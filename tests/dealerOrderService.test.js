'use strict';

jest.mock('../Helper/emailHelper', () => ({
    sendDealerOrderEmail: jest.fn(),
}));

jest.mock('../adapters/telecom/twilioClient', () => ({
    createTwilioClient: jest.fn(),
}));

jest.mock('../adapters/telecom/plivoClient', () => ({
    createPlivoClient: jest.fn(),
}));

jest.mock('../Utils/telemetry', () => ({ emit: jest.fn() }));

jest.mock('../services/callingWindowCheck', () => ({
    isWithinCallingWindow: jest.fn(() => true),
}));

const { sendDealerOrderEmail } = require('../Helper/emailHelper');
const { createTwilioClient } = require('../adapters/telecom/twilioClient');
const telemetry = require('../Utils/telemetry');
const {
    buildOrderPayload,
    handleDealerOrderMissedCall,
    resolveDealerOrderConfig,
    sendDealerOrderNotifications,
    submitDealerOrder,
} = require('../services/dealerOrderService');

const ORIGINAL_FETCH = global.fetch;

describe('dealerOrderService', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        global.fetch = jest.fn();
    });

    afterEach(() => {
        global.fetch = ORIGINAL_FETCH;
    });

    test('builds sanitized ERP payload from order and CRM context', () => {
        const payload = buildOrderPayload({
            orderId: 'DO-20260509-ABCDEF',
            callId: 'CA11111111111111111111111111111111',
            contextHint: JSON.stringify({
                dealerId: 'D-1024',
                dealerName: 'Apex Auto',
                dealerEmail: 'ORDERS@EXAMPLE.COM',
            }),
            items: [{ productName: 'Engine Oil', quantity: 10, unit: 'case' }],
        });

        expect(payload).toEqual(expect.objectContaining({
            orderId: 'DO-20260509-ABCDEF',
            callId: 'CA11111111111111111111111111111111',
            personaId: 'dealer-orders',
            dealerId: 'D-1024',
            dealerName: 'Apex Auto',
            dealerEmail: 'orders@example.com',
            itemSummary: '10 case of Engine Oil',
        }));
    });

    test('posts confirmed order to ERP and sends email confirmation', async () => {
        global.fetch.mockResolvedValue({
            ok: true,
            text: jest.fn().mockResolvedValue(JSON.stringify({ externalOrderId: 'ERP-9001' })),
        });
        sendDealerOrderEmail.mockResolvedValue(true);

        const config = {
            ...resolveDealerOrderConfig({ DEALER_ORDER_COMPANY_NAME: 'Acme Parts' }),
            erpEndpoint: 'https://erp.example.com/orders',
            erpAuthToken: 'secret-token',
            notificationEmail: 'ops@example.com',
            ccEmail: 'cc@example.com',
            selfServiceUrl: 'https://orders.example.com',
            deliveryOrder: ['email'],
            emailEnabled: true,
            smsEnabled: false,
        };

        const result = await submitDealerOrder({
            orderId: 'DO-20260509-ABCDEF',
            callId: 'CA22222222222222222222222222222222',
            dealerName: 'Apex Auto',
            dealerEmail: 'orders@example.com',
            dealerPhone: '+14155551234',
            items: [{ productName: 'engine oil', quantity: 10, unit: 'cases' }],
        }, config);

        expect(result.erp).toEqual(expect.objectContaining({
            ok: true,
            status: 'sent',
            externalOrderId: 'ERP-9001',
        }));
        expect(global.fetch).toHaveBeenCalledWith('https://erp.example.com/orders', expect.objectContaining({
            method: 'POST',
            headers: expect.objectContaining({
                Authorization: 'Bearer secret-token',
                'Content-Type': 'application/json',
            }),
            body: expect.stringContaining('DO-20260509-ABCDEF'),
        }));
        expect(sendDealerOrderEmail).toHaveBeenCalledWith(expect.objectContaining({
            dealerName: 'Apex Auto',
            dealerEmail: 'orders@example.com',
            ccEmail: 'ops@example.com',
            orderId: 'DO-20260509-ABCDEF',
        }));
        expect(telemetry.emit).toHaveBeenCalledWith('dealer_order_erp_logged', expect.objectContaining({
            callId: 'CA22222222222222222222222222222222',
            orderId: 'DO-20260509-ABCDEF',
            externalOrderId: 'ERP-9001',
        }));
        expect(telemetry.emit).toHaveBeenCalledWith('dealer_order_notification_sent', expect.objectContaining({
            callId: 'CA22222222222222222222222222222222',
            channels: ['email'],
        }));
    });

    test('falls back to email when SMS provider fails', async () => {
        createTwilioClient.mockReturnValue({
            messages: { create: jest.fn().mockRejectedValue(new Error('provider down')) },
        });
        sendDealerOrderEmail.mockResolvedValue(true);

        const result = await sendDealerOrderNotifications({
            orderId: 'DO-20260509-123456',
            dealerName: 'Apex Auto',
            dealerPhone: '+14155551234',
            dealerEmail: 'orders@example.com',
            itemSummary: '4 brake pads',
            items: [{ productName: 'brake pads', quantity: 4, unit: null }],
        }, {
            companyName: 'Acme Parts',
            selfServiceUrl: 'https://orders.example.com',
            notificationEmail: 'ops@example.com',
            ccEmail: null,
            deliveryOrder: ['sms', 'email'],
            smsEnabled: true,
            emailEnabled: true,
            messagingProvider: 'twilio',
            twilio: {
                accountSid: 'AC123',
                authToken: 'token',
                from: '+15550001111',
                messagingServiceSid: null,
            },
            plivo: {},
        });

        expect(result.ok).toBe(true);
        expect(result.sentChannels).toEqual(['email']);
        expect(result.attempts).toEqual(expect.arrayContaining([
            expect.objectContaining({ channel: 'sms', ok: false, failureReason: 'provider_api_error' }),
            expect.objectContaining({ channel: 'email', ok: true, messageProvider: 'smtp' }),
        ]));
        expect(sendDealerOrderEmail).toHaveBeenCalledWith(expect.objectContaining({
            dealerEmail: 'orders@example.com',
            orderId: 'DO-20260509-123456',
        }));
    });

    test('sends missed-call fallback SMS when retries are disabled', async () => {
        const messagesCreate = jest.fn().mockResolvedValue({ sid: 'SM777' });
        createTwilioClient.mockReturnValue({ messages: { create: messagesCreate } });

        const result = await handleDealerOrderMissedCall({
            callSID: 'CA33333333333333333333333333333333',
            provider: 'twilio',
            status: 'no-answer',
            callState: {
                persona: 'dealer-orders',
                phoneNumber: '+14155551234',
                name: 'Apex Auto',
            },
        }, {
            selfServiceUrl: 'https://orders.example.com/self-service',
            retryEnabled: false,
            maxRetries: 0,
            retryDelayMs: 1000,
            fallbackSmsEnabled: true,
            messagingProvider: 'twilio',
            twilio: {
                accountSid: 'AC123',
                authToken: 'token',
                from: '+15550001111',
                messagingServiceSid: null,
            },
            plivo: {},
        });

        expect(result).toEqual(expect.objectContaining({ ok: true, status: 'fallback_sent' }));
        expect(messagesCreate).toHaveBeenCalledWith(expect.objectContaining({
            from: '+15550001111',
            to: '+14155551234',
            body: expect.stringContaining('https://orders.example.com/self-service'),
        }));
        expect(telemetry.emit).toHaveBeenCalledWith('dealer_order_missed_call', expect.objectContaining({
            callId: 'CA33333333333333333333333333333333',
            status: 'no-answer',
        }));
        expect(telemetry.emit).toHaveBeenCalledWith('dealer_order_fallback_sent', expect.objectContaining({
            callId: 'CA33333333333333333333333333333333',
        }));
    });
});