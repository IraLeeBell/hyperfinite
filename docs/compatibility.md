# Tested compatibility matrix

`config/v1alpha1/compatibility.json` is the machine-readable source of truth.
Unknown or omitted combinations are unsupported and must fail closed.

## Product and technical identity

Hyperfinite is the product name. `agentic-framework` is the retained technical
compatibility identity for the current `v1alpha1` epoch; it is not a second
product name. The compatibility document fixes this decision and the exact
package, release archive, API/schema, logical Project schema, Capability
Registry publisher, and domain stem values.
`config/v1alpha1/technical-identity-inventory.json` separately binds the counts
and digest of every complete identity-bearing file plus its classified
occurrences, so changing enclosing semantics, removing an identifier, or
replacing it cannot disappear silently from validation. Separate reviewed
evidence covers the authoritative repository and the two mechanically closed
customer-starter profiles. A source set must match exactly one of those scopes;
the authoritative, core, and demo package scripts use separate fixed
entrypoints, so file-presence heuristics or caller arguments cannot downgrade
validation.

| Surface | Fixed compatibility identity |
|---|---|
| npm/package and release manifest | `agentic-framework`; archive `agentic-framework.tar` |
| API group and schema origin | `agentic-framework.github.com/v1alpha1`; `https://agentic-framework.github.com/schemas/` |
| Reusable logical Project schema | `agentic-framework-control-plane`; display title `Hyperfinite Control Plane` |
| Capability Registry publisher | `agentic-framework` |
| Signature, digest, OIDC audience, evidence-marker, builder, User-Agent, and format domains | Values derived from the lower-case `agentic-framework` stem and closed by their existing schemas or validators |

There is no alias, dual-read, dual-write, or automatic evidence rewrite.
Existing exact-head release/customer-starter evidence remains evidence for its
original head. New evidence is regenerated for the new head while retaining the
same technical identifiers. Content digests therefore change only when their
bound content or head changes; old digests are never re-signed or silently
migrated.

## Product and distribution boundary

Repository and customer-starter source are the only supported distribution
today. `config/v1alpha1/compatibility.json` closes the entry points and
unsupported consumption models in `productBoundary`.

| Consumer or surface | Supported status |
|---|---|
| Maintainer | Clone the authoritative repository and invoke documented repository scripts |
| Local evaluator | Clone the authoritative repository and run deterministic validation, simulation, and evidence commands |
| Customer-starter profile evaluator | Extract a verified profile into a new customer-owned private repository and run only its documented profile commands |
| Complete customer sandbox operator | Use a reviewed full file-only copy in a new customer-owned private repository and follow the complete evaluation matrix |
| Repository `npm` scripts | Supported only in the documented repository or customer-copy context |
| npm registry package | Unsupported; package metadata is private and exists for repository tooling and retained compatibility identity |
| TypeScript API / deep import | Unsupported; `src/` and `src/index.ts` are internal repository implementation |
| Packaged or general-purpose CLI | Unsupported; there is no `bin` entry |
| Hosted or deployable service | Unsupported; no service distribution is provided |
| Live administration and effects | External human and independently deployed trust-service prerequisites |

An SDK, CLI package, hosted service, deployable service, or production
distribution is separate future product work. This boundary does not change the
retained `agentic-framework/v1alpha1` technical identity and does not grant
runtime or effect authority.

Versioned JSON documents and schemas remain repository contracts. They do not
create a supported TypeScript package API; ADR 0020 explicitly supersedes that
interpretation of earlier API wording.

The credentialless canary seed, synthetic topology OIDC audiences, and
upstream taxonomy User-Agent previously used the product slug. They are
pre-release synthetic/tooling values, now normalized into the retained epoch;
there is no deployed credential or live evidence migration.

Only the exact protected compatibility field declares `identifierEpoch`, and
its exact closed-schema property accepts one constant value. Validation decodes
JSON keys, checks the exact schema location, and normalizes source Unicode
escapes. Runtime jobs, model outputs, and migration manifests have no field that
can choose or infer another epoch.

| Surface | Tested/supported combination |
|---|---|
| Private repository package metadata | Hyperfinite technical package identity `agentic-framework 0.1.0`; not a registry distribution |
| Node.js | Major `24` in Agentic Workflows; major `26` for local deterministic validation |
| npm | Major `11` |
| GitHub CLI | `2.96.0` |
| Git | `2.46.0` or newer; required for enforceable `GIT_NO_LAZY_FETCH=1` |
| Agentic Workflows compiler | `github/gh-aw v0.86.2` |
| Reviewer/threat-detection GitHub Copilot CLI | Effective app version `1.0.79` with `--no-auto-update` |
| Actions runner | `ubuntu-slim`; trusted setup uses Node major `24` |
| Platform | GitHub Enterprise Cloud only |
| GitHub Enterprise Server | Unsupported and unverified |
| Packaging/control/Project/runtime contracts | `1.0.0` |
| Deployment topology / GitHub App registration / administrator plan / administrator handoff contracts | `1.0.0` |
| Durable store journal-record / single-store and composition-backup-manifest contracts | `1.0.0` |
| Local durable adapter composition | Node majors `24` and `26`, each gated again by the live `node:sqlite` capability probe |

Canonical `github.com` and GitHub Enterprise Cloud data-residency
`<enterprise>.ghe.com` Git remotes are supported for release and
customer-starter source identity parsing.

The Copilot version is an effective runtime pin, not a launcher-only claim. The
offline validator checks source/config pins; the existing authorized manual
reviewer-runtime probe checks the release archive, extracted executable,
complete gh-aw setup JavaScript tree, `--no-auto-update` result, non-vacuous
evidence read, and external denial observations. That live probe is manual and
is not represented as a CI guarantee.

`npm run validate:customer-readiness` rejects source-specific, private, or
non-portable repository content. `npm run validate:packaging` rejects package,
lockfile, workflow, documentation,
example, compatibility, migration, or readiness drift. `validate:demos`,
`simulate:demos`, and `validate:hardening` cover the complete autonomous
portfolio. `npm run validate:review-agent-runtime` remains separately required
when the reviewer boundary changes.

The local durable composition is nonproduction and deep-import only. Passing a
listed Node major does not bypass its runtime capability probe, and passing the
probe does not activate a service, credential, writer, model, or GitHub effect.
