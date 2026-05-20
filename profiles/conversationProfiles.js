/**
 * Phase 4 — MODULE 1: ConversationProfile System
 * Strategy control: RAG thresholds, clarification limits, retrieval caps, transaction rules, escalation.
 * Profile selection at call start; config-driven; immutable during call. No dynamic switching mid-call.
 */

const { getPhase4ProfileName } = require('../config/phase4Config');

/**
 * @typedef {Object} RagProfile
 * @property {boolean} enabled
 * @property {number} maxDocs
 * @property {number} retrievalTimeoutMs
 * @property {number} minRelevanceScore
 * @property {number} synthesisThreshold
 */

/**
 * @typedef {Object} IntentProfile
 * @property {number} minConfidence
 * @property {number} clarificationThreshold
 * @property {number} maxClarifications
 */

/**
 * @typedef {Object} EscalationProfile
 * @property {number} maxLowConfidenceTurns
 */

/**
 * @typedef {Object} TransactionProfile
 * @property {boolean} confirmationRequired
 * @property {boolean} numericRepetitionRequired
 */

/**
 * @typedef {Object} ConversationProfile
 * @property {'structured'|'balanced'|'rapid'} name
 * @property {RagProfile} rag
 * @property {IntentProfile} intent
 * @property {EscalationProfile} escalation
 * @property {TransactionProfile} transaction
 */

const STRUCTURED = Object.freeze({
    name: 'structured',
    rag: Object.freeze({
        enabled: true,
        maxDocs: 5,
        retrievalTimeoutMs: 2000,
        minRelevanceScore: 0.4,
        synthesisThreshold: 0.75
    }),
    intent: Object.freeze({
        minConfidence: 0.75,
        clarificationThreshold: 0.75,
        maxClarifications: 3
    }),
    escalation: Object.freeze({
        maxLowConfidenceTurns: 2
    }),
    transaction: Object.freeze({
        confirmationRequired: true,
        numericRepetitionRequired: true
    })
});

const BALANCED = Object.freeze({
    name: 'balanced',
    rag: Object.freeze({
        enabled: true,
        maxDocs: 4,
        retrievalTimeoutMs: 2500,
        minRelevanceScore: 0.35,
        synthesisThreshold: 0.70
    }),
    intent: Object.freeze({
        minConfidence: 0.70,
        clarificationThreshold: 0.70,
        maxClarifications: 2
    }),
    escalation: Object.freeze({
        maxLowConfidenceTurns: 3
    }),
    transaction: Object.freeze({
        confirmationRequired: true,
        numericRepetitionRequired: true
    })
});

const RAPID = Object.freeze({
    name: 'rapid',
    rag: Object.freeze({
        enabled: true,
        maxDocs: 3,
        retrievalTimeoutMs: 3000,
        minRelevanceScore: 0.30,
        synthesisThreshold: 0.60
    }),
    intent: Object.freeze({
        minConfidence: 0.60,
        clarificationThreshold: 0.60,
        maxClarifications: 1
    }),
    escalation: Object.freeze({
        maxLowConfidenceTurns: 4
    }),
    transaction: Object.freeze({
        confirmationRequired: true,
        numericRepetitionRequired: true
    })
});

const PROFILES = Object.freeze({
    structured: STRUCTURED,
    balanced: BALANCED,
    rapid: RAPID
});

/**
 * Get the conversation profile by name. Used at call start; profile is immutable during call.
 * @param {string} [profileName] - If omitted, uses config-driven default.
 * @returns {ConversationProfile}
 */
function getConversationProfile(profileName) {
    const name = profileName != null ? String(profileName).toLowerCase() : getPhase4ProfileName();
    const profile = PROFILES[name];
    return profile != null ? profile : BALANCED;
}

module.exports = {
    getConversationProfile,
    PROFILES,
    STRUCTURED,
    BALANCED,
    RAPID
};
