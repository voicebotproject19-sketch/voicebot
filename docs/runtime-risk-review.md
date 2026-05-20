# Runtime Risk Review

This review covers the live runtime path from `POST /api/call` through provider routing, media streaming, AI response generation, persistence, and teardown.

## Scope

Primary path reviewed:

1. `Routes/Routes.js`
2. `Controller/MainController.js`
3. `adapters/telecom/`
4. `app.js`
5. `session/createCallSession.js`
6. `services-twilio/` and `services-plivo/`
7. `services/writeQueue.js`
8. `services/CallRegistry.js`
9. `repositories/` and `services/db.js`

## Findings

### 1. High: provider fallback can create duplicate outbound calls

`MainController.call` wraps provider creation in a timeout race and falls back to the other provider if the primary call does not return quickly enough. That protects responsiveness, but it does not cancel the in-flight primary request. If the primary provider succeeds after the timeout and the fallback also succeeds, the system can create two live calls for one request.

Files:

- `Controller/MainController.js`

Why this matters:

- Duplicate calls are customer-visible.
- The risk is amplified during partial provider slowdowns rather than full outages.
- Registry and DB state may reflect whichever provider finishes first, not necessarily the only live call.

### 2. High: active call state is volatile and shared across too many writers

`services/CallRegistry.js` is an in-memory map used by controller logic, provider adapters, the session engine, and helper persistence code. It is a central dependency, but it has no concurrency controls, no persistence, and no lifecycle guard beyond TTL cleanup.

Files:

- `services/CallRegistry.js`
- `Controller/MainController.js`
- `adapters/telecom/TwilioProvider.js`
- `adapters/telecom/PlivoProvider.js`
- `session/createCallSession.js`
- `Helper/Helpers.js`

Why this matters:

- Process restart loses active-call state immediately.
- Multiple layers updating the same call object increases inconsistency risk.
- TTL cleanup can remove long-lived state independently of actual media/session health.

### 3. High: write queue can silently lose persistent call data

`services/writeQueue.js` drops jobs on overflow and only logs a warning. Producers do not appear to react to enqueue failure. That means call start or end persistence can fail without a compensating path.

Files:

- `services/writeQueue.js`
- `adapters/telecom/TwilioProvider.js`
- `adapters/telecom/PlivoProvider.js`
- `session/createCallSession.js`
- `app.js`

Why this matters:

- Call records can diverge from actual runtime behavior.
- Post-call transcript persistence can be lost during load spikes.
- Shutdown handling drains the queue, but sudden process death still loses buffered work.

### 4. Medium: session orchestration is concentrated in one large timer-heavy coordinator

`session/createCallSession.js` owns media ingress, denoising, turn transitions, policy mode changes, escalation, latency compensation, micro-acks, hangup signaling, and teardown. That centralization simplifies assembly, but it also creates a large coordination surface with many timers and event interactions.

Files:

- `session/createCallSession.js`

Why this matters:

- Regressions in one branch can affect unrelated runtime behavior.
- Timer ordering and turn guards are easy to break with localized changes.
- Failure analysis is harder because the module crosses transport, policy, audio, and lifecycle concerns.

### 5. Medium: provider asymmetry can drop early caller audio on Plivo

The shared session engine explicitly buffers pre-connect audio for Twilio, but not for Plivo. Plivo audio that arrives before the Azure realtime session is fully ready can be dropped.

Files:

- `session/createCallSession.js`
- `adapters/telecom/TwilioProvider.js`
- `adapters/telecom/PlivoProvider.js`

Why this matters:

- Users may lose the first words of their greeting or answer.
- This produces intermittent, provider-specific behavior that is difficult to reproduce.

### 6. Medium: teardown and persistence depend on cooperative shutdown

The runtime does make a good-faith attempt to drain the queue and close resources, but final persistence still depends on the process staying alive long enough for queued jobs to complete.

Files:

- `session/createCallSession.js`
- `app.js`
- `services/writeQueue.js`

Why this matters:

- Abrupt termination can lose end-of-call transcript and duration data.
- WebSocket close, queueing, DB write, and registry cleanup are decoupled across separate timing paths.

### 7. Medium: hangup analysis is model-driven in the live path

`Helper/hangupDecision.js` uses Azure OpenAI responses to decide whether the call has naturally concluded. It has retries and normalization, which is good, but the runtime still depends on a remote model for a core control decision.

Files:

- `Helper/hangupDecision.js`
- matching realtime service files

Why this matters:

- External latency or quota pressure can delay or degrade termination decisions.
- The function normalizes failures into a safe default, but that default is to continue, which may lengthen unproductive calls.

### 8. Low to medium: live runtime and Phase 4 architecture are not the same thing

The repository contains a richer Phase 4 and RAG-oriented orchestration layer, but the primary active runtime path still leans on helper-driven prompt updates and realtime-service-local logic.

Files:

- `logic/phase4Pipeline.js`
- `rag/`
- `persona/styleEngine.js`
- live runtime files in `session/` and `services-*`

Why this matters:

- Design intent and production behavior can drift.
- Future contributors may assume guardrails are active when they are only partially wired.

## Most critical runtime choke points

If a production incident occurs, these are the first files worth checking.

1. `Controller/MainController.js`
2. `session/createCallSession.js`
3. `services-twilio/realtimeServiceTwilio.js`
4. `services-plivo/realtimeServicePlivo.js`
5. `services/writeQueue.js`
6. `services/CallRegistry.js`

## Operational interpretation

The runtime is strongest at provider abstraction and Azure session encapsulation. The main risks are not basic correctness failures in one small function; they are coordination risks:

- duplicate actions under timeout and fallback,
- volatile shared in-memory state,
- lossy async persistence under pressure,
- and timing-sensitive orchestration across media, policy, and teardown.

Those are the parts most likely to produce intermittent production defects instead of immediate deterministic failures.