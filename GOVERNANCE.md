# Governance

Human maintainers own policy, administration, cost activation, release,
licensing, and merge decisions.

Public governance applies to this authoritative upstream from its curated
open-source snapshot forward. Unpublished issues, pull requests, commits, or
coordination records are not required for governance or review, and the snapshot
makes no claim about earlier private development history.

## Decision rights

| Decision | Required authority |
|---|---|
| Lifecycle, Work Accord, policy, schema, registry, or capability change | Human CODEOWNER review |
| Security boundary, credential, workflow, or Single Writer change | Independent security review and human CODEOWNER review |
| Cost-bearing activation | Current human-approved Activation Lease and administrator billing approval |
| GitHub App installation or permission change | Repository or organization administrator |
| Ruleset, branch protection, team, visibility, secret, billing, or enterprise-policy change | Human administrator outside automation |
| Pull-request approval and merge | Independent eligible human on the exact current head |
| Publication, deployment, license, or production-system access | Separate authorized human/legal decision |
| Installation, upgrade, rollback, recovery, or uninstall apply | Human-approved canonical plan plus trusted-adapter authorization |
| Release signing or package publication | Human release owner using an approved protected release service |

No model, workflow, App, or service may approve itself, merge, dismiss review,
weaken policy, or treat a generated artifact as authority. Emergency response
may disable capabilities or the runtime, but restoration requires the normal
reviewed process and fresh evidence.

Merge readiness also requires exact-head CodeQL and Dependency Review plus
recorded success for typecheck, build, full tests, all checked-in
customer-readiness/schema/runtime/eval-fixture/provenance/workflow/gh-aw/
packaging validations,
dependency audit, and committed-range diff check. Demo portfolio changes also
require `validate:demos`, byte-deterministic `simulate:demos`, and
`validate:hardening`. Review-boundary changes additionally require the pinned
Copilot CLI release-archive and complete gh-aw setup-JS-tree agent-resolution
probe, including its authorized live resolution and non-vacuous denial
challenges, post-launch sentinel integrity, entropy-bound evidence read, and
effective no-auto-update version check. If
repository rulesets do not enforce a check, the human
maintainer must inspect its exact-head evidence; absence is a blocker, not
permission to merge.

Generated installer plans, SBOMs, provenance, unsigned attestations, and
release-candidate checklists are evidence only. They cannot approve a change,
make a readiness or licensing decision, install into a customer tenant, sign,
publish, or deploy.
