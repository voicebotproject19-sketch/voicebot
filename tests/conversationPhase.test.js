'use strict';

/**
 * Validation suite for Helper/conversationPhase.js
 *
 * Run: npx jest tests/conversationPhase.test.js
 */

const { computePhase, PHASES, TERMINAL_PHASES } = require('../Helper/conversationPhase');

function base(overrides = {}) {
    return {
        currentPhase: 'opening',
        count: 0,
        isBeingScreened: false,
        isVoicemail: false,
        isRejected: false,
        hasAskedForConsultation: false,
        offerAccepted: false,
        emailRefused: false,
        isOnHold: false,
        preferredSlot: null,
        userEmail: null,
        emailConfirmed: false,
        emailPendingConfirmation: false,
        isSuccess: false,
        consultationOfferedThisTurn: false,
        ...overrides,
    };
}

// ─── 1. Happy path ──────────────────────────────────────────────────────────
describe('Happy path', () => {
    test('opening: count=0 → opening', () => {
        expect(computePhase(base())).toBe('opening');
    });
    test('opening → discovery: count=1', () => {
        expect(computePhase(base({ count: 1 }))).toBe('discovery');
    });
    test('discovery → offer: consultationOfferedThisTurn=true', () => {
        expect(computePhase(base({ currentPhase: 'discovery', count: 2, hasAskedForConsultation: true, consultationOfferedThisTurn: true }))).toBe('offer');
    });
    test('offer → email-collection when accepted (slot optional)', () => {
        expect(computePhase(base({ currentPhase: 'offer', count: 3, hasAskedForConsultation: true, offerAccepted: true }))).toBe('email-collection');
    });
    test('slot-collection → email-collection: preferredSlot captured', () => {
        expect(computePhase(base({ currentPhase: 'slot-collection', count: 4, hasAskedForConsultation: true, offerAccepted: true, preferredSlot: 'next Tuesday afternoon' }))).toBe('email-collection');
    });
    test('email-collection → email-verify: email captured with pending confirmation', () => {
        expect(computePhase(base({ currentPhase: 'email-collection', count: 5, hasAskedForConsultation: true, offerAccepted: true, preferredSlot: 'next Tuesday afternoon', userEmail: 'test@example.com', emailPendingConfirmation: true }))).toBe('email-verify');
    });
    test('email-collection → confirmation: email captured with confirmation cleared', () => {
        expect(computePhase(base({ currentPhase: 'email-collection', count: 5, hasAskedForConsultation: true, offerAccepted: true, preferredSlot: 'next Tuesday afternoon', userEmail: 'test@example.com' }))).toBe('confirmation');
    });
    test('email-verify → confirmation: emailPendingConfirmation cleared', () => {
        expect(computePhase(base({ currentPhase: 'email-verify', count: 6, hasAskedForConsultation: true, offerAccepted: true, preferredSlot: 'next Tuesday afternoon', userEmail: 'test@example.com', emailPendingConfirmation: false }))).toBe('confirmation');
    });
    test('email-verify → email-collection: email rejected (cleared)', () => {
        expect(computePhase(base({ currentPhase: 'email-verify', count: 6, hasAskedForConsultation: true, offerAccepted: true, preferredSlot: 'next Tuesday afternoon', userEmail: null, emailPendingConfirmation: false }))).toBe('email-collection');
    });
    test('confirmation → success: emailConfirmed=true', () => {
        expect(computePhase(base({ currentPhase: 'confirmation', count: 6, hasAskedForConsultation: true, offerAccepted: true, preferredSlot: 'next Tuesday afternoon', userEmail: 'test@example.com', emailConfirmed: true }))).toBe('success');
    });
});

// ─── 2. Terminal phase absorption ───────────────────────────────────────────
describe('Terminal phase absorption', () => {
    test('success stays success (even with new signals)', () => {
        expect(computePhase(base({ currentPhase: 'success', count: 6, isRejected: true }))).toBe('success');
    });
    test('rejected stays rejected', () => {
        expect(computePhase(base({ currentPhase: 'rejected', count: 3 }))).toBe('rejected');
    });
    test('voicemail stays voicemail', () => {
        expect(computePhase(base({ currentPhase: 'voicemail', count: 1, userEmail: 'x@y.com' }))).toBe('voicemail');
    });
});

// ─── 3. Interrupt transitions ───────────────────────────────────────────────
describe('Interrupt transitions', () => {
    test('discovery → rejected: isRejected=true', () => {
        expect(computePhase(base({ currentPhase: 'discovery', count: 2, isRejected: true }))).toBe('rejected');
    });
    test('email-collection → voicemail: isVoicemail=true', () => {
        expect(computePhase(base({ currentPhase: 'email-collection', count: 3, hasAskedForConsultation: true, preferredSlot: 'Friday morning', isVoicemail: true }))).toBe('voicemail');
    });
    test('offer → success: isSuccess=true', () => {
        expect(computePhase(base({ currentPhase: 'offer', count: 2, hasAskedForConsultation: true, isSuccess: true }))).toBe('success');
    });
    test('confirmation → success: emailConfirmed=true (interrupt)', () => {
        expect(computePhase(base({ currentPhase: 'confirmation', count: 4, userEmail: 'a@b.com', emailConfirmed: true }))).toBe('success');
    });
    test('opening → voicemail: isVoicemail=true at opening', () => {
        expect(computePhase(base({ currentPhase: 'opening', isVoicemail: true }))).toBe('voicemail');
    });
    test('opening → rejected: isRejected=true at opening', () => {
        expect(computePhase(base({ currentPhase: 'opening', isRejected: true }))).toBe('rejected');
    });
});

// ─── 4. Screening ──────────────────────────────────────────────────────────
describe('Screening', () => {
    test('opening → screening: isBeingScreened=true', () => {
        expect(computePhase(base({ isBeingScreened: true }))).toBe('screening');
    });
    test('discovery → screening: isBeingScreened=true mid-call', () => {
        expect(computePhase(base({ currentPhase: 'discovery', count: 2, isBeingScreened: true }))).toBe('screening');
    });
    test('screening → discovery: isBeingScreened=false, count=1 (human reconnect)', () => {
        expect(computePhase(base({ currentPhase: 'screening', count: 1, isBeingScreened: false }))).toBe('discovery');
    });
    test('screening → rejected: rejection during screening', () => {
        expect(computePhase(base({ currentPhase: 'screening', isRejected: true }))).toBe('rejected');
    });
});

// ─── 5. consultationOfferedThisTurn ─────────────────────────────────────────
describe('consultationOfferedThisTurn', () => {
    test('without flag: hasAsked=true but not accepted stays in offer', () => {
        expect(computePhase(base({ currentPhase: 'discovery', count: 2, hasAskedForConsultation: true, consultationOfferedThisTurn: false }))).toBe('offer');
    });
    test('with flag: hasAsked=true + thisTurn=true goes to offer', () => {
        expect(computePhase(base({ currentPhase: 'discovery', count: 2, hasAskedForConsultation: true, consultationOfferedThisTurn: true }))).toBe('offer');
    });
    test('offerAccepted + no slot goes to email-collection', () => {
        expect(computePhase(base({ currentPhase: 'offer', count: 3, hasAskedForConsultation: true, offerAccepted: true }))).toBe('email-collection');
    });
    test('preferredSlot + offerAccepted + hasAsked=true goes to email-collection', () => {
        expect(computePhase(base({ currentPhase: 'slot-collection', count: 3, hasAskedForConsultation: true, offerAccepted: true, preferredSlot: 'Wednesday 2 PM' }))).toBe('email-collection');
    });
});

// ─── 6. Edge cases ──────────────────────────────────────────────────────────
describe('Edge cases', () => {
    test('count=0 always returns opening', () => {
        expect(computePhase(base({ currentPhase: 'discovery', count: 0 }))).toBe('opening');
    });
    test('email captured early (before consultation) → confirmation', () => {
        expect(computePhase(base({ currentPhase: 'discovery', count: 2, userEmail: 'early@test.com' }))).toBe('confirmation');
    });
    test('emailConfirmed without email does not imply success', () => {
        expect(computePhase(base({ currentPhase: 'discovery', count: 2, emailConfirmed: true }))).toBe('discovery');
    });
    test('PHASES array contains all expected phases', () => {
        expect(PHASES.length).toBe(12);
    });
    test('TERMINAL_PHASES has exactly 3 entries', () => {
        expect(TERMINAL_PHASES.size).toBe(3);
    });
    test('TERMINAL_PHASES contains voicemail', () => {
        expect(TERMINAL_PHASES.has('voicemail')).toBe(true);
    });
    test('TERMINAL_PHASES contains rejected', () => {
        expect(TERMINAL_PHASES.has('rejected')).toBe(true);
    });
    test('TERMINAL_PHASES contains success', () => {
        expect(TERMINAL_PHASES.has('success')).toBe(true);
    });
});

// ─── 7. Offer acceptance ────────────────────────────────────────────────────
describe('Offer acceptance', () => {
    test('offer without acceptance stays in offer', () => {
        expect(computePhase(base({ currentPhase: 'offer', count: 3, hasAskedForConsultation: true, offerAccepted: false }))).toBe('offer');
    });
    test('offer with acceptance moves to email-collection', () => {
        expect(computePhase(base({ currentPhase: 'offer', count: 3, hasAskedForConsultation: true, offerAccepted: true }))).toBe('email-collection');
    });
    test('acceptance + slot moves to email-collection', () => {
        expect(computePhase(base({ count: 4, hasAskedForConsultation: true, offerAccepted: true, preferredSlot: 'Monday' }))).toBe('email-collection');
    });
});

// ─── 8. Hold state ──────────────────────────────────────────────────────────
describe('Hold state', () => {
    test('isOnHold=true → hold', () => {
        expect(computePhase(base({ currentPhase: 'discovery', count: 2, isOnHold: true }))).toBe('hold');
    });
    test('hold exits when isOnHold=false', () => {
        expect(computePhase(base({ currentPhase: 'hold', count: 2, isOnHold: false }))).toBe('discovery');
    });
    test('hold overrides screening', () => {
        // hold is checked after screening, so screening wins
        expect(computePhase(base({ count: 1, isBeingScreened: true, isOnHold: true }))).toBe('screening');
    });
});

// ─── 9. Email refused ───────────────────────────────────────────────────────
describe('Email refused', () => {
    test('emailRefused + hasAsked + no email keeps contact fallback open', () => {
        expect(computePhase(base({ count: 5, hasAskedForConsultation: true, offerAccepted: true, emailRefused: true }))).toBe('email-collection');
    });
    test('phone delivery consent without email moves to confirmation', () => {
        expect(computePhase(base({ count: 5, hasAskedForConsultation: true, offerAccepted: true, bookingPhoneDeliveryConsent: true }))).toBe('confirmation');
    });
    test('emailRefused with email present → confirmation (email wins)', () => {
        expect(computePhase(base({ count: 5, hasAskedForConsultation: true, emailRefused: true, userEmail: 'a@b.com' }))).toBe('confirmation');
    });
    test('emailRefused without consultation → discovery (no effect)', () => {
        expect(computePhase(base({ count: 2, emailRefused: true }))).toBe('discovery');
    });
});
