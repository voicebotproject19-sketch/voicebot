/**
 * PlivoProvider — implements the TelecomProvider contract for Plivo.
 *
 * Call lifecycle, WebSocket event normalisation, gate config, and audio
 * buffering strategy are all Plivo-specific and co-located here.
 */

'use strict';

const { createPlivoClient } = require('./plivoClient');
const CallRegistry = require('../../services/CallRegistry');
const writeQueue = require('../../services/writeQueue');
const UserRepository = require('../../repositories/UserRepository');
const { parseE164CountryCode, normalizeTransferNumber } = require('../../Utils/phoneUtils');

// ── Internal client factory ───────────────────────────────────────────────────

function getPlivoClient() {
    return createPlivoClient({
        authId: process.env.PLIVO_AUTH_ID,
        authToken: process.env.PLIVO_AUTH_TOKEN
    });
}

function buildTransferAlegUrl({ transferNumber, attemptId, rootCallId, mode, timeoutSeconds, confirmTimeoutSeconds, confirmKey } = {}) {
    if (!process.env.NETWORK_URL || !transferNumber) return null;
    const params = new URLSearchParams({ number: transferNumber });
    if (attemptId) params.set('attemptId', String(attemptId));
    if (rootCallId) params.set('rootCallId', String(rootCallId));
    if (mode) params.set('mode', String(mode));
    if (timeoutSeconds != null) params.set('timeoutSeconds', String(timeoutSeconds));
    if (confirmTimeoutSeconds != null) params.set('confirmTimeoutSeconds', String(confirmTimeoutSeconds));
    if (confirmKey) params.set('confirmKey', String(confirmKey));
    return `https://${process.env.NETWORK_URL}/transfer-plivo?${params.toString()}`;
}

// ── Call lifecycle ────────────────────────────────────────────────────────────

/**
 * Initiate an outbound Plivo call.
 * options: optional { contextHint: string|null, policyConfig: object|null }
 */
// ── Pending call metadata ─────────────────────────────────────────────────────
// When Plivo API responds without a call UUID (e.g. "async api spawned"), the
// actual CallUUID only arrives later in the answer URL callback.  We park
// the call metadata here so /incoming-plivo can build a complete registry entry.
const _pendingCallsByPhone = new Map();
const _pendingCallExpiryTimers = new Map();

function clearPendingCallExpiryTimer(phoneNumber) {
    const timer = _pendingCallExpiryTimers.get(phoneNumber);
    if (timer) clearTimeout(timer);
    _pendingCallExpiryTimers.delete(phoneNumber);
}

function storePendingCallMeta(phoneNumber, meta) {
    clearPendingCallExpiryTimer(phoneNumber);
    _pendingCallsByPhone.set(phoneNumber, { ...meta, ts: Date.now() });
    // Auto-expire after 60 s to avoid leaks
    const timer = setTimeout(() => {
        _pendingCallsByPhone.delete(phoneNumber);
        _pendingCallExpiryTimers.delete(phoneNumber);
    }, 60_000);
    if (typeof timer.unref === 'function') timer.unref();
    _pendingCallExpiryTimers.set(phoneNumber, timer);
}

function consumePendingCallMeta(phoneNumber) {
    const meta = _pendingCallsByPhone.get(phoneNumber);
    if (meta) {
        _pendingCallsByPhone.delete(phoneNumber);
        clearPendingCallExpiryTimer(phoneNumber);
    }
    return meta || null;
}

async function createCall(toNumber, name, persona, language, options) {
    const client = getPlivoClient();
    const networkUrl = process.env.NETWORK_URL;
    const response = await client.calls.create(
        process.env.PLIVO_FROM_NUMBER,
        toNumber,
        `https://${networkUrl}/incoming-plivo`,
        {
            answerMethod: 'POST',
            callbackUrl: `https://${networkUrl}/plivo-status`,
            callbackMethod: 'POST'
        }
    );

    const callUuid = response.requestUuid || response.request_uuid || response.callUuid
        || (Array.isArray(response) && response[0]?.requestUuid)
        || null;

    const policyConfig = options?.policyConfig != null ? { ...options.policyConfig } : undefined;
    if (policyConfig != null && policyConfig.isoCountryCode == null && toNumber) {
        const parsed = parseE164CountryCode(toNumber);
        if (parsed != null) policyConfig.isoCountryCode = parsed;
    }

    const callMeta = {
        recipient: toNumber,
        startedAt: Date.now(),
        status: 'initiated',
        transcript: [],
        voicemail: 'false',
        interested: 'false',
        name,
        persona,
        language,
        aiProvider: options?.aiProvider ?? null,
        timestamp: new Date().toISOString(),
        contextHint: options?.contextHint ?? null,
        policyConfig: policyConfig ?? null,
        requireExplicitRecordingConsent: options?.requireExplicitRecordingConsent ?? false
    };

    if (!callUuid) {
        // Plivo accepted the API call (no HTTP error) but did not return a UUID.
        // The call IS being placed — the real CallUUID will arrive in the answer
        // URL callback.  Park the metadata so /incoming-plivo can register it.
        console.info('Plivo createCall: no UUID in response, parking metadata for answer URL.',
            'apiId:', response.apiId || response.api_id, 'keys:', Object.keys(response));
        storePendingCallMeta(toNumber, callMeta);
        return { callSid: null, phoneNumber: toNumber };
    }

    console.log(`Plivo call initiated: ${callUuid} → ${toNumber}`);

    CallRegistry.create(callUuid, {
        ...callMeta,
        sid: callUuid,
    });
    writeQueue.enqueue({ type: 'create_call', callSID: callUuid, phoneNumber: toNumber, provider: 'plivo' });

    const _cleanupTimer = setTimeout(() => { CallRegistry.delete(callUuid); }, 2 * 60 * 60 * 1000);
    if (typeof _cleanupTimer.unref === 'function') _cleanupTimer.unref();
    CallRegistry.update(callUuid, { _cleanupTimer });

    // Fire-and-forget: DB write must not block call initiation or eat into timeout budget
    UserRepository.createUser(callUuid, toNumber, name, 'initiated', 'false', 'false', 'not found', 'not found')
        .catch(err => console.error(`Plivo: failed to persist user for ${callUuid}:`, err.message));

    return { callSid: callUuid, phoneNumber: toNumber };
}

async function hangup(callUuid) {
    if (!callUuid) {
        console.error('Plivo hangup: no callUuid provided.');
        return;
    }
    try {
        console.log(`Plivo: hanging up call ${callUuid}`);
        const client = getPlivoClient();
        const response = await client.calls.hangup(callUuid);
        const callState = CallRegistry.get(callUuid);
        if (callState?._cleanupTimer) {
            clearTimeout(callState._cleanupTimer);
            CallRegistry.update(callUuid, { _cleanupTimer: null });
        }
        console.log(`Plivo call ${callUuid} hung up:`, response);
    } catch (error) {
        console.error(`Plivo hangup error for ${callUuid}:`, error.message);
        if (error.statusCode === 404) {
            console.log('Plivo: call may have already ended or UUID is invalid');
        }
    }
}

async function transfer(callUuid, transferNumber, options = {}) {
    if (!callUuid || !transferNumber) {
        console.error('Plivo transfer: missing callUuid or transferNumber.');
        return false;
    }
    const normalized = normalizeTransferNumber(transferNumber);
    if (!normalized.ok) {
        console.error(`Plivo transfer: invalid transfer number ${String(transferNumber).trim()}`);
        return false;
    }
    const normalizedTransferNumber = normalized.number;
    try {
        console.log(`Plivo: transferring call ${callUuid} to ${normalizedTransferNumber}`);
        const client = getPlivoClient();
        await client.calls.transfer(callUuid, {
            legs: 'aleg',
            alegUrl: buildTransferAlegUrl({
                transferNumber: normalizedTransferNumber,
                attemptId: options.attemptId,
                rootCallId: options.rootCallId || callUuid,
                mode: options.mode,
                timeoutSeconds: options.timeoutSeconds,
                confirmTimeoutSeconds: options.confirmTimeoutSeconds,
                confirmKey: options.confirmKey
            })
        });
        console.log(`Plivo call ${callUuid} transferred to ${normalizedTransferNumber}`);
        return true;
    } catch (error) {
        console.error(`Plivo transfer error for ${callUuid}:`, error.message);
        return false;
    }
}

// ── Incoming call XML ─────────────────────────────────────────────────────────

function incomingCallXml(networkUrl) {
    const serviceUrl = `wss://${networkUrl}/connection_plivo`;
    return `<Response>
  <Stream bidirectional="true" keepCallAlive="true" contentType="audio/x-mulaw;rate=8000">
    ${serviceUrl}
  </Stream>
</Response>`;
}

// ── WebSocket event normalisation ─────────────────────────────────────────────

/**
 * Plivo sends callId and streamId inside msg.start.
 * Normalise to canonical { callId, streamId } used by createCallSession.
 */
function extractStartFields(msg) {
    return {
        callId: msg.start.callId,
        streamId: msg.start.streamId,
        callerNumber: msg.start.from || msg.start.to || null
    };
}

// ── Audio gate configuration ──────────────────────────────────────────────────

/**
 * Plivo gate constants — tuned for PCM-domain RMS energy from µ-law decode.
 *
 * The GateV2 energy computation now decodes µ-law bytes to linear PCM via
 * ULAW_DECODE_TABLE before computing RMS, giving correct amplitude values:
 *   - Silence: ~0.001 – 0.01 PCM RMS
 *   - Speech:  ~0.05 – 0.30 PCM RMS
 *
 * Previous formula `(byte - 128)²` was inverted for µ-law: silence (0xFF)
 * decoded to max gate energy (0.99) and loud speech (0x80) to zero.
 * This made the gate unable to separate speech from silence, requiring
 * energyOverrideThreshold=0 (bypass). With correct PCM RMS, the dynamic
 * threshold gate works as designed.
 *
 * energyOverrideThreshold defaults to null (disabled): the dynamic gate
 * handles speech/silence separation. Set via env to force-send any frame
 * above a fixed energy level. Nullable fields also accept "null", "none",
 * "disabled", or "off" to skip that branch.
 */
function readGateNumber(rawValue, defaultValue, { allowNull = false } = {}) {
    if (rawValue === undefined || String(rawValue).trim() === '') return defaultValue;
    const normalized = String(rawValue).trim().toLowerCase();
    if (allowNull && ['null', 'none', 'disabled', 'off'].includes(normalized)) return null;
    const parsed = Number(rawValue);
    return Number.isFinite(parsed) ? parsed : defaultValue;
}

function getGateConfig() {
    return {
        dynamicThresholdOffset: readGateNumber(process.env.PLIVO_GATE_DYNAMIC_THRESHOLD_OFFSET, 0.02),
        silenceFramesThreshold: readGateNumber(process.env.PLIVO_GATE_SILENCE_FRAMES_THRESHOLD, 50),
        energyOverrideThreshold: readGateNumber(process.env.PLIVO_GATE_ENERGY_OVERRIDE_THRESHOLD, null, { allowNull: true }),
        maxSilenceFailsafe: readGateNumber(process.env.PLIVO_GATE_MAX_SILENCE_FAILSAFE, 150, { allowNull: true })
    };
}

// ── Provider object ───────────────────────────────────────────────────────────

const PlivoProvider = Object.freeze({
    name: 'plivo',
    wsRoute: 'connection_plivo',

    createCall,
    hangup,
    transfer,
    buildTransferAlegUrl,
    incomingCallXml,
    extractStartFields,
    getGateConfig,
    consumePendingCallMeta,
    storePendingCallMeta,

    /** Latest frame overwrites edgeSession.latestAudioFrame (single-slot, no queue). */
    audioBufferStrategy: 'single-slot',

    /**
     * Realtime service listeners are registered at WebSocket construction time,
     * outside the 'start' event handler (no removeAllListeners call).
     */
    listenerRegistrationTiming: 'immediate',

    /** Plivo needs pre-connection buffering to avoid dropping early audio. */
    hasPreConnectBuffer: true,

    /**
     * Plivo media handler should wait for the session to be configured
     * before forwarding audio, avoiding dropped frames.
     */
    requiresSessionConfigured: true
});

module.exports = PlivoProvider;
