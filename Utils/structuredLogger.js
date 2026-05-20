'use strict';

const crypto = require('crypto');
const { redactPII } = require('./piiRedactor');
const { isCallContentRedactionEnabled } = require('./redactionPolicy');

const PHONE_REGEX = /\+?\d[\d\s().-]{6,}\d/g;
const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const DEFAULT_DEBUG_TEXT_MAX_CHARS = 400;
const MAX_DEBUG_TEXT_MAX_CHARS = 2000;

function shortHash(value) {
    return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 12);
}

function maskPhone(match) {
    const digits = String(match).replace(/\D/g, '');
    if (digits.length < 8) return match;
    const visiblePrefix = digits.slice(0, 2);
    const visibleSuffix = digits.slice(-2);
    const maskedMiddle = '*'.repeat(Math.max(0, digits.length - 4));
    const prefix = String(match).trim().startsWith('+') ? '+' : '';
    return `${prefix}${visiblePrefix}${maskedMiddle}${visibleSuffix}`;
}

function isSensitiveTextKey(key) {
    return key.includes('transcript') ||
        key === 'text' ||
        key === 'content' ||
        key.includes('preview') ||
        key === 'actual' ||
        key === 'expected' ||
        key === 'phrase' ||
        key === 'slot' ||
        key.endsWith('slot') ||
        key.includes('question') ||
        key.includes('utterance');
}

function extractCallId(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const candidates = [
        value.callSID,
        value.callSid,
        value.callId,
        value.callID,
        value.callUUID,
        value.callUuid
    ];
    const match = candidates.find((candidate) => typeof candidate === 'string' && candidate.trim());
    return match ? match.trim() : null;
}

function getDebugTextCallIds() {
    return String(process.env.VOICEBOT_DEBUG_TEXT_CALL_IDS || process.env.VOICEBOT_DEBUG_CALL_IDS || '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);
}

function isDebugTextAllowed(context = {}) {
    if (process.env.VOICEBOT_DEBUG_TEXT_LOGS !== 'true') return false;
    const callId = String(context.callId || '').trim();
    if (!callId) return false;
    return getDebugTextCallIds().includes(callId);
}

function getDebugTextMaxChars() {
    const parsed = Number(process.env.VOICEBOT_DEBUG_TEXT_MAX_CHARS);
    if (!Number.isFinite(parsed)) return DEFAULT_DEBUG_TEXT_MAX_CHARS;
    return Math.max(0, Math.min(MAX_DEBUG_TEXT_MAX_CHARS, Math.floor(parsed)));
}

function sanitizeSensitiveText(text, context = {}) {
    if (!text) return '';
    if (!isCallContentRedactionEnabled()) return text;

    const hash = shortHash(text);
    const length = text.length;

    if (isDebugTextAllowed(context)) {
        const maxChars = getDebugTextMaxChars();
        const piiRedacted = redactPII(text);
        const truncated = piiRedacted.length > maxChars;
        const debugText = truncated ? piiRedacted.slice(0, maxChars) : piiRedacted;
        return `[debug_text hash=${hash} length=${length} pii=redacted truncated=${truncated}] ${debugText}`;
    }

    return `[redacted_text hash=${hash} length=${length}]`;
}

function sanitizeString(value, keyHint = '', context = {}) {
    const key = String(keyHint || '').toLowerCase();
    const text = String(value || '');

    if (!isCallContentRedactionEnabled()) return text;

    if (isSensitiveTextKey(key)) {
        return sanitizeSensitiveText(text, context);
    }

    const trimmed = text.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        try {
            return JSON.stringify(sanitizeValue(JSON.parse(trimmed), '', context));
        } catch (_) {
            // Fall through to scalar redaction for non-JSON strings.
        }
    }

    let out = text.replace(EMAIL_REGEX, '[redacted_email]');
    out = out.replace(PHONE_REGEX, (m) => maskPhone(m));
    return out;
}

function sanitizeValue(value, keyHint = '', context = {}) {
    if (value == null) return value;

    if (typeof value === 'string') {
        return sanitizeString(value, keyHint, context);
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
        return value;
    }

    if (Array.isArray(value)) {
        return value.map((item) => sanitizeValue(item, keyHint, context));
    }

    if (typeof value === 'object') {
        const callId = extractCallId(value) || context.callId || null;
        const childContext = callId ? { ...context, callId } : context;
        const redactEnabled = isCallContentRedactionEnabled();
        const out = {};
        for (const [key, objValue] of Object.entries(value)) {
            const normalized = key.toLowerCase();

            if (redactEnabled && normalized.includes('email')) {
                const emailAddressKey = normalized === 'email' ||
                    normalized === 'useremail' ||
                    normalized === 'oldemail' ||
                    normalized === 'newemail' ||
                    normalized.endsWith('emailaddress') ||
                    normalized === 'notificationemail' ||
                    normalized === 'ccemail';
                if (emailAddressKey && typeof objValue === 'string') {
                    out[key] = '[redacted_email]';
                } else {
                    out[key] = sanitizeValue(objValue, normalized, childContext);
                }
                continue;
            }

            if (redactEnabled && (
                normalized.includes('phone') ||
                normalized.includes('number') ||
                normalized === 'to' ||
                normalized === 'from' ||
                normalized.includes('recipient') ||
                normalized.includes('caller')
            )) {
                out[key] = sanitizeString(String(objValue || ''), 'phone', childContext);
                continue;
            }

            out[key] = sanitizeValue(objValue, normalized, childContext);
        }
        return out;
    }

    return String(value);
}

function installStructuredConsoleLogger() {
    if (console.__VOICEBOT_STRUCTURED_LOGGER_INSTALLED__) return;

    const original = {
        log: console.log.bind(console),
        warn: console.warn.bind(console),
        error: console.error.bind(console),
        info: (console.info || console.log).bind(console)
    };

    const emit = (level, args) => {
        const ts = new Date().toISOString();
        const first = args[0];
        const message = typeof first === 'string' ? sanitizeString(first) : 'log_event';

        let data = null;
        if (args.length === 1 && typeof first === 'object' && first !== null) {
            data = sanitizeValue(first);
        } else if (args.length > 1) {
            data = sanitizeValue(args.slice(1));
        }

        const record = {
            ts,
            level,
            message
        };

        if (data != null) {
            record.data = data;
        }

        const line = JSON.stringify(record);
        if (level === 'error') {
            original.error(line);
        } else if (level === 'warn') {
            original.warn(line);
        } else if (level === 'info') {
            original.info(line);
        } else {
            original.log(line);
        }
    };

    console.log = (...args) => emit('info', args);
    console.info = (...args) => emit('info', args);
    console.warn = (...args) => emit('warn', args);
    console.error = (...args) => emit('error', args);
    console.__VOICEBOT_STRUCTURED_LOGGER_INSTALLED__ = true;
}

module.exports = {
    installStructuredConsoleLogger,
    sanitizeValue,
    sanitizeString
};