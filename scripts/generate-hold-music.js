#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const SAMPLE_RATE = 8000;
const DURATION_SECONDS = 12;
const OUTPUT_PATH = path.join(__dirname, '..', 'Music', 'hold.mulaw');

function linear16ToMuLaw(sample) {
  const BIAS = 0x84;
  const CLIP = 32635;
  let pcm = Math.max(-CLIP, Math.min(CLIP, Math.round(sample)));
  let sign = 0;

  if (pcm < 0) {
    pcm = -pcm;
    sign = 0x80;
  }

  pcm += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && (pcm & mask) === 0; mask >>= 1) {
    exponent -= 1;
  }
  const mantissa = (pcm >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

function smoothEnvelope(localTime, segmentDuration) {
  const attack = 0.08;
  const release = 0.12;
  const attackGain = Math.min(1, localTime / attack);
  const releaseGain = Math.min(1, (segmentDuration - localTime) / release);
  return Math.max(0, Math.min(attackGain, releaseGain));
}

function sampleAt(seconds) {
  const phrase = [
    { note: 392.0, bass: 196.0 },
    { note: 493.88, bass: 246.94 },
    { note: 587.33, bass: 196.0 },
    { note: 523.25, bass: 261.63 },
    { note: 440.0, bass: 220.0 },
    { note: 554.37, bass: 277.18 },
    { note: 659.25, bass: 220.0 },
    { note: 587.33, bass: 293.66 }
  ];
  const segmentDuration = DURATION_SECONDS / phrase.length;
  const segmentIndex = Math.min(phrase.length - 1, Math.floor(seconds / segmentDuration));
  const localTime = seconds - (segmentIndex * segmentDuration);
  const { note, bass } = phrase[segmentIndex];
  const envelope = smoothEnvelope(localTime, segmentDuration);
  const shimmer = note * 1.5;

  const value =
    0.18 * Math.sin(2 * Math.PI * note * seconds) +
    0.07 * Math.sin(2 * Math.PI * shimmer * seconds) +
    0.05 * Math.sin(2 * Math.PI * bass * seconds);

  return value * envelope * 32767;
}

function main() {
  const totalSamples = SAMPLE_RATE * DURATION_SECONDS;
  const buffer = Buffer.alloc(totalSamples);

  for (let i = 0; i < totalSamples; i += 1) {
    buffer[i] = linear16ToMuLaw(sampleAt(i / SAMPLE_RATE));
  }

  fs.writeFileSync(OUTPUT_PATH, buffer);
  console.log(`Wrote ${OUTPUT_PATH} (${buffer.length} bytes, ${DURATION_SECONDS}s at ${SAMPLE_RATE}Hz mu-law)`);
}

main();
