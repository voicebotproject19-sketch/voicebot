'use strict';

describe('writeQueue', () => {
    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
    });

    test('emits telemetry when an overflow drops a job', () => {
        const mockEmit = jest.fn();
        jest.mock('../Utils/telemetry', () => ({ emit: mockEmit }));
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const writeQueue = require('../services/writeQueue');

        for (let index = 0; index < 10000; index++) {
            expect(writeQueue.enqueue({
                type: 'persist_call',
                callSID: `CALL-${index}`
            })).toBe(true);
        }

        expect(writeQueue.enqueue({
            type: 'persist_outcome',
            callSID: 'CALL-overflow',
            provider: 'twilio'
        })).toBe(false);

        expect(mockEmit).toHaveBeenCalledWith('write_queue_full', expect.objectContaining({
            jobType: 'persist_outcome',
            callId: 'CALL-overflow',
            provider: 'twilio',
            queueLength: 10000,
            ts: expect.any(Number)
        }));

        warnSpy.mockRestore();
    });
});
