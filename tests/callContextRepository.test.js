'use strict';

describe('CallContextRepository', () => {
    let db;
    let CallContextRepository;

    beforeEach(() => {
        jest.resetModules();
        jest.mock('../services/db', () => ({ query: jest.fn().mockResolvedValue([]), pool: {} }));
        db = require('../services/db');
        CallContextRepository = require('../repositories/CallContextRepository');
    });

    test('upserts initial call context with JSON policy and consent flag', async () => {
        const dealerOrder = {
            status: 'awaiting_confirmation',
            items: [{ productName: 'engine oil', quantity: 10, unit: 'cases' }]
        };

        await CallContextRepository.upsertInitialContext('CA11111111111111111111111111111111', {
            provider: 'twilio',
            phoneNumber: '+14155550111',
            name: 'Alex',
            persona: 'company-sales',
            language: 'en',
            aiProvider: 'azure-realtime',
            contextHint: JSON.stringify({ notes: 'x'.repeat(1800) }),
            policyConfig: { interruptionMinMs: 250 },
            requireExplicitRecordingConsent: true,
            dealerOrder
        });

        expect(db.query).toHaveBeenCalledTimes(1);
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain('INSERT INTO call_context_snapshots');
        expect(sql).toContain('ON DUPLICATE KEY UPDATE');
        expect(sql).toContain('dealerOrder');
        expect(params[0]).toBe('CA11111111111111111111111111111111');
        expect(params).toContain('twilio');
        expect(params).toContain(JSON.stringify({ interruptionMinMs: 250 }));
        expect(params).toContain(JSON.stringify(dealerOrder));
        expect(params).toContain(1);
    });

    test('parses stored policy config and boolean flags', async () => {
        db.query.mockResolvedValueOnce([{
            callSID: 'CA11111111111111111111111111111111',
            policyConfig: '{"interruptionMinMs":250}',
            dealerOrder: '{"status":"confirmed","orderId":"DO-20260509-ABCDEF"}',
            requireExplicitRecordingConsent: 1,
            providerTerminal: 1
        }]);

        const context = await CallContextRepository.getContext('CA11111111111111111111111111111111');

        expect(context).toEqual(expect.objectContaining({
            callSID: 'CA11111111111111111111111111111111',
            policyConfig: { interruptionMinMs: 250 },
            dealerOrder: { status: 'confirmed', orderId: 'DO-20260509-ABCDEF' },
            requireExplicitRecordingConsent: true,
            providerTerminal: true
        }));
    });
});
