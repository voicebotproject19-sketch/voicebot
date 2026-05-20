const db = require("../services/db");
const { redactPII } = require("../Utils/piiRedactor");

async function createUser(callSID, phoneNumber, name, status, interested, voicemail, email, country) {
  const sql = `INSERT INTO users_demobot (callSID, PhoneNumber, Name, status, interested, voicemail, email, country, createdAt)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const now = new Date();
  return db.query(sql, [callSID, phoneNumber, redactPII(name), status, interested, voicemail, redactPII(email), country, now]);
}

async function getUsers(limit = 100, offset = 0) {
  const sql = `SELECT callSID, PhoneNumber, name, createdAt FROM users_demobot ORDER BY createdAt DESC LIMIT ? OFFSET ?`;
  return db.query(sql, [limit, offset]);
}

module.exports = { createUser, getUsers };
