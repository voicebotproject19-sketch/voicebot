# Drift Remediation Plan

This plan converts the verified repository drifts into a concrete remediation sequence. It is based on the current codebase, executed validation surfaces, and the current documentation set.

## Goal

Bring operator-facing configuration, automated validation, and canonical documentation back into sync with the actual runtime without accidentally regressing the live call path.

## Ground truth

The current runtime truth is defined by code, not by older audit documents.

Canonical runtime files:

- `app.js`
- `session/createCallSession.js`
- `services-twilio/realtimeServiceTwilio.js`
- `services-plivo/realtimeServicePlivo.js`
- `adapters/telecom/TwilioProvider.js`
- `adapters/telecom/PlivoProvider.js`
- `Helper/conversationPhase.js`
- `Helper/hangupDecision.js`
- `Helper/contextSummarizer.js`
- `.env.example`

Canonical analysis and inventory docs already added during the repository review:

- `docs/codebase-index.md`
- `docs/runtime-dependency-map.md`
- `docs/runtime-risk-review.md`
- `docs/full-codebase-index.md`
- `docs/full-codebase-analysis.md`
- `docs/confidence-gap-report.md`

## Verified drift inventory

### 1. Operator configuration drift

Current verified mismatches:

- `.env.example` documents `Azure_openAi_key` and `Azure_openAi_endpoint`, but runtime code uses `AZURE_OPENAI_API_KEY` and `AZURE_OPENAI_ENDPOINT` in `Helper/hangupDecision.js` and `Helper/contextSummarizer.js`.
- `.env.example` omits live runtime variables used by the current code path, including Azure OpenAI, VAD tuning, response timeout, greeting fallback, echo guard, default persona and language, and persona-specific handover notification variables.
- `.env.example` includes `DEBUG_VOICELIVE`, but no JavaScript file reads it.
- `adapters/telecom/TwilioProvider.js` supports both `TWILIO_ACCOUNT_AUTH_TOKEN` and `TWILIO_AUTH_TOKEN`, but only one is documented.

Impact:

- fresh environments can be configured incorrectly,
- Azure OpenAI helper paths can silently fail,
- operators cannot reliably infer which env vars are safe, required, or obsolete.

### 2. Test drift

Current verified mismatch:

- `tests/conversationPhase.test.js` is stale relative to `Helper/conversationPhase.js`.

Specific mismatches:

- runtime now includes `slot-collection`, but the test still expects direct `offer -> email-collection`,
- runtime only treats `emailConfirmed` as success when `userEmail` is also present,
- runtime exports 10 phases, but the test still expects 9.

Important interpretation:

- the drift is in the test, not in the runtime implementation.
- remediation must not remove `slot-collection` or loosen the success rule just to satisfy the stale test.

### 3. CI validator drift

Current verified mismatches:

- `ci/scripts/check-provider-behavior-drift.js` scans `app.js` and assumes provider-specific call-control logic is still expressed there.
- `ci/scripts/check-adapter-compliance.js` scans `app.js` and assumes provider-specific telemetry sections are still statically visible there.
- both assumptions are stale because provider behavior is now expressed through `session/createCallSession.js` plus provider-injected realtime and stream services.

Important interpretation:

- these failures do not prove runtime bugs,
- they prove the CI validators still target an older architecture.

### 4. Layering drift

Current verified mismatch:

- `ci/scripts/check-vendor-leakage-core.js` flags `Helper/contextSummarizer.js` because it instantiates `AzureOpenAI` under `Helper/` instead of an adapter-allowed directory.

Important interpretation:

- this is a real layering inconsistency,
- but it is not hidden activation or dead code confusion,
- remediation requires an architectural choice: either move vendor-specific summarization behind an adapter boundary, or explicitly allow this file as an exception.

### 5. Documentation drift

Current verified mismatches:

- older docs still describe STT as Whisper or `whisper-1`, but the live code uses `input_audio_transcription.model: 'azure-speech'` in both realtime services.
- older docs still describe old voice names or old `session.update` payloads.
- some older docs still describe pre-refactor provider logic directly in `app.js`.
- `docs/structural-audit-results.md` still references `Azure_openAi_key` and `Azure_openAi_endpoint`.
- `docs/openai-rate-limit-analysis.md` still describes STT as Whisper.
- `docs/structural-architecture-audit.md` still contains several pre-refactor model and provider assumptions.

Important interpretation:

- not every old document should be rewritten as if it were current truth,
- some audit documents are historical snapshots and should instead be labeled as historical or superseded.

### 6. Deployment and setup drift

Current verified mismatch:

- `migrations/001_call_sessions.sql` and `migrations/002_legacy_tables.sql` exist, but there is no migration runner in the Node runtime.
- repository code assumes those tables already exist.

Important interpretation:

- this is a setup and deployment drift, not an in-process runtime drift,
- but it directly affects first-run correctness and should be treated as operationally important.

## Remediation strategy

The remediation should proceed in six workstreams.

## Workstream 1: Fix operator-facing configuration truth

Scope:

- `.env.example`
- any canonical setup docs that point operators to env var names

Actions:

1. Replace `Azure_openAi_key` with `AZURE_OPENAI_API_KEY`.
2. Replace `Azure_openAi_endpoint` with `AZURE_OPENAI_ENDPOINT`.
3. Add missing live runtime env vars used by the current hot path.
4. Mark optional versus required vars clearly.
5. Remove `DEBUG_VOICELIVE` if the code no longer supports it, or reintroduce the code path explicitly if it is still intended.
6. Document both `TWILIO_ACCOUNT_AUTH_TOKEN` and `TWILIO_AUTH_TOKEN`, but identify one as canonical.

Acceptance criteria:

- every env var read on the live path is either documented or intentionally internal,
- no stale env var remains in `.env.example`,
- operator setup docs point to the same variable names the runtime actually reads.

## Workstream 2: Realign tests with current runtime behavior

Scope:

- `tests/conversationPhase.test.js`
- potentially supporting comments in `Helper/conversationPhase.js`

Actions:

1. Update the happy-path expectations to include `slot-collection` between `offer` and `email-collection`.
2. Update the success expectation so `emailConfirmed` without `userEmail` does not imply `success`.
3. Update the phase-count assertion from 9 to 10.
4. Add explicit assertions for `preferredSlot` so the new path is tested intentionally.

Acceptance criteria:

- `node tests/conversationPhase.test.js` passes,
- the test reflects the current implementation rather than forcing the implementation backward,
- the test names describe the real phase model now in use.

## Workstream 3: Rewrite stale CI validators to target the current architecture

Scope:

- `ci/scripts/check-provider-behavior-drift.js`
- `ci/scripts/check-adapter-compliance.js`

Actions:

1. Stop scanning only `app.js` for provider parity.
2. Rewrite provider drift validation around the current architecture:
	- shared orchestration in `session/createCallSession.js`,
	- provider capabilities in `adapters/telecom/TwilioProvider.js` and `adapters/telecom/PlivoProvider.js`,
	- provider-specific runtime behavior in `services-twilio/` and `services-plivo/`.
3. Decide what parity actually means after the refactor.
4. Validate the current architecture directly instead of inferring from comment locality or provider string sections in `app.js`.

Acceptance criteria:

- the validators pass against the current structure when behavior is actually in sync,
- the validators fail only on real drift, not on architectural relocation,
- the validator logic names the files that now own provider behavior.

## Workstream 4: Resolve the context summarizer layering inconsistency

Scope:

- `Helper/contextSummarizer.js`
- `ci/scripts/check-vendor-leakage-core.js`
- possibly `adapters/telemetry/` style boundaries or a new model adapter file

Decision required:

Choose one of these approaches.

### Option A: Move summarization behind an adapter boundary

Actions:

1. Move Azure SDK construction out of `Helper/contextSummarizer.js`.
2. Replace it with a vendor-neutral helper or adapter call.
3. Keep the realtime services calling a helper, but ensure that helper no longer directly constructs a vendor client.

Best when:

- the codebase wants strong vendor-boundary enforcement,
- future model-provider swaps are expected.

### Option B: Keep the implementation where it is and narrow the validator

Actions:

1. Treat `Helper/contextSummarizer.js` as an intentional exception.
2. Update `ci/scripts/check-vendor-leakage-core.js` to allow a small, explicit whitelist.
3. Document why this file is exempt and why the exemption is safe.

Best when:

- a small architectural exception is acceptable,
- minimizing code movement in the live path is the higher priority.

Acceptance criteria:

- the validator outcome matches the intended architecture,
- the chosen boundary is documented,
- no ambiguous half-state remains where the file is both allowed in practice and treated as forbidden in CI.

## Workstream 5: Normalize canonical docs and mark historical docs correctly

Scope:

- operator-facing and current-state docs,
- older audits and architecture snapshots,
- `docs/README.md`

Actions:

1. Update canonical docs that are intended to reflect current runtime truth.
2. Correct STT/TTS references from Whisper to Azure Realtime plus `azure-speech` where the doc is meant to be current.
3. Correct old env var names where the doc is meant to be current.
4. Mark older audits as historical snapshots if they intentionally capture a prior architecture.
5. Avoid rewriting history in audit documents unless the document’s purpose is current-state reference.

Recommended classification:

- Current truth docs: keep fully synchronized.
- Historical audits: mark as historical and optionally link to newer canonical docs.

Priority candidates for correction or labeling:

- `docs/structural-audit-results.md`
- `docs/structural-architecture-audit.md`
- `docs/voice-platform-analysis.md`
- `docs/openai-rate-limit-analysis.md`
- any current-state setup or platform docs that still mention Whisper or old env names

Acceptance criteria:

- a reader can distinguish current runtime truth from historical architecture snapshots,
- no canonical doc contradicts the live code on STT, TTS, env vars, or provider wiring,
- `docs/README.md` points readers to the right current-state documents first.

## Workstream 6: Close the deployment setup gap

Scope:

- migrations,
- setup docs,
- deployment process

Actions:

1. Decide whether migrations will stay manual or be added to an automated runner.
2. If manual, document the exact required steps and ordering.
3. If automated, add a supported migration path and startup expectations.
4. Ensure deployment docs mention the schema dependency before first write.

Acceptance criteria:

- a new environment can be brought up without guessing about schema creation,
- repository docs no longer imply that DB schema appears automatically if it does not.

## Recommended sequencing

1. Fix `.env.example` and current setup documentation.
2. Fix `tests/conversationPhase.test.js`.
3. Rewrite the two stale CI drift validators.
4. Make the architectural decision for `Helper/contextSummarizer.js` and resolve vendor-leakage validation accordingly.
5. Normalize current-state docs and label historical docs.
6. Document or automate migration execution.

## Verification checklist

After remediation, the following should hold.

### Tests and validators

- `node tests/callClassifier.test.js` passes
- `node tests/callPipeline.test.js` passes
- `node tests/conversationPhase.test.js` passes
- `node ci/scripts/run-phase3-deterministic.js` passes
- `node ci/scripts/run-phase2-5-deterministic-v2.js` passes
- `node ci/scripts/check-hotpath-async.js` passes
- `node ci/scripts/check-telemetry-contract.js` passes
- `node ci/scripts/check-provider-behavior-drift.js` passes for the right reasons
- `node ci/scripts/check-adapter-compliance.js` passes for the right reasons
- `node ci/scripts/check-vendor-leakage-core.js` matches the chosen architecture

### Documentation and setup

- `.env.example` matches the live runtime variables read by the hot path
- current-state docs match the live STT and TTS implementation
- historical docs are explicitly labeled as historical where appropriate
- DB setup steps are explicit and reproducible

## Non-goals

This plan does not assume any of the following unless separately approved:

- activating the Phase 4 pipeline,
- wiring in the tiered retrieval cluster,
- refactoring the live call path for style only,
- changing provider behavior just to satisfy stale validators.

## Final principle

The right remediation is to align validation and documentation to the current runtime truth, not to regress the runtime back to match stale tests, stale CI scripts, or historical audits.
