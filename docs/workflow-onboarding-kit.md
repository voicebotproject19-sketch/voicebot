# Workflow Onboarding Kit

Use this checklist when adding a reusable workflow action. The runtime boundary is intentionally static: workflow metadata describes trusted local handlers, but it never loads remote code or plugin code.

## Required Contract

1. Add the workflow/action entry to `services/workflowManifest.js` with `workflowId`, version, owner, rollback owner, action type, handler name, idempotency key shape, required migrations, telemetry events, and runbook links.
2. Declare parser, classifier, and action-guard applicability. User-driven workflows should point to the real parser/classifier/guard modules. System-triggered workflows can mark a field `not_applicable` with a reason.
3. Register the trusted local handler in `services/workflowActionHandlers.js` and keep side effects inside the durable outbox path.
4. Add or reuse required migrations. Current reusable workflow actions require `013_workflow_action_outbox` and `014_call_workflow_state_events`.
5. Add telemetry event names to `Utils/telemetryEvents.js` before emitting them.
6. Update `docs/workflow-operations-runbook.md` with the workflow/action pair, rollout gates, and replay guidance.

## Required Validation

Run these checks before rollout:

```bash
npm run validate:workflows
npm run validate:telemetry
npm run validate:env
npx jest --forceExit tests/workflowManifest.test.js tests/workflowOperationsService.test.js tests/workflowActionOutboxService.test.js tests/routeAuth.test.js
```

`npm run validate:workflows` fails when a handler is registered without manifest metadata, when a manifest action lacks handler coverage, when runbooks or migration files are missing, or when declared telemetry events are not allowlisted.

## Rollout Pattern

1. Apply migrations manually through `docs/manual-migration-runbook.md`.
2. Check `GET /api/workflow/readiness` and confirm `checks.migrations`, `checks.schema`, `checks.actionOutbox`, and `checks.worker` are healthy.
3. Start with dark-read or read-only reporting when changing read models.
4. Use `GET /api/workflow/reconciliation` for aggregate state and redacted samples.
5. Use `POST /api/workflow/reconciliation/requeue` in `dryRun:true` mode before any capped mutation.
6. Mutate only with explicit filters, `dryRun:false`, and `confirm:"requeue"`; the endpoint remains capped and routes each action through the existing outbox requeue path.
7. Keep compatibility mirrors until dark-read parity, replay evidence, and rollback documentation prove they can be retired.

## Non-Goals

- Do not add dynamic or remote handler loading.
- Do not replay completed actions.
- Do not expose raw call IDs, payloads, destinations, or customer details on operator surfaces.
- Do not replace booking provider webhooks or booking domain tables with workflow events; workflow events are orchestration history.