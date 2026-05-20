const UserRepository = require('../repositories/UserRepository');
const ConversationRepository = require('../repositories/ConversationRepository');
const path = require('path');
const fs = require('fs');
const CallRegistry = require('../services/CallRegistry');
const { parseE164CountryCode, normalizeTransferNumber } = require('../Utils/phoneUtils');
const plivoStatus = require('../Helper/PlivoStatusHandler');
const { getPersonaLanguage, resolveLegacy, listPersonas } = require('../personas/registry');
const TwilioProvider = require('../adapters/telecom/TwilioProvider');
const PlivoProvider = require('../adapters/telecom/PlivoProvider');
const { evaluateOutboundCallCompliance } = require('../services/outboundCallCompliance');
const { normalizeBookingWebhookPayloads } = require('../services/bookingLinkProvider');
const {
    normalizeTwilioStatus,
    normalizeTwilioTransferAction,
    normalizePlivoDialEvent,
    recordProviderStatus,
    recordTransferLegStatus
} = require('../services/telecomStatusService');
const CallContextStore = require('../services/CallContextStore');
const writeQueue = require('../services/writeQueue');
const workflowOperations = require('../services/workflowOperationsService');
const workflowReleaseEvidence = require('../services/workflowReleaseEvidenceService');
const telemetry = require('../Utils/telemetry');
const { buildRevenueMetrics } = require('../Utils/businessMetrics');
const { pool } = require('../services/db');

// ─── In-flight call idempotency guard (30s TTL) ─────────────────────────────
const _inflightCalls = new Map();
const INFLIGHT_TTL_MS = 30000;
function _markInflight(phoneNumber) {
    if (_inflightCalls.has(phoneNumber)) return false; // duplicate
    _inflightCalls.set(phoneNumber, Date.now());
    setTimeout(() => _inflightCalls.delete(phoneNumber), INFLIGHT_TTL_MS);
    return true;
}
function _clearInflight(phoneNumber) { _inflightCalls.delete(phoneNumber); }

function parsePagination(query = {}) {
    const limitRaw = Number.parseInt(query.limit, 10);
    const offsetRaw = Number.parseInt(query.offset, 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 100;
    const offset = Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0;
    return { limit, offset };
}

function serveHtmlWithNonce(filePath, res) {
    const html = fs.readFileSync(filePath, 'utf8');
    const nonce = res.locals.cspNonce;
    const patched = html.replace(/<script(?=[\s>])/gi, `<script nonce="${nonce}"`);
    res.type('html').send(patched);
}

const TWILIO_CALL_SID_REGEX = /^CA[0-9a-fA-F]{32}$/;
const PLIVO_CALL_UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

function normalizeProviderName(provider) {
    if (provider == null) return null;
    const value = String(provider).trim().toLowerCase();
    if (!value) return null;
    if (value === 'twilio' || value === 'plivo') return value;
    return null;
}

function validateProviderSpecificCallId(callId, provider) {
    const normalizedCallId = String(callId || '').trim();

    if (provider === 'twilio') {
        return {
            ok: TWILIO_CALL_SID_REGEX.test(normalizedCallId),
            expected: 'Twilio CallSid pattern ^CA[0-9a-fA-F]{32}$'
        };
    }

    if (provider === 'plivo') {
        return {
            ok: PLIVO_CALL_UUID_REGEX.test(normalizedCallId),
            expected: 'Plivo call_uuid/request_uuid RFC 4122 UUID pattern'
        };
    }

    return {
        ok: TWILIO_CALL_SID_REGEX.test(normalizedCallId) || PLIVO_CALL_UUID_REGEX.test(normalizedCallId),
        expected: 'Twilio CallSid (^CA[0-9a-fA-F]{32}$) or Plivo UUID'
    };
}

function escapeXml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function readBoundedInteger(value, defaultValue, { min = 1, max = 600 } = {}) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return defaultValue;
    return Math.min(Math.max(parsed, min), max);
}

function readPositiveIntegerString(value) {
    const raw = Array.isArray(value) ? value[0] : value;
    const text = String(raw || '').trim();
    if (!/^\d+$/.test(text) || /^0+$/.test(text)) return null;
    return text;
}

function readCsvList(value) {
    if (Array.isArray(value)) return value.flatMap(readCsvList);
    if (value == null || String(value).trim() === '') return undefined;
    return String(value)
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
}

function readBooleanFlag(value, defaultValue = true) {
    const raw = Array.isArray(value) ? value[0] : value;
    if (raw == null || raw === '') return defaultValue;
    return !/^(0|false|off|no)$/i.test(String(raw).trim());
}

function buildPublicUrl(pathname, params = {}) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value != null && String(value).trim() !== '') query.set(key, String(value));
    }
    const suffix = query.toString() ? `?${query.toString()}` : '';
    return `https://${process.env.NETWORK_URL}${pathname}${suffix}`;
}

function isValidPolicyConfig(policyConfig) {
    if (policyConfig == null) return true;
    if (typeof policyConfig !== 'object' || Array.isArray(policyConfig)) return false;

    const allowedTopKeys = new Set(['voicemail', 'screening', 'fallbackLanguage', 'isoCountryCode']);
    const keys = Object.keys(policyConfig);
    if (keys.some((key) => !allowedTopKeys.has(key))) return false;

    const validateChannel = (value) => {
        if (value == null) return true;
        if (typeof value !== 'object' || Array.isArray(value)) return false;
        const channelKeys = Object.keys(value);
        if (channelKeys.some((key) => !['enabled', 'language', 'text'].includes(key))) return false;
        if (value.enabled != null && typeof value.enabled !== 'boolean') return false;
        if (value.language != null && typeof value.language !== 'string') return false;
        if (value.text != null && typeof value.text !== 'string') return false;
        return true;
    };

    if (!validateChannel(policyConfig.voicemail)) return false;
    if (!validateChannel(policyConfig.screening)) return false;
    if (policyConfig.fallbackLanguage != null && typeof policyConfig.fallbackLanguage !== 'string') return false;
    if (policyConfig.isoCountryCode != null && !/^\d{1,4}$/.test(String(policyConfig.isoCountryCode))) return false;
    return true;
}


exports.incoming_twilio = async (req, res) => {
    console.log('Incoming route hit');
    res.set('Content-Type', 'text/xml').send(TwilioProvider.incomingCallXml(process.env.NETWORK_URL));
};

exports.incoming_plivo = async (req, res) => {
    console.log('[incoming_plivo] Answer URL hit, returning Stream XML');

    // Plivo answer URL includes call metadata — register the call so the
    // WebSocket session has recipient, persona, language, etc. available.
    const callUUID = req.body?.CallUUID || req.query?.CallUUID;
    const from     = req.body?.From      || req.query?.From;
    const to       = req.body?.To        || req.query?.To;

    if (callUUID && !CallRegistry.get(callUUID)) {
        // Check if PlivoProvider parked metadata for this phone number
        // (happens when the API returned no UUID).
        const pending = PlivoProvider.consumePendingCallMeta(to) || PlivoProvider.consumePendingCallMeta(from);
        if (pending) {
            CallRegistry.create(callUUID, {
                ...pending,
                callId: callUUID,
                sid: callUUID,
                recipient: to || from || pending.recipient,
                status: 'connected',
                provider: 'plivo'
            });
            await CallContextStore.upsertInitialContext(callUUID, {
                ...pending,
                provider: 'plivo',
                phoneNumber: to || from || pending.recipient,
            });
        } else {
            const fallbackRecipient = to || from || null;
            const fallbackPersona = process.env.DEFAULT_PERSONA || 'company-sales';
            const fallbackLanguage = process.env.DEFAULT_LANGUAGE || 'en';
            CallRegistry.create(callUUID, {
                callId: callUUID,
                sid: callUUID,
                recipient: fallbackRecipient,
                phoneNumber: fallbackRecipient,
                startedAt: Date.now(),
                transcript: [],
                voicemail: 'false',
                interested: 'false',
                name: null,
                persona: fallbackPersona,
                language: fallbackLanguage,
                aiProvider: null,
                contextHint: null,
                policyConfig: null,
                requireExplicitRecordingConsent: false,
                timestamp: new Date().toISOString(),
                createdAt: Date.now(),
                status: 'connected',
                provider: 'plivo'
            });
            await CallContextStore.upsertInitialContext(callUUID, {
                provider: 'plivo',
                phoneNumber: fallbackRecipient,
                name: null,
                persona: fallbackPersona,
                language: fallbackLanguage,
                aiProvider: null,
                contextHint: null,
                policyConfig: null,
                requireExplicitRecordingConsent: false
            });
        }
    }

    res.status(200).type('text/xml').send(PlivoProvider.incomingCallXml(process.env.NETWORK_URL));
};

exports.plivoStatusWebhook = async (req, res) => {
    return plivoStatus(req, res);
};

exports.bookingWebhookValidation = async (req, res) => {
    const token = req.query?.validationToken;
    if (!token) return res.status(400).json({ error: 'validationToken required' });
    return res.status(200).type('text/plain').send(String(token));
};

exports.bookingWebhook = async (req, res) => {
    if (req.query?.validationToken) return exports.bookingWebhookValidation(req, res);

    const normalizedEvents = normalizeBookingWebhookPayloads(req.body || {}, req.query?.provider);
    const validEvents = [];
    for (const normalized of normalizedEvents) {
        if (!normalized.ok) {
            telemetry.emit('booking_provider_error', {
                provider: normalized.provider || 'unknown',
                reason: normalized.reason,
                ts: Date.now()
            });
            continue;
        }
        validEvents.push(normalized);
    }

    if (!validEvents.length) {
        return res.status(202).json({ received: true, ignored: true });
    }

    for (const normalized of validEvents) {
        const isTerminalBooking = normalized.status === 'completed' || normalized.status === 'cancelled';
        if (isTerminalBooking && !normalized.callId) {
            const orphanReason = normalized.orphanReason || normalized.correlationReason || 'missing_booking_call_id';
            const orphanQueued = writeQueue.enqueue({
                type: 'persist_booking_webhook_orphan',
                provider: normalized.provider,
                externalBookingId: normalized.externalBookingId || null,
                eventType: normalized.eventType,
                status: normalized.status,
                rawCallSID: normalized.rawCallId || null,
                correlationStatus: normalized.correlationStatus || null,
                orphanReason,
            });

            telemetry.emit('booking_webhook_orphaned', {
                callId: null,
                provider: normalized.provider,
                providerEventType: normalized.eventType,
                status: normalized.status,
                externalBookingId: normalized.externalBookingId || null,
                rawCallIdPresent: !!normalized.rawCallId,
                bookingRefPresent: !!normalized.bookingRefPresent,
                correlationStatus: normalized.correlationStatus || null,
                reason: orphanReason,
                ts: Date.now()
            });

            if (!orphanQueued) {
                telemetry.emit('booking_provider_error', {
                    callId: null,
                    provider: normalized.provider,
                    reason: 'write_queue_full',
                    queueJob: 'persist_booking_webhook_orphan',
                    ts: Date.now()
                });
            }
            continue;
        }

        if (normalized.callId && CallRegistry.get(normalized.callId)) {
            CallRegistry.update(normalized.callId, {
                bookingStatus: normalized.status,
                bookingProvider: normalized.provider,
                externalBookingId: normalized.externalBookingId || null,
            });
        }

        if (normalized.callId) {
            await CallContextStore.patchContext(normalized.callId, {
                bookingStatus: normalized.status,
                bookingProvider: normalized.provider,
                externalBookingId: normalized.externalBookingId || null
            });
        }

        const queued = writeQueue.enqueue({
            type: 'persist_booking_event',
            callSID: normalized.callId || null,
            provider: normalized.provider,
            externalBookingId: normalized.externalBookingId || null,
            eventType: normalized.eventType,
            status: normalized.status,
        });

        if (!queued) {
            telemetry.emit('booking_provider_error', {
                callId: normalized.callId || null,
                provider: normalized.provider,
                reason: 'write_queue_full',
                ts: Date.now()
            });
        }

        if (normalized.callId && isTerminalBooking) {
            const outcomeQueued = writeQueue.enqueue({
                type: 'update_outcome_status',
                callSID: normalized.callId,
                outcome: normalized.status === 'completed' ? 'booking_completed' : 'booking_cancelled',
            });
            if (!outcomeQueued) {
                telemetry.emit('booking_provider_error', {
                    callId: normalized.callId,
                    provider: normalized.provider,
                    reason: 'write_queue_full',
                    queueJob: 'update_outcome_status',
                    ts: Date.now()
                });
            }
        }

        if (normalized.callId && normalized.status === 'completed') {
            telemetry.emit('booking_completed_webhook', {
                callId: normalized.callId || null,
                provider: normalized.provider,
                providerEventType: normalized.eventType,
                externalBookingId: normalized.externalBookingId || null,
                ...buildRevenueMetrics('booking_completed'),
                ts: Date.now()
            });
        }
    }

    return res.status(202).json({
        received: true,
        status: validEvents.length === 1 ? validEvents[0].status : 'processed',
        count: validEvents.length,
    });
};

// Plivo transfer endpoint — returns <Dial> XML to redirect the call to a human agent
exports.transfer_plivo = async (req, res) => {
    const normalized = normalizeTransferNumber(req.query.number || '');
    if (!normalized.ok) {
        return res.status(400).type('text/xml').send('<Response><Hangup/></Response>');
    }
    const attemptId = req.query.attemptId || null;
    const rootCallId = req.query.rootCallId || null;
    const mode = String(req.query.mode || '').toLowerCase();
    const confirmKey = req.query.confirmKey || process.env.WARM_TRANSFER_CONFIRM_KEY || '1';
    const timeoutSeconds = readBoundedInteger(req.query.timeoutSeconds, 20, { min: 5, max: 120 });
    const confirmTimeoutSeconds = readBoundedInteger(req.query.confirmTimeoutSeconds, 8, { min: 3, max: 60 });
    const callbackParams = { attemptId, rootCallId, confirmKey };
    const actionUrl = buildPublicUrl('/plivo-transfer-action', callbackParams);
    const callbackUrl = buildPublicUrl('/plivo-transfer-events', callbackParams);
    const confirmSound = buildPublicUrl('/plivo-transfer-confirm', { attemptId, rootCallId, confirmKey });
    const warmAttrs = mode === 'warm'
        ? ` confirmSound="${escapeXml(confirmSound)}" confirmKey="${escapeXml(confirmKey)}" confirmTimeout="${confirmTimeoutSeconds}"`
        : '';
    const xml = `<Response><Dial action="${escapeXml(actionUrl)}" method="POST" callbackUrl="${escapeXml(callbackUrl)}" callbackMethod="POST" timeout="${timeoutSeconds}"${warmAttrs}><Number>${escapeXml(normalized.number)}</Number></Dial></Response>`;
    res.status(200).type('text/xml').send(xml);
};

exports.plivoTransferConfirm = async (req, res) => {
    const confirmKey = req.query.confirmKey || process.env.WARM_TRANSFER_CONFIRM_KEY || '1';
    return res.status(200).type('text/xml').send(`<Response><Speak>Press ${escapeXml(confirmKey)} to accept this call.</Speak></Response>`);
};

exports.plivoTransferAction = async (req, res) => {
    const normalized = normalizePlivoDialEvent(req.body || {}, req.query || {});
    recordTransferLegStatus({ ...normalized, source: 'plivo-transfer-action' });
    return res.status(200).type('text/xml').send('<Response></Response>');
};

exports.plivoTransferEvents = async (req, res) => {
    const normalized = normalizePlivoDialEvent(req.body || {}, req.query || {});
    recordTransferLegStatus({ ...normalized, source: 'plivo-transfer-events' });
    return res.status(200).send('ok');
};

exports.call = async (req, res) => {
    if (!req.body) return res.status(400).json({ error: 'Invalid request body' });
    const { phoneNumber, name, contextHint, policyConfig, aiProvider } = req.body;
    let { persona, language } = req.body;

    // ─── Persona + language resolution ───────────────────────────────────────
    // New-style: both `persona` and `language` (ISO 639-1 code) are provided.
    // Legacy-style: only `language` (e.g. "english", "german", "Miami English").
    // If neither resolves to a valid persona+language, reject with 400.
    if (!persona && language) {
        const resolved = resolveLegacy(language);
        if (resolved) {
            persona  = resolved.persona;
            language = resolved.language;
        }
    }

    // Validate persona + language combo using the registry.
    // Returns 400 with a descriptive error if persona or language is unknown.
    if (!persona || !language) {
        console.error('Missing persona or language in /api/call request:', req.body);
        return res.status(400).json({
            error: 'Request must include "persona" and "language", or a recognised legacy "language" string.',
            example: { persona: 'company-sales', language: 'en' },
        });
    }

    try {
        getPersonaLanguage(persona, language); // throws if invalid
    } catch (err) {
        console.error('Invalid persona/language in /api/call:', err.message);
        return res.status(400).json({ error: err.message });
    }
    // ─────────────────────────────────────────────────────────────────────────

    if (!phoneNumber || !name || !/^\+\d{8,15}$/.test(phoneNumber)) {
        console.error("Invalid phone number or name:");
        return res.status(400).json({
            error: 'Invalid phone number or missing name'
        });
    }

    if (!isValidPolicyConfig(policyConfig)) {
        return res.status(400).json({ error: 'Invalid policyConfig shape' });
    }

    const countryCode = parseE164CountryCode(phoneNumber);

    if (!countryCode) {
        console.error("Unable to determine country code for phone number:", phoneNumber);
        return res.status(400).json({
            error: 'Invalid phone number or unable to determine country code'
        });
    }

    const compliance = await evaluateOutboundCallCompliance({ phoneNumber, persona, language });
    if (!compliance.allowed) {
        return res.status(compliance.statusCode || 403).json({
            error: compliance.error,
            reason: compliance.reason,
        });
    }

    let options = (contextHint != null || policyConfig != null || aiProvider != null)
        ? { contextHint: contextHint ?? null, policyConfig: policyConfig ?? null, aiProvider: aiProvider ?? null }
        : undefined;

    if (compliance.requireExplicitRecordingConsent) {
        options = options
            ? { ...options, requireExplicitRecordingConsent: true }
            : { requireExplicitRecordingConsent: true };
    }

    // Provider routing by country
    // India (country code 91) → Plivo
    // All other regions → Twilio
    const useTwilio = countryCode !== '91';

    // Idempotency guard — prevent duplicate calls to same number within 30s window
    if (!_markInflight(phoneNumber)) {
        console.warn(`Duplicate call attempt blocked for ${phoneNumber} (already in-flight)`);
        return res.status(409).json({ error: 'Call already in progress for this number' });
    }

    // Provider call with timeout protection
    const CALL_TIMEOUT_MS = 5000;

    async function callWithTimeout(fn) {
        let timer;
        return Promise.race([
            fn().then(result => { clearTimeout(timer); return result; }),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error("provider_timeout")), CALL_TIMEOUT_MS);
            })
        ]);
    }

    let details = null;
    let actualProvider = null;
    // Track the in-flight primary promise so we can cancel the call if fallback wins
    let primaryInflight = null;
    let primaryProvider = null;

    try {
        if (useTwilio) {
            primaryInflight = TwilioProvider.createCall(phoneNumber, name, persona, language, options);
            primaryProvider = 'twilio';
        } else {
            primaryInflight = PlivoProvider.createCall(phoneNumber, name, persona, language, options);
            primaryProvider = 'plivo';
        }
        // Prevent unhandled rejection if nobody else awaits this promise
        primaryInflight.catch(() => {});

        details = await callWithTimeout(() => primaryInflight);
        actualProvider = primaryProvider;
        primaryInflight = null; // resolved successfully, no cleanup needed

        // Provider returned successfully but UUID is pending (e.g. Plivo async API).
        // The call IS being placed — DO NOT fall back.
        if (details && !details.callSid) {
            console.log(`${actualProvider} call placed (UUID pending via answer URL) → ${phoneNumber}`);
            return res.status(200).json({ success: true, pending: true, phoneNumber });
        }
    } catch (err) {
        console.error("Primary provider failed or timed out:", err.message);

        // Cancel the timed-out primary call in the background once its API call resolves
        if (primaryInflight) {
            const hangupProvider = primaryProvider === 'plivo' ? PlivoProvider : TwilioProvider;
            primaryInflight
                .then(result => {
                    if (result?.callSid) {
                        console.log(`Cancelling timed-out ${primaryProvider} call: ${result.callSid}`);
                        return hangupProvider.hangup(result.callSid);
                    }
                })
                .catch(cancelErr => {
                    // Primary threw (e.g. network error) — nothing to cancel.
                    console.error(`Timed-out ${primaryProvider} call cleanup:`, cancelErr.message);
                });
            primaryInflight = null;
        }

        // Automatic fallback to the other provider
        try {
            if (useTwilio) {
                details = await callWithTimeout(() =>
                    PlivoProvider.createCall(phoneNumber, name, persona, language, options)
                );
                actualProvider = 'plivo';
            } else {
                details = await callWithTimeout(() =>
                    TwilioProvider.createCall(phoneNumber, name, persona, language, options)
                );
                actualProvider = 'twilio';
            }

            console.log("Fallback provider succeeded");

            // Fallback also returned pending UUID
            if (details && !details.callSid) {
                console.log(`${actualProvider} fallback call placed (UUID pending) → ${phoneNumber}`);
                return res.status(200).json({ success: true, pending: true, phoneNumber });
            }
        } catch (fallbackErr) {
            console.error("Fallback provider also failed:", fallbackErr.message);
        }
    }

    if (details && details.callSid) {
    console.log(`Call ${details.callSid} initiated successfully with ${actualProvider}`);

    let existing = CallRegistry.get(details.callSid);
    const requireExplicitRecordingConsent =
        options?.requireExplicitRecordingConsent ?? existing?.requireExplicitRecordingConsent ?? false;

    if (!existing) {
        CallRegistry.create(details.callSid, {
            callId: details.callSid,
            createdAt: Date.now(),
            status: "initiated"
        });
    }

    const updated = CallRegistry.update(details.callSid, {
        provider: actualProvider,
        phoneNumber,
        name,
        persona,
        language,
        aiProvider: aiProvider ?? null,
        requireExplicitRecordingConsent
    });

    await CallContextStore.upsertInitialContext(details.callSid, {
        provider: actualProvider,
        phoneNumber,
        name,
        persona,
        language,
        aiProvider: aiProvider ?? null,
        contextHint: options?.contextHint ?? null,
        policyConfig: options?.policyConfig ?? null,
        requireExplicitRecordingConsent
    });

    if (!updated) {
        console.warn('[CallRegistry] Update failed, recreating entry for:', details.callSid);

        CallRegistry.create(details.callSid, {
            provider: actualProvider,
            phoneNumber,
            name,
            persona,
            language,
            aiProvider: aiProvider ?? null,
            requireExplicitRecordingConsent,
            createdAt: Date.now(),
            status: "initiated"
        });
    }

    return res.status(200).json({ success: true, ...details });
}

    console.error('Failed to create call - no SID returned');
    _clearInflight(phoneNumber);
    return res.status(500).json({ success: false, msg: "error while initiating call" });
};

exports.health = async (req, res) => {
    const requiredBaseEnv = ['DB_HOST', 'DB_USER', 'DB_NAME', 'NETWORK_URL'];
    const missingBaseEnv = requiredBaseEnv.filter((k) => !process.env[k]);

    const twilioConfigured = Boolean(process.env.TWILIO_ACCOUNT_SID && (process.env.TWILIO_ACCOUNT_AUTH_TOKEN || process.env.TWILIO_AUTH_TOKEN));
    const plivoConfigured = Boolean(process.env.PLIVO_AUTH_ID && process.env.PLIVO_AUTH_TOKEN);

    const aiProvider = String(process.env.AI_PROVIDER || 'azure-realtime').trim().toLowerCase();
    let missingAiEnv = [];
    if (aiProvider === 'openai-realtime') {
        missingAiEnv = ['OPENAI_API_KEY'].filter((k) => !process.env[k]);
    } else if (aiProvider === 'azure-realtime' || aiProvider === 'legacy') {
        missingAiEnv = ['AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT'].filter((k) => !process.env[k]);
    }

    let dbOk = false;
    let dbError = null;
    try {
        await pool.query('SELECT 1');
        dbOk = true;
    } catch (err) {
        dbError = err.message;
    }

    const status = dbOk && missingBaseEnv.length === 0 && (twilioConfigured || plivoConfigured) && missingAiEnv.length === 0
        ? 'ok'
        : 'degraded';

    const response = {
        status,
        checks: {
            db: dbOk ? 'ok' : 'down',
            baseEnv: missingBaseEnv.length === 0 ? 'ok' : 'missing',
            telecomProvider: (twilioConfigured || plivoConfigured) ? 'ok' : 'missing',
            aiProviderEnv: missingAiEnv.length === 0 ? 'ok' : 'missing'
        },
        details: {
            missingBaseEnv,
            missingAiEnv,
            twilioConfigured,
            plivoConfigured,
            aiProvider,
            dbError
        }
    };

    return res.status(status === 'ok' ? 200 : 503).json(response);
}

exports.workflowReadiness = async (req, res) => {
    const readiness = await workflowOperations.getWorkflowReadiness({
        staleLockSeconds: readBoundedInteger(req.query?.staleLockSeconds, 120, { min: 1, max: 3600 }),
    });
    return res.status(readiness.ok ? 200 : 503).json(readiness);
}

exports.workflowActionSamples = async (req, res) => {
    const samples = await workflowOperations.getWorkflowActionSamples({
        workflowId: req.query?.workflowId,
        actionType: req.query?.actionType,
        statuses: readCsvList(req.query?.status || req.query?.statuses),
        limit: readBoundedInteger(req.query?.limit, 25, { min: 1, max: 100 }),
    });
    return res.json(samples);
}

exports.workflowReconciliation = async (req, res) => {
    const reconciliation = await workflowOperations.getWorkflowReconciliation({
        workflowId: req.query?.workflowId,
        actionType: req.query?.actionType,
        statuses: readCsvList(req.query?.status || req.query?.statuses),
        staleLockSeconds: readBoundedInteger(req.query?.staleLockSeconds, 120, { min: 1, max: 3600 }),
        limit: readBoundedInteger(req.query?.limit, 25, { min: 1, max: 100 }),
    });
    return res.status(reconciliation.ok ? 200 : 503).json(reconciliation);
}

exports.workflowReconciliationRequeue = async (req, res) => {
    const body = req.body || {};
    const result = await workflowOperations.requeueWorkflowReconciliation({
        workflowId: body.workflowId || req.query?.workflowId,
        actionType: body.actionType || req.query?.actionType,
        statuses: readCsvList(body.statuses || body.status || req.query?.status || req.query?.statuses),
        limit: readBoundedInteger(body.limit || req.query?.limit, 10, { min: 1, max: 25 }),
        lockTimeoutSeconds: readBoundedInteger(body.lockTimeoutSeconds || req.query?.lockTimeoutSeconds, 120, { min: 1, max: 3600 }),
        reason: body.reason || req.query?.reason || 'operator_reconciliation_requeue',
        dryRun: readBooleanFlag(body.dryRun ?? req.query?.dryRun, true),
        confirm: body.confirm || body.confirmation || req.query?.confirm || req.query?.confirmation,
    });

    if (result.ok) return res.json(result);
    if (result.status === 'missing_schema') return res.status(503).json(result);
    if (result.status === 'invalid_status_filter') return res.status(400).json(result);
    if (result.status === 'confirmation_required') return res.status(409).json(result);
    return res.status(500).json(result);
}

exports.workflowReleaseEvidence = async (req, res) => {
    const source = req.method === 'POST' ? (req.body || {}) : (req.query || {});
    const query = req.query || {};
    const report = await workflowReleaseEvidence.getWorkflowReleaseEvidence({
        staleLockSeconds: readBoundedInteger(source.staleLockSeconds || query.staleLockSeconds, 120, { min: 1, max: 3600 }),
        reconciliationLimit: readBoundedInteger(source.reconciliationLimit || source.limit || query.limit, 25, { min: 1, max: 100 }),
        thresholds: source.thresholds || {},
        evidence: source.evidence || source,
        now: source.now || query.now,
    });
    return res.json(report);
}

exports.workflowActionRequeue = async (req, res) => {
    const actionId = readPositiveIntegerString(req.params?.id);
    if (!actionId) return res.status(400).json({ ok: false, reason: 'invalid_action_id' });

    const result = await workflowOperations.requeueWorkflowAction({
        actionId,
        reason: req.body?.reason || req.query?.reason || 'operator_requeue',
        lockTimeoutSeconds: readBoundedInteger(req.body?.lockTimeoutSeconds || req.query?.lockTimeoutSeconds, 120, { min: 1, max: 3600 }),
    });
    if (result.ok) return res.json(result);
    if (result.reason === 'action_not_found') return res.status(404).json(result);
    return res.status(409).json(result);
}

exports.getConfig = (req, res) => {
    const base = process.env.DEMOBOT_BASE_URL;
    if (!base || !base.trim()) {
        return res.status(200).json({ demobotBaseUrl: null });
    }
    const origin = base.trim().replace(/\/+$/, '');
    let path = (process.env.DEMOBOT_PATH || '').trim().replace(/^\/*/, '').replace(/\/+$/, '');
    path = path ? '/' + path : '';
    const demobotBaseUrl = origin + path;
    return res.status(200).json({ demobotBaseUrl });
}

/**
 * Public demobot proxy — forwards the call request to the configured
 * DEMOBOT backend, injecting the API key server-side.
 * The browser never sees or handles the shared secret.
 */
exports.demobotCall = async (req, res) => {
    const base = process.env.DEMOBOT_BASE_URL;
    if (!base || !base.trim()) {
        return res.status(503).json({ error: 'Demobot backend not configured' });
    }
    const apiKey = process.env.APP_API_KEY;
    if (!apiKey) {
        return res.status(503).json({ error: 'Server misconfiguration' });
    }

    const origin = base.trim().replace(/\/+$/, '');
    let basePath = (process.env.DEMOBOT_PATH || '').trim().replace(/^\/*/, '').replace(/\/+$/, '');
    basePath = basePath ? '/' + basePath : '';
    const targetUrl = origin + basePath + '/api/call';

    try {
        const upstream = await fetch(targetUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
            },
            body: JSON.stringify(req.body),
        });
        const data = await upstream.json();
        return res.status(upstream.status).json(data);
    } catch (err) {
        console.error('[demobotCall] upstream error:', err.message);
        return res.status(502).json({ error: 'Unable to reach demobot backend' });
    }
}

exports.serveEnglishHtml = async (req, res) => {
    serveHtmlWithNonce(path.join(__dirname, '../Html/EnglishBot.html'), res);
}

exports.serveGermanHtml = async (req, res) => {
    serveHtmlWithNonce(path.join(__dirname, '../Html/GermanBot.html'), res);
}

exports.serveMiamiEnglishHtml = async (req, res) => {
    serveHtmlWithNonce(path.join(__dirname, '../Html/MiamiEnglishBot.html'), res);
}

exports.serveConversationHtml = async (req, res) => {
    serveHtmlWithNonce(path.join(__dirname, '../Html/conversation.html'), res);
}

exports.getUsers = async (req, res) => {
    try {
        const { limit, offset } = parsePagination(req.query);
        const rows = await UserRepository.getUsers(limit, offset);
        return res.status(200).json({ success: true, data: rows });
    } catch (error) {
        console.error('Error fetching users from users_demobot:', error);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
}

exports.getConversations = async (req, res) => {
    const { callSID } = req.query;
    const provider = normalizeProviderName(req.query.provider);

    if (!callSID) {
        return res.status(400).json({ success: false, error: 'callSID is required' });
    }

    if (req.query.provider != null && !provider) {
        return res.status(400).json({ success: false, error: 'Invalid provider; expected twilio or plivo' });
    }

    const validation = validateProviderSpecificCallId(callSID, provider);
    if (!validation.ok) {
        return res.status(400).json({
            success: false,
            error: `Invalid callSID format for provider. Expected ${validation.expected}`
        });
    }

    try {
        const { limit, offset } = parsePagination(req.query);
        const rows = await ConversationRepository.getByCallSID(callSID, limit, offset);
        return res.status(200).json({ success: true, data: rows });
    } catch (error) {
        console.error('Error fetching conversations:', error);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
}


exports.twilioStatus = (req, res) => {
    try {
        const payload = req.body || {};
        const normalized = normalizeTwilioStatus(payload);
        const result = recordProviderStatus({
            provider: 'twilio',
            callSID: normalized.callSID,
            status: normalized.status,
            payload,
            source: 'twilio-status'
        });

        if (!result.ok) {
            console.warn('[TwilioStatus] Received webhook with no recognizable CallSid. Payload keys:', Object.keys(payload).join(', '));
            return res.status(200).send('ignored');
        }

        return res.status(200).send('ok');
    } catch (err) {
        console.error('[TwilioStatus] handler error:', err);
        return res.status(200).send('error handled');
    }
};

exports.twilioTransferAction = (req, res) => {
    try {
        const normalized = normalizeTwilioTransferAction(req.body || {}, req.query || {});
        recordTransferLegStatus(normalized);
        return res.status(200).type('text/xml').send('<Response></Response>');
    } catch (err) {
        console.error('[TwilioTransferAction] handler error:', err);
        return res.status(200).type('text/xml').send('<Response></Response>');
    }
};

exports.listPersonas = (req, res) => {
    try {
        return res.status(200).json({ success: true, data: listPersonas() });
    } catch (err) {
        console.error('Error listing personas:', err);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
};
