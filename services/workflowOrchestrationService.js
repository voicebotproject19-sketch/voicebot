'use strict';

const CallRegistry = require('./CallRegistry');
const CallContextStore = require('./CallContextStore');
const workflowActionOutbox = require('./workflowActionOutboxService');
const workflowState = require('./workflowStateService');
const { buildBookingLink, resolveBookingProviderConfig } = require('./bookingLinkProvider');
const writeQueue = require('./writeQueue');
const { evaluateDealerOrderActionGuard } = require('../transactions/actionGuard');
const telemetry = require('../Utils/telemetry');

const DEALER_ORDER_WORKFLOW_ID = 'dealer-orders';

function buildDealerWorkflowSummary(order = {}) {
    return {
        orderId: order.orderId || null,
        itemCount: Array.isArray(order.items) ? order.items.length : 0,
        status: order.status || null,
        actionStatus: order.actionStatus || null,
        erpStatus: order.erpStatus || null,
        notificationStatus: order.notificationStatus || null,
    };
}

async function recordDealerWorkflowStep({ edgeSession, realtimeService }, eventType, event = {}) {
    if (!edgeSession?.callSID || !eventType) return null;
    const order = realtimeService?.dealerOrder || event.dealerOrder || {};
    const discriminator = event.discriminator
        || event.actionId
        || event.orderId
        || event.itemSummary
        || JSON.stringify(event.failures || event.items || event.status || eventType);
    return workflowState.recordWorkflowStep({
        callSID: edgeSession.callSID,
        workflowId: DEALER_ORDER_WORKFLOW_ID,
        eventType,
        idempotencyKey: workflowState.createWorkflowEventIdempotencyKey({
            callSID: edgeSession.callSID,
            workflowId: DEALER_ORDER_WORKFLOW_ID,
            eventType,
            discriminator,
        }),
        event: {
            connectionId: edgeSession.connectionId,
            ...event,
            ts: Date.now(),
        },
        state: order,
        status: order.status || event.status || null,
        summary: buildDealerWorkflowSummary(order),
    });
}

function patchDealerOrderState(edgeSession, realtimeService, fallback = null) {
    if (!edgeSession?.callSID) return;
    const dealerOrder = realtimeService?.dealerOrder || fallback;
    CallRegistry.update(edgeSession.callSID, { dealerOrder });
    CallContextStore.patchContext(edgeSession.callSID, { dealerOrder }).catch(() => {});
}

async function handleBookingLinkRequested({ edgeSession, provider, realtimeService, turnState, request = {} }) {
    if (turnState?.isClosed) return;
    if (realtimeService._bookingLinkSendInFlight || realtimeService.bookingLinkSent) return;

    realtimeService._bookingLinkSendInFlight = true;
    const personaId = realtimeService.persona?.id || request.persona || null;
    const contact = {
        ...(realtimeService.kb?.contact || realtimeService.persona?.contact || {}),
        personaId,
    };
    const config = resolveBookingProviderConfig(contact);
    const link = buildBookingLink({
        callId: edgeSession.callSID || request.callId,
        callerName: request.callerName || realtimeService.name,
        callerNumber: request.callerNumber || realtimeService.recipient,
        userEmail: request.userEmail || realtimeService.userEmail,
        userPhone: request.userPhone || realtimeService.userPhone,
        preferredSlot: request.preferredSlot || realtimeService.preferredSlot,
        personaId,
    }, config);

    try {
        if (!link.ok) {
            realtimeService.bookingLinkStatus = 'failed';
            realtimeService.bookingProvider = link.provider;
            telemetry.emit('booking_link_failed', {
                connectionId: edgeSession.connectionId,
                callId: edgeSession.callSID,
                provider: link.provider,
                reason: link.reason,
                ts: Date.now()
            });
            return;
        }

        realtimeService.bookingProvider = link.provider;
        realtimeService.bookingLinkUrl = link.url;
        realtimeService.bookingLinkStatus = 'delivery_pending';

        const delivery = await workflowActionOutbox.enqueueAndProcessBookingLinkDelivery({
            callId: edgeSession.callSID || request.callId,
            connectionId: edgeSession.connectionId,
            telecomProvider: provider.name,
            callerName: request.callerName || realtimeService.name,
            callerNumber: request.callerNumber || realtimeService.recipient,
            userPhone: request.userPhone || realtimeService.userPhone,
            userEmail: request.userEmail || realtimeService.userEmail,
            bookingUrl: link.url,
            bookingProvider: link.provider,
            linkHash: link.linkHash,
            preferredSlot: request.preferredSlot || realtimeService.preferredSlot,
            personaId,
            ccEmail: contact.bookingCcEmail || null,
            phoneConsent: !!(request.phoneConsent || realtimeService.bookingPhoneDeliveryConsent),
            phoneConsentTargetSource: request.phoneConsentTargetSource || realtimeService.bookingPhoneDeliveryTargetSource || 'caller',
            contact,
        }, {
            lockId: `session-${edgeSession.connectionId}`,
        });

        for (const attempt of delivery.attempts || []) {
            const payload = {
                connectionId: edgeSession.connectionId,
                callId: edgeSession.callSID,
                provider: link.provider,
                linkHash: link.linkHash,
                channel: attempt.channel,
                messageProvider: attempt.messageProvider || null,
                reason: attempt.failureReason || null,
                ts: Date.now()
            };
            telemetry.emit('booking_link_delivery_attempted', payload);
            telemetry.emit(attempt.ok ? 'booking_link_delivery_sent' : 'booking_link_delivery_failed', payload);

            const queued = writeQueue.enqueue({
                type: 'persist_booking_delivery_event',
                callSID: edgeSession.callSID || request.callId || null,
                bookingProvider: link.provider,
                linkHash: link.linkHash,
                channel: attempt.channel,
                messageProvider: attempt.messageProvider || null,
                destinationHash: attempt.destinationHash || null,
                externalMessageId: attempt.externalMessageId || null,
                status: attempt.ok ? 'sent' : 'failed',
                failureReason: attempt.failureReason || null,
            });
            if (!queued) {
                telemetry.emit('booking_link_delivery_failed', {
                    ...payload,
                    reason: 'write_queue_full',
                    ts: Date.now()
                });
            }
        }

        if (delivery.ok) {
            realtimeService.bookingLinkSent = true;
            realtimeService.bookingLinkStatus = 'sent';
            realtimeService.bookingDeliveryChannels = delivery.sentChannels || [];
            telemetry.emit('booking_link_sent', {
                connectionId: edgeSession.connectionId,
                callId: edgeSession.callSID,
                provider: link.provider,
                linkHash: link.linkHash,
                userEmailPresent: !!(request.userEmail || realtimeService.userEmail),
                phoneDeliveryPresent: !!(delivery.sentChannels || []).some(channel => channel === 'sms' || channel === 'whatsapp'),
                channels: delivery.sentChannels || [],
                ts: Date.now()
            });
        } else {
            realtimeService.bookingLinkStatus = 'failed';
            await handleHandoverFollowup({
                edgeSession,
                attemptId: request.attemptId || `booking-link-${link.linkHash || edgeSession.callSID || 'delivery-failed'}`,
                followup: {
                    callerName: request.callerName || realtimeService.name,
                    callerNumber: request.callerNumber || realtimeService.recipient,
                    userEmail: request.userEmail || realtimeService.userEmail,
                    userPhone: request.userPhone || realtimeService.userPhone,
                    preferredSlot: request.preferredSlot || realtimeService.preferredSlot,
                    reason: 'booking_link_delivery_failed',
                    persona: personaId,
                    notificationEmail: contact.notificationEmail || null,
                    ccEmail: contact.ccEmail || null,
                    transferAttempted: false,
                    transferFailed: false,
                    transferStatus: 'booking_link_delivery_failed',
                },
            });
            telemetry.emit('booking_link_failed', {
                connectionId: edgeSession.connectionId,
                callId: edgeSession.callSID,
                provider: link.provider,
                linkHash: link.linkHash,
                reason: 'delivery_failed',
                ts: Date.now()
            });
        }
    } catch (err) {
        realtimeService.bookingLinkStatus = 'failed';
        telemetry.emit('booking_provider_error', {
            connectionId: edgeSession.connectionId,
            callId: edgeSession.callSID,
            provider: link.provider || config.provider,
            message: err?.message || String(err),
            ts: Date.now()
        });
    } finally {
        realtimeService._bookingLinkSendInFlight = false;
    }
}

async function handleDealerOrderItemsCaptured({ edgeSession, realtimeService, turnState, request = {} }) {
    if (turnState?.isClosed) return;
    patchDealerOrderState(edgeSession, realtimeService, null);
    await recordDealerWorkflowStep({ edgeSession, realtimeService }, 'dealer_order_items_captured', {
        items: request.items || realtimeService.dealerOrder?.items || [],
        itemSummary: request.itemSummary || realtimeService.dealerOrder?.lastSummary || null,
        status: realtimeService.dealerOrder?.status || 'awaiting_confirmation',
    });
}

async function handleDealerOrderConfirmed({ edgeSession, realtimeService, turnState, request = {} }) {
    if (turnState?.isClosed) return;
    if (realtimeService._dealerOrderSubmitInFlight) return;
    realtimeService._dealerOrderSubmitInFlight = true;

    try {
        const actionRequest = {
            ...request,
            callId: edgeSession.callSID || request.callId,
            callerNumber: request.callerNumber || realtimeService.recipient,
            dealerName: request.dealerName || realtimeService.name,
            dealerPhone: request.dealerPhone || realtimeService.userPhone || realtimeService.recipient,
            dealerEmail: request.dealerEmail || realtimeService.userEmail,
            personaId: realtimeService.persona?.id || request.personaId || DEALER_ORDER_WORKFLOW_ID,
        };

        const guard = evaluateDealerOrderActionGuard({
            explicitConfirmationReceived: request.explicitConfirmationReceived === true,
            numericRepetitionReceived: request.numericRepetitionReceived === true,
            sttConfidence: request.sttConfidence,
            interactionMode: request.interactionMode || realtimeService._currentInteractionMode || 'INTERACTIVE',
            interrupted: request.interrupted === true,
            backendAuthoritativeOk: true,
            idempotencyKey: request.idempotencyKey || null,
        }, realtimeService._phase4Profile);

        if (!guard.allowed) {
            if (realtimeService.dealerOrder) {
                realtimeService.dealerOrder.status = 'blocked';
                realtimeService.dealerOrder.actionStatus = 'blocked';
                realtimeService.dealerOrder.guardFailures = guard.failures;
            }
            telemetry.emit('transaction_policy_blocked', {
                connectionId: edgeSession.connectionId,
                callId: edgeSession.callSID,
                actionType: 'dealer_order_submit',
                failures: guard.failures,
                ts: Date.now()
            });
            patchDealerOrderState(edgeSession, realtimeService, null);
            await recordDealerWorkflowStep({ edgeSession, realtimeService }, 'dealer_order_guard_blocked', {
                orderId: request.orderId || realtimeService.dealerOrder?.orderId || null,
                failures: guard.failures,
                status: 'blocked',
            });
            return;
        }

        await recordDealerWorkflowStep({ edgeSession, realtimeService }, 'dealer_order_confirmed', {
            orderId: actionRequest.orderId || realtimeService.dealerOrder?.orderId || null,
            items: actionRequest.items || realtimeService.dealerOrder?.items || [],
            itemSummary: actionRequest.itemSummary || null,
            status: 'confirmed',
        });

        const result = await workflowActionOutbox.enqueueAndProcessDealerOrderSubmission(actionRequest, guard, {
            lockId: `session-${edgeSession.connectionId}`,
        });

        if (realtimeService.dealerOrder) {
            realtimeService.dealerOrder.actionOutboxId = result.action?.id || null;
            realtimeService.dealerOrder.actionStatus = result.action?.status || (result.ok ? 'completed' : 'failed');
            realtimeService.dealerOrder.erpStatus = result.result?.erp?.status || (result.ok ? realtimeService.dealerOrder.erpStatus : 'failed');
            realtimeService.dealerOrder.erpExternalOrderId = result.result?.erp?.externalOrderId || realtimeService.dealerOrder.erpExternalOrderId || null;
            realtimeService.dealerOrder.notificationStatus = result.result?.notifications?.ok ? 'sent' : (result.ok ? realtimeService.dealerOrder.notificationStatus : 'failed');
            realtimeService.dealerOrder.notificationChannels = result.result?.notifications?.sentChannels || realtimeService.dealerOrder.notificationChannels || [];
        }

        patchDealerOrderState(edgeSession, realtimeService, null);
        await recordDealerWorkflowStep({ edgeSession, realtimeService }, result.ok ? 'dealer_order_outbox_completed' : 'dealer_order_outbox_failed', {
            orderId: actionRequest.orderId || realtimeService.dealerOrder?.orderId || null,
            actionId: result.action?.id || null,
            actionStatus: result.action?.status || null,
            erpStatus: realtimeService.dealerOrder?.erpStatus || null,
            notificationStatus: realtimeService.dealerOrder?.notificationStatus || null,
            status: realtimeService.dealerOrder?.status || 'confirmed',
        });
    } catch (err) {
        if (realtimeService.dealerOrder) {
            realtimeService.dealerOrder.actionStatus = 'failed';
            realtimeService.dealerOrder.erpStatus = 'failed';
            realtimeService.dealerOrder.notificationStatus = 'failed';
        }
        telemetry.emit('action_outbox_failed', {
            connectionId: edgeSession.connectionId,
            callId: edgeSession.callSID,
            workflowId: DEALER_ORDER_WORKFLOW_ID,
            actionType: 'dealer_order_submit',
            reason: err?.message || 'dealer_order_outbox_failed',
            ts: Date.now()
        });
        telemetry.emit('dealer_order_erp_failed', {
            connectionId: edgeSession.connectionId,
            callId: edgeSession.callSID,
            orderId: request.orderId || null,
            reason: err?.message || 'dealer_order_submit_failed',
            ts: Date.now()
        });
        await recordDealerWorkflowStep({ edgeSession, realtimeService }, 'dealer_order_outbox_failed', {
            orderId: request.orderId || realtimeService.dealerOrder?.orderId || null,
            reason: err?.message || 'dealer_order_submit_failed',
            status: realtimeService.dealerOrder?.status || 'failed',
        });
    } finally {
        realtimeService._dealerOrderSubmitInFlight = false;
    }
}

async function handleDealerOrderSkipped({ edgeSession, realtimeService, request = {} }) {
    const fallback = {
        status: 'skipped',
        skipped: true,
        items: request.items || [],
    };
    patchDealerOrderState(edgeSession, realtimeService, fallback);
    await recordDealerWorkflowStep({ edgeSession, realtimeService }, 'dealer_order_skipped', {
        items: request.items || realtimeService.dealerOrder?.items || [],
        status: 'skipped',
    });
}

async function handleHandoverFollowup({ edgeSession, attemptId, followup = {}, lockId = null } = {}) {
    return workflowActionOutbox.enqueueAndProcessHandoverFollowup({
        callId: edgeSession?.callSID || followup.callId || null,
        connectionId: edgeSession?.connectionId || followup.connectionId || null,
        attemptId: attemptId || followup.attemptId || null,
        followup,
    }, {
        lockId: lockId || `session-${edgeSession?.connectionId || 'handover'}`,
    });
}

function registerWorkflowEventHandlers({ edgeSession, provider, realtimeService, turnState }) {
    realtimeService.on('booking_link_requested', (request = {}) => handleBookingLinkRequested({ edgeSession, provider, realtimeService, turnState, request }));
    realtimeService.on('dealer_order_items_captured', (request = {}) => handleDealerOrderItemsCaptured({ edgeSession, realtimeService, turnState, request }));
    realtimeService.on('dealer_order_confirmed', (request = {}) => handleDealerOrderConfirmed({ edgeSession, realtimeService, turnState, request }));
    realtimeService.on('dealer_order_skipped', (request = {}) => handleDealerOrderSkipped({ edgeSession, realtimeService, request }));
    realtimeService.on('handover_followup', (request = {}) => handleHandoverFollowup({ edgeSession, attemptId: request.attemptId, followup: request.followup, lockId: request.lockId }));
}

module.exports = {
    buildDealerWorkflowSummary,
    handleBookingLinkRequested,
    handleDealerOrderConfirmed,
    handleHandoverFollowup,
    handleDealerOrderItemsCaptured,
    handleDealerOrderSkipped,
    patchDealerOrderState,
    recordDealerWorkflowStep,
    registerWorkflowEventHandlers,
};