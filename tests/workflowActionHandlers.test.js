'use strict';

describe('workflowActionHandlers', () => {
    let submitDealerOrder;
    let bookingDeliveryProvider;
    let sendHandoverEmail;
    let handlers;

    beforeEach(() => {
        jest.resetModules();
        submitDealerOrder = jest.fn();
        bookingDeliveryProvider = {
            resolveBookingDeliveryConfig: jest.fn(),
            sendBookingLinkChannel: jest.fn(),
        };
        sendHandoverEmail = jest.fn();
        jest.doMock('../services/dealerOrderService', () => ({ submitDealerOrder }));
        jest.doMock('../services/bookingDeliveryProvider', () => bookingDeliveryProvider);
        jest.doMock('../Helper/emailHelper', () => ({ sendHandoverEmail }));
        handlers = require('../services/workflowActionHandlers');
    });

    test('registers workflow handlers statically', () => {
        const registry = handlers.createWorkflowActionHandlerRegistry();

        expect(registry.has('dealer_order_submit')).toBe(true);
        expect(registry.has('booking_link_deliver')).toBe(true);
        expect(registry.has('handover_followup_send')).toBe(true);
    });

    test('executes dealer-order handler through registry', async () => {
        submitDealerOrder.mockResolvedValue({ erp: { status: 'sent' } });

        const result = await handlers.executeWorkflowAction({
            actionType: 'dealer_order_submit',
            payloadJson: { order: { orderId: 'DO-1' } },
        });

        expect(result).toEqual(expect.objectContaining({ ok: true, result: expect.objectContaining({ erp: expect.objectContaining({ status: 'sent' }) }) }));
        expect(submitDealerOrder).toHaveBeenCalledWith({ orderId: 'DO-1' });
    });

    test('executes single-channel booking-link handler through registry', async () => {
        bookingDeliveryProvider.resolveBookingDeliveryConfig.mockReturnValue({ enabled: true, emailEnabled: true });
        bookingDeliveryProvider.sendBookingLinkChannel.mockResolvedValue({ channel: 'email', ok: true, status: 'sent' });

        const result = await handlers.executeWorkflowAction({
            actionType: 'booking_link_deliver',
            payloadJson: { delivery: { context: { callId: 'CA1' }, channel: 'email', contact: { bookingDeliveryEnabled: true } } },
        });

        expect(result).toEqual({ ok: true, result: { attempt: { channel: 'email', ok: true, status: 'sent' } } });
        expect(bookingDeliveryProvider.sendBookingLinkChannel).toHaveBeenCalledWith(expect.objectContaining({ callId: 'CA1' }), 'email', expect.objectContaining({ enabled: true }));
    });

    test('executes handover follow-up handler through registry', async () => {
        sendHandoverEmail.mockResolvedValue(true);

        const result = await handlers.executeWorkflowAction({
            actionType: 'handover_followup_send',
            payloadJson: { followup: { callerName: 'Sarah', notificationEmail: 'ops@example.com' } },
        });

        expect(result).toEqual({ ok: true, result: { status: 'sent' } });
        expect(sendHandoverEmail).toHaveBeenCalledWith(expect.objectContaining({
            callerName: 'Sarah',
            notificationEmail: 'ops@example.com',
        }));
    });

    test('reports failed handover follow-up without throwing', async () => {
        sendHandoverEmail.mockResolvedValue(false);

        const result = await handlers.executeWorkflowAction({
            actionType: 'handover_followup_send',
            payloadJson: { followup: { notificationEmail: 'ops@example.com' } },
        });

        expect(result).toEqual({ ok: false, reason: 'handover_followup_send_failed', result: { status: 'failed' } });
    });

    test('rejects unsupported action types without executing side effects', async () => {
        const result = await handlers.executeWorkflowAction({ actionType: 'unknown_action', payloadJson: {} });

        expect(result).toEqual({ ok: false, reason: 'unsupported_action_type' });
        expect(submitDealerOrder).not.toHaveBeenCalled();
        expect(bookingDeliveryProvider.sendBookingLinkChannel).not.toHaveBeenCalled();
        expect(sendHandoverEmail).not.toHaveBeenCalled();
    });
});