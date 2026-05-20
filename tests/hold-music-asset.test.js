'use strict';

const fs = require('fs');
const path = require('path');

const HOLD_MUSIC_PATH = path.join(__dirname, '..', 'Music', 'hold.mulaw');

function muLawToLinear16(byte) {
    const value = (~byte) & 0xff;
    const sign = value & 0x80;
    const exponent = (value >> 4) & 0x07;
    const mantissa = value & 0x0f;
    let sample = ((mantissa << 3) + 0x84) << exponent;
    sample -= 0x84;
    return sign ? -sample : sample;
}

function computeAudioStats(buffer) {
    let sumSquares = 0;
    let sum = 0;
    let peak = 0;
    let firstAudibleSample = null;
    let lastAudibleSample = null;

    for (let i = 0; i < buffer.length; i += 1) {
        const normalized = muLawToLinear16(buffer[i]) / 32768;
        const absolute = Math.abs(normalized);
        sum += normalized;
        sumSquares += normalized * normalized;
        peak = Math.max(peak, absolute);

        if (absolute > 0.01) {
            if (firstAudibleSample === null) firstAudibleSample = i;
            lastAudibleSample = i;
        }
    }

    return {
        rms: Math.sqrt(sumSquares / buffer.length),
        peak,
        dcOffset: Math.abs(sum / buffer.length),
        firstAudibleSample,
        lastAudibleSample
    };
}

describe('hold music asset', () => {
    test('is raw 8kHz mu-law with sane telephony playback characteristics', () => {
        const buffer = fs.readFileSync(HOLD_MUSIC_PATH);
        const stats = computeAudioStats(buffer);
        const durationSeconds = buffer.length / 8000;

        expect(buffer.subarray(0, 4).toString('ascii')).not.toBe('RIFF');
        expect(buffer.length % 160).toBe(0);
        expect(durationSeconds).toBeGreaterThanOrEqual(6);
        expect(durationSeconds).toBeLessThanOrEqual(20);
        expect(stats.rms).toBeGreaterThan(0.03);
        expect(stats.rms).toBeLessThan(0.35);
        expect(stats.peak).toBeGreaterThan(0.08);
        expect(stats.peak).toBeLessThan(0.75);
        expect(stats.dcOffset).toBeLessThan(0.02);
        expect(stats.firstAudibleSample).toBeLessThan(1600);
        expect(buffer.length - stats.lastAudibleSample).toBeLessThan(1600);
    });
});
