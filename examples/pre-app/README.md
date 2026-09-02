# Pre-App deployment, App registration, and administrator contract examples

These fixtures are synthetic, GHEC-only, and contain no credential, key
material, or real customer identifier. They illustrate the closed, versioned
contracts defined in `schemas/v1alpha1/deployment-topology.schema.json`,
`schemas/v1alpha1/github-app-registration-plan.schema.json`,
`schemas/v1alpha1/github-app-installation-target-binding.schema.json`,
`schemas/v1alpha1/github-app-permission-readback.schema.json`,
`schemas/v1alpha1/administrator-plan.schema.json`, and
`schemas/v1alpha1/administrator-readback.schema.json`, plus the integrated
`schemas/v1alpha1/administrator-handoff.schema.json`, and are validated by
`npm run validate:schemas`.

| File | Contract | Purpose |
|---|---|---|
| `deployment-topology.json` | `DeploymentTopologyPlan` | Exact closed set of eight independent trust-service identities (each with a fixed logical `principalId` plus a unique `signingKeyId`/`oidcAudience`), four durable stores (each with a unique `namespace`/`credentialId`), budgets, monitoring signals, retention windows, and protections required before any live App installation. |
| `github-app-registration-plan.json` | `GitHubAppRegistrationPlan` | Least-privilege permission union derived exactly from the reviewed `GITHUB_PERMISSION_MANIFEST` in `src/github-auth.ts`; `validateGitHubAppRegistrationPlan` re-derives and compares every field. |
| `github-app-installation-target-binding.json` | `GitHubAppInstallationTargetBinding` | A human-approved record of the immutable owner/App/installation/repository identity observed after a separately performed installation. Binds `compareGitHubAppPermissionReadback` to one exact target, keyed by numeric/node identifiers, never a mutable display name. |
| `github-app-permission-readback.json` | `GitHubAppPermissionReadback` | A clean authenticated readback that matches both the plan and the target binding exactly (no drift). |
| `administrator-plan.json` | `AdministratorPlan` | Desired rulesets — a branch ruleset (requiring pull request, CODEOWNERS review, and current-head approval) and a tag ruleset (restricting tag creation, update, and deletion, per GitHub's closed branch/tag discriminated rule-type split), each with explicit, literal-only `refConditions`/`effectiveProtectedRefs` — required checks, Actions policy, GHAS settings, an immutable `repository` identity, Project binding, incident contacts, and an explicit `nonAuthoritative` marker. |
| `administrator-readback.json` | `AdministratorReadback` | An authenticated readback modeling fresh live evidence with intentional drift from the desired plan (`allowedActions: "all"` instead of `"selected"`, pull-request review approval enabled, SHA pinning disabled, and an environment with no protection rules) to exercise `compareAdministratorReadback` fail-closed detection; `driftFound: true` is only a coherence assertion checked separately by `checkReadbackDriftCoherence`, never an input to the comparator. |

None of these documents can install, transfer, or authenticate a GitHub App;
apply a ruleset, required check, Actions policy, or GHAS setting; mutate a
Project; or select a live deployment target. Every plan and readback in this
contract family — `DeploymentTopologyPlan`, `GitHubAppRegistrationPlan`,
`GitHubAppPermissionReadback`, `AdministratorPlan`, and
`AdministratorReadback` — carries an explicit `nonAuthoritative`/
evidence-only marker, compared field-by-field on the readback side so a
readback cannot silently understate what it cannot itself apply.
`GitHubAppInstallationTargetBinding` is a separate, human-approved record of
an already-completed installation and does not carry this marker.
`compareAdministratorReadback` additionally requires exact governed-set
coverage: an observed ruleset, environment, or required-check ID absent
from the plan is reported as drift, not silently ignored, and a duplicated
observed key (ruleset/environment/check/incident-contact/permission) is
rejected before any per-key comparison.
`compareGitHubAppPermissionReadback` and `compareAdministratorReadback` also
reject an observation outside a caller-supplied freshness window (future, or
older than a maximum age) without reading any clock internally. See
`docs/runbooks/deployment-prerequisites.md`,
`docs/security/github-app-permissions.md`,
`docs/security/ghas-administrator-runbook.md`, and
`docs/runbooks/customer-administrator.md` for the human-only steps these
contracts plan against.
`npm run handoff:administrator` composes these contracts with all fifteen
durable adapters, the repeated synthetic canary, both customer-starter
selections, and the open-source no-go assessment. It accepts no options and
performs no live apply.
