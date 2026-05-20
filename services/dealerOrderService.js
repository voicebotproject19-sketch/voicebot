'use strict';

const crypto = require('crypto');
const { parsePhoneNumberFromString } = require('libphonenumber-js');
const { createTwilioClient } = require('../adapters/telecom/twilioClient');
const { createPlivoClient } = require('../adapters/telecom/plivoClient');
const { parseE164CountryCode } = require('../Utils/phoneUtils');
const { formatOrderItems, parseDealerContextHint, sanitizeText } = require('../Helper/dealerOrderParser');
const { sendDealerOrderEmail } = require('../Helper/emailHelper');
const { isWithinCallingWindow } = require('./callingWindowCheck');
const telemetry = require('../Utils/telemetry');

const retryAttemptsByPhone = new Map();

function isTruthy(value) {
    return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function firstNonEmpty(...values) {
    return values.find(value => typeof value === 'string' && value.trim().length > 0)?.trim() || null;
}

function hashDestination(value) {
    if (!value) return null;
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function parseDeliveryOrder(value) {
    return String(value || 'sms,email')
        .split(',')
        .map(channel => channel.trim().toLowerCase())
        .filter(channel => channel === 'sms' || channel === 'email')
        .filter((channel, index, channels) => channels.indexOf(channel) === index);
}

function resolveDealerOrderConfig(env = process.env) {
    return {
        companyName: firstNonEmpty(env.DEALER_ORDER_COMPANY_NAME, 'Dealer Order Desk'),
        erpEndpoint: firstNonEmpty(env.DEALER_ORDER_ERP_ENDPOINT),
        erpAuthToken: firstNonEmpty(env.DEALER_ORDER_ERP_AUTH_TOKEN),
        selfServiceUrl: firstNonEmpty(env.DEALER_ORDER_SELF_SERVICE_URL),
        notificationEmail: firstNonEmpty(env.DEALER_ORDER_NOTIFICATION_EMAIL),
        ccEmail: firstNonEmpty(env.DEALER_ORDER_CC_EMAIL, env.FALLBACK_CC_EMAIL),
        deliveryOrder: parseDeliveryOrder(env.DEALER_ORDER_DELIVERY_ORDER),
        smsEnabled: isTruthy(env.DEALER_ORDER_SMS_ENABLED),
        emailEnabled: env.DEALER_ORDER_EMAIL_ENABLED == null || isTruthy(env.DEALER_ORDER_EMAIL_ENABLED),
        messagingProvider: String(firstNonEmpty(env.DEALER_ORDER_MESSAGING_PROVIDER, 'auto')).toLowerCase(),
        retryEnabled: isTruthy(env.DEALER_ORDER_RETRY_ENABLED),
        maxRetries: Math.max(0, Number.parseInt(env.DEALER_ORDER_MAX_RETRIES || '2', 10) || 0),
        retryDelayMs: Math.max(1000, Number.parseInt(env.DEALER_ORDER_RETRY_DELAY_MS || '300000', 10) || 300000),
        fallbackSmsEnabled: env.DEALER_ORDER_FALLBACK_SMS_ENABLED == null || isTruthy(env.DEALER_ORDER_FALLBACK_SMS_ENABLED),
        twilio: {
            accountSid: env.TWILIO_ACCOUNT_SID,
            authToken: env.TWILIO_ACCOUNT_AUTH_TOKEN || env.TWILIO_AUTH_TOKEN,
            from: firstNonEmpty(env.TWILIO_MESSAGING_FROM, env.TWILIO_FROM_NUMBER, env.TWILIO_PHONE_NUMBER),
            messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID,
        },
        plivo: {
            authId: env.PLIVO_AUTH_ID,
            authToken: env.PLIVO_AUTH_TOKEN,
            from: firstNonEmpty(env.PLIVO_MESSAGING_FROM, env.PLIVO_SOURCE_NUMBER, env.PLIVO_PHONE_NUMBER),
        },
    };
}

function normalizePhone(value, defaultCountry = 'US') {
    const raw = String(value || '').trim();
    if (!raw) return null;
    try {
        const parsed = parsePhoneNumberFromString(raw, defaultCountry || 'US');
        if (parsed && (parsed.isValid() || parsed.isPossible())) return parsed.number;
    } catch (_) {
        return null;
    }
    return null;
}

function normalizeEmail(value) {
    const email = String(value || '').trim().toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function buildOrderPayload(order = {}) {
    const crmContext = order.crmContext || parseDealerContextHint(order.contextHint);
    const dealerEmail = normalizeEmail(order.dealerEmail || crmContext.dealerEmail || order.userEmail);
    return {
        orderId: sanitizeText(order.orderId, 80),
        callId: sanitizeText(order.callId || order.callSID, 128) || null,
        personaId: sanitizeText(order.personaId || 'dealer-orders', 100),
        dealerId: sanitizeText(order.dealerId || crmContext.dealerId, 80) || null,
        dealerName: sanitizeText(order.dealerName || crmContext.dealerName, 160) || null,
        dealerPhone: sanitizeText(order.dealerPhone || order.callerNumber, 40) || null,
        dealerEmail,
        items: Array.isArray(order.items) ? order.items : [],
        itemSummary: formatOrderItems(order.items || []),
        crmContext,
        source: 'voicebot',
        confirmedAt: order.confirmedAt || new Date().toISOString(),
    };
}

async function postToErp(payload, config) {
    if (!config.erpEndpoint) {
        return { ok: false, status: 'skipped', reason: 'erp_unconfigured' };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
        const headers = { 'Content-Type': 'application/json' };
        if (config.erpAuthToken) headers.Authorization = `Bearer ${config.erpAuthToken}`;
        const response = await fetch(config.erpEndpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: controller.signal,
        });
        const text = await response.text().catch(() => '');
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch (_) { parsed = null; }
        if (!response.ok) {
            return { ok: false, status: 'failed', reason: `erp_http_${response.status}` };
        }
        return {
            ok: true,
            status: 'sent',
            externalOrderId: parsed?.orderId || parsed?.id || parsed?.externalOrderId || null,
        };
    } catch (err) {
        return { ok: false, status: 'failed', reason: err.name === 'AbortError' ? 'erp_timeout' : 'erp_request_failed' };
    } finally {
        clearTimeout(timeout);
    }
}

function buildDealerOrderMessage(payload, config) {
    const greeting = payload.dealerName ? `Hi ${payload.dealerName}, ` : '';
    const portal = config.selfServiceUrl ? ` Manage or reorder here: ${config.selfServiceUrl}` : '';
    return `${greeting}order ${payload.orderId} is confirmed: ${payload.itemSummary}.${portal}`.trim();
}

async function sendTwilioSms({ to, body, config }) {
    const client = createTwilioClient({ accountSid: config.twilio.accountSid, authToken: config.twilio.authToken });
    const message = { to, body };
    if (config.twilio.messagingServiceSid) message.messagingServiceSid = config.twilio.messagingServiceSid;
    else if (config.twilio.from) message.from = config.twilio.from;
    else return { ok: false, failureReason: 'provider_unconfigured' };
    const result = await client.messages.create(message);
    return { ok: true, messageProvider: 'twilio', externalMessageId: result?.sid || null };
}

async function sendPlivoSms({ to, body, config }) {
    if (!config.plivo.from) return { ok: false, failureReason: 'provider_unconfigured' };
    const client = createPlivoClient({ authId: config.plivo.authId, authToken: config.plivo.authToken });
    const result = await client.messages.create(config.plivo.from, to, body);
    const externalMessageId = Array.isArray(result?.messageUuid)
        ? result.messageUuid[0]
        : result?.messageUuid || result?.message_uuid || null;
    return { ok: true, messageProvider: 'plivo', externalMessageId };
}

async function sendDealerOrderSms({ to, body, config }) {
    const phone = normalizePhone(to);
    if (!phone) return { ok: false, failureReason: 'invalid_destination' };
    const candidates = config.messagingProvider === 'auto' ? ['twilio', 'plivo'] : [config.messagingProvider];
    let lastFailure = 'provider_unconfigured';
    for (const provider of candidates) {
        try {
            const result = provider === 'twilio'
                ? await sendTwilioSms({ to: phone, body, config })
                : provider === 'plivo'
                    ? await sendPlivoSms({ to: phone, body, config })
                    : { ok: false, failureReason: 'provider_unconfigured' };
            if (result.ok) return { ...result, destinationHash: hashDestination(phone) };
            lastFailure = result.failureReason || lastFailure;
        } catch (_) {
            lastFailure = 'provider_api_error';
        }
    }
    return { ok: false, failureReason: lastFailure, destinationHash: hashDestination(phone) };
}

async function sendDealerOrderNotifications(payload, config) {
    const attempts = [];
    const message = buildDealerOrderMessage(payload, config);
    for (const channel of config.deliveryOrder) {
        if (channel === 'sms') {
            if (!config.smsEnabled) {
                attempts.push({ channel, ok: false, failureReason: 'channel_disabled' });
                continue;
            }
            const sms = await sendDealerOrderSms({ to: payload.dealerPhone, body: message, config });
            attempts.push({ channel, ...sms });
            continue;
        }
        if (channel === 'email') {
            if (!config.emailEnabled) {
                attempts.push({ channel, ok: false, failureReason: 'channel_disabled' });
                continue;
            }
            const to = payload.dealerEmail || config.notificationEmail;
            const sent = await sendDealerOrderEmail({
                dealerName: payload.dealerName,
                dealerEmail: to,
                orderId: payload.orderId,
                items: payload.items,
                selfServiceUrl: config.selfServiceUrl,
                companyName: config.companyName,
                ccEmail: payload.dealerEmail ? (config.notificationEmail || config.ccEmail) : config.ccEmail,
            });
            attempts.push({ channel, ok: sent, messageProvider: 'smtp', failureReason: sent ? null : 'email_send_failed' });
        }
    }
    return {
        ok: attempts.some(attempt => attempt.ok),
        attempts,
        sentChannels: attempts.filter(attempt => attempt.ok).map(attempt => attempt.channel),
    };
}

async function submitDealerOrder(order = {}, config = resolveDealerOrderConfig()) {
    const payload = buildOrderPayload(order);
    const erp = await postToErp(payload, config);
    telemetry.emit(erp.ok ? 'dealer_order_erp_logged' : 'dealer_order_erp_failed', {
        callId: payload.callId,
        orderId: payload.orderId,
        reason: erp.reason || null,
        externalOrderId: erp.externalOrderId || null,
        ts: Date.now(),
    });

    const notifications = await sendDealerOrderNotifications(payload, config);
    telemetry.emit(notifications.ok ? 'dealer_order_notification_sent' : 'dealer_order_notification_failed', {
        callId: payload.callId,
        orderId: payload.orderId,
        channels: notifications.sentChannels || [],
        ts: Date.now(),
    });

    return { payload, erp, notifications };
}

async function retryDealerCall(callState, attempt) {
    const phoneNumber = callState.phoneNumber || callState.recipient;
    if (!phoneNumber || !isWithinCallingWindow(phoneNumber)) {
        return { ok: false, reason: 'outside_calling_window_or_missing_phone' };
    }
    const countryCode = parseE164CountryCode(phoneNumber);
    const provider = countryCode === '91'
        ? require('../adapters/telecom/PlivoProvider')
        : require('../adapters/telecom/TwilioProvider');
    const details = await provider.createCall(
        phoneNumber,
        callState.name || 'Dealer',
        'dealer-orders',
        callState.language || 'en',
        {
            contextHint: callState.contextHint ?? null,
            policyConfig: callState.policyConfig ?? null,
            aiProvider: callState.aiProvider ?? null,
            requireExplicitRecordingConsent: callState.requireExplicitRecordingConsent ?? false,
        }
    );
    return { ok: true, attempt, callSid: details?.callSid || null, provider: provider.name };
}

async function sendFallbackSelfServiceSms(callState, config) {
    if (!config.fallbackSmsEnabled || !config.selfServiceUrl) {
        return { ok: false, reason: 'fallback_sms_unconfigured' };
    }
    const phoneNumber = callState.phoneNumber || callState.recipient;
    const name = callState.name ? `${callState.name}, ` : '';
    const body = `${name}sorry we missed you. You can place or update your dealer order here: ${config.selfServiceUrl}`;
    return sendDealerOrderSms({ to: phoneNumber, body, config });
}

async function handleDealerOrderMissedCall({ callSID, callState = {}, provider, status } = {}, config = resolveDealerOrderConfig()) {
    if (callState.persona !== 'dealer-orders') return { ok: false, reason: 'not_dealer_order_persona' };
    const phoneNumber = callState.phoneNumber || callState.recipient;
    if (!phoneNumber) return { ok: false, reason: 'missing_phone' };

    telemetry.emit('dealer_order_missed_call', {
        callId: callSID,
        provider,
        status,
        ts: Date.now(),
    });

    const retryKey = phoneNumber;
    const currentAttempt = retryAttemptsByPhone.get(retryKey) || 0;
    if (config.retryEnabled && currentAttempt < config.maxRetries) {
        const nextAttempt = currentAttempt + 1;
        retryAttemptsByPhone.set(retryKey, nextAttempt);
        const timer = setTimeout(async () => {
            try {
                const result = await retryDealerCall(callState, nextAttempt);
                telemetry.emit(result.ok ? 'dealer_order_retry_scheduled' : 'dealer_order_retry_failed', {
                    callId: callSID,
                    attempt: nextAttempt,
                    reason: result.reason || null,
                    retryCallId: result.callSid || null,
                    ts: Date.now(),
                });
            } catch (err) {
                telemetry.emit('dealer_order_retry_failed', {
                    callId: callSID,
                    attempt: nextAttempt,
                    reason: err?.message || 'retry_failed',
                    ts: Date.now(),
                });
            }
        }, config.retryDelayMs);
        if (typeof timer.unref === 'function') timer.unref();
        return { ok: true, status: 'retry_scheduled', attempt: nextAttempt };
    }

    const fallback = await sendFallbackSelfServiceSms(callState, config);
    retryAttemptsByPhone.delete(retryKey);
    telemetry.emit(fallback.ok ? 'dealer_order_fallback_sent' : 'dealer_order_fallback_failed', {
        callId: callSID,
        provider,
        status,
        reason: fallback.reason || fallback.failureReason || null,
        ts: Date.now(),
    });
    return { ok: fallback.ok, status: fallback.ok ? 'fallback_sent' : 'fallback_failed' };
}

module.exports = {
    buildOrderPayload,
    handleDealerOrderMissedCall,
    resolveDealerOrderConfig,
    sendDealerOrderNotifications,
    submitDealerOrder,
};
