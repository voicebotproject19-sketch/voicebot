/**
 * Multi-Intent Detector
 * Detects and splits queries with multiple intents
 * Based on final-implementation-plan.md
 */

class MultiIntentDetector {
    /**
     * Detect if query has multiple intents
     * @param {string} query - User query text
     * @returns {Object} - Detection result with parts if multiple intents found
     */
    detect(query) {
        const patterns = [
            / and .* \?/i,
            / also .* \?/i,
            / what about/i,
            / how about/i,
            / tell me .* and /i,
            /\?.*\?/i  // Multiple question marks
        ];
        
        const hasMultipleIntents = patterns.some(pattern => pattern.test(query));
        
        if (hasMultipleIntents) {
            return {
                hasMultipleIntents: true,
                parts: this.splitQuery(query)
            };
        }
        
        return { hasMultipleIntents: false };
    }
    
    /**
     * Split query into separate intent parts
     * @param {string} query - User query text
     * @returns {string[]} - Array of query parts
     */
    splitQuery(query) {
        // Split on common separators
        const separators = [' and ', ' also ', ' what about ', ' how about '];
        let parts = [query];
        
        for (const sep of separators) {
            parts = parts.flatMap(part => part.split(sep));
        }
        
        return parts
            .map(p => p.trim())
            .filter(p => p.length > 0);
    }
    
    /**
     * Get detailed multi-intent analysis
     * @param {string} query - User query text
     * @returns {Object} - Detailed analysis
     */
    analyze(query) {
        const detection = this.detect(query);
        
        return {
            ...detection,
            queryLength: query.length,
            questionCount: query.split('?').length - 1,
            hasConjunctions: query.includes(' and ') || query.includes(' or '),
            hasAlso: / also /i.test(query),
            hasWhatAbout: / what about/i.test(query),
            hasHowAbout: / how about/i.test(query)
        };
    }
}

module.exports = MultiIntentDetector;
