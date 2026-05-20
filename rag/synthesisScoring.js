/**
 * Phase 4 — MODULE 6: Synthesis Confidence Scoring
 * finalScore = 0.35 grounding + 0.35 alignment + 0.15 structure + 0.15 behavior.
 * If finalScore < profile threshold → clarify / partial / escalate. Never fabricate.
 */

const { recordPhase4Metric } = require('../observability/phase4Metrics');

const WEIGHTS = Object.freeze({
    grounding: 0.35,
    alignment: 0.35,
    structure: 0.15,
    behavior: 0.15
});

/**
 * Grounding score: doc count, avg relevance, variance (low variance = more consistent).
 * @param {Array<{ content: string, relevanceScore?: number }>} docs
 * @returns {number} 0..1
 */
function computeGroundingScore(docs) {
    if (!Array.isArray(docs) || docs.length === 0) return 0;
    const scores = docs.map(d => typeof d.relevanceScore === 'number' ? d.relevanceScore : 0.5);
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    const variance = scores.reduce((acc, s) => acc + (s - avg) ** 2, 0) / scores.length;
    const countNorm = Math.min(1, docs.length / 5);
    const avgNorm = Math.min(1, avg);
    // Sprint 6B.4 (F3): Gate lowVarBonus on mean >= 0.5 — uniformly bad docs should NOT get bonus
    const lowVarBonus = (variance < 0.1 && avg >= 0.5) ? 0.1 : 0;
    return Math.min(1, countNorm * 0.4 + avgNorm * 0.5 + lowVarBonus);
}

/**
 * Alignment: keyword overlap, simple entity overlap, numeric overlap.
 * @param {string} answer
 * @param {string} docContext - Combined doc content
 * @returns {number} 0..1
 */
function computeAlignmentScore(answer, docContext) {
    if (!answer || !docContext) return 0;
    const aWords = new Set(answer.toLowerCase().split(/\s+/).filter(w => w.length > 2));
    const dWords = docContext.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const dSet = new Set(dWords);
    let overlap = 0;
    for (const w of aWords) {
        if (dSet.has(w)) overlap++;
    }
    const keywordScore = aWords.size > 0 ? Math.min(1, overlap / Math.max(1, aWords.size) * 2) : 0.5;
    const numInAnswer = (answer.match(/\d+(?:\.\d+)?/g) || []).length;
    const numInDoc = (docContext.match(/\d+(?:\.\d+)?/g) || []).length;
    const numericScore = numInAnswer === 0 ? 1 : (numInDoc >= numInAnswer ? 1 : Math.max(0, 1 - (numInAnswer - numInDoc) * 0.2));
    return Math.min(1, keywordScore * 0.6 + numericScore * 0.4);
}

/**
 * Structure: hedge density (some hedges good, too many bad), length cap, contradiction flag.
 * @param {string} answer
 * @param {number} maxLength
 * @returns {{ score: number, contradiction: boolean }}
 */
function computeStructureScore(answer, maxLength = 150) {
    if (!answer || typeof answer !== 'string') return { score: 0, contradiction: false };
    const hedges = (answer.match(/\b(maybe|perhaps|might|could|possibly|sometimes|generally|often|typically)\b/gi) || []).length;
    const words = answer.trim().split(/\s+/).length;
    const hedgeDensity = words > 0 ? hedges / words : 0;
    const hedgeScore = hedgeDensity <= 0.1 ? 1 : hedgeDensity <= 0.2 ? 0.7 : 0.4;
    const lengthScore = words <= maxLength ? 1 : Math.max(0, 1 - (words - maxLength) / 100);
    const contradiction = /\b(but|however|although)\s+.*\b(not|never|no)\b.*\b(but|however)\b/i.test(answer) ||
        (answer.includes(' never ') && answer.includes(' always '));
    const score = contradiction ? 0.3 : Math.min(1, hedgeScore * 0.5 + lengthScore * 0.5);
    return { score, contradiction };
}

/**
 * Behavior: unsupported numeric penalty, absolute claims, policy claim without grounding.
 * @param {string} answer
 * @param {string} docContext
 * @param {number} numericPenalty - From numeric enforcement (0..1)
 * @returns {number} 0..1
 */
function computeBehaviorScore(answer, docContext, numericPenalty) {
    let score = 1 - numericPenalty;
    const absoluteClaims = (answer.match(/\b(always|never|everyone|no one|all |none |every |must |certainly)\b/gi) || []).length;
    if (absoluteClaims > 2 && docContext.length < 50) score -= 0.2;
    const policyPhrases = (answer.match(/\b(policy|according to|we require|you must)\b/gi) || []).length;
    if (policyPhrases > 0 && docContext.length < 100) score -= 0.15;
    return Math.max(0, Math.min(1, score));
}

/**
 * Compute final synthesis score. Never fabricate; caller gates on threshold.
 *
 * @param {Object} params
 * @param {Array<{ content: string, relevanceScore?: number }>} params.docs
 * @param {string} params.answer - Raw model answer
 * @param {string} params.docContext - Combined sanitized doc text
 * @param {number} [params.numericPenalty] - From enforceNumerics
 * @param {number} [params.maxAnswerLength]
 * @returns {{ finalScore: number, grounding: number, alignment: number, structure: number, behavior: number }}
 */
function computeSynthesisScore(params) {
    const { docs, answer, docContext, numericPenalty = 0, maxAnswerLength = 150 } = params;
    const grounding = computeGroundingScore(docs);
    const alignment = computeAlignmentScore(answer, docContext);
    const { score: structure } = computeStructureScore(answer, maxAnswerLength);
    const behavior = computeBehaviorScore(answer, docContext, numericPenalty);

    const finalScore =
        WEIGHTS.grounding * grounding +
        WEIGHTS.alignment * alignment +
        WEIGHTS.structure * structure +
        WEIGHTS.behavior * behavior;

    recordPhase4Metric('synthesis_score_distribution', finalScore);

    return {
        finalScore,
        grounding,
        alignment,
        structure,
        behavior
    };
}

/**
 * Gate: is synthesis acceptable for this profile? If not, caller must clarify/partial/escalate.
 * @param {number} finalScore
 * @param {number} profileThreshold - profile.rag.synthesisThreshold
 * @returns {boolean}
 */
function passesSynthesisGate(finalScore, profileThreshold) {
    return typeof finalScore === 'number' && !Number.isNaN(finalScore) && finalScore >= profileThreshold;
}

module.exports = {
    computeSynthesisScore,
    passesSynthesisGate,
    computeGroundingScore,
    computeAlignmentScore,
    computeStructureScore,
    computeBehaviorScore,
    WEIGHTS
};
