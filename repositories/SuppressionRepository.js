'use strict';

const db = require('../services/db');

/**
 * Add a phone number to the suppression (DNC) list.
 * Uses INSERT IGNORE to avoid duplicates.
 */
async function addSuppression(phoneNumber, reason = 'caller_requested', callSID = null, personaId = null) {
    const sql = `
    INSERT IGNORE INTO suppression_list (phoneNumber, reason, callSID, personaId)
    VALUES (?, ?, ?, ?)
    `;
    return db.query(sql, [phoneNumber, reason, callSID || null, personaId || null]);
}

/**
 * Check whether a phone number is on the suppression list.
 * @returns {boolean}
 */
async function isSuppressed(phoneNumber) {
    const sql = `SELECT 1 FROM suppression_list WHERE phoneNumber = ? LIMIT 1`;
    const rows = await db.query(sql, [phoneNumber]);
    return rows.length > 0;
}

/**
 * Remove a phone number from the suppression list.
 */
async function removeSuppression(phoneNumber) {
    const sql = `DELETE FROM suppression_list WHERE phoneNumber = ?`;
    return db.query(sql, [phoneNumber]);
}

module.exports = { addSuppression, isSuppressed, removeSuppression };
