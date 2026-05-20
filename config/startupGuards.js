'use strict';

const PORT_CLEANUP_DELAY_MS = 500;

function normalizeNodeEnv(env = process.env) {
    return String(env.NODE_ENV || '').trim().toLowerCase();
}

function isProductionEnv(env = process.env) {
    return normalizeNodeEnv(env) === 'production';
}

function shouldRunPortCleanup(env = process.env) {
    return !isProductionEnv(env);
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function runPortCleanupIfEnabled({
    env = process.env,
    port,
    cleanup,
    wait = delay,
    delayMs = PORT_CLEANUP_DELAY_MS,
} = {}) {
    if (!shouldRunPortCleanup(env)) {
        return { ran: false, reason: 'production' };
    }

    if (typeof cleanup !== 'function') {
        throw new Error('Port cleanup function is required');
    }

    await cleanup(port);

    if (delayMs > 0 && typeof wait === 'function') {
        await wait(delayMs);
    }

    return { ran: true, reason: 'enabled' };
}

module.exports = {
    PORT_CLEANUP_DELAY_MS,
    isProductionEnv,
    normalizeNodeEnv,
    runPortCleanupIfEnabled,
    shouldRunPortCleanup,
};
