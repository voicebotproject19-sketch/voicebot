/**
 * DEGRADATION CONTRACT (INVARIANT-SAFE)
 *
 * Defines numeric behavioral invariants for degradation state transitions.
 *
 * IMPORTANT:
 * - This freezes threshold behavior, NOT implementation structure.
 * - State transition ordering must be validated in CI.
 * - Do NOT duplicate values in engine logic.
 */

module.exports = {

  /**
   * Canonical degradation state enum (single source of truth with unlock-contract).
   */
  DEGRADATION_STATE: {
    NORMAL: 'NORMAL',
    DEGRADED: 'DEGRADED',
    SEVERE: 'SEVERE'
  },

  /**
   * Confidence-based thresholds (rolling average)
   */
  CONFIDENCE_THRESHOLDS: {
    NORMAL_MIN_AVG: 0.78,
    DEGRADED_MIN_AVG: 0.75,
    SEVERE_MIN_AVG: 0.68
  },

  /**
   * Confidence variance thresholds
   * (Measures instability in rolling window)
   */
  VARIANCE_THRESHOLDS: {
    DEGRADED_MIN_VARIANCE: 0.20,
    SEVERE_MIN_VARIANCE: 0.30
  },

  /**
   * Packet loss thresholds (optional input)
   */
  PACKET_LOSS_THRESHOLDS: {
    DEGRADED_MIN: 0.15,
    SEVERE_MIN: 0.25
  },

  /**
   * Recovery hysteresis thresholds
   * Used to prevent NORMAL <-> DEGRADED oscillation (ping-pong)
   */
  RECOVERY_THRESHOLDS: {
    NORMAL_RECOVERY_AVG: 0.80,
    NORMAL_RECOVERY_VARIANCE: 0.12
  },

  /**
   * Empty / truncated transcript triggers
   */
  TRANSCRIPT_SIGNALS: {
    EMPTY_COUNT_SEVERE: 2,          // Two consecutive empty transcripts
    TRUNCATED_WINDOW_MS: 3000,      // Sliding time window
    TRUNCATED_COUNT_DEGRADED: 2,    // Within window

    // Guard against single noise spikes forcing SEVERE degradation
    SEVERE_CONFIRMATION_COUNT: 2
  },

  /**
   * Rolling history configuration
   */
  HISTORY_WINDOW: {
    TRANSCRIPT_COUNT: 3,    // last N transcripts
    CONFIDENCE_COUNT: 5     // last N confidence values
  },

  /**
   * Stability reset configuration
   */
  RESET_POLICY: {
    STABLE_COUNT_REQUIRED: 5
  },

  /**
   * Compatibility exports required by degradationStateEngine.js
   * These map the structured config above to the flat fields used by the engine.
   */

  CONFIDENCE_HISTORY_SIZE: 5,
  TRANSCRIPT_HISTORY_SIZE: 3,
  TRUNCATED_WINDOW_MS: 3000,
  STABLE_CONSECUTIVE_FOR_RESET: 5,

  /**
   * Relational invariants enforced in CI
   */
  INVARIANTS: {
    ENFORCE_CONFIDENCE_ORDERING: true,   // NORMAL > DEGRADED > SEVERE
    ENFORCE_VARIANCE_ORDERING: true,     // SEVERE > DEGRADED
    ENFORCE_PACKETLOSS_ORDERING: true,   // SEVERE > DEGRADED

    // Ensure thresholds remain within valid confidence scale
    CONFIDENCE_MIN: 0,
    CONFIDENCE_MAX: 1,

    // Prevent collapse of threshold gaps
    ENFORCE_THRESHOLD_GAP: true,
    MIN_CONFIDENCE_GAP: 0.02
  }

};