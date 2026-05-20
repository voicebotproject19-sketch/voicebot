'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

const RUNTIME_ENTRIES = [
  'app.js',
  'Controller',
  'Routes',
  'Helper',
  'Knowledge-base',
  'adapters',
  'config',
  'logic',
  'middleware',
  'persona',
  'personas',
  'profiles',
  'rag',
  'repositories',
  'services',
  'services-plivo',
  'services-twilio',
  'session',
  'transactions',
  'Utils'
];

const EXCLUDED_DIRS = new Set([
  '.azure',
  '.git',
  'ci',
  'docs',
  'logs',
  'node_modules',
  'plans',
  'tests'
]);

const PLATFORM_SIGNAL_VARS = new Set([
  'HOSTNAME',
  'NODE_APP_INSTANCE',
  'PM2_HOME',
  'WEB_CONCURRENCY',
  'WORKERS'
]);

const TEST_RUNTIME_SIGNAL_VARS = new Set([
  'JEST_WORKER_ID',
  'VOICEBOT_TELEMETRY_AZURE_IN_JEST'
]);

function isAllowedUndocumentedRuntimeSignal(name) {
  return PLATFORM_SIGNAL_VARS.has(name) || TEST_RUNTIME_SIGNAL_VARS.has(name);
}

const REQUIRED_AZURE_PLAN_VARS = [
  'PORT',
  'NODE_ENV',
  'NETWORK_URL',
  'CORS_ALLOWED_ORIGINS',
  'APP_API_KEY',
  'AI_PROVIDER',
  'AZURE_REALTIME_ENDPOINT',
  'AZURE_REALTIME_KEY',
  'AZURE_VOICE_LIVE_MODEL',
  'AZURE_VOICE_LIVE_TRANSCRIPTION_MODEL',
  'AZURE_OPENAI_ENDPOINT',
  'AZURE_OPENAI_API_KEY',
  'OPENAI_API_VERSION',
  'AZURE_CLASSIFIER_MODEL',
  'OPENAI_HANGUP_MODEL',
  'DB_HOST',
  'DB_USER',
  'DB_PASSWORD',
  'DB_NAME',
  'DB_CONNECTION_LIMIT',
  'VOICEBOT_TELEMETRY',
  'AZURE_MONITOR_CONNECTION_STRING',
  'APPLICATIONINSIGHTS_CONNECTION_STRING',
  'OTEL_SERVICE_NAME',
  'OTEL_SERVICE_NAMESPACE',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_ACCOUNT_AUTH_TOKEN',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_FROM_NUMBER',
  'PLIVO_AUTH_ID',
  'PLIVO_AUTH_TOKEN',
  'PLIVO_FROM_NUMBER',
  'BOOKING_CORRELATION_SECRET',
  'BOOKING_WEBHOOK_SECRET',
  'CALENDLY_WEBHOOK_SIGNING_KEY',
  'CALENDLY_WEBHOOK_SECRET',
  'MICROSOFT_BOOKINGS_WEBHOOK_SECRET',
  'SMTP_HOST',
  'SMTP_USER',
  'SMTP_PASS',
  'SMTP_FROM',
  'VOICEBOT_REDACT_CALL_CONTENT',
  'PHASE3_ENABLED'
];

function listRuntimeFiles(entry) {
  const fullPath = path.join(ROOT, entry);
  if (!fs.existsSync(fullPath)) return [];

  const stat = fs.statSync(fullPath);
  if (stat.isDirectory()) {
    if (EXCLUDED_DIRS.has(path.basename(fullPath))) return [];
    return fs.readdirSync(fullPath).flatMap((child) => listRuntimeFiles(path.join(entry, child)));
  }

  return entry.endsWith('.js') ? [entry] : [];
}

function lineNumber(source, index) {
  return source.slice(0, index).split(/\r?\n/).length;
}

function addReference(map, name, reference) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) return;
  if (!map.has(name)) map.set(name, new Set());
  map.get(name).add(reference);
}

function collectRuntimeEnvVars() {
  const refs = new Map();
  const dynamicRefs = [];
  const files = RUNTIME_ENTRIES.flatMap(listRuntimeFiles);

  for (const relativePath of files) {
    const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
    const patterns = [
      /process\.env\.([A-Z][A-Z0-9_]*)/g,
      /process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g,
      /\benv\.([A-Z][A-Z0-9_]*)/g,
      /\b(?:read(?:Bounded)?NumberEnv|readCsvEnv|readBooleanEnv|readMoneyEnv)\(['"]([A-Z][A-Z0-9_]*)['"]/g
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(source))) {
        addReference(refs, match[1], `${relativePath}:${lineNumber(source, match.index)}`);
      }
    }

    for (const match of source.matchAll(/(?:const|let|var)\s*\{([^}]+)\}\s*=\s*process\.env/g)) {
      for (const part of match[1].split(',')) {
        const name = part.trim().split(/\s*[:=]\s*/)[0].trim();
        addReference(refs, name, `${relativePath}:${lineNumber(source, match.index)} destructured`);
      }
    }

    for (const match of source.matchAll(/process\.env\[`([^`]+)`\]/g)) {
      dynamicRefs.push(`${relativePath}:${lineNumber(source, match.index)}: process.env[\`${match[1]}\`]`);
      if (match[1].includes('${lang}')) {
        const baseName = match[1].replace('_${lang}', '');
        addReference(refs, `${baseName}_EN`, `${relativePath}:${lineNumber(source, match.index)} derived-from-language-env`);
        addReference(refs, `${baseName}_DE`, `${relativePath}:${lineNumber(source, match.index)} derived-from-language-env`);
      }
    }

    for (const match of source.matchAll(/process\.env\[([^\]'"`\n][^\]\n]*)\]/g)) {
      dynamicRefs.push(`${relativePath}:${lineNumber(source, match.index)}: process.env[${match[1].trim()}]`);
    }
  }

  return { refs, dynamicRefs, filesScanned: files.length };
}

function parseEnvExample() {
  const files = fs.readdirSync(ROOT)
    .filter((name) => name === '.env.example' || /^\.env\.[A-Za-z0-9_-]+\.example$/.test(name))
    .sort((a, b) => {
      if (a === '.env.example') return -1;
      if (b === '.env.example') return 1;
      return a.localeCompare(b);
    });

  const active = new Set();
  const commented = new Set();

  for (const fileName of files) {
    const source = fs.readFileSync(path.join(ROOT, fileName), 'utf8');
    for (const line of source.split(/\r?\n/)) {
      const activeMatch = line.match(/^([A-Z][A-Z0-9_]*)=/);
      if (activeMatch) active.add(activeMatch[1]);

      const commentedMatch = line.match(/^#\s*([A-Z][A-Z0-9_]*)=/);
      if (commentedMatch) commented.add(commentedMatch[1]);
    }
  }

  return { active, commented, files };
}

function parseAzurePlan() {
  const filePath = path.join(ROOT, '.azure', 'plan.copilotmd');
  if (!fs.existsSync(filePath)) return new Set();

  const source = fs.readFileSync(filePath, 'utf8');
  const names = new Set();
  for (const match of source.matchAll(/`([A-Z][A-Z0-9_]*)/g)) {
    names.add(match[1]);
  }
  return names;
}

function formatMissing(name, refs) {
  const locations = refs.has(name) ? [...refs.get(name)].slice(0, 5).join(', ') : 'no references captured';
  return `- ${name} (${locations})`;
}

function main() {
  const { refs, dynamicRefs, filesScanned } = collectRuntimeEnvVars();
  const runtimeVars = [...refs.keys()].sort();
  const envExample = parseEnvExample();
  const azurePlanVars = parseAzurePlan();

  const missingFromEnvExample = runtimeVars.filter((name) => {
    return !envExample.active.has(name) && !isAllowedUndocumentedRuntimeSignal(name);
  });

  const undocumentedPlatformSignals = runtimeVars.filter((name) => {
    return PLATFORM_SIGNAL_VARS.has(name) && !envExample.active.has(name) && !envExample.commented.has(name);
  });

  const missingFromAzurePlan = REQUIRED_AZURE_PLAN_VARS.filter((name) => !azurePlanVars.has(name));
  const envContractLabel = envExample.files.length ? envExample.files.join(', ') : 'env contract files';

  const errors = [];
  if (!envExample.files.length) {
    errors.push('No env contract files found. Expected .env.example or .env.*.example at repository root.');
  }
  if (missingFromEnvExample.length) {
    errors.push(`Runtime env vars missing from env contract files (${envContractLabel}):\n` + missingFromEnvExample.map((name) => formatMissing(name, refs)).join('\n'));
  }
  if (undocumentedPlatformSignals.length) {
    errors.push(`Platform env signals should be documented as comments in env contract files (${envContractLabel}):\n` + undocumentedPlatformSignals.map((name) => formatMissing(name, refs)).join('\n'));
  }
  if (missingFromAzurePlan.length) {
    errors.push('Production-critical env vars missing from .azure/plan.copilotmd:\n' + missingFromAzurePlan.map((name) => `- ${name}`).join('\n'));
  }

  if (errors.length) {
    console.error('Environment contract validation failed:');
    for (const error of errors) console.error(`\n${error}`);
    if (dynamicRefs.length) {
      console.error('\nDynamic process.env references reviewed by helper/derived rules:');
      for (const ref of dynamicRefs) console.error(`- ${ref}`);
    }
    process.exit(1);
  }

  console.log(`Environment contract validation passed (${runtimeVars.length} vars across ${filesScanned} runtime files; ${envExample.active.size} env contract entries from ${envContractLabel}).`);
}

main();
