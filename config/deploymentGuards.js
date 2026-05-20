'use strict';

const CALL_CONTEXT_TABLE_CHECK_SQL = "SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'call_context_snapshots' LIMIT 1";

function isTruthy(value) {
    return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function readWorkerCount(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return 0;
    if (raw === 'max') return Number.POSITIVE_INFINITY;
    if (!/^\d+$/.test(raw)) return 0;
    return Number.parseInt(raw, 10);
}

function isClusterMode(env = process.env) {
    if (isTruthy(env.VOICEBOT_CLUSTER_MODE)) return true;
    if (readWorkerCount(env.WEB_CONCURRENCY) > 1) return true;
    if (readWorkerCount(env.WORKERS) > 1) return true;
    if (readWorkerCount(env.PM2_INSTANCES) > 1) return true;
    if (env.NODE_APP_INSTANCE != null && readWorkerCount(env.PM2_INSTANCES) > 1) return true;
    return false;
}

function buildClusterBootFailure(reason, message, details = {}) {
    return {
        ok: false,
        reason,
        message,
        warnings: [],
        ...details
    };
}

function evaluateClusterBootGuard({ env = process.env, durableContextAvailable = false, durableContextError = null } = {}) {
    const clusterMode = isClusterMode(env);
    const durableContextAck = isTruthy(env.VOICEBOT_CLUSTER_DURABLE_CONTEXT_ACK);

    const base = {
        clusterMode,
        durableContextAck,
        durableContextAvailable: Boolean(durableContextAvailable),
        durableContextError: durableContextError ? durableContextError.message || String(durableContextError) : null,
    };

    if (!clusterMode) {
        return { ok: true, reason: 'single_instance', warnings: [], ...base };
    }

    if (durableContextAvailable) {
        return { ok: true, reason: 'durable_context_verified', warnings: [], ...base };
    }

    if (durableContextError) {
        return buildClusterBootFailure(
            'durable_context_check_failed',
            `Cluster mode detected, but call_context_snapshots could not be verified: ${base.durableContextError}`,
            base
        );
    }

    return buildClusterBootFailure(
        'durable_context_unavailable',
        'Cluster mode detected, but call_context_snapshots is not reachable. Apply migrations/009_call_context_snapshots.sql or run a single instance before accepting traffic.',
        base
    );
}

function assertDbEnvForCluster(env = process.env) {
    const missing = ['DB_HOST', 'DB_USER', 'DB_NAME'].filter(name => !String(env[name] || '').trim());
    if (!missing.length) return null;
    return new Error(`Missing required DB env for clustered startup: ${missing.join(', ')}`);
}

async function verifyCallContextSnapshotsTable(db) {
    if (!db || typeof db.query !== 'function') {
        throw new Error('DB query interface unavailable');
    }

    const rows = await db.query(CALL_CONTEXT_TABLE_CHECK_SQL);
    return Array.isArray(rows) && rows.length > 0;
}

async function assertClusterBootSafe({ env = process.env, db, logger = console } = {}) {
    if (!isClusterMode(env)) {
        return evaluateClusterBootGuard({ env, durableContextAvailable: false });
    }

    const envError = assertDbEnvForCluster(env);
    if (envError) {
        const decision = evaluateClusterBootGuard({ env, durableContextError: envError });
        throw new Error(decision.message);
    }

    let durableContextAvailable = false;
    try {
        durableContextAvailable = await verifyCallContextSnapshotsTable(db);
    } catch (err) {
        const decision = evaluateClusterBootGuard({ env, durableContextError: err });
        throw new Error(decision.message);
    }

    const decision = evaluateClusterBootGuard({ env, durableContextAvailable });
    if (!decision.ok) {
        throw new Error(decision.message);
    }
    return decision;
}

function getDeploymentGuardWarnings(env = process.env) {
    return evaluateClusterBootGuard({ env, durableContextAvailable: false }).warnings;
}

function emitWarnings(warnings, logger = console) {
    for (const warning of warnings) {
        if (logger && typeof logger.warn === 'function') {
            logger.warn(`[DeploymentGuard] ${warning}`);
        }
    }
    return warnings;
}

function emitDeploymentGuardWarnings(env = process.env, logger = console) {
    const warnings = getDeploymentGuardWarnings(env);
    return emitWarnings(warnings, logger);
}

module.exports = {
    CALL_CONTEXT_TABLE_CHECK_SQL,
    assertClusterBootSafe,
    emitDeploymentGuardWarnings,
    evaluateClusterBootGuard,
    getDeploymentGuardWarnings,
    isClusterMode,
    isTruthy,
    readWorkerCount,
    verifyCallContextSnapshotsTable
};
