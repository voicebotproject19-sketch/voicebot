'use strict';

describe('WorkflowStateRepository', () => {
    let db;
    let Repository;

    beforeEach(() => {
        jest.resetModules();
        jest.mock('../services/db', () => ({ query: jest.fn(), pool: {} }));
        db = require('../services/db');
        Repository = require('../repositories/WorkflowStateRepository');
    });

    test('upserts workflow state and returns normalized JSON', async () => {
        db.query
            .mockResolvedValueOnce({ affectedRows: 1 })
            .mockResolvedValueOnce([{
                callSID: 'CA11111111111111111111111111111111',
                workflowId: 'dealer-orders',
                status: 'confirmed',
                version: 2,
                stateJson: '{"orderId":"DO-1"}',
                summaryJson: '{"itemCount":1}',
            }]);

        const state = await Repository.upsertState({
            callSID: 'CA11111111111111111111111111111111',
            workflowId: 'dealer-orders',
            status: 'confirmed',
            version: 2,
            state: { orderId: 'DO-1' },
            summary: { itemCount: 1 },
        });

        expect(db.query.mock.calls[0][0]).toContain('INSERT INTO call_workflow_states');
        expect(db.query.mock.calls[0][0]).toContain('ON DUPLICATE KEY UPDATE');
        expect(db.query.mock.calls[0][1]).toEqual(expect.arrayContaining([
            'CA11111111111111111111111111111111',
            'dealer-orders',
            'confirmed',
            2,
            JSON.stringify({ orderId: 'DO-1' }),
        ]));
        expect(state).toEqual(expect.objectContaining({
            workflowId: 'dealer-orders',
            stateJson: { orderId: 'DO-1' },
            summaryJson: { itemCount: 1 },
        }));
    });

    test('appends workflow event with idempotent duplicate suppression', async () => {
        db.query
            .mockResolvedValueOnce({ affectedRows: 2 })
            .mockResolvedValueOnce([{
                callSID: 'CA22222222222222222222222222222222',
                workflowId: 'dealer-orders',
                eventType: 'dealer_order_confirmed',
                idempotencyKey: 'workflow_event:abc',
                eventJson: '{"orderId":"DO-2"}',
            }]);

        const event = await Repository.appendEvent({
            callSID: 'CA22222222222222222222222222222222',
            workflowId: 'dealer-orders',
            eventType: 'dealer_order_confirmed',
            idempotencyKey: 'workflow_event:abc',
            event: { orderId: 'DO-2' },
        });

        expect(db.query.mock.calls[0][0]).toContain('INSERT INTO call_workflow_events');
        expect(db.query.mock.calls[0][0]).toContain('ON DUPLICATE KEY UPDATE');
        expect(event).toEqual(expect.objectContaining({
            eventJson: { orderId: 'DO-2' },
            _duplicateSuppressed: true,
        }));
    });

    test('lists workflow events normalized by call and workflow', async () => {
        db.query.mockResolvedValueOnce([
            { id: 1, eventJson: '{"step":"one"}' },
            { id: 2, eventJson: '{"step":"two"}' },
        ]);

        const events = await Repository.listEvents('CA33333333333333333333333333333333', 'dealer-orders', { limit: 2 });

        expect(db.query.mock.calls[0][0]).toContain('SELECT * FROM call_workflow_events');
        expect(db.query.mock.calls[0][1]).toEqual(['CA33333333333333333333333333333333', 'dealer-orders', 2]);
        expect(events.map(event => event.eventJson.step)).toEqual(['one', 'two']);
    });
});