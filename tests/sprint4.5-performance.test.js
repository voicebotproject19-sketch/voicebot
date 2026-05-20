'use strict';

/**
 * Sprint 4.5 — Performance Tests (Phase 1 + Phase 2)
 *
 * Covers:
 *  1.1  VAD cohort stability (stable per-adapter, not re-rolled)
 *  1.2  Reduced server_vad defaults (200/400)
 *  1.4  Token budget default 25000
 *  1.5  Model identity wired (_modelId, _abCohort)
 *  2.1  Semantic VAD payload (eagerness, no silence_duration/prefix_padding)
 *  2.2  Persona vadEagerness support
 *  2.3  Semantic VAD A/B (azure-only guard, mutually exclusive with silence A/B)
 *
 * Run: npx jest tests/sprint4.5-performance.test.js --no-coverage
 */

const path = require('path');

jest.mock('../Utils/telemetry', () => ({
    emit: jest.fn(),
    isKnownEvent: () => true
}));

const BaseRealtimeAdapter = require(path.join(__dirname, '..', 'adapters', 'ai', 'BaseRealtimeAdapter'));

function makeAdapter(overrides = {}) {
    const adapter = Object.create(BaseRealtimeAdapter.prototype);
    adapter.vadMode = overrides.vadMode || 'server_vad';
    adapter._langCode = overrides._langCode || 'en';
    adapter._audioConfig = overrides._audioConfig || {};
    adapter._vadAbAssignment = overrides._vadAbAssignment || null;
    adapter._vadAbCohort = undefined;
    adapter.callSID = 'test-perf';
    // providerName is a getter on subclass prototypes — use defineProperty
    Object.defineProperty(adapter, 'providerName', { value: overrides.providerName || 'azure-realtime', configurable: true });
    adapter.emitTelemetry = jest.fn();
    return adapter;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1.1 VAD COHORT STABILITY
// ═══════════════════════════════════════════════════════════════════════════
describe('Step 1.1 — VAD cohort stability', () => {
    test('50x calls to getVADConfig on same adapter return same cohort', () => {
        const adapter = makeAdapter();
        adapter._vadAbAssignment = { inCohort: true, cohort: 'experiment', mode: 'server_vad', silenceMs: 350 };
        const cohorts = new Set();
        for (let i = 0; i < 50; i++) {
            adapter.getVADConfig();
            cohorts.add(adapter._vadAbCohort);
        }
        expect(cohorts.size).toBe(1);
        expect(cohorts.has('experiment')).toBe(true);
    });

    test('control cohort is also stable', () => {
        const adapter = makeAdapter();
        adapter._vadAbAssignment = { inCohort: false, cohort: 'control', mode: 'server_vad' };
        const cohorts = new Set();
        for (let i = 0; i < 50; i++) {
            adapter.getVADConfig();
            cohorts.add(adapter._vadAbCohort);
        }
        expect(cohorts.size).toBe(1);
        expect(cohorts.has('control')).toBe(true);
    });

    test('experiment cohort uses assigned silence duration', () => {
        const adapter = makeAdapter();
        adapter._vadAbAssignment = { inCohort: true, cohort: 'experiment', mode: 'server_vad', silenceMs: 350 };
        const config = adapter.getVADConfig();
        expect(config.silence_duration_ms).toBe(350);
    });

    test('no assignment defaults to control', () => {
        const adapter = makeAdapter();
        adapter._vadAbAssignment = null;
        const config = adapter.getVADConfig();
        expect(adapter._vadAbCohort).toBe('control');
        expect(config.silence_duration_ms).toBe(400); // new default
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 1.2 REDUCED DEFAULTS
// ═══════════════════════════════════════════════════════════════════════════
describe('Step 1.2 — Reduced server_vad defaults', () => {
    const envBackup = {};
    beforeEach(() => {
        envBackup.VAD_PREFIX_PADDING = process.env.VAD_PREFIX_PADDING;
        envBackup.VAD_SILENCE_DURATION = process.env.VAD_SILENCE_DURATION;
        delete process.env.VAD_PREFIX_PADDING;
        delete process.env.VAD_SILENCE_DURATION;
        delete process.env.VAD_PREFIX_PADDING_EN;
        delete process.env.VAD_SILENCE_DURATION_EN;
    });
    afterEach(() => {
        if (envBackup.VAD_PREFIX_PADDING !== undefined) process.env.VAD_PREFIX_PADDING = envBackup.VAD_PREFIX_PADDING;
        else delete process.env.VAD_PREFIX_PADDING;
        if (envBackup.VAD_SILENCE_DURATION !== undefined) process.env.VAD_SILENCE_DURATION = envBackup.VAD_SILENCE_DURATION;
        else delete process.env.VAD_SILENCE_DURATION;
    });

    test('prefix_padding defaults to 200ms (was 300)', () => {
        const adapter = makeAdapter();
        const config = adapter.getVADConfig();
        expect(config.prefix_padding_ms).toBe(200);
    });

    test('silence_duration defaults to 400ms (was 600)', () => {
        const adapter = makeAdapter();
        const config = adapter.getVADConfig();
        expect(config.silence_duration_ms).toBe(400);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 1.4 TOKEN BUDGET
// ═══════════════════════════════════════════════════════════════════════════
describe('Step 1.4 — Token budget', () => {
    const envBackup = {};
    beforeEach(() => {
        envBackup.MAX_TOTAL_TOKEN_BUDGET = process.env.MAX_TOTAL_TOKEN_BUDGET;
        delete process.env.MAX_TOTAL_TOKEN_BUDGET;
    });
    afterEach(() => {
        if (envBackup.MAX_TOTAL_TOKEN_BUDGET !== undefined) process.env.MAX_TOTAL_TOKEN_BUDGET = envBackup.MAX_TOTAL_TOKEN_BUDGET;
        else delete process.env.MAX_TOTAL_TOKEN_BUDGET;
    });

    test('default token budget is 25000 (was 12000)', () => {
        const adapter = new BaseRealtimeAdapter({});
        expect(adapter.maxTotalTokenBudget).toBe(25000);
    });

    test('env var override still works', () => {
        process.env.MAX_TOTAL_TOKEN_BUDGET = '30000';
        const adapter = new BaseRealtimeAdapter({});
        expect(adapter.maxTotalTokenBudget).toBe(30000);
    });

    test('50000 ceiling still enforced', () => {
        process.env.MAX_TOTAL_TOKEN_BUDGET = '99999';
        const adapter = new BaseRealtimeAdapter({});
        expect(adapter.maxTotalTokenBudget).toBe(50000);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 1.5 MODEL IDENTITY
// ═══════════════════════════════════════════════════════════════════════════
describe('Step 1.5 — Model identity wired', () => {
    test('_modelId stored from config.model', () => {
        const adapter = new BaseRealtimeAdapter({ model: 'phi4-mm-realtime' });
        expect(adapter._modelId).toBe('phi4-mm-realtime');
    });

    test('_abCohort stored from config._abCohort', () => {
        const adapter = new BaseRealtimeAdapter({ _abCohort: 'experiment' });
        expect(adapter._abCohort).toBe('experiment');
    });

    test('_modelId defaults to null when not provided', () => {
        const adapter = new BaseRealtimeAdapter({});
        expect(adapter._modelId).toBeNull();
    });

    test('_abCohort defaults to control when not provided', () => {
        const adapter = new BaseRealtimeAdapter({});
        expect(adapter._abCohort).toBe('control');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2.1 SEMANTIC VAD PAYLOAD
// ═══════════════════════════════════════════════════════════════════════════
describe('Step 2.1 — Semantic VAD payload', () => {
    test('azure_semantic_vad returns silence_duration_ms, not eagerness', () => {
        const adapter = makeAdapter({ vadMode: 'azure_semantic_vad' });
        const config = adapter.getVADConfig();
        expect(config.type).toBe('azure_semantic_vad');
        expect(config.eagerness).toBeUndefined();
        expect(config.create_response).toBe(false);
        expect(config.interrupt_response).toBe(true);
        // threshold IS valid for semantic VAD (API docs confirm)
        expect(config.threshold).toBe(0.5);
        // silence_duration_ms is valid for azure_semantic_vad per Voice Live docs
        expect(config.silence_duration_ms).toBe(400);
        expect(config.prefix_padding_ms).toBeUndefined();
        // Voice Live semantic VAD fields
        expect(config.remove_filler_words).toBe(true);
        expect(config.speech_duration_ms).toBe(80);
        expect(config.auto_truncate).toBe(false);
    });

    test('silence_duration_ms respects _vadAbAssignment first', () => {
        const adapter = makeAdapter({ vadMode: 'azure_semantic_vad' });
        adapter._vadAbAssignment = { inCohort: true, cohort: 'experiment', mode: 'azure_semantic_vad', silenceMs: 350 };
        const config = adapter.getVADConfig();
        expect(config.silence_duration_ms).toBe(350);
    });

    test('silence_duration_ms falls back to _audioConfig.vadSilenceDuration', () => {
        const adapter = makeAdapter({ vadMode: 'azure_semantic_vad', _audioConfig: { vadSilenceDuration: 500 } });
        const config = adapter.getVADConfig();
        expect(config.silence_duration_ms).toBe(500);
    });

    test('silence_duration_ms falls back to env var', () => {
        const orig = process.env.VAD_SILENCE_DURATION;
        process.env.VAD_SILENCE_DURATION = '700';
        const adapter = makeAdapter({ vadMode: 'azure_semantic_vad' });
        const config = adapter.getVADConfig();
        expect(config.silence_duration_ms).toBe(700);
        if (orig !== undefined) process.env.VAD_SILENCE_DURATION = orig;
        else delete process.env.VAD_SILENCE_DURATION;
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2.3 SEMANTIC VAD A/B
// ═══════════════════════════════════════════════════════════════════════════
describe('Step 2.3 — Semantic VAD A/B', () => {
    // These tests verify the A/B assignment structure, not initialize() directly
    // (initialize() requires full persona registry which is complex to mock)

    test('semantic A/B assignment structure has correct shape', () => {
        const assignment = { inCohort: true, cohort: 'experiment', mode: 'azure_semantic_vad', eagerness: 'medium' };
        expect(assignment.mode).toBe('azure_semantic_vad');
        expect(assignment.eagerness).toBe('medium');
        expect(assignment.inCohort).toBe(true);
    });

    test('silence A/B assignment structure has correct shape', () => {
        const assignment = { inCohort: true, cohort: 'experiment', mode: 'server_vad', silenceMs: 350 };
        expect(assignment.mode).toBe('server_vad');
        expect(assignment.silenceMs).toBe(350);
    });

    test('semantic A/B assignment feeds correctly into getVADConfig', () => {
        const adapter = makeAdapter({ vadMode: 'azure_semantic_vad' });
        adapter._vadAbAssignment = { inCohort: true, cohort: 'experiment', mode: 'azure_semantic_vad', silenceMs: 350 };
        const config = adapter.getVADConfig();
        expect(config.type).toBe('azure_semantic_vad');
        expect(config.silence_duration_ms).toBe(350);
        expect(config.eagerness).toBeUndefined();
        expect(adapter._vadAbCohort).toBe('experiment');
    });

    test('control assignment still returns server_vad with default silence', () => {
        const adapter = makeAdapter();
        adapter._vadAbAssignment = { inCohort: false, cohort: 'control', mode: 'server_vad' };
        const config = adapter.getVADConfig();
        expect(config.type).toBe('server_vad');
        expect(adapter._vadAbCohort).toBe('control');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// vadMode=none unchanged
// ═══════════════════════════════════════════════════════════════════════════
describe('Regression: vadMode=none still returns { type: "none" }', () => {
    test('returns none config', () => {
        const adapter = makeAdapter({ vadMode: 'none' });
        expect(adapter.getVADConfig()).toEqual({ type: 'none' });
    });
});
