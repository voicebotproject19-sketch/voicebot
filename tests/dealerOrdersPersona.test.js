'use strict';

const { getPersonaLanguage, listPersonas } = require('../personas/registry');

describe('dealer-orders persona', () => {
    test('is registered with English support', () => {
        expect(listPersonas().some(persona => persona.id === 'dealer-orders')).toBe(true);
        const { persona, lang } = getPersonaLanguage('dealer-orders', 'en');
        expect(persona.flow.type).toBe('dealer-order-capture');
        expect(lang.knowledgeBase).toBeNull();
    });

    test('uses CRM context in greeting and prompt', () => {
        const { lang } = getPersonaLanguage('dealer-orders', 'en');
        const contextHint = JSON.stringify({
            dealerName: 'Apex Auto',
            lastOrder: '20 cases of engine oil',
            monthlyTargetPercent: 85,
            milestonePrompt: 'This order could unlock Tier 2 bonuses.',
        });
        const greeting = lang.greeting('Fallback Name', { contextHint });
        expect(greeting).toContain('Apex Auto');
        expect(greeting).toContain('20 cases of engine oil');

        const prompt = lang.buildTurnPrompt({
            count: 1,
            name: 'Apex Auto',
            userQuestion: 'I need 10 filters',
            userEmail: null,
            userPhone: null,
            preferredSlot: null,
            bookingLinkRequested: false,
            bookingLinkSent: false,
            bookingProvider: null,
            bookingDeliveryPreference: null,
            bookingPhoneDeliveryConsent: false,
            bookingDeliveryChannels: [],
            contextHint,
            dealerContext: null,
            dealerOrder: { items: [], awaitingConfirmation: false, confirmed: false },
            conversationContext: '',
            relevantKnowledge: '',
            hasAskedForConsultation: false,
            conversationPhase: 'opening',
            toneDirective: null,
            decision: 'high',
        });
        expect(prompt).toContain('Monthly target progress: 85%');
        expect(prompt).toContain('This order could unlock Tier 2 bonuses.');
    });
});
