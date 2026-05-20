/**
 * Phase 4 — MODULE 4: Retrieval Sanitation Layer
 * Strip HTML/script/code blocks, YAML/frontmatter, injection phrases, behavioral overrides.
 * Drop cross-tenant docs, enforce doc length cap. Synchronous and lightweight.
 * Injection density above threshold → drop doc.
 */

const { recordPhase4Metric } = require('../observability/phase4Metrics');

const DEFAULT_MAX_DOC_CHARS = 5000;

/**
 * Returns injection detection patterns: (assistant|ai|model|system).*(must|should|always|never|ensure) etc.
 */
function getInjectionPatterns() {
    return [
        /\b(assistant|ai|model|system)\b[^.]*?\b(must|should|always|never|ensure)\b/gi,
        /\b(when generating responses|follow these guidelines|avoid saying)\b/gi,

        // Production RAG protection: detect indirect imperative instructions embedded in docs
        /\b(always|never|must|should)\b[^.]{0,120}\b(reply|respond|answer|say|mention|explain)\b/gi,

        // Sprint 6B.2 (F2): Multilingual injection patterns — DE, HI, ES
        /\b(ignoriere|vergiss|überschreibe|ignorier|vergesse)\b[^.]*?\b(anweisungen|regeln|system|prompt)\b/gi,
        /\b(Assistent|KI|Modell|System)\b[^.]*?\b(muss|soll|immer|niemals)\b/gi,
        /(अनदेखा करो|भूल जाओ|नज़रअंदाज़|उपेक्षा)/gi,
        /\b(ignora|olvida|anula|sobrescribe)\b[^.]*?\b(instrucciones|reglas|sistema|prompt)\b/gi,
        /\b(asistente|modelo|sistema)\b[^.]*?\b(debe|siempre|nunca)\b/gi
    ];
}

/** Max fraction of sentences that can be injection-like before dropping doc. */
const INJECTION_DENSITY_THRESHOLD = 0.25;

/**
 * Strip HTML and script tags.
 * @param {string} text
 * @returns {string}
 */
function stripHtmlAndScript(text) {
    if (typeof text !== 'string') return '';
    return text
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ');
}

/**
 * Strip code blocks (markdown and similar).
 * @param {string} text
 * @returns {string}
 */
function stripCodeBlocks(text) {
    if (typeof text !== 'string') return '';
    return text
        .replace(/```[\s\S]*?```/g, '')
        .replace(/`[^`]+`/g, ' ');
}

/**
 * Strip YAML frontmatter (--- ... --- at start).
 * @param {string} text
 * @returns {string}
 */
function stripYamlFrontmatter(text) {
    if (typeof text !== 'string') return '';
    return text.replace(/^\s*---\s*\n[\s\S]*?\n\s*---\s*\n?/, '').trim();
}

/**
 * Remove sentences matching injection patterns. Returns cleaned text and count of removed sentences.
 * @param {string} text
 * @returns {{ text: string, removed: number }}
 */
function removeInjectionSentences(text) {
    if (typeof text !== 'string') return { text: '', removed: 0 };
    const patterns = getInjectionPatterns();
    const result = text
        .split(/(?<=[.!?])\s+/)
        .filter(s => s.trim().length > 0)
        .reduce((acc, sentence) => {
            const combined = acc.prev ? acc.prev + ' ' + sentence : sentence;

            const isInjection = patterns.some(re => {
                re.lastIndex = 0;
                return re.test(sentence) || re.test(combined);
            });

            if (isInjection) {
                acc.removed++;
            } else {
                acc.kept.push(sentence);
            }

            acc.prev = sentence;
            return acc;
        }, { kept: [], removed: 0, prev: '' });

    if (result.removed > 0) {
        recordPhase4Metric('injection_sentences_removed', result.removed);
    }

    return {
        text: result.kept.join(' ').replace(/\s+/g, ' ').trim(),
        removed: result.removed
    };
}

/**
 * Check injection density. If above threshold, return true (drop doc).
 * @param {string} text
 * @returns {boolean}
 */
function hasHighInjectionDensity(text) {
    if (typeof text !== 'string' || !text.trim()) return false;
    const patterns = getInjectionPatterns();
    const result = text
        .split(/(?<=[.!?])\s+/)
        .filter(s => s.trim().length > 0)
        .reduce((acc, sentence) => {
            const isInjection = patterns.some(re => {
                re.lastIndex = 0;
                return re.test(sentence);
            });
            if (isInjection) acc.injection++;
            acc.total++;
            return acc;
        }, { injection: 0, total: 0 });

    if (result.total === 0) return false;
    return result.injection / result.total > INJECTION_DENSITY_THRESHOLD;
}

/**
 * Sanitize a single document content. Synchronous, lightweight.
 * @param {string} content - Raw doc content
 * @param {object} [opts]
 * @param {number} [opts.maxChars] - Max length after sanitization
 * @param {string} [opts.tenantId] - If provided, used for cross-tenant check (caller must pass tenant on doc)
 * @param {string} [opts.docTenantId] - Doc's tenant; if !== tenantId, drop
 * @returns {{ sanitized: string, dropped: boolean, reason?: string }}
 */
function sanitizeDocument(content, opts = {}) {
    const maxChars = opts.maxChars ?? DEFAULT_MAX_DOC_CHARS;
    const tenantId = opts.tenantId;
    const docTenantId = opts.docTenantId;

    if (typeof content !== 'string') {
        return { sanitized: '', dropped: true, reason: 'non_string' };
    }

    if (tenantId != null && docTenantId != null && String(tenantId) !== String(docTenantId)) {
        return { sanitized: '', dropped: true, reason: 'cross_tenant' };
    }

    let text = content;
    text = stripHtmlAndScript(text);
    text = stripCodeBlocks(text);
    text = stripYamlFrontmatter(text);

    if (hasHighInjectionDensity(text)) {
        return { sanitized: '', dropped: true, reason: 'injection_density' };
    }

    const { text: afterInjection, removed } = removeInjectionSentences(text);
    text = afterInjection;

    if (text.length > maxChars) {
        text = text.slice(0, maxChars);
    }
    text = text.replace(/\s+/g, ' ').trim();

    return { sanitized: text, dropped: false };
}

/**
 * Sanitize multiple documents. Drops cross-tenant and high-injection; returns only sanitized content array.
 * @param {Array<{ content: string, relevanceScore?: number, tenantId?: string }>} docs
 * @param {string} [tenantId]
 * @param {number} [maxChars]
 * @returns {Array<{ content: string, relevanceScore?: number }>}
 */
function sanitizeDocuments(docs, tenantId, maxChars = DEFAULT_MAX_DOC_CHARS) {
    if (!Array.isArray(docs)) return [];
    const out = [];
    for (const doc of docs) {
        const content = doc.content != null ? String(doc.content) : '';
        const result = sanitizeDocument(content, {
            maxChars,
            tenantId,
            docTenantId: doc.tenantId
        });
        if (!result.dropped && result.sanitized) {
            out.push({
                content: result.sanitized,
                relevanceScore: doc.relevanceScore
            });
        }
    }
    return out;
}

module.exports = {
    sanitizeDocument,
    sanitizeDocuments,
    stripHtmlAndScript,
    stripCodeBlocks,
    stripYamlFrontmatter,
    removeInjectionSentences,
    hasHighInjectionDensity,
    DEFAULT_MAX_DOC_CHARS,
    getInjectionPatterns,
    INJECTION_DENSITY_THRESHOLD
};
