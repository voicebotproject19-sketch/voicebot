const { normalizePlivoStatus, recordProviderStatus } = require('../services/telecomStatusService');

const plivoStatus = async (req, res) => {
  try {
    const payload = req.body || {};

    const normalized = normalizePlivoStatus(payload);

    console.debug("[PlivoStatus] Webhook received:", {
      callUUID: normalized.callSID,
      status: normalized.status
    });

    const result = recordProviderStatus({
      provider: 'plivo',
      callSID: normalized.callSID,
      status: normalized.status,
      payload,
      source: 'plivo-status'
    });

    if (!result.ok) {
      console.warn('[PlivoStatus] Received webhook with no recognizable UUID. Payload keys:', Object.keys(payload).join(', '));
      return res.status(200).send("ignored");
    }

    return res.status(200).send("ok");
  } catch (err) {
    console.error("[PlivoStatus] handler error:", err);
    return res.status(200).send("error handled");
  }
};

module.exports = plivoStatus;