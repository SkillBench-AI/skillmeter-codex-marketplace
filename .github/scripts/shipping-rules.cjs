"use strict";

// Render additive rulesets for review. This script never calls GitHub.
const CHECKS_APP = 15368; // GitHub Actions, verified from this repository's checks.
const REQUIRED_CHECKS = ["Compatibility required", "Test (Node 20)", "Test (Node 22)", "Test candidate contract runner", "Validate manifests & version"];
function rulesets(publisherAppId) {
  if (!Number.isSafeInteger(publisherAppId) || publisherAppId <= 0 || publisherAppId === CHECKS_APP) throw Error("dedicated-publisher-app-required");
  const rule = (name, target, include, rules, bypass_actors = []) => ({name,target,enforcement:"active",conditions:{ref_name:{include,exclude:[]}},bypass_actors,rules});
  return [
    rule("compatibility-main", "branch", ["refs/heads/main"], [
      {type:"required_status_checks",parameters:{strict_required_status_checks_policy:false,do_not_enforce_on_create:true,required_status_checks:REQUIRED_CHECKS.map(context=>({context,integration_id:CHECKS_APP}))}},
      {type:"merge_queue",parameters:{check_response_timeout_minutes:60,grouping_strategy:"ALLGREEN",max_entries_to_build:1,max_entries_to_merge:1,min_entries_to_merge:1,merge_method:"MERGE",min_entries_to_merge_wait_minutes:1}}
    ]),
    rule("release-tag-creation", "tag", ["refs/tags/v*"], [{type:"creation"}], [{actor_id:publisherAppId,actor_type:"Integration",bypass_mode:"always"}]),
    // Separate from creation so the publisher cannot retarget or delete tags.
    rule("release-tag-immutability", "tag", ["refs/tags/v*"], [{type:"update"},{type:"deletion"}])
  ];
}
module.exports={rulesets,REQUIRED_CHECKS,CHECKS_APP};
if (require.main === module) {
  try { process.stdout.write(JSON.stringify(rulesets(Number(process.argv[2])), null, 2)+"\n"); }
  catch { console.error("dedicated-publisher-app-required"); process.exitCode=1; }
}
