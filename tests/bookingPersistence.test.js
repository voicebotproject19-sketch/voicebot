'use strict';

describe('BookingRepository', () => {
    let db;
    let BookingRepository;

    beforeEach(() => {
        jest.resetModules();
        jest.mock('../services/db', () => ({ query: jest.fn().mockResolvedValue([]), pool: {} }));
        db = require('../services/db');
        BookingRepository = require('../repositories/BookingRepository');
    });

    test('persists normalized booking event with deterministic dedupe key', async () => {
        const first = BookingRepository.buildDedupeKey({
            callSID: 'CA11111111111111111111111111111111',
            provider: 'calendly',
            externalBookingId: 'https://api.calendly.com/scheduled_events/abc',
            eventType: 'invitee.created',
            status: 'completed',
        });
        const second = BookingRepository.buildDedupeKey({
            callSID: 'CA11111111111111111111111111111111',
            provider: 'calendly',
            externalBookingId: 'https://api.calendly.com/scheduled_events/abc',
            eventType: 'invitee.created',
            status: 'completed',
        });

        await BookingRepository.persistBookingEvent({
            callSID: 'CA11111111111111111111111111111111',
            provider: 'calendly',
            externalBookingId: 'https://api.calendly.com/scheduled_events/abc',
            eventType: 'invitee.created',
            status: 'completed',
        });

        expect(first).toBe(second);
        expect(first).toHaveLength(64);
        expect(db.query).toHaveBeenCalledTimes(1);
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain('INSERT INTO booking_events');
        expect(sql).toContain('ON DUPLICATE KEY UPDATE');
        expect(params[1]).toBe('CA11111111111111111111111111111111');
        expect(params[2]).toBe('calendly');
        expect(params[4]).toBe('invitee.created');
        expect(params[5]).toBe('completed');
        expect(params[7]).toBeInstanceOf(Date);
        expect(params[8]).toBeNull();
    });

    test('normalizes unsupported status to unknown', async () => {
        await BookingRepository.persistBookingEvent({
            provider: 'microsoft-bookings',
            eventType: 'updated',
            status: 'rescheduled',
        });

        const params = db.query.mock.calls[0][1];
        expect(params[5]).toBe('unknown');
        expect(params[7]).toBeNull();
        expect(params[8]).toBeNull();
    });

    test('persists booking delivery event with delivery-specific dedupe key', async () => {
        const dedupe = BookingRepository.buildDeliveryDedupeKey({
            callSID: 'CA11111111111111111111111111111111',
            linkHash: 'abc123',
            channel: 'sms',
            destinationHash: 'dest-hash',
            status: 'sent',
            externalMessageId: 'SM123',
        });

        await BookingRepository.persistBookingDeliveryEvent({
            callSID: 'CA11111111111111111111111111111111',
            bookingProvider: 'calendly',
            linkHash: 'abc123',
            channel: 'sms',
            messageProvider: 'twilio',
            destinationHash: 'dest-hash',
            externalMessageId: 'SM123',
            status: 'sent',
        });

        expect(dedupe).toHaveLength(64);
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain('INSERT INTO booking_delivery_events');
        expect(params[1]).toBe('CA11111111111111111111111111111111');
        expect(params[2]).toBe('calendly');
        expect(params[4]).toBe('sms');
        expect(params[5]).toBe('twilio');
        expect(params[8]).toBe('sent');
        expect(params[10]).toBeInstanceOf(Date);
    });

    test('persists orphan booking webhook with reconciliation metadata', async () => {
        const dedupe = BookingRepository.buildOrphanDedupeKey({
            provider: 'calendly',
            externalBookingId: 'https://api.calendly.com/scheduled_events/abc',
            eventType: 'invitee.created',
            status: 'completed',
            rawCallSID: 'CA22222222222222222222222222222222',
            correlationStatus: 'invalid_correlation_token',
            orphanReason: 'booking_ref_call_id_mismatch',
        });

        await BookingRepository.persistBookingWebhookOrphan({
            provider: 'calendly',
            externalBookingId: 'https://api.calendly.com/scheduled_events/abc',
            eventType: 'invitee.created',
            status: 'completed',
            rawCallSID: 'CA22222222222222222222222222222222',
            correlationStatus: 'invalid_correlation_token',
            orphanReason: 'booking_ref_call_id_mismatch',
        });

        expect(dedupe).toHaveLength(64);
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain('INSERT INTO booking_webhook_orphans');
        expect(params[1]).toBe('calendly');
        expect(params[4]).toBe('completed');
        expect(params[5]).toBe('CA22222222222222222222222222222222');
        expect(params[6]).toBe('invalid_correlation_token');
        expect(params[7]).toBe('booking_ref_call_id_mismatch');
    });

    test('updates call outcome status without clearing call details', async () => {
        const OutcomeRepository = require('../repositories/OutcomeRepository');

        await OutcomeRepository.updateOutcomeStatus('CA11111111111111111111111111111111', 'booking_completed');

        expect(db.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO call_outcomes'), [
            'CA11111111111111111111111111111111',
            'booking_completed',
        ]);
    });
});

describe('booking webhook persistence queueing', () => {
    let MainController;
    let CallRegistry;
    let CallContextStore;
    let telemetry;
    let writeQueue;

    function makeRes() {
        return {
            statusCode: null,
            body: null,
            status(code) { this.statusCode = code; return this; },
            json(body) { this.body = body; return this; },
            type() { return this; },
            send(body) { this.body = body; return this; },
        };
    }

    beforeEach(() => {
        jest.resetModules();
        jest.mock('../services/db', () => ({ query: jest.fn().mockResolvedValue([]), pool: {} }));
        jest.mock('../services/CallRegistry', () => ({
            get: jest.fn(() => ({ callId: 'CA11111111111111111111111111111111' })),
            update: jest.fn(),
        }));
        jest.mock('../services/CallContextStore', () => ({
            patchContext: jest.fn().mockResolvedValue(true),
            upsertInitialContext: jest.fn().mockResolvedValue(true),
        }));
        jest.mock('../services/writeQueue', () => ({ enqueue: jest.fn(() => true) }));
        jest.mock('../Utils/telemetry', () => ({ emit: jest.fn() }));

        CallRegistry = require('../services/CallRegistry');
        CallContextStore = require('../services/CallContextStore');
        telemetry = require('../Utils/telemetry');
        writeQueue = require('../services/writeQueue');
        MainController = require('../Controller/MainController');
    });

    test('queues valid booking webhook for durable persistence', async () => {
        const req = {
            query: { provider: 'calendly' },
            body: {
                event: 'invitee.created',
                payload: {
                    uri: 'https://api.calendly.com/scheduled_events/abc/invitees/def',
                    tracking: { utm_content: 'CA11111111111111111111111111111111' },
                },
            },
        };
        const res = makeRes();

        await MainController.bookingWebhook(req, res);

        expect(res.statusCode).toBe(202);
        expect(writeQueue.enqueue).toHaveBeenCalledWith(expect.objectContaining({
            type: 'persist_booking_event',
            callSID: 'CA11111111111111111111111111111111',
            provider: 'calendly',
            eventType: 'invitee.created',
            status: 'completed',
        }));
        expect(writeQueue.enqueue).toHaveBeenCalledWith(expect.objectContaining({
            type: 'update_outcome_status',
            callSID: 'CA11111111111111111111111111111111',
            outcome: 'booking_completed',
        }));
        expect(CallRegistry.update).toHaveBeenCalledWith('CA11111111111111111111111111111111', expect.objectContaining({
            bookingStatus: 'completed',
            bookingProvider: 'calendly',
        }));
        expect(CallContextStore.patchContext).toHaveBeenCalledWith('CA11111111111111111111111111111111', expect.objectContaining({
            bookingStatus: 'completed',
            bookingProvider: 'calendly',
        }));
        expect(telemetry.emit).toHaveBeenCalledWith('booking_completed_webhook', expect.objectContaining({
            callId: 'CA11111111111111111111111111111111',
            provider: 'calendly',
        }));
    });

    test('orphan terminal booking webhook without call id is not counted as completion', async () => {
        const originalSecret = process.env.BOOKING_CORRELATION_SECRET;
        process.env.BOOKING_CORRELATION_SECRET = 'correlation-secret';
        try {
            const res = makeRes();

            await MainController.bookingWebhook({
                query: { provider: 'calendly' },
                body: {
                    event: 'invitee.created',
                    payload: {
                        uri: 'https://api.calendly.com/scheduled_events/abc/invitees/def',
                        tracking: {},
                    },
                },
            }, res);

            expect(res.statusCode).toBe(202);
            expect(writeQueue.enqueue).toHaveBeenCalledWith(expect.objectContaining({
                type: 'persist_booking_webhook_orphan',
                provider: 'calendly',
                eventType: 'invitee.created',
                status: 'completed',
                orphanReason: 'missing_booking_call_id',
            }));
            expect(writeQueue.enqueue).not.toHaveBeenCalledWith(expect.objectContaining({
                type: 'update_outcome_status',
            }));
            expect(telemetry.emit).toHaveBeenCalledWith('booking_webhook_orphaned', expect.objectContaining({
                provider: 'calendly',
                status: 'completed',
                reason: 'missing_booking_call_id',
            }));
            expect(telemetry.emit).not.toHaveBeenCalledWith('booking_completed_webhook', expect.anything());
            expect(CallRegistry.update).not.toHaveBeenCalled();
            expect(CallContextStore.patchContext).not.toHaveBeenCalled();
        } finally {
            if (originalSecret == null) delete process.env.BOOKING_CORRELATION_SECRET;
            else process.env.BOOKING_CORRELATION_SECRET = originalSecret;
        }
    });

    test('tampered signed booking correlation is orphaned instead of updating outcome', async () => {
        const originalSecret = process.env.BOOKING_CORRELATION_SECRET;
        process.env.BOOKING_CORRELATION_SECRET = 'correlation-secret';
        try {
            const { createBookingCorrelationToken } = require('../services/bookingLinkProvider');
            const token = createBookingCorrelationToken({
                callId: 'CA11111111111111111111111111111111',
                provider: 'calendly',
                issuedAtMs: Date.now(),
                nonce: 'test-nonce',
            }, 'correlation-secret');
            const res = makeRes();

            await MainController.bookingWebhook({
                query: { provider: 'calendly' },
                body: {
                    event: 'invitee.created',
                    payload: {
                        uri: 'https://api.calendly.com/scheduled_events/abc/invitees/def',
                        tracking: {
                            utm_content: 'CA22222222222222222222222222222222',
                            booking_ref: token,
                        },
                    },
                },
            }, res);

            expect(res.statusCode).toBe(202);
            expect(writeQueue.enqueue).toHaveBeenCalledWith(expect.objectContaining({
                type: 'persist_booking_webhook_orphan',
                rawCallSID: 'CA22222222222222222222222222222222',
                correlationStatus: 'invalid_correlation_token',
                orphanReason: 'booking_ref_call_id_mismatch',
            }));
            expect(writeQueue.enqueue).not.toHaveBeenCalledWith(expect.objectContaining({
                type: 'update_outcome_status',
            }));
            expect(telemetry.emit).not.toHaveBeenCalledWith('booking_completed_webhook', expect.anything());
        } finally {
            if (originalSecret == null) delete process.env.BOOKING_CORRELATION_SECRET;
            else process.env.BOOKING_CORRELATION_SECRET = originalSecret;
        }
    });

    test('returns validation token from POST booking webhook handshake', async () => {
        const res = makeRes();

        await MainController.bookingWebhook({ query: { validationToken: 'validate-me' }, body: {} }, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toBe('validate-me');
        expect(writeQueue.enqueue).not.toHaveBeenCalled();
    });

    test('emits provider error when booking persistence queue is full', async () => {
        writeQueue.enqueue.mockReturnValueOnce(false);
        const res = makeRes();

        await MainController.bookingWebhook({
            query: { provider: 'microsoft-bookings' },
            body: {
                value: [{
                    changeType: 'created',
                    clientState: 'voicebot:CA11111111111111111111111111111111',
                    resourceData: { id: 'booking-123' },
                }],
            },
        }, res);

        expect(res.statusCode).toBe(202);
        expect(telemetry.emit).toHaveBeenCalledWith('booking_provider_error', expect.objectContaining({
            callId: 'CA11111111111111111111111111111111',
            provider: 'microsoft-bookings',
            reason: 'write_queue_full',
        }));
    });

    test('emits provider error when booking outcome status queue is full', async () => {
        writeQueue.enqueue
            .mockReturnValueOnce(true)
            .mockReturnValueOnce(false);
        const res = makeRes();

        await MainController.bookingWebhook({
            query: { provider: 'calendly' },
            body: {
                event: 'invitee.created',
                payload: {
                    uri: 'https://api.calendly.com/scheduled_events/abc/invitees/def',
                    tracking: { utm_content: 'CA11111111111111111111111111111111' },
                },
            },
        }, res);

        expect(res.statusCode).toBe(202);
        expect(telemetry.emit).toHaveBeenCalledWith('booking_provider_error', expect.objectContaining({
            callId: 'CA11111111111111111111111111111111',
            provider: 'calendly',
            reason: 'write_queue_full',
            queueJob: 'update_outcome_status',
        }));
    });

    test('queues every Microsoft Bookings notification in a webhook batch', async () => {
        const res = makeRes();

        await MainController.bookingWebhook({
            query: { provider: 'microsoft-bookings' },
            body: {
                value: [
                    {
                        changeType: 'created',
                        clientState: 'voicebot:CA11111111111111111111111111111111',
                        resourceData: { id: 'booking-123' },
                    },
                    {
                        changeType: 'deleted',
                        clientState: 'voicebot:CA22222222222222222222222222222222',
                        resourceData: { id: 'booking-456' },
                    },
                ],
            },
        }, res);

        expect(res.statusCode).toBe(202);
        expect(res.body).toEqual(expect.objectContaining({ received: true, status: 'processed', count: 2 }));
        expect(writeQueue.enqueue).toHaveBeenCalledWith(expect.objectContaining({
            type: 'persist_booking_event',
            callSID: 'CA11111111111111111111111111111111',
            externalBookingId: 'booking-123',
            status: 'completed',
        }));
        expect(writeQueue.enqueue).toHaveBeenCalledWith(expect.objectContaining({
            type: 'persist_booking_event',
            callSID: 'CA22222222222222222222222222222222',
            externalBookingId: 'booking-456',
            status: 'cancelled',
        }));
        expect(writeQueue.enqueue).toHaveBeenCalledWith(expect.objectContaining({
            type: 'update_outcome_status',
            callSID: 'CA11111111111111111111111111111111',
            outcome: 'booking_completed',
        }));
        expect(writeQueue.enqueue).toHaveBeenCalledWith(expect.objectContaining({
            type: 'update_outcome_status',
            callSID: 'CA22222222222222222222222222222222',
            outcome: 'booking_cancelled',
        }));
    });

    test('booking delivery events use dedicated write queue job type', () => {
        const queued = writeQueue.enqueue({
            type: 'persist_booking_delivery_event',
            callSID: 'CA11111111111111111111111111111111',
            channel: 'email',
            status: 'sent',
        });

        expect(queued).toBe(true);
        expect(writeQueue.enqueue).toHaveBeenCalledWith(expect.objectContaining({
            type: 'persist_booking_delivery_event',
            channel: 'email',
            status: 'sent',
        }));
    });
});
