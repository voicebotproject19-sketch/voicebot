/**
 * Azure Telemetry Adapter
 *
 * Uses the Azure Monitor OpenTelemetry distro (useAzureMonitor) to send
 * telemetry to Application Insights.
 *
 * - Custom events  → customEvents table  (via OTel Logs API + "microsoft.custom_event.name")
 * - Custom metrics → customMetrics table  (via OTel Metrics API)
 * - Trace spans    → dependencies table   (via OTel Traces API, secondary)
 **/

const os = require("os");

function getTelemetryState() {
    if (!module.exports.__telemetryState) {
        module.exports.__telemetryState = {
            otelLogger: null,
            tracer: null,
            monitor: null,
            meters: null
        };
    }
    return module.exports.__telemetryState;
}

function init() {

    const state = getTelemetryState();
    if (state.otelLogger) return;

    const connection =
        process.env.AZURE_MONITOR_CONNECTION_STRING ||
        process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;

    if (!connection) return;

    try {

        const { useAzureMonitor } = require("@azure/monitor-opentelemetry");
        const resources = require("@opentelemetry/resources");
        const { ATTR_SERVICE_NAME } = require("@opentelemetry/semantic-conventions");
        const { logs, SeverityNumber } = require("@opentelemetry/api-logs");
        const { trace, metrics } = require("@opentelemetry/api");

        let version = "unknown";
        try { version = require("../../package.json").version || "unknown"; } catch {}

        const resourceAttributes = {
            [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || "voicebot",
            "service.namespace": process.env.OTEL_SERVICE_NAMESPACE || "voicebot",
            "service.instance.id": process.env.OTEL_SERVICE_INSTANCE_ID || process.env.HOSTNAME || os.hostname(),
            "service.version": version,
            "deployment.environment": process.env.NODE_ENV || "development"
        };

        const azureMonitorOptions = {
            azureMonitorExporterOptions: { connectionString: connection }
        };
        const resourceFromAttributes = resources && resources.resourceFromAttributes;
        if (typeof resourceFromAttributes === "function") {
            try {
                azureMonitorOptions.resource = resourceFromAttributes(resourceAttributes);
            } catch (resourceErr) {
                console.warn("Azure telemetry resource initialization skipped:", resourceErr.message);
            }
        } else {
            console.warn("Azure telemetry resource initialization skipped: resourceFromAttributes unavailable");
        }

        state.monitor = useAzureMonitor(azureMonitorOptions);

        // OTel Logs API logger → populates customEvents table
        state.otelLogger = logs.getLogger("voicebot-telemetry");
        state.SeverityNumber = SeverityNumber;

        // OTel Traces API tracer → secondary trace signal
        state.tracer = trace.getTracer("voicebot-telemetry");

        // OTel Metrics API → populates customMetrics table
        const meter = metrics.getMeter("voicebot-metrics");
        state.meters = {
            ragTimeout:        meter.createCounter("voicebot.rag_timeout_rate"),
            clarification:     meter.createCounter("voicebot.clarification_rate"),
            escalation:        meter.createCounter("voicebot.escalation_rate"),
            transactionConfirm: meter.createCounter("voicebot.transaction_confirmation_rate"),
            humorUsage:        meter.createCounter("voicebot.humor_usage_rate"),
            unsupportedNumeric: meter.createCounter("voicebot.unsupported_numeric_rate"),
            injectionRemoved:  meter.createCounter("voicebot.injection_sentences_removed"),
            synthesisScore:    meter.createHistogram("voicebot.synthesis_score", {
                description: "Synthesis quality score distribution (0-1)"
            })
        };

    } catch (err) {

        console.error("Azure telemetry initialization failed:", err.message);
        state.otelLogger = null;

    }
}

/**
 * Emit a batch of telemetry events.
 * Each event is sent as a customEvent (via OTel Logs API) AND as a span event
 * on a batch trace span (secondary signal for end-to-end transaction views).
 */
function emitBatch(events) {

    const state = getTelemetryState();
    if (!events || events.length === 0) return;

    // ── Primary: customEvents via OTel Logs API ──────────────────────────
    if (state.otelLogger) {
        for (const e of events) {
            try {
                const attrs = { ...(e.payload || {}) };
                if (attrs.eventType && attrs.eventType !== e.eventType) {
                    attrs.payloadEventType = attrs.eventType;
                }
                attrs["microsoft.custom_event.name"] = e.eventType;
                attrs.eventType = e.eventType;
                if (e.callId) attrs.callId = e.callId;
                if (e.turnId) attrs.turnId = e.turnId;

                // Flatten non-primitive values for App Insights compatibility
                for (const k of Object.keys(attrs)) {
                    const v = attrs[k];
                    if (v !== null && v !== undefined && typeof v === "object") {
                        attrs[k] = JSON.stringify(v);
                    }
                }

                state.otelLogger.emit({
                    severityNumber: state.SeverityNumber.INFO,
                    body: e.eventType,
                    attributes: attrs
                });
            } catch {}
        }
    }

    // ── Secondary: batch trace span ──────────────────────────────────────
    if (state.tracer) {
        try {
            const span = state.tracer.startSpan("voicebot.telemetry.batch");
            span.setAttribute("event.count", events.length);
            span.setAttribute("telemetry.source", "voicebot");
            span.setAttribute("deployment.env", process.env.NODE_ENV || "unknown");

            for (const e of events) {
                const payload = { ...(e.payload || {}) };
                span.addEvent(
                    e.eventType,
                    payload,
                    e.timestamp ? new Date(e.timestamp) : undefined
                );
            }

            span.end();
        } catch {}
    }
}

/**
 * Record a named metric via OTel Metrics API.
 * Maps metric names to pre-created instruments.
 */
function recordMetric(name, value, attributes) {
    const state = getTelemetryState();
    if (!state.meters) return;

    const COUNTER_MAP = {
        rag_timeout_rate:              state.meters.ragTimeout,
        clarification_rate:            state.meters.clarification,
        escalation_rate:               state.meters.escalation,
        transaction_confirmation_rate: state.meters.transactionConfirm,
        humor_usage_rate:              state.meters.humorUsage,
        unsupported_numeric_rate:      state.meters.unsupportedNumeric,
        injection_sentences_removed:   state.meters.injectionRemoved
    };

    if (name === "synthesis_score_distribution") {
        state.meters.synthesisScore.record(
            typeof value === "number" ? value : 0,
            attributes
        );
        return;
    }

    const counter = COUNTER_MAP[name];
    if (counter) {
        counter.add(typeof value === "number" ? value : 1, attributes);
    }
}

async function shutdown() {

    const state = getTelemetryState();
    try {
        if (state.monitor && state.monitor.shutdown) {
            await state.monitor.shutdown();
        }
    } catch (err) {
        console.error("Azure telemetry shutdown error:", err.message);
    }

    state.monitor = null;
    state.otelLogger = null;
    state.tracer = null;
    state.meters = null;

}

module.exports = {
    init,
    emitBatch,
    recordMetric,
    shutdown
};
