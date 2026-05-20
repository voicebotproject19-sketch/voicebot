'use strict';

const { evaluateDealerOrderActionGuard } = require('../transactions/actionGuard');

describe('actionGuard', () => {
    test('allows explicitly confirmed dealer order with numeric recap in interactive mode', () => {
        const result = evaluateDealerOrderActionGuard({
            explicitConfirmationReceived: true,
            numericRepetitionReceived: true,
            sttConfidence: 0.96,
            interactionMode: 'INTERACTIVE',
            interrupted: false,
            backendAuthoritativeOk: true,
        });

        expect(result.allowed).toBe(true);
        expect(result.failures).toEqual([]);
        expect(result.actionType).toBe('dealer_order_submit');
    });

    test('blocks unsafe dealer-order actions before side effects', () => {
        const result = evaluateDealerOrderActionGuard({
            explicitConfirmationReceived: false,
            numericRepetitionReceived: false,
            sttConfidence: 0.4,
            interactionMode: 'NON_INTERACTIVE',
            interrupted: true,
            backendAuthoritativeOk: true,
        });

        expect(result.allowed).toBe(false);
        expect(result.failures).toEqual(expect.arrayContaining([
            'INTERACTIVE_mode_required',
            'explicit_confirmation_required',
            'numeric_repetition_required',
            'stt_confidence_below_threshold',
            'abort_on_interruption',
        ]));
    });

    test('treats missing provider confidence as neutral but blocks explicit low confidence', () => {
        expect(evaluateDealerOrderActionGuard({
            explicitConfirmationReceived: true,
            numericRepetitionReceived: true,
            interactionMode: 'INTERACTIVE',
            interrupted: false,
            backendAuthoritativeOk: true,
        }).allowed).toBe(true);

        expect(evaluateDealerOrderActionGuard({
            explicitConfirmationReceived: true,
            numericRepetitionReceived: true,
            sttConfidence: 0.2,
            interactionMode: 'INTERACTIVE',
            interrupted: false,
            backendAuthoritativeOk: true,
        }).failures).toContain('stt_confidence_below_threshold');
    });
});