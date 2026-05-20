'use strict';

/**
 * AzureRealtimeAdapter — Azure Voice Live WebSocket implementation.
 *
 * Overrides the abstract protocol methods from BaseRealtimeAdapter to speak
 * Azure's Realtime API: api-key auth, g711_ulaw audio, Voice Live STT
 * model selection, server_echo_cancellation, Azure voice names.
 */

const WebSocket = require('ws');
const BaseRealtimeAdapter = require('./BaseRealtimeAdapter');
const { getAzureVoiceLiveTranscriptionModel } = require('../../config/twoPhaseResponseConfig');

function normalizeModelName(value) {
    return typeof value === 'string' ? value.trim() : '';
}

class AzureRealtimeAdapter extends BaseRealtimeAdapter {

    constructor(config = {}) {
        super(config);
        // Sprint 4.8: Accept endpoint/apiKey override from model router
        this.endpoint = config.endpoint || process.env.AZURE_REALTIME_ENDPOINT;
        this.apiKey   = config.apiKey   || process.env.AZURE_REALTIME_KEY;
        this.model    = normalizeModelName(config.model || process.env.AZURE_VOICE_LIVE_MODEL) || null;
        if (!this.endpoint) {
            throw new Error('AZURE_REALTIME_ENDPOINT env var is required');
        }
        if (!this.apiKey) {
            throw new Error('AZURE_REALTIME_KEY env var is required');
        }
    }

    get providerName() { return 'azure-realtime'; }

    _getProviderVoice() {
        return this.lang?.voice || process.env.AZURE_VOICE_ENGLISH || 'en-US-JennyNeural';
    }

    _createWebSocket() {
        return new WebSocket(this._buildWebSocketEndpoint(), {
            headers: {
                'api-key': this.apiKey,
                'OpenAI-Beta': 'realtime=v1'
            },
            perMessageDeflate: false,
            maxPayload: 10 * 1024 * 1024
        });
    }

    _buildWebSocketEndpoint() {
        if (!this.model) return this.endpoint;

        let endpointUrl;
        try {
            endpointUrl = new URL(this.endpoint);
        } catch (err) {
            console.warn(`[AzureRealtimeAdapter] AZURE_VOICE_LIVE_MODEL ignored because AZURE_REALTIME_ENDPOINT is not a valid URL: ${err.message}`);
            return this.endpoint;
        }

        if (endpointUrl.searchParams.has('model')) return this.endpoint;

        if (this._isVoiceLiveEndpoint(endpointUrl)) {
            endpointUrl.searchParams.set('model', this.model);
            return endpointUrl.toString();
        }

        if (endpointUrl.pathname.includes('/openai/realtime') || endpointUrl.searchParams.has('deployment')) {
            console.warn('[AzureRealtimeAdapter] AZURE_VOICE_LIVE_MODEL ignored for legacy Azure OpenAI Realtime endpoint; use a Voice Live /voice-live/realtime endpoint with model query support.');
        }

        return this.endpoint;
    }

    _isVoiceLiveEndpoint(endpointUrl) {
        return endpointUrl.pathname.toLowerCase().includes('/voice-live/realtime');
    }

    _getEffectiveVoiceLiveModel() {
        let endpointUrl;
        try {
            endpointUrl = new URL(this.endpoint);
        } catch (err) {
            return null;
        }

        if (!this._isVoiceLiveEndpoint(endpointUrl)) return null;
        return normalizeModelName(endpointUrl.searchParams.get('model')) || this.model || null;
    }

    _buildInputAudioTranscription(defaultLanguage = 'en-US') {
        const language = this.lang?.sttLocale || defaultLanguage;
        const transcriptionModel = getAzureVoiceLiveTranscriptionModel(this._getEffectiveVoiceLiveModel());
        if (transcriptionModel === 'azure-speech') {
            return {
                model:    'azure-speech',
                language
            };
        }
        return {
            model: transcriptionModel,
            language
        };
    }

    _buildInitialSessionConfig(instructions) {
        const voice = this._getProviderVoice();
        const voiceRate = this._clampVoiceRate(this.lang?.voiceRate || process.env.AZURE_VOICE_RATE);
        const vadConfig = this.getVADConfig();
        const config = {
            voice:               { type: 'azure-standard', name: voice, ...(voiceRate && { rate: String(voiceRate) }) },
            input_audio_format:  'g711_ulaw',
            output_audio_format: 'g711_ulaw',
            input_audio_transcription: this._buildInputAudioTranscription(),
            ...(this.vadMode !== 'none' && {
                input_audio_echo_cancellation: { type: 'server_echo_cancellation' }
            }),
            ...(this.vadMode !== 'none' && {
                input_audio_noise_reduction: { type: this._validNoiseReduction(process.env.AZURE_NOISE_REDUCTION) }
            }),
            turn_detection:             vadConfig,
            modalities:                 ['audio', 'text'],
            instructions,
            max_response_output_tokens: this._getAdaptiveTokenLimit()
        };
        if (this._includeTempInSessionConfig) {
            config.temperature = Math.max(0.6, Math.min(1.2, this._getAdaptiveTemperature()));
        }
        return config;
    }

    _buildFullSessionConfig(instructions) {
        const voice = this._getProviderVoice();
        const voiceRate = this._clampVoiceRate(this.lang?.voiceRate || process.env.AZURE_VOICE_RATE);
        const config = {
            voice:               { type: 'azure-standard', name: voice, ...(voiceRate && { rate: String(voiceRate) }) },
            input_audio_format:  'g711_ulaw',
            output_audio_format: 'g711_ulaw',
            input_audio_transcription: this._buildInputAudioTranscription(),
            ...(this.vadMode !== 'none' && {
                input_audio_echo_cancellation: { type: 'server_echo_cancellation' }
            }),
            ...(this.vadMode !== 'none' && {
                input_audio_noise_reduction: { type: this._validNoiseReduction(process.env.AZURE_NOISE_REDUCTION) }
            }),
            turn_detection:             this.getVADConfig(),
            modalities:                 ['audio', 'text'],
            instructions,
            max_response_output_tokens: this._getAdaptiveTokenLimit()
        };
        if (this._includeTempInSessionConfig) {
            config.temperature = Math.max(0.6, Math.min(1.2, this._getAdaptiveTemperature()));
        }
        return config;
    }

    _buildResponseCreate(opts = {}) {
        const voiceRate = this._clampVoiceRate(this.lang?.voiceRate || process.env.AZURE_VOICE_RATE);
        // Azure Voice Live Realtime API does not support max_response_output_tokens
        // or temperature in response.create — strip them to avoid invalid_value errors.
        // These fields are already enforced at the session level via session.update.
        const { max_response_output_tokens, temperature, ...safeOpts } = opts;
        const payload = {
            type: 'response.create',
            response: {
                voice:      { type: 'azure-standard', name: this._getProviderVoice(), ...(voiceRate && { rate: String(voiceRate) }) },
                modalities: ['audio', 'text'],
                ...safeOpts
            }
        };
        return payload;
    }

    _formatAudioForProvider(mulawBuffer) {
        // Azure accepts g711_ulaw natively — no transcoding needed.
        // Fast-path: Plivo already sends 160-byte frames (20ms at 8kHz),
        // so skip the chunking loop for the common case.
        const CHUNK_SIZE = 160;
        if (mulawBuffer.length <= CHUNK_SIZE) {
            return [{ audio: mulawBuffer.toString('base64') }];
        }
        const chunks = [];
        for (let i = 0; i < mulawBuffer.length; i += CHUNK_SIZE) {
            const chunk = mulawBuffer.slice(i, Math.min(i + CHUNK_SIZE, mulawBuffer.length));
            chunks.push({ audio: chunk.toString('base64') });
        }
        return chunks;
    }

    _parseAudioDelta(message) {
        // Azure sends base64-encoded g711_ulaw audio in message.delta.
        return Buffer.from(message.delta, 'base64');
    }

    /** Clamp voice rate to API-valid range "0.5"–"1.5"; return undefined if unset. */
    _clampVoiceRate(raw) {
        if (!raw) return undefined;
        const n = parseFloat(raw);
        if (!Number.isFinite(n)) return undefined;
        return String(Math.max(0.5, Math.min(1.5, n)));
    }

    /** Allowlist noise reduction types — only azure_deep_noise_suppression is valid for Voice Live. */
    _validNoiseReduction(val) {
        const ALLOWED = new Set(['azure_deep_noise_suppression']);
        return ALLOWED.has(val) ? val : 'azure_deep_noise_suppression';
    }
}

module.exports = AzureRealtimeAdapter;
