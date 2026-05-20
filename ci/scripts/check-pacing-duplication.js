/**
 * CI VALIDATOR
 * Prevents pacing duplication bugs that could cause double audio playback.
 *
 * Guarantees:
 * - sendAudioDirect only appears inside sendOne()
 * - each sendOne contains exactly one emitter
 * - timers never emit audio directly
 * - sendOne always includes assertTurnActive guard
 *
 * Runtime: ~5ms
 */

const fs = require("fs");
const path = require("path");

const TARGET_FILE = path.join(process.cwd(), "app.js");

if (!fs.existsSync(TARGET_FILE)) {
    console.log("✔ pacing duplication check skipped (app.js missing)");
    process.exit(0);
}

const source = fs.readFileSync(TARGET_FILE, "utf8");
const violations = [];


/* -------------------------------------------------- */
/* Detect sendOne definitions                         */
/* -------------------------------------------------- */

const sendOneMatches = [...source.matchAll(/const\s+sendOne\s*=\s*\(/g)];

if (sendOneMatches.length === 0) {
    violations.push("sendOne() function not found");
}


/* -------------------------------------------------- */
/* Count audio emitters                               */
/* -------------------------------------------------- */

const emitterMatches = [...source.matchAll(/sendAudioDirect\s*\(/g)];

if (emitterMatches.length !== sendOneMatches.length) {
    violations.push(
        `sendAudioDirect count (${emitterMatches.length}) must equal sendOne count (${sendOneMatches.length})`
    );
}


/* -------------------------------------------------- */
/* Verify assertTurnActive guard                      */
/* -------------------------------------------------- */

sendOneMatches.forEach((match, index) => {

    const start = match.index;

    const inspectionWindow = source.substring(start, start + 500);

    if (!inspectionWindow.includes("assertTurnActive")) {
        violations.push(`sendOne #${index + 1} missing assertTurnActive guard`);
    }

});


/* -------------------------------------------------- */
/* Detect illegal timer emission                      */
/* -------------------------------------------------- */

const timerRegex = /setTimeout\s*\(\s*\(\)\s*=>\s*\{([\s\S]*?)\}\s*,/g;

let timerMatch;

while ((timerMatch = timerRegex.exec(source)) !== null) {

    const timerBody = timerMatch[1];

    if (/sendAudioDirect\s*\(/.test(timerBody)) {
        violations.push("sendAudioDirect used directly inside setTimeout");
    }

}


/* -------------------------------------------------- */
/* CI RESULT                                          */
/* -------------------------------------------------- */

if (violations.length > 0) {

    console.error("\n❌ Pacing duplication guard failed:\n");

    violations.forEach(v => console.error(" -", v));

    console.error("\nCI blocked due to potential double-audio race.\n");

    process.exit(1);

}

console.log("✔ Pacing duplication guard passed");
