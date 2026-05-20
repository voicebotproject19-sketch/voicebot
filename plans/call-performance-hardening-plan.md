# Call Performance Hardening Plan

Date: 2026-05-06

## Scope

This plan covers the performance and conversational smoothness issues found in the 2026-05-06 production log pass. It is focused on interruption recovery, noisy speech handling, duplicate/synthesis loops, reconnect behavior, and validation instrumentation.

The goal is not to re-engineer barge-in from scratch. The goal is to make the existing flow safer by reusing the signals already present in the codebase and preventing the bot from nudging while caller speech is still active or likely pending transcription.

## Grounding Inputs

Code paths reviewed:

- `adapters/ai/BaseRealtimeAdapter.js`
- `session/createCallSession.js`
- `Helper/callClassifier.js`
- `adapters/telecom/PlivoProvider.js`
- `adapters/telecom/TwilioProvider.js`
- `scripts/simulate-log-based-calls.js`

Runtime evidence:

- Production log: `/Users/divyanggarg/Downloads/voicebot-out 87.log`
- Replay command: `node scripts/simulate-log-based-calls.js "/Users/divyanggarg/Downloads/voicebot-out 87.log" "/Users/divyanggarg/Downloads/voicebot-error 36.log"`
- Focused tests: `npm test -- --runTestsByPath tests/response-quality-routing.test.js tests/createCallSession.contextHydration.test.js tests/structuredLogger.test.js tests/conversationRepositoryRedaction.test.js`

Validation result:

- Focused test suites passed: 4/4
- Focused tests passed: 51/51

Final validation after Slice 1 implementation:

- Full Jest suite passed: 61/61 suites, 1588/1588 tests.
- Telemetry validation passed: contract, completeness, and schema checks.
- Phase 3 surface validation passed: AI adapter contracts, provider behavior drift, deterministic phase 3, and audio transcode.
- Static whitespace check passed on the full diff.
- VS Code diagnostics were clear for the touched realtime, telemetry, test, and plan files.
- Known residual warning: Jest still reports an existing forced-exit/open-handle warning after tests complete.

## Log Replay Findings

### F1. GateV2 is noisy, but not the primary source of the observed call drift

The replay found high GateV2 drop ratios across all three calls:

- Call `cd7e7b26...`: 1510 sampled frames, 70.4% dropped, 73 high-energy drops.
- Call `f5ea361f...`: 1377 sampled frames, 77.6% dropped, 8 high-energy drops.
- Call `fd4fc715...`: 977 sampled frames, 72.2% dropped, 3 high-energy drops.

However, speech windows still usually completed:

- Call `cd7e7b26...`: 15 speech starts, 14 speech stops, 12 transcripts, max transcript delay 847 ms.
- Call `f5ea361f...`: 8 speech starts, 8 speech stops, 8 transcripts, max transcript delay 697 ms.
- Call `fd4fc715...`: 12 speech starts, 12 speech stops, 10 transcripts, max transcript delay 745 ms.

Conclusion: do not treat this as a simple gate-dropping-all-user-speech failure. Gate tuning still matters, but the stronger failure is that recovery/nudge logic sometimes speaks before the caller's active speech window has stopped and transcribed.

### F2. Barge-in recovery fires while caller speech is still active

The most important repeated production pattern is:

1. `speech_started` fires.
2. The system classifies it as `barge_in` because playback tracking still thinks audio is active or the response was recently active.
3. `barge_in_recovery` fires after 2500 ms with `status.isUserSpeaking=true`.
4. The bot sends a scripted silence nudge.
5. Only later does `speech_stopped` and `user_transcribed` arrive.

Examples from call `f5ea361f...`:

- At 63.966 s: `speech_started` and `barge_in`.
- At 66.466 s: `barge_in_recovery` with `status.isUserSpeaking=true`, followed by `silence_nudge_scripted_sent`.
- At 67.482 s: `speech_stopped`.
- At 68.065 s: `user_transcribed`.

The same pattern repeats around 120.395 s -> 122.895 s -> 131.317 s, and around 138.643 s -> 141.143 s -> 142.435 s.

Call `cd7e7b26...` shows the same class of issue around 68.303 s, 117.537 s, and 135.799 s.

Conclusion: the bot can appear out of sync because it sends recovery nudges during an active caller speech window, then later receives and responds to the caller's actual prior speech.

### F3. Current code has richer suppression for normal silence timers than for barge-in recovery

`BaseRealtimeAdapter._getSilenceSuppressionReason(status)` suppresses silence timers for:

- `isResponding`
- `isUserSpeaking`
- playback active
- recent speech start
- recent gate activity
- recent input energy
- recent dropped input energy

`BaseRealtimeAdapter._getBargeInRecoverySuppressionReason(status)` currently suppresses only for:

- `isResponding`
- very recent response completion
- recent transcript

Conclusion: the fix should first align barge-in recovery with the already stronger silence suppression model, then add a bounded recheck path. This is a narrow correction, not a broad redesign.

### F4. Duplicate and synthesis recovery loops contribute to repetition and delayed answers

Call `f5ea361f...` shows repeated `response_duplicate_suppressed`, `synthesis_gate_failed`, `synthesis_gate_skipped_contextual`, `synthesis_gate_cap_reached`, `early_duplicate_cancelled`, and `response_quality_fail reason="incomplete"`.

The most concerning segment is around 131.345 s -> 136.565 s:

- A user transcript triggers response generation.
- `synthesis_gate_failed` occurs.
- `early_duplicate_cancelled` fires.
- `response_quality_fail reason="incomplete"` fires.
- Another response is created and hits synthesis gate cap.
- A fallback response is emitted.

Conclusion: stale duplicate/synthesis recovery can survive across turns and can make the bot respond late or repeat itself. This needs turn-scoped ownership so a recovery response generated for an old turn cannot collide with a newer caller utterance.

### F5. The system does not truly classify background noise vs user speech

The current stack is layered but probabilistic:

- GateV2 is acoustic: energy, variance, slope, adaptive noise floor, and thresholds.
- Echo guard pauses transcription during bot playback and tail windows.
- Azure VAD decides speech activity.
- `isGarbledTranscript()` filters transcript shape.
- `_isMediaBleedthrough()` catches some bot-audio echo patterns.

Conclusion: do not build logic that assumes speech-start means intentional caller speech, or that a garbled transcript always means background noise. The safe behavior is to wait or suppress while the evidence is ambiguous.

## Implementation Plan

### Slice 1: Make barge-in recovery speech-aware

Priority: Critical

Files:

- `adapters/ai/BaseRealtimeAdapter.js`
- `tests/response-quality-routing.test.js`

Implementation:

1. Change `_getBargeInRecoverySuppressionReason(status)` to reuse `_getSilenceSuppressionReason(status)` first.
2. Preserve the existing `recent_response` and `recent_transcript` suppression checks.
3. When the suppression reason is `user_speaking`, `recent_speech_started`, `recent_gate_activity`, `recent_input_energy`, or `recent_dropped_input_energy`, do not send a silence nudge.
4. Add a bounded recheck timer instead of a one-shot nudge. The recheck should keep waiting while caller activity is still likely, but must not wait forever if VAD gets stuck.
5. Add a hard maximum wait before any synthetic recovery. The recovery after the hard maximum should be a low-risk clarification only if no recent gate/input activity remains.
6. Emit structured telemetry for every branch:
   - `barge_in_recovery_suppressed_state`
   - `barge_in_recovery_recheck_scheduled`
   - `barge_in_recovery_hard_timeout`
   - `barge_in_recovery_clarification_sent`

Acceptance:

- No `barge_in_recovery` nudge is sent while `status.isUserSpeaking=true` unless the hard timeout has elapsed and recent gate/input activity is absent.
- If `speech_stopped` or `user_transcribed` arrives, pending recovery timers are cleared.
- Existing normal true-barge-in cancellation behavior remains unchanged.

Tests:

- Active caller speech suppresses barge-in recovery and does not call `sendTextResponse`.
- Recent gate activity suppresses barge-in recovery even if `isUserSpeaking` has been cleared incorrectly.
- Recent dropped input energy suppresses barge-in recovery.
- Recent transcript suppresses and clears stale `isUserSpeaking` as today.
- Hard timeout path sends at most one controlled clarification and only after no recent energy.

### Slice 2: Turn-scope duplicate, synthesis, and quality recovery

Priority: High

Status: Implemented and validated.

Files:

- `adapters/ai/BaseRealtimeAdapter.js`
- `session/conversationEngine.js`
- `Utils/telemetryEvents.js`
- `scripts/_check-telemetry-coverage.js`
- `tests/response-quality-routing.test.js`

Implementation:

1. Introduce lightweight response ownership metadata with two related concepts:
   - an accepted-transcript turn epoch for primary user-turn responses;
   - an input-activity epoch for speech-start/new-transcript interruption evidence.
2. Do not stale-drop a primary response solely because a noisy speech-start flickered. Speech-start can be ambiguous and should only invalidate delayed recovery/fallback work when it represents newer caller activity after that recovery was scheduled.
3. Attach ownership metadata to recovery paths: duplicate correction, synthesis gate retry/fallback, quality retry, response timeout fallback, response-create retry-after-done, and deferred text/user-input drains.
4. Before dispatching any delayed correction/fallback, verify that the relevant owner still matches the active user/input epoch.
5. If a newer user transcript or speech-start window has arrived after a recovery was scheduled, discard the stale correction/fallback, clear any one-shot bypass flags it owned, and log `stale_recovery_response_dropped`.
6. Keep the existing duplicate circuit breaker, but ensure `_skipDupCheckForNextResponse` applies only to the specific fallback response it was intended for.
7. Add per-turn counters to stop response-generation churn earlier when duplicate suppression and synthesis failure happen together.

Acceptance:

- A duplicate/synthesis fallback cannot be delivered after a newer user transcript has been accepted.
- A delayed recovery response cannot be delivered after a newer speech-start/user-input epoch indicates the caller has begun a newer turn.
- A normal primary response for an accepted transcript is not dropped just because a noisy speech-start occurred before the transcript was processed.
- `early_duplicate_cancelled` followed by `response_quality_fail` does not trigger an old-turn response into the next user turn.
- No more than one recovery response is allowed per user turn unless the active turn token still matches.

Tests:

- Duplicate correction is dropped after a newer user transcript.
- Synthesis gate cap fallback is dropped after a newer speech-start/user transcript.
- Response timeout fallback is dropped after newer input activity.
- Response-create retry-after-done is dropped after a newer user turn has taken ownership.
- Deferred text/user-input drains preserve only the latest relevant active-turn work.
- Primary accepted-transcript response still dispatches when only pre-transcript speech-start activity belongs to the same turn.
- `_skipDupCheckForNextResponse` is cleared when the intended response is cancelled or stale.
- Existing duplicate circuit breaker tests continue to pass.

Validation completed:

- `npm test -- --runTestsByPath tests/response-quality-routing.test.js --silent` passed: 43 tests.
- `npm test -- --runTestsByPath tests/response-quality-routing.test.js tests/responseDuplicate.test.js tests/createCallSession.contextHydration.test.js --silent` passed: 65 tests.
- Final hardening pass refreshed duplicate-short deferred queue ownership in `session/conversationEngine.js`, preventing a newer repeated short utterance from inheriting a stale queued owner.
- `npm test -- --runTestsByPath tests/sprint4.5-phase4.test.js tests/response-quality-routing.test.js --silent` passed: 56 tests.
- `npm run validate:telemetry` passed.
- `npm run validate:phase3-surface` passed.
- `npm test -- --silent` passed: 61 suites, 1595 tests. Existing Jest force-exit open-handle warning remains.
- `git diff --check` and editor diagnostics passed for touched files.

### Slice 3: Add log replay assertions for this exact failure class

Priority: High

Status: Implemented and validated. The replay script now emits per-call `replayAssertions` plus a top-level `assertions` pass/fail summary while preserving the existing gate/speech metrics.

Files:

- `scripts/simulate-log-based-calls.js`
- `tests/` or a new focused replay test if practical

Implementation:

1. Extend the replay script to count barge-in recovery events where `status.isUserSpeaking=true`.
2. Count recovery nudges that occur before the next `speech_stopped` or `user_transcribed` for the same speech window.
3. Count duplicate/synthesis recovery chains per turn.
4. Emit a compact pass/fail summary for:
   - `unsafeBargeInRecoveryNudges`
   - `recoveryBeforeTranscript`
   - `duplicateSynthesisChains`
   - `maxRecoveryResponsesPerTurn`

Acceptance:

- The current log should reproduce the unsafe events before the fix.
- After the fix, replay should show zero unsafe recovery nudges while preserving transcript completion counts.

Validation after implementation:

- `npm test -- --runTestsByPath tests/simulate-log-based-calls.test.js --silent` passed: 4 tests.
- Replay command reproduced the legacy failure baseline as first-class JSON assertions: 3 calls, `unsafeBargeInRecoveryNudges=6`, `recoveryBeforeTranscript=4`, `duplicateSynthesisChains=11`, `maxRecoveryResponsesPerTurn=7`, and `speechWindowNoTranscript=0`.
- Per-call assertion summary now marks the two unsafe legacy calls as failing and the safe call as passing.
- The aggregate `assertions.checks.speechWindowNoTranscript` check passes, confirming transcript completion metrics are preserved by the replay assertion layer.

Validation pass before implementation:

- Current command: `node scripts/simulate-log-based-calls.js "/Users/divyanggarg/Downloads/voicebot-out 87.log" "/Users/divyanggarg/Downloads/voicebot-error 36.log"`.
- Current script confirmed 3 calls and preserves the speech-window baseline: 30/35 speech windows transcribed, 0 speech-window timeout misses, max transcript delay 847 ms.
- Direct event scan confirms legacy failure reproduction in the current production log: 6 `barge_in_recovery` events fired with `status.isUserSpeaking=true`.
- 4 of those unsafe recovery events had a `silence_nudge_scripted_sent` before the next `speech_stopped`, `user_transcribed`, or new `speech_started` boundary.
- Duplicate/synthesis recovery churn is reproducible: 11 duplicate/synthesis chains across the log, with the worst call reaching 7 recovery-class events in one turn.
- Per-call baseline counters:
   - `cd7e7b26...`: unsafe=3, recoveryBeforeTranscript=2, duplicateSynthesisChains=4, maxRecoveryResponsesPerTurn=5.
   - `f5ea361f...`: unsafe=3, recoveryBeforeTranscript=2, duplicateSynthesisChains=5, maxRecoveryResponsesPerTurn=7.
   - `fd4fc715...`: unsafe=0, recoveryBeforeTranscript=0, duplicateSynthesisChains=2, maxRecoveryResponsesPerTurn=2.
- Slice 3 should add these counters to `scripts/simulate-log-based-calls.js` as first-class JSON output, then add a focused replay test or fixture-backed unit test so future regressions fail in CI.

### Slice 4: Validation logging and raw-content runbook

Priority: Medium

Status: Grounded against current code. No new runtime code is required before this slice; the pass should focus on a controlled validation runbook and operator discipline.

Files:

- `.env.example`
- `Utils/redactionPolicy.js`
- `Utils/structuredLogger.js`
- `Utils/logger.js`
- `repositories/ConversationRepository.js`
- `adapters/ai/BaseRealtimeAdapter.js`
- `session/createCallSession.js`
- `tests/structuredLogger.test.js`
- `tests/conversationRepositoryRedaction.test.js`
- `docs/` or a validation runbook if desired

Grounded code paths verified:

1. `app.js` installs `installStructuredConsoleLogger()` at process startup, so normal console output is sanitized before it reaches stdout/log files.
2. `Utils/redactionPolicy.js` reads `VOICEBOT_REDACT_CALL_CONTENT` dynamically and defaults to redaction enabled. Recognized false values are `false`, `0`, `off`, `no`, and `disabled`.
3. `Utils/structuredLogger.js` returns raw strings when `VOICEBOT_REDACT_CALL_CONTENT=false`; otherwise transcript/text/content/preview/phrase/question-like keys become hashed redaction summaries, with optional PII-redacted debug text for allowlisted calls.
4. `Utils/logger.js` sanitizes telemetry logger payloads through `sanitizeValue()`, so the same raw-content switch applies to telemetry payload fields that contain text.
5. `repositories/ConversationRepository.js` stores raw `content` only when `VOICEBOT_REDACT_CALL_CONTENT=false`; by default it persists `redactPII(content)`.
6. `BaseRealtimeAdapter` logs `user_transcribed` with `transcript: userText`, logs bot `ai_response` with `transcript: aiText` or `processedAiText`, and writes user/bot turns through `insertConversation()`.
7. `session/createCallSession.js` logs `[TRANSCRIPT RECEIVED]` with `text: userText`, transcript length, and confidence. Structured console redaction still controls whether `text` appears raw.
8. `session/createCallSession.js` implements `GATE_DEBUG_TRACE_CALL_IDS` and `GATE_DEBUG_TRACE_SAMPLE_RATE` directly in the media path. The trace is exact-call-id allowlisted, sampled per frame, and emits numeric GateV2/acoustic metrics only, not raw audio or transcript text.

Important guardrails:

- `VOICEBOT_REDACT_CALL_CONTENT=false` is process-global, not call-scoped. Use it only on an isolated validation instance or during a tightly controlled maintenance window.
- `GATE_DEBUG_TRACE_CALL_IDS` is call-scoped and safer to leave available because it emits acoustic metrics only.
- If raw content is not required, prefer `VOICEBOT_DEBUG_TEXT_LOGS=true` plus `VOICEBOT_DEBUG_TEXT_CALL_IDS=<call-id>` while leaving `VOICEBOT_REDACT_CALL_CONTENT=true`; this exposes call-scoped PII-redacted text snippets for debugging without storing raw PII.
- `.env` changes require the running service to receive the updated environment. In normal deployment that means restart/redeploy; the code reads `process.env` dynamically but cannot see file edits that were not loaded into the process.

Implementation:

1. Keep production default redaction enabled:
   - `VOICEBOT_REDACT_CALL_CONTENT=true`
2. For raw semantic validation only, run an isolated validation instance with:
   - `VOICEBOT_REDACT_CALL_CONTENT=false`
   - `GATE_DEBUG_TRACE_CALL_IDS=<call-id>`
   - `GATE_DEBUG_TRACE_SAMPLE_RATE=1`
3. Also capture the safer call-scoped debug-text mode in one dry run to verify fallback observability:
   - `VOICEBOT_REDACT_CALL_CONTENT=true`
   - `VOICEBOT_DEBUG_TEXT_LOGS=true`
   - `VOICEBOT_DEBUG_TEXT_CALL_IDS=<call-id>`
   - `VOICEBOT_DEBUG_TEXT_MAX_CHARS=400`
4. Capture raw transcript semantics plus gate metrics for at least:
   - quiet environment
   - normal mobile environment
   - speakerphone/noisy room
   - intentional interruption while bot speaks
   - accidental background speech while bot speaks
5. For each call, correlate these events in the log/replay output:
   - `speech_started`
   - `barge_in`
   - `barge_in_recovery_suppressed_state`
   - `barge_in_recovery_recheck_scheduled`
   - `barge_in_recovery_hard_timeout`
   - `barge_in_recovery_clarification_sent`
   - `user_transcribed`
   - `silence_nudge_scripted_sent`
   - `stale_recovery_response_dropped`
   - `[GateV2 TRACE]`
6. Re-enable redaction immediately after validation and clear call allowlists:
   - `VOICEBOT_REDACT_CALL_CONTENT=true`
   - unset `GATE_DEBUG_TRACE_CALL_IDS`
   - unset `VOICEBOT_DEBUG_TEXT_CALL_IDS`
7. Replay the captured validation logs with `scripts/simulate-log-based-calls.js` and confirm the Slice 3 assertion summary passes for new calls.

Acceptance:

- Raw validation confirms whether the post-fix bot waits for actual transcripts instead of apologizing/nudging during active speech.
- Gate traces show whether Plivo's high drop ratio is suppressing meaningful speech or mostly filtering background/noise.
- New validation logs produce zero `unsafeBargeInRecoveryNudges` and zero `recoveryBeforeTranscript` while preserving `speechWindowNoTranscript=0` or explaining any missed window with raw semantics and gate trace context.
- Conversation persistence contains raw call text only during the explicitly isolated validation run, then returns to PII-redacted persistence.

Validation commands:

- `npm test -- --runTestsByPath tests/structuredLogger.test.js tests/conversationRepositoryRedaction.test.js --silent`
- `node scripts/simulate-log-based-calls.js "<validation-out-log>" "<validation-error-log>"`

### Slice 5: Gate tuning only after raw validation

Priority: Medium

Status: Validated for implementation against current code.

Grounded code/path validation:

1. Provider-specific gate defaults are implemented and currently divergent by design:
   - `TwilioProvider.getGateConfig()` defaults: `dynamicThresholdOffset=0.02`, `silenceFramesThreshold=20`, `energyOverrideThreshold=0.03`, `maxSilenceFailsafe=50`.
   - `PlivoProvider.getGateConfig()` defaults: `dynamicThresholdOffset=0.02`, `silenceFramesThreshold=50`, `energyOverrideThreshold=null`, `maxSilenceFailsafe=150`.
2. Runtime GateV2 decisions in `session/createCallSession.js` already support all Slice 5 tuning levers:
   - dynamic threshold (`noiseFloor + dynamicThresholdOffset + highNoiseFloorBias`)
   - low-level initial window (`silenceFramesThreshold`)
   - optional `energyOverrideThreshold`
   - optional `maxSilenceFailsafe`
3. Current runtime emits gate diagnostics needed for comparison:
   - call-scoped `[GateV2 TRACE]` when allowlisted
   - per-turn `gate_turn_summary` telemetry with pass/drop ratios, energy/noise stats, and transcript length/confidence
4. Replay script currently exposes baselining fields for gate/transcript outcomes:
   - `sampledGateFrames`, `sampledSentFrames`, `sampledDroppedFrames`, `sampledDropRatio`, `highEnergyDroppedFrames`
   - `speechWindowTranscribed`, `speechWindowNoTranscript`, `maxTranscriptDelayMs`

Validation results (latest codebase):

- `npm test -- --runTestsByPath tests/sprint3.5-audio-pipeline.test.js tests/simulate-log-based-calls.test.js tests/sprint4-production-replay.test.js --silent` passed: 3 suites, 70 tests.
- `npm test -- --runTestsByPath tests/callFinalizer.test.js tests/sprint5a-validation.test.js tests/telemetry-adapter.test.js --silent` passed: 3 suites, 112 tests.
- Runtime provider defaults resolved from code at execution time:
   - Plivo: `{ dynamicThresholdOffset: 0.02, silenceFramesThreshold: 50, energyOverrideThreshold: null, maxSilenceFailsafe: 150 }`
   - Twilio: `{ dynamicThresholdOffset: 0.02, silenceFramesThreshold: 20, energyOverrideThreshold: 0.03, maxSilenceFailsafe: 50 }`
- Replay baseline from current production log remains stable for comparison:
   - 3 calls; replay assertions totals unchanged (`unsafe=6`, `recoveryBeforeTranscript=4`, `duplicateSynthesisChains=11`, `maxRecoveryResponsesPerTurn=7`)
   - transcript preservation remains `speechWindowNoTranscript=0`.

Current measurable-vs-gap note:

- Transcript completion rate, gate drop metrics, and high-energy drop behavior are directly measurable now.
- Replay assertions now include booking funnel observability (`bookingIntentDetectedCalls`, `bookingLinkRequestedCalls`, `bookingLinkSentCalls`) plus an informational `bookingIntentCaptureRate` check for controlled-call comparisons.

Files:

- `adapters/telecom/PlivoProvider.js`
- `adapters/telecom/TwilioProvider.js`
- `.env.example`
- `session/createCallSession.js`

Implementation:

1. Do not globally lower GateV2 thresholds based only on the redacted log.
2. Use raw validation and gate traces to decide whether Plivo should enable a conservative `PLIVO_GATE_ENERGY_OVERRIDE_THRESHOLD`.
3. If tuning is needed, run provider-specific tests and compare:
   - transcript completion rate
   - false VAD starts during bot playback
   - noisy transcript count
   - booking-intent capture rate
4. Keep Twilio and Plivo thresholds provider-specific.

Acceptance:

- Gate tuning improves transcript capture without increasing false background-noise captures or bot self-echo transcripts.
- Provider-specific tuning decisions are evidence-backed by call-scoped gate traces and per-turn gate summaries, not global threshold changes.

### Slice 6: Reconnect and hold-music production verification

Priority: Medium

Status: Code-complete and validation-complete for repo-testable behavior.

Grounded code/path validation:

1. `session/createCallSession.js` owns reconnect hold-music lifecycle with explicit helpers:
   - `startReconnectHoldMusic(info)` starts hold audio, emits `reconnect_hold_music_started`, and schedules bounded failsafe stop via `HOLD_MUSIC_MAX_DURATION_MS`.
   - `stopReconnectHoldMusic(reason)` always clears failsafe timer, stops hold music if available, and emits `reconnect_hold_music_stopped` when active.
   - Failsafe callback emits `reconnect_hold_music_failsafe_stop` and force-stops hold mode.
2. Abnormal reconnect events are wired to lifecycle helpers:
   - `realtimeService.on('disconnected')` calls start helper for abnormal/server errors (excluding region errors).
   - `realtimeService.on('reconnected')` calls stop helper with reason `reconnected`.
   - `realtimeService.on('reconnection_failed')` calls stop helper with reason `reconnection_failed`, emits `reconnection_failed_hangup`, and closes call path with bounded audio/hangup fallback.
3. Session cleanup path is safety-wired:
   - `cleanupCallSession()` invokes `stopReconnectHoldMusic(reason)` before closing/releasing session resources, preventing orphan hold loops after WebSocket close.
4. Provider stream services enforce hold-loop stop behavior:
   - `services-twilio/stream-service-twilio.js`: hold loop self-stops if turn is inactive/closed; `stopHoldMusic()` always clears interval and hold state.
   - `services-plivo/stream-service-plivo.js`: same interval-clear + hold-state reset semantics in `stopHoldMusic()`.
5. Telemetry event allowlist includes all Slice 6 reconnect/hold events in `Utils/telemetryEvents.js`.

Validation results (latest codebase):

- `npm test -- --runTestsByPath tests/createCallSession.contextHydration.test.js tests/stream-service-hold-music.test.js tests/hold-music-asset.test.js --silent` passed: 3 suites, 14 tests.
- `npm test -- --runTestsByPath tests/createCallSession.contextHydration.test.js --silent` passed: 1 suite, 10 tests.
- Added Slice 6 focused assertions in `tests/createCallSession.contextHydration.test.js` for:
   - reconnect telemetry start/stop/failsafe emission,
   - reconnection-failed stop telemetry and hangup telemetry emission.
- `npm run validate:telemetry` passed: contract/completeness/schema checks include reconnect hold-music events.
- `npm run validate:hold-music` passed: hold asset format/playback characteristics are valid for telephony path.

Residual production-only validation boundary:

- Repo-testable behavior is now covered; final closure still requires controlled live-call verification that user-audible hold music always stops under real carrier/network conditions (as required by rollout step 6 and Slice 6 acceptance).

Files:

- `session/createCallSession.js`
- `services-plivo/stream-service-plivo.js`
- `services-twilio/stream-service-twilio.js`
- `Utils/telemetryEvents.js`

Implementation:

1. Keep the current hold-music lifecycle hardening.
2. Add production validation checks for telemetry events:
   - `reconnect_hold_music_started`
   - `reconnect_hold_music_stopped`
   - `reconnect_hold_music_failsafe_stop`
3. Verify the user never hears indefinite hold music after a reconnect failure or WebSocket close.

Acceptance:

- Any abnormal realtime disconnect either recovers and stops music, or fails safely with a bounded message/hangup path.

## Rollout Sequence

1. Implement Slice 1 with tests.
2. Replay `voicebot-out 87.log` and confirm unsafe recovery nudge count drops to zero.
3. Implement Slice 2 with tests.
4. Replay again and confirm duplicate/synthesis chains are bounded per turn.
5. Run the focused test pack.
6. Run 5 to 10 controlled validation calls with raw content enabled.
7. Decide on GateV2 tuning only after the raw validation set.
8. Re-enable redaction and remove call-scoped gate trace IDs.

## Success Metrics

Primary:

- Zero recovery nudges while caller speech is active or pending transcription.
- Zero stale fallback/correction responses delivered after a newer user transcript.
- No repeated identical bot response within the same call unless it is an intentional scripted silence nudge.
- Transcript completion remains stable or improves.

Secondary:

- Lower caller-perceived awkwardness during interruptions.
- Lower duplicate suppression and synthesis-gate churn per call.
- Reconnect hold music always stops on reconnect, close, or failsafe.
- Booking flow reaches qualification/contact/booking stages more consistently in validation calls.

## Non-Goals

- Do not replace Azure VAD or GateV2 in this slice.
- Do not assume speech-start is always intentional user speech.
- Do not assume a garbled transcript proves background noise.
- Do not globally tune Plivo/Twilio gate thresholds without raw call validation.