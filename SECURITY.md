# Security policy

## Reporting

Report suspected vulnerabilities through GitHub private vulnerability reporting
when available, or directly to the repository's human administrators through an
approved customer security channel. Do not include credentials, private keys,
tokens, customer data, exploit payloads, or confidential logs in an issue.

Include the affected commit and contract version, the boundary crossed, expected
and observed behavior, and redacted evidence digests. Do not attempt production
exploitation or change repository/organization settings while investigating.

## Supported posture

Only the current default branch is maintained. The repository uses
disabled-by-default controls and deterministic exact-head validation. GitHub
Project provisioning, App installation, paid inference, live writes,
publication, deployment, and production-system mutation require that the human
prerequisites in
[the activation checklist](docs/demos/portfolio/activation-and-readiness.md)
and [deployment runbook](docs/runbooks/deployment-prerequisites.md) are met.

The packaging CLI is plan/`offline-validate`-only. Authenticated live validation
requires the separately deployed read-only trusted adapter and current human
authorization. Local release output is unsigned
evidence and is not a trusted release. Customer apply, protected signing,
publication, and deployment require separate human-owned trusted services and
remain unavailable in this repository.

The framework never accepts PAT fallback, model-held credentials, autonomous
approval or merge, or model-selected effect targets.
