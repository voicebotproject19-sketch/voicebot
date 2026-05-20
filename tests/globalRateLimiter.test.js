'use strict';

const {
    normalizeRequestPath,
    shouldSkipGlobalRateLimit,
} = require('../middleware/globalRateLimiter');

describe('global request limiter webhook exemptions', () => {
    test.each([
        ['POST', '/incoming-twilio'],
        ['POST', '/incoming-plivo'],
        ['POST', '/twilio-status'],
        ['POST', '/twilio-transfer-action'],
        ['POST', '/plivo-status'],
        ['GET', '/transfer-plivo'],
        ['POST', '/transfer-plivo'],
        ['POST', '/plivo-transfer-action'],
        ['POST', '/plivo-transfer-events'],
        ['GET', '/plivo-transfer-confirm'],
        ['POST', '/plivo-transfer-confirm'],
        ['GET', '/booking-webhook'],
        ['POST', '/booking-webhook'],
        ['GET', '/connection_twilio'],
        ['GET', '/connection_plivo'],
    ])('skips global limiter for %s %s', (method, originalUrl) => {
        expect(shouldSkipGlobalRateLimit({ method, originalUrl })).toBe(true);
    });

    test.each([
        ['POST', '/api/call'],
        ['POST', '/api/demobot/call'],
        ['GET', '/health'],
        ['GET', '/api/personas'],
        ['GET', '/incoming-twilio'],
    ])('keeps global limiter for %s %s', (method, originalUrl) => {
        expect(shouldSkipGlobalRateLimit({ method, originalUrl })).toBe(false);
    });

    test('normalizes query strings, casing, and trailing slash', () => {
        expect(normalizeRequestPath({ originalUrl: '/PLIVO-STATUS/?CallUUID=abc' })).toBe('/plivo-status');
        expect(shouldSkipGlobalRateLimit({ method: 'POST', originalUrl: '/PLIVO-STATUS/?CallUUID=abc' })).toBe(true);
    });
});
