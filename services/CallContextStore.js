'use strict';

const CallRegistry = require('./CallRegistry');
const telemetry = require('../Utils/telemetry');
const CallContextRepository = require('../repositories/CallContextRepository');
const WorkflowStateService = require('./workflowStateService');

function emitFailure(operation, callSID, err) {
    telemetry.emit('call_context_persist_failed', {
        operation,
        callId: callSID || null,
        error: err.message,
        ts: Date.now()
    });
}

function buildRegistryState(context = {}, fallback = {}) {
    const phoneNumber = context.phoneNumber || fallback.phoneNumber || fallback.recipient || null;
    return {
        callId: context.callSID || fallback.callId || fallback.sid || null,
        sid: context.callSID || fallback.sid || fallback.callId || null,
        recipient: phoneNumber,
        phoneNumber,
        provider: context.provider || fallback.provider || null,
        name: context.name ?? fallback.name ?? null,
        persona: context.persona ?? fallback.persona ?? null,
        language: context.language ?? fallback.language ?? null,
        aiProvider: context.aiProvider ?? fallback.aiProvider ?? null,
        contextHint: context.contextHint ?? fallback.contextHint ?? null,
        policyConfig: context.policyConfig ?? fallback.policyConfig ?? null,
        requireExplicitRecordingConsent:
            context.requireExplicitRecordingConsent ?? fallback.requireExplicitRecordingConsent ?? false,
        bookingStatus: context.bookingStatus ?? fallback.bookingStatus ?? null,
        bookingProvider: context.bookingProvider ?? fallback.bookingProvider ?? null,
        externalBookingId: context.externalBookingId ?? fallback.externalBookingId ?? null,
        dealerOrder: context.dealerOrder ?? fallback.dealerOrder ?? null,
        providerStatus: context.providerStatus ?? fallback.providerStatus ?? null,
        providerTerminal: context.providerTerminal ?? fallback.providerTerminal ?? false,
        providerTerminalAt: context.providerTerminalAt ?? fallback.providerTerminalAt ?? null,
        status: fallback.status || 'connected',
        transcript: fallback.transcript || [],
        voicemail: fallback.voicemail || 'false',
        interested: fallback.interested || 'false',
        timestamp: fallback.timestamp || new Date().toISOString()
    };
}

async function upsertInitialContext(callSID, context = {}) {
    try {
        await CallContextRepository.upsertInitialContext(callSID, context);
        return true;
    } catch (err) {
        emitFailure('upsertInitialContext', callSID, err);
        return false;
    }
}

async function patchContext(callSID, patch = {}) {
    try {
        await CallContextRepository.patchContext(callSID, patch);
        return true;
    } catch (err) {
        emitFailure('patchContext', callSID, err);
        return false;
    }
}

async function getContext(callSID) {
    try {
        return await CallContextRepository.getContext(callSID);
    } catch (err) {
        emitFailure('getContext', callSID, err);
        return null;
    }
}

async function hydrateCallRegistry(callSID, fallback = {}) {
    const context = await getContext(callSID);
    if (!context) return null;

    const dealerReadModel = await WorkflowStateService.getDealerOrderReadModel(callSID, {
        fallbackDealerOrder: context.dealerOrder ?? fallback.dealerOrder ?? null,
    });
    const hydratedContext = dealerReadModel.dealerOrder
        ? { ...context, dealerOrder: dealerReadModel.dealerOrder }
        : context;

    const state = buildRegistryState(hydratedContext, { ...fallback, callId: callSID, sid: callSID });
    const existing = CallRegistry.get(callSID);
    if (existing) {
        CallRegistry.update(callSID, state);
        return { ...existing, ...state };
    }

    const created = CallRegistry.create(callSID, state);
    CallRegistry.update(callSID, state);
    telemetry.emit('call_context_hydrated', {
        callId: callSID,
        provider: state.provider,
        persona: state.persona,
        language: state.language,
        ts: Date.now()
    });
    return { ...created, ...state };
}

module.exports = {
    upsertInitialContext,
    patchContext,
    getContext,
    hydrateCallRegistry,
    buildRegistryState
};
