const path = require('path');
const fs = require('fs');

function decodeMuLaw(buffer) {
    // build µ-law decode table using standard ITU-T G.711 formula.
    // Previous formula ((mantissa<<4)+0x08)<<exp had up to 49% amplitude error
    // at low mantissa + high exponent values, degrading RNNoise input quality.
    const BIAS = 0x84;
    const table = new Int16Array(256);
    for (let i = 0; i < 256; i++) {
        let mu = ~i & 0xff;
        const sign = mu & 0x80;
        const exponent = (mu >> 4) & 0x07;
        const mantissa = mu & 0x0f;

        let sample = ((mantissa << 3) + BIAS) << exponent;
        sample -= BIAS;
        if (sign) sample = -sample;

        table[i] = sample;
    }

    const out = new Int16Array(buffer.length);
    for (let i = 0; i < buffer.length; i++) {
        out[i] = table[buffer[i]];
    }

    return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
}

function expand8kTo48k(frame8k) {
    const expanded = new Float32Array(frame8k.length * 6);
    for (let i = 0; i < frame8k.length; i++) {
        const v = frame8k[i];
        const idx = i * 6;
        expanded[idx] = v;
        expanded[idx + 1] = v;
        expanded[idx + 2] = v;
        expanded[idx + 3] = v;
        expanded[idx + 4] = v;
        expanded[idx + 5] = v;
    }
    return expanded;
}

function collapse48kTo8k(frame48k) {
    const out = new Float32Array(frame48k.length / 6);
    for (let i = 0; i < out.length; i++) {
        out[i] = frame48k[i * 6];
    }
    return out;
}

class RealTimeRNNoise {
    constructor() {
        this.Module = null;
        this.state = null;
        this.closed = false; // guard to prevent processing after destroy
        this.frameSize = 480; // 10ms frame at 48kHz
        this.inputRate = 8000;
        this.processRate = 48000;

        // Buffers for carrying over samples between chunks
        this.residual8k = new Float32Array(0);
    }

    async initialize() {
        if (this.Module && this.state) return; // prevent double initialization
        if (this.closed) {
            throw new Error('RNNoise instance was destroyed');
        }
        this.Module = await this.loadModule();
        this.state = this.Module._rnnoise_create();
        this.framePtr = this.Module._malloc(this.frameSize * 4); // preallocate frame buffer
    }

    async loadModule() {
        return new Promise((resolve, reject) => {
            const wasmPath = path.join(__dirname, '..', 'libs', 'rnnoise.wasm');
            const wasmBinary = fs.readFileSync(wasmPath);

            const Module = {
                wasmBinary: wasmBinary,
                onRuntimeInitialized: () => resolve(Module),
                onAbort: (error) => reject(error)
            };

            require('../libs/rnnoise.js')(Module);
        });
    }

    convertUlawToPcm(ulawBuffer) {
        // Fast µ-law decoding using lookup table
        return decodeMuLaw(ulawBuffer);
    }

    async processChunk(mulawChunk) {
        if (this.closed || !this.state) {
            return Buffer.alloc(0); // prevent processing after shutdown
        }
        if (!mulawChunk || mulawChunk.length === 0) {
            return Buffer.alloc(0);
        }

        // µ-law → PCM16
        const pcmChunk = this.convertUlawToPcm(mulawChunk);

        // PCM16 → Float32
        const input16 = new Int16Array(pcmChunk.buffer, pcmChunk.byteOffset, pcmChunk.byteLength / 2);
        const float32 = new Float32Array(input16.length);
        for (let i = 0; i < input16.length; i++) {
            float32[i] = input16[i] / 32768.0;
        }

        // prepend leftover samples from previous chunk
        const combined = new Float32Array(this.residual8k.length + float32.length);
        combined.set(this.residual8k);
        combined.set(float32, this.residual8k.length);

        const frameSize8k = 80;
        const processedFrames = [];

        let offset = 0;

        while (offset + frameSize8k <= combined.length) {
            const frame8k = combined.subarray(offset, offset + frameSize8k);

            const expanded = expand8kTo48k(frame8k);
            const processed48k = this.processFrame(expanded);
            const collapsed = collapse48kTo8k(processed48k);

            processedFrames.push(collapsed);
            offset += frameSize8k;
        }

        // store leftover samples for next chunk
        this.residual8k = combined.subarray(offset);

        if (processedFrames.length === 0) {
            return Buffer.alloc(0);
        }
        // Concatenate processed frames
        const processed = this.concatFrames(processedFrames);

        // Convert back to PCM16
        const output16 = new Int16Array(processed.length);
        for (let i = 0; i < processed.length; i++) {
            output16[i] = Math.max(-32768, Math.min(32767, processed[i] * 32768));
        }

        return Buffer.from(output16.buffer);
    }

    processFrame(frame) {
        if (this.closed || !this.state || !this.Module || !this.Module.HEAPF32) {
            return new Float32Array(frame.length);
        }
        // reuse preallocated WASM buffer to avoid malloc/free per frame
        this.Module.HEAPF32.set(frame, this.framePtr / 4);
        this.Module._rnnoise_process_frame(this.state, this.framePtr, this.framePtr);

        const processed = new Float32Array(frame.length);
        for (let i = 0; i < frame.length; i++) {
            processed[i] = this.Module.HEAPF32[(this.framePtr / 4) + i];
        }

        return processed;
    }

    concatFrames(frames) {
        const length = frames.reduce((sum, f) => sum + f.length, 0);
        const result = new Float32Array(length);
        let offset = 0;
        frames.forEach(f => {
            result.set(f, offset);
            offset += f.length;
        });
        return result;
    }

    destroy() {
        if (this.state) {
            this.Module._rnnoise_destroy(this.state);
            this.state = null;
            this.closed = true;
        }
        if (this.framePtr) {
            this.Module._free(this.framePtr);
            this.framePtr = null;
        }
    }
}

module.exports = { RealTimeRNNoise };