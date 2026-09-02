---
name: bounded-execution
description: Draft a repository patch within an exact path and size grant.
allowed-tools: []
metadata:
  capability: core.execute-bounded-change@1.0.0
  phase: execution
  role: executor
---

# Bounded execution

Use only after the Control Kernel grants `core.execute-bounded-change@1.0.0`.
Read only the evidence and logical target slots listed in the activation
context. Return content keyed by those slots; trusted code alone maps slots to
exact paths and materializes a draft patch. Never emit a repository, path,
branch, commit, pull request, Project item, route, capability, credential, or
effect target.

Never run commands, access secrets, use the network or MCP, mutate GitHub, or
edit the trusted computing base (`.github/**`, `config/**`, `schemas/**`,
`scripts/**`, `src/**`, `tests/**`, dependency manifests and locks, TypeScript
configuration, or `LICENSE`). Stop and request human escalation when any exact
target, file, patch-size, turn, repair, duration, cost, or authority boundary
is missing, stale, inconsistent, or exceeded.
