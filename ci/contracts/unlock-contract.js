/**
 * UNLOCK CONTRACT (INVARIANT-SAFE, NON-DUPLICATED)
 *
 * Defines numeric behavioral invariants for unlock logic.
 *
 * IMPORTANT:
 * - Unlock thresholds exist in ONE place only (SCORE_THRESHOLDS).
 * - SCORE_BANDS must NOT duplicate unlock thresholds.
 * - Validators must enforce relational invariants.
 */

module.exports = {

  /**
   * Canonical degradation state enum used across engines.
   * This prevents drift between scoring engines and validators.
   */
  DEGRADATION_STATE: {
    NORMAL: 'NORMAL',
    DEGRADED: 'DEGRADED',
    SEVERE: 'SEVERE'
  },

  /**
   * Primary unlock thresholds by degradation state
   * (Score scale assumed 0–100 unless explicitly changed)
   */
  SCORE_THRESHOLDS: {
    NORMAL: 65,
    DEGRADED: 75,
    SEVERE: 90
  },

  /**
   * Severe-state confidence requirement
   */
  SEVERE_MIN_CONFIDENCE: 0.85,

  /**
   * Clarification governance
   */
  CLARIFICATION_POLICY: {
    MAX_CLARIFICATIONS: 2,
    ENABLE_CLARIFICATION: true
  },

  /**
   * Clarification score bands ONLY.
   * Unlock minimums must be read from SCORE_THRESHOLDS.
   */
  SCORE_BANDS: {
    NORMAL_CLARIFY_MIN: 45,
    DEGRADED_CLARIFY_MIN: 50
  },

  /**
   * Relational invariants to be validated in CI.
   * These prevent threshold drift and logical inversion.
   */
  INVARIANTS: {
    ENFORCE_ORDERING: true,   // NORMAL < DEGRADED < SEVERE
    SCORE_MIN: 0,
    SCORE_MAX: 100,
    REQUIRE_SEVERE_CONFIDENCE: true,
    REQUIRE_CLARIFY_BELOW_UNLOCK: true // clarify thresholds must remain below unlock thresholds
  },

  /**
   * Compatibility layer for engines expecting UNLOCK_THRESHOLDS.
   * These values are derived from the canonical contract fields above.
   */
  UNLOCK_THRESHOLDS: {
    get NORMAL_UNLOCK() { return module.exports.SCORE_THRESHOLDS.NORMAL; },
    get NORMAL_CLARIFY_MIN() { return module.exports.SCORE_BANDS.NORMAL_CLARIFY_MIN; },

    get DEGRADED_UNLOCK() { return module.exports.SCORE_THRESHOLDS.DEGRADED; },
    get DEGRADED_CLARIFY_MIN() { return module.exports.SCORE_BANDS.DEGRADED_CLARIFY_MIN; },

    get SEVERE_SCORE() { return module.exports.SCORE_THRESHOLDS.SEVERE; },
    get SEVERE_CONFIDENCE() { return module.exports.SEVERE_MIN_CONFIDENCE; }
  }

};
Object.freeze(module.exports);