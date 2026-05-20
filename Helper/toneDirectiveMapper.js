'use strict';

/**
 * Maps sentiment signals (from sentimentDetector.js) and escalation tone overrides
 * (from escalationEngine.js) to prompt instruction strings.
 * Pure function — no I/O, no side effects.
 *
 * The returned directive string is injected into buildTurnPrompt() via ctx.toneDirective.
 * Azure Voice Live has no SSML/prosody controls, so all tone adaptation is prompt-driven.
 */

const TONE_DIRECTIVES = {
    frustration: 'TONE: The caller sounds frustrated. Acknowledge their concern directly. ' +
        'Use phrases like "I understand" or "I hear you." Be concise and solution-focused. ' +
        'Do NOT repeat information already provided.',
    urgency: 'TONE: The caller has urgency. Be efficient and action-oriented. Skip pleasantries. ' +
        'Get to the point quickly. Offer the fastest path to resolution.',
    confusion: 'TONE: The caller seems confused. Simplify your language. Use shorter sentences. ' +
        'Avoid jargon. Clarify one thing at a time.',
    disengagement: 'TONE: The caller seems disengaged. Ask a direct yes/no question to re-engage. ' +
        'If they remain disengaged, offer to wrap up. Keep it very brief.',
    hostility: 'TONE: The caller is upset. Stay calm and professional. Acknowledge their concern ' +
        'without being defensive. Offer concrete next steps or offer to connect them with a team member.',
};

const ESCALATION_DIRECTIVE = 'TONE OVERRIDE: Be formal, concise, no humor. ' +
    'The caller needs precise, direct help. Offer to connect them with a team member if needed.';

/**
 * @param {{ signals: string[], primary: string|null }|null} sentimentResult
 * @param {{ tone: string, humorAllowed: boolean, concise: boolean }|null} escalationToneOverride
 * @returns {string|null} Prompt directive string, or null if no tone adjustment needed
 */
function buildToneDirective(sentimentResult, escalationToneOverride) {
    if (!sentimentResult && !escalationToneOverride) return null;

    // Escalation override takes precedence
    if (escalationToneOverride) return ESCALATION_DIRECTIVE;

    if (!sentimentResult || !sentimentResult.signals || sentimentResult.signals.length === 0) return null;

    // Map primary signal to directive, append secondary if present
    const parts = [];
    for (const signal of sentimentResult.signals) {
        if (TONE_DIRECTIVES[signal]) parts.push(TONE_DIRECTIVES[signal]);
        if (parts.length >= 2) break; // Max 2 directives to avoid prompt bloat
    }
    return parts.length > 0 ? parts.join('\n') : null;
}

module.exports = { buildToneDirective };
