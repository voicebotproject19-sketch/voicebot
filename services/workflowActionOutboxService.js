'use strict';

const crypto = require('crypto');
const Repository = require('../repositories/WorkflowActionOutboxRepository');
const {
    normalizeDeliveryTarget,
    resolveBookingDeliveryConfig,
} = require('./bookingDeliveryProvider');
const {
    BOOKING_LINK_ACTION_TYPE,
    DEALER_ORDER_ACTION_TYPE,
    HANDOVER_FOLLOWUP_ACTION_TYPE,
    defaultWorkflowActionHandlers,
    executeWorkflowAction,
    resolveEffectiveBookingDeliveryConfig,
} = require('./workflowActionHandlers');
const workflowState = require('./workflowStateService');
const telemetry = require('../Utils/telemetry');

const DEALER_ORDER_WORKFLOW_ID = 'dealer-orders';
const BOOKING_LINK_WORKFLOW_ID = 'booking-link-delivery';
const HANDOVER_FOLLOWUP_WORKFLOW_ID = 'handover-followup';

const DEFAULT_POLL_INTERVAL_MS = Number(process.env.ACTION_OUTBOX_POLL_INTERVAL_MS) || 5000;
const DEFAULT_MAX_BATCH = Number(process.env.ACTION_OUTBOX_MAX_BATCH) || 5;
const DEFAULT_RETRY_DELAY_MS = Number(process.env.ACTION_OUTBOX_RETRY_DELAY_MS) || 30000;

const state = {
    running: false,
    timer: null,
    processing: false,
    workerId: `action-outbox-${process.pid}`,
};

function normalizeKeyPart(value) {
    return String(value || 'none').trim() || 'none';
}

function safeJsonObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    try {
        return JSON.parse(JSON.stringify(value));
    } catch (_) {
        return {};
    }
}

function createDealerOrderIdempotencyKey(order = {}) {
    const raw = [
        normalizeKeyPart(order.callId || order.callSID),
        normalizeKeyPart(order.orderId),
        normalizeKeyPart(order.itemSummary),
    ].join('|');
    const digest = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 48);
    return `${DEALER_ORDER_ACTION_TYPE}:${digest}`;
}

function createBookingLinkDeliveryIdempotencyKey(delivery = {}) {
    const raw = [
        normalizeKeyPart(delivery.callId || delivery.callSID),
        normalizeKeyPart(delivery.linkHash),
        normalizeKeyPart(delivery.channel),
        normalizeKeyPart(delivery.destinationHash),
    ].join('|');
    const digest = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 48);
    return `${BOOKING_LINK_ACTION_TYPE}:${digest}`;
}

function createHandoverFollowupIdempotencyKey(followup = {}) {
    const raw = [
        normalizeKeyPart(followup.callId || followup.callSID),
        normalizeKeyPart(followup.attemptId),
        normalizeKeyPart(followup.reason),
        normalizeKeyPart(followup.transferStatus),
    ].join('|');
    const digest = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 48);
    return `${HANDOVER_FOLLOWUP_ACTION_TYPE}:${digest}`;
}

function buildDealerOrderPayload(order = {}, guard = {}) {
    return {
        version: 1,
        actionType: DEALER_ORDER_ACTION_TYPE,
        order: {
            ...order,
            callId: order.callId || order.callSID || null,
            personaId: order.personaId || DEALER_ORDER_WORKFLOW_ID,
        },
        guard: {
            allowed: guard.allowed === true,
            failures: Array.isArray(guard.failures) ? guard.failures : [],
            evaluatedAt: guard.evaluatedAt || new Date().toISOString(),
        },
    };
}

function buildBookingDeliveryContext(request = {}) {
    return {
        callId: request.callId || request.callSID || null,
        connectionId: request.connectionId || null,
        telecomProvider: request.telecomProvider || null,
        callerName: request.callerName || null,
        callerNumber: request.callerNumber || null,
        userPhone: request.userPhone || null,
        userEmail: request.userEmail || null,
        bookingUrl: request.bookingUrl || null,
        bookingProvider: request.bookingProvider || null,
        linkHash: request.linkHash || null,
        preferredSlot: request.preferredSlot || null,
        personaId: request.personaId || null,
        ccEmail: request.ccEmail || null,
        phoneConsent: request.phoneConsent === true,
        phoneConsentTargetSource: request.phoneConsentTargetSource || 'caller',
    };
}

function isBookingChannelEnabled(channel, config) {
    if (channel === 'email') return config.emailEnabled;
    if (channel === 'sms') return config.smsEnabled;
    if (channel === 'whatsapp') return config.whatsappEnabled;
    return false;
}

function buildDisabledBookingAttempt(channel, reason, destinationHash = null) {
    return {
        channel: channel || 'delivery',
        messageProvider: null,
        ok: false,
        status: 'failed',
        failureReason: reason || 'provider_unconfigured',
        destinationHash,
        externalMessageId: null,
    };
}

function buildBookingLinkDeliveryPayload(request = {}, plan = {}) {
    return {
        version: 1,
        actionType: BOOKING_LINK_ACTION_TYPE,
        delivery: {
            context: plan.context || buildBookingDeliveryContext(request),
            contact: safeJsonObject(request.contact),
            forceEmailOnly: plan.forceEmailOnly === true,
            channel: plan.channel,
            destinationHash: plan.destinationHash || null,
            targetSource: plan.targetSource || null,
            linkHash: plan.context?.linkHash || request.linkHash || null,
            bookingProvider: plan.context?.bookingProvider || request.bookingProvider || null,
        },
    };
}

function buildHandoverFollowupPayload(request = {}) {
    return {
        version: 1,
        actionType: HANDOVER_FOLLOWUP_ACTION_TYPE,
        followup: {
            ...(request.followup || {}),
            callId: request.callId || request.callSID || request.followup?.callId || null,
            connectionId: request.connectionId || request.followup?.connectionId || null,
            attemptId: request.attemptId || request.followup?.attemptId || null,
        },
    };
}

function summarizeBookingDeliveryAttempts(attempts = []) {
    const sentChannels = attempts.filter(attempt => attempt.ok).map(attempt => attempt.channel);
    return {
        ok: sentChannels.length > 0,
        status: sentChannels.length > 0 ? 'sent' : 'failed',
        attempts,
        sentChannels,
        failedChannels: attempts.filter(attempt => !attempt.ok).map(attempt => attempt.channel),
    };
}

function normalizeBookingAttemptResult(result = {}, plan = {}) {
    const action = result.action || plan.action || {};
    const delivery = action.payloadJson?.delivery || plan.delivery || {};
    const attempt = result.result?.attempt || action.resultJson?.attempt;
    if (attempt) return attempt;
    return buildDisabledBookingAttempt(
        delivery.channel || plan.channel,
        result.reason || result.error?.message || action.status || 'booking_link_delivery_pending',
        delivery.destinationHash || plan.destinationHash || null
    );
}

async function appendWorkflowActionEvent({ action, eventType, event = {} } = {}) {
    if (!action?.workflowId || !action?.callSID || !eventType) return null;
    const discriminator = [
        action.actionType,
        action.id || action.idempotencyKey || 'unknown',
        action.attemptCount == null ? 'na' : action.attemptCount,
        action.status || event.status || 'unknown',
    ].join(':');
    return workflowState.appendWorkflowEvent({
        callSID: action.callSID,
        workflowId: action.workflowId,
        eventType,
        idempotencyKey: workflowState.createWorkflowEventIdempotencyKey({
            callSID: action.callSID,
            workflowId: action.workflowId,
            eventType,
            discriminator,
        }),
        event: {
            actionId: action.id || null,
            actionType: action.actionType,
            status: action.status || null,
            ...event,
        },
    });
}

async function enqueueDealerOrderSubmission(order = {}, guard = {}) {
    const idempotencyKey = order.idempotencyKey || createDealerOrderIdempotencyKey(order);
    const action = await Repository.enqueueAction({
        callSID: order.callId || order.callSID || null,
        workflowId: DEALER_ORDER_WORKFLOW_ID,
        actionType: DEALER_ORDER_ACTION_TYPE,
        idempotencyKey,
        payload: buildDealerOrderPayload(order, guard),
        maxAttempts: order.maxAttempts || 3,
    });

    telemetry.emit('action_outbox_enqueued', {
        callId: order.callId || order.callSID || null,
        workflowId: DEALER_ORDER_WORKFLOW_ID,
        actionType: DEALER_ORDER_ACTION_TYPE,
        actionId: action?.id || null,
        status: action?.status || null,
        ts: Date.now(),
    });

    await appendWorkflowActionEvent({
        action,
        eventType: 'action_outbox_enqueued',
        event: { idempotencyKey, actionType: DEALER_ORDER_ACTION_TYPE },
    });

    return action;
}

async function enqueueBookingLinkDeliveryActions(request = {}) {
    const contact = safeJsonObject(request.contact);
    const context = buildBookingDeliveryContext(request);
    const initialConfig = resolveBookingDeliveryConfig(contact);
    const forceEmailOnly = request.forceEmailOnly === true || initialConfig.enabled !== true;
    const config = resolveEffectiveBookingDeliveryConfig(contact, forceEmailOnly);
    const attempts = [];
    const actions = [];

    for (const channel of config.order) {
        if (!isBookingChannelEnabled(channel, config)) {
            attempts.push(buildDisabledBookingAttempt(channel, 'channel_disabled'));
            continue;
        }

        const target = normalizeDeliveryTarget(channel, context, config);
        if (!target.ok) {
            attempts.push(buildDisabledBookingAttempt(channel, target.failureReason, target.destinationHash || null));
            continue;
        }

        const plan = {
            channel,
            context,
            destinationHash: target.destinationHash,
            targetSource: target.targetSource || null,
            forceEmailOnly,
        };
        const idempotencyKey = createBookingLinkDeliveryIdempotencyKey({
            callId: context.callId,
            linkHash: context.linkHash,
            channel,
            destinationHash: target.destinationHash,
        });
        const action = await Repository.enqueueAction({
            callSID: context.callId,
            workflowId: BOOKING_LINK_WORKFLOW_ID,
            actionType: BOOKING_LINK_ACTION_TYPE,
            idempotencyKey,
            payload: buildBookingLinkDeliveryPayload({ ...request, contact }, plan),
            maxAttempts: request.maxAttempts || 3,
        });

        telemetry.emit('action_outbox_enqueued', {
            callId: context.callId || null,
            workflowId: BOOKING_LINK_WORKFLOW_ID,
            actionType: BOOKING_LINK_ACTION_TYPE,
            actionId: action?.id || null,
            status: action?.status || null,
            channel,
            ts: Date.now(),
        });

        await appendWorkflowActionEvent({
            action,
            eventType: 'action_outbox_enqueued',
            event: { idempotencyKey, actionType: BOOKING_LINK_ACTION_TYPE, channel },
        });

        actions.push({ action, delivery: plan, channel, destinationHash: target.destinationHash });
    }

    return { actions, attempts };
}

async function enqueueHandoverFollowup(request = {}) {
    const followup = {
        ...(request.followup || {}),
        callId: request.callId || request.callSID || request.followup?.callId || null,
        connectionId: request.connectionId || request.followup?.connectionId || null,
        attemptId: request.attemptId || request.followup?.attemptId || null,
    };
    const idempotencyKey = request.idempotencyKey || createHandoverFollowupIdempotencyKey(followup);
    const action = await Repository.enqueueAction({
        callSID: followup.callId,
        workflowId: HANDOVER_FOLLOWUP_WORKFLOW_ID,
        actionType: HANDOVER_FOLLOWUP_ACTION_TYPE,
        idempotencyKey,
        payload: buildHandoverFollowupPayload({ ...request, followup }),
        maxAttempts: request.maxAttempts || 3,
    });

    telemetry.emit('action_outbox_enqueued', {
        callId: followup.callId || null,
        workflowId: HANDOVER_FOLLOWUP_WORKFLOW_ID,
        actionType: HANDOVER_FOLLOWUP_ACTION_TYPE,
        actionId: action?.id || null,
        status: action?.status || null,
        ts: Date.now(),
    });

    await appendWorkflowActionEvent({
        action,
        eventType: 'action_outbox_enqueued',
        event: { idempotencyKey, actionType: HANDOVER_FOLLOWUP_ACTION_TYPE },
    });

    return action;
}

async function executeAction(action) {
    return executeWorkflowAction(action, defaultWorkflowActionHandlers);
}

async function processAction(action, options = {}) {
    if (!action?.id) return { ok: false, reason: 'missing_action' };
    if (action.status === 'completed') return { ok: true, status: 'already_completed', action };
    if (action.status !== 'processing') return { ok: false, reason: `action_not_claimed:${action.status || 'unknown'}`, action };

    try {
        const execution = await executeAction(action);
        if (!execution.ok) {
            const err = new Error(execution.reason || 'workflow_action_execution_failed');
            err.resultPayload = execution.result || null;
            throw err;
        }
        const completed = await Repository.markActionCompleted(action.id, execution.result || {});
        telemetry.emit('action_outbox_completed', {
            callId: action.callSID || null,
            workflowId: action.workflowId,
            actionType: action.actionType,
            actionId: action.id,
            ts: Date.now(),
        });
        await appendWorkflowActionEvent({
            action: completed || action,
            eventType: 'action_outbox_completed',
            event: { result: execution.result || null },
        });
        return { ok: true, action: completed || action, result: execution.result || null };
    } catch (err) {
        const failed = await Repository.markActionFailed(action.id, err, {
            retryDelayMs: options.retryDelayMs || DEFAULT_RETRY_DELAY_MS,
        });
        telemetry.emit('action_outbox_failed', {
            callId: action.callSID || null,
            workflowId: action.workflowId,
            actionType: action.actionType,
            actionId: action.id,
            status: failed?.status || null,
            reason: err?.message || String(err),
            ts: Date.now(),
        });
        await appendWorkflowActionEvent({
            action: failed || action,
            eventType: 'action_outbox_failed',
            event: { reason: err?.message || String(err), result: err.resultPayload || null },
        });
        return { ok: false, action: failed || action, error: err, result: err.resultPayload || null };
    }
}

async function processActionById(id, options = {}) {
    const claimed = await Repository.claimAction(id, {
        lockId: options.lockId || state.workerId,
        lockTimeoutSeconds: options.lockTimeoutSeconds || 120,
    });
    if (!claimed) return { ok: false, reason: 'action_not_found' };
    if (claimed.status === 'completed') return { ok: true, status: 'already_completed', action: claimed };
    if (claimed._claimedByWorker === false && claimed.status === 'processing') {
        return { ok: true, status: 'already_processing', action: claimed };
    }
    if (claimed.status !== 'processing') return { ok: false, reason: `action_not_claimed:${claimed.status}`, action: claimed };
    telemetry.emit('action_outbox_claimed', {
        callId: claimed.callSID || null,
        workflowId: claimed.workflowId,
        actionType: claimed.actionType,
        actionId: claimed.id,
        ts: Date.now(),
    });
    return processAction(claimed, options);
}

async function requeueWorkflowAction(actionId, options = {}) {
    const action = await Repository.requeueAction(actionId, {
        reason: options.reason || 'operator_requeue',
        availableAt: options.availableAt || null,
        lockTimeoutSeconds: options.lockTimeoutSeconds || 120,
    });
    if (!action) return { ok: false, reason: 'action_not_found' };
    if (action._requeued === false) {
        return { ok: false, reason: `action_not_requeueable:${action.status || 'unknown'}`, action };
    }

    telemetry.emit('action_outbox_requeued', {
        callId: action.callSID || null,
        workflowId: action.workflowId,
        actionType: action.actionType,
        actionId: action.id,
        reason: options.reason || 'operator_requeue',
        auditId: options.auditId || null,
        ts: Date.now(),
    });
    await appendWorkflowActionEvent({
        action,
        eventType: 'action_outbox_requeued',
        event: { reason: options.reason || 'operator_requeue', auditId: options.auditId || null },
    });
    return { ok: true, action };
}

async function enqueueAndProcessDealerOrderSubmission(order = {}, guard = {}, options = {}) {
    const action = await enqueueDealerOrderSubmission(order, guard);
    if (!action) return { ok: false, reason: 'action_enqueue_failed' };
    if (action.status === 'completed') {
        telemetry.emit('action_outbox_duplicate', {
            callId: order.callId || order.callSID || null,
            workflowId: DEALER_ORDER_WORKFLOW_ID,
            actionType: DEALER_ORDER_ACTION_TYPE,
            actionId: action.id,
            status: action.status,
            ts: Date.now(),
        });
        return { ok: true, status: 'already_completed', action, result: action.resultJson || null };
    }
    return processActionById(action.id, options);
}

async function enqueueAndProcessBookingLinkDelivery(request = {}, options = {}) {
    const planned = await enqueueBookingLinkDeliveryActions(request);
    const attempts = [...planned.attempts];

    for (const plan of planned.actions) {
        if (plan.action?.status === 'completed') {
            telemetry.emit('action_outbox_duplicate', {
                callId: request.callId || request.callSID || null,
                workflowId: BOOKING_LINK_WORKFLOW_ID,
                actionType: BOOKING_LINK_ACTION_TYPE,
                actionId: plan.action.id,
                status: plan.action.status,
                channel: plan.channel,
                ts: Date.now(),
            });
            attempts.push(normalizeBookingAttemptResult({ ok: true, status: 'already_completed', action: plan.action }, plan));
            continue;
        }

        const result = await processActionById(plan.action.id, options);
        attempts.push(normalizeBookingAttemptResult(result, plan));
    }

    return summarizeBookingDeliveryAttempts(attempts);
}

async function enqueueAndProcessHandoverFollowup(request = {}, options = {}) {
    const action = await enqueueHandoverFollowup(request);
    if (!action) return { ok: false, reason: 'action_enqueue_failed' };
    if (action.status === 'completed') {
        telemetry.emit('action_outbox_duplicate', {
            callId: request.callId || request.callSID || request.followup?.callId || null,
            workflowId: HANDOVER_FOLLOWUP_WORKFLOW_ID,
            actionType: HANDOVER_FOLLOWUP_ACTION_TYPE,
            actionId: action.id,
            status: action.status,
            ts: Date.now(),
        });
        return { ok: true, status: 'already_completed', action, result: action.resultJson || null };
    }
    return processActionById(action.id, options);
}

async function processDueActions(options = {}) {
    if (state.processing) return [];
    state.processing = true;
    try {
        const actions = await Repository.claimDueActions({
            limit: options.limit || DEFAULT_MAX_BATCH,
            lockId: options.lockId || state.workerId,
            lockTimeoutSeconds: options.lockTimeoutSeconds || 120,
        });
        const results = [];
        for (const action of actions) {
            telemetry.emit('action_outbox_claimed', {
                callId: action.callSID || null,
                workflowId: action.workflowId,
                actionType: action.actionType,
                actionId: action.id,
                ts: Date.now(),
            });
            results.push(await processAction(action, options));
        }
        return results;
    } finally {
        state.processing = false;
    }
}

function scheduleNext(options = {}) {
    if (!state.running) return;
    const intervalMs = Math.max(1000, Number(options.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS) || DEFAULT_POLL_INTERVAL_MS);
    state.timer = setTimeout(async () => {
        state.timer = null;
        try {
            await processDueActions(options);
        } catch (err) {
            telemetry.emit('action_outbox_poll_failed', {
                reason: err?.message || String(err),
                ts: Date.now(),
            });
        } finally {
            scheduleNext(options);
        }
    }, intervalMs);
    if (typeof state.timer.unref === 'function') state.timer.unref();
}

function start(options = {}) {
    if (state.running) return;
    if (String(process.env.ACTION_OUTBOX_WORKER_ENABLED || 'true').toLowerCase() === 'false') return;
    state.running = true;
    scheduleNext(options);
}

function stop() {
    state.running = false;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
}

module.exports = {
    BOOKING_LINK_ACTION_TYPE,
    BOOKING_LINK_WORKFLOW_ID,
    HANDOVER_FOLLOWUP_ACTION_TYPE,
    HANDOVER_FOLLOWUP_WORKFLOW_ID,
    createBookingLinkDeliveryIdempotencyKey,
    createDealerOrderIdempotencyKey,
    createHandoverFollowupIdempotencyKey,
    enqueueAndProcessBookingLinkDelivery,
    enqueueAndProcessDealerOrderSubmission,
    enqueueAndProcessHandoverFollowup,
    enqueueBookingLinkDeliveryActions,
    enqueueDealerOrderSubmission,
    enqueueHandoverFollowup,
    executeAction,
    processAction,
    processActionById,
    processDueActions,
    requeueWorkflowAction,
    start,
    stop,
};