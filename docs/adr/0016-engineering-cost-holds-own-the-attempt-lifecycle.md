# ADR 0016: Engineering cost holds own the attempt lifecycle

- **Status:** Accepted
- **Date:** 2026-08-31

## Context

The engineering slice previously recorded provider work before it had durable
cost authority for that work.

`runEngineeringSlice` called `providerUsage.begin()`, which appended a signed
attempt to the `receipt-journal`, and only later registered the returned attempt
in a caller-local `unresolvedAttempts` array. Exceptions in the intervening
steps — bound-snapshot reads, `CURRENT_HEAD_STALE` refusal, activation-lease
reads, or validator failure — reached the release path with an incomplete array.
`costs.release({ unresolvedAttempts })` then released budget that was still
represented by a durable provider attempt.

That was not a validator gap that could be fixed by checking the same input more
strictly. `validateCostRelease` derived `heldCostUnits` by summing the
`phaseBudget` values over the caller-supplied array, so an omitted attempt was
invisible to the checker. The same root cause covered three cases: an omission
window before the array was updated, a crash window where no in-memory array
survived, and a real cross-store race because the held set lived in
`receipt-journal` while the budget pool lived in `runtime-state-store`.

A focused review diagnosed the defect and intentionally did not patch around it in the
adapter. The repair belongs in the cost contract, because budget cannot depend on
a caller remembering which attempts exist.

## Decision

Engineering cost holds own the attempt lifecycle.

Before any provider work begins, `EngineeringCostLedger.hold()` commits a signed
`EngineeringCostHold` into the `engineering.cost-ledger` namespace in
`runtime-state-store` by compare-and-swap. `EngineeringProviderUsageLedger.begin()`
then requires that hold and records its `holdDigest` on the
`EngineeringProviderAttempt`. `EngineeringCostSettlement` also carries
`holdDigest`, and `EngineeringCostLedger.settle()` requires the supplied
settlement to discharge the exact hold it follows.

The required order is:

1. `costs.hold()`;
2. `providerUsage.begin({ hold })`;
3. provider work;
4. `reconcile()`;
5. `costs.settle({ hold })`.

This is intentionally two ordered single-store writes, not a cross-store
transaction. A crash between the hold and the attempt strands budget as held,
which is the safe direction, and an attempt cannot exist unless its hold already
does. The receipt journal records attempt evidence; the runtime-state cost ledger
owns the held set.

For every reservation, at every instant:

`totalReserved = Σ settled actualCostUnits + Σ releasedCostUnits + Σ open-hold phase budgets`

Holds and settlements share one signed lineage:

`reservation → hold → settlement → hold → settlement → release`

Each entry chains onto the immediately preceding entry of either kind, because an
open hold that never settles still occupies a link. `validateCostSettlement`
therefore receives ordered `priorEntries: readonly EngineeringCostLineageEntry[]`,
not `priorSettlements`, and a settlement chains directly to its hold
(`ledgerHeadBefore === hold.ledgerHeadAfter`,
`ledgerVersion === hold.ledgerVersion + 1`).

Release is derived from durable cost state. `EngineeringCostLedger.release()`
takes `expectedOpenHoldDigests`, which is only the caller's view, and checks it as
a subset of the ledger-derived open-hold set. Omission is impossible because a
lost in-memory hold is still present in the cost lineage. Fabrication is refused
because a digest the ledger never wrote is not in the derived set.

`validateCostRelease` reconstructs the lineage from content the release itself
pins, never from a caller-supplied hold array. A settlement is signed over
`ledgerVersion` and `ledgerHeadBefore`, so it pins the hold it discharged: that
hold occupied the immediately preceding version and ended at that head. Every
still-open hold is carried whole and signature-verified. Together those cover
every link, and contiguity of the version sequence from the reservation is what
makes an omitted hold detectable as a gap.

This matters for liveness as well as safety. A hold whose compare-and-swap lands
and whose post-commit readback then fails is durable but never reaches its
caller. The ledger derives it and returns a correct release; a validator that
rebuilt the chain from the caller's array would reject that correct release,
mask the original failure, and strand the reservation after the release had
already committed. The chain is therefore never caller-derived: lineage
reconstruction needs no caller hold list. `EngineeringCostLedger.release()` still
takes `expectedOpenHoldDigests`, and `validateCostRelease` still takes
`knownOpenHolds`, but both are non-authoritative assertions of the caller's own
view, checked only as a subset of the derived set. They can catch a caller that
names a hold the ledger never wrote; they can never define what is held.

The chain is bounded at both ends: below by the reservation, above by the
release's own signed `ledgerVersion`. Stating the upper bound directly is a
clarity change rather than a new refusal — requiring the walked distance to equal
the claimed size and separately requiring the release to follow the walked tip
enforces the same set — but it puts the bound where it applies and reports which
position is missing instead of a generic mismatch.

At most one hold is open at a time, so the lineage strictly alternates hold and
settlement. Two concurrently open holds would fork the chain, because a
settlement derives its position from the hold it discharges: settling the older
one after a newer hold had been taken would write a second entry at the version
that newer hold already occupies, leaving a reservation whose own release could
never validate. Phases are sequential by construction, so nothing legitimate
needs two.

What this proves is scoped deliberately. It proves the release is internally
complete against the content it pins, so no caller omission can make a correct
release look wrong or a truncated one look right, and no caller can drop a hold
while still claiming the chain position that hold created. It does not prove
that the ledger did not under-report its own durable state: a signer that both
dropped a hold and restated its own release version would be internally
consistent at the shorter history, and no checker reading only release-pinned
content can distinguish that from a history where the hold never existed. That
is the trusted adapter's authority, discharged by
`openDurableEngineeringCostLedger` deriving the open set from its own lineage
under compare-and-swap, and covered by its own durable tests rather than by this
validator.

Settlements remain supplied-and-checked. The release must cover exactly the
durably settled phases, preserving the prior settlement proof. Holds are
derived-only. That asymmetry is deliberate: supplied settlement evidence proves
spent cost, while the open-hold set is the ledger's own state and must not be
defined by a caller array.

Holds and releases use the same compare-and-swap namespace head. A concurrent
hold moves the head and makes release re-derive; a completed release closes the
reservation and later `hold()` refuses with `ADAPTER_CONFLICT`. The race resolves
only as "hold lands, then release derives it" or "release lands, then hold is
refused." No interleaving loses a hold.

A hold with no proven settlement is never released from absence of evidence. It
stays held and the release reports `reconciliationRequired: true`. There is no
orphan collection, garbage collection, abandonment, expiry, or "provably unused"
return path in this contract.

Engineering checkpoints that carry cost state advance from
`schemaVersion: "1.0.0"` to `"1.1.0"`. `EngineeringAwaitingHumanMergeCheckpoint`,
`EngineeringCostReleaseCheckpoint`, and `EngineeringClosureCheckpoint` replace
`unresolvedAttempts` with `openHolds`. A stored `1.0.0`
checkpoint is refused, not reinterpreted: it references a lineage that can no
longer validate, and its holds never existed, so they cannot be synthesized.
Operators drain in-flight slices before upgrading. Engineering checkpoints are
not a `MigratableKind` in `src/migrations.ts`, so no migration-registry entry is
created. `schemas/v1alpha1/` contains no engineering cost-document schema, so no
JSON Schema change is made.

## Consequences

- A caller-local unresolved-attempt array is no longer a source of budget truth.
- A crash or thrown validator after `hold()` leaves budget held and
  reconciliation-required, never silently released.
- Release documents carry whole signed `unresolvedHolds`, so the release is
  self-proving without a second store read.
- The cost ledger can refuse fabricated open-hold digests and cannot omit a hold
  it already wrote.
- The public engineering cost contract adds `EngineeringCostHold`,
  `EngineeringCostLineageEntry`, and `validateCostHold`; adds `holdDigest` to
  `EngineeringProviderAttempt` and `EngineeringCostSettlement`; replaces
  `EngineeringCostRelease.unresolvedAttemptDigests` with whole signed
  `unresolvedHolds` plus `reconciliationRequired`; adds
  `EngineeringCostLedger.hold()`; changes `EngineeringCostLedger.settle()` to
  require `hold`; changes `EngineeringCostLedger.release()` to accept
  `expectedOpenHoldDigests`; and changes
  `EngineeringProviderUsageLedger.begin()` to require `hold`.
- The store isolation from ADR 0013 and ADR 0014 remains intact. The attempt
  journal and cost ledger are ordered, but not transactionally coupled.
- The reference implementation remains nonproduction. It adds no paid inference,
  App credential handling, secret handling, live GitHub effect, provider retry,
  cloud deployment, production SLA, approval automation, merge automation, or
  publication.

## Rejected alternatives

- **Release a provably orphaned hold after its reconciliation window closes.**
  Rejected: absence of durable attempt or usage evidence is not proof of spent
  cost. Budget may leave a hold only through a settlement that proves what was
  spent. Returning budget from derived absence would make a missing receipt
  success-shaped.
- **Keep the caller-supplied unresolved list and validate it harder.** Rejected:
  the validator can only re-read the values it was handed. An omitted attempt or
  crash-lost array entry is not present to sum, so the checker cannot distinguish
  a complete list from a convenient one.
- **Add a cross-store transaction across `receipt-journal` and
  `runtime-state-store`.** Rejected: it would violate ADR 0013's isolated store
  identities and ADR 0014's two-primitive mapping. It is unnecessary because the
  safe ordering commits the hold in the cost ledger before the receipt journal
  can contain an attempt.
