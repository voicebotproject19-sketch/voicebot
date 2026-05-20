'use strict';

function createWebSocketStub() {
    return {
        readyState: 1,
        bufferedAmount: 0,
        on: jest.fn(),
        send: jest.fn()
    };
}

describe('stream service hold music', () => {
    let consoleLogSpy;

    beforeEach(() => {
        jest.useFakeTimers();
        consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.runOnlyPendingTimers();
        jest.useRealTimers();
        consoleLogSpy.mockRestore();
    });

    test('Plivo hold music starts, sends playAudio, loops, and stops', () => {
        const { StreamServicePlivo } = require('../services-plivo/stream-service-plivo');
        const ws = createWebSocketStub();
        const turnState = { currentTurnId: 'turn-plivo-1', isClosed: false };
        const service = new StreamServicePlivo(ws, turnState);
        service.setStreamId('stream-plivo-1');
        service.holdAudioBuffer = Buffer.from('hold').toString('base64');
        service.holdMusicDuration = 1000;

        service.startHoldMusic();

        expect(service.holdMode).toBe(true);
        expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('playAudio'));

        const sendCountAfterStart = ws.send.mock.calls.length;
        service.startHoldMusic();
        expect(ws.send).toHaveBeenCalledTimes(sendCountAfterStart);

        jest.advanceTimersByTime(1000);
        expect(ws.send.mock.calls.length).toBeGreaterThan(sendCountAfterStart);

        service.stopHoldMusic();
        expect(service.holdMode).toBe(false);
        expect(service.holdMusicInterval).toBeNull();
    });

    test('Twilio hold music self-stops when the turn closes', () => {
        const { StreamServiceTwilio } = require('../services-twilio/stream-service-twilio');
        const ws = createWebSocketStub();
        const turnState = { currentTurnId: 'turn-twilio-1', isClosed: false };
        const service = new StreamServiceTwilio(ws, turnState);
        service.setStreamId('stream-twilio-1');
        service.holdAudioBuffer = Buffer.from('hold').toString('base64');
        service.holdMusicDuration = 1000;

        service.startHoldMusic();
        expect(service.holdMode).toBe(true);
        expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('media'));

        turnState.isClosed = true;
        jest.advanceTimersByTime(1000);

        expect(service.holdMode).toBe(false);
        expect(service.holdMusicInterval).toBeNull();
    });

    test('stopCurrentAudio stops hold music and sends provider clear without an active task', () => {
        const { StreamServicePlivo } = require('../services-plivo/stream-service-plivo');
        const ws = createWebSocketStub();
        const turnState = { currentTurnId: 'turn-plivo-2', isClosed: false };
        const service = new StreamServicePlivo(ws, turnState);
        service.setStreamId('stream-plivo-2');
        service.holdAudioBuffer = Buffer.from('hold').toString('base64');
        service.holdMusicDuration = 1000;

        service.startHoldMusic();
        service.currentAudioTask = null;
        ws.send.mockClear();

        service.stopCurrentAudio('cancelled-response');

        expect(service.holdMode).toBe(false);
        expect(service.holdMusicInterval).toBeNull();
        expect(service.silentMode).toBe(false);
        expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('clearAudio'));
    });
});
