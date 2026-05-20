CREATE TABLE IF NOT EXISTS booking_webhook_orphans (
    id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    dedupeKey         CHAR(64) NOT NULL,
    provider          VARCHAR(64) NOT NULL,
    externalBookingId VARCHAR(512) DEFAULT NULL,
    eventType         VARCHAR(128) NOT NULL,
    status            ENUM('completed', 'cancelled', 'unknown') NOT NULL DEFAULT 'unknown',
    rawCallSID        VARCHAR(128) DEFAULT NULL,
    correlationStatus VARCHAR(64) DEFAULT NULL,
    orphanReason      VARCHAR(128) NOT NULL,
    payloadHash       CHAR(64) DEFAULT NULL,
    receivedAt        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updatedAt         TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_booking_orphan_dedupe (dedupeKey),
    INDEX idx_booking_orphan_provider_status (provider, status),
    INDEX idx_booking_orphan_reason (orphanReason),
    INDEX idx_booking_orphan_external (provider, externalBookingId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;