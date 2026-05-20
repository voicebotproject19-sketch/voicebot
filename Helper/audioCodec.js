function pcm16ToMulaw(pcm16Buffer) {
    const BIAS = 0x84;
    const CLIP = 32635;
    const mulawBuffer = Buffer.alloc(pcm16Buffer.length / 2);

    for (let i = 0; i < pcm16Buffer.length; i += 2) {
        let sample = pcm16Buffer.readInt16LE(i);
        // Standard ITU-T G.711 µ-law encoding — no pre-emphasis.
        // Pre-emphasis was incorrectly applied here, distorting the audio spectrum
        // and causing Azure's server_vad to fail to detect speech.

        const sign = (sample < 0) ? 0x80 : 0x00;
        sample = Math.abs(sample);
        sample = Math.min(sample, CLIP);
        sample += BIAS;

        // Optimized exponent calculation
        let exponent = 7;
        for (let exp = 0; exp < 8; exp++) {
            if (sample < (0x100 << exp)) {
                exponent = exp;
                break;
            }
        }

        const mantissa = (sample >> (exponent + 3)) & 0x0F;
        const mulaw = ~(sign | (exponent << 4) | mantissa);
        mulawBuffer[i / 2] = mulaw & 0xFF;
    }

    return mulawBuffer;
}
function mulawToPcm16(mulawBuffer) {

    const BIAS = 0x84;
    const pcmBuffer = Buffer.alloc(mulawBuffer.length * 2);

    for (let i = 0; i < mulawBuffer.length; i++) {

        let mu = ~mulawBuffer[i];
        const sign = mu & 0x80;
        const exponent = (mu >> 4) & 0x07;
        const mantissa = mu & 0x0F;

        let sample = ((mantissa << 3) + BIAS) << exponent;
        sample -= BIAS;

        if (sign !== 0) sample = -sample;

        pcmBuffer.writeInt16LE(sample, i * 2);
    }

    return pcmBuffer;
}
module.exports = { pcm16ToMulaw, mulawToPcm16 };