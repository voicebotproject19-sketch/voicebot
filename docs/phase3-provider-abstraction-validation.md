# Phase 3 Provider Abstraction Validation

Date: 2026-04-04

This document captures the acceptance evidence for Phase 3 from:
- `docs/realtime-provider-abstraction-plan.md` (Section 13, Phase 3)

## Scope

Phase 3 acceptance in plan:
1. `OpenAIRealtimeAdapter` passes the same contract compliance validator.
2. Audio transcoding round-trip test: `μ-law -> PCM16 24kHz -> μ-law` with `< 1 dB` SNR loss.
3. End-to-end call via OpenAI Realtime with correct STT, coherent LLM responses, intelligible TTS.
4. `AI_PROVIDER=openai-realtime` switches provider with no other code change.
5. Latency delta vs Azure documented.

## Script Wiring

The repository now exposes the validation surface via `package.json` scripts:
- `validate:ai-adapters`
- `validate:provider-abstraction`
- `validate:phase3-deterministic`
- `test:audio-transcode`
- `validate:phase3-surface` (aggregates all required script checks)

## Automated Evidence (Completed)

Run command:

```bash
npm run validate:phase3-surface
```

Observed result on 2026-04-04:
- `validate:ai-adapters`: PASS
  - `ci/scripts/check-adapter-contract.js`: PASS
  - `ci/scripts/check-adapter-compliance.js`: PASS
- `validate:provider-abstraction`: PASS
  - `ci/scripts/check-provider-behavior-drift.js`: PASS
- `validate:phase3-deterministic`: PASS
  - `ci/scripts/run-phase3-deterministic.js`: PASS
- `test:audio-transcode`: PASS
  - Includes SNR acceptance assertion `< 1 dB` additional loss versus baseline μ-law codec path.

## Manual Acceptance Steps (Operational)

The following checks require live provider credentials/telephony and cannot be proven by static repository scripts alone.

### 1. Provider switch proof (`AI_PROVIDER=openai-realtime`)

1. Set environment:

```bash
AI_PROVIDER=openai-realtime
OPENAI_REALTIME_API_KEY=<key>
OPENAI_REALTIME_MODEL=gpt-realtime-1.5
```

2. Start service:

```bash
npm start
```

3. Place an outbound call via `/api/call`.
4. Confirm logs and telemetry show OpenAI adapter path (`provider=openai-realtime`).

Acceptance outcome field:
- Status: [ ] PASS [ ] FAIL
- Evidence notes:

### 2. End-to-end OpenAI call quality

Validate on at least one call:
- STT transcript is accurate for caller utterances.
- LLM responses are coherent and on-policy.
- TTS output is intelligible over telecom path.

Acceptance outcome field:
- Status: [ ] PASS [ ] FAIL
- Call IDs tested:
- Evidence notes:

### 3. Latency delta vs Azure documented

1. Run one comparable call on Azure (`AI_PROVIDER=azure-realtime`) and one on OpenAI (`AI_PROVIDER=openai-realtime`).
2. Compare telemetry from:
- `response_latency`
- `speech_playback_started`
- `speech_completed`

3. Record delta table:

| Metric | Azure | OpenAI | Delta |
|---|---:|---:|---:|
| median response latency (ms) |  |  |  |
| P95 response latency (ms) |  |  |  |
| median playback start (ms) |  |  |  |

Acceptance outcome field:
- Status: [ ] PASS [ ] FAIL
- Evidence notes:

## Final Phase 3 Validation Status

- Script-based validation surface: PASS
- Manual operational validation: PENDING SIGN-OFF

Phase 3 can be treated as implementation-complete in repository artifacts. Final operational acceptance requires completing the three manual checks above in a live environment.
