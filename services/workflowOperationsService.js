'use strict';

const crypto = require('crypto');
const db = require('./db');
const Repository = require('../repositories/WorkflowActionOutboxRepository');
const workflowActionOutbox = require('./workflowActionOutboxService');
const workflowManifest = require('./workflowManifest');
const workflowStateService = require('./workflowStateService');
const { redactPII } = require('../Utils/piiRedactor');
const telemetry = require('../Utils/telemetry');

const WORKFLOW_TABLES = Object.freeze(workflowManifest.getRequiredWorkflowTables());

const DEFAULT_ACTION_SAMPLE_STATUSES = Object.freeze(['dead_letter', 'retry', 'processing']);
const DEFAULT_RECONCILIATION_STATUSES = Object.freeze(['dead_letter', 'retry', 'processing', 'failed']);
const DEFAULT_RECONCILIATION_REQUEUE_STATUSES = Object.freeze(['dead_letter', 'retry', 'failed']);
const RECONCILIATION_REQUEUEABLE_STATUSES = new Set(['dead_letter', 'retry', 'failed', 'processing']);
const RECONCILIATION_MUTATION_CONFIRMATION = 'requeue';
const WORKFLOW_TABLE_NAMES = new Set(Object.keys(WORKFLOW_TABLES));
const MAX_REASON_SUMMARY_LENGTH = 180;

function shortHash(value) {
    if (!value) return null;
    return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

function toTimestamp(value) {
    if (!value) return null;
    if (value instanceof Date) {
        const time = value.getTime();
        return Number.isFinite(time) ? time : null;
    }
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : null;
}

function resolveNowMs(now = Date.now()) {
    if (typeof now === 'function') return resolveNowMs(now());
    return toTimestamp(now) ?? Date.now();
}

function ageSecondsSince(value, nowMs) {
    const timestamp = toTimestamp(value);
    if (timestamp == null) return null;
    return Math.max(0, Math.floor((nowMs - timestamp) / 1000));
}

function oldestTimestamp(current, candidate) {
    const candidateTime = toTimestamp(candidate);
    if (candidateTime == null) return current || null;
    const currentTime = toTimestamp(current);
    return currentTime == null || candidateTime < currentTime ? candidate : current;
}

function summarizeReason(value) {
    if (value == null || value === '') return null;
    const text = redactPII(String(value))
        .replace(/[\x00-\x1F\x7F]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!text) return null;
    return text.length > MAX_REASON_SUMMARY_LENGTH
        ? `${text.slice(0, MAX_REASON_SUMMARY_LENGTH)}...`
        : text;
}

function addAgeFields(target, nowMs) {
    target.oldestRetryAgeSeconds = ageSecondsSince(target.oldestRetryAvailableAt, nowMs);
    target.oldestDeadLetterAgeSeconds = ageSecondsSince(target.oldestDeadLetterAt, nowMs);
    target.oldestStaleLockAgeSeconds = ageSecondsSince(target.oldestStaleLockedAt, nowMs);
    return target;
}

function redactActionSample(action = {}) {
    const reasonSummary = summarizeReason(action.lastError);
    return {
        id: action.id,
        callIdHash: shortHash(action.callSID),
        workflowId: action.workflowId,
        actionType: action.actionType,
        status: action.status,
        attemptCount: action.attemptCount,
        maxAttempts: action.maxAttempts,
        availableAt: action.availableAt || null,
        lockedAt: action.lockedAt || null,
        lockedBy: action.lockedBy || null,
        completedAt: action.completedAt || null,
        lastError: reasonSummary,
        reasonSummary,
        createdAt: action.createdAt || null,
        updatedAt: action.updatedAt || null,
    };
}

function normalizeOptionalString(value) {
    if (Array.isArray(value)) return normalizeOptionalString(value[0]);
    if (value == null) return null;
    const text = String(value).trim();
    return text || null;
}

function normalizeStatuses(value) {
    const raw = Array.isArray(value) ? value : [value];
    return raw
        .flatMap(item => String(item || '').split(','))
        .map(item => item.trim())
        .filter(Boolean);
}

function normalizeBoundedInteger(value, defaultValue, { min = 1, max = 100 } = {}) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return defaultValue;
    return Math.max(min, Math.min(parsed, max));
}

function normalizeLimit(value, defaultValue = 25) {
    return normalizeBoundedInteger(value, defaultValue, { min: 1, max: 100 });
}

function isEnabled(value, defaultValue = true) {
    if (value == null || value === '') return defaultValue;
    return !/^(0|false|off|no)$/i.test(String(value).trim());
}

function normalizeBoolean(value, defaultValue = true) {
    if (value == null || value === '') return defaultValue;
    return !/^(0|false|off|no)$/i.test(String(value).trim());
}

function normalizeReconciliationRequeueStatuses(value) {
    const requested = normalizeStatuses(value);
    const invalidStatuses = requested.filter(status => !RECONCILIATION_REQUEUEABLE_STATUSES.has(status));
    const statuses = requested.length
        ? requested.filter(status => RECONCILIATION_REQUEUEABLE_STATUSES.has(status))
        : [...DEFAULT_RECONCILIATION_REQUEUE_STATUSES];
    return {
        statuses: [...new Set(statuses)],
        invalidStatuses: [...new Set(invalidStatuses)],
    };
}

function createAuditId(prefix = 'workflow-reconciliation') {
    if (typeof crypto.randomUUID === 'function') return `${prefix}:${crypto.randomUUID()}`;
    return `${prefix}:${crypto.randomBytes(12).toString('hex')}`;
}

function summarizeManifestForReadiness() {
    return workflowManifest.summarizeWorkflowManifest();
}

function isEligibleReconciliationRequeueSample(action = {}, { lockTimeoutSeconds = 120, nowMs = Date.now() } = {}) {
    if (action.status !== 'processing') return true;
    const lockedAt = toTimestamp(action.lockedAt);
    if (lockedAt == null) return false;
    return (nowMs - lockedAt) >= (Math.max(1, Number(lockTimeoutSeconds) || 120) * 1000);
}

function filterEligibleReconciliationRequeueSamples(samples = [], options = {}) {
    return samples.filter(sample => isEligibleReconciliationRequeueSample(sample, options));
}

function normalizeEnvironmentName(env = process.env) {
    const raw = env.NODE_ENV || 'development';
    return String(raw || 'development').trim().toLowerCase() || 'development';
}

function isProductionLikeEnvironment(env = process.env) {
    return /^(production|prod|staging)$/i.test(normalizeEnvironmentName(env));
}

function getDealerOrderReadPolicyReadiness(env = process.env) {
    const readPolicy = workflowStateService.normalizeDealerOrderReadPolicy(env.DEALER_ORDER_READ_SOURCE_POLICY);
    const policies = workflowStateService.DEALER_ORDER_READ_POLICIES;
    const productionLike = isProductionLikeEnvironment(env);
    const rollbackMode = readPolicy === policies.WORKFLOW_DISABLED;
    const observationOnly = readPolicy === policies.SNAPSHOT_FIRST;
    return {
        workflowId: 'dealer-orders',
        readModel: 'dealer_order',
        readPolicy,
        status: rollbackMode ? 'rollback_mode' : observationOnly ? 'observation_mode' : 'ok',
        productionLike,
        workflowReadPromotionBlocked: rollbackMode || observationOnly,
        rollbackMode,
        observationOnly,
        fallbackAvailable: true,
        allowedPolicies: Object.values(policies),
    };
}

function buildOutboxIssues({ summary, workerEnabled, workerRequired } = {}) {
    const totals = summary?.totals || {};
    const issues = [];
    if (!workerEnabled) {
        issues.push({
            code: 'worker_disabled',
            severity: workerRequired ? 'error' : 'warning',
            count: 1,
        });
    }
    if ((totals.retry || 0) > 0) {
        issues.push({
            code: 'retry_backlog',
            severity: 'warning',
            count: totals.retry,
            oldestAvailableAt: totals.oldestRetryAvailableAt || null,
            oldestAgeSeconds: totals.oldestRetryAgeSeconds ?? null,
        });
    }
    if ((totals.dead_letter || 0) > 0) {
        issues.push({
            code: 'dead_letter_backlog',
            severity: 'error',
            count: totals.dead_letter,
            oldestDeadLetterAt: totals.oldestDeadLetterAt || null,
            oldestAgeSeconds: totals.oldestDeadLetterAgeSeconds ?? null,
        });
    }
    if ((totals.staleProcessing || 0) > 0) {
        issues.push({
            code: 'stale_processing_locks',
            severity: 'error',
            count: totals.staleProcessing,
            oldestLockedAt: totals.oldestStaleLockedAt || null,
            oldestAgeSeconds: totals.oldestStaleLockAgeSeconds ?? null,
        });
    }
    return issues;
}

function emitWorkflowReadinessTelemetry(outbox = {}) {
    const totals = outbox.totals || {};
    telemetry.emit('workflow_readiness_checked', {
        status: outbox.status || 'unknown',
        ok: outbox.ok === true,
        environment: outbox.environment || null,
        workerEnabled: outbox.workerEnabled === true,
        workerRequired: outbox.workerRequired === true,
        retryCount: totals.retry || 0,
        deadLetterCount: totals.dead_letter || 0,
        staleProcessingCount: totals.staleProcessing || 0,
        oldestRetryAgeSeconds: totals.oldestRetryAgeSeconds ?? null,
        oldestDeadLetterAgeSeconds: totals.oldestDeadLetterAgeSeconds ?? null,
        oldestStaleLockAgeSeconds: totals.oldestStaleLockAgeSeconds ?? null,
        issueCount: Array.isArray(outbox.issues) ? outbox.issues.length : 0,
        issueCodes: Array.isArray(outbox.issues) ? outbox.issues.map(issue => issue.code).filter(Boolean) : [],
        ts: Date.now(),
    });
}

function summarizeIssueState(issues = []) {
    if (issues.some(issue => issue.severity === 'error')) return { ok: false, status: 'degraded' };
    if (issues.length) return { ok: true, status: 'warning' };
    return { ok: true, status: 'ok' };
}

function isMissingTableError(err) {
    const message = String(err?.message || '').toLowerCase();
    return err?.code === 'ER_NO_SUCH_TABLE' || err?.errno === 1146 || message.includes("doesn't exist");
}

async function inspectTableColumns(tableName, requiredColumns) {
    if (!WORKFLOW_TABLE_NAMES.has(tableName)) {
        return {
            ok: false,
            status: 'invalid_table',
            reason: 'unsupported_workflow_table',
            missingColumns: requiredColumns,
        };
    }
    try {
        const rows = await db.query(`SHOW COLUMNS FROM ${tableName}`);
        const present = new Set((rows || []).map(row => row.Field));
        const missingColumns = requiredColumns.filter(column => !present.has(column));
        return {
            ok: missingColumns.length === 0,
            status: missingColumns.length === 0 ? 'ok' : 'missing_columns',
            missingColumns,
        };
    } catch (err) {
        return {
            ok: false,
            status: isMissingTableError(err) ? 'missing_table' : 'error',
            reason: err?.code || err?.message || String(err),
            missingColumns: requiredColumns,
        };
    }
}

async function getWorkflowSchemaReadiness() {
    const tables = {};
    for (const [tableName, columns] of Object.entries(WORKFLOW_TABLES)) {
        tables[tableName] = await inspectTableColumns(tableName, columns);
    }
    const ok = Object.values(tables).every(table => table.ok);
    return {
        ok,
        status: ok ? 'ok' : 'degraded',
        tables,
    };
}

function listMigrationWorkflowReferences(migrationId) {
    return workflowManifest.listWorkflowActions()
        .filter(action => (action.requiredMigrations || []).includes(migrationId))
        .map(action => ({
            workflowId: action.workflowId,
            actionType: action.actionType,
        }));
}

function getWorkflowMigrationReadiness(schemaReadiness = {}) {
    const schemaTables = schemaReadiness.tables || {};
    const migrations = workflowManifest.getRequiredMigrationContracts().map(migration => {
        const tables = Object.entries(migration.tables || {}).map(([tableName, requiredColumns]) => {
            const table = schemaTables[tableName] || {};
            return {
                tableName,
                ok: table.ok === true,
                status: table.status || 'not_checked',
                missingColumns: Array.isArray(table.missingColumns) ? table.missingColumns : requiredColumns,
            };
        });
        const ok = tables.every(table => table.ok);
        return {
            id: migration.id,
            file: migration.file,
            ok,
            status: ok ? 'ok' : 'missing_or_incomplete',
            tables,
            workflows: listMigrationWorkflowReferences(migration.id),
        };
    });
    const ok = migrations.every(migration => migration.ok);
    return {
        ok,
        status: ok ? 'ok' : 'degraded',
        migrations,
    };
}

function summarizeOutboxRows(rows = [], { nowMs = Date.now() } = {}) {
    const totals = {
        queued: 0,
        retry: 0,
        processing: 0,
        completed: 0,
        failed: 0,
        dead_letter: 0,
        cancelled: 0,
        staleProcessing: 0,
        oldestRetryAvailableAt: null,
        oldestDeadLetterAt: null,
        oldestStaleLockedAt: null,
    };
    const byWorkflow = {};
    for (const row of rows) {
        const status = row.status || 'unknown';
        if (totals[status] == null) totals[status] = 0;
        totals[status] += row.count;
        totals.staleProcessing += row.staleProcessingCount || 0;
        if (status === 'retry') {
            totals.oldestRetryAvailableAt = oldestTimestamp(totals.oldestRetryAvailableAt, row.oldestRetryAvailableAt || row.oldestAvailableAt);
        }
        if (status === 'dead_letter') {
            totals.oldestDeadLetterAt = oldestTimestamp(totals.oldestDeadLetterAt, row.oldestDeadLetterAt || row.updatedAt || row.oldestAvailableAt);
        }
        if ((row.staleProcessingCount || 0) > 0) {
            totals.oldestStaleLockedAt = oldestTimestamp(totals.oldestStaleLockedAt, row.oldestStaleLockedAt || row.oldestLockedAt);
        }

        const key = `${row.workflowId}:${row.actionType}`;
        if (!byWorkflow[key]) {
            byWorkflow[key] = {
                workflowId: row.workflowId,
                actionType: row.actionType,
                statuses: {},
                staleProcessing: 0,
                oldestAvailableAt: null,
                oldestLockedAt: null,
                oldestRetryAvailableAt: null,
                oldestDeadLetterAt: null,
                oldestStaleLockedAt: null,
            };
        }
        byWorkflow[key].statuses[status] = row.count;
        byWorkflow[key].staleProcessing += row.staleProcessingCount || 0;
        if (row.oldestAvailableAt && (!byWorkflow[key].oldestAvailableAt || row.oldestAvailableAt < byWorkflow[key].oldestAvailableAt)) {
            byWorkflow[key].oldestAvailableAt = row.oldestAvailableAt;
        }
        if (row.oldestLockedAt && (!byWorkflow[key].oldestLockedAt || row.oldestLockedAt < byWorkflow[key].oldestLockedAt)) {
            byWorkflow[key].oldestLockedAt = row.oldestLockedAt;
        }
        if (status === 'retry') {
            byWorkflow[key].oldestRetryAvailableAt = oldestTimestamp(byWorkflow[key].oldestRetryAvailableAt, row.oldestRetryAvailableAt || row.oldestAvailableAt);
        }
        if (status === 'dead_letter') {
            byWorkflow[key].oldestDeadLetterAt = oldestTimestamp(byWorkflow[key].oldestDeadLetterAt, row.oldestDeadLetterAt || row.updatedAt || row.oldestAvailableAt);
        }
        if ((row.staleProcessingCount || 0) > 0) {
            byWorkflow[key].oldestStaleLockedAt = oldestTimestamp(byWorkflow[key].oldestStaleLockedAt, row.oldestStaleLockedAt || row.oldestLockedAt);
        }
    }
    addAgeFields(totals, nowMs);
    return { totals, byWorkflow: Object.values(byWorkflow).map(entry => addAgeFields(entry, nowMs)) };
}

function summarizeReconciliationRows(byWorkflow = []) {
    return byWorkflow.map(entry => {
        const statuses = { ...(entry.statuses || {}) };
        const totalActions = Object.values(statuses).reduce((sum, value) => sum + (Number(value) || 0), 0);
        const pending = (statuses.queued || 0) + (statuses.retry || 0) + (statuses.processing || 0);
        const needsAttention = (statuses.retry || 0) + (statuses.dead_letter || 0) + (statuses.failed || 0) + (entry.staleProcessing || 0);
        const completed = statuses.completed || 0;
        return {
            workflowId: entry.workflowId,
            actionType: entry.actionType,
            totalActions,
            completed,
            pending,
            retry: statuses.retry || 0,
            failed: statuses.failed || 0,
            deadLetter: statuses.dead_letter || 0,
            cancelled: statuses.cancelled || 0,
            staleProcessing: entry.staleProcessing || 0,
            needsAttention,
            completionRate: totalActions > 0 ? Number((completed / totalActions).toFixed(4)) : 0,
            statuses,
            oldestRetryAvailableAt: entry.oldestRetryAvailableAt || null,
            oldestRetryAgeSeconds: entry.oldestRetryAgeSeconds ?? null,
            oldestDeadLetterAt: entry.oldestDeadLetterAt || null,
            oldestDeadLetterAgeSeconds: entry.oldestDeadLetterAgeSeconds ?? null,
            oldestStaleLockedAt: entry.oldestStaleLockedAt || null,
            oldestStaleLockAgeSeconds: entry.oldestStaleLockAgeSeconds ?? null,
        };
    }).sort((left, right) => (right.needsAttention - left.needsAttention) || (right.totalActions - left.totalActions));
}

async function getOutboxReadiness(options = {}) {
    const env = options.env || process.env;
    const environment = normalizeEnvironmentName(env);
    const workerEnabled = isEnabled(env.ACTION_OUTBOX_WORKER_ENABLED, true);
    const workerRequired = isProductionLikeEnvironment(env);
    const nowMs = resolveNowMs(options.now);
    try {
        const rows = await Repository.listActionStatusCounts({
            workflowId: options.workflowId || null,
            actionType: options.actionType || null,
            staleLockSeconds: options.staleLockSeconds || 120,
        });
        const summary = summarizeOutboxRows(rows, { nowMs });
        const issues = buildOutboxIssues({ summary, workerEnabled, workerRequired });
        const issueState = summarizeIssueState(issues);
        const outbox = {
            ok: issueState.ok,
            status: issueState.status,
            environment,
            workerEnabled,
            workerRequired,
            staleLockSeconds: Math.max(1, Number(options.staleLockSeconds) || 120),
            totals: summary.totals,
            byWorkflow: summary.byWorkflow,
            issues,
        };
        emitWorkflowReadinessTelemetry(outbox);
        return outbox;
    } catch (err) {
        const outbox = {
            ok: false,
            status: isMissingTableError(err) ? 'missing_schema' : 'error',
            reason: err?.code || err?.message || String(err),
            environment,
            workerEnabled,
            workerRequired,
            totals: {},
            byWorkflow: [],
            issues: [{
                code: isMissingTableError(err) ? 'missing_schema' : 'outbox_readiness_error',
                severity: 'error',
                count: 1,
            }],
        };
        emitWorkflowReadinessTelemetry(outbox);
        return outbox;
    }
}

async function getWorkflowReadiness(options = {}) {
    const env = options.env || process.env;
    const schema = await getWorkflowSchemaReadiness();
    const migrations = getWorkflowMigrationReadiness(schema);
    const outbox = await getOutboxReadiness(options);
    const dealerOrderReadPolicy = getDealerOrderReadPolicyReadiness(env);
    const ok = schema.ok && migrations.ok && outbox.ok;
    return {
        ok,
        status: ok ? 'ok' : 'degraded',
        checks: {
            schema: schema.status,
            migrations: migrations.status,
            actionOutbox: outbox.status,
            worker: outbox.workerEnabled ? 'enabled' : 'disabled',
            dealerOrderReadPolicy: dealerOrderReadPolicy.status,
        },
        manifest: summarizeManifestForReadiness(),
        readModels: {
            dealerOrder: dealerOrderReadPolicy,
        },
        schema,
        migrations,
        outbox,
    };
}

async function getWorkflowActionSamples(options = {}) {
    const statuses = normalizeStatuses(options.statuses);
    const actions = await Repository.listActionSamples({
        workflowId: normalizeOptionalString(options.workflowId),
        actionType: normalizeOptionalString(options.actionType),
        statuses: statuses.length ? statuses : [...DEFAULT_ACTION_SAMPLE_STATUSES],
        limit: normalizeLimit(options.limit),
    });
    const redactedActions = actions.map(redactActionSample);
    return { count: redactedActions.length, actions: redactedActions };
}

async function getWorkflowReconciliation(options = {}) {
    const nowMs = resolveNowMs(options.now);
    const staleLockSeconds = normalizeBoundedInteger(options.staleLockSeconds, 120, { min: 1, max: 3600 });
    try {
        const rows = await Repository.listActionStatusCounts({
            workflowId: normalizeOptionalString(options.workflowId),
            actionType: normalizeOptionalString(options.actionType),
            staleLockSeconds,
        });
        const summary = summarizeOutboxRows(rows, { nowMs });
        const workflows = summarizeReconciliationRows(summary.byWorkflow);
        const issues = buildOutboxIssues({
            summary,
            workerEnabled: true,
            workerRequired: false,
        });
        const samples = await Repository.listActionSamples({
            workflowId: normalizeOptionalString(options.workflowId),
            actionType: normalizeOptionalString(options.actionType),
            statuses: normalizeStatuses(options.statuses).length
                ? normalizeStatuses(options.statuses)
                : [...DEFAULT_RECONCILIATION_STATUSES],
            limit: normalizeLimit(options.limit, 25),
        });
        const issueState = summarizeIssueState(issues);
        return {
            ok: issueState.ok,
            status: issueState.status,
            generatedAt: new Date(nowMs).toISOString(),
            staleLockSeconds,
            filters: {
                workflowId: normalizeOptionalString(options.workflowId),
                actionType: normalizeOptionalString(options.actionType),
            },
            totals: summary.totals,
            workflows,
            issues,
            samples: samples.map(redactActionSample),
        };
    } catch (err) {
        return {
            ok: false,
            status: isMissingTableError(err) ? 'missing_schema' : 'error',
            reason: err?.code || err?.message || String(err),
            generatedAt: new Date(nowMs).toISOString(),
            staleLockSeconds,
            totals: {},
            workflows: [],
            issues: [{
                code: isMissingTableError(err) ? 'missing_schema' : 'workflow_reconciliation_error',
                severity: 'error',
                count: 1,
            }],
            samples: [],
        };
    }
}

function emitReconciliationAuditTelemetry(event = {}) {
    telemetry.emit('workflow_reconciliation_audit', {
        auditId: event.auditId || null,
        mode: event.mode || 'dry_run',
        dryRun: event.dryRun !== false,
        workflowId: event.workflowId || null,
        actionType: event.actionType || null,
        plannedActionCount: event.plannedActionCount || 0,
        requeuedCount: event.requeuedCount || 0,
        failedCount: event.failedCount || 0,
        cappedLimit: event.cappedLimit || null,
        statuses: Array.isArray(event.statuses) ? event.statuses : [],
        invalidStatuses: Array.isArray(event.invalidStatuses) ? event.invalidStatuses : [],
        ts: Date.now(),
    });
}

async function requeueWorkflowReconciliation(options = {}) {
    const nowMs = resolveNowMs(options.now);
    const dryRun = normalizeBoolean(options.dryRun, true);
    const workflowId = normalizeOptionalString(options.workflowId);
    const actionType = normalizeOptionalString(options.actionType);
    const statusFilter = normalizeReconciliationRequeueStatuses(options.statuses);
    const statuses = statusFilter.statuses;
    const limit = normalizeBoundedInteger(options.limit, 10, { min: 1, max: 25 });
    const lockTimeoutSeconds = normalizeBoundedInteger(options.lockTimeoutSeconds, 120, { min: 1, max: 3600 });
    const reason = normalizeOptionalString(options.reason) || 'operator_reconciliation_requeue';
    const auditId = normalizeOptionalString(options.auditId) || createAuditId();
    const filters = { workflowId, actionType, statuses };

    if (statusFilter.invalidStatuses.length) {
        emitReconciliationAuditTelemetry({
            auditId,
            mode: dryRun ? 'dry_run' : 'requeue',
            dryRun,
            workflowId,
            actionType,
            plannedActionCount: 0,
            cappedLimit: limit,
            statuses,
            invalidStatuses: statusFilter.invalidStatuses,
        });
        return {
            ok: false,
            status: 'invalid_status_filter',
            reason: 'invalid_status_filter',
            validStatuses: [...RECONCILIATION_REQUEUEABLE_STATUSES],
            invalidStatuses: statusFilter.invalidStatuses,
            audit: {
                auditId,
                generatedAt: new Date(nowMs).toISOString(),
                mode: dryRun ? 'dry_run' : 'requeue',
                dryRun,
                filters,
                cappedLimit: limit,
                plannedActionCount: 0,
                invalidStatuses: statusFilter.invalidStatuses,
            },
            actions: [],
            results: [],
        };
    }

    try {
        const rawSamples = await Repository.listActionSamples({
            workflowId,
            actionType,
            statuses,
            limit,
        });
        const samples = filterEligibleReconciliationRequeueSamples(rawSamples, { lockTimeoutSeconds, nowMs });
        const actions = samples.map(redactActionSample);
        const audit = {
            auditId,
            generatedAt: new Date(nowMs).toISOString(),
            mode: dryRun ? 'dry_run' : 'requeue',
            dryRun,
            filters,
            cappedLimit: limit,
            plannedActionCount: actions.length,
            reason: summarizeReason(reason),
        };

        emitReconciliationAuditTelemetry({
            auditId,
            mode: audit.mode,
            dryRun,
            workflowId,
            actionType,
            plannedActionCount: actions.length,
            cappedLimit: limit,
            statuses,
        });

        if (dryRun) {
            return {
                ok: true,
                status: 'dry_run',
                audit,
                actions,
            };
        }

        const confirmation = normalizeOptionalString(options.confirm || options.confirmation);
        if (confirmation !== RECONCILIATION_MUTATION_CONFIRMATION) {
            return {
                ok: false,
                status: 'confirmation_required',
                reason: 'confirmation_required',
                requiredConfirmation: RECONCILIATION_MUTATION_CONFIRMATION,
                audit,
                actions,
            };
        }

        const results = [];
        for (const sample of samples) {
            const result = await workflowActionOutbox.requeueWorkflowAction(sample.id, {
                reason,
                lockTimeoutSeconds,
                auditId,
            });
            results.push({
                ok: result?.ok === true,
                reason: result?.reason || null,
                action: result?.action ? redactActionSample(result.action) : { id: sample.id },
            });
        }

        const requeuedCount = results.filter(result => result.ok).length;
        const failedCount = results.length - requeuedCount;
        telemetry.emit('workflow_reconciliation_requeue_completed', {
            auditId,
            mode: 'requeue',
            dryRun: false,
            workflowId,
            actionType,
            plannedActionCount: actions.length,
            requeuedCount,
            failedCount,
            cappedLimit: limit,
            statuses,
            ts: Date.now(),
        });

        return {
            ok: failedCount === 0,
            status: failedCount === 0 ? 'requeued' : 'partial',
            audit: {
                ...audit,
                requeuedCount,
                failedCount,
            },
            results,
        };
    } catch (err) {
        return {
            ok: false,
            status: isMissingTableError(err) ? 'missing_schema' : 'error',
            reason: err?.code || err?.message || String(err),
            audit: {
                auditId,
                generatedAt: new Date(nowMs).toISOString(),
                mode: dryRun ? 'dry_run' : 'requeue',
                dryRun,
                filters,
                cappedLimit: limit,
                plannedActionCount: 0,
            },
            actions: [],
            results: [],
        };
    }
}

async function requeueWorkflowAction(options = {}) {
    const result = await workflowActionOutbox.requeueWorkflowAction(options.actionId, {
        reason: normalizeOptionalString(options.reason) || 'operator_requeue',
        lockTimeoutSeconds: normalizeBoundedInteger(options.lockTimeoutSeconds, 120, { min: 1, max: 3600 }),
        auditId: normalizeOptionalString(options.auditId),
    });
    if (!result?.action) return result;
    return {
        ...result,
        action: redactActionSample(result.action),
    };
}

module.exports = {
    WORKFLOW_TABLES,
    DEFAULT_ACTION_SAMPLE_STATUSES,
    DEFAULT_RECONCILIATION_STATUSES,
    DEFAULT_RECONCILIATION_REQUEUE_STATUSES,
    getOutboxReadiness,
    getDealerOrderReadPolicyReadiness,
    getWorkflowMigrationReadiness,
    getWorkflowActionSamples,
    getWorkflowReconciliation,
    getWorkflowReadiness,
    getWorkflowSchemaReadiness,
    inspectTableColumns,
    requeueWorkflowReconciliation,
    requeueWorkflowAction,
    summarizeOutboxRows,
};