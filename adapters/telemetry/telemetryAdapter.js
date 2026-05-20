/**
 * Telemetry Adapter
 *
 * Provides a vendor-neutral interface used by the logger.
 * Actual telemetry implementation is loaded dynamically.
 */

function getAdapterState() {
    if (!module.exports.__adapterState) {
        module.exports.__adapterState = {
            impl: null,
            initialized: false
        };
    }
    return module.exports.__adapterState;
}

function init() {
    const state = getAdapterState();
    if (state.initialized) return;
    state.initialized = true;

    if (process.env.JEST_WORKER_ID && process.env.VOICEBOT_TELEMETRY_AZURE_IN_JEST !== 'true') {
        state.impl = null;
        return;
    }

    try {
        state.impl = require("./azureTelemetryAdapter");
        if (state.impl && state.impl.init) {
            state.impl.init();
        }
    } catch (err) {
        console.warn("Telemetry adapter disabled:", err && err.message);
        state.impl = null;
    }
}

function emitBatch(events) {
    const state = getAdapterState();
    if (state.impl && state.impl.emitBatch) {
        try {
            state.impl.emitBatch(events);
        } catch (err) {
            console.error("Telemetry adapter emit error:", err && err.message);
        }
    }
}

function recordMetric(name, value, attributes) {
    const state = getAdapterState();
    if (state.impl && state.impl.recordMetric) {
        try {
            state.impl.recordMetric(name, value, attributes);
        } catch (err) {
            console.error("Telemetry adapter metric error:", err && err.message);
        }
    }
}

async function shutdown() {
    const state = getAdapterState();
    if (state.impl && state.impl.shutdown) {
        try {
            await state.impl.shutdown();
        } catch (err) {
            console.error("Telemetry adapter shutdown error:", err && err.message);
        }
    }
}

module.exports = {
    init,
    emitBatch,
    recordMetric,
    shutdown
};
