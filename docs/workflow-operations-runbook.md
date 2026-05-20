# Workflow Operations Runbook

This runbook covers durable workflow action operations for dealer-order submissions, booking-link delivery, and handover follow-up delivery actions. It assumes the operator has `APP_API_KEY` and that requests are sent over a trusted administrative channel.

## Preconditions

1. Apply migrations `013_workflow_action_outbox.sql` and `014_call_workflow_state_events.sql` before relying on workflow readiness, replay, or action history.
2. Set `APP_API_KEY`; workflow operations endpoints use `x-api-key` and are not exposed through public `/health`.
3. In production, keep `ACTION_OUTBOX_WORKER_ENABLED=true` unless a controlled rollback or drain is in progress.
4. Run `npm run validate:env`, `npm run validate:telemetry`, `npm run validate:workflows`, and the focused workflow tests before rollout.

## Readiness Check

Use the authenticated readiness endpoint to verify schema, worker state, dead-letter backlog, retry backlog, and stale processing locks.

```bash
curl -sS -H "x-api-key: $APP_API_KEY" \
  "$BASE_URL/api/workflow/readiness?staleLockSeconds=120"
```

Healthy readiness returns `ok: true`, `checks.schema: "ok"`, `checks.migrations: "ok"`, `checks.actionOutbox: "ok"`, and `checks.worker: "enabled"`. The `manifest` block lists the static workflow contract inventory and the `migrations` block maps required migration IDs, currently `013_workflow_action_outbox` and `014_call_workflow_state_events`, to the table/column checks that prove them. Warning readiness returns `ok: true` with `checks.actionOutbox: "warning"` and an `outbox.issues` entry such as `retry_backlog` or a non-production `worker_disabled`. Retry, dead-letter, and stale-lock issues include oldest timestamps and `oldestAgeSeconds` so operators can judge urgency without inspecting payloads. Treat `missing_schema`, missing or incomplete migration readiness, `dead_letter_backlog`, `stale_processing_locks`, or a production `worker_disabled` issue as a release blocker.

Each readiness check emits `workflow_readiness_checked` with aggregate counts and oldest-age fields only. Use the Azure workbook `Workflow Readiness Backlog` panel and workflow dead-letter/stale-lock alerts for production monitoring; raw action payloads, destinations, and customer details are not projected.

## Dealer-Order Read Source Policy

Dealer-order hydration uses an explicit read-source policy controlled by `DEALER_ORDER_READ_SOURCE_POLICY`.

- `workflow_first` is the default. It uses generic workflow state when a useful dealer-order row exists, with the legacy call-context snapshot as fallback.
- `snapshot_first` keeps the legacy snapshot as the user-facing source while still dark-reading workflow state for parity evidence.
- `workflow_disabled` skips the workflow-state read entirely and uses only the legacy snapshot fallback for rollback or missing-schema incidents.

All modes preserve fallback behavior. Do not remove dealer-order snapshot writes or reads until the dark-read parity panel has enough production-like samples and a rollback owner has approved the change.

## Dark-Read Observability

Dealer-order hydration emits `workflow_dark_read_compared` for each read decision and `workflow_dark_read_mismatch` when workflow state differs from the snapshot summary. These events include workflow/read-model identifiers, read policy, selected source, fallback usage, `workflowReadSkipped`, mismatch count, mismatch field names, and `callIdHash` only; they do not include raw order values, payloads, or customer contact details. Empty snapshot rows are not treated as useful fallback state; if workflow state has useful dealer-order content and the snapshot is empty, the workflow state remains the selected source.

Use the Azure workbook `Workflow Dark-Read Parity` panel before changing read policy or retiring fallback reads. Release evidence should include comparison volume, mismatch rate, mismatch fields, source mix, and fallback usage over the agreed window.

## Action Inspection

Use redacted samples for operator triage. Payloads and destinations are intentionally omitted. Samples expose action IDs, workflow/action type, status, attempt counts, timestamps, a `callIdHash`, and a PII-redacted `reasonSummary`.

```bash
curl -sS -H "x-api-key: $APP_API_KEY" \
  "$BASE_URL/api/workflow/actions?statuses=dead_letter,retry,processing&limit=25"
```

Filter by workflow or action type when triaging a specific surface.

```bash
curl -sS -H "x-api-key: $APP_API_KEY" \
  "$BASE_URL/api/workflow/actions?workflowId=dealer-orders&actionType=dealer_order_submit&statuses=dead_letter,retry&limit=10"
```

Current workflow/action pairs include `dealer-orders` / `dealer_order_submit`, `booking-link-delivery` / `booking_link_deliver`, and `handover-followup` / `handover_followup_send`.

## Reconciliation

Use reconciliation for a redacted workflow-level summary of completion rates, retry/dead-letter state, stale processing locks, and triage samples.

```bash
curl -sS -H "x-api-key: $APP_API_KEY" \
  "$BASE_URL/api/workflow/reconciliation?staleLockSeconds=120&limit=25"
```

Filter it the same way as action inspection.

```bash
curl -sS -H "x-api-key: $APP_API_KEY" \
  "$BASE_URL/api/workflow/reconciliation?workflowId=handover-followup&actionType=handover_followup_send"
```

The response is read-only and redacted. It includes aggregate totals, per-workflow completion rates, backlog issues, and sample metadata with `callIdHash` and `reasonSummary`; it does not include raw call IDs, payloads, result bodies, destinations, or customer details.

Each dry-run emits `workflow_reconciliation_audit`. Invalid status filters also emit an audit event with `plannedActionCount: 0` and `invalidStatuses` before returning HTTP 400. Successful mutation attempts emit `workflow_reconciliation_requeue_completed` after routing the capped action set through the existing outbox requeue path. Use the Azure workbook `Workflow Reconciliation Audit` panel to review audit ID, mode, dry-run flag, workflow/action filters, status filters, invalid status filters, planned actions, requeued actions, failures, and cap before and after mutation.

## Requeue And Replay

Requeue only after confirming the action is safe to retry and the original failure is resolved. The endpoint only moves eligible `retry`, `failed`, `dead_letter`, or stale `processing` actions back to `queued`; it does not resend completed actions or bypass the outbox worker.

```bash
curl -sS -X POST \
  -H "x-api-key: $APP_API_KEY" \
  -H "content-type: application/json" \
  -d '{"reason":"operator_requeue_after_provider_recovery","lockTimeoutSeconds":120}' \
  "$BASE_URL/api/workflow/actions/$ACTION_ID/requeue"
```

Successful requeue emits `action_outbox_requeued`, appends a workflow event, and leaves execution to the existing `processAction()` path. The response returns the same redacted action metadata shape used by action inspection; it does not include raw call IDs, payloads, results, destinations, or customer details. A completed action returns a conflict response and must not be resent manually.

## Audited Reconciliation Requeue

Use reconciliation requeue in dry-run mode first. It returns the capped set of eligible action IDs and redacted metadata that would be requeued, emits `workflow_reconciliation_audit`, and does not mutate rows.

```bash
curl -sS -X POST \
  -H "x-api-key: $APP_API_KEY" \
  -H "content-type: application/json" \
  -d '{"workflowId":"dealer-orders","actionType":"dealer_order_submit","statuses":"dead_letter,retry","limit":10,"dryRun":true,"reason":"provider_recovered"}' \
  "$BASE_URL/api/workflow/reconciliation/requeue"
```

To mutate, repeat the same explicit filters with `dryRun:false` and `confirm:"requeue"`. The cap is bounded to 25 actions per request. Each action still goes through the existing outbox requeue path, carries the reconciliation `auditId`, emits `action_outbox_requeued`, appends a workflow event, and is later executed by `processAction()`.

Allowed reconciliation requeue statuses are `dead_letter`, `retry`, `failed`, and `processing`. Invalid statuses such as `completed` are rejected instead of being silently broadened to the default filter. `processing` rows are included only when the lock is stale according to `lockTimeoutSeconds`; fresh in-flight work is not planned or requeued by reconciliation dry-runs.

```bash
curl -sS -X POST \
  -H "x-api-key: $APP_API_KEY" \
  -H "content-type: application/json" \
  -d '{"workflowId":"dealer-orders","actionType":"dealer_order_submit","statuses":"dead_letter,retry","limit":10,"dryRun":false,"confirm":"requeue","reason":"provider_recovered"}' \
  "$BASE_URL/api/workflow/reconciliation/requeue"
```

Completed actions are not selected by the default reconciliation requeue statuses and must not be replayed manually. Responses remain redacted and omit raw call IDs, payloads, result bodies, destinations, and customer details.

## Release Evidence And Promotion Gate

Use the authenticated release-evidence report before changing dealer-order read policy, retiring fallback reads, or claiming workflow-read promotion. The report combines current workflow readiness, migration status, action-outbox state, reconciliation health, active read policy, operator-supplied dark-read evidence, reconciliation audit evidence, production-like drill evidence, and rollback-owner approval into a go/no-go decision.

Generate a blocked baseline report at any time:

```bash
curl -sS -H "x-api-key: $APP_API_KEY" \
  "$BASE_URL/api/workflow/release-evidence"
```

Submit release-window evidence after reviewing the Azure workbook panels and drill results:

```bash
curl -sS -X POST \
  -H "x-api-key: $APP_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "evidence": {
      "darkRead": {
        "comparisonCount": 250,
        "mismatchCount": 0,
        "fallbackUsedCount": 3,
        "workflowReadSkippedCount": 0,
        "mismatchFields": [],
        "mismatchFieldsReviewed": true
      },
      "reconciliationAudit": {
        "dryRunCount": 2,
        "mutationCount": 1,
        "failedRequeueCount": 0,
        "invalidStatusFilterCount": 0
      },
      "drills": {
        "missing_schema": true,
        "empty_snapshot": true,
        "empty_workflow_row": true,
        "workflow_snapshot_mismatch": true,
        "retry_backlog": true,
        "dead_letter_backlog": true,
        "stale_processing_lock": true,
        "invalid_status_filter": true,
        "dry_run_reconciliation": true,
        "capped_mutating_reconciliation": true
      },
      "approvals": {
        "rollbackOwnerApproved": true,
        "rollbackOwner": "platform-ops",
        "approvalId": "release-window-id"
      }
    }
  }' \
  "$BASE_URL/api/workflow/release-evidence"
```

The report is intentionally aggregate-only. It does not include action payloads, destinations, raw call IDs, raw dealer-order values, or customer contact details. A `decision: "go"` means the evidence satisfies the configured promotion thresholds. It does not authorize deleting `call_context_snapshots.dealerOrder` writes, snapshot fallback reads, booking provider webhooks, booking delivery events, or booking outcome tables.

Each report emits `workflow_release_evidence_checked` with aggregate decision status, read policy, dark-read rates, reconciliation counts, drill counts, and blocker codes only. Treat that event as release audit telemetry, not as a replacement for the full operator evidence packet.

Promotion thresholds are configured through the environment contract:

- `WORKFLOW_RELEASE_MIN_DARK_READ_COMPARISONS`: minimum dark-read comparison volume.
- `WORKFLOW_RELEASE_MAX_DARK_READ_MISMATCH_RATE`: maximum mismatch rate, expressed as a decimal between `0` and `1`.
- `WORKFLOW_RELEASE_MAX_DARK_READ_FALLBACK_RATE`: maximum fallback usage rate.
- `WORKFLOW_RELEASE_MAX_WORKFLOW_READ_SKIPPED_RATE`: maximum skipped workflow-read rate.
- `WORKFLOW_RELEASE_MIN_RECONCILIATION_DRY_RUNS`: minimum audited reconciliation dry-run count.
- `WORKFLOW_RELEASE_MAX_RECONCILIATION_FAILED_REQUEUES`: maximum failed reconciliation requeue count.
- `WORKFLOW_RELEASE_REQUIRE_ROLLBACK_OWNER_APPROVAL`: whether rollback-owner approval is required.

Treat `workflow_disabled` as an incident rollback mode and `snapshot_first` as an observation mode. Neither mode is accepted as workflow-read promotion success by the release-evidence report.

## Dead-Letter Triage

1. Inspect redacted samples for `reasonSummary`, `workflowId`, `actionType`, `attemptCount`, and timestamps.
2. Verify external dependency health, such as ERP, SMTP, SMS, WhatsApp, booking provider, or network configuration.
3. Check readiness again after provider recovery to confirm there are no stale locks.
4. Check reconciliation for completion rate and remaining dead-letter count on the affected workflow/action pair.
5. Requeue one action first and confirm `action_outbox_completed` before any wider requeue.
6. Keep completed booking truth in booking provider webhooks and booking domain tables; generic workflow events are orchestration history.

## Rollback And Drain

1. Stop new risky rollout traffic at the persona or routing layer before touching the outbox.
2. For a controlled drain, keep `ACTION_OUTBOX_WORKER_ENABLED=true` until queued and retry counts reach zero.
3. To freeze background retries during an incident, set `ACTION_OUTBOX_WORKER_ENABLED=false` and restart workers, then monitor readiness as degraded in production or warning in non-production until the worker is re-enabled.
4. Do not delete outbox rows during rollback. Preserve queued, retry, and dead-letter rows for replay or post-incident reconciliation.

## Rollout Gates

Before enabling a new workflow action in production, verify all of the following:

1. Migrations `013` and `014` are present in readiness output.
2. `ACTION_OUTBOX_WORKER_ENABLED=true` in production.
3. No dead-letter backlog exists for the workflow/action type being released.
4. `npm run validate:telemetry` passes, including observability metric validation.
5. `npm run validate:workflows` passes, proving manifest, handler registry, telemetry allowlist, migration files, and runbook coverage are aligned.
6. Focused workflow repository, service, operations, and route-auth tests pass.
7. Reconciliation shows acceptable completion rate and no unexplained stale processing locks.
8. The release-evidence report returns `decision: "go"` for the release window.
9. Rollback owners know whether to drain, freeze worker retries, set `DEALER_ORDER_READ_SOURCE_POLICY=snapshot_first`, set `DEALER_ORDER_READ_SOURCE_POLICY=workflow_disabled`, or disable the workflow entry point.