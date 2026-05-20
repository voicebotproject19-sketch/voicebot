const db = require("../services/db");
const { redactPII } = require("../Utils/piiRedactor");
const { isCallContentRedactionEnabled } = require("../Utils/redactionPolicy");

async function insertConversation(callSID, phoneNumber, role, content) {
  const sql = `INSERT INTO conversations_demobot (callSID, PhoneNumber, role, content, timestamp, createdAt)
               VALUES (?, ?, ?, ?, ?, ?)`;
  const now = new Date();
  const safeContent = isCallContentRedactionEnabled() ? redactPII(content) : content;
  // mysql2 pool.execute for INSERT returns [ResultSetHeader, fields];
  // db.query() destructures to ResultSetHeader via const [rows] = await pool.execute(...).
  const result = await db.query(sql, [callSID, phoneNumber, role, safeContent, now, now]);
  // Surface the generated row ID so callers can reference or audit the insertion.
  return result?.insertId ?? null;
}

async function getByCallSID(callSID, limit = 100, offset = 0) {
  const sql = `SELECT callSID, PhoneNumber, role, content, timestamp, createdAt FROM conversations_demobot WHERE callSID = ? ORDER BY createdAt ASC LIMIT ? OFFSET ?`;
  return db.query(sql, [callSID, limit, offset]);
}

module.exports = { insertConversation, getByCallSID };
