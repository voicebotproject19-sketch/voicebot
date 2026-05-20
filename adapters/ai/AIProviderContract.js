'use strict';

/**
 * AIProviderContract — JSDoc interface for all AI realtime adapters.
 *
 * Any class passed as `aiProviderClass` to createCallSession MUST conform to
 * this contract. Both AzureRealtimeAdapter and OpenAIRealtimeAdapter implement it.
 *
 * ── Lifecycle ──────────────────────────────────────────────────────────────
 * @method initialize(callSID, recipient, name, personaId, langCode, turnStateRef)
 *   Opens a WebSocket to the AI provider and configures the session.
 *   Must resolve persona/language, load KB, establish connection.
 *
 * @method close()
 *   Tears down the WebSocket, clears all timers, releases resources.
 *
 * ── Audio I/O ──────────────────────────────────────────────────────────────
 * @method sendAudio(mulawBuffer: Buffer)
 *   Accepts μ-law 8kHz audio. The adapter transcodes internally if the
 *   backend requires a different format (e.g. PCM16 24kHz for OpenAI).
 *
 * ── Response control ───────────────────────────────────────────────────────
 * @method cancelResponse()
 *   Cancels the in-flight AI response (sends response.cancel).
 *
 * @method sendTextResponse(text: string)
 *   Injects a deterministic text response via the LLM voice pipeline.
 *   Used for screening responses, voicemail, silence nudges, noise acks.
 *
 * @method insertUpdatedPrompt(userQuestion: string, decision?: string)
 *   Builds KB-enriched instructions and triggers a new AI response.

 * @method updateInstructions(instructions: string)
 *   Pushes a session-level instruction update to the provider.
 *
 * @method setLatencyCompensationLevel(level: string)
 *   Adjusts KB/context depth for latency-sensitive turns.

 * @method setDecision(decision: string)
 * @method setToneDirective(toneDirective: string)
 * @method setHandoverTriggered(triggered?: boolean)
 * @method markBargeInOccurred()
 * @method setEnergyMetrics({ variance: number, slope: number })
 * @method prewarmKnowledge(userText: string)
 * @method clearPrewarmKnowledge()
 * @method getConversationStateSnapshot()
 *
 * ── State (read by orchestrator) ───────────────────────────────────────────
 * @property {boolean} isConnected       — WebSocket is open
 * @property {boolean} isSessionConfigured — AI session accepted our config
 * @property {boolean} isResponding      — AI is generating a response
 * @property {string}  callSID           — current call identifier
 * @property {number}  count             — conversation turn counter
 * @property {string}  conversationPhase — current phase (opening, discovery, etc.)
 * @property {object}  persona           — resolved persona config
 * @property {object}  kb                — knowledge base instance (or null)
 * @property {object}  lang              — persona language config
 * @property {string}  name              — caller name
 * @property {string}  recipient         — caller phone number
 * @property {string}  userEmail         — extracted email (or null)
 * @property {string}  userPhone         — extracted phone number (or null)
 * @property {string}  preferredSlot     — captured appointment slot (or null)
 * @property {boolean} bookingLinkRequested
 * @property {boolean} bookingLinkSent
 * @property {boolean} bookingPhoneDeliveryConsent
 * @property {string}  bookingDeliveryPreference
 * @property {boolean} hasAskedForConsultation
 * @property {number}  totalInputTokens
 * @property {number}  totalOutputTokens
 * @property {Array}   conversationContext
 *
 * ── Events emitted (EventEmitter) ─────────────────────────────────────────
 *   session_configured — AI session ready to receive audio
 *   user_transcript    — (text, { confidence }) final caller transcription
 *   audio              — (buffer) μ-law audio for telecom stream
 *   audio_done         — TTS generation finished for current response
 *   response_created   — model started generating a new response
 *   response.created   — legacy alias for response_created
 *   interruption       — barge-in detected
 *   user_speaking      — VAD speech start (Twilio-style)
 *   user_speech_started — VAD speech start
 *   user_stopped_speaking — VAD speech stop (Twilio-style)
 *   user_speech_stopped — VAD speech stop
 *   ai_transcript      — (text) model's full text transcript
 *   screening_detected — (transcript) call screening detected
 *   voicemail_detected — (transcript) voicemail detected
 *   decision           — (data) hangup decision result
 *   silence_hangup     — silence timeout reached (Twilio only)
 *   disconnected       — ({ code, reason, isNormal, isAbnormal, ... })
 *   reconnected        — ({ attempt })
 *   reconnection_failed — ({ attempts })
 *   error              — transport/API error
 *   region_error       — Azure region not supported
 *   api_error          — API-level error (Plivo-style)
 */

module.exports = {
	requiredMethods: [
		'initialize',
		'close',
		'sendAudio',
		'cancelResponse',
		'sendTextResponse',
		'insertUpdatedPrompt',
		'updateInstructions',
		'setLatencyCompensationLevel',
		'setDecision',
		'setToneDirective',
		'setHandoverTriggered',
		'markBargeInOccurred',
		'setEnergyMetrics',
		'prewarmKnowledge',
		'clearPrewarmKnowledge',
		'getConversationStateSnapshot'
	],
	methodSignatures: {
		initialize: 6,
		close: 0,
		sendAudio: 1,
		cancelResponse: 0,
		sendTextResponse: 1,
		insertUpdatedPrompt: 1,
		updateInstructions: 1,
		setLatencyCompensationLevel: 1,
		setDecision: 1,
		setToneDirective: 1,
		setHandoverTriggered: 0,
		markBargeInOccurred: 0,
		setEnergyMetrics: 1,
		prewarmKnowledge: 1,
		clearPrewarmKnowledge: 0,
		getConversationStateSnapshot: 0
	},
	requiredGetters: ['providerName']
};
