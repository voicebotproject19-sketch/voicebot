'use strict';
const areaCodeMeta = require('../data/areaCodeMeta.json');

/**
 * TCPA-compliant calling window: 8:00 AM – 9:00 PM in the called party's local timezone.
 *
 * Enabled by default for compliance safety.
 * Set CALLING_WINDOW_ENABLED=false to explicitly disable enforcement.
 */
const WINDOW_OPEN_HOUR  = 8;   // inclusive
const WINDOW_CLOSE_HOUR = 21;  // exclusive (calls not allowed at or after 9 PM)

function isCallingWindowEnabled() {
    const value = (process.env.CALLING_WINDOW_ENABLED || '').trim().toLowerCase();
    return value !== 'false';
}

function classifyNanpPhone(e164Phone) {
    if (typeof e164Phone !== 'string' || !e164Phone.trim()) {
        return { kind: 'invalid', areaCode: null };
    }

    if (!e164Phone.startsWith('+1')) {
        return { kind: 'non_nanp', areaCode: null };
    }

    const digits = e164Phone.replace(/^\+1/, '').replace(/\D/g, '');
    if (digits.length !== 10) {
        return { kind: 'invalid_nanp', areaCode: null };
    }

    return { kind: 'nanp', areaCode: digits.slice(0, 3) };
}

/**
 * Derive the IANA timezone for a NANP phone number from its area code.
 * Returns null for non-NANP or unknown area codes.
 *
 * @param {string} e164Phone  E.164 number, e.g. "+12135551234"
 * @returns {string|null}
 */
function getTimezoneForPhone(e164Phone) {
    const { kind, areaCode } = classifyNanpPhone(e164Phone);
    if (kind !== 'nanp') return null;
    return areaCodeMeta[areaCode]?.tz ?? null;
}

function evaluateCallingWindow(e164Phone, now = new Date()) {
    const enforcementEnabled = isCallingWindowEnabled();
    const base = {
        gate: 'calling_window',
        enforcementEnabled,
        timezone: null,
        hour: null,
        areaCode: null,
    };

    if (!enforcementEnabled) {
        return { ...base, allowed: true, reason: 'disabled' };
    }

    const { kind, areaCode } = classifyNanpPhone(e164Phone);
    if (kind === 'invalid') {
        return { ...base, allowed: false, reason: 'invalid_phone_number' };
    }
    if (kind === 'non_nanp') {
        return { ...base, allowed: true, reason: 'not_applicable_non_nanp' };
    }
    if (kind === 'invalid_nanp') {
        return { ...base, allowed: false, reason: 'invalid_nanp_number' };
    }

    const timezone = areaCodeMeta[areaCode]?.tz ?? null;
    if (!timezone) {
        return { ...base, allowed: false, reason: 'unknown_nanp_timezone', areaCode };
    }

    try {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: timezone,
            hour: '2-digit',
            hour12: false,
        }).formatToParts(now);
        const hourPart = parts.find(p => p.type === 'hour');
        if (!hourPart) {
            return { ...base, allowed: false, reason: 'calling_window_eval_failed', timezone, areaCode, error: 'hour_unavailable' };
        }

        const parsedHour = parseInt(hourPart.value, 10);
        if (!Number.isFinite(parsedHour)) {
            return { ...base, allowed: false, reason: 'calling_window_eval_failed', timezone, areaCode, error: 'hour_invalid' };
        }

        const hour = parsedHour % 24;
        const allowed = hour >= WINDOW_OPEN_HOUR && hour < WINDOW_CLOSE_HOUR;
        return {
            ...base,
            allowed,
            reason: allowed ? 'within_calling_window' : 'outside_calling_window',
            timezone,
            hour,
            areaCode,
        };
    } catch (err) {
        return {
            ...base,
            allowed: false,
            reason: 'calling_window_eval_failed',
            timezone,
            areaCode,
            error: err.message,
        };
    }
}

/**
 * Returns true when the current moment falls within the allowed calling window
 * for the destination phone number's timezone.
 *
 * Returns true unconditionally only when CALLING_WINDOW_ENABLED=false.
 * Returns false for unknown or invalid NANP numbers when enforcement is enabled.
 *
 * @param {string} e164Phone
 * @param {Date}   [now]      Injection point for testing; defaults to new Date()
 * @returns {boolean}
 */
function isWithinCallingWindow(e164Phone, now = new Date()) {
    return evaluateCallingWindow(e164Phone, now).allowed;
}

module.exports = { isWithinCallingWindow, getTimezoneForPhone, evaluateCallingWindow };
