# Two-Phase Voice Live Routing - Phase 1 Validation

Date: 2026-04-29
Branch: `feature/two-phase-voice-live-routing`

## Scope

Phase 1 wires Azure Voice Live model readiness without enabling two-phase routing. The Azure adapter
can now append `model=gpt-realtime-mini` for Voice Live endpoints when `AZURE_VOICE_LIVE_MODEL` or
adapter config `model` is set, while preserving endpoints that already contain a `model` query.

## Compatibility Rules Validated

- Existing endpoints with `model=phi4-mm-realtime` remain unchanged.
- Existing endpoints with no model remain unchanged when no model override is set.
- Voice Live endpoints without a model append the configured model query.
- Legacy Azure OpenAI Realtime `/openai/realtime?...deployment=...` endpoints do not receive a
  Voice Live model query and produce a warning.
- `gpt-realtime` and `gpt-realtime-mini` use `AZURE_VOICE_LIVE_TRANSCRIPTION_MODEL` or
  `gpt-4o-mini-transcribe`.
- `phi4-mm-realtime` and unset effective models keep `azure-speech`.

## Validation Commands

```bash
npx jest tests/azureRealtimeAdapter.phase1.test.js tests/twoPhaseResponseConfig.test.js --no-coverage
npm run validate:phase3-surface
npm run validate:telemetry
npm test
```

Results:

- Focused Phase 1/Phase 0 tests: 17 passed, 0 failed
- Phase 3 surface validation: passed
- Telemetry validation: passed with existing non-fatal unknown-event audit warnings
- Full Jest suite: 43 suites passed, 1450 tests passed
