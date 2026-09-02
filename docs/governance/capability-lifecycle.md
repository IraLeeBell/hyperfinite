# Capability lifecycle

Capabilities are immutable, versioned, deny-by-default registry entries selected
by trusted policy, never by a model.

## Add or update

1. Create a new semantic version; do not mutate the meaning of an existing
   version.
2. Declare exact phases, actors, input/output schemas, target-free adapter,
   tools, shell commands, network destinations, MCP tools, secrets, effects,
   limits, evidence, and idempotency scope. Omitted allowlists mean deny.
3. Update the adjacent schema, architecture decision, threat/control mapping, and
   positive and adversarial tests.
4. Run provenance, schema, runtime, workflow, evaluation, and full test
   validation.
5. Obtain independent security review and human CODEOWNER approval on the exact
   head.
6. Activate only through a fresh Work Accord, compiled policy, and Activation
   Lease. Registry merge alone grants no runtime authority.

## Deprecate or disable

Emergency disablement prevents new resolution immediately and preserves prior
evidence. Normal deprecation names a replacement and migration window. Removal
requires no inbound phase/workflow references, retained evidence through policy
retention, migration tests, and human approval.

Changes that add writes, secrets, credentials, network, MCP mutation, publication,
deployment, or production effects require a new architecture decision and
separate administrator authorization. Capability changes never authorize App
installation, rulesets, teams, visibility, billing, or enterprise policy.
