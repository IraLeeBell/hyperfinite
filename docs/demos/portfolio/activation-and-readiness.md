# Portfolio activation and readiness

## Classification

- **Repository/hermetic-demo-ready:** only when the exact repository head
  passes `npm run validate:hardening` and the complete repository validation
  matrix. This means the synthetic, offline demonstrations are reviewable and
  reproducible.
- **Sandbox/live: blocked:** until authorized human administrators complete
  every prerequisite below and an independently observed sandbox canary reaches
  Human Review.
- **Customer adoption:** requires the customer's architecture, security,
  operations, billing, legal/privacy, support, and release approvals after the
  live evaluation evidence is reviewed.
- **Credentialless synthetic sandbox evidence:** independently reported by
  `npm run canary:synthetic`; it is not App-backed sandbox readiness.

Repository delivery did not create a GitHub Project. It did not install or
configure a GitHub App, request a real ID or secret, alter a ruleset, enable
billing or inference, deploy a service, publish an artifact, approve a pull
request, dismiss a review, or merge.

## Required-value inventory

Do not put real values in repository fixtures. Human administrators supply the
following through protected deployment configuration only after merge and
independent review.

| Domain | Required values | Trusted source | Required owner |
|---|---|---|---|
| Repository | Numeric ID, node ID, exact owner/name, default ref, exact current SHA | Two stable authenticated reads | Repository administrator |
| Work item | Issue number and node ID; later draft PR number, node ID, base/head repository IDs, refs, and SHAs | Verified webhook plus fresh reads | Trusted binding service |
| Project | Organization owner node ID, exact Project/view/item node IDs, schema digest, fifteen field IDs, and every option ID | Fresh Project export and reviewed exact-target plan | Project administrator |
| App | App ID/client ID, installation ID, installation account node ID, selected repository IDs | GitHub App installation | Organization administrator |
| OIDC | Exact audience and allowlisted repository, workflow, workflow SHA, actor, event, run ID, and run attempt | Protected service policy | Trust-service owner |
| Signing | Active public key IDs and verification keys for state, redemption, evidence, provider usage, budget, grant store, and effects | Independent key registry | Security owner |
| Runtime | Deployed policy digest, Capability Registry digest, workflow source SHA, pinned compiler/action/CLI digests, and activation generation | Reviewed release manifest | Runtime owner |
| Billing | Explicit sandbox entitlement, maximum AIC/calls/tokens/cost, alert thresholds, and shutdown owner | Billing administrator | Billing owner |
| Protection | Ruleset IDs, required checks, CODEOWNERS, bypass actors, Actions allowlist, secret environments, retention, and incident contacts | Fresh administrative export | Security/repository owners |
| Services | Health identities and endpoints for ingress, state publication, redeemer, reservation ledger, signers, Evidence Ledger, grant store, broker, writer/reconciler, and isolated runner | Deployment inventory | Independent service owners |

Every value is exact and case-sensitive. A missing, duplicated, expired,
revoked, stale, or ambiguous value blocks activation. A Project field or issue
body never supplies authority.

## Administrator activation checklist

### Repository and Project prerequisites

1. Confirm the hardening change is human-merged through the repository's normal
   independent review.
2. Re-run the complete validation matrix on that exact merged SHA.
3. Reconcile exactly four supplied Projects, one for each catalog entry,
   from fresh read-only exports and `github:setup` dry-run plans.
4. Verify all fifteen fields, the fourteen-field projection mapping, and every
   option. Keep Requested Stage Agent as untrusted input, Target Repository
   display-only, and Stage last.
5. Record protected bindings for each Project/item and repository. Do not copy
   values from issue text or model output.
6. Confirm Projects remain projections: only Kernel state and signed receipts
   may lead them.

### Least-privilege GitHub App

1. Create a dedicated App with no PAT or `GITHUB_TOKEN` fallback.
2. Install it only on the selected sandbox repositories.
3. Configure the permission rows in
   [`github-app-permissions.md`](../../security/github-app-permissions.md) and
   no administration, merge, review-dismissal, auto-merge, deployment,
   publication, billing, team, visibility, ruleset, hook, or Actions-admin
   operation.
4. Keep read-only binding/authorization credentials separate from
   write-capable effect credentials.
5. Mint write-capable installation tokens just in time, for one repository and
   one operation, only after the Kernel result, authorization, effect plan,
   current-head evidence, and durable claim pass.
6. Keep the App private key and webhook secret inside the broker/ingress
   services. Never expose either, or an installation token, to a model job.

### Independent trust services

Deploy distinct identities and key custody for:

1. webhook verification and fresh Trusted Binding resolution;
2. runtime-state publication;
3. OIDC redemption, activation claims, and budget reservation;
4. threat, DLP, artifact-policy, review, provider-usage, and evidence signing;
5. durable Evidence Ledger and operation-grant claim storage;
6. operation-scoped GitHub App token brokerage;
7. serialized Single Writer and reconciliation; and
8. a credentialless, network-denied, sandboxed verification runner for fixed
   non-Git commands.

The broker, redeemer, signer, store, runner, or state publisher being disabled,
missing, unhealthy, or unverifiable is a typed block. There is no local,
model-job, ambient-token, unsigned, or success-shaped fallback.

### Rulesets, billing, and controls

1. Configure CODEOWNERS, required checks, branch protections, no automation
   bypass, approved Actions, protected environments, retention, monitoring, and
   incident contacts.
2. Verify GHAS, secret scanning, dependency review, and CodeQL on the exact
   canary head.
3. Preserve unrelated customer security findings. The evaluation cannot claim
   to fix or dismiss findings outside its exact authority.
4. Configure a fixed sandbox budget and alert thresholds. Exhaustion blocks;
   limits are never raised automatically.
5. Independently review the App permission export, Project export, ruleset
   export, billing ceiling, trust-service identities, public keys, software
   digests, and disaster-recovery evidence.
6. Keep live activation disabled until the sandbox canary is explicitly
   authorized.

## Kill switch

An authorized human administrator performs the kill switch in this order:

1. disable new activation and the affected capabilities;
2. stop the serialized Single Writer and automatic reconciliation;
3. revoke active leases, generations, runtime authorizations, effect grants,
   installation tokens, webhook secrets, and compromised signing keys;
4. preserve all run IDs, exact SHAs, claims, reservations, usage, receipts,
   ledger heads, Project observations, and audit chains;
5. reconcile already-started provider work only for authenticated usage and
   settlement; never advance a stage or mutate GitHub; and
6. leave every ambiguous effect blocked until stable exact readback proves the
   prior or intended postcondition.

Disabling a Project or changing a displayed field is not a kill switch because
Projects are non-authoritative.

## Backup, restore, and Evidence Ledger recovery

Back up encrypted, independently retained snapshots of:

- the Evidence Ledger head and complete signed chain;
- activation-claim, budget, provider-usage, run-fence, and operation-grant store
  heads and records;
- Kernel snapshots, applied results, Run States, stage artifacts, signed stage
  receipts, review bundles, and closure/cost-release checkpoints;
- Project and repository binding exports;
- public verification keys, key status, exact software/configuration digests,
  and retention metadata.

Restore into disabled services. Authenticate every head, signature, sequence,
predecessor, generation, target, and digest before enabling reads. Reconstruct
from the exact pre-transition Kernel snapshot and durable result. Never truncate
a chain, reset to a new genesis, decrement usage, recreate a receipt, or retry
an ambiguous write.

For a lost acknowledgement, perform two stable exact reads. Continue only if
they prove the intended record and postcondition. A conflict, missing record,
changing read, unknown provider usage, or unverifiable signature remains
blocked for human reconciliation.

## Key rotation and redaction

Publish and independently review a new public verification key before issuing
evidence under its key ID. Stop old-key signing, retain old verification keys
through the longest evidence lifetime, rotate service credentials
independently, and revoke all affected grants/generations after suspected
compromise. Never re-sign old evidence.

Logs contain fixed reason codes, counters, and digests only. They must not
contain prompts, responses, identities, repository names, paths, URLs,
credentials, tokens, secrets, or arbitrary labels. A redaction or serialization
failure blocks the sink and the dependent operation.

## Cost and provider reconciliation

Reserve the conservative maximum before provider start. Authenticate provider
attempt and usage evidence, settle known usage even when the provider fails or
returns after authority expiry, and release only the proven remainder. Unknown
usage retains the full hold and blocks later inference. Never infer zero usage,
trust model-reported cost, reset lifetime usage during repair/revision, or
blindly repeat reservation, settlement, or release.

## Drift response

Fresh-read and compare repository/default/current/base/head SHAs, issue and PR
identity, Project schema/fields/options/item, installation scope, App
permissions, OIDC policy, rulesets, required checks, billing, keys, service
health, policy/registry/workflow digests, and current generation before every
activation and mutation.

Any drift disables activation and writes, preserves evidence, and produces a
human-admin dry-run plan. Reconcile the authoritative source first, issue new
signed bindings and generations, then repeat independent review. Project drift
never advances or repairs Kernel state.

## Recovery drill

Before the canary and at the administrator-defined cadence:

1. restore ledger and grant-store backups into an isolated disabled
   environment;
2. replay signature, sequence, generation, target, and digest verification;
3. inject broker, redeemer, signer, store, runner, provider, settlement, Kernel,
   Run State, Project CAS/readback, branch, commit, draft-PR, COMMENT, closure,
   cost-release, and acknowledgement faults;
4. prove pre-inference/pre-mutation blocks and exact-readback-only
   reconciliation;
5. rotate one synthetic key and revoke one synthetic generation;
6. prove old grants, artifacts, receipts, fences, reservations, and effect
   grants cannot advance or mutate;
7. reconcile authenticated unknown provider usage without stage advancement;
8. run `validate:hardening` twice and compare bytes; and
9. obtain independent security and correctness review of the exact drill
   evidence.

## Sandbox canary and visibility

The repository-supported synthetic pre-App proof is:

```sh
npm run canary:synthetic
npm run handoff:administrator
```

It composes the full Human Review simulation with all fifteen durable adapters,
real cross-process SQLite races, restart/fault/backup recovery, a deterministic
fake provider, and ephemeral in-memory synthetic Ed25519 key material. The
command runs with a fixed credentialless child environment and a Node network
deny guard, emits target-free canonical signed evidence, and performs no live
effect. Passing it establishes only synthetic repository evidence; it does not
satisfy the live administration and deployment prerequisites below.

The administrator handoff command repeats the canary, binds all source contract
digests, evaluates the drift-prone administrator readback, and proves the exact
plan/confirmation/pre-read/one-attempt/post-read contract using synthetic data
only. It performs no administration. Follow the
[administrator handoff runbook](../../runbooks/administrator-handoff.md) for the
remaining human-only sequence.

After independently validating the merged hardening head, administrators may
choose to reconcile all four exact Projects, install/configure the
least-privilege App, deploy the independent trust services and isolated runner,
configure protected exact bindings/rulesets/billing/security controls, run
drift validation, and activate one synthetic sandbox canary.

The canary must start from fresh exact bindings, keep every external budget
bounded, create at most a draft pull request, produce exact-current-head
COMMENT-only review evidence, and stop at Human Review. It must not approve,
dismiss, mark ready, merge, deploy, publish, or release.

The four Projects may be visible earlier as clearly marked synthetic display
fixtures. Only after the canary reaches Human Review and independent humans
validate its complete evidence should they be considered runtime-usable in
sandbox. Merge or Project configuration alone does not activate them.

## Unsupported environments and residual risk

Unsupported: GHES or other environments not in the compatibility matrix,
unselected repositories, forks without exact dual-repository bindings,
unprotected branches, wildcard Apps, PATs, ambient credentials, model-visible
secrets, missing conditional stores, non-isolated runners, network-enabled
verification, autonomous administration, approval, dismissal, merge,
deployment, publication, or production use.

Residual risks include administrator bypass, compromised GitHub/provider/runner
or trust services, semantic detector false negatives, human error or collusion,
provider reporting lag, platform race windows, and privileged-human evidence
editing. Repository evidence reduces but does not eliminate those risks.
