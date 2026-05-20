'use strict';

const crypto = require('crypto');
const db = require('../services/db');

function hash(value) {
    return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function truncate(value, maxLength) {
    if (value == null) return null;
    const text = String(value);
    return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function parseJsonColumn(value) {
    if (value == null) return null;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(value);
    } catch (_) {
        return null;
    }
}

function normalizeStateRow(row) {
    if (!row) return null;
    return {
        ...row,
        stateJson: parseJsonColumn(row.stateJson),
        summaryJson: parseJsonColumn(row.summaryJson),
    };
}

function normalizeEventRow(row) {
    if (!row) return null;
    return {
        ...row,
        eventJson: parseJsonColumn(row.eventJson),
    };
}

function buildEventIdempotencyKey(data = {}) {
    const raw = [
        data.workflowId || 'unknown',
        data.callSID || data.callId || 'none',
        data.eventType || 'unknown',
        data.discriminator || data.eventId || JSON.stringify(data.event || data.eventJson || {}),
    ].join('|');
    return `workflow_event:${hash(raw).slice(0, 48)}`;
}

async function getState(callSID, workflowId) {
    if (!callSID || !workflowId) return null;
    const rows = await db.query(
        'SELECT * FROM call_workflow_states WHERE callSID = ? AND workflowId = ? LIMIT 1',
        [callSID, workflowId]
    );
    return normalizeStateRow(rows?.[0] || null);
}

async function upsertState(data = {}) {
    const callSID = truncate(data.callSID || data.callId, 128);
    const workflowId = truncate(data.workflowId, 100);
    if (!callSID) throw new Error('workflow_state_call_id_required');
    if (!workflowId) throw new Error('workflow_state_workflow_id_required');

    const version = Math.max(1, Number.parseInt(data.version || '1', 10) || 1);
    const stateJson = JSON.stringify(data.state || data.stateJson || {});
    const summaryJson = data.summary || data.summaryJson ? JSON.stringify(data.summary || data.summaryJson) : null;

    await db.query(
        `INSERT INTO call_workflow_states
         (callSID, workflowId, status, version, stateJson, summaryJson)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
             status = VALUES(status),
             version = GREATEST(version, VALUES(version)),
             stateJson = VALUES(stateJson),
             summaryJson = VALUES(summaryJson),
             updatedAt = CURRENT_TIMESTAMP`,
        [
            callSID,
            workflowId,
            truncate(data.status, 64),
            version,
            stateJson,
            summaryJson,
        ]
    );

    return getState(callSID, workflowId);
}

async function getEventByIdempotencyKey(idempotencyKey) {
    if (!idempotencyKey) return null;
    const rows = await db.query(
        'SELECT * FROM call_workflow_events WHERE idempotencyKey = ? LIMIT 1',
        [idempotencyKey]
    );
    return normalizeEventRow(rows?.[0] || null);
}

async function appendEvent(data = {}) {
    const callSID = truncate(data.callSID || data.callId, 128);
    const workflowId = truncate(data.workflowId, 100);
    const eventType = truncate(data.eventType, 100);
    const idempotencyKey = truncate(data.idempotencyKey || buildEventIdempotencyKey(data), 190);
    if (!callSID) throw new Error('workflow_event_call_id_required');
    if (!workflowId) throw new Error('workflow_event_workflow_id_required');
    if (!eventType) throw new Error('workflow_event_type_required');

    const result = await db.query(
        `INSERT INTO call_workflow_events
         (callSID, workflowId, eventType, idempotencyKey, eventJson)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
             id = LAST_INSERT_ID(id)`,
        [
            callSID,
            workflowId,
            eventType,
            idempotencyKey,
            JSON.stringify(data.event || data.eventJson || {}),
        ]
    );

    const event = await getEventByIdempotencyKey(idempotencyKey);
    return event ? { ...event, _duplicateSuppressed: result?.affectedRows === 2 } : null;
}

async function listEvents(callSID, workflowId, { limit = 100 } = {}) {
    if (!callSID || !workflowId) return [];
    const rows = await db.query(
        `SELECT * FROM call_workflow_events
         WHERE callSID = ? AND workflowId = ?
         ORDER BY id ASC
         LIMIT ?`,
        [callSID, workflowId, Math.max(1, Number(limit) || 100)]
    );
    return (rows || []).map(normalizeEventRow);
}

module.exports = {
    appendEvent,
    buildEventIdempotencyKey,
    getEventByIdempotencyKey,
    getState,
    listEvents,
    upsertState,
};