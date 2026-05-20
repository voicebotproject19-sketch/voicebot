'use strict';

const path = require('path');

const {
    createTwoPhaseResponseConfig,
    getAzureVoiceLiveTranscriptionModel,
    isGptRealtimeVoiceLiveModel,
    isProviderAllowed,
    TWO_PHASE_TELEMETRY_EVENTS
} = require(path.join('..', 'config', 'twoPhaseResponseConfig'));

const EVENTS = require(path.join('..', 'Utils', 'telemetryEvents'));

describe('twoPhaseResponseConfig', () => {
    test('defaults preserve legacy behavior', () => {
        const config = createTwoPhaseResponseConfig({});

        expect(config.enabled).toBe(false);
        expect(config.ackEnabled).toBe(false);
        expect(config.toolRoutingEnabled).toBe(false);
        expect(config.shadowMode).toBe(true);
        expect(config.providerAllowlist).toEqual(['azure-realtime', 'openai-realtime']);
        expect(config.ackMaxMs).toBe(300);
        expect(config.ackGapMs).toBe(80);
        expect(config.toolTimeoutMs).toBe(800);
        expect(config.azureVoiceLiveModel).toBe('');
        expect(config.azureVoiceLiveTranscriptionModel).toBe('azure-speech');
    });

    test('parses explicit flags and numeric overrides', () => {
        const config = createTwoPhaseResponseConfig({
            TWO_PHASE_RESPONSE_ENABLED: 'true',
            TWO_PHASE_ACK_ENABLED: 'true',
            TWO_PHASE_TOOL_ROUTING_ENABLED: 'true',
            TWO_PHASE_SHADOW_MODE: 'false',
            TWO_PHASE_PROVIDER_ALLOWLIST: ' azure-realtime, openai-realtime, azure-realtime ',
            TWO_PHASE_ACK_MAX_MS: '250',
            TWO_PHASE_ACK_GAP_MS: '60',
            TWO_PHASE_TOOL_TIMEOUT_MS: '900',
            AZURE_VOICE_LIVE_MODEL: 'gpt-realtime-mini',
            AZURE_VOICE_LIVE_TRANSCRIPTION_MODEL: 'gpt-4o-transcribe'
        });

        expect(config.enabled).toBe(true);
        expect(config.ackEnabled).toBe(true);
        expect(config.toolRoutingEnabled).toBe(true);
        expect(config.shadowMode).toBe(false);
        expect(config.providerAllowlist).toEqual(['azure-realtime', 'openai-realtime']);
        expect(config.ackMaxMs).toBe(250);
        expect(config.ackGapMs).toBe(60);
        expect(config.toolTimeoutMs).toBe(900);
        expect(config.azureVoiceLiveModel).toBe('gpt-realtime-mini');
        expect(config.azureVoiceLiveTranscriptionModel).toBe('gpt-4o-transcribe');
    });

    test('falls back for invalid numeric values', () => {
        const config = createTwoPhaseResponseConfig({
            TWO_PHASE_ACK_MAX_MS: '-1',
            TWO_PHASE_ACK_GAP_MS: 'abc',
            TWO_PHASE_TOOL_TIMEOUT_MS: '0'
        });

        expect(config.ackMaxMs).toBe(300);
        expect(config.ackGapMs).toBe(80);
        expect(config.toolTimeoutMs).toBe(800);
    });

    test('detects gpt realtime Voice Live models', () => {
        expect(isGptRealtimeVoiceLiveModel('gpt-realtime')).toBe(true);
        expect(isGptRealtimeVoiceLiveModel('gpt-realtime-mini')).toBe(true);
        expect(isGptRealtimeVoiceLiveModel('phi4-mm-realtime')).toBe(false);
        expect(isGptRealtimeVoiceLiveModel('')).toBe(false);
    });

    test('chooses transcription model only for gpt realtime Voice Live models', () => {
        expect(getAzureVoiceLiveTranscriptionModel('gpt-realtime-mini', {})).toBe('gpt-4o-mini-transcribe');
        expect(getAzureVoiceLiveTranscriptionModel('gpt-realtime-mini', {
            AZURE_VOICE_LIVE_TRANSCRIPTION_MODEL: 'gpt-4o-transcribe'
        })).toBe('gpt-4o-transcribe');
        expect(getAzureVoiceLiveTranscriptionModel('phi4-mm-realtime', {
            AZURE_VOICE_LIVE_TRANSCRIPTION_MODEL: 'gpt-4o-transcribe'
        })).toBe('azure-speech');
    });

    test('checks provider allowlist case-insensitively', () => {
        const config = createTwoPhaseResponseConfig({
            TWO_PHASE_PROVIDER_ALLOWLIST: 'azure-realtime'
        });

        expect(isProviderAllowed('AZURE-REALTIME', config)).toBe(true);
        expect(isProviderAllowed('openai-realtime', config)).toBe(false);
        expect(isProviderAllowed('', config)).toBe(false);
    });

    test('registers all Phase 0 telemetry event names', () => {
        for (const eventName of TWO_PHASE_TELEMETRY_EVENTS) {
            expect(EVENTS.has(eventName)).toBe(true);
        }
    });
});
