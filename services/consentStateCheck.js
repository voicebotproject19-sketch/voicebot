'use strict';
const areaCodeMeta = require('../data/areaCodeMeta.json');

/**
 * US states that require all-party (two-party) consent for recorded telephone calls.
 * Source: widely-cited 13-state TCPA/state wiretapping compliance list.
 */
const TWO_PARTY_CONSENT_STATES = new Set([
    'CA', // California — CIPA
    'CT', // Connecticut
    'FL', // Florida
    'HI', // Hawaii
    'IL', // Illinois — Eavesdropping Act
    'MD', // Maryland
    'MA', // Massachusetts
    'MI', // Michigan
    'MT', // Montana
    'NV', // Nevada
    'NH', // New Hampshire
    'PA', // Pennsylvania
    'WA', // Washington
]);

function classifyNanpPhone(e164Phone) {
    if (typeof e164Phone !== 'string' || !e164Phone.trim()) {
        return { kind: 'invalid', areaCode: null };
    }

    if (!e164Phone.startsWith('+1')) {
        return { kind: 'non_nanp', areaCode: null };
    }

    const digits = e164Phone.replace(/^\+1/, '').replace(/\D/g, '');
    if (digits.length !== 10) {
        return { kind: 'invalid_nanp', areaCode: null };
    }

    return { kind: 'nanp', areaCode: digits.slice(0, 3) };
}

function evaluateRecordingConsentRequirement(e164Phone) {
    const base = {
        gate: 'recording_consent',
        requireExplicitRecordingConsent: true,
        state: null,
        areaCode: null,
    };

    const { kind, areaCode } = classifyNanpPhone(e164Phone);
    if (kind === 'invalid') {
        return { ...base, reason: 'invalid_phone_number' };
    }
    if (kind === 'non_nanp') {
        return {
            ...base,
            requireExplicitRecordingConsent: false,
            reason: 'not_applicable_non_nanp',
        };
    }
    if (kind === 'invalid_nanp') {
        return { ...base, reason: 'invalid_nanp_number' };
    }

    const meta = areaCodeMeta[areaCode];
    if (!meta) {
        return { ...base, reason: 'unknown_nanp_area', areaCode };
    }

    const requiresConsent = TWO_PARTY_CONSENT_STATES.has(meta.state);
    return {
        ...base,
        requireExplicitRecordingConsent: requiresConsent,
        reason: requiresConsent ? 'two_party_state' : 'one_party_state',
        state: meta.state,
        areaCode,
    };
}

/**
 * Returns true when the destination phone number's area code maps to a US state
 * that requires all-party consent before recording.
 *
 * Returns true for invalid or unknown NANP numbers so recording acknowledgment
 * is required when state-level consent cannot be confidently evaluated.
 *
 * @param {string} e164Phone  E.164 number, e.g. "+12135551234"
 * @returns {boolean}
 */
function requiresTwoPartyConsent(e164Phone) {
    return evaluateRecordingConsentRequirement(e164Phone).requireExplicitRecordingConsent;
}

module.exports = {
    requiresTwoPartyConsent,
    evaluateRecordingConsentRequirement,
    TWO_PARTY_CONSENT_STATES,
};
