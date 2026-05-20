#!/usr/bin/env node

/**
 * Event Schema Validator
 *
 * Purpose
 * -------
 * Ensures that telemetry events emitted through logger.emit() preserve
 * their expected payload structure. This protects observability from
 * silent schema drift during refactors or vibe‑coding changes.
 *
 * This validator performs static scanning of the repository and checks
 * that required payload keys exist in the logger.emit payload objects.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../../');

const TARGET_FILES = [
  'app.js',
  'services-twilio/stream-service-twilio.js',
  'services-plivo/stream-service-plivo.js'
];

/**
 * Frozen telemetry schema contract
 */
const EVENT_SCHEMA = {
  speech_emitted: ['durationMs', 'source'],
  turn_unlock: ['confidence'],
  degradation_transition: ['from', 'to'],
  micro_ack_emitted: ['durationMs'],
  silence_hangup: ['reason']
};

if (!EVENT_SCHEMA || Object.keys(EVENT_SCHEMA).length === 0) {
  fail('EVENT_SCHEMA configuration invalid');
}

function fail(msg) {
  console.error(`❌ Event schema violation: ${msg}`);
  process.exit(1);
}

function pass(msg) {
  console.log(`✔ ${msg}`);
}

function stripComments(code) {
  return code
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

function fileExists(filePath) {
  try {
    fs.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function scanForEventSchema(content, eventName) {
  const regex = new RegExp(
    `logger\\.emit\\(\\s*['\"]${eventName}['\"]([\\s\\S]*?)\\)`,
    'g'
  );

  const snippets = [];
  let match;

  while ((match = regex.exec(content)) !== null) {
    const argsSection = match[1];

    const payloadMatch = argsSection.match(/\{[\s\S]*?\}/);

    if (payloadMatch) {
      snippets.push(payloadMatch[0]);
    }
  }

  return snippets;
}

console.log('🔍 Running telemetry event schema validation...');

for (const relFile of TARGET_FILES) {
  const absPath = path.join(ROOT, relFile);

  if (!fileExists(absPath)) {
    fail(`Required file missing: ${relFile}`);
  }

  const raw = fs.readFileSync(absPath, 'utf8');
  const content = stripComments(raw);

  for (const [eventName, requiredFields] of Object.entries(EVENT_SCHEMA)) {
    const snippets = scanForEventSchema(content, eventName);

    if (!snippets || snippets.length === 0) continue;

    for (const snippet of snippets) {
      for (const field of requiredFields) {
        const fieldRegex = new RegExp(`\\b${field}\\b`);

        if (!fieldRegex.test(snippet)) {
          fail(`${eventName} missing required field "${field}" in ${relFile}`);
        }
      }
    }
  }

  pass(`Validated telemetry schema in ${relFile}`);
}

console.log('✔ Telemetry event schema validation passed');
process.exit(0);