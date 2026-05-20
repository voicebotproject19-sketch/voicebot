# Structural Architecture Audit — Provider, Call Lifecycle, and Model Assumptions

> Historical snapshot
>
> This audit reflects a pre-refactor repository state and is retained for drift history. For current runtime truth, start with `docs/codebase-index.md`, `docs/runtime-dependency-map.md`, `docs/full-codebase-analysis.md`, and the live adapter/session files in `adapters/telecom/`, `adapters/llm/`, and `session/createCallSession.js`.

**Objective:** Identify all files and code paths that influence provider selection, call creation/routing, state management, disconnect/hangup, Azure session init, hardcoded provider behavior, env-based routing, retry/fallback/reconnect, country/ISD routing, and STT/LLM/TTS provider assumptions.

**Classification:**
- **Transport-specific:** Depends on Twilio or Plivo wire format, SDK, or WebSocket contract.
- **Model-specific:** Depends on Azure Realtime, Whisper, or a specific LLM (e.g. GPT-4o).
- **Business logic:** Call flow, policy, degradation, turn/epoch; should be provider-agnostic where possible.

**Break under refactor:** If the code path would break or behave incorrectly under a provider-agnostic or model-agnostic refactor.

---

## 1. Provider selection (Twilio, Plivo, or other)

| File | Role in call lifecycle | Type | Breaks if refactored? |
|------|-------------------------|------|------------------------|
| **Controller/MainController.js** | `exports.call`: chooses provider by **phone number**: `phoneNumber.includes("+na")` → Plivo; else Twilio. Calls `createCallPlivo` or `createCallTwilio`. | Business logic (routing) | Yes — routing rule is hardcoded here. |
| **Helper/Helpers.js** | `createCallTwilio` / `createCallPlivo`: use Twilio vs Plivo SDK to create outbound call; no selection logic. | Transport-specific | Yes — each uses its SDK. |

---

## 2. Call creation and routing logic

| File | Role in call lifecycle | Type | Breaks if refactored? |
|------|-------------------------|------|------------------------|
| **Routes/Routes.js** | Defines: `POST /api/call` → `MainController.call`; `POST /incoming-twilio` → `MainController.incoming_twilio`; `POST /incoming-plivo` → `MainController.incoming_plivo`. | Transport-specific (route names) | Yes — route names are provider-specific. |
| **Controller/MainController.js** | `exports.call`: single entry for outbound call; routes to Plivo or Twilio by `+na`. `incoming_twilio`: returns TwiML with `<Stream url='wss://.../connection_twilio'/>`. `incoming_plivo`: returns Plivo XML with `wss://.../connection_plivo`. | Transport-specific + env | Yes — URLs and XML shapes are provider-specific. |
| **app.js** | `app.ws('/connection_twilio', ...)` and `app.ws('/connection_plivo', ...)`: two separate WebSocket handlers. No shared “connection” abstraction. | Transport-specific | Yes — duplicate handler structure. |

---

## 3. activeCalls and activeCallsPlivo state management

| File | Role in call lifecycle | Type | Breaks if refactored? |
|------|-------------------------|------|------------------------|
| **Helper/Helpers.js** | Defines and exports `activeCalls = {}` and `activeCallsPlivo = {}`. Populates on `createCallTwilio` (key `response.sid`) and `createCallPlivo` (key `response.requestUuid`). | Transport-specific (two maps) | Yes — single provider-agnostic map would need one key space. |
| **Controller/MainController.js** | Uses `activeCalls` / `activeCallsPlivo` only implicitly via Helpers (createCall* writes to the maps). | Business logic | No — just relies on Helpers. |
| **app.js** | **Twilio path:** On `start`: reads `activeCalls[edgeSession.callSID]` for recipient, name, language, contextHint, policyConfig; sets `current.streamID`, `current.connectionId`. On WebSocket `close`: sets `activeCalls[edgeSession.callSID].status = "disconnected"`, `delete activeCalls[edgeSession.callSID]`. **Plivo path:** Same pattern with `activeCallsPlivo[edgeSession.callSID]` on start and close. | Transport-specific (which map) | Yes — wrong map on close would leak or mis-update state (see docs/voice-platform-analysis.md historical bug). |
| **Helper/PlivoStatusHandler.js** | Imports `activeCallsPlivo`, `createCallTwilio`, `createCallPlivo`, `activeCalls` but only logs `req.body`; does not mutate maps. | Unused for state | No. |

---

## 4. Disconnect / hangup helpers

| File | Role in call lifecycle | Type | Breaks if refactored? |
|------|-------------------------|------|------------------------|
| **Helper/Helpers.js** | `disconnetTwilioCall(callSID)`: `client.calls(callSID).update({ status: 'completed' })`. `disconnetPlivoCall(callUuid)`: `plivoClient.calls.hangup(callUuid)`. | Transport-specific | Yes — each uses vendor API. |
| **app.js** | **Twilio:** `disconnetTwilioCall(edgeSession.callSID)` on `signal_silence_hangup` and `signal_should_hangup`. **Plivo:** `disconnetPlivoCall(edgeSession.callSID)` on `signal_should_hangup` only (no silence_hangup in Plivo path). On WebSocket `close`: updates status and deletes from correct map (`activeCalls` / `activeCallsPlivo`). | Transport-specific | Yes — hangup API and which map is updated are provider-specific. |
| **services-twilio/realtimeServiceTwilio.js** | Emits `silence_hangup` after sending a hangup message and delay; uses `sendTextResponse` then `this.emit('silence_hangup', ...)`. No direct disconnect call. | Transport + business | Yes — silence flow is Twilio-only; Plivo has no equivalent. |
| **services-plivo/realtimeServicePlivo.js** | No `silence_hangup` or `sendTextResponse`. Emits `disconnected` on WebSocket close. | Transport-specific | Yes — different event surface. |

---

## 5. Azure session initialization (session.update, turn_detection, voice, VAD settings)

| File | Role in call lifecycle | Type | Breaks if refactored? |
|------|-------------------------|------|------------------------|
| **services-twilio/realtimeServiceTwilio.js** | `handleOpen()`: sends `session.update` with `voice: 'sage'`, `input_audio_format` / `output_audio_format: 'g711_ulaw'`, `input_audio_transcription: { model: 'whisper-1' }`, `turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 100, silence_duration_ms: 400, create_response: true }`, `temperature: 0.7`, `max_response_output_tokens: 600`. Also starts first silence timer. | Model-specific (Azure Realtime, voice, VAD) | Yes — hardcoded voice and VAD; different from Plivo. |
| **services-plivo/realtimeServicePlivo.js** | `handleOpen()`: sends `session.update` with `voice: 'shimmer'`, same g711/whisper, `turn_detection: { type: 'server_vad', threshold: 0.4, prefix_padding_ms: 150, silence_duration_ms: 500, create_response: true }`, `temperature: 0.7`, `max_response_output_tokens: 800`. No silence timer. | Model-specific (Azure Realtime, voice, VAD) | Yes — different voice and VAD/token limits than Twilio path. |

**Summary:** Voice IDs and VAD/token settings differ between Twilio and Plivo; both assume Azure Realtime + Whisper + g711_ulaw.

---

## 6. Hardcoded provider-dependent behavior

| File | Behavior | Breaks if refactored? |
|------|----------|------------------------|
| **Controller/MainController.js** | `+na` → Plivo; otherwise Twilio. Stream URLs: `connection_twilio` vs `connection_plivo`. | Yes |
| **app.js** | Twilio: `msg.start.callSid`, `msg.start.streamSid`; `msg.event === 'media'` with `msg.media.payload`. Plivo: `msg.start.callId`, `msg.start.streamId`; same `media.payload`. Twilio has CallSID mismatch check before `sendAudio`; Plivo does not. Twilio has `silence_hangup` timer and `signal_silence_hangup`; Plivo has no silence-based hangup. | Yes |
| **services-twilio/stream-service-twilio.js** | Sends `streamSid`, `event: 'media'`, `event: 'mark'` (Twilio Media Streams contract). Comment says "Convert to base64 for Plivo" but file is Twilio. | Yes (wrong comment) |
| **services-plivo/stream-service-plivo.js** | Sends `streamId`, `event: 'playAudio'`, `event: 'checkpoint'` (Plivo contract). Same hold-music comment. | Yes |
| **services-twilio/realtimeServiceTwilio.js** | Has `sendTextResponse`, silence timers, `FIRST_SILENCE_TIMEOUT` / `SECOND_SILENCE_TIMEOUT`, `excludedSentences`, `silence_hangup` emission. | Yes |
| **services-plivo/realtimeServicePlivo.js** | No `sendTextResponse`. No silence-based hangup. Different `insertUpdatedPrompt` (e.g. German uses kbe + kbg; Twilio German uses only kbg). | Yes — and clarification text is never sent on Plivo (see below). |

---

## 7. Environment-based routing logic

| File | Role | Type | Breaks if refactored? |
|------|------|------|------------------------|
| **Controller/MainController.js** | `process.env.NETWORK_URL` used for Stream URL (Twilio) and `service_url` (Plivo). | Config / env | No — env is expected. |
| **Helper/Helpers.js** | Twilio: `url: https://${process.env.NETWORK_URL}/incoming-twilio`, `statusCallback`, etc. Plivo: `https://${process.env.NETWORK_URL}/incoming-plivo`. | Config / env | No. |
| **app.js** | `PHASE2_5_2_UNLOCK_DEBUG`, `PORT` from env. | Config | No. |
| **config/latencyResponsivenessConfig.js** | Phase3 flags and timeouts from env. | Config | No. |
| **Sequelize/db.js**, **Helper/hangupDecision.js** | DB and Azure OpenAI base URL/key from env. | Config | No. |

No env value is used to *select* provider; provider selection is purely `+na` in `MainController.call`.

---

## 8. Retry, fallback, or reconnect logic

| File | Role | Type | Breaks if refactored? |
|------|------|------|------------------------|
| **Helper/Helpers.js** | `createCallTwilio` / `createCallPlivo`: no retry on failure; catch only logs. | Business logic | No — no retry today. |
| **services-twilio/realtimeServiceTwilio.js** | No WebSocket reconnect or Azure session retry. `handleError` / `handleClose` emit only. | — | No retry present. |
| **services-plivo/realtimeServicePlivo.js** | Same — no reconnect. | — | No retry present. |
| **rag/ragGuardrails.js** | “Zero docs” → fallback behavior (caller must clarify); no telephony retry. | RAG / business | No. |
| **config/latencyResponsivenessConfig.js** | “No silent fallback” for confidence override. | Config | No. |
| **policy/callInteractionPolicy.js** | `resolveGuardedLanguage`: campaign → ISD default → tenant fallback language. | Business logic | No. |
| **Helper/hangupDecision.js** | Returns safe fallback JSON on error. | Business logic | No. |

**Summary:** No retry or reconnect for call setup or Azure WebSocket; only application-level fallbacks (language, RAG, hangup decision).

---

## 9. Country-based or ISD-based routing logic

| File | Role in call lifecycle | Type | Breaks if refactored? |
|------|-------------------------|------|------------------------|
| **Controller/MainController.js** | Error message says "country detection failed" but provider selection is by `+na`, not country/ISD. | Copy only | No. |
| **Helper/Helpers.js** | `parseE164CountryCode(phone)`: best-effort E.164 country code for `policyConfig.isoCountryCode`. Used in both `createCallTwilio` and `createCallPlivo` when `policyConfig.isoCountryCode` is null. | Business logic | No — used for policy, not provider routing. |
| **policy/callInteractionPolicy.js** | `ISD_DEFAULT_LANGUAGE`: map of country/ISD codes to language (e.g. '91'→'en', '49'→'de'). `resolveGuardedLanguage`: campaign language > ISD default > tenant fallback. | Business logic | No — policy only; no call routing. |

**Summary:** No country/ISD-based *provider* routing; country/ISD is used only for policy (e.g. guarded language).

---

## 10. STT/LLM/TTS provider-specific assumptions

| File | Assumption | Type | Breaks if refactored? |
|------|------------|------|------------------------|
| **services-twilio/realtimeServiceTwilio.js** | Azure Realtime: `AZURE_REALTIME_ENDPOINT`, `AZURE_REALTIME_KEY`; `input_audio_transcription: { model: 'whisper-1' }`; `g711_ulaw`; `OpenAI-Beta: realtime=v1`. | Model-specific | Yes — switching STT/TTS provider would require adapter. |
| **services-plivo/realtimeServicePlivo.js** | Same Azure Realtime + Whisper + g711_ulaw. | Model-specific | Yes. |
| **Helper/hangupDecision.js** | Azure OpenAI `chat.completions.create`, `model: "gpt-4o"`. Uses `Azure_openAi_key`, `Azure_openAi_endpoint`, api-version. | Model-specific (LLM) | Yes — different LLM or API would need adapter. |
| **app.js** | Calls `realtimeService.sendTextResponse` only when `typeof realtimeService.sendTextResponse === 'function'`. **RealtimeServicePlivo does not implement sendTextResponse.** So clarification/guarded text is never sent on Plivo when unlock/policy requests it. | Transport + model | **Yes — behavior gap:** Plivo path never sends clarification TTS. |
| **Knowledge-base/** (e.g. Knowledge-base-english.js, Knowledge-base-german.js) | Keyword retrieval; no direct STT/LLM/TTS dependency. | Business logic | No. |
| **Helper/languageModel.js** | Prompt text for LLM; used by realtime services for instructions. | Model-specific (prompts) | Yes if model contract changes. |

---

## Summary table: would break under provider-agnostic or model-agnostic refactor

| Area | Files | Breaks? |
|------|--------|--------|
| Provider selection | MainController.js, Helpers.js | Yes |
| Call creation & routing | Routes.js, MainController.js, app.js (ws paths) | Yes |
| activeCalls / activeCallsPlivo | Helpers.js, app.js (both ws handlers) | Yes |
| Disconnect / hangup | Helpers.js, app.js, realtimeServiceTwilio/Plivo | Yes |
| Azure session (voice, VAD) | realtimeServiceTwilio.js, realtimeServicePlivo.js | Yes (and differs by provider) |
| Hardcoded provider behavior | All of the above + stream-service-* | Yes |
| Env-based routing | Only NETWORK_URL for URLs; no provider switch | No |
| Retry/fallback/reconnect | Not implemented for call/Azure | N/A |
| Country/ISD routing | Only for policy language, not provider | No |
| STT/LLM/TTS assumptions | realtimeService* (Azure, Whisper), hangupDecision (GPT-4o), app.js sendTextResponse | Yes; Plivo clarification TTS missing |

---

## Critical finding: Plivo clarification / guarded TTS

- **app.js** (Twilio and Plivo branches) uses: `if (permission.allowSpeak && typeof realtimeService.sendTextResponse === 'function') { realtimeService.sendTextResponse(clarificationText); }`
- **RealtimeServiceTwilio** implements `sendTextResponse(text)`; **RealtimeServicePlivo** does not.
- **Effect:** On Plivo, when unlock/policy decides to send clarification or guarded message, the condition fails and no TTS is sent. Provider-agnostic refactor would need to either add `sendTextResponse` to Plivo realtime service or unify behind a single interface used by both.

---

## Recommendation for refactor

1. **Provider selection:** Move to config or explicit parameter (e.g. `provider: 'plivo' | 'twilio'`) instead of `+na`.
2. **State:** Single `activeCalls` (or abstract session store) keyed by a canonical call id, with provider stored on the record.
3. **Hangup / disconnect:** Single interface (e.g. `hangup(callId)`) implemented by Twilio/Plivo adapters.
4. **WebSocket:** Single connection handler that dispatches by provider (e.g. from URL path or first message) to transport-specific message parsing and stream service.
5. **Azure session:** Single config (voice, VAD, tokens) or per-campaign config; avoid duplicating different values per provider.
6. **sendTextResponse:** Define on both realtime services (or shared base) so clarification/guarded speech works on Plivo.

This audit aligns with `.cursor/rules/voice-platform-non-negotiable.mdc` and the existing docs (e.g. voice-platform-analysis.md, phase2-implementation-validation.md). No separate `development_rules.md` was found; cursor rules are the authoritative source.
