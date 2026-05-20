/**
 * Phase 4 — MODULE 5: Numeric Enforcement
 * Extract numerics from docs and answer; exact match or sum/difference only; unit validation.
 * Structured profile: unsupported numeric → hard block. Balanced/Rapid: apply penalty in synthesis score.
 * Must re-run after persona rewrite (persona must not alter numeric tokens).
 */

const { recordPhase4Metric } = require('../observability/phase4Metrics');

/** Regex to capture numbers: integers, decimals, percentages, currency, simple ranges, date-like numbers */
const NUMERIC_PATTERN = /(\d+(?:,\d{3})*(?:\.\d+)?%?|\d+(?:\.\d+)?\s*(?:days?|weeks?|months?|years?|hours?|%|USD|EUR|GBP|\$|€|£))/gi;

/**
 * Extract numeric tokens from text (normalized for comparison: strip commas, lower unit).
 * @param {string} text
 * @returns {Array<{ raw: string, normalized: string, unit?: string }>}
 */
function extractNumerics(text) {
    if (typeof text !== 'string' || !text.trim()) return [];
    const seen = new Set();
    const out = [];
    let m;
    const re = new RegExp(NUMERIC_PATTERN.source, 'gi');
    while ((m = re.exec(text)) !== null) {
        const raw = m[1].trim();
        const normalized = raw.replace(/,/g, '').toLowerCase();
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        const unit = raw.replace(/[\d,.\s]/g, '').toLowerCase() || undefined;
        out.push({ raw, normalized, unit });
    }
    return out;
}

/**
 * Parse a single numeric for arithmetic (value only).
 * @param {string} normalized
 * @returns {number|null}
 */
function parseNumericValue(normalized) {
    const s = normalized.replace(/,/g, '').replace(/%/g, '').replace(/\s*(days?|weeks?|months?|years?|hours?|usd|eur|gbp|\$|€|£)/gi, '').trim();
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
}

/**
 * Check if answer numeric is in doc set or equals sum/difference of two doc values.
 * Unit must match when present.
 * @param {Array<{ raw: string, normalized: string, unit?: string }>} docNumerics
 * @param {{ raw: string, normalized: string, unit?: string }} answerNum
 * @returns {boolean}
 */
function isNumericSupported(docNumerics, answerNum) {
    const ansNorm = answerNum.normalized;
    const ansVal = parseNumericValue(ansNorm);
    const ansUnit = (answerNum.unit || '').toLowerCase();

    const exactMatch = docNumerics.some(d => d.normalized === ansNorm);
    if (exactMatch) return true;

    if (ansVal === null) return false;

    const docValues = docNumerics
        .map(d => ({ ...d, val: parseNumericValue(d.normalized) }))
        .filter(d => d.val !== null);

    for (const d of docValues) {
        if (d.unit && ansUnit && d.unit !== ansUnit) continue;
        if (Math.abs(d.val - ansVal) < 1e-6) return true;
    }

    for (let i = 0; i < docValues.length; i++) {
        for (let j = i + 1; j < docValues.length; j++) {
            const a = docValues[i];
            const b = docValues[j];
            if (a.unit && ansUnit && a.unit !== ansUnit) continue;
            if (b.unit && ansUnit && b.unit !== ansUnit) continue;
            if (Math.abs(a.val + b.val - ansVal) < 1e-6) return true;
            if (Math.abs(a.val - b.val - ansVal) < 1e-6) return true;
            if (Math.abs(b.val - a.val - ansVal) < 1e-6) return true;
        }
    }
    return false;
}

/**
 * Validate answer numerics against doc numerics. Returns list of unsupported and penalty to apply.
 *
 * @param {string} docText - Combined sanitized doc content
 * @param {string} answerText - Model answer (pre-persona)
 * @param {'structured'|'balanced'|'rapid'} profileName
 * @returns {{ allowed: boolean, unsupportedCount: number, penalty: number, unsupportedSnippets: string[] }}
 */
function validateNumerics(docText, answerText, profileName) {
    const docN = extractNumerics(docText);
    const answerN = extractNumerics(answerText);
    const unsupported = [];
    const unsupportedSnippets = [];

    for (const an of answerN) {
        if (!isNumericSupported(docN, an)) {
            unsupported.push(an);
            unsupportedSnippets.push(an.raw);
        }
    }

    if (unsupported.length === 0) {
        return { allowed: true, unsupportedCount: 0, penalty: 0, unsupportedSnippets: [] };
    }

    recordPhase4Metric('unsupported_numeric_rate', 1);

    if (profileName === 'structured') {
        return {
            allowed: false,
            unsupportedCount: unsupported.length,
            penalty: 1,
            unsupportedSnippets
        };
    }

    if (profileName === 'balanced') {
        return {
            allowed: true,
            unsupportedCount: unsupported.length,
            penalty: 0.25 * unsupported.length,
            unsupportedSnippets
        };
    }

    return {
        allowed: true,
        unsupportedCount: unsupported.length,
        penalty: 0.15 * unsupported.length,
        unsupportedSnippets
    };
}

/**
 * Run numeric enforcement and return gate result. For structured profile, caller must block when allowed=false.
 * Re-run after persona rewrite; persona must not alter numeric tokens.
 *
 * @param {string} docText
 * @param {string} answerText
 * @param {import('../profiles/conversationProfiles').ConversationProfile} profile
 * @returns {{ allowed: boolean, penalty: number, unsupportedSnippets: string[] }}
 */
function enforceNumerics(docText, answerText, profile) {
    const name = profile.name;
    const r = validateNumerics(docText, answerText, name);
    return {
        allowed: r.allowed,
        penalty: Math.min(1, r.penalty),
        unsupportedSnippets: r.unsupportedSnippets
    };
}

module.exports = {
    extractNumerics,
    isNumericSupported,
    validateNumerics,
    enforceNumerics,
    NUMERIC_PATTERN
};
