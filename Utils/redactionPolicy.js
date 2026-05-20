'use strict';

const FALSE_VALUES = new Set(['false', '0', 'off', 'no', 'disabled']);
const TRUE_VALUES = new Set(['true', '1', 'on', 'yes', 'enabled']);

function readBooleanEnv(name, defaultValue) {
    const raw = process.env[name];
    if (raw == null || String(raw).trim() === '') return defaultValue;

    const normalized = String(raw).trim().toLowerCase();
    if (FALSE_VALUES.has(normalized)) return false;
    if (TRUE_VALUES.has(normalized)) return true;
    return defaultValue;
}

function isCallContentRedactionEnabled() {
    return readBooleanEnv('VOICEBOT_REDACT_CALL_CONTENT', true);
}

module.exports = {
    isCallContentRedactionEnabled,
    readBooleanEnv
};