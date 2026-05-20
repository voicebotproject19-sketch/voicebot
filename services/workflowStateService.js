'use strict';

const crypto = require('crypto');
const Repository = require('../repositories/WorkflowStateRepository');
const telemetry = require('../Utils/telemetry');

const DEALER_ORDER_WORKFLOW_ID = 'dealer-orders';
const DEALER_ORDER_READ_POLICIES = Object.freeze({
    WORKFLOW_FIRST: 'workflow_first',
    SNAPSHOT_FIRST: 'snapshot_first',
    WORKFLOW_DISABLED: 'workflow_disabled',
});
const DEFAULT_DEALER_ORDER_READ_POLICY = DEALER_ORDER_READ_POLICIES.WORKFLOW_FIRST;

function shortHash(value) {
    if (!value) return null;
    return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

function isMissingWorkflowTableError(err) {
    const message = String(err?.message || '').toLowerCase();
    return err?.code === 'ER_NO_SUCH_TABLE'
        || err?.errno === 1146
        || message.includes('call_workflow_states')
        || message.includes('call_workflow_events');
}

function failureResult(err) {
    return {
        ok: false,
        skipped: isMissingWorkflowTableError(err),
        reason: err?.code || err?.message || String(err),
    };
}

async function upsertWorkflowState(data = {}) {
    try {
        return { ok: true, state: await Repository.upsertState(data) };
    } catch (err) {
        return failureResult(err);
    }
}

async function appendWorkflowEvent(data = {}) {
    try {
        return { ok: true, event: await Repository.appendEvent(data) };
    } catch (err) {
        return failureResult(err);
    }
}

async function getWorkflowState(callSID, workflowId) {
    try {
        return { ok: true, state: await Repository.getState(callSID, workflowId) };
    } catch (err) {
        return failureResult(err);
    }
}

async function listWorkflowEvents(callSID, workflowId, options = {}) {
    try {
        return { ok: true, events: await Repository.listEvents(callSID, workflowId, options) };
    } catch (err) {
        return failureResult(err);
    }
}

function summarizeDealerOrder(value = {}) {
    const order = value && typeof value === 'object' ? value : {};
    return {
        status: order.status || null,
        orderId: order.orderId || null,
        confirmed: order.confirmed === true,
        skipped: order.skipped === true,
        itemCount: Array.isArray(order.items) ? order.items.length : 0,
        erpStatus: order.erpStatus || null,
        notificationStatus: order.notificationStatus || null,
    };
}

function compareDealerOrderParity(workflowDealerOrder = null, fallbackDealerOrder = null) {
    const workflowSummary = summarizeDealerOrder(workflowDealerOrder || {});
    const fallbackSummary = summarizeDealerOrder(fallbackDealerOrder || {});
    const fields = ['status', 'orderId', 'confirmed', 'skipped', 'itemCount', 'erpStatus', 'notificationStatus'];
    const mismatches = fields
        .filter(field => workflowSummary[field] !== fallbackSummary[field])
        .map(field => ({ field, workflowValue: workflowSummary[field], fallbackValue: fallbackSummary[field] }));
    return {
        ok: mismatches.length === 0,
        workflowSummary,
        fallbackSummary,
        mismatches,
    };
}

function hasDealerOrderContent(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    return !!(
        value.status
        || value.orderId
        || value.confirmed === true
        || value.skipped === true
        || (Array.isArray(value.items) && value.items.length > 0)
    );
}

function normalizeDealerOrderReadPolicy(value) {
    const normalized = String(value || DEFAULT_DEALER_ORDER_READ_POLICY)
        .trim()
        .toLowerCase()
        .replace(/-/g, '_');
    return Object.values(DEALER_ORDER_READ_POLICIES).includes(normalized)
        ? normalized
        : DEFAULT_DEALER_ORDER_READ_POLICY;
}

function emitDealerOrderDarkReadTelemetry(callSID, data = {}) {
    const parity = data.parity || null;
    const mismatchFields = Array.isArray(parity?.mismatches)
        ? parity.mismatches.map(mismatch => mismatch.field).filter(Boolean)
        : [];
    const payload = {
        workflowId: DEALER_ORDER_WORKFLOW_ID,
        readModel: 'dealer_order',
        readPolicy: data.readPolicy || DEFAULT_DEALER_ORDER_READ_POLICY,
        source: data.source || 'missing',
        fallbackUsed: data.fallbackUsed === true,
        workflowStatePresent: data.workflowStatePresent === true,
        fallbackPresent: data.fallbackPresent === true,
        workflowReadSkipped: data.workflowReadSkipped === true,
        parityChecked: !!parity,
        parityOk: parity ? parity.ok === true : null,
        mismatchCount: mismatchFields.length,
        mismatchFields,
        callIdHash: shortHash(callSID),
        ts: Date.now(),
    };

    telemetry.emit('workflow_dark_read_compared', payload);
    if (parity && parity.ok === false) {
        telemetry.emit('workflow_dark_read_mismatch', payload);
    }
}

async function getDealerOrderReadModel(callSID, { fallbackDealerOrder = null, readPolicy = null, env = process.env } = {}) {
    const activeReadPolicy = normalizeDealerOrderReadPolicy(readPolicy ?? env.DEALER_ORDER_READ_SOURCE_POLICY);
    const fallbackSnapshot = hasDealerOrderContent(fallbackDealerOrder) ? fallbackDealerOrder : null;
    const workflowReadSkipped = activeReadPolicy === DEALER_ORDER_READ_POLICIES.WORKFLOW_DISABLED;
    const workflowState = workflowReadSkipped
        ? { ok: true, skipped: true, state: null }
        : await getWorkflowState(callSID, DEALER_ORDER_WORKFLOW_ID);
    const workflowDealerOrder = workflowState.ok && hasDealerOrderContent(workflowState.state?.stateJson)
        ? workflowState.state.stateJson
        : null;
    const dealerOrder = activeReadPolicy === DEALER_ORDER_READ_POLICIES.SNAPSHOT_FIRST
        ? (fallbackSnapshot || workflowDealerOrder || null)
        : (workflowDealerOrder || fallbackSnapshot || null);
    const parity = workflowDealerOrder && fallbackSnapshot
        ? compareDealerOrderParity(workflowDealerOrder, fallbackSnapshot)
        : null;
    let source = 'missing';
    if (dealerOrder === workflowDealerOrder && workflowDealerOrder) {
        source = 'workflow_state';
    } else if (dealerOrder === fallbackSnapshot && fallbackSnapshot) {
        source = 'fallback';
    }
    emitDealerOrderDarkReadTelemetry(callSID, {
        readPolicy: activeReadPolicy,
        source,
        fallbackUsed: source === 'fallback',
        workflowStatePresent: !!workflowDealerOrder,
        fallbackPresent: !!fallbackSnapshot,
        workflowReadSkipped,
        parity,
    });
    return {
        ok: !!dealerOrder || workflowState.ok,
        source,
        fallbackUsed: source === 'fallback',
        readPolicy: activeReadPolicy,
        workflowReadSkipped,
        dealerOrder,
        workflowState: workflowState.ok ? workflowState.state : null,
        parity,
        error: workflowState.ok ? null : workflowState.reason,
    };
}

async function recordWorkflowStep(data = {}) {
    const event = data.eventType
        ? await appendWorkflowEvent(data)
        : { ok: false, skipped: true, reason: 'workflow_event_type_missing' };
    const state = data.state || data.stateJson
        ? await upsertWorkflowState(data)
        : { ok: false, skipped: true, reason: 'workflow_state_missing' };
    return {
        ok: event.ok || state.ok,
        event,
        state,
    };
}

module.exports = {
    DEALER_ORDER_READ_POLICIES,
    DEFAULT_DEALER_ORDER_READ_POLICY,
    appendWorkflowEvent,
    compareDealerOrderParity,
    createWorkflowEventIdempotencyKey: Repository.buildEventIdempotencyKey,
    emitDealerOrderDarkReadTelemetry,
    getDealerOrderReadModel,
    getWorkflowState,
    isMissingWorkflowTableError,
    listWorkflowEvents,
    normalizeDealerOrderReadPolicy,
    recordWorkflowStep,
    upsertWorkflowState,
};