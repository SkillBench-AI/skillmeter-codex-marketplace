/**
 * Sign-in banner with a 42-column inner box. Box-drawing glyphs and the
 * checkmark are assumed to occupy one terminal column each.
 */

// `orgs` are the GitHub accounts the license covers.
function welcomeBanner(orgs) {
  // Without a connected organization no repository is in scope; say where to
  // fix that rather than welcoming nobody.
  const scope = Array.isArray(orgs) && orgs.length
    ? [`      Welcome, @${orgs.join(", @")}`]
    : ["      No GitHub organization is connected to this workspace,",
       "      so no repository is recorded. Connect one in SkillBench."];

  return [
    "",
    "   ╭──────────────────────────────────────────╮",
    "   │                                          │",
    "   │           ✓   SkillMeter                 │",
    "   │               signed in                  │",
    "   │                                          │",
    "   ╰──────────────────────────────────────────╯",
    ...scope,
    "",
  ].join("\n");
}

module.exports = { welcomeBanner };
