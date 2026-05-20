# Manual Migration Runbook

This repository does not include a runtime migration runner. Database setup is manual and must be completed before running the application against a new MySQL environment.

## Applies to

- `migrations/001_call_sessions.sql`
- `migrations/002_legacy_tables.sql`
- `migrations/003_call_outcomes.sql`
- `migrations/004_suppression_list.sql`
- `migrations/005_consent_ledger.sql`
- `migrations/006_booking_events.sql`
- `migrations/007_booking_outcome_statuses.sql`
- `migrations/008_booking_delivery_events.sql`
- `migrations/009_call_context_snapshots.sql`
- `migrations/010_booking_webhook_orphans.sql`
- `migrations/011_call_context_dealer_order_state.sql`
- `migrations/012_dealer_order_outcomes.sql`
- `migrations/013_workflow_action_outbox.sql`
- `migrations/014_call_workflow_state_events.sql`
- `services/db.js`
- `repositories/`

## Required database settings

The application connects with these environment variables:

- `DB_HOST`
- `DB_USER`
- `DB_PASSWORD`
- `DB_NAME`

Confirm that `DB_NAME` already exists before applying the SQL files. The Node runtime does not create the database itself.

## Migration order

Apply the files in numeric order:

1. `migrations/001_call_sessions.sql`
2. `migrations/002_legacy_tables.sql`
3. `migrations/003_call_outcomes.sql`
4. `migrations/004_suppression_list.sql`
5. `migrations/005_consent_ledger.sql`
6. `migrations/006_booking_events.sql`
7. `migrations/007_booking_outcome_statuses.sql`
8. `migrations/008_booking_delivery_events.sql`
9. `migrations/009_call_context_snapshots.sql`
10. `migrations/010_booking_webhook_orphans.sql`
11. `migrations/011_call_context_dealer_order_state.sql`
12. `migrations/012_dealer_order_outcomes.sql`
13. `migrations/013_workflow_action_outbox.sql`
14. `migrations/014_call_workflow_state_events.sql`

`001_call_sessions.sql` does not use `IF NOT EXISTS`, so rerunning it against an existing `call_sessions` table will fail. Check first before applying it again.

## Pre-flight checks

1. Point the shell at the intended database environment.
2. Back up the target database if it already contains data.
3. Verify whether the tables already exist.

Example checks:

```bash
mysql -h "$DB_HOST" -u "$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" -e "SHOW TABLES LIKE 'call_sessions'; SHOW TABLES LIKE 'users_demobot'; SHOW TABLES LIKE 'conversations_demobot';"
```

## Apply the migrations

Run from the repository root.

```bash
mysql -h "$DB_HOST" -u "$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" < migrations/001_call_sessions.sql
mysql -h "$DB_HOST" -u "$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" < migrations/002_legacy_tables.sql
mysql -h "$DB_HOST" -u "$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" < migrations/003_call_outcomes.sql
mysql -h "$DB_HOST" -u "$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" < migrations/004_suppression_list.sql
mysql -h "$DB_HOST" -u "$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" < migrations/005_consent_ledger.sql
mysql -h "$DB_HOST" -u "$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" < migrations/006_booking_events.sql
mysql -h "$DB_HOST" -u "$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" < migrations/007_booking_outcome_statuses.sql
mysql -h "$DB_HOST" -u "$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" < migrations/008_booking_delivery_events.sql
mysql -h "$DB_HOST" -u "$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" < migrations/009_call_context_snapshots.sql
mysql -h "$DB_HOST" -u "$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" < migrations/010_booking_webhook_orphans.sql
mysql -h "$DB_HOST" -u "$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" < migrations/011_call_context_dealer_order_state.sql
mysql -h "$DB_HOST" -u "$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" < migrations/012_dealer_order_outcomes.sql
mysql -h "$DB_HOST" -u "$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" < migrations/013_workflow_action_outbox.sql
mysql -h "$DB_HOST" -u "$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" < migrations/014_call_workflow_state_events.sql
```

## Post-apply verification

Verify that the tables now exist and that the expected columns are present.

```bash
mysql -h "$DB_HOST" -u "$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" -e "SHOW TABLES LIKE 'call_sessions'; SHOW TABLES LIKE 'users_demobot'; SHOW TABLES LIKE 'conversations_demobot'; SHOW TABLES LIKE 'call_outcomes'; SHOW TABLES LIKE 'suppression_list'; SHOW TABLES LIKE 'consent_ledger'; SHOW TABLES LIKE 'booking_events'; SHOW TABLES LIKE 'booking_delivery_events'; SHOW TABLES LIKE 'call_context_snapshots'; SHOW TABLES LIKE 'booking_webhook_orphans'; SHOW TABLES LIKE 'workflow_action_outbox'; SHOW TABLES LIKE 'call_workflow_states'; SHOW TABLES LIKE 'call_workflow_events'; SHOW COLUMNS FROM call_context_snapshots LIKE 'dealerOrder'; SHOW COLUMNS FROM call_workflow_states LIKE 'stateJson'; SHOW COLUMNS FROM call_workflow_events LIKE 'idempotencyKey';"
```

Expected tables:

- `call_sessions`
- `users_demobot`
- `conversations_demobot`
- `call_outcomes`
- `suppression_list`
- `consent_ledger`
- `booking_events`
- `booking_delivery_events`
- `call_context_snapshots`
- `booking_webhook_orphans`
- `workflow_action_outbox`
- `call_workflow_states`
- `call_workflow_events`

## Operational notes

- Apply migrations before starting `node app.js` in a new environment.
- If `call_sessions` already exists, inspect it before rerunning `001_call_sessions.sql`.
- `002_legacy_tables.sql` is written for backward compatibility with the existing user/conversation read paths and legacy write helpers.
- `003_call_outcomes.sql` through `005_consent_ledger.sql` all use `IF NOT EXISTS` — safe to rerun.
- `006_booking_events.sql` and `008_booking_delivery_events.sql` use `IF NOT EXISTS` and are safe to rerun.
- `009_call_context_snapshots.sql` uses `IF NOT EXISTS` and is safe to rerun.
- `010_booking_webhook_orphans.sql` uses `IF NOT EXISTS` and is safe to rerun.
- `011_call_context_dealer_order_state.sql` widens `call_context_snapshots.contextHint` to `TEXT` and adds `dealerOrder JSON`. Apply it once after `009_call_context_snapshots.sql`; rerunning it after `dealerOrder` already exists will fail on MySQL versions without conditional column DDL.
- `012_dealer_order_outcomes.sql` updates the `call_outcomes.outcome` enum for dealer-order confirmation and skip outcomes. Apply it after `003_call_outcomes.sql` and `007_booking_outcome_statuses.sql` before relying on dealer-order analytics.
- `013_workflow_action_outbox.sql` creates the durable side-effect outbox used for dealer-order ERP and notification execution. It uses `IF NOT EXISTS` and is safe to rerun.
- `014_call_workflow_state_events.sql` creates generic workflow state/event tables used for dealer-order shadow state and booking-link delivery orchestration history. It uses `IF NOT EXISTS` and is safe to rerun.
- `007_booking_outcome_statuses.sql` updates the `call_outcomes.outcome` enum for booking-link and provider-completion statuses. Apply it after `003_call_outcomes.sql` and before relying on booking outcome analytics.
- **`005_consent_ledger.sql` is required for Sprint 2 consent features.** If omitted, consent write jobs will fail silently after 3 retries with a `console.error`. The application will still function (fail-open), but consent revocations will not be persisted.
- **`006_booking_events.sql`, `007_booking_outcome_statuses.sql`, and `008_booking_delivery_events.sql` are required for booking-link delivery and provider webhook completion reporting.** If omitted, booking delivery or completion write jobs will fail after retries and conversion analytics can undercount completed meetings.
- **`009_call_context_snapshots.sql` is required for clustered or multi-worker deployments.** If omitted, calls can still run, but cross-worker WebSocket/callback hydration falls back to generic defaults and may lose persona, language, provider, consent, or booking context.
- **`010_booking_webhook_orphans.sql` is required before enabling `BOOKING_CORRELATION_SECRET`.** If omitted, completed/cancelled provider webhooks without valid signed call correlation will still be acknowledged and emitted as `booking_webhook_orphaned`, but orphan reconciliation persistence will fail after write-queue retries.
- **`011_call_context_dealer_order_state.sql` is required before relying on dealer-order reconnect or callback recovery.** If omitted, long JSON `contextHint` values can be truncated by the old snapshot column and `dealerOrder` state patches will fail or be dropped depending on the deployed schema.
- **`012_dealer_order_outcomes.sql` is required before persisting dealer-order outcomes.** If omitted, `persist_outcome` jobs for `dealer_order_confirmed` or `dealer_order_skipped` can fail against the old enum.
- **`013_workflow_action_outbox.sql` is required before enabling production dealer-order side effects.** If omitted, confirmed dealer orders can be blocked from durable ERP/notification enqueueing and the action outbox worker will emit `action_outbox_failed` or `action_outbox_poll_failed` telemetry.
- **`014_call_workflow_state_events.sql` is required before relying on generic workflow state/event history.** If omitted, workflow state writes fail soft and calls continue, but dealer-order workflow history and booking-link orchestration events will be skipped until the migration is applied.
- Set `BOOKING_CORRELATION_SECRET` to a strong random value before rollout. Keep `BOOKING_CORRELATION_LEGACY_MODE=orphan` in steady state; use `attribute` only during a short migration window for pre-existing unsigned booking links.
- **`CONSENT_CHECK_ENABLED=true` must NOT be enabled** until `005_consent_ledger.sql` has been run AND consent records have been imported for all existing leads. Without pre-populated consent records, every outbound call will be blocked.
- If a deployment pipeline is added later, this runbook should remain the fallback procedure until an automated migration path is officially supported.