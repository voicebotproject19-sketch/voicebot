'use strict';

const {
    PORT_CLEANUP_DELAY_MS,
    isProductionEnv,
    normalizeNodeEnv,
    runPortCleanupIfEnabled,
    shouldRunPortCleanup,
} = require('../config/startupGuards');

describe('startupGuards', () => {
    test.each([
        [{ NODE_ENV: 'production' }, true],
        [{ NODE_ENV: 'Production' }, true],
        [{ NODE_ENV: ' production ' }, true],
        [{ NODE_ENV: 'development' }, false],
        [{ NODE_ENV: 'test' }, false],
        [{}, false],
    ])('detects production env for %j', (env, expected) => {
        expect(isProductionEnv(env)).toBe(expected);
    });

    test.each([
        [{ NODE_ENV: 'production' }, false],
        [{ NODE_ENV: 'Production' }, false],
        [{ NODE_ENV: ' production ' }, false],
        [{ NODE_ENV: 'development' }, true],
        [{ NODE_ENV: 'test' }, true],
        [{}, true],
    ])('resolves port cleanup policy for %j', (env, expected) => {
        expect(shouldRunPortCleanup(env)).toBe(expected);
    });

    test('normalizes NODE_ENV consistently', () => {
        expect(normalizeNodeEnv({ NODE_ENV: ' Production ' })).toBe('production');
        expect(normalizeNodeEnv({ NODE_ENV: undefined })).toBe('');
    });

    test('skips port cleanup and wait in production', async () => {
        const cleanup = jest.fn();
        const wait = jest.fn();

        await expect(runPortCleanupIfEnabled({
            env: { NODE_ENV: 'production' },
            port: 4000,
            cleanup,
            wait,
        })).resolves.toEqual({ ran: false, reason: 'production' });

        expect(cleanup).not.toHaveBeenCalled();
        expect(wait).not.toHaveBeenCalled();
    });

    test('runs port cleanup and wait outside production', async () => {
        const cleanup = jest.fn().mockResolvedValue();
        const wait = jest.fn().mockResolvedValue();

        await expect(runPortCleanupIfEnabled({
            env: { NODE_ENV: 'development' },
            port: 4000,
            cleanup,
            wait,
        })).resolves.toEqual({ ran: true, reason: 'enabled' });

        expect(cleanup).toHaveBeenCalledWith(4000);
        expect(wait).toHaveBeenCalledWith(PORT_CLEANUP_DELAY_MS);
    });

    test('treats missing NODE_ENV as local cleanup-safe mode', async () => {
        const cleanup = jest.fn().mockResolvedValue();
        const wait = jest.fn().mockResolvedValue();

        await expect(runPortCleanupIfEnabled({
            env: {},
            port: 4000,
            cleanup,
            wait,
            delayMs: 0,
        })).resolves.toEqual({ ran: true, reason: 'enabled' });

        expect(cleanup).toHaveBeenCalledWith(4000);
        expect(wait).not.toHaveBeenCalled();
    });

    test('requires a cleanup function when cleanup is enabled', async () => {
        await expect(runPortCleanupIfEnabled({
            env: { NODE_ENV: 'development' },
            port: 4000,
        })).rejects.toThrow('Port cleanup function is required');
    });
});
