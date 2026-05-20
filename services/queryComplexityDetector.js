/**
 * Query Complexity Detector
 * Determines query complexity (simple/medium/complex) for tiered latency routing
 * Based on final-implementation-plan.md
 */

class QueryComplexityDetector {
    /**
     * Detect query complexity level
     * @param {string} query - User query text
     * @returns {string} - 'simple', 'medium', or 'complex'
     */
    detect(query) {
        const indicators = {
            simple: this.getSimpleIndicators(query),
            medium: this.getMediumIndicators(query),
            complex: this.getComplexIndicators(query)
        };
        
        const simpleScore = indicators.simple.filter(Boolean).length;
        const mediumScore = indicators.medium.filter(Boolean).length;
        const complexScore = indicators.complex.filter(Boolean).length;
        
        // Priority: complex > medium > simple
        if (complexScore >= 2) return 'complex';
        if (mediumScore >= 2) return 'medium';
        if (simpleScore >= 2) return 'simple';
        
        // Default to medium if no clear pattern
        return 'simple';
    }
    
    /**
     * Get simple query indicators
     * @param {string} query - User query text
     * @returns {boolean[]} - Array of indicator matches
     */
    getSimpleIndicators(query) {
        const trimmedQuery = query.trim();
        return [
            trimmedQuery.length < 50,                           // Short query
            trimmedQuery.split('?').length === 1,                  // Single question
            !trimmedQuery.includes(' and ') && !trimmedQuery.includes(' or '), // No conjunctions
            /what|how|who|when|where|why/i.test(trimmedQuery)   // Common WH words
        ];
    }
    
    /**
     * Get medium query indicators
     * @param {string} query - User query text
     * @returns {boolean[]} - Array of indicator matches
     */
    getMediumIndicators(query) {
        const trimmedQuery = query.trim();
        return [
            trimmedQuery.length >= 50 && trimmedQuery.length <= 100,  // Medium length
            trimmedQuery.split('?').length === 2,                       // Two questions
            trimmedQuery.includes(' and ') || trimmedQuery.includes(' or ')    // Has conjunctions
        ];
    }
    
    /**
     * Get complex query indicators
     * @param {string} query - User query text
     * @returns {boolean[]} - Array of indicator matches
     */
    getComplexIndicators(query) {
        const trimmedQuery = query.trim();
        return [
            trimmedQuery.length > 100,                              // Long query
            trimmedQuery.split('?').length > 2,                       // Multiple questions
            trimmedQuery.includes(' if ') || trimmedQuery.includes(' unless '),     // Conditional
            trimmedQuery.includes(' versus ') || trimmedQuery.includes(' compared to '), // Comparison
            trimmedQuery.includes('calculate') || trimmedQuery.includes('how much'), // Calculation
            trimmedQuery.includes('pricing') || trimmedQuery.includes('cost'),     // Pricing query
            trimmedQuery.includes(' and ') && trimmedQuery.includes(' or ')        // Multiple intents
        ];
    }
    
    /**
     * Get detailed complexity analysis
     * @param {string} query - User query text
     * @returns {Object} - Detailed complexity analysis
     */
    analyze(query) {
        const complexity = this.detect(query);
        const indicators = {
            simple: this.getSimpleIndicators(query),
            medium: this.getMediumIndicators(query),
            complex: this.getComplexIndicators(query)
        };
        
        return {
            complexity,
            scores: {
                simple: indicators.simple.filter(Boolean).length,
                medium: indicators.medium.filter(Boolean).length,
                complex: indicators.complex.filter(Boolean).length
            },
            queryLength: query.length,
            questionCount: query.split('?').length - 1,
            hasConjunctions: query.includes(' and ') || query.includes(' or ')
        };
    }
}

module.exports = QueryComplexityDetector;
