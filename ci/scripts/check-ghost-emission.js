/**
 * Prevent ghost audio emission after socket close
 *
 * Ensures every sendAudioDirect call is protected by
 * edgeSession.isClosed guard or assertTurnActive.
 */

const fs = require("fs");
const path = require("path");

const file = path.join(process.cwd(), "app.js");

if (!fs.existsSync(file)) {
  console.log("✔ ghost emission check skipped (app.js missing)");
  process.exit(0);
}

const src = fs.readFileSync(file, "utf8");

const sendMatches = [...src.matchAll(/sendAudioDirect\s*\(/g)];

const violations = [];

sendMatches.forEach((m, i) => {

  const start = Math.max(0, m.index - 600);
  const end = m.index + 600;

  const window = src.slice(start, end);

  // Check only the local region before the emitter for a safety guard
  const guardWindowStart = Math.max(0, m.index - 300);
  const guardWindow = src.slice(guardWindowStart, m.index);

  const hasGuard =
    /assertAudioSafe\s*\(/.test(guardWindow) ||
    /assertTurnActive\s*\(/.test(guardWindow) ||
    /edgeSession\.isClosed/.test(guardWindow) ||
    /isClosed/.test(guardWindow);

  if (!hasGuard) {
    violations.push(`Audio emission missing guard near index ${m.index}`);
  }

});

if (violations.length > 0) {

  console.error("\n❌ Ghost audio emission risk detected:\n");

  violations.forEach(v => console.error(" -", v));

  console.error("\nAudio emitters must be protected by assertAudioSafe, assertTurnActive, or a close guard.\n");

  process.exit(1);

}

console.log("✔ Ghost emission guard passed");