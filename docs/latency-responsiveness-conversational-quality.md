📘 PHASE 3 — Latency, Responsiveness & Conversational Quality

1. Purpose of Phase 3

Phase 3 improves:
	•	Perceived latency
	•	Conversational pacing
	•	Natural turn flow
	•	Responsiveness under load

WITHOUT:
	•	Changing when the bot is allowed to speak
	•	Weakening silence-by-default
	•	Modifying InteractionMode
	•	Touching EdgeSession
	•	Adding heuristics or ML to hot paths


2. Architectural Invariants (MUST REMAIN TRUE)
	1.	Speech permission is governed only by:
	•	InteractionMode
	•	Guarded policy
	2.	Silence remains default
	3.	Human override remains absolute
	4.	No inference from system audio
	5.	No additional blocking in hot path

If any Phase 3 change violates these, Phase 3 fails.


3. Phase 3 Scope

Phase 3 has FOUR subsystems:

3.1 Latency Budgeting

3.2 Safe Response Pre-Warm

3.3 Conversational Pacing Control

3.4 Optional Safe Micro-Acknowledgements (Phase 3.1)

Each is optional and reversible.


4. Phase 3.1 — Latency Budgeting

Objective

Make latency predictable and consistent.

Latency Targets (Soft Targets)

Stage	Target
Speech end → STT partial	≤ 200 ms
STT final → response start	≤ 300 ms
Total perceived delay	≤ 600 ms

Rules
	•	No new awaits
	•	No retries in hot path
	•	No filler speech
	•	No artificial delays

If latency spikes:
→ Silence
→ No compensatory behavior


5. Phase 3.2 — Safe Response Pre-Warm

Pre-warm means preparing a response early, not speaking early.

Preconditions

Pre-warm allowed only if:

InteractionMode === INTERACTIVE
AND currentTurnId valid
AND no interruption

Forbidden
	•	Prewarm during TRANSITIONAL
	•	Prewarm during NON_INTERACTIVE
	•	Prewarm during guarded speech
	•	Prewarm before human proof

Edge Cases Covered
	•	User interrupts → drop prewarm state
	•	Partial STT revised → discard old prewarm
	•	TurnId changes → discard


6. Phase 3.3 — Conversational Pacing

Goal: avoid robotic rapid-fire responses.

Controls
	•	Break long TTS into chunks
	•	Insert 50–150ms natural pauses
	•	Cap utterances at 12–15 seconds

Forbidden
	•	Changing semantic meaning
	•	Adding filler content
	•	Injecting new dialogue


7. Phase 3.4 — Safe Micro-Acknowledgements (Optional)

⚠ Default: OFF
⚠ Feature-flag required


Definition

A micro-acknowledgement (MA) is:
	•	≤ 300 ms neutral audio
	•	No semantic content
	•	No intent
	•	No new turn
	•	Cancelable instantly

Examples:
	•	“Okay.”
	•	“Mm-hm.”


Preconditions (ALL required)

Condition	Requirement
InteractionMode	INTERACTIVE
Confidence	STT ≥ 0.80
Continuous speech	≥ 900 ms
No pause ≥ 180 ms	
No previous MA in turn	
Latency budget not exceeded	


Timing Window

Emit between:

900 ms and 1800 ms of continuous speech

After 1800 ms → do nothing.

⸻

Hard Restrictions
	•	Only ONE MA per turn
	•	Never during voicemail
	•	Never during screening
	•	Never during IVR
	•	Never during hold
	•	Never predictive
	•	Never semantic
	•	Never multi-language guessing


Cancellation Rules (Mandatory)

If user continues speaking:
→ Stop MA immediately

If interruption fires:
→ Stop MA immediately

If turnId changes:
→ Cancel

If STT confidence drops:
→ Cancel


8. Complete Edge Case Handling Matrix

Case A — Voicemail

MA disabled (InteractionMode ≠ INTERACTIVE)

Case B — iOS Screening

MA disabled

Case C — IVR

MA disabled

Case D — Call Hold

MA disabled

Case E — User switches language mid-sentence

Language remains sticky per turn

Case F — Network jitter

No retries, no compensation

Case G — Double interruption

Idempotent cancellation

Case H — Long monologue (10+ seconds)

MA allowed once only

Case I — STT low confidence

No MA

Case J — Guarded speech in progress

MA disabled

Case K — Late timer firing

Bound to turnId


9. Acceptance Criteria

Phase 3 is accepted only if:
	•	No Phase 2 invariant weakened
	•	No early speech before human proof
	•	No MA during system audio
	•	No latency regression
	•	Silence remains safe fallback
	•	All new features behind flags
	•	EdgeSession unchanged


10. Rejection Criteria

Reject if:
	•	Bot speaks earlier than before
	•	MA becomes conversational
	•	MA fires during system audio
	•	Prewarm emits TTS
	•	New awaits added to hot path
	•	EdgeSession modified