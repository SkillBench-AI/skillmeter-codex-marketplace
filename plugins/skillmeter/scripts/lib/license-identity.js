"use strict";
const { decodeJwtPayload, getEndpointFromTokenAllowExpired } = require("./jwt");

// Local continuity check over claims issued by the activation service. The
// service/collector remains responsible for signature verification. An absent
// sub is retained as null for older tokens; changing it requires fresh sign-in.
function identity(token) {
  const p = decodeJwtPayload(token);
  if (!p || !Number.isFinite(p.exp) || !Number.isSafeInteger(p.github_id) || p.github_id <= 0 ||
      typeof p.org?.login !== "string" || !p.org.login ||
      (p.sub !== undefined && typeof p.sub !== "string") ||
      typeof p.aud !== "string" || getEndpointFromTokenAllowExpired(token) !== p.aud) return null;
  return {github_id:p.github_id, sub:p.sub ?? null, org:{login:p.org.login.toLowerCase()}, aud:p.aud};
}
function matches(a, b) {
  return !!a && !!b && a.github_id === b.github_id && a.sub === b.sub &&
    a.org?.login === b.org?.login && a.aud === b.aud;
}
module.exports = { identity, matches };
