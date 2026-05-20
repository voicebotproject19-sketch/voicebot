'use strict';

const crypto = require('crypto');
const db = require('../services/db');

const VALID_STATUSES = new Set(['completed', 'cancelled', 'unknown']);
const VALID_DELIVERY_STATUSES = new Set(['sent', 'failed', 'unknown']);

function hash(value) {
    return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function truncate(value, maxLength) {
    if (value == null) return null;
    const text = String(value);
    return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizeStatus(status) {
    const value = String(status || '').trim().toLowerCase();
    return VALID_STATUSES.has(value) ? value : 'unknown';
}

function normalizeDeliveryStatus(status) {
    const value = String(status || '').trim().toLowerCase();
    return VALID_DELIVERY_STATUSES.has(value) ? value : 'unknown';
}

function buildDedupeKey(data = {}) {
    const externalBookingId = data.externalBookingId || 'none';
    const callSID = data.callSID || 'none';
    const eventType = data.eventType || 'unknown';
    const status = normalizeStatus(data.status);
    return hash(`${data.provider || 'unknown'}|${externalBookingId}|${callSID}|${eventType}|${status}`);
}

function buildPayloadHash(data = {}) {
    return hash(JSON.stringify({
        callSID: data.callSID || null,
        provider: data.provider || 'unknown',
        externalBookingId: data.externalBookingId || null,
        eventType: data.eventType || 'unknown',
        status: normalizeStatus(data.status),
    }));
}

function buildOrphanDedupeKey(data = {}) {
    const externalBookingId = data.externalBookingId || 'none';
    const rawCallSID = data.rawCallSID || data.rawCallId || 'none';
    const eventType = data.eventType || 'unknown';
    const status = normalizeStatus(data.status);
    const reason = data.orphanReason || data.reason || 'unknown';
    return hash(`orphan|${data.provider || 'unknown'}|${externalBookingId}|${rawCallSID}|${eventType}|${status}|${reason}`);
}

function buildOrphanPayloadHash(data = {}) {
    return hash(JSON.stringify({
        provider: data.provider || 'unknown',
        externalBookingId: data.externalBookingId || null,
        eventType: data.eventType || 'unknown',
        status: normalizeStatus(data.status),
        rawCallSID: data.rawCallSID || data.rawCallId || null,
        correlationStatus: data.correlationStatus || null,
        orphanReason: data.orphanReason || data.reason || null,
    }));
}

function buildDeliveryDedupeKey(data = {}) {
    const callSID = data.callSID || 'none';
    const linkHash = data.linkHash || 'none';
    const channel = data.channel || 'unknown';
    const destinationHash = data.destinationHash || 'none';
    const status = normalizeDeliveryStatus(data.status);
    const externalMessageId = data.externalMessageId || 'none';
    return hash(`delivery|${callSID}|${linkHash}|${channel}|${destinationHash}|${status}|${externalMessageId}`);
}

async function persistBookingEvent(data = {}) {
    const status = normalizeStatus(data.status);
    const event = {
        dedupeKey: data.dedupeKey || buildDedupeKey(data),
        callSID: truncate(data.callSID, 128),
        provider: truncate(data.provider || 'unknown', 64),
        externalBookingId: truncate(data.externalBookingId, 512),
        eventType: truncate(data.eventType || 'unknown', 128),
        status,
        payloadHash: data.payloadHash || buildPayloadHash(data),
        completedAt: status === 'completed' ? new Date() : null,
        cancelledAt: status === 'cancelled' ? new Date() : null,
    };

    const sql = `
    INSERT INTO booking_events
    (dedupeKey, callSID, provider, externalBookingId, eventType, status, payloadHash, completedAt, cancelledAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
        callSID = COALESCE(VALUES(callSID), callSID),
        provider = VALUES(provider),
        externalBookingId = COALESCE(VALUES(externalBookingId), externalBookingId),
        eventType = VALUES(eventType),
        status = VALUES(status),
        payloadHash = VALUES(payloadHash),
        completedAt = COALESCE(VALUES(completedAt), completedAt),
        cancelledAt = COALESCE(VALUES(cancelledAt), cancelledAt),
        updatedAt = CURRENT_TIMESTAMP
    `;

    return db.query(sql, [
        event.dedupeKey,
        event.callSID,
        event.provider,
        event.externalBookingId,
        event.eventType,
        event.status,
        event.payloadHash,
        event.completedAt,
        event.cancelledAt,
    ]);
}

async function getBookingEventsByCallSID(callSID) {
    const rows = await db.query(
        'SELECT * FROM booking_events WHERE callSID = ? ORDER BY receivedAt DESC, id DESC',
        [callSID]
    );
    return rows;
}

async function persistBookingWebhookOrphan(data = {}) {
    const status = normalizeStatus(data.status);
    const event = {
        dedupeKey: data.dedupeKey || buildOrphanDedupeKey(data),
        provider: truncate(data.provider || 'unknown', 64),
        externalBookingId: truncate(data.externalBookingId, 512),
        eventType: truncate(data.eventType || 'unknown', 128),
        status,
        rawCallSID: truncate(data.rawCallSID || data.rawCallId, 128),
        correlationStatus: truncate(data.correlationStatus, 64),
        orphanReason: truncate(data.orphanReason || data.reason || 'unknown', 128),
        payloadHash: data.payloadHash || buildOrphanPayloadHash(data),
    };

    const sql = `
    INSERT INTO booking_webhook_orphans
    (dedupeKey, provider, externalBookingId, eventType, status, rawCallSID, correlationStatus, orphanReason, payloadHash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
        provider = VALUES(provider),
        externalBookingId = COALESCE(VALUES(externalBookingId), externalBookingId),
        eventType = VALUES(eventType),
        status = VALUES(status),
        rawCallSID = COALESCE(VALUES(rawCallSID), rawCallSID),
        correlationStatus = COALESCE(VALUES(correlationStatus), correlationStatus),
        orphanReason = VALUES(orphanReason),
        payloadHash = VALUES(payloadHash),
        updatedAt = CURRENT_TIMESTAMP
    `;

    return db.query(sql, [
        event.dedupeKey,
        event.provider,
        event.externalBookingId,
        event.eventType,
        event.status,
        event.rawCallSID,
        event.correlationStatus,
        event.orphanReason,
        event.payloadHash,
    ]);
}

async function persistBookingDeliveryEvent(data = {}) {
    const status = normalizeDeliveryStatus(data.status);
    const event = {
        dedupeKey: data.dedupeKey || buildDeliveryDedupeKey(data),
        callSID: truncate(data.callSID, 128),
        bookingProvider: truncate(data.bookingProvider || data.provider || null, 64),
        linkHash: truncate(data.linkHash, 64),
        channel: truncate(data.channel || 'delivery', 32),
        messageProvider: truncate(data.messageProvider, 64),
        destinationHash: truncate(data.destinationHash, 64),
        externalMessageId: truncate(data.externalMessageId, 512),
        status,
        failureReason: truncate(data.failureReason, 128),
        sentAt: status === 'sent' ? new Date() : null,
    };

    const sql = `
    INSERT INTO booking_delivery_events
    (dedupeKey, callSID, bookingProvider, linkHash, channel, messageProvider, destinationHash, externalMessageId, status, failureReason, sentAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
        callSID = COALESCE(VALUES(callSID), callSID),
        bookingProvider = COALESCE(VALUES(bookingProvider), bookingProvider),
        linkHash = COALESCE(VALUES(linkHash), linkHash),
        channel = VALUES(channel),
        messageProvider = COALESCE(VALUES(messageProvider), messageProvider),
        destinationHash = COALESCE(VALUES(destinationHash), destinationHash),
        externalMessageId = COALESCE(VALUES(externalMessageId), externalMessageId),
        status = VALUES(status),
        failureReason = COALESCE(VALUES(failureReason), failureReason),
        sentAt = COALESCE(VALUES(sentAt), sentAt),
        updatedAt = CURRENT_TIMESTAMP
    `;

    return db.query(sql, [
        event.dedupeKey,
        event.callSID,
        event.bookingProvider,
        event.linkHash,
        event.channel,
        event.messageProvider,
        event.destinationHash,
        event.externalMessageId,
        event.status,
        event.failureReason,
        event.sentAt,
    ]);
}

module.exports = {
    buildDeliveryDedupeKey,
    buildDedupeKey,
    buildOrphanDedupeKey,
    getBookingEventsByCallSID,
    persistBookingDeliveryEvent,
    persistBookingEvent,
    persistBookingWebhookOrphan,
};
