'use strict';

/**
 * Sprint 3.4 — Plivo no-UUID → pending-meta → incoming_plivo flow test.
 *
 * Validates:
 * - consumePendingCallMeta retrieves and removes metadata
 * - consumePendingCallMeta returns null for unknown numbers
 * - Telemetry event latency_compensation_level is registered
 *
 * Run: npx jest tests/plivoNoUuid.test.js
 */

const PlivoProvider = require('../adapters/telecom/PlivoProvider');

describe('Plivo pending metadata (no-UUID flow)', () => {
    test('consumePendingCallMeta returns null for unknown number', () => {
        const result = PlivoProvider.consumePendingCallMeta('+10000000000');
        expect(result).toBeNull();
    });

    test('store then consume returns metadata and removes it', () => {
        const meta = { persona: 'sales', language: 'en', campaignId: 'test-123' };
        PlivoProvider.storePendingCallMeta('+19999999999', meta);
        const consumed = PlivoProvider.consumePendingCallMeta('+19999999999');
        expect(consumed).not.toBeNull();
        expect(consumed.persona).toBe('sales');
        expect(consumed.language).toBe('en');
        expect(consumed.ts).toBeDefined();
        // Second consume should return null (already consumed)
        const second = PlivoProvider.consumePendingCallMeta('+19999999999');
        expect(second).toBeNull();
    });

    test('consumePendingCallMeta is exported and callable', () => {
        expect(typeof PlivoProvider.consumePendingCallMeta).toBe('function');
    });
});

describe('Telemetry event registration (Sprint 3.5)', () => {
    const EVENTS = require('../Utils/telemetryEvents');

    test('latency_compensation_level is registered', () => {
        expect(EVENTS.has('latency_compensation_level')).toBe(true);
    });

    test('latency_compensation_active is still registered', () => {
        expect(EVENTS.has('latency_compensation_active')).toBe(true);
    });

    test('response_loop_permanent_fallback is registered', () => {
        expect(EVENTS.has('response_loop_permanent_fallback')).toBe(true);
    });

    test('token_budget_exceeded is registered', () => {
        expect(EVENTS.has('token_budget_exceeded')).toBe(true);
    });

    test('prompt budget events are registered', () => {
        expect(EVENTS.has('prompt_budget_warning')).toBe(true);
        expect(EVENTS.has('prompt_budget_hard_warning')).toBe(true);
    });

    test('hangup nextAction clamp event is registered', () => {
        expect(EVENTS.has('hangup_next_action_clamped')).toBe(true);
    });

    test('first_audio_delta is registered', () => {
        expect(EVENTS.has('first_audio_delta')).toBe(true);
    });

    test('dtmf_received is registered', () => {
        expect(EVENTS.has('dtmf_received')).toBe(true);
    });

    test('transfer_failed_callback_offered is registered', () => {
        expect(EVENTS.has('transfer_failed_callback_offered')).toBe(true);
    });

    test('latency_compensation_disabled_warning is registered', () => {
        expect(EVENTS.has('latency_compensation_disabled_warning')).toBe(true);
    });
});
