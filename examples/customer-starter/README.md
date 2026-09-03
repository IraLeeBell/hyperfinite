# Customer-starter build/verify example

This example documents how to build and verify a deterministic
customer-starter bundle for the reviewed `control-plane-core` profile. It
does not decide license, publication, visibility, or release; the produced
`starter-preflight.json` is always `decision: "no-go"`, `authoritative:
false`, `selfApproved: false`, exactly like `release-candidate.json` in
[`examples/customer-installation/`](../customer-installation/README.md).
The resulting archive is supported only as source extracted into a new
customer-owned Git repository. It is not an npm package, SDK, packaged CLI,
hosted service, deployable service, or live-effect distribution.
Run only the profile commands in the
[customer-starter preflight](../../docs/release/customer-starter-preflight.md);
the archive does not support the complete customer sandbox matrix.

```bash
npm run starter:local -- build \
  --profile control-plane-core \
  --base-sha <exact-40-character-base-sha> \
  --head-sha <exact-40-character-head-sha> \
  --version 0.1.0 \
  --output <new-empty-absolute-output-directory>

npm run starter:local -- verify \
  --profile control-plane-core \
  --base-sha <exact-40-character-base-sha> \
  --head-sha <exact-40-character-head-sha> \
  --version 0.1.0 \
  --output <existing-absolute-output-directory>
```

`--base-sha`/`--head-sha` must be the exact `origin/main` and current `HEAD`
commits of a clean GitHub checkout; the tool derives `owner/repository` from the
canonical origin, binds the canonical Git host separately, and reads exact Git
blobs the same way the release tool does (see
[Deterministic local release evidence](../../docs/release/local-release-evidence.md))
and refuses a stale or dirty worktree.

## What gets produced

| File | Meaning |
|---|---|
| `customer-starter.tar` | Deterministic regular-file-only ustar archive of exactly the selected files |
| `starter-manifest.json` | Closed file/type/mode/size/digest manifest bound to the selection and exact source head |
| `starter-sbom.spdx.json` | SPDX 2.3 package inventory (root package plus any shipped `package-lock.json` dependencies) |
| `starter-provenance.json` | Local builder, materials, and limitation record (unsigned, non-authoritative) |
| `starter-preflight.json` | Non-authoritative no-go report: 8 machine-checked scans/closures plus the live 9-category open-source-readiness gate |
| `checksums.txt` | SHA-256 checksums for every other bundle file |

## The `control-plane-core` profile

[`config/v1alpha1/customer-starter-selection.json`](../../config/v1alpha1/customer-starter-selection.json)
is the reviewed selection: an explicit list of included/excluded path
prefixes, mechanically verified to be closed under TypeScript relative
imports, JSON Schema `$ref`, generated workflow lock/source pairing,
Markdown links, and the profile's own advertised `package.json` scripts.
`src/index.ts`'s own `export *` barrel — needed by `tests/packaging.test.ts`
and `tests/github-adapter.test.ts` — transitively requires the entire
`src/` tree, so `control-plane-core` ships all of `src/`; the schemas and
config that `src/validation.ts`'s central document registry loads eagerly;
and the docs/examples that `README.md` and the ADRs cross-link. It excludes
the demo-project-specific schemas/config and the two profiles' own
extension surfaces (`config/v1alpha1/demo-portfolio`,
`config/v1alpha1/demo-projects`).

A handful of package.json scripts and tests are inherently unable to run
from a bare extracted bundle regardless of selection, because they invoke
`scripts/installer.ts`/`scripts/release-local.ts` as real subprocesses that
call `git rev-parse --show-toplevel` and expect a real repository commit graph
— an extracted tarball has no `.git` directory. Those are not
part of `control-plane-core`'s advertised scripts; the framework's own CI,
running inside the real clone, continues to exercise them fully.

## `demo-portfolio`: an explicit extension, not a second profile

[`config/v1alpha1/customer-starter-demo-portfolio-selection.json`](../../config/v1alpha1/customer-starter-demo-portfolio-selection.json)
declares `extendsProfileId: "control-plane-core"` and a
`baseSelectionDigest` bound to the exact `control-plane-core` selection
above. Building it (`--profile demo-portfolio`) first re-derives the base
profile's manifest from the exact source head, then adds only the
extension's own files (the four demo packs, `.github/agents`/`.github/skills`/
`.github/workflows`, demo-specific schemas/config, and their tests), and
verifies the two file sets are disjoint. The resulting manifest is the
deterministic union of both, independently reproducible from the two
selection documents and the exact head alone.

## Non-goals

No license, publication, visibility, or release decision; no App
installation, Project mutation, or live GitHub effect; no credentials,
customer data, or non-portable source material (enforced by the secret/
internal-reference/customer-data scanners, which fail the build closed on
any match rather than shipping a "flagged" bundle).
