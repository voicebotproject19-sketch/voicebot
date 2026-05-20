/**
 * TwilioProvider — implements the TelecomProvider contract for Twilio.
 *
 * Call lifecycle, WebSocket event normalisation, gate config, and audio
 * buffering strategy are all Twilio-specific and co-located here.
 */

'use strict';

const { twiml: Twiml } = require('twilio');
const { createTwilioClient } = require('./twilioClient');
const CallRegistry = require('../../services/CallRegistry');
const writeQueue = require('../../services/writeQueue');
const UserRepository = require('../../repositories/UserRepository');
const { parseE164CountryCode, normalizeTransferNumber } = require('../../Utils/phoneUtils');

// ── Internal client factory ───────────────────────────────────────────────────

function getTwilioClient() {
    return createTwilioClient({
        accountSid: process.env.TWILIO_ACCOUNT_SID,
        authToken: process.env.TWILIO_ACCOUNT_AUTH_TOKEN || process.env.TWILIO_AUTH_TOKEN
    });
}

function buildTransferActionUrl({ attemptId, rootCallId } = {}) {
    if (!process.env.NETWORK_URL || !attemptId || !rootCallId) return null;
    const params = new URLSearchParams({
        attemptId: String(attemptId),
        rootCallId: String(rootCallId)
    });
    return `https://${process.env.NETWORK_URL}/twilio-transfer-action?${params.toString()}`;
}

// ── Call lifecycle ────────────────────────────────────────────────────────────

/**
 * Initiate an outbound Twilio call.
 * options: optional { contextHint: string|null, policyConfig: object|null }
 */
async function createCall(toNumber, name, persona, language, options) {
    console.log('Attempting to initiate Twilio call...', toNumber, name);
    const client = getTwilioClient();
    const response = await client.calls.create({
        from: process.env.TWILIO_FROM_NUMBER,
        to: toNumber,
        url: `https://${process.env.NETWORK_URL}/incoming-twilio`,
        statusCallback: `https://${process.env.NETWORK_URL}/twilio-status`,
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        statusCallbackMethod: 'POST'
    });

    console.log(`Twilio call initiated: ${response.sid} → ${toNumber}`);
    const policyConfig = options?.policyConfig != null ? { ...options.policyConfig } : undefined;
    if (policyConfig != null && policyConfig.isoCountryCode == null && toNumber) {
        const parsed = parseE164CountryCode(toNumber);
        if (parsed != null) policyConfig.isoCountryCode = parsed;
    }

    CallRegistry.create(response.sid, {
        recipient: toNumber,
        sid: response.sid,
        startedAt: Date.now(),
        status: 'initiated',
        transcript: [],
        voicemail: 'false',
        interested: 'false',
        name,
        streamID: null,
        persona,
        language,
        aiProvider: options?.aiProvider ?? null,
        timestamp: new Date().toISOString(),
        contextHint: options?.contextHint ?? null,
        policyConfig: policyConfig ?? null,
        requireExplicitRecordingConsent: options?.requireExplicitRecordingConsent ?? false
    });
    writeQueue.enqueue({ type: 'create_call', callSID: response.sid, phoneNumber: toNumber, provider: 'twilio' });

    const _cleanupTimer = setTimeout(() => { CallRegistry.delete(response.sid); }, 2 * 60 * 60 * 1000);
    CallRegistry.update(response.sid, { _cleanupTimer });

    // Fire-and-forget: DB write must not block call initiation or eat into timeout budget
    UserRepository.createUser(response.sid, toNumber, name, 'initiated', 'false', 'false', 'not found', 'not found')
        .catch(err => console.error(`Twilio: failed to persist user for ${response.sid}:`, err.message));

    return { callSid: response.sid, phoneNumber: toNumber };
}

async function hangup(callSID) {
    if (!callSID) {
        console.error('Twilio hangup: no callSID provided.');
        return;
    }
    try {
        console.log(`Twilio: hanging up call ${callSID}`);
        const client = getTwilioClient();
        const call = await client.calls(callSID).update({ status: 'completed' });
        const callState = CallRegistry.get(callSID);
        if (callState?._cleanupTimer) {
            clearTimeout(callState._cleanupTimer);
            CallRegistry.update(callSID, { _cleanupTimer: null });
        }
        console.log(`Twilio call ended: ${call.sid}`);
    } catch (error) {
        console.error(`Twilio hangup error for ${callSID}:`, error.message);
        if (error.statusCode === 404) {
            console.log('Twilio: call may have already ended or SID is invalid');
        }
    }
}

async function transfer(callSID, transferNumber, options = {}) {
    if (!callSID || !transferNumber) {
        console.error('Twilio transfer: missing callSID or transferNumber.');
        return false;
    }
    const normalized = normalizeTransferNumber(transferNumber);
    if (!normalized.ok) {
        console.error(`Twilio transfer: invalid transfer number ${String(transferNumber).trim()}`);
        return false;
    }
    const normalizedTransferNumber = normalized.number;
    try {
        console.log(`Twilio: transferring call ${callSID} to ${normalizedTransferNumber}`);
        const client = getTwilioClient();
        const voiceResponse = new Twiml.VoiceResponse();
        const actionUrl = buildTransferActionUrl({
            attemptId: options.attemptId,
            rootCallId: options.rootCallId || callSID
        });
        if (actionUrl) {
            voiceResponse.dial({
                action: actionUrl,
                method: 'POST',
                answerOnBridge: true,
                timeout: Number.isFinite(Number(options.timeoutSeconds)) ? Number(options.timeoutSeconds) : 20
            }, normalizedTransferNumber);
        } else {
            voiceResponse.dial(normalizedTransferNumber);
        }
        await client.calls(callSID).update({
            twiml: voiceResponse.toString()
        });
        console.log(`Twilio call ${callSID} transferred to ${normalizedTransferNumber}`);
        return true;
    } catch (error) {
        console.error(`Twilio transfer error for ${callSID}:`, error.message);
        return false;
    }
}

// ── Incoming call XML ─────────────────────────────────────────────────────────

function incomingCallXml(networkUrl) {
    const streamUrl = `wss://${networkUrl}/connection_twilio`;
    return `<Response>
  <Connect>
    <Stream url="${streamUrl}" />
  </Connect>
</Response>`;
}

// ── WebSocket event normalisation ─────────────────────────────────────────────

/**
 * Twilio sends callSid and streamSid inside msg.start.
 * Normalise to canonical { callId, streamId } used by createCallSession.
 */
function extractStartFields(msg) {
    return {
        callId: msg.start.callSid,
        streamId: msg.start.streamSid,
        callerNumber: msg.start?.customParameters?.From || msg.start?.customParameters?.To || null
    };
}

// ── Audio gate configuration ──────────────────────────────────────────────────

/**
 * Twilio reads gate constants from environment variables, falling back to
 * defaults tuned for PCM-domain RMS energy (after µ-law decode fix).
 *
 * Both providers use the energy-override and silence-failsafe paths.
 * Set nullable fields to "null", "none", "disabled", or "off" to skip that branch.
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
        dynamicThresholdOffset: readGateNumber(process.env.GATE_DYNAMIC_THRESHOLD_OFFSET, 0.02),
        silenceFramesThreshold: readGateNumber(process.env.GATE_SILENCE_FRAMES_THRESHOLD, 20),
        energyOverrideThreshold: readGateNumber(process.env.GATE_ENERGY_OVERRIDE_THRESHOLD, 0.03, { allowNull: true }),
        maxSilenceFailsafe: readGateNumber(process.env.GATE_MAX_SILENCE_FAILSAFE, 50, { allowNull: true })
    };
}

// ── Provider object ───────────────────────────────────────────────────────────

const TwilioProvider = Object.freeze({
    name: 'twilio',
    wsRoute: 'connection_twilio',

    createCall,
    hangup,
    transfer,
    buildTransferActionUrl,
    incomingCallXml,
    extractStartFields,
    getGateConfig,

    /** Frames are queued FIFO in edgeSession.audioInputQueue and drained by the denoiser. */
    audioBufferStrategy: 'fifo-queue',

    /**
     * Realtime service listeners are registered inside the WS 'start' event handler,
     * after realtimeService.removeAllListeners() is called.
     */
    listenerRegistrationTiming: 'on_start',

    /**
     * Twilio may receive media frames before session.updated fires (Azure session not yet
     * configured). These frames are buffered in preConnectAudioQueue and flushed on
     * session_configured. Plivo does not exhibit this timing issue.
     */
    hasPreConnectBuffer: true,

    /**
     * Twilio media handler also checks realtimeService.isSessionConfigured before passing
     * audio to Azure. Plivo only checks isConnected.
     */
    requiresSessionConfigured: true
});

module.exports = TwilioProvider;
