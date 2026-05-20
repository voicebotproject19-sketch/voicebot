'use strict';

const { normalizeTransferNumber } = require('../Utils/phoneUtils');

function firstNonEmpty(...values) {
    for (const value of values) {
        if (value == null) continue;
        const normalized = String(value).trim();
        if (normalized) return normalized;
    }
    return null;
}

function readBooleanEnv(env, name, defaultValue = false) {
    const value = firstNonEmpty(env?.[name]);
    if (value == null) return defaultValue;
    return ['1', 'true', 'yes', 'on', 'enabled'].includes(value.toLowerCase());
}

function readPositiveIntegerEnv(env, name, defaultValue, { min = 1, max = 600 } = {}) {
    const raw = Number.parseInt(firstNonEmpty(env?.[name]), 10);
    if (!Number.isFinite(raw)) return defaultValue;
    return Math.min(Math.max(raw, min), max);
}

function parseTargetList(value) {
    const raw = firstNonEmpty(value);
    if (!raw) return [];

    let values = [];
    if (raw.startsWith('[')) {
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) values = parsed;
        } catch (_) {
            values = [];
        }
    }

    if (values.length === 0) {
        values = raw.split(',');
    }

    const targets = [];
    for (const candidate of values) {
        const normalized = normalizeTransferNumber(candidate);
        if (normalized.ok && !targets.includes(normalized.number)) {
            targets.push(normalized.number);
        }
    }
    return targets;
}

function normalizePersonaKey(personaId) {
    return String(personaId || '')
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

function getAgentTargetCandidates({ env = process.env, contact = {}, personaId = null, fallbackTransferNumber = null } = {}) {
    const personaKey = normalizePersonaKey(personaId);
    const personaEnvName = personaKey ? `${personaKey}_AGENT_NUMBERS` : null;
    const rawTargets = firstNonEmpty(
        contact.agentNumbers,
        contact.warmTransferAgentNumbers,
        personaEnvName ? env[personaEnvName] : null,
        env.WARM_TRANSFER_AGENT_NUMBERS,
        fallbackTransferNumber
    );
    return parseTargetList(rawTargets);
}

function resolveAgentAvailability({ env = process.env, contact = {}, personaId = null, fallbackTransferNumber = null } = {}) {
    const enabled = readBooleanEnv(env, 'WARM_TRANSFER_ENABLED', false);
    const mode = firstNonEmpty(env.WARM_TRANSFER_MODE, contact.warmTransferMode, enabled ? 'warm' : 'cold').toLowerCase();
    const timeoutSeconds = readPositiveIntegerEnv(env, 'WARM_TRANSFER_TIMEOUT_SECONDS', 20, { min: 5, max: 120 });
    const confirmTimeoutSeconds = readPositiveIntegerEnv(env, 'WARM_TRANSFER_CONFIRM_TIMEOUT_SECONDS', 8, { min: 3, max: 60 });
    const confirmKey = firstNonEmpty(env.WARM_TRANSFER_CONFIRM_KEY, contact.warmTransferConfirmKey, '1');
    const selectedTargets = enabled ? getAgentTargetCandidates({ env, contact, personaId, fallbackTransferNumber }) : [];

    if (!enabled) {
        return {
            enabled,
            mode: 'cold',
            available: false,
            selectedTargets: [],
            reason: 'warm_transfer_disabled',
            timeoutSeconds,
            confirmTimeoutSeconds,
            confirmKey
        };
    }

    if (!selectedTargets.length) {
        return {
            enabled,
            mode,
            available: false,
            selectedTargets,
            reason: 'no_configured_agents',
            timeoutSeconds,
            confirmTimeoutSeconds,
            confirmKey
        };
    }

    return {
        enabled,
        mode,
        available: true,
        selectedTargets,
        reason: 'configured_agent_targets',
        timeoutSeconds,
        confirmTimeoutSeconds,
        confirmKey
    };
}

module.exports = {
    getAgentTargetCandidates,
    resolveAgentAvailability,
    parseTargetList
};
