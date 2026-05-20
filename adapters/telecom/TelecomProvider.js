/**
 * TelecomProvider interface contract.
 *
 * Every provider object (TwilioProvider, PlivoProvider) must satisfy this shape.
 * This file is documentation-only — no runtime enforcement, zero overhead.
 *
 * @typedef {Object} TelecomProvider
 *
 * ── Identity ──────────────────────────────────────────────────────────────────
 *
 * @property {'twilio'|'plivo'} name
 *   Provider identifier used for logging, telemetry, and conditional branches.
 *
 * @property {string} wsRoute
 *   The WebSocket path this provider connects on (e.g. 'connection_twilio').
 *
 * ── Call lifecycle ────────────────────────────────────────────────────────────
 *
 * @property {(
 *   toNumber: string,
 *   name: string,
 *   persona: string,
 *   language: string,
 *   options?: { contextHint?: string|null, policyConfig?: object|null }
 * ) => Promise<{ callSid: string, phoneNumber: string }>} createCall
 *   Initiate an outbound call. Seeds CallRegistry and DB.
 *   Returns { callSid, phoneNumber } on success.
 *
 * @property {(callSid: string) => Promise<void>} hangup
 *   Terminate a live call by SID (Twilio) or UUID (Plivo).
 *   Errors are caught and logged internally; never throws.
 *
 * @property {(
 *   callSid: string,
 *   transferNumber: string,
 *   options?: {
 *     attemptId?: string,
 *     mode?: 'cold'|'warm',
 *     rootCallId?: string,
 *     timeoutSeconds?: number,
 *     confirmTimeoutSeconds?: number,
 *     confirmKey?: string,
 *     agentTargets?: string[]
 *   }
 * ) => Promise<boolean>} transfer
 *   Ask the carrier to redirect a live call to transferNumber. Returns true when
 *   the carrier accepts the transfer request, false on request failure. This is
 *   not bridge confirmation; provider callbacks must prove whether a human leg
 *   actually answered. When attempt options are present, providers include those
 *   identifiers in transfer-specific callback URLs for bridge correlation.
 *
 * ── Incoming call ─────────────────────────────────────────────────────────────
 *
 * @property {(networkUrl: string) => string} incomingCallXml
 *   Returns provider-specific TwiML/XML that connects the inbound call to the
 *   WebSocket stream endpoint. networkUrl should not include the protocol prefix.
 *
 * ── WebSocket event normalisation ─────────────────────────────────────────────
 *
 * @property {(msg: object) => { callId: string, streamId: string }} extractStartFields
 *   Given a parsed 'start' WebSocket message, return canonical { callId, streamId }.
 *   Abstracts Twilio's callSid/streamSid naming vs Plivo's callId/streamId naming.
 *
 * ── Audio gate configuration ──────────────────────────────────────────────────
 *
 * @property {() => {
 *   dynamicThresholdOffset: number,
 *   silenceFramesThreshold: number,
 *   energyOverrideThreshold: number|null,  // null = check skipped; Twilio 0.03, Plivo null by default
 *   maxSilenceFailsafe: number|null         // null = check skipped; Twilio 50, Plivo 150
 * }} getGateConfig
 *   Returns the gate constants for this provider.
 *   Both Twilio and Plivo read from process.env with fallback defaults.
 *   Nullable fields accept "null", "none", "disabled", or "off" to skip
 *   that branch; blank/unset env values use the provider default.
 *
 * ── Audio buffering strategy ──────────────────────────────────────────────────
 *
 * @property {'fifo-queue'|'single-slot'} audioBufferStrategy
 *   'fifo-queue'  — Twilio: frames queued in edgeSession.audioInputQueue (FIFO drain).
 *   'single-slot' — Plivo: latest frame overwrites edgeSession.latestAudioFrame.
 *
 * ── Realtime listener registration timing ────────────────────────────────────
 *
 * @property {'on_start'|'immediate'} listenerRegistrationTiming
 *   'on_start' — Twilio: realtimeService.on() calls happen inside the WS 'start'
 *                event, after removeAllListeners() is called.
 *   'immediate' — Plivo: listeners are registered at WebSocket construction time,
 *                 outside the 'start' event handler.
 */

module.exports = {}; // No runtime exports; this file is a living contract document.
