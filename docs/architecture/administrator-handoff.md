# Administrator handoff architecture

The administrator handoff composes evidence; it does not add an authority plane.
The fixed order remains:

`lifecycle graph -> Work Accord and Phase Contracts -> policy compiler and Capability Registry -> Control Kernel -> trusted adapter -> Single Writer -> model output as untrusted advisory data`

## Contract chain

1. `AdministratorHandoffPlan` binds the canonical digests of the existing
   deployment, App, administrator, durable-adapter, synthetic-canary,
   customer-starter, open-source, and LICENSE evidence.
2. For one mutation-capable control, `AdministratorApplyPlan` binds exact target
   IDs, its fixed responsible owner/target source/readback/rollback metadata,
   the control's exact state keys and value domains, counted current and desired
   values, a derived attempt/idempotency identity, one attempt, and every
   prohibited effect.
3. A human creates a separate `AdministratorApplyConfirmation` for the exact
   canonical apply-plan digest.
4. A trusted adapter supplies a fresh `pre-apply` readback. Any count, value,
   target, digest, freshness, or confirmation mismatch invokes nothing.
5. The trusted adapter independently verifies the confirmation, atomically
   claims the attempt ID/idempotency key in durable storage, and may make one
   bounded attempt outside this repository.
6. A complete `post-apply` readback must equal the desired state. Ambiguous
   acknowledgement is typed reconciliation-required and never retried; every
   post-readback binds the confirmation, pre-readback, attempt, and signed
   trusted-adapter receipt.
7. `AdministratorHandoffReadback` uses only digests of live target identities
   and recomputes the complete gap/readiness state. Raw identifiers remain in
   protected administrator evidence and exact apply plans.

The library has no network client, credential reader, environment fallback,
clock read, App registration call, administrative mutation, or retry loop. All
time and evidence inputs are explicit.

## Readiness separation

| State | Required evidence |
|---|---|
| Repository readiness | Complete exact-head validation and independent review |
| Credentialless synthetic sandbox | Byte-stable `npm run canary:synthetic` evidence |
| App-backed sandbox | Complete authenticated admin readback plus a separately authorized live canary reaching Human Review |
| Broader adoption | Separate customer architecture, security, operations, billing, legal, and release decisions |

The repository-only handoff command evaluates the first two and emits a
synthetic-unconfigured gap set for customer completion. Project fields, issue
text, model output, fixture text, and API display names never choose a target or
close a gap.

## Export boundary

The contract, schema, tests, synthetic examples, and runbook are customer-starter
content. The repository contains no source-organization administrator snapshot.
Customer live readbacks remain in protected customer evidence systems. No raw
live target IDs, credential material, or customer data may enter an exported
bundle.
