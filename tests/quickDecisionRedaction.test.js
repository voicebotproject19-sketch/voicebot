'use strict';

const { quickHangupDecision } = require('../Helper/quickDecisionFilter');

function captureConsoleLog(run) {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
        const result = run();
        return { result, serializedLogs: JSON.stringify(logSpy.mock.calls).toLowerCase() };
    } finally {
        logSpy.mockRestore();
    }
}

describe('quick decision redaction', () => {
    test('voicemail detection logs summary without raw transcript text', () => {
        const { result, serializedLogs } = captureConsoleLog(() => quickHangupDecision([
            { sender: 'AI', message: 'Hey John, this is Sarah from company...' },
            { sender: 'USER', message: 'The person you have called is not available. Please leave a message after the tone.' }
        ], 1, 'english'));

        expect(result?.reason).toBe('voicemail_greeting');
        expect(serializedLogs).toContain('transcriptsummary');
        expect(serializedLogs).not.toContain('please leave a message after the tone');
        expect(serializedLogs).not.toContain('the person you have called is not available');
    });

    test('screening detection logs summary without raw transcript text', () => {
        const { result, serializedLogs } = captureConsoleLog(() => quickHangupDecision([
            { sender: 'AI', message: 'Hey John, this is Sarah from company...' },
            { sender: 'USER', message: 'This call is being screened. Please state your name and call me at 555 123 4567.' }
        ], 1, 'english'));

        expect(result?.reason).toBe('ai_screening');
        expect(serializedLogs).toContain('transcriptsummary');
        expect(serializedLogs).not.toContain('this call is being screened');
        expect(serializedLogs).not.toContain('555 123 4567');
    });
});
