'use strict';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
});

describe('callFinalizer', () => {
    let mockEmit;
    let mockEnqueue;
    let mockGet;
    let mockUpdate;

    beforeEach(() => {
        jest.resetModules();
        mockEmit = jest.fn();
        mockEnqueue = jest.fn(() => true);
        mockGet = jest.fn();
        mockUpdate = jest.fn();

        jest.doMock('../Utils/telemetry', () => ({ emit: mockEmit }));
        jest.doMock('../services/writeQueue', () => ({ enqueue: mockEnqueue }));
        jest.doMock('../services/CallRegistry', () => ({
            get: mockGet,
            update: mockUpdate
        }));
    });

    test('persists rich WebSocket call state and emits summary telemetry', () => {
        const { finalizeCall } = require('../services/callFinalizer');
        const callState = {
            startedAt: 1000,
            transcript: [{ sender: 'user', message: 'yes please send the link' }],
            phoneNumber: '+14155550111',
            provider: 'twilio'
        };
        const realtimeService = {
            persona: { id: 'company-sales' },
            userEmail: 'buyer@example.com',
            userPhone: '+14155550111',
            preferredSlot: null,
            conversationPhase: 'confirmation',
            count: 4,
            bookingLinkSent: true,
            bookingLinkStatus: 'sent',
            bookingProvider: 'calendly',
            bookingDeliveryPreference: 'sms',
            bookingPhoneDeliveryConsent: true,
            bookingDeliveryChannels: ['sms'],
            _handoverTriggered: false,
            totalInputTokens: 120,
            totalOutputTokens: 80,
            hasAskedForConsultation: true,
            _abCohort: 'experiment-a',
            providerName: 'azure-realtime',
            _modeCollapseRetries: 1
        };

        const result = finalizeCall({
            callSID: 'CA11111111111111111111111111111111',
            callState,
            realtimeService,
            callContextState: { lastSentimentPrimary: 'positive', phase4Profile: { name: 'default' } },
            edgeSession: { connectionId: 'conn-1', packetLossRatio: 0.02 },
            finalDegradationState: 'NORMAL',
            now: () => 2500
        });

        expect(result).toEqual(expect.objectContaining({
            ok: true,
            outcome: 'booking_link_sent',
            durationMs: 1500,
            degraded: false
        }));
        expect(mockEnqueue).toHaveBeenNthCalledWith(1, expect.objectContaining({
            type: 'persist_call',
            callSID: 'CA11111111111111111111111111111111',
            transcript: callState.transcript,
            durationMs: 1500
        }));
        expect(mockEnqueue).toHaveBeenNthCalledWith(2, expect.objectContaining({
            type: 'persist_outcome',
            callSID: 'CA11111111111111111111111111111111',
            outcome: 'booking_link_sent',
            personaId: 'company-sales',
            phoneNumber: '+14155550111',
            userEmail: 'buyer@example.com',
            conversationPhase: 'confirmation',
            degradationStateFinal: 'NORMAL'
        }));
        expect(mockEmit).toHaveBeenCalledWith('call_summary', expect.objectContaining({
            callId: 'CA11111111111111111111111111111111',
            outcome: 'booking_link_sent',
            bookingProvider: 'calendly',
            bookingLinkSent: true,
            bookingDeliveryChannels: ['sms'],
            userEmailPresent: true,
            turnCount: 4,
            estimatedRevenueUsd: 0,
            estimatedCostUsd: 0,
            abCohort: 'experiment-a'
        }));
        expect(mockEmit).toHaveBeenCalledWith('model_ab_outcome', expect.objectContaining({
            callId: 'CA11111111111111111111111111111111',
            cohort: 'experiment-a'
        }));
        expect(mockEmit).toHaveBeenCalledWith('call_finalization_completed', expect.objectContaining({
            callId: 'CA11111111111111111111111111111111',
            outcome: 'booking_link_sent',
            durationMs: 1500
        }));
        expect(mockUpdate).toHaveBeenCalledWith('CA11111111111111111111111111111111', expect.objectContaining({
            _finalizedAt: 2500,
            _finalizationOutcome: 'booking_link_sent'
        }));
    });

    test('maps provider-terminal fallback failures to abandoned outcome', () => {
        const { finalizeCall } = require('../services/callFinalizer');
        const callState = {
            createdAt: 1000,
            provider: 'twilio',
            providerTerminal: true,
            providerStatus: 'no-answer',
            phoneNumber: '+14155550111'
        };

        const result = finalizeCall({
            callSID: 'CA22222222222222222222222222222222',
            callState,
            source: 'provider_terminal_status',
            now: () => 3000
        });

        expect(result).toEqual(expect.objectContaining({
            ok: true,
            outcome: 'abandoned',
            degraded: true
        }));
        expect(mockEnqueue).toHaveBeenNthCalledWith(2, expect.objectContaining({
            type: 'persist_outcome',
            outcome: 'abandoned',
            conversationPhase: 'provider_terminal',
            durationMs: 2000
        }));
        expect(mockEmit).toHaveBeenCalledWith('call_finalization_degraded', expect.objectContaining({
            callId: 'CA22222222222222222222222222222222',
            reason: 'provider_terminal_fallback',
            provider: 'twilio',
            providerStatus: 'no-answer',
            outcome: 'abandoned'
        }));
        expect(mockEmit).toHaveBeenCalledWith('call_summary', expect.objectContaining({
            callId: 'CA22222222222222222222222222222222',
            provider: 'twilio',
            outcome: 'abandoned',
            conversationPhase: 'provider_terminal',
            estimatedRevenueUsd: 0,
            estimatedCostUsd: 0
        }));
    });

    test('maps accepted transfer request to transfer_requested instead of transferred', () => {
        const { finalizeCall } = require('../services/callFinalizer');
        const callState = {
            startedAt: 1000,
            provider: 'plivo',
            phoneNumber: '+14155550111'
        };
        const realtimeService = {
            persona: { id: 'company-sales' },
            conversationPhase: 'email-collection',
            count: 5,
            _handoverTriggered: true,
            _handoverTransferState: {
                triggered: true,
                requestAccepted: true,
                bridgeConfirmed: false,
            }
        };

        const result = finalizeCall({
            callSID: 'CA55555555555555555555555555555555',
            callState,
            realtimeService,
            now: () => 2500
        });

        expect(result).toEqual(expect.objectContaining({
            ok: true,
            outcome: 'transfer_requested'
        }));
        expect(mockEnqueue).toHaveBeenNthCalledWith(2, expect.objectContaining({
            type: 'persist_outcome',
            outcome: 'transfer_requested'
        }));
        expect(mockEmit).toHaveBeenCalledWith('call_summary', expect.objectContaining({
            callId: 'CA55555555555555555555555555555555',
            outcome: 'transfer_requested',
            transferred: false,
            transferRequested: true,
            transferRequestAccepted: true,
            transferBridgeConfirmed: false,
        }));
    });

    test('maps bridge-confirmed handover transfer to transferred', () => {
        const { finalizeCall } = require('../services/callFinalizer');
        const result = finalizeCall({
            callSID: 'CA88888888888888888888888888888888',
            callState: { startedAt: 1000, provider: 'twilio' },
            realtimeService: {
                conversationPhase: 'email-collection',
                _handoverTriggered: true,
                _handoverTransferState: {
                    triggered: true,
                    requestAccepted: true,
                    bridgeConfirmed: true,
                }
            },
            now: () => 2000
        });

        expect(result).toEqual(expect.objectContaining({
            ok: true,
            outcome: 'transferred'
        }));
        expect(mockEmit).toHaveBeenCalledWith('call_summary', expect.objectContaining({
            outcome: 'transferred',
            transferred: true,
            transferBridgeConfirmed: true,
            transferRequested: false,
        }));
    });

    test('maps confirmed dealer order to first-class outcome and ROI', () => {
        process.env.VOICEBOT_DEALER_ORDER_CONFIRMED_VALUE_USD = '125';
        const { finalizeCall } = require('../services/callFinalizer');

        const result = finalizeCall({
            callSID: 'CA12121212121212121212121212121212',
            callState: {
                startedAt: 1000,
                provider: 'twilio',
                phoneNumber: '+14155550121'
            },
            realtimeService: {
                persona: { id: 'dealer-orders' },
                conversationPhase: 'success',
                count: 3,
                dealerOrder: {
                    confirmed: true,
                    status: 'confirmed',
                    orderId: 'DO-20260509-ABCDEF',
                    items: [{ productName: 'engine oil', quantity: 10, unit: 'cases' }],
                    erpStatus: 'sent',
                    notificationStatus: 'sent'
                }
            },
            now: () => 2000
        });

        expect(result).toEqual(expect.objectContaining({
            ok: true,
            outcome: 'dealer_order_confirmed'
        }));
        expect(mockEnqueue).toHaveBeenNthCalledWith(2, expect.objectContaining({
            type: 'persist_outcome',
            outcome: 'dealer_order_confirmed',
            personaId: 'dealer-orders'
        }));
        expect(mockEmit).toHaveBeenCalledWith('call_summary', expect.objectContaining({
            outcome: 'dealer_order_confirmed',
            dealerOrderConfirmed: true,
            dealerOrderId: 'DO-20260509-ABCDEF',
            dealerOrderItemCount: 1,
            dealerOrderErpStatus: 'sent',
            dealerOrderNotificationStatus: 'sent',
            estimatedRevenueUsd: 125
        }));
    });

    test('uses hydrated registry dealer order when realtime service has no dealer-order state', () => {
        process.env.VOICEBOT_DEALER_ORDER_CONFIRMED_VALUE_USD = '125';
        const { finalizeCall } = require('../services/callFinalizer');

        const result = finalizeCall({
            callSID: 'CA13131313131313131313131313131313',
            callState: {
                startedAt: 1000,
                provider: 'plivo',
                phoneNumber: '+14155550131',
                dealerOrder: {
                    confirmed: true,
                    status: 'confirmed',
                    orderId: 'DO-HYDRATED-13',
                    items: [{ productName: 'brake pads', quantity: 4, unit: 'sets' }],
                    erpStatus: 'sent',
                    notificationStatus: 'sent'
                }
            },
            realtimeService: {
                persona: { id: 'dealer-orders' },
                conversationPhase: 'wrapup',
                count: 5,
            },
            now: () => 2200
        });

        expect(result).toEqual(expect.objectContaining({
            ok: true,
            outcome: 'dealer_order_confirmed'
        }));
        expect(mockEmit).toHaveBeenCalledWith('call_summary', expect.objectContaining({
            outcome: 'dealer_order_confirmed',
            dealerOrderConfirmed: true,
            dealerOrderId: 'DO-HYDRATED-13',
            dealerOrderItemCount: 1,
            dealerOrderErpStatus: 'sent',
            dealerOrderNotificationStatus: 'sent',
            estimatedRevenueUsd: 125
        }));
    });

    test('keeps provider-confirmed booking outcome ahead of dealer-order state', () => {
        const { finalizeCall } = require('../services/callFinalizer');

        const result = finalizeCall({
            callSID: 'CA14141414141414141414141414141414',
            callState: {
                startedAt: 1000,
                provider: 'twilio',
                bookingStatus: 'completed',
                dealerOrder: { confirmed: true, status: 'confirmed', orderId: 'DO-14' }
            },
            realtimeService: {
                persona: { id: 'dealer-orders' },
                conversationPhase: 'success',
                dealerOrder: { confirmed: true, status: 'confirmed', orderId: 'DO-14' }
            },
            now: () => 2000
        });

        expect(result).toEqual(expect.objectContaining({
            ok: true,
            outcome: 'booking_completed'
        }));
        expect(mockEnqueue).toHaveBeenNthCalledWith(2, expect.objectContaining({
            type: 'persist_outcome',
            outcome: 'booking_completed'
        }));
        expect(mockEmit).toHaveBeenCalledWith('call_summary', expect.objectContaining({
            outcome: 'booking_completed',
            bookingCompleted: true,
            dealerOrderConfirmed: true,
            dealerOrderId: 'DO-14'
        }));
    });

    test('maps skipped dealer order before generic rejected phase', () => {
        const { deriveCallOutcome } = require('../services/callFinalizer');

        expect(deriveCallOutcome({
            conversationPhase: 'rejected',
            dealerOrder: { skipped: true, status: 'skipped' }
        }, {})).toBe('dealer_order_skipped');
    });

    test('maps bridge-failed accepted request to transfer_failed', () => {
        const { finalizeCall } = require('../services/callFinalizer');
        const result = finalizeCall({
            callSID: 'CA99999999999999999999999999999999',
            callState: { startedAt: 1000, provider: 'plivo' },
            realtimeService: {
                conversationPhase: 'email-collection',
                _handoverTriggered: true,
                _handoverTransferState: {
                    triggered: true,
                    requestAccepted: true,
                    bridgeConfirmed: false,
                    bridgeFailed: true,
                }
            },
            now: () => 2000
        });

        expect(result).toEqual(expect.objectContaining({
            ok: true,
            outcome: 'transfer_failed'
        }));
        expect(mockEmit).toHaveBeenCalledWith('call_summary', expect.objectContaining({
            outcome: 'transfer_failed',
            transferFailed: true,
            transferRequestAccepted: true,
            transferBridgeFailed: true,
            transferred: false,
        }));
    });

    test('maps failed or invalid handover transfer to transfer_failed', () => {
        const { finalizeCall } = require('../services/callFinalizer');
        const result = finalizeCall({
            callSID: 'CA66666666666666666666666666666666',
            callState: { startedAt: 1000, provider: 'plivo' },
            realtimeService: {
                conversationPhase: 'email-collection',
                _handoverTriggered: true,
                _handoverTransferState: {
                    triggered: true,
                    invalidNumber: true,
                    requestAccepted: false,
                }
            },
            now: () => 2000
        });

        expect(result).toEqual(expect.objectContaining({
            ok: true,
            outcome: 'transfer_failed'
        }));
        expect(mockEmit).toHaveBeenCalledWith('call_summary', expect.objectContaining({
            outcome: 'transfer_failed',
            transferFailed: true,
            transferInvalidNumber: true,
            transferred: false,
        }));
    });

    test('maps handover with no valid transfer number to handover_fallback', () => {
        const { finalizeCall } = require('../services/callFinalizer');
        const result = finalizeCall({
            callSID: 'CA77777777777777777777777777777777',
            callState: { startedAt: 1000, provider: 'plivo' },
            realtimeService: {
                conversationPhase: 'email-collection',
                _handoverTriggered: true,
                _handoverTransferState: {
                    triggered: true,
                    fallbackUsed: true,
                    noTransferNumber: true,
                }
            },
            now: () => 2000
        });

        expect(result).toEqual(expect.objectContaining({
            ok: true,
            outcome: 'handover_fallback'
        }));
        expect(mockEmit).toHaveBeenCalledWith('call_summary', expect.objectContaining({
            outcome: 'handover_fallback',
            handoverFallback: true,
            transferFallbackUsed: true,
            transferred: false,
        }));
    });

    test('skips already-finalized calls without enqueueing duplicate jobs', () => {
        mockGet.mockReturnValue({
            _finalizedAt: 2000,
            _finalizationOutcome: 'completed'
        });
        const { finalizeCall } = require('../services/callFinalizer');

        const result = finalizeCall({ callSID: 'CA33333333333333333333333333333333' });

        expect(result).toEqual(expect.objectContaining({
            ok: true,
            skipped: true,
            reason: 'already_finalized',
            outcome: 'completed'
        }));
        expect(mockEnqueue).not.toHaveBeenCalled();
    });

    test('reports write-queue failure without marking call finalized', () => {
        mockEnqueue.mockReturnValueOnce(true).mockReturnValueOnce(false);
        const { finalizeCall } = require('../services/callFinalizer');

        const result = finalizeCall({
            callSID: 'CA44444444444444444444444444444444',
            callState: { startedAt: 1000, provider: 'twilio' },
            now: () => 2000
        });

        expect(result).toEqual(expect.objectContaining({
            ok: false,
            outcome: 'completed',
            callQueued: true,
            outcomeQueued: false
        }));
        expect(mockUpdate).toHaveBeenCalledWith('CA44444444444444444444444444444444', expect.objectContaining({
            _finalizationFailedAt: 2000,
            _finalizationOutcome: 'completed'
        }));
        expect(mockUpdate).not.toHaveBeenCalledWith('CA44444444444444444444444444444444', expect.objectContaining({
            _finalizedAt: expect.any(Number)
        }));
        expect(mockEmit).toHaveBeenCalledWith('call_finalization_degraded', expect.objectContaining({
            callId: 'CA44444444444444444444444444444444',
            reason: 'write_queue_full',
            outcomeQueued: false
        }));
    });
});
