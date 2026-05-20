'use strict';

// Isolate ConsentRepository from the real DB by mocking the db service
jest.mock('../services/db', () => ({
    query: jest.fn(),
}));

const db = require('../services/db');
const { recordConsent, hasValidConsent, revokeConsent } = require('../repositories/ConsentRepository');

describe('ConsentRepository', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    // ── recordConsent ──────────────────────────────────────────────────────

    describe('recordConsent', () => {
        test('inserts a granted event with all fields', async () => {
            db.query.mockResolvedValue({ affectedRows: 1 });
            await recordConsent('+12135551234', 'granted', 'CA123', 'persona-1');
            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('INSERT INTO consent_ledger'),
                ['+12135551234', 'granted', 'CA123', 'persona-1']
            );
        });

        test('inserts a revoked event', async () => {
            db.query.mockResolvedValue({ affectedRows: 1 });
            await recordConsent('+12135551234', 'revoked', null, null);
            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('INSERT INTO consent_ledger'),
                ['+12135551234', 'revoked', null, null]
            );
        });

        test('coerces undefined callSID and personaId to null', async () => {
            db.query.mockResolvedValue({ affectedRows: 1 });
            await recordConsent('+12135551234', 'granted');
            const [, args] = db.query.mock.calls[0];
            expect(args[2]).toBeNull();
            expect(args[3]).toBeNull();
        });
    });

    // ── hasValidConsent ────────────────────────────────────────────────────

    describe('hasValidConsent', () => {
        test('returns true when most-recent event is granted', async () => {
            db.query.mockResolvedValue([{ event: 'granted' }]);
            const result = await hasValidConsent('+12135551234');
            expect(result).toBe(true);
        });

        test('returns false when most-recent event is revoked', async () => {
            db.query.mockResolvedValue([{ event: 'revoked' }]);
            const result = await hasValidConsent('+12135551234');
            expect(result).toBe(false);
        });

        test('returns false when no row exists', async () => {
            db.query.mockResolvedValue([]);
            const result = await hasValidConsent('+12135551234');
            expect(result).toBe(false);
        });

        test('queries by phoneNumber', async () => {
            db.query.mockResolvedValue([{ event: 'granted' }]);
            await hasValidConsent('+19995551234');
            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('WHERE phoneNumber = ?'),
                ['+19995551234']
            );
        });

        test('selects most-recent event (ORDER BY createdAt DESC)', async () => {
            db.query.mockResolvedValue([{ event: 'granted' }]);
            await hasValidConsent('+12135551234');
            const [sql] = db.query.mock.calls[0];
            expect(sql).toMatch(/ORDER BY createdAt DESC/i);
            expect(sql).toMatch(/LIMIT 1/i);
        });
    });

    // ── revokeConsent ──────────────────────────────────────────────────────

    describe('revokeConsent', () => {
        test('delegates to recordConsent with event=revoked', async () => {
            db.query.mockResolvedValue({ affectedRows: 1 });
            await revokeConsent('+12135551234', 'CA456', 'persona-2');
            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('INSERT INTO consent_ledger'),
                ['+12135551234', 'revoked', 'CA456', 'persona-2']
            );
        });

        test('works with no callSID or personaId', async () => {
            db.query.mockResolvedValue({ affectedRows: 1 });
            await revokeConsent('+12135551234');
            const [, args] = db.query.mock.calls[0];
            expect(args[2]).toBeNull();
            expect(args[3]).toBeNull();
        });
    });
});
