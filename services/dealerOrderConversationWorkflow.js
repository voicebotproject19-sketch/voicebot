'use strict';

const {
    createDealerOrderId,
    extractOrderItems,
    formatOrderItems,
    hasOrderReplacementIntent,
    isOrderConfirmation,
    isOrderSkip,
    mergeOrderItems,
} = require('../Helper/dealerOrderParser');
const { evaluateDealerOrderActionGuard } = require('../transactions/actionGuard');
const telemetry = require('../Utils/telemetry');

function handleDealerOrderTurn(adapter, userText) {
    const state = adapter._ensureDealerOrderState();
    if (!state || state.confirmed || state.skipped) return null;

    const parsedItems = extractOrderItems(userText);
    if (parsedItems.length) {
        state.items = hasOrderReplacementIntent(userText)
            ? parsedItems
            : mergeOrderItems(state.items, parsedItems);
        state.awaitingConfirmation = true;
        state.status = 'awaiting_confirmation';
        state.lastSummary = formatOrderItems(state.items);
        telemetry.emit('dealer_order_items_captured', {
            callId: adapter.callSID,
            itemCount: state.items.length,
            awaitingConfirmation: true,
            ts: Date.now()
        });
        adapter.emit('dealer_order_items_captured', {
            callId: adapter.callSID,
            items: state.items,
            itemSummary: state.lastSummary,
            status: state.status,
            awaitingConfirmation: true,
            ts: Date.now(),
        });
        return {
            purpose: 'dealer_order_summary',
            text: `I have ${state.lastSummary}. Should I place this order now?`,
        };
    }

    if (state.awaitingConfirmation && isOrderConfirmation(userText)) {
        const guard = evaluateDealerOrderActionGuard({
            explicitConfirmationReceived: true,
            numericRepetitionReceived: adapter._hasDealerOrderNumericRecap(state),
            sttConfidence: adapter._lastSttConfidence,
            interactionMode: adapter._currentInteractionMode || 'INTERACTIVE',
            interrupted: adapter._isDealerOrderActionInterrupted(),
            backendAuthoritativeOk: true,
        }, adapter._phase4Profile);

        if (!guard.allowed) {
            state.status = 'awaiting_confirmation';
            state.lastGuardFailures = guard.failures;
            telemetry.emit('transaction_policy_blocked', {
                callId: adapter.callSID,
                actionType: 'dealer_order_submit',
                failures: guard.failures,
                ts: Date.now()
            });
            return {
                purpose: 'dealer_order_confirmation_guard',
                text: `I want to make sure I got that right. I have ${formatOrderItems(state.items)}. Please repeat the quantities, then say yes to place the order.`,
            };
        }

        state.awaitingConfirmation = false;
        state.confirmed = true;
        state.status = 'confirmed';
        state.confirmedAt = new Date().toISOString();
        state.orderId = state.orderId || createDealerOrderId();
        adapter.conversationPhase = 'success';

        const payload = {
            callId: adapter.callSID,
            orderId: state.orderId,
            items: state.items,
            itemSummary: formatOrderItems(state.items),
            dealerName: state.crmContext?.dealerName || adapter.name || null,
            dealerEmail: state.crmContext?.dealerEmail || adapter.userEmail || null,
            dealerPhone: adapter.userPhone || adapter.recipient || null,
            callerNumber: adapter.recipient || null,
            personaId: adapter.persona?.id || null,
            crmContext: state.crmContext || {},
            contextHint: adapter.callContextHint || null,
            confirmedAt: state.confirmedAt,
            explicitConfirmationReceived: true,
            numericRepetitionReceived: guard.policyInput.numericRepetitionReceived,
            sttConfidence: guard.policyInput.sttConfidence,
            interactionMode: guard.policyInput.interactionMode,
            interrupted: guard.policyInput.interrupted,
            actionGuard: {
                allowed: guard.allowed,
                failures: guard.failures,
                evaluatedAt: guard.evaluatedAt,
            },
        };
        telemetry.emit('dealer_order_confirmed', {
            callId: adapter.callSID,
            orderId: state.orderId,
            itemCount: state.items.length,
            ts: Date.now()
        });
        adapter.emit('dealer_order_confirmed', payload);

        return {
            purpose: 'dealer_order_confirmation',
            text: `Confirmed. Your order ID is ${state.orderId}: ${payload.itemSummary}. You'll receive the details by SMS or email shortly. Have a great day.`,
            closeAfterMs: 7000,
        };
    }

    if (state.awaitingConfirmation && isOrderSkip(userText)) {
        state.awaitingConfirmation = false;
        state.skipped = true;
        state.status = 'skipped';
        adapter.conversationPhase = 'rejected';
        telemetry.emit('dealer_order_skipped', {
            callId: adapter.callSID,
            itemCount: state.items.length,
            ts: Date.now()
        });
        adapter.emit('dealer_order_skipped', {
            callId: adapter.callSID,
            items: state.items,
            dealerName: state.crmContext?.dealerName || adapter.name || null,
        });
        return {
            purpose: 'dealer_order_skipped',
            text: 'No problem, we will skip this order run. You can use the self-service link anytime. Have a great day.',
            closeAfterMs: 5000,
        };
    }

    if (state.awaitingConfirmation) {
        return {
            purpose: 'dealer_order_confirmation_prompt',
            text: `I have ${formatOrderItems(state.items)}. Please say yes to place it, change it, or skip.`,
        };
    }

    if (isOrderSkip(userText)) {
        state.skipped = true;
        state.status = 'skipped';
        adapter.conversationPhase = 'rejected';
        telemetry.emit('dealer_order_skipped', {
            callId: adapter.callSID,
            itemCount: 0,
            ts: Date.now()
        });
        return {
            purpose: 'dealer_order_skipped',
            text: 'No problem, we will skip this order run. Have a great day.',
            closeAfterMs: 5000,
        };
    }

    return null;
}

module.exports = { handleDealerOrderTurn };