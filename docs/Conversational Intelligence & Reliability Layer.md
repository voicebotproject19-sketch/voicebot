📘 PHASE 4

Conversational Intelligence, RAG Guardrails & Persona Governance


0️⃣ PURPOSE

Phase 4 introduces:
	•	Deterministic conversational intelligence
	•	Hardened RAG guardrails
	•	Retrieval sanitation
	•	Numeric enforcement
	•	Escalation governance
	•	Light transaction safety
	•	ConversationProfile strategy control
	•	CommunicationStyleProfile (persona precision)

Phase 4 does NOT modify:
	•	Turn/Epoch logic (Phase 2)
	•	InteractionMode gating (Phase 2.5)
	•	Latency model (Phase 3)
	•	Silence-by-default policy
	•	EdgeSession structure

Phase 4 operates entirely above those layers.


1️⃣ HIGH-LEVEL ARCHITECTURE

User Speech
↓
Intent Confidence Gate
↓
ConversationProfile Applied
↓
RAG Decision Gate
↓
Retrieve Documents
↓
Retrieval Sanitation Layer
↓
Relevance Filtering
↓
LLM Synthesis (Raw)
↓
Numeric Enforcement
↓
Synthesis Confidence Scoring
↓
Escalation Decision
↓
Transaction Policy Layer (if needed)
↓
CommunicationStyleProfile (Persona Layer)
↓
TTS

Each stage is bounded, deterministic, and auditable.


2️⃣ CONVERSATIONPROFILE (STRATEGY CONTROL)

ConversationProfile governs behavioral strictness.

2.1 Structure

ConversationProfile = {
  name: 'structured' | 'balanced' | 'rapid',

  rag: {
    enabled: boolean,
    maxDocs: number,
    retrievalTimeoutMs: number,
    minRelevanceScore: number,
    synthesisThreshold: number
  },

  intent: {
    minConfidence: number,
    clarificationThreshold: number,
    maxClarifications: number
  },

  escalation: {
    maxLowConfidenceTurns: number
  },

  transaction: {
    confirmationRequired: boolean,
    numericRepetitionRequired: boolean
  }
}



2.2 Profiles

Structured (Enterprise)
	•	synthesisThreshold = 0.75
	•	maxClarifications = 3
	•	maxDocs = 5
	•	Strict numeric enforcement (hard block)
	•	Formal tone

Balanced (Default)
	•	synthesisThreshold = 0.70
	•	maxClarifications = 2
	•	maxDocs = 4
	•	Heavy numeric penalty
	•	Neutral tone

Rapid (Consumer)
	•	synthesisThreshold = 0.60
	•	maxClarifications = 1
	•	maxDocs = 3
	•	Moderate numeric penalty
	•	Concise tone


3️⃣ INTENT CONFIDENCE GATE

3.1 Rule

If:

intentConfidence < profile.intent.minConfidence

Then:
	•	Do NOT call RAG
	•	Ask clarification
	•	Increment clarification counter


3.2 Edge Cases

Scenario	Expected Behavior
User says “Cancel”	Clarify scope
User says “Refund”	Ask which plan/order
Mixed-language fragment	Clarify



3.3 Escalation Trigger

If:

clarifications > maxClarifications

Then:
	•	Escalate to human / fallback channel


4️⃣ RAG GUARDRAILS


4.1 Retrieval Budget

Constraints:
	•	maxDocs ≤ profile.rag.maxDocs
	•	retrievalTimeoutMs enforced
	•	maxCharsPerDoc capped (e.g. 5000)

If timeout:
	•	Abort retrieval
	•	Fallback response


4.2 Relevance Filter

Drop documents if:

relevanceScore < profile.rag.minRelevanceScore

If 0 docs remain:
	•	Clarify or fallback


4.3 Edge Scenarios

Scenario	Outcome
0 docs	Clarify
Retrieval timeout	Fallback
Conflicting docs	Clarify
Partial relevance	Clarify


5️⃣ RETRIEVAL SANITATION LAYER

Sanitizes retrieved documents before synthesis.


5.1 Removes
	•	HTML/script tags
	•	Code blocks
	•	YAML frontmatter
	•	Cross-tenant docs
	•	Prompt injection phrases
	•	Behavioral override attempts


5.2 Injection Detection Patterns

Remove sentences matching:

(assistant|ai|model|system).*(must|should|always|never|ensure)
(when generating responses|follow these guidelines|avoid saying)

If injection density > threshold:
	•	Drop document


5.3 Edge Cases

Scenario	Outcome
Hidden script injection	Stripped
Behavioral override	Sentence removed
Cross-tenant doc	Dropped
Overlong doc	Truncated

6️⃣ NUMERIC ENFORCEMENT

Most hallucinations involve numbers.

6.1 Extraction

Extract numeric tokens from:
	•	Sanitized docs
	•	Model answer

Include:
	•	Integers
	•	Decimals
	•	Percentages
	•	Currency
	•	Ranges
	•	Date values

6.2 Validation Rules

Every numeric in answer must:
	•	Exist in docs
OR
	•	Equal simple arithmetic combination (sum/difference) of doc numbers

Unit must match.

6.3 Profile Handling

Profile	Unsupported Numeric
Structured	Hard block
Balanced	Heavy penalty
Rapid	Moderate penalty


6.4 Edge Cases

Scenario	Outcome
7 days → 7 weeks	Block
7 + 3 = 10	Allowed
7–10 range (10 not in docs)	Penalized
Approximate “about a week”	Allowed

7️⃣ SYNTHESIS CONFIDENCE SCORING

7.1 Components

finalScore =
  0.35 groundingScore +
  0.35 alignmentScore +
  0.15 structureScore +
  0.15 behaviorScore

7.2 Scoring Signals

GroundingScore
	•	Doc count
	•	Average relevance
	•	Variance

AlignmentScore
	•	Keyword overlap
	•	Entity overlap
	•	Numeric overlap

StructureScore
	•	Hedge density
	•	Length cap
	•	Contradiction detection

BehaviorScore
	•	Unsupported numeric
	•	Absolute claims
	•	Policy without grounding

7.3 Threshold Gate

If:

finalScore < profile.rag.synthesisThreshold

Then:
	•	Clarify OR
	•	Partial answer OR
	•	Escalate

Never fabricate.

8️⃣ ESCALATION LOGIC

Escalate if:
	•	Repeated low synthesis scores
	•	Clarification cap exceeded
	•	High-risk domain detected
	•	Repeated transactional failures

Escalation tone:
	•	Formal
	•	Clear
	•	No humor

9️⃣ LIGHT TRANSACTION POLICY LAYER

Applies only after synthesis validation.

9.1 Rules
	•	INTERACTIVE mode only
	•	STT confidence threshold
	•	Explicit confirmation required
	•	Numeric repetition required (if values involved)
	•	Backend authoritative confirmation
	•	Idempotent execution

9.2 Edge Scenarios

Scenario	Outcome
STT misheard amount	Repetition loop
Partial cancel	Clarify scope
Backend failure	Report failure
Interruption mid-confirmation	Abort execution

🔟 COMMUNICATIONSTYLEPROFILE (PERSONA)

Persona applies after all validation.

10.1 Structure

CommunicationStyleProfile = {
  warmthLevel: 0–3,
  humorLevel: 0–2,
  verbosityLevel: 0–2,
  sentenceComplexity: 0–2,
  maxHumorPerTurn: number,
  exclamationAllowed: boolean
}

10.2 Guardrails
	•	Humor disabled in financial/complaint/escalation contexts
	•	Max one light warmth phrase per turn
	•	No emoji in voice channel
	•	No sarcasm
	•	No new commitments added
	•	Numeric validation re-run after style pass

10.3 Edge Scenarios

Scenario	Outcome
Refund denial	Humor suppressed
Escalation active	Formal tone
Transaction failure	Neutral tone
Informational FAQ	Warm tone allowed

1️⃣1️⃣ MULTILINGUAL & ACCENT CONSIDERATIONS

Phase 4 ensures:
	•	Numeric repetition for spoken numbers
	•	STT confidence thresholds profile-specific
	•	Language locked per call
	•	No mid-call model flapping
	•	Clarification when code-switching ambiguous

Full accent robustness is Phase 5.

1️⃣2️⃣ WHAT PHASE 4 GUARANTEES
	•	No hallucinated numbers
	•	No synthesis on weak grounding
	•	No prompt injection influence
	•	No cross-tenant leakage
	•	No unsafe transaction execution
	•	No escalation tone violation
	•	No persona overreach
	•	Deterministic profile behavior
	•	Latency bounded RAG

1️⃣3️⃣ WHAT PHASE 4 DOES NOT GUARANTEE
	•	Perfect STT accuracy
	•	Legal advice correctness
	•	Financial advisory safety
	•	Emotional crisis handling
	•	Regulatory reconciliation
	•	Real-time fact verification beyond docs

1️⃣4️⃣ ADVERSARIAL COVERAGE MATRIX

Attack	Mitigation
Hallucinated number	Numeric enforcement
Prompt injection	Sanitation layer
Conflicting docs	Clarify
Retrieval timeout	Fallback
Token overflow	Doc cap
Cross-tenant data	Tenant filter
STT numeric mishear	Repetition loop
Overenthusiastic persona	Persona caps
Transaction race	Turn model

No silent unsafe path remains within defined scope.

🏁 FINAL ASSESSMENT

Phase 4 provides:
	•	Intelligence reliability
	•	RAG discipline
	•	Numeric safety
	•	Escalation control
	•	Transaction governance
	•	Brand-safe persona
	•	Deterministic behavior

It is:
	•	Layered
	•	Auditable
	•	Rollbackable
	•	Configurable
	•	Production-ready within defined domain boundaries
