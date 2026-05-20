const crypto = require('crypto');

function summarizeCallContentForLog(value) {
    const text = String(value || '');
    const trimmed = text.trim();
    return {
        hash: crypto.createHash('sha256').update(text).digest('hex').slice(0, 12),
        length: text.length,
        wordCount: trimmed ? trimmed.split(/\s+/).length : 0
    };
}

/**
 * Quick Decision Filter for Hangup Decisions
 * Provides rule-based heuristics to avoid unnecessary LLM calls
 */

/**
 * Quick hangup decision based on simple heuristics
 * Returns a decision object if confident, null if LLM analysis is needed
 * 
 * @param {Array} conversationContext - Array of conversation messages
 * @param {number} count - Current turn count
 * @param {string} botLang - Bot language
 * @returns {Object|null} - Decision object or null
 */
function quickHangupDecision(conversationContext, count, botLang) {
    if (!conversationContext || conversationContext.length === 0) {
        return null;
    }

    // Get last user message
    const userMessages = conversationContext.filter(msg => msg.sender === 'USER');
    const lastUserMessage = userMessages.slice(-1)[0]?.message?.toLowerCase() || '';

    // Get AI messages
    const aiMessages = conversationContext.filter(msg => msg.sender === 'AI');
    const lastAIMessage = aiMessages.slice(-1)[0]?.message?.toLowerCase() || '';

    // Rule 1: Explicit rejection phrases
    const rejectionPhrases = {
        english: ['not interested', 'no thanks', 'remove me', 'pass', 'take me off your list', 'stop calling'],
        german: ['nicht interessiert', 'nein danke', 'kein interesse', 'nicht mehr anrufen', 'bitte nicht mehr'],
        hindi: ['दिलचस्पी नहीं', 'नहीं धन्यवाद', 'कॉल मत करो']
    };

    const lang = botLang?.toLowerCase() || 'english';
    const phrases = rejectionPhrases[lang] || rejectionPhrases.english;

    for (const phrase of phrases) {
        const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`\\b${escaped}\\b`, 'i');
        if (re.test(lastUserMessage)) {
            console.log(`[QuickDecision] Rejection detected: "${phrase}"`);
            return {
                shouldHangup: true,
                reason: 'rejected',
                success: false,
                eventConfirmed: false,
                userEmail: null,
                emailConfirmed: false,
                nextAction: 'End call - user declined',
                confidence: 0.95,
                language: lang,
                isVoicemail: false,
                isAIScreening: false
            };
        }
    }

    // Rule 2a: Voicemail detection (one-way communication)
    // Require 3+ unanswered AI messages before declaring voicemail
    if (userMessages.length === 0 && aiMessages.length >= 3) {
        console.log('[QuickDecision] Voicemail detected - no user speech');
        return {
            shouldHangup: true,
            reason: 'voicemail',
            success: false,
            eventConfirmed: false,
            userEmail: null,
            emailConfirmed: false,
            nextAction: 'Leave voicemail and hangup',
            confidence: 0.9,
            language: lang,
            isVoicemail: true,
            isAIScreening: false
        };
    }

    // Rule 2b: Voicemail content detection (greeting was transcribed as user speech)
    // Catches cases where the STT transcribes the voicemail greeting, so userMessages.length > 0
    // but the content is "Please leave a message after the beep".
    const { isVoicemailContent } = require('./callClassifier');
    if (isVoicemailContent(lastUserMessage)) {
        console.log('[QuickDecision] Voicemail greeting detected', {
            transcriptSummary: summarizeCallContentForLog(lastUserMessage)
        });
        return {
            shouldHangup: true,
            reason: 'voicemail_greeting',
            success: false,
            eventConfirmed: false,
            userEmail: null,
            emailConfirmed: false,
            nextAction: 'Leave voicemail and hangup',
            confidence: 0.95,
            language: lang,
            isVoicemail: true,
            isAIScreening: false
        };
    }

    // Rule 3: AI Screening detection
    // Full screening detection is now handled upstream in the transcription handler
    // (services-plivo/realtimeServicePlivo.js and services-twilio/realtimeServiceTwilio.js)
    // using Helper/callClassifier.js. This rule catches any screening text that leaks
    // past the upstream gate (e.g. partial transcripts that arrive via a different event path).
    const { isCallScreening } = require('./callClassifier');
    if (isCallScreening(lastUserMessage)) {
        console.log('[QuickDecision] AI screening detected', {
            transcriptSummary: summarizeCallContentForLog(lastUserMessage)
        });
        return {
            shouldHangup: false,
            reason: 'ai_screening',
            success: false,
            eventConfirmed: false,
            userEmail: null,
            emailConfirmed: false,
            nextAction: 'Continue conversation with AI screener',
            confidence: 0.85,
            language: lang,
            isVoicemail: false,
            isAIScreening: true
        };
    }

    // Also catch human gatekeeper questions that should not trigger hangup
    const gatekeeperPatterns = [
        'who\'s calling', 'who is calling', 'what is this about', 'what\'s this about',
        'what\'s the reason', 'what is the reason', 'can i ask who', 'may i ask who',
        'wer ruft an', 'worum geht es', 'darf ich fragen'
    ];
    for (const pattern of gatekeeperPatterns) {
        if (lastUserMessage.includes(pattern)) {
            console.log(`[QuickDecision] Gatekeeper question detected: "${pattern}"`);
            return {
                shouldHangup: false,
                reason: 'gatekeeper_question',
                success: false,
                eventConfirmed: false,
                userEmail: null,
                emailConfirmed: false,
                nextAction: 'Continue conversation - answer gatekeeper',
                confidence: 0.85,
                language: lang,
                isVoicemail: false,
                isAIScreening: false
            };
        }
    }

    // Rule 4: Email confirmation detection
    // If AI mentioned an email and user confirmed positively
    const emailPattern = /[\w.-]+@[\w.-]+\.\w+/;
    const hasEmailInLastAI = emailPattern.test(lastAIMessage);

    const confirmationPhrases = {
        english: ['yes', 'yeah', 'yep', 'correct', 'right', 'perfect', 'thanks', 'thank you', 'great', 'okay', 'ok', 'sure'],
        german: ['ja', 'stimmt', 'richtig', 'perfekt', 'danke', 'vielen dank', 'gut', 'in ordnung', 'passt'],
        hindi: ['हां', 'सही', 'ठीक', 'धन्यवाद', 'शुक्रिया', 'अच्छा']
    };

    const confirmations = confirmationPhrases[lang] || confirmationPhrases.english;

    // Negation tokens: if user says "okay but wrong" or "yes actually wait",
    // that's NOT a genuine confirmation — fall through to LLM analysis.
    const negationTokensMap = {
        english: /\b(but|wrong|incorrect|wait|actually|hold on|not right|different|change|mistake)\b/i,
        german:  /\b(aber|falsch|warte|moment|halt|nicht richtig|ändern|fehler|eigentlich)\b/i,
        hindi:   /\b(लेकिन|गलत|रुको|रुकिए|सही नहीं|बदलो)\b/i,
    };
    const negationTokens = negationTokensMap[lang] || negationTokensMap.english;

    if (hasEmailInLastAI) {
        for (const confirmation of confirmations) {
            if (lastUserMessage.includes(confirmation)) {
                if (negationTokens.test(lastUserMessage)) {
                    console.log('[QuickDecision] Email confirmation with negation — deferring to LLM');
                    continue;
                }
                console.log('[QuickDecision] Email confirmation detected');
                return {
                    shouldHangup: true,
                    reason: 'success',
                    success: true,
                    eventConfirmed: true,
                    userEmail: extractEmail(lastAIMessage),
                    emailConfirmed: true,
                    nextAction: 'End call - email confirmed',
                    confidence: 0.95,
                    language: lang,
                    isVoicemail: false,
                    isAIScreening: false
                };
            }
        }
    }

    // No confident decision - need LLM analysis
    return null;
}

/**
 * Extract email from text
 * @param {string} text - Text to extract email from
 * @returns {string|null} - Extracted email or null
 */
function extractEmail(text) {
    const emailPattern = /[\w.-]+@[\w.-]+\.\w+/;
    const match = text.match(emailPattern);
    return match ? match[0] : null;
}

/**
 * Check if hangup analysis should be performed based on turn count
 * @param {number} count - Current turn count
 * @param {boolean} hasEmail - Whether email has been captured
 * @returns {boolean} - Whether to perform analysis
 */
function shouldPerformAnalysis(count, hasEmail) {
    const analysisInterval = parseInt(process.env.OPENAI_HANGUP_ANALYSIS_INTERVAL) || 3;

    // Always analyze first turn
    if (count === 1) {
        return true;
    }

    // Analyze every Nth turn
    if (count % analysisInterval === 0) {
        return true;
    }

    // Analyze after 6th turn regardless
    if (count >= 6) {
        return true;
    }

    // Analyze if no email yet after 3 turns
    if (!hasEmail && count >= 3) {
        return true;
    }

    return false;
}

module.exports = {
    quickHangupDecision,
    shouldPerformAnalysis,
    extractEmail
};
