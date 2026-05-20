'use strict';

jest.mock('../repositories/SuppressionRepository', () => ({ isSuppressed: jest.fn() }));
jest.mock('../repositories/ConsentRepository', () => ({ hasValidConsent: jest.fn() }));
jest.mock('../Utils/telemetry', () => ({ emit: jest.fn() }));

const SuppressionRepository = require('../repositories/SuppressionRepository');
const ConsentRepository = require('../repositories/ConsentRepository');
const telemetry = require('../Utils/telemetry');
const { evaluateOutboundCallCompliance } = require('../services/outboundCallCompliance');

describe('outboundCallCompliance', () => {
    const ORIGINAL_ENV = {
        CALLING_WINDOW_ENABLED: process.env.CALLING_WINDOW_ENABLED,
        CONSENT_CHECK_ENABLED: process.env.CONSENT_CHECK_ENABLED,
        COMPLIANCE_BYPASS: process.env.COMPLIANCE_BYPASS,
        NODE_ENV: process.env.NODE_ENV,
    };
    let warnSpy;

    beforeEach(() => {
        jest.clearAllMocks();
        warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        process.env.CALLING_WINDOW_ENABLED = 'true';
        process.env.CONSENT_CHECK_ENABLED = 'false';
        process.env.NODE_ENV = 'test';
        delete process.env.COMPLIANCE_BYPASS;
        SuppressionRepository.isSuppressed.mockResolvedValue(false);
        ConsentRepository.hasValidConsent.mockResolvedValue(true);
    });

    afterEach(() => {
        warnSpy.mockRestore();
        for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });

    test('blocks suppressed numbers and never bypasses DNC', async () => {
        process.env.COMPLIANCE_BYPASS = 'true';
        SuppressionRepository.isSuppressed.mockResolvedValue(true);

        const result = await evaluateOutboundCallCompliance({
            phoneNumber: '+12135551234',
            persona: 'company-sales',
            language: 'en',
            now: new Date('2026-07-15T16:00:00Z'),
        });

        expect(result).toMatchObject({
            allowed: false,
            statusCode: 403,
            reason: 'suppressed',
        });
        expect(ConsentRepository.hasValidConsent).not.toHaveBeenCalled();
        expect(telemetry.emit).toHaveBeenCalledWith('compliance_gate_decision', expect.objectContaining({
            gate: 'suppression',
            allowed: false,
            reason: 'suppressed',
            blocking: true,
            bypassed: false,
        }));
    });

    test('fails closed when suppression lookup fails', async () => {
        SuppressionRepository.isSuppressed.mockRejectedValue(new Error('db unavailable'));

        const result = await evaluateOutboundCallCompliance({
            phoneNumber: '+12135551234',
            persona: 'company-sales',
            language: 'en',
            now: new Date('2026-07-15T16:00:00Z'),
        });

        expect(result).toMatchObject({
            allowed: false,
            statusCode: 503,
            reason: 'suppression_check_failed',
            error: 'Compliance check unavailable: suppression',
        });
    });

    test('blocks missing consent when consent ledger is enabled', async () => {
        process.env.CONSENT_CHECK_ENABLED = 'true';
        ConsentRepository.hasValidConsent.mockResolvedValue(false);

        const result = await evaluateOutboundCallCompliance({
            phoneNumber: '+12135551234',
            persona: 'company-sales',
            language: 'en',
            now: new Date('2026-07-15T16:00:00Z'),
        });

        expect(result).toMatchObject({
            allowed: false,
            statusCode: 403,
            reason: 'consent_missing',
        });
        expect(telemetry.emit).toHaveBeenCalledWith('compliance_gate_decision', expect.objectContaining({
            gate: 'consent_ledger',
            allowed: false,
            reason: 'consent_missing',
            blocking: true,
        }));
    });

    test('fails closed when consent lookup fails', async () => {
        process.env.CONSENT_CHECK_ENABLED = 'true';
        ConsentRepository.hasValidConsent.mockRejectedValue(new Error('ledger down'));

        const result = await evaluateOutboundCallCompliance({
            phoneNumber: '+12135551234',
            persona: 'company-sales',
            language: 'en',
            now: new Date('2026-07-15T16:00:00Z'),
        });

        expect(result).toMatchObject({
            allowed: false,
            statusCode: 503,
            reason: 'consent_check_failed',
            error: 'Compliance check unavailable: consent ledger',
        });
    });

    test('blocks unknown NANP timezone instead of failing open', async () => {
        const result = await evaluateOutboundCallCompliance({
            phoneNumber: '+19995551234',
            persona: 'company-sales',
            language: 'en',
            now: new Date('2026-07-15T16:00:00Z'),
        });

        expect(result).toMatchObject({
            allowed: false,
            statusCode: 403,
            reason: 'unknown_nanp_timezone',
        });
    });

    test('blocks overlong NANP numbers instead of evaluating a partial area code', async () => {
        const result = await evaluateOutboundCallCompliance({
            phoneNumber: '+121355512345',
            persona: 'company-sales',
            language: 'en',
            now: new Date('2026-07-15T16:00:00Z'),
        });

        expect(result).toMatchObject({
            allowed: false,
            statusCode: 403,
            reason: 'invalid_nanp_number',
        });
        expect(result.decisions).toEqual(expect.arrayContaining([
            expect.objectContaining({ gate: 'calling_window', reason: 'invalid_nanp_number', blocking: true }),
        ]));
    });

    test('allows non-NANP demo numbers without US calling-window or recording-consent blocks', async () => {
        const result = await evaluateOutboundCallCompliance({
            phoneNumber: '+919165551234',
            persona: 'company-sales',
            language: 'en',
            now: new Date('2026-07-15T16:00:00Z'),
        });

        expect(result).toMatchObject({
            allowed: true,
            requireExplicitRecordingConsent: false,
        });
        expect(result.decisions).toEqual(expect.arrayContaining([
            expect.objectContaining({ gate: 'calling_window', allowed: true, reason: 'not_applicable_non_nanp' }),
            expect.objectContaining({ gate: 'recording_consent', allowed: true, reason: 'not_applicable_non_nanp' }),
        ]));
    });

    test('requires explicit recording acknowledgment for known two-party states', async () => {
        const result = await evaluateOutboundCallCompliance({
            phoneNumber: '+12135551234',
            persona: 'company-sales',
            language: 'en',
            now: new Date('2026-07-15T16:00:00Z'),
        });

        expect(result).toMatchObject({
            allowed: true,
            requireExplicitRecordingConsent: true,
        });
        expect(result.decisions).toEqual(expect.arrayContaining([
            expect.objectContaining({
                gate: 'recording_consent',
                reason: 'two_party_state',
                state: 'CA',
                requireExplicitRecordingConsent: true,
            }),
        ]));
    });

    test('requires explicit recording acknowledgment for unknown NANP consent state when window is disabled', async () => {
        process.env.CALLING_WINDOW_ENABLED = 'false';

        const result = await evaluateOutboundCallCompliance({
            phoneNumber: '+19995551234',
            persona: 'company-sales',
            language: 'en',
        });

        expect(result).toMatchObject({
            allowed: true,
            requireExplicitRecordingConsent: true,
        });
        expect(result.decisions).toEqual(expect.arrayContaining([
            expect.objectContaining({ gate: 'recording_consent', reason: 'unknown_nanp_area' }),
        ]));
    });

    test('non-production bypass allows consent gate blocks with warning telemetry', async () => {
        process.env.CONSENT_CHECK_ENABLED = 'true';
        process.env.COMPLIANCE_BYPASS = 'true';
        ConsentRepository.hasValidConsent.mockResolvedValue(false);

        const result = await evaluateOutboundCallCompliance({
            phoneNumber: '+12135551234',
            persona: 'company-sales',
            language: 'en',
            now: new Date('2026-07-15T16:00:00Z'),
        });

        expect(result.allowed).toBe(true);
        expect(result.decisions).toEqual(expect.arrayContaining([
            expect.objectContaining({ gate: 'compliance_bypass', allowed: true, reason: 'enabled_non_production' }),
            expect.objectContaining({ gate: 'consent_ledger', allowed: true, reason: 'consent_missing_bypassed', bypassed: true }),
        ]));
    });

    test('production rejects bypass and still blocks consent gate failures', async () => {
        process.env.CONSENT_CHECK_ENABLED = 'true';
        process.env.COMPLIANCE_BYPASS = 'true';
        process.env.NODE_ENV = 'production';
        ConsentRepository.hasValidConsent.mockResolvedValue(false);

        const result = await evaluateOutboundCallCompliance({
            phoneNumber: '+12135551234',
            persona: 'company-sales',
            language: 'en',
            now: new Date('2026-07-15T16:00:00Z'),
        });

        expect(result).toMatchObject({
            allowed: false,
            reason: 'consent_missing',
        });
        expect(result.decisions).toEqual(expect.arrayContaining([
            expect.objectContaining({ gate: 'compliance_bypass', allowed: false, reason: 'production_rejected' }),
        ]));
    });
});
