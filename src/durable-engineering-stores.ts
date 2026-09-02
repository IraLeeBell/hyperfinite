/**
 * Durable adapters for the engineering-slice evidence, cost, and checkpoint
 * ports.
 *
 * This maps four ports declared in `src/engineering-slice.ts` onto the merged
 * durable substrate (ADR 0014), using the store identities fixed by the pre-App
 * deployment contract (ADR 0013) and ADR
 * 0014's normative primitive mapping:
 *
 * | Port                                | Store                 | Primitive        |
 * |-------------------------------------|-----------------------|------------------|
 * | `EngineeringEvidenceStore`          | `evidence-store`      | `appendOnce`     |
 * | `EngineeringClosureCheckpointStore` | `evidence-store`      | `appendOnce`     |
 * | `EngineeringCostLedger`             | `runtime-state-store` | `compareAndSwap` |
 * | `EngineeringProviderUsageLedger`    | `receipt-journal`     | `appendOnce`     |
 *
 * Authority note: these adapters are mechanism. They mint no authority, choose
 * no target, resolve no credential, read no environment variable, open no
 * network client, invent no provider usage, and have no default path. Every
 * timestamp comes from a port input rather than an ambient clock.
 *
 * ## Why void-returning ports re-read
 *
 * ADR 0014 records that caller-side re-validation is a strong backstop but not
 * a universal one: `EngineeringEvidenceStore.conditionalAppend` and every
 * `EngineeringClosureCheckpointStore.put*` return `void`, so a caller has no
 * value to re-derive and literally cannot tell a durable write from a no-op.
 * Those ports therefore prove their own postcondition — after the write they
 * re-read the durable state and require it to be byte-identical to what they
 * intended. A substrate that acknowledged a write it did not perform would be
 * caught here rather than surfacing much later as missing evidence.
 *
 * ## Why a conflict is an exception and not a silent overwrite
 *
 * The in-memory fakes these adapters replace overwrite whatever was there.
 * Durably, a lost race means another writer's state is current and this
 * caller's view is stale, so proceeding would publish evidence derived from
 * state that no longer exists. Every such case raises, because there is no
 * success-shaped fallback in this repository.
 *
 * Nonproduction: these are local reference adapters for the pre-App sandbox.
 */

import { canonicalJson, digest } from "./canonical.js";
import type { DurableStoreId } from "./deployment-topology.js";
import {
  DurableAmbiguousAcknowledgementError,
  type DurableRecord,
  type DurableSubstrate
} from "./durable-substrate.js";
import {
  EngineeringEvidenceConflictError,
  type EngineeringAwaitingHumanMergeCheckpoint,
  type EngineeringClosureCheckpoint,
  type EngineeringClosureCheckpointStore,
  type EngineeringCostHold,
  type EngineeringCostLedger,
  type EngineeringCostRelease,
  type EngineeringCostReleaseCheckpoint,
  type EngineeringCostReservation,
  type EngineeringCostSettlement,
  type EngineeringEffectEvidence,
  type EngineeringEvidenceStore,
  type EngineeringProviderAttempt,
  type EngineeringProviderUsage,
  type EngineeringProviderUsageLedger,
  type EvidenceSigner
} from "./engineering-slice.js";
import type { Digest } from "./types.js";
import { assertDocument, validateDocument } from "./validation.js";

const EVIDENCE_STORE_ID: DurableStoreId = "evidence-store";
const RUNTIME_STATE_STORE_ID: DurableStoreId = "runtime-state-store";
const RECEIPT_JOURNAL_STORE_ID: DurableStoreId = "receipt-journal";

/**
 * One namespace per effect key, so each effect's evidence has its own
 * independent chain. A single shared namespace would make the head of one
 * effect move whenever an unrelated effect was recorded, and the port's
 * `expected` argument refers to *this* effect's predecessor, not the store's.
 */
const EFFECT_EVIDENCE_NAMESPACE_PREFIX = "engineering.effect-evidence";
const CLOSURE_CHECKPOINT_NAMESPACE = "engineering.closure-checkpoints";
const AWAITING_MERGE_NAMESPACE_PREFIX = "engineering.awaiting-human-merge";
const COST_RELEASE_NAMESPACE_PREFIX = "engineering.cost-release";
const COST_LEDGER_NAMESPACE = "engineering.cost-ledger";
const PROVIDER_USAGE_NAMESPACE = "engineering.provider-usage";

/**
 * Mirrors the private `COST_RECONCILIATION_WINDOW_MS` in
 * `src/engineering-slice.ts`. It is duplicated rather than exported because
 * widening that module's public surface is not in this change's scope; the
 * deterministic tests assert agreement by running the real exported
 * `validateProviderAttempt` and `validateCostSettlement` against this adapter's
 * output, so a drift in either constant fails immediately.
 */
const COST_RECONCILIATION_WINDOW_MS = 24 * 60 * 60 * 1_000;

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const PHASE_ORDER = ["framing", "execution", "verification"] as const;

/**
 * How many times a compare-and-swap on the cost ledger is re-derived against
 * freshly read durable state before the adapter refuses. Bounded on purpose: an
 * unbounded retry would turn a persistent conflict into a hang, and this
 * substrate never retries on a caller's behalf.
 */
const COST_LEDGER_MAX_ATTEMPTS = 3;

export type DurableEngineeringStoreRefusalCode =
  | "ADAPTER_ARGUMENT_INVALID"
  | "ADAPTER_BINDING_INVALID"
  | "ADAPTER_RECORD_INVALID"
  | "ADAPTER_OUTPUT_INVALID"
  | "ADAPTER_CONFLICT";

/**
 * An adapter-level refusal. Distinct from `DurableSubstrateError` so a caller
 * can tell "the store is broken" from "this adapter refused to emit or accept
 * evidence it could not stand behind".
 */
export class DurableEngineeringStoreError extends Error {
  constructor(
    readonly code: DurableEngineeringStoreRefusalCode,
    message: string
  ) {
    super(message);
    this.name = "DurableEngineeringStoreError";
  }
}

/**
 * Raised when a write's durable outcome could not be resolved to one stable
 * answer.
 *
 * Deliberately *not* an `EngineeringEvidenceConflictError`: a conflict means
 * "your write definitely did not land and another one did", which a caller may
 * act on. Ambiguity means the opposite is also possible, so collapsing the two
 * would let a caller treat an unknown outcome as a known one.
 */
export class DurableEngineeringAmbiguityError extends Error {
  constructor(
    readonly namespace: string,
    readonly key: string,
    message = "durable engineering write acknowledgement is ambiguous"
  ) {
    super(message);
    this.name = "DurableEngineeringAmbiguityError";
  }
}

function refuse(
  code: DurableEngineeringStoreRefusalCode,
  message: string
): never {
  throw new DurableEngineeringStoreError(code, message);
}

function assertStore(
  substrate: DurableSubstrate,
  expected: DurableStoreId,
  port: string
): void {
  // The substrate carries its plan-derived identity durably, so this refuses a
  // caller that wired, say, cost state into the receipt journal — which would
  // silently collapse the store isolation ADR 0013 asserts.
  if (substrate.metadata.storeId !== expected) {
    refuse(
      "ADAPTER_BINDING_INVALID",
      `${port} requires the ${expected}, not ${substrate.metadata.storeId}`
    );
  }
}

function assertDigestArgument(value: unknown, label: string): Digest {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    refuse("ADAPTER_ARGUMENT_INVALID", `${label} must be a sha256 digest`);
  }
  return value as Digest;
}

function assertTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) {
    refuse(
      "ADAPTER_ARGUMENT_INVALID",
      `${label} must be an ISO-8601 UTC timestamp`
    );
  }
  return value;
}

function millisecondsOf(value: string, label: string): number {
  const parsed = Date.parse(assertTimestamp(value, label));
  if (!Number.isSafeInteger(parsed)) {
    refuse("ADAPTER_ARGUMENT_INVALID", `${label} is not a representable instant`);
  }
  return parsed;
}

/**
 * The reconciliation deadline `validateProviderAttempt` and
 * `validateCostSettlement` both require, derived only from the reservation's
 * own signed expiry. Computed rather than accepted from the caller so the
 * adapter cannot be talked into signing an attempt with a window the validator
 * will reject.
 */
function reconciliationExpiry(reservationExpiresAt: string): string {
  return new Date(
    millisecondsOf(reservationExpiresAt, "reservation.expiresAt") +
      COST_RECONCILIATION_WINDOW_MS
  ).toISOString();
}

function slotKey(prefix: string, sequence: number): string {
  return `${prefix}.${String(sequence)}`;
}

function assertNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    refuse(
      "ADAPTER_ARGUMENT_INVALID",
      `${label} must be a non-negative safe integer`
    );
  }
  return value as number;
}

/**
 * Reads one slot twice and requires a single stable answer, which is the
 * reconciliation ADR 0014 prescribes for an ambiguous acknowledgement. A lone
 * read could observe a write that is still settling; two identical reads are
 * the evidence that durable state has stopped moving.
 */
async function rereadStably(
  substrate: DurableSubstrate,
  namespace: string,
  key: string
): Promise<DurableRecord | null> {
  const first = await substrate.read({ namespace, key });
  const second = await substrate.read({ namespace, key });
  const firstBytes = first === null ? null : canonicalJson(first.body);
  const secondBytes = second === null ? null : canonicalJson(second.body);
  if (firstBytes !== secondBytes) {
    throw new DurableEngineeringAmbiguityError(namespace, key);
  }
  return second;
}

/**
 * Appends one record and then proves, from durable state alone, that exactly
 * the intended bytes are present at the intended slot.
 *
 * `acceptExisting` distinguishes the two genuinely different uses of
 * `appendOnce` here, and getting it wrong is the most dangerous mistake this
 * module can make:
 *
 * - A **fenced** write (`false`) uses the key to decide a winner, so only a
 *   direct `appended` means *this* invocation won. `existing` there means some
 *   other caller produced byte-identical bytes and already occupies the slot;
 *   treating that as success would let two callers both believe they hold the
 *   fence.
 * - A **content-addressed idempotent** write (`true`) uses the key as the
 *   identity of the value, so `existing` is the correct answer: the same
 *   document is already durably recorded and there is nothing to decide.
 *
 * An `existing` observed while reconciling this invocation's *own* ambiguous
 * acknowledgement is different again — there the write may genuinely have been
 * ours — and is handled on the ambiguity path rather than here.
 */
async function appendAndProve(input: {
  readonly substrate: DurableSubstrate;
  readonly namespace: string;
  readonly key: string;
  readonly body: unknown;
  readonly expectedSequence: number | null;
  readonly acceptExisting: boolean;
  readonly onConflict: () => never;
}): Promise<DurableRecord> {
  const { substrate, namespace, key } = input;
  try {
    const outcome = await substrate.appendOnce({
      namespace,
      key,
      body: input.body
    });
    if (outcome.status === "conflict") input.onConflict();
    if (outcome.status === "existing" && !input.acceptExisting) {
      input.onConflict();
    }
  } catch (error) {
    if (!(error instanceof DurableAmbiguousAcknowledgementError)) throw error;
    const settled = await rereadStably(substrate, namespace, key);
    if (settled === null || canonicalJson(settled.body) !== canonicalJson(input.body)) {
      // The write is decidably absent, or decidably something else. Either way
      // the outcome is now known, so it is reported as a conflict rather than
      // left as ambiguity.
      input.onConflict();
    }
    if (!input.acceptExisting) {
      // The slot now holds exactly these bytes — but under a *fence* that is
      // not enough to conclude this invocation won it. A concurrent writer
      // submitting byte-identical content could have landed while this write
      // was rolling back, and the record carries nothing that distinguishes
      // the two. Reporting success here would hand two callers the same fence,
      // so the outcome stays what it actually is: unknown.
      throw new DurableEngineeringAmbiguityError(namespace, key);
    }
    // Content-addressed writes have no such problem: the key *is* the value,
    // so "somebody else wrote it" and "I wrote it" are the same outcome.
  }
  return proveDurable({
    substrate,
    namespace,
    key,
    body: input.body,
    expectedSequence: input.expectedSequence
  });
}

/** Re-reads a slot and requires it to hold exactly the bytes just written. */
async function proveDurable(input: {
  readonly substrate: DurableSubstrate;
  readonly namespace: string;
  readonly key: string;
  readonly body: unknown;
  readonly expectedSequence: number | null;
}): Promise<DurableRecord> {
  const persisted = await input.substrate.read({
    namespace: input.namespace,
    key: input.key
  });
  if (
    persisted === null ||
    canonicalJson(persisted.body) !== canonicalJson(input.body) ||
    (input.expectedSequence !== null &&
      persisted.sequence !== input.expectedSequence)
  ) {
    refuse(
      "ADAPTER_OUTPUT_INVALID",
      `${input.namespace}/${input.key} is not durably present exactly as written`
    );
  }
  return persisted;
}

// ---------------------------------------------------------------------------
// EngineeringEvidenceStore
// ---------------------------------------------------------------------------

export interface DurableEngineeringEvidenceStoreOptions {
  /** A substrate already opened for the `evidence-store` binding. */
  readonly substrate: DurableSubstrate;
}

function effectEvidenceNamespace(effectKey: Digest): string {
  return `${EFFECT_EVIDENCE_NAMESPACE_PREFIX}.${effectKey}`;
}

function decodeEvidence(record: DurableRecord): EngineeringEffectEvidence {
  const result = validateDocument("EngineeringEffectEvidence", record.body);
  if (!result.valid) {
    refuse(
      "ADAPTER_RECORD_INVALID",
      `stored effect evidence at sequence ${String(record.sequence)} is not a valid document: ${result.errors.join("; ")}`
    );
  }
  const evidence = result.value;
  // The chain position is not a free-standing fact: slot `evidence.<k>` is
  // written at substrate sequence `k`, so a record whose own sequence disagrees
  // has been moved or rewritten.
  if (evidence.sequence !== record.sequence) {
    refuse(
      "ADAPTER_RECORD_INVALID",
      `stored effect evidence asserts sequence ${String(evidence.sequence)} at substrate sequence ${String(record.sequence)}`
    );
  }
  return evidence;
}

/**
 * Binds `EngineeringEvidenceStore` to a durable substrate.
 *
 * `conditionalAppend` is a compare-and-swap expressed with `appendOnce`: the
 * new evidence is written to the slot that immediately follows the expected
 * predecessor, so two writers holding the same `expected` target the same slot
 * and exactly one of them wins. The loser sees `conflict`, never a silent
 * overwrite of the winner's record.
 */
export function openDurableEngineeringEvidenceStore(
  options: DurableEngineeringEvidenceStoreOptions
): EngineeringEvidenceStore {
  const substrate = options.substrate;
  assertStore(substrate, EVIDENCE_STORE_ID, "engineering effect evidence");

  async function currentOf(
    effectKey: Digest
  ): Promise<{ readonly record: DurableRecord | null; readonly evidence: EngineeringEffectEvidence | null }> {
    // The whole per-effect chain is verified, not just its head. `readCurrent`
    // authenticates only the head row, so a rewritten *earlier* revision would
    // stay invisible and this port would hand back trusted current evidence
    // sitting on a broken history. Each effect chain is a handful of entries
    // inside a 512-entry store-wide bound, so verifying it is cheap.
    const chain = await substrate.verifyChain(effectEvidenceNamespace(effectKey));
    const record = chain.at(-1);
    if (record === undefined) return { record: null, evidence: null };
    for (const entry of chain) decodeEvidence(entry);
    const evidence = decodeEvidence(record);
    if (evidence.effectKey !== effectKey) {
      refuse(
        "ADAPTER_RECORD_INVALID",
        `stored effect evidence carries effect key ${evidence.effectKey} in the chain for ${effectKey}`
      );
    }
    return { record, evidence };
  }

  return {
    async read(effectKey): Promise<EngineeringEffectEvidence | null> {
      const key = assertDigestArgument(effectKey, "effectKey");
      return (await currentOf(key)).evidence;
    },

    async conditionalAppend(expected, evidence): Promise<void> {
      const document = assertDocument("EngineeringEffectEvidence", evidence);
      const effectKey = assertDigestArgument(document.effectKey, "evidence.effectKey");
      if (expected !== null && expected.effectKey !== effectKey) {
        refuse(
          "ADAPTER_ARGUMENT_INVALID",
          "expected evidence belongs to a different effect key"
        );
      }
      // The port's own composite integrity rules. Enforcing them here means a
      // caller cannot durably record a chain that does not link, which no later
      // reader could repair.
      const expectedSequence = (expected?.sequence ?? 0) + 1;
      const expectedPredecessor =
        expected === null ? null : digest(expected);
      if (
        document.sequence !== expectedSequence ||
        document.previousEvidenceDigest !== expectedPredecessor
      ) {
        refuse(
          "ADAPTER_ARGUMENT_INVALID",
          "effect evidence does not chain onto the expected predecessor"
        );
      }

      const namespace = effectEvidenceNamespace(effectKey);
      const current = await currentOf(effectKey);
      const currentBytes =
        current.evidence === null ? null : canonicalJson(current.evidence);
      const expectedBytes = expected === null ? null : canonicalJson(expected);
      if (currentBytes !== expectedBytes) {
        throw new EngineeringEvidenceConflictError();
      }

      const key = slotKey("evidence", expectedSequence);
      await appendAndProve({
        substrate,
        namespace,
        key,
        body: document,
        expectedSequence,
        // Fenced: the slot decides the winner, so byte-identical bytes written
        // by somebody else are that writer's win, not this one's.
        acceptExisting: false,
        onConflict: () => {
          throw new EngineeringEvidenceConflictError();
        }
      });

      // `appendAndProve` has already shown that exactly these bytes are durably
      // present at exactly the fenced sequence, which is the postcondition this
      // `void`-returning port cannot otherwise convey. It deliberately does not
      // also demand that the record still be the chain head: a later writer
      // that legitimately builds on this one would make a successful write look
      // like a failure, and the caller would then be told its landed evidence
      // was rejected.
    }
  };
}

// ---------------------------------------------------------------------------
// EngineeringClosureCheckpointStore
// ---------------------------------------------------------------------------

export interface DurableEngineeringClosureCheckpointStoreOptions {
  /** A substrate already opened for the `evidence-store` binding. */
  readonly substrate: DurableSubstrate;
}

interface CheckpointFamily<T> {
  readonly namespace: (key: Digest) => string;
  readonly label: string;
}

const AWAITING_FAMILY: CheckpointFamily<EngineeringAwaitingHumanMergeCheckpoint> = {
  namespace: (bindingDigest) =>
    `${AWAITING_MERGE_NAMESPACE_PREFIX}.${bindingDigest}`,
  label: "awaiting-human-merge checkpoint"
};

const COST_RELEASE_FAMILY: CheckpointFamily<EngineeringCostReleaseCheckpoint> = {
  namespace: (bindingDigest) =>
    `${COST_RELEASE_NAMESPACE_PREFIX}.${bindingDigest}`,
  label: "cost-release checkpoint"
};

/**
 * Binds `EngineeringClosureCheckpointStore` to a durable substrate.
 *
 * Three families with genuinely different shapes share one adapter:
 *
 * - Closure checkpoints are content-addressed. `read` is keyed by
 *   `digest(checkpoint)`, so the key *is* the content and a replay can only
 *   ever be byte-identical. They are stored in one namespace under that digest.
 * - Awaiting-human-merge and cost-release checkpoints are keyed by binding
 *   digest and are *revised* — `putCostRelease` is called once with a null
 *   release and again once the release exists. Each binding therefore gets its
 *   own chain and the reader returns the head, so a revision supersedes its
 *   predecessor without destroying it.
 */
export function openDurableEngineeringClosureCheckpointStore(
  options: DurableEngineeringClosureCheckpointStoreOptions
): EngineeringClosureCheckpointStore {
  const substrate = options.substrate;
  assertStore(substrate, EVIDENCE_STORE_ID, "engineering closure checkpoints");

  async function readHeadDocument<T>(
    family: CheckpointFamily<T>,
    bindingDigest: Digest
  ): Promise<T | null> {
    // Verify the whole revision chain rather than only its head, so a rewritten
    // earlier revision is detected instead of being hidden behind an
    // independently valid current one.
    const chain = await substrate.verifyChain(family.namespace(bindingDigest));
    const record = chain.at(-1);
    if (record === undefined) return null;
    for (const entry of chain) {
      const stored = entry.body as { readonly bindingDigest?: unknown };
      if (stored.bindingDigest !== bindingDigest) {
        refuse(
          "ADAPTER_RECORD_INVALID",
          `stored ${family.label} carries a binding digest that does not match its chain`
        );
      }
    }
    return record.body as T;
  }

  async function putHeadDocument<T extends { readonly bindingDigest: Digest }>(
    family: CheckpointFamily<T>,
    checkpoint: T
  ): Promise<void> {
    const bindingDigest = assertDigestArgument(
      checkpoint.bindingDigest,
      `${family.label} bindingDigest`
    );
    const namespace = family.namespace(bindingDigest);
    const current = await substrate.readCurrent(namespace);
    // A byte-identical re-put is idempotent, not a revision. Appending it again
    // would grow the chain without changing state and consume the store-wide
    // journal bound for nothing.
    if (
      current.record !== null &&
      canonicalJson(current.record.body) === canonicalJson(checkpoint)
    ) {
      return;
    }
    const sequence = current.head.sequence + 1;
    const key = slotKey("checkpoint", sequence);
    await appendAndProve({
      substrate,
      namespace,
      key,
      body: checkpoint,
      expectedSequence: sequence,
      // Fenced: two revisions of one binding compete for the next position.
      acceptExisting: false,
      onConflict: () =>
        refuse(
          "ADAPTER_CONFLICT",
          `${family.label} for ${bindingDigest} was revised concurrently`
        )
    });
    // The append proof above is the independent durable postcondition this
    // `void`-returning port needs: exactly these bytes at exactly the fenced
    // position. Requiring the revision to still be the head afterwards would
    // turn a successful write that another revision legitimately built on into
    // a reported failure.
  }

  return {
    async put(checkpoint: EngineeringClosureCheckpoint): Promise<void> {
      const key = digest(checkpoint);
      await appendAndProve({
        substrate,
        namespace: CLOSURE_CHECKPOINT_NAMESPACE,
        key,
        body: checkpoint,
        // Many independent checkpoints share this namespace, so a record's
        // chain position carries no meaning and must not be asserted.
        expectedSequence: null,
        // Content-addressed: the key is `digest(checkpoint)`, so `existing`
        // can only mean this exact checkpoint is already recorded. Nothing is
        // being decided, so idempotence is the correct answer.
        acceptExisting: true,
        onConflict: () =>
          refuse(
            "ADAPTER_CONFLICT",
            `closure checkpoint ${key} is occupied by different bytes`
          )
      });
    },

    async read(checkpointDigest): Promise<EngineeringClosureCheckpoint | null> {
      const key = assertDigestArgument(checkpointDigest, "checkpointDigest");
      const record = await substrate.read({
        namespace: CLOSURE_CHECKPOINT_NAMESPACE,
        key
      });
      if (record === null) return null;
      const checkpoint = record.body as EngineeringClosureCheckpoint;
      // Content addressing is only a guarantee if it is checked: a record whose
      // digest is not its own key has been rewritten under a stolen name.
      if (digest(checkpoint) !== key) {
        refuse(
          "ADAPTER_RECORD_INVALID",
          `stored closure checkpoint at ${key} does not hash to its own key`
        );
      }
      return checkpoint;
    },

    async putAwaitingHumanMerge(checkpoint): Promise<void> {
      await putHeadDocument(AWAITING_FAMILY, checkpoint);
    },

    async readAwaitingHumanMerge(
      bindingDigest
    ): Promise<EngineeringAwaitingHumanMergeCheckpoint | null> {
      return readHeadDocument(
        AWAITING_FAMILY,
        assertDigestArgument(bindingDigest, "bindingDigest")
      );
    },

    async putCostRelease(checkpoint): Promise<void> {
      await putHeadDocument(COST_RELEASE_FAMILY, checkpoint);
    },

    async readCostRelease(
      bindingDigest
    ): Promise<EngineeringCostReleaseCheckpoint | null> {
      return readHeadDocument(
        COST_RELEASE_FAMILY,
        assertDigestArgument(bindingDigest, "bindingDigest")
      );
    }
  };
}

// ---------------------------------------------------------------------------
// EngineeringCostLedger
// ---------------------------------------------------------------------------

/**
 * One ledger entry, stored as a composite record.
 *
 * `pooledRemainingAfter` travels with the entry because the signed cost
 * documents do not all carry the pool: a reservation states `remainingAfter`,
 * but a settlement and a release only state what they returned. Recomputing the
 * pool by replaying the chain would work, but storing it makes the invariant
 * checkable at every single entry instead of only at the end.
 */
interface CostLedgerEntry {
  readonly kind: "reservation" | "hold" | "settlement" | "release";
  readonly document:
    | EngineeringCostReservation
    | EngineeringCostHold
    | EngineeringCostSettlement
    | EngineeringCostRelease;
  readonly ledgerHeadAfter: Digest;
  readonly pooledRemainingAfter: number;
  /**
   * The pool authority this entry was accounted against.
   *
   * Recorded on every entry so a store cannot be reopened under a *different*
   * budget and have its recovered `pooledRemainingAfter` silently reinterpreted
   * — reopening a 100-unit ledger that has 64 left as a 50-unit ledger would
   * otherwise accept 64 units of headroom that the new authority never granted.
   */
  readonly totalBudgetCostUnits: number;
}

/**
 * Read access to the durable provider-attempt and provider-usage records the
 * cost ledger must account against.
 *
 * The ledger lives in the runtime-state store and the attempts live in the
 * receipt journal, so without this the ledger could only take the caller's word
 * for which attempts exist and what they cost. That word is not evidence: a
 * caller could omit a real unresolved attempt and have its reserved budget
 * released into the pool, or hand over a forged zero-cost usage and have the
 * whole phase budget returned. Neither is visible to `validateCostRelease` or
 * `validateCostSettlement`, because both re-read the same caller-supplied
 * values.
 *
 * This is a read of an adjacent store, not a write to it, so it needs no
 * cross-store transaction and does not weaken the isolation ADR 0013 asserts.
 */
export interface DurableProviderEvidence {
  /** Every durably recorded attempt belonging to one reservation. */
  listAttempts(
    reservationDigest: Digest
  ): Promise<readonly EngineeringProviderAttempt[]>;
  /** The durable reconciliation for one attempt, if it has been recorded. */
  readUsage(attemptDigest: Digest): Promise<EngineeringProviderUsage | null>;
}

export interface DurableEngineeringProviderEvidenceOptions {
  /** A substrate already opened for the `receipt-journal` binding. */
  readonly substrate: DurableSubstrate;
}

/**
 * Opens read-only provider evidence over the receipt journal the provider usage
 * ledger writes to.
 */
export function openDurableEngineeringProviderEvidence(
  options: DurableEngineeringProviderEvidenceOptions
): DurableProviderEvidence {
  const substrate = options.substrate;
  assertStore(
    substrate,
    RECEIPT_JOURNAL_STORE_ID,
    "engineering provider evidence"
  );
  return {
    async listAttempts(reservationDigest) {
      // The whole bounded chain is verified rather than a single row, so an
      // attempt cannot be hidden from this accounting by rewriting history.
      const chain = await substrate.verifyChain(PROVIDER_USAGE_NAMESPACE);
      return chain
        .filter((record) => record.key.startsWith("attempt."))
        .map((record) => record.body as EngineeringProviderAttempt)
        .filter((attempt) => attempt.reservationDigest === reservationDigest);
    },
    async readUsage(attemptDigest) {
      const record = await substrate.read({
        namespace: PROVIDER_USAGE_NAMESPACE,
        key: `usage.${attemptDigest}`
      });
      return record === null
        ? null
        : (record.body as EngineeringProviderUsage);
    }
  };
}

export interface DurableEngineeringCostLedgerOptions {
  /** A substrate already opened for the `runtime-state-store` binding. */
  readonly substrate: DurableSubstrate;
  readonly signer: EvidenceSigner;
  /**
   * The durable attempts and reconciliations this ledger accounts against.
   * Required, because a ledger that could only consult the caller's copy of
   * them would be trusting an assertion where it needs evidence.
   */
  readonly providerEvidence: DurableProviderEvidence;
  /**
   * The cost pool this ledger may reserve against. Explicit and required: a
   * default budget would be this module granting spend the deployment contract
   * never authorized.
   */
  readonly totalBudgetCostUnits: number;
}

function decodeLedgerEntry(
  record: DurableRecord,
  totalBudgetCostUnits: number
): CostLedgerEntry {
  const body = record.body as Partial<CostLedgerEntry>;
  if (
    body === null ||
    typeof body !== "object" ||
    (body.kind !== "reservation" &&
      body.kind !== "hold" &&
      body.kind !== "settlement" &&
      body.kind !== "release") ||
    body.document === null ||
    typeof body.document !== "object" ||
    typeof body.ledgerHeadAfter !== "string" ||
    !DIGEST_PATTERN.test(body.ledgerHeadAfter) ||
    !Number.isSafeInteger(body.pooledRemainingAfter) ||
    (body.pooledRemainingAfter as number) < 0
  ) {
    refuse(
      "ADAPTER_RECORD_INVALID",
      `stored cost ledger entry at sequence ${String(record.sequence)} is malformed`
    );
  }
  const entry = body as CostLedgerEntry;
  if (entry.totalBudgetCostUnits !== totalBudgetCostUnits) {
    refuse(
      "ADAPTER_BINDING_INVALID",
      `cost ledger was written against a ${String(entry.totalBudgetCostUnits)} unit pool but is being opened with ${String(totalBudgetCostUnits)}`
    );
  }
  // The document's own head must agree with the envelope's, so a rewritten
  // envelope cannot re-point the ledger chain at a different document.
  const documentHead = (entry.document as { readonly ledgerHeadAfter?: unknown })
    .ledgerHeadAfter;
  if (documentHead !== entry.ledgerHeadAfter) {
    refuse(
      "ADAPTER_RECORD_INVALID",
      `cost ledger entry at sequence ${String(record.sequence)} disagrees with its document head`
    );
  }
  return entry;
}

/**
 * Binds `EngineeringCostLedger` to a durable substrate.
 *
 * Every mutation is a `compareAndSwap` against the ledger namespace head, which
 * is what makes reserve/settle/release serialized rather than merely ordered by
 * luck. All three operations are idempotent against durable state: `settle` in
 * particular is retried by its caller after a failure, and must return the
 * original settlement rather than mint a second one for the same attempt.
 *
 * ## The signed head chain is reservation-local, the substrate chain is global
 *
 * These are two different chains and conflating them would break the caller.
 * `validateCostSettlement` and `validateCostRelease` require
 * `ledgerHeadBefore` to be the *previous settlement for this reservation*, or
 * the reservation's own head when there is none — so once a reservation exists,
 * its settlements and release chain only to each other. Two concurrent
 * reservations therefore fork the signed head, and their `ledgerVersion`
 * counters can coincide; both are scoped by reservation, so neither is
 * ambiguous. The substrate namespace chain remains globally ordered underneath
 * and is what the compare-and-swap and the pool accounting use.
 */
export function openDurableEngineeringCostLedger(
  options: DurableEngineeringCostLedgerOptions
): EngineeringCostLedger {
  const substrate = options.substrate;
  assertStore(substrate, RUNTIME_STATE_STORE_ID, "engineering cost ledger");
  const totalBudget = options.totalBudgetCostUnits;
  if (!Number.isSafeInteger(totalBudget) || totalBudget < 0) {
    refuse(
      "ADAPTER_BINDING_INVALID",
      "cost ledger total budget must be a non-negative safe integer"
    );
  }

  interface LedgerState {
    readonly sequence: number;
    readonly substrateHead: Digest | null;
    readonly entries: readonly CostLedgerEntry[];
    readonly ledgerHead: Digest | null;
    readonly pooled: number;
  }

  async function readState(): Promise<LedgerState> {
    // `verifyChain` pins one read snapshot and already proves that the
    // namespace head equals the last entry's head, so the compare-and-swap
    // token is taken from the chain itself. Reading the head separately would
    // be a second transaction, and a write landing between the two would make
    // an intact ledger look inconsistent.
    const chain = await substrate.verifyChain(COST_LEDGER_NAMESPACE);
    const entries = chain.map((record) => decodeLedgerEntry(record, totalBudget));
    const lastRecord = chain.at(-1);
    const last = entries.at(-1);
    return {
      sequence: chain.length,
      substrateHead: lastRecord?.head ?? null,
      entries,
      ledgerHead: last?.ledgerHeadAfter ?? null,
      pooled: last?.pooledRemainingAfter ?? totalBudget
    };
  }

  function settlementsFor(
    state: LedgerState,
    reservationDigest: Digest
  ): readonly EngineeringCostSettlement[] {
    return state.entries
      .filter((entry) => entry.kind === "settlement")
      .map((entry) => entry.document as EngineeringCostSettlement)
      .filter((settlement) => settlement.reservationDigest === reservationDigest);
  }

  function holdsFor(
    state: LedgerState,
    reservationDigest: Digest
  ): readonly EngineeringCostHold[] {
    return state.entries
      .filter((entry) => entry.kind === "hold")
      .map((entry) => entry.document as EngineeringCostHold)
      .filter((hold) => hold.reservationDigest === reservationDigest);
  }

  /**
   * This reservation's holds and settlements in durable chain order.
   *
   * Holds and settlements share one signed lineage, so the predecessor of any
   * new entry is the last entry of *either* kind: an open hold that never
   * settles still occupies a link, and deriving the head from settlements alone
   * would silently skip it.
   */
  function lineageFor(
    state: LedgerState,
    reservationDigest: Digest
  ): readonly (EngineeringCostHold | EngineeringCostSettlement)[] {
    return state.entries
      .filter((entry) => entry.kind === "hold" || entry.kind === "settlement")
      .map(
        (entry) =>
          entry.document as EngineeringCostHold | EngineeringCostSettlement
      )
      .filter((document) => document.reservationDigest === reservationDigest);
  }

  function lineageTip(
    state: LedgerState,
    reservation: EngineeringCostReservation,
    reservationDigest: Digest
  ): { readonly head: Digest; readonly version: number } {
    const last = lineageFor(state, reservationDigest).at(-1);
    return last === undefined
      ? { head: reservation.ledgerHeadAfter, version: reservation.ledgerVersion }
      : { head: last.ledgerHeadAfter, version: last.ledgerVersion };
  }

  function releasesFor(
    state: LedgerState,
    reservationDigest: Digest
  ): readonly EngineeringCostRelease[] {
    return state.entries
      .filter((entry) => entry.kind === "release")
      .map((entry) => entry.document as EngineeringCostRelease)
      .filter((release) => release.reservationDigest === reservationDigest);
  }

  /**
   * Requires the caller's reservation to be a reservation this ledger actually
   * made.
   *
   * Without this, a fabricated reservation could be settled or released and its
   * unspent budget returned to the pool, minting cost units that were never
   * reserved and that a later, legitimate reservation could then spend. The
   * comparison is byte-exact rather than by id, so a mutated copy of a real
   * reservation is refused too.
   */
  function requireDurableReservation(
    state: LedgerState,
    reservation: EngineeringCostReservation,
    reservationDigest: Digest
  ): void {
    const durable = state.entries
      .filter((entry) => entry.kind === "reservation")
      .map((entry) => entry.document as EngineeringCostReservation)
      .some(
        (candidate) => canonicalJson(candidate) === canonicalJson(reservation)
      );
    if (!durable) {
      refuse(
        "ADAPTER_CONFLICT",
        `reservation ${reservationDigest} was never durably reserved by this ledger`
      );
    }
  }

  async function commit(input: {
    readonly state: LedgerState;
    readonly entry: CostLedgerEntry;
  }): Promise<void> {
    // The pool is the ledger's whole reason to exist, so it is bounded at every
    // single transition rather than only checked at the end. A pool above the
    // configured budget means units were minted; below zero means they were
    // spent twice.
    if (
      !Number.isSafeInteger(input.entry.pooledRemainingAfter) ||
      input.entry.pooledRemainingAfter < 0 ||
      input.entry.pooledRemainingAfter > totalBudget
    ) {
      refuse(
        "ADAPTER_OUTPUT_INVALID",
        `cost ledger transition would leave ${String(input.entry.pooledRemainingAfter)} of a ${String(totalBudget)} unit pool`
      );
    }
    const sequence = input.state.sequence + 1;
    const key = slotKey("entry", sequence);
    let outcome: Awaited<ReturnType<DurableSubstrate["compareAndSwap"]>>;
    try {
      outcome = await substrate.compareAndSwap({
        namespace: COST_LEDGER_NAMESPACE,
        key,
        expectedHead: input.state.substrateHead,
        body: input.entry
      });
    } catch (error) {
      if (!(error instanceof DurableAmbiguousAcknowledgementError)) throw error;
      // An ambiguous ledger commit does not need its authorship decided,
      // because every operation here is idempotent on durable *content*: the
      // bounded retry re-reads the journal and, if the entry is present, the
      // derivation returns it rather than writing a second one. Reporting a
      // conflict is therefore both honest and sufficient — it never claims the
      // write landed, and it never loses it if it did.
      refuse(
        "ADAPTER_CONFLICT",
        `cost ledger entry ${key} has an undecided acknowledgement`
      );
    }
    if (outcome.status === "conflict") {
      refuse("ADAPTER_CONFLICT", `cost ledger head moved before entry ${key}`);
    }
    await proveDurable({
      substrate,
      namespace: COST_LEDGER_NAMESPACE,
      key,
      body: input.entry,
      expectedSequence: sequence
    });
  }

  /**
   * Runs one ledger mutation against freshly read durable state, re-deriving on
   * a lost race up to a bounded number of attempts. `derive` returns an
   * already-durable document when the operation has already been performed,
   * which is what makes every operation here idempotent across a restart.
   */
  async function mutate<T>(
    derive: (state: LedgerState) => Promise<
      { readonly done: T } | { readonly entry: CostLedgerEntry; readonly result: T }
    >
  ): Promise<T> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < COST_LEDGER_MAX_ATTEMPTS; attempt += 1) {
      const state = await readState();
      const derived = await derive(state);
      if ("done" in derived) return derived.done;
      try {
        await commit({ state, entry: derived.entry });
        return derived.result;
      } catch (error) {
        if (
          !(error instanceof DurableEngineeringStoreError) ||
          error.code !== "ADAPTER_CONFLICT"
        ) {
          throw error;
        }
        lastError = error;
      }
    }
    // The final attempt's conflict may itself have been an ambiguous commit
    // that actually landed. Deriving once more against freshly read durable
    // state is what turns that into a known answer: if the operation is
    // present, it is returned, so a reservation is never stranded by a failure
    // report for a mutation that succeeded.
    const settled = await derive(await readState());
    if ("done" in settled) return settled.done;
    throw lastError instanceof Error
      ? lastError
      : new DurableEngineeringStoreError(
          "ADAPTER_CONFLICT",
          "cost ledger remained contended"
        );
  }

  async function sign(payload: unknown, label: string): Promise<EngineeringCostReservation["signature"]> {
    const signature = await options.signer.sign(payload);
    if (
      typeof signature !== "object" ||
      signature.algorithm !== "ed25519" ||
      typeof signature.keyId !== "string" ||
      signature.keyId.length === 0 ||
      typeof signature.value !== "string" ||
      signature.value.length === 0
    ) {
      refuse(
        "ADAPTER_OUTPUT_INVALID",
        `${label} signer returned an unusable detached signature`
      );
    }
    return signature;
  }

  return {
    async hold(input): Promise<EngineeringCostHold> {
      const reservationDigest = digest(input.reservation);
      const phase = input.phase;
      if (!PHASE_ORDER.includes(phase)) {
        refuse("ADAPTER_ARGUMENT_INVALID", `unknown hold phase ${String(phase)}`);
      }
      const sequence = assertNonNegativeInteger(input.sequence, "sequence");
      const now = assertTimestamp(input.now, "now");
      // A hold authorizes an attempt, and `validateProviderAttempt` refuses an
      // attempt outside its reservation's window, so an already-expired hold is
      // never written rather than written and then found unusable.
      if (
        millisecondsOf(now, "now") >=
        millisecondsOf(input.reservation.expiresAt, "reservation.expiresAt")
      ) {
        refuse(
          "ADAPTER_ARGUMENT_INVALID",
          "a cost hold cannot be taken at or after its reservation expires"
        );
      }
      const heldCostUnits = input.reservation.phaseBudgets[phase];
      const heldTokenUnits = input.reservation.phaseTokenBudgets[phase];
      if (
        !Number.isSafeInteger(heldCostUnits) ||
        heldCostUnits < 0 ||
        !Number.isSafeInteger(heldTokenUnits) ||
        heldTokenUnits < 0
      ) {
        refuse(
          "ADAPTER_RECORD_INVALID",
          `reservation carries no usable ${phase} phase budget`
        );
      }

      return mutate<EngineeringCostHold>(async (state) => {
        requireDurableReservation(state, input.reservation, reservationDigest);
        // A released reservation is closed. Admitting a hold afterwards would
        // let an attempt open against budget the release already returned to
        // the pool — the exact race this contract exists to make impossible.
        if (releasesFor(state, reservationDigest).length > 0) {
          refuse(
            "ADAPTER_CONFLICT",
            "this reservation has already been released and cannot take further holds"
          );
        }
        const durableHolds = holdsFor(state, reservationDigest);
        const existing = durableHolds.find(
          (candidate) =>
            candidate.phase === phase && candidate.sequence === sequence
        );
        const priorSettlements = settlementsFor(state, reservationDigest);
        const prior = priorSettlements.at(-1);
        const projected = {
          projectedCumulativeCalls: (prior?.cumulativeCalls ?? 0) + 1,
          projectedCumulativeTokens:
            (prior?.cumulativeTokens ?? 0) + heldTokenUnits,
          projectedCumulativeCostUnits:
            (prior?.cumulativeCostUnits ?? 0) + heldCostUnits
        };
        // Content-addressed on (reservation, phase, sequence): the caller
        // retries after an ambiguous acknowledgement and must get the same hold
        // back, never a second one holding the same budget twice.
        if (existing !== undefined) {
          if (
            existing.projectedCumulativeCalls !== projected.projectedCumulativeCalls ||
            existing.projectedCumulativeTokens !== projected.projectedCumulativeTokens ||
            existing.projectedCumulativeCostUnits !==
              projected.projectedCumulativeCostUnits ||
            existing.heldCostUnits !== heldCostUnits ||
            existing.heldTokenUnits !== heldTokenUnits
          ) {
            refuse(
              "ADAPTER_CONFLICT",
              `a ${phase} hold at sequence ${String(sequence)} is already recorded against a different settlement history`
            );
          }
          return { done: existing };
        }
        // One phase holds its budget once. A second hold for the same phase
        // would reserve the same units twice and strand the difference.
        if (durableHolds.some((candidate) => candidate.phase === phase)) {
          refuse(
            "ADAPTER_CONFLICT",
            `the ${phase} phase budget is already held by this reservation`
          );
        }
        // At most one hold is open at a time, so the lineage strictly alternates
        // hold, settlement, hold, settlement.
        //
        // Two concurrently open holds would fork the chain: a settlement derives
        // its position from the hold it discharges, so settling the older one
        // after a newer hold had been taken would write a second entry at the
        // version that newer hold already occupies, and the reservation could
        // then never be validly released. Phases are sequential by construction
        // — `settle` requires strict phase order, and the slice abandons the run
        // when a phase's usage never resolves — so nothing legitimate needs to
        // hold two at once.
        const settledPhases = new Set(
          priorSettlements.map((settlement) => settlement.phase)
        );
        const openHold = durableHolds.find(
          (candidate) => !settledPhases.has(candidate.phase)
        );
        if (openHold !== undefined) {
          refuse(
            "ADAPTER_CONFLICT",
            `the ${openHold.phase} hold is still open, so this reservation cannot take another`
          );
        }
        if (priorSettlements.some((settlement) => settlement.phase === phase)) {
          refuse(
            "ADAPTER_CONFLICT",
            `the ${phase} phase has already settled and cannot be held again`
          );
        }
        // The sequence is the caller's restatement of a position durable state
        // already fixes. Checking it rather than trusting it keeps a caller
        // whose local counters drifted from signing a hold its own validator
        // would reject a moment later.
        if (sequence !== durableHolds.length + 1) {
          refuse(
            "ADAPTER_ARGUMENT_INVALID",
            `hold sequence ${String(sequence)} does not follow the ${String(durableHolds.length)} holds already recorded`
          );
        }
        const { head: ledgerHeadBefore, version: priorVersion } = lineageTip(
          state,
          input.reservation,
          reservationDigest
        );
        const ledgerVersion = priorVersion + 1;
        const reconciliationExpiresAt = reconciliationExpiry(
          input.reservation.expiresAt
        );
        const holdId = `hold.${digest({ reservationDigest, phase, sequence }).slice(
          "sha256:".length,
          "sha256:".length + 32
        )}`;
        const ledgerHeadAfter = digest({
          ledgerHeadBefore,
          ledgerVersion,
          holdId,
          reservationDigest,
          phase,
          sequence,
          heldCostUnits,
          heldTokenUnits,
          ...projected,
          reconciliationExpiresAt
        });
        const payload = {
          holdId,
          reservationDigest,
          activationLeaseDigest: input.reservation.activationLeaseDigest,
          phase,
          sequence,
          heldCostUnits,
          heldTokenUnits,
          ...projected,
          ledgerVersion,
          ledgerHeadBefore,
          ledgerHeadAfter,
          heldAt: now,
          expiresAt: input.reservation.expiresAt,
          reconciliationExpiresAt
        };
        const hold: EngineeringCostHold = {
          ...payload,
          signature: await sign(payload, "cost hold")
        };
        return {
          entry: {
            kind: "hold",
            document: hold,
            ledgerHeadAfter,
            // A hold moves no units: `reserve` already took them out of the
            // pool. It records *which* reserved units are spoken for, so the
            // pool is unchanged and the invariant stays checkable at this entry.
            pooledRemainingAfter: state.pooled,
            totalBudgetCostUnits: totalBudget
          },
          result: hold
        };
      });
    },

    async reserve(input): Promise<EngineeringCostReservation> {
      const workAccordDigest = assertDigestArgument(
        input.workAccordDigest,
        "workAccordDigest"
      );
      const activationLeaseDigest = assertDigestArgument(
        input.activationLeaseDigest,
        "activationLeaseDigest"
      );
      const now = assertTimestamp(input.now, "now");
      const expiresAt = assertTimestamp(input.expiresAt, "expiresAt");
      const maxCalls = assertNonNegativeInteger(input.maxCalls, "maxCalls");
      const maxTokens = assertNonNegativeInteger(input.maxTokens, "maxTokens");
      // `validateCostReservation` refuses `maxCalls < 1` and a reservation that
      // is already expired. Mirroring those bounds here means the ledger never
      // durably records a reservation its own caller must reject.
      if (maxCalls < 1) {
        refuse("ADAPTER_ARGUMENT_INVALID", "maxCalls must be at least one");
      }
      if (millisecondsOf(now, "now") >= millisecondsOf(expiresAt, "expiresAt")) {
        refuse(
          "ADAPTER_ARGUMENT_INVALID",
          "a reservation cannot be made at or after its own expiry"
        );
      }
      for (const phase of PHASE_ORDER) {
        assertNonNegativeInteger(
          input.phaseBudgets[phase],
          `phaseBudgets.${phase}`
        );
        assertNonNegativeInteger(
          input.phaseTokenBudgets[phase],
          `phaseTokenBudgets.${phase}`
        );
      }
      const totalReserved = PHASE_ORDER.reduce(
        (sum, phase) => sum + input.phaseBudgets[phase],
        0
      );

      return mutate<EngineeringCostReservation>(async (state) => {
        const existing = state.entries
          .filter((entry) => entry.kind === "reservation")
          .map((entry) => entry.document as EngineeringCostReservation)
          .find(
            (reservation) =>
              reservation.activationLeaseDigest === activationLeaseDigest
          );
        if (existing !== undefined) {
          // One activation lease reserves once. The lookup is keyed by the
          // lease *alone* on purpose: keying it by the accord as well would let
          // the same lease reserve a second time under a different Work Accord
          // and spend the pool twice. A request that differs in any bound field
          // is therefore a conflict, not a second reservation.
          if (
            existing.workAccordDigest !== workAccordDigest ||
            digest(existing.phaseBudgets) !== digest(input.phaseBudgets) ||
            digest(existing.phaseTokenBudgets) !==
              digest(input.phaseTokenBudgets) ||
            existing.maxCalls !== maxCalls ||
            existing.maxTokens !== maxTokens ||
            existing.expiresAt !== expiresAt
          ) {
            refuse(
              "ADAPTER_CONFLICT",
              "a different reservation already exists for this activation lease"
            );
          }
          return { done: existing };
        }
        if (totalReserved > state.pooled) {
          refuse(
            "ADAPTER_CONFLICT",
            `reservation of ${String(totalReserved)} exceeds the ${String(state.pooled)} cost units still pooled`
          );
        }
        const ledgerVersion = state.sequence;
        const remainingBefore = state.pooled;
        const remainingAfter = remainingBefore - totalReserved;
        const reservationId = `reservation.${digest({
          workAccordDigest,
          activationLeaseDigest,
          ledgerVersion
        }).slice("sha256:".length, "sha256:".length + 32)}`;
        const ledgerHeadAfter = digest({
          ledgerHeadBefore: state.ledgerHead,
          ledgerVersion,
          reservationId,
          workAccordDigest,
          activationLeaseDigest,
          phaseBudgets: input.phaseBudgets,
          phaseTokenBudgets: input.phaseTokenBudgets,
          maxCalls,
          maxTokens,
          totalReserved,
          remainingBefore,
          remainingAfter
        });
        const payload = {
          reservationId,
          workAccordDigest,
          activationLeaseDigest,
          phaseBudgets: input.phaseBudgets,
          phaseTokenBudgets: input.phaseTokenBudgets,
          maxCalls,
          maxTokens,
          totalReserved,
          remainingBefore,
          remainingAfter,
          ledgerVersion,
          ledgerHeadBefore: state.ledgerHead,
          ledgerHeadAfter,
          checkedAt: now,
          reservedAt: now,
          expiresAt
        };
        const reservation: EngineeringCostReservation = {
          ...payload,
          signature: await sign(payload, "cost reservation")
        };
        return {
          entry: {
            kind: "reservation",
            document: reservation,
            ledgerHeadAfter,
            pooledRemainingAfter: remainingAfter,
            totalBudgetCostUnits: totalBudget
          },
          result: reservation
        };
      });
    },

    async settle(input): Promise<EngineeringCostSettlement> {
      const reservationDigest = digest(input.reservation);
      const attemptDigest = digest(input.attempt);
      const providerUsageDigest = assertDigestArgument(
        input.providerUsageDigest,
        "providerUsageDigest"
      );
      const now = assertTimestamp(input.now, "now");
      const phase = input.phase;
      if (!PHASE_ORDER.includes(phase)) {
        refuse("ADAPTER_ARGUMENT_INVALID", `unknown settlement phase ${phase}`);
      }
      if (input.attempt.phase !== phase) {
        refuse(
          "ADAPTER_ARGUMENT_INVALID",
          "settlement phase does not match its attempt"
        );
      }
      if (input.attempt.reservationDigest !== reservationDigest) {
        refuse(
          "ADAPTER_ARGUMENT_INVALID",
          "settlement attempt belongs to a different reservation"
        );
      }
      if (input.usage.attemptDigest !== attemptDigest) {
        refuse(
          "ADAPTER_ARGUMENT_INVALID",
          "settlement usage belongs to a different attempt"
        );
      }
      if (input.usage.status !== "settled") {
        // An unresolved attempt is *held*, never settled. Settling an unknown
        // usage would convert "we do not know what this cost" into a signed
        // claim that we do.
        refuse(
          "ADAPTER_ARGUMENT_INVALID",
          "an attempt with unknown provider usage cannot be settled"
        );
      }
      // The settlement's numbers must be the authoritative usage record's
      // numbers. Accepting the caller's separate arguments unchecked would let
      // a lower invented cost be signed and the difference returned to the pool
      // as if it had never been spent.
      if (
        input.actualCostUnits !== input.usage.actualCostUnits ||
        input.actualCalls !== input.usage.actualCalls ||
        input.actualTokens !== input.usage.actualTokens ||
        providerUsageDigest !== input.usage.providerUsageDigest
      ) {
        refuse(
          "ADAPTER_ARGUMENT_INVALID",
          "settlement values do not match the authoritative provider usage record"
        );
      }
      const actualCostUnits = assertNonNegativeInteger(
        input.actualCostUnits,
        "actualCostUnits"
      );
      const actualTokens = assertNonNegativeInteger(
        input.actualTokens,
        "actualTokens"
      );
      if (input.actualCalls !== 1) {
        refuse(
          "ADAPTER_ARGUMENT_INVALID",
          "one provider attempt settles exactly one call"
        );
      }
      const phaseBudget = input.reservation.phaseBudgets[phase];
      const tokenBudget = input.reservation.phaseTokenBudgets[phase];
      if (actualCostUnits > phaseBudget || actualTokens > tokenBudget) {
        refuse(
          "ADAPTER_ARGUMENT_INVALID",
          `${phase} settlement exceeds its reserved phase budget`
        );
      }
      // `validateCostSettlement` refuses a settlement recorded at or after its
      // own reconciliation deadline, so one is never durably written.
      const settlementReconciliationExpiry = reconciliationExpiry(
        input.reservation.expiresAt
      );
      if (
        millisecondsOf(now, "now") >=
        millisecondsOf(settlementReconciliationExpiry, "reconciliationExpiresAt")
      ) {
        refuse(
          "ADAPTER_ARGUMENT_INVALID",
          "a settlement cannot be recorded after its reconciliation window closes"
        );
      }

      return mutate<EngineeringCostSettlement>(async (state) => {
        requireDurableReservation(state, input.reservation, reservationDigest);
        const priorSettlements = settlementsFor(state, reservationDigest);
        const already = priorSettlements.find(
          (settlement) =>
            settlement.attemptDigest === attemptDigest &&
            settlement.phase === phase
        );
        // The caller retries `settle` after a failure and requires the same
        // settlement back, so a durable hit is returned unchanged rather than
        // re-minted with a new timestamp. It must still be the *same*
        // settlement: a replay whose actuals were mutated is refused rather
        // than answered with the original, which would be a success-shaped
        // wrong answer.
        if (already !== undefined) {
          if (
            already.actualCostUnits !== actualCostUnits ||
            already.actualCalls !== 1 ||
            already.actualTokens !== actualTokens ||
            already.providerUsageDigest !== providerUsageDigest
          ) {
            refuse(
              "ADAPTER_CONFLICT",
              "this attempt is already settled with different values"
            );
          }
          return { done: already };
        }

        // The settlement's numbers must trace to durable evidence, not to the
        // caller's copy of it. The attempt must be the one the provider usage
        // ledger recorded, and the usage must be the reconciliation that ledger
        // wrote for it — a forged zero-cost usage would otherwise return the
        // whole phase budget to the pool, durably, before
        // `validateCostSettlement` (which re-reads the same caller values) ever
        // ran.
        const durableAttempts =
          await options.providerEvidence.listAttempts(reservationDigest);
        const durableAttempt = durableAttempts.find(
          (candidate) => digest(candidate) === attemptDigest
        );
        if (
          durableAttempt === undefined ||
          canonicalJson(durableAttempt) !== canonicalJson(input.attempt)
        ) {
          refuse(
            "ADAPTER_CONFLICT",
            `attempt ${attemptDigest} is not durably recorded for this reservation`
          );
        }
        const durableUsage =
          await options.providerEvidence.readUsage(attemptDigest);
        if (
          durableUsage === null ||
          canonicalJson(durableUsage) !== canonicalJson(input.usage)
        ) {
          refuse(
            "ADAPTER_CONFLICT",
            `provider usage for attempt ${attemptDigest} is not the durable reconciliation`
          );
        }

        // A reservation that has already been released is closed. Settling
        // against it afterwards would spend budget the ledger has returned to
        // the pool and already accounted for as unspent.
        if (releasesFor(state, reservationDigest).length > 0) {
          refuse(
            "ADAPTER_CONFLICT",
            "this reservation has already been released and cannot settle further phases"
          );
        }

        // A settlement discharges exactly the hold that authorized its attempt.
        // The hold is read from durable state rather than taken from the
        // caller, so a settlement cannot discharge a hold this ledger never
        // wrote, and cannot chain onto a position the lineage does not have.
        const durableHold = holdsFor(state, reservationDigest).find(
          (candidate) => candidate.phase === phase
        );
        if (
          durableHold === undefined ||
          canonicalJson(durableHold) !== canonicalJson(input.hold) ||
          digest(durableHold) !== input.attempt.holdDigest
        ) {
          refuse(
            "ADAPTER_CONFLICT",
            `the ${phase} settlement does not discharge this reservation's durable ${phase} hold`
          );
        }
        const holdDigest = digest(durableHold);
        if (durableHold.heldCostUnits !== phaseBudget) {
          refuse(
            "ADAPTER_RECORD_INVALID",
            `the durable ${phase} hold disagrees with the reservation's phase budget`
          );
        }

        const prior = priorSettlements.at(-1);
        if (PHASE_ORDER.indexOf(phase) !== priorSettlements.length) {
          refuse(
            "ADAPTER_CONFLICT",
            `${phase} settlement is out of order for this reservation`
          );
        }
        const releasedCostUnits = phaseBudget - actualCostUnits;
        const cumulativeCostUnits =
          (prior?.cumulativeCostUnits ?? 0) + actualCostUnits;
        const cumulativeCalls = (prior?.cumulativeCalls ?? 0) + 1;
        const cumulativeTokens = (prior?.cumulativeTokens ?? 0) + actualTokens;
        const cumulativeReleasedCostUnits =
          (prior?.cumulativeReleasedCostUnits ?? 0) + releasedCostUnits;
        if (
          cumulativeCalls > input.reservation.maxCalls ||
          cumulativeTokens > input.reservation.maxTokens ||
          cumulativeCostUnits + cumulativeReleasedCostUnits >
            input.reservation.totalReserved
        ) {
          refuse(
            "ADAPTER_CONFLICT",
            "settlement would exceed the reservation's signed bounds"
          );
        }
        const ledgerVersion = durableHold.ledgerVersion + 1;
        const ledgerHeadBefore = durableHold.ledgerHeadAfter;
        const reconciliationExpiresAt = reconciliationExpiry(
          input.reservation.expiresAt
        );
        const ledgerHeadAfter = digest({
          ledgerHeadBefore,
          ledgerVersion,
          attemptDigest,
          holdDigest,
          phase,
          actualCostUnits,
          actualCalls: 1,
          actualTokens,
          releasedCostUnits,
          cumulativeCostUnits,
          cumulativeCalls,
          cumulativeTokens,
          cumulativeReleasedCostUnits,
          providerUsageDigest,
          reconciliationExpiresAt
        });
        const payload = {
          reservationDigest,
          attemptDigest,
          holdDigest,
          phase,
          actualCostUnits,
          actualCalls: 1,
          actualTokens,
          releasedCostUnits,
          cumulativeCostUnits,
          cumulativeCalls,
          cumulativeTokens,
          cumulativeReleasedCostUnits,
          providerUsageDigest,
          ledgerVersion,
          ledgerHeadBefore,
          ledgerHeadAfter,
          settledAt: now,
          reconciliationExpiresAt
        };
        const settlement: EngineeringCostSettlement = {
          ...payload,
          signature: await sign(payload, "cost settlement")
        };
        return {
          entry: {
            kind: "settlement",
            document: settlement,
            ledgerHeadAfter,
            // Unspent phase budget returns to the pool as soon as the phase
            // settles; the still-unsettled phases stay reserved.
            pooledRemainingAfter: state.pooled + releasedCostUnits,
            totalBudgetCostUnits: totalBudget
          },
          result: settlement
        };
      });
    },

    async release(input): Promise<EngineeringCostRelease> {
      const releaseIdempotencyKey = assertDigestArgument(
        input.releaseIdempotencyKey,
        "releaseIdempotencyKey"
      );
      const reservationDigest = digest(input.reservation);
      const now = assertTimestamp(input.now, "now");
      // `validateCostRelease` refuses a release recorded at or after the
      // reservation's reconciliation deadline, so one is never durably written.
      if (
        millisecondsOf(now, "now") >=
        millisecondsOf(
          reconciliationExpiry(input.reservation.expiresAt),
          "reconciliationExpiresAt"
        )
      ) {
        refuse(
          "ADAPTER_ARGUMENT_INVALID",
          "a release cannot be recorded after its reconciliation window closes"
        );
      }
      const expected = digest({
        operation: "release-engineering-reservation",
        reservation: reservationDigest,
        settlements: input.settledPhases.map((settlement) => digest(settlement))
      });
      // The idempotency key is a claim about exactly which settlements this
      // release covers. The held set is deliberately absent from it: that set is
      // derived from durable state, so a retry after re-derivation must still
      // resolve to the same operation rather than colliding with itself.
      if (expected !== releaseIdempotencyKey) {
        refuse(
          "ADAPTER_ARGUMENT_INVALID",
          "release idempotency key does not describe the supplied settlements"
        );
      }
      const expectedOpenHoldDigests = input.expectedOpenHoldDigests.map(
        (value, index) =>
          assertDigestArgument(value, `expectedOpenHoldDigests[${String(index)}]`)
      );
      if (
        new Set(expectedOpenHoldDigests).size !== expectedOpenHoldDigests.length
      ) {
        refuse(
          "ADAPTER_ARGUMENT_INVALID",
          "release repeats an expected open hold"
        );
      }

      return mutate<EngineeringCostRelease>(async (state) => {
        requireDurableReservation(state, input.reservation, reservationDigest);
        const releases = releasesFor(state, reservationDigest);
        const durableSettlements = settlementsFor(state, reservationDigest);
        const suppliedSettlementDigests = input.settledPhases.map((settlement) =>
          digest(settlement)
        );
        // A replay is only a replay when it covers the same settlements. The
        // held set is derived from the same durable state on every attempt, so
        // it cannot differ between a release and its own replay.
        const already = releases.find(
          (release) =>
            digest(release.settlementDigests) === digest(suppliedSettlementDigests)
        );
        if (already !== undefined) return { done: already };
        // A reservation is released exactly once. `validateCostRelease` derives
        // `releasedCostUnits` from the reservation total without subtracting an
        // earlier release, so a second release covering a different settlement
        // set would return the same pooled budget twice.
        if (releases.length > 0) {
          refuse(
            "ADAPTER_CONFLICT",
            "this reservation has already been released under a different settlement set"
          );
        }

        // The release must describe the ledger's own record of what happened,
        // not the caller's recollection of it.
        if (
          digest(suppliedSettlementDigests) !==
          digest(durableSettlements.map((settlement) => digest(settlement)))
        ) {
          refuse(
            "ADAPTER_CONFLICT",
            "release does not cover exactly the durably settled phases"
          );
        }

        // The open set is *derived*, never supplied.
        //
        // This is the whole point of the hold: a caller that lost track of an
        // attempt — an exception between the durable hold and its own
        // bookkeeping, or a crash — cannot cause that attempt's budget to be
        // released, because the ledger never consults the caller's list to find
        // it. Budget leaves a hold only through a settlement that proves what
        // was spent; absence of evidence never releases it.
        const settledHoldDigests = new Set(
          durableSettlements.map((settlement) => settlement.holdDigest)
        );
        const durableHolds = holdsFor(state, reservationDigest);
        const unresolvedHolds = durableHolds.filter(
          (hold) => !settledHoldDigests.has(digest(hold))
        );
        const unresolvedHoldDigests = unresolvedHolds.map((hold) => digest(hold));
        const derivedOpenSet = new Set(unresolvedHoldDigests);
        // The caller's view may legitimately be *smaller* than the derived set
        // (that is the post-crash case this contract exists to survive), but it
        // may not name a hold this ledger never wrote.
        for (const expectedOpen of expectedOpenHoldDigests) {
          if (!derivedOpenSet.has(expectedOpen)) {
            refuse(
              "ADAPTER_ARGUMENT_INVALID",
              `hold ${expectedOpen} is not an open hold of this reservation`
            );
          }
        }

        const last = durableSettlements.at(-1);
        const cumulativeCostUnits = last?.cumulativeCostUnits ?? 0;
        const cumulativeCalls = last?.cumulativeCalls ?? 0;
        const cumulativeTokens = last?.cumulativeTokens ?? 0;
        const previouslyReleasedCostUnits =
          last?.cumulativeReleasedCostUnits ?? 0;
        // The held amount is derived **exclusively from the durable
        // reservation**, never from the hold's own restatement of it. A forged
        // low value would otherwise inflate `releasedCostUnits`, durably raise
        // the pool before the caller's validator ever ran, survive a restart,
        // and fund a later over-reservation.
        let heldCostUnits = 0;
        for (const hold of unresolvedHolds) {
          const phase: EngineeringCostHold["phase"] = hold.phase;
          if (!PHASE_ORDER.includes(phase)) {
            refuse(
              "ADAPTER_RECORD_INVALID",
              `an open hold names unknown phase ${String(phase)}`
            );
          }
          const reservedForPhase = input.reservation.phaseBudgets[phase];
          if (!Number.isSafeInteger(reservedForPhase) || reservedForPhase < 0) {
            refuse(
              "ADAPTER_RECORD_INVALID",
              `reservation carries no usable ${phase} phase budget`
            );
          }
          if (hold.heldCostUnits !== reservedForPhase) {
            refuse(
              "ADAPTER_RECORD_INVALID",
              `the open ${phase} hold states ${String(hold.heldCostUnits)} units but the reservation reserved ${String(reservedForPhase)}`
            );
          }
          heldCostUnits += reservedForPhase;
        }
        if (
          !Number.isSafeInteger(input.reservation.totalReserved) ||
          !Number.isSafeInteger(cumulativeCostUnits) ||
          !Number.isSafeInteger(previouslyReleasedCostUnits) ||
          !Number.isSafeInteger(heldCostUnits) ||
          heldCostUnits > input.reservation.totalReserved
        ) {
          refuse(
            "ADAPTER_CONFLICT",
            "release arithmetic inputs are not representable against this reservation"
          );
        }
        const releasedCostUnits =
          input.reservation.totalReserved -
          cumulativeCostUnits -
          previouslyReleasedCostUnits -
          heldCostUnits;
        if (!Number.isSafeInteger(releasedCostUnits) || releasedCostUnits < 0) {
          refuse(
            "ADAPTER_CONFLICT",
            "release would return more cost units than the reservation holds"
          );
        }
        const cumulativeReleasedCostUnits =
          previouslyReleasedCostUnits + releasedCostUnits;
        // The release closes the lineage, so it chains onto the last entry of
        // either kind: an open hold that never settled is still a link.
        const { head: ledgerHeadBefore, version: priorVersion } = lineageTip(
          state,
          input.reservation,
          reservationDigest
        );
        const ledgerVersion = priorVersion + 1;
        const reconciliationRequired = unresolvedHolds.length > 0;
        const ledgerHeadAfter = digest({
          ledgerHeadBefore,
          ledgerVersion,
          reservationDigest,
          settlementDigests: suppliedSettlementDigests,
          unresolvedHoldDigests,
          reconciliationRequired,
          previouslyReleasedCostUnits,
          heldCostUnits,
          releasedCostUnits,
          cumulativeCostUnits,
          cumulativeCalls,
          cumulativeTokens,
          cumulativeReleasedCostUnits
        });
        const payload = {
          reservationDigest,
          settlementDigests: suppliedSettlementDigests,
          // Whole signed holds, not digests: this release is the closing
          // document and must prove what it still holds without a second read.
          unresolvedHolds,
          reconciliationRequired,
          previouslyReleasedCostUnits,
          heldCostUnits,
          releasedCostUnits,
          cumulativeCostUnits,
          cumulativeCalls,
          cumulativeTokens,
          cumulativeReleasedCostUnits,
          ledgerVersion,
          ledgerHeadBefore,
          ledgerHeadAfter,
          releasedAt: now
        };
        const release: EngineeringCostRelease = {
          ...payload,
          signature: await sign(payload, "cost release")
        };
        return {
          entry: {
            kind: "release",
            document: release,
            ledgerHeadAfter,
            pooledRemainingAfter: state.pooled + releasedCostUnits,
            totalBudgetCostUnits: totalBudget
          },
          result: release
        };
      });
    }
  };
}

// ---------------------------------------------------------------------------
// EngineeringProviderUsageLedger
// ---------------------------------------------------------------------------

/**
 * What an injected observer reports about one completed provider attempt.
 *
 * Returning `null` is a first-class answer meaning "the provider did not tell
 * us". The ledger records that as `unknown` and never fabricates a cost, which
 * is what keeps an unresolved attempt held rather than silently released.
 */
export interface DurableObservedProviderUsage {
  readonly actualCostUnits: number;
  readonly actualCalls: number;
  readonly actualTokens: number;
  readonly providerUsageDigest: Digest;
}

export interface DurableProviderUsageObserver {
  observe(input: {
    readonly reservation: EngineeringCostReservation;
    readonly attempt: EngineeringProviderAttempt;
    readonly now: string;
  }): Promise<DurableObservedProviderUsage | null>;
}

export interface DurableEngineeringProviderUsageLedgerOptions {
  /** A substrate already opened for the `receipt-journal` binding. */
  readonly substrate: DurableSubstrate;
  readonly signer: EvidenceSigner;
  /**
   * The only source of provider truth. Required, because a ledger that could
   * fall back to inventing usage would be minting cost evidence.
   */
  readonly observer: DurableProviderUsageObserver;
}

/**
 * Binds `EngineeringProviderUsageLedger` to a durable substrate.
 *
 * Both operations are content-keyed idempotent appends, which is what makes
 * them stable across a restart: an attempt begun once is begun once, and a
 * usage reconciled once keeps its answer forever. That last property is the
 * important one for `unknown` — re-observing later and finding a cost would
 * retroactively change a settled release.
 */
export function openDurableEngineeringProviderUsageLedger(
  options: DurableEngineeringProviderUsageLedgerOptions
): EngineeringProviderUsageLedger {
  const substrate = options.substrate;
  assertStore(
    substrate,
    RECEIPT_JOURNAL_STORE_ID,
    "engineering provider usage ledger"
  );

  async function sign(
    payload: unknown,
    label: string
  ): Promise<EngineeringProviderAttempt["signature"]> {
    const signature = await options.signer.sign(payload);
    if (
      typeof signature !== "object" ||
      signature.algorithm !== "ed25519" ||
      typeof signature.keyId !== "string" ||
      signature.keyId.length === 0 ||
      typeof signature.value !== "string" ||
      signature.value.length === 0
    ) {
      refuse(
        "ADAPTER_OUTPUT_INVALID",
        `${label} signer returned an unusable detached signature`
      );
    }
    return signature;
  }

  return {
    async begin(input): Promise<EngineeringProviderAttempt> {
      const reservationDigest = digest(input.reservation);
      const phase = input.phase;
      if (!PHASE_ORDER.includes(phase)) {
        refuse("ADAPTER_ARGUMENT_INVALID", `unknown attempt phase ${phase}`);
      }
      const sequence = assertNonNegativeInteger(input.sequence, "sequence");
      const now = assertTimestamp(input.now, "now");
      const reconciliationExpiresAt = reconciliationExpiry(
        input.reservation.expiresAt
      );
      // `validateProviderAttempt` requires the attempt to be fresh within its
      // reservation's expiry, so an already-expired attempt is never recorded.
      if (
        millisecondsOf(now, "now") >=
        millisecondsOf(input.reservation.expiresAt, "reservation.expiresAt")
      ) {
        refuse(
          "ADAPTER_ARGUMENT_INVALID",
          "a provider attempt cannot begin at or after its reservation expires"
        );
      }
      // The caller supplies its own view of the reconciliation deadline. It is
      // checked rather than used, so this adapter can never sign an attempt
      // whose window `validateProviderAttempt` will reject.
      if (input.reconciliationExpiresAt !== reconciliationExpiresAt) {
        refuse(
          "ADAPTER_ARGUMENT_INVALID",
          "reconciliation expiry does not follow from the reservation expiry"
        );
      }

      // The attempt is authorized by a committed hold, so the hold's own
      // binding is checked before anything is written. An attempt whose hold
      // names another reservation, phase, or position is not evidence that the
      // budget it is about to spend was ever held.
      const holdDigest = digest(input.hold);
      if (
        input.hold.reservationDigest !== reservationDigest ||
        input.hold.phase !== phase ||
        input.hold.sequence !== sequence ||
        input.hold.heldCostUnits !== input.reservation.phaseBudgets[phase] ||
        input.hold.heldTokenUnits !== input.reservation.phaseTokenBudgets[phase] ||
        input.hold.reconciliationExpiresAt !== reconciliationExpiresAt
      ) {
        refuse(
          "ADAPTER_ARGUMENT_INVALID",
          "provider attempt is not bound to a hold for this reservation, phase, and position"
        );
      }
      const key = `attempt.${digest({ reservationDigest, phase, sequence })}`;
      const prior = input.priorSettlements.at(-1);
      const projected = {
        projectedCumulativeCalls: (prior?.cumulativeCalls ?? 0) + 1,
        projectedCumulativeTokens:
          (prior?.cumulativeTokens ?? 0) +
          input.reservation.phaseTokenBudgets[phase],
        projectedCumulativeCostUnits:
          (prior?.cumulativeCostUnits ?? 0) + input.reservation.phaseBudgets[phase]
      };
      const stored = await substrate.read({
        namespace: PROVIDER_USAGE_NAMESPACE,
        key
      });
      if (stored !== null) {
        const durable = stored.body as EngineeringProviderAttempt;
        // The key covers (reservation, phase, sequence), but the settlement
        // history also determines every projected cumulative. Returning the
        // stored attempt for a *different* history would be a success-shaped
        // answer that `validateProviderAttempt` rejects a moment later, so the
        // derived fields are compared before the replay is honoured.
        if (
          durable.projectedCumulativeCalls !== projected.projectedCumulativeCalls ||
          durable.projectedCumulativeTokens !==
            projected.projectedCumulativeTokens ||
          durable.projectedCumulativeCostUnits !==
            projected.projectedCumulativeCostUnits ||
          durable.reconciliationExpiresAt !== reconciliationExpiresAt ||
          durable.holdDigest !== holdDigest ||
          durable.phaseBudget !== input.reservation.phaseBudgets[phase] ||
          durable.tokenBudget !== input.reservation.phaseTokenBudgets[phase]
        ) {
          refuse(
            "ADAPTER_CONFLICT",
            `provider attempt ${key} is already recorded against a different settlement history`
          );
        }
        return durable;
      }

      const payload = {
        attemptId: `attempt.${digest({ reservationDigest, phase, sequence }).slice(
          "sha256:".length,
          "sha256:".length + 32
        )}`,
        reservationDigest,
        activationLeaseDigest: input.reservation.activationLeaseDigest,
        holdDigest,
        phase,
        phaseBudget: input.reservation.phaseBudgets[phase],
        tokenBudget: input.reservation.phaseTokenBudgets[phase],
        sequence,
        ...projected,
        startedAt: now,
        expiresAt: input.reservation.expiresAt,
        reconciliationExpiresAt
      };
      const attempt: EngineeringProviderAttempt = {
        ...payload,
        signature: await sign(payload, "provider attempt")
      };
      const record = await appendAndProve({
        substrate,
        namespace: PROVIDER_USAGE_NAMESPACE,
        key,
        body: attempt,
        expectedSequence: null,
        // Content-addressed on (reservation, phase, sequence): an identical
        // attempt already recorded is the same attempt, not a lost race.
        acceptExisting: true,
        onConflict: () =>
          refuse(
            "ADAPTER_CONFLICT",
            `provider attempt ${key} is occupied by a different attempt`
          )
      });
      return record.body as EngineeringProviderAttempt;
    },

    async reconcile(input): Promise<EngineeringProviderUsage> {
      const attemptDigest = digest(input.attempt);
      const now = assertTimestamp(input.now, "now");
      if (input.attempt.reservationDigest !== digest(input.reservation)) {
        refuse(
          "ADAPTER_ARGUMENT_INVALID",
          "attempt belongs to a different reservation"
        );
      }
      const key = `usage.${attemptDigest}`;
      // `validateProviderUsage` requires the observation to fall inside the
      // attempt's signed reconciliation window, so one outside it is never
      // durably recorded.
      if (
        millisecondsOf(now, "now") <
          millisecondsOf(input.attempt.startedAt, "attempt.startedAt") ||
        millisecondsOf(now, "now") >=
          millisecondsOf(
            input.attempt.reconciliationExpiresAt,
            "attempt.reconciliationExpiresAt"
          )
      ) {
        refuse(
          "ADAPTER_ARGUMENT_INVALID",
          "provider usage falls outside the attempt's signed reconciliation window"
        );
      }
      const stored = await substrate.read({
        namespace: PROVIDER_USAGE_NAMESPACE,
        key
      });
      // Once recorded, a usage answer is final. Re-observing could turn an
      // `unknown` that a release already held budget for into a cost, which
      // would retroactively invalidate that release.
      if (stored !== null) return stored.body as EngineeringProviderUsage;

      const observed = await options.observer.observe({
        reservation: input.reservation,
        attempt: input.attempt,
        now
      });
      if (observed !== null) {
        // An observation outside the attempt's signed bounds is a real overrun,
        // not an unknown. Recording it as unknown would hide it, and recording
        // it as settled would produce evidence the caller must reject, so the
        // adapter refuses and leaves the attempt unresolved.
        if (
          !Number.isSafeInteger(observed.actualCostUnits) ||
          observed.actualCostUnits < 0 ||
          observed.actualCostUnits > input.attempt.phaseBudget ||
          observed.actualCalls !== 1 ||
          !Number.isSafeInteger(observed.actualTokens) ||
          observed.actualTokens < 0 ||
          observed.actualTokens > input.attempt.tokenBudget ||
          !DIGEST_PATTERN.test(observed.providerUsageDigest)
        ) {
          refuse(
            "ADAPTER_ARGUMENT_INVALID",
            "observed provider usage is malformed or exceeds its signed attempt"
          );
        }
      }
      const payload =
        observed === null
          ? {
              attemptDigest,
              phase: input.attempt.phase,
              status: "unknown" as const,
              actualCostUnits: null,
              actualCalls: null,
              actualTokens: null,
              providerUsageDigest: null,
              observedAt: now
            }
          : {
              attemptDigest,
              phase: input.attempt.phase,
              status: "settled" as const,
              actualCostUnits: observed.actualCostUnits,
              actualCalls: observed.actualCalls,
              actualTokens: observed.actualTokens,
              providerUsageDigest: observed.providerUsageDigest,
              observedAt: now
            };
      const usage: EngineeringProviderUsage = {
        ...payload,
        signature: await sign(payload, "provider usage")
      };
      const record = await appendAndProve({
        substrate,
        namespace: PROVIDER_USAGE_NAMESPACE,
        key,
        body: usage,
        expectedSequence: null,
        // Content-addressed on the attempt digest: an identical answer already
        // recorded is the same answer.
        acceptExisting: true,
        onConflict: () =>
          refuse(
            "ADAPTER_CONFLICT",
            `provider usage ${key} is occupied by a different answer`
          )
      });
      return record.body as EngineeringProviderUsage;
    }
  };
}
