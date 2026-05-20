'use strict';

const { defaultRateLimiter } = require('../../Utils/rateLimiter');

/**
 * Summarizes older conversation turns into a concise 2-3 sentence summary.
 * Uses the same Azure OpenAI endpoint and rate limiter as hangup analysis.
 * Runs asynchronously and never blocks the realtime hot path.
 *
 * @param {Array<{sender: string, message: string}>} turns
 * @param {string} [callType='sales'] - 'sales' or 'event', used for context-aware summarization
 * @returns {Promise<string>} Summary text, or '' on failure
 */
async function summarizeOlderTurns(turns, callType = 'sales') {
    if (!turns || turns.length === 0) return '';

    // Sanitize transcript: mask profanity and hostile language that triggers
    // Azure content filters when sent as a "user" message.
    const profanityPattern = /\b(f+u+c+k+|s+h+i+t+|a+s+s+h+o+l+e+|b+i+t+c+h+|d+a+m+n+|hell|crap|piss|bastard|dick|wtf|stfu|gtfo)\b/gi;
    const formatted = turns
        .map(t => `${t.sender}: ${t.message}`)
        .join('\n')
        .replace(profanityPattern, '[expletive]');

    const callLabel = callType === 'event' ? 'event invitation' : 'business development';

    try {
        const { AzureOpenAI } = require('openai');
        const endpointUrl = process.env.AZURE_OPENAI_ENDPOINT || '';
        const origin = endpointUrl ? new URL(endpointUrl).origin : '';
        const client = new AzureOpenAI({
            apiKey: process.env.AZURE_OPENAI_API_KEY,
            endpoint: origin,
            apiVersion: process.env.OPENAI_API_VERSION || '2025-04-01-preview'
        });

        const model = process.env.OPENAI_HANGUP_MODEL || "gpt-4o-mini";
        const result = await defaultRateLimiter.execute(() =>
            client.chat.completions.create({
                model,
                messages: [
                    {
                        role: 'system',
                        content: `You are summarizing a verbatim ${callLabel} call transcript. The transcript is from automated cold-calling and may contain rejection phrases, strong language, or hostile responses — this is normal and expected. Focus only on extracting business-relevant information.\n\nSummarize in 2-3 sentences. Preserve: caller name, email address, phone number, ${callType === 'event' ? 'registration status' : 'consultation status'}, interest level, objections raised, and any commitments made. No commentary.`
                    },
                    { role: 'user', content: formatted }
                ],
                max_completion_tokens: 150
            })
        );

        return result.choices?.[0]?.message?.content?.trim() || '';
    } catch (err) {
        console.warn('[ContextSummarizer] Failed:', err.message);
        // Sprint 5B.6: Re-throw so _triggerSummarization catch block fires alerting
        throw err;
    }
}

module.exports = { summarizeOlderTurns };