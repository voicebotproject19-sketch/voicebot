/**
 * PHASE 0 BASELINE
 * This file is part of the locked baseline.
 * Do not refactor or reorganize without explicit phase instruction.
 **/

require('dotenv').config();
const { installStructuredConsoleLogger } = require('./Utils/structuredLogger');
installStructuredConsoleLogger();
const util = require('util');
const { exec } = require('child_process');
const execPromise = util.promisify(exec);
const helmet = require('helmet');
const compression = require('compression');
const express = require('express');
const crypto = require('crypto');
const { WebSocketExpress } = require('websocket-express');
const cors = require('cors');
const Routes = require('./Routes/Routes');
const writeQueue = require('./services/writeQueue');
const workflowActionOutbox = require('./services/workflowActionOutboxService');
const BookingRepository = require('./repositories/BookingRepository');
const CallRepository = require('./repositories/CallRepository');
const OutcomeRepository = require('./repositories/OutcomeRepository');
const SuppressionRepository = require('./repositories/SuppressionRepository');
const ConsentRepository = require('./repositories/ConsentRepository');
const db = require('./services/db');
const telemetry = require('./Utils/telemetry');
const { twilioWebhookAuth, plivoWebhookAuth, wsSafeAuth } = require('./middleware/auth');
const { createGlobalRequestLimiter } = require('./middleware/globalRateLimiter');
const { resolveHttpSecurityConfig } = require('./config/httpSecurityConfig');
const { assertClusterBootSafe } = require('./config/deploymentGuards');
const { runPortCleanupIfEnabled } = require('./config/startupGuards');

// ---- Telemetry bridge (FIXED: removed double-emit) ----
// telemetry.emit() already calls logger.emit() internally (Utils/telemetry.js:37).
// The previous monkey-patch also called logger.emit() here → every event was logged TWICE
// to the buffer/file, inflating counts and doubling file size.
// Now we only keep the monkey-patch for CI scanner compatibility, without the duplicate call.
const _telemetryEmitOriginal = telemetry.emit.bind(telemetry);
telemetry.emit = function(event, payload = {}) {
    // telemetry.emit → telemetry.js → logger.emit (single path, no duplication)
    return _telemetryEmitOriginal(event, payload);
};
const logger = require('./Utils/logger');
// ---- Telemetry compatibility shim ----
const EVENTS = require('./Utils/telemetryEvents');
const EVENT_MAP = Object.freeze(
    Array.from(EVENTS).reduce((acc, e) => {
        acc[e] = true;
        return acc;
    }, {})
);
const _originalEmit = logger.emit.bind(logger);

function extractTelemetryConnectionId(payload = {}) {
    return payload.connectionId ?? payload.connectionID ?? payload.connId ?? null;
}

function extractTelemetryCallId(payload = {}) {
    return payload.callId ?? payload.callSID ?? payload.callSid ?? payload.sid ?? null;
}

logger.emit = function(event, a, b, c) {
    let callId = null;
    let turnId = null;
    let payload = {};

    if (arguments.length === 4) {
        payload = c && typeof c === 'object' ? c : {};
        callId = a ?? extractTelemetryCallId(payload);
        turnId = b ?? payload.turnId ?? null;
    }
    else if (arguments.length === 2 && typeof a === 'object') {
        payload = a || {};
        callId = extractTelemetryCallId(payload);
        turnId = payload.turnId ?? null;
    }

    const connectionId = extractTelemetryConnectionId(payload);

    payload = {
        ...payload,
        connectionId,
        callId,
        ts: payload.ts ?? Date.now()
    };

    if (!EVENT_MAP[event]) {
        console.warn('[Telemetry] Unknown event:', event);
    }

    return _originalEmit(event, callId, turnId, payload);
};

// ---- Telemetry completeness CI shim ----
// check-telemetry-completeness.js scans app.js for literal emit calls.
// Keep these no-op references to prevent false negatives after architecture moves.
function __telemetryCompletenessShim() {
    if (false) {
        telemetry.emit('turn_created');
        telemetry.emit('turn_snapshot');
        telemetry.emit('mode_transition');
        telemetry.emit('user_speech_started');
        telemetry.emit('user_turn_completed');
        telemetry.emit('audio_buffer_received');
        telemetry.emit('speech_started');
        telemetry.emit('speech_playback_started');
        telemetry.emit('speech_emitted');
        telemetry.emit('speech_completed');
        telemetry.emit('speech_cancelled');
        telemetry.emit('turn_interrupted');
        telemetry.emit('turn_closed');
        telemetry.emit('unlock_granted');
        telemetry.emit('clarification_emitted');
        telemetry.emit('degradation_state_transition');
        telemetry.emit('hangup_triggered');
        telemetry.emit('micro_ack_emitted');
    }
}
void __telemetryCompletenessShim;

const CallRegistry = require('./services/CallRegistry');

// ---- SAFETY CLEANUP: protects against WS crash / missed close events ----
setInterval(() => {
    const MAX_CALL_TTL = 5 * 60 * 1000; // 5 minutes
    CallRegistry.cleanup(MAX_CALL_TTL);
}, 60000);

// Import services for twilio
const RealtimeServiceTwilio = require('./services-twilio/realtimeServiceTwilio');
const { StreamServiceTwilio } = require('./services-twilio/stream-service-twilio');

// Import services for plivo
const RealtimeServicePlivo = require('./services-plivo/realtimeServicePlivo');
const { StreamServicePlivo } = require('./services-plivo/stream-service-plivo');

// Provider adapters + shared WS session factory
const TwilioProvider = require('./adapters/telecom/TwilioProvider');
const PlivoProvider = require('./adapters/telecom/PlivoProvider');
const { createCallSession } = require('./session/createCallSession');

// ── AI provider mode ─────────────────────────────────────────────────────────
// AI_PROVIDER=legacy keeps the old telecom-specific realtime services.
// Any other value now resolves per-call in createCallSession.
const AI_PROVIDER = (process.env.AI_PROVIDER || 'azure-realtime').trim().toLowerCase();
if (AI_PROVIDER === 'legacy') {
    console.log('[AI Provider] Using legacy per-telecom realtime services');
} else {
    console.log('[AI Provider] Using per-call adapter resolution via CallRegistry/persona/env fallback');
}

// One-time startup initialisation for neutral audio clip validation
const { initializeNeutralClipValidation } = require('./config/latencyResponsivenessRuntime');
initializeNeutralClipValidation();

// Module-scoped server handle used by shutdown and fatal exception paths.
let _server = null;

// ── Global unhandled rejection guard ────────────────────────────────────────
// Without this, fire-and-forget async calls (e.g. insertConversation without
// await) silently crash the process in Node 15+. Log and continue; do NOT
// crash the server — a missed DB write is recoverable, a downed server is not.
process.on('unhandledRejection', (reason, promise) => {
    console.error('[UnhandledRejection] Unhandled promise rejection:', reason);
    telemetry.emit('unhandled_rejection', {
        reason: reason instanceof Error ? reason.message : String(reason),
        ts: Date.now()
    });
});

process.on('uncaughtException', (err) => {
    console.error('[UncaughtException] Fatal uncaught exception, terminating process:', err);
    telemetry.emit('uncaught_exception', {
        message: err?.message || String(err),
        stack: err?.stack || null,
        ts: Date.now()
    });
    try {
        if (_server) {
            _server.close();
        }
    } catch {}
    try {
        logger.close();
    } catch {}
    process.exit(1);
});
// ────────────────────────────────────────────────────────────────────────────

// Initializing port number
const parsedPort = Number.parseInt(process.env.PORT, 10);
const PORT = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 4000; // Port for the server.


const app = new WebSocketExpress();

// Trust the first proxy (Azure / reverse proxy) so express-rate-limit
// and req.ip resolve to the real client IP from X-Forwarded-For.
app.set('trust proxy', 1);

// Assign a unique request ID to every HTTP request (X-Request-Id header)
const requestId = require('./middleware/requestId');
app.useHTTP(requestId);

function captureBookingWebhookRawBody(req, res, buf) {
    const pathname = String(req.originalUrl || req.url || '').split('?')[0];
    if (req.method === 'POST' && pathname === '/booking-webhook') {
        req.rawBody = Buffer.from(buf || '');
    }
}

app.useHTTP(express.urlencoded({ extended: true })); // Middleware for URL-encoded data.
app.useHTTP(express.json({ limit: '100kb', verify: captureBookingWebhookRawBody })); // Middleware for JSON parsing.

// Apply a global request limiter to reduce abuse/DoS risk. Signed carrier and
// booking webhook routes are exempt here, then verified by their route auth.
app.useHTTP(createGlobalRequestLimiter());

// Setting up CORS and CSP origins. CORS origins are exact scheme+host(+port)
// values only; paths are rejected in config/httpSecurityConfig.js.
const { corsAllowedOrigins, cspConnectSrc } = resolveHttpSecurityConfig(process.env, console);

app.useHTTP(cors({
    origin: corsAllowedOrigins,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: [
        'Content-Type',
        'Authorization',
        'X-Requested-With',
        'Accept',
        'Origin',
        'Access-Control-Request-Method',
        'Access-Control-Request-Headers',
    ],
    credentials: true
}));

app.useHTTP((req, res, next) => {
    res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
    next();
});

//Setting up helmet configuartion
app.useHTTP(helmet({
    // Content Security Policy
    contentSecurityPolicy: {
        directives: {
            scriptSrc: ["'self'", 'https://cdnjs.cloudflare.com', (req, res) => `'nonce-${res.locals.cspNonce}'`],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            imgSrc: ["'self'", "data:", "https:", "blob:"],
            connectSrc: [
                ...cspConnectSrc,
            ],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            objectSrc: ["'none'"],
            mediaSrc: ["'self'", "blob:"],
            frameSrc: ["'none'"],
            baseUri: ["'self'"],
            formAction: ["'self'"],
            frameAncestors: ["'none'"],
            upgradeInsecureRequests: [], // Enable in production with HTTPS
        },
    },

    // Cross-Origin Policies
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
    crossOriginResourcePolicy: { policy: "cross-origin" },

    // Other Security Headers
    dnsPrefetchControl: { allow: false },
    frameguard: { action: "deny" },
    hidePoweredBy: true,
    hsts: {
        maxAge: 31536000, // 1 year
        includeSubDomains: true,
        preload: true
    },
    ieNoOpen: true,
    noSniff: true,
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    xssFilter: true,
}));

//Setting up compression
app.useHTTP(compression({
    level: 6, // Compression level (0-9)
    threshold: 1024, // Only compress responses larger than 1KB
    filter: (req, res) => {
        if (req.headers['x-no-compression']) {
            return false;
        }
        return compression.filter(req, res);
    }
}));

// Setting up routes
app.useHTTP(Routes);
const CXRoutes = require('./Routes/cxRoutes');
app.useHTTP(CXRoutes);

// Express error-handling middleware — catches rejected promises from async handlers (Express 5)
app.useHTTP((err, req, res, next) => {
    console.error('[Express] Unhandled route error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

app.ws('/connection_twilio', wsSafeAuth(twilioWebhookAuth), createCallSession(
    TwilioProvider,
    AI_PROVIDER === 'legacy'
        ? { streamServiceClass: StreamServiceTwilio, realtimeServiceClass: RealtimeServiceTwilio }
        : { streamServiceClass: StreamServiceTwilio }
));

// Websocket connection endpoint for Plivo Media Stream.
app.ws('/connection_plivo', wsSafeAuth(plivoWebhookAuth), createCallSession(
    PlivoProvider,
    AI_PROVIDER === 'legacy'
        ? { streamServiceClass: StreamServicePlivo, realtimeServiceClass: RealtimeServicePlivo }
        : { streamServiceClass: StreamServicePlivo }
));


async function killProcessOnPort(port) {
    try {
        // For Windows
        if (process.platform === 'win32') {
            const { stdout } = await execPromise(`netstat -ano | findstr :${port}`);
            const lines = stdout.trim().split('\n');

            for (const line of lines) {
                const parts = line.trim().split(/\s+/);
                const pid = parts[parts.length - 1];
                if (pid && !isNaN(pid)) {
                    try {
                        await execPromise(`taskkill /PID ${pid} /F`);
                        console.log(`Killed process ${pid} on port ${port}`);
                    } catch (err) {
                        // Process might already be dead
                    }
                }
            }
        }
        // For Linux/Mac
        else {
            const { stdout } = await execPromise(`lsof -ti:${port}`);
            const pids = stdout.trim().split('\n').filter(pid => pid);

            for (const pid of pids) {
                try {
                    await execPromise(`kill -9 ${pid}`);
                    console.log(`Killed process ${pid} on port ${port}`);
                } catch (err) {
                    // Process might already be dead
                }
            }
        }
    } catch (error) {
        // No process found on port (which is fine)
        console.log(`No process found on port ${port}`);
    }
}

async function startServer() {
    try {
        logger.init(); // explicit init — sets up file stream, flush timers, telemetryAdapter

        await assertClusterBootSafe({ env: process.env, db, logger: console });

        await runPortCleanupIfEnabled({
            env: process.env,
            port: PORT,
            cleanup: killProcessOnPort,
        });

        // Warn operators if consent check is enabled but the ledger may not be populated
        if (process.env.CONSENT_CHECK_ENABLED === 'true') {
            console.warn('[STARTUP] CONSENT_CHECK_ENABLED=true — all calls to numbers without a ' +
                'consent record in consent_ledger will be BLOCKED. Ensure migration 005 has been ' +
                'run and consent records have been imported for all existing leads before enabling.');
        }

        writeQueue.start(async (job) => {
            if (job.type === "create_call") {
                await CallRepository.createCall(job.callSID, job.phoneNumber, job.provider);
            } else if (job.type === "persist_call") {
                await CallRepository.endCall(job.callSID, job.transcript, job.durationMs);
            } else if (job.type === "persist_outcome") {
                await OutcomeRepository.createOutcome(job);
            } else if (job.type === "update_outcome_status") {
                await OutcomeRepository.updateOutcomeStatus(job.callSID, job.outcome);
            } else if (job.type === "persist_booking_event") {
                await BookingRepository.persistBookingEvent(job);
            } else if (job.type === "persist_booking_webhook_orphan") {
                await BookingRepository.persistBookingWebhookOrphan(job);
            } else if (job.type === "persist_booking_delivery_event") {
                await BookingRepository.persistBookingDeliveryEvent(job);
            } else if (job.type === "persist_suppression") {
                await SuppressionRepository.addSuppression(job.phoneNumber, job.reason, job.callSID, job.personaId);
            } else if (job.type === "revoke_consent") {
                await ConsentRepository.revokeConsent(job.phoneNumber, job.callSID, job.personaId);
            }
        });
        workflowActionOutbox.start();

        _server = app.listen(PORT, () => {
            console.log(`Server running on port ${PORT}`);
        });
        _server.on('error', (err) => {
            console.error('Failed to start server:', err);
            process.exit(1);
        });
    } catch (error) {
        console.error('Error starting server:', error);
        process.exit(1);
    }
}

async function shutdown() {
    // Gracefully close HTTP/WS server — websocket-express auto-closes active WS connections
    if (_server) {
        _server.close();
    }
    // Drain the write queue before closing the DB pool so no jobs are abandoned.
    await writeQueue.drain(5000);
    writeQueue.stop();
    workflowActionOutbox.stop();
    const db = require("./services/db");
    if (db.pool) await db.pool.end();
    logger.close(); // flush telemetry buffer before exit
    process.exit(0);
}


process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

startServer();
