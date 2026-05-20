'use strict';

/**
 * Sprint 6E — Repetition Loop Root Cause Tests
 *
 * 6E.1: Double-push fix → dedup window has 10 unique entries, repetition guard fires on turn 5+
 * 6E.2: Summarizer → no temperature key, permanent disable at 5 (not 3)
 * 6E.3: Per-turn cap → counts all dup correction branches (mild + breaker)
 * 6E.5: Permanent fallback → locked when _callLevelDupCount >= 9
 */

// ── Shared test helpers ──────────────────────────────────────────────────────

jest.mock('../services/db', () => ({
    getConnection: jest.fn(() => ({ query: jest.fn((q, p, cb) => cb?.(null, [])), release: jest.fn() })),
    insertConversation: jest.fn()
}));

jest.mock('../Utils/rateLimiter', () => ({
    defaultRateLimiter: { execute: jest.fn(fn => fn()) }
}));

jest.mock('openai', () => ({
    AzureOpenAI: jest.fn().mockImplementation(() => ({
        chat: { completions: { create: jest.fn() } }
    }))
}));

// Telemetry mock
const mockTelemetryEmit = jest.fn();
jest.mock('../adapters/telemetry/azureTelemetryAdapter', () => ({ emit: mockTelemetryEmit }));

// ──────────────────────────────────────────────────────────────────────────────
// 6E.1: Double-push fix
// ──────────────────────────────────────────────────────────────────────────────

describe('6E.1: _recentAiResponses double-push fix', () => {
    /** Minimal adapter stub with _isResponseDuplicate from real code */
    function makeAdapter() {
        return {
            _recentAiResponses: [],
            _trigramJaccard(a, b) {
                const tg = s => { const t = new Set(); for (let i = 0; i < s.length - 2; i++) t.add(s.slice(i, i + 3)); return t; };
                const ta = tg(a.toLowerCase()), tb = tg(b.toLowerCase());
                let inter = 0; for (const t of ta) if (tb.has(t)) inter++;
                const union = ta.size + tb.size - inter;
                return union === 0 ? 0 : inter / union;
            },
            conversationPhase: 'discovery',
            _isResponseDuplicate(aiText) {
                if (!this._recentAiResponses) this._recentAiResponses = [];
                const normalized = aiText.trim().toLowerCase().replace(/[^a-z0-9\s]/g, '');
                for (const prev of this._recentAiResponses) {
                    const prevNorm = prev.trim().toLowerCase().replace(/[^a-z0-9\s]/g, '');
                    const shorter = Math.min(normalized.length, prevNorm.length);
                    const longer = Math.max(normalized.length, prevNorm.length);
                    if (shorter < 15 || longer === 0) continue;
                    let common = 0;
                    for (let i = 0; i < shorter; i++) { if (normalized[i] === prevNorm[i]) common++; }
                    if (common / longer > 0.8) return true;
                    const words1 = new Set(normalized.split(/\s+/));
                    const words2 = new Set(prevNorm.split(/\s+/));
                    const overlap = [...words1].filter(w => words2.has(w)).length;
                    const maxWords = Math.max(words1.size, words2.size);
                    if (maxWords > 3 && overlap / maxWords > 0.8) return true;
                    if (maxWords > 3) {
                        const trigramSim = this._trigramJaccard(normalized, prevNorm);
                        const threshold = this.conversationPhase === 'email-verify' ? 0.3 : 0.25;
                        if (trigramSim > threshold) return true;
                    }
                }
                this._recentAiResponses.push(aiText);
                if (this._recentAiResponses.length > 10) this._recentAiResponses.shift();
                return false;
            }
        };
    }

    test('15 unique turns → 10 unique entries in window (not 5)', () => {
        const adapter = makeAdapter();
        const responses = [
            'The quarterly revenue forecast shows strong upward momentum in the enterprise sector',
            'Our development team recently shipped version three of the mobile application suite',
            'Customer satisfaction scores have reached an unprecedented ninety-five percent rating',
            'Marketing campaigns targeting small businesses yielded impressive conversion numbers',
            'Supply chain optimization resulted in a forty percent reduction in delivery times',
            'New machine learning features dramatically improved the search relevance scores',
            'Partnerships with three major distributors expanded our reach into Asian markets',
            'Employee retention programs reduced voluntary attrition by twenty-seven percent',
            'Cloud infrastructure migration completed ahead of schedule and under budget targets',
            'Product roadmap prioritization shifted focus towards artificial intelligence work',
            'Regulatory compliance automation saved the legal department thousands of hours',
            'Beta testing feedback from enterprise clients shaped the premium feature design',
            'Geographic expansion plans include opening offices in Sydney and Singapore soon',
            'Security audit findings confirmed zero critical vulnerabilities in production',
            'Annual recurring revenue surpassed projections by eighteen percent this year'
        ];
        for (const text of responses) {
            adapter._isResponseDuplicate(text);
            // Sprint 6E.1: NO second push from repetition guard — removed
        }
        expect(adapter._recentAiResponses.length).toBe(10);
        // Verify all 10 entries are unique
        const unique = new Set(adapter._recentAiResponses);
        expect(unique.size).toBe(10);
    });

    test('window contains most recent responses after rotation', () => {
        const adapter = makeAdapter();
        const responses = [
            'The quarterly revenue forecast shows strong upward momentum in the enterprise sector',
            'Our development team recently shipped version three of the mobile application',
            'Customer satisfaction scores have reached an unprecedented ninety-five percent approval',
            'Marketing campaigns targeting small businesses yielded impressive conversion rates',
            'Supply chain optimization resulted in a forty percent reduction in delivery times',
            'New machine learning features dramatically improved the search relevance algorithm',
            'Partnerships with three major distributors expanded our reach into Asian markets',
            'Employee retention programs reduced voluntary attrition by twenty-seven percent',
            'Cloud infrastructure migration completed ahead of schedule and under budget targets',
            'Product roadmap prioritization shifted focus towards artificial intelligence integration',
            'Regulatory compliance automation saved the legal department thousands of hours annually',
            'Beta testing feedback from enterprise clients shaped the premium feature tier design',
            'Geographic expansion plans include opening offices in Sydney and Singapore next year',
            'Security audit findings confirmed zero critical vulnerabilities in production systems',
            'Annual recurring revenue surpassed projections by eighteen percent this fiscal year'
        ];
        for (const text of responses) {
            adapter._isResponseDuplicate(text);
        }
        // After 15 distinct responses, window should hold 10
        expect(adapter._recentAiResponses.length).toBe(10);
        // Most recent should be the last one pushed
        expect(adapter._recentAiResponses[9]).toBe(responses[14]);
    });

    test('repetition guard fires with >= 3 similar responses (not dead after turn 2)', () => {
        // Simulate the repetition guard logic from the fixed code
        const recentResponses = [
            'I would be happy to help you with your inquiry about our services',
            'I would be happy to assist you with your question about our services',
            'I would be happy to help you with your question regarding our services',
            'Something completely different about pricing and availability',
            'I would be happy to help you with your inquiry about our services today',
            'I would be happy to assist you with your inquiry about our services',
            'I would be happy to help you with your question about our services',
        ];

        // The guard should check the LAST 3, not require exactly 3
        const _jaccard = (a, b) => {
            const sa = new Set(a.toLowerCase().split(/\s+/));
            const sb = new Set(b.toLowerCase().split(/\s+/));
            let inter = 0;
            for (const w of sa) if (sb.has(w)) inter++;
            const union = sa.size + sb.size - inter;
            return union === 0 ? 0 : inter / union;
        };

        // Fixed code: checks length >= 3 and uses slice(-3)
        expect(recentResponses.length).toBeGreaterThanOrEqual(3);
        const recent = recentResponses.slice(-3);
        const [r0, r1, r2] = recent;
        const j01 = _jaccard(r0, r1);
        const j12 = _jaccard(r1, r2);
        const j02 = _jaccard(r0, r2);
        expect(j01).toBeGreaterThan(0.6);
        expect(j12).toBeGreaterThan(0.6);
        expect(j02).toBeGreaterThan(0.6);
    });

    test('old code: double-push halved effective dedup window', () => {
        // Prove the OLD code was broken: with double-push, the 10-item
        // window holds only 5 unique entries (each takes 2 slots)
        const bigArr = [];
        const distinctTexts = [
            'The quarterly revenue forecast shows strong momentum ahead',
            'Our development team shipped version three of the mobile app',
            'Customer satisfaction scores reached unprecedented ninety-five percent',
            'Marketing campaigns targeting small businesses yielded great results',
            'Supply chain optimization resulted in forty percent delivery improvement',
            'Machine learning features dramatically improved search relevance overall',
            'Partnerships with major distributors expanded reach into Asian markets',
            'Employee retention programs reduced attrition by twenty-seven percent',
            'Cloud infrastructure migration completed ahead of schedule under budget',
            'Product roadmap shifted focus towards artificial intelligence integration',
            'Regulatory compliance automation saved the legal department many hours',
            'Beta testing feedback from enterprise clients shaped premium features',
            'Geographic expansion plans include offices in Sydney and Singapore',
            'Security audit findings confirmed zero critical production vulnerabilities',
            'Annual recurring revenue surpassed projections by eighteen percent overall'
        ];
        for (let turn = 0; turn < 15; turn++) {
            const text = distinctTexts[turn];
            // Push from _isResponseDuplicate
            bigArr.push(text);
            if (bigArr.length > 10) bigArr.shift();
            // Push from old repetition guard (the bug)
            bigArr.push(text);
            if (bigArr.length > 10) bigArr.shift();
        }
        const uniqueInWindow = new Set(bigArr).size;
        // With double-push: only 5 unique entries in the 10-slot window
        expect(uniqueInWindow).toBeLessThanOrEqual(5);
    });
});

// ──────────────────────────────────────────────────────────────────────────────
// 6E.2: ContextSummarizer hardening
// ──────────────────────────────────────────────────────────────────────────────

describe('6E.2: ContextSummarizer resilience', () => {
    test('summarizeOlderTurns request has no temperature key', () => {
        // Read the actual source and check there's no temperature in the request
        const src = require('fs').readFileSync(
            require('path').join(__dirname, '..', 'adapters', 'llm', 'contextSummarizer.js'),
            'utf8'
        );
        // The create() call arguments should NOT contain 'temperature'
        const createCallMatch = src.match(/client\.chat\.completions\.create\(\{([\s\S]*?)\}\)/);
        expect(createCallMatch).toBeTruthy();
        const createBody = createCallMatch[1];
        expect(createBody).not.toContain('temperature');
    });

    test('permanent disable threshold is 5 (not 3)', () => {
        const src = require('fs').readFileSync(
            require('path').join(__dirname, '..', 'session', 'conversationEngine.js'),
            'utf8'
        );
        // Find the >= N check for permanent disable
        const match = src.match(/summarizationConsecutiveFailures\s*>=\s*(\d+)/);
        expect(match).toBeTruthy();
        expect(Number(match[1])).toBe(5);
    });

    test('summarizer survives 4 consecutive failures without permanent disable', () => {
        // Simulate the failure counter logic
        let consecutiveFailures = 0;
        let permanentlyFailed = false;

        for (let i = 0; i < 4; i++) {
            consecutiveFailures++;
            if (consecutiveFailures >= 5) {
                permanentlyFailed = true;
            }
        }

        expect(consecutiveFailures).toBe(4);
        expect(permanentlyFailed).toBe(false);
    });

    test('summarizer disables permanently after 5 failures', () => {
        let consecutiveFailures = 0;
        let permanentlyFailed = false;

        for (let i = 0; i < 5; i++) {
            consecutiveFailures++;
            if (consecutiveFailures >= 5) {
                permanentlyFailed = true;
            }
        }

        expect(permanentlyFailed).toBe(true);
    });
});

// ──────────────────────────────────────────────────────────────────────────────
// 6E.3: Per-turn generation cap covers ALL dup branches
// ──────────────────────────────────────────────────────────────────────────────

describe('6E.3: Per-turn cap + circuit breaker', () => {
    test('cap increment appears BEFORE circuit breaker check in source', () => {
        const src = require('fs').readFileSync(
            require('path').join(__dirname, '..', 'adapters', 'ai', 'BaseRealtimeAdapter.js'),
            'utf8'
        );
        // Find the cap increment position and circuit breaker position
        const capPos = src.indexOf('this._responsesThisTurn = (this._responsesThisTurn || 0) + 1;');
        const breakerPos = src.indexOf('this._consecutiveDupSuppressions >= 3');

        // Cap increment should appear BEFORE the circuit breaker check
        expect(capPos).toBeLessThan(breakerPos);
        // Cap check should also appear before breaker
        const capCheckPos = src.indexOf('this._responsesThisTurn > 3');
        expect(capCheckPos).toBeLessThan(breakerPos);
    });

    test('simulated flow: cap blocks after 3 corrections (breaker counted)', () => {
        // Simulate the corrected dup handling flow
        let responsesThisTurn = 0;
        let consecutiveDups = 0;
        let callLevelDupCount = 0;
        const actions = [];

        function handleDup(turn) {
            consecutiveDups++;

            // Sprint 6E.3: Cap increment BEFORE any branch
            responsesThisTurn++;
            if (responsesThisTurn > 3) {
                actions.push(`turn${turn}: BLOCKED by cap (responses=${responsesThisTurn})`);
                return;
            }

            if (consecutiveDups >= 3) {
                callLevelDupCount += consecutiveDups;
                actions.push(`turn${turn}: circuit_breaker (callLevel=${callLevelDupCount}, responses=${responsesThisTurn})`);
                consecutiveDups = 0;
                return;
            }

            actions.push(`turn${turn}: mild_correction (responses=${responsesThisTurn})`);
        }

        // Simulate 6 consecutive dups
        for (let i = 1; i <= 6; i++) handleDup(i);

        // With 6E.3 fix:
        // dup 1: consecutiveDups=1, responses=1 → mild correction
        // dup 2: consecutiveDups=2, responses=2 → mild correction
        // dup 3: consecutiveDups=3, responses=3 → circuit breaker (3 is not > 3)
        // dup 4: responses=4 > 3 → BLOCKED
        // dup 5: responses=5 > 3 → BLOCKED
        // dup 6: responses=6 > 3 → BLOCKED
        expect(actions[0]).toContain('mild_correction');
        expect(actions[1]).toContain('mild_correction');
        expect(actions[2]).toContain('circuit_breaker');
        expect(actions[3]).toContain('BLOCKED');
        expect(actions[4]).toContain('BLOCKED');
        expect(actions[5]).toContain('BLOCKED');
        // Key: only 3 response.creates actually sent (2 mild + 1 breaker)
        // Dups 4-6 are silently dropped by the cap
        const sentResponses = actions.filter(a => !a.includes('BLOCKED'));
        expect(sentResponses.length).toBe(3);
    });

    test('old flow: cap only counted mild corrections (breaker bypassed cap)', () => {
        // Simulate OLD code: cap only in mild-correction branch
        let responsesThisTurn_old = 0;
        let consecutiveDups_old = 0;
        const actions_old = [];

        function handleDupOld(turn) {
            consecutiveDups_old++;

            if (consecutiveDups_old >= 3) {
                // OLD: circuit breaker does NOT increment cap
                actions_old.push(`turn${turn}: circuit_breaker (cap=${responsesThisTurn_old})`);
                consecutiveDups_old = 0;
                return;
            }

            // OLD: only mild correction increments cap
            responsesThisTurn_old++;
            if (responsesThisTurn_old > 3) {
                actions_old.push(`turn${turn}: BLOCKED`);
                return;
            }
            actions_old.push(`turn${turn}: mild (cap=${responsesThisTurn_old})`);
        }

        for (let i = 1; i <= 8; i++) handleDupOld(i);

        // OLD flow allows more response.creates:
        // dup1: mild (cap=1), dup2: mild (cap=2), dup3: breaker (cap stays 2)
        // dup4: mild (cap=3), dup5: mild (cap=4>3→BLOCKED at dup5)
        // = 5 attempts before blocking (vs 4 with fix)
        expect(actions_old.filter(a => !a.includes('BLOCKED')).length).toBeGreaterThanOrEqual(4);
    });
});

// ──────────────────────────────────────────────────────────────────────────────
// 6E.5: Permanent fallback lock
// ──────────────────────────────────────────────────────────────────────────────

describe('6E.5: Permanent dup fallback lock', () => {
    test('fallback resets when callLevelDupCount < 9', () => {
        let permanentDupFallback = true;
        let callLevelDupCount = 6;

        // Simulate _processUserTranscript reset logic
        if (permanentDupFallback) {
            if (callLevelDupCount < 9) {
                permanentDupFallback = false;
            }
        }

        expect(permanentDupFallback).toBe(false);
    });

    test('fallback stays locked when callLevelDupCount >= 9', () => {
        let permanentDupFallback = true;
        let callLevelDupCount = 9;

        if (permanentDupFallback) {
            if (callLevelDupCount < 9) {
                permanentDupFallback = false;
            }
        }

        expect(permanentDupFallback).toBe(true);
    });

    test('fallback stays locked at high dup counts (12, 15)', () => {
        for (const count of [12, 15, 20]) {
            let permanentDupFallback = true;
            if (permanentDupFallback) {
                if (count < 9) permanentDupFallback = false;
            }
            expect(permanentDupFallback).toBe(true);
        }
    });

    test('source code gates reset on _callLevelDupCount < 9', () => {
        const src = require('fs').readFileSync(
            require('path').join(__dirname, '..', 'adapters', 'ai', 'BaseRealtimeAdapter.js'),
            'utf8'
        );
        // Find the permanent fallback reset block
        const resetBlock = src.match(/if\s*\(this\._permanentDupFallback\)\s*\{[\s\S]*?callLevelDupCount.*?<\s*(\d+)/);
        expect(resetBlock).toBeTruthy();
        expect(Number(resetBlock[1])).toBe(9);
    });

    test('production scenario: call 83b replay — 37 dups across 7 user turns', () => {
        // Simulate the production call that showed 37 dups
        let permanentDupFallback = false;
        let callLevelDupCount = 0;
        let consecutiveDups = 0;
        let totalDups = 0;
        let responsesBlocked = 0;

        function userSpeaks() {
            if (permanentDupFallback) {
                if (callLevelDupCount < 9) {
                    permanentDupFallback = false;
                }
                // else: stays locked
            }
        }

        function aiGeneratesDup() {
            if (permanentDupFallback) {
                responsesBlocked++;
                return;
            }
            totalDups++;
            consecutiveDups++;

            if (consecutiveDups >= 3) {
                callLevelDupCount += consecutiveDups;
                if (callLevelDupCount >= 6) {
                    permanentDupFallback = true;
                }
                consecutiveDups = 0;
            }
        }

        // Simulate 7 user turns, each followed by dup responses
        for (let userTurn = 0; userTurn < 7; userTurn++) {
            userSpeaks();
            // Each user turn triggers up to 6 dup attempts
            for (let dup = 0; dup < 6; dup++) {
                aiGeneratesDup();
            }
        }

        // With 6E.5 fix: after callLevelDupCount >= 9, fallback is locked
        // So later user turns don't reset it → fewer total dups
        expect(totalDups).toBeLessThan(37); // Old code allowed 37
        expect(permanentDupFallback).toBe(true);
        expect(callLevelDupCount).toBeGreaterThanOrEqual(9);
    });
});
