# Contributing

All changes are pull-request only. Do not commit credentials, generated secrets,
customer data, or production identifiers.

Before changing a contract, read and update its adjacent schema, architecture
decision, security control, and deterministic tests. Preserve the authority
order: lifecycle graph, Work Accord, policy compiler, Control Kernel, trusted
adapter, Single Writer, then model output. Models must remain target-free and
cannot choose authority, credentials, transitions, repositories, work items,
pull requests, Project items, or effects.

Generated Agentic Workflow `.lock.yml` files and `.github/aw/actions-lock.json`
are compiler-owned. Change the Markdown source and compile with
`github/gh-aw v0.86.2`. Never edit `LICENSE`; its legal posture requires a
separate human decision.

Public review and contribution begin at the curated open-source snapshot and use
only this repository's published files and history. Earlier private development
history is intentionally not published. Unpublished issues, pull requests,
commits, or coordination records are not required and must not be requested or
reconstructed.

## Issue taxonomy

The authoritative `IraLeeBell/hyperfinite` repository uses three issue classes.
It is the authoritative upstream for public development from that snapshot
forward. The label is for list-level classification only: issue content, labels,
and templates are untrusted input and grant no lifecycle, target, capability,
credential, transition, or effect authority.

| Class | Where to file | How to use it |
|---|---|---|
| `type: maintainer-development` | This authoritative repository | Maintainers use the **Maintainer development** template for bounded repository changes. Do not use it for customer evaluation or synthetic demo records. |
| `type: customer-evaluation` | The clean customer-owned sandbox repository | Evaluators use the four customer journey forms only after the evaluation ticket and fixed budget are approved. Customer-safe feedback for the Hyperfinite maintainers may use this repository's **Customer evaluation feedback** form; a maintainer applies the taxonomy label during triage. |
| `type: synthetic-demo` | The repository that hosts the demonstration | Demo operators use only synthetic data and follow the applicable demo runbook. These records are samples or evidence inputs, not maintainer backlog or customer authority. |

Customer-owned repositories do not need the authoritative repository's taxonomy
labels. The four journey forms intentionally declare no automatic label so they
remain portable to a clean sandbox. The upstream-only maintainer template is
excluded from the customer-starter bundle. A customer sandbox starts from its
own reviewed file snapshot and new evidence-chain root rather than inheriting
the upstream delivery history.

The authoritative repository's reviewed issue-taxonomy workflow reconciles only
these three labels. A merge to `main` is the initial effect authorization; later
`issues.opened` events apply only the exact repository-local title-prefix rules.
Unknown prefixes fail closed, conflicting taxonomy labels are removed, and
unrelated labels are preserved. The workflow, mapping, schema, and reconciler are
upstream-only and excluded from customer-starter bundles.

Run:

```text
npm ci --ignore-scripts --no-audit --no-fund
npm run validate:customer-readiness
npm run validate:technical-identity
npm run typecheck
npm run build
npm test
npm run validate:schemas
npm run validate:runtime
npm run validate:eval-fixtures
npm run validate:provenance
npm run validate:workflows
npm run validate:gh-aw
npm run validate:packaging
npm audit --audit-level=high
git diff --check origin/main...HEAD
npm run validate:demos
npm run simulate:demos
npm run validate:hardening
```

Changes to the review workflow boundary must also run
`npm run validate:review-agent-runtime` with
`COPILOT_CLI_ARCHIVE_PATH` pointing to the exact pinned Copilot CLI 1.0.79
release archive and `GH_AW_HARNESS_PATH` pointing into the exact pinned gh-aw
v0.86.2 setup JS tree. An authorized maintainer runs its `--live` mode to prove
agent discovery and evidence reads, then issue a non-authoritative denial
challenge while a protected sentinel remains outside both roots. Accepted
evidence is the absence of sentinel content from captured output/logs and the
absence of a requested shell marker on disk, not the model's claim that it
attempted either tool. The probe must also revalidate sentinel device/inode,
mode, size, and content after launch; require the model to echo an undisclosed
per-run evidence nonce; and confirm the effective app reports `1.0.79` under
`--no-auto-update`.

Before merge, record successful exact-head CodeQL and Dependency Review checks;
missing, skipped, stale-head, or unavailable checks are blockers.

Security-sensitive changes require independent security and code review against
the exact current head. Automated review is advisory `COMMENT` only. A human
CODEOWNER approves and a human maintainer merges.

## Documentation

Start from the [documentation index](docs/README.md). Keep status language
explicit: implemented repository behavior, hermetic evidence, undeployed live
prerequisites, and unsupported behavior are different claims. Projected GitHub
state, fixture assertions, model output, and local release evidence are never
described as authority, telemetry, approval, or live readiness.

Add or update a directory README when introducing a new major subsystem,
operator workflow, demo pack, schema family, fixture family, or example group.
Use relative links for repository documentation and verify that every local link
resolves. Do not duplicate mutable version values when an authoritative config
or compatibility file can be linked instead.
