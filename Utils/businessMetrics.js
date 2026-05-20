'use strict';

function readMoneyEnv(name) {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value >= 0 ? value : 0;
}

function roundMoney(value) {
    if (!Number.isFinite(value)) return 0;
    return Math.round(value * 10000) / 10000;
}

function getTokenCount(value) {
    const count = Number(value || 0);
    return Number.isFinite(count) && count > 0 ? count : 0;
}

function getRevenueForOutcome(outcome) {
    if (outcome === 'booking_completed') {
        return readMoneyEnv('VOICEBOT_BOOKING_COMPLETED_VALUE_USD');
    }
    if (outcome === 'booking_link_sent') {
        return readMoneyEnv('VOICEBOT_BOOKING_LINK_VALUE_USD');
    }
    if (outcome === 'booking_link_requested') {
        return readMoneyEnv('VOICEBOT_BOOKING_REQUEST_VALUE_USD');
    }
    if (outcome === 'dealer_order_confirmed') {
        return readMoneyEnv('VOICEBOT_DEALER_ORDER_CONFIRMED_VALUE_USD');
    }
    if (outcome === 'transfer_requested') {
        return readMoneyEnv('VOICEBOT_TRANSFER_REQUEST_VALUE_USD');
    }
    if (outcome === 'transferred') {
        return readMoneyEnv('VOICEBOT_TRANSFER_VALUE_USD');
    }
    return 0;
}

function getRevenueModel() {
    return process.env.VOICEBOT_REVENUE_MODEL || 'env_estimate_v1';
}

function getCostModel() {
    return process.env.VOICEBOT_COST_MODEL || 'env_estimate_v1';
}

function buildRevenueMetrics(outcome) {
    return {
        estimatedRevenueUsd: roundMoney(getRevenueForOutcome(outcome)),
        revenueModel: getRevenueModel()
    };
}

function buildBusinessMetrics({ outcome, durationMs, inputTokens = 0, outputTokens = 0 }) {
    const normalizedInputTokens = getTokenCount(inputTokens);
    const normalizedOutputTokens = getTokenCount(outputTokens);
    const durationMinutes = Number.isFinite(durationMs) && durationMs > 0 ? durationMs / 60000 : 0;

    const tokenCostUsd =
        (normalizedInputTokens / 1000) * readMoneyEnv('VOICEBOT_INPUT_TOKEN_COST_PER_1K_USD') +
        (normalizedOutputTokens / 1000) * readMoneyEnv('VOICEBOT_OUTPUT_TOKEN_COST_PER_1K_USD');
    const callTransportCostUsd =
        readMoneyEnv('VOICEBOT_COST_PER_CALL_USD') +
        durationMinutes * readMoneyEnv('VOICEBOT_COST_PER_MINUTE_USD');

    const estimatedRevenueUsd = getRevenueForOutcome(outcome);
    const estimatedCostUsd = tokenCostUsd + callTransportCostUsd;
    const estimatedGrossProfitUsd = estimatedRevenueUsd - estimatedCostUsd;

    return {
        estimatedRevenueUsd: roundMoney(estimatedRevenueUsd),
        estimatedCostUsd: roundMoney(estimatedCostUsd),
        estimatedGrossProfitUsd: roundMoney(estimatedGrossProfitUsd),
        tokenCostUsd: roundMoney(tokenCostUsd),
        callTransportCostUsd: roundMoney(callTransportCostUsd),
        roiRatio: estimatedCostUsd > 0 ? roundMoney(estimatedGrossProfitUsd / estimatedCostUsd) : null,
        revenueModel: getRevenueModel(),
        costModel: getCostModel()
    };
}

module.exports = {
    buildBusinessMetrics,
    buildRevenueMetrics,
    getRevenueForOutcome,
    roundMoney
};
