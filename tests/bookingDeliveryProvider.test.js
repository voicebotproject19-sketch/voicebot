'use strict';

jest.mock('../Helper/emailHelper', () => ({
    sendBookingLinkEmail: jest.fn(),
}));

jest.mock('../adapters/telecom/twilioClient', () => ({
    createTwilioClient: jest.fn(),
}));

jest.mock('../adapters/telecom/plivoClient', () => ({
    createPlivoClient: jest.fn(),
}));

const { sendBookingLinkEmail } = require('../Helper/emailHelper');
const { createTwilioClient } = require('../adapters/telecom/twilioClient');
const {
    normalizeDeliveryTarget,
    resolveBookingDeliveryConfig,
    sendBookingLink,
    sendBookingLinkChannel,
} = require('../services/bookingDeliveryProvider');

describe('bookingDeliveryProvider', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('defaults to disabled unless persona or global gate enables delivery', () => {
        const config = resolveBookingDeliveryConfig({}, {});

        expect(config.enabled).toBe(false);
        expect(config.order).toEqual(['sms', 'email']);
    });

    test('normalizes consented caller phone target', () => {
        const config = resolveBookingDeliveryConfig({ bookingDeliveryEnabled: true }, {
            BOOKING_SMS_ENABLED: 'true',
            BOOKING_SMS_REQUIRE_EXPLICIT_CONSENT: 'true',
            BOOKING_PHONE_DEFAULT_COUNTRY: 'US',
        });

        const target = normalizeDeliveryTarget('sms', {
            callerNumber: '(415) 555-1234',
            phoneConsent: true,
            phoneConsentTargetSource: 'caller',
        }, config);

        expect(target.ok).toBe(true);
        expect(target.destination).toBe('+14155551234');
        expect(target.destinationHash).toHaveLength(64);
    });

    test('blocks phone delivery when explicit consent is required but absent', () => {
        const config = resolveBookingDeliveryConfig({ bookingDeliveryEnabled: true }, {
            BOOKING_SMS_ENABLED: 'true',
            BOOKING_SMS_REQUIRE_EXPLICIT_CONSENT: 'true',
        });

        const target = normalizeDeliveryTarget('sms', {
            callerNumber: '+14155551234',
            phoneConsent: false,
        }, config);

        expect(target.ok).toBe(false);
        expect(target.failureReason).toBe('consent_required');
    });

    test('sends SMS through Twilio when configured and consented', async () => {
        const messagesCreate = jest.fn().mockResolvedValue({ sid: 'SM123' });
        createTwilioClient.mockReturnValue({ messages: { create: messagesCreate } });
        const config = resolveBookingDeliveryConfig({ bookingDeliveryEnabled: true }, {
            BOOKING_DELIVERY_ORDER: 'sms,email',
            BOOKING_SMS_ENABLED: 'true',
            BOOKING_MESSAGING_PROVIDER: 'twilio',
            TWILIO_ACCOUNT_SID: 'AC123',
            TWILIO_AUTH_TOKEN: 'token',
            TWILIO_MESSAGING_FROM: '+15550001111',
        });

        const result = await sendBookingLink({
            callerName: 'Jane',
            callerNumber: '+14155551234',
            phoneConsent: true,
            phoneConsentTargetSource: 'caller',
            bookingUrl: 'https://book.example.com/demo',
        }, config);

        expect(result.ok).toBe(true);
        expect(result.sentChannels).toContain('sms');
        expect(messagesCreate).toHaveBeenCalledWith(expect.objectContaining({
            from: '+15550001111',
            to: '+14155551234',
            body: expect.stringContaining('https://book.example.com/demo'),
        }));
        expect(result.attempts[0]).toEqual(expect.objectContaining({
            channel: 'sms',
            messageProvider: 'twilio',
            externalMessageId: 'SM123',
            status: 'sent',
        }));
    });

    test('Twilio messaging accepts account auth token and voice sender aliases', async () => {
        const messagesCreate = jest.fn().mockResolvedValue({ sid: 'SM456' });
        createTwilioClient.mockReturnValue({ messages: { create: messagesCreate } });
        const config = resolveBookingDeliveryConfig({ bookingDeliveryEnabled: true }, {
            BOOKING_SMS_ENABLED: 'true',
            BOOKING_MESSAGING_PROVIDER: 'twilio',
            TWILIO_ACCOUNT_SID: 'AC123',
            TWILIO_ACCOUNT_AUTH_TOKEN: 'account-token',
            TWILIO_FROM_NUMBER: '+15552223333',
        });

        const result = await sendBookingLink({
            callerNumber: '+14155551234',
            phoneConsent: true,
            bookingUrl: 'https://book.example.com/demo',
        }, config);

        expect(result.ok).toBe(true);
        expect(createTwilioClient).toHaveBeenCalledWith({ accountSid: 'AC123', authToken: 'account-token' });
        expect(messagesCreate).toHaveBeenCalledWith(expect.objectContaining({
            from: '+15552223333',
            to: '+14155551234',
        }));
    });

    test('falls back to email when SMS provider fails', async () => {
        createTwilioClient.mockReturnValue({ messages: { create: jest.fn().mockRejectedValue(new Error('down')) } });
        sendBookingLinkEmail.mockResolvedValue(true);
        const config = resolveBookingDeliveryConfig({ bookingDeliveryEnabled: true }, {
            BOOKING_DELIVERY_ORDER: 'sms,email',
            BOOKING_SMS_ENABLED: 'true',
            BOOKING_MESSAGING_PROVIDER: 'twilio',
            TWILIO_ACCOUNT_SID: 'AC123',
            TWILIO_AUTH_TOKEN: 'token',
            TWILIO_MESSAGING_FROM: '+15550001111',
        });

        const result = await sendBookingLink({
            callerName: 'Jane',
            callerNumber: '+14155551234',
            userEmail: 'jane@example.com',
            phoneConsent: true,
            bookingUrl: 'https://book.example.com/demo',
        }, config);

        expect(result.ok).toBe(true);
        expect(result.sentChannels).toEqual(['email']);
        expect(result.attempts).toEqual(expect.arrayContaining([
            expect.objectContaining({ channel: 'sms', status: 'failed', failureReason: 'provider_api_error' }),
            expect.objectContaining({ channel: 'email', status: 'sent', messageProvider: 'smtp' }),
        ]));
        expect(sendBookingLinkEmail).toHaveBeenCalledWith(expect.objectContaining({
            userEmail: 'jane@example.com',
            bookingUrl: 'https://book.example.com/demo',
        }));
    });

    test('sends only the requested single channel', async () => {
        sendBookingLinkEmail.mockResolvedValue(true);
        const config = resolveBookingDeliveryConfig({ bookingDeliveryEnabled: true }, {
            BOOKING_DELIVERY_ORDER: 'sms,email',
            BOOKING_SMS_ENABLED: 'true',
        });

        const attempt = await sendBookingLinkChannel({
            userEmail: 'jane@example.com',
            callerNumber: '+14155551234',
            phoneConsent: true,
            bookingUrl: 'https://book.example.com/demo',
        }, 'email', config);

        expect(attempt).toEqual(expect.objectContaining({
            channel: 'email',
            ok: true,
            status: 'sent',
            messageProvider: 'smtp',
        }));
        expect(sendBookingLinkEmail).toHaveBeenCalledTimes(1);
        expect(createTwilioClient).not.toHaveBeenCalled();
    });
});
