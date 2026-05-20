'use strict';

/**
 * OpenAIRealtimeAdapter — OpenAI Realtime API WebSocket implementation.
 *
 * Key differences from Azure:
 * - Endpoint: wss://api.openai.com/v1/realtime?model=<model>
 * - Auth: Authorization: Bearer <key>
 * - Audio format: pcm16 at 24kHz (requires μ-law ↔ PCM16 transcoding)
 * - STT: gpt-4o-transcribe (no locale field)
 * - Voice: OpenAI voice IDs (alloy, echo, nova, shimmer, etc.)
 * - VAD: server_vad / semantic_vad (not azure_semantic_vad)
 * - No echo cancellation field; has noise_reduction option
 * - Session config uses nested audio format (GA API shape)
 */

const WebSocket = require('ws');
const BaseRealtimeAdapter = require('./BaseRealtimeAdapter');
const { mulawToLinear16_24k, linear16_24kToMulaw } = require('../../Utils/audioTranscode');

class OpenAIRealtimeAdapter extends BaseRealtimeAdapter {

    constructor(config = {}) {
        super(config);
        // Sprint 4.8: Accept endpoint/apiKey/model override from model router
        // Sprint 6A.1 (F5): Migrated to gpt-realtime-1.5 (gpt-4o-realtime-preview shutdown May 7 2026)
        this._openaiApiKey  = config.apiKey || process.env.OPENAI_REALTIME_API_KEY || process.env.OPENAI_API_KEY;
        this._openaiModel   = config.model || process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-1.5';
        this._openaiEndpoint = config.endpoint || process.env.OPENAI_REALTIME_ENDPOINT
            || `wss://api.openai.com/v1/realtime?model=${this._openaiModel}`;
        if (!this._openaiApiKey) {
            throw new Error('OPENAI_REALTIME_API_KEY or OPENAI_API_KEY env var is required');
        }
    }

    get providerName() { return 'openai-realtime'; }

    _buildAudioConfig() {
        return {
            input: {
                format: {
                    type: 'audio/pcm'
                },
                noise_reduction: {
                    type: process.env.OPENAI_NOISE_REDUCTION || 'near_field'
                },
                transcription: {
                    model: 'gpt-4o-transcribe'
                },
                turn_detection: this.getVADConfig()
            },
            output: {
                format: {
                    type: 'audio/pcm'
                },
                voice: this._getProviderVoice()
            }
        };
    }

    _buildSessionConfig(instructions) {
        return {
            type: 'realtime',
            modalities: ['audio', 'text'],
            instructions,
            audio: this._buildAudioConfig(),
            max_response_output_tokens: this._getAdaptiveTokenLimit(),
            temperature: this._getAdaptiveTemperature(),

            // Compatibility aliases retained alongside GA audio config.
        // TODO(6C.3/F8): Remove once all deployments use GA nested audio format.
            voice: this._getProviderVoice(),
            input_audio_format: 'pcm16',
            output_audio_format: 'pcm16',
            input_audio_transcription: {
                model: 'gpt-4o-transcribe'
            },
            turn_detection: this.getVADConfig(),
            input_audio_noise_reduction: {
                type: process.env.OPENAI_NOISE_REDUCTION || 'near_field'
            }
        };
    }

    _getProviderVoice() {
        // Use openaiVoice from persona config; fallback to 'nova'
        return this.lang?.openaiVoice || process.env.OPENAI_REALTIME_VOICE || 'nova';
    }

    _createWebSocket() {
        // OpenAI Realtime WebSocket: model in query param, Bearer auth
        const url = this._openaiEndpoint.includes('?')
            ? this._openaiEndpoint
            : `${this._openaiEndpoint}?model=${this._openaiModel}`;

        return new WebSocket(url, {
            headers: {
                'Authorization': `Bearer ${this._openaiApiKey}`
            },
            perMessageDeflate: false,
            maxPayload: 15 * 1024 * 1024
        });
    }

    /**
     * Map VAD mode from Azure naming to OpenAI naming.
     * azure_semantic_vad → semantic_vad
     */
    getVADConfig() {
        if (this.vadMode === 'none') return { type: 'none' };

        const lang = (this._langCode || 'en').toUpperCase();
        const prefixPadding   = Number(process.env[`VAD_PREFIX_PADDING_${lang}`])   || Number(process.env.VAD_PREFIX_PADDING)   || 200;
        const silenceDuration = Number(process.env[`VAD_SILENCE_DURATION_${lang}`]) || Number(process.env.VAD_SILENCE_DURATION) || 400;

        // Sprint 4.5 Step 2.1: Semantic VAD uses eagerness, not silence/prefix/threshold
        if (this.vadMode === 'azure_semantic_vad' || this.vadMode === 'azure_semantic_vad_multilingual') {
            const eagerness = this._vadAbAssignment?.eagerness
                ?? this._audioConfig?.vadEagerness
                ?? process.env.AZURE_VAD_EAGERNESS ?? 'medium';
            return { type: 'semantic_vad', eagerness, create_response: false, interrupt_response: true };
        }

        const base = { prefix_padding_ms: prefixPadding, silence_duration_ms: silenceDuration, create_response: false };
        const threshold = parseFloat(process.env[`VAD_THRESHOLD_${lang}`] || process.env.AZURE_VAD_THRESHOLD || '0.5');
        return { type: 'server_vad', threshold, ...base };
    }

    _buildInitialSessionConfig(instructions) {
        return this._buildSessionConfig(instructions);
    }

    _buildFullSessionConfig(instructions) {
        return this._buildSessionConfig(instructions);
    }

    _buildResponseCreate(opts = {}) {
        const response = {
            output_modalities: ['audio', 'text'],
            ...opts
        };

        if (response.modalities) {
            response.output_modalities = response.modalities;
            delete response.modalities;
        }

        return {
            type: 'response.create',
            response
        };
    }

    _formatAudioForProvider(mulawBuffer) {
        // Transcode μ-law 8kHz → PCM16 24kHz for OpenAI
        const pcm24k = mulawToLinear16_24k(mulawBuffer);

        // Chunk into ~960 bytes (20ms at 24kHz, 16-bit = 24000 * 0.02 * 2 = 960 bytes)
        const CHUNK_SIZE = 960;
        const chunks = [];
        for (let i = 0; i < pcm24k.length; i += CHUNK_SIZE) {
            const chunk = pcm24k.slice(i, Math.min(i + CHUNK_SIZE, pcm24k.length));
            chunks.push({ audio: chunk.toString('base64') });
        }
        return chunks;
    }

    _parseAudioDelta(message) {
        // OpenAI sends base64-encoded PCM16 24kHz audio in message.delta.
        // Transcode to μ-law 8kHz for telephony.
        const pcm24kBuf = Buffer.from(message.delta, 'base64');
        const mulawBuf = linear16_24kToMulaw(pcm24kBuf);
        return mulawBuf;
    }
}

module.exports = OpenAIRealtimeAdapter;
