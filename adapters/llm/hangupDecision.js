require('dotenv').config();

const { AzureOpenAI } = require('openai');
const { defaultRateLimiter } = require('../../Utils/rateLimiter');

const azureOpenAI = new AzureOpenAI({
    apiKey: process.env.AZURE_OPENAI_API_KEY,
    baseURL: process.env.AZURE_OPENAI_ENDPOINT,
    apiVersion: '2025-04-01-preview',
    defaultQuery: { 'api-version': '2025-04-01-preview' },
    defaultHeaders: {
        'Content-Type': 'application/json'
    }
});

const HANGUP_MODEL =
    process.env.AZURE_CLASSIFIER_MODEL ||
    process.env.OPENAI_HANGUP_MODEL ||
    "gpt-4o-mini";

function extractJSON(text) {
    if (!text) throw new Error('Empty response');

    let cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) cleaned = jsonMatch[0];

    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');

    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        cleaned = cleaned.substring(firstBrace, lastBrace + 1);
    }

    cleaned = cleaned.replace(/,\s*([}\]])/g, '$1');

    return cleaned;
}

async function analyzeConversationForHangup(name, count, conversationContext, callType = 'event') {
    return analyzeConversationWithRetry(name, count, conversationContext, callType);
}

async function analyzeConversationWithRetry(name, count, conversationContext, callType = 'event', maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await analyzeConversationInternal(name, count, conversationContext, callType);
        } catch (error) {
            const isRateLimit = error.status === 429 || error.code === 'rate_limit_exceeded';
            const isJsonTruncation = error instanceof SyntaxError ||
                (error.message && (
                    error.message.includes('Unterminated string') ||
                    error.message.includes('Unexpected end') ||
                    error.message.includes('Unexpected token')
                ));
            const isEmptyResponse = error.message && error.message.includes('Empty response from API');
            const isContentFilter = error.status === 400 && error.message &&
                (error.message.includes('content_filter') || error.message.includes('content management policy'));
            const isTransient = isRateLimit || isJsonTruncation || isEmptyResponse || isContentFilter;

            if (isTransient && attempt < maxRetries) {
                const delay = isRateLimit
                    ? Math.pow(2, attempt) * 1000
                    : 400 * attempt;
                console.log(`[HangupDecision] Transient error "${error.message}" - retrying in ${delay}ms (attempt ${attempt}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                if (attempt >= maxRetries) console.error('[HangupDecision] Max retries exceeded');
                throw error;
            }
        }
    }
}

async function analyzeConversationInternal(name, count, conversationContext, callType = 'event') {
    try {
        const campaignGoal = callType === 'event'
            ? 'prospect CONFIRMED attendance and EMAIL VERIFIED'
            : 'prospect COMMITTED to next steps (meeting/demo/proposal) and CONTACT CONFIRMED';

        const successCriteria = callType === 'event'
            ? 'Event attendance confirmed + Email provided + Email verified by user'
            : 'Next step agreed (meeting/demo/proposal) + Contact info provided + Contact verified';

        const response = await defaultRateLimiter.execute(async () => {
            return azureOpenAI.responses.create({
                model: HANGUP_MODEL,
                input: [
                    {
                        role: 'system',
                        content: `You are a business call status analyzer. Respond with ONLY valid JSON.

Goal: Determine whether the conversation has reached a natural conclusion or should continue.

Conclude the call when:
1. Completed: ${successCriteria}
2. Declined: The prospect has clearly said they are not interested
3. Voicemail: The call reached a voicemail system

Keep the call going when:
- A phone screening assistant is asking verification questions
- The prospect just asked a clarifying question about the offer in the last 1-2 turns
- The prospect has offered to send documents or take an action within the last 2 turns

Return ONLY this JSON structure:
{
  "shouldHangup": boolean,
  "reason": "success|awaiting_verification|awaiting_contact|rejected|voicemail|ai_screening|continue|soft_interest",
  "success": boolean,
  "${callType === 'event' ? 'eventConfirmed' : 'nextStepConfirmed'}": boolean,
  "userEmail": string|null,
  "userPhone": string|null,
  "${callType === 'event' ? 'emailConfirmed' : 'contactConfirmed'}": boolean,
  "nextAction": string,
  "confidence": number,
  "language": "english|german|hindi|mixed",
  "isVoicemail": boolean,
  "isAIScreening": boolean
}`
                    },
                    {
                        role: 'user',
                        content: `Call type: ${callType === 'event' ? 'Event invitation' : 'Business development'}

Prospect: ${name || 'Unknown'}
Turn count: ${count}
Message count: ${conversationContext.length}

Transcript:

${conversationContext.map((msg, idx) =>
                            `[${idx + 1}] ${msg.sender === 'USER' ? 'Prospect' : 'Representative'}: ${msg.message}`
                        ).join('\n')}

Analyze and return ONLY JSON.`
                    }
                ],
                max_output_tokens: 1200,
                text: {
                    format: {
                        type: 'json_object'
                    }
                }
            });
        });

        let responseContent =
            (typeof response.output_text === 'string' && response.output_text.trim()) ||
            (Array.isArray(response.output)
                ? response.output
                    .map(o =>
                        (typeof o.text === 'string' ? o.text : '') ||
                        (o.content || []).map(c => c.text || '').join('')
                    )
                    .join('')
                    .trim()
                : '');

        if (!responseContent) {
            throw new Error('Empty response from API');
        }

        const cleanedJSON = extractJSON(responseContent);

        let finalJSON;
        try {
            finalJSON = JSON.parse(cleanedJSON);
        } catch (parseErr) {
            throw new Error(`JSON parse failed: ${parseErr.message} - raw: ${cleanedJSON.substring(0, 200)}`);
        }

        return {
            shouldHangup: finalJSON.shouldHangup || false,
            reason: finalJSON.reason || 'continue',
            success: finalJSON.success || false,
            eventConfirmed: finalJSON.eventConfirmed || finalJSON.nextStepConfirmed || false,
            userEmail: finalJSON.userEmail || null,
            userPhone: finalJSON.userPhone || null,
            emailConfirmed: finalJSON.emailConfirmed || finalJSON.contactConfirmed || false,
            nextAction: finalJSON.nextAction || 'Continue conversation',
            confidence: finalJSON.confidence || 0,
            language: finalJSON.language || 'unknown',
            isVoicemail: finalJSON.isVoicemail || false,
            isAIScreening: finalJSON.isAIScreening || false
        };
    } catch (error) {
        console.error('Hangup analysis error:', error);

        return {
            shouldHangup: false,
            reason: 'error',
            success: false,
            eventConfirmed: false,
            userEmail: null,
            userPhone: null,
            emailConfirmed: false,
            nextAction: 'Continue - analysis error occurred',
            confidence: 0,
            language: 'unknown',
            isVoicemail: false,
            isAIScreening: false,
            error: error.message
        };
    }
}

module.exports = { analyzeConversationForHangup };