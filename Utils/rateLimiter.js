/**
 * Rate Limiter for OpenAI API calls
 * Prevents rate limit exceeded errors by managing concurrent requests and request frequency
 */

class RateLimiter {
    constructor(maxConcurrent = 3, maxPerMinute = 20) {
        this.maxConcurrent = maxConcurrent;
        this.maxPerMinute = maxPerMinute;
        this.activeRequests = 0;
        this.requestTimestamps = [];
        this.queue = [];
    }

    /**
     * Execute a function with rate limiting
     * @param {Function} fn - The async function to execute
     * @returns {Promise<any>} - The result of the function
     */
    async execute(fn) {
        // Wait if too many concurrent requests
        while (this.activeRequests >= this.maxConcurrent) {
            await this.sleep(100);
        }

        // Wait if rate limit exceeded
        const now = Date.now();
        const oneMinuteAgo = now - 60000;
        this.requestTimestamps = this.requestTimestamps.filter(t => t > oneMinuteAgo);

        while (this.requestTimestamps.length >= this.maxPerMinute) {
            console.log(`[RateLimiter] Rate limit approaching (${this.requestTimestamps.length}/${this.maxPerMinute}), waiting...`);
            await this.sleep(1000);
            this.requestTimestamps = this.requestTimestamps.filter(t => Date.now() - t < 60000);
        }

        this.activeRequests++;
        this.requestTimestamps.push(Date.now());

        try {
            return await fn();
        } finally {
            this.activeRequests--;
        }
    }

    /**
     * Get current rate limiter statistics
     * @returns {Object} Statistics about current usage
     */
    getStats() {
        const now = Date.now();
        const oneMinuteAgo = now - 60000;
        const recentRequests = this.requestTimestamps.filter(t => t > oneMinuteAgo);

        return {
            activeRequests: this.activeRequests,
            requestsInLastMinute: recentRequests.length,
            maxConcurrent: this.maxConcurrent,
            maxPerMinute: this.maxPerMinute,
            queueLength: this.queue.length
        };
    }

    /**
     * Sleep for a specified number of milliseconds
     * @param {number} ms - Milliseconds to sleep
     * @returns {Promise<void>}
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// Create singleton instance with default configuration
const defaultRateLimiter = new RateLimiter(
    parseInt(process.env.OPENAI_MAX_CONCURRENT) || 3,
    parseInt(process.env.OPENAI_MAX_PER_MINUTE) || 20
);

module.exports = {
    RateLimiter,
    defaultRateLimiter
};
