# Authoritative repository metadata

This design covers only the About description, homepage, and topics for the
authoritative public Hyperfinite repository. It is upstream maintainer
administration, not a customer-starter setup surface.

## State and authority separation

| Stage | Artifact or actor | Meaning | Effect authority |
|---|---|---|---|
| Desired state | `config/v1alpha1/repository-metadata.json` | Exact reviewed description, unset homepage, and closed topic set for one repository identity | None |
| Validation | Closed schema plus independent constants and deterministic tests | The contract is complete, bounded, and has not widened its repository or authority surface | None |
| Pre-apply read | Authenticated human `gh repo view` for the literal repository | Drift-prone observation of current GitHub state and the viewer's repository role | None |
| Plan | `scripts/plan-repository-metadata.ts` | Canonical contract/readback digests and exact replace/add/remove differences | None |
| Confirmation and apply | Human repository administrator using GitHub repository settings | Separately confirmed external administration after the contract pull request is merged | Human-admin effect only |
| Post-apply readback | A second authenticated exact-repository read and plan | Acceptance evidence only when the full state is in sync | None |

The planner accepts no repository argument, URL, credential, apply flag, or
fallback. The only live-shaped input is the exact closed `gh repo view` JSON
read from standard input. Both the repository full name and immutable GraphQL
node ID must match the contract before drift is computed. Unknown fields,
malformed or duplicate topics, oversized strings, and unrecognized viewer
permissions are rejected.

The plan normalizes GitHub's empty homepage string to the contract's explicit
`null` decision and compares topics as a sorted, duplicate-free set. Unknown
live topics are removals; missing desired topics are additions. Description and
homepage changes are complete replacements. A drifted read by a viewer without
both `viewerCanAdminister: true` and `viewerPermission: ADMIN` is blocked rather
than presented as ready to apply.

## Why application remains human-only

Updating repository settings and replacing all repository topics require
repository Administration write permission. The built-in Actions
`GITHUB_TOKEN` has no supported `administration` permission key. This repository
does not add a PAT fallback, mint an App token in a model or repository job, or
move GitHub App installation credentials out of the trusted-adapter boundary.
Consequently, no merge-triggered workflow can truthfully claim that merge
applied the About state.

The reviewed merge is the source authorization for the declared state. A human
administrator still confirms the fresh plan and performs the Settings change.
The direct post-apply read and zero-drift plan are the acceptance test. The plan
does not persist a GitHub snapshot or create the separate provenance mechanism
tracked for future work.

## Product and authority boundaries

The description is a concise rendering of the README opening. Hyperfinite is
the product/display name; `agentic-framework/v1alpha1` remains only the retained
package, API, schema, publisher, and cryptographic identity. The unset homepage
avoids presenting repository documentation as a hosted product or maintained
site. Topics describe discoverability, not supported consumption models.

About metadata grants no lifecycle, repository, target, Project, capability,
credential, transition, release, or effect authority. The lifecycle graph,
Work Accord, policy compiler, Control Kernel, trusted adapter, Single Writer,
and independent humans retain their existing authority order.

See the [maintainer checklist](../release/repository-metadata-checklist.md) for
the exact pre-read, confirmation, drift, and post-readback procedure.
