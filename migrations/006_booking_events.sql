CREATE TABLE IF NOT EXISTS booking_events (
    id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    dedupeKey         CHAR(64) NOT NULL,
    callSID           VARCHAR(128) DEFAULT NULL,
    provider          VARCHAR(64) NOT NULL,
    externalBookingId VARCHAR(512) DEFAULT NULL,
    eventType         VARCHAR(128) NOT NULL,
    status            ENUM('completed', 'cancelled', 'unknown') NOT NULL DEFAULT 'unknown',
    payloadHash       CHAR(64) DEFAULT NULL,
    receivedAt        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completedAt       TIMESTAMP NULL DEFAULT NULL,
    cancelledAt       TIMESTAMP NULL DEFAULT NULL,
    updatedAt         TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_booking_dedupe (dedupeKey),
    INDEX idx_booking_callSID (callSID),
    INDEX idx_booking_provider_status (provider, status),
    INDEX idx_booking_external (provider, externalBookingId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
