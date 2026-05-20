'use strict';

const {
    assertClusterBootSafe,
    evaluateClusterBootGuard,
    getDeploymentGuardWarnings,
    isClusterMode,
    readWorkerCount,
    verifyCallContextSnapshotsTable
} = require('../config/deploymentGuards');

describe('deploymentGuards', () => {
    test('treats non-cluster runtime as safe without durable-context verification', () => {
        expect(isClusterMode({ NODE_ENV: 'production' })).toBe(false);
        expect(evaluateClusterBootGuard({
            env: { NODE_ENV: 'production' },
            durableContextAvailable: false
        })).toMatchObject({
            ok: true,
            reason: 'single_instance',
            clusterMode: false,
        });
        expect(getDeploymentGuardWarnings({ NODE_ENV: 'production' })).toEqual([]);
    });

    test.each([
        [{ VOICEBOT_CLUSTER_MODE: 'true' }, 'VOICEBOT_CLUSTER_MODE'],
        [{ WEB_CONCURRENCY: '2' }, 'WEB_CONCURRENCY'],
        [{ WORKERS: '2' }, 'WORKERS'],
        [{ PM2_INSTANCES: '2' }, 'PM2_INSTANCES'],
        [{ PM2_INSTANCES: 'max' }, 'PM2_INSTANCES=max'],
    ])('detects cluster mode from %s', (env) => {
        expect(isClusterMode(env)).toBe(true);
    });

    test('does not treat PM2_HOME alone as multi-worker cluster mode', () => {
        expect(isClusterMode({ PM2_HOME: '/tmp/pm2' })).toBe(false);
    });

    test('parses numeric and max worker counts', () => {
        expect(readWorkerCount('')).toBe(0);
        expect(readWorkerCount('1')).toBe(1);
        expect(readWorkerCount('2')).toBe(2);
        expect(readWorkerCount('max')).toBe(Number.POSITIVE_INFINITY);
        expect(readWorkerCount('not-a-number')).toBe(0);
    });

    test('durable-context acknowledgement is advisory and does not make cluster boot safe', () => {
        const decision = evaluateClusterBootGuard({
            env: {
                VOICEBOT_CLUSTER_MODE: 'true',
                VOICEBOT_CLUSTER_DURABLE_CONTEXT_ACK: 'true'
            },
            durableContextAvailable: false
        });

        expect(decision).toMatchObject({
            ok: false,
            reason: 'durable_context_unavailable',
            clusterMode: true,
            durableContextAck: true,
            durableContextAvailable: false,
        });
    });

    test('verified durable context makes cluster boot safe without advisory acknowledgement', () => {
        expect(evaluateClusterBootGuard({
            env: { VOICEBOT_CLUSTER_MODE: 'true' },
            durableContextAvailable: true
        })).toMatchObject({
            ok: true,
            reason: 'durable_context_verified',
            clusterMode: true,
            durableContextAck: false,
            durableContextAvailable: true,
        });
    });

    test('durable context check errors make cluster boot unsafe', () => {
        expect(evaluateClusterBootGuard({
            env: { VOICEBOT_CLUSTER_MODE: 'true' },
            durableContextError: new Error('db unavailable')
        })).toMatchObject({
            ok: false,
            reason: 'durable_context_check_failed',
            durableContextError: 'db unavailable',
        });
    });

    test('verifies call_context_snapshots table through DB query', async () => {
        const db = { query: jest.fn().mockResolvedValue([{ ok: 1 }]) };

        await expect(verifyCallContextSnapshotsTable(db)).resolves.toBe(true);
        expect(db.query).toHaveBeenCalledWith(expect.stringContaining("table_name = 'call_context_snapshots'"));
    });

    test('reports missing call_context_snapshots table as unavailable', async () => {
        await expect(verifyCallContextSnapshotsTable({
            query: jest.fn().mockResolvedValue([])
        })).resolves.toBe(false);
    });

    test('assertClusterBootSafe refuses cluster boot when DB env is incomplete', async () => {
        await expect(assertClusterBootSafe({
            env: { VOICEBOT_CLUSTER_MODE: 'true' },
            db: { query: jest.fn() },
            logger: { warn: jest.fn() }
        })).rejects.toThrow('Missing required DB env');
    });

    test('assertClusterBootSafe refuses cluster boot when durable table is missing', async () => {
        await expect(assertClusterBootSafe({
            env: {
                VOICEBOT_CLUSTER_MODE: 'true',
                DB_HOST: 'localhost',
                DB_USER: 'voicebot',
                DB_NAME: 'voicebot',
                VOICEBOT_CLUSTER_DURABLE_CONTEXT_ACK: 'true'
            },
            db: { query: jest.fn().mockResolvedValue([]) },
            logger: { warn: jest.fn() }
        })).rejects.toThrow('call_context_snapshots');
    });

    test('assertClusterBootSafe allows cluster boot when durable table is reachable', async () => {
        await expect(assertClusterBootSafe({
            env: {
                VOICEBOT_CLUSTER_MODE: 'true',
                DB_HOST: 'localhost',
                DB_USER: 'voicebot',
                DB_NAME: 'voicebot'
            },
            db: { query: jest.fn().mockResolvedValue([{ ok: 1 }]) },
            logger: { warn: jest.fn() }
        })).resolves.toMatchObject({
            ok: true,
            reason: 'durable_context_verified'
        });
    });

    test('unsafe acknowledgement does not bypass durable context verification', async () => {
        const logger = { warn: jest.fn() };
        const db = { query: jest.fn() };
        await expect(assertClusterBootSafe({
            env: {
                VOICEBOT_CLUSTER_MODE: 'true',
                VOICEBOT_CLUSTER_UNSAFE_ACK: 'true',
                DB_HOST: 'localhost',
                DB_USER: 'voicebot',
                DB_NAME: 'voicebot'
            },
            db,
            logger
        })).rejects.toThrow('call_context_snapshots');

        expect(db.query).toHaveBeenCalled();
        expect(logger.warn).not.toHaveBeenCalled();
    });

    test('ecosystem config defaults PM2 to single-instance demo mode', () => {
        const originalPm2Instances = process.env.PM2_INSTANCES;
        delete process.env.PM2_INSTANCES;
        jest.resetModules();

        const ecosystem = require('../ecosystem.config');
        const app = ecosystem.apps[0];

        expect(app.instances).toBe(1);
        expect(app.exec_mode).toBe('fork');
        expect(app.env.VOICEBOT_CLUSTER_MODE).toBe('false');
        expect(app.env_production.VOICEBOT_CLUSTER_MODE).toBe('false');

        if (originalPm2Instances === undefined) delete process.env.PM2_INSTANCES;
        else process.env.PM2_INSTANCES = originalPm2Instances;
        jest.resetModules();
    });

    test('ecosystem config opts into cluster mode only when PM2_INSTANCES requests it', () => {
        const originalPm2Instances = process.env.PM2_INSTANCES;
        process.env.PM2_INSTANCES = '2';
        jest.resetModules();

        const ecosystem = require('../ecosystem.config');
        const app = ecosystem.apps[0];

        expect(app.instances).toBe(2);
        expect(app.exec_mode).toBe('cluster');
        expect(app.env.VOICEBOT_CLUSTER_MODE).toBe('true');
        expect(app.env_production.VOICEBOT_CLUSTER_MODE).toBe('true');

        if (originalPm2Instances === undefined) delete process.env.PM2_INSTANCES;
        else process.env.PM2_INSTANCES = originalPm2Instances;
        jest.resetModules();
    });
});
