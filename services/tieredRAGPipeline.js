/**
 * @deprecated Sprint 6C (F7): Dead code — zero non-test production imports.
 * conversationEngine.js handles RAG pipeline orchestration directly.
 *
 * Tiered RAG Pipeline
 * Integrates complexity detection, multi-intent handling, ambiguity resolution,
 * and tiered latency processing
 * Based on final-implementation-plan.md
 */

const { EventEmitter } = require('events');
const QueryComplexityDetector = require('./queryComplexityDetector');
const MultiIntentDetector = require('./multiIntentDetector');
const AmbiguityResolver = require('./ambiguityResolver');
const { getConfigForComplexity } = require('../config/tieredLatencyConfig');
const telemetry = require('../Utils/telemetry');

class TieredRAGPipeline extends EventEmitter {
    /**
     * Constructor
     * @param {Object} config - Configuration object
     * @param {Object} config.knowledgeBase - Knowledge base instance (English/German)
     * @param {Object} config.cache - Cache instance (optional)
     * @param {string} config.botLang - Bot language ('english' or 'german')
     * @param {string} config.callType - Call type ('event' or 'sales')
     */
    constructor(config) {
        super();
        this.config = config;
        
        // Initialize components
        this.complexityDetector = new QueryComplexityDetector();
        this.multiIntentDetector = new MultiIntentDetector();
        this.ambiguityResolver = new AmbiguityResolver(config.cache);
        
        // Get appropriate knowledge base
        this.knowledgeBase = config.botLang === 'german' 
            ? config.knowledgeBase.german 
            : config.knowledgeBase.english;
        
        this.isProcessing = false;
        this.pendingInputs = [];
        this.conversationHistory = [];
    }
    
    /**
     * Process user input through the tiered RAG pipeline
     * @param {string} input - User input text
     * @returns {Promise<Object>} - Processing result
     */
    async processInput(input) {
        if (this.isProcessing) {
            return new Promise((resolve) => {
                this.pendingInputs.push({ input, resolve });
            });
        }

        this.isProcessing = true;
        const result = await this._processInputInternal(input);
        this.isProcessing = false;

        while (this.pendingInputs.length > 0) {
            const next = this.pendingInputs.shift();
            this.isProcessing = true;
            const queuedResult = await this._processInputInternal(next.input);
            this.isProcessing = false;
            next.resolve(queuedResult);
        }

        return result;
    }

    async _processInputInternal(input) {
        const startTime = Date.now();
        
        try {
            // Add to conversation history
            this.addToHistory({ role: 'user', content: input, type: 'query' });
            
            // Detect query complexity
            const complexity = this.complexityDetector.detect(input);
            console.log(`[TieredRAG] Query complexity: ${complexity}`);
            
            telemetry.emit('query_complexity_detected', {
                complexity,
                inputLength: input.length,
                timestamp: Date.now()
            });
            
            // Get tiered configuration
            const tierConfig = getConfigForComplexity(complexity);
            
            // Handle edge cases - ambiguity
            const ambiguityResult = await this.ambiguityResolver.resolve(
                input,
                this.conversationHistory
            );
            
            if (ambiguityResult) {
                console.log('[TieredRAG] Ambiguity detected, asking clarification');
                telemetry.emit('ambiguity_resolved', {
                    query: input,
                    clarification: ambiguityResult.content,
                    timestamp: Date.now()
                });
                
                this.addToHistory({ 
                    role: 'assistant', 
                    content: ambiguityResult.content, 
                    type: 'clarification' 
                });
                
                const totalLatency = Date.now() - startTime;
                return {
                    status: 'clarification_needed',
                    response: ambiguityResult.content,
                    complexity,
                    latency: totalLatency,
                    targetLatency: tierConfig.targetLatency
                };
            }
            
            // Handle edge cases - multi-intent
            const multiIntentResult = this.multiIntentDetector.detect(input);
            if (multiIntentResult.hasMultipleIntents) {
                console.log('[TieredRAG] Multiple intents detected');
                telemetry.emit('multi_intent_detected', {
                    query: input,
                    parts: multiIntentResult.parts,
                    timestamp: Date.now()
                });
                
                const response = await this.handleMultipleIntents(
                    multiIntentResult.parts, 
                    tierConfig
                );
                
                const totalLatency = Date.now() - startTime;
                return {
                    status: 'success',
                    response,
                    complexity,
                    latency: totalLatency,
                    targetLatency: tierConfig.targetLatency,
                    hadMultipleIntents: true
                };
            }
            
            // Process single-intent query
            const response = await this.processQuery(input, tierConfig);
            
            const totalLatency = Date.now() - startTime;
            console.log(`[TieredRAG] Total latency: ${totalLatency}ms (target: ${tierConfig.targetLatency}ms)`);
            
            telemetry.emit('rag_latency', {
                complexity,
                total: totalLatency,
                target: tierConfig.targetLatency,
                timestamp: Date.now()
            });
            
            return {
                status: 'success',
                response,
                complexity,
                latency: totalLatency,
                targetLatency: tierConfig.targetLatency
            };
            
        } catch (error) {
            console.error('[TieredRAG] Error processing input:', error);
            telemetry.emit('rag_error', {
                error: error.message,
                input,
                timestamp: Date.now()
            });
            
            return {
                status: 'error',
                error: error.message
            };
        }
    }
    
    /**
     * Handle multiple intents in a single query
     * @param {string[]} parts - Array of query parts
     * @param {Object} tierConfig - Tiered configuration
     * @returns {Promise<string>} - Combined response
     */
    async handleMultipleIntents(parts, tierConfig) {
        const responses = [];
        
        for (const part of parts) {
            const response = await this.processQuery(part, tierConfig);
            responses.push(response);
        }
        
        // Combine responses
        const combined = responses.join(' ');
        
        this.addToHistory({ 
            role: 'assistant', 
            content: combined, 
            type: 'response' 
        });
        
        return combined;
    }
    
    /**
     * Process a single query
     * @param {string} query - Query text
     * @param {Object} tierConfig - Tiered configuration
     * @returns {Promise<string>} - Generated response
     */
    async processQuery(query, tierConfig) {
        const startTime = Date.now();
        
        // Step 1: Retrieve documents from knowledge base
        const retrievalStart = Date.now();
        const docs = this.knowledgeBase.retrieveRelevantInfo(
            query, 
            tierConfig.maxDocs
        );
        const retrievalLatency = Date.now() - retrievalStart;
        
        console.log(`[TieredRAG] Retrieval latency: ${retrievalLatency}ms`);
        
        // Step 2: Build prompt with context
        const context = this.getRecentContext();
        const prompt = this.buildPrompt(query, docs, context);
        
        // Step 3: Generate response (delegated to LLM service)
        // Note: In a full implementation, this would call an LLM service
        // For now, we'll use a simple approach that returns the retrieved docs
        const response = this.generateResponse(query, docs, tierConfig);
        
        const generationLatency = Date.now() - startTime - retrievalLatency;
        console.log(`[TieredRAG] Generation latency: ${generationLatency}ms`);
        
        // Step 4: Update conversation history
        this.addToHistory({ 
            role: 'assistant', 
            content: response, 
            type: 'response' 
        });
        
        return response;
    }
    
    /**
     * Build prompt for LLM
     * @param {string} query - Query text
     * @param {string} docs - Retrieved documents
     * @param {Array} context - Recent conversation context
     * @returns {string} - Built prompt
     */
    buildPrompt(query, docs, context) {
        let prompt = `CONTEXT (use this information to answer):\n${docs}\n\n`;
        prompt += `USER QUESTION: "${query}"\n\n`;
        
        // Add context from conversation history
        if (context.length > 0) {
            const recentContext = context.slice(-3).map(m => 
                `${m.role}: ${m.content}`
            ).join('\n');
            prompt += `RECENT CONVERSATION:\n${recentContext}\n\n`;
        }
        
        prompt += `Provide a concise response that directly answers the question using the context above.`;
        
        return prompt;
    }
    
    /**
     * Generate response from retrieved documents
     * @param {string} query - Query text
     * @param {string} docs - Retrieved documents
     * @param {Object} tierConfig - Tiered configuration
     * @returns {string} - Generated response
     */
    generateResponse(query, docs, tierConfig) {
        // Simple response generation based on retrieved docs
        // In a full implementation, this would call an LLM
        
        if (!docs || docs.length === 0) {
            return "I don't have specific information about that. Could you please provide more details?";
        }
        
        // Extract relevant content from docs
        const lines = docs.split('\n').filter(line => line.trim().length > 0);
        const contentLines = lines.filter(line => !line.startsWith('**'));
        
        // Sprint 4.10: LLM synthesis — rerank and compress retrieved docs
        // When enabled, prepend a synthesis instruction for the model to follow
        const synthesisEnabled = process.env.RAG_SYNTHESIS_ENABLED === 'true';
        if (synthesisEnabled && contentLines.length > 1) {
            // Deduplicate near-identical retrieved chunks (simple prefix match)
            const unique = [];
            const seen = new Set();
            for (const line of contentLines) {
                const prefix = line.substring(0, 80).toLowerCase();
                if (!seen.has(prefix)) {
                    seen.add(prefix);
                    unique.push(line);
                }
            }
            // Take top N most relevant (already sorted by retriever)
            const topN = Number(process.env.RAG_SYNTHESIS_TOP_N) || 3;
            const selected = unique.slice(0, topN);
            return `[SYNTHESIZE] Based on these knowledge base excerpts, provide a concise answer:\n${selected.join('\n')}`;
        }

        // Limit response length based on tier config
        let response = contentLines.join(' ').trim();
        const maxChars = tierConfig.maxTokens * 4; // Approximate chars per token
        
        if (response.length > maxChars) {
            response = response.substring(0, maxChars) + '...';
        }
        
        return response;
    }
    
    /**
     * Get recent conversation context
     * @returns {Array} - Recent messages
     */
    getRecentContext() {
        return this.conversationHistory.slice(-5);
    }
    
    /**
     * Add message to conversation history
     * @param {Object} message - Message object
     */
    addToHistory(message) {
        this.conversationHistory.push({
            ...message,
            timestamp: Date.now()
        });
        
        // Trim history if too large
        if (this.conversationHistory.length > 50) {
            this.conversationHistory = this.conversationHistory.slice(-50);
        }
    }
    
    /**
     * Reset conversation history
     */
    resetHistory() {
        this.conversationHistory = [];
    }
    
    /**
     * Get pipeline statistics
     * @returns {Object} - Statistics
     */
    getStats() {
        return {
            isProcessing: this.isProcessing,
            historyLength: this.conversationHistory.length,
            config: this.config
        };
    }
}

module.exports = TieredRAGPipeline;
