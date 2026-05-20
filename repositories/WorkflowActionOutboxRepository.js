'use strict';

const crypto = require('crypto');
const db = require('../services/db');

const CLAIMABLE_STATUSES = ['queued', 'retry'];
const REQUEUEABLE_STATUSES = ['retry', 'failed', 'dead_letter'];

const CLAIMABLE_ACTION_WHERE = `
            (
                (status IN ('queued', 'retry') AND availableAt <= CURRENT_TIMESTAMP(3))
                OR (status = 'processing' AND lockedAt IS NOT NULL AND lockedAt < DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL ? SECOND))
            )
            AND (lockedAt IS NULL OR lockedAt < DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL ? SECOND))
`;

const STALE_PROCESSING_WHERE = `status = 'processing' AND lockedAt IS NOT NULL AND lockedAt < DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL ? SECOND)`;

function hashPayload(payload) {
    return crypto.createHash('sha256').update(JSON.stringify(payload || {})).digest('hex');
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

function normalizeActionRow(row) {
    if (!row) return null;
    return {
        ...row,
        payloadJson: parseJsonColumn(row.payloadJson),
        resultJson: parseJsonColumn(row.resultJson),
    };
}

async function getActionById(id) {
    if (!id) return null;
    const rows = await db.query(
        'SELECT * FROM workflow_action_outbox WHERE id = ? LIMIT 1',
        [id]
    );
    return normalizeActionRow(rows?.[0] || null);
}

async function getActionByIdempotencyKey(idempotencyKey) {
    if (!idempotencyKey) return null;
    const rows = await db.query(
        'SELECT * FROM workflow_action_outbox WHERE idempotencyKey = ? LIMIT 1',
        [idempotencyKey]
    );
    return normalizeActionRow(rows?.[0] || null);
}

async function enqueueAction(action = {}) {
    const payload = action.payload || action.payloadJson || {};
    const idempotencyKey = truncate(action.idempotencyKey, 190);
    if (!idempotencyKey) throw new Error('workflow_action_idempotency_key_required');
    if (!action.workflowId) throw new Error('workflow_action_workflow_id_required');
    if (!action.actionType) throw new Error('workflow_action_type_required');

    const sql = `
    INSERT INTO workflow_action_outbox
    (callSID, workflowId, actionType, idempotencyKey, payloadJson, payloadHash, status, availableAt, maxAttempts)
    VALUES (?, ?, ?, ?, ?, ?, 'queued', COALESCE(?, CURRENT_TIMESTAMP(3)), ?)
    ON DUPLICATE KEY UPDATE
        id = LAST_INSERT_ID(id),
        updatedAt = CURRENT_TIMESTAMP
    `;

    await db.query(sql, [
        truncate(action.callSID || action.callId, 128),
        truncate(action.workflowId, 100),
        truncate(action.actionType, 100),
        idempotencyKey,
        JSON.stringify(payload),
        action.payloadHash || hashPayload(payload),
        action.availableAt || null,
        Math.max(1, Number.parseInt(action.maxAttempts || '3', 10) || 3),
    ]);

    return getActionByIdempotencyKey(idempotencyKey);
}

async function claimAction(id, { lockId, lockTimeoutSeconds = 120 } = {}) {
    if (!id) return null;
    const owner = truncate(lockId || `worker-${process.pid}`, 100);
    const sql = `
    UPDATE workflow_action_outbox
    SET status = 'processing', lockedAt = CURRENT_TIMESTAMP(3), lockedBy = ?, attemptCount = attemptCount + 1, updatedAt = CURRENT_TIMESTAMP
    WHERE id = ?
          AND ${CLAIMABLE_ACTION_WHERE}
    `;
    const lockTimeout = Math.max(1, Number(lockTimeoutSeconds) || 120);
    const result = await db.query(sql, [owner, id, lockTimeout, lockTimeout]);
    const action = await getActionById(id);
    if (!action) return null;
    return { ...action, _claimedByWorker: result?.affectedRows !== 0 };
}

async function claimDueActions({ limit = 5, lockId, lockTimeoutSeconds = 120 } = {}) {
    const rows = await db.query(
        `SELECT id FROM workflow_action_outbox
         WHERE ${CLAIMABLE_ACTION_WHERE}
         ORDER BY availableAt ASC, id ASC
         LIMIT ?`,
        [
            Math.max(1, Number(lockTimeoutSeconds) || 120),
            Math.max(1, Number(lockTimeoutSeconds) || 120),
            Math.max(1, Number(limit) || 5),
        ]
    );

    const claimed = [];
    for (const row of rows || []) {
        const action = await claimAction(row.id, { lockId, lockTimeoutSeconds });
        if (action?.status === 'processing' && action._claimedByWorker !== false) claimed.push(action);
    }
    return claimed;
}

async function markActionCompleted(id, resultPayload = {}) {
    if (!id) return null;
    await db.query(
        `UPDATE workflow_action_outbox
         SET status = 'completed', resultJson = ?, lockedAt = NULL, lockedBy = NULL, lastError = NULL,
             completedAt = CURRENT_TIMESTAMP(3), updatedAt = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [JSON.stringify(resultPayload || {}), id]
    );
    return getActionById(id);
}

async function markActionFailed(id, error, { retryDelayMs = 30000 } = {}) {
    if (!id) return null;
    const message = truncate(error?.message || error || 'workflow_action_failed', 512);
    const resultPayload = error?.resultPayload == null ? null : JSON.stringify(error.resultPayload);
    const retryDelaySeconds = Math.max(1, Math.ceil((Number(retryDelayMs) || 30000) / 1000));
    await db.query(
        `UPDATE workflow_action_outbox
         SET status = CASE WHEN attemptCount >= maxAttempts THEN 'dead_letter' ELSE 'retry' END,
             availableAt = DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL ? SECOND),
             resultJson = COALESCE(?, resultJson),
             lockedAt = NULL,
             lockedBy = NULL,
             lastError = ?,
             updatedAt = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [retryDelaySeconds, resultPayload, message, id]
    );
    return getActionById(id);
}

async function requeueAction(id, { reason = 'operator_requeue', availableAt = null, lockTimeoutSeconds = 120 } = {}) {
    if (!id) return null;
    const lockTimeout = Math.max(1, Number(lockTimeoutSeconds) || 120);
    const message = truncate(reason || 'operator_requeue', 512);
    const result = await db.query(
        `UPDATE workflow_action_outbox
         SET status = 'queued',
             availableAt = COALESCE(?, CURRENT_TIMESTAMP(3)),
             lockedAt = NULL,
             lockedBy = NULL,
             lastError = ?,
             updatedAt = CURRENT_TIMESTAMP
         WHERE id = ?
           AND (
               status IN ('retry', 'failed', 'dead_letter')
               OR (${STALE_PROCESSING_WHERE})
           )`,
        [availableAt, message, id, lockTimeout]
    );
    const action = await getActionById(id);
    if (!action) return null;
    return { ...action, _requeued: result?.affectedRows !== 0 };
}

async function listActionStatusCounts({ workflowId = null, actionType = null, staleLockSeconds = 120 } = {}) {
    const lockTimeout = Math.max(1, Number(staleLockSeconds) || 120);
    const rows = await db.query(
        `SELECT workflowId, actionType, status,
                COUNT(*) AS count,
                MIN(availableAt) AS oldestAvailableAt,
                MIN(lockedAt) AS oldestLockedAt,
                MIN(CASE WHEN status = 'retry' THEN availableAt ELSE NULL END) AS oldestRetryAvailableAt,
                MIN(CASE WHEN status = 'dead_letter' THEN updatedAt ELSE NULL END) AS oldestDeadLetterAt,
                MIN(CASE WHEN ${STALE_PROCESSING_WHERE} THEN lockedAt ELSE NULL END) AS oldestStaleLockedAt,
                SUM(CASE WHEN ${STALE_PROCESSING_WHERE} THEN 1 ELSE 0 END) AS staleProcessingCount
         FROM workflow_action_outbox
         WHERE (? IS NULL OR workflowId = ?)
           AND (? IS NULL OR actionType = ?)
         GROUP BY workflowId, actionType, status
         ORDER BY workflowId ASC, actionType ASC, status ASC`,
        [lockTimeout, lockTimeout, workflowId, workflowId, actionType, actionType]
    );
    return (rows || []).map(row => ({
        workflowId: row.workflowId,
        actionType: row.actionType,
        status: row.status,
        count: Number(row.count) || 0,
        oldestAvailableAt: row.oldestAvailableAt || null,
        oldestLockedAt: row.oldestLockedAt || null,
        oldestRetryAvailableAt: row.oldestRetryAvailableAt || null,
        oldestDeadLetterAt: row.oldestDeadLetterAt || null,
        oldestStaleLockedAt: row.oldestStaleLockedAt || null,
        staleProcessingCount: Number(row.staleProcessingCount) || 0,
    }));
}

async function listActionSamples({ workflowId = null, actionType = null, statuses = [], limit = 20 } = {}) {
    const normalizedStatuses = Array.isArray(statuses)
        ? statuses.map(status => String(status || '').trim()).filter(Boolean)
        : [];
    if (!normalizedStatuses.length) return [];
    const placeholders = normalizedStatuses.map(() => '?').join(', ');
    const rows = await db.query(
        `SELECT id, callSID, workflowId, actionType, status, attemptCount, maxAttempts,
                availableAt, lockedAt, lockedBy, completedAt, lastError, createdAt, updatedAt
         FROM workflow_action_outbox
         WHERE status IN (${placeholders})
           AND (? IS NULL OR workflowId = ?)
           AND (? IS NULL OR actionType = ?)
         ORDER BY updatedAt DESC, id DESC
         LIMIT ?`,
        [
            ...normalizedStatuses,
            workflowId,
            workflowId,
            actionType,
            actionType,
            Math.max(1, Math.min(Number(limit) || 20, 100)),
        ]
    );
    return (rows || []).map(normalizeActionRow);
}

module.exports = {
    CLAIMABLE_STATUSES,
    REQUEUEABLE_STATUSES,
    claimAction,
    claimDueActions,
    enqueueAction,
    getActionById,
    getActionByIdempotencyKey,
    hashPayload,
    listActionSamples,
    listActionStatusCounts,
    markActionCompleted,
    markActionFailed,
    requeueAction,
};