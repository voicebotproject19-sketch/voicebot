/**
 * VENDOR LEAKAGE PROTECTION (Core Layers) — HARDENED v2
 *
 * Improvements over v1:
 *  - Only inspects import / require module strings (no comment / variable false positives)
 *  - Detects constructor usage (e.g. new Twilio(), new AzureOpenAI())
 *  - Emitter‑agnostic and adapter‑friendly
 *  - Vendor list centralized for easy extension
 *
 * Allowed vendor usage ONLY inside:
 *   - adapters/
 *   - providers/
 *   - infra/
 *   - integration/
 */

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();

const IGNORE_DIRS = ['node_modules', '.git', 'ci'];
const ALLOWED_VENDOR_DIRS = ['adapters', 'providers', 'infra', 'integration'];

/**
 * Add new vendors here when onboarding.
 * Only module names or constructor identifiers — NOT generic words.
 */
const VENDORS = [
  {
    name: 'twilio',
    modulePatterns: [/^twilio$/i],
    constructorPatterns: [/new\s+Twilio\b/]
  },
  {
    name: 'plivo',
    modulePatterns: [/^plivo$/i],
    constructorPatterns: [/new\s+Plivo\b/]
  },
  {
    name: 'azure',
    modulePatterns: [/^@azure\//i],
    constructorPatterns: [/new\s+Azure/i]
  },
  {
    name: 'elevenlabs',
    modulePatterns: [/^elevenlabs$/i],
    constructorPatterns: [/new\s+Eleven/i]
  },
  {
    name: 'deepgram',
    modulePatterns: [/^deepgram$/i],
    constructorPatterns: [/new\s+Deepgram/i]
  },
  {
    name: 'sarvam',
    modulePatterns: [/^sarvam/i],
    constructorPatterns: [/new\s+Sarvam/i]
  }
];

function fail(message) {
  console.error(`❌ Vendor leakage detected: ${message}`);
  process.exit(1);
}

function isIgnoredDir(name) {
  return IGNORE_DIRS.includes(name);
}

function isAllowedVendorPath(filePath) {
  const normalized = filePath.split(path.sep).join('/');
  return ALLOWED_VENDOR_DIRS.some(dir =>
    normalized.includes(`/${dir}/`)
  );
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

    validateFile(fullPath);
  }
}

function stripComments(line) {
  // remove // comments
  const noInline = line.replace(/\/\/.*$/, '');
  // remove simple block comments on the same line
  return noInline.replace(/\/\*.*?\*\//g, '');
}

function extractModuleString(line) {
  // require('module')
  const requireMatch = line.match(/require\(\s*['"]([^'"]+)['"]\s*\)/);
  if (requireMatch) return requireMatch[1];

  // import ... from 'module'
  const importMatch = line.match(/from\s+['"]([^'"]+)['"]/);
  if (importMatch) return importMatch[1];

  // import 'module'
  const bareImportMatch = line.match(/import\s+['"]([^'"]+)['"]/);
  if (bareImportMatch) return bareImportMatch[1];

  return null;
}

function validateFile(filePath) {
  if (isAllowedVendorPath(filePath)) return;

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    let line = stripComments(lines[i]).trim();
    if (!line) continue;

    // 1️⃣ Check import / require leakage
    const moduleString = extractModuleString(line);
    if (moduleString) {
      for (const vendor of VENDORS) {
        for (const pattern of vendor.modulePatterns) {
          if (pattern.test(moduleString)) {
            fail(
              `Vendor module "${vendor.name}" imported in core layer: ${filePath} at line ${i + 1}`
            );
          }
        }
      }
    }

    // 2️⃣ Check constructor leakage (e.g. new Twilio())
    for (const vendor of VENDORS) {
      for (const pattern of vendor.constructorPatterns) {
        if (pattern.test(line) && /new\s+[A-Z]/.test(line)) {
          fail(
            `Vendor constructor "${vendor.name}" used in core layer: ${filePath} at line ${i + 1}`
          );
        }
      }
    }
  }
}

scanDirectory(ROOT);

console.log('✔ Vendor leakage validation passed (hardened v2).');
process.exit(0);