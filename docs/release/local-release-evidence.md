# Deterministic local release evidence

The local release tool builds evidence; it does not publish, sign, approve,
deploy, install, or mutate a customer environment.

## Build

From a clean worktree at the exact reviewed head:

```bash
npm run release:local -- build \
  --base-sha <exact-40-character-base-sha> \
  --head-sha <exact-40-character-head-sha> \
  --version 0.1.0 \
  --output <new-empty-absolute-output-directory>
```

The output directory must be outside the source repository. An in-repository
bundle would dirty the exact source and is rejected before any directory is
created. `repositoryRoot` must equal Git's canonical top-level directory; a
subdirectory cannot weaken this containment check.

The tool reads regular Git blobs from the exact commit, not working-tree files.
It rejects dirty or stale source, a non-descendant base, links, submodules,
unsupported modes, release-file paths over 224 Unicode code points,
noncanonical or non-NFC paths, paths with controls or malformed Unicode, paths
whose UTF-8 bytes cannot use the canonical ustar 100-byte name or
155-byte prefix/name slash split, oversized files, and oversized/file-count
archives before aggregate content is retained or concatenated. Output files are
exclusive mode-`0600` regular files:

All Git subprocesses require Git `2.46.0` or newer, set
`GIT_NO_LAZY_FETCH=1`, and override `core.fsmonitor=false`. A partial clone with
a missing required object fails rather than contacting a promisor remote or
contradicting the `networkUsed: false` provenance statement. Repository-local
fsmonitor programs cannot execute or hide worktree dirtiness.

| File | Meaning |
|---|---|
| `agentic-framework.tar` | Deterministic regular-file-only ustar source archive |
| `release-manifest.json` | Closed file/type/mode/size/digest and source/base/head manifest |
| `checksums.txt` | SHA-256 checksums for every other bundle file |
| `sbom.spdx.json` | SPDX 2.3 package inventory from the exact lockfile |
| `provenance.json` | Local builder, materials, source, and limitation record |
| `attestation.json` | Unsigned in-toto statement binding archive and evidence |
| `release-candidate.json` | Exact-candidate risk/no-go checklist |

Archive headers use uid/gid/mtime zero, fixed ustar fields, source modes, sorted
strictly unique paths, byte-exact canonical headers, zero padding, and exactly
two terminating zero blocks. The JSON Schema's registered `release-path` format,
planning, writing, and verification all delegate to the authoritative
`assertReleasePath` semantic representability validator. Evidence JSON uses
canonical serialization.
Independent builds from the same clean commit must match byte-for-byte.

## Verify

```bash
npm run release:local -- verify \
  --base-sha <exact-40-character-base-sha> \
  --head-sha <exact-40-character-head-sha> \
  --version 0.1.0 \
  --output <existing-absolute-output-directory>
```

Verification rejects unexpected/missing files, output links or modes, checksum
tampering, traversal, duplicate/archive links, unsupported types or modes,
noncanonical UTF-8 name/prefix splits, nonzero owners/timestamps/padding,
manifest mismatch, stale source/head,
package-version/commit-time/dependency/license/notice drift, Git
replacement-object influence, SBOM/provenance drift, and attestation
subject/predicate substitution.

SPDX package records include the required copyright field. Lockfile integrity
is emitted only as a non-empty SHA-1 or SHA-512 checksum with the correct digest
length; absent/unknown integrity is omitted rather than represented by an empty
array. License declarations must be valid SPDX expressions or the standard
`NONE`/`NOASSERTION` sentinels.

`--require-trusted-attestation` intentionally rejects the generated bundle. The
flag is valid only for `verify`; `build` rejects it rather than silently
producing unsigned output under a trust-requiring command. The statement is
unsigned local evidence and says exactly that it binds bytes and
source identity but does not attest review, security, readiness, signing, or
publication approval. A future human-approved release service must produce and
verify a separate protected signature; signing keys and publishing paths remain
customer-controlled deployment concerns.
