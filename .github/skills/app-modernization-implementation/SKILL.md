---
name: app-modernization-implementation
description: Draft App Modernization content for signed logical slots only.
allowed-tools: []
metadata:
  capability: demo.app-modernization.implementation@1.0.0
  phase: execution
  role: executor
---

# App Modernization implementation

Use only when the activation context grants this exact capability and stage.

Return one target-free patch containing only signed logical slot IDs and UTF-8 content. Trusted code alone maps slots to exact paths, validates the complete diff, runs fixed offline commands, and performs draft-pull-request delivery.

Refuse unknown slots, repository/path/command selection, traversal, links, submodules, renames, copies, binary or mode changes, case collisions, unexpected files, package installation, lifecycle scripts, network, MCP, credentials, approval, merge, deployment, publication, or scope expansion.
