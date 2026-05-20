'use strict';

const crypto = require('crypto');
const { parsePhoneNumberFromString } = require('libphonenumber-js');
const { sendBookingLinkEmail } = require('../Helper/emailHelper');
const { createTwilioClient } = require('../adapters/telecom/twilioClient');
const { createPlivoClient } = require('../adapters/telecom/plivoClient');

const PHONE_CHANNELS = new Set(['sms', 'whatsapp']);
const VALID_CHANNELS = new Set(['sms', 'whatsapp', 'email']);

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
        .filter(channel => VALID_CHANNELS.has(channel))
        .filter((channel, index, channels) => channels.indexOf(channel) === index);
}

function resolvePersonaDeliveryGate(personaId, env = process.env) {
    const key = String(personaId || '')
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '_');
    const envName = key ? `${key}_BOOKING_DELIVERY_ENABLED` : null;
    if (envName && env[envName] != null) return isTruthy(env[envName]);
    if (env.BOOKING_DELIVERY_ENABLED != null) return isTruthy(env.BOOKING_DELIVERY_ENABLED);
    return false;
}

function resolveBookingDeliveryConfig(contact = {}, env = process.env) {
    const booking = contact && typeof contact.booking === 'object' && !Array.isArray(contact.booking)
        ? contact.booking
        : {};
    const personaId = contact.personaId || contact.id || booking.personaId || null;
    const enabled = booking.deliveryEnabled != null
        ? booking.deliveryEnabled === true
        : contact.bookingDeliveryEnabled != null
            ? contact.bookingDeliveryEnabled === true
            : resolvePersonaDeliveryGate(personaId, env);

    const order = parseDeliveryOrder(
        booking.deliveryOrder || contact.bookingDeliveryOrder || env.BOOKING_DELIVERY_ORDER
    );

    return {
        enabled,
        order: order.length ? order : ['sms', 'email'],
        messagingProvider: String(firstNonEmpty(
            booking.messagingProvider,
            contact.bookingMessagingProvider,
            env.BOOKING_MESSAGING_PROVIDER,
            'auto'
        )).toLowerCase(),
        smsEnabled: booking.smsEnabled != null ? booking.smsEnabled === true : isTruthy(env.BOOKING_SMS_ENABLED),
        whatsappEnabled: booking.whatsappEnabled != null ? booking.whatsappEnabled === true : isTruthy(env.BOOKING_WHATSAPP_ENABLED),
        emailEnabled: booking.emailEnabled != null ? booking.emailEnabled === true : !isTruthy(env.BOOKING_EMAIL_DISABLED),
        requirePhoneConsent: booking.smsRequireExplicitConsent != null
            ? booking.smsRequireExplicitConsent === true
            : env.BOOKING_SMS_REQUIRE_EXPLICIT_CONSENT == null || isTruthy(env.BOOKING_SMS_REQUIRE_EXPLICIT_CONSENT),
        defaultCountry: firstNonEmpty(booking.defaultCountry, contact.defaultCountry, env.BOOKING_PHONE_DEFAULT_COUNTRY, 'US'),
        twilio: {
            accountSid: env.TWILIO_ACCOUNT_SID,
            authToken: env.TWILIO_ACCOUNT_AUTH_TOKEN || env.TWILIO_AUTH_TOKEN,
            from: firstNonEmpty(env.TWILIO_MESSAGING_FROM, env.TWILIO_FROM_NUMBER, env.TWILIO_PHONE_NUMBER),
            messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID,
            whatsappFrom: env.TWILIO_WHATSAPP_FROM,
        },
        plivo: {
            authId: env.PLIVO_AUTH_ID,
            authToken: env.PLIVO_AUTH_TOKEN,
            from: firstNonEmpty(env.PLIVO_MESSAGING_FROM, env.PLIVO_SOURCE_NUMBER, env.PLIVO_PHONE_NUMBER),
            whatsappFrom: env.PLIVO_WHATSAPP_FROM,
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

function normalizeDeliveryTarget(channel, context = {}, config = resolveBookingDeliveryConfig()) {
    if (channel === 'email') {
        const email = normalizeEmail(context.userEmail);
        return email
            ? { ok: true, channel, destination: email, destinationHash: hashDestination(email), targetSource: 'email' }
            : { ok: false, channel, failureReason: 'invalid_destination' };
    }

    if (!PHONE_CHANNELS.has(channel)) return { ok: false, channel, failureReason: 'unsupported_channel' };

    if (config.requirePhoneConsent && !context.phoneConsent) {
        return { ok: false, channel, failureReason: 'consent_required' };
    }

    const source = context.phoneConsentTargetSource === 'spoken_confirmed'
        ? 'userPhone'
        : context.phoneConsentTargetSource === 'caller'
            ? 'callerNumber'
            : context.userPhone
                ? 'userPhone'
                : 'callerNumber';
    const rawPhone = source === 'userPhone' ? context.userPhone : context.callerNumber;
    const phone = normalizePhone(rawPhone, config.defaultCountry);
    if (!phone) return { ok: false, channel, failureReason: 'invalid_destination' };

    return { ok: true, channel, destination: phone, destinationHash: hashDestination(phone), targetSource: source };
}

function buildBookingLinkMessage(context = {}) {
    const greeting = context.callerName ? `Hi ${context.callerName}, ` : '';
    const slot = context.preferredSlot ? ` You mentioned ${context.preferredSlot} on the call.` : '';
    return `${greeting}thanks for speaking with us. Choose a meeting time here: ${context.bookingUrl}.${slot}`.trim();
}

async function sendTwilioMessage({ channel, destination, body, config }) {
    const twilioConfig = config.twilio || {};
    const client = createTwilioClient({ accountSid: twilioConfig.accountSid, authToken: twilioConfig.authToken });
    const payload = { to: channel === 'whatsapp' ? `whatsapp:${destination}` : destination, body };
    if (channel === 'whatsapp') {
        if (!twilioConfig.whatsappFrom) return { ok: false, failureReason: 'provider_unconfigured' };
        payload.from = twilioConfig.whatsappFrom.startsWith('whatsapp:') ? twilioConfig.whatsappFrom : `whatsapp:${twilioConfig.whatsappFrom}`;
    } else if (twilioConfig.messagingServiceSid) {
        payload.messagingServiceSid = twilioConfig.messagingServiceSid;
    } else if (twilioConfig.from) {
        payload.from = twilioConfig.from;
    } else {
        return { ok: false, failureReason: 'provider_unconfigured' };
    }

    const message = await client.messages.create(payload);
    return { ok: true, externalMessageId: message?.sid || null };
}

async function sendPlivoMessage({ channel, destination, body, config }) {
    const plivoConfig = config.plivo || {};
    const from = channel === 'whatsapp' ? plivoConfig.whatsappFrom : plivoConfig.from;
    if (!from) return { ok: false, failureReason: 'provider_unconfigured' };
    const client = createPlivoClient({ authId: plivoConfig.authId, authToken: plivoConfig.authToken });
    const response = await client.messages.create(from, destination, body);
    const externalMessageId = Array.isArray(response?.messageUuid)
        ? response.messageUuid[0]
        : response?.messageUuid || response?.message_uuid || response?.messageUuid?.[0] || null;
    return { ok: true, externalMessageId };
}

async function sendPhoneChannel({ channel, target, context, config }) {
    const body = buildBookingLinkMessage(context);
    const candidates = config.messagingProvider === 'auto'
        ? ['twilio', 'plivo']
        : [config.messagingProvider];
    let lastFailure = 'provider_unconfigured';

    for (const provider of candidates) {
        try {
            const result = provider === 'twilio'
                ? await sendTwilioMessage({ channel, destination: target.destination, body, config })
                : provider === 'plivo'
                    ? await sendPlivoMessage({ channel, destination: target.destination, body, config })
                    : { ok: false, failureReason: 'provider_unconfigured' };
            if (result.ok) return { ok: true, messageProvider: provider, externalMessageId: result.externalMessageId || null };
            lastFailure = result.failureReason || lastFailure;
        } catch (err) {
            lastFailure = err?.message ? 'provider_api_error' : 'provider_unconfigured';
        }
    }

    return { ok: false, messageProvider: candidates[0] || null, failureReason: lastFailure };
}

async function sendEmailChannel({ target, context }) {
    const sent = await sendBookingLinkEmail({
        callerName: context.callerName,
        userEmail: target.destination,
        bookingUrl: context.bookingUrl,
        preferredSlot: context.preferredSlot,
        persona: context.personaId,
        ccEmail: context.ccEmail,
    });
    return sent
        ? { ok: true, messageProvider: 'smtp', externalMessageId: null }
        : { ok: false, messageProvider: 'smtp', failureReason: 'email_send_failed' };
}

function disabledAttempt(channel, reason = 'provider_unconfigured') {
    return {
        channel,
        messageProvider: null,
        ok: false,
        status: 'failed',
        failureReason: reason,
        destinationHash: null,
        externalMessageId: null,
    };
}

async function sendBookingLink(context = {}, config = resolveBookingDeliveryConfig()) {
    const attempts = [];
    if (!config.enabled) {
        return { ok: false, status: 'failed', attempts: [disabledAttempt('delivery', 'delivery_disabled')] };
    }

    for (const channel of config.order) {
        attempts.push(await sendBookingLinkChannel(context, channel, config));
    }

    const sentChannels = attempts.filter(attempt => attempt.ok).map(attempt => attempt.channel);
    return {
        ok: sentChannels.length > 0,
        status: sentChannels.length > 0 ? 'sent' : 'failed',
        attempts,
        sentChannels,
        failedChannels: attempts.filter(attempt => !attempt.ok).map(attempt => attempt.channel),
    };
}

async function sendBookingLinkChannel(context = {}, channel, config = resolveBookingDeliveryConfig()) {
    const normalizedChannel = String(channel || '').trim().toLowerCase();
    if (!VALID_CHANNELS.has(normalizedChannel)) {
        return disabledAttempt(normalizedChannel || 'delivery', 'unsupported_channel');
    }

    if (!config.enabled) {
        return disabledAttempt(normalizedChannel, 'delivery_disabled');
    }

    const channelEnabled = normalizedChannel === 'email'
        ? config.emailEnabled
        : normalizedChannel === 'sms'
            ? config.smsEnabled
            : config.whatsappEnabled;
    if (!channelEnabled) {
        return disabledAttempt(normalizedChannel, 'channel_disabled');
    }

    const target = normalizeDeliveryTarget(normalizedChannel, context, config);
    if (!target.ok) {
        return {
            ...disabledAttempt(normalizedChannel, target.failureReason),
            destinationHash: target.destinationHash || null,
        };
    }

    const result = normalizedChannel === 'email'
        ? await sendEmailChannel({ target, context, config })
        : await sendPhoneChannel({ channel: normalizedChannel, target, context, config });

    return {
        channel: normalizedChannel,
        messageProvider: result.messageProvider || null,
        ok: !!result.ok,
        status: result.ok ? 'sent' : 'failed',
        failureReason: result.ok ? null : result.failureReason || 'provider_api_error',
        destinationHash: target.destinationHash,
        externalMessageId: result.externalMessageId || null,
        targetSource: target.targetSource || null,
    };
}

module.exports = {
    buildBookingLinkMessage,
    hashDestination,
    normalizeDeliveryTarget,
    normalizePhone,
    resolveBookingDeliveryConfig,
    sendBookingLink,
    sendBookingLinkChannel,
};
