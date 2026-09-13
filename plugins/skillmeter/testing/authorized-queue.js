// Synthetic repository/consent fixture shared by transport tests. Callers must
// isolate credentials and PLUGIN_DATA before loading production modules.
const fs = require("node:fs");
const path = require("node:path");
function authorizedQueue(logger, org = "acme") {
  const repo = path.join(logger.PLUGIN_DATA, "synthetic-repo");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git/config"), `[remote "origin"]\nurl = https://github.com/${org}/fixture.git\n`);
  const store = require("../scripts/lib/telemetry-store");
  if (store.getRepositoryOverride(`${org}/fixture`) !== true || store.getOrganizationConsent(org) !== true) {
    store.authorizeOrganizationRepositories(org, [`${org}/fixture`], true);
  }
  const scope = logger.transcriptScope(repo);
  if (!scope) throw new Error("Fixture requires a valid licensed principal");
  return require("../scripts/lib/repository-queue").context(logger.REPOSITORIES_LOG_DIR, scope, logger.getOrCreateHashSalt());
}
module.exports = { authorizedQueue };
