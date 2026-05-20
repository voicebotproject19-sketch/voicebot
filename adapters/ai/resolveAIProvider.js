'use strict';

/**
 * resolveAIProvider — factory that returns the correct AI adapter class
 * based on the provider name.
 *
 * Usage:
 *   const { resolveAIProvider } = require('./adapters/ai/resolveAIProvider');
 *   const AIAdapterClass = resolveAIProvider(process.env.AI_PROVIDER);
 */

const AzureRealtimeAdapter  = require('./AzureRealtimeAdapter');
const OpenAIRealtimeAdapter = require('./OpenAIRealtimeAdapter');

const PROVIDERS = {
    'azure-realtime': AzureRealtimeAdapter,
    'openai-realtime': OpenAIRealtimeAdapter,
};

/**
 * @param {string} providerName — 'azure-realtime' (default) or 'openai-realtime'
 * @returns {typeof import('./BaseRealtimeAdapter')} The adapter class (not an instance)
 */
function resolveAIProvider(providerName) {
    const name = (providerName || 'azure-realtime').toLowerCase().trim();
    const AdapterClass = PROVIDERS[name];
    if (!AdapterClass) {
        throw new Error(
            `Unknown AI provider: "${providerName}". ` +
            `Valid providers: ${Object.keys(PROVIDERS).join(', ')}`
        );
    }
    return AdapterClass;
}

module.exports = { resolveAIProvider, PROVIDERS };
