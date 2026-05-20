'use strict';

/**
 * BaseRealtimeAdapter — shared business logic for all AI realtime adapters.
 *
 * Contains: conversation state, KB retrieval, hallucination guard, hangup
 * analysis, phase management, entity extraction, greeting lifecycle,
 * silence timers, barge-in recovery, media bleedthrough detection, noise
 * filtering, context summarization, reconnection, ping/pong.
 *
 * Subclasses (AzureRealtimeAdapter, OpenAIRealtimeAdapter) override only
 * the provider-specific protocol methods marked with @abstract.
 */

const WebSocket = require('ws');
const EventEmitter = require('events');
const crypto = require('crypto');
const { analyzeConversationForHangup } = require('../llm/hangupDecision');
const { quickHangupDecision, shouldPerformAnalysis } = require('../../Helper/quickDecisionFilter');
const { getPersonaLanguage } = require('../../personas/registry');
const { insertConversation } = require('../../Helper/Helpers');
const { isCallScreening, isVoicemailContent, isHumanGreeting, isGarbledTranscript } = require('../../Helper/callClassifier');
const { scanForHallucination, getHallucinationFallback, classifyFallbackQuestion } = require('../../Helper/hallucinationGuard');
const { enforceNumerics, extractNumerics } = require('../../rag/numericEnforcement');
const { computeSynthesisScore, passesSynthesisGate } = require('../../rag/synthesisScoring');
const { applyPersonaPass } = require('../../persona/styleEngine');
const { detectComplexity } = require('../../Helper/complexityDetector');
const { parseDealerContextHint } = require('../../Helper/dealerOrderParser');
const { PHASE4_ENABLED } = require('../../config/phase4Config');
const { handleDealerOrderTurn } = require('../../services/dealerOrderConversationWorkflow');
const telemetry = require('../../Utils/telemetry');
const { sanitizeValue } = require('../../Utils/structuredLogger');
const ConversationEngine = require('../../session/conversationEngine');

// ─── Structured logger ────────────────────────────────────────────────────────
const DEBUG = (process.env.LOG_LEVEL || '').toLowerCase() === 'debug';

function log(level, callSID, event, data = {}) {
    if (level === 'debug' && !DEBUG) return;
    const safeData = sanitizeValue({ callSID: callSID || 'none', event, ...data }, '', { callId: callSID || null });
    console.log(JSON.stringify({ ts: Date.now(), level, ...safeData }));
}

function summarizeTextForLog(value) {
    const text = String(value || '');
    const trimmed = text.trim();
    return {
        hash: crypto.createHash('sha256').update(text).digest('hex').slice(0, 12),
        length: text.length,
        wordCount: trimmed ? trimmed.split(/\s+/).length : 0
    };
}

const BOOKING_HANGUP_PHASES = new Set(['offer', 'slot-collection', 'email-collection', 'email-verify', 'confirmation']);
const TERMINAL_HANGUP_REASONS = new Set(['rejected', 'voicemail', 'voicemail_greeting', 'success']);

class BaseRealtimeAdapter extends EventEmitter {

    /**
     * @param {object} config
     * @param {boolean} config.enableSilenceTimers — true for Twilio
     * @param {boolean} config.enableAudioPlaybackTracking — true for Twilio
     * @param {boolean} config.enableTextInputPath — handle conversation.item.created text (Twilio)
     * @param {boolean} config.enableReconnectContext — use getReconnectInstructions (Twilio)
     * @param {boolean} config.includeTempInSessionConfig — include temperature (Plivo)
     * @param {boolean} config.emitAudioAsBuffer — true: emit Buffer, false: emit base64 string
     */
    constructor(config = {}) {
        super();

        // ─── Config flags (set by telecom provider context) ──────────────
        this._enableSilenceTimers = config.enableSilenceTimers || false;
        this._enableAudioPlaybackTracking = config.enableAudioPlaybackTracking || false;
        this._enableTextInputPath = config.enableTextInputPath || false;
        this._enableReconnectContext = config.enableReconnectContext || false;
        this._includeTempInSessionConfig = config.includeTempInSessionConfig || false;
        this._emitAudioAsBuffer = config.emitAudioAsBuffer || false;

        // ─── WebSocket ────────────────────────────────────────────────────
        this.ws          = null;
        this.isConnected = false;
        this.sessionId   = null;
        this.conversationId    = null;
        this.totalInputTokens  = 0;
        this.totalOutputTokens = 0;
        this.maxTotalTokenBudget = Math.min(Number(process.env.MAX_TOTAL_TOKEN_BUDGET) || 25000, 50000);
        this._tokenBudgetExceeded = false;
        this.callSID     = null;

        // Sprint 4.5 Step 1.5: Wire model identity from routeModel()
        this._modelId  = config.model || null;
        this._abCohort = config._abCohort || 'control';

        this.recipient = null;
        this.name      = null;
        this.botLang   = null;
        this.callContextHint = null;
        this.requireExplicitRecordingConsent = false;

        // ─── Persona / language ───────────────────────────────────────────
        this.persona = null;
        this.lang    = null;
        this.kb      = null;
        this.kbEn    = null; // English KB merge (Plivo German)

        // ─── Conversation state ───────────────────────────────────────────
        this.hasAskedForConsultation      = false;
        this.offerAccepted                = false;
        this.emailRefused                 = false;
        this.emailPendingConfirmation     = false;
        this.emailConfirmed               = false;
        this.userEmailProvenance          = null;
        this._bookingIntentDetected       = false;
        this._bookingActionThisTurn       = false;
        this._bookingActionReasonThisTurn = null;
        this.bookingLinkRequested         = false;
        this.bookingLinkSent              = false;
        this.bookingLinkStatus            = null;
        this.bookingProvider              = null;
        this.bookingLinkUrl               = null;
        this.bookingDeliveryPreference    = null;
        this.bookingPhoneDeliveryConsent  = false;
        this.bookingPhoneDeliveryConsentTs = 0;
        this.bookingPhoneDeliveryTargetSource = null;
        this._pendingPhoneDeliveryConsentContext = null;
        this.bookingDeliveryChannels      = [];
        this._bookingLinkSendInFlight     = false;
        this.dealerOrder                  = null;
        this._dealerOrderCloseTimer       = null;
        this._dealerOrderSubmitInFlight   = false;
        this._isSilenceNudgeResponse      = false;
        this._responseWasCancelled         = false;
        this._expectedNudgePhrase          = null;
        this._pendingResponsePurpose       = null;
        this._currentResponsePurpose       = null;
        this._pendingExpectedPhrase        = null;
        this._silenceNudgeCancelledNoRepair = false;
        this._silenceNudgeComplianceCancelledForResponse = null;
        this._lastSilencePhrase            = null;
        this._lastSilencePhraseTs          = 0;
        this._lastHangupDecision           = null;
        this._lastHangupDecisionTs         = 0;
        this._pendingSilenceHangupTimer    = null;
        this.isOnHold                     = false;
        this._holdTimer                   = null;
        this.preferredSlot                = null;
        this.userPhone                    = null;
        this.conversationPhase            = 'opening';
        this._consultationOfferedThisTurn = false;
        this._wordLimitOverride           = null;
        this._phaseAtResponseStart        = 'opening';
        this._callClosed                  = false;
        this._sessionInitTimer            = null;

        // ─── VAD ──────────────────────────────────────────────────────────
        this.vadMode             = this.constructor.resolveVADMode(process.env.AZURE_SERVER_VAD);
        this.silenceCommitTimer  = null;
        this.SILENCE_COMMIT_MS   = parseInt(process.env.AZURE_VAD_SILENCE_MS || '400', 10);
        this.pendingAudioSinceCommit = false;

        // Unified audio config — persona overrides fall through to env defaults.
        this._audioConfig = {
            silenceCommitMs: this.SILENCE_COMMIT_MS,
            vadMode: this.vadMode,
            vadThreshold: null,
            vadSilenceDuration: null,
            vadPrefixPadding: null
        };

        // ─── Context ──────────────────────────────────────────────────────
        this.conversationContext = [];
        this.userEmail = null;
        this.count     = 0;
        this._currentToneDirective = null;
        this._handoverTriggered    = false;
        this._bargeInOccurred      = false;
        this._clarificationCount   = 0;
        this._currentComplexity    = 'simple';
        this._isTransactionTurn    = false;
        this._currentInteractionMode = 'INTERACTIVE';

        // ─── Response state ───────────────────────────────────────────────
        this.isResponding        = false;
        this.isSessionConfigured = false;
        this._firstDeltaLogged   = false;
        this._speechStoppedAt    = null;
        this._lastAutoResponseTs = null;

        // ─── Audio playback tracking (Twilio only) ────────────────────────
        this._firstAudioTs          = null;
        this._totalAudioDurationMs  = 0;
        this._audioPlaybackEndEstimate = 0;

        // ─── Greeting ─────────────────────────────────────────────────────
        this._greetingDelivered     = false;
        this._greetingPending       = false;
        this._greetingFallbackTimer = null;
        this._greetingRetried       = false;

        // ─── Silence timers ───────────────────────────────────────────────
        this.firstSilenceTimer  = null;
        this.secondSilenceTimer = null;
        this.FIRST_SILENCE_TIMEOUT  = Number(process.env.FIRST_SILENCE_TIMEOUT_MS) || 12000;
        this.SECOND_SILENCE_TIMEOUT = Number(process.env.SECOND_SILENCE_TIMEOUT_MS) || 15000;
        this.SILENCE_RECENT_SPEECH_START_GRACE_MS = Number(process.env.SILENCE_RECENT_SPEECH_START_GRACE_MS) || 1200;
        this.SILENCE_RECENT_GATE_FRAMES = Number(process.env.SILENCE_RECENT_GATE_FRAMES) || 8;
        this.SILENCE_RECENT_GATE_ACTIVITY_MIN_ENERGY = Number(process.env.SILENCE_RECENT_GATE_ACTIVITY_MIN_ENERGY) || 0.003;
        this.SILENCE_RECENT_INPUT_ENERGY = Number(process.env.SILENCE_RECENT_INPUT_ENERGY) || 0.015;
        this.SILENCE_RECENT_GATE_ACTIVITY_MS = Number(process.env.SILENCE_RECENT_GATE_ACTIVITY_MS) || 1200;
        this.SPEECH_WINDOW_TRANSCRIPT_TIMEOUT_MS = Number(process.env.SPEECH_WINDOW_TRANSCRIPT_TIMEOUT_MS) || 2000;

        // ─── Reconnection ─────────────────────────────────────────────────
        this.reconnectAttempts    = 0;
        this.maxReconnectAttempts = 3;
        this.baseReconnectDelay   = 1000;
        this.isReconnecting       = false;
        this._personaId           = null;
        this._langCode            = null;

        // ─── Ping/pong ────────────────────────────────────────────────────
        this.pingInterval     = null;
        this.PING_INTERVAL_MS = Number(process.env.WS_PING_INTERVAL_MS) || 30000;
        this.PING_TIMEOUT_MS  = Number(process.env.WS_PING_TIMEOUT_MS) || 10000;
        this.pongTimeout      = null;

        // ─── Audio send state ─────────────────────────────────────────────
        this.audioFrameCount         = 0;
        this.framesPerCommit         = 5;
        this.audioAppendedSinceCommit = false;
        this.lastCommitTime          = 0;
        this.accumulatedAudioBytes   = 0;
        this.audioChunkCounter       = 0;

        // ─── Dynamic state ────────────────────────────────────────────────
        this.isUserSpeaking      = false;
        this.aiTranscript        = '';
        this.lastUserTranscript  = null;
        this._lastUserTranscriptAt = 0;
        this._lastSpeechStartedAt  = 0;
        this._inputActivityEpoch = 0;
        this._acceptedTranscriptTurnEpoch = 0;
        this._lastInputActivityEpochReason = null;
        this._lastInputActivityEpochAt = 0;
        this._lastAcceptedTranscriptEpochReason = null;
        this._lastAcceptedTranscriptEpochAt = 0;
        this._lastNormalizedTranscript = null;
        this._speechWindowSeq = 0;
        this._speechWindows = [];
        this._activeSpeechWindow = null;
        this._speechWindowTimers = new Map();
        this.turnStateRef        = null;

        // ─── Barge-in recovery ────────────────────────────────────────────
        this._bargeInRecoveryTimer = null;
        this._bargeInRecoveryStartedAt = 0;
        this._deferredFlushWatchdog = null;
        this.BARGE_IN_RECOVERY_MS  = Number(process.env.BARGE_IN_RECOVERY_MS) || 4000;
        this.BARGE_IN_RECOVERY_RECHECK_MS = Number(process.env.BARGE_IN_RECOVERY_RECHECK_MS) || 500;
        this.BARGE_IN_RECOVERY_MAX_WAIT_MS = Number(process.env.BARGE_IN_RECOVERY_MAX_WAIT_MS) || Math.max(12000, this.BARGE_IN_RECOVERY_MS * 4);
        this.SILENCE_RECENT_TRANSCRIPT_GRACE_MS = Number(process.env.SILENCE_RECENT_TRANSCRIPT_GRACE_MS) || 5000;
        this._deferredInstruction  = null;
        this._currentResponseId    = null;
        this._currentResponseItemId = null;  // item_id for conversation.item.truncate
        this._truncateAudioEndMs    = 0;     // cumulative audio ms sent to caller
        this._pendingLanguageCorrection = null;

        // ─── KB prewarm ───────────────────────────────────────────────────
        this._prewarmKbResult = null;
        this._prewarmKbQuery  = null;

        // ─── Context summarization ────────────────────────────────────────
        this._contextSummary         = '';
        this._summarizationInFlight  = false;

        // ─── Latency compensation ─────────────────────────────────────────
        this._latencyCompensationLevel = 'NONE';

        // ─── Phase 4 profile ──────────────────────────────────────────────
        this._phase4Profile = null;
        this._lastKbScoredSections = null;
        this._lastSanitizedDocs = null;
        this._lowSynthesisTurnCount = 0;
        this._lastSttConfidence = null;
        this._lastInputEnergy = null;
        this._lastGateLevel = null;
        this._lastGateSendAudio = null;
        this._lastGateSilenceFrames = null;
        this._lastGateMetricsAt = 0;
        this._synthesisGateRetries = 0;
        this._aiTranscriptDoneCountThisTurn = 0; // Log64 P4: hard backstop for total responses per turn
        this._lastResponseDoneTime = 0; // Log65 P6: track last response completion for barge-in recovery guard

        // ─── Response timeout ─────────────────────────────────────────────
        this._responseTimeoutTimer = null;
        this._responseTimeoutGuard = null;
        this._responseTimeoutActive = false;
        this.RESPONSE_TIMEOUT_MS   = Number(process.env.RESPONSE_TIMEOUT_MS) || 10000;
        this._rateLimitBackoffUntil = 0;
        this._lastResponseCreateOpts = null; // Preserve last response.create opts for retry

        // ─── Deferred responses ───────────────────────────────────────────
        this._deferredTextResponse      = null;
        this._deferredUserInputQueue    = [];   // capped queue (max 3) — prevents silent overwrites
        this._maxDeferredUserInputQueue = 3;
        this._lastRelevantKnowledge = '';
        this._deferredInstructionScripted = false;

        // ─── Call screening / voicemail ────────────────────────────────────
        this.isBeingScreened    = false;
        this._screeningTimeout  = null;
        this._screeningGraceMs  = Number(process.env.SCREENING_GRACE_MS) || 10000;

        // ─── Noise / garble tracking ──────────────────────────────────────
        this.consecutiveNoisyTurns = 0;
        this._totalNoisyTurns = 0;
        this.MAX_TOTAL_NOISY_TURNS = Number(process.env.MAX_TOTAL_NOISY_TURNS) || 5;

        // ─── Response deduplication ───────────────────────────────────────
        this._recentAiResponses    = [];   // rolling window of last 10 AI transcripts
        this._consecutiveDupSuppressions = 0; // consecutive duplicate suppressions
        this._consecutiveGreetings = 0;    // tracks repeated "Hello" user inputs
        this._consecutiveDriftCount = 0;   // language drift tracker
        this._earlyDupCancelled    = false; // Fix 11: track early dup cancels to skip drain
        this._retryResponseCreateOnDone = false; // Fix 10: retry rejected response.create
        this._retryResponseCreateOnDoneOwner = null;
        this._lastResponseCreateOwner = null;
        this._currentResponseOwner = null;
        this._responseTimeoutOwner = null;
        this._deferredTextResponseOwner = null;
        this._deferredInstructionOwner = null;
        this._skipDupCheckForNextResponseOwner = null;

        // ─── Media bleedthrough ───────────────────────────────────────────
        this._contextWords     = new Set();
        this._contextWordList  = [];
        this.CONTEXT_WORD_LIMIT       = 150;
        this._lastBargeInTime         = null;
        this.MEDIA_BARGE_IN_WINDOW_MS = 20000;
        this.MEDIA_MIN_WORDS          = 8;
        this._energyVariance = 0;
        this._energySlope    = 0;

        // ─── Decision (set by orchestrator) ───────────────────────────────
        this._decision = null;

        // ─── Provider-agnostic conversation orchestration ───────────────
        this.conversationEngine = new ConversationEngine(this);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ABSTRACT METHODS — must be overridden by subclasses
    // ═══════════════════════════════════════════════════════════════════════

    /** @abstract Create and return a WebSocket connection to the AI provider. */
    _createWebSocket() { throw new Error('_createWebSocket must be overridden'); }

    /** @abstract Build the initial session.update payload. */
    _buildInitialSessionConfig(instructions) { throw new Error('_buildInitialSessionConfig must be overridden'); }

    /** @abstract Build a FULL session.update payload (for subsequent updates). */
    _buildFullSessionConfig(instructions) { throw new Error('_buildFullSessionConfig must be overridden'); }

    /** @abstract Build a response.create payload. */
    _buildResponseCreate(opts) { throw new Error('_buildResponseCreate must be overridden'); }

    /** @abstract Get the voice name/ID for this provider. */
    _getProviderVoice() { throw new Error('_getProviderVoice must be overridden'); }

    /** @abstract Format a μ-law audio buffer for the provider's expected format. */
    _formatAudioForProvider(mulawBuffer) { throw new Error('_formatAudioForProvider must be overridden'); }

    /**
     * @abstract Parse an audio delta message from the provider.
     * Must return the audio data ready for telecom emission.
     * Azure: returns base64 string (μ-law). OpenAI: transcodes PCM16→μ-law.
     */
    _parseAudioDelta(message) { throw new Error('_parseAudioDelta must be overridden'); }

    /** @abstract Get the provider name for logging. */
    get providerName() { throw new Error('providerName must be overridden'); }

    // ═══════════════════════════════════════════════════════════════════════
    // LIFECYCLE
    // ═══════════════════════════════════════════════════════════════════════

    async initialize(callSID, recipient, name, personaId, langCode, turnStateRef, contextHint = null) {
        try {
            this.callSID     = callSID;
            this.recipient   = recipient;
            this.name        = name;
            this.turnStateRef = turnStateRef || null;
            this.conversationId = callSID;
            this.callContextHint = contextHint ?? null;

            // Resolve persona + language
            const resolvedPersona = personaId || process.env.DEFAULT_PERSONA || 'company-sales';
            const resolvedLang    = langCode   || process.env.DEFAULT_LANGUAGE || 'en';

            try {
                const { persona, lang } = getPersonaLanguage(resolvedPersona, resolvedLang);
                this.persona = persona;
                this.lang    = lang;

                // Phase C2: Apply persona audio presets
                if (this.persona?.audioPresets) {
                    const ap = this.persona.audioPresets;
                    if (ap.silenceCommitMs != null) {
                        this.SILENCE_COMMIT_MS = ap.silenceCommitMs;
                        this._audioConfig.silenceCommitMs = ap.silenceCommitMs;
                    }
                    if (ap.vadMode != null) {
                        this.vadMode = this.constructor.resolveVADMode(ap.vadMode);
                        this._audioConfig.vadMode = this.vadMode;
                    }
                    if (ap.vadThreshold != null) this._audioConfig.vadThreshold = ap.vadThreshold;
                    if (ap.vadSilenceDuration != null) this._audioConfig.vadSilenceDuration = ap.vadSilenceDuration;
                    if (ap.vadPrefixPadding != null) this._audioConfig.vadPrefixPadding = ap.vadPrefixPadding;
                    if (ap.vadEagerness != null) this._audioConfig.vadEagerness = ap.vadEagerness;
                }
            } catch (registryErr) {
                log('error', callSID, 'persona_not_found', {
                    personaId: resolvedPersona, langCode: resolvedLang,
                    message: registryErr.message, fallback: 'company-sales/en'
                });
                const { persona, lang } = getPersonaLanguage('company-sales', 'en');
                this.persona = persona;
                this.lang    = lang;

                // Phase C2: Apply persona audio presets (fallback path)
                if (this.persona?.audioPresets) {
                    const ap = this.persona.audioPresets;
                    if (ap.silenceCommitMs != null) {
                        this.SILENCE_COMMIT_MS = ap.silenceCommitMs;
                        this._audioConfig.silenceCommitMs = ap.silenceCommitMs;
                    }
                    if (ap.vadMode != null) {
                        this.vadMode = this.constructor.resolveVADMode(ap.vadMode);
                        this._audioConfig.vadMode = this.vadMode;
                    }
                    if (ap.vadThreshold != null) this._audioConfig.vadThreshold = ap.vadThreshold;
                    if (ap.vadSilenceDuration != null) this._audioConfig.vadSilenceDuration = ap.vadSilenceDuration;
                    if (ap.vadPrefixPadding != null) this._audioConfig.vadPrefixPadding = ap.vadPrefixPadding;
                    if (ap.vadEagerness != null) this._audioConfig.vadEagerness = ap.vadEagerness;
                }
            }

            // Sprint 4.5 Steps 1.1 + 2.3: Stable VAD A/B cohort assignment (once per session)
            // Semantic A/B checked first (mutually exclusive with silence A/B).
            const semanticAbPercent = Number(process.env.VAD_SEMANTIC_AB_PERCENT) || 0;
            const silenceAbMs      = Number(process.env.VAD_SILENCE_AB_MS) || 0;
            const silenceAbPercent  = Number(process.env.VAD_SILENCE_AB_PERCENT) || 0;

            if (semanticAbPercent > 0 && this.providerName?.includes('azure') && Math.random() * 100 < semanticAbPercent) {
                const eagerness = process.env.AZURE_VAD_EAGERNESS || 'medium';
                this._vadAbAssignment = { inCohort: true, cohort: 'experiment', mode: 'azure_semantic_vad', eagerness };
                this.vadMode = 'azure_semantic_vad';
                this._audioConfig.vadMode = 'azure_semantic_vad';
                this.emitTelemetry?.('vad_ab_assignment', { cohort: 'experiment', mode: 'azure_semantic_vad', eagerness, callSID: this.callSID });
            } else if (silenceAbMs > 0 && silenceAbPercent > 0 && Math.random() * 100 < silenceAbPercent) {
                this._vadAbAssignment = { inCohort: true, cohort: 'experiment', mode: 'server_vad', silenceMs: silenceAbMs };
                this.emitTelemetry?.('vad_ab_assignment', { cohort: 'experiment', mode: 'server_vad', silenceMs: silenceAbMs, callSID: this.callSID });
            } else {
                this._vadAbAssignment = { inCohort: false, cohort: 'control', mode: this.vadMode };
            }

            this.botLang    = `${this.persona.id}/${resolvedLang}`;
            this._personaId = this.persona.id;
            this._langCode  = resolvedLang;
            this.dealerOrder = this.persona.id === 'dealer-orders'
                ? {
                    items: [],
                    awaitingConfirmation: false,
                    confirmed: false,
                    skipped: false,
                    orderId: null,
                    status: 'open',
                    erpStatus: null,
                    notificationStatus: null,
                    crmContext: parseDealerContextHint(this.callContextHint),
                }
                : null;

            // Load primary KB
            if (this.lang.knowledgeBase) {
                const KBClass = require(`../../Knowledge-base/${this.lang.knowledgeBase}`);
                this.kb = new KBClass();
            } else {
                this.kb = null;
            }

            // Load English KB merge (Plivo German path)
            if (this.lang.mergeEnglishKBForPlivo) {
                const EnKBClass = require('../../Knowledge-base/Knowledge-base-english');
                this.kbEn = new EnKBClass();
            } else {
                this.kbEn = null;
            }

            log('info', callSID, 'connecting', {
                provider: this.providerName,
                persona: this.persona.id, lang: resolvedLang,
                voice: this._getProviderVoice(), stt: this.lang.sttLocale,
                model: this._modelId || process.env.AZURE_OPENAI_REALTIME_DEPLOYMENT || process.env.OPENAI_REALTIME_MODEL || null,
                hasKB: !!this.kb, mergeEnKB: !!this.kbEn, vadMode: this.vadMode
            });

            this.ws = this._createWebSocket();

            this.ws.on('open',    ()             => this.handleOpen());
            this.ws.on('message', (data)         => this.handleMessage(data));
            this.ws.on('close',   (code, reason) => this.handleClose(code, reason));
            this.ws.on('error',   (err)          => this.handleError(err));
            this.ws.on('pong',    ()             => this.handlePong());

        } catch (err) {
            log('error', callSID, 'init_error', { message: err.message });
            throw err;
        }
    }

    handleOpen() {
        const isReconnect = this.count > 0;

        log('info', this.callSID, isReconnect ? 'reconnected_open' : 'connected', {
            isReconnect, turnCount: this.count
        });
        this.isConnected       = true;
        this.reconnectAttempts = 0;
        this.isReconnecting    = false;

        let instructions;
        if (isReconnect) {
            instructions = this._enableReconnectContext
                ? this.getReconnectInstructions()
                : this.getOperationalInstructions();
        } else {
            instructions = this.getInitialGreetingInstructions();
        }

        log('info', this.callSID, 'session_configuring', {
            voice: this._getProviderVoice(), vadMode: this.vadMode,
            sttLocale: this.lang.sttLocale, isReconnect,
            model: this._modelId || process.env.AZURE_OPENAI_REALTIME_DEPLOYMENT || process.env.OPENAI_REALTIME_MODEL || null
        });

        this.send({
            type: 'session.update',
            session: this._buildInitialSessionConfig(instructions)
        });

        // Log78 Fix 4: Session init timeout — if session.updated never arrives,
        // reconnect rather than leaving the caller in dead silence.
        if (this._sessionInitTimer) clearTimeout(this._sessionInitTimer);
        this._sessionInitTimer = setTimeout(() => {
            this._sessionInitTimer = null;
            if (!this.isSessionConfigured && this.isConnected && !this._callClosed) {
                log('error', this.callSID, 'session_init_timeout', {
                    timeoutMs: 5000, isReconnect
                });
                telemetry.emit('session_init_timeout', {
                    callSID: this.callSID, provider: this.providerName, timestamp: Date.now()
                });
                // Force-close the stale WS and attempt reconnection
                if (this.ws) { try { this.ws.close(1001, 'Session init timeout'); } catch {} }
            }
        }, Number(process.env.SESSION_INIT_TIMEOUT_MS) || 5000);

        if (isReconnect) {
            this._greetingDelivered = true;
            this._greetingPending   = false;
            log('info', this.callSID, 'greeting_skipped_reconnect', {
                turnCount: this.count, phase: this.conversationPhase
            });
        } else {
            this._greetingPending = true;
            this._greetingFallbackTimer = setTimeout(() => {
                if (this._greetingPending && this.isConnected) {
                    log('warn', this.callSID, 'greeting_fallback_timeout', { delayMs: 500 });
                    this._fireGreeting();
                }
            }, Number(process.env.GREETING_FALLBACK_TIMEOUT_MS) || 500);
        }

        if (this._enableSilenceTimers) {
            this.startFirstSilenceTimer();
        }
        this.startPing();
    }

    // ═══════════════════════════════════════════════════════════════════════
    // INSTRUCTION BUILDERS
    // ═══════════════════════════════════════════════════════════════════════

    getInitialGreetingInstructions() {
        const greetingLine = this.lang.greeting(this.name, {
            requireExplicitRecordingConsent: this.requireExplicitRecordingConsent,
            contextHint: this.callContextHint,
            dealerContext: this.dealerOrder?.crmContext || parseDealerContextHint(this.callContextHint),
        });
        const maxWords = this.persona.rules?.targetWords?.detailedMax ?? 40;
        return `Role: ${this.persona.company} ${this.persona.role || 'representative'}.
Assistant name: ${this.persona.name}.

Your ONLY opening message MUST be delivered word-for-word:
"${greetingLine}"
Do NOT paraphrase, expand, add commentary, or say anything else before or after this greeting. After delivering it, wait silently for the caller's response. Do NOT speak again until the caller responds.

Keep subsequent answers under ${maxWords} words.`;
    }

    _fireGreeting() {
        if (!this._greetingPending) return;
        this._greetingPending = false;
        if (this._greetingFallbackTimer) {
            clearTimeout(this._greetingFallbackTimer);
            this._greetingFallbackTimer = null;
        }
        log('info', this.callSID, 'greeting_fired', {
            trigger: this.isSessionConfigured ? 'session_updated' : 'fallback', ts: Date.now()
        });
        this.send(this._buildResponseCreate({}));
    }

    getOperationalInstructions() {
        return this.lang.baseInstruction();
    }

    getReconnectInstructions() {
        const base = this.lang.baseInstruction();
        const recentTurns = this.conversationContext && this.conversationContext.length > 0
            ? this.conversationContext
                .slice(-6)
                .map(e => `${e.sender}: ${e.message}`)
                .join('\n')
            : null;
        if (!recentTurns) return base;
        const name = this.name || 'the caller';
        return `${base}

RECONNECT — CRITICAL:
You are mid-call with ${name}. Do NOT re-introduce yourself. Do NOT say "Hello" or greet them again.
Continue the conversation naturally from where it left off.

RECENT CONVERSATION:
${recentTurns}

Pick up from the most recent turn. If the next step is unclear, ask a brief natural follow-up based on the above context.`;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // VAD CONFIG
    // ═══════════════════════════════════════════════════════════════════════

    static resolveVADMode(envVal) {
        const v = (envVal || 'server_vad').toLowerCase();
        if (v === 'false' || v === 'none') return 'none';
        if (v === 'azure_semantic_vad')              return 'azure_semantic_vad';
        if (v === 'azure_semantic_vad_multilingual')  return 'azure_semantic_vad_multilingual';
        return 'server_vad';
    }

    getVADConfig() {
        if (this.vadMode === 'none') return { type: 'none' };
        const lang = (this._langCode || 'en').toUpperCase();
        const prefixPadding   = this._audioConfig?.vadPrefixPadding
            ?? (Number(process.env[`VAD_PREFIX_PADDING_${lang}`])
            || Number(process.env.VAD_PREFIX_PADDING) || 200);

        // Sprint 4.5 Step 1.1: Read stable A/B assignment from initialize() instead of re-rolling
        const assignment = this._vadAbAssignment;
        const silenceDuration = assignment?.inCohort ? assignment.silenceMs
            : (this._audioConfig?.vadSilenceDuration
            ?? (Number(process.env[`VAD_SILENCE_DURATION_${lang}`])
            || Number(process.env.VAD_SILENCE_DURATION) || 400));
        // Sprint 4.5 Step 1.3: A/B suggested config — set VAD_SILENCE_AB_MS=350 VAD_SILENCE_AB_PERCENT=50
        this._vadAbCohort = assignment?.cohort || 'control';

        // Azure semantic VAD — eagerness is only valid for OpenAI's semantic_vad type
        if (this.vadMode === 'azure_semantic_vad' || this.vadMode === 'azure_semantic_vad_multilingual') {
            // Auto-select multilingual VAD for non-English calls (per Azure docs:
            // azure_semantic_vad "primarily supports English", multilingual variant
            // supports German, Spanish, French, Italian, etc.)
            const effectiveVadType = (this._langCode && this._langCode !== 'en' && this.vadMode === 'azure_semantic_vad')
                ? 'azure_semantic_vad_multilingual'
                : this.vadMode;
            const rawThreshold = this._audioConfig?.vadThreshold
                ?? parseFloat(process.env[`VAD_THRESHOLD_${lang}`] || process.env.AZURE_VAD_THRESHOLD || '0.5');
            const threshold = Number.isFinite(rawThreshold) ? Math.max(0, Math.min(1, rawThreshold)) : 0.5;
            const removeFillerWords = process.env.AZURE_VAD_REMOVE_FILLER_WORDS !== 'false';
            const speechDurationMs = Number(process.env.AZURE_VAD_SPEECH_DURATION_MS) || 80;
            const autoTruncate = process.env.AZURE_VAD_AUTO_TRUNCATE === 'true';
            const semanticCfg = {
                type: effectiveVadType, threshold,
                silence_duration_ms: silenceDuration,
                remove_filler_words: removeFillerWords,
                speech_duration_ms: speechDurationMs,
                auto_truncate: autoTruncate,
                create_response: false, interrupt_response: true
            };
            // Add languages hint when known — improves filler word accuracy
            const langEnv = process.env.AZURE_VAD_LANGUAGES;
            const langs = langEnv
                ? langEnv.split(',').map(l => l.trim()).filter(Boolean)
                : (this._langCode ? [this._langCode] : []);
            if (langs.length > 0) semanticCfg.languages = langs;
            return semanticCfg;
        }

        const base = { prefix_padding_ms: prefixPadding, silence_duration_ms: silenceDuration, create_response: false, interrupt_response: true };
        const threshold = this._audioConfig?.vadThreshold
            ?? parseFloat(process.env[`VAD_THRESHOLD_${lang}`] || process.env.AZURE_VAD_THRESHOLD || '0.5');
        return { type: 'server_vad', threshold, ...base };
    }

    _getAdaptiveTokenLimit() {
        // Sprint 4.3: Floor/ceiling clamp prevents accidentally low/high values
        const raw = Math.floor(Number(process.env.MAX_RESPONSE_OUTPUT_TOKENS) || 400);
        const base = Math.max(100, Math.min(raw, 1000));
        if (!PHASE4_ENABLED) return base;
        if (this._currentComplexity === 'complex') return Math.min(base * 1.5, 600);
        return base;
    }

    _getAdaptiveTemperature() {
        const base = parseFloat(process.env.SLM_TEMPERATURE) || 0.7;
        let temp = base;
        if (PHASE4_ENABLED && this._currentComplexity === 'complex') {
            temp = Math.min(base + 0.15, 1.2);
        }
        return Math.max(0.6, Math.min(1.2, temp));
    }

    // ═══════════════════════════════════════════════════════════════════════
    // AUDIO SEND
    // ═══════════════════════════════════════════════════════════════════════

    sendAudio(audioBuffer) {
        if (!this.isConnected) return;
        if (!this.callSID) return;

        const formatted = this._formatAudioForProvider(audioBuffer);
        // formatted is an array of { audio: base64String } chunks
        for (const chunk of formatted) {
            this.send({ type: 'input_audio_buffer.append', audio: chunk.audio });
        }

        this.audioChunkCounter++;
        if (this.audioChunkCounter % 50 === 0) {
            log('debug', this.callSID, 'audio_metrics', {
                chunks: this.audioChunkCounter, bytes: audioBuffer.length
            });
        }

        if (this.vadMode === 'none') {
            this.pendingAudioSinceCommit = true;
            if (this.silenceCommitTimer) clearTimeout(this.silenceCommitTimer);
            this.silenceCommitTimer = setTimeout(() => {
                this.silenceCommitTimer = null;
                if (this.isConnected && this.pendingAudioSinceCommit && !this.isResponding) {
                    this.pendingAudioSinceCommit = false;
                    log('info', this.callSID, 'vad_none_silence_commit');
                    this.send({ type: 'input_audio_buffer.commit' });
                    this.send(this._buildResponseCreate({}));
                }
            }, this.SILENCE_COMMIT_MS);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // MESSAGE HANDLER
    // ═══════════════════════════════════════════════════════════════════════

    handleMessage(data) {
        try {
            const message = JSON.parse(data.toString());

            if (message.type === 'response.audio.delta') {
                if (!this._firstDeltaLogged) {
                    const now = Date.now();
                    const responseLatencyMs = this._speechStoppedAt ? now - this._speechStoppedAt : null;
                    log('info', this.callSID, 'first_audio_delta', {
                        response_id: message.response_id, ts: now,
                        ...(responseLatencyMs !== null ? { responseLatencyMs } : {})
                    });
                    if (responseLatencyMs !== null) {
                        telemetry.emit('response_latency', {
                            callSID: this.callSID, responseLatencyMs,
                            turnCount: this.count, ts: now
                        });
                        this._speechStoppedAt = null;
                    }
                    this._firstDeltaLogged = true;
                }
            } else {
                log('debug', this.callSID, 'voicelive_event', { type: message.type, event_id: message.event_id });
            }

            switch (message.type) {

                // ── SPEECH START (BARGE-IN) ───────────────────────────────
                case 'input_audio_buffer.speech_started':
                    this._handleSpeechStarted();
                    break;

                // ── SPEECH STOP ───────────────────────────────────────────
                case 'input_audio_buffer.speech_stopped':
                    this._handleSpeechStopped();
                    break;

                case 'input_audio_buffer.committed':
                    log('debug', this.callSID, 'audio_committed');
                    break;

                // ── SESSION LIFECYCLE ─────────────────────────────────────
                case 'session.created':
                    this.sessionId = message.session?.id || null;
                    log('info', this.callSID, 'session_created', { sessionId: this.sessionId });
                    telemetry.emit('realtime_session_created', {
                        callSID: this.callSID, provider: this.providerName,
                        sessionId: this.sessionId, timestamp: Date.now()
                    });
                    break;

                case 'session.updated':
                    this.sessionId = message.session?.id || this.sessionId;
                    this.isSessionConfigured = true;
                    // Log78 Fix 4: Clear session init timeout — session is alive
                    if (this._sessionInitTimer) {
                        clearTimeout(this._sessionInitTimer);
                        this._sessionInitTimer = null;
                    }
                    log('info', this.callSID, 'session_updated', { sessionId: this.sessionId });
                    telemetry.emit('realtime_session_updated', {
                        callSID: this.callSID, provider: this.providerName,
                        sessionId: this.sessionId, timestamp: Date.now()
                    });
                    this.emit('session_configured');
                    if (this._greetingPending) {
                        this._fireGreeting();
                    }
                    break;

                case 'error': {
                    const errCode = message.error?.code;
                    const isBenign = errCode === 'response_cancel_not_active'
                        || (errCode === 'input_audio_buffer_commit_empty' && this.vadMode !== 'none')
                        || errCode === 'conversation_already_has_active_response'
                        || errCode === 'item_already_truncated'
                        || errCode === 'item_delete_invalid_item_id';
                    if (!isBenign) {
                        log('error', this.callSID, 'azure_error', {
                            code: errCode, message: message.error?.message, type: message.error?.type
                        });
                    } else {
                        log('debug', this.callSID, 'azure_error_suppressed', {
                            code: errCode, message: message.error?.message
                        });
                    }
                    // Fix 6f: Our response.create was rejected — clear the spurious
                    // timeout timer that send() armed for it. Without this, the timer
                    // fires 10s later and cancels the ORIGINAL active response.
                    // Guard: only clear if the active response is already producing
                    // audio (_firstDeltaLogged). If it hasn't received audio yet,
                    // keep the timer as a safety net for a possibly-hung response.
                    if (errCode === 'conversation_already_has_active_response') {
                        if (this._firstDeltaLogged) {
                            this._clearResponseTimeout();
                        }
                        // Fix 10: Our response.create was rejected because the server is
                        // still processing a cancelled response. Flag for retry so
                        // _handleResponseDone re-sends a response.create with current
                        // session instructions instead of silently losing the user's question.
                        this._retryResponseCreateOnDone = true;
                        this._retryResponseCreateOnDoneOwner = this._lastResponseCreateOwner || this._captureResponseOwner('response_create_retry_after_done');
                        log('info', this.callSID, 'response_create_queued_for_retry', {
                            ts: Date.now()
                        });
                    }
                    this.emit('api_error', message.error);
                    break;
                }

                // ── TEXT INPUT PATH (Twilio only) ─────────────────────────
                case 'conversation.item.created':
                    if (this._enableTextInputPath) {
                        this._handleTextInput(message);
                    }
                    break;

                // ── MAIN TRANSCRIPTION PATH ───────────────────────────────
                case 'conversation.item.input_audio_transcription.completed':
                    this._handleTranscription(message);
                    break;

                // ── AUDIO STREAM ──────────────────────────────────────────
                case 'response.audio.delta':
                    this._handleAudioDelta(message);
                    break;

                case 'response.audio.done':
                    this._handleAudioDone(message);
                    break;

                // ── AI TRANSCRIPT ─────────────────────────────────────────
                case 'response.audio_transcript.delta':
                    if (!this.aiTranscript) this.aiTranscript = '';
                    this.aiTranscript += (message.delta || '');
                    // Sprint 6D: Sliding early duplicate detection — check at every 20-char
                    // boundary instead of once at 80 chars. Catches duplicates earlier,
                    // reducing the amount of duplicate audio that reaches the caller.
                    {
                        const _deltaLen = (message.delta || '').length;
                        const _prevLen = this.aiTranscript.length - _deltaLen;
                        if (this.aiTranscript.length >= 20 && (Math.floor(_prevLen / 20) < Math.floor(this.aiTranscript.length / 20))) {
                            if (this._isEarlyDuplicate(this.aiTranscript)) {
                                const isSilencePurpose = this._isSilenceResponsePurpose(this._currentResponsePurpose);
                                log('warn', this.callSID, 'early_duplicate_cancelled', {
                                    preview: this.aiTranscript.substring(0, 80),
                                    charCount: this.aiTranscript.length,
                                    purpose: this._currentResponsePurpose || null
                                });
                                telemetry.emit('early_dedup', {
                                    callId: this.callSID, provider: this.providerName,
                                    triggered: true, charCount: this.aiTranscript.length,
                                    ts: Date.now()
                                });
                                this._earlyDupCancelled = true; // Fix 11: flag so response.done skips drain
                                if (isSilencePurpose) this._silenceNudgeCancelledNoRepair = true;
                                this.send({ type: 'response.cancel' });
                            }
                        }
                        if (this._isSilenceResponsePurpose(this._currentResponsePurpose)
                            && this._expectedNudgePhrase
                            && this._isNudgeTranscriptClearlyOffScript(this.aiTranscript, this._expectedNudgePhrase)) {
                            const responseKey = message.response_id || this._currentResponseId || 'pending';
                            if (this._silenceNudgeComplianceCancelledForResponse !== responseKey) {
                                this._silenceNudgeComplianceCancelledForResponse = responseKey;
                                log('warn', this.callSID, 'nudge_compliance_early_cancelled', {
                                    expected: this._expectedNudgePhrase,
                                    preview: this.aiTranscript.substring(0, 80),
                                    expectedSummary: summarizeTextForLog(this._expectedNudgePhrase),
                                    previewSummary: summarizeTextForLog(this.aiTranscript),
                                    purpose: this._currentResponsePurpose,
                                    responseId: responseKey
                                });
                                this._earlyDupCancelled = true;
                                this._silenceNudgeCancelledNoRepair = true;
                                this.send({ type: 'response.cancel' });
                            }
                        }
                    }
                    break;

                case 'response.audio_transcript.done':
                    this._handleAITranscriptDone(message);
                    break;

                // ── RESPONSE LIFECYCLE ────────────────────────────────────
                case 'response.created':
                    this._handleResponseCreated(message);
                    break;

                case 'response.done':
                    this._handleResponseDone(message);
                    break;

                // ── SILENCED LIFECYCLE EVENTS ─────────────────────────────
                case 'response.output_item.added':
                case 'response.output_item.done':
                case 'response.content_part.added':
                case 'response.content_part.done':
                    break;

                case 'conversation.created':
                    if (message.conversation?.id) {
                        this.conversationId = message.conversation.id;
                    }
                    break;

                case 'conversation.updated':
                    break;

                case 'conversation.item.deleted':
                case 'conversation.item.truncated':
                case 'input_audio_buffer.cleared':
                    break;

                case 'response.audio_timestamp.delta':
                case 'response.audio_timestamp.done':
                    break;

                case 'rate_limits.updated':
                    this._handleRateLimitsUpdated(message);
                    break;

                case 'input_audio_buffer.timeout_triggered':
                    log('info', this.callSID, 'input_audio_timeout_triggered');
                    break;

                default:
                    log('debug', this.callSID, 'unhandled_event', { type: message.type });
                    break;
            }

        } catch (err) {
            log('error', this.callSID, 'message_parse_error', { message: err.message });
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // SPEECH HANDLERS
    // ═══════════════════════════════════════════════════════════════════════

    _ensureSpeechWindowState() {
        if (!Array.isArray(this._speechWindows)) this._speechWindows = [];
        if (!this._speechWindowTimers) this._speechWindowTimers = new Map();
        if (typeof this._speechWindowSeq !== 'number') this._speechWindowSeq = 0;
    }

    _recordSpeechWindowStart(now = Date.now()) {
        this._ensureSpeechWindowState();
        const previousUntranscribed = [...this._speechWindows]
            .reverse()
            .find((window) => window.stoppedAt && !window.transcribed && !window.noTranscriptEmitted);
        if (previousUntranscribed) {
            previousUntranscribed.overlappedByNextSpeech = true;
            previousUntranscribed.overlapGapMs = now - previousUntranscribed.stoppedAt;
        }
        const window = {
            id: ++this._speechWindowSeq,
            turnEpoch: this.turnStateRef?.currentTurnId || null,
            startedAt: now,
            stoppedAt: null,
            transcribed: false,
            overlappedPrevious: !!previousUntranscribed,
            overlappedByNextSpeech: false,
            overlapGapMs: null,
            noTranscriptEmitted: false
        };
        this._activeSpeechWindow = window;
        this._speechWindows.push(window);
        while (this._speechWindows.length > 20) {
            const removed = this._speechWindows.shift();
            const timer = removed ? this._speechWindowTimers.get(removed.id) : null;
            if (timer) clearTimeout(timer);
            if (removed) this._speechWindowTimers.delete(removed.id);
        }
    }

    _recordSpeechWindowStop(now = Date.now()) {
        this._ensureSpeechWindowState();
        const window = this._activeSpeechWindow;
        if (!window || window.stoppedAt) return;
        window.stoppedAt = now;
        this._activeSpeechWindow = null;
        const timeoutMs = this.SPEECH_WINDOW_TRANSCRIPT_TIMEOUT_MS || 2000;
        const timer = setTimeout(() => {
            this._speechWindowTimers.delete(window.id);
            this._emitSpeechWindowNoTranscript(window, 'timeout');
        }, timeoutMs);
        this._speechWindowTimers.set(window.id, timer);
    }

    _markSpeechWindowTranscribed(userText, confidence) {
        this._ensureSpeechWindowState();
        const now = Date.now();
        const window = [...this._speechWindows].reverse().find((candidate) => (
            !candidate.transcribed && !candidate.noTranscriptEmitted && candidate.stoppedAt
        )) || this._activeSpeechWindow;
        if (!window || window.transcribed) return null;
        window.transcribed = true;
        window.transcribedAt = now;
        const timer = this._speechWindowTimers.get(window.id);
        if (timer) clearTimeout(timer);
        this._speechWindowTimers.delete(window.id);

        const transcriptLength = typeof userText === 'string' ? userText.length : 0;
        const payload = this._buildSpeechWindowTelemetry(window, {
            transcriptLength,
            confidence: typeof confidence === 'number' ? confidence : null,
            transcriptDelayMs: window.stoppedAt ? now - window.stoppedAt : null
        });
        log('info', this.callSID, 'speech_window_transcribed', payload);
        telemetry.emit('speech_window_transcribed', payload);
        return window;
    }

    _emitSpeechWindowNoTranscript(window, reason) {
        if (!window || window.transcribed || window.noTranscriptEmitted) return;
        window.noTranscriptEmitted = true;
        const payload = this._buildSpeechWindowTelemetry(window, { reason });
        log('warn', this.callSID, 'speech_window_no_transcript', payload);
        telemetry.emit('speech_window_no_transcript', payload);
    }

    _buildSpeechWindowTelemetry(window, extra = {}) {
        const status = this._getSilenceStatus ? this._getSilenceStatus() : {};
        return {
            callId: this.callSID,
            provider: this.providerName,
            windowId: window.id,
            turnEpoch: window.turnEpoch || null,
            startedAt: window.startedAt,
            stoppedAt: window.stoppedAt || null,
            durationMs: window.stoppedAt ? window.stoppedAt - window.startedAt : null,
            overlappedPrevious: !!window.overlappedPrevious,
            overlappedByNextSpeech: !!window.overlappedByNextSpeech,
            overlapGapMs: window.overlapGapMs,
            lastInputEnergy: status.lastInputEnergy,
            lastGateLevel: status.lastGateLevel,
            lastGateSendAudio: status.lastGateSendAudio,
            lastGateSilenceFrames: status.lastGateSilenceFrames,
            ...extra,
            ts: Date.now()
        };
    }

    _clearSpeechWindowTimers() {
        if (!this._speechWindowTimers) return;
        for (const timer of this._speechWindowTimers.values()) clearTimeout(timer);
        this._speechWindowTimers.clear();
    }

    _handleSpeechStarted() {
        // Debounce rapid speech-start events
        const debounceMs = Number(process.env.SPEECH_START_DEBOUNCE_MS) || 150;
        const now = Date.now();
        if (this._lastSpeechStartTime && (now - this._lastSpeechStartTime) < debounceMs) {
            log('debug', this.callSID, 'speech_start_debounced', { gap: now - this._lastSpeechStartTime });
            return;
        }
        this._lastSpeechStartTime = now;
        this._lastSpeechStartedAt = now;
        const stillPlaying = this._enableAudioPlaybackTracking
            ? now < this._audioPlaybackEndEstimate
            : false;
        const isRespondingAtStart = !!this.isResponding;
        const isTrueBargeIn = isRespondingAtStart || stillPlaying;
        this._advanceInputActivityEpoch(isTrueBargeIn ? 'barge_in_speech_started' : 'speech_started');

        log('info', this.callSID, 'speech_started', {
            isResponding: isRespondingAtStart,
            stillPlaying,
            isBargeIn: isTrueBargeIn,
            ts: now
        });
        this.isUserSpeaking = true;
        this.emit('user_speaking');
        this.emit('user_speech_started', {
            timestamp: now,
            isBargeIn: isTrueBargeIn,
            isRespondingAtStart,
            stillPlaying
        });
        this._recordSpeechWindowStart(now);

        // Arm watchdog: if speech_stopped never arrives (noise/media keeps
        // stream open), flush any deferred instruction after timeout.
        if (this._deferredFlushWatchdog) clearTimeout(this._deferredFlushWatchdog);
        this._deferredFlushWatchdog = setTimeout(() => {
            this._deferredFlushWatchdog = null;
            if (this._deferredInstruction && this.isUserSpeaking && !this.isResponding && this.isConnected) {
                log('warn', this.callSID, 'deferred_flush_watchdog', {
                    ts: Date.now(), reason: 'speech_stopped_missing'
                });
                this.isUserSpeaking = false;
                this.emit('user_speech_stopped', { timestamp: Date.now() });
                const deferred = this._deferredInstruction;
                const deferredOwner = this._deferredInstructionOwner;
                const deferredScripted = this._deferredInstructionScripted === true;
                this._deferredInstruction = null;
                this._deferredInstructionOwner = null;
                this._deferredInstructionScripted = false;
                if (!this._shouldDropStaleRecoveryOwner(deferredOwner, 'deferred_instruction_watchdog')) {
                    if (deferredScripted) this._scriptedResponsePending = true;
                    this.send(this._buildOwnedResponseCreate({
                        instructions: deferred
                    }, deferredOwner));
                }
            }
        }, this.BARGE_IN_RECOVERY_MS);

        // Clear stale deferred user inputs from previous turns to prevent
        // cross-turn replay cascades in server_vad mode.
        if (this._deferredUserInputQueue.length > 0) {
            log('info', this.callSID, 'deferred_queue_cleared_on_speech', {
                dropped: this._deferredUserInputQueue.length
            });
            this._deferredUserInputQueue = [];
        }

        if (this._enableSilenceTimers) {
            clearTimeout(this.firstSilenceTimer);
            clearTimeout(this.secondSilenceTimer);
        }
        // In vadMode=none, _deferredInstruction is flushed in _handleSpeechStopped.
        // In server_vad, discard stale deferred instructions to prevent races
        // with the upcoming insertUpdatedPrompt response.create.
        if (this.vadMode !== 'none' && this._deferredInstruction) {
            log('info', this.callSID, 'deferred_instruction_discarded_on_speech', {
                preview: (this._deferredInstruction || '').substring(0, 60)
            });
            this._deferredInstruction = null;
            this._deferredInstructionOwner = null;
            this._deferredInstructionScripted = false;
        }

        if (isTrueBargeIn) {
            log('info', this.callSID, 'barge_in', { isResponding: isRespondingAtStart, stillPlaying });
            this._lastBargeInTime = Date.now();
            // Log78 Fix 2: Mark response as cancelled so truncated fragment skips quality gate
            this._responseWasCancelled = true;
            const cancelledItemId = this._currentResponseItemId || null;
            if (isRespondingAtStart) this.send({ type: 'response.cancel' });
            this.isResponding  = false;
            this.aiTranscript  = '';
            // Fix 10: Clear retry flag — the barge-in means the user's new speech
            // will trigger its own insertUpdatedPrompt/response.create.
            this._retryResponseCreateOnDone = false;
            this._retryResponseCreateOnDoneOwner = null;
            if (this._enableAudioPlaybackTracking) {
                this._audioPlaybackEndEstimate = 0;
            }
            const interruptionPayload = {
                cancelledResponseId: this._currentResponseId,
                isBargeIn: true,
                isRespondingAtStart,
                stillPlaying,
                timestamp: now
            };
            this.emit('interrupt_audio', interruptionPayload);

            // Per Azure docs: truncate the assistant audio item so the server's
            // conversation context only contains what the user actually heard.
            // Without this, the server retains the full AI transcript including
            // the part that was never played, polluting future turn context.
            if (cancelledItemId && this._truncateAudioEndMs > 0) {
                this.send({
                    type: 'conversation.item.truncate',
                    item_id: cancelledItemId,
                    content_index: 0,
                    audio_end_ms: this._truncateAudioEndMs
                });
                log('info', this.callSID, 'item_truncated', {
                    item_id: cancelledItemId,
                    audio_end_ms: this._truncateAudioEndMs
                });
            }

            this.accumulatedAudioBytes    = 0;
            this.audioAppendedSinceCommit = false;

            this._bargeInRecoveryStartedAt = now;
            this._scheduleBargeInRecoveryCheck(this.BARGE_IN_RECOVERY_MS, now, 0);
            this.emit('interruption', interruptionPayload);
        }
    }

    _clearBargeInRecoveryTimer() {
        if (this._bargeInRecoveryTimer) clearTimeout(this._bargeInRecoveryTimer);
        this._bargeInRecoveryTimer = null;
        this._bargeInRecoveryStartedAt = 0;
    }

    _scheduleBargeInRecoveryCheck(delayMs, startedAt, attempt = 0) {
        if (this._bargeInRecoveryTimer) clearTimeout(this._bargeInRecoveryTimer);
        const safeDelayMs = Math.max(0, Number(delayMs) || 0);
        this._bargeInRecoveryTimer = setTimeout(() => {
            this._bargeInRecoveryTimer = null;
            this._runBargeInRecoveryCheck(startedAt, attempt);
        }, safeDelayMs);
    }

    _scheduleBargeInRecoveryRecheck(startedAt, attempt, reason, status, elapsedMs, hardTimeoutReached) {
        if (!this.isConnected || startedAt !== this._bargeInRecoveryStartedAt) return;
        const delayMs = this.BARGE_IN_RECOVERY_RECHECK_MS;
        log('info', this.callSID, 'barge_in_recovery_recheck_scheduled', {
            reason,
            attempt,
            elapsedMs,
            hardTimeoutReached: !!hardTimeoutReached,
            delayMs,
            status
        });
        telemetry.emit('barge_in_recovery_recheck_scheduled', {
            callId: this.callSID,
            provider: this.providerName,
            reason,
            attempt,
            elapsedMs,
            hardTimeoutReached: !!hardTimeoutReached,
            delayMs,
            ...(status || {})
        });
        this._scheduleBargeInRecoveryCheck(delayMs, startedAt, attempt);
    }

    _runBargeInRecoveryCheck(startedAt, attempt = 0) {
        if (!this.isConnected || startedAt !== this._bargeInRecoveryStartedAt) return;
        if (this.isResponding) {
            log('info', this.callSID, 'barge_in_recovery_skipped', { reason: 'isResponding' });
            return;
        }
        if (!this.isUserSpeaking) return;

        const now = Date.now();
        const elapsedMs = now - startedAt;
        const status = this._getSilenceStatus(now);
        const suppressionReason = this._getBargeInRecoverySuppressionReason(status);

        if (suppressionReason === 'recent_transcript') {
            this.isUserSpeaking = false;
            this._recordSilenceDecision('barge_in_recovery_suppressed_state', 'barge_in_recovery', 'suppressed', suppressionReason, status, {
                elapsedMs,
                attempt,
                hardTimeoutReached: false
            });
            this._clearBargeInRecoveryTimer();
            return;
        }

        const hardTimeoutReached = elapsedMs >= this.BARGE_IN_RECOVERY_MAX_WAIT_MS;
        const hardBlockReason = hardTimeoutReached ? this._getBargeInRecoveryHardTimeoutBlockReason(status) : null;
        const effectiveSuppressionReason = hardTimeoutReached ? hardBlockReason : suppressionReason;

        if (effectiveSuppressionReason) {
            this._recordSilenceDecision('barge_in_recovery_suppressed_state', 'barge_in_recovery', 'suppressed', effectiveSuppressionReason, status, {
                elapsedMs,
                attempt,
                hardTimeoutReached
            });
            this._scheduleBargeInRecoveryRecheck(startedAt, attempt + 1, effectiveSuppressionReason, status, elapsedMs, hardTimeoutReached);
            return;
        }

        if (!hardTimeoutReached) {
            this._scheduleBargeInRecoveryRecheck(startedAt, attempt + 1, 'awaiting_hard_timeout', status, elapsedMs, false);
            return;
        }

        log('warn', this.callSID, 'barge_in_recovery_hard_timeout', {
            elapsedMs,
            timeoutMs: this.BARGE_IN_RECOVERY_MAX_WAIT_MS,
            attempt,
            status
        });
        telemetry.emit('barge_in_recovery_hard_timeout', {
            callId: this.callSID,
            provider: this.providerName,
            elapsedMs,
            timeoutMs: this.BARGE_IN_RECOVERY_MAX_WAIT_MS,
            attempt,
            ...(status || {})
        });

        this.isUserSpeaking = false;
        this.emit('user_speech_stopped', { timestamp: now, reason: 'barge_in_recovery_hard_timeout' });
        const clarification = this._getBargeInRecoveryClarification();
        log('info', this.callSID, 'barge_in_recovery_clarification_sent', {
            elapsedMs,
            timeoutMs: this.BARGE_IN_RECOVERY_MAX_WAIT_MS,
            phraseSummary: summarizeTextForLog(clarification)
        });
        telemetry.emit('barge_in_recovery_clarification_sent', {
            callId: this.callSID,
            provider: this.providerName,
            elapsedMs,
            timeoutMs: this.BARGE_IN_RECOVERY_MAX_WAIT_MS
        });
        this._clearBargeInRecoveryTimer();
        this.sendTextResponse(clarification);
    }

    _getBargeInRecoveryClarification() {
        return this.lang?.sttLocale?.startsWith('de')
            ? 'Ich möchte sicherstellen, dass ich Sie richtig verstanden habe. Könnten Sie das bitte wiederholen?'
            : 'I want to make sure I heard you correctly. Could you please repeat that?';
    }

    _handleSpeechStopped() {
        this._speechStoppedAt = Date.now();
        this._recordSpeechWindowStop(this._speechStoppedAt);
        log('info', this.callSID, 'speech_stopped', { ts: Date.now() });
        this.isUserSpeaking = false;

        if (this._deferredFlushWatchdog) {
            clearTimeout(this._deferredFlushWatchdog);
            this._deferredFlushWatchdog = null;
        }

        this._clearBargeInRecoveryTimer();

        this.emit('user_stopped_speaking');
        this.emit('user_speech_stopped', { timestamp: Date.now() });

        if (this.vadMode === 'none') {
            this.send({ type: 'input_audio_buffer.commit' });
        }

        // Flush deferred instruction if not currently responding.
        // With create_response:false, no auto-response races with this.
        if (this._deferredInstruction && !this.isResponding) {
            log('info', this.callSID, 'rag_deferred_flush', { ts: Date.now(), vadMode: this.vadMode });
            const deferred = this._deferredInstruction;
            const deferredOwner = this._deferredInstructionOwner;
            const deferredScripted = this._deferredInstructionScripted === true;
            this._deferredInstruction = null;
            this._deferredInstructionOwner = null;
            this._deferredInstructionScripted = false;
            if (!this._shouldDropStaleRecoveryOwner(deferredOwner, 'deferred_instruction_speech_stopped')) {
                if (deferredScripted) this._scriptedResponsePending = true;
                this.send(this._buildOwnedResponseCreate({
                    instructions: deferred
                }, deferredOwner));
            }
        }
    }

    _advanceInputActivityEpoch(reason = 'input_activity') {
        this._inputActivityEpoch = (this._inputActivityEpoch || 0) + 1;
        this._lastInputActivityEpochReason = reason;
        this._lastInputActivityEpochAt = Date.now();
        this._clearStaleRecoveryBypass(`${reason}_input_epoch`);
        return this._inputActivityEpoch;
    }

    _advanceAcceptedTranscriptTurnEpoch(reason = 'accepted_transcript') {
        this._acceptedTranscriptTurnEpoch = (this._acceptedTranscriptTurnEpoch || 0) + 1;
        this._lastAcceptedTranscriptEpochReason = reason;
        this._lastAcceptedTranscriptEpochAt = Date.now();
        this._clearStaleRecoveryBypass(`${reason}_transcript_epoch`);
        return this._acceptedTranscriptTurnEpoch;
    }

    _captureResponseOwner(source = 'response', options = {}) {
        return {
            source,
            acceptedTranscriptTurnEpoch: this._acceptedTranscriptTurnEpoch || 0,
            inputActivityEpoch: this._inputActivityEpoch || 0,
            createdAt: Date.now(),
            allowInputActivityDrift: options.allowInputActivityDrift === true
        };
    }

    _attachResponseOwner(message, owner) {
        if (!message || !owner) return message;
        Object.defineProperty(message, '__voicebotResponseOwner', {
            value: owner,
            enumerable: false,
            configurable: true
        });
        return message;
    }

    _buildOwnedResponseCreate(opts, owner) {
        return this._attachResponseOwner(this._buildResponseCreate(opts), owner);
    }

    _getStaleRecoveryReason(owner) {
        if (!owner) return null;
        if (owner.acceptedTranscriptTurnEpoch !== (this._acceptedTranscriptTurnEpoch || 0)) {
            return 'newer_transcript_turn';
        }
        if (!owner.allowInputActivityDrift && owner.inputActivityEpoch !== (this._inputActivityEpoch || 0)) {
            return 'newer_input_activity';
        }
        return null;
    }

    _recordStaleRecoveryResponseDropped(source, owner, reason, extra = {}) {
        const payload = {
            source,
            reason,
            ownerSource: owner?.source || null,
            ownerAcceptedTranscriptTurnEpoch: owner?.acceptedTranscriptTurnEpoch ?? null,
            activeAcceptedTranscriptTurnEpoch: this._acceptedTranscriptTurnEpoch || 0,
            ownerInputActivityEpoch: owner?.inputActivityEpoch ?? null,
            activeInputActivityEpoch: this._inputActivityEpoch || 0,
            ownerAgeMs: owner?.createdAt ? Date.now() - owner.createdAt : null,
            ...extra
        };
        log('info', this.callSID, 'stale_recovery_response_dropped', payload);
        telemetry.emit('stale_recovery_response_dropped', {
            callId: this.callSID,
            provider: this.providerName,
            ts: Date.now(),
            ...payload
        });
    }

    _shouldDropStaleRecoveryOwner(owner, source, extra = {}) {
        const staleReason = this._getStaleRecoveryReason(owner);
        if (!staleReason) return false;
        this._recordStaleRecoveryResponseDropped(source, owner, staleReason, extra);
        return true;
    }

    _sendRecoveryResponseCreate(opts, source, owner = null, extra = {}) {
        const responseOwner = owner || this._currentResponseOwner || this._captureResponseOwner(source);
        if (this._shouldDropStaleRecoveryOwner(responseOwner, source, extra)) return false;
        this.send(this._buildOwnedResponseCreate(opts, responseOwner));
        return true;
    }

    _clearStaleRecoveryBypass(source) {
        if (this._skipDupCheckForNextResponse && this._skipDupCheckForNextResponseOwner) {
            const staleReason = this._getStaleRecoveryReason(this._skipDupCheckForNextResponseOwner);
            if (staleReason) {
                this._recordStaleRecoveryResponseDropped(source, this._skipDupCheckForNextResponseOwner, staleReason, {
                    clearedFlag: '_skipDupCheckForNextResponse'
                });
                this._skipDupCheckForNextResponse = false;
                this._skipDupCheckForNextResponseOwner = null;
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // TRANSCRIPTION PROCESSING
    // ═══════════════════════════════════════════════════════════════════════

    _handleTextInput(message) {
        const content = message.item?.content?.[0];
        if (content?.type !== 'text') return;
        const userText = content.text?.trim();
        if (!userText) return;
        this._processUserTranscript(userText, undefined, 'text_input');
    }

    _handleTranscription(message) {
        if (this.turnStateRef) {
            if (this.turnStateRef.isClosed) return;
        }

        const transcript = message.transcript?.trim() || null;
        if (!transcript || transcript.length < 2) {
            log('debug', this.callSID, 'transcript_rejected', { reason: 'too_short_or_empty' });
            return;
        }
        // Normalize for duplicate detection: lowercase, strip trailing punctuation.
        // Azure STT can produce "Hello", "Hello.", "hello!", "Hello?" for the same
        // utterance — without normalization each variant bypasses the filter and
        // generates a separate AI response (the "5x hello" repeated-responses bug).
        const normalizedTranscript = transcript.toLowerCase().replace(/[.!?,;:]+$/, '');
        if (this._lastNormalizedTranscript === normalizedTranscript) {
            log('debug', this.callSID, 'transcript_rejected', { reason: 'duplicate_normalized', transcript });
            return;
        }
        this._lastNormalizedTranscript = normalizedTranscript;
        this.lastUserTranscript = transcript;

        const confidence = typeof message.confidence === 'number'
            ? message.confidence
            : (typeof message.transcript?.confidence === 'number' ? message.transcript.confidence : undefined);
        this._lastSttConfidence = confidence ?? null;

        this._processUserTranscript(transcript, confidence, 'audio_transcription');
    }

    _processUserTranscript(userText, confidence, source) {
        this._advanceAcceptedTranscriptTurnEpoch(source || 'accepted_transcript');
        this._advanceInputActivityEpoch(source || 'accepted_transcript');
        // Sprint 3.3: Reset per-turn generation counter on each new user utterance
        this._responsesThisTurn = 0;
        // Sprint 4.1: Reset mode collapse retry counter on new user turn
        this._modeCollapseRetries = 0;
        // Sprint 6F: Reset synthesis gate retry counter on new user turn
        this._synthesisGateRetries = 0;
        // Log64 P4: Reset hard backstop counter on new user turn
        this._aiTranscriptDoneCountThisTurn = 0;
        // Log77 Fix A: Reset silence-nudge flag on new user turn (safety: barge-in cancel could leak)
        this._isSilenceNudgeResponse = false;
        // Log78 Fix 2: Reset cancelled flag on new user turn
        this._responseWasCancelled = false;
        this._currentResponsePurpose = null;
        this._silenceNudgeCancelledNoRepair = false;
        this._bookingActionThisTurn = false;
        this._bookingActionReasonThisTurn = null;
        // Log77 Fix B: Transcript arrival = speech turn complete. Override stale isUserSpeaking
        // set by echo-triggered speech_started. Without this, insertUpdatedPrompt defers the
        // instruction and Azure responds with empty context (28 tokens → "Could you rephrase?").
        this._lastUserTranscriptAt = Date.now();
        const transcriptSpeechWindow = this._markSpeechWindowTranscribed(userText, confidence);
        if (this._bargeInRecoveryTimer) {
            this._clearBargeInRecoveryTimer();
            this._recordSilenceDecision('barge_in_recovery_suppressed_state', 'barge_in_recovery', 'suppressed', 'transcript_arrived', this._getSilenceStatus());
        }
        if (this._deferredFlushWatchdog) {
            clearTimeout(this._deferredFlushWatchdog);
            this._deferredFlushWatchdog = null;
        }
        this.isUserSpeaking = false;
        // Sprint 6E.5: Only reset permanent fallback if call-level dups haven't exceeded
        // hard limit. After 9+ dups, the model is stuck and resetting just wastes tokens.
        if (this._permanentDupFallback) {
            if ((this._callLevelDupCount || 0) < 9) {
                log('info', this.callSID, 'permanent_dup_fallback_reset_on_new_turn', {
                    callLevelDupCount: this._callLevelDupCount
                });
                this._permanentDupFallback = false;
            } else {
                log('warn', this.callSID, 'permanent_dup_fallback_locked', {
                    callLevelDupCount: this._callLevelDupCount,
                    reason: 'call_level_dups_exceeded_hard_limit'
                });
            }
        }
        // ── Call Screening ──────────────────────────────────────────
        if (isCallScreening(userText)) {
            log('info', this.callSID, 'call_screening_detected', { transcript: userText });
            this.isBeingScreened = true;
            insertConversation(this.callSID, this.recipient, 'system', `[SCREENED] ${userText}`);
            this.emit('screening_detected', userText);
            const screenResp = this.persona?.screening?.response?.(this.name)
                ?? `This is ${this.persona?.name || 'a representative'} from ${this.persona?.company || 'our company'}. Calling ${this.name || ''} about a business matter. This is a legitimate business call.`;
            this.sendTextResponse(screenResp);
            if (this._screeningTimeout) clearTimeout(this._screeningTimeout);
            this._screeningTimeout = setTimeout(() => {
                if (this.isBeingScreened) {
                    this.isBeingScreened = false;
                    log('info', this.callSID, 'screening_grace_timeout_regreeting', { graceMs: this._screeningGraceMs });
                    // The human likely picked up but hasn't spoken.  Rather than
                    // firing a generic silence nudge (which sounds wrong because the
                    // human never heard the greeting), re-deliver the greeting so
                    // the conversation starts naturally.
                    this.count = 0;
                    this.conversationContext = [];
                    if (!this.isResponding) {
                        this.send(this._buildResponseCreate({ instructions: this.getInitialGreetingInstructions() }));
                    }
                    if (this._enableSilenceTimers) this.resetSilenceTimers();
                }
            }, this._screeningGraceMs);
            if (this._enableSilenceTimers) this.resetSilenceTimers();
            return;
        }

        // ── Voicemail ───────────────────────────────────────────────
        if (isVoicemailContent(userText)) {
            log('info', this.callSID, 'voicemail_content_detected', { transcript: userText });
            insertConversation(this.callSID, this.recipient, 'system', `[VOICEMAIL] ${userText}`);
            this.emit('voicemail_detected', userText);
            this._updatePhase({ isVoicemail: true });
            const vmMsg = this.persona?.voicemail?.message?.(this.name)
                ?? `Hi, this is ${this.persona?.name || 'a representative'} from ${this.persona?.company || 'our company'}. We will follow up by email. Have a great day.`;
            this.sendTextResponse(vmMsg);
            // Schedule disconnect after voicemail message plays (~6s)
            const vmEpoch = this.count;
            setTimeout(() => {
                if (this.count === vmEpoch && this.isConnected) {
                    log('info', this.callSID, 'voicemail_auto_disconnect');
                    this.close();
                }
            }, 6000);
            return;
        }

        // ── Post-screening human reconnect ──────────────────────────
        // Any non-screening transcript while isBeingScreened is true must be
        // a real human — isCallScreening() already returned false above.
        // Previously this used isHumanGreeting() which only matched "hello/hi/yes"
        // and missed "who is this?", "what do you want?", "why are you calling?"
        // causing the bot to stay in screening phase and repeat the screening identity.
        if (this.isBeingScreened) {
            log('info', this.callSID, 'post_screening_human_connected', { transcript: userText });
            this.isBeingScreened = false;
            if (this._screeningTimeout) { clearTimeout(this._screeningTimeout); this._screeningTimeout = null; }
            this.count = 0;
            this.conversationContext = [];
            // Re-deliver the same greeting the human never heard (only the screener did)
            this.send(this._buildResponseCreate({ instructions: this.getInitialGreetingInstructions() }));
            if (this._enableSilenceTimers) this.resetSilenceTimers();
            return;
        }

        // ── Noise / garble filter ───────────────────────────────────
        if (isGarbledTranscript(userText)) {
            this.consecutiveNoisyTurns++;
            this._totalNoisyTurns++;
            telemetry.emit('garble_filter', {
                callId: this.callSID, provider: this.providerName,
                triggered: true, wordCount: userText.trim().split(/\s+/).length,
                ts: Date.now()
            });
            log('info', this.callSID, 'noisy_turn_skipped', {
                transcript: userText.substring(0, 60),
                consecutiveCount: this.consecutiveNoisyTurns,
                totalNoisyTurns: this._totalNoisyTurns,
            });
            if (this._totalNoisyTurns >= this.MAX_TOTAL_NOISY_TURNS) {
                log('warn', this.callSID, 'noise_loop_disconnect', {
                    totalNoisyTurns: this._totalNoisyTurns, threshold: this.MAX_TOTAL_NOISY_TURNS
                });
                const goodbye = this.lang?.sttLocale?.startsWith('de')
                    ? 'Die Verbindung ist leider zu schlecht. Ich versuche es später noch einmal. Auf Wiederhören.'
                    : 'The connection quality is too poor to continue. I\'ll try again later. Goodbye.';
                this.sendTextResponse(goodbye);
                const epoch = this.count;
                setTimeout(() => {
                    if (this.count === epoch && this.isConnected) this.close();
                }, 4000);
                return;
            }
            if (this.consecutiveNoisyTurns === 2) {
                const noiseAck = this.lang?.sttLocale?.startsWith('de')
                    ? `Entschuldigung, ich höre Sie gerade nicht deutlich. Könnten Sie das bitte wiederholen?`
                    : `Sorry, I'm having a bit of trouble hearing you clearly. Could you please repeat that?`;
                this.sendTextResponse(noiseAck);
            } else if (this.consecutiveNoisyTurns >= 3) {
                const noiseEsc = this.lang?.sttLocale?.startsWith('de')
                    ? `Die Verbindung ist leider sehr schlecht. Wir versuchen es ein anderes Mal. Auf Wiederhören.`
                    : `The connection seems too noisy to continue. We'll try again another time. Goodbye.`;
                this.sendTextResponse(noiseEsc);
                const epoch = this.count;
                setTimeout(() => {
                    if (this.count === epoch && this.isConnected) this.close();
                }, 4000);
            } else if (this.consecutiveNoisyTurns === 1 && this._lastBargeInTime
                && (Date.now() - this._lastBargeInTime) < this.BARGE_IN_RECOVERY_MS) {
                // First noisy turn right after a barge-in: the bot's previous
                // response was cancelled but the transcription was noise/garble.
                // Without this ack the bot goes permanently silent.
                const postBargeAck = this.lang?.sttLocale?.startsWith('de')
                    ? 'Entschuldigung, ich höre Sie gerade nicht deutlich. Könnten Sie das bitte wiederholen?'
                    : 'Sorry, I\'m having a bit of trouble hearing you clearly. Could you please repeat that?';
                this.sendTextResponse(postBargeAck);
            }
            if (this._enableSilenceTimers) this.resetSilenceTimers();
            return;
        }

        // ── Media bleedthrough ──────────────────────────────────────
        if (this._isMediaBleedthrough(userText)) {
            this.consecutiveNoisyTurns++;
            this._totalNoisyTurns++;
            log('info', this.callSID, 'media_bleedthrough_detected', {
                transcript: userText.substring(0, 80),
                contextSize: this._contextWords.size,
                consecutiveCount: this.consecutiveNoisyTurns,
                totalNoisyTurns: this._totalNoisyTurns,
                energyVariance: this._energyVariance,
                energySlope: this._energySlope,
            });
            if (this._totalNoisyTurns >= this.MAX_TOTAL_NOISY_TURNS) {
                log('warn', this.callSID, 'noise_loop_disconnect', {
                    totalNoisyTurns: this._totalNoisyTurns, threshold: this.MAX_TOTAL_NOISY_TURNS
                });
                const goodbye = this.lang?.sttLocale?.startsWith('de')
                    ? 'Die Verbindung ist leider zu schlecht. Ich versuche es später noch einmal. Auf Wiederhören.'
                    : 'The connection quality is too poor to continue. I\'ll try again later. Goodbye.';
                this.sendTextResponse(goodbye);
                const epoch = this.count;
                setTimeout(() => {
                    if (this.count === epoch && this.isConnected) this.close();
                }, 4000);
                return;
            }
            if (this.consecutiveNoisyTurns === 2) {
                const noiseAck = this.lang?.sttLocale?.startsWith('de')
                    ? `Entschuldigung, ich höre Sie gerade nicht deutlich. Könnten Sie das bitte wiederholen?`
                    : `Sorry, I'm having a bit of trouble hearing you clearly. Could you please repeat that?`;
                this.sendTextResponse(noiseAck);
            } else if (this.consecutiveNoisyTurns >= 3) {
                const noiseEsc = this.lang?.sttLocale?.startsWith('de')
                    ? `Die Verbindung ist leider sehr schlecht. Wir versuchen es ein anderes Mal. Auf Wiederhören.`
                    : `The connection seems too noisy to continue. We'll try again another time. Goodbye.`;
                this.sendTextResponse(noiseEsc);
                const epoch = this.count;
                setTimeout(() => {
                    if (this.count === epoch && this.isConnected) this.close();
                }, 4000);
            } else if (this.consecutiveNoisyTurns === 1 && this._lastBargeInTime
                && (Date.now() - this._lastBargeInTime) < this.BARGE_IN_RECOVERY_MS) {
                // First bleedthrough turn right after a barge-in: the bot's
                // previous response was cancelled but the transcription was the
                // bot's own audio bleeding back. Without this ack the bot goes
                // permanently silent.
                const postBargeAck = this.lang?.sttLocale?.startsWith('de')
                    ? 'Entschuldigung, ich höre Sie gerade nicht deutlich. Könnten Sie das bitte wiederholen?'
                    : 'Sorry, I\'m having a bit of trouble hearing you clearly. Could you please repeat that?';
                this.sendTextResponse(postBargeAck);
            }
            if (this._enableSilenceTimers) this.resetSilenceTimers();
            return;
        }

        // Clean turn — reset noise counter
        this.consecutiveNoisyTurns = 0;

        // ── Hold/pause detection ────────────────────────────────────
        if (this.isOnHold) {
            // User returned from hold — resume conversation
            this.isOnHold = false;
            if (this._holdTimer) { clearTimeout(this._holdTimer); this._holdTimer = null; }
            log('info', this.callSID, 'hold_resumed');
        }

        const _holdPatterns = /^(hold on|hang on|wait|one moment|one second|just a (second|moment|sec)|wait a (moment|second|minute)|hold please|just a moment|wait please|moment bitte|einen moment|warten sie|kurz warten)\.?$/i;
        if (_holdPatterns.test(userText.trim())) {
            log('info', this.callSID, 'hold_requested', { transcript: userText });
            this.isOnHold = true;
            this._updatePhase();
            const holdAck = this.lang?.sttLocale?.startsWith('de')
                ? 'Kein Problem, ich warte.'
                : 'No problem, take your time.';
            this.sendTextResponse(holdAck);
            // Auto-resume nudge after 15s
            this._holdTimer = setTimeout(() => {
                this._holdTimer = null;
                if (this.isOnHold && this.isConnected) {
                    this.isOnHold = false;
                    this._updatePhase();
                    const nudge = this.lang?.sttLocale?.startsWith('de')
                        ? 'Sind Sie noch da?'
                        : 'Still there? No rush.';
                    this.sendTextResponse(nudge);
                }
            }, 15000);
            if (this._enableSilenceTimers) this.resetSilenceTimers();
            return;
        }

        // ── Normal processing ───────────────────────────────────────
        log('info', this.callSID, 'user_transcribed', { transcript: userText, confidence });

        // ── Greeting loop detection ─────────────────────────────────
        const isSimpleGreeting = /^(hello[.!?]?|hi[.!?]?|hey[.!?]?)$/i.test(userText.trim());
        if (isSimpleGreeting) {
            this._consecutiveGreetings = (this._consecutiveGreetings || 0) + 1;
        } else {
            this._consecutiveGreetings = 0;
        }

        this.count++;
        // Sprint 5B.7: Reset no-speech voicemail counter on user speech
        this._aiResponsesSinceUserSpeech = 0;
        insertConversation(this.callSID, this.recipient, 'user', userText)
            .catch(err => log('error', this.callSID, 'insert_conversation_error', { role: 'user', message: err.message }));
        // Sprint 6A.4 (N2): Sanitize user text before adding to conversation history
        // Strips angle brackets (XML injection), control chars, and excessive whitespace
        const sanitizedUserText = String(userText || '').replace(/[<>]/g, '').replace(/[\x00-\x08\x0E-\x1F]/g, '').replace(/[\u200B-\u200F\uFEFF\u202A-\u202E]/g, '').replace(/\s{2,}/g, ' ').trim();
        this.addConversationContext('USER', sanitizedUserText);
        this.extractEntities(userText, 'USER');
        this._addContextWords(userText);
        this._updatePhase();

        const dealerOrderResponse = this._handleDealerOrderTurn(userText);
        if (dealerOrderResponse) {
            this._sendScriptedResponse(dealerOrderResponse.text, dealerOrderResponse.purpose, { addToContext: true });
            if (dealerOrderResponse.closeAfterMs) this._scheduleDealerOrderClose(dealerOrderResponse.closeAfterMs);
            if (this._enableSilenceTimers) this.resetSilenceTimers();
            return;
        }

        const clarification = this._buildUnclearSalesClarification(userText, confidence);
        if (clarification) {
            log('info', this.callSID, 'unclear_sales_turn_clarification', {
                phase: this.conversationPhase,
                wordCount: String(userText || '').trim().split(/\s+/).filter(Boolean).length
            });
            telemetry.emit('clarification_emitted', {
                callId: this.callSID,
                provider: this.providerName,
                reason: 'unclear_sales_turn',
                phase: this.conversationPhase,
                ts: Date.now()
            });
            this._sendScriptedResponse(clarification, 'clarification', { addToContext: true });
            if (this._enableSilenceTimers) this.resetSilenceTimers();
            return;
        }

        // ── Deterministic consultation pivot (fallback if LLM ignores PIVOT NOW prompt) ──
        if (this._shouldTriggerDeterministicConsultationPivot(userText, isSimpleGreeting)) {
            log('info', this.callSID, 'deterministic_consultation_pivot', { count: this.count });
            this.hasAskedForConsultation = true;
            this._consultationOfferedThisTurn = true;
            this._updatePhase(); // re-compute: phase → 'offer'
            this._sendScriptedResponse('That sounds like a great fit. Can I book a quick 20-minute call with our solutions team? They can put together a tailored plan for you.', 'consultation_offer', { addToContext: true });
            if (this._enableSilenceTimers) this.resetSilenceTimers();
            return;
        }

        // Inject audio-issue context after repeated greeting-only turns
        let effectiveUserText = userText;
        if (this._consecutiveGreetings >= 3) {
            log('warn', this.callSID, 'greeting_loop_detected', { count: this._consecutiveGreetings });
            effectiveUserText = `${userText}\n[SYSTEM NOTE: The caller has said "hello" ${this._consecutiveGreetings} times in a row. They may be experiencing audio issues. Vary your response and confirm they can hear you clearly.]`;
        }

        // Phase C1: Turn complexity detection
        if (PHASE4_ENABLED) {
            const complexityResult = detectComplexity(effectiveUserText);
            this._currentComplexity = complexityResult.isComplex ? 'complex' : 'simple';
            this.emit('turn_complexity', {
                complexity: this._currentComplexity,
                reason: complexityResult.reason,
                userText: effectiveUserText.substring(0, 100)
            });
        }

        this.emit('user_transcript', userText, {
            confidence,
            turnEpoch: transcriptSpeechWindow?.turnEpoch || this.turnStateRef?.currentTurnId || null
        });

        // Sprint 6C.7 (P4): Inject variation hint if repetition guard fired
        if (this._repetitionHintPending) {
            effectiveUserText += '\n[SYSTEM NOTE: Your last 3 responses were very similar. Vary your language, provide new information, or advance the conversation.]';
            this._repetitionHintPending = false;
        }

        this.insertUpdatedPrompt(effectiveUserText, this._decision);
        if (this._enableSilenceTimers) this.resetSilenceTimers();
    }

    // ═══════════════════════════════════════════════════════════════════════
    // AUDIO DELTA / DONE
    // ═══════════════════════════════════════════════════════════════════════

    _handleAudioDelta(message) {
        if (this.turnStateRef) {
            if (this.turnStateRef.isClosed) return;
        }
        if (!message.delta) return;

        this.isResponding = true;
        this._currentResponseId = message.response_id || this._currentResponseId || null;
        this._currentResponseItemId = message.item_id || this._currentResponseItemId || null;
        const audioData = this._parseAudioDelta(message);

        // ── First-audio-delta latency telemetry ─────────────────────
        if (!this._firstDeltaLogged) {
            this._firstDeltaLogged = true;
            // Fix 6a: Clear response timeout here (first real output) instead
            // of in response.created, so the timer covers the full lifecycle
            // from response.create → first audio byte.
            this._clearResponseTimeout();
            const now = Date.now();
            const sinceSpStopped = this._speechStoppedAt ? now - this._speechStoppedAt : null;
            log('info', this.callSID, 'first_audio_delta', {
                ts: now,
                speechStoppedAt: this._speechStoppedAt || null,
                latencyMs: sinceSpStopped
            });
            telemetry.emit('first_audio_delta', {
                callSID: this.callSID,
                provider: this.providerName,
                latencyMs: sinceSpStopped,
                timestamp: now
            });
        }

        // Track cumulative audio duration for conversation.item.truncate on barge-in.
        // Azure audio at 8kHz mono = 1 byte per sample → bytes / 8 = ms.
        const deltaMs = Math.round((audioData.length / 8000) * 1000);
        this._truncateAudioEndMs += deltaMs;

        if (this._enableAudioPlaybackTracking) {
            const rawAudioBytes = audioData.length;
            const chunkMs = Math.round((rawAudioBytes / 8000) * 1000);
            if (this._firstAudioTs === null) this._firstAudioTs = Date.now();
            this._totalAudioDurationMs += chunkMs;
            this._audioPlaybackEndEstimate = this._firstAudioTs + this._totalAudioDurationMs + 400;
        }

        this.emit('audio', audioData, this._currentResponseId);
    }

    _handleAudioDone(message) {
        if (this.turnStateRef) {
            if (this.turnStateRef.isClosed) return;
        }

        const producedAudio = this._firstDeltaLogged;
        const completedResponsePurpose = this._currentResponsePurpose;
        this.isResponding = false;
        // Let _audioPlaybackEndEstimate expire naturally via wall-clock.
        // The estimate is _firstAudioTs + _totalAudioDurationMs + 400ms and
        // self-expires when Date.now() passes it.  _handleResponseCreated
        // resets all counters before the next response generates audio.
        // Keeping the estimate alive enables tail-playback barge-in detection
        // (user speaks after Azure finishes generating but before caller hears it).
        if (this.vadMode === 'none') {
            if (this.silenceCommitTimer) {
                clearTimeout(this.silenceCommitTimer);
                this.silenceCommitTimer = null;
            }
            this.pendingAudioSinceCommit = false;
        }
        log('info', this.callSID, 'audio_done', { ts: Date.now() });
        this.emit('audio_done', message);

        // Greeting → operational transition
        // Only transition if audio was actually produced (firstDeltaLogged).
        // A TTS failure fires audio_done with zero deltas — don't promote yet.
        if (!this._greetingDelivered) {
            if (this._firstDeltaLogged) {
                this._greetingDelivered = true;
                log('info', this.callSID, 'session_transition', { from: 'greeting', to: 'operational' });
                this.send({
                    type: 'session.update',
                    session: this._buildFullSessionConfig(this.getOperationalInstructions())
                });
            } else {
                log('warn', this.callSID, 'greeting_audio_empty', { ts: Date.now() });
            }
        }

        if (this._enableSilenceTimers && producedAudio && !this._callClosed) {
            this._startPostAssistantSilenceTimer(completedResponsePurpose);
        }
        if (completedResponsePurpose && this._currentResponsePurpose === completedResponsePurpose) {
            this._currentResponsePurpose = null;
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // AI TRANSCRIPT + HANGUP ANALYSIS
    // ═══════════════════════════════════════════════════════════════════════

    _handleAITranscriptDone(message) {
        if (this.turnStateRef) {
            if (this.turnStateRef.isClosed) return;
        }

        // Log64 P4: Hard backstop — cap total _handleAITranscriptDone invocations per turn.
        // Prevents any cascade (dup + synthesis + quality + timeout) from generating
        // more than 6 responses regardless of which retry path triggered them.
        this._aiTranscriptDoneCountThisTurn = (this._aiTranscriptDoneCountThisTurn || 0) + 1;
        if (this._aiTranscriptDoneCountThisTurn > 6) {
            log('warn', this.callSID, 'per_turn_response_hard_cap', {
                count: this._aiTranscriptDoneCountThisTurn
            });
            this.aiTranscript = ''; // prevent unbounded accumulation while capped
            return;
        }

        // Get transcript — handle both Twilio (aiTranscript accumulated) and Plivo (message.transcript)
        const rawAiText = (this.aiTranscript || message.transcript || '').trim();
        this.aiTranscript = ''; // reset for next response

        // Strip Azure Realtime API internal format tokens (e.g. <|sam|says|>, <|bot|says|>)
        // that occasionally leak into response.audio_transcript.delta
        const aiText = rawAiText
            .replace(/<\|[^>]*\|>/g, '')
            // Log65 P1c+: Strip model-hallucinated bracket placeholders
            .replace(/\[(?:Your\s+)?(?:Name|Agent(?:\s+Name)?|Company(?:\s+Name)?|Product|Service|Brand|Client(?:'s)?\s+Name|Caller(?:'s)?\s+Name)\]/gi, '')
            .trim();

        if (!aiText || aiText.length === 0) {
            if (this._isSilenceResponsePurpose(this._currentResponsePurpose)) {
                this._isSilenceNudgeResponse = false;
                this._expectedNudgePhrase = null;
                return;
            }
            this._currentResponsePurpose = null;
            return;
        }

        const isScriptedResponse = this._scriptedResponsePending === true;
        this._scriptedResponsePending = false;
        const responsePurpose = this._currentResponsePurpose;
        const isSilenceResponse = this._isSilenceResponsePurpose(responsePurpose);
        const responseOwner = this._currentResponseOwner || this._captureResponseOwner('ai_transcript_done');

        // Guard: discard corrupted/runaway responses
        const _aiWordCount = aiText.split(/\s+/).length;
        if (_aiWordCount > 200) {
            log('warn', this.callSID, 'corrupted_response_discarded', {
                wordCount: _aiWordCount, preview: aiText.substring(0, 150)
            });
            return;
        }

        // Soft word limit enforcement — flag for next turn if significantly over target
        const _targetMaxWords = this.persona?.rules?.targetWords?.detailedMax || 50;
        if (_aiWordCount > _targetMaxWords * 2) {
            log('warn', this.callSID, 'word_limit_exceeded', {
                wordCount: _aiWordCount, target: _targetMaxWords
            });
            this._wordLimitOverride = `Your previous response was ${_aiWordCount} words. MAX ${_targetMaxWords} words this turn. Be concise.`;
        } else {
            this._wordLimitOverride = null;
        }

        // ── Log77 Fix A: Skip quality gate for silence-nudge responses ────
        // Silence nudges are scripted 2-word phrases ("Everything okay?", "Still there?")
        // that always fail the too_short check. Without this bypass, the quality retry
        // sends conversation:'none' with no language anchor → model responds in wrong language.
        if (this._isSilenceNudgeResponse) {
            this._isSilenceNudgeResponse = false;
            const expectedPhrase = this._expectedNudgePhrase;
            this._expectedNudgePhrase = null;
            log('info', this.callSID, 'quality_gate_skipped_silence_nudge', {
                preview: aiText.substring(0, 50),
                actualSummary: summarizeTextForLog(aiText),
                expectedSummary: summarizeTextForLog(expectedPhrase)
            });
            // Log78 Fix 3: Nudge compliance check — if the model ignored the
            // scripted phrase and generated something completely different,
            // discard the hallucinated response. The expected nudge is typically
            // 2-5 words; if the model produced 3x+ more words, it hallucinated.
            if (expectedPhrase) {
                const expectedWords = expectedPhrase.split(/\s+/).length;
                const normalizedAi = aiText.toLowerCase().replace(/[^a-z\u00e0-\u00ff\s]/g, '').trim();
                const normalizedExpected = expectedPhrase.toLowerCase().replace(/[^a-z\u00e0-\u00ff\s]/g, '').trim();
                const isCompliant = normalizedAi.includes(normalizedExpected)
                    || (expectedWords <= 5 && _aiWordCount <= expectedWords * 2);
                if (!isCompliant) {
                    log('warn', this.callSID, 'nudge_compliance_fail', {
                        expected: expectedPhrase,
                        actual: aiText.substring(0, 100),
                        expectedWords, actualWords: _aiWordCount,
                        expectedSummary: summarizeTextForLog(expectedPhrase),
                        actualSummary: summarizeTextForLog(aiText)
                    });
                    this._currentResponsePurpose = null;
                    if (this._sendBookingRecoveryResponse('nudge_compliance_booking_repair', responseOwner, {
                        expectedSummary: summarizeTextForLog(expectedPhrase),
                        actualSummary: summarizeTextForLog(aiText)
                    })) return;
                    return;
                }
            }
            log('info', this.callSID, 'ai_response', { transcript: aiText });
            this.emit('ai_transcript', aiText);
            insertConversation(this.callSID, this.recipient, 'bot', aiText)
                .catch(err => log('error', this.callSID, 'insert_conversation_error', { role: 'bot', message: err.message }));
            return;
        } else if (this._responseWasCancelled) {
            // Log78 Fix 2: Response was truncated by barge-in. The fragment is not a
            // model failure — skip the quality gate entirely and discard the fragment.
            this._responseWasCancelled = false;
            log('info', this.callSID, 'quality_gate_skipped_barge_in_truncation', {
                wordCount: _aiWordCount, preview: aiText.substring(0, 50)
            });
            return; // Discard truncated fragment — user's new speech will trigger a fresh response
        } else {

        // ── Sprint 4.1: Mode collapse / response quality gate ────
        const qualityIssue = this._assessResponseQuality(aiText, _aiWordCount);
        if (qualityIssue) {
            this._modeCollapseRetries = (this._modeCollapseRetries || 0) + 1;
            log('warn', this.callSID, 'response_quality_fail', {
                reason: qualityIssue, wordCount: _aiWordCount,
                retryCount: this._modeCollapseRetries,
                preview: aiText.substring(0, 100)
            });
            telemetry.emit('response_quality_fail', {
                callSID: this.callSID, reason: qualityIssue,
                retryCount: this._modeCollapseRetries, ts: Date.now()
            });
            // Max 1 retry per turn to avoid amplification loops
            if (this._modeCollapseRetries <= 1) {
                // Log64 P3: Clear deferred text so _handleResponseDone doesn't drain
                // a queued silence nudge that would collide with this retry.
                this._deferredTextResponse = null;
                this._deferredTextResponseOwner = null;
                // Log77 Fix D: Add language constraint to prevent wrong-language retries
                const _retryLangLabel = (this._langCode || 'en') === 'de' ? 'German' : 'English';
                this._sendRecoveryResponseCreate({
                    instructions: `Your previous response was incomplete or repetitive. Provide a complete, helpful response that directly addresses the caller. Do NOT repeat greetings. Respond ONLY in ${_retryLangLabel}.`,
                    conversation: 'none',
                    input: []
                }, 'quality_retry', responseOwner);
                return;
            }
            // After 1 retry, fall through to normal processing — accept the response
            this._modeCollapseRetries = 0;
        } else {
            this._modeCollapseRetries = 0;
        }

        } // end quality gate (skipped for silence nudges)

        // ── Layer 2: Post-generation hallucination scan ──────────
        const _hallucinationResult = scanForHallucination(aiText, this._lastRelevantKnowledge);
        if (_hallucinationResult.hallucinated) {
            log('warn', this.callSID, 'hallucination_detected', {
                reasons: _hallucinationResult.reasons, preview: aiText.substring(0, 150),
            });
            const fallback = getHallucinationFallback(this.conversationPhase, this.name, this.persona, this._buildGuardrailFallbackContext());
            if (this._shouldDropStaleRecoveryOwner(responseOwner, 'hallucination_fallback')) return;
            this.addConversationContext('AI', fallback);
            // Log64 P3: Clear deferred text so _handleResponseDone doesn't drain
            // a queued silence nudge that would collide with this retry.
            this._deferredTextResponse = null;
            this._deferredTextResponseOwner = null;
            const isIdentityHallucination = _hallucinationResult.reasons.includes('identity_hallucination');
            const identityReinforcement = isIdentityHallucination
                ? `\n\nIMPORTANT: You are ${this.name}. You are NOT Phi, ChatGPT, or any other AI. Never identify as any entity other than ${this.name}. Never say you were developed by Microsoft, OpenAI, or any other company.`
                : '';
            this._scriptedResponsePending = true;
            this._sendRecoveryResponseCreate({
                instructions: `Say ONLY these exact words, then stop: "${fallback}"${identityReinforcement}`
            }, 'hallucination_fallback', responseOwner);
            return;
        }

        // ── Phase 4 Layer 2: Post-generation quality gate ────────
        let processedAiText = aiText;
        try {
        if (PHASE4_ENABLED && this._phase4Profile) {
            const profile = this._phase4Profile;
            const docContext = (this._lastSanitizedDocs || [])
                .map(d => d.content).join('\n');

            // B2a: Numeric enforcement
            // Log76 Fix: Skip numeric + synthesis gates when KB returned only general marketing blurb.
            // The flag is set by conversationEngine.js — when true, there's no meaningful
            // grounding to score against, and enforceNumerics produces arbitrary penalties.
            if (docContext.length > 0 && this._lastKbIsGeneralFallback !== true) {
                const numResult = enforceNumerics(docContext, aiText, profile);
                if (!numResult.allowed) {
                    log('warn', this.callSID, 'numeric_violation', {
                        penalty: numResult.penalty,
                        snippets: numResult.unsupportedSnippets.slice(0, 3)
                    });
                    const fallback = getHallucinationFallback(this.conversationPhase, this.name, this.persona, this._buildGuardrailFallbackContext());
                    if (this._shouldDropStaleRecoveryOwner(responseOwner, 'numeric_violation_fallback')) return;
                    this.addConversationContext('AI', fallback);
                    // Log64 P3: Clear deferred text so _handleResponseDone doesn't drain
                    // a queued silence nudge that would collide with this retry.
                    this._deferredTextResponse = null;
                    this._deferredTextResponseOwner = null;
                    this._scriptedResponsePending = true;
                    this._sendRecoveryResponseCreate({
                        instructions: `Say ONLY these exact words, then stop: "${fallback}"`
                    }, 'numeric_violation_fallback', responseOwner);
                    telemetry.emit('numeric_violation', {
                        callId: this.callSID,
                        penalty: numResult.penalty,
                        ts: Date.now()
                    });
                    return;
                }

                // B2b: Synthesis scoring
                const synthResult = computeSynthesisScore({
                    docs: this._lastSanitizedDocs || [],
                    answer: aiText,
                    docContext,
                    numericPenalty: numResult.penalty
                });

                telemetry.emit('synthesis_score', {
                    callId: this.callSID,
                    score: synthResult.finalScore,
                    grounding: synthResult.grounding,
                    alignment: synthResult.alignment,
                    ts: Date.now()
                });

                // Log76 Fix: Lower threshold for discovery/opening questions.
                // During discovery the bot's job is to ASK, not cite KB content.
                // Grounding/alignment scores are structurally low for questions.
                const isDiscoveryQuestion = (this.conversationPhase === 'discovery' || this.conversationPhase === 'opening')
                    && aiText.trim().endsWith('?');
                const effectiveThreshold = isDiscoveryQuestion
                    ? Math.min(profile.rag.synthesisThreshold, 0.45)
                    : profile.rag.synthesisThreshold;

                const skipSynthesisGate = this._shouldSkipSynthesisGateForResponse(aiText, isScriptedResponse);
                const synthesisGatePassed = skipSynthesisGate || passesSynthesisGate(synthResult.finalScore, effectiveThreshold);
                if (!synthesisGatePassed) {
                    this._lowSynthesisTurnCount = (this._lowSynthesisTurnCount || 0) + 1;
                    this._synthesisGateRetries = (this._synthesisGateRetries || 0) + 1;
                    log('warn', this.callSID, 'synthesis_gate_failed', {
                        score: synthResult.finalScore,
                        threshold: effectiveThreshold,
                        profileThreshold: profile.rag.synthesisThreshold,
                        isDiscoveryQuestion,
                        retryCount: this._synthesisGateRetries
                    });
                    const fallback = getHallucinationFallback(this.conversationPhase, this.name, this.persona, this._buildGuardrailFallbackContext());
                    if (this._synthesisGateRetries >= 2) {
                        log('warn', this.callSID, 'synthesis_gate_cap_reached', {
                            retries: this._synthesisGateRetries,
                            delivering: fallback.substring(0, 80)
                        });
                        this.emit('synthesis_cascade_ended');
                        if (this._shouldDropStaleRecoveryOwner(responseOwner, 'synthesis_gate_cap_fallback')) {
                            this._skipDupCheckForNextResponse = false;
                            this._skipDupCheckForNextResponseOwner = null;
                            return;
                        }
                        processedAiText = fallback;
                        // Skip dup check — fallback is intentional even if it matches a recent response
                        this._skipDupCheckForNextResponse = true;
                        this._skipDupCheckForNextResponseOwner = responseOwner;
                        // Fall through to delivery — addConversationContext happens at L1773
                    } else {
                        if (this._shouldDropStaleRecoveryOwner(responseOwner, 'synthesis_gate_retry')) return;
                        this.addConversationContext('AI', fallback);
                        // Log64 P3: Clear deferred text so _handleResponseDone doesn't drain
                        // a queued silence nudge that would collide with this retry.
                        this._deferredTextResponse = null;
                        this._deferredTextResponseOwner = null;
                        this._scriptedResponsePending = true;
                        this._sendRecoveryResponseCreate({
                            instructions: `Say ONLY these exact words, then stop: "${fallback}"`
                        }, 'synthesis_gate_retry', responseOwner);
                        return;
                    }
                } else {
                    if (skipSynthesisGate) {
                        log('info', this.callSID, 'synthesis_gate_skipped_contextual', {
                            phase: this.conversationPhase,
                            scripted: isScriptedResponse,
                            questionType: classifyFallbackQuestion(this._getLatestUserMessage())
                        });
                    }
                    this._lowSynthesisTurnCount = 0;
                }
            } else {
                const unsupportedNumerics = extractNumerics(processedAiText);
                if (unsupportedNumerics.length > 0) {
                    telemetry.emit('numeric_without_grounding', {
                        callId: this.callSID,
                        numerics: unsupportedNumerics.map(n => n.raw),
                        ts: Date.now()
                    });
                }
            }

            // B2c: Persona style pass
            const profileName = profile.name || 'balanced';
            const prePersonaText = processedAiText;
            const styleResult = applyPersonaPass(processedAiText, profileName, {
                escalationActive: this._handoverTriggered
            });
            if (!styleResult.numericsUnchanged) {
                processedAiText = prePersonaText;
            } else {
                processedAiText = styleResult.text;
            }

            telemetry.emit('persona_pass_applied', {
                callId: this.callSID,
                humorUsed: styleResult.humorUsed,
                numericsUnchanged: styleResult.numericsUnchanged,
                ts: Date.now()
            });
        }
        } catch (phase4Err) {
            log('error', this.callSID, 'phase4_layer2_error', { message: phase4Err.message });
            processedAiText = aiText; // Fall back to unprocessed text
        }

        const responsePhase = this._phaseAtResponseStart || this.conversationPhase;
        const phaseViolation = this._detectPhaseContractViolation(processedAiText, responsePhase);
        if (phaseViolation) {
            log('warn', this.callSID, 'phase_contract_violation', {
                phase: responsePhase,
                reason: phaseViolation.reason,
                preview: aiText.substring(0, 120),
                preferredSlotPresent: !!this.preferredSlot,
                userEmailPresent: !!this.userEmail,
            });

            const corrective = this._buildPhaseContractCorrection(responsePhase);
            if (this._shouldDropStaleRecoveryOwner(responseOwner, 'phase_contract_correction')) return;
            this.addConversationContext('AI', corrective);
            // Log64 P3: Clear deferred text so _handleResponseDone doesn't drain
            // a queued silence nudge that would collide with this correction.
            this._deferredTextResponse = null;
            this._deferredTextResponseOwner = null;
            this._scriptedResponsePending = true;
            this._sendRecoveryResponseCreate({
                instructions: `Say ONLY these exact words, then stop: "${corrective}"`,
                conversation: 'none',
                input: []
            }, 'phase_contract_correction', responseOwner);
            return;
        }

        // ── Response deduplication ───────────────────────────────────
        // Sprint 3.2: If permanent fallback active, skip ALL response generation
        if (this._permanentDupFallback) {
            log('info', this.callSID, 'response_skipped_permanent_dup_fallback', {
                preview: aiText.substring(0, 80)
            });
            return;
        }

        // Sprint 3.2c: Skip dup check for circuit breaker fallback response
        if (this._skipDupCheckForNextResponse) {
            const skipOwner = this._skipDupCheckForNextResponseOwner;
            this._skipDupCheckForNextResponse = false;
            this._skipDupCheckForNextResponseOwner = null;
            if (this._shouldDropStaleRecoveryOwner(skipOwner, 'skip_dup_fallback_delivery')) return;
            // Fall through to normal processing — don't check for duplicates
        } else if (this._isResponseDuplicate(processedAiText)) {
            this._consecutiveDupSuppressions = (this._consecutiveDupSuppressions || 0) + 1;
            log('warn', this.callSID, 'response_duplicate_suppressed', {
                preview: processedAiText.substring(0, 80),
                consecutiveCount: this._consecutiveDupSuppressions
            });
            // Sprint 6D: Remove duplicate from Azure server-side conversation history
            // to prevent the model from regenerating the same response on future turns.
            // Mirrors conversation.item.truncate pattern used in barge-in.
            if (this._currentResponseItemId) {
                this.send({ type: 'conversation.item.delete', item_id: this._currentResponseItemId });
                log('info', this.callSID, 'duplicate_item_deleted_from_server', {
                    item_id: this._currentResponseItemId
                });
            }
            // Fix 8a: Do NOT add duplicate to conversationContext — it reinforces
            // the repetition pattern by showing the LLM repeated history.
            // Still extract entities and update phase so signals aren't lost
            this.extractEntities(aiText, 'AI');
            this._updatePhase();

            if (isSilenceResponse) {
                log('warn', this.callSID, 'duplicate_nudge_suppressed_no_repair', {
                    preview: processedAiText.substring(0, 80),
                    purpose: responsePurpose
                });
                if (this._sendBookingRecoveryResponse('duplicate_nudge_booking_repair', responseOwner, {
                    preview: processedAiText.substring(0, 80),
                    purpose: responsePurpose
                })) {
                    this._currentResponsePurpose = null;
                    return;
                }
                this._silenceNudgeCancelledNoRepair = true;
                this._currentResponsePurpose = null;
                return;
            }

            // Fix 8b+11: Send correction directly via _buildResponseCreate with
            // conversation:'none' to bypass Azure server-side history that keeps
            // regenerating the same duplicate. Do NOT use sendTextResponse — it
            // defers when isResponding=true, creating an infinite drain loop.

            // Sprint 6E.3: Per-turn generation cap — count ALL dup correction branches
            // (mild + circuit breaker). Moved here so breaker increments too.
            this._responsesThisTurn = (this._responsesThisTurn || 0) + 1;
            if (this._responsesThisTurn > 3) {
                log('warn', this.callSID, 'per_turn_generation_cap_reached', {
                    responsesThisTurn: this._responsesThisTurn,
                    consecutiveDups: this._consecutiveDupSuppressions
                });
                return;
            }

            if (this._consecutiveDupSuppressions >= 3) {
                // Sprint 3.2: Accumulate at call level before resetting window counter
                this._callLevelDupCount = (this._callLevelDupCount || 0) + this._consecutiveDupSuppressions;

                log('warn', this.callSID, 'response_loop_circuit_breaker', {
                    consecutiveCount: this._consecutiveDupSuppressions,
                    callLevelCount: this._callLevelDupCount
                });

                // Sprint 3.2: If call-level dups reach threshold, go permanently silent
                if (this._callLevelDupCount >= 6) {
                    this._permanentDupFallback = true;
                    this._consecutiveDupSuppressions = 0;
                    this._retryResponseCreateOnDone = false;
                    this._retryResponseCreateOnDoneOwner = null;
                    this._deferredTextResponse = null;
                    this._deferredTextResponseOwner = null;
                    this._deferredUserInputQueue = [];
                    log('warn', this.callSID, 'response_loop_permanent_fallback', {
                        callLevelCount: this._callLevelDupCount
                    });
                    this.emit('telemetry', 'response_loop_permanent_fallback', {
                        callLevelDupCount: this._callLevelDupCount,
                        callSID: this.callSID
                    });
                    return;
                }

                // Hard circuit breaker: clear all pending queues
                this._deferredTextResponse = null;
                this._deferredTextResponseOwner = null;
                this._deferredUserInputQueue = [];
                // Sprint 3.2d: Clear retry flag to prevent _handleResponseDone from firing another response.create
                this._retryResponseCreateOnDone = false;
                this._retryResponseCreateOnDoneOwner = null;
                // Log64 P3b: Clear timeout flag so _handleResponseDone doesn't
                // also send a fallback — circuit breaker owns recovery now.
                if (this._responseTimeoutActive) {
                    this._responseTimeoutActive = false;
                    if (this._responseTimeoutGuard) { clearTimeout(this._responseTimeoutGuard); this._responseTimeoutGuard = null; }
                }
                if (this._sendBookingRecoveryResponse('duplicate_circuit_breaker_booking_recovery', responseOwner, {
                    consecutiveCount: this._consecutiveDupSuppressions,
                    callLevelCount: this._callLevelDupCount
                })) {
                    this._consecutiveDupSuppressions = 0;
                    return;
                }
                // Use phase-appropriate scripted fallback (same as hallucination handler)
                const fallback = getHallucinationFallback(this.conversationPhase, this.name, this.persona, this._buildGuardrailFallbackContext());
                if (this._shouldDropStaleRecoveryOwner(responseOwner, 'duplicate_circuit_breaker_fallback')) {
                    this._skipDupCheckForNextResponse = false;
                    this._skipDupCheckForNextResponseOwner = null;
                    return;
                }
                this.addConversationContext('AI', fallback);
                this._consecutiveDupSuppressions = 0;
                // Sprint 3.2c: Skip dup check for the fallback response itself
                this._skipDupCheckForNextResponse = true;
                this._skipDupCheckForNextResponseOwner = responseOwner;
                this._scriptedResponsePending = true;
                this._sendRecoveryResponseCreate({
                    instructions: `Say ONLY these exact words, then stop: "${fallback}"`,
                    conversation: 'none',
                    input: []
                }, 'duplicate_circuit_breaker_fallback', responseOwner);
                return;
            }
            // Mild correction (< 3 dups): still use conversation:'none' to avoid history regen
            // Sprint 6E.3: Cap increment moved above (before circuit breaker check)
            // Log64 P3: Clear deferred text so _handleResponseDone doesn't drain
            // a queued silence nudge that would collide with this correction.
            this._deferredTextResponse = null;
            this._deferredTextResponseOwner = null;
            // Log76 fix: Build phase-aware correction with recent context so the
            // model knows what phase we're in, what the user just said, and what
            // responses to avoid — prevents off-topic corrections.
            const correction = this._buildDupCorrectionPrompt();
            this._sendRecoveryResponseCreate({
                instructions: correction,
                conversation: 'none',
                input: []
            }, 'duplicate_correction', responseOwner);
            return;
        }

        this._consecutiveDupSuppressions = 0;
        log('info', this.callSID, 'ai_response', { transcript: processedAiText });

        // Sprint 6E.1: Repetition guard reads from _recentAiResponses (managed by
        // _isResponseDuplicate, cap 10). No push here — avoids double-push that
        // halved the effective dedup window from 10 unique to 5.
        if (this._recentAiResponses && this._recentAiResponses.length >= 3) {
            const recent = this._recentAiResponses.slice(-3);
            const _jaccard = (a, b) => {
                const sa = new Set(a.toLowerCase().split(/\s+/));
                const sb = new Set(b.toLowerCase().split(/\s+/));
                let inter = 0;
                for (const w of sa) if (sb.has(w)) inter++;
                const union = sa.size + sb.size - inter;
                return union === 0 ? 0 : inter / union;
            };
            const [r0, r1, r2] = recent;
            if (_jaccard(r0, r1) > 0.6 && _jaccard(r1, r2) > 0.6 && _jaccard(r0, r2) > 0.6) {
                this._repetitionHintPending = true;
                log('warn', this.callSID, 'repetition_guard_triggered', { similarity: 'all_pairs>0.6' });
            }
        }

        // Sprint 5B.7: Track AI responses without user speech for voicemail inference
        this._aiResponsesSinceUserSpeech = (this._aiResponsesSinceUserSpeech || 0) + 1;

        this.addConversationContext('AI', processedAiText);
        this.extractEntities(processedAiText, 'AI');
        this._updatePhase();
        this._addContextWords(processedAiText);

        // ── Language drift detection ─────────────────────────────────
        this._checkLanguageDrift(processedAiText);

        // ── Sprint 5B.7: No-speech voicemail inference ──────────────
        // If 3+ AI responses with zero user speech, likely voicemail/dead-air
        if (this._aiResponsesSinceUserSpeech >= 3 && this.count === 0
            && this.conversationPhase !== 'voicemail') {
            log('info', this.callSID, 'voicemail_suspected_no_speech', {
                aiTurns: this._aiResponsesSinceUserSpeech
            });
            telemetry.emit('voicemail_suspected', {
                callId: this.callSID,
                aiTurns: this._aiResponsesSinceUserSpeech,
                ts: Date.now()
            });
            this._updatePhase({ isVoicemail: true });
            const vmMsg = this.persona?.voicemail?.message?.(this.name)
                ?? `Hi, this is ${this.persona?.name || 'a representative'} from ${this.persona?.company || 'our company'}. We will follow up by email. Have a great day.`;
            this.sendTextResponse(vmMsg);
            const vmEpoch = this.count;
            setTimeout(() => {
                if (this.count === vmEpoch && this.isConnected) {
                    log('info', this.callSID, 'voicemail_no_speech_disconnect');
                    this.close();
                }
            }, 6000);
            return;
        }

        this.emit('ai_transcript', processedAiText);
        insertConversation(this.callSID, this.recipient, 'bot', processedAiText)
            .catch(err => log('error', this.callSID, 'insert_conversation_error', { role: 'bot', message: err.message }));

        // ── Hangup analysis ──────────────────────────────────────────
        const phaseAllowsAnalysis = !['voicemail', 'rejected', 'success', 'screening', 'opening'].includes(this.conversationPhase);
        const shouldAnalyze = phaseAllowsAnalysis && shouldPerformAnalysis(this.count, this.userEmail !== null);
        if (shouldAnalyze) {
            log('info', this.callSID, 'hangup_analysis_start', { turn: this.count });
            const stt = this.lang?.sttLocale || 'en-US';
            const langKey = stt.startsWith('de') ? 'german' : stt.startsWith('hi') ? 'hindi' : 'english';
            const quickDecision = quickHangupDecision(this.conversationContext, this.count, langKey);
            const callType = this.persona?.flow?.callType || 'event';

            if (quickDecision && quickDecision.confidence > 0.8) {
                const normalizedQuickDecision = this._normalizeHangupDecisionForPhase(quickDecision, 'quick_hangup');
                log('info', this.callSID, 'hangup_quick_decision', { decision: normalizedQuickDecision });
                this._lastHangupDecision = normalizedQuickDecision;
                this._lastHangupDecisionTs = Date.now();
                this._applyDecisionEmail(normalizedQuickDecision.userEmail, 'quick_hangup');
                const quickEmailConfirmed = normalizedQuickDecision.reason === 'success' && !!this.userEmail && !this.emailPendingConfirmation;
                if (quickEmailConfirmed) {
                    this.emailConfirmed = true;
                    this._requestBookingLink('quick_hangup_success');
                }
                this._updatePhase({
                    isVoicemail: normalizedQuickDecision.reason === 'voicemail' || normalizedQuickDecision.reason === 'voicemail_greeting',
                    isRejected: normalizedQuickDecision.reason === 'rejected',
                    emailConfirmed: quickEmailConfirmed,
                    isSuccess: quickEmailConfirmed,
                });
                this.emit('decision', normalizedQuickDecision);
            } else {
                const myTurn = this.turnStateRef ? this.turnStateRef.currentTurnId : null;
                const capturedContext = [...this.conversationContext];
                const capturedName    = this.name;
                const capturedCount   = this.count;
                // Log76 fix: Timeout guard — prevents orphaned promises when call
                // disconnects before the hangup LLM returns. 8s covers 1 retry
                // with backoff while cutting off before the 2nd retry.
                const HANGUP_LLM_TIMEOUT_MS = 8000;
                const callSIDRef = this.callSID;
                ;(async () => {
                    let decision;
                    let timeoutHandle;
                    try {
                        decision = await Promise.race([
                            analyzeConversationForHangup(capturedName, capturedCount, capturedContext, callType),
                            new Promise((_, reject) => {
                                timeoutHandle = setTimeout(() => reject(new Error('hangup_analysis_timeout')), HANGUP_LLM_TIMEOUT_MS);
                            })
                        ]);
                        clearTimeout(timeoutHandle);
                    } catch (err) {
                        clearTimeout(timeoutHandle);
                        if (err.message === 'hangup_analysis_timeout') {
                            log('warn', callSIDRef, 'hangup_analysis_timeout', { turn: capturedCount, timeoutMs: HANGUP_LLM_TIMEOUT_MS });
                            return;
                        }
                        throw err;
                    }
                    if (this.turnStateRef) {
                        if (this.turnStateRef.isClosed) return;
                        if (myTurn !== this.turnStateRef.currentTurnId) return;
                    }
                    if (decision.shouldHangup && this._deferredUserInputQueue.length > 0) {
                        log('info', this.callSID, 'hangup_suppressed', {
                            reason: 'deferred_user_input_pending',
                            originalReason: decision.reason,
                            queueLen: this._deferredUserInputQueue.length,
                        });
                        decision.shouldHangup = false;
                        decision.reason = 'suppressed_pending_input';
                    }
                    decision = this._normalizeHangupDecisionForPhase(decision, 'llm_hangup');
                    log('info', this.callSID, 'hangup_llm_decision', { decision });
                    this._lastHangupDecision = decision;
                    this._lastHangupDecisionTs = Date.now();
                    this._applyDecisionEmail(decision.userEmail, 'llm_hangup');
                    const decisionEmailConfirmed = !!(decision.emailConfirmed || decision.contactConfirmed) && !!this.userEmail && !this.emailPendingConfirmation;
                    if (decisionEmailConfirmed) {
                        this.emailConfirmed = true;
                        this._requestBookingLink('llm_hangup_success');
                    }
                    this._updatePhase({
                        isVoicemail: decision.isVoicemail,
                        isRejected: decision.reason === 'rejected',
                        emailConfirmed: decisionEmailConfirmed,
                        isSuccess: decision.reason === 'success' && decisionEmailConfirmed,
                    });
                    this.emit('decision', decision);
                })().catch(err => log('error', this.callSID, 'hangup_analysis_error', { message: err.message }));
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // RESPONSE LIFECYCLE
    // ═══════════════════════════════════════════════════════════════════════

    _handleResponseCreated(message) {
        this._firstDeltaLogged = false;
        this._phaseAtResponseStart = this.conversationPhase;
        this._currentResponsePurpose = this._pendingResponsePurpose || null;
        this._pendingResponsePurpose = null;
        this._currentResponseOwner = this._lastResponseCreateOwner || this._captureResponseOwner('response_created');
        this._silenceNudgeComplianceCancelledForResponse = null;
        if (this._pendingExpectedPhrase) {
            this._expectedNudgePhrase = this._pendingExpectedPhrase;
            this._pendingExpectedPhrase = null;
        }
        if (this._enableAudioPlaybackTracking) {
            this._firstAudioTs             = null;
            this._totalAudioDurationMs     = 0;
            this._audioPlaybackEndEstimate = 0;
        }
        if (this._enableSilenceTimers) this._clearSilencePromptTimers();
        this.isResponding = true;
        this._currentResponseId = null;  // reset; will be set on first audio.delta
        this._currentResponseItemId = null;  // reset; will be set on first audio.delta
        this._truncateAudioEndMs = 0;        // reset cumulative audio for truncation tracking
        if (this.vadMode === 'none') {
            if (this.silenceCommitTimer) {
                clearTimeout(this.silenceCommitTimer);
                this.silenceCommitTimer = null;
            }
            this.pendingAudioSinceCommit = false;
        }
        // Fix 6a: Do NOT clear response timeout here — keep it running until
        // first response.audio.delta proves the API is actually producing output.
        // Previously this killed the safety net too early, leaving a gap where
        // the API could hang between response.created and first audio.delta.
        log('info', this.callSID, 'response_created', { ts: Date.now() });
        this.emit('response_created');
        this.emit('response.created');
    }

    _handleResponseDone(message) {
        this.isResponding      = false;
        this._lastResponseDoneTime = Date.now(); // Log65 P6: for barge-in recovery guard
        const completedResponseOwner = this._currentResponseOwner;
        this._firstDeltaLogged = false;
        this._currentResponseId = null;
        this._currentResponseItemId = null;
        this._currentResponseOwner = null;
        this._truncateAudioEndMs = 0;
        this._lastAutoResponseTs = null;  // clear stale timestamp to prevent cross-turn matching
        this._clearResponseTimeout();

        // Fix 6c+6d: If this response.done is from a timeout-triggered cancel,
        // skip all deferred queue drains — the timeout owns recovery. Draining
        // queues here would race with the timeout fallback and potentially
        // re-trigger the same failing prompt that caused the empty response.
        const responseStatus = message.response?.status;
        if (this._responseTimeoutActive) {
            this._responseTimeoutActive = false;
            if (this._responseTimeoutGuard) {
                clearTimeout(this._responseTimeoutGuard);
                this._responseTimeoutGuard = null;
            }
            log('info', this.callSID, 'response_done_after_timeout', {
                status: responseStatus, ts: Date.now()
            });
            const timeoutOwner = this._responseTimeoutOwner || completedResponseOwner;
            this._responseTimeoutOwner = null;
            if (this._shouldDropStaleRecoveryOwner(timeoutOwner, 'response_timeout_fallback')) return;
            const fallback = this.lang?.sttLocale?.startsWith('de')
                ? 'Ich bin noch da \u2014 k\u00f6nnten Sie das bitte nochmal sagen? Ich m\u00f6chte sicherstellen, dass ich Ihnen richtig helfe.'
                : 'Still here \u2014 could you say that again? Want to make sure I help you properly.';
            this.sendTextResponse(fallback);
            return;
        }

        // Fix 10: Retry a response.create that was rejected because the server
        // was still processing a previous cancelled response. Now that
        // response.done has fired, the server is ready for a new response.
        if (this._retryResponseCreateOnDone) {
            this._retryResponseCreateOnDone = false;
            const retryOwner = this._retryResponseCreateOnDoneOwner || this._lastResponseCreateOwner;
            this._retryResponseCreateOnDoneOwner = null;
            if (this._shouldDropStaleRecoveryOwner(retryOwner, 'response_create_retry_after_done')) return;
            log('info', this.callSID, 'response_create_retry_after_done', { ts: Date.now() });
            // Re-send with the same per-response overrides (instructions, temperature, etc.)
            // that were in the rejected response.create. Without this, the model falls back
            // to session-level greeting instructions and produces disconnected responses.
            const retryOpts = this._lastResponseCreateOpts || {};
            this.send(this._buildOwnedResponseCreate(retryOpts, retryOwner));
            return;
        }

        // Fix 11: Early dup cancel produces response.done with status 'cancelled'.
        // Skip drain so the deferred correction doesn't restart the dup loop.
        if (this._earlyDupCancelled && responseStatus === 'cancelled') {
            const wasSilenceNudge = this._silenceNudgeCancelledNoRepair === true;
            this._earlyDupCancelled = false;
            this._silenceNudgeCancelledNoRepair = false;
            this._currentResponsePurpose = null;
            log('info', this.callSID, 'response_done_early_dup_cancelled_skip_drain', { ts: Date.now() });
            if (wasSilenceNudge) {
                log('info', this.callSID, 'duplicate_nudge_suppressed_no_repair', { ts: Date.now() });
            }
            // fall through to usage/token tracking below
        } else

        // Fix 6d: For failed/incomplete responses (not timeout-triggered),
        // skip queue drains to avoid replaying a prompt the API rejected.
        if (responseStatus === 'failed' || responseStatus === 'incomplete') {
            log('warn', this.callSID, 'response_done_failed', {
                status: responseStatus,
                statusDetails: message.response?.status_details,
                ts: Date.now()
            });
            // Greeting TTS retry: if the greeting never produced audio, retry once
            if (!this._greetingDelivered && !this._greetingRetried) {
                this._greetingRetried = true;
                log('info', this.callSID, 'greeting_tts_retry', {
                    error: message.response?.status_details?.error?.code,
                    ts: Date.now()
                });
                this.send(this._buildOwnedResponseCreate({}, completedResponseOwner));
            }
            // Still process usage/token tracking below, just skip queue drains
        } else {

        if (this._deferredTextResponse) {
            const pending = this._deferredTextResponse;
            const pendingOwner = this._deferredTextResponseOwner;
            this._deferredTextResponse = null;
            this._deferredTextResponseOwner = null;
            if (!this._shouldDropStaleRecoveryOwner(pendingOwner, 'deferred_text_response_drain')) {
                this.sendTextResponse(pending);
                return;  // process queued user inputs on the NEXT response_done cycle
            }
        }

        if (this._deferredUserInputQueue.length > 0) {
            // Guard: a racing server-VAD response.created can re-set isResponding
            if (this.isResponding) {
                log('info', this.callSID, 'deferred_user_input_cancel_first', {
                    remaining: this._deferredUserInputQueue.length
                });
                this.send({ type: 'response.cancel' });
                this.isResponding = false;
            }
            // Collapse all queued inputs into ONE response — prevents serial
            // drain where each "hello" gets its own full AI response played
            // back-to-back (the "repeated responses" bug).
            // Take the LAST input as primary (most recent user intent),
            // use highest decision level from all queued items.
            const allQueued = this._deferredUserInputQueue.splice(0);
            const activeQueued = allQueued.filter((item) => {
                const owner = item.owner || null;
                return !this._shouldDropStaleRecoveryOwner(owner, 'deferred_user_input_drain', {
                    queryPreview: String(item.userQuestion || '').substring(0, 80)
                });
            });
            if (activeQueued.length === 0) return;
            const decisionPriority = { high: 3, medium: 2, low: 1 };
            let bestDecision = 'low';
            for (const item of activeQueued) {
                if ((decisionPriority[item.decision] || 0) > (decisionPriority[bestDecision] || 0)) {
                    bestDecision = item.decision;
                }
            }
            const lastItem = activeQueued[activeQueued.length - 1];
            log('info', this.callSID, 'deferred_user_input_collapsed', {
                query: lastItem.userQuestion.substring(0, 80),
                collapsed: activeQueued.length,
                dropped: allQueued.length - activeQueued.length,
                decision: bestDecision
            });
            this.insertUpdatedPrompt(lastItem.userQuestion, bestDecision);
        }

        } // end status gate (Fix 6d)

        const doneConvId = message.response?.conversation_id;
        if (doneConvId && !this.conversationId) this.conversationId = doneConvId;

        const usage = message.response?.usage;
        if (usage) {
            this.totalInputTokens  = (this.totalInputTokens  || 0) + (usage.input_tokens  || 0);
            this.totalOutputTokens = (this.totalOutputTokens || 0) + (usage.output_tokens || 0);
            const inputDetails  = usage.input_token_details  || {};
            const outputDetails = usage.output_token_details || {};
            log('info', this.callSID, 'response_done', {
                conversationId: this.conversationId,
                input_tokens: usage.input_tokens || 0,
                output_tokens: usage.output_tokens || 0,
                cached_tokens: inputDetails.cached_tokens || 0,
                input_audio_tokens: inputDetails.audio_tokens || 0,
                input_text_tokens: inputDetails.text_tokens || 0,
                output_audio_tokens: outputDetails.audio_tokens || 0,
                output_text_tokens: outputDetails.text_tokens || 0,
                cumulative_input: this.totalInputTokens,
                cumulative_output: this.totalOutputTokens
            });
            telemetry.emit('realtime_usage', {
                callSID: this.callSID, conversationId: this.conversationId,
                provider: this.providerName,
                input_tokens: usage.input_tokens || 0,
                output_tokens: usage.output_tokens || 0,
                cached_tokens: inputDetails.cached_tokens || 0,
                input_audio_tokens: inputDetails.audio_tokens || 0,
                input_text_tokens: inputDetails.text_tokens || 0,
                output_audio_tokens: outputDetails.audio_tokens || 0,
                output_text_tokens: outputDetails.text_tokens || 0,
                cumulative_input: this.totalInputTokens,
                cumulative_output: this.totalOutputTokens,
                timestamp: Date.now()
            });

            const totalTokens = (this.totalInputTokens || 0) + (this.totalOutputTokens || 0);
            if (!this._tokenBudgetExceeded && this.maxTotalTokenBudget > 0 && totalTokens > this.maxTotalTokenBudget) {
                this._tokenBudgetExceeded = true;
                log('warn', this.callSID, 'token_budget_exceeded', {
                    totalTokens,
                    budget: this.maxTotalTokenBudget
                });
                telemetry.emit('token_budget_exceeded', {
                    callSID: this.callSID,
                    provider: this.providerName,
                    totalTokens,
                    budget: this.maxTotalTokenBudget,
                    timestamp: Date.now()
                });
                this.close();
                return;
            }
        } else {
            log('info', this.callSID, 'response_done', { conversationId: this.conversationId });
        }
    }

    _handleRateLimitsUpdated(message) {
        const limits = Array.isArray(message.rate_limits) ? message.rate_limits : [];
        if (limits.length === 0) {
            log('debug', this.callSID, 'rate_limits_updated');
            return;
        }

        let backoffSeconds = 0;
        for (const limit of limits) {
            const remaining = Number(limit?.remaining);
            const resetSeconds = Number(limit?.reset_seconds || limit?.resetSeconds || 0);
            if (Number.isFinite(remaining) && remaining <= 2 && Number.isFinite(resetSeconds) && resetSeconds > backoffSeconds) {
                backoffSeconds = resetSeconds;
            }
        }

        if (backoffSeconds > 0) {
            this._rateLimitBackoffUntil = Date.now() + (backoffSeconds * 1000);
            telemetry.emit('realtime_rate_limit_backoff', {
                callSID: this.callSID,
                provider: this.providerName,
                backoffSeconds,
                timestamp: Date.now()
            });
            log('warn', this.callSID, 'rate_limits_updated_backoff', { backoffSeconds });
        } else {
            log('debug', this.callSID, 'rate_limits_updated', {
                count: limits.length
            });
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // SEND TEXT RESPONSE
    // ═══════════════════════════════════════════════════════════════════════

    sendTextResponse(text) {
        if (!this.isConnected) return;
        const isSilenceNudge = this._isSilenceNudgeText(text);
        if (this.isResponding) {
            const payload = { reason: 'isResponding', text: text.substring(0, 80) };
            if (isSilenceNudge) payload.status = this._getSilenceStatus();
            log('info', this.callSID, 'text_response_queued', payload);
            this._deferredTextResponse = text;
            this._deferredTextResponseOwner = this._captureResponseOwner('deferred_text_response');
            return;
        }

        let fullInstruction;
        if (this.lang && typeof this.lang.buildTurnPrompt === 'function') {
            const conversationContext = this.formatConversationContext();
            try {
                fullInstruction = this.lang.buildTurnPrompt({
                    count: this.count,
                    name: this.name,
                    userQuestion: text,
                    userEmail: this.userEmail,
                    preferredSlot: this.preferredSlot,
                    conversationContext,
                    relevantKnowledge: '',
                    hasAskedForConsultation: this.hasAskedForConsultation,
                    conversationPhase: this.conversationPhase,
                    toneDirective: null,
                    decision: 'high'
                });
            } catch (_) {
                fullInstruction = (typeof this.lang.baseInstruction === 'function')
                    ? `${this.lang.baseInstruction()}\n\n${text}`
                    : text;
            }
        } else if (this.lang && typeof this.lang.baseInstruction === 'function') {
            fullInstruction = `${this.lang.baseInstruction()}\n\n${text}`;
        } else {
            fullInstruction = text;
        }

        log('info', this.callSID, 'text_response_sent', { text: text.substring(0, 80) });

        // Silence nudges bypass buildTurnPrompt
        if (isSilenceNudge) {
            const match = text.match(/(?:ONLY|EXACTLY|NUR|EXAKT):\s*'([^']+)'/);
            const phrase = match ? match[1] : text.replace(/<\/?silence-(?:nudge|goodbye)>/g, '').trim();
            const purpose = text.startsWith('SILENCE GOODBYE') || text.startsWith('STILLE VERABSCHIEDUNG') || text.startsWith('<silence-goodbye>')
                ? 'silence_goodbye'
                : 'silence_nudge';
            this._sendSilenceResponse(phrase, purpose);
            return;
        }

        this.send(this._buildResponseCreate({
            input: [{
                type: 'message', role: 'system',
                content: [{ type: 'input_text', text: fullInstruction }]
            }]
        }));
    }

    cancelResponse() {
        if (!this.isConnected) return;
        if (!this.isResponding) return;
        log('info', this.callSID, 'response_cancel_sent');
        this.send({ type: 'response.cancel' });
        this.isResponding = false;
        this._clearResponseTimeout();
    }

    // ═══════════════════════════════════════════════════════════════════════
    // INSERT UPDATED PROMPT
    // ═══════════════════════════════════════════════════════════════════════

    insertUpdatedPrompt(userQuestion, decision = "high") {
        this.conversationEngine.insertUpdatedPrompt(userQuestion, decision);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ENTITY EXTRACTION
    // ═══════════════════════════════════════════════════════════════════════

    // Sprint 5B.1: Normalize spoken email tokens before regex extraction
    _normalizeSpokenEmail(text) {
        let t = String(text || '');
        t = t.replace(/\bd\s+o\s+t\b/gi, 'dot');
        t = t.replace(/\ba\s+t\b/gi, 'at');
        t = t.replace(/\bunder\s+score\b/gi, 'underscore');
        t = t.replace(/\bfull\s+stop\b/gi, 'dot');
        const normalizer = this && typeof this._collapseSpokenEmailLetterRuns === 'function'
            ? this
            : BaseRealtimeAdapter.prototype;
        t = normalizer._collapseSpokenEmailLetterRuns(t);
        t = t.replace(/\b(?:dot|period)\b/gi, '.');
        t = t.replace(/\b(?:underscore)\b/gi, '_');
        t = t.replace(/\b(?:dash|hyphen)\b/gi, '-');
        t = t.replace(/\bplus\b/gi, '+');
        t = t.replace(/\s*([._+\-])\s*/g, '$1');
        t = t.replace(/\b([A-Za-z0-9.!#$%&*+/=?^_{|}~.-]+)\s+at\s+([A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z0-9.-]+)\b/gi, '$1@$2');
        t = t.replace(/\s*@\s*/g, '@');
        return t;
    }

    _collapseSpokenEmailLetterRuns(text) {
        const letterTokens = [
            'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel',
            'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa',
            'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor', 'whiskey',
            'xray', 'x-ray', 'yankee', 'zulu', '[a-z0-9]'
        ];
        const run = new RegExp(`\\b(?:${letterTokens.join('|')})(?:\\s+(?:${letterTokens.join('|')})){1,}\\b`, 'gi');
        return String(text || '').replace(run, (match) => {
            const chars = match.split(/\s+/).map(token => this._spokenEmailLetterToChar(token));
            return chars.every(Boolean) ? chars.join('') : match;
        });
    }

    _spokenEmailLetterToChar(token) {
        const value = String(token || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        if (/^[a-z0-9]$/.test(value)) return value;
        const nato = {
            alpha: 'a', bravo: 'b', charlie: 'c', delta: 'd', echo: 'e', foxtrot: 'f',
            golf: 'g', hotel: 'h', india: 'i', juliet: 'j', kilo: 'k', lima: 'l',
            mike: 'm', november: 'n', oscar: 'o', papa: 'p', quebec: 'q', romeo: 'r',
            sierra: 's', tango: 't', uniform: 'u', victor: 'v', whiskey: 'w', xray: 'x',
            yankee: 'y', zulu: 'z'
        };
        return nato[value] || null;
    }

    _extractPracticalEmail(text) {
        const matches = String(text || '').match(/[A-Za-z0-9.!#$%&*+/=?^_{|}~.-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+/g) || [];
        const match = matches.find(candidate => this._isPracticalEmail(candidate));
        return match ? match.toLowerCase() : null;
    }

    _isPracticalEmail(email) {
        const value = String(email || '').trim();
        if (!value || value.length > 254) return false;
        if (/[\s\u0000\r\n"'`]/.test(value)) return false;
        const parts = value.split('@');
        if (parts.length !== 2) return false;
        const [local, domain] = parts;
        if (!local || local.length > 63 || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
        if (!domain || domain.length > 253 || !domain.includes('.')) return false;
        const labels = domain.split('.');
        if (labels.some(label => !label || label.length > 63 || label.startsWith('-') || label.endsWith('-') || !/^[A-Za-z0-9-]+$/.test(label))) {
            return false;
        }
        return /^[A-Za-z]{2,}$/.test(labels[labels.length - 1]);
    }

    _captureUserEmail(email, provenance = 'voice_regex') {
        const normalizedEmail = this._extractPracticalEmail(email) || String(email || '').trim().toLowerCase();
        if (!this._isPracticalEmail(normalizedEmail)) return false;
        if (this.userEmail && this.userEmail !== normalizedEmail) {
            log('info', this.callSID, 'email_corrected', { old: this.userEmail, new: normalizedEmail });
        }
        this.userEmail = normalizedEmail;
        this.userEmailProvenance = provenance;
        this.emailPendingConfirmation = true;
        this.emailConfirmed = false;
        log('info', this.callSID, 'email_extracted', { email: this.userEmail });
        telemetry.emit('email_extracted', { callId: this.callSID, email: this.userEmail, phase: this.conversationPhase, ts: Date.now() });
        return true;
    }

    _applyDecisionEmail(candidate, provenance = 'llm_hangup') {
        const email = this._extractPracticalEmail(candidate);
        if (!email) return false;
        if (this.userEmail && this.userEmail !== email && (this.emailPendingConfirmation || this.emailConfirmed || /^voice_/.test(String(this.userEmailProvenance || '')))) {
            log('info', this.callSID, 'decision_email_ignored', {
                reason: 'deterministic_email_present',
                existingEmail: this.userEmail,
                candidateEmail: email,
                provenance: this.userEmailProvenance
            });
            return false;
        }
        if (!this.userEmail) {
            this.userEmail = email;
            this.userEmailProvenance = provenance;
            this.emailPendingConfirmation = false;
            this.emailConfirmed = false;
        }
        return true;
    }

    _classifyEmailVerificationIntent(rawText, normalizedEmailText) {
        const correctedEmail = this._extractPracticalEmail(normalizedEmailText);
        if (correctedEmail) return { type: 'corrected_email', email: correctedEmail };

        const text = this._normalizeGuardText(rawText);
        if (!text) return { type: 'ambiguous' };

        const idiomaticNo = /\bno\s+(problem|worries|issue)\b/i.test(text);
        const standaloneNo = /^(no|nope|nah|nein)$/i.test(text);
        const explicitRejection = /\b(wrong|incorrect|not\s+correct|not\s+right|that\s+is\s+wrong|thats\s+wrong|falsch|nicht\s+richtig|stimmt\s+nicht)\b/i.test(text);
        const noWithNegativeCue = /^(no|nope|nah)\b/i.test(text) && !idiomaticNo && /\b(wrong|incorrect|not|falsch)\b/i.test(text);
        if (standaloneNo || explicitRejection || noWithNegativeCue) return { type: 'rejected' };

        const confirmed = /\b(yes|yeah|yep|correct|right|that\s+is\s+right|thats\s+right|that\s+is\s+correct|thats\s+correct|perfect|exactly|sure|ja|stimmt|richtig|genau|korrekt|perfekt)\b/i.test(text);
        if (confirmed) return { type: 'confirmed' };

        if (/@|\bat\b/i.test(String(rawText || ''))) return { type: 'invalid_email' };
        return { type: 'ambiguous' };
    }

    _hasDeliverableBookingPhoneTarget() {
        const target = this.bookingPhoneDeliveryTargetSource === 'spoken_confirmed'
            ? this.userPhone
            : this.recipient || this.userPhone;
        return String(target || '').replace(/[^\d]/g, '').length >= 7;
    }

    _hasBookingContactContext() {
        return !!(this.hasAskedForConsultation
            || this.offerAccepted
            || this._bookingIntentDetected
            || this._bookingActionThisTurn
            || this.bookingPhoneDeliveryConsent
            || this.bookingLinkRequested
            || this.bookingLinkSent
            || ['offer', 'slot-collection', 'email-collection', 'email-verify', 'confirmation'].includes(this.conversationPhase));
    }

    _isPhoneDeliveryConsentPrompt(text) {
        const normalized = this._normalizeGuardText(text);
        if (!normalized) return false;
        return /\b(should|shall|can)\s+i\s+(text|send|share)\s+(you\s+)?(it|that|this|the\s+booking\s+link|the\s+link)\s+(to\s+)?(this|that|same|your)?\s*(number|phone|mobile|cell|there)\b/i.test(normalized)
            || /\bi\s+can\s+(text|send|share)\s+(you\s+)?(the\s+)?(booking\s+)?link\b.*\b(this\s+number|your\s+number|same\s+number|sms|text|phone|mobile|there)\b/i.test(normalized)
            || /\btext\s+(the\s+)?booking\s+link\s+to\s+this\s+number\b/i.test(normalized);
    }

    _markPendingPhoneDeliveryConsentFromAssistantText(text, source = 'assistant_response') {
        if (!this._hasBookingContactContext()) return false;
        if (!this._hasDeliverableBookingPhoneTarget()) return false;
        if (!this._isPhoneDeliveryConsentPrompt(text)) return false;
        this._pendingPhoneDeliveryConsentContext = {
            phase: this.conversationPhase,
            source,
            ts: Date.now(),
            promptSummary: summarizeTextForLog(text)
        };
        telemetry.emit('booking_phone_consent_context_set', {
            callId: this.callSID,
            phase: this.conversationPhase,
            source,
            ts: this._pendingPhoneDeliveryConsentContext.ts
        });
        return true;
    }

    _clearPendingPhoneDeliveryConsentContext(reason = 'cleared') {
        if (!this._pendingPhoneDeliveryConsentContext) return;
        this._pendingPhoneDeliveryConsentContext = null;
        telemetry.emit('booking_phone_consent_context_cleared', {
            callId: this.callSID,
            phase: this.conversationPhase,
            reason,
            ts: Date.now()
        });
    }

    _hasPendingPhoneDeliveryConsentContext() {
        const context = this._pendingPhoneDeliveryConsentContext;
        if (!context) return false;
        const configuredTtl = Number(process.env.BOOKING_PHONE_CONSENT_CONTEXT_TTL_MS);
        const ttlMs = Number.isFinite(configuredTtl) && configuredTtl > 0 ? configuredTtl : 90000;
        if (Date.now() - context.ts > ttlMs) {
            this._clearPendingPhoneDeliveryConsentContext('expired');
            return false;
        }
        return this._hasBookingContactContext() && this._hasDeliverableBookingPhoneTarget();
    }

    _isBarePhoneDeliveryAffirmation(text) {
        const normalized = this._normalizeGuardText(text);
        if (!normalized || normalized.length > 60) return false;
        if (/\b(what|why|how|where|when|who|price|pricing|rate|cost|weather|joke|hear|repeat|email|mail)\b/i.test(normalized)) return false;
        return /^(yes|yeah|yep|sure|okay|ok|absolutely|definitely|please do|yes please|yeah please|yep please|sure please|ok please|okay please|that works|sounds good|go ahead|send it|text it|send the link|text the link|do that|please send it)$/i.test(normalized);
    }

    _buildBookingRecoveryAction() {
        if (!this._hasBookingContactContext()) return null;
        if (this.bookingLinkSent) {
            return {
                action: 'confirm_link_sent',
                response: 'You are all set. I sent the booking link, so please choose a time that works for you.'
            };
        }
        if (this.bookingLinkRequested) {
            return {
                action: 'confirm_link_requested',
                response: 'Perfect, I have requested the booking link. Please choose a time that works for you once it arrives.'
            };
        }
        if (this.bookingPhoneDeliveryConsent && this._hasDeliverableBookingPhoneTarget()) {
            return {
                action: 'request_phone_booking_link',
                requestReason: 'phone_delivery_consent_recovery',
                response: 'Perfect, I will text the booking link now. Please choose a time that works for you.'
            };
        }
        if (this.userEmail && this.emailConfirmed) {
            return {
                action: 'request_email_booking_link',
                requestReason: 'email_confirmed_recovery',
                response: `Perfect, I will send the booking link to ${this.userEmail}. Please choose a time that works for you.`
            };
        }
        if (this.userEmail && this.emailPendingConfirmation) {
            return {
                action: 'verify_email',
                response: `Just to confirm, I have ${this.userEmail}. Is that correct?`
            };
        }
        if (this._hasDeliverableBookingPhoneTarget()) {
            return {
                action: 'ask_phone_delivery_consent',
                response: this._buildPhaseContractCorrection(this.conversationPhase)
            };
        }
        return null;
    }

    _sendBookingRecoveryResponse(source, owner = null, extra = {}) {
        const action = this._buildBookingRecoveryAction();
        if (!action) return false;
        const responseOwner = owner || this._currentResponseOwner || this._captureResponseOwner(source);
        if (this._shouldDropStaleRecoveryOwner(responseOwner, source, extra)) return false;

        if (action.requestReason) this._requestBookingLink(action.requestReason);
        telemetry.emit('booking_recovery_action_selected', {
            callId: this.callSID,
            phase: this.conversationPhase,
            action: action.action,
            source,
            ts: Date.now()
        });

        this._deferredTextResponse = null;
        this._deferredTextResponseOwner = null;
        this._deferredUserInputQueue = [];
        this._skipDupCheckForNextResponse = true;
        this._skipDupCheckForNextResponseOwner = responseOwner;
        this._scriptedResponsePending = true;
        const sent = this._sendRecoveryResponseCreate({
            instructions: `Say ONLY these exact words, then stop: "${action.response}"`,
            conversation: 'none',
            input: []
        }, source, responseOwner, extra);
        if (sent) this.addConversationContext('AI', action.response);
        return sent;
    }

    _selectBookingHangupNextAction() {
        if (this.bookingLinkSent) return 'continue_booking';
        if (this.bookingLinkRequested && !this.bookingLinkSent) return 'await_booking_link_delivery';
        if ((this.bookingPhoneDeliveryConsent && this._hasDeliverableBookingPhoneTarget())
            || (this.userEmail && this.emailConfirmed)) {
            if (!this.bookingLinkRequested && !this.bookingLinkSent) return 'send_booking_link';
        }
        if (this.userEmail && this.emailPendingConfirmation) return 'verify_email';
        if (!this.userEmail || (!this.emailConfirmed && !this.bookingPhoneDeliveryConsent)) return 'collect_contact';
        return 'continue_booking';
    }

    _normalizeHangupDecisionForPhase(decision, source = 'hangup') {
        if (!decision || typeof decision !== 'object') return decision;
        if (decision.shouldHangup) return decision;
        if (TERMINAL_HANGUP_REASONS.has(String(decision.reason || '').toLowerCase())) return decision;
        if (!BOOKING_HANGUP_PHASES.has(this.conversationPhase) || !this._hasBookingContactContext()) return decision;

        const nextAction = this._selectBookingHangupNextAction();
        if (!nextAction || decision.nextAction === nextAction) return decision;

        telemetry.emit('hangup_next_action_clamped', {
            callId: this.callSID,
            phase: this.conversationPhase,
            source,
            reason: decision.reason || null,
            previousNextAction: summarizeTextForLog(decision.nextAction),
            nextAction,
            ts: Date.now()
        });
        return { ...decision, nextAction };
    }

    _captureBookingPhoneDeliveryConsent(rawText) {
        const text = this._normalizeGuardText(rawText);
        if (!text) return false;
        if (!this._hasBookingContactContext()) {
            this._clearPendingPhoneDeliveryConsentContext('booking_context_lost');
            return false;
        }

        const phoneChannelIntent = /\b(text|sms|message|send|share)\b.*\b(link|it|that|this|details)\b/i.test(text)
            || /\b(send|share)\b.*\b(link|it|that|this|details)\b.*\b(phone|number|mobile|cell|sms|text|whatsapp)\b/i.test(text)
            || /\b(text|sms|whatsapp)\b.*\b(me|my|this|same|number)\b/i.test(text)
            || /\b(schick|senden|sende)\b.*\b(link|terminlink|buchungslink)\b.*\b(handy|nummer|whatsapp|sms)\b/i.test(text);
        const pendingContextActive = this._hasPendingPhoneDeliveryConsentContext();
        const contextualPhoneConsent = !phoneChannelIntent
            && pendingContextActive
            && this._isBarePhoneDeliveryAffirmation(text);
        if (!phoneChannelIntent && !contextualPhoneConsent) {
            if (pendingContextActive) this._clearPendingPhoneDeliveryConsentContext('user_non_affirmation');
            return false;
        }

        const whatsappIntent = /\bwhats\s?app\b/i.test(text);
        this.bookingDeliveryPreference = whatsappIntent ? 'whatsapp' : 'sms';
        this.bookingPhoneDeliveryConsent = true;
        this.bookingPhoneDeliveryConsentTs = Date.now();
        this.bookingPhoneDeliveryTargetSource = this.userPhone && /\d/.test(text) ? 'spoken_confirmed' : 'caller';
        this._markBookingActionThisTurn('phone_delivery_consent');
        this._markBookingIntentDetected('phone_delivery_consent', rawText);
        if (pendingContextActive) this._clearPendingPhoneDeliveryConsentContext('captured');
        telemetry.emit('booking_link_delivery_attempted', {
            callId: this.callSID,
            phase: this.conversationPhase,
            channel: this.bookingDeliveryPreference,
            reason: contextualPhoneConsent ? 'contextual_phone_delivery_consent_captured' : 'phone_delivery_consent_captured',
            ts: this.bookingPhoneDeliveryConsentTs
        });
        return true;
    }

    _requestBookingLink(reason = 'email_confirmed') {
        const canDeliverByEmail = !!(this.userEmail && this.emailConfirmed);
        const canDeliverByPhone = !!(this.bookingPhoneDeliveryConsent && this._hasDeliverableBookingPhoneTarget());
        if (this.bookingLinkRequested || (!canDeliverByEmail && !canDeliverByPhone)) return false;
        const hasBookingContext = this.hasAskedForConsultation
            || this.offerAccepted
            || !!this.preferredSlot
            || this._bookingIntentDetected
            || ['email-verify', 'confirmation', 'success'].includes(this.conversationPhase);
        if (!hasBookingContext) return false;

        this._markBookingIntentDetected(reason, null);
        this.bookingLinkRequested = true;
        this.bookingLinkStatus = 'requested';
        const payload = {
            callId: this.callSID,
            phase: this.conversationPhase,
            reason,
            persona: this.persona?.id || null,
            preferredSlotPresent: !!this.preferredSlot,
            userEmailPresent: !!this.userEmail,
            phoneDeliveryConsented: canDeliverByPhone,
            deliveryPreference: this.bookingDeliveryPreference || (canDeliverByEmail ? 'email' : null),
            ts: Date.now()
        };
        telemetry.emit('booking_link_requested', payload);
        this.emit('booking_link_requested', {
            ...payload,
            userEmail: this.userEmail,
            preferredSlot: this.preferredSlot,
            callerName: this.name,
            callerNumber: this.recipient,
            userPhone: this.userPhone,
            phoneConsent: canDeliverByPhone,
            phoneConsentTargetSource: this.bookingPhoneDeliveryTargetSource,
            deliveryPreference: this.bookingDeliveryPreference,
        });
        return true;
    }

    _isDealerOrderPersona() {
        return this.persona?.id === 'dealer-orders';
    }

    _ensureDealerOrderState() {
        if (!this._isDealerOrderPersona()) return null;
        if (!this.dealerOrder) {
            this.dealerOrder = {
                items: [],
                awaitingConfirmation: false,
                confirmed: false,
                skipped: false,
                orderId: null,
                status: 'open',
                erpStatus: null,
                notificationStatus: null,
                crmContext: parseDealerContextHint(this.callContextHint),
            };
        }
        return this.dealerOrder;
    }

    _hasDealerOrderNumericRecap(state) {
        const hasQuantity = Array.isArray(state?.items)
            && state.items.some(item => Number(item?.quantity) > 0);
        return hasQuantity && typeof state?.lastSummary === 'string' && state.lastSummary.trim().length > 0;
    }

    _isDealerOrderActionInterrupted() {
        return this._bargeInOccurred === true;
    }

    _handleDealerOrderTurn(userText) {
        return handleDealerOrderTurn(this, userText);
    }

    _scheduleDealerOrderClose(delayMs) {
        if (this._dealerOrderCloseTimer) clearTimeout(this._dealerOrderCloseTimer);
        this._dealerOrderCloseTimer = setTimeout(() => {
            this._dealerOrderCloseTimer = null;
            if (this.isConnected && this._isDealerOrderPersona()) this.close();
        }, Math.max(1000, Number(delayMs) || 5000));
        if (typeof this._dealerOrderCloseTimer.unref === 'function') this._dealerOrderCloseTimer.unref();
    }

    _isBookingIntentPhase() {
        return ['opening', 'discovery', 'offer', 'slot-collection', 'email-collection', 'email-verify', 'confirmation', 'success']
            .includes(this.conversationPhase);
    }

    _shouldBypassIntentGateForBookingAction() {
        return !!(this._bookingActionThisTurn && this._isBookingIntentPhase());
    }

    _hasBookingLinkRequestSignal(text) {
        const normalizedText = String(text || '').trim();
        if (!normalizedText) return false;

        return /\b(booking|calendar|appointment|schedule|consultation)\s+link\b/i.test(normalizedText)
            || /\b(send|share|text|sms|email|mail)\b[^.!?]{0,80}\b(booking|calendar|appointment|schedule|consultation)\b[^.!?]{0,80}\blink\b/i.test(normalizedText)
            || /\blink\b[^.!?]{0,80}\b(send|share|text|sms|email|mail)\b/i.test(normalizedText);
    }

    _getBookingIntentReasonFromText(text) {
        if (!this._isBookingIntentPhase()) return null;
        if (this._hasExplicitBookingRequest(text)) return 'explicit_booking_request';
        if (this._hasBookingLinkRequestSignal(text)) return 'booking_link_request_signal';

        if (this.conversationPhase === 'slot-collection') {
            const bookingPatterns = /\b(book|book up|book it|schedule|set up|go ahead|let'?s do it|yes please|buchen|termin)\b/i;
            if (bookingPatterns.test(String(text || ''))) return 'slot_collection_booking_signal';
        }

        return null;
    }

    _markBookingIntentDetected(reason = 'booking_signal', rawText = null) {
        if (this._bookingIntentDetected) return false;
        this._bookingIntentDetected = true;
        const payload = {
            callId: this.callSID,
            phase: this.conversationPhase,
            reason,
            offerAccepted: !!this.offerAccepted,
            hasAskedForConsultation: !!this.hasAskedForConsultation,
            bookingLinkRequested: !!this.bookingLinkRequested,
            ts: Date.now()
        };
        if (rawText) payload.textPreview = String(rawText).substring(0, 120);
        log('info', this.callSID, 'booking_intent_detected', {
            reason,
            phase: this.conversationPhase,
            text: rawText ? String(rawText).substring(0, 120) : undefined
        });
        telemetry.emit('booking_intent_detected', payload);
        return true;
    }

    _markBookingActionThisTurn(reason = 'booking_signal') {
        this._bookingActionThisTurn = true;
        this._bookingActionReasonThisTurn = reason;
    }

    _isQuestionLikeTurn(text) {
        const t = String(text || '').trim();
        if (!t) return false;

        return /[?]/.test(t)
            || /^(what|where|who|why|how|when|which|can|could|would|do|does|did|are|is|have|has)\b/i.test(t)
            || /\b(can|could)\s+you\s+(tell|explain|repeat|share|send|say|hear|help)\b/i.test(t)
            || /\b(tell\s+me|explain\s+this|share\s+(your|the)|what\s+are\s+your|where\s+are\s+you)\b/i.test(t)
            || /\b(joke|can\s+you\s+hear\s+me|are\s+you\s+there|repeat\s+that)\b/i.test(t);
    }

    _hasExplicitBookingRequest(text) {
        const t = String(text || '').trim();
        if (!t) return false;

        return /\b(book|schedule|set\s+up|arrange|reserve)\b[^.!?]{0,80}\b(call|consultation|meeting|appointment|demo|slot|time)\b/i.test(t)
            || /\b(call|consultation|meeting|appointment|demo)\b[^.!?]{0,80}\b(book|scheduled?|set\s+up|arranged?)\b/i.test(t)
            || /\b(book\s+it|schedule\s+it|yes\s+please\s+(book|schedule|set\s+up)|go\s+ahead\s+(and\s+)?(book|schedule|set\s+up)|let'?s\s+do\s+it\s+(and\s+)?(book|schedule|set\s+up))\b/i.test(t);
    }

    _normalizeGuardText(text) {
        return String(text || '')
            .toLowerCase()
            .replace(/[^a-z0-9\u00e0-\u00ff\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    _isSilenceResponsePurpose(purpose) {
        return purpose === 'silence_nudge' || purpose === 'silence_goodbye';
    }

    _isSilenceNudgeText(text) {
        const value = String(text || '');
        return value.startsWith('SILENCE CHECK') || value.startsWith('SILENCE GOODBYE') ||
            value.startsWith('STILLE VERABSCHIEDUNG') || value.startsWith('SILENCE CHECK — ÜBERSCHREIBT') ||
            value.startsWith('<silence-nudge>') || value.startsWith('<silence-goodbye>');
    }

    _getSilenceStatus(now = Date.now()) {
        const playbackRemainingMs = this._enableAudioPlaybackTracking
            ? Math.max(0, (this._audioPlaybackEndEstimate || 0) - now)
            : 0;
        return {
            phase: this.conversationPhase || null,
            turnCount: this.count || 0,
            isResponding: !!this.isResponding,
            isUserSpeaking: !!this.isUserSpeaking,
            hasDeferredTextResponse: !!this._deferredTextResponse,
            hasBargeInRecoveryTimer: !!this._bargeInRecoveryTimer,
            playbackRemainingMs,
            msSinceLastTranscript: this._lastUserTranscriptAt ? now - this._lastUserTranscriptAt : null,
            msSinceSpeechStarted: this._lastSpeechStartedAt ? now - this._lastSpeechStartedAt : null,
            msSinceSpeechStopped: this._speechStoppedAt ? now - this._speechStoppedAt : null,
            msSinceResponseDone: this._lastResponseDoneTime ? now - this._lastResponseDoneTime : null,
            lastInputEnergy: this._lastInputEnergy,
            lastGateLevel: this._lastGateLevel,
            lastGateSendAudio: this._lastGateSendAudio,
            lastGateSilenceFrames: this._lastGateSilenceFrames,
            msSinceGateMetrics: this._lastGateMetricsAt ? now - this._lastGateMetricsAt : null,
            synthesisGateRetries: this._synthesisGateRetries || 0
        };
    }

    _getSilenceSuppressionReason(status) {
        if (!status) return null;
        if (status.isResponding) return 'isResponding';
        if (status.isUserSpeaking) return 'user_speaking';
        if (status.playbackRemainingMs > 0) return 'playback_active';
        if (status.msSinceSpeechStarted != null && status.msSinceSpeechStarted < this.SILENCE_RECENT_SPEECH_START_GRACE_MS) {
            return 'recent_speech_started';
        }
        return this._getRecentInputActivitySuppressionReason(status);
    }

    _getRecentInputActivitySuppressionReason(status) {
        if (!status) return null;
        const hasRecentGateMetrics = status.msSinceGateMetrics == null ||
            status.msSinceGateMetrics <= this.SILENCE_RECENT_GATE_ACTIVITY_MS;
        const hasMeaningfulGateEnergy = status.lastGateLevel === 'MEDIUM' || status.lastGateLevel === 'HIGH' ||
            (typeof status.lastInputEnergy === 'number' && status.lastInputEnergy >= this.SILENCE_RECENT_GATE_ACTIVITY_MIN_ENERGY);
        if (hasRecentGateMetrics && status.lastGateSendAudio === true &&
            typeof status.lastGateSilenceFrames === 'number' &&
            status.lastGateSilenceFrames <= this.SILENCE_RECENT_GATE_FRAMES &&
            hasMeaningfulGateEnergy) {
            return 'recent_gate_activity';
        }
        if (hasRecentGateMetrics && typeof status.lastInputEnergy === 'number' &&
            status.lastInputEnergy >= this.SILENCE_RECENT_INPUT_ENERGY) {
            return status.lastGateSendAudio === false ? 'recent_dropped_input_energy' : 'recent_input_energy';
        }
        return null;
    }

    _getBargeInRecoverySuppressionReason(status) {
        if (!status) return null;
        if (status.isResponding) return 'isResponding';
        if (status.msSinceLastTranscript != null && status.msSinceLastTranscript < this.SILENCE_RECENT_TRANSCRIPT_GRACE_MS) return 'recent_transcript';
        const silenceSuppressionReason = this._getSilenceSuppressionReason(status);
        if (silenceSuppressionReason) return silenceSuppressionReason;
        if (status.msSinceResponseDone != null && status.msSinceResponseDone < 2000) return 'recent_response';
        return null;
    }

    _getBargeInRecoveryHardTimeoutBlockReason(status) {
        if (!status) return null;
        if (status.isResponding) return 'isResponding';
        if (status.playbackRemainingMs > 0) return 'playback_active';
        if (status.msSinceLastTranscript != null && status.msSinceLastTranscript < this.SILENCE_RECENT_TRANSCRIPT_GRACE_MS) return 'recent_transcript';
        if (status.msSinceResponseDone != null && status.msSinceResponseDone < 2000) return 'recent_response';
        return this._getRecentInputActivitySuppressionReason(status);
    }

    _recordSilenceDecision(eventName, source, decision, reason, status, extra = {}) {
        const payload = {
            source,
            decision,
            reason: reason || null,
            ...extra,
            status: status || this._getSilenceStatus()
        };
        log('info', this.callSID, eventName, payload);
        telemetry.emit(eventName, {
            callId: this.callSID,
            provider: this.providerName,
            source,
            decision,
            reason: reason || null,
            ...extra,
            ...(status || {})
        });
    }

    _sendScriptedResponse(phrase, purpose, options = {}) {
        const text = String(phrase || '').trim();
        if (!text) return false;
        const owner = options.owner || this._captureResponseOwner(purpose || 'scripted');
        this._pendingResponsePurpose = purpose || 'scripted';
        this._scriptedResponsePending = true;
        if (options.addToContext) this.addConversationContext('AI', text);
        this.send(this._buildOwnedResponseCreate({
            instructions: `Say ONLY these exact words, then stop: "${text}"`,
            conversation: 'none',
            input: []
        }, owner));
        return true;
    }

    _sendSilenceResponse(phrase, purpose) {
        const text = String(phrase || '').trim();
        if (!text) return false;
        const now = Date.now();
        const normalized = this._normalizeGuardText(text);
        if (purpose === 'silence_nudge'
            && this._lastSilencePhrase === normalized
            && now - this._lastSilencePhraseTs < 90000) {
            log('info', this.callSID, 'duplicate_nudge_suppressed_no_repair', {
                phrase: text.substring(0, 80),
                phraseSummary: summarizeTextForLog(text),
                elapsedMs: now - this._lastSilencePhraseTs
            });
            telemetry.emit('duplicate_nudge_suppressed_no_repair', {
                callId: this.callSID,
                provider: this.providerName,
                elapsedMs: now - this._lastSilencePhraseTs,
                ts: now
            });
            return false;
        }
        this._lastSilencePhrase = normalized;
        this._lastSilencePhraseTs = now;
        this._pendingResponsePurpose = purpose || 'silence_nudge';
        this._pendingExpectedPhrase = text;
        this._isSilenceNudgeResponse = true;
        this._silenceNudgeComplianceCancelledForResponse = null;
        const eventName = purpose === 'silence_goodbye' ? 'silence_goodbye_scripted_sent' : 'silence_nudge_scripted_sent';
        const phraseSummary = summarizeTextForLog(text);
        log('info', this.callSID, eventName, { phrase: text.substring(0, 80), phraseSummary, purpose: purpose || 'silence_nudge' });
        telemetry.emit(eventName, {
            callId: this.callSID,
            provider: this.providerName,
            purpose: purpose || 'silence_nudge',
            phraseHash: phraseSummary.hash,
            phraseLength: phraseSummary.length,
            phraseWordCount: phraseSummary.wordCount,
            ts: now
        });
        const owner = this._captureResponseOwner(purpose || 'silence_nudge');
        this.send(this._buildOwnedResponseCreate({
            instructions: `CRITICAL: Say ONLY these exact words verbatim, nothing else, then stop: "${text}". Do NOT elaborate or add any other words.`,
            conversation: 'none',
            input: []
        }, owner));
        return true;
    }

    _isNudgeTranscriptClearlyOffScript(partialTranscript, expectedPhrase) {
        const actual = this._normalizeGuardText(partialTranscript);
        const expected = this._normalizeGuardText(expectedPhrase);
        if (!actual || !expected || actual.length < 12) return false;
        if (expected.startsWith(actual) || actual.startsWith(expected)) return false;
        const expectedWords = expected.split(/\s+/).filter(Boolean);
        const actualWords = actual.split(/\s+/).filter(Boolean);
        if (expectedWords.length <= 5 && actualWords.length > expectedWords.length * 2) return true;
        const actualPrefix = actualWords.slice(0, Math.min(actualWords.length, expectedWords.length)).join(' ');
        const expectedPrefix = expectedWords.slice(0, Math.min(actualWords.length, expectedWords.length)).join(' ');
        return actualWords.length >= 2 && actualPrefix !== expectedPrefix;
    }

    _getPreviousUserMessage() {
        const history = Array.isArray(this.conversationContext) ? this.conversationContext : [];
        let seenLatest = false;
        for (let i = history.length - 1; i >= 0; i--) {
            if (history[i]?.sender !== 'USER') continue;
            if (!seenLatest) {
                seenLatest = true;
                continue;
            }
            return history[i].message || '';
        }
        return '';
    }

    _buildUnclearSalesClarification(text, confidence) {
        const raw = String(text || '').trim();
        if (!raw) return null;
        if (this.persona?.flow?.callType !== 'sales') return null;
        if (!['discovery', 'offer'].includes(this.conversationPhase)) return null;
        if (this._hasExplicitBookingRequest(raw) || this._isQuestionLikeTurn(raw)) return null;
        if (/\b(no|nope|nah|not\s+interested|stop|bye|goodbye)\b/i.test(raw)) return null;

        const previousUser = this._getPreviousUserMessage();
        const contextText = `${previousUser} ${this._getLatestUserMessage()}`;
        const hasProjectContext = /\b(moodle|shopify|website|platform|app|software|ecommerce|e-commerce|lms|learning\s+management|project)\b/i.test(contextText);
        const hasClearServiceTerm = /\b(moodle|shopify|website|platform|app|software|ecommerce|e-commerce|lms|learning\s+management|project|features?|requirements?|timeline|budget)\b/i.test(raw);
        const malformedHaveStatement = /\b(i|we)\s+have\s+(a|an|the)?\b/i.test(raw) && !hasClearServiceTerm;
        const unclearCue = /\b(featureless|unclear|not\s+sure|something|thing|stuff|dockeros?|doceros?)\b/i.test(raw);
        const confidenceLow = typeof confidence === 'number' && confidence < 0.78;

        if (!hasProjectContext) return null;
        if (!unclearCue && !malformedHaveStatement && !confidenceLow && !isGarbledTranscript(raw)) return null;

        if (/\bmoodle\b/i.test(contextText)) {
            return 'Sorry, did you mean features for the Moodle website?';
        }
        if (/\b(shopify|ecommerce|e-commerce)\b/i.test(contextText)) {
            return 'Sorry, did you mean features for the e-commerce website?';
        }
        return 'Sorry, I did not catch that clearly. Which website or platform features do you mean?';
    }

    _hasOfferAcceptanceSignal(text) {
        const t = String(text || '').trim();
        if (!t) return false;

        if (/\b(no|nope|nah|not\s+now|not\s+interested|don'?t|do\s+not|stop)\b/i.test(t)) {
            return false;
        }

        if (this._hasExplicitBookingRequest(t)) return true;
        if (this._isQuestionLikeTurn(t)) return false;

        const acceptPatterns = /\b(yes|sure|okay|ok|sounds good|yeah|yep|absolutely|definitely|let'?s do it|go ahead|why not|perfect|great|that works|yes please|klar|ja|natürlich|einverstanden|genau|sicher|gerne)\b/i;
        if (!acceptPatterns.test(t)) return false;

        const wordCount = t.toLowerCase().split(/\s+/).filter(Boolean).length;
        return wordCount <= 5;
    }

    _shouldTriggerDeterministicConsultationPivot(userText, isSimpleGreeting = false) {
        if (this._buildUnclearSalesClarification(userText) !== null) return false;
        const hasPivotIntentSignal = /\b(project|website|app|software|developer|developers|development|moodle|platform|integration|services?|support|team|timeline|requirements?|pricing|quote|budget|hire|hiring)\b/i.test(userText);
        const hasAcceptanceSignal = /\b(yes|yeah|yep|sure|okay|ok|definitely|absolutely|sounds good|go ahead|let'?s do it|why not|perfect|great)\b/i.test(userText);
        const hasExplicitBookingRequest = this._hasExplicitBookingRequest(userText);
        const hasNeedOrOwnershipSignal = /\b(i|we|our|my|they|their|company|business|team|client|customer|school|university|organization|organisation)\b/i.test(userText)
            && /\b(need|want|wanted|looking|planning|plan|build|develop|create|launch|upgrade|migrate|hire|hiring|requirements?|project|website|app|software|platform|integration|moodle|budget|timeline)\b/i.test(userText);
        const hasActionNeedSignal = /\b(need|want|wanted|looking|planning|plan|build|develop|create|launch|upgrade|migrate|hire|hiring|requirements?)\b/i.test(userText);
        const hasConcreteProjectEvidence = hasPivotIntentSignal && (
            hasActionNeedSignal ||
            hasNeedOrOwnershipSignal ||
            /\b(project|requirements?|budget|timeline)\b/i.test(userText)
        );
        const hasMeaningfulPivotEvidence = hasConcreteProjectEvidence || hasExplicitBookingRequest;

        if (this.conversationPhase !== 'discovery'
            || this.hasAskedForConsultation
            || this.persona?.flow?.callType !== 'sales'
            || isSimpleGreeting
            || !hasMeaningfulPivotEvidence) {
            return false;
        }

        if (hasExplicitBookingRequest) return true;
        if (this._isQuestionLikeTurn(userText)) return false;
        if (hasAcceptanceSignal && !hasConcreteProjectEvidence) return false;

        return this.count >= 1 && hasConcreteProjectEvidence;
    }

    _shouldSkipSynthesisGateForResponse(answer, isScriptedResponse = false) {
        if (isScriptedResponse) return true;
        if (this._lastKbIsGeneralFallback !== true) return false;

        const questionType = classifyFallbackQuestion(this._getLatestUserMessage());
        if (!['pricing', 'location', 'capability', 'identity', 'hearing_check', 'off_topic'].includes(questionType)) {
            return false;
        }

        return /\b(pricing depends|headquartered in|we can help|we support|we build|solutions team|scope|stack|timeline|can hear you|speaking with|booking link|text you|text the booking link|send it there|prefer email)\b/i.test(String(answer || ''));
    }

    extractEntities(text, sender) {
        if (!text) return;

        if (sender === 'USER') {
            // Sprint 5B.1: Normalize spoken email in email-collection/verify phases
            const emailText = (this.conversationPhase === 'email-collection' || this.conversationPhase === 'email-verify')
                ? this._normalizeSpokenEmail(text) : text;
            if (emailText !== text) {
                telemetry.emit('spoken_email_normalized', {
                    callId: this.callSID,
                    phase: this.conversationPhase, ts: Date.now()
                });
            }
            const emailIntent = this.conversationPhase === 'email-verify'
                ? this._classifyEmailVerificationIntent(text, emailText)
                : null;
            const extractedEmail = emailIntent?.type === 'corrected_email'
                ? emailIntent.email
                : this._extractPracticalEmail(emailText);
            if (extractedEmail) {
                const provenance = emailText !== text ? 'voice_normalized' : 'voice_regex';
                this._captureUserEmail(extractedEmail, provenance);
            }

            // Email verification gate — user confirms or rejects the spelled-back email
            if (this.conversationPhase === 'email-verify' && this.emailPendingConfirmation) {
                const intent = emailIntent || this._classifyEmailVerificationIntent(text, emailText);
                if (intent.type === 'confirmed' && this.userEmail) {
                    this.emailPendingConfirmation = false;
                    this.emailConfirmed = true;
                    log('info', this.callSID, 'email_confirmed_by_user', { email: this.userEmail });
                    telemetry.emit('email_confirmed', { callId: this.callSID, email: this.userEmail, phase: this.conversationPhase, ts: Date.now() });
                    this._requestBookingLink('email_confirmed_by_user');
                } else if (intent.type === 'rejected') {
                    log('info', this.callSID, 'email_rejected_by_user', { email: this.userEmail });
                    telemetry.emit('email_rejected', { callId: this.callSID, email: this.userEmail, phase: this.conversationPhase, ts: Date.now() });
                    this.userEmail = null;
                    this.userEmailProvenance = null;
                    this.emailPendingConfirmation = false;
                    this.emailConfirmed = false;
                }
            }

            // Phone number extraction
            const phoneMatch = text.match(/(?:\+?\d[\d\s().-]{6,}\d)/);
            if (phoneMatch) {
                const normalized = phoneMatch[0].replace(/[^\d+]/g, '');
                if (normalized.replace(/\+/, '').length >= 7) {
                    if (this.userPhone && this.userPhone !== normalized) {
                        log('info', this.callSID, 'phone_corrected', { old: this.userPhone, new: normalized });
                    }
                    this.userPhone = normalized;
                    log('info', this.callSID, 'phone_extracted', { phone: this.userPhone });
                }
            }

            if (this._captureBookingPhoneDeliveryConsent(text)) {
                this._requestBookingLink('phone_delivery_consent');
            }

            // Offer acceptance detection — user confirms consultation in 'offer' phase
            if (this.conversationPhase === 'offer' && !this.offerAccepted) {
                if (this._hasOfferAcceptanceSignal(text)) {
                    this.offerAccepted = true;
                    this._markBookingActionThisTurn(
                        this._hasExplicitBookingRequest(text) ? 'explicit_booking_request' : 'offer_accepted'
                    );
                    this._markBookingIntentDetected(
                        this._hasExplicitBookingRequest(text) ? 'explicit_booking_request' : 'offer_accepted',
                        text
                    );
                    log('info', this.callSID, 'offer_accepted');
                }
            }

            const bookingIntentReason = this._getBookingIntentReasonFromText(text);
            if (bookingIntentReason) {
                this._markBookingActionThisTurn(bookingIntentReason);
                if (bookingIntentReason === 'explicit_booking_request') {
                    this.hasAskedForConsultation = true;
                    this.offerAccepted = true;
                }
                this._markBookingIntentDetected(bookingIntentReason, text);
            }

            // Email refusal detection — user declines to share email
            if (this.conversationPhase === 'email-collection' && !this.emailRefused && !this.userEmail) {
                const refusalPatterns = /\b(no email|don'?t want to (share|give)|rather not|prefer not|not sharing|won'?t give|keine e-?mail|möchte nicht|nicht teilen)\b/i;
                if (refusalPatterns.test(text)) {
                    this.emailRefused = true;
                    this.emailConfirmed = false;
                    log('info', this.callSID, 'email_refused');
                    telemetry.emit('email_refused', { callId: this.callSID, phase: this.conversationPhase, ts: Date.now() });
                }
            }

            if (this.conversationPhase === 'slot-collection' && !this.preferredSlot) {
                const slotPatterns = [
                    /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
                    /\btomorrow\b/i, /\btoday\b/i,
                    /\b(morning|afternoon|evening|night)\b/i,
                    /\b(next|this)\s+(week|monday|tuesday|wednesday|thursday|friday)\b/i,
                    /\d{1,2}\s*(am|pm|:\d{2})/i, /\d{1,2}\s*o.?clock/i,
                    /\b(anytime|any\s*time|whenever|flexible|available|works for me)\b/i,
                    /\b(montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)\b/i,
                    /\b(morgen|heute|übermorgen)\b/i,
                    /\b(morgens|nachmittags|abends|vormittags)\b/i,
                    /\b(nächste[rn]?|diese[rn]?)\s+(woche|montag|dienstag|mittwoch|donnerstag|freitag)\b/i,
                    /\b(jederzeit|flexibel|egal wann|passt mir)\b/i,
                ];
                if (slotPatterns.some(p => p.test(text))) {
                    this.preferredSlot = text.trim().substring(0, 120);
                    log('info', this.callSID, 'slot_captured', { slot: this.preferredSlot });
                    telemetry.emit('slot_captured', { callId: this.callSID, phase: this.conversationPhase, ts: Date.now() });
                }
            }
        }

        if (sender === 'AI' && !this.hasAskedForConsultation) {
            const consultPatterns = [
                /connect you (with|to)\b.*\bteam/i,
                /book\b.*\b(meeting|call|appointment)/i,
                /schedule\b.*\b(consult|call)/i,
                /set up\b.*\bcall/i, /set\b.*\bappointment/i, /arrange\b.*\bcall/i,
                /20[\s-]?minute/i, /calendar[\s-]?invite/i, /free consult/i, /want to\b.*\bconsult/i,
                /möchten.*\bteam\b/i, /\bberatung\b/i, /verbinden.*\bteam\b/i,
                /termin.*vereinbaren/i, /anruf.*vereinbaren/i, /kalender.*einladung/i,
            ];
            if (consultPatterns.some(p => p.test(text))) {
                this.hasAskedForConsultation = true;
                this._consultationOfferedThisTurn = true;
                log('info', this.callSID, 'appointment_offered');
                telemetry.emit('appointment_offered', { callId: this.callSID, phase: this.conversationPhase, ts: Date.now() });
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // DUP CORRECTION PROMPT BUILDER (Log76 fix)
    // ═══════════════════════════════════════════════════════════════════════

    /** Phase-goal map for dup-correction prompts */
    static _PHASE_GOALS = {
        'discovery':        'Ask discovery questions to understand the caller\'s needs and requirements',
        'offer':            'Present the consultation offer clearly',
        'slot-collection':  'Acknowledge any volunteered time preference and ask permission to send the booking link if this legacy phase is active',
        'email-collection': 'Ask permission to send the booking link by text, or collect and verify email if requested',
        'email-verify':     'Confirm the email address the caller just provided',
        'confirmation':     'Confirm that the booking link will be sent or has been sent; do not claim the meeting is booked',
        'opening':          'Introduce yourself and ask if the caller has a moment',
        'screening':        'Determine if this is a valid prospect',
    };

    _buildDupCorrectionPrompt() {
        const phase = this.conversationPhase || 'discovery';
        const goal = this.constructor._PHASE_GOALS[phase] || 'Continue the conversation helpfully';

        // Extract recent context from conversationContext
        // Context entries use { sender: 'USER'|'AI', message: string }
        const ctx = this.conversationContext || [];
        const lastUserEntry = [...ctx].reverse().find(e => e.sender === 'USER');
        const lastUserMsg = lastUserEntry ? lastUserEntry.message : '';
        const recentAi = ctx.filter(e => e.sender === 'AI').slice(-2).map(e => e.message);

        const parts = [
            'You just repeated a previous response. Provide a DIFFERENT and more helpful response.',
            'Do NOT repeat greetings or introductions.',
            `Current phase: ${phase}. Your goal: ${goal}.`,
        ];
        if (lastUserMsg) {
            parts.push(`The caller just said: "${lastUserMsg.substring(0, 200)}"`);
        }
        if (recentAi.length > 0) {
            parts.push(`Do NOT repeat these previous responses: ${recentAi.map(r => `"${r.substring(0, 100)}"`).join(', ')}`);
        }
        return parts.join(' ');
    }

    // ═══════════════════════════════════════════════════════════════════════
    // CONTEXT MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════════

    addConversationContext(sender, message) {
        this.conversationEngine.addConversationContext(sender, message);
        if (String(sender || '').toUpperCase() === 'AI') {
            this._markPendingPhoneDeliveryConsentFromAssistantText(message, 'conversation_context');
        }
    }

    _getLatestUserMessage() {
        const history = Array.isArray(this.conversationContext) ? this.conversationContext : [];
        for (let i = history.length - 1; i >= 0; i--) {
            if (history[i]?.sender === 'USER') return history[i].message || '';
        }
        return '';
    }

    _buildGuardrailFallbackContext() {
        return {
            userQuestion: this._getLatestUserMessage(),
            bookingIntentActive: !!this._bookingIntentDetected,
            bookingActionThisTurn: !!this._bookingActionThisTurn,
            offerAccepted: !!this.offerAccepted,
            bookingPhoneDeliveryConsent: !!this.bookingPhoneDeliveryConsent,
            bookingLinkRequested: !!this.bookingLinkRequested,
            bookingLinkSent: !!this.bookingLinkSent,
            userPhoneAvailable: !!this.userPhone,
            userEmailAvailable: !!this.userEmail,
        };
    }

    async _triggerSummarization() {
        await this.conversationEngine._triggerSummarization();
    }

    setLatencyCompensationLevel(level) {
        this._latencyCompensationLevel = level || 'NONE';
    }

    formatConversationContext(maxTurns) {
        return this.conversationEngine.formatConversationContext(maxTurns);
    }

    getConversationHistory() {
        return this.conversationContext;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════════

    _updatePhase(overrides = {}) {
        this.conversationEngine._updatePhase(overrides);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // SILENCE TIMERS (gated by _enableSilenceTimers)
    // ═══════════════════════════════════════════════════════════════════════

    _clearSilencePromptTimers() {
        if (this.firstSilenceTimer) {
            clearTimeout(this.firstSilenceTimer);
            this.firstSilenceTimer = null;
        }
        if (this.secondSilenceTimer) {
            clearTimeout(this.secondSilenceTimer);
            this.secondSilenceTimer = null;
        }
    }

    _startPostAssistantSilenceTimer(responsePurpose) {
        this._clearSilencePromptTimers();
        if (responsePurpose === 'silence_goodbye') {
            this._scheduleSilenceHangupAfterGoodbye();
            return;
        }
        if (responsePurpose === 'silence_nudge') {
            this.startSecondSilenceTimer();
            return;
        }
        this.startFirstSilenceTimer();
    }

    startFirstSilenceTimer() {
        if (this._callClosed) return;
        if (this.firstSilenceTimer) clearTimeout(this.firstSilenceTimer);
        const now = Date.now();
        const remainingPlaybackMs = this._enableAudioPlaybackTracking
            ? Math.max(0, this._audioPlaybackEndEstimate - now)
            : 0;
        const effectiveTimeout = this.FIRST_SILENCE_TIMEOUT + remainingPlaybackMs;
        log('info', this.callSID, 'silence_timer_armed', {
            timer: 'first', timeoutMs: effectiveTimeout, status: this._getSilenceStatus(now)
        });
        this.firstSilenceTimer = setTimeout(() => {
            if (this.isBeingScreened || this._callClosed) return;
            const status = this._getSilenceStatus();
            const suppressionReason = this._getSilenceSuppressionReason(status);
            if (suppressionReason) {
                this._recordSilenceDecision('silence_nudge_suppressed_state', 'first_timer', 'suppressed', suppressionReason, status);
                this.startFirstSilenceTimer();
                return;
            }
            // Log64 P2: Skip silence nudge if synthesis gate just capped.
            // The cap already delivered a fallback; firing a nudge now triggers
            // quality-fail → synthesis retry → immediate re-cap → double fallback.
            if (this._synthesisGateRetries >= 2) {
                log('info', this.callSID, 'silence_nudge_skipped_synthesis_cap', {
                    retries: this._synthesisGateRetries,
                    status
                });
                this._recordSilenceDecision('silence_nudge_suppressed_state', 'first_timer', 'suppressed', 'synthesis_cap', status, {
                    retries: this._synthesisGateRetries
                });
                return;
            }
            const preSendStatus = this._getSilenceStatus();
            const preSendSuppressionReason = this._getSilenceSuppressionReason(preSendStatus);
            if (preSendSuppressionReason) {
                this._recordSilenceDecision(
                    'silence_nudge_suppressed_state',
                    'first_timer_presend',
                    'suppressed',
                    preSendSuppressionReason,
                    preSendStatus,
                    { timeoutMs: effectiveTimeout }
                );
                this.startFirstSilenceTimer();
                return;
            }
            this._recordSilenceDecision('silence_timer_fired', 'first_timer', 'send_nudge', null, preSendStatus, {
                timeoutMs: effectiveTimeout
            });
            const lastTopic = this._getLastTopic();
            const nudge = this.persona.silenceNudges.first(this.name, lastTopic, this._langCode);
            this.sendTextResponse(nudge);
        }, effectiveTimeout);
    }

    startSecondSilenceTimer() {
        if (this._callClosed) return;
        if (this.secondSilenceTimer) clearTimeout(this.secondSilenceTimer);
        const now = Date.now();
        const remainingPlaybackMs = this._enableAudioPlaybackTracking
            ? Math.max(0, this._audioPlaybackEndEstimate - now)
            : 0;
        const effectiveTimeout = this.SECOND_SILENCE_TIMEOUT + remainingPlaybackMs;
        log('info', this.callSID, 'silence_timer_armed', {
            timer: 'second', timeoutMs: effectiveTimeout, status: this._getSilenceStatus(now)
        });
        this.secondSilenceTimer = setTimeout(() => {
            const status = this._getSilenceStatus();
            const suppressionReason = this._getSilenceSuppressionReason(status);
            if (suppressionReason) {
                this._recordSilenceDecision('silence_nudge_suppressed_state', 'second_timer', 'suppressed', suppressionReason, status);
                this.startSecondSilenceTimer();
                return;
            }
            // Log64 P2: Skip goodbye if synthesis gate capped (safety — matches first timer guard)
            if (this._synthesisGateRetries >= 2) {
                log('info', this.callSID, 'silence_goodbye_skipped_synthesis_cap', {
                    retries: this._synthesisGateRetries,
                    status
                });
                this._recordSilenceDecision('silence_nudge_suppressed_state', 'second_timer', 'suppressed', 'synthesis_cap', status, {
                    retries: this._synthesisGateRetries
                });
                return;
            }
            if (this._recentHangupDecisionSaysContinue()) {
                log('info', this.callSID, 'silence_goodbye_postponed_continue_decision', {
                    ageMs: Date.now() - this._lastHangupDecisionTs,
                    status
                });
                telemetry.emit('silence_goodbye_postponed_continue_decision', {
                    callId: this.callSID,
                    provider: this.providerName,
                    ageMs: Date.now() - this._lastHangupDecisionTs,
                    ts: Date.now()
                });
                this.startFirstSilenceTimer();
                return;
            }
            this._recordSilenceDecision('silence_timer_fired', 'second_timer', 'send_goodbye', null, status, {
                timeoutMs: effectiveTimeout
            });
            const nudge = this.persona.silenceNudges.second(this.name, this._langCode);
            this.sendTextResponse(nudge);
        }, effectiveTimeout);
    }

    _recentHangupDecisionSaysContinue() {
        if (!this._lastHangupDecision || this._lastHangupDecision.shouldHangup !== false) return false;
        const ageMs = Date.now() - (this._lastHangupDecisionTs || 0);
        return ageMs >= 0 && ageMs < 10000;
    }

    _scheduleSilenceHangupAfterGoodbye() {
        if (this._pendingSilenceHangupTimer) clearTimeout(this._pendingSilenceHangupTimer);
        const now = Date.now();
        const playbackTailMs = this._enableAudioPlaybackTracking
            ? Math.max(0, this._audioPlaybackEndEstimate - now)
            : 0;
        const delayMs = Math.max(4000, playbackTailMs + 1000);
        this._pendingSilenceHangupTimer = setTimeout(() => {
            this._pendingSilenceHangupTimer = null;
            if (this._callClosed || this._recentHangupDecisionSaysContinue()) {
                log('info', this.callSID, 'silence_hangup_postponed_continue_decision');
                return;
            }
            this.emit('silence_hangup');
        }, delayMs);
        log('info', this.callSID, 'silence_hangup_scheduled_after_goodbye', { delayMs });
    }

    resetSilenceTimers() {
        this._clearSilencePromptTimers();
        if (this._pendingSilenceHangupTimer) {
            clearTimeout(this._pendingSilenceHangupTimer);
            this._pendingSilenceHangupTimer = null;
        }
        this.startFirstSilenceTimer();
    }

    // ═══════════════════════════════════════════════════════════════════════
    // MEDIA BLEEDTHROUGH + CONTEXT WORDS
    // ═══════════════════════════════════════════════════════════════════════

    _getLastTopic() {
        if (!this.conversationContext || this.conversationContext.length === 0) return null;
        const lastUser = [...this.conversationContext].reverse().find(m => m.sender === 'USER');
        if (!lastUser || !lastUser.message) return null;
        const msg = lastUser.message.trim();
        return msg.length > 60 ? msg.substring(0, 57).trim() + '...' : msg;
    }

    _addContextWords(text) {
        if (!text) return;
        const words = text.toLowerCase()
            .replace(/[^a-zäöüß\s]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length >= 5);
        for (const w of words) {
            if (!this._contextWords.has(w)) {
                this._contextWords.add(w);
                this._contextWordList.push(w);
            }
        }
        while (this._contextWordList.length > this.CONTEXT_WORD_LIMIT) {
            this._contextWords.delete(this._contextWordList.shift());
        }
    }

    // ── Response deduplication ───────────────────────────────────────────
    _isResponseDuplicate(aiText) {
        if (!aiText || aiText.length < 15) return false;
        const normalized = aiText.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
        let isDup = false;
        for (const prev of this._recentAiResponses) {
            const prevNorm = prev.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
            if (prevNorm.length === 0 || normalized.length === 0) continue;
            // Exact or near-exact match
            const longer  = Math.max(normalized.length, prevNorm.length);
            const common  = this._commonPrefixLength(normalized, prevNorm);
            if (common / longer > 0.8) { isDup = true; break; }
            // Simple word overlap check
            const words1 = new Set(normalized.split(/\s+/));
            const words2 = new Set(prevNorm.split(/\s+/));
            const overlap = [...words1].filter(w => words2.has(w)).length;
            const maxWords = Math.max(words1.size, words2.size);
            if (maxWords > 3 && overlap / maxWords > 0.8) { isDup = true; break; }
            // Sprint 4.2: Trigram Jaccard similarity catches paraphrased duplicates
            // Sprint 5B.3: Threshold lowered from 0.30 to 0.25 for higher catch rate
            // Phase exception: email-verify keeps 0.30 (confirmation repeats are intentional)
            if (maxWords > 3) {
                const trigramSim = this._trigramJaccard(normalized, prevNorm);
                const threshold = this.conversationPhase === 'email-verify' ? 0.3 : 0.25;
                if (trigramSim > threshold) { isDup = true; break; }
            }
        }
        // Fix 11: Always push to window (even dups) so old entries rotate out
        // and the original response doesn't stay permanently.
        this._recentAiResponses.push(aiText);
        if (this._recentAiResponses.length > 10) this._recentAiResponses.shift();
        return isDup;
    }

    // ── Sprint 4.1: Response quality assessment (mode collapse detection) ─
    _assessResponseQuality(aiText, wordCount) {
        if (!aiText) return 'empty';
        // Short response check — skip for confirmations/acknowledgements
        // Strip leading/trailing quotes — Azure sometimes wraps responses in literal " characters
        const cleanedText = aiText.trim().replace(/^["']+|["']+$/g, '').trim();
        const isConfirmation = /^(yes|no|sure|okay|ok|got it|thanks|thank you|bye|goodbye|right|exactly|correct|absolutely|definitely|perfect)\b/i.test(cleanedText);
        if (wordCount <= 3 && !isConfirmation) return 'too_short';
        // Incomplete sentence — ends without punctuation and is >10 chars
        if (aiText.length > 10 && !/[.!?…"')\]]$/.test(aiText.trim())) return 'incomplete';
        // Internal repetition — 3+ consecutive word ngram repeats within the response
        const words = aiText.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
        if (words.length >= 6) {
            for (let n = 2; n <= 4; n++) {
                for (let i = 0; i <= words.length - n * 2; i++) {
                    const gram = words.slice(i, i + n).join(' ');
                    const next = words.slice(i + n, i + n * 2).join(' ');
                    if (gram === next) {
                        const third = words.slice(i + n * 2, i + n * 3).join(' ');
                        if (third === gram) return 'repetitive';
                    }
                }
            }
        }
        // Sprint 5B.2: Meta-instruction-leak detection (mode collapse subtype)
        if (/\b(as an? ai|my (instructions|programming|guidelines)|i('m| am) (designed|programmed|an ai)|my (role|purpose) is to)\b/i.test(aiText)) return 'meta_leak';
        if (/\b(system prompt|you are a|act as a|respond as|i was (built|trained|created) to)\b/i.test(aiText)) return 'meta_leak';
        return null; // quality OK
    }

    // ── Sprint 4.2: Trigram Jaccard similarity ──────────────────────────
    _trigramJaccard(a, b) {
        if (a.length < 3 || b.length < 3) return 0;
        const trigramsA = new Set();
        const trigramsB = new Set();
        for (let i = 0; i <= a.length - 3; i++) trigramsA.add(a.substring(i, i + 3));
        for (let i = 0; i <= b.length - 3; i++) trigramsB.add(b.substring(i, i + 3));
        let intersection = 0;
        for (const t of trigramsA) { if (trigramsB.has(t)) intersection++; }
        const union = trigramsA.size + trigramsB.size - intersection;
        return union === 0 ? 0 : intersection / union;
    }

    _detectPhaseContractViolation(aiText, phase) {
        if (!aiText || !phase) return null;
        const text = aiText.toLowerCase();
        const bookingPhases = ['offer', 'slot-collection', 'email-collection', 'email-verify', 'confirmation', 'success'];
        const activeBookingContext = !!(
            this._bookingIntentDetected
            || this._bookingActionThisTurn
            || this.offerAccepted
            || this.bookingPhoneDeliveryConsent
            || this.bookingLinkRequested
            || this.bookingLinkSent
        );
        const bookingNextStep = /\b(booking\s+link|calendar\s+link|book(ing)?|schedule|slot|appointment|text|sms|email|contact|phone|number|send\s+(it|the\s+link)|should\s+i\s+send)\b/i;
        const genericClarification = /(could\s+you\s+rephrase|rephrase\s+that|make\s+sure\s+i\s+understand\s+you\s+correctly|did\s+not\s+catch|didn'?t\s+catch)/i;
        const genericDiscovery = /(tell\s+me\s+more\s+about\s+the\s+(topic|question)|what\s+part\s+should\s+they\s+focus\s+on|what\s+part\s+should\s+i\s+focus\s+on|could\s+you\s+tell\s+me\s+more\s+about\s+the\s+(topic|question))/i;
        const schedulingClaim = /(i have scheduled|appointment\s+(is\s+)?(booked|scheduled)|you'?re all set|calendar invite\s+going|they will reach out soon|you'll hear from our team soon)/i;

        if (bookingPhases.includes(phase) && activeBookingContext) {
            if (genericClarification.test(text) && !bookingNextStep.test(text)) {
                return { reason: 'booking_phase_generic_clarification' };
            }
            if (genericDiscovery.test(text) && !bookingNextStep.test(text)) {
                return { reason: 'booking_phase_generic_clarification' };
            }
        }

        // In offer/slot/email phases, claiming the call is already scheduled is invalid
        // unless slot and email are both captured.
        if (bookingPhases.includes(phase)
            && schedulingClaim.test(text)
            && (!this.preferredSlot || !this.userEmail)) {
            return { reason: 'premature_scheduling_claim' };
        }

        return null;
    }

    _buildPhaseContractCorrection(phase) {
        if (phase === 'opening' || phase === 'discovery') {
            return 'Absolutely, I can help you book that. Should I text the booking link to this number?';
        }
        if (phase === 'offer') {
            return 'Great, I can text you the booking link so you can choose a time. Should I send it to this number?';
        }
        if (phase === 'slot-collection') {
            return 'Perfect, I can include that preference. Should I text the booking link to this number?';
        }
        if (phase === 'email-collection') {
            const slotRef = this.preferredSlot ? ` for ${this.preferredSlot}` : '';
            return `Great, I can send the booking link${slotRef}. Should I text it to this number?`;
        }
        if (phase === 'email-verify' && this.userEmail) {
            return `Just to confirm, I have ${this.userEmail}. Is that correct?`;
        }
        if (phase === 'confirmation' || phase === 'success') {
            return 'You are all set for the booking link path. I can text the link to this number if you want it again.';
        }
        return 'Let us continue step by step so I get this right. What day and time work best for you?';
    }

    _commonPrefixLength(a, b) {
        let i = 0;
        while (i < a.length && i < b.length && a[i] === b[i]) i++;
        return i;
    }

    // Sprint 6D: Sliding early duplicate check using partial transcript prefix.
    // Called from response.audio_transcript.delta at every ~20-char boundary.
    // Checks prefix overlap only (no word analysis) to be fast in the hot path.
    _isEarlyDuplicate(partialText) {
        if (!partialText || partialText.length < 15) return false;
        const normalized = partialText.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
        if (normalized.length < 15) return false;
        for (const prev of this._recentAiResponses) {
            const prevNorm = prev.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
            if (prevNorm.length < 15) continue;
            const common = this._commonPrefixLength(normalized, prevNorm);
            if (common >= 15 && common / normalized.length > 0.8) return true;
        }
        return false;
    }

    // ── Language drift detection ──────────────────────────────────────────
    _checkLanguageDrift(aiText) {
        if (!aiText || aiText.length < 10) return;
        const lang = (this._langCode || 'en').toLowerCase();
        let drifted = false;

        if (lang === 'en') {
            // Detect German-specific characters / common German words in English-mode responses
            const germanPattern = /[äöüß]|(?:^|\s)(ich|und|ist|sie|das|wir|nicht|kann|gerne|bitte|danke|haben|können|Ihnen)\b/i;
            drifted = germanPattern.test(aiText);
            // Log77 Fix C: Detect Romance-language drift (Spanish/French/Portuguese/Italian)
            if (!drifted) {
                const foreignLatinPattern = /\b(pero|puede|también|alguna|tiene|otra|quiero|estoy|tengo|puedo|entendido|gracias|asistirte|avec|dans|pour|votre|nous|muito|obrigado|posso|anche|grazie)\b/gi;
                const foreignMatches = aiText.match(foreignLatinPattern);
                if (foreignMatches && foreignMatches.length >= 2) drifted = true;
            }
            // Accented characters common in Romance languages but rare in English text
            if (!drifted) {
                const accentedChars = aiText.match(/[ñáéíóúàèùâêîôûçãõ]/g);
                if (accentedChars && accentedChars.length >= 3) drifted = true;
            }
        } else if (lang === 'de') {
            // Detect English-dominant responses in German-mode
            const englishPattern = /\b(the|and|you|can|this|that|with|have|your|would|could|should|our|about)\b/gi;
            const matches = aiText.match(englishPattern);
            drifted = matches && matches.length >= 3;
        }

        if (drifted) {
            this._consecutiveDriftCount = (this._consecutiveDriftCount || 0) + 1;
            const langLabel = lang === 'de' ? 'German' : 'English';
            log('warn', this.callSID, 'language_drift_detected', {
                expected: langLabel,
                preview: aiText.substring(0, 80),
                consecutiveCount: this._consecutiveDriftCount
            });

            // After 2+ consecutive drifts, queue a corrective instruction for the next turn's response.create
            if (this._consecutiveDriftCount >= 2) {
                this._pendingLanguageCorrection = `CRITICAL: You just responded in the WRONG language. You MUST respond ONLY in ${langLabel}. Switch back to ${langLabel} immediately.`;
                this._consecutiveDriftCount = 0;
            }
        } else {
            this._consecutiveDriftCount = 0;
        }
    }

    _isMediaBleedthrough(transcript) {
        const words = transcript.trim().split(/\s+/);
        if (words.length < this.MEDIA_MIN_WORDS) return false;
        if (!this._lastBargeInTime) return false;
        if (Date.now() - this._lastBargeInTime > this.MEDIA_BARGE_IN_WINDOW_MS) return false;
        if (this._contextWords.size === 0) return false;
        const sigWords = transcript.toLowerCase()
            .replace(/[^a-zäöüß\s]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length >= 5);
        if (sigWords.length < 3) return false;
        if (sigWords.some(w => this._contextWords.has(w))) return false;
        if (/\b(i'm|i've|i'd|i'll|my|mine|you|your|yours|yourself|we're|we've|we'd|our|ours|ourselves)\b/i.test(transcript)) return false;
        if (this._energyVariance <= 0.12) return false;
        return true;
    }

    updateInstructions(instructions) {
        if (!this.isConnected) return;
        this.send(this._buildResponseCreate({
            instructions: instructions
        }));
    }

    setDecision(decision) {
        this._decision = decision;
    }

    setToneDirective(toneDirective) {
        this._currentToneDirective = toneDirective;
    }

    setHandoverTriggered(triggered = true) {
        this._handoverTriggered = !!triggered;
    }

    setClarificationCount(count, reason = 'unspecified') {
        const numeric = Number(count);
        this._clarificationCount = Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
        if (typeof this._clarificationCount === 'number') {
            this.emit('clarification_sync', this._clarificationCount);
        }
        return this._clarificationCount;
    }

    markBargeInOccurred() {
        this._bargeInOccurred = true;
    }

    setEnergyMetrics({ variance, slope, energy, gateLevel, gateSendAudio, silenceFrames }) {
        if (typeof variance === 'number') this._energyVariance = variance;
        if (typeof slope === 'number') this._energySlope = slope;
        if (typeof energy === 'number') this._lastInputEnergy = energy;
        if (typeof gateLevel === 'string') this._lastGateLevel = gateLevel;
        if (typeof gateSendAudio === 'boolean') this._lastGateSendAudio = gateSendAudio;
        if (typeof silenceFrames === 'number') this._lastGateSilenceFrames = silenceFrames;
        this._lastGateMetricsAt = Date.now();
    }

    async prewarmKnowledge(userText) {
        if (!this.kb || !userText || typeof this.kb.retrieveRelevantInfo !== 'function') return;
        this._prewarmKbQuery = userText;
        try {
            this._prewarmKbResult = this.kb.retrieveRelevantInfo(userText, this.persona?.retrieval?.maxResults) || '';
        } catch (_) {
            this._prewarmKbResult = null;
            this._prewarmKbQuery = null;
        }
    }

    clearPrewarmKnowledge() {
        this._prewarmKbResult = null;
        this._prewarmKbQuery = null;
    }

    getConversationStateSnapshot() {
        return {
            userEmail: this.userEmail,
            preferredSlot: this.preferredSlot,
            hasAskedForConsultation: this.hasAskedForConsultation,
            conversationPhase: this.conversationPhase,
            count: this.count,
            isBeingScreened: this.isBeingScreened,
            callClosed: this._callClosed,
        };
    }

    // ═══════════════════════════════════════════════════════════════════════
    // RESPONSE TIMEOUT
    // ═══════════════════════════════════════════════════════════════════════

    _startResponseTimeout(owner = null) {
        this._clearResponseTimeout();
        const timeoutOwner = owner || this._lastResponseCreateOwner || this._currentResponseOwner || this._captureResponseOwner('response_timeout');
        this._responseTimeoutTimer = setTimeout(() => {
            this._responseTimeoutTimer = null;
            // Fix 6b: Use || (either condition means nothing to do) not && (both required)
            if (!this.isResponding || !this.isConnected) return;
            log('error', this.callSID, 'response_timeout', {
                timeoutMs: this.RESPONSE_TIMEOUT_MS, isResponding: this.isResponding, ts: Date.now()
            });
            telemetry.emit('response_timeout', {
                callSID: this.callSID, timeoutMs: this.RESPONSE_TIMEOUT_MS, ts: Date.now()
            });
            // Fix 6c: Set flag so _handleResponseDone knows to skip queue drains
            // and send the fallback instead. Don't set isResponding=false here —
            // let response.done (from the cancel) handle state transition cleanly.
            this._responseTimeoutActive = true;
            this._responseTimeoutOwner = timeoutOwner;
            this.send({ type: 'response.cancel' });
            // Guard: if response.done never arrives (connection issue), force recovery
            this._responseTimeoutGuard = setTimeout(() => {
                if (this._responseTimeoutActive && this.isConnected) {
                    this._responseTimeoutActive = false;
                    this.isResponding = false;
                    log('warn', this.callSID, 'response_timeout_guard_fired', { ts: Date.now() });
                    const guardOwner = this._responseTimeoutOwner || timeoutOwner;
                    this._responseTimeoutOwner = null;
                    if (this._shouldDropStaleRecoveryOwner(guardOwner, 'response_timeout_guard_fallback')) return;
                    const fallback = this.lang?.sttLocale?.startsWith('de')
                        ? 'Ich bin noch da \u2014 k\u00f6nnten Sie das bitte nochmal sagen? Ich m\u00f6chte sicherstellen, dass ich Ihnen richtig helfe.'
                        : 'Still here \u2014 could you say that again? Want to make sure I help you properly.';
                    this.sendTextResponse(fallback);
                } else if (this._responseTimeoutActive) {
                    this._responseTimeoutActive = false;
                    this.isResponding = false;
                    this._responseTimeoutOwner = null;
                }
            }, 2000);
        }, this.RESPONSE_TIMEOUT_MS);
    }

    _clearResponseTimeout() {
        if (this._responseTimeoutTimer) {
            clearTimeout(this._responseTimeoutTimer);
            this._responseTimeoutTimer = null;
        }
        if (this._responseTimeoutGuard) {
            clearTimeout(this._responseTimeoutGuard);
            this._responseTimeoutGuard = null;
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // SEND / TRANSPORT
    // ═══════════════════════════════════════════════════════════════════════

    send(message) {
        if (!this.ws) return;
        if (this.ws.readyState !== WebSocket.OPEN) return;
        if (message?.type === 'response.create' && this._rateLimitBackoffUntil > Date.now()) {
            const delayMs = this._rateLimitBackoffUntil - Date.now();
            setTimeout(() => {
                if (this.isConnected) this.send(message);
            }, delayMs);
            return;
        }
        try {
            const responseOwner = message?.type === 'response.create'
                ? (message.__voicebotResponseOwner || this._captureResponseOwner('response_create'))
                : null;
            this.ws.send(JSON.stringify(message));
            if (message.type === 'response.create') {
                // Preserve the response opts so retry (Fix 10) can re-use
                // turn-specific instructions instead of falling back to session defaults
                this._lastResponseCreateOpts = message.response || null;
                this._lastResponseCreateOwner = responseOwner;
                this._startResponseTimeout(responseOwner);
            }
        } catch (err) {
            log('error', this.callSID, 'send_error', { type: message.type, message: err.message });
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // CONNECTION LIFECYCLE
    // ═══════════════════════════════════════════════════════════════════════

    handleError(err) {
        const isRegionError = err.message && err.message.includes('not supported in this region');
        log('error', this.callSID, 'ws_error', { message: err.message, code: err.code, isRegionError });
        this.emit('error', { message: err.message, code: err.code, type: err.type, isRegionError });
        telemetry.emit('realtime_connection_error', {
            callSID: this.callSID, provider: this.providerName,
            error: err.message, code: err.code, isRegionError, timestamp: Date.now()
        });
    }

    handleClose(code, reason) {
        const reasonStr = reason?.toString();
        const isRegionError = reasonStr && reasonStr.includes('not supported in this region');
        const isAbnormal = code === 1006;
        const isServerError = code >= 1011;
        const isPingTimeout = code === 1001; // Sprint 4.11: ping timeout/failure closes with 1001

        log('info', this.callSID, 'disconnected', { code, reason: reasonStr, isAbnormal, isServerError, isPingTimeout, isRegionError });
        this.isConnected = false;
        // Log78 Fix 4: Clear session init timer on disconnect
        if (this._sessionInitTimer) {
            clearTimeout(this._sessionInitTimer);
            this._sessionInitTimer = null;
        }
        if (this._greetingFallbackTimer) {
            clearTimeout(this._greetingFallbackTimer);
            this._greetingFallbackTimer = null;
        }
        if (this._enableSilenceTimers) this.clearSilenceTimers();
        this.clearPing();
        this._clearResponseTimeout();
        this._responseTimeoutActive = false;
        this._clearBargeInRecoveryTimer();
        if (this._deferredFlushWatchdog) {
            clearTimeout(this._deferredFlushWatchdog);
            this._deferredFlushWatchdog = null;
        }
        this._clearSpeechWindowTimers();

        this.emit('disconnected', {
            code, reason: reasonStr,
            isNormal: code === 1000, isAbnormal, isServerError, isRegionError
        });
        telemetry.emit('realtime_connection_closed', {
            callSID: this.callSID, provider: this.providerName,
            code, reason: reasonStr, isAbnormal, isRegionError, timestamp: Date.now()
        });

        if ((isAbnormal || isServerError || isPingTimeout) && !isRegionError) {
            this.attemptReconnection();
        } else if (isRegionError) {
            this.emit('region_error', { reason: reasonStr });
        }
    }

    close() {
        // Log78 Fix 1: Mark call as closed FIRST — prevents zombie reconnects
        this._callClosed = true;
        if (this._sessionInitTimer) { clearTimeout(this._sessionInitTimer); this._sessionInitTimer = null; }
        if (this.ws) { this.ws.close(); this.ws = null; }
        this.isConnected = false;
        this.isResponding = false;
        this.clearPing();
        this._clearResponseTimeout();
        this._responseTimeoutActive = false;
        if (this._screeningTimeout) {
            clearTimeout(this._screeningTimeout);
            this._screeningTimeout = null;
        }
        if (this._greetingFallbackTimer) {
            clearTimeout(this._greetingFallbackTimer);
            this._greetingFallbackTimer = null;
        }
        if (this._enableSilenceTimers) this.clearSilenceTimers();
        this._clearBargeInRecoveryTimer();
        if (this._deferredFlushWatchdog) {
            clearTimeout(this._deferredFlushWatchdog);
            this._deferredFlushWatchdog = null;
        }
        this._clearSpeechWindowTimers();
        this.hasAskedForConsultation = false;
        this.offerAccepted = false;
        this.emailRefused = false;
        this.emailPendingConfirmation = false;
        this.emailConfirmed = false;
        this.userEmailProvenance = null;
        this._bookingIntentDetected = false;
        this._bookingActionThisTurn = false;
        this._bookingActionReasonThisTurn = null;
        this.bookingLinkRequested = false;
        this.bookingLinkSent = false;
        this.bookingLinkStatus = null;
        this.bookingProvider = null;
        this.bookingLinkUrl = null;
        this.bookingDeliveryPreference = null;
        this.bookingPhoneDeliveryConsent = false;
        this.bookingPhoneDeliveryConsentTs = 0;
        this.bookingPhoneDeliveryTargetSource = null;
        this._pendingPhoneDeliveryConsentContext = null;
        this.bookingDeliveryChannels = [];
        this._bookingLinkSendInFlight = false;
        if (this._dealerOrderCloseTimer) { clearTimeout(this._dealerOrderCloseTimer); this._dealerOrderCloseTimer = null; }
        this._dealerOrderSubmitInFlight = false;
        this._isSilenceNudgeResponse = false;
        this._responseWasCancelled = false;
        this._expectedNudgePhrase = null;
        if (this._sessionInitTimer) { clearTimeout(this._sessionInitTimer); this._sessionInitTimer = null; }
        this.isOnHold = false;
        if (this._holdTimer) { clearTimeout(this._holdTimer); this._holdTimer = null; }
        this.preferredSlot = null;
        this.userPhone = null;
        this._consultationOfferedThisTurn = false;
        // Note: do NOT reset _callClosed here — close() sets it true to block zombie reconnects.
        // It only resets in the constructor for fresh instances.
        this._deferredUserInputQueue = [];
        this._pendingLanguageCorrection = null;
        this._currentResponseId = null;
        this._currentResponseItemId = null;
        this._truncateAudioEndMs = 0;
        this._lastAutoResponseTs = null;
        if (this._enableAudioPlaybackTracking) {
            this._audioPlaybackEndEstimate = 0;
            this._firstAudioTs = null;
            this._totalAudioDurationMs = 0;
        }
        this.conversationContext = [];
        this._recentAiResponses = [];
        this._repetitionHintPending = false;
        this._lastKbScoredSections = null;
        this.removeAllListeners();
    }

    async attemptReconnection() {
        // Log78 Fix 1: Don't reconnect if the telecom call has ended
        if (this._callClosed) {
            log('info', this.callSID, 'reconnect_skipped_call_closed', { ts: Date.now() });
            return;
        }
        if (this.isReconnecting) return;
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            log('error', this.callSID, 'reconnect_max_attempts', { attempts: this.reconnectAttempts });
            this.emit('reconnection_failed', { attempts: this.reconnectAttempts });
            return;
        }

        this.isReconnecting = true;
        this.reconnectAttempts++;
        const delay = this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
        log('info', this.callSID, 'reconnecting', {
            attempt: this.reconnectAttempts, maxAttempts: this.maxReconnectAttempts, delayMs: delay
        });

        await new Promise(resolve => setTimeout(resolve, delay));

        try {
            if (this.ws) {
                try { this.ws.close(); } catch {}
                this.ws = null;
            }
            await this.initialize(this.callSID, this.recipient, this.name, this._personaId, this._langCode, this.turnStateRef);
            log('info', this.callSID, 'reconnected', { attempt: this.reconnectAttempts });
            this.emit('reconnected', { attempt: this.reconnectAttempts });
            telemetry.emit('realtime_reconnected', {
                callSID: this.callSID, provider: this.providerName,
                attempt: this.reconnectAttempts, timestamp: Date.now()
            });
            this.isReconnecting = false;
        } catch (err) {
            log('error', this.callSID, 'reconnect_attempt_failed', {
                attempt: this.reconnectAttempts, message: err.message
            });
            telemetry.emit('realtime_reconnection_failed', {
                callSID: this.callSID, provider: this.providerName,
                attempt: this.reconnectAttempts, error: err.message, timestamp: Date.now()
            });
            this.isReconnecting = false;
            if (this.reconnectAttempts < this.maxReconnectAttempts) {
                this.attemptReconnection();
            } else {
                this.emit('reconnection_failed', { attempts: this.reconnectAttempts });
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PING / PONG
    // ═══════════════════════════════════════════════════════════════════════

    startPing() {
        this.clearPing();
        this.pingInterval = setInterval(() => {
            if (!this.isConnected || !this.ws) return;
            try {
                this.ws.ping();
                if (this.pongTimeout) clearTimeout(this.pongTimeout);
                this.pongTimeout = setTimeout(() => {
                    log('error', this.callSID, 'ping_timeout');
                    if (this.ws) this.ws.close(1001, 'Ping timeout');
                }, this.PING_TIMEOUT_MS);
            } catch (err) {
                log('error', this.callSID, 'ping_failed', { message: err.message });
                if (this.ws) this.ws.close(1001, 'Ping failed');
            }
        }, this.PING_INTERVAL_MS);
    }

    handlePong() {
        if (this.pongTimeout) { clearTimeout(this.pongTimeout); this.pongTimeout = null; }
    }

    clearPing() {
        if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
        if (this.pongTimeout)  { clearTimeout(this.pongTimeout);   this.pongTimeout  = null; }
    }

    clearSilenceTimers() {
        this._clearSilencePromptTimers();
        if (this._pendingSilenceHangupTimer) { clearTimeout(this._pendingSilenceHangupTimer); this._pendingSilenceHangupTimer = null; }
        if (this.silenceCommitTimer) { clearTimeout(this.silenceCommitTimer); this.silenceCommitTimer = null; }
    }
}

module.exports = BaseRealtimeAdapter;
