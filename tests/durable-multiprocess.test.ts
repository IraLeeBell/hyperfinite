/**
 * Multi-process durability proof.
 *
 * Every assertion here is about behaviour that cannot be demonstrated inside a
 * single process: that the on-disk write lock, not application logic, is what
 * prevents two independent workers from both winning a contended write.
 */

import assert from "node:assert/strict";
import { fork } from "node:child_process";
import path from "node:path";
import { test } from "node:test";

import { openDurableSqliteSubstrate } from "../src/durable-sqlite-substrate.js";
import {
  BUSY_TIMEOUT_MS,
  SUPPORTED_NODE_MAJORS,
  temporaryStoreRoot
} from "./support/durable-substrate-harness.js";
import type { WorkerReply, WorkerRequest } from "./support/durable-worker.js";

const WORKER = path.join(import.meta.dirname, "support", "durable-worker.js");

async function runWorkers(
  requests: readonly WorkerRequest[]
): Promise<readonly WorkerReply[]> {
  return Promise.all(
    requests.map(
      (request) =>
        new Promise<WorkerReply>((resolve, reject) => {
          const child = fork(WORKER, [JSON.stringify(request)], { stdio: "inherit" });
          let reply: WorkerReply | null = null;
          child.on("message", (message) => {
            reply = message as WorkerReply;
          });
          child.on("error", reject);
          child.on("exit", (code) => {
            if (reply === null) {
              reject(new Error("worker exited without reporting"));
              return;
            }
            if (code !== 0) {
              reject(new Error(`worker exited with code ${String(code)}`));
              return;
            }
            resolve(reply);
          });
        })
    )
  );
}

function totals(replies: readonly WorkerReply[]): {
  appended: number;
  existing: number;
  conflict: number;
  unavailable: number;
  errors: readonly string[];
} {
  return {
    appended: replies.reduce((sum, reply) => sum + reply.appended, 0),
    existing: replies.reduce((sum, reply) => sum + reply.existing, 0),
    conflict: replies.reduce((sum, reply) => sum + reply.conflict, 0),
    unavailable: replies.reduce((sum, reply) => sum + reply.unavailable, 0),
    errors: replies.flatMap((reply) => reply.errors)
  };
}

function baseRequest(overrides: Partial<WorkerRequest>): WorkerRequest {
  return {
    scenario: "race-append-identical",
    path: "",
    namespace: "journal",
    key: "contended",
    workerIndex: 0,
    iterations: 1,
    maxEntries: 512,
    busyTimeoutMs: BUSY_TIMEOUT_MS,
    supportedNodeMajors: SUPPORTED_NODE_MAJORS,
    ...overrides
  };
}

function open(storePath: string) {
  return openDurableSqliteSubstrate({
    path: storePath,
    storeId: "receipt-journal",
    storeNamespace: "namespace-receipt-journal",
    maxEntries: 512,
    busyTimeoutMs: BUSY_TIMEOUT_MS,
    supportedNodeMajors: SUPPORTED_NODE_MAJORS
  });
}

test("independent processes racing one identical append yield exactly one appended", async () => {
  const root = temporaryStoreRoot("mp-identical");
  const storePath = root.pathFor("s.db");
  // Create the store first so every worker opens an initialized file.
  open(storePath).close();

  try {
    const replies = await runWorkers(
      [0, 1, 2, 3, 4, 5].map((workerIndex) =>
        baseRequest({
          scenario: "race-append-identical",
          path: storePath,
          workerIndex
        })
      )
    );
    const result = totals(replies);
    assert.deepEqual(result.errors, []);
    assert.equal(result.appended, 1, "exactly one process may create the record");
    assert.equal(result.conflict, 0, "an identical body must never report conflict");
    assert.equal(
      result.existing + result.unavailable,
      5,
      "every other process must observe the record or refuse, never win"
    );

    const store = open(storePath);
    try {
      const chain = await store.verifyChain("journal");
      assert.equal(chain.length, 1, "only one durable record may exist");
    } finally {
      store.close();
    }
  } finally {
    root.cleanup();
  }
});

test("independent processes racing conflicting bodies yield one appended and the rest conflict", async () => {
  const root = temporaryStoreRoot("mp-conflicting");
  const storePath = root.pathFor("s.db");
  open(storePath).close();

  try {
    const replies = await runWorkers(
      [0, 1, 2, 3, 4, 5].map((workerIndex) =>
        baseRequest({
          scenario: "race-append-conflicting",
          path: storePath,
          workerIndex
        })
      )
    );
    const result = totals(replies);
    assert.deepEqual(result.errors, []);
    assert.equal(result.appended, 1);
    assert.equal(result.existing, 0, "a differing body must never report existing");
    assert.equal(
      result.conflict + result.unavailable,
      5,
      "every other process must conflict or refuse, never win"
    );
  } finally {
    root.cleanup();
  }
});

test("independent processes compare-and-swapping the same head yield exactly one winner", async () => {
  const root = temporaryStoreRoot("mp-cas");
  const storePath = root.pathFor("s.db");
  open(storePath).close();

  try {
    const replies = await runWorkers(
      [0, 1, 2, 3, 4, 5].map((workerIndex) =>
        baseRequest({
          scenario: "race-cas-same-head",
          path: storePath,
          workerIndex
        })
      )
    );
    const result = totals(replies);
    assert.deepEqual(result.errors, []);
    assert.equal(result.appended, 1, "only one process may advance genesis");
    assert.equal(
      result.conflict + result.unavailable,
      5,
      "every other process must conflict or refuse, never win"
    );
  } finally {
    root.cleanup();
  }
});

test("contended compare-and-swap loops across processes lose no update", async () => {
  const root = temporaryStoreRoot("mp-loop");
  const storePath = root.pathFor("s.db");
  open(storePath).close();

  const iterations = 40;
  const workers = 4;

  try {
    const replies = await runWorkers(
      Array.from({ length: workers }, (_unused, workerIndex) =>
        baseRequest({
          scenario: "contended-cas-loop",
          path: storePath,
          workerIndex,
          iterations
        })
      )
    );
    const result = totals(replies);
    assert.deepEqual(result.errors, []);
    assert.ok(result.appended > 0, "some writes must succeed under contention");

    const store = open(storePath);
    try {
      // The decisive check: the journal length equals the number of reported
      // successes exactly. A lost update would make the chain shorter than the
      // count of processes that believed they had won.
      const chain = await store.verifyChain("journal");
      assert.equal(
        chain.length,
        result.appended,
        "journal length must equal the number of reported appends"
      );
      const head = await store.readHead("journal");
      assert.equal(head.sequence, result.appended);
      assert.equal(head.entryCount, result.appended);
    } finally {
      store.close();
    }
  } finally {
    root.cleanup();
  }
});

test("a record committed by one process is immediately visible to another", async () => {
  const root = temporaryStoreRoot("mp-visibility");
  const storePath = root.pathFor("s.db");
  const writer = open(storePath);
  try {
    await writer.appendOnce({
      namespace: "journal",
      key: "k1",
      body: { written: "by-writer" }
    });
  } finally {
    writer.close();
  }

  try {
    const replies = await runWorkers([
      baseRequest({
        scenario: "race-append-identical",
        path: storePath,
        key: "k1"
      })
    ]);
    // The child writes a different body under the same key; it must observe the
    // committed record and refuse rather than create a second one.
    assert.equal(replies[0]?.conflict, 1);
    assert.equal(replies[0]?.appended, 0, "a second process must not re-create the record");
    assert.deepEqual(replies[0]?.errors, []);
  } finally {
    root.cleanup();
  }
});

// ---------------------------------------------------------------------------
// First-open provisioning races
//
// Every prior test in this file provisions the store once, single-threaded,
// before forking, because that is what every existing adapter race test does
// — it does not exercise first-open creation. These cases fork real,
// independent processes against a file that does not exist yet, which is
// the exact first-open gap: multiple processes racing to create the
// same store can collide before normal adapter operations begin.
//
// Whether any given run actually lands two processes' optimistic reads inside
// the same narrow window depends on OS scheduling, so these prove the store
// converges correctly under genuine concurrent process access rather than
// guaranteeing the exact race fires every run. `tests/durable-recovery.test.ts`
// carries the deterministic proof: it forces that exact interleaving via
// fault injection, independent of scheduling, for both a same-identity and a
// conflicting-identity racer.
// ---------------------------------------------------------------------------

test("independent processes racing first-open provisioning of an absent store converge on exactly one identity", async () => {
  const root = temporaryStoreRoot("mp-provision-identical");
  const storePath = root.pathFor("s.db");
  // Deliberately do not create the store first: concurrent first-open
  // provisioning of this exact absent file is the race under test.

  try {
    // Match the six-worker convention used by every other race test in this
    // file, for the same margin against incidental scheduling.
    const workerCount = 6;
    const replies = await runWorkers(
      Array.from({ length: workerCount }, (_unused, workerIndex) =>
        baseRequest({
          scenario: "provision-open",
          path: storePath,
          namespace: "journal",
          workerIndex,
          maxEntries: 512
        })
      )
    );

    for (const reply of replies) {
      assert.deepEqual(reply.errors, [], `worker ${reply.pid} must never leak a raw driver error`);
      assert.equal(
        reply.ambiguous,
        undefined,
        `worker ${reply.pid} must not report an ambiguous creation`
      );
      assert.equal(reply.refusalCode, undefined, `worker ${reply.pid} must not be refused`);
      assert.equal(reply.opened, true, `worker ${reply.pid} must successfully open the store`);
    }

    // Exactly one process initializes schema/meta; every other process must
    // converge on that exact same identity and bound, never a wider or
    // different one, and never a weakened readback.
    const storeIds = new Set(replies.map((reply) => reply.storeId));
    const storeNamespaces = new Set(replies.map((reply) => reply.storeNamespace));
    const maxEntriesSet = new Set(replies.map((reply) => reply.maxEntries));
    const formatVersions = new Set(replies.map((reply) => reply.formatVersion));
    assert.equal(storeIds.size, 1, "every process must observe the same store id");
    assert.equal(storeNamespaces.size, 1, "every process must observe the same backend namespace");
    assert.equal(maxEntriesSet.size, 1, "every process must observe the same journal bound");
    assert.equal(formatVersions.size, 1, "every process must observe the same format version");
    assert.equal([...storeIds][0], "receipt-journal");
    assert.equal([...storeNamespaces][0], "namespace-receipt-journal");
    assert.equal([...maxEntriesSet][0], 512);

    // The store is genuinely usable after the race: every worker's distinct
    // key is durable and the chain is intact, not merely a returned handle.
    const store = open(storePath);
    try {
      const chain = await store.verifyChain("journal");
      assert.equal(chain.length, workerCount, "every worker's distinct key must be durable");
    } finally {
      store.close();
    }
  } finally {
    root.cleanup();
  }
});

test("independent processes racing first-open provisioning with conflicting identities converge deterministically", async () => {
  const root = temporaryStoreRoot("mp-provision-conflict");
  const storePath = root.pathFor("s.db");

  const identityA = {
    provisionStoreId: "receipt-journal",
    provisionStoreNamespace: "namespace-receipt-journal"
  };
  const identityB = {
    provisionStoreId: "evidence-store",
    provisionStoreNamespace: "namespace-evidence-store"
  };

  try {
    const groupA = Array.from({ length: 4 }, (_unused, index) =>
      baseRequest({
        scenario: "provision-open",
        path: storePath,
        namespace: "journal",
        workerIndex: index,
        maxEntries: 512,
        ...identityA
      })
    );
    const groupB = Array.from({ length: 4 }, (_unused, index) =>
      baseRequest({
        scenario: "provision-open",
        path: storePath,
        namespace: "journal",
        workerIndex: 100 + index,
        maxEntries: 512,
        ...identityB
      })
    );
    const replies = await runWorkers([...groupA, ...groupB]);

    for (const reply of replies) {
      assert.deepEqual(reply.errors, [], `worker ${reply.pid} must never leak a raw driver error`);
      assert.equal(
        reply.ambiguous,
        undefined,
        `worker ${reply.pid} must not report an ambiguous creation`
      );
    }

    const repliesA = replies.slice(0, groupA.length);
    const repliesB = replies.slice(groupA.length);
    const aWon = repliesA.every((reply) => reply.opened === true);
    const bWon = repliesB.every((reply) => reply.opened === true);
    assert.notEqual(
      aWon,
      bWon,
      "exactly one conflicting identity must win the race — never both, never neither"
    );

    const [winners, losers] = aWon ? [repliesA, repliesB] : [repliesB, repliesA];
    for (const reply of winners) {
      assert.equal(reply.opened, true);
      assert.equal(reply.refusalCode, undefined);
    }
    for (const reply of losers) {
      assert.equal(reply.opened, false, "the losing identity must never be silently accepted");
      assert.equal(
        reply.refusalCode,
        "STORE_BINDING_INVALID",
        "the losing identity must refuse typed, never with a raw driver error or a weakened readback"
      );
    }

    // Every process on the winning side must agree on the exact same
    // identity — the store cannot be reopened under a different one.
    const winnerIds = new Set(winners.map((reply) => reply.storeId));
    assert.equal(winnerIds.size, 1, "every winning process must observe the same store id");
  } finally {
    root.cleanup();
  }
});
