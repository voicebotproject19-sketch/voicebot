'use strict';

const crypto = require('crypto');

const NUMBER_WORDS = Object.freeze({
    zero: 0,
    one: 1,
    a: 1,
    an: 1,
    two: 2,
    couple: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    dozen: 12,
    thirteen: 13,
    fourteen: 14,
    fifteen: 15,
    sixteen: 16,
    seventeen: 17,
    eighteen: 18,
    nineteen: 19,
    twenty: 20,
    thirty: 30,
    forty: 40,
    fifty: 50,
    sixty: 60,
    seventy: 70,
    eighty: 80,
    ninety: 90,
    hundred: 100,
});

const UNIT_WORDS = [
    'unit', 'units', 'pc', 'pcs', 'piece', 'pieces', 'case', 'cases',
    'box', 'boxes', 'carton', 'cartons', 'pack', 'packs', 'set', 'sets',
    'bottle', 'bottles', 'bag', 'bags', 'kg', 'kgs', 'kilogram', 'kilograms',
    'liter', 'liters', 'litre', 'litres', 'l', 'dozen', 'dozens'
];

const UNIT_PATTERN = UNIT_WORDS.join('|');
const NUMBER_PATTERN = [
    '\\d{1,5}',
    ...Object.keys(NUMBER_WORDS).sort((a, b) => b.length - a.length)
].join('|');

function sanitizeText(value, maxLength = 1000) {
    return String(value || '')
        .replace(/[<>]/g, '')
        .replace(/[\x00-\x08\x0E-\x1F]/g, '')
        .replace(/[\u200B-\u200F\uFEFF\u202A-\u202E]/g, '')
        .replace(/["`]/g, "'")
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLength);
}

function parseNumberToken(raw) {
    const token = String(raw || '').trim().toLowerCase().replace(/[-_]+/g, ' ');
    if (!token) return null;
    if (/^\d+$/.test(token)) {
        const parsed = Number(token);
        return parsed > 0 ? parsed : null;
    }

    const parts = token.split(/\s+/).filter(Boolean);
    let total = 0;
    let matched = false;

    for (const part of parts) {
        if (NUMBER_WORDS[part] == null) return null;
        matched = true;
        if (part === 'hundred') {
            total = total > 0 ? total * 100 : 100;
        } else {
            total += NUMBER_WORDS[part];
        }
    }

    return matched && total > 0 ? total : null;
}

function normalizeProductName(value) {
    return sanitizeText(value, 160)
        .replace(/^(?:of\s+)?(?:the\s+)?/i, '')
        .replace(/\b(?:please|thanks|thank you|for now|today|right now)$/i, '')
        .replace(/[.,;:!?]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function normalizeUnit(value) {
    const unit = String(value || '').trim().toLowerCase();
    if (!unit) return null;
    const aliases = {
        pc: 'pieces',
        pcs: 'pieces',
        piece: 'pieces',
        unit: 'units',
        case: 'cases',
        box: 'boxes',
        carton: 'cartons',
        pack: 'packs',
        set: 'sets',
        bottle: 'bottles',
        bag: 'bags',
        kg: 'kg',
        kgs: 'kg',
        kilogram: 'kg',
        kilograms: 'kg',
        liter: 'liters',
        litre: 'liters',
        litres: 'liters',
        l: 'liters',
        dozen: 'dozen',
        dozens: 'dozen',
    };
    return aliases[unit] || unit;
}

function stripOrderLeadIn(segment) {
    return sanitizeText(segment, 300)
        .replace(/^(?:i\s+)?(?:need|want|would like|will take|want to order|need to order|order|add|get|send|ship|give me|place|book)\s+/i, '')
        .replace(/^(?:please\s+)?(?:add|send|ship|get|give me)\s+/i, '')
        .trim();
}

function parseItemSegment(segment) {
    const cleaned = stripOrderLeadIn(segment);
    if (!cleaned || cleaned.length < 3) return null;

    const quantityFirst = new RegExp(`^(${NUMBER_PATTERN})(?:\\s+(${UNIT_PATTERN}))?(?:\\s+of)?\\s+(.+)$`, 'i');
    let match = cleaned.match(quantityFirst);
    if (match) {
        const quantity = parseNumberToken(match[1]);
        const productName = normalizeProductName(match[3]);
        if (quantity && productName) {
            return { productName, quantity, unit: normalizeUnit(match[2]) };
        }
    }

    const productFirst = new RegExp(`^(.+?)\\s+(${NUMBER_PATTERN})(?:\\s+(${UNIT_PATTERN}))?(?:\\s|$)`, 'i');
    match = cleaned.match(productFirst);
    if (match) {
        const quantity = parseNumberToken(match[2]);
        const productName = normalizeProductName(match[1]);
        if (quantity && productName) {
            return { productName, quantity, unit: normalizeUnit(match[3]) };
        }
    }

    return null;
}

function extractOrderItems(text) {
    const safe = sanitizeText(text, 800);
    if (!safe) return [];
    const segments = safe
        .split(/(?:,|;|\bplus\b|\balso\b|\band\b)/i)
        .map(part => part.trim())
        .filter(Boolean);
    const items = segments.map(parseItemSegment).filter(Boolean);
    return mergeOrderItems([], items);
}

function itemKey(item) {
    return `${String(item.productName || '').toLowerCase()}|${String(item.unit || '')}`;
}

function mergeOrderItems(existing = [], incoming = []) {
    const merged = new Map();
    for (const item of [...existing, ...incoming]) {
        if (!item || !item.productName || !Number.isFinite(Number(item.quantity))) continue;
        const normalized = {
            productName: normalizeProductName(item.productName),
            quantity: Number(item.quantity),
            unit: normalizeUnit(item.unit),
        };
        if (!normalized.productName || normalized.quantity <= 0) continue;
        const key = itemKey(normalized);
        const current = merged.get(key);
        if (current) current.quantity += normalized.quantity;
        else merged.set(key, normalized);
    }
    return [...merged.values()];
}

function formatOrderItem(item) {
    const quantity = Number(item.quantity);
    const unit = item.unit ? `${item.unit} of ` : '';
    return `${quantity} ${unit}${item.productName}`.trim();
}

function formatOrderItems(items = []) {
    const parts = items.map(formatOrderItem).filter(Boolean);
    if (parts.length <= 1) return parts[0] || 'no items';
    return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function normalizeIntentText(text) {
    return sanitizeText(text, 300).toLowerCase().replace(/[.!?,;:]+$/g, '').trim();
}

function isOrderConfirmation(text) {
    const normalized = normalizeIntentText(text);
    if (!normalized) return false;
    return /^(yes|yeah|yep|correct|right|that's right|that is right|confirm|confirmed|ok|okay|sure|go ahead|place it|submit it|send it|please do|do it)\b/i.test(normalized)
        || /\b(confirm|place|submit|send)\s+(the\s+)?order\b/i.test(normalized);
}

function isOrderSkip(text) {
    const normalized = normalizeIntentText(text);
    if (!normalized) return false;
    return /\b(skip|not now|later|no order|nothing today|no thanks|don't need|do not need|pass|call me later)\b/i.test(normalized);
}

function hasOrderReplacementIntent(text) {
    return /\b(change|replace|instead|make it|actually|correction|correct that|revise)\b/i.test(normalizeIntentText(text));
}

function createDealerOrderId(now = new Date(), randomBytes = crypto.randomBytes) {
    const date = now instanceof Date ? now : new Date(now);
    const stamp = date.toISOString().slice(0, 10).replace(/-/g, '');
    const suffix = randomBytes(3).toString('hex').toUpperCase();
    return `DO-${stamp}-${suffix}`;
}

function parseDealerContextHint(value) {
    if (value == null || value === '') return {};
    let data = value;
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return {};
        try {
            data = JSON.parse(trimmed);
        } catch (_) {
            return { notes: sanitizeText(trimmed, 700) };
        }
    }
    if (typeof data !== 'object' || Array.isArray(data)) return {};

    const percentRaw = Number(data.monthlyTargetPercent ?? data.targetPercent ?? data.milestonePercent);
    const monthlyTargetPercent = Number.isFinite(percentRaw) ? Math.max(0, Math.min(200, percentRaw)) : null;

    return {
        dealerId: sanitizeText(data.dealerId || data.id || '', 80) || null,
        dealerName: sanitizeText(data.dealerName || data.accountName || data.name || '', 120) || null,
        dealerEmail: sanitizeText(data.dealerEmail || data.email || '', 160).toLowerCase() || null,
        lastOrder: sanitizeText(data.lastOrder || data.lastOrderSummary || '', 240) || null,
        monthlyTargetPercent,
        milestonePrompt: sanitizeText(data.milestonePrompt || data.bonusPrompt || '', 240) || null,
        triggerReason: sanitizeText(data.triggerReason || data.trigger || '', 120) || null,
        selfServiceUrl: sanitizeText(data.selfServiceUrl || data.orderUrl || data.portalUrl || '', 300) || null,
        notes: sanitizeText(data.notes || data.crmNotes || '', 500) || null,
    };
}

module.exports = {
    createDealerOrderId,
    extractOrderItems,
    formatOrderItems,
    hasOrderReplacementIntent,
    isOrderConfirmation,
    isOrderSkip,
    mergeOrderItems,
    parseDealerContextHint,
    sanitizeText,
};
