'use strict';

/**
 * Tests for persona/styleEngine.js
 *
 * Run: npx jest tests/styleEngine.test.js
 */

const {
    applyStyleConstraints,
    applyPersonaPass,
    verifyNumericsUnchanged,
    capSentences,
    countHumorMarkers,
} = require('../persona/styleEngine');
const { FORMAL, NEUTRAL, WARM, FRIENDLY } = require('../persona/styleProfiles');

// ── verifyNumericsUnchanged ─────────────────────────────────────────────────
describe('verifyNumericsUnchanged', () => {
    test('identical text is unchanged', () => {
        const r = verifyNumericsUnchanged('The price is $500.', 'The price is $500.');
        expect(r.unchanged).toBe(true);
        expect(r.added).toEqual([]);
        expect(r.removed).toEqual([]);
    });

    test('detects added numerics', () => {
        const r = verifyNumericsUnchanged('The price is $500.', 'The price is $500 or $600.');
        expect(r.unchanged).toBe(false);
        expect(r.added.length).toBeGreaterThan(0);
    });

    test('detects removed numerics', () => {
        const r = verifyNumericsUnchanged('The price is $500 and $600.', 'The price is $500.');
        expect(r.unchanged).toBe(false);
        expect(r.removed.length).toBeGreaterThan(0);
    });

    test('handles empty strings', () => {
        const r = verifyNumericsUnchanged('', '');
        expect(r.unchanged).toBe(true);
    });
});

// ── capSentences ────────────────────────────────────────────────────────────
describe('capSentences', () => {
    test('passes through text under limit', () => {
        expect(capSentences('Hello. How are you?', 5)).toBe('Hello. How are you?');
    });

    test('caps at maxSentences', () => {
        const text = 'One. Two. Three. Four. Five.';
        const result = capSentences(text, 3);
        const count = result.split(/(?<=[.!?])\s+/).filter(s => s.trim()).length;
        expect(count).toBeLessThanOrEqual(3);
    });

    test('handles single sentence', () => {
        expect(capSentences('Just one sentence.', 1)).toBe('Just one sentence.');
    });

    test('handles non-string input', () => {
        expect(capSentences(null, 3)).toBe('');
        expect(capSentences(undefined, 3)).toBe('');
    });

    test('handles maxSentences < 1', () => {
        expect(capSentences('Hello.', 0)).toBe('Hello.');
    });
});

// ── countHumorMarkers ───────────────────────────────────────────────────────
describe('countHumorMarkers', () => {
    test('counts humor keywords', () => {
        expect(countHumorMarkers('just kidding, haha!')).toBeGreaterThanOrEqual(2);
    });

    test('counts exclamation clusters', () => {
        expect(countHumorMarkers('Wow!! Amazing!!')).toBeGreaterThanOrEqual(2);
    });

    test('returns 0 for normal text', () => {
        expect(countHumorMarkers('The meeting is at 3 PM.')).toBe(0);
    });

    test('handles non-string input', () => {
        expect(countHumorMarkers(null)).toBe(0);
        expect(countHumorMarkers(undefined)).toBe(0);
    });
});

// ── applyStyleConstraints ───────────────────────────────────────────────────
describe('applyStyleConstraints', () => {
    test('returns text, humorUsed, numericsUnchanged', () => {
        const result = applyStyleConstraints('Hello there.', NEUTRAL);
        expect(result).toHaveProperty('text');
        expect(result).toHaveProperty('humorUsed');
        expect(result).toHaveProperty('numericsUnchanged');
    });

    test('caps sentences per profile limit', () => {
        const longText = 'A. B. C. D. E. F. G. H. I. J.';
        const result = applyStyleConstraints(longText, FORMAL); // maxSentencesPerTurn: 4
        const count = result.text.split(/(?<=[.!?])\s+/).filter(s => s.trim()).length;
        expect(count).toBeLessThanOrEqual(4);
    });

    test('numericsUnchanged is true when no numeric change', () => {
        const result = applyStyleConstraints('The cost is $100.', NEUTRAL);
        expect(result.numericsUnchanged).toBe(true);
    });

    test('handles empty string', () => {
        const result = applyStyleConstraints('', NEUTRAL);
        expect(result.text).toBe('');
    });

    test('handles non-string input', () => {
        const result = applyStyleConstraints(null, NEUTRAL);
        expect(result.text).toBe('');
    });
});

// ── applyPersonaPass ────────────────────────────────────────────────────────
describe('applyPersonaPass', () => {
    test('returns text + styleProfile', () => {
        const result = applyPersonaPass('Hello.', 'balanced');
        expect(result).toHaveProperty('text');
        expect(result).toHaveProperty('styleProfile');
        expect(result.styleProfile).toEqual(NEUTRAL);
    });

    test('escalation forces FORMAL style', () => {
        const result = applyPersonaPass('Hello!', 'balanced', { escalationActive: true });
        expect(result.styleProfile.humorLevel).toBe(0);
        expect(result.styleProfile.warmthLevel).toBe(0);
    });

    test('structured profile uses FORMAL', () => {
        const result = applyPersonaPass('Hello.', 'structured');
        expect(result.styleProfile).toEqual(FORMAL);
    });

    test('unknown profile falls back to NEUTRAL', () => {
        const result = applyPersonaPass('Hello.', 'nonexistent');
        expect(result.styleProfile).toEqual(NEUTRAL);
    });
});
