/**
 * ASCII welcome banner shown on sign-in success. Kept in one place so the
 * signin script and any future in-Codex expansion render the exact same art.
 *
 * Inner box width (between the two │ chars) is 42 columns. Box-drawing glyphs
 * and ✓ all render single-column in modern terminals.
 */

function welcomeBanner(orgs) {
  const identity = Array.isArray(orgs) && orgs.length
    ? `@${orgs.join(", @")}`
    : "(no GitHub identities cached)";

  return [
    "",
    "   ╭──────────────────────────────────────────╮",
    "   │                                          │",
    "   │           ✓   SkillMeter                 │",
    "   │               signed in                  │",
    "   │                                          │",
    "   ╰──────────────────────────────────────────╯",
    `      Welcome, ${identity}`,
    "",
  ].join("\n");
}

module.exports = { welcomeBanner };
