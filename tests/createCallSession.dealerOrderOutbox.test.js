'use strict';

const { EventEmitter } = require('events');

describe('createCallSession dealer order outbox wiring', () => {
    let hydrateCallRegistry;
    let registryUpdate;
    let patchContext;
    let telemetryEmit;
    let enqueueAndProcessDealerOrderSubmission;
    let enqueueAndProcessBookingLinkDelivery;
    let enqueueAndProcessHandoverFollowup;
    let recordWorkflowStep;
    let buildBookingLink;
    let resolveBookingProviderConfig;
    let writeQueueEnqueue;

    beforeEach(() => {
        jest.resetModules();
        hydrateCallRegistry = jest.fn();
        registryUpdate = jest.fn();
        patchContext = jest.fn().mockResolvedValue(true);
        telemetryEmit = jest.fn();
        enqueueAndProcessDealerOrderSubmission = jest.fn();
        enqueueAndProcessBookingLinkDelivery = jest.fn();
        enqueueAndProcessHandoverFollowup = jest.fn().mockResolvedValue({ ok: true });
        recordWorkflowStep = jest.fn().mockResolvedValue({ ok: true });
        buildBookingLink = jest.fn();
        resolveBookingProviderConfig = jest.fn();
        writeQueueEnqueue = jest.fn(() => true);

        jest.doMock('../Noise-Reducer/noise-reducer', () => ({
            RealTimeRNNoise: jest.fn().mockImplementation(() => ({
                initialize: jest.fn(),
                processChunk: jest.fn(),
                destroy: jest.fn(),
            })),
        }));
        jest.doMock('../services/CallRegistry', () => ({
            get: jest.fn(() => null),
            create: jest.fn((callSID, state) => ({ callId: callSID, ...state })),
            update: registryUpdate,
            delete: jest.fn(),
        }));
        jest.doMock('../services/CallContextStore', () => ({
            hydrateCallRegistry,
            patchContext,
        }));
        jest.doMock('../services/CXStateRegistry', () => ({
            register: jest.fn(),
            delete: jest.fn(),
        }));
        jest.doMock('../Utils/telemetry', () => ({ emit: telemetryEmit }));
        jest.doMock('../services/workflowActionOutboxService', () => ({
            enqueueAndProcessDealerOrderSubmission,
            enqueueAndProcessBookingLinkDelivery,
            enqueueAndProcessHandoverFollowup,
            start: jest.fn(),
            stop: jest.fn(),
        }));
        jest.doMock('../services/workflowStateService', () => ({
            recordWorkflowStep,
            createWorkflowEventIdempotencyKey: jest.fn(({ callSID, workflowId, eventType, discriminator }) => (
                `${callSID}:${workflowId}:${eventType}:${discriminator}`
            )),
        }));
        jest.doMock('../services/bookingLinkProvider', () => ({
            buildBookingLink,
            resolveBookingProviderConfig,
        }));
        jest.doMock('../services/writeQueue', () => ({
            enqueue: writeQueueEnqueue,
        }));
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    function makeProvider() {
        return {
            name: 'twilio',
            getGateConfig: () => ({
                dynamicThresholdOffset: 0,
                silenceFramesThreshold: 10,
                energyOverrideThreshold: null,
                maxSilenceFailsafe: null,
            }),
            extractStartFields: (msg) => ({
                callId: msg.start.callSid,
                streamId: msg.start.streamSid,
                callerNumber: msg.start.from,
            }),
            requiresSessionConfigured: true,
            hasPreConnectBuffer: false,
            audioBufferStrategy: 'fifo-queue',
            hangup: jest.fn(),
        };
    }

    async function startSession() {
        hydrateCallRegistry.mockResolvedValueOnce({
            callId: 'CA99999999999999999999999999999999',
            sid: 'CA99999999999999999999999999999999',
            recipient: '+14155559999',
            phoneNumber: '+14155559999',
            provider: 'twilio',
            name: 'Apex Auto',
            persona: 'dealer-orders',
            language: 'en',
            aiProvider: 'azure-realtime',
            contextHint: null,
            policyConfig: null,
            requireExplicitRecordingConsent: false,
            status: 'connected',
        });

        const realtimeInstances = [];
        class FakeRealtimeService extends EventEmitter {
            constructor() {
                super();
                this.initialize = jest.fn();
                this.close = jest.fn();
                realtimeInstances.push(this);
            }
        }

        class FakeStreamService {
            setStreamId = jest.fn();
            stopCurrentAudio = jest.fn();
            startHoldMusic = jest.fn();
            stopHoldMusic = jest.fn();
            clearAudioTask = jest.fn();
        }

        const ws = new EventEmitter();
        const res = { accept: jest.fn().mockResolvedValue(ws) };
        const { createCallSession } = require('../session/createCallSession');

        await createCallSession(makeProvider(), {
            streamServiceClass: FakeStreamService,
            realtimeServiceClass: FakeRealtimeService,
        })({}, res);

        ws.emit('message', JSON.stringify({
            event: 'start',
            start: {
                callSid: 'CA99999999999999999999999999999999',
                streamSid: 'MZ99999999999999999999999999999999',
                from: '+14155559999',
            },
        }));
        await new Promise(resolve => setImmediate(resolve));

        const realtimeService = realtimeInstances[0];
        realtimeService.persona = { id: 'dealer-orders' };
        realtimeService.name = 'Apex Auto';
        realtimeService.recipient = '+14155559999';
        realtimeService.userPhone = '+14155559999';
        realtimeService.userEmail = 'orders@example.com';
        realtimeService._currentInteractionMode = 'INTERACTIVE';
        realtimeService.dealerOrder = {
            status: 'confirmed',
            orderId: 'DO-20260509-ABCDEF',
            items: [{ productName: 'filters', quantity: 10, unit: null }],
        };
        return realtimeService;
    }

    test('enqueues confirmed dealer order through durable outbox', async () => {
        enqueueAndProcessDealerOrderSubmission.mockResolvedValueOnce({
            ok: true,
            action: { id: 42, status: 'completed' },
            result: {
                erp: { status: 'sent', externalOrderId: 'ERP-42' },
                notifications: { ok: true, sentChannels: ['email'] },
            },
        });

        const realtimeService = await startSession();
        realtimeService.emit('dealer_order_confirmed', {
            callId: 'CA99999999999999999999999999999999',
            orderId: 'DO-20260509-ABCDEF',
            items: [{ productName: 'filters', quantity: 10, unit: null }],
            itemSummary: '10 filters',
            explicitConfirmationReceived: true,
            numericRepetitionReceived: true,
            sttConfidence: 0.96,
            interactionMode: 'INTERACTIVE',
        });
        await new Promise(resolve => setImmediate(resolve));

        expect(enqueueAndProcessDealerOrderSubmission).toHaveBeenCalledWith(expect.objectContaining({
            callId: 'CA99999999999999999999999999999999',
            orderId: 'DO-20260509-ABCDEF',
            dealerName: 'Apex Auto',
            dealerEmail: 'orders@example.com',
        }), expect.objectContaining({ allowed: true }), expect.objectContaining({
            lockId: expect.stringMatching(/^session-/),
        }));
        expect(realtimeService.dealerOrder).toEqual(expect.objectContaining({
            actionOutboxId: 42,
            actionStatus: 'completed',
            erpStatus: 'sent',
            erpExternalOrderId: 'ERP-42',
            notificationStatus: 'sent',
            notificationChannels: ['email'],
        }));
        expect(registryUpdate).toHaveBeenCalledWith('CA99999999999999999999999999999999', expect.objectContaining({
            dealerOrder: expect.objectContaining({ actionOutboxId: 42 }),
        }));
        expect(patchContext).toHaveBeenCalledWith('CA99999999999999999999999999999999', expect.objectContaining({
            dealerOrder: expect.objectContaining({ actionOutboxId: 42 }),
        }));
        expect(recordWorkflowStep).toHaveBeenCalledWith(expect.objectContaining({
            workflowId: 'dealer-orders',
            eventType: 'dealer_order_confirmed',
        }));
        expect(recordWorkflowStep).toHaveBeenCalledWith(expect.objectContaining({
            workflowId: 'dealer-orders',
            eventType: 'dealer_order_outbox_completed',
        }));
    });

    test('blocks unsafe dealer order before outbox enqueue', async () => {
        const realtimeService = await startSession();
        realtimeService.emit('dealer_order_confirmed', {
            callId: 'CA99999999999999999999999999999999',
            orderId: 'DO-20260509-ABCDEF',
            items: [{ productName: 'filters', quantity: 10, unit: null }],
            itemSummary: '10 filters',
            explicitConfirmationReceived: true,
            numericRepetitionReceived: false,
            sttConfidence: 0.96,
            interactionMode: 'INTERACTIVE',
        });
        await new Promise(resolve => setImmediate(resolve));

        expect(enqueueAndProcessDealerOrderSubmission).not.toHaveBeenCalled();
        expect(realtimeService.dealerOrder).toEqual(expect.objectContaining({
            status: 'blocked',
            actionStatus: 'blocked',
            guardFailures: expect.arrayContaining(['numeric_repetition_required']),
        }));
        expect(telemetryEmit).toHaveBeenCalledWith('transaction_policy_blocked', expect.objectContaining({
            actionType: 'dealer_order_submit',
            failures: expect.arrayContaining(['numeric_repetition_required']),
        }));
        expect(recordWorkflowStep).toHaveBeenCalledWith(expect.objectContaining({
            workflowId: 'dealer-orders',
            eventType: 'dealer_order_guard_blocked',
        }));
    });

    test('delivers booking links through durable outbox before persistence telemetry', async () => {
        resolveBookingProviderConfig.mockReturnValue({ provider: 'calendly' });
        buildBookingLink.mockReturnValue({
            ok: true,
            provider: 'calendly',
            url: 'https://book.example.com/demo?call=CA999',
            linkHash: 'booking-link-hash',
        });
        enqueueAndProcessBookingLinkDelivery.mockResolvedValueOnce({
            ok: true,
            status: 'sent',
            sentChannels: ['email'],
            attempts: [{
                channel: 'email',
                messageProvider: 'smtp',
                ok: true,
                status: 'sent',
                destinationHash: 'email-hash',
                externalMessageId: null,
            }],
        });

        const realtimeService = await startSession();
        realtimeService.persona = {
            id: 'booking-agent',
            contact: { bookingDeliveryEnabled: true, bookingCcEmail: 'ops@example.com' },
        };
        realtimeService.kb = { contact: { bookingDeliveryEnabled: true, bookingCcEmail: 'ops@example.com' } };
        realtimeService.preferredSlot = 'Tuesday morning';
        realtimeService.emit('booking_link_requested', {
            callId: 'CA99999999999999999999999999999999',
            callerName: 'Jane',
            callerNumber: '+14155559999',
            userEmail: 'jane@example.com',
            phoneConsent: false,
        });
        await new Promise(resolve => setImmediate(resolve));

        expect(enqueueAndProcessBookingLinkDelivery).toHaveBeenCalledWith(expect.objectContaining({
            callId: 'CA99999999999999999999999999999999',
            connectionId: expect.any(String),
            telecomProvider: 'twilio',
            userEmail: 'jane@example.com',
            bookingUrl: 'https://book.example.com/demo?call=CA999',
            bookingProvider: 'calendly',
            linkHash: 'booking-link-hash',
            ccEmail: 'ops@example.com',
            contact: expect.objectContaining({ bookingDeliveryEnabled: true }),
        }), expect.objectContaining({
            lockId: expect.stringMatching(/^session-/),
        }));
        expect(realtimeService.bookingLinkSent).toBe(true);
        expect(realtimeService.bookingLinkStatus).toBe('sent');
        expect(realtimeService.bookingDeliveryChannels).toEqual(['email']);
        expect(writeQueueEnqueue).toHaveBeenCalledWith(expect.objectContaining({
            type: 'persist_booking_delivery_event',
            channel: 'email',
            status: 'sent',
            destinationHash: 'email-hash',
        }));
        expect(telemetryEmit).toHaveBeenCalledWith('booking_link_sent', expect.objectContaining({
            channels: ['email'],
        }));
    });

    test('routes failed booking-link follow-up through handover outbox', async () => {
        resolveBookingProviderConfig.mockReturnValue({ provider: 'calendly' });
        buildBookingLink.mockReturnValue({
            ok: true,
            provider: 'calendly',
            url: 'https://book.example.com/demo?call=CA999',
            linkHash: 'booking-link-hash',
        });
        enqueueAndProcessBookingLinkDelivery.mockResolvedValueOnce({
            ok: false,
            status: 'failed',
            sentChannels: [],
            attempts: [{
                channel: 'email',
                messageProvider: 'smtp',
                ok: false,
                status: 'failed',
                failureReason: 'smtp_down',
                destinationHash: 'email-hash',
            }],
        });

        const realtimeService = await startSession();
        realtimeService.persona = {
            id: 'booking-agent',
            contact: { bookingDeliveryEnabled: true, notificationEmail: 'ops@example.com' },
        };
        realtimeService.kb = { contact: { bookingDeliveryEnabled: true, notificationEmail: 'ops@example.com' } };
        realtimeService.emit('booking_link_requested', {
            callId: 'CA99999999999999999999999999999999',
            callerName: 'Jane',
            callerNumber: '+14155559999',
            userEmail: 'jane@example.com',
        });
        await new Promise(resolve => setImmediate(resolve));

        expect(enqueueAndProcessHandoverFollowup).toHaveBeenCalledWith(expect.objectContaining({
            callId: 'CA99999999999999999999999999999999',
            attemptId: 'booking-link-booking-link-hash',
            followup: expect.objectContaining({
                reason: 'booking_link_delivery_failed',
                notificationEmail: 'ops@example.com',
                transferStatus: 'booking_link_delivery_failed',
            }),
        }), expect.objectContaining({
            lockId: expect.stringMatching(/^session-/),
        }));
        expect(telemetryEmit).toHaveBeenCalledWith('booking_link_failed', expect.objectContaining({
            reason: 'delivery_failed',
        }));
    });
});