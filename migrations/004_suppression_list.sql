CREATE TABLE IF NOT EXISTS suppression_list (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    phoneNumber VARCHAR(32) NOT NULL,
    reason      VARCHAR(64) NOT NULL DEFAULT 'caller_requested',
    callSID     VARCHAR(128) DEFAULT NULL,
    personaId   VARCHAR(64) DEFAULT NULL,
    createdAt   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_phone (phoneNumber)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
