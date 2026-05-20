/**
 * Telemetry Completeness Validator
 *
 * Ensures critical observability events are present in app.js.
 * Prevents accidental removal during refactors or vibe coding.
 */

const fs = require('fs');
const path = require('path');

const APP_FILE = path.join(__dirname, '../../app.js');

if (!fs.existsSync(APP_FILE)) {
  console.error('❌ app.js not found');
  process.exit(1);
}

const source = fs.readFileSync(APP_FILE, 'utf8');

/**
 * REQUIRED TELEMETRY EVENTS
 *
 * These events enable full conversation timeline reconstruction.
 * Removing any of them breaks observability.
 */
const REQUIRED_EVENTS = [
  'turn_created',
  'turn_snapshot',
  'mode_transition',

  'user_speech_started',
  'user_turn_completed',

  'audio_buffer_received',

  'speech_started',
  'speech_playback_started',
  'speech_emitted',
  'speech_completed',

  'speech_cancelled',

  'turn_interrupted',
  'turn_closed',

  'unlock_granted',
  'clarification_emitted',

  'degradation_state_transition',

  'hangup_triggered',

  'micro_ack_emitted'
];

let failures = [];

// Strip comments to avoid false positives
const code = source
  .replace(/\/\/.*$/gm, '')
  .replace(/\/\*[\s\S]*?\*\//g, '');

for (const event of REQUIRED_EVENTS) {
  const pattern = new RegExp(
    `(?:logger|telemetry)\\s*\\.\\s*emit\\s*\\(\\s*['"\`]${event}['"\`]`,
    'm'
  );

  if (!pattern.test(code)) {
    failures.push(event);
  }
}

if (failures.length > 0) {
  console.error('❌ Missing required telemetry events:\n');
  failures.forEach(e => console.error(`   - ${e}`));
  console.error('\nTelemetry contract violated.');
  process.exit(1);
}

console.log('✔ Telemetry completeness check passed.');