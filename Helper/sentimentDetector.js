'use strict';

/**
 * Detects caller sentiment signals from transcript text.
 * Pure function — no I/O, no side effects, no LLM calls.
 * Mirrors the pattern of complexityDetector.js.
 *
 * Cost: ~0.1ms per call (string matching on short transcripts).
 */

const FRUSTRATION_SIGNALS = [
    'i already told you', 'i said', 'told you again', 'asking again',
    'not helpful', 'this is ridiculous', 'waste of time', 'for the third time',
    'i just said', 'how many times', 'still not', 'you keep'
];

const URGENCY_SIGNALS = [
    'urgent', 'asap', 'right now', 'immediately', 'right away',
    'quickly', 'hurry', 'deadline', 'time sensitive', 'can\'t wait'
];

const CONFUSION_SIGNALS = [
    'i don\'t understand', 'what do you mean', 'confused', 'that doesn\'t make sense',
    'can you explain', 'i\'m lost', 'huh', 'wait what', 'what are you saying'
];

const DISENGAGEMENT_SIGNALS = [
    'whatever', 'i don\'t care', 'never mind', 'doesn\'t matter',
    'just forget it', 'not interested', 'no thanks'
];

const HOSTILITY_SIGNALS = [
    'this is stupid', 'you\'re useless', 'terrible', 'incompetent',
    'shut up', 'idiot', 'worst', 'horrible', 'pathetic'
];

const HANDOVER_REQUESTS = [
    'real person', 'human agent', 'talk to someone', 'transfer me',
    'speak to a manager', 'representative', 'speak to someone',
    'talk to a human', 'real agent', 'let me talk to', 'operator',
    'connect me to', 'transfer to', 'speak with a person',
    'echte person', 'mit jemandem sprechen', 'weiterleiten',   // German
    'menschlicher agent', 'vorgesetzter', 'mitarbeiter'
];

/**
 * @param {string} userText - Transcribed user utterance
 * @returns {{ signals: string[], handoverRequested: boolean, primary: string|null }}
 */
function detectSentiment(userText) {
    if (!userText) return { signals: [], handoverRequested: false, primary: null };
    const lower = userText.toLowerCase();
    const signals = [];

    if (FRUSTRATION_SIGNALS.some(s => lower.includes(s)))    signals.push('frustration');
    if (URGENCY_SIGNALS.some(s => lower.includes(s)))        signals.push('urgency');
    if (CONFUSION_SIGNALS.some(s => lower.includes(s)))      signals.push('confusion');
    if (DISENGAGEMENT_SIGNALS.some(s => lower.includes(s)))  signals.push('disengagement');
    if (HOSTILITY_SIGNALS.some(s => lower.includes(s)))      signals.push('hostility');

    const handoverRequested = HANDOVER_REQUESTS.some(s => lower.includes(s));
    return { signals, handoverRequested, primary: signals[0] || null };
}

module.exports = { detectSentiment };
