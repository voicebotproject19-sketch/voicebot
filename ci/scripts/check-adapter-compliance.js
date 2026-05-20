/**
 * Provider Telemetry / Adapter Compliance Validator
 *
 * The current architecture splits telemetry ownership between:
 * - shared session orchestration (provider-agnostic events)
 * - shared AI realtime adapter logic (BaseRealtimeAdapter)
 * - concrete provider adapters (Azure/OpenAI)
 *
 * This validator enforces that the session layer still emits critical call
 * telemetry, that finalization-owned call summary telemetry remains present,
 * and that the AI adapter layer still exposes the expected provider protocol
 * markers.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', '..', relativePath), 'utf8');
}

function extractTelemetryEvents(source) {
  const events = new Set();
  const pattern = /telemetry\s*\.\s*emit\s*\(\s*['"]([^'"]+)['"]/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    events.add(match[1]);
  }
  return events;
}

function missingEvents(source, requiredEvents) {
  return requiredEvents.filter(event => !source.has(event));
}

const sessionEvents = extractTelemetryEvents(read('session/createCallSession.js'));
const finalizerEvents = extractTelemetryEvents(read('services/callFinalizer.js'));
const baseEvents = extractTelemetryEvents(read('adapters/ai/BaseRealtimeAdapter.js'));
const azureSource = read('adapters/ai/AzureRealtimeAdapter.js');
const openaiSource = read('adapters/ai/OpenAIRealtimeAdapter.js');

const REQUIRED_SESSION_EVENTS = [
  'turn_created',
  'turn_snapshot',
  'degradation_state_transition',
  'user_speech_started',
  'speech_emitted'
];

const REQUIRED_FINALIZER_EVENTS = [
  'call_summary'
];

const REQUIRED_SHARED_PROVIDER_EVENTS = [
  'response_latency',
  'realtime_session_created',
  'realtime_session_updated',
  'realtime_usage',
  'realtime_connection_error',
  'response_timeout',
  'realtime_connection_closed',
  'realtime_reconnected',
  'realtime_reconnection_failed'
];

const failures = [];

for (const event of missingEvents(sessionEvents, REQUIRED_SESSION_EVENTS)) {
  failures.push(`Shared session telemetry missing required event: ${event}`);
}

for (const event of missingEvents(finalizerEvents, REQUIRED_FINALIZER_EVENTS)) {
  failures.push(`Shared call finalizer telemetry missing required event: ${event}`);
}

for (const event of missingEvents(baseEvents, REQUIRED_SHARED_PROVIDER_EVENTS)) {
  failures.push(`Base realtime adapter telemetry missing required event: ${event}`);
}

const ADAPTER_MARKERS = {
  azure: [
    /get\s+providerName\s*\(\)\s*\{\s*return 'azure-realtime';\s*\}/,
    /'api-key': this\.apiKey/,
    /input_audio_format:\s*'g711_ulaw'/,
    /output_audio_format:\s*'g711_ulaw'/,
    /model:\s*'azure-speech'/,
    /server_echo_cancellation/
  ],
  openai: [
    /get\s+providerName\s*\(\)\s*\{\s*return 'openai-realtime';\s*\}/,
    /'Authorization': `Bearer \$\{this\._openaiApiKey\}`/,
    /model:\s*'gpt-4o-transcribe'/,
    /mulawToLinear16_24k/,
    /linear16_24kToMulaw/,
    /type:\s*'semantic_vad'/,
    /_buildAudioConfig\(\)/,
    /output_modalities:\s*\['audio', 'text'\]/
  ]
};

for (const marker of ADAPTER_MARKERS.azure) {
  if (!marker.test(azureSource)) {
    failures.push(`Azure adapter missing expected protocol marker: ${marker}`);
  }
}

for (const marker of ADAPTER_MARKERS.openai) {
  if (!marker.test(openaiSource)) {
    failures.push(`OpenAI adapter missing expected protocol marker: ${marker}`);
  }
}

if (failures.length > 0) {
  console.error('AI adapter compliance drift detected against the current ownership model.');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`AI adapter compliance verified (session=${sessionEvents.size}, finalizer=${finalizerEvents.size}, base=${baseEvents.size}).`);
