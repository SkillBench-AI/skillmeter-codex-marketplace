/**
 * License-JWT helpers: payload decode, expiry check, telemetry endpoint
 * resolution. No signature verification — these are trust-the-server-or-
 * rotate semantics; the plugin only uses claims to make local routing
 * decisions and to avoid sending tokens we know are already expired.
 */

// 30-second grace window tolerates minor clock skew between client and server.
const JWT_EXPIRY_GRACE_SECONDS = 30;

/**
 * Decode the payload section of a JWT token (without signature verification)
 * @param {string} token - JWT token string
 * @returns {object|null} Decoded payload or null on failure
 */
function decodeJwtPayload(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(base64, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * Return true when the token's `exp` claim is already past (with a small
 * grace window). A missing/undecodable token is treated as NOT expired —
 * callers already guard on token presence.
 */
function isJwtExpired(token) {
  if (!token) return false;
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload.exp !== "number") return false;
  return payload.exp < Math.floor(Date.now() / 1000) + JWT_EXPIRY_GRACE_SECONDS;
}

/**
 * Resolve the per-tenant telemetry endpoint baked into the license JWT. The
 * activation Lambda mints a `telemetry_endpoint` claim into every JWT (resolved
 * against the tenant slug at issuance), so each tenant's traffic routes to its
 * own meter hostname without per-tenant plugin builds.
 *
 * Returns the claim host (no trailing slash) or null when no endpoint can be
 * resolved — when the token is absent, already expired, or the claim is missing
 * or not an https URL. The caller (getBackendUrl) falls back to the shipped
 * default in that case; it must never block uploads on a null here.
 *
 * @param {string} token - License JWT (raw, as stored in the credstore)
 * @returns {string|null}
 */
function getEndpointFromToken(token) {
  if (!token) return null;
  if (isJwtExpired(token)) return null;
  const payload = decodeJwtPayload(token);
  if (!payload) return null;
  const endpoint = payload.telemetry_endpoint;
  if (typeof endpoint !== "string") return null;
  const trimmed = endpoint.trim();
  // The claim is server-minted, but reject anything that isn't a plain https
  // origin so a malformed claim can't redirect traffic to a non-TLS host.
  if (!/^https:\/\//i.test(trimmed)) return null;
  return trimmed.replace(/\/+$/, "");
}

module.exports = {
  JWT_EXPIRY_GRACE_SECONDS,
  decodeJwtPayload,
  isJwtExpired,
  getEndpointFromToken,
};
