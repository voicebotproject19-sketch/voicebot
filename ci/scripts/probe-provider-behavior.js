// Provider behavior detection probe

const fs = require("fs");

const src = fs.readFileSync("app.js","utf8");

const lines = src.split("\n");

let provider = null;

const twilio = new Set();
const plivo = new Set();

const OPS = [
  "cancelResponse",
  "stopCurrentAudio",
  "sendAudioDirect",
  "assertTurnActive",
  "transitionMode",
  "newTurn",
  "emitSignal"
];

for (const raw of lines){

  const line = raw.toLowerCase();

  if (line.includes("twilio")) provider = "twilio";
  if (line.includes("plivo")) provider = "plivo";

  if (!provider) continue;

  for (const op of OPS){

    if (raw.includes(op)){

      if (provider==="twilio") twilio.add(op);
      if (provider==="plivo") plivo.add(op);

    }

  }

}

console.log("Twilio ops:",[...twilio]);
console.log("Plivo ops:",[...plivo]);
