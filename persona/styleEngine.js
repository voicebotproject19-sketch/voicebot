/**
 * Phase 4 — MODULE 9b: CommunicationStyleProfile (Persona) Engine
 * Applies style after all validation. No numeric modification; no new commitments.
 * Humor suppressed in complaints, financial disputes, escalation. After style rewrite:
 * re-run numeric enforcement, re-check max sentence count, enforce caps.
 */

const { recordPhase4Metric } = require('../observability/phase4Metrics');
const { getStyleProfile } = require('./styleProfiles');
const { extractNumerics } = require('../rag/numericEnforcement');

/**
 * Persona must NOT alter numeric tokens. Verify that numerics in output match input (same set).
 * @param {string} inputText
 * @param {string} outputText
 * @returns {{ unchanged: boolean, added: string[], removed: string[] }}
 */
function verifyNumericsUnchanged(inputText, outputText) {
    const inN = extractNumerics(inputText).map(n => n.normalized);
    const outN = extractNumerics(outputText).map(n => n.normalized);
    const inSet = new Set(inN);
    const outSet = new Set(outN);
    const added = outN.filter(n => !inSet.has(n));
    const removed = inN.filter(n => !outSet.has(n));
    return {
        unchanged: added.length === 0 && removed.length === 0,
        added,
        removed
    };
}

/**
 * Cap sentences to maxSentencesPerTurn. Does not alter numeric content.
 * @param {string} text
 * @param {number} maxSentences
 * @returns {string}
 */
function capSentences(text, maxSentences) {
    if (typeof text !== 'string' || maxSentences < 1) return text || '';
    const sentences = text.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 0);
    if (sentences.length <= maxSentences) return text.trim();
    return sentences.slice(0, maxSentences).join(' ').trim();
}

/**
 * Count humor markers (light heuristic: "!", "ha", "funny", "just kidding" etc.). For rate tracking.
 * @param {string} text
 * @returns {number}
 */
function countHumorMarkers(text) {
    if (typeof text !== 'string') return 0;
    const re = /\b(just kidding|funny|ha ha|haha|lol|:-\)|:\))\b|!{2,}/gi;
    const m = text.match(re);
    return m ? m.length : 0;
}

/**
 * Apply style constraints to text: no numeric change, cap sentences, suppress humor if not allowed.
 * This is a deterministic, synchronous pass. Does NOT rewrite content; only trims and validates.
 * Full "rewrite" for warmth/humor would be LLM-based; here we enforce caps and verify numerics.
 *
 * @param {string} validatedAnswer - Answer after numeric enforcement and synthesis gate
 * @param {import('./styleProfiles').CommunicationStyleProfile} styleProfile
 * @param {Object} [opts]
 * @param {boolean} [opts.escalationActive] - Force formal (no humor, concise)
 * @returns {{ text: string, humorUsed: number, numericsUnchanged: boolean }}
 */
function applyStyleConstraints(validatedAnswer, styleProfile, opts = {}) {
    let text = typeof validatedAnswer === 'string' ? validatedAnswer : '';

    const escalation = opts.escalationActive === true;
    const maxSentences = styleProfile.maxSentencesPerTurn ?? 8;
    const humorAllowed = escalation ? false : (styleProfile.humorLevel > 0 && styleProfile.maxHumorPerTurn > 0);

    text = capSentences(text, maxSentences);

    const humorUsed = countHumorMarkers(text);
    if (humorUsed > 0) recordPhase4Metric('humor_usage_rate', 1);

    const numericsCheck = verifyNumericsUnchanged(validatedAnswer, text);
    const numericsUnchanged = numericsCheck.unchanged;

    return {
        text,
        humorUsed,
        numericsUnchanged
    };
}

/**
 * Full style pass for use after synthesis: get profile, apply constraints.
 * Caller must re-run numeric enforcement after persona pass (spec requirement).
 *
 * @param {string} validatedAnswer
 * @param {'structured'|'balanced'|'rapid'} conversationProfileName
 * @param {Object} context - escalationActive, complaintContext, financialDispute, transactionFailure
 * @returns {{ text: string, humorUsed: number, numericsUnchanged: boolean, styleProfile: import('./styleProfiles').CommunicationStyleProfile }}
 */
function applyPersonaPass(validatedAnswer, conversationProfileName, context = {}) {
    const styleProfile = getStyleProfile(conversationProfileName, context);
    const result = applyStyleConstraints(validatedAnswer, styleProfile, {
        escalationActive: context.escalationActive
    });
    return {
        ...result,
        styleProfile
    };
}

module.exports = {
    applyStyleConstraints,
    applyPersonaPass,
    verifyNumericsUnchanged,
    capSentences,
    countHumorMarkers
};
