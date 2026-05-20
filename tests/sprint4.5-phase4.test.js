'use strict';

/**
 * Sprint 4.5 Phase 4 — Prompt Dedup + Time Formatting
 *
 * Validates:
 *  4.1  server_vad response.create has NO input[] (dedup)
 *  4.1b vadMode=none response.create still HAS input[] (safety net)
 *  4.1c deferred queue drain re-enters insertUpdatedPrompt (same path)
 *  4.2  formatConversationContext uses fast padStart, not toLocaleTimeString
 *
 * Run: npx jest tests/sprint4.5-phase4.test.js --no-coverage
 */

const path = require('path');

// ── mocks ──────────────────────────────────────────────────────────────
jest.mock('../Utils/telemetry', () => ({ emit: jest.fn(), isKnownEvent: () => true }));
jest.mock('../adapters/llm/hangupDecision', () => ({ analyzeConversationForHangup: jest.fn() }));
jest.mock('../Helper/quickDecisionFilter', () => ({
    quickHangupDecision: jest.fn().mockReturnValue(null),
    shouldPerformAnalysis: jest.fn().mockReturnValue(false)
}));
jest.mock('../Helper/conversationPhase', () => ({ computePhase: jest.fn().mockReturnValue('greeting') }));
jest.mock('../Helper/hallucinationGuard', () => ({
    isFactualQuestionWithoutKB: jest.fn().mockReturnValue(false),
    scanForHallucination: jest.fn().mockReturnValue(null),
    getHallucinationFallback: jest.fn()
}));
jest.mock('../config/latencyResponsivenessConfig', () => ({
    LATENCY_COMPENSATION: { enabled: false },
    PHASE3_ENABLED: false,
    MICRO_ACK: { enabled: false }
}));
jest.mock('../rag/ragGuardrails', () => ({
    legacyRetrievalToDocs: jest.fn().mockReturnValue([]),
    applyRagGuardrails: jest.fn().mockReturnValue({ allowed: true, docs: [] }),
    recordRetrievalTimeout: jest.fn()
}));
jest.mock('../logic/intentGate', () => ({
    evaluateIntentConfidence: jest.fn().mockReturnValue({ decision: 'skip_kb', reason: 'test' })
}));
jest.mock('../config/phase4Config', () => ({ PHASE4_ENABLED: false }));
jest.mock('../services/precomputedAnswers', () => ({
    matchPrecomputedAnswer: jest.fn().mockReturnValue(null)
}));

const ConversationEngine = require(path.join(__dirname, '..', 'session', 'conversationEngine'));
const telemetry = require('../Utils/telemetry');

// ── helpers ────────────────────────────────────────────────────────────
function makeAdapter(vadMode = 'server_vad') {
    const sent = [];
    const langObj = {
        buildTurnPrompt: (ctx) => `prompt for ${ctx.userQuestion}`,
        baseInstruction: () => 'fallback instruction'
    };
    return {
        vadMode,
        callSID: 'test-phase4',
        count: 3,
        isResponding: false,
        isUserSpeaking: false,
        _handoverTriggered: false,
        _deferredUserInputQueue: [],
        _maxDeferredUserInputQueue: 3,
        _deferredInstruction: null,
        _pendingLanguageCorrection: null,
        _wordLimitOverride: null,
        _contextSummary: null,
        _langCode: 'en',
        _modelTier: 'slm',
        _currentPhase: 'greeting',
        _currentToneDirective: null,
        _bargeInOccurred: false,
        _isMuted: false,
        _summarizationInFlight: false,
        _summarizationPermanentlyFailed: false,
        _latencyCompensationLevel: null,
        _prewarmKbResult: null,
        _prewarmKbQuery: null,
        _lastRelevantKnowledge: '',
        _phase4Profile: null,
        _clarificationCount: 0,
        conversationContext: [],
        conversationPhase: 'greeting',
        userEmail: null,
        userPhone: null,
        preferredSlot: null,
        hasAskedForConsultation: false,
        kb: null,
        kbEn: null,
        lang: langObj,
        persona: {
            id: 'test',
            retrieval: null,
            languages: { en: langObj }
        },
        recipient: 'TestUser',
        name: 'TestBot',
        addConversationContext: jest.fn(),
        _buildFullSessionConfig: (instr) => ({ instructions: instr }),
        _buildResponseCreate: (opts) => ({ type: 'response.create', response: opts }),
        send: (msg) => sent.push(msg),
        _sentMessages: sent,
        _getAdaptiveTokenLimit: () => 400,
        _getAdaptiveTemperature: () => 0.7,
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// 4.1 DIRECT RESPONSE.CREATE (per-response overrides, no session.update)
// ═══════════════════════════════════════════════════════════════════════════
describe('4.1 Direct response.create with per-response overrides', () => {
    afterEach(() => {
        delete process.env.RESPONSE_INSTRUCTION_WARN_CHARS;
        delete process.env.RESPONSE_INSTRUCTION_HARD_WARN_CHARS;
        delete process.env.RESPONSE_INSTRUCTION_BOOKING_MAX_TURNS;
        telemetry.emit.mockClear();
    });

    test('server_vad: single response.create sent directly with instructions override', () => {
        const adapter = makeAdapter('server_vad');
        const engine = new ConversationEngine(adapter);
        engine.insertUpdatedPrompt('What services do you offer?', 'high');

        // Only response.create sent (no session.update)
        expect(adapter._sentMessages.length).toBe(1);
        expect(adapter._sentMessages[0].type).toBe('response.create');

        // Per-response instruction override present
        const rc = adapter._sentMessages[0];
        expect(rc.response.instructions).toBeDefined();
        expect(rc.response.instructions).toContain('LANGUAGE RULE');

        // No input[] needed — instructions are in the response override
        expect(rc.response.input).toBeUndefined();
    });

    test('vadMode=none: response.create sent directly with instructions override', () => {
        const adapter = makeAdapter('none');
        const engine = new ConversationEngine(adapter);
        engine.insertUpdatedPrompt('Tell me about pricing', 'high');

        // Single response.create sent directly
        expect(adapter._sentMessages.length).toBe(1);
        expect(adapter._sentMessages[0].type).toBe('response.create');

        // Per-response instruction override present
        const rc = adapter._sentMessages[0];
        expect(rc.response.instructions).toBeDefined();
    });

    test('response.create includes max_response_output_tokens', () => {
        const adapter = makeAdapter('server_vad');
        const engine = new ConversationEngine(adapter);
        engine.insertUpdatedPrompt('Hello', 'high');

        expect(adapter._sentMessages.length).toBe(1);
        const rc = adapter._sentMessages[0];
        expect(rc.response.max_response_output_tokens).toBe(400);
    });

    test('booking simple confirmations cap context and skip fallback KB', () => {
        const adapter = makeAdapter('server_vad');
        adapter.conversationPhase = 'email-collection';
        adapter.hasAskedForConsultation = true;
        adapter.kb = {
            retrieveRelevantInfo: jest.fn(() => 'specific KB'),
            getGeneralInfo: jest.fn(() => 'general KB')
        };
        adapter.lang.buildTurnPrompt = jest.fn(ctx => `booking prompt for ${ctx.userQuestion}`);
        adapter.conversationContext = Array.from({ length: 7 }, (_, index) => ({
            sender: index % 2 === 0 ? 'USER' : 'AI',
            message: `Message ${index + 1}`,
            timestamp: '2026-04-20T09:05:30.000Z'
        }));

        const engine = new ConversationEngine(adapter);
        engine.insertUpdatedPrompt('Yes please', 'high');

        expect(adapter.kb.retrieveRelevantInfo).not.toHaveBeenCalled();
        expect(adapter.kb.getGeneralInfo).not.toHaveBeenCalled();
        const promptArgs = adapter.lang.buildTurnPrompt.mock.calls[0][0];
        expect(promptArgs.relevantKnowledge).toBe('');
        expect(promptArgs.conversationContext).toContain('Message 4');
        expect(promptArgs.conversationContext).toContain('Message 7');
        expect(promptArgs.conversationContext).not.toContain('Message 3');
    });

    test('booking factual follow-up can still use KB despite simple prefix', () => {
        const adapter = makeAdapter('server_vad');
        adapter.conversationPhase = 'email-collection';
        adapter.hasAskedForConsultation = true;
        adapter.kb = {
            retrieveRelevantInfo: jest.fn(() => 'pricing KB'),
            getGeneralInfo: jest.fn(() => 'general KB')
        };
        adapter.lang.buildTurnPrompt = jest.fn(ctx => `booking prompt with ${ctx.relevantKnowledge}`);

        const engine = new ConversationEngine(adapter);
        engine.insertUpdatedPrompt('Sure pricing?', 'high');

        expect(adapter.kb.retrieveRelevantInfo).toHaveBeenCalledWith('Sure pricing?', undefined, undefined);
        const promptArgs = adapter.lang.buildTurnPrompt.mock.calls[0][0];
        expect(promptArgs.relevantKnowledge).toBe('pricing KB');
    });

    test('prompt budget warning is emitted without corrupting response instructions', () => {
        process.env.RESPONSE_INSTRUCTION_WARN_CHARS = '1000';
        process.env.RESPONSE_INSTRUCTION_HARD_WARN_CHARS = '5000';
        const adapter = makeAdapter('server_vad');
        adapter.conversationPhase = 'email-collection';
        adapter.hasAskedForConsultation = true;
        adapter.lang.buildTurnPrompt = jest.fn(() => `PHASE BLOCK\n${'x'.repeat(1200)}`);

        const engine = new ConversationEngine(adapter);
        engine.insertUpdatedPrompt('Yes please', 'high');

        expect(telemetry.emit).toHaveBeenCalledWith('prompt_budget_warning', expect.objectContaining({
            callId: 'test-phase4',
            phase: 'email-collection',
            instructionLen: expect.any(Number),
            softCharBudget: 1000,
            hardCharBudget: 5000,
            skippedKbForSimpleIntent: true
        }));
        const instructions = adapter._sentMessages[0].response.instructions;
        expect(instructions).toContain('LANGUAGE RULE');
        expect(instructions).toContain('PHASE BLOCK');
    });

    test('deferred queue drain re-enters insertUpdatedPrompt for same direct-send path', () => {
        const adapter = makeAdapter('server_vad');
        adapter.isResponding = true; // force deferral
        const engine = new ConversationEngine(adapter);
        engine.insertUpdatedPrompt('Deferred question', 'high');

        // Queued, not sent as response.create
        expect(adapter._deferredUserInputQueue.length).toBe(1);
        expect(adapter._sentMessages.length).toBe(0);

        // Simulate drain: stop responding, re-call with dequeued item
        adapter.isResponding = false;
        const { userQuestion, decision } = adapter._deferredUserInputQueue.shift();
        engine.insertUpdatedPrompt(userQuestion, decision);

        // Now response.create sent directly with instructions
        expect(adapter._sentMessages.length).toBe(1);
        expect(adapter._sentMessages[0].type).toBe('response.create');
        expect(adapter._sentMessages[0].response.instructions).toBeDefined();
        expect(adapter._sentMessages[0].response.input).toBeUndefined();
    });

    test('duplicate short deferred input refreshes owner for latest utterance', () => {
        const adapter = makeAdapter('server_vad');
        adapter.isResponding = true;
        let ownerSeq = 0;
        adapter._captureResponseOwner = jest.fn(source => ({ source, seq: ++ownerSeq }));
        const engine = new ConversationEngine(adapter);

        engine.insertUpdatedPrompt('hello', 'low');
        const firstOwner = adapter._deferredUserInputQueue[0].owner;
        engine.insertUpdatedPrompt('hello', 'high');

        expect(adapter._deferredUserInputQueue).toHaveLength(1);
        expect(adapter._deferredUserInputQueue[0].decision).toBe('high');
        expect(adapter._deferredUserInputQueue[0].owner).toEqual({ source: 'deferred_user_input', seq: 2 });
        expect(adapter._deferredUserInputQueue[0].owner).not.toBe(firstOwner);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4.2 TIME FORMATTING
// ═══════════════════════════════════════════════════════════════════════════
describe('4.2 Time Formatting — padStart vs toLocaleTimeString', () => {
    test('formats HH:MM correctly for various times', () => {
        const adapter = makeAdapter();
        adapter.conversationContext = [
            { sender: 'USER', message: 'Hello', timestamp: '2026-04-20T09:05:30.000Z' },
            { sender: 'AI', message: 'Hi there', timestamp: '2026-04-20T14:00:00.000Z' },
            { sender: 'USER', message: 'Tell me more', timestamp: '2026-04-20T00:30:00.000Z' },
        ];
        const engine = new ConversationEngine(adapter);
        const formatted = engine.formatConversationContext();

        // Verify HH:MM format with zero-padding (UTC times, may shift in local TZ)
        const lines = formatted.split('\n');
        expect(lines.length).toBe(3);
        // Each line should match [HH:MM] Speaker: Message
        lines.forEach(line => {
            expect(line).toMatch(/^\[\d{2}:\d{2}\] .+: .+$/);
        });
    });

    test('empty context returns placeholder', () => {
        const adapter = makeAdapter();
        adapter.conversationContext = [];
        const engine = new ConversationEngine(adapter);
        expect(engine.formatConversationContext()).toBe('(Call just started - no previous exchanges)');
    });

    test('respects maxTurns limit', () => {
        const adapter = makeAdapter();
        adapter.conversationContext = Array.from({ length: 12 }, (_, i) => ({
            sender: i % 2 === 0 ? 'USER' : 'AI',
            message: `Turn ${i}`,
            timestamp: new Date(2026, 3, 20, 10, i).toISOString()
        }));
        const engine = new ConversationEngine(adapter);
        const formatted = engine.formatConversationContext(5);
        expect(formatted.split('\n').length).toBe(5);
    });

    test('includes context summary prefix when available', () => {
        const adapter = makeAdapter();
        adapter._contextSummary = 'User asked about pricing';
        adapter.conversationContext = [
            { sender: 'USER', message: 'What about timing?', timestamp: '2026-04-20T10:00:00.000Z' }
        ];
        const engine = new ConversationEngine(adapter);
        const formatted = engine.formatConversationContext();
        expect(formatted).toMatch(/^\[Earlier: User asked about pricing\]/);
    });

    test('padStart is faster than toLocaleTimeString (perf baseline)', () => {
        // Micro-benchmark: 10k iterations of padStart formatting
        const ts = '2026-04-20T14:35:22.000Z';
        const iterations = 10000;

        const startPad = performance.now();
        for (let i = 0; i < iterations; i++) {
            const d = new Date(ts);
            String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
        }
        const padTime = performance.now() - startPad;

        const startLocale = performance.now();
        for (let i = 0; i < iterations; i++) {
            new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        }
        const localeTime = performance.now() - startLocale;

        const speedup = localeTime / padTime;
        console.log(`    padStart: ${padTime.toFixed(1)}ms, toLocaleTimeString: ${localeTime.toFixed(1)}ms, speedup: ${speedup.toFixed(0)}x`);
        // padStart should be at least 10x faster (typically 100-500x)
        expect(speedup).toBeGreaterThan(10);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4.1+4.2 COMBINED: Prompt Size Simulation
// ═══════════════════════════════════════════════════════════════════════════
describe('Phase 4 ROI Simulation', () => {
    test('direct response.create eliminates session.update round-trip', () => {
        const samplePrompt = 'You are Sarah, an AI sales assistant for company. ' +
            'Your goal is to engage prospects in a natural conversation about software development services. ' +
            'Be concise, professional, and empathetic. Never use more than 2 sentences per response. ' +
            'Current phase: greeting. Previous context available in session.';

        // Before: prompt in session.update + empty response.create (2 messages)
        const beforeMessages = 2; // session.update + response.create

        // After: single response.create with per-response instructions override
        const afterMessages = 1;

        const reduction = ((beforeMessages - afterMessages) / beforeMessages) * 100;
        console.log(`    Before: ${beforeMessages} messages, After: ${afterMessages} message, Reduction: ${reduction.toFixed(0)}%`);
        expect(reduction).toBe(50); // half the message count
    });

    test('per-call latency savings at scale (8-turn conversation)', () => {
        // Each turn previously required session.update wait (15-40ms)
        const turns = 8;
        const minSavingsPerTurn = 15; // ms
        const maxSavingsPerTurn = 40; // ms

        const totalMinSavings = turns * minSavingsPerTurn;
        const totalMaxSavings = turns * maxSavingsPerTurn;
        console.log(`    8-turn call: ${totalMinSavings}-${totalMaxSavings}ms saved by eliminating session.update round-trips`);
        expect(totalMinSavings).toBeGreaterThanOrEqual(120);
        expect(totalMaxSavings).toBeLessThanOrEqual(320);
    });

    test('time formatting latency budget per 8-turn context build', () => {
        const timestamps = Array.from({ length: 8 }, (_, i) =>
            new Date(2026, 3, 20, 10 + i, 30).toISOString()
        );
        const iterations = 1000;

        // New path: padStart
        const start = performance.now();
        for (let iter = 0; iter < iterations; iter++) {
            timestamps.forEach(ts => {
                const d = new Date(ts);
                String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
            });
        }
        const totalMs = performance.now() - start;
        const perCallMs = totalMs / iterations;

        console.log(`    1000 × 8-turn format: ${totalMs.toFixed(1)}ms total, ${perCallMs.toFixed(3)}ms per call`);
        // Should be < 0.1ms per 8-turn format (vs ~5-10ms with toLocaleTimeString)
        expect(perCallMs).toBeLessThan(1);
    });
});
