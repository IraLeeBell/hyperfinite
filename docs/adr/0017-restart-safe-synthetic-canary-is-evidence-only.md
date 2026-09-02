# ADR 0017: The restart-safe synthetic sandbox canary is evidence only

- **Status:** Accepted
- **Date:** 2026-09-01

## Context

The repository already has two complementary proof surfaces. The portfolio
hardening runner exercises the lifecycle graph, Work Accords, Phase Contracts,
compiled policy, Capability Registry, Control Kernel, trusted adapter, Single
Writer, and fake-provider journey through Human Review. The durable composition
opens all fifteen reviewed store adapters through the four exact store identities
in `DeploymentTopologyPlan` and proves restart, replay, conflict, backup, restore,
corruption, ambiguity, provider reconciliation, and engineering cost-hold
behavior.

Neither surface alone satisfies the operator-facing canary requirement. The
canary must compose them without introducing another authority, reading an
ambient credential, calling a network service, or converting repository evidence
into live deployment evidence.

## Decision

`npm run canary:synthetic` is the one supported credentialless local command.
It:

1. validates the existing synthetic `DeploymentTopologyPlan`;
2. runs the closed portfolio hardening evidence twice under a Node network deny
   guard and requires byte-identical canonical output;
3. runs the exact durable composition, adapter, recovery, multi-process, and
   deployment-contract tests twice under the same guard;
4. requires every named hardening and durable fault boundary to pass exactly
   once and pins the exact compiled content digest of every evidence test;
5. emits one target-free canonical evidence object signed with an Ed25519 key
   derived in memory from a public synthetic canary label; and
6. stops at Human Review with only a draft pull request and `COMMENT` review
   represented by the fake services.

The private signing key is never written. Its deterministic public synthetic seed
allows repeated executions to produce byte-identical signatures and output; it
is test evidence, not a credential. The emitted public key is verification
material only.

The command supplies child processes only a fixed environment allowlist. It does
not read `process.env`, `GH_TOKEN`, `GITHUB_TOKEN`, or any billing/provider
credential. `scripts/deny-network.ts` rejects Node HTTP, HTTPS, TCP, TLS, UDP,
DNS, `fetch`, WebSocket, and EventSource entry points. The runner invokes only
fixed compiled repository scripts and test files; no model, prompt, issue field,
Project value, fixture string, or command-line option can select a path, command,
target, retry, or effect.

The canary reuses the merged hardening and durable contracts. It does not define
a new lifecycle, binding, store descriptor, permission set, capability, or
effect. The existing authority order remains:

`lifecycle graph -> Work Accord and Phase Contracts -> policy compiler and Capability Registry -> Control Kernel -> trusted adapter -> Single Writer -> untrusted model output`

## Consequences

- The repository has a repeatable, restart-safe synthetic canary with one exact
  command and canonical signed evidence.
- The command covers real cross-process SQLite races and close/reopen continuity,
  but no live GitHub, provider, App, Project, billing, or administration service.
- Fixture-declared external-call counters remain assertions, not runtime
  telemetry. The Node network deny guard narrows the local proof but is not an OS
  sandbox and cannot establish production isolation.
- The canary result grants no capability, selects no live target, satisfies no
  deployment prerequisite, and cannot approve, dismiss, mark ready, merge,
  deploy, publish, install or transfer an App, enable billing/inference, or
  mutate administration.
- Human exact-head review remains required. Live sandbox administration and any
  separately authorized live canary remain blocked.

## Rejected alternatives

- **Create a new canary lifecycle or store contract.** Rejected because it would
  duplicate the authority already fixed by the lifecycle, hardening plan,
  deployment topology, and durable adapter mapping.
- **Use ambient credentials to make the synthetic proof more realistic.**
  Rejected because a credentialless canary must fail before any live boundary.
- **Generate a random key per run.** Rejected because valid random signatures
  would make canonical evidence differ across otherwise identical executions.
- **Treat passing repository evidence as live readiness.** Rejected because the
  independent services, protected bindings, App installation, billing,
  administration, and platform readback remain undeployed.

## References

- [Synthetic sandbox canary runbook](../runbooks/synthetic-sandbox-canary.md)
- [Durable stores](../architecture/durable-stores.md)
- [Portfolio activation and readiness](../demos/portfolio/activation-and-readiness.md)
- [ADR 0014](0014-durable-local-trust-substrate-is-nonproduction.md)
- [ADR 0016](0016-engineering-cost-holds-own-the-attempt-lifecycle.md)
