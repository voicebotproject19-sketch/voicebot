'use strict';

describe('workflowActionOutboxService', () => {
    let Repository;
    let submitDealerOrder;
    let bookingDeliveryProvider;
    let sendHandoverEmail;
    let workflowState;
    let telemetry;
    let service;

    beforeEach(() => {
        jest.resetModules();
        Repository = {
            enqueueAction: jest.fn(),
            claimAction: jest.fn(),
            claimDueActions: jest.fn(),
            markActionCompleted: jest.fn(),
            markActionFailed: jest.fn(),
            requeueAction: jest.fn(),
        };
        submitDealerOrder = jest.fn();
        bookingDeliveryProvider = {
            normalizeDeliveryTarget: jest.fn(),
            resolveBookingDeliveryConfig: jest.fn(),
            sendBookingLinkChannel: jest.fn(),
        };
        sendHandoverEmail = jest.fn();
        workflowState = {
            appendWorkflowEvent: jest.fn().mockResolvedValue({ ok: true }),
            createWorkflowEventIdempotencyKey: jest.fn(({ callSID, workflowId, eventType, discriminator }) => (
                `${callSID}:${workflowId}:${eventType}:${discriminator}`
            )),
        };
        telemetry = { emit: jest.fn() };
        jest.doMock('../repositories/WorkflowActionOutboxRepository', () => Repository);
        jest.doMock('../services/dealerOrderService', () => ({ submitDealerOrder }));
        jest.doMock('../services/bookingDeliveryProvider', () => bookingDeliveryProvider);
        jest.doMock('../Helper/emailHelper', () => ({ sendHandoverEmail }));
        jest.doMock('../services/workflowStateService', () => workflowState);
        jest.doMock('../Utils/telemetry', () => telemetry);
        service = require('../services/workflowActionOutboxService');
    });

    afterEach(() => {
        service.stop();
    });

    test('creates stable dealer-order idempotency keys', () => {
        const first = service.createDealerOrderIdempotencyKey({
            callId: 'CA11111111111111111111111111111111',
            orderId: 'DO-20260509-ABCDEF',
            itemSummary: '10 filters',
        });
        const second = service.createDealerOrderIdempotencyKey({
            callId: 'CA11111111111111111111111111111111',
            orderId: 'DO-20260509-ABCDEF',
            itemSummary: '10 filters',
        });

        expect(first).toBe(second);
        expect(first).toMatch(/^dealer_order_submit:[a-f0-9]{48}$/);
    });

    test('enqueues then claims and executes dealer order action', async () => {
        Repository.enqueueAction.mockResolvedValue({ id: 12, status: 'queued' });
        Repository.claimAction.mockResolvedValue({
            id: 12,
            callSID: 'CA11111111111111111111111111111111',
            workflowId: 'dealer-orders',
            actionType: 'dealer_order_submit',
            status: 'processing',
            payloadJson: { order: { orderId: 'DO-1', items: [] } },
        });
        submitDealerOrder.mockResolvedValue({
            erp: { status: 'sent', externalOrderId: 'ERP-1' },
            notifications: { ok: true, sentChannels: ['email'] },
        });
        Repository.markActionCompleted.mockResolvedValue({ id: 12, status: 'completed' });

        const result = await service.enqueueAndProcessDealerOrderSubmission({
            callId: 'CA11111111111111111111111111111111',
            orderId: 'DO-1',
            itemSummary: '10 filters',
            items: [],
        }, { allowed: true, failures: [] });

        expect(result.ok).toBe(true);
        expect(Repository.enqueueAction).toHaveBeenCalledWith(expect.objectContaining({
            workflowId: 'dealer-orders',
            actionType: 'dealer_order_submit',
            idempotencyKey: expect.stringMatching(/^dealer_order_submit:/),
        }));
        expect(Repository.claimAction).toHaveBeenCalledWith(12, expect.objectContaining({ lockId: expect.any(String) }));
        expect(submitDealerOrder).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'DO-1' }));
        expect(Repository.markActionCompleted).toHaveBeenCalledWith(12, expect.objectContaining({
            erp: expect.objectContaining({ status: 'sent' }),
        }));
        expect(telemetry.emit).toHaveBeenCalledWith('action_outbox_completed', expect.objectContaining({ actionId: 12 }));
    });

    test('suppresses duplicate already-completed actions', async () => {
        Repository.enqueueAction.mockResolvedValue({
            id: 15,
            status: 'completed',
            resultJson: { erp: { status: 'sent' }, notifications: { ok: true, sentChannels: ['email'] } },
        });

        const result = await service.enqueueAndProcessDealerOrderSubmission({
            callId: 'CA22222222222222222222222222222222',
            orderId: 'DO-2',
            itemSummary: '4 pads',
        }, { allowed: true, failures: [] });

        expect(result).toEqual(expect.objectContaining({ ok: true, status: 'already_completed' }));
        expect(result.result).toEqual(expect.objectContaining({
            erp: expect.objectContaining({ status: 'sent' }),
        }));
        expect(Repository.claimAction).not.toHaveBeenCalled();
        expect(submitDealerOrder).not.toHaveBeenCalled();
        expect(telemetry.emit).toHaveBeenCalledWith('action_outbox_duplicate', expect.objectContaining({ actionId: 15 }));
    });

    test('treats action owned by another worker as already processing', async () => {
        Repository.claimAction.mockResolvedValue({
            id: 18,
            status: 'processing',
            actionType: 'dealer_order_submit',
            workflowId: 'dealer-orders',
            _claimedByWorker: false,
        });

        const result = await service.processActionById(18, { lockId: 'test-worker' });

        expect(result).toEqual(expect.objectContaining({ ok: true, status: 'already_processing' }));
        expect(submitDealerOrder).not.toHaveBeenCalled();
        expect(Repository.markActionCompleted).not.toHaveBeenCalled();
        expect(Repository.markActionFailed).not.toHaveBeenCalled();
    });

    test('processes due worker actions with claim telemetry', async () => {
        Repository.claimDueActions.mockResolvedValueOnce([{
            id: 19,
            callSID: 'CA19191919191919191919191919191919',
            workflowId: 'dealer-orders',
            actionType: 'dealer_order_submit',
            status: 'processing',
            payloadJson: { order: { orderId: 'DO-19' } },
        }]);
        submitDealerOrder.mockResolvedValue({
            erp: { status: 'sent' },
            notifications: { ok: true, sentChannels: ['email'] },
        });
        Repository.markActionCompleted.mockResolvedValue({ id: 19, status: 'completed' });

        const results = await service.processDueActions({ limit: 1, lockId: 'background-worker' });

        expect(results).toEqual([expect.objectContaining({ ok: true })]);
        expect(Repository.claimDueActions).toHaveBeenCalledWith(expect.objectContaining({
            limit: 1,
            lockId: 'background-worker',
        }));
        expect(telemetry.emit).toHaveBeenCalledWith('action_outbox_claimed', expect.objectContaining({
            actionId: 19,
            callId: 'CA19191919191919191919191919191919',
        }));
        expect(telemetry.emit).toHaveBeenCalledWith('action_outbox_completed', expect.objectContaining({
            actionId: 19,
        }));
    });

    test('marks failed action for retry without throwing', async () => {
        Repository.claimAction.mockResolvedValue({
            id: 20,
            callSID: 'CA33333333333333333333333333333333',
            workflowId: 'dealer-orders',
            actionType: 'dealer_order_submit',
            status: 'processing',
            payloadJson: { order: { orderId: 'DO-3' } },
        });
        submitDealerOrder.mockRejectedValue(new Error('erp_down'));
        Repository.markActionFailed.mockResolvedValue({ id: 20, status: 'retry' });

        const result = await service.processActionById(20, { lockId: 'test-worker', retryDelayMs: 1000 });

        expect(result.ok).toBe(false);
        expect(Repository.markActionFailed).toHaveBeenCalledWith(20, expect.any(Error), expect.objectContaining({ retryDelayMs: 1000 }));
        expect(telemetry.emit).toHaveBeenCalledWith('action_outbox_failed', expect.objectContaining({
            actionId: 20,
            status: 'retry',
            reason: 'erp_down',
        }));
    });

    test('routes unsupported action types through retry/dead-letter failure path', async () => {
        Repository.markActionFailed.mockResolvedValue({ id: 21, status: 'dead_letter' });

        const result = await service.processAction({
            id: 21,
            callSID: 'CA21212121212121212121212121212121',
            workflowId: 'unknown-workflow',
            actionType: 'unknown_action',
            status: 'processing',
            payloadJson: {},
        }, { retryDelayMs: 1000 });

        expect(result.ok).toBe(false);
        expect(Repository.markActionFailed).toHaveBeenCalledWith(21, expect.objectContaining({
            message: 'unsupported_action_type',
        }), expect.objectContaining({ retryDelayMs: 1000 }));
        expect(telemetry.emit).toHaveBeenCalledWith('action_outbox_failed', expect.objectContaining({
            actionId: 21,
            actionType: 'unknown_action',
            status: 'dead_letter',
        }));
    });

    test('requeues actions through repository and emits operator telemetry', async () => {
        Repository.requeueAction.mockResolvedValue({
            id: 62,
            callSID: 'CA62626262626262626262626262626262',
            workflowId: 'dealer-orders',
            actionType: 'dealer_order_submit',
            status: 'queued',
            _requeued: true,
        });

        const result = await service.requeueWorkflowAction(62, { reason: 'manual_retry', lockTimeoutSeconds: 45, auditId: 'workflow-reconciliation:test-audit' });

        expect(result).toEqual(expect.objectContaining({ ok: true }));
        expect(Repository.requeueAction).toHaveBeenCalledWith(62, expect.objectContaining({
            reason: 'manual_retry',
            lockTimeoutSeconds: 45,
        }));
        expect(telemetry.emit).toHaveBeenCalledWith('action_outbox_requeued', expect.objectContaining({
            actionId: 62,
            workflowId: 'dealer-orders',
            actionType: 'dealer_order_submit',
            reason: 'manual_retry',
            auditId: 'workflow-reconciliation:test-audit',
        }));
        expect(workflowState.appendWorkflowEvent).toHaveBeenCalledWith(expect.objectContaining({
            workflowId: 'dealer-orders',
            eventType: 'action_outbox_requeued',
            event: expect.objectContaining({ auditId: 'workflow-reconciliation:test-audit' }),
        }));
    });

    test('does not requeue completed or otherwise non-requeueable actions', async () => {
        Repository.requeueAction.mockResolvedValue({
            id: 63,
            workflowId: 'dealer-orders',
            actionType: 'dealer_order_submit',
            status: 'completed',
            _requeued: false,
        });

        const result = await service.requeueWorkflowAction(63, { reason: 'manual_retry' });

        expect(result).toEqual(expect.objectContaining({
            ok: false,
            reason: 'action_not_requeueable:completed',
        }));
        expect(telemetry.emit).not.toHaveBeenCalledWith('action_outbox_requeued', expect.any(Object));
        expect(workflowState.appendWorkflowEvent).not.toHaveBeenCalledWith(expect.objectContaining({
            eventType: 'action_outbox_requeued',
        }));
    });

    test('creates stable booking-link delivery idempotency keys per destination channel', () => {
        const first = service.createBookingLinkDeliveryIdempotencyKey({
            callId: 'CA44444444444444444444444444444444',
            linkHash: 'link-hash-1',
            channel: 'sms',
            destinationHash: 'dest-hash-1',
        });
        const second = service.createBookingLinkDeliveryIdempotencyKey({
            callId: 'CA44444444444444444444444444444444',
            linkHash: 'link-hash-1',
            channel: 'sms',
            destinationHash: 'dest-hash-1',
        });
        const differentChannel = service.createBookingLinkDeliveryIdempotencyKey({
            callId: 'CA44444444444444444444444444444444',
            linkHash: 'link-hash-1',
            channel: 'email',
            destinationHash: 'dest-hash-1',
        });

        expect(first).toBe(second);
        expect(first).toMatch(/^booking_link_deliver:[a-f0-9]{48}$/);
        expect(differentChannel).not.toBe(first);
    });

    test('creates stable handover follow-up idempotency keys', () => {
        const first = service.createHandoverFollowupIdempotencyKey({
            callId: 'CA88888888888888888888888888888888',
            attemptId: 'handover-1',
            reason: 'caller_requested',
            transferStatus: 'request_failed',
        });
        const second = service.createHandoverFollowupIdempotencyKey({
            callId: 'CA88888888888888888888888888888888',
            attemptId: 'handover-1',
            reason: 'caller_requested',
            transferStatus: 'request_failed',
        });

        expect(first).toBe(second);
        expect(first).toMatch(/^handover_followup_send:[a-f0-9]{48}$/);
    });

    test('enqueues then claims and executes handover follow-up action', async () => {
        Repository.enqueueAction.mockResolvedValue({ id: 71, status: 'queued' });
        Repository.claimAction.mockResolvedValue({
            id: 71,
            callSID: 'CA71717171717171717171717171717171',
            workflowId: 'handover-followup',
            actionType: 'handover_followup_send',
            status: 'processing',
            payloadJson: { followup: { callerName: 'Sarah', notificationEmail: 'ops@example.com' } },
        });
        sendHandoverEmail.mockResolvedValue(true);
        Repository.markActionCompleted.mockResolvedValue({ id: 71, status: 'completed' });

        const result = await service.enqueueAndProcessHandoverFollowup({
            callId: 'CA71717171717171717171717171717171',
            attemptId: 'handover-71',
            followup: { callerName: 'Sarah', notificationEmail: 'ops@example.com' },
        }, { lockId: 'test-worker' });

        expect(result.ok).toBe(true);
        expect(Repository.enqueueAction).toHaveBeenCalledWith(expect.objectContaining({
            workflowId: 'handover-followup',
            actionType: 'handover_followup_send',
            idempotencyKey: expect.stringMatching(/^handover_followup_send:/),
        }));
        expect(Repository.claimAction).toHaveBeenCalledWith(71, expect.objectContaining({ lockId: 'test-worker' }));
        expect(sendHandoverEmail).toHaveBeenCalledWith(expect.objectContaining({ callerName: 'Sarah' }));
        expect(Repository.markActionCompleted).toHaveBeenCalledWith(71, expect.objectContaining({ status: 'sent' }));
    });

    test('enqueues and processes booking-link delivery actions per channel', async () => {
        const callId = 'CA55555555555555555555555555555555';
        const baseConfig = {
            enabled: true,
            order: ['sms', 'email'],
            smsEnabled: true,
            emailEnabled: true,
            whatsappEnabled: false,
        };
        bookingDeliveryProvider.resolveBookingDeliveryConfig.mockReturnValue(baseConfig);
        bookingDeliveryProvider.normalizeDeliveryTarget.mockImplementation((channel) => ({
            ok: true,
            channel,
            destinationHash: `${channel}-hash`,
            targetSource: channel === 'email' ? 'email' : 'callerNumber',
        }));
        Repository.enqueueAction
            .mockResolvedValueOnce({
                id: 31,
                callSID: callId,
                workflowId: 'booking-link-delivery',
                actionType: 'booking_link_deliver',
                status: 'queued',
                payloadJson: { delivery: { channel: 'sms', destinationHash: 'sms-hash' } },
            })
            .mockResolvedValueOnce({
                id: 32,
                callSID: callId,
                workflowId: 'booking-link-delivery',
                actionType: 'booking_link_deliver',
                status: 'queued',
                payloadJson: { delivery: { channel: 'email', destinationHash: 'email-hash' } },
            });
        Repository.claimAction
            .mockResolvedValueOnce({
                id: 31,
                callSID: callId,
                workflowId: 'booking-link-delivery',
                actionType: 'booking_link_deliver',
                status: 'processing',
                payloadJson: { delivery: { context: { callId }, channel: 'sms', contact: { bookingDeliveryEnabled: true } } },
            })
            .mockResolvedValueOnce({
                id: 32,
                callSID: callId,
                workflowId: 'booking-link-delivery',
                actionType: 'booking_link_deliver',
                status: 'processing',
                payloadJson: { delivery: { context: { callId }, channel: 'email', contact: { bookingDeliveryEnabled: true } } },
            });
        bookingDeliveryProvider.sendBookingLinkChannel
            .mockResolvedValueOnce({ channel: 'sms', ok: true, status: 'sent', messageProvider: 'twilio', destinationHash: 'sms-hash' })
            .mockResolvedValueOnce({ channel: 'email', ok: true, status: 'sent', messageProvider: 'smtp', destinationHash: 'email-hash' });
        Repository.markActionCompleted
            .mockResolvedValueOnce({ id: 31, callSID: callId, workflowId: 'booking-link-delivery', actionType: 'booking_link_deliver', status: 'completed' })
            .mockResolvedValueOnce({ id: 32, callSID: callId, workflowId: 'booking-link-delivery', actionType: 'booking_link_deliver', status: 'completed' });

        const result = await service.enqueueAndProcessBookingLinkDelivery({
            callId,
            callerNumber: '+14155551234',
            userEmail: 'jane@example.com',
            bookingUrl: 'https://book.example.com/demo',
            linkHash: 'booking-link-hash',
            contact: { bookingDeliveryEnabled: true },
            phoneConsent: true,
        }, { lockId: 'test-worker' });

        expect(result).toEqual(expect.objectContaining({
            ok: true,
            status: 'sent',
            sentChannels: ['sms', 'email'],
        }));
        expect(Repository.enqueueAction).toHaveBeenCalledTimes(2);
        expect(Repository.enqueueAction).toHaveBeenNthCalledWith(1, expect.objectContaining({
            workflowId: 'booking-link-delivery',
            actionType: 'booking_link_deliver',
            idempotencyKey: expect.stringMatching(/^booking_link_deliver:/),
        }));
        expect(Repository.claimAction).toHaveBeenCalledWith(31, expect.objectContaining({ lockId: 'test-worker' }));
        expect(Repository.claimAction).toHaveBeenCalledWith(32, expect.objectContaining({ lockId: 'test-worker' }));
        expect(bookingDeliveryProvider.sendBookingLinkChannel).toHaveBeenCalledWith(expect.objectContaining({ callId }), 'sms', expect.objectContaining({ enabled: true }));
        expect(bookingDeliveryProvider.sendBookingLinkChannel).toHaveBeenCalledWith(expect.objectContaining({ callId }), 'email', expect.objectContaining({ enabled: true }));
        expect(Repository.markActionCompleted).toHaveBeenCalledTimes(2);
    });

    test('does not resend already-completed booking-link actions', async () => {
        const callId = 'CA66666666666666666666666666666666';
        bookingDeliveryProvider.resolveBookingDeliveryConfig.mockReturnValue({
            enabled: true,
            order: ['email'],
            smsEnabled: false,
            emailEnabled: true,
            whatsappEnabled: false,
        });
        bookingDeliveryProvider.normalizeDeliveryTarget.mockReturnValue({
            ok: true,
            channel: 'email',
            destinationHash: 'email-hash',
            targetSource: 'email',
        });
        Repository.enqueueAction.mockResolvedValue({
            id: 41,
            callSID: callId,
            workflowId: 'booking-link-delivery',
            actionType: 'booking_link_deliver',
            status: 'completed',
            payloadJson: { delivery: { channel: 'email', destinationHash: 'email-hash' } },
            resultJson: { attempt: { channel: 'email', ok: true, status: 'sent', messageProvider: 'smtp', destinationHash: 'email-hash' } },
        });

        const result = await service.enqueueAndProcessBookingLinkDelivery({
            callId,
            userEmail: 'jane@example.com',
            bookingUrl: 'https://book.example.com/demo',
            linkHash: 'booking-link-hash',
            contact: { bookingDeliveryEnabled: true },
        });

        expect(result.ok).toBe(true);
        expect(result.sentChannels).toEqual(['email']);
        expect(Repository.claimAction).not.toHaveBeenCalled();
        expect(bookingDeliveryProvider.sendBookingLinkChannel).not.toHaveBeenCalled();
        expect(telemetry.emit).toHaveBeenCalledWith('action_outbox_duplicate', expect.objectContaining({
            actionId: 41,
            actionType: 'booking_link_deliver',
        }));
    });

    test('failed booking-link channel is marked for retry and returned as failed attempt', async () => {
        const callId = 'CA77777777777777777777777777777777';
        bookingDeliveryProvider.resolveBookingDeliveryConfig.mockReturnValue({
            enabled: true,
            order: ['sms'],
            smsEnabled: true,
            emailEnabled: true,
            whatsappEnabled: false,
        });
        bookingDeliveryProvider.normalizeDeliveryTarget.mockReturnValue({
            ok: true,
            channel: 'sms',
            destinationHash: 'sms-hash',
            targetSource: 'callerNumber',
        });
        Repository.enqueueAction.mockResolvedValue({
            id: 51,
            callSID: callId,
            workflowId: 'booking-link-delivery',
            actionType: 'booking_link_deliver',
            status: 'queued',
            payloadJson: { delivery: { channel: 'sms', destinationHash: 'sms-hash' } },
        });
        Repository.claimAction.mockResolvedValue({
            id: 51,
            callSID: callId,
            workflowId: 'booking-link-delivery',
            actionType: 'booking_link_deliver',
            status: 'processing',
            payloadJson: { delivery: { context: { callId }, channel: 'sms', contact: { bookingDeliveryEnabled: true } } },
        });
        bookingDeliveryProvider.sendBookingLinkChannel.mockResolvedValue({
            channel: 'sms',
            ok: false,
            status: 'failed',
            failureReason: 'provider_api_error',
            destinationHash: 'sms-hash',
        });
        Repository.markActionFailed.mockResolvedValue({
            id: 51,
            callSID: callId,
            workflowId: 'booking-link-delivery',
            actionType: 'booking_link_deliver',
            status: 'retry',
            payloadJson: { delivery: { channel: 'sms', destinationHash: 'sms-hash' } },
        });

        const result = await service.enqueueAndProcessBookingLinkDelivery({
            callId,
            callerNumber: '+14155551234',
            bookingUrl: 'https://book.example.com/demo',
            linkHash: 'booking-link-hash',
            contact: { bookingDeliveryEnabled: true },
            phoneConsent: true,
        }, { retryDelayMs: 1000 });

        expect(result).toEqual(expect.objectContaining({ ok: false, status: 'failed', sentChannels: [] }));
        expect(result.attempts).toEqual([expect.objectContaining({
            channel: 'sms',
            ok: false,
            failureReason: 'provider_api_error',
        })]);
        expect(Repository.markActionFailed).toHaveBeenCalledWith(51, expect.objectContaining({
            message: 'provider_api_error',
            resultPayload: expect.objectContaining({ attempt: expect.objectContaining({ channel: 'sms' }) }),
        }), expect.objectContaining({ retryDelayMs: 1000 }));
    });
});