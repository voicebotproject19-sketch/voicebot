/**
 * Provider Behavior Drift Validator
 *
 * Validates the current provider architecture rather than scanning legacy
 * app.js sections. The critical invariants now live across:
 * - adapter contract implementations
 * - shared session orchestration
 * - provider-specific stream services
 * - thin provider-specific realtime wrappers
 */

'use strict';

const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', '..', relativePath), 'utf8');
}

function has(source, matcher) {
  return matcher instanceof RegExp ? matcher.test(source) : source.includes(matcher);
}

function record(failures, ok, message) {
  if (ok) return;
  failures.push(message);
}

const appSource = read('app.js');
const contractSource = read('adapters/telecom/TelecomProvider.js');
const sessionSource = read('session/createCallSession.js');
const aiResolverSource = read('adapters/ai/resolveAIProvider.js');

const providers = {
  twilio: {
    providerSource: read('adapters/telecom/TwilioProvider.js'),
    streamSource: read('services-twilio/stream-service-twilio.js'),
    realtimeSource: read('services-twilio/realtimeServiceTwilio.js'),
    providerFile: 'adapters/telecom/TwilioProvider.js',
    streamFile: 'services-twilio/stream-service-twilio.js',
    realtimeFile: 'services-twilio/realtimeServiceTwilio.js',
    route: 'connection_twilio',
    streamClass: 'StreamServiceTwilio',
    appRealtimeBinding: 'AI_PROVIDER === \'legacy\'',
    realtimeClass: 'RealtimeServiceTwilio',
    flags: {
      audioBufferStrategy: 'fifo-queue',
      listenerRegistrationTiming: 'on_start',
      hasPreConnectBuffer: true,
      requiresSessionConfigured: true
    },
    streamProtocolMarkers: [
      /event:\s*'media'/,
      /event:\s*'mark'/,
      /event:\s*'clear'/
    ]
  },
  plivo: {
    providerSource: read('adapters/telecom/PlivoProvider.js'),
    streamSource: read('services-plivo/stream-service-plivo.js'),
    realtimeSource: read('services-plivo/realtimeServicePlivo.js'),
    providerFile: 'adapters/telecom/PlivoProvider.js',
    streamFile: 'services-plivo/stream-service-plivo.js',
    realtimeFile: 'services-plivo/realtimeServicePlivo.js',
    route: 'connection_plivo',
    streamClass: 'StreamServicePlivo',
    appRealtimeBinding: 'AI_PROVIDER === \'legacy\'',
    realtimeClass: 'RealtimeServicePlivo',
    flags: {
      audioBufferStrategy: 'single-slot',
      listenerRegistrationTiming: 'immediate',
      hasPreConnectBuffer: true,
      requiresSessionConfigured: true
    },
    streamProtocolMarkers: [
      /event:\s*'playAudio'/,
      /event:\s*'checkpoint'/,
      /event:\s*'clearAudio'/
    ]
  }
};

const failures = [];

const contractMarkers = [
  '@property {(networkUrl: string) => string} incomingCallXml',
  '@property {(msg: object) => { callId: string, streamId: string }} extractStartFields',
  '@property {() => {',
  '@property {\'fifo-queue\'|\'single-slot\'} audioBufferStrategy',
  '@property {\'on_start\'|\'immediate\'} listenerRegistrationTiming'
];

for (const marker of contractMarkers) {
  record(failures, has(contractSource, marker), `TelecomProvider contract missing marker: ${marker}`);
}

const sharedSessionMarkers = [
  /const gateConfig = provider\.getGateConfig\(\);/,
  /typeof aiProviderOrServices === 'function'/,
  /resolveCallAIProvider/,
  /instantiateRealtimeService\(current\)/,
  /provider\.extractStartFields\(msg\)/,
  /provider\.audioBufferStrategy === 'fifo-queue'/,
  /provider\.hasPreConnectBuffer/,
  /provider\.requiresSessionConfigured/
];

for (const marker of sharedSessionMarkers) {
  record(failures, has(sessionSource, marker), `Shared session no longer consumes provider contract marker: ${marker}`);
}

record(
  failures,
  has(sessionSource, /resolveAIProvider/) && has(aiResolverSource, /azure-realtime/) && has(aiResolverSource, /openai-realtime/),
  'AI provider resolver wiring missing from createCallSession / resolveAIProvider.js'
);

for (const [providerName, config] of Object.entries(providers)) {
  const lifecycleMethods = [
    'async function createCall(',
    'async function hangup(',
    'async function transfer(',
    'function incomingCallXml(',
    'function extractStartFields(',
    'function getGateConfig('
  ];

  for (const marker of lifecycleMethods) {
    record(
      failures,
      has(config.providerSource, marker),
      `${config.providerFile} missing provider lifecycle method: ${marker}`
    );
  }

  for (const [flag, value] of Object.entries(config.flags)) {
    const matcher = typeof value === 'string'
      ? new RegExp(`${flag}:\\s*'${value.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}'`)
      : new RegExp(`${flag}:\\s*${String(value)}`);
    record(
      failures,
      has(config.providerSource, matcher),
      `${config.providerFile} missing expected ${flag}=${String(value)}`
    );
  }

  const appWiringMatchers = [
    new RegExp(`app\\.ws\\('/${config.route}',[\\s\\S]*?createCallSession\\(`),
    new RegExp(`streamServiceClass:\\s*${config.streamClass}`)
  ];

  for (const matcher of appWiringMatchers) {
    record(failures, has(appSource, matcher), `app.js missing ${providerName} wiring marker: ${matcher}`);
  }

  const sharedStreamMethods = [
    /assertTurnActive\(scheduledTurn\)/,
    /setStreamId\(streamId\)/,
    /buffer\(index, audio, hold, audioDuration\)/,
    /sendAudioDirect\(audio, audioDuration, hold = false[^)]*\)/,
    /stopCurrentAudio\(\)/,
    /handleInterruption\(\)/,
    /stopPlayback\(\)/
  ];

  for (const marker of sharedStreamMethods) {
    record(failures, has(config.streamSource, marker), `${config.streamFile} missing stream control marker: ${marker}`);
  }

  for (const marker of config.streamProtocolMarkers) {
    record(failures, has(config.streamSource, marker), `${config.streamFile} missing provider protocol marker: ${marker}`);
  }

  const realtimeMarkers = [
    new RegExp(`class ${config.realtimeClass} extends AzureRealtimeAdapter`),
    /super\(\{/,
    /emitAudioAsBuffer:\s*true/
  ];

  for (const marker of realtimeMarkers) {
    record(failures, has(config.realtimeSource, marker), `${config.realtimeFile} missing realtime marker: ${marker}`);
  }
}

if (failures.length > 0) {
  console.error('Provider behavior drift detected against the current adapter/session architecture.');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('Provider behavior parity verified against adapter, session, stream, and realtime contracts.');