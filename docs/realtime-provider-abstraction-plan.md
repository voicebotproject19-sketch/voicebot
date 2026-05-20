# Realtime Provider Abstraction Plan

## Goal

Enable seamless switching between **Azure Voice Live** (current) and **OpenAI ChatGPT Realtime** as combined STT+LLM+TTS providers, and design the abstraction so a future **discrete-provider** mode (separate STT, LLM, TTS services) can be added without rearchitecting.

---

## 1. Current Architecture — What Exists Today

### 1.1 Runtime topology

```
app.js
  ├── createCallSession(TwilioProvider, { StreamServiceTwilio, RealtimeServiceTwilio })
  └── createCallSession(PlivoProvider, { StreamServicePlivo, RealtimeServicePlivo })

session/createCallSession.js          ← shared orchestrator (provider-agnostic)
  ├── streamServiceClass  instance    ← telecom audio I/O (Twilio or Plivo wire format)
  └── realtimeServiceClass instance   ← Azure Realtime WebSocket (handles STT+LLM+TTS)
```

### 1.2 Current realtime service responsibilities

Each `RealtimeService*` class owns **all** of the following:

| Responsibility | Where it lives |
|---|---|
| WebSocket connection to Azure | `initialize()` / `handleOpen()` / `handleClose()` |
| Session config (voice, audio format, VAD, transcription model) | `handleOpen()` / `getFullSessionConfig()` |
| Audio ingress to AI (chunking, commit, VAD commit) | `sendAudio()` |
| Audio egress from AI (delta decode, emit) | `response.audio.delta` handler |
| Conversation state (phase, context, email, slot, KB) | Instance properties + `insertUpdatedPrompt()` |
| Hangup decision (LLM call via adapters/llm) | `response.audio_transcript.done` handler |
| Hallucination guard (pre- and post-generation) | `insertUpdatedPrompt()` + `response.audio_transcript.done` |
| Greeting lifecycle | `_fireGreeting()` / `handleOpen()` |
| Silence timers (Twilio only) | `startFirstSilenceTimer()` / `startSecondSilenceTimer()` |
| Context summarization trigger | `addConversationContext()` |
| Reconnection | `attemptReconnection()` |
| Telemetry emission | Throughout |

### 1.3 Orchestrator coupling

`session/createCallSession.js` consumes the realtime service through:

**Events listened to** (the contract surface):
- `response.created` — new model response started
- `interruption` / `interrupt_audio` — barge-in
- `user_transcript` — final caller transcription
- `user_speech_started` / `user_speech_stopped` — VAD signals
- `silence_hangup` — silence timeout (Twilio only)
- `audio` — TTS audio buffer for telecom stream
- `audio_done` — TTS generation complete
- `screening_detected` / `voicemail_detected` — call classification
- `decision` — hangup decision result
- `session_configured` — session ready
- `disconnected` / `reconnected` / `reconnection_failed` — connection lifecycle
- `error` / `region_error` — error reporting

**Methods called**:
- `initialize(callSID, recipient, name, personaId, langCode, turnStateRef)`
- `sendAudio(buffer)` — pipe denoised audio to AI
- `cancelResponse()` — abort current generation
- `setLatencyCompensationLevel(level)` — adjust latency hints
- `close()` — teardown
- `sendTextResponse(text)` — inject text for handover/clarification
- `removeAllListeners()` — Twilio: re-register on new start

**State read directly** (coupling leak):
- `realtimeService.callSID`
- `realtimeService.isConnected`
- `realtimeService.isSessionConfigured`
- `realtimeService.count`
- `realtimeService.name` / `recipient` / `userEmail` / `preferredSlot`
- `realtimeService.hasAskedForConsultation`
- `realtimeService.conversationPhase`
- `realtimeService.persona`
- `realtimeService.kb`
- `realtimeService.totalInputTokens` / `totalOutputTokens`
- `realtimeService._prewarmKbResult` / `_prewarmKbQuery`
- `realtimeService._bargeInOccurred`
- `realtimeService._energyVariance` / `_energySlope`
- `realtimeService._decision`
- `realtimeService._handoverTriggered`
- `realtimeService._currentToneDirective`

---

## 2. Azure Voice Live vs OpenAI ChatGPT Realtime — Protocol Comparison

Both APIs share a common Realtime protocol lineage. The key differences:

| Aspect | Azure Voice Live (current) | OpenAI ChatGPT Realtime |
|---|---|---|
| **Endpoint** | `wss://<azure-endpoint>` (env `AZURE_REALTIME_ENDPOINT`) | `wss://api.openai.com/v1/realtime?model=gpt-realtime` |
| **Auth header** | `api-key: <key>` | `Authorization: Bearer <key>` |
| **Optional header** | `OpenAI-Beta: realtime=v1` (Plivo uses it) | Not needed (GA API) |
| **Audio formats** | `g711_ulaw`, `g711_alaw`, `pcm16` | `pcm16` (24kHz). No native g711 support. |
| **STT model field** | `input_audio_transcription.model: 'azure-speech'` with `.language` locale | `input_audio_transcription.model: 'gpt-4o-transcribe'` (or `whisper-1`). No `.language` field. |
| **Echo cancellation** | `input_audio_echo_cancellation.type: 'server_echo_cancellation'` | Not documented as a session field |
| **Noise reduction** | Not in current code (done client-side via RNNoise) | `noise_reduction.type: 'near_field'` or `'far_field'` (server-side) |
| **Voice names** | Azure voice names (`en-US-JennyNeural`, `de-DE-KatjaNeural`) | OpenAI voice IDs (`alloy`, `echo`, `fable`, `onyx`, `nova`, `shimmer`, `ash`, `ballad`, `coral`, `sage`, `verse`) |
| **VAD types** | `server_vad`, `azure_semantic_vad` | `server_vad`, `semantic_vad` |
| **session.update shape** | `{ type: 'session.update', session: { ... } }` | `{ type: 'session.update', session: { type: 'realtime', ... } }` (GA adds `type: 'realtime'` inside session) |
| **Audio config (GA)** | Flat: `input_audio_format`, `output_audio_format` at session root | Nested: `audio.input.format`, `audio.output.format`, `audio.output.voice` |
| **response.create** | `{ type: 'response.create' }` or with `response.instructions` | Same, plus `response.conversation`, `response.input`, `response.metadata` |
| **Event set** | Subset of OpenAI events | Full event set including `rate_limits.updated`, `conversation.item.added`, `conversation.item.done`, `input_audio_buffer.timeout_triggered` |
| **Model selection** | Implicit (configured on Azure resource) | Explicit via URL query param `?model=gpt-realtime` (or `gpt-realtime-1.5`) |
| **Pricing/tokens** | Azure pricing | OpenAI pricing |

### Critical audio format gap

Azure Voice Live supports `g711_ulaw` natively, which is the telephony wire format. OpenAI Realtime only supports `pcm16` at 24kHz. This means:

- **Azure path**: Telephony μ-law → denoise → μ-law → Azure (native). Azure → μ-law → telephony. Zero transcoding.
- **OpenAI path**: Telephony μ-law → denoise → μ-law → **transcode to PCM16 24kHz** → OpenAI. OpenAI → PCM16 24kHz → **transcode to μ-law** → telephony. Two transcoding steps per direction.

This transcoding is the single biggest implementation concern for OpenAI Realtime support.

---

## 3. Abstraction Design

### 3.1 Principles

1. **The orchestrator (`createCallSession`) must not know which AI provider is active.** It already achieved this for telecom providers. The same pattern extends to AI providers.
2. **Conversation logic (phase, KB, hangup, hallucination) must be provider-agnostic.** It currently lives inside the realtime services — this is the main refactor target.
3. **Audio format bridging is the AI adapter's responsibility.** The orchestrator always speaks μ-law (the telephony native format). The AI adapter transcodes internally if needed.
4. **The AI provider is selected per-call**, not globally. This allows A/B testing and gradual migration.

### 3.2 Target architecture

```
adapters/
  telecom/
    TwilioProvider.js          ← existing
    PlivoProvider.js           ← existing
  ai/
    AzureRealtimeAdapter.js    ← NEW: wraps Azure Voice Live WebSocket
    OpenAIRealtimeAdapter.js   ← NEW: wraps OpenAI Realtime WebSocket + transcoding
    DiscreteAdapter.js         ← FUTURE: separate STT + LLM + TTS pipeline
    AIProviderContract.js      ← NEW: interface/contract doc (like TelecomProvider.js)

session/
  createCallSession.js         ← MODIFIED: consumes AI adapter via contract, not class directly
  conversationEngine.js        ← NEW: extracted conversation logic (phase, KB, hangup, hallucination, context)
```

### 3.3 AI Provider Contract

```javascript
/**
 * @typedef {Object} AIProvider
 *
 * ── Identity ──
 * @property {string} name - 'azure-realtime' | 'openai-realtime' | 'discrete'
 *
 * ── Lifecycle ──
 * @property {(config: AIProviderConfig) => Promise<void>} initialize
 * @property {() => void} close
 *
 * ── Audio I/O ──
 * @property {(mulawBuffer: Buffer) => void} sendAudio
 *   Accepts μ-law audio. Adapter transcodes internally if the backend requires PCM16.
 *
 * ── Response control ──
 * @property {() => void} cancelResponse
 * @property {(text: string) => void} sendTextResponse
 * @property {(instructions: string) => void} updateInstructions
 *   Replaces the current session instructions (full replacement).
 *
 * ── State (read-only for orchestrator) ──
 * @property {boolean} isConnected
 * @property {boolean} isSessionConfigured
 *
 * ── Events emitted (EventEmitter) ──
 *   session_configured    — AI session ready to receive audio
 *   user_transcript       — (text: string, opts: { confidence?: number })
 *   audio                 — (buffer: Buffer) μ-law audio for telecom. Adapter transcodes from PCM16 if needed.
 *   audio_done            — TTS generation finished
 *   response_created      — model started generating
 *   interruption          — barge-in detected
 *   user_speech_started   — VAD speech start
 *   user_speech_stopped   — VAD speech stop
 *   ai_transcript         — (text: string) model's text transcript
 *   disconnected          — connection lost
 *   reconnected           — reconnection succeeded
 *   reconnection_failed   — retries exhausted
 *   error                 — transport/API error
 */
```

### 3.4 AIProviderConfig (passed to `initialize`)

```javascript
/**
 * @typedef {Object} AIProviderConfig
 * @property {string} callSID
 * @property {string} recipient
 * @property {string} name - caller name
 * @property {string} personaId
 * @property {string} langCode
 * @property {object} turnStateRef
 * @property {string} voiceName - resolved voice name for this provider
 * @property {string} sttLocale - e.g. 'en-US' (Azure), ignored by OpenAI
 * @property {object} vadConfig - { type, threshold, prefixPaddingMs, silenceDurationMs }
 * @property {string} instructions - initial system instructions
 * @property {number} maxResponseTokens
 */
```

---

## 4. Conversation Engine Extraction

### 4.1 What moves out of the realtime services

The following are currently duplicated between `RealtimeServiceTwilio` and `RealtimeServicePlivo` and are **not** provider-specific:

| Logic cluster | Current location | Target |
|---|---|---|
| Conversation state (phase, context, email, slot, consultation flags) | Instance fields on both services | `session/conversationEngine.js` |
| `insertUpdatedPrompt()` — KB retrieval, instruction building, hallucination guard layer 1 | Method on both services | `session/conversationEngine.js` |
| `addConversationContext()` — context append + summarization trigger | Method on both services | `session/conversationEngine.js` |
| Hangup decision flow (quick + LLM) | `response.audio_transcript.done` handler in both services | `session/conversationEngine.js` |
| Hallucination guard layer 2 (post-generation scan) | `response.audio_transcript.done` handler in both services | `session/conversationEngine.js` |
| KB prewarm cache | Instance fields on both services | `session/conversationEngine.js` |
| Call classifier integration (screening, voicemail, garble, human greeting) | Transcript handler in both services | `session/conversationEngine.js` |
| Silence timers (Twilio only — but conceptually provider-agnostic) | RealtimeServiceTwilio | `session/conversationEngine.js` (gated on telecom provider flag) |
| Greeting lifecycle | Both services | `session/conversationEngine.js` |
| Media bleedthrough detection | Both services | `session/conversationEngine.js` |
| Noisy turn tracking | Both services | `session/conversationEngine.js` |
| Barge-in recovery timer | Both services | `session/conversationEngine.js` |

### 4.2 What stays in the AI adapter

| Logic cluster | Stays because |
|---|---|
| WebSocket connect/reconnect | Provider-specific endpoint, auth, protocol |
| `session.update` payload construction | Different field shapes per provider |
| Audio send (chunking, commit logic) | Different formats (μ-law vs PCM16) |
| Audio receive (delta decode, format conversion) | Different formats |
| Ping/pong keepalive | Provider-specific |
| VAD mode resolution | Provider-specific VAD type names |
| All telemetry.emit calls inside the adapter | Provider-specific event names |

### 4.3 Interaction model after extraction

```
createCallSession (orchestrator)
  │
  ├── conversationEngine
  │     ├── owns: phase, context, KB, hangup, hallucination, greeting, silence timers
  │     ├── receives: user_transcript, ai_transcript from AI adapter
  │     ├── calls: aiAdapter.updateInstructions(), aiAdapter.sendTextResponse()
  │     └── emits to orchestrator: decision, screening_detected, voicemail_detected
  │
  └── aiAdapter (Azure or OpenAI or Discrete)
        ├── owns: WebSocket, session config, audio format, reconnection
        ├── receives: sendAudio(mulaw) from orchestrator
        ├── emits: user_transcript, audio, audio_done, interruption, session_configured, etc.
        └── calls: conversationEngine methods when transcript arrives (or orchestrator wires the events)
```

---

## 5. Implementation Phases

### Phase 1: Extract conversation engine (no new provider yet)

**Risk: LOW** — Pure refactor of existing code with no behavioral change.

1. Create `session/conversationEngine.js`:
   - Move conversation state, `insertUpdatedPrompt()`, `addConversationContext()`, hangup flow, hallucination guard, call classifier integration, greeting lifecycle, silence timers, context summarization, media bleedthrough, noisy turn tracking, barge-in recovery, and KB prewarm cache.
   - Constructor takes `{ persona, lang, kb, callSID, name, recipient, turnStateRef }`.
   - Exposes methods like `handleUserTranscript(text, opts)`, `handleAITranscript(text)`, `handleAudioDone()`, `getInstructions()`, `getGreetingInstructions()`, `getOperationalInstructions()`.
   - Emits events: `decision`, `screening_detected`, `voicemail_detected`, `instructions_ready`, `text_response`.

2. Modify `RealtimeServiceTwilio` and `RealtimeServicePlivo`:
   - Remove all conversation logic. They become thin AI transport wrappers.
   - Accept a `conversationEngine` instance in `initialize()`.
   - Wire transcript events through the engine.
   - Forward `instructions_ready` events back to the Azure WebSocket via `session.update`.

3. Modify `createCallSession.js`:
   - Instantiate `conversationEngine` in the session.
   - Wire engine events to orchestrator signals.
   - Move KB prewarm from direct `realtimeService._prewarmKbResult` writes to engine method calls.

4. **Validation**: All existing tests pass. CI validators pass. Manual call test confirms identical behavior.

### Phase 2: Formalize AI adapter contract

**Risk: LOW** — Rename + interface enforcement, no behavioral change.

1. Create `adapters/ai/AIProviderContract.js` (documentation-only, like `TelecomProvider.js`).
2. Create `adapters/ai/AzureRealtimeAdapter.js`:
   - Wrap the slimmed-down realtime service into the formal contract shape.
   - Consolidate the Twilio/Plivo differences (temperature, modalities ordering, audio delta format) into config parameters rather than separate classes.
   - The adapter emits `audio` events with μ-law buffers (current Azure behavior, no transcoding needed).
3. Update `app.js` to resolve the AI adapter:
   ```javascript
   const aiProvider = resolveAIProvider(process.env.AI_PROVIDER || 'azure-realtime');
   app.ws('/connection_twilio', createCallSession(TwilioProvider, aiProvider, { streamServiceClass: StreamServiceTwilio }));
   ```
4. Update `createCallSession` signature to accept `(telecomProvider, aiProvider, { streamServiceClass })`.

### Phase 3: Add OpenAI Realtime adapter

**Risk: MEDIUM** — New code path, audio transcoding, different auth.

1. Create `adapters/ai/OpenAIRealtimeAdapter.js`:
   - WebSocket to `wss://api.openai.com/v1/realtime?model=<model>`.
   - Auth via `Authorization: Bearer <key>`.
   - Session config uses GA shape: `session.audio.input.format`, `session.audio.output.format`, `session.audio.output.voice`.
   - **Audio ingress**: Accept μ-law from orchestrator → transcode to PCM16 24kHz → base64 → `input_audio_buffer.append`.
   - **Audio egress**: Receive PCM16 24kHz base64 delta → transcode to μ-law → emit `audio` event with μ-law buffer.
   - Map OpenAI VAD type names (`server_vad`, `semantic_vad`) to config.
   - Map OpenAI voice IDs from persona config (new field: `persona.lang.openaiVoice`).
   - Handle OpenAI-specific events: `rate_limits.updated`, `input_audio_buffer.timeout_triggered`.
   - Implement reconnection with same strategy as Azure adapter.

2. Add audio transcoding utilities:
   - `Utils/audioTranscode.js` — `mulawToLinear16_24k(mulawBuffer)` and `linear16_24kToMulaw(pcmBuffer)`.
   - The μ-law→PCM16 step already exists in `Helper/audioCodec.js` (`pcm16ToMulaw`). Need the reverse and resampling from 8kHz→24kHz and 24kHz→8kHz.

3. Add persona voice mapping:
   - Extend persona language config with `openaiVoice` field alongside existing `voice` (Azure voice name).
   - AI adapter resolves voice from the appropriate field based on provider.

4. Add env vars:
   - `AI_PROVIDER` — `'azure-realtime'` (default) or `'openai-realtime'`
   - `OPENAI_REALTIME_API_KEY` — OpenAI API key for realtime
   - `OPENAI_REALTIME_MODEL` — model name (default `'gpt-realtime-1.5'`)
   - `OPENAI_REALTIME_ENDPOINT` — optional override (for proxies)

5. **Validation**:
   - Unit tests for audio transcoding (round-trip fidelity).
   - CI validator extended to check both AI adapters export the contract.
   - Manual call test with OpenAI Realtime confirming STT accuracy, latency, and TTS quality.

### Phase 4: Discrete provider mode (future)

**Risk: HIGH** — Fundamentally different data flow.

1. Create `adapters/ai/DiscreteAdapter.js`:
   - Composes separate STT, LLM, and TTS services behind the same AI adapter contract.
   - Audio ingress → STT service (e.g., Deepgram, Whisper API, Google STT).
   - Transcript → LLM service (e.g., OpenAI Chat Completions, Anthropic, local model).
   - LLM text → TTS service (e.g., ElevenLabs, Google TTS, Azure TTS REST).
   - Emits the same events as the realtime adapters.

2. New sub-contracts:
   ```
   adapters/ai/stt/STTContract.js
   adapters/ai/stt/DeepgramSTT.js
   adapters/ai/stt/WhisperSTT.js

   adapters/ai/llm/LLMContract.js
   adapters/ai/llm/OpenAIChatLLM.js
   adapters/ai/llm/AnthropicLLM.js

   adapters/ai/tts/TTSContract.js
   adapters/ai/tts/ElevenLabsTTS.js
   adapters/ai/tts/AzureTTSRest.js
   ```

3. The discrete adapter handles:
   - Concurrent STT streaming while LLM generates
   - Token-level TTS streaming (start TTS before full LLM response)
   - Turn detection (client-side VAD since there's no server-side realtime VAD)
   - Interruption handling (cancel LLM + TTS on barge-in)

4. Env config:
   ```
   AI_PROVIDER=discrete
   STT_PROVIDER=deepgram
   LLM_PROVIDER=openai-chat
   TTS_PROVIDER=elevenlabs
   ```

---

## 6. Audio Format Bridge — Detailed Design

### 6.1 Current flow (Azure, zero-transcode)

```
Telephony → μ-law 8kHz → RNNoise (μ-law→PCM16→denoise→PCM16→μ-law) → Azure (native μ-law)
Azure → μ-law → StreamService → Telephony
```

### 6.2 OpenAI flow (requires transcoding)

```
Telephony → μ-law 8kHz → RNNoise → μ-law 8kHz → TRANSCODE(μ-law 8kHz → PCM16 24kHz) → OpenAI
OpenAI → PCM16 24kHz → TRANSCODE(PCM16 24kHz → μ-law 8kHz) → StreamService → Telephony
```

### 6.3 Transcoding implementation

```javascript
// Utils/audioTranscode.js

const MULAW_DECODE_TABLE = new Int16Array(256); // pre-computed
const MULAW_ENCODE_TABLE = new Uint8Array(65536); // pre-computed

function mulawDecode(mulawBuf) { /* μ-law → PCM16 8kHz */ }
function mulawEncode(pcm16Buf) { /* PCM16 8kHz → μ-law */ }
function upsample8kTo24k(pcm16_8k) { /* linear interpolation 8kHz → 24kHz */ }
function downsample24kTo8k(pcm16_24k) { /* decimation with anti-alias filter 24kHz → 8kHz */ }

function mulawToLinear16_24k(mulawBuf) {
    return upsample8kTo24k(mulawDecode(mulawBuf));
}

function linear16_24kToMulaw(pcm16_24k) {
    return mulawEncode(downsample24kTo8k(pcm16_24k));
}
```

### 6.4 Latency impact

Each transcoding step adds ~0.5-1ms for a 20ms audio chunk. Total added latency per round trip: ~2-4ms. This is negligible relative to network latency.

The resampling quality matters more than speed. A simple linear interpolation for 8k→24k is acceptable for telephony-grade audio. The 24k→8k downsampling requires a low-pass anti-alias filter to avoid aliasing artifacts.

---

## 7. Provider Selection and A/B Testing

### 7.1 Selection hierarchy

```
Per-call override (API param) → Per-persona config → Environment default
```

1. `POST /api/call` body gains optional `aiProvider` field.
2. Persona config gains optional `aiProvider` field.
3. Environment `AI_PROVIDER` sets the global default.

### 7.2 CallRegistry integration

The selected AI provider is stored in `CallRegistry` alongside telecom provider, so it's available when the WebSocket connects:

```javascript
CallRegistry.create(callSid, {
    ...existing,
    aiProvider: resolvedAIProvider  // 'azure-realtime' | 'openai-realtime' | 'discrete'
});
```

### 7.3 Resolution in createCallSession

```javascript
// Inside ws 'start' handler, after CallRegistry lookup:
const aiProviderName = current.aiProvider || process.env.AI_PROVIDER || 'azure-realtime';
const aiAdapter = createAIAdapter(aiProviderName, {
    // provider-specific config resolved here
});
```

---

## 8. Persona Voice Mapping

### 8.1 Current persona language config

```javascript
{
    voice: 'en-US-JennyNeural',   // Azure voice
    sttLocale: 'en-US',
    // ...
}
```

### 8.2 Extended config

```javascript
{
    voice: 'en-US-JennyNeural',       // Azure voice
    openaiVoice: 'nova',              // OpenAI voice
    sttLocale: 'en-US',               // Used by Azure; ignored by OpenAI
    openaiTranscriptionModel: null,    // null = use adapter default
    // ...
}
```

The AI adapter resolves the correct voice field:

```javascript
// In AzureRealtimeAdapter:
getVoice() { return this.lang.voice; }

// In OpenAIRealtimeAdapter:
getVoice() { return this.lang.openaiVoice || 'nova'; }
```

---

## 9. Event Normalization Matrix

The AI adapter contract normalizes provider events to a common set:

| Contract event | Azure source | OpenAI source |
|---|---|---|
| `session_configured` | `session.updated` | `session.updated` |
| `user_transcript` | `conversation.item.input_audio_transcription.completed` | `conversation.item.input_audio_transcription.completed` |
| `audio` | `response.audio.delta` (μ-law base64) | `response.audio.delta` (PCM16 base64 → transcode to μ-law) |
| `audio_done` | `response.audio.done` | `response.audio.done` |
| `response_created` | `response.created` | `response.created` |
| `interruption` | `input_audio_buffer.speech_started` (when responding) | `input_audio_buffer.speech_started` (when responding) |
| `user_speech_started` | `input_audio_buffer.speech_started` | `input_audio_buffer.speech_started` |
| `user_speech_stopped` | `input_audio_buffer.speech_stopped` | `input_audio_buffer.speech_stopped` |
| `ai_transcript` | `response.audio_transcript.done` | `response.audio_transcript.done` |
| `disconnected` | WebSocket close | WebSocket close |
| `reconnected` | Reconnection success | Reconnection success |
| `reconnection_failed` | Max retries | Max retries |
| `error` | WebSocket error / `error` event | WebSocket error / `error` event |

---

## 10. Risk Assessment

| Risk | Severity | Mitigation |
|---|---|---|
| Audio quality degradation from transcoding (OpenAI path) | MEDIUM | Unit tests with round-trip fidelity checks; A/B quality comparison |
| Conversation engine extraction breaks subtle timing | HIGH | Phase 1 is pure refactor; exhaustive before/after test comparison |
| OpenAI Realtime latency higher than Azure (network + transcoding) | MEDIUM | Measure and document; latency compensation engine already exists |
| OpenAI Realtime lacks echo cancellation | MEDIUM | RNNoise already handles client-side denoising; may need echo cancellation logic in adapter |
| Persona voice quality differs between Azure and OpenAI | LOW | A/B testing; per-persona voice tuning |
| OpenAI API breaking changes (still evolving) | MEDIUM | Adapter isolates all OpenAI-specific code; changes confined to one file |
| Discrete mode adds 100-200ms latency from separate STT→LLM→TTS hops | HIGH | Token-level streaming TTS; only for use cases where provider choice matters more than latency |

---

## 11. Sequencing and Dependencies

```
Phase 1 ──→ Phase 2 ──→ Phase 3
                         Phase 4 (independent, can start after Phase 2)
```

| Phase | Depends on | Estimated scope |
|---|---|---|
| Phase 1: Extract conversation engine | Nothing | Large refactor, high test coverage needed |
| Phase 2: Formalize AI adapter contract | Phase 1 | Medium, mostly structural |
| Phase 3: OpenAI Realtime adapter | Phase 2 | Medium, new code + transcoding utils |
| Phase 4: Discrete adapter | Phase 2 | Large, multiple sub-integrations |

---

## 12. Files Affected

### Phase 1 (conversation engine extraction)

| File | Change |
|---|---|
| `session/conversationEngine.js` | **NEW** — extracted conversation logic |
| `services-twilio/realtimeServiceTwilio.js` | **MAJOR** — remove conversation logic, accept engine |
| `services-plivo/realtimeServicePlivo.js` | **MAJOR** — remove conversation logic, accept engine |
| `session/createCallSession.js` | **MODERATE** — wire engine, remove direct state reads |
| `tests/conversationPhase.test.js` | **MINOR** — may need import path update |

### Phase 2 (AI adapter contract)

| File | Change |
|---|---|
| `adapters/ai/AIProviderContract.js` | **NEW** — interface documentation |
| `adapters/ai/AzureRealtimeAdapter.js` | **NEW** — wraps slimmed realtime services |
| `app.js` | **MODERATE** — resolve AI provider, pass to createCallSession |
| `session/createCallSession.js` | **MODERATE** — accept aiProvider parameter |
| `ci/scripts/check-provider-behavior-drift.js` | **MODERATE** — extend to validate AI adapter contract |

### Phase 3 (OpenAI Realtime)

| File | Change |
|---|---|
| `adapters/ai/OpenAIRealtimeAdapter.js` | **NEW** |
| `Utils/audioTranscode.js` | **NEW** — μ-law ↔ PCM16 24kHz transcoding |
| `personas/company-sales.js` | **MINOR** — add `openaiVoice` field |
| `personas/exed-webinar.js` | **MINOR** — add `openaiVoice` field |
| `.env.example` | **MINOR** — add OpenAI Realtime env vars |
| `tests/audioTranscode.test.js` | **NEW** — round-trip fidelity tests |

### Phase 4 (discrete adapter — future)

| File | Change |
|---|---|
| `adapters/ai/DiscreteAdapter.js` | **NEW** |
| `adapters/ai/stt/*.js` | **NEW** — STT provider adapters |
| `adapters/ai/llm/*.js` | **NEW** — LLM provider adapters |
| `adapters/ai/tts/*.js` | **NEW** — TTS provider adapters |

---

## 13. Acceptance Criteria

### Phase 1
- All existing tests pass with zero behavioral change
- `conversationEngine.js` has no imports from `ws`, `openai`, or any vendor SDK
- `RealtimeServiceTwilio` and `RealtimeServicePlivo` have no conversation phase / KB / hangup logic
- Manual call test produces identical transcripts, decisions, and timing

### Phase 2
- `AIProviderContract.js` documents all required methods and events
- `AzureRealtimeAdapter` passes contract compliance validator
- `createCallSession` no longer directly imports realtime service classes
- CI validators pass

### Phase 3
- `OpenAIRealtimeAdapter` passes same contract compliance validator
- Audio transcoding round-trip test: μ-law → PCM16 24kHz → μ-law with < 1dB SNR loss
- End-to-end call via OpenAI Realtime with correct STT, coherent LLM responses, and intelligible TTS
- `AI_PROVIDER=openai-realtime` switches the provider without any other code change
- Latency delta vs Azure documented

### Phase 4
- Discrete adapter passes contract compliance validator
- End-to-end call with configurable STT/LLM/TTS combination
- Interruption handling works correctly across separate services
