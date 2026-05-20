ALTER TABLE call_context_snapshots
    MODIFY COLUMN contextHint TEXT NULL,
    ADD COLUMN dealerOrder JSON DEFAULT NULL AFTER externalBookingId;