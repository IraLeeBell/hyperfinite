/**
 * Durable adapter for the domain operation-grant claim port.
 *
 * This maps `DomainOperationGrantStore` (`src/domain-packs.ts`) onto the merged
 * durable substrate (ADR 0014) using the `operation-grant-store`
 * identity fixed by the pre-App deployment contract (ADR 0013).
 * Per ADR 0014's normative mapping the primitive is `appendOnce`.
 *
 * Authority note: this adapter is mechanism. It mints no authority, chooses no
 * target, resolves no credential, reads no environment variable, opens no
 * network client, and has no default path. The grant itself is produced and
 * verified by the caller in `src/domain-git-packager.ts`; all this module does
 * is decide — durably, atomically, and exactly once — whether one operation slot
 * may be occupied, and then record the claim the caller will re-authenticate.
 *
 * ## Why the fence is the substrate key, not a pre-check
 *
 * The port carries an explicit compare-and-swap: `expectedPreviousHead` and
 * `expectedStoreSequence`. The caller cannot detect a lost fence, because
 * `#validGrantClaim` checks the *body* fields this adapter writes, so two
 * concurrent claims that both merely pre-checked the head would both be signed
 * asserting store position `n + 1`, and the caller would accept both.
 *
 * The fence is therefore the append key itself: a claim that fences on store
 * sequence `n` writes to slot `claim.<n + 1>`. `appendOnce` is atomic and
 * cross-process, so exactly one racing claim occupies that slot and every other
 * one is refused. This keeps ADR 0014's `appendOnce` mapping while making the
 * fence real rather than advisory, and it holds the invariant that slot
 * `claim.<k>` is always the record at substrate sequence `k`, which is asserted
 * on every read.
 *
 * ## Why a refusal is `null` and not an exception
 *
 * `claim` is typed `Promise<DomainOperationGrantClaim | null>`, and its caller
 * treats `null` as "the authorization was not atomically claimed". Every
 * *decided* refusal — a moved head, a replayed redemption key, a re-used
 * operation slot, a lost race — is therefore `null`. Only an undecided or
 * broken store throws, because reporting a corrupt store as a clean refusal
 * would hide it.
 *
 * Nonproduction: this is a local reference adapter for the pre-App sandbox.
 */

import { canonicalJson, digest } from "./canonical.js";
import type { DurableStoreId } from "./deployment-topology.js";
import type {
  DomainAuthorizedOperation,
  DomainDetachedSignature,
  DomainEvidenceSigner,
  DomainOperationGrantClaim,
  DomainOperationGrantStore,
  DomainOperationGrantStoreHead
} from "./domain-packs.js";
import {
  DurableAmbiguousAcknowledgementError,
  type DurableRecord,
  type DurableSubstrate
} from "./durable-substrate.js";
import type { Digest } from "./types.js";
import { assertDocument, validateDocument } from "./validation.js";

/** The store identity this adapter binds to, fixed by ADR 0013's closed set. */
export const DOMAIN_OPERATION_GRANT_STORE_ID: DurableStoreId =
  "operation-grant-store";

/**
 * The logical namespace inside that store. One namespace holds the whole claim
 * chain, so the substrate's own sequence *is* the port's `storeSequence` and
 * the two can never disagree.
 */
export const DOMAIN_OPERATION_GRANT_NAMESPACE = "domain.operation-grant-claims";

const STORE_ID_PATTERN = /^[a-z0-9]+(?:[._:-][a-z0-9]+)*$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

/** Matches the `storeId` bound `DomainGitPackager` enforces on construction. */
const STORE_ID_MAX_LENGTH = 128;

export type DurableDomainStoreRefusalCode =
  | "ADAPTER_ARGUMENT_INVALID"
  | "ADAPTER_BINDING_INVALID"
  | "ADAPTER_RECORD_INVALID"
  | "ADAPTER_OUTPUT_INVALID"
  | "ADAPTER_ACKNOWLEDGEMENT_AMBIGUOUS";

/**
 * An adapter-level refusal. Distinct from `DurableSubstrateError` so a caller
 * can tell "the store is broken" from "this adapter refused to emit evidence it
 * could not stand behind".
 */
export class DurableDomainStoreError extends Error {
  constructor(
    readonly code: DurableDomainStoreRefusalCode,
    message: string
  ) {
    super(message);
    this.name = "DurableDomainStoreError";
  }
}

function refuse(code: DurableDomainStoreRefusalCode, message: string): never {
  throw new DurableDomainStoreError(code, message);
}

/**
 * An injected clock. The adapter never reads an ambient one: every timestamp it
 * writes must be attributable to the same trusted clock the caller validates
 * against.
 */
export interface DurableDomainClock {
  now(): string;
}

export interface DurableDomainOperationGrantStoreOptions {
  /** A substrate already opened for the `operation-grant-store` binding. */
  readonly substrate: DurableSubstrate;
  /** The logical store id the caller will pass on every call. */
  readonly storeId: string;
  readonly clock: DurableDomainClock;
  readonly signer: DomainEvidenceSigner;
  /**
   * How long a signed store-head observation stays valid. Explicit and
   * required: a default here would be this module inventing a freshness policy
   * the deployment contract never granted it.
   */
  readonly headValidityMs: number;
}

/** The slot a claim fencing on store sequence `n` must occupy. */
function slotKey(storeSequence: number): string {
  return `claim.${String(storeSequence)}`;
}

function assertTimestamp(value: string, label: string): string {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) {
    refuse(
      "ADAPTER_ARGUMENT_INVALID",
      `${label} must be an ISO-8601 UTC timestamp`
    );
  }
  return value;
}

function assertDigestArgument(value: string, label: string): Digest {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    refuse("ADAPTER_ARGUMENT_INVALID", `${label} must be a sha256 digest`);
  }
  return value as Digest;
}

function millisecondsOf(value: string, label: string): number {
  const parsed = Date.parse(assertTimestamp(value, label));
  if (!Number.isSafeInteger(parsed)) {
    refuse("ADAPTER_ARGUMENT_INVALID", `${label} is not a representable instant`);
  }
  return parsed;
}

/**
 * Projects a stored body back into a claim, refusing anything that is not
 * exactly the closed contract document this adapter wrote.
 *
 * A stored record is bytes, not authority: it is re-validated against the
 * published schema and its own recomputed head before it is allowed to
 * influence the next claim's fence.
 */
function decodeClaim(record: DurableRecord): DomainOperationGrantClaim {
  const result = validateDocument("DomainOperationGrantClaim", record.body);
  if (!result.valid) {
    refuse(
      "ADAPTER_RECORD_INVALID",
      `stored operation grant claim at sequence ${String(record.sequence)} is not a valid document: ${result.errors.join("; ")}`
    );
  }
  const claim = result.value;
  if (claim.storeSequence !== record.sequence) {
    refuse(
      "ADAPTER_RECORD_INVALID",
      `stored claim asserts store sequence ${String(claim.storeSequence)} at substrate sequence ${String(record.sequence)}`
    );
  }
  if (claim.head !== recomputeClaimHead(claim)) {
    refuse(
      "ADAPTER_RECORD_INVALID",
      `stored claim at sequence ${String(record.sequence)} does not match its own recomputed head`
    );
  }
  return claim;
}

/**
 * The head the caller recomputes in `#validGrantClaim`: the claim without its
 * signature and without the head field itself. Recomputing it here rather than
 * trusting the stored value is what makes a rewritten record detectable at the
 * adapter boundary rather than three layers up.
 */
function recomputeClaimHead(claim: DomainOperationGrantClaim): Digest {
  const { signature: _signature, head: _head, ...payload } = claim;
  return digest(payload);
}

/**
 * Reads the current chain position: the substrate sequence, which is the port's
 * `storeSequence`, together with the caller-shaped head the last claim
 * published.
 *
 * The two heads are deliberately different things. The substrate's chain head
 * covers the stored bytes; the port's head is the claim's own signed
 * `head` field. This adapter must return the latter, because that is what the
 * caller fences on and re-derives.
 */
async function readPosition(
  substrate: DurableSubstrate
): Promise<{ readonly storeSequence: number; readonly head: Digest | null }> {
  const current = await substrate.readCurrent(DOMAIN_OPERATION_GRANT_NAMESPACE);
  if (current.record === null) {
    if (current.head.sequence !== 0 || current.head.head !== null) {
      refuse(
        "ADAPTER_RECORD_INVALID",
        "operation grant chain reports a non-genesis head with no record"
      );
    }
    return { storeSequence: 0, head: null };
  }
  const claim = decodeClaim(current.record);
  return { storeSequence: current.head.sequence, head: claim.head };
}

/**
 * Resolves an ambiguous acknowledgement the way ADR 0014 requires: by reading
 * the slot twice through the substrate and demanding one stable answer.
 *
 * A single read could observe a write that is still settling; two identical
 * reads are the evidence that the durable state has stopped moving. Anything
 * else stays ambiguous and is refused rather than guessed in either direction.
 */
async function rereadSlotStably(
  substrate: DurableSubstrate,
  key: string
): Promise<DurableRecord | null> {
  const first = await substrate.read({
    namespace: DOMAIN_OPERATION_GRANT_NAMESPACE,
    key
  });
  const second = await substrate.read({
    namespace: DOMAIN_OPERATION_GRANT_NAMESPACE,
    key
  });
  const firstBytes = first === null ? null : canonicalJson(first.body);
  const secondBytes = second === null ? null : canonicalJson(second.body);
  if (firstBytes !== secondBytes) {
    refuse(
      "ADAPTER_ACKNOWLEDGEMENT_AMBIGUOUS",
      `operation grant slot ${key} did not resolve to one stable record`
    );
  }
  return second;
}

/**
 * Binds `DomainOperationGrantStore` to a durable substrate.
 *
 * Nothing is cached between calls. Every decision is taken against durable
 * state read at that moment, which is what makes the adapter correct across a
 * restart and across two processes rather than only within one object's
 * lifetime.
 */
export function openDurableDomainOperationGrantStore(
  options: DurableDomainOperationGrantStoreOptions
): DomainOperationGrantStore {
  const substrate = options.substrate;
  const boundStoreId = options.storeId;

  if (
    typeof boundStoreId !== "string" ||
    !STORE_ID_PATTERN.test(boundStoreId) ||
    boundStoreId.length > STORE_ID_MAX_LENGTH
  ) {
    refuse(
      "ADAPTER_BINDING_INVALID",
      "operation grant storeId must be a bounded lower-case logical name"
    );
  }
  // The substrate carries its plan-derived identity durably. Binding the
  // domain grant port to any other store would let operation-grant evidence be
  // written into, say, the receipt journal, silently collapsing the store
  // isolation ADR 0013 asserts.
  if (substrate.metadata.storeId !== DOMAIN_OPERATION_GRANT_STORE_ID) {
    refuse(
      "ADAPTER_BINDING_INVALID",
      `domain operation grant claims require the ${DOMAIN_OPERATION_GRANT_STORE_ID}, not ${substrate.metadata.storeId}`
    );
  }
  // The logical id the adapter signs into every head and claim must be the
  // store's own durable identity. Accepting any syntactically valid alias would
  // let this adapter emit authentic-looking evidence under a name ADR 0013's
  // closed store set never defined, which a correspondingly misconfigured
  // caller would accept.
  if (boundStoreId !== substrate.metadata.storeId) {
    refuse(
      "ADAPTER_BINDING_INVALID",
      `storeId ${boundStoreId} is not the durable identity of the store it is bound to`
    );
  }
  if (
    !Number.isSafeInteger(options.headValidityMs) ||
    options.headValidityMs < 1
  ) {
    refuse(
      "ADAPTER_BINDING_INVALID",
      "head validity must be a positive safe integer number of milliseconds"
    );
  }

  function assertBoundStore(storeId: string): void {
    if (storeId !== boundStoreId) {
      refuse(
        "ADAPTER_ARGUMENT_INVALID",
        `storeId ${storeId} is not the bound operation grant store ${boundStoreId}`
      );
    }
  }

  function sign(
    payload: unknown,
    purpose: string
  ): DomainDetachedSignature {
    const signature = options.signer.sign(payload, purpose);
    if (
      signature === null ||
      typeof signature !== "object" ||
      signature.algorithm !== "ed25519" ||
      typeof signature.keyId !== "string" ||
      signature.keyId.length === 0 ||
      typeof signature.value !== "string" ||
      signature.value.length === 0
    ) {
      refuse(
        "ADAPTER_OUTPUT_INVALID",
        `${purpose} signer returned an unusable detached signature`
      );
    }
    return signature;
  }

  return {
    async readHead(input): Promise<DomainOperationGrantStoreHead> {
      assertBoundStore(input.storeId);
      const challenge = assertDigestArgument(input.challenge, "challenge");

      const position = await readPosition(substrate);
      const observedAt = assertTimestamp(options.clock.now(), "clock.now()");
      const expiresAt = new Date(
        millisecondsOf(observedAt, "observedAt") + options.headValidityMs
      ).toISOString();

      const payload = {
        purpose: "domain-operation-grant-store-head" as const,
        storeId: boundStoreId,
        storeSequence: position.storeSequence,
        challenge,
        head: position.head,
        observedAt,
        expiresAt
      };
      // The head must satisfy the caller's exact chain-state rule before it is
      // signed. Signing first and discovering the inconsistency later would put
      // a signature on evidence this adapter cannot stand behind.
      if (
        (payload.storeSequence === 0) !== (payload.head === null) ||
        !Number.isSafeInteger(payload.storeSequence) ||
        payload.storeSequence < 0
      ) {
        refuse(
          "ADAPTER_OUTPUT_INVALID",
          "operation grant store head chain state is inconsistent"
        );
      }
      const head: DomainOperationGrantStoreHead = {
        ...payload,
        signature: sign(payload, "domain-operation-grant-store-head")
      };
      // Validate the adapter's own output against the published schema, so a
      // malformed document is this adapter's refusal rather than an
      // unexplained caller-side rejection.
      return assertDocument("DomainOperationGrantStoreHead", head);
    },

    async claim(input): Promise<DomainOperationGrantClaim | null> {
      assertBoundStore(input.storeId);
      const claimChallenge = assertDigestArgument(
        input.claimChallenge,
        "claimChallenge"
      );
      const grantDigest = assertDigestArgument(input.grantDigest, "grantDigest");
      const redemptionKey = assertDigestArgument(
        input.redemptionKey,
        "redemptionKey"
      );
      const contextDigest = assertDigestArgument(
        input.contextDigest,
        "contextDigest"
      );
      const repositoryIdentityDigest = assertDigestArgument(
        input.repositoryIdentityDigest,
        "repositoryIdentityDigest"
      );
      const expectedPreviousHead =
        input.expectedPreviousHead === null
          ? null
          : assertDigestArgument(
              input.expectedPreviousHead,
              "expectedPreviousHead"
            );
      const grantCheckedAt = assertTimestamp(
        input.grantCheckedAt,
        "grantCheckedAt"
      );
      const grantExpiresAt = assertTimestamp(
        input.grantExpiresAt,
        "grantExpiresAt"
      );
      if (
        !Number.isSafeInteger(input.expectedStoreSequence) ||
        input.expectedStoreSequence < 0 ||
        input.expectedStoreSequence >= Number.MAX_SAFE_INTEGER ||
        !Number.isSafeInteger(input.runAttempt) ||
        input.runAttempt < 0 ||
        !Number.isSafeInteger(input.operationSequence) ||
        input.operationSequence < 0 ||
        typeof input.runId !== "string" ||
        input.runId.length === 0
      ) {
        refuse(
          "ADAPTER_ARGUMENT_INVALID",
          "operation grant claim carries an out-of-range sequence, attempt, or run id"
        );
      }
      if ((input.expectedStoreSequence === 0) !== (expectedPreviousHead === null)) {
        refuse(
          "ADAPTER_ARGUMENT_INVALID",
          "expected store sequence and expected previous head disagree about genesis"
        );
      }

      // Optimistic fence read. This is not the atomicity mechanism — the slot
      // key is — but it lets a stale caller be refused without writing.
      const position = await readPosition(substrate);
      if (
        position.storeSequence !== input.expectedStoreSequence ||
        position.head !== expectedPreviousHead
      ) {
        return null;
      }

      // Replay refusal is a property of the whole chain, not of one slot, so it
      // is decided against the verified journal. Reading it here is safe
      // precisely because the write is fenced to the slot that follows the head
      // this scan ends at: any claim that landed first moves the head and takes
      // the slot, and any claim that lands later is scanned by *its* own call.
      const chain = await substrate.verifyChain(DOMAIN_OPERATION_GRANT_NAMESPACE);
      for (const record of chain) {
        const stored = decodeClaim(record);
        // A redemption key may be spent exactly once. Returning the stored
        // claim instead would hand a caller a second, independently valid
        // receipt for one redemption, which is the whole failure this store
        // exists to prevent.
        if (stored.redemptionKey === redemptionKey) return null;
        // The same operation slot may not be claimed twice under a different
        // redemption key either; that would be one authorized operation
        // redeemed as two.
        if (
          stored.runId === input.runId &&
          stored.runAttempt === input.runAttempt &&
          stored.operationSequence === input.operationSequence
        ) {
          return null;
        }
      }

      const claimedAt = assertTimestamp(options.clock.now(), "clock.now()");
      if (
        millisecondsOf(claimedAt, "claimedAt") <
          millisecondsOf(grantCheckedAt, "grantCheckedAt") ||
        millisecondsOf(claimedAt, "claimedAt") >=
          millisecondsOf(grantExpiresAt, "grantExpiresAt")
      ) {
        // The caller re-checks this window too, but emitting a signed claim
        // that is already outside its own grant would be this adapter
        // manufacturing invalid evidence and leaving a permanent record of it.
        refuse(
          "ADAPTER_OUTPUT_INVALID",
          "operation grant claim time is outside the grant window"
        );
      }

      const storeSequence = input.expectedStoreSequence + 1;
      const payload = {
        purpose: "domain-operation-grant-claim" as const,
        storeId: boundStoreId,
        storeSequence,
        claimChallenge,
        casResult: "appended" as const,
        grantDigest,
        redemptionKey,
        operation: input.operation as DomainAuthorizedOperation,
        contextDigest,
        repositoryIdentityDigest,
        runId: input.runId,
        runAttempt: input.runAttempt,
        operationSequence: input.operationSequence,
        grantCheckedAt,
        claimedAt,
        grantExpiresAt,
        previousHead: expectedPreviousHead
      };
      const unsigned = { ...payload, head: digest(payload) };
      const claim: DomainOperationGrantClaim = {
        ...unsigned,
        signature: sign(unsigned, "domain-operation-grant-claim")
      };
      // Everything is signed *before* the write. The substrate's transaction is
      // synchronous and forbids an await between BEGIN IMMEDIATE and COMMIT, so
      // a signer may never be invoked inside it.
      const validated = assertDocument("DomainOperationGrantClaim", claim);

      const key = slotKey(storeSequence);
      try {
        const outcome = await substrate.appendOnce({
          namespace: DOMAIN_OPERATION_GRANT_NAMESPACE,
          key,
          body: validated
        });
        // Only a direct `appended` means *this* invocation won the slot.
        //
        // `existing` means the slot is already occupied by byte-identical
        // bytes somebody else wrote. Treating that as success would hand two
        // callers the same store position and the same signed receipt, which
        // is precisely the double-redemption this store exists to prevent. A
        // genuine retry of our own write reaches the ambiguity path below
        // instead, where the outcome really is ours to reconcile.
        if (outcome.status !== "appended") return null;
      } catch (error) {
        if (!(error instanceof DurableAmbiguousAcknowledgementError)) throw error;
        // The commit was attempted and its outcome is unknown. Resolve it
        // against durable state instead of guessing.
        const settled = await rereadSlotStably(substrate, key);
        if (
          settled === null ||
          canonicalJson(settled.body) !== canonicalJson(validated)
        ) {
          // Decidably absent, or decidably somebody else's record. Either way
          // this claim did not land, which is a refusal rather than a fault.
          return null;
        }
        // The slot holds exactly these bytes, and that is still not proof this
        // invocation won it: a concurrent caller submitting byte-identical
        // bytes could have landed while this write rolled back, and the record
        // carries nothing that tells the two apart. Returning the claim would
        // issue a second valid receipt for one store position, so the outcome
        // is reported as what it is — undecided.
        refuse(
          "ADAPTER_ACKNOWLEDGEMENT_AMBIGUOUS",
          `operation grant slot ${key} holds this claim's bytes but its authorship is undecided`
        );
      }

      // Independent durable postcondition proof.
      //
      // The port's return value is not itself evidence that anything was
      // stored, so the adapter re-reads the slot and requires the durable bytes
      // to be exactly the claim it signed, at exactly the fenced sequence.
      // Without this, a substrate that reported success while writing something
      // else would be indistinguishable from one that worked.
      const persisted = await substrate.read({
        namespace: DOMAIN_OPERATION_GRANT_NAMESPACE,
        key
      });
      if (
        persisted === null ||
        persisted.sequence !== storeSequence ||
        canonicalJson(persisted.body) !== canonicalJson(validated)
      ) {
        refuse(
          "ADAPTER_OUTPUT_INVALID",
          `operation grant claim at ${key} is not durably present as written`
        );
      }
      return validated;
    }
  };
}
