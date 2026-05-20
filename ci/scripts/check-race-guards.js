/**
 * Race Guard Validator
 *
 * Ensures every audio emission path is protected against:
 * - pacing timers
 * - micro-ack timers
 * - interruption cancellation
 *
 * Prevents ghost audio emission under telecom jitter.
 */

const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '../../app.js');
const source = fs.readFileSync(file, 'utf8');

// remove comments
const code = source
  .replace(/\/\/.*$/gm, '')
  .replace(/\/\*[\s\S]*?\*\//g, '');

const lines = code.split('\n');

let failures = 0;

// async emission patterns (more precise than substring checks)
const ASYNC_PATTERNS = [
  /setTimeout\s*\(/,
  /setInterval\s*\(/,
  /Promise\./,
  /\.then\s*\(/,
  /async\s+\(/,
  /async\s*=>/
];

function hasRaceGuard(lines, emissionIndex) {
  const start = Math.max(0, emissionIndex - 10);
  const guardWindow = lines.slice(start, emissionIndex).join('\n');

  return (
    guardWindow.includes('assertTurnActive') ||
    guardWindow.includes('edgeSession.isClosed') ||
    guardWindow.includes('currentTurnId') ||
    guardWindow.includes('turnState.currentTurnId')
  );
}

for (let i = 0; i < lines.length; i++) {

  const line = lines[i];

  if (!line.includes('sendAudioDirect')) continue;

  const start = Math.max(0, i - 10);
  const end = Math.min(lines.length, i + 10);

  const context = lines.slice(start, end).join('\n');

  const asyncContext = ASYNC_PATTERNS.some(r => r.test(context));

  if (asyncContext && !hasRaceGuard(lines, i)) {

    console.error('\n❌ Unguarded async audio emission detected');
    console.error(`Line: ${i + 1}\n`);
    console.error(context);
    failures++;

  }

}

if (failures > 0) {
  console.error(`\n❌ Race guard violations: ${failures}`);
  process.exit(1);
}

console.log('✔ Race guard validation passed.');