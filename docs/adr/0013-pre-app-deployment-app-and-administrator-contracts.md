# ADR 0013: Pre-App deployment, App registration, and administrator contracts are closed and fail closed

- **Status:** Accepted
- **Date:** 2026-08-30

## Context

The pre-App deployment design requires the strongest provider-neutral posture
possible without creating or installing a GitHub App, handling secrets, or
asserting live activation. The first deliverable is a set of closed, versioned,
provider-neutral contracts for the deployment topology, the
GitHub App registration permission plan, and administrator configuration,
plus deterministic generators/validators, synthetic examples, and exhaustive
positive/adversarial tests.

Before this change, `docs/runbooks/deployment-prerequisites.md`,
`docs/security/github-app-permissions.md`, and
`docs/security/ghas-administrator-runbook.md` described these expectations in
prose only. `GITHUB_PERMISSION_MANIFEST` in `src/github-auth.ts` was the only
machine-checked contract, and it governs runtime permission requests, not
registration planning or administrator configuration.

## Decision

Three new closed, versioned (`schemaVersion: "1.0.0"`) contract families are
added, each with a JSON Schema, a deterministic TypeScript generator, and a
deterministic comparator/validator that fails closed on omission, duplication,
extra entries, or elevation. None of these contracts creates, transfers,
installs, or authenticates a GitHub App; applies a ruleset, required check,
Actions policy, or GHAS setting; mutates a Project; mints a credential; or
selects a live deployment target. Every document carries an explicit
`nonAuthoritative` marker recording exactly which live effects it cannot
perform.

1. **`DeploymentTopologyPlan`**
   (`schemas/v1alpha1/deployment-topology.schema.json`,
   `src/deployment-topology.ts`) fixes the exact eight independent trust-service
   identities and four durable-store identities named in
   `docs/runbooks/deployment-prerequisites.md` in code, not in caller or model
   input. `planDeploymentTopology` always emits exactly these sets;
   `validateDeploymentTopologyPlan` rejects any ingested document — for
   example a stored or replayed plan — that omits, duplicates, or adds a
   service or store, that leaves a service without a budget, that narrows the
   eight required monitoring signals, that leaves a retained-artifact kind
   without a retention window, that declares a conflicting duplicate
   retention window for the same artifact kind (converting the retention
   list to a `Set` of artifact kinds for coverage checking is insufficient,
   since a second entry for an already-covered kind with a different window
   is a distinct object and passes membership), or that leaves a required
   protection scope
   undeclared. Key material never appears in the contract; only opaque key
   IDs matching the same pattern used elsewhere in this repository for
   non-secret identifiers.

   Independence between services and between durable stores is checked
   structurally, not merely declared. Every service carries a fixed,
   code-derived `identity.principalId` (`principal:<serviceId>`), validated
   exactly the same way `kind` already is; `signingKeyId` and `oidcAudience`
   must each be unique across all eight services. Every durable store carries
   a caller-supplied `identity.namespace` and `identity.credentialId`, both
   required unique across all four stores, and `kind` is validated exactly
   against the store's `storeId`. A plan that assigns every service the same
   signing key or OIDC audience, or every store the same backend namespace or
   credential, fails closed even though each individual field is otherwise
   well-formed — closing a gap where independence could previously be
   declared (via distinct `isolation` booleans) without being structurally
   enforced.

2. **`GitHubAppRegistrationPlan`**, **`GitHubAppInstallationTargetBinding`**,
   and **`GitHubAppPermissionReadback`**
   (`schemas/v1alpha1/github-app-registration-plan.schema.json`,
   `schemas/v1alpha1/github-app-installation-target-binding.schema.json`,
   `schemas/v1alpha1/github-app-permission-readback.schema.json`,
   `src/app-registration-plan.ts`) derive the exact least-privilege permission
   union from the reviewed `GITHUB_PERMISSION_MANIFEST` operation table.
   `planGitHubAppRegistration` reads only the manifest; no caller or model
   input can add, omit, or elevate a permission, and the function itself
   refuses to emit a permission on the manifest's denied list.
   `validateGitHubAppRegistrationPlan` independently re-derives `operations`,
   `deniedPermissionNames`, and `leastPrivilegeUnion` from the manifest and
   rejects an *ingested* plan whose values do not exactly match — not only a
   freshly generated one — closing a gap where a stored or replayed plan
   could drift from the manifest without being re-validated.

   The plan itself stays target-free per ADR 0004: it carries no
   installation ID, owner, or repository identity, because none exist before
   a human installs the App. `GitHubAppInstallationTargetBinding` is a
   separate, closed, human-approved record of the immutable owner/App/
   installation/repository-set identity actually observed after a separately
   performed installation, keyed by numeric and node identifiers rather than
   a mutable login or repository name. `compareGitHubAppPermissionReadback`
   checks, in order, before any permission is examined: (1) the plan itself
   still exactly matches the manifest via `validateGitHubAppRegistrationPlan`;
   (2) the readback's `planDigest` equals a canonical digest of the exact
   plan (the same plan/evidence binding pattern used elsewhere in this
   repository, for example `state.planDigest !== digest(plan)` in
   `src/github-adapter.ts`); (3) the approved target binding has not expired
   and the readback's `observedAt` falls within a caller-supplied freshness
   window — future or over-age observations are rejected without this module
   reading any clock; and (4) every owner/App/installation/repository-set
   field on the readback exactly equals the approved target binding. Only
   then are individual permissions compared, and a permission level that
   differs from plan *in either direction* — elevated **or** downscoped — is
   reported, closing a gap where a silently downscoped `read` in place of a
   planned `write` previously passed uninspected. Before individual
   permissions are compared, the readback's `observedPermissions` collection
   is checked for a duplicated permission key (`scope`+`name`): a
   schema-valid readback can contain both a `read` and a `write` object for
   the same key as two distinct array entries — `uniqueItems` treats them as
   non-identical objects — so indexing them directly into a `Map` keyed by
   permission key would silently resolve the conflict last-wins instead of
   failing closed on it. `GitHubAppPermissionReadback` also carries its own
   `nonAuthoritative` marker, compared field-by-field against the plan's by
   the comparator, closing a gap where a readback could otherwise silently
   report `false` for a claim (for example "cannot mint an installation
   token") the plan requires to be `true`.

3. **`AdministratorPlan`** and **`AdministratorReadback`**
   (`schemas/v1alpha1/administrator-plan.schema.json`,
   `schemas/v1alpha1/administrator-readback.schema.json`,
   `src/administrator-plan.ts`) declare the closed required-check catalog,
   Actions policy, and GitHub Advanced Security settings from
   `docs/security/ghas-administrator-runbook.md` and
   `docs/runbooks/customer-administrator.md`, plus repository-specific
   rulesets, environments, Project binding, and incident contacts. The
   repository target is bound by immutable numeric/node identity
   (`GitHubRepositoryIdentity`: `id`, `nodeId`, `owner`, `name`, `fullName`),
   never a bare full-name string, so a rename cannot silently redirect a plan
   to a different repository.

   Field names mirror the real GitHub REST/GraphQL surface: rulesets carry an
   explicit `source` of `repository` or `organization` because a repository
   can rely entirely on organization-owned rulesets with no classic branch
   protection at all, and `AdministratorReadback` carries
   `classicBranchProtectionObserved` so that absence is recorded as an
   observed fact rather than inferred as drift. Each ruleset also carries
   explicit `refConditions` (`include`/`exclude`) and the fully-resolved
   `effectiveProtectedRefs` those conditions produce.

   Rulesets are modeled as a **closed branch/tag discriminated union**
   (`AdministratorBranchRulesetPlan`/`AdministratorTagRulesetPlan`, and the
   corresponding readback types), keyed by `target`. GitHub exposes
   pull-request/CODEOWNERS/current-head-approval rule types only for a
   `branch`-targeted ruleset, and restrict-creation/-update/-deletion rule
   types only for a `tag`-targeted ruleset; a shape that made
   `requiresPullRequest` etc. unconditional regardless of `target` could
   describe an unsatisfiable tag ruleset (GitHub simply does not offer a
   pull-request rule type for tags). The union makes that shape
   unrepresentable at the type level, the JSON Schema `oneOf` rejects it at
   the document level, and both `validateAdministratorPlan` and
   `compareAdministratorReadback` branch on `target` before checking the
   variant-specific controls. `compareAdministratorReadback` also compares
   an observed ruleset's `source` and `target` exactly against the plan
   before evaluating any other field, closing a gap where a repository-owned
   or differently-targeted readback could otherwise be accepted under the
   same `rulesetId` and matching booleans.

   Every ref in this
   contract must be a **literal, fully-qualified ref name**: wildcard/glob
   metacharacters (`*`, `?`, `[`, `]`) and whitespace are rejected by both
   the JSON Schema pattern and `validateAdministratorPlan`, because exact-set
   subtraction (`include` minus `exclude`) is only sound over literal refs.
   Treating a glob pattern as a literal string is unsafe in either
   direction: an `exclude: ["refs/heads/*"]` intended to remove
   `refs/heads/main` from protection would not literal-string-match it and
   `effectiveProtectedRefs` would misstate `main` as still protected, while
   a live GitHub ruleset evaluating that same glob would not actually
   enforce it. Rather than reimplement GitHub's fnmatch semantics, this
   closed contract requires every ref to be enumerated literally; a ruleset
   that needs to describe multiple refs must use separate literal `include`
   entries or separate rulesets. `validateAdministratorPlan` requires
   `effectiveProtectedRefs` to equal `include` minus `exclude` over these
   literal refs, requires every protected ref to sit inside its target's
   namespace (`refs/heads/*` for a `branch` ruleset, `refs/tags/*` for
   `tag` — read here as a namespace prefix, not a glob, since the refs
   themselves are literal), and requires a ruleset whose ID implies the
   default main branch to actually protect `refs/heads/main` — closing a
   gap where a ruleset named for the default branch could quietly cover a
   different ref. `validateAdministratorPlan` also now checks every fixed
   GHAS/Actions control this contract promises (not a representative
   subset): every `true`-typed GHAS field, every `false`-typed GHAS field,
   `defaultWorkflowPermissions`, `shaPinningRequired`, and
   `requireApprovalForForkPullRequests`.

   `validateAdministratorPlan` and `compareAdministratorReadback` also
   reject a plan or readback that declares or observes the same
   `rulesetId`, `environmentId`, `checkName`, or incident-contact `role`
   more than once, checked before any lookup is built from that collection.
   Indexing a collection with a repeated key directly into a `Map` (as the
   comparator's per-collection lookups do) silently keeps only the last
   entry for that key, discarding a conflicting duplicate observation —
   for example a non-compliant `disabled` ruleset entry masked by a second,
   compliant `active` entry for the same `rulesetId` — instead of failing
   closed on the conflict.

   `compareAdministratorReadback` also requires **exact governed-set
   coverage** for rulesets, environments, and required checks: the readback
   is presented as complete administrator state, so an observed
   `rulesetId`, `environmentId`, or `checkName` absent from the plan is
   reported as drift, not merely never evaluated because the comparator
   only walked the planned side. This closes a gap where an unplanned extra
   ruleset — including one carrying a bypass actor the threat model
   otherwise requires to fail closed — or an unplanned extra environment
   with no protection rules could be silently accepted alongside a
   plan-satisfying observation. This contract does not yet distinguish an
   inherited, informational, out-of-scope ruleset or environment from a
   governed one; every observed entry must correspond to a planned one.

   `compareAdministratorReadback` requires the readback's `planDigest` to
   match a canonical digest of the exact plan, its `repository` identity to
   match the plan's, and its `observedAt` to fall within a caller-supplied
   freshness window, all before any field-level comparison. It then fails
   closed on a ruleset that is missing, not active, declares a bypass actor,
   or whose `refConditions`/`effectiveProtectedRefs`/`source`/`target`
   diverge from plan (catching, for example, a main-named ruleset that now
   covers `refs/heads/develop` in the readback even though the plan itself was
   never tampered with); on a required check that is not observed as
   required; on an environment with no protection rules; on any
   Actions-policy or GHAS field that diverges from plan, including fork
   pull-request approval; on `projectBinding.mutationRequiresExplicitConfirmation`
   drift, which was previously left uncompared; on any incident contact
   that is missing, extra, or substituted, compared as an exact
   role+handle set; and on any `nonAuthoritative` field that diverges from
   the plan's — `AdministratorReadback` carries the same marker as the plan,
   as booleans rather than `true` consts so a tampered readback claiming
   `false` for one of these fields can be represented and therefore rejected
   rather than the shape being unrepresentable. The comparator's returned issues are the sole compliance
   result. A readback's own `driftFound` field is never read by the
   comparator; `checkReadbackDriftCoherence` is a separate, additive check
   that a fixture's or caller's own `driftFound` claim agrees with the
   comparator's actual result, and it cannot suppress or override a real
   finding.

Both `validateDeploymentTopologyPlan` and the administrator/App comparators
perform closed-set completeness checks that plain JSON Schema cannot express
in a single constraint (a required set of specific enum values, all present,
none extra, none duplicated). This mirrors the existing pattern in
`GitHubAppCredentialBroker` (`src/github-auth.ts`), which already compares
minted-token permissions against `GITHUB_PERMISSION_MANIFEST` by exact set
by this same rationale: JSON Schema enforces per-item shape and closed
enums, and TypeScript enforces cross-field and cross-array invariants.

All three modules, plus the shared `src/freshness.ts` helper they use, are
deterministic and side-effect free: no network, environment, filesystem, or
clock read. Every timestamp — including the `now` used to evaluate a
freshness window — is caller-supplied.

`deployment-topology.ts`, `app-registration-plan.ts`, `administrator-plan.ts`,
`freshness.ts`, and the shared `duplicate-keys.ts` helper they use are
re-exported from `src/index.ts` as supported public
contracts for the durable-adapter and sandbox-composition work in issue
the durable-adapter implementation; `tests/pre-app-api-surface.test.ts` makes
that support intentional and
regression-proof.

## Consequences

- `config/v1alpha1/compatibility.json` and
  `schemas/v1alpha1/packaging.schema.json` gain three new
  `contractVersions` entries (`deploymentTopology`, `githubAppRegistration`,
  `administratorPlan`, all `1.0.0`); `docs/compatibility.md` documents them.
- `examples/pre-app/` provides six synthetic fixtures with no real
  identifier, credential, or key material, including a
  `GitHubAppInstallationTargetBinding` fixture and one administrator
  readback fixture that intentionally drifts from its plan (Actions allowing
  all instead of selected, pull-request review approval enabled, SHA
  pinning disabled, and an environment with no protection rules) so
  `compareAdministratorReadback` has an exercised failure path in
  `npm run validate:schemas`, not only in unit tests. The readback fixture
  models fresh live evidence as actually observed; it is never used as a
  substitute for the desired policy captured in the plan fixture.
- These contracts remain planning and readback evidence. Deploying the eight
  trust services, installing the App, and applying rulesets/checks/Actions
  policy/GHAS settings/Project bindings remain separate, explicit human
  administration governed by the existing runbooks; this ADR does not
  change that authority order.
- A future durable-adapter or sandbox-composition change
  later) that consumes these contracts must not widen the closed service,
  store, permission, protection, or GHAS/Actions control sets without a
  superseding ADR, must supply a `GitHubAppInstallationTargetBinding`
  obtained through separate human approval rather than deriving one from a
  readback, and must supply its own trusted `now` for every freshness check
  rather than trusting caller-supplied readback timestamps unchecked.
- A ruleset that needs a real GitHub glob/fnmatch ref pattern (for example
  protecting every `v*` release tag with one ruleset) cannot be represented
  by this closed contract as written; it must be decomposed into separate
  rulesets over literal refs, or a future superseding ADR must introduce and
  fully test real fnmatch-equivalent ref-matching semantics before glob
  patterns are accepted.

## References

- [Deployment prerequisites](../runbooks/deployment-prerequisites.md)
- [GitHub App permission manifest](../security/github-app-permissions.md)
- [GHAS administrator runbook](../security/ghas-administrator-runbook.md)
- [Customer administrator runbook](../runbooks/customer-administrator.md)
- [Secrets and identity model](../security/secrets-and-identity.md)
- [Threat-to-control matrix](../security/control-matrix.md)
- [Deterministic mechanical authority](0002-deterministic-mechanical-authority.md)
