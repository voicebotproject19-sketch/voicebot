/**
 * Phase 2.5.2 — Degradation State Engine
 * Deterministic state machine for unlock control. No async, no external deps.
 * Authoritative: docs/VoiceBot Unlock & Degradation Control — Formal Specification.md
 */

const degradationContract = require('../ci/contracts/degradation-contract.js');

const DEGRADATION_STATE = degradationContract.DEGRADATION_STATE || {
    NORMAL: 'NORMAL',
    DEGRADED: 'DEGRADED',
    SEVERE: 'SEVERE'
};

const {
    CONFIDENCE_HISTORY_SIZE = 8,
    TRANSCRIPT_HISTORY_SIZE = 6,
    TRUNCATED_WINDOW_MS = 4000,
    STABLE_CONSECUTIVE_FOR_RESET = 3,
    CONFIDENCE_THRESHOLDS = {},
    VARIANCE_THRESHOLDS = {},
    PACKET_LOSS_THRESHOLDS = {},
    RECOVERY_THRESHOLDS = {},
    TRANSCRIPT_SIGNALS = {}
} = degradationContract;

/**
 * Creates a per-call degradation state engine. Session-isolated; no global state.
 * @param {{ onStateTransition?: (from: string, to: string) => void }} [opts] - optional callback when state changes
 * @returns {{
 *   updateDegradationState: (event: TranscriptEvent) => void,
 *   getCurrentState: () => string,
 *   getStabilityMetrics: () => { rollingAvgConfidence: number, variance: number, stableConsecutive: number },
 *   resetState: () => void
 * }}
 */
function createDegradationStateEngine(opts) {
    let state = DEGRADATION_STATE.NORMAL;
    const onStateTransition = typeof opts?.onStateTransition === 'function' ? opts.onStateTransition : null;
    const transcriptHistory = [];
    const confidenceHistory = [];
    let stableConsecutiveCount = 0;
    let emptyTranscriptCount = 0;
    let severeCandidateCount = 0; // noise‑spike guard for SEVERE transitions

    /**
     * @typedef {object} TranscriptEvent
     * @property {string} [transcript]
     * @property {number} [confidence]
     * @property {number} [timestamp]
     * @property {boolean} [isTruncated]
     * @property {number} [packetLoss] 0-1
     */

    function variance(arr) {
        if (arr.length < 2) return 0;
        const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
        const sq = arr.reduce((acc, x) => acc + (x - mean) ** 2, 0);
        return sq / arr.length;
    }

    function rollingAvg(arr) {
        if (arr.length === 0) return 0;
        return arr.reduce((a, b) => a + b, 0) / arr.length;
    }

    function updateDegradationState(transcriptEvent) {
        const now = typeof transcriptEvent?.timestamp === 'number' ? transcriptEvent.timestamp : Date.now();
        const transcript = typeof transcriptEvent?.transcript === 'string' ? transcriptEvent.transcript.trim() : '';
        const confidence = typeof transcriptEvent?.confidence === 'number' ? transcriptEvent.confidence : 0;
        const isTruncated = Boolean(transcriptEvent?.isTruncated);
        const packetLoss = typeof transcriptEvent?.packetLoss === 'number' ? transcriptEvent.packetLoss : 0;

        if (transcript === '') {
            emptyTranscriptCount += 1;
        } else {
            emptyTranscriptCount = 0;
        }

        transcriptHistory.push({ text: transcript, confidence, ts: now, isTruncated });
        if (transcriptHistory.length > TRANSCRIPT_HISTORY_SIZE) transcriptHistory.shift();

        if (typeof transcriptEvent?.confidence === 'number') {
            confidenceHistory.push(transcriptEvent.confidence);
            if (confidenceHistory.length > CONFIDENCE_HISTORY_SIZE) confidenceHistory.shift();
        }

        const avg = rollingAvg(confidenceHistory);
        const varVal = variance(confidenceHistory);
        const truncatedInWindow = transcriptHistory.filter(
            (e) => e.isTruncated && (now - e.ts) <= TRUNCATED_WINDOW_MS
        ).length;
        const revisionBurst = transcriptHistory.length >= 2 && transcriptHistory[transcriptHistory.length - 1].text !== transcriptHistory[transcriptHistory.length - 2].text && transcriptHistory[transcriptHistory.length - 2].text !== '';
        const hasEnoughHistory = confidenceHistory.length >= 2;

        if (avg >= CONFIDENCE_THRESHOLDS.NORMAL_MIN_AVG && varVal <= VARIANCE_THRESHOLDS.NORMAL_MAX_VARIANCE && emptyTranscriptCount < TRANSCRIPT_SIGNALS.EMPTY_COUNT_SEVERE) {
            stableConsecutiveCount += 1;
        } else {
            stableConsecutiveCount = 0;
        }

        if (stableConsecutiveCount >= STABLE_CONSECUTIVE_FOR_RESET) {
            const prev = state;
            state = DEGRADATION_STATE.NORMAL;
            stableConsecutiveCount = 0;
            if (onStateTransition && prev !== state) onStateTransition(prev, state);
            return;
        }

        if (
            emptyTranscriptCount >= TRANSCRIPT_SIGNALS.EMPTY_COUNT_SEVERE ||
            packetLoss > PACKET_LOSS_THRESHOLDS.SEVERE_MIN ||
            (hasEnoughHistory && (avg < CONFIDENCE_THRESHOLDS.SEVERE_MIN_AVG || varVal > VARIANCE_THRESHOLDS.SEVERE_MIN))
        ) {
            severeCandidateCount += 1;

            // Require two consecutive severe signals to avoid single noise spikes
            if (severeCandidateCount >= TRANSCRIPT_SIGNALS.SEVERE_CONFIRMATION_COUNT) {
                const prev = state;
                state = DEGRADATION_STATE.SEVERE;
                severeCandidateCount = 0;
                if (onStateTransition && prev !== state) onStateTransition(prev, state);
                return;
            }
        } else {
            severeCandidateCount = 0;
        }

        if (hasEnoughHistory && (
            avg < CONFIDENCE_THRESHOLDS.DEGRADED_MIN_AVG ||
            varVal > VARIANCE_THRESHOLDS.DEGRADED_MIN ||
            truncatedInWindow >= TRANSCRIPT_SIGNALS.TRUNCATED_COUNT_DEGRADED ||
            revisionBurst ||
            packetLoss > PACKET_LOSS_THRESHOLDS.DEGRADED_MIN
        )) {
            const prev = state;
            state = DEGRADATION_STATE.DEGRADED;
            if (onStateTransition && prev !== state) onStateTransition(prev, state);
            return;
        }

        const recoverAvg = state === DEGRADATION_STATE.DEGRADED
            ? RECOVERY_THRESHOLDS.NORMAL_RECOVERY_AVG
            : CONFIDENCE_THRESHOLDS.NORMAL_MIN_AVG;
        const recoverVar = state === DEGRADATION_STATE.DEGRADED
            ? RECOVERY_THRESHOLDS.NORMAL_RECOVERY_VARIANCE
            : VARIANCE_THRESHOLDS.NORMAL_MAX_VARIANCE;

        if (hasEnoughHistory && avg >= recoverAvg && varVal <= recoverVar && packetLoss <= PACKET_LOSS_THRESHOLDS.DEGRADED_MIN) {
            const prev = state;
            state = DEGRADATION_STATE.NORMAL;
            if (onStateTransition && prev !== state) onStateTransition(prev, state);
        }
    }

    function getCurrentState() {
        return state;
    }

    function getStabilityMetrics() {
        const avg = rollingAvg(confidenceHistory);
        const varVal = variance(confidenceHistory);
        return {
            rollingAvgConfidence: avg,
            variance: varVal,
            stableConsecutive: stableConsecutiveCount
        };
    }

    function resetState() {
        state = DEGRADATION_STATE.NORMAL;
        transcriptHistory.length = 0;
        confidenceHistory.length = 0;
        stableConsecutiveCount = 0;
        emptyTranscriptCount = 0;
        severeCandidateCount = 0;
    }

    return {
        updateDegradationState,
        getCurrentState,
        getStabilityMetrics,
        resetState
    };
}

module.exports = {
    createDegradationStateEngine
};
