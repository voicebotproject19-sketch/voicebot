-- Legacy tables for backward compatibility (getUsers, getConversations, createUser, insertConversation)
CREATE TABLE IF NOT EXISTS users_demobot (
  callSID VARCHAR(64) NOT NULL,
  PhoneNumber VARCHAR(32),
  Name VARCHAR(255),
  status VARCHAR(64),
  interested VARCHAR(32),
  voicemail VARCHAR(32),
  email VARCHAR(255),
  country VARCHAR(16),
  createdAt DATETIME,
  PRIMARY KEY (callSID)
);

CREATE TABLE IF NOT EXISTS conversations_demobot (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  callSID VARCHAR(64) NOT NULL,
  PhoneNumber VARCHAR(32),
  role VARCHAR(32),
  content TEXT,
  timestamp DATETIME,
  createdAt DATETIME,
  INDEX idx_callSID (callSID)
);
