'use strict';

const crypto = require('crypto');

describe('bookingWebhookAuth', () => {
    let bookingWebhookAuth;
    const originalSecret = process.env.BOOKING_WEBHOOK_SECRET;
    const originalCalendlySecret = process.env.CALENDLY_WEBHOOK_SECRET;
    const originalCalendlySigningKey = process.env.CALENDLY_WEBHOOK_SIGNING_KEY;
    const originalMicrosoftSecret = process.env.MICROSOFT_BOOKINGS_WEBHOOK_SECRET;

    function makeRes() {
        return {
            statusCode: null,
            body: null,
            status(code) { this.statusCode = code; return this; },
            json(body) { this.body = body; return this; },
        };
    }

    beforeEach(() => {
        jest.resetModules();
        process.env.BOOKING_WEBHOOK_SECRET = 'secret-123';
        process.env.CALENDLY_WEBHOOK_SECRET = 'calendly-secret';
        delete process.env.CALENDLY_WEBHOOK_SIGNING_KEY;
        process.env.MICROSOFT_BOOKINGS_WEBHOOK_SECRET = 'microsoft-secret';
        ({ bookingWebhookAuth } = require('../middleware/auth'));
    });

    afterAll(() => {
        if (originalSecret == null) delete process.env.BOOKING_WEBHOOK_SECRET;
        else process.env.BOOKING_WEBHOOK_SECRET = originalSecret;
        if (originalCalendlySecret == null) delete process.env.CALENDLY_WEBHOOK_SECRET;
        else process.env.CALENDLY_WEBHOOK_SECRET = originalCalendlySecret;
        if (originalCalendlySigningKey == null) delete process.env.CALENDLY_WEBHOOK_SIGNING_KEY;
        else process.env.CALENDLY_WEBHOOK_SIGNING_KEY = originalCalendlySigningKey;
        if (originalMicrosoftSecret == null) delete process.env.MICROSOFT_BOOKINGS_WEBHOOK_SECRET;
        else process.env.MICROSOFT_BOOKINGS_WEBHOOK_SECRET = originalMicrosoftSecret;
    });

    function calendlySignature(rawBody, timestamp, secret = 'calendly-secret') {
        const signature = crypto
            .createHmac('sha256', secret)
            .update(`${timestamp}.${rawBody}`)
            .digest('hex');
        return `t=${timestamp},v1=${signature}`;
    }

    function microsoftSignedClientState(callId, secret = 'microsoft-secret') {
        const signature = crypto
            .createHmac('sha256', secret)
            .update(`voicebot:${callId}`)
            .digest('hex');
        return `voicebot:${callId}|hmac:${signature}`;
    }

    test('accepts generic x-booking-webhook-secret header', () => {
        const req = { get: (name) => name === 'x-booking-webhook-secret' ? 'secret-123' : null, body: {} };
        const res = makeRes();
        const next = jest.fn();

        bookingWebhookAuth(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(res.statusCode).toBeNull();
    });

    test('accepts generic bearer token header', () => {
        const req = { get: (name) => name === 'authorization' ? 'Bearer secret-123' : null, body: {} };
        const res = makeRes();
        const next = jest.fn();

        bookingWebhookAuth(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
    });

    test('rejects missing or wrong generic secret', () => {
        const req = { get: () => null, body: {} };
        const res = makeRes();
        const next = jest.fn();

        bookingWebhookAuth(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(403);
    });

    test('allows provider validationToken handshake without webhook secret', () => {
        const req = { query: { validationToken: 'validate-me' }, get: () => null, body: {} };
        const res = makeRes();
        const next = jest.fn();

        bookingWebhookAuth(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(res.statusCode).toBeNull();
    });

    test('accepts valid Calendly signature over raw body', () => {
        const rawBody = JSON.stringify({ event: 'invitee.created', payload: { tracking: { utm_content: 'call-1' } } });
        const timestamp = Math.floor(Date.now() / 1000);
        const req = {
            query: { provider: 'calendly' },
            body: JSON.parse(rawBody),
            rawBody: Buffer.from(rawBody),
            get: (name) => name === 'Calendly-Webhook-Signature' ? calendlySignature(rawBody, timestamp) : null,
        };
        const res = makeRes();
        const next = jest.fn();

        bookingWebhookAuth(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(req.bookingWebhookVerification).toEqual(expect.objectContaining({ provider: 'calendly', mode: 'signature' }));
    });

    test('rejects Calendly webhook without raw body', () => {
        const rawBody = JSON.stringify({ event: 'invitee.created', payload: {} });
        const timestamp = Math.floor(Date.now() / 1000);
        const req = {
            query: { provider: 'calendly' },
            body: JSON.parse(rawBody),
            get: (name) => name === 'Calendly-Webhook-Signature' ? calendlySignature(rawBody, timestamp) : null,
        };
        const res = makeRes();
        const next = jest.fn();

        bookingWebhookAuth(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(403);
    });

    test('rejects Calendly webhook with invalid signature', () => {
        const rawBody = JSON.stringify({ event: 'invitee.created', payload: {} });
        const timestamp = Math.floor(Date.now() / 1000);
        const req = {
            query: { provider: 'calendly' },
            body: JSON.parse(rawBody),
            rawBody: Buffer.from(rawBody),
            get: (name) => name === 'Calendly-Webhook-Signature' ? `t=${timestamp},v1=bad` : null,
        };
        const res = makeRes();
        const next = jest.fn();

        bookingWebhookAuth(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(403);
    });

    test('rejects stale Calendly signature', () => {
        const rawBody = JSON.stringify({ event: 'invitee.created', payload: {} });
        const timestamp = Math.floor(Date.now() / 1000) - 1000;
        const req = {
            query: { provider: 'calendly' },
            body: JSON.parse(rawBody),
            rawBody: Buffer.from(rawBody),
            get: (name) => name === 'Calendly-Webhook-Signature' ? calendlySignature(rawBody, timestamp) : null,
        };
        const res = makeRes();
        const next = jest.fn();

        bookingWebhookAuth(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(403);
    });

    test('accepts Microsoft Bookings clientState secret', () => {
        const req = {
            query: { provider: 'microsoft-bookings' },
            get: () => null,
            body: { value: [{ clientState: 'microsoft-secret', changeType: 'created' }] },
        };
        const res = makeRes();
        const next = jest.fn();

        bookingWebhookAuth(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(req.bookingWebhookVerification).toEqual(expect.objectContaining({ provider: 'microsoft-bookings', mode: 'client_state' }));
    });

    test('accepts Microsoft Bookings signed clientState with call correlation', () => {
        const callId = 'CA11111111111111111111111111111111';
        const req = {
            query: { provider: 'microsoft-bookings' },
            get: () => null,
            body: { value: [{ clientState: microsoftSignedClientState(callId), changeType: 'created' }] },
        };
        const res = makeRes();
        const next = jest.fn();

        bookingWebhookAuth(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(req.bookingWebhookVerification).toEqual(expect.objectContaining({ provider: 'microsoft-bookings', mode: 'client_state' }));
    });

    test('rejects Microsoft Bookings signed clientState with wrong hmac', () => {
        const req = {
            query: { provider: 'microsoft-bookings' },
            get: () => null,
            body: { value: [{ clientState: microsoftSignedClientState('CA11111111111111111111111111111111', 'wrong-secret'), changeType: 'created' }] },
        };
        const res = makeRes();
        const next = jest.fn();

        bookingWebhookAuth(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(403);
    });

    test('rejects Microsoft Bookings wrong clientState', () => {
        const req = {
            query: { provider: 'microsoft-bookings' },
            get: () => null,
            body: { value: [{ clientState: 'secret-123', changeType: 'created' }] },
        };
        const res = makeRes();
        const next = jest.fn();

        bookingWebhookAuth(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(403);
    });
});
