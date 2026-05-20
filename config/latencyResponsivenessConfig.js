/**
 * Latency, Responsiveness & Conversational Quality — config
 * Covers: latency budgeting, prewarm, pacing, micro-acknowledgements (hardened).
 * Configuration only. No I/O, no hot-path logic.
 * Authoritative: docs/latency-responsiveness-conversational-quality.md
 */

const path = require('path');

/** Global kill switch. If false, all Phase 3 is disabled (latency, prewarm, pacing, micro-ack, Phase 3 logging). */
const PHASE3_ENABLED = process.env.PHASE3_ENABLED === 'true';

/** Extra logging (cancellations etc.) only when true. Overruns and MA emission always logged when Phase 3 on. */
const PHASE3_DEBUG = process.env.PHASE3_DEBUG === 'true';

/** Latency budget targets (ms). Overruns logged only when PHASE3_ENABLED; no compensation. */
const LATENCY_BUDGET = Object.freeze({
    speechEndToResponseMs: Number(process.env.PHASE3_LATENCY_RESPONSE_MS) || 800,
    responseToFirstAudioMs: Number(process.env.PHASE3_LATENCY_FIRST_AUDIO_MS) || 700,
    totalMs: Number(process.env.PHASE3_LATENCY_TOTAL_MS) || 1200,
    logOverruns: process.env.PHASE3_LATENCY_LOG_OVERRUNS !== 'false'
});

/** Latency compensation: adaptive context/KB reduction when overruns are frequent. */
const LATENCY_COMPENSATION = Object.freeze({
    enabled:                   process.env.PHASE3_LATENCY_COMPENSATION_ENABLED === 'true',
    windowSize:                Number(process.env.PHASE3_LATENCY_WINDOW_SIZE) || 5,
    lightThreshold:            Number(process.env.PHASE3_LATENCY_LIGHT_THRESHOLD) || 2,
    aggressiveThreshold:       Number(process.env.PHASE3_LATENCY_AGGRESSIVE_THRESHOLD) || 5,
    lightMaxContextTurns:      Number(process.env.PHASE3_LATENCY_LIGHT_MAX_CONTEXT) || 6,
    aggressiveMaxContextTurns: Number(process.env.PHASE3_LATENCY_AGGRESSIVE_MAX_CONTEXT) || 5,
    skipKbOnAggressive:        process.env.PHASE3_LATENCY_SKIP_KB === 'true',
    fillerEnabled:             process.env.PHASE3_LATENCY_FILLER_ENABLED === 'true',
});

/** Safe prewarm: only when INTERACTIVE; drop state on turnId change; never emit early TTS. */
const PREWARM = Object.freeze({
    enabled: process.env.PHASE3_PREWARM_ENABLED === 'true'
});

/** Pacing: split long TTS, insert natural pauses. Never alter semantics. Cap cumulative delay at MAX_TOTAL_PACING_DELAY. */
const MAX_TOTAL_PACING_DELAY_MS = 400;
const PACING = Object.freeze({
    enabled: process.env.PHASE3_PACING_ENABLED !== 'false',
    chunkDurationMs: Number(process.env.PHASE3_PACING_CHUNK_MS) || 4000,
    pauseMinMs: Number(process.env.PHASE3_PACING_PAUSE_MIN_MS) || 50,
    pauseMaxMs: Number(process.env.PHASE3_PACING_PAUSE_MAX_MS) || 150,
    maxTotalDelayMs: MAX_TOTAL_PACING_DELAY_MS
});

/** Micro-ack: require BOTH PHASE3_MICRO_ACK_ENABLED and PHASE3_MICRO_ACK_ALLOW_TEST_CONFIDENCE for test confidence override. lastStoredConfidence initialises to 1.0 (optimistic prior); ALLOW_TEST_CONFIDENCE overrides getEffectiveConfidence only in tests. */
const _microAckEnabled = process.env.PHASE3_MICRO_ACK_ENABLED === 'true';
const _allowTestConfidence = process.env.PHASE3_MICRO_ACK_ALLOW_TEST_CONFIDENCE === 'true';
const MICRO_ACK = Object.freeze({
    enabled: _microAckEnabled,
    /** Only true when BOTH micro-ack enabled AND allow-test-confidence set. No silent fallback. */
    allowTestConfidence: _microAckEnabled && _allowTestConfidence,
    confidenceThreshold: Number(process.env.PHASE3_MICRO_ACK_CONFIDENCE) || 0.7,
    continuousSpeechMinMs: Number(process.env.PHASE3_MICRO_ACK_SPEECH_MIN_MS) || 200,
    continuousSpeechMaxMs: Number(process.env.PHASE3_MICRO_ACK_SPEECH_MAX_MS) || 600,
    noPauseMinMs: 150,
    neutralAudioPath: process.env.PHASE3_MICRO_ACK_NEUTRAL_AUDIO_PATH || null
});

function getPhase3Config() {
    return {
        latencyBudget: LATENCY_BUDGET,
        latencyCompensation: LATENCY_COMPENSATION,
        prewarm: PREWARM,
        pacing: PACING,
        microAck: MICRO_ACK
    };
}

/** Resolve neutral audio path to absolute path if set. */
function getNeutralAudioPath() {
    if (!MICRO_ACK.neutralAudioPath) return null;
    return path.isAbsolute(MICRO_ACK.neutralAudioPath)
        ? MICRO_ACK.neutralAudioPath
        : path.join(process.cwd(), MICRO_ACK.neutralAudioPath);
}

module.exports = {
    getPhase3Config,
    getNeutralAudioPath,
    PHASE3_ENABLED,
    PHASE3_DEBUG,
    LATENCY_BUDGET,
    PREWARM,
    PACING,
    MICRO_ACK,
    LATENCY_COMPENSATION
};
