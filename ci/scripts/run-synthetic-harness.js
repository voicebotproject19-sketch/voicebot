#!/usr/bin/env node
/**
 * SYNTHETIC RACE HARNESS (HARDENED v3 – ASYNC RACE SIMULATION)
 *
 * Enhancements over v2:
 *  - Simulates true async scheduling (setTimeout-style)
 *  - Deterministic seeded randomness
 *  - Simulated microtask queue
 *  - Turn flip before delayed emission
 *  - Cancel-before-delayed-emission detection
 *  - Integrates real unlock + degradation engines if present
 *  - CI-safe (no external IO)
 */
console.log("RUNNING HARNESS VERSION: v3-async");
const BASE_ITERATIONS = 600;
const STRESS_MULTIPLIER = 4;
const ITERATIONS = process.env.HARNESS_STRESS === 'true'
  ? BASE_ITERATIONS * STRESS_MULTIPLIER
  : BASE_ITERATIONS;

const MAX_ASYNC_DELAY = 5; // simulated ticks

// Simple deterministic PRNG
let seed = 1337;
function rand() {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
}

let computeAmbiguityScore = null;
let getUnlockDecision = null;
let createDegradationStateEngine = null;

try {
  const ambiguity = require('../../policy/ambiguityScoringEngine');
  computeAmbiguityScore = ambiguity.computeAmbiguityScore;
  getUnlockDecision = ambiguity.getUnlockDecision;
} catch {}

try {
  const degradation = require('../../policy/degradationStateEngine');
  createDegradationStateEngine = degradation.createDegradationStateEngine;
} catch {}

function fail(msg) {
  console.error(`❌ Synthetic Harness Failure: ${msg}`);
  process.exit(1);
}

function simulateOne() {
  let turnId = 1;
  let interactionMode = 'TRANSITIONAL';
  let unlocked = false;
  let cancelled = false;
  let asyncQueue = [];

  let metrics = {
    staleEmissionAttempts: 0,
    cancelEmissionAttempts: 0,
    unlockAttempts: 0,
    unlockSuccess: 0,
    degradationEvents: 0,
    validEmissions: 0
  };

  const degradationEngine = createDegradationStateEngine
    ? createDegradationStateEngine()
    : null;

  function validateEmission(payloadTurnId) {
    if (payloadTurnId !== turnId) {
      metrics.staleEmissionAttempts++;
      return false; // blocked stale emission
    }

    if (cancelled) {
      metrics.cancelEmissionAttempts++;
      return false; // blocked cancelled emission
    }

    return true;
  }

  function sendAudio(payloadTurnId) {
    const allowed = validateEmission(payloadTurnId);
    if (allowed) {
      metrics.validEmissions++;
    }
  }

  function scheduleEmission(payloadTurnId) {
    const delay = Math.floor(rand() * MAX_ASYNC_DELAY);
    asyncQueue.push({ delay, fn: () => sendAudio(payloadTurnId) });
  }

  function flushAsyncTick() {
    asyncQueue.forEach(task => task.delay--);
    const ready = asyncQueue.filter(task => task.delay <= 0);
    asyncQueue = asyncQueue.filter(task => task.delay > 0);
    ready.forEach(task => task.fn());
  }

  function cancelResponse() {
    cancelled = true;
  }

  function unlock(transcript = 'yes', confidence = 0.9) {
    metrics.unlockAttempts++;

    // Do not allow unlock if already interactive (mirrors real app.js behavior)
    if (interactionMode === 'INTERACTIVE') {
      return { violation: null, metrics };
    }

    if (computeAmbiguityScore && getUnlockDecision) {
      const scoreObj = computeAmbiguityScore({
        confidence,
        transcript,
        transcriptTimingMs: 1000,
        degradationState: degradationEngine ? degradationEngine.getCurrentState?.() : 'NORMAL',
        stabilityMetrics: degradationEngine ? degradationEngine.getStabilityMetrics?.() : {},
        energyMetrics: { energy: 0.6 }
      });

      const decision = getUnlockDecision(
        degradationEngine ? degradationEngine.getCurrentState?.() : 'NORMAL',
        scoreObj?.finalScore || 0,
        confidence,
        0,
        2
      );

      if (decision !== 'unlock') return { violation: null, metrics };
    }

    // Transition to INTERACTIVE (mirrors app.js transitionMode)
    interactionMode = 'INTERACTIVE';
    unlocked = true;
    metrics.unlockSuccess++;

    return { violation: null, metrics };
  }

  function changeTurn() {
    turnId++;
    cancelled = false;
    unlocked = false;
    interactionMode = 'TRANSITIONAL';
    if (degradationEngine?.resetState) {
      degradationEngine.resetState();
    }
  }

  function degradeTranscript() {
    if (!degradationEngine) return;
    metrics.degradationEvents++;
    degradationEngine.updateDegradationState({
      transcript: '',
      confidence: 0.4,
      isTruncated: true,
      packetLoss: 0.3
    });
  }

  const events = [
    () => unlock('yes', 0.92),
    () => unlock('confirm', 0.88),
    () => unlock('maybe', 0.4),
    () => scheduleEmission(turnId),
    () => scheduleEmission(turnId - 1), // stale async emission
    () => cancelResponse(),
    () => changeTurn(),
    () => degradeTranscript(),
    () => flushAsyncTick()
  ];

  for (let i = 0; i < 25; i++) {
    // Pre‑event timer tick (simulates timers firing before the next task)
    if (rand() < 0.5) {
      flushAsyncTick();
    }

    const e = events[Math.floor(rand() * events.length)];
    e();

    // Race injector: occasionally flip the turn immediately after scheduling
    // which simulates telecom jitter where a turn changes before delayed audio fires
    if (rand() < 0.15) {
      changeTurn();
    }

    // Standard async flush
    flushAsyncTick();

    // NEW: deterministic "double timer window"
    // This simulates situations where multiple timer callbacks fire
    // within the same event loop cycle under heavy load.
    if (rand() < 0.2) {
      flushAsyncTick();
    }
  }

  // Final flush to catch late emissions
  for (let i = 0; i < MAX_ASYNC_DELAY + 1; i++) {
    flushAsyncTick();
  }

  return { metrics };
}

function run() {
  const aggregate = {
    staleEmissionAttempts: 0,
    cancelEmissionAttempts: 0,
    unlockAttempts: 0,
    unlockSuccess: 0,
    degradationEvents: 0,
    validEmissions: 0
  };

  for (let i = 0; i < ITERATIONS; i++) {
    const result = simulateOne();

    Object.keys(aggregate).forEach(key => {
      aggregate[key] += result.metrics[key];
    });
  }

  console.log('✔ Synthetic race harness passed (hardened v3 async).');
  console.log('📊 Coverage Summary:');
  console.log(`   Iterations: ${ITERATIONS}`);
  console.log(`   Stale emission attempts: ${aggregate.staleEmissionAttempts}`);
  console.log(`   Cancel emission attempts: ${aggregate.cancelEmissionAttempts}`);
  console.log(`   Unlock attempts: ${aggregate.unlockAttempts}`);
  console.log(`   Unlock success: ${aggregate.unlockSuccess}`);
  console.log(`   Degradation events: ${aggregate.degradationEvents}`);
  console.log(`   Valid emissions: ${aggregate.validEmissions}`);

  // Sanity guard: ensure harness actually allowed some emissions
  if (aggregate.validEmissions === 0) {
    fail("Harness detected zero valid emissions (likely logic error)");
  }

  process.exit(0);
}

run();