'use strict';

describe('WorkflowActionOutboxRepository', () => {
    let db;
    let Repository;

    beforeEach(() => {
        jest.resetModules();
        jest.mock('../services/db', () => ({ query: jest.fn(), pool: {} }));
        db = require('../services/db');
        Repository = require('../repositories/WorkflowActionOutboxRepository');
    });

    test('enqueues action with idempotency key and returns normalized row', async () => {
        db.query
            .mockResolvedValueOnce({ affectedRows: 1 })
            .mockResolvedValueOnce([{
                id: 10,
                callSID: 'CA11111111111111111111111111111111',
                workflowId: 'dealer-orders',
                actionType: 'dealer_order_submit',
                idempotencyKey: 'dealer_order_submit:abc',
                payloadJson: '{"order":{"orderId":"DO-1"}}',
                resultJson: null,
                status: 'queued',
            }]);

        const action = await Repository.enqueueAction({
            callSID: 'CA11111111111111111111111111111111',
            workflowId: 'dealer-orders',
            actionType: 'dealer_order_submit',
            idempotencyKey: 'dealer_order_submit:abc',
            payload: { order: { orderId: 'DO-1' } },
        });

        expect(db.query).toHaveBeenCalledTimes(2);
        expect(db.query.mock.calls[0][0]).toContain('INSERT INTO workflow_action_outbox');
        expect(db.query.mock.calls[0][0]).toContain('ON DUPLICATE KEY UPDATE');
        expect(db.query.mock.calls[0][1]).toEqual(expect.arrayContaining([
            'CA11111111111111111111111111111111',
            'dealer-orders',
            'dealer_order_submit',
            'dealer_order_submit:abc',
        ]));
        expect(action.payloadJson).toEqual({ order: { orderId: 'DO-1' } });
    });

    test('claims due actions and normalizes JSON payload', async () => {
        db.query
            .mockResolvedValueOnce([{ id: 7 }])
            .mockResolvedValueOnce({ affectedRows: 1 })
            .mockResolvedValueOnce([{
                id: 7,
                callSID: 'CA22222222222222222222222222222222',
                workflowId: 'dealer-orders',
                actionType: 'dealer_order_submit',
                payloadJson: '{"order":{"orderId":"DO-2"}}',
                resultJson: null,
                status: 'processing',
            }]);

        const actions = await Repository.claimDueActions({ limit: 1, lockId: 'test-worker' });

        expect(actions).toHaveLength(1);
        expect(actions[0]).toEqual(expect.objectContaining({
            id: 7,
            status: 'processing',
            payloadJson: { order: { orderId: 'DO-2' } },
        }));
        expect(db.query.mock.calls[0][0]).toContain("status = 'processing' AND lockedAt IS NOT NULL");
        expect(db.query.mock.calls[1][0]).toContain("SET status = 'processing'");
    });

    test('reclaims stale processing actions for replay', async () => {
        db.query
            .mockResolvedValueOnce({ affectedRows: 1 })
            .mockResolvedValueOnce([{
                id: 8,
                callSID: 'CA33333333333333333333333333333333',
                workflowId: 'dealer-orders',
                actionType: 'dealer_order_submit',
                payloadJson: '{"order":{"orderId":"DO-3"}}',
                resultJson: null,
                status: 'processing',
            }]);

        const action = await Repository.claimAction(8, { lockId: 'replay-worker', lockTimeoutSeconds: 5 });

        expect(db.query.mock.calls[0][0]).toContain("status = 'processing' AND lockedAt IS NOT NULL");
        expect(db.query.mock.calls[0][1]).toEqual(['replay-worker', 8, 5, 5]);
        expect(action).toEqual(expect.objectContaining({
            id: 8,
            status: 'processing',
            _claimedByWorker: true,
            payloadJson: { order: { orderId: 'DO-3' } },
        }));
    });

    test('marks failures as retry or dead letter based on database attempt counters', async () => {
        const err = new Error('erp_down');
        err.resultPayload = { attempt: { channel: 'sms', ok: false, failureReason: 'provider_api_error' } };
        db.query
            .mockResolvedValueOnce({ affectedRows: 1 })
            .mockResolvedValueOnce([{
                id: 9,
                payloadJson: '{}',
                resultJson: '{"attempt":{"channel":"sms","ok":false,"failureReason":"provider_api_error"}}',
                status: 'retry',
                lastError: 'erp_down'
            }]);

        const action = await Repository.markActionFailed(9, err, { retryDelayMs: 1000 });

        expect(db.query.mock.calls[0][0]).toContain("CASE WHEN attemptCount >= maxAttempts THEN 'dead_letter' ELSE 'retry' END");
        expect(db.query.mock.calls[0][0]).toContain('resultJson = COALESCE(?, resultJson)');
        expect(db.query.mock.calls[0][1]).toEqual([
            1,
            JSON.stringify(err.resultPayload),
            'erp_down',
            9,
        ]);
        expect(action.status).toBe('retry');
        expect(action.resultJson).toEqual(err.resultPayload);
    });

    test('requeues retry, failed, dead-letter, or stale processing actions for operator replay', async () => {
        db.query
            .mockResolvedValueOnce({ affectedRows: 1 })
            .mockResolvedValueOnce([{
                id: 61,
                callSID: 'CA61616161616161616161616161616161',
                workflowId: 'dealer-orders',
                actionType: 'dealer_order_submit',
                payloadJson: '{"order":{"orderId":"DO-61"}}',
                resultJson: null,
                status: 'queued',
            }]);

        const action = await Repository.requeueAction(61, { reason: 'manual_retry', lockTimeoutSeconds: 45 });

        expect(db.query.mock.calls[0][0]).toContain("status IN ('retry', 'failed', 'dead_letter')");
        expect(db.query.mock.calls[0][0]).toContain("status = 'processing' AND lockedAt IS NOT NULL");
        expect(db.query.mock.calls[0][1]).toEqual([null, 'manual_retry', 61, 45]);
        expect(action).toEqual(expect.objectContaining({
            id: 61,
            status: 'queued',
            _requeued: true,
            payloadJson: { order: { orderId: 'DO-61' } },
        }));
    });

    test('lists action status counts with stale processing totals', async () => {
        db.query.mockResolvedValueOnce([{
            workflowId: 'dealer-orders',
            actionType: 'dealer_order_submit',
            status: 'processing',
            count: '3',
            oldestAvailableAt: '2026-05-09T10:00:00.000Z',
            oldestLockedAt: '2026-05-09T10:01:00.000Z',
            oldestRetryAvailableAt: null,
            oldestDeadLetterAt: null,
            oldestStaleLockedAt: '2026-05-09T10:01:00.000Z',
            staleProcessingCount: '2',
        }]);

        const rows = await Repository.listActionStatusCounts({ workflowId: 'dealer-orders', staleLockSeconds: 30 });

        expect(db.query.mock.calls[0][0]).toContain('GROUP BY workflowId, actionType, status');
        expect(db.query.mock.calls[0][0]).toContain("status = 'processing' AND lockedAt IS NOT NULL");
        expect(db.query.mock.calls[0][1]).toEqual([30, 30, 'dealer-orders', 'dealer-orders', null, null]);
        expect(rows).toEqual([expect.objectContaining({
            workflowId: 'dealer-orders',
            actionType: 'dealer_order_submit',
            status: 'processing',
            count: 3,
            oldestStaleLockedAt: '2026-05-09T10:01:00.000Z',
            staleProcessingCount: 2,
        })]);
    });
});