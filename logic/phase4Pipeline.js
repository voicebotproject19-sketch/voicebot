/**
 * @deprecated Sprint 6C (F7): This facade is dead code — conversationEngine.js calls
 * underlying modules (ragGuardrails, synthesisScoring, etc.) directly. Zero production imports.
 *
 * Phase 4 — Orchestration facade (optional).
 * Encodes order of operations: intent gate → RAG guardrails → numeric enforcement → synthesis scoring
 * → escalation check → transaction policy (if needed) → persona → re-run numeric enforcement.
 * Does NOT add new awaits; all steps sync except retrieval (caller runs retrieval with timeout).
 * Feature-flag controlled via PHASE4_ENABLED.
 */

const { PHASE4_ENABLED } = require('../config/phase4Config');
const { getConversationProfile } = require('../profiles/conversationProfiles');
const { evaluateIntentConfidence } = require('./intentGate');
const { applyRagGuardrails, legacyRetrievalToDocs } = require('../rag/ragGuardrails');
const { enforceNumerics } = require('../rag/numericEnforcement');
const { computeSynthesisScore, passesSynthesisGate } = require('../rag/synthesisScoring');
const { evaluateEscalation, getEscalationToneOverride } = require('./escalationEngine');
const { evaluateTransactionPolicy } = require('../transactions/transactionPolicy');
const { applyPersonaPass } = require('../persona/styleEngine');

/**
 * Run Phase 4 intent gate only. Call at start of turn when intent confidence available.
 * @param {number} intentConfidence
 * @param {import('../profiles/conversationProfiles').ConversationProfile} profile
 * @param {number} clarificationCount
 * @returns {{ action: 'proceed'|'clarify'|'escalate', clarificationCount: number, abortRag: boolean }}
 */
function runIntentGate(intentConfidence, profile, clarificationCount) {
    if (!PHASE4_ENABLED) {
        return { action: 'proceed', clarificationCount, abortRag: false };
    }
    return evaluateIntentConfidence(intentConfidence, profile, clarificationCount);
}

/**
 * Apply RAG guardrails to raw docs (or legacy string). Returns sanitized docs and zeroDocs flag.
 * @param {Array<{ content: string, relevanceScore?: number }>|string} rawDocsOrString
 * @param {import('../profiles/conversationProfiles').ConversationProfile} profile
 * @param {{ tenantId?: string, maxCharsPerDoc?: number }} [opts]
 */
function runRagGuardrails(rawDocsOrString, profile, opts = {}) {
    if (!PHASE4_ENABLED) {
        const docs = Array.isArray(rawDocsOrString) ? rawDocsOrString : legacyRetrievalToDocs(rawDocsOrString);
        return { docs, zeroDocs: docs.length === 0 };
    }
    const docs = Array.isArray(rawDocsOrString)
        ? rawDocsOrString
        : legacyRetrievalToDocs(rawDocsOrString);
    return applyRagGuardrails(docs, profile, opts);
}

/**
 * Run numeric enforcement. Structured profile can hard-block (allowed=false).
 * @param {string} docContext
 * @param {string} answer
 * @param {import('../profiles/conversationProfiles').ConversationProfile} profile
 */
function runNumericEnforcement(docContext, answer, profile) {
    if (!PHASE4_ENABLED) {
        return { allowed: true, penalty: 0, unsupportedSnippets: [] };
    }
    return enforceNumerics(docContext, answer, profile);
}

/**
 * Run synthesis scoring and gate. Below threshold → caller should clarify/partial/escalate.
 * @param {{ docs: Array<{ content: string, relevanceScore?: number }>, answer: string, docContext: string, numericPenalty?: number, profile?: import('../profiles/conversationProfiles').ConversationProfile }}
 */
function runSynthesisScoring(params) {
    if (!PHASE4_ENABLED) {
        return { finalScore: 1, belowThreshold: false };
    }
    const { docs, answer, docContext, numericPenalty = 0, profile } = params;
    const scoreResult = computeSynthesisScore({ docs, answer, docContext, numericPenalty });
    const threshold = profile && profile.rag ? profile.rag.synthesisThreshold : 0.7;
    return {
        ...scoreResult,
        belowThreshold: !passesSynthesisGate(scoreResult.finalScore, threshold)
    };
}

/**
 * Run escalation check. Returns shouldEscalate and tone override when escalated.
 */
function runEscalationCheck(state, profile) {
    if (!PHASE4_ENABLED) {
        return { shouldEscalate: false, toneOverride: null };
    }
    const trigger = evaluateEscalation({
        clarificationCount: state.clarificationCount,
        maxClarifications: profile.intent.maxClarifications,
        lowSynthesisTurnCount: state.lowSynthesisTurnCount,
        maxLowConfidenceTurns: profile.escalation.maxLowConfidenceTurns,
        transactionFailureCount: state.transactionFailureCount,
        transactionFailureThreshold: 2,
        highRiskDomainDetected: state.highRiskDomainDetected
    });
    return {
        shouldEscalate: trigger.shouldEscalate,
        reason: trigger.reason,
        toneOverride: trigger.shouldEscalate ? getEscalationToneOverride() : null
    };
}

/**
 * Run transaction policy. Only INTERACTIVE; all rules must pass.
 */
function runTransactionPolicy(input, profile) {
    if (!PHASE4_ENABLED) {
        return { allowed: true, failures: [] };
    }
    return evaluateTransactionPolicy(input, profile);
}

/**
 * Apply persona pass. Caller MUST re-run numeric enforcement on returned text before final TTS.
 * Persona does not alter numeric values; verification is in applyStyleConstraints.
 */
function runPersonaPass(validatedAnswer, conversationProfileName, context = {}) {
    if (!PHASE4_ENABLED) {
        return { text: validatedAnswer, numericsUnchanged: true };
    }
    const result = applyPersonaPass(validatedAnswer, conversationProfileName, context);
    return {
        text: result.text,
        numericsUnchanged: result.numericsUnchanged,
        toneOverride: context.escalationActive ? getEscalationToneOverride() : null
    };
}

/**
 * Build combined doc context string from sanitized docs.
 * @param {Array<{ content: string }>} docs
 * @returns {string}
 */
function buildDocContext(docs) {
    if (!Array.isArray(docs)) return '';
    return docs.map(d => d.content).filter(Boolean).join('\n\n');
}

module.exports = {
    runIntentGate,
    runRagGuardrails,
    runNumericEnforcement,
    runSynthesisScoring,
    runEscalationCheck,
    runTransactionPolicy,
    runPersonaPass,
    buildDocContext,
    legacyRetrievalToDocs
};
