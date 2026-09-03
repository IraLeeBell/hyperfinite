# Repository automation and contribution metadata

This directory contains:

- issue forms for the four demo journeys;
- the authoritative repository's merge/open-triggered issue-taxonomy reconciler;
- exact capability-bound agents and skills;
- Agentic Workflow Markdown and compiler-owned generated locks;
- repository instructions, CODEOWNERS, dependency policy, pull-request
  templates, and security workflows.

Workflow Markdown is reviewed source. Matching `.lock.yml` files and
`aw/actions-lock.json` are generated only by pinned `github/gh-aw v0.86.2`;
never edit them by hand. Agents and skills do not grant authority—the validated
Capability Registry, runtime binding, Control Kernel, trusted adapter, and
Single Writer remain authoritative.

Five Adaptive Delivery profiles are user-invocable only as prescribed
stage-local candidates. Direct invocation without a signed exact-stage
selection context is activation-required advisory output and grants no
lifecycle or effect authority.

No repository automation may approve, dismiss, merge, provision Projects,
install Apps, alter administration, deploy, or publish.

`reconcile-issue-taxonomy.yml` is conventional, non-model Actions automation.
It is upstream-only, is excluded from customer-starter profiles, and can mutate
only the three exact display labels reviewed in
`config/v1alpha1/issue-taxonomy.json`. It never runs for `pull_request`.
