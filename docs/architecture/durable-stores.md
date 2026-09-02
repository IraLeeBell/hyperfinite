# Durable stores

The local durable substrate is the nonproduction reference implementation of the
four durable stores fixed by the pre-App deployment contract (ADR 0013). It
exists so the sandbox can be exercised across process restarts and concurrent
processes without deploying a real store service.

See [ADR 0014](../adr/0014-durable-local-trust-substrate-is-nonproduction.md)
for the decision and the rejected alternatives.

## Authority position

The substrate sits below every existing authority. It stores exact bytes a
trusted caller already produced and returns exact bytes back. It does not sign,
mint, read a clock, choose a target, or repair a record, and it is not public
package API.

This is safe precisely because the callers already distrust it. Each store port
in `src/` re-validates whatever the store returns: `src/demo-activation.ts`
recomputes the receipt head and refuses with `ACTIVATION_AMBIGUOUS` when it does
not match. The substrate therefore cannot smuggle in contract semantics.

```
lifecycle graph → Work Accord → policy compiler → Control Kernel
  → trusted adapter → Single Writer
      → store port caller (re-validates every returned receipt)
          → DurableSubstrate  ← this module
```

## Structure

| Module | Role |
|---|---|
| `src/durable-substrate.ts` | The seam: interface, primitives, chain and capacity rules, refusal codes. Imports no backend. |
| `src/durable-sqlite-substrate.ts` | The only module that binds `node:sqlite`. Runtime gate, WAL transactions, backup. |
| `src/durable-store-binding.ts` | Derives store bindings from a validated `DeploymentTopologyPlan`. |
| `src/durable-store-composition.ts` | Validates the topology, opens its four bound stores exactly once, and wires all fifteen ports to their normative store. Deep-import only. |

`node:sqlite` is a release-candidate API, so it is confined to one module and a
test enforces that confinement. An `node:fs`-only backend could replace that one
file without touching an adapter or a test assertion.

## Complete composition

`openDurableStoreComposition` accepts the exact deployment plan, one explicit
absolute path per closed store identity, the repository-supported Node majors,
and every clock, signer, provider observation, genesis value, and budget needed
by an adapter. It validates the document and its semantic closed sets before
opening a file. The plan, path map, dispatch context, and genesis documents are
canonical-snapshotted and privately frozen first; caller-owned objects cannot
be mutated after open to change later backup/topology digests or genesis reads.
It then opens exactly one substrate for each store and wires:

| Store | Composed ports |
|---|---|
| `operation-grant-store` | `DemoActivationClaimStore`, `StageAgentSelectionGrantStore`, `DomainOperationGrantStore` |
| `receipt-journal` | `DemoDispatchStore`, `DemoStageReceiptStore`, `DemoProviderUsageLedger`, `EngineeringProviderUsageLedger` |
| `runtime-state-store` | `DemoKernelStateStore`, `DemoRunStateStore`, `DemoRunFenceStore`, `DemoBudgetLedger`, `DemoRecoveryBudgetStore`, `EngineeringCostLedger` |
| `evidence-store` | `EngineeringEvidenceStore`, `EngineeringClosureCheckpointStore` |

`DURABLE_ADAPTER_STORE_MAPPING` is the closed, deterministic inventory used by
the integration proof. It contains fifteen unique port names and only the four
plan store IDs. It is evidence, not caller-selectable routing; callers cannot
add an entry or choose another store.

Engineering cost keeps ADR 0016's safe ordering unchanged: a hold is committed
in `runtime-state-store` before `EngineeringProviderUsageLedger.begin` can
append an attempt to `receipt-journal`. The cost ledger reads adjacent provider
evidence but never writes across stores, and absence of usage cannot release a
hold.

The composition backs up all four stores under one new canonical absolute
backup root that it creates atomically with mode `0700`. The root's parent must
be owned by the current user and deny group/other writes; parent/root device,
inode, mode, and canonical identity are rechecked around every copy. Fixed child
names remove caller-selected per-store paths, and lexical (`.`/`..`), existing,
live-database, live-WAL/live-SHM, and symlink aliases refuse before copying.

The trusted quiescence guard must return the same signed `writerDisabled: true`
generation and checkpoint before and after all four copies. Both observations
must be current under the injected trusted clock. A stale, future, expired,
changed, or unauthenticated observation is `BACKUP_NOT_QUIESCENT`. One signed, closed
`DurableStoreCompositionBackupManifest` binds that checkpoint, the exact four
per-store manifest digests, and the topology digest under a recomputed
`backupSetId`. Consequently a caller cannot reconstruct a mixed-generation set
and authenticate it by recomputing only public digests.

A restored composition obtains one consistent, fully chain-verified inventory
of every namespace from each store and requires exact namespace-set, head,
sequence, count, store-manifest digest, backup-set, and topology equality. An
injected namespace, unauthenticated composition manifest, or manifest mixed
from a different backup set refuses with `RESTORE_MISMATCH`. This remains an
operator-disabled recovery operation, not an automatic enablement decision.
The private-directory check narrows races from other local identities; a process
already executing as the same user remains inside the local reference
substrate's trusted-host residual risk.

Restore authenticates the historical quiescence evidence through the signed
composition manifest; it does not require a retained backup to remain inside
its original short backup-time freshness window.

## Two primitives

All fifteen trust-service store ports reduce to two operations.

- **`appendOnce`** — idempotent keyed append.
- **`compareAndSwap`** — exact head swap; `expectedHead: null` means genesis.
- **`readCurrent`** — the head and the record that produced it, in one
  consistent view, so an adapter can perform a read-modify-write without
  scanning the journal or reading an incoherent pair.

Both return the same trichotomy:

| Status | Meaning |
|---|---|
| `appended` | this call durably created the record |
| `existing` | an identical record was already present, compared on **byte-identical canonical bytes** |
| `conflict` | the key holds different bytes, or the expected head has moved |

`existing` is deliberately strict, on two axes. The body must be byte-identical,
because a looser comparison would let a replay carrying a *mutated* body satisfy
a caller's idempotency check — the most severe failure this design can have. And
for `compareAndSwap`, the stored record's predecessor must equal the caller's
`expectedHead`, so `existing` means "my write already landed" rather than "some
identical write landed"; a caller fencing against a head that was never in the
chain gets `conflict`.

## Chain and journal

Each namespace is a hash chain. Genesis is `(sequence 0, head null)`; every
positive sequence carries a non-null head. Both impossible combinations —
`(0, digest)` and `(positive, null)` — are refused rather than normalized,
matching the exact store-head state rule of ADR 0008.

Each entry's head covers its namespace, key, sequence, predecessor head, and
body digest, so an inserted, reordered, dropped, or rewritten entry cannot
preserve the chain.

The journal is bounded by the plan's `boundedJournal.maxEntries` (ceiling 512).
The bound is **store-wide**, not per-namespace: the deployment contract attaches
`boundedJournal` to a store, so counting namespaces separately would let a store
with N namespaces hold N times its permitted entries. No write accepts a
per-call bound.

Reaching the bound is a `CAPACITY_EXHAUSTED` refusal. **It never evicts**:
dropping the oldest entry would break the chain and destroy the replay evidence
the journal exists to hold.

`entry_count` is the one head field the hash chain does not cover, so it is
checked explicitly on every head read and by `verifyChain`; a desynced counter
is a `CHAIN_INVALID` refusal rather than a silent widening of the bound.

## Concurrency

Writes run inside `BEGIN IMMEDIATE … COMMIT` under WAL with
`synchronous = FULL`. The expected-head re-check happens *inside* the
transaction, so a head that moved after an optimistic read yields `conflict`
rather than a lost update.

`DatabaseSync` is synchronous and injected signers are asynchronous, so **no
`await` may appear between `BEGIN IMMEDIATE` and `COMMIT`** — an interleaved
microtask there would let another operation observe a half-open transaction.
Callers sign *before* entering a write. A test asserts this over the transaction
body.

Pragma order matters: the busy timeout is applied before
`PRAGMA journal_mode = WAL`, because that statement needs an exclusive lock and
would otherwise fail instantly against a concurrent writer.

### First-open provisioning

Opening a store is check-then-act — read `user_version` to ask whether the
file is already initialized, then create the schema and identity row if not.
An optimistic, lock-free read handles the common case, an already-provisioned
store, exactly as before: a normal reopen never takes a write lock it does not
need. Only when that optimistic read finds an uninitialized file does opening
acquire the same `BEGIN IMMEDIATE` write lock every write uses, re-reading
`user_version` *inside* the transaction before deciding what to do. Without
that second, locked read, two processes racing the same absent file both see
`user_version = 0` before either writes and both attempt to insert the same
`id = 1` identity row, and the loser previously surfaced a raw
`UNIQUE constraint failed: durable_meta.id` driver error instead of a typed
outcome.

Serializing this way makes every racer converge deterministically, including a
genuine identity conflict: whichever process's transaction commits first
settles the store's durable identity, namespace, and bound, and every other
racer's post-lock read takes the exact same `STORE_BINDING_INVALID` path an
ordinary mismatched reopen would — never a raw error, a blind retry, a
different accepted identity, or a weakened check. A lock timeout during
creation is `STORE_UNAVAILABLE`, identical to a write's lock timeout. A commit
that fails after being attempted during creation raises
`DurableAmbiguousAcknowledgementError` after a best-effort rollback that frees
the lock; retrying the open is always safe, because the retried transaction
re-derives its outcome from whatever the file actually holds rather than
guessing.

## Failure modes

| Code | Meaning |
|---|---|
| `RUNTIME_UNSUPPORTED` | unsupported Node major, or the capability probe failed |
| `STORE_PATH_INVALID` | path missing, relative, or containing a NUL byte |
| `STORE_FORMAT_MISMATCH` | `user_version` is not the supported format |
| `STORE_CORRUPT` | `integrity_check` failed, stored bytes do not re-derive their digest, or the identity row is missing |
| `STORE_BINDING_INVALID` | omitted, duplicated, shared, or under-guaranteed store, including a losing identity during a first-open provisioning race |
| `STORE_UNAVAILABLE` | the write lock was unavailable; nothing was written, including during first-open provisioning |
| `CHAIN_INVALID` | impossible chain state, sequence gap, or broken link |
| `CAPACITY_EXHAUSTED` | the store-wide bounded journal is full |
| `ARGUMENT_INVALID` | malformed namespace, key, digest, or bound |

`DurableAmbiguousAcknowledgementError` is **not** in this table on purpose. A
refusal means the operation definitely did not happen. An ambiguous
acknowledgement means the outcome is unknown, and it is never collapsed into
success or failure — the substrate guarantees a stable reread so the caller's
existing double-read reconciliation can resolve it. Opening a store can raise
this too, for the same reason a write can: a commit attempted during
first-open provisioning whose acknowledgement is lost. An open has no
caller-visible key to reread, but retrying the open is always safe.

A lock timeout is distinct from ambiguity: the transaction never opened, so
nothing was written and `STORE_UNAVAILABLE` is unambiguous and retryable.

Ambiguity is about durable content, not connection state. The commit path rolls
back best-effort before raising it, so the write lock is released and later
operations still return typed outcomes. Reconcile by reading through a **fresh
handle**: a read on the handle that experienced the fault could otherwise
observe uncommitted rows.

The backup manifest's namespace list is bounded by the store-wide journal
ceiling rather than a smaller cap, because the degenerate case is one
single-entry namespace per record; a lower cap would let `backup()` emit
evidence that fails its own schema.

## Runtime gate


Opening a store requires both:

1. the running Node major is one of the majors supplied from the repository
   compatibility matrix; and
2. a capability probe passes — `DatabaseSync` constructible, `backup` present,
   WAL and `synchronous=FULL` settable, `user_version` round-tripping,
   `integrity_check` reporting `ok`, and a conditional `UPDATE` reporting one
   row then zero.

The version gate catches an unsupported runtime. The probe catches a supported
runtime whose API moved underneath us, which a version string cannot detect.
There is no fallback and no default path.

## Identity

Store identity, backend namespace, credential identity, isolation, and journal
bound all come from a validated `DeploymentTopologyPlan`. This module defines no
store descriptor of its own; a second store-identity contract would widen ADR
0013's closed four-store set and drift from it.

The binding is authoritative, not advisory: the store id, backend namespace, and
journal bound are written into the store when it is created and **verified on
every later open**. Reopening the same file under a different store id,
namespace, or bound is a `STORE_BINDING_INVALID` refusal, so a store cannot emit
evidence under an identity the caller merely asserted.

Binding refuses an omitted, duplicated, or unknown store, a shared backend
namespace or credential, a store shared with a model runner, and two stores
pointed at one file.

`identity.credentialId` is an opaque logical name from the plan. It is never a
secret value and is never resolved to a credential.

## Non-goals

Not a production database and no SLA claim. No App credential, no network call,
no environment read, no paid inference, and no live GitHub effect.

## Synthetic canary composition

`npm run canary:synthetic` composes this durable proof with the closed portfolio
hardening evidence without changing the mapping or adding another authority. It
runs the full close/reopen, multi-process, backup/restore, disabled-state,
corruption, ambiguity, provider-reconciliation, and cost-hold cases under the
Node network deny guard, binds the executed compiled test files by digest, and
emits deterministic target-free signed evidence.

The canary is still nonproduction. It uses fixed synthetic bindings, clocks,
provider observations, and ephemeral in-memory test key material. It performs no
live GitHub or administration effect and stops at Human Review.
