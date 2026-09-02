/**
 * Restart continuity, backup/restore, ambiguity reconciliation, and
 * disabled-state recovery for the durable substrate.
 */

import assert from "node:assert/strict";
import { copyFileSync, existsSync, rmSync } from "node:fs";
import { test } from "node:test";

import { digest } from "../src/canonical.js";
import {
  DURABLE_JOURNAL_MAX_ENTRIES,
  DurableAmbiguousAcknowledgementError,
  DurableSubstrateError,
  journalRecordDocument,
  type DurableSubstrate
} from "../src/durable-substrate.js";
import { validateDocument } from "../src/validation.js";
import {
  DURABLE_STORE_FORMAT_VERSION,
  openDurableSqliteSubstrate
} from "../src/durable-sqlite-substrate.js";
import {
  BUSY_TIMEOUT_MS,
  SUPPORTED_NODE_MAJORS,
  temporaryStoreRoot
} from "./support/durable-substrate-harness.js";

function open(storePath: string): DurableSubstrate {
  return openDurableSqliteSubstrate({
    path: storePath,
    storeId: "receipt-journal",
    storeNamespace: "namespace-receipt-journal",
    maxEntries: 512,
    busyTimeoutMs: BUSY_TIMEOUT_MS,
    supportedNodeMajors: SUPPORTED_NODE_MAJORS
  });
}

function codeOf(error: unknown): string {
  assert.ok(error instanceof DurableSubstrateError, `expected refusal, got ${String(error)}`);
  return error.code;
}

// ---------------------------------------------------------------------------
// Restart continuity
// ---------------------------------------------------------------------------

test("reopening a store preserves head, sequence, and every record", async () => {
  const root = temporaryStoreRoot("restart");
  const file = root.pathFor("s.db");

  const before = open(file);
  let headBefore: string | null = null;
  try {
    for (const index of [1, 2, 3]) {
      await before.appendOnce({
        namespace: "journal",
        key: `k${index}`,
        body: { index }
      });
    }
    headBefore = (await before.readHead("journal")).head;
  } finally {
    before.close();
  }

  const after = open(file);
  try {
    const head = await after.readHead("journal");
    assert.equal(head.head, headBefore, "head must survive a restart unchanged");
    assert.equal(head.sequence, 3);
    assert.equal(head.entryCount, 3);

    const chain = await after.verifyChain("journal");
    assert.equal(chain.length, 3);
    assert.deepEqual(
      chain.map((record) => record.body),
      [{ index: 1 }, { index: 2 }, { index: 3 }]
    );
  } finally {
    after.close();
    root.cleanup();
  }
});

test("a replay after restart is still recognized as existing, not appended twice", async () => {
  const root = temporaryStoreRoot("restart-replay");
  const file = root.pathFor("s.db");

  const before = open(file);
  try {
    await before.appendOnce({
      namespace: "claims",
      key: "k1",
      body: { claim: "a" }
    });
  } finally {
    before.close();
  }

  const after = open(file);
  try {
    const replay = await after.appendOnce({
      namespace: "claims",
      key: "k1",
      body: { claim: "a" }
    });
    assert.equal(replay.status, "existing");
    assert.equal((await after.readHead("claims")).sequence, 1);
  } finally {
    after.close();
    root.cleanup();
  }
});

test("a held compare-and-swap slot is not silently re-winnable after restart", async () => {
  const root = temporaryStoreRoot("restart-fence");
  const file = root.pathFor("s.db");

  const before = open(file);
  let head: string | null = null;
  try {
    const acquired = await before.compareAndSwap({
      namespace: "fence",
      key: "f1",
      expectedHead: null,
      body: { holder: "worker-a", state: "held" }
    });
    assert.equal(acquired.status, "appended");
    head = acquired.record?.head ?? null;
  } finally {
    before.close();
  }

  const after = open(file);
  try {
    // A restarted process that still believes the fence is at genesis must not
    // be able to re-acquire it.
    const stolen = await after.compareAndSwap({
      namespace: "fence",
      key: "f2",
      expectedHead: null,
      body: { holder: "worker-b", state: "held" }
    });
    assert.equal(stolen.status, "conflict", "a held fence must not be re-acquirable");

    // Only a process that observed the real current head may advance it.
    const released = await after.compareAndSwap({
      namespace: "fence",
      key: "f2",
      expectedHead: head as never,
      body: { holder: "worker-a", state: "released" }
    });
    assert.equal(released.status, "appended");
  } finally {
    after.close();
    root.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Ambiguity reconciliation
// ---------------------------------------------------------------------------

// The substrate's side of ambiguity reconciliation is the *stable reread*
// guarantee. The commit-fault test at the end of this file exercises the
// ambiguity path itself; these two only pin the reread property it depends on.
test("a written record rereads identically, which is what makes reconciliation possible", async () => {
  const root = temporaryStoreRoot("ambiguous");
  const file = root.pathFor("s.db");
  const store = open(file);
  try {
    const body = { claim: "a" };
    const written = await store.appendOnce({
      namespace: "claims",
      key: "k1",
      body
    });
    assert.equal(written.status, "appended");

    // A caller whose acknowledgement was lost reconciles by reading twice,
    // exactly as `reconcileAmbiguousClaim` does in src/demo-activation.ts.
    const first = await store.read({ namespace: "claims", key: "k1" });
    const second = await store.read({ namespace: "claims", key: "k1" });
    assert.notEqual(first, null);
    assert.equal(
      digest(first),
      digest(second),
      "reconciliation requires two identical reads"
    );
    assert.deepEqual(first?.body, body);
  } finally {
    store.close();
    root.cleanup();
  }
});

test("an absent record rereads as stably null, so a lost write is not read as success", async () => {
  const root = temporaryStoreRoot("ambiguous-absent");
  const store = open(root.pathFor("s.db"));
  try {
    const first = await store.read({ namespace: "claims", key: "never-written" });
    const second = await store.read({ namespace: "claims", key: "never-written" });
    assert.equal(first, null);
    assert.equal(second, null);
  } finally {
    store.close();
    root.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Backup and restore
// ---------------------------------------------------------------------------

test("backup produces a manifest and a restorable store", async () => {
  const root = temporaryStoreRoot("backup");
  const file = root.pathFor("s.db");
  const backupPath = root.pathFor("backup.db");

  const store = open(file);
  let headBefore: string | null = null;
  try {
    for (const index of [1, 2, 3]) {
      await store.appendOnce({
        namespace: "journal",
        key: `k${index}`,
        body: { index }
      });
    }
    headBefore = (await store.readHead("journal")).head;

    const manifest = await store.backup(backupPath);
    assert.equal(manifest.kind, "DurableStoreBackupManifest");
    assert.equal(manifest.schemaVersion, "1.0.0");
    assert.equal(manifest.storeId, "receipt-journal");
    assert.equal(manifest.formatVersion, DURABLE_STORE_FORMAT_VERSION);
    assert.equal(manifest.nonAuthoritative, true);
    assert.equal(manifest.entryCount, 3);
    assert.equal(manifest.storeNamespace, "namespace-receipt-journal");
    assert.deepEqual(manifest.namespaces, [
      { namespace: "journal", sequence: 3, head: headBefore, entryCount: 3 }
    ]);
  } finally {
    store.close();
  }

  assert.ok(existsSync(backupPath), "backup file must exist");

  const restored = open(backupPath);
  try {
    const chain = await restored.verifyChain("journal");
    assert.equal(chain.length, 3);
    assert.equal((await restored.readHead("journal")).head, headBefore);
  } finally {
    restored.close();
    root.cleanup();
  }
});

test("a restored copy accepts new writes that continue the chain", async () => {
  const root = temporaryStoreRoot("restore-continue");
  const file = root.pathFor("s.db");
  const backupPath = root.pathFor("backup.db");
  const restoredPath = root.pathFor("restored.db");

  const store = open(file);
  try {
    await store.appendOnce({
      namespace: "journal",
      key: "k1",
      body: { index: 1 }
    });
    await store.backup(backupPath);
  } finally {
    store.close();
  }

  copyFileSync(backupPath, restoredPath);
  const restored = open(restoredPath);
  try {
    const appended = await restored.appendOnce({
      namespace: "journal",
      key: "k2",
      body: { index: 2 }
    });
    assert.equal(appended.status, "appended");
    assert.equal(appended.record?.sequence, 2);

    const chain = await restored.verifyChain("journal");
    assert.equal(chain.length, 2);
    assert.equal(chain[1]?.previousHead, chain[0]?.head);
  } finally {
    restored.close();
    root.cleanup();
  }
});

test("a relative backup destination refuses", async () => {
  const root = temporaryStoreRoot("backup-path");
  const store = open(root.pathFor("s.db"));
  try {
    await assert.rejects(
      store.backup("relative/backup.db"),
      (error: unknown) => codeOf(error) === "STORE_PATH_INVALID"
    );
  } finally {
    store.close();
    root.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Disabled-state recovery
// ---------------------------------------------------------------------------

test("a removed store file is recreated empty rather than resurrecting stale records", async () => {
  const root = temporaryStoreRoot("disabled");
  const file = root.pathFor("s.db");

  const store = open(file);
  try {
    await store.appendOnce({
      namespace: "journal",
      key: "k1",
      body: { index: 1 }
    });
  } finally {
    store.close();
  }

  rmSync(file, { force: true });
  rmSync(`${file}-wal`, { force: true });
  rmSync(`${file}-shm`, { force: true });

  const recreated = open(file);
  try {
    const head = await recreated.readHead("journal");
    assert.equal(head.sequence, 0, "a recreated store must start at genesis");
    assert.equal(head.head, null);
    assert.equal(head.entryCount, 0);
    assert.equal(await recreated.read({ namespace: "journal", key: "k1" }), null);
  } finally {
    recreated.close();
    root.cleanup();
  }
});

test("a store whose journal is restored from backup refuses a mismatched format", async () => {
  const root = temporaryStoreRoot("disabled-format");
  const file = root.pathFor("s.db");
  const store = open(file);
  try {
    await store.appendOnce({
      namespace: "journal",
      key: "k1",
      body: { index: 1 }
    });
  } finally {
    store.close();
  }

  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(file);
  raw.exec(`PRAGMA user_version = ${DURABLE_STORE_FORMAT_VERSION + 7}`);
  raw.close();

  assert.throws(
    () => open(file),
    (error: unknown) => codeOf(error) === "STORE_FORMAT_MISMATCH"
  );
  root.cleanup();
});

// ---------------------------------------------------------------------------
// Journal tampering
//
// Each case edits the store out from under the substrate and asserts the
// tampering is detected rather than silently accepted. These are the attacks a
// hash-chained journal exists to catch.
// ---------------------------------------------------------------------------

async function seededStore(label: string): Promise<{
  readonly root: ReturnType<typeof temporaryStoreRoot>;
  readonly file: string;
}> {
  const root = temporaryStoreRoot(label);
  const file = root.pathFor("s.db");
  const store = open(file);
  try {
    for (const index of [1, 2, 3, 4]) {
      await store.appendOnce({
        namespace: "journal",
        key: `k${index}`,
        body: { index }
      });
    }
  } finally {
    store.close();
  }
  return { root, file };
}

async function mutate(file: string, statement: string): Promise<void> {
  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(file);
  raw.exec(statement);
  raw.close();
}

test("a deleted middle record breaks the chain and is detected", async () => {
  const { root, file } = await seededStore("tamper-middle");
  await mutate(file, "DELETE FROM durable_record WHERE namespace='journal' AND sequence=2");
  const store = open(file);
  try {
    await assert.rejects(
      store.verifyChain("journal"),
      (error: unknown) => codeOf(error) === "CHAIN_INVALID"
    );
  } finally {
    store.close();
    root.cleanup();
  }
});

test("a truncated journal tail is detected against the recorded head", async () => {
  const { root, file } = await seededStore("tamper-tail");
  await mutate(file, "DELETE FROM durable_record WHERE namespace='journal' AND sequence=4");
  const store = open(file);
  try {
    await assert.rejects(
      store.verifyChain("journal"),
      (error: unknown) => codeOf(error) === "CHAIN_INVALID"
    );
  } finally {
    store.close();
    root.cleanup();
  }
});

test("a rewritten record key no longer matches its chain link", async () => {
  const { root, file } = await seededStore("tamper-key");
  await mutate(
    file,
    "UPDATE durable_record SET key='rewritten' WHERE namespace='journal' AND sequence=2"
  );
  const store = open(file);
  try {
    await assert.rejects(
      store.verifyChain("journal"),
      (error: unknown) => codeOf(error) === "CHAIN_INVALID"
    );
  } finally {
    store.close();
    root.cleanup();
  }
});

test("a rolled-back head is detected instead of silently shortening history", async () => {
  const { root, file } = await seededStore("tamper-head");
  await mutate(
    file,
    "UPDATE durable_head SET sequence=2, entry_count=2 WHERE namespace='journal'"
  );
  const store = open(file);
  try {
    await assert.rejects(
      store.verifyChain("journal"),
      (error: unknown) => codeOf(error) === "CHAIN_INVALID"
    );
  } finally {
    store.close();
    root.cleanup();
  }
});

test("a rolled-back head cannot overwrite existing history on the next append", async () => {
  const { root, file } = await seededStore("tamper-clobber");
  await mutate(
    file,
    "UPDATE durable_head SET sequence=2, entry_count=2 WHERE namespace='journal'"
  );
  const store = open(file);
  try {
    // The write must fail as a typed refusal, not as a raw driver error, and
    // must not reuse an occupied sequence.
    await assert.rejects(
      store.appendOnce({
        namespace: "journal",
        key: "clobber",
        body: { evil: true }
      }),
      (error: unknown) => codeOf(error) === "CHAIN_INVALID"
    );

    // The record that occupied the contested sequence is untouched.
    const survivor = await store.read({ namespace: "journal", key: "k3" });
    assert.deepEqual(survivor?.body, { index: 3 });
    assert.equal(survivor?.sequence, 3);
  } finally {
    store.close();
    root.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Commit-phase ambiguity (fault injection)
//
// A refusal means the write definitely did not happen. A commit that fails
// after being attempted means the outcome is genuinely unknown, and must not be
// reported as either success or failure.
// ---------------------------------------------------------------------------

/**
 * Injects a fault at exactly the COMMIT boundary of the next write.
 * Returns a disposer that restores the driver.
 */
function injectCommitFailure(DatabaseSyncCtor: {
  prototype: { exec: (statement: string) => void };
}): { fired: () => boolean; restore: () => void } {
  const original = DatabaseSyncCtor.prototype.exec;
  let fired = false;
  DatabaseSyncCtor.prototype.exec = function patched(
    this: unknown,
    statement: string
  ): void {
    if (statement === "COMMIT" && !fired) {
      fired = true;
      throw new Error("simulated lost commit acknowledgement");
    }
    return original.call(this, statement);
  };
  return {
    fired: () => fired,
    restore: () => {
      DatabaseSyncCtor.prototype.exec = original;
    }
  };
}

test("a failing commit raises ambiguity and leaves no transaction open", async () => {
  const root = temporaryStoreRoot("ambiguous-commit");
  const file = root.pathFor("s.db");
  const store = open(file);
  const { DatabaseSync } = await import("node:sqlite");

  try {
    const fault = injectCommitFailure(DatabaseSync);
    try {
      await assert.rejects(
        store.appendOnce({ namespace: "claims", key: "k1", body: { claim: "a" } }),
        (error: unknown) => {
          assert.ok(
            error instanceof DurableAmbiguousAcknowledgementError,
            `expected ambiguity, got ${String(error)}`
          );
          assert.ok(!(error instanceof DurableSubstrateError));
          assert.equal(error.namespace, "claims");
          assert.equal(error.key, "k1");
          return true;
        }
      );
    } finally {
      fault.restore();
    }
    assert.ok(fault.fired(), "the commit fault must actually have fired");

    // 1. The cross-process write lock must have been released. A still-open
    //    transaction would block every other writer until this handle closed.
    const contender = new DatabaseSync(file);
    contender.exec("PRAGMA busy_timeout = 250");
    try {
      contender.exec("BEGIN IMMEDIATE");
      contender.exec("ROLLBACK");
    } catch (error) {
      assert.fail(
        `the write lock was not released after an ambiguous commit: ${String(error)}`
      );
    } finally {
      contender.close();
    }

    // 2. A subsequent write must produce a typed outcome, never a raw driver
    //    error such as "cannot start a transaction within a transaction".
    const next = await store.appendOnce({
      namespace: "claims",
      key: "k2",
      body: { claim: "b" }
    });
    assert.equal(next.status, "appended");

    // 3. The chain must still verify.
    const chain = await store.verifyChain("claims");
    assert.equal(chain.length, 1, "only the second write is durable");
  } finally {
    store.close();
  }

  // 4. Reconciliation must read through fresh handles, not the handle that
  //    experienced the fault — a same-handle read inside an open transaction
  //    would observe uncommitted rows and report a durable outcome that does
  //    not exist.
  const firstHandle = open(file);
  const first = await firstHandle.read({ namespace: "claims", key: "k1" });
  firstHandle.close();

  const secondHandle = open(file);
  const second = await secondHandle.read({ namespace: "claims", key: "k1" });
  const survivor = await secondHandle.read({ namespace: "claims", key: "k2" });
  secondHandle.close();

  // The two independent reads must agree, and must reflect the real durable
  // outcome: this commit did not land, so the record is genuinely absent.
  assert.equal(digest(first), digest(second), "reconciliation reads must agree");
  assert.equal(first, null, "the uncommitted write must not be durable");
  assert.deepEqual(survivor?.body, { claim: "b" });

  root.cleanup();
});

test("a store stays healthy on the faulted handle after an ambiguous commit", async () => {
  const root = temporaryStoreRoot("ambiguous-reopen");
  const file = root.pathFor("s.db");
  const store = open(file);
  const { DatabaseSync } = await import("node:sqlite");

  try {
    await store.appendOnce({ namespace: "journal", key: "k1", body: { index: 1 } });
    const fault = injectCommitFailure(DatabaseSync);
    try {
      await assert.rejects(
        store.appendOnce({ namespace: "journal", key: "k2", body: { index: 2 } }),
        (error: unknown) => error instanceof DurableAmbiguousAcknowledgementError
      );
    } finally {
      fault.restore();
    }

    // These must run while the faulted handle is still OPEN. Closing the
    // connection would roll back any leaked transaction and erase exactly the
    // condition under test, so a post-close assertion proves nothing.
    const contender = new DatabaseSync(file);
    contender.exec("PRAGMA busy_timeout = 250");
    try {
      contender.exec("BEGIN IMMEDIATE");
      contender.exec("ROLLBACK");
    } catch (error) {
      assert.fail(`write lock still held by the faulted handle: ${String(error)}`);
    } finally {
      contender.close();
    }

    const chain = await store.verifyChain("journal");
    assert.equal(chain.length, 1, "only the committed write is durable");

    const third = await store.appendOnce({
      namespace: "journal",
      key: "k3",
      body: { index: 3 }
    });
    assert.equal(third.status, "appended");
    assert.equal(third.record?.sequence, 2);
    assert.equal(third.record?.previousHead, chain[0]?.head);
  } finally {
    store.close();
  }

  // Restart continuity is a separate claim, checked after a genuine reopen.
  const reopened = open(file);
  try {
    const chain = await reopened.verifyChain("journal");
    assert.equal(chain.length, 2);
    assert.deepEqual(
      chain.map((record) => record.body),
      [{ index: 1 }, { index: 3 }]
    );
  } finally {
    reopened.close();
    root.cleanup();
  }
});

// ---------------------------------------------------------------------------
// First-open provisioning races
//
// Concurrent first-open provisioning is a check-then-act race: "is this file
// already initialized?" then "if not, create it". These cases exercise every
// distinct failure shape that race can take once serialized behind
// `BEGIN IMMEDIATE`, single-process, alongside the genuine multi-process
// proof in `tests/durable-multiprocess.test.ts`.
// ---------------------------------------------------------------------------

test("a lock held during first-open provisioning refuses typed, never with a raw driver error", async () => {
  const root = temporaryStoreRoot("provision-lock-timeout");
  const file = root.pathFor("s.db");
  const { DatabaseSync } = await import("node:sqlite");

  // Simulate another process that has already begun creating this exact
  // store: establish the same WAL setup this substrate performs, then hold
  // the write lock open without committing.
  const holder = new DatabaseSync(file);
  holder.exec("PRAGMA journal_mode = WAL");
  holder.exec("BEGIN IMMEDIATE");

  try {
    assert.throws(
      () =>
        openDurableSqliteSubstrate({
          path: file,
          storeId: "receipt-journal",
          storeNamespace: "namespace-receipt-journal",
          maxEntries: 512,
          busyTimeoutMs: 100,
          supportedNodeMajors: SUPPORTED_NODE_MAJORS
        }),
      (error: unknown) => codeOf(error) === "STORE_UNAVAILABLE"
    );
  } finally {
    holder.exec("ROLLBACK");
    holder.close();
  }

  // Once the competing lock is released, opening proceeds normally and
  // creates the store exactly once — the earlier timeout left nothing
  // written.
  const store = open(file);
  try {
    const result = await store.appendOnce({
      namespace: "journal",
      key: "k1",
      body: { index: 1 }
    });
    assert.equal(result.status, "appended");
    assert.equal(result.record?.sequence, 1);
  } finally {
    store.close();
    root.cleanup();
  }
});

test("a failing commit during first-open provisioning raises ambiguity rather than a partial store", async () => {
  const root = temporaryStoreRoot("provision-ambiguous");
  const file = root.pathFor("s.db");
  const { DatabaseSync } = await import("node:sqlite");

  const fault = injectCommitFailure(DatabaseSync);
  try {
    assert.throws(
      () => open(file),
      (error: unknown) => {
        assert.ok(
          error instanceof DurableAmbiguousAcknowledgementError,
          `expected ambiguity, got ${String(error)}`
        );
        assert.ok(!(error instanceof DurableSubstrateError));
        return true;
      }
    );
  } finally {
    fault.restore();
  }
  assert.ok(fault.fired(), "the commit fault must actually have fired");

  // The write lock must have been released, not leaked: a fresh connection
  // can immediately acquire it.
  const contender = new DatabaseSync(file);
  contender.exec("PRAGMA busy_timeout = 250");
  try {
    contender.exec("BEGIN IMMEDIATE");
    contender.exec("ROLLBACK");
  } catch (error) {
    assert.fail(
      `the write lock was not released after an ambiguous creation commit: ${String(error)}`
    );
  } finally {
    contender.close();
  }

  // Retrying the open is always safe for a store, unlike retrying an
  // ordinary write: it must succeed cleanly and create exactly one store,
  // never a duplicate or a partial one.
  const store = open(file);
  try {
    const result = await store.appendOnce({
      namespace: "journal",
      key: "k1",
      body: { index: 1 }
    });
    assert.equal(result.status, "appended");
    assert.equal(result.record?.sequence, 1);
    const chain = await store.verifyChain("journal");
    assert.equal(chain.length, 1, "the earlier ambiguous attempt must not have left a partial store");
  } finally {
    store.close();
    root.cleanup();
  }
});

test("a store missing its identity metadata refuses to open instead of accepting a wrong or absent identity", async () => {
  const root = temporaryStoreRoot("provision-partial-meta");
  const file = root.pathFor("s.db");
  const store = open(file);
  try {
    await store.appendOnce({ namespace: "journal", key: "k1", body: { index: 1 } });
  } finally {
    store.close();
  }

  // Simulate partial provisioning surviving a crash: the schema and format
  // pragma landed but the identity row did not (or was later removed).
  await mutate(file, "DELETE FROM durable_meta WHERE id = 1");

  assert.throws(
    () => open(file),
    (error: unknown) => codeOf(error) === "STORE_CORRUPT"
  );
  root.cleanup();
});

/**
 * Forces the exact first-open interleaving — another process's
 * first-open provisioning completing and committing in the narrow window
 * between this process's optimistic, lock-free `user_version` read and its
 * acquiring the write lock — deterministically, rather than relying on real
 * process-fork scheduling to happen to land in that window.
 *
 * That window is a handful of synchronous statements wide. A real multi-
 * process test (see `tests/durable-multiprocess.test.ts`) can happen to land
 * in it, but whether it does depends on OS scheduling and is not guaranteed
 * on every machine or every run; forcing the interleaving here removes that
 * dependency and proves the specific mechanism the fix relies on — the
 * re-read of `user_version` *inside* `BEGIN IMMEDIATE` — independent of
 * timing.
 */
function injectConcurrentCreatorBeforeLock(
  DatabaseSyncCtor: { prototype: { exec: (statement: string) => void } },
  onFirstBeginImmediate: () => void
): { fired: () => boolean; restore: () => void } {
  const original = DatabaseSyncCtor.prototype.exec;
  let fired = false;
  DatabaseSyncCtor.prototype.exec = function patched(
    this: unknown,
    statement: string
  ): void {
    if (statement === "BEGIN IMMEDIATE" && !fired) {
      fired = true;
      // Runs synchronously before this call's own BEGIN IMMEDIATE actually
      // executes, simulating a concurrent creator that lands in the window
      // and fully commits before this process can acquire the lock.
      onFirstBeginImmediate();
    }
    return original.call(this, statement);
  };
  return {
    fired: () => fired,
    restore: () => {
      DatabaseSyncCtor.prototype.exec = original;
    }
  };
}

test("a concurrent creator that lands in the window before the write lock is observed, not raced against", async () => {
  const root = temporaryStoreRoot("provision-forced-race-same-identity");
  const file = root.pathFor("s.db");
  const { DatabaseSync } = await import("node:sqlite");

  const fault = injectConcurrentCreatorBeforeLock(DatabaseSync, () => {
    // The impostor uses the exact same identity this test's own `open(file)`
    // call below will request, simulating another process racing the same
    // binding to the same absent file.
    open(file).close();
  });

  let store: DurableSubstrate;
  try {
    // This must never raise the raw `UNIQUE constraint failed:
    // durable_meta.id` driver error the unfixed check-then-act provisioning
    // leaked, nor any other error: it must silently converge on the
    // impostor's already-committed identity.
    store = open(file);
  } finally {
    fault.restore();
  }
  // The fault must have fired specifically during this `open(file)` call's
  // own provisioning, not merely at some later, unrelated `BEGIN IMMEDIATE`
  // such as the `appendOnce` call below's write transaction. Checking this
  // immediately after `open` returns, before doing anything else, is what
  // makes this a genuine regression guard: reverting the fix removes the only
  // `BEGIN IMMEDIATE` call from the open path, so the fault would never fire
  // here — restoring the patch and asserting *before* the first write runs
  // means a reverted fix is caught right here, rather than the fault
  // happening to fire later during an unrelated write and masking the
  // regression behind an incidental, harmless reopen.
  assert.ok(
    fault.fired(),
    "the forced interleaving must fire during open() itself, not a later write"
  );

  try {
    assert.equal(store.metadata.storeId, "receipt-journal");
    assert.equal(store.metadata.storeNamespace, "namespace-receipt-journal");
    assert.equal(store.metadata.maxEntries, 512);

    const head = await store.readHead("journal");
    assert.equal(head.sequence, 0, "the impostor created identity only, no records");

    // The store is genuinely usable afterward, not merely opened, and there
    // is exactly one durable identity row, not a duplicate.
    const result = await store.appendOnce({
      namespace: "journal",
      key: "k1",
      body: { index: 1 }
    });
    assert.equal(result.status, "appended");
    assert.equal(result.record?.sequence, 1);
    const metaCount = (() => {
      const raw = new DatabaseSync(file, { readOnly: true });
      try {
        const row = raw.prepare("SELECT COUNT(*) AS total FROM durable_meta").get() as
          | { readonly total?: unknown }
          | undefined;
        return Number(row?.total ?? 0);
      } finally {
        raw.close();
      }
    })();
    assert.equal(metaCount, 1, "exactly one identity row must exist, never a duplicate");
  } finally {
    store.close();
  }
  root.cleanup();
});

test("a concurrent creator with a conflicting identity that lands in the window refuses typed, never a raw error", async () => {
  const root = temporaryStoreRoot("provision-forced-race-conflict");
  const file = root.pathFor("s.db");
  const { DatabaseSync } = await import("node:sqlite");

  const fault = injectConcurrentCreatorBeforeLock(DatabaseSync, () => {
    // The impostor commits under a *different* identity than the one this
    // test's own open() call below requests — a genuine identity conflict
    // landing in the exact window before the write lock is acquired.
    openDurableSqliteSubstrate({
      path: file,
      storeId: "evidence-store",
      storeNamespace: "namespace-evidence-store",
      maxEntries: 512,
      busyTimeoutMs: BUSY_TIMEOUT_MS,
      supportedNodeMajors: SUPPORTED_NODE_MAJORS
    }).close();
  });

  try {
    assert.throws(
      () => open(file),
      (error: unknown) => codeOf(error) === "STORE_BINDING_INVALID"
    );
  } finally {
    fault.restore();
  }
  assert.ok(fault.fired(), "the forced interleaving must actually have fired");

  // The impostor's identity is durably settled; reopening under it succeeds.
  const winner = openDurableSqliteSubstrate({
    path: file,
    storeId: "evidence-store",
    storeNamespace: "namespace-evidence-store",
    maxEntries: 512,
    busyTimeoutMs: BUSY_TIMEOUT_MS,
    supportedNodeMajors: SUPPORTED_NODE_MAJORS
  });
  winner.close();
  root.cleanup();
});

// ---------------------------------------------------------------------------
// A produced manifest must satisfy its own published schema
//
// The store-wide journal ceiling permits up to one single-entry namespace per
// record, so any namespace cap below that ceiling makes `backup()` capable of
// emitting evidence that fails its own contract.
// ---------------------------------------------------------------------------

test("a manifest with more than 64 namespaces validates against its own schema", async () => {
  const root = temporaryStoreRoot("manifest-namespaces");
  const file = root.pathFor("s.db");
  const backupPath = root.pathFor("backup.db");
  const store = open(file);

  const namespaceCount = 70;
  try {
    for (let index = 0; index < namespaceCount; index += 1) {
      const result = await store.appendOnce({
        namespace: `ns-${index}`,
        key: "k1",
        body: { index }
      });
      assert.equal(result.status, "appended");
    }

    const manifest = await store.backup(backupPath);
    assert.equal(manifest.namespaces.length, namespaceCount);
    assert.equal(manifest.entryCount, namespaceCount);

    const validation = validateDocument("DurableStoreBackupManifest", manifest);
    assert.ok(
      validation.valid,
      `produced manifest must satisfy its own schema: ${
        validation.valid ? "" : validation.errors.join("; ")
      }`
    );
  } finally {
    store.close();
  }

  // The backup is genuinely restorable at this scale, not merely describable.
  const restored = open(backupPath);
  try {
    for (let index = 0; index < namespaceCount; index += 1) {
      const chain = await restored.verifyChain(`ns-${index}`);
      assert.equal(chain.length, 1);
      assert.deepEqual(chain[0]?.body, { index });
    }
  } finally {
    restored.close();
    root.cleanup();
  }
});

test("a produced journal record validates against its own schema", async () => {
  const root = temporaryStoreRoot("record-schema");
  const store = open(root.pathFor("s.db"));
  try {
    await store.appendOnce({ namespace: "journal", key: "k1", body: { index: 1 } });
    const appended = await store.appendOnce({
      namespace: "journal",
      key: "k".repeat(128),
      body: { index: 2 }
    });
    assert.ok(appended.record);

    const document = journalRecordDocument(store.metadata.storeId, appended.record);
    const validation = validateDocument("DurableStoreJournalRecord", document);
    assert.ok(
      validation.valid,
      `produced record must satisfy its own schema: ${
        validation.valid ? "" : validation.errors.join("; ")
      }`
    );
  } finally {
    store.close();
    root.cleanup();
  }
});

test("a refusal raised inside verifyChain is not masked by closing the read snapshot", async () => {
  const root = temporaryStoreRoot("verify-mask");
  const file = root.pathFor("s.db");
  const store = open(file);
  try {
    await store.appendOnce({ namespace: "journal", key: "k1", body: { index: 1 } });
  } finally {
    store.close();
  }

  // Desync the one head field the hash chain does not cover, so `headOf`
  // raises CHAIN_INVALID from inside verifyChain's read transaction.
  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(file);
  raw.exec("UPDATE durable_head SET entry_count = 99 WHERE namespace='journal'");
  raw.close();

  const reopened = open(file);
  try {
    await assert.rejects(
      reopened.verifyChain("journal"),
      (error: unknown) => {
        // The specific refusal must survive; it must not be replaced by an
        // error thrown while closing the snapshot.
        assert.equal(codeOf(error), "CHAIN_INVALID");
        return true;
      }
    );

    // The connection remains usable and inside the typed taxonomy afterwards.
    await assert.rejects(
      reopened.readHead("journal"),
      (error: unknown) => codeOf(error) === "CHAIN_INVALID"
    );
  } finally {
    reopened.close();
    root.cleanup();
  }
});

test("a manifest at the store's maximum namespace count validates, and the bound is exact", async () => {
  const root = temporaryStoreRoot("manifest-max");
  const file = root.pathFor("s.db");
  const backupPath = root.pathFor("backup.db");
  const store = open(file);

  try {
    // The worst case for the manifest is one single-entry namespace per
    // record, which is exactly the store-wide journal ceiling. This pins the
    // schema's namespace bound to the real upper bound rather than a guess.
    for (let index = 0; index < DURABLE_JOURNAL_MAX_ENTRIES; index += 1) {
      const result = await store.appendOnce({
        namespace: `ns-${index}`,
        key: "k1",
        body: { index }
      });
      assert.equal(result.status, "appended");
    }

    // One more must refuse: the ceiling is exact, not advisory.
    await assert.rejects(
      store.appendOnce({ namespace: "overflow", key: "k1", body: {} }),
      (error: unknown) => codeOf(error) === "CAPACITY_EXHAUSTED"
    );

    const manifest = await store.backup(backupPath);
    assert.equal(manifest.namespaces.length, DURABLE_JOURNAL_MAX_ENTRIES);
    assert.equal(manifest.entryCount, DURABLE_JOURNAL_MAX_ENTRIES);

    const validation = validateDocument("DurableStoreBackupManifest", manifest);
    assert.ok(
      validation.valid,
      `manifest at the maximum bound must satisfy its own schema: ${
        validation.valid ? "" : validation.errors.join("; ")
      }`
    );
  } finally {
    store.close();
    root.cleanup();
  }
});
