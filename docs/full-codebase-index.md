# Full Codebase Index

This document is a repository-wide index of the VoiceBot workspace. It is broader than the runtime-only index and includes active code, support code, tests, CI drift checks, assets, and planning artifacts.

## Scope

Included:

- all top-level workspace folders except `node_modules/`
- root entry files and governance files
- executable code, support infrastructure, tests, CI scripts, assets, and documentation

Excluded:

- third-party dependencies under `node_modules/`

## Root files

| File | Type | Notes |
|------|------|-------|
| `app.js` | executable | Main process entry point and server bootstrap. |
| `package.json` | config | Declares runtime entry, scripts, and dependencies. |
| `package-lock.json` | lockfile | Dependency lockfile; baseline docs say not to regenerate casually. |
| `.env` | local config | Environment-specific runtime configuration. |
| `.env.example` | template | Example environment configuration. |
| `.gitignore` | config | Git ignore rules. |
| `BASELINE.md` | governance | Baseline declaration for architectural change control. |
| `Overall Plan.md` | planning | High-level roadmap and execution planning. |
| `cursor-rules.md` | governance | Workspace rules and constraints. |
| `cursor-rules.docx` | document | Alternate document form of rules. |
| `voicebot-out 15.log` | artifact | Runtime log artifact present in workspace. |

## Top-level directory index

| Directory | Classification | Purpose | Key files |
|-----------|----------------|---------|-----------|
| `.claude/` | support | Local tool or assistant settings | `settings.local.json` |
| `Controller/` | active runtime | HTTP controller layer | `MainController.js` |
| `Helper/` | active runtime | Cross-cutting business helpers, prompt logic, classification, persistence bridge | `Helpers.js`, `callClassifier.js`, `hangupDecision.js`, `hallucinationGuard.js` |
| `Html/` | support/runtime-adjacent | Static demo or operator-facing pages | `EnglishBot.html`, `GermanBot.html`, `MiamiEnglishBot.html`, `conversation.html` |
| `Knowledge-base/` | active runtime | In-repo KB implementations used by persona language configs | `Knowledge-base-english.js`, `Knowledge-base-german.js` |
| `Music/` | active runtime asset | Telephony audio assets | `error.mulaw`, `hold.mulaw`, `micro-ack.mulaw` |
| `Noise-Reducer/` | active runtime | Audio denoise integration | `noise-reducer.js` |
| `Routes/` | active runtime | Express route declarations | `Routes.js` |
| `Utils/` | active runtime/support | Shared infrastructure utilities for telemetry, logging, guards, rate limiting, phone parsing | `logger.js`, `telemetry.js`, `turnGuard.js`, `rateLimiter.js` |
| `adapters/` | active runtime | Telecom and telemetry boundary layer | `telecom/`, `telemetry/` |
| `ci/` | validation | Drift checks, contracts, and synthetic validation tooling | `contracts/`, `scripts/` |
| `config/` | active runtime plus dormant flags | Latency, runtime tuning, Phase 4 feature flags, tiered latency config | `latencyResponsivenessConfig.js`, `phase4Config.js` |
| `docs/` | documentation | Architecture, validation, audits, analysis, specifications | multiple markdown and JSON docs |
| `libs/` | active runtime asset | RNNoise runtime binaries and bindings | `rnnoise.js`, `rnnoise.wasm` |
| `logic/` | mixed | Live escalation logic plus dormant Phase 4 orchestration | `escalationEngine.js`, `intentGate.js`, `phase4Pipeline.js` |
| `migrations/` | support | Database schema migrations | `001_call_sessions.sql`, `002_legacy_tables.sql` |
| `observability/` | mixed | Phase 4 metrics; only partially live | `phase4Metrics.js` |
| `persona/` | likely dormant | Style-engine layer used by Phase 4 pipeline | `styleEngine.js`, `styleProfiles.js` |
| `personas/` | active runtime | Persona registry and persona definitions | `registry.js`, `company-sales.js`, `exed-webinar.js` |
| `plans/` | planning | Refactor plans | `app-refactoring-plan.md` |
| `policy/` | active runtime | Interaction policy, degradation, ambiguity scoring, helper policy utilities | `callInteractionPolicy.js`, `degradationStateEngine.js` |
| `profiles/` | likely dormant | Conversation profiles for Phase 4 | `conversationProfiles.js` |
| `rag/` | likely dormant | RAG guardrails, numeric enforcement, synthesis scoring | `ragGuardrails.js`, `numericEnforcement.js` |
| `repositories/` | active runtime | DB persistence layer | `CallRepository.js`, `ConversationRepository.js`, `UserRepository.js` |
| `services/` | mixed | Active infrastructure plus dormant advanced retrieval and RAG pipeline experiments | `CallRegistry.js`, `writeQueue.js`, `tieredRAGPipeline.js` |
| `services-plivo/` | active runtime | Plivo-specific media and Azure realtime client layer | `realtimeServicePlivo.js`, `stream-service-plivo.js` |
| `services-twilio/` | active runtime | Twilio-specific media and Azure realtime client layer | `realtimeServiceTwilio.js`, `stream-service-twilio.js` |
| `session/` | active runtime | Shared call-session orchestrator | `createCallSession.js` |
| `tests/` | validation | Standalone node-based behavioral test scripts | `callClassifier.test.js`, `callPipeline.test.js`, `conversationPhase.test.js` |
| `transactions/` | likely dormant | Transaction policy layer for Phase 4 | `transactionPolicy.js` |

## Active runtime surface

These folders and files are on the current live execution path.

### Bootstrap and request path

- `app.js`
- `Routes/Routes.js`
- `Controller/MainController.js`

### Session and telecom runtime

- `session/createCallSession.js`
- `adapters/telecom/TwilioProvider.js`
- `adapters/telecom/PlivoProvider.js`
- `services-twilio/realtimeServiceTwilio.js`
- `services-twilio/stream-service-twilio.js`
- `services-plivo/realtimeServicePlivo.js`
- `services-plivo/stream-service-plivo.js`

### Active support layers used by runtime

- `Helper/`
- `Utils/`
- `services/CallRegistry.js`
- `services/writeQueue.js`
- `services/db.js`
- `repositories/`
- `Knowledge-base/`
- `personas/`
- `Noise-Reducer/`
- `libs/`
- `policy/`
- `config/latencyResponsivenessConfig.js`
- `config/latencyResponsivenessRuntime.js`
- `logic/escalationEngine.js`

## Likely dormant or partially wired surface

These modules are implemented and internally coherent, but they do not appear to sit on the live runtime import path.

### Phase 4 cluster

- `logic/phase4Pipeline.js`
- `logic/intentGate.js`
- `rag/`
- `persona/`
- `profiles/conversationProfiles.js`
- `transactions/transactionPolicy.js`
- `config/phase4Config.js`

### Tiered retrieval cluster

- `services/tieredRAGPipeline.js`
- `services/hybridRetriever.js`
- `services/queryComplexityDetector.js`
- `services/multiIntentDetector.js`
- `services/ambiguityResolver.js`
- `config/tieredLatencyConfig.js`

### Explicitly legacy or excluded

- `personas/_company-sales-v1.js`
- `Helper/languageModel.js`

## Test and validation surface

| Area | Contents | Notes |
|------|----------|-------|
| `tests/` | 3 standalone Node test scripts | Focused on classifier logic, conversation phase transitions, and simulated pipeline behavior. |
| `ci/contracts/` | 3 contract files | Encodes drift and policy expectations for CI tooling. |
| `ci/scripts/` | 30+ analysis scripts | Static checks, simulation harnesses, telemetry diagnostics, and behavior drift detection. |

## Documentation surface

The `docs/` folder contains:

- platform analysis and architecture audits,
- implementation plans and validation summaries,
- rate-limit and telemetry diagnostics,
- formal specs for unlock, degradation, and latency responsiveness,
- current indexes added during this repository analysis.

## Best starting points by task

| Task | Start here |
|------|------------|
| Understand live runtime | `docs/codebase-index.md`, then `app.js` |
| Trace dependencies | `docs/runtime-dependency-map.md` |
| Review operational risks | `docs/runtime-risk-review.md` |
| Understand whole repository | `docs/full-codebase-analysis.md` |
| Add or inspect personas | `personas/registry.js`, then persona files |
| Review DB persistence | `repositories/`, `services/db.js`, `migrations/` |
| Review CI policy enforcement | `ci/contracts/`, then `ci/scripts/` |