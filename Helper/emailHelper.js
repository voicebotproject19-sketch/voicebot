'use strict';

/**
 * @file emailHelper.js
 * Sends handover notification emails when a call is transferred or escalated.
 *
 * SMTP config is read from environment variables:
 *   SMTP_HOST     — e.g. smtp.gmail.com
 *   SMTP_PORT     — default 587
 *   SMTP_SECURE   — 'true' for port 465 SSL, otherwise STARTTLS
 *   SMTP_USER     — SMTP username / sender address
 *   SMTP_PASS     — SMTP password / app password
 *   SMTP_FROM     — Display name + address, e.g. "VoiceBot <bot@company.com>"
 *                   Falls back to SMTP_USER if not set.
 *
 * Per-client contact details (notificationEmail, ccEmail) come from
 * the KB class (kb.contact) or persona config (persona.contact).
 * These are resolved in app.js and passed in as parameters here.
 */

const nodemailer = require('nodemailer');

// ── Reason labels for email subject/body ─────────────────────────────────────

const REASON_LABELS = {
    caller_requested:     'Caller requested a human agent',
    turn_limit:           'Maximum conversation turns reached',
    escalation_hostility: 'Escalated due to caller frustration',
};

// ── Lazy transporter — created once, reused ──────────────────────────────────

let _transporter = null;
let _transporterSignature = null;

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

function isValidHttpUrl(value) {
    try {
        const url = new URL(String(value || ''));
        return url.protocol === 'https:' || url.protocol === 'http:';
    } catch (_) {
        return false;
    }
}

function getTransportSignature() {
    const { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER } = process.env;
    return JSON.stringify({ SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER });
}

function getTransporter() {
    const signature = getTransportSignature();
    if (_transporter && _transporterSignature === signature) return _transporter;
    const { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS } = process.env;
    if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
        return null; // Not configured — caller handles gracefully
    }
    _transporter = nodemailer.createTransport({
        host:   SMTP_HOST,
        port:   Number(SMTP_PORT) || 587,
        secure: SMTP_SECURE === 'true',
        auth:   { user: SMTP_USER, pass: SMTP_PASS },
    });
    _transporterSignature = signature;
    return _transporter;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Send a handover notification email.
 *
 * @param {object} params
 * @param {string|null} params.callerName         — Caller name from CRM
 * @param {string|null} params.callerNumber       — Caller's phone number
 * @param {string|null} params.userEmail          — Email captured during conversation
 * @param {string|null} params.userPhone          — Phone number spoken by caller during conversation
 * @param {string|null} params.preferredSlot      — Preferred day/time if captured
 * @param {string}      params.reason             — Handover reason key
 * @param {string|null} params.persona            — Persona ID (e.g. 'company-sales')
 * @param {string}      params.notificationEmail  — Primary recipient (from KB/persona contact)
 * @param {string|null} params.ccEmail            — CC address (from KB/persona contact or env)
 * @param {boolean}     params.transferAttempted  — Was a transfer tried before emailing?
 * @param {boolean}     params.transferFailed     — Did the transfer attempt fail?
 * @param {string|null} params.transferStatus     — Detailed transfer request state
 * @returns {Promise<boolean>} true if sent, false if skipped or failed
 */
async function sendHandoverEmail({
    callerName,
    callerNumber,
    userEmail,
    userPhone,
    preferredSlot,
    reason,
    persona,
    notificationEmail,
    ccEmail,
    transferAttempted = false,
    transferFailed    = false,
    transferStatus    = null,
}) {
    if (!notificationEmail) {
        console.warn('[EmailHelper] No notificationEmail configured — skipping handover email');
        return false;
    }

    if (!isValidEmail(notificationEmail)) {
        console.warn(`[EmailHelper] Invalid notificationEmail (${notificationEmail}) — skipping handover email`);
        return false;
    }

    if (ccEmail && !isValidEmail(ccEmail)) {
        console.warn(`[EmailHelper] Invalid ccEmail (${ccEmail}) — dropping CC for handover email`);
        ccEmail = null;
    }

    const transporter = getTransporter();
    if (!transporter) {
        console.warn('[EmailHelper] SMTP not configured (missing SMTP_HOST/SMTP_USER/SMTP_PASS) — skipping handover email');
        return false;
    }

    const reasonLabel = REASON_LABELS[reason] || reason;

    // ── Subject ───────────────────────────────────────────────────────────────

    const subject = transferFailed || transferStatus === 'invalid_number'
        ? `[VoiceBot] Call Transfer Failed — Immediate Follow-up Required`
        : `[VoiceBot] Call Handover — Follow-up Required`;

    // ── Transfer status line ──────────────────────────────────────────────────

    let transferStatusLine;
    if (transferStatus === 'invalid_number') {
        transferStatusLine = 'Not attempted — configured transfer number is invalid';
    } else if (transferStatus === 'request_failed' || transferFailed) {
        transferStatusLine = 'FAILED — provider did not accept the transfer request';
    } else if (transferStatus === 'request_accepted') {
        transferStatusLine = 'Requested — provider accepted the transfer redirect; bridge confirmation was not available';
    } else if (transferStatus === 'bridge_confirmed') {
        transferStatusLine = 'Completed — caller was connected to the transfer number';
    } else if (!transferAttempted) {
        transferStatusLine = 'Not attempted — no valid transfer number configured for this account';
    } else {
        transferStatusLine = 'Requested — provider transfer request was attempted; bridge confirmation was not available';
    }

    // ── Body ──────────────────────────────────────────────────────────────────

    const body = [
        'A voicebot call has been escalated and requires follow-up.',
        '',
        'CALLER DETAILS',
        `  Name:           ${callerName    || 'Not available'}`,
        `  Phone:          ${callerNumber  || 'Not available'}`,
        `  Contact Phone:  ${userPhone      || 'Not provided during call'}`,
        `  Email:          ${userEmail     || 'Not provided during call'}`,
        `  Preferred slot: ${preferredSlot || 'Not specified'}`,
        '',
        'HANDOVER DETAILS',
        `  Reason:         ${reasonLabel}`,
        `  Account:        ${persona        || 'Unknown'}`,
        `  Transfer:       ${transferStatusLine}`,
        `  Time (UTC):     ${new Date().toISOString()}`,
        '',
        'ACTION REQUIRED',
        callerNumber
            ? `  Call back ${callerName || 'the caller'} on ${callerNumber}.`
            : '  Contact the caller — phone number was not available at handover.',
        userEmail
            ? `  A booking follow-up was being arranged for ${userEmail}.`
            : '',
        '',
        '---',
        'This message was sent automatically by the VoiceBot system.',
    ].filter(line => line !== undefined).join('\n');

    // ── Send ──────────────────────────────────────────────────────────────────

    const mailOptions = {
        from:    process.env.SMTP_FROM || process.env.SMTP_USER,
        to:      notificationEmail,
        subject,
        text:    body,
    };
    if (ccEmail) mailOptions.cc = ccEmail;

    try {
        await transporter.sendMail(mailOptions);
        console.log(`[EmailHelper] Handover email sent → ${notificationEmail}${ccEmail ? ` (cc: ${ccEmail})` : ''}`);
        return true;
    } catch (err) {
        console.error(`[EmailHelper] Failed to send handover email: ${err.message}`);
        _transporter = null;
        _transporterSignature = null;
        return false;
    }
}

async function sendBookingLinkEmail({
    callerName,
    userEmail,
    bookingUrl,
    preferredSlot,
    persona,
    ccEmail,
}) {
    if (!isValidEmail(userEmail)) {
        console.warn('[EmailHelper] Invalid userEmail — skipping booking link email');
        return false;
    }

    if (!isValidHttpUrl(bookingUrl)) {
        console.warn('[EmailHelper] Invalid bookingUrl — skipping booking link email');
        return false;
    }

    if (ccEmail && !isValidEmail(ccEmail)) {
        console.warn('[EmailHelper] Invalid ccEmail — dropping CC for booking link email');
        ccEmail = null;
    }

    const transporter = getTransporter();
    if (!transporter) {
        console.warn('[EmailHelper] SMTP not configured (missing SMTP_HOST/SMTP_USER/SMTP_PASS) — skipping booking link email');
        return false;
    }

    const greeting = callerName ? `Hi ${callerName},` : 'Hi,';
    const body = [
        greeting,
        '',
        'Thanks for speaking with us. Please use this link to choose a meeting time:',
        bookingUrl,
        '',
        preferredSlot ? `You mentioned this preferred time on the call: ${preferredSlot}` : '',
        '',
        'If none of the available times work, reply to this email and our team will help coordinate.',
        '',
        '---',
        'This message was sent automatically by the VoiceBot system.',
    ].filter(line => line !== undefined).join('\n');

    const mailOptions = {
        from:    process.env.SMTP_FROM || process.env.SMTP_USER,
        to:      userEmail,
        subject: '[VoiceBot] Choose a time for your meeting',
        text:    body,
    };
    if (ccEmail) mailOptions.cc = ccEmail;

    try {
        await transporter.sendMail(mailOptions);
        console.log(`[EmailHelper] Booking link email sent to ${userEmail} (${persona || 'unknown persona'})`);
        return true;
    } catch (err) {
        console.error(`[EmailHelper] Failed to send booking link email: ${err.message}`);
        _transporter = null;
        _transporterSignature = null;
        return false;
    }
}

async function sendDealerOrderEmail({
    dealerName,
    dealerEmail,
    orderId,
    items = [],
    selfServiceUrl,
    companyName,
    ccEmail,
}) {
    if (!isValidEmail(dealerEmail)) {
        console.warn('[EmailHelper] Invalid dealerEmail — skipping dealer order email');
        return false;
    }

    if (ccEmail && !isValidEmail(ccEmail)) {
        console.warn('[EmailHelper] Invalid ccEmail — dropping CC for dealer order email');
        ccEmail = null;
    }

    const transporter = getTransporter();
    if (!transporter) {
        console.warn('[EmailHelper] SMTP not configured (missing SMTP_HOST/SMTP_USER/SMTP_PASS) — skipping dealer order email');
        return false;
    }

    const greeting = dealerName ? `Hi ${dealerName},` : 'Hi,';
    const itemLines = Array.isArray(items) && items.length
        ? items.map(item => `  - ${item.quantity}${item.unit ? ` ${item.unit}` : ''} ${item.productName}`).join('\n')
        : '  - Order details captured on the call';
    const company = companyName || 'Dealer Order Desk';

    const body = [
        greeting,
        '',
        `Your dealer order has been confirmed with ${company}.`,
        '',
        `Order ID: ${orderId || 'Pending'}`,
        '',
        'ORDER DETAILS',
        itemLines,
        '',
        selfServiceUrl ? `Manage or reorder here: ${selfServiceUrl}` : '',
        '',
        '---',
        'This message was sent automatically by the VoiceBot system.',
    ].filter(line => line !== undefined).join('\n');

    const mailOptions = {
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: dealerEmail,
        subject: `[VoiceBot] Dealer Order Confirmation${orderId ? ` — ${orderId}` : ''}`,
        text: body,
    };
    if (ccEmail) mailOptions.cc = ccEmail;

    try {
        await transporter.sendMail(mailOptions);
        console.log(`[EmailHelper] Dealer order email sent to ${dealerEmail}`);
        return true;
    } catch (err) {
        console.error(`[EmailHelper] Failed to send dealer order email: ${err.message}`);
        _transporter = null;
        _transporterSignature = null;
        return false;
    }
}

module.exports = { sendBookingLinkEmail, sendDealerOrderEmail, sendHandoverEmail };
