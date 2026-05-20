const { InteractionMode, ContextHint } = require('./callInteractionPolicy');
const telemetry = require('../Utils/telemetry');

/**
 * Optional debug invariant: log only when PHASE3_DEBUG and non-INTERACTIVE. Does not throw.
 * @param {string} interactionMode - Current interaction mode
 * @param {boolean} PHASE3_DEBUG - Phase 3 debug flag
 */
function assertInteractiveBeforeNonGuardedSend(interactionMode, PHASE3_DEBUG) {
    if (PHASE3_DEBUG && interactionMode !== InteractionMode.INTERACTIVE) {
        console.error('[Phase3][InvariantViolation] Non-guarded audio attempted outside INTERACTIVE mode');
    }
}

/**
 * Phase 2.5: Human transcript validation — IVR echo / low-confidence must not unlock INTERACTIVE.
 * @param {string} userText - User transcript text
 * @param {Object} opts - Options object with confidence
 * @param {number} opts.confidence - Confidence score (0-1)
 * @returns {boolean} Whether the transcript is valid
 */
function isValidHumanTranscript(userText, opts) {
    if (!userText) return false;

    const trimmed = userText.trim();
    if (trimmed.length < 2) return false;

    const confidence = typeof opts?.confidence === 'number' ? opts.confidence : 0;
    if (confidence < 0.65) return false;

    return true;
}

/**
 * Phase 2.5: Strict mode transition — blocks illegal transitions, logs allowed.
 * @param {Object} stateObj - State object with interactionMode, connectionId, callId, provider
 * @param {string} nextMode - Next interaction mode
 * @param {string} reason - Reason for transition
 */
function transitionMode(stateObj, nextMode, reason) {
    const allowed = {
        TRANSITIONAL: [InteractionMode.INTERACTIVE, InteractionMode.NON_INTERACTIVE],
        NON_INTERACTIVE: [InteractionMode.INTERACTIVE],
        INTERACTIVE: []
    };

    const current = stateObj.interactionMode;

    // No-op: already in the requested mode — silently skip.
    if (current === nextMode) return;

    if (!allowed[current]?.includes(nextMode)) {
        console.warn(`[ModeGuard] Illegal transition ${current} → ${nextMode}`);
        return;
    }

    console.log(`[ModeTransition] ${current} → ${nextMode} (reason: ${reason})`);
    telemetry.emit('mode_transition', {
        connectionId: stateObj.connectionId || null,
        callId: stateObj.callId || null,
        provider: stateObj.provider || 'unknown',
        from: current,
        to: nextMode,
        reason,
        ts: Date.now()
    });
    stateObj.interactionMode = nextMode;
}

/**
 * Phase 2.5: Policy config validation — log misconfig, do not throw.
 * @param {Object} policyConfig - Policy configuration object
 * @param {string} contextHint - Context hint (VOICEMAIL, OS_SCREENING, etc.)
 */
function validatePolicyConfig(policyConfig, contextHint) {
    if (!policyConfig) return;

    if (contextHint === ContextHint.VOICEMAIL && policyConfig.voicemail?.enabled) {
        if (!policyConfig.voicemail.text) {
            console.warn('[PolicyValidation] Voicemail enabled but no text defined');
        }
    }

    if (contextHint === ContextHint.OS_SCREENING && policyConfig.screening?.enabled) {
        if (!policyConfig.screening.text) {
            console.warn('[PolicyValidation] Screening enabled but no text defined');
        }
    }
}

module.exports = {
    assertInteractiveBeforeNonGuardedSend,
    isValidHumanTranscript,
    transitionMode,
    validatePolicyConfig
};
