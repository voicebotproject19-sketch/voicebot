'use strict';

const db = require('../services/db');
const { redactPII } = require('../Utils/piiRedactor');

/**
 * Persist structured call outcome. Called once at call end via writeQueue.
 * All fields are optional except callSID.
 */
async function createOutcome(data) {
    const sql = `
    INSERT INTO call_outcomes
    (callSID, outcome, personaId, phoneNumber, userEmail, userPhone,
     preferredSlot, conversationPhase, turnCount, durationMs,
     sentimentPrimary, escalated, synthesisScoreAvg,
     degradationStateFinal, packetLossAvg, phase4Profile)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
        outcome = CASE
            WHEN outcome IN ('booking_completed', 'booking_cancelled', 'dealer_order_confirmed', 'dealer_order_skipped') THEN outcome
            ELSE VALUES(outcome)
        END,
        userEmail = VALUES(userEmail),
        userPhone = VALUES(userPhone),
        preferredSlot = VALUES(preferredSlot),
        conversationPhase = VALUES(conversationPhase),
        turnCount = VALUES(turnCount),
        durationMs = VALUES(durationMs),
        sentimentPrimary = VALUES(sentimentPrimary),
        escalated = VALUES(escalated),
        synthesisScoreAvg = VALUES(synthesisScoreAvg),
        degradationStateFinal = VALUES(degradationStateFinal),
        packetLossAvg = VALUES(packetLossAvg)
    `;

    return db.query(sql, [
        data.callSID,
        data.outcome || 'completed',
        data.personaId || null,
        data.phoneNumber || null,
        redactPII(data.userEmail || null),
        redactPII(data.userPhone || null),
        redactPII(data.preferredSlot || null),
        data.conversationPhase || null,
        data.turnCount || 0,
        data.durationMs || 0,
        data.sentimentPrimary || null,
        data.escalated ? 1 : 0,
        data.synthesisScoreAvg != null ? data.synthesisScoreAvg : null,
        data.degradationStateFinal || 'NORMAL',
        data.packetLossAvg != null ? data.packetLossAvg : null,
        data.phase4Profile || null
    ]);
}

async function updateOutcomeStatus(callSID, outcome) {
    if (!callSID || !outcome) return null;
    const sql = `
    INSERT INTO call_outcomes (callSID, outcome)
    VALUES (?, ?)
    ON DUPLICATE KEY UPDATE outcome = VALUES(outcome)
    `;
    return db.query(sql, [callSID, outcome]);
}

/**
 * Read outcome by callSID (for future API use).
 */
async function getOutcome(callSID) {
    const rows = await db.query(
        'SELECT * FROM call_outcomes WHERE callSID = ? LIMIT 1',
        [callSID]
    );
    return rows[0] || null;
}

module.exports = { createOutcome, getOutcome, updateOutcomeStatus };
