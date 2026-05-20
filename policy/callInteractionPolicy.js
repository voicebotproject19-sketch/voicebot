/**
 * Phase 2.5.1 — Call Interaction Policy
 * Decides IF guarded speech is allowed. Does NOT handle audio, call TTS, or modify EdgeSession.
 * Authoritative: docs/call-context-acceptance.md
 */

const InteractionMode = Object.freeze({
    INTERACTIVE: 'INTERACTIVE',
    NON_INTERACTIVE: 'NON_INTERACTIVE',
    TRANSITIONAL: 'TRANSITIONAL'
});

const ContextHint = Object.freeze({
    VOICEMAIL: 'VOICEMAIL',
    OS_SCREENING: 'OS_SCREENING',
    IVR: 'IVR',
    HOLD: 'HOLD',
    IVR_ROUTING: 'IVR_ROUTING',
    CONFERENCE: 'CONFERENCE'
});

const MESSAGE_TYPE = Object.freeze({
    VOICEMAIL: 'voicemail',
    SCREENING: 'screening'
});

/** ISD/country default language map (config-driven; no inference from audio). */
const ISD_DEFAULT_LANGUAGE = Object.freeze({
    '91': 'en',
    '1': 'en',
    '44': 'en',
    '49': 'de',
    '33': 'fr',
    '34': 'es',
    '39': 'it',
    '81': 'ja',
    '86': 'zh'
});

/**
 * Returns default policy config when none provided.
 * @returns {object}
 */
function getDefaultPolicyConfig() {
    return {
        voicemail: { enabled: false, language: null, text: null },
        screening: { enabled: false, language: null, text: null },
        fallbackLanguage: 'en',
        isoCountryCode: null
    };
}

/**
 * Resolve language for guarded speech: campaign > ISD default > tenant fallback.
 * NEVER infers from audio.
 * @param {object} opts
 * @param {string} [opts.campaignLanguage] - From campaign/call config
 * @param {string} [opts.isoCountryCode] - E.164 country code (e.g. '91')
 * @param {string} [opts.fallbackLanguage] - Tenant fallback
 * @returns {string}
 */
function resolveGuardedLanguage({ campaignLanguage, isoCountryCode, fallbackLanguage }) {
    if (campaignLanguage && typeof campaignLanguage === 'string') return campaignLanguage;
    if (isoCountryCode && ISD_DEFAULT_LANGUAGE[String(isoCountryCode)]) return ISD_DEFAULT_LANGUAGE[String(isoCountryCode)];
    return (fallbackLanguage && typeof fallbackLanguage === 'string') ? fallbackLanguage : 'en';
}

/**
 * Evaluates whether the bot is allowed to speak (normal or guarded).
 * Pure function; no I/O; no TTS; no EdgeSession.
 *
 * @param {object} input
 * @param {string} input.interactionMode - INTERACTIVE | NON_INTERACTIVE | TRANSITIONAL
 * @param {string} [input.contextHint] - VOICEMAIL | OS_SCREENING | etc.
 * @param {string} [input.turnId] - Current turn id (for voicemail turn check)
 * @param {string} [input.currentTurnId] - Session current turn id
 * @param {object} [input.policyConfig] - voicemail/screening enabled, language, text
 * @param {boolean} [input.messageAlreadySent] - Guarded message already sent this call
 * @returns {{ allowSpeak: boolean, messageType?: string, language?: string, text?: string }}
 */
function evaluateSpeechPermission(input) {
    const {
        interactionMode,
        contextHint,
        turnId,
        currentTurnId,
        policyConfig = getDefaultPolicyConfig(),
        messageAlreadySent = false
    } = input;

    if (interactionMode === InteractionMode.INTERACTIVE) {
        return { allowSpeak: true };
    }

    if (interactionMode === InteractionMode.TRANSITIONAL) {
        return { allowSpeak: false };
    }

    if (interactionMode !== InteractionMode.NON_INTERACTIVE) {
        return { allowSpeak: false };
    }

    if (messageAlreadySent) {
        return { allowSpeak: false };
    }

    if (contextHint === ContextHint.VOICEMAIL && policyConfig.voicemail && policyConfig.voicemail.enabled) {
        const turnCurrent = (turnId != null && currentTurnId != null && turnId === currentTurnId);
        if (!turnCurrent) return { allowSpeak: false };
        const language = resolveGuardedLanguage({
            campaignLanguage: policyConfig.voicemail.language,
            isoCountryCode: policyConfig.isoCountryCode,
            fallbackLanguage: policyConfig.fallbackLanguage
        });
        const text = policyConfig.voicemail.text || null;
        return { allowSpeak: true, messageType: MESSAGE_TYPE.VOICEMAIL, language, text };
    }

    if (contextHint === ContextHint.OS_SCREENING && policyConfig.screening && policyConfig.screening.enabled) {
        const language = resolveGuardedLanguage({
            campaignLanguage: policyConfig.screening.language,
            isoCountryCode: policyConfig.isoCountryCode,
            fallbackLanguage: policyConfig.fallbackLanguage
        });
        const text = policyConfig.screening.text || null;
        return { allowSpeak: true, messageType: MESSAGE_TYPE.SCREENING, language, text };
    }

    return { allowSpeak: false };
}

module.exports = {
    InteractionMode,
    ContextHint,
    MESSAGE_TYPE,
    getDefaultPolicyConfig,
    resolveGuardedLanguage,
    evaluateSpeechPermission
};
