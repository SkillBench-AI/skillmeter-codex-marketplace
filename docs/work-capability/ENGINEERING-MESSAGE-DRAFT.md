Draft only; not sent. Suggested location: INF-177 discussion, addressed to Seungho/Homin.

Seungho, Homin: the local ChatGPT Work experiment now passes a two-turn capture and normalization canary. It reused the Codex queue/sanitizer and shared preprocessor, preserved the tool-call/result pairs, and stayed local-only. The temporary hooks are removed. Production upload, analysis and the dashboard path are still untested.

I’d keep this as a separate opt-in extension of the Codex plugin, linked to INF-177, while the existing Codex repair PRs remain draft. The review also caught an unintended credential-initialization path, which I fixed locally, and a remaining expiry gap: Work currently drops its queued capture when the token expires. That needs to follow the agreed lifecycle before delivery is enabled.

Could we confirm explicit per-task consent as the initial Work scope, including how long the grant lasts and how users renew/revoke it? For shared credentials, I’d reuse the contract we’re already discussing for #37/#38 and INF-200. For the later report test, I’d need the approved environment and test account, confirmation of which dashboard user it maps to, and whether the current analyzer is suitable for that Work sample.

I’ve prepared the implementation/evidence packet locally. Nothing has been deployed, and the Work branches haven’t been pushed yet.
