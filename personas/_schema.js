'use strict';

/**
 * @file _schema.js
 * Persona schema — JSDoc type definitions only.
 * This file is NOT loaded by the registry (underscore prefix skips it).
 *
 * ─── HOW TO CREATE A NEW PERSONA ────────────────────────────────────────────
 * 1. Create a new file in /personas/ (e.g. personas/my-persona.js)
 * 2. Export an object conforming to PersonaConfig below
 * 3. The registry auto-loads it on next server start — no other file changes needed
 *
 * ─── REQUIRED FIELDS ────────────────────────────────────────────────────────
 * id, name, company, languages (with at least one language key), flow,
 * retrieval, rules, silenceNudges, voicemail
 *
 * ─── LANGUAGE KEYS ──────────────────────────────────────────────────────────
 * Use ISO 639-1 codes: 'en', 'de', 'es', 'fr', 'pt', etc.
 * Each key maps to a PersonaLanguageConfig.
 * ────────────────────────────────────────────────────────────────────────────
 */

/**
 * @typedef {Object} TurnContext
 * Passed to buildTurnPrompt() on every user utterance.
 *
 * @property {number}       count                    - Turn number (1 = first user utterance)
 * @property {string|null}  name                     - Caller's name from CRM/dialer (may be null)
 * @property {string}       userQuestion             - Transcribed user utterance for this turn
 * @property {string|null}  userEmail                - Email extracted from conversation, or null
 * @property {string|null}  userPhone                - Phone number extracted from conversation, or null
 * @property {string|null}  preferredSlot            - Preferred meeting time volunteered by caller, or null
 * @property {boolean}      bookingLinkRequested     - Booking link delivery has been requested
 * @property {boolean}      bookingLinkSent          - Booking link was accepted by at least one delivery channel
 * @property {string|null}  bookingProvider          - Booking provider used for the generated link
 * @property {string|null}  bookingDeliveryPreference - Preferred delivery channel such as sms/whatsapp/email
 * @property {boolean}      bookingPhoneDeliveryConsent - Caller explicitly consented to phone delivery
 * @property {string|null}  contextHint              - Call-scoped CRM/orchestration context from /api/call
 * @property {object|null}  dealerContext            - Parsed dealer-order CRM context, when applicable
 * @property {object|null}  dealerOrder              - Runtime dealer-order state, when applicable
 * @property {string}       conversationContext      - Formatted recent conversation history
 * @property {string}       relevantKnowledge        - KB retrieval result, or '' if no KB
 * @property {boolean}      hasAskedForConsultation  - Whether consultation has been offered this session
 * @property {string}       conversationPhase        - Current phase: 'opening'|'screening'|'discovery'|'offer'|'slot-collection'|'email-collection'|'email-verify'|'confirmation'|'rejected'|'success'|'voicemail'
 * @property {string|null}  toneDirective            - Sentiment-driven tone override instruction, or null
 */

/**
 * @typedef {Object} PersonaLanguageConfig
 * All language-specific configuration for one language variant of a persona.
 *
 * @property {string}   voice         - Azure TTS voice name (e.g. 'en-US-JennyNeural')
 * @property {string}   sttLocale     - Azure STT locale (e.g. 'en-US', 'de-DE')
 * @property {string|null} knowledgeBase
 *   Filename stem in /Knowledge-base/ (without .js) to load as the KB.
 *   Set to null if this persona/language has no KB (all knowledge is in-prompt).
 *
 * @property {function(string|null): string} greeting
 *   Takes the caller's display name (or null) and returns the EXACT greeting text
 *   the model must say word-for-word.
 *
 * @property {function(): string} baseInstruction
 *   Returns the persona's base instruction text — used as session-level instructions
 *   after the greeting is delivered, and as the foundation of every turn prompt.
 *
 * @property {function(TurnContext): string} buildTurnPrompt
 *   Builds the complete per-turn instruction string injected on every user utterance.
 *   Must embed base instructions, conversation history, KB knowledge, and all rules.
 */

/**
 * @typedef {Object} FlowConfig
 * @property {string} type
 *   Human-readable category label ('sales-consultation' | 'webinar-recruitment' | 'customer-support').
 *   Informational/telemetry metadata only — not consumed at runtime.
 *
 * @property {string} callType
 *   Runtime hangup-success criterion passed to analyzeConversationForHangup().
 *   'sales'  → "committed to next steps + contact confirmed"
 *   'event'  → "confirmed attendance + email verified"
 *   This IS wired at runtime (realtimeServicePlivo.js).
 *
 * Runtime phase tracking is handled by Helper/conversationPhase.js — computePhase().
 * Do NOT add a 'stages' array here; it would conflict with the universal 9-phase state machine.
 */

/**
 * @typedef {Object} RetrievalConfig
 * @property {number} maxResults        - Max KB results to retrieve per turn (0 = no retrieval)
 * @property {number} minScoreThreshold - Minimum KB score for a result to be included
 */

/**
 * @typedef {Object} RulesConfig
 * @property {{ min: number, max: number, detailedMax: number }} targetWords
 *   Reference values for persona authors — keep prompt word count strings consistent with these.
 *
 *   detailedMax: the ONLY field consumed at runtime. Read by getInitialGreetingInstructions()
 *     (Twilio) to inject the opening turn word ceiling into the greeting prompt. Should match
 *     the 'Under N words' value used for the first turn in buildTurnPrompt().
 *
 *   max: reference value for the standard per-turn ceiling used in buildTurnPrompt() guidelines.
 *     Not consumed at runtime — persona authors must keep their hardcoded prompt strings aligned
 *     with this value manually.
 *
 *   min: reference value only. Minimum word count targets are not enforced by runtime or prompts
 *     (a minimum instruction would be unnatural in voice). Kept for schema completeness.
 *
 * @property {boolean} speechOutput
 *   Prompt directive — not a runtime enforcement flag.
 *   When true, the persona's buildTurnPrompt() must instruct the model to respond with spoken
 *   words only (no markdown, bullets, emojis, or symbols). Cannot be enforced post-emission:
 *   audio streams to the caller before the text transcript is fully available for inspection.
 *
 * @property {boolean} neverRevealAI
 *   Prompt directive — not a runtime enforcement flag.
 *   When true, the persona's buildTurnPrompt() must establish identity strongly enough that the
 *   model never breaks character. Cannot be enforced programmatically: audio is emitted before
 *   text can be intercepted, and mid-stream cancellation produces worse UX than the disclosure
 *   itself. Violations are a model alignment failure that must be addressed in the prompt.
 */

/**
 * @typedef {Object} SilenceNudgesConfig
 * @property {function(string|null, string|null, string|null): string} first
 *   Takes (callerName, lastTopic, langCode). Returns the system directive sent after FIRST_SILENCE_TIMEOUT.
 *   langCode is the ISO 639-1 code (e.g. 'en', 'de') — use it to return language-appropriate nudge text.
 *
 * @property {function(string|null, string|null): string} second
 *   Takes (callerName, langCode). Returns the system directive sent after SECOND_SILENCE_TIMEOUT.
 */

/**
 * @typedef {Object} VoicemailConfig
 * Detection is handled globally by Helper/callClassifier.js — isVoicemailContent().
 * To add patterns for a new language/market, add regexes to VOICEMAIL_CONTENT_PATTERNS there.
 *
 * @property {function(string|null): string} message
 *   Takes caller name, returns the voicemail message text the model should speak.
 *   This IS persona-specific (different brand, name, purpose).
 */

/**
 * @typedef {Object} PersonaConfig
 * Root persona configuration object. One file per persona in /personas/.
 *
 * @property {string} id       - Unique slug (e.g. 'company-sales'). Used in API calls.
 * @property {string} name     - Character display name (e.g. 'Sarah')
 * @property {string} company  - Company the character represents (e.g. 'company')
 * @property {string} role     - Character's role title
 * @property {Object<string, PersonaLanguageConfig>} languages
 *   ISO 639-1 keyed map of language configs. Must have at least one entry.
 * @property {FlowConfig}       flow
 * @property {RetrievalConfig}  retrieval
 * @property {RulesConfig}      rules
 * @property {SilenceNudgesConfig} silenceNudges
 * @property {VoicemailConfig}  voicemail
 * @property {AudioPresetsConfig} [audioPresets] - Optional audio/VAD overrides per persona
 */

/**
 * @typedef {Object} AudioPresetsConfig
 * Optional audio/VAD overrides per persona. All fields optional; omit to use env defaults.
 * @property {number} [silenceCommitMs]    - Override AZURE_VAD_SILENCE_MS
 * @property {string} [vadMode]            - 'server_vad' | 'azure_semantic_vad' | 'none'
 * @property {number} [vadThreshold]       - Override AZURE_VAD_THRESHOLD (0-1)
 * @property {number} [vadSilenceDuration] - Override VAD_SILENCE_DURATION
 * @property {number} [vadPrefixPadding]   - Override VAD_PREFIX_PADDING\n * @property {string} [vadEagerness]       - Semantic VAD eagerness: 'low' | 'medium' | 'high' | 'auto'
 */

module.exports = {}; // No runtime exports — type definitions only
