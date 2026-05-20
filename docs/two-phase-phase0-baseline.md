# Two-Phase Voice Live Routing - Phase 0 Baseline

Date: 2026-04-29
Branch: `feature/two-phase-voice-live-routing`

## Purpose

This file captures the Phase 0 implementation baseline before enabling any two-phase response
behavior. All new flags default off, so runtime behavior should remain equivalent to the existing
Azure Voice Live path.

## Worktree Baseline

- Created branch: `feature/two-phase-voice-live-routing`
- Starting branch before implementation: `main`, ahead of `origin/main` by 3 commits
- Starting worktree: clean

## Validation Baseline

Commands run during Phase 0:

```bash
npx jest tests/twoPhaseResponseConfig.test.js --no-coverage
npm run validate:phase3-surface
npm run validate:telemetry
npm test
```

Results:

- Focused Phase 0 config test: 7 passed, 0 failed
- Phase 3 surface validation: passed
- Telemetry validation: passed with the repo's existing non-fatal unknown-event audit warnings
- Full Jest suite final run: 42 suites passed, 1440 tests passed

Note: the first full Jest run hit an existing Monte Carlo boundary in
`tests/sprint4-ux-pipeline-simulation.test.js` where `callsWithCollapseRate` was exactly `65` and
the test expects `<65`. The isolated rerun of that suite passed all 38 tests, and the second full
suite passed all tests.

## Test-Derived Latency and UX Baseline

From the existing Sprint 4 UX simulation suite rerun:

| Metric | Observed Baseline |
|---|---:|
| Modeled baseline TTFA | 1292ms |
| Production p50 reference | 1380ms |
| Sprint 4 weighted TTFA | 1242ms |
| Sprint 4 TTFA p50 in 100-call projection | 1122ms |
| Sprint 4 TTFA p90 in 100-call projection | 1542ms |
| Sprint 4 average TTFA in 100-call projection | 1149ms |
| KB bypass rate in 100-call projection | 77.7% |
| Mode collapse rate in 100-call projection | 11.2% |
| QA gate catch rate in 100-call projection | 83% |
| Calls with at least one collapse in rerun | 46% |

## Phase 0 Runtime Baseline

No live-call traffic was run during Phase 0. The implemented changes are limited to configuration,
telemetry registration, env documentation, and tests. The new config intentionally keeps
`AZURE_VOICE_LIVE_MODEL` empty by default so the current endpoint-embedded model behavior is
unchanged unless a later sprint explicitly enables canary settings.
