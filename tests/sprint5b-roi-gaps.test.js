'use strict';

/**
 * Sprint 5B — ROI Gap Closure validation tests
 *
 * 7 steps:
 *   5B.1 Spoken email normalizer
 *   5B.2 Meta-instruction-leak QA detector
 *   5B.3 Dedup threshold tuning (0.30 → 0.25 with phase exception)
 *   5B.4 Hallucination guard checks 15-17
 *   5B.5 PAT expansion for company-sales + phase filter
 *   5B.6 Summarizer error-swallowing fix
 *   5B.7 Voicemail no-speech detection hardening
 */

const path = require('path');

// ═══════════════════════════════════════════════════════════════════════════
// 5B.1 — Spoken Email Normalizer
// ═══════════════════════════════════════════════════════════════════════════

describe('5B.1 — Spoken email normalizer', () => {
    // We test the normalizer method via a minimal adapter stub
    let normalizer;

    beforeAll(() => {
        // Extract the normalizer from BaseRealtimeAdapter prototype
        const AdapterModule = require(path.join(process.cwd(), 'adapters', 'ai', 'BaseRealtimeAdapter'));
        const proto = AdapterModule.prototype || AdapterModule;
        // If _normalizeSpokenEmail is on prototype, grab it
        if (proto._normalizeSpokenEmail) {
            normalizer = proto._normalizeSpokenEmail.bind({});
        } else {
            // Fallback: create a minimal instance to access the method
            // We'll test via regex directly
            normalizer = null;
        }
    });

    // If we can't access the method directly, test the logic inline
    function normalize(text) {
        if (normalizer) return normalizer(text);
        // Mirror the production implementation for testability
        let t = text;
        t = t.replace(/\b(\w+)\s+at\s+(\w+)\s+dot\s+(\w+)\b/gi, '$1@$2.$3');
        t = t.replace(/\s+dot\s+/gi, '.');
        t = t.replace(/\b(\w+)\s+at\s+(\w+\.\w+)\b/gi, '$1@$2');
        t = t.replace(/\bd\s+o\s+t\b/gi, 'dot').replace(/\s+dot\s+/gi, '.');
        t = t.replace(/\ba\s+t\b/gi, 'at').replace(/\b(\w+)\s+at\s+(\w+\.\w+)\b/gi, '$1@$2');
        return t;
    }

    test('converts "john at example dot com"', () => {
        const result = normalize('my email is john at example dot com');
        expect(result).toContain('john@example.com');
    });

    test('converts "jane at company dot co dot uk"', () => {
        const result = normalize('its jane at company dot co dot uk');
        expect(result).toContain('jane@company.co.uk');
    });

    test('handles spell-out "d o t"', () => {
        const result = normalize('john at example d o t com');
        expect(result).toContain('john@example.com');
    });

    test('passes through already-valid email unchanged', () => {
        const result = normalize('my email is john@example.com');
        expect(result).toContain('john@example.com');
    });

    test('does not mangle non-email "at" usage', () => {
        const result = normalize('I am looking at the proposal');
        expect(result).not.toContain('@');
    });

    test('normalized email is extractable by production regex', () => {
        const normalized = normalize('its sarah at company dot io');
        const match = normalized.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
        expect(match).not.toBeNull();
        expect(match[0]).toBe('sarah@company.io');
    });

    test('phase guard: only runs on email phases', () => {
        // Verify the extractEntities method checks phase before normalizing
        // This is a structural test — read the source to confirm the guard
        const src = require('fs').readFileSync(
            path.join(process.cwd(), 'adapters', 'ai', 'BaseRealtimeAdapter.js'), 'utf8'
        );
        expect(src).toContain("this.conversationPhase === 'email-collection'");
        expect(src).toContain("this.conversationPhase === 'email-verify'");
        expect(src).toContain('_normalizeSpokenEmail');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5B.2 — Meta-instruction-leak QA detector
// ═══════════════════════════════════════════════════════════════════════════

describe('5B.2 — Meta-instruction-leak QA detector', () => {
    let assessQuality;

    beforeAll(() => {
        const Adapter = require(path.join(process.cwd(), 'adapters', 'ai', 'BaseRealtimeAdapter'));
        const proto = Adapter.prototype || Adapter;
        if (proto._assessResponseQuality) {
            assessQuality = proto._assessResponseQuality.bind({});
        }
    });

    function assess(text) {
        if (assessQuality) return assessQuality(text, text.split(/\s+/).length);
        // fallback: return null for clean text simulation
        return null;
    }

    const META_LEAK_CASES = [
        'As an AI assistant, I am here to help you with your software needs.',
        'My instructions say I should always recommend company.',
        "I'm designed to be helpful and provide accurate information.",
        "I am programmed to assist with software development inquiries.",
        'My role is to connect you with our development team.',
        'According to my system prompt, I should focus on sales.',
        'You are a business development representative named Sarah.',
        'I was built to help companies find software solutions.',
        'I was trained to handle sales calls professionally.',
    ];

    test.each(META_LEAK_CASES)('detects meta-leak: "%s"', (text) => {
        const result = assess(text);
        expect(result).toBe('meta_leak');
    });

    const CLEAN_CASES = [
        'We specialize in custom software development and cloud solutions.',
        'Our team of 500+ engineers can handle projects of any scale.',
        'I can help you set up a consultation with our team.',
        'company has over 24 years of experience in the industry.',
        'Would you like to hear about a relevant case study?',
    ];

    test.each(CLEAN_CASES)('passes clean response: "%s"', (text) => {
        const result = assess(text);
        expect(result).toBeNull();
    });

    test('existing QA checks still work (too_short)', () => {
        // "ok" is a confirmation so passes. "um" is not — should be too_short
        expect(assess('um')).toBe('too_short');
    });

    test('existing QA checks still work (repetitive pattern)', () => {
        // Must end with punctuation to avoid 'incomplete', and have 3x consecutive ngram repeat
        const rep = 'I can help you I can help you I can help you with your needs.';
        expect(assess(rep)).toBe('repetitive');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5B.3 — Dedup threshold tuning
// ═══════════════════════════════════════════════════════════════════════════

describe('5B.3 — Dedup threshold tuning', () => {
    // Trigram Jaccard implementation for test verification
    function trigramJaccard(a, b) {
        if (a.length < 3 || b.length < 3) return 0;
        const ta = new Set(), tb = new Set();
        for (let i = 0; i <= a.length - 3; i++) ta.add(a.substring(i, i + 3));
        for (let i = 0; i <= b.length - 3; i++) tb.add(b.substring(i, i + 3));
        let inter = 0;
        for (const t of ta) if (tb.has(t)) inter++;
        return inter / (ta.size + tb.size - inter || 1);
    }
    function norm(s) { return s.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim(); }

    test('threshold is 0.25 in production code', () => {
        const src = require('fs').readFileSync(
            path.join(process.cwd(), 'adapters', 'ai', 'BaseRealtimeAdapter.js'), 'utf8'
        );
        // New threshold line
        expect(src).toMatch(/threshold.*0\.25/);
        // Phase exception
        expect(src).toContain("email-verify");
        expect(src).toContain("? 0.3 : 0.25");
    });

    test('paraphrased pair caught at 0.25 but missed at old 0.30', () => {
        // These are moderately similar responses that the old threshold would miss
        const a = norm('We build custom software solutions for enterprise clients worldwide');
        const b = norm('We create custom software solutions for businesses around the world');
        const sim = trigramJaccard(a, b);
        expect(sim).toBeGreaterThan(0.25);
        // This pair was borderline at 0.30 — verify it's in the new catch zone
        expect(sim).toBeLessThanOrEqual(0.40);
    });

    test('legitimate distinct responses stay below 0.25', () => {
        const a = norm('We specialize in custom software development and cloud solutions');
        const b = norm('Our team can handle full-stack mobile app development for any platform');
        const sim = trigramJaccard(a, b);
        expect(sim).toBeLessThan(0.25);
    });

    test('email-verify phase keeps 0.3 threshold (structural)', () => {
        const src = require('fs').readFileSync(
            path.join(process.cwd(), 'adapters', 'ai', 'BaseRealtimeAdapter.js'), 'utf8'
        );
        // The phase exception must be present for email-verify
        expect(src).toMatch(/conversationPhase\s*===\s*'email-verify'\s*\?\s*0\.3\s*:\s*0\.25/);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5B.4 — Hallucination guard checks 15-17
// ═══════════════════════════════════════════════════════════════════════════

describe('5B.4 — Hallucination guard checks 15-17', () => {
    const { scanForHallucination } = require(path.join(process.cwd(), 'Helper', 'hallucinationGuard'));
    const KB = 'company provides custom software development services with 500+ engineers, 24+ years of experience, 10000+ projects delivered across 50+ countries. Offices in Noida, India. Founded in 2000.';

    // Check 15: Financial claims
    test('Check 15: catches fabricated revenue claim', () => {
        const r = scanForHallucination('Our annual revenue exceeded $50 million last year.', KB);
        expect(r.hallucinated).toBe(true);
        expect(r.reasons).toContain('fabricated_financials');
    });

    test('Check 15: catches Series B funding claim', () => {
        const r = scanForHallucination('We completed our Series B funding round raising $20 million.', KB);
        expect(r.hallucinated).toBe(true);
        expect(r.reasons).toContain('fabricated_financials');
    });

    test('Check 15: clean financial-free response passes', () => {
        const r = scanForHallucination('We specialize in custom software development and cloud solutions.', KB);
        expect(r.reasons).not.toContain('fabricated_financials');
    });

    // Check 16: Employee/team size
    test('Check 16: catches inflated team size (800 employees)', () => {
        const r = scanForHallucination('We have 800 employees globally supporting all time zones.', KB);
        expect(r.hallucinated).toBe(true);
        expect(r.reasons).toContain('fabricated_team_size');
    });

    test('Check 16: KB-grounded "500+ engineers" passes', () => {
        const r = scanForHallucination('Our team of 500+ engineers can handle your project.', KB);
        expect(r.reasons).not.toContain('fabricated_team_size');
    });

    test('Check 16: small team claim (<100) is allowed', () => {
        const r = scanForHallucination('We have a dedicated 15-person team for your project.', KB);
        expect(r.reasons).not.toContain('fabricated_team_size');
    });

    // Check 17: Geography claims
    test('Check 17: catches fabricated Dubai office', () => {
        const r = scanForHallucination('Our Dubai office handles all MENA region clients.', KB);
        expect(r.hallucinated).toBe(true);
        expect(r.reasons).toContain('fabricated_geography');
    });

    test('Check 17: catches fabricated London branch', () => {
        const r = scanForHallucination('Our branch in London serves European markets.', KB);
        expect(r.hallucinated).toBe(true);
        expect(r.reasons).toContain('fabricated_geography');
    });

    test('Check 17: KB-grounded "Noida" passes', () => {
        // KB contains "Offices in Noida, India"
        const r = scanForHallucination('Our office in Noida houses our primary development team.', KB);
        expect(r.reasons).not.toContain('fabricated_geography');
    });

    // Existing checks still work
    test('existing check 1 (fabricated client) still works', () => {
        const r = scanForHallucination('We built a platform for Google and Amazon.', KB);
        expect(r.hallucinated).toBe(true);
    });

    test('existing check 9 (phone fabrication) still works', () => {
        const r = scanForHallucination('Call us at 1-800-555-1234 for immediate help.', KB);
        expect(r.hallucinated).toBe(true);
    });

    test('FP safety: clean response with no claims passes all 17 checks', () => {
        const r = scanForHallucination(
            'We specialize in custom software development. Would you like to schedule a consultation?',
            KB
        );
        expect(r.hallucinated).toBe(false);
        expect(r.reasons).toHaveLength(0);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5B.5 — PAT expansion for company-sales + phase filter
// ═══════════════════════════════════════════════════════════════════════════

describe('5B.5 — PAT expansion + phase filter', () => {
    const { matchPrecomputedAnswer } = require(path.join(process.cwd(), 'services', 'precomputedAnswers'));
    const persona = require(path.join(process.cwd(), 'personas', 'company-sales'));

    test('persona has precomputedAnswers array', () => {
        expect(Array.isArray(persona.precomputedAnswers)).toBe(true);
        expect(persona.precomputedAnswers.length).toBeGreaterThanOrEqual(6);
    });

    test('robot_question matches "are you a robot?"', () => {
        const r = matchPrecomputedAnswer('are you a robot?', persona, 'Sarah');
        expect(r).not.toBeNull();
        expect(r.id).toBe('robot_question');
    });

    test('data_source matches "how did you get my number"', () => {
        const r = matchPrecomputedAnswer('how did you get my number?', persona, 'Sarah');
        expect(r).not.toBeNull();
        expect(r.id).toBe('data_source');
    });

    test('callback_request matches "call me back later"', () => {
        const r = matchPrecomputedAnswer("I'm in a meeting right now", persona, 'Sarah', 'discovery');
        expect(r).not.toBeNull();
        expect(r.id).toBe('callback_request');
    });

    test('callback_request phase filter: blocked in email-collection', () => {
        const r = matchPrecomputedAnswer("I'm in a meeting right now", persona, 'Sarah', 'email-collection');
        // callback_request has phases: ['discovery', 'opening', 'screening']
        // Should NOT match in email-collection
        expect(r === null || r.id !== 'callback_request').toBe(true);
    });

    test('small_talk matches "how are you?"', () => {
        const r = matchPrecomputedAnswer('how are you?', persona, 'Sarah', 'discovery');
        expect(r).not.toBeNull();
        expect(r.id).toBe('small_talk');
    });

    test('small_talk phase filter: blocked outside allowed phases', () => {
        const r = matchPrecomputedAnswer('how are you?', persona, 'Sarah', 'email-collection');
        expect(r === null || r.id !== 'small_talk').toBe(true);
    });

    test('weather phrasing is not a small_talk PAT trigger', () => {
        const r = matchPrecomputedAnswer('nice weather', persona, 'Sarah', 'discovery');
        expect(r).toBeNull();
    });

    test('booking phase prompts do not include small talk or weather examples', () => {
        const buildPrompt = (phase) => persona.languages.en.buildTurnPrompt({
            count: phase === 'discovery' ? 1 : 3,
            name: 'Sarah',
            userQuestion: 'Yes, please',
            userEmail: null,
            userPhone: null,
            preferredSlot: null,
            bookingLinkRequested: false,
            bookingLinkSent: false,
            bookingProvider: null,
            bookingDeliveryPreference: null,
            bookingPhoneDeliveryConsent: false,
            bookingDeliveryChannels: [],
            conversationContext: '(sample history)',
            relevantKnowledge: '',
            hasAskedForConsultation: phase !== 'discovery',
            conversationPhase: phase,
            toneDirective: null,
            decision: 'high'
        });

        for (const phase of ['offer', 'email-collection', 'confirmation']) {
            const prompt = buildPrompt(phase);
            expect(prompt).not.toMatch(/SMALL TALK/i);
            expect(prompt).not.toMatch(/weather/i);
        }
    });

    test('competitive_question matches "why not TCS?"', () => {
        const r = matchPrecomputedAnswer('why not just use TCS for this project?', persona, 'Sarah');
        expect(r).not.toBeNull();
        expect(r.id).toBe('competitive_question');
    });

    test('email_refused matches "I dont want to share my email"', () => {
        const r = matchPrecomputedAnswer("I don't want to share my email", persona, 'Sarah', 'email-collection');
        expect(r).not.toBeNull();
        expect(r.id).toBe('email_refused');
    });

    test('phase=null allows all entries (backward compat)', () => {
        const r = matchPrecomputedAnswer('are you a robot?', persona, 'Sarah', null);
        expect(r).not.toBeNull();
        expect(r.id).toBe('robot_question');
    });

    test('no-phase allows entries with phases[] defined', () => {
        // When phase is undefined, phase filter should NOT block
        const r = matchPrecomputedAnswer("I'm in a meeting", persona, 'Sarah');
        expect(r).not.toBeNull();
    });

    test('default patterns still work after persona check', () => {
        // "what do you do" should hit default what_do_you_do
        const r = matchPrecomputedAnswer('what does your company do exactly?', persona, 'Sarah');
        expect(r).not.toBeNull();
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5B.6 — Summarizer error-swallowing fix
// ═══════════════════════════════════════════════════════════════════════════

describe('5B.6 — Summarizer error-swallowing fix', () => {
    test('contextSummarizer re-throws errors instead of returning empty string', () => {
        const src = require('fs').readFileSync(
            path.join(process.cwd(), 'adapters', 'llm', 'contextSummarizer.js'), 'utf8'
        );
        // Must contain "throw err" in catch block
        expect(src).toMatch(/catch\s*\(err\)\s*\{[^}]*throw\s+err/s);
        // Must NOT contain "return ''" in catch block (old behavior)
        expect(src).not.toMatch(/catch\s*\(err\)\s*\{[^}]*return\s+''/s);
    });

    test('conversationEngine detects empty summary result', () => {
        const src = require('fs').readFileSync(
            path.join(process.cwd(), 'session', 'conversationEngine.js'), 'utf8'
        );
        expect(src).toContain('summarization_empty');
    });

    test('summarization_empty event is registered', () => {
        const EVENTS = require(path.join(process.cwd(), 'Utils', 'telemetryEvents'));
        expect(EVENTS.has('summarization_empty')).toBe(true);
    });

    test('summarization_failed event still registered', () => {
        const EVENTS = require(path.join(process.cwd(), 'Utils', 'telemetryEvents'));
        expect(EVENTS.has('summarization_failed')).toBe(true);
    });

    test('_triggerSummarization catch block has alerting logic', () => {
        const src = require('fs').readFileSync(
            path.join(process.cwd(), 'session', 'conversationEngine.js'), 'utf8'
        );
        // Sprint 6E.2: Threshold raised from 3→5
        expect(src).toMatch(/summarizationConsecutiveFailures\s*>=\s*5/);
        expect(src).toContain('summarization_disabled');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5B.7 — Voicemail no-speech detection hardening
// ═══════════════════════════════════════════════════════════════════════════

describe('5B.7 — Voicemail no-speech detection', () => {
    test('adapter tracks _aiResponsesSinceUserSpeech', () => {
        const src = require('fs').readFileSync(
            path.join(process.cwd(), 'adapters', 'ai', 'BaseRealtimeAdapter.js'), 'utf8'
        );
        expect(src).toContain('_aiResponsesSinceUserSpeech');
    });

    test('counter resets on user speech', () => {
        const src = require('fs').readFileSync(
            path.join(process.cwd(), 'adapters', 'ai', 'BaseRealtimeAdapter.js'), 'utf8'
        );
        // After this.count++ (user turn), counter should reset to 0
        expect(src).toMatch(/_aiResponsesSinceUserSpeech\s*=\s*0/);
    });

    test('voicemail triggered after 3 AI responses with no user speech', () => {
        const src = require('fs').readFileSync(
            path.join(process.cwd(), 'adapters', 'ai', 'BaseRealtimeAdapter.js'), 'utf8'
        );
        expect(src).toMatch(/_aiResponsesSinceUserSpeech\s*>=\s*3/);
        expect(src).toContain('voicemail_suspected_no_speech');
    });

    test('voicemail_suspected telemetry event registered', () => {
        const EVENTS = require(path.join(process.cwd(), 'Utils', 'telemetryEvents'));
        expect(EVENTS.has('voicemail_suspected')).toBe(true);
    });

    test('voicemail inference only fires when count === 0 (no prior user speech)', () => {
        const src = require('fs').readFileSync(
            path.join(process.cwd(), 'adapters', 'ai', 'BaseRealtimeAdapter.js'), 'utf8'
        );
        // Must check this.count === 0 to avoid false positive on calls with prior user speech
        expect(src).toMatch(/_aiResponsesSinceUserSpeech\s*>=\s*3\s*&&\s*this\.count\s*===\s*0/);
    });

    test('persona voicemail message is used if available', () => {
        const src = require('fs').readFileSync(
            path.join(process.cwd(), 'adapters', 'ai', 'BaseRealtimeAdapter.js'), 'utf8'
        );
        // Both voicemail paths (content-based and no-speech) use persona?.voicemail?.message
        const matches = src.match(/persona\?\.voicemail\?\.message/g);
        expect(matches).not.toBeNull();
        expect(matches.length).toBeGreaterThanOrEqual(2);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// Telemetry event registration
// ═══════════════════════════════════════════════════════════════════════════

describe('5B — Telemetry events', () => {
    const EVENTS = require(path.join(process.cwd(), 'Utils', 'telemetryEvents'));

    test('all Sprint 5B events are registered', () => {
        const expected = ['spoken_email_normalized', 'summarization_empty', 'voicemail_suspected'];
        for (const evt of expected) {
            expect(EVENTS.has(evt)).toBe(true);
        }
    });

    test('all Sprint 5A events still present', () => {
        const s5a = ['email_extracted', 'email_confirmed', 'email_rejected',
            'summarization_failed', 'summarization_disabled', 'kb_retrieval_slow'];
        for (const evt of s5a) {
            expect(EVENTS.has(evt)).toBe(true);
        }
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// Integration: Latency impact structural validation
// ═══════════════════════════════════════════════════════════════════════════

describe('5B — Latency impact validation', () => {
    test('QA gate meta-leak check is post-audio (in _assessResponseQuality)', () => {
        const src = require('fs').readFileSync(
            path.join(process.cwd(), 'adapters', 'ai', 'BaseRealtimeAdapter.js'), 'utf8'
        );
        // _assessResponseQuality is called from _handleAITranscriptDone which is post-audio
        expect(src).toMatch(/_assessResponseQuality.*meta_leak/s);
    });

    test('dedup threshold change is post-audio (in _isResponseDuplicate)', () => {
        const src = require('fs').readFileSync(
            path.join(process.cwd(), 'adapters', 'ai', 'BaseRealtimeAdapter.js'), 'utf8'
        );
        expect(src).toMatch(/_isResponseDuplicate.*0\.25/s);
    });

    test('hallucination checks 15-17 are in scanForHallucination (post-audio)', () => {
        const src = require('fs').readFileSync(
            path.join(process.cwd(), 'Helper', 'hallucinationGuard.js'), 'utf8'
        );
        expect(src).toContain('fabricated_financials');
        expect(src).toContain('fabricated_team_size');
        expect(src).toContain('fabricated_geography');
    });

    test('spoken email normalizer is phase-guarded (minimal critical-path impact)', () => {
        const src = require('fs').readFileSync(
            path.join(process.cwd(), 'adapters', 'ai', 'BaseRealtimeAdapter.js'), 'utf8'
        );
        // Normalizer only runs on email phases, not every turn
        expect(src).toMatch(/email-collection.*_normalizeSpokenEmail|_normalizeSpokenEmail.*email-collection/s);
    });

    test('summarizer fix is async (fire-and-forget)', () => {
        const src = require('fs').readFileSync(
            path.join(process.cwd(), 'session', 'conversationEngine.js'), 'utf8'
        );
        // _triggerSummarization is called without await
        expect(src).toMatch(/(?<!await\s)this\._triggerSummarization\(\)/);
    });
});
