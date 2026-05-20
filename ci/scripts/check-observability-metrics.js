'use strict';

const fs = require('fs');
const path = require('path');
const EVENTS = require('../../Utils/telemetryEvents');

const ROOT = path.resolve(__dirname, '..', '..');
const workbookPath = path.join(ROOT, 'observability', 'azure-monitor-workbook.json');
const alertsPath = path.join(ROOT, 'observability', 'azure-alert-rules.json');
const controllerPath = path.join(ROOT, 'Controller', 'MainController.js');
const adapterPath = path.join(ROOT, 'adapters', 'telemetry', 'azureTelemetryAdapter.js');

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function collectWorkbookQueries(workbook) {
    const queries = [];
    for (const item of workbook.items || []) {
        const query = item?.content?.query;
        if (typeof query === 'string') {
            queries.push({ title: item.content.title || 'untitled workbook query', query, source: 'workbook' });
        }
    }
    return queries;
}

function collectAlertQueries(alerts) {
    const queries = [];
    for (const resource of alerts.resources || []) {
        for (const criterion of resource.properties?.criteria?.allOf || []) {
            queries.push({
                title: resource.name,
                query: String(criterion.query || ''),
                source: 'alert',
                metricMeasureColumn: criterion.metricMeasureColumn || null
            });
        }
    }
    return queries;
}

function extractEventNames(query) {
    const eventNames = new Set();
    for (const match of query.matchAll(/eventName\s*==\s*['"]([^'"]+)['"]/g)) {
        eventNames.add(match[1]);
    }
    for (const match of query.matchAll(/eventName\s+in\s*\(([^)]*)\)/g)) {
        for (const item of match[1].matchAll(/['"]([^'"]+)['"]/g)) {
            eventNames.add(item[1]);
        }
    }
    return [...eventNames];
}

function fail(errors, message) {
    errors.push(message);
}

function hasRobustEventNameMapping(query) {
    return query.includes('customDimensions["microsoft.custom_event.name"]')
        && query.includes('customDimensions.eventType');
}

function hasRobustCallIdMapping(query) {
    return query.includes('customDimensions.callId')
        && query.includes('customDimensions.callSID')
        && query.includes('customDimensions.callSid')
        && query.includes('customDimensions.sid');
}

function exposesAlertMetric(query, metricMeasureColumn) {
    if (!metricMeasureColumn) return true;
    const escaped = metricMeasureColumn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\s*=`, 'i').test(query)
        || new RegExp(`\\b${escaped}\\b`, 'i').test(query.split('| summarize').pop() || '');
}

function includesAll(query, values) {
    return values.every(value => query.includes(`"${value}"`) || query.includes(`'${value}'`));
}

const REQUIRED_TIMELINE_EVENTS = [
    'telecom_status_received',
    'telecom_status_terminal',
    'realtime_connection_error',
    'realtime_service_error',
    'realtime_reconnected',
    'realtime_reconnection_failed',
    'turn_created',
    'user_speech_started',
    'speech_window_transcribed',
    'response_latency',
    'speech_emitted',
    'speech_completed',
    'turn_closed',
    'response_timeout',
    'booking_intent_detected',
    'booking_link_requested',
    'booking_link_delivery_sent',
    'booking_link_sent',
    'booking_completed_webhook',
    'booking_webhook_orphaned',
    'handover_transfer_scheduled',
    'agent_availability_checked',
    'warm_transfer_started',
    'cold_transfer_started',
    'transfer_request_accepted',
    'transfer_request_failed',
    'agent_leg_answered',
    'agent_leg_accepted',
    'warm_transfer_bridge_confirmed',
    'warm_transfer_failed',
    'call_transferred',
    'hangup_triggered',
    'call_finalization_started',
    'call_finalization_completed',
    'call_finalization_degraded',
    'call_summary'
];

const REQUIRED_WORKFLOW_ACTION_EVENTS = [
    'action_outbox_enqueued',
    'action_outbox_claimed',
    'action_outbox_completed',
    'action_outbox_failed',
    'action_outbox_duplicate',
    'action_outbox_requeued',
    'action_outbox_poll_failed'
];

const REQUIRED_WORKFLOW_READINESS_FIELDS = [
    'workflow_readiness_checked',
    'retryCount',
    'deadLetterCount',
    'staleProcessingCount',
    'oldestRetryAgeSeconds',
    'oldestDeadLetterAgeSeconds',
    'oldestStaleLockAgeSeconds',
    'workerEnabled',
    'workerRequired'
];

const REQUIRED_WORKFLOW_DARK_READ_FIELDS = [
    'workflow_dark_read_compared',
    'workflow_dark_read_mismatch',
    'workflowId',
    'readModel',
    'readPolicy',
    'source',
    'fallbackUsed',
    'workflowStatePresent',
    'fallbackPresent',
    'workflowReadSkipped',
    'mismatchCount',
    'mismatchFields',
    'mismatchRate'
];

const REQUIRED_WORKFLOW_RECONCILIATION_FIELDS = [
    'workflow_reconciliation_audit',
    'workflow_reconciliation_requeue_completed',
    'auditId',
    'mode',
    'dryRun',
    'workflowId',
    'actionType',
    'plannedActionCount',
    'requeuedCount',
    'failedCount',
    'cappedLimit',
    'statuses',
    'invalidStatuses'
];

const workbook = readJson(workbookPath);
const alerts = readJson(alertsPath);
const queries = [...collectWorkbookQueries(workbook), ...collectAlertQueries(alerts)];
const errors = [];

if (!queries.length) {
    fail(errors, 'No workbook or alert queries found.');
}

for (const item of queries) {
    if (item.query.includes('customEvents') && !hasRobustEventNameMapping(item.query)) {
        fail(errors, `${item.source} query "${item.title}" does not use the Azure custom-event name fallback.`);
    }

    if (item.query.includes('coalesce(tostring(')) {
        fail(errors, `${item.source} query "${item.title}" stringifies before coalesce, which can break null fallbacks.`);
    }

    if (item.query.includes('eventName = tostring(coalesce(') || item.query.includes('callId = tostring(coalesce(')) {
        fail(errors, `${item.source} query "${item.title}" uses identity coalesce without empty-string fallback protection.`);
    }

    if (item.query.includes('callId') && !hasRobustCallIdMapping(item.query)) {
        fail(errors, `${item.source} query "${item.title}" does not use the robust callId/callSID fallback.`);
    }

    for (const eventName of extractEventNames(item.query)) {
        if (!EVENTS.has(eventName)) {
            fail(errors, `${item.source} query "${item.title}" references unknown telemetry event "${eventName}".`);
        }
    }

    if (item.source === 'alert' && !exposesAlertMetric(item.query, item.metricMeasureColumn)) {
        fail(errors, `Alert "${item.title}" does not expose metricMeasureColumn "${item.metricMeasureColumn}".`);
    }
}

const businessTitles = new Set([
    'Executive Scorecard',
    'Booking Funnel by Hour',
    'Booking Intent Cohort Conversion',
    'Business Metrics by Persona',
    'Daily Revenue, Cost, and ROI'
]);
for (const item of queries.filter(query => businessTitles.has(query.title))) {
    if (!item.query.includes('booking_completed_webhook')) {
        fail(errors, `Business query "${item.title}" does not include provider-confirmed booking completions.`);
    }
}

const tokenQuery = queries.find(item => item.title === 'Token Usage')?.query || '';
if (!tokenQuery.includes('customDimensions.input_tokens') || !tokenQuery.includes('customDimensions.inputTokens')) {
    fail(errors, 'Token Usage query must tolerate snake_case and camelCase token fields.');
}

const timelineQuery = queries.find(item => item.title === 'Recent End-to-End Call Timeline')?.query || '';
if (!includesAll(timelineQuery, REQUIRED_TIMELINE_EVENTS)) {
    fail(errors, 'Recent End-to-End Call Timeline query is missing one or more required lifecycle events.');
}

const intentCohortQuery = queries.find(item => item.title === 'Booking Intent Cohort Conversion')?.query || '';
if (!includesAll(intentCohortQuery, [
    'booking_intent_detected',
    'booking_link_requested',
    'booking_link_delivery_sent',
    'booking_link_sent',
    'booking_completed_webhook'
])) {
    fail(errors, 'Booking Intent Cohort Conversion query is missing required booking funnel or completion events.');
}

const orphanWorkbookQuery = queries.find(item => item.title === 'Booking Webhook Orphans')?.query || '';
if (!orphanWorkbookQuery.includes('booking_webhook_orphaned')) {
    fail(errors, 'Booking Webhook Orphans query must include booking_webhook_orphaned.');
}

const workflowActionQuery = queries.find(item => item.title === 'Workflow Action Operations')?.query || '';
if (!includesAll(workflowActionQuery, REQUIRED_WORKFLOW_ACTION_EVENTS)) {
    fail(errors, 'Workflow Action Operations query is missing required durable action outbox events.');
}

const workflowReadinessQuery = queries.find(item => item.title === 'Workflow Readiness Backlog')?.query || '';
for (const field of REQUIRED_WORKFLOW_READINESS_FIELDS) {
    if (!workflowReadinessQuery.includes(field)) {
        fail(errors, `Workflow Readiness Backlog query is missing required field or event "${field}".`);
    }
}

const workflowDarkReadQuery = queries.find(item => item.title === 'Workflow Dark-Read Parity')?.query || '';
for (const field of REQUIRED_WORKFLOW_DARK_READ_FIELDS) {
    if (!workflowDarkReadQuery.includes(field)) {
        fail(errors, `Workflow Dark-Read Parity query is missing required field or event "${field}".`);
    }
}

const workflowReconciliationAuditQuery = queries.find(item => item.title === 'Workflow Reconciliation Audit')?.query || '';
for (const field of REQUIRED_WORKFLOW_RECONCILIATION_FIELDS) {
    if (!workflowReconciliationAuditQuery.includes(field)) {
        fail(errors, `Workflow Reconciliation Audit query is missing required field or event "${field}".`);
    }
}

const alertNames = new Set(queries.filter(item => item.source === 'alert').map(item => item.title));
for (const requiredAlert of [
    'voicebot-booking-intent-dropoff-alert',
    'voicebot-booking-orphan-webhook-alert',
    'voicebot-workflow-dead-letter-alert',
    'voicebot-workflow-stale-lock-alert',
    'voicebot-workflow-poll-failure-alert'
]) {
    if (!alertNames.has(requiredAlert)) {
        fail(errors, `Missing required alert "${requiredAlert}".`);
    }
}

const controllerSource = fs.readFileSync(controllerPath, 'utf8');
if (!controllerSource.includes("buildRevenueMetrics('booking_completed')")) {
    fail(errors, 'booking_completed_webhook telemetry must emit estimated booking revenue metrics.');
}
if (!controllerSource.includes('providerEventType: normalized.eventType')) {
    fail(errors, 'booking_completed_webhook telemetry must preserve provider event type without colliding with Azure eventType.');
}
if (!controllerSource.includes("telemetry.emit('booking_webhook_orphaned'")) {
    fail(errors, 'booking webhook controller must emit booking_webhook_orphaned for unattributable terminal webhooks.');
}
if (!controllerSource.includes("type: 'persist_booking_webhook_orphan'")) {
    fail(errors, 'booking webhook controller must enqueue orphan persistence for unattributable terminal webhooks.');
}

const adapterSource = fs.readFileSync(adapterPath, 'utf8');
if (!adapterSource.includes('attrs.payloadEventType = attrs.eventType')) {
    fail(errors, 'Azure telemetry adapter must preserve payload eventType before setting the dashboard eventType dimension.');
}

if (errors.length) {
    console.error('Observability metric validation failed:');
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
}

console.log(`Observability metric validation passed (${queries.length} queries checked).`);
