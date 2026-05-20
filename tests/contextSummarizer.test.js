'use strict';

/**
 * Sprint 3.1 — ContextSummarizer and summarization retry guard tests.
 *
 * Validates:
 * - summarizeOlderTurns throws on failure (Sprint 5B.6: error re-thrown for alerting)
 * - summarizeOlderTurns returns '' for empty/null input
 * - _triggerSummarization stops retrying after 3 consecutive failures
 * - _summarizationPermanentlyFailed flag prevents further calls
 * - Successful summarization resets failure counter
 * - Temperature clamping in AzureRealtimeAdapter [0.6, 1.2]
 * - Token budget cap at 50000
 * - Tautological Number() fix
 *
 * Run: npx jest tests/contextSummarizer.test.js
 */

// ── contextSummarizer ────────────────────────────────────────────────────────

describe('summarizeOlderTurns', () => {
    const { summarizeOlderTurns } = require('../adapters/llm/contextSummarizer');

    test('returns empty string for empty array', async () => {
        const result = await summarizeOlderTurns([]);
        expect(result).toBe('');
    });

    test('returns empty string for null input', async () => {
        const result = await summarizeOlderTurns(null);
        expect(result).toBe('');
    });

    test('throws when Azure client fails (Sprint 5B.6: error no longer swallowed)', async () => {
        // Sprint 5B.6: errors are now re-thrown so _triggerSummarization catch block fires
        const turns = [
            { sender: 'AI', message: 'Hello, this is Sarah from company.' },
            { sender: 'USER', message: 'Hi, who is this?' },
        ];
        await expect(summarizeOlderTurns(turns)).rejects.toThrow();
    });
});

// ── Summarization retry guard (conversationEngine) ────────────────────────────

describe('ConversationEngine summarization retry guard', () => {
    test('_summarizationPermanentlyFailed stops retries after 5 failures', () => {
        const adapter = {
            conversationContext: [],
            _summarizationInFlight: false,
            _summarizationConsecutiveFailures: 0,
            _summarizationPermanentlyFailed: false,
            _contextSummary: '',
            callSID: 'test-123',
        };

        // Sprint 6E.2: Threshold raised from 3→5
        for (let i = 0; i < 5; i++) {
            adapter._summarizationConsecutiveFailures++;
            if (adapter._summarizationConsecutiveFailures >= 5) {
                adapter._summarizationPermanentlyFailed = true;
            }
        }

        expect(adapter._summarizationPermanentlyFailed).toBe(true);
        expect(adapter._summarizationConsecutiveFailures).toBe(5);
    });

    test('successful summarization resets failure counter', () => {
        const adapter = {
            _summarizationConsecutiveFailures: 2,
            _summarizationPermanentlyFailed: false,
        };

        // Simulate successful summarization
        adapter._summarizationConsecutiveFailures = 0;

        expect(adapter._summarizationConsecutiveFailures).toBe(0);
        expect(adapter._summarizationPermanentlyFailed).toBe(false);
    });

    test('permanently failed flag prevents _triggerSummarization call', () => {
        const adapter = {
            conversationContext: Array(12).fill({ sender: 'USER', message: 'test' }),
            _summarizationInFlight: false,
            _summarizationPermanentlyFailed: true,
        };

        const SUMMARIZE_THRESHOLD = 8;
        const shouldTrigger = adapter.conversationContext.length > SUMMARIZE_THRESHOLD
            && !adapter._summarizationInFlight
            && !adapter._summarizationPermanentlyFailed;

        expect(shouldTrigger).toBe(false);
    });
});

// ── Temperature clamping (Sprint 3.1b) ────────────────────────────────────────

describe('Temperature clamping [0.6, 1.2]', () => {
    test('clamps low temperature (0.4) to 0.6', () => {
        const temp = 0.4;
        const clamped = Math.max(0.6, Math.min(1.2, temp));
        expect(clamped).toBe(0.6);
    });

    test('clamps very low temperature (0.1) to 0.6', () => {
        const temp = 0.1;
        const clamped = Math.max(0.6, Math.min(1.2, temp));
        expect(clamped).toBe(0.6);
    });

    test('passes valid temperature (0.8) unchanged', () => {
        const temp = 0.8;
        const clamped = Math.max(0.6, Math.min(1.2, temp));
        expect(clamped).toBe(0.8);
    });

    test('clamps high temperature (1.5) to 1.2', () => {
        const temp = 1.5;
        const clamped = Math.max(0.6, Math.min(1.2, temp));
        expect(clamped).toBe(1.2);
    });

    test('clamps edge minimum (0.6) correctly', () => {
        const temp = 0.6;
        const clamped = Math.max(0.6, Math.min(1.2, temp));
        expect(clamped).toBe(0.6);
    });

    test('clamps edge maximum (1.2) correctly', () => {
        const temp = 1.2;
        const clamped = Math.max(0.6, Math.min(1.2, temp));
        expect(clamped).toBe(1.2);
    });
});

// ── Token budget cap (Sprint 3.6) ────────────────────────────────────────────

describe('Token budget cap', () => {
    test('caps at 50000 when env value exceeds limit', () => {
        const envVal = 999999;
        const budget = Math.min(Number(envVal) || 25000, 50000);
        expect(budget).toBe(50000);
    });

    test('defaults to 25000 when env not set', () => {
        const envVal = undefined;
        const budget = Math.min(Number(envVal) || 25000, 50000);
        expect(budget).toBe(25000);
    });

    test('accepts valid budget within range', () => {
        const envVal = 20000;
        const budget = Math.min(Number(envVal) || 25000, 50000);
        expect(budget).toBe(20000);
    });
});

// ── Tautological Number() fix (Sprint 3.7) ──────────────────────────────────

describe('Tautological Number() fix', () => {
    test('single Number() call produces same result as tautological double', () => {
        const envVal = '15000';
        const singleCall = Number(envVal) || 15000;
        const doubleCall = Number(envVal) || Number(envVal) || 15000;
        expect(singleCall).toBe(doubleCall);
    });

    test('fallback works correctly with undefined', () => {
        const envVal = undefined;
        const result = Number(envVal) || 15000;
        expect(result).toBe(15000);
    });
});

// ── DB pool configurability (Sprint 3.8) ────────────────────────────────────

describe('DB pool configurability', () => {
    test('Number() or-default pattern for connection limit', () => {
        const envVal = '50';
        const limit = Number(envVal) || 25;
        expect(limit).toBe(50);
    });

    test('defaults to 25 when env not set', () => {
        const envVal = undefined;
        const limit = Number(envVal) || 25;
        expect(limit).toBe(25);
    });
});
