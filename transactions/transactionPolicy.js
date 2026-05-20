/**
 * Phase 4 — MODULE 8: Transaction Policy Layer
 * Rules: INTERACTIVE mode only; STT confidence >= threshold; explicit confirmation required;
 * numeric repetition required; backend authoritative response required; idempotent execution;
 * abort on interruption. No transaction bypass allowed.
 */

const { InteractionMode } = require('../policy/callInteractionPolicy');
const { recordPhase4Metric } = require('../observability/phase4Metrics');

/**
 * @typedef {Object} TransactionPolicyInput
 * @property {string} interactionMode - INTERACTIVE | NON_INTERACTIVE | TRANSITIONAL
 * @property {number} [sttConfidence]
 * @property {number} [sttConfidenceThreshold]
 * @property {boolean} [explicitConfirmationReceived]
 * @property {boolean} [numericRepetitionReceived] - When values involved
 * @property {boolean} [backendAuthoritativeOk]
 * @property {boolean} [interrupted]
 */

/**
 * @typedef {Object} TransactionPolicyResult
 * @property {boolean} allowed - May execute transaction
 * @property {string[]} failures - List of failed rule names
 */

/**
 * Evaluate whether a transaction may proceed. All rules must pass. No bypass.
 *
 * @param {TransactionPolicyInput} input
 * @param {import('../profiles/conversationProfiles').ConversationProfile} profile
 * @returns {TransactionPolicyResult}
 */
function evaluateTransactionPolicy(input, profile) {
    const failures = [];
    const {
        interactionMode,
        sttConfidence = 0,
        sttConfidenceThreshold = 0.85,
        explicitConfirmationReceived = false,
        numericRepetitionReceived = false,
        backendAuthoritativeOk = false,
        interrupted = false
    } = input;

    if (interactionMode !== InteractionMode.INTERACTIVE) {
        failures.push('INTERACTIVE_mode_required');
    }

    if (profile.transaction.confirmationRequired && !explicitConfirmationReceived) {
        failures.push('explicit_confirmation_required');
    }

    if (profile.transaction.numericRepetitionRequired && !numericRepetitionReceived) {
        failures.push('numeric_repetition_required');
    }

    if (sttConfidence < sttConfidenceThreshold) {
        failures.push('stt_confidence_below_threshold');
    }

    if (!backendAuthoritativeOk) {
        failures.push('backend_authoritative_required');
    }

    if (interrupted) {
        failures.push('abort_on_interruption');
    }

    const allowed = failures.length === 0;
    if (allowed && explicitConfirmationReceived) {
        recordPhase4Metric('transaction_confirmation_rate', 1);
    }

    return { allowed, failures };
}

/**
 * Check only INTERACTIVE. Used as fast guard before full policy evaluation.
 * @param {string} interactionMode
 * @returns {boolean}
 */
function isTransactionModeAllowed(interactionMode) {
    return interactionMode === InteractionMode.INTERACTIVE;
}

module.exports = {
    evaluateTransactionPolicy,
    isTransactionModeAllowed
};
