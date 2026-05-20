#!/usr/bin/env node
/**
 * DIFF SIZE GUARD (HARDENED v2)
 *
 * Improvements:
 *  - Dynamic base branch detection (supports CI + local)
 *  - Handles binary diffs safely
 *  - Fails if diff cannot be computed (no silent skip)
 *  - Supports GitHub Actions base ref
 *  - Still stabilization-friendly
 *
 * Allows override via commit message tag: [diff-override]
 */

const { execSync } = require('child_process');

const MAX_TOTAL_LINES = 800;
const MAX_LINES_PER_FILE = 400;
const MAX_FILES_CHANGED = 25;

function fail(msg) {
  console.error(`❌ Diff Guard Violation: ${msg}`);
  process.exit(1);
}

function getCommitMessage() {
  try {
    return execSync('git log -1 --pretty=%B').toString();
  } catch {
    return '';
  }
}

function resolveBaseRef() {
  // GitHub Actions
  if (process.env.GITHUB_BASE_REF) {
    return `origin/${process.env.GITHUB_BASE_REF}`;
  }

  // Fallback to origin/main if exists
  try {
    execSync('git show-ref --verify --quiet refs/remotes/origin/main');
    return 'origin/main';
  } catch {}

  // Fallback to origin/master if exists
  try {
    execSync('git show-ref --verify --quiet refs/remotes/origin/master');
    return 'origin/master';
  } catch {}

  // Fallback to main
  try {
    execSync('git show-ref --verify --quiet refs/heads/main');
    return 'main';
  } catch {}

  // Fallback to local master
  try {
    execSync('git show-ref --verify --quiet refs/heads/master');
    return 'master';
  } catch {}

  fail('Unable to resolve base branch for diff comparison.');
}

function getDiffStats(baseRef) {
  try {
    const raw = execSync(`git diff --numstat ${baseRef}...HEAD`)
      .toString()
      .trim();

    if (!raw) return [];

    return raw
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const [added, removed, file] = line.split('\t');

        // Handle binary diffs (“-”)
        const safeAdded = isNaN(parseInt(added, 10)) ? 0 : parseInt(added, 10);
        const safeRemoved = isNaN(parseInt(removed, 10)) ? 0 : parseInt(removed, 10);

        return {
          file,
          added: safeAdded,
          removed: safeRemoved,
          total: safeAdded + safeRemoved
        };
      });
  } catch (e) {
    fail('Unable to compute git diff. Ensure fetch-depth is sufficient in CI.');
  }
}

function run() {
  const commitMessage = getCommitMessage();

  if (commitMessage.includes('[diff-override]')) {
    console.log('⚠️ Diff guard overridden via commit tag.');
    process.exit(0);
  }

  const baseRef = resolveBaseRef();
  const stats = getDiffStats(baseRef);

  if (!stats.length) {
    console.log('✔ No diff detected.');
    process.exit(0);
  }

  const totalLines = stats.reduce((sum, f) => sum + f.total, 0);
  const filesChanged = stats.length;

  console.log('📊 Diff Summary:');
  console.log(`   Base ref: ${baseRef}`);
  console.log(`   Files changed: ${filesChanged}`);
  console.log(`   Total lines changed: ${totalLines}`);

  if (filesChanged > MAX_FILES_CHANGED) {
    fail(`Too many files changed (${filesChanged}). Limit is ${MAX_FILES_CHANGED}.`);
  }

  if (totalLines > MAX_TOTAL_LINES) {
    fail(`Total diff too large (${totalLines} lines). Limit is ${MAX_TOTAL_LINES}.`);
  }

  for (const f of stats) {
    if (f.total > MAX_LINES_PER_FILE) {
      fail(`File "${f.file}" changed ${f.total} lines. Limit per file is ${MAX_LINES_PER_FILE}.`);
    }
  }

  console.log('✔ Diff guard passed (hardened v2).');
  process.exit(0);
}

run();