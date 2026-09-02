/**
 * The only module in this repository that imports `node:sqlite`.
 *
 * Everything else depends on the `DurableSubstrate` interface in
 * `src/durable-substrate.ts`, so the concrete engine can be replaced without
 * touching an adapter or a test assertion. `node:sqlite` is a Node built-in, so
 * this adds no dependency; it is a release-candidate API, which is precisely why
 * it is confined here and gated at `open` (see `assertSupportedRuntime`).
 *
 * Nonproduction. This is a local reference store for the pre-App sandbox. It
 * handles no GitHub App credential, performs no network call, reads no
 * environment variable, and has no default path: the caller supplies an exact
 * absolute path or the substrate refuses.
 *
 * Concurrency rule enforced throughout: a transaction is opened with
 * `BEGIN IMMEDIATE` and closed in the same synchronous run. `DatabaseSync` is
 * synchronous, so no `await` may appear between `BEGIN IMMEDIATE` and
 * `COMMIT`/`ROLLBACK` — an interleaved microtask there would let another
 * operation observe a half-open transaction. Callers that need an async signer
 * must sign before entering a write.
 */

import { DatabaseSync, backup as sqliteBackup } from "node:sqlite";
import { isAbsolute } from "node:path";

import { digest } from "./canonical.js";
import type { Digest } from "./types.js";
import {
  DurableAmbiguousAcknowledgementError,
  DurableSubstrateError,
  assertCapacity,
  assertChainState,
  assertDigest,
  assertKey,
  canonicalBytes,
  chainHead,
  decodeCanonicalBytes,
  refuse,
  type DurableBackupManifest,
  type DurableHead,
  type DurableRecord,
  type DurableStoreInventory,
  type DurableStoreMetadata,
  type DurableSubstrate,
  type DurableWriteOutcome
} from "./durable-substrate.js";

/**
 * Bumped only by a deliberate, reviewed change to the on-disk shape. An older
 * or newer file refuses to open; there is no silent upgrade, because a
 * best-effort read of an unknown layout is exactly how durable evidence gets
 * silently corrupted.
 */
export const DURABLE_STORE_FORMAT_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS durable_meta(
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  store_id        TEXT NOT NULL,
  store_namespace TEXT NOT NULL,
  max_entries     INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS durable_head(
  namespace   TEXT PRIMARY KEY,
  sequence    INTEGER NOT NULL,
  head        TEXT,
  entry_count INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS durable_record(
  namespace     TEXT NOT NULL,
  key           TEXT NOT NULL,
  sequence      INTEGER NOT NULL,
  previous_head TEXT,
  head          TEXT NOT NULL,
  body_digest   TEXT NOT NULL,
  body          BLOB NOT NULL,
  PRIMARY KEY(namespace, key)
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS durable_record_sequence
  ON durable_record(namespace, sequence);
`;

/**
 * Recognizes a SQLite "database is locked"/"database is busy" condition.
 * `node:sqlite` surfaces these as `ERR_SQLITE_ERROR` carrying the primary
 * result codes 5 (`SQLITE_BUSY`) and 6 (`SQLITE_LOCKED`).
 */
function isBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const candidate = error as { readonly errcode?: unknown; readonly code?: unknown };
  if (candidate.errcode === 5 || candidate.errcode === 6) return true;
  return (
    candidate.code === "ERR_SQLITE_ERROR" &&
    /database is (locked|busy)/iu.test(error.message)
  );
}

/**
 * Translates a `node:sqlite` driver error into this substrate's refusal
 * taxonomy. Every substrate failure must carry an exact code: callers branch on
 * the taxonomy, so a raw engine error would be reported as an unexpected
 * internal fault instead of, say, a recognizable corrupt store.
 */
function translateOpenError(error: unknown, path: string): never {
  if (error instanceof DurableSubstrateError) throw error;
  const errcode = (error as { readonly errcode?: unknown }).errcode;
  const message = error instanceof Error ? error.message : String(error);
  if (errcode === 26 || errcode === 11) {
    refuse("STORE_CORRUPT", `durable store at ${path} is not a valid database: ${message}`);
  }
  if (errcode === 14) {
    refuse("STORE_PATH_INVALID", `durable store at ${path} could not be opened: ${message}`);
  }
  if (errcode === 5 || errcode === 6) {
    refuse("STORE_UNAVAILABLE", `durable store at ${path} was locked: ${message}`);
  }
  throw error;
}

/**
 * Normalizes a driver's reported affected-row count. `node:sqlite` types
 * `changes` as `number | bigint`; anything other than exactly zero or one rows
 * from a single-row conditional write means the statement did not do what this
 * substrate assumes, so it refuses instead of coercing. This lives with the
 * driver rather than in the neutral seam because the `number | bigint` shape is
 * a `node:sqlite` detail.
 */
export function normalizeChanges(
  changes: number | bigint,
  label: string
): 0 | 1 {
  if (changes === 0 || changes === 0n) return 0;
  if (changes === 1 || changes === 1n) return 1;
  refuse("STORE_CORRUPT", `${label} affected ${String(changes)} rows, expected 0 or 1`);
}

/**
 * Recognizes a uniqueness violation on the journal's `(namespace, sequence)`
 * index. This is the last line of defence against a rolled-back or otherwise
 * inconsistent head: the head claims a sequence the journal has already used,
 * so the insert would overwrite existing history. The index refuses it, and
 * this converts the driver error into an exact typed refusal instead of
 * letting a raw engine error escape the substrate's error taxonomy.
 */
function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /UNIQUE constraint failed/iu.test(error.message)
  );
}

interface HeadRow {
  readonly sequence: number;
  readonly head: string | null;
  readonly entry_count: number;
}

interface RecordRow {
  readonly namespace: string;
  readonly key: string;
  readonly sequence: number;
  readonly previous_head: string | null;
  readonly head: string;
  readonly body_digest: string;
  readonly body: Uint8Array;
}

export interface DurableSqliteOpenOptions {
  /** Exact absolute filesystem path. No default, no directory creation. */
  readonly path: string;
  /** Logical store identity, supplied by the caller's deployment binding. */
  readonly storeId: string;
  /** Backend namespace from the deployment plan's store identity. */
  readonly storeNamespace: string;
  /** Store-wide journal bound from the plan's `boundedJournal.maxEntries`. */
  readonly maxEntries: number;
  /** Milliseconds a write waits for a competing process's write lock. */
  readonly busyTimeoutMs: number;
  /**
   * Supported Node major versions, supplied by the caller from the repository
   * compatibility matrix so this module does not carry a second, divergent
   * copy of that list.
   */
  readonly supportedNodeMajors: readonly number[];
}

/**
 * Refuses unless the running runtime both *is* a supported major and actually
 * *behaves* as this substrate requires.
 *
 * Two gates, because they catch different failures. The version gate catches an
 * unsupported runtime. The capability probe catches a supported runtime whose
 * `node:sqlite` surface moved underneath us — the real risk of depending on a
 * release-candidate API. A version string alone cannot detect that.
 *
 * `process.versions` is runtime introspection, not configuration; this reads no
 * environment variable and there is no fallback path on failure.
 */
export function assertSupportedRuntime(supportedNodeMajors: readonly number[]): void {
  if (supportedNodeMajors.length === 0) {
    refuse("ARGUMENT_INVALID", "supportedNodeMajors must not be empty");
  }
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "", 10);
  if (!Number.isSafeInteger(major) || !supportedNodeMajors.includes(major)) {
    refuse(
      "RUNTIME_UNSUPPORTED",
      `Node ${process.versions.node} is not one of the supported majors ${supportedNodeMajors.join(", ")}`
    );
  }
  if (typeof sqliteBackup !== "function") {
    refuse("RUNTIME_UNSUPPORTED", "node:sqlite does not expose backup()");
  }

  let probe: DatabaseSync;
  try {
    probe = new DatabaseSync(":memory:");
  } catch {
    refuse("RUNTIME_UNSUPPORTED", "node:sqlite DatabaseSync is not constructible");
  }
  try {
    probe.exec("PRAGMA journal_mode = WAL");
    probe.exec("PRAGMA synchronous = FULL");
    probe.exec("PRAGMA user_version = 1");
    const userVersion = probe.prepare("PRAGMA user_version").get() as
      | { readonly user_version?: unknown }
      | undefined;
    if (userVersion?.user_version !== 1) {
      refuse("RUNTIME_UNSUPPORTED", "node:sqlite does not honour PRAGMA user_version");
    }
    const integrity = probe.prepare("PRAGMA integrity_check").get() as
      | { readonly integrity_check?: unknown }
      | undefined;
    if (integrity?.integrity_check !== "ok") {
      refuse("RUNTIME_UNSUPPORTED", "node:sqlite does not report integrity_check");
    }
    probe.exec("CREATE TABLE probe(k TEXT PRIMARY KEY, v INTEGER NOT NULL) STRICT");
    probe.exec("INSERT INTO probe VALUES('a', 0)");
    const hit = probe.prepare("UPDATE probe SET v = 1 WHERE k = 'a' AND v = 0").run();
    const miss = probe.prepare("UPDATE probe SET v = 2 WHERE k = 'a' AND v = 0").run();
    if (normalizeChanges(hit.changes, "probe hit") !== 1) {
      refuse("RUNTIME_UNSUPPORTED", "node:sqlite conditional update did not report a hit");
    }
    if (normalizeChanges(miss.changes, "probe miss") !== 0) {
      refuse("RUNTIME_UNSUPPORTED", "node:sqlite conditional update did not report a miss");
    }
    const blob = probe.prepare("SELECT CAST(? AS BLOB) AS b").get(new Uint8Array([1, 2])) as
      | { readonly b?: unknown }
      | undefined;
    if (!(blob?.b instanceof Uint8Array)) {
      refuse("RUNTIME_UNSUPPORTED", "node:sqlite does not round-trip BLOB values");
    }
  } finally {
    probe.close();
  }
}

export function openDurableSqliteSubstrate(
  options: DurableSqliteOpenOptions
): DurableSubstrate {
  assertSupportedRuntime(options.supportedNodeMajors);

  if (typeof options.path !== "string" || options.path.length === 0) {
    refuse("STORE_PATH_INVALID", "durable store path must be a non-empty string");
  }
  if (!isAbsolute(options.path)) {
    refuse("STORE_PATH_INVALID", "durable store path must be absolute");
  }
  if (options.path.includes("\0")) {
    refuse("STORE_PATH_INVALID", "durable store path must not contain a NUL byte");
  }
  if (
    !Number.isSafeInteger(options.busyTimeoutMs) ||
    options.busyTimeoutMs < 0
  ) {
    refuse("ARGUMENT_INVALID", "busyTimeoutMs must be a non-negative safe integer");
  }
  const storeId = assertKey(options.storeId, "storeId");
  const storeNamespace = assertKey(options.storeNamespace, "storeNamespace");
  assertCapacity({
    storeId,
    storeEntryCount: 0,
    maxEntries: options.maxEntries
  });

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(options.path, { timeout: options.busyTimeoutMs });
  } catch (error) {
    translateOpenError(error, options.path);
  }

  try {
    // Order matters. `PRAGMA journal_mode = WAL` needs an exclusive lock, so it
    // must never be the statement that runs while the busy timeout is still the
    // default of zero — otherwise a concurrently-writing process makes this
    // open fail instantly instead of waiting. The constructor `timeout` option
    // above applies the busy timeout before any statement runs; setting the
    // pragma here as well keeps the value explicit and asserted below.
    db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs}`);
    const appliedTimeout = db.prepare("PRAGMA busy_timeout").get() as
      | { readonly timeout?: unknown }
      | undefined;
    if (Number(appliedTimeout?.timeout ?? -1) !== options.busyTimeoutMs) {
      refuse(
        "STORE_UNAVAILABLE",
        "durable store did not apply the requested busy timeout"
      );
    }
    db.exec("PRAGMA journal_mode = WAL");
    // Read WAL back on the real file. The open-time capability probe runs
    // against `:memory:`, where SQLite silently keeps `memory` mode, so this is
    // the only place the WAL guarantee this substrate depends on is confirmed.
    const journalMode = db.prepare("PRAGMA journal_mode").get() as
      | { readonly journal_mode?: unknown }
      | undefined;
    if (String(journalMode?.journal_mode).toLowerCase() !== "wal") {
      refuse(
        "STORE_UNAVAILABLE",
        `durable store did not enter WAL mode (got ${String(journalMode?.journal_mode)})`
      );
    }
    db.exec("PRAGMA synchronous = FULL");
    db.exec("PRAGMA foreign_keys = ON");

    const integrity = db.prepare("PRAGMA integrity_check").get() as
      | { readonly integrity_check?: unknown }
      | undefined;
    if (integrity?.integrity_check !== "ok") {
      refuse(
        "STORE_CORRUPT",
        `durable store failed integrity_check: ${String(integrity?.integrity_check)}`
      );
    }

    // First-open provisioning is check-then-act — "is this file already
    // initialized?" followed by "if not, create it". An optimistic, lock-free
    // read of `user_version` handles the overwhelmingly common case, a store
    // that is already provisioned, exactly as before: no write lock is taken
    // to open an existing store. Only when that optimistic read finds
    // `user_version = 0` does this reach for the same cross-process write
    // lock every other write in this module uses, because a lock-free read
    // alone cannot distinguish "genuinely new" from "another process is
    // creating it right now". Without that lock, two independent processes
    // opening the same absent file both read `user_version = 0` before either
    // could write, and both proceed to `INSERT INTO durable_meta`, which has
    // an `id = 1` primary key: exactly one wins and the other leaks a raw
    // `UNIQUE constraint failed: durable_meta.id` driver error.
    const optimisticVersion = db.prepare("PRAGMA user_version").get() as
      | { readonly user_version?: unknown }
      | undefined;
    if (Number(optimisticVersion?.user_version ?? 0) !== 0) {
      const existing = Number(optimisticVersion?.user_version);
      if (existing !== DURABLE_STORE_FORMAT_VERSION) {
        refuse(
          "STORE_FORMAT_MISMATCH",
          `durable store format ${existing} is not the supported format ${DURABLE_STORE_FORMAT_VERSION}`
        );
      }
    } else {
      // The optimistic read saw an uninitialized file. `BEGIN IMMEDIATE`
      // serializes every such opener against this exact race: a loser blocks
      // until the winner commits, then re-reads `user_version` *inside its
      // own transaction* and observes the winner's already-committed
      // metadata, taking the validation branch below instead of the creation
      // branch. No blind retry, no partial metadata — schema creation, the
      // format pragma, and the identity row land in one atomic transaction,
      // so a real crash between them is rolled back on the next open exactly
      // like any other interrupted write. Two racers requesting conflicting
      // identities, namespaces, or bounds converge the same way: whichever
      // commits first settles the durable identity, and every other racer's
      // re-read below takes the same identity-mismatch refusal path an
      // ordinary reopen would.
      try {
        db.exec("BEGIN IMMEDIATE");
      } catch (error) {
        if (isBusyError(error)) {
          refuse(
            "STORE_UNAVAILABLE",
            `durable store write lock was unavailable while opening ${options.path}`
          );
        }
        throw error;
      }
      try {
        const versionRow = db.prepare("PRAGMA user_version").get() as
          | { readonly user_version?: unknown }
          | undefined;
        const existing = Number(versionRow?.user_version ?? 0);
        if (existing === 0) {
          db.exec(SCHEMA);
          db.exec(`PRAGMA user_version = ${DURABLE_STORE_FORMAT_VERSION}`);
          try {
            db.prepare(
              "INSERT INTO durable_meta(id, store_id, store_namespace, max_entries) VALUES(1, ?, ?, ?)"
            ).run(storeId, storeNamespace, options.maxEntries);
          } catch (error) {
            if (isUniqueConstraintError(error)) {
              // Defence in depth only: `BEGIN IMMEDIATE` above already
              // serializes every concurrent opener against this exact race,
              // so this should be unreachable. If it is ever reached anyway,
              // refuse with a typed code rather than let a raw driver error
              // escape the taxonomy.
              refuse(
                "STORE_CORRUPT",
                `durable store at ${options.path} reported user_version 0 but already carries identity metadata`
              );
            }
            throw error;
          }
        } else if (existing !== DURABLE_STORE_FORMAT_VERSION) {
          // Another process created the store between this process's
          // optimistic read and its acquiring the write lock, and did so
          // under an unsupported format.
          refuse(
            "STORE_FORMAT_MISMATCH",
            `durable store format ${existing} is not the supported format ${DURABLE_STORE_FORMAT_VERSION}`
          );
        }
        try {
          db.exec("COMMIT");
        } catch (error) {
          // The commit was attempted, so whether the schema and identity
          // landed is genuinely unknown — this is the one place guessing
          // would be wrong in both directions, exactly as for a write's
          // commit ambiguity. Roll back best-effort first: if the commit did
          // not land this releases the write lock and discards the open
          // transaction; if it did land there is nothing to roll back and
          // this fails harmlessly. Either way the caller must reopen fresh to
          // reconcile — unlike a write, an open has no caller-visible key to
          // reread, but retrying the open is always safe because the
          // reopened transaction re-derives the same outcome from whatever is
          // actually durable.
          try {
            db.exec("ROLLBACK");
          } catch {
            // Expected when the commit actually landed. Never mask the
            // ambiguity.
          }
          throw new DurableAmbiguousAcknowledgementError(
            storeNamespace,
            storeId,
            `durable store creation acknowledgement is ambiguous: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      } catch (error) {
        if (!(error instanceof DurableAmbiguousAcknowledgementError)) {
          try {
            db.exec("ROLLBACK");
          } catch {
            // A rollback failure must not mask the original refusal.
          }
        }
        // An ambiguous acknowledgement has already rolled back at the commit
        // boundary; a second attempt here would only raise a spurious error.
        throw error;
      }
    }

    // The durable identity is authoritative. Reopening the same file under a
    // different store id, backend namespace, or journal bound is a binding
    // error, not something to silently adopt from the caller.
    const meta = db
      .prepare(
        "SELECT store_id, store_namespace, max_entries FROM durable_meta WHERE id = 1"
      )
      .get() as
      | {
          readonly store_id?: unknown;
          readonly store_namespace?: unknown;
          readonly max_entries?: unknown;
        }
      | undefined;
    if (meta === undefined) {
      refuse("STORE_CORRUPT", "durable store carries no identity metadata");
    }
    if (meta.store_id !== storeId) {
      refuse(
        "STORE_BINDING_INVALID",
        `durable store at this path belongs to ${String(meta.store_id)}, not ${storeId}`
      );
    }
    if (meta.store_namespace !== storeNamespace) {
      refuse(
        "STORE_BINDING_INVALID",
        `durable store ${storeId} was created with backend namespace ${String(meta.store_namespace)}, not ${storeNamespace}`
      );
    }
    if (Number(meta.max_entries) !== options.maxEntries) {
      refuse(
        "STORE_BINDING_INVALID",
        `durable store ${storeId} was created with a ${String(meta.max_entries)}-entry bound, not ${options.maxEntries}`
      );
    }
  } catch (error) {
    db.close();
    translateOpenError(error, options.path);
  }

  const selectHead = db.prepare(
    "SELECT sequence, head, entry_count FROM durable_head WHERE namespace = ?"
  );
  const selectRecord = db.prepare(
    "SELECT namespace, key, sequence, previous_head, head, body_digest, body FROM durable_record WHERE namespace = ? AND key = ?"
  );
  const selectBySequence = db.prepare(
    "SELECT namespace, key, sequence, previous_head, head, body_digest, body FROM durable_record WHERE namespace = ? AND sequence = ?"
  );
  const selectChain = db.prepare(
    "SELECT namespace, key, sequence, previous_head, head, body_digest, body FROM durable_record WHERE namespace = ? ORDER BY sequence ASC"
  );
  const insertRecord = db.prepare(
    "INSERT INTO durable_record(namespace, key, sequence, previous_head, head, body_digest, body) VALUES(?, ?, ?, ?, ?, ?, ?)"
  );
  const insertHead = db.prepare(
    "INSERT INTO durable_head(namespace, sequence, head, entry_count) VALUES(?, ?, ?, ?)"
  );
  const updateHead = db.prepare(
    "UPDATE durable_head SET sequence = ?, head = ?, entry_count = ? WHERE namespace = ? AND sequence = ? AND entry_count = ?"
  );
  const countEntries = db.prepare(
    "SELECT COUNT(*) AS total FROM durable_record"
  );
  const listNamespaces = db.prepare(
    "SELECT namespace, sequence, head, entry_count FROM durable_head ORDER BY namespace ASC"
  );

  function headOf(namespace: string): DurableHead {
    const row = selectHead.get(namespace) as HeadRow | undefined;
    if (row === undefined) {
      return { namespace, sequence: 0, head: null, entryCount: 0 };
    }
    const head = row.head === null ? null : assertDigest(row.head, "stored head");
    assertChainState(row.sequence, head, `namespace ${namespace}`);
    // `entry_count` is not covered by the hash chain, so it must be checked
    // explicitly: by construction it always equals `sequence`, and a desynced
    // value would otherwise be invisible to every integrity check.
    if (
      !Number.isSafeInteger(row.entry_count) ||
      row.entry_count !== row.sequence
    ) {
      refuse(
        "CHAIN_INVALID",
        `namespace ${namespace} entry count ${String(row.entry_count)} does not match sequence ${row.sequence}`
      );
    }
    return {
      namespace,
      sequence: row.sequence,
      head,
      entryCount: row.entry_count
    };
  }

  function materialize(row: RecordRow): DurableRecord {
    const head = assertDigest(row.head, "stored record head");
    const bodyDigest = assertDigest(row.body_digest, "stored body digest");
    const previousHead =
      row.previous_head === null
        ? null
        : assertDigest(row.previous_head, "stored previous head");
    const body = decodeCanonicalBytes(row.body, bodyDigest, row.namespace, row.key);
    const expected = chainHead({
      namespace: row.namespace,
      key: row.key,
      sequence: row.sequence,
      previousHead,
      bodyDigest
    });
    if (expected !== head) {
      refuse(
        "CHAIN_INVALID",
        `record ${row.namespace}/${row.key} head does not match its chain link`
      );
    }
    // Sequence 1 is genesis and must have no predecessor; every later record
    // must have one. Checking this here means a single `read()` detects a
    // forged predecessor, not only a full `verifyChain()`.
    if ((row.sequence === 1) !== (previousHead === null)) {
      refuse(
        "CHAIN_INVALID",
        `record ${row.namespace}/${row.key} at sequence ${row.sequence} has an inconsistent predecessor`
      );
    }
    return {
      namespace: row.namespace,
      key: row.key,
      sequence: row.sequence,
      previousHead,
      head,
      bodyDigest,
      body
    };
  }

  function inventoryOf(connection: DatabaseSync): DurableStoreInventory {
    const identity = connection
      .prepare(
        "SELECT store_id, store_namespace, max_entries FROM durable_meta WHERE id = 1"
      )
      .get() as
      | {
          readonly store_id?: unknown;
          readonly store_namespace?: unknown;
          readonly max_entries?: unknown;
        }
      | undefined;
    if (
      identity?.store_id !== storeId ||
      identity.store_namespace !== storeNamespace ||
      Number(identity.max_entries) !== options.maxEntries
    ) {
      refuse(
        "STORE_CORRUPT",
        "durable store inventory does not carry the source store identity"
      );
    }
    const userVersion = connection.prepare("PRAGMA user_version").get() as
      | { readonly user_version?: unknown }
      | undefined;
    if (userVersion?.user_version !== DURABLE_STORE_FORMAT_VERSION) {
      refuse(
        "STORE_FORMAT_MISMATCH",
        "durable store inventory has an unsupported format version"
      );
    }
    const integrity = connection.prepare("PRAGMA integrity_check").get() as
      | { readonly integrity_check?: unknown }
      | undefined;
    if (integrity?.integrity_check !== "ok") {
      refuse("STORE_CORRUPT", "durable store inventory failed integrity_check");
    }

    const heads = connection
      .prepare(
        "SELECT namespace, sequence, head, entry_count FROM durable_head ORDER BY namespace ASC"
      )
      .all() as unknown as (HeadRow & { readonly namespace: string })[];
    const selectInventoryChain = connection.prepare(
      "SELECT namespace, key, sequence, previous_head, head, body_digest, body FROM durable_record WHERE namespace = ? ORDER BY sequence ASC"
    );
    let entryCount = 0;
    const namespaces = heads.map((row) => {
      const head = row.head === null ? null : assertDigest(row.head, "inventory head");
      assertChainState(row.sequence, head, `namespace ${row.namespace}`);
      const records = selectInventoryChain.all(row.namespace) as unknown as RecordRow[];
      let previousHead: Digest | null = null;
      for (const [index, recordRow] of records.entries()) {
        const record = materialize(recordRow);
        if (
          record.sequence !== index + 1 ||
          record.previousHead !== previousHead
        ) {
          refuse(
            "CHAIN_INVALID",
            `namespace ${row.namespace} inventory does not form one contiguous chain`
          );
        }
        previousHead = record.head;
      }
      if (
        row.sequence !== records.length ||
        row.entry_count !== records.length ||
        head !== previousHead
      ) {
        refuse(
          "CHAIN_INVALID",
          `namespace ${row.namespace} inventory head does not match its journal`
        );
      }
      entryCount += records.length;
      return {
        namespace: row.namespace,
        sequence: row.sequence,
        head,
        entryCount: row.entry_count
      };
    });
    const totalRow = connection
      .prepare("SELECT COUNT(*) AS total FROM durable_record")
      .get() as { readonly total?: unknown } | undefined;
    if (Number(totalRow?.total ?? -1) !== entryCount) {
      refuse(
        "CHAIN_INVALID",
        "durable store inventory count does not match its namespace journals"
      );
    }
    if (entryCount > options.maxEntries) {
      refuse(
        "CAPACITY_EXHAUSTED",
        `durable store ${storeId} contains ${String(entryCount)} entries above its ${String(options.maxEntries)}-entry bound`
      );
    }
    return Object.freeze({
      storeId,
      storeNamespace,
      maxEntries: options.maxEntries,
      formatVersion: DURABLE_STORE_FORMAT_VERSION,
      namespaces: Object.freeze(namespaces),
      entryCount
    });
  }

  function readRecord(namespace: string, key: string): DurableRecord | null {
    const row = selectRecord.get(namespace, key) as RecordRow | undefined;
    return row === undefined ? null : materialize(row);
  }

  /**
   * Performs the single durable write.
   *
   * Runs entirely synchronously between `BEGIN IMMEDIATE` and `COMMIT`. The
   * expected-head re-check happens *inside* the transaction, so a head that
   * moved after the caller's optimistic read yields `conflict` rather than a
   * lost update.
   */
  function write(input: {
    readonly namespace: string;
    readonly key: string;
    readonly body: unknown;
    readonly mode: "append-once" | "compare-and-swap";
    readonly expectedHead: Digest | null;
  }): DurableWriteOutcome {
    const bytes = canonicalBytes(input.body);
    const bodyDigest = digest(input.body);

    // Acquire the cross-process write lock before anything else. A busy timeout
    // that expires here means the transaction never opened and nothing was
    // written, so this is an unambiguous no-op refusal rather than an ambiguous
    // acknowledgement — the caller may safely retry.
    try {
      db.exec("BEGIN IMMEDIATE");
    } catch (error) {
      if (isBusyError(error)) {
        refuse(
          "STORE_UNAVAILABLE",
          `durable store write lock was unavailable for ${input.namespace}/${input.key}`
        );
      }
      throw error;
    }

    try {
      const current = headOf(input.namespace);
      const existing = readRecord(input.namespace, input.key);

      if (existing !== null) {
        db.exec("ROLLBACK");
        // Byte-identical replay is `existing`; anything else under the same key
        // is a conflict. A looser comparison here would let a mutated replay
        // satisfy a caller's idempotency check.
        // `existing` must mean "my write already landed", not merely "some
        // identical write landed". A genuine retry after an ambiguous
        // acknowledgement replays its original expected head, which equals the
        // stored record's predecessor; a caller fencing against a head that was
        // never in this chain gets `conflict`.
        const sameWrite =
          existing.bodyDigest === bodyDigest &&
          (input.mode !== "compare-and-swap" ||
            existing.previousHead === input.expectedHead);
        return sameWrite
          ? { status: "existing", record: existing }
          : { status: "conflict", record: null };
      }

      if (input.mode === "compare-and-swap" && current.head !== input.expectedHead) {
        db.exec("ROLLBACK");
        return { status: "conflict", record: null };
      }

      const totalRow = countEntries.get() as { readonly total?: unknown } | undefined;
      assertCapacity({
        storeId,
        storeEntryCount: Number(totalRow?.total ?? 0),
        maxEntries: options.maxEntries
      });

      const sequence = current.sequence + 1;
      const head = chainHead({
        namespace: input.namespace,
        key: input.key,
        sequence,
        previousHead: current.head,
        bodyDigest
      });

      try {
        insertRecord.run(
          input.namespace,
          input.key,
          sequence,
          current.head,
          head,
          bodyDigest,
          bytes
        );
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          refuse(
            "CHAIN_INVALID",
            `namespace ${input.namespace} head claims sequence ${current.sequence} but the journal already holds sequence ${sequence}`
          );
        }
        throw error;
      }

      if (current.sequence === 0 && current.entryCount === 0) {
        insertHead.run(input.namespace, sequence, head, 1);
      } else {
        const changed = updateHead.run(
          sequence,
          head,
          current.entryCount + 1,
          input.namespace,
          current.sequence,
          current.entryCount
        );
        if (normalizeChanges(changed.changes, "durable head update") !== 1) {
          db.exec("ROLLBACK");
          return { status: "conflict", record: null };
        }
      }

      try {
        db.exec("COMMIT");
      } catch (error) {
        // The commit was attempted, so the durable outcome is genuinely
        // unknown: the transaction may have landed before the failure. This is
        // the one place where guessing would be wrong in both directions, so it
        // is surfaced as ambiguity for the caller to reconcile against a stable
        // reread rather than reported as success or failure.
        //
        // Roll back first, unconditionally and best-effort. If the commit did
        // not land, this releases the write lock and discards the open
        // transaction; leaving it open would make same-handle reads observe
        // uncommitted rows, block every other writer until this handle closed,
        // and make the next write fail with a raw "cannot start a transaction
        // within a transaction". If the commit did land, there is no
        // transaction to roll back and this fails harmlessly. Either way the
        // outcome stays ambiguous — the rollback resolves connection state, not
        // the question of what was durably written.
        try {
          db.exec("ROLLBACK");
        } catch {
          // Expected when the commit actually landed. Never mask the ambiguity.
        }
        throw new DurableAmbiguousAcknowledgementError(
          input.namespace,
          input.key,
          `durable commit acknowledgement is ambiguous: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
      return {
        status: "appended",
        record: {
          namespace: input.namespace,
          key: input.key,
          sequence,
          previousHead: current.head,
          head,
          bodyDigest,
          body: input.body
        }
      };
    } catch (error) {
      if (!(error instanceof DurableAmbiguousAcknowledgementError)) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // A rollback failure must not mask the original refusal.
        }
      }
      // An ambiguous acknowledgement has already rolled back at the commit
      // boundary; a second attempt here would only raise a spurious error.
      throw error;
    }
  }

  const metadata: DurableStoreMetadata = Object.freeze({
    storeId,
    storeNamespace,
    maxEntries: options.maxEntries,
    formatVersion: DURABLE_STORE_FORMAT_VERSION
  });

  return {
    metadata,

    async appendOnce(input) {
      return write({
        namespace: assertKey(input.namespace, "namespace"),
        key: assertKey(input.key, "key"),
        body: input.body,
        mode: "append-once",
        expectedHead: null
      });
    },

    async compareAndSwap(input) {
      const expectedHead =
        input.expectedHead === null
          ? null
          : assertDigest(input.expectedHead, "expectedHead");
      return write({
        namespace: assertKey(input.namespace, "namespace"),
        key: assertKey(input.key, "key"),
        body: input.body,
        mode: "compare-and-swap",
        expectedHead
      });
    },

    async read(input) {
      return readRecord(
        assertKey(input.namespace, "namespace"),
        assertKey(input.key, "key")
      );
    },

    async readHead(namespace) {
      return headOf(assertKey(namespace, "namespace"));
    },

    async readCurrent(namespace) {
      const ns = assertKey(namespace, "namespace");
      const head = headOf(ns);
      if (head.head === null) {
        return { head, record: null };
      }
      const row = selectBySequence.get(ns, head.sequence) as RecordRow | undefined;
      if (row === undefined) {
        refuse(
          "CHAIN_INVALID",
          `namespace ${ns} head claims sequence ${head.sequence} but no such record exists`
        );
      }
      const record = materialize(row);
      if (record.head !== head.head) {
        refuse(
          "CHAIN_INVALID",
          `namespace ${ns} head does not match the record at its sequence`
        );
      }
      return { head, record };
    },

    async verifyChain(namespace) {
      const ns = assertKey(namespace, "namespace");
      // Pin one read snapshot. Reading the journal and the head as two
      // autocommit statements lets a concurrent write land between them and
      // produces a false CHAIN_INVALID on an intact store.
      db.exec("BEGIN DEFERRED");
      let rows: RecordRow[];
      let current: DurableHead;
      try {
        rows = selectChain.all(ns) as unknown as RecordRow[];
        current = headOf(ns);
      } finally {
        // Close the read snapshot without letting this mask an in-flight
        // refusal: `headOf` can raise CHAIN_INVALID, and an exception thrown
        // from a `finally` would replace it with a less specific error. Nothing
        // was written, so ending the read transaction cannot lose data.
        try {
          db.exec("COMMIT");
        } catch {
          try {
            db.exec("ROLLBACK");
          } catch {
            // Read-only transaction: nothing to preserve either way.
          }
        }
      }
      const records: DurableRecord[] = [];
      let previous: Digest | null = null;
      let expectedSequence = 1;
      for (const row of rows) {
        const record = materialize(row);
        if (record.sequence !== expectedSequence) {
          refuse(
            "CHAIN_INVALID",
            `namespace ${ns} has a sequence gap at ${record.sequence}`
          );
        }
        if (record.previousHead !== previous) {
          refuse(
            "CHAIN_INVALID",
            `namespace ${ns} entry ${record.sequence} does not chain to its predecessor`
          );
        }
        previous = record.head;
        expectedSequence += 1;
        records.push(record);
      }
      if (
        current.sequence !== records.length ||
        current.entryCount !== records.length ||
        current.head !== previous
      ) {
        refuse("CHAIN_INVALID", `namespace ${ns} head does not match its journal`);
      }
      return records;
    },

    async inventory() {
      db.exec("BEGIN DEFERRED");
      try {
        return inventoryOf(db);
      } finally {
        try {
          db.exec("COMMIT");
        } catch {
          try {
            db.exec("ROLLBACK");
          } catch {
            // Read-only transaction: nothing to preserve either way.
          }
        }
      }
    },

    async backup(destinationPath) {
      if (typeof destinationPath !== "string" || !isAbsolute(destinationPath)) {
        refuse("STORE_PATH_INVALID", "backup destination path must be absolute");
      }
      await sqliteBackup(db, destinationPath);

      // The manifest describes the backup *copy*, read back after the copy
      // completes. Reading heads from the live store beforehand would let a
      // concurrent write make the manifest describe state the copy does not
      // contain.
      const copy = new DatabaseSync(destinationPath, { readOnly: true });
      try {
        const inventory = inventoryOf(copy);
        const manifest: DurableBackupManifest = {
          apiVersion: "agentic-framework.github.com/v1alpha1",
          kind: "DurableStoreBackupManifest",
          schemaVersion: "1.0.0",
          storeId,
          storeNamespace,
          formatVersion: DURABLE_STORE_FORMAT_VERSION,
          namespaces: inventory.namespaces,
          entryCount: inventory.entryCount,
          nonAuthoritative: true
        };
        return manifest;
      } finally {
        copy.close();
      }
    },

    close() {
      db.close();
    }
  };
}
