/****
 * TURN MUTATION FREEZE (HARDENED)
 *
 * Ensures that ONLY app.js may mutate currentTurnId.
 *
 * Blocks:
 *  - direct assignment ( = )
 *  - compound assignment (+=, ||=, &&=, etc.)
 *  - property assignment (.currentTurnId =)
 *  - bracket assignment (['currentTurnId'] =)
 *
 * Does NOT block reads or comparisons.
 */

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const APP_PATH = path.join(ROOT, 'app.js');

// Detect ONLY true assignments, not comparisons (==, ===)
// Includes logical assignment operators (||=, &&=, ??=)
const MUTATION_PATTERNS = [
  /\bcurrentTurnId\s*(?:\+=|-=|\*=|\/=|%=|\|=|&=|\^=|\|\|=|&&=|\?\?=|=)(?!=)/,
  /\.currentTurnId\s*(?:\+=|-=|\*=|\/=|%=|\|=|&=|\^=|\|\|=|&&=|\?\?=|=)(?!=)/,
  /\[['"]currentTurnId['"]\]\s*(?:\+=|-=|\*=|\/=|%=|\|=|&=|\^=|\|\|=|&&=|\?\?=|=)(?!=)/
];

function containsTurnMutation(content) {
  return MUTATION_PATTERNS.some((regex) => regex.test(content));
}

function scanDirectory(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (
        entry.name === 'node_modules' ||
        entry.name === 'ci' ||
        entry.name === '.git'
      ) continue;

      scanDirectory(fullPath);
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.js')) {
      if (fullPath === APP_PATH) continue;

      const content = fs.readFileSync(fullPath, 'utf8');

      if (containsTurnMutation(content)) {
        console.error(`❌ Turn mutation detected outside app.js: ${fullPath}`);
        console.error('Only app.js may mutate currentTurnId.');
        process.exit(1);
      }
    }
  }
}

if (!fs.existsSync(APP_PATH)) {
  console.error('❌ app.js not found at project root.');
  process.exit(1);
}

scanDirectory(ROOT);

console.log('✔ Turn mutation validation passed (hardened enforcement).');
process.exit(0);