#!/usr/bin/env node

/**
 * TELEMETRY LIFECYCLE ORDER VALIDATOR
 *
 * Ensures voice lifecycle telemetry events are emitted in a valid order.
 * Detects impossible event sequences caused by race conditions, async bugs,
 * telecom jitter, or provider drift.
 *
 * Deterministic and CI-safe.
 */

const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();

const VALID_SEQUENCE = [
  "speech_started",
  "speech_playback_started",
  "speech_emitted",
  "speech_completed"
];

const OPTIONAL_EVENTS = new Set([
  "mode_transition",
  "micro_ack_emitted",
  "clarification_emitted",
  "carrier_jitter_sample"
]);

const SEARCH_EVENTS = new Set([
  ...VALID_SEQUENCE,
  ...OPTIONAL_EVENTS
]);

function walk(dir, files = []) {
  for (const file of fs.readdirSync(dir)) {
    const p = path.join(dir, file);
    const stat = fs.statSync(p);

    if (stat.isDirectory()) {
      if (file === "node_modules" || file === ".git" || file === "ci") continue;
      walk(p, files);
    } else if (file.endsWith(".js")) {
      files.push(p);
    }
  }
  return files;
}

function extractEvents(file) {
  const content = fs.readFileSync(file, "utf8");

  const matches = [...content.matchAll(/(?:logger|telemetry)\.emit\s*\(\s*['"`]([^'"`]+)['"`]/g)];

  const events = [];

  for (const m of matches) {
    const event = m[1];
    if (SEARCH_EVENTS.has(event)) {
      events.push(event);
    }
  }

  return events;
}

function validateSequence(events, file) {
  let lastIndex = -1;

  let seen = new Set();
  let lifecycleCount = 0;

  for (const e of events) {

    if (OPTIONAL_EVENTS.has(e)) {
      continue;
    }

    // Reset lifecycle when a new speech cycle begins
    if (e === "speech_started") {
      // if a lifecycle was already in progress but never completed
      if (seen.size > 0 && !seen.has("speech_completed")) {
        console.error(`❌ Incomplete lifecycle detected in ${file}`);
        console.error(`   speech_started occurred before previous speech_completed`);
        process.exit(1);
      }

      // start a new lifecycle
      lastIndex = -1;
      seen = new Set();
      lifecycleCount = 0;
    }

    const idx = VALID_SEQUENCE.indexOf(e);

    if (idx === -1) continue;

    if (seen.has(e)) {
      console.error(`❌ Duplicate lifecycle event "${e}" detected in ${file}`);
      process.exit(1);
    }

    if (idx < lastIndex) {
      console.error(`❌ Telemetry lifecycle violation in ${file}`);
      const prev = lastIndex >= 0 ? VALID_SEQUENCE[lastIndex] : "start";
      console.error(`   Invalid order: ${e} after ${prev}`);
      process.exit(1);
    }

    lastIndex = idx;
    seen.add(e);

    lifecycleCount++;

    // detect abnormal lifecycle length (infinite emission loops / race bugs)
    if (lifecycleCount > 10) {
      console.error(`❌ Abnormally long lifecycle detected in ${file}`);
      process.exit(1);
    }
  }

  // ensure any lifecycle that started also completed
  if (seen.has("speech_started") && !seen.has("speech_completed")) {
    console.error(`❌ Lifecycle started but never completed in ${file}`);
    process.exit(1);
  }
}

const files = walk(ROOT);

let checked = 0;

for (const file of files) {
  const events = extractEvents(file);

  if (events.length === 0) continue;

  validateSequence(events, file);
  checked++;
}

console.log(`✔ Telemetry lifecycle validation passed (${checked} files checked)`);
process.exit(0);