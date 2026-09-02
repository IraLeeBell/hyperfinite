# Operator runbook

1. Confirm `activation-profile.json` remains disabled unless a human
   administrator has reviewed all deployment prerequisites. Enabling the file
   alone does not create live authority.
2. Validate the catalog/profile/binding digests, signed synthetic advisory,
   current base SHA, fixed target-slot map, fixed checks, and budget before any
   model invocation.
3. Run the repository validation matrix. The synthetic hands-off fixture must
   stop at Human Review and carry the exact closed zero-valued external-call
   assertion fixture. Treat that declaration as fixture evidence, not telemetry.
4. On pause or block, preserve the journey cursor. On repair, replan, revision,
   retry, stale advisory, or reauthorization, require the exact Kernel recovery
   route, increment generation as defined by runtime policy, and invalidate the
   affected receipt suffix.
5. Reconcile partial effects or lost acknowledgements by the original
   idempotency key and stable exact readback. Never blindly retry a mutation.
6. Treat unavailable, missing, warning, skipped, stale, malformed, or
   head-mismatched scanner, threat, or DLP evidence as blocked.
7. Preserve the synthetic unrelated scanner finding as open evidence. Refuse
   fixed or dismissal claims outside the exact remediation authority.
8. Stop at independent human review. Automation cannot approve, request changes
   as authority, merge, mark ready, deploy, publish, dismiss, or reconfigure.

Live App installation, Project binding, OIDC services, evidence signing,
durable stores, billing, rulesets, credentials, and repository protections are
human-administrator prerequisites outside this pack.
