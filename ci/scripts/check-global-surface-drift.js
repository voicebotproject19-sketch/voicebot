/**
 * GLOBAL SURFACE DRIFT VALIDATOR (HARDENED v3.5)
 *
 * Adds protection against factory-based singleton drift.
 *
 * Blocks at top-level (outside approved files):
 *  - let / var
 *  - const assigned to {}, [], new X(), Map/Set
 *  - const assigned to factory call (createX(), buildX(), etc.)
 *  - module.exports assigned to object literal or factory call
 *  - global/globalThis mutation
 *
 * Allows only:
 *  - const x = require(...)
 *  - primitive const declarations
 */

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();

const APPROVED_GLOBAL_PATH_PREFIXES = [
  path.join(ROOT, 'app.js'),
  path.join(ROOT, 'config')
];

const IGNORE_DIRS = ['node_modules', '.git', 'ci'];

function fail(message) {
  console.error(`❌ Global surface drift detected: ${message}`);
  process.exit(1);
}

function isIgnoredDir(name) {
  return IGNORE_DIRS.includes(name);
}

function isApprovedFile(filePath) {
  return APPROVED_GLOBAL_PATH_PREFIXES.some(prefix =>
    filePath.startsWith(prefix)
  );
}

function containsForbiddenTopLevelState(content) {
  const lines = content.split('\n');
  let braceDepth = 0;
  let pendingConstAssignment = null;

  for (let rawLine of lines) {
    const line = rawLine.trim();

    // Improved brace depth handling: ignore braces inside strings
    let inString = false;
    for (let i = 0; i < rawLine.length; i++) {
      const char = rawLine[i];

      if (char === '"' || char === "'" || char === '`') {
        inString = !inString;
      }

      if (!inString) {
        if (char === '{') braceDepth++;
        if (char === '}') braceDepth--;
      }
    }

    if (braceDepth !== 0) continue;

    // Block let / var
    if (/^let\s+/.test(line) || /^var\s+/.test(line)) {
      return `Top-level mutable declaration: ${line}`;
    }

    // Block object literals (except approved runtime registries)
    if (/^const\s+\w+\s*=\s*\{/.test(line)) {

      return `Top-level object literal: ${line}`;
    }

    if (/^const\s+\w+\s*=\s*\[/.test(line)) {
      return `Top-level array literal: ${line}`;
    }

    // Block class instances
    if (/^const\s+\w+\s*=\s*new\s+/.test(line)) {

      // Allow Plivo SDK client initialization (intentional service client)
      if (/^const\s+plivoClient\s*=\s*new\s+plivo\.Client/.test(line)) {
        continue;
      }

      return `Top-level class instance: ${line}`;
    }

    // Block collection constructors without new
    if (/^const\s+\w+\s*=\s*(Map|Set|WeakMap|WeakSet)\(/.test(line)) {
      return `Top-level collection instance: ${line}`;
    }

    // Detect start of possible multi-line const assignment
    if (/^const\s+\w+\s*=\s*$/.test(line)) {
      pendingConstAssignment = line;
      continue;
    }

    // Detect continuation of multi-line singleton factories
    if (pendingConstAssignment && /^\w+\(/.test(line)) {
      pendingConstAssignment = null;
      return `Top-level factory-based singleton (multiline): ${line}`;
    }

    // Block factory calls (except require)
    if (/^const\s+\w+\s*=\s*\w+\(/.test(line) && !/^const\s+\w+\s*=\s*require\(/.test(line)) {

      // Allow Twilio SDK client initialization
      if (/^const\s+client\s*=\s*twilio\(/.test(line)) {
        continue;
      }

      return `Top-level factory-based singleton: ${line}`;
    }

    // Detect helper-based singleton factories: require(...).createX()
    if (/^const\s+\w+\s*=\s*require\([^)]+\)\.\w+\(/.test(line)) {
      return `Top-level helper factory singleton: ${line}`;
    }

    // Detect imported helper factories: helper.createX()
    if (/^const\s+\w+\s*=\s*\w+\.\w+\(/.test(line)) {

      // Allow Express router initialization (stateless routing object)
      if (/^const\s+Router\s*=\s*express\.Router\(\)/.test(line) ||
          /^const\s+router\s*=\s*express\.Router\(\)/.test(line)) {
        continue;
      }

      return `Top-level helper method singleton: ${line}`;
    }

    // Detect hidden singleton assignment via object property (registry.redis = createRedis())
    if (/^\w+\.\w+\s*=\s*\w+\(/.test(line)) {
      return `Hidden singleton via object property assignment: ${line}`;
    }

    // Detect immediately-invoked function expressions creating hidden singletons
    if (/^const\s+\w+\s*=\s*\(\s*\(\s*\)\s*=>/.test(line) || /^\(\s*function/.test(line)) {
      return `Top-level IIFE singleton: ${line}`;
    }

    // Validate module.exports object literal does not create hidden state
    if (/^module\.exports\s*=\s*\{/.test(line)) {

      // allow simple identifier exports: module.exports = { a, b, c }
      if (/^module\.exports\s*=\s*\{\s*[a-zA-Z0-9_,\s]+\s*\}/.test(line)) {
        continue;
      }

      return `Top-level module.exports object literal with potential state: ${line}`;
    }

    // Block module.exports factory call
    if (/^module\.exports\s*=\s*\w+\(/.test(line)) {
      return `Top-level module.exports factory singleton: ${line}`;
    }

    // Detect exported factory wrapper (lazy singleton pattern)
    if (/^module\.exports\s*=\s*(async\s*)?function/.test(line) ||
        /^module\.exports\s*=\s*\(?.*\)?\s*=>/.test(line)) {
      return `Top-level exported function singleton wrapper: ${line}`;
    }

    // Detect named export factory wrappers (exports.foo = () => createX())
    if (/^exports\.\w+\s*=\s*(async\s*)?function/.test(line) ||
        /^exports\.\w+\s*=\s*\(?.*\)?\s*=>/.test(line)) {
      return `Top-level exported factory wrapper: ${line}`;
    }
  }

  return null;
}

function containsGlobalLeak(content) {
  const globalPatterns = [
    /\bglobal\./,
    /\bglobalThis\./,
    /\bObject\.assign\s*\(\s*global/,
    /\bObject\.defineProperty\s*\(\s*global/,
    /\bconst\s+\w+\s*=\s*global\b/
  ];

  return globalPatterns.some(regex => regex.test(content));
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

    if (isApprovedFile(fullPath)) continue;

    const content = fs.readFileSync(fullPath, 'utf8');

    if (containsGlobalLeak(content)) {
      fail(`Explicit global object mutation found in ${fullPath}`);
    }

    const forbidden = containsForbiddenTopLevelState(content);
    if (forbidden) {
      fail(`${forbidden} in ${fullPath}`);
    }
  }
}

scanDirectory(ROOT);

console.log('✔ Global surface validation passed (hardened v3.5).');
process.exit(0);
