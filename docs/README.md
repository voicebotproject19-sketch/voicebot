# VoiceBot Documentation

This folder contains analysis, specifications, and reference documentation for the VoiceBot real-time enterprise voice platform.

Current runtime truth lives in code first, then in the current-state docs below. Older audits are retained for traceability and should be treated as historical snapshots unless they explicitly say otherwise.

---

## Overview & architecture

| Document | Description |
|----------|-------------|
| [codebase-index.md](./codebase-index.md) | Current navigation index: runtime entry points, subsystem map, core state owners, external integrations, and recommended reading order. |
| [confidence-gap-report.md](./confidence-gap-report.md) | Final confidence boundary report: resolved repo-internal gaps, stale validators, and irreducible external unknowns. |
| [drift-remediation-plan.md](./drift-remediation-plan.md) | Verified remediation sequence for operator config drift, stale tests, stale CI validators, layering inconsistencies, docs drift, and deployment setup drift. |
| [full-codebase-index.md](./full-codebase-index.md) | Repository-wide index covering all top-level folders, active runtime code, support code, assets, tests, CI, and documentation surfaces. |
| [full-codebase-analysis.md](./full-codebase-analysis.md) | Full repository analysis: active runtime, support layers, dormant clusters, governance surface, and confidence assessment. |
| [runtime-dependency-map.md](./runtime-dependency-map.md) | Live runtime dependency map: hot-path modules, cross-layer edges, fan-in and fan-out choke points, and debugging order. |
| [runtime-risk-review.md](./runtime-risk-review.md) | Runtime path risk review from call initiation to teardown, ordered by operational impact. |

---

## Historical snapshots

These docs capture earlier repository states and are useful for audit history, not as canonical runtime truth.

| Document | Description |
|----------|-------------|
| [voice-platform-analysis.md](./voice-platform-analysis.md) | Historical codebase analysis snapshot from an earlier runtime shape. |
| [structural-architecture-audit.md](./structural-architecture-audit.md) | Historical architecture audit from the pre-adapter/pre-session-refactor structure. |
| [structural-audit-results.md](./structural-audit-results.md) | Historical structural audit results retained for comparison and drift tracking. |
| [stt-tts-provider-audit.md](./stt-tts-provider-audit.md) | Historical STT/TTS architecture plan and provider snapshot. |
| [openai-rate-limit-analysis.md](./openai-rate-limit-analysis.md) | Historical rate-limit analysis based on an earlier speech/runtime stack description. |

---

## Specifications & acceptance

| Document | Description |
|----------|-------------|
| [call-context-acceptance.md](./call-context-acceptance.md) | Call context and lifecycle acceptance criteria. |
| [VoiceBot Unlock & Degradation Control — Formal Specification.md](./VoiceBot%20Unlock%20%26%20Degradation%20Control%20%E2%80%94%20Formal%20Specification.md) | Formal spec for unlock behavior and degradation control. |
| [Conversational Intelligence & Reliability Layer.md](./Conversational%20Intelligence%20%26%20Reliability%20Layer.md) | Conversational intelligence and reliability layer design. |
| [latency-responsiveness-conversational-quality.md](./latency-responsiveness-conversational-quality.md) | Latency budgeting, responsiveness (prewarm, pacing), and conversational quality (micro-acknowledgements). Feature spec and acceptance criteria. |

---

## Implementation & validation

| Document | Description |
|----------|-------------|
| [phase2-epoch-isolation-implementation-plan.md](./phase2-epoch-isolation-implementation-plan.md) | Plan for deterministic turn/epoch isolation. |
| [phase2-implementation-validation.md](./phase2-implementation-validation.md) | Validation of phase 2 epoch isolation implementation. |
| [phase3-provider-abstraction-validation.md](./phase3-provider-abstraction-validation.md) | Phase 3 provider abstraction acceptance evidence: script wiring, validator outcomes, and operational sign-off checklist. |
| [phase4-implementation-summary.md](./phase4-implementation-summary.md) | Summary of phase 4 implementation work. |
| [phase4-edge-case-validation.md](./phase4-edge-case-validation.md) | Edge-case validation for phase 4. |
| [Deterministic-Turn-Epoch-Isolation.md](./Deterministic-Turn-Epoch-Isolation.md) | Deterministic turn and epoch isolation design. |
| [persona-bot-creation-runbook.md](./persona-bot-creation-runbook.md) | Reusable process for creating prompt-only personas and action workflow bots through chat. |
| [workflow-operations-runbook.md](./workflow-operations-runbook.md) | Operator readiness, inspection, requeue, dead-letter triage, rollback, and rollout gates for durable workflow actions. |
| [workflow-onboarding-kit.md](./workflow-onboarding-kit.md) | Contract checklist for adding reusable workflow actions with manifest metadata, validations, telemetry, runbooks, and rollout gates. |
| [env-contract-split.md](./env-contract-split.md) | Phased plan and validator behavior for splitting the oversized environment contract into core, feature/plugin, and persona surfaces. |
| [reusable-workflow-batch-validation.md](./reusable-workflow-batch-validation.md) | Grounded validation of the first reusable-workflow implementation batch and code-based evidence for the next outbox/action-guard batch. |
| [dealer-order-persona.md](./dealer-order-persona.md) | Dealer order persona setup: call payload, CRM context, ERP submission, notifications, retries, and fallback SMS. |

---

## Database & migration

| Document | Description |
|----------|-------------|
| [db-migration-map.json](./db-migration-map.json) | Migration map from Sequelize/sqlite to mysql2: Sequelize imports, query locations, models, conversation writes, call-end hooks, and DB config. |
| [manual-migration-runbook.md](./manual-migration-runbook.md) | Manual MySQL migration procedure for `migrations/001_call_sessions.sql` through `migrations/014_call_workflow_state_events.sql`. |
| [sqlite3-database-analysis.json](./sqlite3-database-analysis.json) | Analysis of sqlite3/Sequelize usage: packages, connection, consumers, tables, and conclusions (pre–mysql2 migration). |

---

## Related

- **Authoritative rules:** `.cursor/rules/voice-platform-non-negotiable.mdc`
- **Entry point:** `app.js` (WebSocket handlers, write queue, server bootstrap)
- **Database:** MySQL via `services/db.js` and `repositories/` (CallRepository, UserRepository, ConversationRepository)
- **Migrations:** `migrations/001_call_sessions.sql` through `migrations/014_call_workflow_state_events.sql`
