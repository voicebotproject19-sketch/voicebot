# Codebase Index

This document is a navigation map for the current VoiceBot runtime. It complements the broader analysis documents in this folder by focusing on where the live system is wired today.

## System summary

VoiceBot is a Node.js voice-agent platform that:

- accepts outbound call requests over HTTP,
- routes calls to Twilio or Plivo,
- bridges provider media streams to Azure OpenAI Realtime over WebSockets,
- applies policy, degradation, escalation, latency, and phase logic per call,
- persists call and conversation data to MySQL,
- exposes persona-driven multilingual behavior from the personas registry.

## Runtime entry points

| Area | File | Responsibility |
|------|------|----------------|
| Process entry | `app.js` | Boots Express, registers HTTP routes, opens provider WebSocket endpoints, starts write queue and server lifecycle hooks. |
| HTTP routes | `Routes/Routes.js` | Declares API, webhook, HTML, health, and data routes. |
| Controller | `Controller/MainController.js` | Validates outbound call requests, resolves persona and language, selects provider, handles inbound webhook XML, and exposes persona/config/data endpoints. |
| Per-call session | `session/createCallSession.js` | Shared call-session factory for Twilio and Plivo. Owns turn state, media pipeline, policy gating, escalation hooks, and session event orchestration. |
| Realtime AI | `services-twilio/realtimeServiceTwilio.js`, `services-plivo/realtimeServicePlivo.js` | Azure Realtime clients: session configuration, transcript events, response lifecycle, reconnection, greeting flow, and prompt updates. |
| Media egress | `services-twilio/stream-service-twilio.js`, `services-plivo/stream-service-plivo.js` | Provider-specific media output and wire-format handling. |

## Request and call flow

### 1. Outbound call creation

1. `POST /api/call` enters `MainController.call`.
2. Persona and language are resolved through `personas/registry.js`.
3. Provider is selected by E.164 country code: India goes to Plivo, all others to Twilio.
4. The selected provider adapter creates the call and seeds `CallRegistry` and the write queue.

### 2. Provider connects media stream

1. Twilio and Plivo hit `incoming_twilio` or `incoming_plivo`.
2. Controller returns provider-specific XML that points the call to `/connection_twilio` or `/connection_plivo`.
3. `app.js` binds both endpoints to the same session factory, injecting the provider adapter and the provider-specific stream and realtime service classes.

### 3. Shared call session runs

1. `createCallSession` creates `edgeSession`, `turnState`, `callContextState`, and phase/latency state.
2. Provider settings define gate thresholds, audio buffering strategy, listener timing, and pre-connect buffering behavior.
3. Inbound media is denoised through `Noise-Reducer/noise-reducer.js`, converted as needed, and sent to the Azure realtime service.
4. User transcripts and bot responses drive policy checks, escalation decisions, latency compensation, micro-ack behavior, and hangup or handover signals.

### 4. Persistence and shutdown

1. `services/writeQueue` serializes DB writes.
2. `repositories/CallRepository.js` persists call session start and end data.
3. Conversation writes and user records are handled from helper and repository layers.
4. On process shutdown, `app.js` drains the queue, closes the DB pool, and flushes logs.

## Subsystem map

| Folder | Purpose |
|--------|---------|
| `adapters/telecom/` | Provider abstraction for Twilio and Plivo. Contains provider contract, SDK clients, and provider-specific call/hangup/transfer behavior. |
| `adapters/telemetry/` | Telemetry adapter integration, including Azure monitoring bridge. |
| `session/` | Shared WebSocket call-session orchestration. |
| `services-twilio/`, `services-plivo/` | Provider-specific realtime client and media stream adapters. |
| `policy/` | Interaction policy, degradation state engine, ambiguity scoring, and app-level policy helpers. |
| `logic/` | Phase 4 orchestration, escalation engine, and intent gating. |
| `config/` | Feature flags, latency responsiveness settings, and runtime helpers. |
| `personas/` | Persona registry and persona definitions. New persona files are auto-loaded from this directory. |
| `persona/` | Persona style application and style profiles used during response shaping. |
| `Knowledge-base/` | In-repo knowledge base implementations referenced by persona language configs. |
| `rag/` | Retrieval guardrails, numeric enforcement, and synthesis scoring. |
| `profiles/` | Conversation profiles used by Phase 4 policy and scoring logic. |
| `transactions/` | Transaction policy checks and transaction-specific constraints. |
| `Helper/` | Cross-cutting helpers for audio conversion, classification, summarization, tone mapping, email handover, hangup analysis, and utility behaviors. |
| `repositories/` | Database-facing persistence layer on top of `services/db.js`. |
| `services/` | Infrastructure services such as DB pool, write queue, and in-memory call registry. |
| `observability/` | Metrics and instrumentation helpers, especially Phase 4 metrics. |
| `Noise-Reducer/`, `libs/` | RNNoise-backed denoising and lower-level audio support. |
| `Html/` | Static HTML clients or demo pages. |
| `docs/` | Specifications, audits, validation notes, and analysis documents. |
| `tests/` | Automated test coverage. |

## Core state owners

| State | Owner |
|------|-------|
| Active call metadata | `services/CallRegistry` |
| Per-WebSocket turn and media state | `session/createCallSession.js` |
| Realtime conversation context and response lifecycle | `services-twilio/realtimeServiceTwilio.js`, `services-plivo/realtimeServicePlivo.js` |
| Policy mode and guarded-speech eligibility | `policy/callInteractionPolicy.js` and helpers in `policy/` |
| Degradation and unlock scoring | `policy/degradationStateEngine.js`, `policy/ambiguityScoringEngine.js` |
| Phase 4 orchestration | `logic/phase4Pipeline.js` |
| Persistent call records | `repositories/CallRepository.js` via `services/db.js` |
| Persona and language definitions | `personas/registry.js` and files in `personas/` |

## External integrations

| Integration | Files |
|------------|-------|
| Twilio | `adapters/telecom/TwilioProvider.js`, `adapters/telecom/twilioClient.js` |
| Plivo | `adapters/telecom/PlivoProvider.js`, `adapters/telecom/plivoClient.js` |
| Azure OpenAI Realtime | `services-twilio/realtimeServiceTwilio.js`, `services-plivo/realtimeServicePlivo.js` |
| OpenAI SDK | helper modules such as `Helper/hangupDecision.js` |
| MySQL | `services/db.js`, `repositories/` |
| Azure Monitor / OpenTelemetry | `adapters/telemetry/azureTelemetryAdapter.js`, `Utils/telemetry.js`, `Utils/logger.js` |
| SMTP email handover | `Helper/emailHelper.js` |

## Recommended reading order

1. `app.js`
2. `Routes/Routes.js`
3. `Controller/MainController.js`
4. `session/createCallSession.js`
5. `adapters/telecom/TwilioProvider.js` and `adapters/telecom/PlivoProvider.js`
6. `services-twilio/realtimeServiceTwilio.js` and `services-plivo/realtimeServicePlivo.js`
7. `policy/callInteractionPolicy.js`, `policy/degradationStateEngine.js`, `policy/ambiguityScoringEngine.js`
8. `logic/phase4Pipeline.js`
9. `personas/registry.js` and the active persona files
10. `services/db.js` and `repositories/`

## Related documents

- `docs/voice-platform-analysis.md` for broader system analysis.
- `docs/structural-architecture-audit.md` for architecture and refactor risk framing.
- `docs/phase4-implementation-summary.md` for the reliability and guardrail layer.
- `docs/latency-responsiveness-conversational-quality.md` for latency and micro-ack behavior.