/**
 * Phase 4 — Conversational Intelligence & Reliability Layer
 * Feature flags and profile selection. Config only; no I/O, no hot-path logic.
 * Phase 4 MUST NOT modify: InteractionMode, EdgeSession, Turn/Epoch, Phase 3 latency model.
 */

/** Global kill switch. If false, all Phase 4 modules are disabled (no guardrails, no persona, no escalation). */
const PHASE4_ENABLED = process.env.PHASE4_ENABLED === 'true';

/** Profile selection at call start. Config-driven; immutable during call. No dynamic switching. */
const PHASE4_PROFILE_NAME = (process.env.PHASE4_PROFILE || 'balanced').toLowerCase();
const ALLOWED_PROFILES = ['structured', 'balanced', 'rapid'];

function getPhase4ProfileName() {
    const name = PHASE4_PROFILE_NAME;
    return ALLOWED_PROFILES.includes(name) ? name : 'balanced';
}

module.exports = {
    PHASE4_ENABLED,
    getPhase4ProfileName,
    ALLOWED_PROFILES
};
