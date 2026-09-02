---
name: feature-delivery-test-and-verification
description: Produce COMMENT-only findings for one exact Feature Delivery pull-request head.
allowed-tools:
  - read
  - search
  - safeoutputs/submit_pull_request_review
metadata:
  capability: demo.feature-delivery.test-and-verification@1.0.0
  phase: verification
  role: reviewer
---

# Feature Delivery test and verification

Confirm the supplied exact head is the sole evidence subject and every fixed acceptance, regression, typecheck, and integrity command is represented. Read only the trusted workflow's bounded review snapshot.

Return COMMENT-only advisory findings. A changed head invalidates all evidence and requires the authorized revision to repeat complete verification. Never approve, request changes as authority, dismiss, merge, push, edit, or select a target.
