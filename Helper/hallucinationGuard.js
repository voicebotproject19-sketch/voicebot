'use strict';

/**
 * @file hallucinationGuard.js
 * Three-layer defense against SLM hallucination in voice bot responses.
 *
 * Layer 1 (Pre-generation):  isFactualQuestionWithoutKB()
 *   Detects when a user asks a specific factual question and the KB returned
 *   nothing relevant. Returns a safe canned response to bypass the model entirely.
 *
 * Layer 2 (Post-generation):  scanForHallucination()
 *   Scans AI-generated text for hallucination markers: unlisted client names,
 *   fabricated numbers, pricing claims. Returns { hallucinated, reasons }.
 *
 * Both layers are pure functions — no I/O, no side effects.
 */

// ─── Layer 1: Factual Question Detection ─────────────────────────────────────

/**
 * Patterns that indicate the user is asking a specific factual question
 * (not small talk, not a confirmation, not a vague interest signal).
 */
const FACTUAL_QUESTION_PATTERNS = [
    // Pricing / cost
    /\b(how much|price|pricing|cost|budget|charge|fee|quote|estimate|afford|expensive|cheap)\b/i,
    /\b(hourly rate|daily rate|rate card)\b/i,
    // Specific capability / comparison
    /\b(do you (have|offer|support|provide|use|work with))\b/i,
    /\b(can you (do|build|make|create|handle|develop|integrate))\b/i,
    /\b(have you (built|worked|done|created|developed|delivered))\b/i,
    // Competitor comparison
    /\b(vs|versus|compared? to|better than|different from|why not|instead of)\b/i,
    // Specific tech question
    /\b(what (technology|tech|stack|framework|platform|language|tool))\b/i,
    // Stats / proof
    /\b(how many|how long|success rate|track record|guarantee|sla|uptime)\b/i,
    // Location / team
    /\b(where (are|is) (your|the) (team|office|company|headquarters))\b/i,
    // Case study / portfolio
    /\b(example|case study|portfolio|reference|testimonial|review)\b/i,
    // Who / specific entity
    /\b(who (is|are|was|were) (your|the))\b/i,
];

/**
 * Patterns that indicate the input is NOT a factual question (small talk,
 * confirmations, greetings, etc.) — these should NOT trigger the KB gate.
 */
const NON_FACTUAL_PATTERNS = [
    /^(yes|no|yeah|yep|sure|okay|ok|right|got it|absolutely|definitely|nope|nah)\b/i,
    /^(hi|hello|hey|good morning|good afternoon|good evening)\b/i,
    /^how are you(?!\s+(compared|different|better|vs\b))/i,
    /^(thanks|thank you|great|perfect|sounds good|wonderful|awesome)\b/i,
    /\b(hold on|wait|one moment|give me a second|call (me )?back)\b/i,
    /\b(not interested|no thanks|i'm busy|bad time)\b/i,
];

/**
 * Determines if the user is asking a factual question that requires KB grounding,
 * but the KB returned no relevant content.
 *
 * @param {string} userQuestion - The user's transcribed utterance
 * @param {string} relevantKnowledge - KB retrieval result (may be empty or general fallback)
 * @param {string} generalInfo - getGeneralInfo() output for comparison
 * @param {Object} [persona] - Persona config (optional, for callType-aware responses)
 * @returns {{ shouldIntercept: boolean, safeResponse: string|null, reason: string|null }}
 */
function isFactualQuestionWithoutKB(userQuestion, relevantKnowledge, generalInfo, persona, isGeneralFallback) {
    if (!userQuestion || typeof userQuestion !== 'string') {
        return { shouldIntercept: false, safeResponse: null, reason: null };
    }

    const q = userQuestion.trim();

    // Skip if input is clearly not a factual question
    if (NON_FACTUAL_PATTERNS.some(p => p.test(q))) {
        return { shouldIntercept: false, safeResponse: null, reason: null };
    }

    // Skip if KB returned specific content (not just the general fallback)
    const kbIsEmpty = !relevantKnowledge || relevantKnowledge.trim().length === 0;
    // Use structured flag when available; fall back to string comparison for backward compat
    const kbIsOnlyGeneral = (isGeneralFallback === true) || (
        isGeneralFallback === undefined && generalInfo && relevantKnowledge &&
        relevantKnowledge.trim() === generalInfo.trim()
    );
    const kbHasNoSpecificContent = kbIsEmpty || kbIsOnlyGeneral;

    if (!kbHasNoSpecificContent) {
        return { shouldIntercept: false, safeResponse: null, reason: null };
    }

    // Check if this is a factual question
    const isFactual = FACTUAL_QUESTION_PATTERNS.some(p => p.test(q));
    if (!isFactual) {
        return { shouldIntercept: false, safeResponse: null, reason: null };
    }

    // Determine appropriate safe response based on question type
    const isPricing = /\b(how much|price|pricing|cost|budget|charge|fee|quote|estimate)\b/i.test(q) ||
        (/\brate\b/i.test(q) && !/\b(success rate|track record|rating)\b/i.test(q));
    const isComparison = /\b(vs|versus|compared? to|better than|different from|why not|instead of)\b/i.test(q);

    const isEvent = persona?.flow?.callType === 'event';

    let safeResponse;
    if (isPricing) {
        safeResponse = isEvent
            ? "The webinar is completely free. I can send you the invite so you can see for yourself. What's your email?"
            : "Pricing depends on the project scope and requirements. Our team can put together a detailed quote on the call. Can I book a quick 20-minute call with our solutions team?";
    } else if (isComparison) {
        safeResponse = isEvent
            ? "Great question! We cover that in detail during the webinar with real case studies. Can I save you a spot?"
            : "Great question! Our team can walk through our differentiators in detail on the call. Can I book you a quick 20-minute call?";
    } else {
        safeResponse = isEvent
            ? "That's a great question — we go into detail on that during the webinar. Can I send you the invite so you can see for yourself?"
            : "That's a great question — I want to make sure you get the most accurate answer. Our solutions team can cover that in detail. Can I book you a quick 20-minute call?";
    }

    return {
        shouldIntercept: true,
        safeResponse,
        reason: isPricing ? 'pricing_question_no_kb' :
                isComparison ? 'comparison_question_no_kb' :
                'factual_question_no_kb'
    };
}

function classifyFallbackQuestion(userQuestion) {
    const q = String(userQuestion || '').trim();
    if (!q) return null;

    if (/\b(how much|price|pricing|cost|budget|charge|fee|quote|estimate|hourly rate|daily rate|rate card)\b/i.test(q) ||
        (/\brate\b/i.test(q) && !/\b(success rate|track record|rating)\b/i.test(q))) {
        return 'pricing';
    }
    if (/\b(where\s+(are|is)\s+(you|your|the|company\s*india)|located|based|office|headquarters|address)\b/i.test(q)) {
        return 'location';
    }
    if (/\b(who\s+(am\s+i\s+)?(speaking|talking)\s+(to|with)|who\s+are\s+you|what\s+is\s+your\s+name)\b/i.test(q)) {
        return 'identity';
    }
    if (/\b(can\s+you\s+hear\s+me|do\s+you\s+hear\s+me|are\s+you\s+there|repeat\s+that|say\s+that\s+again|i\s+can'?t\s+hear)\b/i.test(q)) {
        return 'hearing_check';
    }
    if (/\b(joke|tell\s+me\s+a\s+joke|weather|sing\s+a\s+song)\b/i.test(q)) {
        return 'off_topic';
    }
    if (/\b(can\s+you|could\s+you|do\s+you|have\s+you|work\s+with|support|build|develop|integrate|handle|moodle|shopify|magento|woocommerce|wordpress|react|angular|node|python|java|\.net|aws|azure|platform|website|app|software)\b/i.test(q)) {
        return 'capability';
    }
    if (/\b(featureless|unclear|not\s+sure|something|thing|stuff|dockeros?|doceros?)\b/i.test(q) ||
        (/\b(i|we)\s+have\s+(a|an|the)?\b/i.test(q) && !/\b(moodle|shopify|website|platform|app|software|features?|requirements?|timeline|budget)\b/i.test(q))) {
        return 'unclear';
    }

    return null;
}

// ─── Layer 2: Post-Generation Hallucination Scanner ──────────────────────────

/**
 * Known/allowed client names from the persona script. Any other company name
 * mentioned as a company client is likely hallucinated.
 */
const ALLOWED_CLIENTS = new Set([
    'steve madden', 'happy planner', 'smartr365', 'ramp group',
    'fda thailand', "entrepreneurs' organization", 'entrepreneurs organization',
    'awarenessideas4u', 'mother dairy', 'stem city usa', 'dabur',
    'bata', 'ymca', 'paypal', 'company',
    'jetex', 'unido lkdf', 'unido', 'porteck', 'finding a doctor',
    'us embassy span magazine', 'us embassy', 'all here',
]);

/**
 * Well-known tech companies that the SLM might hallucinate as clients.
 */
const HALLUCINATION_COMPANY_PATTERNS = [
    /\b(apple|amazon|netflix|google|microsoft|meta|facebook|tesla|uber|airbnb)\b/i,
    /\b(spotify|twitter|linkedin|tiktok|snapchat|pinterest|reddit)\b/i,
    /\b(udemy|coursera|edx|moodle\.org|linkedin learning|khan academy)\b/i,
    /\b(infosys|tcs|wipro|cognizant|accenture|capgemini|deloitte)\b/i,
];

/**
 * Patterns indicating fabricated pricing / cost claims.
 */
const PRICING_HALLUCINATION_PATTERNS = [
    /\$\d/,                                          // any dollar amount
    /\b\d+[,.]?\d*\s*(dollars|usd|eur|gbp|inr)\b/i, // "500 dollars"
    /\b(per hour|hourly rates?|per month|monthly fee|monthly cost)\b/i,  // rate claims
    /\b(starts? (at|from)|as low as|only)\s*\$?\d/i,  // "starts at $50"
];

/**
 * Patterns indicating fabricated statistics that contradict the KB.
 * The KB says: 10,000+ projects, 50+ countries, 4.9/5 rating.
 */
const STATS_HALLUCINATION_PATTERNS = [
    // Inflated project counts: 11,000+ through 99,999+ (10,000 is correct)
    /\b(1[1-9],?\d{3}|[2-9]\d,?\d{3}|\d{3,},?\d{3})\+?\s*projects?\b/i,
    // Inflated country counts: 60+ through 999 (50 is correct)
    /\b([6-9]\d|[1-9]\d{2,})\+?\s*countries\b/i,
    // Wrong ratings
    /\b[0-4]\.[0-8]\/5\b/,   // below 4.9/5
    /\b5\.0\/5\b/,            // inflated to perfect 5.0/5
];

/**
 * Patterns for fabricated URLs — the bot should never cite specific URLs.
 */
const URL_HALLUCINATION_PATTERNS = [
    /https?:\/\/[^\s]+/i,   // any URL is suspect in a voice response
];

/**
 * Fabricated partnership/certification claims not in KB.
 * KB lists: Microsoft Gold, Google, Drupal, Shopify, BigCommerce, Wix, Odoo, ISO 9001:2015, EO, YPO.
 */
const FABRICATED_PARTNERSHIP_PATTERNS = [
    /\b(aws premier|aws select|aws advanced)\b/i,
    /\b(google cloud premier|google cloud partner)\b/i,
    /\b(salesforce partner|oracle partner|sap partner|sap certified)\b/i,
    /\b(cmmi level|six sigma|pmp certified)\b/i,
    /\b(iso 27001|iso 22301|soc 2|soc2|hipaa compliant|gdpr certified)\b/i,
];

/**
 * Fabricated delivery timeline claims — specific timelines not grounded in KB.
 * KB only mentions: "basic website 3-4 weeks", "complex platforms several months", "ride app 60-90 days".
 */
const FABRICATED_TIMELINE_PATTERNS = [
    /\b(?:deliver|ship|launch|complete|finish|ready)\b.{0,30}\b(\d{1,2})\s*(?:day|week|month)s?\b/i,
];

/**
 * Sprint 5A.3: Fabricated phone numbers — bot should never cite specific phone numbers.
 */
const FABRICATED_PHONE_PATTERNS = [
    /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/,   // 555-123-4567
    /\b1[-.\s]?800[-.\s]?\d{3}[-.\s]?\d{4}\b/, // 1-800 numbers
    /\bcall\s+us\s+at\b/i,                  // "call us at" phrasing
];

/**
 * Sprint 5A.3: Fabricated team size — flag if drastically different from KB.
 * KB says "500+ engineers" — anything claiming a wildly different number is suspect.
 */
const FABRICATED_TEAM_SIZE_PATTERNS = [
    /\b(\d{4,})\s*(?:developer|engineer|expert|professional|specialist)s?\b/i, // 1000+ devs
];

/**
 * Sprint 5A.3: Fabricated founding year — flag if year not grounded in KB.
 * KB says "24+ years" (founded ~2000) — claims of 1985, 2010 etc. are suspect.
 */
const FABRICATED_FOUNDING_PATTERNS = [
    /\b(?:founded|established|since|started)\s*(?:in\s*)?(?:19[0-8]\d|199[0-8]|20(?:0[1-9]|[1-2]\d))\b/i,
];

/**
 * Sprint 5A.3: Fabricated award/recognition claims not in KB.
 */
const FABRICATED_AWARD_PATTERNS = [
    /\b(?:award|prize|recognition|accolade|fast\s*500|fortune\s*\d|inc\s*5000|gartner)\b/i,
];

/**
 * Sprint 5A.3: Fabricated office/location claims — specific addresses not in KB.
 */
const FABRICATED_OFFICE_PATTERNS = [
    /\b(?:office|headquarters|headquartered|located)\s+(?:at|in|on)\s+\d+\s/i,
    /\bsilicon valley\b/i,
];

/**
 * Scans AI-generated response text for hallucination markers.
 *
 * @param {string} aiResponse - The model's generated text
 * @param {string} relevantKnowledge - The KB content that was provided to the model
 * @returns {{ hallucinated: boolean, reasons: string[] }}
 */
function scanForHallucination(aiResponse, relevantKnowledge) {
    if (!aiResponse || typeof aiResponse !== 'string') {
        return { hallucinated: false, reasons: [] };
    }

    const reasons = [];
    const text = aiResponse.toLowerCase();
    const kbLower = (relevantKnowledge || '').toLowerCase();

    // Check 1: Unlisted company named as client
    // Pattern: "we built/worked with/developed for [Company]"
    const clientClaims = aiResponse.match(
        /\b(?:we(?:'ve)?\s+(?:built|worked|developed|created|delivered|partnered|helped|served|designed)(?:\s+\w+){0,3}\s+(?:for|with))\s+([A-Z][\w\s&'.,-]+?)(?:\.|,|\s+and\b|\s+in\b|\s+to\b|\s+across\b)/g
    );
    if (clientClaims) {
        for (const claim of clientClaims) {
            // Extract company name after "for/with"
            const nameMatch = claim.match(/(?:for|with)\s+(.+?)(?:\.|,)?$/i);
            if (nameMatch) {
                const name = nameMatch[1].trim().toLowerCase();
                // Only flag if it matches a known hallucination pattern
                if (HALLUCINATION_COMPANY_PATTERNS.some(p => p.test(name))) {
                    reasons.push(`unlisted_client:${nameMatch[1].trim()}`);
                }
            }
        }
    }

    // Check 2: Direct mention of hallucination-prone companies as clients
    for (const pattern of HALLUCINATION_COMPANY_PATTERNS) {
        const match = text.match(pattern);
        if (match) {
            // Only flag if the company appears in a client/work context
            const idx = text.indexOf(match[0].toLowerCase());
            const surrounding = text.substring(Math.max(0, idx - 60), idx + match[0].length + 60);
            if (/\b(built|worked|client|project|developed|case study|portfolio)\b/i.test(surrounding)) {
                reasons.push(`hallucinated_client:${match[0]}`);
            }
        }
    }

    // Check 3: Pricing claims (should never happen)
    for (const pattern of PRICING_HALLUCINATION_PATTERNS) {
        if (pattern.test(aiResponse)) {
            reasons.push('fabricated_pricing');
            break;
        }
    }

    // Check 4: Inflated/wrong statistics
    for (const pattern of STATS_HALLUCINATION_PATTERNS) {
        if (pattern.test(aiResponse)) {
            reasons.push('fabricated_stats');
            break;
        }
    }

    // Check 5: Role inversion — AI speaking as the buyer
    const roleInversionPatterns = [
        /\b(my name is|i am looking for|we are seeking|we need a developer|our budget is|we want to hire)\b/i,
        /\bdoes company have experience\b/i,
    ];
    for (const pattern of roleInversionPatterns) {
        if (pattern.test(aiResponse)) {
            // Exclude if Sarah is quoting the caller ("You mentioned you're looking for")
            const isQuoting = /\b(you mentioned|you said|you're looking|sounds like you)\b/i.test(aiResponse);
            if (!isQuoting) {
                reasons.push('role_inversion');
                break;
            }
        }
    }

    // Check 6: Fabricated URLs — voice responses should never contain URLs
    for (const pattern of URL_HALLUCINATION_PATTERNS) {
        if (pattern.test(aiResponse)) {
            reasons.push('fabricated_url');
            break;
        }
    }

    // Check 7: Fabricated partnership/certification claims
    // Only flag if the specific claim text isn't found in the KB content
    for (const pattern of FABRICATED_PARTNERSHIP_PATTERNS) {
        const match = aiResponse.match(pattern);
        if (match && !kbLower.includes(match[0].toLowerCase())) {
            reasons.push('fabricated_partnership');
            break;
        }
    }

    // Check 8: Fabricated delivery timelines not grounded in KB
    // Only flag if the specific timeline text isn't found in the KB content
    for (const pattern of FABRICATED_TIMELINE_PATTERNS) {
        const match = aiResponse.match(pattern);
        if (match && !kbLower.includes(match[0].toLowerCase())) {
            reasons.push('fabricated_timeline');
            break;
        }
    }

    // Check 9: Fabricated phone numbers — voice bot should never cite specific numbers
    for (const pattern of FABRICATED_PHONE_PATTERNS) {
        if (pattern.test(aiResponse)) {
            reasons.push('fabricated_phone');
            break;
        }
    }

    // Check 10: Fabricated team size — flag numbers drastically different from KB
    for (const pattern of FABRICATED_TEAM_SIZE_PATTERNS) {
        const match = aiResponse.match(pattern);
        if (match) {
            const claimed = parseInt(match[1], 10);
            // KB says 500+ — flag if claiming 1000+ and not backed by KB
            if (claimed >= 1000 && !kbLower.includes(match[0].toLowerCase())) {
                reasons.push('fabricated_team_size');
                break;
            }
        }
    }

    // Check 11: Fabricated founding year
    for (const pattern of FABRICATED_FOUNDING_PATTERNS) {
        const match = aiResponse.match(pattern);
        if (match && !kbLower.includes(match[0].toLowerCase())) {
            reasons.push('fabricated_founding');
            break;
        }
    }

    // Check 12: Fabricated awards/recognitions not in KB
    for (const pattern of FABRICATED_AWARD_PATTERNS) {
        const match = aiResponse.match(pattern);
        if (match && !kbLower.includes(match[0].toLowerCase())) {
            reasons.push('fabricated_award');
            break;
        }
    }

    // Check 13: Fabricated office/location claims
    for (const pattern of FABRICATED_OFFICE_PATTERNS) {
        if (pattern.test(aiResponse)) {
            reasons.push('fabricated_office');
            break;
        }
    }

    // Check 14: Broad client claim — "our clients include X" without for/with verb pattern
    const broadClientClaims = aiResponse.match(
        /\b(?:clients?\s+include|work(?:ed)?\s+with|partnered\s+with|trusted\s+by)\s+([A-Z][\w\s,&]+?)(?:\.|,\s*and\b|\s+and\s+many|\s+among)/gi
    );
    if (broadClientClaims) {
        for (const claim of broadClientClaims) {
            for (const pattern of HALLUCINATION_COMPANY_PATTERNS) {
                if (pattern.test(claim)) {
                    const nameMatch = claim.match(pattern);
                    if (nameMatch && !ALLOWED_CLIENTS.has(nameMatch[0].toLowerCase())) {
                        reasons.push(`broad_client_claim:${nameMatch[0]}`);
                    }
                }
            }
        }
    }

    // ── Sprint 5B.4: Checks 15-17 — Novel fabrication types ─────────────

    // Check 15: Revenue / financial claims not grounded in KB
    const financialMatch = aiResponse.match(/\b(?:revenue|turnover|profit|funded|series\s[a-d]|valuation|ipo|revenue of|annual revenue)\b.{0,40}\b\d/i);
    if (financialMatch && !kbLower.includes(financialMatch[0].toLowerCase())) {
        reasons.push('fabricated_financials');
    }

    // Check 16: Employee / team count claims (≥100) not grounded in KB
    const employeeMatch = aiResponse.match(/\b(\d{2,5})\s*(?:employee|staff|team member|people|professional|worker)s?\b/i);
    if (employeeMatch) {
        const claimed = parseInt(employeeMatch[1], 10);
        if (claimed >= 100 && !kbLower.includes(employeeMatch[0].toLowerCase())) {
            reasons.push('fabricated_team_size');
        }
    }

    // Check 17: Office / geography claims not grounded in KB
    // Matches both "office in Dubai" and "Dubai office" forms
    const geoPattern = /\b(?:office|branch|presence|headquarter(?:s|ed)?|located)\s+in\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+){0,2})/g;
    const geoPatternReverse = /\b([A-Z][a-z]+)\s+(?:office|branch|headquarters?)\b/g;
    const geoStopWords = new Set(['our', 'the', 'this', 'that', 'their', 'main', 'new', 'head', 'regional', 'local', 'central', 'corporate']);
    const geoLocations = new Set();
    let geoM;
    while ((geoM = geoPattern.exec(aiResponse)) !== null) geoLocations.add(geoM[1].toLowerCase());
    while ((geoM = geoPatternReverse.exec(aiResponse)) !== null) {
        const loc = geoM[1].toLowerCase();
        if (!geoStopWords.has(loc)) geoLocations.add(loc);
    }
    for (const loc of geoLocations) {
        if (!kbLower.includes(loc)) {
            reasons.push('fabricated_geography');
            break;
        }
    }

    // Check 18: Identity hallucination — model claims to be another AI entity
    // (e.g. "I'm Phi, an AI developed by Microsoft")
    if (/\b(?:i(?:'m| am)\s+(?:phi|chatgpt|gpt-?\d*|bard|gemini|claude|alexa|siri|cortana|copilot)|(?:developed|created|made|built)\s+by\s+(?:microsoft|openai|google|anthropic|amazon|apple))\b/i.test(aiResponse)) {
        reasons.push('identity_hallucination');
    }

    return {
        hallucinated: reasons.length > 0,
        reasons,
    };
}

/**
 * Returns the safe fallback response to use when hallucination is detected.
 * Picks based on conversation phase for natural flow.
 *
 * @param {string} conversationPhase
 * @param {string} callerName
 * @param {Object} [persona] - Persona config (optional)
 * @returns {string}
 */
function getHallucinationFallback(conversationPhase, callerName, persona, context = {}) {
    const name = callerName || '';
    const isEvent = persona?.flow?.callType === 'event';
    const company = persona?.company || 'our team';
    const questionType = classifyFallbackQuestion(context?.userQuestion);
    const bookingPhases = new Set(['offer', 'slot-collection', 'email-collection', 'email-verify']);
    const bookingContextActive = !!(
        context?.bookingIntentActive
        || context?.bookingActionThisTurn
        || context?.offerAccepted
        || context?.bookingPhoneDeliveryConsent
        || context?.bookingLinkRequested
        || context?.bookingLinkSent
    );
    const useBookingAwareCapabilityFallback = !isEvent
        && questionType === 'capability'
        && bookingPhases.has(conversationPhase)
        && bookingContextActive;

    if (!isEvent && questionType === 'pricing') {
        return 'Pricing depends on scope, stack, and timeline. Our solutions team can give you an accurate quote after a quick scoping call. What budget range should they plan around?';
    }
    if (!isEvent && questionType === 'location') {
        return 'We\'re headquartered in Noida, India, with delivery teams across India and client-facing teams globally. What else would you like to know before we schedule?';
    }
    if (!isEvent && questionType === 'identity') {
        const assistantName = persona?.name || 'an AI assistant';
        return `You're speaking with ${assistantName} from ${company}. What would you like to know before we schedule?`;
    }
    if (!isEvent && questionType === 'hearing_check') {
        return 'Yes, I can hear you. Sorry if that was unclear. What would you like me to clarify?';
    }
    if (!isEvent && questionType === 'off_topic') {
        return 'I can keep us focused on your project questions. What would you like to know about our services?';
    }
    if (useBookingAwareCapabilityFallback) {
        if (context?.bookingPhoneDeliveryConsent || context?.bookingLinkRequested || context?.bookingLinkSent || context?.userPhoneAvailable) {
            return 'Yes, we can help with that. I can text the booking link to this number now. Should I send it?';
        }
        if (context?.userEmailAvailable) {
            return 'Yes, we can help with that. I can send the booking link by email. Should I send it there now?';
        }
        return 'Yes, we can help with that. Should I text you the booking link, or would you prefer email?';
    }
    if (!isEvent && questionType === 'capability') {
        return 'Yes, we can help with that. Our solutions team can map the right approach for your requirement and answer the technical details. What part should they focus on?';
    }
    if (!isEvent && questionType === 'unclear') {
        return 'Sorry, I did not catch that clearly. Which website or platform features do you mean?';
    }

    if (conversationPhase === 'discovery' || conversationPhase === 'opening') {
        if (isEvent) {
            return name
                ? `Great question, ${name}! We cover that in the webinar with real examples. Can I send you the invite?`
                : `Great question! We cover that in the webinar with real examples. Can I send you the invite?`;
        }
        return name
            ? `That's a great topic, ${name}! Could you tell me a bit more about what you're looking for so I can point you to the right specialist?`
            : `That's a great topic! Could you tell me a bit more about what you're looking for so I can point you to the right specialist?`;
    }
    if (conversationPhase === 'offer' || conversationPhase === 'slot-collection') {
        if (isEvent) {
            return name
                ? `We go into that during the session, ${name}. Want me to save you a spot?`
                : `We go into that during the session. Want me to save you a spot?`;
        }
        return name
            ? `I'll make sure our team covers that in detail on the call, ${name}. What day works best for you?`
            : `I'll make sure our team covers that in detail on the call. What day works best for you?`;
    }
    if (isEvent) {
        return name
            ? `Our team can share more details on that, ${name}. I'll send a follow-up by email.`
            : `Our team can share more details on that. I'll send a follow-up by email.`;
    }
    return name
        ? `Our team can provide the specifics on that, ${name}. They'll follow up within 24 hours.`
        : `Our team can provide the specifics on that. They'll follow up within 24 hours.`;
}

module.exports = {
    isFactualQuestionWithoutKB,
    scanForHallucination,
    getHallucinationFallback,
    classifyFallbackQuestion,
};
