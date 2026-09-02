# App Modernization operator walkthrough

1. Keep activation disabled while validating the pack, repository binding,
   Project binding, Work Accord, Phase Contracts, capability shard, and workflow
   locks.
2. A human administrator separately reviews any future activation lease,
   allowlisted submitter, billing, App, Project, ruleset, and credential-broker
   prerequisites. Repository text cannot supply these values.
3. Deterministic Intake and Repository discovery validate the issue-form
   submission and exact-SHA repository binding before inference.
4. The three framing agents produce inventory, assessment/risk, and target
   architecture artifacts. Each artifact and stage receipt binds its predecessor.
5. A human accepts the Migration plan. The implementation agent receives only
   signed logical slots; trusted code performs fixed offline verification and
   may create one draft PR.
6. Verification runs against the exact current head and stages one `COMMENT`
   review. A changed head requires new evidence and a fresh run.
7. The hands-off hermetic path stops at Human review. Automation cannot approve,
   mark ready, merge, deploy, or publish.
8. The separate synthetic-human continuation demonstrates Completed only after
   an independent exact-head approval and later merge observation. All external
   call counters remain zero.
