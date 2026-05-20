# Persona And Bot Creation Runbook

Use this runbook when creating a new VoiceBot persona through chat. The goal is to decide early whether the request is a prompt-only persona or an action workflow, then add only the files needed for that path.

## 1. Chat Intake

Capture these answers before coding:

| Question | Why it matters |
|----------|----------------|
| Who is the bot calling or answering for? | Defines persona identity, greeting, audience, and tone. |
| What business outcome should the call produce? | Defines stage mapping, ROI, and success metrics. |
| Is the bot only informing/qualifying, or does it perform an action? | Decides prompt-only persona versus action workflow. |
| What seed data is available before the call? | Defines `contextHint` and CRM/orchestration payloads. |
| What data is collected during the call? | Defines mutable workflow state and persistence needs. |
| What external systems are touched? | Defines ERP/CRM/webhook/provider side effects and idempotency. |
| What must be confirmed verbally? | Defines transaction/action guard requirements. |
| What happens on silence, missed call, no answer, or skip? | Defines fallback behavior and provider-status handling. |
| What telemetry and reporting are required? | Defines event allowlist, call summary fields, and ROI. |
| Which env vars are core versus feature/persona-specific? | Prevents growth of the core runtime config surface. |

Do not start with adapter rewrites. Add the smallest stable contract first, then route behavior through existing session seams until the workflow registry/orchestrator exists.

## 2. Decision: Prompt-Only Or Action Workflow

Choose prompt-only when the bot only changes wording, voice, qualification style, knowledge, or call script. A prompt-only bot normally needs:

- `personas/<persona-id>.js`
- optional knowledge base content
- docs entry
- focused persona registration/prompt tests

Choose action workflow when the bot captures structured data, needs explicit confirmation, writes to external systems, sends messages, transfers calls, books slots, retries work, or needs durable state. An action bot normally needs:

- persona file for identity and scripts
- deterministic parser or classifier for action signals
- workflow/service module for side effects
- persistence for mutable state/events/outbox when the action is production-grade
- telemetry events and final summary fields
- service, session, and replay/idempotency tests

## 3. Persona File Contract

Persona files live in `personas/` and are auto-loaded by `personas/registry.js` when the file is not prefixed with `_`.

Every persona should define:

- `id`: stable kebab-case identifier used by `/api/call`.
- `name`, `company`, and `role`: identity exposed to the caller.
- `languages`: at least one language entry with voice settings, greeting, base instructions, and optional `buildTurnPrompt`.
- `flow`: high-level flow type and call type.
- `rules`: target word counts and speech constraints.
- silence/screening/voicemail scripts when outbound calls are supported.

Persona files should stay declarative. They may format seed context and current workflow state for prompts, but they should not submit orders, send messages, transfer calls, or mutate durable workflow state.

## 4. `contextHint` Ownership

`contextHint` is immutable invocation seed data. It is suitable for CRM fields known before the call, such as account name, campaign trigger, last order summary, target progress, preferred URL, or notes.

Do not store mutable workflow progress in `contextHint`. Captured items, confirmation status, retry count, transfer attempts, provider message IDs, ERP IDs, and completion status belong in durable workflow state/events/outbox tables.

Preferred shape for structured seed data:

```json
{
  "accountId": "A-1024",
  "accountName": "Apex Auto Parts",
  "triggerReason": "approaching_sales_milestone",
  "lastInteraction": "20 cases of engine oil on 2026-04-28",
  "selfServiceUrl": "https://orders.example.com/self-service/A-1024"
}
```

The current API allows long `contextHint` values, but database durability must be verified for each runtime path before relying on large JSON payloads after reconnect or restart.

## 5. Workflow Data Contract

For action workflows, define these fields before implementation:

| Field | Description |
|-------|-------------|
| `workflowId` | Stable workflow/plugin key, such as `dealer-order-capture`. |
| `pluginVersion` | Version of the workflow contract. |
| `seedContext` | Parsed immutable seed data derived from `contextHint`. |
| `state` | Mutable state, such as captured items and confirmation status. |
| `events` | Append-only events, such as items captured, confirmed, skipped, submitted. |
| `outbox` | Durable side-effect jobs, such as ERP submit or SMS/email send. |
| `summary` | Fields projected into call summary and analytics. |
| `idempotencyKey` | Stable duplicate-suppression key for every external effect. |

Until generic workflow tables exist, keep action state namespaced and avoid adding one-off snapshot columns unless the slice explicitly includes migration and repository tests.

## 6. Guardrails

Layer guardrails by where the risk enters:

| Layer | Responsibility |
|-------|----------------|
| Transport/audio gates | Drop unsafe or stale audio turns before action extraction. |
| Gate 4 noisy-turn suppression | Suppress garbled transcripts before workflow logic. |
| Persona prompt rules | Keep wording, disclosure, refusal, and domain boundaries clear. |
| Deterministic parser/classifier | Extract structured action signals without relying only on the LLM. |
| Action guard | Require explicit confirmation and minimum confidence before side effects. |
| Backend validation | Treat ERP/CRM/provider response as authoritative for external status. |
| Idempotency/outbox | Prevent duplicate or lost side effects across retries and restarts. |
| Telemetry/readiness | Make blocked, failed, retried, and completed actions observable. |

Phase 4 protects conversational generation. It does not automatically protect scripted action branches unless the workflow tags the turn and invokes the same transaction assumptions before side effects.

## 7. Stage, Outcome, And ROI Mapping

Every new bot needs a stage and outcome contract:

- Universal `conversationPhase` can remain broad: opening, discovery, confirmation, success, rejected.
- Workflow-specific stage should live under the workflow state, such as `open`, `awaiting_confirmation`, `confirmed`, `erp_logged`, `notification_sent`, `skipped`, or `failed`.
- Final call summary should expose stable workflow summary fields.
- ROI should use the existing business metrics formula when possible, with a feature-specific default value env var when external pricing is not available.

Do not invent monetary value inside prompts. ROI values come from configuration, ERP payloads, or reporting pipelines.

## 8. Env Ownership

Classify every env var before adding it:

| Category | Examples |
|----------|----------|
| Core runtime | server, auth, database, AI provider, telecom credentials, telemetry, global policy gates. |
| Feature/plugin | booking provider, dealer-order ERP, retry/fallback, warm transfer, RAG synthesis. |
| Persona/client override | default persona/language, client notification targets, persona transfer number, workflow enablement. |

The compatibility aggregate `.env.example` should remain valid while split env files are introduced. The env validator reads `.env.example` plus root-level `.env.*.example` files as a union, so do not reduce `.env.example` until the split files cover all runtime references and `npm run validate:env` passes.

## 9. Implementation Checklist

Use this order for action bots:

1. Add persona file and docs.
2. Add deterministic parser/classifier tests.
3. Add service module with env resolver accepting `env = process.env`.
4. Add telemetry event names and docs.
5. Add session/adapter compatibility hook with minimal branching.
6. Add call summary and ROI fields.
7. Add repository/migration tests for durable state.
8. Add action guard tests for confirm, ambiguous, skip, low confidence, duplicate submit, and noisy transcript.
9. Add outbox/replay tests before production side effects are considered reliable.
10. Run focused tests, env validation, telemetry validation, syntax checks, and `git diff --check`.

## 10. Rollout Checklist

A persona is ready for pilot when:

- The persona is discoverable through `listPersonas()` and has focused tests.
- All prompt rules are domain-specific and avoid invented facts.
- Structured actions have deterministic extraction and explicit confirmation.
- Durable state and outbox exist for irreversible production side effects.
- Env vars are documented and validated.
- Telemetry events are allowlisted and covered by validation.
- Final summaries expose workflow status and outcome.
- Missed-call, fallback, skip, and wrong-contact paths are documented.
- Provider parity is checked for Twilio and Plivo when both are enabled.
- Operators have a rollback/disable path, normally by disabling the persona or workflow env gate.

## 11. Demo-Safe Smoke Checklist

Use this checklist before any live AE-led prospect demo. The automated smoke proves code and contract readiness; the carrier-call checks remain manual because they require live telecom credentials, a reachable `NETWORK_URL`, and real target numbers.

### Automated Smoke

Run the aggregate smoke command from the repository root:

```bash
npm run smoke:demo
```

The command wraps these existing validations:

1. `npm run validate:env`
2. `npm run validate:phase3-surface`
3. `npm run validate:workflows`
4. `npm run validate:telemetry`

Do not proceed to a live call if any step fails. Capture the command, date, branch, and commit SHA in demo notes instead of hardcoding test counts.

### Runtime Preflight

Verify the demo runtime before dialing:

1. Run a single app instance unless Sprint 3.1 Redis-backed `CallRegistry` has shipped and clustered boot verifies durable call context.
2. Confirm `NODE_ENV=production` or an explicitly approved demo env value.
3. Confirm `NETWORK_URL` is public and matches the carrier webhook configuration.
4. Confirm `/health` returns `status: ok`; a `degraded` response must be explained and accepted before proceeding.
5. Confirm at least one telecom provider is configured, and use the configured provider for the region under test.
6. Confirm the Azure Monitor workbook or equivalent telemetry view is open to the response-latency panel.

### Live Carrier Smoke

Run one controlled Twilio path and one controlled Plivo path when both providers are enabled:

1. Place a dealer-order call using persona `dealer-orders` and language `en`.
2. Place an outbound sales qualification call using persona `company-sales` and language `en`.
3. Verify the greeting identifies the caller as an AI assistant.
4. For a two-party or unknown NANP consent state, verify the greeting asks for recording consent before continuing.
5. Complete one booking-link or dealer-order action only after explicit verbal confirmation.
6. Verify the call summary and relevant workflow/action telemetry appear after finalization.
7. Verify p95 response latency is green in the dashboard for the demo window.

### Compliance Gate Smoke

Run these before a prospect-facing demo using internal test numbers only:

1. DNC/suppression: add the test number to the suppression list, call `/api/call`, and verify the API blocks before invoking a telecom provider.
2. Consent ledger: set `CONSENT_CHECK_ENABLED=true`, use a number without valid consent, and verify the API blocks with a consent reason.
3. Calling window: use a known NANP number outside the permitted destination window, or inject the covered unit-test case, and verify the gate blocks.
4. Recording consent: use a two-party or unknown NANP consent state and verify `requireExplicitRecordingConsent` reaches the persona greeting.
5. Bypass: use `COMPLIANCE_BYPASS=true` only outside production and verify DNC/suppression is still never bypassed.

Durable `consent.revoke` and `suppression.add` workflow actions are not part of Sprint 1.4. They belong to Sprint 2.1 and should not be represented as demo-safe until they flow through the workflow outbox and action handler registry.

### Stop Conditions

Stop the demo and do not call a prospect when any of these are true:

1. `npm run smoke:demo` fails.
2. `/health` is degraded for database, AI provider, telecom provider, or base env without explicit operator acceptance.
3. Cluster mode is enabled without verified durable call context.
4. AI disclosure or recording consent wording is missing from the first turn where it is required.
5. Compliance gate telemetry is missing for a blocked-call smoke check.
6. p95 response latency is red or unavailable for the demo window.
