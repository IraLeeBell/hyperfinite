# ADR 0009: Packaging is target-bound and release evidence is non-authoritative

- **Status:** Accepted
- **Date:** 2026-08-28

## Context

Customer replication, upgrades, rollback, recovery, uninstall, and release
evidence introduce privileged target-selection, filesystem, migration, and
supply-chain boundaries. A model-generated command, inferred target, permissive
archive extractor, mutable version label, or self-reported attestation could
bypass the lifecycle, Work Accord, policy compiler, Control Kernel, trusted
adapter, and Single Writer authority order.

## Decision

Packaging uses the closed `PackagingDocument` contract family in
`schemas/v1alpha1/packaging.schema.json`. Installation configuration binds an
explicit enterprise, organization, repository numeric/node/full identity, App
installation, default ref, exact head, observed state digest, receipt-chain CAS
head, selected release- and migration-manifest digests, closed backup evidence,
operation, and package version. The plan and authorization also bind each
selected directional migration-step checksum.
Release-source base/head and customer-target head remain separate immutable
values; only the target head is used for apply CAS. Trusted code precomputes and
binds the expected resulting target head for repository-file effects.

The repository CLI defaults to deterministic `plan` or explicitly
`offline-validate` mode and cannot apply. The typed read-only
`validateLiveInstallationPlan` boundary requires an injected trusted adapter,
fresh target observation, current authorization, and signature-verified
validation evidence. A live apply is available only through the typed
`TrustedInstallationAdapter`, after a separate current human-signed
authorization binds the canonical plan digest and idempotency key. The adapter
owns credentials outside model reach, performs one CAS effect, and returns a
signed receipt. It also provides the trusted clock; callers cannot choose an
authorization evaluation time. The caller rereads that clock immediately before
apply, while the adapter contract still requires atomic authorization-freshness,
expected-state/head, and idempotency enforcement with the effect. Untrusted inputs are snapshotted once before
validation. The caller never retries an ambiguous effect. Reconciliation accepts
success only when the signed receipt, authoritative receipt-store reread, and
exact resulting state agree.
The idempotency key covers every effect-defining action, expected result
head/state, and evidence path. Actions and retained evidence paths must have no
equality or segment-boundary ancestor/descendant overlap in planning or
apply-side validation. The plan embeds its closed selected configuration,
release manifest, migration manifest, expected pre/post states, and nullable
recovery base and verifies them against their digests. It re-runs migration-path
selection and re-derives actions, all four preconditions, and the deterministic
current-operation evidence path before authorization verification. Non-recovery
input must be stable; recovery input must be partial, bind the last stable state,
and retain evidence from both. A self-rehashed plan cannot substitute arbitrary
customer paths, omit migration/irreversibility, replace the selected release,
or discard evidence by changing only its action/state summaries.

Migration manifests form one contiguous ordered graph with unique source and target
versions, step checksums, required preconditions, irreversible declarations,
rollback support, and evidence-retention semantics. Unknown versions, skipped
edges, downgrade without a reversible edge, partial journals, reordered
receipts, and ambiguous states fail closed.
Backup, exact source-version, exact target-head, and receipt-chain evidence are
bound into the plan; irreversible steps require a separate human authorization
bit. Non-empty receipt chains require trusted signature verification plus exact
target, predecessor, sequence, state-continuity, terminal-state, and observed
terminal-head checks. The structural-only validator is named
`validateInstallationJournalStructure`; only
`validateAuthenticatedInstallationJournal` accepts a non-empty chain as
authenticated. Raw receipt arrays are refused above 512 before element access or
cloning, then materialized once; structure and authentication use that same
snapshot, including the decision whether the journal is non-empty. No
compaction/checkpoint protocol is implemented, so capacity exhaustion
requires external complete-chain archival and a future authenticated checkpoint;
truncation or chain reset remains forbidden.
Journaled recovery binds both the authenticated partial state and the last
completed stable state; migration authority comes from the stable state and
retains evidence from both. Uninstall inventory must equal the selected
installed-version manifest. Release-file paths use one authoritative
`assertReleasePath` semantic contract from the schema's registered
`release-path` format through planning, tar writing, and verification. It rejects
controls, U+2028/U+2029 line separators, malformed Unicode, non-NFC values,
denied segments, and any UTF-8 path lacking a canonical ustar slash split with
name at most 100 bytes and prefix at most 155 bytes.

Local release tooling reads only regular blobs from an exact clean Git commit
with Git 2.46+, replacement objects, partial-clone lazy fetching, and repository
fsmonitor disabled, rejects
links/submodules/unsupported modes and oversized content, and emits a
deterministic ustar archive, closed release manifest, checksums, SPDX 2.3 SBOM,
source/base/head provenance, unsigned in-toto statement, and risk-explicit
release-candidate checklist. Verification re-derives every artifact and rejects
unexpected files, traversal, links, type/mode/owner/time drift, tampering,
dependency/license-expression drift, stale source, or subject/predicate mismatch. Unsigned local
evidence never establishes trusted attestation, release readiness, or permission
to publish.
The manifest repository name is derived from a canonical GitHub Enterprise
Cloud origin URL instead of a fixed source repository. HTTPS, SCP-style SSH, and
`ssh://git@.../` forms for `github.com` and data-residency `*.ghe.com` hosts
resolve to a source object containing both canonical lowercase `server` and
`owner/repository`; malformed, credential-bearing, or other-host remotes are
refused. Verification compares both fields so identical owner/repository names
on different GitHub Enterprise Cloud hosts cannot collide.
Release output is required to remain outside the exact clean source repository.
Installer and release output checks also exclude Git's resolved directory and
common directory, including separate linked-worktree metadata.

## Consequences

- Administrators must provide explicit target configuration, authenticated
  fresh state, backup evidence, a human change record, a trusted adapter, and
  independently protected App credentials before apply.
- App, OIDC, Project, ruleset, GHAS, billing, team, visibility, key custody,
  signing, publication, and deployment actions remain human-owned.
- Uninstall removes only exact package-owned files through an approved plan and
  preserves receipts, backups, audit evidence, and customer content.
- `LICENSE` remains byte-identical. Open-source readiness remains an unresolved
  human legal/OSPO/security/product assessment.
- The pre-1.0 TypeScript API intentionally removes the ambiguous
  `validateInstallationJournal` export. Consumers must choose the explicitly
  structural or authenticated validator; retaining an alias would preserve the
  false-authentication hazard.

## Rejected alternatives

- A shell/template installer: rejected because arguments, paths, and commands
  could become attacker-controlled.
- Automatic retries: rejected because a lost acknowledgement can duplicate an
  external effect.
- Version-range migrations or inferred downgrade paths: rejected because they
  conceal skipped and irreversible transitions.
- Generic archive libraries with permissive extraction defaults: rejected in
  favor of a bounded regular-file-only ustar format and exact manifest.
- Treating a generated SBOM, provenance file, or model review as release
  approval: rejected because evidence is not authority.

## References

- [Packaging and replication architecture](../architecture/packaging-and-replication.md)
- [Customer administrator runbook](../runbooks/customer-administrator.md)
- [Release evidence](../release/local-release-evidence.md)
- [Threat model](../security/threat-model.md)
- [Control matrix](../security/control-matrix.md)
