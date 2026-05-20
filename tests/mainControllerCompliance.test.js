'use strict';

jest.mock('../repositories/UserRepository', () => ({}));
jest.mock('../repositories/ConversationRepository', () => ({}));
jest.mock('../Helper/PlivoStatusHandler', () => jest.fn());
jest.mock('../services/db', () => ({ pool: { execute: jest.fn(), query: jest.fn() } }));
jest.mock('../services/CallContextStore', () => ({ upsertInitialContext: jest.fn(), patchContext: jest.fn() }));
jest.mock('../services/CallRegistry', () => ({
    get: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
}));
jest.mock('../services/outboundCallCompliance', () => ({ evaluateOutboundCallCompliance: jest.fn() }));
jest.mock('../adapters/telecom/TwilioProvider', () => ({
    createCall: jest.fn(),
    incomingCallXml: jest.fn(),
    hangup: jest.fn(),
}));
jest.mock('../adapters/telecom/PlivoProvider', () => ({
    createCall: jest.fn(),
    incomingCallXml: jest.fn(),
    consumePendingCallMeta: jest.fn(),
    hangup: jest.fn(),
}));
jest.mock('../personas/registry', () => ({
    getPersonaLanguage: jest.fn(),
    resolveLegacy: jest.fn(),
    listPersonas: jest.fn(),
}));

const TwilioProvider = require('../adapters/telecom/TwilioProvider');
const PlivoProvider = require('../adapters/telecom/PlivoProvider');
const { getPersonaLanguage } = require('../personas/registry');
const { evaluateOutboundCallCompliance } = require('../services/outboundCallCompliance');
const MainController = require('../Controller/MainController');

function createResponse() {
    return {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
        send: jest.fn().mockReturnThis(),
        type: jest.fn().mockReturnThis(),
    };
}

describe('MainController.call compliance gate integration', () => {
    let errorSpy;

    beforeEach(() => {
        jest.clearAllMocks();
        errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        getPersonaLanguage.mockReturnValue({ persona: 'company-sales', language: 'en' });
    });

    afterEach(() => {
        errorSpy.mockRestore();
    });

    test('returns compliance block response before invoking telecom providers', async () => {
        evaluateOutboundCallCompliance.mockResolvedValue({
            allowed: false,
            statusCode: 503,
            error: 'Compliance check unavailable: suppression',
            reason: 'suppression_check_failed',
            decisions: [],
        });
        const res = createResponse();

        await MainController.call({
            body: {
                phoneNumber: '+12135551234',
                name: 'Ada Lovelace',
                persona: 'company-sales',
                language: 'en',
            },
        }, res);

        expect(evaluateOutboundCallCompliance).toHaveBeenCalledWith(expect.objectContaining({
            phoneNumber: '+12135551234',
            persona: 'company-sales',
            language: 'en',
        }));
        expect(res.status).toHaveBeenCalledWith(503);
        expect(res.json).toHaveBeenCalledWith({
            error: 'Compliance check unavailable: suppression',
            reason: 'suppression_check_failed',
        });
        expect(TwilioProvider.createCall).not.toHaveBeenCalled();
        expect(PlivoProvider.createCall).not.toHaveBeenCalled();
    });

    test('rejects unknown country code before compliance lookup', async () => {
        const res = createResponse();

        await MainController.call({
            body: {
                phoneNumber: '+99955512345',
                name: 'Ada Lovelace',
                persona: 'company-sales',
                language: 'en',
            },
        }, res);

        expect(evaluateOutboundCallCompliance).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({
            error: 'Invalid phone number or unable to determine country code',
        });
        expect(TwilioProvider.createCall).not.toHaveBeenCalled();
        expect(PlivoProvider.createCall).not.toHaveBeenCalled();
    });
});
