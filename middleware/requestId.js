'use strict';

const crypto = require('crypto');

/**
 * Middleware that assigns a unique request ID to every HTTP request.
 * - Uses the incoming `X-Request-Id` header if present (from load balancer / upstream).
 * - Otherwise generates a random 16-byte hex string.
 * - Sets the ID on `req.id` and as the `X-Request-Id` response header.
 */
const REQUEST_ID_PATTERN = /^[a-zA-Z0-9._\-]{1,128}$/;

function requestId(req, res, next) {
    const incoming = req.headers['x-request-id'];
    const id = (incoming && REQUEST_ID_PATTERN.test(incoming))
        ? incoming
        : crypto.randomBytes(16).toString('hex');
    req.id = id;
    res.setHeader('X-Request-Id', id);
    next();
}

module.exports = requestId;
