#!/usr/bin/env node
/**
 * POLICY FUZZ VALIDATOR
 *
 * Deterministically stress-tests the ambiguity scoring engine and
 * unlock policy contract. Designed to catch edge cases that scenario
 * tests miss.
 *
 * Properties verified:
 * 1. Negative replies never unlock
 *  * 2. High-confidence confirmations should not be ignored
 * 3. Background noise rarely unlocks
 * 4. Engine output always stays within score bounds
 *
 * This script is intentionally deterministic so CI results are stable.
 */

const {
    computeAmbiguityScore,
    getUnlockDecision
  } = require("../../policy/ambiguityScoringEngine");
  
  function fail(msg) {
    console.error("❌ Policy fuzz failure:", msg);
    process.exit(1);
  }
  
  // deterministic pseudo RNG
  function rand(seed) {
    const x = Math.sin(seed) * 10000;
    return x - Math.floor(x);
  }
  
  const transcripts = [
    "yes",
    "ok",
    "okay",
    "yes please",
    "ok go ahead",
    "haan",
    "si",
    "oui",
    "ja",
    "maybe",
    "wait",
    "uh ok",
    "maybe later",
    "yes maybe",
    "no",
    "nah",
    "cancel",
    "stop",
    "no wait continue",
    "nah sorry go ahead",
    "yeeees",
    "noooo",
    "nahhh",
    "okaaaay",
    "no actually continue",
    "nah wait go ahead",
    "yes continue",
    "ok continue",
    "yes go ahead",
    "sure continue"
  ];
  
  const ITERATIONS = 10000;
  let violations = 0;
  let unlocks = 0;
  let clarifies = 0;
  let ignores = 0;
  let cancels = 0;
  
  for (let i = 1; i <= ITERATIONS; i++) {
  
    const confidence = rand(i) * 1.0;
  
    const energyMetrics = {
      score: rand(i * 2),
      variance: rand(i * 3),
      slope: rand(i * 4) - 0.5
    };
  
    const stabilityMetrics = {
      variance: rand(i * 5)
    };
  
    const transcript = transcripts[Math.floor(rand(i * 6) * transcripts.length)];
  
    const result = computeAmbiguityScore({
      confidence,
      transcript,
      transcriptTimingMs: rand(i * 7) * 2000,
      stabilityMetrics,
      energyMetrics,
      degradationState: "NORMAL"
    });
  
    if (!result || typeof result.finalScore !== "number") {
      fail("Engine returned invalid score object");
    }
  
    const decision = getUnlockDecision(
      "NORMAL",
      result.finalScore,
      confidence,
      0,
      2,
      transcript
    );
  
    switch (decision) {
      case "unlock": unlocks++; break;
      case "clarify": clarifies++; break;
      case "ignore": ignores++; break;
      case "cancel": cancels++; break;
      default:
        fail(`Invalid decision returned: ${decision}`);
    }
  
    // invariant 1: negative transcripts must never unlock
    if (["no","nah","cancel","stop"].includes(transcript) && decision === "unlock") {
      violations++;
    }
  
    // invariant 2: extremely high confidence confirmations should not ignore
    if (confidence > 0.9 && transcript === "yes" && decision === "ignore") {
      violations++;
    }
  
    // invariant 3: very noisy audio with low confidence should not unlock
    if (energyMetrics.variance > 0.8 && confidence < 0.7 && decision === "unlock") {
      violations++;
    }
  
    // invariant 4: model should not become overly conservative for clear confirmations
    if (confidence > 0.9 && transcript.startsWith("yes") && decision !== "unlock") {
      violations++;
    }
  
    // invariant 5: score must remain within valid numeric bounds
    if (!Number.isFinite(result.finalScore) || result.finalScore < 0 || result.finalScore > 100) {
      violations++;
    }
  }
  
  console.log("\n🔬 POLICY FUZZ RESULTS");
  console.log("Iterations:", ITERATIONS);
  console.log("Unlocks:", unlocks);
  console.log("Clarifications:", clarifies);
  console.log("Ignores:", ignores);
  console.log("Cancels:", cancels);
  console.log("Violations:", violations);
  
  if (violations > 0) {
    fail("Policy invariants violated");
  }
  
  console.log("✔ Policy fuzz validation passed");
  process.exit(0);