const MAX_QUEUE = 10000;
const MAX_RETRIES = 3;
const telemetry = require('../Utils/telemetry');

const state = {
  running: false,
  queue: null,
  workerStarted: false
};

function ensureQueue() {
  if (!state.queue) {
    state.queue = [];
  }
  return state.queue;
}

function enqueue(job) {
  const queue = ensureQueue();

  if (queue.length >= MAX_QUEUE) {
    console.warn("Write queue overflow – dropping job");
    telemetry.emit('write_queue_full', {
      jobType: job?.type || 'unknown',
      callId: job?.callSID || null,
      provider: job?.provider || null,
      queueLength: queue.length,
      ts: Date.now()
    });
    return false;
  }

  queue.push({ job, retries: 0 });
  return true;
}

async function start(handler) {
  if (state.workerStarted) return;

  state.workerStarted = true;
  state.running = true;

  while (state.running) {
    const queue = ensureQueue();
    const item = queue.shift();

    if (!item) {
      await new Promise(r => setTimeout(r, 25));
      continue;
    }

    try {
      await handler(item.job);
    } catch (err) {
      if (item.retries < MAX_RETRIES) {
        item.retries++;
        queue.push(item);
      } else {
        console.error("Write permanently failed", err);
      }
    }
  }

  state.workerStarted = false;
}

function stop() {
  state.running = false;
}

/**
 * Gracefully drain the queue: wait until all enqueued jobs have been
 * processed (or permanently failed) before resolving.  If the worker is not
 * running this resolves immediately.
 *
 * @param {number} [timeoutMs=5000] - Maximum ms to wait before giving up.
 * @returns {Promise<void>}
 */
function drain(timeoutMs = 5000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      const queue = state.queue;
      if (!queue || queue.length === 0) return resolve();
      if (Date.now() >= deadline) {
        console.warn(`[WriteQueue] drain timeout — ${queue.length} job(s) abandoned`);
        telemetry.emit('write_queue_abandoned', {
          count: queue.length,
          ts: Date.now()
        });
        return resolve();
      }
      setTimeout(check, 25);
    };
    check();
  });
}

module.exports = { enqueue, start, stop, drain };
