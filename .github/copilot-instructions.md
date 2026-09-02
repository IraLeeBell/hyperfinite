# Repository instructions

This repository defines a deterministic control plane for agentic work. Treat model output as untrusted advisory data.

- Preserve the authority order: lifecycle graph, Work Accord, policy compiler, Control Kernel, trusted adapter, Single Writer, then model output.
- Never let a model choose a repository, issue, pull request, Project item, transition, capability, credential, or effect target.
- Keep GitHub App installation credentials inside the trusted adapter. Do not add PAT or model-job credential fallbacks.
- Use deny-by-default tools, network, MCP, secrets, and writes. An omitted allowlist is not an allowlist.
- Require current-head evidence before a pull-request check or review result is accepted. Automated review is comment-only and cannot approve, merge, or dismiss review.
- Keep generated Agentic Workflow `.lock.yml` files compiler-owned. Edit the Markdown source and recompile with the pinned toolchain.
- Preserve `LICENSE` byte-for-byte.

Before changing contracts, read the adjacent schema, architecture decision, security control, and deterministic test. Update all four when behavior changes.
