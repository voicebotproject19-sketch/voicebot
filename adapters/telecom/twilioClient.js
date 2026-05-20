const twilio = require("twilio");

function createTwilioClient({ accountSid, authToken }) {
  if (!accountSid || !authToken) {
    throw new Error(
      "Twilio credentials missing: TWILIO_ACCOUNT_SID or TWILIO_ACCOUNT_AUTH_TOKEN/TWILIO_AUTH_TOKEN"
    );
  }

  return twilio(accountSid, authToken);
}

module.exports = Object.freeze({
  createTwilioClient
});
