/**
 * Phase 4 — MODULE 10: Observability
 * Metrics for RAG timeout, synthesis score, unsupported numeric, injection removal,
 * clarification, escalation, transaction confirmation, humor usage.
 * Metrics MUST NOT auto-adjust behavior. Observational only.
 */

const PHASE4_METRICS = {
    rag_timeout_rate: 0,
    synthesis_score_distribution: [],
    unsupported_numeric_rate: 0,
    injection_sentences_removed: 0,
    clarification_rate: 0,
    escalation_rate: 0,
    transaction_confirmation_rate: 0,
    humor_usage_rate: 0
};

const MAX_SCORE_SAMPLES = 500;

/**
 * Record a Phase 4 metric. Increments counters or appends to distribution. Does not alter behavior.
 * @param {keyof typeof PHASE4_METRICS} name
 * @param {number} [value] - For rates: increment by this (typically 1). For synthesis_score_distribution: score 0..1.
 */
function recordPhase4Metric(name, value = 1) {
    if (name === 'synthesis_score_distribution' && typeof value === 'number') {
        const arr = PHASE4_METRICS.synthesis_score_distribution;
        arr.push(value);
        if (arr.length > MAX_SCORE_SAMPLES) arr.shift();
        return;
    }
    if (typeof PHASE4_METRICS[name] === 'number') {
        PHASE4_METRICS[name] += value;
    }
}

/**
 * Get current metric values. Read-only; for logging/dashboards. Does not reset.
 * @returns {Record<string, number | number[]>}
 */
function getPhase4Metrics() {
    return { ...PHASE4_METRICS };
}

/**
 * Reset metrics (e.g. for tests). Not used in production hot path.
 */
function resetPhase4Metrics() {
    PHASE4_METRICS.rag_timeout_rate = 0;
    PHASE4_METRICS.synthesis_score_distribution = [];
    PHASE4_METRICS.unsupported_numeric_rate = 0;
    PHASE4_METRICS.injection_sentences_removed = 0;
    PHASE4_METRICS.clarification_rate = 0;
    PHASE4_METRICS.escalation_rate = 0;
    PHASE4_METRICS.transaction_confirmation_rate = 0;
    PHASE4_METRICS.humor_usage_rate = 0;
}

module.exports = {
    recordPhase4Metric,
    getPhase4Metrics,
    resetPhase4Metrics,
    PHASE4_METRICS
};
