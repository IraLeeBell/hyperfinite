# Secrets and identity model

## Identity sources

The trusted adapter resolves immutable numeric GitHub App, installation,
repository, actor, work-item, Project, and pull-request identities through
authenticated API reads. Logins, names, comments, refs, and model text are not
identity authority. Human gates require a current non-bot actor, current
permission/team evidence, required independence, exact Work Accord/lease binding,
and exact current-head binding where applicable.

GitHub Actions workloads authenticate to independent trust services with OIDC
claims bound to repository, workflow, workflow SHA, run ID, run attempt, actor,
event, and audience. Each service rejects repositories, workflows, audiences, and
subjects not explicitly allowlisted.

## Secret custody

- GitHub App private keys stay in a sign-only credential broker.
- Installation tokens are short-lived, one-repository, operation-scoped, verified
  against exact permissions, and never returned to a model or stored in evidence.
- State, redeemer, evidence, and operation-claim signing keys are separate,
  independently rotated keys. Public verification keys and key IDs may be
  repository variables; private material may not.
- PATs, personal tokens, ambient runner credentials, fallback credentials, and
  secrets exposed to model context are prohibited. Reviewed framing GitHub read
  gateways may receive the platform's ephemeral `GITHUB_TOKEN` inside trusted
  gh-aw setup; the credential is not returned to the model, cannot mint App
  authority, and grants no external MCP or durable secret access.
- Webhook secrets are held by the ingress verifier and used only against raw
  request bytes.

## Rotation and revocation

Publish a new reviewed public key and key ID before issuing new evidence. Retain
old verification keys until all signed evidence expires, but stop signing with
them. Revoke the affected lease, runtime state, App installation token, and
capability immediately on suspected compromise. Recovery requires fresh state,
nonce, grant, current-head evidence, and human approval; old evidence is never
re-signed or silently migrated.

Audit records contain digests and fixed reason codes, never secret values. Apply
`redactForAudit` to diagnostic objects before any log sink and block the sink if
redaction or serialization fails.
