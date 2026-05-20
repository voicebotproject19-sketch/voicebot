'use strict';

jest.mock('../repositories/UserRepository', () => ({}));
jest.mock('../repositories/ConversationRepository', () => ({}));
jest.mock('../adapters/telecom/TwilioProvider', () => ({}));
jest.mock('../Helper/PlivoStatusHandler', () => jest.fn());
jest.mock('../personas/registry', () => ({
    getPersonaLanguage: jest.fn(),
    resolveLegacy: jest.fn(),
    listPersonas: jest.fn(),
}));
jest.mock('../repositories/SuppressionRepository', () => ({ isSuppressed: jest.fn() }));
jest.mock('../repositories/ConsentRepository', () => ({ hasValidConsent: jest.fn() }));
jest.mock('../services/callingWindowCheck', () => ({ isWithinCallingWindow: jest.fn() }));
jest.mock('../services/consentStateCheck', () => ({ requiresTwoPartyConsent: jest.fn() }));
jest.mock('../services/db', () => ({ pool: { execute: jest.fn() } }));

jest.mock('../services/CallRegistry', () => ({
    get: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
}));

jest.mock('../adapters/telecom/PlivoProvider', () => ({
    consumePendingCallMeta: jest.fn(),
    incomingCallXml: jest.fn(() => '<Response><Stream>ok</Stream></Response>'),
}));

const CallRegistry = require('../services/CallRegistry');
const PlivoProvider = require('../adapters/telecom/PlivoProvider');
const MainController = require('../Controller/MainController');

describe('incoming_plivo fallback registry hydration', () => {
    const ORIG_DEFAULT_PERSONA = process.env.DEFAULT_PERSONA;
    const ORIG_DEFAULT_LANGUAGE = process.env.DEFAULT_LANGUAGE;
    const ORIG_NETWORK_URL = process.env.NETWORK_URL;

    beforeEach(() => {
        jest.clearAllMocks();
        process.env.DEFAULT_PERSONA = 'company-sales';
        process.env.DEFAULT_LANGUAGE = 'en';
        process.env.NETWORK_URL = 'example.test';
    });

    afterAll(() => {
        process.env.DEFAULT_PERSONA = ORIG_DEFAULT_PERSONA;
        process.env.DEFAULT_LANGUAGE = ORIG_DEFAULT_LANGUAGE;
        process.env.NETWORK_URL = ORIG_NETWORK_URL;
    });

    test('creates complete registry state when no pending metadata is available', async () => {
        CallRegistry.get.mockReturnValue(null);
        PlivoProvider.consumePendingCallMeta.mockReturnValue(null);

        const req = {
            body: {
                CallUUID: '0f8fad5b-d9cb-469f-a165-70867728950e',
                From: '+14155550111',
                To: '+12135550123',
            },
            query: {},
        };

        const res = {
            status: jest.fn().mockReturnThis(),
            type: jest.fn().mockReturnThis(),
            send: jest.fn().mockReturnThis(),
        };

        await MainController.incoming_plivo(req, res);

        expect(PlivoProvider.consumePendingCallMeta).toHaveBeenCalledTimes(2);
        expect(CallRegistry.create).toHaveBeenCalledWith(
            '0f8fad5b-d9cb-469f-a165-70867728950e',
            expect.objectContaining({
                callId: '0f8fad5b-d9cb-469f-a165-70867728950e',
                sid: '0f8fad5b-d9cb-469f-a165-70867728950e',
                recipient: '+12135550123',
                phoneNumber: '+12135550123',
                persona: 'company-sales',
                language: 'en',
                provider: 'plivo',
                status: 'connected',
                aiProvider: null,
                contextHint: null,
                policyConfig: null,
                requireExplicitRecordingConsent: false,
                transcript: [],
                voicemail: 'false',
                interested: 'false',
            })
        );

        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.type).toHaveBeenCalledWith('text/xml');
        expect(res.send).toHaveBeenCalledWith('<Response><Stream>ok</Stream></Response>');
    });
});
