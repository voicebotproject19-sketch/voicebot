
📘 VoiceBot Unlock & Degradation Control — Formal Specification

Version: Phase 2.5.2

Scope: PSTN Real-Time Voice Unlock Control

Applies To: Twilio + Plivo Media Streams



1️⃣ Objective

Design and validate a deterministic unlock control system that:
	•	Prevents false unlock from TV/music/background
	•	Handles telecom jitter & packet loss
	•	Preserves latency (<5ms added compute)
	•	Avoids heavy ML overhead
	•	Fails safe under ambiguity
	•	Remains concurrency-safe

2️⃣ System Architecture Overview

Unlock decision uses:

Transcript Event
   ↓
Human Transcript Validation
   ↓
Degradation State Machine
   ↓
Ambiguity Score Computation
   ↓
Unlock / Clarify / Reject

All logic is deterministic.

No blocking operations.
No buffering delays.
No external inference calls.


3️⃣ Degradation State Machine

States

State	Meaning
NORMAL	Stable audio conditions
DEGRADED	Mild instability detected
SEVERE	High instability / unreliable audio

3.1 NORMAL State

Entry Conditions
	•	Rolling avg confidence ≥ 0.78
	•	Confidence variance ≤ 0.15
	•	No transcript correction bursts
	•	No STT instability

Unlock Threshold

FinalScore ≥ 65

3.2 DEGRADED State

Trigger Conditions (ANY)
	•	Rolling avg confidence < 0.75
	•	Confidence variance > 0.20
	•	2+ truncated transcripts in 3s
	•	STT revision burst
	•	Packet loss > 15% (if detectable)

Unlock Threshold

FinalScore ≥ 75
Single-word unlock disabled
Explicit “confirm” allowed


3.3 SEVERE State

Trigger Conditions (ANY)
	•	Rolling avg confidence < 0.68
	•	Confidence variance > 0.30
	•	STT empty twice
	•	Packet loss > 25%

Unlock Rules

Only explicit confirmation:
	•	confidence ≥ 0.85
	•	FinalScore ≥ 90

Otherwise → Clarification loop

4️⃣ Ambiguity Score Model

Score Range: 0–100

FinalScore =
100 × (
  0.35 * ConfidenceScore
+ 0.25 * AlignmentScore
+ 0.15 * TimingScore
+ 0.10 * StabilityScore
+ 0.10 * EnergyScore
+ 0.05 * DegradationMultiplier
)


4.1 Component Definitions

ConfidenceScore

(confidence - 0.65) / 0.35
clamped 0–1


AlignmentScore

Condition	Score
Direct yes/no alignment	1
Entity-aligned response	1
Partial semantic match	0.5
Unrelated	0


TimingScore

Time from bot finish	Score
300–2000ms	1
2000–3500ms	0.5
Outside	0


StabilityScore

Transcript Pattern	Score
Stable content	1
Moderate variance	0.5
High variance	0

EnergyScore

Near-field detection:

Pattern	Score
Consistent amplitude	1
Mixed	0.5
Background-like	0

DegradationMultiplier

State	Multiplier
NORMAL	1
DEGRADED	0.6
SEVERE	0.2

5️⃣ Clarification Loop Logic

Triggered when:

State	Score Range
NORMAL	45–64
DEGRADED	50–74
SEVERE	<90

Clarification examples:
	•	“I’m hearing background audio. Please confirm clearly.”
	•	“Please say confirm to proceed.”

Limit: Maximum 2 loops per interaction.

6️⃣ Detailed Scenario Documentation

Scenario A — Clean Yes/No

User: “Yes.”
	•	High confidence
	•	Timing correct
	•	Alignment correct
	•	NORMAL state

Expected:
Unlock immediately.

Scenario B — TV says “Yes”

User silent.

Transcript:
“yes ready”

Evaluation:
	•	Alignment present
	•	EnergyScore low
	•	Timing misaligned
	•	No interruption event
	•	Stability mismatch

Expected:
FinalScore < threshold
→ No unlock
→ Clarification

Scenario C — Restaurant Overlap

Transcript:
“yes chai table”

Evaluation:
	•	Alignment present
	•	Energy mixed
	•	Stability moderate

If score ≥ threshold:
Unlock

Else:
Clarify

Scenario D — Packet Loss 15%

Transcript sequence unstable.

Degradation state → DEGRADED

Single-word unlock disabled.

Expected:
Clarification or explicit confirm required.

Scenario E — Packet Loss 30%

SEVERE state.

Only explicit “confirm” accepted.

Expected:
Clarification loop.


Scenario F — Multilingual Chaos

Transcript:
“haan chai”

Alignment:
Yes in Hindi.

If timing aligned and stable:
Unlock.

Else:
Clarify.

Scenario G — Entity Corruption

Transcript:
“transfer 50 table”

Entity validation fails.

Expected:
Reject entity.
Clarify

Scenario H — Jitter Reordering

Transcript arrives out of order.

Turn isolation prevents stale unlock.

Expected:
Safe.

7️⃣ Validation Test Plan

7.1 Functional Tests
	•	Clean speech unlock
	•	Yes/no
	•	Numeric capture
	•	Email capture
	•	Explicit confirm


7.2 Noise Tests
	•	TV background
	•	Music vocals
	•	Multiple speakers
	•	Whisper user

7.3 Telecom Tests
	•	10% packet loss
	•	20% packet loss
	•	30% packet loss
	•	200ms jitter spike
	•	Out-of-order transcripts

7.4 Chaos Tests
	•	TV + packet loss
	•	Multilingual + jitter
	•	Background yes at exact timing
	•	Delayed transcript after response.created


8️⃣ Latency Validation

Measure:
	•	Time from transcript to unlock decision
	•	CPU time per scoring
	•	Average overhead

Expected:
<5ms additional compute per transcript event.

No perceptible conversational delay.


9️⃣ Observability Requirements

Log:
	•	Degradation state transitions
	•	FinalScore per transcript
	•	Clarification triggers
	•	Unlock vs clarify ratio
	•	False unlock detection signals

Metrics:
	•	% Clarification Rate
	•	% False Unlock Incidents
	•	Avg Degradation Duration
	•	Avg Confidence Variance


🔟 Production Safeguards
	•	Hard cap: no more than 2 clarification loops
	•	Timeout for severe degradation
	•	Automatic reset to NORMAL after stable period
	•	Explicit confirmation required for high-risk actions


1️⃣1️⃣ Risk Assessment

Risk	Mitigation
TV perfectly mimics user	Clarification loop
Severe packet loss	Degradation state
Multilingual noise	Alignment scoring
Jitter reordering	Turn isolation
Entity corruption	Structural validation


1️⃣2️⃣ Final Engineering Position

This approach:

✔ Is deterministic
✔ Is telecom-aware
✔ Preserves latency
✔ Avoids heavy ML
✔ Is concurrency-safe
✔ Is production scalable

Confidence: ~9 / 10 for PSTN voice unlock control.