# VoiceBot Structural Enforcement Audit — Results

> Historical snapshot
>
> This document captures a topology audit from an earlier repository layout. Use `docs/codebase-index.md`, `docs/runtime-dependency-map.md`, and `docs/full-codebase-index.md` for current ownership and navigation.

**Audit type:** Topology extraction (no code review, no refactor, no suggestions).  
**Date:** 2025-02-24.

---

## 1️⃣ PROJECT STRUCTURE MAP

### Full folder tree (top 3 levels only)

```
.
./.cursor
./.cursor/rules
./Controller
./Helper
./Html
./Knowledge-base
./Models
./Music
./Noise-Reducer
./Routes
./Sequelize
./config
./docs
./libs
./logic
./observability
./persona
./policy
./profiles
./rag
./services-plivo
./services-twilio
./transactions
```

### Files by category

| Category | File(s) |
|----------|---------|
| **WebSocket server setup** | `app.js` (ExpressWs, `app.ws('/connection_twilio')`, `app.ws('/connection_plivo')`); `services-twilio/realtimeServiceTwilio.js` (client `new WebSocket`); `services-plivo/realtimeServicePlivo.js` (client `new WebSocket`); `services-twilio/stream-service-twilio.js` (uses `this.ws.send`); `services-plivo/stream-service-plivo.js` (uses `this.ws.send`) |
| **Telephony event listeners** | `Controller/MainController.js` (incoming_twilio, incoming_plivo); `Routes/Routes.js` (POST /incoming-twilio, /incoming-plivo, /twilio-status); `app.js` (ws handlers for Twilio/Plivo media streams, disconnect/hangup); `Helper/Helpers.js` (createCallTwilio, createCallPlivo, disconnetTwilioCall, disconnetPlivoCall); `Helper/PlivoStatusHandler.js` (plivoStatus); `services-twilio/realtimeServiceTwilio.js`, `services-plivo/realtimeServicePlivo.js` (hangup/silence_hangup emit); `Helper/hangupDecision.js` (analyzeConversationForHangup) |
| **Adapter classes** | `services-twilio/realtimeServiceTwilio.js` (RealtimeServiceTwilio); `services-plivo/realtimeServicePlivo.js` (RealtimeServicePlivo); `services-twilio/stream-service-twilio.js` (StreamServiceTwilio); `services-plivo/stream-service-plivo.js` (StreamServicePlivo). `config/latencyResponsivenessRuntime.js` mentions "adapter" in comment only. |
| **Unlock logic** | `app.js` (getUnlockDecision, transitionMode, clarification flow); `policy/ambiguityScoringEngine.js` (getUnlockDecision, computeAmbiguityScore, DEGRADATION_MULTIPLIER) |
| **Degradation logic** | `app.js` (createDegradationStateEngine, updateDegradationState, getCurrentState, getStabilityMetrics, resetState); `policy/degradationStateEngine.js` (createDegradationStateEngine, DEGRADATION_STATE, updateDegradationState); `policy/ambiguityScoringEngine.js` (degradationMultiplier, DEGRADATION_MULTIPLIER) |
| **Turn state** | `app.js` (turnState, newTurn, currentTurnId); `services-twilio/stream-service-twilio.js` (turnStateRef, currentTurnId, isClosed); `services-plivo/stream-service-plivo.js` (turnStateRef, currentTurnId, isClosed); `services-twilio/realtimeServiceTwilio.js` (turnStateRef, currentTurnId); `services-plivo/realtimeServicePlivo.js` (turnStateRef, currentTurnId); `config/latencyResponsivenessRuntime.js` (mayEmitMicroAckNow currentTurnId/turnIdAtEmit); `policy/callInteractionPolicy.js` (turnId, currentTurnId in evaluateSpeechPermission); `config/latencyResponsivenessConfig.js` (comment turnId) |
| **Latency instrumentation** | `app.js` (phase3State.latencyState, logLatencyOverruns, speechEndTs, responseStartTs, firstAudioFrameTs); `config/latencyResponsivenessConfig.js` (LATENCY_BUDGET, PHASE3_* env); `config/latencyResponsivenessRuntime.js` (logLatencyOverruns, splitAudioForPacing, getPauseMs) |

---

## 2️⃣ ENTRY POINTS

| File | Function / Route | Async | Initializes session state |
|------|------------------|-------|---------------------------|
| **app.js** | (server start) | — | — |
| **app.js** | `startServer` | Yes | No (starts Express + db.sync) |
| **app.js** | `app.ws('/connection_twilio', (ws) => { ... })` | No (callback) | Yes: edgeSession, turnState, callContextState, phase3State, streamService, realtimeService, listeners |
| **app.js** | `app.ws('/connection_plivo', (ws) => { ... })` | No (callback) | Yes: edgeSession, turnState, callContextStatePlivo, phase3StatePlivo, streamService, realtimeService, listeners |
| **app.js** | `ws.on('message', async function message(data) { ... })` (Twilio) | Yes | No (uses existing session) |
| **app.js** | `ws.on('message', async function message(data) { ... })` (Plivo) | Yes | No (uses existing session) |
| **Routes/Routes.js** | `Router.post('/api/call', MainController.call)` | Handler async | No |
| **Routes/Routes.js** | `Router.post('/incoming-twilio', MainController.incoming_twilio)` | Handler async | No (returns TwiML/HTML) |
| **Routes/Routes.js** | `Router.post('/incoming-plivo', MainController.incoming_plivo)` | Handler async | No (plivoStatus or stream XML) |
| **Routes/Routes.js** | `Router.post('/twilio-status', MainController.twilioStatus)` | Handler async | No |
| **Routes/Routes.js** | `Router.get('/health', MainController.health)` | Handler async | No |
| **Routes/Routes.js** | `Router.get('/english/Call', ...)`, `/german/Call`, `/miami-english/Call`, `/conversations`, `/users`, `/user/conversations` | Handler async | No |
| **Controller/MainController.js** | `incoming_twilio` | Yes | No |
| **Controller/MainController.js** | `incoming_plivo` | Yes | No (delegates to plivoStatus or returns XML) |
| **Controller/MainController.js** | `call` | Yes | No (creates call via Helpers) |
| **Controller/MainController.js** | `twilioStatus`, `health`, `serve*`, `getUsers`, `getConversations` | Yes | No |

**Connection/session creation:**

- **app.js** `app.ws('/connection_twilio', ...)`: creates `edgeSession`, `turnState`, `callContextState`, `phase3State`, `streamService`, `realtimeService`; assigns `edgeSession.connectionId` (uuidv4).
- **app.js** `app.ws('/connection_plivo', ...)`: same for Plivo path (separate `callContextStatePlivo`, `phase3StatePlivo`).
- **Helper/Helpers.js**: `activeCalls[sid]` / `activeCallsPlivo[uuid]` populated by `createCallTwilio` / `createCallPlivo` when a call is initiated; session state for a given call is then created when the WebSocket connects in app.js and looks up `activeCalls[callSID]` / `activeCallsPlivo[callSID]`.

---

## 3️⃣ TURN STATE MUTATION MAP

| File | Line(s) | Type | Notes |
|------|---------|------|--------|
| **app.js** | 10, 225, 747 | — | `require('uuid')` / `uuidv4` import (not mutation) |
| **app.js** | 241, 252 | Creation | `edgeSession.currentTurnId: null`, `turnState = { currentTurnId: null, isClosed: false }` |
| **app.js** | 253–256 | Creation | `function newTurn()`: `turnState.currentTurnId = uuidv4()`, `edgeSession.currentTurnId = turnState.currentTurnId` |
| **app.js** | 393, 396, 437 | Mutation | `newTurn()` called (response.created, start, interruption) |
| **app.js** | 414–420, 458–460, 527–528, 542–544, 562–565, 570, 574–575, 580–583, 595–597, 608–611, 616–617, 642–643, 669–670, 688–690, 699–701 | Comparison | Reads `turnState.currentTurnId`, `edgeSession.currentTurnId`; guards with `scheduledTurn !== turnState.currentTurnId`, `myTurn !== turnState.currentTurnId` |
| **app.js** | 470 | Mutation | `phase3State.prewarmState.turnId = edgeSession.currentTurnId` |
| **app.js** | 545 | Creation | `const hangupTurnId = newTurn()` (silence_hangup) |
| **app.js** | 707–708, 711 | Invalidation | `turnState.isClosed = true`, `turnState.currentTurnId = null`, `edgeSession.currentTurnId = null` (ws close) |
| **app.js** | 772–776 | Creation | Plivo: same `turnState` / `newTurn()` pattern |
| **app.js** | 858, 882, 922 | Mutation | Plivo: `newTurn()` |
| **app.js** | 900–906, 941–943, 953, 1010–1011, 1036–1039, 1044, 1048–1049, 1054–1057, 1069–1071, 1077–1080, 1086, 1111–1112, 1138–1139, 1157–1158 | Comparison / Mutation | Plivo: same turn checks and prewarmState.turnId |
| **app.js** | 1197–1198 | Invalidation | Plivo close: degradationEngine.resetState(); turnState invalidation in same ws.on('close') block (not re-listed) |
| **Controller/MainController.js** | 1 | — | `uuidv4` import only |
| **config/latencyResponsivenessRuntime.js** | 106, 109 | Comparison | `mayEmitMicroAckNow(..., currentTurnId, turnIdAtEmit)`, `currentTurnId !== turnIdAtEmit` |
| **policy/callInteractionPolicy.js** | 75–76, 85–86, 108 | Comparison | `turnId`, `currentTurnId` in params and `turnId === currentTurnId` |
| **services-twilio/stream-service-twilio.js** | 7, 10 | — | Constructor: `turnStateRef` |
| **services-twilio/stream-service-twilio.js** | 86, 99, 114–119, 144–148, 157–158, 165, 177, 222 | Comparison | `turnStateRef.isClosed`, `turnStateRef.currentTurnId`, `scheduledTurn !== this.turnStateRef.currentTurnId` |
| **services-twilio/realtimeServiceTwilio.js** | 44, 47, 49 | — | `turnStateRef = null` / passed in `initialize` |
| **services-twilio/realtimeServiceTwilio.js** | 161–166, 175–180, 237–242, 301–304, 323–326, 334–337, 351–354, 365–369, 381–384 | Comparison | Reads `this.turnStateRef.currentTurnId`, `scheduledTurn !== this.turnStateRef.currentTurnId`, `myTurn !== this.turnStateRef.currentTurnId` |
| **services-plivo/stream-service-plivo.js** | 7, 10, 84, 99, 112–117, 148–152, 161–162, 169, 182, 227 | Same pattern as stream-service-twilio | Comparison / isClosed |
| **services-plivo/realtimeServicePlivo.js** | 35, 38, 44 | — | turnStateRef init |
| **services-plivo/realtimeServicePlivo.js** | 143–146, 162–165, 173–176, 189–192, 200–204, 214–217 | Comparison | Same as Twilio realtime |

**Turn contract surface:** Creation in app.js only via `newTurn()` (uuidv4). Mutation: `turnState.currentTurnId`, `edgeSession.currentTurnId`; invalidation on `ws.on('close')`. All other references are comparison or read.

---

## 4️⃣ HOT PATH HANDLERS

| Handler | File | Async | Await inside | Functions called inside (selected) |
|---------|------|-------|---------------|------------------------------------|
| **user_transcript** | app.js (Twilio ~457, Plivo ~940) | No (Twilio), No (Plivo) | No | isValidHumanTranscript, transitionMode, clearPhase3Timers, streamService.stopCurrentAudio, realtimeService.cancelResponse, callContextState.degradationEngine.updateDegradationState, getCurrentState, getStabilityMetrics, computeAmbiguityScore, getUnlockDecision, evaluateSpeechPermission, realtimeService.sendTextResponse |
| **audio** | app.js 594, 1068 | Yes | No | evaluateSpeechPermission, logLatencyOverruns, splitAudioForPacing, getPauseMs, streamService.sendAudioDirect, assertInteractiveBeforeNonGuardedSend |
| **response.created** | app.js 395, 881 | No | No | newTurn, clearPhase3Timers / clearPhase3TimersPlivo, transitionMode (indirect via setTimeout) |
| **interruption** | app.js 436, 921 | No | No | newTurn, transitionMode, clearPhase3Timers, streamService.stopCurrentAudio, realtimeService.cancelResponse |
| **decision** | app.js 687, 1156 | No | No | edgeSession.emitSignal('signal_should_hangup', ...) |
| **silence_hangup** | app.js 541 | No | No | newTurn, edgeSession.emitSignal('signal_silence_hangup', hangupTurnId) |
| **audio_done** | app.js 698, 1166 | Yes | No | (none beyond turn guard and logging) |

**Emitter side (adapter):**

- **user_transcript**: `services-twilio/realtimeServiceTwilio.js` ~314 (`this.emit('user_transcript', userText, { confidence })`); `services-plivo/realtimeServicePlivo.js` ~156.
- **audio**: `realtimeServiceTwilio.js` ~342; `realtimeServicePlivo.js` ~180.
- **response.created**: `realtimeServiceTwilio.js` 322–329; `realtimeServicePlivo.js` 161–168.
- **interruption**: `realtimeServiceTwilio.js` ~290; `realtimeServicePlivo.js` ~134; stream-service-* (interrupted flag / stop).
- **decision**: `realtimeServiceTwilio.js` ~373; `realtimeServicePlivo.js` ~208.
- **silence_hangup**: `realtimeServiceTwilio.js` ~244.
- **audio_done**: `realtimeServiceTwilio.js` 380–386; `realtimeServicePlivo.js` 213–219.

---

## 5️⃣ ASYNC GRAPH SURFACE

### Async functions

| File | Function / location | Called from hot path |
|------|---------------------|-----------------------|
| app.js | `ws.on('message', async function message(data)'` (Twilio) | Yes (WS message = hot path) |
| app.js | `ws.on('message', async function message(data)'` (Plivo) | Yes |
| app.js | `realtimeService.on('audio', async (audioBuffer) => ...)` | Yes |
| app.js | `realtimeService.on('audio_done', async (data) => ...)` | Yes |
| app.js | `initializeDenoiser` | No |
| app.js | `killProcessOnPort` | No |
| app.js | `startServer` | No (entry) |
| Controller/MainController.js | `incoming_twilio`, `incoming_plivo`, `call`, `twilioStatus`, `health`, `serve*`, `getUsers`, `getConversations` | No (HTTP) |
| Helper/Helpers.js | `createCallTwilio`, `createCallPlivo`, `createUser`, `insertConversation`, `disconnetTwilioCall`, `disconnetPlivoCall` | No |
| Helper/hangupDecision.js | `analyzeConversationForHangup` | Yes (from realtime adapter decision path) |
| Helper/PlivoStatusHandler.js | `plivoStatus` | No |
| services-twilio/realtimeServiceTwilio.js | `initialize` | Yes (from app.js WS path) |
| services-plivo/realtimeServicePlivo.js | `initialize` | Yes |
| services-twilio/stream-service-twilio.js | (none async) | — |
| services-plivo/stream-service-plivo.js | `loadHoldMusic` (await used) | Not from app.js hot path (used in stream service) |
| Noise-Reducer/noise-reducer.js | (class methods using await) | Yes if denoiser used in WS path |

### Functions returning Promise

- `libs/rnnoise.js`: `.then(...)` chains (no async keyword).
- `Helper/Helpers.js`: async functions return Promises.
- Others: as above (async functions).

### Await expressions

| File | Line (approx) | Context |
|------|----------------|--------|
| app.js | 364, 366, 374 | Twilio WS: denoiser.initialize(), realtimeService.initialize(), processChunk |
| app.js | 860, 862, 870 | Plivo WS: same |
| app.js | 1213, 1227, 1235, 1245, 1250, 1266, 1269, 1273 | initializeDenoiser, killProcessOnPort, startServer |
| Helper/hangupDecision.js | 51 | azureOpenAI.chat.completions.create |
| Helper/Helpers.js | 54, 95, 142, 164, 204 | createCall*, insertConversation, disconnetPlivoCall |
| Controller/MainController.js | 59, 76, 122, 139 | createCallPlivo, createCallTwilio, db.query |
| services-twilio/realtimeServiceTwilio.js | 366 | analyzeConversationForHangup |
| services-plivo/realtimeServicePlivo.js | 201 | analyzeConversationForHangup |
| services-twilio/stream-service-twilio.js | 234 | loadHoldMusic |
| services-plivo/stream-service-plivo.js | 238 | loadHoldMusic |
| Noise-Reducer/noise-reducer.js | 18, 38, 55 | loadModule, import, convertUlawToPcm |

---

## 6️⃣ THRESHOLD & CONSTANT SURFACE

### app.js

- `MAX_CLARIFICATIONS = 2`
- `PHASE2_5_2_UNLOCK_DEBUG` (env)
- `NON_INTERACTIVE_GRACE_MS`: 8000 (OS_SCREENING), 6000 (VOICEMAIL) or `policyConfig?.nonInteractiveDelayMs`
- Sample rate 8000, duration calc constants (e.g. length + 15, durationMs = buffer.length/8)
- Audio timer 20 ms

### config/latencyResponsivenessConfig.js

- `PHASE3_ENABLED`, `PHASE3_DEBUG` (env)
- `LATENCY_BUDGET`: speechEndToResponseMs (300), responseToFirstAudioMs (300), totalMs (600), logOverruns
- `PREWARM.enabled`
- `PACING`: chunkDurationMs (4000), pauseMinMs (50), pauseMaxMs (150), maxTotalDelayMs (400)
- `MICRO_ACK`: confidenceThreshold (0.8), continuousSpeechMinMs (900), continuousSpeechMaxMs (1800), noPauseMinMs (180), neutralAudioPath

### config/latencyResponsivenessRuntime.js

- bytesPerMs = 8 (8kHz mulaw)
- Neutral clip max 300 ms (comment / validation)
- No numeric constants beyond PACING/MICRO_ACK from config

### policy/ambiguityScoringEngine.js

- WEIGHTS: CONFIDENCE 0.35, ALIGNMENT 0.25, TIMING 0.15, STABILITY 0.10, ENERGY 0.10, DEGRADATION 0.05
- DEGRADATION_MULTIPLIER: NORMAL 1, DEGRADED 0.6, SEVERE 0.2
- confidenceScore: (confidence - 0.65) / 0.35
- timingScore: 300–2000 ms = 1, 2000–3500 ms = 0.5
- stabilityScore: variance ≤0.15 → 1, ≤0.20 → 0.5
- getUnlockDecision: SEVERE → clarify/ignore; DEGRADED/NORMAL thresholds (e.g. conf ≥ 0.85 and score ≥ 90 → unlock; score ≥ 75, ≥ 65 → unlock)

### policy/degradationStateEngine.js

- `CONFIDENCE_HISTORY_SIZE = 5`
- `TRANSCRIPT_HISTORY_SIZE = 3`
- `TRUNCATED_WINDOW_MS = 3000`
- `STABLE_CONSECUTIVE_FOR_RESET = 5`
- State thresholds: avg ≥ 0.78, varVal ≤ 0.15 (stable); emptyTranscriptCount ≥ 2, packetLoss > 0.25, avg < 0.68, varVal > 0.30 (SEVERE); avg < 0.75, varVal > 0.20, etc. (DEGRADED)

### policy/callInteractionPolicy.js

- InteractionMode, ContextHint, MESSAGE_TYPE enums
- ISD_DEFAULT_LANGUAGE map
- getDefaultPolicyConfig (voicemail/screening enabled: false, fallbackLanguage: 'en')

### config/phase4Config.js

- `PHASE4_ENABLED`, `PHASE4_PROFILE_NAME` (env, default 'balanced')

### observability/phase4Metrics.js

- `MAX_SCORE_SAMPLES = 500`
- PHASE4_METRICS keys (rag_timeout_rate, synthesis_score_distribution, etc.)

### VAD

- `services-twilio/realtimeServiceTwilio.js` ~102: `type: 'server_vad'`
- `services-plivo/realtimeServicePlivo.js` ~94: `type: 'server_vad'`

---

## 7️⃣ VENDOR SURFACE MAP

| File | Vendor reference | Inside adapter layer? | Inside core orchestration? |
|------|------------------|------------------------|-----------------------------|
| Controller/MainController.js | plivo (require), Stream url connection_twilio, service_url connection_plivo | No (controller) | No |
| Helper/Helpers.js | twilio, plivo (client, create, hangup) | No (helper) | No |
| Helper/PlivoStatusHandler.js | (uses Helpers) | No | No |
| services-twilio/realtimeServiceTwilio.js | WebSocket (ws), Azure env (AZURE_REALTIME_*) | Yes (adapter) | No |
| services-twilio/stream-service-twilio.js | (EventEmitter, uuid, fs, path; Twilio media protocol) | Yes (adapter) | No |
| services-plivo/realtimeServicePlivo.js | WebSocket (ws), Azure env | Yes (adapter) | No |
| services-plivo/stream-service-plivo.js | (EventEmitter, uuid, fs, path; Plivo media) | Yes (adapter) | No |
| app.js | RealtimeServiceTwilio, StreamServiceTwilio, RealtimeServicePlivo, StreamServicePlivo (import only); no direct twilio/plivo SDK | No (orchestration uses adapters) | Yes (orchestration wires adapters) |

**SDK imports:** `twilio` and `plivo` in Helper/Helpers.js and Controller/MainController.js. `ws` (WebSocket) in services-twilio/realtimeServiceTwilio.js and services-plivo/realtimeServicePlivo.js. No other vendor SDK imports in the listed files.

---

## 8️⃣ CROSS-LAYER IMPORT MAP

### Import graph (high level)

- **app.js** → Routes, db, Models, Helper (audioCodec, Helpers), Noise-Reducer, policy (callInteractionPolicy, degradationStateEngine, ambiguityScoringEngine), config (latencyResponsivenessConfig, latencyResponsivenessRuntime), services-twilio (realtimeServiceTwilio, stream-service-twilio), services-plivo (realtimeServicePlivo, stream-service-plivo).
- **services-twilio/realtimeServiceTwilio.js** → dotenv, ws, events, Helper/hangupDecision, Helper/languageModel, Knowledge-base, Helper/Helpers.
- **services-plivo/realtimeServicePlivo.js** → same pattern.
- **services-*/stream-service-*.js** → events, uuid, fs, path (no policy/config/core).
- **policy/ambiguityScoringEngine.js** → policy/degradationStateEngine.
- **config/latencyResponsivenessRuntime.js** → config/latencyResponsivenessConfig.
- **logic/phase4Pipeline.js** → config/phase4Config, profiles, logic/intentGate, rag/*, logic/escalationEngine, transactions, persona/styleEngine.
- **persona/styleEngine.js** → observability/phase4Metrics, persona/styleProfiles, rag/numericEnforcement.
- **rag/ragGuardrails.js** → observability/phase4Metrics, rag/retrievalSanitation.
- **logic/intentGate.js** → profiles, observability/phase4Metrics.
- **transactions/transactionPolicy.js** → policy/callInteractionPolicy, observability/phase4Metrics.
- **Helper/hangupDecision.js** → dotenv, openai (Azure).

### Cross-boundary

- **Adapter → Core:** services-twilio/realtimeServiceTwilio and services-plivo/realtimeServicePlivo require Helper/hangupDecision, Helper/languageModel, Knowledge-base, Helper/Helpers. So adapters import Helpers, hangup (which uses OpenAI), and Knowledge-base (data). No direct adapter → policy or adapter → config in this codebase; app.js is the only file that imports both adapters and policy/config.
- **Core → Adapter:** app.js imports and instantiates RealtimeServiceTwilio, StreamServiceTwilio, RealtimeServicePlivo, StreamServicePlivo. No policy or config modules require services-*.
- **Unlock → Transport:** policy/ambiguityScoringEngine and policy/degradationStateEngine do not require app.js or any transport/WS. Unlock is used only from app.js (transport/orchestration).
- **Degradation → Transport:** policy/degradationStateEngine has no dependency on transport or app.

### Cyclic imports

- No cycles detected: policy and config do not require app or services-*; app requires policy and config; services-* require Helper/Knowledge-base but not app or policy.

---

## 9️⃣ GLOBAL STATE SURFACE

| Location | Kind | Details |
|----------|------|---------|
| **app.js** | process | `process.env.PORT`, `process.env.PHASE2_5_2_UNLOCK_DEBUG`; `process.platform`, `process.exit(1)` in startServer |
| **config/latencyResponsivenessConfig.js** | process | `process.env.PHASE3_*`, `process.cwd()` |
| **config/phase4Config.js** | process | `process.env.PHASE4_*` |
| **config/latencyResponsivenessRuntime.js** | module-level mutable | `_microAckDisabledByNeutralClip`, `_neutralValidationDone`, `_neutralAudioCache` (singleton cache for neutral audio) |
| **Helper/Helpers.js** | module-level mutable | `activeCalls = {}`, `activeCallsPlivo = {}` (singletons for call lookup) |
| **Helper/hangupDecision.js** | process | `process.env.Azure_openAi_key`, `process.env.Azure_openAi_endpoint` |
| **Helper/Helpers.js** | process | `process.env.TWILIO_*`, `process.env.PLIVO_*`, `process.env.NETWORK_URL` |
| **Sequelize/db.js** | process | `process.env.DB_*` |
| **services-*/realtimeService*.js** | process | `process.env.AZURE_REALTIME_*` |
| **observability/phase4Metrics.js** | module-level mutable | `PHASE4_METRICS` object (counters and synthesis_score_distribution array) |
| **libs/rnnoise.js** | process | `typeof process`, `process.versions.node` |

**global.**  
Not found.

---

## 🔟 HOT PATH LOGGING

Logging inside hot-path handlers (user_transcript, audio, response.created, interruption, decision, silence_hangup, audio_done) and in the WS message/close path in app.js:

| File | Line(s) | What |
|------|---------|------|
| app.js | 105 | `console.log` [ModeTransition] (transitionMode — used from user_transcript, interruption) |
| app.js | 226 | `console.log` WebSocket connection established (Twilio) |
| app.js | 269 | `console.log` [Degradation] (degradationEngine onStateTransition) |
| app.js | 328 | `console.log` New WebSocket connection |
| app.js | 341 | `console.log` Call started |
| app.js | 448 | `console.log` User interrupted - stopping audio (interruption) |
| app.js | 501 | `console.log` [Unlock] finalScore/state/decision (user_transcript, PHASE2_5_2_UNLOCK_DEBUG) |
| app.js | 517 | `console.log` [Unlock] Clarification trigger (user_transcript) |
| app.js | 546 | `console.log` Call ending due to silence (silence_hangup) |
| app.js | 601 | `console.error` AUDIO MISMATCH (audio handler) |
| app.js | 653 | `console.error` [Invariant] Non-guarded speech (audio path sendOne) |
| app.js | 691 | `console.log` Decision for callSID (decision) |
| app.js | 702 | `console.log` Full speech received for event (audio_done) |
| app.js | 709 | `console.log` Call ended (ws close) |
| app.js | 748 | `console.log` WebSocket connection established (Plivo) |
| app.js | 788 | `console.log` [Degradation] Plivo |
| app.js | 846 | `console.log` Call started (Plivo) |
| app.js | 877 | `console.error` Error parsing WebSocket message |
| app.js | 933 | `console.log` User interrupted (Plivo interruption) |
| app.js | 984 | `console.log` [Unlock] Plivo |
| app.js | 1000 | `console.log` [Unlock] Clarification trigger Plivo |
| app.js | 1170 | `console.log` Full speech received (Plivo audio_done) |
| app.js | 1176 | `console.log` Call ended Plivo |

**logger.***  
Not found in codebase.

**metrics.emit**  
Not found. (Only `recordPhase4Metric` in observability/phase4Metrics.js; not used in app.js hot path.)

---

*End of structural audit.*
