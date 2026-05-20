/**
 * Telemetry Adapter Unit Tests
 *
 * Validates:
 * 1. customEvent emission via OTel Logs API with "microsoft.custom_event.name"
 * 2. callId/turnId/connectionId preserved in attributes (not stripped)
 * 3. Resource attributes set (service.name = 'voicebot')
 * 4. OTel Metrics instruments created and recordMetric() routes correctly
 * 5. Batch trace span emitted as secondary signal
 * 6. Graceful no-op when AZURE_MONITOR_CONNECTION_STRING is not set
 * 7. Shutdown cleans state
 */

const ORIGINAL_ENV = { ...process.env };

// ── Shared mock state ────────────────────────────────────────────────────────
let mockLoggerEmitCalls = [];
let mockSpanEvents = [];
let mockSpanAttrs = {};
let mockSpanEnded = false;
let mockCounterAdds = {};
let mockHistogramRecords = [];
let mockUseAzureMonitorOpts = null;
let mockShutdownCalled = false;
let mockResourcesModule = {
    resourceFromAttributes: (attrs) => ({ attributes: attrs })
};

// ── Module mocks ─────────────────────────────────────────────────────────────

jest.mock('@azure/monitor-opentelemetry', () => ({
    useAzureMonitor: (opts) => {
        mockUseAzureMonitorOpts = opts;
        return {
            shutdown: async () => { mockShutdownCalled = true; }
        };
    }
}));

jest.mock('@opentelemetry/resources', () => mockResourcesModule);

jest.mock('@opentelemetry/semantic-conventions', () => ({
    ATTR_SERVICE_NAME: 'service.name'
}));

jest.mock('@opentelemetry/api-logs', () => ({
    logs: {
        getLogger: () => ({
            emit: (record) => { mockLoggerEmitCalls.push(record); }
        })
    },
    SeverityNumber: { INFO: 9 }
}));

jest.mock('@opentelemetry/api', () => ({
    trace: {
        getTracer: () => ({
            startSpan: (name) => ({
                setAttribute: (k, v) => { mockSpanAttrs[k] = v; },
                addEvent: (name, attrs, ts) => { mockSpanEvents.push({ name, attrs, ts }); },
                end: () => { mockSpanEnded = true; }
            })
        })
    },
    metrics: {
        getMeter: () => ({
            createCounter: (name) => ({
                add: (val, attrs) => {
                    if (!mockCounterAdds[name]) mockCounterAdds[name] = [];
                    mockCounterAdds[name].push({ val, attrs });
                }
            }),
            createHistogram: (name) => ({
                record: (val, attrs) => { mockHistogramRecords.push({ name, val, attrs }); }
            })
        })
    }
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function resetMocks() {
    mockLoggerEmitCalls = [];
    mockSpanEvents = [];
    mockSpanAttrs = {};
    mockSpanEnded = false;
    mockCounterAdds = {};
    mockHistogramRecords = [];
    mockUseAzureMonitorOpts = null;
    mockShutdownCalled = false;
    for (const key of Object.keys(mockResourcesModule)) delete mockResourcesModule[key];
    mockResourcesModule.resourceFromAttributes = (attrs) => ({ attributes: attrs });
}

function freshAdapter() {
    // Clear require cache so __telemetryState resets
    const adapterPath = require.resolve('../adapters/telemetry/azureTelemetryAdapter');
    delete require.cache[adapterPath];
    // Also clear the facade cache so it re-requires the azure adapter
    const facadePath = require.resolve('../adapters/telemetry/telemetryAdapter');
    delete require.cache[facadePath];
    const adapter = require('../adapters/telemetry/azureTelemetryAdapter');
    // Force-reset internal state for test isolation
    adapter.__telemetryState = null;
    return adapter;
}

// ── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
    resetMocks();
    process.env = { ...ORIGINAL_ENV };
});

afterAll(() => {
    process.env = ORIGINAL_ENV;
});

describe('azureTelemetryAdapter', () => {

    describe('init()', () => {

        test('no-ops when AZURE_MONITOR_CONNECTION_STRING is not set', () => {
            delete process.env.AZURE_MONITOR_CONNECTION_STRING;
            delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
            const adapter = freshAdapter();
            adapter.init();
            expect(mockUseAzureMonitorOpts).toBeNull();
        });

        test('initializes with AZURE_MONITOR_CONNECTION_STRING', () => {
            process.env.AZURE_MONITOR_CONNECTION_STRING = 'InstrumentationKey=test';
            const adapter = freshAdapter();
            adapter.init();

            expect(mockUseAzureMonitorOpts).not.toBeNull();
            expect(mockUseAzureMonitorOpts.azureMonitorExporterOptions.connectionString)
                .toBe('InstrumentationKey=test');
        });

        test('also accepts APPLICATIONINSIGHTS_CONNECTION_STRING', () => {
            delete process.env.AZURE_MONITOR_CONNECTION_STRING;
            process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = 'InstrumentationKey=fallback';
            const adapter = freshAdapter();
            adapter.init();

            expect(mockUseAzureMonitorOpts).not.toBeNull();
            expect(mockUseAzureMonitorOpts.azureMonitorExporterOptions.connectionString)
                .toBe('InstrumentationKey=fallback');
        });

        test('sets Resource with service.name=voicebot', () => {
            process.env.AZURE_MONITOR_CONNECTION_STRING = 'InstrumentationKey=test';
            const adapter = freshAdapter();
            adapter.init();

            expect(mockUseAzureMonitorOpts.resource.attributes['service.name'])
                .toBe('voicebot');
        });

        test('honors OTEL_SERVICE_NAME when provided', () => {
            process.env.AZURE_MONITOR_CONNECTION_STRING = 'InstrumentationKey=test';
            process.env.OTEL_SERVICE_NAME = 'voicebot-prod';
            const adapter = freshAdapter();
            adapter.init();

            expect(mockUseAzureMonitorOpts.resource.attributes['service.name'])
                .toBe('voicebot-prod');
        });

        test('sets deployment.environment from NODE_ENV', () => {
            process.env.AZURE_MONITOR_CONNECTION_STRING = 'InstrumentationKey=test';
            process.env.NODE_ENV = 'staging';
            const adapter = freshAdapter();
            adapter.init();

            expect(mockUseAzureMonitorOpts.resource.attributes['deployment.environment'])
                .toBe('staging');
        });

        test('idempotent — second init() is a no-op', () => {
            process.env.AZURE_MONITOR_CONNECTION_STRING = 'InstrumentationKey=test';
            const adapter = freshAdapter();
            adapter.init();
            const firstOpts = mockUseAzureMonitorOpts;
            mockUseAzureMonitorOpts = null;
            adapter.init();
            expect(mockUseAzureMonitorOpts).toBeNull();
        });

        test('initializes without custom resource when resourceFromAttributes is missing', () => {
            delete mockResourcesModule.resourceFromAttributes;
            process.env.AZURE_MONITOR_CONNECTION_STRING = 'InstrumentationKey=test';
            jest.spyOn(console, 'warn').mockImplementation(() => {});

            const adapter = freshAdapter();
            expect(() => adapter.init()).not.toThrow();

            expect(mockUseAzureMonitorOpts).not.toBeNull();
            expect(mockUseAzureMonitorOpts.resource).toBeUndefined();
            expect(mockUseAzureMonitorOpts.azureMonitorExporterOptions.connectionString)
                .toBe('InstrumentationKey=test');
            expect(adapter.__telemetryState.otelLogger).toBeTruthy();
            expect(adapter.__telemetryState.tracer).toBeTruthy();
            expect(adapter.__telemetryState.meters).toBeTruthy();
            expect(console.warn).toHaveBeenCalledWith(
                'Azure telemetry resource initialization skipped: resourceFromAttributes unavailable'
            );
        });

        test('initializes without custom resource when resourceFromAttributes throws', () => {
            mockResourcesModule.resourceFromAttributes = () => {
                throw new TypeError('resource factory unavailable');
            };
            process.env.AZURE_MONITOR_CONNECTION_STRING = 'InstrumentationKey=test';
            jest.spyOn(console, 'warn').mockImplementation(() => {});

            const adapter = freshAdapter();
            expect(() => adapter.init()).not.toThrow();

            expect(mockUseAzureMonitorOpts).not.toBeNull();
            expect(mockUseAzureMonitorOpts.resource).toBeUndefined();
            expect(adapter.__telemetryState.otelLogger).toBeTruthy();
            expect(adapter.__telemetryState.tracer).toBeTruthy();
            expect(adapter.__telemetryState.meters).toBeTruthy();
            expect(console.warn).toHaveBeenCalledWith(
                'Azure telemetry resource initialization skipped:',
                'resource factory unavailable'
            );
        });
    });

    describe('emitBatch()', () => {

        let adapter;
        beforeEach(() => {
            process.env.AZURE_MONITOR_CONNECTION_STRING = 'InstrumentationKey=test';
            adapter = freshAdapter();
            adapter.init();
            resetMocks();
        });

        test('emits customEvents via OTel Logs API with microsoft.custom_event.name', () => {
            adapter.emitBatch([
                { eventType: 'call_summary', callId: 'c1', turnId: 't1', timestamp: 1000, payload: { durationMs: 5000 } }
            ]);

            expect(mockLoggerEmitCalls).toHaveLength(1);
            const record = mockLoggerEmitCalls[0];
            expect(record.attributes['microsoft.custom_event.name']).toBe('call_summary');
            expect(record.body).toBe('call_summary');
            expect(record.severityNumber).toBe(9); // INFO
        });

        test('preserves callId, turnId, connectionId in attributes', () => {
            adapter.emitBatch([
                {
                    eventType: 'response_latency',
                    callId: 'call-123',
                    turnId: 'turn-456',
                    payload: { connectionId: 'ws-789', responseLatencyMs: 350 }
                }
            ]);

            const attrs = mockLoggerEmitCalls[0].attributes;
            expect(attrs.callId).toBe('call-123');
            expect(attrs.turnId).toBe('turn-456');
            expect(attrs.connectionId).toBe('ws-789');
            expect(attrs.responseLatencyMs).toBe(350);
        });

        test('preserves payload eventType before setting telemetry eventType', () => {
            adapter.emitBatch([
                {
                    eventType: 'booking_completed_webhook',
                    callId: 'call-123',
                    payload: { eventType: 'invitee.created' }
                }
            ]);

            const attrs = mockLoggerEmitCalls[0].attributes;
            expect(attrs.eventType).toBe('booking_completed_webhook');
            expect(attrs.payloadEventType).toBe('invitee.created');
        });

        test('flattens object values to JSON strings for App Insights', () => {
            adapter.emitBatch([
                { eventType: 'test', payload: { nested: { a: 1 }, arr: [1, 2] } }
            ]);

            const attrs = mockLoggerEmitCalls[0].attributes;
            expect(attrs.nested).toBe('{"a":1}');
            expect(attrs.arr).toBe('[1,2]');
        });

        test('emits secondary batch trace span', () => {
            adapter.emitBatch([
                { eventType: 'speech_emitted', payload: { durationMs: 100 } },
                { eventType: 'speech_completed', payload: { durationMs: 200 } }
            ]);

            expect(mockSpanAttrs['event.count']).toBe(2);
            expect(mockSpanEvents).toHaveLength(2);
            expect(mockSpanEvents[0].name).toBe('speech_emitted');
            expect(mockSpanEnded).toBe(true);
        });

        test('handles empty batch gracefully', () => {
            adapter.emitBatch([]);
            expect(mockLoggerEmitCalls).toHaveLength(0);
        });

        test('handles null/undefined batch gracefully', () => {
            adapter.emitBatch(null);
            adapter.emitBatch(undefined);
            expect(mockLoggerEmitCalls).toHaveLength(0);
        });
    });

    describe('recordMetric()', () => {

        let adapter;
        beforeEach(() => {
            process.env.AZURE_MONITOR_CONNECTION_STRING = 'InstrumentationKey=test';
            adapter = freshAdapter();
            adapter.init();
            resetMocks();
        });

        test('records counter metrics', () => {
            adapter.recordMetric('escalation_rate', 1, { reason: 'hostility' });
            expect(mockCounterAdds['voicebot.escalation_rate']).toHaveLength(1);
            expect(mockCounterAdds['voicebot.escalation_rate'][0].val).toBe(1);
        });

        test('records synthesis_score_distribution as histogram', () => {
            adapter.recordMetric('synthesis_score_distribution', 0.85);
            expect(mockHistogramRecords).toHaveLength(1);
            expect(mockHistogramRecords[0].val).toBe(0.85);
        });

        test('ignores unknown metric names', () => {
            adapter.recordMetric('nonexistent_metric', 1);
            expect(Object.keys(mockCounterAdds)).toHaveLength(0);
            expect(mockHistogramRecords).toHaveLength(0);
        });

        test('no-ops when not initialized', () => {
            delete process.env.AZURE_MONITOR_CONNECTION_STRING;
            const uninitAdapter = freshAdapter();
            // Don't call init
            uninitAdapter.recordMetric('escalation_rate', 1);
            // Should not throw
        });
    });

    describe('shutdown()', () => {

        test('calls monitor.shutdown() and resets state', async () => {
            process.env.AZURE_MONITOR_CONNECTION_STRING = 'InstrumentationKey=test';
            const adapter = freshAdapter();
            adapter.init();
            await adapter.shutdown();
            expect(mockShutdownCalled).toBe(true);
            expect(adapter.__telemetryState.otelLogger).toBeNull();
            expect(adapter.__telemetryState.tracer).toBeNull();
            expect(adapter.__telemetryState.meters).toBeNull();
        });
    });
});

describe('telemetryAdapter (facade)', () => {

    test('passes recordMetric through to azure adapter', () => {
        const facadePath = require.resolve('../adapters/telemetry/telemetryAdapter');
        delete require.cache[facadePath];

        process.env.AZURE_MONITOR_CONNECTION_STRING = 'InstrumentationKey=test';
        process.env.VOICEBOT_TELEMETRY_AZURE_IN_JEST = 'true';
        const facade = require('../adapters/telemetry/telemetryAdapter');
        // Reset facade state so it re-initializes
        if (facade.__adapterState) {
            facade.__adapterState.initialized = false;
            facade.__adapterState.impl = null;
        }
        facade.init();
        resetMocks();

        facade.recordMetric('clarification_rate', 1);
        expect(mockCounterAdds['voicebot.clarification_rate']).toHaveLength(1);
    });
});
