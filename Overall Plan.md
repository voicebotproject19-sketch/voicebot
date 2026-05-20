

🧠 CURRENT STATE RECAP

Completed:
	•	Phase 1 (bug fixes)
	•	Phase 2 (turn isolation)
	•	Phase 2.5 (interaction mode)
	•	Phase 3 implemented (pending validation)
	•	Phase 4 scaffolded

Planned:
	•	Full refactor
	•	Multi-STT
	•	Multi-TTS
	•	Provider-agnostic transport
	•	VAD remains provider-controlled

🎯 FINAL HOLISTIC PLAN (Structured & Practical)

We break this into 7 controlled stages.

🔵 STAGE 0 — Hard Baseline Freeze

Before touching architecture:

Add Telemetry Layer

Standardize metrics emitted per call:

callId
provider
sttProvider
ttsProvider
llmProvider
market
persona

unlockScore
unlockDecision
confidenceNormalized
degradationState
clarificationCount

speechStartTs
speechStopTs
transcriptLatencyMs
firstAudioFrameLatencyMs
totalResponseTimeMs

Acceptance Criteria
	•	Same unlock rate for Twilio vs Plivo
	•	Same degradation distribution
	•	Same clarification frequency

This becomes your regression detection system.

🔵 STAGE 1 — STT Semantic Normalization Layer

Before full abstraction, add:

normalizeTranscriptEvent({
  rawTranscript,
  rawConfidence,
  provider,
  interim,
  durationMs
})

Normalization Rules:
	•	Ignore interim transcripts
	•	Enforce minimum speech duration (300ms)
	•	Normalize confidence scale
	•	Enforce minimum transcript length
	•	Collapse repeated speech_started
	•	Enforce max silence jitter window

Why Now?

This shields:
	•	Unlock
	•	Degradation
	•	Clarification

From STT variance before abstraction.

Acceptance Criteria

Across Azure, Sarvam, ElevenLabs STT:
	•	Unlock decision variance <5%
	•	Degradation state variance <5%
	•	No spike in clarifications

🔵 STAGE 2 — Transport Adapter Extraction

Create:

BaseTransportAdapter
TwilioTransportAdapter
PlivoTransportAdapter

Responsibilities:
	•	Normalize event ordering
	•	Normalize speech boundary emission
	•	Normalize audio send
	•	Normalize stopPlayback

App.js consumes single interface.

No logic changes.

Acceptance Criteria
	•	Identical unlock metrics
	•	Identical latency distribution
	•	No regression in interruption behavior

🔵 STAGE 3 — TTS Adapter + Audio Normalization

Create:

BaseTTSAdapter
AzureTTSAdapter
ElevenLabsTTSAdapter
DeepgramTTSAdapter
SarvamTTSAdapter

Add AudioNormalizationLayer:
	•	Convert to 8kHz PCM or µ-law
	•	Standardize duration estimation
	•	Standardize streaming chunk size
	•	Standardize cancellation semantics

Acceptance Criteria
	•	Pacing identical ±50ms
	•	Interrupt stops audio instantly
	•	Micro-ack unaffected
	•	No clipped audio

🔵 STAGE 4 — LLM Adapter Extraction

Create:

BaseLLMAdapter
AzureLLMAdapter
OpenAIAdapter
ClaudeAdapter

Move:
	•	HangupDecision behind LLM adapter
	•	Streaming lifecycle abstraction
	•	Cancellation semantics normalization

Acceptance Criteria
	•	Same decision outcome for identical conversation
	•	Streaming latency unchanged
	•	Cancellation race safe
	•	No double responses

🔵 STAGE 5 — STT Adapter Extraction (Still No VAD Ownership)

Create:

BaseSTTAdapter
AzureSTTAdapter
SarvamSTTAdapter
ElevenLabsSTTAdapter

STTAdapter must emit:

speech_started
speech_stopped
transcript_final
confidence_normalized

All semantics normalized before reaching orchestrator.

Acceptance Criteria
	•	Unlock rate parity across STT providers
	•	No degradation instability
	•	Clarification frequency stable
	•	Silence hangup unaffected

🔵 STAGE 6 — RAG Guardrail Integration Hardening

Now integrate:
	•	Ambiguity scoring
	•	Retrieval sanitation
	•	Synthesis confidence scoring
	•	Injection resistance

Tie guardrails to unlock + clarification.

Acceptance Criteria
	•	Adversarial multilingual injection blocked
	•	No hallucinated data leakage
	•	Clarification loops capped
	•	Persona style preserved

🔵 STAGE 7 — Provider Drift Monitoring System

This is the second missing piece.

Add automated drift checks:

Monthly synthetic test calls:
	•	Silence scenario
	•	Single-word “yes”
	•	Restaurant noise
	•	Packet loss simulation
	•	Multilingual fragmentation
	•	IVR scenario

Compare metrics to baseline.

Alert if:
	•	Unlock rate changes >5%
	•	Clarification rate changes >10%
	•	Degradation rate spikes
	•	Latency shifts >100ms median

This protects you from:
	•	Silent SDK changes
	•	Confidence distribution drift
	•	Turn detection changes
	•	Voice provider latency drift


📊 WHERE VAD OWNERSHIP FITS LATER

Because you built:
	•	STTAdapter
	•	Semantic Normalization Layer
	•	Telemetry Layer
	•	Drift Monitoring

Owning VAD later becomes:

Replace:

speech_started / speech_stopped from STT

With:

speech_started / speech_stopped from LocalVAD

Inside STTAdapter.

Refactor impact reduces from 8/10 to ~5/10.

🧠 What You Are NOT Doing

You are NOT:
	•	Owning raw audio segmentation now
	•	Rewriting unlock logic
	•	Rewriting degradation
	•	Rewriting pacing
	•	Rewriting turn isolation

You are building protective layers around them.

📈 Big Picture View

After this plan:

You have:

✔ Transport-agnostic orchestration
✔ STT-agnostic orchestration
✔ TTS-agnostic orchestration
✔ LLM-agnostic orchestration
✔ Market-based configuration
✔ Persona isolation
✔ Drift monitoring
✔ Future-ready VAD transition

Without premature complexity.

🔐 Risk Assessment

If phased:

Low–Medium.

If big-bang:

High.


🎯 Final Structured Plan Summary

Stage	Goal	Risk
0	Baseline freeze + telemetry	Low
1	STT semantic normalization	Medium
2	Transport adapter	Medium
3	TTS adapter	Medium
4	LLM adapter	Medium
5	STT adapter	Medium–High
6	Guardrail hardening	Medium
7	Drift monitoring	Low



🏁 Final Evaluation

This plan is:

Practical
Sequenced
Defensive
Not over-engineered
Not under-engineered
Future-ready

And it keeps VAD ownership optional without locking you in.
