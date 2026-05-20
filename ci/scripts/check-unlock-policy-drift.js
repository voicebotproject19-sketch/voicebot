/**
 * UNLOCK POLICY DRIFT VALIDATOR (HARDENED)
 *
 * Ensures:
 *  - Unlock thresholds follow invariant ordering
 *  - Thresholds are within numeric bounds
 *  - Clarification limits are sane
 *  - ambiguityScoringEngine.js imports unlock-contract.js
 *  - ambiguityScoringEngine.js references SCORE_THRESHOLDS
 *  - No hardcoded unlock threshold literals exist in engine
 *
 * This script does NOT freeze implementation structure.
 */

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const CONTRACT_PATH = path.join(ROOT, 'ci/contracts/unlock-contract.js');
const POLICY_ENGINE_PATH = path.join(ROOT, 'policy', 'ambiguityScoringEngine.js');

if (!fs.existsSync(CONTRACT_PATH)) {
  console.error('❌ unlock-contract.js not found.');
  process.exit(1);
}

const contract = require(CONTRACT_PATH);

function fail(message) {
  console.error(`❌ Unlock policy drift detected: ${message}`);
  process.exit(1);
}

/**
 * 1️⃣ Validate numeric bounds
 */
function validateBounds() {
  const { SCORE_THRESHOLDS, SEVERE_MIN_CONFIDENCE } = contract;

  for (const [state, value] of Object.entries(SCORE_THRESHOLDS)) {
    if (typeof value !== 'number') {
      fail(`SCORE threshold for ${state} must be numeric.`);
    }

    if (value < 0 || value > 100) {
      fail(`Invalid SCORE threshold for ${state}: ${value}`);
    }
  }

  if (
    typeof SEVERE_MIN_CONFIDENCE !== 'number' ||
    SEVERE_MIN_CONFIDENCE < 0 ||
    SEVERE_MIN_CONFIDENCE > 1
  ) {
    fail(`Invalid SEVERE_MIN_CONFIDENCE: ${SEVERE_MIN_CONFIDENCE}`);
  }
}

/**
 * 2️⃣ Validate relational ordering
 */
function validateOrdering() {
  const { SCORE_THRESHOLDS, INVARIANTS } = contract;

  if (!INVARIANTS || !INVARIANTS.ENFORCE_ORDERING) return;

  const { NORMAL, DEGRADED, SEVERE } = SCORE_THRESHOLDS;

  if (!(NORMAL < DEGRADED && DEGRADED < SEVERE)) {
    fail(
      `Unlock thresholds out of order: NORMAL(${NORMAL}) < DEGRADED(${DEGRADED}) < SEVERE(${SEVERE}) required`
    );
  }
}

/**
 * 3️⃣ Validate clarification policy
 */
function validateClarificationPolicy() {
  const { CLARIFICATION_POLICY } = contract;

  if (!CLARIFICATION_POLICY) {
    fail('CLARIFICATION_POLICY missing from unlock-contract.');
  }

  const { MAX_CLARIFICATIONS } = CLARIFICATION_POLICY;

  if (typeof MAX_CLARIFICATIONS !== 'number') {
    fail('MAX_CLARIFICATIONS must be numeric.');
  }

  if (MAX_CLARIFICATIONS < 0) {
    fail('MAX_CLARIFICATIONS must be >= 0');
  }

  if (MAX_CLARIFICATIONS > 5) {
    fail('MAX_CLARIFICATIONS too high — risk of infinite clarification loop');
  }
}

/**
 * 4️⃣ Validate policy engine imports and uses contract
 */
function validateEngineUsage() {
  if (!fs.existsSync(POLICY_ENGINE_PATH)) {
    fail('ambiguityScoringEngine.js not found — unlock engine location must be updated in validator.');
  }

  const content = fs.readFileSync(POLICY_ENGINE_PATH, 'utf8');

  // Ensure unlock-contract is imported
  const importRegex = /require\((['"]).*unlock-contract.*\1\)/;
  if (!importRegex.test(content)) {
    fail('ambiguityScoringEngine.js must require unlock-contract.js');
  }

  // Ensure SCORE_THRESHOLDS is referenced
  if (!content.includes('SCORE_THRESHOLDS')) {
    fail('ambiguityScoringEngine.js must reference SCORE_THRESHOLDS from unlock-contract');
  }

  // Detect hardcoded unlock threshold literals (hardened guard)
  // Literals matching contract thresholds must NOT appear directly in the engine.
  const hardcodedValues = Object.values(contract.SCORE_THRESHOLDS);
  for (const value of hardcodedValues) {
    const literalRegex = new RegExp(`[^A-Za-z0-9_]${value}[^A-Za-z0-9_]`);

    if (literalRegex.test(content)) {
      // Allow literal only inside comments explaining thresholds
      const lines = content.split('\n');
      const offendingLines = lines.filter(l => literalRegex.test(l) && !l.trim().startsWith('//'));

      if (offendingLines.length > 0) {
        fail(`Hardcoded unlock threshold detected in engine: ${value}`);
      }
    }
  }
}

try {
  validateBounds();
  validateOrdering();
  validateClarificationPolicy();
  validateEngineUsage();

  console.log('✔ Unlock policy validation passed (hardened).');
  process.exit(0);
} catch (err) {
  fail(err.message);
}