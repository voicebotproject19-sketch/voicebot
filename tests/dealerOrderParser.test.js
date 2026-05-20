'use strict';

const {
    createDealerOrderId,
    extractOrderItems,
    formatOrderItems,
    hasOrderReplacementIntent,
    isOrderConfirmation,
    isOrderSkip,
    mergeOrderItems,
    parseDealerContextHint,
} = require('../Helper/dealerOrderParser');

describe('dealerOrderParser', () => {
    test('extracts multiple spoken product quantities', () => {
        const items = extractOrderItems('I need ten cases of engine oil and 4 brake pads, plus two boxes of filters');
        expect(items).toEqual([
            { productName: 'engine oil', quantity: 10, unit: 'cases' },
            { productName: 'brake pads', quantity: 4, unit: null },
            { productName: 'filters', quantity: 2, unit: 'boxes' },
        ]);
        expect(formatOrderItems(items)).toBe('10 cases of engine oil, 4 brake pads and 2 boxes of filters');
    });

    test('merges duplicate products with matching units', () => {
        const merged = mergeOrderItems(
            [{ productName: 'engine oil', quantity: 3, unit: 'cases' }],
            [{ productName: 'Engine Oil', quantity: 2, unit: 'case' }]
        );
        expect(merged).toEqual([{ productName: 'engine oil', quantity: 5, unit: 'cases' }]);
    });

    test('detects confirmation, skip, and replacement intents', () => {
        expect(isOrderConfirmation('Yes, place the order')).toBe(true);
        expect(isOrderSkip('not now, call me later')).toBe(true);
        expect(hasOrderReplacementIntent('actually make it 12 cases of oil')).toBe(true);
    });

    test('parses JSON CRM context safely', () => {
        const context = parseDealerContextHint(JSON.stringify({
            dealerId: 'D-1',
            dealerName: 'Apex Auto',
            dealerEmail: 'ORDERS@EXAMPLE.COM',
            lastOrder: '8 filters',
            monthlyTargetPercent: 85,
            milestonePrompt: 'This order could unlock Tier 2 bonuses.',
            selfServiceUrl: 'https://orders.example.com',
        }));
        expect(context).toMatchObject({
            dealerId: 'D-1',
            dealerName: 'Apex Auto',
            dealerEmail: 'orders@example.com',
            monthlyTargetPercent: 85,
        });
    });

    test('generates stable-shape order IDs', () => {
        const id = createDealerOrderId(new Date('2026-05-09T00:00:00Z'), () => Buffer.from([0xab, 0xcd, 0xef]));
        expect(id).toBe('DO-20260509-ABCDEF');
    });
});
