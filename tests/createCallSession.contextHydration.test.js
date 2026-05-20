'use strict';

const { EventEmitter } = require('events');

describe('createCallSession durable context hydration', () => {
    let hydrateCallRegistry;
    let registryGet;
    let registryUpdate;
    let registerCxState;
    let telemetryEmit;

    beforeEach(() => {
        jest.resetModules();
        hydrateCallRegistry = jest.fn();
        registryGet = jest.fn(() => null);
        registryUpdate = jest.fn();
        registerCxState = jest.fn();
        telemetryEmit = jest.fn();

        jest.doMock('../Noise-Reducer/noise-reducer', () => ({
            RealTimeRNNoise: jest.fn().mockImplementation(() => ({
                initialize: jest.fn(),
                processChunk: jest.fn(),
                destroy: jest.fn()
            }))
        }));
        jest.doMock('../services/CallRegistry', () => ({
            get: registryGet,
            create: jest.fn((callSID, state) => ({ callId: callSID, ...state })),
            update: registryUpdate,
            delete: jest.fn()
        }));
        jest.doMock('../services/CallContextStore', () => ({
            hydrateCallRegistry,
            patchContext: jest.fn().mockResolvedValue(true)
        }));
        jest.doMock('../services/CXStateRegistry', () => ({
            register: registerCxState,
            delete: jest.fn()
        }));
        jest.doMock('../Utils/telemetry', () => ({ emit: telemetryEmit }));
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('uses hydrated snapshot fields for realtime initialization when local registry is empty', async () => {
        hydrateCallRegistry.mockResolvedValueOnce({
            callId: 'CA11111111111111111111111111111111',
            sid: 'CA11111111111111111111111111111111',
            recipient: '+14155550111',
            phoneNumber: '+14155550111',
            provider: 'twilio',
            name: 'Alex Buyer',
            persona: 'company-sales',
            language: 'en',
            aiProvider: 'azure-realtime',
            contextHint: null,
            policyConfig: null,
            requireExplicitRecordingConsent: true,
            status: 'connected'
        });

        const realtimeInstances = [];
        class FakeRealtimeService extends EventEmitter {
            constructor() {
                super();
                this.initialize = jest.fn();
                this.close = jest.fn();
                realtimeInstances.push(this);
            }
        }

        class FakeStreamService {
            setStreamId = jest.fn();
            stopCurrentAudio = jest.fn();
            startHoldMusic = jest.fn();
            stopHoldMusic = jest.fn();
        }

        const provider = {
            name: 'twilio',
            getGateConfig: () => ({
                dynamicThresholdOffset: 0,
                silenceFramesThreshold: 10,
                energyOverrideThreshold: null,
                maxSilenceFailsafe: null
            }),
            extractStartFields: (msg) => ({
                callId: msg.start.callSid,
                streamId: msg.start.streamSid,
                callerNumber: msg.start.from
            }),
            requiresSessionConfigured: true,
            hasPreConnectBuffer: false,
            audioBufferStrategy: 'fifo-queue',
            hangup: jest.fn()
        };

        const ws = new EventEmitter();
        const res = { accept: jest.fn().mockResolvedValue(ws) };
        const { createCallSession } = require('../session/createCallSession');

        await createCallSession(provider, {
            streamServiceClass: FakeStreamService,
            realtimeServiceClass: FakeRealtimeService
        })({}, res);

        ws.emit('message', JSON.stringify({
            event: 'start',
            start: {
                callSid: 'CA11111111111111111111111111111111',
                streamSid: 'MZ11111111111111111111111111111111',
                from: '+14155550999'
            }
        }));
        await new Promise(resolve => setImmediate(resolve));

        expect(hydrateCallRegistry).toHaveBeenCalledWith('CA11111111111111111111111111111111', expect.objectContaining({
            recipient: '+14155550999',
            provider: 'twilio',
            status: 'connected'
        }));
        expect(realtimeInstances).toHaveLength(1);
        expect(realtimeInstances[0].requireExplicitRecordingConsent).toBe(true);
        expect(realtimeInstances[0].initialize).toHaveBeenCalledWith(
            'CA11111111111111111111111111111111',
            '+14155550111',
            'Alex Buyer',
            'company-sales',
            'en',
            expect.objectContaining({ currentTurnId: expect.any(String) }),
            null
        );
        expect(registerCxState).toHaveBeenCalledWith('CA11111111111111111111111111111111', expect.objectContaining({
            realtimeService: realtimeInstances[0]
        }));
    });

    test('normal user speech start does not stop audio or cancel response', async () => {
        hydrateCallRegistry.mockResolvedValueOnce({
            callId: 'CA44444444444444444444444444444444',
            sid: 'CA44444444444444444444444444444444',
            recipient: '+14155550444',
            phoneNumber: '+14155550444',
            provider: 'twilio',
            name: 'Morgan Buyer',
            persona: 'company-sales',
            language: 'en',
            aiProvider: 'azure-realtime',
            contextHint: null,
            policyConfig: null,
            requireExplicitRecordingConsent: false,
            status: 'connected'
        });

        const realtimeInstances = [];
        class FakeRealtimeService extends EventEmitter {
            constructor() {
                super();
                this.initialize = jest.fn();
                this.close = jest.fn();
                this.cancelResponse = jest.fn();
                this.markBargeInOccurred = jest.fn();
                this.clearPrewarmKnowledge = jest.fn();
                realtimeInstances.push(this);
            }
        }

        const streamInstances = [];
        class FakeStreamService {
            constructor() {
                this.setStreamId = jest.fn();
                this.stopCurrentAudio = jest.fn();
                this.startHoldMusic = jest.fn();
                this.stopHoldMusic = jest.fn();
                this.clearAudioTask = jest.fn();
                streamInstances.push(this);
            }
        }

        const provider = {
            name: 'twilio',
            getGateConfig: () => ({
                dynamicThresholdOffset: 0,
                silenceFramesThreshold: 10,
                energyOverrideThreshold: null,
                maxSilenceFailsafe: null
            }),
            extractStartFields: (msg) => ({
                callId: msg.start.callSid,
                streamId: msg.start.streamSid,
                callerNumber: msg.start.from
            }),
            requiresSessionConfigured: true,
            hasPreConnectBuffer: false,
            audioBufferStrategy: 'fifo-queue',
            hangup: jest.fn()
        };

        const ws = new EventEmitter();
        const res = { accept: jest.fn().mockResolvedValue(ws) };
        const { createCallSession } = require('../session/createCallSession');

        await createCallSession(provider, {
            streamServiceClass: FakeStreamService,
            realtimeServiceClass: FakeRealtimeService
        })({}, res);

        ws.emit('message', JSON.stringify({
            event: 'start',
            start: {
                callSid: 'CA44444444444444444444444444444444',
                streamSid: 'MZ44444444444444444444444444444444',
                from: '+14155550499'
            }
        }));
        await new Promise(resolve => setImmediate(resolve));
        streamInstances[0].stopCurrentAudio.mockClear();

        realtimeInstances[0].emit('user_speech_started', { timestamp: Date.now(), isBargeIn: false });

        expect(streamInstances[0].stopCurrentAudio).not.toHaveBeenCalled();
        expect(realtimeInstances[0].markBargeInOccurred).not.toHaveBeenCalled();
        expect(realtimeInstances[0].cancelResponse).not.toHaveBeenCalled();
    });

    test('true interruption stops audio and cancels response', async () => {
        hydrateCallRegistry.mockResolvedValueOnce({
            callId: 'CA55555555555555555555555555555555',
            sid: 'CA55555555555555555555555555555555',
            recipient: '+14155550555',
            phoneNumber: '+14155550555',
            provider: 'twilio',
            name: 'Casey Buyer',
            persona: 'company-sales',
            language: 'en',
            aiProvider: 'azure-realtime',
            contextHint: null,
            policyConfig: null,
            requireExplicitRecordingConsent: false,
            status: 'connected'
        });

        const realtimeInstances = [];
        class FakeRealtimeService extends EventEmitter {
            constructor() {
                super();
                this.initialize = jest.fn();
                this.close = jest.fn();
                this.cancelResponse = jest.fn();
                this.markBargeInOccurred = jest.fn();
                this.clearPrewarmKnowledge = jest.fn();
                realtimeInstances.push(this);
            }
        }

        const streamInstances = [];
        class FakeStreamService {
            constructor() {
                this.setStreamId = jest.fn();
                this.stopCurrentAudio = jest.fn();
                this.startHoldMusic = jest.fn();
                this.stopHoldMusic = jest.fn();
                this.clearAudioTask = jest.fn();
                streamInstances.push(this);
            }
        }

        const provider = {
            name: 'twilio',
            getGateConfig: () => ({
                dynamicThresholdOffset: 0,
                silenceFramesThreshold: 10,
                energyOverrideThreshold: null,
                maxSilenceFailsafe: null
            }),
            extractStartFields: (msg) => ({
                callId: msg.start.callSid,
                streamId: msg.start.streamSid,
                callerNumber: msg.start.from
            }),
            requiresSessionConfigured: true,
            hasPreConnectBuffer: false,
            audioBufferStrategy: 'fifo-queue',
            hangup: jest.fn()
        };

        const ws = new EventEmitter();
        const res = { accept: jest.fn().mockResolvedValue(ws) };
        const { createCallSession } = require('../session/createCallSession');

        await createCallSession(provider, {
            streamServiceClass: FakeStreamService,
            realtimeServiceClass: FakeRealtimeService
        })({}, res);

        ws.emit('message', JSON.stringify({
            event: 'start',
            start: {
                callSid: 'CA55555555555555555555555555555555',
                streamSid: 'MZ55555555555555555555555555555555',
                from: '+14155550599'
            }
        }));
        await new Promise(resolve => setImmediate(resolve));
        streamInstances[0].stopCurrentAudio.mockClear();

        realtimeInstances[0].emit('user_speech_started', { timestamp: Date.now(), isBargeIn: true });
        realtimeInstances[0].emit('interruption', { cancelledResponseId: 'response-55', isBargeIn: true });

        expect(streamInstances[0].stopCurrentAudio).toHaveBeenCalledWith('response-55');
        expect(realtimeInstances[0].markBargeInOccurred).toHaveBeenCalledTimes(1);
        expect(realtimeInstances[0].cancelResponse).toHaveBeenCalledTimes(1);
    });

    test('reconnect lifecycle starts and stops hold music deterministically', async () => {
        hydrateCallRegistry.mockResolvedValueOnce({
            callId: 'plivo-call-666',
            sid: 'plivo-call-666',
            recipient: '+14155550666',
            phoneNumber: '+14155550666',
            provider: 'plivo',
            name: 'Riley Buyer',
            persona: 'company-sales',
            language: 'en',
            aiProvider: 'azure-realtime',
            contextHint: null,
            policyConfig: null,
            requireExplicitRecordingConsent: false,
            status: 'connected'
        });

        const realtimeInstances = [];
        class FakeRealtimeService extends EventEmitter {
            constructor() {
                super();
                this.initialize = jest.fn();
                this.close = jest.fn();
                realtimeInstances.push(this);
            }
        }

        const streamInstances = [];
        class FakeStreamService {
            constructor() {
                this.ws = { readyState: 1, close: jest.fn() };
                this.setStreamId = jest.fn();
                this.stopCurrentAudio = jest.fn();
                this.startHoldMusic = jest.fn();
                this.stopHoldMusic = jest.fn();
                this.clearAudioTask = jest.fn();
                this.sendAudioDirect = jest.fn();
                streamInstances.push(this);
            }
        }

        const provider = {
            name: 'plivo',
            getGateConfig: () => ({
                dynamicThresholdOffset: 0,
                silenceFramesThreshold: 10,
                energyOverrideThreshold: null,
                maxSilenceFailsafe: null
            }),
            extractStartFields: (msg) => ({
                callId: msg.start.callId,
                streamId: msg.start.streamId,
                callerNumber: msg.start.from
            }),
            requiresSessionConfigured: true,
            hasPreConnectBuffer: false,
            audioBufferStrategy: 'fifo-queue',
            hangup: jest.fn()
        };

        const ws = new EventEmitter();
        const res = { accept: jest.fn().mockResolvedValue(ws) };
        const { createCallSession } = require('../session/createCallSession');

        await createCallSession(provider, {
            streamServiceClass: FakeStreamService,
            realtimeServiceClass: FakeRealtimeService
        })({}, res);

        ws.emit('message', JSON.stringify({
            event: 'start',
            start: {
                callId: 'plivo-call-666',
                streamId: 'plivo-stream-666',
                from: '+14155550699'
            }
        }));
        await new Promise(resolve => setImmediate(resolve));

        realtimeInstances[0].emit('disconnected', { isServerError: true, isRegionError: false });
        expect(streamInstances[0].startHoldMusic).toHaveBeenCalledTimes(1);

        realtimeInstances[0].emit('reconnected', { attempt: 1 });
        expect(streamInstances[0].stopHoldMusic).toHaveBeenCalledTimes(1);

        realtimeInstances[0].emit('disconnected', { isAbnormal: true, isRegionError: false });
        ws.emit('close');
        expect(streamInstances[0].stopHoldMusic).toHaveBeenCalledTimes(2);
    });

    test('emits reconnect hold-music telemetry for start, stop, and failsafe branches', async () => {
        const originalHoldMax = process.env.HOLD_MUSIC_MAX_DURATION_MS;
        process.env.HOLD_MUSIC_MAX_DURATION_MS = '25';
        try {
            hydrateCallRegistry.mockResolvedValueOnce({
                callId: 'plivo-call-telemetry-1',
                sid: 'plivo-call-telemetry-1',
                recipient: '+14155550670',
                phoneNumber: '+14155550670',
                provider: 'plivo',
                name: 'Taylor Buyer',
                persona: 'company-sales',
                language: 'en',
                aiProvider: 'azure-realtime',
                contextHint: null,
                policyConfig: null,
                requireExplicitRecordingConsent: false,
                status: 'connected'
            });

            const realtimeInstances = [];
            class FakeRealtimeService extends EventEmitter {
                constructor() {
                    super();
                    this.initialize = jest.fn();
                    this.close = jest.fn();
                    realtimeInstances.push(this);
                }
            }

            const streamInstances = [];
            class FakeStreamService {
                constructor() {
                    this.ws = { readyState: 1, close: jest.fn() };
                    this.setStreamId = jest.fn();
                    this.stopCurrentAudio = jest.fn();
                    this.startHoldMusic = jest.fn();
                    this.stopHoldMusic = jest.fn();
                    this.clearAudioTask = jest.fn();
                    this.sendAudioDirect = jest.fn();
                    this.isInHoldMode = jest.fn(() => true);
                    streamInstances.push(this);
                }
            }

            const provider = {
                name: 'plivo',
                getGateConfig: () => ({
                    dynamicThresholdOffset: 0,
                    silenceFramesThreshold: 10,
                    energyOverrideThreshold: null,
                    maxSilenceFailsafe: null
                }),
                extractStartFields: (msg) => ({
                    callId: msg.start.callId,
                    streamId: msg.start.streamId,
                    callerNumber: msg.start.from
                }),
                requiresSessionConfigured: true,
                hasPreConnectBuffer: false,
                audioBufferStrategy: 'fifo-queue',
                hangup: jest.fn()
            };

            const ws = new EventEmitter();
            const res = { accept: jest.fn().mockResolvedValue(ws) };
            const { createCallSession } = require('../session/createCallSession');

            await createCallSession(provider, {
                streamServiceClass: FakeStreamService,
                realtimeServiceClass: FakeRealtimeService
            })({}, res);

            ws.emit('message', JSON.stringify({
                event: 'start',
                start: {
                    callId: 'plivo-call-telemetry-1',
                    streamId: 'plivo-stream-telemetry-1',
                    from: '+14155550699'
                }
            }));
            await new Promise(resolve => setImmediate(resolve));

            realtimeInstances[0].emit('disconnected', { isServerError: true, isRegionError: false });
            expect(telemetryEmit).toHaveBeenCalledWith('reconnect_hold_music_started', expect.objectContaining({
                callId: 'plivo-call-telemetry-1',
                isServerError: true,
                isAbnormal: false
            }));

            realtimeInstances[0].emit('reconnected', { attempt: 1 });
            expect(telemetryEmit).toHaveBeenCalledWith('reconnect_hold_music_stopped', expect.objectContaining({
                callId: 'plivo-call-telemetry-1',
                reason: 'reconnected'
            }));

            realtimeInstances[0].emit('disconnected', { isAbnormal: true, isRegionError: false });
            await new Promise(resolve => setTimeout(resolve, 40));
            expect(streamInstances[0].stopHoldMusic).toHaveBeenCalled();
            expect(telemetryEmit).toHaveBeenCalledWith('reconnect_hold_music_failsafe_stop', expect.objectContaining({
                callId: 'plivo-call-telemetry-1',
                maxDurationMs: 25
            }));
        } finally {
            if (originalHoldMax === undefined) delete process.env.HOLD_MUSIC_MAX_DURATION_MS;
            else process.env.HOLD_MUSIC_MAX_DURATION_MS = originalHoldMax;
        }
    });

    test('emits stop telemetry and failed-hangup telemetry on reconnection failure path', async () => {
        hydrateCallRegistry.mockResolvedValueOnce({
            callId: 'plivo-call-telemetry-2',
            sid: 'plivo-call-telemetry-2',
            recipient: '+14155550671',
            phoneNumber: '+14155550671',
            provider: 'plivo',
            name: 'Morgan Buyer',
            persona: 'company-sales',
            language: 'en',
            aiProvider: 'azure-realtime',
            contextHint: null,
            policyConfig: null,
            requireExplicitRecordingConsent: false,
            status: 'connected'
        });

        const realtimeInstances = [];
        class FakeRealtimeService extends EventEmitter {
            constructor() {
                super();
                this.initialize = jest.fn();
                this.close = jest.fn();
                realtimeInstances.push(this);
            }
        }

        const streamInstances = [];
        class FakeStreamService {
            constructor() {
                this.ws = { readyState: 1, close: jest.fn() };
                this.setStreamId = jest.fn();
                this.stopCurrentAudio = jest.fn();
                this.startHoldMusic = jest.fn();
                this.stopHoldMusic = jest.fn();
                this.clearAudioTask = jest.fn();
                this.sendAudioDirect = jest.fn();
                this.isInHoldMode = jest.fn(() => true);
                streamInstances.push(this);
            }
        }

        const provider = {
            name: 'plivo',
            getGateConfig: () => ({
                dynamicThresholdOffset: 0,
                silenceFramesThreshold: 10,
                energyOverrideThreshold: null,
                maxSilenceFailsafe: null
            }),
            extractStartFields: (msg) => ({
                callId: msg.start.callId,
                streamId: msg.start.streamId,
                callerNumber: msg.start.from
            }),
            requiresSessionConfigured: true,
            hasPreConnectBuffer: false,
            audioBufferStrategy: 'fifo-queue',
            hangup: jest.fn()
        };

        const ws = new EventEmitter();
        const res = { accept: jest.fn().mockResolvedValue(ws) };
        const { createCallSession } = require('../session/createCallSession');

        await createCallSession(provider, {
            streamServiceClass: FakeStreamService,
            realtimeServiceClass: FakeRealtimeService
        })({}, res);

        ws.emit('message', JSON.stringify({
            event: 'start',
            start: {
                callId: 'plivo-call-telemetry-2',
                streamId: 'plivo-stream-telemetry-2',
                from: '+14155550698'
            }
        }));
        await new Promise(resolve => setImmediate(resolve));

        realtimeInstances[0].emit('disconnected', { isAbnormal: true, isRegionError: false });
        realtimeInstances[0].emit('reconnection_failed', { attempts: 4 });

        expect(streamInstances[0].stopHoldMusic).toHaveBeenCalled();
        expect(telemetryEmit).toHaveBeenCalledWith('reconnect_hold_music_stopped', expect.objectContaining({
            callId: 'plivo-call-telemetry-2',
            reason: 'reconnection_failed'
        }));
        expect(telemetryEmit).toHaveBeenCalledWith('reconnection_failed_hangup', expect.objectContaining({
            callSID: 'plivo-call-telemetry-2',
            attempts: 4
        }));
    });

    test('drops invalid pre-connect media before session configuration', async () => {
        hydrateCallRegistry.mockResolvedValueOnce({
            callId: 'CA22222222222222222222222222222222',
            sid: 'CA22222222222222222222222222222222',
            recipient: '+14155550222',
            phoneNumber: '+14155550222',
            provider: 'twilio',
            name: 'Jordan Buyer',
            persona: 'company-sales',
            language: 'en',
            aiProvider: 'azure-realtime',
            contextHint: null,
            policyConfig: null,
            requireExplicitRecordingConsent: false,
            status: 'connected'
        });

        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const realtimeInstances = [];
        class FakeRealtimeService extends EventEmitter {
            constructor() {
                super();
                this.initialize = jest.fn();
                this.close = jest.fn();
                this.sendAudio = jest.fn();
                this.isConnected = false;
                this.isSessionConfigured = false;
                realtimeInstances.push(this);
            }
        }

        class FakeStreamService {
            setStreamId = jest.fn();
            stopCurrentAudio = jest.fn();
        }

        const provider = {
            name: 'twilio',
            getGateConfig: () => ({
                dynamicThresholdOffset: 0,
                silenceFramesThreshold: 10,
                energyOverrideThreshold: null,
                maxSilenceFailsafe: null
            }),
            extractStartFields: (msg) => ({
                callId: msg.start.callSid,
                streamId: msg.start.streamSid,
                callerNumber: msg.start.from
            }),
            requiresSessionConfigured: true,
            hasPreConnectBuffer: true,
            audioBufferStrategy: 'fifo-queue',
            hangup: jest.fn()
        };

        const ws = new EventEmitter();
        const res = { accept: jest.fn().mockResolvedValue(ws) };
        const { createCallSession } = require('../session/createCallSession');

        await createCallSession(provider, {
            streamServiceClass: FakeStreamService,
            realtimeServiceClass: FakeRealtimeService
        })({}, res);

        ws.emit('message', JSON.stringify({
            event: 'start',
            start: {
                callSid: 'CA22222222222222222222222222222222',
                streamSid: 'MZ22222222222222222222222222222222',
                from: '+14155550299'
            }
        }));
        await new Promise(resolve => setImmediate(resolve));

        ws.emit('message', JSON.stringify({
            event: 'media',
            media: { payload: '!!!!' }
        }));
        await new Promise(resolve => setImmediate(resolve));

        realtimeInstances[0].isConnected = true;
        realtimeInstances[0].isSessionConfigured = true;
        realtimeInstances[0].emit('session_configured');

        expect(warnSpy).toHaveBeenCalledWith('[GateV2 INVALID_FRAME]', expect.objectContaining({
            reason: 'invalid_base64_payload',
            payloadLength: 4
        }));
        expect(realtimeInstances[0].sendAudio).not.toHaveBeenCalled();
    });

    test('keeps playback estimate when Plivo confirms an intermediate playedStream checkpoint', async () => {
        hydrateCallRegistry.mockResolvedValueOnce({
            callId: 'plivo-call-333',
            sid: 'plivo-call-333',
            recipient: '+14155550333',
            phoneNumber: '+14155550333',
            provider: 'plivo',
            name: 'Taylor Buyer',
            persona: 'company-sales',
            language: 'en',
            aiProvider: 'azure-realtime',
            contextHint: null,
            policyConfig: null,
            requireExplicitRecordingConsent: false,
            status: 'connected'
        });

        const realtimeInstances = [];
        class FakeRealtimeService extends EventEmitter {
            constructor() {
                super();
                this.initialize = jest.fn();
                this.close = jest.fn();
                this._enableAudioPlaybackTracking = true;
                this._audioPlaybackEndEstimate = 12345;
                realtimeInstances.push(this);
            }
        }

        const streamInstances = [];
        class FakeStreamService {
            constructor() {
                this.setStreamId = jest.fn();
                this.stopCurrentAudio = jest.fn();
                this.clearAudioTask = jest.fn();
                streamInstances.push(this);
            }
        }

        const provider = {
            name: 'plivo',
            getGateConfig: () => ({
                dynamicThresholdOffset: 0,
                silenceFramesThreshold: 10,
                energyOverrideThreshold: null,
                maxSilenceFailsafe: null
            }),
            extractStartFields: (msg) => ({
                callId: msg.start.callId,
                streamId: msg.start.streamId,
                callerNumber: msg.start.from
            }),
            requiresSessionConfigured: true,
            hasPreConnectBuffer: false,
            audioBufferStrategy: 'fifo-queue',
            hangup: jest.fn()
        };

        const ws = new EventEmitter();
        const res = { accept: jest.fn().mockResolvedValue(ws) };
        const { createCallSession } = require('../session/createCallSession');

        await createCallSession(provider, {
            streamServiceClass: FakeStreamService,
            realtimeServiceClass: FakeRealtimeService
        })({}, res);

        ws.emit('message', JSON.stringify({
            event: 'start',
            start: {
                callId: 'plivo-call-333',
                streamId: 'plivo-stream-333',
                from: '+14155550399'
            }
        }));
        await new Promise(resolve => setImmediate(resolve));

        ws.emit('message', JSON.stringify({
            event: 'playedStream',
            name: 'turn-1_chunk-1'
        }));

        expect(streamInstances[0].clearAudioTask).toHaveBeenCalledTimes(1);
        expect(realtimeInstances[0]._audioPlaybackEndEstimate).toBe(12345);
    });

    test('ignores duplicate start without replacing the active realtime service', async () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        hydrateCallRegistry.mockResolvedValueOnce({
            callId: 'CA77777777777777777777777777777777',
            sid: 'CA77777777777777777777777777777777',
            recipient: '+14155550777',
            phoneNumber: '+14155550777',
            provider: 'twilio',
            name: 'Jamie Buyer',
            persona: 'company-sales',
            language: 'en',
            aiProvider: 'azure-realtime',
            contextHint: null,
            policyConfig: null,
            requireExplicitRecordingConsent: false,
            status: 'connected'
        });

        const realtimeInstances = [];
        class FakeRealtimeService extends EventEmitter {
            constructor() {
                super();
                this.initialize = jest.fn();
                this.close = jest.fn();
                this.clearPrewarmKnowledge = jest.fn();
                realtimeInstances.push(this);
            }
        }

        const streamInstances = [];
        class FakeStreamService {
            constructor() {
                this.setStreamId = jest.fn();
                this.stopCurrentAudio = jest.fn();
                this.stopHoldMusic = jest.fn();
                this.clearAudioTask = jest.fn();
                streamInstances.push(this);
            }
        }

        const provider = {
            name: 'twilio',
            getGateConfig: () => ({
                dynamicThresholdOffset: 0,
                silenceFramesThreshold: 10,
                energyOverrideThreshold: null,
                maxSilenceFailsafe: null
            }),
            extractStartFields: (msg) => ({
                callId: msg.start.callSid,
                streamId: msg.start.streamSid,
                callerNumber: msg.start.from
            }),
            requiresSessionConfigured: true,
            hasPreConnectBuffer: false,
            audioBufferStrategy: 'fifo-queue',
            hangup: jest.fn()
        };

        const ws = new EventEmitter();
        const res = { accept: jest.fn().mockResolvedValue(ws) };
        const { createCallSession } = require('../session/createCallSession');

        await createCallSession(provider, {
            streamServiceClass: FakeStreamService,
            realtimeServiceClass: FakeRealtimeService
        })({}, res);

        const startMessage = JSON.stringify({
            event: 'start',
            start: {
                callSid: 'CA77777777777777777777777777777777',
                streamSid: 'MZ77777777777777777777777777777777',
                from: '+14155550799'
            }
        });

        ws.emit('message', startMessage);
        await new Promise(resolve => setImmediate(resolve));

        expect(realtimeInstances).toHaveLength(1);
        realtimeInstances[0].close.mockClear();
        hydrateCallRegistry.mockClear();

        ws.emit('message', startMessage);
        await new Promise(resolve => setImmediate(resolve));

        expect(realtimeInstances).toHaveLength(1);
        expect(realtimeInstances[0].close).not.toHaveBeenCalled();
        expect(streamInstances[0].setStreamId).toHaveBeenCalledTimes(1);
        expect(hydrateCallRegistry).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Ignoring duplicate start event'), expect.any(Object));
    });

    test('does not initialize realtime service when websocket closes during context hydration', async () => {
        let resolveHydration;
        hydrateCallRegistry.mockReturnValueOnce(new Promise((resolve) => {
            resolveHydration = resolve;
        }));

        const realtimeInstances = [];
        class FakeRealtimeService extends EventEmitter {
            constructor() {
                super();
                this.initialize = jest.fn();
                this.close = jest.fn();
                realtimeInstances.push(this);
            }
        }

        class FakeStreamService {
            constructor() {
                this.setStreamId = jest.fn();
                this.stopCurrentAudio = jest.fn();
                this.stopHoldMusic = jest.fn();
            }
        }

        const provider = {
            name: 'twilio',
            getGateConfig: () => ({
                dynamicThresholdOffset: 0,
                silenceFramesThreshold: 10,
                energyOverrideThreshold: null,
                maxSilenceFailsafe: null
            }),
            extractStartFields: (msg) => ({
                callId: msg.start.callSid,
                streamId: msg.start.streamSid,
                callerNumber: msg.start.from
            }),
            requiresSessionConfigured: true,
            hasPreConnectBuffer: false,
            audioBufferStrategy: 'fifo-queue',
            hangup: jest.fn()
        };

        const ws = new EventEmitter();
        const res = { accept: jest.fn().mockResolvedValue(ws) };
        const { createCallSession } = require('../session/createCallSession');

        await createCallSession(provider, {
            streamServiceClass: FakeStreamService,
            realtimeServiceClass: FakeRealtimeService
        })({}, res);

        ws.emit('message', JSON.stringify({
            event: 'start',
            start: {
                callSid: 'CA88888888888888888888888888888888',
                streamSid: 'MZ88888888888888888888888888888888',
                from: '+14155550899'
            }
        }));
        await new Promise(resolve => setImmediate(resolve));

        expect(hydrateCallRegistry).toHaveBeenCalledTimes(1);

        ws.emit('close');
        resolveHydration({
            callId: 'CA88888888888888888888888888888888',
            sid: 'CA88888888888888888888888888888888',
            recipient: '+14155550888',
            phoneNumber: '+14155550888',
            provider: 'twilio',
            name: 'Avery Buyer',
            persona: 'company-sales',
            language: 'en',
            aiProvider: 'azure-realtime',
            contextHint: null,
            policyConfig: null,
            requireExplicitRecordingConsent: false,
            status: 'connected'
        });
        await new Promise(resolve => setImmediate(resolve));

        expect(realtimeInstances).toHaveLength(0);
        expect(registerCxState).not.toHaveBeenCalled();
    });
});
