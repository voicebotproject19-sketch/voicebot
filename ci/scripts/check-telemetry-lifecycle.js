/**
 * Telemetry Lifecycle Ordering Validator
 * Ensures speech lifecycle events appear in correct order in app.js
 */

const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
  path.join(__dirname, '../../app.js'),
  'utf8'
);

// Remove comments
const code = source
  .replace(/\/\/.*$/gm, '')
  .replace(/\/\*[\s\S]*?\*\//g, '');

const lifecycle = [
  'speech_started',
  'speech_playback_started',
  'speech_emitted',
  'speech_completed'
];

// Build regex that captures lifecycle events in code order (logger or telemetry)
const lifecycleRegex = /(?:logger|telemetry)\s*\.\s*emit\s*\(\s*['"](speech_started|speech_playback_started|speech_emitted|speech_completed)['"]/g;

const observed = [];
let match;

while ((match = lifecycleRegex.exec(code)) !== null) {
  observed.push(match[1]);
}

if (observed.length === 0) {
  console.error('❌ No speech lifecycle telemetry found in app.js');
  process.exit(1);
}

// Validate lifecycle ordering across every sequence
let expectedIndex = 0;

for (const event of observed) {
  if (event === lifecycle[expectedIndex]) {
    expectedIndex++;

    if (expectedIndex === lifecycle.length) {
      // Completed one valid lifecycle
      expectedIndex = 0;
    }

  } else if (event === lifecycle[0]) {
    // Start of a new lifecycle
    expectedIndex = 1;
  } else {
    console.error('❌ Telemetry lifecycle ordering violation detected.');
    console.error('Expected order: ' + lifecycle.join(' → '));
    console.error('Observed sequence: ' + observed.join(' → '));
    process.exit(1);
  }
}

console.log(`✔ Telemetry lifecycle ordering verified (${observed.length} events scanned).`);