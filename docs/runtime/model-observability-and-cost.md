# Model, observability, and cost policy

## Model selection

The reviewed runtime policy pins the Copilot engine to `gpt-5.4`. There is no
automatic fallback, dynamic routing, or model-selected model. A change requires
all of the following:

1. an administrator policy change through a reviewed pull request;
2. an Activation Lease authorizing the provider, model, capability, and cost;
3. regenerated workflow locks from the pinned compiler;
4. deterministic validation and manual behavioral evaluation;
5. security and independent code review; and
6. human approval of billing, privacy, retention, and regional constraints.

Unavailability fails closed. The runtime must not switch providers, use a PAT,
or increase a budget to make a run succeed. The same model acting as agent,
reviewer, or detector is not independent review. Human review remains
mandatory; an independent-model evaluation must name a different model.

## Session lineage

Every authorized run must be reconstructable from immutable or authenticated
records containing:

- GitHub Actions run, repository, work-item, actor, event, and exact head;
- workflow source and lock digest, `gh-aw` version, action pin, engine, and
  model;
- Work Accord, policy, Activation Lease, Capability Registry, and Control
  Kernel receipt digests;
- phase, role, agent, skill, capability, route, contract revision, and
  authorization and redemption digests, signing key ID, nonce, run attempt, and
  CAS ledger heads;
- reserved-before/reserved-after and consumed AI credits, start/end time, turns, continuations,
  repair count, recursion depth, and termination reason;
- target-free output digest and exact threat input/output/status evidence;
- derived Effect Plan digest, Trusted Binding digest, receipt head, and
  Single Writer evidence when an effect is attempted; and
- human reviewer identity and current-head decision.

`AuditEvent@1.0.0` is the closed operational record. It contains only fixed
component/action/outcome enums, a bounded reason code, authority and subject
digests, a predecessor digest, and non-negative resource counters. Canonical
newline-delimited serialization validates contiguous sequence and hash-chain
linkage. Event creation, serialization, and metric derivation each consume one
canonical snapshot rather than rereading caller objects. Raw prompts, responses,
identities, repository names, paths, URLs, and credentials are intentionally
absent. UTC timestamps are capped at millisecond precision and 24 characters so
causal comparisons cannot collapse distinct accepted timestamps.

`MetricRecord@1.0.0` is derived deterministically from valid audit chains. Metric
names are fixed and labels are limited to component and outcome, bounding the
possible series count. `redactForAudit()` permits only reviewed diagnostic field
names, replaces every other field without emitting its key or value, validates
retained fields against fixed enums/digest/counter types, requires exact object
shapes for `labels` and `usage`, rejects anonymous root scalars/arrays, and
bounds depth and collection size. Authentication, API/access/signing-key,
passphrase, password, session, token, cookie, URL, PAT, private-key, PII, and
free-form business fields are not in the allowlist. Redaction or serialization
failure blocks the sink; it is not silently ignored.

Resource metrics include attempts, tokens, cost units, tool calls, effects, and
duration. A resource is counted on exactly one evidence event; digest-only
summary events do not repeat it.

Canonical `BudgetDecisionEvidence` round-trips through redaction without losing
its authority, budget, usage, reservation, or nullable predecessor digests,
closed projected usage, status/reason, and canonical run times. Malformed
digests, extra projected-usage fields, or invalid counters produce explicit
invalid markers rather than success-shaped evidence.

The repository validates these contracts and emitters but does not deploy their
storage or transport. Production activation is blocked until an authenticated
append-only Evidence Ledger retains the records and an operator verifies access,
retention, alerting, and restore behavior.

## Monitoring

Operators should inspect the platform run and agent log without treating either
as authority:

```text
gh run view <run-id> --repo <owner>/<repository> --log
gh aw logs <run-id>
gh aw audit <run-id>
```

Before a write, correlate those records with the trusted runtime authorization,
exact-success threat evidence, Control Kernel receipt, and Single Writer
evidence. Alert and pause on:

- denied or malformed pre-activation;
- any threat result other than exact `success`;
- input/output digest mismatch or stale evidence;
- model, tool, capability, source/lock, or action-pin drift;
- nonce/run-attempt replay, revocation, CAS conflict, cost reservation/usage
  mismatch, or delayed provider reporting;
- turn, duration, continuation, repair, recursion, or patch-size exhaustion;
- changed pull-request head or Project binding;
- missing, conflicting, partial, or replayed effect evidence; or
- any credential, network, MCP, protected-file, approval, or merge request.

Logs are sensitive operational data. Do not place secrets, customer data, raw
credentials, or private-key material in prompts, output, state comments, logs,
or evaluation fixtures. Apply repository retention and access policy before
enabling a run, and test structured redaction in the deployed environment.

## Cost authorization

The policy caps each main invocation at 200 AI credits, one continuation,
threat detection at 100 AI credits, zero cascades, and platform daily use at
1,500 AI credits. These are maximums, not spending approval. Before inference, the
trusted redeemer atomically reserves the complete maximum:
`(200 × (1 + 1) + 100) × (1 + 0) = 500` AI credits. It fresh-checks revocation,
consumes the signed nonce and exact run attempt, decrements remaining lease
credits with compare-and-swap, and appends a signed redemption record.

Slash-command activation can evade a platform daily cap. Atomic redemption and
the concurrency key therefore remain mandatory even when
`max-daily-ai-credits` is present. Sequential replay is not permitted, and
delayed or unavailable provider usage data must pause further inference rather
than assume zero cost.

Paid inference remains disabled until an administrator confirms the
organization's Copilot policy and billing. There is no PAT or alternate-token
fallback when `copilot-requests: write` is unavailable.

## Runaway-work model

Existing Work Accord, Phase Contract, Capability Registry, Activation Lease,
kernel route, and runtime policy controls jointly cap:

| Resource | Enforced source |
|---|---|
| Attempts and retries | Route `maxAttempts`, Work Accord/domain/enterprise retry ceilings |
| Fanout and concurrency | Work Accord/domain/enterprise parallel ceilings, capability concurrency, workflow concurrency with cancellation disabled |
| Wall clock and expiry | Work Accord/lease/grant/evidence expiry, capability deadline, workflow timeout |
| Tokens and cost | Work Accord, lease, phase, capability, signed reservation/settlement |
| Tool calls | Exact allowlist plus compiled capability call/retry ceilings |
| Effects | Exact effect union, trusted ordinal, one-time grant, claim, and idempotency evidence |

`evaluateRunBudget()` supplies an additional deterministic reservation check for
attempt, fanout, concurrency, token, tool-call, effect, wall-clock, and expiry
ceilings. It emits schema-valid `BudgetDecisionEvidence` with exact budget,
usage, reservation, prior-decision, and authority digests plus canonical run
start and evaluation times. It first snapshots the complete input through
canonical JSON and performs all validation, comparison, and digesting on that
stable value, so getters or later caller mutation cannot change a ceiling.
Malformed input or
overflow is rejected before a decision can be emitted; equality at expiry or
wall-clock and any exceeded ceiling produce a refusal. A
deployed scheduler must persist the decision before starting work and reconcile
unknown provider usage by holding the full reservation.

## Behavioral evaluation

Fast CI validates fixture contracts only:

```text
npm run validate:eval-fixtures
```

Live or recorded responses are evaluated separately:

```text
npm run eval:behavioral -- --responses-dir=<reviewed-response-records>
```

The command never invokes a model. Each record must contain evidence for role
adherence, correct skill activation, evidence quality, authority refusal, or
escalation as applicable. Any forbidden behavior fails the record. A
same-model evaluator/subject pair is rejected.
