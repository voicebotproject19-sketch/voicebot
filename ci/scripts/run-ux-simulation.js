#!/usr/bin/env node
/**
 * UX SIMULATION HARNESS
 *
 * Purpose:
 * Validate conversational unlock UX quality across realistic
 * user responses without introducing race conditions.
 *
 * This script verifies:
 *  - Unlock accuracy
 *  - False unlock rate
 *  - Clarification rate
 *  - Multilingual confirmation handling
 *
 * Designed for deterministic CI execution.
 */

process.stdout.write("RUNNING UX SIMULATION HARNESS\n");
process.stdout.write("Initializing UX scenarios...\n");

const {
  computeAmbiguityScore,
  getUnlockDecision
} = require("../../policy/ambiguityScoringEngine");

const {
  createDegradationStateEngine
} = require("../../policy/degradationStateEngine");

function fail(msg) {
  console.error(`❌ UX Simulation Failure: ${msg}`);
  process.exit(1);
}

const degradationEngine = createDegradationStateEngine
  ? createDegradationStateEngine()
  : null;

function simulateScenario(test) {

  const scoreObj = computeAmbiguityScore({
    confidence: test.confidence,
    transcript: test.transcript,
    transcriptTimingMs: test.timing || 800,
    degradationState: test.degradation || 'NORMAL',
    stabilityMetrics: test.stability || { variance: 0.2 },
    energyMetrics: test.energy || {
      energy: 0.6,
      variance: 0.1,
      slope: 0.2
    }
  });

  const decision = getUnlockDecision(
    test.degradation || 'NORMAL',
    scoreObj?.finalScore || 0,
    test.confidence,
    0,
    test.clarifications || 0
  );

  return decision;
}

const scenarios = [

  // Clear confirmations
  { transcript: "yes", confidence: 0.95, expected: "unlock" },
  { transcript: "yes please continue", confidence: 0.92, expected: "unlock" },
  { transcript: "ok go ahead", confidence: 0.90, expected: "unlock" },
  { transcript: "sure continue", confidence: 0.88, expected: "unlock", energy: { energy: 0.7, variance: 0.05, slope: 0.25 } },

  // Neutral / ambiguous
  { transcript: "maybe", confidence: 0.60, expected: "ignore" },
  { transcript: "uh ok", confidence: 0.65, expected: "ignore" },

  // Noise / background
  { transcript: "yeah yeah yeah", confidence: 0.72, expected: "ignore", energy: { energy: 0.3 } },
  { transcript: "yes yes yes", confidence: 0.70, expected: "ignore", energy: { energy: 0.35 } },

  // Multilingual confirmations
  { transcript: "si", confidence: 0.90, expected: "unlock" },
  { transcript: "oui", confidence: 0.90, expected: "unlock" },
  { transcript: "haan", confidence: 0.90, expected: "unlock" },

  // Mixed multilingual confirmations (common in Indian / European speech)
  { transcript: "haan yes", confidence: 0.91, expected: "unlock" },
  { transcript: "yes haan", confidence: 0.90, expected: "unlock" },

  // Background TV style speech
  { transcript: "yes maybe okay", confidence: 0.75, expected: "ignore", stability: { variance: 0.4 } },

  // TV / speaker echo pattern
  {
    transcript: "yes yes yes",
    confidence: 0.82,
    expected: "ignore",
    energy: { energy: 0.6, variance: 0.6, slope: 0.0 }
  },

  // Low confidence
  { transcript: "yes", confidence: 0.55, expected: "ignore" },

  // Interruption style
  { transcript: "wait", confidence: 0.85, expected: "ignore" },

  // Explicit negative
  { transcript: "no", confidence: 0.72, expected: "ignore", energy: { energy: 0.5, variance: 0.2, slope: -0.1 } }
];

let correct = 0;
let unlocks = 0;
let falseUnlocks = 0;
let clarifications = 0;

for (const s of scenarios) {

  const decision = simulateScenario(s);

  if (decision === "unlock") unlocks++;
  if (decision === "clarify") clarifications++;

  if (decision === s.expected) {
    correct++;
  } else {

    if (decision === "unlock" && s.expected !== "unlock") {
      falseUnlocks++;
    }

    console.warn(
      `⚠ UX mismatch: transcript="${s.transcript}" expected=${s.expected} got=${decision}`
    );
  }
}

const accuracy = correct / scenarios.length;
const falseUnlockRate = falseUnlocks / scenarios.length;

process.stdout.write("\n📊 UX Simulation Summary\n");
process.stdout.write(`   Scenarios: ${scenarios.length}\n`);
process.stdout.write(`   Accuracy: ${(accuracy * 100).toFixed(1)}%\n`);
process.stdout.write(`   Unlocks: ${unlocks}\n`);
process.stdout.write(`   Clarifications: ${clarifications}\n`);
process.stdout.write(`   False Unlock Rate: ${(falseUnlockRate * 100).toFixed(1)}%\n`);

/**
 * CI thresholds
 * tuned for voice UX stability
 */

if (accuracy < 0.75) {
  fail("UX accuracy below 75%");
}

if (falseUnlockRate > 0.05) {
  fail("False unlock rate above 5%");
}

process.stdout.write("✔ UX simulation passed.\n");

process.exit(0);