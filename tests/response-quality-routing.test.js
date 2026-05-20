'use strict';

const BaseRealtimeAdapter = require('../adapters/ai/BaseRealtimeAdapter');
const { matchPrecomputedAnswer } = require('../services/precomputedAnswers');
const { getHallucinationFallback } = require('../Helper/hallucinationGuard');
const telemetry = require('../Utils/telemetry');
const logger = require('../Utils/logger');
const replayTurns = require('./fixtures/response-quality-replay.json');
const salesPersona = require('../personas/company-sales');

function makeSalesAdapter() {
    const adapter = new BaseRealtimeAdapter({});
    Object.defineProperty(adapter, 'providerName', { value: 'plivo', configurable: true });
    adapter.count = 4;
    adapter.conversationPhase = 'discovery';
    adapter.hasAskedForConsultation = false;
    adapter.persona = { flow: { callType: 'sales' }, name: 'Sarah', company: 'company' };
    return adapter;
}

function makeBookingPromptAdapter(phase, overrides = {}) {
    const adapter = makeSalesAdapter();
    adapter.callSID = 'CA44444444444444444444444444444444';
    adapter.recipient = '+15551234567';
    adapter.conversationPhase = phase;
    adapter.hasAskedForConsultation = overrides.hasAskedForConsultation ?? true;
    adapter.isResponding = false;
    adapter.isUserSpeaking = false;
    adapter._clarificationCount = overrides._clarificationCount ?? 2;
    adapter._phase4Profile = {
        rag: { maxDocs: 4, minRelevanceScore: 0.99, retrievalTimeoutMs: 2500 },
        intent: { minConfidence: overrides.minConfidence ?? 0.99, maxClarifications: 2 },
        transaction: { confirmationRequired: false },
    };
    adapter.lang = {
        buildTurnPrompt: jest.fn(() => 'unexpected prompt'),
        baseInstruction: () => 'base instruction',
        sttLocale: 'en-US',
    };
    adapter.send = jest.fn();
    adapter._buildResponseCreate = opts => ({ type: 'response.create', response: opts });
    return adapter;
}

describe('Response quality routing hardening', () => {
    afterEach(() => {
        logger.close();
    });

    test('sales greeting uses cold-lead project discovery instead of time permission', () => {
        const greeting = salesPersona.languages.en.greeting('Amit');

        expect(greeting).toContain('Hi Amit');
        expect(greeting).toContain('custom software, apps, and web platforms');
        expect(greeting).toContain('tech project or development need coming up');
        expect(greeting).not.toContain('couple of minutes');
    });

    test('deterministic pivot does not steal pricing, location, or capability questions', () => {
        const adapter = makeSalesAdapter();

        expect(adapter._shouldTriggerDeterministicConsultationPivot('What is your pricing for Shopify?', false)).toBe(false);
        expect(adapter._shouldTriggerDeterministicConsultationPivot('Where are your offices located?', false)).toBe(false);
        expect(adapter._shouldTriggerDeterministicConsultationPivot('Can you support Moodle delivery?', false)).toBe(false);
    });

    test('deterministic pivot still fires for substantive project statements', () => {
        const adapter = makeSalesAdapter();

        expect(adapter._shouldTriggerDeterministicConsultationPivot('I need a Moodle platform for a university project', false)).toBe(true);
        expect(adapter._shouldTriggerDeterministicConsultationPivot('Our budget is ready and we need a website', false)).toBe(true);
    });

    test('deterministic pivot handles clear first-turn cold-lead project needs', () => {
        const adapter = makeSalesAdapter();
        adapter.count = 1;

        expect(adapter._shouldTriggerDeterministicConsultationPivot('Yes, we need a new website for our business', false)).toBe(true);
        expect(adapter._shouldTriggerDeterministicConsultationPivot('I am planning a mobile app launch', false)).toBe(true);
    });

    test('deterministic pivot does not treat bare permission as buying intent', () => {
        const adapter = makeSalesAdapter();
        adapter.count = 1;

        expect(adapter._shouldTriggerDeterministicConsultationPivot('Yes, I have a minute', false)).toBe(false);
        expect(adapter._shouldTriggerDeterministicConsultationPivot('Okay, go ahead', false)).toBe(false);
    });

    test('offer acceptance emits booking intent in the active no-slot flow', () => {
        const adapter = makeSalesAdapter();
        adapter.callSID = 'CA11111111111111111111111111111111';
        adapter.conversationPhase = 'offer';
        adapter.hasAskedForConsultation = true;
        const emitSpy = jest.spyOn(telemetry, 'emit').mockImplementation(() => {});
        try {
            adapter.extractEntities('Yes please', 'USER');

            expect(adapter.offerAccepted).toBe(true);
            expect(adapter._bookingIntentDetected).toBe(true);
            expect(emitSpy).toHaveBeenCalledWith('booking_intent_detected', expect.objectContaining({
                callId: 'CA11111111111111111111111111111111',
                phase: 'offer',
                reason: 'offer_accepted',
            }));
        } finally {
            emitSpy.mockRestore();
        }
    });

    test('phone delivery consent emits booking intent before link request', () => {
        const adapter = makeSalesAdapter();
        adapter.callSID = 'CA22222222222222222222222222222222';
        adapter.recipient = '+15551234567';
        adapter.conversationPhase = 'email-collection';
        adapter.hasAskedForConsultation = true;
        const emitSpy = jest.spyOn(telemetry, 'emit').mockImplementation(() => {});
        try {
            adapter.extractEntities('Yes, text me the booking link', 'USER');

            expect(adapter.bookingPhoneDeliveryConsent).toBe(true);
            expect(adapter._bookingIntentDetected).toBe(true);
            expect(emitSpy).toHaveBeenCalledWith('booking_intent_detected', expect.objectContaining({
                callId: 'CA22222222222222222222222222222222',
                phase: 'email-collection',
                reason: 'phone_delivery_consent',
            }));
            expect(emitSpy).toHaveBeenCalledWith('booking_link_requested', expect.objectContaining({
                callId: 'CA22222222222222222222222222222222',
                reason: 'phone_delivery_consent',
            }));
        } finally {
            emitSpy.mockRestore();
        }
    });

    test('contextual phone delivery affirmation requests booking link after assistant prompt', () => {
        const adapter = makeSalesAdapter();
        const requests = [];
        adapter.callSID = 'CA22555555555555555555555555555555';
        adapter.recipient = '+15551234567';
        adapter.conversationPhase = 'email-collection';
        adapter.hasAskedForConsultation = true;
        adapter.offerAccepted = true;
        adapter.on('booking_link_requested', payload => requests.push(payload));
        const emitSpy = jest.spyOn(telemetry, 'emit').mockImplementation(() => {});
        try {
            adapter.addConversationContext('AI', 'Great, I can text you the booking link right now. Should I send it to this number?');
            expect(adapter._pendingPhoneDeliveryConsentContext).toBeTruthy();

            adapter.extractEntities('Yes, please.', 'USER');

            expect(adapter.bookingPhoneDeliveryConsent).toBe(true);
            expect(adapter.bookingDeliveryPreference).toBe('sms');
            expect(adapter.bookingLinkRequested).toBe(true);
            expect(adapter._pendingPhoneDeliveryConsentContext).toBeNull();
            expect(requests).toHaveLength(1);
            expect(requests[0]).toEqual(expect.objectContaining({
                reason: 'phone_delivery_consent',
                phoneConsent: true,
                phoneDeliveryConsented: true,
            }));
            const eventNames = emitSpy.mock.calls.map(([name]) => name);
            expect(eventNames.indexOf('booking_intent_detected')).toBeLessThan(eventNames.indexOf('booking_link_requested'));
        } finally {
            emitSpy.mockRestore();
        }
    });

    test('bare yes does not become phone delivery consent without pending assistant prompt', () => {
        const adapter = makeSalesAdapter();
        adapter.callSID = 'CA22666666666666666666666666666666';
        adapter.recipient = '+15551234567';
        adapter.conversationPhase = 'email-collection';
        adapter.hasAskedForConsultation = true;
        adapter.offerAccepted = true;

        adapter.extractEntities('Yes, please.', 'USER');

        expect(adapter.bookingPhoneDeliveryConsent).toBe(false);
        expect(adapter.bookingLinkRequested).toBe(false);
    });

    test('non-affirmation clears pending phone delivery context before later yes', () => {
        const adapter = makeSalesAdapter();
        adapter.callSID = 'CA22777777777777777777777777777777';
        adapter.recipient = '+15551234567';
        adapter.conversationPhase = 'email-collection';
        adapter.hasAskedForConsultation = true;
        adapter.offerAccepted = true;

        adapter.addConversationContext('AI', 'I can text you the booking link right now. Should I send it to this number?');
        expect(adapter._pendingPhoneDeliveryConsentContext).toBeTruthy();

        adapter.extractEntities('Can you email it instead?', 'USER');
        expect(adapter._pendingPhoneDeliveryConsentContext).toBeNull();

        adapter.extractEntities('Yes, please.', 'USER');

        expect(adapter.bookingPhoneDeliveryConsent).toBe(false);
        expect(adapter.bookingLinkRequested).toBe(false);
    });

    test('duplicate circuit breaker in booking phase uses booking recovery text', () => {
        const adapter = makeBookingPromptAdapter('email-collection');
        adapter.offerAccepted = true;
        adapter._bookingIntentDetected = true;
        adapter._recentAiResponses = ['Great, I can send the booking link. Should I text it to this number?'];
        adapter._consecutiveDupSuppressions = 2;
        adapter._responsesThisTurn = 0;

        adapter._handleAITranscriptDone({
            transcript: 'Great, I can send the booking link. Should I text it to this number?'
        });

        expect(adapter.send).toHaveBeenCalledTimes(1);
        const response = adapter.send.mock.calls[0][0].response;
        expect(response.instructions).toContain('Should I text it to this number?');
        expect(response.instructions).not.toMatch(/weather|tell me more|what part should/i);
        expect(adapter._pendingPhoneDeliveryConsentContext).toBeTruthy();
        expect(adapter._consecutiveDupSuppressions).toBe(0);
    });

    test('hangup nextAction is clamped to booking state before it is stored', () => {
        const adapter = makeSalesAdapter();
        adapter.callSID = 'CA22888888888888888888888888888888';
        adapter.recipient = '+15551234567';
        adapter.conversationPhase = 'email-collection';
        adapter.hasAskedForConsultation = true;
        adapter.offerAccepted = true;
        adapter.bookingPhoneDeliveryConsent = true;
        const emitSpy = jest.spyOn(telemetry, 'emit').mockImplementation(() => {});
        try {
            const decision = adapter._normalizeHangupDecisionForPhase({
                shouldHangup: false,
                reason: 'continue',
                nextAction: 'continue discussing weather'
            }, 'llm_hangup');

            expect(decision.nextAction).toBe('send_booking_link');
            expect(emitSpy).toHaveBeenCalledWith('hangup_next_action_clamped', expect.objectContaining({
                callId: 'CA22888888888888888888888888888888',
                phase: 'email-collection',
                source: 'llm_hangup',
                reason: 'continue',
                nextAction: 'send_booking_link',
                previousNextAction: expect.objectContaining({
                    hash: expect.any(String),
                    length: expect.any(Number),
                    wordCount: expect.any(Number)
                })
            }));
        } finally {
            emitSpy.mockRestore();
        }
    });

    test('terminal hangup decisions are not clamped by booking state', () => {
        const adapter = makeSalesAdapter();
        adapter.callSID = 'CA22999999999999999999999999999999';
        adapter.recipient = '+15551234567';
        adapter.conversationPhase = 'email-collection';
        adapter.hasAskedForConsultation = true;
        adapter.offerAccepted = true;
        adapter.bookingPhoneDeliveryConsent = true;
        const emitSpy = jest.spyOn(telemetry, 'emit').mockImplementation(() => {});
        try {
            const originalDecision = {
                shouldHangup: true,
                reason: 'rejected',
                nextAction: 'continue discussing weather'
            };

            const decision = adapter._normalizeHangupDecisionForPhase(originalDecision, 'llm_hangup');

            expect(decision).toBe(originalDecision);
            expect(decision.nextAction).toBe('continue discussing weather');
            expect(emitSpy).not.toHaveBeenCalledWith('hangup_next_action_clamped', expect.anything());
        } finally {
            emitSpy.mockRestore();
        }
    });

    test('hangup nextAction continues booking after link has already been sent', () => {
        const adapter = makeSalesAdapter();
        adapter.callSID = 'CA23000000000000000000000000000000';
        adapter.recipient = '+15551234567';
        adapter.conversationPhase = 'confirmation';
        adapter.hasAskedForConsultation = true;
        adapter.offerAccepted = true;
        adapter.bookingPhoneDeliveryConsent = true;
        adapter.bookingLinkRequested = true;
        adapter.bookingLinkSent = true;

        const decision = adapter._normalizeHangupDecisionForPhase({
            shouldHangup: false,
            reason: 'continue',
            nextAction: 'ask for email address'
        }, 'llm_hangup');

        expect(decision.nextAction).toBe('continue_booking');
    });

    test('current-turn booking request bypasses clarification gate in offer phase', () => {
        const adapter = makeBookingPromptAdapter('offer');

        adapter.extractEntities('Yes, please. Please book a call.', 'USER');
        expect(adapter._bookingActionThisTurn).toBe(true);

        adapter.insertUpdatedPrompt('Yes, please. Please book a call.', 'high');

        expect(adapter.send).toHaveBeenCalledTimes(1);
        const response = adapter.send.mock.calls[0][0].response;
        expect(response.input).toEqual([]);
        expect(response.instructions).toContain('Great, I can text you the booking link');
        expect(response.instructions).not.toMatch(/rephrase|tell me more/i);
        expect(adapter._clarificationCount).toBe(0);
        expect(adapter.lang.buildTurnPrompt).not.toHaveBeenCalled();
    });

    test('repeated booking request bypasses clarification gate after booking intent is already sticky', () => {
        const adapter = makeBookingPromptAdapter('email-collection');
        adapter._bookingIntentDetected = true;
        adapter._bookingActionThisTurn = false;

        adapter.extractEntities('Please book a call.', 'USER');
        expect(adapter._bookingActionThisTurn).toBe(true);

        adapter.insertUpdatedPrompt('Please book a call.', 'high');

        expect(adapter.send).toHaveBeenCalledTimes(1);
        const response = adapter.send.mock.calls[0][0].response;
        expect(response.input).toEqual([]);
        expect(response.instructions).toContain('Great, I can send the booking link');
        expect(response.instructions).not.toMatch(/rephrase|tell me more/i);
        expect(adapter._clarificationCount).toBe(0);
        expect(adapter.lang.buildTurnPrompt).not.toHaveBeenCalled();
    });

    test('booking bypass queues instead of overlapping while assistant is responding', () => {
        const adapter = makeBookingPromptAdapter('email-collection');
        adapter._bookingIntentDetected = true;
        adapter.extractEntities('Please book a call.', 'USER');
        adapter.isResponding = true;

        adapter.insertUpdatedPrompt('Please book a call.', 'high');

        expect(adapter.send).not.toHaveBeenCalled();
        expect(adapter._deferredUserInputQueue).toHaveLength(1);
        expect(adapter._deferredUserInputQueue[0].userQuestion).toBe('Please book a call.');
        expect(adapter._scriptedResponsePending).not.toBe(true);

        adapter.isResponding = false;
        const queued = adapter._deferredUserInputQueue.shift();
        adapter.insertUpdatedPrompt(queued.userQuestion, queued.decision);

        expect(adapter.send).toHaveBeenCalledTimes(1);
        const response = adapter.send.mock.calls[0][0].response;
        expect(response.instructions).toContain('Great, I can send the booking link');
        expect(response.instructions).not.toMatch(/rephrase|tell me more/i);
    });

    test('booking bypass defers exact booking prompt while caller is still speaking', () => {
        const adapter = makeBookingPromptAdapter('email-collection');
        adapter._bookingIntentDetected = true;
        adapter.extractEntities('Please book a call.', 'USER');
        adapter.isUserSpeaking = true;

        adapter.insertUpdatedPrompt('Please book a call.', 'high');

        expect(adapter.send).not.toHaveBeenCalled();
        expect(adapter._deferredInstruction).toContain('Great, I can send the booking link');
        expect(adapter._deferredInstruction).not.toMatch(/rephrase|tell me more/i);
        expect(adapter._deferredInstructionScripted).toBe(true);
        expect(adapter._scriptedResponsePending).not.toBe(true);
    });

    test('discovery explicit booking advances to booking delivery and bypasses clarification gate', () => {
        const adapter = makeBookingPromptAdapter('discovery', { hasAskedForConsultation: false });
        const syncCounts = [];
        adapter.on('clarification_sync', count => syncCounts.push(count));

        adapter.extractEntities('Please book a call.', 'USER');
        adapter._updatePhase();

        expect(adapter._bookingActionThisTurn).toBe(true);
        expect(adapter._bookingActionReasonThisTurn).toBe('explicit_booking_request');
        expect(adapter.hasAskedForConsultation).toBe(true);
        expect(adapter.offerAccepted).toBe(true);
        expect(adapter.conversationPhase).toBe('email-collection');

        adapter.insertUpdatedPrompt('Please book a call.', 'high');

        expect(adapter.send).toHaveBeenCalledTimes(1);
        const response = adapter.send.mock.calls[0][0].response;
        expect(response.instructions).toContain('Great, I can send the booking link');
        expect(response.instructions).not.toMatch(/rephrase|connect you/i);
        expect(adapter._clarificationCount).toBe(0);
        expect(syncCounts).toContain(0);
        expect(adapter.lang.buildTurnPrompt).not.toHaveBeenCalled();
    });

    test.each(['confirmation', 'success'])('booking request bypasses clarification gate in %s phase', (phase) => {
        const adapter = makeBookingPromptAdapter(phase);
        adapter.extractEntities('Please schedule a consultation call.', 'USER');

        adapter.insertUpdatedPrompt('Please schedule a consultation call.', 'high');

        expect(adapter.send).toHaveBeenCalledTimes(1);
        const response = adapter.send.mock.calls[0][0].response;
        expect(response.instructions).toContain('booking link');
        expect(response.instructions).not.toMatch(/rephrase|connect you/i);
        expect(adapter._clarificationCount).toBe(0);
        expect(adapter.lang.buildTurnPrompt).not.toHaveBeenCalled();
    });

    test('successful intent gate proceed resets stale clarification count and emits sync', () => {
        const adapter = makeBookingPromptAdapter('discovery', { minConfidence: 0.7, _clarificationCount: 2 });
        const syncCounts = [];
        adapter.on('clarification_sync', count => syncCounts.push(count));

        adapter.insertUpdatedPrompt('yes', 'high');

        expect(adapter._clarificationCount).toBe(0);
        expect(syncCounts).toContain(0);
        expect(adapter.send).toHaveBeenCalledTimes(1);
        expect(adapter.send.mock.calls[0][0].response.instructions).not.toMatch(/rephrase|connect you/i);
    });

    test('phase contract flags generic rephrase prompts during active booking context', () => {
        const adapter = makeSalesAdapter();
        adapter._bookingIntentDetected = true;

        const violation = adapter._detectPhaseContractViolation(
            'I want to make sure I understand you correctly. Could you rephrase that for me?',
            'email-collection'
        );

        expect(violation).toEqual(expect.objectContaining({ reason: 'booking_phase_generic_clarification' }));
    });

    test('phase contract flags generic discovery prompts during active booking context', () => {
        const adapter = makeSalesAdapter();
        adapter._bookingIntentDetected = true;

        const violation = adapter._detectPhaseContractViolation(
            'Sure! Could you tell me more about the topic or question they have?',
            'email-collection'
        );

        expect(violation).toEqual(expect.objectContaining({ reason: 'booking_phase_generic_clarification' }));
    });

    test('phase contract allows capability answers that include a booking next step', () => {
        const adapter = makeSalesAdapter();
        adapter._bookingIntentDetected = true;

        const violation = adapter._detectPhaseContractViolation(
            'Yes, we can help with Moodle delivery. Should I text the booking link to this number?',
            'email-collection'
        );

        expect(violation).toBeNull();
    });

    test('offer side questions do not become booking intent', () => {
        const adapter = makeSalesAdapter();
        adapter.callSID = 'CA33333333333333333333333333333333';
        adapter.conversationPhase = 'offer';
        adapter.hasAskedForConsultation = true;
        const emitSpy = jest.spyOn(telemetry, 'emit').mockImplementation(() => {});
        try {
            adapter.extractEntities('What is your pricing for Shopify?', 'USER');

            expect(adapter.offerAccepted).toBe(false);
            expect(adapter._bookingIntentDetected).toBe(false);
            expect(emitSpy).not.toHaveBeenCalledWith('booking_intent_detected', expect.anything());
        } finally {
            emitSpy.mockRestore();
        }
    });

    test('exact replay turns keep expected pivot routing', () => {
        for (const turn of replayTurns) {
            const adapter = makeSalesAdapter();
            expect(adapter._shouldTriggerDeterministicConsultationPivot(turn.text, false)).toBe(turn.shouldPivot);
        }
    });

    test('unclear sales turn after Moodle context clarifies instead of booking', () => {
        const adapter = makeSalesAdapter();
        adapter.conversationContext = [
            { sender: 'USER', message: 'I wanted to Moodle website.' }
        ];

        const clarification = adapter._buildUnclearSalesClarification('I have a featureless dockeros.');

        expect(clarification).toMatch(/Moodle website/i);
        expect(adapter._shouldTriggerDeterministicConsultationPivot('I have a featureless dockeros.', false)).toBe(false);
    });

    test('unclear guard does not block clear Moodle buyer statements', () => {
        const adapter = makeSalesAdapter();
        adapter.conversationContext = [
            { sender: 'USER', message: 'I need a Moodle platform for a university project' }
        ];

        expect(adapter._buildUnclearSalesClarification('I need a Moodle platform for a university project')).toBeNull();
        expect(adapter._shouldTriggerDeterministicConsultationPivot('I need a Moodle platform for a university project', false)).toBe(true);
    });

    test('offer acceptance ignores side questions and hearing checks', () => {
        const adapter = new BaseRealtimeAdapter({});
        adapter.conversationPhase = 'offer';

        adapter.extractEntities('Yeah, can you tell me a joke?', 'USER');
        expect(adapter.offerAccepted).toBe(false);

        adapter.extractEntities('yes, what are your rates?', 'USER');
        expect(adapter.offerAccepted).toBe(false);

        adapter.extractEntities('yeah, can you hear me?', 'USER');
        expect(adapter.offerAccepted).toBe(false);
    });

    test('offer acceptance still accepts explicit booking phrases', () => {
        const adapter = new BaseRealtimeAdapter({});
        adapter.conversationPhase = 'offer';

        adapter.extractEntities('Yes please book the call', 'USER');
        expect(adapter.offerAccepted).toBe(true);
    });

    test('exact replay turns keep expected offer acceptance', () => {
        for (const turn of replayTurns) {
            const adapter = new BaseRealtimeAdapter({});
            adapter.conversationPhase = 'offer';

            adapter.extractEntities(turn.text, 'USER');
            expect(adapter.offerAccepted).toBe(turn.shouldAcceptOffer);
        }
    });

    test('PAT coverage answers production FAQ phrasing before model inference', () => {
        const cases = [
            ['Can you support Moodle delivery?', 'moodle_platform'],
            ['Do you build Shopify store integrations?', 'ecommerce_platform'],
            ['Where is your office located?', 'location'],
            ['Can you share your pricing model?', 'pricing']
        ];

        for (const [utterance, expectedId] of cases) {
            const match = matchPrecomputedAnswer(utterance, null, 'Sarah', 'discovery');
            expect(match).not.toBeNull();
            expect(match.id).toBe(expectedId);
        }
    });

    test('exact replay turns have the expected PAT answers where applicable', () => {
        for (const turn of replayTurns) {
            const match = matchPrecomputedAnswer(turn.text, null, 'Sarah', 'discovery');
            if (turn.expectedPatId) {
                expect(match).not.toBeNull();
                expect(match.id).toBe(turn.expectedPatId);
            } else {
                expect(match).toBeNull();
            }
        }
    });

    test('fallbacks answer factual questions in offer phases instead of only asking for a day', () => {
        const persona = { flow: { callType: 'sales' }, name: 'Sarah', company: 'company' };

        const location = getHallucinationFallback('slot-collection', 'Mark', persona, { userQuestion: 'Where are you located?' });
        expect(location).toMatch(/Noida|headquartered/i);
        expect(location).not.toMatch(/What day works best/i);

        const pricing = getHallucinationFallback('offer', 'Mark', persona, { userQuestion: 'How much does a Shopify build cost?' });
        expect(pricing).toMatch(/Pricing depends/i);
        expect(pricing).not.toMatch(/What day works best/i);

        const hearingCheck = getHallucinationFallback('offer', 'Mark', persona, { userQuestion: 'Can you hear me?' });
        expect(hearingCheck).toMatch(/hear you/i);
        expect(hearingCheck).not.toMatch(/What day works best/i);

        const unclear = getHallucinationFallback('offer', 'Mark', persona, { userQuestion: 'I have a featureless dockeros.' });
        expect(unclear).toMatch(/did not catch|features/i);
        expect(unclear).not.toMatch(/What day works best/i);
    });

    test('capability fallback in active booking context keeps booking next step', () => {
        const persona = { flow: { callType: 'sales' }, name: 'Sarah', company: 'company' };

        const fallback = getHallucinationFallback('email-collection', 'Mark', persona, {
            userQuestion: 'I wanted to hire a Moodle developer sales team.',
            bookingIntentActive: true,
            offerAccepted: true,
            bookingLinkRequested: true,
            userPhoneAvailable: true,
        });

        expect(fallback).toMatch(/booking link|text|send/i);
        expect(fallback).not.toMatch(/what part should they focus on/i);
    });

    test('capability fallback remains discovery-style without booking context', () => {
        const persona = { flow: { callType: 'sales' }, name: 'Sarah', company: 'company' };

        const fallback = getHallucinationFallback('email-collection', 'Mark', persona, {
            userQuestion: 'I wanted to hire a Moodle developer sales team.'
        });

        expect(fallback).toMatch(/what part should they focus on/i);
    });

    test('silence nudge helper tags purpose and suppresses duplicate fixed nudges without repair', () => {
        const adapter = new BaseRealtimeAdapter({});
        adapter.callSID = 'test-call';
        Object.defineProperty(adapter, 'providerName', { value: 'plivo' });
        adapter.send = jest.fn();
        adapter._buildResponseCreate = opts => ({ type: 'response.create', response: opts });

        expect(adapter._sendSilenceResponse('Take your time - still here.', 'silence_nudge')).toBe(true);
        expect(adapter._pendingResponsePurpose).toBe('silence_nudge');
        expect(adapter._pendingExpectedPhrase).toBe('Take your time - still here.');
        expect(adapter.send).toHaveBeenCalledTimes(1);

        expect(adapter._sendSilenceResponse('Take your time - still here.', 'silence_nudge')).toBe(false);
        expect(adapter.send).toHaveBeenCalledTimes(1);
    });

    test('nudge transcript prefix guard catches model elaboration early', () => {
        const adapter = new BaseRealtimeAdapter({});

        expect(adapter._isNudgeTranscriptClearlyOffScript(
            'Sure, I can help with that. What specifically would you like to know about?',
            'Still there?'
        )).toBe(true);
        expect(adapter._isNudgeTranscriptClearlyOffScript('Still there?', 'Still there?')).toBe(false);
    });

    test('silence suppression treats recent speech and gate activity as caller activity', () => {
        const adapter = new BaseRealtimeAdapter({});
        adapter.SILENCE_RECENT_SPEECH_START_GRACE_MS = 1200;
        adapter.SILENCE_RECENT_GATE_FRAMES = 8;
        adapter.SILENCE_RECENT_GATE_ACTIVITY_MIN_ENERGY = 0.003;
        adapter.SILENCE_RECENT_INPUT_ENERGY = 0.015;

        const baseStatus = {
            isResponding: false,
            isUserSpeaking: false,
            playbackRemainingMs: 0,
            msSinceSpeechStarted: null,
            lastGateSendAudio: false,
            lastGateSilenceFrames: null,
            lastInputEnergy: null
        };

        expect(adapter._getSilenceSuppressionReason({
            ...baseStatus,
            msSinceSpeechStarted: 500
        })).toBe('recent_speech_started');
        expect(adapter._getSilenceSuppressionReason({
            ...baseStatus,
            lastGateSendAudio: true,
            lastGateSilenceFrames: 4,
            lastInputEnergy: 0.004
        })).toBe('recent_gate_activity');
        expect(adapter._getSilenceSuppressionReason({
            ...baseStatus,
            lastGateSendAudio: true,
            lastGateSilenceFrames: 4,
            lastInputEnergy: 0.0003
        })).toBeNull();
        expect(adapter._getSilenceSuppressionReason({
            ...baseStatus,
            lastGateSendAudio: true,
            lastGateSilenceFrames: 20,
            lastInputEnergy: 0.02
        })).toBe('recent_input_energy');
        expect(adapter._getSilenceSuppressionReason({
            ...baseStatus,
            lastGateSendAudio: false,
            lastGateSilenceFrames: 20,
            lastInputEnergy: 0.02,
            msSinceGateMetrics: 100
        })).toBe('recent_dropped_input_energy');
        expect(adapter._getSilenceSuppressionReason({
            ...baseStatus,
            lastGateSendAudio: false,
            lastGateSilenceFrames: 20,
            lastInputEnergy: 0.02,
            msSinceGateMetrics: 2000
        })).toBeNull();
    });

    test('speech windows emit transcribed and no-transcript telemetry', () => {
        jest.useFakeTimers();
        const emitSpy = jest.spyOn(telemetry, 'emit').mockImplementation(() => undefined);
        try {
            const adapter = new BaseRealtimeAdapter({});
            adapter.callSID = 'call-speech-window';
            adapter.turnStateRef = { currentTurnId: 'turn-window-1' };
            Object.defineProperty(adapter, 'providerName', { value: 'plivo', configurable: true });
            adapter.SPEECH_WINDOW_TRANSCRIPT_TIMEOUT_MS = 1000;

            adapter._recordSpeechWindowStart(1000);
            adapter._recordSpeechWindowStop(1300);
            adapter._markSpeechWindowTranscribed('hello there', 0.92);

            expect(emitSpy).toHaveBeenCalledWith('speech_window_transcribed', expect.objectContaining({
                callId: 'call-speech-window',
                provider: 'plivo',
                windowId: 1,
                turnEpoch: 'turn-window-1',
                transcriptLength: 11,
                confidence: 0.92,
                durationMs: 300
            }));

            adapter._recordSpeechWindowStart(2000);
            adapter._recordSpeechWindowStop(2200);
            jest.advanceTimersByTime(1000);

            expect(emitSpy).toHaveBeenCalledWith('speech_window_no_transcript', expect.objectContaining({
                callId: 'call-speech-window',
                provider: 'plivo',
                windowId: 2,
                reason: 'timeout',
                durationMs: 200
            }));
        } finally {
            emitSpy.mockRestore();
            jest.useRealTimers();
        }
    });

    test('speech window timers are cleared on adapter close', () => {
        jest.useFakeTimers();
        const emitSpy = jest.spyOn(telemetry, 'emit').mockImplementation(() => undefined);
        try {
            const adapter = new BaseRealtimeAdapter({});
            adapter.callSID = 'call-window-close';
            Object.defineProperty(adapter, 'providerName', { value: 'plivo', configurable: true });
            adapter.SPEECH_WINDOW_TRANSCRIPT_TIMEOUT_MS = 1000;

            adapter._recordSpeechWindowStart(1000);
            adapter._recordSpeechWindowStop(1200);
            adapter.close();
            jest.advanceTimersByTime(1000);

            expect(emitSpy).not.toHaveBeenCalledWith('speech_window_no_transcript', expect.anything());
        } finally {
            emitSpy.mockRestore();
            jest.useRealTimers();
        }
    });

    test('speech window overlap marks late transcript without no-transcript miss', () => {
        jest.useFakeTimers();
        const emitSpy = jest.spyOn(telemetry, 'emit').mockImplementation(() => undefined);
        try {
            const adapter = new BaseRealtimeAdapter({});
            adapter.callSID = 'call-window-overlap';
            adapter.turnStateRef = { currentTurnId: 'turn-overlap-1' };
            Object.defineProperty(adapter, 'providerName', { value: 'plivo', configurable: true });
            adapter.SPEECH_WINDOW_TRANSCRIPT_TIMEOUT_MS = 1000;

            adapter._recordSpeechWindowStart(1000);
            adapter._recordSpeechWindowStop(1300);
            adapter._recordSpeechWindowStart(1500);
            adapter._markSpeechWindowTranscribed('late transcript', 0.81);
            jest.advanceTimersByTime(1000);

            expect(emitSpy).toHaveBeenCalledWith('speech_window_transcribed', expect.objectContaining({
                callId: 'call-window-overlap',
                windowId: 1,
                turnEpoch: 'turn-overlap-1',
                overlappedByNextSpeech: true,
                overlapGapMs: 200,
                transcriptLength: 15,
                confidence: 0.81
            }));
            expect(emitSpy).not.toHaveBeenCalledWith('speech_window_no_transcript', expect.objectContaining({
                callId: 'call-window-overlap',
                windowId: 1
            }));
        } finally {
            emitSpy.mockRestore();
            jest.useRealTimers();
        }
    });

    test('nudge compliance cancellation only fires once per response', () => {
        const adapter = new BaseRealtimeAdapter({});
        adapter.callSID = 'call-nudge-latch';
        Object.defineProperty(adapter, 'providerName', { value: 'plivo', configurable: true });
        adapter.send = jest.fn();
        adapter._isEarlyDuplicate = () => false;
        adapter._currentResponsePurpose = 'silence_nudge';
        adapter._expectedNudgePhrase = 'Still there?';

        const offScriptDelta = JSON.stringify({
            type: 'response.audio_transcript.delta',
            response_id: 'resp-1',
            delta: 'Sure, I can help with that. What would you like to know?'
        });

        adapter.handleMessage(Buffer.from(offScriptDelta));
        adapter.handleMessage(Buffer.from(offScriptDelta));

        expect(adapter.send).toHaveBeenCalledTimes(1);
        expect(adapter.send).toHaveBeenCalledWith({ type: 'response.cancel' });
    });

    test('silence goodbye schedules hangup after a grace period', () => {
        jest.useFakeTimers().setSystemTime(1000);
        try {
            const adapter = makeSalesAdapter();
            adapter._enableSilenceTimers = true;
            adapter._greetingDelivered = true;
            adapter.SECOND_SILENCE_TIMEOUT = 1000;
            adapter.persona.silenceNudges = {
                first: () => "SILENCE CHECK Say EXACTLY: 'Still there?'",
                second: () => "SILENCE GOODBYE Say EXACTLY: 'Thanks for your time.'"
            };
            adapter.isConnected = true;
            adapter.send = jest.fn();
            adapter._buildResponseCreate = (opts) => ({ type: 'response.create', response: opts });
            const hangup = jest.fn();
            adapter.on('silence_hangup', hangup);

            adapter.startSecondSilenceTimer();
            jest.advanceTimersByTime(1000);

            expect(adapter.send).toHaveBeenCalledTimes(1);
            expect(hangup).not.toHaveBeenCalled();

            adapter._handleResponseCreated({});
            adapter._currentResponsePurpose = 'silence_goodbye';
            adapter.aiTranscript = '';
            adapter._handleAITranscriptDone({});
            adapter._firstDeltaLogged = true;
            adapter._handleAudioDone({});

            jest.advanceTimersByTime(3999);
            expect(hangup).not.toHaveBeenCalled();

            jest.advanceTimersByTime(1);
            expect(hangup).toHaveBeenCalledTimes(1);
        } finally {
            jest.useRealTimers();
        }
    });

    test('recent continue hangup decision postpones silence goodbye', () => {
        jest.useFakeTimers().setSystemTime(2000);
        try {
            const adapter = makeSalesAdapter();
            Object.defineProperty(adapter, 'providerName', { value: 'plivo' });
            adapter.FIRST_SILENCE_TIMEOUT = 30000;
            adapter.SECOND_SILENCE_TIMEOUT = 1000;
            adapter._lastHangupDecision = { shouldHangup: false, reason: 'ai_screening' };
            adapter._lastHangupDecisionTs = Date.now();
            adapter.persona.silenceNudges = {
                first: () => "SILENCE CHECK Say EXACTLY: 'Still there?'",
                second: () => "SILENCE GOODBYE Say EXACTLY: 'Thanks for your time.'"
            };
            adapter.sendTextResponse = jest.fn();
            const hangup = jest.fn();
            adapter.on('silence_hangup', hangup);

            adapter.startSecondSilenceTimer();
            jest.advanceTimersByTime(1000);

            expect(adapter.sendTextResponse).not.toHaveBeenCalled();
            expect(hangup).not.toHaveBeenCalled();
            expect(adapter.firstSilenceTimer).not.toBeNull();
        } finally {
            jest.useRealTimers();
        }
    });

    test('first silence timer re-arms instead of queuing while assistant is responding', () => {
        jest.useFakeTimers().setSystemTime(3000);
        try {
            const adapter = makeSalesAdapter();
            adapter.FIRST_SILENCE_TIMEOUT = 1000;
            adapter.SECOND_SILENCE_TIMEOUT = 1000;
            adapter.isResponding = true;
            adapter.persona.silenceNudges = {
                first: () => "SILENCE CHECK Say EXACTLY: 'Still there?'",
                second: () => "SILENCE GOODBYE Say EXACTLY: 'Thanks for your time.'"
            };
            adapter.sendTextResponse = jest.fn();

            adapter.startFirstSilenceTimer();
            jest.advanceTimersByTime(1000);

            expect(adapter.sendTextResponse).not.toHaveBeenCalled();
            expect(adapter.firstSilenceTimer).not.toBeNull();
        } finally {
            jest.useRealTimers();
        }
    });

    test('silence timer starts a full listening window after assistant playback tail', () => {
        jest.useFakeTimers().setSystemTime(1000);
        try {
            const adapter = new BaseRealtimeAdapter({
                enableSilenceTimers: true,
                enableAudioPlaybackTracking: true
            });
            adapter.callSID = 'call-post-playback-timer';
            Object.defineProperty(adapter, 'providerName', { value: 'plivo', configurable: true });
            adapter._greetingDelivered = true;
            adapter.FIRST_SILENCE_TIMEOUT = 8000;
            adapter.SECOND_SILENCE_TIMEOUT = 12000;
            adapter.persona = {
                silenceNudges: {
                    first: () => "SILENCE CHECK Say EXACTLY: 'Still there?'",
                    second: () => "SILENCE GOODBYE Say EXACTLY: 'Thanks for your time.'"
                }
            };
            adapter.sendTextResponse = jest.fn();

            adapter.startFirstSilenceTimer();
            jest.advanceTimersByTime(1000);

            adapter._handleResponseCreated({});
            jest.advanceTimersByTime(7000);
            expect(adapter.sendTextResponse).not.toHaveBeenCalled();

            adapter._firstDeltaLogged = true;
            adapter._audioPlaybackEndEstimate = Date.now() + 3000;
            adapter._handleAudioDone({});

            jest.advanceTimersByTime(10999);
            expect(adapter.sendTextResponse).not.toHaveBeenCalled();

            jest.advanceTimersByTime(1);
            expect(adapter.sendTextResponse).toHaveBeenCalledTimes(1);
        } finally {
            jest.useRealTimers();
        }
    });

    test('second silence timer waits until the nudge audio is done', () => {
        jest.useFakeTimers().setSystemTime(1000);
        try {
            const adapter = new BaseRealtimeAdapter({
                enableSilenceTimers: true,
                enableAudioPlaybackTracking: true
            });
            adapter.callSID = 'call-nudge-second-timer';
            Object.defineProperty(adapter, 'providerName', { value: 'plivo', configurable: true });
            adapter._greetingDelivered = true;
            adapter.FIRST_SILENCE_TIMEOUT = 1000;
            adapter.SECOND_SILENCE_TIMEOUT = 1000;
            adapter.persona = {
                silenceNudges: {
                    first: () => "SILENCE CHECK Say EXACTLY: 'Still there?'",
                    second: () => "SILENCE GOODBYE Say EXACTLY: 'Thanks for your time.'"
                }
            };
            adapter.sendTextResponse = jest.fn();

            adapter.startFirstSilenceTimer();
            jest.advanceTimersByTime(1000);

            expect(adapter.sendTextResponse).toHaveBeenCalledTimes(1);
            expect(adapter.secondSilenceTimer).toBeNull();

            adapter._currentResponsePurpose = 'silence_nudge';
            adapter.aiTranscript = '';
            adapter._handleAITranscriptDone({});
            adapter._firstDeltaLogged = true;
            adapter._audioPlaybackEndEstimate = Date.now() + 3000;
            adapter._handleAudioDone({});

            expect(adapter.secondSilenceTimer).not.toBeNull();
            jest.advanceTimersByTime(3999);
            expect(adapter.sendTextResponse).toHaveBeenCalledTimes(1);

            jest.advanceTimersByTime(1);
            expect(adapter.sendTextResponse).toHaveBeenCalledTimes(2);
        } finally {
            jest.useRealTimers();
        }
    });

    test('barge-in recovery suppresses stale nudge after a recent transcript', () => {
        jest.useFakeTimers().setSystemTime(5000);
        try {
            const adapter = makeSalesAdapter();
            adapter.isConnected = true;
            adapter.isResponding = true;
            adapter.BARGE_IN_RECOVERY_MS = 1000;
            adapter.SILENCE_RECENT_TRANSCRIPT_GRACE_MS = 5000;
            adapter._lastUserTranscriptAt = Date.now() - 1000;
            adapter._lastResponseDoneTime = 0;
            adapter.send = jest.fn();
            adapter.emit = jest.fn();
            adapter.sendTextResponse = jest.fn();
            adapter.persona.silenceNudges = {
                first: () => "SILENCE CHECK Say EXACTLY: 'Still there?'"
            };

            adapter._handleSpeechStarted();
            jest.advanceTimersByTime(1000);

            expect(adapter.sendTextResponse).not.toHaveBeenCalled();
            expect(adapter.isUserSpeaking).toBe(false);
        } finally {
            jest.useRealTimers();
        }
    });

    test('barge-in recovery rechecks instead of nudging while caller speech is active', () => {
        jest.useFakeTimers().setSystemTime(6000);
        const emitSpy = jest.spyOn(telemetry, 'emit').mockImplementation(() => undefined);
        try {
            const adapter = makeSalesAdapter();
            adapter.callSID = 'call-barge-active-speech';
            adapter.isConnected = true;
            adapter.isResponding = true;
            adapter.BARGE_IN_RECOVERY_MS = 1000;
            adapter.BARGE_IN_RECOVERY_RECHECK_MS = 500;
            adapter.BARGE_IN_RECOVERY_MAX_WAIT_MS = 5000;
            adapter._lastUserTranscriptAt = 0;
            adapter._lastResponseDoneTime = 0;
            adapter.send = jest.fn();
            adapter.emit = jest.fn();
            adapter.sendTextResponse = jest.fn();

            adapter._handleSpeechStarted();
            jest.advanceTimersByTime(1000);

            expect(adapter.sendTextResponse).not.toHaveBeenCalled();
            expect(adapter.isUserSpeaking).toBe(true);
            expect(adapter._bargeInRecoveryTimer).not.toBeNull();
            expect(emitSpy).toHaveBeenCalledWith('barge_in_recovery_recheck_scheduled', expect.objectContaining({
                callId: 'call-barge-active-speech',
                reason: 'user_speaking',
                hardTimeoutReached: false,
                delayMs: 500
            }));
        } finally {
            emitSpy.mockRestore();
            jest.useRealTimers();
        }
    });

    test('barge-in recovery hard timeout still waits on recent gate activity', () => {
        jest.useFakeTimers().setSystemTime(8000);
        const emitSpy = jest.spyOn(telemetry, 'emit').mockImplementation(() => undefined);
        try {
            const adapter = makeSalesAdapter();
            adapter.callSID = 'call-barge-gate-activity';
            adapter.isConnected = true;
            adapter.isResponding = true;
            adapter.BARGE_IN_RECOVERY_MS = 1000;
            adapter.BARGE_IN_RECOVERY_RECHECK_MS = 500;
            adapter.BARGE_IN_RECOVERY_MAX_WAIT_MS = 1500;
            adapter.SILENCE_RECENT_GATE_ACTIVITY_MS = 1000;
            adapter.SILENCE_RECENT_GATE_ACTIVITY_MIN_ENERGY = 0.003;
            adapter._lastUserTranscriptAt = 0;
            adapter._lastResponseDoneTime = 0;
            adapter.send = jest.fn();
            adapter.emit = jest.fn();
            adapter.sendTextResponse = jest.fn();

            adapter._handleSpeechStarted();
            jest.advanceTimersByTime(1000);
            jest.advanceTimersByTime(400);
            adapter.setEnergyMetrics({
                energy: 0.02,
                gateLevel: 'HIGH',
                gateSendAudio: true,
                silenceFrames: 1
            });
            jest.advanceTimersByTime(100);

            expect(adapter.sendTextResponse).not.toHaveBeenCalled();
            expect(adapter.isUserSpeaking).toBe(true);
            expect(adapter._bargeInRecoveryTimer).not.toBeNull();
            expect(emitSpy).toHaveBeenCalledWith('barge_in_recovery_suppressed_state', expect.objectContaining({
                callId: 'call-barge-gate-activity',
                reason: 'recent_gate_activity',
                hardTimeoutReached: true
            }));
        } finally {
            emitSpy.mockRestore();
            jest.useRealTimers();
        }
    });

    test('barge-in recovery hard timeout still waits on recent dropped input energy', () => {
        jest.useFakeTimers().setSystemTime(10000);
        const emitSpy = jest.spyOn(telemetry, 'emit').mockImplementation(() => undefined);
        try {
            const adapter = makeSalesAdapter();
            adapter.callSID = 'call-barge-dropped-energy';
            adapter.isConnected = true;
            adapter.isResponding = true;
            adapter.BARGE_IN_RECOVERY_MS = 1000;
            adapter.BARGE_IN_RECOVERY_RECHECK_MS = 500;
            adapter.BARGE_IN_RECOVERY_MAX_WAIT_MS = 1500;
            adapter.SILENCE_RECENT_GATE_ACTIVITY_MS = 1000;
            adapter.SILENCE_RECENT_INPUT_ENERGY = 0.015;
            adapter._lastUserTranscriptAt = 0;
            adapter._lastResponseDoneTime = 0;
            adapter.send = jest.fn();
            adapter.emit = jest.fn();
            adapter.sendTextResponse = jest.fn();

            adapter._handleSpeechStarted();
            jest.advanceTimersByTime(1000);
            jest.advanceTimersByTime(400);
            adapter.setEnergyMetrics({
                energy: 0.02,
                gateLevel: 'LOW',
                gateSendAudio: false,
                silenceFrames: 20
            });
            jest.advanceTimersByTime(100);

            expect(adapter.sendTextResponse).not.toHaveBeenCalled();
            expect(adapter.isUserSpeaking).toBe(true);
            expect(adapter._bargeInRecoveryTimer).not.toBeNull();
            expect(emitSpy).toHaveBeenCalledWith('barge_in_recovery_suppressed_state', expect.objectContaining({
                callId: 'call-barge-dropped-energy',
                reason: 'recent_dropped_input_energy',
                hardTimeoutReached: true
            }));
        } finally {
            emitSpy.mockRestore();
            jest.useRealTimers();
        }
    });

    test('barge-in recovery hard timeout sends one clarification after input is quiet', () => {
        jest.useFakeTimers().setSystemTime(12000);
        const emitSpy = jest.spyOn(telemetry, 'emit').mockImplementation(() => undefined);
        try {
            const adapter = makeSalesAdapter();
            adapter.callSID = 'call-barge-hard-timeout';
            adapter.isConnected = true;
            adapter.isResponding = true;
            adapter.BARGE_IN_RECOVERY_MS = 1000;
            adapter.BARGE_IN_RECOVERY_RECHECK_MS = 500;
            adapter.BARGE_IN_RECOVERY_MAX_WAIT_MS = 1500;
            adapter._lastUserTranscriptAt = 0;
            adapter._lastResponseDoneTime = 0;
            adapter.send = jest.fn();
            adapter.emit = jest.fn();
            adapter.sendTextResponse = jest.fn();

            adapter._handleSpeechStarted();
            jest.advanceTimersByTime(1500);
            jest.advanceTimersByTime(2000);

            expect(adapter.sendTextResponse).toHaveBeenCalledTimes(1);
            expect(adapter.sendTextResponse).toHaveBeenCalledWith('I want to make sure I heard you correctly. Could you please repeat that?');
            expect(adapter.isUserSpeaking).toBe(false);
            expect(adapter._bargeInRecoveryTimer).toBeNull();
            expect(adapter.emit).toHaveBeenCalledWith('user_speech_stopped', expect.objectContaining({
                reason: 'barge_in_recovery_hard_timeout'
            }));
            expect(emitSpy).toHaveBeenCalledWith('barge_in_recovery_hard_timeout', expect.objectContaining({
                callId: 'call-barge-hard-timeout',
                timeoutMs: 1500
            }));
            expect(emitSpy).toHaveBeenCalledWith('barge_in_recovery_clarification_sent', expect.objectContaining({
                callId: 'call-barge-hard-timeout',
                timeoutMs: 1500
            }));
        } finally {
            emitSpy.mockRestore();
            jest.useRealTimers();
        }
    });

    test('speech stopped clears pending barge-in recovery rechecks', () => {
        jest.useFakeTimers().setSystemTime(14000);
        try {
            const adapter = makeSalesAdapter();
            adapter.isConnected = true;
            adapter.isResponding = true;
            adapter.BARGE_IN_RECOVERY_MS = 1000;
            adapter.BARGE_IN_RECOVERY_RECHECK_MS = 500;
            adapter.BARGE_IN_RECOVERY_MAX_WAIT_MS = 5000;
            adapter._lastUserTranscriptAt = 0;
            adapter._lastResponseDoneTime = 0;
            adapter.send = jest.fn();
            adapter.emit = jest.fn();
            adapter.sendTextResponse = jest.fn();

            adapter._handleSpeechStarted();
            expect(adapter._bargeInRecoveryTimer).not.toBeNull();

            adapter._handleSpeechStopped();
            jest.advanceTimersByTime(5000);

            expect(adapter._bargeInRecoveryTimer).toBeNull();
            expect(adapter.sendTextResponse).not.toHaveBeenCalled();
            expect(adapter.emit).toHaveBeenCalledWith('user_speech_stopped', expect.objectContaining({
                timestamp: 14000
            }));
        } finally {
            jest.useRealTimers();
        }
    });

    test('normal speech start does not emit destructive interruption', () => {
        jest.useFakeTimers().setSystemTime(10000);
        try {
            const adapter = makeSalesAdapter();
            adapter.isConnected = true;
            adapter.isResponding = false;
            adapter._enableAudioPlaybackTracking = true;
            adapter._audioPlaybackEndEstimate = Date.now() - 1;
            adapter.send = jest.fn();
            adapter.emit = jest.fn();

            adapter._handleSpeechStarted();

            expect(adapter.send).not.toHaveBeenCalledWith({ type: 'response.cancel' });
            expect(adapter._responseWasCancelled).not.toBe(true);
            expect(adapter.emit).toHaveBeenCalledWith('user_speech_started', expect.objectContaining({
                isBargeIn: false,
                isRespondingAtStart: false,
                stillPlaying: false
            }));
            expect(adapter.emit).not.toHaveBeenCalledWith('interruption', expect.anything());
        } finally {
            jest.useRealTimers();
        }
    });

    test('active response speech start emits true barge-in interruption', () => {
        jest.useFakeTimers().setSystemTime(12000);
        try {
            const adapter = makeSalesAdapter();
            adapter.isConnected = true;
            adapter.isResponding = true;
            adapter._enableAudioPlaybackTracking = true;
            adapter._currentResponseId = 'response-active-1';
            adapter.send = jest.fn();
            adapter.emit = jest.fn();
            adapter.sendTextResponse = jest.fn();
            adapter.persona.silenceNudges = { first: () => 'Still there?' };

            adapter._handleSpeechStarted();

            expect(adapter.send).toHaveBeenCalledWith({ type: 'response.cancel' });
            expect(adapter._responseWasCancelled).toBe(true);
            expect(adapter.emit).toHaveBeenCalledWith('user_speech_started', expect.objectContaining({
                isBargeIn: true,
                isRespondingAtStart: true
            }));
            expect(adapter.emit).toHaveBeenCalledWith('interruption', expect.objectContaining({
                cancelledResponseId: 'response-active-1',
                isBargeIn: true,
                isRespondingAtStart: true
            }));
        } finally {
            jest.useRealTimers();
        }
    });

    test('playback-tail speech start emits true barge-in interruption', () => {
        jest.useFakeTimers().setSystemTime(14000);
        try {
            const adapter = makeSalesAdapter();
            adapter.isConnected = true;
            adapter.isResponding = false;
            adapter._enableAudioPlaybackTracking = true;
            adapter._audioPlaybackEndEstimate = Date.now() + 1500;
            adapter._currentResponseId = 'response-tail-1';
            adapter.send = jest.fn();
            adapter.emit = jest.fn();
            adapter.sendTextResponse = jest.fn();
            adapter.persona.silenceNudges = { first: () => 'Still there?' };

            adapter._handleSpeechStarted();

            expect(adapter.send).not.toHaveBeenCalledWith({ type: 'response.cancel' });
            expect(adapter._audioPlaybackEndEstimate).toBe(0);
            expect(adapter.emit).toHaveBeenCalledWith('user_speech_started', expect.objectContaining({
                isBargeIn: true,
                isRespondingAtStart: false,
                stillPlaying: true
            }));
            expect(adapter.emit).toHaveBeenCalledWith('interruption', expect.objectContaining({
                cancelledResponseId: 'response-tail-1',
                isBargeIn: true,
                stillPlaying: true
            }));
        } finally {
            jest.useRealTimers();
        }
    });

    test('duplicate correction is dropped after a newer accepted transcript turn', () => {
        const emitSpy = jest.spyOn(telemetry, 'emit').mockImplementation(() => undefined);
        try {
            const adapter = makeSalesAdapter();
            adapter.callSID = 'call-stale-duplicate';
            adapter._buildResponseCreate = opts => ({ type: 'response.create', response: opts });
            adapter.send = jest.fn();
            adapter.extractEntities = jest.fn();
            adapter._updatePhase = jest.fn();
            adapter._assessResponseQuality = jest.fn(() => null);
            adapter._isResponseDuplicate = jest.fn(() => true);
            adapter._buildDupCorrectionPrompt = jest.fn(() => 'Provide a concise correction.');
            adapter._acceptedTranscriptTurnEpoch = 1;
            adapter._inputActivityEpoch = 1;
            const staleOwner = adapter._captureResponseOwner('duplicate_response');
            adapter._currentResponseOwner = staleOwner;
            adapter._advanceAcceptedTranscriptTurnEpoch('newer_user_transcript');
            adapter.aiTranscript = 'This is the duplicated answer the caller already heard.';

            adapter._handleAITranscriptDone({});

            expect(adapter.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'response.create' }));
            expect(emitSpy).toHaveBeenCalledWith('stale_recovery_response_dropped', expect.objectContaining({
                callId: 'call-stale-duplicate',
                source: 'duplicate_correction',
                reason: 'newer_transcript_turn'
            }));
        } finally {
            emitSpy.mockRestore();
        }
    });

    test('stale skip-duplicate bypass is cleared instead of leaking to a newer turn', () => {
        const emitSpy = jest.spyOn(telemetry, 'emit').mockImplementation(() => undefined);
        try {
            const adapter = makeSalesAdapter();
            adapter.callSID = 'call-stale-skip-bypass';
            adapter._assessResponseQuality = jest.fn(() => null);
            adapter._isResponseDuplicate = jest.fn(() => false);
            adapter.send = jest.fn();
            adapter._acceptedTranscriptTurnEpoch = 2;
            adapter._inputActivityEpoch = 2;
            const staleOwner = adapter._captureResponseOwner('synthesis_gate_cap_fallback');
            adapter._currentResponseOwner = staleOwner;
            adapter._skipDupCheckForNextResponse = true;
            adapter._skipDupCheckForNextResponseOwner = staleOwner;
            adapter._inputActivityEpoch = 3;
            adapter.aiTranscript = 'Here is a clear and complete response about the project next steps.';

            adapter._handleAITranscriptDone({});

            expect(adapter._skipDupCheckForNextResponse).toBe(false);
            expect(adapter._skipDupCheckForNextResponseOwner).toBeNull();
            expect(emitSpy).toHaveBeenCalledWith('stale_recovery_response_dropped', expect.objectContaining({
                callId: 'call-stale-skip-bypass',
                source: 'skip_dup_fallback_delivery',
                reason: 'newer_input_activity'
            }));
        } finally {
            emitSpy.mockRestore();
        }
    });

    test('response timeout fallback is dropped after newer input activity', () => {
        const emitSpy = jest.spyOn(telemetry, 'emit').mockImplementation(() => undefined);
        try {
            const adapter = makeSalesAdapter();
            adapter.callSID = 'call-stale-timeout';
            adapter.sendTextResponse = jest.fn();
            adapter._acceptedTranscriptTurnEpoch = 3;
            adapter._inputActivityEpoch = 3;
            const staleOwner = adapter._captureResponseOwner('response_timeout');
            adapter._currentResponseOwner = staleOwner;
            adapter._responseTimeoutActive = true;
            adapter._responseTimeoutOwner = staleOwner;
            adapter._advanceInputActivityEpoch('newer_speech_started');

            adapter._handleResponseDone({ response: { status: 'cancelled' } });

            expect(adapter.sendTextResponse).not.toHaveBeenCalled();
            expect(emitSpy).toHaveBeenCalledWith('stale_recovery_response_dropped', expect.objectContaining({
                callId: 'call-stale-timeout',
                source: 'response_timeout_fallback',
                reason: 'newer_input_activity'
            }));
        } finally {
            emitSpy.mockRestore();
        }
    });

    test('response-create retry-after-done is dropped after a newer user turn', () => {
        const emitSpy = jest.spyOn(telemetry, 'emit').mockImplementation(() => undefined);
        try {
            const adapter = makeSalesAdapter();
            adapter.callSID = 'call-stale-retry';
            adapter._buildResponseCreate = opts => ({ type: 'response.create', response: opts });
            adapter.send = jest.fn();
            adapter._acceptedTranscriptTurnEpoch = 4;
            adapter._inputActivityEpoch = 4;
            const staleOwner = adapter._captureResponseOwner('response_create_retry');
            adapter._retryResponseCreateOnDone = true;
            adapter._retryResponseCreateOnDoneOwner = staleOwner;
            adapter._lastResponseCreateOpts = { instructions: 'Old prompt' };
            adapter._advanceAcceptedTranscriptTurnEpoch('newer_user_transcript');

            adapter._handleResponseDone({ response: { status: 'completed' } });

            expect(adapter.send).not.toHaveBeenCalled();
            expect(emitSpy).toHaveBeenCalledWith('stale_recovery_response_dropped', expect.objectContaining({
                callId: 'call-stale-retry',
                source: 'response_create_retry_after_done',
                reason: 'newer_transcript_turn'
            }));
        } finally {
            emitSpy.mockRestore();
        }
    });

    test('deferred text response drain is dropped when its owner is stale', () => {
        const emitSpy = jest.spyOn(telemetry, 'emit').mockImplementation(() => undefined);
        try {
            const adapter = makeSalesAdapter();
            adapter.callSID = 'call-stale-deferred-text';
            adapter.sendTextResponse = jest.fn();
            adapter._acceptedTranscriptTurnEpoch = 5;
            adapter._inputActivityEpoch = 5;
            const staleOwner = adapter._captureResponseOwner('deferred_text_response');
            adapter._deferredTextResponse = 'Still there?';
            adapter._deferredTextResponseOwner = staleOwner;
            adapter._advanceInputActivityEpoch('newer_speech_started');

            adapter._handleResponseDone({ response: { status: 'completed' } });

            expect(adapter.sendTextResponse).not.toHaveBeenCalled();
            expect(adapter._deferredTextResponse).toBeNull();
            expect(emitSpy).toHaveBeenCalledWith('stale_recovery_response_dropped', expect.objectContaining({
                callId: 'call-stale-deferred-text',
                source: 'deferred_text_response_drain',
                reason: 'newer_input_activity'
            }));
        } finally {
            emitSpy.mockRestore();
        }
    });

    test('deferred user-input drain keeps only active-turn queued work', () => {
        const emitSpy = jest.spyOn(telemetry, 'emit').mockImplementation(() => undefined);
        try {
            const adapter = makeSalesAdapter();
            adapter.callSID = 'call-deferred-filter';
            adapter.insertUpdatedPrompt = jest.fn();
            adapter._acceptedTranscriptTurnEpoch = 6;
            adapter._inputActivityEpoch = 6;
            const staleOwner = adapter._captureResponseOwner('deferred_user_input');
            adapter._advanceAcceptedTranscriptTurnEpoch('newer_user_transcript');
            const activeOwner = adapter._captureResponseOwner('deferred_user_input');
            adapter._deferredUserInputQueue = [
                { userQuestion: 'old question', decision: 'high', owner: staleOwner },
                { userQuestion: 'new question', decision: 'low', owner: activeOwner }
            ];

            adapter._handleResponseDone({ response: { status: 'completed' } });

            expect(adapter.insertUpdatedPrompt).toHaveBeenCalledTimes(1);
            expect(adapter.insertUpdatedPrompt).toHaveBeenCalledWith('new question', 'low');
            expect(emitSpy).toHaveBeenCalledWith('stale_recovery_response_dropped', expect.objectContaining({
                callId: 'call-deferred-filter',
                source: 'deferred_user_input_drain',
                reason: 'newer_transcript_turn'
            }));
        } finally {
            emitSpy.mockRestore();
        }
    });

    test('accepted transcript dispatches primary response after same-turn speech start', () => {
        const adapter = makeSalesAdapter();
        adapter.callSID = 'call-primary-after-speech-start';
        adapter.isConnected = true;
        adapter.isResponding = false;
        adapter.insertUpdatedPrompt = jest.fn();
        adapter.sendTextResponse = jest.fn();
        adapter.send = jest.fn();
        adapter._buildUnclearSalesClarification = jest.fn(() => null);
        adapter._shouldTriggerDeterministicConsultationPivot = jest.fn(() => false);

        adapter._handleSpeechStarted();
        adapter._processUserTranscript('Can you tell me about web development?', 0.91, 'audio_transcription');

        expect(adapter.insertUpdatedPrompt).toHaveBeenCalledTimes(1);
        expect(adapter.insertUpdatedPrompt).toHaveBeenCalledWith('Can you tell me about web development?', null);
        expect(adapter.isUserSpeaking).toBe(false);
        expect(adapter._acceptedTranscriptTurnEpoch).toBe(1);
        expect(adapter._inputActivityEpoch).toBe(2);
    });

    test('scripted and contextual answers can skip synthesis retry loops', () => {
        const adapter = makeSalesAdapter();
        adapter._lastKbIsGeneralFallback = true;
        adapter.conversationContext = [{ sender: 'USER', message: 'Where are you located?' }];

        expect(adapter._shouldSkipSynthesisGateForResponse('We are headquartered in Noida, India.', false)).toBe(true);
        expect(adapter._shouldSkipSynthesisGateForResponse('Any trusted scripted PAT response.', true)).toBe(true);

        adapter._lastKbIsGeneralFallback = false;
        expect(adapter._shouldSkipSynthesisGateForResponse('We are headquartered in Noida, India.', false)).toBe(false);
    });

    test('guardrail fallback context includes booking state for capability fallback decisions', () => {
        const adapter = makeSalesAdapter();
        adapter.conversationContext = [{ sender: 'USER', message: 'Can you support Moodle delivery?' }];
        adapter._bookingIntentDetected = true;
        adapter._bookingActionThisTurn = true;
        adapter.offerAccepted = true;
        adapter.bookingPhoneDeliveryConsent = true;
        adapter.bookingLinkRequested = true;
        adapter.bookingLinkSent = false;
        adapter.userPhone = '+15551234567';
        adapter.userEmail = 'user@example.com';

        const context = adapter._buildGuardrailFallbackContext();

        expect(context).toEqual(expect.objectContaining({
            userQuestion: 'Can you support Moodle delivery?',
            bookingIntentActive: true,
            bookingActionThisTurn: true,
            offerAccepted: true,
            bookingPhoneDeliveryConsent: true,
            bookingLinkRequested: true,
            bookingLinkSent: false,
            userPhoneAvailable: true,
            userEmailAvailable: true,
        }));
    });
});
