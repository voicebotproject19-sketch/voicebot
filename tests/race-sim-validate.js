/**
 * Advanced Race Condition & Edge Case Simulation
 * Models the full state machine: BaseRealtimeAdapter, StreamService, Orchestrator
 */
const { isGarbledTranscript } = require('../Helper/callClassifier');

// ─── Simulated Stream Service (mirrors stream-service-plivo.js) ─────
class SimStreamService {
  constructor() {
    this.currentAudioTask = null;
    this.silentMode = false;
    this._cancelledResponseId = null;
    this.interrupted = false;
    this.turnId = 1;
    this.isUserSpeaking = false;
  }
  sendAudioDirect(responseId) {
    if (this.silentMode) {
      const isStale = responseId && this._cancelledResponseId && responseId === this._cancelledResponseId;
      if (!isStale && !this.isUserSpeaking) {
        this.silentMode = false;
        this.interrupted = false;
        this._cancelledResponseId = null;
      } else {
        return 'SUPPRESSED';
      }
    }
    this.currentAudioTask = 'task_' + this.turnId + '_' + Math.random().toString(36).slice(2, 6);
    return 'SENT';
  }
  stopCurrentAudio(cancelledResponseId) {
    if (this.currentAudioTask) {
      this.currentAudioTask = null;
      this.silentMode = true;
      this._cancelledResponseId = cancelledResponseId || null;
      this.interrupted = true;
      return 'STOPPED_AND_SILENT';
    }
    return 'NO_TASK';
  }
  clearAudioTask() {
    if (this.currentAudioTask) { this.currentAudioTask = null; return 'CLEARED'; }
    return 'ALREADY_NULL';
  }
}

// ─── Simulated Adapter (mirrors BaseRealtimeAdapter + orchestrator) ──
class SimAdapter {
  constructor(ss) {
    this.ss = ss;
    this.isResponding = false;
    this._lastBargeInTime = null;
    this._audioPlaybackEndEstimate = 0;
    this.consecutiveNoisyTurns = 0;
    this.isUserSpeaking = false;
    this.BARGE_IN_RECOVERY_MS = 4000;
    this._currentResponseId = null;
  }
  speechStarted(now) {
    this.isUserSpeaking = true;
    this.ss.isUserSpeaking = true;
    const stillPlaying = this._audioPlaybackEndEstimate > now;
    let bargeIn = false;
    if (this.isResponding || stillPlaying) {
      this._lastBargeInTime = now;
      this.isResponding = false;
      this._audioPlaybackEndEstimate = 0;
      bargeIn = true;
    }
    this.ss.turnId++;
    const stopResult = this.ss.stopCurrentAudio(bargeIn ? this._currentResponseId : null);
    return { bargeIn, stopResult };
  }
  speechStopped() {
    this.isUserSpeaking = false;
    this.ss.isUserSpeaking = false;
  }
  audioDone(now) {
    this.isResponding = false;
    this._audioPlaybackEndEstimate = 0;
    this.ss.clearAudioTask();
  }
  audioStart(responseId, now) {
    this.isResponding = true;
    this._currentResponseId = responseId;
    this._audioPlaybackEndEstimate = now + 2000;
    return this.ss.sendAudioDirect(responseId);
  }
  processTranscript(text, now) {
    if (isGarbledTranscript(text)) {
      this.consecutiveNoisyTurns++;
      let action = 'skipped';
      if (this.consecutiveNoisyTurns === 2) action = 'clarification_sent';
      else if (this.consecutiveNoisyTurns >= 4) { action = 'escalation_sent'; this.consecutiveNoisyTurns = 2; }
      else if (this.consecutiveNoisyTurns === 1 && this._lastBargeInTime && (now - this._lastBargeInTime) < this.BARGE_IN_RECOVERY_MS) {
        action = 'barge_in_recovery_ack';
      }
      return { garbled: true, action, consecutiveNoisy: this.consecutiveNoisyTurns };
    }
    this.consecutiveNoisyTurns = 0;
    return { garbled: false, action: 'forwarded_to_ai', consecutiveNoisy: 0 };
  }
  state() {
    return {
      isResponding: this.isResponding,
      silentMode: this.ss.silentMode,
      audioTask: this.ss.currentAudioTask ? 'SET' : null,
      isUserSpeaking: this.isUserSpeaking,
      lastBargeIn: this._lastBargeInTime,
      consecutiveNoisy: this.consecutiveNoisyTurns,
    };
  }
}

// ─── Test Runner ─────────────────────────────────────────────────────
let total = 0, pass = 0, failures = [];
function run(name, steps) {
  total++;
  const ss = new SimStreamService();
  const a = new SimAdapter(ss);
  let passed = true, failReason = null;

  for (const step of steps) {
    const t = step.t;
    switch (step.action) {
      case 'audio_start': a.audioStart(step.responseId, t); break;
      case 'audio_done': a.audioDone(t); break;
      case 'speech_started': a.speechStarted(t); break;
      case 'speech_stopped': a.speechStopped(); break;
      case 'transcript': a.processTranscript(step.text, t); break;
      case 'check':
        const s = a.state();
        for (const [k, v] of Object.entries(step.expect)) {
          if (s[k] !== v) {
            passed = false;
            failReason = 'T+' + t + 'ms: ' + k + '=' + JSON.stringify(s[k]) + ', expected ' + JSON.stringify(v);
          }
        }
        break;
    }
  }

  if (passed) { pass++; console.log('  PASS | ' + name); }
  else { failures.push(name); console.log('  FAIL | ' + name); console.log('       > ' + failReason); }
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n══ GROUP 1: Normal flow ═══════════════════════════════════');
run('Greeting > user speaks > valid transcript', [
  { t: 0, action: 'audio_start', responseId: 'r1' },
  { t: 300, action: 'audio_done' },
  { t: 300, action: 'check', expect: { silentMode: false, audioTask: null } },
  { t: 10000, action: 'speech_started' },
  { t: 10000, action: 'check', expect: { silentMode: false } },
  { t: 11000, action: 'speech_stopped' },
  { t: 11500, action: 'transcript', text: 'Yes, I have some time.' },
]);
run('Greeting > garbled > clarification at count=2', [
  { t: 0, action: 'audio_start', responseId: 'r1' },
  { t: 300, action: 'audio_done' },
  { t: 5000, action: 'speech_started' },
  { t: 5300, action: 'speech_stopped' },
  { t: 5800, action: 'transcript', text: 'Uh hm?' },
  { t: 5800, action: 'check', expect: { silentMode: false, consecutiveNoisy: 1 } },
  { t: 8000, action: 'speech_started' },
  { t: 8300, action: 'speech_stopped' },
  { t: 8800, action: 'transcript', text: 'Da ba.' },
  { t: 8800, action: 'check', expect: { consecutiveNoisy: 2 } },
]);

console.log('\n══ GROUP 2: audio_done vs speech_started race ════════════');
run('speech_started BEFORE audio_done (real barge-in)', [
  { t: 0, action: 'audio_start', responseId: 'r1' },
  { t: 200, action: 'speech_started' },
  { t: 200, action: 'check', expect: { silentMode: true } },
  { t: 250, action: 'audio_done' },
  { t: 250, action: 'check', expect: { silentMode: true, audioTask: null } },
  { t: 1000, action: 'speech_stopped' },
  { t: 1500, action: 'transcript', text: 'Am I audible?' },
]);
run('audio_done then speech_started (same tick)', [
  { t: 0, action: 'audio_start', responseId: 'r1' },
  { t: 300, action: 'audio_done' },
  { t: 300, action: 'speech_started' },
  { t: 300, action: 'check', expect: { silentMode: false, audioTask: null } },
  { t: 1000, action: 'speech_stopped' },
  { t: 1500, action: 'transcript', text: 'Of this call.' },
]);
run('audio_done then speech_started (1ms gap)', [
  { t: 0, action: 'audio_start', responseId: 'r1' },
  { t: 300, action: 'audio_done' },
  { t: 301, action: 'speech_started' },
  { t: 301, action: 'check', expect: { silentMode: false } },
  { t: 1000, action: 'speech_stopped' },
  { t: 1500, action: 'transcript', text: 'Tell me more about your services.' },
]);

console.log('\n══ GROUP 3: Rapid VAD flicker ═════════════════════════════');
run('Two speech bursts before transcript arrives', [
  { t: 0, action: 'audio_start', responseId: 'r1' },
  { t: 300, action: 'audio_done' },
  { t: 5000, action: 'speech_started' },
  { t: 5500, action: 'speech_stopped' },
  { t: 6000, action: 'speech_started' },
  { t: 6500, action: 'speech_stopped' },
  { t: 7000, action: 'transcript', text: 'Of this call.' },
  { t: 7000, action: 'check', expect: { silentMode: false } },
  { t: 7500, action: 'transcript', text: 'Am I audible?' },
]);
run('Three garbled then valid resets', [
  { t: 0, action: 'audio_start', responseId: 'r1' },
  { t: 300, action: 'audio_done' },
  { t: 5000, action: 'speech_started' },
  { t: 5300, action: 'speech_stopped' },
  { t: 5800, action: 'transcript', text: 'Uh hm?' },
  { t: 5800, action: 'check', expect: { consecutiveNoisy: 1 } },
  { t: 8000, action: 'speech_started' },
  { t: 8300, action: 'speech_stopped' },
  { t: 8800, action: 'transcript', text: 'Da ba.' },
  { t: 8800, action: 'check', expect: { consecutiveNoisy: 2 } },
  { t: 12000, action: 'speech_started' },
  { t: 12500, action: 'speech_stopped' },
  { t: 13000, action: 'transcript', text: 'Yes, I have some time.' },
  { t: 13000, action: 'check', expect: { consecutiveNoisy: 0, silentMode: false } },
]);

console.log('\n══ GROUP 4: Barge-in + garbled ════════════════════════════');
run('Barge-in > garbled within recovery window (ack)', [
  { t: 0, action: 'audio_start', responseId: 'r1' },
  { t: 150, action: 'speech_started' },
  { t: 150, action: 'check', expect: { silentMode: true } },
  { t: 200, action: 'audio_done' },
  { t: 500, action: 'speech_stopped' },
  { t: 1000, action: 'transcript', text: 'Uh hm?' },
]);
run('Barge-in > garbled OUTSIDE recovery window', [
  { t: 0, action: 'audio_start', responseId: 'r1' },
  { t: 150, action: 'speech_started' },
  { t: 500, action: 'speech_stopped' },
  { t: 200, action: 'audio_done' },
  { t: 5000, action: 'transcript', text: 'Da ba.' },
  { t: 5000, action: 'check', expect: { silentMode: true, consecutiveNoisy: 1 } },
]);
run('Barge-in > garbled > valid speech > AI response clears silence', [
  { t: 0, action: 'audio_start', responseId: 'r1' },
  { t: 150, action: 'speech_started' },
  { t: 200, action: 'audio_done' },
  { t: 500, action: 'speech_stopped' },
  { t: 5000, action: 'transcript', text: 'Da ba.' },
  { t: 5000, action: 'check', expect: { silentMode: true } },
  { t: 8000, action: 'speech_started' },
  { t: 8500, action: 'speech_stopped' },
  { t: 9000, action: 'transcript', text: 'Yes I am interested.' },
  { t: 9500, action: 'audio_start', responseId: 'r2' },
  { t: 9500, action: 'check', expect: { silentMode: false, consecutiveNoisy: 0 } },
]);

console.log('\n══ GROUP 5: clearAudioTask races ══════════════════════════');
run('Pipelined responses: new audio before audio_done', [
  { t: 0, action: 'audio_start', responseId: 'r1' },
  { t: 250, action: 'audio_start', responseId: 'r2' },
  { t: 250, action: 'check', expect: { audioTask: 'SET' } },
  { t: 300, action: 'audio_done' },
  { t: 300, action: 'check', expect: { audioTask: null } },
  { t: 5000, action: 'speech_started' },
  { t: 5000, action: 'check', expect: { silentMode: false } },
]);
run('Double audio_done is idempotent', [
  { t: 0, action: 'audio_start', responseId: 'r1' },
  { t: 300, action: 'audio_done' },
  { t: 301, action: 'audio_done' },
  { t: 301, action: 'check', expect: { audioTask: null, silentMode: false } },
]);

console.log('\n══ GROUP 6: Original log scenario replay ══════════════════');
run('Greeting > 10s > "Of this call." + "Am I audible?"', [
  { t: 0, action: 'audio_start', responseId: 'r_greeting' },
  { t: 300, action: 'audio_done' },
  { t: 300, action: 'check', expect: { audioTask: null, silentMode: false, isResponding: false } },
  { t: 10200, action: 'speech_started' },
  { t: 10200, action: 'check', expect: { silentMode: false } },
  { t: 11200, action: 'speech_stopped' },
  { t: 12800, action: 'transcript', text: 'Of this call.' },
  { t: 12800, action: 'check', expect: { silentMode: false, consecutiveNoisy: 0 } },
  { t: 21700, action: 'speech_started' },
  { t: 22700, action: 'speech_stopped' },
  { t: 23200, action: 'transcript', text: 'Am I audible?' },
  { t: 23200, action: 'check', expect: { silentMode: false, consecutiveNoisy: 0 } },
]);

console.log('\n══ GROUP 7: silentMode escape exhaustive ═══════════════════');
run('silentMode + user speaking > suppressed > user stops > next response clears', [
  { t: 0, action: 'audio_start', responseId: 'r1' },
  { t: 150, action: 'speech_started' },
  { t: 200, action: 'audio_done' },
  { t: 500, action: 'speech_stopped' },
  { t: 1000, action: 'transcript', text: 'Yes, go ahead.' },
  { t: 1500, action: 'audio_start', responseId: 'r2' },
  { t: 1500, action: 'check', expect: { silentMode: false, isResponding: true } },
]);
run('Multiple rapid barge-ins > recovery', [
  { t: 0, action: 'audio_start', responseId: 'r1' },
  { t: 100, action: 'speech_started' },
  { t: 100, action: 'check', expect: { silentMode: true } },
  { t: 200, action: 'speech_stopped' },
  { t: 200, action: 'audio_done' },
  { t: 500, action: 'audio_start', responseId: 'r2' },
  { t: 500, action: 'check', expect: { silentMode: false } },
  { t: 600, action: 'speech_started' },
  { t: 600, action: 'check', expect: { silentMode: true } },
  { t: 700, action: 'speech_stopped' },
  { t: 700, action: 'audio_done' },
  { t: 1200, action: 'transcript', text: 'I need help with web development.' },
  { t: 1500, action: 'audio_start', responseId: 'r3' },
  { t: 1500, action: 'check', expect: { silentMode: false } },
]);
run('4 consecutive garbled > escalation > reset to 2', [
  { t: 0, action: 'audio_start', responseId: 'r1' },
  { t: 300, action: 'audio_done' },
  { t: 1000, action: 'speech_started' },
  { t: 1200, action: 'speech_stopped' },
  { t: 1500, action: 'transcript', text: 'Da ba.' },
  { t: 1500, action: 'check', expect: { consecutiveNoisy: 1 } },
  { t: 3000, action: 'speech_started' },
  { t: 3200, action: 'speech_stopped' },
  { t: 3500, action: 'transcript', text: 'Er um.' },
  { t: 3500, action: 'check', expect: { consecutiveNoisy: 2 } },
  { t: 5000, action: 'speech_started' },
  { t: 5200, action: 'speech_stopped' },
  { t: 5500, action: 'transcript', text: 'Uh hm?' },
  { t: 5500, action: 'check', expect: { consecutiveNoisy: 3 } },
  { t: 7000, action: 'speech_started' },
  { t: 7200, action: 'speech_stopped' },
  { t: 7500, action: 'transcript', text: 'Go to?' },
  { t: 7500, action: 'check', expect: { consecutiveNoisy: 2 } },
]);

console.log('\n══ GROUP 8: Remaining risk scenarios ════════════════════════');
run('RISK: Barge-in > garbled outside window > stuck > valid speech recovers', [
  { t: 0, action: 'audio_start', responseId: 'r1' },
  { t: 150, action: 'speech_started' },
  { t: 500, action: 'speech_stopped' },
  { t: 200, action: 'audio_done' },
  { t: 5000, action: 'transcript', text: 'Da ba.' },
  { t: 5000, action: 'check', expect: { silentMode: true, consecutiveNoisy: 1 } },
  { t: 10000, action: 'speech_started' },
  { t: 10500, action: 'speech_stopped' },
  { t: 11000, action: 'transcript', text: 'Hello, can you hear me?' },
  { t: 11500, action: 'audio_start', responseId: 'r2' },
  { t: 11500, action: 'check', expect: { silentMode: false, consecutiveNoisy: 0 } },
]);
run('RISK: Only garbled > count=2 clarification > audio clears silence', [
  { t: 0, action: 'audio_start', responseId: 'r1' },
  { t: 150, action: 'speech_started' },
  { t: 200, action: 'audio_done' },
  { t: 500, action: 'speech_stopped' },
  { t: 5000, action: 'transcript', text: 'Uh hm?' },
  { t: 5000, action: 'check', expect: { silentMode: true, consecutiveNoisy: 1 } },
  { t: 8000, action: 'speech_started' },
  { t: 8300, action: 'speech_stopped' },
  { t: 8800, action: 'transcript', text: 'Da ba.' },
  { t: 9000, action: 'audio_start', responseId: 'r_clarify' },
  { t: 9000, action: 'check', expect: { silentMode: false, consecutiveNoisy: 2 } },
]);
run('RISK: Barge-in > single garbled > silence nudge saves it', [
  { t: 0, action: 'audio_start', responseId: 'r1' },
  { t: 150, action: 'speech_started' },
  { t: 200, action: 'audio_done' },
  { t: 500, action: 'speech_stopped' },
  { t: 5000, action: 'transcript', text: 'Da ba.' },
  { t: 5000, action: 'check', expect: { silentMode: true } },
  { t: 15000, action: 'audio_start', responseId: 'r_nudge' },
  { t: 15000, action: 'check', expect: { silentMode: false } },
]);
run('RISK: stopCurrentAudio on null task does NOT set silentMode', [
  { t: 0, action: 'audio_start', responseId: 'r1' },
  { t: 300, action: 'audio_done' },
  { t: 300, action: 'check', expect: { silentMode: false, audioTask: null } },
  // speech_started with no active audio task
  { t: 5000, action: 'speech_started' },
  // stopCurrentAudio returns NO_TASK, silentMode stays false
  { t: 5000, action: 'check', expect: { silentMode: false } },
  { t: 5500, action: 'speech_stopped' },
  { t: 6000, action: 'transcript', text: 'Hello there.' },
  { t: 6000, action: 'check', expect: { silentMode: false, consecutiveNoisy: 0 } },
]);

console.log('\n══ GROUP 9: Threshold edge cases ═══════════════════════════');
run('Short valid phrases all pass through', [
  { t: 0, action: 'audio_start', responseId: 'r1' },
  { t: 300, action: 'audio_done' },
  { t: 1000, action: 'speech_started' },
  { t: 1200, action: 'speech_stopped' },
  { t: 1500, action: 'transcript', text: 'Who is this?' },
  { t: 1500, action: 'check', expect: { consecutiveNoisy: 0 } },
  { t: 3000, action: 'speech_started' },
  { t: 3200, action: 'speech_stopped' },
  { t: 3500, action: 'transcript', text: 'Not yet.' },
  { t: 3500, action: 'check', expect: { consecutiveNoisy: 0 } },
  { t: 5000, action: 'speech_started' },
  { t: 5200, action: 'speech_stopped' },
  { t: 5500, action: 'transcript', text: 'Yes sir.' },
  { t: 5500, action: 'check', expect: { consecutiveNoisy: 0 } },
]);
run('Garble at new thresholds still caught', [
  { t: 0, action: 'audio_start', responseId: 'r1' },
  { t: 300, action: 'audio_done' },
  { t: 1000, action: 'speech_started' },
  { t: 1200, action: 'speech_stopped' },
  { t: 1500, action: 'transcript', text: 'Uh hm?' },
  { t: 1500, action: 'check', expect: { consecutiveNoisy: 1 } },
  { t: 3000, action: 'speech_started' },
  { t: 3200, action: 'speech_stopped' },
  { t: 3500, action: 'transcript', text: 'Go to?' },
  { t: 3500, action: 'check', expect: { consecutiveNoisy: 2 } },
]);
run('Boundary: 2-word exactly at threshold (5 chars) passes', [
  { t: 0, action: 'audio_start', responseId: 'r1' },
  { t: 300, action: 'audio_done' },
  { t: 1000, action: 'speech_started' },
  { t: 1200, action: 'speech_stopped' },
  { t: 1500, action: 'transcript', text: 'Hi no.' },
  // "Hi no" = 4 chars (stripped) → below 5 threshold → garbled
  { t: 1500, action: 'check', expect: { consecutiveNoisy: 1 } },
]);
run('Boundary: 3-word exactly at threshold (7 chars) passes', [
  { t: 0, action: 'audio_start', responseId: 'r1' },
  { t: 300, action: 'audio_done' },
  { t: 1000, action: 'speech_started' },
  { t: 1200, action: 'speech_stopped' },
  { t: 1500, action: 'transcript', text: 'I am in.' },
  // "I am in" = 6 chars → below 7 threshold → garbled
  { t: 1500, action: 'check', expect: { consecutiveNoisy: 1 } },
]);

console.log('\n══ GROUP 10: Complex multi-turn sequences ═══════════════════');
run('Full conversation: greeting > barge-in > garbled > valid > response > barge-in > valid', [
  // Bot greeting
  { t: 0, action: 'audio_start', responseId: 'r_greet' },
  // User barges in during greeting
  { t: 150, action: 'speech_started' },
  { t: 150, action: 'check', expect: { silentMode: true } },
  { t: 200, action: 'audio_done' },
  { t: 500, action: 'speech_stopped' },
  // Garbled from barge-in (within recovery window)
  { t: 800, action: 'transcript', text: 'Uh hm?' },
  // Recovery ack sent → bot sends ack audio
  { t: 1200, action: 'audio_start', responseId: 'r_ack' },
  { t: 1200, action: 'check', expect: { silentMode: false } },
  { t: 1800, action: 'audio_done' },
  // User speaks valid
  { t: 3000, action: 'speech_started' },
  { t: 3000, action: 'check', expect: { silentMode: false } },
  { t: 4000, action: 'speech_stopped' },
  { t: 4500, action: 'transcript', text: 'Yes I am interested in your services.' },
  { t: 4500, action: 'check', expect: { consecutiveNoisy: 0 } },
  // Bot responds
  { t: 5000, action: 'audio_start', responseId: 'r_main' },
  { t: 5000, action: 'check', expect: { silentMode: false, isResponding: true } },
  // User barges in again
  { t: 5500, action: 'speech_started' },
  { t: 5500, action: 'check', expect: { silentMode: true } },
  { t: 5600, action: 'audio_done' },
  { t: 6000, action: 'speech_stopped' },
  { t: 6500, action: 'transcript', text: 'Actually wait, what about pricing?' },
  { t: 6500, action: 'check', expect: { consecutiveNoisy: 0 } },
  // Bot responds to new question
  { t: 7000, action: 'audio_start', responseId: 'r_pricing' },
  { t: 7000, action: 'check', expect: { silentMode: false } },
  { t: 7500, action: 'audio_done' },
  { t: 7500, action: 'check', expect: { silentMode: false, audioTask: null } },
]);

// ═════════════════════════════════════════════════════════════════════
console.log('\n══════════════════════════════════════════════════════════════');
console.log('RESULTS: ' + pass + '/' + total + ' passed');
if (failures.length) {
  console.log('FAILED:');
  failures.forEach(f => console.log('  - ' + f));
  process.exit(1);
} else {
  console.log('All scenarios passed');
}
