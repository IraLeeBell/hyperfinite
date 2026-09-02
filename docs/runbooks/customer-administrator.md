# GHEC customer administrator installation runbook

This is the canonical detailed runbook for customer installation, upgrade,
rollback, recovery, and uninstall. Begin with the
[customer evaluation guide](../../CUSTOMER_EVALUATION_GUIDE.md), then open the
[approval tickets](customer-approval-tickets.md).

## Safety posture

This runbook is for GitHub Enterprise Cloud. GitHub Enterprise Server is
unsupported and unverified. Use placeholders and authenticated reads from the
intended customer tenant; never copy identifiers, credentials, logs, or data
between customers.

Repository automation may generate schemas, plans, manifests, checksums, SBOM,
provenance, unsigned attestations, receipts, and validation evidence. Human
administrators separately own App/OIDC installation, Projects, rulesets,
required checks, GHAS, billing, teams, visibility, enterprise policy,
monitoring, retention, signing, deployment, and publication. Automation must
not perform or infer those steps.

## Prerequisites and backup

1. Keep runtime enablement and every write capability disabled.
2. Confirm the customer repository passes:

   ```bash
   npm run validate:customer-readiness
   ```

3. Run `npm run customer:configure -- --codeowner
   @<customer-organization>/<customer-team>` and confirm that user/team has
   repository write access.
4. Confirm the exact supported toolchain in
   [`docs/compatibility.md`](../compatibility.md). Refuse unknown versions.
5. Obtain independent administrator, security, product, and change-management
   authorization. Legal/OSPO approval is additionally required for distribution
   or publication.
6. From authenticated fresh reads, record the enterprise slug, organization
   login, repository numeric/node/full identity, App installation ID, default
   ref, and exact customer head SHA. Separately record the release source
   base/head from the verified release manifest; the source and customer heads
   are not expected to match. Never ask a model to discover or choose them.
7. Export repository rulesets, required checks, Actions policy, environments,
   variables, App permissions, Project schema/binding, GHAS settings, teams,
   visibility, billing controls, runtime policy, receipt-chain head, and package
   inventory. Store the encrypted backup outside the model/runtime boundary.
8. Record backup digests and retention location in the installation evidence
   store and create a closed `InstallationBackupEvidence` record bound to the
   target, observed state, and receipt-chain head. A migration requires
   `backup-evidence-present`; a prose assertion is insufficient.

## Dry run and validation

1. Copy `examples/customer-installation/installation.json` to a reviewed
   administrator workspace.
2. Replace all synthetic identity values from authenticated reads. Set the
   selected release- and migration-manifest digests, expected state digest,
   receipt sequence and head, operation, exact package version, and an exact
   expected result head precomputed by trusted code from the target parent and
   selected package bytes. Keep:

   ```json
   {"apply":{"enabled":false,"humanChangeId":null}}
   ```

3. Validate the source package independently:

   ```bash
   npm ci --ignore-scripts --no-audit --no-fund
   npm run validate:customer-readiness
   npm run typecheck
   npm run build
   npm test
   npm run validate:schemas
   npm run validate:provenance
   npm run validate:runtime
   npm run validate:eval-fixtures
   npm run validate:workflows
   npm run validate:gh-aw
   npm run validate:packaging
   npm audit --audit-level=high
   git diff --check origin/main...HEAD
   npm run validate:demos
   npm run simulate:demos
   npm run validate:hardening
   ```

4. Run `npm run installer -- plan --config <reviewed-relative-path>
   --release-manifest <verified-relative-path> --state
   <authenticated-relative-path> --backup-evidence
   <backup-evidence-relative-path> --receipts <journal-relative-path> --output
   <new-relative-path>`. Inputs and output must remain beneath the repository,
   cannot be symlinks, and are opened without overwrite. The plan exposes the
   exact migration-manifest digest, directional step checksum, and digest for
   every enforced migration precondition.
   A non-empty receipt journal additionally requires a trusted
   `InstallationReceiptVerifier`; the generic CLI intentionally refuses to
   self-assert signature validity. Invoke the library from the trusted
   administrator service that owns the pinned verification key.
   `npm run installer -- offline-validate` is only an offline repeat over those
   files; it is not a live target read. For live validation, the trusted
   administrator service must call `validateLiveInstallationPlan` with current
   human authorization and a read-only trusted adapter, then retain the signed
   target/state/head-bound validation evidence. The legacy ambiguous `validate`
   command is rejected.
5. Repeat the plan in an independent clean workspace. Canonical plan bytes and
   digest must match. Any target, head, state, journal, version, checksum,
   compatibility, or action difference is a no-go.
6. Inspect every action. Package writes must target only closed manifest paths.
   Removal must refer only to exact package-owned files and preserve evidence
   paths. No action may equal, contain, or be contained by a retained evidence
   path at a slash boundary. There is no arbitrary command or recursive deletion
   action.
   The final plan embeds the full selected configuration, release manifest,
   migration manifest, expected pre/post installation states, and nullable last
   stable recovery state. Apply-side validation must re-run migration selection
   and re-derive actions, preconditions, and the current-operation evidence path
   before consulting authorization or the trusted adapter.
7. After provisional review, set `apply.enabled: true` and the approved human
   change ID, then generate one final plan. The CLI still performs no mutation.
   Review and sign that exact final plan digest, idempotency key, expected result
   head/state, actions, and evidence paths. Do not sign an earlier
   apply-disabled plan and do not change configuration after signing.

## Human-authorized apply

The checked-in CLI cannot apply. A deployment team must first implement and
independently review the `TrustedInstallationAdapter` with:

- GitHub App installation credentials held only in the trusted adapter;
- no PAT, model-job credential, environment-token, or network fallback;
- exact installation/repository/ref/head verification;
- signed human authorization validation and expiry;
- freshness from a protected adapter clock, never caller-supplied time;
- immediate pre-call freshness revalidation plus atomic authorization-expiry,
  expected-state/head, and idempotency enforcement with the effect;
- signature, target, sequence, predecessor, and state-continuity validation for
  every non-empty receipt journal, including terminal applied-head equality with
  the observed target;
- state and receipt compare-and-swap;
- one immutable snapshot of each untrusted input before validation or adapter
  use;
- one idempotency key per canonical plan;
- one effect attempt without blind retry;
- signed receipt append, exact state reconciliation, and authoritative
  receipt-store reread after apply and during recovery; and
- bounded redacted evidence with no customer data.

Receipt journals are capped at 512 entries before any element is cloned or
validated. The repository has no compaction/checkpoint implementation. When the
chain reaches capacity, stop: retain and externally archive the complete signed
chain, then deploy an independently reviewed authenticated checkpoint protocol
before further planning. Never truncate the journal, reset its sequence/head, or
reuse genesis.

After humans approve the final apply-enabled canonical plan, they may create a
short-lived signed `InstallationAuthorization` and invoke the trusted adapter
outside the model job without changing the plan or configuration. Head or state
drift requires a new dry run and approval. Never weaken policy to make an old
plan fit.

## Upgrade

Select one contiguous edge sequence from
`config/v1alpha1/migrations.json`. Verify every step checksum, precondition,
irreversible declaration, rollback support, and expected source version. Back up
first, dry-run twice, obtain new human authorization, apply once, retain every
receipt, and validate the exact resulting state. Unknown or skipped versions are
blocked.

## Rollback

Rollback is a new human-authorized operation, not an automatic exception path.
Use a verified historical release manifest and traverse only explicit reversible
migration edges. Do not claim rollback for an irreversible step. Repository
content changes remain pull-request only; administrators separately reverse App,
Project, ruleset, team, visibility, billing, or enterprise settings.

## Recovery and lost acknowledgements

Disable the writer. Fresh-read the exact target and signed receipt chain. Never
repeat an effect because the caller timed out. If the exact persisted
idempotency receipt and result state agree, an expired original authorization
does not block non-mutating reconciliation; it may return that receipt without
another effect. If persistence is absent, they disagree, a plan
digest does not recompute, or no authoritative evidence proves prior or intended
state, mark the state ambiguous and escalate for manual recovery. A partial
state accepts only `recover`, which reconciles exact package files and preserves
evidence.
For a journaled partial state, pass the authenticated last completed stable
state with `--recovery-base-state <relative-path>` and bind its digest in
`recoveryBaseStateDigest`; normal operations require that field to remain null.
Migration source version, irreversibility, and stable evidence retention derive
from that recovery base, never from partially applied version claims.

Installer input/output arguments must be canonical repository-relative paths.
Absolute, backslash, empty, `.`, `..`, and exact `.git` segments are refused
before resolution. The CLI also resolves Git's actual directory and common
directory, so separate metadata locations cannot be entered.

## Uninstall

Back up and dry-run an `uninstall` plan. It may remove only files in the
authenticated package-owned inventory whose complete path, digest, mode, and
size exactly match the installed-version release manifest. Every removal
requires explicit destructive approval. Preserve customer
content, Issues, Projects, pull requests, audit/receipt chains, backups, and
release evidence. Do not recursively delete a repository or infer admin cleanup.
Human administrators decide whether to remove the App, OIDC trust, rulesets,
Projects, secrets, billing, teams, or monitoring after required retention.

## Evidence to retain

Retain the selected release manifest/archive/SBOM/provenance/attestation and
checksums; compatibility and migration manifests; backups; both dry-run plans;
human change and signed authorization; pre/post authenticated state; signed
receipt chain; exact-head validations/reviews/alerts; administrator changes; and
all rollback, recovery, or uninstall observations. Generated unsigned evidence
does not replace a protected release signature or human approval.

## Deployment topology and administrator plan/readback contracts

Before any App installation covered by this runbook, provision the eight
independent trust-service identities and four durable stores fixed by the
closed `DeploymentTopologyPlan` contract
(`schemas/v1alpha1/deployment-topology.schema.json`,
`src/deployment-topology.ts`), record the immutable installation identity a
human separately approves in a `GitHubAppInstallationTargetBinding`
(`schemas/v1alpha1/github-app-installation-target-binding.schema.json`,
`src/app-registration-plan.ts`), and configure rulesets, required checks,
Actions policy, GHAS settings, environments, and Project binding against the
closed `AdministratorPlan` contract
(`schemas/v1alpha1/administrator-plan.schema.json`,
`src/administrator-plan.ts`). See
[ADR 0013](../adr/0013-pre-app-deployment-app-and-administrator-contracts.md),
[deployment prerequisites](deployment-prerequisites.md), and the
[GHAS administrator runbook](../security/ghas-administrator-runbook.md) for
the full contract and its fail-closed comparators, including the exact
target-identity binding and caller-supplied freshness window every
permission and administrator readback must satisfy. These plans, target
bindings, and readbacks are evidence for this runbook's human decisions;
they cannot themselves install the App, apply a ruleset or Actions/GHAS
setting, or mutate a Project.

Before any live administrative step, run the repository-only
[`administrator handoff`](administrator-handoff.md). For each proposed mutation,
create one exact `AdministratorApplyPlan`, obtain a separate human confirmation
of its canonical digest, fresh-read expected counts and values, make at most one
trusted-adapter attempt, and complete the post-apply readback. An ambiguous
acknowledgement is reconciliation-required and must never be retried.
