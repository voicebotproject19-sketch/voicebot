'use strict';

const { EventEmitter } = require('events');

const { registerHandoverSignalHandler } = require('../session/createCallSession');
const EVENTS = require('../Utils/telemetryEvents');

function createEdgeSession(callSID = 'call-handover-123') {
    const signalEmitter = new EventEmitter();
    return {
        callSID,
        connectionId: 'conn-handover-123',
        isClosed: false,
        emitSignal(event, ...args) {
            signalEmitter.emit(event, ...args);
        },
        onSignal(event, handler) {
            signalEmitter.on(event, handler);
        }
    };
}

function createRealtimeService(contact = {}, personaContact = {}) {
    return {
        kb: { contact },
        persona: { id: 'company-sales', contact: personaContact },
        name: 'Sarah',
        recipient: '+15551230000',
        userEmail: 'caller@example.com',
        userPhone: '+15551230001',
        preferredSlot: 'tomorrow morning',
        lang: { sttLocale: 'en-US' },
        sendTextResponse: jest.fn(),
    };
}

function createHarness({ callSID = 'call-handover-123', transferNumber = '+15550001111', transferred = true, realtimeService, isSessionClosed, isTelecomCallActive, agentAvailabilityResolver } = {}) {
    const edgeSession = createEdgeSession(callSID);
    const provider = {
        name: 'plivo',
        transfer: jest.fn().mockResolvedValue(transferred),
        hangup: jest.fn(),
    };
    const telemetryClient = { emit: jest.fn() };
    const sendHandoverEmailFn = jest.fn().mockResolvedValue(undefined);
    const service = realtimeService || createRealtimeService(transferNumber ? { transferNumber } : {});

    registerHandoverSignalHandler({
        edgeSession,
        provider,
        getRealtimeService: () => service,
        isSessionClosed: isSessionClosed || (() => false),
        isTelecomCallActive: isTelecomCallActive || (() => true),
        telemetryClient,
        sendHandoverEmailFn,
        agentAvailabilityResolver: agentAvailabilityResolver || (() => ({
            enabled: false,
            mode: 'cold',
            available: false,
            selectedTargets: [],
            reason: 'warm_transfer_disabled',
            timeoutSeconds: 20,
            confirmTimeoutSeconds: 8,
            confirmKey: '1'
        })),
        handoverTransferNumber: null,
    });

    return { edgeSession, provider, realtimeService: service, telemetryClient, sendHandoverEmailFn };
}

async function advanceTimersByTime(ms) {
    jest.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

describe('createCallSession handover signal', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    test('handover transfer scheduled telemetry event is registered', () => {
        expect(EVENTS.has('handover_transfer_scheduled')).toBe(true);
        expect(EVENTS.has('handover_transfer_invalid_number')).toBe(true);
        expect(EVENTS.has('transfer_request_accepted')).toBe(true);
        expect(EVENTS.has('transfer_request_failed')).toBe(true);
        expect(EVENTS.has('agent_availability_checked')).toBe(true);
        expect(EVENTS.has('warm_transfer_started')).toBe(true);
        expect(EVENTS.has('warm_transfer_bridge_confirmed')).toBe(true);
        expect(EVENTS.has('warm_transfer_failed')).toBe(true);
    });

    test('schedules transfer before handoff TTS and still transfers if TTS throws', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        const realtimeService = createRealtimeService({ transferNumber: '+15550001111' });
        realtimeService.sendTextResponse.mockImplementation(() => {
            throw new Error('tts unavailable');
        });
        const { edgeSession, provider, telemetryClient } = createHarness({ realtimeService });

        edgeSession.emitSignal('signal_handover', { reason: 'caller_requested' });

        expect(telemetryClient.emit).toHaveBeenCalledWith('handover_transfer_scheduled', expect.objectContaining({
            callId: 'call-handover-123',
            transferNumber: '+15550001111',
            delayMs: 3000,
        }));
        expect(telemetryClient.emit.mock.invocationCallOrder[0])
            .toBeLessThan(realtimeService.sendTextResponse.mock.invocationCallOrder[0]);
        expect(provider.transfer).not.toHaveBeenCalled();

        await advanceTimersByTime(3000);

        expect(provider.transfer).toHaveBeenCalledWith('call-handover-123', '+15550001111', expect.objectContaining({
            attemptId: expect.stringMatching(/^handover-/),
            mode: 'cold',
            rootCallId: 'call-handover-123'
        }));
        expect(telemetryClient.emit).toHaveBeenCalledWith('transfer_request_accepted', expect.objectContaining({
            callId: 'call-handover-123',
            success: true,
        }));
        expect(telemetryClient.emit).not.toHaveBeenCalledWith('call_transferred', expect.any(Object));
    });

    test('normalizes formatted transfer numbers before scheduling provider transfer', async () => {
        const realtimeService = createRealtimeService({ transferNumber: '+1 (555) 000-1111' });
        const { edgeSession, provider, telemetryClient } = createHarness({ realtimeService });

        edgeSession.emitSignal('signal_handover', { reason: 'caller_requested' });
        await advanceTimersByTime(3000);

        expect(telemetryClient.emit).toHaveBeenCalledWith('handover_transfer_scheduled', expect.objectContaining({
            transferNumber: '+15550001111',
        }));
        expect(provider.transfer).toHaveBeenCalledWith('call-handover-123', '+15550001111', expect.any(Object));
        expect(realtimeService._handoverTransferState).toEqual(expect.objectContaining({
            transferNumberRaw: '+1 (555) 000-1111',
            transferNumberNormalized: '+15550001111',
            requestAccepted: true,
        }));
    });

    test('invalid transfer number uses fallback without calling provider transfer', async () => {
        const realtimeService = createRealtimeService({ transferNumber: '+1-555-BAD-CALL' });
        const { edgeSession, provider, telemetryClient, sendHandoverEmailFn } = createHarness({ realtimeService });

        edgeSession.emitSignal('signal_handover', { reason: 'caller_requested' });
        await advanceTimersByTime(3000);

        expect(provider.transfer).not.toHaveBeenCalled();
        expect(telemetryClient.emit).toHaveBeenCalledWith('handover_transfer_invalid_number', expect.objectContaining({
            callId: 'call-handover-123',
            invalidReason: 'invalid_characters',
        }));
        expect(telemetryClient.emit).toHaveBeenCalledWith('handover_fallback_close', expect.objectContaining({
            callId: 'call-handover-123',
            noTransferNumber: true,
        }));
        expect(sendHandoverEmailFn).toHaveBeenCalledWith(expect.objectContaining({
            transferAttempted: false,
            transferFailed: true,
            transferStatus: 'invalid_number',
        }));
        expect(realtimeService._handoverTransferState).toEqual(expect.objectContaining({
            invalidNumber: true,
            fallbackUsed: true,
            requestAccepted: false,
        }));
    });

    test('transfer still runs when realtime session is closed but telecom call is active', async () => {
        const { edgeSession, provider } = createHarness({
            isSessionClosed: () => true,
            isTelecomCallActive: () => true,
        });

        edgeSession.emitSignal('signal_handover', { reason: 'caller_requested' });
        edgeSession.isClosed = true;
        await advanceTimersByTime(3000);

        expect(provider.transfer).toHaveBeenCalledWith('call-handover-123', '+15550001111', expect.any(Object));
    });

    test('uses persona transfer number when knowledge-base contact is empty', async () => {
        const realtimeService = createRealtimeService({}, { transferNumber: '+15559998888' });
        const { edgeSession, provider, telemetryClient } = createHarness({
            transferNumber: null,
            realtimeService,
        });

        edgeSession.emitSignal('signal_handover', { reason: 'caller_requested' });
        await advanceTimersByTime(3000);

        expect(telemetryClient.emit).toHaveBeenCalledWith('handover_transfer_scheduled', expect.objectContaining({
            transferNumber: '+15559998888',
        }));
        expect(provider.transfer).toHaveBeenCalledWith('call-handover-123', '+15559998888', expect.any(Object));
    });

    test('uses available warm-transfer agent target and emits availability telemetry', async () => {
        const { edgeSession, provider, telemetryClient, realtimeService } = createHarness({
            agentAvailabilityResolver: () => ({
                enabled: true,
                mode: 'warm',
                available: true,
                selectedTargets: ['+15557778888'],
                reason: 'configured_agent_targets',
                timeoutSeconds: 15,
                confirmTimeoutSeconds: 6,
                confirmKey: '7'
            })
        });

        edgeSession.emitSignal('signal_handover', { reason: 'caller_requested', attemptId: 'attempt-warm-1' });
        await advanceTimersByTime(3000);

        expect(telemetryClient.emit).toHaveBeenCalledWith('agent_availability_checked', expect.objectContaining({
            attemptId: 'attempt-warm-1',
            available: true,
            selectedTargetCount: 1
        }));
        expect(telemetryClient.emit).toHaveBeenCalledWith('warm_transfer_started', expect.objectContaining({
            attemptId: 'attempt-warm-1',
            transferNumber: '+15557778888'
        }));
        expect(provider.transfer).toHaveBeenCalledWith('call-handover-123', '+15557778888', expect.objectContaining({
            attemptId: 'attempt-warm-1',
            mode: 'warm',
            timeoutSeconds: 15,
            confirmTimeoutSeconds: 6,
            confirmKey: '7'
        }));
        expect(realtimeService._handoverTransferState).toEqual(expect.objectContaining({
            attemptId: 'attempt-warm-1',
            mode: 'warm',
            targetNumber: '+15557778888'
        }));
    });

    test('skips delayed transfer when telecom call is no longer active', async () => {
        const { edgeSession, provider, telemetryClient } = createHarness({
            isTelecomCallActive: () => false,
        });

        edgeSession.emitSignal('signal_handover', { reason: 'caller_requested' });
        await advanceTimersByTime(3000);

        expect(telemetryClient.emit).toHaveBeenCalledWith('handover_transfer_scheduled', expect.any(Object));
        expect(provider.transfer).not.toHaveBeenCalled();
    });

    test('skips delayed transfer when callSID is missing', async () => {
        const { edgeSession, provider } = createHarness({
            callSID: null,
            isTelecomCallActive: () => true,
        });

        edgeSession.emitSignal('signal_handover', { reason: 'caller_requested' });
        await advanceTimersByTime(3000);

        expect(provider.transfer).not.toHaveBeenCalled();
    });

    test('failed transfer offers callback and sends handover email', async () => {
        const { edgeSession, provider, realtimeService, telemetryClient, sendHandoverEmailFn } = createHarness({
            transferred: false,
        });

        edgeSession.emitSignal('signal_handover', { reason: 'caller_requested' });
        await advanceTimersByTime(3000);

        expect(provider.transfer).toHaveBeenCalledWith('call-handover-123', '+15550001111', expect.any(Object));
        expect(telemetryClient.emit).toHaveBeenCalledWith('transfer_request_failed', expect.objectContaining({ success: false }));
        expect(telemetryClient.emit).toHaveBeenCalledWith('transfer_failed_callback_offered', expect.objectContaining({
            callId: 'call-handover-123',
            reason: 'caller_requested',
        }));
        expect(realtimeService.sendTextResponse).toHaveBeenCalledWith(expect.stringMatching(/no one is available|reach out/i));
        expect(sendHandoverEmailFn).toHaveBeenCalledWith(expect.objectContaining({
            transferAttempted: true,
            transferFailed: true,
            transferStatus: 'request_failed',
            callerName: 'Sarah',
            callerNumber: '+15551230000',
        }));
    });

    test('no-transfer fallback still emails, says farewell, and hangs up', async () => {
        const realtimeService = createRealtimeService({});
        const { edgeSession, provider, telemetryClient, sendHandoverEmailFn } = createHarness({
            transferNumber: null,
            realtimeService,
        });

        edgeSession.emitSignal('signal_handover', { reason: 'caller_requested' });

        expect(realtimeService.sendTextResponse).toHaveBeenCalledWith(expect.stringMatching(/no executive is available/i));
        await advanceTimersByTime(3000);

        expect(sendHandoverEmailFn).toHaveBeenCalledWith(expect.objectContaining({
            transferAttempted: false,
            transferFailed: false,
            transferStatus: 'not_configured',
        }));
        expect(realtimeService.sendTextResponse).toHaveBeenCalledWith(expect.stringMatching(/Goodbye/i));
        expect(telemetryClient.emit).toHaveBeenCalledWith('handover_fallback_close', expect.objectContaining({
            callId: 'call-handover-123',
            noTransferNumber: true,
        }));

        await advanceTimersByTime(4000);

        expect(provider.hangup).toHaveBeenCalledWith('call-handover-123');
    });
});
