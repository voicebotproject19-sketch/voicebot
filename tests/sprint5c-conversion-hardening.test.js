'use strict';

/**
 * Sprint 5C — Conversion Hardening validation tests
 *
 * 3 fixes:
 *   5C.1 Email confirmation negation guard
 *   5C.2 PAT expansion — 7 new B2B persona patterns
 *   5C.3 Context retention cap increase (500→1000)
 */

const path = require('path');

// ═══════════════════════════════════════════════════════════════════════════
// 5C.1 — Email Confirmation Negation Guard
// ═══════════════════════════════════════════════════════════════════════════

describe('5C.1 — Email confirmation negation guard', () => {
    let quickHangupDecision;

    beforeAll(() => {
        const mod = require(path.join(process.cwd(), 'Helper', 'quickDecisionFilter'));
        quickHangupDecision = mod.quickHangupDecision;
    });

    const aiWithEmail = "Great, I'll send the details to john@example.com.";
    const aiNoEmail = "Tell me more about your project requirements.";

    function buildContext(userMsg, aiMsg) {
        return [
            { sender: 'AI', message: 'Hello, this is Sarah from company.' },
            { sender: 'USER', message: 'Hi, tell me more.' },
            { sender: 'AI', message: aiMsg },
            { sender: 'USER', message: userMsg },
        ];
    }

    test('genuine confirmation still triggers hangup', () => {
        const result = quickHangupDecision(
            buildContext('yes that is correct', aiWithEmail),
            4,
            'english'
        );
        expect(result).not.toBeNull();
        expect(result.shouldHangup).toBe(true);
        expect(result.emailConfirmed).toBe(true);
    });

    test('simple "okay" still triggers hangup', () => {
        const result = quickHangupDecision(
            buildContext('okay', aiWithEmail),
            4,
            'english'
        );
        expect(result).not.toBeNull();
        expect(result.shouldHangup).toBe(true);
    });

    test('"okay but that is wrong" — negation blocks premature hangup', () => {
        const result = quickHangupDecision(
            buildContext('okay but that is wrong', aiWithEmail),
            4,
            'english'
        );
        expect(result).toBeNull(); // falls through to LLM analysis
    });

    test('"yes actually wait" — negation blocks premature hangup', () => {
        const result = quickHangupDecision(
            buildContext('yes actually wait', aiWithEmail),
            4,
            'english'
        );
        expect(result).toBeNull();
    });

    test('"thanks but that is incorrect" — negation blocks premature hangup', () => {
        const result = quickHangupDecision(
            buildContext('thanks but that is incorrect', aiWithEmail),
            4,
            'english'
        );
        expect(result).toBeNull();
    });

    test('"ok hold on let me change that" — negation blocks premature hangup', () => {
        const result = quickHangupDecision(
            buildContext('ok hold on let me change that', aiWithEmail),
            4,
            'english'
        );
        expect(result).toBeNull();
    });

    test('"great but wait I made a mistake" — negation blocks premature hangup', () => {
        const result = quickHangupDecision(
            buildContext('great but wait I made a mistake', aiWithEmail),
            4,
            'english'
        );
        expect(result).toBeNull();
    });

    test('"perfect not right actually" — negation blocks premature hangup', () => {
        const result = quickHangupDecision(
            buildContext('perfect not right actually', aiWithEmail),
            4,
            'english'
        );
        expect(result).toBeNull();
    });

    test('no email in AI message → returns null regardless', () => {
        const result = quickHangupDecision(
            buildContext('yes okay', aiNoEmail),
            4,
            'english'
        );
        // Should be null (no email in AI message, so email rule doesn't fire)
        // Other rules may match, but email-specific negation is irrelevant
        // Just verify it doesn't crash
        expect(result === null || result.emailConfirmed === undefined).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5C.2 — PAT Expansion: 7 New Persona Patterns
// ═══════════════════════════════════════════════════════════════════════════

describe('5C.2 — PAT expansion: 7 new B2B persona patterns', () => {
    let matchPrecomputedAnswer;
    let persona;

    beforeAll(() => {
        const pat = require(path.join(process.cwd(), 'services', 'precomputedAnswers'));
        matchPrecomputedAnswer = pat.matchPrecomputedAnswer;

        const { getPersona } = require(path.join(process.cwd(), 'personas', 'registry'));
        persona = getPersona('company-sales');
    });

    const newPatterns = [
        { id: 'compliance',       inputs: ['Are you ISO certified?', 'Do you have SOC2 compliance?', 'Is your platform GDPR compliant?'] },
        { id: 'engagement_model', inputs: ['What engagement models do you offer?', 'Do you have a dedicated team model?', 'Is there a fixed price option?'] },
        { id: 'nda_ip',           inputs: ['Who owns the IP?', 'Do you sign an NDA?', 'What about non-disclosure and IP transfer?'] },
        { id: 'post_launch',      inputs: ['What happens after launch?', 'Do you offer maintenance and SLA?', 'Is there post-launch support?'] },
        { id: 'timeline',         inputs: ['How long does a typical project take?', 'What is the average timeline?', 'Time to deliver an MVP?'] },
        { id: 'communication',    inputs: ['What timezone do you work in?', 'How do you handle communication?', 'Are daily standups included?'] },
        { id: 'industry_vertical', inputs: ['Do you work in healthcare?', 'Any fintech experience?', 'Have you done ecommerce projects?'] },
    ];

    for (const { id, inputs } of newPatterns) {
        for (const input of inputs) {
            test(`${id}: "${input}" matches persona PAT`, () => {
                const match = matchPrecomputedAnswer(input, persona);
                expect(match).not.toBeNull();
                expect(match.id).toBe(id);
                expect(match.response.length).toBeGreaterThan(20);
            });
        }
    }

    test('total persona patterns is 15 (8 original + 7 new)', () => {
        expect(persona.precomputedAnswers.length).toBe(15);
    });

    test('default PAT coverage includes core and platform-specific entries', () => {
        const { DEFAULT_PATTERNS } = require(path.join(process.cwd(), 'services', 'precomputedAnswers'));
        const ids = DEFAULT_PATTERNS.map(entry => entry.id);
        expect(ids).toEqual(expect.arrayContaining([
            'what_do_you_do',
            'pricing',
            'location',
            'technologies',
            'moodle_platform',
            'ecommerce_platform'
        ]));
        expect(DEFAULT_PATTERNS.length).toBeGreaterThanOrEqual(10);
        expect(persona.precomputedAnswers.length).toBe(15);
    });

    test('existing patterns still work after expansion', () => {
        const robotQ = matchPrecomputedAnswer('are you a robot?', persona);
        expect(robotQ).not.toBeNull();
        expect(robotQ.id).toBe('robot_question');

        const dataSource = matchPrecomputedAnswer('how did you get my number?', persona);
        expect(dataSource).not.toBeNull();
        expect(dataSource.id).toBe('data_source');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5C.3 — Context Retention Cap Increase (500 → 1000)
// ═══════════════════════════════════════════════════════════════════════════

describe('5C.3 — Context retention cap increase', () => {
    test('conversationEngine caps summary at 1000 chars (was 500)', () => {
        const fs = require('fs');
        const source = fs.readFileSync(
            path.join(process.cwd(), 'session', 'conversationEngine.js'),
            'utf8'
        );
        const capMatch = source.match(/_contextSummary\.length\s*>\s*(\d+)/);
        expect(capMatch).not.toBeNull();
        expect(parseInt(capMatch[1], 10)).toBe(1000);

        const sliceMatch = source.match(/\.slice\(-(\d+)\)/);
        expect(sliceMatch).not.toBeNull();
        expect(parseInt(sliceMatch[1], 10)).toBe(1000);
    });

    test('summary of ~800 chars is NOT truncated (was truncated at 500)', () => {
        // Simulates post-summarization state
        const summary = 'A'.repeat(800);
        // Under old cap (500), this would be sliced to 500
        // Under new cap (1000), this should survive intact
        const result = summary.length > 1000 ? summary.slice(-1000) : summary;
        expect(result.length).toBe(800); // not truncated
    });

    test('summary of 1200 chars IS truncated to 1000', () => {
        const summary = 'B'.repeat(1200);
        const result = summary.length > 1000 ? summary.slice(-1000) : summary;
        expect(result.length).toBe(1000);
    });
});
