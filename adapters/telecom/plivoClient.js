const plivo = require("plivo");

function createPlivoClient({ authId, authToken }) {
  if (!authId || !authToken) {
    throw new Error(
      "Plivo credentials missing: PLIVO_AUTH_ID or PLIVO_AUTH_TOKEN"
    );
  }

  return new plivo.Client(authId, authToken);
}

module.exports = Object.freeze({
  createPlivoClient
});
