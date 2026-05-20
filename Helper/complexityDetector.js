'use strict';

/**
 * Detects question complexity to dynamically expand word limits.
 * Pure function — no I/O, no side effects.
 */

const TECHNICAL_KEYWORDS = [
    'architecture', 'integration', 'infrastructure', 'implementation', 'migration',
    'scalability', 'microservice', 'api', 'database', 'deployment', 'devops',
    'kubernetes', 'docker', 'cloud', 'security', 'compliance',
    'sap', 's/4hana', 'erp', 'fiori', 'abap', 'hana',
    'how does', 'how do', 'what is the difference', 'compare'
];

const DETAIL_REQUESTS = [
    'explain in detail', 'tell me more', 'elaborate', 'can you expand',
    'go deeper', 'more detail', 'in depth', 'walk me through'
];

/**
 * @param {string} userQuestion
 * @returns {{ isComplex: boolean, reason: string|null }}
 */
function detectComplexity(userQuestion) {
    if (!userQuestion) return { isComplex: false, reason: null };
    const lower = userQuestion.toLowerCase();
    const wordCount = userQuestion.split(/\s+/).length;
    const questionMarks = (userQuestion.match(/\?/g) || []).length;

    if (questionMarks >= 2) return { isComplex: true, reason: 'multiple_questions' };
    if (wordCount > 30) return { isComplex: true, reason: 'long_question' };
    if (DETAIL_REQUESTS.some(d => lower.includes(d))) return { isComplex: true, reason: 'detail_request' };
    if (TECHNICAL_KEYWORDS.some(k => lower.includes(k))) return { isComplex: true, reason: 'technical' };

    return { isComplex: false, reason: null };
}

module.exports = { detectComplexity };
