'use strict';

describe('workflowStateService', () => {
    let Repository;
    let telemetry;
    let service;

    beforeEach(() => {
        jest.resetModules();
        Repository = {
            appendEvent: jest.fn(),
            buildEventIdempotencyKey: jest.fn(() => 'workflow_event:mock'),
            getState: jest.fn(),
            listEvents: jest.fn(),
            upsertState: jest.fn(),
        };
        telemetry = { emit: jest.fn() };
        jest.doMock('../repositories/WorkflowStateRepository', () => Repository);
        jest.doMock('../Utils/telemetry', () => telemetry);
        service = require('../services/workflowStateService');
    });

    test('recordWorkflowStep writes event and state', async () => {
        Repository.appendEvent.mockResolvedValue({ id: 1 });
        Repository.upsertState.mockResolvedValue({ id: 2 });

        const result = await service.recordWorkflowStep({
            callSID: 'CA11111111111111111111111111111111',
            workflowId: 'dealer-orders',
            eventType: 'dealer_order_confirmed',
            event: { orderId: 'DO-1' },
            state: { status: 'confirmed' },
        });

        expect(result.ok).toBe(true);
        expect(Repository.appendEvent).toHaveBeenCalledWith(expect.objectContaining({
            eventType: 'dealer_order_confirmed',
        }));
        expect(Repository.upsertState).toHaveBeenCalledWith(expect.objectContaining({
            state: { status: 'confirmed' },
        }));
    });

    test('fails soft when workflow tables are not migrated yet', async () => {
        const err = new Error("Table 'voicebot.call_workflow_events' doesn't exist");
        err.code = 'ER_NO_SUCH_TABLE';
        Repository.appendEvent.mockRejectedValue(err);

        const result = await service.appendWorkflowEvent({
            callSID: 'CA22222222222222222222222222222222',
            workflowId: 'dealer-orders',
            eventType: 'dealer_order_confirmed',
        });

        expect(result).toEqual(expect.objectContaining({
            ok: false,
            skipped: true,
            reason: 'ER_NO_SUCH_TABLE',
        }));
    });

    test('reads workflow state and events through fail-soft helpers', async () => {
        Repository.getState.mockResolvedValue({ id: 3, stateJson: { status: 'confirmed' } });
        Repository.listEvents.mockResolvedValue([{ id: 4, eventType: 'dealer_order_confirmed' }]);

        await expect(service.getWorkflowState('CA33333333333333333333333333333333', 'dealer-orders'))
            .resolves.toEqual({ ok: true, state: { id: 3, stateJson: { status: 'confirmed' } } });
        await expect(service.listWorkflowEvents('CA33333333333333333333333333333333', 'dealer-orders', { limit: 5 }))
            .resolves.toEqual({ ok: true, events: [{ id: 4, eventType: 'dealer_order_confirmed' }] });
    });

    test('prefers workflow dealer-order read model and reports parity', async () => {
        Repository.getState.mockResolvedValue({
            id: 5,
            stateJson: { status: 'confirmed', orderId: 'DO-5', confirmed: true, items: [{ sku: 'A' }] },
        });

        const result = await service.getDealerOrderReadModel('CA55555555555555555555555555555555', {
            fallbackDealerOrder: { status: 'confirmed', orderId: 'DO-5', confirmed: true, items: [{ sku: 'A' }] },
        });

        expect(result).toEqual(expect.objectContaining({
            ok: true,
            source: 'workflow_state',
            fallbackUsed: false,
            dealerOrder: expect.objectContaining({ orderId: 'DO-5' }),
            parity: expect.objectContaining({ ok: true, mismatches: [] }),
        }));
        expect(telemetry.emit).toHaveBeenCalledWith('workflow_dark_read_compared', expect.objectContaining({
            workflowId: 'dealer-orders',
            readModel: 'dealer_order',
            source: 'workflow_state',
            fallbackUsed: false,
            parityChecked: true,
            parityOk: true,
            mismatchCount: 0,
            callIdHash: expect.stringMatching(/^[a-f0-9]{16}$/),
        }));
    });

    test('can pin dealer-order reads to snapshot fallback while still dark-reading workflow parity', async () => {
        Repository.getState.mockResolvedValue({
            id: 51,
            stateJson: { status: 'confirmed', orderId: 'DO-WF', confirmed: true, items: [{ sku: 'A' }] },
        });

        const result = await service.getDealerOrderReadModel('CA51515151515151515151515151515151', {
            readPolicy: 'snapshot_first',
            fallbackDealerOrder: { status: 'awaiting_confirmation', orderId: 'DO-SNAPSHOT', items: [{ sku: 'A' }, { sku: 'B' }] },
        });

        expect(result).toEqual(expect.objectContaining({
            ok: true,
            readPolicy: 'snapshot_first',
            source: 'fallback',
            fallbackUsed: true,
            dealerOrder: expect.objectContaining({ orderId: 'DO-SNAPSHOT' }),
            parity: expect.objectContaining({ ok: false }),
        }));
        expect(Repository.getState).toHaveBeenCalledWith('CA51515151515151515151515151515151', 'dealer-orders');
        expect(telemetry.emit).toHaveBeenCalledWith('workflow_dark_read_mismatch', expect.objectContaining({
            readPolicy: 'snapshot_first',
            source: 'fallback',
            fallbackUsed: true,
            workflowStatePresent: true,
            fallbackPresent: true,
            mismatchFields: expect.arrayContaining(['status', 'orderId', 'itemCount']),
        }));
    });

    test('snapshot-first policy ignores empty snapshot fallback when workflow state is useful', async () => {
        Repository.getState.mockResolvedValue({
            id: 510,
            stateJson: { status: 'confirmed', orderId: 'DO-WF-510', confirmed: true, items: [{ sku: 'A' }] },
        });

        const result = await service.getDealerOrderReadModel('CA51051051051051051051051051051051', {
            readPolicy: 'snapshot_first',
            fallbackDealerOrder: {},
        });

        expect(result).toEqual(expect.objectContaining({
            ok: true,
            readPolicy: 'snapshot_first',
            source: 'workflow_state',
            fallbackUsed: false,
            dealerOrder: expect.objectContaining({ orderId: 'DO-WF-510' }),
        }));
        expect(telemetry.emit).toHaveBeenCalledWith('workflow_dark_read_compared', expect.objectContaining({
            readPolicy: 'snapshot_first',
            source: 'workflow_state',
            workflowStatePresent: true,
            fallbackPresent: false,
            workflowReadSkipped: false,
        }));
    });

    test('can disable workflow dealer-order reads for rollback', async () => {
        const result = await service.getDealerOrderReadModel('CA52525252525252525252525252525252', {
            readPolicy: 'workflow_disabled',
            fallbackDealerOrder: { status: 'confirmed', orderId: 'DO-52' },
        });

        expect(result).toEqual(expect.objectContaining({
            ok: true,
            readPolicy: 'workflow_disabled',
            source: 'fallback',
            fallbackUsed: true,
            workflowReadSkipped: true,
            workflowState: null,
            parity: null,
            dealerOrder: expect.objectContaining({ orderId: 'DO-52' }),
        }));
        expect(Repository.getState).not.toHaveBeenCalled();
        expect(telemetry.emit).toHaveBeenCalledWith('workflow_dark_read_compared', expect.objectContaining({
            readPolicy: 'workflow_disabled',
            source: 'fallback',
            workflowReadSkipped: true,
            workflowStatePresent: false,
            fallbackPresent: true,
        }));
    });

    test('normalizes invalid dealer-order read policies to workflow first', async () => {
        Repository.getState.mockResolvedValue({
            id: 53,
            stateJson: { status: 'confirmed', orderId: 'DO-53' },
        });

        const result = await service.getDealerOrderReadModel('CA53535353535353535353535353535353', {
            readPolicy: 'surprise-mode',
            fallbackDealerOrder: { status: 'awaiting_confirmation', orderId: 'DO-FALLBACK-53' },
        });

        expect(service.normalizeDealerOrderReadPolicy('snapshot-first')).toBe('snapshot_first');
        expect(result).toEqual(expect.objectContaining({
            readPolicy: 'workflow_first',
            source: 'workflow_state',
            fallbackUsed: false,
            dealerOrder: expect.objectContaining({ orderId: 'DO-53' }),
        }));
    });

    test('falls back to legacy dealer-order snapshot when workflow state is unavailable', async () => {
        const err = new Error("Table 'voicebot.call_workflow_states' doesn't exist");
        err.code = 'ER_NO_SUCH_TABLE';
        Repository.getState.mockRejectedValue(err);

        const result = await service.getDealerOrderReadModel('CA66666666666666666666666666666666', {
            fallbackDealerOrder: { status: 'confirmed', orderId: 'DO-6' },
        });

        expect(result).toEqual(expect.objectContaining({
            ok: true,
            source: 'fallback',
            fallbackUsed: true,
            dealerOrder: expect.objectContaining({ orderId: 'DO-6' }),
            error: 'ER_NO_SUCH_TABLE',
        }));
    });

    test('does not promote an empty workflow row over legacy dealer-order data', async () => {
        Repository.getState.mockResolvedValue({ id: 8, stateJson: {} });

        const result = await service.getDealerOrderReadModel('CA88888888888888888888888888888888', {
            fallbackDealerOrder: { status: 'confirmed', orderId: 'DO-8' },
        });

        expect(result).toEqual(expect.objectContaining({
            source: 'fallback',
            fallbackUsed: true,
            dealerOrder: expect.objectContaining({ orderId: 'DO-8' }),
        }));
    });

    test('identifies dealer-order parity mismatches by summary field', () => {
        const parity = service.compareDealerOrderParity(
            { status: 'confirmed', orderId: 'DO-7', confirmed: true, items: [{ sku: 'A' }] },
            { status: 'confirmed', orderId: 'DO-7', confirmed: true, items: [{ sku: 'A' }, { sku: 'B' }] }
        );

        expect(parity.ok).toBe(false);
        expect(parity.mismatches).toEqual([expect.objectContaining({ field: 'itemCount', workflowValue: 1, fallbackValue: 2 })]);
    });

    test('emits mismatch telemetry without raw parity values', async () => {
        Repository.getState.mockResolvedValue({
            id: 9,
            stateJson: { status: 'confirmed', orderId: 'DO-9', confirmed: true, items: [{ sku: 'A' }] },
        });

        const result = await service.getDealerOrderReadModel('CA99999999999999999999999999999999', {
            fallbackDealerOrder: { status: 'confirmed', orderId: 'DO-9', confirmed: true, items: [{ sku: 'A' }, { sku: 'B' }] },
        });

        expect(result.parity.ok).toBe(false);
        expect(telemetry.emit).toHaveBeenCalledWith('workflow_dark_read_mismatch', expect.objectContaining({
            workflowId: 'dealer-orders',
            mismatchCount: 1,
            mismatchFields: ['itemCount'],
            callIdHash: expect.stringMatching(/^[a-f0-9]{16}$/),
        }));
        const mismatchPayload = telemetry.emit.mock.calls.find(call => call[0] === 'workflow_dark_read_mismatch')[1];
        expect(mismatchPayload).not.toHaveProperty('workflowValue');
        expect(mismatchPayload).not.toHaveProperty('fallbackValue');
    });
});