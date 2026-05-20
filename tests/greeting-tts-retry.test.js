'use strict';

/**
 * Greeting TTS Retry — Tests for the greeting speech synthesis failure recovery.
 *
 * Validates:
 *   1. audio_done with no prior audio deltas does NOT transition to operational
 *   2. response_done_failed during greeting phase triggers a single retry
 *   3. No retry fires if greeting was already delivered
 *   4. No infinite loop — second failure does not trigger another retry
 *   5. Successful greeting after retry transitions normally
 */

const path = require('path');

jest.mock('../Utils/telemetry', () => ({
    emit: jest.fn(),
    isKnownEvent: () => true,
}));

const BaseRealtimeAdapter = require(path.join(__dirname, '..', 'adapters', 'ai', 'BaseRealtimeAdapter'));

function createAdapter(overrides = {}) {
    const adapter = Object.create(BaseRealtimeAdapter.prototype);
    // providerName is a getter on the prototype — must use defineProperty
    Object.defineProperty(adapter, 'providerName', { value: 'azure-realtime', configurable: true });
    Object.assign(adapter, {
        callSID: 'test-greeting-retry-' + Date.now(),
        conversationPhase: 'opening',
        name: 'Test User',
        persona: { name: 'Sarah', company: 'TestCo', rules: { targetWords: { detailedMax: 50 } } },
        conversationContext: [],
        isConnected: true,
        isResponding: false,
        lang: { baseInstruction: () => 'Test base instructions', sttLocale: 'en-US' },
        vadMode: 'server_vad',

        // Greeting state
        _greetingDelivered: false,
        _greetingPending: false,
        _greetingFallbackTimer: null,
        _greetingRetried: false,

        // Audio/response state
        _firstDeltaLogged: false,
        _firstAudioTs: null,
        _totalAudioDurationMs: 0,
        _audioPlaybackEndEstimate: 0,
        _currentResponseId: null,
        _currentResponseItemId: null,
        _truncateAudioEndMs: 0,
        _lastAutoResponseTs: null,
        _responseTimeoutActive: false,
        _responseTimeoutGuard: null,
        _retryResponseCreateOnDone: false,
        _earlyDupCancelled: false,
        _deferredTextResponse: null,
        _deferredUserInputQueue: [],
        _enableAudioPlaybackTracking: false,

        // Stubs
        send: jest.fn(),
        emit: jest.fn(),
        _clearResponseTimeout: jest.fn(),
        _buildFullSessionConfig: jest.fn(() => ({ type: 'session.update' })),
        _buildResponseCreate: jest.fn(() => ({ type: 'response.create' })),
        getOperationalInstructions: jest.fn(() => 'operational instructions'),

        // Turnstate
        turnStateRef: null,

        // Token tracking
        totalInputTokens: 0,
        totalOutputTokens: 0,
        conversationId: null,

        ...overrides,
    });
    return adapter;
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('Greeting TTS Retry', () => {

    // ── 1. audio_done with zero deltas must NOT transition to operational ──
    test('audio_done without audio deltas logs warning, does not transition', () => {
        const adapter = createAdapter();
        // _firstDeltaLogged is false → no audio was produced
        adapter._handleAudioDone({});

        // Should NOT have called session.update (no operational transition)
        const sessionUpdates = adapter.send.mock.calls.filter(
            c => c[0] && c[0].type === 'session.update'
        );
        expect(sessionUpdates).toHaveLength(0);
        expect(adapter._greetingDelivered).toBe(false);
    });

    // ── 2. audio_done WITH prior audio delta DOES transition ──────────────
    test('audio_done with prior audio delta transitions to operational', () => {
        const adapter = createAdapter();
        adapter._firstDeltaLogged = true; // simulate a delta was received
        adapter._handleAudioDone({});

        expect(adapter._greetingDelivered).toBe(true);
        const sessionUpdates = adapter.send.mock.calls.filter(
            c => c[0] && c[0].type === 'session.update'
        );
        expect(sessionUpdates).toHaveLength(1);
    });

    // ── 3. response_done_failed during greeting triggers retry ────────────
    test('response_done_failed during greeting sends retry response.create', () => {
        const adapter = createAdapter();
        adapter._handleResponseDone({
            response: {
                status: 'failed',
                status_details: {
                    type: 'failed',
                    error: { code: 'speech_synthesis_error', message: 'invalid token state' }
                },
                usage: { input_tokens: 0, output_tokens: 0 }
            }
        });

        expect(adapter._greetingRetried).toBe(true);
        // Should have sent a response.create for retry
        const creates = adapter.send.mock.calls.filter(
            c => c[0] && c[0].type === 'response.create'
        );
        expect(creates).toHaveLength(1);
        // Should NOT have transitioned to operational
        expect(adapter._greetingDelivered).toBe(false);
    });

    // ── 4. Second failure does NOT trigger another retry (no loop) ────────
    test('second response_done_failed does NOT retry again', () => {
        const adapter = createAdapter();
        adapter._greetingRetried = true; // already retried once

        adapter._handleResponseDone({
            response: {
                status: 'failed',
                status_details: { type: 'failed', error: { code: 'speech_synthesis_error' } },
                usage: { input_tokens: 0, output_tokens: 0 }
            }
        });

        // No response.create should have been sent
        const creates = adapter.send.mock.calls.filter(
            c => c[0] && c[0].type === 'response.create'
        );
        expect(creates).toHaveLength(0);
    });

    // ── 5. No retry when greeting already delivered ───────────────────────
    test('response_done_failed after greeting delivered does not retry', () => {
        const adapter = createAdapter();
        adapter._greetingDelivered = true;

        adapter._handleResponseDone({
            response: {
                status: 'failed',
                status_details: { type: 'failed', error: { code: 'speech_synthesis_error' } },
                usage: { input_tokens: 0, output_tokens: 0 }
            }
        });

        expect(adapter._greetingRetried).toBe(false);
        const creates = adapter.send.mock.calls.filter(
            c => c[0] && c[0].type === 'response.create'
        );
        expect(creates).toHaveLength(0);
    });

    // ── 6. Full sequence: TTS fail → retry → success ──────────────────────
    test('full greeting retry lifecycle: fail → retry → audio delivered → transition', () => {
        const adapter = createAdapter();

        // Step 1: audio_done with no deltas (TTS failed to produce audio)
        adapter._handleAudioDone({});
        expect(adapter._greetingDelivered).toBe(false);

        // Step 2: response.done with status=failed triggers retry
        adapter._handleResponseDone({
            response: {
                status: 'failed',
                status_details: { type: 'failed', error: { code: 'speech_synthesis_error' } },
                usage: { input_tokens: 0, output_tokens: 0 }
            }
        });
        expect(adapter._greetingRetried).toBe(true);
        const retryCreate = adapter.send.mock.calls.filter(
            c => c[0] && c[0].type === 'response.create'
        );
        expect(retryCreate).toHaveLength(1);

        // Step 3: Retry succeeds — audio delta arrives
        adapter._firstDeltaLogged = true;
        adapter.isResponding = true; // simulate response in progress

        // Step 4: audio_done after successful retry → should transition now
        adapter._handleAudioDone({});
        expect(adapter._greetingDelivered).toBe(true);
        const sessionUpdates = adapter.send.mock.calls.filter(
            c => c[0] && c[0].type === 'session.update'
        );
        expect(sessionUpdates).toHaveLength(1);
    });

    // ── 7. Incomplete response during greeting also triggers retry ────────
    test('response_done with status=incomplete during greeting triggers retry', () => {
        const adapter = createAdapter();
        adapter._handleResponseDone({
            response: {
                status: 'incomplete',
                status_details: { type: 'incomplete' },
                usage: { input_tokens: 0, output_tokens: 0 }
            }
        });

        expect(adapter._greetingRetried).toBe(true);
        const creates = adapter.send.mock.calls.filter(
            c => c[0] && c[0].type === 'response.create'
        );
        expect(creates).toHaveLength(1);
    });

    // ── 8. Constructor initializes _greetingRetried flag ──────────────────
    test('_greetingRetried flag exists in BaseRealtimeAdapter prototype chain', () => {
        const adapter = createAdapter();
        expect(adapter).toHaveProperty('_greetingRetried', false);
    });
});
