'use strict';

const { sanitizeString, sanitizeValue } = require('../Utils/structuredLogger');

const ORIGINAL_DEBUG_TEXT_LOGS = process.env.VOICEBOT_DEBUG_TEXT_LOGS;
const ORIGINAL_DEBUG_TEXT_CALL_IDS = process.env.VOICEBOT_DEBUG_TEXT_CALL_IDS;
const ORIGINAL_DEBUG_CALL_IDS = process.env.VOICEBOT_DEBUG_CALL_IDS;
const ORIGINAL_DEBUG_TEXT_MAX_CHARS = process.env.VOICEBOT_DEBUG_TEXT_MAX_CHARS;
const ORIGINAL_REDACT_CALL_CONTENT = process.env.VOICEBOT_REDACT_CALL_CONTENT;

function restoreEnv(name, value) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}

describe('structured logger sanitization', () => {
    afterEach(() => {
        restoreEnv('VOICEBOT_DEBUG_TEXT_LOGS', ORIGINAL_DEBUG_TEXT_LOGS);
        restoreEnv('VOICEBOT_DEBUG_TEXT_CALL_IDS', ORIGINAL_DEBUG_TEXT_CALL_IDS);
        restoreEnv('VOICEBOT_DEBUG_CALL_IDS', ORIGINAL_DEBUG_CALL_IDS);
        restoreEnv('VOICEBOT_DEBUG_TEXT_MAX_CHARS', ORIGINAL_DEBUG_TEXT_MAX_CHARS);
        restoreEnv('VOICEBOT_REDACT_CALL_CONTENT', ORIGINAL_REDACT_CALL_CONTENT);
    });

    test('redacts transcript-like fields inside JSON string logs', () => {
        const raw = JSON.stringify({
            event: 'user_transcribed',
            transcript: 'My email is caller@example.com and my phone is 555 123 4567',
            nested: {
                preview: 'This is a sensitive preview value'
            }
        });

        const sanitized = sanitizeString(raw);

        expect(sanitized).toContain('redacted_text hash=');
        expect(sanitized).toContain('length=');
        expect(sanitized).not.toContain('caller@example.com');
        expect(sanitized).not.toContain('555 123 4567');
        expect(sanitized).not.toContain('sensitive preview');
    });

    test('redacts object text, actual, and question fields while preserving numeric status', () => {
        const sanitized = sanitizeValue({
            text: 'Book the call for me at caller@example.com',
            actual: 'Sure, I can send it to caller@example.com',
            userQuestion: 'Can you call me at 555 123 4567?',
            energy: 0.42,
            isResponding: false
        });

        expect(sanitized.text).toMatch(/^\[redacted_text hash=/);
        expect(sanitized.actual).toMatch(/^\[redacted_text hash=/);
        expect(sanitized.userQuestion).toMatch(/^\[redacted_text hash=/);
        expect(sanitized.energy).toBe(0.42);
        expect(sanitized.isResponding).toBe(false);
    });

    test('preserves email-related booleans while redacting address values', () => {
        const sanitized = sanitizeValue({
            userEmail: 'caller@example.com',
            oldEmail: 'old@example.com',
            newEmail: 'new@example.com',
            userEmailPresent: true,
            emailPendingConfirmation: false,
            emailConfirmed: true,
            emailConfidence: 'voice_confirmed'
        });

        expect(sanitized.userEmail).toBe('[redacted_email]');
        expect(sanitized.oldEmail).toBe('[redacted_email]');
        expect(sanitized.newEmail).toBe('[redacted_email]');
        expect(sanitized.userEmailPresent).toBe(true);
        expect(sanitized.emailPendingConfirmation).toBe(false);
        expect(sanitized.emailConfirmed).toBe(true);
        expect(sanitized.emailConfidence).toBe('voice_confirmed');
    });

    test('redacts slot and scripted phrase fields by default', () => {
        const sanitized = sanitizeValue({
            callSID: 'call-a',
            slot: 'Book the call tomorrow evening',
            phrase: 'Still there?',
            expected: 'Still there?'
        });

        expect(sanitized.slot).toMatch(/^\[redacted_text hash=/);
        expect(sanitized.phrase).toMatch(/^\[redacted_text hash=/);
        expect(sanitized.expected).toMatch(/^\[redacted_text hash=/);
    });

    test('allows PII-redacted debug text only for allowlisted call ids', () => {
        process.env.VOICEBOT_DEBUG_TEXT_LOGS = 'true';
        process.env.VOICEBOT_DEBUG_TEXT_CALL_IDS = 'call-debug';

        const sanitized = sanitizeValue({
            callSID: 'call-debug',
            transcript: 'Please book tomorrow and email me at caller@example.com'
        });

        expect(sanitized.transcript).toContain('[debug_text hash=');
        expect(sanitized.transcript).toContain('Please book tomorrow');
        expect(sanitized.transcript).toContain('[REDACTED_EMAIL]');
        expect(sanitized.transcript).not.toContain('caller@example.com');
    });

    test('clamps debug text max chars to prevent unsafe env expansion', () => {
        process.env.VOICEBOT_DEBUG_TEXT_LOGS = 'true';
        process.env.VOICEBOT_DEBUG_TEXT_CALL_IDS = 'call-debug';
        process.env.VOICEBOT_DEBUG_TEXT_MAX_CHARS = '-1';

        const sanitized = sanitizeValue({
            callSID: 'call-debug',
            transcript: 'Please book tomorrow and email me at caller@example.com'
        });

        expect(sanitized.transcript).toContain('truncated=true');
        expect(sanitized.transcript).not.toContain('Please book tomorrow');
        expect(sanitized.transcript).not.toContain('caller@example.com');
    });

    test('allows debug text through JSON string logs for allowlisted call ids', () => {
        process.env.VOICEBOT_DEBUG_TEXT_LOGS = 'true';
        process.env.VOICEBOT_DEBUG_TEXT_CALL_IDS = 'call-json';

        const raw = JSON.stringify({
            callSID: 'call-json',
            event: 'user_transcribed',
            transcript: 'Book it tomorrow evening'
        });
        const sanitized = JSON.parse(sanitizeString(raw));

        expect(sanitized.transcript).toContain('[debug_text hash=');
        expect(sanitized.transcript).toContain('Book it tomorrow evening');
    });

    test('keeps debug text redacted for non-allowlisted calls', () => {
        process.env.VOICEBOT_DEBUG_TEXT_LOGS = 'true';
        process.env.VOICEBOT_DEBUG_TEXT_CALL_IDS = 'call-debug';

        const sanitized = sanitizeValue({
            callSID: 'call-other',
            transcript: 'Please book tomorrow'
        });

        expect(sanitized.transcript).toMatch(/^\[redacted_text hash=/);
        expect(sanitized.transcript).not.toContain('Please book tomorrow');
    });

    test('can disable call content redaction for validation logs', () => {
        process.env.VOICEBOT_REDACT_CALL_CONTENT = 'false';

        const raw = JSON.stringify({
            callSID: 'call-raw',
            event: 'user_transcribed',
            transcript: 'Please call me at 555 123 4567 and email caller@example.com',
            text: 'I can help with that. What time works for you?',
            userEmail: 'caller@example.com'
        });
        const sanitized = JSON.parse(sanitizeString(raw));

        expect(sanitized.transcript).toBe('Please call me at 555 123 4567 and email caller@example.com');
        expect(sanitized.text).toBe('I can help with that. What time works for you?');
        expect(sanitized.userEmail).toBe('caller@example.com');
    });

    test('redacts call content again when validation logging is not explicitly disabled', () => {
        delete process.env.VOICEBOT_REDACT_CALL_CONTENT;

        const sanitized = sanitizeValue({
            callSID: 'call-default',
            transcript: 'Please call me at 555 123 4567',
            userEmail: 'caller@example.com'
        });

        expect(sanitized.transcript).toMatch(/^\[redacted_text hash=/);
        expect(sanitized.userEmail).toBe('[redacted_email]');
    });
});
