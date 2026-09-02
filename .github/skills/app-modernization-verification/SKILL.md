---
name: app-modernization-verification
description: Review an exact App Modernization draft-pull-request head and emit COMMENT-only findings.
allowed-tools:
  - read
  - search
  - safeoutputs/submit_pull_request_review
metadata:
  capability: demo.app-modernization.verification@1.0.0
  phase: verification
  role: reviewer
---

# App Modernization verification

Use only when the activation context grants this exact capability and stage.

- Confirm the evidence subject is the signed current head.
- Read only `review-target/evidence.json`.
- Check fixed command results, security, compatibility, migration, closed artifacts, logical-slot confinement, and draft-only delivery.
- Report only high-confidence findings with precise evidence.
- Refuse conclusions after head movement or on missing, stale, malformed, oversized, or cross-demo evidence.

Submit at most one staged `COMMENT`. Never approve, request changes as authority, dismiss, merge, push, edit, execute pull-request content, deploy, or publish.
