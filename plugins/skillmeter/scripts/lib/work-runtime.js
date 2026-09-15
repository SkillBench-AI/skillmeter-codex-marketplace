"use strict";
const fs = require("node:fs"), path = require("node:path");
const telemetry = require("./telemetry-store");
const {STATE_DIR} = require("./config");
const credentials = require("../credstore");
const {decodeJwtPayload,isJwtExpired,getEndpointFromToken} = require("./jwt");
const {hmac} = require("./transcript-delta");
const {createWorkCapture} = require("./work-local");
const data = process.env.PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA || path.join(STATE_DIR,"codex");
const logs = path.join(data,"logs");
function identity() {
  credentials.refreshFromDisk();
  if (credentials.getSignedOut() || credentials.getTelemetryDisabled() || fs.existsSync(path.join(logs,"purge-request.json"))) return null;
  const token=credentials.getLicenseToken(logs), claims=decodeJwtPayload(token);
  if (isJwtExpired(token) || !getEndpointFromToken(token) || !(claims.github_id || claims.user_alt_id)) return null;
  const salt=credentials.getOrCreateHashSalt(logs), deviceId=credentials.getDeviceId(logs);
  if (!salt || !deviceId) return null;
  // Same principal/tenant binding as repository capture. Existing credentials
  // are read only; no activation, token refresh or auth-schema change here.
  return {salt,deviceId,policyStamp:JSON.stringify(telemetry.readPolicy().global),owner:hmac(salt,JSON.stringify([claims.iss,claims.aud,claims.sub,claims.github_id || claims.user_alt_id]))};
}
function workCapture() { return createWorkCapture({root:path.join(logs,"work-local-v1"),identity}); }
module.exports={workCapture};
