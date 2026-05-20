/**
 * DEGRADATION POLICY DRIFT VALIDATOR (HARDENED)
 *
 * Ensures:
 *  - Degradation thresholds follow invariant ordering
 *  - Confidence / variance / packet-loss values are within bounds
 *  - Threshold gaps are preserved
 *  - degradationStateEngine.js imports degradation-contract.js
 *  - No hardcoded degradation threshold literals exist in engine
 *
 * This script does NOT freeze implementation structure.
 */

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const CONTRACT_PATH = path.join(ROOT, 'ci/contracts/degradation-contract.js');
const ENGINE_PATH = path.join(ROOT, 'policy', 'degradationStateEngine.js');

if (!fs.existsSync(CONTRACT_PATH)) {
  console.error('❌ degradation-contract.js not found.');
  process.exit(1);
}

const contract = require(CONTRACT_PATH);

function fail(message) {
  console.error(`❌ Degradation policy drift detected: ${message}`);
  process.exit(1);
}

/**
 * 1️⃣ Validate confidence thresholds
 */
function validateConfidenceThresholds() {
  const { CONFIDENCE_THRESHOLDS, INVARIANTS } = contract;

  if (!CONFIDENCE_THRESHOLDS) {
    fail('CONFIDENCE_THRESHOLDS missing from degradation-contract.');
  }

  const { NORMAL_MIN_AVG, DEGRADED_MIN_AVG, SEVERE_MIN_AVG } =
    CONFIDENCE_THRESHOLDS;

  [NORMAL_MIN_AVG, DEGRADED_MIN_AVG, SEVERE_MIN_AVG].forEach((v) => {
    if (typeof v !== 'number') fail('Confidence thresholds must be numeric.');
    if (v < INVARIANTS.CONFIDENCE_MIN || v > INVARIANTS.CONFIDENCE_MAX) {
      fail(`Confidence threshold out of bounds: ${v}`);
    }
  });

  if (INVARIANTS.ENFORCE_CONFIDENCE_ORDERING) {
    if (
      !(
        NORMAL_MIN_AVG > DEGRADED_MIN_AVG &&
        DEGRADED_MIN_AVG > SEVERE_MIN_AVG
      )
    ) {
      fail(
        'Confidence thresholds must satisfy NORMAL > DEGRADED > SEVERE'
      );
    }
  }

  if (INVARIANTS.ENFORCE_THRESHOLD_GAP) {
    const gap1 = NORMAL_MIN_AVG - DEGRADED_MIN_AVG;
    const gap2 = DEGRADED_MIN_AVG - SEVERE_MIN_AVG;

    if (
      gap1 < INVARIANTS.MIN_CONFIDENCE_GAP ||
      gap2 < INVARIANTS.MIN_CONFIDENCE_GAP
    ) {
      fail(
        'Confidence threshold gaps too small — risk of collapse between states.'
      );
    }
  }
}

/**
 * 2️⃣ Validate variance thresholds
 */
function validateVarianceThresholds() {
  const { VARIANCE_THRESHOLDS, INVARIANTS } = contract;

  if (!VARIANCE_THRESHOLDS) {
    fail('VARIANCE_THRESHOLDS missing from degradation-contract.');
  }

  const { DEGRADED_MIN_VARIANCE, SEVERE_MIN_VARIANCE } =
    VARIANCE_THRESHOLDS;

  [DEGRADED_MIN_VARIANCE, SEVERE_MIN_VARIANCE].forEach((v) => {
    if (typeof v !== 'number') fail('Variance thresholds must be numeric.');
  });

  if (INVARIANTS.ENFORCE_VARIANCE_ORDERING) {
    if (!(SEVERE_MIN_VARIANCE > DEGRADED_MIN_VARIANCE)) {
      fail('Variance thresholds must satisfy SEVERE > DEGRADED');
    }
  }
}

/**
 * 3️⃣ Validate packet loss thresholds
 */
function validatePacketLossThresholds() {
  const { PACKET_LOSS_THRESHOLDS, INVARIANTS } = contract;

  if (!PACKET_LOSS_THRESHOLDS) {
    fail('PACKET_LOSS_THRESHOLDS missing from degradation-contract.');
  }

  const { DEGRADED_MIN, SEVERE_MIN } = PACKET_LOSS_THRESHOLDS;

  [DEGRADED_MIN, SEVERE_MIN].forEach((v) => {
    if (typeof v !== 'number') fail('Packet loss thresholds must be numeric.');
    if (v < 0 || v > 1)
      fail('Packet loss thresholds must be within 0–1 range.');
  });

  if (INVARIANTS.ENFORCE_PACKETLOSS_ORDERING) {
    if (!(SEVERE_MIN > DEGRADED_MIN)) {
      fail('Packet loss thresholds must satisfy SEVERE > DEGRADED');
    }
  }
}

/**
 * 4️⃣ Validate engine usage
 */
function validateEngineUsage() {
  if (!fs.existsSync(ENGINE_PATH)) {
    fail(
      'degradationStateEngine.js not found — engine location must be updated in validator.'
    );
  }

  const content = fs.readFileSync(ENGINE_PATH, 'utf8');

  // Must import degradation-contract
  const importRegex = /require\((['"]).*degradation-contract.*\1\)/;
  if (!importRegex.test(content)) {
    fail('degradationStateEngine.js must require degradation-contract.js');
  }

  // Must reference contract thresholds
  if (!content.includes('CONFIDENCE_THRESHOLDS')) {
    fail(
      'degradationStateEngine.js must reference CONFIDENCE_THRESHOLDS from contract'
    );
  }

  // Detect hardcoded threshold literals (basic guard)
  const hardcodedValues = [
    ...Object.values(contract.CONFIDENCE_THRESHOLDS),
    ...Object.values(contract.VARIANCE_THRESHOLDS),
    ...Object.values(contract.PACKET_LOSS_THRESHOLDS)
  ];

  for (const value of hardcodedValues) {
    const literalRegex = new RegExp(`[^A-Za-z0-9_]${value}[^A-Za-z0-9_]`);
    if (literalRegex.test(content)) {
      fail(`Hardcoded degradation threshold detected in engine: ${value}. Engine must use contract constants only.`);
    }
  }
}

try {
  validateConfidenceThresholds();
  validateVarianceThresholds();
  validatePacketLossThresholds();
  validateEngineUsage();

  console.log('✔ Degradation policy validation passed (hardened).');
  process.exit(0);
} catch (err) {
  fail(err.message);
}