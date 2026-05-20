'use strict';

describe('telecomStatusService', () => {
    let mockEmit;
    let mockFinalizeCall;
    let mockPatchContext;
    let originalGraceMs;

    beforeEach(() => {
        jest.resetModules();
        jest.useFakeTimers();
        originalGraceMs = process.env.PROVIDER_TERMINAL_FINALIZATION_GRACE_MS;
        process.env.PROVIDER_TERMINAL_FINALIZATION_GRACE_MS = '25';
        mockEmit = jest.fn();
        mockFinalizeCall = jest.fn();
        mockPatchContext = jest.fn().mockResolvedValue(true);

        jest.doMock('../Utils/telemetry', () => ({ emit: mockEmit }));
        jest.doMock('../services/CallContextStore', () => ({ patchContext: mockPatchContext }));
        jest.doMock('../services/CallRegistry', () => ({
            get: jest.fn(() => ({ sid: 'CA11111111111111111111111111111111' })),
            update: jest.fn(),
            create: jest.fn()
        }));
        jest.doMock('../services/callFinalizer', () => ({ finalizeCall: mockFinalizeCall }));
    });

    afterEach(() => {
        jest.runOnlyPendingTimers();
        jest.useRealTimers();
        if (originalGraceMs == null) delete process.env.PROVIDER_TERMINAL_FINALIZATION_GRACE_MS;
        else process.env.PROVIDER_TERMINAL_FINALIZATION_GRACE_MS = originalGraceMs;
    });

    test('schedules delayed fallback finalization for terminal provider status', () => {
        const { recordProviderStatus } = require('../services/telecomStatusService');

        recordProviderStatus({
            provider: 'twilio',
            callSID: 'CA11111111111111111111111111111111',
            status: 'completed',
            payload: { CallSid: 'CA11111111111111111111111111111111' },
            source: 'twilio-status'
        });

        expect(mockFinalizeCall).not.toHaveBeenCalled();
        jest.advanceTimersByTime(25);

        expect(mockFinalizeCall).toHaveBeenCalledWith(expect.objectContaining({
            callSID: 'CA11111111111111111111111111111111',
            source: 'provider_terminal_status',
            reason: 'twilio_completed'
        }));
        expect(mockPatchContext).toHaveBeenCalledWith('CA11111111111111111111111111111111', expect.objectContaining({
            providerStatus: 'completed',
            providerTerminal: true
        }));
    });

    test('does not schedule fallback finalization for non-terminal provider status', () => {
        const { recordProviderStatus } = require('../services/telecomStatusService');

        recordProviderStatus({
            provider: 'twilio',
            callSID: 'CA11111111111111111111111111111111',
            status: 'ringing',
            payload: { CallSid: 'CA11111111111111111111111111111111' },
            source: 'twilio-status'
        });

        jest.advanceTimersByTime(25);

        expect(mockFinalizeCall).not.toHaveBeenCalled();
        expect(mockEmit).toHaveBeenCalledWith('telecom_status_received', expect.objectContaining({
            provider: 'twilio',
            status: 'ringing'
        }));
    });

    test('records Twilio transfer action bridge confirmation and emits call_transferred', () => {
        const CallRegistry = require('../services/CallRegistry');
        const {
            normalizeTwilioTransferAction,
            recordTransferLegStatus
        } = require('../services/telecomStatusService');
        CallRegistry.get.mockReturnValue({
            sid: 'CA11111111111111111111111111111111',
            handoverTransferState: {
                attemptId: 'attempt-1',
                requestAccepted: true,
                bridgeConfirmed: false
            }
        });

        const normalized = normalizeTwilioTransferAction({
            DialCallStatus: 'completed',
            DialCallSid: 'CA22222222222222222222222222222222',
            DialCallDuration: '42',
            DialBridged: 'true'
        }, {
            attemptId: 'attempt-1',
            rootCallId: 'CA11111111111111111111111111111111'
        });
        const result = recordTransferLegStatus(normalized);

        expect(result).toEqual(expect.objectContaining({
            ok: true,
            bridgeConfirmed: true,
            bridgeFailed: false
        }));
        expect(CallRegistry.update).toHaveBeenCalledWith(
            'CA11111111111111111111111111111111',
            expect.objectContaining({
                handoverTransferState: expect.objectContaining({
                    attemptId: 'attempt-1',
                    bridgeConfirmed: true,
                    requestAccepted: true,
                    agentLeg: expect.objectContaining({
                        callId: 'CA22222222222222222222222222222222',
                        status: 'completed'
                    })
                })
            })
        );
        expect(mockEmit).toHaveBeenCalledWith('warm_transfer_bridge_confirmed', expect.objectContaining({
            callId: 'CA11111111111111111111111111111111',
            attemptId: 'attempt-1'
        }));
        expect(mockEmit).toHaveBeenCalledWith('call_transferred', expect.objectContaining({
            callId: 'CA11111111111111111111111111111111',
            bridgeConfirmed: true
        }));
        expect(mockPatchContext).toHaveBeenCalledWith('CA11111111111111111111111111111111', expect.objectContaining({
            handoverTransferState: expect.objectContaining({ bridgeConfirmed: true })
        }));
    });

    test('records Plivo no-answer transfer callback as bridge failure', () => {
        const CallRegistry = require('../services/CallRegistry');
        const {
            normalizePlivoDialEvent,
            recordTransferLegStatus
        } = require('../services/telecomStatusService');
        CallRegistry.get.mockReturnValue({
            sid: '0f8fad5b-d9cb-469f-a165-70867728950e',
            handoverTransferState: {
                attemptId: 'attempt-plivo-1',
                requestAccepted: true,
                bridgeConfirmed: false
            }
        });

        const normalized = normalizePlivoDialEvent({
            DialStatus: 'no-answer',
            DialALegUUID: '0f8fad5b-d9cb-469f-a165-70867728950e',
            DialBLegUUID: ''
        }, {
            attemptId: 'attempt-plivo-1',
            rootCallId: '0f8fad5b-d9cb-469f-a165-70867728950e'
        });
        const result = recordTransferLegStatus(normalized);

        expect(result).toEqual(expect.objectContaining({
            ok: true,
            bridgeConfirmed: false,
            bridgeFailed: true
        }));
        expect(CallRegistry.update).toHaveBeenCalledWith(
            '0f8fad5b-d9cb-469f-a165-70867728950e',
            expect.objectContaining({
                handoverTransferState: expect.objectContaining({
                    bridgeFailed: true,
                    fallbackReason: 'no-answer'
                })
            })
        );
        expect(mockEmit).toHaveBeenCalledWith('warm_transfer_failed', expect.objectContaining({
            callId: '0f8fad5b-d9cb-469f-a165-70867728950e',
            reason: 'no-answer'
        }));
        expect(mockEmit).not.toHaveBeenCalledWith('call_transferred', expect.any(Object));
    });
});
