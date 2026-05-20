'use strict';

function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
    return value;
}

const WORKFLOW_MIGRATIONS = deepFreeze({
    '013_workflow_action_outbox': {
        id: '013_workflow_action_outbox',
        file: 'migrations/013_workflow_action_outbox.sql',
        tables: {
            workflow_action_outbox: ['id', 'workflowId', 'actionType', 'idempotencyKey', 'payloadJson', 'resultJson', 'status', 'attemptCount', 'availableAt', 'lockedAt'],
        },
    },
    '014_call_workflow_state_events': {
        id: '014_call_workflow_state_events',
        file: 'migrations/014_call_workflow_state_events.sql',
        tables: {
            call_workflow_states: ['id', 'callSID', 'workflowId', 'status', 'stateJson', 'summaryJson'],
            call_workflow_events: ['id', 'callSID', 'workflowId', 'eventType', 'idempotencyKey', 'eventJson'],
        },
    },
});

const WORKFLOW_PLATFORM_TELEMETRY_EVENTS = deepFreeze([
    'workflow_readiness_checked',
    'workflow_dark_read_compared',
    'workflow_dark_read_mismatch',
    'workflow_reconciliation_audit',
    'workflow_reconciliation_requeue_completed',
    'workflow_release_evidence_checked',
]);

const WORKFLOW_MANIFEST = deepFreeze([
    {
        workflowId: 'dealer-orders',
        version: 1,
        owner: 'sales-operations',
        rollbackOwner: 'sales-operations',
        runbook: 'docs/workflow-operations-runbook.md',
        domainRunbook: 'docs/dealer-order-persona.md',
        actions: [
            {
                actionType: 'dealer_order_submit',
                handlerName: 'handleDealerOrderSubmit',
                payloadVersion: 1,
                idempotencyKey: 'dealer_order_submit:sha256(callId|orderId|itemSummary)',
                requiredMigrations: ['013_workflow_action_outbox', '014_call_workflow_state_events'],
                telemetryEvents: [
                    'dealer_order_items_captured',
                    'dealer_order_confirmed',
                    'dealer_order_skipped',
                    'dealer_order_erp_logged',
                    'dealer_order_erp_failed',
                    'dealer_order_notification_sent',
                    'dealer_order_notification_failed',
                    'action_outbox_enqueued',
                    'action_outbox_claimed',
                    'action_outbox_completed',
                    'action_outbox_failed',
                    'action_outbox_duplicate',
                    'action_outbox_requeued',
                ],
                parser: { status: 'required', module: 'Helper/dealerOrderParser.js' },
                classifier: { status: 'required', module: 'services/dealerOrderConversationWorkflow.js', export: 'handleDealerOrderTurn' },
                actionGuard: { status: 'required', module: 'transactions/actionGuard.js', export: 'evaluateDealerOrderActionGuard' },
                sideEffectOwner: 'services/dealerOrderService.js',
            },
        ],
    },
    {
        workflowId: 'booking-link-delivery',
        version: 1,
        owner: 'sales-operations',
        rollbackOwner: 'sales-operations',
        runbook: 'docs/workflow-operations-runbook.md',
        domainRunbook: 'docs/persona-bot-creation-runbook.md',
        actions: [
            {
                actionType: 'booking_link_deliver',
                handlerName: 'handleBookingLinkDeliver',
                payloadVersion: 1,
                idempotencyKey: 'booking_link_deliver:sha256(callId|linkHash|channel|destinationHash)',
                requiredMigrations: ['013_workflow_action_outbox', '014_call_workflow_state_events'],
                telemetryEvents: [
                    'booking_link_requested',
                    'booking_link_delivery_attempted',
                    'booking_link_delivery_sent',
                    'booking_link_delivery_failed',
                    'booking_link_sent',
                    'booking_link_failed',
                    'action_outbox_enqueued',
                    'action_outbox_claimed',
                    'action_outbox_completed',
                    'action_outbox_failed',
                    'action_outbox_duplicate',
                    'action_outbox_requeued',
                ],
                parser: { status: 'not_applicable', reason: 'Delivery actions are triggered after booking intent is already captured by the session workflow.' },
                classifier: { status: 'required', module: 'services/workflowOrchestrationService.js', export: 'handleBookingLinkRequested' },
                actionGuard: { status: 'required', module: 'services/bookingDeliveryProvider.js', export: 'resolveBookingDeliveryConfig' },
                sideEffectOwner: 'services/bookingDeliveryProvider.js',
            },
        ],
    },
    {
        workflowId: 'handover-followup',
        version: 1,
        owner: 'sales-operations',
        rollbackOwner: 'sales-operations',
        runbook: 'docs/workflow-operations-runbook.md',
        domainRunbook: 'docs/persona-bot-creation-runbook.md',
        actions: [
            {
                actionType: 'handover_followup_send',
                handlerName: 'handleHandoverFollowupSend',
                payloadVersion: 1,
                idempotencyKey: 'handover_followup_send:sha256(callId|attemptId|reason|transferStatus)',
                requiredMigrations: ['013_workflow_action_outbox', '014_call_workflow_state_events'],
                telemetryEvents: [
                    'handover_triggered',
                    'transfer_request_failed',
                    'action_outbox_enqueued',
                    'action_outbox_claimed',
                    'action_outbox_completed',
                    'action_outbox_failed',
                    'action_outbox_duplicate',
                    'action_outbox_requeued',
                ],
                parser: { status: 'not_applicable', reason: 'This workflow is system-triggered from handover transfer outcomes.' },
                classifier: { status: 'not_applicable', reason: 'The session handover path is the source event.' },
                actionGuard: { status: 'not_applicable', reason: 'The existing handover fallback path only sends the configured follow-up email payload.' },
                sideEffectOwner: 'Helper/emailHelper.js',
            },
        ],
    },
]);

function listWorkflowContracts() {
    return WORKFLOW_MANIFEST;
}

function listWorkflowActions() {
    return WORKFLOW_MANIFEST.flatMap(workflow => workflow.actions.map(action => ({
        workflowId: workflow.workflowId,
        workflowVersion: workflow.version,
        owner: workflow.owner,
        rollbackOwner: workflow.rollbackOwner,
        runbook: workflow.runbook,
        domainRunbook: workflow.domainRunbook,
        ...action,
    })));
}

function getWorkflowContract(workflowId) {
    return WORKFLOW_MANIFEST.find(workflow => workflow.workflowId === workflowId) || null;
}

function getWorkflowActionContract(actionType) {
    return listWorkflowActions().find(action => action.actionType === actionType) || null;
}

function getRequiredMigrationContracts() {
    const ids = new Set();
    for (const action of listWorkflowActions()) {
        for (const migrationId of action.requiredMigrations || []) ids.add(migrationId);
    }
    return [...ids].map(id => WORKFLOW_MIGRATIONS[id]).filter(Boolean);
}

function getRequiredWorkflowTables() {
    const tables = {};
    for (const migration of getRequiredMigrationContracts()) {
        for (const [tableName, columns] of Object.entries(migration.tables || {})) {
            tables[tableName] = [...new Set([...(tables[tableName] || []), ...columns])];
        }
    }
    return tables;
}

function summarizeWorkflowManifest() {
    const actions = listWorkflowActions();
    return {
        workflowCount: WORKFLOW_MANIFEST.length,
        actionCount: actions.length,
        requiredMigrations: getRequiredMigrationContracts().map(migration => migration.id),
        platformTelemetryEvents: [...WORKFLOW_PLATFORM_TELEMETRY_EVENTS],
        workflows: WORKFLOW_MANIFEST.map(workflow => ({
            workflowId: workflow.workflowId,
            version: workflow.version,
            owner: workflow.owner,
            rollbackOwner: workflow.rollbackOwner,
            runbook: workflow.runbook,
            actionTypes: workflow.actions.map(action => action.actionType),
        })),
    };
}

module.exports = {
    WORKFLOW_MANIFEST,
    WORKFLOW_MIGRATIONS,
    WORKFLOW_PLATFORM_TELEMETRY_EVENTS,
    getRequiredMigrationContracts,
    getRequiredWorkflowTables,
    getWorkflowActionContract,
    getWorkflowContract,
    listWorkflowActions,
    listWorkflowContracts,
    summarizeWorkflowManifest,
};