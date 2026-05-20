'use strict';

const CallRegistry = require('./CallRegistry');
const CallContextStore = require('./CallContextStore');
const telemetry = require('../Utils/telemetry');

const TERMINAL_STATUSES = Object.freeze({
    twilio: new Set(['completed', 'failed', 'busy', 'no-answer', 'canceled', 'cancelled']),
    plivo: new Set(['completed', 'hangup', 'failed', 'busy', 'no-answer', 'timeout', 'canceled', 'cancelled', 'rejected', 'invalid'])
});

const MISSED_CALL_STATUSES = new Set(['failed', 'busy', 'no-answer', 'timeout', 'canceled', 'cancelled', 'rejected', 'invalid']);

function getProviderTerminalFinalizationGraceMs() {
    const configured = Number(process.env.PROVIDER_TERMINAL_FINALIZATION_GRACE_MS);
    return Number.isFinite(configured) && configured >= 0 ? configured : 5000;
}

function scheduleProviderTerminalFinalization({ callSID, provider, status, source }) {
    const delayMs = getProviderTerminalFinalizationGraceMs();
    const timer = setTimeout(() => {
        try {
            const { finalizeCall } = require('./callFinalizer');
            finalizeCall({
                callSID,
                source: 'provider_terminal_status',
                reason: `${provider || 'unknown'}_${status || 'terminal'}`
            });
        } catch (err) {
            telemetry.emit('call_finalization_degraded', {
                callId: callSID,
                provider,
                providerStatus: status,
                source,
                reason: 'provider_terminal_finalizer_error',
                error: err.message,
                ts: Date.now()
            });
        }
    }, delayMs);
    if (typeof timer.unref === 'function') timer.unref();
    return timer;
}

function firstNonEmpty(...values) {
    for (const value of values) {
        if (value == null) continue;
        const normalized = String(value).trim();
        if (normalized) return normalized;
    }
    return null;
}

function normalizeProvider(provider) {
    const value = firstNonEmpty(provider);
    if (!value) return 'unknown';
    const normalized = value.toLowerCase();
    if (normalized === 'twilio' || normalized === 'plivo') return normalized;
    return normalized;
}

function normalizeStatus(status) {
    const value = firstNonEmpty(status);
    if (!value) return null;
    return value.toLowerCase().replace(/[_\s]+/g, '-');
}

function normalizeBoolean(value) {
    if (typeof value === 'boolean') return value;
    if (value == null) return false;
    return ['1', 'true', 'yes', 'y'].includes(String(value).trim().toLowerCase());
}

function normalizeQueryValue(query = {}, name) {
    return firstNonEmpty(query[name], query[name.toLowerCase()]);
}

function normalizeTwilioStatus(payload = {}) {
    return {
        provider: 'twilio',
        callSID: firstNonEmpty(
            payload.CallSid,
            payload.CallSID,
            payload.callSid,
            payload.call_sid,
            payload.Sid,
            payload.sid
        ),
        status: normalizeStatus(firstNonEmpty(
            payload.CallStatus,
            payload.callStatus,
            payload.call_status,
            payload.Status,
            payload.status,
            payload.Event,
            payload.event
        ))
    };
}

function normalizePlivoStatus(payload = {}) {
    return {
        provider: 'plivo',
        callSID: firstNonEmpty(
            payload.CallUUID,
            payload.CallUuid,
            payload.call_uuid,
            payload.CallSid,
            payload.RequestUUID,
            payload.request_uuid,
            payload.ParentCallUUID
        ),
        status: normalizeStatus(firstNonEmpty(
            payload.CallStatus,
            payload.call_status,
            payload.Event,
            payload.event
        ))
    };
}

function normalizeTwilioTransferAction(payload = {}, query = {}) {
    const status = normalizeStatus(firstNonEmpty(payload.DialCallStatus, payload.dialCallStatus, payload.Status, payload.status));
    const dialBridged = normalizeBoolean(firstNonEmpty(payload.DialBridged, payload.dialBridged));
    return {
        provider: 'twilio',
        attemptId: firstNonEmpty(normalizeQueryValue(query, 'attemptId'), payload.attemptId),
        rootCallId: firstNonEmpty(normalizeQueryValue(query, 'rootCallId'), payload.ParentCallSid, payload.CallSid, payload.callSid),
        legCallId: firstNonEmpty(payload.DialCallSid, payload.dialCallSid),
        legRole: 'agent',
        normalizedStatus: status,
        rawStatus: firstNonEmpty(payload.DialCallStatus, payload.Status, payload.status),
        bridgeEvidence: {
            dialBridged,
            dialCallStatus: status,
            dialCallSid: firstNonEmpty(payload.DialCallSid, payload.dialCallSid),
            dialCallDuration: firstNonEmpty(payload.DialCallDuration, payload.dialCallDuration)
        },
        bridgeConfirmed: dialBridged && (status === 'completed' || status === 'answered'),
        bridgeFailed: ['busy', 'no-answer', 'failed', 'canceled', 'cancelled'].includes(status),
        duration: firstNonEmpty(payload.DialCallDuration, payload.dialCallDuration),
        source: 'twilio-transfer-action'
    };
}

function normalizePlivoDialEvent(payload = {}, query = {}) {
    const action = normalizeStatus(firstNonEmpty(payload.DialAction, payload.dialAction, payload.Event, payload.event));
    const status = normalizeStatus(firstNonEmpty(payload.DialStatus, payload.DialBLegStatus, payload.dialStatus, payload.dialBLegStatus));
    const digits = firstNonEmpty(payload.DialDigitsMatch, payload.DialDigits, payload.Digits, payload.digits);
    const pressedBy = firstNonEmpty(payload.DialDigitsPressedBy, payload.dialDigitsPressedBy);
    const confirmKey = firstNonEmpty(normalizeQueryValue(query, 'confirmKey'));
    const digitsAccepted = !!(confirmKey && digits === confirmKey && /bleg/i.test(String(pressedBy || '')));
    const bridgeConfirmed = status === 'completed' || action === 'connected' || digitsAccepted;
    const bridgeFailed = ['busy', 'no-answer', 'failed', 'timeout', 'cancel', 'canceled', 'cancelled', 'rejected', 'invalid'].includes(status)
        || ['hangup'].includes(action) && status !== 'completed';
    return {
        provider: 'plivo',
        attemptId: firstNonEmpty(normalizeQueryValue(query, 'attemptId'), payload.attemptId),
        rootCallId: firstNonEmpty(normalizeQueryValue(query, 'rootCallId'), payload.DialALegUUID, payload.CallUUID, payload.call_uuid),
        legCallId: firstNonEmpty(payload.DialBLegUUID, payload.dialBLegUUID),
        legRole: 'agent',
        normalizedStatus: status || action,
        rawStatus: firstNonEmpty(payload.DialStatus, payload.DialBLegStatus, payload.DialAction),
        bridgeEvidence: {
            dialAction: action,
            dialStatus: status,
            dialALegUUID: firstNonEmpty(payload.DialALegUUID, payload.CallUUID),
            dialBLegUUID: firstNonEmpty(payload.DialBLegUUID, payload.dialBLegUUID),
            digits,
            pressedBy
        },
        bridgeConfirmed,
        bridgeFailed,
        digits,
        duration: firstNonEmpty(payload.DialBLegDuration, payload.DialBLegBillDuration),
        source: action ? 'plivo-transfer-events' : 'plivo-transfer-action'
    };
}

function getAgentTelemetryEvent(normalized) {
    if (normalized.provider === 'plivo') {
        const action = normalized.bridgeEvidence?.dialAction;
        const status = normalized.normalizedStatus;
        if (action === 'answer') return 'agent_leg_answered';
        if (action === 'connected' || normalized.bridgeConfirmed) return 'agent_leg_accepted';
        if (['busy', 'no-answer', 'failed', 'timeout', 'rejected'].includes(status)) return 'agent_leg_rejected';
        return null;
    }
    if (normalized.bridgeConfirmed) return 'agent_leg_accepted';
    if (normalized.bridgeFailed) return 'agent_leg_rejected';
    return null;
}

function recordTransferLegStatus(normalized = {}) {
    const ts = Date.now();
    const rootCallId = firstNonEmpty(normalized.rootCallId);
    const attemptId = firstNonEmpty(normalized.attemptId);

    if (!rootCallId) {
        telemetry.emit('telecom_status_missing_call_id', {
            provider: normalizeProvider(normalized.provider),
            source: normalized.source || 'transfer-leg-status',
            status: normalized.normalizedStatus || null,
            payloadKeys: [],
            ts
        });
        return { ok: false, reason: 'missing_call_id' };
    }

    const existing = CallRegistry.get(rootCallId);
    const previousTransferState = existing?.handoverTransferState || {};
    const agentLeg = {
        ...(previousTransferState.agentLeg || {}),
        callId: normalized.legCallId || previousTransferState.agentLeg?.callId || null,
        role: normalized.legRole || 'agent',
        status: normalized.normalizedStatus || null,
        rawStatus: normalized.rawStatus || null,
        duration: normalized.duration || null,
        updatedAt: ts
    };
    const bridgeConfirmed = !!(previousTransferState.bridgeConfirmed || normalized.bridgeConfirmed);
    const bridgeFailed = !!(!bridgeConfirmed && (previousTransferState.bridgeFailed || normalized.bridgeFailed));
    const nextTransferState = {
        ...previousTransferState,
        attemptId: attemptId || previousTransferState.attemptId || null,
        provider: normalizeProvider(normalized.provider),
        sourceCallId: rootCallId,
        agentLeg,
        bridgeEvidence: normalized.bridgeEvidence || previousTransferState.bridgeEvidence || null,
        bridgeConfirmed,
        bridgeFailed,
        bridgeConfirmedAt: bridgeConfirmed ? (previousTransferState.bridgeConfirmedAt || ts) : previousTransferState.bridgeConfirmedAt || null,
        bridgeFailedAt: bridgeFailed ? (previousTransferState.bridgeFailedAt || ts) : previousTransferState.bridgeFailedAt || null,
        fallbackReason: bridgeFailed ? (normalized.normalizedStatus || 'transfer_bridge_failed') : previousTransferState.fallbackReason || null,
        requestAccepted: bridgeConfirmed ? true : previousTransferState.requestAccepted,
        updatedAt: ts
    };

    if (existing) {
        CallRegistry.update(rootCallId, { handoverTransferState: nextTransferState });
    } else {
        CallRegistry.create(rootCallId, {
            callId: rootCallId,
            sid: rootCallId,
            createdFromTransferWebhook: true,
            handoverTransferState: nextTransferState
        });
    }
    CallContextStore.patchContext(rootCallId, { handoverTransferState: nextTransferState }).catch(() => {});

    const eventPayload = {
        provider: normalizeProvider(normalized.provider),
        callId: rootCallId,
        attemptId: nextTransferState.attemptId,
        agentLegCallId: agentLeg.callId,
        status: normalized.normalizedStatus || null,
        source: normalized.source || 'transfer-leg-status',
        ts
    };
    const agentEvent = getAgentTelemetryEvent(normalized);
    if (agentEvent) telemetry.emit(agentEvent, eventPayload);

    if (bridgeConfirmed) {
        telemetry.emit('warm_transfer_bridge_confirmed', eventPayload);
        telemetry.emit('call_transferred', { ...eventPayload, bridgeConfirmed: true });
    } else if (bridgeFailed) {
        telemetry.emit('warm_transfer_failed', {
            ...eventPayload,
            reason: nextTransferState.fallbackReason
        });
    }

    return {
        ok: true,
        callSID: rootCallId,
        attemptId: nextTransferState.attemptId,
        bridgeConfirmed,
        bridgeFailed,
        handoverTransferState: nextTransferState
    };
}

function isTerminalProviderStatus(provider, status) {
    const normalizedProvider = normalizeProvider(provider);
    const normalizedStatus = normalizeStatus(status);
    if (!normalizedStatus) return false;
    const knownStatuses = TERMINAL_STATUSES[normalizedProvider];
    if (knownStatuses) return knownStatuses.has(normalizedStatus);
    return normalizedStatus === 'completed' || normalizedStatus === 'failed' || normalizedStatus === 'hangup';
}

function buildStatusPatch({ provider, status, terminal, ts }) {
    const patch = {
        provider,
        providerStatus: status,
        providerStatusAt: ts,
        lastStatus: status,
        lastStatusAt: ts
    };

    if (terminal) {
        patch.providerTerminal = true;
        patch.providerTerminalAt = ts;
    }

    return patch;
}

function recordProviderStatus({ provider, callSID, status, payload = {}, source = 'status-webhook' } = {}) {
    const ts = Date.now();
    const normalizedProvider = normalizeProvider(provider);
    const normalizedCallSID = firstNonEmpty(callSID);
    const normalizedStatus = normalizeStatus(status);

    if (!normalizedCallSID) {
        telemetry.emit('telecom_status_missing_call_id', {
            provider: normalizedProvider,
            source,
            status: normalizedStatus,
            payloadKeys: Object.keys(payload || {}).slice(0, 20),
            ts
        });
        return { ok: false, reason: 'missing_call_id', provider: normalizedProvider, status: normalizedStatus };
    }

    telemetry.emit('telecom_status_received', {
        provider: normalizedProvider,
        callId: normalizedCallSID,
        status: normalizedStatus,
        source,
        ts
    });

    const terminal = isTerminalProviderStatus(normalizedProvider, normalizedStatus);
    const patch = buildStatusPatch({
        provider: normalizedProvider,
        status: normalizedStatus,
        terminal,
        ts
    });

    let createdPlaceholder = false;
    const existing = CallRegistry.get(normalizedCallSID);
    if (existing) {
        CallRegistry.update(normalizedCallSID, patch);
    } else {
        createdPlaceholder = true;
        CallRegistry.create(normalizedCallSID, {
            callId: normalizedCallSID,
            sid: normalizedCallSID,
            createdFromStatusWebhook: true,
            ...patch
        });
    }

    CallContextStore.patchContext(normalizedCallSID, patch).catch(() => {});

    if (terminal) {
        telemetry.emit('telecom_status_terminal', {
            provider: normalizedProvider,
            callId: normalizedCallSID,
            status: normalizedStatus,
            source,
            createdPlaceholder,
            ts
        });
        scheduleProviderTerminalFinalization({
            callSID: normalizedCallSID,
            provider: normalizedProvider,
            status: normalizedStatus,
            source
        });

        const stateForMissedCall = existing || CallRegistry.get(normalizedCallSID);
        if (stateForMissedCall?.persona === 'dealer-orders' && MISSED_CALL_STATUSES.has(normalizedStatus)) {
            try {
                const { handleDealerOrderMissedCall } = require('./dealerOrderService');
                handleDealerOrderMissedCall({
                    callSID: normalizedCallSID,
                    callState: stateForMissedCall,
                    provider: normalizedProvider,
                    status: normalizedStatus,
                }).catch((err) => {
                    telemetry.emit('dealer_order_fallback_failed', {
                        callId: normalizedCallSID,
                        provider: normalizedProvider,
                        status: normalizedStatus,
                        reason: err?.message || 'missed_call_handler_failed',
                        ts
                    });
                });
            } catch (err) {
                telemetry.emit('dealer_order_fallback_failed', {
                    callId: normalizedCallSID,
                    provider: normalizedProvider,
                    status: normalizedStatus,
                    reason: err?.message || 'missed_call_handler_unavailable',
                    ts
                });
            }
        }
    }

    return {
        ok: true,
        provider: normalizedProvider,
        callSID: normalizedCallSID,
        status: normalizedStatus,
        terminal,
        createdPlaceholder
    };
}

module.exports = {
    normalizeTwilioStatus,
    normalizePlivoStatus,
    normalizeTwilioTransferAction,
    normalizePlivoDialEvent,
    isTerminalProviderStatus,
    recordProviderStatus,
    recordTransferLegStatus,
    scheduleProviderTerminalFinalization
};
