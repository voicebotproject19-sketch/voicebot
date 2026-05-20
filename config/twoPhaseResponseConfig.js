'use strict';

const DEFAULT_PROVIDER_ALLOWLIST = Object.freeze(['azure-realtime', 'openai-realtime']);
const GPT_REALTIME_MODELS = Object.freeze(new Set(['gpt-realtime', 'gpt-realtime-mini']));

const TWO_PHASE_TELEMETRY_EVENTS = Object.freeze([
    'two_phase_eligible',
    'two_phase_skipped',
    'route_tool_started',
    'route_tool_completed',
    'route_tool_fallback',
    'micro_ack_played',
    'micro_ack_skipped',
    'micro_ack_completed',
    'micro_ack_cleared',
    'model_audio_queued_for_ack',
    'model_audio_flushed_after_ack'
]);

function parseBool(value, defaultValue = false) {
    if (value === undefined || value === null || value === '') return defaultValue;
    return String(value).trim().toLowerCase() === 'true';
}

function parsePositiveInt(value, defaultValue) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function parseProviderAllowlist(value) {
    if (!value) return [...DEFAULT_PROVIDER_ALLOWLIST];
    const providers = String(value)
        .split(',')
        .map(provider => provider.trim().toLowerCase())
        .filter(Boolean);
    return providers.length > 0 ? [...new Set(providers)] : [...DEFAULT_PROVIDER_ALLOWLIST];
}

function normalizeModelName(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function isGptRealtimeVoiceLiveModel(model) {
    return GPT_REALTIME_MODELS.has(normalizeModelName(model));
}

function getAzureVoiceLiveTranscriptionModel(model, env = process.env) {
    if (!isGptRealtimeVoiceLiveModel(model)) return 'azure-speech';
    return normalizeModelName(env.AZURE_VOICE_LIVE_TRANSCRIPTION_MODEL) || 'gpt-4o-mini-transcribe';
}

function createTwoPhaseResponseConfig(env = process.env) {
    const azureVoiceLiveModel = normalizeModelName(env.AZURE_VOICE_LIVE_MODEL);
    const providerAllowlist = parseProviderAllowlist(env.TWO_PHASE_PROVIDER_ALLOWLIST);

    return Object.freeze({
        enabled: parseBool(env.TWO_PHASE_RESPONSE_ENABLED, false),
        ackEnabled: parseBool(env.TWO_PHASE_ACK_ENABLED, false),
        toolRoutingEnabled: parseBool(env.TWO_PHASE_TOOL_ROUTING_ENABLED, false),
        shadowMode: parseBool(env.TWO_PHASE_SHADOW_MODE, true),
        providerAllowlist: Object.freeze(providerAllowlist),
        ackMaxMs: parsePositiveInt(env.TWO_PHASE_ACK_MAX_MS, 300),
        ackGapMs: parsePositiveInt(env.TWO_PHASE_ACK_GAP_MS, 80),
        toolTimeoutMs: parsePositiveInt(env.TWO_PHASE_TOOL_TIMEOUT_MS, 800),
        azureVoiceLiveModel,
        azureVoiceLiveTranscriptionModel: getAzureVoiceLiveTranscriptionModel(azureVoiceLiveModel, env),
        telemetryEvents: TWO_PHASE_TELEMETRY_EVENTS
    });
}

function isProviderAllowed(providerName, config = TWO_PHASE_RESPONSE) {
    if (!providerName) return false;
    return config.providerAllowlist.includes(String(providerName).trim().toLowerCase());
}

const TWO_PHASE_RESPONSE = createTwoPhaseResponseConfig();

module.exports = {
    createTwoPhaseResponseConfig,
    getAzureVoiceLiveTranscriptionModel,
    isGptRealtimeVoiceLiveModel,
    isProviderAllowed,
    TWO_PHASE_RESPONSE,
    TWO_PHASE_TELEMETRY_EVENTS
};
