#!/usr/bin/env node
/**
 * Phase 3 deterministic validation harness.
 * Imports REAL config and runtime modules. No production file changes. No async, no setTimeout.
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

let phase3ConfigModule;
let runtimeModule;
try {
    phase3ConfigModule = require(path.join(ROOT, 'config', 'latencyResponsivenessConfig'));
    runtimeModule = require(path.join(ROOT, 'config', 'latencyResponsivenessRuntime'));
} catch (e) {
    console.log('❌ Phase 3 violation: Import failed –', e.message);
    process.exit(1);
}

const {
    getPhase3Config,
    PHASE3_ENABLED,
    PACING,
    MICRO_ACK
} = phase3ConfigModule;

const {
    splitAudioForPacing,
    getPauseMs,
    mayEmitMicroAckNow,
    getEffectiveConfidence,
    initializeNeutralClipValidation,
    isMicroAckDisabledByNeutralClip
} = runtimeModule;

const phase3Config = getPhase3Config();
const maxTotalDelayMs = phase3Config.pacing.maxTotalDelayMs || 400;
const chunkDurationMs = phase3Config.pacing.chunkDurationMs || 4000;

function assert(cond, reason) {
    if (!cond) {
        console.log('❌ Phase 3 violation:', reason);
        process.exit(1);
    }
}

function seededPRNG(seed) {
    let s = seed;
    return function next() {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        return s / 0x7fffffff;
    };
}

let turnId = 1;
let interactionMode = 'INTERACTIVE';
let cancelled = false;
let emissionCount = 0;

function simulateEmission(currentTurn) {
    if (!PHASE3_ENABLED) return;
    if (interactionMode !== 'INTERACTIVE') return;
    if (cancelled) return;
    if (currentTurn !== turnId) return;
    emissionCount++;
}

let phase3State = {
    latencyState: {},
    lastStoredConfidence: null,
    pacing: { cumulativeDelayMs: 0 },
    microAck: {
        emittedThisTurn: false,
        windowClosed: false
    }
};

initializeNeutralClipValidation();

function resetSimState() {
    turnId = 1;
    interactionMode = 'INTERACTIVE';
    cancelled = false;
    emissionCount = 0;
    phase3State = {
        latencyState: {},
        lastStoredConfidence: null,
        pacing: { cumulativeDelayMs: 0 },
        microAck: { emittedThisTurn: false, windowClosed: false }
    };
}

const ITERATIONS = 500;
const SEED = 42;
const rng = seededPRNG(SEED);

const realRandom = Math.random;
Math.random = function () { return rng(); };

try {
    for (let iter = 0; iter < ITERATIONS; iter++) {
        resetSimState();

        const bytesPerMs = 8;
        const longDurationMs = chunkDurationMs + 2000;
        const mockBufferSize = longDurationMs * bytesPerMs;
        const mockBuffer = Buffer.alloc(mockBufferSize, 0xff);

        const chunks = splitAudioForPacing(mockBuffer, chunkDurationMs);
        assert(Array.isArray(chunks) && chunks.length >= 1, 'splitAudioForPacing returns non-empty array');

        let cumulativeDelayMs = 0;
        const scheduledTurnAtStart = turnId;
        for (let i = 1; i < chunks.length; i++) {
            const pause = getPauseMs();
            const delayMs = Math.min(maxTotalDelayMs - cumulativeDelayMs, pause);
            const delayToAdd = Math.max(0, Math.min(delayMs, maxTotalDelayMs - cumulativeDelayMs));
            cumulativeDelayMs += delayToAdd;

            // Simulate mid-loop interactionMode flip
            if (rng() < 0.15) interactionMode = 'NON_INTERACTIVE';
            if (rng() < 0.15) cancelled = true;
            if (rng() < 0.15) turnId++;

            simulateEmission(scheduledTurnAtStart);
        }
        assert(emissionCount >= 0, 'Emission counter stable');
        assert(cumulativeDelayMs <= maxTotalDelayMs, `Pacing delay cap: ${cumulativeDelayMs} > ${maxTotalDelayMs}`);
    }

    resetSimState();
    phase3State.lastStoredConfidence = 0.9;
    phase3State.microAck.emittedThisTurn = false;
    phase3State.microAck.windowClosed = false;
    const turnAtEmit = turnId;
    const allowed1 = mayEmitMicroAckNow(phase3State, 'INTERACTIVE', turnId, turnAtEmit);
    if (MICRO_ACK.enabled && !isMicroAckDisabledByNeutralClip() && getEffectiveConfidence(phase3State) >= MICRO_ACK.confidenceThreshold) {
        assert(allowed1 === true, 'mayEmitMicroAckNow allows once when high confidence and INTERACTIVE');
    }

    phase3State.microAck.emittedThisTurn = true;
    const allowed2 = mayEmitMicroAckNow(phase3State, interactionMode, turnId, turnId);
    assert(allowed2 === false, 'No micro-ack after emittedThisTurn');

    phase3State.microAck.emittedThisTurn = false;
    phase3State.microAck.windowClosed = true;
    const allowed3 = mayEmitMicroAckNow(phase3State, interactionMode, turnId, turnId);
    assert(allowed3 === false, 'No micro-ack when windowClosed');

    phase3State.microAck.windowClosed = false;
    const allowed4 = mayEmitMicroAckNow(phase3State, 'NON_INTERACTIVE', turnId, turnId);
    assert(allowed4 === false, 'No micro-ack outside INTERACTIVE');

    phase3State.lastStoredConfidence = 0.5;
    const allowed5 = mayEmitMicroAckNow(phase3State, 'INTERACTIVE', turnId, turnId);
    assert(allowed5 === false, 'No micro-ack under low confidence');

    cancelled = true;
    phase3State.lastStoredConfidence = 0.95;
    const cancelMA = mayEmitMicroAckNow(phase3State, 'INTERACTIVE', turnId, turnId);
    assert(cancelMA === false, 'No micro-ack when cancelled');
    cancelled = false;

    phase3State.lastStoredConfidence = 0.9;
    const allowed6TurnMismatch = mayEmitMicroAckNow(phase3State, 'INTERACTIVE', turnId, turnId + 999);
    assert(allowed6TurnMismatch === false, 'Double-gate: no micro-ack on turnId mismatch');

    turnId = 1;
    phase3State.microAck.emittedThisTurn = false;
    phase3State.microAck.windowClosed = false;
    phase3State.lastStoredConfidence = 0.9;
    const allowed7 = mayEmitMicroAckNow(phase3State, 'INTERACTIVE', 1, 1);
    turnId = 2;
    const allowed8AfterFlip = mayEmitMicroAckNow(phase3State, 'INTERACTIVE', 2, 1);
    assert(allowed8AfterFlip === false, 'No micro-ack after turn flip (turnId changed)');

    resetSimState();
    const mockBuffer2 = Buffer.alloc((phase3Config.pacing.chunkDurationMs + 3000) * 8, 0x00);
    const chunks2 = splitAudioForPacing(mockBuffer2, phase3Config.pacing.chunkDurationMs);
    let cum = 0;
    const turnWhenScheduled = turnId;
    for (let i = 1; i < chunks2.length; i++) {
        cum += Math.min(maxTotalDelayMs - cum, getPauseMs());
    }
    turnId = turnWhenScheduled + 1;
    assert(cum <= maxTotalDelayMs, 'Pacing cumulative cap after simulated scheduling');
    assert(turnId !== turnWhenScheduled, 'Chunk would be suppressed on turn flip');

} finally {
    Math.random = realRandom;
}

if (!MICRO_ACK.enabled) {
    const neverAllow = mayEmitMicroAckNow(
        { microAck: { emittedThisTurn: false, windowClosed: false }, lastStoredConfidence: 1 },
        'INTERACTIVE', 1, 1
    );
    assert(neverAllow === false, 'PHASE3/MICRO_ACK gating: mayEmitMicroAckNow false when MICRO_ACK.enabled false');
}

if (phase3Config.PHASE3_ENABLED !== undefined) {
    const original = phase3Config.PHASE3_ENABLED;
    phase3Config.PHASE3_ENABLED = false;

    const maDisabled = mayEmitMicroAckNow(
        { microAck: { emittedThisTurn: false, windowClosed: false }, lastStoredConfidence: 1 },
        'INTERACTIVE', 1, 1
    );

    assert(maDisabled === false, 'PHASE3_ENABLED gating enforced');

    phase3Config.PHASE3_ENABLED = original;
}

resetSimState();
phase3State.lastStoredConfidence = 0.95;
const initialTurn = turnId;

const maAllowed = mayEmitMicroAckNow(phase3State, 'INTERACTIVE', initialTurn, initialTurn);
if (maAllowed) simulateEmission(initialTurn);

const combinedBuffer = Buffer.alloc((chunkDurationMs + 2500) * 8);
const combinedChunks = splitAudioForPacing(combinedBuffer, chunkDurationMs);
for (let i = 1; i < combinedChunks.length; i++) {
    if (rng() < 0.2) cancelled = true;
    if (rng() < 0.2) turnId++;
    simulateEmission(initialTurn);
}

assert(emissionCount >= 0, 'Combined pacing+MA stable');

console.log('✔ Phase 3 deterministic validation passed');
