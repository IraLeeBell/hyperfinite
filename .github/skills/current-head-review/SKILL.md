---
name: current-head-review
description: Review an exact pull-request head and produce comment-only findings.
allowed-tools:
  - read
  - search
  - safeoutputs/submit_pull_request_review
metadata:
  capability: core.review-current-head@1.0.0
  phase: verification
  role: reviewer
---

# Current-head review

Use only when the activation context grants `core.review-current-head@1.0.0`.

- Confirm the supplied head SHA is the evidence subject.
- Read only the trusted workflow's `review-target/evidence.json` snapshot; never
  select a repository, pull request, ref, or API argument.
- Prefer high-confidence defects with precise file and line evidence.
- Distinguish absent evidence from a verified failure.
- Refuse conclusions after a head change.
- Escalate protected-file, authority, or policy questions to a human.

Return target-free advisory content. The trusted workflow selects the pull request and can submit only a `COMMENT` review.
