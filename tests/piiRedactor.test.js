'use strict';

const { redactPII } = require('../Utils/piiRedactor');

describe('piiRedactor', () => {
    test('redacts SSN patterns', () => {
        expect(redactPII('my ssn is 123-45-6789')).toBe('my ssn is [REDACTED_SSN]');
    });

    test('redacts email addresses', () => {
        expect(redactPII('contact me at john@example.com please')).toBe(
            'contact me at [REDACTED_EMAIL] please'
        );
    });

    test('redacts phone numbers', () => {
        const result = redactPII('call me at +1 555-123-4567');
        expect(result).toContain('[REDACTED_PHONE]');
        expect(result).not.toContain('555-123-4567');
    });

    test('redacts Luhn-valid credit card numbers', () => {
        // Visa test card number
        expect(redactPII('card is 4111111111111111')).toBe('card is [REDACTED_CC]');
    });

    test('does not redact non-Luhn digit strings', () => {
        // 16-digit string that fails Luhn
        expect(redactPII('code 1234567890123456')).not.toContain('[REDACTED_CC]');
    });

    test('handles null and non-string input gracefully', () => {
        expect(redactPII(null)).toBe(null);
        expect(redactPII(undefined)).toBe(undefined);
        expect(redactPII('')).toBe('');
    });

    test('redacts multiple PII types in one string', () => {
        const input = 'email john@test.com ssn 111-22-3333 card 4111111111111111';
        const result = redactPII(input);
        expect(result).toContain('[REDACTED_EMAIL]');
        expect(result).toContain('[REDACTED_SSN]');
        expect(result).toContain('[REDACTED_CC]');
    });

    test('CC with spaces/dashes is redacted (Luhn-valid)', () => {
        expect(redactPII('card 4111 1111 1111 1111')).toContain('[REDACTED_CC]');
    });

    test('CC is prioritized over phone regex (ordering)', () => {
        // A valid CC number should not be consumed by phone regex
        const result = redactPII('pay with 4111111111111111');
        expect(result).toContain('[REDACTED_CC]');
        expect(result).not.toContain('[REDACTED_PHONE]');
    });
});
