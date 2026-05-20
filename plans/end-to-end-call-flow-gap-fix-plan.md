# End-to-End Call Flow Remaining Gap Fix Plan

Date: 2026-05-05

## Scope

This plan covers the remaining production and conversion gaps after the booking-link, webhook, queue-overflow telemetry, and hangup-model fixes. It is grounded in the current active runtime:

- HTTP routes: `Routes/Routes.js`
- Controller/webhooks: `Controller/MainController.js`
- Per-call WebSocket session: `session/createCallSession.js`
- In-memory call state: `services/CallRegistry.js`
- Telecom providers: `adapters/telecom/TwilioProvider.js`, `adapters/telecom/PlivoProvider.js`
- Stream services: `services-twilio/stream-service-twilio.js`, `services-plivo/stream-service-plivo.js`
- Persistence queue: `services/writeQueue.js`
- Booking correlation: `services/bookingLinkProvider.js`, `services/bookingDeliveryProvider.js`, `Controller/MainController.js`
- Phase and intent state: `Helper/conversationPhase.js`, `adapters/ai/BaseRealtimeAdapter.js`
- Outcome and business metrics: `services/callFinalizer.js`, `observability/azure-monitor-workbook.json`, `observability/azure-alert-rules.json`
- PM2 runtime: `ecosystem.config.js`

## Current Verdict

The current flow is stronger than the earlier baseline, but it is not fully optimized end to end. The remaining issues are mostly lifecycle/state correctness and measurable conversion optimization. They are not prompt-polish issues.

The highest risk is that call state is process-local while production is configured for clustered workers. Provider callbacks and WebSocket sessions can land on a different worker than the one that created the call. That can lose persona/context, booking state, provider terminal status, or final persistence context.

2026-05-07 booking-flow validation added four conversion-integrity requirements to this plan: outside-call booking attribution must require a valid call correlation key, booking links should carry tamper-resistant correlation, booking intent capture must match the active phase model, and booking completion KPIs must include an intent-cohort denominator in addition to global call completion.

## Critical Gaps

### G1. Clustered PM2 plus in-memory CallRegistry can split call state

Severity: Critical

Evidence:

- `ecosystem.config.js` runs `instances: 'max'` with `exec_mode: 'cluster'`.
- `services/CallRegistry.js` stores calls in a process-local `Map`.
- `session/createCallSession.js` hydrates call/session behavior from `CallRegistry.get(edgeSession.callSID)` at WebSocket `start`.
- `Controller/MainController.js` has fallback creation paths when registry state is missing, but those fallbacks only preserve limited context.

Impact:

- The call creation request, provider answer callback, provider status callback, booking webhook, and WebSocket session may not share the same in-memory state.
- Persona, language, AI provider, context hint, consent requirements, and booking state can degrade to defaults.
- This directly reduces booking conversion because the bot can enter a generic or incomplete sales flow.

Fix direction:

- Add a durable call context store and hydrate missing local registry state from it.
- Until that exists, production should not use multi-worker cluster mode unless sticky routing and callback affinity are guaranteed.

### G2. Plivo terminal status can delete state before WebSocket finalization

Severity: Critical

Evidence:

- `Helper/PlivoStatusHandler.js` deletes `CallRegistry` entries on terminal statuses.
- `session/createCallSession.js` only persists `persist_call`, `persist_outcome`, and `call_summary` if `CallRegistry.get(edgeSession.callSID)` exists in the WebSocket close handler.

Impact:

- If Plivo terminal status arrives before WebSocket `close`, the finalizer can miss the transcript/outcome persistence path.
- This can undercount calls, lose outcomes, and corrupt conversion reporting.

Fix direction:

- Status handlers should mark terminal provider status, not delete live call state.
- Deletion should remain owned by WebSocket finalization or a dedicated idempotent finalizer.

### G3. Twilio status callback is a no-op

Severity: High

Evidence:

- `Routes/Routes.js` exposes `POST /twilio-status` behind `twilioWebhookAuth`.
- `Controller/MainController.js` currently returns `ok` without normalizing or storing Twilio callback payloads.
- `TwilioProvider.createCall()` configures `statusCallback` and status events.

Impact:

- Failed, busy, no-answer, abandoned, or completed calls are not available as provider truth unless the WebSocket close path also ran cleanly.
- Operations cannot distinguish call delivery failures from bot conversation failures.
- Conversion funnel analysis misses pre-conversation leakage.

Fix direction:

- Implement Twilio status normalization and persistence with parity to Plivo.
- Do not use status callbacks to blindly overwrite provider-webhook booking truth.

### G4. Finalization logic is not centralized or idempotent

Severity: High

Evidence:

- `session/createCallSession.js` owns final `persist_call` and `persist_outcome` enqueue calls inline in `ws.on('close')`.
- Provider status handlers have their own lifecycle cleanup behavior.
- `OutcomeRepository.createOutcome()` is idempotent at DB level, but session-level finalization has no single owner.

Impact:

- Provider callbacks, WebSocket close, reconnection failures, and process shutdown can race.
- Some paths can miss final persistence; future fixes risk duplicating finalization logic.

Fix direction:

- Create a shared finalizer service that derives outcome once and enqueues/persists idempotently.
- WebSocket close and provider status fallback should both call the same finalizer.

### G5. Stream-service duplicate-audio protection is asymmetric and likely ineffective

Severity: Medium

Evidence:

- `services-twilio/stream-service-twilio.js` has `lastPayloadHash`.
- `services-plivo/stream-service-plivo.js` does not.
- Twilio's current hash includes `currentAudioTask`, which is regenerated with a UUID inside each `sendAudioDirect()` call, so it will not reliably catch duplicate payloads across calls.

Impact:

- Duplicate outbound audio may still slip through, especially under jitter or retry conditions.
- Repetition and overlapping playback reduce trust and conversion.

Fix direction:

- Move duplicate suppression to a shared helper that hashes payload content, turn id, response id, and a short time window without relying on a newly generated task id.
- Apply it consistently to Twilio and Plivo.

### G6. Conversion funnel is observable in pieces but not as a product metric

Severity: Medium

Evidence:

- Booking events, delivery attempts, email lifecycle, and outcomes are emitted/persisted in different paths.
- There is no single repository/API/report that joins call initiated -> connected -> contact captured -> booking link requested -> delivery sent -> provider booking completed/cancelled.

Impact:

- The team can know that a booking link was sent or completed, but cannot easily see where calls leak.
- Without stage-level conversion, prompt/flow changes cannot be optimized with confidence.

Fix direction:

- Add a secured funnel reporting query and telemetry summary by provider/persona/channel/date.
- Use it to guide A/B experiments on channel order, consent wording, and booking prompt timing.

### G7. CORS origin configuration contains a path entry

Severity: Low

Evidence:

- `app.js` includes `https://voicebot.eastus2.cloudapp.azure.com/demobot` in `allowedOrigins`.
- CORS origin matching uses scheme, host, and port, not URL path.

Impact:

- The path-based entry is inert and can mislead operators reviewing exposure.

Fix direction:

- Replace hardcoded duplicates with `CORS_ALLOWED_ORIGINS` parsing and exact origin validation.

### G8. Latency observability is tied to Phase 3 feature enablement

Severity: Medium

Evidence:

- `config/latencyResponsivenessRuntime.js` returns early from `logLatencyOverruns()` when `PHASE3_ENABLED` is false.
- `config/latencyResponsivenessConfig.js` treats Phase 3 as the global kill switch for latency logging, prewarm, pacing, micro-ack, and compensation.

Impact:

- Operators may disable Phase 3 features and also lose passive latency overrun visibility.
- Prior logs showed latency overruns; hiding these makes conversion regressions harder to diagnose.

Fix direction:

- Split passive latency measurement from active latency compensation/features.
- Keep low-cost overrun telemetry available without enabling prewarm, pacing, or micro-acks.

### G9. Completed booking webhooks without call correlation are accepted but not attributable

Severity: Critical

Evidence:

- `Controller/MainController.js` can enqueue `persist_booking_event` with `callSID: normalized.callId || null`.
- `Controller/MainController.js` only enqueues `update_outcome_status` when `normalized.callId` exists.
- `Controller/MainController.js` can emit `booking_completed_webhook` with `callId: normalized.callId || null`.
- `observability/azure-monitor-workbook.json` and `observability/azure-alert-rules.json` filter completion metrics to events with a non-empty `callId`.

Impact:

- A real booking completed outside the call can be persisted as an orphan event but not counted toward the call's completion metric.
- Conversion reporting can undercount completed meetings while giving operators no direct orphan-booking work queue.
- Provider retries or payload-shape drift can silently degrade attribution.

Fix direction:

- Treat completed/cancelled booking webhooks with no resolvable call id as orphan booking events, not attributed completions.
- Emit explicit `booking_webhook_orphaned` telemetry with provider, event type, external booking id presence, and reason.
- Persist orphan booking events with enough non-PII provider metadata for reconciliation, but do not emit `booking_completed_webhook` or update `call_outcomes` without a validated call id.
- Add operational reporting for orphan booking count by provider and event type.

### G10. Booking call correlation is plain query-string state, not tamper-resistant

Severity: High

Evidence:

- `services/bookingLinkProvider.js` writes `call_id` and `utm_content` directly into generated booking links.
- `services/bookingLinkProvider.js` accepts call ids recovered from tracking fields or URLs during webhook normalization.
- Provider webhook auth validates the provider request, but it does not prove that the call id embedded in the booking link was issued by this system.

Impact:

- A modified booking URL can attribute a completion to the wrong call if the provider returns the altered tracking value.
- Accidental link copying/editing can create false-positive completion metrics.
- A future public or forwarded link can become a metric-integrity risk.

Fix direction:

- Add a signed correlation token to booking links, for example `booking_ref`, using HMAC over call id, provider, issued timestamp, and link hash or nonce.
- Verify the token before accepting the recovered call id for completed/cancelled booking attribution.
- Keep a legacy compatibility path that records unsigned completions as lower-confidence or orphaned until the rollout window expires.
- Add tests for valid signature, tampered call id, missing signature, stale signature, and legacy unsigned behavior.

### G11. Booking intent capture is tied to an inactive phase path

Severity: High

Evidence:

- `Helper/conversationPhase.js` currently treats the slot as optional and moves accepted offers directly to `email-collection`.
- `adapters/ai/BaseRealtimeAdapter.js` detects `booking_intent_detected` only in `slot-collection`.
- Duplicate-correction phase goals still describe `slot-collection` as active booking-link permission flow.

Impact:

- Users can accept booking or ask for a link in the active flow without generating `booking_intent_detected`.
- Funnel stage counts can underreport real booking intent, making conversion rates and drop-off analysis unreliable.
- Prompt or channel-order experiments can optimize against a biased denominator.

Fix direction:

- Choose one active phase model: either reintroduce deterministic `slot-collection`, or keep the lower-friction no-slot model and move booking-intent capture into `offer`, `email-collection`, `email-verify`, and `confirmation` where appropriate.
- Emit booking intent once per call when explicit booking request, offer acceptance, phone delivery consent, or confirmed email creates booking-ready intent.
- Align phase-goal copy, duplicate-correction prompts, tests, and telemetry with the chosen model.

### G12. Booking completion KPI is global-call based, not intent-cohort based

Severity: Medium

Evidence:

- `observability/azure-alert-rules.json` computes completion percentage using all `call_summary` calls as the denominator.
- `observability/azure-monitor-workbook.json` has top-line booking completion and link rates, but no required intent-cohort completion panel.

Impact:

- Global completion rate is useful for business health, but it cannot show whether booking flow changes improve conversion among callers who expressed booking intent.
- A campaign mix shift can move the global rate without any booking-flow regression or improvement.

Fix direction:

- Keep the global booking completion KPI.
- Add an intent-cohort KPI where the denominator is calls with booking intent, offer accepted, booking link requested, or link sent.
- Add alert/workbook panels for stage drop-off: intent -> link requested -> delivery sent -> provider completed/cancelled.

## Implementation Plan

### Slice 1: Provider status parity and safe lifecycle marking

Status: Implemented on 2026-05-05.

Goal: Stop provider status callbacks from losing call state and make Twilio status useful.

Files:

- `Controller/MainController.js`
- `Helper/PlivoStatusHandler.js`
- New `services/telecomStatusService.js`
- `Utils/telemetryEvents.js`
- Tests under `tests/`

Steps:

1. Add `services/telecomStatusService.js` with:
   - `normalizeTwilioStatus(payload)`
   - `normalizePlivoStatus(payload)` or migration of current Plivo normalization
   - `isTerminalProviderStatus(provider, status)`
   - `recordProviderStatus({ provider, callSID, status, payload, source })`
2. Update `Controller.MainController.twilioStatus` to normalize Twilio payload and call `recordProviderStatus()`.
3. Update `Helper/PlivoStatusHandler.js` to call the shared service.
4. Replace Plivo `CallRegistry.delete()` on terminal status with `CallRegistry.update(callSID, { providerStatus, providerTerminal: true, providerTerminalAt })`.
5. Emit telemetry for `telecom_status_received`, `telecom_status_terminal`, and `telecom_status_missing_call_id`.
6. Add tests:
   - Twilio completed/failed/no-answer callback updates registry and returns `ok`.
   - Plivo terminal callback does not delete registry before WebSocket finalization.
   - Missing call id is acknowledged but telemetry is emitted.

Acceptance:

- Twilio and Plivo status callbacks both update call lifecycle state.
- No provider status handler deletes `CallRegistry` directly.
- Existing booking webhook behavior remains unchanged.

Implemented files:

- `services/telecomStatusService.js`
- `Controller/MainController.js`
- `Helper/PlivoStatusHandler.js`
- `Utils/telemetryEvents.js`
- `tests/telecomStatusHandlers.test.js`

### Slice 2: Durable call context hydration for clustered runtime

Status: Implemented on 2026-05-05.

Goal: Make call context recoverable when callbacks/WebSockets hit a different worker.

Files:

- New migration `migrations/009_call_context_snapshots.sql`
- New `repositories/CallContextRepository.js`
- New `services/CallContextStore.js`
- `Controller/MainController.js`
- `adapters/telecom/TwilioProvider.js`
- `adapters/telecom/PlivoProvider.js`
- `session/createCallSession.js`
- `docs/manual-migration-runbook.md`

Steps:

1. Create `call_context_snapshots` table keyed by `callSID`, with provider, phoneNumber, name, persona, language, aiProvider, contextHint, policyConfig JSON, consent flag, provider status, booking status, createdAt, updatedAt.
2. Add repository methods:
   - `upsertInitialContext(callSID, context)`
   - `patchContext(callSID, patch)`
   - `getContext(callSID)`
3. On successful `createCall()`, persist initial context before returning success to the API handler where possible.
4. In `session/createCallSession.js`, when local `CallRegistry.get()` misses, hydrate from `CallContextStore.getContext()` before falling back to generic defaults.
5. When status or booking webhooks update local registry, also patch durable context.
6. Add startup warning if `ecosystem.config.js` or env implies cluster mode but durable context migrations are unavailable.

Acceptance:

- A WebSocket `start` event can recover persona/language/AI provider/context from DB when local memory is empty.
- Clustered deployments no longer depend on same-worker call creation affinity.
- Tests simulate missing local registry plus DB snapshot and verify correct adapter initialization context.

Implementation note: initial durable upserts are owned by `Controller/MainController.js`, where the API handler has the complete persona/language/options context before returning success. The telecom adapters were inspected; direct adapter writes were not needed because `PlivoProvider` already parks pending metadata for answer-url hydration, and `TwilioProvider`/`PlivoProvider` create calls only through the controller path.

### Slice 3: Central idempotent call finalizer

Status: Implemented on 2026-05-05.

Goal: Make final persistence reliable across WebSocket close, provider terminal callbacks, and abnormal disconnects.

Files:

- New `services/callFinalizer.js`
- `session/createCallSession.js`
- `services/telecomStatusService.js`
- `services/writeQueue.js`
- Tests under `tests/`

Steps:

1. Move final outcome derivation and `persist_call`/`persist_outcome` enqueue logic into `callFinalizer.finalizeCall()`.
2. Add idempotency using local registry flags plus DB upsert behavior.
3. If rich `realtimeService` state exists, persist full transcript/outcome exactly as today.
4. If only provider terminal state exists, persist a minimal provider-derived outcome using current enum values, mapping failed/busy/no-answer/canceled to `abandoned` unless a richer enum migration is added.
5. Emit `call_finalization_started`, `call_finalization_completed`, and `call_finalization_degraded` telemetry.
6. Have WebSocket close call the finalizer.
7. Have provider terminal status schedule a delayed fallback finalization only if no WebSocket finalization appears within a short grace period.

Acceptance:

- WebSocket close remains the normal rich finalization path.
- Provider terminal fallback captures calls that never reached a usable WebSocket session.
- Duplicate finalization attempts are safe.

Implemented files:

- `services/callFinalizer.js`
- `session/createCallSession.js`
- `services/telecomStatusService.js`
- `Utils/telemetryEvents.js`
- `tests/callFinalizer.test.js`
- `tests/telecomStatusService.test.js`

### Slice 3A: Booking webhook attribution integrity

Goal: Prevent outside-call booking completions from being counted unless they are aligned to a valid call.

Status: Implemented and locally validation-complete.

Implemented files:

- `Controller/MainController.js`
- `repositories/BookingRepository.js`
- `migrations/010_booking_webhook_orphans.sql`
- `app.js`
- `Utils/telemetryEvents.js`
- `observability/azure-monitor-workbook.json`
- `observability/azure-alert-rules.json`
- `infra/main.bicep`
- `tests/bookingPersistence.test.js`

Files:

- `Controller/MainController.js`
- `services/bookingLinkProvider.js`
- `repositories/BookingRepository.js`
- `Utils/telemetryEvents.js`
- `observability/azure-monitor-workbook.json`
- `observability/azure-alert-rules.json`
- Tests under `tests/booking*.test.js`

Steps:

1. Add a normalization outcome for missing or invalid call correlation, for example `ok: false, reason: 'missing_booking_call_id'` for completed/cancelled provider events that cannot be tied to a call.
2. In `bookingWebhook`, do not emit `booking_completed_webhook` and do not enqueue `update_outcome_status` unless the booking event has a validated call id.
3. Persist orphan booking events separately or with an explicit orphan status/reason so support can reconcile them by provider and external booking id without counting them as completed call outcomes.
4. Emit `booking_webhook_orphaned` telemetry with provider, event type, status, external booking id presence, and reason.
5. Add workbook/alert visibility for orphan webhook count and orphan rate.
6. Add tests for Calendly and Microsoft Bookings completed/cancelled payloads with missing call ids.

Acceptance:

- A completed/cancelled provider webhook without call id is acknowledged but not counted as a booking completion.
- Orphan webhook events are visible in telemetry and persistence for reconciliation.
- Valid call-id webhooks still update `CallRegistry`, durable call context, `booking_events`, `call_outcomes`, and completion telemetry.

### Slice 3B: Signed booking correlation token

Goal: Make booking-link call attribution tamper-resistant while preserving a controlled migration path for existing links.

Status: Implemented and locally validation-complete.

Implemented files:

- `services/bookingLinkProvider.js`
- `.env.example`
- `docs/manual-migration-runbook.md`
- `tests/bookingLinkProvider.test.js`
- `tests/bookingPersistence.test.js`

Files:

- `services/bookingLinkProvider.js`
- `services/bookingWebhookVerifier.js` if shared signing helpers belong there
- `.env.example`
- `docs/manual-migration-runbook.md`
- `tests/bookingLinkProvider.test.js`
- `tests/bookingWebhookAuth.test.js` or new focused correlation tests

Steps:

1. Add `BOOKING_CORRELATION_SECRET`; fail closed for signed-correlation enforcement in production once configured.
2. Generate a `booking_ref` HMAC token when building booking links. Include call id, provider, issued timestamp, and a nonce or link hash in the signed payload.
3. Include the signed token in Calendly/Microsoft/static link parameters without exposing PII.
4. During webhook normalization, recover both the call id and signed token. Accept the call id for attribution only when the token verifies and is not stale.
5. Add a migration mode for legacy unsigned links: record as `legacy_unsigned`, emit telemetry, and optionally attribute only during a short rollout window.
6. Add tests for valid token, tampered call id, tampered token, missing token, stale token, and legacy migration behavior.

Acceptance:

- Tampering `call_id` or `utm_content` prevents attribution to a call.
- Valid signed links still attribute provider completions to the original call.
- Unsigned legacy behavior is explicit, measurable, and time-bounded.

### Slice 4: Stream duplicate suppression parity

Goal: Reduce duplicate/overlapping bot audio without dropping valid repeated phrases.

Files:

- New `Utils/audioPayloadDeduper.js`
- `services-twilio/stream-service-twilio.js`
- `services-plivo/stream-service-plivo.js`
- Tests under `tests/`

Steps:

1. Implement a bounded per-stream dedupe helper using payload length, content prefix/hash, turn id, optional response id, and a short time window.
2. Remove the task-id-dependent Twilio hash from the dedupe decision.
3. Apply the helper to both Twilio and Plivo before sending outbound media/playAudio frames.
4. Emit `duplicate_audio_suppressed` with provider, turn id, and payload length.
5. Add tests proving immediate duplicate payloads are suppressed and later legitimate repeats are allowed.

Acceptance:

- Twilio and Plivo share duplicate suppression behavior.
- Current pacing/mark behavior remains intact.

### Slice 5: Conversion funnel reporting

Goal: Make conversion optimization measurable, not anecdotal.

Files:

- New `repositories/ConversionFunnelRepository.js`
- New secured route/controller method, for example `GET /api/conversion-funnel`
- Existing repositories: `CallRepository`, `OutcomeRepository`, `BookingRepository`
- Tests under `tests/`

Steps:

1. Define funnel stages:
   - call_created
   - provider_connected
   - first_user_speech
   - contact_captured_email
   - contact_captured_phone
   - booking_link_requested
   - booking_delivery_attempted
   - booking_delivery_sent
   - booking_delivery_failed
   - booking_provider_completed
   - booking_provider_cancelled
2. Query existing tables/events to aggregate stage counts by date range, provider, persona, language, and delivery channel.
3. Add secured API endpoint for funnel summary.
4. Add daily telemetry summary or script for operational reporting.
5. Add tests with seeded DB mocks for stage joins and drop-off percentages.

Acceptance:

- Operators can see exactly where bookings leak.
- Future prompt or channel-order changes can be evaluated by real conversion stages.

### Slice 5A: Booking intent and phase-model alignment

Goal: Make booking intent detection match the active low-friction booking flow.

Status: Implemented and locally validation-complete.

Implemented files:

- `adapters/ai/BaseRealtimeAdapter.js`
- `Utils/telemetryEvents.js`
- `tests/response-quality-routing.test.js`

Files:

- `Helper/conversationPhase.js`
- `adapters/ai/BaseRealtimeAdapter.js`
- `session/conversationEngine.js`
- `Utils/telemetryEvents.js`
- `tests/conversationPhase.test.js`
- `tests/response-quality-routing.test.js`
- `tests/phase4-contract-validation.test.js`

Steps:

1. Decide the authoritative flow: either reintroduce `slot-collection` as a real phase, or keep slot optional and remove `slot-collection` as a required booking-intent gate.
2. If slot remains optional, detect `booking_intent_detected` in active phases where booking intent occurs: `offer`, `email-collection`, `email-verify`, `confirmation`, and any explicit booking request during discovery.
3. Emit booking intent once per call when one of these signals occurs: explicit booking request, offer accepted, phone delivery consent, email confirmed for booking context, or booking link requested.
4. Update duplicate-correction phase goals and persona prompt guidance so they do not depend on dead-phase behavior.
5. Add end-to-end-style adapter tests for offer acceptance -> booking intent -> link request, phone-consent-only booking, email-confirmed booking, and side-question/non-booking turns that must not become booking intent.

Acceptance:

- Booking-intent telemetry fires for actual active booking paths and does not depend on inactive `slot-collection` transitions.
- Offer-side questions and generic yes/okay turns that are not booking-ready remain excluded.
- Funnel denominator can be trusted for conversion experiments.

### Slice 5B: Intent-cohort booking KPI and alert alignment

Goal: Separate global business completion from booking-flow conversion among callers who expressed booking intent.

Status: Implemented and locally validation-complete.

Implemented files:

- `observability/azure-monitor-workbook.json`
- `observability/azure-alert-rules.json`
- `ci/scripts/check-observability-metrics.js`
- `infra/main.bicep`
- `docs/telemetry-metric-pipeline-audit.md`

Files:

- `observability/azure-monitor-workbook.json`
- `observability/azure-alert-rules.json`
- `ci/scripts/check-observability-metrics.js`
- `Utils/telemetryEvents.js`
- Tests or validation scripts under `tests/` and `ci/scripts/`

Steps:

1. Keep the current global booking completion KPI based on all calls.
2. Add an intent-cohort KPI with denominator defined as calls with any of: `booking_intent_detected`, `appointment_offered` plus accepted/link-request state, `booking_link_requested`, `booking_link_sent`, or `booking_link_delivery_sent`.
3. Add funnel panels for intent -> link requested -> delivery sent -> provider completed/cancelled.
4. Add alert rules for severe drop-off after intent and for orphan webhook rate, separate from global completion rate.
5. Add observability validation that parses workbook/alert JSON and checks required booking KPI query fragments.

Acceptance:

- Operators can distinguish global call-to-booking performance from booking-flow conversion after intent.
- KPI denominator definitions are documented in the workbook titles/descriptions or infra README.
- CI catches accidental removal of booking intent, link request, delivery, completion, and orphan stages from observability assets.

### Slice 6: Passive latency observability independent of Phase 3 features

Goal: Preserve latency signal even when experimental responsiveness features are disabled.

Files:

- `config/latencyResponsivenessConfig.js`
- `config/latencyResponsivenessRuntime.js`
- `session/createCallSession.js`
- `Utils/telemetryEvents.js`
- Tests under `tests/`

Steps:

1. Add `PHASE3_LATENCY_OBSERVABILITY_ENABLED`, defaulting to true.
2. Keep `PHASE3_ENABLED` as the switch for active features: prewarm, pacing changes, micro-ack, and compensation.
3. Allow `logLatencyOverruns()` to run when observability is enabled, even if active Phase 3 features are off.
4. Emit structured `latency_overrun` telemetry instead of console-only warnings.
5. Add tests for all combinations of observability enabled/disabled and Phase 3 enabled/disabled.

Acceptance:

- Passive latency overrun data remains available without enabling experimental features.

### Slice 7: Configuration cleanup and guardrails

Status: Implemented on 2026-05-06.

Goal: Remove misleading production config and add deployment warnings.

Files:

- `app.js`
- `.env.example`
- `ecosystem.config.js`
- Tests under `tests/`

Steps:

1. Replace hardcoded duplicate CORS entries with `CORS_ALLOWED_ORIGINS` parsing.
2. Strip paths from origins or reject path-containing origins at startup with a clear warning.
3. Document that clustered PM2 requires durable call context store or sticky routing.
4. Consider changing PM2 default to one instance until Slice 2 is complete, or add explicit `VOICEBOT_CLUSTER_UNSAFE_ACK=true` guard if cluster is retained.

Acceptance:

- CORS config is unambiguous.
- Operators cannot accidentally treat a path as a CORS origin.
- Cluster risk is visible during deployment.

Implemented files:

- `config/httpSecurityConfig.js`
- `config/deploymentGuards.js`
- `app.js`
- `ecosystem.config.js`
- `.env.example`
- `tests/httpSecurityConfig.test.js`
- `tests/deploymentGuards.test.js`

## Recommended Order

1. Slice 1: Provider status parity and safe lifecycle marking.
2. Slice 3: Central idempotent finalizer.
3. Slice 2: Durable call context hydration.
4. Slice 3A: Booking webhook attribution integrity.
5. Slice 3B: Signed booking correlation token.
6. Slice 5A: Booking intent and phase-model alignment.
7. Slice 5: Conversion funnel reporting.
8. Slice 5B: Intent-cohort booking KPI and alert alignment.
9. Slice 6: Passive latency observability.
10. Slice 4: Stream duplicate suppression parity.
11. Slice 7: Configuration cleanup.

Reasoning: Slice 1 prevents active data loss risk; Slice 3 makes finalization reliable; Slice 2 fixes clustered production correctness; Slices 3A and 3B protect outside-call booking attribution before metrics are optimized; Slice 5A makes the booking-intent denominator trustworthy; Slice 5 and Slice 5B make optimization measurable; the remaining slices improve quality and operational confidence.

## Validation Plan

Run after each slice:

```bash
npm run validate:telemetry
npm run validate:phase3-surface
npm test -- --runInBand
git -c core.whitespace=blank-at-eol,blank-at-eof,space-before-tab,cr-at-eol diff --check
```

Add focused tests per slice before running the full suite.

Booking-specific validation set:

```bash
npm test -- --runInBand tests/bookingWebhookAuth.test.js tests/bookingLinkProvider.test.js tests/bookingPersistence.test.js tests/conversationPhase.test.js tests/response-quality-routing.test.js tests/callFinalizer.test.js tests/createCallSession.contextHydration.test.js
node -e "for (const f of ['observability/azure-monitor-workbook.json','observability/azure-alert-rules.json']) { JSON.parse(require('fs').readFileSync(f, 'utf8')); console.log(f + ' ok'); }"
```

Attribution-negative tests required before production rollout:

- Calendly completion with missing call id is orphaned and not counted.
- Microsoft Bookings completion with static clientState but no signed per-call token is orphaned or marked legacy according to rollout mode.
- Tampered `call_id`/`utm_content` plus valid provider signature is rejected for attribution.
- Valid signed booking reference updates `booking_events`, durable call context, and `call_outcomes` for the original call.
- Booking intent fires in the active phase model without requiring `slot-collection`.
- Intent-cohort workbook/alert queries retain `booking_intent_detected`, `booking_link_requested`, `booking_link_delivery_sent`, `booking_link_sent`, `booking_completed_webhook`, and orphan-webhook stages.

Finalization validation gates:

1. Run focused booking, phase, finalizer, and context hydration tests.
2. Run telemetry and observability JSON validation.
3. Run full `npm test -- --runInBand` after all slices that touch runtime behavior.
4. Run whitespace/static diff validation.
5. Review workbook/alert KQL manually for both global and intent-cohort denominators.
6. Confirm migration/runbook notes cover new secrets and any orphan reconciliation table or status fields.

Latest local validation results for booking-flow hardening:

- `npm test -- --runInBand tests/bookingLinkProvider.test.js tests/bookingPersistence.test.js tests/bookingWebhookAuth.test.js tests/response-quality-routing.test.js` passed: 4 suites, 84 tests.
- `npm test -- --runInBand tests/conversationPhase.test.js tests/callFinalizer.test.js tests/createCallSession.contextHydration.test.js tests/businessMetrics.test.js tests/telemetry-adapter.test.js` passed: 5 suites, 81 tests.
- `node -e "for (const f of ['observability/azure-monitor-workbook.json','observability/azure-alert-rules.json']) { JSON.parse(require('fs').readFileSync(f, 'utf8')); console.log(f + ' ok'); }"` passed.
- `npm run validate:telemetry` passed, including observability metric validation.
- `git -c core.whitespace=blank-at-eol,blank-at-eof,space-before-tab,cr-at-eol diff --check` passed.
- `npm test -- --runInBand` passed: 63 suites, 1618 tests.
- Local `az` and `bicep` CLIs were not installed, so deployment compile/what-if remains a rollout validation step.

## Done Criteria

The call flow can be called production-optimized only when all of these are true:

- Provider status callbacks never delete active call state before finalization.
- Twilio and Plivo both record lifecycle status.
- WebSocket finalization and provider fallback finalization are centralized and idempotent.
- Call context can hydrate across workers when local memory is empty.
- Completed/cancelled booking webhooks without a valid call id are not counted as completed bookings and are visible as orphan events.
- Booking links include tamper-resistant correlation once `BOOKING_CORRELATION_SECRET` is configured, with explicit legacy unsigned handling.
- Booking-intent detection matches the active phase model and does not depend on inactive `slot-collection` transitions.
- Booking funnel drop-offs are reportable by provider/persona/channel/date.
- Global booking completion and intent-cohort booking completion are both reported and separately alertable.
- Passive latency overrun telemetry is available independently of Phase 3 feature flags.
- Twilio and Plivo outbound audio duplicate suppression is consistent.
