# Deployment prerequisites

Customer activation begins only after authorized humans complete and
independently review every applicable prerequisite.

Use the [copy-ready approval tickets](customer-approval-tickets.md) and record
ticket IDs in the customer's protected change-management system.

## Customer prerequisite matrix

| Workstream | Required owner | Required outcome | Minimum evidence |
|---|---|---|---|
| Evaluation scope | Executive sponsor and evaluation lead | Repository, users, dates, demos, budget, success measures, and stop conditions approved | Approved evaluation/change ticket |
| Repository | Repository administrator | Customer-owned private repository, real CODEOWNERS team, default-branch ruleset, required checks, selected/SHA-pinned Actions | Fresh settings export and exact-head review |
| Projects | Organization/Project administrator | Four private empty Projects, linked repository, confirmed target-manifest digest, applied plan, complete readback | Target manifest, confirmation, plan, API readback, and manual-view screenshots |
| GitHub App | Organization owner | Customer-owned App installed only on selected repositories with exact permissions | App/installation identity and permission readback |
| OIDC and keys | Identity/security owner | Exact repository/workflow audiences, independent signing keys, rotation, revocation, protected custody | OIDC policy, public-key registry, rotation/revocation drill |
| Trust services | Platform owner | Independent ingress, state publisher, redeemer, signer, store broker, token broker, Single Writer, installer, and isolated runner | Deployment inventory, health, identity, and network-policy evidence |
| Durable stores | Platform/data owner | Four isolated conditional stores with CAS, replay refusal, bounds, backup, and restore | Store bindings, fault tests, encrypted backup, disabled restore |
| Security | Security owner | Threat/control review, GHAS controls, secrets policy, incident response, residual-risk approval | Security ticket, scans, CodeQL/Dependency Review, tabletop |
| Billing | Billing owner | Entitlement, per-run/daily limits, alerts, reconciliation source, shutdown owner | Approved budget ticket and alert test |
| Legal/privacy | Legal/privacy owner | License, data classes, provider terms, retention, residency, and feedback path approved | Written disposition in customer system |
| Operations/support | Operations owner | Monitoring, support contacts, pause/rollback/kill-switch thresholds, evidence retention | Runbook sign-off, dashboard/alert test, recovery drill |

## Independent trust services

Deploy separate service identities and key custody for:

1. webhook verification and fresh Trusted Binding resolution;
2. runtime-state publication;
3. OIDC-authenticated authorization redemption and budget reservation;
4. threat, DLP, artifact-policy, and evidence signing;
5. durable conditional evidence and operation-grant claim storage;
6. operation-scoped GitHub App token brokerage;
7. the serialized Single Writer and reconciler; and
8. a target-bound installation adapter and protected release-signing service.

Do not collapse a model runner, reviewer, or untrusted Actions job into any of
these trust services. Each service must enforce an exact OIDC audience and
repository/workflow allowlist, use independent signing keys, deny network and
secret access not explicitly required, expose health without secret material,
and fail closed when its dependency or durable store is unavailable.

## Acceptance

Exercise nonce and operation-grant replay across processes, CAS conflicts,
revocation, key rotation, expired evidence, budget exhaustion, detector
unavailability, current-head changes, partial writes, restore from backup, and
complete credential/log redaction. Preserve signed evidence and exact software
digests. Keep runtime enablement false until all tests pass and owners sign off.

The local reference proof in
`tests/durable-store-composition.test.ts` wires all fifteen ports through the
exact synthetic `DeploymentTopologyPlan`, compares uninterrupted execution with
a close/reopen after every durable boundary, and covers backup/restore,
disabled-state recovery, corruption, stale/replay/revocation, budget
exhaustion, ambiguous acknowledgement, and landed lost-ack outcomes. This is
repository evidence only and does not satisfy prerequisite item 5.

For the four-demo portfolio, use the consolidated
[activation and readiness checklist](../demos/portfolio/activation-and-readiness.md).
Repository and hermetic evidence does not satisfy a live deployment gate.

`npm run canary:synthetic` composes that durable proof with the closed full
portfolio journey under a credentialless child environment and Node network deny
guard. It emits deterministic target-free evidence and stops at Human Review.
It does not satisfy prerequisite item 5, deploy a trust service, or establish
live sandbox readiness.

`npm run handoff:administrator` is the exact repository-only convergence path.
It binds the topology, App/admin plans, fifteen-adapter mapping, repeated canary,
customer-starter selections, open-source no-go assessment, LICENSE bytes, and
drift-prone readback under canonical digests. It performs no apply. See the
[administrator handoff](administrator-handoff.md).

The eight trust-service identities and four durable-store identities above are
fixed in the closed, versioned `DeploymentTopologyPlan` contract
(`schemas/v1alpha1/deployment-topology.schema.json`,
`src/deployment-topology.ts`; see [ADR 0013](../adr/0013-pre-app-deployment-app-and-administrator-contracts.md)).
`planDeploymentTopology` always emits exactly these services and stores;
`validateDeploymentTopologyPlan` fails closed on an ingested document that
omits, duplicates, or adds one, that leaves a service without a budget, that
narrows the required monitoring signals, or that leaves a retained-artifact
kind or protection scope undeclared. Independence is checked structurally,
not merely declared: every service's `identity.principalId` and every
durable store's `kind` must exactly match a fixed, code-derived expectation,
and `signingKeyId`/`oidcAudience` across services and `namespace`/
`credentialId` across stores must each be unique — a plan that assigns
every service or store the same identity fails closed even though every
individual field is otherwise well-formed. A synthetic example is in
`examples/pre-app/deployment-topology.json`. The plan is deployment-planning
evidence only; it does not provision a service, mint a credential, or select a
live target.

Before customer installation or release, also exercise installer target
substitution, stale-head/state CAS, idempotency replay, migration skip/downgrade,
irreversible rollback, partial/lost-ack recovery, bounded uninstall, archive
traversal/link/type/mode tampering, independent byte reproduction, SBOM and
attestation binding, unsigned-trust refusal, and
`npm run validate:packaging`. Keep apply, signing, publication, and deployment
disabled until the separately authorized human gates in the customer runbook
are complete.
