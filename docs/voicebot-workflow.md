# VoiceBot — Detailed Workflow Document

> Generated from codebase analysis on 16 April 2026.  
> Source of truth: `adapters/ai/BaseRealtimeAdapter.js`, `session/conversationEngine.js`, `services-plivo/stream-service-plivo.js`, `services-twilio/stream-service-twilio.js`, `adapters/ai/AzureRealtimeAdapter.js`

---

## 1. System Architecture Overview

```
Telecom (Plivo/Twilio)
   │
   ├── WebSocket ──► StreamService (Plivo/Twilio)
   │                    │
   │                    ├── Incoming audio → Orchestrator (createCallSession)
   │                    │                    ├── GateV2 energy filter
   │                    │                    ├── Permission + assertAudioSafe gates
   │                    │                    └── sendAudio() → Azure/OpenAI
   │                    │
   │                    └── Outgoing audio ← emit('audio') ← BaseRealtimeAdapter
   │                                          └── Orchestrator gates (permission, activity, assertAudioSafe)
   │                                                └── StreamService.sendAudioDirect()
   │
   └── HTTP webhooks (answer URL, status callbacks)

createCallSession.js (orchestrator)
   ├── Wires StreamService ↔ BaseRealtimeAdapter events
   ├── Enforces turn/activity/speech-permission gates on outbound audio
   └── Manages GateV2 for inbound audio filtering

BaseRealtimeAdapter (state machine)
   ├── AzureRealtimeAdapter (protocol layer)
   ├── ConversationEngine (prompt construction, KB retrieval, phase tracking)
   ├── HallucinationGuard (post-generation safety)
   ├── CallClassifier (screening, voicemail, garble detection)
   └── Telemetry + DB persistence
```

---

## 2. Initialization Flow

### 2.1 `initialize(callSID, recipient, name, personaId, langCode, turnStateRef)`

**Source:** `BaseRealtimeAdapter.js L262-330`

| Step | Action | Parameters |
|------|--------|------------|
| 1 | Set call identity | `callSID`, `recipient`, `name`, `conversationId = callSID` |
| 2 | Resolve persona | `personaId` (default: `process.env.DEFAULT_PERSONA` or `'company-sales'`) |
| 3 | Resolve language | `langCode` (default: `process.env.DEFAULT_LANGUAGE` or `'en'`) |
| 4 | Load persona+lang | Via `getPersonaLanguage(personaId, langCode)`, fallback to `company-sales/en` |
| 5 | Load primary KB | From `lang.knowledgeBase` → require(`Knowledge-base/${name}`) |
| 6 | Load merge KB | If `lang.mergeEnglishKBForPlivo === true` → load `Knowledge-base-english` |
| 7 | Create WebSocket | `_createWebSocket()` → Azure: `new WebSocket(AZURE_REALTIME_ENDPOINT)` with `api-key` + `OpenAI-Beta: realtime=v1` headers, `perMessageDeflate: false`, `maxPayload: 10MB` |
| 8 | Attach handlers | `open`, `message`, `close`, `error`, `pong` |

### 2.2 Constructor State Defaults

**Source:** `BaseRealtimeAdapter.js L47-220`

| Category | Parameter | Default | Source |
|----------|-----------|---------|--------|
| **Config flags** | `_enableSilenceTimers` | `false` (Twilio: `true`) | constructor config |
| | `_enableAudioPlaybackTracking` | `false` (Twilio: `true`) | constructor config |
| | `_enableTextInputPath` | `false` (Twilio: `true`) | constructor config |
| | `_enableReconnectContext` | `false` (Twilio: `true`) | constructor config |
| | `_includeTempInSessionConfig` | `false` (Plivo: `true`) | constructor config |
| | `_emitAudioAsBuffer` | `false` | constructor config |
| **VAD** | `vadMode` | `resolveVADMode(process.env.AZURE_SERVER_VAD)` → `'server_vad'` | env |
| | `SILENCE_COMMIT_MS` | `parseInt(env.AZURE_VAD_SILENCE_MS) \|\| 400` | env |
| **Tokens** | `maxTotalTokenBudget` | `Number(env.MAX_TOTAL_TOKEN_BUDGET) \|\| 12000` | env |
| **Timeouts** | `BARGE_IN_RECOVERY_MS` | `Number(env.BARGE_IN_RECOVERY_MS) \|\| 4000` | env |
| | `RESPONSE_TIMEOUT_MS` | `Number(env.RESPONSE_TIMEOUT_MS) \|\| 10000` | env |
| | `FIRST_SILENCE_TIMEOUT` | `Number(env.FIRST_SILENCE_TIMEOUT_MS) \|\| 12000` | env |
| | `SECOND_SILENCE_TIMEOUT` | `Number(env.SECOND_SILENCE_TIMEOUT_MS) \|\| 15000` | env |
| | `PING_INTERVAL_MS` | `Number(env.WS_PING_INTERVAL_MS) \|\| 30000` | env |
| | `PING_TIMEOUT_MS` | `Number(env.WS_PING_TIMEOUT_MS) \|\| 10000` | env |
| | `_screeningGraceMs` | `Number(env.SCREENING_GRACE_MS) \|\| 10000` | env |
| **Noise** | `MAX_TOTAL_NOISY_TURNS` | `Number(env.MAX_TOTAL_NOISY_TURNS) \|\| 8` | env |
| **Bleedthrough** | `CONTEXT_WORD_LIMIT` | `150` | hardcoded |
| | `MEDIA_BARGE_IN_WINDOW_MS` | `20000` | hardcoded |
| | `MEDIA_MIN_WORDS` | `8` | hardcoded |
| **Deferred queue** | `_maxDeferredUserInputQueue` | `3` | hardcoded |
| **Reconnect** | `maxReconnectAttempts` | `3` | hardcoded |
| | `baseReconnectDelay` | `1000` (ms) | hardcoded |

---

## 3. Session Setup & Greeting Flow

### 3.1 `handleOpen()` — WebSocket Connected

**Source:** `BaseRealtimeAdapter.js L336-378`

```
handleOpen()
   │
   ├── reconnectAttempts = 0, isReconnecting = false  (reset on successful open)
   │
   ├── isReconnect = (this.count > 0)
   │
   ├── if (isReconnect)
   │     ├── instructions = getReconnectInstructions() [if _enableReconnectContext]
   │     │                   OR getOperationalInstructions()
   │     ├── _greetingDelivered = true
   │     └── _greetingPending = false
   │
   └── else (first connect)
         ├── instructions = getInitialGreetingInstructions()
         ├── _greetingPending = true
         └── _greetingFallbackTimer = setTimeout(env.GREETING_FALLBACK_TIMEOUT_MS || 500ms)
               └── if (_greetingPending && isConnected) → _fireGreeting()
   │
   ├── send({ type: 'session.update', session: _buildInitialSessionConfig(instructions) })
   │
   ├── if (_enableSilenceTimers) → startFirstSilenceTimer()
   └── startPing()
```

### 3.2 Greeting Delivery

**Trigger:** `session.updated` event or fallback timer (500ms)

```
session.updated event arrives
   │
   ├── isSessionConfigured = true
   ├── emit('session_configured')
   │
   ├── if (_greetingPending) → _fireGreeting()
   │     ├── _greetingPending = false
   │     ├── clear _greetingFallbackTimer
   │     └── send(_buildResponseCreate({}))  ← triggers greeting audio
   │
   └── Pending RC flush (see §6.3)
```

### 3.3 Greeting → Operational Transition

**Source:** `_handleAudioDone()` at `BaseRealtimeAdapter.js L1197`

```
_handleAudioDone() [first response completes]
   │
   ├── isResponding = false
   │
   └── if (!_greetingDelivered)
         ├── _greetingDelivered = true
         └── send({ type: 'session.update', session: _buildFullSessionConfig(getOperationalInstructions()) })
              └── Session instructions switch from greeting-only to full persona+rules
```

---

## 4. VAD Configuration

### 4.1 Mode Resolution

**Source:** `BaseRealtimeAdapter.js L437-441`

| `AZURE_SERVER_VAD` env value | Resolved `vadMode` |
|------------------------------|--------------------|
| `undefined` / `server_vad` | `'server_vad'` |
| `false` / `none` | `'none'` |
| `azure_semantic_vad` | `'azure_semantic_vad'` |

### 4.2 VAD Config Payload

**Source:** `BaseRealtimeAdapter.js L443-455`

| Parameter | Default | Env Override |
|-----------|---------|-------------|
| `prefix_padding_ms` | `300` | `VAD_PREFIX_PADDING_{LANG}` or `VAD_PREFIX_PADDING` |
| `silence_duration_ms` | `600` | `VAD_SILENCE_DURATION_{LANG}` or `VAD_SILENCE_DURATION` |
| `create_response` | **`false`** (hardcoded) | — |
| `interrupt_response` | `true` | — |
| `threshold` (server_vad only) | `0.5` | `VAD_THRESHOLD_{LANG}` or `AZURE_VAD_THRESHOLD` |

**Critical:** `create_response: false` means ALL `response.create` calls are **explicit** from our code. The server never auto-creates responses.

**Note:** Azure session config includes `input_audio_echo_cancellation: { type: 'server_echo_cancellation' }` only when `vadMode !== 'none'`.

### 4.3 VAD=none Commit Behavior

**Source:** `BaseRealtimeAdapter.js L478-490`

When `vadMode === 'none'`:
- Each `sendAudio()` sets `pendingAudioSinceCommit = true`
- Arms a `silenceCommitTimer` for `SILENCE_COMMIT_MS` (default 400ms)
- On timer fire: if `isConnected && pendingAudioSinceCommit && !isResponding` → commit + response.create

---

## 5. Audio Pipeline

### 5.1 Incoming Audio (Caller → AI)

```
Telecom WebSocket
   │
   ├── StreamService receives raw μ-law audio frame
   │
   ├── Orchestrator (createCallSession.js) gates:
   │     ├── GateV2 energy analysis (energy, variance, silenceFrames)
   │     ├── Permission + assertAudioSafe checks
   │     ├── Decision: send=true → adapter.sendAudio()
   │     └── Decision: send=false → DROP (silence/noise)
   │
   └── adapter.sendAudio(audioBuffer)
         ├── _formatAudioForProvider() → chunk into 160-byte segments (20ms @8kHz)
         ├── for each chunk: send({ type: 'input_audio_buffer.append', audio: base64 })
         └── if vadMode='none': arm silenceCommitTimer
```

### 5.2 Outgoing Audio (AI → Caller)

```
Azure WebSocket sends response.audio.delta
   │
   ├── handleMessage pre-switch block (first delta fast path)
   │     └── if (!_firstDeltaLogged)
   │           ├── Log 'first_audio_delta' + response_latency telemetry
   │           ├── _firstDeltaLogged = true  ← claimed BEFORE _handleAudioDelta runs
   │           └── NOTE: _clearResponseTimeout() is NOT called here
   │
   ├── _handleAudioDelta(message)
   │     ├── GATE: if turnStateRef.isClosed → return (drop)
   │     ├── isResponding = true
   │     ├── _currentResponseId = message.response_id
   │     ├── _currentResponseItemId = message.item_id
   │     │
   │     ├── if (!_firstDeltaLogged) [Fix 6a — intended first-delta timeout clear]
   │     │     ├── _firstDeltaLogged = true
   │     │     ├── _clearResponseTimeout()
   │     │     └── log latency telemetry
   │     │     NOTE: In practice, the pre-switch block above sets _firstDeltaLogged=true
   │     │     first, so this block is typically skipped. The response timeout is
   │     │     ultimately cleared by _handleResponseDone instead.
   │     │
   │     ├── _truncateAudioEndMs += deltaMs  (for barge-in truncation)
   │     │
   │     ├── if (_enableAudioPlaybackTracking) → update _audioPlaybackEndEstimate
   │     │
   │     └── emit('audio', audioData, _currentResponseId)
   │
   └── StreamService receives 'audio' event
         ├── GATE: if silentMode → check conditions to exit/suppress
         │     ├── Turn advanced past interruption → force-clear silentMode (Fix 7b)
         │     ├── New responseId (not cancelled) + !userSpeaking → exit silentMode
         │     └── Stale responseId → DROP
         │
         ├── GATE: if assertTurnActive(scheduledTurn) fails → DROP
         │
         └── Write μ-law payload to telecom WebSocket → caller hears audio
```

---

## 6. Transcript → Prompt → Response Flow

### 6.1 Transcript Processing Pipeline

**Source:** `_processUserTranscript()` at `BaseRealtimeAdapter.js L903-1116`

```
Server sends: conversation.item.input_audio_transcription.completed
   │
   ├── _handleTranscription(message)
   │     ├── GATE: turnStateRef.isClosed → return
   │     ├── GATE: transcript.length < 2 → reject
   │     ├── GATE: transcript === lastUserTranscript → reject (dedup)
   │     └── lastUserTranscript = transcript
   │
   └── _processUserTranscript(userText, confidence, source)
         │
         ├── GATE 1: isCallScreening(userText) → send screening response, return
         │     └── Sets isBeingScreened=true, arms _screeningTimeout (10s)
         │
         ├── GATE 2: isVoicemailContent(userText) → send voicemail msg, schedule disconnect (6s), return
         │
         ├── GATE 3: post-screening human reconnect
         │     └── if isBeingScreened && isHumanGreeting → reset state
         │
         ├── GATE 4: isGarbledTranscript(userText) → noise handling
         │     ├── consecutiveNoisyTurns++, _totalNoisyTurns++
         │     │
         │     ├── GATE 4a: _totalNoisyTurns >= MAX_TOTAL_NOISY_TURNS (8)
         │     │     └── send goodbye, schedule close(4s), return  [Fix 5]
         │     │
         │     ├── GATE 4b: consecutiveNoisyTurns === 2
         │     │     └── sendTextResponse("trouble hearing you...")
         │     │
         │     ├── GATE 4c: consecutiveNoisyTurns >= 4
         │     │     └── sendTextResponse("background noise..."), reset to 2
         │     │
         │     ├── GATE 4d: consecutiveNoisyTurns === 1 &&
         │     │            _lastBargeInTime && (now - _lastBargeInTime) < BARGE_IN_RECOVERY_MS (4000ms)
         │     │     └── sendTextResponse("trouble hearing you...")  [Fix 4]
         │     │
         │     └── return
         │
         ├── GATE 5: _isMediaBleedthrough(userText) → same noise handling as Gate 4
         │     Returns true (bleedthrough) when ALL of:
         │     - words.length >= MEDIA_MIN_WORDS (8)
         │     - _lastBargeInTime exists and within MEDIA_BARGE_IN_WINDOW_MS (20s)
         │     - _contextWords set is non-empty
         │     - At least 3 significant words (≥5 chars)
         │     - NO significant words overlap with _contextWords (inverted: overlap = NOT bleedthrough)
         │     - NO personal pronouns (I'm, my, you, your, we, our, etc.)
         │     - _energyVariance > 0.12
         │
         ├── consecutiveNoisyTurns = 0  (clean turn resets noise counter)
         │
         ├── GATE 6: Hold detection
         │     └── /^(hold on|wait|one moment|...)$/i → send "No problem", arm 15s resume nudge
         │
         ├── NORMAL PROCESSING:
         │     ├── log('user_transcribed')
         │     ├── Greeting loop detection: isSimpleGreeting? → _consecutiveGreetings++
         │     │     └── if >= 3: inject [SYSTEM NOTE] about audio issues
         │     ├── count++
         │     ├── insertConversation(callSID, recipient, 'user', userText)
         │     ├── addConversationContext('USER', userText)
         │     ├── extractEntities(userText, 'USER')
         │     ├── _addContextWords(userText)
         │     ├── _updatePhase()
         │     │
         │     └── insertUpdatedPrompt(effectiveUserText, _decision)
         │
         └── if (_enableSilenceTimers) → resetSilenceTimers()
```

### 6.2 Prompt Construction (`insertUpdatedPrompt`)

**Source:** `conversationEngine.js L49-192`

```
insertUpdatedPrompt(userQuestion, decision)
   │
   ├── GATE: if _handoverTriggered → return (hard handover in progress)
   │
   ├── Format conversation context
   │     └── formatConversationContext(maxTurns)
   │           ├── maxTurns = 8 (default/NONE), 6 (LIGHT), 3 (AGGRESSIVE)
   │           └── Returns: [Earlier: summary]\n[time] Speaker: message × last N turns
   │
   ├── Knowledge Base retrieval
   │     ├── if AGGRESSIVE + skipKbOnAggressive (default: true) → skip KB
   │     ├── if _prewarmKbResult cached → use it
   │     ├── else → kb.retrieveRelevantInfo(userQuestion, maxResults, minScore)
   │     ├── if kbEn exists → merge English KB results (prepended before primary KB)
   │     └── if no KB result → kb.getGeneralInfo() fallback
   │
   ├── KB Gate check
   │     └── shouldInterceptWithKbGate(userQuestion, knowledge, generalInfo, isGeneralFallback)
   │           └── If factual question without KB → send safe canned response, return
   │
   ├── Tone directive
   │     └── if _bargeInOccurred → prepend "BARGE-IN: acknowledge before answering"
   │
   ├── Build turn prompt
   │     └── lang.buildTurnPrompt({ count, name, userQuestion, userEmail, userPhone,
   │           preferredSlot, conversationContext, relevantKnowledge,
   │           hasAskedForConsultation, conversationPhase, toneDirective, decision })
   │     └── Prepend: "CRITICAL LANGUAGE RULE: You MUST respond ONLY in {English|German}.
   │            NEVER switch languages. If you catch yourself, self-correct immediately."
   │
   ├── Send session.update
   │     └── send({ type: 'session.update', session: _buildFullSessionConfig(updatedInstruction) })
   │     └── _pendingSessionUpdate = true
   │
   └── Route response.create based on state:
         │
         ├── BRANCH A: isResponding === true
         │     ├── Queue to _deferredUserInputQueue (max 3, FIFO, drop oldest)
         │     └── Drained in _handleResponseDone after current response completes
         │
         ├── BRANCH B: isUserSpeaking === true
         │     └── _deferredInstruction = updatedInstruction
         │         └── Flushed in _handleSpeechStopped or by watchdog timer
         │
         └── BRANCH C: !isResponding && !isUserSpeaking
               ├── _deferredInstruction = null
               ├── Build responseCreate payload with system message input
               │
               ├── if vadMode !== 'none' (server_vad):
               │     └── _pendingResponseCreate = responseCreate
               │         └── Flushed when session.updated arrives (see §6.3)
               │
               └── if vadMode === 'none':
                     └── send(responseCreate) immediately
```

### 6.3 `session.updated` → Pending RC Flush

**Source:** `BaseRealtimeAdapter.js L559-577`

```
session.updated event
   │
   ├── if (_pendingSessionUpdate && _pendingResponseCreate)
   │     ├── _pendingSessionUpdate = false
   │     │
   │     ├── if (!isResponding)
   │     │     ├── pendingRC = _pendingResponseCreate
   │     │     ├── _pendingResponseCreate = null
   │     │     └── send(pendingRC)                    [Fix 1: safe flush]
   │     │
   │     └── if (isResponding)
   │           ├── log('pending_rc_blocked_by_responding')
   │           └── send({ type: 'response.cancel' })  [Fix 1: cancel stale, keep pendingRC]
   │               └── _pendingResponseCreate stays alive for response.done to drain
   │
   └── else: _pendingSessionUpdate = false
```

---

## 7. Speech Lifecycle & Barge-In

### 7.1 `_handleSpeechStarted()`

**Source:** `BaseRealtimeAdapter.js L704-828`

```
input_audio_buffer.speech_started
   │
   ├── GATE: Debounce — if gap < SPEECH_START_DEBOUNCE_MS (150ms) → return
   │
   ├── isUserSpeaking = true
   │
   ├── Arm deferred flush watchdog
   │     └── setTimeout(BARGE_IN_RECOVERY_MS = 4000ms)
   │           └── if _deferredInstruction && isUserSpeaking && !isResponding && isConnected:
   │                 ├── isUserSpeaking = false
   │                 ├── emit('user_speech_stopped')  [Fix 7a]
   │                 └── Flush _deferredInstruction via response.create  [Fix 3]
   │
   ├── Clear stale deferred queue  [existing guard]
   │     └── if _deferredUserInputQueue.length > 0 → clear all, log dropped count
   │
   ├── if (_enableSilenceTimers) → clear silence timers
   │
   ├── Clear stale _deferredInstruction (server_vad only)  [Fix 8c]
   │     └── if vadMode !== 'none' && _deferredInstruction → _deferredInstruction = null
   │
   ├── Compute _stillPlaying (Twilio only)
   │     └── Date.now() < _audioPlaybackEndEstimate
   │
   ├── BARGE-IN BRANCH: if (isResponding || _stillPlaying)
   │     ├── _lastBargeInTime = Date.now()
   │     ├── if (isResponding) → send({ type: 'response.cancel' })
   │     ├── isResponding = false
   │     ├── aiTranscript = ''
   │     ├── _retryResponseCreateOnDone = false  [Fix 10]
   │     ├── emit('interrupt_audio')
   │     │
   │     ├── Truncate server-side audio context  [Azure best practice]
   │     │     └── send({ type: 'conversation.item.truncate', item_id, audio_end_ms })
   │     │
   │     └── Arm barge-in recovery timer
   │           └── setTimeout(BARGE_IN_RECOVERY_MS = 4000ms)
   │                 └── if isUserSpeaking && !isResponding && isConnected:
   │                       ├── isUserSpeaking = false
   │                       ├── emit('user_speech_stopped')  [Fix 7a]
   │                       └── sendTextResponse(silenceNudge)
   │
   ├── emit('interruption'), emit('user_speaking'), emit('user_speech_started')
   │     NOTE: These three events are emitted on EVERY speech_started, not just barge-in.
   │
   └── Orchestrator receives 'interrupt_audio' (barge-in only):
         └── Calls streamService.stopCurrentAudio(cancelledResponseId)
               ├── silentMode = true  (suppress outgoing audio)
               ├── interrupted = true
               └── _cancelledResponseId = cancelledResponseId
```

### 7.2 `_handleSpeechStopped()`

**Source:** `BaseRealtimeAdapter.js L830-866`

```
input_audio_buffer.speech_stopped
   │
   ├── _speechStoppedAt = Date.now()
   ├── isUserSpeaking = false
   │
   ├── Clear watchdog timer
   │     └── clearTimeout(_deferredFlushWatchdog)
   │
   ├── Clear barge-in recovery timer
   │     └── clearTimeout(_bargeInRecoveryTimer)
   │
   ├── emit('user_stopped_speaking'), emit('user_speech_stopped')
   │
   ├── if vadMode === 'none': send({ type: 'input_audio_buffer.commit' })
   │
   └── Flush deferred instruction  [if not currently responding]
         └── if _deferredInstruction && !isResponding:
               ├── log('rag_deferred_flush')
               ├── deferred = _deferredInstruction; _deferredInstruction = null
               └── send(_buildResponseCreate({ input: [system message with deferred] }))
```

---

## 8. Response Lifecycle

### 8.1 `response.created`

**Source:** `BaseRealtimeAdapter.js L1344-1370`

```
response.created
   ├── _firstDeltaLogged = false
   ├── _earlyDupChecked = false      [Fix 9]
   ├── Reset playback tracking (Twilio)
   ├── isResponding = true
   ├── _currentResponseId = null     (set on first audio.delta)
   ├── _currentResponseItemId = null (set on first audio.delta)
   ├── _truncateAudioEndMs = 0
   ├── if vadMode === 'none': clearTimeout(silenceCommitTimer), pendingAudioSinceCommit = false
   └── log + emit
```

### 8.2 `response.audio_transcript.delta` — Early Duplicate Detection

**Source:** `BaseRealtimeAdapter.js L638-652`

```
response.audio_transcript.delta
   │
   ├── aiTranscript += message.delta
   │
   └── if (!_earlyDupChecked && aiTranscript.length >= 80)  [Fix 9]
         ├── _earlyDupChecked = true  (once per response)
         └── if _isEarlyDuplicate(aiTranscript):
               ├── log('early_duplicate_cancelled')
               └── send({ type: 'response.cancel' })
                     └── Cuts off duplicate before full audio streams to caller
```

**`_isEarlyDuplicate(partialText)` logic:**
- Normalize: lowercase, strip non-alphanumeric
- Compare prefix against each entry in `_recentAiResponses` (last 3)
- Match: `commonPrefix >= 40 chars && commonPrefix / partialLength > 0.8`

### 8.3 `response.audio_transcript.done` — Full Transcript Processing

**Source:** `_handleAITranscriptDone()` at `BaseRealtimeAdapter.js L1210-1300`

```
response.audio_transcript.done
   │
   ├── aiText = this.aiTranscript || message.transcript
   ├── this.aiTranscript = ''  (reset for next response)
   │
   ├── GATE: if empty → return
   ├── GATE: if wordCount > 200 → discard as corrupted
   │
   ├── Hallucination scan
   │     └── scanForHallucination(aiText, _lastRelevantKnowledge)
   │           └── if hallucinated: add fallback to context, session.update with override, response.create
   │
   ├── Response deduplication
   │     └── _isResponseDuplicate(aiText)
   │           ├── Check against _recentAiResponses (rolling window of 3)
   │           ├── Match: prefix overlap > 80% OR word overlap > 80% (requires maxWords > 3, i.e. ≥4 words)
   │           │
   │           └── if DUPLICATE:
   │                 ├── _consecutiveDupSuppressions++
   │                 ├── Do NOT addConversationContext('AI', aiText)  [Fix 8a]
   │                 ├── Still extract entities + update phase
   │                 │
   │                 ├── if _consecutiveDupSuppressions >= 3 → loop breaker correction
   │                 │     "CRITICAL: You have repeated the same response multiple times..."
   │                 └── else → standard correction
   │                       "You just repeated a previous response..."
   │                 │
   │                 ├── sendTextResponse(correction)  [Fix 8b: immediate, not deferred]
   │                 └── return
   │
   ├── NOT duplicate:
   │     ├── _consecutiveDupSuppressions = 0
   │     ├── _recentAiResponses managed inside _isResponseDuplicate() (push + cap at 3)
   │     ├── addConversationContext('AI', aiText)
   │     ├── extractEntities(aiText, 'AI')
   │     ├── _updatePhase()
   │     ├── _addContextWords(aiText)
   │     ├── _checkLanguageDrift(aiText)
   │     ├── emit('ai_transcript', aiText)
   │     └── insertConversation(callSID, recipient, 'bot', aiText)
   │
   └── Hangup analysis (if applicable)
         ├── GATE: phase not in ['voicemail','rejected','success','screening','opening']
         ├── GATE: shouldPerformAnalysis(count, hasEmail)
         └── quickHangupDecision() or full LLM analyzeConversationForHangup()
```

### 8.4 `response.done` — Drain & Recovery

**Source:** `_handleResponseDone()` at `BaseRealtimeAdapter.js L1375-1510`

```
response.done
   │
   ├── isResponding = false
   ├── _firstDeltaLogged = false
   ├── _currentResponseId = null
   ├── _currentResponseItemId = null
   ├── _truncateAudioEndMs = 0
   ├── _lastAutoResponseTs = null
   ├── _clearResponseTimeout()
   │
   ├── BRANCH 1: Timeout-triggered cancel  [Fix 6c]
   │     └── if _responseTimeoutActive:
   │           ├── _responseTimeoutActive = false
   │           ├── Clear _responseTimeoutGuard
   │           ├── log('response_done_after_timeout')
   │           ├── sendTextResponse(bilingual fallback)  [Fix 6e]
   │           └── return  ← skip ALL drains
   │
   ├── BRANCH 2: Rejected response retry  [Fix 10]
   │     └── if _retryResponseCreateOnDone:
   │           ├── _retryResponseCreateOnDone = false
   │           ├── log('response_create_retry_after_done')
   │           ├── send(_buildResponseCreate({}))
   │           └── return
   │
   ├── BRANCH 3: Failed/incomplete  [Fix 6d]
   │     └── if status === 'failed' || 'incomplete': skip queue drains
   │
   ├── BRANCH 4: Normal drain chain
   │     │
   │     ├── Priority 1: _deferredTextResponse
   │     │     └── sendTextResponse(pending), return  ← drains one per cycle
   │     │
   │     └── Priority 2: _deferredUserInputQueue  [Fix 2]
   │           ├── GUARD: if isResponding → send(response.cancel) first
   │           ├── Shift oldest entry
   │           └── insertUpdatedPrompt(dq, dd)  ← re-enters §6.2
   │
   ├── Token tracking (runs after drain chain, not exclusive branch)
   │     ├── totalInputTokens += usage.input_tokens
   │     ├── totalOutputTokens += usage.output_tokens
   │     └── if !_tokenBudgetExceeded && maxTotalTokenBudget > 0
   │           && totalTokens > maxTotalTokenBudget (12000) → _tokenBudgetExceeded = true, close()
   │
   └── Orphaned pendingRC flush (runs after drain chain, not exclusive branch)
         └── if _pendingResponseCreate && !_pendingSessionUpdate && !isResponding:
               └── send(orphaned pendingRC)
```

---

## 9. Error Recovery & Timeouts

### 9.1 Response Timeout

**Source:** `BaseRealtimeAdapter.js L1988-2035`

```
send(message) intercepts every response.create:
   └── _startResponseTimeout()
         └── setTimeout(RESPONSE_TIMEOUT_MS = 10000ms)
               │
               ├── GATE: if !isResponding || !isConnected → return  [Fix 6b: || not &&]
               │
               ├── log('response_timeout')
               ├── _responseTimeoutActive = true  [Fix 6c: flag for response.done]
               ├── send({ type: 'response.cancel' })
               │
               └── _responseTimeoutGuard = setTimeout(2000ms)
                     ├── if _responseTimeoutActive && isConnected:
                     │     ├── isResponding = false
                     │     └── sendTextResponse(bilingual fallback)  [Fix 6e]
                     └── if _responseTimeoutActive && !isConnected:
                           ├── _responseTimeoutActive = false
                           └── isResponding = false  (cleanup only, no TTS)

_clearResponseTimeout():
   ├── Called by: _handleResponseDone, cancelResponse, handleClose, close()
   │   (NOTE: intended to be called by first_audio_delta via Fix 6a,
   │    but pre-switch block claims _firstDeltaLogged first — see §5.2)
   └── Clears both _responseTimeoutTimer and _responseTimeoutGuard
```

### 9.2 `conversation_already_has_active_response` Error

**Source:** `BaseRealtimeAdapter.js L599-612`

```
error event with code='conversation_already_has_active_response'
   │
   ├── if (_firstDeltaLogged) → _clearResponseTimeout()  [Fix 6f]
   │     (Active response is already producing audio — our RC was redundant)
   │
   ├── _retryResponseCreateOnDone = true  [Fix 10]
   │     (Server still processing cancelled response — retry after its response.done)
   │
   └── log('response_create_queued_for_retry')
```

### 9.3 Rate Limit Handling

**Source:** `BaseRealtimeAdapter.js L1536-1568, L2046`

```
rate_limits.updated
   └── if any limit.remaining <= 2:
         └── _rateLimitBackoffUntil = Date.now() + (resetSeconds * 1000)

send():
   └── if message.type === 'response.create' && _rateLimitBackoffUntil > Date.now():
         └── setTimeout(delayMs, () => send(message))  ← delayed retry
```

### 9.4 Token Budget Enforcement

**Source:** `BaseRealtimeAdapter.js L1487-1501`

| Parameter | Value |
|-----------|-------|
| `maxTotalTokenBudget` | `Number(env.MAX_TOTAL_TOKEN_BUDGET) \|\| 12000` |
| Trigger | `totalInputTokens + totalOutputTokens > maxTotalTokenBudget` |
| Action | `close()` — terminates WebSocket connection |

---

## 10. `sendTextResponse()` — Direct Text Response

**Source:** `BaseRealtimeAdapter.js L1572-1617`

```
sendTextResponse(text)
   │
   ├── GATE: if !isConnected → return
   │
   ├── GATE: if isResponding → _deferredTextResponse = text, return
   │     └── Drained in _handleResponseDone (§8.4, Priority 1)
   │
   ├── Build full instruction via lang.buildTurnPrompt() with text as userQuestion
   │     └── conversationContext included, but NO KB retrieval, NO session.update
   │
   ├── BRANCH: Silence nudge detection
   │     └── if text starts with 'SILENCE CHECK'/'SILENCE GOODBYE'/'STILLE VERABSCHIEDUNG'/'SILENCE CHECK — ÜBERSCHREIBT':
   │           └── Extract exact phrase via regex: /(?:ONLY|EXACTLY|NUR|EXAKT):\s*'([^']+)'/
   │                 (falls back to full text if no match)
   │           └── response.create with `instructions: "Speak ONLY..."`, `conversation: 'none'`, `input: []`
   │
   └── NORMAL: send(_buildResponseCreate({ input: [system message with fullInstruction] }))
         └── NOTE: No session.update — uses current session instructions
         └── NOTE: buildTurnPrompt hardcodes `decision: 'high'` and `toneDirective: null`
```

---

## 11. Silence Timers

**Source:** `BaseRealtimeAdapter.js L1770-1798`

Gated by `_enableSilenceTimers` (Twilio: `true`, Plivo: `false` in main call session; legacy Plivo wrapper may set `true`)

```
startFirstSilenceTimer()
   ├── GATE: if _callClosed → return
   ├── Effective timeout = FIRST_SILENCE_TIMEOUT (12s) + remaining playback estimate
   └── On fire:
         ├── GATE: if isBeingScreened || _callClosed → return
         └── sendTextResponse(silenceNudge.first) → startSecondSilenceTimer()

startSecondSilenceTimer()
   ├── Timeout = SECOND_SILENCE_TIMEOUT (15s)
   └── On fire: sendTextResponse(silenceNudge.second) → emit('silence_hangup')

resetSilenceTimers()
   └── Called after every clean user transcript
```

---

## 12. Entity Extraction & Phase Management

### 12.1 Extracted Entities

| Entity | Pattern | Phase Gate |
|--------|---------|-----------|
| `userEmail` | `/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/` | — |
| Email confirm | `/yes\|correct\|right\|ja\|stimmt\|richtig/i` | `conversationPhase === 'email-verify'` |
| Email reject | `/no\|wrong\|incorrect\|nein\|falsch/i` | `conversationPhase === 'email-verify'` |
| `userPhone` | `/(?:\+?\d[\d\s().-]{6,}\d)/` (≥7 digits) | — |
| `offerAccepted` | `/yes\|sure\|okay\|sounds good\|ja\|natürlich/i` | `conversationPhase === 'offer'` |
| `emailRefused` | `/no email\|don't want to share\|keine e-?mail/i` | `conversationPhase === 'email-collection'` |
| `preferredSlot` | Day/time patterns (en+de) | `conversationPhase === 'slot-collection'` |

### 12.2 Conversation Phases

Managed by `computePhase()` in `Helper/conversationPhase.js`. Phases progress based on entity presence and turn count:

`opening` → `discovery` → `offer` → `email-collection` → `email-verify` → `slot-collection` → `success`

Side exits: `voicemail`, `rejected`, `screening`

---

## 13. Reconnection

**Source:** `BaseRealtimeAdapter.js L2155-2210`

| Parameter | Value |
|-----------|-------|
| `maxReconnectAttempts` | `3` |
| `baseReconnectDelay` | `1000ms` |
| Backoff | Exponential: `baseReconnectDelay * 2^(attempt-1)` → 1s, 2s, 4s |
| Trigger | Abnormal close (code 1006) or server error (≥1011), excluding region errors |
| Non-reconnect closes | Code 1001 (ping timeout, normal close) — does NOT trigger reconnect |
| On reconnect | `handleOpen()` with `isReconnect=true` → skip greeting, use operational/reconnect instructions |
| Reset | `reconnectAttempts = 0` on successful `handleOpen()` |
| Region errors | Emit `region_error` event, no reconnection attempted |

---

## 14. StreamService (Plivo) — Audio Gating

**Source:** `services-plivo/stream-service-plivo.js`

### Silent Mode State Machine

```
State: silentMode=false, interrupted=false
   │
   ├── Event: Orchestrator calls streamService.stopCurrentAudio(cancelledResponseId)
   │     (triggered by 'interrupt_audio' event from adapter during barge-in)
   │     ├── silentMode = true
   │     ├── interrupted = true
   │     └── _cancelledResponseId = cancelledResponseId
   │
   ├── Event: sendAudioDirect() called while silentMode=true
   │     ├── GATE 0: if holdMode → bypass silentMode entirely
   │     │
   │     ├── CHECK 1: Turn advanced past interruption?
   │     │     └── YES → silentMode=false, interrupted=false  [Fix 7b]
   │     │
   │     ├── CHECK 2: Is audio from cancelled response?
   │     │     └── YES → DROP audio
   │     │
   │     ├── CHECK 3: Is user currently speaking?
   │     │     └── YES → DROP audio
   │     │
   │     └── CHECK 4: New response + !userSpeaking
   │           └── silentMode=false → deliver audio to caller
   │
   ├── Additional hard gates before media send:
   │     ├── assertTurnActive(scheduledTurn)
   │     ├── ws.readyState === 1 (OPEN)
   │     └── ws.bufferedAmount < 5MB (backpressure guard)
   │
   └── State: silentMode=false → all audio delivered normally
```

---

## 15. Context Summarization

**Source:** `conversationEngine.js L195-215`

| Parameter | Value |
|-----------|-------|
| Trigger threshold | `conversationContext.length > 12` |
| Strategy | Summarize first half of context array (cumulative — appended to previous summary) |
| Guard | `_summarizationInFlight` prevents concurrent summarization |
| Error handling | Failures swallowed to keep runtime resilient |
| Post-summary | Context array truncated to newer half |
| Result | `_contextSummary` prepended to formatted context: `[Earlier: summary]\n...` |

---

## 16. Complete State Variable Reference

### Boolean Flags

| Variable | Meaning | Set true by | Set false by |
|----------|---------|-------------|--------------|
| `isResponding` | AI is generating a response | `_handleAudioDelta`, `_handleResponseCreated` | `_handleAudioDone`, `_handleResponseDone`, barge-in |
| `isUserSpeaking` | User is currently speaking | `_handleSpeechStarted` | `_handleSpeechStopped`, barge-in recovery, watchdog |
| `isConnected` | WebSocket is open | `handleOpen` | `handleClose`, `close()` |
| `isSessionConfigured` | First `session.updated` received | `session.updated` handler | — |
| `_greetingDelivered` | Greeting audio fully played | `_handleAudioDone` (first response), `handleOpen` (reconnect) | — |
| `_greetingPending` | Waiting to fire greeting | `handleOpen` (first connect) | `_fireGreeting` |
| `_firstDeltaLogged` | First audio delta in current response | `_handleAudioDelta` | `_handleResponseCreated`, `_handleResponseDone` |
| `_pendingSessionUpdate` | session.update sent, waiting for confirmation | `insertUpdatedPrompt` | `session.updated` handler |
| `_responseTimeoutActive` | Timeout fired, waiting for cancel's response.done | timeout handler | `_handleResponseDone`, timeout guard, `handleClose`, `close()` |
| `_earlyDupChecked` | Early dup check done for current response | transcript.delta handler | `_handleResponseCreated` |
| `_retryResponseCreateOnDone` | RC rejected, retry on next response.done | error handler | `_handleResponseDone`, barge-in |
| `_tokenBudgetExceeded` | Total tokens exceeded budget | `_handleResponseDone` | — |
| `silentMode` (StreamService) | Suppress outgoing audio | `stopCurrentAudio()` (via interrupt_audio) | New response audio / turn advance |

### Deferred Queues

| Variable | Type | Max Size | Set by | Consumed by |
|----------|------|----------|--------|-------------|
| `_deferredUserInputQueue` | `Array<{userQuestion, decision}>` | 3 | `insertUpdatedPrompt` (when `isResponding`) | `_handleResponseDone` drain |
| `_deferredTextResponse` | `string \| null` | 1 | `sendTextResponse` (when `isResponding`) | `_handleResponseDone` Priority 1 |
| `_deferredInstruction` | `string \| null` | 1 | `insertUpdatedPrompt` (when `isUserSpeaking`) | `_handleSpeechStopped` flush, watchdog |
| `_pendingResponseCreate` | `object \| null` | 1 | `insertUpdatedPrompt` (server_vad, idle) | `session.updated` handler, orphan flush |

### Timers

| Timer | Timeout | Armed by | Cleared by | Action on fire |
|-------|---------|----------|------------|----------------|
| `_greetingFallbackTimer` | `env.GREETING_FALLBACK_TIMEOUT_MS \|\| 500ms` | `handleOpen` | `_fireGreeting` | Force greeting if session.updated delayed |
| `_deferredFlushWatchdog` | `BARGE_IN_RECOVERY_MS (4000ms)` | `_handleSpeechStarted` | `_handleSpeechStopped` | Flush _deferredInstruction if speech_stopped missing. Condition: `_deferredInstruction && isUserSpeaking && !isResponding && isConnected` |
| `_bargeInRecoveryTimer` | `BARGE_IN_RECOVERY_MS (4000ms)` | barge-in branch | `_handleSpeechStopped` | Send silence nudge if user goes quiet after barge-in |
| `_responseTimeoutTimer` | `RESPONSE_TIMEOUT_MS (10000ms)` | `send()` on response.create | `_clearResponseTimeout` (first_audio_delta) | Cancel + flag for fallback |
| `_responseTimeoutGuard` | `2000ms` | timeout handler | `_clearResponseTimeout`, response.done | Force recovery if response.done never arrives |
| `firstSilenceTimer` | `FIRST_SILENCE_TIMEOUT (12s) + playback` | `handleOpen`, `resetSilenceTimers` | speech handlers, `clearSilenceTimers` (disconnect/close) | First silence nudge |
| `secondSilenceTimer` | `SECOND_SILENCE_TIMEOUT (15s)` | `startSecondSilenceTimer` | `resetSilenceTimers`, `clearSilenceTimers` (disconnect/close) | Second nudge + hangup emit |
| `silenceCommitTimer` | `SILENCE_COMMIT_MS (400ms)` | `sendAudio` (vad=none) | next sendAudio, `response.created` (vad=none), `clearSilenceTimers` | Commit audio buffer + response.create. Condition: `isConnected && pendingAudioSinceCommit && !isResponding` |
| `_screeningTimeout` | `_screeningGraceMs (10000ms)` | screening detection | human reconnect | Clear isBeingScreened |
| `_holdTimer` | `15000ms` | hold detection | hold resume | "Still there?" nudge |
| `pingInterval` | `PING_INTERVAL_MS (30000ms)` | `startPing` | `clearPing`, close | WebSocket keepalive |
| `pongTimeout` | `PING_TIMEOUT_MS (10000ms)` | ping sent | pong received, `clearPing` | `ws.close(1001, 'Ping timeout')` — does NOT trigger reconnect (code 1001 ≠ 1006/≥1011) |

---

## 17. Latency Compensation Config

**Source:** `config/latencyResponsivenessConfig.js`

Adaptive context/KB reduction when response latency overruns are frequent.

| Parameter | Default | Env Override |
|-----------|---------|-------------|
| `enabled` | `false` | `PHASE3_LATENCY_COMPENSATION_ENABLED=true` |
| `windowSize` | `5` | `PHASE3_LATENCY_WINDOW_SIZE` |
| `lightThreshold` | `2` overruns in window | `PHASE3_LATENCY_LIGHT_THRESHOLD` |
| `aggressiveThreshold` | `4` overruns in window | `PHASE3_LATENCY_AGGRESSIVE_THRESHOLD` |
| `lightMaxContextTurns` | `6` | `PHASE3_LATENCY_LIGHT_MAX_CONTEXT` |
| `aggressiveMaxContextTurns` | `3` | `PHASE3_LATENCY_AGGRESSIVE_MAX_CONTEXT` |
| `skipKbOnAggressive` | `true` (unless env=`false`) | `PHASE3_LATENCY_SKIP_KB` |
| `fillerEnabled` | `false` | `PHASE3_LATENCY_FILLER_ENABLED=true` |

**Effect on `insertUpdatedPrompt`:**
- `NONE`: maxTurns = 8, full KB retrieval
- `LIGHT`: maxTurns = 6, full KB retrieval
- `AGGRESSIVE`: maxTurns = 3, KB skipped (if `skipKbOnAggressive`)
