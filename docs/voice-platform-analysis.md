# Voice Platform Codebase Analysis

> Historical snapshot
>
> This document reflects an earlier codebase shape and is retained for analysis history. For current runtime truth, use `docs/codebase-index.md`, `docs/runtime-dependency-map.md`, `docs/runtime-risk-review.md`, and `docs/full-codebase-analysis.md`.

**Document version:** 1.0  
**Date:** 2025-02-10  
**Purpose:** Understanding-only analysis of the real-time enterprise voice platform. No proposed changes or refactors—findings only.

---

## 1. High-Level System Overview (As Implemented)

### What the system does

The system is a Node.js application that:

- Handles **outbound and inbound** phone calls via **Twilio** and **Plivo**.
- Streams **bidirectional audio** over WebSockets.
- Uses a single **Azure OpenAI Realtime** (realtime=v1) session per call for STT, dialogue, and TTS.
- Optionally applies **RNNoise** (WASM) denoising to inbound audio.
- Uses an **in-memory, keyword-based “knowledge base”** (no vector RAG) to enrich prompts.
- Uses **Azure OpenAI GPT-4o** for hangup/decision analysis after each bot utterance.

### End-to-end data flow

1. **Call creation:** `/api/call` receives `phoneNumber`, `name`, `language`. Twilio vs Plivo is chosen by phone number (`+na` → Plivo; otherwise Twilio). Call metadata is stored in `activeCalls` or `activeCallsPlivo`.
2. **Telephony connection:** Incoming call hits `/incoming-twilio` or `/incoming-plivo`; Twilio returns `<Stream url="wss://.../connection_twilio"/>`, Plivo returns stream XML. Media is sent over WebSocket.
3. **WebSocket:** Client connects to `/connection_twilio` or `/connection_plivo`. On `start`, a `RealtimeServiceTwilio` or `RealtimeServicePlivo` is initialized with callSID, recipient, name, language; a `StreamService` is bound to the same WebSocket.
4. **Ingress:** Telephony sends `media` events (base64 μ-law). App optionally denoises (shared denoiser), converts back to μ-law, and forwards to Azure Realtime via `input_audio_buffer.append`.
5. **Realtime:** Azure performs server VAD, turn detection, transcription, and generation. It sends `response.audio.delta` (TTS) and `conversation.item.input_audio_transcription.completed` (final user transcript). On `input_audio_buffer.speech_started`, the app cancels the current response and emits `interruption`.
6. **Egress:** Audio deltas are pushed into an in-memory array; a 20 ms timer concatenates and sends one chunk to the stream service, which sends it to the telephony WebSocket.
7. **Per-turn:** On each **final** user transcript the app: inserts conversation in DB, appends to in-memory context, runs knowledge-base retrieval (keyword match), builds updated instructions, sends `session.update` to Azure. After the **next** bot transcript it runs hangup analysis (GPT-4o) and may schedule disconnect.
8. **State:** Session/state is per WebSocket (one RealtimeService + one StreamService per call). Global state: `activeCalls`, `activeCallsPlivo`, and a **single shared** denoiser instance.

---

## 2. Audio & Telephony Flow

### Ingress

- Twilio/Plivo send WebSocket messages with `event: 'media'` and base64 μ-law payload.
- **Twilio:** In `connection_twilio`, handler reads `msg.media.payload`, decodes to Buffer. If denoiser is initialized and not `pauseTranscription`, it **awaits** `denoiser.processChunk(ulawBuffer)`, then `pcm16ToMulaw(denoisedAudio)`, then `realtimeService.sendAudio(pcm16toulaw)`. CallSID is checked before send.
- **Plivo:** Same pattern: `msg.media.payload` → optional denoise → pcm16ToMulaw → `sendAudio`.
- Audio is sent to Azure in 160-byte chunks via `input_audio_buffer.append`.
- **Streaming vs buffering:** Ingress is chunk-by-chunk after optional denoising; no full-segment buffering. The denoiser runs **per media message** and is **async** (resampling, WASM frames), so it sits on the hot path.

### Egress

- Azure sends `response.audio.delta` (base64). RealtimeService emits `audio` with a Buffer.
- In **app.js**, each buffer is pushed into `audioChunks` and a **20 ms** timer is set; when it fires, all chunks are concatenated, duration is computed (length/8000 + 15), and `streamService.sendAudioDirect(combinedAudio.toString('base64'), duration, false, 'AI')` is called. The fourth argument is not used by `sendAudioDirect(audio, audioDuration, hold)`.
- **Twilio:** `sendAudioDirect` sends one `media` event and one `mark`. On barge-in, the timer is cleared and `streamService.stopCurrentAudio()` sends `clear`.
- **Plivo:** `sendAudioDirect` sends `playAudio` and `checkpoint`; on interruption, `stopCurrentAudio` → `stopPlayback` sends `clearAudio`.
- **Streaming:** TTS is produced as deltas by Azure; the app batches them for 20 ms then sends one combined chunk to telephony. Playback is chunked with a 20 ms minimum batch, not sample-by-sample streaming.

### Known implementation issues

- **Hold music (Twilio):** In `stream-service-twilio.js`, `playHoldMusicOnce()` sends `media.payload: audio` where `audio` is **undefined** (variable not defined in scope). Intent is likely `this.holdAudioBuffer`. Twilio hold music is non-functional in current code.
- **Hold music load:** Sync `fs.readFileSync` in `loadHoldMusic()` at StreamService init.

---

## 3. Turn-Taking & Session Model

### Turn detection

- Handled entirely by **Azure Realtime** via `turn_detection: { type: 'server_vad', ... }` (threshold, prefix_padding_ms, silence_duration_ms, create_response: true). The app does not implement its own VAD or turn boundaries.

### Interruptions (barge-in)

- On `input_audio_buffer.speech_started`, RealtimeService calls `cancelResponse()` (sends `response.cancel`) and emits `interruption`.
- In **app.js** listeners: clear `audioChunks`, clear the 20 ms audio timer, call `streamService.stopCurrentAudio()` (and for Twilio, `realtimeService.cancelResponse()`). No further TTS is sent for that response and playback is stopped.
- There is **no explicit turn/epoch ID** in code. Cancellation is “cancel current response”; late audio or late hangup results are not explicitly discarded by turn.

### Session state

- **Per connection:** One RealtimeService and one StreamService per WebSocket. `conversationContext`, `count`, `isResponseActive`, `callSID`, `recipient`, `name`, `botLang`, knowledge-base instances (kbe/kbg), and silence timers (Twilio only) live on that instance.
- **Shared/global:**
  - `activeCalls` / `activeCallsPlivo`: keyed by call SID; hold recipient, name, language, streamID, etc.
  - **Single** `denoiser` (RealTimeRNNoise) created at app load and reused for all Twilio and Plivo connections.
- **Bug:** On Plivo WebSocket `close`, the code checks and deletes `activeCalls[callSID]` instead of `activeCallsPlivo[callSID]`. Plivo call cleanup does not remove the correct map entry.

### Session isolation

- Conversations and Realtime state are per connection. The shared denoiser is not session-keyed; its internal residual buffers are not reset per call (no per-call reset in `noise-reducer.js`). Denoiser state can leak across calls.

---

## 4. STT / TTS Behavior

### STT

- Provided by Azure Realtime (Whisper in that pipeline). The app only consumes **final** transcripts: `conversation.item.input_audio_transcription.completed`. There is **no** handling of partial or interim transcripts; no code path uses partials for latency-sensitive behavior.

### TTS

- Also Azure Realtime; output is `response.audio.delta`. The app emits each delta as `audio` and batches in memory for 20 ms, then sends one chunk to telephony. Playback can start after the first batch (20 ms of deltas).
- **Interruptibility:** When the user speaks, `response.cancel` is sent and `stopCurrentAudio()` clears playback and stops the timer, so TTS is interruptible. There is no explicit “first audio chunk” latency metric or timeout.

### Format

- Realtime is configured with `input_audio_format: 'g711_ulaw'`, `output_audio_format: 'g711_ulaw'`. End-to-end is 8 kHz μ-law.

---

## 5. RAG / Knowledge Handling

### Presence

- There is **no** vector RAG or external retrieval service. Two **in-process** classes exist: `companyKnowledgeBaseEnglish` and `companyKnowledgeBaseGerman`. Each holds a large in-memory array of sections (id, category, keywords, priority, content).

### Trigger

- On each **final** user transcript, `insertUpdatedPrompt(userQuestion)` is called. It calls `this.kbe.retrieveRelevantInfo(userQuestion)` (and for German, `this.kbg.retrieveRelevantInfo(userQuestion)`). Retrieval is **synchronous** keyword + category + simple word-overlap scoring; top N sections are concatenated and injected into the next `session.update` instructions. So retrieval runs on the hot path after every user turn, before the next bot reply is generated.

### Third-party

- Knowledge is local (no external RAG API). Hangup/decision uses **Azure OpenAI** (GPT-4o) in `hangupDecision.js`; that call has **no** timeout and is awaited in the RealtimeService message handler after `response.audio_transcript.done`.

---

## 6. Multilingual Handling

### Detection

- **Not in codebase.** Language is **not** detected from audio or transcript. It is provided at **call creation** by the client (`language` in `/api/call` body) and is fixed for the call (e.g. "english", "german", "Miami English" from the HTML bot pages).

### Switching

- **No mid-call language switch.** `botLang` is set once in `initialize(callSID, recipient, name, botLang)` and used for instructions, prompts, and knowledge-base choice (English vs German). No logic to change language during the call or to preserve/merge context across a hypothetical switch.

### Configuration

- Language values are hard-coded strings in the app (`"english"`, `"german"`, etc.) and in the HTML (e.g. `const language = "english"`). No config-driven language list or mapping.

---

## 7. Non-Functional Assessment

### Latency risks

- **Denoiser:** `await denoiser.processChunk(ulawBuffer)` on every media chunk is on the ingress path; WASM + resample 8k→48k→process→8k can add delay. Single shared instance.
- **Hangup decision:** `await analyzeConversationForHangup(...)` runs after each bot transcript with **no timeout**; a slow Azure OpenAI response can delay the next turn or disconnect decision.
- **Knowledge retrieval:** Synchronous and in-process; small but non-zero CPU cost on every user turn.
- **TTS:** 20 ms batching adds a fixed 20 ms before first playback; no measurement of time-to-first-audio.
- **No** end-to-end or segment-level latency metrics or targets (e.g. 600 ms) enforced in code.

### Concurrency / ordering risks

- Audio chunks are appended to `audioChunks` and flushed by a single 20 ms timer; if multiple `audio` events arrive before the timer fires, they are concatenated. There is no turn/epoch ID; if a late `audio` or `decision` arrives after an interruption, the code does not explicitly discard it by turn. Twilio path validates `realtimeService.callSID === callSID` before sending audio and before emitting to stream; Plivo path does not validate callSID on `audio` in app.js.
- **Plivo realtimeServicePlivo.js:** In the `else` branch of `insertUpdatedPrompt`, `updatedInstruction - updatedEnglishPrompt(...)` uses **minus** instead of assignment (`=`); `updatedInstruction` is never set and the session.update uses an undefined instruction.

### State isolation risks

- **Denoiser:** One global instance; residual buffers are not reset per call → possible cross-call leakage.
- **Plivo close:** Uses `activeCalls` instead of `activeCallsPlivo` → wrong map updated on disconnect.
- Session-scoped state (context, count, etc.) is per RealtimeService instance, which is per WebSocket, so per-call isolation is mostly correct except for the denoiser and the Plivo cleanup bug.

### Observability gaps

- **No** structured metrics (counters, histograms, latency percentiles). Only `console.log` (and optional connectionId for Twilio). No session ID or call SID in a consistent trace format. No alerts or health signals for latency breaches, STT delay, or TTS first-audio delay. Health is a simple HTTP 200 from `/health`.

### Security

- CORS and Helmet are configured. No logging of raw audio or full transcripts in the snippets reviewed; conversation content is logged (e.g. `[USER]:`, `[AI ...]:`). API keys and secrets come from `process.env`. DB uses parameterized queries. No obvious PII in logs beyond what’s in conversation text. Twilio/Plivo and Azure endpoints/keys are environment-driven.

### Blocking I/O

- **noise-reducer:** `fs.readFileSync(wasmPath)` in `loadModule()` (at denoiser init).
- **StreamService:** `fs.readFileSync(holdMusicPath)` in `loadHoldMusic()` and `fs.existsSync(holdMusicPath)`.
- These are not on the per-chunk hot path but run at startup or first use.

---

## 8. Alignment Summary

### Clearly aligned with target requirements

- Full-duplex phone calls (Twilio and Plivo).
- Streaming audio ingress and egress (chunked; no full-file buffering).
- TTS is interruptible (cancel + stop playback on barge-in).
- Barge-in triggers cancellation and stopping of current TTS.
- Some “RAG-like” behavior via in-app knowledge base used to enhance prompts.
- Third-party telephony and Azure are behind app-owned code (no direct SDK use in core flow beyond WebSocket/HTTP).
- Session-scoped conversation state and per-connection RealtimeService/StreamService.
- Language can differ per call (English/German/Miami English) via request body.

### Partial alignment

- **Streaming STT:** Azure is streaming, but the app only uses **final** transcripts; partials are not used.
- **Latency:** No file-based audio; batching and denoiser add delay; no 600 ms budget or measurement.
- **RAG:** Retrieval exists and is prompt-enhancement only, but it’s synchronous and on the hot path with no timeout; failure mode is not clearly defined.
- **Observability:** Logging exists; no metrics, tracing, or latency/health signals.
- **Config:** Some behavior is env-driven (URLs, keys); language and many thresholds (e.g. silence 25s/15s, 20 ms batch) are hard-coded.

### Clear violations / gaps

- **Turn/epoch contract:** No explicit turn ID; late results are not discarded by turn.
- **Session isolation:** Shared denoiser without per-call reset; Plivo close updates wrong map (`activeCalls` instead of `activeCallsPlivo`).
- **STT:** Partials not used; only final transcript drives dialogue.
- **Multilingual:** No automatic language detection; no mid-call switch; no context preservation across language change.
- **Hard-coded behavior:** Languages, silence timeouts, batch interval, VAD parameters, excluded sentences, etc.
- **External calls:** Hangup analysis has no timeout; can block.
- **Observability:** No latency or health metrics as required by rules.
- **Intentional bugs:** Twilio hold music uses undefined `audio`; Plivo `insertUpdatedPrompt` uses `-` instead of `=` for default language branch.

---

## 9. Unknowns & Assumptions

### Explicit uncertainties

- Whether `franc-min` or any other package is used elsewhere for language detection (it appears in package.json but was not found in the files reviewed).
- Exact Azure Realtime API semantics (e.g. ordering of `response.cancel` and in-flight deltas, or whether partial transcripts are available in the same API).
- Whether `isDenoiserInitialized` is ever set to false after init (e.g. on denoiser failure) and what happens to audio when denoiser is off (code path exists but behavior under failure is not fully traced).
- Whether Twilio/Plivo media semantics (clear vs clearAudio, mark/checkpoint) are used correctly for barge-in and hold music in production.

### Assumptions made

- `cursor-rules` / voice-platform-non-negotiable rules are the authoritative requirements source; no separate `development_rules.md` was found.
- Azure Realtime “realtime=v1” is the sole STT+TTS+dialogue provider; no other STT/TTS adapters are in use.
- The fourth argument to `sendAudioDirect(..., 'AI')` is legacy/unused and not required for correctness.
- Knowledge base is only the two in-repo JS classes; no external RAG or search service is used.

### Documented as missing or unclear

- No turn/epoch identifier; “intent unclear” for how late async work (e.g. hangup decision or RAG) should be tied to a turn.
- No in-code specification of the 600 ms latency budget or where it applies.
- Configuration source for languages, timeouts, and thresholds is not defined in the codebase (beyond env vars for URLs/keys).

---

## File Reference

| Area              | Files |
|-------------------|--------|
| Entry & WebSocket | `app.js` |
| Routes            | `Routes/Routes.js` |
| Controller        | `Controller/MainController.js` |
| Twilio services   | `services-twilio/realtimeServiceTwilio.js`, `services-twilio/stream-service-twilio.js` |
| Plivo services    | `services-plivo/realtimeServicePlivo.js`, `services-plivo/stream-service-plivo.js` |
| Helpers           | `Helper/Helpers.js`, `Helper/audioCodec.js`, `Helper/hangupDecision.js`, `Helper/languageModel.js` |
| Noise             | `Noise-Reducer/noise-reducer.js`, `libs/rnnoise.js`, `libs/rnnoise.wasm` |
| Knowledge         | `Knowledge-base/Knowledge-base-english.js`, `Knowledge-base/Knowledge-base-german.js` |
| Rules             | `.cursor/rules/voice-platform-non-negotiable.mdc` |
