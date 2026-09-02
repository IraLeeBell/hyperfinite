/**
 * Durable adapters mapping `src/demo-scheduler.ts`'s `DemoRunFenceStore` and
 * `DemoBudgetLedger` ports onto the local durable substrate (ADR 0014).
 *
 * Both ports are declared by ADR 0014's normative mapping to bind to the
 * `runtime-state-store` durable store via `compareAndSwap`. This module never
 * opens or binds that store itself -- it accepts an already-opened
 * `DurableSubstrate` (see `src/durable-store-binding.ts`) and layers exactly
 * the port semantics `src/demo-scheduler.ts` already assumes on top of it.
 *
 * Namespacing: the fence store and the budget ledger are two distinct ports
 * sharing one durable store, so each uses its own disjoint namespace space
 * inside that store rather than assuming any cross-namespace transaction.
 *
 * - The fence store opens one substrate namespace per work item, keyed by the
 *   fence's own `fenceKey` (`digest({ repositoryId, workItemNodeId })`). Each
 *   namespace's compare-and-swap head *is* the cross-process mutual-exclusion
 *   token for that work item's fence: acquiring or releasing writes exactly
 *   one composite `{ fence, runState }` record per transition, keyed by the
 *   transitioning fence's own `contentDigest` (unique per transition because
 *   it embeds `previousFenceDigest`), and the namespace's current record is
 *   always the fence's latest durable state.
 * - The budget ledger is bound to one authority for its whole lifetime: its
 *   namespace is `demoBudgetAuthorityDigest` of the genesis budget it is
 *   constructed with, which is stable across every reserve/settle transition
 *   because none of the fields that digest covers (limits, epoch, generation,
 *   lease, work-accord, validity window) change once a run starts. Each
 *   reservation or settlement writes one composite `{ budget, evidence }`
 *   record, keyed by the resulting budget's `contentDigest`.
 *
 * Fail-closed posture (ADR 0008/0014): a domain precondition that does not
 * match the durably recorded predecessor is a `conflict`, never a guess. A
 * durable write whose acknowledgement is ambiguous is reconciled by rereading
 * the namespace twice and requiring a stable answer; an unstable or
 * unresolvable reread throws `DurableDemoSchedulerStoreAmbiguousError` rather
 * than inventing a status, exactly mirroring the substrate's own posture that
 * ambiguity is a state, not an error to swallow. A capacity, corruption, or
 * runtime refusal from the substrate is never caught here -- it propagates
 * to the caller unchanged, which is what "fail closed" means for those cases.
 *
 * Nonproduction. Only a clock-free, network-free, credential-free substrate,
 * signer, and verifier are consumed, all injected by the caller; nothing here
 * reads an environment variable, a default path, or ambient time.
 */

import { canonicalJson } from "./canonical.js";
import { validateDemoContract } from "./demo-portfolio.js";
import type { DemoEvidenceSigner, DemoEvidenceVerifier } from "./demo-activation.js";
import {
  demoBudgetAuthorityDigest,
  validateDemoBudgetState,
  type DemoBudgetState
} from "./demo-runtime-state.js";
import type {
  DemoBudgetLedger,
  DemoBudgetReservationEvidence,
  DemoBudgetSettlementEvidence,
  DemoFenceStoreSnapshot,
  DemoRunFenceStore
} from "./demo-scheduler.js";
import type { DemoRunFence, DemoRunState } from "./demo-types.js";
import type { Digest } from "./types.js";
import { isCanonicalUtcDateTime } from "./validation.js";
import {
  DurableAmbiguousAcknowledgementError,
  assertKey,
  refuse,
  type DurableRecord,
  type DurableSubstrate,
  type DurableWriteOutcome,
  type DurableWriteStatus
} from "./durable-substrate.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/u;

function fail(message: string): never {
  throw new TypeError(message);
}

/**
 * Raised when a durable write's acknowledgement was ambiguous and the
 * reconciling double-read did not settle on one stable, attributable outcome.
 * This is deliberately never collapsed into `appended`, `existing`, or
 * `conflict` -- doing so would be exactly the guess ADR 0014 forbids. Callers
 * of `DemoRunFenceStore`/`DemoBudgetLedger` in this repository do not catch
 * this; it is meant to propagate as an unresolved fault, the same fail-closed
 * posture the substrate itself takes for a genuinely unknown outcome.
 */
export class DurableDemoSchedulerStoreAmbiguousError extends Error {
  constructor(
    readonly port: "fence" | "budget",
    readonly namespace: string,
    readonly key: string,
    message = "durable scheduler store write acknowledgement is ambiguous"
  ) {
    super(message);
    this.name = "DurableDemoSchedulerStoreAmbiguousError";
  }
}

/**
 * Attempts one durable compare-and-swap, reconciling an ambiguous
 * acknowledgement into a stable trichotomy rather than letting it escape as a
 * distinct error the demo-scheduler callers do not catch.
 *
 * On ambiguity, rereads the namespace's current record twice. If the reread is
 * unstable (two reads disagree) it cannot be resolved and throws
 * `DurableDemoSchedulerStoreAmbiguousError`. If it stably shows exactly the
 * record this call attempted (same key, same predecessor head, byte-identical
 * body), the write is known to have actually landed and is reported as
 * `existing` -- the same meaning the substrate itself gives a byte-identical
 * replay. Anything else durably present is a genuine `conflict`.
 */
async function writeWithReconciliation(input: {
  readonly substrate: DurableSubstrate;
  readonly port: "fence" | "budget";
  readonly namespace: string;
  readonly key: string;
  readonly expectedHead: Digest | null;
  readonly body: unknown;
}): Promise<DurableWriteOutcome> {
  try {
    return await input.substrate.compareAndSwap({
      namespace: input.namespace,
      key: input.key,
      expectedHead: input.expectedHead,
      body: input.body
    });
  } catch (error) {
    if (!(error instanceof DurableAmbiguousAcknowledgementError)) throw error;
    return reconcileAmbiguousWrite(input);
  }
}

async function reconcileAmbiguousWrite(input: {
  readonly substrate: DurableSubstrate;
  readonly port: "fence" | "budget";
  readonly namespace: string;
  readonly key: string;
  readonly expectedHead: Digest | null;
  readonly body: unknown;
}): Promise<DurableWriteOutcome> {
  const first = await input.substrate.readCurrent(input.namespace);
  const second = await input.substrate.readCurrent(input.namespace);
  const stable =
    first.head.head === second.head.head &&
    canonicalJson(first.record) === canonicalJson(second.record);
  if (!stable) {
    throw new DurableDemoSchedulerStoreAmbiguousError(
      input.port,
      input.namespace,
      input.key,
      `ambiguous ${input.port} write for ${input.namespace}/${input.key} did not resolve to one stable durable record`
    );
  }
  const resolved = second.record;
  if (
    resolved !== null &&
    resolved.key === input.key &&
    resolved.previousHead === input.expectedHead &&
    canonicalJson(resolved.body) === canonicalJson(input.body)
  ) {
    return { status: "existing", record: resolved };
  }
  return { status: "conflict", record: null };
}

// ---------------------------------------------------------------------------
// DemoRunFenceStore
// ---------------------------------------------------------------------------

interface DurableDemoRunFenceRecordBody {
  readonly kind: "DurableDemoRunFenceRecord";
  readonly schemaVersion: "1.0.0";
  readonly fence: DemoRunFence;
  readonly runState: DemoRunState;
}

function decodeFenceBody(body: unknown, namespace: string): DemoFenceStoreSnapshot {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    refuse("STORE_CORRUPT", `durable fence record for ${namespace} is not a composite object`);
  }
  const record = body as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record).sort();
  if (
    record.kind !== "DurableDemoRunFenceRecord" ||
    record.schemaVersion !== "1.0.0" ||
    keys.length !== 4 ||
    keys.join(",") !== "fence,kind,runState,schemaVersion"
  ) {
    refuse("STORE_CORRUPT", `durable fence record for ${namespace} has an unrecognized envelope`);
  }
  const fence = validateDemoContract("DemoRunFence", record.fence);
  const runState = validateDemoContract("DemoRunState", record.runState);
  if (fence.spec.fenceKey !== namespace) {
    refuse(
      "STORE_CORRUPT",
      `durable fence record for ${namespace} is bound to a different fence key`
    );
  }
  return Object.freeze({ fence, runState });
}

type FencePrecondition =
  | { readonly kind: "run-state"; readonly expectedRunStateDigest: Digest }
  | { readonly kind: "fence"; readonly expectedFenceDigest: Digest };

function fencePreconditionHolds(input: {
  readonly operation: "acquire" | "release";
  readonly prior: DemoFenceStoreSnapshot | null;
  readonly proposed: DemoRunFence;
  readonly precondition: FencePrecondition;
}): boolean {
  if (input.operation === "acquire") {
    if (input.precondition.kind !== "run-state") return false;
    // Independent of any prior durable record: the proposed fence's own
    // `runStateDigest` field must be the exact run-state precondition the
    // caller supplied, since `src/demo-scheduler.ts` always derives both from
    // the same reconstructed run state. This is the only check available at
    // genesis (no prior record to compare against) and remains a useful
    // cross-check afterward.
    if (input.proposed.spec.runStateDigest !== input.precondition.expectedRunStateDigest) {
      return false;
    }
    if (input.prior === null) {
      // Genesis: this work item has never durably recorded a fence. The only
      // additional thing this namespace can enforce is that the proposed
      // fence claims to be the first link in its own chain.
      return input.proposed.spec.previousFenceDigest === null;
    }
    // Mutual exclusion (the fence must currently be released, never a second
    // acquire on top of a held one) and chain continuity (this acquire must
    // build on the exact fence last recorded here). This deliberately does
    // *not* also require `prior.runState.contentDigest` to equal the caller's
    // `expectedRunStateDigest`: the authoritative run state legitimately
    // advances between stages through `DemoRunStateStore` (a different port),
    // so the fence namespace's own retained `runState` snapshot -- a receipt
    // of what was true at that past transition, not a second copy of current
    // truth -- is expected to differ from the caller's current reconstruction
    // on every subsequent acquire for the same work item.
    return (
      input.prior.fence.spec.status === "released" &&
      input.proposed.spec.previousFenceDigest === input.prior.fence.contentDigest
    );
  }
  // release
  if (input.precondition.kind !== "fence") return false;
  if (input.prior === null) return false; // cannot release a fence never acquired
  return (
    input.prior.fence.spec.status === "acquired" &&
    input.prior.fence.contentDigest === input.precondition.expectedFenceDigest &&
    input.proposed.spec.previousFenceDigest === input.prior.fence.contentDigest
  );
}

async function fenceTransition(input: {
  readonly substrate: DurableSubstrate;
  readonly operation: "acquire" | "release";
  readonly proposedFence: DemoRunFence;
  readonly runningState: DemoRunState;
  readonly precondition: FencePrecondition;
}): Promise<{
  readonly status: DurableWriteStatus;
  readonly snapshot: DemoFenceStoreSnapshot | null;
}> {
  const proposed = validateDemoContract("DemoRunFence", input.proposedFence);
  const runningState = validateDemoContract("DemoRunState", input.runningState);
  const requiredStatus = input.operation === "acquire" ? "acquired" : "released";
  if (proposed.spec.status !== requiredStatus) {
    fail(
      `durable fence ${input.operation} requires a proposed fence with status "${requiredStatus}"`
    );
  }
  // The composite record binds one fence to one run state atomically, so the
  // pairing itself must be internally consistent before either is persisted.
  // `validateDemoContract("DemoRunState", ...)` only checks that a "running"
  // state carries *some* non-null fence binding (`validateRunStateSemantics`
  // in `src/demo-portfolio.ts`), not that it references *this* fence -- a
  // caller bug here would otherwise let the store durably commit a fence and
  // a run state that disagree about which fence is held, which later
  // consumers (e.g. `validateRunFencesForReceipt`) assume can never happen.
  if (input.operation === "acquire") {
    if (
      runningState.spec.fenceDigest !== proposed.contentDigest ||
      runningState.spec.fenceBaseRunStateDigest !== proposed.spec.runStateDigest
    ) {
      fail(
        "durable fence acquire requires the paired run state to reference the exact proposed fence"
      );
    }
  } else if (runningState.spec.fenceDigest !== proposed.spec.previousFenceDigest) {
    fail(
      "durable fence release requires the paired run state to reference the fence being released"
    );
  }

  const namespace = assertKey(proposed.spec.fenceKey, "fenceKey");
  const current = await input.substrate.readCurrent(namespace);
  const prior = current.record === null ? null : decodeFenceBody(current.record.body, namespace);
  const body: DurableDemoRunFenceRecordBody = {
    kind: "DurableDemoRunFenceRecord",
    schemaVersion: "1.0.0",
    fence: proposed,
    runState: runningState
  };

  // A byte-identical replay of the transition already recorded as this
  // namespace's current entry is idempotent: report it directly as
  // `existing` rather than recomputing an expected head for it. The head
  // this namespace advanced to *for that transition* was computed against
  // *its own* predecessor, not against the state it produced, so re-deriving
  // `expectedHead` from the current head here would compare the replay
  // against the wrong precondition and misreport a genuine replay as a
  // conflict.
  if (
    current.record !== null &&
    current.record.key === proposed.contentDigest &&
    canonicalJson(current.record.body) === canonicalJson(body)
  ) {
    return { status: "existing", snapshot: prior };
  }

  if (
    !fencePreconditionHolds({
      operation: input.operation,
      prior,
      proposed,
      precondition: input.precondition
    })
  ) {
    return { status: "conflict", snapshot: null };
  }

  const outcome = await writeWithReconciliation({
    substrate: input.substrate,
    port: "fence",
    namespace,
    key: proposed.contentDigest,
    expectedHead: current.head.head,
    body
  });
  if (outcome.status === "conflict" || outcome.record === null) {
    return { status: "conflict", snapshot: null };
  }
  return {
    status: outcome.status,
    snapshot: decodeFenceBody(outcome.record.body, namespace)
  };
}

/**
 * Builds a `DemoRunFenceStore` over an already-opened durable substrate. Every
 * distinct work item (`fence.spec.fenceKey`) gets its own compare-and-swap
 * namespace inside the injected store, so unrelated work items never contend
 * on the same namespace head.
 */
export function createDurableDemoRunFenceStore(
  substrate: DurableSubstrate
): DemoRunFenceStore {
  const store: DemoRunFenceStore = {
    supportsAtomicCompareAndSwap: true as const,

    async acquire(input) {
      return fenceTransition({
        substrate,
        operation: "acquire",
        proposedFence: input.fence,
        runningState: input.runningState,
        precondition: {
          kind: "run-state",
          expectedRunStateDigest: input.expectedRunStateDigest
        }
      });
    },

    async release(input) {
      return fenceTransition({
        substrate,
        operation: "release",
        proposedFence: input.releasedFence,
        runningState: input.runningState,
        precondition: {
          kind: "fence",
          expectedFenceDigest: input.expectedFenceDigest
        }
      });
    },

    async read(fenceKey) {
      const namespace = assertKey(fenceKey, "fenceKey");
      const current = await substrate.readCurrent(namespace);
      return current.record === null
        ? null
        : decodeFenceBody(current.record.body, namespace);
    }
  };
  return Object.freeze(store);
}

// ---------------------------------------------------------------------------
// DemoBudgetLedger
// ---------------------------------------------------------------------------

type DurableDemoBudgetTransitionKind =
  | "DurableDemoBudgetReservationRecord"
  | "DurableDemoBudgetSettlementRecord";

interface DurableDemoBudgetRecordBody {
  readonly kind: DurableDemoBudgetTransitionKind;
  readonly schemaVersion: "1.0.0";
  readonly budget: DemoBudgetState;
  readonly evidence: DemoBudgetReservationEvidence | DemoBudgetSettlementEvidence;
}

function decodeBudgetBody(
  body: unknown,
  namespace: string
): DurableDemoBudgetRecordBody {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    refuse("STORE_CORRUPT", `durable budget record for ${namespace} is not a composite object`);
  }
  const record = body as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record).sort();
  if (
    (record.kind !== "DurableDemoBudgetReservationRecord" &&
      record.kind !== "DurableDemoBudgetSettlementRecord") ||
    record.schemaVersion !== "1.0.0" ||
    keys.length !== 4 ||
    keys.join(",") !== "budget,evidence,kind,schemaVersion"
  ) {
    refuse("STORE_CORRUPT", `durable budget record for ${namespace} has an unrecognized envelope`);
  }
  const budget = validateDemoBudgetState(record.budget);
  if (demoBudgetAuthorityDigest(budget) !== namespace) {
    refuse(
      "STORE_CORRUPT",
      `durable budget record for ${namespace} is bound to a different budget authority`
    );
  }
  const evidence = assertSignedEvidenceShape(record.evidence, namespace);
  return Object.freeze({
    kind: record.kind,
    schemaVersion: "1.0.0",
    budget,
    evidence
  });
}

function assertSignedEvidenceShape(
  value: unknown,
  namespace: string
): DemoBudgetReservationEvidence | DemoBudgetSettlementEvidence {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    refuse("STORE_CORRUPT", `durable budget evidence for ${namespace} is not an object`);
  }
  const evidence = value as Readonly<Record<string, unknown>>;
  const signature = evidence.signature as
    | Readonly<Record<string, unknown>>
    | undefined;
  if (
    signature === undefined ||
    signature === null ||
    typeof signature !== "object" ||
    signature.algorithm !== "ed25519" ||
    typeof signature.keyId !== "string" ||
    typeof signature.value !== "string"
  ) {
    refuse("STORE_CORRUPT", `durable budget evidence for ${namespace} carries no valid signature`);
  }
  return value as DemoBudgetReservationEvidence | DemoBudgetSettlementEvidence;
}

const RESERVATION_EVIDENCE_KEYS = [
  "budgetAfterDigest",
  "budgetBeforeDigest",
  "calls",
  "costUnits",
  "dispatchDecisionDigest",
  "expiresAt",
  "reservationKey",
  "reservedAt",
  "runtimeBinding",
  "schemaVersion",
  "stageId",
  "tokens"
].sort();

const SETTLEMENT_EVIDENCE_KEYS = [
  "budgetAfterDigest",
  "budgetBeforeDigest",
  "calls",
  "costUnits",
  "reservationDigest",
  "schemaVersion",
  "settledAt",
  "tokens",
  "usageDigest"
].sort();

function assertEvidencePayloadShape(input: {
  readonly kind: DurableDemoBudgetTransitionKind;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly expected: DemoBudgetState;
  readonly next: DemoBudgetState;
}): void {
  const keys = Object.keys(input.payload).sort();
  const required =
    input.kind === "DurableDemoBudgetReservationRecord"
      ? RESERVATION_EVIDENCE_KEYS
      : SETTLEMENT_EVIDENCE_KEYS;
  if (keys.length !== required.length || keys.join(",") !== required.join(",")) {
    fail(`durable budget ${input.kind} evidence has an unexpected shape`);
  }
  const payload = input.payload as unknown as {
    readonly schemaVersion: unknown;
    readonly budgetBeforeDigest: unknown;
    readonly budgetAfterDigest: unknown;
    readonly calls: unknown;
    readonly tokens: unknown;
    readonly costUnits: unknown;
  };
  if (
    payload.schemaVersion !== "1.0.0" ||
    payload.budgetBeforeDigest !== input.expected.contentDigest ||
    payload.budgetAfterDigest !== input.next.contentDigest ||
    payload.calls !== 1 ||
    !Number.isSafeInteger(payload.tokens as number) ||
    (payload.tokens as number) < 0 ||
    !Number.isSafeInteger(payload.costUnits as number) ||
    (payload.costUnits as number) < 0
  ) {
    fail(`durable budget ${input.kind} evidence does not match the proposed transition`);
  }
  if (input.kind === "DurableDemoBudgetReservationRecord") {
    const reservation = input.payload as unknown as Omit<
      DemoBudgetReservationEvidence,
      "signature"
    >;
    if (
      !DIGEST.test(reservation.reservationKey) ||
      !DIGEST.test(reservation.dispatchDecisionDigest) ||
      typeof reservation.stageId !== "string" ||
      reservation.stageId.length === 0 ||
      !isCanonicalUtcDateTime(reservation.reservedAt) ||
      !isCanonicalUtcDateTime(reservation.expiresAt)
    ) {
      fail("durable budget reservation evidence is malformed");
    }
  } else {
    const settlement = input.payload as unknown as Omit<
      DemoBudgetSettlementEvidence,
      "signature"
    >;
    if (
      !DIGEST.test(settlement.reservationDigest) ||
      !DIGEST.test(settlement.usageDigest) ||
      !isCanonicalUtcDateTime(settlement.settledAt)
    ) {
      fail("durable budget settlement evidence is malformed");
    }
  }
}

export interface DurableDemoBudgetLedgerOptions {
  /** An already-opened substrate bound to the `runtime-state-store` port. */
  readonly substrate: DurableSubstrate;
  /**
   * The genesis `DemoBudgetState` for this ledger's authority
   * (`ledgerVersion: 0`, `ledgerHead: null`). Its `demoBudgetAuthorityDigest`
   * fixes this ledger's substrate namespace for its whole lifetime; every
   * later `reserve`/`settle` call is checked against that same digest, so a
   * caller cannot widen or redirect the ledger by supplying a mismatched
   * authority.
   */
  readonly initialBudget: DemoBudgetState;
  readonly signer: DemoEvidenceSigner;
  readonly verifier: DemoEvidenceVerifier;
}

/**
 * Builds a `DemoBudgetLedger` over an already-opened durable substrate. One
 * ledger instance is bound to exactly one budget authority
 * (`demoBudgetAuthorityDigest(initialBudget)`); reserving or settling against
 * a `DemoBudgetState` from a different authority is a `conflict`, not a widen.
 */
export function createDurableDemoBudgetLedger(
  options: DurableDemoBudgetLedgerOptions
): DemoBudgetLedger {
  const initialBudget = validateDemoBudgetState(options.initialBudget);
  if (
    initialBudget.spec.ledgerVersion !== 0 ||
    initialBudget.spec.ledgerHead !== null
  ) {
    fail("durable budget ledger must be constructed from a genesis DemoBudgetState");
  }
  const namespace = assertKey(
    demoBudgetAuthorityDigest(initialBudget),
    "budget authority digest"
  );
  const substrate = options.substrate;
  const signer = options.signer;
  const verifier = options.verifier;

  async function currentRecord(): Promise<{
    readonly head: Digest | null;
    readonly record: DurableRecord | null;
    readonly budget: DemoBudgetState;
    readonly priorKind: DurableDemoBudgetTransitionKind | "genesis";
  }> {
    const current = await substrate.readCurrent(namespace);
    if (current.record === null) {
      return { head: null, record: null, budget: initialBudget, priorKind: "genesis" };
    }
    const decoded = decodeBudgetBody(current.record.body, namespace);
    if (!verifier.verify(evidencePayloadOf(decoded.evidence), decoded.evidence.signature)) {
      refuse(
        "STORE_CORRUPT",
        `durable budget record for ${namespace} carries an unverifiable signature`
      );
    }
    return {
      head: current.head.head,
      record: current.record,
      budget: decoded.budget,
      priorKind: decoded.kind
    };
  }

  async function transition(input: {
    readonly kind: DurableDemoBudgetTransitionKind;
    readonly expected: DemoBudgetState;
    readonly next: DemoBudgetState;
    readonly evidencePayload: Readonly<Record<string, unknown>>;
  }): Promise<{
    readonly status: DurableWriteStatus;
    readonly budget: DemoBudgetState | null;
    readonly evidence:
      | DemoBudgetReservationEvidence
      | DemoBudgetSettlementEvidence
      | null;
  }> {
    const expected = validateDemoBudgetState(input.expected);
    const next = validateDemoBudgetState(input.next);
    if (
      demoBudgetAuthorityDigest(expected) !== namespace ||
      demoBudgetAuthorityDigest(next) !== namespace
    ) {
      return { status: "conflict", budget: null, evidence: null };
    }
    assertEvidencePayloadShape({
      kind: input.kind,
      payload: input.evidencePayload,
      expected,
      next
    });

    const current = await currentRecord();

    // Sign before checking for an idempotent replay and before entering the
    // durable write: ed25519 signing is deterministic for a given key and
    // payload, so signing an identical payload twice yields byte-identical
    // signature bytes, and the substrate's transaction is fully synchronous
    // end-to-end while an injected signer is asynchronous.
    const signature = await signer.sign(input.evidencePayload);
    const evidence = Object.freeze({
      ...input.evidencePayload,
      signature
    }) as DemoBudgetReservationEvidence | DemoBudgetSettlementEvidence;
    const body: DurableDemoBudgetRecordBody = {
      kind: input.kind,
      schemaVersion: "1.0.0",
      budget: next,
      evidence
    };
    const key = next.contentDigest;

    // A byte-identical replay of the transition already recorded as this
    // namespace's current entry is idempotent: report it directly rather
    // than recomputing an expected head for it. The head this namespace
    // advanced to *for that transition* was computed against *its own*
    // predecessor, not against the state it produced, so re-deriving
    // `expectedHead` from the current head here would compare the replay
    // against the wrong precondition and misreport a genuine replay as a
    // conflict.
    if (
      current.record !== null &&
      current.record.key === key &&
      canonicalJson(current.record.body) === canonicalJson(body)
    ) {
      const decoded = decodeBudgetBody(current.record.body, namespace);
      return { status: "existing", budget: decoded.budget, evidence: decoded.evidence };
    }

    // Reservation and settlement must strictly alternate: at most one
    // outstanding reservation may exist at a time (the domain model fixes
    // `limits.maxParallel` to 1), so a reservation can only follow genesis or
    // a settlement, and a settlement can only follow a reservation.
    const alternationHolds =
      input.kind === "DurableDemoBudgetReservationRecord"
        ? current.priorKind !== "DurableDemoBudgetReservationRecord"
        : current.priorKind === "DurableDemoBudgetReservationRecord";
    if (
      current.budget.contentDigest !== expected.contentDigest ||
      next.spec.ledgerVersion !== current.budget.spec.ledgerVersion + 1 ||
      next.spec.ledgerHead === null ||
      !alternationHolds
    ) {
      return { status: "conflict", budget: null, evidence: null };
    }

    const outcome = await writeWithReconciliation({
      substrate,
      port: "budget",
      namespace,
      key,
      expectedHead: current.head,
      body
    });
    if (outcome.status === "conflict" || outcome.record === null) {
      return { status: "conflict", budget: null, evidence: null };
    }
    const resolved = decodeBudgetBody(outcome.record.body, namespace);
    if (resolved.kind !== input.kind) {
      // The key (the next budget's own content digest) collided across a
      // reserve/settle boundary. Astronomically unlikely under sha256, but
      // this is exactly the "duplicate conflict" case ADR 0014 requires to
      // fail closed rather than hand back evidence for the wrong transition.
      refuse(
        "STORE_CORRUPT",
        `durable budget record ${next.contentDigest} changed transition kind on replay`
      );
    }
    return { status: outcome.status, budget: resolved.budget, evidence: resolved.evidence };
  }

  const ledger: DemoBudgetLedger = {
    async reserve(input) {
      const result = await transition({
        kind: "DurableDemoBudgetReservationRecord",
        expected: input.expected,
        next: input.next,
        evidencePayload: input.evidence
      });
      return {
        status: result.status,
        budget: result.budget,
        evidence: result.evidence as DemoBudgetReservationEvidence | null
      };
    },

    async settle(input) {
      const result = await transition({
        kind: "DurableDemoBudgetSettlementRecord",
        expected: input.expected,
        next: input.next,
        evidencePayload: input.evidence
      });
      return {
        status: result.status,
        budget: result.budget,
        evidence: result.evidence as DemoBudgetSettlementEvidence | null
      };
    },

    async read() {
      return (await currentRecord()).budget;
    }
  };
  return Object.freeze(ledger);
}

function evidencePayloadOf(
  evidence: DemoBudgetReservationEvidence | DemoBudgetSettlementEvidence
): Omit<DemoBudgetReservationEvidence | DemoBudgetSettlementEvidence, "signature"> {
  const { signature: _signature, ...payload } = evidence;
  return payload;
}

// Re-exported so tests and future call sites can name the exact record shape
// this module persists without redeclaring it. Not part of the public
// package API (see `tests/durable-api-surface.test.ts`): this module is
// reached only by deep import, matching every other durable adapter.
export type { DurableDemoRunFenceRecordBody, DurableDemoBudgetRecordBody };
