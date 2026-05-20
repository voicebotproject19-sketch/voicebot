-- Sprint 2: Consent ledger — event-log of per-number consent grants and revocations.
-- Intentionally no UNIQUE on phoneNumber — multiple rows allowed (full audit trail).
CREATE TABLE IF NOT EXISTS consent_ledger (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    phoneNumber VARCHAR(32)  NOT NULL,
    event       ENUM('granted', 'revoked') NOT NULL,
    callSID     VARCHAR(128) DEFAULT NULL,
    personaId   VARCHAR(64)  DEFAULT NULL,
    createdAt   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_phone_event (phoneNumber, event)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
