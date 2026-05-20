'use strict';

const { EventEmitter } = require('events');

const { registerSilenceHangupSignalHandler } = require('../session/createCallSession');

function createEdgeSession(callSID = 'call-plivo-123') {
    const signalEmitter = new EventEmitter();
    return {
        callSID,
        emitSignal(event, ...args) {
            signalEmitter.emit(event, ...args);
        },
        onSignal(event, handler) {
            signalEmitter.on(event, handler);
        }
    };
}

describe('createCallSession silence hangup signal', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.runOnlyPendingTimers();
        jest.useRealTimers();
    });

    test('executes silence hangup for Plivo providers', () => {
        const edgeSession = createEdgeSession();
        const provider = { name: 'plivo', hangup: jest.fn() };
        const turnState = { currentTurnId: 'turn-1', isClosed: false };
        let timerId = null;

        registerSilenceHangupSignalHandler({
            edgeSession,
            provider,
            turnState,
            setTimerId(value) {
                timerId = value;
            }
        });

        edgeSession.emitSignal('signal_silence_hangup', 'turn-1');

        expect(timerId).not.toBeNull();
        jest.advanceTimersByTime(0);

        expect(provider.hangup).toHaveBeenCalledTimes(1);
        expect(provider.hangup).toHaveBeenCalledWith('call-plivo-123');
    });

    test('does not hang up when the signal turn is stale', () => {
        const edgeSession = createEdgeSession('call-plivo-stale');
        const provider = { name: 'plivo', hangup: jest.fn() };
        const turnState = { currentTurnId: 'turn-1', isClosed: false };

        registerSilenceHangupSignalHandler({
            edgeSession,
            provider,
            turnState,
            setTimerId() {}
        });

        edgeSession.emitSignal('signal_silence_hangup', 'turn-1');
        turnState.currentTurnId = 'turn-2';
        jest.advanceTimersByTime(15000);

        expect(provider.hangup).not.toHaveBeenCalled();
    });
});