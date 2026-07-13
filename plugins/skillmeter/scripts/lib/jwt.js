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
 * grace window). A missing/undecodable token is treated as expired to
 * ensure malformed tokens are rejected.
 */
function isJwtExpired(token) {
  if (!token) return true;
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload.exp !== "number") return true;
  return payload.exp < Math.floor(Date.now() / 1000) + JWT_EXPIRY_GRACE_SECONDS;
}

/**
 * Resolve the per-tenant telemetry endpoint baked into the license JWT. The
 * activation Lambda mints the tenant's meter URL into the standard JWT `aud`
 * (audience) claim — the token's intended recipient IS the tenant's meter host
 * — so each tenant's traffic routes to its own meter hostname without per-tenant
 * plugin builds. (The legacy `telemetry_endpoint` claim is deprecated and no
 * longer consulted.)
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
  return readEndpointClaim(token);
}

/**
 * Like getEndpointFromToken but WITHOUT the expiry gate. The telemetry endpoint
 * is routing info (the per-tenant meter hostname) and stays valid after the
 * token has aged out — and the collector accepts unauthenticated uploads, so a
 * drain can still deliver to the correct tenant host while a refresh is pending
 * or failing. Never used for an auth decision; only to recover the destination
 * URL. Mirrors the Claude plugin's helper of the same name.
 *
 * @param {string} token - License JWT (raw, as stored in the credstore)
 * @returns {string|null}
 */
function getEndpointFromTokenAllowExpired(token) {
  if (!token) return null;
  return readEndpointClaim(token);
}

// Shared claim extraction. The endpoint is read from the standard `aud`
// (audience) claim, which per RFC 7519 may be a string or an array of strings —
// we take the first https origin. The claim is server-minted, but reject
// anything that isn't a plain https origin so a malformed claim can't redirect
// traffic to a non-TLS host. The legacy `telemetry_endpoint` claim is no longer
// consulted.
function readEndpointClaim(token) {
  const payload = decodeJwtPayload(token);
  if (!payload) return null;
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  for (const aud of auds) {
    if (typeof aud !== "string") continue;
    const trimmed = aud.trim();
    if (!/^https:\/\//i.test(trimmed)) continue;
    return trimmed.replace(/\/+$/, "");
  }
  return null;
}

module.exports = {
  JWT_EXPIRY_GRACE_SECONDS,
  decodeJwtPayload,
  isJwtExpired,
  getEndpointFromToken,
  getEndpointFromTokenAllowExpired,
};
