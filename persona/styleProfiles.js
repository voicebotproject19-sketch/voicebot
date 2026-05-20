/**
 * Phase 4 — MODULE 9a: CommunicationStyleProfile (Persona) Definitions
 * warmthLevel, humorLevel, verbosityLevel, sentenceComplexity, maxHumorPerTurn, exclamationAllowed.
 * Constraints: no numeric modification, no new commitments. Humor suppressed in complaints,
 * financial disputes, escalation. Persona must never alter factual content.
 */

/**
 * @typedef {Object} CommunicationStyleProfile
 * @property {number} warmthLevel - 0-3
 * @property {number} humorLevel - 0-2
 * @property {number} verbosityLevel - 0-2
 * @property {number} sentenceComplexity - 0-2
 * @property {number} maxHumorPerTurn
 * @property {boolean} exclamationAllowed
 * @property {number} [maxSentencesPerTurn]
 */

const FORMAL = Object.freeze({
    warmthLevel: 0,
    humorLevel: 0,
    verbosityLevel: 0,
    sentenceComplexity: 0,
    maxHumorPerTurn: 0,
    exclamationAllowed: false,
    maxSentencesPerTurn: 4
});

const NEUTRAL = Object.freeze({
    warmthLevel: 1,
    humorLevel: 0,
    verbosityLevel: 1,
    sentenceComplexity: 1,
    maxHumorPerTurn: 0,
    exclamationAllowed: false,
    maxSentencesPerTurn: 6
});

const WARM = Object.freeze({
    warmthLevel: 2,
    humorLevel: 1,
    verbosityLevel: 1,
    sentenceComplexity: 1,
    maxHumorPerTurn: 1,
    exclamationAllowed: true,
    maxSentencesPerTurn: 6
});

const FRIENDLY = Object.freeze({
    warmthLevel: 3,
    humorLevel: 2,
    verbosityLevel: 2,
    sentenceComplexity: 2,
    maxHumorPerTurn: 2,
    exclamationAllowed: true,
    maxSentencesPerTurn: 8
});

const STYLE_BY_CONVERSATION_PROFILE = Object.freeze({
    structured: FORMAL,
    balanced: NEUTRAL,
    rapid: Object.freeze({ ...NEUTRAL, verbosityLevel: 0, maxSentencesPerTurn: 4 })
});

/**
 * Get style profile for a conversation profile name. Escalation/complaint/financial override to FORMAL.
 *
 * @param {'structured'|'balanced'|'rapid'} conversationProfileName
 * @param {Object} [context]
 * @param {boolean} [context.escalationActive]
 * @param {boolean} [context.complaintContext]
 * @param {boolean} [context.financialDispute]
 * @param {boolean} [context.transactionFailure]
 * @returns {CommunicationStyleProfile}
 */
function getStyleProfile(conversationProfileName, context = {}) {
    if (context.escalationActive || context.complaintContext || context.financialDispute || context.transactionFailure) {
        return FORMAL;
    }
    const base = STYLE_BY_CONVERSATION_PROFILE[conversationProfileName] || NEUTRAL;
    return base;
}

module.exports = {
    getStyleProfile,
    FORMAL,
    NEUTRAL,
    WARM,
    FRIENDLY,
    STYLE_BY_CONVERSATION_PROFILE
};
