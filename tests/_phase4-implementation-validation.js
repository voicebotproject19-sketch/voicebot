'use strict';
/**
 * Phase 4 Implementation Validation — validates all changes from the
 * Phase 4 RAG Pipeline Gap Remediation + Model Migration plan.
 */
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function CHECK(label, ok) {
    if (ok) { pass++; console.log('  ✅', label); }
    else    { fail++; console.log('  ❌', label); }
}

// ═══ PHASE 0: Model Migration ═══════════════════════════════════════════
console.log('═══ PHASE 0: Model Migration ═══');

const OA = require(path.join(process.cwd(), 'adapters/ai/OpenAIRealtimeAdapter'));
const oa = new OA({ apiKey: 'test-key' });
CHECK('0A: OpenAIRealtimeAdapter default = gpt-realtime-1.5', oa._openaiModel === 'gpt-realtime-1.5');
CHECK('0A: Not deprecated model', oa._openaiModel !== 'gpt-4o-realtime-preview-2025-06-03');

const mrSrc = fs.readFileSync(path.join(process.cwd(), 'adapters/ai/modelRouter.js'), 'utf8');
CHECK('0A: modelRouter fallback = gpt-realtime-1.5', mrSrc.includes("|| 'gpt-realtime-1.5'"));
CHECK('0A: modelRouter no deprecated model', !mrSrc.includes("'gpt-4o-realtime-preview-2025-06-03'"));

const envSrc = fs.readFileSync(path.join(process.cwd(), '.env.example'), 'utf8');
CHECK('0A: .env.example default = gpt-realtime-1.5', envSrc.includes('OPENAI_REALTIME_MODEL=gpt-realtime-1.5'));
CHECK('0A: .env.example deprecation noted', envSrc.includes('was DEPRECATED'));

// Scan production code for deprecated model
const prodFiles = [
    'adapters/ai/OpenAIRealtimeAdapter.js',
    'adapters/ai/modelRouter.js',
    'session/conversationEngine.js',
    'adapters/ai/BaseRealtimeAdapter.js',
];
let deprecatedInProd = [];
for (const f of prodFiles) {
    const src = fs.readFileSync(path.join(process.cwd(), f), 'utf8');
    if (src.includes("'gpt-4o-realtime-preview-2025-06-03'")) deprecatedInProd.push(f);
}
CHECK('0A: No deprecated model in production code', deprecatedInProd.length === 0);
if (deprecatedInProd.length > 0) console.log('    Found in:', deprecatedInProd.join(', '));

// Docs check
const doc1 = fs.readFileSync(path.join(process.cwd(), 'docs/phase3-provider-abstraction-validation.md'), 'utf8');
CHECK('0C: phase3 doc updated', doc1.includes('gpt-realtime-1.5'));
const doc2 = fs.readFileSync(path.join(process.cwd(), 'docs/realtime-provider-abstraction-plan.md'), 'utf8');
CHECK('0C: realtime plan doc updated', doc2.includes("'gpt-realtime-1.5'"));

// ═══ PHASE A: Data Integrity ════════════════════════════════════════════
console.log('\n═══ PHASE A: Data Integrity ═══');

// A1: Sigmoid normalization — English KB
const KBEn = require(path.join(process.cwd(), 'Knowledge-base/Knowledge-base-english'));
const kb = new KBEn();
const r1 = kb.retrieveRelevantInfo('custom software development cloud solutions', 3);
if (!r1.isGeneralFallback && r1.sections) {
    const scores = r1.sections.map(s => s.relevanceScore);
    CHECK('A1: All EN KB scores in 0–1 range', scores.every(s => s >= 0 && s <= 1));
    CHECK('A1: Scores are meaningful (not all 0)', scores.some(s => s > 0.1));
    CHECK('A1: Raw scores preserved as _rawRelevanceScore', r1.sections.every(s => typeof s._rawRelevanceScore === 'number' && s._rawRelevanceScore > 1));
    console.log('    EN scores:', scores.map(s => s.toFixed(3)).join(', '));
    console.log('    EN raw:', r1.sections.map(s => (s._rawRelevanceScore || 0).toFixed(1)).join(', '));
} else {
    CHECK('A1: KB returned sections (not fallback)', false);
}

// A1: Single result edge case (min-max would NaN here)
const r2 = kb.retrieveRelevantInfo('custom software development cloud solutions', 1);
if (!r2.isGeneralFallback && r2.sections) {
    const singleScore = r2.sections[0].relevanceScore;
    CHECK('A1: Single result is NOT NaN', !isNaN(singleScore));
    CHECK('A1: Single result passes BALANCED threshold (> 0.35)', singleScore > 0.35);
    console.log('    Single result:', singleScore.toFixed(3));
} else {
    CHECK('A1: Single result test (not fallback)', false);
}

// A1: Two similar scores don't get artificially spread
const r3 = kb.retrieveRelevantInfo('software development services', 2);
if (!r3.isGeneralFallback && r3.sections && r3.sections.length === 2) {
    const [s1, s2] = r3.sections.map(s => s.relevanceScore);
    const rawDiff = Math.abs(r3.sections[0]._rawRelevanceScore - r3.sections[1]._rawRelevanceScore);
    const normDiff = Math.abs(s1 - s2);
    // If raw scores are within 5 points, normalized scores should be within 0.2
    if (rawDiff < 5) {
        CHECK('A1: Similar raw scores stay similar after normalization', normDiff < 0.2);
    } else {
        CHECK('A1: Spread preserved for different raw scores', normDiff > 0.02);
    }
    console.log('    Raw diff:', rawDiff.toFixed(1), '→ Norm diff:', normDiff.toFixed(3));
}

// A1: German KB
const KBDe = require(path.join(process.cwd(), 'Knowledge-base/Knowledge-base-german'));
const kbDe = new KBDe();
const rDe = kbDe.retrieveRelevantInfo('Software Entwicklung Cloud', 2);
if (!rDe.isGeneralFallback && rDe.sections) {
    CHECK('A1: DE KB scores in 0–1', rDe.sections.every(s => s.relevanceScore >= 0 && s.relevanceScore <= 1));
    CHECK('A1: DE KB has _rawRelevanceScore', rDe.sections.every(s => typeof s._rawRelevanceScore === 'number'));
    console.log('    DE scores:', rDe.sections.map(s => s.relevanceScore.toFixed(3)).join(', '));
}

// A1: KB_SCORE_SIGMOID_K env tuning
const origK = process.env.KB_SCORE_SIGMOID_K;
process.env.KB_SCORE_SIGMOID_K = '5';
delete require.cache[require.resolve(path.join(process.cwd(), 'Knowledge-base/Knowledge-base-english'))];
const KBEn2 = require(path.join(process.cwd(), 'Knowledge-base/Knowledge-base-english'));
const kb2 = new KBEn2();
const rK5 = kb2.retrieveRelevantInfo('custom software development', 2);
let k5Scores = null;
if (!rK5.isGeneralFallback && rK5.sections) {
    k5Scores = rK5.sections.map(s => s.relevanceScore);
    console.log('    K=5 scores:', k5Scores.map(s => s.toFixed(3)).join(', '));
}
// Reset
if (origK) process.env.KB_SCORE_SIGMOID_K = origK; else delete process.env.KB_SCORE_SIGMOID_K;

// Compare K=5 vs K=10 — K=5 should produce higher normalized scores for same raw
delete require.cache[require.resolve(path.join(process.cwd(), 'Knowledge-base/Knowledge-base-english'))];
const KBEn3 = require(path.join(process.cwd(), 'Knowledge-base/Knowledge-base-english'));
const kb3 = new KBEn3();
const rK10 = kb3.retrieveRelevantInfo('custom software development', 2);
if (!rK10.isGeneralFallback && rK10.sections && k5Scores) {
    const k10Scores = rK10.sections.map(s => s.relevanceScore);
    CHECK('A1: K=5 produces higher normalized scores than K=10', k5Scores[0] > k10Scores[0]);
    console.log('    K=10 scores:', k10Scores.map(s => s.toFixed(3)).join(', '));
}

// A2: Constructor inits
console.log('\n  ── A2: Constructor Inits ──');
const braSrc = fs.readFileSync(path.join(process.cwd(), 'adapters/ai/BaseRealtimeAdapter.js'), 'utf8');
CHECK('A2: _lastKbScoredSections initialized in constructor', braSrc.includes('this._lastKbScoredSections = null;'));
CHECK('A2: _lowSynthesisTurnCount initialized', braSrc.includes('this._lowSynthesisTurnCount = 0;'));
CHECK('A2: _lastSttConfidence initialized', braSrc.includes('this._lastSttConfidence = null;'));
// Verify they're in the Phase 4 profile section
const ctorBlock = braSrc.substring(braSrc.indexOf('// ─── Phase 4 profile'), braSrc.indexOf('// ─── Response timeout'));
CHECK('A2: All 3 fields in Phase 4 constructor block', 
    ctorBlock.includes('_lastKbScoredSections') && 
    ctorBlock.includes('_lowSynthesisTurnCount') &&
    ctorBlock.includes('_lastSttConfidence'));

// A3: Non-Phase4 sanitization
console.log('\n  ── A3: Non-Phase4 Sanitization ──');
const ceSrc = fs.readFileSync(path.join(process.cwd(), 'session/conversationEngine.js'), 'utf8');
CHECK('A3: sanitizeDocument imported from retrievalSanitation', 
    ceSrc.includes("{ sanitizeDocument }") && ceSrc.includes('retrievalSanitation'));
CHECK('A3: Gate: only when Phase4 disabled', ceSrc.includes('!PHASE4_ENABLED && relevantKnowledge'));
CHECK('A3: Calls sanitizeDocument(relevantKnowledge)', ceSrc.includes('sanitizeDocument(relevantKnowledge)'));
CHECK('A3: Handles dropped result', ceSrc.includes('sanitized.dropped'));
// Verify it's OUTSIDE the Phase 4 block (after the catch)
const phase4Catch = ceSrc.indexOf('phase4_layer1_error');
const sanitizeGate = ceSrc.indexOf('!PHASE4_ENABLED && relevantKnowledge');
CHECK('A3: Sanitization is after Phase 4 catch block', sanitizeGate > phase4Catch);

// ═══ PHASE B: Safety Wiring ═════════════════════════════════════════════
console.log('\n═══ PHASE B: Safety Wiring ═══');

const ccsSrc = fs.readFileSync(path.join(process.cwd(), 'session/createCallSession.js'), 'utf8');

// B1: Escalation → handover wiring
console.log('  ── B1: Escalation → Handover ──');
CHECK('B1: escalation_needed listener registered', ccsSrc.includes("realtimeService.on('escalation_needed'"));
CHECK('B1: Sets _handoverTriggered = true', ccsSrc.includes('realtimeService._handoverTriggered = true'));
CHECK('B1: Emits signal_handover (correct signal name)', ccsSrc.includes("edgeSession.emitSignal('signal_handover'"));
CHECK('B1: Telemetry: phase4_escalation', ccsSrc.includes("'phase4_escalation'"));
// Verify the signal payload includes reason
const escBlock = ccsSrc.substring(ccsSrc.indexOf("realtimeService.on('escalation_needed'"), ccsSrc.indexOf("realtimeService.on('clarification_sync'"));
CHECK('B1: Signal payload includes reason', escBlock.includes('reason: data?.reason'));
CHECK('B1: Signal payload includes callSID', escBlock.includes('callSID: edgeSession.callSID'));

// B2: Clarification counter sync
console.log('  ── B2: Clarification Sync ──');
CHECK('B2: clarification_sync emitted after insertUpdatedPrompt', braSrc.includes("this.emit('clarification_sync'"));
CHECK('B2: Emits _clarificationCount value', braSrc.includes("this.emit('clarification_sync', this._clarificationCount)"));
CHECK('B2: Listener in createCallSession', ccsSrc.includes("realtimeService.on('clarification_sync'"));
CHECK('B2: Updates callContextState', ccsSrc.includes('callContextState.clarificationCount = count'));
// Verify emission is AFTER insertUpdatedPrompt, not before
const insertCall = braSrc.indexOf('this.insertUpdatedPrompt(effectiveUserText');
const syncEmit = braSrc.indexOf("this.emit('clarification_sync'");
CHECK('B2: Sync emission is AFTER insertUpdatedPrompt call', syncEmit > insertCall);

// B3: Full escalation state
console.log('  ── B3: Escalation Engine State ──');
CHECK('B3: lowSynthesisTurnCount passed', ccsSrc.includes('lowSynthesisTurnCount: realtimeService._lowSynthesisTurnCount'));
CHECK('B3: maxLowConfidenceTurns from profile', ccsSrc.includes('realtimeService._phase4Profile?.escalation?.maxLowConfidenceTurns'));
CHECK('B3: transactionFailureCount placeholder (0)', ccsSrc.includes('transactionFailureCount: 0'));
CHECK('B3: highRiskDomainDetected placeholder (false)', ccsSrc.includes('highRiskDomainDetected: false'));
// Verify counter tracking in adapter
CHECK('B3: Increments _lowSynthesisTurnCount on gate fail', braSrc.includes('this._lowSynthesisTurnCount = (this._lowSynthesisTurnCount || 0) + 1'));
CHECK('B3: Resets _lowSynthesisTurnCount on gate pass', braSrc.includes('this._lowSynthesisTurnCount = 0'));
// Verify reset is in the right place (before persona pass, after synthesis block)
const resetPos = braSrc.indexOf('this._lowSynthesisTurnCount = 0');
const personaPass = braSrc.indexOf('applyPersonaPass(processedAiText');
CHECK('B3: Counter reset is before persona pass', resetPos < personaPass);

// B4: Transaction policy
console.log('  ── B4: Transaction Policy ──');
CHECK('B4: evaluateTransactionPolicy imported', ceSrc.includes('evaluateTransactionPolicy'));
CHECK('B4: Import from correct module', ceSrc.includes("require('../transactions/transactionPolicy')"));
CHECK('B4: Gate: profile.transaction?.confirmationRequired', ceSrc.includes('profile.transaction?.confirmationRequired'));
CHECK('B4: Gate also requires _isTransactionTurn', ceSrc.includes('this.adapter._isTransactionTurn'));
CHECK('B4: Uses _currentInteractionMode (not hardcoded)', ceSrc.includes('this.adapter._currentInteractionMode'));
CHECK('B4: No hardcoded voice string', !ceSrc.includes("interactionMode: 'voice'"));
CHECK('B4: Checks txResult.allowed', ceSrc.includes('txResult.allowed'));
CHECK('B4: Telemetry on block', ceSrc.includes("'transaction_policy_blocked'"));
// Verify it's inside the Phase 4 block and after intent gate
const intentGatePos = ceSrc.indexOf("gateResult.action === 'proceed'") || ceSrc.indexOf("gateResult.action === 'escalate'");
const txPolicyPos = ceSrc.indexOf('evaluateTransactionPolicy({');
CHECK('B4: Transaction gate is after intent gate', txPolicyPos > intentGatePos);

// B5: Retrieval timeout
console.log('  ── B5: Retrieval Timeout ──');
CHECK('B5: recordRetrievalTimeout imported', ceSrc.includes('recordRetrievalTimeout'));
CHECK('B5: Import added to ragGuardrails destructure', ceSrc.includes('recordRetrievalTimeout } = require'));
CHECK('B5: Uses profile retrievalTimeoutMs', ceSrc.includes('retrievalTimeoutMs'));
CHECK('B5: Calls recordRetrievalTimeout(true) on timeout', ceSrc.includes('recordRetrievalTimeout(true)'));
CHECK('B5: Calls recordRetrievalTimeout(false) on success', ceSrc.includes('recordRetrievalTimeout(false)'));
CHECK('B5: Telemetry: kb_retrieval_timeout', ceSrc.includes("'kb_retrieval_timeout'"));

// ═══ PHASE C: Quality Hardening ═════════════════════════════════════════
console.log('\n═══ PHASE C: Quality Hardening ═══');

// C1: STT confidence threading
console.log('  ── C1: STT Confidence ──');
CHECK('C1: _lastSttConfidence stored on transcription', braSrc.includes('this._lastSttConfidence = confidence'));
// Verify it's in _handleTranscription, near the confidence extraction
const confExtract = braSrc.indexOf("typeof message.confidence === 'number'");
const confStore = braSrc.indexOf('this._lastSttConfidence = confidence');
CHECK('C1: Storage is after confidence extraction', confStore > confExtract && confStore - confExtract < 500);
CHECK('C1: Blended into intent gate', ceSrc.includes('this.adapter._lastSttConfidence'));
CHECK('C1: Math.min(sttConf, 0.8) caps STT influence', ceSrc.includes('Math.min(sttConf, 0.8)'));
CHECK('C1: Fallback to 1.0 when no STT', ceSrc.includes('_lastSttConfidence ?? 1.0'));
// Verify backward compat: first turn = 0.9, zeroDocs = 0.3
CHECK('C1: First turn still 0.9', ceSrc.includes('count <= 1') && ceSrc.includes('0.9'));
CHECK('C1: zeroDocs maps to 0.5', ceSrc.includes('zeroDocs ? 0.5'));
CHECK('C1: simple intents get 0.95', ceSrc.includes('simpleIntent') && ceSrc.includes('? 0.95'));

// C2: Numeric revert after persona pass
console.log('  ── C2: Numeric Revert ──');
CHECK('C2: prePersonaText saved before persona pass', braSrc.includes('const prePersonaText = processedAiText'));
CHECK('C2: Checks numericsUnchanged flag', braSrc.includes('styleResult.numericsUnchanged'));
CHECK('C2: Reverts to prePersonaText on numeric change', braSrc.includes('processedAiText = prePersonaText'));
// Verify ordering: save → persona → check → revert
const savePos = braSrc.indexOf('const prePersonaText = processedAiText');
const personaCallPos = braSrc.indexOf('applyPersonaPass(processedAiText');
const revertPos = braSrc.indexOf('processedAiText = prePersonaText');
CHECK('C2: Correct ordering: save → persona → revert', savePos < personaCallPos && personaCallPos < revertPos);

// C3: No-doc numeric telemetry
console.log('  ── C3: No-Doc Numeric Telemetry ──');
CHECK('C3: extractNumerics imported', braSrc.includes('extractNumerics'));
CHECK('C3: Import from numericEnforcement', braSrc.includes("{ enforceNumerics, extractNumerics }"));
CHECK('C3: Called when docContext empty', braSrc.includes('extractNumerics(processedAiText)'));
CHECK('C3: Telemetry: numeric_without_grounding', braSrc.includes("'numeric_without_grounding'"));
// Verify it's in the else branch (no docs)
const noDocCheck = braSrc.indexOf('extractNumerics(processedAiText)');
const docLenCheck = braSrc.lastIndexOf('docContext.length > 0', noDocCheck);
CHECK('C3: In else branch of docContext check', noDocCheck > docLenCheck);

// ═══ CROSS-CUTTING ══════════════════════════════════════════════════════
console.log('\n═══ CROSS-CUTTING CHECKS ═══');

// Verify no accidental imports of non-existent functions
CHECK('Cross: No reference to sanitizeRetrievedContent (does not exist)', !ceSrc.includes('sanitizeRetrievedContent'));
CHECK('Cross: Uses correct signal name signal_handover', !ccsSrc.includes("emitSignal('handover')") || ccsSrc.includes("emitSignal('signal_handover'"));

// Verify Phase 4 kill switch still works — all Phase 4 code gated
const phase4Gates = (ceSrc.match(/PHASE4_ENABLED/g) || []).length;
CHECK('Cross: PHASE4_ENABLED referenced in conversationEngine', phase4Gates >= 2);
const braPhase4Gates = (braSrc.match(/PHASE4_ENABLED/g) || []).length;
CHECK('Cross: PHASE4_ENABLED referenced in BaseRealtimeAdapter', braPhase4Gates >= 1);

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══════════════════════════════════════════');
console.log(`  TOTAL: ${pass} PASS / ${fail} FAIL`);
console.log('═══════════════════════════════════════════');
if (fail > 0) process.exit(1);
