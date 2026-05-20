'use strict';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    jest.resetModules();
});

describe('businessMetrics', () => {
    test('calculates call ROI from approved env estimates', () => {
        process.env.VOICEBOT_BOOKING_COMPLETED_VALUE_USD = '500';
        process.env.VOICEBOT_COST_PER_CALL_USD = '0.25';
        process.env.VOICEBOT_COST_PER_MINUTE_USD = '0.10';
        process.env.VOICEBOT_INPUT_TOKEN_COST_PER_1K_USD = '0.002';
        process.env.VOICEBOT_OUTPUT_TOKEN_COST_PER_1K_USD = '0.006';
        const { buildBusinessMetrics } = require('../Utils/businessMetrics');

        const metrics = buildBusinessMetrics({
            outcome: 'booking_completed',
            durationMs: 120000,
            inputTokens: 1000,
            outputTokens: 500
        });

        expect(metrics).toEqual(expect.objectContaining({
            estimatedRevenueUsd: 500,
            estimatedCostUsd: 0.455,
            estimatedGrossProfitUsd: 499.545,
            tokenCostUsd: 0.005,
            callTransportCostUsd: 0.45,
            revenueModel: 'env_estimate_v1',
            costModel: 'env_estimate_v1'
        }));
        expect(metrics.roiRatio).toBeCloseTo(1097.9011, 4);
    });

    test('emits webhook revenue without call transport cost', () => {
        process.env.VOICEBOT_BOOKING_COMPLETED_VALUE_USD = '250';
        process.env.VOICEBOT_REVENUE_MODEL = 'campaign_estimate_v2';
        const { buildRevenueMetrics } = require('../Utils/businessMetrics');

        expect(buildRevenueMetrics('booking_completed')).toEqual({
            estimatedRevenueUsd: 250,
            revenueModel: 'campaign_estimate_v2'
        });
    });

    test('maps dealer-order confirmation to approved env estimate', () => {
        process.env.VOICEBOT_DEALER_ORDER_CONFIRMED_VALUE_USD = '125.50';
        const { getRevenueForOutcome } = require('../Utils/businessMetrics');

        expect(getRevenueForOutcome('dealer_order_confirmed')).toBe(125.5);
        expect(getRevenueForOutcome('dealer_order_skipped')).toBe(0);
    });
});
