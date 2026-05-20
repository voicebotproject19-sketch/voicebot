'use strict';

describe('workflowReleaseEvidenceService', () => {
    let workflowOperations;
    let telemetry;
    let service;

    const passedDrills = Object.freeze({
        missing_schema: true,
        empty_snapshot: true,
        empty_workflow_row: true,
        workflow_snapshot_mismatch: true,
        retry_backlog: true,
        dead_letter_backlog: true,
        stale_processing_lock: true,
        invalid_status_filter: true,
        dry_run_reconciliation: true,
        capped_mutating_reconciliation: true,
    });

    beforeEach(() => {
        jest.resetModules();
        workflowOperations = {
            getWorkflowReadiness: jest.fn(),
            getWorkflowReconciliation: jest.fn(),
        };
        telemetry = { emit: jest.fn() };
        jest.doMock('../services/workflowOperationsService', () => workflowOperations);
        jest.doMock('../Utils/telemetry', () => telemetry);
        service = require('../services/workflowReleaseEvidenceService');
    });

    function mockHealthyOperations(readPolicy = 'workflow_first') {
        workflowOperations.getWorkflowReadiness.mockResolvedValue({
            ok: true,
            status: 'ok',
            checks: {
                schema: 'ok',
                migrations: 'ok',
                actionOutbox: 'ok',
                worker: 'enabled',
                dealerOrderReadPolicy: readPolicy === 'workflow_first' ? 'ok' : 'observation_mode',
            },
            migrations: { ok: true, status: 'ok', migrations: [] },
            outbox: { ok: true, status: 'ok', totals: {}, issues: [] },
            readModels: {
                dealerOrder: {
                    readPolicy,
                    productionLike: true,
                    workflowReadPromotionBlocked: readPolicy !== 'workflow_first',
                    fallbackAvailable: true,
                },
            },
        });
        workflowOperations.getWorkflowReconciliation.mockResolvedValue({
            ok: true,
            status: 'ok',
            generatedAt: '2026-05-09T12:00:00.000Z',
            totals: {},
            issues: [],
        });
    }

    test('returns ready go decision when release evidence satisfies thresholds', async () => {
        mockHealthyOperations();

        const report = await service.getWorkflowReleaseEvidence({
            env: {
                NODE_ENV: 'production',
                DEALER_ORDER_READ_SOURCE_POLICY: 'workflow_first',
                WORKFLOW_RELEASE_MIN_DARK_READ_COMPARISONS: '50',
                WORKFLOW_RELEASE_MAX_DARK_READ_MISMATCH_RATE: '0.01',
                WORKFLOW_RELEASE_MAX_DARK_READ_FALLBACK_RATE: '0.05',
                WORKFLOW_RELEASE_MAX_WORKFLOW_READ_SKIPPED_RATE: '0',
                WORKFLOW_RELEASE_MIN_RECONCILIATION_DRY_RUNS: '1',
                WORKFLOW_RELEASE_MAX_RECONCILIATION_FAILED_REQUEUES: '0',
                WORKFLOW_RELEASE_REQUIRE_ROLLBACK_OWNER_APPROVAL: 'true',
            },
            now: '2026-05-09T12:00:00.000Z',
            evidence: {
                darkRead: {
                    comparisonCount: 200,
                    mismatchCount: 0,
                    fallbackUsedCount: 2,
                    workflowReadSkippedCount: 0,
                },
                reconciliationAudit: {
                    dryRunCount: 2,
                    mutationCount: 1,
                    failedRequeueCount: 0,
                },
                drills: passedDrills,
                approvals: {
                    rollbackOwnerApproved: true,
                    rollbackOwner: 'platform-ops',
                    approvalId: 'release-2026-05-09',
                },
            },
        });

        expect(report).toEqual(expect.objectContaining({
            ok: true,
            status: 'ready',
            decision: 'go',
            generatedAt: '2026-05-09T12:00:00.000Z',
            blockers: [],
            guardrails: expect.objectContaining({
                dealerOrderSnapshotFallbackMustRemain: true,
                bookingWebhookDomainTruthMustRemain: true,
                dynamicWorkflowLoadingAllowed: false,
            }),
        }));
        expect(report.summary).toEqual(expect.objectContaining({
            darkReadComparisonCount: 200,
            darkReadMismatchRate: 0,
            darkReadFallbackRate: 0.01,
            workflowReadSkippedRate: 0,
            reconciliationDryRunCount: 2,
            rollbackOwnerApproved: true,
        }));
        expect(report.readPolicy).toEqual(expect.objectContaining({
            readPolicy: 'workflow_first',
            workflowReadPromotionEligible: true,
        }));
        expect(report).not.toHaveProperty('actions');
        expect(telemetry.emit).toHaveBeenCalledWith('workflow_release_evidence_checked', expect.objectContaining({
            status: 'ready',
            ok: true,
            readPolicy: 'workflow_first',
            darkReadComparisonCount: 200,
            darkReadFallbackRate: 0.01,
            blockerCodes: [],
        }));
    });

    test('blocks promotion when policy is rollback mode and evidence is missing', async () => {
        mockHealthyOperations('workflow_disabled');

        const report = await service.getWorkflowReleaseEvidence({
            env: {
                NODE_ENV: 'production',
                DEALER_ORDER_READ_SOURCE_POLICY: 'workflow_disabled',
                WORKFLOW_RELEASE_MIN_DARK_READ_COMPARISONS: '100',
                WORKFLOW_RELEASE_REQUIRE_ROLLBACK_OWNER_APPROVAL: 'true',
            },
            now: '2026-05-09T13:00:00.000Z',
        });

        expect(report.ok).toBe(false);
        expect(report.status).toBe('blocked');
        expect(report.decision).toBe('no_go');
        expect(report.blockers).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'workflow_read_policy_disabled' }),
            expect.objectContaining({ code: 'dark_read_sample_volume_below_threshold', actual: 0, required: 100 }),
            expect.objectContaining({ code: 'reconciliation_dry_run_evidence_missing' }),
            expect.objectContaining({ code: 'production_drill_evidence_missing' }),
            expect.objectContaining({ code: 'rollback_owner_approval_missing' }),
        ]));
        expect(report.readPolicy).toEqual(expect.objectContaining({
            readPolicy: 'workflow_disabled',
            rollbackMode: true,
            workflowReadPromotionEligible: false,
        }));
        expect(telemetry.emit).toHaveBeenCalledWith('workflow_release_evidence_checked', expect.objectContaining({
            status: 'blocked',
            ok: false,
            blockerCodes: expect.arrayContaining(['workflow_read_policy_disabled']),
        }));
    });

    test('blocks snapshot-first observation mode even when supplied evidence passes', async () => {
        mockHealthyOperations('snapshot_first');

        const report = await service.getWorkflowReleaseEvidence({
            env: {
                NODE_ENV: 'production',
                DEALER_ORDER_READ_SOURCE_POLICY: 'snapshot_first',
                WORKFLOW_RELEASE_MIN_DARK_READ_COMPARISONS: '50',
                WORKFLOW_RELEASE_MAX_DARK_READ_MISMATCH_RATE: '0.01',
                WORKFLOW_RELEASE_MAX_DARK_READ_FALLBACK_RATE: '0.05',
                WORKFLOW_RELEASE_MAX_WORKFLOW_READ_SKIPPED_RATE: '0',
                WORKFLOW_RELEASE_MIN_RECONCILIATION_DRY_RUNS: '1',
                WORKFLOW_RELEASE_MAX_RECONCILIATION_FAILED_REQUEUES: '0',
                WORKFLOW_RELEASE_REQUIRE_ROLLBACK_OWNER_APPROVAL: 'true',
            },
            evidence: {
                darkRead: {
                    comparisonCount: 200,
                    mismatchCount: 0,
                    fallbackUsedCount: 1,
                    workflowReadSkippedCount: 0,
                    mismatchFieldsReviewed: true,
                },
                reconciliationAudit: {
                    dryRunCount: 2,
                    failedRequeueCount: 0,
                },
                drills: passedDrills,
                approvals: {
                    rollbackOwnerApproved: true,
                    rollbackOwner: 'platform-ops',
                },
            },
        });

        expect(report.ok).toBe(false);
        expect(report.decision).toBe('no_go');
        expect(report.readPolicy).toEqual(expect.objectContaining({
            readPolicy: 'snapshot_first',
            observationOnly: true,
            workflowReadPromotionEligible: false,
        }));
        expect(report.blockers).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'snapshot_first_observation_mode' }),
        ]));
    });

    test('blocks unsafe dark-read and reconciliation audit metrics', async () => {
        mockHealthyOperations();

        const report = await service.getWorkflowReleaseEvidence({
            env: {
                NODE_ENV: 'production',
                DEALER_ORDER_READ_SOURCE_POLICY: 'workflow_first',
                WORKFLOW_RELEASE_MIN_DARK_READ_COMPARISONS: '10',
                WORKFLOW_RELEASE_MAX_DARK_READ_MISMATCH_RATE: '0.02',
                WORKFLOW_RELEASE_MAX_DARK_READ_FALLBACK_RATE: '0.10',
                WORKFLOW_RELEASE_MAX_WORKFLOW_READ_SKIPPED_RATE: '0',
                WORKFLOW_RELEASE_MIN_RECONCILIATION_DRY_RUNS: '1',
                WORKFLOW_RELEASE_MAX_RECONCILIATION_FAILED_REQUEUES: '0',
                WORKFLOW_RELEASE_REQUIRE_ROLLBACK_OWNER_APPROVAL: 'false',
            },
            now: '2026-05-09T14:00:00.000Z',
            evidence: {
                darkRead: {
                    comparisonCount: 100,
                    mismatchCount: 5,
                    fallbackUsedCount: 20,
                    workflowReadSkippedCount: 1,
                    mismatchFields: ['status', 'itemCount'],
                    mismatchFieldsReviewed: false,
                },
                reconciliationAudit: {
                    dryRunCount: 1,
                    failedRequeueCount: 1,
                    invalidStatusFilterCount: 2,
                },
                drills: passedDrills,
            },
        });

        expect(report.ok).toBe(false);
        expect(report.blockers).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'dark_read_mismatch_rate_above_threshold', actual: 0.05, maximum: 0.02 }),
            expect.objectContaining({ code: 'dark_read_fallback_rate_above_threshold', actual: 0.2, maximum: 0.1 }),
            expect.objectContaining({ code: 'workflow_read_skipped_rate_above_threshold', actual: 0.01, maximum: 0 }),
            expect.objectContaining({ code: 'dark_read_mismatch_fields_not_reviewed', mismatchFields: ['status', 'itemCount'] }),
            expect.objectContaining({ code: 'reconciliation_failed_requeue_above_threshold', actual: 1, maximum: 0 }),
        ]));
        expect(report.warnings).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'reconciliation_invalid_status_filters_seen', count: 2 }),
        ]));
    });

    test('blocks degraded readiness and incomplete migrations', async () => {
        workflowOperations.getWorkflowReadiness.mockResolvedValue({
            ok: false,
            status: 'degraded',
            checks: { schema: 'degraded', migrations: 'degraded', actionOutbox: 'missing_schema' },
            migrations: { ok: false, status: 'degraded', migrations: [{ id: '014_call_workflow_state_events', ok: false }] },
            outbox: { ok: false, status: 'missing_schema', totals: {}, issues: [{ code: 'missing_schema' }] },
            readModels: { dealerOrder: { readPolicy: 'workflow_first', productionLike: true } },
        });
        workflowOperations.getWorkflowReconciliation.mockResolvedValue({
            ok: false,
            status: 'missing_schema',
            totals: {},
            issues: [{ code: 'missing_schema' }],
        });

        const report = await service.getWorkflowReleaseEvidence({
            env: {
                NODE_ENV: 'production',
                DEALER_ORDER_READ_SOURCE_POLICY: 'workflow_first',
                WORKFLOW_RELEASE_MIN_DARK_READ_COMPARISONS: '0',
                WORKFLOW_RELEASE_REQUIRE_ROLLBACK_OWNER_APPROVAL: 'false',
                WORKFLOW_RELEASE_MIN_RECONCILIATION_DRY_RUNS: '0',
            },
            evidence: { drills: passedDrills },
            now: '2026-05-09T15:00:00.000Z',
        });

        expect(report.ok).toBe(false);
        expect(report.blockers).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'workflow_readiness_not_ok', readinessStatus: 'degraded' }),
            expect.objectContaining({ code: 'workflow_migrations_incomplete', migrationStatus: 'degraded' }),
            expect.objectContaining({ code: 'workflow_reconciliation_not_ok', reconciliationStatus: 'missing_schema' }),
        ]));
        expect(report.warnings).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'workflow_outbox_not_clear', outboxStatus: 'missing_schema' }),
        ]));
    });
});