# Confidence Gap Report

This report captures the final gaps encountered during exhaustive repository analysis and classifies them as either resolved from repository contents or irreducible without external runtime context.

## Bottom line

Literal 100% confidence is not achievable from repository inspection alone because some uncertainty depends on external facts:

- the actual production environment variables in use,
- whether migrations were applied in deployed environments,
- whether standalone scripts are run manually outside normal startup,
- and whether there are external operational workflows not stored in this repository.

However, the repository-internal analysis gaps have now been reduced to a short, explicit set.

## Resolved from repository contents

### 1. Environment and documentation drift

- `.env.example` uses `Azure_openAi_key` and `Azure_openAi_endpoint`, but the live code uses `AZURE_OPENAI_API_KEY` and `AZURE_OPENAI_ENDPOINT` in `Helper/hangupDecision.js` and `Helper/contextSummarizer.js`.
- `.env.example` also omits several live runtime env vars used by the current runtime path.
- `.env.example` includes at least one stale entry, `DEBUG_VOICELIVE`, that has no consumer in code.

### 2. Dynamic loading is now understood

- Knowledge base classes are loaded dynamically from persona language config, but the current set is closed and known.
- Persona files are auto-loaded by scanning `personas/` and requiring all non-underscore `.js` files.

### 3. Active versus dormant clusters are now understood

- The live runtime path is centered on `app.js`, `session/createCallSession.js`, telecom adapters, provider realtime services, helpers, policy, and persistence modules.
- The Phase 4 cluster and tiered retrieval cluster are implemented but not clearly wired into the active server runtime.

### 4. Validation surfaces were executed

Passing:

- `tests/callClassifier.test.js`
- `tests/callPipeline.test.js`
- `ci/scripts/run-phase3-deterministic.js`
- `ci/scripts/run-phase2-5-deterministic-v2.js`
- `ci/scripts/check-hotpath-async.js`
- `ci/scripts/check-telemetry-contract.js`

Drift or failure:

- `tests/conversationPhase.test.js` fails against the current `Helper/conversationPhase.js` implementation because the code now includes `slot-collection`, treats success more strictly, and exposes 10 phases instead of the test's expected 9.
- `ci/scripts/check-provider-behavior-drift.js` assumes provider behavior can still be inferred from `app.js`, but provider logic has moved into the shared session factory and provider-specific services.
- `ci/scripts/check-adapter-compliance.js` similarly relies on older structural assumptions about provider telemetry sections.
- `ci/scripts/check-vendor-leakage-core.js` flags `Helper/contextSummarizer.js` for Azure SDK usage in a core-layer file. This is a valid architectural concern, but not evidence of hidden runtime activation elsewhere.

### 5. Database setup expectations are now understood

- SQL migrations exist, but no migration runner is present in the application runtime.
- Repository code assumes the database schema already exists.

## Irreducible without external context

These cannot be fully proven from repository contents alone.

### 1. Actual production environment state

The repository shows what variables are consumed, but not which values are actually configured in deployed systems.

### 2. Actual production database state

The repo contains migrations, but it cannot prove whether they were applied in each environment.

### 3. External invocation patterns

Some CI and utility scripts may be run manually by operators or other automation outside this repository. The repo can show availability, not guaranteed usage frequency.

### 4. External service behavior

The code makes Azure, Twilio, and Plivo assumptions, but static analysis cannot prove that live vendor responses and timing always match those assumptions.

## Practical confidence statement

For repository-internal structure and behavior, confidence is now high.

- Live runtime architecture: high confidence
- Whole-repository classification: high confidence
- Active versus dormant clustering: high confidence
- External operational reality: not fully knowable from repo inspection alone

## Recommended interpretation

Use this repository analysis as authoritative for:

- code structure,
- import and activation paths,
- runtime layering,
- validation and CI surface,
- and documented design drift.

Do not treat it as proof of:

- deployed configuration correctness,
- migration application status,
- or real production behavior under all vendor conditions.