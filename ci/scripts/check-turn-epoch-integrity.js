/**
 * Turn Epoch Integrity Validator
 *
 * Prevents rare race conditions between:
 *  - pacing timers
 *  - micro-ack timers
 *  - interruption cancellation
 *
 * Ensures async emission paths snapshot the turnEpoch
 * and validate it before audio emission.
 */

const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '../../app.js');
const src = fs.readFileSync(file, 'utf8');

const code = src
  .replace(/\/\/.*$/gm, '')
  .replace(/\/\*[\s\S]*?\*\//g, '');

const lines = code.split('\n');

let failures = 0;

// async emission patterns we must guard
const ASYNC_PATTERNS = [
  /setTimeout\s*\(/,
  /setInterval\s*\(/,
  /Promise\./,
  /\.then\s*\(/,
  /async\s+\(/,
  /async\s*=>/
];

function containsAsync(context) {
  return ASYNC_PATTERNS.some(r => r.test(context));
}

function hasEpochSnapshot(context) {
  return (
    context.includes('scheduledTurn') ||
    context.includes('turnEpoch') ||
    context.includes('const scheduledTurn')
  );
}

function hasEpochValidation(lines, emissionIndex) {
  const start = Math.max(0, emissionIndex - 10);
  const guardWindow = lines.slice(start, emissionIndex).join('\n');

  return (
    guardWindow.includes('scheduledTurn !== turnState.currentTurnId') ||
    guardWindow.includes('assertTurnActive') ||
    guardWindow.includes('turnEpoch !==')
  );
}

for (let i = 0; i < lines.length; i++) {

  const line = lines[i];

  if (!containsAsync(line) && !line.includes('setTimeout')) continue;

  const windowStart = Math.max(0, i - 10);
  const windowEnd = Math.min(lines.length, i + 20);

  const context = lines.slice(windowStart, windowEnd).join('\n');

  const emissionDetected = context.includes('sendAudioDirect');

  if (emissionDetected && containsAsync(context)) {

    if (!hasEpochSnapshot(context)) {

      console.error('\n❌ Missing turnEpoch snapshot in async emission');
      console.error(`Line: ${i + 1}\n`);
      console.error(context);
      failures++;

    }

    if (!hasEpochValidation(lines, i)) {

      console.error('\n❌ Missing turnEpoch validation before emission');
      console.error(`Line: ${i + 1}\n`);
      console.error(context);
      failures++;

    }

  }

}

if (failures > 0) {

  console.error(`\n❌ Turn epoch integrity violations: ${failures}`);
  process.exit(1);

}

console.log('✔ Turn epoch integrity verified.');