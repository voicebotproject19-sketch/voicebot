'use strict';

const {
    buildBookingLink,
    createBookingCorrelationToken,
    normalizeBookingWebhookPayload,
    normalizeBookingWebhookPayloads,
    resolveBookingProviderConfig,
    verifyBookingCorrelationToken,
} = require('../services/bookingLinkProvider');

describe('booking link provider', () => {
    test('is disabled when no provider URL is configured', () => {
        const config = resolveBookingProviderConfig({}, { BOOKING_PROVIDER: 'calendly' });
        const link = buildBookingLink({ callId: 'CA11111111111111111111111111111111' }, config);

        expect(config.enabled).toBe(false);
        expect(link.ok).toBe(false);
        expect(link.reason).toBe('booking_provider_unconfigured');
    });

    test('builds Calendly link with tracking but no PII by default', () => {
        const config = resolveBookingProviderConfig({
            bookingProvider: 'calendly',
            bookingUrl: 'https://calendly.com/acme/demo',
        }, {});

        const link = buildBookingLink({
            callId: 'CA11111111111111111111111111111111',
            callerName: 'Jane Caller',
            userEmail: 'jane@example.com',
            preferredSlot: 'Tuesday afternoon',
            personaId: 'company-sales',
        }, config);

        const url = new URL(link.url);
        expect(link.ok).toBe(true);
        expect(link.provider).toBe('calendly');
        expect(url.searchParams.get('call_id')).toBe('CA11111111111111111111111111111111');
        expect(url.searchParams.get('utm_source')).toBe('voicebot');
        expect(url.searchParams.get('preferred_slot')).toBe('Tuesday afternoon');
        expect(url.searchParams.has('email')).toBe(false);
        expect(url.searchParams.has('name')).toBe(false);
        expect(link.linkHash).toHaveLength(16);
    });

    test('builds signed booking correlation token when a correlation secret is configured', () => {
        const config = resolveBookingProviderConfig({
            bookingProvider: 'calendly',
            bookingUrl: 'https://calendly.com/acme/demo',
        }, {});
        config.bookingCorrelationSecret = 'correlation-secret';

        const link = buildBookingLink({
            callId: 'CA11111111111111111111111111111111',
            personaId: 'company-sales',
            issuedAtMs: 1778112000000,
            correlationNonce: 'test-nonce',
        }, config);

        const url = new URL(link.url);
        const bookingRef = url.searchParams.get('booking_ref');
        expect(bookingRef).toMatch(/^v1\./);

        const verified = verifyBookingCorrelationToken(bookingRef, {
            secret: 'correlation-secret',
            expectedProvider: 'calendly',
            nowMs: 1778112000000,
        });
        expect(verified).toEqual(expect.objectContaining({
            ok: true,
            callId: 'CA11111111111111111111111111111111',
            status: 'signed',
        }));
    });

    test('infers generic link provider from BOOKING_LINK_URL', () => {
        const config = resolveBookingProviderConfig({}, { BOOKING_LINK_URL: 'https://book.example.com/team' });

        expect(config.enabled).toBe(true);
        expect(config.provider).toBe('link');
    });

    test('can opt in to provider prefill fields', () => {
        const config = resolveBookingProviderConfig({
            bookingProvider: 'calendly',
            bookingUrl: 'https://calendly.com/acme/demo',
            bookingPrefillPII: true,
        }, {});

        const link = buildBookingLink({
            callerName: 'Jane Caller',
            userEmail: 'jane@example.com',
            userPhone: '+15551234567',
        }, config);

        const url = new URL(link.url);
        expect(url.searchParams.get('name')).toBe('Jane Caller');
        expect(url.searchParams.get('email')).toBe('jane@example.com');
        expect(url.searchParams.get('a1')).toBe('+15551234567');
    });

    test('normalizes Calendly invitee-created webhook payload', () => {
        const result = normalizeBookingWebhookPayload({
            event: 'invitee.created',
            payload: {
                uri: 'https://api.calendly.com/scheduled_events/abc/invitees/def',
                tracking: { utm_content: 'CA11111111111111111111111111111111' },
            },
        }, 'calendly');

        expect(result.ok).toBe(true);
        expect(result.provider).toBe('calendly');
        expect(result.status).toBe('completed');
        expect(result.callId).toBe('CA11111111111111111111111111111111');
    });

    test('normalizes signed Calendly webhook correlation', () => {
        const token = createBookingCorrelationToken({
            callId: 'CA11111111111111111111111111111111',
            provider: 'calendly',
            issuedAtMs: 1778112000000,
            nonce: 'test-nonce',
        }, 'correlation-secret');

        const result = normalizeBookingWebhookPayload({
            event: 'invitee.created',
            payload: {
                uri: 'https://api.calendly.com/scheduled_events/abc/invitees/def',
                tracking: {
                    utm_content: 'CA11111111111111111111111111111111',
                    booking_ref: token,
                },
            },
        }, 'calendly', {
            env: { BOOKING_CORRELATION_SECRET: 'correlation-secret' },
            nowMs: 1778112000000,
        });

        expect(result.ok).toBe(true);
        expect(result.callId).toBe('CA11111111111111111111111111111111');
        expect(result.correlationStatus).toBe('signed');
        expect(result.orphanReason).toBeNull();
    });

    test('rejects tampered Calendly call id when booking_ref is valid for another call', () => {
        const token = createBookingCorrelationToken({
            callId: 'CA11111111111111111111111111111111',
            provider: 'calendly',
            issuedAtMs: 1778112000000,
            nonce: 'test-nonce',
        }, 'correlation-secret');

        const result = normalizeBookingWebhookPayload({
            event: 'invitee.created',
            payload: {
                uri: 'https://api.calendly.com/scheduled_events/abc/invitees/def',
                tracking: {
                    utm_content: 'CA22222222222222222222222222222222',
                    booking_ref: token,
                },
            },
        }, 'calendly', {
            env: { BOOKING_CORRELATION_SECRET: 'correlation-secret' },
            nowMs: 1778112000000,
        });

        expect(result.ok).toBe(true);
        expect(result.callId).toBeNull();
        expect(result.rawCallId).toBe('CA22222222222222222222222222222222');
        expect(result.correlationStatus).toBe('invalid_correlation_token');
        expect(result.orphanReason).toBe('booking_ref_call_id_mismatch');
    });

    test('treats unsigned terminal webhook as orphan when correlation secret is configured', () => {
        const result = normalizeBookingWebhookPayload({
            event: 'invitee.created',
            payload: {
                uri: 'https://api.calendly.com/scheduled_events/abc/invitees/def',
                tracking: { utm_content: 'CA11111111111111111111111111111111' },
            },
        }, 'calendly', {
            env: { BOOKING_CORRELATION_SECRET: 'correlation-secret' },
            nowMs: 1778112000000,
        });

        expect(result.ok).toBe(true);
        expect(result.callId).toBeNull();
        expect(result.rawCallId).toBe('CA11111111111111111111111111111111');
        expect(result.correlationStatus).toBe('legacy_unsigned_rejected');
        expect(result.orphanReason).toBe('missing_booking_ref');
    });

    test('can temporarily attribute legacy unsigned webhooks in migration mode', () => {
        const result = normalizeBookingWebhookPayload({
            event: 'invitee.created',
            payload: {
                uri: 'https://api.calendly.com/scheduled_events/abc/invitees/def',
                tracking: { utm_content: 'CA11111111111111111111111111111111' },
            },
        }, 'calendly', {
            env: {
                BOOKING_CORRELATION_SECRET: 'correlation-secret',
                BOOKING_CORRELATION_LEGACY_MODE: 'attribute',
            },
            nowMs: 1778112000000,
        });

        expect(result.ok).toBe(true);
        expect(result.callId).toBe('CA11111111111111111111111111111111');
        expect(result.correlationStatus).toBe('legacy_unsigned');
        expect(result.orphanReason).toBeNull();
    });

    test('rejects stale booking_ref tokens', () => {
        const token = createBookingCorrelationToken({
            callId: 'CA11111111111111111111111111111111',
            provider: 'calendly',
            issuedAtMs: 1778112000000,
            nonce: 'test-nonce',
        }, 'correlation-secret');

        const result = verifyBookingCorrelationToken(token, {
            secret: 'correlation-secret',
            expectedProvider: 'calendly',
            nowMs: 1778112000000 + 2000,
            maxAgeSeconds: 1,
        });

        expect(result).toEqual(expect.objectContaining({
            ok: false,
            status: 'stale_correlation_token',
            reason: 'booking_ref_stale',
        }));
    });

    test('normalizes Microsoft Bookings Graph notification payload', () => {
        const result = normalizeBookingWebhookPayload({
            value: [{
                changeType: 'created',
                clientState: 'voicebot:CA11111111111111111111111111111111',
                resourceData: { id: 'booking-123' },
            }],
        }, 'microsoft-bookings');

        expect(result.ok).toBe(true);
        expect(result.provider).toBe('microsoft-bookings');
        expect(result.status).toBe('completed');
        expect(result.callId).toBe('CA11111111111111111111111111111111');
        expect(result.externalBookingId).toBe('booking-123');
    });

    test('normalizes every Microsoft Bookings Graph notification in a batch', () => {
        const results = normalizeBookingWebhookPayloads({
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
        }, 'microsoft-bookings');

        expect(results).toHaveLength(2);
        expect(results[0]).toEqual(expect.objectContaining({
            ok: true,
            callId: 'CA11111111111111111111111111111111',
            externalBookingId: 'booking-123',
            status: 'completed',
        }));
        expect(results[1]).toEqual(expect.objectContaining({
            ok: true,
            callId: 'CA22222222222222222222222222222222',
            externalBookingId: 'booking-456',
            status: 'cancelled',
        }));
    });
});
