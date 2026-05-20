'use strict';

require('dotenv').config();

const AzureRealtimeAdapter = require('../adapters/ai/AzureRealtimeAdapter');

class RealtimeServiceTwilio extends AzureRealtimeAdapter {
    constructor() {
        super({
            enableSilenceTimers: true,
            enableAudioPlaybackTracking: true,
            enableTextInputPath: true,
            enableReconnectContext: true,
            includeTempInSessionConfig: false,
            emitAudioAsBuffer: true,
        });
    }
}

module.exports = RealtimeServiceTwilio;
