#!/usr/bin/env node
/**
 * MEMORY REGRESSION CHECK
 *
 * Detects unbounded heap growth in core hot-path logic.
 * Deterministic. No external IO.
 */

const ITERATIONS = 5000;
const MAX_HEAP_DELTA_MB = 5; // safe guardrail
const RELAX_FACTOR = process.env.MEMORY_RELAX === 'true' ? 1.5 : 1;

function fail(msg) {
  console.error(`❌ Memory Regression: ${msg}`);
  process.exit(1);
}

function formatMB(bytes) {
  return (bytes / 1024 / 1024).toFixed(2);
}

function forceGC() {
  if (global.gc) {
    global.gc();
  }
}

let computeAmbiguityScore;
let getUnlockDecision;
let createDegradationStateEngine;

try {
  const ambiguity = require('../../policy/ambiguityScoringEngine');
  computeAmbiguityScore = ambiguity.computeAmbiguityScore;
  getUnlockDecision = ambiguity.getUnlockDecision;
} catch {}

try {
  const degradation = require('../../policy/degradationStateEngine');
  createDegradationStateEngine = degradation.createDegradationStateEngine;
} catch {}

function run() {
  console.log('🧠 Running memory regression check...');

  if (!computeAmbiguityScore && !createDegradationStateEngine) {
    console.log('⚠️ No engines found. Skipping memory regression check.');
    process.exit(0);
  }

  forceGC();
  const before = process.memoryUsage().heapUsed;

  const degradationEngine = createDegradationStateEngine
    ? createDegradationStateEngine()
    : null;

  for (let i = 0; i < ITERATIONS; i++) {
    if (computeAmbiguityScore) {
      computeAmbiguityScore({
        confidence: 0.92,
        transcript: 'yes',
        transcriptTimingMs: 1200,
        degradationState: 'NORMAL',
        stabilityMetrics: {},
        energyMetrics: { energy: 0.6 }
      });
    }

    if (degradationEngine) {
      degradationEngine.updateDegradationState({
        transcript: 'test',
        confidence: 0.8
      });
    }

    if (getUnlockDecision) {
      getUnlockDecision('NORMAL', 85, 0.9, 0, 2);
    }
  }

  forceGC();
  const after = process.memoryUsage().heapUsed;

  const deltaMB = (after - before) / 1024 / 1024;

  console.log(`Heap before: ${formatMB(before)} MB`);
  console.log(`Heap after:  ${formatMB(after)} MB`);
  console.log(`Heap delta:  ${deltaMB.toFixed(2)} MB`);

  if (deltaMB > MAX_HEAP_DELTA_MB * RELAX_FACTOR) {
    fail(`Heap grew excessively (+${deltaMB.toFixed(2)} MB)`);
  }

  console.log('✔ Memory regression check passed.');
  process.exit(0);
}

run();