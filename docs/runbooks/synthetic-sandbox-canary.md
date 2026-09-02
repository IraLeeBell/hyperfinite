# Synthetic sandbox canary

## Classification

This is a credentialless, network-denied, local synthetic proof. It uses only
fixed synthetic bindings, deterministic clocks, an in-memory deterministic
Ed25519 test key, deterministic fake providers, isolated local Git, and the
nonproduction durable SQLite adapters.

It is not a live sandbox canary, production-readiness evidence, a deployment, or
authorization to configure a GitHub App, Project, ruleset, billing account,
provider, credential, or trust service.

## Exact command

From a clean repository workspace with the pinned dependencies installed:

```sh
npm run canary:synthetic
```

The command accepts no options. Any option suggesting live, apply, execution,
GitHub, network, credential, or paid operation is rejected before ambient
environment access.

## Expected result

The command prints one canonical JSON line. A successful report records:

- all four governed demo journeys stopped at Human Review;
- draft pull requests only and automated review event `COMMENT`;
- the exact closed hardening fault-boundary set passed;
- all fifteen durable ports used only their topology-bound store;
- close/reopen continuity after every durable boundary;
- real independent-process append and compare-and-swap races;
- replay/conflict, revocation, stale-head, wrong-Project, wrong-agent, budget,
  provider-unknown-usage, kill-switch/unavailability, backup/restore,
  disabled-state, corruption, signer/verifier, runner, and acknowledgement
  refusals;
- ADR 0016 hold-before-provider ordering and reconciliation-required unknown
  usage;
- zero fixture-declared credential, GitHub, network, and paid-inference calls;
- a verified synthetic Ed25519 signature; and
- an explicit remaining independent human exact-head review gate.

The runner executes the hardening and durable evidence paths twice. Canonical
evidence, including the deterministic synthetic signature, must be byte
identical. Every executed evidence file is pinned by its exact compiled-content
digest, so retaining a test name while changing or weakening its implementation
also fails. A failed, skipped, missing, renamed, duplicated, reordered, or
content-drifted required test; changed evidence digest; nonzero external-call
assertion; unsupported Node major; unsafe readiness claim; or network attempt
fails the command.

## Evidence handling

The output contains fixed labels, counters, public verification material, and
digests only. It contains no private key, token, secret, repository path, live
target, prompt, response, customer data, or credential value. The private
synthetic signing key exists only in process memory and is never persisted.

Retain the exact output and repository head for human review. Do not reinterpret
the result as approval, merge evidence, Project state, live administration
readback, or a deployment gate.

## Recovery

On failure, preserve the output and stop. Do not add credentials, disable the
network guard, skip a test, raise a budget, repair a corrupt store in place,
reset a chain, or rerun an ambiguous effect blindly. Reconcile durable ambiguity
through two stable reads on fresh handles, restore only an authenticated complete
four-store backup while writers remain disabled, and rerun the exact command
after the underlying issue is reviewed and fixed.
