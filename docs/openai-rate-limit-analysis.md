# OpenAI Rate Limit Analysis & Optimization Recommendations

> Historical snapshot
>
> This analysis was written against an earlier runtime description and should not be used as the source of truth for current STT/TTS behavior. Current runtime truth is documented in `docs/runtime-dependency-map.md` and implemented in `services-twilio/realtimeServiceTwilio.js` and `services-plivo/realtimeServicePlivo.js`.

## Executive Summary

This document analyzes the VoiceBot codebase for OpenAI API usage patterns and provides actionable recommendations to reduce API calls and prevent rate limit exceeded errors.

---

## Current OpenAI API Usage Analysis

### 1. Primary OpenAI API Call Points

#### A. Hangup Decision Analysis (GPT-4o)
**Location:** [`Helper/hangupDecision.js`](Helper/hangupDecision.js:51)

**Usage Pattern:**
- Called after EVERY AI response (except excluded sentences)
- Model: `gpt-4o`
- Max tokens: 600
- Temperature: 0.1
- Response format: JSON

**Call Frequency:**
- **Twilio Service:** Line 371 in [`services-twilio/realtimeServiceTwilio.js`](services-twilio/realtimeServiceTwilio.js:371)
- **Plivo Service:** Line 201 in [`services-plivo/realtimeServicePlivo.js`](services-plivo/realtimeServicePlivo.js:201)

**Impact:**
- For a typical 10-turn conversation: 10 GPT-4o API calls
- With 10 concurrent calls: 100+ API calls per minute
- This is the PRIMARY cause of rate limit issues

#### B. Azure Realtime API (Voice Conversation)
**Location:** [`services-twilio/realtimeServiceTwilio.js`](services-twilio/realtimeServiceTwilio.js:67) and [`services-plivo/realtimeServicePlivo.js`](services-plivo/realtimeServicePlivo.js:58)

**Usage Pattern:**
- WebSocket connection to Azure Realtime API
- Handles STT (Whisper), LLM (GPT-4o-mini), and TTS in real-time
- Session updates after every user transcript

**Call Frequency:**
- Continuous streaming during active calls
- Session updates after each user input

**Impact:**
- While this is a streaming API, the session updates can contribute to rate limits
- The main issue is the hangup decision analysis calls

---

## Rate Limit Bottlenecks

### Critical Issue: Excessive Hangup Analysis Calls

**Problem:**
```javascript
// Called after EVERY AI response
let decision = await analyzeConversationForHangup(this.name, this.count, this.conversationContext);
```

**Example Scenario:**
- 5 active calls in progress
- Average 8 turns per call
- Total API calls: 5 × 8 = 40 GPT-4o calls in ~2-3 minutes
- This can easily exceed rate limits for lower-tier accounts

### Secondary Issues

1. **No Caching:** Identical conversation analyses are repeated
2. **No Throttling:** Multiple concurrent calls can spike API usage
3. **No Fallback Strategy:** No graceful degradation when rate limits are hit
4. **No Request Queuing:** All calls fire immediately without coordination

---

## Optimization Recommendations

### Priority 1: Implement Intelligent Hangup Analysis (IMMEDIATE)

#### Recommendation 1.1: Reduce Analysis Frequency

**Current:** Analyze after every AI response
**Proposed:** Analyze only at strategic points

```javascript
// Only analyze at key decision points
const shouldAnalyze = 
    this.count === 1 ||                              // First response
    this.count % 3 === 0 ||                          // Every 3rd response
    this.count >= 6 ||                               // After 6th response
    this.userEmail === null && this.count >= 3;      // No email yet after 3 turns

if (shouldAnalyze && !this.excludedSentences.includes(aiText)) {
    let decision = await analyzeConversationForHangup(...);
}
```

**Expected Impact:** 60-70% reduction in GPT-4o calls

#### Recommendation 1.2: Implement Rule-Based Pre-Filtering

**Add simple heuristics before calling LLM:**

```javascript
function quickHangupDecision(conversationContext, count) {
    // Rule 1: If user said "not interested" or "remove me"
    const lastUserMessage = conversationContext
        .filter(msg => msg.sender === 'USER')
        .slice(-1)[0]?.message?.toLowerCase() || '';
    
    const rejectionPhrases = [
        'not interested', 'no thanks', 'remove me', 'pass',
        'nicht interessiert', 'nein danke', 'kein interesse'
    ];
    
    if (rejectionPhrases.some(phrase => lastUserMessage.includes(phrase))) {
        return { shouldHangup: true, reason: 'rejected', confidence: 0.95 };
    }
    
    // Rule 2: If voicemail detected (one-way communication)
    const userMessages = conversationContext.filter(msg => msg.sender === 'USER');
    const aiMessages = conversationContext.filter(msg => msg.sender === 'AI');
    
    if (userMessages.length === 0 && aiMessages.length >= 1) {
        return { shouldHangup: true, reason: 'voicemail', confidence: 0.9 };
    }
    
    // Rule 3: If email confirmed, hangup on next turn
    const lastAIMessage = aiMessages.slice(-1)[0]?.message?.toLowerCase() || '';
    const lastUserConfirmation = userMessages.slice(-1)[0]?.message?.toLowerCase() || '';
    
    if (lastAIMessage.includes('@') && 
        ['yes', 'yeah', 'correct', 'right', 'ja', 'stimmt', 'danke']
            .some(affirmation => lastUserConfirmation.includes(affirmation))) {
        return { shouldHangup: true, reason: 'success', confidence: 0.95 };
    }
    
    // Default: No decision, need LLM analysis
    return null;
}

// Usage in realtimeService
if (!this.excludedSentences.includes(aiText)) {
    // Try quick decision first
    const quickDecision = quickHangupDecision(this.conversationContext, this.count);
    
    if (quickDecision && quickDecision.confidence > 0.8) {
        console.log('[Quick Decision]:', quickDecision);
        this.emit('decision', quickDecision);
    } else {
        // Fall back to LLM analysis
        let decision = await analyzeConversationForHangup(...);
    }
}
```

**Expected Impact:** 40-50% additional reduction in GPT-4o calls

#### Recommendation 1.3: Use Cheaper Model for Analysis

**Current:** `gpt-4o`
**Proposed:** `gpt-4o-mini` or `gpt-3.5-turbo`

```javascript
const response = await azureOpenAI.chat.completions.create({
    model: "gpt-4o-mini",  // 10x cheaper than gpt-4o
    // ... rest of config
});
```

**Expected Impact:** 90% cost reduction for hangup analysis

### Priority 2: Implement Request Throttling & Queuing

#### Recommendation 2.1: Add Request Queue with Rate Limiting

```javascript
// Utils/rateLimiter.js
class RateLimiter {
    constructor(maxConcurrent, maxPerMinute) {
        this.maxConcurrent = maxConcurrent;
        this.maxPerMinute = maxPerMinute;
        this.activeRequests = 0;
        this.requestTimestamps = [];
        this.queue = [];
    }
    
    async execute(fn) {
        // Wait if too many concurrent requests
        while (this.activeRequests >= this.maxConcurrent) {
            await this.sleep(100);
        }
        
        // Wait if rate limit exceeded
        const now = Date.now();
        const oneMinuteAgo = now - 60000;
        this.requestTimestamps = this.requestTimestamps.filter(t => t > oneMinuteAgo);
        
        while (this.requestTimestamps.length >= this.maxPerMinute) {
            await this.sleep(1000);
            this.requestTimestamps = this.requestTimestamps.filter(t => Date.now() - t < 60000);
        }
        
        this.activeRequests++;
        this.requestTimestamps.push(Date.now());
        
        try {
            return await fn();
        } finally {
            this.activeRequests--;
        }
    }
    
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// Usage in hangupDecision.js
const rateLimiter = new RateLimiter(3, 20); // Max 3 concurrent, 20 per minute

async function analyzeConversationForHangup(...) {
    return rateLimiter.execute(async () => {
        // Original implementation
        const response = await azureOpenAI.chat.completions.create({...});
        // ...
    });
}
```

#### Recommendation 2.2: Implement Exponential Backoff

```javascript
async function analyzeConversationWithRetry(name, count, conversationContext, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await analyzeConversationForHangup(name, count, conversationContext);
        } catch (error) {
            if (error.status === 429 && attempt < maxRetries) {
                const delay = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
                console.log(`Rate limited. Retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                throw error;
            }
        }
    }
}
```

### Priority 3: Implement Caching

#### Recommendation 3.1: Cache Similar Conversation Patterns

```javascript
// Utils/conversationCache.js
const NodeCache = require('node-cache');
const cache = new NodeCache({ stdTTL: 300 }); // 5 minute TTL

function getCacheKey(conversationContext, count) {
    const recentMessages = conversationContext
        .slice(-3)
        .map(msg => `${msg.sender}:${msg.message.substring(0, 50)}`)
        .join('|');
    return `${count}:${recentMessages}`;
}

async function analyzeWithCache(name, count, conversationContext) {
    const cacheKey = getCacheKey(conversationContext, count);
    const cached = cache.get(cacheKey);
    
    if (cached) {
        console.log('[Cache Hit]: Using cached decision');
        return cached;
    }
    
    const decision = await analyzeConversationForHangup(name, count, conversationContext);
    cache.set(cacheKey, decision);
    return decision;
}
```

### Priority 4: Optimize Azure Realtime API Usage

#### Recommendation 4.1: Reduce Session Update Frequency

```javascript
// Only update session instructions every 2-3 turns
insertUpdatedPrompt(userQuestion) {
    if (this.count % 2 !== 0) {
        console.log('[RealtimeService] Skipping session update (every 2nd turn)');
        return;
    }
    // ... rest of implementation
}
```

#### Recommendation 4.2: Reduce Token Limits

```javascript
// In handleOpen()
session: {
    max_response_output_tokens: 400,  // Reduced from 600/800
    temperature: 0.6,                 // Reduced from 0.7
    // ...
}
```

---

## Implementation Priority

### Phase 1: Quick Wins (Implement Today)
1. ✅ Reduce hangup analysis frequency (every 3rd turn)
2. ✅ Add rule-based pre-filtering
3. ✅ Switch to gpt-4o-mini for hangup analysis
4. ✅ Add exponential backoff

**Expected Impact:** 80-90% reduction in API calls

### Phase 2: Robustness (Implement This Week)
1. ✅ Implement request queue with rate limiting
2. ✅ Add conversation pattern caching
3. ✅ Reduce session update frequency

**Expected Impact:** Additional 10-15% reduction, better stability

### Phase 3: Advanced Optimization (Implement Next Sprint)
1. ✅ Implement batch analysis for multiple calls
2. ✅ Add telemetry for API usage monitoring
3. ✅ Consider alternative models for specific tasks

---

## Monitoring & Alerting

### Add API Usage Tracking

```javascript
// Utils/apiUsageTracker.js
class APIUsageTracker {
    constructor() {
        this.calls = {
            gpt4o: 0,
            gpt4oMini: 0,
            realtime: 0
        };
        this.errors = {
            rateLimit: 0,
            other: 0
        };
    }
    
    trackCall(model) {
        this.calls[model]++;
    }
    
    trackError(error) {
        if (error.status === 429) {
            this.errors.rateLimit++;
        } else {
            this.errors.other++;
        }
    }
    
    getStats() {
        return {
            calls: this.calls,
            errors: this.errors,
            total: Object.values(this.calls).reduce((a, b) => a + b, 0)
        };
    }
}

const tracker = new APIUsageTracker();

// Log stats every minute
setInterval(() => {
    console.log('[API Usage Stats]', tracker.getStats());
}, 60000);
```

---

## Configuration Recommendations

### Environment Variables

Add to [`.env`](.env.example):

```bash
# OpenAI Rate Limiting
OPENAI_MAX_CONCURRENT=3
OPENAI_MAX_PER_MINUTE=20
OPENAI_HANGUP_ANALYSIS_INTERVAL=3  # Analyze every Nth turn
OPENAI_USE_MINI_MODEL=true

# Cache Configuration
CONVERSATION_CACHE_TTL=300  # 5 minutes
```

---

## Expected Results

### Before Optimization
- **Calls per conversation:** ~10 GPT-4o calls
- **Cost per conversation:** ~$0.50-1.00
- **Rate limit errors:** Frequent during peak usage

### After Phase 1 Optimization
- **Calls per conversation:** ~2-3 GPT-4o-mini calls
- **Cost per conversation:** ~$0.03-0.05
- **Rate limit errors:** Eliminated
- **Cost savings:** 90-95%

### After All Phases
- **Calls per conversation:** ~1-2 GPT-4o-mini calls
- **Cost per conversation:** ~$0.02-0.03
- **Rate limit errors:** Eliminated
- **Cost savings:** 95-97%

---

## Conclusion

The primary cause of OpenAI rate limit issues in this VoiceBot is the excessive frequency of hangup decision analysis calls. By implementing the recommended optimizations, particularly reducing analysis frequency and adding rule-based pre-filtering, you can achieve:

1. **80-90% reduction in API calls** (Phase 1)
2. **95-97% cost reduction** (All phases)
3. **Elimination of rate limit errors**
4. **Improved system stability**

The most impactful changes can be implemented quickly and will provide immediate relief from rate limit issues.

---

## Next Steps

1. Review and approve recommendations
2. Implement Phase 1 optimizations
3. Monitor API usage metrics
4. Implement Phase 2 and 3 as needed
5. Establish ongoing monitoring and alerting
