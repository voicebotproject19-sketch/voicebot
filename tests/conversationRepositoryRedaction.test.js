'use strict';

const ORIGINAL_REDACT_CALL_CONTENT = process.env.VOICEBOT_REDACT_CALL_CONTENT;

function restoreEnv(name, value) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}

function loadRepository() {
    jest.resetModules();
    const query = jest.fn().mockResolvedValue({ insertId: 42 });
    jest.doMock('../services/db', () => ({ query }));
    const repository = require('../repositories/ConversationRepository');
    return { repository, query };
}

describe('conversation repository call-content redaction', () => {
    afterEach(() => {
        restoreEnv('VOICEBOT_REDACT_CALL_CONTENT', ORIGINAL_REDACT_CALL_CONTENT);
        jest.dontMock('../services/db');
        jest.resetModules();
    });

    test('redacts persisted conversation content by default', async () => {
        delete process.env.VOICEBOT_REDACT_CALL_CONTENT;
        const { repository, query } = loadRepository();

        await repository.insertConversation('call-1', '+14155550123', 'user', 'Email me at caller@example.com or call 555 123 4567');

        const params = query.mock.calls[0][1];
        expect(params[3]).toBe('Email me at [REDACTED_EMAIL] or call [REDACTED_PHONE]');
    });

    test('persists raw conversation content when validation redaction is disabled', async () => {
        process.env.VOICEBOT_REDACT_CALL_CONTENT = 'false';
        const { repository, query } = loadRepository();

        await repository.insertConversation('call-2', '+14155550123', 'user', 'Email me at caller@example.com or call 555 123 4567');

        const params = query.mock.calls[0][1];
        expect(params[3]).toBe('Email me at caller@example.com or call 555 123 4567');
    });
});