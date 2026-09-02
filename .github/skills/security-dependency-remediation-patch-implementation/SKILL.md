---
name: security-dependency-remediation-patch-implementation
description: Produces only a target-free bounded patch for trusted slot mapping and draft-PR delivery.
allowed-tools: []
metadata:
  capability: demo.security-dependency-remediation.patch-implementation@1.0.0
  phase: execution
  role: executor
---

# Security remediation patch implementation

Use only when the activation context grants `demo.security-dependency-remediation.patch-implementation@1.0.0` and supplies exact logical target slots, predecessor digest, base SHA, fixed checks, and patch-byte limit. Return content keyed only by those slots. Trusted code alone maps slots to paths, validates the complete diff, and may deliver only an open draft pull request through the Single Writer.

Do not emit a repository, path, ref, pull request, route, capability, credential, retry, or effect target. Do not run commands, install packages, execute lifecycle scripts, use network, shell, MCP, or secrets, or request approval, merge, ready-for-review, dismissal, deployment, publication, or reconfiguration. Refuse missing, stale, inconsistent, oversized, or out-of-scope authority.
