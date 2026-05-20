const { assertTurnActive } = require('./turnGuard');

function epochTimeout(turnState, fn, delay) {

    if (!turnState || !turnState.currentTurnId) {
        return setTimeout(fn, delay);
    }

    const epoch = turnState.currentTurnId;

    return setTimeout(() => {

        if (!assertTurnActive(turnState, epoch)) return;

        fn(epoch);

    }, delay);
}

module.exports = { epochTimeout };
