'use strict';

/**
 * @file conversationPhase.js
 * Deterministic conversation phase calculator for the voice bot pipeline.
 *
 * Pure function — no state, no side effects, no LLM calls.
 * Computes the current phase from existing signals (turn count, boolean flags,
 * hangup decision results) that are already available in the service layer.
 *
 * Phases are universal across all persona types (sales, event, support).
 */

const PHASES = Object.freeze([
    'opening',           // greeting delivered, awaiting first human response
    'screening',         // AI call screener / gatekeeper detected
    'hold',              // user asked to wait ("hold on", "one moment")
    'voicemail',         // voicemail system detected (terminal)
    'discovery',         // qualifying the lead — 1-2 turns max, then pivot to booking
    'offer',             // appointment call offered — awaiting acceptance
    'slot-collection',   // offer accepted — collecting preferred day/time for the call
    'email-collection',  // slot preference captured — collecting email for booking link
    'email-verify',      // email captured — spelling back for explicit confirmation
    'confirmation',      // booking link requested/sent — confirming details and closing
    'rejected',          // user explicitly declined (terminal)
    'success',           // contact flow completed (terminal; provider booking is tracked separately)
]);

const TERMINAL_PHASES = new Set(['voicemail', 'rejected', 'success']);

/**
 * Computes the conversation phase from current state signals.
 *
 * @param {Object} signals
 * @param {string}  signals.currentPhase                - Current value of conversationPhase
 * @param {number}  signals.count                       - Turn counter (0 = no user turns yet)
 * @param {boolean} signals.isBeingScreened             - Call screening active
 * @param {boolean} signals.isVoicemail                 - Voicemail detected (from quick/LLM decision)
 * @param {boolean} signals.isRejected                  - Hard rejection detected
 * @param {boolean} signals.hasAskedForConsultation     - Appointment call offered
 * @param {string|null} signals.preferredSlot           - Preferred day/time captured from user, or null
 * @param {string|null} signals.userEmail               - Captured email, or null
 * @param {boolean} signals.emailConfirmed              - Email confirmed by user
 * @param {boolean} [signals.emailPendingConfirmation]  - Email captured but not yet verified by user
 * @param {boolean} signals.isSuccess                   - Full success detected
 * @param {boolean} [signals.consultationOfferedThisTurn] - Appointment offered on THIS turn (not previous)
 * @param {boolean} [signals.offerAccepted]             - User explicitly accepted the consultation offer
 * @param {boolean} [signals.isOnHold]                  - User asked to hold/pause
 * @param {boolean} [signals.emailRefused]              - User explicitly refused to share email
 * @param {boolean} [signals.bookingPhoneDeliveryConsent] - User explicitly consented to phone link delivery
 * @param {boolean} [signals.bookingLinkRequested]      - Booking link delivery has been requested
 * @param {boolean} [signals.bookingLinkSent]           - Booking link delivery succeeded on at least one channel
 * @returns {string} - New phase
 */
function computePhase(signals) {
    const {
        currentPhase,
        count,
        isBeingScreened,
        isVoicemail,
        isRejected,
        hasAskedForConsultation,
        preferredSlot,           // preferred day/time captured from user
        userEmail,
        emailConfirmed,
        emailPendingConfirmation,
        isSuccess,
        consultationOfferedThisTurn,
        offerAccepted,
        isOnHold,
        emailRefused,
        bookingPhoneDeliveryConsent,
        bookingLinkRequested,
        bookingLinkSent,
    } = signals;

    // Terminal phases are absorbing — no transitions out
    if (TERMINAL_PHASES.has(currentPhase)) return currentPhase;

    // Interrupt transitions (from any non-terminal phase)
    if (isVoicemail) return 'voicemail';
    if (isRejected) return 'rejected';
    // emailConfirmed alone is not enough for success — userEmail must also be present.
    // Without this guard, emailConfirmed=true arriving before userEmail is set causes
    // the phase to jump to 'success' and the persona to render "Sending details to undefined".
    if (isSuccess || (emailConfirmed && userEmail)) return 'success';

    // Screening (can enter/exit)
    if (isBeingScreened) return 'screening';

    // Hold/pause (can enter/exit on next user speech)
    if (isOnHold) return 'hold';

    // Pre-first-turn
    if (count === 0) return 'opening';

    // Email captured but not yet verified → spell-back gate
    if (userEmail && emailPendingConfirmation) return 'email-verify';

    // Email captured and verified → confirmation; provider booking completes via webhook.
    if (userEmail) return 'confirmation';

    // Phone-consented delivery can proceed without an email address.
    if (bookingLinkSent || bookingLinkRequested || bookingPhoneDeliveryConsent) return 'confirmation';

    // User explicitly refused email; keep the flow open for phone delivery fallback.
    if (emailRefused && hasAskedForConsultation && !userEmail) return 'email-collection';

    // Offer just made this turn — wait for acceptance before progressing
    if (consultationOfferedThisTurn) return 'offer';

    // Offer accepted; collect the lowest-friction delivery method. Slot remains optional context.
    if (offerAccepted && hasAskedForConsultation && !userEmail) return 'email-collection';

    // Offer made but not yet accepted → stay in offer
    if (hasAskedForConsultation && !offerAccepted) return 'offer';

    // Default: discovery (qualify the lead)
    return 'discovery';
}

module.exports = { computePhase, PHASES, TERMINAL_PHASES };
