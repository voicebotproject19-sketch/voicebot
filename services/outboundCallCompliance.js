'use strict';

const SuppressionRepository = require('../repositories/SuppressionRepository');
const ConsentRepository = require('../repositories/ConsentRepository');
const { evaluateCallingWindow } = require('./callingWindowCheck');
const { evaluateRecordingConsentRequirement } = require('./consentStateCheck');
const telemetry = require('../Utils/telemetry');

function readTrueEnv(name) {
    return String(process.env[name] || '').trim().toLowerCase() === 'true';
}

function isProduction() {
    return String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production';
}

function isConsentCheckEnabled() {
    return readTrueEnv('CONSENT_CHECK_ENABLED');
}

function isComplianceBypassEnabled() {
    return readTrueEnv('COMPLIANCE_BYPASS');
}

function emitDecision(context, decision) {
    const payload = {
        gate: decision.gate,
        allowed: decision.allowed,
        reason: decision.reason,
        blocking: Boolean(decision.blocking),
        bypassed: Boolean(decision.bypassed),
        severity: decision.severity || (decision.allowed ? 'info' : 'warn'),
        statusCode: decision.statusCode ?? null,
        phoneNumber: context.phoneNumber || null,
        persona: context.persona || null,
        language: context.language || null,
        sourceReason: decision.sourceReason || null,
        timezone: decision.timezone || null,
        hour: decision.hour ?? null,
        state: decision.state || null,
        areaCode: decision.areaCode || null,
        requireExplicitRecordingConsent: decision.requireExplicitRecordingConsent ?? null,
        errorMessage: decision.errorMessage || null,
        ts: Date.now(),
    };

    try {
        telemetry.emit('compliance_gate_decision', payload);
    } catch (err) {
        console.error('[Compliance] audit emit failed:', err.message);
    }

    if (payload.severity === 'warn') {
        console.warn(`[Compliance] gate=${payload.gate} allowed=${payload.allowed} reason=${payload.reason}`);
    }
}

function buildBlockedResult(decision, decisions) {
    return {
        allowed: false,
        statusCode: decision.statusCode || 403,
        error: decision.error || 'Call blocked by compliance gate',
        reason: decision.reason,
        decisions,
        requireExplicitRecordingConsent: false,
    };
}

function callingWindowErrorFor(reason) {
    if (reason === 'calling_window_eval_failed') return 'Compliance check unavailable: calling window';
    if (reason === 'invalid_phone_number' || reason === 'invalid_nanp_number') return 'Invalid phone number or unable to evaluate calling window';
    if (reason === 'unknown_nanp_timezone') return 'Call blocked: destination timezone could not be determined';
    return 'Call blocked: outside permitted calling window';
}

async function evaluateOutboundCallCompliance({ phoneNumber, persona, language, now = new Date() } = {}) {
    const context = { phoneNumber, persona, language };
    const decisions = [];
    const bypassRequested = isComplianceBypassEnabled();
    const production = isProduction();
    const bypassActive = bypassRequested && !production;

    function record(decision) {
        decisions.push(decision);
        emitDecision(context, decision);
        return decision;
    }

    function resolveBlockingDecision(decision) {
        if (decision.allowed) {
            record({ ...decision, blocking: false, severity: decision.severity || 'info' });
            return null;
        }

        if (bypassActive && decision.bypassable !== false) {
            record({
                ...decision,
                allowed: true,
                blocking: false,
                bypassed: true,
                severity: 'warn',
                sourceReason: decision.reason,
                reason: `${decision.reason}_bypassed`,
            });
            return null;
        }

        record({ ...decision, blocking: true, severity: 'warn' });
        return buildBlockedResult(decision, decisions);
    }

    if (bypassRequested) {
        record({
            gate: 'compliance_bypass',
            allowed: bypassActive,
            reason: production ? 'production_rejected' : 'enabled_non_production',
            blocking: false,
            bypassed: bypassActive,
            bypassable: false,
            severity: 'warn',
        });
    }

    try {
        const suppressed = await SuppressionRepository.isSuppressed(phoneNumber);
        const blocked = resolveBlockingDecision({
            gate: 'suppression',
            allowed: !suppressed,
            reason: suppressed ? 'suppressed' : 'not_suppressed',
            statusCode: 403,
            error: 'Number is on the suppression list (DNC)',
            bypassable: false,
        });
        if (blocked) return blocked;
    } catch (err) {
        const blocked = resolveBlockingDecision({
            gate: 'suppression',
            allowed: false,
            reason: 'suppression_check_failed',
            statusCode: 503,
            error: 'Compliance check unavailable: suppression',
            errorMessage: err.message,
            bypassable: false,
        });
        if (blocked) return blocked;
    }

    if (isConsentCheckEnabled()) {
        try {
            const hasConsent = await ConsentRepository.hasValidConsent(phoneNumber);
            const blocked = resolveBlockingDecision({
                gate: 'consent_ledger',
                allowed: Boolean(hasConsent),
                reason: hasConsent ? 'valid_consent' : 'consent_missing',
                statusCode: 403,
                error: 'No valid consent on file for this number',
                bypassable: true,
            });
            if (blocked) return blocked;
        } catch (err) {
            const blocked = resolveBlockingDecision({
                gate: 'consent_ledger',
                allowed: false,
                reason: 'consent_check_failed',
                statusCode: 503,
                error: 'Compliance check unavailable: consent ledger',
                errorMessage: err.message,
                bypassable: true,
            });
            if (blocked) return blocked;
        }
    } else {
        record({
            gate: 'consent_ledger',
            allowed: true,
            reason: 'disabled',
            blocking: false,
            severity: 'info',
        });
    }

    const callingWindow = evaluateCallingWindow(phoneNumber, now);
    const callingWindowStatus = callingWindow.reason === 'calling_window_eval_failed' ? 503 : 403;
    const blockedByCallingWindow = resolveBlockingDecision({
        ...callingWindow,
        gate: 'calling_window',
        statusCode: callingWindowStatus,
        error: callingWindowErrorFor(callingWindow.reason),
        bypassable: true,
    });
    if (blockedByCallingWindow) return blockedByCallingWindow;

    const recordingConsent = evaluateRecordingConsentRequirement(phoneNumber);
    record({
        gate: 'recording_consent',
        allowed: true,
        reason: recordingConsent.reason,
        blocking: false,
        severity: recordingConsent.requireExplicitRecordingConsent ? 'warn' : 'info',
        requireExplicitRecordingConsent: recordingConsent.requireExplicitRecordingConsent,
        state: recordingConsent.state,
        areaCode: recordingConsent.areaCode,
    });

    return {
        allowed: true,
        reason: 'allowed',
        decisions,
        requireExplicitRecordingConsent: recordingConsent.requireExplicitRecordingConsent,
    };
}

module.exports = {
    evaluateOutboundCallCompliance,
    isComplianceBypassEnabled,
    isConsentCheckEnabled,
};
