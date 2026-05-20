'use strict';

jest.mock('ws', () => jest.fn(function MockWebSocket() {}));

const WebSocket = require('ws');
const AzureRealtimeAdapter = require('../adapters/ai/AzureRealtimeAdapter');

const VOICE_LIVE_ENDPOINT = 'wss://example.services.ai.azure.com/voice-live/realtime?api-version=2025-10-01';

function makeAdapter({ endpoint = VOICE_LIVE_ENDPOINT, model = null, language = 'en-US' } = {}) {
    const adapter = Object.create(AzureRealtimeAdapter.prototype);
    adapter.endpoint = endpoint;
    adapter.apiKey = 'test-key';
    adapter.model = model;
    adapter.lang = { sttLocale: language };
    adapter.vadMode = 'none';
    adapter._includeTempInSessionConfig = false;
    adapter.getVADConfig = jest.fn(() => null);
    adapter._getAdaptiveTokenLimit = jest.fn(() => 100);
    adapter._getAdaptiveTemperature = jest.fn(() => 0.8);
    return adapter;
}

describe('AzureRealtimeAdapter Phase 1 Voice Live readiness', () => {
    let savedVoiceLiveModel;
    let savedTranscriptionModel;
    let warnSpy;

    beforeEach(() => {
        WebSocket.mockClear();
        savedVoiceLiveModel = process.env.AZURE_VOICE_LIVE_MODEL;
        savedTranscriptionModel = process.env.AZURE_VOICE_LIVE_TRANSCRIPTION_MODEL;
        delete process.env.AZURE_VOICE_LIVE_MODEL;
        delete process.env.AZURE_VOICE_LIVE_TRANSCRIPTION_MODEL;
        warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        if (savedVoiceLiveModel === undefined) delete process.env.AZURE_VOICE_LIVE_MODEL;
        else process.env.AZURE_VOICE_LIVE_MODEL = savedVoiceLiveModel;

        if (savedTranscriptionModel === undefined) delete process.env.AZURE_VOICE_LIVE_TRANSCRIPTION_MODEL;
        else process.env.AZURE_VOICE_LIVE_TRANSCRIPTION_MODEL = savedTranscriptionModel;

        warnSpy.mockRestore();
    });

    test('constructor stores explicit config model before env model', () => {
        process.env.AZURE_VOICE_LIVE_MODEL = 'gpt-realtime';

        const adapter = new AzureRealtimeAdapter({
            endpoint: VOICE_LIVE_ENDPOINT,
            apiKey: 'test-key',
            model: ' gpt-realtime-mini '
        });

        expect(adapter.model).toBe('gpt-realtime-mini');
    });

    test('constructor reads AZURE_VOICE_LIVE_MODEL when config model is unset', () => {
        process.env.AZURE_VOICE_LIVE_MODEL = ' gpt-realtime-mini ';

        const adapter = new AzureRealtimeAdapter({
            endpoint: VOICE_LIVE_ENDPOINT,
            apiKey: 'test-key'
        });

        expect(adapter.model).toBe('gpt-realtime-mini');
    });

    test('appends model query for Voice Live endpoint without existing model', () => {
        const adapter = makeAdapter({
            endpoint: `${VOICE_LIVE_ENDPOINT}&foo=bar`,
            model: 'gpt-realtime-mini'
        });

        adapter._createWebSocket();

        const [url, options] = WebSocket.mock.calls[0];
        const parsed = new URL(url);
        expect(parsed.pathname).toBe('/voice-live/realtime');
        expect(parsed.searchParams.get('api-version')).toBe('2025-10-01');
        expect(parsed.searchParams.get('foo')).toBe('bar');
        expect(parsed.searchParams.get('model')).toBe('gpt-realtime-mini');
        expect(options.headers['api-key']).toBe('test-key');
    });

    test('preserves endpoint model query when one is already present', () => {
        const endpoint = `${VOICE_LIVE_ENDPOINT}&model=phi4-mm-realtime`;
        const adapter = makeAdapter({ endpoint, model: 'gpt-realtime-mini' });

        adapter._createWebSocket();

        expect(WebSocket.mock.calls[0][0]).toBe(endpoint);
    });

    test('leaves Voice Live endpoint unchanged when model override is unset', () => {
        const adapter = makeAdapter({ endpoint: VOICE_LIVE_ENDPOINT, model: null });

        adapter._createWebSocket();

        expect(WebSocket.mock.calls[0][0]).toBe(VOICE_LIVE_ENDPOINT);
    });

    test('warns and leaves legacy Azure OpenAI Realtime endpoint unchanged', () => {
        const endpoint = 'wss://example.openai.azure.com/openai/realtime?api-version=2024-10-01-preview&deployment=legacy-realtime';
        const adapter = makeAdapter({ endpoint, model: 'gpt-realtime-mini' });

        adapter._createWebSocket();

        expect(WebSocket.mock.calls[0][0]).toBe(endpoint);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('AZURE_VOICE_LIVE_MODEL ignored for legacy Azure OpenAI Realtime endpoint'));
    });

    test('uses gpt realtime transcription model for configured Voice Live gpt model', () => {
        process.env.AZURE_VOICE_LIVE_TRANSCRIPTION_MODEL = 'gpt-4o-transcribe';
        const adapter = makeAdapter({ model: 'gpt-realtime-mini', language: 'de-DE' });

        const initialConfig = adapter._buildInitialSessionConfig('hello');
        const fullConfig = adapter._buildFullSessionConfig('hello again');

        expect(initialConfig.input_audio_transcription).toEqual({
            model: 'gpt-4o-transcribe',
            language: 'de-DE'
        });
        expect(fullConfig.input_audio_transcription).toEqual({
            model: 'gpt-4o-transcribe',
            language: 'de-DE'
        });
    });

    test('uses default gpt realtime transcription model when endpoint already selects gpt realtime', () => {
        const adapter = makeAdapter({
            endpoint: `${VOICE_LIVE_ENDPOINT}&model=gpt-realtime-mini`,
            model: null
        });

        const config = adapter._buildFullSessionConfig('hello');

        expect(config.input_audio_transcription.model).toBe('gpt-4o-mini-transcribe');
    });

    test('keeps azure-speech for phi4 endpoint model even when override is configured', () => {
        const adapter = makeAdapter({
            endpoint: `${VOICE_LIVE_ENDPOINT}&model=phi4-mm-realtime`,
            model: 'gpt-realtime-mini'
        });

        const config = adapter._buildInitialSessionConfig('hello');

        expect(config.input_audio_transcription).toEqual({
            model: 'azure-speech',
            language: 'en-US'
        });
    });

    test('keeps azure-speech when no effective Voice Live gpt model exists', () => {
        const adapter = makeAdapter({ model: null });

        const config = adapter._buildFullSessionConfig('hello');

        expect(config.input_audio_transcription).toEqual({
            model: 'azure-speech',
            language: 'en-US'
        });
    });
});
