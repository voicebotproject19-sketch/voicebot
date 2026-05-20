'use strict';
const db = require('../services/db');

/**
 * Record a consent event (grant or revocation) for a phone number.
 * Always appends a new row — preserves full audit trail.
 */
async function recordConsent(phoneNumber, event, callSID = null, personaId = null) {
    const sql = `INSERT INTO consent_ledger (phoneNumber, event, callSID, personaId)
                 VALUES (?, ?, ?, ?)`;
    return db.query(sql, [phoneNumber, event, callSID || null, personaId || null]);
}

/**
 * Returns true if the most-recent consent event for this number is 'granted'.
 * Returns false if the most-recent event is 'revoked' OR if no record exists.
 */
async function hasValidConsent(phoneNumber) {
    const sql = `SELECT event FROM consent_ledger
                 WHERE phoneNumber = ?
                 ORDER BY createdAt DESC, id DESC
                 LIMIT 1`;
    const rows = await db.query(sql, [phoneNumber]);
    return rows.length > 0 && rows[0].event === 'granted';
}

/**
 * Append a 'revoked' event for a phone number.
 */
async function revokeConsent(phoneNumber, callSID = null, personaId = null) {
    return recordConsent(phoneNumber, 'revoked', callSID, personaId);
}

module.exports = { recordConsent, hasValidConsent, revokeConsent };
