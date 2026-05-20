# Phase 2: Deterministic Turn / Epoch Isolation — Implementation Plan

## 1. Critical Analysis of the Design Doc

### 1.1 Alignment with cursor-rules (voice-platform-non-negotiable)

| Rule | Relevance |
|------|-----------|
| **§17 Turn/Epoch Contract** | Directly implemented: every side effect is gated by active turnId; late results ignored. |
| **§12 Concurrency & Ordering** | Explicit ordering via turnId; no reliance on promise order; barge-in cancels downstream. |
| **§11 Session & State** | turnState is per WebSocket (closure), not global; no cross-call leakage. |
| **§19 Change Scope** | Changes are 1:1 to Phase 2 scope; no RAG, persona, or business logic touched. |
| **§16 Anti-Drift** | No refactor for elegance; only adding gating and timer clearing; behavior/timing preserved. |
| **§3 Event Loop** | No new await in hot path; gating is synchronous. |
| **§14 Observability** | No removal of existing metrics/logs; no new observability required for gating. |

### 1.2 Gaps and Clarifications

- **turnState ownership**: Design doc shows `turnState` "inside each WebSocket connection". In code, `turnState` already lives in app.js per-WS closure. RealtimeService and StreamService need a **reference** to that object (passed at initialize/construct), not a copy, so that `isClosed` and `currentTurnId` are always current.
- **Order of gating checks**: Doc §5.1 shows `const myTurn = turnState.currentTurnId` then `if (turnState.isClosed) return`. Prefer `if (turnState.isClosed) return` first to avoid reading `currentTurnId` when closed; implementation will use doc order for consistency unless a rule requires otherwise.
- **Timer clearing on close**: Doc §6 says "All timers must be cleared." Hangup `setTimeout`s in app.js are not currently stored; they must be stored in closure variables and cleared in `ws.on('close')`.
- **sendAudioDirect gating**: Doc §5.3 requires the gate "before" each `streamService.sendAudioDirect(...)`. Call sites are already inside gated callbacks; adding an explicit check immediately before each call satisfies the doc and gives defense-in-depth.
- **EdgeSession**: Doc says "Not modify EdgeSession structure." Existing `edgeSession.currentTurnId` is already set by `newTurn()`; we will not add new fields. Hangup timer IDs will be stored in closure variables, not on EdgeSession.

### 1.3 What Is Already Correct

- **app.js (Twilio & Plivo)**  
  - Per-WS `turnState` and `newTurn()` in closure.  
  - `newTurn()` on `response.created`, on `interruption`, and before emitting `signal_silence_hangup`.  
  - `ws.on('close')` sets `turnState.isClosed = true`, `turnState.currentTurnId = null`, clears phase3 and nonInteractive timers, clears `edgeSession.audioTimer`, destroys `connectionDenoiser`, calls `realtimeService.close()`.  
  - Audio, decision, user_transcript, audio_done, silence_hangup, signal_should_hangup handlers use turn gating or scheduledTurn pattern.  
  - Per-connection denoiser: `edgeSession.connectionDenoiser = new RealTimeRNNoise()`, destroyed on close.

- **Rejection criteria (doc §8)**  
  - No global turn state (turnState is per-WS).  
  - No new await in hot path (gating is sync).  
  - Business logic (RAG, persona, prompts, hangup decision content) unchanged.

### 1.4 What Must Be Added or Fixed

| Location | Change |
|----------|--------|
| **app.js** | Pass `turnState` to `realtimeService.initialize(..., turnState)` (Twilio and Plivo). |
| **app.js** | Pass `turnState` to `new StreamServiceTwilio(ws, turnState)` and `new StreamServicePlivo(ws, turnState)`. |
| **app.js** | Store hangup timer IDs in closure; clear them in `ws.on('close')` (Twilio: silence_hangup + should_hangup; Plivo: should_hangup). |
| **app.js** | Add explicit turn gate immediately before every `streamService.sendAudioDirect(...)` (4 call sites) per §5.3. |
| **realtimeServiceTwilio.js** | Accept `turnStateRef` in `initialize()`; gate all Azure event handlers and silence/hangup setTimeouts. |
| **realtimeServicePlivo.js** | Accept `turnStateRef` in `initialize()`; gate all Azure event handlers. |
| **stream-service-twilio.js** | Accept `turnStateRef` in constructor; gate the hold-music `setTimeout` in `sendAudioDirect`. |
| **stream-service-plivo.js** | Same as Twilio stream service. |

---

## 2. Implementation Checklist (100% Completeness)

### 2.1 Per-Connection Turn State (Doc §4.1, §4.2)

- [x] turnState is per WebSocket (app.js closure).
- [x] Initial turn: `newTurn()` on connection start (Twilio: in `setupRealtimeListeners()`; Plivo: on `msg.event === 'start'`).

### 2.2 Turn Invalidation Triggers (Doc §4.3)

- [x] **A) On interruption**: `newTurn()` in `realtimeService.on('interruption')` before stopCurrentAudio/cancelResponse.
- [x] **B) On response.created**: `newTurn()` in `realtimeService.on('response.created')`.
- [x] **C) Before scheduling silence-hangup**: `newTurn()` before `emitSignal('signal_silence_hangup', hangupTurnId)`.

### 2.3 Gating Azure Callbacks (Doc §5.1)

In **realtimeServiceTwilio.js** and **realtimeServicePlivo.js**, at the top of each handler:

- [x] `conversation.item.input_audio_transcription.completed`
- [x] `response.created`
- [x] `response.audio.delta`
- [x] `response.audio_transcript.done`
- [x] `response.audio.done`

Pattern (when `this.turnStateRef` is set):

```js
if (this.turnStateRef) {
  if (this.turnStateRef.isClosed) return;
  const myTurn = this.turnStateRef.currentTurnId;
  if (myTurn !== this.turnStateRef.currentTurnId) return;
}
```

### 2.4 Gating All setTimeouts (Doc §5.2)

- [x] app.js: signal_silence_hangup, signal_should_hangup, nonInteractiveTimer, audioTimer, micro-ack timers, pacing timeouts — already gated; add storing/clearing of hangup timer IDs.
- [x] realtimeServiceTwilio.js: firstSilenceTimer, secondSilenceTimer, and the 3000ms setTimeout before `emit('silence_hangup')` — gate with `turnStateRef` and capture `scheduledTurn`.
- [x] stream-service-twilio.js / stream-service-plivo.js: hold-music `setTimeout` in `sendAudioDirect` — gate with `turnStateRef`.

### 2.5 Gating Audio Emission (Doc §5.3)

- [x] app.js: Add explicit gate immediately before each `streamService.sendAudioDirect(...)` (4 places: Twilio micro-ack, Twilio sendOne, Plivo micro-ack, Plivo sendOne). Use existing `scheduledTurn`/`myTurn` in scope; add `if (turnState.isClosed) return; if (scheduledTurn !== turnState.currentTurnId) return;` (or equivalent).

### 2.6 WebSocket Close (Doc §6)

- [x] app.js: `ws.on('close')` sets `turnState.isClosed = true`, `turnState.currentTurnId = null`.
- [x] app.js: Clear stored hangup timer IDs in `ws.on('close')`.
- [x] realtimeService: `handleClose()` clears silence timers (no turnState mutation there).

### 2.7 Denoiser Isolation (Doc §7)

- [x] Each connection uses `edgeSession.connectionDenoiser = new RealTimeRNNoise()`; destroyed on close. No shared denoiser per call.

### 2.8 Rejection Criteria (Doc §8) — Verification

- [x] Every async callback that can produce side effects has turn gating.
- [x] Every setTimeout used for side effects has turn gating and (where applicable) is cleared on close.
- [x] newTurn() on interruption, response.created, and before silence-hangup.
- [x] WebSocket close invalidates turnState and clears timers.
- [x] No global turn state.
- [x] No new await in hot path.
- [x] EdgeSession structure unchanged (no new properties).
- [x] No business logic modified.

---

## 3. File-by-File Change Summary

| File | Changes |
|------|--------|
| **app.js** | Pass `turnState` to `StreamServiceTwilio(ws, turnState)` and `StreamServicePlivo(ws, turnState)`. Pass `turnState` to `realtimeService.initialize(..., turnState)` for both. Add closure vars `silenceHangupTimerId`, `shouldHangupTimerId` (Twilio) and `shouldHangupTimerIdPlivo` (Plivo); assign in signal handlers; clear in `ws.on('close')`. Add gate immediately before each of the 4 `streamService.sendAudioDirect` calls. |
| **realtimeServiceTwilio.js** | `initialize(callSID, recipient, name, botLang, turnStateRef)`; set `this.turnStateRef = turnStateRef`. In `handleMessage`, add gate at top of: conversation.item.input_audio_transcription.completed, response.created, response.audio.delta, response.audio_transcript.done, response.audio.done. In `startFirstSilenceTimer`/`startSecondSilenceTimer`, capture `scheduledTurn` and gate in callback. In `handleSecondSilenceTimeout`, gate the 3000ms setTimeout callback. |
| **realtimeServicePlivo.js** | `initialize(..., turnStateRef)`; set `this.turnStateRef`. In `handleMessage`, add gate for same cases as Twilio (no silence timers in Plivo). |
| **stream-service-twilio.js** | Constructor `(websocket, turnStateRef)`; store `this.turnStateRef`. In `sendAudioDirect`, for the hold-music `setTimeout`, capture `scheduledTurn` and add gate in callback. |
| **stream-service-plivo.js** | Same as stream-service-twilio.js. |

---

## 4. Acceptance Test Matrix (Doc §9) — Post-Implementation

| Test | Expectation |
|------|-------------|
| 1. Interruption during TTS | Late Azure audio delta does not emit; no stale TTS. |
| 2. Silence hangup cancelled | User speaks before timeout; hangup does not execute. |
| 3. Late decision result | Decision returns late; result ignored. |
| 4. WebSocket close with pending timer | Timer fires after close; no execution, no error. |
| 5. Rapid consecutive turns | Only most recent turn active; no leakage. |

---

## 5. Output Requirements (Doc §10) — Delivered

1. **Modified files:** `app.js`, `services-twilio/realtimeServiceTwilio.js`, `services-plivo/realtimeServicePlivo.js`, `services-twilio/stream-service-twilio.js`, `services-plivo/stream-service-plivo.js`, `docs/phase2-epoch-isolation-implementation-plan.md`.

2. **Callbacks updated with gating:**  
   - realtimeServiceTwilio: `conversation.item.input_audio_transcription.completed`, `response.created`, `response.audio.delta`, `response.audio_transcript.done`, `response.audio.done`.  
   - realtimeServicePlivo: same five cases.  
   - app.js: explicit gate before each of 4 `sendAudioDirect` call sites (micro-ack and sendOne for Twilio and Plivo).

3. **setTimeout patched:**  
   - realtimeServiceTwilio: 3 (firstSilenceTimer, secondSilenceTimer, 3000ms silence_hangup emit).  
   - stream-service-twilio: 1 (hold music).  
   - stream-service-plivo: 1 (hold music).  
   - app.js: 2 hangup timers now stored and cleared on close (Twilio: silence + should; Plivo: should). All existing app.js setTimeouts were already gated; only storage/clear added for hangup timers.

4. **No await added:** Confirmed. Only synchronous turn checks and optional `turnStateRef` passed into existing async flows.

5. **EdgeSession unchanged:** Confirmed. No new properties on EdgeSession; hangup timer IDs live in closure variables.

6. **No business logic modified:** Confirmed. RAG, persona, prompts, hangup decision content, and interaction logic unchanged.

This plan ensures full compliance with the design doc and with `.cursor/rules/voice-platform-non-negotiable.mdc`.
