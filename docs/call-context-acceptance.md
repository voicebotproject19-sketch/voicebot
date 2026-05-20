# Phase 2.5 — Call Context Awareness, Guarded Speech & Language Policy (Revised & Locked Specification)

## Purpose

Phase 2.5 establishes **call context awareness** with explicit **guarded speech policies** for the voice platform.

While Phase 2 guarantees *mechanical correctness* (race-free, turn-safe behavior), Phase 2.5 guarantees **social, contextual, and policy correctness**:  
the system must **know when it is appropriate to speak**, **how to speak**, and **when silence or guarded language is required**.

This document is a **long-term architectural reference**, **acceptance contract**, and **review gate**.

---

## Core Problem Statement

Real-world telephony audio includes many non-human sources and contexts that require careful handling:

- Voicemail systems (including campaign and ISD-based voicemail)
- OS call screening (e.g., iOS “ask for name”)
- IVRs and auto-attendants
- Carrier announcements
- Hold music
- Conference bridges
- Internal system prompts

A voice system that assumes *“speech = human intent”* or *“any speech is safe”* will behave incorrectly.

Phase 2.5 ensures the system:
- never speaks to machines except under explicit guarded language policies
- never embarrasses or misleads users or screening systems
- always recovers immediately and fully when a human speaks

---

## Design Principles

### 1. Speech Is Permissioned and Guarded

The system must **earn the right to speak** and **speak only with approved language**.

Silence is the default until **interactive human behavior** is proven.

When non-interactive speech is allowed (e.g., voicemail greeting), it must be **explicitly guarded** by language policy.

### 2. Guarded Language Policies

Explicit policies govern speech in sensitive contexts:

- **Voicemail Language Policy:**  
  Speech is allowed only for campaign or ISD-based voicemail detection and greeting.  
  Language must be **neutral, minimal, and non-intrusive**.  
  No complex dialogue or personal data disclosure.

- **iOS Screening Language Policy:**  
  Speech is allowed only for minimal identity confirmation or polite prompts.  
  Language must be **brief, non-committal, and respectful of privacy**.

---

## Governing Abstraction

### InteractionMode (Authoritative)

```ts
enum InteractionMode {
  INTERACTIVE,        // Proven human interaction
  NON_INTERACTIVE,    // System audio, no reaction capability
  TRANSITIONAL        // May become interactive later
}
```

- **InteractionMode** is the only control signal that governs whether the bot may speak.
- All other classifications are secondary metadata.

### Context Hints (Secondary, Non-Authoritative)

Optional metadata such as:
- VOICEMAIL
- OS_SCREENING
- IVR_ROUTING
- ON_HOLD
- CONFERENCE

These:
- MUST NOT directly trigger speech
- MUST NOT override InteractionMode
- MAY be used only for logging, analytics, or enterprise policy

---

## Behavioral Invariants (Non-Negotiable)

Phase 2.5 is considered complete only if all invariants below are guaranteed by construction.

### Invariant 1 — Speech Requires Interactivity or Guarded Policy

The system MUST NOT emit TTS unless:

- `InteractionMode === INTERACTIVE`  
  **OR**  
- Explicit guarded language policy applies (e.g., voicemail campaign, iOS screening)

Rules:
- Silence is the default
- Uncertainty always results in silence
- No heuristic may “guess” permission to speak
- Guarded speech must follow approved language policies strictly

### Invariant 2 — Human Override Is Absolute

Any real human behavior MUST immediately override prior classification.

Human signals include:
- interruption
- turn-taking
- reactive speech

When detected:
- `InteractionMode` switches to `INTERACTIVE`
- all prior system classifications are invalidated
- normal conversation begins immediately

### Invariant 3 — Non-Interactive Audio Is Safe

Non-interactive audio MUST NEVER:
- trigger dialogue
- trigger TTS (except guarded speech)
- trigger RAG
- cause irreversible actions

This explicitly includes:
- voicemail greetings (except guarded policy)
- OS call screening prompts (except guarded policy)
- IVR prompts
- compliance announcements
- carrier error messages
- hold music
- conference join/leave announcements

### Invariant 4 — Transitional States Are Reversible

Transitional states MUST NOT cause irreversible actions.

Examples:
- hold
- routing
- transfer
- muted caller

Rules:
- no forced hangup
- no speech (except guarded policy if applicable)
- wait indefinitely (or policy timeout)
- immediate recovery to `INTERACTIVE` on human speech

### Invariant 5 — Unknown Scenarios Fail Silent and Guarded

Any unknown or future call context MUST:
- degrade to `NON_INTERACTIVE` or `TRANSITIONAL`
- result in silence or guarded speech only if explicitly allowed by policy
- remain recoverable by human speech

This guarantees future-proofing against:
- new OS features
- carrier behavior changes
- AI agents answering calls
- enterprise middleware

---

## Explicitly Supported Scenario Classes and Language Policy

| Scenario           | Required Behavior                         | Language Policy                         |
|--------------------|------------------------------------------|---------------------------------------|
| Voicemail          | Silence; optional policy hangup           | Guarded speech allowed only for campaign / ISD voicemail; minimal, neutral language only |
| OS Call Screening  | Silence or single identity response       | Guarded speech only; brief, polite, non-committal language |
| Call Hold          | Silence; wait for resume                   | No speech                             |
| IVR / Routing      | Silence; wait for human                    | No speech                             |
| Conference Bridge  | Silence until clear human turn             | No speech                             |
| Muted Caller       | Silence; wait                              | No speech                             |
| Early Media / Ringback | Silence                               | No speech                             |

---

## Handling Call Hold

Call hold is treated as a `TRANSITIONAL` state.

**Detection**
- inbound media pauses OR
- continuous non-speech audio (e.g., hold music)
- WebSocket remains open

**Behavior**
- pause TTS
- pause transcription if required
- do not hang up
- do not speak (except guarded speech if policy applies)

**Resume**
- new human speech immediately transitions to `INTERACTIVE`
- conversation resumes normally

---

## Latency & Safety Constraints

Phase 2.5 MUST:
- NOT block the audio hot path
- NOT add buffering
- NOT add ML inference
- NOT introduce external dependencies
- NOT increase response latency

Logic must operate on:
- existing STT events
- timing metadata
- Phase 2 turn / epoch signals

---

## Architectural Placement

Phase 2.5 logic MUST:
- live outside the Edge Media Layer
- consume already-emitted events
- respect Phase 2 turn/epoch gating

EdgeSession MUST remain:
- media-only
- deterministic
- context-agnostic

---

## Guardrails and Anti-Drift Notice

Phase 2.5 policies and invariants are **locked** and must not be modified without formal review.

All changes require:
- documented rationale
- rigorous testing for regressions
- approval by architecture governance

This prevents drift, regressions, and unintended side effects in production voice platforms.

---

## Acceptance Criteria

Phase 2.5 is ACCEPTED only if:

1. The bot never speaks to voicemail except under explicit guarded language policy (campaign / ISD-based only)
2. The bot never converses with OS call screening except minimal guarded language
3. The bot never speaks during hold or IVR except as allowed by policy (usually silence)
4. The bot immediately responds when a human speaks
5. Human speech overrides all prior classifications immediately and absolutely
6. Unknown contexts result in silence or guarded speech only, never errors or unguarded speech
7. No measurable latency regression exists
8. No Phase 2 invariants are violated
9. No context logic is added to EdgeSession
10. Behavior is explainable via `InteractionMode` transitions and guarded language policies

---

## Rejection Criteria

Phase 2.5 MUST be REJECTED if any of the following occur:

- Bot speaks without proven interactivity or explicit guarded language policy
- Bot speaks to system audio without guarded language
- Bot hangs up during hold or routing
- Classification depends on language-specific heuristics or vendor-specific scripts
- Edge media code is modified to add context logic
- Unknown contexts cause speech or errors
- Heuristics are irreversible or cause drift
- Guarded language policies are violated or bypassed

---

## Formal Completion Statement

Phase 2.5 is complete only when the following statement is true:

> For any call audio that is not demonstrably interactive human speech, the system remains silent or speaks only guarded, policy-approved language, waits safely, and immediately recovers full conversational capability when a human speaks.

---

## Architectural Rationale

This approach avoids:
- brittle scenario enumeration
- language-dependent heuristics
- false positives
- future regressions
- user embarrassment or privacy violations

Instead, it guarantees:
- safety
- dignity
- reversibility
- long-term robustness
- compliance with explicit language policies

This is the only viable definition of completeness for production voice platforms.
