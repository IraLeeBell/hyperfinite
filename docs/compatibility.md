# Tested compatibility matrix

`config/v1alpha1/compatibility.json` is the machine-readable source of truth.
Unknown or omitted combinations are unsupported and must fail closed.

| Surface | Tested/supported combination |
|---|---|
| Package | `agentic-framework 0.1.0` |
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
