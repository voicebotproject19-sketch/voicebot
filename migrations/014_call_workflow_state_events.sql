CREATE TABLE IF NOT EXISTS call_workflow_states (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    callSID     VARCHAR(128) NOT NULL,
    workflowId  VARCHAR(100) NOT NULL,
    status      VARCHAR(64) DEFAULT NULL,
    version     INT UNSIGNED NOT NULL DEFAULT 1,
    stateJson   JSON NOT NULL,
    summaryJson JSON DEFAULT NULL,
    createdAt   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updatedAt   TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_call_workflow_state (callSID, workflowId),
    INDEX idx_call_workflow_state_status (workflowId, status, updatedAt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS call_workflow_events (
    id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    callSID        VARCHAR(128) NOT NULL,
    workflowId     VARCHAR(100) NOT NULL,
    eventType      VARCHAR(100) NOT NULL,
    idempotencyKey VARCHAR(190) NOT NULL,
    eventJson      JSON NOT NULL,
    createdAt      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_call_workflow_event_idempotency (idempotencyKey),
    INDEX idx_call_workflow_events_call (callSID, workflowId, id),
    INDEX idx_call_workflow_events_type (workflowId, eventType, createdAt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;