# Recovery and rollback

Recovery is a new authorized operation, not a continuation of stale model output.

1. Keep the runtime and writer disabled while evidence is ambiguous.
2. Restore the durable Evidence Ledger and operation-grant claim store from the
   latest authenticated backup; verify signed heads and monotonic sequences.
3. Fresh-read repository, issue, Project, pull-request, review, check, permission,
   team, lease, policy, and billing state.
4. Reconcile each pending or partial effect against its exact target-specific
   postcondition. Never blindly retry an effect after an unknown acknowledgement.
5. Revoke stale nonces, grants, leases, and keys. Issue replacements only after
   current policy and human approval.
6. Roll back repository content through a reviewed pull request. Human
   administrators separately reverse App, ruleset, Project, visibility, team,
   billing, or enterprise-policy changes.
7. Run full validation and independent exact-head security/code review before
   re-enabling.

If authoritative evidence cannot prove either the prior or intended state, leave
the work blocked for manual reconciliation. Do not fabricate a receipt, reset a
chain head, lower a budget, or mark the operation successful.

## Autonomous demo runtime recovery

Reconstruct one immutable view from the exact Demo Run State, Kernel snapshot
and receipt head, current Work Accord and lease, budget ledger, ordered signed
stage receipts and artifacts, linear run-fence chain, persisted dispatch
decision, provider usage, and Project observation.

- A duplicate exact decision, receipt, activation claim, reservation, or effect
  returns its prior authenticated record; conflicting content is a replay
  refusal.
- An acquired fence with no conclusive provider usage is released only after
  usage reconciliation; unknown usage remains fully held and blocks later
  inference.
- An ambiguous claim, reservation, settlement, receipt, Project write, or
  Kernel/run-state persistence operation is never repeated blindly. Accept it
  only when stable readback proves the exact intended digest; otherwise leave
  the run in typed reconciliation.
- Pause and block preserve the journey cursor. Resume preserves it. A blocked
  retry or non-terminal recovery increments the attempt and authority
  generation. `blocked.cancel` is terminal, preserves both, and requires no
  recovery-budget write. Scope repair, verification repair/replan, and
  human-requested revision increment generation and truncate only the affected
  canonical stage suffix. Persist the matching signed recovery-budget
  retry/generation transition before the recovered Run State; never reset
  lifetime usage. Cancellation is terminal.
- Persist and read back the applied Kernel transition first, then the signed
  stage receipt and Demo Run State. Converge Project fields only afterward,
  with Stage last.
- Reject legacy runtime evidence without both full GitHub and Kernel binding
  digests. Never translate or copy one digest into the other during recovery.

If projection is ahead of Kernel, receipt heads differ at the same Kernel
version, a stage/fence chain forks, usage cannot be authenticated, or either
binding domain changes, keep inference and the Single Writer disabled for
manual reconciliation.

The portfolio-specific backup inventory, kill switch, key rotation, provider
unknown-usage handling, drift response, and recovery drill are consolidated in
[activation and readiness](../demos/portfolio/activation-and-readiness.md).

## Packaging and installation recovery

Keep the trusted installation adapter disabled. Revalidate the exact
enterprise/organization/repository/installation/ref/head binding, release and
migration manifests, observed package-owned file inventory, backup digests, and
complete signed receipt chain. Never repeat an apply after a timeout or lost
acknowledgement. If the exact idempotency receipt and expected result-state
digest agree, return the prior receipt without another effect. Otherwise mark
the state ambiguous and require manual reconciliation.

The local contract refuses receipt journals above 512 and does not implement
compaction. Capacity recovery requires external archival of the complete signed
chain and a separately reviewed authenticated checkpoint protocol. Truncating
history, resetting sequence/head, or starting a new genesis would permit replay
and is prohibited.

A partial installation accepts only a new human-authorized `recover` plan.
Rollback traverses explicit reversible migration edges. Uninstall removes only
exact digest-matched package-owned files and preserves customer content,
backups, receipts, audit evidence, and release evidence. Human administrators
separately reverse App, OIDC, ruleset, Project, GHAS, billing, team, visibility,
monitoring, or enterprise-policy changes.

## Local durable substrate backup and recovery drill

Applies to the nonproduction local reference substrate (ADR 0014), not to the
deployed durable store of deployment prerequisite item 5.

### Backup

1. Keep the runtime and Single Writer disabled. For the complete composition,
   supply one new canonical absolute backup root and call
   `backup(destinationRoot)`. Its parent must be privately owned and not
   group/other writable. The composition atomically creates the root as mode
   `0700`, uses fixed store filenames, and rechecks directory identity around
   every copy. A relative, existing, aliased, or live-store destination refuses
   before any copy starts. For one substrate, call
   `backup(destinationPath)` with an exact absolute path.
2. Retain the returned `DurableStoreBackupManifest`. It binds the store id,
   format version, per-namespace sequence, head, and entry count, and is
   schema-validated as `DurableStoreBackupManifest`.
3. For a complete composition, retain the returned
   `DurableStoreCompositionBackupManifest` with the four store manifests. Its
   recomputed `backupSetId` and signature bind the exact store-manifest digests,
   topology digest, and signed writer-disabled generation/checkpoint. The
   quiescence guard must return the same authenticated observation before and
   after all four copies, and both reads must be current under the injected
   trusted clock. Do not reconstruct or mix this set manually.
4. Treat the manifests as evidence of observed chain state only. They are marked
   `nonAuthoritative` and grant no capability.

### Restore

1. Leave the runtime and writer disabled for the whole drill.
2. Restore all four composition files as one set; do not mix manifests or store
   files from different backup operations.
3. Open the restored copy. Opening re-runs `PRAGMA integrity_check` and the
   `user_version` format gate; a corrupt or foreign-format file refuses rather
   than being read on a best-effort basis.
4. Call `verifyRestoredBackup(backupSet)` for the composition, or
   `verifyChain(namespace)` for every namespace in one store's manifest, and compare
   the resulting head, sequence, and entry count against the manifest. A
   mismatch means the copy is not the backup the manifest describes.
5. Confirm each restored record still re-derives its own digest and chain link.
   This happens automatically on read; a refusal here means the bytes changed.
6. For the composition, require the exact inventory of every restored namespace
   to equal the manifest set. An extra namespace, a mixed store manifest, or a
   changed topology is `RESTORE_MISMATCH`.
7. Only after every namespace in every store verifies, allow new writes. A
   restored copy continues the existing chain rather than starting a new one.

### Reconciling an ambiguous acknowledgement

The store rolls back best-effort before reporting ambiguity, so the write lock is
released and the connection stays usable. Reconcile by opening a **fresh handle**
and reading the record twice: a read on the handle that experienced the fault
could observe an uncommitted row and report a durable outcome that does not
exist. Two agreeing reads are the answer; divergent reads mean the store is not
in a state you may act on.

### Interpreting a refusal

| Outcome | Meaning | Action |
|---|---|---|
| `STORE_UNAVAILABLE` | the write lock was never acquired, so nothing was written | safe to retry |
| `DurableAmbiguousAcknowledgementError` | the outcome is unknown | reconcile by reading the record twice **through fresh handles** and requiring one stable answer; never assume success or failure |
| `CAPACITY_EXHAUSTED` | the bounded journal is full | operator action; the journal never evicts, because dropping an entry would destroy replay evidence |
| `STORE_CORRUPT` | stored bytes do not re-derive their digest, or `integrity_check` failed | restore from backup; do not attempt in-place repair |
| `STORE_FORMAT_MISMATCH` | the file was written by a different store format | do not upgrade in place; restore a matching-format backup |
| `CHAIN_INVALID` | impossible chain state, sequence gap, or broken link | treat the store as untrusted and restore from backup |
| `RUNTIME_UNSUPPORTED` | unsupported Node major or failed capability probe | correct the runtime; there is no fallback backend or default path |

### Disabled-state recovery

A store file that has been removed is recreated empty at genesis
`(sequence 0, head null)`. It does not resurrect prior records. If prior records
are required, restore from backup before enabling any writer, and re-verify
every namespace chain first.

Never fabricate a record, reset a chain head, widen a journal bound, or
re-point a store at another store's file to make a refusal go away.
