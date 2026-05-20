#!/usr/bin/env node

/**
 * Behavior Drift Validator
 *
 * Ensures core decision engines behave deterministically.
 * CI fails if decisions change from baseline expectations.
 */

const { computeAmbiguityScore, getUnlockDecision } =
    require('../../policy/ambiguityScoringEngine');

const { createDegradationStateEngine } =
    require('../../policy/degradationStateEngine');

const MAX_CLARIFICATIONS = 2;

function validateScoreRange(score, scenario) {
    if (Number.isNaN(score)) {
        fail(`${scenario} produced NaN score`);
    }

    if (score < 0 || score > 100) {
        fail(`${scenario} produced out-of-range score ${score}`);
    }
}

function assertValidDegradationState(state) {
    const allowed = new Set(['NONE','MODERATE','SEVERE','NORMAL','DEGRADED']);
    if (!allowed.has(state)) {
        fail(`Unexpected degradation state "${state}"`);
    }
}

function fail(msg) {
    console.error(`❌ Behavior drift detected: ${msg}`);
    process.exit(1);
}

function pass(msg) {
    console.log(`✔ ${msg}`);
}

function runScenario(name, input, expectedDecision) {
    const { confidence, transcript, degradationState, clarifications } = input;

    const result = computeAmbiguityScore({
        confidence,
        transcript,
        transcriptTimingMs: 0,
        degradationState,
        stabilityMetrics: { stabilityScore: 0.5 },
        energyMetrics: { score: 0.5 }
    });

    validateScoreRange(result.finalScore, name);

    const decision = getUnlockDecision(
        degradationState,
        result.finalScore,
        confidence,
        clarifications,
        MAX_CLARIFICATIONS
    );

    if (decision !== expectedDecision) {
        fail(`${name} → expected "${expectedDecision}" but got "${decision}"`);
    }

    pass(`${name} (${decision})`);
}

console.log('🔍 Running behavior drift validation...\n');

try {

    /**
     * Scenario 1
     * Clear human speech should unlock
     */
    runScenario(
        'High confidence human speech',
        {
            confidence: 0.92,
            transcript: 'yes please continue',
            degradationState: 'NONE',
            clarifications: 0
        },
        'unlock'
    );


    /**
     * Scenario 2
     * Low confidence + non-confirmation transcript → ignore (score below clarify band)
     */
    runScenario(
        'Low confidence transcript',
        {
            confidence: 0.32,
            transcript: 'hello',
            degradationState: 'MODERATE',
            clarifications: 0
        },
        'ignore'
    );


    /**
     * Scenario 3
     * Severe degradation should clarify
     */
    runScenario(
        'Severe degradation environment',
        {
            confidence: 0.55,
            transcript: 'confirm',
            degradationState: 'SEVERE',
            clarifications: 0
        },
        'clarify'
    );


    /**
     * Scenario 4
     * Too many clarifications should ignore
     */
    runScenario(
        'Clarification limit reached',
        {
            confidence: 0.40,
            transcript: 'maybe',
            degradationState: 'MODERATE',
            clarifications: 2
        },
        'ignore'
    );


    /**
     * Scenario 5
     * Mid confidence + phrase confirmation → clarify (score in [45, 65), below unlock 65)
     */
    runScenario(
        'Stable audio mid confidence',
        {
            confidence: 0.75,
            transcript: 'yes go ahead',
            degradationState: 'NONE',
            clarifications: 0
        },
        'clarify'
    );


    /**
     * Scenario 6
     * Unlock boundary low → ignore (score below clarify min 45)
     */
    runScenario(
        'Unlock boundary low',
        {
            confidence: 0.64,
            transcript: 'yes',
            degradationState: 'NONE',
            clarifications: 0
        },
        'ignore'
    );


    /**
     * Scenario 7
     * Unlock boundary high → clarify (score in [45, 65), below unlock 65)
     */
    runScenario(
        'Unlock boundary high',
        {
            confidence: 0.78,
            transcript: 'yes confirm',
            degradationState: 'NONE',
            clarifications: 0
        },
        'clarify'
    );


    /**
     * Scenario 8
     * Timing influence sanity check
     */
    const timingScore = computeAmbiguityScore({
        confidence: 0.7,
        transcript: 'yes',
        transcriptTimingMs: 1800,
        degradationState: 'NONE',
        stabilityMetrics: { stabilityScore: 0.5 },
        energyMetrics: { score: 0.5 }
    });

    validateScoreRange(timingScore.finalScore, 'Timing influence');


    /**
     * Scenario 9
     * Clarification escalation → ignore (score below clarify band)
     */
    runScenario(
        'Clarification escalation',
        {
            confidence: 0.45,
            transcript: 'maybe',
            degradationState: 'MODERATE',
            clarifications: 1
        },
        'ignore'
    );


    /**
     * Degradation engine sanity check
     */
    const engine = createDegradationStateEngine({});

    engine.updateDegradationState({
        transcript: 'background noise',
        confidence: 0.2,
        timestamp: Date.now()
    });

    const state = engine.getCurrentState();

    if (!state) {
        fail('Degradation engine returned invalid state');
    }

    assertValidDegradationState(state);

    pass(`Degradation engine state valid (${state})`);

} catch (err) {
    fail(err.message);
}

console.log('\n✔ Behavior drift check passed.');
process.exit(0);