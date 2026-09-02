# Security

Start with:

1. [Threat model](threat-model.md)
2. [Threat-to-control matrix](control-matrix.md)
3. [Secrets and identity](secrets-and-identity.md)
4. [GitHub App permissions](github-app-permissions.md)
5. [GHAS administrator runbook](ghas-administrator-runbook.md)

The repository demonstrates deterministic controls through hermetic tests and
injected ports. It does not prove a live App installation, key service,
credential broker, Evidence Ledger, conditional store, isolated runner, or
provider boundary. Missing or unverifiable controls fail closed.

Report suspected vulnerabilities according to
[`SECURITY.md`](../../SECURITY.md). Never include credentials, customer data,
private artifacts, or production exploit payloads in an issue.
