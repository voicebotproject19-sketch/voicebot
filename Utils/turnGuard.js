function assertTurnActive(turnState, expectedTurnId) {

    // Turn state must exist and be an object
    if (!turnState || typeof turnState !== "object") return false;

    // Turn must not be closed
    if (turnState.isClosed === true) return false;

    // Defensive guard: ensure turnId property exists
    if (!("currentTurnId" in turnState)) return false;

    // Expected turn id must be provided
    if (typeof expectedTurnId !== "string" && typeof expectedTurnId !== "number") {
        return false;
    }

    // Turn must match the scheduled turn
    if (turnState.currentTurnId !== expectedTurnId) return false;

    return true;
}

module.exports = { assertTurnActive };