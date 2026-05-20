/**
 * Latency, Responsiveness & Conversational Quality — runtime helpers
 * Used by app.js for latency logging, pacing chunking, micro-ack timing. No I/O in hot path; no new awaits.
 * Authoritative: docs/latency-responsiveness-conversational-quality.md
 */

const fs = require('fs');
const { getNeutralAudioPath, LATENCY_BUDGET, PACING, MICRO_ACK, PHASE3_ENABLED, LATENCY_COMPENSATION } = require('./latencyResponsivenessConfig');

/** When true, neutral clip was >300ms at startup; micro-ack must not emit. */
let _microAckDisabledByNeutralClip = false;

function isMicroAckDisabledByNeutralClip() {
    return _microAckDisabledByNeutralClip;
}

let _neutralValidationDone = false;
/** Call once at startup (NOT hot path). Loads neutral clip; if duration >300ms, disables micro-ack and logs. */
function initializeNeutralClipValidation() {
    if (_neutralValidationDone) return _microAckDisabledByNeutralClip ? null : _neutralAudioCache;
    _neutralValidationDone = true;
    const p = getNeutralAudioPath();
    if (!p) {
        _neutralAudioCache = null;
        return null;
    }
    try {
        const buf = fs.readFileSync(p);
        const durationMs = Math.ceil(buf.length / 8);
        if (durationMs > 300) {
            console.warn('[Phase3] Neutral clip exceeds 300ms. Disabling micro-ack.');
            _microAckDisabledByNeutralClip = true;
            _neutralAudioCache = null;
            return null;
        }
        _neutralAudioCache = { base64: buf.toString('base64'), durationMs };
        return _neutralAudioCache;
    } catch (err) {
        console.warn('[Phase3] Could not load micro-ack neutral audio:', p, err.message);
        _neutralAudioCache = null;
        return null;
    }
}

/** Log latency overruns and return structured result. Backward-compatible — callers that ignore return are unaffected. */
function logLatencyOverruns(connectionId, callSID, latencyState) {
    if (!PHASE3_ENABLED || !LATENCY_BUDGET.logOverruns) return null;
    const { speechEndTs, responseStartTs, firstAudioFrameTs } = latencyState;
    if (firstAudioFrameTs == null) return null;
    const now = firstAudioFrameTs;
    const result = {
        speechEndToFirstAudio: speechEndTs != null ? now - speechEndTs : null,
        responseStartToFirstAudio: responseStartTs != null ? now - responseStartTs : null,
        speechEndToResponse: (speechEndTs != null && responseStartTs != null) ? responseStartTs - speechEndTs : null,
        overrun: false
    };
    if (result.speechEndToFirstAudio != null && result.speechEndToFirstAudio > LATENCY_BUDGET.totalMs) {
        console.warn(`[Phase3][${connectionId}] Latency overrun: speechEnd→firstAudio ${result.speechEndToFirstAudio}ms (budget ${LATENCY_BUDGET.totalMs}ms) callSID=${callSID}`);
        result.overrun = true;
    }
    if (result.responseStartToFirstAudio != null && result.responseStartToFirstAudio > LATENCY_BUDGET.responseToFirstAudioMs) {
        console.warn(`[Phase3][${connectionId}] Latency overrun: responseStart→firstAudio ${result.responseStartToFirstAudio}ms (budget ${LATENCY_BUDGET.responseToFirstAudioMs}ms) callSID=${callSID}`);
        result.overrun = true;
    }
    if (result.speechEndToResponse != null && result.speechEndToResponse > LATENCY_BUDGET.speechEndToResponseMs) {
        console.warn(`[Phase3][${connectionId}] Latency overrun: speechEnd→responseStart ${result.speechEndToResponse}ms (budget ${LATENCY_BUDGET.speechEndToResponseMs}ms) callSID=${callSID}`);
        result.overrun = true;
    }
    return result;
}

// ─── Latency Compensation Engine ─────────────────────────────────────────────
// Per-call rolling window tracker. Mirrors createDegradationStateEngine() pattern.
const COMPENSATION_LEVEL = Object.freeze({ NONE: 'NONE', LIGHT: 'LIGHT', AGGRESSIVE: 'AGGRESSIVE' });

function createLatencyCompensationEngine() {
    const history = [];
    let currentLevel = COMPENSATION_LEVEL.NONE;

    function recordTurn(latencyState) {
        if (!LATENCY_COMPENSATION.enabled) return COMPENSATION_LEVEL.NONE;
        const { speechEndTs, firstAudioFrameTs } = latencyState;
        if (speechEndTs == null || firstAudioFrameTs == null) return currentLevel;
        const totalMs = firstAudioFrameTs - speechEndTs;
        history.push({ overrun: totalMs > LATENCY_BUDGET.totalMs, totalMs, ts: Date.now() });
        if (history.length > LATENCY_COMPENSATION.windowSize) history.shift();
        const overrunCount = history.filter(h => h.overrun).length;
        if (overrunCount >= LATENCY_COMPENSATION.aggressiveThreshold) currentLevel = COMPENSATION_LEVEL.AGGRESSIVE;
        else if (overrunCount >= LATENCY_COMPENSATION.lightThreshold) currentLevel = COMPENSATION_LEVEL.LIGHT;
        else currentLevel = COMPENSATION_LEVEL.NONE;
        return currentLevel;
    }

    return {
        recordTurn,
        getLevel: () => currentLevel,
        reset: () => { history.length = 0; currentLevel = COMPENSATION_LEVEL.NONE; }
    };
}

/** Split buffer into chunks by duration (8kHz mulaw: 8000 bytes/sec). Returns array of { buffer, durationMs }. */
function splitAudioForPacing(audioBuffer, chunkDurationMs) {
    const bytesPerMs = 8;
    const chunkBytes = Math.max(1, Math.floor(chunkDurationMs * bytesPerMs));
    const chunks = [];
    for (let i = 0; i < audioBuffer.length; i += chunkBytes) {
        const slice = audioBuffer.slice(i, Math.min(i + chunkBytes, audioBuffer.length));
        const durationMs = Math.ceil(slice.length / bytesPerMs);
        chunks.push({ buffer: slice, durationMs });
    }
    return chunks;
}

/** Random pause between PACING.pauseMinMs and PACING.pauseMaxMs. */
function getPauseMs() {
    const min = PACING.pauseMinMs;
    const max = PACING.pauseMaxMs;
    return min + Math.floor(Math.random() * (max - min + 1));
}

/** Load neutral audio (must call initializeNeutralClipValidation at startup first). Returns cached { base64, durationMs } or null. No runtime load. */
let _neutralAudioCache = undefined;
function loadNeutralAudioSync() {
    if (!_neutralValidationDone) return null;
    if (_microAckDisabledByNeutralClip) return null;
    return _neutralAudioCache || null;
}

/** Effective confidence: from adapter or, only when BOTH flags set, test override; else 0. No silent fallback. */
function getEffectiveConfidence(phase3State) {
    if (phase3State.lastStoredConfidence != null) return phase3State.lastStoredConfidence;
    return MICRO_ACK.allowTestConfidence ? 1 : 0;
}

/** Whether micro-ack conditions are met (INTERACTIVE, confidence, no prior MA, window). Caller must gate on PHASE3_ENABLED and microAck.enabled. */
function shouldEmitMicroAck(phase3State, isInteractive) {
    if (!isInteractive) return false;
    if (phase3State.microAck.emittedThisTurn) return false;
    if (phase3State.microAck.windowClosed) return false;
    const effectiveConfidence = getEffectiveConfidence(phase3State);
    return effectiveConfidence >= MICRO_ACK.confidenceThreshold;
}

/** Double-gate at emit time: re-check ALL conditions. Returns true only if safe to emit. No throw. */
function mayEmitMicroAckNow(phase3State, interactionMode, currentTurnId, turnIdAtEmit) {
    if (!MICRO_ACK.enabled) return false;
    if (interactionMode !== 'INTERACTIVE') return false;
    if (currentTurnId !== turnIdAtEmit) return false;
    if (phase3State.microAck.windowClosed) return false;
    if (phase3State.microAck.emittedThisTurn) return false;
    if (_microAckDisabledByNeutralClip) return false;
    const effectiveConfidence = getEffectiveConfidence(phase3State);
    if (effectiveConfidence < MICRO_ACK.confidenceThreshold) return false;
    return true;
}

module.exports = {
    logLatencyOverruns,
    createLatencyCompensationEngine,
    COMPENSATION_LEVEL,
    splitAudioForPacing,
    getPauseMs,
    loadNeutralAudioSync,
    shouldEmitMicroAck,
    getEffectiveConfidence,
    mayEmitMicroAckNow,
    initializeNeutralClipValidation,
    isMicroAckDisabledByNeutralClip
};
