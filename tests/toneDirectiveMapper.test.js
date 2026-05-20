'use strict';

/**
 * Tests for Helper/toneDirectiveMapper.js
 *
 * Run: npx jest tests/toneDirectiveMapper.test.js
 */

const { buildToneDirective } = require('../Helper/toneDirectiveMapper');

describe('buildToneDirective', () => {
    test('returns null when both inputs are null', () => {
        expect(buildToneDirective(null, null)).toBeNull();
    });

    test('returns null when sentimentResult has no signals', () => {
        expect(buildToneDirective({ signals: [], primary: null }, null)).toBeNull();
    });

    test('returns escalation override when provided', () => {
        const override = { tone: 'formal', humorAllowed: false, concise: true };
        const result = buildToneDirective(null, override);
        expect(result).toContain('TONE OVERRIDE');
        expect(result).toContain('formal');
    });

    test('escalation override takes precedence over sentiment', () => {
        const sentiment = { signals: ['frustration'], primary: 'frustration' };
        const override = { tone: 'formal', humorAllowed: false, concise: true };
        const result = buildToneDirective(sentiment, override);
        expect(result).toContain('TONE OVERRIDE');
        expect(result).not.toContain('frustrated');
    });

    test('maps frustration signal', () => {
        const sentiment = { signals: ['frustration'], primary: 'frustration' };
        const result = buildToneDirective(sentiment, null);
        expect(result).toContain('frustrated');
    });

    test('maps urgency signal', () => {
        const sentiment = { signals: ['urgency'], primary: 'urgency' };
        const result = buildToneDirective(sentiment, null);
        expect(result).toContain('urgency');
    });

    test('maps confusion signal', () => {
        const sentiment = { signals: ['confusion'], primary: 'confusion' };
        const result = buildToneDirective(sentiment, null);
        expect(result).toContain('confused');
    });

    test('maps disengagement signal', () => {
        const sentiment = { signals: ['disengagement'], primary: 'disengagement' };
        const result = buildToneDirective(sentiment, null);
        expect(result).toContain('disengaged');
    });

    test('maps hostility signal', () => {
        const sentiment = { signals: ['hostility'], primary: 'hostility' };
        const result = buildToneDirective(sentiment, null);
        expect(result).toContain('upset');
    });

    test('combines max 2 signals', () => {
        const sentiment = { signals: ['frustration', 'urgency', 'confusion'], primary: 'frustration' };
        const result = buildToneDirective(sentiment, null);
        // Should contain at most 2 TONE: directives
        const toneCount = (result.match(/TONE:/g) || []).length;
        expect(toneCount).toBeLessThanOrEqual(2);
    });

    test('returns null for unknown signal', () => {
        const sentiment = { signals: ['unknown_signal'], primary: 'unknown_signal' };
        const result = buildToneDirective(sentiment, null);
        expect(result).toBeNull();
    });

    test('handles sentimentResult with null signals', () => {
        expect(buildToneDirective({ signals: null, primary: null }, null)).toBeNull();
    });
});
