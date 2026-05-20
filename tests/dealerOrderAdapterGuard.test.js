'use strict';

jest.mock('../Utils/telemetry', () => ({ emit: jest.fn() }));

const telemetry = require('../Utils/telemetry');
const BaseRealtimeAdapter = require('../adapters/ai/BaseRealtimeAdapter');

function makeAdapter(overrides = {}) {
    const adapter = Object.create(BaseRealtimeAdapter.prototype);
    Object.assign(adapter, {
        persona: { id: 'dealer-orders' },
        dealerOrder: {
            items: [{ productName: 'filters', quantity: 10, unit: null }],
            awaitingConfirmation: true,
            confirmed: false,
            skipped: false,
            status: 'awaiting_confirmation',
            lastSummary: '10 filters',
            crmContext: { dealerName: 'Apex Auto', dealerEmail: 'orders@example.com' },
        },
        callSID: 'CA11111111111111111111111111111111',
        _lastSttConfidence: 0.95,
        _currentInteractionMode: 'INTERACTIVE',
        _phase4Profile: null,
        _bargeInOccurred: false,
        conversationPhase: 'confirmation',
        userPhone: '+14155551234',
        recipient: '+14155551234',
        name: 'Apex Auto',
        userEmail: null,
        callContextHint: null,
        emit: jest.fn(),
    }, overrides);
    return adapter;
}

describe('dealer order adapter action guard', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('blocks low-confidence confirmation before emitting side-effect event', () => {
        const adapter = makeAdapter({ _lastSttConfidence: 0.2 });

        const response = adapter._handleDealerOrderTurn('yes place the order');

        expect(response.purpose).toBe('dealer_order_confirmation_guard');
        expect(adapter.dealerOrder.confirmed).toBe(false);
        expect(adapter.dealerOrder.status).toBe('awaiting_confirmation');
        expect(adapter.emit).not.toHaveBeenCalledWith('dealer_order_confirmed', expect.anything());
        expect(telemetry.emit).toHaveBeenCalledWith('transaction_policy_blocked', expect.objectContaining({
            actionType: 'dealer_order_submit',
            failures: expect.arrayContaining(['stt_confidence_below_threshold']),
        }));
    });

    test('emits confirmed dealer-order event with guard evidence when safe', () => {
        const adapter = makeAdapter();

        const response = adapter._handleDealerOrderTurn('yes place the order');

        expect(response.purpose).toBe('dealer_order_confirmation');
        expect(adapter.dealerOrder.confirmed).toBe(true);
        expect(adapter.emit).toHaveBeenCalledWith('dealer_order_confirmed', expect.objectContaining({
            orderId: expect.stringMatching(/^DO-/),
            explicitConfirmationReceived: true,
            numericRepetitionReceived: true,
            sttConfidence: 0.95,
            interactionMode: 'INTERACTIVE',
            actionGuard: expect.objectContaining({ allowed: true, failures: [] }),
        }));
    });
});