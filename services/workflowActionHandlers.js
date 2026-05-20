'use strict';

const { submitDealerOrder } = require('./dealerOrderService');
const { sendHandoverEmail } = require('../Helper/emailHelper');
const {
    resolveBookingDeliveryConfig,
    sendBookingLinkChannel,
} = require('./bookingDeliveryProvider');

const DEALER_ORDER_ACTION_TYPE = 'dealer_order_submit';
const BOOKING_LINK_ACTION_TYPE = 'booking_link_deliver';
const HANDOVER_FOLLOWUP_ACTION_TYPE = 'handover_followup_send';

function resolveEffectiveBookingDeliveryConfig(contact = {}, forceEmailOnly = false) {
    const config = resolveBookingDeliveryConfig(contact);
    if (!forceEmailOnly && config.enabled) return config;
    return {
        ...config,
        enabled: true,
        order: ['email'],
        smsEnabled: false,
        whatsappEnabled: false,
        emailEnabled: true,
    };
}

async function handleDealerOrderSubmit(action = {}) {
    const order = action.payloadJson?.order || {};
    const result = await submitDealerOrder(order);
    return { ok: true, result };
}

async function handleBookingLinkDeliver(action = {}) {
    const delivery = action.payloadJson?.delivery || {};
    const config = resolveEffectiveBookingDeliveryConfig(delivery.contact || {}, delivery.forceEmailOnly === true);
    const attempt = await sendBookingLinkChannel(delivery.context || {}, delivery.channel, config);
    if (!attempt.ok) {
        return { ok: false, reason: attempt.failureReason || 'booking_link_delivery_failed', result: { attempt } };
    }
    return { ok: true, result: { attempt } };
}

async function handleHandoverFollowupSend(action = {}) {
    const followup = action.payloadJson?.followup || {};
    const sent = await sendHandoverEmail(followup);
    if (!sent) {
        return {
            ok: false,
            reason: 'handover_followup_send_failed',
            result: { status: 'failed' },
        };
    }
    return { ok: true, result: { status: 'sent' } };
}

function createWorkflowActionHandlerRegistry(extraHandlers = {}) {
    const registry = new Map([
        [DEALER_ORDER_ACTION_TYPE, handleDealerOrderSubmit],
        [BOOKING_LINK_ACTION_TYPE, handleBookingLinkDeliver],
        [HANDOVER_FOLLOWUP_ACTION_TYPE, handleHandoverFollowupSend],
    ]);
    for (const [actionType, handler] of Object.entries(extraHandlers || {})) {
        if (typeof actionType === 'string' && typeof handler === 'function') registry.set(actionType, handler);
    }
    return registry;
}

const defaultWorkflowActionHandlers = createWorkflowActionHandlerRegistry();

async function executeWorkflowAction(action, registry = defaultWorkflowActionHandlers) {
    if (!action) return { ok: false, reason: 'missing_action' };
    const handler = registry instanceof Map ? registry.get(action.actionType) : null;
    if (typeof handler !== 'function') return { ok: false, reason: 'unsupported_action_type' };
    return handler(action);
}

module.exports = {
    BOOKING_LINK_ACTION_TYPE,
    DEALER_ORDER_ACTION_TYPE,
    HANDOVER_FOLLOWUP_ACTION_TYPE,
    createWorkflowActionHandlerRegistry,
    defaultWorkflowActionHandlers,
    executeWorkflowAction,
    handleBookingLinkDeliver,
    handleDealerOrderSubmit,
    handleHandoverFollowupSend,
    resolveEffectiveBookingDeliveryConfig,
};