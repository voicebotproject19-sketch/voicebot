'use strict';

const { rateLimit } = require('express-rate-limit');

const WEBHOOK_RATE_LIMIT_EXEMPTIONS = Object.freeze(new Map([
    ['/incoming-twilio', new Set(['POST'])],
    ['/incoming-plivo', new Set(['POST'])],
    ['/twilio-status', new Set(['POST'])],
    ['/twilio-transfer-action', new Set(['POST'])],
    ['/plivo-status', new Set(['POST'])],
    ['/transfer-plivo', new Set(['GET', 'POST'])],
    ['/plivo-transfer-action', new Set(['POST'])],
    ['/plivo-transfer-events', new Set(['POST'])],
    ['/plivo-transfer-confirm', new Set(['GET', 'POST'])],
    ['/booking-webhook', new Set(['GET', 'POST'])],
    ['/connection_twilio', new Set(['GET'])],
    ['/connection_plivo', new Set(['GET'])],
]));

function normalizeRequestPath(req = {}) {
    const raw = String(req.originalUrl || req.url || req.path || '').split('?')[0] || '/';
    const withoutTrailingSlash = raw.length > 1 ? raw.replace(/\/+$/, '') : raw;
    return withoutTrailingSlash.toLowerCase();
}

function shouldSkipGlobalRateLimit(req = {}) {
    const methods = WEBHOOK_RATE_LIMIT_EXEMPTIONS.get(normalizeRequestPath(req));
    if (!methods) return false;
    return methods.has(String(req.method || 'GET').toUpperCase());
}

function createGlobalRequestLimiter() {
    return rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: 100,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        skip: shouldSkipGlobalRateLimit
    });
}

module.exports = {
    createGlobalRequestLimiter,
    normalizeRequestPath,
    shouldSkipGlobalRateLimit,
    WEBHOOK_RATE_LIMIT_EXEMPTIONS,
};
