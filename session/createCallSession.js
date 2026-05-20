'use strict';

/**
 * createCallSession — shared WebSocket handler factory.
 *
 * Returns a function(ws) that handles a complete call session for any provider.
 * Provider-specific behaviour is injected through the `provider` object (see
 * adapters/telecom/TelecomProvider.js for the contract).
 *
 * Usage in app.js:
 *
 *   app.ws('/connection_twilio', createCallSession(
 *       TwilioProvider,
 *       { streamServiceClass: StreamServiceTwilio }
 *   ));
 *
 * Backward-compatible legacy form is also supported:
 *
 *   createCallSession(TwilioProvider, {
 *       streamServiceClass: StreamServiceTwilio,
 *       realtimeServiceClass: RealtimeServiceTwilio
 *   })
 */

const { EventEmitter } = require('events');
const { v4: uuidv4 } = require('uuid');
const { pcm16ToMulaw } = require('../Helper/audioCodec');
const { RealTimeRNNoise } = require('../Noise-Reducer/noise-reducer');
const CallRegistry = require('../services/CallRegistry');
const { finalizeCall } = require('../services/callFinalizer');
const CallContextStore = require('../services/CallContextStore');
const writeQueue = require('../services/writeQueue');
const telemetry = require('../Utils/telemetry');
const { normalizeTransferNumber } = require('../Utils/phoneUtils');
const { resolveAgentAvailability } = require('../services/agentAvailabilityService');
const { sendHandoverEmail } = require('../Helper/emailHelper');
const workflowOrchestration = require('../services/workflowOrchestrationService');
const { assertTurnActive } = require('../Utils/turnGuard');
const { epochTimeout } = require('../Utils/epochTimeout');
const { assertAudioSafe, epochGuardedTimeout } = require('../Helper/appHelpers');
const {
    InteractionMode,
    ContextHint,
    evaluateSpeechPermission,
    getDefaultPolicyConfig
} = require('../policy/callInteractionPolicy');
const { createDegradationStateEngine } = require('../policy/degradationStateEngine');
const { computeAmbiguityScore, getUnlockDecision } = require('../policy/ambiguityScoringEngine');
const { evaluateEscalation, getEscalationToneOverride } = require('../logic/escalationEngine');
const { detectSentiment } = require('../Helper/sentimentDetector');
const { buildToneDirective } = require('../Helper/toneDirectiveMapper');
const {
    assertInteractiveBeforeNonGuardedSend,
    isValidHumanTranscript,
    transitionMode,
    validatePolicyConfig
} = require('../policy/appPolicyHelpers');
const {
    getPhase3Config,
    PREWARM,
    PACING,
    MICRO_ACK,
    PHASE3_ENABLED,
    PHASE3_DEBUG,
    LATENCY_COMPENSATION
} = require('../config/latencyResponsivenessConfig');
const {
    logLatencyOverruns,
    createLatencyCompensationEngine,
    loadNeutralAudioSync,
    shouldEmitMicroAck,
    mayEmitMicroAckNow
} = require('../config/latencyResponsivenessRuntime');
const { resolveAIProvider } = require('../adapters/ai/resolveAIProvider');
const { resolveCallAIProvider } = require('../adapters/ai/resolveCallAIProvider');
const { routeModel } = require('../adapters/ai/modelRouter');
const { PHASE4_ENABLED, getPhase4ProfileName } = require('../config/phase4Config');
const { getConversationProfile } = require('../profiles/conversationProfiles');
const CXStateRegistry = require('../services/CXStateRegistry');

const phase3Config = getPhase3Config();
const DEFAULT_POLICY_CONFIG = getDefaultPolicyConfig();

// ── μ-law decode table (ITU-T G.711) ─────────────────────────────────────────
// Used by GateV2 to compute correct PCM-domain RMS energy.
// Previous formula `(byte - 128)²` was inverted for μ-law: silence (0xFF)
// mapped to high energy and loud speech (0x80) mapped to zero.
const ULAW_DECODE_TABLE = new Int16Array(256);
{
    const BIAS = 0x84;
    for (let i = 0; i < 256; i++) {
        let mu = ~i & 0xff;
        const sign = mu & 0x80;
        const exponent = (mu >> 4) & 0x07;
        const mantissa = mu & 0x0f;
        let sample = ((mantissa << 3) + BIAS) << exponent;
        sample -= BIAS;
        if (sign) sample = -sample;
        ULAW_DECODE_TABLE[i] = sample;
    }
}
const MAX_BOT_TURNS = Number(process.env.MAX_BOT_TURNS) || 20;
const HANDOVER_TRANSFER_NUMBER = process.env.HANDOVER_TRANSFER_NUMBER || null;
const PHASE2_5_2_UNLOCK_DEBUG = process.env.PHASE2_5_2_UNLOCK_DEBUG === 'true';
const MAX_CLARIFICATIONS = 2;

function readNumberEnv(name, defaultValue) {
    const raw = process.env[name];
    if (raw === undefined || String(raw).trim() === '') return defaultValue;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : defaultValue;
}

function readBoundedNumberEnv(name, defaultValue, { min = -Infinity, max = Infinity, integer = false } = {}) {
    const parsed = readNumberEnv(name, defaultValue);
    const bounded = Math.max(min, Math.min(max, parsed));
    return integer ? Math.floor(bounded) : bounded;
}

function readCsvEnv(name) {
    return String(process.env[name] || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
}

function isGateDebugTraceCall(callSID) {
    if (!callSID) return false;
    const callIds = readCsvEnv('GATE_DEBUG_TRACE_CALL_IDS');
    return callIds.includes(callSID);
}

function shouldEmitGateDebugTrace(callSID) {
    if (!isGateDebugTraceCall(callSID)) return false;
    const sampleRate = Math.max(0, Math.min(1, readNumberEnv('GATE_DEBUG_TRACE_SAMPLE_RATE', 1)));
    if (sampleRate <= 0) return false;
    return sampleRate >= 1 || Math.random() < sampleRate;
}

const GATE_DIAGNOSTIC_HIGH_ENERGY_DROP_THRESHOLD = readBoundedNumberEnv('GATE_DIAGNOSTIC_HIGH_ENERGY_DROP_THRESHOLD', 0.05, { min: 0, max: 1 });
const GATE_DIAGNOSTIC_HIGH_NOISE_FLOOR_THRESHOLD = readBoundedNumberEnv('GATE_DIAGNOSTIC_HIGH_NOISE_FLOOR_THRESHOLD', 0.05, { min: 0, max: 1 });
const GATE_MAX_MEDIA_PAYLOAD_CHARS = readBoundedNumberEnv('GATE_MAX_MEDIA_PAYLOAD_CHARS', 8192, { min: 1, max: 1048576, integer: true });
const SILENCE_HANGUP_SIGNAL_DELAY_MS = readBoundedNumberEnv('SILENCE_HANGUP_SIGNAL_DELAY_MS', 0, { min: 0, max: 60000, integer: true });
const HOLD_MUSIC_MAX_DURATION_MS = readBoundedNumberEnv('HOLD_MUSIC_MAX_DURATION_MS', 30000, { min: 0, max: 300000, integer: true });
const HANDOVER_TRANSFER_DELAY_MS = 3000;
const HANDOVER_FALLBACK_HANGUP_DELAY_MS = 4000;
const BASE64_MEDIA_PAYLOAD_REGEX = /^[A-Za-z0-9+/]+={0,2}$/;

function isValidBase64MediaPayload(mediaPayload) {
    return mediaPayload.length % 4 === 0 && BASE64_MEDIA_PAYLOAD_REGEX.test(mediaPayload);
}

// Pre-load error audio once at module level (shared across all sessions)
let _errorAudioBase64 = null;
let _errorAudioDurationSec = 0;
try {
    const fs = require('fs');
    const errorPath = require('path').join(__dirname, '..', 'Music', 'error.mulaw');
    const buf = fs.readFileSync(errorPath);
    _errorAudioBase64 = buf.toString('base64');
    _errorAudioDurationSec = buf.length / 8000;
} catch (err) {
    // Handled at startup in app.js; logged there already
}

function computeKeywordMatch(text, lastIntent) {
    if (!lastIntent) return 0.7;
    const keywords = lastIntent.toLowerCase().split(' ');
    const lower = text.toLowerCase();
    let matches = 0;
    for (const k of keywords) {
        if (k.length > 3 && lower.includes(k)) matches++;
    }
    return Math.min(1, matches / Math.max(1, keywords.length));
}

function registerSilenceHangupSignalHandler({ edgeSession, provider, turnState, setTimerId }) {
    edgeSession.onSignal('signal_silence_hangup', (turnId) => {
        const scheduledTurn = turnId;
        const timerId = epochTimeout(turnState, () => {
            if (!assertTurnActive(turnState, scheduledTurn)) return;
            provider.hangup(edgeSession.callSID);
        }, SILENCE_HANGUP_SIGNAL_DELAY_MS);

        if (typeof setTimerId === 'function') {
            setTimerId(timerId);
        }
    });
}

function registerHandoverSignalHandler({
    edgeSession,
    provider,
    getRealtimeService,
    scheduleLifecycleTimeout,
    scheduleTransferTimeout,
    isSessionClosed,
    isTelecomCallActive,
    telemetryClient = telemetry,
    sendHandoverEmailFn = sendHandoverEmail,
    agentAvailabilityResolver = resolveAgentAvailability,
    handoverTransferNumber = HANDOVER_TRANSFER_NUMBER,
    transferDelayMs = HANDOVER_TRANSFER_DELAY_MS,
    fallbackHangupDelayMs = HANDOVER_FALLBACK_HANGUP_DELAY_MS,
}) {
    const lifecycleScheduler = typeof scheduleLifecycleTimeout === 'function'
        ? scheduleLifecycleTimeout
        : (fn, delayMs) => setTimeout(fn, delayMs);
    const transferScheduler = typeof scheduleTransferTimeout === 'function'
        ? scheduleTransferTimeout
        : (fn, delayMs) => setTimeout(fn, delayMs);
    const sessionClosed = typeof isSessionClosed === 'function' ? isSessionClosed : () => false;
    const telecomCallActive = typeof isTelecomCallActive === 'function' ? isTelecomCallActive : () => !sessionClosed();
    const emitTelemetry = (event, payload) => {
        if (telemetryClient && typeof telemetryClient.emit === 'function') telemetryClient.emit(event, payload);
    };
    const getRealtime = typeof getRealtimeService === 'function'
        ? getRealtimeService
        : () => getRealtimeService;

    edgeSession.onSignal('signal_handover', (data = {}) => {
        const realtimeService = getRealtime() || {};
        const updateHandoverTransferState = (patch = {}) => {
            const nextState = {
                ...(realtimeService._handoverTransferState || {}),
                ...patch,
                updatedAt: Date.now()
            };
            realtimeService._handoverTransferState = nextState;
            try {
                if (edgeSession.callSID) CallRegistry.update(edgeSession.callSID, { handoverTransferState: nextState });
            } catch (_) {}
            return nextState;
        };
        const safeSendTextResponse = (message, source) => {
            if (typeof realtimeService.sendTextResponse !== 'function') return;
            try {
                realtimeService.sendTextResponse(message);
            } catch (err) {
                console.error(`[${provider.name}:${edgeSession.connectionId}] signal_handover ${source} TTS error:`, err);
            }
        };

        try {
            const { reason } = data || {};

            const contact = {
                ...(realtimeService.persona?.contact || {}),
                ...(realtimeService.kb?.contact || {})
            };
            const rawTransferNumber = contact.transferNumber || handoverTransferNumber || null;
            const normalizedTransfer = normalizeTransferNumber(rawTransferNumber);
            const fallbackTransferNumber = normalizedTransfer.ok ? normalizedTransfer.number : null;
            const invalidTransferNumber = !!rawTransferNumber && !normalizedTransfer.ok;
            const notificationEmail = contact.notificationEmail || null;
            const ccEmail           = contact.ccEmail           || null;
            const attemptId = data.attemptId || `handover-${uuidv4()}`;
            const availability = agentAvailabilityResolver({
                env: process.env,
                contact,
                personaId: realtimeService.persona?.id,
                fallbackTransferNumber
            });
            const warmTransferAvailable = !!(availability.enabled && availability.available && availability.selectedTargets?.length);
            const transferNumber = warmTransferAvailable ? availability.selectedTargets[0] : fallbackTransferNumber;
            const transferMode = warmTransferAvailable ? 'warm' : 'cold';

            if (availability.enabled) {
                emitTelemetry('agent_availability_checked', {
                    connectionId: edgeSession.connectionId,
                    callId: edgeSession.callSID,
                    attemptId,
                    mode: availability.mode,
                    available: availability.available,
                    selectedTargetCount: availability.selectedTargets?.length || 0,
                    reason: availability.reason,
                    ts: Date.now()
                });
            }

            const transferMessages = {
                caller_requested:     'Let me connect you with a team member who can help you directly. Please hold for just a moment.',
                turn_limit:           'Let me connect you with someone from our team who can continue helping you. Please hold for a moment.',
                escalation_hostility: 'Let me connect you with a team member right away. Please hold.',
            };
            const fallbackMessages = {
                caller_requested:     "I'm sorry, no executive is available right now. A team member will reach out to you shortly.",
                turn_limit:           'Our team will be in touch with you directly. Thank you for speaking with us today.',
                escalation_hostility: 'I understand. A team member will reach out to you personally very soon. Thank you for your patience.',
            };

            updateHandoverTransferState({
                triggered: true,
                reason,
                attemptId,
                mode: transferMode,
                provider: provider.name,
                sourceCallId: edgeSession.callSID || null,
                transferNumberRaw: rawTransferNumber,
                transferNumberNormalized: transferNumber,
                invalidNumber: invalidTransferNumber,
                invalidReason: invalidTransferNumber ? normalizedTransfer.reason : null,
                noTransferNumber: !transferNumber,
                fallbackUsed: !transferNumber,
                requestAccepted: false,
                requestFailed: false,
                bridgeConfirmed: false,
                bridgeFailed: false,
                bridgeEvidence: null,
                agentAvailability: availability,
                targetNumber: transferNumber,
                requestedAt: Date.now()
            });

            if (invalidTransferNumber) {
                emitTelemetry('handover_transfer_invalid_number', {
                    connectionId: edgeSession.connectionId,
                    callId: edgeSession.callSID,
                    reason,
                    invalidReason: normalizedTransfer.reason,
                    ts: Date.now()
                });
            }

            const handoverMessage = transferNumber
                ? (transferMessages[reason] || transferMessages.caller_requested)
                : (fallbackMessages[reason] || fallbackMessages.caller_requested);

            const emailContext = {
                callerName:    realtimeService.name,
                callerNumber:  realtimeService.recipient,
                userEmail:     realtimeService.userEmail,
                userPhone:     realtimeService.userPhone,
                preferredSlot: realtimeService.preferredSlot,
                reason,
                persona:       realtimeService.persona?.id,
                notificationEmail,
                ccEmail,
            };

            const sendHandoverFollowup = async (patch = {}) => {
                const followup = {
                    ...emailContext,
                    ...patch,
                    callId: edgeSession.callSID || null,
                    connectionId: edgeSession.connectionId,
                    attemptId,
                };
                if (sendHandoverEmailFn !== sendHandoverEmail) {
                    return sendHandoverEmailFn(followup);
                }
                const result = await workflowOrchestration.handleHandoverFollowup({
                    edgeSession,
                    attemptId,
                    followup,
                    lockId: `session-${edgeSession.connectionId}`,
                });
                return result?.ok === true;
            };

            if (transferNumber) {
                emitTelemetry('handover_transfer_scheduled', {
                    connectionId: edgeSession.connectionId,
                    callId: edgeSession.callSID,
                    reason,
                    attemptId,
                    mode: transferMode,
                    transferNumber,
                    delayMs: transferDelayMs,
                    ts: Date.now()
                });
                emitTelemetry(warmTransferAvailable ? 'warm_transfer_started' : 'cold_transfer_started', {
                    connectionId: edgeSession.connectionId,
                    callId: edgeSession.callSID,
                    attemptId,
                    mode: transferMode,
                    transferNumber,
                    ts: Date.now()
                });
                transferScheduler(() => {
                    (async () => {
                        if (!edgeSession.callSID || !telecomCallActive()) return;
                        updateHandoverTransferState({ attempted: true, attemptedAt: Date.now() });
                        const transferRequestAccepted = await provider.transfer(edgeSession.callSID, transferNumber, {
                            attemptId,
                            mode: transferMode,
                            rootCallId: edgeSession.callSID,
                            timeoutSeconds: availability.timeoutSeconds,
                            confirmTimeoutSeconds: availability.confirmTimeoutSeconds,
                            confirmKey: availability.confirmKey,
                            agentTargets: availability.selectedTargets || []
                        });
                        updateHandoverTransferState({
                            requestAccepted: transferRequestAccepted,
                            requestFailed: !transferRequestAccepted,
                            requestCompletedAt: Date.now()
                        });
                        emitTelemetry(transferRequestAccepted ? 'transfer_request_accepted' : 'transfer_request_failed', {
                            connectionId: edgeSession.connectionId,
                            callId: edgeSession.callSID,
                            reason,
                            attemptId,
                            mode: transferMode,
                            transferNumber,
                            success: transferRequestAccepted,
                            ts: Date.now()
                        });
                        if (!transferRequestAccepted) {
                            const failMsg = realtimeService?.lang?.sttLocale?.startsWith('de')
                                ? 'Leider ist gerade kein Mitarbeiter erreichbar. Ein Teammitglied wird sich in Kürze bei Ihnen melden. Können Sie mir eine E-Mail-Adresse oder Telefonnummer nennen, unter der wir Sie am besten erreichen?'
                                : "I'm sorry, no one is available to take the call right now. A team member will reach out to you shortly. Could you share an email or phone number where we can best reach you?";
                            if (!sessionClosed()) safeSendTextResponse(failMsg, 'transfer_failed');
                            emitTelemetry('transfer_failed_callback_offered', {
                                connectionId: edgeSession.connectionId,
                                callId: edgeSession.callSID,
                                reason,
                                ts: Date.now()
                            });
                            await sendHandoverFollowup({ transferAttempted: true, transferFailed: true, transferStatus: 'request_failed' });
                        }
                    })().catch((err) => {
                        console.error(`[${provider.name}:${edgeSession.connectionId}] signal_handover deferred error:`, err);
                        if (!sessionClosed()) provider.hangup(edgeSession.callSID);
                    });
                }, transferDelayMs);
            } else {
                lifecycleScheduler(() => {
                    (async () => {
                        await sendHandoverFollowup({
                            transferAttempted: false,
                            transferFailed: invalidTransferNumber,
                            transferStatus: invalidTransferNumber ? 'invalid_number' : 'not_configured'
                        });
                        if (sessionClosed()) return;
                        const farewellMsg = realtimeService?.lang?.sttLocale?.startsWith('de')
                            ? 'Vielen Dank für Ihren Anruf. Wir werden Sie innerhalb einer Stunde zurückrufen.'
                            : 'Thank you for your time. We will call you back within the hour. Goodbye!';
                        safeSendTextResponse(farewellMsg, 'fallback_close');
                        emitTelemetry('handover_fallback_close', {
                            connectionId: edgeSession.connectionId,
                            callId: edgeSession.callSID,
                            reason,
                            noTransferNumber: true,
                            ts: Date.now()
                        });
                        lifecycleScheduler(() => provider.hangup(edgeSession.callSID), fallbackHangupDelayMs);
                    })().catch((err) => {
                        console.error(`[${provider.name}:${edgeSession.connectionId}] signal_handover deferred error:`, err);
                        if (!sessionClosed()) provider.hangup(edgeSession.callSID);
                    });
                }, transferDelayMs);
            }

            safeSendTextResponse(handoverMessage, 'handover');
        } catch (err) {
            console.error(`[${provider.name}:${edgeSession.connectionId}] signal_handover error:`, err);
            try {
                if (!sessionClosed()) provider.hangup(edgeSession.callSID);
            } catch (hangupErr) {
                console.error(`[${provider.name}:${edgeSession.connectionId}] signal_handover hangup fallback failed:`, hangupErr);
            }
        }
    });
}

/**
 * @param {import('../adapters/telecom/TelecomProvider')} provider
 * @param {Function|{ streamServiceClass: Function, realtimeServiceClass?: Function }} aiProviderOrServices
 * @param {{ streamServiceClass: Function }} [services]
 * @returns {function(req, res): Promise<void>}
 */
function createCallSession(provider, aiProviderOrServices, services) {
    let streamServiceClass;
    let realtimeServiceClass;

    if (typeof aiProviderOrServices === 'function') {
        realtimeServiceClass = aiProviderOrServices;
        ({ streamServiceClass } = services || {});
    } else {
        ({ streamServiceClass, realtimeServiceClass } = aiProviderOrServices || {});
    }

    if (typeof streamServiceClass !== 'function') {
        throw new Error('createCallSession requires a streamServiceClass');
    }

    const gateConfig = provider.getGateConfig();
    const gateTurnSummaryDelayMs = Number(process.env.GATE_TURN_SUMMARY_DELAY_MS) || 250;

    return async function handleWebSocket(req, res) {
        let ws;
        try {
            ws = await res.accept();
        } catch (err) {
            console.error(`[${provider.name}] WS accept failed (client disconnected during upgrade):`, err.message || err);
            return;
        }
        console.log(`[${provider.name}] WebSocket connection established`);

        /**
         * EDGE MEDIA LAYER: responsible only for audio ingress, μ-law↔PCM, noise suppression,
         * barge-in signaling, audio batching/pacing, audio egress. NOT responsible for
         * dialogue decisions, hangup decisions, RAG, language selection, turn/epoch.
         */

        const signalEmitter = new EventEmitter();
        const connectionId = uuidv4();

        const edgeSession = {
            callSID: undefined,
            streamSessionId: undefined,
            connectionId,
            currentTurnId: null,
            connectionDenoiser: null,
            latestAudioFrame: null,
            lastEnergyScore: 0.01,
            energyHistory: [],
            energyVariance: 0,
            energySlope: 0,
            lastAudioFrameTs: null,
            denoiseWorkerRunning: false,
            audioChunks: [],
            audioBytes: 0,
            audioTimer: null,
            lastAudioDuration: null,
            pauseTranscription: false,
            denoiseBypass: false,
            isClosed: false,
            _firstOutboundAudioLogged: false,
            emitSignal(event, ...args) { signalEmitter.emit(event, ...args); },
            onSignal(event, fn) { signalEmitter.on(event, fn); },
            // Phase D: Packet tracking for degradation enrichment
            packetFrameCount: 0,
            packetWindowStart: Date.now(),
            packetLossRatio: 0,
            expectedFrameRate: 50,
            gateStatsByTurn: new Map(),
            invalidMediaFrameCount: 0,
            invalidMediaFrameSuppressed: 0
        };

        function describeInvalidMediaPayload(mediaPayload) {
            if (typeof mediaPayload !== 'string') return { reason: 'missing_payload' };
            if (mediaPayload.length === 0) return { reason: 'empty_payload' };
            if (mediaPayload.length > GATE_MAX_MEDIA_PAYLOAD_CHARS) {
                return {
                    reason: 'payload_too_large',
                    payloadLength: mediaPayload.length,
                    maxPayloadLength: GATE_MAX_MEDIA_PAYLOAD_CHARS
                };
            }
            if (!isValidBase64MediaPayload(mediaPayload)) {
                return {
                    reason: 'invalid_base64_payload',
                    payloadLength: mediaPayload.length
                };
            }
            return null;
        }

        function decodeMediaPayload(mediaPayload) {
            const invalidPayload = describeInvalidMediaPayload(mediaPayload);
            if (invalidPayload) return { invalidPayload, ulawBuffer: null };
            const ulawBuffer = Buffer.from(mediaPayload, 'base64');
            if (ulawBuffer.length === 0) {
                return {
                    invalidPayload: {
                        reason: 'empty_decoded_payload',
                        payloadLength: mediaPayload.length
                    },
                    ulawBuffer: null
                };
            }
            return { invalidPayload: null, ulawBuffer };
        }

        function warnInvalidMediaFrame(reason, extra = {}) {
            edgeSession.invalidMediaFrameCount += 1;
            const count = edgeSession.invalidMediaFrameCount;
            const shouldLog = count <= 5 || count % 50 === 0;
            if (!shouldLog) {
                edgeSession.invalidMediaFrameSuppressed += 1;
                return;
            }
            const suppressedSinceLastLog = edgeSession.invalidMediaFrameSuppressed;
            edgeSession.invalidMediaFrameSuppressed = 0;
            console.warn('[GateV2 INVALID_FRAME]', {
                provider: provider.name,
                connectionId: edgeSession.connectionId,
                callSID: edgeSession.callSID,
                reason,
                invalidFrameCount: count,
                suppressedSinceLastLog,
                ...extra
            });
        }

        const turnState = { currentTurnId: null, isClosed: false, isUserSpeaking: false };

        // ── Denoiser worker — strategy depends on provider ──────────────────
        // 'fifo-queue': Twilio — drains audioInputQueue in FIFO order.
        // 'single-slot': Plivo — consumes the latest frame only (overwrites on new audio).

        function startDenoiseWorker() {
            if (edgeSession.denoiseWorkerRunning) return;
            edgeSession.denoiseWorkerRunning = true;
            let failureCount = 0;

            const loop = async () => {
                if (edgeSession.isClosed) {
                    edgeSession.denoiseWorkerRunning = false;
                    return;
                }

                let frame;
                if (provider.audioBufferStrategy === 'fifo-queue') {
                    frame = (edgeSession.audioInputQueue && edgeSession.audioInputQueue.length > 0)
                        ? edgeSession.audioInputQueue.shift()
                        : null;
                } else {
                    // single-slot: consume and clear
                    frame = edgeSession.latestAudioFrame || null;
                    edgeSession.latestAudioFrame = null;
                }

                if (!frame) {
                    setImmediate(loop);
                    return;
                }

                try {
                    // processChunk accepts raw µ-law and handles µ-law→PCM16 internally.
                    // DO NOT decode µ-law before passing — causes double-decode garbage.
                    const denoisedPCM = await edgeSession.connectionDenoiser.processChunk(frame.buffer);

                    if (!assertTurnActive(turnState, frame.turnId)) {
                        setImmediate(loop);
                        return;
                    }

                    // processChunk returns PCM16 — convert back to µ-law for Azure
                    const ulaw = pcm16ToMulaw(denoisedPCM);

                    // Check pauseTranscription at send time too: audio queued BEFORE the echo
                    // guard activates can still be in the pipeline when the guard fires.
                    const sessionReady = provider.requiresSessionConfigured
                        ? (realtimeService && realtimeService.isConnected && realtimeService.isSessionConfigured)
                        : (realtimeService && realtimeService.isConnected);

                    if (sessionReady && !edgeSession.pauseTranscription) {
                        if (Math.random() < 0.05) {
                            console.log('[AUDIO->AZURE]', {
                                size: ulaw.length,
                                paused: edgeSession.pauseTranscription
                            });
                        }
                        recordGateAzureSend(frame.turnId);
                        realtimeService.sendAudio(ulaw);
                    } else if (edgeSession.pauseTranscription && echoGuardTimer) {
                        recordGateBlocked(frame.turnId, 'echo_guard');
                        echoBlockedFrames++;
                    } else {
                        recordGateBlocked(frame.turnId, sessionReady ? 'pause_transcription' : 'session_not_ready');
                    }
                } catch (err) {
                    failureCount++;
                    if (failureCount > 10) {
                        console.error(`[${provider.name}:${edgeSession.connectionId}] Denoise worker stopped after repeated failures`);
                        edgeSession.denoiseWorkerRunning = false;
                        edgeSession.denoiseBypass = true;
                        edgeSession.connectionDenoiser = null;
                        telemetry.emit('denoise_worker_stopped', {
                            connectionId: edgeSession.connectionId,
                            callId: edgeSession.callSID,
                            ts: Date.now()
                        });
                        return;
                    }
                }

                setImmediate(loop);
            };

            loop();
        }

        // ── Turn management ──────────────────────────────────────────────────

        let callContextState;

        function createGateTurnStats(turnId) {
            return {
                turnId: turnId || null,
                startedAt: Date.now(),
                lastAt: null,
                inputFrames: 0,
                gatedSendFrames: 0,
                gatedDropFrames: 0,
                lowFrames: 0,
                mediumFrames: 0,
                highFrames: 0,
                azureSentFrames: 0,
                blockedAfterGateFrames: 0,
                blockedReasons: {},
                energySum: 0,
                maxEnergy: 0,
                noiseFloorSum: 0,
                maxNoiseFloor: 0,
                dynamicThresholdSum: 0,
                maxDynamicThreshold: 0,
                maxSilenceFrames: 0,
                highEnergyDropFrames: 0,
                highNoiseFloorDropFrames: 0,
                lastGateLevel: null,
                lastGateSendAudio: null,
                lastSilenceFrames: null,
                transcriptLength: null,
                transcriptConfidence: null,
                summaryTimer: null,
                summaryEmitted: false
            };
        }

        function getGateTurnStats(turnId) {
            const key = turnId || 'preconnect';
            if (!edgeSession.gateStatsByTurn.has(key)) {
                edgeSession.gateStatsByTurn.set(key, createGateTurnStats(turnId));
                if (edgeSession.gateStatsByTurn.size > 50) {
                    const oldestKey = edgeSession.gateStatsByTurn.keys().next().value;
                    edgeSession.gateStatsByTurn.delete(oldestKey);
                }
            }
            return edgeSession.gateStatsByTurn.get(key);
        }

        function resetGateTurnStats(turnId) {
            if (!turnId) return;
            edgeSession.gateStatsByTurn.set(turnId, createGateTurnStats(turnId));
        }

        function recordGateDecision(turnId, decision) {
            const stats = getGateTurnStats(turnId);
            const energy = typeof decision.energy === 'number' ? decision.energy : 0;
            const silenceFrames = typeof decision.silenceFrames === 'number' ? decision.silenceFrames : 0;
            const noiseFloor = typeof decision.noiseFloor === 'number' ? decision.noiseFloor : 0;
            const dynamicThreshold = typeof decision.dynamicThreshold === 'number' ? decision.dynamicThreshold : 0;
            stats.inputFrames += 1;
            stats.lastAt = Date.now();
            stats.energySum += energy;
            stats.maxEnergy = Math.max(stats.maxEnergy, energy);
            stats.noiseFloorSum += noiseFloor;
            stats.maxNoiseFloor = Math.max(stats.maxNoiseFloor, noiseFloor);
            stats.dynamicThresholdSum += dynamicThreshold;
            stats.maxDynamicThreshold = Math.max(stats.maxDynamicThreshold, dynamicThreshold);
            stats.maxSilenceFrames = Math.max(stats.maxSilenceFrames, silenceFrames);
            stats.lastGateLevel = decision.gateLevel || null;
            stats.lastGateSendAudio = !!decision.shouldSendAudio;
            stats.lastSilenceFrames = silenceFrames;

            if (decision.gateLevel === 'HIGH') stats.highFrames += 1;
            else if (decision.gateLevel === 'MEDIUM') stats.mediumFrames += 1;
            else stats.lowFrames += 1;

            if (decision.shouldSendAudio) stats.gatedSendFrames += 1;
            else {
                stats.gatedDropFrames += 1;
                if (energy >= GATE_DIAGNOSTIC_HIGH_ENERGY_DROP_THRESHOLD) stats.highEnergyDropFrames += 1;
                if (noiseFloor >= GATE_DIAGNOSTIC_HIGH_NOISE_FLOOR_THRESHOLD) stats.highNoiseFloorDropFrames += 1;
            }
        }

        function recordGateBlocked(turnId, reason) {
            const stats = getGateTurnStats(turnId);
            const key = reason || 'unknown';
            stats.blockedAfterGateFrames += 1;
            stats.blockedReasons[key] = (stats.blockedReasons[key] || 0) + 1;
            stats.lastAt = Date.now();
        }

        function recordGateAzureSend(turnId) {
            const stats = getGateTurnStats(turnId);
            stats.azureSentFrames += 1;
            stats.lastAt = Date.now();
        }

        function emitGateTurnSummary(reason, turnId, extra = {}) {
            const key = turnId || 'preconnect';
            const stats = edgeSession.gateStatsByTurn.get(key);
            if (!stats) return;
            if (stats.summaryEmitted) return;
            if (stats.summaryTimer) {
                clearTimeout(stats.summaryTimer);
                stats.summaryTimer = null;
            }
            const hasActivity = stats.inputFrames > 0 || stats.azureSentFrames > 0 || stats.blockedAfterGateFrames > 0;
            if (!hasActivity) return;
            const dropRatio = stats.inputFrames > 0 ? stats.gatedDropFrames / stats.inputFrames : 0;
            const passRatio = stats.inputFrames > 0 ? stats.gatedSendFrames / stats.inputFrames : 0;
            telemetry.emit('gate_turn_summary', {
                connectionId: edgeSession.connectionId,
                callId: edgeSession.callSID,
                provider: provider.name,
                turnEpoch: turnId || null,
                reason,
                durationMs: stats.lastAt && stats.startedAt ? stats.lastAt - stats.startedAt : 0,
                inputFrames: stats.inputFrames,
                gatedSendFrames: stats.gatedSendFrames,
                gatedDropFrames: stats.gatedDropFrames,
                dropRatio: Number(dropRatio.toFixed(4)),
                passRatio: Number(passRatio.toFixed(4)),
                lowFrames: stats.lowFrames,
                mediumFrames: stats.mediumFrames,
                highFrames: stats.highFrames,
                azureSentFrames: stats.azureSentFrames,
                blockedAfterGateFrames: stats.blockedAfterGateFrames,
                blockedReasons: stats.blockedReasons,
                maxEnergy: Number(stats.maxEnergy.toFixed(6)),
                avgEnergy: stats.inputFrames > 0 ? Number((stats.energySum / stats.inputFrames).toFixed(6)) : 0,
                maxNoiseFloor: Number(stats.maxNoiseFloor.toFixed(6)),
                avgNoiseFloor: stats.inputFrames > 0 ? Number((stats.noiseFloorSum / stats.inputFrames).toFixed(6)) : 0,
                maxDynamicThreshold: Number(stats.maxDynamicThreshold.toFixed(6)),
                avgDynamicThreshold: stats.inputFrames > 0 ? Number((stats.dynamicThresholdSum / stats.inputFrames).toFixed(6)) : 0,
                maxSilenceFrames: stats.maxSilenceFrames,
                highEnergyDropFrames: stats.highEnergyDropFrames,
                highNoiseFloorDropFrames: stats.highNoiseFloorDropFrames,
                diagnosticThresholds: {
                    highEnergyDrop: GATE_DIAGNOSTIC_HIGH_ENERGY_DROP_THRESHOLD,
                    highNoiseFloor: GATE_DIAGNOSTIC_HIGH_NOISE_FLOOR_THRESHOLD
                },
                lastGateLevel: stats.lastGateLevel,
                lastGateSendAudio: stats.lastGateSendAudio,
                lastSilenceFrames: stats.lastSilenceFrames,
                transcriptLength: stats.transcriptLength,
                transcriptConfidence: stats.transcriptConfidence,
                ...extra,
                ts: Date.now()
            });
            stats.summaryEmitted = true;
        }

        function scheduleGateTurnSummary(reason, turnId, extra = {}) {
            const key = turnId || 'preconnect';
            const stats = edgeSession.gateStatsByTurn.get(key);
            if (!stats || stats.summaryEmitted || stats.summaryTimer) return;
            stats.summaryTimer = setTimeout(() => {
                stats.summaryTimer = null;
                emitGateTurnSummary(reason, turnId, extra);
            }, gateTurnSummaryDelayMs);
        }

        function newTurn() {
            if (turnState.currentTurnId) scheduleGateTurnSummary('new_turn', turnState.currentTurnId);
            turnState.currentTurnId = uuidv4();
            edgeSession.currentTurnId = turnState.currentTurnId;
            resetGateTurnStats(turnState.currentTurnId);
            telemetry.emit('turn_created', {
                turnId: turnState.currentTurnId,
                connectionId: edgeSession.connectionId,
                ts: Date.now()
            });
            telemetry.emit('turn_snapshot', {
                connectionId: edgeSession.connectionId,
                callId: edgeSession.callSID,
                turnEpoch: turnState.currentTurnId,
                interactionMode: callContextState?.interactionMode || InteractionMode.TRANSITIONAL,
                ts: Date.now()
            });
            return turnState.currentTurnId;
        }

        function ensureUserSpeechTurn(reason = 'user_speech_started') {
            if (turnState.isClosed) return null;
            if (turnState.isUserSpeaking && turnState.currentTurnId) return turnState.currentTurnId;
            return newTurn();
        }

        // ── Call context state ───────────────────────────────────────────────

        callContextState = {
            connectionId: edgeSession.connectionId,
            callId: edgeSession.callSID,
            interactionMode: InteractionMode.TRANSITIONAL,
            contextHint: undefined,
            guardedMessageAlreadySent: false,
            policyConfig: DEFAULT_POLICY_CONFIG,
            nonInteractiveTimer: null,
            lastHumanActivityTs: null,
            degradationEngine: createDegradationStateEngine({
                onStateTransition(from, to) {
                    console.log(`[Degradation][${provider.name}:${edgeSession.connectionId}] ${from} → ${to}`);
                    telemetry.emit('degradation_state_transition', {
                        connectionId: edgeSession.connectionId,
                        callId: edgeSession.callSID,
                        from,
                        to,
                        ts: Date.now()
                    });
                }
            }),
            clarificationCount: 0,
            lastSentimentPrimary: null,
            phase4Profile: PHASE4_ENABLED ? getConversationProfile(getPhase4ProfileName()) : null
        };

        // ── Phase 3 state ────────────────────────────────────────────────────

        const phase3State = {
            latencyState: { speechEndTs: null, responseStartTs: null, firstAudioFrameTs: null },
            latencyOverrunStreak: 0,
            prewarmState: { active: false, turnId: null, result: null },
            pacingTimeouts: [],
            _fillerTimer: null,
            microAck: {
                emittedThisTurn: false,
                checkTimer: null,
                windowCloseTimer: null,
                windowClosed: false,
                lastSpeechStartTs: 0
            },
            lastStoredConfidence: 1.0
        };

        const latencyCompensation = PHASE3_ENABLED && LATENCY_COMPENSATION.enabled
            ? createLatencyCompensationEngine() : null;

        let sessionCleanupStarted = false;
        let startHandled = false;
        const lifecycleTimers = new Set();

        function isSessionClosed() {
            return sessionCleanupStarted || turnState.isClosed || edgeSession.isClosed;
        }

        function clearLifecycleTimeout(timerId) {
            if (!timerId) return;
            clearTimeout(timerId);
            lifecycleTimers.delete(timerId);
        }

        function clearLifecycleTimers() {
            for (const timerId of lifecycleTimers) {
                clearTimeout(timerId);
            }
            lifecycleTimers.clear();
        }

        function scheduleLifecycleTimeout(fn, delayMs) {
            const timerId = setTimeout(() => {
                lifecycleTimers.delete(timerId);
                if (isSessionClosed()) return;
                fn();
            }, delayMs);
            if (typeof timerId.unref === 'function') timerId.unref();
            lifecycleTimers.add(timerId);
            return timerId;
        }

        function scheduleHandoverTransferTimeout(fn, delayMs) {
            return setTimeout(fn, delayMs);
        }

        function isTelecomCallActiveForTransfer() {
            if (!edgeSession.callSID) return false;
            const callState = CallRegistry.get(edgeSession.callSID);
            return callState?.status !== 'disconnected';
        }

        console.log(JSON.stringify({
            ts: Date.now(),
            level: 'info',
            callSID: edgeSession.callSID || 'none',
            event: 'latency_runtime_config',
            phase3Enabled: PHASE3_ENABLED,
            compensationEnabled: LATENCY_COMPENSATION.enabled,
            compensationActive: !!latencyCompensation,
            lightThreshold: LATENCY_COMPENSATION.lightThreshold,
            aggressiveThreshold: LATENCY_COMPENSATION.aggressiveThreshold,
            totalBudgetMs: phase3Config.latencyBudget.totalMs,
        }));

        function clearPhase3Timers() {
            phase3State.pacingTimeouts.forEach(t => clearTimeout(t));
            phase3State.pacingTimeouts.length = 0;
            if (phase3State.microAck.checkTimer) {
                clearTimeout(phase3State.microAck.checkTimer);
                phase3State.microAck.checkTimer = null;
            }
            if (phase3State.microAck.windowCloseTimer) {
                clearTimeout(phase3State.microAck.windowCloseTimer);
                phase3State.microAck.windowCloseTimer = null;
            }
            if (phase3State._fillerTimer) {
                clearLifecycleTimeout(phase3State._fillerTimer);
                phase3State._fillerTimer = null;
            }
            phase3State.microAck.windowClosed = true;
        }

        let silenceHangupTimerId = null;
        let shouldHangupTimerId = null;
        let holdMusicFailsafeTimerId = null;
        let reconnectHoldMusicActive = false;

        // ── Service instantiation ────────────────────────────────────────────

        const streamService = new streamServiceClass(ws, turnState);
        let realtimeService = null;

        function clearHoldMusicFailsafe() {
            if (holdMusicFailsafeTimerId) {
                clearLifecycleTimeout(holdMusicFailsafeTimerId);
                holdMusicFailsafeTimerId = null;
            }
        }

        function stopReconnectHoldMusic(reason) {
            const wasActive = reconnectHoldMusicActive || !!holdMusicFailsafeTimerId ||
                (typeof streamService.isInHoldMode === 'function' && streamService.isInHoldMode());
            clearHoldMusicFailsafe();
            if (typeof streamService.stopHoldMusic === 'function') {
                streamService.stopHoldMusic();
            }
            reconnectHoldMusicActive = false;
            if (!wasActive) return;
            telemetry.emit('reconnect_hold_music_stopped', {
                connectionId: edgeSession.connectionId,
                callId: edgeSession.callSID,
                reason,
                ts: Date.now()
            });
        }

        function startReconnectHoldMusic(info = {}) {
            if (isSessionClosed()) return;
            if (typeof streamService.startHoldMusic !== 'function') return;
            streamService.startHoldMusic();
            clearHoldMusicFailsafe();
            reconnectHoldMusicActive = typeof streamService.isInHoldMode === 'function'
                ? streamService.isInHoldMode()
                : true;
            if (!reconnectHoldMusicActive) return;
            telemetry.emit('reconnect_hold_music_started', {
                connectionId: edgeSession.connectionId,
                callId: edgeSession.callSID,
                isAbnormal: !!info.isAbnormal,
                isServerError: !!info.isServerError,
                ts: Date.now()
            });
            if (HOLD_MUSIC_MAX_DURATION_MS <= 0) return;
            holdMusicFailsafeTimerId = scheduleLifecycleTimeout(() => {
                holdMusicFailsafeTimerId = null;
                if (turnState.isClosed) return;
                console.warn(`[${provider.name}:${edgeSession.connectionId}] Hold music max duration reached, stopping hold loop`);
                if (typeof streamService.stopHoldMusic === 'function') streamService.stopHoldMusic();
                reconnectHoldMusicActive = false;
                telemetry.emit('reconnect_hold_music_failsafe_stop', {
                    connectionId: edgeSession.connectionId,
                    callId: edgeSession.callSID,
                    maxDurationMs: HOLD_MUSIC_MAX_DURATION_MS,
                    ts: Date.now()
                });
            }, HOLD_MUSIC_MAX_DURATION_MS);
        }

        function instantiateRealtimeService(callState) {
            if (typeof realtimeServiceClass === 'function') {
                return new realtimeServiceClass();
            }

            const aiProvider = resolveCallAIProvider({
                requestedAIProvider: callState?.aiProvider,
                personaId: callState?.persona,
                language: callState?.language,
                envDefault: process.env.AI_PROVIDER || 'azure-realtime'
            });

            // Sprint 4.8: Model router may override provider, endpoint, or A/B cohort
            const route = routeModel({
                callSID: callState?.CallSID || callState?.callSID,
                baseProvider: aiProvider,
                persona: callState?.personaConfig,
                language: callState?.language
            });

            const AIAdapterClass = resolveAIProvider(route.provider || aiProvider);
            return new AIAdapterClass({
                enableSilenceTimers: true,
                enableAudioPlaybackTracking: true,
                enableTextInputPath: provider.name === 'twilio',
                enableReconnectContext: provider.name === 'twilio',
                includeTempInSessionConfig: provider.name === 'plivo',
                emitAudioAsBuffer: true,
                // Sprint 4.8: Pass endpoint/apiKey/model overrides from router
                ...(route.endpoint && { endpoint: route.endpoint }),
                ...(route.apiKey && { apiKey: route.apiKey }),
                ...(route.model && { model: route.model }),
                _abCohort: route.abCohort,
            });
        }

        // ── Pre-connect audio buffer (Twilio only) ───────────────────────────
        // Twilio can receive media frames before Azure's session.updated fires.
        // Plivo does not have this timing issue.

        let preConnectAudioQueue = [];
        let audioBatch = [];
        const BATCH_SIZE = 10; // ~200ms audio
        const PRECONNECT_AUDIO_QUEUE_CAP = Number(process.env.PRECONNECT_AUDIO_QUEUE_CAP) || 500;

        function flushPreConnectAudioQueue() {
            while (preConnectAudioQueue.length > 0) {
                const payload = preConnectAudioQueue.shift();
                const { invalidPayload, ulawBuffer } = decodeMediaPayload(payload);
                if (invalidPayload) {
                    warnInvalidMediaFrame(invalidPayload.reason, invalidPayload);
                    continue;
                }
                audioBatch.push(ulawBuffer);
                if (audioBatch.length >= BATCH_SIZE) {
                    realtimeService.sendAudio(Buffer.concat(audioBatch));
                    audioBatch = [];
                }
            }
            if (audioBatch.length > 0) {
                realtimeService.sendAudio(Buffer.concat(audioBatch));
                audioBatch = [];
            }
        }

        function attachPreconnectBufferListener() {
            if (provider.hasPreConnectBuffer && realtimeService) {
                realtimeService.on('session_configured', flushPreConnectAudioQueue);
            }
        }

        // ── Adaptive echo guard ──────────────────────────────────────────────

        let echoGuardTimer = null;
        let echoGuardMs = Number(process.env.ECHO_GUARD_INITIAL_MS) || 1500;
        let echoGuardTurnCount = 0;
        let echoBlockedFrames = 0;
        const ECHO_GUARD_MIN_MS = Number(process.env.ECHO_GUARD_MIN_MS) || 800;
        const ECHO_GUARD_ADAPT_TURNS = Number(process.env.ECHO_GUARD_ADAPT_TURNS) || 5;
        let echoGuardAdapted = false;
        let lastAiAudioDurationMs = 0;

        function startEchoGuard() {
            edgeSession.pauseTranscription = true;
            if (echoGuardTimer) clearTimeout(echoGuardTimer);
        }
        function stopEchoGuard() {
            if (echoGuardTimer) clearTimeout(echoGuardTimer);
            // Scale guard duration proportionally to how long the AI spoke
            const proportionalMs = Math.floor(lastAiAudioDurationMs * 0.3);
            const guardDuration = Math.max(ECHO_GUARD_MIN_MS, proportionalMs, echoGuardMs);
            echoGuardTimer = setTimeout(() => {
                edgeSession.pauseTranscription = false;
                echoGuardTimer = null;
            }, guardDuration);
        }
        function cancelEchoGuard() {
            if (echoGuardTimer) clearTimeout(echoGuardTimer);
            echoGuardTimer = null;
            edgeSession.pauseTranscription = false;
        }
        function recordEchoGuardTurn() {
            if (echoGuardAdapted) return;
            echoGuardTurnCount++;
            if (echoGuardTurnCount >= ECHO_GUARD_ADAPT_TURNS) {
                echoGuardAdapted = true;
                if (echoBlockedFrames === 0) {
                    echoGuardMs = Math.max(ECHO_GUARD_MIN_MS, Math.floor(echoGuardMs / 2));
                    console.log(`[EchoGuard][${provider.name}:${edgeSession.connectionId}] No echo in ${ECHO_GUARD_ADAPT_TURNS} turns → ${echoGuardMs}ms`);
                } else {
                    console.log(`[EchoGuard][${provider.name}:${edgeSession.connectionId}] Echo detected (${echoBlockedFrames} blocked frames), keeping ${echoGuardMs}ms`);
                }
            }
        }

        // ── Signal handlers — decision execution layer ───────────────────────

        registerSilenceHangupSignalHandler({
            edgeSession,
            provider,
            turnState,
            setTimerId(timerId) {
                silenceHangupTimerId = timerId;
            }
        });

        edgeSession.onSignal('signal_should_hangup', (lastAudioDuration, turnId) => {
            const scheduledTurn = turnId;
            telemetry.emit('hangup_triggered', {
                connectionId: edgeSession.connectionId,
                callId: edgeSession.callSID,
                reason: 'ai_decision',
                ts: Date.now()
            });
            shouldHangupTimerId = epochTimeout(turnState, () => {
                if (!assertTurnActive(turnState, scheduledTurn)) return;
                provider.hangup(edgeSession.callSID);
            }, (lastAudioDuration || 0) * 1000);
        });

        registerHandoverSignalHandler({
            edgeSession,
            provider,
            getRealtimeService: () => realtimeService,
            scheduleLifecycleTimeout,
            scheduleTransferTimeout: scheduleHandoverTransferTimeout,
            isSessionClosed,
            isTelecomCallActive: isTelecomCallActiveForTransfer,
            telemetryClient: telemetry,
            sendHandoverEmailFn: sendHandoverEmail,
        });

        console.log(`[${provider.name}:${connectionId}] New WebSocket connection`);

        function cleanupCallSession(source = 'websocket_close', reason = 'ws_close') {
            if (sessionCleanupStarted) return;
            sessionCleanupStarted = true;

            const closingTurnId = turnState.currentTurnId;
            emitGateTurnSummary(reason, closingTurnId);
            stopReconnectHoldMusic(reason);
            turnState.isClosed = true;
            turnState.currentTurnId = null;
            console.log(`[${provider.name}:${edgeSession.connectionId}] Call ended: ${edgeSession.callSID}`);
            edgeSession.isClosed = true;
            edgeSession.currentTurnId = null;
            edgeSession.audioInputQueue = [];
            edgeSession.latestAudioFrame = null;
            preConnectAudioQueue = [];
            audioBatch = [];
            clearPhase3Timers();
            clearLifecycleTimers();
            cancelEchoGuard();

            if (callContextState.nonInteractiveTimer) clearTimeout(callContextState.nonInteractiveTimer);
            callContextState.nonInteractiveTimer = null;

            if (silenceHangupTimerId) clearTimeout(silenceHangupTimerId);
            silenceHangupTimerId = null;
            if (shouldHangupTimerId) clearTimeout(shouldHangupTimerId);
            shouldHangupTimerId = null;

            if (edgeSession.audioTimer) clearTimeout(edgeSession.audioTimer);
            edgeSession.audioTimer = null;
            signalEmitter.removeAllListeners();

            if (edgeSession.connectionDenoiser) {
                edgeSession.connectionDenoiser.destroy();
                edgeSession.connectionDenoiser = null;
            }

            if (realtimeService) realtimeService.close();

            const finalDegradationState = callContextState.degradationEngine?.getCurrentState?.() || 'NORMAL';
            if (callContextState.degradationEngine) callContextState.degradationEngine.resetState();
            callContextState.clarificationCount = 0;

            if (edgeSession.callSID) {
                const callState = CallRegistry.get(edgeSession.callSID);
                finalizeCall({
                    callSID: edgeSession.callSID,
                    callState,
                    realtimeService,
                    callContextState,
                    edgeSession,
                    finalDegradationState,
                    source,
                    reason
                });
                const currentCallState = CallRegistry.get(edgeSession.callSID);
                if (currentCallState?._cleanupTimer) clearTimeout(currentCallState._cleanupTimer);
                CallRegistry.update(edgeSession.callSID, { status: 'disconnected' });
                CXStateRegistry.delete(edgeSession.callSID);
                const registryCleanupTimer = setTimeout(() => { CallRegistry.delete(edgeSession.callSID); }, 2000);
                if (typeof registryCleanupTimer.unref === 'function') registryCleanupTimer.unref();
            }
        }

        ws.on('error', (err) => {
            console.error(`[${provider.name}:${connectionId}] WebSocket error:`, err);
            cleanupCallSession('websocket_error', 'ws_error');
        });

        // ── Realtime service event listeners ─────────────────────────────────

        function registerRealtimeListeners() {

            // Wire emitTelemetry callback so BaseRealtimeAdapter optional-call sites
            // (e.g. vad_ab_assignment) reach the telemetry pipeline.
            realtimeService.emitTelemetry = (event, payload) => telemetry.emit(event, payload);

            // Wire 'telemetry' EventEmitter channel used by BaseRealtimeAdapter
            // (e.g. response_loop_permanent_fallback).
            realtimeService.on('telemetry', (event, payload) => telemetry.emit(event, payload));

            workflowOrchestration.registerWorkflowEventHandlers({
                edgeSession,
                provider,
                realtimeService,
                turnState,
            });

            realtimeService.on('error', (err) => {
                console.error(`[${provider.name}:${edgeSession.connectionId}] Realtime service error:`, err);
                telemetry.emit('realtime_service_error', {
                    connectionId: edgeSession.connectionId,
                    callId: edgeSession.callSID,
                    message: err?.message || String(err),
                    ts: Date.now()
                });
            });

            realtimeService.on('response_created', () => {
                if (isSessionClosed()) return;
                newTurn();
                if (phase3State._fillerTimer) {
                    clearLifecycleTimeout(phase3State._fillerTimer);
                    phase3State._fillerTimer = null;
                }
                if (PHASE3_ENABLED) {
                    phase3State.latencyState.responseStartTs = Date.now();
                    phase3State.latencyState.firstAudioFrameTs = null;
                    if (phase3Config.latencyBudget.logOverruns && phase3State.latencyState.speechEndTs != null) {
                        const delta = phase3State.latencyState.responseStartTs - phase3State.latencyState.speechEndTs;
                        if (delta > phase3Config.latencyBudget.speechEndToResponseMs) {
                            console.warn(`[Phase3][${provider.name}:${edgeSession.connectionId}] Latency overrun: speechEnd→responseStart ${delta}ms (budget ${phase3Config.latencyBudget.speechEndToResponseMs}ms) callSID=${edgeSession.callSID}`);
                        }
                    }
                    phase3State.prewarmState.active = false;
                    phase3State.prewarmState.turnId = null;
                    phase3State.prewarmState.result = null;
                    realtimeService.clearPrewarmKnowledge();
                    clearPhase3Timers();
                } else {
                    clearPhase3Timers();
                }
                if (callContextState.interactionMode === InteractionMode.TRANSITIONAL &&
                    (callContextState.contextHint === ContextHint.VOICEMAIL || callContextState.contextHint === ContextHint.OS_SCREENING)) {
                    if (callContextState.nonInteractiveTimer) clearTimeout(callContextState.nonInteractiveTimer);
                    const scheduledTurn = turnState.currentTurnId;
                    const NON_INTERACTIVE_GRACE_MS =
                        callContextState.policyConfig?.nonInteractiveDelayMs ||
                        (callContextState.contextHint === ContextHint.OS_SCREENING ? 8000 : 6000);
                    callContextState.nonInteractiveTimer = setTimeout(() => {
                        if (!assertTurnActive(turnState, scheduledTurn)) return;
                        const now = Date.now();
                        if (callContextState.lastHumanActivityTs &&
                            now - callContextState.lastHumanActivityTs < NON_INTERACTIVE_GRACE_MS) {
                            return;
                        }
                        callContextState.nonInteractiveTimer = null;
                        transitionMode(callContextState, InteractionMode.NON_INTERACTIVE, 'non_interactive_timeout');
                        callContextState.clarificationCount = 0;
                    }, NON_INTERACTIVE_GRACE_MS);
                }
            });

            realtimeService.on('interruption', (interruptInfo) => {
                if (interruptInfo && interruptInfo.isBargeIn === false) return;
                const cancelledResponseId = interruptInfo?.cancelledResponseId || null;
                let interruptedTurnId = turnState.currentTurnId;
                if (!interruptedTurnId && !turnState.isClosed) {
                    interruptedTurnId = ensureUserSpeechTurn('interruption_fallback');
                }
                if (!interruptedTurnId) return;
                telemetry.emit('turn_interrupted', {
                    connectionId: edgeSession.connectionId,
                    callId: edgeSession.callSID,
                    turnEpoch: interruptedTurnId,
                    ts: Date.now()
                });
                callContextState.lastHumanActivityTs = Date.now();
                transitionMode(callContextState, InteractionMode.INTERACTIVE, 'interruption');
                if (callContextState.nonInteractiveTimer) clearTimeout(callContextState.nonInteractiveTimer);
                callContextState.nonInteractiveTimer = null;
                if (PHASE3_ENABLED) {
                    clearPhase3Timers();
                    phase3State.prewarmState.active = false;
                    phase3State.prewarmState.turnId = null;
                    phase3State.prewarmState.result = null;
                    if (typeof realtimeService.clearPrewarmKnowledge === 'function') realtimeService.clearPrewarmKnowledge();
                    if (PHASE3_DEBUG) console.warn(`[Phase3][${provider.name}:${edgeSession.connectionId}] MA cancelled (interruption)`);
                }
                console.log(`[${provider.name}:${edgeSession.connectionId}] Barge-in detected - stopping audio`);
                cancelEchoGuard();
                streamService.stopCurrentAudio(cancelledResponseId);
                realtimeService.markBargeInOccurred();
                realtimeService.cancelResponse();
                telemetry.emit('speech_cancelled', {
                    connectionId: edgeSession.connectionId,
                    callId: edgeSession.callSID,
                    reason: 'interruption',
                    turnEpoch: interruptedTurnId,
                    ts: Date.now()
                });
                telemetry.emit('turn_closed', {
                    connectionId: edgeSession.connectionId,
                    callId: edgeSession.callSID,
                    turnEpoch: interruptedTurnId,
                    outcome: 'interrupted',
                    ts: Date.now()
                });
                emitGateTurnSummary('turn_interrupted', interruptedTurnId);
                edgeSession.audioChunks = [];
                if (edgeSession.audioTimer) clearTimeout(edgeSession.audioTimer);
            });

            // Phase 4 escalation: wire to existing handover signal
            realtimeService.on('escalation_needed', (data) => {
                telemetry.emit('phase4_escalation', {
                    connectionId: edgeSession.connectionId,
                    callId: edgeSession.callSID,
                    reason: data?.reason || 'unknown',
                    clarificationCount: data?.clarificationCount,
                    ts: Date.now()
                });
                realtimeService._handoverTriggered = true;
                edgeSession.emitSignal('signal_handover', {
                    reason: data?.reason || 'phase4_escalation',
                    callSID: edgeSession.callSID
                });
            });

            // Phase 4 counter sync: keep adapter + call context clarification counts in sync
            realtimeService.on('clarification_sync', (count) => {
                callContextState.clarificationCount = count;
            });

            realtimeService.on('user_transcript', (userText, opts) => {
                console.log('[TRANSCRIPT RECEIVED]', {
                    text: userText,
                    transcriptLength: typeof userText === 'string' ? userText.length : 0,
                    confidence: opts?.confidence
                });
                const transcriptTurnId = opts?.turnEpoch || turnState.currentTurnId;
                if (turnState.isClosed) return;
                if (!isValidHumanTranscript(userText, opts)) return;
                telemetry.emit('user_turn_completed', {
                    connectionId: edgeSession.connectionId,
                    callId: edgeSession.callSID,
                    transcriptLength: userText.length,
                    confidence: typeof opts?.confidence === 'number' ? opts.confidence : null,
                    turnEpoch: transcriptTurnId,
                    ts: Date.now()
                });
                const gateStats = getGateTurnStats(transcriptTurnId);
                gateStats.transcriptLength = userText.length;
                gateStats.transcriptConfidence = typeof opts?.confidence === 'number' ? opts.confidence : null;
                callContextState.lastHumanActivityTs = Date.now();
                if (PHASE3_ENABLED) {
                    if (opts && typeof opts.confidence === 'number') phase3State.lastStoredConfidence = opts.confidence;
                    phase3State.latencyState.speechEndTs = Date.now();
                    clearPhase3Timers();
                    if (PHASE3_DEBUG) console.warn(`[Phase3][${provider.name}:${edgeSession.connectionId}] MA cancelled (user_transcript)`);
                    if (latencyCompensation && latencyCompensation.getLevel() !== 'NONE' && LATENCY_COMPENSATION.fillerEnabled) {
                        const neutralAudio = loadNeutralAudioSync();
                        if (neutralAudio) {
                            const scheduledTurn = turnState.currentTurnId;
                            phase3State._fillerTimer = scheduleLifecycleTimeout(() => {
                                phase3State._fillerTimer = null;
                                if (!assertTurnActive(turnState, scheduledTurn)) return;
                                if (phase3State.latencyState.firstAudioFrameTs != null) return;
                                streamService.sendAudioDirect(neutralAudio.base64, neutralAudio.durationMs / 1000, false);
                            }, phase3Config.latencyBudget.totalMs);
                        }
                    }
                    if (PREWARM.enabled && callContextState.interactionMode === InteractionMode.INTERACTIVE) {
                        phase3State.prewarmState.active = true;
                        phase3State.prewarmState.turnId = edgeSession.currentTurnId;
                        if (realtimeService.kb) {
                            realtimeService.prewarmKnowledge(userText);
                            phase3State.prewarmState.result = 'attempted';
                        }
                    }
                }

                const confidence = typeof opts?.confidence === 'number' ? opts.confidence : 0;

                if (!edgeSession.lastUserIntent && userText.length > 5) {
                    edgeSession.lastUserIntent = userText;
                }

                const relevanceScore = computeKeywordMatch(userText, edgeSession.lastUserIntent);
                const fastDecisionScore =
                    (relevanceScore * 0.5) +
                    (confidence * 0.3) +
                    (edgeSession.lastEnergyScore * 0.2);

                let decision;
                if (fastDecisionScore > 0.68) decision = 'high';
                else if (fastDecisionScore > 0.55) decision = 'medium';
                else decision = 'low';

                realtimeService.setDecision(decision);

                if (Math.random() < 0.1) {
                    console.log('[Hybrid Debug]', {
                        energy: edgeSession.lastEnergyScore,
                        variance: edgeSession.energyVariance,
                        slope: edgeSession.energySlope,
                        relevanceScore,
                        confidence,
                        fastDecisionScore
                    });
                }

                const transcriptEvent = { transcript: userText, confidence, timestamp: Date.now(),
                    packetLoss: edgeSession.packetLossRatio || 0,
                    isTruncated: confidence < 0.4 && userText.split(/\s+/).length < 3
                };
                callContextState.degradationEngine.updateDegradationState(transcriptEvent);

                if (edgeSession.packetLossRatio > 0.15) {
                    telemetry.emit('packet_loss_detected', {
                        connectionId: edgeSession.connectionId,
                        callId: edgeSession.callSID,
                        packetLossRatio: edgeSession.packetLossRatio,
                        ts: Date.now()
                    });
                }
                const degradationState = callContextState.degradationEngine.getCurrentState();
                const stabilityMetrics = callContextState.degradationEngine.getStabilityMetrics();

                let transcriptTimingMs;
                if (PHASE3_ENABLED &&
                    phase3State.latencyState.responseStartTs != null &&
                    phase3State.latencyState.speechEndTs != null &&
                    phase3State.latencyState.speechEndTs >= phase3State.latencyState.responseStartTs) {
                    transcriptTimingMs =
                        phase3State.latencyState.speechEndTs -
                        phase3State.latencyState.responseStartTs;
                }

                const { finalScore } = computeAmbiguityScore({
                    confidence,
                    transcript: userText,
                    transcriptTimingMs,
                    degradationState,
                    stabilityMetrics,
                    energyMetrics: {
                        score: edgeSession.lastEnergyScore,
                        variance: edgeSession.energyVariance,
                        slope: edgeSession.energySlope
                    }
                });
                const unlockDecision = getUnlockDecision(
                    degradationState, finalScore, confidence,
                    callContextState.clarificationCount, MAX_CLARIFICATIONS
                );

                if (PHASE2_5_2_UNLOCK_DEBUG) {
                    console.log(`[Unlock][${edgeSession.connectionId}] finalScore=${finalScore} state=${degradationState} decision=${unlockDecision}`);
                }

                if (unlockDecision === 'cancel') {
                    callContextState.clarificationCount = 0;
                    transitionMode(callContextState, InteractionMode.INTERACTIVE, 'user_cancel');
                    telemetry.emit('speech_cancelled', {
                        connectionId: edgeSession.connectionId,
                        callId: edgeSession.callSID,
                        reason: 'user_negative',
                        turnEpoch: turnState.currentTurnId,
                        ts: Date.now()
                    });
                    streamService.stopCurrentAudio();
                    realtimeService.cancelResponse();
                    telemetry.emit('turn_closed', {
                        connectionId: edgeSession.connectionId,
                        callId: edgeSession.callSID,
                        turnEpoch: turnState.currentTurnId,
                        outcome: 'cancelled',
                        ts: Date.now()
                    });
                    emitGateTurnSummary('turn_cancelled', turnState.currentTurnId);
                    edgeSession.audioChunks = [];
                    if (edgeSession.audioTimer) clearTimeout(edgeSession.audioTimer);
                    return;
                }
                if (unlockDecision === 'unlock') {
                    callContextState.clarificationCount = 0;
                    telemetry.emit('unlock_granted', {
                        connectionId: edgeSession.connectionId,
                        score: finalScore,
                        turnEpoch: turnState.currentTurnId,
                        ts: Date.now()
                    });
                    transitionMode(callContextState, InteractionMode.INTERACTIVE, 'user_transcript');
                    if (callContextState.nonInteractiveTimer) clearTimeout(callContextState.nonInteractiveTimer);
                    callContextState.nonInteractiveTimer = null;
                    streamService.stopCurrentAudio();
                    realtimeService.cancelResponse();
                    telemetry.emit('speech_cancelled', {
                        connectionId: edgeSession.connectionId,
                        callId: edgeSession.callSID,
                        reason: 'unlock',
                        turnEpoch: turnState.currentTurnId,
                        ts: Date.now()
                    });
                    telemetry.emit('turn_closed', {
                        connectionId: edgeSession.connectionId,
                        callId: edgeSession.callSID,
                        turnEpoch: turnState.currentTurnId,
                        outcome: 'unlock',
                        ts: Date.now()
                    });
                    emitGateTurnSummary('turn_unlock', turnState.currentTurnId);
                    edgeSession.audioChunks = [];
                    if (edgeSession.audioTimer) clearTimeout(edgeSession.audioTimer);
                    return;
                }
                if (unlockDecision === 'clarify') {
                    callContextState.clarificationCount += 1;
                    console.log(`[Unlock][${edgeSession.connectionId}] Clarification trigger score=${finalScore} state=${degradationState} count=${callContextState.clarificationCount}`);
                    const clarificationText =
                        degradationState === 'SEVERE'
                            ? 'The line seems unstable. Please say confirm clearly to proceed.'
                            : 'I may have heard background audio. Please confirm clearly.';
                    const permission = evaluateSpeechPermission({
                        interactionMode: callContextState.interactionMode,
                        contextHint: callContextState.contextHint,
                        turnId: turnState.currentTurnId,
                        currentTurnId: edgeSession.currentTurnId,
                        policyConfig: callContextState.policyConfig,
                        messageAlreadySent: callContextState.guardedMessageAlreadySent
                    });
                    const scheduledTurn = turnState.currentTurnId;
                    if (!assertTurnActive(turnState, scheduledTurn)) return;
                    if (permission.allowSpeak && typeof realtimeService.sendTextResponse === 'function') {
                        if (!assertTurnActive(turnState, scheduledTurn)) return;
                        realtimeService.sendTextResponse(clarificationText);
                        telemetry.emit('clarification_emitted', {
                            connectionId: edgeSession.connectionId,
                            state: degradationState,
                            score: finalScore,
                            clarificationCount: callContextState.clarificationCount,
                            ts: Date.now()
                        });
                    }
                    return;
                }

                const sentimentResult = detectSentiment(userText);

                if (sentimentResult.handoverRequested) {
                    telemetry.emit('handover_triggered', {
                        connectionId: edgeSession.connectionId,
                        callId: edgeSession.callSID,
                        reason: 'caller_requested',
                        turnCount: realtimeService.count,
                        ts: Date.now()
                    });
                    realtimeService.setHandoverTriggered(true);
                    edgeSession.emitSignal('signal_handover', { reason: 'caller_requested' });
                    return;
                }

                if (MAX_BOT_TURNS > 0 && realtimeService.count >= MAX_BOT_TURNS) {
                    telemetry.emit('handover_triggered', {
                        connectionId: edgeSession.connectionId,
                        callId: edgeSession.callSID,
                        reason: 'turn_limit',
                        turnCount: realtimeService.count,
                        ts: Date.now()
                    });
                    realtimeService.setHandoverTriggered(true);
                    edgeSession.emitSignal('signal_handover', { reason: 'turn_limit' });
                    return;
                }

                const escalationResult = evaluateEscalation({
                    clarificationCount: callContextState.clarificationCount,
                    maxClarifications: MAX_CLARIFICATIONS,
                    lowSynthesisTurnCount: realtimeService._lowSynthesisTurnCount || 0,
                    maxLowConfidenceTurns: realtimeService._phase4Profile?.escalation?.maxLowConfidenceTurns ?? 3,
                    transactionFailureCount: 0,    // placeholder — wired when transaction detection is added
                    highRiskDomainDetected: false,  // placeholder — domain detection is a future feature
                });

                let escalationToneOverride = null;
                if (escalationResult.shouldEscalate) {
                    escalationToneOverride = getEscalationToneOverride();
                    telemetry.emit('escalation_triggered', {
                        connectionId: edgeSession.connectionId,
                        callId: edgeSession.callSID,
                        reason: escalationResult.reason,
                        ts: Date.now()
                    });
                    if (sentimentResult.signals.includes('hostility')) {
                        // Sprint 5A.6: 2-turn grace period before hostility-triggered handover
                        realtimeService._hostileTurnCount = (realtimeService._hostileTurnCount || 0) + 1;
                        if (realtimeService._hostileTurnCount >= 2) {
                            realtimeService.setHandoverTriggered(true);
                            edgeSession.emitSignal('signal_handover', { reason: 'escalation_hostility' });
                            return;
                        }
                    }
                }

                // Sprint 5A.6: Reset hostile turn counter on non-hostile turns
                if (!sentimentResult.signals.includes('hostility')) {
                    realtimeService._hostileTurnCount = 0;
                }

                const toneDirective = buildToneDirective(sentimentResult, escalationToneOverride);
                realtimeService.setToneDirective(toneDirective);

                if (sentimentResult.signals.length > 0) {
                    callContextState.lastSentimentPrimary = sentimentResult.primary;
                    telemetry.emit('sentiment_detected', {
                        connectionId: edgeSession.connectionId,
                        callId: edgeSession.callSID,
                        signals: sentimentResult.signals,
                        primary: sentimentResult.primary,
                        hasToneDirective: toneDirective !== null,
                        ts: Date.now()
                    });
                }

                // Sync interaction mode AFTER all transitions (unlock, cancel, etc.)
                // so the adapter sees the final mode when insertUpdatedPrompt runs.
                realtimeService._currentInteractionMode = callContextState.interactionMode;
            });

            // The realtime adapter emits this only after the silence goodbye audio
            // has finished and its post-playback grace has elapsed.
            realtimeService.on('silence_hangup', () => {
                const myTurn = turnState.currentTurnId;
                if (turnState.isClosed) return;
                if (myTurn !== turnState.currentTurnId) return;
                const hangupTurnId = newTurn();
                console.log(`[${provider.name}:${edgeSession.connectionId}] Call ending due to silence`);
                telemetry.emit('hangup_triggered', {
                    connectionId: edgeSession.connectionId,
                    callId: edgeSession.callSID,
                    reason: 'silence_timeout',
                    ts: Date.now()
                });
                telemetry.emit('speech_cancelled', {
                    connectionId: edgeSession.connectionId,
                    callId: edgeSession.callSID,
                    reason: 'silence_hangup',
                    turnEpoch: hangupTurnId,
                    ts: Date.now()
                });
                edgeSession.emitSignal('signal_silence_hangup', hangupTurnId);
            });

            // Track user speaking state unconditionally (needed for silent-mode guard)
            realtimeService.on('user_speech_started', (speechInfo = {}) => {
                const turnId = ensureUserSpeechTurn('user_speech_started');
                turnState.isUserSpeaking = true;
                callContextState.lastHumanActivityTs = Date.now();
                transitionMode(callContextState, InteractionMode.INTERACTIVE, speechInfo.isBargeIn ? 'barge_in_speech_started' : 'user_speech_started');
                if (callContextState.nonInteractiveTimer) clearTimeout(callContextState.nonInteractiveTimer);
                callContextState.nonInteractiveTimer = null;
                if (PHASE3_ENABLED) {
                    clearPhase3Timers();
                    phase3State.prewarmState.active = false;
                    phase3State.prewarmState.turnId = null;
                    phase3State.prewarmState.result = null;
                    if (typeof realtimeService.clearPrewarmKnowledge === 'function') realtimeService.clearPrewarmKnowledge();
                    if (PHASE3_DEBUG && speechInfo.isBargeIn) console.warn(`[Phase3][${provider.name}:${edgeSession.connectionId}] MA cancelled (barge-in speech_started)`);
                }
                realtimeService._currentInteractionMode = callContextState.interactionMode;
                console.log(`[${provider.name}:${edgeSession.connectionId}] User speech started${speechInfo.isBargeIn ? ' (barge-in)' : ''}`);
                telemetry.emit('user_speech_started', {
                    connectionId: edgeSession.connectionId,
                    callId: edgeSession.callSID,
                    turnEpoch: turnId || turnState.currentTurnId,
                    isBargeIn: !!speechInfo.isBargeIn,
                    ts: Date.now()
                });
            });
            realtimeService.on('user_speech_stopped', () => { turnState.isUserSpeaking = false; });

            if (PHASE3_ENABLED && MICRO_ACK.enabled) {
                realtimeService.on('user_speech_started', () => {
                    console.log('[VAD] speech_started');
                    if (!PHASE3_ENABLED) return;
                    callContextState.lastHumanActivityTs = Date.now();
                    const now = Date.now();
                    if (now - phase3State.microAck.lastSpeechStartTs < 200) return;
                    phase3State.microAck.lastSpeechStartTs = now;
                    if (callContextState.interactionMode !== InteractionMode.INTERACTIVE) return;
                    phase3State.microAck.emittedThisTurn = false;
                    if (phase3State.microAck.checkTimer) clearTimeout(phase3State.microAck.checkTimer);
                    if (phase3State.microAck.windowCloseTimer) clearTimeout(phase3State.microAck.windowCloseTimer);
                    phase3State.microAck.windowClosed = false;
                    const scheduledTurn = turnState.currentTurnId;
                    phase3State.microAck.checkTimer = epochGuardedTimeout(turnState, (scheduledTurn) => {
                        if (!assertTurnActive(turnState, scheduledTurn)) return;
                        if (!PHASE3_ENABLED) return;
                        if (phase3State.microAck.windowClosed || phase3State.microAck.emittedThisTurn) return;
                        if (callContextState.interactionMode !== InteractionMode.INTERACTIVE) return;
                        if (!shouldEmitMicroAck(phase3State, callContextState.interactionMode === InteractionMode.INTERACTIVE)) return;
                        if (!mayEmitMicroAckNow(phase3State, callContextState.interactionMode, edgeSession.currentTurnId, scheduledTurn)) return;
                        phase3State.microAck.emittedThisTurn = true;
                        const neutral = loadNeutralAudioSync();
                        if (neutral) {
                            if (!assertTurnActive(turnState, scheduledTurn)) return;
                            if (!assertAudioSafe(turnState, scheduledTurn)) return;
                            streamService.sendAudioDirect(neutral.base64, neutral.durationMs / 1000, false);
                            console.warn(`[Phase3][${provider.name}:${edgeSession.connectionId}] Micro-ack emitted callSID=${edgeSession.callSID}`);
                            telemetry.emit('micro_ack_emitted', {
                                connectionId: edgeSession.connectionId,
                                callId: edgeSession.callSID,
                                turnId: scheduledTurn,
                                turnEpoch: scheduledTurn,
                                ts: Date.now()
                            });
                        }
                    }, MICRO_ACK.continuousSpeechMinMs);
                    const scheduledTurnWindow = turnState.currentTurnId;
                    phase3State.microAck.windowCloseTimer = epochGuardedTimeout(turnState, () => {
                        if (!assertTurnActive(turnState, scheduledTurnWindow)) return;
                        phase3State.microAck.windowClosed = true;
                    }, MICRO_ACK.continuousSpeechMaxMs);
                });

                realtimeService.on('user_speech_stopped', () => {
                    console.log('[VAD] speech_stopped');
                    phase3State.microAck.windowClosed = true;
                    if (PHASE3_DEBUG) console.warn(`[Phase3][${provider.name}:${edgeSession.connectionId}] MA cancelled (speech_stopped)`);
                    clearPhase3Timers();
                    telemetry.emit('user_speech_stopped', {
                        connectionId: edgeSession.connectionId,
                        callId: edgeSession.callSID,
                        turnEpoch: turnState.currentTurnId,
                        ts: Date.now()
                    });
                });
            }

            // Sprint 6F: Cancel echo guard when synthesis cascade cap is reached
            // so user audio can flow to Azure and barge-in can break the loop
            realtimeService.on('synthesis_cascade_ended', () => {
                cancelEchoGuard();
            });

            realtimeService.on('audio', (audioBuffer, responseId) => {
                if (isSessionClosed()) return;
                // Sprint 6F: Skip echo guard during synthesis/hallucination cascade
                // to allow user barge-in to break the retry loop
                if ((realtimeService._synthesisGateRetries || 0) < 2) {
                    startEchoGuard();
                }

                if (Math.random() < 0.1 || !edgeSession._firstOutboundTelemetry) {
                    edgeSession._firstOutboundTelemetry = true;
                    telemetry.emit('audio_buffer_received', {
                        connectionId: edgeSession.connectionId,
                        callId: edgeSession.callSID,
                        size: typeof audioBuffer === 'string' ? audioBuffer.length : audioBuffer.byteLength,
                        turnEpoch: turnState.currentTurnId,
                        ts: Date.now()
                    });
                }

                const scheduledTurn = turnState.currentTurnId;
                if (turnState.isClosed) return;
                if (realtimeService.callSID !== edgeSession.callSID) return;
                if (!assertTurnActive(turnState, scheduledTurn)) return;

                // audioBuffer is a Buffer from _parseAudioDelta; encode to base64
                // once for the stream service instead of round-tripping through
                // base64→Buffer→base64.
                const isBuffer = Buffer.isBuffer(audioBuffer);
                const b64 = isBuffer ? audioBuffer.toString('base64') : audioBuffer;
                const byteLen = isBuffer ? audioBuffer.length : Buffer.byteLength(b64, 'base64');
                const duration = byteLen / 8000;

                if (callContextState.interactionMode === InteractionMode.TRANSITIONAL) {
                    transitionMode(callContextState, InteractionMode.INTERACTIVE, 'audio_start');
                }

                const permission = evaluateSpeechPermission({
                    interactionMode: callContextState.interactionMode,
                    contextHint: callContextState.contextHint,
                    turnId: scheduledTurn,
                    currentTurnId: edgeSession.currentTurnId,
                    policyConfig: callContextState.policyConfig,
                    messageAlreadySent: callContextState.guardedMessageAlreadySent
                });

                if (!permission.allowSpeak) return;
                if (!assertAudioSafe(turnState, scheduledTurn)) return;

                telemetry.emit('speech_started', {
                    connectionId: edgeSession.connectionId,
                    callId: edgeSession.callSID,
                    turnId: scheduledTurn,
                    turnEpoch: scheduledTurn,
                    ts: Date.now()
                });

                const playbackStartTs = Date.now();

                telemetry.emit('speech_playback_started', {
                    connectionId: edgeSession.connectionId,
                    callId: edgeSession.callSID,
                    turnEpoch: scheduledTurn,
                    ts: playbackStartTs
                });

                if (edgeSession.lastPlaybackTurnEpoch !== scheduledTurn) {
                    edgeSession.lastPlaybackStartTs = playbackStartTs;
                    edgeSession.lastPlaybackTurnEpoch = scheduledTurn;
                }

                if (PHASE3_ENABLED && phase3State.latencyState.firstAudioFrameTs == null) {
                    phase3State.latencyState.firstAudioFrameTs = playbackStartTs;
                    const latencyResult = logLatencyOverruns(edgeSession.connectionId, edgeSession.callSID, phase3State.latencyState);
                    if (latencyResult?.overrun) phase3State.latencyOverrunStreak += 1;
                    else phase3State.latencyOverrunStreak = 0;

                    if (!latencyCompensation && phase3State.latencyOverrunStreak >= 3) {
                        console.warn(`[Phase3][${provider.name}:${edgeSession.connectionId}] Persistent latency overruns detected (${phase3State.latencyOverrunStreak} turns) while compensation is disabled. callSID=${edgeSession.callSID}`);
                        telemetry.emit('latency_compensation_disabled_warning', {
                            connectionId: edgeSession.connectionId,
                            callSID: edgeSession.callSID,
                            overrunStreak: phase3State.latencyOverrunStreak,
                            compensationEnabled: LATENCY_COMPENSATION.enabled,
                            ts: Date.now()
                        });
                    }
                    if (latencyCompensation) {
                        const level = latencyCompensation.recordTurn(phase3State.latencyState);
                        telemetry.emit('latency_compensation_level', {
                            connectionId: edgeSession.connectionId,
                            callSID: edgeSession.callSID,
                            level,
                            overrunStreak: phase3State.latencyOverrunStreak,
                            ts: Date.now()
                        });
                        if (level !== 'NONE') {
                            telemetry.emit('latency_compensation_active', {
                                connectionId: edgeSession.connectionId, callSID: edgeSession.callSID,
                                level, totalMs: phase3State.latencyState.firstAudioFrameTs - phase3State.latencyState.speechEndTs,
                                ts: Date.now()
                            });
                        }
                        realtimeService.setLatencyCompensationLevel(level);
                    }
                }

                streamService.sendAudioDirect(b64, duration, false, 'AI', responseId);

                if (Math.random() < 0.2 || !edgeSession._firstOutboundAudioLogged) {
                    edgeSession._firstOutboundAudioLogged = true;
                    console.log(`[${provider.name}:${edgeSession.connectionId}] AUDIO->CALLER`, {
                        bytes: byteLen,
                        durationMs: Math.round(duration * 1000),
                        streamId: streamService.streamId || 'MISSING',
                        wsReady: streamService.ws?.readyState,
                        silentMode: streamService.silentMode
                    });
                }

                if (permission.messageType) callContextState.guardedMessageAlreadySent = true;

                const emittedTs = Date.now();
                telemetry.emit('speech_emitted', {
                    connectionId: edgeSession.connectionId,
                    callId: edgeSession.callSID,
                    durationMs: Math.round(duration * 1000),
                    guarded: !!permission.messageType,
                    playbackPipelineDelayMs: emittedTs - playbackStartTs,
                    turnEpoch: scheduledTurn,
                    ts: emittedTs
                });
                edgeSession.lastSpeechEmittedTs = emittedTs;
            });

            realtimeService.on('screening_detected', (transcript) => {
                console.log(`[${provider.name}:${edgeSession.connectionId}] Call screening detected`, {
                    transcriptLength: typeof transcript === 'string' ? transcript.length : 0
                });
                telemetry.emit('call_screening_detected', {
                    connectionId: edgeSession.connectionId,
                    callId: edgeSession.callSID,
                    transcript: transcript.substring(0, 200),
                    ts: Date.now()
                });
            });

            realtimeService.on('voicemail_detected', (transcript) => {
                console.log(`[${provider.name}:${edgeSession.connectionId}] Voicemail detected`, {
                    transcriptLength: typeof transcript === 'string' ? transcript.length : 0
                });
                telemetry.emit('voicemail_content_detected', {
                    connectionId: edgeSession.connectionId,
                    callId: edgeSession.callSID,
                    transcript: transcript.substring(0, 200),
                    ts: Date.now()
                });
            });

            realtimeService.on('decision', (data) => {
                const myTurn = turnState.currentTurnId;
                if (turnState.isClosed) return;
                if (myTurn !== turnState.currentTurnId) return;
                console.log(`[${provider.name}:${edgeSession.connectionId}] Decision:`, data);
                if (data.shouldHangup) {
                    // Persist suppression for explicit opt-out ("stop calling", "remove me", etc.)
                    if (data.reason === 'rejected' && realtimeService?.recipient) {
                        writeQueue.enqueue({
                            type: 'persist_suppression',
                            phoneNumber: realtimeService.recipient,
                            reason: 'caller_requested',
                            callSID: edgeSession.callSID,
                            personaId: realtimeService?.persona?.id || null
                        });
                        writeQueue.enqueue({
                            type: 'revoke_consent',
                            phoneNumber: realtimeService.recipient,
                            callSID: edgeSession.callSID,
                            personaId: realtimeService?.persona?.id || null
                        });
                    }
                    edgeSession.pauseTranscription = true;
                    edgeSession.emitSignal('signal_should_hangup', edgeSession.lastAudioDuration, myTurn);
                }
            });

            realtimeService.on('audio_done', (data) => {
                const myTurn = turnState.currentTurnId;
                if (turnState.isClosed) return;
                if (myTurn !== turnState.currentTurnId) return;
                // Clear stale currentAudioTask so that a later speech_started
                // does not spuriously activate silentMode via stopCurrentAudio.
                streamService.clearAudioTask();
                // Capture AI audio duration for proportional echo guard
                lastAiAudioDurationMs = realtimeService._totalAudioDurationMs || 0;
                stopEchoGuard();
                recordEchoGuardTurn();
                const completedTs = Date.now();
                const playbackLatencyMs = edgeSession.lastSpeechEmittedTs
                    ? completedTs - edgeSession.lastSpeechEmittedTs : null;
                const playbackDurationMs = edgeSession.lastPlaybackStartTs
                    ? completedTs - edgeSession.lastPlaybackStartTs : null;
                telemetry.emit('speech_completed', {
                    connectionId: edgeSession.connectionId,
                    callId: edgeSession.callSID,
                    turnEpoch: edgeSession.lastPlaybackTurnEpoch || turnState.currentTurnId,
                    playbackLatencyMs,
                    playbackDurationMs,
                    cancelled: edgeSession.pauseTranscription === true,
                    ts: completedTs
                });
                telemetry.emit('turn_closed', {
                    connectionId: edgeSession.connectionId,
                    callId: edgeSession.callSID,
                    turnEpoch: turnState.currentTurnId,
                    outcome: 'completed',
                    ts: Date.now()
                });
                emitGateTurnSummary('turn_completed', turnState.currentTurnId);
            });

            realtimeService.on('disconnected', (info) => {
                if (isSessionClosed()) return;
                if (info && (info.isAbnormal || info.isServerError) && !info.isRegionError) {
                    console.log(`[${provider.name}:${edgeSession.connectionId}] Azure disconnected abnormally, playing hold music`);
                    startReconnectHoldMusic(info);
                }
            });

            realtimeService.on('reconnected', (info) => {
                if (isSessionClosed()) return;
                console.log(`[${provider.name}:${edgeSession.connectionId}] Azure reconnected (attempt ${info.attempt}), stopping hold music`);
                stopReconnectHoldMusic('reconnected');
            });

            realtimeService.on('reconnection_failed', (info) => {
                if (isSessionClosed()) return;
                console.error(`[${provider.name}:${edgeSession.connectionId}] Reconnection failed after ${info.attempts} attempts`);
                stopReconnectHoldMusic('reconnection_failed');
                telemetry.emit('reconnection_failed_hangup', {
                    connectionId: edgeSession.connectionId,
                    callSID: edgeSession.callSID,
                    attempts: info.attempts,
                    ts: Date.now()
                });
                if (_errorAudioBase64 && streamService.ws && streamService.ws.readyState === 1) {
                    streamService.sendAudioDirect(_errorAudioBase64, _errorAudioDurationSec, false);
                    scheduleLifecycleTimeout(() => {
                        turnState.isClosed = true;
                        if (streamService.ws && streamService.ws.readyState === 1) streamService.ws.close();
                    }, Math.ceil(_errorAudioDurationSec * 1000) + 500);
                } else {
                    turnState.isClosed = true;
                    if (streamService.ws && streamService.ws.readyState === 1) streamService.ws.close();
                }
            });
        }

        // ── WebSocket close handler ───────────────────────────────────────────

        ws.on('close', () => {
            cleanupCallSession('websocket_close', 'ws_close');
        });

        // ── WebSocket message handler ─────────────────────────────────────────

        ws.on('message', async function message(data) {
            try {
                const str = typeof data === 'string' ? data : data.toString('utf8');
                if (!str || str[0] !== '{') return;
                const msg = JSON.parse(str);

                if (isSessionClosed()) return;

                if (msg.event === 'start') {
                    // Normalise provider-specific field names to canonical callId / streamId
                    const { callId, streamId, callerNumber } = provider.extractStartFields(msg);
                    if (!callId || !streamId) {
                        console.warn(`[${provider.name}:${edgeSession.connectionId}] Ignoring start event with missing identifiers`, {
                            hasCallId: !!callId,
                            hasStreamId: !!streamId
                        });
                        return;
                    }
                    if (startHandled) {
                        console.warn(`[${provider.name}:${edgeSession.connectionId}] Ignoring duplicate start event`, {
                            existingCallId: edgeSession.callSID,
                            incomingCallId: callId,
                            existingStreamId: edgeSession.streamSessionId,
                            incomingStreamId: streamId
                        });
                        return;
                    }
                    startHandled = true;
                    edgeSession.callSID = callId;
                    edgeSession.streamSessionId = streamId;

                    // Sync context identifiers
                    if (callContextState) {
                        callContextState.callId = edgeSession.callSID;
                        callContextState.connectionId = edgeSession.connectionId;
                    }

                    streamService.setStreamId(edgeSession.streamSessionId);
                    console.log(`[${provider.name}:${edgeSession.connectionId}] Call started: ${edgeSession.callSID}`);

                    let current = CallRegistry.get(edgeSession.callSID);

                    if (!current) {
                        console.warn(`[CallRegistry] Missing call context for ${edgeSession.callSID}`);
                        current = await CallContextStore.hydrateCallRegistry(edgeSession.callSID, {
                            recipient: callerNumber || null,
                            phoneNumber: callerNumber || null,
                            provider: provider.name,
                            status: 'connected'
                        });
                    }

                    if (isSessionClosed()) return;

                    if (!current) {
                        current = CallRegistry.create(edgeSession.callSID, {
                            callId: edgeSession.callSID,
                            recipient: callerNumber || null,
                            phoneNumber: callerNumber || null,
                            provider: provider.name,
                            createdAt: Date.now(),
                            status: 'connected'
                        });
                    }

                    const registryProvider = current?.provider || null;
                    callContextState.provider = registryProvider;
                    if (!registryProvider) {
                        console.warn('[ProviderMissingAtStart]', {
                            callSID: edgeSession.callSID,
                            route: provider.name
                        });
                    }

                    // Backfill recipient if the registry entry was created without one
                    if (!current.recipient && callerNumber) {
                        CallRegistry.update(edgeSession.callSID, { recipient: callerNumber });
                        current = { ...current, recipient: callerNumber };
                    }

                    CallRegistry.update(edgeSession.callSID, {
                        streamID: edgeSession.streamSessionId,
                        connectionId: edgeSession.connectionId,
                        connectedAt: Date.now()
                    });
                    CallContextStore.patchContext(edgeSession.callSID, {
                        provider: current.provider || provider.name,
                        phoneNumber: current.phoneNumber || current.recipient || callerNumber || null,
                        name: current.name || null,
                        persona: current.persona || null,
                        language: current.language || null,
                        aiProvider: current.aiProvider || null,
                        contextHint: current.contextHint ?? null,
                        policyConfig: current.policyConfig ?? null,
                        requireExplicitRecordingConsent: current.requireExplicitRecordingConsent ?? false
                    }).catch(() => {});

                    callContextState.contextHint = current.contextHint ?? null;
                    Object.defineProperty(callContextState, 'contextHint', { writable: false, configurable: true });
                    callContextState.policyConfig = current.policyConfig
                        ? { ...DEFAULT_POLICY_CONFIG, ...current.policyConfig }
                        : DEFAULT_POLICY_CONFIG;
                    validatePolicyConfig(callContextState.policyConfig, callContextState.contextHint);

                    const resolvedAiProvider = resolveCallAIProvider({
                        requestedAIProvider: current.aiProvider,
                        personaId: current.persona,
                        language: current.language,
                        envDefault: process.env.AI_PROVIDER || 'azure-realtime'
                    });
                    if (current.aiProvider !== resolvedAiProvider) {
                        CallRegistry.update(edgeSession.callSID, { aiProvider: resolvedAiProvider });
                        current = { ...current, aiProvider: resolvedAiProvider };
                    }

                    if (realtimeService) realtimeService.close();
                    realtimeService = instantiateRealtimeService(current);
                    attachPreconnectBufferListener();
                    newTurn();
                    registerRealtimeListeners();

                    edgeSession.connectionDenoiser = new RealTimeRNNoise();
                    try {
                        edgeSession.connectionDenoiser.initialize();
                        realtimeService.requireExplicitRecordingConsent =
                            current.requireExplicitRecordingConsent ?? false;
                        realtimeService.initialize(
                            edgeSession.callSID,
                            current.recipient,
                            current.name,
                            current.persona,
                            current.language,
                            turnState,
                            current.contextHint ?? null
                        );
                        realtimeService._phase4Profile = callContextState.phase4Profile || null;

                        // Phase E: Register CX state for API access
                        CXStateRegistry.register(edgeSession.callSID, {
                            edgeSession,
                            callContextState,
                            realtimeService,
                            streamService
                        });
                        streamService.stopCurrentAudio();
                    } catch (err) {
                        console.error(`[${provider.name}:${edgeSession.connectionId}] Init error:`, err);
                    }
                }
                else if (msg.event === 'media') {
                    // Gate on session readiness (Twilio also requires isSessionConfigured)
                    const sessionReady = provider.requiresSessionConfigured
                        ? (realtimeService && realtimeService.isConnected && realtimeService.isSessionConfigured)
                        : (realtimeService && realtimeService.isConnected);

                    if (!sessionReady) {
                        const preConnectPayload = msg?.media?.payload;
                        if (provider.hasPreConnectBuffer) {
                            const { invalidPayload } = decodeMediaPayload(preConnectPayload);
                            if (invalidPayload) {
                                warnInvalidMediaFrame(invalidPayload.reason, invalidPayload);
                                return;
                            }
                            if (preConnectAudioQueue.length < PRECONNECT_AUDIO_QUEUE_CAP) {
                                preConnectAudioQueue.push(preConnectPayload);
                            }
                        }
                        return;
                    }

                    // Flush any pre-connect queue (Twilio; safety-net in case session_configured was missed)
                    if (provider.hasPreConnectBuffer && preConnectAudioQueue.length > 0) {
                        flushPreConnectAudioQueue();
                    }

                    const mediaPayload = msg?.media?.payload;
                    const { invalidPayload, ulawBuffer } = decodeMediaPayload(mediaPayload);
                    if (invalidPayload) {
                        warnInvalidMediaFrame(invalidPayload.reason, invalidPayload);
                        return;
                    }

                    // Phase D: Packet frame tracking
                    edgeSession.packetFrameCount++;
                    const pktElapsed = Date.now() - edgeSession.packetWindowStart;
                    if (pktElapsed >= 2000) {
                        const expectedFrames = edgeSession.expectedFrameRate * (pktElapsed / 1000);
                        edgeSession.packetLossRatio = expectedFrames > 0
                            ? Math.max(0, 1 - (edgeSession.packetFrameCount / expectedFrames))
                            : 0;
                        edgeSession.packetFrameCount = 0;
                        edgeSession.packetWindowStart = Date.now();
                    }

                    // ── Jitter sampling ──────────────────────────────────────
                    const nowTs = Date.now();
                    if (edgeSession.lastAudioFrameTs) {
                        const jitterMs = Math.min(200, nowTs - edgeSession.lastAudioFrameTs);
                        if (Math.random() < 0.2) {
                            telemetry.emit('carrier_jitter_sample', {
                                connectionId: edgeSession.connectionId,
                                callId: edgeSession.callSID,
                                jitterMs,
                                ts: nowTs
                            });
                        }
                    }
                    edgeSession.lastAudioFrameTs = nowTs;

                    // ── RMS energy estimate — decode μ-law to linear PCM first
                    let energy = 0;
                    for (let i = 0; i < ulawBuffer.length; i++) {
                        const pcm = ULAW_DECODE_TABLE[ulawBuffer[i]];
                        energy += pcm * pcm;
                    }
                    energy = Math.sqrt(energy / ulawBuffer.length) / 32768;
                    const rawFrameEnergy = energy;
                    const clampedEnergy = Math.max(0, Math.min(1, energy));
                    edgeSession.lastEnergyScore = 0.7 * edgeSession.lastEnergyScore + 0.3 * clampedEnergy;

                    // ── Energy variance and slope ────────────────────────────
                    const ENERGY_WINDOW = 12;
                    edgeSession.energyHistory.push(edgeSession.lastEnergyScore);
                    if (edgeSession.energyHistory.length > ENERGY_WINDOW) edgeSession.energyHistory.shift();

                    if (edgeSession.energyHistory.length > 2) {
                        const mean = edgeSession.energyHistory.reduce((a, b) => a + b, 0) / edgeSession.energyHistory.length;
                        edgeSession.energyVariance = edgeSession.energyHistory.reduce(
                            (acc, v) => acc + Math.pow(v - mean, 2), 0
                        ) / edgeSession.energyHistory.length;
                    }
                    if (edgeSession.energyHistory.length >= 2) {
                        const last = edgeSession.energyHistory[edgeSession.energyHistory.length - 1];
                        const prev = edgeSession.energyHistory[edgeSession.energyHistory.length - 2];
                        edgeSession.energySlope = last - prev;
                    }

                    // ── Fast speech probability ──────────────────────────────
                    const fastSpeechScore =
                        (edgeSession.lastEnergyScore * 0.5) +
                        (edgeSession.energyVariance * 0.3) +
                        (Math.max(0, edgeSession.energySlope) * 0.2);

                    // ── Adaptive noise floor (asymmetric) ─────────────────
                    // Adapt fast downward (silence → floor drops quickly) but
                    // slow upward (speech → floor stays near silence level).
                    const currentNoiseFloor = edgeSession.noiseFloor || 0.01;
                    const noiseAdaptRate = edgeSession.lastEnergyScore > currentNoiseFloor * 2 ? 0.02 : 0.15;
                    edgeSession.noiseFloor =
                        (1 - noiseAdaptRate) * currentNoiseFloor +
                        noiseAdaptRate * edgeSession.lastEnergyScore;

                    // ── Gate V2 — provider-specific thresholds ───────────────
                    const highNoiseFloorBias = (edgeSession.noiseFloor > 0.05) ? 0.02 : 0;
                    const dynamicThreshold = edgeSession.noiseFloor + gateConfig.dynamicThresholdOffset + highNoiseFloorBias;

                    const now = Date.now();
                    let gateLevel;
                    if (fastSpeechScore > dynamicThreshold + 0.01) gateLevel = 'HIGH';
                    else if (fastSpeechScore > dynamicThreshold - 0.01) gateLevel = 'MEDIUM';
                    else gateLevel = 'LOW';

                    edgeSession.speechMomentumUntil = edgeSession.speechMomentumUntil || 0;
                    if (gateLevel === 'HIGH') edgeSession.speechMomentumUntil = now + 300;

                    if (gateLevel === 'LOW') {
                        edgeSession.silenceFrames = (edgeSession.silenceFrames || 0) + 1;
                    } else {
                        edgeSession.silenceFrames = 0;
                    }

                    const inMomentum = now < edgeSession.speechMomentumUntil;

                    let shouldSendAudio = false;
                    let sendReason = null;
                    if (gateLevel === 'HIGH' || gateLevel === 'MEDIUM') {
                        shouldSendAudio = true;
                        sendReason = 'gate_level';
                    } else {
                        const withinInitialSilenceWindow = edgeSession.silenceFrames < gateConfig.silenceFramesThreshold;
                        shouldSendAudio = inMomentum || withinInitialSilenceWindow;
                        if (shouldSendAudio) sendReason = inMomentum ? 'momentum' : 'low_initial_window';
                    }

                    let energyOverrideApplied = false;
                    let silenceFailsafeApplied = false;

                    // Energy override: Twilio default 0.03, Plivo default null (disabled)
                    if (gateConfig.energyOverrideThreshold != null &&
                        edgeSession.lastEnergyScore > gateConfig.energyOverrideThreshold) {
                        shouldSendAudio = true;
                        sendReason = 'energy_override';
                        energyOverrideApplied = true;
                    }

                    // Silence failsafe: both Twilio (50) and Plivo (150); null disables.
                    // Reset silenceFrames to create a duty-cycle (send/drop/send)
                    // instead of permanently opening the gate after the first trigger.
                    if (gateConfig.maxSilenceFailsafe != null &&
                        edgeSession.silenceFrames > gateConfig.maxSilenceFailsafe) {
                        shouldSendAudio = true;
                        sendReason = 'silence_failsafe';
                        silenceFailsafeApplied = true;
                        edgeSession.silenceFrames = 0;
                    }

                    const scheduledTurn = turnState.currentTurnId;

                    recordGateDecision(scheduledTurn, {
                        gateLevel,
                        shouldSendAudio,
                        energy: edgeSession.lastEnergyScore,
                        noiseFloor: edgeSession.noiseFloor,
                        dynamicThreshold,
                        silenceFrames: edgeSession.silenceFrames
                    });

                    if (shouldEmitGateDebugTrace(edgeSession.callSID)) {
                        console.log('[GateV2 TRACE]', {
                            provider: provider.name,
                            connectionId: edgeSession.connectionId,
                            callSID: edgeSession.callSID,
                            turnEpoch: scheduledTurn,
                            rawFrameEnergy,
                            clampedEnergy,
                            energy: edgeSession.lastEnergyScore,
                            variance: edgeSession.energyVariance,
                            slope: edgeSession.energySlope,
                            fastSpeechScore,
                            noiseFloor: edgeSession.noiseFloor,
                            dynamicThreshold,
                            level: gateLevel,
                            send: shouldSendAudio,
                            sendReason,
                            silenceFrames: edgeSession.silenceFrames,
                            inMomentum,
                            energyOverrideApplied,
                            silenceFailsafeApplied,
                            gateConfig: {
                                dynamicThresholdOffset: gateConfig.dynamicThresholdOffset,
                                silenceFramesThreshold: gateConfig.silenceFramesThreshold,
                                energyOverrideThreshold: gateConfig.energyOverrideThreshold,
                                maxSilenceFailsafe: gateConfig.maxSilenceFailsafe
                            }
                        });
                    }

                    // Pipe energy metrics to realtime service even for dropped frames so
                    // silence suppression can see recent gate/audio activity.
                    realtimeService.setEnergyMetrics({
                        variance: edgeSession.energyVariance,
                        slope: edgeSession.energySlope,
                        energy: edgeSession.lastEnergyScore,
                        gateLevel,
                        gateSendAudio: shouldSendAudio,
                        silenceFrames: edgeSession.silenceFrames
                    });

                    if (Math.random() < 0.1) {
                        console.log('[GateV2]', {
                            provider: provider.name,
                            connectionId: edgeSession.connectionId,
                            callSID: edgeSession.callSID,
                            level: gateLevel,
                            send: shouldSendAudio,
                            energy: edgeSession.lastEnergyScore,
                            variance: edgeSession.energyVariance,
                            slope: edgeSession.energySlope,
                            silenceFrames: edgeSession.silenceFrames,
                            noiseFloor: edgeSession.noiseFloor,
                            dynamicThreshold,
                            inMomentum
                        });
                    }

                    if (!shouldSendAudio) {
                        if (Math.random() < 0.1) {
                            console.log('[GateV2 DROP]', {
                                provider: provider.name,
                                connectionId: edgeSession.connectionId,
                                callSID: edgeSession.callSID,
                                level: gateLevel,
                                silenceFrames: edgeSession.silenceFrames,
                                energy: edgeSession.lastEnergyScore,
                                variance: edgeSession.energyVariance,
                                slope: edgeSession.energySlope,
                                noiseFloor: edgeSession.noiseFloor,
                                dynamicThreshold,
                                inMomentum
                            });
                        }
                        return;
                    }

                    if (edgeSession.connectionDenoiser && !edgeSession.pauseTranscription) {
                        if (provider.audioBufferStrategy === 'fifo-queue') {
                            if (!edgeSession.audioInputQueue) edgeSession.audioInputQueue = [];
                            edgeSession.audioInputQueue.push({ buffer: ulawBuffer, turnId: scheduledTurn });
                        } else {
                            // single-slot: overwrite latest frame
                            edgeSession.latestAudioFrame = { buffer: ulawBuffer, turnId: scheduledTurn };
                        }
                        startDenoiseWorker();
                    } else if (edgeSession.denoiseBypass && !edgeSession.pauseTranscription) {
                        recordGateAzureSend(scheduledTurn);
                        realtimeService.sendAudio(ulawBuffer);
                    } else if (edgeSession.pauseTranscription && echoGuardTimer) {
                        recordGateBlocked(scheduledTurn, 'echo_guard');
                        echoBlockedFrames++;
                    } else {
                        recordGateBlocked(scheduledTurn, 'pause_transcription');
                    }
                }
                else if (msg.event === 'dtmf') {
                    // DTMF digit received via Twilio/Plivo bidirectional stream
                    const digit = msg.dtmf?.digit || msg.digit || null;
                    if (digit) {
                        console.log(`[${provider.name}:${edgeSession.connectionId}] DTMF received: ${digit}`);
                        telemetry.emit('dtmf_received', {
                            connectionId: edgeSession.connectionId,
                            callId: edgeSession.callSID,
                            digit,
                            ts: Date.now()
                        });
                        // Feed DTMF digit as synthetic user text to the AI adapter
                        if (realtimeService && realtimeService.isConnected) {
                            realtimeService.emit('user_transcript', `[DTMF: ${digit}]`, { confidence: 1.0, isDTMF: true });
                        }
                    }
                }
                // Plivo: Confirmation that audio with a checkpoint finished playing
                else if (msg.event === 'playedStream') {
                    const checkpointName = msg.name || null;
                    console.log(`[${provider.name}:${edgeSession.connectionId}] playedStream: ${checkpointName}`);
                    streamService.clearAudioTask();
                    // Plivo emits a checkpoint per audio chunk. Do not clear the
                    // adapter playback estimate here; later queued chunks may still
                    // be audible to the caller, and silence timers rely on that tail.
                    telemetry.emit('playback_confirmed', {
                        connectionId: edgeSession.connectionId,
                        callId: edgeSession.callSID,
                        checkpoint: checkpointName,
                        ts: Date.now()
                    });
                }
                // Plivo: Confirmation that the audio queue was cleared (after clearAudio)
                else if (msg.event === 'clearedAudio') {
                    console.log(`[${provider.name}:${edgeSession.connectionId}] clearedAudio confirmed`);
                    telemetry.emit('audio_cleared_confirmed', {
                        connectionId: edgeSession.connectionId,
                        callId: edgeSession.callSID,
                        ts: Date.now()
                    });
                }
            } catch (error) {
                console.error(`[${provider.name}:${edgeSession.connectionId}] Error parsing message:`, error);
            }
        });
    };
}

module.exports = { createCallSession, registerSilenceHangupSignalHandler, registerHandoverSignalHandler };
