#!/usr/bin/env node
'use strict';
const EVENTS = require('../Utils/telemetryEvents');
const emitted = [
  "agent_availability_checked","agent_leg_accepted","agent_leg_answered",
  "agent_leg_rejected","audio_buffer_received","audio_cleared_confirmed","call_screening_detected",
  "call_summary","call_transferred","carrier_jitter_sample","clarification_emitted",
  "cold_transfer_started","degradation_state_transition","denoise_worker_stopped","dtmf_received","early_dedup",
  "email_confirmed","email_extracted","email_rejected","escalation_triggered",
  "first_audio_delta","garble_filter","handover_fallback_close","handover_triggered",
  "handover_transfer_invalid_number","handover_transfer_scheduled",
  "hangup_triggered","intent_gate_skip_kb","kb_retrieval_slow","kb_retrieval_timeout",
  "latency_compensation_active","latency_compensation_disabled_warning",
  "latency_compensation_level","micro_ack_emitted","model_ab_outcome",
  "numeric_violation","numeric_without_grounding","packet_loss_detected","pat_match",
  "persona_pass_applied","phase4_escalation","playback_confirmed",
  "barge_in_recovery_clarification_sent","barge_in_recovery_hard_timeout",
  "barge_in_recovery_recheck_scheduled",
  "realtime_connection_closed","realtime_connection_error","realtime_rate_limit_backoff",
  "realtime_reconnected","realtime_reconnection_failed","realtime_service_error",
  "realtime_session_created","realtime_session_updated","realtime_usage",
  "reconnect_hold_music_failsafe_stop","reconnect_hold_music_started",
  "reconnect_hold_music_stopped","reconnection_failed_hangup","response_latency","response_quality_fail",
  "response_timeout","sentiment_detected","stale_recovery_response_dropped","speculative_prewarm_completed",
  "speculative_prewarm_used","speech_cancelled","speech_completed","speech_emitted",
  "speech_playback_started","speech_started","spoken_email_normalized",
  "summarization_disabled","summarization_empty","summarization_failed",
  "synthesis_score","token_budget_exceeded","transaction_policy_blocked",
  "transfer_failed_callback_offered","transfer_request_accepted","transfer_request_failed",
  "turn_closed","turn_created","turn_interrupted",
  "turn_snapshot","unlock_granted","user_speech_started","user_speech_stopped",
  "user_turn_completed","voicemail_content_detected","voicemail_suspected",
  "warm_transfer_bridge_confirmed","warm_transfer_failed","warm_transfer_started"
];
const unregistered = emitted.filter(e => !EVENTS.has(e));
if (unregistered.length === 0) {
  console.log('All ' + emitted.length + ' emitted events are registered ✅');
} else {
  console.log('UNREGISTERED:', unregistered);
  process.exit(1);
}
