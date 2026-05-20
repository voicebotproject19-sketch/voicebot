/**
 * Phase 4 — MODULE 2: Intent Confidence Gate
 * If intent confidence below threshold: trigger clarification, increment counter, abort RAG.
 * Escalate if clarification limit exceeded. No LLM re-prompt loops.
 */

const { recordPhase4Metric } = require('../observability/phase4Metrics');

/**
 * @typedef {Object} IntentGateResult
 * @property {'proceed'|'clarify'|'escalate'} action
 * @property {number} clarificationCount - Count after this evaluation (for caller to persist)
 * @property {boolean} abortRag - If true, caller must not call RAG
 */

/**
 * Evaluate intent confidence against profile. Deterministic; no I/O.
 * If below threshold: clarify, increment counter, abort RAG. Escalate if limit exceeded.
 *
 * @param {number} intentConfidence - 0..1
 * @param {import('../profiles/conversationProfiles').ConversationProfile} profile
 * @param {number} currentClarificationCount - Count for this call/session (caller-provided)
 * @returns {IntentGateResult}
 */
function evaluateIntentConfidence(intentConfidence, profile, currentClarificationCount) {
    const minConf = profile.intent.minConfidence;
    const maxClar = profile.intent.maxClarifications;
    const count = Math.max(0, Math.floor(currentClarificationCount));

    if (typeof intentConfidence !== 'number' || Number.isNaN(intentConfidence)) {
        recordPhase4Metric('clarification_rate', 1);
        return {
            action: 'clarify',
            clarificationCount: count + 1,
            abortRag: true
        };
    }

    const clamped = Math.max(0, Math.min(1, intentConfidence));

    if (clamped >= minConf) {
        return {
            action: 'proceed',
            clarificationCount: count,
            abortRag: false
        };
    }

    const newCount = count + 1;
    recordPhase4Metric('clarification_rate', 1);

    if (newCount > maxClar) {
        recordPhase4Metric('escalation_rate', 1);
        return {
            action: 'escalate',
            clarificationCount: newCount,
            abortRag: true
        };
    }

    return {
        action: 'clarify',
        clarificationCount: newCount,
        abortRag: true
    };
}

module.exports = {
    evaluateIntentConfidence
};
