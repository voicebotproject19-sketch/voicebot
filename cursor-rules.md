**cursor-rules.md**

**Enterprise Real-Time Voice Platform --- ABSOLUTE NON-NEGOTIABLE RULES**

These rules are **authoritative and persistent**.

They override all conversational prompts, explanations, or intentions.

Any violation requires **explicit rejection**, not workaround.

**0. Governing Principle (HIGHEST PRIORITY)**

This is a **production, real-time, latency-critical voice system**.

Priority order (highest → lowest):

1.  **Correctness**

2.  **Latency guarantees**

3.  **Security & isolation**

4.  **Intent preservation**

5.  **Stability**

6.  **User experience**

7.  **Code elegance**

If priorities conflict, **higher priority always wins**.

**1. Language & Runtime (HARD CONSTRAINT)**

- The codebase is **Node.js only**

- Do **not**:

  - Introduce other languages or runtimes

  - Replace frameworks or SDKs

  - Suggest architectural migrations

- Existing integrations must be preserved unless explicitly instructed

**2. Real-Time & Streaming Constraints**

- This is a **real-time streaming system**

- File-based audio processing is **forbidden**

- Audio must remain:

  - Streaming

  - Chunked

  - Low-latency

- Do not buffer full audio segments unless strictly unavoidable

**3. Event Loop & Async Discipline**

- Do **not** block the Node.js event loop

- Do **not** introduce synchronous I/O

- All I/O must be:

  - Async

  - Non-blocking

- Every await in the conversational hot path must be **explicitly latency-justified**

- No CPU-intensive operations (>1ms expected execution) may run in the hot path without justification.

- Use of Promise.resolve, process.nextTick, setImmediate, or equivalent async wrappers must not alter event sequencing guarantees.

**4. Latency Is a First-Class Requirement**

- End-to-end conversational latency must remain **≤ 600 ms**

- Latency is a **distributed budget**

- Rules:

  - Prefer parallel async execution

  - Enforce **hard timeouts** on all external calls

  - Start work on **partial STT**, never wait for final transcripts

  - Stream output immediately on first availability

- Any async work triggered by STT, TTS, audio, or dialogue is **hot-path by default**

- "Background" work must prove it cannot delay output

**5. Telephony & Audio Flow Integrity**

- Do not break or reinterpret telephony integrations

- Do not alter RTP / WebSocket semantics

- Audio ingress and egress must remain **full-duplex**

- Barge-in must be immediate and reliable

**6. Architecture Boundaries (STRICT)**

The following concerns **must not be coupled**:

- Telephony

- Audio intelligence (noise, VAD, classification)

- STT / TTS

- Dialogue orchestration

- RAG

- Third-party integrations

Rules:

- Prefer adapters and interfaces

- No cross-module side effects

- No "temporary" shortcuts

- No logic relocation "for cleanliness"

**7. Audio Intelligence Constraints**

- Heavy ML inference must **not** run in the request hot path

- Noise / music / non-speech handling must:

  - Occur **before STT**

  - Be low-latency

- Music or background noise must **never**:

  - Trigger VAD

  - Trigger barge-in

  - Interrupt TTS

**8. STT / TTS Usage Rules**

- STT must be:

  - Streaming

  - Partial-result driven

- Do not wait for final STT if partials exist

- TTS must be:

  - Streaming

  - Interruptible

- Playback must begin on the **first audio chunk**

**9. RAG & External Integration Constraints**

- RAG is an **enhancer**, never a gatekeeper

- External calls must be:

  - Async

  - Parallel

  - Time-bounded

- No external dependency may stall conversation flow

- Failures must degrade gracefully

- Do not treat RAG output as authoritative when data is partial

**10. Multilingual & Language Handling**

- Do not hard-code languages

- Language behavior must be configuration-driven

- The system must support:

  - Automatic language detection

  - Mid-call language switching

  - Context preservation across switches

- Prevent language flapping via:

  - Confidence thresholds

  - Hysteresis / stickiness

**11. Session & State Management (CRITICAL)**

- Each call session must be **fully isolated**

- No global mutable state for:

  - Audio buffers

  - STT / TTS streams

  - Language detection

  - RAG context

- Session state must be:

  - Explicit

  - Passed, never inferred

- Shared caches must be read-only or tenant-scoped

**12. Concurrency & Ordering Rules**

- Audio, STT, TTS, RAG, and integrations operate concurrently

- Event ordering must be **explicit**

- Never rely on promise resolution order

- Late async results must be **discarded**, never merged

- Barge-in must cancel downstream TTS immediately

**13. Configuration-First Enforcement**

- Do **not** hard-code:

  - Languages

  - Thresholds

  - Timeouts

  - Model or voice IDs

- Defaults are allowed; constants in logic are not

- Configuration controls **values**, not logic branches

- Config must not encode behavioral decisions

**14. Observability & Metrics (MANDATORY GATE)**

- Any behavior-affecting change must emit metrics or logs

- Removal of existing observability is forbidden

- Each call must be traceable via session ID

- Latency metrics must include:

  - STT partial timing

  - TTS first-audio timing

  - External call duration

**15. Runtime Self-Health Checks (MANDATORY, LIGHTWEIGHT)**

This system relies on third-party services and real-time guarantees.

Runtime self-health checks are required to detect silent regressions.

**Latency Health**

- The system must expose signals for:

  - End-to-end latency breaches

  - STT partial-result delays

  - TTS first-audio delays

- Health checks must be:

  - Non-blocking

  - Observational only

  - Outside the conversational hot path

**Vendor Drift Detection**

- The system must expose:

  - Active SDK versions

  - Active API versions (where applicable)

- Unexpected changes in:

  - response shape

  - enum values

  - defaults

> must surface as detectable signals

**Failure Visibility**

- Health degradation must be:

  - Observable via logs or metrics

  - Distinguishable from normal operation

- Health checks must never:

  - Block audio

  - Delay responses

  - Alter conversational flow

**Cursor Constraints**

- Cursor must not remove or weaken health checks

- Cursor must not introduce heavy or speculative probes

- Health checks fail **open at runtime**, but **closed for development changes**

**16. Anti-Drift & Anti-Vibe Coding Rules (STRICT)**

**Intent Preservation**

- Do not reinterpret system intent

- Do not "simplify" behavior unless explicitly requested

- Assume existing behavior is intentional

**Local Optimization Control**

- Do not refactor for cleanliness or elegance

- Any refactor must state:

  - What behavior is preserved

  - What timing guarantees remain unchanged

- If timing cannot be proven unchanged → reject

**Abstraction Control**

- Do not introduce abstractions unless:

  - A boundary violation exists, or

  - A measurable problem is solved

- New files named helper, util, manager, common, shared require explicit justification

**Rename Discipline**

- Renames must not change behavior

- Any semantic shift must be declared

**No Silent Rewrites**

- Large rewrites require:

  - Explicit reason

  - Old → new behavior mapping

- Prefer minimal diffs

**17. Turn / Epoch Contract (ABSOLUTE LAW)**

- Every interaction belongs to a single **turn / epoch**

- Each turn must have a unique identifier

**Turn Lifecycle**

- A turn starts when valid speech is accepted

- A turn ends when:

  - Response completes, or

  - User barges in, or

  - System cancels the turn

**Cancellation Rules**

- Cancelling a turn invalidates **all downstream async work**

- Late results must be ignored

**Non-Negotiable**

- No async result may affect behavior unless its turn is active

- Late correctness is worse than no response

**18. Fail-Closed Rule (MANDATORY)**

- If correctness, ordering, latency, or vendor behavior is uncertain:

  - **Do nothing**

  - **Reject the change**

- Silence is safer than speculative output

**19. Change Scope & Blast Radius Control**

- Changes must map **1:1** to stated objectives

- Unrelated changes → reject

- Large diffs for small goals → reject

**20. Anti-Hallucination Rules**

- If something is not present, state:

> **"Not found in the current codebase"**

- Do not invent:

  - Modules

  - Services

  - Queues

  - Abstractions

- If uncertain:

  - State uncertainty and stop

  - Do not ask follow-ups unless instructed

**21. Security Rules (EXPLICIT)**

- Do not log:

  - Raw audio

  - Transcripts

  - PII

  - Secrets or tokens

- Do not introduce:

  - Hard-coded credentials

  - Inline secrets

- All external integrations must:

  - Enforce least privilege

  - Respect tenant isolation

- Do not weaken authentication, authorization, or encryption

- Security violations override all other concerns

**22. Third-Party API Safety (CRITICAL)**

Third-party services evolve independently.

Cursor must **never guess API behavior**.

**Adapter-Only Rule**

- Cursor must not call third-party SDKs directly

- All vendor interactions must go through approved adapters

- Vendor types must not leak into core logic

**No API Guessing**

- If a method or field is not present in:

  - Adapter code, or

  - Local integration documentation

> → treat it as unavailable

**Version Discipline**

- SDK and API versions are pinned

- Cursor must not upgrade or switch versions without instruction

**Fail-Closed on Vendor Uncertainty**

- If vendor behavior or response shape is unclear → reject

- Runtime guards are preferred over assumptions

**22A. Adapter Output Contract Enforcement**

Adapter outputs must contain only normalized contract fields.

Provider-specific metadata must not leak beyond adapter boundaries.

Violation → REJECT.

**23. Synthetic Validation Mandate (MANDATORY FOR BEHAVIORAL CHANGES)**

Any modification to:

- Unlock logic  
- Degradation logic  
- STT adapters  
- TTS adapters  
- LLM adapters  
- Transport adapters  
- Guardrail enforcement  
- Confidence handling  

Must explicitly reference synthetic validation coverage.

Synthetic validation must include:

- Unlock regression scenarios  
- Clarification regression scenarios  
- Latency budget validation  
- Race condition simulation  
- Injection attempt simulation  

Behavioral tolerance thresholds:

- Unlock variance must remain &lt; 5%  
- Clarification rate variance must remain &lt; 10%  
- Median end-to-end latency shift must remain &lt; 100 ms  

If validation impact is unknown → REJECT.

Synthetic validation must include at least one regression-detecting scenario that would fail if behavior drifts beyond defined tolerance.

Passive or no-op tests are insufficient.

Behavioral equivalence must be explicitly declared when modifying unlock, degradation, guardrails, or streaming logic.

Cursor must provide either:
- A statement of strict behavioral equivalence with justification, OR
- An explicit old → new behavioral delta description.

Semantic drift without declaration → REJECT.

---

**24. Confidence Normalization Lock (NON-NEGOTIABLE)**

Unlock and degradation engines must consume only normalized confidence values.

Raw provider confidence values must never be used directly in orchestration logic.

If a new STT provider is introduced:

- A deterministic calibration mapping must be implemented  
- Calibration must be configuration-driven  
- Calibration logic must not alter orchestration semantics  

Direct raw confidence usage → REJECT.

Identity mappings (raw → normalized without calibration) require explicit justification with provider confidence distribution evidence.

Confidence calibration logic must reference measurable provider confidence distribution characteristics.

Unverified calibration assumptions → REJECT.

---

**25. Single Active Execution Path Rule**

There must be exactly ONE active execution path per responsibility.

Prohibited:

- Legacy and replacement adapters active simultaneously  
- Shadow logic branches  
- Hidden fallbacks  
- Dual unlock pipelines  

When replacing logic:

- Legacy code must be removed or made unreachable  
- Parallel scaffolding is not allowed  

Multiple active paths → REJECT.

Feature flags may not preserve legacy execution paths unless a documented removal milestone is defined.

Feature-flagged legacy paths must include:
- A documented removal milestone
- A version or release target

Indefinite parallel paths → REJECT.

---

**26. Guardrail-First Emission Enforcement**

No LLM-generated output may be emitted to transport before:

- Guardrail validation  
- Retrieval sanitation  
- Synthesis confidence check  

Unlock success does not imply emission permission.

Guardrail enforcement must occur before any audio chunk is streamed.

Violation → REJECT.

Guardrail validation must complete before any invocation of transport.sendAudioDirect or equivalent audio emission call.

Guardrail enforcement must include:
- Injection pattern validation
- Role separation validation
- Retrieval boundary validation

Shallow or partial validation is insufficient.

---

**27. Drift Tolerance & Behavioral Integrity Rule**

Structural changes must explicitly confirm preservation of:

- Turn ordering semantics  
- Event sequencing guarantees  
- Latency budget compliance  
- Unlock scoring stability  
- Degradation state stability  

Any behavioral drift outside defined tolerance must be declared.

Undeclared drift → REJECT.

Drift declarations must reference specific metric comparisons or synthetic baseline outputs.

Behavioral integrity checks must include comparison against previous synthetic baseline outputs.

Assertion without comparative evidence → REJECT.

---

**28. Output Discipline (FINAL GATE)**

- If **any** rule is violated → output **REJECTED**

- Rejection format:

REJECTED

Rule violated: \<rule number\>

Reason: \<specific explanation\>

- Explanations never override rules

- Partial compliance is invalid

**🔒 Final Reminder**

This system is **not forgiving**.

- Correctness beats output

- Stability beats progress

- Silence beats wrong behavior

- Rules beat explanations

Cursor must **comply or stop**.

---

**29. Drift Tolerance & Telemetry Preservation**

No telemetry regression without approval.

Telemetry field names must remain stable. Renaming or structural alteration requires explicit migration declaration.

---

**30. Adapter Contract Versioning (MANDATORY)**

All adapter output contracts must declare an explicit version identifier.

Breaking changes require:
- Version increment
- Migration description
- Compatibility statement

Silent contract mutation → REJECT.

---

**31. Monitoring Schema Stability (MANDATORY)**

Telemetry schemas must be versioned.

Metric renames, removals, or structural changes require:
- Migration declaration
- Compatibility mapping

Undeclared schema drift → REJECT.

---

**32. Threat Modeling Requirement (SECURITY HARDENING)**

Any change affecting:
- User input handling
- Model input construction
- Retrieval logic
- Response emission

Must include evaluation of:
- Prompt injection risk
- Data leakage risk
- Privilege escalation risk
- Retrieval amplification risk

Absence of threat evaluation → REJECT.

---

**33. CI & Structural Enforcement Mandate**

Where feasible, structural constraints must be enforceable via:
- Static analysis
- Pre-commit checks
- CI validation

Rules concerning:
- Stub detection
- Dual execution paths
- Telemetry schema stability
- Adapter contract versioning

Must be validated automatically where technically possible.

Manual-only enforcement is insufficient.


---

**34. Vibe Coding Automation Enforcement (MANDATORY FOR THIS PROJECT)**

This project operates in a vibe-coding dominant environment with minimal human review.

Therefore, behavioral safety must be mechanically enforceable.

The following are REQUIRED:

1. Golden Behavioral Baselines
   - Unlock, clarification, and degradation outputs must be covered by snapshot-style golden tests.
   - Any behavioral drift beyond declared tolerance must fail CI.
   - Tests must fail when unlock thresholds or scoring logic materially change.

2. Injection & Guardrail Harness
   - A mandatory adversarial test suite must validate injection resistance.
   - Tests must include prompt injection, retrieval override, and multilingual injection scenarios.
   - Unsafe emission in any scenario → CI FAIL.

3. Telemetry & Adapter Schema Snapshots
   - Telemetry JSON schema must be snapshotted.
   - Adapter output contracts must be schema-validated.
   - Field rename or removal without migration → CI FAIL.

4. Latency Regression Guard
   - CI must enforce that latency budgets remain within defined tolerance.
   - Median shift > declared tolerance → CI FAIL.

5. Structural Integrity Checks
   - No unused adapters.
   - No TODO or placeholder logic in production paths.
   - No duplicate active execution paths.
   - No raw provider confidence usage outside normalization layer.

6. Behavioral Integrity Over Declarations
   - Declarative compliance is insufficient.
   - Behavioral invariants must be demonstrably preserved via automated checks.

7. Merge Gate Rule
   - No change affecting unlock, degradation, adapters, guardrails, latency, telemetry, or schema may merge without passing all automated invariants.

In vibe-coding mode:
- Automation is enforcement.
- Human intent statements are insufficient.
- Mechanical invariants override conversational assurances.

Failure to satisfy automated invariants → REJECT.