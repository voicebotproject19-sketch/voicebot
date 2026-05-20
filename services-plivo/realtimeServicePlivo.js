'use strict';

require('dotenv').config();

const AzureRealtimeAdapter = require('../adapters/ai/AzureRealtimeAdapter');

class RealtimeServicePlivo extends AzureRealtimeAdapter {
    constructor() {
        super({
            enableSilenceTimers: true,
            enableAudioPlaybackTracking: false,
            enableTextInputPath: false,
            enableReconnectContext: false,
            includeTempInSessionConfig: true,
            emitAudioAsBuffer: true,
        });
    }
}

module.exports = RealtimeServicePlivo;
