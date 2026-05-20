'use strict';

const fs = require('fs');
const path = require('path');

describe('workflowManifest', () => {
    let manifest;
    let handlers;
    let EVENTS;
    const root = path.resolve(__dirname, '..');

    beforeAll(() => {
        manifest = require('../services/workflowManifest');
        handlers = require('../services/workflowActionHandlers');
        EVENTS = require('../Utils/telemetryEvents');
    });

    test('declares every registered workflow action', () => {
        const actions = manifest.listWorkflowActions();
        const actionTypes = new Set(actions.map(action => action.actionType));

        for (const actionType of handlers.defaultWorkflowActionHandlers.keys()) {
            expect(actionTypes.has(actionType)).toBe(true);
        }
        expect(actionTypes).toEqual(new Set([
            'dealer_order_submit',
            'booking_link_deliver',
            'handover_followup_send',
        ]));
    });

    test('references known telemetry events, migrations, and runbooks', () => {
        for (const action of manifest.listWorkflowActions()) {
            expect(action.workflowId).toEqual(expect.any(String));
            expect(action.workflowVersion).toBeGreaterThanOrEqual(1);
            expect(action.handlerName).toEqual(expect.any(String));
            expect(action.idempotencyKey).toContain(action.actionType);
            expect(handlers[action.handlerName]).toBe(handlers.defaultWorkflowActionHandlers.get(action.actionType));
            expect(fs.existsSync(path.join(root, action.runbook))).toBe(true);

            const runbook = fs.readFileSync(path.join(root, action.runbook), 'utf8');
            expect(runbook).toContain(action.workflowId);
            expect(runbook).toContain(action.actionType);

            for (const migrationId of action.requiredMigrations) {
                const migration = manifest.WORKFLOW_MIGRATIONS[migrationId];
                expect(migration).toBeTruthy();
                expect(fs.existsSync(path.join(root, migration.file))).toBe(true);
            }
            for (const eventName of action.telemetryEvents) {
                expect(EVENTS.has(eventName)).toBe(true);
            }
            for (const fieldName of ['parser', 'classifier', 'actionGuard']) {
                expect(['required', 'not_applicable']).toContain(action[fieldName].status);
                if (action[fieldName].status === 'required') {
                    expect(fs.existsSync(path.join(root, action[fieldName].module))).toBe(true);
                } else {
                    expect(action[fieldName].reason).toEqual(expect.any(String));
                }
            }
        }
    });

    test('provides required table and manifest summaries for readiness', () => {
        expect(manifest.getRequiredWorkflowTables()).toEqual(expect.objectContaining({
            workflow_action_outbox: expect.arrayContaining(['id', 'workflowId', 'actionType', 'status']),
            call_workflow_states: expect.arrayContaining(['id', 'callSID', 'workflowId', 'stateJson']),
            call_workflow_events: expect.arrayContaining(['id', 'callSID', 'workflowId', 'eventType']),
        }));
        expect(manifest.summarizeWorkflowManifest()).toEqual(expect.objectContaining({
            workflowCount: 3,
            actionCount: 3,
            requiredMigrations: ['013_workflow_action_outbox', '014_call_workflow_state_events'],
            platformTelemetryEvents: expect.arrayContaining([
                'workflow_reconciliation_audit',
                'workflow_release_evidence_checked',
            ]),
        }));
    });
});