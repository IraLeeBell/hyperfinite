# ADR 0015: Customer-starter and open-source-preflight tooling is additive, non-authoritative, and mechanically closed

- **Status:** Accepted
- **Date:** 2026-08-31

## Context

The customer-starter work provides a configurable, minimal subset of the
repository, a deterministic starter bundle/SBOM/provenance, and a
non-authoritative no-go preflight report, without deciding license,
publication, visibility, or release, and without adding customer/App/
Project data or credentials. Architecture review of the initial docs-only
starter plan required a
code-bearing, mechanically-verified profile model instead: an explicit
`control-plane-core` profile and an explicit `demo-portfolio` extension
composed as the deterministic union of the core plus its own additional
files, not a second unrelated profile.

Investigating the actual dependency graph showed that `src/index.ts`'s
`export *` barrel — required by `tests/packaging.test.ts` and
`tests/github-adapter.test.ts` — transitively re-exports every `src/`
module, and `src/validation.ts`'s central AJV document registry eagerly
imports nearly every schema in `schemas/v1alpha1/` regardless of which
document kind a caller actually validates. Neither module cleanly
partitions along a "core code" versus "demo code" boundary without an
architectural extraction that the coordinator explicitly ruled out except
when independently justified with its own tests/docs. `control-plane-core`
therefore ships the entire `src/` tree and most of `schemas/`/`config/`, and
the meaningful profile boundary is expressed at the docs/examples/tests/
scripts/`.github` layer instead.

## Decision

Add three additive, closed `PackagingDocument` kinds —
`CustomerStarterSelection`, `CustomerStarterManifest`, and
`CustomerStarterPreflightReport` — to `schemas/v1alpha1/packaging.schema.json`
and `src/packaging-types.ts`. A selection is a human-authored, closed list
of included/excluded path prefixes bound to an exact `sourceHeadSha` and a
`resolvedClosureDigest`: a digest over the sorted `{path, mode, digest}` of
every file the selection resolves to at `sourceHeadSha`, excluding the
selection document's own entry (excluded structurally, by matching
`kind`/`profileId`, not by an out-of-band path, since a selection cannot
commit a digest of a resolution that includes its own not-yet-committed
final bytes). `validateCustomerStarterSelection` independently recomputes
this digest both at the reviewed `sourceHeadSha` and at the current build
head and requires both to match the pinned value; ancestry of
`sourceHeadSha` alone is not sufficient, since a file could otherwise be
silently added, removed, mode-changed, or content-changed under a matched
prefix after review and before a later build. An extension profile
additionally binds `extendsProfileId` and a `baseSelectionDigest` to an
exact base selection, so the extension's own manifest is provably the
deterministic union of the base's files plus its own, never a
hand-assembled or overlapping second selection.

A closed, trusted catalog (`src/customer-starter-catalog.ts`) is the only
place `profileId -> exact committed selection-document path ->
extendsProfileId -> advertisedScripts`, plus the two shared scan-denylist
document paths, may be declared. `buildCustomerStarterBundle`/
`verifyCustomerStarterBundle`'s public signature accepts only a
`profileId`; there is no parameter through which a selection object, a
base selection, a base manifest, a `knownSelectionDocumentPaths` exemption
list, a scan denylist, an advertised-script list, or the catalog itself
can be supplied by a caller. Two successive review rounds found narrower
versions of this same "caller-suppliable catalog" gap: first, that
accepting an arbitrary `CustomerStarterProfileCatalog` as a build/verify
parameter was itself exploitable (a catalog entry naming a file added only
after the selection's reviewed `sourceHeadSha` is absent from the closure
there, so exempting it is a no-op, but present and exempted at the current
build head, so `resolvedClosureDigest` matches at both ends while the file
still ships); then, once that parameter was removed from the *production*
entry points, that a second, exported "test-fixture-only" function still
accepting a catalog was itself compiled into the shipped package and
reachable via a deep import regardless of its name or doc comments —
naming and documentation are not an authority boundary once a function is
exported from a module that ships. `src/customer-starter.ts` now exports
no function that accepts a `CustomerStarterProfileCatalog` at all;
`tests/customer-starter.test.ts` exercises the engine exclusively through
its real, sealed, catalog-fixed profileIds
(`control-plane-core`/`demo-portfolio`) against small hermetic synthetic
repositories that commit their own selection/denylist documents at
exactly the catalog's real paths. The catalog itself is constructed twice
independently — once as `src/customer-starter-catalog.ts`'s own exported,
recursively-frozen, detached inspection copy (used only for read-only
tooling such as `scripts/validate-customer-starter-extraction.ts`'s
evidence-gathering), and once as `src/customer-starter.ts`'s own
module-private, recursively-frozen reference the engine actually resolves
— from independent calls to a shared, otherwise-inert data-only seed
factory, so the two never share one mutable object graph and the
production reference cannot be reached by any deep import at all (it is
never exported). The engine resolves `profileId` through its own private
catalog to the profile's exact selection path and reads that document's
bytes directly from the exact reviewed Git tree at the build/verify head —
never from a caller-supplied in-memory object, and never from the working
directory, which could hold an uncommitted, unreviewed edit. When a
selection extends a base profile, the engine recurses into the same
catalog-bound resolution for the base `profileId` and derives the base's
manifest entirely internally from its own reviewed selection and the exact
tree; there is no caller-suppliable base manifest value left to widen,
narrow, or otherwise tamper with. `knownSelectionDocumentPaths` (the
exemption a selection's own `resolvedClosureDigest` computation needs to
avoid the self-referential pinning problem) and the two shared scan
denylists and each profile's `advertisedScripts` are likewise always
derived from the same private catalog's own declared paths, never
independently caller-suppliable.

`src/customer-starter.ts` implements the deterministic engine, reusing
`src/release.ts`'s tar/SPDX/open-source-readiness validators and shared
primitives in `src/release-support.ts` (Git-tree listing and content
fetch are split so a starter subset is not bounded by the full release
archive's 512-file cap; output-directory/checksum verification, SPDX
package building, and a portable-extraction path-collision check — two
tree paths colliding under NFC normalization and case-fold, e.g.
`README.md`/`readme.md` — are shared rather than duplicated, and the
collision check protects both the full release archive and every
customer-starter profile from the same shared `listGitTree`). Building a
bundle resolves the selection's prefixes against the exact tree
(default-deny: every included prefix must match at least one real file;
every excluded prefix must actually carve something out of an included
one), then runs eight checks over the resulting file set before writing
anything: deterministic secret, internal-reference, and customer-data
scans driven by reviewed denylist configuration (never model output), a
module-import closure (TypeScript, `.mjs`/`.cjs`/`.js`; static and dynamic
`import`, re-export, and `require`; resolved over a comment- and
string-literal-aware redaction of the source, preserving byte offsets 1:1,
rather than a bare regex — the pinned `typescript@7` devDependency, the
native "tsgo" rewrite, no longer exposes a synchronous single-file parse
API through its public entry points, confirmed empirically; a captured
module specifier containing a backslash escape sequence in any form this
checker recognizes — static import/from, dynamic `import()`, `require()`,
or a no-substitution template literal, in any of the three quote/backtick
delimiters — fails closed rather than being decoded, since a sequence
such as `\x2e` or `\u002e` resolves to a leading `.` at runtime without
containing a literal `.` character in its raw source form; an
interpolated template-literal specifier whose non-interpolated prefix is
empty, starts with `.`, or itself contains a backslash likewise fails
closed, since there is no evaluator here to resolve what an interpolation
might produce), a JSON Schema
`$ref` closure, a generated-workflow lock/Markdown-source closure
(one-directional: a compiled `.lock.yml` requires its `.md` source; the
reverse is not required), a Markdown-link closure (walking `markdown-it`'s
own token tree, so reference-style links/images and their definitions
resolve correctly, with an explicit `[text](path "external")`/
`"non-bundle"` title annotation escape hatch, and directory-style links
satisfied by any selected file under that prefix), and a package.json
script closure scoped to each profile's own explicitly declared
`advertisedScripts` (not literally every entry in package.json, since
demo-only scripts like `validate:demos` do not apply to a core-only
bundle). Any hit throws before any output is written, so a produced
bundle's `CustomerStarterPreflightReport` can only ever report
`status: "clean"` for all eight; there is no "flagged but shipped" state.

The preflight report is always `decision: "no-go"`, `authoritative: false`,
`selfApproved: false`, and embeds the exact
`config/v1alpha1/open-source-readiness.json` (read from the selected file
set, not a caller-supplied value) by digest, together with its unchanged
9-category human-gate list — the same non-authoritative pattern as
`ReleaseCandidateChecklist` (ADR 0009). `LICENSE` and
`THIRD_PARTY_NOTICES.md` byte digests are checked against the same
reviewed baseline constants the release tool uses.

`npm run starter:local -- build|verify --profile <id>` (new
`scripts/customer-starter-local.ts`) is the only CLI surface: build/verify
only, no apply/publish/install/network verbs, mirroring
`release-local.ts`. It imports the shared, trusted profile catalog rather
than declaring selection paths itself, and is cross-validated against that
catalog at module load. Building `demo-portfolio` no longer builds
`control-plane-core` to a throwaway directory to obtain its manifest: the
engine derives the base profile's manifest internally (loading its
selection through the same catalog and re-deriving its files from the
exact tree), so the extension is never bound to a stale, hand-copied, or
otherwise caller-suppliable base artifact.
Release and customer-starter manifests derive the source repository from the
canonical GitHub origin URL. Customer copies therefore bind their own
`owner/repository` identity without code edits or weaker exact-head checks.
`npm run customer:repin` provides the deterministic authoring step required when
a file-only customer copy receives a new Git root: from a clean initial commit,
it recomputes both reviewed closure digests and the demo selection's exact base
selection digest, then writes only the two selection documents for human review
and a follow-up commit. For an extracted starter archive, it also removes only
excluded-path entries that match no file in the new Git tree; it never adds an
included path or restores omitted source-only content.
The maintained source keeps a valid CODEOWNER. Before its initial commit, a
customer copy runs `npm run customer:configure -- --codeowner <owner>` to
rewrite every ownership rule. Organization-team values must belong to the
repository owner derived from `origin`; user-owned repositories may supply one
user. `validate:customer-readiness` permits the source maintainer only at the
source repository's `.github/CODEOWNERS` path and rejects it everywhere in a
customer copy.

The readiness scanner's deny rules each have positive and near-miss tests,
covering source repository/history, source organization and node identities,
private domains/links, live Project IDs, and the source CODEOWNER exception.
The exception also accepts CODEOWNERS whose user or team namespace equals the
destination repository owner, so a user-owned destination may legitimately keep
the same human owner while an unrelated customer organization cannot.

`src/release.ts`'s low-level Git/path/hash/output-safety/SPDX-building
helpers moved into a new internal `src/release-support.ts`, shared by
`release.ts` and `customer-starter.ts`. `release-support.ts` is
deliberately **not** re-exported from `src/index.ts`'s barrel — adding it
there produced a real ambiguous-export compile error against
`src/policy.ts`'s own `compareCodeUnits`, confirming the barrel is a public
surface that must not silently grow. A pinned API-surface regression test
in `tests/packaging.test.ts` asserts the internal helper names are absent
from `src/index.js`'s resolved exports and that `release.ts`'s original
public functions remain present.

## Consequences

- Two profiles are shipped: `control-plane-core` (the entire `src/`,
  most of `schemas/`/`config/`, and governance/architecture/security/
  release/runbook docs plus the docs/examples cross-linked from
  `README.md`) and `demo-portfolio` (the four demo packs' own schemas/
  config, `.github/agents`/`.github/skills`/`.github/workflows`, the
  demo-specific validation/simulation scripts, and their tests), verified
  disjoint and empirically extracted/`npm ci`/typechecked/built/tested
  standalone. `scripts/validate-customer-starter-extraction.ts`
  (`npm run validate:customer-starter-extraction`) makes this repeatable
  and checked rather than only a one-time manual exercise: it builds each
  real profile, extracts it with no Git history, runs `npm ci`, and runs
  every one of the profile's advertised scripts, writing a retained JSON
  evidence record. It is kept outside `npm test`/`validate:packaging`
  because it reaches the network; the hermetic unit tests still prove
  package/script/link/import/schema/workflow closure statically.
- `tests/packaging.test.ts` and `scripts/installer.ts` are not part of
  either profile's shipped test/script set: both require a real `.git`
  directory and a real repository commit graph (`git rev-parse
  --show-toplevel`, exact base/head matching) to function, which an
  extracted tarball inherently lacks. This is a pre-existing property of
  the installer's own exact-head safety model (ADR 0009), not a gap this
  work introduces; the framework's own CI continues to exercise them in
  the real clone. `validate:workflows` and `validate:gh-aw` remain
  shipped in `demo-portfolio` but are not advertised as standalone-
  runnable for the same reason: both shell out to `gh aw compile`, which
  itself requires a real Git repository. `validate:demos` is excluded
  from the advertised list too, since it unconditionally invokes
  `validate-workflows.js` as one of its own steps, and `validate:hardening`
  is excluded because its own closed hardening plan
  (`config/v1alpha1/demo-portfolio/hardening-plan.json`) mandates
  `tests/packaging.test.ts` among its exact test files.
  `validate:review-agent-runtime` is excluded because it unconditionally
  requires `COPILOT_CLI_ARCHIVE_PATH`/`GH_AW_HARNESS_PATH` environment
  variables pointing at external artifacts this profile does not ship or
  fetch. `eval:behavioral` is excluded because it unconditionally
  requires `--responses-dir=<reviewed-response-records>` pointing at
  externally-reviewed response records this profile does not ship.
- `tests/customer-starter.test.ts` (the engine's own unit tests) is
  shipped in neither profile: it deliberately embeds fake-secret and
  self-referential relative-import string literals to test the scanners
  and closures, which would trip the very same scanners when the file
  itself is scanned as bundle content.
- No existing `PackagingDocument` kind, script, or `buildReleaseBundle`/
  `verifyReleaseBundle` behavior changes; all additions are new files or
  new closed union members.
- `src/release-support.ts`'s shared output/verify path-safety helpers
  (`safeOutputPath`, `assertSafeOutputRoot`, `canonicalDirectory`,
  `writeExclusive`) close a check-then-use (TOCTOU) symlink gap under an
  attacker-controlled *writable* parent directory (the classic
  world-writable shared `/tmp` scenario): a build/verify output parent, and
  a directory being read back (a verify `bundleRoot`, or `repositoryRoot`
  itself), must now be owned by the current process user and free of
  group/other write bits, in addition to being a non-symbolic-link
  directory, and each is re-`lstat`'d after any `realpathSync` resolution
  or directory creation to narrow the window between check and use
  further; `writeExclusive` additionally opens with `O_NOFOLLOW` where the
  platform exposes it, on top of the pre-existing `O_EXCL`. This applies
  identically to `src/release.ts` and `src/customer-starter.ts`, since both
  share these exact functions. It explicitly does not, and is not claimed
  to, protect against an attacker who already has code-execution as the
  same user/process identity — only against a symlink swap or
  pre-positioned entry from a *different* identity sharing a writable
  parent directory.

## Rejected alternatives

- Extracting `github-adapter.ts` away from `github-auth.ts`/
  `github-events.ts` to shrink the core closure: rejected per explicit
  coordinator direction — `github-auth.ts` is an injected credential
  boundary with no ambient secret/env fallback and is appropriate in the
  core closure; only concrete network transport (`github-http.ts`, which
  nothing else in the closure imports) is excluded.
- A single combined profile: rejected because it cannot express "ship the
  deterministic core without the demo layer," which the coordinator
  required.
- Modeling package-script closure over every entry in `package.json`:
  rejected because `package.json` legitimately declares scripts that only
  apply once `demo-portfolio` is present; each profile instead declares
  the exact scripts it advertises.

## References

- [ADR 0006](0006-open-source-readiness-is-a-gated-assessment.md)
- [ADR 0009](0009-packaging-is-target-bound-and-release-evidence-is-non-authoritative.md)
- [Packaging and replication architecture](../architecture/packaging-and-replication.md)
- [Customer-starter example](../../examples/customer-starter/README.md)
- [Control matrix](../security/control-matrix.md)
- [Threat model](../security/threat-model.md)
