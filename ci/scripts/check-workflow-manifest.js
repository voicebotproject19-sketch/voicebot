'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const EVENTS = require(path.join(ROOT, 'Utils', 'telemetryEvents'));
const workflowManifest = require(path.join(ROOT, 'services', 'workflowManifest'));
const workflowActionHandlers = require(path.join(ROOT, 'services', 'workflowActionHandlers'));

const errors = [];

function fail(message) {
    errors.push(message);
}

function exists(relativePath) {
    return fs.existsSync(path.join(ROOT, relativePath));
}

function read(relativePath) {
    return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function validateApplicability(action, fieldName) {
    const value = action[fieldName] || {};
    if (!['required', 'not_applicable'].includes(value.status)) {
        fail(`${action.actionType} ${fieldName} must be required or not_applicable.`);
        return;
    }
    if (value.status === 'required' && !value.module) {
        fail(`${action.actionType} ${fieldName} is required but has no module.`);
    }
    if (value.status === 'required' && value.module && !exists(value.module)) {
        fail(`${action.actionType} ${fieldName} module does not exist: ${value.module}`);
    }
    if (value.status === 'not_applicable' && !value.reason) {
        fail(`${action.actionType} ${fieldName} is not_applicable but has no reason.`);
    }
}

const handlerRegistry = workflowActionHandlers.defaultWorkflowActionHandlers;
const manifestActions = workflowManifest.listWorkflowActions();
const manifestActionTypes = new Set(manifestActions.map(action => action.actionType));
const registryActionTypes = new Set(handlerRegistry.keys());

for (const actionType of registryActionTypes) {
    if (!manifestActionTypes.has(actionType)) {
        fail(`Handler action ${actionType} is missing workflow manifest metadata.`);
    }
}

for (const action of manifestActions) {
    const registeredHandler = handlerRegistry.get(action.actionType);
    if (!handlerRegistry.has(action.actionType)) {
        fail(`Manifest action ${action.actionType} has no registered handler.`);
    }
    if (!action.workflowId || !action.workflowVersion) {
        fail(`Manifest action ${action.actionType} is missing workflow identity metadata.`);
    }
    if (!action.handlerName) {
        fail(`Manifest action ${action.actionType} is missing handlerName.`);
    } else {
        const exportedHandler = workflowActionHandlers[action.handlerName];
        if (typeof exportedHandler !== 'function') {
            fail(`Manifest action ${action.actionType} handlerName ${action.handlerName} is not exported by services/workflowActionHandlers.js.`);
        } else if (registeredHandler && registeredHandler !== exportedHandler) {
            fail(`Manifest action ${action.actionType} handlerName ${action.handlerName} does not match the registered handler function.`);
        }
    }
    if (!action.idempotencyKey) {
        fail(`Manifest action ${action.actionType} is missing idempotencyKey documentation.`);
    }
    if (!exists(action.runbook)) {
        fail(`Manifest action ${action.actionType} runbook does not exist: ${action.runbook}`);
    } else {
        const runbook = read(action.runbook);
        if (!runbook.includes(action.workflowId)) {
            fail(`Runbook ${action.runbook} does not mention workflow ${action.workflowId}.`);
        }
        if (!runbook.includes(action.actionType)) {
            fail(`Runbook ${action.runbook} does not mention action ${action.actionType}.`);
        }
    }
    if (action.domainRunbook && !exists(action.domainRunbook)) {
        fail(`Manifest action ${action.actionType} domain runbook does not exist: ${action.domainRunbook}`);
    }
    for (const migrationId of action.requiredMigrations || []) {
        const migration = workflowManifest.WORKFLOW_MIGRATIONS[migrationId];
        if (!migration) {
            fail(`Manifest action ${action.actionType} references unknown migration ${migrationId}.`);
        } else if (!exists(migration.file)) {
            fail(`Manifest action ${action.actionType} migration file does not exist: ${migration.file}`);
        }
    }
    for (const eventName of action.telemetryEvents || []) {
        if (!EVENTS.has(eventName)) {
            fail(`Manifest action ${action.actionType} references unknown telemetry event ${eventName}.`);
        }
    }
    for (const fieldName of ['parser', 'classifier', 'actionGuard']) {
        validateApplicability(action, fieldName);
    }
}

for (const eventName of workflowManifest.WORKFLOW_PLATFORM_TELEMETRY_EVENTS) {
    if (!EVENTS.has(eventName)) {
        fail(`Workflow platform telemetry event ${eventName} is not in Utils/telemetryEvents.js.`);
    }
}

if (errors.length) {
    console.error('Workflow manifest validation failed:');
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
}

console.log(`Workflow manifest validation passed (${manifestActions.length} actions, ${workflowManifest.getRequiredMigrationContracts().length} migrations).`);