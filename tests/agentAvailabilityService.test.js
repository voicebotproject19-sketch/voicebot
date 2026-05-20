'use strict';

const {
    getAgentTargetCandidates,
    parseTargetList,
    resolveAgentAvailability
} = require('../services/agentAvailabilityService');

describe('agentAvailabilityService', () => {
    test('parses comma-separated and JSON agent target lists with phone normalization', () => {
        expect(parseTargetList('+1 (555) 000-1111, +44 20 1234 5678, invalid')).toEqual([
            '+15550001111',
            '+442012345678'
        ]);
        expect(parseTargetList('["+1 (555) 000-1111", "+1 (555) 000-1111"]')).toEqual([
            '+15550001111'
        ]);
    });

    test('prefers contact agent numbers before env fallback', () => {
        const targets = getAgentTargetCandidates({
            env: {
                WARM_TRANSFER_AGENT_NUMBERS: '+15550009999',
                company_SALES_AGENT_NUMBERS: '+15550008888'
            },
            contact: { agentNumbers: '+15550001111' },
            personaId: 'company-sales',
            fallbackTransferNumber: '+15550002222'
        });

        expect(targets).toEqual(['+15550001111']);
    });

    test('returns disabled availability without claiming live agent availability', () => {
        const availability = resolveAgentAvailability({
            env: { WARM_TRANSFER_ENABLED: 'false', WARM_TRANSFER_AGENT_NUMBERS: '+15550001111' }
        });

        expect(availability).toEqual(expect.objectContaining({
            enabled: false,
            available: false,
            mode: 'cold',
            reason: 'warm_transfer_disabled',
            selectedTargets: []
        }));
    });

    test('returns configured targets when warm transfer is enabled', () => {
        const availability = resolveAgentAvailability({
            env: {
                WARM_TRANSFER_ENABLED: 'true',
                WARM_TRANSFER_AGENT_NUMBERS: '+1 (555) 000-1111',
                WARM_TRANSFER_TIMEOUT_SECONDS: '15',
                WARM_TRANSFER_CONFIRM_TIMEOUT_SECONDS: '6',
                WARM_TRANSFER_CONFIRM_KEY: '7'
            }
        });

        expect(availability).toEqual(expect.objectContaining({
            enabled: true,
            available: true,
            mode: 'warm',
            reason: 'configured_agent_targets',
            selectedTargets: ['+15550001111'],
            timeoutSeconds: 15,
            confirmTimeoutSeconds: 6,
            confirmKey: '7'
        }));
    });
});
