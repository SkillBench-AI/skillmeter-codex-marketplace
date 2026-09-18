/**
 * Sign-in banner with a 42-column inner box. Box-drawing glyphs and the
 * checkmark are assumed to occupy one terminal column each.
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
