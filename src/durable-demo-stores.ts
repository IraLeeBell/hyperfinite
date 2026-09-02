/**
 * Durable adapters for the eight trust-service store ports named by issue
 * The durable demo adapters cover `DemoActivationClaimStore`,
 * `StageAgentSelectionGrantStore`,
 * `DemoDispatchStore`, `DemoProviderUsageLedger`, `DemoKernelStateStore`,
 * `DemoStageReceiptStore`, `DemoRunStateStore`, and `DemoRecoveryBudgetStore`.
 *
 * This module maps each port onto the two primitives declared by
 * `src/durable-substrate.ts` (`appendOnce`, `compareAndSwap`), per the
 * normative mapping in ADR 0014:
 *
 * | Store                  | Ports (of this module)                                                              | Primitive       |
 * |-------------------------|--------------------------------------------------------------------------------------|-----------------|
 * | `operation-grant-store` | `DemoActivationClaimStore`, `StageAgentSelectionGrantStore`                          | `appendOnce`    |
 * | `receipt-journal`        | `DemoDispatchStore`, `DemoStageReceiptStore`, `DemoProviderUsageLedger`              | `appendOnce`    |
 * | `runtime-state-store`    | `DemoKernelStateStore`, `DemoRunStateStore`, `DemoRecoveryBudgetStore`               | `compareAndSwap`|
 *
 * Authority position: this module is mechanism, never authority. It never
 * signs on its own initiative — where a port's interface requires a signed
 * receipt (`DemoActivationClaimStore`, `DemoDispatchStore`,
 * `DemoRecoveryBudgetStore`, `DemoProviderUsageLedger`), an injected signer is
 * required and no key material lives here. Genesis values (the state a port
 * must report before its first durable write) are injected too, never
 * fabricated. Every `read`/`readEvidence` returns exactly the durable bytes
 * the substrate holds; there is no success-shaped fallback.
 *
 * Two idempotency shapes recur:
 *
 * - **Self-contained receipt ports** (`DemoActivationClaimStore`,
 *   `DemoDispatchStore`, `StageAgentSelectionGrantStore`,
 *   `DemoProviderUsageLedger`) key each logical operation into its own
 *   dedicated namespace (`prefix:{operationKey}`), so a first write is always
 *   chain genesis (`sequence` 1, `previousHead` null) — no guess against a
 *   racing writer is required. `appendOnce`'s own byte-identical comparison
 *   then decides idempotent replay versus conflict; a substrate `conflict`
 *   is re-read once to distinguish a benign metadata race (another writer's
 *   byte-identical *operation*, different attempt metadata) from a genuine
 *   conflicting replay.
 * - **Single-lineage compare-and-swap ports** (`DemoKernelStateStore`,
 *   `DemoRunStateStore`, `DemoRecoveryBudgetStore`) track one evolving chain
 *   per store instance in a fixed namespace. Each port independently
 *   verifies the caller's expected predecessor against the durably observed
 *   current record *before* touching the substrate (fail-fast on a stale
 *   precondition), then compare-and-swaps using the substrate's own current
 *   head as the fencing token and a key derived from the new record's own
 *   content digest. A precondition mismatch that already equals the
 *   requested successor (with matching evidence, where evidence exists) is
 *   reported as `existing`, matching the reference in-memory stores in
 *   `tests/demo-runtime.test.ts`.
 *
 * `DemoStageReceiptStore` is an append-only port with a compare-and-swap-like
 * fencing requirement (`expectedRunStateDigest`): it uses a single shared
 * namespace keyed by the predecessor run-state digest, so only one receipt
 * can ever durably claim a given predecessor, and `read(receiptDigest)`
 * resolves by scanning the bounded journal (`verifyChain`) for the matching
 * receipt content digest, since the journal is keyed by predecessor, not by
 * receipt digest.
 *
 * **Ambiguity is never resolved by resubmitting a mutation.** Six ports
 * expose a dedicated caller-catchable ambiguous-error class (activation
 * claim, dispatch, stage receipt, kernel/run-state/recovery-budget state);
 * those translate the substrate's `DurableAmbiguousAcknowledgementError`
 * directly into that class and leave reconciliation to the existing
 * caller-side double read (see e.g. `reconcileAmbiguousClaim` in
 * `src/demo-activation.ts`). The two ports whose interface has no such
 * class (`StageAgentSelectionGrantStore`, `DemoProviderUsageLedger`)
 * reconcile *here*, but strictly through `classifyAmbiguousWrite`'s bounded,
 * side-effect-free double read — never by attempting the write again. A
 * mutation that actually landed must not risk a second side effect (a
 * second signature, a second provider charge, a second durable append
 * racing a second writer) from a caller who merely failed to observe the
 * first attempt's true outcome.
 *
 * **`DemoProviderUsageLedger.reconcile()` additionally gates its call to the
 * injected `resolveUsage` callback behind an atomic, fully deterministic
 * durable claim.** Because the claim body depends only on the attempt's
 * digest, the substrate's own cross-process `appendOnce` atomicity (proved
 * in `tests/durable-multiprocess.test.ts`) decides exactly one winner across
 * any number of concurrent callers or processes racing the same attempt —
 * without needing a lock, a lease, or a second store. Every other caller,
 * including one that starts after an earlier claimant crashed before
 * finishing, is a contender: it must never call `resolveUsage`, and either
 * observes an already-completed usage record or fails closed with
 * `DemoProviderUsageLedgerReconciliationPendingError`.
 */

import { canonicalJson, digest } from "./canonical.js";
import type {
  DemoActivationClaim,
  DemoActivationClaimReceipt,
  DemoActivationClaimResult,
  DemoActivationClaimStore,
  DemoEvidenceSigner,
  DemoEvidenceVerifier,
  DemoRecoveryBudgetEvidence
} from "./demo-activation.js";
import { DemoActivationClaimAmbiguousError } from "./demo-activation.js";
import type { StageAgentSelectionGrantStore } from "./demo-agent-selection.js";
import type {
  DemoDispatchPersistenceReceipt,
  DemoDispatchPersistenceResult,
  DemoDispatchStore
} from "./demo-dispatcher.js";
import { DemoDispatchPersistenceAmbiguousError } from "./demo-dispatcher.js";
import type { DemoRuntimeReconstruction } from "./demo-runtime-state.js";
import type { DemoBudgetState } from "./demo-runtime-state.js";
import type {
  DemoKernelStateStore,
  DemoRecoveryBudgetStore,
  DemoRunStateStore,
  DemoStageReceiptStore
} from "./demo-runtime.js";
import {
  DemoKernelPersistenceAmbiguousError,
  DemoRecoveryBudgetPersistenceAmbiguousError,
  DemoRunStatePersistenceAmbiguousError,
  DemoStageReceiptPersistenceAmbiguousError
} from "./demo-runtime.js";
import type {
  DemoProviderAttemptEvidence,
  DemoProviderUsageEvidence,
  DemoProviderUsageLedger
} from "./demo-scheduler.js";
import type {
  SignedStageAgentSelectionGrant,
  SignedStageReceipt
} from "./demo-types.js";
import {
  DurableAmbiguousAcknowledgementError,
  type DurableRecord,
  type DurableSubstrate,
  type DurableWriteStatus
} from "./durable-substrate.js";
import type { Digest, KernelSnapshot, KernelResult } from "./types.js";

/** Injected wall-clock. The substrate reads no ambient clock; neither do these adapters. */
export interface DurableDemoClock {
  now(): string;
}

/**
 * Raised only when a lost commit acknowledgement for `DemoProviderUsageLedger`
 * cannot be resolved through bounded stable reads (see `classifyAmbiguousWrite`)
 * — either the reads themselves disagree/fault ("unstable"), or a definite
 * negative outcome is confirmed with no completed usage record to fall back
 * on. `DemoProviderUsageLedger`'s interface has no status field to report
 * this through, unlike every other port in this module, so an unresolved
 * ambiguity surfaces as this typed rejection rather than the raw substrate
 * `DurableAmbiguousAcknowledgementError` or a success-shaped guess. The
 * mutation is never resubmitted to try to clear it.
 */
export class DemoProviderUsageLedgerPersistenceFailedError extends Error {
  constructor(
    message = "provider usage ledger acknowledgement remained ambiguous after every retry"
  ) {
    super(message);
    this.name = "DemoProviderUsageLedgerPersistenceFailedError";
  }
}

/**
 * Raised by `DemoProviderUsageLedger.reconcile()` when this call does not
 * hold exclusive reconciliation rights for an attempt (see the `claim`
 * gate below) and no completed usage record is durably present yet. This is
 * the safe, fail-closed outcome for every contender — a concurrent racer, or
 * a call made after a prior claimant crashed before finishing — since none
 * of them may invoke the injected, potentially billable `resolveUsage`
 * callback a second time without authenticated provider-side idempotency
 * evidence this port does not have.
 */
export class DemoProviderUsageLedgerReconciliationPendingError extends Error {
  constructor(readonly attemptDigest: Digest, message?: string) {
    super(
      message ??
        `provider usage reconciliation for attempt ${attemptDigest} is claimed by another caller and not yet complete`
    );
    this.name = "DemoProviderUsageLedgerReconciliationPendingError";
  }
}

/**
 * Raised by `StageAgentSelectionGrantStore.claim()` when a lost commit
 * acknowledgement cannot be resolved through bounded stable reads (the two
 * reads disagree with each other, or a read itself faults). This is
 * distinct from the port's ordinary `"conflict"` status, which is reserved
 * for a *confirmed* negative outcome (a different grant durably exists, or
 * the write is stably confirmed to never have landed) — collapsing a
 * genuinely unresolved state into `"conflict"` would let the caller treat an
 * unknown outcome as a resolved competing selection requiring
 * reconciliation, when in fact retrying the identical claim from scratch may
 * have succeeded cleanly. The mutation is never resubmitted to try to
 * clear it.
 */
export class StageAgentSelectionGrantPersistenceAmbiguousError extends Error {
  constructor(
    message = "stage-agent selection grant acknowledgement is ambiguous"
  ) {
    super(message);
    this.name = "StageAgentSelectionGrantPersistenceAmbiguousError";
  }
}

// ---------------------------------------------------------------------------
// Shared low-level helpers
// ---------------------------------------------------------------------------

/**
 * Idempotent single-record write for a namespace dedicated to exactly one
 * logical operation (so the first write is always chain genesis).
 *
 * `sameOperation` decides whether a stored body already occupying the key
 * represents the same logical operation as the one being attempted (as
 * opposed to a different operation that happens to reuse the key, which is
 * a genuine conflict). It is checked both for an already-existing record
 * (fast idempotent path, no substrate write attempted) and after a
 * substrate-reported conflict (a benign race between two writers of the
 * same operation, distinguished from a real conflicting replay).
 */
async function singleKeyIdempotentWrite(input: {
  readonly substrate: DurableSubstrate;
  readonly namespace: string;
  readonly key: string;
  readonly buildBody: () => Promise<unknown>;
  readonly sameOperation: (storedBody: unknown) => boolean;
}): Promise<{ readonly status: DurableWriteStatus; readonly body: unknown }> {
  const existing = await input.substrate.read({
    namespace: input.namespace,
    key: input.key
  });
  if (existing !== null) {
    return input.sameOperation(existing.body)
      ? { status: "existing", body: existing.body }
      : { status: "conflict", body: null };
  }
  const body = await input.buildBody();
  const outcome = await input.substrate.appendOnce({
    namespace: input.namespace,
    key: input.key,
    body
  });
  if (outcome.status === "appended") {
    return { status: "appended", body };
  }
  if (outcome.status === "existing") {
    return { status: "existing", body: outcome.record?.body ?? body };
  }
  // A substrate conflict on a namespace dedicated to this one operation means
  // a racing writer landed first. Re-read the authoritative record: if it is
  // the same logical operation, this is a benign metadata race (for example
  // two writers computing the same claim at a different wall-clock instant),
  // reported as existing; otherwise it is a genuine conflicting replay.
  const reread = await input.substrate.read({
    namespace: input.namespace,
    key: input.key
  });
  if (reread !== null && input.sameOperation(reread.body)) {
    return { status: "existing", body: reread.body };
  }
  return { status: "conflict", body: null };
}

/**
 * Classifies the durable outcome of a write whose acknowledgement was lost
 * (`DurableAmbiguousAcknowledgementError`), using **bounded stable reads
 * only** — the write itself is never resubmitted. Retrying a mutation after
 * an ambiguous acknowledgement risks a second side effect (a second
 * signature, a second provider charge, a second durable append racing a
 * second writer) whenever the original write actually landed; reads carry no
 * such risk.
 *
 * - `"matches"` — both reads agree, and the record equals what this call
 *   attempted to write. The write demonstrably landed; report it as if the
 *   caller's own operation succeeded (`existing`).
 * - `"differs"` — both reads agree, but on something other than what this
 *   call attempted (including a stable, confirmed absence). This is a
 *   *definite*, not ambiguous, negative outcome: either a different durable
 *   record already occupies the slot, or the write demonstrably never
 *   landed. Both are safe to report through the port's ordinary failure
 *   status, because both are confirmed states, never a guess.
 * - `"unstable"` — the two reads disagree with each other, or a read itself
 *   faults. The true state cannot be determined from here at all; the
 *   caller must fail closed with a dedicated ambiguity error rather than
 *   conceal this as an ordinary conflict or retry the mutation.
 */
async function classifyAmbiguousWrite(input: {
  readonly substrate: DurableSubstrate;
  readonly namespace: string;
  readonly key: string;
  readonly matchesAttempted: (storedBody: unknown) => boolean;
}): Promise<
  | { readonly kind: "matches"; readonly record: DurableRecord }
  | { readonly kind: "differs"; readonly record: DurableRecord | null }
  | { readonly kind: "unstable" }
> {
  let first: DurableRecord | null;
  let second: DurableRecord | null;
  try {
    first = await input.substrate.read({ namespace: input.namespace, key: input.key });
    second = await input.substrate.read({ namespace: input.namespace, key: input.key });
  } catch {
    return { kind: "unstable" };
  }
  const firstView = first === null ? null : canonicalJson(first.body);
  const secondView = second === null ? null : canonicalJson(second.body);
  if (firstView !== secondView) {
    return { kind: "unstable" };
  }
  if (second !== null && input.matchesAttempted(second.body)) {
    return { kind: "matches", record: second };
  }
  return { kind: "differs", record: second };
}

function withoutSignature<T extends { readonly signature: unknown }>(
  value: T
): Omit<T, "signature"> {
  const { signature: _signature, ...rest } = value;
  return rest;
}

function derivedNamespace(prefix: string, key: string): string {
  return `${prefix}:${key}`;
}

// ---------------------------------------------------------------------------
// DemoActivationClaimStore — operation-grant-store, appendOnce
// ---------------------------------------------------------------------------

export interface DurableDemoActivationClaimStoreOptions {
  readonly substrate: DurableSubstrate;
  readonly signer: DemoEvidenceSigner;
  readonly clock: DurableDemoClock;
  /** Defaults to `demo-activation-claim`. Each claim gets its own derived namespace. */
  readonly namespacePrefix?: string;
}

export function createDurableDemoActivationClaimStore(
  options: DurableDemoActivationClaimStoreOptions
): DemoActivationClaimStore {
  const prefix = options.namespacePrefix ?? "demo-activation-claim";
  const storeId = options.substrate.metadata.storeId;

  function namespaceFor(claimKey: Digest): string {
    return derivedNamespace(prefix, claimKey);
  }

  function sameClaim(storedBody: unknown, claim: DemoActivationClaim): boolean {
    return (
      storedBody !== null &&
      typeof storedBody === "object" &&
      canonicalJson((storedBody as DemoActivationClaimReceipt).claim) ===
        canonicalJson(claim)
    );
  }

  async function buildReceipt(
    claim: DemoActivationClaim
  ): Promise<DemoActivationClaimReceipt> {
    const persistedAt = options.clock.now();
    const head = digest({
      storeId,
      sequence: 1,
      previousHead: null,
      claim,
      status: "appended",
      persistedAt
    });
    const unsigned = {
      schemaVersion: "1.0.0" as const,
      storeId,
      sequence: 1,
      previousHead: null,
      claim,
      status: "appended" as const,
      head,
      persistedAt
    };
    const signature = await options.signer.sign(unsigned);
    return { ...unsigned, signature };
  }

  return {
    async claim(claim): Promise<DemoActivationClaimResult> {
      const namespace = namespaceFor(claim.claimKey);
      let result: { readonly status: DurableWriteStatus; readonly body: unknown };
      try {
        result = await singleKeyIdempotentWrite({
          substrate: options.substrate,
          namespace,
          key: "receipt",
          buildBody: () => buildReceipt(claim),
          sameOperation: (stored) => sameClaim(stored, claim)
        });
      } catch (error) {
        if (error instanceof DurableAmbiguousAcknowledgementError) {
          throw new DemoActivationClaimAmbiguousError(error.message);
        }
        throw error;
      }
      return {
        status: result.status,
        receipt: result.body as DemoActivationClaimReceipt | null
      };
    },
    async read(claimKey) {
      const record = await options.substrate.read({
        namespace: namespaceFor(claimKey),
        key: "receipt"
      });
      return record === null ? null : (record.body as DemoActivationClaimReceipt);
    }
  };
}

// ---------------------------------------------------------------------------
// StageAgentSelectionGrantStore — operation-grant-store, appendOnce
// ---------------------------------------------------------------------------

export interface DurableStageAgentSelectionGrantStoreOptions {
  readonly substrate: DurableSubstrate;
  /** Defaults to `demo-stage-agent-selection-grant`. Each selection key gets its own derived namespace. */
  readonly namespacePrefix?: string;
}

export function createDurableStageAgentSelectionGrantStore(
  options: DurableStageAgentSelectionGrantStoreOptions
): StageAgentSelectionGrantStore {
  const prefix = options.namespacePrefix ?? "demo-stage-agent-selection-grant";

  function namespaceFor(selectionKey: Digest): string {
    return derivedNamespace(prefix, selectionKey);
  }

  function sameGrant(
    storedBody: unknown,
    grant: SignedStageAgentSelectionGrant
  ): boolean {
    return (
      storedBody !== null &&
      typeof storedBody === "object" &&
      (storedBody as SignedStageAgentSelectionGrant).contentDigest ===
        grant.contentDigest
    );
  }

  return {
    supportsAtomicCreate: true,
    async claim(grant) {
      const namespace = namespaceFor(grant.spec.selectionKey);
      let outcome: { readonly status: DurableWriteStatus; readonly body: unknown };
      try {
        outcome = await singleKeyIdempotentWrite({
          substrate: options.substrate,
          namespace,
          key: "grant",
          buildBody: () => Promise.resolve(grant),
          sameOperation: (stored) => sameGrant(stored, grant)
        });
      } catch (error) {
        if (!(error instanceof DurableAmbiguousAcknowledgementError)) throw error;
        // Never resubmit the write. Reconcile through bounded stable reads
        // only.
        const classification = await classifyAmbiguousWrite({
          substrate: options.substrate,
          namespace,
          key: "grant",
          matchesAttempted: (stored) => sameGrant(stored, grant)
        });
        if (classification.kind === "matches") {
          return {
            status: "existing" as const,
            grant: classification.record.body as SignedStageAgentSelectionGrant
          };
        }
        if (classification.kind === "differs") {
          // A confirmed, definite negative outcome: either a different grant
          // durably occupies this selection key, or the write is stably
          // confirmed to have never landed. Both map to the port's ordinary
          // failure status, which the caller already treats as a safe,
          // non-authority-inventing refusal (see demo-agent-selection.ts).
          return { status: "conflict" as const, grant: null };
        }
        // classification.kind === "unstable": the true state cannot be
        // determined from here. Fail closed rather than conceal this as an
        // ordinary conflict or guess by retrying the mutation.
        throw new StageAgentSelectionGrantPersistenceAmbiguousError(error.message);
      }
      return {
        status: outcome.status,
        grant: outcome.body as SignedStageAgentSelectionGrant | null
      };
    },
    async read(selectionKey) {
      const record = await options.substrate.read({
        namespace: namespaceFor(selectionKey),
        key: "grant"
      });
      return record === null ? null : (record.body as SignedStageAgentSelectionGrant);
    }
  };
}

// ---------------------------------------------------------------------------
// DemoDispatchStore — receipt-journal, appendOnce
// ---------------------------------------------------------------------------

export interface DurableDemoDispatchStoreOptions {
  readonly substrate: DurableSubstrate;
  readonly signer: DemoEvidenceSigner;
  readonly clock: DurableDemoClock;
  /**
   * The receipt's `repositoryId`/`workItemNodeId`/`authorityEpoch`/`generation`
   * fields are not derivable from `DemoDispatchDecision` alone (its `spec`
   * carries only `runStateDigest`). This store instance is dedicated to one
   * run, so these are fixed context supplied at construction — matching the
   * reference in-memory `DispatchStore` in `tests/demo-runtime.test.ts`,
   * which fixes the same fields per store instance.
   */
  readonly repositoryId: number;
  readonly workItemNodeId: string;
  readonly authorityEpoch: number;
  readonly generation: number;
  /** Defaults to `demo-dispatch`. Each decision gets its own derived namespace. */
  readonly namespacePrefix?: string;
}

export function createDurableDemoDispatchStore(
  options: DurableDemoDispatchStoreOptions
): DemoDispatchStore {
  const prefix = options.namespacePrefix ?? "demo-dispatch";
  const storeId = options.substrate.metadata.storeId;

  function namespaceFor(decisionDigest: Digest): string {
    return derivedNamespace(prefix, decisionDigest);
  }

  function sameDecision(storedBody: unknown, decisionDigest: Digest): boolean {
    return (
      storedBody !== null &&
      typeof storedBody === "object" &&
      (storedBody as DemoDispatchPersistenceReceipt).decisionDigest ===
        decisionDigest
    );
  }

  async function buildReceipt(
    decisionDigest: Digest,
    runStateDigest: Digest
  ): Promise<DemoDispatchPersistenceReceipt> {
    const persistedAt = options.clock.now();
    const fields = {
      storeId,
      sequence: 1,
      previousHead: null,
      decisionDigest,
      runStateDigest,
      repositoryId: options.repositoryId,
      workItemNodeId: options.workItemNodeId,
      authorityEpoch: options.authorityEpoch,
      generation: options.generation,
      status: "persisted" as const,
      persistedAt
    };
    const head = digest(fields);
    const unsigned = { schemaVersion: "1.0.0" as const, ...fields, head };
    const signature = await options.signer.sign(unsigned);
    return { ...unsigned, signature };
  }

  return {
    async persist(decision): Promise<DemoDispatchPersistenceResult> {
      const namespace = namespaceFor(decision.contentDigest);
      let result: { readonly status: DurableWriteStatus; readonly body: unknown };
      try {
        result = await singleKeyIdempotentWrite({
          substrate: options.substrate,
          namespace,
          key: "receipt",
          buildBody: () =>
            buildReceipt(decision.contentDigest, decision.spec.runStateDigest),
          sameOperation: (stored) => sameDecision(stored, decision.contentDigest)
        });
      } catch (error) {
        if (error instanceof DurableAmbiguousAcknowledgementError) {
          throw new DemoDispatchPersistenceAmbiguousError(error.message);
        }
        throw error;
      }
      return {
        status: result.status,
        receipt: result.body as DemoDispatchPersistenceReceipt | null
      };
    },
    async read(decisionDigest) {
      const record = await options.substrate.read({
        namespace: namespaceFor(decisionDigest),
        key: "receipt"
      });
      return record === null ? null : (record.body as DemoDispatchPersistenceReceipt);
    }
  };
}

// ---------------------------------------------------------------------------
// DemoStageReceiptStore — receipt-journal, appendOnce (predecessor-fenced)
// ---------------------------------------------------------------------------

export interface DurableDemoStageReceiptStoreOptions {
  readonly substrate: DurableSubstrate;
  /**
   * Shared across every receipt this store instance ever records (unlike the
   * other appendOnce ports above): only one receipt may durably claim a given
   * predecessor run-state digest, which this store enforces by using that
   * digest as the append key in one shared namespace. `read(receiptDigest)`
   * therefore resolves by scanning the bounded journal rather than a direct
   * keyed lookup. Defaults to `demo-stage-receipt`.
   */
  readonly namespace?: string;
}

export function createDurableDemoStageReceiptStore(
  options: DurableDemoStageReceiptStoreOptions
): DemoStageReceiptStore {
  const namespace = options.namespace ?? "demo-stage-receipt";

  interface StoredStageReceipt {
    readonly receipt: SignedStageReceipt;
    readonly runState: DemoRuntimeReconstruction["runState"];
  }

  return {
    async append(input) {
      // The predecessor fence is the append key. A receipt whose own
      // `spec.runStateDigest` disagrees with `expectedRunStateDigest` would,
      // if persisted, durably consume an unrelated predecessor's slot and
      // make a later `read(receiptDigest)` return a self-contradictory
      // record (a receipt claiming one predecessor, keyed under another).
      // Fail closed before ever writing, matching the invariant the
      // reference in-memory store asserts (`tests/demo-runtime.test.ts`,
      // `class StageReceiptStore`).
      if (input.receipt.spec.runStateDigest !== input.expectedRunStateDigest) {
        throw new TypeError(
          "stage receipt runStateDigest does not match its own expectedRunStateDigest predecessor fence"
        );
      }
      const body: StoredStageReceipt = {
        receipt: input.receipt,
        runState: input.nextRunState
      };
      let outcome;
      try {
        outcome = await options.substrate.appendOnce({
          namespace,
          key: input.expectedRunStateDigest,
          body
        });
      } catch (error) {
        if (error instanceof DurableAmbiguousAcknowledgementError) {
          throw new DemoStageReceiptPersistenceAmbiguousError(error.message);
        }
        throw error;
      }
      return { status: outcome.status };
    },
    async read(receiptDigest) {
      const chain = await options.substrate.verifyChain(namespace);
      for (const record of chain) {
        const body = record.body as StoredStageReceipt;
        if (body.receipt.contentDigest === receiptDigest) {
          return body;
        }
      }
      return null;
    }
  };
}

// ---------------------------------------------------------------------------
// DemoKernelStateStore — runtime-state-store, compareAndSwap (single lineage)
// ---------------------------------------------------------------------------

export interface DurableDemoKernelStateStoreOptions {
  readonly substrate: DurableSubstrate;
  /** The snapshot this store must report before its first durable write. */
  readonly genesisSnapshot: KernelSnapshot;
  /** Defaults to `demo-kernel-state`. */
  readonly namespace?: string;
}

export function createDurableDemoKernelStateStore(
  options: DurableDemoKernelStateStoreOptions
): DemoKernelStateStore {
  const namespace = options.namespace ?? "demo-kernel-state";

  async function currentSnapshot(): Promise<{
    readonly head: Digest | null;
    readonly snapshot: KernelSnapshot;
  }> {
    const current = await options.substrate.readCurrent(namespace);
    return {
      head: current.head.head,
      snapshot:
        current.record === null
          ? options.genesisSnapshot
          : (current.record.body as KernelSnapshot)
    };
  }

  return {
    async persistApplied(result: Extract<KernelResult, { kind: "applied" }>) {
      const current = await currentSnapshot();
      if (result.receipt.previousReceipt !== current.snapshot.receiptHead) {
        // Already durably applied exactly this transition? Report existing
        // rather than a conflict a caller cannot distinguish from a genuine
        // concurrent writer.
        if (
          current.snapshot.receiptHead === result.snapshot.receiptHead &&
          canonicalJson(current.snapshot) === canonicalJson(result.snapshot)
        ) {
          return { status: "existing" as const };
        }
        return { status: "conflict" as const };
      }
      let outcome;
      try {
        outcome = await options.substrate.compareAndSwap({
          namespace,
          key: result.receiptDigest,
          expectedHead: current.head,
          body: result.snapshot
        });
      } catch (error) {
        if (error instanceof DurableAmbiguousAcknowledgementError) {
          throw new DemoKernelPersistenceAmbiguousError(error.message);
        }
        throw error;
      }
      return { status: outcome.status };
    },
    async read() {
      return (await currentSnapshot()).snapshot;
    }
  };
}

// ---------------------------------------------------------------------------
// DemoRunStateStore — runtime-state-store, compareAndSwap (single lineage)
// ---------------------------------------------------------------------------

export interface DurableDemoRunStateStoreOptions {
  readonly substrate: DurableSubstrate;
  /** The run state this store must report before its first durable write. */
  readonly genesisRunState: DemoRuntimeReconstruction["runState"];
  /** Defaults to `demo-run-state`. */
  readonly namespace?: string;
}

export function createDurableDemoRunStateStore(
  options: DurableDemoRunStateStoreOptions
): DemoRunStateStore {
  const namespace = options.namespace ?? "demo-run-state";

  async function currentRunState(): Promise<{
    readonly head: Digest | null;
    readonly runState: DemoRuntimeReconstruction["runState"];
  }> {
    const current = await options.substrate.readCurrent(namespace);
    return {
      head: current.head.head,
      runState:
        current.record === null
          ? options.genesisRunState
          : (current.record.body as DemoRuntimeReconstruction["runState"])
    };
  }

  return {
    async compareAndSwap(input) {
      const current = await currentRunState();
      if (current.runState.contentDigest !== input.expectedRunStateDigest) {
        if (current.runState.contentDigest === input.nextRunState.contentDigest) {
          return { status: "existing" as const };
        }
        return { status: "conflict" as const };
      }
      let outcome;
      try {
        outcome = await options.substrate.compareAndSwap({
          namespace,
          key: input.nextRunState.contentDigest,
          expectedHead: current.head,
          body: input.nextRunState
        });
      } catch (error) {
        if (error instanceof DurableAmbiguousAcknowledgementError) {
          throw new DemoRunStatePersistenceAmbiguousError(error.message);
        }
        throw error;
      }
      return { status: outcome.status };
    },
    async read() {
      return (await currentRunState()).runState
    }
  };
}

// ---------------------------------------------------------------------------
// DemoRecoveryBudgetStore — runtime-state-store, compareAndSwap (single lineage)
// ---------------------------------------------------------------------------

export interface DurableDemoRecoveryBudgetStoreOptions {
  readonly substrate: DurableSubstrate;
  readonly signer: DemoEvidenceSigner;
  /** The budget this store must report before its first durable write. */
  readonly genesisBudget: DemoBudgetState;
  /** Defaults to `demo-recovery-budget`. */
  readonly namespace?: string;
}

export function createDurableDemoRecoveryBudgetStore(
  options: DurableDemoRecoveryBudgetStoreOptions
): DemoRecoveryBudgetStore {
  const namespace = options.namespace ?? "demo-recovery-budget";

  interface StoredRecoveryBudget {
    readonly budget: DemoBudgetState;
    readonly evidence: DemoRecoveryBudgetEvidence;
  }

  async function currentComposite(): Promise<{
    readonly head: Digest | null;
    readonly composite: StoredRecoveryBudget | null;
  }> {
    const current = await options.substrate.readCurrent(namespace);
    return {
      head: current.head.head,
      composite:
        current.record === null
          ? null
          : (current.record.body as StoredRecoveryBudget)
    };
  }

  return {
    async record(input) {
      const current = await currentComposite();
      const currentBudget = current.composite?.budget ?? options.genesisBudget;
      if (currentBudget.contentDigest !== input.expected.contentDigest) {
        if (
          current.composite !== null &&
          currentBudget.contentDigest === input.next.contentDigest &&
          canonicalJson(withoutSignature(current.composite.evidence)) ===
            canonicalJson(input.evidence)
        ) {
          return {
            status: "existing" as const,
            budget: current.composite.budget,
            evidence: current.composite.evidence
          };
        }
        return { status: "conflict" as const, budget: null, evidence: null };
      }
      const signature = await options.signer.sign(input.evidence);
      const evidence: DemoRecoveryBudgetEvidence = { ...input.evidence, signature };
      const body: StoredRecoveryBudget = { budget: input.next, evidence };
      let outcome;
      try {
        outcome = await options.substrate.compareAndSwap({
          namespace,
          key: input.evidence.kernelReceiptDigest,
          expectedHead: current.head,
          body
        });
      } catch (error) {
        if (error instanceof DurableAmbiguousAcknowledgementError) {
          throw new DemoRecoveryBudgetPersistenceAmbiguousError(error.message);
        }
        throw error;
      }
      if (outcome.status === "conflict") {
        return { status: "conflict" as const, budget: null, evidence: null };
      }
      const stored = (outcome.record?.body ?? body) as StoredRecoveryBudget;
      return { status: outcome.status, budget: stored.budget, evidence: stored.evidence };
    },
    async read() {
      return (await currentComposite()).composite?.budget ?? options.genesisBudget;
    },
    async readEvidence(kernelReceiptDigest) {
      const record = await options.substrate.read({
        namespace,
        key: kernelReceiptDigest
      });
      return record === null
        ? null
        : (record.body as StoredRecoveryBudget).evidence;
    }
  };
}

// ---------------------------------------------------------------------------
// DemoProviderUsageLedger — receipt-journal, appendOnce
// ---------------------------------------------------------------------------

export interface DurableDemoProviderUsageLedgerOptions {
  readonly substrate: DurableSubstrate;
  readonly signer: DemoEvidenceSigner;
  /**
   * Resolves the actual provider usage outcome for a begun attempt. This
   * substrate durably records evidence; it cannot observe a real model
   * provider's usage or billing signal, so the caller supplies it (a real
   * metering source, or a simulated one in the pre-App sandbox).
   */
  readonly resolveUsage: (
    attempt: DemoProviderAttemptEvidence
  ) => Promise<
    Omit<DemoProviderUsageEvidence, "schemaVersion" | "attemptDigest" | "observedAt" | "signature">
  >;
  readonly clock: DurableDemoClock;
  /** Defaults to `demo-provider-attempt`. Each attempt gets its own derived namespace. */
  readonly attemptNamespacePrefix?: string;
  /** Defaults to `demo-provider-usage`. Each reconciled attempt gets its own derived namespace. */
  readonly usageNamespacePrefix?: string;
}

export function createDurableDemoProviderUsageLedger(
  options: DurableDemoProviderUsageLedgerOptions
): DemoProviderUsageLedger {
  const attemptPrefix = options.attemptNamespacePrefix ?? "demo-provider-attempt";
  const usagePrefix = options.usageNamespacePrefix ?? "demo-provider-usage";

  function attemptNamespace(attemptKey: Digest): string {
    return derivedNamespace(attemptPrefix, attemptKey);
  }

  function usageNamespace(attemptDigest: Digest): string {
    return derivedNamespace(usagePrefix, attemptDigest);
  }

  function sameAttempt(
    storedBody: unknown,
    attempt: Omit<DemoProviderAttemptEvidence, "signature">
  ): boolean {
    return (
      storedBody !== null &&
      typeof storedBody === "object" &&
      canonicalJson(withoutSignature(storedBody as DemoProviderAttemptEvidence)) ===
        canonicalJson(attempt)
    );
  }

  function sameUsage(storedBody: unknown, attemptDigest: Digest): boolean {
    return (
      storedBody !== null &&
      typeof storedBody === "object" &&
      (storedBody as DemoProviderUsageEvidence).attemptDigest === attemptDigest
    );
  }

  interface ClaimBody {
    readonly schemaVersion: "1.0.0";
    readonly attemptDigest: Digest;
    readonly claimed: true;
  }

  function claimBodyFor(attemptDigest: Digest): ClaimBody {
    return { schemaVersion: "1.0.0", attemptDigest, claimed: true };
  }

  function sameClaim(storedBody: unknown, expected: ClaimBody): boolean {
    return (
      storedBody !== null &&
      typeof storedBody === "object" &&
      canonicalJson(storedBody) === canonicalJson(expected)
    );
  }

  return {
    async begin(attempt) {
      const namespace = attemptNamespace(attempt.attemptKey);
      // Check for an existing record BEFORE signing: a normal top-level
      // replay must never re-invoke the signer, since signing is a
      // side-effecting dependency the module elsewhere (`resolveUsage`)
      // already treats as unsafe to redo needlessly.
      const existing = await options.substrate.read({ namespace, key: "attempt" });
      if (existing !== null) {
        if (!sameAttempt(existing.body, attempt)) {
          throw new TypeError(
            "provider attempt conflicts with an existing durable attempt"
          );
        }
        return existing.body as DemoProviderAttemptEvidence;
      }
      const body: DemoProviderAttemptEvidence = {
        ...attempt,
        signature: await options.signer.sign(attempt)
      };
      let outcome;
      try {
        outcome = await options.substrate.appendOnce({ namespace, key: "attempt", body });
      } catch (error) {
        if (!(error instanceof DurableAmbiguousAcknowledgementError)) throw error;
        // Never resubmit the write. Reconcile through bounded stable reads
        // only.
        const classification = await classifyAmbiguousWrite({
          substrate: options.substrate,
          namespace,
          key: "attempt",
          matchesAttempted: (stored) => sameAttempt(stored, attempt)
        });
        if (classification.kind === "matches") {
          return classification.record.body as DemoProviderAttemptEvidence;
        }
        // "differs" here would mean a hash-collision on attemptKey within a
        // namespace dedicated to it, which should not occur; "unstable"
        // means the true state cannot be determined. Neither has a status
        // this interface can report, so both fail closed the same way.
        throw new DemoProviderUsageLedgerPersistenceFailedError(error.message);
      }
      if (outcome.status === "conflict") {
        // A racing writer landed first between our own pre-check read and
        // this append attempt. Reread the authoritative record: if it is
        // the same logical operation (a benign metadata race — e.g. a
        // different signature from a non-deterministic signer, or a
        // different `startedAt`/`expiresAt` on a legitimate retry, neither
        // of which `attemptKey` covers), this is existing, not a genuine
        // conflict — mirroring `singleKeyIdempotentWrite`'s own conflict
        // reread, which every sibling `appendOnce` port in this module
        // relies on for exactly this reason.
        const reread = await options.substrate.read({ namespace, key: "attempt" });
        if (reread !== null && sameAttempt(reread.body, attempt)) {
          return reread.body as DemoProviderAttemptEvidence;
        }
        throw new TypeError(
          "provider attempt conflicts with an existing durable attempt"
        );
      }
      return (outcome.record?.body ?? body) as DemoProviderAttemptEvidence;
    },
    async reconcile(attempt) {
      const attemptDigest = digest(attempt);
      const namespace = usageNamespace(attemptDigest);

      // Fast path: a completed usage record already exists (from a prior
      // successful reconciliation, possibly by another process/handle).
      // Only a fresh reconciliation ever consults the provider.
      const existingUsage = await options.substrate.read({ namespace, key: "usage" });
      if (existingUsage !== null && sameUsage(existingUsage.body, attemptDigest)) {
        return existingUsage.body as DemoProviderUsageEvidence;
      }

      // Atomically claim exclusive reconciliation rights before ever
      // invoking the injected, potentially billable `resolveUsage`
      // callback. The claim body depends only on `attemptDigest`, so the
      // substrate's own cross-process `appendOnce` atomicity (proved in
      // tests/durable-multiprocess.test.ts) decides exactly one winner
      // across any number of concurrent callers or processes racing this
      // same attempt — no lock, lease, or second store is needed. Every
      // other caller, including one that starts after an earlier claimant
      // crashed before finishing, is a contender: it must never call
      // `resolveUsage`, and either observes a completed usage record or
      // fails closed.
      const claimBody = claimBodyFor(attemptDigest);
      let claimOutcome: { readonly status: DurableWriteStatus };
      try {
        claimOutcome = await options.substrate.appendOnce({
          namespace,
          key: "claim",
          body: claimBody
        });
      } catch (error) {
        if (!(error instanceof DurableAmbiguousAcknowledgementError)) throw error;
        // Never resubmit the claim write. Reconcile through bounded stable
        // reads only.
        const classification = await classifyAmbiguousWrite({
          substrate: options.substrate,
          namespace,
          key: "claim",
          matchesAttempted: (stored) => sameClaim(stored, claimBody)
        });
        if (classification.kind !== "matches") {
          // Never resubmit the claim write, and never guess who owns
          // reconciliation rights: fail closed rather than risk a second
          // resolveUsage invocation.
          throw new DemoProviderUsageLedgerPersistenceFailedError(
            `reconciliation claim for attempt ${attemptDigest} is ambiguous: ${error.message}`
          );
        }
        // The claim record durably exists, but ambiguity means this call
        // cannot prove it is the one that created it, so it conservatively
        // treats itself as a non-owning contender rather than risk a
        // second resolveUsage invocation.
        claimOutcome = { status: "existing" };
      }

      if (claimOutcome.status === "conflict") {
        // Should be unreachable: the claim namespace/key is dedicated to
        // one deterministic body. Fail closed rather than invent
        // authority.
        throw new DemoProviderUsageLedgerPersistenceFailedError(
          `reconciliation claim for attempt ${attemptDigest} conflicts with an unexpected durable record`
        );
      }

      if (claimOutcome.status === "existing") {
        // This call does not hold exclusive reconciliation rights: never
        // call the provider. Check once more for a completed record; if
        // still absent, fail closed rather than poll indefinitely or
        // invoke resolveUsage speculatively.
        const reread = await options.substrate.read({ namespace, key: "usage" });
        if (reread !== null && sameUsage(reread.body, attemptDigest)) {
          return reread.body as DemoProviderUsageEvidence;
        }
        throw new DemoProviderUsageLedgerReconciliationPendingError(attemptDigest);
      }

      // claimOutcome.status === "appended": exclusive reconciliation rights
      // are ours. Resolve and sign exactly once; any later ambiguity in the
      // final write must reuse this same computed body, never call
      // resolveUsage again.
      const resolved = await options.resolveUsage(attempt);
      const unsigned = {
        schemaVersion: "1.0.0" as const,
        attemptDigest,
        ...resolved,
        observedAt: options.clock.now()
      };
      const body: DemoProviderUsageEvidence = {
        ...unsigned,
        signature: await options.signer.sign(unsigned)
      };

      let result: { readonly status: DurableWriteStatus; readonly body: unknown };
      try {
        result = await singleKeyIdempotentWrite({
          substrate: options.substrate,
          namespace,
          key: "usage",
          buildBody: () => Promise.resolve(body),
          sameOperation: (stored) => sameUsage(stored, attemptDigest)
        });
      } catch (error) {
        if (!(error instanceof DurableAmbiguousAcknowledgementError)) throw error;
        const classification = await classifyAmbiguousWrite({
          substrate: options.substrate,
          namespace,
          key: "usage",
          matchesAttempted: (stored) => sameUsage(stored, attemptDigest)
        });
        if (classification.kind === "matches") {
          return classification.record.body as DemoProviderUsageEvidence;
        }
        throw new DemoProviderUsageLedgerPersistenceFailedError(error.message);
      }
      if (result.body === null) {
        throw new TypeError(
          "provider usage conflicts with an existing durable usage record"
        );
      }
      return result.body as DemoProviderUsageEvidence;
    }
  };
}
