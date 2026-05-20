'use strict';

const DEFAULT_PRODUCTION_ORIGINS = Object.freeze([
    'https://voicebot.eastus2.cloudapp.azure.com'
]);
const DEFAULT_DEVELOPMENT_ORIGINS = Object.freeze([
    'http://localhost:4000'
]);

function splitCsv(value) {
    return String(value || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
}

function parseHttpOrigin(rawOrigin) {
    const value = String(rawOrigin || '').trim();
    if (!value) return { origin: null, warning: null };

    let parsed;
    try {
        parsed = new URL(value);
    } catch (_) {
        return { origin: null, warning: `Ignoring invalid CORS origin "${value}".` };
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
        return { origin: null, warning: `Ignoring non-HTTP CORS origin "${value}".` };
    }

    const hasPath = parsed.pathname && parsed.pathname !== '/';
    if (hasPath || parsed.search || parsed.hash) {
        return {
            origin: null,
            warning: `Ignoring CORS origin "${value}" because origins cannot include paths, query strings, or fragments. Use "${parsed.origin}" instead.`
        };
    }

    return { origin: parsed.origin, warning: null };
}

function createOriginList(rawOrigins, { includeDevelopmentDefaults = false } = {}) {
    const warnings = [];
    const origins = [];
    const seen = new Set();

    function add(rawOrigin) {
        const { origin, warning } = parseHttpOrigin(rawOrigin);
        if (warning) warnings.push(warning);
        if (!origin) return;
        if (seen.has(origin)) return;
        seen.add(origin);
        origins.push(origin);
    }

    for (const rawOrigin of rawOrigins) add(rawOrigin);
    if (includeDevelopmentDefaults) {
        for (const rawOrigin of DEFAULT_DEVELOPMENT_ORIGINS) add(rawOrigin);
    }

    return { origins, warnings };
}

function resolveHttpSecurityConfig(env = process.env, logger = console) {
    const explicitOrigins = splitCsv(env.CORS_ALLOWED_ORIGINS);
    const rawOrigins = explicitOrigins.length > 0 ? explicitOrigins : DEFAULT_PRODUCTION_ORIGINS;
    const includeDevelopmentDefaults = env.NODE_ENV !== 'production';
    const { origins, warnings } = createOriginList(rawOrigins, { includeDevelopmentDefaults });

    for (const warning of warnings) {
        if (logger && typeof logger.warn === 'function') {
            logger.warn(`[HTTP Security] ${warning}`);
        }
    }

    if (origins.length === 0 && logger && typeof logger.warn === 'function') {
        logger.warn('[HTTP Security] No valid CORS origins configured; browser cross-origin requests will be rejected.');
    }

    return {
        corsAllowedOrigins: origins,
        cspConnectSrc: ["'self'", ...origins]
    };
}

module.exports = {
    DEFAULT_DEVELOPMENT_ORIGINS,
    DEFAULT_PRODUCTION_ORIGINS,
    createOriginList,
    parseHttpOrigin,
    resolveHttpSecurityConfig,
    splitCsv
};
