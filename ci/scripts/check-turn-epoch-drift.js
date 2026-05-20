const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '../..');
const appPath = path.join(repoRoot, 'app.js');

if (!fs.existsSync(appPath)) {
  console.log('✔ app.js not found, skipping turnEpoch drift check');
  process.exit(0);
}

const code = fs.readFileSync(appPath, 'utf8');

let errors = [];

/* --------------------------------------------------
RULE 1: sendAudioDirect must be guarded by turn/epoch
-------------------------------------------------- */

const emissionMatches = [...code.matchAll(/sendAudioDirect\s*\(/g)];

for (const match of emissionMatches) {

  const idx = match.index;

  // Look ONLY before the emission
  const windowStart = Math.max(0, idx - 700);
  const before = code.slice(windowStart, idx);

  const guarded =
    before.includes('assertTurnActive') ||
    before.includes('scheduledTurn') ||
    before.includes('playbackEpoch') ||
    before.includes('playbackEpochPlivo') ||
    before.includes('myEpoch');

  if (!guarded) {
    errors.push(`Audio emission missing turnEpoch guard near index ${idx}`);
  }
}

/* --------------------------------------------------
RULE 2: turnEpoch must be created
-------------------------------------------------- */

const turnCreatePatterns = [
  'turnState.currentTurnId = uuidv4()',
  'turnState.currentTurnId = uuidv4();'
];

if (!turnCreatePatterns.some(p => code.includes(p))) {
  errors.push('turnEpoch creation missing (turnState.currentTurnId = uuidv4())');
}

/* --------------------------------------------------
RULE 3: turnEpoch must be cleared
-------------------------------------------------- */

if (!code.includes('turnState.currentTurnId = null')) {
  errors.push('turnEpoch reset missing on teardown');
}

/* --------------------------------------------------
RULE 4: edgeSession must mirror turnEpoch
-------------------------------------------------- */

const edgeSyncPatterns = [
  'edgeSession.currentTurnId = turnState.currentTurnId',
  'edgeSession.currentTurnId=turnState.currentTurnId'
];

if (!edgeSyncPatterns.some(p => code.includes(p))) {
  errors.push('edgeSession turnEpoch sync missing');
}

/* --------------------------------------------------
RULE 5: timers emitting audio must include epoch guard
-------------------------------------------------- */

const timerMatches = [...code.matchAll(/setTimeout\s*\(\s*\(.*?=>\s*{([\s\S]*?)}/g)];

for (const t of timerMatches) {

  const body = t[1];

  if (!body.includes('sendAudioDirect')) continue;

  const hasEpochGuard =
    body.includes('playbackEpoch') ||
    body.includes('playbackEpochPlivo') ||
    body.includes('myEpoch');

  if (!hasEpochGuard) {
    errors.push('Timer emitting audio without playback epoch guard');
  }
}

/* --------------------------------------------------
RESULT
-------------------------------------------------- */

if (errors.length > 0) {

  console.error('\n❌ turnEpoch drift detected\n');

  errors.forEach(e => console.error(' -', e));

  process.exit(1);
}

console.log('✔ turnEpoch lifecycle validated.');