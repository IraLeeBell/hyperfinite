# ADR 0018: The administrator handoff is plan, confirm, and readback only

- **Status:** Accepted
- **Date:** 2026-09-01

## Context

ADR 0013 defined separate deployment, GitHub App, and administrator contracts.
ADR 0014 added the nonproduction four-store composition and its fifteen durable
adapters. ADR 0015 added customer-starter and open-source no-go evidence, and ADR
0017 composed the repository journey and durable recovery proof into one
credentialless synthetic canary.

Those surfaces did not provide one deterministic administrator handoff. A human
operator still had to correlate several plans and runbooks, and there was no
single contract requiring every proposed administrative mutation to bind exact
targets, expected counts and values, a closed desired state, a canonical digest,
a separate confirmation of that digest, a fresh pre-apply read, one attempt, and
a complete post-apply readback.

## Decision

Add the closed `AdministratorHandoffDocument` family in
`schemas/v1alpha1/administrator-handoff.schema.json` and
`src/administrator-handoff.ts`.

`AdministratorHandoffPlan` is target-free and deterministically binds canonical
digests for the deployment topology, App registration plan, administrator plan,
fifteen-port durable mapping, synthetic canary evidence, both customer-starter
selections, open-source no-go assessment, and exact LICENSE bytes. Its fixed
27-control catalog covers App ownership/installation, Project binding/projection, permissions/events,
webhook/OIDC, key custody/rotation, stores and recovery, broker, Single Writer,
runner isolation, repository protections, Actions, GHAS, environments,
monitoring, retention, provider/billing/budgets/usage, kill switch, incident
response, customer transfer, open-source review, final readback, live sandbox
canary, and production decision.

Every mutation-capable control requires a separate `AdministratorApplyPlan`.
That plan contains the exact owner and repository identities plus every
operation-applicable Project, environment, ruleset, App, installation, and
billing identifier; a counted, sorted, duplicate-free current state; a counted,
sorted, duplicate-free desired state whose keys and value domains come from the
fixed per-control manifest; responsible owner, trusted target source, readback
procedure, rollback mode; and the complete per-control prohibited-effect set.
`AdministratorApplyConfirmation` is a separate human record bound to the
canonical apply-plan digest. `validateAdministratorApplyGate` accepts only a
current, unexpired plan and confirmation whose fresh pre-apply readback exactly
matches the expected target, count, and values. Its result means only ready for
trusted-adapter authentication and durable attempt claiming; it is not effect
authority and exposes no effect adapter.

`AdministratorApplyReadback` records zero attempts before apply or exactly one
after apply and binds the exact attempt ID, confirmation, pre-readback, and
trusted-adapter attempt receipt. An ambiguous acknowledgement is always
`reconciliationRequired`, even when a read appears to match, and cannot be
retried. A post-apply result is accepted only when the complete readback exactly
matches the desired state.

`AdministratorHandoffReadback` is explicitly drift-prone evidence. The
repository command generates a plan-bound `synthetic-fixture` readback with no
live target. A customer trusted adapter may instead produce an
`authenticated-live-current` readback. Both bind source, per-target identity
digests, per-control statuses, and readiness classification under a snapshot
digest. Raw live target identifiers remain in protected customer evidence and
only enter an exact per-operation apply plan.

`npm run handoff:administrator` is an optionless repository-only command. It
validates the existing contracts, runs the synthetic canary twice under a fixed
credentialless environment, checks the fifteen-port mapping, validates and
verifies both customer-starter bundles plus their open-source no-go evidence,
generates a synthetic-unconfigured readback, exercises a synthetic
plan/confirmation/pre/post readback sequence without an effect, and emits one
canonical report. It accepts no caller-selected path, target, command,
credential, or live/apply flag.

Customer artifacts receive the contract, schema, tests, synthetic examples, and
runbooks without source-organization observations. The demo profile includes a
synthetic target-manifest example. Customer target manifests are generated from
fresh customer snapshots and must match a separately confirmed digest.
The shared internal-reference scanner rejects non-synthetic Project, view, item,
field, and option node identities.
The hermetic simulator also uses only synthetic Project/owner identities; live
Project identities never enter customer-runnable simulation source or evidence.
The same private-evidence path set is excluded from npm package materialization;
the package remains private and the open-source/release decision remains no-go.

## Consequences

- There is one exact pre-App validation path without creating an App, handling a
  key, enabling billing, deploying, or mutating GitHub administration.
- Missing, duplicated, stale, expired, wrong-target, changed-current,
  ambiguous, or weakened evidence authorizes nothing.
- The command's report enumerates a synthetic-unconfigured customer gap set but
  cannot fix it or turn repository/synthetic evidence into live readiness.
- GitHub API observations remain drift-prone inputs. Exact target selection and
  credentials remain inside a separately reviewed trusted adapter.
- Legal, OSPO, visibility, publication, signing, licensing, customer
  installation, release, and adoption decisions remain human-only.

## References

- [Administrator handoff runbook](../runbooks/administrator-handoff.md)
- [Administrator handoff architecture](../architecture/administrator-handoff.md)
- [Deployment prerequisites](../runbooks/deployment-prerequisites.md)
- [Customer administrator runbook](../runbooks/customer-administrator.md)
- [Synthetic sandbox canary](../runbooks/synthetic-sandbox-canary.md)
- [Threat model](../security/threat-model.md)
- [Control matrix](../security/control-matrix.md)
