const db = require("../services/db");
const { redactPII } = require("../Utils/piiRedactor");

async function createCall(callSID, phoneNumber, provider) {
  const sql = `
  INSERT INTO call_sessions
  (callSID, phoneNumber, provider, startedAt)
  VALUES (?, ?, ?, NOW())
  `;

  return db.query(sql, [callSID, phoneNumber, provider]);
}

async function endCall(callSID, transcript, durationMs) {
  const sql = `
  UPDATE call_sessions
  SET transcript = ?, durationMs = ?, endedAt = NOW()
  WHERE callSID = ?
  `;

  return db.query(sql, [
    redactPII(JSON.stringify(transcript)),
    durationMs,
    callSID
  ]);
}

module.exports = { createCall, endCall };
