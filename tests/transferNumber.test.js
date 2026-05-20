'use strict';

const { normalizeTransferNumber } = require('../Utils/phoneUtils');

function createResponse() {
    return {
        statusCode: null,
        contentType: null,
        body: null,
        status: jest.fn(function status(code) { this.statusCode = code; return this; }),
        type: jest.fn(function type(value) { this.contentType = value; return this; }),
        send: jest.fn(function send(body) { this.body = body; return this; }),
    };
}

describe('transfer number normalization', () => {
    test('normalizes formatted phone numbers', () => {
        expect(normalizeTransferNumber('+1 (555) 000-1111')).toEqual({
            ok: true,
            number: '+15550001111',
            reason: null,
        });
    });

    test('rejects extension or mixed text numbers', () => {
        expect(normalizeTransferNumber('+1-555-BAD-CALL')).toEqual(expect.objectContaining({
            ok: false,
            reason: 'invalid_characters',
        }));
        expect(normalizeTransferNumber('+1 555 000 1111 ext 5')).toEqual(expect.objectContaining({
            ok: false,
            reason: 'invalid_characters',
        }));
    });
});

describe('telecom provider transfer validation', () => {
    beforeEach(() => {
        jest.resetModules();
        process.env.NETWORK_URL = 'voicebot.example.com';
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('Plivo rejects invalid transfer numbers before calling provider API', async () => {
        const transferMock = jest.fn();
        jest.doMock('../adapters/telecom/plivoClient', () => ({
            createPlivoClient: () => ({ calls: { transfer: transferMock } })
        }));

        const PlivoProvider = require('../adapters/telecom/PlivoProvider');
        const result = await PlivoProvider.transfer('call-uuid-123', '+1-555-BAD-CALL');

        expect(result).toBe(false);
        expect(transferMock).not.toHaveBeenCalled();
    });

    test('Plivo normalizes formatted transfer numbers in alegUrl', async () => {
        const transferMock = jest.fn().mockResolvedValue({});
        jest.doMock('../adapters/telecom/plivoClient', () => ({
            createPlivoClient: () => ({ calls: { transfer: transferMock } })
        }));

        const PlivoProvider = require('../adapters/telecom/PlivoProvider');
        const result = await PlivoProvider.transfer('call-uuid-123', '+1 (555) 000-1111');

        expect(result).toBe(true);
        expect(transferMock).toHaveBeenCalledWith('call-uuid-123', expect.objectContaining({
            legs: 'aleg',
            alegUrl: 'https://voicebot.example.com/transfer-plivo?number=%2B15550001111&rootCallId=call-uuid-123'
        }));
    });

    test('Plivo includes warm transfer correlation in alegUrl', async () => {
        const transferMock = jest.fn().mockResolvedValue({});
        jest.doMock('../adapters/telecom/plivoClient', () => ({
            createPlivoClient: () => ({ calls: { transfer: transferMock } })
        }));

        const PlivoProvider = require('../adapters/telecom/PlivoProvider');
        const result = await PlivoProvider.transfer('call-uuid-123', '+15550001111', {
            attemptId: 'attempt-1',
            rootCallId: 'root-1',
            mode: 'warm',
            timeoutSeconds: 15,
            confirmTimeoutSeconds: 6,
            confirmKey: '7'
        });

        expect(result).toBe(true);
        const alegUrl = transferMock.mock.calls[0][1].alegUrl;
        expect(alegUrl).toContain('/transfer-plivo?');
        expect(alegUrl).toContain('attemptId=attempt-1');
        expect(alegUrl).toContain('rootCallId=root-1');
        expect(alegUrl).toContain('mode=warm');
        expect(alegUrl).toContain('confirmKey=7');
    });

    test('Twilio normalizes formatted transfer numbers in Dial TwiML', async () => {
        const updateMock = jest.fn().mockResolvedValue({});
        const callsMock = jest.fn(() => ({ update: updateMock }));
        jest.doMock('../adapters/telecom/twilioClient', () => ({
            createTwilioClient: () => ({ calls: callsMock })
        }));

        const TwilioProvider = require('../adapters/telecom/TwilioProvider');
        const result = await TwilioProvider.transfer('CA11111111111111111111111111111111', '+1 (555) 000-1111');

        expect(result).toBe(true);
        expect(callsMock).toHaveBeenCalledWith('CA11111111111111111111111111111111');
        expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
            twiml: expect.stringContaining('+15550001111')
        }));
    });

    test('Twilio includes transfer action correlation when attempt options are provided', async () => {
        const updateMock = jest.fn().mockResolvedValue({});
        const callsMock = jest.fn(() => ({ update: updateMock }));
        jest.doMock('../adapters/telecom/twilioClient', () => ({
            createTwilioClient: () => ({ calls: callsMock })
        }));

        const TwilioProvider = require('../adapters/telecom/TwilioProvider');
        const result = await TwilioProvider.transfer('CA11111111111111111111111111111111', '+15550001111', {
            attemptId: 'attempt-1',
            rootCallId: 'CA11111111111111111111111111111111',
            timeoutSeconds: 15
        });

        expect(result).toBe(true);
        const twiml = updateMock.mock.calls[0][0].twiml;
        expect(twiml).toContain('twilio-transfer-action');
        expect(twiml).toContain('attemptId=attempt-1');
        expect(twiml).toContain('answerOnBridge="true"');
        expect(twiml).toContain('timeout="15"');
    });
});

describe('Plivo transfer XML controller', () => {
    beforeEach(() => {
        jest.resetModules();
        jest.doMock('../services/db', () => ({
            pool: {},
            query: jest.fn()
        }));
    });

    test('returns callback-aware Dial XML for valid formatted numbers', async () => {
        const MainController = require('../Controller/MainController');
        const res = createResponse();

        process.env.NETWORK_URL = 'voicebot.example.com';
        await MainController.transfer_plivo({
            query: {
                number: '+1 (555) 000-1111',
                attemptId: 'attempt-1',
                rootCallId: 'root-1',
                mode: 'warm',
                confirmKey: '7'
            }
        }, res);

        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.type).toHaveBeenCalledWith('text/xml');
        expect(res.body).toContain('<Dial action="https://voicebot.example.com/plivo-transfer-action?attemptId=attempt-1&amp;rootCallId=root-1&amp;confirmKey=7"');
        expect(res.body).toContain('callbackUrl="https://voicebot.example.com/plivo-transfer-events?attemptId=attempt-1&amp;rootCallId=root-1&amp;confirmKey=7"');
        expect(res.body).toContain('confirmKey="7"');
        expect(res.body).toContain('<Number>+15550001111</Number>');
    });

    test('returns Hangup XML for invalid transfer numbers', async () => {
        const MainController = require('../Controller/MainController');
        const res = createResponse();

        await MainController.transfer_plivo({ query: { number: '+1-555-BAD-CALL' } }, res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.type).toHaveBeenCalledWith('text/xml');
        expect(res.send).toHaveBeenCalledWith('<Response><Hangup/></Response>');
    });
});