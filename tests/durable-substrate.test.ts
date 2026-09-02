import assert from "node:assert/strict";
import { openSync, writeSync, closeSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";

import { digest } from "../src/canonical.js";
import {
  DurableAmbiguousAcknowledgementError,
  DurableSubstrateError,
  assertCapacity,
  assertChainState,
  canonicalBytes,
  chainHead,
  decodeCanonicalBytes,
  type DurableSubstrate
} from "../src/durable-substrate.js";
import {
  DURABLE_STORE_FORMAT_VERSION,
  assertSupportedRuntime,
  normalizeChanges,
  openDurableSqliteSubstrate
} from "../src/durable-sqlite-substrate.js";
import {
  bindDurableStores,
  openBoundDurableStore
} from "../src/durable-store-binding.js";
import {
  BUSY_TIMEOUT_MS,
  SUPPORTED_NODE_MAJORS,
  assertCallerHeadFidelity,
  storePathsFor,
  syntheticStorePlan,
  temporaryStoreRoot
} from "./support/durable-substrate-harness.js";

function open(path: string, storeId = "receipt-journal"): DurableSubstrate {
  return openDurableSqliteSubstrate({
    path,
    storeId,
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
// Runtime gate
// ---------------------------------------------------------------------------

test("the runtime gate accepts the supported majors and probes real capability", () => {
  assert.doesNotThrow(() => assertSupportedRuntime(SUPPORTED_NODE_MAJORS));
});

test("an unsupported Node major refuses with no fallback", () => {
  const error = (() => {
    try {
      assertSupportedRuntime([1]);
      return null;
    } catch (caught) {
      return caught;
    }
  })();
  assert.equal(codeOf(error), "RUNTIME_UNSUPPORTED");
});

test("an empty supported-major set refuses rather than defaulting to permissive", () => {
  assert.throws(
    () => assertSupportedRuntime([]),
    (error: unknown) => codeOf(error) === "ARGUMENT_INVALID"
  );
});

// ---------------------------------------------------------------------------
// Path discipline: no default path, no relative path
// ---------------------------------------------------------------------------

test("a relative store path refuses; there is no default path", () => {
  assert.throws(
    () => open("relative/store.db"),
    (error: unknown) => codeOf(error) === "STORE_PATH_INVALID"
  );
});

test("an empty store path refuses", () => {
  assert.throws(
    () => open(""),
    (error: unknown) => codeOf(error) === "STORE_PATH_INVALID"
  );
});

test("a NUL byte in the store path refuses", () => {
  assert.throws(
    () => open("/tmp/bad\0path.db"),
    (error: unknown) => codeOf(error) === "STORE_PATH_INVALID"
  );
});

// ---------------------------------------------------------------------------
// Write trichotomy
// ---------------------------------------------------------------------------

test("appendOnce returns appended, then existing for byte-identical replay", async () => {
  const root = temporaryStoreRoot("trichotomy");
  const store = open(root.pathFor("s.db"));
  try {
    const body = { claim: "a", value: 1 };
    const first = await store.appendOnce({
      namespace: "claims",
      key: "k1",
      body
    });
    assert.equal(first.status, "appended");
    assert.equal(first.record?.sequence, 1);
    assert.equal(first.record?.previousHead, null);

    const replay = await store.appendOnce({
      namespace: "claims",
      key: "k1",
      body: { value: 1, claim: "a" }
    });
    // Key ordering differs but canonical bytes are identical.
    assert.equal(replay.status, "existing");
    assert.equal(replay.record?.head, first.record?.head);
  } finally {
    store.close();
    root.cleanup();
  }
});

test("a differing body under the same key is conflict, never existing", async () => {
  const root = temporaryStoreRoot("conflict");
  const store = open(root.pathFor("s.db"));
  try {
    await store.appendOnce({
      namespace: "claims",
      key: "k1",
      body: { claim: "a" }
    });
    const mutated = await store.appendOnce({
      namespace: "claims",
      key: "k1",
      body: { claim: "b" }
    });
    assert.equal(mutated.status, "conflict");
    assert.equal(mutated.record, null);

    // The original must be untouched by the refused write.
    const stored = await store.read({ namespace: "claims", key: "k1" });
    assert.deepEqual(stored?.body, { claim: "a" });
  } finally {
    store.close();
    root.cleanup();
  }
});

test("compareAndSwap honours the expected head and refuses a stale one", async () => {
  const root = temporaryStoreRoot("cas");
  const store = open(root.pathFor("s.db"));
  try {
    const genesis = await store.compareAndSwap({
      namespace: "state",
      key: "s1",
      expectedHead: null,
      body: { generation: 1 }
    });
    assert.equal(genesis.status, "appended");
    const head = genesis.record?.head ?? null;

    const advanced = await store.compareAndSwap({
      namespace: "state",
      key: "s2",
      expectedHead: head,
      body: { generation: 2 }
    });
    assert.equal(advanced.status, "appended");
    assert.equal(advanced.record?.previousHead, head);
    assert.equal(advanced.record?.sequence, 2);

    const stale = await store.compareAndSwap({
      namespace: "state",
      key: "s3",
      expectedHead: head,
      body: { generation: 3 }
    });
    assert.equal(stale.status, "conflict");
  } finally {
    store.close();
    root.cleanup();
  }
});

test("compareAndSwap against a non-null head at genesis is a conflict", async () => {
  const root = temporaryStoreRoot("cas-genesis");
  const store = open(root.pathFor("s.db"));
  try {
    const result = await store.compareAndSwap({
      namespace: "state",
      key: "s1",
      expectedHead: digest({ not: "present" }),
      body: { generation: 1 }
    });
    assert.equal(result.status, "conflict");
  } finally {
    store.close();
    root.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Stable reread (the guarantee callers rely on to reconcile ambiguity)
// ---------------------------------------------------------------------------

test("two consecutive reads return canonically identical records", async () => {
  const root = temporaryStoreRoot("reread");
  const store = open(root.pathFor("s.db"));
  try {
    await store.appendOnce({
      namespace: "claims",
      key: "k1",
      body: { claim: "a" }
    });
    const first = await store.read({ namespace: "claims", key: "k1" });
    const second = await store.read({ namespace: "claims", key: "k1" });
    assert.equal(digest(first), digest(second));
  } finally {
    store.close();
    root.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Chain integrity
// ---------------------------------------------------------------------------

test("verifyChain accepts a well-formed journal and reports its records", async () => {
  const root = temporaryStoreRoot("chain");
  const store = open(root.pathFor("s.db"));
  try {
    for (const index of [1, 2, 3]) {
      await store.appendOnce({
        namespace: "journal",
        key: `k${index}`,
        body: { index }
      });
    }
    const chain = await store.verifyChain("journal");
    assert.equal(chain.length, 3);
    assert.equal(chain[0]?.previousHead, null);
    assert.equal(chain[1]?.previousHead, chain[0]?.head);
    assert.equal(chain[2]?.previousHead, chain[1]?.head);

    const head = await store.readHead("journal");
    assert.equal(head.sequence, 3);
    assert.equal(head.head, chain[2]?.head);
    assert.equal(head.entryCount, 3);
  } finally {
    store.close();
    root.cleanup();
  }
});

test("impossible chain states are refused rather than normalized", () => {
  // Genesis must carry a null head.
  assert.throws(
    () => assertChainState(0, digest({ a: 1 }), "test"),
    (error: unknown) => codeOf(error) === "CHAIN_INVALID"
  );
  // A positive sequence must carry a non-null head.
  assert.throws(
    () => assertChainState(4, null, "test"),
    (error: unknown) => codeOf(error) === "CHAIN_INVALID"
  );
  assert.doesNotThrow(() => assertChainState(0, null, "test"));
  assert.doesNotThrow(() => assertChainState(1, digest({ a: 1 }), "test"));
});

test("a rewritten body is detected because its digest no longer matches", () => {
  const body = { claim: "a" };
  const bytes = canonicalBytes(body);
  assert.throws(
    () => decodeCanonicalBytes(bytes, digest({ claim: "b" }), "ns", "k"),
    (error: unknown) => codeOf(error) === "STORE_CORRUPT"
  );
});

test("non-canonical stored bytes are refused even when they parse", () => {
  const noncanonical = new TextEncoder().encode('{"b":1,"a":2}');
  assert.throws(
    () => decodeCanonicalBytes(noncanonical, digest({ a: 2, b: 1 }), "ns", "k"),
    (error: unknown) => codeOf(error) === "STORE_CORRUPT"
  );
});

test("truncated and non-UTF-8 stored bytes are refused", () => {
  const truncated = new TextEncoder().encode('{"claim":');
  assert.throws(
    () => decodeCanonicalBytes(truncated, digest({ claim: "a" }), "ns", "k"),
    (error: unknown) => codeOf(error) === "STORE_CORRUPT"
  );
  const invalidUtf8 = new Uint8Array([0xff, 0xfe, 0xfd]);
  assert.throws(
    () => decodeCanonicalBytes(invalidUtf8, digest({ claim: "a" }), "ns", "k"),
    (error: unknown) => codeOf(error) === "STORE_CORRUPT"
  );
});

test("a tampered record body on disk is refused on read", async () => {
  const root = temporaryStoreRoot("tamper");
  const file = root.pathFor("s.db");
  const store = open(file);
  try {
    await store.appendOnce({
      namespace: "claims",
      key: "k1",
      body: { claim: "aaaaaaaa" }
    });
  } finally {
    store.close();
  }

  // Flip the stored payload in place, preserving byte length so the row still
  // reads back but can no longer re-derive its recorded digest.
  const raw = readFileSync(file);
  const needle = Buffer.from('{"claim":"aaaaaaaa"}', "utf8");
  const at = raw.indexOf(needle);
  assert.ok(at > 0, "expected the canonical body bytes to be present on disk");
  raw.write('{"claim":"bbbbbbbb"}', at, "utf8");
  writeFileSync(file, raw);

  const reopened = open(file);
  try {
    await assert.rejects(
      reopened.read({ namespace: "claims", key: "k1" }),
      (error: unknown) => codeOf(error) === "STORE_CORRUPT"
    );
  } finally {
    reopened.close();
    root.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Format version
// ---------------------------------------------------------------------------

test("a store written by another format version refuses to open", async () => {
  const root = temporaryStoreRoot("format");
  const file = root.pathFor("s.db");
  const store = open(file);
  try {
    await store.appendOnce({
      namespace: "claims",
      key: "k1",
      body: { claim: "a" }
    });
    assert.equal(store.metadata.formatVersion, DURABLE_STORE_FORMAT_VERSION);
  } finally {
    store.close();
  }

  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(file);
  raw.exec(`PRAGMA user_version = ${DURABLE_STORE_FORMAT_VERSION + 1}`);
  raw.close();

  assert.throws(
    () => open(file),
    (error: unknown) => codeOf(error) === "STORE_FORMAT_MISMATCH"
  );
  root.cleanup();
});

test("a corrupt database file refuses to open", () => {
  const root = temporaryStoreRoot("corrupt");
  const file = root.pathFor("s.db");
  const descriptor = openSync(file, "w");
  // A valid SQLite header followed by garbage: opens, then fails integrity.
  writeSync(descriptor, Buffer.from("SQLite format 3\0", "utf8"));
  writeSync(descriptor, Buffer.alloc(4096, 0x41));
  closeSync(descriptor);

  assert.throws(
    () => open(file),
    (error: unknown) => codeOf(error) === "STORE_CORRUPT"
  );
  root.cleanup();
});

// ---------------------------------------------------------------------------
// Bounded journal refuses, never evicts
// ---------------------------------------------------------------------------

function openBounded(storePath: string, maxEntries: number): DurableSubstrate {
  return openDurableSqliteSubstrate({
    path: storePath,
    storeId: "receipt-journal",
    storeNamespace: "namespace-receipt-journal",
    maxEntries,
    busyTimeoutMs: BUSY_TIMEOUT_MS,
    supportedNodeMajors: SUPPORTED_NODE_MAJORS
  });
}

test("a full journal refuses the next append and keeps every existing entry", async () => {
  const root = temporaryStoreRoot("capacity");
  const store = openBounded(root.pathFor("s.db"), 3);
  try {
    for (const index of [1, 2, 3]) {
      const result = await store.appendOnce({
        namespace: "journal",
        key: `k${index}`,
        body: { index }
      });
      assert.equal(result.status, "appended");
    }
    await assert.rejects(
      store.appendOnce({ namespace: "journal", key: "k4", body: { index: 4 } }),
      (error: unknown) => codeOf(error) === "CAPACITY_EXHAUSTED"
    );

    // Nothing was evicted to make room.
    const chain = await store.verifyChain("journal");
    assert.equal(chain.length, 3);
    assert.equal((await store.readHead("journal")).entryCount, 3);
  } finally {
    store.close();
    root.cleanup();
  }
});

test("the journal bound is store-wide, not per namespace", async () => {
  const root = temporaryStoreRoot("capacity-store-wide");
  const store = openBounded(root.pathFor("s.db"), 3);
  try {
    // Spread the entries across two namespaces. A per-namespace bound would
    // let this store hold six entries under a three-entry plan.
    await store.appendOnce({ namespace: "alpha", key: "k1", body: { i: 1 } });
    await store.appendOnce({ namespace: "beta", key: "k2", body: { i: 2 } });
    await store.appendOnce({ namespace: "alpha", key: "k3", body: { i: 3 } });

    await assert.rejects(
      store.appendOnce({ namespace: "beta", key: "k4", body: { i: 4 } }),
      (error: unknown) => codeOf(error) === "CAPACITY_EXHAUSTED"
    );
  } finally {
    store.close();
    root.cleanup();
  }
});

test("a store cannot be reopened under a different identity or a wider bound", async () => {
  const root = temporaryStoreRoot("identity");
  const file = root.pathFor("s.db");
  const store = openBounded(file, 3);
  try {
    await store.appendOnce({ namespace: "journal", key: "k1", body: { i: 1 } });
  } finally {
    store.close();
  }

  // A wider bound than the store was created with.
  assert.throws(
    () => openBounded(file, 8),
    (error: unknown) => codeOf(error) === "STORE_BINDING_INVALID"
  );
  // A different store id.
  assert.throws(
    () =>
      openDurableSqliteSubstrate({
        path: file,
        storeId: "evidence-store",
        storeNamespace: "namespace-receipt-journal",
        maxEntries: 3,
        busyTimeoutMs: BUSY_TIMEOUT_MS,
        supportedNodeMajors: SUPPORTED_NODE_MAJORS
      }),
    (error: unknown) => codeOf(error) === "STORE_BINDING_INVALID"
  );
  // A different backend namespace.
  assert.throws(
    () =>
      openDurableSqliteSubstrate({
        path: file,
        storeId: "receipt-journal",
        storeNamespace: "namespace-other",
        maxEntries: 3,
        busyTimeoutMs: BUSY_TIMEOUT_MS,
        supportedNodeMajors: SUPPORTED_NODE_MAJORS
      }),
    (error: unknown) => codeOf(error) === "STORE_BINDING_INVALID"
  );
  // The correct binding still opens.
  const reopened = openBounded(file, 3);
  assert.equal(reopened.metadata.maxEntries, 3);
  reopened.close();
  root.cleanup();
});

test("readCurrent returns the head and the record that produced it", async () => {
  const root = temporaryStoreRoot("read-current");
  const store = open(root.pathFor("s.db"));
  try {
    const empty = await store.readCurrent("state");
    assert.equal(empty.record, null);
    assert.equal(empty.head.head, null);
    assert.equal(empty.head.sequence, 0);

    await store.compareAndSwap({
      namespace: "state",
      key: "s1",
      expectedHead: null,
      body: { generation: 1 }
    });
    const advanced = await store.compareAndSwap({
      namespace: "state",
      key: "s2",
      expectedHead: (await store.readHead("state")).head,
      body: { generation: 2 }
    });

    const current = await store.readCurrent("state");
    assert.equal(current.head.head, advanced.record?.head);
    assert.deepEqual(current.record?.body, { generation: 2 });
    assert.equal(current.record?.key, "s2");

    // The pair is coherent: the returned record is exactly the head's record.
    assert.equal(current.record?.head, current.head.head);
  } finally {
    store.close();
    root.cleanup();
  }
});

test("a journal bound above the contract ceiling refuses", () => {
  assert.throws(
    () => assertCapacity({ storeId: "j", storeEntryCount: 0, maxEntries: 513 }),
    (error: unknown) => codeOf(error) === "ARGUMENT_INVALID"
  );
  assert.throws(
    () => assertCapacity({ storeId: "j", storeEntryCount: 0, maxEntries: 0 }),
    (error: unknown) => codeOf(error) === "ARGUMENT_INVALID"
  );
});

// ---------------------------------------------------------------------------
// Driver row-count normalization
// ---------------------------------------------------------------------------

test("changes counts normalize from bigint and refuse anything but 0 or 1", () => {
  assert.equal(normalizeChanges(0, "t"), 0);
  assert.equal(normalizeChanges(1, "t"), 1);
  assert.equal(normalizeChanges(0n, "t"), 0);
  assert.equal(normalizeChanges(1n, "t"), 1);
  assert.throws(
    () => normalizeChanges(2, "t"),
    (error: unknown) => codeOf(error) === "STORE_CORRUPT"
  );
  assert.throws(
    () => normalizeChanges(7n, "t"),
    (error: unknown) => codeOf(error) === "STORE_CORRUPT"
  );
});

// ---------------------------------------------------------------------------
// Argument discipline
// ---------------------------------------------------------------------------

test("namespace and key must be closed logical names", async () => {
  const root = temporaryStoreRoot("keys");
  const store = open(root.pathFor("s.db"));
  try {
    for (const bad of ["../escape", "/abs", "Upper", "with space", ""]) {
      await assert.rejects(
        store.appendOnce({ namespace: bad, key: "k", body: {} }),
        (error: unknown) => codeOf(error) === "ARGUMENT_INVALID",
        `namespace ${JSON.stringify(bad)} should refuse`
      );
      await assert.rejects(
        store.appendOnce({ namespace: "ns", key: bad, body: {} }),
        (error: unknown) => codeOf(error) === "ARGUMENT_INVALID",
        `key ${JSON.stringify(bad)} should refuse`
      );
    }
  } finally {
    store.close();
    root.cleanup();
  }
});

test("a malformed expected head refuses instead of being coerced", async () => {
  const root = temporaryStoreRoot("digest");
  const store = open(root.pathFor("s.db"));
  try {
    await assert.rejects(
      store.compareAndSwap({
        namespace: "ns",
        key: "k",
        expectedHead: "not-a-digest" as never,
        body: {}
      }),
      (error: unknown) => codeOf(error) === "ARGUMENT_INVALID"
    );
  } finally {
    store.close();
    root.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Ambiguity is a distinct, exported state
// ---------------------------------------------------------------------------

test("the ambiguous-acknowledgement state is distinct from a refusal", () => {
  const ambiguous = new DurableAmbiguousAcknowledgementError("claims", "k1");
  assert.ok(ambiguous instanceof Error);
  assert.ok(!(ambiguous instanceof DurableSubstrateError));
  assert.equal(ambiguous.name, "DurableAmbiguousAcknowledgementError");
  assert.equal(ambiguous.namespace, "claims");
  assert.equal(ambiguous.key, "k1");
});

// ---------------------------------------------------------------------------
// Head fidelity helper (reused by PRs B-E)
// ---------------------------------------------------------------------------

test("the head-fidelity helper matches a caller's recomputed receipt head", () => {
  // Mirrors the recomputation in src/demo-activation.ts:539.
  const receipt = {
    storeId: "activation-store-1",
    sequence: 1,
    previousHead: null,
    claim: { claimKey: digest({ a: 1 }) },
    status: "appended",
    persistedAt: "2026-08-30T12:00:00.000Z"
  };
  const callerRecomputedHead = digest(receipt);
  assertCallerHeadFidelity({
    label: "activation claim receipt",
    callerRecomputedHead,
    receiptHead: digest({ ...receipt })
  });
  assert.throws(() =>
    assertCallerHeadFidelity({
      label: "activation claim receipt",
      callerRecomputedHead,
      receiptHead: digest({ ...receipt, sequence: 2 })
    })
  );
});

test("chainHead binds namespace, key, sequence, predecessor, and body", () => {
  const base = {
    namespace: "claims",
    key: "k1",
    sequence: 1,
    previousHead: null,
    bodyDigest: digest({ a: 1 })
  } as const;
  const head = chainHead(base);
  assert.notEqual(head, chainHead({ ...base, namespace: "other" }));
  assert.notEqual(head, chainHead({ ...base, key: "k2" }));
  assert.notEqual(head, chainHead({ ...base, sequence: 2 }));
  assert.notEqual(head, chainHead({ ...base, bodyDigest: digest({ a: 2 }) }));
});

// ---------------------------------------------------------------------------
// Binding to the merged deployment contract
// ---------------------------------------------------------------------------

test("binding derives exactly the four contract stores", () => {
  const root = temporaryStoreRoot("bind");
  try {
    const bindings = bindDurableStores({
      plan: syntheticStorePlan(),
      storePaths: storePathsFor(root)
    });
    assert.equal(bindings.length, 4);
    assert.deepEqual(
      bindings.map((binding) => binding.storeId).slice().sort(),
      ["evidence-store", "operation-grant-store", "receipt-journal", "runtime-state-store"]
    );
    assert.equal(bindings[0]?.maxEntries, 512);
  } finally {
    root.cleanup();
  }
});

test("a shared backend namespace or credential refuses", () => {
  const root = temporaryStoreRoot("bind-shared");
  try {
    assert.throws(
      () =>
        bindDurableStores({
          plan: syntheticStorePlan({ namespaceFor: () => "one-namespace" }),
          storePaths: storePathsFor(root)
        }),
      (error: unknown) => codeOf(error) === "STORE_BINDING_INVALID"
    );
    assert.throws(
      () =>
        bindDurableStores({
          plan: syntheticStorePlan({ credentialFor: () => "one-credential" }),
          storePaths: storePathsFor(root)
        }),
      (error: unknown) => codeOf(error) === "STORE_BINDING_INVALID"
    );
  } finally {
    root.cleanup();
  }
});

test("two stores sharing one filesystem path refuses", () => {
  const root = temporaryStoreRoot("bind-path");
  try {
    const shared = root.pathFor("shared.db");
    assert.throws(
      () =>
        bindDurableStores({
          plan: syntheticStorePlan(),
          storePaths: {
            "evidence-store": shared,
            "operation-grant-store": shared,
            "receipt-journal": root.pathFor("c.db"),
            "runtime-state-store": root.pathFor("d.db")
          }
        }),
      (error: unknown) => codeOf(error) === "STORE_BINDING_INVALID"
    );
  } finally {
    root.cleanup();
  }
});

test("a missing, relative, or omitted store path refuses", () => {
  const root = temporaryStoreRoot("bind-missing");
  try {
    const paths = storePathsFor(root);
    assert.throws(
      () =>
        bindDurableStores({
          plan: syntheticStorePlan(),
          storePaths: { ...paths, "receipt-journal": "" }
        }),
      (error: unknown) => codeOf(error) === "STORE_BINDING_INVALID"
    );
    assert.throws(
      () =>
        bindDurableStores({
          plan: syntheticStorePlan(),
          storePaths: { ...paths, "receipt-journal": "relative/path.db" }
        }),
      (error: unknown) => codeOf(error) === "STORE_PATH_INVALID"
    );
  } finally {
    root.cleanup();
  }
});

test("an omitted or duplicated contract store refuses", () => {
  const root = temporaryStoreRoot("bind-set");
  try {
    const plan = syntheticStorePlan();
    const short = {
      ...plan,
      durableStores: plan.durableStores.slice(0, 3)
    } as typeof plan;
    assert.throws(
      () => bindDurableStores({ plan: short, storePaths: storePathsFor(root) }),
      (error: unknown) => codeOf(error) === "STORE_BINDING_INVALID"
    );

    const duplicated = {
      ...plan,
      durableStores: [...plan.durableStores, plan.durableStores[0]!]
    } as typeof plan;
    assert.throws(
      () => bindDurableStores({ plan: duplicated, storePaths: storePathsFor(root) }),
      (error: unknown) => codeOf(error) === "STORE_BINDING_INVALID"
    );
  } finally {
    root.cleanup();
  }
});

test("a store shared with a model runner refuses", () => {
  const root = temporaryStoreRoot("bind-isolation");
  try {
    const plan = syntheticStorePlan();
    const leaky = {
      ...plan,
      durableStores: plan.durableStores.map((store, index) =>
        index === 0
          ? {
              ...store,
              isolation: { dedicatedCredential: true, sharedWithModelRunner: true }
            }
          : store
      )
    } as unknown as typeof plan;
    assert.throws(
      () => bindDurableStores({ plan: leaky, storePaths: storePathsFor(root) }),
      (error: unknown) => codeOf(error) === "STORE_BINDING_INVALID"
    );
  } finally {
    root.cleanup();
  }
});

test("a bound store opens under its contract store id", async () => {
  const root = temporaryStoreRoot("bind-open");
  const bindings = bindDurableStores({
    plan: syntheticStorePlan(),
    storePaths: storePathsFor(root)
  });
  const binding = bindings.find((entry) => entry.storeId === "evidence-store");
  assert.ok(binding);
  const store = openBoundDurableStore({
    binding,
    busyTimeoutMs: BUSY_TIMEOUT_MS,
    supportedNodeMajors: SUPPORTED_NODE_MAJORS
  });
  try {
    assert.equal(store.metadata.storeId, "evidence-store");
    const result = await store.appendOnce({
      namespace: "evidence",
      key: "e1",
      body: { effect: 1 }
    });
    assert.equal(result.status, "appended");
  } finally {
    store.close();
    root.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Refusal taxonomy completeness
//
// Every substrate failure must carry an exact code. A raw driver error escaping
// would be reported by callers as an unexpected internal fault rather than as
// the specific, actionable condition it is.
// ---------------------------------------------------------------------------

test("an unopenable path refuses with a typed code, not a driver error", () => {
  const root = temporaryStoreRoot("unopenable");
  try {
    assert.throws(
      () => open(root.pathFor("missing-directory/s.db")),
      (error: unknown) => codeOf(error) === "STORE_PATH_INVALID"
    );
  } finally {
    root.cleanup();
  }
});

test("compareAndSwap does not report existing for a head it never held", async () => {
  const root = temporaryStoreRoot("cas-existing");
  const store = open(root.pathFor("s.db"));
  try {
    const genesis = await store.compareAndSwap({
      namespace: "state",
      key: "s1",
      expectedHead: null,
      body: { generation: 1 }
    });
    assert.equal(genesis.status, "appended");

    // Replaying the *same* write with its original expected head is a genuine
    // idempotent retry and must still be `existing`.
    const retry = await store.compareAndSwap({
      namespace: "state",
      key: "s1",
      expectedHead: null,
      body: { generation: 1 }
    });
    assert.equal(retry.status, "existing");

    // Advance the chain so the head moves.
    await store.compareAndSwap({
      namespace: "state",
      key: "s2",
      expectedHead: genesis.record?.head ?? null,
      body: { generation: 2 }
    });

    // A caller fencing against a head that was never in this chain must get
    // `conflict`, even though the body happens to match.
    const bogus = await store.compareAndSwap({
      namespace: "state",
      key: "s1",
      expectedHead: digest({ never: "a head" }),
      body: { generation: 1 }
    });
    assert.equal(
      bogus.status,
      "conflict",
      "existing must mean 'my write landed', not 'some identical write landed'"
    );
  } finally {
    store.close();
    root.cleanup();
  }
});

test("a desynced entry count is detected instead of silently widening the bound", async () => {
  const root = temporaryStoreRoot("entry-count");
  const file = root.pathFor("s.db");
  const store = openBounded(file, 3);
  try {
    for (const index of [1, 2, 3]) {
      await store.appendOnce({
        namespace: "journal",
        key: `k${index}`,
        body: { index }
      });
    }
  } finally {
    store.close();
  }

  // `entry_count` is not covered by the hash chain, so it is the one field an
  // attacker could edit without breaking a single link.
  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(file);
  raw.exec("UPDATE durable_head SET entry_count = 0 WHERE namespace='journal'");
  raw.close();

  const reopened = openBounded(file, 3);
  try {
    await assert.rejects(
      reopened.readHead("journal"),
      (error: unknown) => codeOf(error) === "CHAIN_INVALID"
    );
    await assert.rejects(
      reopened.verifyChain("journal"),
      (error: unknown) => codeOf(error) === "CHAIN_INVALID"
    );
    // The capacity bound cannot be bypassed through the tampered counter.
    await assert.rejects(
      reopened.appendOnce({ namespace: "journal", key: "bypass", body: { x: 1 } }),
      (error: unknown) =>
        codeOf(error) === "CHAIN_INVALID" || codeOf(error) === "CAPACITY_EXHAUSTED"
    );
  } finally {
    reopened.close();
    root.cleanup();
  }
});

test("a forged genesis predecessor is detected by a single read", async () => {
  const root = temporaryStoreRoot("forged-genesis");
  const file = root.pathFor("s.db");
  const store = open(file);
  try {
    await store.appendOnce({ namespace: "journal", key: "k1", body: { index: 1 } });
    await store.appendOnce({ namespace: "journal", key: "k2", body: { index: 2 } });
  } finally {
    store.close();
  }

  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(file);
  raw.exec("UPDATE durable_record SET previous_head = NULL WHERE namespace='journal' AND sequence=2");
  raw.close();

  const reopened = open(file);
  try {
    await assert.rejects(
      reopened.read({ namespace: "journal", key: "k2" }),
      (error: unknown) => codeOf(error) === "CHAIN_INVALID"
    );
  } finally {
    reopened.close();
    root.cleanup();
  }
});

test("a logical name longer than the published schema bound refuses", async () => {
  const root = temporaryStoreRoot("name-bound");
  const store = open(root.pathFor("s.db"));
  try {
    await assert.rejects(
      store.appendOnce({ namespace: "j", key: "k".repeat(129), body: {} }),
      (error: unknown) => codeOf(error) === "ARGUMENT_INVALID"
    );
    const atBound = await store.appendOnce({
      namespace: "j",
      key: "k".repeat(128),
      body: {}
    });
    assert.equal(atBound.status, "appended");
  } finally {
    store.close();
    root.cleanup();
  }
});
