/**
 * License activation orchestrator.
 *
 * Owns the silent `gh auth token` fallback path, the JWT /refresh round-trip,
 * and activation-endpoint URL resolution. Storage lives in credstore (license
 * JWT, allowed orgs, signed-out sentinel); HTTP lives in lib/github-api (org
 * lookup). This module wires the two together.
 *
 * The exported surface (`getActivateUrl`, `getRefreshUrl`, `refreshExpiredJwt`,
 * `trySilentGhActivate`) is what the sign-in entrypoint and the hook-runtime
 * refresh path consume.
 */

const { execSync } = require("child_process");
const credstore = require("../credstore");
const { fetchUserGitHubOrgs } = require("./github-api");
const fs = require("node:fs"), path = require("node:path");
const { STATE_DIR } = require("./config");
const status = require("./license-status");
const identity = require("./license-identity");
const { acquireLock } = require("./transcript-delta");
const { getSkillmeterStringSetting } = require("./settings");
const { resolveOrgScope, narrowOrgsToScope } = require("./org-scope");

// Default points at prod. The prod control plane lives on the greenfield
// `skillbench.ai` zone (api.skillbench.ai), matching the Claude plugin and the
// infra `api_domain_name` — NOT skillbench.com, which has no DNS record.
// Devs/agents override via SKILLMETER_ACTIVATE_URL (e.g.
// https://api.dev.skillbench.com/activate) or a `skillmeter.activate_url` entry
// in the project's .codex/settings.local.json.
const DEFAULT_ACTIVATE_URL = "https://api.skillbench.ai/activate";

// Trusted domain patterns for activation URL validation. Prod is on
// skillbench.ai; dev/non-prod environments are on api.<env>.skillbench.com.
const TRUSTED_ACTIVATION_PATTERNS = [
  /^https:\/\/api\.skillbench\.ai\//,
  /^https:\/\/api\.skillbench\.com\//,
  /^https:\/\/api\.[a-z0-9-]+\.skillbench\.com\//,
  /^https:\/\/[a-z0-9-]+\.dev\.skillbench\.com\//,
];

function isValidActivationUrl(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    return TRUSTED_ACTIVATION_PATTERNS.some((pattern) => pattern.test(parsed.href));
  } catch {
    return false;
  }
}

function getActivateUrl() {
  if (process.env.SKILLMETER_ACTIVATE_URL) {
    const url = process.env.SKILLMETER_ACTIVATE_URL;
    if (!isValidActivationUrl(url)) {
      console.error(
        `[skillmeter] SKILLMETER_ACTIVATE_URL rejected (untrusted domain), using default`
      );
      return DEFAULT_ACTIVATE_URL;
    }
    return url;
  }
  const fromSettings = getSkillmeterStringSetting(process.cwd(), "activate_url");
  if (fromSettings) {
    if (!isValidActivationUrl(fromSettings)) {
      console.error(
        `[skillmeter] activate_url from settings rejected (untrusted domain), using default`
      );
      return DEFAULT_ACTIVATE_URL;
    }
    return fromSettings;
  }
  return DEFAULT_ACTIVATE_URL;
}

// The /refresh endpoint sits next to /activate on the same host. Derive the URL
// from getActivateUrl so the same host configuration covers both. If the
// activate URL doesn't end with /activate (e.g. a dev override with a custom
// path), append /refresh to the base path — keeps weird overrides at least
// roundtrippable.
function getRefreshUrl() {
  const url = getActivateUrl();
  if (url.endsWith("/activate")) return url.slice(0, -"/activate".length) + "/refresh";
  return url.replace(/\/?$/, "/refresh");
}

// Match Claude's outcome protocol; never log HTTP bodies or exception text.
async function exchange(url, bearer, deviceId) {
  let res;
  try {
    res = await fetch(url, {method:"POST", headers:{Authorization:`Bearer ${bearer}`, "Content-Type":"application/json"},
      body:JSON.stringify({device_id:deviceId}), signal:AbortSignal.timeout(5000)});
  } catch { return {outcome:"transient", message:"network error"}; }
  if (res.status === 402) return {outcome:"revoked", status:402};
  if ([401,410].includes(res.status)) return {outcome:"rejected", status:res.status};
  if (!res.ok) return {outcome:"transient", status:res.status, message:`HTTP ${res.status}`};
  let payload;
  try { payload = await res.json(); } catch { return {outcome:"transient", message:"invalid JSON"}; }
  if (!identity.identity(payload?.token) || credstore.isLicenseTokenExpired(payload.token, 0)) {
    return {outcome:"transient", message:"invalid issued token"};
  }
  return {outcome:"issued", token:payload.token};
}
async function refreshExpiredJwt(jwt, deviceId) {
  return exchange(getRefreshUrl(), jwt, deviceId);
}

async function silentGhActivate(deviceId, options = {}, expected = credstore.recoverySnapshot()) {
  if (credstore.getSignedOut()) return {outcome:"signed_out"};
  const prior = expected.marker || identity.identity(expected.token);
  if (!options.interactive && !prior) return {outcome:"signin_required"};
  let ghToken;
  try { ghToken = execSync("gh auth token", {encoding:"utf8", stdio:["pipe","pipe","ignore"], timeout:3000}).trim(); }
  catch { return {outcome:"gh_unauthenticated"}; }
  if (!ghToken) return {outcome:"gh_unauthenticated"};
  if (!options.interactive) {
    let res, user;
    try {
      res = await fetch("https://api.github.com/user", {headers:{Authorization:`Bearer ${ghToken}`, "User-Agent":"skillmeter-cli"}, signal:AbortSignal.timeout(5000)});
      if (!res.ok) return {outcome:res.status === 401 ? "gh_unauthenticated" : "transient", message:"GitHub identity unavailable"};
      user = await res.json();
    } catch { return {outcome:"transient", message:"GitHub identity unavailable"}; }
    if (!Number.isSafeInteger(user?.id)) return {outcome:"transient", message:"invalid GitHub identity"};
    if (user.id !== prior.github_id) return {outcome:"identity_mismatch"};
  }
  const issued = await exchange(getActivateUrl(), ghToken, deviceId);
  if (issued.outcome !== "issued") return issued;
  if (!options.interactive) {
    if (!identity.matches(identity.identity(issued.token), prior)) return {outcome:"identity_mismatch"};
    return credstore.commitRecovery(issued.token, expected) ? {outcome:"reactivated", token:issued.token} : {outcome:"superseded"};
  }
  // Explicit sign-in preserves the existing organization-narrowing behavior.
  let orgs;
  try { orgs = await fetchUserGitHubOrgs(ghToken); }
  catch { return {outcome:"transient", message:"GitHub memberships unavailable"}; }
  const scope = resolveOrgScope({cliOrgs:options.orgScope});
  const {orgs:scopedOrgs} = narrowOrgsToScope(orgs, scope);
  const current = credstore.recoverySnapshot();
  if (current.generation !== expected.generation || current.token !== expected.token) return {outcome:"superseded"};
  return credstore.commitSignin({jwt:issued.token, orgs:options.orgScope ? scopedOrgs : orgs})
    ? {outcome:"reactivated", token:issued.token} : {outcome:"signed_out"};
}
async function trySilentGhActivate(deviceId, options = {}) {
  const result = await silentGhActivate(deviceId, options);
  return result.outcome === "reactivated" ? result.token : null;
}

async function ensureFreshLicense(deviceId, {source = "daemon"} = {}) {
  if (!deviceId || credstore.getSignedOut()) return null;
  fs.mkdirSync(STATE_DIR, {recursive:true, mode:0o700});
  // Existing durable PID lock: never take over a live owner on a timer. This
  // also coordinates separate Codex installations sharing the credential file.
  const release = acquireLock(path.join(STATE_DIR, ".codex-license-refresh.lock"));
  if (!release) return null;
  try {
    if (credstore.getSignedOut()) return null;
    const expected = credstore.recoverySnapshot();
    if (status.refreshBlockedReason(status.readLicenseStatus())) return null;
    if (expected.token && !credstore.isLicenseTokenExpired(expected.token)) return expected.token;
    let result;
    if (expected.token) {
      result = await refreshExpiredJwt(expected.token, deviceId);
      if (result.outcome === "issued") {
        if (!identity.matches(identity.identity(result.token), expected.marker || identity.identity(expected.token))) result = {outcome:"identity_mismatch"};
        else result = credstore.commitRecovery(result.token, expected)
          ? {outcome:"rotated", token:result.token} : {outcome:"superseded"};
      }
    }
    if (!result || result.outcome === "rejected") result = await silentGhActivate(deviceId, {}, expected);
    if (["rotated","reactivated"].includes(result.outcome)) {
      status.recordRefreshSuccess({source, outcome:result.outcome}); return result.token;
    }
    // An old exchange must not revoke or change the status of a newer sign-in.
    if (JSON.stringify(credstore.recoverySnapshot()) !== JSON.stringify(expected) || credstore.getSignedOut()) return null;
    if (["revoked","identity_mismatch"].includes(result.outcome)) {
      if (!credstore.invalidateRecovery(expected)) return null;
      require("./queue-retention").purgeAll();
    }
    if (["revoked","identity_mismatch","gh_unauthenticated","signin_required"].includes(result.outcome)) {
      status.recordTerminal({source, reason:result.outcome, status:result.status});
    } else if (!["signed_out","superseded"].includes(result.outcome)) {
      status.recordRefreshFailure({source, kind:"refresh", status:result.status, message:result.message || "activation unavailable"});
    }
    return null;
  } finally { release(); }
}
module.exports = {getActivateUrl, getRefreshUrl, refreshExpiredJwt, trySilentGhActivate, ensureFreshLicense};
