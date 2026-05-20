const fs = require("fs");
const path = require("path");
const acorn = require("acorn");

const ROOT = process.cwd();
const ALLOWED_EVENTS = require(path.join(ROOT, "Utils", "telemetryEvents"));

const SPEECH_LIFECYCLE = [
  "speech_started",
  "speech_playback_started",
  "speech_emitted",
  "speech_completed"
];

const files = [];

function scan(dir) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);

    if (fs.statSync(p).isDirectory()) {
      if (!p.includes("node_modules") && !p.includes(".git")) scan(p);
    } else if (p.endsWith(".js")) {
      files.push(p);
    }
  }
}

scan(ROOT);

let badSignature = [];
let unknownEvents = [];
let missingEpoch = [];
let lifecycleErrors = [];

for (const file of files) {

  const code = fs.readFileSync(file, "utf8");

  let ast;

  try {
    ast = acorn.parse(code, {
      ecmaVersion: "latest",
      sourceType: "module"
    });
  } catch {
    continue;
  }

  const observedEvents = [];

  function walk(node) {

    if (!node) return;

    if (node.type === "CallExpression") {

      const callee = node.callee;

      // Match both logger.emit() and telemetry.emit() call patterns
      const isLoggerEmit =
        callee &&
        callee.type === "MemberExpression" &&
        callee.object.name === "logger" &&
        callee.property.name === "emit";

      const isTelemetryEmit =
        callee &&
        callee.type === "MemberExpression" &&
        callee.object.name === "telemetry" &&
        callee.property.name === "emit";

      if (isLoggerEmit) {

        const args = node.arguments;

        // Expect logger.emit(eventType, callId, turnId, payload)
        if (args.length < 4) {
          badSignature.push(`${file} -> expected 4 args, got ${args.length}`);
        }

        if (args[0] && args[0].type === "Literal" && typeof args[0].value === "string") {
          const evt = args[0].value;
          observedEvents.push(evt);
          if (!ALLOWED_EVENTS.has(evt)) {
            unknownEvents.push(`${evt} in ${file}`);
          }
        }

        const payload = args[3];

        // Only validate inline payload objects
        if (payload && payload.type === "ObjectExpression") {
          const props = payload.properties
            .map(p => {
              if (!p.key) return null;
              if (p.key.type === "Identifier") return p.key.name;
              if (p.key.type === "Literal") return p.key.value;
              return null;
            })
            .filter(Boolean);

          if (!props.includes("turnEpoch")) {
            missingEpoch.push(`${file} -> ${args[0] && args[0].value}`);
          }

          if (!props.includes("ts")) {
            missingEpoch.push(`${file} -> ${args[0] && args[0].value} (missing ts)`);
          }
        }
      }

      // telemetry.emit(eventType, payload) — public API used throughout codebase
      if (isTelemetryEmit) {
        const args = node.arguments;

        if (args[0] && args[0].type === "Literal" && typeof args[0].value === "string") {
          const evt = args[0].value;
          observedEvents.push(evt);
          if (!ALLOWED_EVENTS.has(evt)) {
            unknownEvents.push(`${evt} in ${file}`);
          }
        }
      }
    }

    for (const k in node) {
      const v = node[k];

      if (!v) continue;

      if (Array.isArray(v)) {
        for (const child of v) {
          if (child && typeof child === "object" && child.type) walk(child);
        }
      } else if (typeof v === "object" && v.type) {
        walk(v);
      }
    }
  }

  walk(ast);

  // lifecycle ordering check
  let idx = 0;

  for (const evt of observedEvents) {

    if (evt === SPEECH_LIFECYCLE[idx]) {
      idx++;
    }

    if (idx === SPEECH_LIFECYCLE.length) {
      break;
    }
  }

  if (idx !== SPEECH_LIFECYCLE.length && observedEvents.includes("speech_started")) {
    lifecycleErrors.push(`${file} -> incomplete speech lifecycle sequence`);
  }
}

console.log("\n=== TELEMETRY CONTRACT AUDIT ===\n");

if (badSignature.length) {
  console.log("❌ Invalid logger.emit signature:");
  console.log([...new Set(badSignature)]);
} else {
  console.log("✔ logger.emit signatures valid");
}

if (unknownEvents.length) {
  console.log("\n❌ Unknown telemetry events:");
  console.log(unknownEvents);
} else {
  console.log("✔ telemetry events valid");
}

if (missingEpoch.length) {
  console.log("\n⚠ Missing turnEpoch or ts:");
  console.log(missingEpoch);
} else {
  console.log("✔ payload epoch/timestamp valid");
}

if (lifecycleErrors.length) {
  console.log("\n⚠ lifecycle ordering suspicious:");
  console.log(lifecycleErrors);
} else {
  console.log("✔ lifecycle ordering looks valid");
}

console.log("\nFiles scanned:", files.length);