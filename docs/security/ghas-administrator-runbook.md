# GitHub Advanced Security administrator runbook

This runbook records human-only settings. Automation in this repository must not
enable products, change rulesets, dismiss alerts, alter visibility, or grant
bypass.

## Current repository evidence

As observed on 2026-08-28, GitHub Advanced Security, Dependabot security updates,
secret scanning, non-provider patterns, validity checks, AI detection, and push
protection were enabled. Delegated alert dismissal and delegated bypass were
disabled. Recheck live settings before every release; this document is not
authority.

## Required administrator configuration

1. Keep private visibility until the license conflict is resolved by authorized
   legal/OSPO owners.
2. Require pull requests, CODEOWNER review, current-head approval, passing
   CodeQL and Dependency Review, typecheck/build/full tests, every checked-in
   schema/runtime/eval-fixture/provenance/workflow/gh-aw validation script,
   dependency audit, and diff check. Enforce these with reviewed required checks
   where available or retain exact human-run evidence before merge. Require
   signed commits if organizational policy requires them, and allow no automation
   bypass actor.
3. Keep CodeQL default setup or an equivalently reviewed advanced setup enabled
   for JavaScript/TypeScript and Actions.
4. Keep Dependabot alerts, security updates, secret scanning, push protection,
   validity checks, and non-provider patterns enabled.
5. Enable dependency review as a required pull-request check through the
   organization-approved workflow or ruleset. Do not add an unreviewed privileged
   workflow merely to satisfy this checklist.
6. Route alerts to named human security owners. Only a human security owner may
   dismiss an alert, with a documented rationale and exact commit evidence.
7. Verify the CODEOWNERS identity resolves and that required-review rules enforce
   it without App or administrator bypass.

## Verification

Capture repository security settings, applicable organization/repository
rulesets, code-scanning alerts by ref and commit, Dependabot alerts, secret
scanning alerts, required checks, and bypass actors. Separate pre-existing
default-branch alerts from findings introduced on the pull-request head. A
missing API permission or unavailable check is a blocker, not evidence of
success.

## Administrator plan and readback contract

`AdministratorPlan` and `AdministratorReadback`
(`schemas/v1alpha1/administrator-plan.schema.json`,
`schemas/v1alpha1/administrator-readback.schema.json`,
`src/administrator-plan.ts`; see
[ADR 0013](../adr/0013-pre-app-deployment-app-and-administrator-contracts.md))
give this runbook a machine-checked counterpart for rulesets, required
checks, Actions policy, and the GHAS settings above. The repository target
is bound by immutable numeric/node identity, never a mutable full-name
string. Field names mirror the real GitHub REST/GraphQL surface: a ruleset
carries an explicit `source` of `repository` or `organization`, since a
repository can rely entirely on organization-owned rulesets with no classic
branch protection at all, and `AdministratorReadback` records
`classicBranchProtectionObserved` as an observed fact rather than inferring
drift from its absence. Each ruleset also carries explicit `refConditions`
and the resolved `effectiveProtectedRefs` they produce, so a ruleset named
for the default branch whose conditions are quietly repointed at a
different ref is caught as drift rather than passing on rulesetId alone.
Every ref in this contract must be a literal, fully-qualified ref name —
wildcard/glob metacharacters are rejected outright, since exact-set ref
subtraction (`include` minus `exclude`) is only sound over literal refs and
this contract does not implement GitHub's fnmatch glob semantics. A ruleset
protecting refs via a glob pattern must be decomposed into separate
literal-ref rulesets. Rulesets are modeled as a closed branch/tag
discriminated union: a `branch`-targeted ruleset must require pull request,
CODEOWNERS review, and current-head approval, while a `tag`-targeted
ruleset must instead restrict tag creation, update, and deletion — the only
rule types GitHub exposes for a tag target — so a tag ruleset can never be
required to satisfy the branch-only controls. An observed ruleset's
`source` and `target` are compared exactly against the plan, not merely its
ID and booleans, so a repository-owned or differently-targeted readback
cannot stand in for an organization-owned or branch-targeted plan. Because
the readback is presented as complete administrator state,
`compareAdministratorReadback` also requires exact governed-set coverage
for rulesets, environments, and required checks: an observed ID absent from
the plan is reported as drift even when every planned entry is otherwise
satisfied — including an unplanned ruleset that itself carries a bypass
actor. `validateAdministratorPlan` and
`compareAdministratorReadback` also reject a plan or readback that declares
or observes the same rulesetId, environmentId, checkName, or
incident-contact role more than once, so a conflicting duplicate observation
cannot be silently discarded by a last-wins lookup.
`compareAdministratorReadback` first validates the supplied plan itself,
then requires the readback's `planDigest` and repository identity to match
the exact plan and its observation to fall inside a caller-supplied
freshness window before any field comparison, then
fails closed when a planned ruleset is missing, not active, carries a
bypass actor, or has drifted ref conditions, source, or target; when a
required check is not observed as required; when an environment has no
protection rules; when Actions policy or GHAS settings diverge from plan,
including Actions allowing all instead of a selected/local-only allowlist,
workflows able to approve pull-request reviews, disabled fork-pull-request
approval, or SHA pinning disabled; when a Project's mutation-confirmation
requirement drifts; when an incident contact is missing, extra, or
substituted; or when the readback's own `nonAuthoritative` marker reports
`false` for a field the plan requires to be `true`. A readback's
own `driftFound` field is checked only for coherence by
`checkReadbackDriftCoherence` and never overrides the comparator's actual
result. Synthetic examples, including one readback that intentionally
drifts from its plan to model fresh live evidence rather than the desired
policy, are in `examples/pre-app/administrator-plan.json` and
`examples/pre-app/administrator-readback.json`. Neither document applies a
ruleset, required check, Actions policy, or GHAS setting, or mutates a
Project.
