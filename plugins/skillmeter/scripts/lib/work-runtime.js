"use strict";
const fs = require("node:fs"), path = require("node:path");
const telemetry = require("./telemetry-store");
const {STATE_DIR,CRED_FILE} = require("./config");
const {safeReadJson} = require("./io");
const {decodeJwtPayload,isJwtExpired,getEndpointFromTokenAllowExpired} = require("./jwt");
const {hmac} = require("./transcript-delta");
const {createWorkCapture} = require("./work-local");
const data = process.env.PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA || path.join(STATE_DIR,"codex");
const logs = path.join(data,"logs");
function identity() {
  // Read one existing snapshot. Credential getters can initialize missing
  // fields; this experimental adapter must never create or migrate identity.
  const store=safeReadJson(CRED_FILE), policy=telemetry.readPolicy();
  if (!store || store.signed_out===true || store.telemetry_disabled===true || policy.global.enabled===false || fs.existsSync(path.join(logs,"purge-request.json"))) return null;
  const token=store.license_jwt, claims=decodeJwtPayload(token);
  // Expiry prevents a new grant, but does not revoke an existing local grant.
  // Claims bind local capture only; this adapter has no authenticated sender.
  if (!Number.isFinite(claims?.exp) || !getEndpointFromTokenAllowExpired(token) || !(claims.github_id || claims.user_alt_id)) return null;
  const salt=store.hash_salt, deviceId=store.device_id;
  if (![salt,deviceId].every(value=>typeof value==="string" && value)) return null;
  // Same principal/tenant binding as repository capture. Existing credentials
  // are read only; no activation, token refresh or auth-schema change here.
  return {salt,deviceId,tokenExpired:isJwtExpired(token),policyStamp:JSON.stringify(policy.global),owner:hmac(salt,JSON.stringify([claims.iss,claims.aud,claims.sub,claims.github_id || claims.user_alt_id]))};
}
function workCapture() { return createWorkCapture({root:path.join(logs,"work-local-v1"),identity}); }
module.exports={workCapture};
