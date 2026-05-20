# Phase 4 — Edge Case Validation Report

Deterministic safe behavior for each scenario. No modification to Phase 2/2.5/3, EdgeSession, or InteractionMode.

| # | Scenario | Expected behavior | Module(s) |
|---|----------|-------------------|-----------|
| 1 | **Hallucinated number** | Structured: hard block. Balanced/Rapid: penalty in synthesis score; re-run numeric enforcement after persona. | numericEnforcement, synthesisScoring |
| 2 | **Conflicting documents** | Relevance filter + variance in grounding score; low alignment can lower synthesis → clarify/partial/escalate. | ragGuardrails, synthesisScoring |
| 3 | **Zero retrieval** | `zeroDocs: true` from guardrails; caller must clarify or fallback; never fabricate. | ragGuardrails |
| 4 | **Retrieval timeout** | Caller enforces timeout; `recordRetrievalTimeout(true)`; no hallucination path—fallback/clarify. | ragGuardrails (recordRetrievalTimeout) |
| 5 | **Prompt injection** | Sanitation strips injection sentences; high density → drop doc. | retrievalSanitation |
| 6 | **Subtle instruction injection** | Patterns `(assistant|ai|model|system).*(must|should|always|never|ensure)` and `(when generating responses|follow these guidelines|avoid saying)` remove sentences. | retrievalSanitation |
| 7 | **STT numeric mishear** | Transaction policy requires numeric repetition; repetition loop until confirmed. | transactionPolicy |
| 8 | **Partial cancel command** | Intent gate: low confidence → clarify; clarification count → escalate if exceeded. No transaction without confirmation. | intentGate, transactionPolicy |
| 9 | **Backend transaction failure** | Transaction policy: backendAuthoritativeOk required; failure → not allowed. Escalation on repeated failures. | transactionPolicy, escalationEngine |
| 10 | **Humor in complaint context** | Style profile: complaintContext → FORMAL; humorLevel 0, maxHumorPerTurn 0. | styleProfiles |
| 11 | **Persona over-enthusiasm** | maxSentencesPerTurn, maxHumorPerTurn, exclamationAllowed caps; capSentences enforces. | styleEngine |
| 12 | **Code-switch ambiguity** | Intent confidence below threshold → clarify; no RAG until confident. | intentGate |
| 13 | **Cross-tenant doc retrieval** | sanitizeDocument drops when docTenantId !== tenantId. | retrievalSanitation |
| 14 | **Long doc overflow** | maxCharsPerDoc (default 5000) truncates in sanitizeDocument. | retrievalSanitation |

All behaviors are deterministic and do not add awaits to the audio hot path. Numeric enforcement is re-run after persona pass (styleEngine does not modify numerics; caller re-runs enforceNumerics on persona output).
