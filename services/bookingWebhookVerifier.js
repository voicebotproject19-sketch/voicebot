'use strict';

const crypto = require('crypto');
const { normalizeProvider } = require('./bookingLinkProvider');

const DEFAULT_SIGNATURE_TOLERANCE_SECONDS = 300;

function getHeader(req, name) {
    if (req && typeof req.get === 'function') return req.get(name);
    const headers = req?.headers || {};
    return headers[name.toLowerCase()] || headers[name] || null;
}

function extractBearerToken(value) {
    const match = String(value || '').match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : null;
}

function secureCompareString(actual, expected) {
    if (!actual || !expected || actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(
        Buffer.from(actual, 'utf8'),
        Buffer.from(expected, 'utf8')
    );
}

function parseCalendlySignatureHeader(value) {
    const parsed = {};
    String(value || '').split(',').forEach((part) => {
        const index = part.indexOf('=');
        if (index === -1) return;
        const key = part.slice(0, index).trim();
        const val = part.slice(index + 1).trim();
        if (key) parsed[key] = val;
    });
    return parsed;
}

function inferBookingWebhookProvider(req) {
    const hinted = normalizeProvider(req?.query?.provider || req?.body?.provider || req?.body?.event_provider);
    if (hinted !== 'disabled') return hinted;
    if (Array.isArray(req?.body?.value)) return 'microsoft-bookings';
    if (req?.body?.event || req?.body?.payload) return 'calendly';
    return 'link';
}

function getRawBodyString(req) {
    if (Buffer.isBuffer(req?.rawBody)) return req.rawBody.toString('utf8');
    if (typeof req?.rawBody === 'string') return req.rawBody;
    return null;
}

function verifyCalendlySignature(req, env = process.env, nowMs = Date.now()) {
    const secret = env.CALENDLY_WEBHOOK_SIGNING_KEY || env.CALENDLY_WEBHOOK_SECRET;
    if (!secret) return { ok: false, statusCode: 500, reason: 'calendly_secret_missing', provider: 'calendly' };

    const rawBody = getRawBodyString(req);
    if (rawBody == null) return { ok: false, statusCode: 403, reason: 'raw_body_missing', provider: 'calendly' };

    const signatureHeader = getHeader(req, 'Calendly-Webhook-Signature');
    const parsed = parseCalendlySignatureHeader(signatureHeader);
    const timestamp = Number(parsed.t);
    const signature = parsed.v1;

    if (!Number.isFinite(timestamp) || !signature) {
        return { ok: false, statusCode: 403, reason: 'calendly_signature_missing', provider: 'calendly' };
    }

    const toleranceSeconds = Number(env.CALENDLY_WEBHOOK_TOLERANCE_SECONDS) || DEFAULT_SIGNATURE_TOLERANCE_SECONDS;
    const ageSeconds = Math.abs(Math.floor(nowMs / 1000) - timestamp);
    if (ageSeconds > toleranceSeconds) {
        return { ok: false, statusCode: 403, reason: 'calendly_signature_stale', provider: 'calendly' };
    }

    const expected = crypto
        .createHmac('sha256', secret)
        .update(`${timestamp}.${rawBody}`)
        .digest('hex');

    if (!secureCompareString(signature, expected)) {
        return { ok: false, statusCode: 403, reason: 'calendly_signature_invalid', provider: 'calendly' };
    }

    return { ok: true, provider: 'calendly', mode: 'signature' };
}

function getMicrosoftClientState(req) {
    return req?.body?.clientState
        || (Array.isArray(req?.body?.value) ? req.body.value[0]?.clientState : null)
        || null;
}

function verifySignedClientState(clientState, expected) {
    const match = String(clientState || '').match(/^voicebot:([^|]+)\|hmac:([a-f0-9]{64})$/i);
    if (!match) return false;
    const callId = match[1];
    const signature = match[2].toLowerCase();
    const expectedSignature = crypto
        .createHmac('sha256', expected)
        .update(`voicebot:${callId}`)
        .digest('hex');
    return secureCompareString(signature, expectedSignature);
}

function verifyClientState(req, env = process.env, provider = 'microsoft-bookings') {
    const expected = provider === 'microsoft-bookings'
        ? (env.MICROSOFT_BOOKINGS_WEBHOOK_SECRET || env.BOOKING_WEBHOOK_SECRET)
        : env.BOOKING_WEBHOOK_SECRET;
    if (!expected) return { ok: false, statusCode: 500, reason: 'booking_webhook_secret_missing', provider };

    const clientState = getMicrosoftClientState(req);
    const valid = secureCompareString(String(clientState || ''), String(expected))
        || verifySignedClientState(clientState, String(expected));
    if (!valid) {
        return { ok: false, statusCode: 403, reason: 'client_state_invalid', provider };
    }

    return { ok: true, provider, mode: 'client_state' };
}

function verifySharedSecret(req, env = process.env, provider = 'link') {
    const expected = env.BOOKING_WEBHOOK_SECRET;
    if (!expected) return { ok: false, statusCode: 500, reason: 'booking_webhook_secret_missing', provider };

    const provided = getHeader(req, 'x-booking-webhook-secret')
        || extractBearerToken(getHeader(req, 'authorization'));

    if (!secureCompareString(String(provided || ''), String(expected))) {
        return { ok: false, statusCode: 403, reason: 'shared_secret_invalid', provider };
    }

    return { ok: true, provider, mode: 'shared_secret' };
}

function verifyBookingWebhookRequest(req, env = process.env, nowMs = Date.now()) {
    const provider = inferBookingWebhookProvider(req);
    if (provider === 'calendly') return verifyCalendlySignature(req, env, nowMs);
    if (provider === 'microsoft-bookings') return verifyClientState(req, env, provider);
    return verifySharedSecret(req, env, provider);
}

module.exports = {
    inferBookingWebhookProvider,
    parseCalendlySignatureHeader,
    verifyBookingWebhookRequest,
    verifyCalendlySignature,
    verifyClientState,
    verifySignedClientState,
    verifySharedSecret,
};
