'use strict';

const {
    isWithinCallingWindow,
    getTimezoneForPhone,
    evaluateCallingWindow,
} = require('../services/callingWindowCheck');

describe('callingWindowCheck', () => {
    const ORIG_ENV = process.env.CALLING_WINDOW_ENABLED;

    afterEach(() => {
        if (ORIG_ENV === undefined) delete process.env.CALLING_WINDOW_ENABLED;
        else process.env.CALLING_WINDOW_ENABLED = ORIG_ENV;
    });

    // ── getTimezoneForPhone ────────────────────────────────────────────────

    describe('getTimezoneForPhone', () => {
        test('returns IANA tz for known US area code (213 → Los Angeles)', () => {
            expect(getTimezoneForPhone('+12135551234')).toBe('America/Los_Angeles');
        });

        test('returns IANA tz for NY area code (212)', () => {
            expect(getTimezoneForPhone('+12125551234')).toBe('America/New_York');
        });

        test('returns IANA tz for Chicago area code (312)', () => {
            expect(getTimezoneForPhone('+13125551234')).toBe('America/Chicago');
        });

        test('returns IANA tz for Hawaii area code (808)', () => {
            expect(getTimezoneForPhone('+18085551234')).toBe('Pacific/Honolulu');
        });

        test('returns null for non-NANP number (UK)', () => {
            expect(getTimezoneForPhone('+441614960000')).toBeNull();
        });

        test('returns null for null input', () => {
            expect(getTimezoneForPhone(null)).toBeNull();
        });

        test('returns null for too-short number', () => {
            expect(getTimezoneForPhone('+1212')).toBeNull();
        });

        test('returns null for overlong NANP number', () => {
            expect(getTimezoneForPhone('+121355512345')).toBeNull();
        });
    });

    // ── isWithinCallingWindow (feature flag explicitly OFF) ────────────────

    describe('when CALLING_WINDOW_ENABLED is explicitly false', () => {
        beforeEach(() => {
            process.env.CALLING_WINDOW_ENABLED = 'false';
        });

        test('always returns true regardless of time', () => {
            const midnight = new Date('2026-01-15T05:00:00Z'); // midnight PT
            expect(isWithinCallingWindow('+12135551234', midnight)).toBe(true);
        });

        test('always returns true for unknown area code', () => {
            expect(isWithinCallingWindow('+19995551234')).toBe(true);
        });

        test('returns disabled decision when enforcement is off', () => {
            expect(evaluateCallingWindow('+19995551234')).toMatchObject({
                allowed: true,
                reason: 'disabled',
                enforcementEnabled: false,
            });
        });
    });

    // ── isWithinCallingWindow (feature flag ON) ────────────────────────────

    describe('when CALLING_WINDOW_ENABLED is unset (default-on)', () => {
        beforeEach(() => {
            delete process.env.CALLING_WINDOW_ENABLED;
        });

        test('enforces the calling window by default', () => {
            const sevenAmPT = new Date('2026-07-15T14:00:00Z'); // 7 AM PDT
            expect(isWithinCallingWindow('+12135551234', sevenAmPT)).toBe(false);
        });
    });

    describe('when CALLING_WINDOW_ENABLED is true', () => {
        beforeEach(() => {
            process.env.CALLING_WINDOW_ENABLED = 'true';
        });

        test('returns true at 9 AM PT (within window)', () => {
            // 9 AM PT = 17:00 UTC in PDT (UTC-7) on a summer day
            const nineAmPT = new Date('2026-07-15T16:00:00Z'); // 9 AM PDT
            expect(isWithinCallingWindow('+12135551234', nineAmPT)).toBe(true);
        });

        test('returns true at 8 PM PT (within window, hour=20)', () => {
            // 8 PM PT = 03:00 UTC next day in PDT (UTC-7)
            const eightPmPT = new Date('2026-07-16T03:00:00Z'); // 8 PM PDT
            expect(isWithinCallingWindow('+12135551234', eightPmPT)).toBe(true);
        });

        test('returns false at 9 PM PT (outside window, hour=21)', () => {
            // 9 PM PT = 04:00 UTC next day in PDT (UTC-7)
            const ninePmPT = new Date('2026-07-16T04:00:00Z'); // 9 PM PDT
            expect(isWithinCallingWindow('+12135551234', ninePmPT)).toBe(false);
        });

        test('returns false at 7 AM PT (before window, hour=7)', () => {
            // 7 AM PT = 14:00 UTC in PDT (UTC-7)
            const sevenAmPT = new Date('2026-07-15T14:00:00Z'); // 7 AM PDT
            expect(isWithinCallingWindow('+12135551234', sevenAmPT)).toBe(false);
        });

        test('returns true at 8 AM PT exactly (boundary open hour)', () => {
            // 8 AM PT = 15:00 UTC in PDT (UTC-7)
            const eightAmPT = new Date('2026-07-15T15:00:00Z'); // 8 AM PDT
            expect(isWithinCallingWindow('+12135551234', eightAmPT)).toBe(true);
        });

        test('returns false for unknown NANP area code (fail-closed)', () => {
            const midnight = new Date('2026-01-15T05:00:00Z');
            expect(isWithinCallingWindow('+19995551234', midnight)).toBe(false);
            expect(evaluateCallingWindow('+19995551234', midnight)).toMatchObject({
                allowed: false,
                reason: 'unknown_nanp_timezone',
                areaCode: '999',
            });
        });

        test('returns invalid decision for overlong NANP number', () => {
            const noonPT = new Date('2026-07-15T19:00:00Z');
            expect(evaluateCallingWindow('+121355512345', noonPT)).toMatchObject({
                allowed: false,
                reason: 'invalid_nanp_number',
                areaCode: null,
            });
        });

        test('allows non-NANP number as not applicable', () => {
            const midnight = new Date('2026-01-15T05:00:00Z');
            expect(isWithinCallingWindow('+441614960000', midnight)).toBe(true);
            expect(evaluateCallingWindow('+441614960000', midnight)).toMatchObject({
                allowed: true,
                reason: 'not_applicable_non_nanp',
            });
        });

        test('returns decision metadata for known NANP number', () => {
            const tenAmET = new Date('2026-07-15T14:00:00Z');
            expect(evaluateCallingWindow('+12125551234', tenAmET)).toMatchObject({
                allowed: true,
                reason: 'within_calling_window',
                timezone: 'America/New_York',
                hour: 10,
                areaCode: '212',
            });
        });

        test('ET number: returns true at 10 AM ET', () => {
            // 10 AM ET = 15:00 UTC in summer (EDT = UTC-4) — wait, 10 AM EDT = 14:00 UTC
            const tenAmET = new Date('2026-07-15T14:00:00Z'); // 10 AM EDT
            expect(isWithinCallingWindow('+12125551234', tenAmET)).toBe(true);
        });

        test('ET number: returns false at 10 PM ET', () => {
            // 10 PM EDT = 02:00 UTC next day
            const tenPmET = new Date('2026-07-16T02:00:00Z'); // 10 PM EDT
            expect(isWithinCallingWindow('+12125551234', tenPmET)).toBe(false);
        });
    });
});
