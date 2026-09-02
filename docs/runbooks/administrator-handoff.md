# Pre-App administrator handoff

## Repository-only validation

From the exact reviewed repository head:

```bash
npm ci --ignore-scripts --no-audit --no-fund
handoff_output="$(mktemp -d)"
npm run handoff:administrator > "$handoff_output/report.json"
npm run handoff:administrator > "$handoff_output/report.second.json"
cmp "$handoff_output/report.json" "$handoff_output/report.second.json"
```

The optionless command accepts no path, target, credential, live, apply, retry,
or paid-inference argument. It runs the credentialless synthetic canary twice,
validates the existing deployment/App/admin contracts, checks all fifteen
durable adapters, builds and verifies both customer-starter profiles and their
open-source `no-go` evidence, creates a customer-safe synthetic-unconfigured
readback, and exercises only synthetic apply-contract data. It performs no live
effect.

The command requires a clean worktree before evaluation, captures exact
base/head SHAs, and rechecks both HEAD and complete status immediately before
emitting. Any concurrent tracked or untracked source drift refuses the report.
The generated synthetic readback contains no source-organization observation or
live target. Its snapshot digest binds observation time, handoff-plan digest,
source classification, synthetic target digests, all control statuses/evidence
metadata, readiness, and non-authoritative markers.

The report must remain:

- repository: `exact-head-validation-required`;
- credentialless synthetic sandbox: `passed`;
- App-backed sandbox: `blocked`; and
- customer adoption decision: pending the customer's governance process.

Do not retain either output file in the repository. Store reviewed evidence in
the protected evidence system with the exact commit SHA and software digests.

## Per-operation human gate

For every proposed live administrative mutation, a separately reviewed trusted
administrator service must:

1. create one `AdministratorApplyPlan` with the exact numeric/node identities
   for the owner and repository and every applicable Project item/field,
   environment, ruleset, App, installation, and billing account;
2. include the exact expected item/value counts and current values from a fresh
   authenticated read, plus a closed desired value set;
3. compute the canonical plan digest and obtain a separate explicit human
   `AdministratorApplyConfirmation` for that same digest;
4. fresh-read again immediately before apply and require exact target, count,
   value, plan, confirmation, authorization, and expiry equality;
5. atomically claim the plan-derived idempotency key and exact attempt ID in a
   durable trusted store; validate the human confirmation independently;
6. invoke one bounded trusted-adapter apply with GitHub App installation
   credentials held only inside that adapter and retain its signed attempt
   receipt;
7. perform a complete authenticated post-apply readback bound to the
   confirmation, pre-readback, attempt ID, attempt receipt, and desired state; and
8. stop without retry if acknowledgement is ambiguous. Disable the writer,
   reconcile stable exact reads, preserve evidence, and require a new plan and
   confirmation for any later effect.

The repository contains no apply implementation. Never substitute a PAT,
workflow token, model-job token, ambient environment credential, alternate
agent, default store, inferred target, widened allowlist, or success-shaped
fallback.

## Human-only sequence

Complete the controls in the plan's fixed dependency order:

1. register the private App under the authorized owner; transfer ownership only
   under a separately confirmed exact plan whose source and destination numeric,
   node, and case-insensitive login identities are all distinct; install it only on the reviewed
   repository set; then read back immutable App/installation/account/repository
   identities;
2. configure exactly the reviewed permissions and events; bind webhook and OIDC
   identity; place opaque App/webhook/signing key handles in independent
   custody; prove rotation and revocation without reading key material;
3. deploy the four independent durable stores, broker, Single Writer, and
   isolated credentialless runner; restore backups into disabled services and
   prove corruption/replay/unknown-usage refusal;
4. create main protection with pull request, CODEOWNERS, current-head review,
   required checks, no automation bypass, selected/SHA-pinned Actions, no
   workflow approval permission, GHAS/CodeQL/Dependency Review/secret scanning,
   and protected environments;
5. configure health, latency, error, budget, signing, replay, store-availability,
   and journal-capacity monitoring; set alert owners; configure approved
   log/artifact/data retention;
6. select a sandbox provider/billing account, fixed budgets, usage
   reconciliation, and shutdown owner; keep inference disabled until the final
   confirmed activation plan;
7. run kill-switch, key/generation revocation, backup/restore, disabled recovery,
   incident-response, and customer-transfer drills;
8. complete legal/OSPO/privacy/trademark/support/signing review. The existing
   open-source assessment remains `not-ready`; do not change LICENSE,
   visibility, publication, or release state here;
9. log in as the authorized human administrator, fresh-read every target and
   control, produce the final complete readback, and independently review it;
10. separately authorize one bounded App-backed sandbox canary. It may create
    only a draft PR, emit current-head `COMMENT` review evidence, and must stop at
    Human Review.

## Customer-specific readback

The repository stores no source-organization readback. The optionless command
emits a synthetic-unconfigured baseline so every customer gate is visible
without embedding a live identity.

A customer trusted administrator service creates the real
`authenticated-live-current` readback from fresh protected sources. Store that
readback in the customer's evidence system, not in the copied repository.

## Customer and open-source boundary

Exported artifacts contain synthetic contracts and the non-authoritative no-go
assessment only. A clean scan, SBOM, deterministic archive, or customer transfer
plan does not decide license, OSPO, visibility, publication, signing, customer
installation, release, or deployment authorization.
