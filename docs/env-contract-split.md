# Environment Contract Split

The current `.env.example` remains the compatibility aggregate for CI and deployment. It is intentionally not reduced until split env files are complete and validation proves the union covers every runtime `process.env` reference.

## Current State

- `npm run validate:env` now reads `.env.example` plus any root-level `.env.*.example` files.
- The validator treats active variables across those files as one union contract.
- `.env.example` still contains the full aggregate contract and can be copied to `.env` for existing environments.
- Split files can be introduced incrementally without making validation blind.

## Target Files

| File | Ownership |
|------|-----------|
| `.env.core.example` | Platform runtime: server, auth, database, AI providers, telecom credentials, telemetry, global policy, latency, consent, and deployment guards. |
| `.env.features.example` | Optional feature/plugin settings: booking, dealer order, handover, SMTP notifications, RAG synthesis, demobot, experiments, and ROI estimates. |
| `.env.personas.example` | Persona/client overrides: default persona/language, client-specific contacts, workflow enablement, transfer numbers, notification targets, and per-persona delivery gates. |
| `.env.example` | Backward-compatible aggregate until operators and deployment automation move to split files. |

## Migration Rules

1. Keep `.env.example` valid while split files are introduced.
2. Add or move vars into split files by ownership, then run `npm run validate:env`.
3. Do not remove a variable from `.env.example` until the split file containing it is committed and validation passes.
4. Core missing values should fail startup readiness. Feature missing values should fail only when that feature/persona/plugin is enabled.
5. Keep resolver modules accepting `env = process.env` so tests can validate feature config without mutating global state.

## Ownership Map

Core runtime includes:

- server/networking: `PORT`, `NODE_ENV`, `NETWORK_URL`, CORS, body limits, health/readiness controls
- auth/security: API keys, rate limits, HTTP security, deployment guards
- providers: Azure/OpenAI realtime and text models, Twilio, Plivo, STT/TTS provider selection
- database: MySQL connection and pool settings
- telemetry: Azure Monitor, OpenTelemetry, redaction, sampling, debug logging
- global conversation policy: Phase 3, Phase 4, VAD, turn isolation, latency budgets, recording consent

Feature and plugin settings include:

- booking providers, webhook secrets, booking delivery, and correlation settings
- dealer-order ERP endpoint, notification channels, retry/fallback, and ROI estimate
- warm transfer and handover routing
- SMTP-backed notifications
- RAG synthesis and model-router experiments
- demobot/test harness feature flags

Persona/client overrides include:

- default persona and language
- persona-specific transfer numbers, notification emails, booking URLs, and delivery gates
- workflow enablement flags and per-client workflow parameters

## Validation

Run this after every env contract change:

```bash
npm run validate:env
```

The expected steady-state output should report runtime variables, scanned runtime files, and the union of env contract files used. If split files exist, they should appear in the output alongside `.env.example`.
