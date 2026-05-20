/**
 * Phase 4 — MODULE 3: RAG Guardrail Layer
 * Retrieval timeout enforcement (caller applies timeout; we validate bounds),
 * maxDocs trimming, relevance filtering, zero-doc fallback behavior.
 * Does NOT modify the retriever itself. All timeouts bounded and non-blocking.
 */

const { recordPhase4Metric } = require('../observability/phase4Metrics');
const { sanitizeDocuments } = require('./retrievalSanitation');

/**
 * Apply guardrails to retrieval results: trim to maxDocs, filter by relevance, sanitize.
 * Zero docs after filtering → return empty and signal fallback (caller must clarify/fallback, never fabricate).
 *
 * @param {Array<{ content: string, relevanceScore?: number, tenantId?: string }>} docs - Raw docs from retriever
 * @param {import('../profiles/conversationProfiles').ConversationProfile} profile
 * @param {object} [opts]
 * @param {string} [opts.tenantId] - For cross-tenant drop
 * @param {number} [opts.maxCharsPerDoc] - Default 5000
 * @returns {{ docs: Array<{ content: string, relevanceScore?: number }>, zeroDocs: boolean, timedOut?: boolean }}
 */
function applyRagGuardrails(docs, profile, opts = {}) {
    const maxDocs = profile.rag.maxDocs;
    const minRelevance = profile.rag.minRelevanceScore;
    const tenantId = opts.tenantId;
    const maxCharsPerDoc = opts.maxCharsPerDoc ?? 5000;

    if (!Array.isArray(docs)) {
        return { docs: [], zeroDocs: true };
    }

    let list = docs
        .filter(d => d && typeof (d.content || d.text) === 'string')
        .map(d => ({
            content: d.content != null ? d.content : d.text,
            relevanceScore: typeof d.relevanceScore === 'number' ? d.relevanceScore : 1,
            tenantId: d.tenantId
        }));

    list = list.filter(d => d.relevanceScore >= minRelevance);
    list.sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0));
    list = list.slice(0, maxDocs);

    const sanitized = sanitizeDocuments(list, tenantId, maxCharsPerDoc);
    const zeroDocs = sanitized.length === 0;

    return {
        docs: sanitized,
        zeroDocs
    };
}

/**
 * Interpret retrieval timeout: caller should pass timedOut when they enforced a timeout.
 * We only record metric; no await, no blocking.
 * @param {boolean} timedOut
 */
function recordRetrievalTimeout(timedOut) {
    if (timedOut) recordPhase4Metric('rag_timeout_rate', 1);
}

/**
 * Convert legacy retriever output (single string) to doc array for guardrails.
 * Existing KB returns a string; this normalizes to [{ content, relevanceScore }].
 *
 * Sprint 6B.1 (F1): When scored sections are available from KB, use real relevance
 * scores instead of the flat default. This preserves the ranking signal computed
 * during retrieval (keyword + category + semantic scoring).
 *
 * @param {string} rawOutput - Single string from retrieveRelevantInfo
 * @param {number} [defaultRelevance] - Used when no per-doc score
 * @param {Array<{ content: string, relevanceScore: number }>} [scoredSections] - Pre-scored sections from KB
 * @returns {Array<{ content: string, relevanceScore: number }>}
 */
function legacyRetrievalToDocs(rawOutput, defaultRelevance = 0.5, scoredSections) {
    // Sprint 6B.1: Use real scores when available
    if (Array.isArray(scoredSections) && scoredSections.length > 0) {
        return scoredSections.map(s => ({
            content: (s.content || '').trim(),
            relevanceScore: typeof s.relevanceScore === 'number' ? s.relevanceScore : defaultRelevance
        })).filter(d => d.content);
    }
    if (typeof rawOutput !== 'string' || !rawOutput.trim()) {
        return [];
    }
    const blocks = rawOutput.split(/\n\n+/).filter(b => b.trim());
    if (blocks.length === 0) return [{ content: rawOutput.trim(), relevanceScore: defaultRelevance }];
    return blocks.map(content => ({ content: content.trim(), relevanceScore: defaultRelevance }));
}

module.exports = {
    applyRagGuardrails,
    recordRetrievalTimeout,
    legacyRetrievalToDocs
};
