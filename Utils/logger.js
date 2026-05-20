// utils/telemetry/logger.js

const fs = require("fs");
const telemetryAdapter = require("../adapters/telemetry/telemetryAdapter");
const { sanitizeValue } = require("./structuredLogger");

const ENABLED = process.env.VOICEBOT_TELEMETRY === "true";
const LOG_DIR = "./logs";
const LOG_FILE = "./logs/voicebot-events.jsonl";

const MAX_BUFFER_SIZE = 1000;
const FLUSH_INTERVAL_MS = 1000;
const MAX_FILE_SIZE_MB = 50;

// Mutable runtime state container (avoids top-level let declarations)
const runtimeState = {
  flushTimer: null,
  cleanupTimer: null,
  buffer: [],
  stream: null,
  flushing: false,
  droppedEvents: 0,
  timelines: new Map()
};

const TIMELINE_LIMIT = 200;

const DRIFT_MAX_SPEECH_WITHOUT_CANCEL = 3;
const DRIFT_MAX_UNLOCKS_PER_CALL = 10;
const CALL_TIMELINE_TTL_MS = 5 * 60 * 1000; // cleanup orphaned timelines after 5 minutes

function init() {
  if (!ENABLED) return;

  telemetryAdapter.init();

  try {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }

    rotateIfNeeded();
    runtimeState.stream = fs.createWriteStream(LOG_FILE, {
      flags: "a",
      highWaterMark: 1024 * 1024
    });

    runtimeState.stream.on("error", (err) => {
      console.error("[Telemetry Stream Error]", err.message);
    });

    runtimeState.flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);
    runtimeState.flushTimer.unref();

    runtimeState.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [cid, tl] of runtimeState.timelines) {
        if (tl.length && now - tl[0].ts > CALL_TIMELINE_TTL_MS) {
          runtimeState.timelines.delete(cid);
        }
      }
    }, 60000);
    runtimeState.cleanupTimer.unref();
  } catch (err) {
    console.error("[Telemetry Init Error]", err.message);
  }
}

function getLifecycleEvents() {
  if (!module.exports.__lifecycleEvents) {
    module.exports.__lifecycleEvents = new Set([
      "speech_playback_started",
      "speech_emitted",
      "speech_completed",
      "hangup_triggered",
      "call_summary",       // normal-disconnect analytics — must never be dropped
      "response_latency"    // per-turn UX metric — must never be dropped
    ]);
  }
  return module.exports.__lifecycleEvents;
}

function emit(eventType, callId, turnId, payload = {}) {
  if (!ENABLED) return;

  if (!runtimeState.stream) init();
  const safePayload = sanitizeValue(payload && typeof payload === "object" ? payload : {});

  try {
    if (runtimeState.buffer.length >= MAX_BUFFER_SIZE) {
      if (getLifecycleEvents().has(eventType)) {
        runtimeState.buffer.shift(); // make room for critical event
        runtimeState.buffer.push({
          timestamp: Date.now(),
          eventType,
          callId,
          turnId,
          payload: safePayload
        });
      } else {
        runtimeState.droppedEvents++;
      }
    } else {
      runtimeState.buffer.push({
        timestamp: Date.now(),
        eventType,
        callId,
        turnId,
        payload: safePayload
      });
    }

    if (callId && typeof callId === "string") {
      const now = Date.now();

      let timeline = runtimeState.timelines.get(callId);
      if (runtimeState.timelines.size > 10000) {
        // emergency cleanup to prevent memory exhaustion
        runtimeState.timelines.clear();
      }
      if (!timeline) {
        timeline = [];
        runtimeState.timelines.set(callId, timeline);
      }

      timeline.push({
        ts: Date.now(),
        event: eventType,
        turnId,
        epoch: safePayload && safePayload.turnEpoch ? safePayload.turnEpoch : null
      });

      if (timeline.length > TIMELINE_LIMIT) timeline.shift();
    }

    // Drift detection fires on both explicit hangup and normal call_summary disconnect.
    // Previously only "hangup_triggered" was checked — making drift dead for the vast
    // majority of calls that end via a clean disconnect (no explicit hangup event).
    if ((eventType === "hangup_triggered" || eventType === "call_summary") && callId) {
      const timeline = runtimeState.timelines.get(callId);
      if (timeline) {
        // ---- Behavior drift detection ----
        let speechEmitted = 0;
        let speechCancelled = 0;
        let unlocks = 0;
        let speechStarted = 0;
        let speechStopped = 0;
        let epochSet = new Set();
        let playbackLatencyMs = null;
        let maxPlaybackLatencyMs = 0;
        let missingPlaybackStarts = 0;
        let earlyJitterEvents = 0;
        let jitterVarianceAccumulator = 0;
        let jitterSamples = 0;
        let ewmaLatency = null; // exponential moving average for latency trend detection
        const EWMA_ALPHA = 0.25;
        let prevLatency = null; // previous playback latency
        let latencyVolatilityEvents = 0; // large oscillations between emissions

        let driftFlags = [];
        for (let i = 0; i < timeline.length; i++) {
          const e = timeline[i];

          if (e.event === "speech_emitted") speechEmitted++;
          if (e.event === "speech_cancelled") speechCancelled++;
          if (e.event === "unlock_granted") unlocks++;
          if (e.event === "user_speech_started") speechStarted++;
          if (e.event === "user_speech_stopped") speechStopped++;
          if (e.epoch !== null) epochSet.add(e.epoch);

          // Detect playback lifecycle: speech_playback_started → speech_emitted → speech_completed
          if (e.event === "speech_playback_started") {
            const emitted = timeline[i + 1];

            if (emitted && emitted.event === "speech_emitted") {
              const latency = emitted.ts - e.ts;
              playbackLatencyMs = latency;

              if (latency > maxPlaybackLatencyMs) {
                maxPlaybackLatencyMs = latency;
              }

              if (latency > 120) {
                earlyJitterEvents++;
              }

              jitterVarianceAccumulator += latency;
              jitterSamples++;

              if (ewmaLatency === null) {
                ewmaLatency = latency;
              } else {
                ewmaLatency = (EWMA_ALPHA * latency) + (1 - EWMA_ALPHA) * ewmaLatency;
              }

              if (prevLatency !== null) {
                const delta = Math.abs(latency - (ewmaLatency || latency));
                if (delta > 120) {
                  latencyVolatilityEvents++;
                }
              }

              prevLatency = latency;

            } else {
              // playback started but no emitted event followed
              missingPlaybackStarts++;
            }
          }

          // Detect playback completion timing
          if (e.event === "speech_completed") {
            const prev = timeline[i - 1];
            if (prev && prev.event === "speech_emitted") {
              const completionLatency = e.ts - prev.ts;

              if (completionLatency > 800) {
                driftFlags.push("slow_playback_completion");
              }
            }
          }
        }


        // AI speaking over user repeatedly
        if (Math.max(0, speechEmitted - speechCancelled) > DRIFT_MAX_SPEECH_WITHOUT_CANCEL) {
          driftFlags.push("speech_overlap");
        }

        // Unlock loop or STT hallucination loop
        if (unlocks > DRIFT_MAX_UNLOCKS_PER_CALL) {
          driftFlags.push("unlock_loop");
        }

        // AI never spoke during call
        if (speechEmitted === 0) {
          driftFlags.push("speech_starvation");
        }

        // User speech fragmentation or STT instability
        if ((speechStarted > 0 && speechStopped === 0) || (speechStarted - speechStopped > 3)) {
          driftFlags.push("speech_fragmentation");
        }

        // Call ended without meaningful interaction
        if (timeline.length < 3) {
          driftFlags.push("empty_call");
        }

        // Cross-epoch emission detection (possible ghost audio)
        if (epochSet.size > 1) {
          driftFlags.push("cross_epoch_emission");
        }

        // Telecom jitter detection (high playback start latency)
        if (maxPlaybackLatencyMs > 300) {
          driftFlags.push("telecom_jitter");
        }

        // Early carrier jitter predictor (detect before users hear delay)
        if (earlyJitterEvents >= 2) {
          driftFlags.push("early_carrier_jitter");
        }

        // EWMA latency predictor (detects gradual carrier degradation)
        if (ewmaLatency !== null && ewmaLatency > 160) {
          driftFlags.push("carrier_latency_trend");
        }

        // Latency volatility (rapid oscillation → unstable routing / jitter buffers)
        if (latencyVolatilityEvents >= 2) {
          driftFlags.push("latency_volatility");
        }

        // Packet loss / RTP drop detection
        if (missingPlaybackStarts >= 2) {
          driftFlags.push("possible_packet_loss");
        }

        // Compute jitter average for diagnostics.
        const avgPlaybackLatencyMs = jitterSamples > 0
          ? Math.round(jitterVarianceAccumulator / jitterSamples)
          : 0;

        // ---- Carrier quality score (0–100) ----
        let carrierQualityScore = 100;

        // latency penalties
        if (avgPlaybackLatencyMs > 120) carrierQualityScore -= 10;
        if (avgPlaybackLatencyMs > 180) carrierQualityScore -= 15;
        if (avgPlaybackLatencyMs > 250) carrierQualityScore -= 20;

        // jitter penalties
        if (earlyJitterEvents >= 2) carrierQualityScore -= 10;

        // volatility penalties
        if (latencyVolatilityEvents >= 2) carrierQualityScore -= 15;

        // packet loss penalty
        if (missingPlaybackStarts > 0) carrierQualityScore -= 25;

        if (carrierQualityScore < 0) carrierQualityScore = 0;

        if (driftFlags.length > 0) {
          try {
            if (runtimeState.buffer.length >= MAX_BUFFER_SIZE) {
              runtimeState.droppedEvents++;
            } else {
              runtimeState.buffer.push({
                timestamp: Date.now(),
                eventType: "behavior_drift_detected",
                callId,
                turnId: null,
                payload: {
                  driftFlags,
                  speechEmitted,
                  speechCancelled,
                  unlocks,
                  speechStarted,
                  speechStopped,
                  playbackLatencyMs,
                  maxPlaybackLatencyMs,
                  avgPlaybackLatencyMs,
                  earlyJitterEvents,
                  ewmaLatencyMs: ewmaLatency ? Math.round(ewmaLatency) : 0,
                  latencyVolatilityEvents,
                  missingPlaybackStarts,
                  carrierQualityScore,
                  timelineLength: timeline.length,
                  epochCount: epochSet.size
                }
              });
            }
          } catch {}
        }
        // ---- End drift detection ----
        try {
          if (runtimeState.buffer.length >= MAX_BUFFER_SIZE) {
            runtimeState.droppedEvents++;
          } else {
            runtimeState.buffer.push({
              timestamp: Date.now(),
              eventType: "call_timeline",
              callId,
              turnId: null,
              payload: { timeline }
            });
          }
        } catch {}

        runtimeState.timelines.delete(callId);
      }
    }
  } catch (err) {
    // Never throw
  }
}

function flush() {
  if (!ENABLED || runtimeState.flushing || runtimeState.buffer.length === 0) return;
  if (!runtimeState.stream) return;

  runtimeState.flushing = true;

  const batch = runtimeState.buffer.splice(0, Math.min(runtimeState.buffer.length, 500));

  telemetryAdapter.emitBatch(batch);

  try {
    const lines = batch
      .map(e => {
        try {
          return JSON.stringify(e);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .join("\n") + "\n";

    // Runtime rotation check (minimal overhead – only when flushing)
    try {
      const stats = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE) : null;
      if (stats && stats.size / (1024 * 1024) >= MAX_FILE_SIZE_MB) {
          runtimeState.stream.end();
          const rotatedName = `${LOG_FILE}.${Date.now()}`;
          fs.renameSync(LOG_FILE, rotatedName);
          runtimeState.stream = fs.createWriteStream(LOG_FILE, {
            flags: "a",
            highWaterMark: 1024 * 1024
          });
          runtimeState.stream.on("error", (err) => {
            console.error("[Telemetry Stream Error]", err.message);
          });
      }
    } catch {}

      const canWrite = runtimeState.stream.write(lines);

      if (!canWrite) {
        runtimeState.stream.once("drain", () => {
          runtimeState.flushing = false;
        });
      } else {
        runtimeState.flushing = false;
      }
  } catch {
      runtimeState.flushing = false;
  }
}

function close() {
  if (!ENABLED) return;

  try {
    if (runtimeState.flushTimer) {
      clearInterval(runtimeState.flushTimer);
      runtimeState.flushTimer = null;
    }
    if (runtimeState.cleanupTimer) {
      clearInterval(runtimeState.cleanupTimer);
      runtimeState.cleanupTimer = null;
    }

    if (runtimeState.droppedEvents > 0) {
      try {
        emit("telemetry_dropped_events", null, null, { droppedEvents: runtimeState.droppedEvents });
      } catch {}
      console.warn(`[Telemetry] Dropped events: ${runtimeState.droppedEvents}`);
    }

    flush();
    if (runtimeState.stream) {
      runtimeState.stream.end(() => {});
      runtimeState.stream = null;
    }

    telemetryAdapter.shutdown();
  } catch {}
}

function rotateIfNeeded() {
  try {
    if (!fs.existsSync(LOG_FILE)) return;

    const stats = fs.statSync(LOG_FILE);
    const sizeMB = stats.size / (1024 * 1024);

    if (sizeMB >= MAX_FILE_SIZE_MB) {
      const rotatedName = `${LOG_FILE}.${Date.now()}`;
      fs.renameSync(LOG_FILE, rotatedName);
    }
  } catch {
    // ignore rotation errors
  }
}


module.exports = {
  init,
  emit,
  close
};