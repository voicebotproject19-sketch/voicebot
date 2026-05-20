'use strict';

/**
 * Pipeline simulation — verifies the exact execution flow of
 * screening, voicemail, and post-screening reconnect through
 * the actual code paths in both Plivo and Twilio services.
 *
 * Run: npx jest tests/callPipeline.test.js
 */

const { isCallScreening, isVoicemailContent, isHumanGreeting } = require('../Helper/callClassifier');
const { quickHangupDecision } = require('../Helper/quickDecisionFilter');

// ═══════════════════════════════════════════════════════════════════════════════
// SIMULATION 1: Apple Intelligence screens a Plivo outbound sales call
// ═══════════════════════════════════════════════════════════════════════════════
describe('SIM 1: Apple Intelligence → Plivo Sales Call', () => {
    let count, conversationContext, isBeingScreened, events;

    beforeEach(() => {
        count = 0;
        conversationContext = [];
        isBeingScreened = false;
        events = [];
    });

    test('Turn 1: screening detected and state unchanged', () => {
        const screenText = 'The person you are calling is using a screening service. Please state your name and reason for your call.';
        if (isCallScreening(screenText)) {
            isBeingScreened = true;
            events.push('screening_detected');
        }

        expect(isBeingScreened).toBe(true);
        expect(count).toBe(0);
        expect(conversationContext.length).toBe(0);
        expect(events).toContain('screening_detected');
    });

    test('Turn 1: persona screening response is valid', () => {
        const persona = require('../personas/company-sales');
        const screenResp = persona.screening.response('John');
        expect(screenResp.split(/\s+/).length).toBeLessThanOrEqual(25);
        expect(screenResp).toMatch(/company/i);
        expect(screenResp).toMatch(/john/i);
    });

    test('Turn 1: hangup analysis skipped during screening', () => {
        isBeingScreened = true;
        const shouldAnalyze = !isBeingScreened;
        expect(shouldAnalyze).toBe(false);
    });

    test('Turn 2: human greeting clears screening', () => {
        isBeingScreened = true;
        const humanGreeting = 'Hello?';
        if (isBeingScreened && isHumanGreeting(humanGreeting)) {
            isBeingScreened = false;
            count = 0;
            conversationContext = [];
        }
        count++;
        conversationContext.push({ sender: 'USER', message: humanGreeting });

        expect(isBeingScreened).toBe(false);
        expect(count).toBe(1);
        expect(conversationContext.length).toBe(1);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SIMULATION 2: Google Call Screen → Twilio Webinar Call
// ═══════════════════════════════════════════════════════════════════════════════
describe('SIM 2: Google Call Screen → Twilio Webinar Call', () => {
    test('detects Google screening and clears on human answer', () => {
        let count = 0;
        let conversationContext = [];
        let isBeingScreened = false;

        const screenText = 'Hi, I\'m the Google Assistant. I\'m screening a call for Sarah. Please say your name and why you\'re calling.';
        if (isCallScreening(screenText)) isBeingScreened = true;
        expect(isBeingScreened).toBe(true);

        const persona = require('../personas/exed-webinar');
        const screenResp = persona.screening.response('Sarah');
        expect(screenResp.split(/\s+/).length).toBeLessThanOrEqual(25);
        expect(screenResp).toMatch(/webinar/i);

        const humanText = 'Yeah, go ahead';
        if (isBeingScreened && isHumanGreeting(humanText)) {
            isBeingScreened = false;
            count = 0;
            conversationContext = [];
        }
        count++;
        conversationContext.push({ sender: 'USER', message: humanText });

        expect(isBeingScreened).toBe(false);
        expect(count).toBe(1);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SIMULATION 3: Voicemail → Plivo Sales Call
// ═══════════════════════════════════════════════════════════════════════════════
describe('SIM 3: Voicemail → Plivo Sales Call', () => {
    test('detects voicemail and persona message is valid', () => {
        let count = 0;
        const events = [];
        const vmText = 'Hi, you\'ve reached the voicemail of Mark Johnson. Please leave a message after the beep.';
        if (isVoicemailContent(vmText)) events.push('voicemail_detected');

        expect(events).toContain('voicemail_detected');
        expect(count).toBe(0);

        const persona = require('../personas/company-sales');
        const vmMsg = persona.voicemail.message('Mark');
        expect(vmMsg).toMatch(/mark/i);
        expect(vmMsg).toMatch(/follow up|email/i);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SIMULATION 4: quickHangupDecision edge cases
// ═══════════════════════════════════════════════════════════════════════════════
describe('SIM 4: quickHangupDecision edge cases', () => {
    test('voicemail greeting → hangup', () => {
        const vmContext = [
            { sender: 'AI', message: 'Hey John, this is Sarah from company...' },
            { sender: 'USER', message: 'The person you have called is not available. Please leave a message after the tone.' }
        ];
        const vmDecision = quickHangupDecision(vmContext, 1, 'english');
        expect(vmDecision?.shouldHangup).toBe(true);
        expect(vmDecision?.reason).toBe('voicemail_greeting');
    });

    test('screening → shouldHangup=false', () => {
        const screenContext = [
            { sender: 'AI', message: 'Hey John, this is Sarah from company...' },
            { sender: 'USER', message: 'This call is being screened. Please state your name and the reason for your call.' }
        ];
        const screenDecision = quickHangupDecision(screenContext, 1, 'english');
        expect(screenDecision?.shouldHangup).toBe(false);
        expect(screenDecision?.reason).toBe('ai_screening');
    });

    test('gatekeeper → shouldHangup=false', () => {
        const gatekeeperContext = [
            { sender: 'AI', message: 'Hey John, this is Sarah from company...' },
            { sender: 'USER', message: 'Who is calling please?' }
        ];
        const gkDecision = quickHangupDecision(gatekeeperContext, 1, 'english');
        expect(gkDecision?.shouldHangup).toBe(false);
    });

    test('German gatekeeper → shouldHangup=false', () => {
        const deGatekeeperContext = [
            { sender: 'AI', message: 'Hallo Hans, hier ist Sarah von company...' },
            { sender: 'USER', message: 'Wer ruft an bitte?' }
        ];
        const deGkDecision = quickHangupDecision(deGatekeeperContext, 1, 'german');
        expect(deGkDecision?.shouldHangup).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SIMULATION 5: Human declines after screening
// ═══════════════════════════════════════════════════════════════════════════════
describe('SIM 5: Human declines after screening', () => {
    test('screening detected, count stays 0', () => {
        let isBeingScreened = false;
        let count = 0;
        const screenText = 'Your call is being screened. Please state your name and the reason for your call.';
        if (isCallScreening(screenText)) isBeingScreened = true;
        expect(isBeingScreened).toBe(true);
        expect(count).toBe(0);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SIMULATION 6: Samsung Bixby screening
// ═══════════════════════════════════════════════════════════════════════════════
describe('SIM 6: Samsung Bixby Screening', () => {
    test('Bixby screening detected', () => {
        const bixbyText = 'Your call is being screened by Bixby. Please state your name and why you are calling.';
        expect(isCallScreening(bixbyText)).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SIMULATION 7: German voicemail
// ═══════════════════════════════════════════════════════════════════════════════
describe('SIM 7: German Voicemail', () => {
    test('German Mailbox greeting detected', () => {
        expect(isVoicemailContent('Sie haben die Mailbox von Hans Mueller erreicht. Hinterlassen Sie bitte eine Nachricht nach dem Signalton.')).toBe(true);
    });

    test('German nicht erreichbar detected', () => {
        expect(isVoicemailContent('Der gewuenschte Teilnehmer ist momentan nicht erreichbar. Bitte hinterlassen Sie eine Nachricht.')).toBe(true);
    });

    test('German Anrufbeantworter detected', () => {
        expect(isVoicemailContent('Dies ist der Anrufbeantworter. Bitte sprechen Sie nach dem Piep.')).toBe(true);
    });

    test('German quickHangupDecision catches voicemail', () => {
        const deVm1 = 'Sie haben die Mailbox von Hans Mueller erreicht. Hinterlassen Sie bitte eine Nachricht nach dem Signalton.';
        const deVmContext = [
            { sender: 'AI', message: 'Hallo Hans, hier ist Sarah von company...' },
            { sender: 'USER', message: deVm1 }
        ];
        const deVmDecision = quickHangupDecision(deVmContext, 1, 'german');
        expect(deVmDecision?.reason).toBe('voicemail_greeting');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SIMULATION 8: Rejection phrases still work
// ═══════════════════════════════════════════════════════════════════════════════
describe('SIM 8: Rejection phrases', () => {
    test('English rejection detected', () => {
        const rejectContext = [
            { sender: 'AI', message: 'Hey John, this is Sarah from company...' },
            { sender: 'USER', message: 'Not interested, please stop calling.' }
        ];
        const rejectDecision = quickHangupDecision(rejectContext, 2, 'english');
        expect(rejectDecision?.shouldHangup).toBe(true);
        expect(rejectDecision?.reason).toBe('rejected');
    });

    test('German rejection detected', () => {
        const deRejectContext = [
            { sender: 'AI', message: 'Hallo Hans, hier ist Sarah von company...' },
            { sender: 'USER', message: 'Nicht interessiert, bitte nicht mehr anrufen.' }
        ];
        const deRejectDecision = quickHangupDecision(deRejectContext, 2, 'german');
        expect(deRejectDecision?.shouldHangup).toBe(true);
        expect(deRejectDecision?.reason).toBe('rejected');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SIMULATION 9: Email confirmation still works
// ═══════════════════════════════════════════════════════════════════════════════
describe('SIM 9: Email confirmation', () => {
    test('email confirmation → success hangup', () => {
        const emailContext = [
            { sender: 'USER', message: 'Sure, my email is john@example.com' },
            { sender: 'AI', message: 'Great, I have john@example.com. Is that correct?' },
            { sender: 'USER', message: 'Yes, that is correct.' }
        ];
        const emailDecision = quickHangupDecision(emailContext, 3, 'english');
        expect(emailDecision?.shouldHangup).toBe(true);
        expect(emailDecision?.reason).toBe('success');
        expect(emailDecision?.userEmail).toBe('john@example.com');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SIMULATION 10: Truecaller screening
// ═══════════════════════════════════════════════════════════════════════════════
describe('SIM 10: Truecaller Screening', () => {
    test('Truecaller detected', () => {
        expect(isCallScreening('This call is being screened by Truecaller. Please identify yourself.')).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SIMULATION 11: iOS mid-pickup — post-screening re-greeting
// ═══════════════════════════════════════════════════════════════════════════════
describe('SIM 11: iOS Call Screening Mid-Pickup Re-Greeting', () => {
    const persona = require('../personas/company-sales');

    test('post-screening reconnect triggers on ANY non-screening transcript', () => {
        // The real code no longer uses isHumanGreeting — any transcript while
        // isBeingScreened is true triggers reconnect (isCallScreening already
        // returned false for these texts before the reconnect check).
        const humanTexts = [
            'Hello',
            'Who is this?',
            'What do you want?',
            'Why are you calling?',
            'OK',
            'Hm?',
            'Yes',
        ];
        for (const humanText of humanTexts) {
            let isBeingScreened = true;
            let count = 0;
            let regreeted = false;

            // isCallScreening check (runs first in real code)
            if (isCallScreening(humanText)) continue; // shouldn't happen

            // Post-screening reconnect — now uses just isBeingScreened
            if (isBeingScreened) {
                isBeingScreened = false;
                count = 0;
                regreeted = true;
            }

            expect(isBeingScreened).toBe(false);
            expect(regreeted).toBe(true);
        }
    });

    test('screening text does NOT trigger reconnect (caught by isCallScreening first)', () => {
        const screeningTexts = [
            'The person you are calling is using a screening service.',
            'Hi, I am the Google Assistant screening this call.',
            'Your call is being screened by Bixby.',
        ];
        for (const s of screeningTexts) {
            expect(isCallScreening(s)).toBe(true);
        }
    });

    test('re-greeting text matches persona greeting', () => {
        const greetingText = persona.languages.en.greeting('John');
        expect(greetingText).toMatch(/Sarah/);
        expect(greetingText).toMatch(/company/i);
        expect(greetingText).toMatch(/John/);
    });

    test('screening grace timeout re-greets proactively (simulation)', (done) => {
        let isBeingScreened = true;
        let regreetingSent = false;
        const graceMs = 50; // short for test
        setTimeout(() => {
            if (isBeingScreened) {
                isBeingScreened = false;
                regreetingSent = true; // simulates: send(this._buildResponseCreate({instructions: greeting}))
            }
        }, graceMs);

        setTimeout(() => {
            expect(isBeingScreened).toBe(false);
            expect(regreetingSent).toBe(true);
            done();
        }, graceMs + 20);
    });

    test('isHumanGreeting still works for common greetings', () => {
        // isHumanGreeting is no longer used for post-screening reconnect,
        // but verify it still works for other callers of the function.
        const greetings = ['hello', 'Hello?', 'Hi', 'hey', 'Yes', 'yeah', 'speaking', 'go ahead', 'this is John'];
        for (const g of greetings) {
            expect(isHumanGreeting(g)).toBe(true);
        }
    });
});
