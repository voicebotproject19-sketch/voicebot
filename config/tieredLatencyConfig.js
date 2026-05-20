/**
 * Tiered Latency Configuration
 * Configuration for simple/medium/complex query processing paths
 * Based on final-implementation-plan.md
 */

const tieredConfig = Object.freeze({
    simple: {
        maxTokens: 50,
        maxDocs: 2,
        semanticWeight: 0.8,
        keywordWeight: 0.2,
        rerank: false,
        temperature: 0.6,
        targetLatency: 300,
        sttEarlyFinalization: true,
        ttsStreaming: true
    },
    medium: {
        maxTokens: 100,
        maxDocs: 3,
        semanticWeight: 0.6,
        keywordWeight: 0.4,
        rerank: false,
        temperature: 0.8,
        targetLatency: 500,
        sttEarlyFinalization: true,
        ttsStreaming: true
    },
    complex: {
        maxTokens: 200,
        maxDocs: 5,
        semanticWeight: 0.5,
        keywordWeight: 0.3,
        exactWeight: 0.2,
        rerank: true,
        temperature: 1.0,
        targetLatency: 1000,
        sttEarlyFinalization: false,
        ttsStreaming: true
    }
});

/**
 * Get tiered configuration from environment variables or defaults
 * @returns {Object} - Tiered configuration object
 */
function getTieredConfig() {
    return {
        simple: {
            maxTokens: parseInt(process.env.TIERED_SIMPLE_MAX_TOKENS) || tieredConfig.simple.maxTokens,
            maxDocs: parseInt(process.env.TIERED_SIMPLE_MAX_DOCS) || tieredConfig.simple.maxDocs,
            semanticWeight: parseFloat(process.env.TIERED_SIMPLE_SEMANTIC_WEIGHT) || tieredConfig.simple.semanticWeight,
            keywordWeight: parseFloat(process.env.TIERED_SIMPLE_KEYWORD_WEIGHT) || tieredConfig.simple.keywordWeight,
            rerank: process.env.TIERED_SIMPLE_RERANK === 'true',
            temperature: parseFloat(process.env.TIERED_SIMPLE_TEMPERATURE) || tieredConfig.simple.temperature,
            targetLatency: parseInt(process.env.TIERED_SIMPLE_TARGET_LATENCY) || tieredConfig.simple.targetLatency,
            sttEarlyFinalization: process.env.TIERED_SIMPLE_STT_EARLY_FINALIZATION !== 'false',
            ttsStreaming: process.env.TIERED_SIMPLE_TTS_STREAMING !== 'false'
        },
        medium: {
            maxTokens: parseInt(process.env.TIERED_MEDIUM_MAX_TOKENS) || tieredConfig.medium.maxTokens,
            maxDocs: parseInt(process.env.TIERED_MEDIUM_MAX_DOCS) || tieredConfig.medium.maxDocs,
            semanticWeight: parseFloat(process.env.TIERED_MEDIUM_SEMANTIC_WEIGHT) || tieredConfig.medium.semanticWeight,
            keywordWeight: parseFloat(process.env.TIERED_MEDIUM_KEYWORD_WEIGHT) || tieredConfig.medium.keywordWeight,
            rerank: process.env.TIERED_MEDIUM_RERANK === 'true',
            temperature: parseFloat(process.env.TIERED_MEDIUM_TEMPERATURE) || tieredConfig.medium.temperature,
            targetLatency: parseInt(process.env.TIERED_MEDIUM_TARGET_LATENCY) || tieredConfig.medium.targetLatency,
            sttEarlyFinalization: process.env.TIERED_MEDIUM_STT_EARLY_FINALIZATION !== 'false',
            ttsStreaming: process.env.TIERED_MEDIUM_TTS_STREAMING !== 'false'
        },
        complex: {
            maxTokens: parseInt(process.env.TIERED_COMPLEX_MAX_TOKENS) || tieredConfig.complex.maxTokens,
            maxDocs: parseInt(process.env.TIERED_COMPLEX_MAX_DOCS) || tieredConfig.complex.maxDocs,
            semanticWeight: parseFloat(process.env.TIERED_COMPLEX_SEMANTIC_WEIGHT) || tieredConfig.complex.semanticWeight,
            keywordWeight: parseFloat(process.env.TIERED_COMPLEX_KEYWORD_WEIGHT) || tieredConfig.complex.keywordWeight,
            exactWeight: parseFloat(process.env.TIERED_COMPLEX_EXACT_WEIGHT) || tieredConfig.complex.exactWeight,
            rerank: process.env.TIERED_COMPLEX_RERANK !== 'false',
            temperature: parseFloat(process.env.TIERED_COMPLEX_TEMPERATURE) || tieredConfig.complex.temperature,
            targetLatency: parseInt(process.env.TIERED_COMPLEX_TARGET_LATENCY) || tieredConfig.complex.targetLatency,
            sttEarlyFinalization: process.env.TIERED_COMPLEX_STT_EARLY_FINALIZATION === 'true',
            ttsStreaming: process.env.TIERED_COMPLEX_TTS_STREAMING !== 'false'
        }
    };
}

/**
 * Get configuration for a specific complexity level
 * @param {string} complexity - 'simple', 'medium', or 'complex'
 * @returns {Object} - Configuration for the specified complexity level
 */
function getConfigForComplexity(complexity) {
    const config = getTieredConfig();
    return config[complexity] || config.simple;
}

module.exports = {
    tieredConfig,
    getTieredConfig,
    getConfigForComplexity
};
