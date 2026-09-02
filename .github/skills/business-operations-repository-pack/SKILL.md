---
name: business-operations-repository-pack
description: Create a bounded business-operations proposal package in exact trusted slots.
allowed-tools: []
metadata:
  capability: business-operations.create-repository-artifacts@1.0.0
  phase: execution
  role: proposer
---

# Business operations repository pack

Use only after the Control Kernel grants the named capability and trusted code
supplies the nine logical slots. Produce problem framing, stakeholder analysis,
a process map, decision memo, proposed policy/process design, implementation
plan, simulation-only runbook, controls/approvals design, and outcome
measurement plan.

Return `slot` plus closed JSON `content`; trusted code alone validates DLP,
evidence, graph and control semantics, dependencies, sizes, and maps each slot
below `examples/business-operations/workspace/artifacts/`. Stop after two repair
loops. Business authority and control approvals must come from authenticated,
independent humans on the exact current artifact set and head. Repository draft
PR packaging is the maximum effect; merged artifacts are proposals, not enacted
operations.
