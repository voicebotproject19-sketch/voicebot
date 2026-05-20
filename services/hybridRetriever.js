/**
 * Hybrid Retriever
 * Combines semantic search (embeddings) with keyword matching
 * Based on final-implementation-plan.md
 */

const crypto = require('crypto');

class HybridRetriever {
    /**
     * Constructor
     * @param {Object} config - Configuration object
     * @param {Object} config.knowledgeBase - Knowledge base instance
     * @param {Object} config.embeddingsClient - Embeddings client (optional)
     */
    constructor(config) {
        this.config = config;
        this.knowledgeBase = config.knowledgeBase;
        this.embeddingsClient = config.embeddingsClient;
        this.embeddingCache = new Map();
    }
    
    /**
     * Retrieve documents using hybrid search
     * @param {string} query - Query text
     * @param {Object} options - Retrieval options
     * @returns {Promise<Array>} - Retrieved documents with scores
     */
    async retrieve(query, options = {}) {
        const {
            topK = 3,
            semanticWeight = 0.5,
            keywordWeight = 0.5,
            exactWeight = 0
        } = options;
        
        // Normalize weights
        const totalWeight = semanticWeight + keywordWeight + exactWeight;
        const normSemantic = semanticWeight / totalWeight;
        const normKeyword = keywordWeight / totalWeight;
        const normExact = exactWeight / totalWeight;
        
        // Get keyword-based results
        const keywordResults = this.keywordSearch(query);
        
        // Get semantic-based results (if embeddings client available)
        let semanticResults = [];
        if (this.embeddingsClient) {
            semanticResults = await this.semanticSearch(query);
        }
        
        // Combine and score results
        const combinedScores = new Map();
        
        // Add keyword scores
        keywordResults.forEach(result => {
            const score = result.relevanceScore * normKeyword;
            combinedScores.set(result.id, {
                ...result,
                keywordScore: result.relevanceScore,
                semanticScore: 0,
                exactScore: 0,
                combinedScore: score
            });
        });
        
        // Add semantic scores
        semanticResults.forEach(result => {
            if (combinedScores.has(result.id)) {
                const existing = combinedScores.get(result.id);
                existing.semanticScore = result.score;
                existing.combinedScore += result.score * normSemantic;
            } else {
                const score = result.score * normSemantic;
                combinedScores.set(result.id, {
                    ...result,
                    keywordScore: 0,
                    semanticScore: result.score,
                    exactScore: 0,
                    combinedScore: score
                });
            }
        });
        
        // Add exact match bonus
        const exactMatches = this.findExactMatches(query);
        exactMatches.forEach(id => {
            if (combinedScores.has(id)) {
                const existing = combinedScores.get(id);
                existing.exactScore = 1.0;
                existing.combinedScore += 1.0 * normExact;
            }
        });
        
        // Sort by combined score and return top K
        const results = Array.from(combinedScores.values())
            .sort((a, b) => b.combinedScore - a.combinedScore)
            .slice(0, topK);
        
        return results;
    }
    
    /**
     * Keyword-based search
     * @param {string} query - Query text
     * @returns {Array} - Results with relevance scores
     */
    keywordSearch(query) {
        const queryLower = query.toLowerCase();
        const results = [];
        
        // Get all documents from knowledge base
        const docs = this.getAllDocuments();
        
        docs.forEach(doc => {
            let score = 0;
            
            // Keyword matching
            doc.keywords.forEach(keyword => {
                if (queryLower.includes(keyword.toLowerCase())) {
                    score += 3;
                }
            });
            
            // Boost based on priority
            score = score * (4 - doc.priority);
            
            // Category name matching
            if (queryLower.includes(doc.category.toLowerCase())) {
                score += 5;
            }
            
            // Content word matching
            const queryWords = queryLower.split(' ').filter(word => word.length > 3);
            const contentWords = doc.content.toLowerCase().split(' ');
            const commonWords = queryWords.filter(word => contentWords.includes(word));
            score += commonWords.length * 0.5;
            
            if (score > 0) {
                results.push({
                    id: doc.id,
                    content: doc.content,
                    category: doc.category,
                    keywords: doc.keywords,
                    priority: doc.priority,
                    relevanceScore: score
                });
            }
        });
        
        return results.sort((a, b) => b.relevanceScore - a.relevanceScore);
    }
    
    /**
     * Semantic search using embeddings
     * @param {string} query - Query text
     * @returns {Promise<Array>} - Results with semantic scores
     */
    async semanticSearch(query) {
        if (!this.embeddingsClient) {
            return [];
        }
        
        try {
            // Get query embedding
            const queryEmbedding = await this.getEmbedding(query);
            
            // Get all documents
            const docs = this.getAllDocuments();
            
            // Calculate similarity for each document
            const results = [];
            for (const doc of docs) {
                const docEmbedding = await this.getEmbedding(doc.content);
                const similarity = this.cosineSimilarity(queryEmbedding, docEmbedding);
                
                results.push({
                    id: doc.id,
                    content: doc.content,
                    category: doc.category,
                    keywords: doc.keywords,
                    priority: doc.priority,
                    score: similarity
                });
            }
            
            return results.sort((a, b) => b.score - a.score);
        } catch (error) {
            console.warn('[HybridRetriever] Semantic search failed:', error.message);
            return [];
        }
    }
    
    /**
     * Find exact matches in query
     * @param {string} query - Query text
     * @returns {Array} - Array of document IDs with exact matches
     */
    findExactMatches(query) {
        const queryLower = query.toLowerCase();
        const exactMatches = [];
        
        const docs = this.getAllDocuments();
        docs.forEach(doc => {
            // Check for exact phrase matches
            if (doc.content.toLowerCase().includes(queryLower)) {
                exactMatches.push(doc.id);
            }
        });
        
        return exactMatches;
    }
    
    /**
     * Get embedding for text (with caching)
     * @param {string} text - Text to embed
     * @returns {Promise<Array>} - Embedding vector
     */
    async getEmbedding(text) {
        // Check cache
        const cacheKey = crypto.createHash('sha256').update(String(text)).digest('hex');
        if (this.embeddingCache.has(cacheKey)) {
            return this.embeddingCache.get(cacheKey);
        }
        
        // Generate embedding
        const embedding = await this.embeddingsClient.embed(text);
        
        // Cache result
        this.embeddingCache.set(cacheKey, embedding);
        
        return embedding;
    }
    
    /**
     * Calculate cosine similarity between two vectors
     * @param {Array} vec1 - First vector
     * @param {Array} vec2 - Second vector
     * @returns {number} - Cosine similarity
     */
    cosineSimilarity(vec1, vec2) {
        if (vec1.length !== vec2.length) {
            return 0;
        }
        
        let dotProduct = 0;
        let norm1 = 0;
        let norm2 = 0;
        
        for (let i = 0; i < vec1.length; i++) {
            dotProduct += vec1[i] * vec2[i];
            norm1 += vec1[i] * vec1[i];
            norm2 += vec2[i] * vec2[i];
        }
        
        if (norm1 === 0 || norm2 === 0) {
            return 0;
        }
        
        return dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2));
    }
    
    /**
     * Get all documents from knowledge base
     * @returns {Array} - Array of documents
     */
    getAllDocuments() {
        if (!this.knowledgeBase) return [];

        // Support common knowledge base document-collection shapes.
        if (typeof this.knowledgeBase.getAllDocuments === 'function') {
            return this.knowledgeBase.getAllDocuments();
        }
        if (Array.isArray(this.knowledgeBase.documents)) {
            return this.knowledgeBase.documents;
        }
        if (typeof this.knowledgeBase.getAll === 'function') {
            return this.knowledgeBase.getAll();
        }
        // Fallback: if the knowledge base is an array itself, return it directly.
        if (Array.isArray(this.knowledgeBase)) {
            return this.knowledgeBase;
        }
        return [];
    }
    
    /**
     * Clear embedding cache
     */
    clearCache() {
        this.embeddingCache.clear();
    }
}

module.exports = HybridRetriever;
