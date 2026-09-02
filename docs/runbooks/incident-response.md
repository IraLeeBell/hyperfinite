# Incident response

## Trigger

Treat credential exposure, unexpected write, replay, evidence-chain conflict,
budget overrun, current-head mismatch, unauthorized capability, secret-scanning
alert, or unexplained audit gap as an incident.

## Contain

1. A human administrator disables runtime activation and the affected capability.
2. Revoke active leases, runtime state, signing keys, webhook secrets, and App
   installation tokens as applicable. Do not delete evidence.
3. Pause the serialized Single Writer and all automatic reconciliation.
4. Preserve workflow run IDs, exact SHAs, signed authorization/redemption,
   operation-grant claims, audit chains, budget decisions, effect evidence, and
   provider usage.

## Investigate

Verify signatures and hash chains from an independently retained head. Rebuild
the timeline from fixed reason codes and digests. Compare current GitHub state to
the last completed effect receipt. Treat missing, edited, reordered, conflicting,
or unverifiable evidence as partial failure. Redact diagnostics before sharing.

## Recover

Follow the recovery runbook. Rotate compromised keys, reconcile or reverse only
effects with explicit human authorization, and require new state, leases, grants,
and exact-head review. Record the root cause, affected scope, residual risk, and
human reopening decision. Never dismiss a GHAS alert or resume automatically.
