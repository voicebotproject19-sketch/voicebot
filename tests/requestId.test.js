'use strict';

describe('requestId middleware', () => {
    let requestId;

    beforeEach(() => {
        jest.resetModules();
        requestId = require('../middleware/requestId');
    });

    function makeMocks(headers = {}) {
        const req = { headers };
        const res = { setHeader: jest.fn() };
        const next = jest.fn();
        return { req, res, next };
    }

    test('uses valid X-Request-Id when provided', () => {
        const { req, res, next } = makeMocks({ 'x-request-id': 'abc-123.test_id' });
        requestId(req, res, next);
        expect(req.id).toBe('abc-123.test_id');
        expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', 'abc-123.test_id');
        expect(next).toHaveBeenCalled();
    });

    test('generates new ID when header is missing', () => {
        const { req, res, next } = makeMocks({});
        requestId(req, res, next);
        expect(req.id).toMatch(/^[a-f0-9]{32}$/);
        expect(next).toHaveBeenCalled();
    });

    test('rejects X-Request-Id exceeding 128 chars', () => {
        const longId = 'a'.repeat(129);
        const { req, res, next } = makeMocks({ 'x-request-id': longId });
        requestId(req, res, next);
        expect(req.id).not.toBe(longId);
        expect(req.id).toMatch(/^[a-f0-9]{32}$/);
    });

    test('rejects X-Request-Id with invalid characters', () => {
        const { req, res, next } = makeMocks({ 'x-request-id': '<script>alert(1)</script>' });
        requestId(req, res, next);
        expect(req.id).toMatch(/^[a-f0-9]{32}$/);
    });

    test('accepts X-Request-Id with dots, dashes, underscores', () => {
        const { req, res, next } = makeMocks({ 'x-request-id': 'req-123_v2.final' });
        requestId(req, res, next);
        expect(req.id).toBe('req-123_v2.final');
    });

    test('rejects X-Request-Id with unicode characters', () => {
        const { req, res, next } = makeMocks({ 'x-request-id': 'req-✨-fancy' });
        requestId(req, res, next);
        expect(req.id).toMatch(/^[a-f0-9]{32}$/);
    });

    test('rejects X-Request-Id with newlines', () => {
        const { req, res, next } = makeMocks({ 'x-request-id': 'id\ninjection' });
        requestId(req, res, next);
        expect(req.id).toMatch(/^[a-f0-9]{32}$/);
    });

    test('rejects empty string X-Request-Id', () => {
        const { req, res, next } = makeMocks({ 'x-request-id': '' });
        requestId(req, res, next);
        expect(req.id).toMatch(/^[a-f0-9]{32}$/);
    });

    test('fallback ID is mirrored in response header', () => {
        const { req, res, next } = makeMocks({ 'x-request-id': '<bad>' });
        requestId(req, res, next);
        expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', req.id);
    });
});
