
const ConversationRepository = require('../repositories/ConversationRepository');
const CallRegistry = require('../services/CallRegistry');

// Provider adapters — re-exported under legacy names for backwards compatibility.
// New callers should import from the provider files directly.
const TwilioProvider = require('../adapters/telecom/TwilioProvider');
const PlivoProvider  = require('../adapters/telecom/PlivoProvider');

const { parseE164CountryCode } = require('../Utils/phoneUtils');

async function insertConversation(callSID, phoneNumber, role, content) {
    try {
        if (!callSID || !phoneNumber) {
            throw new Error('callSID and phoneNumber are required');
        }
        await ConversationRepository.insertConversation(callSID, phoneNumber, role, content);
        const callState = CallRegistry.get(callSID);
        if (callState) {
            const transcript = callState.transcript || (callState.transcript = []);
            transcript.push({ role, content });

            // Keep only the most recent 50 messages to avoid unbounded memory growth
            if (transcript.length > 50) {
                transcript.splice(0, transcript.length - 50);
            }
        }
        console.log('conversation created for', role);
    } catch (err) {
        console.error('Error inserting call conversation:', err);
        throw err;
    }
}

module.exports = {
    // Shared utility — canonical location is Utils/phoneUtils.js
    parseE164CountryCode,

    // Conversation persistence — still lives here (used by realtimeService classes)
    insertConversation,

    // Provider call lifecycle — thin re-exports; bodies live in provider files
    createCallTwilio:        TwilioProvider.createCall,
    disconnectTwilioCall:    TwilioProvider.hangup,
    transferTwilioCall:      TwilioProvider.transfer,

    createCallPlivo:         PlivoProvider.createCall,
    disconnectPlivoCall:     PlivoProvider.hangup,
    transferPlivoCall:       PlivoProvider.transfer,
};
