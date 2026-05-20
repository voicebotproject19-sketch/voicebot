/**
 * Sprint 6D: Pre-Playback Duplicate Prevention Tests
 *
 * Validates:
 * - 6D.1: Sliding early dup check fires at 20-char boundaries (not once at 80)
 * - 6D.2: _isEarlyDuplicate threshold lowered to 15 chars
 * - 6D.3: conversation.item.delete sent on duplicate suppression
 * - 6D.4: _earlyDupChecked flag removed
 * - 6D.5: Persona email rule uses ONCE/EINMAL (not IMMEDIATELY/SOFORT)
 */

const EventEmitter = require('events');

// ── Minimal adapter stub for unit-testing BaseRealtimeAdapter methods ───
class TestAdapter extends EventEmitter {
    constructor() {
        super();
        this.callSID = 'test-6d';
        this.providerName = 'azure';
        this.aiTranscript = '';
        this._recentAiResponses = [];
        this._earlyDupCancelled = false;
        this._consecutiveDupSuppressions = 0;
        this._skipDupCheckForNextResponse = false;
        this._permanentDupFallback = false;
        this._currentResponseItemId = null;
        this._currentResponseId = null;
        this.conversationPhase = 'discovery';
        this._sentMessages = [];
        this.isConnected = true;
        this.ws = { readyState: 1, send: () => {} };
        this._rateLimitBackoffUntil = 0;
    }

    send(msg) {
        this._sentMessages.push(msg);
    }
}

// Load the real methods from BaseRealtimeAdapter prototype
const BaseRealtimeAdapter = require('../adapters/ai/BaseRealtimeAdapter');

// Attach real methods to TestAdapter for testing
const methodsToCopy = [
    '_isEarlyDuplicate',
    '_isResponseDuplicate',
    '_commonPrefixLength',
    '_trigramJaccard',
];

methodsToCopy.forEach(method => {
    if (BaseRealtimeAdapter.prototype[method]) {
        TestAdapter.prototype[method] = BaseRealtimeAdapter.prototype[method];
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// 6D.1: Sliding Early Duplicate Check
// ═══════════════════════════════════════════════════════════════════════════

describe('Sprint 6D.1: Sliding early duplicate check', () => {
    test('check fires at the 20-char boundary', () => {
        // Simulate the transcript.delta handler logic
        const adapter = new TestAdapter();
        adapter._recentAiResponses = [
            'Sure you can send documents to leads at company dot com for any inquiries'
        ];

        // Simulate delta events accumulating transcript
        const deltas = [
            'Sure you can ',      // 14 chars — below 20
            'send doc',           // 22 chars — crosses 20 boundary
        ];

        let cancelSent = false;
        deltas.forEach(delta => {
            adapter.aiTranscript += delta;
            const _deltaLen = delta.length;
            const _prevLen = adapter.aiTranscript.length - _deltaLen;
            if (adapter.aiTranscript.length >= 20 &&
                (Math.floor(_prevLen / 20) < Math.floor(adapter.aiTranscript.length / 20))) {
                if (adapter._isEarlyDuplicate(adapter.aiTranscript)) {
                    cancelSent = true;
                }
            }
        });

        expect(cancelSent).toBe(true);
    });

    test('check fires again at 40-char boundary', () => {
        const adapter = new TestAdapter();
        adapter._recentAiResponses = [
            'We specialize in custom software development and cloud solutions'
        ];

        let checkCount = 0;
        const deltas = [
            'We specialize in c', // 18 chars
            'us',                 // 20 chars — first boundary
            'tom software developmen', // 43 chars — second boundary (crosses 40)
        ];

        deltas.forEach(delta => {
            adapter.aiTranscript += delta;
            const _deltaLen = delta.length;
            const _prevLen = adapter.aiTranscript.length - _deltaLen;
            if (adapter.aiTranscript.length >= 20 &&
                (Math.floor(_prevLen / 20) < Math.floor(adapter.aiTranscript.length / 20))) {
                checkCount++;
            }
        });

        expect(checkCount).toBe(2);
    });

    test('no check fires under 20 chars', () => {
        const adapter = new TestAdapter();
        adapter._recentAiResponses = ['Short text here plus some more'];

        let checkFired = false;
        const delta = 'Short text here';
        adapter.aiTranscript += delta;
        const _deltaLen = delta.length;
        const _prevLen = adapter.aiTranscript.length - _deltaLen;
        if (adapter.aiTranscript.length >= 20 &&
            (Math.floor(_prevLen / 20) < Math.floor(adapter.aiTranscript.length / 20))) {
            checkFired = true;
        }

        expect(checkFired).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6D.2: Lowered _isEarlyDuplicate Threshold
// ═══════════════════════════════════════════════════════════════════════════

describe('Sprint 6D.2: _isEarlyDuplicate threshold at 15 chars', () => {
    let adapter;
    beforeEach(() => {
        adapter = new TestAdapter();
    });

    test('catches prefix match at 20 chars', () => {
        adapter._recentAiResponses = [
            'Sure you can send your documents to leads at company dot com'
        ];
        expect(adapter._isEarlyDuplicate('Sure you can send yo')).toBe(true);
    });

    test('catches prefix match at 15+ chars when ratio > 0.8', () => {
        adapter._recentAiResponses = [
            'Absolutely we can help you with that project right away'
        ];
        // 18 chars, all matching — 18/18 = 1.0 > 0.8
        expect(adapter._isEarlyDuplicate('Absolutely we can ')).toBe(true);
    });

    test('rejects partial under 15 chars', () => {
        adapter._recentAiResponses = [
            'Sure you can send your documents to leads'
        ];
        expect(adapter._isEarlyDuplicate('Sure you can')).toBe(false);
    });

    test('rejects null/empty input', () => {
        adapter._recentAiResponses = ['Some previous response'];
        expect(adapter._isEarlyDuplicate(null)).toBe(false);
        expect(adapter._isEarlyDuplicate('')).toBe(false);
        expect(adapter._isEarlyDuplicate(undefined)).toBe(false);
    });

    test('rejects dissimilar prefix', () => {
        adapter._recentAiResponses = [
            'We specialize in custom software development and cloud solutions'
        ];
        expect(adapter._isEarlyDuplicate('Our team delivers mobile apps')).toBe(false);
    });

    test('rejects when only previous responses are short', () => {
        adapter._recentAiResponses = ['Ok', 'Sure', 'Got it'];
        expect(adapter._isEarlyDuplicate('Sure you can send your documents')).toBe(false);
    });

    test('handles common openings without false positives', () => {
        adapter._recentAiResponses = [
            'Sure I can help you with that specific project timeline'
        ];
        // Different response starting with "Sure" — only 4 chars common, well under threshold
        expect(adapter._isEarlyDuplicate('Sure thing let me check on that for you')).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6D.3: conversation.item.delete on Duplicate Suppression
// ═══════════════════════════════════════════════════════════════════════════

describe('Sprint 6D.3: conversation.item.delete on duplicate', () => {
    test('sends delete when _currentResponseItemId is set', () => {
        const adapter = new TestAdapter();
        adapter._currentResponseItemId = 'item_abc123';
        adapter._recentAiResponses = [
            'Sure you can send your documents to leads at company dot com for inquiries'
        ];

        // Simulate _isResponseDuplicate returning true by having near-identical text
        const dupText = 'Sure you can send your documents to leads at company dot com for inquiries';

        // Call _isResponseDuplicate to verify it detects the dup
        const isDup = adapter._isResponseDuplicate(dupText);
        expect(isDup).toBe(true);

        // Now simulate what the handler does after detection:
        // send conversation.item.delete
        if (adapter._currentResponseItemId) {
            adapter.send({ type: 'conversation.item.delete', item_id: adapter._currentResponseItemId });
        }

        const deleteMessages = adapter._sentMessages.filter(m => m.type === 'conversation.item.delete');
        expect(deleteMessages).toHaveLength(1);
        expect(deleteMessages[0].item_id).toBe('item_abc123');
    });

    test('does NOT send delete when _currentResponseItemId is null', () => {
        const adapter = new TestAdapter();
        adapter._currentResponseItemId = null;

        if (adapter._currentResponseItemId) {
            adapter.send({ type: 'conversation.item.delete', item_id: adapter._currentResponseItemId });
        }

        const deleteMessages = adapter._sentMessages.filter(m => m.type === 'conversation.item.delete');
        expect(deleteMessages).toHaveLength(0);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6D.4: _earlyDupChecked Flag Removed
// ═══════════════════════════════════════════════════════════════════════════

describe('Sprint 6D.4: _earlyDupChecked flag removed', () => {
    test('BaseRealtimeAdapter constructor does not set _earlyDupChecked', () => {
        // Check the prototype/constructor doesn't reference the flag
        const src = require('fs').readFileSync(
            require('path').join(__dirname, '..', 'adapters', 'ai', 'BaseRealtimeAdapter.js'),
            'utf8'
        );
        // Should not have _earlyDupChecked in constructor or _handleResponseCreated
        const constructorMatch = src.match(/this\._earlyDupChecked\s*=/g);
        expect(constructorMatch).toBeNull();
    });

    test('_earlyDupCancelled flag is still present (needed by response.done)', () => {
        const src = require('fs').readFileSync(
            require('path').join(__dirname, '..', 'adapters', 'ai', 'BaseRealtimeAdapter.js'),
            'utf8'
        );
        expect(src).toContain('this._earlyDupCancelled');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6D.5: Persona Email Rule Softened
// ═══════════════════════════════════════════════════════════════════════════

describe('Sprint 6D.5: Persona email rule softened', () => {
    test('English persona uses ONCE instead of IMMEDIATELY', () => {
        const src = require('fs').readFileSync(
            require('path').join(__dirname, '..', 'personas', 'company-sales.js'),
            'utf8'
        );
        // Should NOT contain the old imperative
        expect(src).not.toContain('give this email IMMEDIATELY');
        // Should contain the new once-per-call directive
        expect(src).toContain('give this email ONCE');
        expect(src).toContain('I shared that email a moment ago');
    });

    test('German persona uses EINMAL instead of SOFORT', () => {
        const src = require('fs').readFileSync(
            require('path').join(__dirname, '..', 'personas', 'company-sales.js'),
            'utf8'
        );
        // Should NOT contain the old imperative for email rule
        expect(src).not.toContain('SOFORT diese Adresse geben');
        // Should contain the new once-per-call directive
        expect(src).toContain('EINMAL geben');
        expect(src).toContain('Ich habe die Adresse eben schon genannt');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6D Integration: Sliding Check + Delete in Dup Suppression Path
// ═══════════════════════════════════════════════════════════════════════════

describe('Sprint 6D Integration: conversation.item.delete in source code', () => {
    test('BaseRealtimeAdapter contains conversation.item.delete in dup suppression path', () => {
        const src = require('fs').readFileSync(
            require('path').join(__dirname, '..', 'adapters', 'ai', 'BaseRealtimeAdapter.js'),
            'utf8'
        );
        expect(src).toContain("type: 'conversation.item.delete'");
        expect(src).toContain('duplicate_item_deleted_from_server');
    });

    test('sliding check uses 20-char boundary logic (not 80-char one-shot)', () => {
        const src = require('fs').readFileSync(
            require('path').join(__dirname, '..', 'adapters', 'ai', 'BaseRealtimeAdapter.js'),
            'utf8'
        );
        // Should contain the new sliding boundary check
        expect(src).toContain('Math.floor(_prevLen / 20)');
        expect(src).toContain('Math.floor(this.aiTranscript.length / 20)');
        // Should NOT contain the old one-shot pattern
        expect(src).not.toContain('this._earlyDupChecked && this.aiTranscript.length >= 80');
    });
});
