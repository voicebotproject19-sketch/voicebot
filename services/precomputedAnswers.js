'use strict';

/**
 * Sprint 4.5: Pre-computed Answer Templates (PAT)
 *
 * Maps common FAQ intent patterns to pre-scripted responses that bypass
 * full inference. Responses are persona-aware when persona config provides
 * overrides via persona.precomputedAnswers[].
 *
 * Usage:
 *   const match = matchPrecomputedAnswer(transcript, persona);
 *   if (match) { // bypass inference, send match.response }
 */

// Default FAQ patterns and responses (English, sales context)
const DEFAULT_PATTERNS = [
    {
        id: 'what_do_you_do',
        patterns: [/what\s+(do\s+you|does\s+(your|the)\s+company)\s+do/i, /tell\s+me\s+about\s+(your|the)\s+company/i, /what\s+is\s+(company|your\s+company)/i],
        response: 'We\'re a global IT services company specialising in custom software development, cloud solutions, and digital transformation. We\'ve been in the industry for over 24 years. Would you like to know how we can help with your specific needs?'
    },
    {
        id: 'pricing',
        patterns: [
            /what\s+are\s+your\s+(rates|prices|pricing|cost)/i,
            /how\s+much\s+(do\s+you|does\s+it|would\s+(a|the|my))\s+(charge|cost)/i,
            /\b(hourly|daily|monthly)\s+rates?\b/i,
            /\b(rate\s+card|pricing\s+model|share\s+your\s+pricing|price\s+range|budget\s+range)\b/i,
            /\bwhat\s+(budget|cost)\s+(do\s+i|would\s+i)\s+need\b/i,
            /\bwhat\s+(is|will\s+be)\s+the\s+(budget|cost)\b/i,
            /\bhow\s+much\s+would\s+.{0,60}\s+cost\b/i
        ],
        response: 'Our pricing depends on the project scope and technology stack. We offer competitive rates and flexible engagement models. I\'d love to set up a quick call with our solutions team to give you an accurate quote. Would that work?'
    },
    {
        id: 'demo_request',
        patterns: [/can\s+i\s+(get|see|have)\s+a\s+demo/i, /show\s+me\s+a?\s*demo/i, /demo\s+available/i],
        response: 'Absolutely! I can arrange a personalised demo for you. What day works best — this week or next?'
    },
    {
        id: 'location',
        patterns: [
            /where\s+are\s+you\s+(located|based)/i,
            /where\s+is\s+your\s+(company|office|team|headquarters)\s+(located|based)/i,
            /where'?s\s+(your|the|company\s*india)\s+(office|location|headquarters|team)/i,
            /your\s+(office|location|headquarters)/i,
            /\b(office|headquarters)\s+(address|location)\b/i
        ],
        response: 'We\'re headquartered in Noida, India, with delivery centres across India and client-facing teams globally. We serve clients in the US, UK, Europe, and the Middle East.'
    },
    {
        id: 'who_am_i_speaking_to',
        patterns: [/who\s+(am\s+i|is\s+this)\s+(speaking|talking)\s+(to|with)/i, /what\s+is\s+your\s+name/i, /who\s+are\s+you/i],
        response: null // Handled dynamically — needs persona name
    },
    {
        id: 'moodle_platform',
        patterns: [/\bmoodle\b.*\b(develop|development|delivery|implementation|integration|support|platform|lms|learning\s+management|website|site|portal)\b/i, /\b(do|can)\s+you\s+.*\bmoodle\b/i],
        response: 'Yes, we support Moodle development, integrations, upgrades, and custom LMS workflows. A solutions specialist can map the right approach for your use case. Would you like me to arrange that discussion?'
    },
    {
        id: 'ecommerce_platform',
        patterns: [/\b(shopify|magento|woocommerce|online\s+store|e-?commerce)\b.*\b(develop|development|website|store|integration|migration|support|platform|order\s+to\s+shipment)\b/i, /\b(do|can)\s+you\s+.*\b(shopify|magento|woocommerce|online\s+store|e-?commerce)\b/i],
        response: 'Yes, we build and support e-commerce platforms including Shopify, Magento, and WooCommerce, along with custom integrations. A quick scoping call would help us recommend the right path. Would that work?'
    },
    {
        id: 'call_back',
        patterns: [/call\s+(me\s+)?back\s+(later|tomorrow|next\s+week)/i, /not\s+a\s+good\s+time/i, /i'?m\s+busy\s+(right\s+now|at\s+the\s+moment)/i],
        response: 'No problem at all! When would be a better time for a quick chat?'
    },
    {
        id: 'technologies',
        patterns: [
            /what\s+technolog(y|ies)\s+do\s+you\s+(use|work\s+with|support)/i,
            /do\s+you\s+(work\s+with|support|do)\s+(react|angular|node|python|java|\.net|aws|azure|moodle|shopify|magento|woocommerce|wordpress)/i,
            /can\s+you\s+(build|support|develop|integrate|handle)\s+.*\b(react|angular|node|python|java|\.net|aws|azure|moodle|shopify|magento|woocommerce|wordpress|lms|e-?commerce)\b/i
        ],
        response: 'We work with a wide range of technologies including React, Angular, Node.js, Python, Java, .NET, AWS, Azure, and more. Our team can match the right stack to your project needs. Shall I set up a technical consultation?'
    },
    {
        id: 'experience',
        patterns: [/how\s+long\s+have\s+you\s+been/i, /how\s+many\s+years/i, /your\s+experience/i],
        response: 'We\'ve been delivering IT solutions for over 24 years, with thousands of projects completed across 50+ countries. Would you like to hear about work we\'ve done in your industry?'
    },
    {
        id: 'case_studies',
        patterns: [/case\s+stud(y|ies)/i, /examples?\s+of\s+(your\s+)?work/i, /portfolio/i, /references/i],
        response: 'We have case studies across healthcare, fintech, e-commerce, and enterprise SaaS. I can have our team share relevant examples after a quick discovery call. Shall we schedule one?'
    },
    {
        id: 'team_size',
        patterns: [/how\s+(many|big)\s+is\s+your\s+team/i, /team\s+size/i, /how\s+many\s+(developers|engineers|people)/i],
        response: 'We have over 500 technology professionals across our delivery centres. We can scale teams up or down based on your project needs. Would you like to discuss your requirements?'
    }
];

/**
 * Match a user transcript against pre-computed answer patterns.
 * @param {string} transcript - User's utterance
 * @param {object} [persona] - Optional persona config with .precomputedAnswers[]
 * @param {string} [botName] - Bot's display name for dynamic responses
 * @returns {{ id: string, response: string } | null}
 */
function matchPrecomputedAnswer(transcript, persona, botName, phase) {
    if (!transcript || transcript.length < 5 || transcript.length > 200) return null;

    // Check persona-specific overrides first
    const personaPatterns = persona?.precomputedAnswers;
    if (Array.isArray(personaPatterns)) {
        for (const entry of personaPatterns) {
            if (!entry.patterns || !entry.response) continue;
            // Sprint 5B.5: Phase filter — skip entry if phases[] is defined and current phase is not in it
            if (entry.phases && Array.isArray(entry.phases) && phase && !entry.phases.includes(phase)) continue;
            for (const p of entry.patterns) {
                const re = p instanceof RegExp ? p : new RegExp(p, 'i');
                if (re.test(transcript)) return { id: entry.id || 'persona_custom', response: entry.response };
            }
        }
    }

    // Check default patterns
    for (const entry of DEFAULT_PATTERNS) {
        for (const pattern of entry.patterns) {
            if (pattern.test(transcript)) {
                // Dynamic response for "who am I speaking to"
                if (entry.id === 'who_am_i_speaking_to') {
                    const name = botName || persona?.name || 'an AI assistant';
                    return { id: entry.id, response: `You're speaking with ${name}, an AI assistant. How can I help you today?` };
                }
                if (entry.response) return { id: entry.id, response: entry.response };
            }
        }
    }

    return null;
}

module.exports = { matchPrecomputedAnswer, DEFAULT_PATTERNS };
