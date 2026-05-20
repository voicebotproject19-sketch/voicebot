'use strict';

const {
    requiresTwoPartyConsent,
    evaluateRecordingConsentRequirement,
    TWO_PARTY_CONSENT_STATES,
} = require('../services/consentStateCheck');

describe('consentStateCheck', () => {
    // ── State set sanity ───────────────────────────────────────────────────

    test('TWO_PARTY_CONSENT_STATES contains the expected 13 states', () => {
        const expected = ['CA', 'CT', 'FL', 'HI', 'IL', 'MD', 'MA', 'MI', 'MT', 'NV', 'NH', 'PA', 'WA'];
        expect(TWO_PARTY_CONSENT_STATES.size).toBe(13);
        for (const state of expected) {
            expect(TWO_PARTY_CONSENT_STATES.has(state)).toBe(true);
        }
    });

    // ── Two-party consent states — should return true ──────────────────────

    test('California (213) → true', () => {
        expect(requiresTwoPartyConsent('+12135551234')).toBe(true);
    });

    test('California (415) → true', () => {
        expect(requiresTwoPartyConsent('+14155551234')).toBe(true);
    });

    test('Florida (305) → true', () => {
        expect(requiresTwoPartyConsent('+13055551234')).toBe(true);
    });

    test('Illinois (312) → true', () => {
        expect(requiresTwoPartyConsent('+13125551234')).toBe(true);
    });

    test('Maryland (301) → true', () => {
        expect(requiresTwoPartyConsent('+13015551234')).toBe(true);
    });

    test('Massachusetts (617) → true', () => {
        expect(requiresTwoPartyConsent('+16175551234')).toBe(true);
    });

    test('Michigan (313) → true', () => {
        expect(requiresTwoPartyConsent('+13135551234')).toBe(true);
    });

    test('Washington (206) → true', () => {
        expect(requiresTwoPartyConsent('+12065551234')).toBe(true);
    });

    test('Nevada (702) → true', () => {
        expect(requiresTwoPartyConsent('+17025551234')).toBe(true);
    });

    test('Connecticut (860) → true', () => {
        expect(requiresTwoPartyConsent('+18605551234')).toBe(true);
    });

    test('New Hampshire (603) → true', () => {
        expect(requiresTwoPartyConsent('+16035551234')).toBe(true);
    });

    test('Pennsylvania (215) → true', () => {
        expect(requiresTwoPartyConsent('+12155551234')).toBe(true);
    });

    test('Hawaii (808) → true', () => {
        expect(requiresTwoPartyConsent('+18085551234')).toBe(true);
    });

    test('Montana (406) → true', () => {
        expect(requiresTwoPartyConsent('+14065551234')).toBe(true);
    });

    // ── One-party consent states — should return false ────────────────────

    test('Texas (214) → false', () => {
        expect(requiresTwoPartyConsent('+12145551234')).toBe(false);
    });

    test('New York (212) → false', () => {
        expect(requiresTwoPartyConsent('+12125551234')).toBe(false);
    });

    test('Ohio (216) → false', () => {
        expect(requiresTwoPartyConsent('+12165551234')).toBe(false);
    });

    // ── Edge cases ────────────────────────────────────────────────────────

    test('returns false for non-NANP number (UK +44)', () => {
        expect(requiresTwoPartyConsent('+441614960000')).toBe(false);
        expect(evaluateRecordingConsentRequirement('+441614960000')).toMatchObject({
            requireExplicitRecordingConsent: false,
            reason: 'not_applicable_non_nanp',
        });
    });

    test('returns true for null input (fail-closed explicit acknowledgment)', () => {
        expect(requiresTwoPartyConsent(null)).toBe(true);
        expect(evaluateRecordingConsentRequirement(null)).toMatchObject({
            requireExplicitRecordingConsent: true,
            reason: 'invalid_phone_number',
        });
    });

    test('returns true for non-string input (fail-closed explicit acknowledgment)', () => {
        expect(requiresTwoPartyConsent(12135551234)).toBe(true);
        expect(evaluateRecordingConsentRequirement(12135551234)).toMatchObject({
            requireExplicitRecordingConsent: true,
            reason: 'invalid_phone_number',
        });
    });

    test('returns true for unknown NANP area code (fail-closed explicit acknowledgment)', () => {
        expect(requiresTwoPartyConsent('+19995551234')).toBe(true);
        expect(evaluateRecordingConsentRequirement('+19995551234')).toMatchObject({
            requireExplicitRecordingConsent: true,
            reason: 'unknown_nanp_area',
            areaCode: '999',
        });
    });

    test('returns true for too-short NANP number (fail-closed explicit acknowledgment)', () => {
        expect(requiresTwoPartyConsent('+1213')).toBe(true);
        expect(evaluateRecordingConsentRequirement('+1213')).toMatchObject({
            requireExplicitRecordingConsent: true,
            reason: 'invalid_nanp_number',
        });
    });

    test('returns true for overlong NANP number (fail-closed explicit acknowledgment)', () => {
        expect(requiresTwoPartyConsent('+121355512345')).toBe(true);
        expect(evaluateRecordingConsentRequirement('+121355512345')).toMatchObject({
            requireExplicitRecordingConsent: true,
            reason: 'invalid_nanp_number',
            areaCode: null,
        });
    });

    test('returns state metadata for known one-party and two-party states', () => {
        expect(evaluateRecordingConsentRequirement('+12135551234')).toMatchObject({
            requireExplicitRecordingConsent: true,
            reason: 'two_party_state',
            state: 'CA',
            areaCode: '213',
        });
        expect(evaluateRecordingConsentRequirement('+12125551234')).toMatchObject({
            requireExplicitRecordingConsent: false,
            reason: 'one_party_state',
            state: 'NY',
            areaCode: '212',
        });
    });

    test('Indian number whose digits overlap CA area code (916) returns false', () => {
        // +91 916XXXXXXX — without the +1 guard this was a false positive (CA = two-party)
        expect(requiresTwoPartyConsent('+919165551234')).toBe(false);
    });

    test('Canadian number (+1 613, ON) returns false', () => {
        // Ontario is not a two-party consent state
        expect(requiresTwoPartyConsent('+16135551234')).toBe(false);
    });
});
