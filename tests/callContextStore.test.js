'use strict';

describe('CallContextStore', () => {
    let mockGetContext;
    let mockRegistryGet;
    let mockRegistryCreate;
    let mockRegistryUpdate;
    let mockEmit;
    let mockGetDealerOrderReadModel;

    beforeEach(() => {
        jest.resetModules();
        mockGetContext = jest.fn();
        mockRegistryGet = jest.fn(() => null);
        mockRegistryCreate = jest.fn((callSID, data) => ({ callId: callSID, ...data, status: 'active' }));
        mockRegistryUpdate = jest.fn();
        mockEmit = jest.fn();
        mockGetDealerOrderReadModel = jest.fn(async (_callSID, options = {}) => ({
            ok: true,
            source: 'fallback',
            fallbackUsed: true,
            dealerOrder: options.fallbackDealerOrder || null,
        }));

        jest.doMock('../repositories/CallContextRepository', () => ({
            getContext: mockGetContext,
            upsertInitialContext: jest.fn().mockResolvedValue([]),
            patchContext: jest.fn().mockResolvedValue([])
        }));
        jest.doMock('../services/CallRegistry', () => ({
            get: mockRegistryGet,
            create: mockRegistryCreate,
            update: mockRegistryUpdate
        }));
        jest.doMock('../services/workflowStateService', () => ({
            getDealerOrderReadModel: mockGetDealerOrderReadModel,
        }));
        jest.doMock('../Utils/telemetry', () => ({ emit: mockEmit }));
    });

    test('hydrates missing CallRegistry state from durable context snapshot', async () => {
        mockGetContext.mockResolvedValueOnce({
            callSID: 'CA11111111111111111111111111111111',
            provider: 'twilio',
            phoneNumber: '+14155550111',
            name: 'Alex',
            persona: 'company-sales',
            language: 'en',
            aiProvider: 'azure-realtime',
            contextHint: 'human',
            policyConfig: { interruptionMinMs: 250 },
            requireExplicitRecordingConsent: true,
            bookingStatus: 'sent',
            dealerOrder: {
                status: 'awaiting_confirmation',
                items: [{ productName: 'engine oil', quantity: 10, unit: 'cases' }]
            }
        });
        const CallContextStore = require('../services/CallContextStore');

        const hydrated = await CallContextStore.hydrateCallRegistry('CA11111111111111111111111111111111', {
            recipient: '+14155550999'
        });

        expect(hydrated).toEqual(expect.objectContaining({
            callId: 'CA11111111111111111111111111111111',
            provider: 'twilio',
            recipient: '+14155550111',
            persona: 'company-sales',
            language: 'en',
            aiProvider: 'azure-realtime',
            contextHint: 'human',
            policyConfig: { interruptionMinMs: 250 },
            requireExplicitRecordingConsent: true,
            bookingStatus: 'sent',
            dealerOrder: expect.objectContaining({ status: 'awaiting_confirmation' })
        }));
        expect(mockRegistryCreate).toHaveBeenCalledWith('CA11111111111111111111111111111111', expect.objectContaining({
            provider: 'twilio',
            persona: 'company-sales',
            language: 'en',
            aiProvider: 'azure-realtime',
            dealerOrder: expect.objectContaining({ status: 'awaiting_confirmation' })
        }));
        expect(mockRegistryUpdate).toHaveBeenCalledWith('CA11111111111111111111111111111111', expect.objectContaining({
            provider: 'twilio',
            persona: 'company-sales',
            language: 'en',
            aiProvider: 'azure-realtime'
        }));
        expect(mockEmit).toHaveBeenCalledWith('call_context_hydrated', expect.objectContaining({
            callId: 'CA11111111111111111111111111111111',
            provider: 'twilio'
        }));
    });

    test('hydrates dealer order from workflow read model when available', async () => {
        mockGetContext.mockResolvedValueOnce({
            callSID: 'CA22222222222222222222222222222222',
            provider: 'plivo',
            phoneNumber: '+14155550222',
            dealerOrder: { status: 'awaiting_confirmation' }
        });
        mockGetDealerOrderReadModel.mockResolvedValueOnce({
            ok: true,
            source: 'workflow_state',
            fallbackUsed: false,
            dealerOrder: { status: 'confirmed', orderId: 'DO-22' },
        });
        const CallContextStore = require('../services/CallContextStore');

        const hydrated = await CallContextStore.hydrateCallRegistry('CA22222222222222222222222222222222');

        expect(hydrated.dealerOrder).toEqual(expect.objectContaining({ status: 'confirmed', orderId: 'DO-22' }));
        expect(mockGetDealerOrderReadModel).toHaveBeenCalledWith('CA22222222222222222222222222222222', {
            fallbackDealerOrder: expect.objectContaining({ status: 'awaiting_confirmation' }),
        });
        expect(mockRegistryCreate).toHaveBeenCalledWith('CA22222222222222222222222222222222', expect.objectContaining({
            dealerOrder: expect.objectContaining({ orderId: 'DO-22' }),
        }));
    });

    test('keeps snapshot dealer order when workflow read model falls back after missing schema', async () => {
        mockGetContext.mockResolvedValueOnce({
            callSID: 'CA33333333333333333333333333333333',
            provider: 'twilio',
            phoneNumber: '+14155550333',
            dealerOrder: { status: 'confirmed', orderId: 'DO-33' }
        });
        mockGetDealerOrderReadModel.mockResolvedValueOnce({
            ok: true,
            source: 'fallback',
            fallbackUsed: true,
            readPolicy: 'workflow_first',
            error: 'ER_NO_SUCH_TABLE',
            dealerOrder: { status: 'confirmed', orderId: 'DO-33' },
        });
        const CallContextStore = require('../services/CallContextStore');

        const hydrated = await CallContextStore.hydrateCallRegistry('CA33333333333333333333333333333333');

        expect(hydrated.dealerOrder).toEqual(expect.objectContaining({ status: 'confirmed', orderId: 'DO-33' }));
        expect(mockGetDealerOrderReadModel).toHaveBeenCalledWith('CA33333333333333333333333333333333', {
            fallbackDealerOrder: expect.objectContaining({ orderId: 'DO-33' }),
        });
        expect(mockRegistryCreate).toHaveBeenCalledWith('CA33333333333333333333333333333333', expect.objectContaining({
            dealerOrder: expect.objectContaining({ orderId: 'DO-33' }),
        }));
    });

    test('does not erase snapshot dealer order when workflow read model has no useful row', async () => {
        mockGetContext.mockResolvedValueOnce({
            callSID: 'CA44444444444444444444444444444444',
            provider: 'plivo',
            phoneNumber: '+14155550444',
            dealerOrder: { status: 'awaiting_confirmation', orderId: 'DO-44' }
        });
        mockGetDealerOrderReadModel.mockResolvedValueOnce({
            ok: true,
            source: 'fallback',
            fallbackUsed: true,
            readPolicy: 'workflow_first',
            dealerOrder: { status: 'awaiting_confirmation', orderId: 'DO-44' },
            workflowState: { id: 44, stateJson: {} },
        });
        const CallContextStore = require('../services/CallContextStore');

        const hydrated = await CallContextStore.hydrateCallRegistry('CA44444444444444444444444444444444');

        expect(hydrated.dealerOrder).toEqual(expect.objectContaining({ status: 'awaiting_confirmation', orderId: 'DO-44' }));
        expect(mockRegistryCreate).toHaveBeenCalledWith('CA44444444444444444444444444444444', expect.objectContaining({
            dealerOrder: expect.objectContaining({ orderId: 'DO-44' }),
        }));
    });
});
