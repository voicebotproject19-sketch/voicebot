'use strict';

describe('workflowOperationsService', () => {
    let db;
    let Repository;
    let workflowActionOutbox;
    let telemetry;
    let service;

    beforeEach(() => {
        jest.resetModules();
        db = { query: jest.fn() };
        Repository = {
            listActionStatusCounts: jest.fn(),
            listActionSamples: jest.fn(),
        };
        workflowActionOutbox = {
            requeueWorkflowAction: jest.fn(),
        };
        telemetry = { emit: jest.fn() };
        jest.doMock('../services/db', () => db);
        jest.doMock('../repositories/WorkflowActionOutboxRepository', () => Repository);
        jest.doMock('../services/workflowActionOutboxService', () => workflowActionOutbox);
        jest.doMock('../Utils/telemetry', () => telemetry);
        service = require('../services/workflowOperationsService');
    });

    function mockSchemaColumns() {
        db.query.mockImplementation((sql) => {
            if (sql.includes('workflow_action_outbox')) {
                return Promise.resolve(['id', 'workflowId', 'actionType', 'idempotencyKey', 'payloadJson', 'resultJson', 'status', 'attemptCount', 'availableAt', 'lockedAt'].map(Field => ({ Field })));
            }
            if (sql.includes('call_workflow_states')) {
                return Promise.resolve(['id', 'callSID', 'workflowId', 'status', 'stateJson', 'summaryJson'].map(Field => ({ Field })));
            }
            if (sql.includes('call_workflow_events')) {
                return Promise.resolve(['id', 'callSID', 'workflowId', 'eventType', 'idempotencyKey', 'eventJson'].map(Field => ({ Field })));
            }
            return Promise.resolve([]);
        });
    }

    test('reports healthy workflow readiness when schema and outbox are clean', async () => {
        mockSchemaColumns();
        Repository.listActionStatusCounts.mockResolvedValue([]);

        const readiness = await service.getWorkflowReadiness({ env: { ACTION_OUTBOX_WORKER_ENABLED: 'true' } });

        expect(readiness).toEqual(expect.objectContaining({
            ok: true,
            status: 'ok',
            checks: expect.objectContaining({ schema: 'ok', migrations: 'ok', actionOutbox: 'ok', worker: 'enabled', dealerOrderReadPolicy: 'ok' }),
            readModels: expect.objectContaining({
                dealerOrder: expect.objectContaining({
                    readPolicy: 'workflow_first',
                    fallbackAvailable: true,
                    workflowReadPromotionBlocked: false,
                }),
            }),
            manifest: expect.objectContaining({ workflowCount: 3, actionCount: 3 }),
            migrations: expect.objectContaining({
                status: 'ok',
                migrations: expect.arrayContaining([
                    expect.objectContaining({ id: '013_workflow_action_outbox', status: 'ok' }),
                    expect.objectContaining({ id: '014_call_workflow_state_events', status: 'ok' }),
                ]),
            }),
        }));
    });

    test('degrades readiness for dead-letter and stale processing backlog', async () => {
        mockSchemaColumns();
        Repository.listActionStatusCounts.mockResolvedValue([
            { workflowId: 'dealer-orders', actionType: 'dealer_order_submit', status: 'dead_letter', count: 1, staleProcessingCount: 0, oldestDeadLetterAt: '2026-05-09T09:00:00.000Z' },
            { workflowId: 'booking-link-delivery', actionType: 'booking_link_deliver', status: 'processing', count: 2, staleProcessingCount: 2, oldestStaleLockedAt: '2026-05-09T10:01:00.000Z' },
        ]);

        const readiness = await service.getWorkflowReadiness({ staleLockSeconds: 30, now: '2026-05-09T10:05:00.000Z' });

        expect(readiness.ok).toBe(false);
        expect(readiness.outbox.totals).toEqual(expect.objectContaining({
            dead_letter: 1,
            processing: 2,
            staleProcessing: 2,
        }));
        expect(readiness.outbox.byWorkflow).toEqual(expect.arrayContaining([
            expect.objectContaining({ workflowId: 'dealer-orders', actionType: 'dealer_order_submit' }),
        ]));
        expect(readiness.outbox.issues).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'dead_letter_backlog', severity: 'error', count: 1, oldestAgeSeconds: 3900 }),
            expect.objectContaining({ code: 'stale_processing_locks', severity: 'error', count: 2, oldestAgeSeconds: 240 }),
        ]));
        expect(telemetry.emit).toHaveBeenCalledWith('workflow_readiness_checked', expect.objectContaining({
            status: 'degraded',
            ok: false,
            retryCount: 0,
            deadLetterCount: 1,
            staleProcessingCount: 2,
            oldestDeadLetterAgeSeconds: 3900,
            oldestStaleLockAgeSeconds: 240,
            issueCodes: expect.arrayContaining(['dead_letter_backlog', 'stale_processing_locks']),
        }));
    });

    test('distinguishes retry backlog as warning without failing readiness', async () => {
        mockSchemaColumns();
        Repository.listActionStatusCounts.mockResolvedValue([
            { workflowId: 'dealer-orders', actionType: 'dealer_order_submit', status: 'retry', count: 3, staleProcessingCount: 0, oldestRetryAvailableAt: '2026-05-09T10:00:00.000Z' },
        ]);

        const readiness = await service.getWorkflowReadiness({ env: { ACTION_OUTBOX_WORKER_ENABLED: 'true', NODE_ENV: 'production' }, now: '2026-05-09T10:05:00.000Z' });

        expect(readiness.ok).toBe(true);
        expect(readiness.checks.actionOutbox).toBe('warning');
        expect(readiness.outbox.issues).toEqual([expect.objectContaining({
            code: 'retry_backlog',
            severity: 'warning',
            count: 3,
            oldestAgeSeconds: 300,
        })]);
        expect(readiness.outbox.byWorkflow).toEqual([expect.objectContaining({
            oldestRetryAvailableAt: '2026-05-09T10:00:00.000Z',
            oldestRetryAgeSeconds: 300,
        })]);
    });

    test('treats disabled worker severity as environment-aware', async () => {
        mockSchemaColumns();
        Repository.listActionStatusCounts.mockResolvedValue([]);

        const development = await service.getWorkflowReadiness({ env: { ACTION_OUTBOX_WORKER_ENABLED: 'false', NODE_ENV: 'development' } });
        const production = await service.getWorkflowReadiness({ env: { ACTION_OUTBOX_WORKER_ENABLED: 'false', NODE_ENV: 'production' } });

        expect(development.ok).toBe(true);
        expect(development.checks.actionOutbox).toBe('warning');
        expect(development.outbox).toEqual(expect.objectContaining({
            environment: 'development',
            workerEnabled: false,
            workerRequired: false,
        }));
        expect(development.outbox.issues).toEqual([expect.objectContaining({ code: 'worker_disabled', severity: 'warning' })]);

        expect(production.ok).toBe(false);
        expect(production.checks.actionOutbox).toBe('degraded');
        expect(production.outbox).toEqual(expect.objectContaining({
            environment: 'production',
            workerEnabled: false,
            workerRequired: true,
        }));
        expect(production.outbox.issues).toEqual([expect.objectContaining({ code: 'worker_disabled', severity: 'error' })]);
    });

    test('surfaces dealer-order rollback read policy without marking schema readiness healthy promotion', async () => {
        mockSchemaColumns();
        Repository.listActionStatusCounts.mockResolvedValue([]);

        const readiness = await service.getWorkflowReadiness({
            env: { ACTION_OUTBOX_WORKER_ENABLED: 'true', NODE_ENV: 'production', DEALER_ORDER_READ_SOURCE_POLICY: 'workflow_disabled' },
        });

        expect(readiness.ok).toBe(true);
        expect(readiness.checks.dealerOrderReadPolicy).toBe('rollback_mode');
        expect(readiness.readModels.dealerOrder).toEqual(expect.objectContaining({
            readPolicy: 'workflow_disabled',
            productionLike: true,
            rollbackMode: true,
            workflowReadPromotionBlocked: true,
            fallbackAvailable: true,
        }));
    });

    test('reports missing schema without throwing', async () => {
        const err = new Error("Table 'voicebot.workflow_action_outbox' doesn't exist");
        err.code = 'ER_NO_SUCH_TABLE';
        db.query.mockRejectedValue(err);
        Repository.listActionStatusCounts.mockRejectedValue(err);

        const readiness = await service.getWorkflowReadiness();

        expect(readiness.ok).toBe(false);
        expect(readiness.schema.tables.workflow_action_outbox.status).toBe('missing_table');
        expect(readiness.outbox.status).toBe('missing_schema');
        expect(readiness.outbox.issues).toEqual([expect.objectContaining({ code: 'missing_schema', severity: 'error' })]);
        expect(telemetry.emit).toHaveBeenCalledWith('workflow_readiness_checked', expect.objectContaining({
            status: 'missing_schema',
            ok: false,
            issueCodes: ['missing_schema'],
        }));
    });

    test('rejects unsupported table inspection names', async () => {
        const result = await service.inspectTableColumns('workflow_action_outbox; DROP TABLE users', ['id']);

        expect(result).toEqual(expect.objectContaining({
            ok: false,
            status: 'invalid_table',
            reason: 'unsupported_workflow_table',
        }));
        expect(db.query).not.toHaveBeenCalled();
    });

    test('returns normalized workflow action samples without payloads', async () => {
        Repository.listActionSamples.mockResolvedValue([
            {
                id: 5,
                callSID: 'CA55555555555555555555555555555555',
                workflowId: 'dealer-orders',
                actionType: 'dealer_order_submit',
                status: 'dead_letter',
                attemptCount: 3,
                maxAttempts: 3,
                availableAt: '2026-05-09T10:00:00.000Z',
                lockedAt: null,
                lastError: 'ERP failed for +14155551234 and ops@example.com',
                createdAt: '2026-05-09T09:00:00.000Z',
                updatedAt: '2026-05-09T10:05:00.000Z',
            },
        ]);

        const samples = await service.getWorkflowActionSamples({
            workflowId: 'dealer-orders',
            statuses: ['dead_letter'],
            limit: 10,
        });

        expect(Repository.listActionSamples).toHaveBeenCalledWith(expect.objectContaining({
            workflowId: 'dealer-orders',
            statuses: ['dead_letter'],
            limit: 10,
        }));
        expect(samples).toEqual({
            count: 1,
            actions: [expect.objectContaining({
                id: 5,
                callIdHash: expect.stringMatching(/^[a-f0-9]{16}$/),
                workflowId: 'dealer-orders',
                status: 'dead_letter',
                lastError: 'ERP failed for [REDACTED_PHONE] and [REDACTED_EMAIL]',
                reasonSummary: 'ERP failed for [REDACTED_PHONE] and [REDACTED_EMAIL]',
            })],
        });
        expect(samples.actions[0]).not.toHaveProperty('callSID');
    });

    test('defaults action samples to operator triage statuses', async () => {
        Repository.listActionSamples.mockResolvedValue([]);

        const samples = await service.getWorkflowActionSamples({ workflowId: '  ', limit: 999 });

        expect(samples).toEqual({ count: 0, actions: [] });
        expect(Repository.listActionSamples).toHaveBeenCalledWith({
            workflowId: null,
            actionType: null,
            statuses: ['dead_letter', 'retry', 'processing'],
            limit: 100,
        });
    });

    test('returns redacted reconciliation with completion rates and backlog issues', async () => {
        Repository.listActionStatusCounts.mockResolvedValue([
            { workflowId: 'dealer-orders', actionType: 'dealer_order_submit', status: 'completed', count: 8, staleProcessingCount: 0 },
            { workflowId: 'dealer-orders', actionType: 'dealer_order_submit', status: 'retry', count: 2, staleProcessingCount: 0, oldestRetryAvailableAt: '2026-05-09T10:00:00.000Z' },
            { workflowId: 'handover-followup', actionType: 'handover_followup_send', status: 'dead_letter', count: 1, staleProcessingCount: 0, oldestDeadLetterAt: '2026-05-09T09:55:00.000Z' },
        ]);
        Repository.listActionSamples.mockResolvedValue([
            {
                id: 81,
                callSID: 'CA81818181818181818181818181818181',
                workflowId: 'handover-followup',
                actionType: 'handover_followup_send',
                status: 'dead_letter',
                attemptCount: 3,
                maxAttempts: 3,
                lastError: 'Email failed for +14155550000 and ops@example.com',
            },
        ]);

        const reconciliation = await service.getWorkflowReconciliation({
            now: '2026-05-09T10:05:00.000Z',
            limit: 10,
        });

        expect(reconciliation).toEqual(expect.objectContaining({
            ok: false,
            status: 'degraded',
            staleLockSeconds: 120,
            generatedAt: '2026-05-09T10:05:00.000Z',
            issues: expect.arrayContaining([
                expect.objectContaining({ code: 'retry_backlog', count: 2, oldestAgeSeconds: 300 }),
                expect.objectContaining({ code: 'dead_letter_backlog', count: 1, oldestAgeSeconds: 600 }),
            ]),
            samples: [expect.objectContaining({
                id: 81,
                callIdHash: expect.stringMatching(/^[a-f0-9]{16}$/),
                reasonSummary: 'Email failed for [REDACTED_PHONE] and [REDACTED_EMAIL]',
            })],
        }));
        expect(reconciliation.workflows).toEqual(expect.arrayContaining([
            expect.objectContaining({
                workflowId: 'dealer-orders',
                actionType: 'dealer_order_submit',
                totalActions: 10,
                completed: 8,
                retry: 2,
                completionRate: 0.8,
            }),
            expect.objectContaining({
                workflowId: 'handover-followup',
                actionType: 'handover_followup_send',
                deadLetter: 1,
                needsAttention: 1,
            }),
        ]));
        expect(reconciliation.samples[0]).not.toHaveProperty('callSID');
        expect(Repository.listActionSamples).toHaveBeenCalledWith(expect.objectContaining({
            statuses: ['dead_letter', 'retry', 'processing', 'failed'],
            limit: 10,
        }));
    });

    test('delegates operator requeue with normalized reason and bounded lock timeout', async () => {
        workflowActionOutbox.requeueWorkflowAction.mockResolvedValue({
            ok: true,
            action: {
                id: 72,
                callSID: 'CA72727272727272727272727272727272',
                workflowId: 'dealer-orders',
                actionType: 'dealer_order_submit',
                status: 'queued',
                attemptCount: 3,
                maxAttempts: 3,
                payloadJson: { order: { dealerPhone: '+14155551234' } },
                resultJson: { erp: { status: 'failed' } },
                lastError: 'manual_retry for +14155551234 and ops@example.com',
            },
        });

        const result = await service.requeueWorkflowAction({
            actionId: 72,
            reason: '  manual_retry  ',
            lockTimeoutSeconds: 9999,
        });

        expect(result).toEqual({
            ok: true,
            action: expect.objectContaining({
                id: 72,
                callIdHash: expect.stringMatching(/^[a-f0-9]{16}$/),
                workflowId: 'dealer-orders',
                actionType: 'dealer_order_submit',
                status: 'queued',
                reasonSummary: 'manual_retry for [REDACTED_PHONE] and [REDACTED_EMAIL]',
            }),
        });
        expect(result.action).not.toHaveProperty('callSID');
        expect(result.action).not.toHaveProperty('payloadJson');
        expect(result.action).not.toHaveProperty('resultJson');
        expect(workflowActionOutbox.requeueWorkflowAction).toHaveBeenCalledWith(72, {
            reason: 'manual_retry',
            lockTimeoutSeconds: 3600,
            auditId: null,
        });
    });

    test('returns dry-run audited reconciliation requeue plan without mutation', async () => {
        Repository.listActionSamples.mockResolvedValue([
            {
                id: 91,
                callSID: 'CA91919191919191919191919191919191',
                workflowId: 'dealer-orders',
                actionType: 'dealer_order_submit',
                status: 'dead_letter',
                attemptCount: 3,
                maxAttempts: 3,
                lastError: 'ERP failed for +14155551234',
            },
        ]);

        const result = await service.requeueWorkflowReconciliation({
            workflowId: 'dealer-orders',
            actionType: 'dealer_order_submit',
            dryRun: true,
            limit: 10,
            now: '2026-05-09T11:00:00.000Z',
        });

        expect(result).toEqual(expect.objectContaining({
            ok: true,
            status: 'dry_run',
            audit: expect.objectContaining({
                auditId: expect.stringMatching(/^workflow-reconciliation:/),
                mode: 'dry_run',
                dryRun: true,
                plannedActionCount: 1,
                generatedAt: '2026-05-09T11:00:00.000Z',
            }),
            actions: [expect.objectContaining({
                id: 91,
                callIdHash: expect.stringMatching(/^[a-f0-9]{16}$/),
                reasonSummary: 'ERP failed for [REDACTED_PHONE]',
            })],
        }));
        expect(Repository.listActionSamples).toHaveBeenCalledWith(expect.objectContaining({
            workflowId: 'dealer-orders',
            actionType: 'dealer_order_submit',
            statuses: ['dead_letter', 'retry', 'failed'],
            limit: 10,
        }));
        expect(workflowActionOutbox.requeueWorkflowAction).not.toHaveBeenCalled();
        expect(telemetry.emit).toHaveBeenCalledWith('workflow_reconciliation_audit', expect.objectContaining({
            mode: 'dry_run',
            dryRun: true,
            plannedActionCount: 1,
        }));
    });

    test('requires explicit confirmation before mutating reconciliation requeue', async () => {
        Repository.listActionSamples.mockResolvedValue([{ id: 92, workflowId: 'dealer-orders', actionType: 'dealer_order_submit', status: 'retry' }]);

        const result = await service.requeueWorkflowReconciliation({ dryRun: false, limit: 1 });

        expect(result).toEqual(expect.objectContaining({
            ok: false,
            status: 'confirmation_required',
            requiredConfirmation: 'requeue',
        }));
        expect(workflowActionOutbox.requeueWorkflowAction).not.toHaveBeenCalled();
    });

    test('rejects invalid reconciliation requeue statuses instead of broadening the filter', async () => {
        const result = await service.requeueWorkflowReconciliation({ statuses: ['completed'], dryRun: true });

        expect(result).toEqual(expect.objectContaining({
            ok: false,
            status: 'invalid_status_filter',
            invalidStatuses: ['completed'],
            validStatuses: expect.arrayContaining(['dead_letter', 'retry', 'failed', 'processing']),
            audit: expect.objectContaining({
                invalidStatuses: ['completed'],
                plannedActionCount: 0,
            }),
        }));
        expect(Repository.listActionSamples).not.toHaveBeenCalled();
        expect(workflowActionOutbox.requeueWorkflowAction).not.toHaveBeenCalled();
        expect(telemetry.emit).toHaveBeenCalledWith('workflow_reconciliation_audit', expect.objectContaining({
            mode: 'dry_run',
            dryRun: true,
            plannedActionCount: 0,
            statuses: [],
            invalidStatuses: ['completed'],
        }));
    });

    test('dry-run reconciliation requeue only plans stale processing locks', async () => {
        Repository.listActionSamples.mockResolvedValue([
            {
                id: 95,
                callSID: 'CA95959595959595959595959595959595',
                workflowId: 'dealer-orders',
                actionType: 'dealer_order_submit',
                status: 'processing',
                lockedAt: '2026-05-09T11:59:00.000Z',
                lastError: 'currently processing',
            },
            {
                id: 96,
                callSID: 'CA96969696969696969696969696969696',
                workflowId: 'dealer-orders',
                actionType: 'dealer_order_submit',
                status: 'processing',
                lockedAt: '2026-05-09T11:50:00.000Z',
                lastError: 'stale processing lock',
            },
        ]);

        const result = await service.requeueWorkflowReconciliation({
            statuses: ['processing'],
            dryRun: true,
            lockTimeoutSeconds: 120,
            now: '2026-05-09T12:00:00.000Z',
        });

        expect(result).toEqual(expect.objectContaining({
            ok: true,
            status: 'dry_run',
            actions: [expect.objectContaining({ id: 96 })],
            audit: expect.objectContaining({ plannedActionCount: 1 }),
        }));
        expect(result.actions).toHaveLength(1);
        expect(workflowActionOutbox.requeueWorkflowAction).not.toHaveBeenCalled();
    });

    test('mutating reconciliation requeue only replays stale processing locks through outbox path', async () => {
        Repository.listActionSamples.mockResolvedValue([
            {
                id: 97,
                callSID: 'CA97979797979797979797979797979797',
                workflowId: 'dealer-orders',
                actionType: 'dealer_order_submit',
                status: 'processing',
                lockedAt: '2026-05-09T12:59:00.000Z',
                lastError: 'fresh processing lock',
            },
            {
                id: 98,
                callSID: 'CA98989898989898989898989898989898',
                workflowId: 'dealer-orders',
                actionType: 'dealer_order_submit',
                status: 'processing',
                lockedAt: '2026-05-09T12:50:00.000Z',
                lastError: 'stale processing lock',
            },
        ]);
        workflowActionOutbox.requeueWorkflowAction.mockResolvedValueOnce({
            ok: true,
            action: {
                id: 98,
                callSID: 'CA98989898989898989898989898989898',
                workflowId: 'dealer-orders',
                actionType: 'dealer_order_submit',
                status: 'queued',
            },
        });

        const result = await service.requeueWorkflowReconciliation({
            statuses: ['processing'],
            dryRun: false,
            confirm: 'requeue',
            lockTimeoutSeconds: 120,
            now: '2026-05-09T13:00:00.000Z',
            auditId: 'workflow-reconciliation:stale-processing-test',
        });

        expect(result).toEqual(expect.objectContaining({
            ok: true,
            status: 'requeued',
            audit: expect.objectContaining({ plannedActionCount: 1, requeuedCount: 1, failedCount: 0 }),
            results: [expect.objectContaining({ action: expect.objectContaining({ id: 98 }) })],
        }));
        expect(workflowActionOutbox.requeueWorkflowAction).toHaveBeenCalledTimes(1);
        expect(workflowActionOutbox.requeueWorkflowAction).toHaveBeenCalledWith(98, expect.objectContaining({
            auditId: 'workflow-reconciliation:stale-processing-test',
            lockTimeoutSeconds: 120,
        }));
        expect(telemetry.emit).toHaveBeenCalledWith('workflow_reconciliation_requeue_completed', expect.objectContaining({
            auditId: 'workflow-reconciliation:stale-processing-test',
            mode: 'requeue',
            dryRun: false,
            plannedActionCount: 1,
            requeuedCount: 1,
            failedCount: 0,
            statuses: ['processing'],
        }));
    });

    test('mutating reconciliation is capped and routes through outbox requeue with audit id', async () => {
        Repository.listActionSamples.mockResolvedValue([
            { id: 93, callSID: 'CA93939393939393939393939393939393', workflowId: 'dealer-orders', actionType: 'dealer_order_submit', status: 'dead_letter' },
            { id: 94, callSID: 'CA94949494949494949494949494949494', workflowId: 'booking-link-delivery', actionType: 'booking_link_deliver', status: 'retry' },
        ]);
        workflowActionOutbox.requeueWorkflowAction
            .mockResolvedValueOnce({ ok: true, action: { id: 93, callSID: 'CA93939393939393939393939393939393', workflowId: 'dealer-orders', actionType: 'dealer_order_submit', status: 'queued' } })
            .mockResolvedValueOnce({ ok: true, action: { id: 94, callSID: 'CA94949494949494949494949494949494', workflowId: 'booking-link-delivery', actionType: 'booking_link_deliver', status: 'queued' } });

        const result = await service.requeueWorkflowReconciliation({
            dryRun: false,
            confirm: 'requeue',
            reason: 'provider_recovered',
            limit: 100,
            auditId: 'workflow-reconciliation:test-audit',
        });

        expect(Repository.listActionSamples).toHaveBeenCalledWith(expect.objectContaining({ limit: 25 }));
        expect(workflowActionOutbox.requeueWorkflowAction).toHaveBeenCalledWith(93, expect.objectContaining({
            reason: 'provider_recovered',
            auditId: 'workflow-reconciliation:test-audit',
        }));
        expect(workflowActionOutbox.requeueWorkflowAction).toHaveBeenCalledWith(94, expect.objectContaining({
            reason: 'provider_recovered',
            auditId: 'workflow-reconciliation:test-audit',
        }));
        expect(result).toEqual(expect.objectContaining({
            ok: true,
            status: 'requeued',
            audit: expect.objectContaining({ requeuedCount: 2, failedCount: 0 }),
            results: [
                expect.objectContaining({ ok: true, action: expect.objectContaining({ id: 93, callIdHash: expect.stringMatching(/^[a-f0-9]{16}$/) }) }),
                expect.objectContaining({ ok: true, action: expect.objectContaining({ id: 94, callIdHash: expect.stringMatching(/^[a-f0-9]{16}$/) }) }),
            ],
        }));
        expect(telemetry.emit).toHaveBeenCalledWith('workflow_reconciliation_requeue_completed', expect.objectContaining({
            auditId: 'workflow-reconciliation:test-audit',
            mode: 'requeue',
            dryRun: false,
            requeuedCount: 2,
            failedCount: 0,
            statuses: ['dead_letter', 'retry', 'failed'],
        }));
    });
});