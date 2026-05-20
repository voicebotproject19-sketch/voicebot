'use strict';

/**
 * Sprint 4.8: Model Router
 *
 * Central routing logic for selecting AI provider per call.
 * Supports environment-based overrides, persona-specific routing,
 * and A/B experiment splitting (Sprint 4.9).
 *
 * Environment variables:
 *   MODEL_ROUTER_ENABLED=true          — Enable model routing (default: false)
 *   MODEL_ROUTER_GPT4O_ENDPOINT        — GPT-4o realtime endpoint URL
 *   MODEL_ROUTER_GPT4O_API_KEY         — GPT-4o API key
 *   MODEL_ROUTER_AB_ENABLED=true       — Enable A/B experiment (Sprint 4.9)
 *   MODEL_ROUTER_AB_GPT4O_PERCENT=10   — % of calls routed to GPT-4o (0-100)
 */

const telemetry = require('../../Utils/telemetry');

const ROUTER_ENABLED     = process.env.MODEL_ROUTER_ENABLED === 'true';
const AB_ENABLED         = process.env.MODEL_ROUTER_AB_ENABLED === 'true';
const GPT4O_PERCENT      = Math.max(0, Math.min(100, Number(process.env.MODEL_ROUTER_AB_GPT4O_PERCENT) || 0));
const GPT4O_ENDPOINT     = process.env.MODEL_ROUTER_GPT4O_ENDPOINT || '';
const GPT4O_API_KEY      = process.env.MODEL_ROUTER_GPT4O_API_KEY || '';

/**
 * Determine which model configuration to use for a given call.
 *
 * @param {object} opts
 * @param {string} opts.callSID       - Unique call identifier
 * @param {string} opts.baseProvider  - Provider resolved by resolveCallAIProvider ('azure-realtime')
 * @param {object} [opts.persona]     - Persona config (may have modelRouting overrides)
 * @param {string} [opts.language]    - Language code
 * @returns {{ provider: string, endpoint?: string, apiKey?: string, model?: string, abCohort: string }}
 */
function routeModel({ callSID, baseProvider, persona, language }) {
    if (!ROUTER_ENABLED) {
        return { provider: baseProvider, abCohort: 'control' };
    }

    // Persona-level override (explicit routing)
    if (persona?.modelRouting?.provider) {
        const r = persona.modelRouting;
        telemetry.emit('model_selected', {
            callSID, provider: r.provider, reason: 'persona_override', abCohort: 'none', ts: Date.now()
        });
        return {
            provider: r.provider,
            endpoint: r.endpoint,
            apiKey:   r.apiKey,
            model:    r.model,
            abCohort: 'none'
        };
    }

    // Sprint 4.9: A/B experiment split
    if (AB_ENABLED && GPT4O_ENDPOINT && GPT4O_API_KEY && GPT4O_PERCENT > 0) {
        const inExperiment = Math.random() * 100 < GPT4O_PERCENT;
        if (inExperiment) {
            telemetry.emit('model_selected', {
                callSID, provider: 'openai-realtime', reason: 'ab_experiment',
                abCohort: 'experiment', percent: GPT4O_PERCENT, ts: Date.now()
            });
            return {
                provider: 'openai-realtime',
                endpoint: GPT4O_ENDPOINT,
                apiKey:   GPT4O_API_KEY,
                // Sprint 6A.2 (N4): env-configurable model (was hardcoded)
                model:    process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-1.5',
                abCohort: 'experiment'
            };
        }
    }

    // Default: control cohort (phi4 / azure-realtime)
    telemetry.emit('model_selected', {
        callSID, provider: baseProvider, reason: 'default', abCohort: 'control', ts: Date.now()
    });
    return { provider: baseProvider, abCohort: 'control' };
}

module.exports = { routeModel, ROUTER_ENABLED };
