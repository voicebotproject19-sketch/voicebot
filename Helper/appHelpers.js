const { assertTurnActive } = require('../Utils/turnGuard');

/**
 * Centralized audio safety gate used before any audio emission
 * @param {Object} turnState - Turn state object
 * @param {string} expectedTurnId - Expected turn ID
 * @returns {boolean} Whether audio emission is safe
 */
function assertAudioSafe(turnState, expectedTurnId) {
    if (!turnState) return false;
    if (turnState.isClosed === true) return false;
    return assertTurnActive(turnState, expectedTurnId);
}

/**
 * Epoch‑guarded timeout helper.
 * Captures the current turn epoch at scheduling time and prevents execution
 * if the turn has advanced. Used to eliminate turnEpoch drift in timers.
 * @param {Object} turnState - Turn state object
 * @param {Function} fn - Function to execute
 * @param {number} delay - Delay in milliseconds
 * @returns {NodeJS.Timeout} Timeout ID
 */
function epochGuardedTimeout(turnState, fn, delay) {
    const epoch = turnState.currentTurnId;
    return setTimeout(() => {
        if (!assertTurnActive(turnState, epoch)) return;
        fn(epoch);
    }, delay);
}

module.exports = {
    assertAudioSafe,
    epochGuardedTimeout
};
