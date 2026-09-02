# ADR 0014: The durable local trust store is a nonproduction substrate, not an authority

- **Status:** Accepted
- **Date:** 2026-08-30

## Context

Every trust-service store port in this repository — activation claims,
exact-agent selection grants, dispatch, run fences, Kernel/run state, stage
receipts, evidence, budgets, provider usage, domain operation grants, and
closure checkpoints — was implemented only as an in-memory fake inside test
files and `scripts/simulate-demos.ts`. Nothing survived a process restart,
nothing was safe across two processes, and there was no backup, corruption, or
replay story. ADR 0008 already requires a durable conditional ledger and an
operation-grant claim store; `docs/runbooks/deployment-prerequisites.md` lists
that storage as undeployed prerequisite item 5.

ADR 0013 then fixed the closed pre-App deployment contract, including exactly
four durable-store identities (`evidence-store`, `operation-grant-store`,
`receipt-journal`, `runtime-state-store`), each with a unique backend namespace
and credential identity, declared atomic guarantees, and a bounded journal
ceiling of 512 entries.

What was still missing was a reference implementation that actually exhibits
those guarantees, so the pre-App sandbox can be exercised across restarts and
processes without deploying a real store service.

## Decision

A local durable substrate is added as a **nonproduction reference
implementation**. It is mechanism, never authority.

**The substrate stores bytes; it does not interpret them.** It signs nothing,
mints nothing, reads no clock, and repairs no record. Several store ports'
callers additionally re-validate what the store returns — `src/demo-activation.ts`
recomputes `digest({ storeId, sequence, previousHead, claim, status, persistedAt })`
and refuses with `ACTIVATION_AMBIGUOUS` on a mismatch — and the shared
head-fidelity assertion in `tests/support/durable-substrate-harness.ts` exists so
later adapters are checked against that recomputation rather than against
themselves.

That caller-side re-validation is a strong backstop but **not a universal one**:
ports such as `EngineeringEvidenceStore.conditionalAppend` and
`EngineeringClosureCheckpointStore.put*` return `void` and are trusted directly.
Adapters therefore still own real semantics — choosing idempotency keys and
namespaces, packing state and evidence into one composite record, constructing
and signing contract-specific receipts, and translating substrate ambiguity into
each port's domain ambiguity. This ADR does not claim adapters are trivial; it
claims the substrate carries the durability risk and can be proven
independently.

**Two primitives cover the ports.** A review of all fifteen confirmed none
requires atomic mutation across two namespaces, provided each logical transition
is stored as one composite record. `appendOnce` is an idempotent keyed
append; `compareAndSwap` is an exact head swap. Both return the same trichotomy:
`appended`, `existing`, or `conflict`. `existing` requires **byte-identical
canonical bytes**; any other stored value under the same key is `conflict`. A
looser comparison would let a mutated replay satisfy a caller's idempotency
check, which is the most severe failure this design can have.

**The engine sits behind a narrow seam.** `src/durable-substrate.ts` declares the
interface and imports no backend. `src/durable-sqlite-substrate.ts` is the only
module in the repository that binds `node:sqlite`, enforced by a test. That
matters because `node:sqlite` is a release-candidate API: confining it means an
`node:fs`-only backend could replace one file without touching an adapter or a
test assertion. It is a Node built-in, so this adds no dependency, keeping
`THIRD_PARTY_NOTICES.md` free of bundled runtime dependencies.

**The runtime is gated twice, and fails closed.** On open the substrate requires
the running Node major to be one of the majors supplied from the repository
compatibility matrix, *and* requires a capability probe to pass: `DatabaseSync`
constructible, `backup` present, WAL and `synchronous=FULL` settable,
`user_version` readable and writable, `integrity_check` reporting `ok`, and a
conditional `UPDATE` reporting one row then zero. The version gate catches an
unsupported runtime; the probe catches a supported runtime whose API moved
underneath us, which a version string alone cannot detect. There is no
filesystem fallback, no degraded mode, and no default path — the caller supplies
an exact absolute path or the substrate refuses.

**Identity comes from ADR 0013, not from a second contract, and it is
authoritative rather than advisory.** Store identity, backend namespace,
credential identity, isolation, and journal bound are read from a validated
`DeploymentTopologyPlan`. No parallel store descriptor is defined here, because
a second store-identity contract would widen ADR 0013's closed four-store set
and immediately drift from it.

The store id, backend namespace, and journal bound are **written into the store
on creation and verified on every later open**, so the same file cannot be
reopened under a different identity or a wider bound and then emit evidence
bearing whatever the caller supplied. No write accepts a per-call bound.
Binding additionally refuses a shared namespace, a shared credential, or two
stores pointed at one file, since any of those would silently collapse the
independence the plan asserts.

**First-open provisioning is serialized behind the same cross-process write
lock as every write, closing a real first-open race.** Creating the schema
and identity row is check-then-act: read `user_version` to ask whether the
file is already initialized, then create it if not. An optimistic, lock-free
read handles the overwhelmingly common case — a store that is already
provisioned — exactly as before, so a normal reopen never pays for a write
lock it does not need. Only when that optimistic read finds an uninitialized
file does opening acquire `BEGIN IMMEDIATE` and re-read `user_version` *inside*
that transaction before deciding to create anything. Without the second read,
two independent processes racing the same absent file both observe
`user_version = 0` before either can write, and both attempt to insert the
same `id = 1` identity row: exactly one wins and the loser previously leaked a
raw `UNIQUE constraint failed: durable_meta.id` driver error instead of a typed
refusal. Re-reading inside the lock means the loser instead observes the
winner's already-committed identity and takes the same validation path an
ordinary reopen would — so two racers requesting *conflicting* identities,
namespaces, or bounds converge exactly as deterministically as two racers
requesting the same one: whichever commits first settles the durable identity,
and every other racer's post-lock read yields the same typed
`STORE_BINDING_INVALID` an ordinary mismatched reopen would, never a raw
error, a blind retry, a wrong identity, or a weakened check. A lock timeout
during creation is `STORE_UNAVAILABLE`, matching every other write lock
timeout in this module. A commit that fails after being attempted during
creation is the same ambiguity a write's commit raises — genuinely unknown
whether the schema and identity landed — surfaced as
`DurableAmbiguousAcknowledgementError` after a best-effort rollback that
releases the lock; unlike a write, an open has no caller-visible key to
reread, but retrying the open is always safe, because the retried transaction
re-derives its outcome from whatever is actually durable rather than guessing.

**The journal bound is store-wide.** ADR 0013 attaches `boundedJournal` to a
*store*, so counting each logical namespace separately would let a store with N
namespaces hold N times the entries its plan permits.

**Durability is transactional and cross-process.** Writes run inside
`BEGIN IMMEDIATE … COMMIT` under WAL with `synchronous=FULL`, and the
expected-head re-check happens *inside* the transaction so a head that moved
after an optimistic read yields `conflict` rather than a lost update. Because
`DatabaseSync` is synchronous and injected signers are asynchronous, **no `await`
may appear between `BEGIN IMMEDIATE` and `COMMIT`**; callers sign before
entering a write. A test asserts this over the transaction body.

**The journal refuses; it does not evict.** Reaching the plan's bound is a
`CAPACITY_EXHAUSTED` refusal. Dropping the oldest entry to make room would break
the hash chain and destroy exactly the replay evidence the journal exists to
hold.

**Ambiguity is a state, not an error to swallow.** A write whose durable outcome
cannot be determined raises a distinct
`DurableAmbiguousAcknowledgementError`, never a success- or failure-shaped
answer. The substrate guarantees a stable reread so the existing caller-side
double-read reconciliation can resolve it. A lock timeout is different and is
reported as `STORE_UNAVAILABLE`: the transaction never opened, so nothing was
written and the outcome is unambiguous.

Ambiguity concerns *what was durably written*, never *connection state*. The
commit path therefore rolls back best-effort before raising ambiguity. Leaving
the transaction open would be strictly worse than the ambiguity it reports:
same-handle reads would observe uncommitted rows and reconcile to a durable
outcome that does not exist, every other writer would block until the handle
closed, and the next write would surface a raw
`cannot start a transaction within a transaction` outside the refusal taxonomy.
If the commit did land there is nothing to roll back and the attempt fails
harmlessly. Reconciliation is consequently defined as reading through fresh
handles, not through the handle that experienced the fault.

**The persisted contracts are public; the implementation is not.**
`DurableStoreJournalRecord`, `DurableStoreBackupManifest`, and
`DurableStoreCompositionBackupManifest` are registered as closed document kinds
with schemas, validators, and a compatibility contract version, exactly as ADR
0013's contracts are — a persisted or exported document is a contract
regardless of who wrote it. The signed composition manifest binds one exact
four-store manifest set, deployment-topology digest, and signed stable
writer-quiescence checkpoint under a recomputed `backupSetId`.
The *implementation* is deliberately absent from `src/index.ts`. ADR 0013's
contracts are supported public API because later work consumes them; a
nonproduction reference store is not. Tests reach it by deep import, and
`tests/durable-api-surface.test.ts` fails if any durable symbol reaches the
barrel, so promoting it must be a deliberate reviewed decision rather than a
by-product of test convenience.

## Consequences

- The pre-App sandbox can exercise restart, replay, conflict, and recovery
  behaviour without deploying a store service.
- `src/durable-store-composition.ts` validates the exact
  `DeploymentTopologyPlan`, opens each of its four bound stores once, and
  constructs every one of the fifteen ports from only the handle assigned by
  the table below. The composition has no default path, clock, signer, provider
  result, genesis state, compatibility list, or budget, and remains absent from
  the public package barrel. It canonical-snapshots and privately freezes the
  validated topology, store paths, dispatch context, and genesis documents
  before opening, so later caller mutation cannot rebind backup evidence or
  adapter state.
- Adapter work maps ports onto two primitives and reuses
  one conformance harness. The normative mapping is:

  | Store | Ports | Primitive |
  |---|---|---|
  | `operation-grant-store` | `DemoActivationClaimStore`, `StageAgentSelectionGrantStore`, `DomainOperationGrantStore` | `appendOnce` |
  | `receipt-journal` | `DemoDispatchStore`, `DemoStageReceiptStore`, `DemoProviderUsageLedger`, `EngineeringProviderUsageLedger` | `appendOnce` |
  | `runtime-state-store` | `DemoRunStateStore`, `DemoKernelStateStore`, `DemoRunFenceStore`, `DemoBudgetLedger`, `DemoRecoveryBudgetStore`, `EngineeringCostLedger` | `compareAndSwap` |
  | `evidence-store` | `EngineeringEvidenceStore`, `EngineeringClosureCheckpointStore`, `DomainEvidenceLedger` | `appendOnce` |

  For engineering cost, the opened-but-unsettled attempt set is
  `runtime-state-store` cost-ledger state, not `receipt-journal` state.
  `EngineeringProviderUsageLedger` records attempt evidence only;
  `EngineeringCostLedger` derives open holds from its own
  `engineering.cost-ledger` lineage, so no cross-namespace transaction is
  required to decide the held set.

  A transition that must advance state *and* record its evidence atomically is
  stored as one composite record, which is why no cross-namespace transaction is
  required. `DomainEvidenceLedger` (`src/domain-packs.ts`) is included here even
  though it sits outside the fifteen ports named in the issue.
- The complete synthetic composition is exercised uninterrupted and with the
  process-equivalent store handles closed and reopened after every durable
  boundary. Progression and refusal evidence must be byte-identical in both
  cases. Backup/restore verifies all four manifests before use; removing the
  disabled stores recreates only genesis and never resurrects records.
- Restore verification reads one consistent inventory of every namespace in
  each restored store and requires exact namespace, sequence, head, per-namespace
  count, total-count, store-manifest digest, backup-set identity, and topology
  identity equality. An extra namespace or a store manifest mixed from another
  backup set is a typed `RESTORE_MISMATCH`.
- A composition backup requires the trusted writer-quiescence guard to return
  the same signed disabled generation and checkpoint before and after all four
  copies, and both observations must be current under the injected trusted
  clock. A stale, future, expired, or changed observation is
  `BACKUP_NOT_QUIESCENT`; a mixed/recomputed set cannot pass restore because the
  composition manifest itself is signed. Backup files are created only inside
  one new, atomically created mode-`0700` directory whose parent ownership,
  mode, and inode remain stable during every copy. Restore may validate an older
  backup because the signed composition manifest proves the freshness check was
  performed when the copies were made.
- A capacity refusal or an unavailable write lock reduces availability but
  cannot produce a success-shaped fallback.
- Concurrent first-open provisioning of the same store converges on exactly
  one identity deterministically, with no raw driver error, blind mutation
  retry, partial metadata, lock leak, wrong identity acceptance, or weakened
  open verification.
- Depending on a release-candidate built-in is a real risk, accepted because it
  is contained to one module and gated at open.
- This remains nonproduction. It is not a production database, carries no SLA
  claim, handles no App credential, performs no network call, and grants no
  capability.

## Rejected alternatives

- **A temporary store descriptor defined here.** Rejected: it would duplicate
  ADR 0013's closed store contract and guarantee churn when the two drifted.
- **A hand-rolled `node:fs` store** (`O_EXCL` plus atomic rename and `fsync`, as
  in `scripts/probe-review-agent-runtime.ts`). Rejected as the primary
  implementation: hand-built transactions, hash-chained journals, crash
  atomicity, and consistent online backup are precisely where durability defects
  hide. Retained as the documented fallback behind the seam.
- **A new dependency** such as `better-sqlite3` or `lmdb`. Rejected: native
  build and supply-chain surface, against a repository that bundles no runtime
  dependency.
- **`node:sqlite` used directly by each adapter.** Rejected: it would couple
  fifteen adapters to a release-candidate API and make the fallback a rewrite.
- **Evicting the oldest journal entry when full.** Rejected: it breaks the chain
  and destroys replay evidence.
- **Treating a lost acknowledgement as success or as failure.** Rejected: both
  are guesses; the caller must reconcile against durable state.
- **Catching the `durable_meta.id` unique-constraint violation and retrying the
  open.** Rejected as the primary fix: a caught-and-retried insert cannot tell
  "another process just created this store" apart from "this file is
  corrupt in a way that happens to collide on that key", so it would either
  paper over genuine corruption or still race a second time under contention.
  Serializing behind `BEGIN IMMEDIATE` removes the race outright rather than
  reacting to its symptom; the unique-constraint catch is retained only as
  defence in depth for an otherwise-unreachable path.
- **Always taking the write lock to open, even for an already-provisioned
  store.** Rejected: it would serialize every ordinary reopen against every
  in-flight write for no reason, when a lock-free read of `user_version`
  already answers "is this store already initialized?" correctly outside the
  narrow window where two processes are both creating it for the first time.
