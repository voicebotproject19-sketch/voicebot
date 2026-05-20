/**
 * HOT PATH LOGGING DRIFT VALIDATOR (HARDENED v5)
 *
 * Improvements over v4:
 *  - Requires event names to appear inside quotes (prevents matching audioBuffer/message vars)
 *  - Proper multiline registration parsing using parenthesis depth
 *  - Emitter-aware detection (realtimeService, ws, adapter supported)
 *  - Avoids generic "message" false positives except for ws.on('message')
 *
 * Hot events enforced:
 *  - realtimeService / adapter: 'audio', 'user_transcript', 'response.created'
 *  - ws: 'message'
 *
 * Blocks inside hot callbacks:
 *  - console.*
 *  - logger.*
 *  - debug.*
 *  - winston.*
 *  - pino.*
 *  - Aliased console usage (const x = console.log)
 */

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const IGNORE_DIRS = ['node_modules', '.git', 'ci'];

const HOT_EMITTERS = new Set(['realtimeService', 'adapter', 'realtimeAdapter']);

function fail(message) {
  console.error(`❌ Hot-path logging drift detected: ${message}`);
  process.exit(1);
}

function isIgnoredDir(name) {
  return IGNORE_DIRS.includes(name);
}

function scanDirectory(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (isIgnoredDir(entry.name)) continue;
      scanDirectory(fullPath);
      continue;
    }

    if (!entry.name.endsWith('.js')) continue;

    const content = fs.readFileSync(fullPath, 'utf8');
    validateFile(fullPath, content);
  }
}

function validateFile(filePath, content) {
  const lines = content.split('\n');

  let insideHotCallback = false;
  let callbackBraceDepth = 0;
  let registrationBuffer = '';
  let parenDepth = 0;
  let trackingRegistration = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect emitter.on(
    const emitterMatch = line.match(/(\w+)\.on\s*\(/);
    if (emitterMatch) {
      const emitter = emitterMatch[1];

      if (HOT_EMITTERS.has(emitter) || emitter === 'ws') {
        trackingRegistration = true;
        registrationBuffer = line;
        parenDepth = (line.match(/\(/g) || []).length - (line.match(/\)/g) || []).length;
        continue;
      }
    }

    if (trackingRegistration) {
      registrationBuffer += '\n' + line;
      parenDepth += (line.match(/\(/g) || []).length;
      parenDepth -= (line.match(/\)/g) || []).length;

      if (parenDepth <= 0) {
        trackingRegistration = false;

        // Extract emitter again
        const emitterMatch2 = registrationBuffer.match(/(\w+)\.on\s*\(/);
        if (!emitterMatch2) continue;

        const emitter = emitterMatch2[1];

        // Extract quoted event name
        const eventMatch = registrationBuffer.match(/['"](audio|user_transcript|response\.created|message)['"]/);
        if (!eventMatch) continue;

        const eventName = eventMatch[1];

        // Validate event per emitter
        if (
          (HOT_EMITTERS.has(emitter) && ['audio', 'user_transcript', 'response.created'].includes(eventName)) ||
          (emitter === 'ws' && eventName === 'message')
        ) {
          insideHotCallback = true;
          callbackBraceDepth = 0;
        }
      }

      continue;
    }

    // Track brace depth inside callback
    for (const char of line) {
      if (char === '{' && insideHotCallback) callbackBraceDepth++;
      if (char === '}' && insideHotCallback) callbackBraceDepth--;
    }

    // Block forbidden logging
    if (insideHotCallback && /(console\.|logger\.|debug\.|winston\.|pino\.)/.test(line)) {
      fail(`Logging detected inside hot-path callback in ${filePath} at line ${i + 1}`);
    }

    // Block console alias inside callback
    if (insideHotCallback && /const\s+\w+\s*=\s*console\./.test(line)) {
      fail(`Console alias detected inside hot-path callback in ${filePath} at line ${i + 1}`);
    }

    if (insideHotCallback && callbackBraceDepth <= 0) {
      insideHotCallback = false;
    }
  }
}

scanDirectory(ROOT);

console.log('✔ Hot-path logging validation passed (hardened v5).');
process.exit(0);