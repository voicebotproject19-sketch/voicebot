'use strict';

const crypto = require('crypto');

const DISABLED_PROVIDER = 'disabled';
const DEFAULT_CORRELATION_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;
const SIGNED_CORRELATION_PREFIX = 'v1';

function normalizeProvider(provider) {
    const value = String(provider || '').trim().toLowerCase();
    if (!value || value === 'none' || value === 'off' || value === 'disabled') return DISABLED_PROVIDER;
    if (value === 'calendly') return 'calendly';
    if (value === 'microsoft' || value === 'microsoft-booking' || value === 'microsoft-bookings' || value === 'ms-bookings' || value === 'bookings') {
        return 'microsoft-bookings';
    }
    if (value === 'static' || value === 'url' || value === 'link') return 'link';
    return value;
}

function isTruthy(value) {
    return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function firstNonEmpty(...values) {
    return values.find(value => typeof value === 'string' && value.trim().length > 0)?.trim() || null;
}

function secureCompareString(actual, expected) {
    if (!actual || !expected || actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(
        Buffer.from(actual, 'utf8'),
        Buffer.from(expected, 'utf8')
    );
}

function base64UrlEncode(value) {
    return Buffer.from(String(value), 'utf8').toString('base64url');
}

function base64UrlDecode(value) {
    return Buffer.from(String(value), 'base64url').toString('utf8');
}

function isValidHttpUrl(value) {
    try {
        const url = new URL(String(value || ''));
        return url.protocol === 'https:' || url.protocol === 'http:';
    } catch (_) {
        return false;
    }
}

function resolveBookingProviderConfig(contact = {}, env = process.env) {
    const booking = contact && typeof contact.booking === 'object' && !Array.isArray(contact.booking)
        ? contact.booking
        : {};
    const configuredProvider = firstNonEmpty(
        booking.provider,
        contact.bookingProvider,
        env.BOOKING_PROVIDER
    );
    let provider = normalizeProvider(configuredProvider);

    const providerUrl = provider === 'calendly'
        ? env.CALENDLY_BOOKING_URL
        : provider === 'microsoft-bookings'
            ? env.MICROSOFT_BOOKINGS_URL
            : null;

    const url = firstNonEmpty(
        booking.url,
        contact.bookingUrl,
        contact.calendarUrl,
        env.BOOKING_LINK_URL,
        providerUrl,
        env.CALENDLY_BOOKING_URL,
        env.MICROSOFT_BOOKINGS_URL
    );

    if (provider === DISABLED_PROVIDER && url) {
        provider = url === env.CALENDLY_BOOKING_URL
            ? 'calendly'
            : url === env.MICROSOFT_BOOKINGS_URL
                ? 'microsoft-bookings'
                : 'link';
    }

    const prefillPII = booking.prefillPII != null
        ? booking.prefillPII === true
        : contact.bookingPrefillPII != null
            ? contact.bookingPrefillPII === true
            : isTruthy(env.BOOKING_LINK_PREFILL_PII);

    return {
        provider,
        url,
        enabled: provider !== DISABLED_PROVIDER && isValidHttpUrl(url),
        prefillPII,
        extraParams: booking.extraParams && typeof booking.extraParams === 'object' ? booking.extraParams : null,
    };
}

function setParam(url, key, value) {
    if (value == null || value === '') return;
    if (!url.searchParams.has(key)) url.searchParams.set(key, String(value));
}

function getCorrelationSecret(env = process.env, config = {}) {
    return firstNonEmpty(config.bookingCorrelationSecret, config.correlationSecret, env.BOOKING_CORRELATION_SECRET);
}

function getCorrelationMaxAgeSeconds(env = process.env) {
    const configured = Number(env.BOOKING_CORRELATION_MAX_AGE_SECONDS);
    return Number.isFinite(configured) && configured > 0
        ? configured
        : DEFAULT_CORRELATION_MAX_AGE_SECONDS;
}

function normalizeLegacyCorrelationMode(env = process.env) {
    const value = String(env.BOOKING_CORRELATION_LEGACY_MODE || '').trim().toLowerCase();
    if (['attribute', 'allow', 'accept'].includes(value)) return 'attribute';
    if (['orphan', 'reject', 'deny'].includes(value)) return 'orphan';
    return 'orphan';
}

function signCorrelationPayload(encodedPayload, secret) {
    return crypto.createHmac('sha256', secret).update(encodedPayload).digest('base64url');
}

function createBookingCorrelationToken({ callId, provider, issuedAtMs = Date.now(), nonce = null } = {}, secret = getCorrelationSecret()) {
    if (!callId || !secret) return null;
    const payload = {
        v: 1,
        c: String(callId),
        p: normalizeProvider(provider),
        iat: Math.floor(issuedAtMs / 1000),
        n: nonce || crypto.randomBytes(8).toString('hex')
    };
    const encodedPayload = base64UrlEncode(JSON.stringify(payload));
    const signature = signCorrelationPayload(encodedPayload, secret);
    return `${SIGNED_CORRELATION_PREFIX}.${encodedPayload}.${signature}`;
}

function verifyBookingCorrelationToken(token, options = {}) {
    const secret = options.secret || getCorrelationSecret(options.env || process.env, options.config || {});
    if (!secret) return { ok: false, status: 'correlation_disabled', reason: 'booking_correlation_secret_missing' };

    const parts = String(token || '').split('.');
    if (parts.length !== 3 || parts[0] !== SIGNED_CORRELATION_PREFIX) {
        return { ok: false, status: 'invalid_correlation_token', reason: 'malformed_booking_ref' };
    }

    const [, encodedPayload, signature] = parts;
    const expectedSignature = signCorrelationPayload(encodedPayload, secret);
    if (!secureCompareString(signature, expectedSignature)) {
        return { ok: false, status: 'invalid_correlation_token', reason: 'booking_ref_signature_invalid' };
    }

    let payload;
    try {
        payload = JSON.parse(base64UrlDecode(encodedPayload));
    } catch (_) {
        return { ok: false, status: 'invalid_correlation_token', reason: 'booking_ref_payload_invalid' };
    }

    const callId = typeof payload.c === 'string' && payload.c.trim() ? payload.c.trim() : null;
    const provider = normalizeProvider(payload.p);
    if (!callId) return { ok: false, status: 'invalid_correlation_token', reason: 'booking_ref_call_id_missing' };

    const expectedProvider = normalizeProvider(options.expectedProvider || provider);
    if (expectedProvider !== DISABLED_PROVIDER && provider !== expectedProvider) {
        return { ok: false, status: 'invalid_correlation_token', reason: 'booking_ref_provider_mismatch' };
    }

    const issuedAtSeconds = Number(payload.iat);
    const nowSeconds = Math.floor((options.nowMs || Date.now()) / 1000);
    const maxAgeSeconds = Number(options.maxAgeSeconds) || getCorrelationMaxAgeSeconds(options.env || process.env);
    if (!Number.isFinite(issuedAtSeconds) || issuedAtSeconds <= 0) {
        return { ok: false, status: 'invalid_correlation_token', reason: 'booking_ref_issued_at_invalid' };
    }
    if (nowSeconds - issuedAtSeconds > maxAgeSeconds || issuedAtSeconds - nowSeconds > 300) {
        return { ok: false, status: 'stale_correlation_token', reason: 'booking_ref_stale' };
    }

    return {
        ok: true,
        callId,
        provider,
        issuedAtSeconds,
        status: 'signed',
        reason: null
    };
}

function extractBookingRefFromString(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    if (/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(text)) return text;
    const prefixed = text.match(/(?:booking_ref|bookingRef)[:=]([^\s|&]+)/i);
    if (prefixed) return prefixed[1];
    try {
        const url = new URL(text);
        return url.searchParams.get('booking_ref') || url.searchParams.get('bookingRef') || null;
    } catch (_) {
        return null;
    }
}

function resolveBookingCorrelation({ provider, rawCallId, bookingRef, env = process.env, config = {}, nowMs = Date.now() } = {}) {
    const secret = getCorrelationSecret(env, config);
    const normalizedRawCallId = typeof rawCallId === 'string' && rawCallId.trim() ? rawCallId.trim() : null;

    if (bookingRef && secret) {
        const verified = verifyBookingCorrelationToken(bookingRef, {
            secret,
            expectedProvider: provider,
            env,
            config,
            nowMs
        });
        if (!verified.ok) {
            return {
                callId: null,
                rawCallId: normalizedRawCallId,
                bookingRefPresent: true,
                correlationStatus: verified.status,
                correlationReason: verified.reason
            };
        }
        if (normalizedRawCallId && normalizedRawCallId !== verified.callId) {
            return {
                callId: null,
                rawCallId: normalizedRawCallId,
                bookingRefPresent: true,
                correlationStatus: 'invalid_correlation_token',
                correlationReason: 'booking_ref_call_id_mismatch'
            };
        }
        return {
            callId: verified.callId,
            rawCallId: normalizedRawCallId || verified.callId,
            bookingRefPresent: true,
            correlationStatus: 'signed',
            correlationReason: null,
            correlationIssuedAtSeconds: verified.issuedAtSeconds
        };
    }

    if (bookingRef && !secret) {
        return {
            callId: normalizedRawCallId,
            rawCallId: normalizedRawCallId,
            bookingRefPresent: true,
            correlationStatus: 'legacy_unsigned_no_secret',
            correlationReason: normalizedRawCallId ? null : 'missing_booking_call_id'
        };
    }

    if (normalizedRawCallId && !secret) {
        return {
            callId: normalizedRawCallId,
            rawCallId: normalizedRawCallId,
            bookingRefPresent: false,
            correlationStatus: 'legacy_unsigned_no_secret',
            correlationReason: null
        };
    }

    if (normalizedRawCallId && normalizeLegacyCorrelationMode(env) === 'attribute') {
        return {
            callId: normalizedRawCallId,
            rawCallId: normalizedRawCallId,
            bookingRefPresent: false,
            correlationStatus: 'legacy_unsigned',
            correlationReason: null
        };
    }

    if (normalizedRawCallId) {
        return {
            callId: null,
            rawCallId: normalizedRawCallId,
            bookingRefPresent: false,
            correlationStatus: 'legacy_unsigned_rejected',
            correlationReason: 'missing_booking_ref'
        };
    }

    return {
        callId: null,
        rawCallId: null,
        bookingRefPresent: false,
        correlationStatus: 'missing_call_id',
        correlationReason: 'missing_booking_call_id'
    };
}

function buildBookingLink(params = {}, config = resolveBookingProviderConfig()) {
    const provider = normalizeProvider(config.provider);
    if (!config.enabled || !isValidHttpUrl(config.url)) {
        return { ok: false, provider, reason: 'booking_provider_unconfigured', url: null };
    }

    const url = new URL(config.url);
    setParam(url, 'utm_source', 'voicebot');
    setParam(url, 'utm_medium', 'phone');
    setParam(url, 'utm_content', params.callId);
    setParam(url, 'call_id', params.callId);
    setParam(url, 'persona', params.personaId);

    const correlationSecret = getCorrelationSecret(process.env, config);
    const bookingRef = createBookingCorrelationToken({
        callId: params.callId,
        provider,
        issuedAtMs: params.issuedAtMs || Date.now(),
        nonce: params.correlationNonce
    }, correlationSecret);
    setParam(url, 'booking_ref', bookingRef);

    if (params.preferredSlot) setParam(url, 'preferred_slot', params.preferredSlot);

    if (config.prefillPII) {
        if (provider === 'calendly') {
            setParam(url, 'name', params.callerName);
            setParam(url, 'email', params.userEmail);
            setParam(url, 'a1', params.userPhone || params.callerNumber);
            setParam(url, 'a2', params.preferredSlot);
        } else if (provider === 'microsoft-bookings') {
            setParam(url, 'customerName', params.callerName);
            setParam(url, 'customerEmail', params.userEmail);
            setParam(url, 'customerPhone', params.userPhone || params.callerNumber);
            setParam(url, 'notes', params.preferredSlot ? `Preferred slot: ${params.preferredSlot}` : null);
        } else {
            setParam(url, 'name', params.callerName);
            setParam(url, 'email', params.userEmail);
            setParam(url, 'phone', params.userPhone || params.callerNumber);
        }
    }

    if (config.extraParams) {
        for (const [key, value] of Object.entries(config.extraParams)) {
            setParam(url, key, value);
        }
    }

    return { ok: true, provider, reason: null, url: url.toString(), linkHash: hashBookingUrl(url.toString()) };
}

function hashBookingUrl(url) {
    return crypto.createHash('sha256').update(String(url || '')).digest('hex').slice(0, 16);
}

function extractCallIdFromString(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    const prefixed = text.match(/voicebot:([^\s|]+)/i);
    if (prefixed) return prefixed[1];
    if (/^(CA[0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$/.test(text)) return text;
    try {
        const url = new URL(text);
        return url.searchParams.get('call_id') || url.searchParams.get('utm_content') || null;
    } catch (_) {
        return null;
    }
}

function normalizeMicrosoftNotification(payload, notificationOverride = null, options = {}) {
    const notification = notificationOverride || (Array.isArray(payload?.value) ? payload.value[0] : null);
    if (!notification) return null;
    const rawCallId = extractCallIdFromString(notification.clientState)
        || extractCallIdFromString(payload.clientState)
        || extractCallIdFromString(notification.bookingUrl)
        || extractCallIdFromString(notification.url);
    const bookingRef = extractBookingRefFromString(notification.booking_ref)
        || extractBookingRefFromString(notification.bookingRef)
        || extractBookingRefFromString(notification.clientState)
        || extractBookingRefFromString(payload.clientState)
        || extractBookingRefFromString(notification.bookingUrl)
        || extractBookingRefFromString(notification.url);
    const correlation = resolveBookingCorrelation({
        provider: 'microsoft-bookings',
        rawCallId,
        bookingRef,
        env: options.env || process.env,
        config: options.config || {},
        nowMs: options.nowMs || Date.now()
    });
    return {
        provider: 'microsoft-bookings',
        eventType: notification.changeType || payload.changeType || 'unknown',
        status: /deleted|cancel/i.test(notification.changeType || '') ? 'cancelled' : 'completed',
        callId: correlation.callId,
        rawCallId: correlation.rawCallId,
        bookingRefPresent: correlation.bookingRefPresent,
        correlationStatus: correlation.correlationStatus,
        correlationReason: correlation.correlationReason,
        externalBookingId: notification.resourceData?.id || notification.resource || null,
    };
}

function isTerminalBookingStatus(status) {
    return status === 'completed' || status === 'cancelled';
}

function validateNormalizedBookingWebhook(normalized, fallbackProvider) {
    if (!normalized) {
        return { ok: false, reason: 'unsupported_booking_webhook', provider: fallbackProvider };
    }

    if (!normalized.eventType || normalized.eventType === 'unknown') {
        return { ok: false, reason: 'missing_booking_event_type', provider: normalized.provider };
    }

    const orphanReason = isTerminalBookingStatus(normalized.status) && !normalized.callId
        ? (normalized.correlationReason || 'missing_booking_call_id')
        : null;

    return { ok: true, ...normalized, orphanReason };
}

function normalizeCalendlyNotification(payload, options = {}) {
    const body = payload?.payload || payload || {};
    const tracking = body.tracking || {};
    const eventType = payload?.event || payload?.eventType || body.event_type || 'unknown';
    const rawCallId = extractCallIdFromString(tracking.utm_content)
        || extractCallIdFromString(tracking.call_id)
        || extractCallIdFromString(body.call_id)
        || extractCallIdFromString(body.scheduled_event?.uri)
        || extractCallIdFromString(body.uri);
    const bookingRef = extractBookingRefFromString(tracking.booking_ref)
        || extractBookingRefFromString(tracking.bookingRef)
        || extractBookingRefFromString(body.booking_ref)
        || extractBookingRefFromString(body.bookingRef)
        || extractBookingRefFromString(body.scheduled_event?.uri)
        || extractBookingRefFromString(body.uri);
    const correlation = resolveBookingCorrelation({
        provider: 'calendly',
        rawCallId,
        bookingRef,
        env: options.env || process.env,
        config: options.config || {},
        nowMs: options.nowMs || Date.now()
    });
    return {
        provider: 'calendly',
        eventType,
        status: /cancel/i.test(eventType) ? 'cancelled' : 'completed',
        callId: correlation.callId,
        rawCallId: correlation.rawCallId,
        bookingRefPresent: correlation.bookingRefPresent,
        correlationStatus: correlation.correlationStatus,
        correlationReason: correlation.correlationReason,
        externalBookingId: body.uri || body.scheduled_event?.uri || body.event || null,
    };
}

function normalizeBookingWebhookPayload(payload = {}, providerHint = null, options = {}) {
    return normalizeBookingWebhookPayloads(payload, providerHint, options)[0];
}

function normalizeBookingWebhookPayloads(payload = {}, providerHint = null, options = {}) {
    const hintedProvider = normalizeProvider(providerHint || payload.provider || payload.event_provider);
    if (hintedProvider === 'microsoft-bookings' || Array.isArray(payload?.value)) {
        const notifications = Array.isArray(payload?.value) ? payload.value : [];
        if (!notifications.length) {
            return [validateNormalizedBookingWebhook(null, 'microsoft-bookings')];
        }
        return notifications.map(notification => validateNormalizedBookingWebhook(
            normalizeMicrosoftNotification(payload, notification, options),
            'microsoft-bookings'
        ));
    }

    if (hintedProvider === 'calendly' || payload?.event || payload?.payload) {
        return [validateNormalizedBookingWebhook(normalizeCalendlyNotification(payload, options), 'calendly')];
    }

    return [validateNormalizedBookingWebhook(null, hintedProvider)];
}

module.exports = {
    buildBookingLink,
    createBookingCorrelationToken,
    extractBookingRefFromString,
    extractCallIdFromString,
    hashBookingUrl,
    normalizeBookingWebhookPayload,
    normalizeBookingWebhookPayloads,
    normalizeProvider,
    resolveBookingCorrelation,
    resolveBookingProviderConfig,
    verifyBookingCorrelationToken,
};
