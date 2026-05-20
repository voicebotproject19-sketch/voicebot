'use strict';

jest.mock('../repositories/UserRepository', () => ({}));
jest.mock('../repositories/ConversationRepository', () => ({}));
jest.mock('../adapters/telecom/TwilioProvider', () => ({}));
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

jest.mock('../Utils/telemetry', () => ({
    emit: jest.fn(),
}));

jest.mock('../adapters/telecom/PlivoProvider', () => ({
    consumePendingCallMeta: jest.fn(),
    incomingCallXml: jest.fn(() => '<Response><Stream>ok</Stream></Response>'),
}));

const CallRegistry = require('../services/CallRegistry');
const telemetry = require('../Utils/telemetry');
const MainController = require('../Controller/MainController');
const plivoStatus = require('../Helper/PlivoStatusHandler');

function createResponse() {
    return {
        status: jest.fn().mockReturnThis(),
        send: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
        type: jest.fn().mockReturnThis(),
    };
}

describe('telecom status handlers', () => {
    let debugSpy;
    let warnSpy;

    beforeEach(() => {
        jest.clearAllMocks();
        debugSpy = jest.spyOn(console, 'debug').mockImplementation(() => {});
        warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        debugSpy.mockRestore();
        warnSpy.mockRestore();
    });

    test('Twilio status callback records terminal lifecycle state and returns ok', () => {
        CallRegistry.get.mockReturnValue({ sid: 'CA11111111111111111111111111111111' });
        const res = createResponse();

        MainController.twilioStatus({
            body: {
                CallSid: 'CA11111111111111111111111111111111',
                CallStatus: 'completed'
            }
        }, res);

        expect(CallRegistry.update).toHaveBeenCalledWith(
            'CA11111111111111111111111111111111',
            expect.objectContaining({
                provider: 'twilio',
                providerStatus: 'completed',
                providerTerminal: true,
                lastStatus: 'completed',
                providerStatusAt: expect.any(Number),
                providerTerminalAt: expect.any(Number)
            })
        );
        expect(CallRegistry.delete).not.toHaveBeenCalled();
        expect(telemetry.emit).toHaveBeenCalledWith('telecom_status_received', expect.objectContaining({
            provider: 'twilio',
            callId: 'CA11111111111111111111111111111111',
            status: 'completed',
            source: 'twilio-status'
        }));
        expect(telemetry.emit).toHaveBeenCalledWith('telecom_status_terminal', expect.objectContaining({
            provider: 'twilio',
            callId: 'CA11111111111111111111111111111111',
            status: 'completed'
        }));
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.send).toHaveBeenCalledWith('ok');
    });

    test('Plivo terminal callback marks terminal state without deleting registry', async () => {
        CallRegistry.get.mockReturnValue({ sid: '0f8fad5b-d9cb-469f-a165-70867728950e' });
        const res = createResponse();

        await plivoStatus({
            body: {
                CallUUID: '0f8fad5b-d9cb-469f-a165-70867728950e',
                CallStatus: 'hangup'
            }
        }, res);

        expect(CallRegistry.update).toHaveBeenCalledWith(
            '0f8fad5b-d9cb-469f-a165-70867728950e',
            expect.objectContaining({
                provider: 'plivo',
                providerStatus: 'hangup',
                providerTerminal: true,
                lastStatus: 'hangup'
            })
        );
        expect(CallRegistry.delete).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.send).toHaveBeenCalledWith('ok');
    });

    test('missing provider call id is acknowledged and emits telemetry', async () => {
        const res = createResponse();

        await plivoStatus({ body: { Event: 'hangup' } }, res);

        expect(CallRegistry.create).not.toHaveBeenCalled();
        expect(CallRegistry.update).not.toHaveBeenCalled();
        expect(CallRegistry.delete).not.toHaveBeenCalled();
        expect(telemetry.emit).toHaveBeenCalledWith('telecom_status_missing_call_id', expect.objectContaining({
            provider: 'plivo',
            source: 'plivo-status',
            status: 'hangup'
        }));
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.send).toHaveBeenCalledWith('ignored');
    });

    test('Twilio transfer action records bridge confirmation and returns TwiML', () => {
        CallRegistry.get.mockReturnValue({
            sid: 'CA11111111111111111111111111111111',
            handoverTransferState: { attemptId: 'attempt-1', requestAccepted: true }
        });
        const res = createResponse();

        MainController.twilioTransferAction({
            query: {
                attemptId: 'attempt-1',
                rootCallId: 'CA11111111111111111111111111111111'
            },
            body: {
                DialCallStatus: 'completed',
                DialCallSid: 'CA22222222222222222222222222222222',
                DialBridged: 'true'
            }
        }, res);

        expect(CallRegistry.update).toHaveBeenCalledWith(
            'CA11111111111111111111111111111111',
            expect.objectContaining({
                handoverTransferState: expect.objectContaining({
                    bridgeConfirmed: true,
                    agentLeg: expect.objectContaining({ callId: 'CA22222222222222222222222222222222' })
                })
            })
        );
        expect(telemetry.emit).toHaveBeenCalledWith('call_transferred', expect.objectContaining({
            callId: 'CA11111111111111111111111111111111',
            bridgeConfirmed: true
        }));
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.type).toHaveBeenCalledWith('text/xml');
        expect(res.send).toHaveBeenCalledWith('<Response></Response>');
    });

    test('Plivo transfer action records no-answer bridge failure', async () => {
        CallRegistry.get.mockReturnValue({
            sid: '0f8fad5b-d9cb-469f-a165-70867728950e',
            handoverTransferState: { attemptId: 'attempt-plivo-1', requestAccepted: true }
        });
        const res = createResponse();

        await MainController.plivoTransferAction({
            query: {
                attemptId: 'attempt-plivo-1',
                rootCallId: '0f8fad5b-d9cb-469f-a165-70867728950e'
            },
            body: {
                DialStatus: 'no-answer',
                DialALegUUID: '0f8fad5b-d9cb-469f-a165-70867728950e'
            }
        }, res);

        expect(CallRegistry.update).toHaveBeenCalledWith(
            '0f8fad5b-d9cb-469f-a165-70867728950e',
            expect.objectContaining({
                handoverTransferState: expect.objectContaining({
                    bridgeFailed: true,
                    fallbackReason: 'no-answer'
                })
            })
        );
        expect(telemetry.emit).toHaveBeenCalledWith('warm_transfer_failed', expect.objectContaining({
            callId: '0f8fad5b-d9cb-469f-a165-70867728950e',
            reason: 'no-answer'
        }));
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.type).toHaveBeenCalledWith('text/xml');
    });
});
