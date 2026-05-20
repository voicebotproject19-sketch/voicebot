const EVENTS = new Set([
  // ─── Turn lifecycle ─────────────────────────────────────────────────────────
  'mode_transition',
  'turn_created',
  'turn_snapshot',
  'turn_interrupted',
  'turn_closed',
  'user_turn_completed',

  // ─── Speech pipeline ────────────────────────────────────────────────────────
  'speech_started',
  'speech_playback_started',
  'speech_emitted',
  'speech_cancelled',
  'speech_completed',
  'user_speech_started',
  'user_speech_stopped',           // needed by drift detection (speechStopped counter)
  'speech_window_transcribed',
  'speech_window_no_transcript',

  // ─── Carrier / audio quality ────────────────────────────────────────────────
  'degradation_state_transition',
  'carrier_jitter_sample',
  'audio_buffer_received',
  'gate_turn_summary',
  'telecom_status_received',
  'telecom_status_terminal',
  'telecom_status_missing_call_id',

  // ─── Conversation events ────────────────────────────────────────────────────
  'clarification_emitted',
  'micro_ack_emitted',
  'unlock_granted',
  'hangup_triggered',

  // ─── Realtime adapter events ───────────────────────────────────────────────
  'realtime_session_created',
  'realtime_session_updated',
  'realtime_usage',
  'realtime_connection_error',
  'realtime_connection_closed',
  'realtime_reconnected',
  'realtime_reconnection_failed',
  'realtime_rate_limit_backoff',
  'realtime_service_error',

  // ─── Legacy Azure names retained for backward compatibility ───────────────
  'azure_voicelive_session_created',
  'azure_voicelive_session_updated',
  'azure_voicelive_usage',
  'azure_realtime_connection_error',
  'azure_realtime_connection_closed',
  'azure_realtime_reconnected',
  'azure_realtime_reconnection_failed',

  // ─── Call classification ────────────────────────────────────────────────────
  'call_screening_detected',
  'voicemail_content_detected',

  // ─── System stability / observability ──────────────────────────────────────
  'unhandled_rejection',
  'uncaught_exception',
  'pipeline_error',
  'session_init_timeout',
  'rag_error',
  'rag_latency',
  'query_complexity_detected',
  'ambiguity_resolved',
  'multi_intent_detected',
  'call_registry_capacity_reached',
  'write_queue_abandoned',
  'write_queue_full',
  'call_finalization_started',
  'call_finalization_completed',
  'call_finalization_degraded',
  'call_context_hydrated',
  'call_context_persist_failed',
  'token_budget_exceeded',
  'prompt_budget_warning',
  'prompt_budget_hard_warning',
  'denoise_worker_stopped',
  'telemetry_dropped_events',
  'behavior_drift_detected',
  'call_timeline',
  'first_audio_delta',
  'dtmf_received',
  'transfer_failed_callback_offered',
  'latency_compensation_disabled_warning',
  'compliance_gate_decision',

  // ─── Response latency (speech_stopped → first audio byte) ──────────────────
  'response_latency',
  'latency_compensation_active',
  'latency_compensation_level',

  // ─── Speculative pre-warm (partial transcript KB pre-fetch) ────────────────
  'speculative_prewarm_completed',
  'speculative_prewarm_used',

  // ─── Response loop detection ───────────────────────────────────────────────
  'response_loop_permanent_fallback',
  'duplicate_nudge_suppressed_no_repair',
  'booking_recovery_action_selected',

  // ─── Response timeout (response.create sent but Azure never produced audio) ─
  'response_timeout',

  // ─── Reconnection UX ─────────────────────────────────────────────────────
  'reconnection_failed_hangup',
  'reconnect_hold_music_started',
  'reconnect_hold_music_stopped',
  'reconnect_hold_music_failsafe_stop',

  // ─── Tone adaptation & handover ────────────────────────────────────────────
  'sentiment_detected',
  'escalation_triggered',
  'handover_triggered',
  'handover_transfer_scheduled',
  'handover_transfer_invalid_number',
  'agent_availability_checked',
  'cold_transfer_started',
  'warm_transfer_started',
  'agent_leg_ringing',
  'agent_leg_answered',
  'agent_leg_accepted',
  'agent_leg_rejected',
  'warm_transfer_bridge_confirmed',
  'warm_transfer_failed',
  'transfer_request_accepted',
  'transfer_request_failed',
  'call_transferred',
  'handover_fallback_close',

  // ─── Call summary (emitted on disconnect for call-level analytics) ─────────
  'call_summary',

  // ─── Phase 4 CX events ────────────────────────────────────────────────────
  'numeric_violation',
  'synthesis_score',
  'persona_pass_applied',
  'packet_loss_detected',
  'transaction_policy_blocked',
  'phase4_escalation',
  'kb_retrieval_timeout',
  'numeric_without_grounding',
  'silence_timer_fired',
  'silence_nudge_suppressed_state',
  'barge_in_recovery_suppressed_state',
  'barge_in_recovery_recheck_scheduled',
  'barge_in_recovery_hard_timeout',
  'barge_in_recovery_clarification_sent',
  'stale_recovery_response_dropped',
  'silence_nudge_scripted_sent',
  'silence_goodbye_scripted_sent',
  'silence_goodbye_postponed_continue_decision',

  // ─── Sprint 4: Model Layer Optimization ──────────────────────────────────
  'response_quality_fail',
  'intent_gate_skip_kb',
  'pat_match',
  'model_selected',
  'model_ab_outcome',
  'vad_ab_assignment',

  // ─── Sprint 5A: Production Hardening ───────────────────────────────────
  'email_extracted',
  'email_confirmed',
  'email_rejected',
  'email_refused',
  'appointment_offered',
  'booking_intent_detected',
  'booking_phone_consent_context_set',
  'booking_phone_consent_context_cleared',
  'hangup_next_action_clamped',
  'slot_captured',
  'booking_link_requested',
  'booking_link_delivery_attempted',
  'booking_link_delivery_sent',
  'booking_link_delivery_failed',
  'booking_link_sent',
  'booking_link_failed',
  'booking_completed_webhook',
  'booking_webhook_orphaned',
  'booking_provider_error',
  'dealer_order_items_captured',
  'dealer_order_confirmed',
  'dealer_order_skipped',
  'dealer_order_erp_logged',
  'dealer_order_erp_failed',
  'dealer_order_notification_sent',
  'dealer_order_notification_failed',
  'dealer_order_missed_call',
  'dealer_order_retry_scheduled',
  'dealer_order_retry_failed',
  'dealer_order_fallback_sent',
  'dealer_order_fallback_failed',
  'action_outbox_enqueued',
  'action_outbox_claimed',
  'action_outbox_completed',
  'action_outbox_failed',
  'action_outbox_duplicate',
  'action_outbox_requeued',
  'action_outbox_poll_failed',
  'workflow_readiness_checked',
  'workflow_dark_read_compared',
  'workflow_dark_read_mismatch',
  'workflow_reconciliation_audit',
  'workflow_reconciliation_requeue_completed',
  'workflow_release_evidence_checked',
  'summarization_failed',
  'summarization_disabled',
  'kb_retrieval_slow',

  // ─── Sprint 5B: ROI Gap Closure ───────────────────────────────────────
  'spoken_email_normalized',
  'summarization_empty',
  'voicemail_suspected',

  // ─── Sprint 5B Hardening: Provider monitoring ─────────────────────────
  'garble_filter',
  'early_dedup',
  'playback_confirmed',
  'audio_cleared_confirmed',

  // ─── Two-phase Voice Live routing ─────────────────────────────────────
  'two_phase_eligible',
  'two_phase_skipped',
  'route_tool_started',
  'route_tool_completed',
  'route_tool_fallback',
  'micro_ack_played',
  'micro_ack_skipped',
  'micro_ack_completed',
  'micro_ack_cleared',
  'model_audio_queued_for_ack',
  'model_audio_flushed_after_ack',
]);

Object.freeze(EVENTS);

module.exports = EVENTS;
