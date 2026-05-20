const {
    analyzeReplayAssertions,
    summarizeReplayAssertions
} = require('../scripts/simulate-log-based-calls');

function row(ms, event, extras = {}) {
    return {
        ms,
        event,
        callSID: 'CA-test-call',
        timestamp: new Date(ms).toISOString(),
        ...extras
    };
}

describe('simulate-log-based-calls replay assertions', () => {
    test('counts unsafe barge-in recovery nudges before the next speech boundary', () => {
        const assertions = analyzeReplayAssertions('CA-unsafe', [
            row(100, 'speech_started'),
            row(200, 'barge_in_recovery', {
                status: {
                    isUserSpeaking: true,
                    turnCount: 4,
                    msSinceSpeechStarted: 100,
                    msSinceSpeechStopped: null,
                    msSinceLastTranscript: 900,
                    lastInputEnergy: 0.82,
                    lastGateSendAudio: false,
                    lastGateSilenceFrames: 6
                }
            }),
            row(240, 'silence_nudge_scripted_sent'),
            row(500, 'speech_stopped'),
            row(620, 'user_transcribed')
        ]);

        expect(assertions).toMatchObject({
            callId: 'CA-unsafe',
            unsafeBargeInRecoveryNudges: 1,
            recoveryBeforeTranscript: 1,
            duplicateSynthesisChains: 0,
            maxRecoveryResponsesPerTurn: 2
        });
        expect(assertions.details.recoveryBeforeTranscript[0]).toMatchObject({
            atMs: 200,
            nudgeAtMs: 240,
            nudgeDelayMs: 40,
            lastGateSendAudio: false
        });
    });

    test('does not count a nudge after speech stops as recovery before transcript', () => {
        const assertions = analyzeReplayAssertions('CA-boundary-safe', [
            row(100, 'speech_started'),
            row(200, 'barge_in_recovery', {
                status: {
                    isUserSpeaking: true,
                    turnCount: 3
                }
            }),
            row(260, 'speech_stopped'),
            row(310, 'silence_nudge_scripted_sent'),
            row(500, 'user_transcribed')
        ]);

        expect(assertions.unsafeBargeInRecoveryNudges).toBe(1);
        expect(assertions.recoveryBeforeTranscript).toBe(0);
    });

    test('groups duplicate and synthesis recovery churn into transcript-delimited chains', () => {
        const assertions = analyzeReplayAssertions('CA-churn', [
            row(100, 'user_transcribed'),
            row(200, 'synthesis_gate_failed'),
            row(300, 'response_duplicate_suppressed'),
            row(400, 'early_duplicate_cancelled'),
            row(500, 'response_quality_fail'),
            row(9000, 'synthesis_gate_cap_reached'),
            row(10000, 'user_transcribed'),
            row(10100, 'response_duplicate_suppressed'),
            row(10200, 'silence_nudge_scripted_sent')
        ]);

        expect(assertions.duplicateSynthesisChains).toBe(3);
        expect(assertions.maxDuplicateSynthesisEventsPerTurn).toBe(5);
        expect(assertions.maxRecoveryResponsesPerTurn).toBe(5);
        expect(assertions.details.duplicateSynthesisChains.map((chain) => chain.startsAtMs)).toEqual([200, 9000, 10100]);
    });

    test('summarizes pass/fail checks without losing transcript completion metrics', () => {
        const cleanAssertions = analyzeReplayAssertions('CA-clean', [
            row(100, 'speech_started'),
            row(300, 'speech_stopped'),
            row(360, 'booking_intent_detected'),
            row(380, 'booking_link_requested'),
            row(500, 'user_transcribed')
        ]);
        const unsafeAssertions = analyzeReplayAssertions('CA-unsafe', [
            row(100, 'speech_started'),
            row(200, 'barge_in_recovery', { status: { isUserSpeaking: true } }),
            row(240, 'silence_nudge_scripted_sent')
        ]);

        const summary = summarizeReplayAssertions([
            {
                callId: 'CA-clean',
                replayAssertions: cleanAssertions,
                speechWindowNoTranscript: 0
            },
            {
                callId: 'CA-unsafe',
                replayAssertions: unsafeAssertions,
                speechWindowNoTranscript: 1
            }
        ]);

        expect(summary.pass).toBe(false);
        expect(summary.totals).toMatchObject({
            unsafeBargeInRecoveryNudges: 1,
            recoveryBeforeTranscript: 1,
            speechWindowNoTranscript: 1,
            bookingIntentDetectedCalls: 1,
            bookingLinkRequestedCalls: 1,
            bookingLinkSentCalls: 0
        });
        expect(summary.checks.unsafeBargeInRecoveryNudges.pass).toBe(false);
        expect(summary.checks.recoveryBeforeTranscript.pass).toBe(false);
        expect(summary.checks.speechWindowNoTranscript.pass).toBe(false);
        expect(summary.checks.bookingIntentCaptureRate).toMatchObject({
            pass: true,
            actual: 1
        });
        expect(summary.calls.map((call) => [call.callId, call.pass])).toEqual([
            ['CA-clean', true],
            ['CA-unsafe', false]
        ]);
        expect(summary.calls.find((call) => call.callId === 'CA-clean')).toMatchObject({
            bookingIntentDetectedCount: 1,
            bookingLinkRequestedCount: 1,
            bookingIntentCaptureRate: 1
        });
    });

    test('controlled fixed incident replay passes booking and weather closure checks', () => {
        const assertions = analyzeReplayAssertions('CA-fixed-incident', [
            row(100, 'user_transcribed', { transcript: 'I need a Moodle developer' }),
            row(180, 'booking_intent_detected'),
            row(220, 'ai_response', {
                transcript: 'Great, I can text you the booking link right now. Should I send it to this number?'
            }),
            row(300, 'user_transcribed', { transcript: 'Yes, please' }),
            row(330, 'booking_link_requested'),
            row(360, 'booking_recovery_action_selected'),
            row(390, 'ai_response', {
                transcript: 'Perfect, I will text the booking link now. Please choose a time that works for you.'
            })
        ]);

        const summary = summarizeReplayAssertions([{ callId: 'CA-fixed-incident', replayAssertions: assertions }], {
            assistantWeatherMentions: 0,
            minBookingIntentCaptureRate: 1,
            maxRecoveryResponsesPerTurn: 3
        });

        expect(assertions).toMatchObject({
            bookingIntentDetectedCount: 1,
            bookingLinkRequestedCount: 1,
            assistantWeatherMentions: 0,
            maxRecoveryResponsesPerTurn: 0
        });
        expect(summary.pass).toBe(true);
        expect(summary.checks.bookingIntentCaptureRate).toMatchObject({
            pass: true,
            actual: 1,
            expectedMin: 1
        });
        expect(summary.checks.assistantWeatherMentions).toMatchObject({
            pass: true,
            actual: 0,
            expectedMax: 0
        });
    });

    test('controlled replay fails when assistant drifts to weather', () => {
        const assertions = analyzeReplayAssertions('CA-weather-drift', [
            row(100, 'user_transcribed', { transcript: 'Yes, please' }),
            row(150, 'booking_intent_detected'),
            row(200, 'ai_response', {
                transcript: 'Nice weather today. Tell me more about the project.'
            }),
            row(250, 'booking_link_requested')
        ]);

        const summary = summarizeReplayAssertions([{ callId: 'CA-weather-drift', replayAssertions: assertions }], {
            assistantWeatherMentions: 0,
            minBookingIntentCaptureRate: 1
        });

        expect(assertions.assistantWeatherMentions).toBe(1);
        expect(assertions.details.assistantWeatherMentions[0]).toMatchObject({
            atMs: 200,
            turnIndex: 1,
            summary: expect.objectContaining({
                hash: expect.any(String),
                length: expect.any(Number),
                wordCount: expect.any(Number)
            })
        });
        expect(summary.pass).toBe(false);
        expect(summary.checks.assistantWeatherMentions).toMatchObject({
            pass: false,
            actual: 1,
            expectedMax: 0
        });
    });

    test('controlled replay fails when booking intent has no booking link request', () => {
        const assertions = analyzeReplayAssertions('CA-missing-link', [
            row(100, 'user_transcribed', { transcript: 'Yes, please' }),
            row(150, 'booking_intent_detected'),
            row(200, 'ai_response', {
                transcript: 'Great, I can help with that.'
            })
        ]);

        const summary = summarizeReplayAssertions([{ callId: 'CA-missing-link', replayAssertions: assertions }], {
            assistantWeatherMentions: 0,
            minBookingIntentCaptureRate: 1
        });

        expect(summary.pass).toBe(false);
        expect(summary.checks.bookingIntentCaptureRate).toMatchObject({
            pass: false,
            actual: 0,
            expectedMin: 1
        });
        expect(summary.calls[0]).toMatchObject({
            bookingIntentDetectedCount: 1,
            bookingLinkRequestedCount: 0,
            bookingIntentCaptureRate: 0,
            pass: false
        });
    });
});