'use strict';

const CallRegistry = require('./CallRegistry');
const writeQueue = require('./writeQueue');
const telemetry = require('../Utils/telemetry');
const { buildBusinessMetrics } = require('../Utils/businessMetrics');

const ABANDONED_PROVIDER_STATUSES = new Set([
    'failed',
    'busy',
    'no-answer',
    'timeout',
    'canceled',
    'cancelled',
    'rejected',
    'invalid'
]);

function buildCallSummaryPayload({
    callSID,
    registryState,
    realtimeService,
    edgeSession,
    callContextState,
    finalDegradationState,
    outcome,
    durationMs,
    provider,
    nowMs
}) {
    const bookingDeliveryChannels = Array.isArray(realtimeService?.bookingDeliveryChannels)
        ? realtimeService.bookingDeliveryChannels
        : [];
    const dealerOrder = realtimeService?.dealerOrder || registryState.dealerOrder || null;
    const handoverTransferState = realtimeService?._handoverTransferState || registryState.handoverTransferState || {};
    const businessMetrics = buildBusinessMetrics({
        outcome,
        durationMs,
        inputTokens: realtimeService?.totalInputTokens,
        outputTokens: realtimeService?.totalOutputTokens
    });

    return {
        connectionId: edgeSession.connectionId || registryState.connectionId || null,
        callId: callSID,
        provider,
        outcome,
        durationMs,
        turnCount: realtimeService?.count || 0,
        cumulativeInputTokens: realtimeService?.totalInputTokens || 0,
        cumulativeOutputTokens: realtimeService?.totalOutputTokens || 0,
        hasAskedForConsultation: realtimeService?.hasAskedForConsultation || false,
        userEmailPresent: !!realtimeService?.userEmail,
        userPhonePresent: !!realtimeService?.userPhone,
        persona: realtimeService?.persona?.id || registryState.persona || null,
        conversationPhase: realtimeService?.conversationPhase || (registryState.providerTerminal ? 'provider_terminal' : 'unknown'),
        abCohort: realtimeService?._abCohort || 'control',
        bookingStatus: registryState.bookingStatus || null,
        bookingProvider: realtimeService?.bookingProvider || registryState.bookingProvider || null,
        externalBookingPresent: !!registryState.externalBookingId,
        bookingLinkRequested: !!realtimeService?.bookingLinkRequested,
        bookingLinkSent: !!(realtimeService?.bookingLinkSent || realtimeService?.bookingLinkStatus === 'sent'),
        bookingLinkStatus: realtimeService?.bookingLinkStatus || null,
        bookingDeliveryPreference: realtimeService?.bookingDeliveryPreference || null,
        bookingPhoneDeliveryConsent: !!realtimeService?.bookingPhoneDeliveryConsent,
        bookingDeliveryChannels,
        dealerOrderConfirmed: !!dealerOrder?.confirmed,
        dealerOrderSkipped: !!dealerOrder?.skipped,
        dealerOrderId: dealerOrder?.orderId || null,
        dealerOrderItemCount: Array.isArray(dealerOrder?.items) ? dealerOrder.items.length : 0,
        dealerOrderErpStatus: dealerOrder?.erpStatus || null,
        dealerOrderNotificationStatus: dealerOrder?.notificationStatus || null,
        bookingCompleted: outcome === 'booking_completed',
        bookingCancelled: outcome === 'booking_cancelled',
        transferred: outcome === 'transferred',
        transferRequested: outcome === 'transfer_requested',
        transferFailed: outcome === 'transfer_failed',
        handoverFallback: outcome === 'handover_fallback',
        transferRequestAccepted: !!handoverTransferState.requestAccepted,
        transferRequestFailed: !!handoverTransferState.requestFailed,
        transferBridgeConfirmed: !!handoverTransferState.bridgeConfirmed,
        transferBridgeFailed: !!handoverTransferState.bridgeFailed,
        transferInvalidNumber: !!handoverTransferState.invalidNumber,
        transferFallbackUsed: !!handoverTransferState.fallbackUsed,
        escalated: !!realtimeService?._handoverTriggered,
        sentimentPrimary: callContextState.lastSentimentPrimary || null,
        degradationStateFinal: finalDegradationState || callContextState.finalDegradationState || 'NORMAL',
        packetLossAvg: edgeSession.packetLossRatio || 0,
        phase4Profile: callContextState.phase4Profile?.name || null,
        ...businessMetrics,
        ts: nowMs
    };
}

function deriveHandoverOutcome(realtimeService, callState = {}) {
    const state = realtimeService?._handoverTransferState || callState.handoverTransferState || null;
    const handoverTriggered = !!(realtimeService?._handoverTriggered || state?.triggered);
    if (!handoverTriggered) return null;
    if (state?.bridgeConfirmed) return 'transferred';
    if (state?.bridgeFailed) return 'transfer_failed';
    if (state?.requestAccepted) return 'transfer_requested';
    if (state?.requestFailed || state?.invalidNumber) return 'transfer_failed';
    if (state?.fallbackUsed || state?.noTransferNumber) return 'handover_fallback';
    return 'handover_fallback';
}

function deriveProviderTerminalOutcome(callState = {}) {
    if (!callState.providerTerminal) return null;
    const status = String(callState.providerStatus || callState.lastStatus || '').toLowerCase();
    if (ABANDONED_PROVIDER_STATUSES.has(status)) return 'abandoned';
    if (status === 'completed' || status === 'hangup') return 'completed';
    return 'completed';
}

function deriveDealerOrderOutcome(realtimeService, callState = {}) {
    const dealerOrder = realtimeService?.dealerOrder || callState?.dealerOrder || null;
    if (!dealerOrder) return null;
    if (dealerOrder.confirmed || dealerOrder.status === 'confirmed') return 'dealer_order_confirmed';
    if (dealerOrder.skipped || dealerOrder.status === 'skipped') return 'dealer_order_skipped';
    return null;
}

function deriveCallOutcome(realtimeService, callState = {}) {
    if (callState?.bookingStatus === 'completed') return 'booking_completed';
    if (callState?.bookingStatus === 'cancelled') return 'booking_cancelled';
    const dealerOrderOutcome = deriveDealerOrderOutcome(realtimeService, callState);
    if (dealerOrderOutcome) return dealerOrderOutcome;
    const handoverOutcome = deriveHandoverOutcome(realtimeService, callState);
    if (!realtimeService) return handoverOutcome || deriveProviderTerminalOutcome(callState) || 'completed';
    if (realtimeService.conversationPhase === 'voicemail') return 'voicemail';
    if (realtimeService.conversationPhase === 'rejected') return 'rejected';
    if (handoverOutcome) return handoverOutcome;
    if (realtimeService.bookingLinkSent || realtimeService.bookingLinkStatus === 'sent') return 'booking_link_sent';
    if (realtimeService.bookingLinkStatus === 'failed') return 'booking_link_failed';
    if (realtimeService.bookingLinkRequested) return 'booking_link_requested';
    return 'completed';
}

function getDurationMs(callState = {}, nowMs = Date.now()) {
    const start = callState.startedAt || callState.connectedAt || callState.createdAt || nowMs;
    const durationMs = nowMs - start;
    return Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0;
}

function emitDegraded(callSID, reason, payload = {}) {
    telemetry.emit('call_finalization_degraded', {
        callId: callSID || null,
        reason,
        ...payload,
        ts: Date.now()
    });
}

function finalizeCall({
    callSID,
    callState = null,
    realtimeService = null,
    callContextState = {},
    edgeSession = {},
    finalDegradationState = null,
    source = 'websocket_close',
    reason = 'call_end',
    now = Date.now
} = {}) {
    if (!callSID) {
        emitDegraded(null, 'missing_call_id', { source, finalizationReason: reason });
        return { ok: false, reason: 'missing_call_id' };
    }

    const registryState = callState || CallRegistry.get(callSID);
    if (!registryState) {
        emitDegraded(callSID, 'missing_call_state', { source, finalizationReason: reason });
        return { ok: false, reason: 'missing_call_state' };
    }

    if (registryState._finalizedAt) {
        return {
            ok: true,
            skipped: true,
            reason: 'already_finalized',
            outcome: registryState._finalizationOutcome || null
        };
    }

    const nowMs = now();
    const durationMs = getDurationMs(registryState, nowMs);
    const outcome = deriveCallOutcome(realtimeService, registryState);
    const provider = registryState.provider || null;

    CallRegistry.update(callSID, {
        _finalizationStartedAt: nowMs,
        _finalizationSource: source
    });

    telemetry.emit('call_finalization_started', {
        callId: callSID,
        source,
        reason,
        provider,
        hasRealtimeService: !!realtimeService,
        ts: nowMs
    });

    const callQueued = writeQueue.enqueue({
        type: 'persist_call',
        callSID,
        transcript: registryState.transcript || [],
        durationMs
    });

    const outcomeQueued = writeQueue.enqueue({
        type: 'persist_outcome',
        callSID,
        outcome,
        personaId: realtimeService?.persona?.id || registryState.persona || null,
        phoneNumber: registryState?.phoneNumber || registryState?.recipient || null,
        userEmail: realtimeService?.userEmail || null,
        userPhone: realtimeService?.userPhone || null,
        preferredSlot: realtimeService?.preferredSlot || null,
        conversationPhase: realtimeService?.conversationPhase || (registryState.providerTerminal ? 'provider_terminal' : 'unknown'),
        turnCount: realtimeService?.count || 0,
        durationMs,
        sentimentPrimary: callContextState.lastSentimentPrimary || null,
        escalated: realtimeService?._handoverTriggered || false,
        synthesisScoreAvg: null,
        degradationStateFinal: finalDegradationState || callContextState.finalDegradationState || 'NORMAL',
        packetLossAvg: edgeSession.packetLossRatio || 0,
        phase4Profile: callContextState.phase4Profile?.name || null
    });

    telemetry.emit('call_summary', buildCallSummaryPayload({
        callSID,
        registryState,
        realtimeService,
        edgeSession,
        callContextState,
        finalDegradationState,
        outcome,
        durationMs,
        provider,
        nowMs
    }));

    if (realtimeService) {
        if (realtimeService?._abCohort && realtimeService._abCohort !== 'control') {
            telemetry.emit('model_ab_outcome', {
                callId: callSID,
                cohort: realtimeService._abCohort,
                provider: realtimeService.providerName,
                durationMs,
                turnCount: realtimeService?.count || 0,
                modeCollapseCount: realtimeService?._modeCollapseRetries || 0,
                ts: Date.now()
            });
        }
    }

    if (!realtimeService) {
        emitDegraded(callSID, 'provider_terminal_fallback', {
            source,
            provider,
            providerStatus: registryState.providerStatus || registryState.lastStatus || null,
            outcome
        });
    }

    const fullyQueued = callQueued !== false && outcomeQueued !== false;
    if (fullyQueued) {
        CallRegistry.update(callSID, {
            _finalizedAt: nowMs,
            _finalizationOutcome: outcome
        });
        telemetry.emit('call_finalization_completed', {
            callId: callSID,
            source,
            reason,
            provider,
            outcome,
            durationMs,
            ts: nowMs
        });
    } else {
        CallRegistry.update(callSID, {
            _finalizationFailedAt: nowMs,
            _finalizationOutcome: outcome
        });
        emitDegraded(callSID, 'write_queue_full', {
            source,
            provider,
            outcome,
            callQueued,
            outcomeQueued
        });
    }

    return {
        ok: fullyQueued,
        outcome,
        durationMs,
        callQueued,
        outcomeQueued,
        degraded: !realtimeService
    };
}

module.exports = { finalizeCall, deriveCallOutcome, deriveProviderTerminalOutcome, deriveDealerOrderOutcome };
