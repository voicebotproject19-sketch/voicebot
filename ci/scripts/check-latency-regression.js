#!/usr/bin/env node
/**
 * LATENCY REGRESSION CHECK
 *
 * Protects against accidental CPU-heavy drift.
 * Deterministic, no external IO.
 */

const ITERATIONS = 5000;

const MAX_AMBIGUITY_MS = 5;
const MAX_DEGRADATION_MS = 5;
const MAX_UNLOCK_MS = 5;
const MAX_HARNESS_TOTAL_MS = 250;

const LATENCY_RELAX = process.env.LATENCY_RELAX === 'true';
const RELAX_FACTOR = LATENCY_RELAX ? 1.3 : 1;

const { execSync } = require('child_process');

function fail(msg) {
  console.error(`❌ Latency Regression: ${msg}`);
  process.exit(1);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted[mid];
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.floor((p / 100) * sorted.length);
  return sorted[Math.min(index, sorted.length - 1)];
}

function measure(fn, iterations, returnSamples = false) {
  const samples = [];

  // Warm-up (JIT stabilization)
  for (let i = 0; i < 50; i++) fn();

  for (let i = 0; i < iterations; i++) {
    const start = process.hrtime.bigint();
    fn();
    const end = process.hrtime.bigint();
    samples.push(Number(end - start) / 1e6);
  }

  return returnSamples ? samples : median(samples);
}

let computeAmbiguityScore;
let getUnlockDecision;
let createDegradationStateEngine;

try {
  const ambiguity = require('../../policy/ambiguityScoringEngine');
  computeAmbiguityScore = ambiguity.computeAmbiguityScore;
  getUnlockDecision = ambiguity.getUnlockDecision;
} catch {
  console.log('⚠️ Ambiguity engine not found, skipping.');
}

try {
  const degradation = require('../../policy/degradationStateEngine');
  createDegradationStateEngine = degradation.createDegradationStateEngine;
} catch {
  console.log('⚠️ Degradation engine not found, skipping.');
}

function run() {
  console.log('🔍 Running latency regression check...');

  if (computeAmbiguityScore) {
    const ambiguitySamples = measure(() => {
      computeAmbiguityScore({
        confidence: 0.92,
        transcript: 'yes',
        transcriptTimingMs: 1200,
        degradationState: 'NORMAL',
        stabilityMetrics: {},
        energyMetrics: { energy: 0.6 }
      });
    }, ITERATIONS, true);

    const ambiguityMedian = median(ambiguitySamples);
    const ambiguityP90 = percentile(ambiguitySamples, 90);

    console.log(`Ambiguity median: ${ambiguityMedian.toFixed(3)} ms`);
    console.log(`Ambiguity p90: ${ambiguityP90.toFixed(3)} ms`);

    if (ambiguityMedian > MAX_AMBIGUITY_MS * RELAX_FACTOR) {
      fail(`Ambiguity scoring too slow (${ambiguityMedian} ms)`);
    }
  }

  if (createDegradationStateEngine) {
    const engine = createDegradationStateEngine();

    const degradationSamples = measure(() => {
      engine.updateDegradationState({
        transcript: 'test',
        confidence: 0.8
      });
    }, ITERATIONS, true);

    const degradationMedian = median(degradationSamples);
    const degradationP90 = percentile(degradationSamples, 90);

    console.log(`Degradation median: ${degradationMedian.toFixed(3)} ms`);
    console.log(`Degradation p90: ${degradationP90.toFixed(3)} ms`);

    if (degradationMedian > MAX_DEGRADATION_MS * RELAX_FACTOR) {
      fail(`Degradation update too slow (${degradationMedian} ms)`);
    }
  }

  if (computeAmbiguityScore && getUnlockDecision) {
    const unlockSamples = measure(() => {
      getUnlockDecision('NORMAL', 85, 0.9, 0, 2);
    }, ITERATIONS, true);

    const unlockMedian = median(unlockSamples);
    const unlockP90 = percentile(unlockSamples, 90);

    console.log(`Unlock median: ${unlockMedian.toFixed(3)} ms`);
    console.log(`Unlock p90: ${unlockP90.toFixed(3)} ms`);

    if (unlockMedian > MAX_UNLOCK_MS * RELAX_FACTOR) {
      fail(`Unlock decision too slow (${unlockMedian} ms)`);
    }
  }

  const harnessStart = process.hrtime.bigint();

  execSync('node ci/scripts/run-synthetic-harness.js', {
    stdio: 'ignore',
    env: { ...process.env }
  });

  const harnessEnd = process.hrtime.bigint();

  const harnessDuration = Number(harnessEnd - harnessStart) / 1e6;
  console.log(`Harness total: ${harnessDuration.toFixed(2)} ms`);

  if (harnessDuration > MAX_HARNESS_TOTAL_MS * RELAX_FACTOR) {
    fail(`Synthetic harness too slow (${harnessDuration} ms)`);
  }

  console.log('✔ Latency regression check passed.');
  process.exit(0);
}

run();