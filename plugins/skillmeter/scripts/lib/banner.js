/**
 * Terminal cards for sign-in, status and consent results. Box-drawing glyphs,
 * the checkmark and the arrow are assumed to occupy one terminal column each.
 */
const path = require("path");

let version = "";
try { version = require(path.join(__dirname, "..", "..", ".codex-plugin", "plugin.json")).version || ""; }
catch { /* An unreadable manifest only drops the version from the title. */ }

// Names a non-default channel or environment so the destination is visible.
function channelLabel() {
  const config = require("./config");
  const { channel } = config.channel();
  const env = config.environment();
  if (channel !== "stable") return ` · ${channel} (${env})`;
  return env === "prod" ? "" : ` · ${env}`;
}

// Content-sized card with a titled top border, as in the Claude plugin.
function card(lines) {
  const title = `${version ? `SkillMeter v${version}` : "SkillMeter"}${channelLabel()}`;
  const bodyWidth = Math.max([...title].length, ...lines.map(line => [...line].length));
  const innerWidth = bodyWidth + 4;
  const titleRule = `─ ${title} `;
  const top = `╭${titleRule}${"─".repeat(innerWidth - [...titleRule].length)}╮`;
  const body = lines.map(line => `│  ${line}${" ".repeat(bodyWidth - [...line].length)}  │`);
  return ["", top, ...body, `╰${"─".repeat(innerWidth)}╯`, ""].join("\n");
}

const row = (label, value) => `${label.padEnd(14)}${value}`;

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

const STATUS_TITLES = {
  on: "[ TELEMETRY ON ]",
  off: "[ TELEMETRY OFF ]",
  consent: "[ CONSENT REQUIRED ]",
  paused: "[ PAUSED ]",
  scope: "[ OUT OF SCOPE ]",
  signin: "[ SIGN IN REQUIRED ]",
};

const NEXT_STEPS = {
  consent: "→ Ask Codex to record SkillMeter consent for this repository",
  signin: "→ Ask Codex to sign in to SkillMeter",
  paused: "→ status --details for the cause",
  off: "→ Ask Codex to show SkillMeter consent for this repository",
  scope: "→ Ask Codex to check SkillMeter repository scope",
  on: "→ status --details for diagnostics",
};

// `capture` is { state, text } from the telemetry CLI; `text` is shown only
// when capture is not on, so a healthy status stays short.
function statusBanner({ capture, repository, signIn, queue }) {
  const lines = [STATUS_TITLES[capture.state] || STATUS_TITLES.paused, ""];
  if (repository) lines.push(row("Repository", repository));
  if (capture.state !== "on") lines.push(row("Reason", capture.text));
  lines.push(row("Sign-in", signIn));
  if (queue) lines.push(row("Queue", queue));
  lines.push("", NEXT_STEPS[capture.state] || NEXT_STEPS.paused);
  return card(lines);
}

// Result of one consent-set write.
function consentSavedBanner({ kind, target, enabled, revision, capture, cleanupDeferred, durabilityUnconfirmed }) {
  const title = kind === "organization"
    ? `[ ORGANIZATION ${enabled ? "ON" : "OFF"} ]`
    : enabled && capture?.state === "on" ? STATUS_TITLES.on : `[ REPOSITORY ${enabled ? "ON" : "OFF"} ]`;
  const lines = [title, "", row(kind === "organization" ? "Organization" : "Repository", target), row("Revision", String(revision))];
  if (!enabled) lines.push(row("Queued data", cleanupDeferred ? "cleanup deferred; delivery rechecks consent" : "removed"));
  if (kind === "repository" && enabled && capture?.state !== "on") lines.push(row("Reason", capture?.text || "unknown"));
  if (durabilityUnconfirmed) lines.push("Save not confirmed to survive a crash; check consent-preview.");
  lines.push("");
  if (kind === "organization" && enabled) lines.push("→ Next: turn this repository on");
  else if (enabled && capture?.state === "on") lines.push("→ Start a new Codex session to capture from the beginning");
  else lines.push("→ status for the current state");
  return card(lines);
}

module.exports = { card, welcomeBanner, statusBanner, consentSavedBanner };
