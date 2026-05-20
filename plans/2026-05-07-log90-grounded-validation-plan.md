# Log 90 Grounded Validation Plan

Date: 2026-05-07
Call ID: 875236fe-7235-4624-b06e-f8695e07f924
Provider: Plivo + Azure Realtime

## Base Plan

For each suspected issue, validate in this order:

1. Log evidence: exact event sequence, timing, and caller-visible impact.
2. Code owner: module/function that produced or controlled the behavior.
3. Existing coverage: tests that currently pass and gaps they miss.
4. Fix plan: minimal code change plus a targeted regression test.

## Slice Design Rules

These slices are designed for code changes that can be implemented completely inside this repository. A slice is complete only when the behavior is deterministic, covered by focused tests, and does not depend on production-only state to prove correctness.

- Keep each slice independently shippable. Do not mix booking control, garble filtering, handoff scheduling, and telemetry compatibility in one patch.
- Each behavioral slice starts with regression tests that reproduce the exact failure mode, then adds only the code needed to pass those tests.
- Prefer small pure helpers or exported registration functions where the current code path is hard to test directly.
- Do not claim runtime-only checks as 100% code complete. Wrong container working directory, PM2 deployment state, and live Plivo callback shape require operator verification; the repo can only add diagnostics or defensive guards.
- After each slice, run only the focused Jest suites first, then the broader targeted bundle already used in this investigation.

## Grounded Findings

### 1. Explicit booking intent was detected but not honored

Observed evidence:

- User said: "Yes, please. Please book a call."
- Runtime logged `booking_intent_detected` with reason `explicit_booking_request`.
- Runtime transitioned `offer -> email-collection`.
- Next assistant response was: "I want to make sure I understand you correctly. Could you rephrase that for me?"
- User repeated: "Please book a call."
- The retry path produced a generic clarification: "Could you tell me more about the topic or question..."

Code owners:

- `adapters/ai/BaseRealtimeAdapter.js`
  - `_hasExplicitBookingRequest()` detects the booking request.
  - `_markBookingIntentDetected()` records the event.
  - `_detectPhaseContractViolation()` only blocks premature scheduling claims; it does not block rephrase/tell-me-more responses after booking intent.
- `session/conversationEngine.js`
  - `evaluateIntentConfidence()` can deterministically emit the rephrase response before normal prompt generation.
  - The gate has no explicit booking/offer-accepted bypass.

Existing coverage:

- `tests/response-quality-routing.test.js` confirms booking intent is emitted and phone delivery consent can request a link.
- Coverage does not assert that an explicit booking request bypasses the Phase 4 clarification gate.
- Coverage does not assert that email-collection responses after booking intent must ask for delivery permission or move toward handoff.

Fix plan:

1. Add a booking-action short-circuit before the intent-confidence clarification gate in `ConversationEngine.insertUpdatedPrompt()`.
2. Treat `_bookingIntentDetected`, `offerAccepted`, or `_hasExplicitBookingRequest(userQuestion)` as high-confidence actionable booking context.
3. In `email-collection`, force a deterministic response such as: "Great, I can send the booking link. Should I text it to this number?"
4. Extend `_detectPhaseContractViolation()` to reject rephrase/tell-me-more style responses when booking intent is active.
5. Add regression tests for:
   - "Yes, please. Please book a call." in `offer` never yields the rephrase script.
   - "Please book a call." in `email-collection` asks for booking-link delivery consent.

### 2. One speech window was skipped by the noise filter

Observed evidence:

- Speech window 5 had `transcriptLength: 9` and `transcriptDelayMs: 466`.
- It logged `noisy_turn_skipped` instead of `user_transcribed`.
- The transcript was a short non-Latin booking-like phrase, likely equivalent to "book call".
- Local reproduction confirms English booking phrases pass while Hindi/Urdu-script booking-like phrases are treated as garbled.

Code owner:

- `Helper/callClassifier.js`
  - `isGarbledTranscript()` tokenizes with `\w` and later strips printable characters with Latin-heavy regexes.
  - Non-Latin words can collapse to zero/short printable text and be classified as noise.

Existing coverage:

- `tests/callClassifier.test.js` covers English and German short utterances and Moodle phrases.
- It does not cover non-Latin booking-like phrases.

Fix plan:

1. Update tokenization to use Unicode letters/numbers, for example property escapes with the `u` flag.
2. Add a protected short-phrase layer for booking/call terms across expected caller languages, before the short-fragment threshold.
3. Add tests proving non-Latin booking-like phrases are not discarded while true low-content noise still is.

### 3. Moodle requirement was understood but the response drifted away from booking

Observed evidence:

- User said: "I wanted to hire a Moodle developer sales team."
- Runtime response eventually acknowledged capability but asked: "What part should they focus on?"
- The call was already in `email-collection` after explicit booking intent, so reopening discovery was the wrong next step.

Code owners:

- `adapters/ai/BaseRealtimeAdapter.js`
  - `_shouldTriggerDeterministicConsultationPivot()` is intentionally disabled outside `discovery` and after consultation has already been offered.
  - `_PHASE_GOALS.email-collection` correctly says to ask permission to send the booking link or collect email.
- `Helper/hallucinationGuard.js`
  - `getHallucinationFallback()` returns the generic capability fallback: "What part should they focus on?"

Existing coverage:

- `tests/response-quality-routing.test.js` intentionally checks that capability questions like "Can you support Moodle delivery?" do not steal the pivot.
- `tests/phase4-contract-validation.test.js` and `tests/phase4-simulation.test.js` accept Moodle capability answers.
- No test combines Moodle/capability wording with already-active booking intent in `email-collection`.

Fix plan:

1. When booking intent is active, make phase goal outrank capability fallback.
2. Pass booking context into fallback generation, or intercept after fallback generation with phase-contract correction.
3. Add a test: in `email-collection` with `_bookingIntentDetected=true`, a Moodle capability utterance must not ask "What part should they focus on?"; it must ask for delivery permission/contact or proceed to handoff.

### 4. Final handoff succeeded but Azure realtime failed during the handoff message

Observed evidence:

- User said: "Can you please book my call?"
- Runtime sent handoff text: "Let me connect you with a team member..."
- Azure returned `internal_error` about 14 ms later and disconnected with code `1011`.
- The app played hold music, reconnected once, and Plivo transfer completed about 3.6 seconds after the user transcript.

Code owners:

- `session/createCallSession.js`
  - `signal_handover` sends a TTS handoff message and schedules transfer after 3000 ms.
  - Transfer is skipped if `isSessionClosed()` becomes true before the delayed task runs.
- `adapters/telecom/PlivoProvider.js`
  - `transfer()` calls Plivo `client.calls.transfer()` with `/transfer-plivo` XML URL.

Existing coverage:

- Transfer paths and finalization have broad tests, but the observed failure is a runtime sequencing issue: realtime TTS can fail after handoff is committed but before the transfer task runs.

Fix plan:

1. Once handoff is committed and a transfer number exists, make the transfer attempt independent from realtime session health unless the telecom call itself has ended.
2. Emit a `handover_transfer_scheduled` telemetry event immediately before the TTS handoff message.
3. If realtime disconnects during handoff, keep hold music/reconnect for caller comfort, but do not cancel the scheduled transfer solely because Azure websocket state changed.
4. Add a test around `signal_handover`: simulated realtime disconnect before the 3000 ms delay must still call provider.transfer when call state is active.

### 5. Operational warnings

Observed evidence:

- Error log shows repeated `Missing script: "dev"`; current workspace package.json does contain `dev`, so this points to a wrong working directory or stale container image.
- Deployment guard warns cluster mode needs durable context acknowledgement or sticky/single-instance routing.
- Azure telemetry initialization failed with `resourceFromAttributes is not a function`.
- Current local `@opentelemetry/resources` export check shows `resourceFromAttributes` exists, so the runtime that produced the log may have a different dependency tree than this workspace.
- Plivo status callback had no recognizable UUID; this is known initial Plivo create/status behavior.

Fix plan:

1. Verify production/container `package.json` and working directory used by PM2/NPM.
2. Verify `npm ls @opentelemetry/resources @azure/monitor-opentelemetry` in the runtime image, not only locally.
3. Add a defensive telemetry adapter fallback if `resourceFromAttributes` is missing.
4. Keep the Plivo missing-UUID status as warning-level only unless terminal callbacks also miss UUID.

## Validation Commands Already Run

```bash
npm test -- --runInBand tests/callClassifier.test.js tests/response-quality-routing.test.js tests/conversationPhase.test.js
```

Result: 3 suites passed, 286 tests passed.

Additional local probes:

```bash
node -e "const r=require('@opentelemetry/resources'); console.log(Object.keys(r).sort().join(',')); console.log(typeof r.resourceFromAttributes, typeof r.Resource);"
node -e "const { isGarbledTranscript }=require('./Helper/callClassifier'); for (const s of ['book call','please book','Can you please book my call?']) console.log(JSON.stringify(s), isGarbledTranscript(s));"
```

## Logical Implementation Slices

### Slice 1: Current-turn booking action bypasses the clarification gate

Status: implemented on 2026-05-07.

Goal: an explicit booking request in the current caller turn must never be converted into the generic Phase 4 rephrase script.

Files:

- `adapters/ai/BaseRealtimeAdapter.js`
- `session/conversationEngine.js`
- `tests/response-quality-routing.test.js`

Implementation shape:

1. Reset a per-turn marker such as `_bookingActionThisTurn` at the start of `_processUserTranscript()`.
2. Set that marker in `extractEntities()` whenever the current user text has an explicit booking request, booking-link request, offer acceptance, or phone delivery consent. This must happen even if sticky `_bookingIntentDetected` was already true from a previous turn.
3. In `ConversationEngine.insertUpdatedPrompt()`, before `evaluateIntentConfidence()` can emit the rephrase script, short-circuit current-turn booking actions in `offer`, `slot-collection`, `email-collection`, or `email-verify` to a deterministic booking response from `_buildPhaseContractCorrection()`.
4. Reset `_clarificationCount` when the booking short-circuit fires, because this is not an ambiguous intent.

Acceptance tests:

- In `offer`, `"Yes, please. Please book a call."` produces a booking-link consent prompt, not `"Could you rephrase"`.
- In `email-collection`, repeated `"Please book a call."` still produces a booking-link consent prompt even when `_bookingIntentDetected` was already true.
- The test must exercise `ConversationEngine.insertUpdatedPrompt()` with a Phase 4 profile that would otherwise clarify on zero docs.

Completeness boundary:

- This slice fixes deterministic control before response generation.
- It does not change multilingual transcript classification or Azure handoff behavior.

Implemented changes:

- Added `_bookingActionThisTurn` and `_bookingActionReasonThisTurn` to `BaseRealtimeAdapter`.
- Reset the marker at the start of every accepted user transcript and during adapter reset.
- Set the marker for current-turn explicit booking requests, booking-link requests, offer acceptance, and phone delivery consent even when sticky `_bookingIntentDetected` is already true.
- Added a pre-prompt short-circuit in `ConversationEngine.insertUpdatedPrompt()` that sends `_buildPhaseContractCorrection()` for current-turn booking actions in booking phases and resets `_clarificationCount` to zero.
- Added regression tests for offer-phase booking and repeated email-collection booking requests.

Validation:

- `npm test -- --runInBand tests/response-quality-routing.test.js` passed: 1 suite, 48 tests.
- `npm test -- --runInBand tests/response-quality-routing.test.js tests/callClassifier.test.js tests/conversationPhase.test.js` passed: 3 suites, 288 tests.

Hardening pass on 2026-05-08:

- Fixed the booking shortcut so it no longer sends immediately while the assistant is already responding; it now queues through the same deferred-user-input path as normal prompts.
- Fixed the booking shortcut so it defers exact booking instructions while the caller is still speaking.
- Moved scripted-response marking to actual send/deferred-flush time so a queued booking turn cannot mark the currently finishing response as scripted.
- Added hardening tests for active-assistant-response queueing and active-caller-speech deferral.

Hardening validation:

- `npm test -- --runInBand tests/response-quality-routing.test.js tests/sprint4.5-phase4.test.js` passed: 2 suites, 63 tests.
- `npm test -- --runInBand tests/response-quality-routing.test.js tests/callClassifier.test.js tests/conversationPhase.test.js` passed: 3 suites, 290 tests.

### Slice 2: Booking phase contract rejects generic clarification after booking intent

Status: implemented on 2026-05-08.

Goal: if the model or a retry path still produces generic discovery/clarification text after active booking intent, the adapter must repair it before playback.

Files:

- `adapters/ai/BaseRealtimeAdapter.js`
- `tests/response-quality-routing.test.js`

Implementation shape:

1. Extend `_detectPhaseContractViolation(aiText, phase)` for active booking phases.
2. When `_bookingIntentDetected`, `offerAccepted`, `bookingPhoneDeliveryConsent`, or `_bookingActionThisTurn` is true, classify these as violations in `offer`, `slot-collection`, `email-collection`, and `email-verify`:
  - `could you rephrase`
  - `tell me more about the topic`
  - `what part should they focus on`
  - generic discovery requests that do not mention booking/link/contact/email/phone.
3. Reuse `_buildPhaseContractCorrection(phase)` for the repair response.

Acceptance tests:

- `_detectPhaseContractViolation('I want to make sure I understand you correctly. Could you rephrase that for me?', 'email-collection')` returns a booking-phase violation when booking intent is active.
- `_detectPhaseContractViolation('Sure! Could you tell me more about the topic or question...', 'email-collection')` returns a booking-phase violation when booking intent is active.
- Normal factual answers in booking phases are not blocked when they also return to booking/link/contact next steps.

Completeness boundary:

- This is a safety net for bad generated text.
- It should not replace Slice 1; both are needed because Slice 1 prevents the deterministic gate failure and Slice 2 catches later generation/retry drift.

Execution plan:

1. Add focused failing tests around `_detectPhaseContractViolation()` before changing implementation.
2. Define `activeBookingContext` in the detector from `_bookingIntentDetected`, `_bookingActionThisTurn`, `offerAccepted`, `bookingPhoneDeliveryConsent`, `bookingLinkRequested`, and `bookingLinkSent`.
3. In booking phases only, reject generic clarification/discovery language when active booking context exists:
  - rephrase/understand-you-correctly prompts,
  - `tell me more about the topic/question`,
  - `what part should they focus on`,
  - broad discovery questions that do not include booking, link, text, email, phone, contact, or schedule language.
4. Return a specific reason such as `booking_phase_generic_clarification` so telemetry/debug output is explainable.
5. Keep factual answers valid when they contain a booking next step, for example capability/location/pricing answers that end by asking to send the booking link or confirm contact.

Slice 2 validation target:

- `npm test -- --runInBand tests/response-quality-routing.test.js`
- Then the broader targeted bundle: `npm test -- --runInBand tests/response-quality-routing.test.js tests/callClassifier.test.js tests/conversationPhase.test.js`

Implemented changes:

- Extended `_detectPhaseContractViolation()` in `BaseRealtimeAdapter` with active booking context:
  - `_bookingIntentDetected`, `_bookingActionThisTurn`, `offerAccepted`,
  - `bookingPhoneDeliveryConsent`, `bookingLinkRequested`, `bookingLinkSent`.
- In booking phases (`offer`, `slot-collection`, `email-collection`, `email-verify`), added detection for generic booking-incompatible responses:
  - rephrase/understand-you-correctly prompts,
  - generic discovery prompts such as “tell me more about the topic/question” and “what part should they focus on”.
- Added guard so those responses are only blocked when they do not include booking/contact next-step language (booking link/text/email/phone/schedule/contact terms).
- Kept existing premature scheduling-claim detection unchanged.

Slice 2 validation results:

- `npm test -- --runInBand tests/response-quality-routing.test.js` passed: 1 suite, 53 tests.
- `npm test -- --runInBand tests/response-quality-routing.test.js tests/callClassifier.test.js tests/conversationPhase.test.js` passed: 3 suites, 293 tests.

### Slice 3: Unicode-safe garble classifier for short booking-like phrases

Status: implemented on 2026-05-08.

Goal: short non-Latin booking-like phrases must not be dropped as `noisy_turn_skipped` solely because the tokenizer is ASCII/Latin-biased.

Files:

- `Helper/callClassifier.js`
- `tests/callClassifier.test.js`

Implementation shape:

1. Replace ASCII-style word extraction in `isGarbledTranscript()` with Unicode-aware tokenization using Unicode property escapes with the `u` flag.
2. Keep the existing true-positive noise behavior for short fragments such as `"Mobile."`, `"Do it?"`, and `"A bu da."`.
3. Add protected short business-intent phrases for booking/call/link intent in expected caller scripts/languages before the short-fragment threshold runs.
4. Avoid broad language detection; only preserve high-value short phrases that are clearly business/action intent.

Acceptance tests:

- `isGarbledTranscript('بک کو کال') === false`.
- `isGarbledTranscript('कॉल बुक') === false`.
- Existing garble true positives remain true.
- Existing English/German false positives remain false.

Completeness boundary:

- This slice only decides whether a transcript is allowed into the normal turn pipeline.
- It does not translate the phrase or change booking response generation.

Implemented changes:

- Replaced ASCII-biased token boundaries in `isGarbledTranscript()` with Unicode-aware tokenization and normalization using Unicode property escapes.
- Added Unicode normalization helpers that preserve combining marks so Devanagari/Arabic-script short phrases are evaluated correctly.
- Kept existing short-fragment thresholds (`2 words < 5`, `3 words < 7`) but switched printable-length calculation to Unicode-safe counting.
- Extended protected short business-intent phrases with booking-like terms in English and multilingual forms used in this call path.
- Added multilingual regression tests in `tests/callClassifier.test.js` for Arabic/Urdu-script and Devanagari booking phrases.

Slice 3 validation results:

- `npm test -- --runInBand tests/callClassifier.test.js` passed: 1 suite, 202 tests.
- `npm test -- --runInBand tests/callClassifier.test.js tests/response-quality-routing.test.js tests/conversationPhase.test.js` passed: 3 suites, 300 tests.

### Slice 4: Active-booking fallback stays in booking flow for Moodle/capability turns

Status: implemented on 2026-05-08.

Goal: once booking intent is active, capability fallback may answer briefly but must end with the booking/contact next step, not reopen discovery.

Files:

- `adapters/ai/BaseRealtimeAdapter.js`
- `Helper/hallucinationGuard.js`
- `tests/response-quality-routing.test.js`
- `tests/phase4-simulation.test.js` (validation matrix coverage; no Slice 4 code changes required)

Implementation shape:

1. Extend `_buildGuardrailFallbackContext()` to include booking context such as `bookingIntentActive`, `bookingActionThisTurn`, `offerAccepted`, `bookingPhoneDeliveryConsent`, `bookingLinkRequested`, and phone/contact availability.
2. In `getHallucinationFallback()`, when `bookingIntentActive` is true and phase is `offer`, `slot-collection`, `email-collection`, or `email-verify`, capability questions should return a booking-aware fallback.
3. For the observed Moodle case, the fallback can acknowledge capability in one sentence, then ask for the booking-link delivery/contact next step.
4. Update `_shouldSkipSynthesisGateForResponse()` if needed so the new booking-aware fallback is treated as an allowed safe fallback.

Acceptance tests:

- `getHallucinationFallback('email-collection', ..., { userQuestion: 'I wanted to hire a Moodle developer sales team.', bookingIntentActive: true })` does not contain `"What part should they focus on?"`.
- The same fallback does contain a booking/contact/link next step.
- Discovery-phase Moodle capability behavior remains unchanged when booking intent is not active.

Completeness boundary:

- This slice addresses fallback text only.
- It does not change the core booking gate from Slice 1 or the response repair guard from Slice 2.

Detailed grounding pass (2026-05-08):

Observed runtime-repro evidence:

- Direct local probe of `getHallucinationFallback('email-collection', ...)` returns the same capability fallback both with and without booking-context flags (`bookingIntentActive`, `offerAccepted`, `bookingLinkRequested`):
  - `Yes, we can help with that... What part should they focus on?`
  - This confirms booking context is currently ignored by fallback generation.

Code-grounded root cause:

- `BaseRealtimeAdapter._buildGuardrailFallbackContext()` currently returns only `{ userQuestion }` and does not expose booking state into fallback generation.
- `getHallucinationFallback()` only branches by `conversationPhase`, `persona.callType`, and `classifyFallbackQuestion(context.userQuestion)`.
- For `questionType === 'capability'` in sales mode, fallback always returns the generic discovery continuation: `What part should they focus on?`.
- Because this text is a capability answer (not a generic rephrase/discovery template from Slice 2 detector), it can still pass through booking phases when fallback is selected by hallucination/numeric/synthesis retry paths.

Current test-coverage state:

- Existing coverage validates factual fallback behavior in offer phases (`pricing`, `location`, `hearing_check`, `unclear`) but does not assert booking-aware capability fallback in active booking phases.
- Existing Slice 2 tests verify phase-contract blocking of generic rephrase/discovery responses during booking context, but do not assert fallback output rewriting for capability fallback in `email-collection`.

Slice 4 implementation checkpoints (grounded):

1. Extend `_buildGuardrailFallbackContext()` to include booking state:
  - `bookingIntentActive`, `_bookingActionThisTurn`, `offerAccepted`, `bookingPhoneDeliveryConsent`, `bookingLinkRequested`, `bookingLinkSent`, and contact availability (`userPhone`, `userEmail`).
2. Update `getHallucinationFallback()` capability branch:
  - if booking context is active and phase is one of `offer|slot-collection|email-collection|email-verify`, return booking-aware next step instead of `What part should they focus on?`.
3. Preserve existing behavior for:
  - discovery/opening phases,
  - non-booking contexts,
  - non-capability fallback classes.
4. Optional safety reinforcement:
  - include booking-aware capability fallback in `_shouldSkipSynthesisGateForResponse()` allowlist pattern if wording differs from current contextual regexes.

Slice 4 validation matrix (to run after implementation):

- Focused: `npm test -- --runInBand tests/response-quality-routing.test.js -t "booking|fallback|Moodle|capability"`
- Focused fallback contract: `npm test -- --runInBand tests/phase4-simulation.test.js -t "Discovery fallback|General-fallback bypass"`
- Broader targeted bundle: `npm test -- --runInBand tests/response-quality-routing.test.js tests/phase4-simulation.test.js tests/phase4-contract-validation.test.js tests/conversationPhase.test.js`

Implemented changes:

- Extended `BaseRealtimeAdapter._buildGuardrailFallbackContext()` to include booking state and contact availability:
  - `bookingIntentActive`, `bookingActionThisTurn`, `offerAccepted`, `bookingPhoneDeliveryConsent`, `bookingLinkRequested`, `bookingLinkSent`, `userPhoneAvailable`, `userEmailAvailable`.
- Updated `getHallucinationFallback()` capability branch in `hallucinationGuard`:
  - in active booking phases (`offer`, `slot-collection`, `email-collection`, `email-verify`) with active booking context, returns booking-next-step fallback (text booking link / email delivery) instead of generic discovery prompt.
  - preserved existing discovery-style capability fallback when booking context is inactive.
- Expanded `_shouldSkipSynthesisGateForResponse()` contextual allowlist to include booking-link delivery phrasing for general-fallback turns.
- Added Slice 4 regression tests in `tests/response-quality-routing.test.js` for:
  - booking-aware capability fallback output,
  - non-booking capability fallback behavior,
  - enriched guardrail fallback context payload.

Slice 4 validation results:

- Focused Slice 4 tests passed: 1 suite, 5 selected tests (within `tests/response-quality-routing.test.js`).
- Slice 4 validation matrix passed: 4 suites, 309 tests.
- Standard targeted regression bundle passed: 3 suites, 303 tests.

### Slices 1-4 Alignment Audit

Audit status: completed on 2026-05-08.

Current-code alignment:

- Slice 1 remains aligned with implementation intent:
  - `_bookingActionThisTurn` is reset at accepted transcript start and set for explicit booking, offer acceptance, booking-link request, and phone delivery consent.
  - `ConversationEngine.insertUpdatedPrompt()` short-circuits booking actions before the clarification gate, but now uses normal queue/defer/send lifecycle paths.
  - Scripted response state is applied only at actual send/deferred flush, not while a turn is merely queued.
- Slice 2 remains aligned with implementation intent:
  - `_detectPhaseContractViolation()` checks active booking context in booking phases and repairs generic rephrase/discovery drift unless booking/contact next-step language is present.
  - Premature scheduling-claim detection remains unchanged.
- Slice 3 remains aligned with implementation intent:
  - `isGarbledTranscript()` uses Unicode-aware token boundaries, preserves combining marks, and applies Unicode-safe printable-length counting.
  - Protected short booking phrases cover the observed Arabic/Urdu-script and Devanagari cases while existing noise true positives remain covered.
- Slice 4 remains aligned with implementation intent:
  - `_buildGuardrailFallbackContext()` now passes booking state/contact availability into fallback generation.
  - `getHallucinationFallback()` returns booking-next-step capability fallback only in active booking contexts and preserves discovery-style fallback otherwise.
  - The plan now marks `tests/phase4-simulation.test.js` as validation matrix coverage rather than a required implementation edit.

Audit validation:

- Static diagnostics passed for Slice 1-4 implementation, test, and plan files.
- Combined Slice 1-4 validation passed: `npm test -- --runInBand tests/response-quality-routing.test.js tests/callClassifier.test.js tests/conversationPhase.test.js tests/phase4-simulation.test.js tests/phase4-contract-validation.test.js tests/sprint4.5-phase4.test.js` passed: 6 suites, 524 tests.

### Slice 5: Handoff transfer scheduling is resilient to realtime TTS failure

Status: implemented on 2026-05-08.

Goal: once handoff is committed and a transfer number exists, transfer scheduling must not depend on successful Azure realtime TTS handoff audio.

Files:

- `session/createCallSession.js`
- a focused test file, preferably `tests/createCallSession.handover.test.js`
- `Utils/telemetryEvents.js` if a new telemetry event is registered centrally

Implementation shape:

1. Extract the `signal_handover` registration into a testable helper, following the existing pattern used by `registerSilenceHangupSignalHandler()`.
2. Schedule the delayed transfer before attempting `realtimeService.sendTextResponse(handoverMessage)`.
3. Wrap the handoff TTS send in its own try/catch so TTS failure cannot prevent transfer scheduling.
4. Emit `handover_transfer_scheduled` when a transfer number exists and the delayed transfer has been registered.
5. Keep the existing fallback email/hangup behavior when no transfer number exists.

Acceptance tests:

- If `sendTextResponse()` throws, provider `transfer(callSID, transferNumber)` is still called after the delay.
- If `transfer()` returns false, existing `call_transferred` telemetry and callback-offer behavior still run.
- If no transfer number exists, existing `handover_fallback_close` behavior remains unchanged.

Completeness boundary:

- This slice can prove scheduling behavior in code.
- It cannot prove live carrier transfer success; that remains a staging call validation.

Detailed grounding pass (2026-05-08):

Current code path:

- `session/createCallSession.js` defines a testable `registerSilenceHangupSignalHandler()` helper and exports it, but `signal_handover` handling is still inline inside `createCallSession()`.
- `signal_handover` resolves contact settings from `realtimeService.kb.contact`, `realtimeService.persona.contact`, and `HANDOVER_TRANSFER_NUMBER`.
- The handler currently calls `realtimeService.sendTextResponse(handoverMessage)` before scheduling the delayed transfer.
- The delayed transfer is scheduled through `scheduleLifecycleTimeout(..., 3000)`, which checks `isSessionClosed()` before running.
- `cleanupCallSession()` marks the session/turn/edge state closed and clears all lifecycle timers.
- Realtime reconnection failure sets `turnState.isClosed = true` and closes the telecom websocket; websocket close then runs `cleanupCallSession()`.
- `call_transferred` telemetry is emitted only after `provider.transfer(...)` resolves and only if `isSessionClosed()` is still false.

Grounded risk:

- If the handoff TTS send throws, execution jumps to the outer `signal_handover` catch before transfer scheduling, so no transfer attempt is guaranteed.
- If realtime/websocket cleanup closes the session before the 3000 ms timer fires, `scheduleLifecycleTimeout()` drops the transfer attempt.
- If transfer succeeds but the call closes immediately afterward, current code can skip `call_transferred` telemetry because it checks `isSessionClosed()` before emitting.
- `handover_transfer_scheduled` is not currently registered in `Utils/telemetryEvents.js`.

Existing coverage baseline:

- No dedicated `tests/createCallSession.handover.test.js` exists yet.
- Existing reusable signal-handler pattern is covered by `tests/createCallSession.silenceHangup.test.js`.
- Existing selected handover/silence baseline passed: `npm test -- --runInBand tests/createCallSession.silenceHangup.test.js tests/sprint5a-validation.test.js -t "handover|silence hangup"` passed: 2 suites, 8 selected tests.

Grounded implementation checkpoints:

1. Extract `signal_handover` registration into a helper exported from `session/createCallSession.js`, matching the silence-hangup helper style.
2. Schedule/record the transfer attempt before trying realtime TTS handoff audio.
3. Wrap handoff TTS in an isolated try/catch so a realtime send failure cannot prevent transfer scheduling.
4. Use a telecom-call-active predicate for transfer scheduling rather than tying the transfer solely to realtime/websocket session health.
5. Emit and register `handover_transfer_scheduled` before the handoff TTS attempt when a transfer number exists.
6. Preserve no-transfer fallback email/farewell/hangup behavior.
7. Add focused tests for TTS throw, realtime/session closure before transfer delay, transfer failure callback offer, and no-transfer fallback preservation.

Implemented changes:

- Extracted `registerHandoverSignalHandler()` from the inline `signal_handover` block in `session/createCallSession.js` and exported it beside `registerSilenceHangupSignalHandler()`.
- Rewired `createCallSession()` to use the exported handover helper while keeping existing handoff messages, transfer messages, fallback messages, email context, and provider transfer behavior.
- Scheduled and emitted `handover_transfer_scheduled` before attempting handoff TTS when a transfer number exists.
- Wrapped handoff and fallback TTS sends in isolated try/catch blocks so realtime `sendTextResponse()` failures cannot prevent transfer scheduling or fallback continuation.
- Added a transfer-specific timer path and telecom-call-active predicate so transfer attempts are not dropped solely because realtime session state is closed.
- Preserved the no-transfer fallback flow: handover email, farewell message, `handover_fallback_close` telemetry, then delayed hangup.
- Registered `handover_transfer_scheduled` in `Utils/telemetryEvents.js`.
- Added `tests/createCallSession.handover.test.js` covering:
  - transfer scheduling before handoff TTS,
  - TTS throw does not block transfer,
  - transfer still runs when realtime session is closed but telecom call is active,
  - failed transfer offers callback and sends handover email,
  - no-transfer fallback preservation,
  - telemetry event registration.

Slice 5 validation results:

- Focused handover suite passed: `npm test -- --runInBand tests/createCallSession.handover.test.js` passed: 1 suite, 8 tests after hardening.
- Slice 5 adjacent validation passed: `npm test -- --runInBand tests/createCallSession.handover.test.js tests/createCallSession.silenceHangup.test.js tests/sprint5a-validation.test.js` passed: 3 suites, 100 tests after hardening.
- Standard targeted regression bundle passed: `npm test -- --runInBand tests/response-quality-routing.test.js tests/callClassifier.test.js tests/conversationPhase.test.js` passed: 3 suites, 303 tests.
- Prior-slice combined matrix passed after Slice 5 extraction: `npm test -- --runInBand tests/response-quality-routing.test.js tests/callClassifier.test.js tests/conversationPhase.test.js tests/phase4-simulation.test.js tests/phase4-contract-validation.test.js tests/sprint4.5-phase4.test.js` passed: 6 suites, 524 tests.

Hardening pass on 2026-05-08:

- Fixed handover contact resolution so an empty `kb.contact` object no longer masks `persona.contact` handover settings. Persona contact is now the base and knowledge-base contact overrides it when present.
- Hardened the delayed transfer body to skip transfer when `callSID` is missing, regardless of the injected telecom-active predicate.
- Hardened `createCallSession()` transfer activity gating so realtime/edge closed state alone does not block transfer; the concrete predicate now requires a call SID and only rejects known `CallRegistry` status `disconnected`.
- Added regression coverage for:
  - transfer still running after edge/session closed when the telecom predicate says the call is active,
  - persona transfer number fallback when KB contact is empty,
  - no transfer after the telecom call is inactive,
  - no transfer when `callSID` is missing.

### Slice 6: Azure telemetry adapter compatibility fallback

Status: implemented on 2026-05-08.

Goal: telemetry initialization should not fail just because the runtime `@opentelemetry/resources` export shape differs from the local install.

Files:

- `adapters/telemetry/azureTelemetryAdapter.js`
- `tests/telemetry-adapter.test.js`

Implementation shape:

1. Resolve `resourceFromAttributes` defensively.
2. If the function is missing, initialize Azure Monitor without a custom resource instead of throwing during startup.
3. Keep current behavior when `resourceFromAttributes` exists.
4. Add a unit test that mocks `@opentelemetry/resources` without `resourceFromAttributes` and verifies `init()` still calls `useAzureMonitor()`.

Acceptance tests:

- Existing telemetry adapter tests still pass.
- New missing-export test passes.
- No startup exception is thrown when `resourceFromAttributes` is absent.

Completeness boundary:

- This fully handles the code-level failure mode from the error log.
- It does not prove the production image has the intended dependency versions; that requires runtime `npm ls` verification.

Detailed grounding pass (2026-05-08):

Current code path:

- `adapters/telemetry/telemetryAdapter.js` is a facade. `init()` dynamically requires `./azureTelemetryAdapter`, calls its `init()`, and then `emitBatch()`, `recordMetric()`, and `shutdown()` delegate to the loaded implementation.
- `Utils/logger.js` calls `telemetryAdapter.emitBatch(batch)`, so failed Azure adapter initialization leaves the process running but disables Azure custom event/log export.
- `adapters/telemetry/azureTelemetryAdapter.js` currently destructures `resourceFromAttributes` from `@opentelemetry/resources` and calls it unconditionally before `useAzureMonitor()`.
- If `resourceFromAttributes` is missing or not a function, `init()` catches the thrown `TypeError`, logs `Azure telemetry initialization failed: ...`, sets `state.otelLogger = null`, and does not create tracer or metric instruments.
- Current local runtime probe shows `@opentelemetry/resources` does export `resourceFromAttributes`, so the observed failure is a runtime/export-shape drift rather than a deterministic local failure.

Dependency grounding:

- Local export probe passed: `resourceFromAttributes` is a function.
- Initial local `npm ls @opentelemetry/resources @azure/monitor-opentelemetry --depth=1` exposed stale `node_modules` contents: installed `@opentelemetry/resources@2.6.0` was invalid against the root `^2.7.1` range.
- `package.json` and `package-lock.json` already targeted `@opentelemetry/resources@2.7.1`; running `npm install` refreshed local `node_modules` without tracked package metadata changes.
- Refreshed local dependency check now passes with `@azure/monitor-opentelemetry@1.16.0`, root `@opentelemetry/resources@2.7.1`, and `@opentelemetry/sdk-trace-base@2.7.1` all using/deduping `@opentelemetry/resources@2.7.1`.

Existing coverage baseline:

- `tests/telemetry-adapter.test.js` currently mocks `@opentelemetry/resources` with `resourceFromAttributes` always present.
- Existing telemetry tests passed: `npm test -- --runInBand tests/telemetry-adapter.test.js` passed: 1 suite, 20 tests.
- Existing tests cover no connection string, connection-string fallback, custom resource attributes, idempotency, custom events, trace span events, metrics, shutdown, and facade metric passthrough.
- Existing tests do not cover a missing `resourceFromAttributes` export or a throwing resource factory.

Grounded implementation checkpoints:

1. In `azureTelemetryAdapter.init()`, require `@opentelemetry/resources` as a module object rather than destructuring and trusting `resourceFromAttributes`.
2. Build resource attributes exactly as today, preserving `service.name`, namespace, instance id, version, and environment.
3. Create the custom `resource` only when `typeof resources.resourceFromAttributes === 'function'`.
4. If the function is missing, call `useAzureMonitor()` with only `azureMonitorExporterOptions` and omit the `resource` property entirely.
5. If the function exists but throws, log a warning-level message and still call `useAzureMonitor()` without a custom resource.
6. Keep existing behavior unchanged when `resourceFromAttributes` exists: `useAzureMonitor({ resource, azureMonitorExporterOptions: { connectionString } })`.
7. Keep logger/tracer/meter creation after `useAzureMonitor()` so telemetry remains active when only the custom resource is unavailable.

Test implementation checkpoints:

1. Adjust the `@opentelemetry/resources` Jest mock in `tests/telemetry-adapter.test.js` so individual tests can replace the mocked module shape.
2. Add a test where the mocked resources module is `{}` and assert:
  - `adapter.init()` does not throw,
  - `useAzureMonitor()` is called,
  - `mockUseAzureMonitorOpts.resource` is `undefined`,
  - `adapter.__telemetryState.otelLogger`, tracer, and meters are initialized.
3. Add a test where `resourceFromAttributes` throws and assert the same fallback behavior.
4. Keep the existing service-name/resource-attribute tests proving the normal custom-resource path remains intact.

Slice 6 validation target:

- Focused: `npm test -- --runInBand tests/telemetry-adapter.test.js`.
- Dependency visibility: `node -e "const r=require('@opentelemetry/resources'); console.log(Object.keys(r).sort().join(',')); console.log(typeof r.resourceFromAttributes);"`.
- Operational follow-up remains production/container `npm ls @opentelemetry/resources @azure/monitor-opentelemetry --depth=1`, because local package metadata and local refreshed install are now clean but the original failure was observed in a runtime environment.

Implemented changes:

- Updated `adapters/telemetry/azureTelemetryAdapter.js` to require `@opentelemetry/resources` as a module object rather than destructuring `resourceFromAttributes` unconditionally.
- Preserved the normal custom-resource path when `resourceFromAttributes` exists, including service name, namespace, instance id, service version, and deployment environment attributes.
- Added fallback behavior when `resourceFromAttributes` is missing or throws:
  - logs a warning explaining that custom resource initialization was skipped,
  - still calls `useAzureMonitor()` with the connection string,
  - still initializes the OTel logger, tracer, and meters.
- Updated `tests/telemetry-adapter.test.js` so the `@opentelemetry/resources` mock can simulate normal, missing-export, and throwing-export runtime shapes.
- Added focused regression tests for missing `resourceFromAttributes` and throwing `resourceFromAttributes`.

Telemetry deployment hardening completed during final pass:

- `infra/main.bicep` now sets `autoMitigate: null` on scheduled query rules that use `resolveConfiguration`, matching the ARM provider error guidance.
- `infra/main.bicep` now uses the Application Insights resource symbol for the connection-string output in source, removing the source-level `reference()` linter warning.
- `infra/README.md` now calls out that the deployment must use `infra/main.bicep` in place so `../observability/azure-monitor-workbook.json` resolves correctly.

Slice 6 validation results:

- Focused telemetry adapter suite passed: `npm test -- --runInBand tests/telemetry-adapter.test.js` passed: 1 suite, 22 tests.
- Local dependency export probe confirmed `resourceFromAttributes` is currently a function.
- Local dependency tree passed after install sync: `npm ls @opentelemetry/resources @azure/monitor-opentelemetry --depth=1` resolved `@opentelemetry/resources@2.7.1` cleanly.
- Telemetry contract validation passed: `npm run validate:telemetry` passed telemetry contract, completeness, event schema, and observability metric checks.
- Bicep validation passed: `infra/main.bicep` built successfully with `diagnostics: []` using Bicep 0.43.8.
- Bicep file references resolved to `infra/main.bicep` and `observability/azure-monitor-workbook.json`.

Final all-slice validation pass (2026-05-08):

- Static diagnostics passed for all Slice 1-6 implementation/test files and `infra/main.bicep`.
- Combined targeted Jest matrix passed after dependency sync: `npm test -- --runInBand tests/response-quality-routing.test.js tests/callClassifier.test.js tests/conversationPhase.test.js tests/phase4-simulation.test.js tests/phase4-contract-validation.test.js tests/sprint4.5-phase4.test.js tests/createCallSession.handover.test.js tests/createCallSession.silenceHangup.test.js tests/sprint5a-validation.test.js tests/telemetry-adapter.test.js` passed: 10 suites, 646 tests.
- Final whitespace check passed for all changed slice, telemetry, Bicep, and plan files.

Post-audit dependency alignment (2026-05-08):

- Ran standard `npm audit fix` without `--force`; it updated `package-lock.json` only and left `package.json` unchanged.
- Key resolved runtime versions after the lockfile update: `plivo@4.77.0`, `axios@1.16.0`, `nodemailer@8.0.7`, `express-rate-limit@8.5.1`, `@opentelemetry/resources@2.7.1`, and `@azure/monitor-opentelemetry@1.16.0`.
- Full Jest suite passed after the audit fix: `npm test -- --runInBand` passed: 64 suites, 1645 tests.
- Telemetry validation passed after the audit fix: `npm run validate:telemetry` passed telemetry contract, completeness, event schema, and observability metric checks.
- Remaining audit state is 2 moderate findings from `plivo -> request`. NPM only offers `npm audit fix --force`, which would downgrade Plivo to `4.75.1` outside the current `^4.75.7` dependency range, so that forced change was not applied during this pass.

## Operator Verification Items

These are not 100% code-complete slices because they depend on the live deployment environment:

1. Confirm PM2/container working directory and package contents for the repeated `Missing script: "dev"` error.
2. Confirm production `npm ls @opentelemetry/resources @azure/monitor-opentelemetry` output.
3. Confirm cluster mode has sticky routing, single-instance routing, or durable context acknowledgement configured.
4. Confirm Plivo terminal status callbacks include UUIDs; keep initial create/status missing-UUID warnings as non-fatal unless terminal events are also missing UUID.
5. Decide explicitly whether to accept npm's forced Plivo downgrade to `4.75.1` for the remaining `request` advisory, or keep `plivo@4.77.0` and track the upstream dependency risk separately.

## Recommended Execution Order

1. Slice 1: current-turn booking action bypass.
2. Slice 2: booking phase contract repair.
3. Slice 3: Unicode-safe garble classifier.
4. Slice 4: active-booking capability fallback.
5. Slice 5: handoff transfer scheduling resilience.
6. Slice 6: telemetry compatibility fallback.
