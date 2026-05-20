/**
 * Phase 4 — MODULE 7: Escalation Engine
 * Triggers: maxClarifications exceeded, repeated low synthesis score, repeated transaction failures,
 * high-risk domain detection.
 * Escalation response: override persona tone to formal, disable humor, concise.
 */

const { recordPhase4Metric } = require('../observability/phase4Metrics');

/**
 * @typedef {Object} EscalationTrigger
 * @property {'clarification_cap'|'low_synthesis'|'transaction_failures'|'high_risk_domain'} reason
 * @property {boolean} shouldEscalate
 */

/**
 * Determine if escalation should trigger. Deterministic.
 *
 * @param {Object} state
 * @param {number} [state.clarificationCount]
 * @param {number} [state.maxClarifications]
 * @param {number} [state.lowSynthesisTurnCount] - Consecutive turns with score below threshold
 * @param {number} [state.maxLowConfidenceTurns]
 * @param {number} [state.transactionFailureCount]
 * @param {number} [state.transactionFailureThreshold]
 * @param {boolean} [state.highRiskDomainDetected]
 * @returns {EscalationTrigger}
 */
function evaluateEscalation(state) {
    const {
        clarificationCount = 0,
        maxClarifications = 2,
        lowSynthesisTurnCount = 0,
        maxLowConfidenceTurns = 3,
        transactionFailureCount = 0,
        transactionFailureThreshold = 2,
        highRiskDomainDetected = false
    } = state;

    if (clarificationCount > maxClarifications) {
        recordPhase4Metric('escalation_rate', 1);
        return { reason: 'clarification_cap', shouldEscalate: true };
    }
    if (lowSynthesisTurnCount >= maxLowConfidenceTurns) {
        recordPhase4Metric('escalation_rate', 1);
        return { reason: 'low_synthesis', shouldEscalate: true };
    }
    if (transactionFailureCount >= transactionFailureThreshold) {
        recordPhase4Metric('escalation_rate', 1);
        return { reason: 'transaction_failures', shouldEscalate: true };
    }
    if (highRiskDomainDetected) {
        recordPhase4Metric('escalation_rate', 1);
        return { reason: 'high_risk_domain', shouldEscalate: true };
    }

    return { reason: 'clarification_cap', shouldEscalate: false };
}

/**
 * Escalation tone constraints: formal, no humor, concise. Caller applies to persona/style.
 * @returns {{ tone: 'formal', humorAllowed: false, concise: true }}
 */
function getEscalationToneOverride() {
    return Object.freeze({
        tone: 'formal',
        humorAllowed: false,
        concise: true
    });
}

/**
 * Suggested escalation response prefix (optional). Override persona to formal; no humor.
 * @returns {string}
 */
function getEscalationResponsePrefix() {
    return ''; // Caller uses tone override to generate; no fixed text.
}

module.exports = {
    evaluateEscalation,
    getEscalationToneOverride,
    getEscalationResponsePrefix
};
