'use strict';

describe('telemetry redaction before sinks', () => {
    const ORIGINAL_REDACT_CALL_CONTENT = process.env.VOICEBOT_REDACT_CALL_CONTENT;

    afterEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
        if (ORIGINAL_REDACT_CALL_CONTENT === undefined) delete process.env.VOICEBOT_REDACT_CALL_CONTENT;
        else process.env.VOICEBOT_REDACT_CALL_CONTENT = ORIGINAL_REDACT_CALL_CONTENT;
    });

    test('redacts transcript and email payloads before logger.emit', () => {
        delete process.env.VOICEBOT_REDACT_CALL_CONTENT;
        jest.doMock('../Utils/logger', () => ({ emit: jest.fn() }));

        const logger = require('../Utils/logger');
        const telemetry = require('../Utils/telemetry');

        telemetry.emit('email_extracted', {
            callId: 'call-redact',
            email: 'caller@example.com',
            transcript: 'Please call 555 123 4567 and email caller@example.com',
        });

        expect(logger.emit).toHaveBeenCalledTimes(1);
        const [, callId, turnId, payload] = logger.emit.mock.calls[0];
        expect(callId).toBe('call-redact');
        expect(turnId).toBeNull();
        expect(payload.email).toBe('[redacted_email]');
        expect(payload.transcript).toMatch(/^\[redacted_text hash=/);
        expect(JSON.stringify(payload)).not.toContain('caller@example.com');
        expect(JSON.stringify(payload)).not.toContain('555 123 4567');
    });

    test('honors explicit call-content redaction disable for validation runs', () => {
        process.env.VOICEBOT_REDACT_CALL_CONTENT = 'false';
        jest.doMock('../Utils/logger', () => ({ emit: jest.fn() }));

        const logger = require('../Utils/logger');
        const telemetry = require('../Utils/telemetry');

        telemetry.emit('email_extracted', {
            callId: 'call-validation',
            email: 'caller@example.com',
            transcript: 'Please call 555 123 4567',
        });

        const payload = logger.emit.mock.calls[0][3];
        expect(payload.email).toBe('caller@example.com');
        expect(payload.transcript).toBe('Please call 555 123 4567');
    });
});
