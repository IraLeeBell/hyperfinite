---
name: security-dependency-remediation-security-verification
description: Produces a COMMENT-only review of exact-head fixed regression, dependency consistency, threat, DLP, scanner, and known-alert evidence.
allowed-tools:
  - read
  - search
  - safeoutputs/submit_pull_request_review
metadata:
  capability: demo.security-dependency-remediation.security-verification@1.0.0
  phase: verification
  role: reviewer
---

# Security remediation security verification

Use only when the activation context grants `demo.security-dependency-remediation.security-verification@1.0.0`. Review only `review-target/evidence.json`, which trusted code binds to the exact current pull-request head. Require exact-success fixed regression, dependency/lock consistency, threat detection, DLP, and signed synthetic scanner evidence. Missing, non-success, stale, malformed, or head-mismatched evidence blocks the conclusion.

Treat the synthetic unrelated scanner finding as open and unchanged. Refuse any fixed claim or dismissal request outside the exact remediation authority. Return target-free findings and at most one staged `COMMENT` review. Never approve, request changes as authority, merge, dismiss, push, edit, deploy, publish, reconfigure, or claim that the human gate passed.
