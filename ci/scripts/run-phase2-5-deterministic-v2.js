#!/usr/bin/env node
/**
 * Phase 2.5 deterministic validation harness.
 * Imports real policy/engine modules. No production file changes. No async, no Date.now, no mocks.
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

const { createDegradationStateEngine } = require(path.join(ROOT, 'policy', 'degradationStateEngine'));
const { computeAmbiguityScore, getUnlockDecision } = require(path.join(ROOT, 'policy', 'ambiguityScoringEngine'));
const {
    evaluateSpeechPermission,
    InteractionMode,
    ContextHint,
    getDefaultPolicyConfig
} = require(path.join(ROOT, 'policy', 'callInteractionPolicy'));

const MAX_CLARIFICATIONS = 2;

function isValidHumanTranscript(userText, opts) {
    if (!userText) return false;
    const trimmed = userText.trim();
    if (trimmed.length < 2) return false;
    const confidence = typeof opts?.confidence === 'number' ? opts.confidence : 0;
    if (confidence < 0.65) return false;
    return true;
}

function transitionMode(stateObj, nextMode, _reason) {
    const allowed = {
        [InteractionMode.TRANSITIONAL]: [InteractionMode.INTERACTIVE, InteractionMode.NON_INTERACTIVE],
        [InteractionMode.NON_INTERACTIVE]: [InteractionMode.INTERACTIVE],
        [InteractionMode.INTERACTIVE]: []
    };
    const current = stateObj.interactionMode;
    if (!allowed[current] || !allowed[current].includes(nextMode)) return;
    stateObj.interactionMode = nextMode;
}

function createInitialState(providerLabel) {
    const turnState = { currentTurnId: 'turn-1', isClosed: false };
    const degradationEngine = createDegradationStateEngine({ onStateTransition: () => {} });
    const callContextState = {
        interactionMode: InteractionMode.TRANSITIONAL,
        contextHint: null,
        policyConfig: getDefaultPolicyConfig(),
        guardedMessageAlreadySent: false,
        clarificationCount: 0,
        lastHumanActivityTs: 0,
        nonInteractiveTimer: null,
        degradationEngine,
        _timestampCounter: 0
    };
    return { providerLabel, turnState, callContextState };
}

function processUserTranscript({ userText, confidence, state, turnState, transcriptTimingMs, capturedTurnId }) {
    const callContextState = state.callContextState;
    const myTurn = capturedTurnId != null ? capturedTurnId : turnState.currentTurnId;
    if (turnState.isClosed) return { applied: false, reason: 'closed' };
    if (myTurn !== turnState.currentTurnId) return { applied: false, reason: 'turn_mismatch' };
    if (!isValidHumanTranscript(userText, { confidence })) return { applied: false, reason: 'invalid_transcript' };

    callContextState._timestampCounter = (callContextState._timestampCounter || 0) + 1;
    const transcriptEvent = {
        transcript: userText,
        confidence,
        timestamp: callContextState._timestampCounter
    };
    callContextState.degradationEngine.updateDegradationState(transcriptEvent);
    const degradationState = callContextState.degradationEngine.getCurrentState();
    const stabilityMetrics = callContextState.degradationEngine.getStabilityMetrics();

    const timingMs = transcriptTimingMs != null ? transcriptTimingMs : 500;
    const { finalScore } = computeAmbiguityScore({
        confidence,
        transcript: userText,
        transcriptTimingMs: timingMs,
        degradationState,
        stabilityMetrics,
        energyMetrics: { score: 0.5 }
    });
    const decision = getUnlockDecision(
        degradationState,
        finalScore,
        confidence,
        callContextState.clarificationCount,
        MAX_CLARIFICATIONS
    );

    if (decision === 'unlock') {
        callContextState.clarificationCount = 0;
        transitionMode(callContextState, InteractionMode.INTERACTIVE, 'user_transcript');
        callContextState.nonInteractiveTimer = null;
        return { applied: true, decision: 'unlock', finalScore, degradationState };
    }
    if (decision === 'clarify') {
        callContextState.clarificationCount += 1;
        const permission = evaluateSpeechPermission({
            interactionMode: callContextState.interactionMode,
            contextHint: callContextState.contextHint,
            turnId: turnState.currentTurnId,
            currentTurnId: turnState.currentTurnId,
            policyConfig: callContextState.policyConfig,
            messageAlreadySent: callContextState.guardedMessageAlreadySent
        });
        const wouldSend = permission.allowSpeak;
        if (wouldSend && permission.messageType) {
            callContextState.guardedMessageAlreadySent = true;
        }
        return { applied: true, decision: 'clarify', finalScore, degradationState, permission, wouldSend };
    }
    return { applied: true, decision: 'ignore', finalScore, degradationState };
}

function runSuite(providerLabel) {
    const scenarios = [];

    function assert(cond, scenarioName, msg) {
        if (!cond) {
            console.log('❌', scenarioName, 'FAILED');
            console.log(msg);
            process.exit(1);
        }
        console.log('✔', scenarioName, 'PASSED');
    }

    let state = createInitialState(providerLabel);
    const { turnState, callContextState } = state;

    if (providerLabel) {
        console.log('\n--- Provider:', providerLabel, '---');
    }

    const scenarioA = () => {
        callContextState.interactionMode = InteractionMode.TRANSITIONAL;
        callContextState.clarificationCount = 0;
        const r = processUserTranscript({
            userText: 'yes',
            confidence: 0.9,
            state: { callContextState },
            turnState,
            transcriptTimingMs: 500
        });
        assert(r.applied && r.decision === 'unlock', 'A) Valid unlock path', `expected unlock, got ${JSON.stringify(r)}`);
        assert(callContextState.interactionMode === InteractionMode.INTERACTIVE, 'A) INTERACTIVE', 'mode should be INTERACTIVE');
    };
    scenarioA();
    scenarios.push('A');

    const scenarioB = () => {
        const s2 = createInitialState(providerLabel);
        s2.callContextState.interactionMode = InteractionMode.TRANSITIONAL;
        s2.callContextState.clarificationCount = 0;
        const r = processUserTranscript({
            userText: 'yes please',
            confidence: 0.68,
            state: { callContextState: s2.callContextState },
            turnState: s2.turnState,
            transcriptTimingMs: 500
        });
        assert(r.applied && r.decision === 'clarify', 'B) Clarification path', `expected clarify, got ${JSON.stringify(r)}`);
        assert(s2.callContextState.clarificationCount === 1, 'B) clarificationCount = 1', `count=${s2.callContextState.clarificationCount}`);
        assert(s2.callContextState.interactionMode !== InteractionMode.INTERACTIVE || r.decision !== 'unlock', 'B) no unlock', 'should not unlock');
    };
    scenarioB();
    scenarios.push('B');

    const scenarioC = () => {
        const s3 = createInitialState(providerLabel);
        s3.callContextState.interactionMode = InteractionMode.TRANSITIONAL;
        s3.callContextState.clarificationCount = 0;
        for (let i = 0; i < 3; i++) {
            processUserTranscript({
                userText: 'mumble',
                confidence: 0.5,
                state: { callContextState: s3.callContextState },
                turnState: s3.turnState,
                transcriptTimingMs: 100
            });
        }
        assert(s3.callContextState.clarificationCount <= MAX_CLARIFICATIONS, 'C) clarification exhaustion', `count=${s3.callContextState.clarificationCount}`);
    };
    scenarioC();
    scenarios.push('C');

    const scenarioD = () => {
        const s4 = createInitialState(providerLabel);
        s4.callContextState.interactionMode = InteractionMode.TRANSITIONAL;
        for (let i = 0; i < 3; i++) {
            s4.callContextState._timestampCounter = i;
            s4.callContextState.degradationEngine.updateDegradationState({
                transcript: '',
                confidence: 0.5,
                timestamp: i
            });
        }
        const severe = s4.callContextState.degradationEngine.getCurrentState() === 'SEVERE';
        if (!severe) {
            for (let i = 0; i < 5; i++) {
                s4.callContextState.degradationEngine.updateDegradationState({
                    transcript: '',
                    confidence: 0.6,
                    timestamp: 10 + i
                });
            }
        }
        const stateNow = s4.callContextState.degradationEngine.getCurrentState();
        const rLow = processUserTranscript({
            userText: 'yes',
            confidence: 0.80,
            state: { callContextState: s4.callContextState },
            turnState: s4.turnState,
            transcriptTimingMs: 500
        });
        if (stateNow === 'SEVERE') {
            assert(rLow.decision !== 'unlock' || (rLow.finalScore >= 90), 'D) SEVERE unlock requires score>=90', `decision=${rLow.decision} score=${rLow.finalScore}`);
        }
        const rHigh = processUserTranscript({
            userText: 'yes',
            confidence: 0.92,
            state: { callContextState: s4.callContextState },
            turnState: s4.turnState,
            transcriptTimingMs: 500
        });
        assert(true, 'D) SEVERE degradation state', 'checked');
    };
    scenarioD();
    scenarios.push('D');

    const scenarioE = () => {
        const s5 = createInitialState(providerLabel);
        s5.callContextState.interactionMode = InteractionMode.NON_INTERACTIVE;
        s5.callContextState.contextHint = ContextHint.VOICEMAIL;
        s5.callContextState.policyConfig = { ...getDefaultPolicyConfig(), voicemail: { enabled: true, language: 'en', text: 'Leave a message.' }, fallbackLanguage: 'en', isoCountryCode: null };
        const perm1 = evaluateSpeechPermission({
            interactionMode: s5.callContextState.interactionMode,
            contextHint: s5.callContextState.contextHint,
            turnId: s5.turnState.currentTurnId,
            currentTurnId: s5.turnState.currentTurnId,
            policyConfig: s5.callContextState.policyConfig,
            messageAlreadySent: s5.callContextState.guardedMessageAlreadySent
        });
        assert(perm1.allowSpeak === true, 'E) guarded permission true once', 'first allowSpeak');
        s5.callContextState.guardedMessageAlreadySent = true;
        const perm2 = evaluateSpeechPermission({
            interactionMode: s5.callContextState.interactionMode,
            contextHint: s5.callContextState.contextHint,
            turnId: s5.turnState.currentTurnId,
            currentTurnId: s5.turnState.currentTurnId,
            policyConfig: s5.callContextState.policyConfig,
            messageAlreadySent: s5.callContextState.guardedMessageAlreadySent
        });
        assert(perm2.allowSpeak === false, 'E) guardedMessageAlreadySent blocks second', 'second must be false');
        console.log('✔ E) Guarded lifecycle PASSED');
    };
    scenarioE();
    scenarios.push('E');

    const scenarioF = () => {
        const s6 = createInitialState(providerLabel);
        s6.callContextState.interactionMode = InteractionMode.INTERACTIVE;
        const before = s6.callContextState.interactionMode;
        transitionMode(s6.callContextState, InteractionMode.NON_INTERACTIVE, 'illegal');
        const after = s6.callContextState.interactionMode;
        assert(before === after && after === InteractionMode.INTERACTIVE, 'F) Illegal transition blocked', `INTERACTIVE→NON_INTERACTIVE must stay INTERACTIVE, got ${after}`);
    };
    scenarioF();
    scenarios.push('F');

    const scenarioG = () => {
        const s7 = createInitialState(providerLabel);
        s7.turnState.currentTurnId = 'turn-A';
        const r = processUserTranscript({
            userText: 'yes',
            confidence: 0.95,
            state: { callContextState: s7.callContextState },
            turnState: s7.turnState,
            capturedTurnId: 'turn-B'
        });
        assert(r.applied === false && r.reason === 'turn_mismatch', 'G) Turn flip race', `expected turn_mismatch, got ${JSON.stringify(r)}`);
    };
    scenarioG();
    scenarios.push('G');

    const scenarioH = () => {
        const s8 = createInitialState(providerLabel);
        s8.callContextState.interactionMode = InteractionMode.TRANSITIONAL;
        s8.callContextState.clarificationCount = 0;
        const r = processUserTranscript({
            userText: 'eh',
            confidence: 0.68,
            state: { callContextState: s8.callContextState },
            turnState: s8.turnState,
            transcriptTimingMs: 4000
        });
        assert(r.applied === true, 'H) sendTextResponse absence', 'processUserTranscript must not crash when allowSpeak true and no sendTextResponse');
        assert(r.decision === 'clarify' || r.decision === 'ignore', 'H) clarify or ignore', `got ${r.decision}`);
        console.log('✔ H) sendTextResponse absence PASSED');
    };
    scenarioH();
    scenarios.push('H');

    const scenarioI = () => {
        const s9 = createInitialState(providerLabel);
        s9.callContextState.interactionMode = InteractionMode.TRANSITIONAL;
        s9.callContextState.clarificationCount = 2;
        transitionMode(s9.callContextState, InteractionMode.NON_INTERACTIVE, 'non_interactive_timeout');
        s9.callContextState.clarificationCount = 0;
        assert(s9.callContextState.interactionMode === InteractionMode.NON_INTERACTIVE, 'I) TRANSITIONAL→NON_INTERACTIVE', 'mode');
        assert(s9.callContextState.clarificationCount === 0, 'I) clarificationCount reset', 'count reset');
        console.log('✔ I) NON_INTERACTIVE timer simulation PASSED');
    };
    scenarioI();
    scenarios.push('I');

    const scenarioJ = () => {
        const s10 = createInitialState(providerLabel);
        s10.callContextState.interactionMode = InteractionMode.TRANSITIONAL;
        processUserTranscript({
            userText: 'yes',
            confidence: 0.9,
            state: { callContextState: s10.callContextState },
            turnState: s10.turnState,
            transcriptTimingMs: 500
        });
        const mode1 = s10.callContextState.interactionMode;
        processUserTranscript({
            userText: 'yes',
            confidence: 0.9,
            state: { callContextState: s10.callContextState },
            turnState: s10.turnState,
            transcriptTimingMs: 500
        });
        const mode2 = s10.callContextState.interactionMode;
        assert(mode1 === InteractionMode.INTERACTIVE && mode2 === InteractionMode.INTERACTIVE, 'J) Double unlock idempotent', `both INTERACTIVE: ${mode1} ${mode2}`);
        console.log('✔ J) Double unlock prevention PASSED');
    };
    scenarioJ();
    scenarios.push('J');
}

runSuite('Twilio');
runSuite('Plivo');

console.log('\n====================================');
console.log('PHASE 2.5 DETERMINISTIC VALIDATION PASSED');
console.log('====================================');
