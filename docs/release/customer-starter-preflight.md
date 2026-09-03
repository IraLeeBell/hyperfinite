# Customer-starter and open-source preflight

The customer-starter tool builds a configurable, mechanically-closed subset
of the exact reviewed Git tree ("profile") plus deterministic evidence. It
does not decide license, publication, visibility, or release.
The archive is a source distribution for extraction into a new customer-owned
Git repository. It is not an npm package, TypeScript SDK, packaged CLI, hosted
service, deployable service, or bundle of live trust services.

## Build and verify

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

See [`examples/customer-starter/README.md`](../../examples/customer-starter/README.md)
for the full walkthrough, including the `demo-portfolio` extension profile.

## Output

| File | Meaning |
|---|---|
| `customer-starter.tar` | Deterministic regular-file-only ustar archive of exactly the selected files |
| `starter-manifest.json` | Closed file/type/mode/size/digest manifest bound to the selection and exact source head |
| `starter-sbom.spdx.json` | SPDX 2.3 package inventory |
| `starter-provenance.json` | Unsigned local builder/materials/limitation record |
| `starter-preflight.json` | Non-authoritative no-go report |
| `checksums.txt` | SHA-256 checksums for every other bundle file |

## The preflight report

`starter-preflight.json` is always `decision: "no-go"`, `authoritative:
false`, `selfApproved: false`. It embeds the live
`config/v1alpha1/open-source-readiness.json` by exact digest, together with
its unchanged 9-category human-gate list, and reports eight machine-checked
scans/closures — secret, internal-reference, and customer-data scans; and
module-import, JSON Schema `$ref`, generated-workflow lock/source,
Markdown-link, and package-script closures. Every scan can only ever report
`status: "clean"`: any hit or closure violation makes the build itself fail
before any file is written, so a produced bundle can never ship in a
"flagged" state. A human release, security, product, OSPO, and legal owner
must still record separate authenticated evidence for the same 9 categories
that gate the framework's own open-source readiness
([ADR 0006](../adr/0006-open-source-readiness-is-a-gated-assessment.md));
the preflight report is additional non-authoritative evidence for that
review, not a substitute for it.

## Profiles

- `control-plane-core` — the deterministic framework itself: all of `src/`,
  the schemas/config its central document validator loads, and the
  governance/architecture/security/release/runbook docs.
- `demo-portfolio` — an explicit extension of `control-plane-core`
  (`extendsProfileId` + `baseSelectionDigest`/`baseManifestDigest`), adding
  only the four demo packs' own schemas/config, `.github/agents`/
  `.github/skills`/`.github/workflows`, and their validation/simulation
  tooling and tests. Its manifest is the deterministic union of the base's
  files plus its own; building it re-derives the exact base manifest first,
  never a stale or hand-copied artifact.

Neither profile includes credentials, a live target, App/Project
identifiers, or customer data. See
[ADR 0015](../adr/0015-customer-starter-and-open-source-preflight-tooling.md)
for the full design, including why `scripts/installer.ts` and
`tests/packaging.test.ts` — which require a real repository
`.git` history — are not part of either profile's shipped, standalone-tested
surface.

The administrator handoff schema, library contract, deterministic tests,
synthetic examples, and runbooks are included through the core profile. The
repository-only `handoff:administrator` command is not advertised by either
extracted profile because it requires full-repository canary and adapter
surfaces.

The demo profile includes a synthetic Project target-manifest example. Customer
target manifests are generated from fresh protected snapshots, confirmed by
digest, and retained outside the repository. The shared internal-reference scan
rejects non-synthetic Project node identities before either bundle is written.
`.npmignore` excludes target-bound synthetic bindings, generators, fixtures, and
bootstrap tests from npm package materialization. This does not authorize npm
publication; open-source readiness remains `not-ready`.

## Clean-extraction validation

`npm run validate:customer-starter-extraction` builds each profile,
extracts it with no Git history, runs `npm ci`, and runs every advertised
script inside the extraction, writing a retained JSON evidence record. It
reaches the network, so it is kept outside `npm test`/`validate:packaging`;
the hermetic unit tests in `tests/customer-starter.test.ts` still prove
package/script/link/import/schema/workflow closure statically.
