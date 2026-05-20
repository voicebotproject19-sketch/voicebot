ALTER TABLE call_outcomes
    MODIFY COLUMN outcome ENUM(
        'booked',
        'rejected',
        'voicemail',
        'transferred',
        'abandoned',
        'completed',
        'booking_link_requested',
        'booking_link_sent',
        'booking_link_failed',
        'booking_completed',
        'booking_cancelled',
        'transfer_requested',
        'transfer_failed',
        'handover_fallback',
        'dealer_order_confirmed',
        'dealer_order_skipped'
    ) DEFAULT 'completed';