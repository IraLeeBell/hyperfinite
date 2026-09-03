# Authority-boundary walkthrough

> Generated from the executable deterministic walkthrough. Do not hand-edit
> the transcript or recording; regenerate both from the command below.

This walkthrough uses fixed synthetic identities, clocks, keys, content, and
an injected fake provider. It performs no network call, credential read, paid
inference, GitHub mutation, approval, or merge. The result is hermetic
repository evidence only; it is not live deployment or readiness evidence.

The `control-plane-core` customer-starter profile intentionally includes and
advertises `demo:authority` because it exercises that profile's hermetic
control-plane surface. The media generator and generated evidence are included
for reproducibility but do not add a live or administrative command.

## Run

From an exact reviewed repository clone after installing the locked
dependencies:

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run demo:authority
```

The structured result is also available without changing the scenario:

```bash
npm run demo:authority -- --format=json
```

## Reproduce the recording

The media generator uses the same canonical structured result and transcript
projection as the executable command and requires no external recorder:

```bash
npm run demo:authority:recording
```

The executable text below remains authoritative when animated pixels cannot
be validated or animation is disabled.

## Complete static transcript

```text
$ npm run demo:authority

Hyperfinite authority-boundary walkthrough
Mode: SYNTHETIC / DETERMINISTIC / OFFLINE

1. MODEL OUTPUT ........ REFUSED [SCHEMA_INVALID]
   Attempted repository, issueNumber, and effect fields are outside the closed schema.
   Provider calls: 0 | effects: 0

2. PRE-ACTIVATION ...... REFUSED [activation.enabled]
   Runtime disabled; no model, credential, network, or effect boundary is crossed.

3. CONTROL KERNEL ...... REFUSED [ACTIVATION_REQUIRED]
   Cost-bearing activation.begin-framing has no current Activation Lease.
   Provider calls: 0 | effects: 0

4. TRUSTED ROUTE ....... APPLIED [activation.begin-framing]
   Current human activation evidence and an exact lease satisfy the Kernel.
   Trusted Binding derives example-organization/hyperfinite#3 @ 2222222222222222222222222222222222222222.
   The model supplied advisory content only; trusted code supplied every target.

5. SINGLE WRITER ....... REFUSED [CURRENT_HEAD_STALE]
   Expected 2222222222222222222222222222222222222222; observed 3333333333333333333333333333333333333333.
   Fake-provider effects: 0 | live effects: 0

6. FRESH EFFECT PLAN ... APPLIED [applied]
   Fresh revision 2 binds example-organization/hyperfinite#3 @ 3333333333333333333333333333333333333333.
   Event: COMMENT | injected fake-provider effects: 1 | live effects: 0

7. LIFECYCLE ........... STOPPED [HUMAN_REVIEW]
   Automation cannot emit APPROVE or merge and cannot cross review.accept.
   Synthetic-human continuation is not executed; only independent human authority may continue.

Final counters: model=0, network=0, credential-reads=0, live-effects=0, fake-effects=1
Scenario digest: sha256:8ce2c2194f75b87ab47610238f57524f5f8bd246abb33a722f4168e7eb64b9a1

This is hermetic repository evidence, not live deployment or readiness evidence.
```
