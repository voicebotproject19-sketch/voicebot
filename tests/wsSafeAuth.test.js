'use strict';

describe('wsSafeAuth middleware wrapper', () => {
    let wsSafeAuth;

    beforeEach(() => {
        jest.resetModules();
        ({ wsSafeAuth } = require('../middleware/auth'));
    });

    function makeWsRes() {
        return {
            accept: jest.fn(),
            reject: jest.fn(),
            status: jest.fn(function () { return this; }),
            type: jest.fn(function () { return this; }),
            send: jest.fn(function () { return this; }),
            json: jest.fn(function () { return this; }),
        };
    }

    test('calls reject on WS response when middleware returns 403', () => {
        const innerMiddleware = (req, res, next) => {
            res.status(403).type('text/plain').send('Forbidden');
        };
        const wrapped = wsSafeAuth(innerMiddleware);

        const req = { headers: {}, get: () => null };
        const res = makeWsRes();
        const next = jest.fn();

        wrapped(req, res, next);

        expect(res.reject).toHaveBeenCalledWith(403);
        expect(next).not.toHaveBeenCalled();
    });

    test('calls next when middleware passes', () => {
        const innerMiddleware = (req, res, next) => next();
        const wrapped = wsSafeAuth(innerMiddleware);

        const req = { headers: {}, get: () => null };
        const res = makeWsRes();
        const next = jest.fn();

        wrapped(req, res, next);

        expect(res.reject).not.toHaveBeenCalled();
        expect(next).toHaveBeenCalled();
    });

    test('passes through to original middleware for non-WS responses', () => {
        const innerMiddleware = (req, res, next) => {
            res.status(403).type('text/plain').send('Forbidden');
        };
        const wrapped = wsSafeAuth(innerMiddleware);

        // Regular HTTP response (no accept/reject methods)
        const res = {
            status: jest.fn(function () { return this; }),
            type: jest.fn(function () { return this; }),
            send: jest.fn(function () { return this; }),
        };
        const req = { headers: {}, get: () => null };
        const next = jest.fn();

        wrapped(req, res, next);

        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.send).toHaveBeenCalledWith('Forbidden');
    });

    test('handles 500 status on WS response (server misconfiguration path)', () => {
        const innerMiddleware = (req, res, next) => {
            res.status(500).type('text/plain').send('Server misconfiguration');
        };
        const wrapped = wsSafeAuth(innerMiddleware);

        const req = { headers: {}, get: () => null };
        const res = makeWsRes();
        const next = jest.fn();

        wrapped(req, res, next);

        expect(res.reject).toHaveBeenCalledWith(500);
        expect(next).not.toHaveBeenCalled();
    });

    test('no-op chain is safe for repeated calls', () => {
        const innerMiddleware = (req, res, next) => {
            const chain = res.status(403);
            // Simulate repeated chaining
            chain.type('text/plain').send('a').end();
            chain.json({ error: true }).send('b');
        };
        const wrapped = wsSafeAuth(innerMiddleware);

        const req = { headers: {}, get: () => null };
        const res = makeWsRes();

        // Should not throw
        expect(() => wrapped(req, res, jest.fn())).not.toThrow();
        expect(res.reject).toHaveBeenCalledWith(403);
    });
});

describe('plivoWebhookAuth — WebSocket upgrade bypass', () => {
    let plivoWebhookAuth;
    const ORIG_TOKEN = process.env.PLIVO_AUTH_TOKEN;

    beforeEach(() => {
        jest.resetModules();
        process.env.PLIVO_AUTH_TOKEN = 'test-plivo-token';
        ({ plivoWebhookAuth } = require('../middleware/auth'));
    });

    afterEach(() => {
        if (ORIG_TOKEN !== undefined) process.env.PLIVO_AUTH_TOKEN = ORIG_TOKEN;
        else delete process.env.PLIVO_AUTH_TOKEN;
    });

    test('skips signature check on WebSocket upgrade request', () => {
        const req = {
            headers: { upgrade: 'websocket' },
            method: 'GET',
            originalUrl: '/connection_plivo',
            get: () => null,
        };
        const res = {
            status: jest.fn(function () { return this; }),
            type: jest.fn(function () { return this; }),
            send: jest.fn(function () { return this; }),
        };
        const next = jest.fn();

        plivoWebhookAuth(req, res, next);

        expect(next).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalled();
    });

    test('skips signature check with mixed-case Upgrade header', () => {
        const req = {
            headers: { upgrade: 'WebSocket' },
            method: 'GET',
            originalUrl: '/connection_plivo',
            get: () => null,
        };
        const res = {
            status: jest.fn(function () { return this; }),
            type: jest.fn(function () { return this; }),
            send: jest.fn(function () { return this; }),
        };
        const next = jest.fn();

        plivoWebhookAuth(req, res, next);

        expect(next).toHaveBeenCalled();
    });

    test('still validates signature on normal HTTP POST webhook', () => {
        const req = {
            headers: {},
            method: 'POST',
            originalUrl: '/plivo-status',
            protocol: 'https',
            body: {},
            get: (h) => {
                if (h === 'X-Plivo-Signature-V3') return null;
                if (h === 'X-Plivo-Signature-V3-Nonce') return null;
                if (h === 'x-forwarded-proto') return null;
                if (h === 'x-forwarded-host') return null;
                if (h === 'host') return 'voicebot.example.com';
                return null;
            },
        };
        const res = {
            status: jest.fn(function () { return this; }),
            type: jest.fn(function () { return this; }),
            send: jest.fn(function () { return this; }),
        };
        const next = jest.fn();

        plivoWebhookAuth(req, res, next);

        // Should reject — no signature headers on HTTP
        expect(res.status).toHaveBeenCalledWith(403);
        expect(next).not.toHaveBeenCalled();
    });

    test('rejects HTTP POST without Upgrade header even if no signature', () => {
        const req = {
            headers: {},
            method: 'POST',
            originalUrl: '/incoming-plivo',
            protocol: 'https',
            body: { CallUUID: 'test-uuid' },
            get: () => null,
        };
        const res = {
            status: jest.fn(function () { return this; }),
            type: jest.fn(function () { return this; }),
            send: jest.fn(function () { return this; }),
        };
        const next = jest.fn();

        plivoWebhookAuth(req, res, next);

        expect(res.status).toHaveBeenCalledWith(403);
        expect(next).not.toHaveBeenCalled();
    });
});
