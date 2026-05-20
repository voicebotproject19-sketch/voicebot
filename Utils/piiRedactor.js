'use strict';

// PII patterns — reuses phone/email patterns from structuredLogger.js
// and adds SSN + credit card detection.

const PHONE_REGEX = /\+?\d[\d\s().-]{6,}\d/g;
const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const SSN_REGEX = /\b\d{3}-\d{2}-\d{4}\b/g;
// 13-19 consecutive digits (optionally separated by spaces/dashes) — common card formats
const CC_REGEX = /\b(?:\d[ -]*?){13,19}\b/g;

/**
 * Luhn check — validates whether a digit string is a plausible card number.
 */
function passesLuhn(digits) {
    let sum = 0;
    let alt = false;
    for (let i = digits.length - 1; i >= 0; i--) {
        let n = parseInt(digits[i], 10);
        if (alt) {
            n *= 2;
            if (n > 9) n -= 9;
        }
        sum += n;
        alt = !alt;
    }
    return sum % 10 === 0;
}

/**
 * Redact PII from a string value.
 * Intended for use on user-facing content before DB persistence.
 */
function redactPII(text) {
    if (typeof text !== 'string' || !text) return text;

    let out = text;
    out = out.replace(SSN_REGEX, '[REDACTED_SSN]');
    out = out.replace(CC_REGEX, (match) => {
        const digits = match.replace(/\D/g, '');
        if (digits.length >= 13 && digits.length <= 19 && passesLuhn(digits)) {
            return '[REDACTED_CC]';
        }
        return match;
    });
    out = out.replace(EMAIL_REGEX, '[REDACTED_EMAIL]');
    out = out.replace(PHONE_REGEX, '[REDACTED_PHONE]');
    return out;
}

module.exports = { redactPII };
