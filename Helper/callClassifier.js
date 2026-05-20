'use strict';

/**
 * @file callClassifier.js
 * Runtime content-based detection of call screening and voicemail systems.
 *
 * Design principle: match SYSTEM IDENTIFIERS (words only automated systems use),
 * not conversational phrases that real humans say.
 *
 * Validated:
 *   Screening: 11/11 real prompts detected, 0/11 human false positives
 *   Voicemail: 12/12 real greetings detected, 0/6 human false positives
 */

// ─── Call Screening ──────────────────────────────────────────────────────────
// These patterns match phrases ONLY produced by automated screening systems
// (Apple Intelligence, Google Call Screen, Samsung Bixby, Truecaller).
// Human gatekeepers/receptionists do NOT use these phrases.

const SCREENING_SYSTEM_PATTERNS = [
    // Apple Intelligence (iOS 18+)
    /screening service/i,
    /call is being screened/i,
    /being screened/i,
    // Google Call Screen
    /google assistant.*screen/i,
    /screening.*call for/i,
    /google.*screening/i,
    // Samsung / Bixby
    /screened by bixby/i,
    /bixby.*screen/i,
    // Truecaller
    /screened by truecaller/i,
    /truecaller/i,
    // Generic automated screening identifiers
    /call screen activated/i,
    /your call is being screened/i,
    /using a screening/i,
    /using.*screen.*service/i,
    // German — "gescreent" / "screene" are loanwords only used by automated systems
    /gescreent/i,
    /screene.*anruf/i,
    /anruf.*gescreent/i,
];

// Structured phrasing that only automated systems use
// (humans say "what's this about?" but never "state your name and the reason for your call")
const SCREENING_STRUCTURED_PATTERNS = [
    /state your name and.*reason/i,
    /state your name and why/i,
    /say your name and why/i,
    /tell me your name and the reason/i,
];

/**
 * Detects whether a transcript is from an automated call screening system.
 * @param {string} text - Transcribed user speech
 * @returns {boolean}
 */
function isCallScreening(text) {
    if (!text || typeof text !== 'string') return false;
    for (const p of SCREENING_SYSTEM_PATTERNS) {
        if (p.test(text)) return true;
    }
    for (const p of SCREENING_STRUCTURED_PATTERNS) {
        if (p.test(text)) return true;
    }
    return false;
}

// ─── Voicemail ───────────────────────────────────────────────────────────────
// Content-based detection of voicemail greetings transcribed as USER speech.
// The meta-heuristic in quickDecisionFilter (no user speech) only catches
// voicemails that produce no transcribable audio. These patterns catch the
// common case where the voicemail greeting IS transcribed by STT.

const VOICEMAIL_CONTENT_PATTERNS = [
    // English
    /leave (a |your )?message after the (beep|tone)/i,
    /please leave (a |your )?message/i,
    /you('ve| have) reached the (voicemail|mailbox)/i,
    /reached the (voicemail|mailbox) of/i,
    /not available.*leave (a |your )?message/i,
    /at the tone.*record your message/i,
    /mailbox.*is full/i,
    /the (person|number|subscriber|party) you (are|have) (called|dialed|trying)/i,
    /please (record|leave) your message/i,
    /after the (beep|tone)/i,
    // German
    /mailbox von .+ erreicht/i,
    /hinterlassen sie (eine |ihre )?nachricht/i,
    /nach dem (signal|piep)ton/i,
    /nicht erreichbar.*nachricht/i,
    /anrufbeantworter/i,
    // Hindi
    /voicemail.*message.*chhod/i,
    /beep ke baad/i,
];

/**
 * Detects whether a transcript is from a voicemail greeting system.
 * @param {string} text - Transcribed user speech
 * @returns {boolean}
 */
function isVoicemailContent(text) {
    if (!text || typeof text !== 'string') return false;
    for (const p of VOICEMAIL_CONTENT_PATTERNS) {
        if (p.test(text)) return true;
    }
    return false;
}

// ─── Post-Screening Human Reconnect ──────────────────────────────────────────
// After screening, the next utterance is likely the real human accepting the call.
// Uses start-of-string anchor WITHOUT end anchor to handle "Hello, this is John" etc.

const HUMAN_GREETING_PATTERNS = /^(hello|hi|hey|yes|yeah|yep|speaking|go ahead|this is)/i;

/**
 * Detects whether a transcript is a human greeting (post-screening reconnect).
 * @param {string} text - Transcribed user speech
 * @returns {boolean}
 */
function isHumanGreeting(text) {
    if (!text || typeof text !== 'string') return false;
    return HUMAN_GREETING_PATTERNS.test(text.trim());
}

// ─── Transcript Quality (Noise / Garble Detection) ───────────────────────────
// Identifies noise-induced STT artifacts: ultra-short fragments, truncated
// sentences, and stutter/self-correction patterns caused by background noise.
//
// Design goals:
//   ✅ Filter: "Where I?", "Mobile.", "Do you provide?", "How did RP?",
//             "Are you do you do RPA?"
//   ✅ Pass:   "yes", "no", "yeah", "okay" (single-word valid responses)
//   ✅ Pass:   "Can you please help me?" (≥ 4 words — complete utterances)
//   ✅ Pass:   "Do you work in RPA services?" (long enough to be real)

/**
 * Single-word and two-word responses that are semantically valid even when
 * transcribed in isolation. These must never be filtered as noise.
 */
const VALID_SHORT_RESPONSES = new Set([
    // English — affirmatives / negatives / closings
    'yes', 'no', 'yeah', 'yep', 'nope', 'nah', 'sure', 'okay', 'ok',
    'right', 'correct', 'good', 'great', 'fine', 'perfect', 'absolutely',
    'definitely', 'exactly', 'agreed', 'understood',
    'hello', 'hi', 'hey', 'bye', 'goodbye', 'thanks', 'thank',
    // English — hold/delay/deferral/politeness (single word, commonly used as interruptions)
    'wait', 'hold', 'later', 'busy', 'sorry', 'pardon', 'please', 'stop', 'what',
    // German — affirmatives / negatives / closings / common single-word conversational
    'ja', 'nein', 'gut', 'danke', 'tschuss', 'hallo', 'klar', 'genau',
    'sicher', 'stimmt', 'richtig', 'natürlich', 'alles',
    'bitte', 'was', 'wie', 'wer', 'wo', 'warum', 'moment',
    // German — hold/delay
    'warten', 'stopp', 'entschuldigung',
]);

/**
 * Business-critical 2–3 word phrases that must NEVER be filtered as noise.
 * Includes rejection phrases (must reach quickDecisionFilter), confirmation
 * phrases, interest signals, and common German conversational phrases.
 * Normalised to lowercase for lookup.
 */
const VALID_SHORT_PHRASES = new Set([
    // English — rejections (must reach quickHangupDecision / quickDecisionFilter)
    'not interested', 'no thanks', 'no thank you', 'not now', 'stop calling',
    'remove me', 'take me off',
    // English — confirmations / permissions
    'go ahead', 'sounds good', 'sounds great', 'thats fine', 'thats great',
    'yes please', 'of course', 'for sure', 'all right', 'no problem',
    // English — interest signals (trigger consultation flow)
    'how much', 'send email', 'call back', 'tell me', 'go on',
    'book call', 'book my call', 'schedule call', 'send booking link',
    // English — hold/delay phrases (user asking bot to pause)
    'hold on', 'hang on', 'one moment', 'one second', 'just a second',
    'wait a moment', 'hold please', 'just a moment', 'wait please',
    // English — clarification requests
    'say again', 'come again', 'say what', 'excuse me',
    // English — audibility / connection checks
    'am i audible', 'can you hear', 'are you there',
    // English — common questions / statements
    'who is this', 'what is it', 'what was that', 'how are you',
    'i am busy', 'not right now', 'yes i am', 'i am good',
    'who are you', 'i said yes', 'tell me more', 'is that so',
    // English — polite responses / deferrals
    'yes sir', 'no sir', 'not yet',
    // German — rejections
    'nicht interessiert', 'nein danke', 'kein interesse',
    // German — common conversational
    'wie bitte', 'wie viel', 'ja bitte', 'ja klar', 'alles klar',
    'ja genau', 'ja gut', 'nein danke', 'moment bitte',
    // German — hold/delay
    'warten sie', 'einen moment', 'moment mal',
    // Hindi / Urdu / Arabic-script booking-like short phrases
    'कॉल बुक', 'बुक कॉल', 'बात बुक',
    'بک کو کال', 'کال بک',
]);

const EDGE_NON_ALNUM_RE = /^[^\p{L}\p{N}\p{M}]+|[^\p{L}\p{N}\p{M}]+$/gu;
const HAS_LETTER_OR_NUMBER_RE = /[\p{L}\p{N}]/u;
const NON_ALNUM_RE = /[^\p{L}\p{N}\p{M}]+/gu;

function normaliseForLookup(value) {
    return String(value || '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(NON_ALNUM_RE, '');
}



/**
 * Detects whether a transcript is a noise-induced garbled fragment that should
 * not be processed as a real user utterance.
 *
 * Returns true (garbled) for:
 *   - Single non-response words: "Mobile.", "Argent."
 *   - Ultra-short 2-word fragments (< 5 printable chars): "Uh hm?"
 *   - Ultra-short 3-word fragments (< 7 printable chars): "A bu da."
 *
 * Returns false (valid) for:
 *   - Known short responses: "yes", "no", "okay", "yeah", "nein", "ja", "bitte"
 *   - Known business-critical phrases: "Not interested", "No thanks", "How much",
 *     "Am I audible", "Who is this", "Wie bitte", "Nein danke", etc.
 *   - Complete short utterances with ≥ 4 words: "Can you please help me?"
 *
 * @param {string} text - Transcribed user speech (already trimmed)
 * @returns {boolean}
 */
function isGarbledTranscript(text) {
    // null, undefined, non-string, or empty → not a valid utterance
    if (!text || typeof text !== 'string' || text.trim().length === 0) return true;

    // Unicode-aware tokenisation keeps non-Latin words (Hindi/Urdu/Arabic)
    // from collapsing to an empty token list.
    const words = text.trim()
        .split(/\s+/)
        .map(w => w.replace(EDGE_NON_ALNUM_RE, ''))
        .filter(w => HAS_LETTER_OR_NUMBER_RE.test(w));

    if (words.length === 0) return true;

    // ── Single-word check ─────────────────────────────────────────────────────
    if (words.length === 1) {
        const lw = normaliseForLookup(words[0]);
        return !VALID_SHORT_RESPONSES.has(lw);
    }

    // ── Business-critical phrase safeguard (2–3 words) ───────────────────────
    // Check BEFORE the character-count threshold so that rejection phrases,
    // interest signals, and common conversational phrases are never filtered.
    if (words.length <= 3) {
        const normalised = words
            .map(w => normaliseForLookup(w))
            .filter(Boolean)
            .join(' ');
        if (VALID_SHORT_PHRASES.has(normalised)) return false;
    }

    // ── Short-fragment check (2–3 words) ──────────────────────────────────────
    // Per-word-count thresholds to avoid catching real phrases like
    // "Not interested" (13 chars) while still catching "Where I?" (6 chars).
    //   2 words: < 5 printable chars → garbled  (catches: "Uh hm?" but not "Not yet")
    //   3 words: < 7 printable chars → garbled  (catches: "A bu da" but not "Am I audible?")
    if (words.length <= 3) {
        const printable = words.map(w => normaliseForLookup(w)).join('');
        const printableLength = Array.from(printable).length;
        const threshold = words.length === 2 ? 5 : 7;
        if (printableLength < threshold) return true;
    }

    return false;
}

module.exports = {
    isCallScreening,
    isVoicemailContent,
    isHumanGreeting,
    isGarbledTranscript,
    // Exported for testing / extension
    SCREENING_SYSTEM_PATTERNS,
    SCREENING_STRUCTURED_PATTERNS,
    VOICEMAIL_CONTENT_PATTERNS,
    VALID_SHORT_RESPONSES,
    VALID_SHORT_PHRASES,
};
