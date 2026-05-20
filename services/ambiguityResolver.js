/**
 * @deprecated Sprint 6C (F7): Dead code — only imported by tieredRAGPipeline.js
 * (itself dead). Use policy/ambiguityScoringEngine.js for production ambiguity scoring.
 *
 * Ambiguity Resolver
 * Detects and resolves ambiguous queries
 * Based on final-implementation-plan.md
 */

class AmbiguityResolver {
    /**
     * Constructor
     * @param {Object} cache - Cache instance for storing clarifications
     */
    constructor(cache = null) {
        this.cache = cache;
        this.ambiguityPatterns = [
            /something/i,
            /anything/i,
            /help/i,
            /information/i,
            /details/i
        ];
    }
    
    /**
     * Resolve ambiguity in query
     * @param {string} query - User query text
     * @param {Array} context - Conversation context
     * @returns {Promise<Object|null>} - Clarification object or null if not ambiguous
     */
    async resolve(query, context = []) {
        const ambiguityScore = this.calculateAmbiguity(query);
        
        if (ambiguityScore > 0.7) {
            // Check cache for pre-computed clarifications
            if (this.cache) {
                try {
                    const cached = await this.cache.get(`ambiguity:${query}`);
                    if (cached) {
                        console.log('[AmbiguityResolver] Using cached clarification');
                        return cached;
                    }
                } catch (err) {
                    console.warn('[AmbiguityResolver] Cache lookup failed:', err.message);
                }
            }
            
            // Check if we have time for clarification
            if (this.allowClarification(context)) {
                const clarification = await this.generateClarification(query, context);
                
                // Cache clarification
                if (this.cache) {
                    try {
                        await this.cache.set(`ambiguity:${query}`, clarification, 300000);
                    } catch (err) {
                        console.warn('[AmbiguityResolver] Cache set failed:', err.message);
                    }
                }
                
                return clarification;
            }
        }
        
        // Make best guess - let main pipeline handle it
        return null;
    }
    
    /**
     * Calculate ambiguity score (0-1)
     * @param {string} query - User query text
     * @returns {number} - Ambiguity score
     */
    calculateAmbiguity(query) {
        let score = 0;
        
        // Check for ambiguity patterns
        for (const pattern of this.ambiguityPatterns) {
            if (pattern.test(query)) {
                score += 0.3;
            }
        }
        
        // Check for vague terms
        const vagueTerms = ['it', 'that', 'this', 'they'];
        const hasVagueTerms = vagueTerms.some(term => 
            new RegExp(`\\b${term}\\b`, 'i').test(query)
        );
        
        if (hasVagueTerms) {
            score += 0.2;
        }
        
        // Check for lack of specificity
        const trimmedQuery = query.trim();
        if (trimmedQuery.length < 20 && 
            !trimmedQuery.includes('what') && 
            !trimmedQuery.includes('how')) {
            score += 0.3;
        }
        
        return Math.min(1, score);
    }
    
    /**
     * Check if clarification should be allowed
     * @param {Array} context - Conversation context
     * @returns {boolean} - Whether clarification is allowed
     */
    allowClarification(context) {
        // Allow clarification if not in a complex query
        // and if we haven't asked too many clarifications
        const recentClarifications = context.filter(m => 
            m.type === 'clarification' && 
            Date.now() - m.timestamp < 60000 // Within last minute
        );
        
        return recentClarifications.length < 2;
    }
    
    /**
     * Generate clarification for ambiguous query
     * @param {string} query - User query text
     * @param {Array} context - Conversation context
     * @returns {Promise<Object>} - Clarification object
     */
    async generateClarification(query, context) {
        // Pre-computed clarifications for common ambiguous queries
        const clarifications = {
            'something': 'Could you be more specific about what you need?',
            'help': 'What specific topic would you like help with?',
            'information': 'What type of information are you looking for?',
            'details': 'What specific details do you need?'
        };
        
        const queryLower = query.toLowerCase();
        for (const [key, value] of Object.entries(clarifications)) {
            if (queryLower.includes(key)) {
                return {
                    type: 'clarification',
                    content: value,
                    shouldContinue: false
                };
            }
        }
        
        return {
            type: 'clarification',
            content: 'Could you provide more details about what you need?',
            shouldContinue: false
        };
    }
    
    /**
     * Get detailed ambiguity analysis
     * @param {string} query - User query text
     * @param {Array} context - Conversation context
     * @returns {Promise<Object>} - Detailed analysis
     */
    async analyze(query, context = []) {
        const score = this.calculateAmbiguity(query);
        const canClarify = this.allowClarification(context);
        
        return {
            ambiguityScore: score,
            isAmbiguous: score > 0.7,
            canClarify,
            queryLength: query.length,
            hasVagueTerms: /\b(it|that|this|they)\b/i.test(query),
            hasAmbiguityPatterns: this.ambiguityPatterns.some(p => p.test(query)),
            clarificationAllowed: canClarify
        };
    }
}

module.exports = AmbiguityResolver;
