'use strict';

/**
 * Validation suite for Utils/audioTranscode.js
 *
 * Run: npx jest tests/audioTranscode.test.js
 */

const {
    mulawDecode,
    mulawEncode,
    upsample8kTo24k,
    downsample24kTo8k,
    mulawToLinear16_24k,
    linear16_24kToMulaw
} = require('../Utils/audioTranscode');

function buildSinePcm8k(sampleRate, freqHz, durationMs, amplitude = 0.55) {
    const samples = Math.floor(sampleRate * (durationMs / 1000));
    const out = Buffer.allocUnsafe(samples * 2);
    for (let i = 0; i < samples; i++) {
        const t = i / sampleRate;
        const s = Math.sin(2 * Math.PI * freqHz * t);
        const v = Math.max(-32768, Math.min(32767, Math.round(s * amplitude * 32767)));
        out.writeInt16LE(v, i * 2);
    }
    return out;
}

function snrDb(referencePcm, testPcm) {
    const count = Math.min(Math.floor(referencePcm.length / 2), Math.floor(testPcm.length / 2));
    let signal = 0;
    let noise = 0;
    for (let i = 0; i < count; i++) {
        const ref = referencePcm.readInt16LE(i * 2);
        const tst = testPcm.readInt16LE(i * 2);
        signal += ref * ref;
        const err = ref - tst;
        noise += err * err;
    }
    if (noise === 0) return Infinity;
    if (signal === 0) return -Infinity;
    return 10 * Math.log10(signal / noise);
}

describe('audioTranscode', () => {
    const mulawSilence = Buffer.alloc(160, 0xFF);

    test('mulawDecode returns Buffer', () => {
        const pcm8k = mulawDecode(mulawSilence);
        expect(Buffer.isBuffer(pcm8k)).toBe(true);
    });

    test('mulawDecode expands 160 ulaw bytes -> 320 PCM bytes', () => {
        const pcm8k = mulawDecode(mulawSilence);
        expect(pcm8k.length).toBe(320);
    });

    test('mulawEncode returns original frame size', () => {
        const pcm8k = mulawDecode(mulawSilence);
        const reencoded = mulawEncode(pcm8k);
        expect(reencoded.length).toBe(mulawSilence.length);
    });

    test('upsample8kTo24k triples PCM byte length', () => {
        const pcm8k = mulawDecode(mulawSilence);
        const pcm24k = upsample8kTo24k(pcm8k);
        expect(pcm24k.length).toBe(pcm8k.length * 3);
    });

    test('downsample24kTo8k returns original PCM length', () => {
        const pcm8k = mulawDecode(mulawSilence);
        const pcm24k = upsample8kTo24k(pcm8k);
        const pcmBack = downsample24kTo8k(pcm24k);
        expect(pcmBack.length).toBe(pcm8k.length);
    });

    test('mulawToLinear16_24k outputs 24k PCM bytes', () => {
        const roundTrip = mulawToLinear16_24k(mulawSilence);
        expect(roundTrip.length).toBe(960);
    });

    test('linear16_24kToMulaw restores original ulaw frame length', () => {
        const roundTripPcm24k = mulawToLinear16_24k(mulawSilence);
        const roundTripMulaw = linear16_24kToMulaw(roundTripPcm24k);
        expect(roundTripMulaw.length).toBe(mulawSilence.length);
    });

    test('silence frame round-trip stays near original ulaw values', () => {
        const roundTripPcm24k = mulawToLinear16_24k(mulawSilence);
        const roundTripMulaw = linear16_24kToMulaw(roundTripPcm24k);
        let maxDiff = 0;
        for (let i = 0; i < roundTripMulaw.length; i++) {
            maxDiff = Math.max(maxDiff, Math.abs(roundTripMulaw[i] - mulawSilence[i]));
        }
        expect(maxDiff).toBeLessThanOrEqual(8);
    });

    test('μ-law ↔ 24k round-trip adds < 1dB SNR loss vs baseline μ-law codec', () => {
        const sinePcm8k = buildSinePcm8k(8000, 440, 500);
        const baselineMulaw = mulawEncode(sinePcm8k);
        const baselineDecodedPcm = mulawDecode(baselineMulaw);
        const baselineSnr = snrDb(sinePcm8k, baselineDecodedPcm);

        const transcodedPcm24k = mulawToLinear16_24k(baselineMulaw);
        const transcodedMulaw = linear16_24kToMulaw(transcodedPcm24k);
        const transcodedDecodedPcm = mulawDecode(transcodedMulaw);
        const transcodedSnr = snrDb(sinePcm8k, transcodedDecodedPcm);
        const snrLossDb = baselineSnr - transcodedSnr;

        expect(snrLossDb).toBeLessThan(1.0);
    });
});