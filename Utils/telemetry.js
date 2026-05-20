const logger = require('./logger');
const EVENTS = require('./telemetryEvents');
const { sanitizeValue } = require('./structuredLogger');

function emit(event, payload = {}) {

    if (typeof event !== 'string') {
        throw new Error('Telemetry event must be a string');
    }

    payload = payload && typeof payload === 'object' ? payload : {};

    const connectionId =
        payload.connectionId ??
        payload.connectionID ??
        payload.connId ??
        null;

    const callId =
        payload.callId ??
        payload.callSID ??
        payload.callSid ??
        payload.sid ??
        null;

    const finalPayload = sanitizeValue({
        ...payload,
        connectionId,
        callId,
        ts: payload.ts ?? Date.now()
    });

    if (!EVENTS.has(event)) {
        console.warn('[Telemetry] Unknown event:', event);
    }

    try {
        return logger.emit(event, callId, null, finalPayload);
    } catch (err) {
        console.error('[Telemetry emit failed]', event, err);
    }
}
module.exports = { emit };
