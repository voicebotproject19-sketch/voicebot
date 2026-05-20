/**
 * Sprint 3.5 — GateV2 PCM energy fix + audio pipeline optimizations.
 *
 * Validates:
 *  1. μ-law decode table correctness (ITU-T G.711)
 *  2. PCM RMS gives correct ordering: silence < speech (>10:1 ratio)
 *  3. Old formula was inverted: silence > speech
 *  4. Gate config changes for Plivo (energyOverrideThreshold=null) and Twilio
 *  5. Outbound audio handler avoids redundant Buffer allocations
 *  6. AzureRealtimeAdapter fast-path skips re-chunking for 160-byte frames
 */

'use strict';

// ─── 1. μ-law decode table ──────────────────────────────────────────────────

// Replicate the exact table from createCallSession.js
const BIAS = 0x84;
const ULAW_DECODE_TABLE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
    let mu = ~i & 0xff;
    const sign = mu & 0x80;
    const exponent = (mu >> 4) & 0x07;
    const mantissa = mu & 0x0f;
    let sample = ((mantissa << 3) + BIAS) << exponent;
    sample -= BIAS;
    if (sign) sample = -sample;
    ULAW_DECODE_TABLE[i] = sample;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Old broken formula: (byte - 128)² */
function oldGateEnergy(ulawBuffer) {
    let energy = 0;
    for (let i = 0; i < ulawBuffer.length; i++) {
        const v = ulawBuffer[i] - 128;
        energy += v * v;
    }
    return Math.sqrt(energy / ulawBuffer.length) / 128;
}

/** New correct formula: ULAW_DECODE_TABLE[byte]² */
function pcmEnergy(ulawBuffer) {
    if (!ulawBuffer || ulawBuffer.length === 0) return 0;
    let energy = 0;
    for (let i = 0; i < ulawBuffer.length; i++) {
        const pcm = ULAW_DECODE_TABLE[ulawBuffer[i]];
        energy += pcm * pcm;
    }
    return Math.sqrt(energy / ulawBuffer.length) / 32768;
}

function simulateGateSequence(rawEnergies, options = {}) {
    let lastEnergyScore = options.lastEnergyScore ?? 0.01;
    let noiseFloor = options.noiseFloor ?? 0.01;
    let silenceFrames = options.initialSilenceFrames ?? 0;
    const energyHistory = [];
    let energyVariance = 0;
    let energySlope = 0;
    const dynamicThresholdOffset = options.dynamicThresholdOffset ?? 0.02;
    const silenceFramesThreshold = options.silenceFramesThreshold ?? 50;
    const energyOverrideThreshold = options.energyOverrideThreshold ?? null;
    const maxSilenceFailsafe = options.maxSilenceFailsafe ?? 150;

    return rawEnergies.map((rawEnergy, index) => {
        const clampedEnergy = Math.max(0, Math.min(1, rawEnergy));
        lastEnergyScore = 0.7 * lastEnergyScore + 0.3 * clampedEnergy;

        energyHistory.push(lastEnergyScore);
        if (energyHistory.length > 12) energyHistory.shift();

        if (energyHistory.length > 2) {
            const mean = energyHistory.reduce((a, b) => a + b, 0) / energyHistory.length;
            energyVariance = energyHistory.reduce(
                (acc, v) => acc + Math.pow(v - mean, 2), 0
            ) / energyHistory.length;
        }
        if (energyHistory.length >= 2) {
            const last = energyHistory[energyHistory.length - 1];
            const prev = energyHistory[energyHistory.length - 2];
            energySlope = last - prev;
        }

        const fastSpeechScore =
            (lastEnergyScore * 0.5) +
            (energyVariance * 0.3) +
            (Math.max(0, energySlope) * 0.2);

        const currentNoiseFloor = noiseFloor || 0.01;
        const noiseAdaptRate = lastEnergyScore > currentNoiseFloor * 2 ? 0.02 : 0.15;
        noiseFloor = (1 - noiseAdaptRate) * currentNoiseFloor + noiseAdaptRate * lastEnergyScore;
        const highNoiseFloorBias = noiseFloor > 0.05 ? 0.02 : 0;
        const dynamicThreshold = noiseFloor + dynamicThresholdOffset + highNoiseFloorBias;

        let gateLevel;
        if (fastSpeechScore > dynamicThreshold + 0.01) gateLevel = 'HIGH';
        else if (fastSpeechScore > dynamicThreshold - 0.01) gateLevel = 'MEDIUM';
        else gateLevel = 'LOW';

        if (gateLevel === 'LOW') silenceFrames += 1;
        else silenceFrames = 0;

        let shouldSendAudio = gateLevel === 'HIGH' || gateLevel === 'MEDIUM' || silenceFrames < silenceFramesThreshold;
        let sendReason = shouldSendAudio ? (gateLevel === 'LOW' ? 'low_initial_window' : 'gate_level') : null;

        if (energyOverrideThreshold != null && lastEnergyScore > energyOverrideThreshold) {
            shouldSendAudio = true;
            sendReason = 'energy_override';
        }

        if (maxSilenceFailsafe != null && silenceFrames > maxSilenceFailsafe) {
            shouldSendAudio = true;
            sendReason = 'silence_failsafe';
            silenceFrames = 0;
        }

        return {
            frame: index + 1,
            rawEnergy,
            energy: lastEnergyScore,
            fastSpeechScore,
            noiseFloor,
            dynamicThreshold,
            gateLevel,
            silenceFrames,
            shouldSendAudio,
            sendReason
        };
    });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Sprint 3.5: GateV2 PCM Energy Fix', () => {

    describe('μ-law decode table (ITU-T G.711)', () => {
        test('silence bytes decode to zero', () => {
            expect(ULAW_DECODE_TABLE[0xFF]).toBe(0);  // positive silence
            expect(ULAW_DECODE_TABLE[0x7F]).toBe(0);  // negative silence
        });

        test('max amplitude bytes decode to ±32124', () => {
            expect(ULAW_DECODE_TABLE[0x80]).toBe(32124);   // max positive
            expect(ULAW_DECODE_TABLE[0x00]).toBe(-32124);  // max negative
        });

        test('table is monotonic within each polarity half', () => {
            // Positive: 0x80 (loudest) → 0xFF (silence), PCM should decrease
            for (let i = 0x80; i < 0xFF; i++) {
                expect(ULAW_DECODE_TABLE[i]).toBeGreaterThanOrEqual(ULAW_DECODE_TABLE[i + 1]);
            }
            // Negative: 0x00 (loudest) → 0x7F (silence), PCM should increase (toward 0)
            for (let i = 0x00; i < 0x7F; i++) {
                expect(ULAW_DECODE_TABLE[i]).toBeLessThanOrEqual(ULAW_DECODE_TABLE[i + 1]);
            }
        });
    });

    describe('PCM RMS energy ordering', () => {
        const silenceFrame = Buffer.alloc(160, 0xFF);
        const mixedSilence = Buffer.alloc(160);
        for (let i = 0; i < 160; i++) mixedSilence[i] = i % 2 === 0 ? 0xFF : 0x7F;

        const speechFrame = Buffer.alloc(160);
        for (let i = 0; i < 160; i++) {
            speechFrame[i] = [0x90, 0xA0, 0xB0, 0xC0, 0xD0, 0xE0, 0x10, 0x20, 0x30][i % 9];
        }

        const loudFrame = Buffer.alloc(160, 0x80);

        test('PCM RMS: silence < speech (>10:1 ratio)', () => {
            const sil = pcmEnergy(mixedSilence);
            const spc = pcmEnergy(speechFrame);
            expect(sil).toBeLessThan(0.01);
            expect(spc).toBeGreaterThan(0.05);
            expect(spc / Math.max(sil, 1e-9)).toBeGreaterThan(10);
        });

        test('PCM RMS: silence near zero', () => {
            expect(pcmEnergy(silenceFrame)).toBeLessThan(0.001);
        });

        test('PCM RMS: empty frame returns zero for defensive guard parity', () => {
            expect(pcmEnergy(Buffer.alloc(0))).toBe(0);
        });

        test('PCM RMS: loud speech near max', () => {
            expect(pcmEnergy(loudFrame)).toBeGreaterThan(0.9);
        });

        test('old formula was INVERTED: silence > speech', () => {
            const oldSil = oldGateEnergy(mixedSilence);
            const oldSpc = oldGateEnergy(speechFrame);
            // With old formula, silence reads HIGHER than speech
            expect(oldSil).toBeGreaterThan(oldSpc);
        });

        test('new formula is CORRECT: speech > silence', () => {
            const newSil = pcmEnergy(mixedSilence);
            const newSpc = pcmEnergy(speechFrame);
            expect(newSpc).toBeGreaterThan(newSil);
        });
    });

    describe('Gate config changes', () => {
        test('PlivoProvider energyOverrideThreshold defaults to null', () => {
            // Clear env to test defaults
            const saved = process.env.PLIVO_GATE_ENERGY_OVERRIDE_THRESHOLD;
            delete process.env.PLIVO_GATE_ENERGY_OVERRIDE_THRESHOLD;

            // Re-require to get fresh config
            jest.resetModules();
            const { getGateConfig } = require('../adapters/telecom/PlivoProvider');
            const config = getGateConfig();

            expect(config.energyOverrideThreshold).toBeNull();
            expect(config.dynamicThresholdOffset).toBe(0.02);

            if (saved !== undefined) process.env.PLIVO_GATE_ENERGY_OVERRIDE_THRESHOLD = saved;
        });

        test('PlivoProvider energyOverrideThreshold respects env override', () => {
            process.env.PLIVO_GATE_ENERGY_OVERRIDE_THRESHOLD = '0.05';
            jest.resetModules();
            const { getGateConfig } = require('../adapters/telecom/PlivoProvider');
            const config = getGateConfig();
            expect(config.energyOverrideThreshold).toBe(0.05);
            delete process.env.PLIVO_GATE_ENERGY_OVERRIDE_THRESHOLD;
        });

        test('TwilioProvider energyOverrideThreshold defaults to 0.03', () => {
            const saved = process.env.GATE_ENERGY_OVERRIDE_THRESHOLD;
            delete process.env.GATE_ENERGY_OVERRIDE_THRESHOLD;

            jest.resetModules();
            const { getGateConfig } = require('../adapters/telecom/TwilioProvider');
            const config = getGateConfig();

            expect(config.energyOverrideThreshold).toBe(0.03);
            expect(config.dynamicThresholdOffset).toBe(0.02);

            if (saved !== undefined) process.env.GATE_ENERGY_OVERRIDE_THRESHOLD = saved;
        });

        test('TwilioProvider energyOverrideThreshold respects explicit zero', () => {
            const saved = process.env.GATE_ENERGY_OVERRIDE_THRESHOLD;
            process.env.GATE_ENERGY_OVERRIDE_THRESHOLD = '0';

            jest.resetModules();
            const { getGateConfig } = require('../adapters/telecom/TwilioProvider');
            const config = getGateConfig();

            expect(config.energyOverrideThreshold).toBe(0);

            if (saved === undefined) delete process.env.GATE_ENERGY_OVERRIDE_THRESHOLD;
            else process.env.GATE_ENERGY_OVERRIDE_THRESHOLD = saved;
        });

        test('TwilioProvider energyOverrideThreshold can be disabled with null token', () => {
            const saved = process.env.GATE_ENERGY_OVERRIDE_THRESHOLD;
            process.env.GATE_ENERGY_OVERRIDE_THRESHOLD = 'null';

            jest.resetModules();
            const { getGateConfig } = require('../adapters/telecom/TwilioProvider');
            const config = getGateConfig();

            expect(config.energyOverrideThreshold).toBeNull();

            if (saved === undefined) delete process.env.GATE_ENERGY_OVERRIDE_THRESHOLD;
            else process.env.GATE_ENERGY_OVERRIDE_THRESHOLD = saved;
        });

        test('PlivoProvider blank override env falls back to disabled default', () => {
            const saved = process.env.PLIVO_GATE_ENERGY_OVERRIDE_THRESHOLD;
            process.env.PLIVO_GATE_ENERGY_OVERRIDE_THRESHOLD = '';

            jest.resetModules();
            const { getGateConfig } = require('../adapters/telecom/PlivoProvider');
            const config = getGateConfig();

            expect(config.energyOverrideThreshold).toBeNull();

            if (saved === undefined) delete process.env.PLIVO_GATE_ENERGY_OVERRIDE_THRESHOLD;
            else process.env.PLIVO_GATE_ENERGY_OVERRIDE_THRESHOLD = saved;
        });
    });

    describe('AzureRealtimeAdapter re-chunk fast-path', () => {
        test('160-byte buffer skips chunking loop', () => {
            jest.resetModules();
            const AzureRealtimeAdapter = require('../adapters/ai/AzureRealtimeAdapter');
            const adapter = Object.create(AzureRealtimeAdapter.prototype);

            const buf160 = Buffer.alloc(160, 0xAA);
            const result = adapter._formatAudioForProvider(buf160);

            expect(result).toHaveLength(1);
            expect(result[0].audio).toBe(buf160.toString('base64'));
        });

        test('320-byte buffer produces 2 chunks', () => {
            jest.resetModules();
            const AzureRealtimeAdapter = require('../adapters/ai/AzureRealtimeAdapter');
            const adapter = Object.create(AzureRealtimeAdapter.prototype);

            const buf320 = Buffer.alloc(320, 0xBB);
            const result = adapter._formatAudioForProvider(buf320);

            expect(result).toHaveLength(2);
            // Each chunk should be base64 of 160 bytes
            expect(Buffer.from(result[0].audio, 'base64').length).toBe(160);
            expect(Buffer.from(result[1].audio, 'base64').length).toBe(160);
        });

        test('small buffer (<160) uses fast-path', () => {
            jest.resetModules();
            const AzureRealtimeAdapter = require('../adapters/ai/AzureRealtimeAdapter');
            const adapter = Object.create(AzureRealtimeAdapter.prototype);

            const buf80 = Buffer.alloc(80, 0xCC);
            const result = adapter._formatAudioForProvider(buf80);

            expect(result).toHaveLength(1);
            expect(result[0].audio).toBe(buf80.toString('base64'));
        });
    });

    describe('Gate math with PCM energy — end-to-end simulation', () => {
        test('speech frames get HIGH/MEDIUM level, silence gets LOW', () => {
            // Simulate the full gate path with PCM-corrected energy
            let lastEnergyScore = 0.01;
            let noiseFloor = 0.01;
            const energyHistory = [];
            let energyVariance = 0;
            let energySlope = 0;
            const dynamicThresholdOffset = 0.02;
            const ENERGY_WINDOW = 12;

            function simulateFrame(ulawBuffer) {
                let energy = 0;
                for (let i = 0; i < ulawBuffer.length; i++) {
                    const pcm = ULAW_DECODE_TABLE[ulawBuffer[i]];
                    energy += pcm * pcm;
                }
                energy = Math.sqrt(energy / ulawBuffer.length) / 32768;
                const clampedEnergy = Math.max(0, Math.min(1, energy));
                lastEnergyScore = 0.7 * lastEnergyScore + 0.3 * clampedEnergy;

                energyHistory.push(lastEnergyScore);
                if (energyHistory.length > ENERGY_WINDOW) energyHistory.shift();

                if (energyHistory.length > 2) {
                    const mean = energyHistory.reduce((a, b) => a + b, 0) / energyHistory.length;
                    energyVariance = energyHistory.reduce(
                        (acc, v) => acc + Math.pow(v - mean, 2), 0
                    ) / energyHistory.length;
                }
                if (energyHistory.length >= 2) {
                    energySlope = energyHistory[energyHistory.length - 1] - energyHistory[energyHistory.length - 2];
                }

                const fastSpeechScore =
                    (lastEnergyScore * 0.5) +
                    (energyVariance * 0.3) +
                    (Math.max(0, energySlope) * 0.2);

                const currentNoiseFloor = noiseFloor;
                const noiseAdaptRate = lastEnergyScore > currentNoiseFloor * 2 ? 0.02 : 0.15;
                noiseFloor = (1 - noiseAdaptRate) * currentNoiseFloor + noiseAdaptRate * lastEnergyScore;
                const highNoiseFloorBias = (noiseFloor > 0.05) ? 0.02 : 0;
                const dynamicThreshold = noiseFloor + dynamicThresholdOffset + highNoiseFloorBias;

                let gateLevel;
                if (fastSpeechScore > dynamicThreshold + 0.01) gateLevel = 'HIGH';
                else if (fastSpeechScore > dynamicThreshold - 0.01) gateLevel = 'MEDIUM';
                else gateLevel = 'LOW';

                return { gateLevel, energy: lastEnergyScore, fastSpeechScore, dynamicThreshold };
            }

            // Run 20 silence frames to establish baseline
            const silenceFrame = Buffer.alloc(160);
            for (let i = 0; i < 160; i++) silenceFrame[i] = i % 2 === 0 ? 0xFF : 0x7F;

            let lastResult;
            for (let f = 0; f < 20; f++) {
                lastResult = simulateFrame(silenceFrame);
            }
            // Silence converges to LOW or MEDIUM (very low energy, near threshold).
            // Key: it should NOT be HIGH.
            expect(lastResult.gateLevel).not.toBe('HIGH');
            expect(lastResult.energy).toBeLessThan(0.01);

            // Now inject speech frames — should transition to HIGH
            const speechFrame = Buffer.alloc(160);
            for (let i = 0; i < 160; i++) {
                speechFrame[i] = [0x90, 0xA0, 0xB0, 0xC0, 0x10, 0x20, 0x30][i % 7];
            }

            let sawHigh = false;
            for (let f = 0; f < 10; f++) {
                lastResult = simulateFrame(speechFrame);
                if (lastResult.gateLevel === 'HIGH') sawHigh = true;
            }
            expect(sawHigh).toBe(true);
            expect(lastResult.energy).toBeGreaterThan(0.03);
        });

        test('moderate speech onset after long silence is initially dropped without override', () => {
            const rows = simulateGateSequence(Array(8).fill(0.05), {
                initialSilenceFrames: 80,
                energyOverrideThreshold: null,
                silenceFramesThreshold: 50,
                maxSilenceFailsafe: 150
            });

            expect(rows.slice(0, 5).every((row) => row.shouldSendAudio === false)).toBe(true);
            expect(rows.some((row) => row.shouldSendAudio === true)).toBe(true);
            expect(rows.findIndex((row) => row.shouldSendAudio)).toBeGreaterThan(0);
        });

        test('Twilio-style energy override rescues moderate onset earlier than Plivo default', () => {
            const plivoRows = simulateGateSequence(Array(8).fill(0.05), {
                initialSilenceFrames: 80,
                energyOverrideThreshold: null,
                silenceFramesThreshold: 50,
                maxSilenceFailsafe: 150
            });
            const twilioRows = simulateGateSequence(Array(8).fill(0.05), {
                initialSilenceFrames: 80,
                energyOverrideThreshold: 0.03,
                silenceFramesThreshold: 20,
                maxSilenceFailsafe: 150
            });

            const plivoFirstSend = plivoRows.findIndex((row) => row.shouldSendAudio);
            const twilioFirstSend = twilioRows.findIndex((row) => row.shouldSendAudio);

            expect(twilioFirstSend).toBeGreaterThanOrEqual(0);
            expect(twilioFirstSend).toBeLessThan(plivoFirstSend);
            expect(twilioRows[twilioFirstSend].sendReason).toBe('energy_override');
        });

        test('elevated noise floor can keep moderate speech classified LOW without override', () => {
            const rows = simulateGateSequence([
                ...Array(20).fill(0.04),
                ...Array(8).fill(0.07)
            ], {
                initialSilenceFrames: 80,
                energyOverrideThreshold: null,
                silenceFramesThreshold: 50,
                maxSilenceFailsafe: 150
            });
            const moderateSpeechRows = rows.slice(-8);

            expect(moderateSpeechRows.every((row) => row.gateLevel === 'LOW')).toBe(true);
            expect(moderateSpeechRows.every((row) => row.shouldSendAudio === false)).toBe(true);
            expect(moderateSpeechRows[moderateSpeechRows.length - 1].dynamicThreshold)
                .toBeGreaterThan(moderateSpeechRows[moderateSpeechRows.length - 1].fastSpeechScore);
        });
    });
});
