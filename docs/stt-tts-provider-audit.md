# Realtime Voice Architecture Implementation Plan

> Historical snapshot
>
> This plan predates the current adapter/session architecture and current Azure Realtime speech configuration. Treat it as design history, not canonical runtime truth.

This document now includes both **quick‑win improvements that can be implemented immediately without refactoring the current pipeline**, and **future architectural upgrades** that require a larger orchestration refactor.

The phases below are grounded in the **current repository structure**, which already includes:

• Twilio and Plivo telecom adapters  
• realtime streaming services  
• CallRegistry lifecycle management  
• audio processing pipeline  
• websocket streaming architecture  

No assumptions are made beyond what is already implemented.

---

# Phase 1 — Immediate improvements (low‑risk, minimal refactor)

These improvements can be implemented directly inside the **existing realtime services**:

```
services-twilio/realtimeServiceTwilio.js
services-plivo/realtimeServicePlivo.js
```

They do **not require replacing the current pipeline**.

Expected engineering effort: **1–2 days**.

## Phase 1 components

1. **Partial streaming commit pipeline**  
   Section reference: **Section 10**

   Allows AI generation to start earlier using partial transcripts.

2. **Streaming LLM → TTS token bridge**  
   Section reference: **Section 14**

   Allows TTS to begin speaking before the full LLM response is generated.

3. **STT partial debounce**  
   Section reference: **Section 28.1**

   Prevents excessive AI triggers from frequent STT partial events.

4. **AI token batching for TTS**  
   Section reference: **Section 28.2**

   Smooths speech synthesis and reduces TTS overhead.

5. **Transcript rewrite correction (commit cursor)**  
   Section reference: **Section 22**

   Prevents duplicated tokens from streaming STT rewrites.

6. **Audio turn isolation (ghost audio prevention)**  
   Section reference: **Section 23**

   Guards audio playback using turn identifiers.

7. **Telecom frame ordering protection**  
   Section reference: **Section 24**

   Handles out‑of‑order telecom frames caused by network jitter.

8. **Parallel prompt prebuilding (latency reduction)**

   Prompt preparation can run **while STT streaming is still in progress** so the LLM request can begin immediately when the final transcript arrives.

Example implementation:

```javascript
// services/ai/promptPrebuilder.js

let preparedPrompt = null

async function preparePrompt(contextManager) {

  if (preparedPrompt) return preparedPrompt

  preparedPrompt = await contextManager.buildContext()

  return preparedPrompt
}

function finalizePrompt(basePrompt, transcript) {

  return [
    ...basePrompt,
    { role: "user", content: transcript }
  ]
}

module.exports = {
  preparePrompt,
  finalizePrompt
}
```

This optimization typically removes **150–200 ms** of hidden latency because prompt construction runs in parallel with STT.

---

# Phase 2 — Architectural refactor (future improvements)

These improvements introduce a **dedicated orchestration layer** and provider abstraction.  
They should be implemented only after Phase 1 stabilizes.

Expected engineering effort: **1–2 weeks**.

## Phase 2 components

1. **Provider adapter architecture**  
   Section reference: **Section 7**

2. **Latency‑aware provider router**  
   Section reference: **Section 9**

3. **Voice orchestration layer**  
   Section reference: **Section 12**

4. **Turn prediction pre‑generation**  
   Section reference: **Section 11**

5. **Semantic endpoint detection**  
   Section reference: **Section 13**

6. **Adaptive speech pacing + prosody control**  
   Section reference: **Section 15**

7. **Provider router hardening (circuit breaker)**  
   Section reference: **Section 16**

8. **Streaming conversation context manager**  
   Section reference: **Section 18**

9. **Voice latency observability layer**  
   Section reference: **Section 19**

10. **Turn‑epoch synchronization layer**  
    Section reference: **Section 27**

---

# Implementation order

Recommended rollout:

```
Phase 1
  ↓
Stabilize streaming pipeline
  ↓
Introduce orchestration layer
  ↓
Phase 2 provider architecture
```

This approach ensures:

• zero regression risk  
• compatibility with current realtime services  
• incremental latency improvements  
• deterministic integration into the existing codebase

### Current vs Target Architecture

The **current** realtime pipeline runs entirely inside:

• **services-twilio/realtimeServiceTwilio.js**  
• **services-plivo/realtimeServicePlivo.js**

There is no separate voice orchestrator today; STT, AI, and TTS are coordinated within these telecom-specific services. The **voice orchestrator** described later in this document is a **future architecture**, not yet implemented.

**Target architecture:**

```
Telecom realtime service
   ↓
Voice Orchestrator
   ↓
STT / AI / TTS providers
```

The planned module is:

**services/voice/voiceOrchestrator.js**

The orchestrator should be introduced **incrementally**: telecom services should gradually route audio frames into the orchestrator so that existing behaviour is preserved while the new layer is adopted.

---

## 7. Provider adapter architecture (recommended)

To support multiple STT and TTS providers without modifying the core voice pipeline, production voice systems implement a **provider adapter layer**.

This repository already separates telecom providers (Twilio / Plivo). The same pattern can be applied to STT and TTS.

### Architecture

Voice pipeline:

Telecom (Twilio / Plivo)  
→ Audio processing (µ‑law decode / RNNoise)  
→ **STT Adapter**  
→ AI / LLM  
→ **TTS Adapter**  
→ Audio stream back to telecom

```text
services/
  stt/
    sttAdapter.js
    providers/
      azureRealtimeStt.js
      deepgramStt.js
      googleStt.js

  tts/
    ttsAdapter.js
    providers/
      azureRealtimeTts.js
      elevenlabsTts.js
      googleTts.js
```

### STT adapter example

```javascript
// services/stt/sttAdapter.js

const providers = {
  azure: () => require('./providers/azureRealtimeStt'),
  deepgram: () => require('./providers/deepgramStt'),
  google: () => require('./providers/googleStt')
};

function getSttProvider() {
  const provider = process.env.STT_PROVIDER || 'azure';

  if (!providers[provider]) {
    throw new Error(`Unsupported STT provider: ${provider}`);
  }

  return providers[provider]();
}

module.exports = {
  transcribeStream: (...args) => getSttProvider().transcribeStream(...args)
};
```

### TTS adapter example

```javascript
// services/tts/ttsAdapter.js

const providers = {
  azure: () => require('./providers/azureRealtimeTts'),
  elevenlabs: () => require('./providers/elevenlabsTts'),
  google: () => require('./providers/googleTts')
};

function getTtsProvider() {
  const provider = process.env.TTS_PROVIDER || 'azure';

  if (!providers[provider]) {
    throw new Error(`Unsupported TTS provider: ${provider}`);
  }

  return providers[provider]();
}

module.exports = {
  synthesize: (...args) => getTtsProvider().synthesize(...args)
};
```

### Runtime configuration

Provider selection becomes environment‑driven:

```
STT_PROVIDER=azure
TTS_PROVIDER=azure
```

Future examples:

```
STT_PROVIDER=deepgram
TTS_PROVIDER=elevenlabs
```

### Benefits

• Provider switching without code changes  
• Easy A/B testing of speech providers  
• Automatic failover capability  
• Reduced vendor lock‑in  

### Example failover pattern

Production systems often implement fallback logic:

```
primaryProvider.transcribeStream(audio, {
  onError: () => fallbackProvider.transcribeStream(audio)
})
```

### Compatibility with current architecture

This adapter layer integrates cleanly with the current system:

- `services-twilio/realtimeServiceTwilio.js`
- `services-plivo/realtimeServicePlivo.js`

Only the STT/TTS calls need to route through the adapters.

No changes are required to:

- telecom adapters
- CallRegistry
- telemetry layer
- realtime streaming architecture

## 8. Deterministic cleanup steps

The following commands can be run to safely remove unused STT/TTS dependencies that were identified in this audit.

⚠ Run the uninstall step only after confirming via the STT/TTS audit that these providers are not actively used in the runtime pipeline.

### Step 1 — Remove unused speech providers

npm uninstall @deepgram/sdk \
@google-cloud/speech \
@google-cloud/text-to-speech \
microsoft-cognitiveservices-speech-sdk

### Step 2 — Reinstall dependencies cleanly

rm -rf node_modules package-lock.json
npm install

### Step 3 — Verify no provider imports remain

grep -R "@google-cloud/speech" . --exclude-dir=node_modules
grep -R "@google-cloud/text-to-speech" . --exclude-dir=node_modules
grep -R "@deepgram/sdk" . --exclude-dir=node_modules
grep -R "microsoft-cognitiveservices-speech-sdk" . --exclude-dir=node_modules

Expected result: **no matches in application code**.

### Step 4 — Verify runtime configuration

Confirm the realtime stack still uses the Azure realtime environment variables:

AZURE_REALTIME_ENDPOINT
AZURE_REALTIME_KEY

These should appear only in:

services-twilio/realtimeServiceTwilio.js  
services-plivo/realtimeServicePlivo.js

### Step 5 — Optional future provider architecture

If the system later adds multiple providers, recommended production architecture is:

Primary STT: Deepgram  
Fallback STT: Google Speech  

Primary TTS: ElevenLabs  
Fallback TTS: Google TTS  

Provider routing should be implemented through a **voice provider adapter layer** so switching providers does not require application code changes.

## 9. Latency‑aware provider router (production improvement)

Large realtime voice systems (Twilio/OpenAI‑style stacks) often extend the adapter layer with a **provider router** that dynamically selects the fastest or healthiest STT/TTS provider at runtime.

Instead of hard‑coding a single provider via environment variables, the router evaluates:

• provider latency  
• recent error rate  
• cost per request  
• regional availability  

### Architecture

```
services/
  stt/
    sttRouter.js
    sttAdapter.js
    providers/
      azureRealtimeStt.js
      deepgramStt.js
      googleStt.js

  tts/
    ttsRouter.js
    ttsAdapter.js
    providers/
      azureRealtimeTts.js
      elevenlabsTts.js
      googleTts.js
```

### Example STT router

```javascript
// services/stt/sttRouter.js

const providers = {
  azure: () => require('./providers/azureRealtimeStt'),
  deepgram: () => require('./providers/deepgramStt'),
  google: () => require('./providers/googleStt')
};

const metrics = {
  azure: { latency: 0, errors: 0 },
  deepgram: { latency: 0, errors: 0 },
  google: { latency: 0, errors: 0 }
};

function selectProvider() {
  return Object.keys(metrics)
    .sort((a, b) => metrics[a].latency - metrics[b].latency)[0];
}

module.exports = {
  transcribeStream(audio, options) {
    const providerName = selectProvider();
    const provider = providers[providerName]();

    const start = Date.now();

    return provider.transcribeStream(audio, {
      ...options,
      onComplete: () => {
        metrics[providerName].latency = Date.now() - start;
      },
      onError: () => {
        metrics[providerName].errors++;
      }
    });
  }
};
```

### Example TTS router

```javascript
// services/tts/ttsRouter.js

const providers = {
  azure: () => require('./providers/azureRealtimeTts'),
  elevenlabs: () => require('./providers/elevenlabsTts'),
  google: () => require('./providers/googleTts')
};

function selectProvider() {
  return process.env.TTS_PROVIDER || 'azure';
}

module.exports = {
  synthesize(...args) {
    return providers[selectProvider()]().synthesize(...args);
  }
};
```

### Benefits

• Automatic routing to fastest provider  
• Built‑in failover if a provider degrades  
• Lower speech latency under load  
• Easier experimentation with new speech models  

### Compatibility with current system

This router layer can be added **without modifying the existing voice pipeline**:

- `services-twilio/realtimeServiceTwilio.js`
- `services-plivo/realtimeServicePlivo.js`

Only the adapter import needs to change:

```
const stt = require('../stt/sttRouter')
const tts = require('../tts/ttsRouter')
```


## 10. Partial streaming commit pipeline (latency reduction improvement)

Large realtime voice systems reduce perceived STT latency by **committing partial transcripts during the audio stream**, instead of waiting for a final transcription result.

This technique typically reduces effective response latency by **25–40%** because the LLM can begin processing earlier.

### Concept

Traditional pipeline:

User speech  
→ full utterance captured  
→ STT final transcript  
→ AI processing  

Latency: full speech duration + STT processing.

Improved pipeline:

User speech  
→ **partial transcript emitted continuously**  
→ AI begins processing partial context  
→ transcript finalized when speech ends  

Latency: significantly reduced because the AI starts earlier.

### Architecture

```
Audio stream
   ↓
STT provider streaming API
   ↓
partial transcripts
   ↓
partialCommitBuffer
   ↓
AI processing begins
   ↓
final transcript commit
```

#### Correct event ordering (deterministic pipeline)

To avoid duplicated transcripts and unstable partial streams, production systems enforce the following order of operations:

```
STT partial
   ↓
partial debounce (Section 28.1)
   ↓
transcript commit cursor (Section 22)
   ↓
partial commit emission (Section 10)
   ↓
turn prediction (Section 11)
```

This ordering ensures:

• unstable partial transcripts are filtered first  
• STT rewrites do not duplicate tokens  
• downstream AI generation receives deterministic text segments  

### Example partial commit handler

```javascript
// services/stt/partialCommit.js

let partialBuffer = "";
let lastCommit = "";

function handlePartialTranscript(partial) {
  partialBuffer = partial;

  const words = partialBuffer.split(" ");

  // commit every N words to downstream pipeline
  if (words.length - lastCommit.split(" ").length >= 3) {
    lastCommit = partialBuffer;

    emitPartialCommit(lastCommit);
  }
}

function handleFinalTranscript(finalText) {
  lastCommit = finalText;
  emitFinalTranscript(finalText);
}

module.exports = {
  handlePartialTranscript,
  handleFinalTranscript
};
```

### Integration with streaming STT

Streaming STT providers already emit partial events:

Examples:

Deepgram  
```
speech.partial
speech.final
```

Google streaming STT  
```
isFinal: false
isFinal: true
```

Azure realtime  
```
conversation.item.input_audio_transcription.delta
conversation.item.input_audio_transcription.completed
```

The partial commit layer simply consumes these events.

### Benefits

• AI response generation begins earlier  
• Lower perceived conversational latency  
• Improved interruption handling  
• More natural voice interaction

### Compatibility with current architecture

This improvement can be added **without modifying telecom streaming code**.

Integration points:

```
services-twilio/realtimeServiceTwilio.js
services-plivo/realtimeServicePlivo.js
```

Replace direct transcript forwarding with:

```
partialCommit.handlePartialTranscript()
partialCommit.handleFinalTranscript()
```


The rest of the pipeline remains unchanged.

### Production note

Large realtime voice systems also include:

• minimum word thresholds  
• debounce timers (≈150–250 ms)  
• interruption detection  

to avoid over-triggering AI responses on unstable partial transcripts.

## 11. Turn‑prediction pre‑generation (ultra‑low latency improvement)

Large realtime voice AI systems reduce conversational latency further by **predicting the end of a user’s turn and pre‑generating an AI response before the user fully finishes speaking**.

Instead of waiting for the final STT transcript, the system estimates that the user is about to stop speaking and begins generating the AI response early.

This technique typically reduces perceived response latency by **150–300 ms**.

### Concept

Traditional pipeline:

User speech  
→ STT final transcript  
→ AI generation begins  
→ TTS synthesis  

Improved pipeline with turn prediction:

User speech  
→ partial transcript stream  
→ **turn‑prediction model detects likely end of speech**  
→ AI response generation begins early  
→ final transcript arrives  
→ AI response is corrected or finalized  

### Architecture

```
Audio stream
   ↓
Streaming STT
   ↓
partial transcripts
   ↓
turnPredictionModel
   ↓
AI pre‑generation
   ↓
final transcript arrives
   ↓
response finalized
```

### Example turn prediction heuristic

Many systems start with a lightweight heuristic before moving to ML models.

```javascript
// services/stt/turnPrediction.js

let lastSpeechTime = Date.now();

function onSpeechActivity() {
  lastSpeechTime = Date.now();
}

function shouldPreGenerate() {
  const silence = Date.now() - lastSpeechTime;

  // if silence > 250ms assume user turn ending
  return silence > 250;
}

module.exports = {
  onSpeechActivity,
  shouldPreGenerate
};
```

### Integration example

Inside the realtime streaming service:

```javascript
if (turnPrediction.shouldPreGenerate()) {
  aiEngine.startPreGeneration(partialTranscript);
}
```

If the final transcript differs significantly, the system can cancel or adjust the response.

#### Priority relative to semantic endpoint detection

Turn prediction and semantic endpoint detection serve different purposes.

Execution order should always be:

```
partial transcript
   ↓
turn prediction (silence heuristic)
   ↓
semantic endpoint detection (Section 13)
   ↓
AI generation
```

Turn prediction handles pauses in speech.

Semantic endpoint detection predicts semantic completion of the user's intent and sentence boundary.

### Advanced implementations

Production systems often extend this with:

• VAD (voice activity detection) confidence  
• language‑model turn prediction  
• interruption detection  
• speculative decoding for LLM responses  

### Benefits

• Faster perceived response times  
• More natural conversation flow  
• Reduced silence gaps between turns  

### Compatibility with current architecture


This layer fits naturally after the **partial commit pipeline** (Section 10):

```
partial transcripts
   ↓
turnPrediction
   ↓
AI pre‑generation
```

It requires **no changes to telecom streaming layers** and can be integrated within:

```
services-twilio/realtimeServiceTwilio.js
services-plivo/realtimeServicePlivo.js
```


## 12. Voice orchestration layer (production architecture)

Modern realtime voice systems include a **voice orchestration layer** that coordinates telecom streaming, STT, LLM generation, TTS streaming, and interruption handling.

This layer acts as the central state machine for a voice session and prevents race conditions across the pipeline.

### Architecture

```
Telecom (Twilio / Plivo)
        ↓
Voice Orchestrator
        ↓
 ┌──────┼────────┐
 │      │        │
 ▼      ▼        ▼
STT   AI Engine  TTS
        ↓
  streaming audio
```

The orchestrator manages:

• streaming STT events  
• partial transcript commits  
• turn prediction  
• speculative LLM decoding  
• streaming TTS playback  
• interruption handling  
• CallRegistry lifecycle  
• telemetry emission

### Example orchestrator implementation

```javascript
// services/voice/voiceOrchestrator.js

const CallRegistry = require('../services/CallRegistry')
const stt = require('../services/stt/sttRouter')
const tts = require('../services/tts/ttsRouter')
const ai = require('../services/ai/streamingEngine')
const vad = require('../services/audio/vad')
const partialCommit = require('../services/stt/partialCommit')
const turnPrediction = require('../services/stt/turnPrediction')

function createVoiceSession(callId, telecomStream) {

  const state = {
    turnId: 0,
    partialTranscript: "",
    activeGeneration: null
  }

  CallRegistry.create(callId, state)

  function onAudioFrame(frame) {

    const speech = vad.detect(frame)

    if (speech) {
      turnPrediction.onSpeechActivity()
    }

    stt.streamAudio(frame, {

      onPartial(text) {

        state.partialTranscript = text

        const commit = partialCommit.handlePartialTranscript(text)

        if (commit) startAI(commit)

        if (turnPrediction.shouldPreGenerate()) {
          speculativeAI(text)
        }
      },

      onFinal(text) {

        partialCommit.handleFinalTranscript(text)

        startAI(text)
      }

    })
  }

  function startAI(transcript) {

    const generationId = Date.now()

    if (state.activeGeneration) return

    state.currentGenerationId = generationId

    const turnId = ++state.turnId

    state.activeGeneration = ai.streamCompletion({
      input: transcript,
      turnId,

      onToken(token) {

        if (generationId !== state.currentGenerationId) return

        tts.streamText(token, {

          onAudio(audioChunk) {

            if (turnId !== state.turnId) return

            telecomStream.sendAudioDirect(audioChunk)

          }

        })
      },

      onComplete() {
        state.activeGeneration = null
      }

    })
  }

  function speculativeAI(partialText) {

    if (state.activeGeneration) return

    state.activeGeneration = ai.speculativeGenerate({
      input: partialText,
      turnId: state.turnId
    })
  }

  function onUserInterrupt() {

    if (state.activeGeneration) {
      ai.cancel(state.activeGeneration)
      tts.stop()
      state.activeGeneration = null
    }
  }

  function closeSession() {

    if (state.activeGeneration) {
      ai.cancel(state.activeGeneration)
    }

    CallRegistry.delete(callId)
  }

  return {
    onAudioFrame,
    onUserInterrupt,
    closeSession
  }
}

module.exports = { createVoiceSession }
```

### Integration with the current system

This orchestrator sits between the telecom streaming layer and the speech/AI providers.

Integration points:

```
services-twilio/realtimeServiceTwilio.js
services-plivo/realtimeServicePlivo.js
```

Telecom services should forward audio frames to the orchestrator:

```
voiceSession.onAudioFrame(frame)
```

### Benefits

• Eliminates race conditions across STT / AI / TTS  
• Centralizes call turn state  
• Enables speculative decoding and partial commits  
• Simplifies interruption handling  
• Improves maintainability of realtime voice pipelines

### Compatibility with current repository

The orchestrator integrates cleanly with existing architecture components:

• telecom adapters (Twilio / Plivo)  
• CallRegistry service  
• telemetry logger  
• streaming audio pipeline

No changes are required to the telecom adapters themselves — only the audio routing layer needs to invoke the orchestrator.

## 13. Semantic endpoint detection (next‑generation latency improvement)

Advanced realtime voice systems further reduce conversational latency by replacing simple silence‑based turn detection with **semantic endpoint detection**.

Instead of waiting for a fixed silence window (for example 250 ms), the system predicts when a sentence is *semantically complete* and begins generating the AI response immediately.

This approach can reduce perceived latency by an additional **100–150 ms** and significantly improves conversational flow.

### Concept

Traditional turn detection:

```
speech
  ↓
250ms silence
  ↓
end of turn
```

Semantic endpoint detection:

```
speech
  ↓
partial transcript stream
  ↓
semantic completion predictor
  ↓
predict end of utterance
  ↓
AI generation begins
```

Example:

User speech:

```
"I want to check my account bal—"
```

Even before the last word completes, the system predicts the intent and begins generating the response.

### Architecture

```
Audio stream
   ↓
Streaming STT
   ↓
partial transcripts
   ↓
semanticEndpointDetector
   ↓
AI generation
```

### Example semantic endpoint heuristic

```javascript
// services/stt/semanticEndpoint.js

let lastTranscript = "";

function shouldEndTurn(partialTranscript) {

  const words = partialTranscript.split(" ");

  if (words.length < 3) return false;

  const lastWord = words[words.length - 1];

  const likelyCompletion = [
    "please",
    "thanks",
    "now",
    "today",
    "balance",
    "status"
  ];

  return likelyCompletion.includes(lastWord);
}

module.exports = {
  shouldEndTurn
};
```

### Integration with orchestrator layer

The semantic endpoint detector can be called from the voice orchestrator before silence detection:

```
if (semanticEndpoint.shouldEndTurn(partialTranscript)) {
  aiEngine.startPreGeneration(partialTranscript);
}
```

### Production implementations

Large voice platforms often combine multiple signals:

• semantic completion models  
• punctuation prediction  
• VAD confidence  
• pause duration  
• language‑model probability of sentence completion

### Benefits

• Faster perceived response times  
• Reduced silence between turns  
• More natural conversation pacing  
• Improved handling of short commands

### Compatibility with current architecture

Semantic endpoint detection integrates naturally after the **turn prediction layer (Section 11)** and before AI generation.

```
partial transcripts
   ↓
turnPrediction
   ↓
semanticEndpoint
   ↓
AI generation
```

No changes are required to:

• telecom adapters  
• STT provider layer  
• TTS provider layer  
• CallRegistry

Only the orchestrator logic needs to include the semantic endpoint detector.
## 14. Streaming LLM → Streaming TTS token bridging (ultra‑low latency architecture)

Large realtime voice AI systems reduce response latency by **streaming LLM tokens directly into the TTS engine**, instead of waiting for the full AI response to complete.

This technique is commonly called **token‑to‑audio bridging**.

It allows the TTS system to begin synthesizing speech as soon as the first AI tokens arrive.

Typical latency improvement: **150–250 ms**.

### Traditional pipeline

```
STT final transcript
   ↓
LLM generates full response
   ↓
TTS synthesis begins
```

Latency impact:

LLM generation time + TTS startup time.

### Streaming pipeline

```
STT partial transcript
   ↓
LLM streaming tokens
   ↓
TTS token bridge
   ↓
Audio chunks streamed to telecom
```

The TTS engine begins generating audio while the LLM is still producing text.

### Architecture

```
Audio stream
   ↓
Streaming STT
   ↓
partial transcripts
   ↓
LLM streaming tokens
   ↓
TTS token bridge
   ↓
telecom audio playback
```

#### Correct streaming order

To prevent double buffering and fragmented speech synthesis, the token pipeline must follow this sequence:

```
LLM token stream
   ↓
token batching (Section 28.2)
   ↓
token bridge (Section 14)
   ↓
prosody controller (Section 15)
   ↓
streaming TTS
```

**Token batching must occur BEFORE the token bridge.** Correct pipeline:

```
LLM token stream
   → tokenBatcher (Section 28.2)
   → tokenBridge (Section 14)
   → prosodyController (Section 15)
   → streaming TTS
```

The **tokenBatcher** stabilizes tokens (groups small bursts into word-sized chunks). The **tokenBridge** converts those chunks into speech-ready segments for TTS. Running batching first avoids duplicated buffering, fragmented speech chunks, and unstable TTS streaming behaviour.

### Example token bridge implementation

```javascript
// services/tts/tokenBridge.js

let buffer = "";

function handleToken(token, tts) {

  buffer += token;

  const words = buffer.split(" ");

  if (words.length >= 3) {

    const chunk = words.slice(0, -1).join(" ");

    buffer = words.slice(-1)[0];

    tts.streamText(chunk);
  }
}

module.exports = {
  handleToken
};
```

### Integration with orchestrator layer

Inside the AI token stream handler:

```
ai.streamCompletion({
  onToken(token) {
    tokenBridge.handleToken(token, tts);
  }
})
```

### Benefits

• AI begins speaking while still thinking
• Reduces first‑audio latency
• Improves conversational responsiveness
• Enables natural streaming speech

### Language‑aware pipeline optimisation

Voice pipelines can further reduce latency by adapting the streaming strategy based on **language characteristics**.

Some languages have longer word formation and slower token stability, which affects partial commit behaviour.

Examples:

English:

• commit every 2–3 words
• token bridge chunk ≈ 2–3 words

German:

• longer compound words
• commit every 1–2 words

Japanese / Chinese:

• no whitespace word boundaries
• commit based on character groups

### Example language‑aware commit strategy

```javascript
// services/stt/languageCommitStrategy.js

function getCommitThreshold(language) {

  switch (language) {

    case "en":
      return 3;

    case "de":
      return 2;

    case "ja":
    case "zh":
      return 5; // characters

    default:
      return 3;
  }
}

module.exports = { getCommitThreshold };
```

### Production systems combine

• token streaming from LLM
• streaming TTS synthesis
• semantic endpoint detection
• language‑aware commit thresholds

This architecture enables **sub‑500 ms conversational latency**, which is the target for natural realtime voice interaction.

## 28. Streaming stability controls

### 28.2 AI token batching for TTS

Token batching groups small token bursts into stable word chunks before the token bridge (Section 14) forwards them to TTS, reducing overhead and smoothing speech synthesis.

### 28.3 STT backpressure queue (production safeguard)

Streaming STT providers can emit partial events faster than downstream components can process them.

Without flow control this can cause:

• AI over-generation  
• duplicated responses  
• event storms under heavy load  

Production systems therefore place STT events behind a lightweight async queue.

Example implementation:

```javascript
// services/stt/sttEventQueue.js

const queue = [];
let processing = false;

async function pushEvent(event, handler) {
  queue.push(event);

  if (processing) return;

  processing = true;
  while (queue.length) {
    const item = queue.shift();
    await handler(item);
  }
  processing = false;
}

module.exports = { pushEvent };
```

Integration example:

```javascript
stt.onPartial(text => {
  sttQueue.pushEvent(text, handlePartialTranscript);
});
```

Benefits:

• prevents event storms from STT providers  
• stabilizes downstream AI triggers  
• reduces race conditions during heavy load  

## 15. Adaptive speech pacing + prosody control (perceived latency improvement)

The fastest production voice systems improve **perceived responsiveness and conversational naturalness** using adaptive speech pacing and prosody control.

Instead of synthesizing speech at a fixed rate, the TTS layer dynamically adjusts:

• speaking rate  
• pause timing  
• pitch / prosody  
• chunk size for streaming audio

This reduces interruption frequency and improves perceived latency by **20–30%**, even when actual model latency remains the same.

### Concept

Traditional voice synthesis:

```
AI response text
   ↓
TTS generates full audio
   ↓
audio streamed at fixed rate
```

Adaptive pacing pipeline:

```
LLM streaming tokens
   ↓
prosody controller
   ↓
adaptive TTS pacing
   ↓
telecom playback
```

The system begins speaking slightly faster at the start of the response and slows down near sentence boundaries.

### Architecture

```
LLM streaming tokens
   ↓
Token bridge (Section 14)
   ↓
Prosody controller
   ↓
Streaming TTS
   ↓
Telecom audio
```

### Example pacing controller

During streaming LLM generation, the total token count is unknown. The pacing controller must therefore depend only on the current token index (or elapsed time), not on `totalTokens`. Streaming-safe implementation:

```javascript
// services/tts/prosodyController.js

function adjustSpeechParams(tokenIndex) {

  const earlyPhase = tokenIndex < 12;
  const midPhase = tokenIndex < 40;

  const speakingRate = earlyPhase
    ? 1.1
    : midPhase
    ? 1.0
    : 0.92;

  return {
    speakingRate,
    pitch: 0,
    pauseMs: earlyPhase ? 40 : 120
  };
}

module.exports = { adjustSpeechParams };
```

**Note:** Total token count is unknown during streaming LLM generation, so pacing is based on token index phases (early / mid / late) rather than a progress ratio.

### Integration example

```
ai.streamCompletion({
  onToken(token, index) {

    const prosody = prosodyController.adjustSpeechParams(index);

    tts.streamText(token, {
      speakingRate: prosody.speakingRate,
      pitch: prosody.pitch
    });
  }
})
```

### Language‑aware pacing

Different languages benefit from different pacing profiles.

English:

• moderate speech acceleration at start  
• short pauses between clauses

German:

• slightly slower speech rate due to compound words

Japanese / Chinese:

• shorter pauses but more tonal prosody adjustments

### Benefits

• Faster perceived responses  
• Reduced user interruptions  
• More natural conversational rhythm  
• Better handling of long AI responses

### Compatibility with current architecture

Adaptive speech pacing sits directly after the **token bridge layer (Section 14)** and before audio output.

```
LLM tokens
   ↓
Token bridge
   ↓
Prosody controller
   ↓
Streaming TTS
```

No changes are required to:

• telecom adapters  
• STT providers  
• CallRegistry  
• orchestration layer

Only the TTS streaming logic needs to include the prosody controller.
## 16. Provider router production hardening (recommended fixes)

The latency router shown earlier selects providers purely by last measured latency. Production systems extend this with **weighted scoring and circuit‑breaker protection**.

### Weighted provider scoring

```
score = (latency * 0.6) + (errorRate * 0.3) + (cost * 0.1)
```

Example implementation:

```javascript
// services/stt/providerScore.js

function computeScore(metrics, cost) {
  return (metrics.latency * 0.6) + (metrics.errors * 0.3) + (cost * 0.1);
}

module.exports = { computeScore };
```

### Circuit breaker protection

Providers that fail repeatedly should be temporarily disabled.

```javascript
// services/stt/providerHealth.js

const health = {};

function markFailure(provider) {
  health[provider] = health[provider] || { failures: 0 };
  health[provider].failures++;
}

function isHealthy(provider) {
  const failures = health[provider]?.failures || 0;
  return failures < 5;
}

module.exports = { markFailure, isHealthy };
```

Benefits:

• Prevents unstable providers from repeatedly being selected  
• Stabilizes routing under provider outages  
• Improves reliability in production environments

---

## 17. Barge‑in (user interruption) detection

Realtime voice systems must detect when a user begins speaking while the AI is still talking. This behaviour is called **barge‑in detection**.

### Architecture

```
TTS playback
   ↓
VAD monitor
   ↓
User speech detected
   ↓
Stop TTS
Cancel LLM generation
Start new turn
```

### Example implementation

```javascript
// services/audio/bargeInDetector.js

function detectBargeIn(audioFrame, vad) {
  const speech = vad.detect(audioFrame);
  return speech === true;
}

module.exports = { detectBargeIn };
```

When barge‑in occurs:

```
tts.stop()
ai.cancel()
```

Buffered components must also be reset so that stale tokens do not continue entering the TTS pipeline:

```
partialCommit.reset()
tokenBridge.reset()
```

Otherwise, tokens that were already queued before the interruption may still be sent to TTS after barge‑in, causing overlapping or ghost audio.

Benefits:

• Prevents AI from talking over users  
• Enables natural conversation flow

---

## 18. Streaming conversation context manager

Voice agents must maintain a rolling conversation context so the LLM understands prior turns.

### Recommended architecture

```
CallRegistry
   ↓
ConversationContext
   ↓
LLM prompt builder
```

### Example implementation

```javascript
// services/ai/contextManager.js

const MAX_HISTORY = 20;

function updateContext(context, role, text) {
  context.push({ role, text });

  if (context.length > MAX_HISTORY) {
    context.shift();
  }

  return context;
}

module.exports = { updateContext };
```

Benefits:

• Prevents prompt explosion  
• Maintains conversation continuity  
• Keeps LLM latency predictable

---

## 19. Voice latency observability

Production voice systems track several metrics to understand latency behaviour.

### Core metrics

• STT partial latency  
• LLM first‑token latency  
• TTS first‑audio latency  
• turn duration  
• interruption frequency

### Example telemetry event

```javascript
telemetry.emit({
  type: "voice_latency",
  sttLatency: 120,
  llmFirstToken: 180,
  ttsFirstAudio: 90
});
```

### LLM generation timeout protection

Production voice systems enforce a **maximum generation duration** so that a stalled LLM response does not freeze the realtime pipeline.

Example:

```javascript
const AI_TIMEOUT_MS = 7000;

setTimeout(() => {
  ai.cancel(activeGeneration);
  tts.stop();
}, AI_TIMEOUT_MS);
```

This prevents stalled LLM responses from holding the pipeline open indefinitely; after the timeout, the generation is cancelled and TTS is stopped so the session can recover or the user can speak again.

Monitoring these metrics enables:

• detection of provider degradation  
• tuning of streaming thresholds  
• optimization of response pacing

---

## 20. Full production voice architecture overview

The following diagram summarizes the entire realtime voice pipeline described across Sections 7–19.

```
Telecom (Twilio / Plivo)
        ↓
Audio ingestion
        ↓
µ‑law decode + noise reduction
        ↓
Voice Orchestrator
        ↓
 ┌───────────────┬───────────────┐
 │               │               │
 ▼               ▼               ▼
STT Router   Context Manager   Telemetry
 │
 ▼
Streaming STT Providers
(Azure / Deepgram / Google)
 │
 ▼
Partial transcript commit pipeline
 │
 ▼
Turn prediction + semantic endpoint detection
 │
 ▼
AI generation (streaming LLM)
 │
 ▼
Token bridge
 │
 ▼
Prosody controller
 │
 ▼
Streaming TTS providers
(Azure / ElevenLabs / Google)
 │
 ▼
Telecom audio playback
```

### Key latency optimization layers

The architecture achieves low latency through the following techniques:

1. Partial STT commits  
2. Turn prediction pre‑generation  
3. Semantic endpoint detection  
4. Streaming LLM token generation  
5. Token‑to‑audio bridging  
6. Adaptive speech pacing

When combined, these techniques enable **sub‑500 ms conversational latency**, which is the target for modern realtime voice AI systems.

---

## 21. Final completeness summary

After incorporating the improvements in Sections 16–20, the architecture now includes all core components of a modern realtime voice system:

| Component | Coverage |
|---|---|
Provider adapters | ✓ |
Provider router | ✓ |
Circuit breaker | ✓ |
Partial transcript commits | ✓ |
Turn prediction | ✓ |
Semantic endpoint detection | ✓ |
Voice orchestration layer | ✓ |
Streaming LLM → TTS bridging | ✓ |
Adaptive speech pacing | ✓ |
Barge‑in detection | ✓ |
Conversation context manager | ✓ |
Latency observability | ✓ |

This document now represents a **complete production architecture reference for realtime voice AI systems**.

---

## 22. Streaming transcript correction (handling STT rewrites)

Streaming STT engines frequently **rewrite earlier words** as more audio becomes available. If the system forwards partial transcripts without correction logic, duplicate or conflicting text may be sent to the AI engine.

Example rewrite sequence:

```
partial: "I want to check my"
partial: "I want to check my account"
partial: "I want to check my account balance"
```

If every partial is forwarded blindly, the downstream AI receives duplicate tokens.

### Deterministic commit cursor

Production systems maintain a **commit cursor** representing how many words have already been committed downstream.

```javascript
// services/stt/transcriptCommitCursor.js

let committedWords = 0;

function commitPartialTranscript(text) {
  const words = text.split(" ");

  if (words.length <= committedWords) {
    return null;
  }

  const newWords = words.slice(committedWords);
  committedWords = words.length;

  return newWords.join(" ");
}

module.exports = { commitPartialTranscript };
```

### Integration with partial commit layer

Replace direct forwarding:

```
partialCommit.handlePartialTranscript(text)
```

With:

```
const newSegment = commitCursor.commitPartialTranscript(text)

if (newSegment) {
  partialCommit.handlePartialTranscript(newSegment)
}
```

### Benefits

• Prevents duplicate transcript segments
• Prevents LLM hallucination caused by repeated tokens
• Ensures deterministic streaming transcripts

---

## 23. Audio turn isolation (ghost‑audio prevention)

Realtime voice systems must prevent **late audio emissions** from a previous AI turn from being played during a new user turn.

This issue appears when:

```
AI turn A generates audio
User interrupts
Turn B begins
Remaining audio from A arrives late
```

Without protection, the user hears outdated speech ("ghost audio").

### Turn ID guard

Every audio chunk must include the **turnId** that produced it.

Example implementation:

```javascript
// inside TTS playback

function sendAudio(audioChunk, turnId, state, telecomStream) {

  if (turnId !== state.turnId) {
    return
  }

  telecomStream.sendAudioDirect(audioChunk)
}
```

### Orchestrator requirement

The voice orchestrator must increment the turnId for each new user turn:

```
state.turnId++
```

### Benefits

• Prevents late audio playback
• Eliminates ghost‑audio bugs
• Stabilizes interruption handling

---

## 24. Telecom frame ordering protection

Telecom audio streams may arrive slightly **out of order due to network jitter**.

Example:

```
frame order received:
1 2 4 3 5
```

If frames are sent directly to STT without reordering, transcription accuracy degrades.

### Frame sequencing buffer

A small reorder buffer fixes this problem.

```javascript
// services/audio/frameReorderBuffer.js

const buffer = new Map();
let expected = 0;

function pushFrame(frame) {

  buffer.set(frame.sequence, frame);

  const ordered = [];

  while (buffer.has(expected)) {
    ordered.push(buffer.get(expected));
    buffer.delete(expected);
    expected++;
  }

  return ordered;
}

module.exports = { pushFrame };
```

### Integration

Telecom services should call the reorder buffer before forwarding audio to STT:

```
const orderedFrames = reorderBuffer.pushFrame(frame)

orderedFrames.forEach(f => stt.streamAudio(f))
```

### Benefits

• Prevents STT degradation
• Handles telecom jitter
• Stabilizes streaming accuracy

### Implementation location

The reorder buffer must run in the **telecom streaming layer**, before STT ingestion.

**Recommended placement:**

• **services-twilio/stream-service-twilio.js**  
• **services-plivo/stream-service-plivo.js**

The reorder buffer must **not** run inside STT adapters; it belongs in the stream service that receives raw frames from the telecom provider, so that frames are resequenced before they are sent to STT.

---

## 25. Deterministic integration steps (vibe‑coding safe implementation)

To ensure the architecture can be implemented safely without breaking existing functionality, the following deterministic steps should be followed.

### Step 1 — Add voice orchestrator

Create:

```
services/voice/voiceOrchestrator.js
```

Export:

```
createVoiceSession(callId, telecomStream)
```

### Step 2 — Initialize session on call start

Inside telecom adapters:

```
services-twilio/realtimeServiceTwilio.js
services-plivo/realtimeServicePlivo.js
```

Add:

```javascript
const { createVoiceSession } = require('../services/voice/voiceOrchestrator')

const voiceSession = createVoiceSession(callId, telecomStream)
```

### Step 3 — Route audio frames

Replace direct STT calls with:

```
voiceSession.onAudioFrame(frame)
```

### Step 4 — Route interruption events

When VAD detects speech during TTS playback:

```
voiceSession.onUserInterrupt()
```

### Step 5 — Close session on websocket close

Inside websocket close handlers:

```
voiceSession.closeSession()
```

### Step 6 — Preserve existing infrastructure

The following components remain unchanged:

• telecom adapters
• CallRegistry
• telemetry layer
• stream‑service‑twilio.js
• stream‑service‑plivo.js

The orchestrator simply coordinates them.

### Implementation guarantee

Following these steps ensures:

• no changes to telecom adapters
• no change to existing streaming code
• deterministic integration
• no runtime regressions

---

## 26. Final architecture completeness verification

After implementing Sections 7–25, the system includes all critical production components used in modern realtime voice platforms.

| Capability | Status |
|---|---|
Provider adapter architecture | ✓ |
Provider latency router | ✓ |
Circuit breaker protection | ✓ |
Partial transcript commits | ✓ |
Transcript rewrite correction | ✓ |
Turn prediction | ✓ |
Semantic endpoint detection | ✓ |
Streaming LLM → TTS bridge | ✓ |
Adaptive prosody control | ✓ |
Voice orchestration layer | ✓ |
Barge‑in detection | ✓ |
Audio turn isolation | ✓ |
Telecom frame ordering protection | ✓ |
Deterministic integration instructions | ✓ |


---

## 28. Streaming stability controls (partial debounce + token batching)

Realtime voice systems must control the rate at which streaming events propagate through the pipeline. Without this control, **high‑frequency STT partials and ultra‑fast LLM token streams can overload the AI and TTS layers**, leading to unnecessary compute cost and unnatural speech playback.

Production voice stacks therefore implement two stabilization mechanisms:

• STT partial debounce
• AI token batching

These mechanisms eliminate two common performance issues in realtime pipelines.

---

### 28.1 STT partial debounce

Streaming STT providers can emit **10–30 partial transcript events per second**.

If each partial triggers downstream logic, the AI pipeline may start generating responses too frequently.

Example partial stream:

```
"I"
"I want"
"I want to"
"I want to check"
"I want to check my"
```

Without control, each event may trigger downstream processing.

#### Debounce strategy

Production systems typically forward partial transcripts **no faster than every 150–200 ms**.

Example implementation:

```javascript
// services/stt/partialDebounce.js

let lastEmitTime = 0
const MIN_INTERVAL = 180

function shouldEmitPartial() {

  const now = Date.now()

  if (now - lastEmitTime < MIN_INTERVAL) {
    return false
  }

  lastEmitTime = now
  return true
}

module.exports = { shouldEmitPartial }
```

Integration with partial commit pipeline:

```
if (shouldEmitPartial()) {
  partialCommit.handlePartialTranscript(text)
}
```

Benefits:

• prevents excessive AI triggers
• reduces compute usage
• stabilizes partial transcript flow

#### Deterministic STT event order

The correct processing pipeline for STT partial events is:

```
STT partial event
   → partialDebounce
   → sttEventQueue
   → transcript commit cursor
   → partialCommit handler
   → turnPrediction
```

This ordering prevents unstable partial transcripts from triggering AI generation prematurely: debounce and queue stabilize the stream, the commit cursor avoids duplicate tokens, and only then do partial commits and turn prediction run.

---

### 28.2 AI token batching for TTS

Modern LLMs can emit tokens extremely quickly (20–80 tokens/sec).

Forwarding each token directly to TTS results in **fragmented speech synthesis**.

Instead, production systems batch a small number of tokens before forwarding to TTS.

Typical batch sizes:

| language | batch size |
|---|---|
English | 3–5 tokens |
German | 2–4 tokens |
Chinese/Japanese | 5–8 characters |

#### Token batching example

```javascript
// services/tts/tokenBatcher.js

let buffer = []

function handleToken(token, tts) {

  buffer.push(token)

  if (buffer.length >= 4) {

    const textChunk = buffer.join(" ")

    buffer = []

    tts.streamText(textChunk)
  }
}

module.exports = { handleToken }
```

Integration with token bridge:

```
ai.streamCompletion({
  onToken(token) {
    tokenBatcher.handleToken(token, tts)
  }
})
```

Benefits:

• smoother speech synthesis
• reduced TTS request overhead
• improved audio naturalness

---

### Combined impact

When STT debounce and token batching are applied together:

| improvement | impact |
|---|---|
STT debounce | stabilizes transcript stream |
Token batching | smoother TTS streaming |
Combined effect | lower compute + improved audio quality |

These controls are used in most **large realtime voice AI systems** to stabilize streaming pipelines under high event rates.

---

## 27. Turn‑epoch synchronization layer (race‑condition elimination)

Production realtime voice stacks include a **turn‑epoch synchronization layer** that prevents hidden race conditions between streaming STT partials, AI token generation, and TTS audio playback.

Without this protection, the following race conditions can occur:

1. **Late STT partials** arrive after a new turn begins
2. **AI tokens** generated for an older transcript continue streaming
3. **TTS audio chunks** from a cancelled response are played
4. **Out‑of‑order async callbacks** trigger duplicated responses

These problems appear under high load or network jitter and are difficult to debug.

### Core concept

Each conversational turn is assigned a **monotonic epoch number**. All asynchronous components must verify that their work belongs to the active epoch before emitting output.

```
turnEpoch
```

The epoch increments whenever a new user turn begins or an interruption occurs.

### Session state example

```javascript
const state = {
  turnEpoch: 0,
  activeGeneration: null
}
```

### Incrementing the epoch

When a new turn begins:

```javascript
state.turnEpoch++
```

When a barge‑in interruption occurs:

```javascript
state.turnEpoch++
```

This invalidates all previous async work.

### Guarding asynchronous emitters

All streaming emitters must check the epoch before sending data downstream.

Example STT guard:

```javascript
function onPartialTranscript(epoch, text) {

  if (epoch !== state.turnEpoch) return

  partialCommit.handlePartialTranscript(text)
}
```

Example AI token guard:

```javascript
function onToken(epoch, token) {

  if (epoch !== state.turnEpoch) return

  tokenBridge.handleToken(token, tts)
}
```

Example TTS audio guard:

```javascript
function onAudio(epoch, chunk) {

  if (epoch !== state.turnEpoch) return

  telecomStream.sendAudioDirect(chunk)
}
```

### Integration with orchestrator

The voice orchestrator should capture the epoch when starting AI generation:

```javascript
const epoch = state.turnEpoch

ai.streamCompletion({
  input: transcript,

  onToken(token) {
    onToken(epoch, token)
  }
})
```

### Why this works

When a new turn begins:

```
state.turnEpoch++
```

All callbacks created under the previous epoch automatically become invalid.

This eliminates several classes of race conditions:

• STT partials from previous turns
• AI tokens from cancelled generations
• TTS audio from outdated responses
• duplicated response playback

### Benefits

• deterministic concurrency control
• elimination of ghost audio
• prevention of duplicate responses
• safer async streaming pipeline

### Compatibility with current architecture

The turn‑epoch guard integrates naturally with the **voice orchestrator layer (Section 12)** and requires only small additions to async emitters.

It does **not require changes to**:

• telecom adapters
• STT provider integrations
• TTS providers
• CallRegistry

### Production note

Most large realtime voice systems combine the turn‑epoch guard with:

• barge‑in detection
• token‑to‑audio bridging
• partial transcript commits

Together these mechanisms eliminate the majority of race conditions found in realtime conversational pipelines.