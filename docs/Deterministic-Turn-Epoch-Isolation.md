
📘 PHASE2_IMPLEMENTATION_GUIDE.md

Deterministic Turn / Epoch Isolation

VoiceBot – Concurrency Hardening Layer


1️⃣ PURPOSE

This document defines the exact implementation plan for Phase 2:

Deterministic Turn / Epoch Isolation

The goal is to eliminate all race conditions and ensure that:
	•	Only the currently active conversational turn can produce side effects.
	•	No async callback can mutate state if stale.
	•	No timer can execute if the turn has changed.
	•	No hangup can fire for a stale turn.
	•	No audio can emit after interruption.
	•	No async code executes after WebSocket close.

This layer must be implemented without modifying business logic.


2️⃣ SCOPE

Phase 2 applies to:
	•	Twilio WebSocket handler
	•	Plivo WebSocket handler
	•	Any location that consumes:
	•	realtimeServiceTwilio
	•	realtimeServicePlivo
	•	All setTimeout
	•	All Azure event callbacks
	•	All hangup scheduling
	•	All audio emission

This phase must NOT modify:
	•	RAG logic
	•	InteractionMode logic
	•	Persona layer
	•	Transaction policy
	•	Prompt logic
	•	Business decisions


3️⃣ CORE INVARIANT

The system must enforce:

Only code executing under the currently active turnId may produce side effects.

Side effects include:
	•	Emitting audio
	•	Scheduling hangup
	•	Disconnecting call
	•	Mutating conversation state
	•	Emitting decision events
	•	Executing delayed callbacks


4️⃣ ARCHITECTURE REQUIREMENTS


4.1 Per-Connection Turn State

Inside each WebSocket connection (Twilio and Plivo), define:

const { v4: uuidv4 } = require('uuid');

const turnState = {
  currentTurnId: null,
  isClosed: false
};

function newTurn() {
  turnState.currentTurnId = uuidv4();
  return turnState.currentTurnId;
}

This must:
	•	Be scoped per WebSocket.
	•	Not be global.
	•	Not modify EdgeSession structure.
	•	Not leak across calls.


4.2 Initial Turn

Immediately after connection start:

newTurn();

This defines the first epoch.


4.3 Turn Invalidation Triggers

newTurn() MUST be called in the following events:

A) On interruption (user_speech_started)

Before:
	•	stopCurrentAudio()
	•	cancelResponse()
	•	clearing chunks

B) On Azure response.created

C) Before scheduling silence-hangup

This invalidates all previous async work.


5️⃣ ASYNC GATING RULES


5.1 Gating All Azure Callbacks

At the top of every callback handling:
	•	response.audio.delta
	•	response.audio.done
	•	response.audio_transcript.done
	•	conversation.item.input_audio_transcription.completed
	•	decision
	•	silence_hangup
	•	Any custom realtime event

Insert:

const myTurn = turnState.currentTurnId;

if (turnState.isClosed) return;
if (myTurn !== turnState.currentTurnId) return;

No callback may execute without this.


5.2 Gating All setTimeout

Every setTimeout must follow this pattern:

const scheduledTurn = turnState.currentTurnId;

setTimeout(() => {
  if (turnState.isClosed) return;
  if (scheduledTurn !== turnState.currentTurnId) return;

  // original logic
}, delay);

This applies to:
	•	Silence timers
	•	Hangup timers
	•	Audio batching
	•	Delayed disconnect
	•	Any pacing logic

No exceptions.


5.3 Gating Audio Emission

Before calling:

streamService.sendAudioDirect(...)

Add:

if (turnState.isClosed) return;
if (myTurn !== turnState.currentTurnId) return;

No stale audio may emit.


6️⃣ WEBSOCKET CLOSE RULE

Inside:

ws.on('close')

Add at top:

turnState.isClosed = true;
turnState.currentTurnId = null;

After this:
	•	All timers must be cleared.
	•	No async code may execute.


7️⃣ DENOSIER ISOLATION

Each WebSocket connection must:
	•	Instantiate its own RealTimeRNNoise.
	•	Destroy it on close.
	•	Never share denoiser across calls.


8️⃣ REJECTION CRITERIA

Cursor must reject implementation if:
	•	Any async callback lacks turn gating.
	•	Any setTimeout lacks turn gating.
	•	newTurn() not called on interruption.
	•	newTurn() not called on response.created.
	•	WebSocket close does not invalidate turnState.
	•	Any global turn state is introduced.
	•	Any new await is introduced in hot path.
	•	Any business logic is modified.


9️⃣ ACCEPTANCE TEST MATRIX

After implementation, the system must pass:


Test 1: Interruption During TTS
	1.	Bot speaking.
	2.	User interrupts.
	3.	Late Azure audio delta arrives.

Expected:
	•	No audio emitted.
	•	No stale TTS heard.


Test 2: Silence Hangup Cancelled
	1.	Silence timer starts.
	2.	User speaks before timeout.
	3.	Timer fires anyway.

Expected:
	•	Hangup does NOT execute.


Test 3: Late Decision Result
	1.	AI decision slow.
	2.	User resumes conversation.
	3.	Decision returns late.

Expected:
	•	Decision ignored.


Test 4: WebSocket Close with Pending Timer
	1.	Timer scheduled.
	2.	WebSocket closes.
	3.	Timer fires.

Expected:
	•	No execution.
	•	No error.
	•	No disconnect.


Test 5: Rapid Consecutive Turns

Multiple back-to-back interruptions.

Expected:
	•	Only most recent turn active.
	•	No leakage across turns.


🔟 OUTPUT REQUIREMENTS FROM CURSOR

After implementation, Cursor must provide:
	1.	List of modified files.
	2.	List of all callbacks updated.
	3.	Count of setTimeout patched.
	4.	Confirmation no await added.
	5.	Confirmation EdgeSession unchanged.
	6.	Confirmation no business logic modified.


1️⃣1️⃣ VALIDATION PHASE

After Cursor completes implementation:

You will provide:
	•	Updated repo
	•	Diff summary

Then I will:
	•	Trace every async path
	•	Trace every timer
	•	Verify deterministic isolation
	•	Attempt to break it conceptually


1️⃣2️⃣ SUCCESS CONDITION

Phase 2 is considered complete only when:
	•	All async side effects are turn-gated.
	•	All timers are turn-gated.
	•	No stale execution possible.
	•	WebSocket close fully invalidates.
	•	No regression introduced.

Only then may Phase 3 or Phase 4 continue.


🧠 FINAL NOTE TO CURSOR

This is not a refactor.
This is not optimization.
This is not feature work.

This is a deterministic concurrency isolation layer.

No improvisation allowed.
