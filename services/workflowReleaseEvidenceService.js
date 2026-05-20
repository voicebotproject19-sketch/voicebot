'use strict';

const workflowOperations = require('./workflowOperationsService');
const workflowStateService = require('./workflowStateService');
const telemetry = require('../Utils/telemetry');

const REQUIRED_DRILLS = Object.freeze([
    { key: 'missing_schema', label: 'Missing workflow schema readiness drill' },
    { key: 'empty_snapshot', label: 'Empty dealer-order snapshot drill' },
    { key: 'empty_workflow_row', label: 'Empty workflow-state row drill' },
    { key: 'workflow_snapshot_mismatch', label: 'Workflow/snapshot mismatch drill' },
    { key: 'retry_backlog', label: 'Retry backlog drill' },
    { key: 'dead_letter_backlog', label: 'Dead-letter backlog drill' },
    { key: 'stale_processing_lock', label: 'Stale processing lock drill' },
    { key: 'invalid_status_filter', label: 'Invalid reconciliation filter drill' },
    { key: 'dry_run_reconciliation', label: 'Dry-run reconciliation drill' },
    { key: 'capped_mutating_reconciliation', label: 'Capped mutating reconciliation drill' },
]);

const DEFAULT_THRESHOLDS = Object.freeze({
    minDarkReadComparisons: 100,
    maxDarkReadMismatchRate: 0.01,
    maxDarkReadFallbackRate: 0.05,
    maxWorkflowReadSkippedRate: 0,
    minReconciliationDryRuns: 1,
    maxReconciliationFailedRequeues: 0,
    requireRollbackOwnerApproval: true,
});

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

function firstDefined(...values) {
    return values.find(value => value !== undefined && value !== null && value !== '');
}

function normalizeOptionalString(value) {
    if (Array.isArray(value)) return normalizeOptionalString(value[0]);
    if (value == null) return null;
    const text = String(value).trim();
    return text || null;
}

function normalizeEnvironmentName(env = process.env) {
    const raw = env.NODE_ENV || 'development';
    return String(raw || 'development').trim().toLowerCase() || 'development';
}

function isProductionLikeEnvironment(env = process.env) {
    return /^(production|prod|staging)$/i.test(normalizeEnvironmentName(env));
}

function normalizeBoolean(value, defaultValue = false) {
    if (Array.isArray(value)) return normalizeBoolean(value[0], defaultValue);
    if (value == null || value === '') return defaultValue;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    const text = String(value).trim().toLowerCase();
    if (/^(1|true|yes|y|on|pass|passed|ok)$/i.test(text)) return true;
    if (/^(0|false|no|n|off|fail|failed)$/i.test(text)) return false;
    return defaultValue;
}

function normalizeNonNegativeInteger(value, defaultValue = 0) {
    const parsed = Number.parseInt(Array.isArray(value) ? value[0] : value, 10);
    if (!Number.isFinite(parsed)) return defaultValue;
    return Math.max(0, parsed);
}

function normalizeRate(value, defaultValue) {
    const parsed = Number.parseFloat(Array.isArray(value) ? value[0] : value);
    if (!Number.isFinite(parsed)) return defaultValue;
    return Math.min(1, Math.max(0, parsed));
}

function normalizeStringList(value) {
    if (Array.isArray(value)) return value.flatMap(normalizeStringList);
    if (value == null || String(value).trim() === '') return [];
    return String(value)
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
}

function toCamelCase(value) {
    return String(value || '').replace(/_([a-z])/g, (_, character) => character.toUpperCase());
}

function rate(count, total) {
    if (!total) return null;
    return Number((count / total).toFixed(6));
}

function normalizeThresholds({ env = process.env, thresholds = {} } = {}) {
    return {
        minDarkReadComparisons: normalizeNonNegativeInteger(firstDefined(
            thresholds.minDarkReadComparisons,
            thresholds.min_dark_read_comparisons,
            env.WORKFLOW_RELEASE_MIN_DARK_READ_COMPARISONS
        ), DEFAULT_THRESHOLDS.minDarkReadComparisons),
        maxDarkReadMismatchRate: normalizeRate(firstDefined(
            thresholds.maxDarkReadMismatchRate,
            thresholds.max_dark_read_mismatch_rate,
            env.WORKFLOW_RELEASE_MAX_DARK_READ_MISMATCH_RATE
        ), DEFAULT_THRESHOLDS.maxDarkReadMismatchRate),
        maxDarkReadFallbackRate: normalizeRate(firstDefined(
            thresholds.maxDarkReadFallbackRate,
            thresholds.max_dark_read_fallback_rate,
            env.WORKFLOW_RELEASE_MAX_DARK_READ_FALLBACK_RATE
        ), DEFAULT_THRESHOLDS.maxDarkReadFallbackRate),
        maxWorkflowReadSkippedRate: normalizeRate(firstDefined(
            thresholds.maxWorkflowReadSkippedRate,
            thresholds.max_workflow_read_skipped_rate,
            env.WORKFLOW_RELEASE_MAX_WORKFLOW_READ_SKIPPED_RATE
        ), DEFAULT_THRESHOLDS.maxWorkflowReadSkippedRate),
        minReconciliationDryRuns: normalizeNonNegativeInteger(firstDefined(
            thresholds.minReconciliationDryRuns,
            thresholds.min_reconciliation_dry_runs,
            env.WORKFLOW_RELEASE_MIN_RECONCILIATION_DRY_RUNS
        ), DEFAULT_THRESHOLDS.minReconciliationDryRuns),
        maxReconciliationFailedRequeues: normalizeNonNegativeInteger(firstDefined(
            thresholds.maxReconciliationFailedRequeues,
            thresholds.max_reconciliation_failed_requeues,
            env.WORKFLOW_RELEASE_MAX_RECONCILIATION_FAILED_REQUEUES
        ), DEFAULT_THRESHOLDS.maxReconciliationFailedRequeues),
        requireRollbackOwnerApproval: normalizeBoolean(firstDefined(
            thresholds.requireRollbackOwnerApproval,
            thresholds.require_rollback_owner_approval,
            env.WORKFLOW_RELEASE_REQUIRE_ROLLBACK_OWNER_APPROVAL
        ), DEFAULT_THRESHOLDS.requireRollbackOwnerApproval),
    };
}

function normalizeDarkReadEvidence(input = {}) {
    const source = input.darkRead || input.darkReadEvidence || input;
    const comparisonCount = normalizeNonNegativeInteger(firstDefined(
        source.comparisonCount,
        source.comparisons,
        source.darkReadComparisons,
        input.darkReadComparisons,
        input.darkReadComparisonCount
    ));
    const mismatchCount = normalizeNonNegativeInteger(firstDefined(
        source.mismatchCount,
        source.mismatches,
        source.darkReadMismatches,
        input.darkReadMismatches,
        input.darkReadMismatchCount
    ));
    const fallbackUsedCount = normalizeNonNegativeInteger(firstDefined(
        source.fallbackUsedCount,
        source.fallbackCount,
        source.darkReadFallbackUsed,
        input.darkReadFallbackUsed,
        input.fallbackUsedCount
    ));
    const workflowReadSkippedCount = normalizeNonNegativeInteger(firstDefined(
        source.workflowReadSkippedCount,
        source.workflowReadSkipped,
        source.darkReadWorkflowSkipped,
        input.darkReadWorkflowSkipped,
        input.workflowReadSkippedCount
    ));
    const mismatchFields = normalizeStringList(firstDefined(
        source.mismatchFields,
        source.darkReadMismatchFields,
        input.darkReadMismatchFields,
        input.mismatchFields
    ));
    const mismatchFieldsReviewed = normalizeBoolean(firstDefined(
        source.mismatchFieldsReviewed,
        source.mismatch_fields_reviewed,
        input.mismatchFieldsReviewed,
        input.darkReadMismatchFieldsReviewed
    ), false);
    return {
        comparisonCount,
        mismatchCount,
        mismatchRate: rate(mismatchCount, comparisonCount),
        fallbackUsedCount,
        fallbackRate: rate(fallbackUsedCount, comparisonCount),
        workflowReadSkippedCount,
        workflowReadSkippedRate: rate(workflowReadSkippedCount, comparisonCount),
        mismatchFields: [...new Set(mismatchFields)],
        mismatchFieldsReviewed,
    };
}

function normalizeReconciliationAuditEvidence(input = {}) {
    const source = input.reconciliationAudit || input.reconciliationAuditEvidence || input;
    const dryRunCount = normalizeNonNegativeInteger(firstDefined(
        source.dryRunCount,
        source.dryRuns,
        source.reconciliationDryRuns,
        input.reconciliationDryRuns,
        input.reconciliationAuditDryRuns
    ));
    const mutationCount = normalizeNonNegativeInteger(firstDefined(
        source.mutationCount,
        source.mutations,
        source.reconciliationMutations,
        input.reconciliationMutations,
        input.reconciliationAuditMutations
    ));
    const failedRequeueCount = normalizeNonNegativeInteger(firstDefined(
        source.failedRequeueCount,
        source.failedRequeues,
        source.reconciliationFailedRequeues,
        input.reconciliationFailedRequeues,
        input.reconciliationAuditFailedRequeues
    ));
    const invalidStatusFilterCount = normalizeNonNegativeInteger(firstDefined(
        source.invalidStatusFilterCount,
        source.invalidStatusFilters,
        source.reconciliationInvalidStatusFilters,
        input.reconciliationInvalidStatusFilters,
        input.invalidStatusFilterCount
    ));
    return {
        dryRunCount,
        mutationCount,
        failedRequeueCount,
        invalidStatusFilterCount,
    };
}

function normalizeDrillEvidence(input = {}) {
    const source = input.drills || input.drillResults || {};
    return REQUIRED_DRILLS.map(drill => {
        const camelKey = toCamelCase(drill.key);
        const rawValue = firstDefined(
            source[drill.key],
            source[camelKey],
            input[drill.key],
            input[camelKey]
        );
        const passed = normalizeBoolean(typeof rawValue === 'object' && rawValue !== null ? rawValue.passed : rawValue, false);
        return {
            key: drill.key,
            label: drill.label,
            passed,
        };
    });
}

function normalizeApprovals(input = {}) {
    const source = input.approvals || input.approval || input;
    return {
        rollbackOwnerApproved: normalizeBoolean(firstDefined(
            source.rollbackOwnerApproved,
            source.rollback_owner_approved,
            input.rollbackOwnerApproved
        ), false),
        rollbackOwner: normalizeOptionalString(firstDefined(source.rollbackOwner, source.rollback_owner, input.rollbackOwner)),
        approvalId: normalizeOptionalString(firstDefined(source.approvalId, source.approval_id, input.approvalId)),
    };
}

function getReadPolicyEvidence({ env = process.env, readiness = null } = {}) {
    const readinessPolicy = readiness?.readModels?.dealerOrder;
    const readPolicy = readinessPolicy?.readPolicy
        || workflowStateService.normalizeDealerOrderReadPolicy(env.DEALER_ORDER_READ_SOURCE_POLICY);
    const productionLike = readinessPolicy?.productionLike === true || isProductionLikeEnvironment(env);
    const policies = workflowStateService.DEALER_ORDER_READ_POLICIES;
    return {
        workflowId: 'dealer-orders',
        readModel: 'dealer_order',
        readPolicy,
        environment: normalizeEnvironmentName(env),
        productionLike,
        workflowReadPromotionEligible: readPolicy === policies.WORKFLOW_FIRST,
        observationOnly: readPolicy === policies.SNAPSHOT_FIRST,
        rollbackMode: readPolicy === policies.WORKFLOW_DISABLED,
        fallbackAvailable: true,
        allowedPolicies: Object.values(policies),
    };
}

function addBlocker(blockers, code, message, details = {}) {
    blockers.push({ code, message, ...details });
}

function evaluateReleaseEvidence({ readiness, reconciliation, readPolicy, thresholds, evidence }) {
    const blockers = [];
    const warnings = [];

    if (!readiness?.ok) {
        addBlocker(blockers, 'workflow_readiness_not_ok', 'Workflow readiness is degraded or unavailable.', {
            readinessStatus: readiness?.status || 'unknown',
        });
    }
    if (!readiness?.migrations?.ok) {
        addBlocker(blockers, 'workflow_migrations_incomplete', 'Required workflow migrations are missing or incomplete.', {
            migrationStatus: readiness?.migrations?.status || 'unknown',
        });
    }
    if (readiness?.outbox?.status && readiness.outbox.status !== 'ok') {
        warnings.push({
            code: 'workflow_outbox_not_clear',
            message: 'Workflow action outbox is not fully clear.',
            outboxStatus: readiness.outbox.status,
        });
    }
    if (reconciliation?.ok === false) {
        addBlocker(blockers, 'workflow_reconciliation_not_ok', 'Workflow reconciliation is degraded or unavailable.', {
            reconciliationStatus: reconciliation?.status || 'unknown',
        });
    }

    if (readPolicy.rollbackMode) {
        addBlocker(blockers, 'workflow_read_policy_disabled', 'workflow_disabled is a rollback mode and cannot be treated as workflow-read promotion success.', {
            readPolicy: readPolicy.readPolicy,
            productionLike: readPolicy.productionLike,
        });
    } else if (readPolicy.observationOnly) {
        addBlocker(blockers, 'snapshot_first_observation_mode', 'snapshot_first is an observation mode and cannot be treated as workflow-read promotion success.', {
            readPolicy: readPolicy.readPolicy,
        });
    }

    if (evidence.darkRead.comparisonCount < thresholds.minDarkReadComparisons) {
        addBlocker(blockers, 'dark_read_sample_volume_below_threshold', 'Dark-read comparison volume is below the promotion threshold.', {
            actual: evidence.darkRead.comparisonCount,
            required: thresholds.minDarkReadComparisons,
        });
    }
    if (evidence.darkRead.mismatchRate != null && evidence.darkRead.mismatchRate > thresholds.maxDarkReadMismatchRate) {
        addBlocker(blockers, 'dark_read_mismatch_rate_above_threshold', 'Dark-read mismatch rate is above the promotion threshold.', {
            actual: evidence.darkRead.mismatchRate,
            maximum: thresholds.maxDarkReadMismatchRate,
        });
    }
    if (evidence.darkRead.fallbackRate != null && evidence.darkRead.fallbackRate > thresholds.maxDarkReadFallbackRate) {
        addBlocker(blockers, 'dark_read_fallback_rate_above_threshold', 'Snapshot fallback usage is above the promotion threshold.', {
            actual: evidence.darkRead.fallbackRate,
            maximum: thresholds.maxDarkReadFallbackRate,
        });
    }
    if (evidence.darkRead.workflowReadSkippedRate != null && evidence.darkRead.workflowReadSkippedRate > thresholds.maxWorkflowReadSkippedRate) {
        addBlocker(blockers, 'workflow_read_skipped_rate_above_threshold', 'Workflow reads were skipped above the promotion threshold.', {
            actual: evidence.darkRead.workflowReadSkippedRate,
            maximum: thresholds.maxWorkflowReadSkippedRate,
        });
    }
    if (evidence.darkRead.mismatchFields.length && !evidence.darkRead.mismatchFieldsReviewed) {
        addBlocker(blockers, 'dark_read_mismatch_fields_not_reviewed', 'Dark-read mismatch fields require operator review before promotion.', {
            mismatchFields: evidence.darkRead.mismatchFields,
        });
    }

    if (evidence.reconciliationAudit.dryRunCount < thresholds.minReconciliationDryRuns) {
        addBlocker(blockers, 'reconciliation_dry_run_evidence_missing', 'Reconciliation dry-run evidence is below the promotion threshold.', {
            actual: evidence.reconciliationAudit.dryRunCount,
            required: thresholds.minReconciliationDryRuns,
        });
    }
    if (evidence.reconciliationAudit.failedRequeueCount > thresholds.maxReconciliationFailedRequeues) {
        addBlocker(blockers, 'reconciliation_failed_requeue_above_threshold', 'Failed reconciliation requeues exceed the promotion threshold.', {
            actual: evidence.reconciliationAudit.failedRequeueCount,
            maximum: thresholds.maxReconciliationFailedRequeues,
        });
    }
    if (evidence.reconciliationAudit.invalidStatusFilterCount > 0) {
        warnings.push({
            code: 'reconciliation_invalid_status_filters_seen',
            message: 'Invalid reconciliation filters were observed and should be reviewed.',
            count: evidence.reconciliationAudit.invalidStatusFilterCount,
        });
    }

    const failedDrills = evidence.drills.filter(drill => !drill.passed);
    if (failedDrills.length) {
        addBlocker(blockers, 'production_drill_evidence_missing', 'Required production-like drill evidence is missing or failed.', {
            missingDrills: failedDrills.map(drill => drill.key),
        });
    }

    if (thresholds.requireRollbackOwnerApproval && !evidence.approvals.rollbackOwnerApproved) {
        addBlocker(blockers, 'rollback_owner_approval_missing', 'Rollback-owner approval is required before promotion or fallback retirement.', {
            rollbackOwner: evidence.approvals.rollbackOwner || null,
        });
    }

    return { blockers, warnings };
}

function emitReleaseEvidenceTelemetry(report = {}) {
    telemetry.emit('workflow_release_evidence_checked', {
        status: report.status,
        ok: report.ok === true,
        environment: report.readPolicy?.environment || null,
        readPolicy: report.readPolicy?.readPolicy || null,
        darkReadComparisonCount: report.evidence?.darkRead?.comparisonCount || 0,
        darkReadMismatchRate: report.evidence?.darkRead?.mismatchRate,
        darkReadFallbackRate: report.evidence?.darkRead?.fallbackRate,
        workflowReadSkippedRate: report.evidence?.darkRead?.workflowReadSkippedRate,
        reconciliationDryRunCount: report.evidence?.reconciliationAudit?.dryRunCount || 0,
        reconciliationFailedRequeueCount: report.evidence?.reconciliationAudit?.failedRequeueCount || 0,
        drillPassedCount: (report.evidence?.drills || []).filter(drill => drill.passed).length,
        drillRequiredCount: REQUIRED_DRILLS.length,
        blockerCodes: (report.blockers || []).map(blocker => blocker.code),
        ts: Date.now(),
    });
}

async function getWorkflowReleaseEvidence(options = {}) {
    const env = options.env || process.env;
    const nowMs = resolveNowMs(options.now);
    const readiness = await workflowOperations.getWorkflowReadiness({
        env,
        now: nowMs,
        staleLockSeconds: options.staleLockSeconds,
    });
    const reconciliation = await workflowOperations.getWorkflowReconciliation({
        now: nowMs,
        staleLockSeconds: options.staleLockSeconds,
        limit: options.reconciliationLimit || options.limit || 25,
    });
    const thresholds = normalizeThresholds({ env, thresholds: options.thresholds || {} });
    const input = options.evidence || options;
    const evidence = {
        darkRead: normalizeDarkReadEvidence(input),
        reconciliationAudit: normalizeReconciliationAuditEvidence(input),
        drills: normalizeDrillEvidence(input),
        approvals: normalizeApprovals(input),
    };
    const readPolicy = getReadPolicyEvidence({ env, readiness });
    const evaluation = evaluateReleaseEvidence({ readiness, reconciliation, readPolicy, thresholds, evidence });
    const ok = evaluation.blockers.length === 0;
    const report = {
        ok,
        status: ok ? 'ready' : 'blocked',
        generatedAt: new Date(nowMs).toISOString(),
        decision: ok ? 'go' : 'no_go',
        summary: {
            workflowReadinessStatus: readiness.status,
            migrationStatus: readiness.migrations?.status || 'unknown',
            actionOutboxStatus: readiness.outbox?.status || 'unknown',
            reconciliationStatus: reconciliation.status,
            readPolicy: readPolicy.readPolicy,
            darkReadComparisonCount: evidence.darkRead.comparisonCount,
            darkReadMismatchRate: evidence.darkRead.mismatchRate,
            darkReadFallbackRate: evidence.darkRead.fallbackRate,
            workflowReadSkippedRate: evidence.darkRead.workflowReadSkippedRate,
            reconciliationDryRunCount: evidence.reconciliationAudit.dryRunCount,
            reconciliationFailedRequeueCount: evidence.reconciliationAudit.failedRequeueCount,
            drillPassedCount: evidence.drills.filter(drill => drill.passed).length,
            drillRequiredCount: REQUIRED_DRILLS.length,
            rollbackOwnerApproved: evidence.approvals.rollbackOwnerApproved,
        },
        thresholds,
        readPolicy,
        readiness: {
            ok: readiness.ok,
            status: readiness.status,
            checks: readiness.checks,
            migrations: readiness.migrations,
            outbox: readiness.outbox,
        },
        reconciliation: {
            ok: reconciliation.ok,
            status: reconciliation.status,
            generatedAt: reconciliation.generatedAt,
            totals: reconciliation.totals,
            issues: reconciliation.issues,
        },
        evidence,
        blockers: evaluation.blockers,
        warnings: evaluation.warnings,
        guardrails: {
            dealerOrderSnapshotFallbackMustRemain: true,
            dealerOrderSnapshotWritesMustRemain: true,
            bookingWebhookDomainTruthMustRemain: true,
            publicHealthMustStayHighLevel: true,
            dynamicWorkflowLoadingAllowed: false,
        },
    };
    emitReleaseEvidenceTelemetry(report);
    return report;
}

module.exports = {
    DEFAULT_THRESHOLDS,
    REQUIRED_DRILLS,
    getWorkflowReleaseEvidence,
    normalizeDarkReadEvidence,
    normalizeDrillEvidence,
    normalizeReconciliationAuditEvidence,
    normalizeThresholds,
};