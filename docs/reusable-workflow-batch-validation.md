# Reusable Workflow Batch Validation

Date: 2026-05-09

Branch: `feat/reusable-workflow-architecture`

## Batch One Result

Batch one is successfully implemented and validated as a focused foundation slice.

Implemented surfaces:

- Reusable persona/action-bot runbook: `docs/persona-bot-creation-runbook.md`.
- Dealer-order setup, guardrail, telemetry, and production-readiness doc: `docs/dealer-order-persona.md`.
- Env split validation support in `ci/scripts/check-env-contract.js`.
- Env split rollout doc: `docs/env-contract-split.md`.
- Dealer-order parser, persona, ERP/notification service, email helper, realtime/session hooks, missed-call fallback, telemetry events, env vars, tests.
- Durable dealer-order snapshot support through `migrations/011_call_context_dealer_order_state.sql`, `repositories/CallContextRepository.js`, and `services/CallContextStore.js`.
- Dealer-order outcomes and ROI through `migrations/012_dealer_order_outcomes.sql`, `services/callFinalizer.js`, `repositories/OutcomeRepository.js`, and `Utils/businessMetrics.js`.

Validation evidence:

```bash
npm test -- --runTestsByPath tests/dealerOrderParser.test.js tests/dealerOrdersPersona.test.js tests/dealerOrderService.test.js tests/businessMetrics.test.js tests/callFinalizer.test.js tests/callContextRepository.test.js tests/callContextStore.test.js tests/createCallSession.contextHydration.test.js tests/actionGuard.test.js tests/workflowActionOutboxRepository.test.js tests/workflowActionOutboxService.test.js tests/dealerOrderAdapterGuard.test.js tests/createCallSession.dealerOrderOutbox.test.js
npm run validate:env
npm run validate:telemetry
node -c <modified runtime files>
git -c core.whitespace=blank-at-eol,blank-at-eof,space-before-tab,cr-at-eol diff --check
```

Latest focused result after final batch-two hardening:

- 13 focused Jest suites passed.
- 55 focused tests passed.
- Env contract validation passed with 290 runtime vars and 290 env contract entries from `.env.example`.
- Telemetry validation passed, including observability metric validation for 16 queries.
- Syntax checks passed for modified runtime files.
- CRLF-aware whitespace check passed.
- VS Code diagnostics reported no errors.

Latest revalidation after third/fourth batch grounding:

- Focused outbox/session recheck passed: 3 suites and 12 tests.
- Combined reusable-workflow focused suite passed: 13 suites and 55 tests.
- Env contract validation still passes with 290 runtime vars and 290 env contract entries from `.env.example`.
- Telemetry validation still passes, including 16 observability metric queries.
- Syntax, CRLF-aware whitespace, and VS Code diagnostics remain clean.

Known non-blocking signal:

- The realtime/session Jest run still prints the repository's existing `--forceExit` open-handle warning. The targeted tests pass, but the warning should remain visible as a future test-harness cleanup item.

Hardening performed during validation:

- `docs/dealer-order-persona.md` was updated so dealer outcomes/ROI and service-path tests are described as implemented, not future work.
- Remaining production gaps in that doc now focus on migration 013 rollout, failed/dead-letter outbox monitoring, and broader integration replay tests.
- The action outbox repository now reclaims stale `processing` rows after lock timeout, so worker crashes can replay durable actions instead of leaving them stuck forever.
- The background outbox worker now emits `action_outbox_claimed`, matching the session-triggered claim path.

## Batch Two Grounding

Recommended batch-two work was grounded in actual code paths. The implemented scope is durable action outbox plus pre-side-effect action guards, introduced before adapter slimming.

### Grounding: Durable Outbox

Batch-two cutoff facts:

- `services/writeQueue.js` is an in-process array with retry counters. It is not durable across process crash, restart, or worker replacement.
- `app.js` starts that write queue and routes persistence jobs such as `persist_call`, `persist_outcome`, `persist_booking_event`, `persist_booking_delivery_event`, and `persist_booking_webhook_orphan`.
- `session/createCallSession.js` calls `sendBookingLink()` directly inside the `booking_link_requested` listener. Booking delivery attempts are persisted after each external send attempt by enqueuing `persist_booking_delivery_event`.
- `session/createCallSession.js` calls `submitDealerOrder()` directly inside the `dealer_order_confirmed` listener. ERP and notification side effects happen before any durable action intent is recorded.
- `repositories/BookingRepository.js`, `migrations/006_booking_events.sql`, and `migrations/008_booking_delivery_events.sql` already provide a proven local pattern for dedupe keys, payload hashes, status records, and idempotent upserts.
- `migrations/013_workflow_action_outbox.sql`, `repositories/WorkflowActionOutboxRepository.js`, and `services/workflowActionOutboxService.js` provided the durable outbox slice for workflow actions. Generic `call_workflow_states` and `call_workflow_events` tables were intentionally deferred to batch three and are now implemented by migration `014`.

Conclusion:

- A durable outbox is the correct second-batch primitive. It now enqueues confirmed dealer-order side-effect intent before ERP/SMS/email execution and supports replay, retries, idempotency keys, and dead-letter/failure status.
- The first outbox consumer wraps dealer-order ERP/notification effects because those are irreversible production side effects and had the biggest reliability gap.
- Booking-link delivery can be migrated later or shadow-written first because it already has booking delivery event persistence, but it still lacks durable pre-send intent capture.

### Grounding: Action Guard

Batch-two cutoff facts:

- `transactions/transactionPolicy.js` already has strict rules for interaction mode, STT confidence, explicit confirmation, numeric repetition, backend authoritative response, interruption, and no bypass.
- `session/conversationEngine.js` invokes `evaluateTransactionPolicy()` only when `profile.transaction?.confirmationRequired && this.adapter._isTransactionTurn` is true.
- The current transaction gate passes only interaction mode and STT confidence into the policy, leaving explicit confirmation, numeric repetition, backend-authoritative status, and interruption as default false values.
- `BaseRealtimeAdapter` now evaluates the shared action guard before accepting dealer confirmation, then emits `dealer_order_confirmed` only after explicit confirmation, numeric recap, STT confidence, interaction mode, and interruption checks pass.
- `_isTransactionTurn` remains effectively inert for dealer-order confirmation, so Phase 4 transaction policy is not currently the protection boundary for dealer ERP submission.

Conclusion:

- Batch two added a pre-side-effect action guard at the adapter/session boundary rather than making the LLM prompt responsible for transaction safety.
- The guard accepts an action envelope with `actionType`, `workflowId`, `idempotencyKey`, `explicitConfirmationReceived`, `numericRepetitionReceived`, `sttConfidence`, `interactionMode`, and `interrupted`.
- For dealer orders, backend-authoritative success should be split into two phases: guard allows enqueueing a confirmed order request, then ERP response updates final backend status.

### Grounding: Workflow State And Events

Current facts:

- Batch one made `dealerOrder` durable in `call_context_snapshots`, which fixes the immediate unsupported patch-key gap.
- `docs/persona-bot-creation-runbook.md` correctly states that generic plugin state should not be stored in `contextHint`.
- The codebase did not yet have generic `call_workflow_states` or `call_workflow_events` tables at the batch-two cutoff; batch three has since added them as shadow orchestration storage.
- `CallRegistry` remains process-local cache; `CallContextStore` hydrates core snapshot fields plus `dealerOrder` only.

Conclusion:

- Generic workflow tables are still valid, but the smallest safe batch-two runtime change is the action outbox and action guard. Generic workflow states/events can follow once the outbox contract is proven with dealer order.

## Batch Two Acceptance Criteria

Batch two implementation should be considered complete only when all of these are true:

1. A migration creates a durable action outbox with `callSID`, `workflowId`, `actionType`, `idempotencyKey`, `payloadJson`, `status`, `attemptCount`, `availableAt`, `lockedAt`, `lastError`, and timestamps.
2. A repository/service can enqueue, claim, complete, fail, retry, and suppress duplicate outbox actions by idempotency key.
3. Dealer-order confirmation records a durable outbox job before ERP/SMS/email side effects execute.
4. Dealer-order side effects can be replayed safely after process restart without duplicate ERP submission for the same idempotency key.
5. A pre-side-effect action guard blocks low-confidence, non-interactive, interrupted, missing-confirmation, or missing-numeric-repeat dealer-order actions.
6. Existing `dealer_order_confirmed`, `dealer_order_erp_logged`, `dealer_order_erp_failed`, `dealer_order_notification_sent`, and `dealer_order_notification_failed` telemetry remains compatible.
7. Focused tests cover enqueue, duplicate suppression, worker success, worker failure/retry, crash/replay shape, and guard allow/block cases.
8. Existing focused first-batch tests, `npm run validate:env`, `npm run validate:telemetry`, syntax checks, and CRLF-aware `git diff --check` still pass.

## Batch Three Grounding, Implementation, And Plan

Batch three makes the workflow architecture reusable across two workflows while keeping the broad adapter rewrite out of scope.

### Latest Code Facts

- `workflow_action_outbox` is generic at the table/repository layer: it stores `workflowId`, `actionType`, `idempotencyKey`, and `payloadJson`.
- `services/workflowActionOutboxService.js` now executes both `dealer_order_submit` and `booking_link_deliver` actions.
- `session/createCallSession.js` now routes booking links through `enqueueAndProcessBookingLinkDelivery()` before external SMS/WhatsApp/email sends, then preserves existing delivery telemetry and `persist_booking_delivery_event` writes.
- `repositories/BookingRepository.js` and migrations `006`, `008`, and `010` already provide durable booking event/delivery/orphan tables and dedupe-key patterns that should be preserved.
- `migrations/014_call_workflow_state_events.sql`, `repositories/WorkflowStateRepository.js`, and `services/workflowStateService.js` add generic workflow state/event shadow storage with fail-soft missing-table behavior.
- `CallContextStore` and `CallContextRepository` still hydrate the snapshot plus the dealer-order JSON mirror; generic workflow state is orchestration history until replay hydration is proven.
- `BaseRealtimeAdapter` still contains hardcoded branches for booking action detection and dealer-order turn handling. Those branches remain compatibility seams while session/services own durable side effects.

### Logical Sequence

Batch three should be split into four cohesive slices:

1. Add generic workflow state and event storage. Implemented as migration `014_call_workflow_state_events.sql`, `WorkflowStateRepository`, and `workflowStateService`.

2. Project dealer-order state into the generic workflow tables. Implemented as fail-soft session shadow writes.
   - Keep `call_context_snapshots.dealerOrder` as a backward-compatible hydration mirror for now.
   - Write workflow events for items captured, guard blocked, confirmed, skipped, outbox enqueued, outbox completed, and outbox failed.
   - Let `callFinalizer` continue reading the mirror until generic state is fully proven and replay tests cover reconnect/callback hydration.

3. Add booking-link delivery as the second outbox user. Implemented with `booking_link_deliver` actions.
   - Booking delivery is modeled at channel/destination granularity, not as one all-channel retry unit.
   - Idempotency keys are shaped around `callSID`, `linkHash`, `channel`, and `destinationHash`.
   - Pre-send booking delivery intent is stored in `workflow_action_outbox`, while existing `booking_delivery_events` persistence and telemetry remain compatible.
   - `BookingRepository` and booking webhook tables remain the booking reporting source of truth.

4. Extract a small workflow action boundary, not a full adapter rewrite.
   - The adapter can continue emitting existing events while session code calls a shared `enqueueWorkflowAction()` path.
   - Only after dealer-order and booking delivery both use the same workflow state/outbox contract should hardcoded adapter branches be reduced.

### Batch Three Hardening From Latest Code

Grounded hardening findings:

- `services/workflowActionOutboxService.js` dispatches `dealer_order_submit` and `booking_link_deliver` inside `executeAction()`. A general handler registry still belongs in batch four now that two action types prove the contract.
- `session/createCallSession.js` owns both `booking_link_requested` and `dealer_order_confirmed` listeners. Batch three should avoid moving workflow persistence into `BaseRealtimeAdapter`; the adapter should keep emitting events and session/services should own durable side effects.
- `services/bookingDeliveryProvider.js` returns per-channel attempts with `destinationHash`, `messageProvider`, `externalMessageId`, `status`, and `failureReason`. Batch three should reuse that attempt shape so existing telemetry and `booking_delivery_events` remain compatible.
- `repositories/BookingRepository.js` already dedupes delivery events after send. Batch three must add durable pre-send intent without treating the generic workflow tables as replacements for booking reporting tables.
- Generic workflow state should shadow-write first. Reads for call finalization and analytics should continue using existing snapshot/domain fields until the new tables pass replay validation.

### Non-Goals For Batch Three

- Do not physically shrink `.env.example`; the validator supports split files, but the aggregate contract is still the safe deployment surface.
- Do not rewrite `BaseRealtimeAdapter` wholesale.
- Do not replace booking webhook/delivery tables with generic workflow tables; use generic workflow events as orchestration history and preserve domain-specific reporting tables.
- Do not make the LLM prompt responsible for side-effect safety; keep deterministic parsers and action guards in code.

### Batch Three Implementation Result

Implemented surfaces:

- `migrations/014_call_workflow_state_events.sql` creates `call_workflow_states` and `call_workflow_events`.
- `repositories/WorkflowStateRepository.js` and `services/workflowStateService.js` provide state upsert, event append, latest-state reads, event listing, idempotent event keys, and fail-soft missing-table behavior.
- `services/workflowActionOutboxService.js` now supports `dealer_order_submit` and `booking_link_deliver`, including booking idempotency per channel/destination.
- `services/bookingDeliveryProvider.js` now exposes `sendBookingLinkChannel()` while preserving `sendBookingLink()` aggregate behavior.
- `session/createCallSession.js` routes booking delivery through the outbox and shadow-writes dealer-order workflow state/events without replacing the existing dealer-order snapshot mirror.
- `BaseRealtimeAdapter` emits `dealer_order_items_captured` for durable dealer-order item capture shadow state while preserving existing telemetry and scripted responses.

Focused validation evidence:

```bash
npm test -- --runTestsByPath tests/workflowStateRepository.test.js tests/workflowStateService.test.js tests/bookingDeliveryProvider.test.js tests/workflowActionOutboxService.test.js tests/createCallSession.dealerOrderOutbox.test.js
npm test -- --runTestsByPath tests/dealerOrderParser.test.js tests/dealerOrdersPersona.test.js tests/dealerOrderService.test.js tests/businessMetrics.test.js tests/callFinalizer.test.js tests/callContextRepository.test.js tests/callContextStore.test.js tests/createCallSession.contextHydration.test.js tests/actionGuard.test.js tests/workflowActionOutboxRepository.test.js tests/workflowActionOutboxService.test.js tests/dealerOrderAdapterGuard.test.js tests/createCallSession.dealerOrderOutbox.test.js tests/workflowStateRepository.test.js tests/workflowStateService.test.js tests/bookingDeliveryProvider.test.js
npm run validate:env
npm run validate:telemetry
git -c core.whitespace=blank-at-eol,blank-at-eof,space-before-tab,cr-at-eol diff --check
```

Latest focused result:

- 5 focused Jest suites passed.
- 25 focused tests passed.
- Syntax checks passed for the new/edited batch-three runtime and focused test files.
- Broader reusable-workflow focused suite passed: 16 suites and 72 tests.
- Env contract validation passed with 290 runtime vars across 117 runtime files and 290 env contract entries from `.env.example`.
- Telemetry validation passed, including observability metric validation for 16 queries.
- CRLF-aware whitespace check passed.
- VS Code diagnostics reported no errors.

Latest hardening pass after implementation:

- Code graph was refreshed before file-level inspection, then the batch-three runtime surfaces were checked directly: `workflowActionOutboxService`, `workflowStateService`, `WorkflowStateRepository`, `createCallSession`, and `bookingDeliveryProvider`.
- Booking delivery is confirmed to route through `enqueueAndProcessBookingLinkDelivery()` from `createCallSession`; direct `sendBookingLink()` remains only as the provider aggregate API and focused tests.
- Failed booking-link outbox actions now persist structured failure result payloads in `workflow_action_outbox.resultJson` as well as `lastError`, so retry/dead-letter inspection can preserve the failed channel attempt shape.
- Generic workflow tables remain a shadow orchestration record. Existing booking delivery events, booking webhooks, call summaries, and dealer-order snapshot mirrors still own their current reporting/hydration responsibilities.
- The remaining batch-three risk is operational, not architectural: migration `014` must be applied before relying on workflow history, and replay/readiness surfaces are intentionally held for batch four.

Post-hardening validation evidence:

- Syntax checks passed for `repositories/WorkflowActionOutboxRepository.js` and `tests/workflowActionOutboxRepository.test.js`.
- Focused outbox suites passed: 2 suites and 14 tests.
- Broader reusable-workflow suite passed: 16 suites and 72 tests.
- `npm run validate:env` passed with 290 runtime vars across 117 runtime files and 290 env contract entries from `.env.example`.
- `npm run validate:telemetry` passed, including observability metric validation for 16 queries.
- CRLF-aware `git diff --check` passed.
- VS Code diagnostics reported no errors.

### Batch Three Acceptance Criteria

1. `call_workflow_states` and `call_workflow_events` migrations exist and are listed in `docs/manual-migration-runbook.md`.
2. A workflow repository/service has focused tests for state upsert, event append, idempotent event suppression, and latest-state hydration.
3. Dealer-order confirmation writes generic workflow state/events while preserving existing call context snapshot behavior and existing tests.
4. Booking-link delivery can be enqueued through `workflow_action_outbox` before external SMS/WhatsApp/email sends, while existing booking delivery telemetry and `booking_delivery_events` rows remain compatible.
5. The action outbox supports at least `dealer_order_submit` and `booking_link_deliver` with separate execution handlers and tests.
6. Booking delivery outbox actions are idempotent per channel/destination and do not resend channels that already completed successfully.
7. `createCallSession` has less duplicated side-effect orchestration, but event names emitted by adapters remain backward-compatible.
8. Focused tests prove replay/duplicate behavior for both dealer-order and booking-link actions.
9. Missing workflow state/event tables fail soft or remain gated until migration 014 is applied.
10. Existing first- and second-batch tests, env validation, telemetry validation, syntax checks, and CRLF-aware whitespace checks still pass.

## Batch Four Grounding And Plan

Batch four should only start after batch three proves generic workflow state/events and at least two outbox action types. The latest codebase makes the next logical boundary clear: generic orchestration and adapter slimming, not another one-off workflow.

### Latest Code Facts

- `BaseRealtimeAdapter.js` is a large shared file and now contains both booking-link detection/emission and dealer-order turn handling.
- `createCallSession.js` is also large and contains direct orchestration for booking delivery, dealer-order outbox submission, call hydration, audio flow, and provider lifecycle.
- `workflowActionOutboxService.js` owns polling, claim telemetry, retry, and execution, but execution is still an inline action-type conditional.
- `WorkflowActionOutboxRepository.markActionFailed()` now persists structured failure result payloads for operator/retry inspection, but there is still no user-facing replay/readiness command or status surface.
- Existing adapter event names such as `booking_link_requested` and `dealer_order_confirmed` are covered by tests and telemetry contracts, so they are compatibility contracts.
- Booking analytics rely on `booking_events`, `booking_delivery_events`, provider webhooks, and call summaries; generic workflow state should not become the source of completed-booking truth.

### Logical Sequence

1. Extract a workflow action handler registry.
   - Move action-type execution out of the outbox worker into registered handlers.
   - Keep the outbox worker responsible for enqueue, claim, retry, completion, failure, and telemetry.
   - Register `dealer_order_submit` and `booking_link_deliver` handlers from their domain service modules.

2. Add a workflow orchestration service for session listeners.
   - `createCallSession` should delegate dealer-order and booking-link event handling to a service that can append workflow events, enqueue actions, update snapshots, and return session patch data.
   - Existing adapter-emitted event names should remain unchanged during this slice.

3. Add operator replay and readiness surfaces.
   - Provide a script or service method to inspect queued, retry, dead-letter, and stale-processing outbox rows by workflow/action type.
   - Add readiness checks that can distinguish migration missing, worker disabled, and dead-letter backlog states.
   - Extend observability validation only after concrete telemetry events and queries exist.

4. Slim adapter branches behind workflow contracts.
   - Move dealer-order parsing/turn handling into a workflow module only after the session orchestration service can preserve current behavior.
   - Keep deterministic extraction and action guards in code, not prompts.
   - Preserve legacy event emissions during a compatibility window.

### Batch Four Non-Goals

- Do not remove booking provider webhook handling or booking domain repositories.
- Do not change outcome semantics: provider webhooks still own `booking_completed` and `booking_cancelled`.
- Do not introduce a plugin marketplace or dynamic untrusted workflow loading.
- Do not rewrite the entire realtime adapter or session orchestrator in one batch.

### Batch Four Acceptance Criteria

1. `workflowActionOutboxService` executes actions through a registered handler map and has tests for unknown, dealer-order, and booking-link action types.
2. A workflow orchestration service owns the session-side action flow for dealer order and booking delivery, with focused tests that prove `createCallSession` behavior remains compatible.
3. Existing telemetry event names remain allowlisted and validation passes; any new workflow-level telemetry is added with schema and observability coverage.
4. Replay/readiness tooling can report queued, retry, dead-letter, stale-processing, and completed action counts by workflow/action type.
5. Adapter extraction is limited to one workflow branch at a time and preserves existing user-facing scripted responses and emitted events.
6. Booking completion analytics continue to come from trusted provider webhooks and existing booking tables.
7. The full first-through-third-batch focused validation suite remains green before removing any compatibility path.

### Batch Four Pre-Implementation Validation Pass

The fourth-batch plan was grounded in the codebase state before batch-four implementation:

- Before implementation, no workflow action handler registry existed; `executeAction()` in `workflowActionOutboxService` still branched on `actionType`, so a registered handler map was the correct next boundary.
- Before implementation, no workflow orchestration service existed; `createCallSession` still owned the booking-link and dealer-order listener bodies directly, so extracting those listeners was cohesive and testable.
- Before implementation, no operator replay/readiness surface existed; the repository could claim, retry, dead-letter, and persist failure payloads, but there was no summary command or readiness check for queued/retry/dead-letter/stale-processing counts.
- Adapter event names remained the compatibility contract; `BaseRealtimeAdapter` emitted `booking_link_requested`, `dealer_order_items_captured`, `dealer_order_confirmed`, and `dealer_order_skipped`, so adapter slimming needed to preserve those events first.
- Booking completion truth should remain with provider webhooks and booking domain tables. Generic workflow events are orchestration history, not a replacement for booking analytics.

### Batch Four Final Hardening Pass

The batch-four plan is ready to implement with these hardening constraints:

- The handler registry should be static and trusted. It should register local handlers for `dealer_order_submit` and `booking_link_deliver`; it should not introduce dynamic untrusted workflow loading.
- `processAction()` result shapes, action outbox telemetry, workflow action events, retry/dead-letter behavior, and structured `resultJson` persistence must stay compatible while execution moves behind the handler map.
- The workflow orchestration service should own only workflow listener behavior: booking-link delivery, dealer-order state patches, guard checks, workflow events, and action enqueueing. `createCallSession` should continue owning WebSocket lifecycle, audio flow, provider lifecycle, and generic realtime cleanup.
- The existing public `/health` route is safe as a broad status endpoint. Detailed workflow readiness should be exposed through an authenticated route or operator script so queued/retry/dead-letter counts and schema details are not leaked publicly.
- Readiness should distinguish at least: migration `013` missing, migration `014` missing, worker disabled, retry backlog, dead-letter backlog, and stale `processing` locks.
- Adapter slimming must be locked behind behavior tests for emitted event names, payload shape, and scripted responses. The adapter can become thinner only after the orchestration service proves compatibility.
- Generic workflow state must remain orchestration history in batch four. Do not promote it to finalizer or booking analytics source of truth during the extraction slice.

### Batch Four Implementation Result

Batch four implemented the grounded extraction without changing provider lifecycle or booking analytics ownership:

- Added `services/workflowActionHandlers.js` as a static trusted handler registry for `dealer_order_submit` and `booking_link_deliver`. `workflowActionOutboxService.executeAction()` now delegates execution through the registry while retaining enqueue, claim, retry, dead-letter, result persistence, and telemetry responsibilities.
- Added `services/workflowOrchestrationService.js` and delegated booking-link and dealer-order session listeners from `session/createCallSession.js`. The session still owns WebSocket lifecycle, audio flow, provider lifecycle, hydration, and cleanup.
- Added `services/workflowOperationsService.js` plus repository count/sample helpers so operators can inspect workflow schema readiness, worker state, dead-letter/retry/stale-processing backlog, and recent action samples.
- Added authenticated workflow endpoints: `GET /api/workflow/readiness` and `GET /api/workflow/actions`. Public `/health` remains high-level.
- Slimmed `BaseRealtimeAdapter._handleDealerOrderTurn()` by moving dealer-order parsing/confirmation/skip behavior into `services/dealerOrderConversationWorkflow.js` while preserving scripted responses and emitted event names.
- Added focused tests for the handler registry, readiness service, outbox repository inspection helpers, unsupported action handling, route authentication, adapter compatibility, and session dealer-order outbox compatibility.

Validation evidence after implementation:

- Syntax checks passed for all new and modified batch-four runtime/test files.
- Focused batch-four Jest suite passed: `tests/workflowActionHandlers.test.js`, `tests/workflowOperationsService.test.js`, `tests/workflowActionOutboxRepository.test.js`, `tests/workflowActionOutboxService.test.js`, `tests/createCallSession.dealerOrderOutbox.test.js`, `tests/dealerOrderAdapterGuard.test.js`, and `tests/routeAuth.test.js`.
- Broader reusable-workflow validation passed: 19 focused suites and 101 tests.
- `npm run validate:env` passed with 290 vars across 121 runtime files and 290 env contract entries from `.env.example`.
- `npm run validate:telemetry` passed, including observability metric validation for 16 queries.
- CRLF-aware `git diff --check` passed.
- VS Code diagnostics reported no errors.
- Code-review graph incremental refresh completed successfully.
- The known Jest `--forceExit` open-handle warning still appears after realtime/session tests; it remains a test-harness cleanup item, not a failing batch-four assertion.

### Batch Four Detailed Hardening Pass

Grounded review findings after implementation:

- The action registry is static and local. There is no dynamic workflow loading path; unsupported action types flow through the existing retry/dead-letter failure path.
- `workflowActionOutboxService` still owns enqueue, claim, retry, completion, dead-letter, workflow action events, and telemetry. The only execution responsibility moved behind `workflowActionHandlers`.
- Duplicate completed dealer-order actions now return the stored `resultJson`, so idempotent duplicate suppression can preserve ERP and notification result details for session state updates.
- `workflowOperationsService.inspectTableColumns()` now rejects unsupported table names before issuing SQL. Runtime readiness uses only the fixed workflow table set.
- `GET /api/workflow/actions` now defaults to operator triage statuses: `dead_letter`, `retry`, and `processing`. Callers can still override statuses explicitly.
- `createCallSession` delegates workflow listener bodies but still owns realtime lifecycle, audio flow, provider lifecycle, start/hydration handling, and cleanup.
- `BaseRealtimeAdapter._handleDealerOrderTurn()` remains as the compatibility wrapper, with scripted responses and emitted dealer-order events preserved by `dealerOrderConversationWorkflow`.

Post-hardening validation evidence:

- Syntax checks passed for `services/workflowOperationsService.js`, `services/workflowActionOutboxService.js`, `tests/workflowOperationsService.test.js`, and `tests/workflowActionOutboxService.test.js`.
- Focused hardening tests passed: 2 suites and 17 tests.
- Post-hardening broader reusable-workflow validation passed: 19 focused suites and 101 tests.
- `npm run validate:env` passed with 290 vars across 121 runtime files and 290 env contract entries from `.env.example`.
- `npm run validate:telemetry` passed, including observability metric validation for 16 queries.
- CRLF-aware `git diff --check` passed.
- VS Code diagnostics reported no errors.
- Code-review graph incremental refresh completed successfully after the hardening changes.

## Batch Five Grounding And Plan

Batch five should start only after batch four has a handler registry, workflow orchestration service, replay/readiness surfaces, and compatibility tests. The next logical boundary is production rollout hardening and workflow read-model promotion, not another adapter rewrite.

### Latest Code Facts

- `Controller/MainController.js` still exposes public `/health` through `Routes/Routes.js`; it remains a high-level status endpoint and does not leak workflow action details.
- Authenticated workflow operational surfaces now exist: `GET /api/workflow/readiness`, `GET /api/workflow/actions`, and `POST /api/workflow/actions/:id/requeue`, all behind `apiAuth`.
- `workflowOperationsService` checks the workflow outbox/state/event tables and columns, reports worker enabled/disabled state, summarizes outbox counts, and flags dead-letter and stale-processing backlog.
- Migrations are still applied manually through `docs/manual-migration-runbook.md`. There is no runtime migration runner or schema-version table.
- `WorkflowActionOutboxRepository` can enqueue, claim, complete, fail, retry, reclaim stale `processing`, persist `resultJson`, list status counts, return redacted action samples, and requeue eligible `retry`, `failed`, `dead_letter`, or stale `processing` actions for operator replay.
- `workflowStateService` writes fail-soft workflow state/events, but `CallContextStore`, `callFinalizer`, booking delivery events, and booking webhooks still own the current hydration and reporting paths.
- Workflow telemetry is allowlisted, and telemetry validation exists. Dedicated workflow backlog/age/dead-letter observability still needs concrete queries or metrics for the new readiness data.
- `BaseRealtimeAdapter` and `createCallSession` now preserve compatibility through wrappers/delegation while workflow action execution and session listener orchestration live in services.

### Logical Sequence

1. Productionize schema and workflow readiness gates.
   - Keep using the new readiness service to verify migrations `013` and `014` by checking required tables and columns.
   - Keep public `/health` high-level, and put detailed workflow readiness behind API auth or an operator CLI.
   - Decide production severity for `ACTION_OUTBOX_WORKER_ENABLED=false` by environment, so intentionally disabled development environments can be distinguished from production misconfiguration.

2. Add outbox inspection, reconciliation, and replay operations.
   - Build on the existing count/sample APIs for queued, retry, dead-letter, completed, and stale-processing counts by `workflowId` and `actionType`.
   - Include oldest available retry age, oldest stale lock age, redacted sample action IDs, and safe reason summaries for operator triage.
   - Add safe replay operations that requeue or claim through the existing idempotent outbox path; do not bypass `processAction()` or resend completed channels directly.

3. Promote generic workflow state as a read model only after parity tests.
   - Keep `call_context_snapshots.dealerOrder` and booking domain tables as fallbacks.
   - Add parity tests proving generic workflow state matches the dealer-order mirror for reconnect/finalizer scenarios before any read path changes.
   - Continue using booking provider webhooks and booking domain tables for completed/cancelled booking truth.

4. Add workflow observability and operator runbooks.
   - Add telemetry or query coverage for dead-letter count, retry backlog age, stale-processing locks, workflow-event write skips, and action worker poll failures.
   - Extend `npm run validate:telemetry` only after the concrete events/queries are implemented.
   - Update runbooks with replay, dead-letter triage, migration readiness, and rollback procedures.

5. Prove reusable onboarding with one additional action workflow.
   - Add the next workflow only through the handler registry and orchestration service.
   - It should define parser/classifier, action guard, workflow state/event contract, outbox handler, telemetry, docs, and focused tests.
   - It should not add new workflow-specific side-effect branches directly inside `createCallSession` or new inline `actionType` branches inside the outbox worker.

### Batch Five Non-Goals

- Do not introduce a plugin marketplace, remote code loading, or untrusted workflow execution.
- Do not remove dealer-order snapshot mirrors or booking domain tables until parity and rollback paths are proven in production-like replay tests.
- Do not make `/health` expose sensitive action IDs, payloads, destinations, or customer details.
- Do not replay dead-letter actions outside the durable outbox idempotency path.
- Do not make generic workflow state the source of completed-booking truth.

### Batch Five Acceptance Criteria

1. Workflow readiness remains authenticated and can distinguish schema missing, worker disabled, retry backlog, dead-letter backlog, stale-processing locks, and healthy state with environment-aware severity.
2. Outbox inspection and replay/requeue operations are covered by focused repository/service tests and do not bypass idempotency.
3. Generic workflow state read paths are introduced only with fallback and parity tests against existing dealer-order and booking reporting paths.
4. Workflow operational telemetry and observability queries are validated by the existing telemetry validation pipeline.
5. Runbooks document migration readiness, replay, dead-letter triage, rollback, and rollout gates.
6. A new action workflow can be added through the extracted workflow contracts without adding direct workflow side-effect orchestration to `createCallSession`.
7. The full first-through-fourth-batch focused validation suite remains green before any compatibility mirror or fallback is removed.

## Batch Five Final Hardening Pass - 9 May 2026

The grounded gap in the Batch Five plan was explicit replay/requeue. The repository already reclaimed stale `processing` rows during normal worker claims, but operators had no authenticated way to move a dead-letter or retry action back into the durable execution path.

Hardening implemented in this pass:

- Added `WorkflowActionOutboxRepository.requeueAction()` for `retry`, `failed`, `dead_letter`, and stale `processing` rows. Completed rows remain non-requeueable.
- Added `workflowActionOutboxService.requeueWorkflowAction()`, which emits `action_outbox_requeued` telemetry and appends a workflow event before the existing worker/process path performs any side effect.
- Added authenticated `POST /api/workflow/actions/:id/requeue` behind `apiAuth`; public `/health` remains high-level and does not expose action IDs or workflow internals.
- Hardened readiness issue classification so retry backlog is explicit, dead-letter and stale-processing locks remain blocking, and disabled-worker severity is production-aware.
- Added focused repository, service, operations, and route-auth test coverage for requeue behavior and operator auth.
- Added `docs/workflow-operations-runbook.md` for migration readiness, action inspection, requeue, dead-letter triage, rollback, and rollout gates.
- Aligned CI telemetry validation to run the package-level `npm run validate:telemetry` pipeline so observability metric checks are not skipped in GitHub Actions.

Residual Batch Five risk after this hardening pass is intentionally bounded: generic workflow state remains a shadow/write-history read model, and booking completion truth remains provider webhooks plus booking domain tables.

### Batch Five Detailed Accuracy Pass - 9 May 2026

Grounded verification after the final hardening pass:

- Rechecked the replay path end to end: `Routes/Routes.js` keeps `POST /api/workflow/actions/:id/requeue` behind `apiAuth`, `Controller/MainController.js` validates action IDs as positive integer strings, `workflowOperationsService` normalizes operator input, `workflowActionOutboxService` emits telemetry/workflow events, and `WorkflowActionOutboxRepository` only requeues eligible durable outbox rows.
- Hardened readiness to expose explicit `outbox.issues` for `retry_backlog`, `dead_letter_backlog`, `stale_processing_locks`, and `worker_disabled`. Disabled worker severity is now environment-aware: warning outside production-like environments and blocking in production or staging.
- Confirmed public `/health` remains high-level and does not expose action IDs, workflow payloads, destinations, or outbox internals.
- Confirmed completed actions remain non-requeueable and replay continues through the existing outbox worker/process path rather than bypassing idempotency.

Validation evidence from this pass:

- Focused Batch Five suite passed: 4 suites and 46 tests.
- Broader reusable-workflow suite passed: 19 suites and 108 tests.
- Syntax checks passed for Batch Five runtime surfaces.
- The known Jest `--forceExit` open-handle warning still appears after realtime/session tests and remains a test-harness cleanup item, not a failing Batch Five assertion.

### Batch Five Implementation Completion Pass - 9 May 2026

Final implementation scope stayed inside the Batch Five operator-readiness boundary. The remaining grounded gap was that readiness and action inspection had counts and timestamps, but not explicit backlog ages or PII-safe reason summaries for triage.

Implemented in this pass:

- Extended workflow outbox status counts with oldest retry availability, oldest dead-letter update, and oldest stale lock timestamps.
- Added `oldestAgeSeconds` fields to retry, dead-letter, and stale-processing readiness issues, plus per-workflow age fields in readiness summaries.
- Redacted workflow action samples at the operations-service boundary. Samples now return action IDs, workflow/action metadata, timestamps, `callIdHash`, and a PII-redacted `reasonSummary` instead of raw call IDs or payload data.
- Sanitized requeue/replay responses at the same operations-service boundary, so successful or conflict responses return redacted action metadata instead of raw `callSID`, `payloadJson`, or `resultJson` fields from the lower outbox service.
- Updated the workflow operations runbook to document age-based readiness triage and redacted action sample shape.

The pass deliberately did not add workflow dashboards, promote generic workflow reads, or onboard another action workflow; those remain Batch Six work in the grounded plan.

### Batch Five Latest Grounding And Hardening Pass - 9 May 2026

Grounded code review after the implementation completion pass confirmed the Batch Five operator path is cohesive, with one additional response-shaping hardening gap fixed in this pass:

- `Routes/Routes.js` keeps workflow readiness, action inspection, and requeue behind `apiAuth`; public `/health` remains high-level.
- `Controller/MainController.js` validates requeue IDs as positive integer strings before calling the operations service, avoiding JavaScript `Number` truncation for MySQL `BIGINT` values.
- `workflowOperationsService` owns operator-facing response shaping. It now redacts both action samples and requeue results before they leave the operations boundary.
- `workflowActionOutboxService.requeueWorkflowAction()` still returns the internal action row for service-to-service callers, but HTTP-facing operations responses no longer expose raw `callSID`, `payloadJson`, or `resultJson`.
- `WorkflowActionOutboxRepository.requeueAction()` still only requeues `retry`, `failed`, `dead_letter`, or stale `processing` rows; completed rows remain non-requeueable.
- `workflowStateService` remains fail-soft and write-oriented, so generic workflow state is still shadow/orchestration history rather than a promoted read source.

Additional hardening implemented:

- Sanitized successful and conflict requeue responses through `workflowOperationsService.requeueWorkflowAction()` using the same redacted action metadata shape as action inspection.
- Extended `tests/workflowOperationsService.test.js` to prove requeue responses include `callIdHash` and PII-redacted `reasonSummary`, while omitting `callSID`, `payloadJson`, and `resultJson`.
- Updated `docs/workflow-operations-runbook.md` to document the sanitized requeue response contract.

Focused validation evidence from this pass:

- Syntax check passed for `services/workflowOperationsService.js`.
- Focused Phase Five suite passed: 4 suites and 46 tests.
- The known Jest `--forceExit` warning still appears and remains a test-harness cleanup item, not a failing Phase Five assertion.

## Batch Six Grounding And Plan

Batch six should build on the hardened operator path rather than introducing new adapter-side side effects. The next logical boundary is observability-backed promotion of the generic workflow model and proof that another action workflow can be onboarded through the extracted contracts.

### Current Grounded State

- Workflow readiness and requeue are authenticated and use the durable outbox path.
- `action_outbox_enqueued`, `action_outbox_claimed`, `action_outbox_completed`, `action_outbox_failed`, `action_outbox_duplicate`, `action_outbox_requeued`, and `action_outbox_poll_failed` are allowlisted telemetry events.
- The Azure workbook and alert templates now include the first workflow-specific observability slice: action-outbox operation counts, workflow readiness backlog counts/ages, dead-letter alerts, stale-lock alerts, and poll-failure alerts. These surfaces use aggregate telemetry rather than raw payloads or destinations.
- Generic workflow state/events shadow dealer-order and booking-link orchestration, but no production read path should depend on those tables until parity tests cover reconnect, callback, finalizer, and analytics behavior.
- The first reusable workflow remains dealer orders, with booking-link delivery using the same outbox and handler registry. A second independent action workflow has not yet been added as proof of onboarding repeatability.

### Batch Six Detailed Grounding Pass - 9 May 2026

Codebase evidence for the Batch Six sequence:

- `ci/scripts/check-observability-metrics.js` validates lifecycle, booking, transfer, orphan webhook, token, business metrics, and now workflow-specific action/readiness observability. It enforces action-outbox event coverage, readiness backlog fields, and required workflow alert rules.
- `workflowStateService` currently exposes write-oriented helpers (`upsertWorkflowState`, `appendWorkflowEvent`, and `recordWorkflowStep`). Runtime reads still use `CallContextStore`, `callFinalizer`, booking delivery events, and provider webhook/domain tables, so read-model promotion must begin with parity tests and fallbacks.
- Booking completion and cancellation remain grounded in `MainController.bookingWebhook`, `BookingRepository`, `OutcomeRepository`, and booking telemetry such as `booking_completed_webhook`; generic workflow events are not the source of completed-booking truth.
- `workflowActionHandlers` has the static trusted handlers for `dealer_order_submit` and `booking_link_deliver`. Booking-link delivery proves the outbox/handler pattern on another existing workflow surface, but it is not a second independent action-bot onboarding slice. Batch Six should still prove one more action workflow through the registry and orchestration contracts.
- There is no dynamic plugin loading path in the current handler registry, so the Batch Six non-goal against remote or untrusted action execution remains aligned with the implementation.

### Batch Six Sequence

1. Add workflow observability panels and alerts.
   - Cover action failure/dead-letter counts, retry backlog age, stale lock age, poll failures, and requeue outcomes.
   - Validate the new queries through `npm run validate:telemetry` and keep payload/destination details out of KQL projections.

2. Add generic workflow read-model parity tests.
   - Compare `call_workflow_states` against `call_context_snapshots.dealerOrder` for reconnect and finalizer scenarios.
   - Keep booking completion and cancellation truth on booking provider webhooks and booking domain tables.

3. Promote read paths only behind fallbacks.
   - Introduce generic workflow reads as fallback-aware helpers, not direct controller rewrites.
   - Preserve dealer-order mirrors until production-like replay validates parity and rollback.

4. Prove one more action workflow through the registry.
   - Add parser/classifier, guard, state/event contract, outbox handler, telemetry, docs, and focused tests.
   - Do not add workflow-specific side-effect branches inside `createCallSession` or inline `actionType` branches in the worker.

5. Add operational reconciliation tooling.
   - Provide a safe operator summary for requeue counts, post-requeue completion rates, and remaining dead letters by workflow/action type.
   - Keep reconciliation read-only unless it calls the authenticated requeue path.

### Batch Six Non-Goals

- Do not remove booking provider webhook/domain-table truth.
- Do not make workflow state the only dealer-order hydration source until parity tests and rollback are proven.
- Do not introduce dynamic plugins, remote handler loading, or untrusted action execution.
- Do not expose workflow operation details through public `/health`.
- Do not bulk replay actions outside the durable outbox idempotency path.

### Batch Six Acceptance Criteria

1. Workflow backlog/dead-letter/stale-lock/requeue observability is represented in workbook or alert templates and validated by CI.
2. Generic workflow state parity tests pass for dealer-order reconnect, callback hydration, finalizer, and analytics scenarios.
3. Any promoted read path retains fallback to existing snapshot/domain tables.
4. A second action workflow is onboarded through handler registry and orchestration contracts without adapter-side side-effect branches.
5. Operator reconciliation reports can explain retry/dead-letter/requeue state without exposing payloads, destinations, or customer PII.
6. Existing dealer-order and booking-link outbox tests remain green.

### Batch Six Final Plan Pass - 9 May 2026

The Batch Six plan remains accurate and complete against the current codebase, with one sequencing clarification: workflow observability should land before any read-model promotion or new action-workflow rollout is considered production-grade. The first observability slice now projects workflow action activity and aggregate readiness backlog signals, but parity tests, read promotion, independent workflow onboarding, and reconciliation reporting are still open.

Final alignment notes:

- Keep observability first. The workbook/alert coverage for `action_outbox_failed`, `action_outbox_requeued`, `action_outbox_poll_failed`, dead-letter backlog, retry backlog age, and stale-processing locks is now represented through aggregate telemetry and enforced by `ci/scripts/check-observability-metrics.js`; future Batch Six work should extend rather than bypass these surfaces.
- Keep workflow state promotion fallback-aware. `WorkflowStateRepository.getState()` and `listEvents()` exist, but runtime reads still use call context snapshots, call finalizer fields, booking delivery events, and booking provider webhooks. Batch Six should add parity tests before using generic workflow state in production read paths.
- Keep booking completion truth on provider webhooks and booking domain tables. Generic workflow events can support orchestration history and diagnostics, not completed/cancelled booking attribution.
- Keep the next action workflow independent from booking-link delivery. Booking-link delivery proves the generic outbox/handler mechanism on an existing booking surface; Batch Six still needs one more action-bot onboarding slice through parser/classifier, guard, state/event, handler, telemetry, docs, and tests.
- Keep replay bounded to the durable outbox path. Operator reconciliation can summarize and call authenticated requeue, but it must not directly resend provider messages or completed actions.

### Batch Six Updated Grounding Pass - 9 May 2026

This grounding pass was rerun after the latest Batch Five requeue-response hardening. The Batch Six sequence remains valid and should stay observability-first.

Updated codebase facts:

- Operator readiness, action samples, and requeue responses are now authenticated and redacted at the operations-service boundary.
- Workflow action telemetry is allowlisted in `Utils/telemetryEvents.js`, and `workflow_readiness_checked` now records aggregate retry, dead-letter, stale-lock, worker, and age fields from the authenticated readiness path.
- `observability/azure-monitor-workbook.json`, `observability/azure-alert-rules.json`, and `ci/scripts/check-observability-metrics.js` now include initial workflow backlog, dead-letter, stale-lock, poll-failure, and requeue visibility.
- `WorkflowStateRepository.getState()` and `listEvents()` exist, while `workflowStateService` exposes only write-oriented helpers. Runtime reads still use call context snapshots, call finalizer fields, booking delivery events, provider webhooks, and booking domain tables.
- `workflowActionHandlers` remains a static trusted local registry for `dealer_order_submit` and `booking_link_deliver`; there is still no dynamic plugin or remote handler loading path.

Updated Phase Six alignment:

- The workflow observability slice is now present. Next add workflow read-model parity tests. Do not promote generic workflow reads until dealer-order mirror parity and booking-domain fallback behavior are proven.
- Keep the next independent action workflow behind the static handler registry and orchestration contracts; booking-link delivery remains proof of the shared outbox path, not proof of a second independent action bot.
- Operator reconciliation in Batch Six should reuse the redacted operations shapes from Batch Five and call the authenticated requeue path for any mutation.

### Batch Six Final Hardening Pass - 9 May 2026

This pass found that Batch Six was not fully implemented, so the hardening result is intentionally scoped: the observability-first Batch Six gate has been implemented and validated, while the remaining Batch Six acceptance criteria stay open.

Implemented hardening:

- `services/workflowOperationsService.js` now emits `workflow_readiness_checked` from readiness evaluation with only aggregate status, worker flags, retry/dead-letter/stale-lock counts, oldest-age fields, issue count, and issue codes.
- `Utils/telemetryEvents.js` allowlists `workflow_readiness_checked` beside the existing `action_outbox_*` workflow events.
- `observability/azure-monitor-workbook.json` now includes `Workflow Action Operations` and `Workflow Readiness Backlog` panels for action failures, requeues, poll failures, retry backlog age, dead-letter counts, stale locks, and disabled production worker signal.
- `observability/azure-alert-rules.json` now includes workflow dead-letter, stale-processing-lock, and outbox poll-failure alerts.
- `ci/scripts/check-observability-metrics.js` now fails if workflow action events, readiness backlog fields, or workflow alert rules are removed from the observability assets.
- `tests/workflowOperationsService.test.js` covers readiness telemetry for degraded and missing-schema readiness states without exposing call IDs, payloads, results, destinations, or customer details.

Still open before Batch Six can be called complete:

- Generic workflow state parity tests for dealer-order reconnect, callback hydration, finalizer, and analytics paths.
- Fallback-aware workflow read helpers and any promoted read path.
- One more independent action workflow through parser/classifier, guard, workflow state/events, outbox handler, telemetry, docs, and tests.
- Operator reconciliation reporting beyond readiness, redacted samples, and single-action requeue.

### Batch Six Completion Pass - 9 May 2026

The remaining Batch Six acceptance criteria have now been implemented with conservative fallback behavior and without adding dynamic workflow loading.

Implemented completion work:

- `workflowStateService` now exposes fail-soft read helpers for workflow state and events plus `getDealerOrderReadModel()`, which prefers useful generic workflow state but falls back to the legacy dealer-order snapshot when the workflow table is missing, unavailable, or empty.
- `CallContextStore.hydrateCallRegistry()` uses the fallback-aware dealer-order read model, so reconnect/callback hydration can read generic workflow state while preserving the existing snapshot rollback path.
- Dealer-order parity coverage now checks workflow-state preference, missing-table fallback, empty-row fallback, and summary-field mismatches used by finalizer and analytics fields such as status, order ID, item count, ERP status, and notification status.
- Added `handover_followup_send` as an independent workflow action through the static trusted handler registry and durable outbox. Production handover follow-up email and booking-delivery-failure follow-up now route through `workflowOrchestrationService.handleHandoverFollowup()` and `workflow_action_outbox`; existing handover tests keep their injected sender path for compatibility.
- Added authenticated `GET /api/workflow/reconciliation` behind `apiAuth`. Reconciliation reports workflow/action status totals, completion rate, retry/dead-letter/stale-lock issues, and redacted samples without raw call IDs, payloads, destinations, results, or customer details.
- Updated focused tests for the handler registry, outbox service, workflow state service, call context hydration, operations reconciliation, route authentication, handover compatibility, and dealer-order/booking outbox compatibility.

Validation evidence from the completion pass:

- Syntax checks passed for changed Batch Six runtime files.
- Focused Batch Six/compatibility Jest suite passed: 8 suites and 73 tests.
- The known Jest `--forceExit` open-handle warning still appears after session tests and remains a test-harness cleanup item, not a failing Batch Six assertion.

Batch Six is now complete against its acceptance criteria. The reusable workflow platform still intentionally retains dealer-order snapshot fallback and booking provider/domain-table truth; those compatibility paths are Batch Seven dark-read and graduation work, not Batch Six removal work.

## Batch Seven Alignment And Grounding

Batch seven can start now that Batch Six has workflow observability, parity-tested fallback reads, an additional independent action workflow, and reconciliation reporting. The next logical boundary is production graduation of the reusable workflow platform and controlled compatibility cleanup, not new side-effect branches.

### Current Grounded State For Batch Seven

- The reusable workflow platform is still intentionally conservative: static trusted handler registry, authenticated operations endpoints, manual migrations, and shadow workflow state/events.
- Batch Six observability covers action-outbox activity and aggregate readiness backlog signals, and the completion pass added fallback-aware dealer-order read parity, handover follow-up workflow onboarding, and reconciliation reporting.
- Batch Six introduced a limited fallback-aware dealer-order hydration read from generic workflow state. Batch Seven dark-read work is still needed before widening generic workflow reads, removing snapshot mirrors, or treating workflow state as the only production read source.
- There is no runtime migration runner or schema-version table. Readiness checks table/column presence for migrations `013` and `014`, but operators still apply SQL manually through `docs/manual-migration-runbook.md`.
- Workflow operations currently expose readiness, redacted action samples, single-action requeue, and workflow-level reconciliation. There is no bulk replay endpoint or audit export yet.
- `workflowActionHandlers` is a static map for trusted local handlers. This matches the security boundary; Batch Seven should improve metadata and test contracts without introducing remote code loading.
- `BaseRealtimeAdapter` and `createCallSession` still preserve compatibility through wrappers and service delegation. Adapter cleanup should happen only after Batch Six proves multiple workflows through shared contracts.
- The older `docs/production-readiness-plan.md` Phase 7 is a separate code-quality/debt track and should not be mixed with this reusable-workflow Batch Seven plan.

### Batch Seven Current-To-Target Grounding

| Area | Current codebase state | Batch Seven target |
|------|------------------------|--------------------|
| Handler registry | `workflowActionHandlers` is a static trusted local map for dealer order, booking delivery, and handover follow-up. | Add static workflow contract metadata around those handlers without dynamic or remote loading. |
| Read model | `workflowStateService.getDealerOrderReadModel()` can prefer workflow state with snapshot fallback, and `CallContextStore` uses that narrow hydration path. | Add dark-read mismatch reporting before widening workflow reads or retiring mirrors. |
| Migration readiness | `workflowOperationsService` checks required workflow tables/columns for migrations `013` and `014`; operators still apply SQL manually. | Map required migrations to manifest entries or add a non-destructive migration-status check so readiness names exact missing migration gates. |
| Operator operations | Authenticated readiness, redacted samples, read-only reconciliation, and single-action requeue exist. | Add dry-run audited reconciliation first, then bounded/capped requeue that still calls the existing outbox path and records audit evidence. |
| Observability | Workflow action/readiness workbook panels, alerts, telemetry allowlist, and metric validation are present. | Add aggregate dark-read mismatch and reconciliation-audit observability only after those features exist. |
| Booking truth | Booking completion and cancellation remain provider-webhook/domain-table concerns. | Keep booking provider/domain tables as permanent completion truth; workflow events stay orchestration history. |
| Documentation and CI | Persona/action-bot and workflow-operations runbooks exist, plus env/telemetry validators. | Add onboarding-kit and CI checks that require manifest, handler tests, telemetry coverage, and runbook links for new workflow actions. |

### Batch Seven Sequence

1. Graduate generic workflow reads with dark-read evidence.
   - Add production-like dark reads that compare generic workflow state against existing snapshot/domain sources without changing user-facing behavior.
   - Emit or record mismatch summaries without payloads, destinations, or PII.
   - Promote reads only where mismatch rates are acceptable and rollback falls back to existing mirrors.
   - Current parity helpers can compute dealer-order mismatches, but they do not yet emit or persist aggregate dark-read evidence.

2. Define workflow contract metadata and versioning.
   - Add a static local workflow manifest describing workflow ID, version, action types, required migrations, telemetry events, handler name, and rollback owner.
   - Use the manifest for readiness/reporting/tests; do not use it to dynamically load untrusted code.
   - Require every new workflow to declare idempotency keys, action guard requirements, state/event schema shape, and operator runbook entries.

3. Add migration and release-gate automation.
   - Introduce a non-destructive schema-version or migration-status check, or a validated deployment checklist, so workflow readiness can report exact missing migration numbers instead of only missing tables/columns.
   - Keep manual SQL runbooks as the fallback until a migration runner is adopted and proven.

4. Add audited reconciliation operations.
   - Build on Batch Six reconciliation summaries with bounded operator actions: dry-run first, explicit filters, per-action audit entries, and optional one-at-a-time or capped requeue that still calls the existing outbox path.
   - Preserve completed actions and provider-domain truth. Never replay by reconstructing provider calls outside `processAction()`.
   - Keep current single-action requeue as the safe mutation primitive until dry-run and audit records are implemented.

5. Retire compatibility mirrors only with rollback.
   - Consider deprecating dealer-order snapshot reads only after dark-read parity, production replay tests, and rollback gates prove the generic workflow read model.
   - Keep booking provider webhooks and booking domain tables as permanent booking completion truth.

6. Create a repeatable workflow onboarding kit.
   - Turn the second independent action workflow from Batch Six into a documented template for state/event contract, handler, telemetry, tests, runbook, and rollout gates.
   - Parser/classifier and action-guard requirements should be explicit manifest fields. User-driven workflows must declare and test them; system-triggered workflows such as `handover-followup` may mark them not applicable with a reason instead of adding fake parser or guard code.
   - Add CI checks that fail if a new workflow action type is registered without tests, telemetry allowlist entries, and operational documentation.

### Batch Seven Non-Goals

- Do not introduce a plugin marketplace, remote handler loading, or untrusted workflow execution.
- Do not remove booking webhooks, booking delivery events, or booking outcome tables.
- Do not expose workflow operation details through public `/health`.
- Do not bulk replay completed or dead-letter actions outside the durable outbox idempotency path.
- Do not remove dealer-order mirrors before dark-read parity and rollback are proven.

### Batch Seven Acceptance Criteria

1. Batch Six observability, parity tests, additional action workflow, and reconciliation reports are complete and green.
2. Workflow read promotion uses dark-read comparison and retains fallback to existing snapshot/domain sources.
3. A static workflow manifest or equivalent contract inventory exists for workflow IDs, versions, action types, migrations, telemetry, handlers, and runbooks.
4. Readiness or release gates can identify missing workflow migrations more specifically than generic table absence.
5. Audited reconciliation supports dry-run and bounded requeue through the existing outbox path without exposing payloads or destinations.
6. Mutating reconciliation/requeue records per-action audit evidence, is explicitly filtered and capped, and never mutates completed actions.
7. Any compatibility mirror retirement has documented rollback and production-like replay evidence.
8. CI or focused tests prevent registering a new workflow action without manifest metadata, handler tests, telemetry validation, and operator documentation.

### Batch Seven Grounding And Validation Pass - 9 May 2026

The Batch Seven plan was re-grounded after the final Batch Six hardening and remains the right next boundary: production graduation, dark-read evidence, workflow contract inventory, release gates, audited reconciliation, and controlled compatibility cleanup.

Validation facts from the current codebase:

- Batch Six prerequisites are green: workflow observability, fallback-aware dealer-order reads, handover follow-up as an additional independent action workflow, authenticated reconciliation, and redacted operator surfaces are all present.
- Fresh reusable-workflow validation passed: 20 focused Jest suites and 132 tests.
- `npm run validate:telemetry` passed, including workflow observability metric validation across 21 queries.
- `npm run validate:env` passed with 290 runtime variables across 121 runtime files and 290 env contract entries from `.env.example`.
- Syntax checks, CRLF-aware diff whitespace checks, and VS Code diagnostics were clean for the Batch Six runtime and documentation surfaces.

Plan hardening from this grounding pass:

- Treat the current dealer-order generic workflow read as a narrow fallback-aware hydration path, not as permission to remove `call_context_snapshots.dealerOrder` or promote generic workflow state everywhere.
- Keep booking completion and cancellation permanently grounded in provider webhooks and booking domain tables; workflow events remain orchestration history and diagnostics.
- Build the Batch Seven manifest as static metadata for trusted local handlers only. It should describe workflow IDs, versions, action types, required migrations, telemetry, handler names, runbook links, idempotency keys, and guard/parser applicability; it must not load remote or untrusted code.
- Make migration readiness more specific by mapping manifest-required migrations to the tables and columns already checked by readiness, or by adding a non-destructive migration-status check. Manual SQL runbooks remain the fallback until a migration runner is proven.
- Make audited reconciliation dry-run first, explicitly filtered, capped, and routed through the existing authenticated requeue/outbox path for any mutation. It must not replay completed actions or reconstruct provider sends outside `processAction()`.

### Batch Seven Detailed Logical Pass - 9 May 2026

This pass checked Batch Seven against the current runtime ownership model rather than older audit documents. The plan is coherent with the overall architecture because it preserves the existing boundaries: `app.js` starts process services, `session/createCallSession.js` owns WebSocket/provider lifecycle, `workflowOrchestrationService` owns session workflow listeners, `workflowActionOutboxService` owns durable execution/retry/requeue, `workflowActionHandlers` owns trusted side-effect handlers, `workflowOperationsService` owns authenticated redacted operator surfaces, and booking domain tables/webhooks remain the booking completion source of truth.

Logical validation:

1. Dark-read evidence must come before read promotion. Batch Six added a narrow dealer-order workflow-state hydration read with fallback, but no aggregate mismatch telemetry or production-like dark-read report exists yet. Therefore Batch Seven should first observe mismatches without changing behavior, then promote only low-risk reads behind fallback.
2. The static manifest should come before migration-specific readiness and new-workflow CI enforcement. The manifest is the contract inventory that can tell readiness which migrations, handlers, telemetry events, and runbook entries belong to each workflow.
3. Migration readiness should improve without assuming a migration runner. The code currently checks tables and columns; Batch Seven can map those checks to migration IDs or add a read-only migration-status check while keeping the manual SQL runbook as fallback.
4. Audited reconciliation should separate read-only planning from mutation. Current reconciliation is safe and redacted, and current requeue is single-action and idempotent. Batch Seven should add dry-run and audit evidence before any capped multi-action requeue.
5. Compatibility cleanup is last. Dealer-order snapshot mirrors, adapter wrappers, and booking domain tables are rollback and analytics safety rails. The only reasonable removal candidate in Batch Seven is dealer-order mirror read fallback, and even that requires dark-read parity, replay evidence, and rollback documentation. Booking provider webhooks and booking domain tables should not be retired.
6. Workflow onboarding should be contract-driven, not code-loading driven. The manifest can describe parser/classifier and action-guard applicability, but handlers remain local trusted functions. System-triggered workflows such as `handover-followup` should declare parser/guard as not applicable instead of adding unnecessary branches.

Validated Batch Seven implementation order:

1. Add static workflow manifest/contract inventory and tests that compare it to the handler registry, telemetry allowlist, runbook entries, and required migrations.
2. Add dark-read mismatch reporting for dealer-order workflow state versus snapshot fallback, with aggregate telemetry and redacted diagnostics.
3. Extend readiness/release gates to report exact workflow migration requirements using manifest metadata plus existing table/column checks.
4. Add dry-run audited reconciliation with explicit filters and redacted output.
5. Add bounded mutating reconciliation only through existing `requeueWorkflowAction()` / `processAction()` paths, with per-action audit events.
6. Use the manifest and onboarding kit to guard future workflows, then consider limited compatibility cleanup only after production-like replay evidence.

### Batch Seven Implementation Pass - 9 May 2026

Batch Seven production-graduation primitives are now implemented without changing side-effect execution ownership or retiring compatibility mirrors.

- Added `services/workflowManifest.js` as the static workflow contract inventory for `dealer-orders`, `booking-link-delivery`, and `handover-followup`. It records workflow IDs, versions, handlers, idempotency-key shapes, required migrations, telemetry events, parser/classifier/action-guard applicability, runbooks, owners, and rollback owners.
- Added `npm run validate:workflows` through `ci/scripts/check-workflow-manifest.js`, and wired it into CI. The validator compares manifest actions to the trusted local handler registry, telemetry allowlist, migration files, and runbook coverage.
- Extended authenticated readiness so `GET /api/workflow/readiness` returns manifest metadata plus migration-specific readiness for `013_workflow_action_outbox` and `014_call_workflow_state_events`, mapped onto the existing table/column checks.
- Added dealer-order dark-read telemetry from `workflowStateService.getDealerOrderReadModel()`. It emits aggregate `workflow_dark_read_compared` and mismatch-only `workflow_dark_read_mismatch` events with call hashes and mismatch field names only, preserving fallback behavior.
- Added audited reconciliation requeue at `POST /api/workflow/reconciliation/requeue`. Dry-run is the default, mutation requires `dryRun:false` plus `confirm:"requeue"`, requests are capped, responses are redacted, and each mutation calls the existing outbox `requeueWorkflowAction()` path with an audit ID.
- Added the onboarding kit in `docs/workflow-onboarding-kit.md` and updated the operations runbook with manifest-backed readiness, dry-run reconciliation, bounded mutation, and `validate:workflows` rollout gates.

Validation from this implementation pass:

- Focused workflow tests passed: `tests/workflowManifest.test.js`, `tests/workflowOperationsService.test.js`, `tests/workflowStateService.test.js`, `tests/workflowActionOutboxService.test.js`, and `tests/routeAuth.test.js`.
- Compatibility cleanup remains intentionally deferred. Dealer-order snapshot fallback and booking provider/domain truth are still retained pending production-like dark-read parity and rollback evidence.

### Batch Seven Final Hardening Pass - 9 May 2026

This pass was grounded in the actual Batch Seven implementation rather than the plan text. The reviewed runtime surfaces were `services/workflowManifest.js`, `ci/scripts/check-workflow-manifest.js`, `services/workflowOperationsService.js`, `services/workflowStateService.js`, `services/workflowActionOutboxService.js`, `Controller/MainController.js`, `Routes/Routes.js`, `services/CallContextStore.js`, `services/callFinalizer.js`, `services/workflowOrchestrationService.js`, and the booking webhook controller path.

Grounded findings:

- The manifest is static metadata and the handler registry remains a trusted local `Map`; there is still no dynamic or remote workflow loading path.
- `GET /api/workflow/readiness`, `GET /api/workflow/actions`, `GET /api/workflow/reconciliation`, `POST /api/workflow/reconciliation/requeue`, and `POST /api/workflow/actions/:id/requeue` remain behind `apiAuth`; public `/health` remains high-level.
- Dealer-order hydration uses `workflowStateService.getDealerOrderReadModel()` with fallback to the legacy snapshot mirror. `CallContextStore` can consume the workflow read model, but `workflowOrchestrationService.patchDealerOrderState()` still writes the snapshot mirror for rollback.
- `callFinalizer` still reads dealer-order summary fields from realtime or registry state, so the generic workflow state path is not the only finalizer source.
- Booking completion and cancellation remain grounded in `bookingWebhook`, `CallContextStore.patchContext()`, `writeQueue` booking-event jobs, and outcome updates. Generic workflow events are still orchestration history, not booking truth.
- Audited reconciliation already separates dry-run from mutation and calls the existing outbox requeue primitive, but the final hardening pass found two precision gaps around filter validation and stale `processing` planning.

Hardening implemented in this pass:

- `ci/scripts/check-workflow-manifest.js` now verifies that each manifest `handlerName` is exported by `services/workflowActionHandlers.js` and is the exact function registered for that action type, not just a non-empty label.
- `tests/workflowManifest.test.js` now asserts the same handler-name-to-registry contract.
- `services/workflowOperationsService.js` now rejects invalid reconciliation requeue status filters, such as `completed`, instead of silently falling back to the default requeue statuses.
- `Controller/MainController.js` maps invalid reconciliation status filters to HTTP 400.
- Reconciliation requeue dry-runs and mutations now filter `processing` samples to stale locks only, using `lockedAt`, `lockTimeoutSeconds`, and the request time. Fresh in-flight `processing` actions are not presented as planned requeues.
- `docs/workflow-operations-runbook.md` documents the allowed reconciliation requeue statuses and stale-processing behavior.

Focused validation from this hardening pass:

- Syntax checks passed for `services/workflowOperationsService.js`, `Controller/MainController.js`, and `ci/scripts/check-workflow-manifest.js`.
- Focused hardening tests passed: `tests/workflowManifest.test.js` and `tests/workflowOperationsService.test.js`, 2 suites and 18 tests.

Residual Batch Seven risk remains intentionally bounded: compatibility mirrors are still retained, booking provider/domain tables remain authoritative for booking completion, and reconciliation mutation still routes through the existing repository/outbox guard that rejects completed and non-stale processing actions.

## Batch Eight Validation Pass - 9 May 2026

Batch Eight is coherent as a production-graduation and compatibility-cleanup validation batch, but it should not start by deleting mirrors or moving booking truth. The codebase now has the Batch Seven contract inventory, manifest validation, migration-specific readiness, dark-read telemetry, and audited reconciliation primitives needed to validate a controlled next step.

### Current Grounded State For Batch Eight

- `workflowManifest` defines the trusted local workflow/action contract for `dealer_order_submit`, `booking_link_deliver`, and `handover_followup_send`, and `validate:workflows` now checks handler, telemetry, migration, and runbook alignment.
- `workflowStateService.getDealerOrderReadModel()` emits `workflow_dark_read_compared` and `workflow_dark_read_mismatch` without exposing raw values, but there is not yet a time-windowed parity report or release threshold for retiring fallback reads.
- `CallContextStore.hydrateCallRegistry()` can read dealer-order state from generic workflow state, but it still falls back to `call_context_snapshots.dealerOrder`.
- `workflowOrchestrationService.patchDealerOrderState()` still writes dealer-order snapshot mirrors. This is the current rollback rail and should remain until production-like replay evidence exists.
- `callFinalizer` reads dealer-order state from realtime or registry state and does not query workflow tables directly.
- Booking completion and cancellation remain owned by `bookingWebhook`, booking domain persistence jobs, and outcome updates. Workflow events must not become the booking completion source of truth.
- `BaseRealtimeAdapter` still owns compatibility wrappers for dealer-order state initialization, scripted dealer-order turn dispatch, and booking-link event emission. `createCallSession` delegates session workflow listeners through `workflowOrchestrationService`.
- Migrations are still manual SQL files. Readiness can identify `013_workflow_action_outbox` and `014_call_workflow_state_events`, but there is still no migration runner or schema-version table.
- Audited reconciliation is dry-run first, explicitly filtered, capped, redacted, and mutates only through the existing outbox requeue path.

### Validated Batch Eight Sequence

1. Add aggregate dark-read reporting before any mirror cleanup.
   - Build a time-windowed report or workbook query for `workflow_dark_read_compared` and `workflow_dark_read_mismatch` by workflow/read model.
   - Gate any dealer-order read promotion on mismatch rate, sample count, and rollback owner approval.

2. Add a read-source policy for dealer-order state.
   - Make workflow-state-first hydration explicit and configurable, with fallback always available.
   - Keep `call_context_snapshots.dealerOrder` writes enabled until production-like replay and rollback drills prove removal is safe.

3. Add production-like replay and reconciliation drills.
   - Exercise dead-letter, retry, stale-processing, duplicate completed, and audited capped requeue paths through the existing outbox service.
   - Keep completed actions non-requeueable and never reconstruct provider sends outside `processAction()`.

4. Improve migration release evidence without assuming a runner.
   - Keep manual SQL runbooks as fallback.
   - Add deployment evidence or a non-destructive schema-version/readiness artifact only if it can be validated in CI or an operator command.

5. Slim compatibility wrappers only after behavior tests.
   - Adapter cleanup should target one wrapper at a time, preserving `booking_link_requested`, `dealer_order_items_captured`, `dealer_order_confirmed`, and `dealer_order_skipped` events.
   - `createCallSession` should continue owning provider/WebSocket lifecycle while workflow services own workflow-side effects.

6. Extend workflow onboarding enforcement.
   - The manifest validator now proves handler alignment; Batch Eight can add test/runbook coverage checks for new workflow action types if the convention is stable enough.

### Batch Eight Non-Goals

- Do not remove `call_context_snapshots.dealerOrder` writes or fallback reads at the start of the batch.
- Do not replace booking provider webhooks, booking delivery events, or booking outcome tables with generic workflow events.
- Do not expose action IDs, payloads, destinations, raw call IDs, or customer details through public `/health`.
- Do not introduce dynamic plugin loading, remote handler execution, or untrusted workflow code.
- Do not bulk replay completed actions or bypass the outbox processor.

### Batch Eight Acceptance Criteria

1. Dark-read mismatch rate is observable over a defined window and redacted by design.
2. Dealer-order workflow reads are controlled by an explicit read-source policy and retain snapshot fallback.
3. Production-like replay drills cover retry, dead-letter, stale-processing, duplicate completed, and audited reconciliation requeue behavior.
4. Migration readiness evidence remains exact for required workflow migrations and is documented for operators.
5. Any adapter cleanup preserves existing event names, scripted responses, and session workflow delegation behavior.
6. Booking completion and cancellation continue to be sourced from provider webhooks and booking domain tables.
7. CI/focused tests fail when a new workflow action bypasses manifest metadata, handler alignment, telemetry allowlisting, or operator documentation.

Batch Eight is validated as the correct next plan only if it starts with observability and replay evidence. It is not ready to remove compatibility mirrors as its first implementation slice.

### Batch Eight Second Grounding Pass - 9 May 2026

This pass rechecked Batch Eight against the current code and observability assets after the Batch Seven final hardening. The plan remains coherent, but it needs a sharper first slice: make evidence measurable before adding policy or cleanup work.

Additional grounded code facts:

- `workflowStateService.emitDealerOrderDarkReadTelemetry()` emits `workflow_dark_read_compared` for every dealer-order read-model decision and `workflow_dark_read_mismatch` only when parity fails. Payloads include `workflowId`, `readModel`, source/fallback flags, mismatch count, mismatch field names, and `callIdHash`, but not raw workflow/fallback values.
- `observability/azure-monitor-workbook.json` currently has workflow action and readiness panels only. It does not yet include a dark-read parity panel or reconciliation-audit panel.
- `ci/scripts/check-observability-metrics.js` currently enforces workflow action events, readiness backlog fields, and workflow dead-letter/stale-lock/poll-failure alerts. It does not yet fail when dark-read or reconciliation-audit observability is missing.
- `Utils/telemetryEvents.js` already allowlists `workflow_dark_read_compared`, `workflow_dark_read_mismatch`, `workflow_reconciliation_audit`, and `workflow_reconciliation_requeue_completed`, so Batch Eight can add observability assets without introducing new event names first.
- `CallContextStore.hydrateCallRegistry()` currently uses `getDealerOrderReadModel()` directly. That helper implicitly prefers workflow state when content exists, then falls back to the snapshot. There is no explicit read-source policy, env gate, or operator-visible read-source mode yet.
- `callFinalizer` still consumes dealer order from realtime state or registry state. It does not directly query generic workflow tables, so any finalizer promotion proof must go through hydration/registry behavior or add a deliberate service boundary.
- `bookingWebhook` remains the booking completion/cancellation authority by patching call context, enqueueing booking-event persistence, and updating outcomes. This confirms Batch Eight must not treat workflow events as booking completion truth.
- Reconciliation mutation is now hardened to reject invalid statuses and include only stale `processing` rows. Batch Eight replay drills should assert this behavior with production-like data rather than inventing another mutation path.

Refined Batch Eight sequence:

1. Add dark-read and reconciliation-audit observability first.
   - Add workbook panels for dark-read comparison count, mismatch count/rate, mismatch fields, read source, and fallback usage by workflow/read model.
   - Add workbook or operator-summary coverage for `workflow_reconciliation_audit` and `workflow_reconciliation_requeue_completed` so dry-run and capped mutation are visible by audit ID, workflow, action type, and result counts.
   - Extend `ci/scripts/check-observability-metrics.js` so `npm run validate:telemetry` fails if those panels or required fields disappear.

2. Define the dealer-order read-source policy before changing behavior.
   - Name the current behavior explicitly, such as workflow-state-first with snapshot fallback.
   - Add a controlled policy surface only if needed for rollback, such as `snapshot_first`, `workflow_first`, or `workflow_disabled` modes.
   - Keep fallback reads and snapshot writes enabled until dark-read observability has enough production-like samples.

3. Prove hydration and finalizer parity through behavior tests.
   - Cover `CallContextStore.hydrateCallRegistry()` when workflow state and snapshot agree, mismatch, workflow state is empty, and workflow tables are missing.
   - Cover final summary/outcome behavior after hydration so dealer-order confirmed/skipped, item count, ERP status, and notification status remain stable.

4. Run production-like replay drills through existing primitives.
   - Use existing outbox service/repository behavior for retry, dead-letter, stale processing, duplicate completed, invalid status filters, and audited capped reconciliation requeue.
   - Do not add bulk replay that bypasses `requeueWorkflowAction()` or `processAction()`.

5. Only then consider narrow compatibility cleanup.
   - Candidate cleanup should be one wrapper or mirror at a time, with rollback documented before the change.
   - Dealer-order snapshot read fallback is the only plausible early cleanup candidate, and only after dark-read mismatch evidence is acceptable.
   - Booking provider webhooks, booking delivery events, and booking outcome tables remain permanent booking-domain truth.

Refined Batch Eight acceptance gates:

1. `npm run validate:telemetry` enforces dark-read and reconciliation-audit workbook coverage.
2. Dark-read panels show comparison volume, mismatch rate, mismatch fields, source, and fallback usage without raw call IDs or raw state values.
3. A documented read-source policy exists for dealer-order hydration, and fallback remains available.
4. Focused tests cover hydration and finalizer parity for workflow-state, snapshot fallback, mismatch, empty workflow row, and missing-table scenarios.
5. Replay drill tests prove retry, dead-letter, stale-processing, duplicate completed, invalid status filter, and audited capped requeue behavior through the existing outbox path.
6. Public `/health` remains high-level; all workflow readiness, reconciliation, replay, and action details remain authenticated and redacted.
7. Booking completion/cancellation remains sourced from `bookingWebhook` and booking domain persistence/outcome paths.

Decision: Batch Eight is ready as a validation-and-evidence batch, not as a cleanup batch. Its first implementation slice should be observability enforcement for dark-read and reconciliation-audit evidence.

### Batch Eight Implementation - 9 May 2026

Implemented the validated Batch Eight evidence slice. No compatibility mirrors or booking truth paths were removed.

Implemented changes:

- Added an explicit dealer-order read-source policy in `workflowStateService.getDealerOrderReadModel()` with `workflow_first`, `snapshot_first`, and `workflow_disabled` modes. The default preserves existing workflow-state-first behavior with snapshot fallback.
- Added `DEALER_ORDER_READ_SOURCE_POLICY=workflow_first` to the environment contract for controlled rollback and production policy changes.
- Extended dark-read telemetry with `readPolicy` and `workflowReadSkipped` so parity evidence can be grouped by active read mode without exposing raw workflow or snapshot values.
- Added Azure workbook panels for `Workflow Dark-Read Parity` and `Workflow Reconciliation Audit`.
- Extended `ci/scripts/check-observability-metrics.js` so `npm run validate:telemetry` now fails if dark-read or reconciliation-audit workbook coverage is removed.
- Extended reconciliation completion telemetry with `mode`, `dryRun`, and `statuses` so dry-run and mutating reconciliation can be audited consistently.
- Updated the workflow operations runbook with the dealer-order read-source policy, dark-read parity workflow, and reconciliation audit panel guidance.
- Added focused tests for snapshot-first rollback, workflow-disabled rollback, invalid policy normalization, missing-schema hydration fallback, empty workflow-row hydration fallback, finalizer use of hydrated registry dealer-order state, booking outcome precedence, and mutating stale-processing reconciliation replay through the existing outbox path.

Validation run:

- `node -c services/workflowStateService.js && node -c services/workflowOperationsService.js && node -c ci/scripts/check-observability-metrics.js` passed.
- `npx jest --forceExit tests/workflowStateService.test.js tests/callContextStore.test.js tests/callFinalizer.test.js tests/workflowOperationsService.test.js` passed: 4 suites, 44 tests.
- `npm run validate:workflows` passed.
- `npm run validate:telemetry` passed and now checks 23 workbook/alert queries.
- `npm run validate:env` passed with 291 runtime vars and 291 env contract entries.

Remaining Batch Eight guardrail: keep snapshot fallback and booking provider/domain truth in place until production-like dark-read samples show acceptable mismatch rates over the release window.

### Batch Eight Additional Hardening Pass - 9 May 2026

This pass reviewed the implemented Batch Eight paths in code after the evidence slice landed: `workflowStateService`, `workflowOperationsService`, the Azure workbook, the observability validator, focused tests, and the operator runbook.

Grounded findings fixed in this pass:

- `snapshot_first` could treat an empty snapshot object as a useful fallback and select it ahead of useful workflow state. `getDealerOrderReadModel()` now treats only meaningful dealer-order snapshots as fallback content, so empty snapshot rows do not mask workflow-state reads or inflate fallback-present telemetry.
- The dark-read workbook did not project `workflowReadSkipped`, even though the Batch Eight rollback policy emits it. The workbook now summarizes skipped workflow reads, and `npm run validate:telemetry` requires the field in the `Workflow Dark-Read Parity` panel.
- Invalid reconciliation requeue filters, such as `completed`, were correctly rejected but were not visible in reconciliation audit telemetry. `requeueWorkflowReconciliation()` now emits `workflow_reconciliation_audit` with `plannedActionCount: 0` and `invalidStatuses` before returning `invalid_status_filter`, and the workbook/validator now enforce `invalidStatuses` coverage.

Focused validation evidence:

- Syntax checks passed for `services/workflowStateService.js`, `services/workflowOperationsService.js`, and `ci/scripts/check-observability-metrics.js`.
- Focused Batch Eight hardening tests passed: `tests/workflowStateService.test.js` and `tests/workflowOperationsService.test.js`, 2 suites and 28 tests.
- The known Jest `--forceExit` open-handle warning still appears and remains a test-harness cleanup item, not a failing Batch Eight assertion.

Batch Eight remains an evidence and rollback-control slice. No dealer-order snapshot mirror writes, snapshot fallback reads, booking webhooks, booking delivery events, or booking outcome truth paths were removed.

## Batch Nine Validation Pass - 9 May 2026

Batch Nine should be a production-release evidence and graduation-gate batch, not a compatibility cleanup batch. Batch Eight made evidence measurable, but the codebase still lacks a single release decision surface that combines active read policy, dark-read sample quality, workflow readiness, reconciliation audit health, and migration status into an operator-approved go/no-go artifact.

### Current Grounded State For Batch Nine

- Dealer-order hydration now has an explicit `DEALER_ORDER_READ_SOURCE_POLICY` with `workflow_first`, `snapshot_first`, and `workflow_disabled`. The service emits dark-read telemetry for selected source, fallback usage, skipped workflow reads, and mismatch fields without raw values.
- The Azure workbook has `Workflow Dark-Read Parity` and `Workflow Reconciliation Audit` panels, and `ci/scripts/check-observability-metrics.js` enforces required fields for both panels.
- `CallContextStore.hydrateCallRegistry()` uses the fallback-aware dealer-order read model, but `workflowOrchestrationService.patchDealerOrderState()` still writes the legacy snapshot mirror for rollback.
- `callFinalizer` consumes dealer-order state from realtime or registry state; it does not query generic workflow tables directly.
- Booking completion and cancellation still come from `bookingWebhook`, booking domain persistence jobs, and outcome updates. Generic workflow events remain orchestration history only.
- Workflow operations remain authenticated and redacted: readiness, action samples, reconciliation, single-action requeue, and capped reconciliation requeue all stay behind `apiAuth`. Public `/health` remains high-level.
- Migrations remain manual SQL files. Readiness maps required migrations `013` and `014` to table/column checks, but there is no schema-version table or migration runner.
- The workflow manifest remains a static trusted local contract inventory. There is no dynamic plugin loading or remote handler execution path.

### Validated Batch Nine Sequence

1. Add a release-evidence summary surface.
   - Build an authenticated operator report or script that combines workflow readiness, active dealer-order read policy, dark-read sample count, mismatch rate, workflow-read-skipped count, fallback usage, reconciliation audit counts, failed requeue count, and migration status.
   - Keep the report redacted: hashes and aggregate counts only, no action payloads, destinations, raw call IDs, or dealer-order values.

2. Define explicit promotion thresholds.
   - Document minimum dark-read comparison volume, maximum mismatch rate, required mismatch-field review, acceptable fallback usage, and rollback-owner approval before switching policy or retiring any fallback.
   - Treat `workflow_disabled` as a rollback state and `snapshot_first` as a safe observation state, not as successful workflow promotion.

3. Add policy/readiness visibility.
   - Surface the active dealer-order read-source policy in authenticated readiness or the release-evidence report.
   - In production-like environments, flag `workflow_disabled` as a release blocker for workflow read promotion while still allowing it as an incident rollback mode.

4. Add production-like drill evidence.
   - Run or automate drills for missing workflow schema, empty snapshot, empty workflow row, workflow/snapshot mismatch, retry backlog, dead-letter backlog, stale processing locks, invalid reconciliation filters, dry-run reconciliation, and capped mutation.
   - Mutations must continue through `requeueWorkflowAction()` and `processAction()`, never through reconstructed provider sends.

5. Keep compatibility cleanup last.
   - Do not remove dealer-order snapshot writes or fallback reads until release evidence satisfies the thresholds above and rollback is documented.
   - Do not remove booking provider webhooks or booking domain tables; they remain permanent booking completion/cancellation truth.

### Batch Nine Non-Goals

- Do not retire `call_context_snapshots.dealerOrder` writes or reads as the first Batch Nine step.
- Do not replace booking provider webhooks, booking delivery events, or booking outcome tables with generic workflow state/events.
- Do not add public workflow details to `/health`.
- Do not introduce dynamic workflow/plugin loading, remote handlers, or untrusted action execution.
- Do not add a migration runner unless it is treated as a separate deployment-safety project with its own rollback plan.
- Do not bulk replay completed actions or bypass the durable outbox idempotency path.

### Batch Nine Acceptance Criteria

1. An authenticated release-evidence report or operator script summarizes readiness, migrations, active read policy, dark-read parity, reconciliation audit state, and replay/drill results without PII or payload leakage.
2. Promotion thresholds are documented and require sample volume, mismatch-rate, mismatch-field, fallback-usage, and rollback-owner evidence before any fallback retirement.
3. Production-like readiness flags make `workflow_disabled` visible as rollback mode and prevent treating it as workflow-read promotion success.
4. Drill tests or scripted validation cover schema missing, empty snapshot, empty workflow row, mismatch, retry, dead-letter, stale processing, invalid status filter, dry-run reconciliation, and capped mutating reconciliation.
5. Existing Batch Eight observability gates remain enforced by `npm run validate:telemetry`.
6. `npm run validate:workflows`, `npm run validate:env`, focused workflow tests, CRLF-aware `git diff --check`, and full Jest remain green.
7. Dealer-order snapshot fallback and booking provider/domain truth remain in place unless a later batch includes production evidence, explicit rollback, and focused compatibility-removal tests.

Decision: Batch Nine is validated as a release-evidence and promotion-gate batch. It should not be treated as approval to remove compatibility mirrors or booking truth paths.

### Batch Nine Implementation Pass - 9 May 2026

Implemented Batch Nine as a release-evidence and promotion-gate surface, not as compatibility cleanup.

Implemented changes:

- Added `services/workflowReleaseEvidenceService.js` to compose workflow readiness, migration-specific readiness, action-outbox state, reconciliation health, active dealer-order read policy, operator-supplied dark-read evidence, reconciliation-audit evidence, production-like drill evidence, and rollback-owner approval into a redacted go/no-go report.
- Added authenticated `GET /api/workflow/release-evidence` and `POST /api/workflow/release-evidence` behind `apiAuth`. The GET form returns a blocked baseline when evidence is missing; the POST form accepts release-window evidence and returns `decision: "go"` only when thresholds and drills pass.
- Added release-threshold environment controls: `WORKFLOW_RELEASE_MIN_DARK_READ_COMPARISONS`, `WORKFLOW_RELEASE_MAX_DARK_READ_MISMATCH_RATE`, `WORKFLOW_RELEASE_MAX_DARK_READ_FALLBACK_RATE`, `WORKFLOW_RELEASE_MAX_WORKFLOW_READ_SKIPPED_RATE`, `WORKFLOW_RELEASE_MIN_RECONCILIATION_DRY_RUNS`, `WORKFLOW_RELEASE_MAX_RECONCILIATION_FAILED_REQUEUES`, and `WORKFLOW_RELEASE_REQUIRE_ROLLBACK_OWNER_APPROVAL`.
- Extended workflow readiness with active dealer-order read-policy visibility so `workflow_disabled` appears as rollback mode and `snapshot_first` appears as observation mode rather than promotion success.
- Added `workflow_release_evidence_checked` telemetry with aggregate decision fields and blocker codes only.
- Updated the workflow operations runbook with release-evidence usage, thresholds, required drill evidence, and explicit guardrails.
- Added focused service and route-auth coverage for ready and blocked release-evidence decisions.

Compatibility guardrails retained:

- Dealer-order snapshot writes and fallback reads remain in place.
- Booking webhooks, booking delivery events, and booking outcome tables remain booking completion/cancellation truth.
- Workflow operations remain authenticated and redacted; public `/health` remains high-level.
- Reconciliation mutation still routes through the durable outbox requeue path and does not replay completed actions.

### Batch Nine Final Hardening Pass - 9 May 2026

Final hardening reviewed the Batch Nine implementation against the actual runtime surfaces rather than only the plan text.

Hardening implemented:

- Added `workflow_release_evidence_checked` to the static `WORKFLOW_PLATFORM_TELEMETRY_EVENTS` inventory so `npm run validate:workflows` now verifies the release-evidence telemetry contract alongside readiness, dark-read, and reconciliation telemetry.
- Extended manifest tests to assert release-evidence telemetry is represented in the workflow platform telemetry summary.
- Added focused release-evidence coverage proving `snapshot_first` remains an observation mode and cannot return `decision: "go"` even when dark-read, reconciliation, drill, and approval evidence otherwise pass.
- Updated the operations runbook to state that `workflow_release_evidence_checked` is aggregate release-audit telemetry and not a substitute for the full operator evidence packet.

Guardrails re-confirmed:

- No dealer-order snapshot fallback reads or snapshot writes were removed.
- Booking provider webhooks and booking domain tables remain permanent booking completion/cancellation truth.
- Public `/health` remains high-level; release evidence remains behind `apiAuth`.
- The release-evidence report remains aggregate-only and does not expose action payloads, destinations, raw call IDs, raw dealer-order values, or customer contact details.
