'use strict';

const db = require('../services/db');

const COLUMN_BY_KEY = Object.freeze({
    provider: 'provider',
    phoneNumber: 'phoneNumber',
    name: 'name',
    persona: 'persona',
    language: 'language',
    aiProvider: 'aiProvider',
    contextHint: 'contextHint',
    policyConfig: 'policyConfig',
    requireExplicitRecordingConsent: 'requireExplicitRecordingConsent',
    providerStatus: 'providerStatus',
    providerTerminal: 'providerTerminal',
    providerTerminalAt: 'providerTerminalAt',
    bookingStatus: 'bookingStatus',
    bookingProvider: 'bookingProvider',
    externalBookingId: 'externalBookingId',
    dealerOrder: 'dealerOrder'
});

function normalizeValue(key, value) {
    if (value === undefined) return undefined;
    if (key === 'policyConfig' || key === 'dealerOrder') {
        if (value == null) return null;
        if (typeof value === 'string') return value;
        return JSON.stringify(value);
    }
    if (key === 'requireExplicitRecordingConsent' || key === 'providerTerminal') return value ? 1 : 0;
    if (key === 'providerTerminalAt' && value != null) return value instanceof Date ? value : new Date(value);
    return value;
}

function buildPayload(data = {}) {
    const payload = {};
    for (const key of Object.keys(COLUMN_BY_KEY)) {
        const value = normalizeValue(key, data[key]);
        if (value !== undefined) payload[key] = value;
    }
    return payload;
}

function parseJsonColumn(value) {
    if (value == null || typeof value === 'object') return value || null;
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

async function upsertContext(callSID, data = {}) {
    if (!callSID) return null;
    const payload = buildPayload(data);
    const keys = Object.keys(payload);
    if (!keys.length) return null;

    const columns = ['callSID', ...keys.map(key => COLUMN_BY_KEY[key])];
    const values = [callSID, ...keys.map(key => payload[key])];
    const placeholders = columns.map(() => '?').join(', ');
    const updates = keys.map(key => `${COLUMN_BY_KEY[key]} = VALUES(${COLUMN_BY_KEY[key]})`).join(', ');

    const sql = `
    INSERT INTO call_context_snapshots (${columns.join(', ')})
    VALUES (${placeholders})
    ON DUPLICATE KEY UPDATE ${updates}
    `;

    return db.query(sql, values);
}

async function upsertInitialContext(callSID, context = {}) {
    return upsertContext(callSID, context);
}

async function patchContext(callSID, patch = {}) {
    return upsertContext(callSID, patch);
}

async function getContext(callSID) {
    if (!callSID) return null;
    const rows = await db.query(
        'SELECT * FROM call_context_snapshots WHERE callSID = ? LIMIT 1',
        [callSID]
    );
    const row = rows?.[0] || null;
    if (!row) return null;
    return {
        ...row,
        policyConfig: parseJsonColumn(row.policyConfig),
        dealerOrder: parseJsonColumn(row.dealerOrder),
        requireExplicitRecordingConsent: row.requireExplicitRecordingConsent === 1 || row.requireExplicitRecordingConsent === true,
        providerTerminal: row.providerTerminal === 1 || row.providerTerminal === true
    };
}

module.exports = { upsertInitialContext, patchContext, getContext };
