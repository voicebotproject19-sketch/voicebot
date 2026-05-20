const crypto = require('crypto');
const twilio = require('twilio');
const plivo = require('plivo');
const { verifyBookingWebhookRequest } = require('../services/bookingWebhookVerifier');

function getRequestUrl(req) {
    const forwardedProto = (req.headers['x-forwarded-proto'] || '').toString().split(',')[0].trim();
    const protocol = forwardedProto || req.protocol || 'https';
    const host = req.headers['x-forwarded-host'] || req.get('host');
    return `${protocol}://${host}${req.originalUrl}`;
}

/**
 * Wrap an HTTP auth middleware so it works safely on WebSocket upgrade
 * requests. WebSocketExpress res.status() calls sendError() which rejects
 * the upgrade, but subsequent .type().send() calls would throw.
 */
function wsSafeAuth(httpMiddleware) {
    return function wsSafeMiddleware(req, res, next) {
        // If this is a WS upgrade, intercept res.status so the chain
        // after status() (e.g. .type().send()) becomes a harmless no-op.
        if (res.accept && typeof res.reject === 'function') {
            const origStatus = res.status.bind(res);
            res.status = function (code) {
                if (code >= 400) {
                    res.reject(code);
                    // Return a no-op chain so .type().send() doesn't throw
                    const noop = { type: () => noop, send: () => noop, json: () => noop, end: () => noop };
                    return noop;
                }
                return origStatus(code);
            };
        }
        return httpMiddleware(req, res, next);
    };
}

function twilioWebhookAuth(req, res, next) {
    const authToken = process.env.TWILIO_ACCOUNT_AUTH_TOKEN || process.env.TWILIO_AUTH_TOKEN;
    if (!authToken) {
        return res.status(500).type('text/plain').send('Server misconfiguration');
    }

    const signature = req.get('X-Twilio-Signature');
    if (!signature) {
        return res.status(403).type('text/plain').send('Forbidden');
    }

    const url = getRequestUrl(req);
    const params = req.body && typeof req.body === 'object' ? req.body : {};
    const valid = twilio.validateRequest(authToken, signature, url, params);

    if (!valid) {
        return res.status(403).type('text/plain').send('Forbidden');
    }

    return next();
}

function plivoWebhookAuth(req, res, next) {
    // Plivo does not send X-Plivo-Signature-V3 headers on WebSocket upgrade
    // requests (media-stream connections).  The WS endpoint URL is only
    // disclosed inside the <Stream> XML returned by the signature-validated
    // Answer URL, so it is not publicly discoverable.
    if (req.headers.upgrade && req.headers.upgrade.toLowerCase() === 'websocket') {
        return next();
    }

    const authToken = process.env.PLIVO_AUTH_TOKEN;
    if (!authToken) {
        return res.status(500).type('text/plain').send('Server misconfiguration');
    }

    const signature = req.get('X-Plivo-Signature-V3');
    const nonce = req.get('X-Plivo-Signature-V3-Nonce');
    if (!signature || !nonce) {
        console.warn('[plivoWebhookAuth] Missing signature headers on', req.method, req.originalUrl);
        return res.status(403).type('text/plain').send('Forbidden');
    }

    const url = getRequestUrl(req);
    const params = req.body && typeof req.body === 'object' ? req.body : {};
    const method = req.method;
    const valid = plivo.validateV3Signature(method, url, nonce, authToken, signature, params);

    if (!valid) {
        console.warn('[plivoWebhookAuth] Signature validation failed for', method, url);
        return res.status(403).type('text/plain').send('Forbidden');
    }

    return next();
}

function apiAuth(req, res, next) {
    const expectedApiKey = process.env.APP_API_KEY;
    if (!expectedApiKey) {
        return res.status(500).json({ error: 'Server misconfiguration' });
    }

    const providedApiKey = req.get('x-api-key');
    if (!providedApiKey || providedApiKey.length !== expectedApiKey.length) {
        return res.status(403).json({ error: 'Forbidden' });
    }

    const match = crypto.timingSafeEqual(
        Buffer.from(providedApiKey, 'utf8'),
        Buffer.from(expectedApiKey, 'utf8')
    );
    if (!match) {
        return res.status(403).json({ error: 'Forbidden' });
    }

    return next();
}

function bookingWebhookAuth(req, res, next) {
    if (req.query?.validationToken) return next();

    const verification = verifyBookingWebhookRequest(req, process.env);
    if (!verification.ok && verification.statusCode === 500) {
        return res.status(500).json({ error: 'Server misconfiguration' });
    }
    if (!verification.ok) {
        return res.status(403).json({ error: 'Forbidden' });
    }

    req.bookingWebhookVerification = verification;

    return next();
}

module.exports = {
    apiAuth,
    bookingWebhookAuth,
    plivoWebhookAuth,
    twilioWebhookAuth,
    wsSafeAuth
};
