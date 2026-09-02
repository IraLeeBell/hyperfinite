# GitHub App permission manifest

## Status

This matrix describes the exact permissions accepted by the current adapter. It is not an installation action. A human administrator must create or update the GitHub App and independently verify the installed permissions.

| Operation | Repository permissions | Organization permissions | Writes |
|---|---|---|---|
| Resolve Trusted Binding | Metadata: read; Issues: read; Pull requests: read | Organization projects: read | None |
| Authorize an actor | Metadata: read; Pull requests: read | Members: read | None |
| Issue-comment effect and durable evidence | Metadata: read; Issues: write | None | Bound issue/PR comments only |
| Check-run effect and durable evidence | Metadata: read; Pull requests: read; Checks: write; Issues: write | None | Exact-head check run and bound issue/PR evidence comment |
| Project-field effect and durable evidence | Metadata: read; Issues: write | Organization projects: write | Already-bound item field value and bound issue/PR evidence comment |

The broker requests only one operation row and one repository per installation
token. Returned installation ID, sole repository, exact permission names,
scopes, and levels, and expiry are checked before an API client reaches the
operation. Extra permissions and elevated `write` grants where `read` was
requested are rejected.

## Explicitly absent

The adapter has no operation for:

- personal access tokens or `GITHUB_TOKEN`;
- pull-request approval, dismissal, merge, or auto-merge;
- repository administration, rulesets, branch-protection bypass, hooks, or Actions administration;
- Project creation, field creation, option creation, deletion, or schema migration;
- organization administration, teams, visibility, billing, enterprise policy, deployment, or publication.

Actor authorization reads current collaborator permission, organization/team membership, human/bot identity, independence, and exact review commit. It does not grant or change membership.

## Registration plan and readback contract

`GitHubAppRegistrationPlan`, `GitHubAppInstallationTargetBinding`, and
`GitHubAppPermissionReadback`
(`schemas/v1alpha1/github-app-registration-plan.schema.json`,
`schemas/v1alpha1/github-app-installation-target-binding.schema.json`,
`schemas/v1alpha1/github-app-permission-readback.schema.json`,
`src/app-registration-plan.ts`; see
[ADR 0013](../adr/0013-pre-app-deployment-app-and-administrator-contracts.md))
give this matrix a machine-checked counterpart. `planGitHubAppRegistration`
derives the exact least-privilege permission union from
`GITHUB_PERMISSION_MANIFEST` above — no caller or model input can add, omit,
or elevate a permission, and the function itself refuses to emit any
permission on the manifest's denied list. `validateGitHubAppRegistrationPlan`
independently re-derives the manifest's operations, denied names, and union
and rejects any ingested plan that drifts from it. The plan itself stays
target-free (no installation ID, owner, or repository identity exists before
a human installs the App); `GitHubAppInstallationTargetBinding` is a
separate, closed record of the immutable owner/App/installation/
repository-set identity a human has already separately approved after
installing. `compareGitHubAppPermissionReadback` requires, in order, the
plan to still match the manifest, the readback's `planDigest` to match the
exact plan, the target binding to be unexpired and the readback's
observation to fall inside a caller-supplied freshness window, and every
owner/App/installation/repository field to match the approved target
binding exactly — only then are permissions compared, and a permission
level that differs from plan in *either* direction (elevated or downscoped),
an extra permission, or a silently missing planned permission all fail
closed. Before individual permissions are compared, the readback's
observed-permission collection is checked for a duplicated permission key
(scope + name): a schema-valid readback can carry both a `read` and a
`write` object for the same key as distinct array entries, so a naive Map
keyed on that value would otherwise resolve the conflict silently by
keeping only the last entry. Every plan and readback also carries an
explicit `nonAuthoritative` marker (it cannot install/transfer/authenticate
an App or mint an installation token); the comparator checks the
readback's marker field-by-field against the plan's, so a readback that
silently reports `false` for one of these claims is flagged like any other
drift. Synthetic examples with no real installation identifier are in
`examples/pre-app/github-app-registration-plan.json`,
`examples/pre-app/github-app-installation-target-binding.json`, and
`examples/pre-app/github-app-permission-readback.json`. None of these
documents creates, transfers, installs, or authenticates an App, or mints an
installation token.
