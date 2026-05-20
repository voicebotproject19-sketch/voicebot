const EventEmitter = require('events');
const { epochTimeout } = require('../Utils/epochTimeout');
const uuid = require('uuid');
const fs = require('fs');
const path = require('path');

function loadHoldMusicAsset() {
  try {
    const holdMusicPath = path.join(__dirname, '..', 'Music', 'hold.mulaw');
    if (!fs.existsSync(holdMusicPath)) {
      return { base64: null, durationMs: 0 };
    }
    const holdMusicBuffer = fs.readFileSync(holdMusicPath);
    return {
      base64: holdMusicBuffer.toString('base64'),
      durationMs: (holdMusicBuffer.length / 8000) * 1000
    };
  } catch {
    return { base64: null, durationMs: 0 };
  }
}

const HOLD_MUSIC_ASSET = loadHoldMusicAsset();

class StreamServiceTwilio extends EventEmitter {
  // Deterministic turn guard used by all async callbacks
  assertTurnActive(scheduledTurn) {
    if (!this.turnStateRef) return true;
    if (this.turnStateRef.isClosed) return false;
    if (scheduledTurn !== null && scheduledTurn !== this.turnStateRef.currentTurnId) return false;
    return true;
  }

  constructor(websocket, turnStateRef) {
    super();
    this.ws = websocket;
    if (this.ws && typeof this.ws.on === 'function') {
      this.ws.on('error', (err) => {
        console.error('[StreamServiceTwilio] WebSocket error:', err);
      });
    }
    this.turnStateRef = turnStateRef || null;
    this.streamId = '';
    this.currentAudioTask = null;
    this.lastEmittedTask = null; // prevents duplicate media emission under telecom jitter
    this.lastPayloadHash = null; // prevents duplicate payload transmission
    this.markCounter = 0; // used to reduce frequency of Twilio mark events
    this.silentMode = false;
    this.interrupted = false;
    this._cancelledResponseId = null;
    this.holdMode = false;
    this.holdMusicInterval = null;
    this.holdAudioBuffer = null;
    this.holdMusicDuration = 0;

    // Use module-level cached hold music asset to avoid per-connection sync disk I/O.
    this.holdAudioBuffer = HOLD_MUSIC_ASSET.base64;
    this.holdMusicDuration = HOLD_MUSIC_ASSET.durationMs;
  }

  // Method to update hold mode and emit status change
  setHoldMode(isHoldMode) {
    if (this.holdMode !== isHoldMode) {
      this.holdMode = isHoldMode;
      console.log(`Hold mode changed to: ${isHoldMode}`);
    }
  }
  setStreamId(streamId) {
    this.streamId = streamId;
  }

  // Load hold music from the hold.mulaw file
  async loadHoldMusic() {
    this.holdAudioBuffer = HOLD_MUSIC_ASSET.base64;
    this.holdMusicDuration = HOLD_MUSIC_ASSET.durationMs;
    return this.holdAudioBuffer;
  }

  // MODIFIED: Simplified method that sends directly
  buffer(index, audio, hold, audioDuration) {
    // Ignore index completely - send directly
    this.sendAudioDirect(audio, audioDuration, hold);
  }

  // MODIFIED: Direct audio transmission without buffering
  sendAudioDirect(audio, audioDuration, hold = false, _srcTag, responseId) {
    const scheduledTurn = this.turnStateRef ? this.turnStateRef.currentTurnId : null;

    if (this.silentMode && !this.holdMode) {
      if (!this.assertTurnActive(scheduledTurn)) {
        // Fix 7b: Turn advanced past the interruption — stale silentMode, force-clear
        console.log('Turn advanced while in silent mode — clearing stale silentMode.');
        this.silentMode = false;
        this.interrupted = false;
        this._cancelledResponseId = null;
      } else {
        // Only exit silent mode if audio is from a NEW response (not stale cancelled one)
        // and the user is not currently speaking
        const isStaleAudio = responseId && this._cancelledResponseId && responseId === this._cancelledResponseId;
        const userSpeaking = this.turnStateRef && this.turnStateRef.isUserSpeaking;
        if (!isStaleAudio && !userSpeaking) {
          console.log('New response received. Exiting silent mode and resuming playback.');
          this.silentMode = false;
          this.interrupted = false;
          this._cancelledResponseId = null;
        } else {
          if (isStaleAudio) console.log('Suppressing stale audio from cancelled response.');
          return; // drop stale or mid-speech audio
        }
      }
    }

    const isHoldMessage = hold;

    // Prevent hold music overlapping with AI audio
    if (!isHoldMessage && this.holdMode) {
      this.stopHoldMusic();
    }

    if (!this.assertTurnActive(scheduledTurn)) return;

    // Pre-flight: verify WS is eligible before assigning currentAudioTask.
    // This prevents stale task state when the frame would be dropped anyway.
    if (!audio || typeof audio !== "string") return;
    if (!this.ws || this.ws.readyState !== 1) return;
    if (!this.streamId) return;

    // Prevent websocket backpressure buildup
    if (this.ws.bufferedAmount && this.ws.bufferedAmount > 5000000) {
      console.warn("WebSocket backpressure detected. Dropping audio frame.");
      return;
    }

    this.currentAudioTask = `${scheduledTurn || 't'}_${uuid.v4()}`;

    if (this.lastEmittedTask === this.currentAudioTask) return;
    this.lastEmittedTask = this.currentAudioTask;

    // Prevent duplicate payloads caused by telecom jitter without dropping valid frames
    const payloadHash = `${this.currentAudioTask}_${audio.length}_${audio.slice(0, 40)}`;
    if (this.lastPayloadHash === payloadHash) return;
    this.lastPayloadHash = payloadHash;

    this.ws.send(
      JSON.stringify({
        streamSid: this.streamId,
        event: 'media',
        media: {
          payload: audio,
        },
      })
    );


    const markLabel = this.currentAudioTask;

    // Reduce Twilio mark frequency to lower websocket overhead
    this.markCounter++;

    if (this.markCounter % 4 === 0) {
      if (!this.assertTurnActive(scheduledTurn)) return;
      if (!this.ws || this.ws.readyState !== 1) return;

      this.ws.send(
        JSON.stringify({
          streamSid: this.streamId,
          event: 'mark',
          mark: {
            name: markLabel,
          },
        })
      );

      if (this.assertTurnActive(scheduledTurn)) {
        this.emit('audiosent', markLabel);
      }
    }

    // If this is a hold message, start playing hold music after the audio duration
    if (isHoldMessage && audioDuration > 0) {
      console.log(`Starting hold music after ${audioDuration}ms`);
      epochTimeout(this.turnStateRef, () => {
        if (!this.assertTurnActive(scheduledTurn)) return;
        if (this.holdMode) return;
        this.startHoldMusic();
      }, audioDuration);
    }
  }

  // Keep existing methods for hold music functionality
  startHoldMusic() {
    if (!this.holdAudioBuffer) {
      console.log('No hold audio buffer set. Cannot play hold music.');
      return;
    }

    if (this.holdMode) {
      console.log('Hold music is already playing.');
      return;
    }

    console.log('Starting hold music...');
    // Clear any stale audio task so playHoldMusicOnce is not blocked.
    this.currentAudioTask = null;
    this.setHoldMode(true);
    this.silentMode = false;

    this.playHoldMusicOnce();

    const scheduledTurn = this.turnStateRef ? this.turnStateRef.currentTurnId : null;
    if (this.holdMusicInterval) {
      clearTimeout(this.holdMusicInterval);
      this.holdMusicInterval = null;
    }

    if (this.holdMusicDuration <= 0) return;

    const playLoop = () => {
      if (!this.assertTurnActive(scheduledTurn)) {
        this.stopHoldMusic();
        return;
      }

      if (!this.holdMode) return;

      this.playHoldMusicOnce();

      this.holdMusicInterval = setTimeout(playLoop, this.holdMusicDuration);
    };

    if (!this.assertTurnActive(scheduledTurn)) return;
    this.holdMusicInterval = setTimeout(playLoop, this.holdMusicDuration);
  }

  playHoldMusicOnce() {
    const scheduledTurn = this.turnStateRef ? this.turnStateRef.currentTurnId : null;
    if (!this.assertTurnActive(scheduledTurn)) return;
    if (!this.holdMode || !this.holdAudioBuffer) return;

    // Do not emit hold music if AI audio started meanwhile
    if (this.currentAudioTask && !this.silentMode) return;

    const holdTaskId = uuid.v4();
    if (this.lastEmittedTask === holdTaskId) return;
    this.lastEmittedTask = holdTaskId;
    console.log(`Playing hold music: ${holdTaskId}`);

    if (!this.assertTurnActive(scheduledTurn)) return;
    if (!this.ws || this.ws.readyState !== 1) return;
    if (!this.streamId) return;

    // Prevent websocket buffer overflow during hold loops
    if (this.ws.bufferedAmount && this.ws.bufferedAmount > 5000000) {
      console.warn("WebSocket backpressure detected during hold music. Skipping frame.");
      return;
    }

    this.ws.send(
      JSON.stringify({
        streamSid: this.streamId,
        event: 'media',
        media: {
          payload: this.holdAudioBuffer,
        },
      })
    );

    // Optional: Send checkpoint for hold music
    if (!this.assertTurnActive(scheduledTurn)) return;
    if (!this.ws || this.ws.readyState !== 1) return;
    this.ws.send(
      JSON.stringify({
        streamSid: this.streamId,
        event: 'mark',
        mark: {
          name: `hold_${holdTaskId}`
        }
      })
    );
  }

  stopHoldMusic() {
    if (this.holdMusicInterval) {
      clearTimeout(this.holdMusicInterval);
      this.holdMusicInterval = null;
    }

    if (this.holdMode) {
      console.log('Stopping hold music...');
      this.setHoldMode(false);
    }
  }

  stopCurrentAudio(cancelledResponseId) {
    if (this.currentAudioTask) {
      console.log(`Stopping current audio task: ${this.currentAudioTask}`);
      this.currentAudioTask = null;
      this.silentMode = true;
      this._cancelledResponseId = cancelledResponseId || null;
      console.log('Entering silent mode due to interruption.');
      this.interrupted = true;
    } else {
      console.log('No current audio task to stop.');
    }

    // Always send clear to Twilio regardless of currentAudioTask state.
    // During tail-playback (audio_done fired but caller still hearing audio),
    // currentAudioTask is null but Twilio may still be playing queued audio.
    this.stopPlayback();
    this.stopHoldMusic();
  }

  /**
   * Clear stale currentAudioTask after normal audio completion (audio_done).
   * Without this, a subsequent speech_started → stopCurrentAudio() finds the
   * stale task, sets silentMode = true, and the bot goes permanently silent
   * if the transcript is filtered (garble/noise) with no response to break out.
   */
  clearAudioTask() {
    if (this.currentAudioTask) {
      this.currentAudioTask = null;
    }
  }

  handleInterruption() {
    console.log('User interrupted! Stopping current TTS playback.');
    this.stopCurrentAudio();
    this.emit("interrupt");
  }

  stopPlayback() {
    console.log('Forcing Twilio to stop audio playback immediately.');
    if (!this.ws || this.ws.readyState !== 1) return;
    if (!this.streamId) return;
    if (this.turnStateRef && this.turnStateRef.isClosed) return;
    this.ws.send(
      JSON.stringify({
        streamSid: this.streamId,
        event: 'clear',
      })
    );
  }

  // Method to reload hold music if needed
  async reloadHoldMusic() {
    await this.loadHoldMusic();
  }

  // Method to check if hold music is available
  isHoldMusicAvailable() {
    return this.holdAudioBuffer !== null && this.holdMusicDuration > 0;
  }

  // Method to get current hold status
  isInHoldMode() {
    return this.holdMode;
  }
}

module.exports = { StreamServiceTwilio };