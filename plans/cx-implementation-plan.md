# CX Implementation Plan — Phases A through F₁

> **Scope:** Implement CX Layers 1–4, Internal CX Control Plane API (Phase E),
> and `call_outcomes` table (Phase F₁). Every file path, line reference,
> function signature, and import is grounded in the current codebase.
>
> **Prerequisite:** `PHASE4_ENABLED=true` in `.env` activates all CX layers.
> Today it defaults to `false` in `config/phase4Config.js:8`.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Phase A — Pre-Generation Guard Rail](#2-phase-a--pre-generation-guard-rail)
3. [Phase B — Post-Generation Quality Gate](#3-phase-b--post-generation-quality-gate)
4. [Phase C — Turn-Adaptive Intelligence](#4-phase-c--turn-adaptive-intelligence)
5. [Phase D — Degradation Signal Enrichment](#5-phase-d--degradation-signal-enrichment)
6. [Phase E — Internal CX Control Plane API](#6-phase-e--internal-cx-control-plane-api)
7. [Phase F₁ — call_outcomes Table & Persistence](#7-phase-f--call_outcomes-table--persistence)
8. [Dependency & Parallelism Map](#8-dependency--parallelism-map)
9. [Verification Matrix](#9-verification-matrix)
10. [New Files Created](#10-new-files-created)
11. [Existing Files Modified](#11-existing-files-modified)

---

## 1. Architecture Overview

```
  Caller Audio
       │
  ┌────▼─────────────────────────────────────────────────┐
  │  Layer 4 (Phase D)  Degradation Signal Enrichment    │
  │  createCallSession.js L741 + L1497                   │
  │  Feed packetLoss + isTruncated → degradationEngine   │
  └────┬─────────────────────────────────────────────────┘
       │
  ┌────▼─────────────────────────────────────────────────┐
  │  Layer 3 (Phase C)  Turn-Adaptive Intelligence       │
  │  C1: complexity → token/temp  (BaseRealtime L1153)   │
  │  C2: persona audioPresets → VAD  (BaseRealtime L93)  │
  └────┬─────────────────────────────────────────────────┘
       │
  ┌────▼─────────────────────────────────────────────────┐
  │  Layer 1 (Phase A)  Pre-Generation Guard Rail        │
  │  conversationEngine.js L137                          │
  │  sanitize → ragGuardrails → intentGate               │
  └────┬─────────────────────────────────────────────────┘
       │
       ▼  LLM generates response
       │
  ┌────▼─────────────────────────────────────────────────┐
  │  Layer 2 (Phase B)  Post-Generation Quality Gate     │
  │  BaseRealtimeAdapter.js L1286                        │
  │  numericEnforcement → synthesisScoring → personaPass │
  └────┬─────────────────────────────────────────────────┘
       │
       ▼  Caller hears response
       │
  ┌────▼─────────────────────────────────────────────────┐
  │  Phase E   Internal CX Control Plane API             │
  │  /api/v2/  — observe, configure, control             │
  └────┬─────────────────────────────────────────────────┘
       │
  ┌────▼─────────────────────────────────────────────────┐
  │  Phase F₁  call_outcomes table                       │
  │  Structured outcome persistence at call-end          │
  └──────────────────────────────────────────────────────┘
```

---

## 2. Phase A — Pre-Generation Guard Rail

**Goal:** Sanitize retrieved KB docs, enforce retrieval quality, and gate low-confidence turns — all BEFORE the LLM sees the prompt.

**Insertion point:** `session/conversationEngine.js`, between KB retrieval settling (L110) and the existing `kbGate` check at L117. The current flow is:

```
L110: relevantKnowledge resolved (string from KB)
L117: const generalInfo = this.adapter.kb?.getGeneralInfo?.() ?? '';
L118: const kbGate = this.shouldInterceptWithKbGate(...)
...
L137: this.adapter._lastRelevantKnowledge = relevantKnowledge;
```

**What changes:**

### Step A1 — Add imports to `session/conversationEngine.js`

At the top of the file (after line 6), add:

```js
const { legacyRetrievalToDocs, applyRagGuardrails } = require('../rag/ragGuardrails');
const { sanitizeDocuments } = require('../rag/retrievalSanitation');
const { evaluateIntentConfidence } = require('../logic/intentGate');
const { PHASE4_ENABLED } = require('../config/phase4Config');
```

**Current imports (L1-7):**
```js
'use strict';
const { analyzeConversationForHangup } = require('../adapters/llm/hangupDecision');
const { quickHangupDecision, shouldPerformAnalysis } = require('../Helper/quickDecisionFilter');
const { computePhase } = require('../Helper/conversationPhase');
const { isFactualQuestionWithoutKB, scanForHallucination, getHallucinationFallback } = require('../Helper/hallucinationGuard');
const { LATENCY_COMPENSATION } = require('../config/latencyResponsivenessConfig');
```

### Step A2 — Insert guard rail logic after KB retrieval

After the line `this.adapter._lastRelevantKnowledge = relevantKnowledge;` (L137) and BEFORE `let updatedInstruction;` (L139), insert:

```js
        // ── Phase 4 Layer 1: Pre-generation guard rail ──────────
        if (PHASE4_ENABLED && this.adapter._phase4Profile) {
            const profile = this.adapter._phase4Profile;

            // A2a: Convert legacy KB string to doc array
            const rawDocs = legacyRetrievalToDocs(relevantKnowledge);

            // A2b: Sanitize — strip injection, HTML, code blocks
            const sanitizedDocs = rawDocs.length > 0
                ? sanitizeDocuments(rawDocs, this.adapter.persona?.id)
                : rawDocs;

            // A2c: Apply RAG guardrails — relevance floor, maxDocs, dedup
            const guardrailResult = applyRagGuardrails(sanitizedDocs, profile);
            this.adapter._lastSanitizedDocs = guardrailResult.docs;

            // A2d: Rebuild relevantKnowledge from sanitized docs
            if (guardrailResult.docs.length > 0) {
                relevantKnowledge = guardrailResult.docs
                    .map(d => d.content)
                    .join('\n\n');
                this.adapter._lastRelevantKnowledge = relevantKnowledge;
            }

            // A2e: Intent confidence gate
            // Use fastDecisionScore concept: confidence proxy from
            // conversation signals (count, phase, complexity)
            const intentConfidence = this.adapter.count <= 1
                ? 0.9  // First turn — always proceed
                : guardrailResult.zeroDocs ? 0.3 : 0.8;

            const gateResult = evaluateIntentConfidence(
                intentConfidence,
                profile,
                callContextState?.clarificationCount ?? this.adapter._clarificationCount ?? 0
            );

            if (gateResult.action === 'clarify') {
                this.adapter._clarificationCount = gateResult.clarificationCount;
                this.adapter.send(this.adapter._buildResponseCreate({
                    instructions: 'Say ONLY these exact words, then stop: "I want to make sure I understand you correctly. Could you rephrase that for me?"',
                    input: []
                }));
                return;
            }

            if (gateResult.action === 'escalate') {
                this.adapter._clarificationCount = gateResult.clarificationCount;
                this.adapter.emit('escalation_needed', {
                    reason: 'intent_confidence_exhausted',
                    clarificationCount: gateResult.clarificationCount
                });
                this.adapter.send(this.adapter._buildResponseCreate({
                    instructions: 'Say ONLY these exact words, then stop: "Let me connect you with someone who can help you better."',
                    input: []
                }));
                return;
            }
        }
```

### Step A3 — Add `_clarificationCount` to BaseRealtimeAdapter constructor

In `adapters/ai/BaseRealtimeAdapter.js`, after L100 (`this._currentToneDirective = null;`), add:

```js
        this._clarificationCount = 0;
```

### Step A4 — Initialize `_lastSanitizedDocs` default

`_lastSanitizedDocs` already exists in the constructor from Wave 1 (set to `null`). No change needed.

**Files modified:**
| File | Lines affected |
|------|---------------|
| `session/conversationEngine.js` | L1-7 (imports), L137-139 (guard rail insert) |
| `adapters/ai/BaseRealtimeAdapter.js` | L100 (add `_clarificationCount`) |

**Modules activated (no changes to these):**
- `rag/ragGuardrails.js` — `applyRagGuardrails()`, `legacyRetrievalToDocs()`
- `rag/retrievalSanitation.js` — `sanitizeDocuments()`
- `logic/intentGate.js` — `evaluateIntentConfidence()`

---

## 3. Phase B — Post-Generation Quality Gate

**Goal:** Score every LLM response for numeric accuracy, synthesis quality, and style compliance. Block or correct bad responses before the caller hears them.

**Depends on:** Phase A (needs `_lastSanitizedDocs` populated).

**Insertion point:** `adapters/ai/BaseRealtimeAdapter.js`, after the hallucination scan passes (L1286) and BEFORE the `responsePhase` / phase-contract-violation check (L1293). The current flow is:

```
L1271: const _hallucinationResult = scanForHallucination(aiText, this._lastRelevantKnowledge);
L1272: if (_hallucinationResult.hallucinated) { ... return; }
...
L1286: // (after hallucination block ends with return)
...
L1293: const responsePhase = this._phaseAtResponseStart || this.conversationPhase;
L1294: const phaseViolation = this._detectPhaseContractViolation(aiText, responsePhase);
```

**What changes:**

### Step B1 — Add imports to `adapters/ai/BaseRealtimeAdapter.js`

After the existing hallucinationGuard import (L22), add:

```js
const { enforceNumerics } = require('../../rag/numericEnforcement');
const { computeSynthesisScore, passesSynthesisGate } = require('../../rag/synthesisScoring');
const { applyPersonaPass } = require('../../persona/styleEngine');
const { PHASE4_ENABLED } = require('../../config/phase4Config');
```

### Step B2 — Insert quality gate after hallucination scan

After the hallucination scan `return;` block (which ends at approximately L1288 — after `this.send(this._buildResponseCreate({})); return;`), and BEFORE `const responsePhase = ...` (L1293), insert:

```js
        // ── Phase 4 Layer 2: Post-generation quality gate ────────
        let processedAiText = aiText;
        if (PHASE4_ENABLED && this._phase4Profile) {
            const profile = this._phase4Profile;
            const docContext = (this._lastSanitizedDocs || [])
                .map(d => d.content).join('\n');

            // B2a: Numeric enforcement
            if (docContext.length > 0) {
                const numResult = enforceNumerics(docContext, aiText, profile);
                if (!numResult.allowed) {
                    log('warn', this.callSID, 'numeric_violation', {
                        penalty: numResult.penalty,
                        snippets: numResult.unsupportedSnippets.slice(0, 3)
                    });
                    const fallback = getHallucinationFallback(this.conversationPhase, this.name, this.persona);
                    this.addConversationContext('AI', fallback);
                    this.send({
                        type: 'session.update',
                        session: this._buildFullSessionConfig(
                            `Say ONLY these exact words, then stop: "${fallback}"`
                        )
                    });
                    this.send(this._buildResponseCreate({}));
                    telemetry.emit('numeric_violation', {
                        callId: this.callSID,
                        penalty: numResult.penalty,
                        ts: Date.now()
                    });
                    return;
                }

                // B2b: Synthesis scoring
                const synthResult = computeSynthesisScore({
                    docs: this._lastSanitizedDocs || [],
                    answer: aiText,
                    docContext,
                    numericPenalty: numResult.penalty
                });

                telemetry.emit('synthesis_score', {
                    callId: this.callSID,
                    score: synthResult.finalScore,
                    grounding: synthResult.grounding,
                    alignment: synthResult.alignment,
                    ts: Date.now()
                });

                if (!passesSynthesisGate(synthResult.finalScore, profile.rag.synthesisThreshold)) {
                    log('warn', this.callSID, 'synthesis_gate_failed', {
                        score: synthResult.finalScore,
                        threshold: profile.rag.synthesisThreshold
                    });
                    const fallback = getHallucinationFallback(this.conversationPhase, this.name, this.persona);
                    this.addConversationContext('AI', fallback);
                    this.send({
                        type: 'session.update',
                        session: this._buildFullSessionConfig(
                            `Say ONLY these exact words, then stop: "${fallback}"`
                        )
                    });
                    this.send(this._buildResponseCreate({}));
                    return;
                }
            }

            // B2c: Persona style pass
            const profileName = profile.name || 'balanced';
            const styleResult = applyPersonaPass(processedAiText, profileName, {
                escalationActive: this._handoverTriggered
            });
            processedAiText = styleResult.text;

            telemetry.emit('persona_pass_applied', {
                callId: this.callSID,
                humorUsed: styleResult.humorUsed,
                numericsUnchanged: styleResult.numericsUnchanged,
                ts: Date.now()
            });
        }
```

### Step B3 — Use `processedAiText` downstream

After the quality gate block, change the `responsePhase` line and all subsequent references to `aiText` in the response-done handler to use `processedAiText` where the text is stored in conversation context. The key change is where `aiText` is added to conversation context (further down in the method). We need to replace the `aiText` reference in `addConversationContext`:

Search for:
```js
        this.addConversationContext('AI', aiText);
```
(appears after the deduplication check, approximately L1336)

Replace with:
```js
        this.addConversationContext('AI', processedAiText);
```

And similarly for `insertConversation`:
```js
        insertConversation(this.callSID, this.recipient, 'assistant', processedAiText)
```

**Files modified:**
| File | Lines affected |
|------|---------------|
| `adapters/ai/BaseRealtimeAdapter.js` | L22 (imports), L1288-L1293 (quality gate insert), L1336 (processedAiText) |

**Modules activated (no changes to these):**
- `rag/numericEnforcement.js` — `enforceNumerics()`
- `rag/synthesisScoring.js` — `computeSynthesisScore()`, `passesSynthesisGate()`
- `persona/styleEngine.js` — `applyPersonaPass()`

---

## 4. Phase C — Turn-Adaptive Intelligence

**Goal:** Dynamically adjust token limits, temperature, and audio presets per turn based on conversation complexity and call type.

**No dependency on A/B — can run in parallel.**

### Sub-Phase C1: Complexity → Dynamic Token/Temperature

#### Step C1.1 — Emit complexity at end of transcript processing

In `adapters/ai/BaseRealtimeAdapter.js`, the `_handleTranscriptCompleted()` method ends with:

```js
        this.emit('user_transcript', userText, { confidence });
        this.insertUpdatedPrompt(effectiveUserText, this._decision);
        if (this._enableSilenceTimers) this.resetSilenceTimers();
    }
```

(approximately L1153-L1155)

Add complexity detection BEFORE the `emit('user_transcript')` call:

```js
        // ── Phase 4 Layer 3: Turn complexity detection ──────────
        const { detectComplexity } = require('../../Helper/complexityDetector');
        const complexityResult = detectComplexity(effectiveUserText);
        this._currentComplexity = complexityResult.isComplex ? 'complex' : 'simple';
        this.emit('turn_complexity', {
            complexity: this._currentComplexity,
            reason: complexityResult.reason,
            userText: effectiveUserText.substring(0, 100)
        });
```

Add `_currentComplexity` to constructor (after `_clarificationCount`):

```js
        this._currentComplexity = 'simple';
```

#### Step C1.2 — Dynamic token/temp in AzureRealtimeAdapter

In `adapters/ai/AzureRealtimeAdapter.js`, `_buildFullSessionConfig()` (L83-L98), the token and temp lines are:

```js
            max_response_output_tokens: Number(process.env.MAX_RESPONSE_OUTPUT_TOKENS) || 400
        };
        if (this._includeTempInSessionConfig) {
            config.temperature = parseFloat(process.env.SLM_TEMPERATURE) || 0.4;
        }
```

Replace with:

```js
            max_response_output_tokens: this._getAdaptiveTokenLimit()
        };
        if (this._includeTempInSessionConfig) {
            config.temperature = this._getAdaptiveTemperature();
        }
```

#### Step C1.3 — Dynamic token/temp in OpenAIRealtimeAdapter

In `adapters/ai/OpenAIRealtimeAdapter.js`, `_buildSessionConfig()` (L66-L67):

```js
            max_response_output_tokens: Number(process.env.MAX_RESPONSE_OUTPUT_TOKENS) || 400,
            temperature: parseFloat(process.env.SLM_TEMPERATURE) || 0.4,
```

Replace with:

```js
            max_response_output_tokens: this._getAdaptiveTokenLimit(),
            temperature: this._getAdaptiveTemperature(),
```

#### Step C1.4 — Add adaptive methods to BaseRealtimeAdapter

Add after the `getVADConfig()` method (after L466):

```js
    _getAdaptiveTokenLimit() {
        const base = Number(process.env.MAX_RESPONSE_OUTPUT_TOKENS) || 400;
        if (!PHASE4_ENABLED) return base;
        if (this._currentComplexity === 'complex') return Math.min(base * 1.5, 600);
        return base;
    }

    _getAdaptiveTemperature() {
        const base = parseFloat(process.env.SLM_TEMPERATURE) || 0.4;
        if (!PHASE4_ENABLED) return base;
        if (this._currentComplexity === 'complex') return Math.min(base + 0.15, 0.85);
        return base;
    }
```

### Sub-Phase C2: Per-Call-Type Audio Presets

#### Step C2.1 — Add `audioPresets` to persona schema

In `personas/_schema.js`, before `module.exports = {};` (L157), add the JSDoc typedef:

```js
/**
 * @typedef {Object} AudioPresetsConfig
 * Optional audio/VAD overrides per persona. All fields optional; omit to use env defaults.
 * @property {number} [silenceCommitMs]   - Override AZURE_VAD_SILENCE_MS
 * @property {string} [vadMode]           - 'server_vad' | 'azure_semantic_vad' | 'none'
 * @property {number} [vadThreshold]      - Override AZURE_VAD_THRESHOLD (0-1)
 * @property {number} [vadSilenceDuration]- Override VAD_SILENCE_DURATION
 * @property {number} [vadPrefixPadding]  - Override VAD_PREFIX_PADDING
 */
```

And add `@property {AudioPresetsConfig} [audioPresets]` to the `PersonaConfig` typedef (inside the existing block near L144).

#### Step C2.2 — Create `_audioConfig` in BaseRealtimeAdapter constructor

In `adapters/ai/BaseRealtimeAdapter.js`, replace the current VAD constructor block (L93-L96):

```js
        // ─── VAD ──────────────────────────────────────────────────────────
        this.vadMode             = this.constructor.resolveVADMode(process.env.AZURE_SERVER_VAD);
        this.silenceCommitTimer  = null;
        this.SILENCE_COMMIT_MS   = parseInt(process.env.AZURE_VAD_SILENCE_MS || '400', 10);
        this.pendingAudioSinceCommit = false;
```

With:

```js
        // ─── VAD / Audio Config ───────────────────────────────────────────
        this.vadMode             = this.constructor.resolveVADMode(process.env.AZURE_SERVER_VAD);
        this.silenceCommitTimer  = null;
        this.SILENCE_COMMIT_MS   = parseInt(process.env.AZURE_VAD_SILENCE_MS || '400', 10);
        this.pendingAudioSinceCommit = false;

        // Unified audio config — persona overrides fall through to env defaults.
        // When STT is later extracted, move this._audioConfig ownership to STT interface.
        this._audioConfig = {
            silenceCommitMs: this.SILENCE_COMMIT_MS,
            vadMode: this.vadMode,
            vadThreshold: null,      // resolved lazily in getVADConfig
            vadSilenceDuration: null, // resolved lazily in getVADConfig
            vadPrefixPadding: null    // resolved lazily in getVADConfig
        };
```

#### Step C2.3 — Apply persona audioPresets after persona is loaded

In `adapters/ai/BaseRealtimeAdapter.js`, inside the `initialize()` method, after the persona is resolved and `this.lang` is set (search for where `this.persona = persona;` and `this.lang = lang;` are assigned — approximately L287-L290), add:

```js
        // Apply persona audio presets (Phase C2)
        if (this.persona?.audioPresets) {
            const ap = this.persona.audioPresets;
            if (ap.silenceCommitMs != null) {
                this.SILENCE_COMMIT_MS = ap.silenceCommitMs;
                this._audioConfig.silenceCommitMs = ap.silenceCommitMs;
            }
            if (ap.vadMode != null) {
                this.vadMode = this.constructor.resolveVADMode(ap.vadMode);
                this._audioConfig.vadMode = this.vadMode;
            }
            if (ap.vadThreshold != null) this._audioConfig.vadThreshold = ap.vadThreshold;
            if (ap.vadSilenceDuration != null) this._audioConfig.vadSilenceDuration = ap.vadSilenceDuration;
            if (ap.vadPrefixPadding != null) this._audioConfig.vadPrefixPadding = ap.vadPrefixPadding;
        }
```

#### Step C2.4 — Update `getVADConfig()` to read from `_audioConfig`

Replace current `getVADConfig()` at L455-L464:

```js
    getVADConfig() {
        if (this.vadMode === 'none') return { type: 'none' };
        const lang = (this._langCode || 'en').toUpperCase();
        const prefixPadding   = Number(process.env[`VAD_PREFIX_PADDING_${lang}`])   || Number(process.env.VAD_PREFIX_PADDING)   || 300;
        const silenceDuration = Number(process.env[`VAD_SILENCE_DURATION_${lang}`]) || Number(process.env.VAD_SILENCE_DURATION) || 600;
        const base = { prefix_padding_ms: prefixPadding, silence_duration_ms: silenceDuration, create_response: false, interrupt_response: true };
        if (this.vadMode === 'azure_semantic_vad') return { type: 'azure_semantic_vad', ...base };
        const threshold = parseFloat(process.env[`VAD_THRESHOLD_${lang}`] || process.env.AZURE_VAD_THRESHOLD || '0.5');
        return { type: 'server_vad', threshold, ...base };
    }
```

With:

```js
    getVADConfig() {
        if (this.vadMode === 'none') return { type: 'none' };
        const lang = (this._langCode || 'en').toUpperCase();
        const prefixPadding   = this._audioConfig?.vadPrefixPadding
            ?? Number(process.env[`VAD_PREFIX_PADDING_${lang}`])
            || Number(process.env.VAD_PREFIX_PADDING) || 300;
        const silenceDuration = this._audioConfig?.vadSilenceDuration
            ?? Number(process.env[`VAD_SILENCE_DURATION_${lang}`])
            || Number(process.env.VAD_SILENCE_DURATION) || 600;
        const base = { prefix_padding_ms: prefixPadding, silence_duration_ms: silenceDuration, create_response: false, interrupt_response: true };
        if (this.vadMode === 'azure_semantic_vad') return { type: 'azure_semantic_vad', ...base };
        const threshold = this._audioConfig?.vadThreshold
            ?? parseFloat(process.env[`VAD_THRESHOLD_${lang}`] || process.env.AZURE_VAD_THRESHOLD || '0.5');
        return { type: 'server_vad', threshold, ...base };
    }
```

**Files modified:**
| File | Lines affected |
|------|---------------|
| `adapters/ai/BaseRealtimeAdapter.js` | Constructor L93-L96, L100 (new fields), ~L287 (persona presets), L455-L464 (getVADConfig), L466+ (adaptive methods), L1153 (complexity emit) |
| `adapters/ai/AzureRealtimeAdapter.js` | L94-L98 (adaptive token/temp) |
| `adapters/ai/OpenAIRealtimeAdapter.js` | L66-L67 (adaptive token/temp) |
| `personas/_schema.js` | L144+L157 (AudioPresetsConfig typedef) |

---

## 5. Phase D — Degradation Signal Enrichment

**Goal:** Populate the `packetLoss` and `isTruncated` fields that `degradationStateEngine` already accepts (see `policy/degradationStateEngine.js:43`) but nobody feeds today.

**No dependencies on A/B/C. 0% rework risk.**

### Step D1 — Add packet tracking to edgeSession

In `session/createCallSession.js`, inside the `edgeSession` object initialization (approximately L147-L190), add new fields:

```js
            // Packet tracking for degradation enrichment (Phase D)
            packetFrameCount: 0,
            packetWindowStart: Date.now(),
            packetLossRatio: 0,
            expectedFrameRate: 50,  // 50 frames/sec at 20ms per frame (8kHz μ-law)
```

### Step D2 — Track packets in media handler

In `session/createCallSession.js`, inside the media message handler (approximately L1470 — the `else if (msg.event === 'media')` block), after the `sessionReady` check passes and before the energy computation, add:

```js
                    // Phase D: Packet frame tracking
                    edgeSession.packetFrameCount++;
                    const elapsed = Date.now() - edgeSession.packetWindowStart;
                    if (elapsed >= 2000) { // 2-second sliding window
                        const expectedFrames = edgeSession.expectedFrameRate * (elapsed / 1000);
                        edgeSession.packetLossRatio = expectedFrames > 0
                            ? Math.max(0, 1 - (edgeSession.packetFrameCount / expectedFrames))
                            : 0;
                        edgeSession.packetFrameCount = 0;
                        edgeSession.packetWindowStart = Date.now();
                    }
```

### Step D3 — Enrich transcript event with degradation signals

In `session/createCallSession.js`, the current transcript event at L741-L742 is:

```js
                const transcriptEvent = { transcript: userText, confidence, timestamp: Date.now() };
                callContextState.degradationEngine.updateDegradationState(transcriptEvent);
```

Replace with:

```js
                const wordCount = userText.split(/\s+/).length;
                const isTruncated = confidence < 0.4 && wordCount < 3;
                const transcriptEvent = {
                    transcript: userText,
                    confidence,
                    timestamp: Date.now(),
                    packetLoss: edgeSession.packetLossRatio || 0,
                    isTruncated
                };
                callContextState.degradationEngine.updateDegradationState(transcriptEvent);

                if (edgeSession.packetLossRatio > 0.15) {
                    telemetry.emit('packet_loss_detected', {
                        connectionId: edgeSession.connectionId,
                        callId: edgeSession.callSID,
                        packetLossRatio: edgeSession.packetLossRatio,
                        ts: Date.now()
                    });
                }
```

**Files modified:**
| File | Lines affected |
|------|---------------|
| `session/createCallSession.js` | L147-L190 (edgeSession fields), L741-L742 (transcript enrichment), ~L1470 (packet tracking) |

---

## 6. Phase E — Internal CX Control Plane API

**Goal:** Expose endpoints for operators to observe CX quality, tune thresholds, and intervene in live calls.

### Step E1 — Create call state registry

The core blocker for Phase E is that `edgeSession` and `callContextState` are local variables inside the `createCallSession` closure — unreachable from outside. We need a queryable registry.

**New file:** `services/CXStateRegistry.js`

```js
'use strict';

/**
 * CX State Registry — per-call CX state accessible from API routes.
 * Entries are created by createCallSession, deleted on ws close.
 * Keyed by callSID.
 */

class CXStateRegistry {
    constructor() {
        this._store = new Map();
    }

    register(callSID, refs) {
        this._store.set(callSID, {
            callSID,
            createdAt: Date.now(),
            ...refs
        });
    }

    get(callSID) {
        return this._store.get(callSID) || null;
    }

    delete(callSID) {
        this._store.delete(callSID);
    }

    getAll() {
        return Array.from(this._store.values());
    }

    getActiveCalls() {
        return this.getAll().map(entry => ({
            callSID: entry.callSID,
            createdAt: entry.createdAt,
            durationMs: Date.now() - entry.createdAt,
            phase: entry.realtimeService?.conversationPhase || 'unknown',
            degradationState: entry.callContextState?.degradationEngine?.getCurrentState?.() || 'NORMAL',
            turnCount: entry.realtimeService?.count || 0,
            persona: entry.realtimeService?.persona?.id || null,
            interactionMode: entry.callContextState?.interactionMode || null
        }));
    }
}

module.exports = new CXStateRegistry();
```

### Step E2 — Wire CXStateRegistry into createCallSession

In `session/createCallSession.js`:

**Add import** (after existing imports, ~L75):
```js
const CXStateRegistry = require('../services/CXStateRegistry');
```

**Register after realtimeService init** (after L1397 `realtimeService._phase4Profile = callContextState.phase4Profile || null;`):
```js
                    CXStateRegistry.register(edgeSession.callSID, {
                        edgeSession,
                        callContextState,
                        realtimeService,
                        streamService
                    });
```

**Delete on ws close** (inside the `ws.on('close', ...)` handler, before `CallRegistry.delete()` at ~L1306):
```js
                CXStateRegistry.delete(edgeSession.callSID);
```

### Step E3 — Create CX API routes

**New file:** `Routes/cxRoutes.js`

```js
'use strict';

const express = require('express');
const Router = express.Router();
const { apiAuth } = require('../middleware/auth');
const CXStateRegistry = require('../services/CXStateRegistry');
const { getPhase4Metrics } = require('../observability/phase4Metrics');
const { PROFILES } = require('../profiles/conversationProfiles');

// ── E1: CX Observability (read-only) ─────────────────────────────────

Router.get('/api/v2/calls/active', apiAuth, (req, res) => {
    res.json({ calls: CXStateRegistry.getActiveCalls() });
});

Router.get('/api/v2/calls/:callId/cx-state', apiAuth, (req, res) => {
    const entry = CXStateRegistry.get(req.params.callId);
    if (!entry) return res.status(404).json({ error: 'Call not found or ended' });

    const rs = entry.realtimeService;
    const ccs = entry.callContextState;

    res.json({
        callSID: entry.callSID,
        durationMs: Date.now() - entry.createdAt,
        conversationPhase: rs?.conversationPhase || 'unknown',
        turnCount: rs?.count || 0,
        degradationState: ccs?.degradationEngine?.getCurrentState?.() || 'NORMAL',
        stabilityMetrics: ccs?.degradationEngine?.getStabilityMetrics?.() || null,
        interactionMode: ccs?.interactionMode || null,
        clarificationCount: ccs?.clarificationCount || 0,
        phase4Profile: ccs?.phase4Profile?.name || null,
        userEmail: rs?.userEmail || null,
        preferredSlot: rs?.preferredSlot || null,
        packetLossRatio: entry.edgeSession?.packetLossRatio || 0,
        complexity: rs?._currentComplexity || 'simple'
    });
});

Router.get('/api/v2/calls/:callId/turns', apiAuth, (req, res) => {
    const entry = CXStateRegistry.get(req.params.callId);
    if (!entry) return res.status(404).json({ error: 'Call not found or ended' });

    const context = entry.realtimeService?.conversationContext || [];
    const turns = context.map((turn, i) => ({
        index: i,
        sender: turn.sender,
        preview: (turn.message || '').substring(0, 200),
        timestamp: turn.timestamp || null
    }));
    res.json({ callSID: entry.callSID, turns });
});

Router.get('/api/v2/cx/metrics', apiAuth, (req, res) => {
    res.json({ metrics: getPhase4Metrics() });
});

// ── E2: CX Configuration ────────────────────────────────────────────

Router.get('/api/v2/profiles', apiAuth, (req, res) => {
    const profiles = Object.entries(PROFILES).map(([name, p]) => ({
        name,
        rag: p.rag,
        intent: p.intent,
        escalation: p.escalation,
        transaction: p.transaction
    }));
    res.json({ profiles });
});

// ── E3: CX Control ──────────────────────────────────────────────────

Router.post('/api/v2/calls/:callId/escalate', apiAuth, (req, res) => {
    const entry = CXStateRegistry.get(req.params.callId);
    if (!entry) return res.status(404).json({ error: 'Call not found or ended' });

    entry.realtimeService?.setHandoverTriggered?.(true);
    entry.edgeSession?.emitSignal?.('signal_handover', {
        reason: 'api_forced_escalation'
    });

    res.json({ status: 'escalation_triggered', callSID: entry.callSID });
});

Router.post('/api/v2/calls/:callId/style-override', apiAuth, (req, res) => {
    const entry = CXStateRegistry.get(req.params.callId);
    if (!entry) return res.status(404).json({ error: 'Call not found or ended' });

    const { directive } = req.body || {};
    if (!directive || typeof directive !== 'string') {
        return res.status(400).json({ error: 'directive string required' });
    }

    entry.realtimeService?.setToneDirective?.(directive);
    res.json({ status: 'style_override_applied', callSID: entry.callSID });
});

module.exports = Router;
```

### Step E4 — Mount CX routes in app.js

In `app.js`, after the existing route mount (`app.useHTTP(Routes);` at ~L302), add:

```js
const CXRoutes = require('./Routes/cxRoutes');
app.useHTTP(CXRoutes);
```

### Step E5 — Register telemetry events

In `Utils/telemetryEvents.js`, add the new events to the declared event set:

```js
// Phase 4 CX events
'numeric_violation',
'synthesis_score',
'persona_pass_applied',
'packet_loss_detected',
```

**New files created:**
| File | Purpose |
|------|---------|
| `services/CXStateRegistry.js` | Per-call CX state registry |
| `Routes/cxRoutes.js` | `/api/v2/` CX endpoints |

**Existing files modified:**
| File | Lines affected |
|------|---------------|
| `session/createCallSession.js` | Imports + L1397 (register) + ws.close (delete) |
| `app.js` | ~L302 (mount CX routes) |
| `Utils/telemetryEvents.js` | Add 4 new event names |

---

## 7. Phase F₁ — call_outcomes Table & Persistence

**Goal:** Persist structured call outcome data at call end so it survives beyond the in-memory session. This is the foundation for future CRM integration.

### Step F1.1 — Create migration

**New file:** `migrations/003_call_outcomes.sql`

```sql
CREATE TABLE IF NOT EXISTS call_outcomes (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    callSID VARCHAR(64) NOT NULL,
    outcome ENUM('booked','rejected','voicemail','transferred','abandoned','completed') DEFAULT 'completed',
    personaId VARCHAR(64),
    phoneNumber VARCHAR(32),
    userEmail VARCHAR(255),
    userPhone VARCHAR(32),
    preferredSlot VARCHAR(255),
    conversationPhase VARCHAR(32),
    turnCount INT DEFAULT 0,
    durationMs INT DEFAULT 0,
    sentimentPrimary VARCHAR(32),
    escalated TINYINT(1) DEFAULT 0,
    synthesisScoreAvg DECIMAL(4,3),
    degradationStateFinal VARCHAR(16) DEFAULT 'NORMAL',
    packetLossAvg DECIMAL(4,3) DEFAULT 0,
    phase4Profile VARCHAR(16),
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_outcome_callSID (callSID),
    INDEX idx_outcome_persona (personaId),
    INDEX idx_outcome_created (createdAt)
);
```

### Step F1.2 — Create OutcomeRepository

**New file:** `repositories/OutcomeRepository.js`

```js
'use strict';

const db = require('../services/db');

/**
 * Persist structured call outcome. Called once at call end via writeQueue.
 * All fields are optional except callSID.
 */
async function createOutcome(data) {
    const sql = `
    INSERT INTO call_outcomes
    (callSID, outcome, personaId, phoneNumber, userEmail, userPhone,
     preferredSlot, conversationPhase, turnCount, durationMs,
     sentimentPrimary, escalated, synthesisScoreAvg,
     degradationStateFinal, packetLossAvg, phase4Profile)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
        outcome = VALUES(outcome),
        userEmail = VALUES(userEmail),
        userPhone = VALUES(userPhone),
        preferredSlot = VALUES(preferredSlot),
        conversationPhase = VALUES(conversationPhase),
        turnCount = VALUES(turnCount),
        durationMs = VALUES(durationMs),
        sentimentPrimary = VALUES(sentimentPrimary),
        escalated = VALUES(escalated),
        synthesisScoreAvg = VALUES(synthesisScoreAvg),
        degradationStateFinal = VALUES(degradationStateFinal),
        packetLossAvg = VALUES(packetLossAvg)
    `;

    return db.query(sql, [
        data.callSID,
        data.outcome || 'completed',
        data.personaId || null,
        data.phoneNumber || null,
        data.userEmail || null,
        data.userPhone || null,
        data.preferredSlot || null,
        data.conversationPhase || null,
        data.turnCount || 0,
        data.durationMs || 0,
        data.sentimentPrimary || null,
        data.escalated ? 1 : 0,
        data.synthesisScoreAvg != null ? data.synthesisScoreAvg : null,
        data.degradationStateFinal || 'NORMAL',
        data.packetLossAvg != null ? data.packetLossAvg : null,
        data.phase4Profile || null
    ]);
}

/**
 * Read outcome by callSID (for future API use).
 */
async function getOutcome(callSID) {
    const rows = await db.query(
        'SELECT * FROM call_outcomes WHERE callSID = ? LIMIT 1',
        [callSID]
    );
    return rows[0] || null;
}

module.exports = { createOutcome, getOutcome };
```

### Step F1.3 — Enqueue outcome persistence at call end

In `session/createCallSession.js`, inside the `ws.on('close', ...)` handler, after the existing `writeQueue.enqueue({ type: 'persist_call', ... })` at ~L1280, add:

```js
                    // Phase F₁: Persist structured call outcome
                    writeQueue.enqueue({
                        type: 'persist_outcome',
                        callSID: edgeSession.callSID,
                        outcome: realtimeService?.hasAskedForConsultation
                            ? (realtimeService?.preferredSlot ? 'booked' : 'completed')
                            : (realtimeService?._handoverTriggered ? 'transferred' : 'completed'),
                        personaId: realtimeService?.persona?.id || null,
                        phoneNumber: callState?.phoneNumber || null,
                        userEmail: realtimeService?.userEmail || null,
                        userPhone: realtimeService?.userPhone || null,
                        preferredSlot: realtimeService?.preferredSlot || null,
                        conversationPhase: realtimeService?.conversationPhase || 'unknown',
                        turnCount: realtimeService?.count || 0,
                        durationMs,
                        sentimentPrimary: null, // enriched in future Phase F
                        escalated: realtimeService?._handoverTriggered || false,
                        synthesisScoreAvg: null, // enriched when Phase B accumulates per-turn scores
                        degradationStateFinal: callContextState.degradationEngine?.getCurrentState?.() || 'NORMAL',
                        packetLossAvg: edgeSession.packetLossRatio || 0,
                        phase4Profile: callContextState.phase4Profile?.name || null
                    });
```

### Step F1.4 — Handle `persist_outcome` in writeQueue worker

In `app.js`, inside the `writeQueue.start(async (job) => { ... })` handler at ~L376-L381, add the new job type:

```js
            } else if (job.type === "persist_outcome") {
                await OutcomeRepository.createOutcome(job);
            }
```

And add the import at the top of app.js (near other repository imports):
```js
const OutcomeRepository = require('./repositories/OutcomeRepository');
```

### Step F1.5 — Run migration

```bash
mysql -u $DB_USER -p$DB_PASSWORD $DB_NAME < migrations/003_call_outcomes.sql
```

**New files created:**
| File | Purpose |
|------|---------|
| `migrations/003_call_outcomes.sql` | Table DDL |
| `repositories/OutcomeRepository.js` | Outcome CRUD |

**Existing files modified:**
| File | Lines affected |
|------|---------------|
| `session/createCallSession.js` | ws.close handler (~L1280) — enqueue persist_outcome |
| `app.js` | Import OutcomeRepository + writeQueue job handler |

---

## 8. Dependency & Parallelism Map

```
Phase A (Pre-Gen Guard)  ─────────┐
         │                         │
         ▼                         │
Phase B (Post-Gen Gate)  ──────────┤
  [blocks on A for                 │
   _lastSanitizedDocs]             │
                                   ├──→  Phase E (CX API)
Phase C (Turn-Adaptive)  ──────────┤     [can start after A/B/C/D
  C1 ∥ C2 parallel                 │      begin emitting data]
  [no dep on A/B]                  │
                                   │
Phase D (Degradation)  ────────────┤
  [no dep on A/B/C]                │
                                   │
Phase F₁ (call_outcomes)  ─────────┘
  [no dep on A/B/C/D/E]
```

**Safe parallel starts:** A + C + D + F₁ simultaneously. B blocks on A. E can start anytime but is most useful after at least one of A-D delivers data.

---

## 9. Verification Matrix

| Phase | Test | Command |
|-------|------|---------|
| A | Existing 299+ Jest tests pass | `npm test` |
| A | Injection patterns stripped from KB docs | New test: PHASE4_ENABLED=true, KB with `<script>` → sanitized |
| A | Intent gate triggers clarification below threshold | New test: intentConfidence=0.2 → `action: 'clarify'` |
| B | Fabricated number triggers correction | New test: aiText has "costs $500" but KB has no price data |
| B | Synthesis gate blocks low-quality response | New test: score below profile.rag.synthesisThreshold |
| B | Persona pass caps sentences | New test: 8-sentence response + profile cap → trimmed |
| C1 | Complex question → token limit 600 | New test: detectComplexity('how does Kubernetes scale') → isComplex=true → `_getAdaptiveTokenLimit()` returns 600 |
| C1 | `turn_complexity` event emitted | New test: verify EventEmitter fires with correct payload |
| C2 | Persona audioPresets override env | New test: persona.audioPresets.vadSilenceDuration=900 → getVADConfig returns 900 |
| D | High packet loss → DEGRADED state | New test: simulate 40% loss → degradation engine transitions |
| D | Truncated transcript detected | New test: confidence=0.3, 2 words → isTruncated=true |
| E | GET /api/v2/calls/active returns list | New test: HTTP GET with apiAuth → 200 + active calls array |
| E | GET /api/v2/calls/:id/cx-state returns CX data | New test: register mock call → GET → verify fields |
| E | POST /api/v2/calls/:id/escalate triggers handover | New test: POST → verify signal_handover emitted |
| F₁ | call_outcomes table created | `SHOW CREATE TABLE call_outcomes;` |
| F₁ | Outcome persisted at call end | New test: simulate ws close → verify OutcomeRepository.createOutcome called |
| ALL | Full regression | `npm test` — all 299+ tests pass |

---

## 10. New Files Created

| File | Phase | Purpose |
|------|-------|---------|
| `services/CXStateRegistry.js` | E | Per-call CX state registry for API access |
| `Routes/cxRoutes.js` | E | `/api/v2/` CX API endpoints |
| `migrations/003_call_outcomes.sql` | F₁ | DDL for call_outcomes table |
| `repositories/OutcomeRepository.js` | F₁ | Outcome persistence CRUD |

---

## 11. Existing Files Modified

| File | Phases | Summary of changes |
|------|--------|--------------------|
| `session/conversationEngine.js` | A | +4 imports, +50 lines guard rail logic between L137-L139 |
| `adapters/ai/BaseRealtimeAdapter.js` | A, B, C | +4 imports, +2 constructor fields, +60 lines quality gate at L1288, +10 lines complexity emit at L1153, +30 lines adaptive methods after L466, +15 lines persona presets in initialize(), getVADConfig rewrite |
| `adapters/ai/AzureRealtimeAdapter.js` | C1 | 2 lines changed in _buildFullSessionConfig (token/temp → adaptive) |
| `adapters/ai/OpenAIRealtimeAdapter.js` | C1 | 2 lines changed in _buildSessionConfig (token/temp → adaptive) |
| `personas/_schema.js` | C2 | +15 lines AudioPresetsConfig typedef |
| `session/createCallSession.js` | D, E, F₁ | +5 edgeSession fields, +15 lines transcript enrichment, +10 lines packet tracking, +1 import CXStateRegistry, +2 lines register/delete, +20 lines persist_outcome |
| `app.js` | E, F₁ | +2 imports, +1 route mount, +3 lines writeQueue handler |
| `Utils/telemetryEvents.js` | E | +4 event names |

---

## Implementation Order (Recommended)

1. **F₁** — Migration + OutcomeRepository (can ship independently, risk-free)
2. **D** — Packet tracking + transcript enrichment (no dependencies, 0% rework risk)
3. **A** — Pre-generation guard rail (activates 3 dormant modules)
4. **C** — Turn-adaptive intelligence (C1 ∥ C2 in parallel)
5. **B** — Post-generation quality gate (depends on A for `_lastSanitizedDocs`)
6. **E** — CX API (most useful after A-D deliver data)

**Total new code:** ~400 lines across 4 new files + ~200 lines of modifications across 8 existing files.

**Feature gate:** Everything behind `PHASE4_ENABLED` — single toggle in `.env` for rollout/rollback. No behavioral change when flag is `false`.
