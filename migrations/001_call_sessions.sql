CREATE TABLE call_sessions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  callSID VARCHAR(64) NOT NULL,
  provider VARCHAR(16),
  phoneNumber VARCHAR(32),
  startedAt DATETIME,
  endedAt DATETIME,
  durationMs INT,
  transcript JSON,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_callSID (callSID)
);
