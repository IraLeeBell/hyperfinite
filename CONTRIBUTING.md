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

Run:

```text
npm ci --ignore-scripts --no-audit --no-fund
npm run validate:customer-readiness
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
