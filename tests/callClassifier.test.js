'use strict';

/**
 * Validation suite for Helper/callClassifier.js
 *
 * Run: npx jest tests/callClassifier.test.js
 */

const { isCallScreening, isVoicemailContent, isHumanGreeting, isGarbledTranscript } = require('../Helper/callClassifier');

// ── 1. Screening True Positives ─────────────────────────────────────────────
describe('Screening Detection', () => {
    const screeningPositives = [
        'The person you are calling is using a screening service. Please state your name and reason for your call.',
        'Hi, I\'m the Google Assistant. I\'m screening a call for John. Please say your name and why you\'re calling.',
        'This call is being screened. Please state your name and the reason for your call.',
        'Your call is being screened by Bixby. Please state your name.',
        'This call is being screened by Truecaller.',
        'Hi, I\'m the Google Assistant, screening this call for Sarah.',
        'The person you\'re calling is using a call screening service.',
        'Call screen activated. Please state your name and reason for your call.',
        'Please state your name and the reason for your call.',
        'Tell me your name and the reason for calling.',
        'Say your name and why you are calling.',
    ];

    test.each(screeningPositives)('detects screening: %s', (text) => {
        expect(isCallScreening(text)).toBe(true);
    });

    const screeningNegatives = [
        'Hello?',
        'Yes, who is this?',
        'I\'m not interested.',
        'Can you tell me more about your services?',
        'What is this about?',
        'Who\'s calling please?',
        'I don\'t have time right now.',
        'We already have a vendor for that.',
        'Send me an email instead.',
        'How did you get my number?',
        'Worum geht es denn?',
    ];

    test.each(screeningNegatives)('does NOT detect screening: %s', (text) => {
        expect(isCallScreening(text)).toBe(false);
    });
});

// ── Voicemail Detection ─────────────────────────────────────────────────────
describe('Voicemail Detection', () => {
    const voicemailPositives = [
        'Hi, you\'ve reached the voicemail of John Smith. Please leave a message after the beep.',
        'The person you have called is not available. Please leave a message after the tone.',
        'You have reached the mailbox of Jane Doe.',
        'Please leave your message after the beep.',
        'At the tone, please record your message.',
        'The subscriber you are trying to reach is not available. Please leave a message.',
        'The number you have dialed is not available. Please record your message after the beep.',
        'Leave a message after the tone and I\'ll get back to you.',
        'Please leave a message and I will return your call.',
        'Sie haben die Mailbox von Hans Mueller erreicht. Hinterlassen Sie eine Nachricht nach dem Signalton.',
        'Der Teilnehmer ist nicht erreichbar. Bitte hinterlassen Sie eine Nachricht.',
        'Dies ist der Anrufbeantworter von Firma Schmidt.',
    ];

    test.each(voicemailPositives)('detects voicemail: %s', (text) => {
        expect(isVoicemailContent(text)).toBe(true);
    });

    const voicemailNegatives = [
        'Hello, this is John.',
        'I\'m not available right now, can you call back?',
        'Yeah, what\'s up?',
        'No thanks, I\'m not interested.',
        'Can you send me that information by email?',
        'Ja, wer ist denn da?',
    ];

    test.each(voicemailNegatives)('does NOT detect voicemail: %s', (text) => {
        expect(isVoicemailContent(text)).toBe(false);
    });
});

// ── Human Greeting Detection ────────────────────────────────────────────────
describe('Human Greeting Detection', () => {
    const greetingPositives = [
        'Hello?', 'Hi, this is John.', 'Hey there.', 'Yes?',
        'Yeah, go ahead.', 'Speaking.', 'Go ahead.', 'This is Sarah.',
    ];

    test.each(greetingPositives)('detects greeting: %s', (text) => {
        expect(isHumanGreeting(text)).toBe(true);
    });

    const greetingNegatives = [
        'I\'m not interested.',
        'What is this about?',
        'Remove me from your list.',
        'The person you are calling is using a screening service.',
    ];

    test.each(greetingNegatives)('does NOT detect greeting: %s', (text) => {
        expect(isHumanGreeting(text)).toBe(false);
    });
});

// ── Edge cases ──────────────────────────────────────────────────────────────
describe('Edge Cases', () => {
    test('null input → screening false', () => expect(isCallScreening(null)).toBe(false));
    test('undefined input → screening false', () => expect(isCallScreening(undefined)).toBe(false));
    test('empty string → screening false', () => expect(isCallScreening('')).toBe(false));
    test('null input → voicemail false', () => expect(isVoicemailContent(null)).toBe(false));
    test('empty string → voicemail false', () => expect(isVoicemailContent('')).toBe(false));
    test('null input → greeting false', () => expect(isHumanGreeting(null)).toBe(false));
    test('empty string → greeting false', () => expect(isHumanGreeting('')).toBe(false));
});

// ── "not available" voicemail vs human distinction ──────────────────────────
describe('"not available" disambiguation', () => {
    test('VM: "not available please leave a message"', () => {
        expect(isVoicemailContent('The person is not available. Please leave a message after the tone.')).toBe(true);
    });
    test('NOT-VM: "I\'m not available right now"', () => {
        expect(isVoicemailContent('I\'m not available right now, can you call back later?')).toBe(false);
    });
});

// ── Garble Detection ────────────────────────────────────────────────────────
describe('Garble Detection', () => {
    describe('True Positives (noise artifacts)', () => {
        const trueGarblePositives = [
            'Mobile.', 'Argent.', 'RPHS.',
            'Do it?', 'Uh hm?', 'Da ba.', 'Er um.', 'Go to?',
            'A bu da.', 'Ba ka ra.',
        ];
        test.each(trueGarblePositives)('detects garble: %s', (text) => {
            expect(isGarbledTranscript(text)).toBe(true);
        });
    });

    describe('False Positives (valid transcripts)', () => {
        const validTranscripts = [
            'yes', 'no', 'yeah', 'yep', 'nope', 'okay', 'sure', 'hi',
            'ja', 'nein', 'danke',
            'Can you please help me?',
            'Do you work in RPA services as well?',
            'But do you have Moodle developers with you?',
            'Do you have Moodle developers with you?',
            'More about your AI services.',
            'What kind of services do you offer?',
            'Tell me more about your projects.',
            'Can you tell me a bit more?',
        ];
        test.each(validTranscripts)('does NOT detect garble: %s', (text) => {
            expect(isGarbledTranscript(text)).toBe(false);
        });
    });

    describe('Edge Cases', () => {
        test('null → garbled', () => expect(isGarbledTranscript(null)).toBe(true));
        test('empty string → garbled', () => expect(isGarbledTranscript('')).toBe(true));
        test('whitespace-only → garbled', () => expect(isGarbledTranscript('   ')).toBe(true));
        test('"No." → valid', () => expect(isGarbledTranscript('No.')).toBe(false));
        test('"Yes." → valid', () => expect(isGarbledTranscript('Yes.')).toBe(false));
        test('"Right." → valid', () => expect(isGarbledTranscript('Right.')).toBe(false));
        test('"Ja." → valid (German)', () => expect(isGarbledTranscript('Ja.')).toBe(false));
        test('"Nein." → valid (German)', () => expect(isGarbledTranscript('Nein.')).toBe(false));
        test('"Where I?" → passes (threshold lowered to avoid false positives)', () => expect(isGarbledTranscript('Where I?')).toBe(false));
        test('"Do you provide?" → borderline passes', () => expect(isGarbledTranscript('Do you provide?')).toBe(false));
        test('"Mobile." → garbled', () => expect(isGarbledTranscript('Mobile.')).toBe(true));
        test('"How did RP?" → passes (threshold lowered to avoid false positives)', () => expect(isGarbledTranscript('How did RP?')).toBe(false));
        test('"Am I audible?" → valid', () => expect(isGarbledTranscript('Am I audible?')).toBe(false));
        test('"Can you hear?" → valid', () => expect(isGarbledTranscript('Can you hear?')).toBe(false));
        test('"Who is this?" → valid', () => expect(isGarbledTranscript('Who is this?')).toBe(false));
        test('"Are you do you do RPA?" → valid (model handles disfluency)', () => expect(isGarbledTranscript('Are you do you do RPA?')).toBe(false));
        test('"More about your AI services." → valid', () => expect(isGarbledTranscript('More about your AI services.')).toBe(false));
        test('"Do you work in RPA services as well?" → valid', () => expect(isGarbledTranscript('Do you work in RPA services as well?')).toBe(false));
        test('"But do you have Moodle developers with you?" → valid', () => expect(isGarbledTranscript('But do you have Moodle developers with you?')).toBe(false));
        test('"Do you have Moodle developers with you?" → valid', () => expect(isGarbledTranscript('Do you have Moodle developers with you?')).toBe(false));
    });

    describe('Business-Critical Phrases', () => {
        const businessCriticalPhrases = [
            'Not interested', 'No thanks', 'Not now', 'Stop calling',
            'Go ahead', 'Sounds good', 'Yes please', 'Of course',
            'How much', 'Send email', 'Call back', 'Tell me',
            'Book call', 'Book my call', 'Schedule call',
            'Nicht interessiert', 'Nein danke', 'Kein Interesse',
            'Wie bitte', 'Wie viel', 'Ja bitte', 'Alles klar', 'Moment bitte',
            'Hold on', 'Hang on', 'One moment', 'One second', 'Just a second', 'Wait a moment',
            'Say again', 'Excuse me',
            'Warten Sie', 'Einen Moment', 'Moment mal',
            // Audibility / connection checks
            'Am I audible', 'Can you hear', 'Are you there',
            // Common questions / statements
            'Who is this', 'What is it', 'What was that', 'How are you',
            'I am busy', 'Not right now', 'Yes I am', 'I am good',
            'Who are you', 'I said yes', 'Tell me more', 'Is that so',
            // Polite responses / deferrals
            'Yes sir', 'No sir', 'Not yet',
        ];
        test.each(businessCriticalPhrases)('preserves: %s', (text) => {
            expect(isGarbledTranscript(text)).toBe(false);
        });
    });

    describe('Multilingual Booking-Like Phrases', () => {
        const multilingualBookingPhrases = [
            'بک کو کال',
            'کال بک',
            'कॉल बुक',
            'बुक कॉल',
        ];

        test.each(multilingualBookingPhrases)('preserves booking phrase: %s', (text) => {
            expect(isGarbledTranscript(text)).toBe(false);
        });
    });

    describe('German Single-Word Responses', () => {
        const germanSingleWords = [
            'Bitte', 'Was', 'Wie', 'Wer', 'Wo', 'Warum', 'Moment',
            'Wait', 'Hold', 'Sorry', 'Pardon', 'Please', 'Stop', 'What',
            'Warten', 'Stopp', 'Entschuldigung',
        ];
        test.each(germanSingleWords)('preserves: %s', (text) => {
            expect(isGarbledTranscript(text)).toBe(false);
        });
    });

    describe('Threshold Boundary', () => {
        test('"Do it?" → garbled (4 chars < 5)', () => expect(isGarbledTranscript('Do it?')).toBe(true));
        test('"Uh hm?" → garbled (4 chars < 5)', () => expect(isGarbledTranscript('Uh hm?')).toBe(true));
        test('"A bu da." → garbled (5 chars < 7)', () => expect(isGarbledTranscript('A bu da.')).toBe(true));
        test('"Where I?" → passes (6 chars >= 5)', () => expect(isGarbledTranscript('Where I?')).toBe(false));
        test('"RP hmm." → passes (5 chars >= 5)', () => expect(isGarbledTranscript('RP hmm.')).toBe(false));
        test('"How did RP?" → passes (8 chars >= 7)', () => expect(isGarbledTranscript('How did RP?')).toBe(false));
    });

    describe('Emphatic Repetition (NOT stutter)', () => {
        const emphaticRepetitions = [
            'Yes yes, I understand', 'No no, that is wrong',
            'Okay okay, I will do it', 'Right right, I see',
            'Yeah yeah sure', 'Fine fine, go ahead',
        ];
        test.each(emphaticRepetitions)('preserves: %s', (text) => {
            expect(isGarbledTranscript(text)).toBe(false);
        });
    });

    describe('Previously False-Positive (stutter block removed)', () => {
        const previouslyFalsePositive = [
            'What will be the cost of the project?',
            'Can you send the report to the client?',
            'I need the quote for the project',
            'Is this for testing or for production?',
            'Are you do you do RPA?',
            'Can you can you help me?',
            'What about what about the pricing?',
        ];
        test.each(previouslyFalsePositive)('preserves: %s', (text) => {
            expect(isGarbledTranscript(text)).toBe(false);
        });
    });
});
