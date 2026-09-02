/**
 * Provider-neutral durable substrate for the local reference trust services.
 *
 * This module is the seam. It declares the two primitives every trust-service
 * store port in this repository reduces to — an idempotent `appendOnce` and an
 * exact `compareAndSwap` — plus the canonical-bytes, hash-chain, and bounded
 * journal rules those primitives must obey. It deliberately imports no backend:
 * `src/durable-sqlite-substrate.ts` is the only module that binds a concrete
 * engine, so a different durable backend can be substituted without touching a
 * single adapter or test assertion.
 *
 * Authority note: nothing here is authority. A substrate stores exact bytes a
 * trusted caller already produced and returns exact bytes back. It never signs,
 * never mints, never reads a clock, never chooses a target, and never repairs a
 * record. Contract semantics stay in the existing callers, which re-validate
 * every returned receipt against their own recomputed digest.
 */

import { canonicalJson, digest } from "./canonical.js";
import type { Digest } from "./types.js";

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

/** Namespace/slot key shape. Opaque logical names only — never a path or secret. */
const KEY_PATTERN = /^[a-z0-9]+(?:[._:-][a-z0-9]+)*$/u;

/** Maximum journal entries any single namespace may retain. */
export const DURABLE_JOURNAL_MAX_ENTRIES = 512;

/**
 * Outcome trichotomy shared by every store port in this repository.
 *
 * - `appended` — this call durably created the record.
 * - `existing` — an identical record was already durably present. This requires
 *   byte-identical canonical bytes; see `DurableWriteOutcome` for why.
 * - `conflict` — the key or slot is occupied by different bytes, or the
 *   supplied expected head no longer matches.
 */
export type DurableWriteStatus = "appended" | "existing" | "conflict";

export interface DurableRecord {
  readonly namespace: string;
  readonly key: string;
  readonly sequence: number;
  readonly previousHead: Digest | null;
  readonly head: Digest;
  readonly bodyDigest: Digest;
  readonly body: unknown;
}

export interface DurableWriteOutcome {
  readonly status: DurableWriteStatus;
  readonly record: DurableRecord | null;
}

export interface DurableHead {
  readonly namespace: string;
  readonly sequence: number;
  readonly head: Digest | null;
  readonly entryCount: number;
}

export type DurableRefusalCode =
  | "RUNTIME_UNSUPPORTED"
  | "STORE_PATH_INVALID"
  | "STORE_FORMAT_MISMATCH"
  | "STORE_CORRUPT"
  | "STORE_BINDING_INVALID"
  | "STORE_UNAVAILABLE"
  | "CHAIN_INVALID"
  | "CAPACITY_EXHAUSTED"
  | "ARGUMENT_INVALID";

/**
 * Every substrate failure is a refusal with an exact code. There is no
 * degraded mode, no repair path, and no success-shaped fallback.
 */
export class DurableSubstrateError extends Error {
  constructor(
    readonly code: DurableRefusalCode,
    message: string
  ) {
    super(message);
    this.name = "DurableSubstrateError";
  }
}

/**
 * Raised when a write's durable outcome cannot be determined — for example a
 * commit whose acknowledgement was lost. This is a distinct state, never
 * collapsed into success or failure. Callers in this repository already
 * reconcile it by reading the record twice and requiring one stable,
 * authenticated answer (see `reconcileAmbiguousClaim` in
 * `src/demo-activation.ts`), which is why the substrate guarantees a stable
 * reread rather than guessing on the caller's behalf.
 */
export class DurableAmbiguousAcknowledgementError extends Error {
  constructor(
    readonly namespace: string,
    readonly key: string,
    message = "durable write acknowledgement is ambiguous"
  ) {
    super(message);
    this.name = "DurableAmbiguousAcknowledgementError";
  }
}

export function refuse(code: DurableRefusalCode, message: string): never {
  throw new DurableSubstrateError(code, message);
}

/** Matches the `logicalName` bound published by the durable-store schemas. */
export const DURABLE_LOGICAL_NAME_MAX_LENGTH = 128;

export function assertKey(value: string, label: string): string {
  if (typeof value !== "string" || !KEY_PATTERN.test(value)) {
    refuse(
      "ARGUMENT_INVALID",
      `${label} must be a lower-case dotted/dashed logical name`
    );
  }
  // Bounded to match the published schemas, so an exported record or manifest
  // can never fail validation against its own contract.
  if (value.length > DURABLE_LOGICAL_NAME_MAX_LENGTH) {
    refuse(
      "ARGUMENT_INVALID",
      `${label} must be at most ${DURABLE_LOGICAL_NAME_MAX_LENGTH} characters`
    );
  }
  return value;
}

export function assertDigest(value: string, label: string): Digest {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    refuse("ARGUMENT_INVALID", `${label} must be a sha256 digest`);
  }
  return value as Digest;
}

/**
 * Canonical bytes for a body. Digests in this repository are taken over
 * `canonicalJson`, so the stored bytes are exactly the bytes the digest
 * covers — a corrupted or truncated row therefore cannot re-derive its
 * recorded digest.
 */
export function canonicalBytes(body: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(body));
}

export function decodeCanonicalBytes(
  bytes: Uint8Array,
  expected: Digest,
  namespace: string,
  key: string
): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    refuse("STORE_CORRUPT", `stored bytes for ${namespace}/${key} are not valid UTF-8`);
  }
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    refuse("STORE_CORRUPT", `stored bytes for ${namespace}/${key} are not valid JSON`);
  }
  if (canonicalJson(body) !== text) {
    refuse(
      "STORE_CORRUPT",
      `stored bytes for ${namespace}/${key} are not canonical`
    );
  }
  if (digest(body) !== expected) {
    refuse(
      "STORE_CORRUPT",
      `stored bytes for ${namespace}/${key} do not match the recorded digest`
    );
  }
  return body;
}

/**
 * The chain link for one journal entry. `head` covers the predecessor, so an
 * inserted, reordered, dropped, or rewritten entry cannot preserve the chain.
 */
export function chainHead(input: {
  readonly namespace: string;
  readonly key: string;
  readonly sequence: number;
  readonly previousHead: Digest | null;
  readonly bodyDigest: Digest;
}): Digest {
  return digest({
    namespace: input.namespace,
    key: input.key,
    sequence: input.sequence,
    previousHead: input.previousHead,
    bodyDigest: input.bodyDigest
  });
}

/**
 * Genesis is `(sequence 0, head null)`. Any positive sequence must carry a
 * non-null head, and sequence zero must carry a null head. Both impossible
 * combinations are rejected rather than normalized — this mirrors the exact
 * store-head state rule already required by ADR 0008 and enforced against
 * `DomainOperationGrantStoreHead`.
 */
export function assertChainState(
  sequence: number,
  head: Digest | null,
  label: string
): void {
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    refuse("CHAIN_INVALID", `${label} sequence must be a non-negative safe integer`);
  }
  if (sequence === 0 && head !== null) {
    refuse("CHAIN_INVALID", `${label} genesis must carry a null head`);
  }
  if (sequence > 0 && head === null) {
    refuse("CHAIN_INVALID", `${label} positive sequence must carry a non-null head`);
  }
}

/**
 * A bounded journal refuses when full; it never evicts. Silently dropping the
 * oldest entry would break the hash chain and destroy exactly the replay
 * evidence the journal exists to hold, so exhaustion is a refusal the operator
 * must resolve.
 *
 * The bound is **store-wide**, not per-namespace. The deployment contract
 * attaches `boundedJournal` to a durable *store*, so counting each logical
 * namespace separately would let a store with N namespaces hold N times the
 * entries its plan permits.
 */
export function assertCapacity(input: {
  readonly storeId: string;
  readonly storeEntryCount: number;
  readonly maxEntries: number;
}): void {
  if (!Number.isSafeInteger(input.maxEntries) || input.maxEntries < 1) {
    refuse("ARGUMENT_INVALID", "journal maxEntries must be a positive safe integer");
  }
  if (input.maxEntries > DURABLE_JOURNAL_MAX_ENTRIES) {
    refuse(
      "ARGUMENT_INVALID",
      `journal maxEntries ${input.maxEntries} exceeds the ${DURABLE_JOURNAL_MAX_ENTRIES} ceiling`
    );
  }
  if (input.storeEntryCount >= input.maxEntries) {
    refuse(
      "CAPACITY_EXHAUSTED",
      `durable store ${input.storeId} is at its ${input.maxEntries}-entry bound`
    );
  }
}

/**
 * The durable substrate contract.
 *
 * Implementations must provide cross-process atomicity: two independent
 * processes racing the same `appendOnce` key or the same `compareAndSwap`
 * expected head must produce exactly one `appended`, never two.
 */
/**
 * Identity and configuration a store carries durably, written when the store is
 * created and verified on every subsequent open.
 *
 * Persisting this is what makes the deployment binding authoritative rather
 * than advisory: without it, the same file could be reopened under a different
 * store id, backend namespace, or journal bound, and would then emit evidence
 * bearing whatever identity the caller happened to supply.
 */
export interface DurableStoreMetadata {
  readonly storeId: string;
  readonly storeNamespace: string;
  readonly maxEntries: number;
  readonly formatVersion: number;
}

export interface DurableStoreInventory extends DurableStoreMetadata {
  readonly namespaces: readonly {
    readonly namespace: string;
    readonly sequence: number;
    readonly head: Digest | null;
    readonly entryCount: number;
  }[];
  readonly entryCount: number;
}

/**
 * The durable substrate contract.
 *
 * Implementations must provide cross-process atomicity: two independent
 * processes racing the same `appendOnce` key or the same `compareAndSwap`
 * expected head must produce exactly one `appended`, never two.
 *
 * Note that no write takes a journal bound. The bound is fixed by the store's
 * durable metadata, so a caller cannot widen it per call.
 */
export interface DurableSubstrate {
  readonly metadata: DurableStoreMetadata;

  /**
   * Idempotent keyed append. Returns `existing` only when the stored canonical
   * bytes are byte-identical to `body`; any other stored value for the same key
   * is `conflict`. Returning `existing` for differing bytes would let a mutated
   * replay pass a caller's idempotency check, so the comparison is exact.
   */
  appendOnce(input: {
    readonly namespace: string;
    readonly key: string;
    readonly body: unknown;
  }): Promise<DurableWriteOutcome>;

  /**
   * Exact compare-and-swap against a namespace's current head. `expectedHead`
   * of `null` means "expect genesis". A head that has moved yields `conflict`;
   * the substrate never retries on the caller's behalf.
   */
  compareAndSwap(input: {
    readonly namespace: string;
    readonly key: string;
    readonly expectedHead: Digest | null;
    readonly body: unknown;
  }): Promise<DurableWriteOutcome>;

  /** Reads one record, re-deriving and checking its digest from stored bytes. */
  read(input: {
    readonly namespace: string;
    readonly key: string;
  }): Promise<DurableRecord | null>;

  /** Reads the current chain head for a namespace. */
  readHead(namespace: string): Promise<DurableHead>;

  /**
   * Reads the current head together with the record that produced it, in one
   * consistent view.
   *
   * Adapters need both to perform a read-modify-write: the head is the
   * compare-and-swap token and the record is the state being advanced. Exposing
   * only `readHead` would force an adapter to scan the journal to recover its
   * own current state, and reading them separately would make the pair
   * incoherent under concurrent writes.
   */
  readCurrent(namespace: string): Promise<{
    readonly head: DurableHead;
    readonly record: DurableRecord | null;
  }>;

  /** Verifies the whole chain for a namespace, entry by entry. */
  verifyChain(namespace: string): Promise<readonly DurableRecord[]>;

  /**
   * Returns one consistent, fully chain-verified inventory of every namespace.
   * Restore verification uses the exact namespace set, not only the namespaces
   * a caller-supplied manifest happens to name.
   */
  inventory(): Promise<DurableStoreInventory>;

  /**
   * Writes a consistent backup to an explicit absolute path and returns a
   * manifest describing the **backup copy**, read back from it after the copy
   * completes.
   */
  backup(destinationPath: string): Promise<DurableBackupManifest>;

  close(): void;
}

export interface DurableBackupManifest {
  readonly apiVersion: "agentic-framework.github.com/v1alpha1";
  readonly kind: "DurableStoreBackupManifest";
  readonly schemaVersion: "1.0.0";
  readonly storeId: string;
  readonly storeNamespace: string;
  readonly formatVersion: number;
  readonly namespaces: readonly {
    readonly namespace: string;
    readonly sequence: number;
    readonly head: Digest | null;
    readonly entryCount: number;
  }[];
  readonly entryCount: number;
  readonly nonAuthoritative: true;
}

/**
 * The serializable envelope for one journal entry.
 *
 * `bodyDigest` stands in for the body itself: the body is a caller-defined
 * contract document this substrate deliberately does not interpret, so exported
 * evidence commits to its digest rather than restating its shape. That keeps
 * this envelope closed and schema-checkable without the substrate acquiring an
 * opinion about any caller's contract.
 *
 * Non-authoritative: exporting a record proves what was stored, never that the
 * stored thing was authorized.
 */
export interface DurableStoreJournalRecord {
  readonly apiVersion: "agentic-framework.github.com/v1alpha1";
  readonly kind: "DurableStoreJournalRecord";
  readonly schemaVersion: "1.0.0";
  readonly storeId: string;
  readonly namespace: string;
  readonly key: string;
  readonly sequence: number;
  readonly previousHead: Digest | null;
  readonly head: Digest;
  readonly bodyDigest: Digest;
  readonly nonAuthoritative: true;
}

/**
 * Projects a stored record into its closed, schema-valid export envelope,
 * re-deriving the chain link so an export cannot state a head the record's own
 * fields do not produce.
 */
export function journalRecordDocument(
  storeId: string,
  record: DurableRecord
): DurableStoreJournalRecord {
  const expected = chainHead({
    namespace: record.namespace,
    key: record.key,
    sequence: record.sequence,
    previousHead: record.previousHead,
    bodyDigest: record.bodyDigest
  });
  if (expected !== record.head) {
    refuse(
      "CHAIN_INVALID",
      `record ${record.namespace}/${record.key} cannot be exported: head does not match its chain link`
    );
  }
  assertChainState(record.sequence, record.head, "exported record");
  return Object.freeze({
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "DurableStoreJournalRecord",
    schemaVersion: "1.0.0",
    storeId: assertKey(storeId, "storeId"),
    namespace: record.namespace,
    key: record.key,
    sequence: record.sequence,
    previousHead: record.previousHead,
    head: record.head,
    bodyDigest: record.bodyDigest,
    nonAuthoritative: true
  });
}
