'use strict';

const {
    parseHttpOrigin,
    resolveHttpSecurityConfig
} = require('../config/httpSecurityConfig');

function captureWarnings() {
    const warnings = [];
    return {
        warnings,
        logger: { warn: (message) => warnings.push(message) }
    };
}

describe('httpSecurityConfig', () => {
    test('production defaults use exact origin without path duplicates', () => {
        const { warnings, logger } = captureWarnings();
        const config = resolveHttpSecurityConfig({ NODE_ENV: 'production' }, logger);

        expect(config.corsAllowedOrigins).toEqual(['https://voicebot.eastus2.cloudapp.azure.com']);
        expect(config.cspConnectSrc).toEqual(["'self'", 'https://voicebot.eastus2.cloudapp.azure.com']);
        expect(warnings).toEqual([]);
    });

    test('development adds localhost once', () => {
        const config = resolveHttpSecurityConfig({ NODE_ENV: 'development' }, null);

        expect(config.corsAllowedOrigins).toEqual([
            'https://voicebot.eastus2.cloudapp.azure.com',
            'http://localhost:4000'
        ]);
    });

    test('env origins reject paths instead of silently widening access', () => {
        const { warnings, logger } = captureWarnings();
        const config = resolveHttpSecurityConfig({
            NODE_ENV: 'production',
            CORS_ALLOWED_ORIGINS: 'https://voicebot.example.com/demobot, https://admin.example.com, https://admin.example.com'
        }, logger);

        expect(config.corsAllowedOrigins).toEqual(['https://admin.example.com']);
        expect(warnings.join('\n')).toContain('origins cannot include paths');
        expect(warnings.join('\n')).toContain('https://voicebot.example.com');
    });

    test('invalid and non-http origins are ignored', () => {
        const { warnings, logger } = captureWarnings();
        const config = resolveHttpSecurityConfig({
            NODE_ENV: 'production',
            CORS_ALLOWED_ORIGINS: 'not-a-url, ftp://files.example.com'
        }, logger);

        expect(config.corsAllowedOrigins).toEqual([]);
        expect(warnings.join('\n')).toContain('Ignoring invalid CORS origin');
        expect(warnings.join('\n')).toContain('Ignoring non-HTTP CORS origin');
        expect(warnings.join('\n')).toContain('No valid CORS origins configured');
    });

    test('parseHttpOrigin accepts only origin-shaped URLs', () => {
        expect(parseHttpOrigin('https://example.com').origin).toBe('https://example.com');
        expect(parseHttpOrigin('https://example.com/').origin).toBe('https://example.com');
        expect(parseHttpOrigin('https://example.com/path').origin).toBeNull();
        expect(parseHttpOrigin('https://example.com?x=1').origin).toBeNull();
    });
});
