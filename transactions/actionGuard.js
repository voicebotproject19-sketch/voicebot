'use strict';

const { getConversationProfile } = require('../profiles/conversationProfiles');
const { InteractionMode } = require('../policy/callInteractionPolicy');
const { evaluateTransactionPolicy } = require('./transactionPolicy');

function normalizeConfidence(value) {
    if (value == null) return 1;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : 1;
}

function resolveProfile(profile) {
    return profile || getConversationProfile('structured');
}

function evaluateActionGuard(input = {}, profile = null) {
    const effectiveProfile = resolveProfile(profile);
    const policyInput = {
        interactionMode: input.interactionMode || InteractionMode.INTERACTIVE,
        sttConfidence: normalizeConfidence(input.sttConfidence),
        sttConfidenceThreshold: input.sttConfidenceThreshold == null ? 0.85 : Number(input.sttConfidenceThreshold),
        explicitConfirmationReceived: input.explicitConfirmationReceived === true,
        numericRepetitionReceived: input.numericRepetitionReceived === true,
        backendAuthoritativeOk: input.backendAuthoritativeOk !== false,
        interrupted: input.interrupted === true,
    };

    const result = evaluateTransactionPolicy(policyInput, effectiveProfile);
    return {
        ...result,
        actionType: input.actionType || 'unknown',
        workflowId: input.workflowId || null,
        idempotencyKey: input.idempotencyKey || null,
        policyInput,
        evaluatedAt: new Date().toISOString(),
    };
}

function evaluateDealerOrderActionGuard(input = {}, profile = null) {
    return evaluateActionGuard({
        ...input,
        actionType: 'dealer_order_submit',
        workflowId: 'dealer-orders',
    }, profile);
}

module.exports = {
    evaluateActionGuard,
    evaluateDealerOrderActionGuard,
    normalizeConfidence,
};