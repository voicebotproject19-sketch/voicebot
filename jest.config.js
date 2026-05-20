/** @type {import('jest').Config} */
module.exports = {
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  testEnvironment: 'node',
  // Timeout per test (ms)
  testTimeout: 10000,
};
