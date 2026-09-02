/**
 * Deterministic proof for the domain and engineering durable store adapters.
 *
 * The substrate tests prove that the *store* is
 * durable. These tests prove the separate claim that each adapter maps its port
 * onto that store without losing a guarantee: that a fence is atomic rather
 * than advisory, that a replay is refused rather than re-honoured, that a
 * `void`-returning port cannot report success for a write that did not land,
 * and that all of it survives a restart, a second process, a corrupted row, a
 * full journal, a restored backup, and a lost commit acknowledgement.
 *
 * Where a port's caller in `src/` exposes its validator, these tests run the
 * *real* validator against the adapter's output rather than re-implementing the
 * caller's expectations. That is the point of the head-fidelity convention in
 * `tests/support/durable-substrate-harness.ts`: an adapter checked only against
 * its own view of itself is not checked at all.
 */

import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { copyFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { canonicalJson, digest } from "../src/canonical.js";
import type { DurableStoreId } from "../src/deployment-topology.js";
import type {
  DomainDetachedSignature,
  DomainEvidenceSigner,
  DomainEvidenceVerifier,
  DomainOperationGrantClaim,
  DomainOperationGrantStore
} from "../src/domain-packs.js";
import {
  DurableDomainStoreError,
  openDurableDomainOperationGrantStore
} from "../src/durable-domain-stores.js";
import {
  DurableEngineeringAmbiguityError,
  DurableEngineeringStoreError,
  openDurableEngineeringClosureCheckpointStore,
  openDurableEngineeringCostLedger,
  openDurableEngineeringEvidenceStore,
  openDurableEngineeringProviderEvidence,
  openDurableEngineeringProviderUsageLedger,
  type DurableProviderEvidence,
  type DurableProviderUsageObserver
} from "../src/durable-engineering-stores.js";
import {
  bindDurableStores,
  openBoundDurableStore
} from "../src/durable-store-binding.js";
import {
  DurableAmbiguousAcknowledgementError,
  DurableSubstrateError,
  type DurableSubstrate,
  type DurableWriteOutcome
} from "../src/durable-substrate.js";
import {
  EngineeringEvidenceConflictError,
  validateCostRelease,
  validateCostReservation,
  validateCostSettlement,
  validateProviderAttempt,
  validateProviderUsage,
  type DetachedSignature,
  type EngineeringCostReservation,
  type EngineeringCostHold,
  type EngineeringCostRelease,
  type EngineeringCostSettlement,
  type EngineeringEffectEvidence,
  type EngineeringProviderAttempt,
  type EvidenceSigner,
  type EvidenceVerifier
} from "../src/engineering-slice.js";
import * as publicApi from "../src/index.js";
import type { Digest } from "../src/types.js";
import {
  BUSY_TIMEOUT_MS,
  SUPPORTED_NODE_MAJORS,
  assertCallerHeadFidelity,
  harnessSignature,
  storePathsFor,
  syntheticStorePlan,
  temporaryStoreRoot
} from "./support/durable-substrate-harness.js";
import type {
  AdapterWorkerReply,
  AdapterWorkerRequest
} from "./support/durable-domain-engineering-worker.js";

const WORKER = path.join(
  import.meta.dirname,
  "support",
  "durable-domain-engineering-worker.js"
);

const NOW = "2026-08-30T12:00:00.000Z";
const GRANT_CHECKED_AT = "2026-08-30T11:59:00.000Z";
const GRANT_EXPIRES_AT = "2026-08-30T13:00:00.000Z";
const BUDGET_EXPIRES_AT = "2026-08-30T18:00:00.000Z";
const MAX_AGE_MS = 6 * 60 * 60 * 1_000;
const HEAD_VALIDITY_MS = 60_000;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Root = ReturnType<typeof temporaryStoreRoot>;

/**
 * Opens one plan-bound store. The identity, backend namespace, and journal
 * bound all come from a validated topology plan, exactly as production binding
 * would supply them, so no test can quietly widen a bound the plan sets.
 */
function openStore(
  root: Root,
  storeId: DurableStoreId,
  maxEntries = 512
): DurableSubstrate {
  const bindings = bindDurableStores({
    plan: syntheticStorePlan({ maxEntries }),
    storePaths: storePathsFor(root)
  });
  const binding = bindings.find((candidate) => candidate.storeId === storeId);
  assert.ok(binding !== undefined, `no binding for ${storeId}`);
  return openBoundDurableStore({
    binding,
    busyTimeoutMs: BUSY_TIMEOUT_MS,
    supportedNodeMajors: SUPPORTED_NODE_MAJORS
  });
}

function pathFor(root: Root, storeId: DurableStoreId): string {
  return storePathsFor(root)[storeId];
}

/** A deterministic domain signer that binds the purpose into the signature. */
function domainSignature(payload: unknown, purpose: string): DomainDetachedSignature {
  return {
    algorithm: "ed25519",
    keyId: "durable:key-1",
    // base64url: the published signature schema accepts only `[A-Za-z0-9_-]`,
    // so a padded standard-base64 value would be rejected by the very document
    // validation these tests are checking.
    value: Buffer.from(digest({ payload, purpose }), "utf8").toString("base64url")
  };
}

const domainSigner: DomainEvidenceSigner = {
  sign: (payload, purpose) => domainSignature(payload, purpose)
};

const domainVerifier: DomainEvidenceVerifier = {
  verify: (payload, signature, purpose) =>
    signature.algorithm === "ed25519" &&
    signature.value === domainSignature(payload, purpose).value
};

const evidenceSigner: EvidenceSigner = {
  sign: async (payload): Promise<DetachedSignature> => harnessSignature(payload)
};

const evidenceVerifier: EvidenceVerifier = {
  verify: (payload, signature) =>
    signature.algorithm === "ed25519" &&
    signature.value === harnessSignature(payload, signature.keyId).value
};

function grantStore(substrate: DurableSubstrate, now = NOW): DomainOperationGrantStore {
  return openDurableDomainOperationGrantStore({
    substrate,
    storeId: "operation-grant-store",
    clock: { now: () => now },
    signer: domainSigner,
    headValidityMs: HEAD_VALIDITY_MS
  });
}

function claimRequest(
  overrides: Partial<Parameters<DomainOperationGrantStore["claim"]>[0]> = {}
): Parameters<DomainOperationGrantStore["claim"]>[0] {
  return {
    storeId: "operation-grant-store",
    claimChallenge: digest({ challenge: "claim-1" }),
    expectedPreviousHead: null,
    expectedStoreSequence: 0,
    grantDigest: digest({ grant: 1 }),
    redemptionKey: digest({ redemption: 1 }),
    operation: "repository-package",
    contextDigest: digest({ context: 1 }),
    repositoryIdentityDigest: digest({ repository: 1 }),
    runId: "run-1",
    runAttempt: 1,
    operationSequence: 1,
    grantCheckedAt: GRANT_CHECKED_AT,
    grantExpiresAt: GRANT_EXPIRES_AT,
    ...overrides
  };
}

/** The head the caller recomputes in `DomainGitPackager.#validGrantClaim`. */
function callerRecomputedClaimHead(claim: DomainOperationGrantClaim): Digest {
  const { signature: _signature, head: _head, ...payload } = claim;
  return digest(payload);
}

function effectEvidence(
  overrides: Partial<Omit<EngineeringEffectEvidence, "signature">> = {}
): EngineeringEffectEvidence {
  const payload = {
    sequence: 1,
    previousEvidenceDigest: null,
    effectKey: digest({ effect: "key-1" }),
    effectOrdinal: 1,
    effectType: "create-branch" as const,
    workflowId: "workflow-1",
    contractRevision: 1,
    planDigest: digest({ plan: 1 }),
    bindingDigest: digest({ binding: 1 }),
    state: "pending" as const,
    effectDigest: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
  return { ...payload, signature: harnessSignature(payload) };
}

function awaitingCheckpoint(
  bindingDigest: Digest,
  marker: string
): { readonly bindingDigest: Digest; readonly stage: "awaiting-human-merge"; readonly marker: string } {
  // The checkpoint families are stored verbatim and read back by binding
  // digest; only the fields the adapter itself inspects need to be real, so the
  // fixture stays legible rather than restating a 25-field contract document.
  return { bindingDigest, stage: "awaiting-human-merge", marker };
}

const PHASE_BUDGETS = { framing: 10, execution: 20, verification: 6 } as const;
const PHASE_TOKEN_BUDGETS = {
  framing: 100,
  execution: 400,
  verification: 60
} as const;

function costLedger(
  substrate: DurableSubstrate,
  totalBudgetCostUnits = 100,
  providerEvidence: DurableProviderEvidence = emptyProviderEvidence
) {
  return openDurableEngineeringCostLedger({
    substrate,
    signer: evidenceSigner,
    providerEvidence,
    totalBudgetCostUnits
  });
}

/**
 * Provider evidence for the ledger tests that never begin an attempt. It is a
 * truthful view of an empty receipt journal, not a stub that waves the checks
 * through: any test that settles or holds an attempt uses `ledgerRig`, which
 * wires the real journal.
 */
const emptyProviderEvidence: DurableProviderEvidence = {
  listAttempts: async () => [],
  readUsage: async () => null
};

/** The signed portion of a cost hold, mirroring the module's own payload split. */
function costHoldPayloadOf(
  hold: EngineeringCostHold
): Omit<EngineeringCostHold, "signature"> {
  const { signature: _signature, ...payload } = hold;
  return payload;
}

/** The signed portion of a cost release. */
function costReleasePayloadOf(
  release: EngineeringCostRelease
): Omit<EngineeringCostRelease, "signature"> {
  const { signature: _signature, ...payload } = release;
  return payload;
}

function usageObserver(
  answer: (attempt: EngineeringProviderAttempt) => {
    readonly actualCostUnits: number;
    readonly actualCalls: number;
    readonly actualTokens: number;
    readonly providerUsageDigest: Digest;
  } | null
): DurableProviderUsageObserver {
  return { observe: async ({ attempt }) => answer(attempt) };
}

function reconciliationExpiry(expiresAt: string): string {
  return new Date(Date.parse(expiresAt) + 24 * 60 * 60 * 1_000).toISOString();
}

async function reserveFixture(
  ledger: ReturnType<typeof costLedger>
): Promise<EngineeringCostReservation> {
  return ledger.reserve({
    workAccordDigest: digest({ accord: 1 }),
    activationLeaseDigest: digest({ lease: 1 }),
    phaseBudgets: PHASE_BUDGETS,
    phaseTokenBudgets: PHASE_TOKEN_BUDGETS,
    maxCalls: 3,
    maxTokens: 1_000,
    now: NOW,
    expiresAt: BUDGET_EXPIRES_AT
  });
}

async function mutate(file: string, statement: string): Promise<void> {
  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(file);
  raw.exec(statement);
  raw.close();
}

/**
 * Rewrites one stored record's body in place, keeping the body digest
 * consistent so only an adapter's own re-derivation can detect the change.
 * The column is a BLOB, so the replacement is bound as bytes rather than text.
 */
async function rewriteBody(
  file: string,
  key: string,
  body: unknown
): Promise<void> {
  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(file);
  raw
    .prepare(
      "UPDATE durable_record SET body = ?, body_digest = ? WHERE key = ?"
    )
    .run(Buffer.from(canonicalJson(body), "utf8"), digest(body), key);
  raw.close();
}

function domainCodeOf(error: unknown): string {
  assert.ok(
    error instanceof DurableDomainStoreError,
    `expected a domain adapter refusal, got ${String(error)}`
  );
  return error.code;
}

function engineeringCodeOf(error: unknown): string {
  assert.ok(
    error instanceof DurableEngineeringStoreError,
    `expected an engineering adapter refusal, got ${String(error)}`
  );
  return error.code;
}

/**
 * Wraps a real substrate so a single call can be made to lie.
 *
 * This is how the `void`-returning ports are held to their postcondition: a
 * store that acknowledges a write it never performed is exactly the failure a
 * caller cannot see, so the adapter must catch it and refuse.
 */
function lyingSubstrate(
  inner: DurableSubstrate,
  overrides: Partial<DurableSubstrate>
): DurableSubstrate {
  return Object.freeze({
    metadata: inner.metadata,
    appendOnce: overrides.appendOnce ?? inner.appendOnce.bind(inner),
    compareAndSwap: overrides.compareAndSwap ?? inner.compareAndSwap.bind(inner),
    read: overrides.read ?? inner.read.bind(inner),
    readHead: overrides.readHead ?? inner.readHead.bind(inner),
    readCurrent: overrides.readCurrent ?? inner.readCurrent.bind(inner),
    verifyChain: overrides.verifyChain ?? inner.verifyChain.bind(inner),
    inventory: overrides.inventory ?? inner.inventory.bind(inner),
    backup: overrides.backup ?? inner.backup.bind(inner),
    close: () => inner.close()
  }) as DurableSubstrate;
}

/**
 * Injects a fault at exactly the COMMIT boundary of the next *write*
 * transaction.
 *
 * Scoping this to a write matters. Both adapters read the journal before they
 * write, and `verifyChain` closes its read snapshot with a `COMMIT` whose
 * failure it deliberately swallows. An injector that fired on any `COMMIT`
 * would therefore be consumed by that read, silently discarded, and the real
 * write would commit normally — leaving the ambiguity path untested while the
 * test still passed.
 */
function injectCommitFailure(
  DatabaseSyncCtor: {
    prototype: { exec: (statement: string) => void };
  },
  mode: "before-commit" | "after-commit" = "before-commit"
): { fired: () => boolean; restore: () => void } {
  const original = DatabaseSyncCtor.prototype.exec;
  let fired = false;
  let inWrite = false;
  DatabaseSyncCtor.prototype.exec = function patched(
    this: unknown,
    statement: string
  ): void {
    if (statement === "BEGIN IMMEDIATE") inWrite = true;
    if (statement === "COMMIT" && inWrite && !fired) {
      fired = true;
      inWrite = false;
      // `after-commit` reproduces the harder half of the ambiguity: the write
      // genuinely landed and only the acknowledgement was lost.
      if (mode === "after-commit") original.call(this, statement);
      throw new Error("simulated lost commit acknowledgement");
    }
    if (statement === "COMMIT" || statement === "ROLLBACK") inWrite = false;
    return original.call(this, statement);
  };
  return {
    fired: () => fired,
    restore: () => {
      DatabaseSyncCtor.prototype.exec = original;
    }
  };
}

async function runWorkers(
  requests: readonly AdapterWorkerRequest[]
): Promise<readonly AdapterWorkerReply[]> {
  const children = requests.map((request) =>
    fork(WORKER, [JSON.stringify(request)], { stdio: "inherit" })
  );
  let arrived = 0;
  let settledEarly = 0;
  const release = (): void => {
    if (arrived + settledEarly < children.length) return;
    for (const child of children) {
      if (!child.connected) continue;
      try {
        // The callback form absorbs a failed send instead of emitting an
        // `error` on the child: a peer that has already exited is expected
        // here, and must not be reported as a harness failure.
        child.send({ type: "go" }, () => {
          /* the peer may have exited between the check and the send */
        });
      } catch {
        /* same race, observed synchronously */
      }
    }
  };

  const results = children.map(
    (child, index) =>
      new Promise<AdapterWorkerReply>((resolve, reject) => {
        let reply: AdapterWorkerReply | null = null;
        child.on("message", (message) => {
          if ((message as { readonly type?: unknown }).type === "ready") {
            arrived += 1;
            // Release only once every worker is parked immediately before its
            // contended write. This is what makes the writes actually overlap;
            // a timed barrier would let a late worker miss the contention
            // entirely and the race tests would prove nothing.
            release();
            return;
          }
          reply = message as AdapterWorkerReply;
        });
        child.on("error", reject);
        child.on("exit", (code) => {
          // A worker that dies before arriving must not deadlock its peers.
          settledEarly += 1;
          release();
          if (reply === null) {
            reject(new Error(`worker ${String(index)} exited without reporting`));
            return;
          }
          if (code !== 0) {
            reject(
              new Error(
                `worker exited with code ${String(code)}: ${reply.errors.join("; ")}`
              )
            );
            return;
          }
          resolve(reply);
        });
      })
  );
  return Promise.all(results);
}

// ---------------------------------------------------------------------------
// Binding: an adapter may only be wired to the store its contract names
// ---------------------------------------------------------------------------

test("every adapter refuses a substrate bound to the wrong durable store", () => {
  const root = temporaryStoreRoot("adapter-binding");
  const evidence = openStore(root, "evidence-store");
  const journal = openStore(root, "receipt-journal");
  try {
    assert.throws(
      () => grantStore(evidence),
      (error: unknown) => domainCodeOf(error) === "ADAPTER_BINDING_INVALID"
    );
    assert.throws(
      () => openDurableEngineeringEvidenceStore({ substrate: journal }),
      (error: unknown) => engineeringCodeOf(error) === "ADAPTER_BINDING_INVALID"
    );
    assert.throws(
      () => openDurableEngineeringClosureCheckpointStore({ substrate: journal }),
      (error: unknown) => engineeringCodeOf(error) === "ADAPTER_BINDING_INVALID"
    );
    assert.throws(
      () => costLedger(evidence),
      (error: unknown) => engineeringCodeOf(error) === "ADAPTER_BINDING_INVALID"
    );
    assert.throws(
      () =>
        openDurableEngineeringProviderUsageLedger({
          substrate: evidence,
          signer: evidenceSigner,
          observer: usageObserver(() => null)
        }),
      (error: unknown) => engineeringCodeOf(error) === "ADAPTER_BINDING_INVALID"
    );
  } finally {
    evidence.close();
    journal.close();
    root.cleanup();
  }
});

test("the cost ledger refuses a budget it was not given", () => {
  const root = temporaryStoreRoot("adapter-budget");
  const store = openStore(root, "runtime-state-store");
  try {
    assert.throws(
      () => costLedger(store, -1),
      (error: unknown) => engineeringCodeOf(error) === "ADAPTER_BINDING_INVALID"
    );
  } finally {
    store.close();
    root.cleanup();
  }
});

// ---------------------------------------------------------------------------
// DomainOperationGrantStore
// ---------------------------------------------------------------------------

test("a genesis store head is signed, schema-valid, and reports no predecessor", async () => {
  const root = temporaryStoreRoot("grant-genesis");
  const substrate = openStore(root, "operation-grant-store");
  try {
    const store = grantStore(substrate);
    const challenge = digest({ challenge: "head-1" });
    const head = await store.readHead({
      storeId: "operation-grant-store",
      challenge
    });
    assert.equal(head.purpose, "domain-operation-grant-store-head");
    assert.equal(head.storeSequence, 0);
    assert.equal(head.head, null);
    assert.equal(head.challenge, challenge);
    const { signature, ...unsigned } = head;
    assert.ok(
      domainVerifier.verify(
        unsigned,
        signature,
        "domain-operation-grant-store-head"
      ),
      "the head must verify under the purpose the caller checks"
    );
  } finally {
    substrate.close();
    root.cleanup();
  }
});

test("a claim advances the store and matches the head its caller recomputes", async () => {
  const root = temporaryStoreRoot("grant-claim");
  const substrate = openStore(root, "operation-grant-store");
  try {
    const store = grantStore(substrate);
    const before = await store.readHead({
      storeId: "operation-grant-store",
      challenge: digest({ challenge: "head-1" })
    });
    const request = claimRequest({
      expectedPreviousHead: before.head,
      expectedStoreSequence: before.storeSequence
    });
    const claim = await store.claim(request);
    assert.ok(claim !== null, "the first claim on a genesis store must succeed");

    // Caller fidelity: `#validGrantClaim` recomputes the head from the claim
    // minus its signature and minus the head itself.
    assertCallerHeadFidelity({
      label: "domain operation grant claim",
      callerRecomputedHead: callerRecomputedClaimHead(claim),
      receiptHead: claim.head
    });
    assert.equal(claim.casResult, "appended");
    assert.equal(claim.previousHead, request.expectedPreviousHead);
    assert.equal(claim.storeSequence, request.expectedStoreSequence + 1);
    assert.equal(claim.redemptionKey, request.redemptionKey);
    assert.equal(claim.grantDigest, request.grantDigest);
    const { signature, ...unsigned } = claim;
    assert.ok(
      domainVerifier.verify(unsigned, signature, "domain-operation-grant-claim")
    );

    const after = await store.readHead({
      storeId: "operation-grant-store",
      challenge: digest({ challenge: "head-2" })
    });
    assert.equal(after.storeSequence, 1);
    assert.equal(
      after.head,
      claim.head,
      "the published head must be the claim's own head, not the substrate's chain link"
    );
  } finally {
    substrate.close();
    root.cleanup();
  }
});

test("a redemption key may be spent exactly once", async () => {
  const root = temporaryStoreRoot("grant-replay");
  const substrate = openStore(root, "operation-grant-store");
  try {
    const store = grantStore(substrate);
    const first = await store.claim(claimRequest());
    assert.ok(first !== null);

    // Replayed with a correct fresh fence and a new operation slot: only the
    // redemption key repeats, and that alone must refuse.
    const replay = await store.claim(
      claimRequest({
        expectedPreviousHead: first.head,
        expectedStoreSequence: 1,
        claimChallenge: digest({ challenge: "claim-2" }),
        runId: "run-2",
        operationSequence: 2
      })
    );
    assert.equal(replay, null, "a spent redemption key must not be re-honoured");
    const head = await store.readHead({
      storeId: "operation-grant-store",
      challenge: digest({ challenge: "head-3" })
    });
    assert.equal(head.storeSequence, 1, "a refused claim must not advance the store");
  } finally {
    substrate.close();
    root.cleanup();
  }
});

test("one operation slot cannot be claimed twice under a fresh redemption key", async () => {
  const root = temporaryStoreRoot("grant-slot");
  const substrate = openStore(root, "operation-grant-store");
  try {
    const store = grantStore(substrate);
    const first = await store.claim(claimRequest());
    assert.ok(first !== null);
    const second = await store.claim(
      claimRequest({
        expectedPreviousHead: first.head,
        expectedStoreSequence: 1,
        redemptionKey: digest({ redemption: 2 }),
        claimChallenge: digest({ challenge: "claim-2" })
      })
    );
    assert.equal(
      second,
      null,
      "the same run/attempt/operation sequence must not be redeemed twice"
    );
  } finally {
    substrate.close();
    root.cleanup();
  }
});

test("a claim fencing on a moved head is refused without writing", async () => {
  const root = temporaryStoreRoot("grant-stale-fence");
  const substrate = openStore(root, "operation-grant-store");
  try {
    const store = grantStore(substrate);
    const first = await store.claim(claimRequest());
    assert.ok(first !== null);
    const stale = await store.claim(
      claimRequest({
        expectedPreviousHead: null,
        expectedStoreSequence: 0,
        redemptionKey: digest({ redemption: 3 }),
        runId: "run-3",
        operationSequence: 3
      })
    );
    assert.equal(stale, null);
    const chain = await substrate.verifyChain("domain.operation-grant-claims");
    assert.equal(chain.length, 1, "a refused claim must leave no record behind");
  } finally {
    substrate.close();
    root.cleanup();
  }
});

test("a claim whose fence disagrees with itself about genesis is refused", async () => {
  const root = temporaryStoreRoot("grant-fence-shape");
  const substrate = openStore(root, "operation-grant-store");
  try {
    const store = grantStore(substrate);
    await assert.rejects(
      store.claim(
        claimRequest({
          expectedPreviousHead: digest({ invented: true }),
          expectedStoreSequence: 0
        })
      ),
      (error: unknown) => domainCodeOf(error) === "ADAPTER_ARGUMENT_INVALID"
    );
  } finally {
    substrate.close();
    root.cleanup();
  }
});

test("a claim outside its own grant window is refused rather than signed", async () => {
  const root = temporaryStoreRoot("grant-window");
  const substrate = openStore(root, "operation-grant-store");
  try {
    // The clock is past the grant's expiry, so emitting a signed claim would
    // durably record evidence that is invalid the moment it is written.
    const store = grantStore(substrate, "2026-08-30T14:00:00.000Z");
    await assert.rejects(
      store.claim(claimRequest()),
      (error: unknown) => domainCodeOf(error) === "ADAPTER_OUTPUT_INVALID"
    );
    const chain = await substrate.verifyChain("domain.operation-grant-claims");
    assert.equal(chain.length, 0);
  } finally {
    substrate.close();
    root.cleanup();
  }
});

test("a claim for another store id is refused", async () => {
  const root = temporaryStoreRoot("grant-store-id");
  const substrate = openStore(root, "operation-grant-store");
  try {
    // The signed logical id must be the store's own durable identity: an alias
    // would let this adapter emit authentic-looking evidence under a name ADR
    // 0013's closed store set never defined.
    assert.throws(
      () =>
        openDurableDomainOperationGrantStore({
          substrate,
          storeId: "other-store",
          clock: { now: () => NOW },
          signer: domainSigner,
          headValidityMs: HEAD_VALIDITY_MS
        }),
      (error: unknown) => domainCodeOf(error) === "ADAPTER_BINDING_INVALID"
    );

    const store = grantStore(substrate);
    await assert.rejects(
      store.readHead({ storeId: "other-store", challenge: digest({ c: 1 }) }),
      (error: unknown) => domainCodeOf(error) === "ADAPTER_ARGUMENT_INVALID"
    );
    await assert.rejects(
      store.claim(claimRequest({ storeId: "other-store" })),
      (error: unknown) => domainCodeOf(error) === "ADAPTER_ARGUMENT_INVALID"
    );
  } finally {
    substrate.close();
    root.cleanup();
  }
});

test("a claim survives a restart and is still refused as a replay afterwards", async () => {
  const root = temporaryStoreRoot("grant-restart");
  const first = openStore(root, "operation-grant-store");
  let claimed: DomainOperationGrantClaim;
  try {
    const store = grantStore(first);
    const claim = await store.claim(claimRequest());
    assert.ok(claim !== null);
    claimed = claim;
  } finally {
    first.close();
  }

  const reopened = openStore(root, "operation-grant-store");
  try {
    const store = grantStore(reopened);
    const head = await store.readHead({
      storeId: "operation-grant-store",
      challenge: digest({ challenge: "after-restart" })
    });
    assert.equal(head.storeSequence, 1);
    assert.equal(head.head, claimed.head, "the head must survive the restart exactly");
    const replay = await store.claim(
      claimRequest({
        expectedPreviousHead: claimed.head,
        expectedStoreSequence: 1,
        claimChallenge: digest({ challenge: "claim-after-restart" }),
        runId: "run-9",
        operationSequence: 9
      })
    );
    assert.equal(replay, null, "replay refusal must be durable, not in-memory");
  } finally {
    reopened.close();
    root.cleanup();
  }
});

test("a rewritten claim body is detected instead of being republished as a head", async () => {
  const root = temporaryStoreRoot("grant-tamper");
  const store = openStore(root, "operation-grant-store");
  try {
    const grants = grantStore(store);
    assert.ok((await grants.claim(claimRequest())) !== null);
  } finally {
    store.close();
  }
  // Rewrite the stored claim's `runId` while leaving the body digest and chain
  // link intact, so only the adapter's own re-derivation can catch it.
  const file = pathFor(root, "operation-grant-store");
  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(file);
  const row = raw
    .prepare("SELECT body FROM durable_record WHERE key = 'claim.1'")
    .get() as { readonly body: Uint8Array };
  const body = JSON.parse(Buffer.from(row.body).toString("utf8")) as Record<
    string,
    unknown
  >;
  body["runId"] = "run-tampered";
  const rewritten = canonicalJson(body);
  raw
    .prepare("UPDATE durable_record SET body = ?, body_digest = ? WHERE key = 'claim.1'")
    .run(Buffer.from(rewritten, "utf8"), digest(body));
  raw.close();

  const reopened = openStore(root, "operation-grant-store");
  try {
    const grants = grantStore(reopened);
    await assert.rejects(
      grants.readHead({
        storeId: "operation-grant-store",
        challenge: digest({ challenge: "tampered" })
      }),
      (error: unknown) =>
        error instanceof DurableDomainStoreError ||
        error instanceof DurableSubstrateError
    );
  } finally {
    reopened.close();
    root.cleanup();
  }
});

test("a full journal refuses a claim rather than evicting evidence", async () => {
  const root = temporaryStoreRoot("grant-capacity");
  const substrate = openStore(root, "operation-grant-store", 1);
  try {
    const store = grantStore(substrate);
    const first = await store.claim(claimRequest());
    assert.ok(first !== null);
    await assert.rejects(
      store.claim(
        claimRequest({
          expectedPreviousHead: first.head,
          expectedStoreSequence: 1,
          redemptionKey: digest({ redemption: 4 }),
          runId: "run-4",
          operationSequence: 4,
          claimChallenge: digest({ challenge: "claim-4" })
        })
      ),
      (error: unknown) =>
        error instanceof DurableSubstrateError &&
        error.code === "CAPACITY_EXHAUSTED"
    );
  } finally {
    substrate.close();
    root.cleanup();
  }
});

test("a restored backup keeps the head and keeps refusing the spent redemption", async () => {
  const root = temporaryStoreRoot("grant-backup");
  const source = openStore(root, "operation-grant-store");
  let claimed: DomainOperationGrantClaim;
  const backupPath = root.pathFor("grant-backup.db");
  try {
    const store = grantStore(source);
    const claim = await store.claim(claimRequest());
    assert.ok(claim !== null);
    claimed = claim;
    const manifest = await source.backup(backupPath);
    assert.equal(manifest.storeId, "operation-grant-store");
    assert.equal(manifest.entryCount, 1);
  } finally {
    source.close();
  }

  // Restore over the live file, exactly as the recovery runbook describes.
  copyFileSync(backupPath, pathFor(root, "operation-grant-store"));
  const restored = openStore(root, "operation-grant-store");
  try {
    const store = grantStore(restored);
    const head = await store.readHead({
      storeId: "operation-grant-store",
      challenge: digest({ challenge: "restored" })
    });
    assert.equal(head.storeSequence, 1);
    assert.equal(head.head, claimed.head);
    const replay = await store.claim(
      claimRequest({
        expectedPreviousHead: claimed.head,
        expectedStoreSequence: 1,
        claimChallenge: digest({ challenge: "restored-claim" }),
        runId: "run-restored",
        operationSequence: 5
      })
    );
    assert.equal(
      replay,
      null,
      "a restored store must not resurrect a spent redemption key as unspent"
    );
  } finally {
    restored.close();
    root.cleanup();
  }
});

test("a lost commit acknowledgement resolves against durable state, never by guessing", async () => {
  const root = temporaryStoreRoot("grant-ambiguous");
  const substrate = openStore(root, "operation-grant-store");
  const { DatabaseSync } = await import("node:sqlite");
  try {
    const store = grantStore(substrate);
    const fault = injectCommitFailure(DatabaseSync);
    let claim: DomainOperationGrantClaim | null;
    try {
      claim = await store.claim(claimRequest());
    } finally {
      fault.restore();
    }
    assert.ok(fault.fired(), "the write commit fault must have been exercised");

    // The substrate rolls back before raising ambiguity, so the double-read
    // reconciliation finds the slot decidably empty. A decided "did not land"
    // is a refusal, never a guessed success.
    assert.equal(claim, null, "an unlanded ambiguous claim must resolve to null");
    const head = await store.readHead({
      storeId: "operation-grant-store",
      challenge: digest({ challenge: "post-ambiguity" })
    });
    assert.equal(head.storeSequence, 0);
    assert.equal(head.head, null);
    const chain = await substrate.verifyChain("domain.operation-grant-claims");
    assert.equal(chain.length, 0, "nothing may be left behind");

    // The store stays usable: ambiguity concerned what was written, never the
    // connection, so the very next claim succeeds normally.
    const recovered = await store.claim(claimRequest());
    assert.ok(recovered !== null, "the store must remain writable after ambiguity");
    assert.equal(recovered.storeSequence, 1);
  } finally {
    substrate.close();
    root.cleanup();
  }
});

test("a claim whose write landed but whose acknowledgement was lost stays undecided", async () => {
  const root = temporaryStoreRoot("grant-landed-ambiguous");
  const substrate = openStore(root, "operation-grant-store");
  const { DatabaseSync } = await import("node:sqlite");
  try {
    const store = grantStore(substrate);
    const fault = injectCommitFailure(DatabaseSync, "after-commit");
    try {
      await assert.rejects(
        store.claim(claimRequest()),
        (error: unknown) =>
          domainCodeOf(error) === "ADAPTER_ACKNOWLEDGEMENT_AMBIGUOUS"
      );
    } finally {
      fault.restore();
    }
    assert.ok(fault.fired(), "the write commit fault must have been exercised");

    // The record really is durably present, and the adapter still refuses to
    // hand back a receipt. It cannot distinguish "my write landed" from "an
    // identical concurrent write landed", and inventing that distinction is
    // exactly how one operation slot ends up redeemed twice.
    const chain = await substrate.verifyChain("domain.operation-grant-claims");
    assert.equal(chain.length, 1, "the landed write must not be rolled back");
    const head = await store.readHead({
      storeId: "operation-grant-store",
      challenge: digest({ challenge: "post-landed-ambiguity" })
    });
    assert.equal(head.storeSequence, 1);

    // The spent redemption key stays spent, so the ambiguity cannot be
    // resolved by simply trying again.
    const retry = await store.claim(
      claimRequest({
        expectedPreviousHead: head.head,
        expectedStoreSequence: 1
      })
    );
    assert.equal(retry, null);
  } finally {
    substrate.close();
    root.cleanup();
  }
});

test("an ambiguous write that cannot be resolved stays ambiguous", async () => {
  const root = temporaryStoreRoot("evidence-unresolvable");
  const inner = openStore(root, "evidence-store");
  try {
    // The two reconciliation reads disagree, so durable state has not settled.
    // Collapsing that into either a conflict or a success would report a known
    // outcome where there is none.
    let reads = 0;
    const unstable = lyingSubstrate(inner, {
      appendOnce: async () => {
        throw new DurableAmbiguousAcknowledgementError(
          "engineering.effect-evidence",
          "evidence.1"
        );
      },
      read: async (request) => {
        reads += 1;
        return reads === 1
          ? null
          : {
              namespace: request.namespace,
              key: request.key,
              sequence: 1,
              previousHead: null,
              head: digest({ head: 1 }),
              bodyDigest: digest({ body: 1 }),
              body: { drifting: true }
            };
      }
    });
    const store = openDurableEngineeringEvidenceStore({ substrate: unstable });
    await assert.rejects(
      store.conditionalAppend(null, effectEvidence()),
      (error: unknown) => {
        assert.ok(
          error instanceof DurableEngineeringAmbiguityError,
          `expected ambiguity, got ${String(error)}`
        );
        assert.ok(
          !(error instanceof EngineeringEvidenceConflictError),
          "ambiguity must not be reported as a conflict, which means 'did not land'"
        );
        return true;
      }
    );
    assert.equal(reads, 2, "reconciliation must read twice before deciding");
  } finally {
    inner.close();
    root.cleanup();
  }
});

test("an acknowledged claim that is not durably present is refused, not returned", async () => {
  const root = temporaryStoreRoot("grant-lying-store");
  const inner = openStore(root, "operation-grant-store");
  try {
    // A substrate that reports success without writing is indistinguishable
    // from a working one unless the adapter proves the postcondition itself.
    const liar = lyingSubstrate(inner, {
      appendOnce: async (): Promise<DurableWriteOutcome> => ({
        status: "appended",
        record: null
      })
    });
    const store = grantStore(liar);
    await assert.rejects(
      store.claim(claimRequest()),
      (error: unknown) => domainCodeOf(error) === "ADAPTER_OUTPUT_INVALID"
    );
  } finally {
    inner.close();
    root.cleanup();
  }
});

test("two processes racing one operation slot produce exactly one claim", async () => {
  for (const identical of [false, true]) {
    const root = temporaryStoreRoot(
      `grant-multiprocess-${identical ? "identical" : "distinct"}`
    );
    const storePath = pathFor(root, "operation-grant-store");
    try {
      // Create the store once before forking. Concurrent *creation* races on
      // the substrate's own metadata row, which is a provisioning concern and
      // not the fence this test is about; a real deployment binds the store
      // before any caller opens it.
      openStore(root, "operation-grant-store").close();
      const requests: AdapterWorkerRequest[] = [0, 1, 2, 3].map((workerIndex) => ({
        scenario: "domain-claim-race",
        path: storePath,
        workerIndex,
        identical,
        maxEntries: 512,
        busyTimeoutMs: BUSY_TIMEOUT_MS,
        supportedNodeMajors: SUPPORTED_NODE_MAJORS,
        storeId: "operation-grant-store",
        storeNamespace: "namespace-operation-grant-store",
        now: NOW,
        grantCheckedAt: GRANT_CHECKED_AT,
        grantExpiresAt: GRANT_EXPIRES_AT,
        effectKey: digest({ effect: "unused" })
      }));
      const replies = await runWorkers(requests);
      const claimed = replies.reduce((sum, reply) => sum + reply.claimed, 0);
      const refused = replies.reduce((sum, reply) => sum + reply.refused, 0);
      const errors = replies.flatMap((reply) => reply.errors);
      assert.deepEqual(errors, [], "no worker may fail with an unexpected error");
      assert.equal(
        claimed,
        1,
        `exactly one process may win a slot fenced on the same store head (identical bodies: ${String(identical)})`
      );
      assert.equal(
        refused,
        3,
        "every loser must be refused, not served a second receipt"
      );

      const substrate = openStore(root, "operation-grant-store");
      try {
        const chain = await substrate.verifyChain("domain.operation-grant-claims");
        assert.equal(chain.length, 1, "the loser must leave no record");
      } finally {
        substrate.close();
      }
    } finally {
      root.cleanup();
    }
  }
});

// ---------------------------------------------------------------------------
// EngineeringEvidenceStore
// ---------------------------------------------------------------------------

test("effect evidence appends from genesis and reads back exactly", async () => {
  const root = temporaryStoreRoot("evidence-genesis");
  const substrate = openStore(root, "evidence-store");
  try {
    const store = openDurableEngineeringEvidenceStore({ substrate });
    const evidence = effectEvidence();
    assert.equal(await store.read(evidence.effectKey), null);
    await store.conditionalAppend(null, evidence);
    const stored = await store.read(evidence.effectKey);
    assert.equal(canonicalJson(stored), canonicalJson(evidence));
    assert.ok(
      evidenceVerifier.verify(
        (() => {
          const { signature: _signature, ...payload } = evidence;
          return payload;
        })(),
        evidence.signature
      )
    );
  } finally {
    substrate.close();
    root.cleanup();
  }
});

test("effect evidence advances only from its exact expected predecessor", async () => {
  const root = temporaryStoreRoot("evidence-cas");
  const substrate = openStore(root, "evidence-store");
  try {
    const store = openDurableEngineeringEvidenceStore({ substrate });
    const first = effectEvidence();
    await store.conditionalAppend(null, first);

    const second = effectEvidence({
      sequence: 2,
      previousEvidenceDigest: digest(first),
      state: "completed",
      effectDigest: digest({ effect: "done" }),
      updatedAt: "2026-08-30T12:05:00.000Z"
    });
    await store.conditionalAppend(first, second);
    assert.equal(canonicalJson(await store.read(first.effectKey)), canonicalJson(second));

    // A writer still holding the first record has a stale view and must lose.
    const stale = effectEvidence({
      sequence: 2,
      previousEvidenceDigest: digest(first),
      state: "rejected",
      updatedAt: "2026-08-30T12:06:00.000Z"
    });
    await assert.rejects(
      store.conditionalAppend(first, stale),
      (error: unknown) => error instanceof EngineeringEvidenceConflictError
    );
    assert.equal(
      canonicalJson(await store.read(first.effectKey)),
      canonicalJson(second),
      "a refused append must not overwrite the winner"
    );
  } finally {
    substrate.close();
    root.cleanup();
  }
});

test("a genesis append against an occupied chain conflicts", async () => {
  const root = temporaryStoreRoot("evidence-occupied");
  const substrate = openStore(root, "evidence-store");
  try {
    const store = openDurableEngineeringEvidenceStore({ substrate });
    const first = effectEvidence();
    await store.conditionalAppend(null, first);
    await assert.rejects(
      store.conditionalAppend(null, effectEvidence({ planDigest: digest({ plan: 2 }) })),
      (error: unknown) => error instanceof EngineeringEvidenceConflictError
    );
  } finally {
    substrate.close();
    root.cleanup();
  }
});

test("effect evidence that does not chain onto its predecessor is refused", async () => {
  const root = temporaryStoreRoot("evidence-chain");
  const substrate = openStore(root, "evidence-store");
  try {
    const store = openDurableEngineeringEvidenceStore({ substrate });
    const first = effectEvidence();
    await store.conditionalAppend(null, first);
    await assert.rejects(
      store.conditionalAppend(
        first,
        effectEvidence({
          sequence: 3,
          previousEvidenceDigest: digest(first),
          updatedAt: "2026-08-30T12:07:00.000Z"
        })
      ),
      (error: unknown) => engineeringCodeOf(error) === "ADAPTER_ARGUMENT_INVALID"
    );
    await assert.rejects(
      store.conditionalAppend(
        first,
        effectEvidence({
          sequence: 2,
          previousEvidenceDigest: digest({ invented: true }),
          updatedAt: "2026-08-30T12:07:00.000Z"
        })
      ),
      (error: unknown) => engineeringCodeOf(error) === "ADAPTER_ARGUMENT_INVALID"
    );
  } finally {
    substrate.close();
    root.cleanup();
  }
});

test("each effect key keeps an independent chain", async () => {
  const root = temporaryStoreRoot("evidence-independent");
  const substrate = openStore(root, "evidence-store");
  try {
    const store = openDurableEngineeringEvidenceStore({ substrate });
    const a = effectEvidence({ effectKey: digest({ effect: "a" }) });
    const b = effectEvidence({ effectKey: digest({ effect: "b" }) });
    await store.conditionalAppend(null, a);
    // Recording `b` must not move `a`'s head, or a caller holding `a` would be
    // told its view is stale because an unrelated effect happened.
    await store.conditionalAppend(null, b);
    assert.equal(canonicalJson(await store.read(a.effectKey)), canonicalJson(a));
    assert.equal(canonicalJson(await store.read(b.effectKey)), canonicalJson(b));
  } finally {
    substrate.close();
    root.cleanup();
  }
});

test("a void conditional append proves its own durable postcondition", async () => {
  const root = temporaryStoreRoot("evidence-postcondition");
  const inner = openStore(root, "evidence-store");
  try {
    // The port returns `void`, so the caller has nothing to re-derive. If the
    // adapter trusted the acknowledgement, this silent no-op would be reported
    // as a successful durable write.
    const liar = lyingSubstrate(inner, {
      appendOnce: async (): Promise<DurableWriteOutcome> => ({
        status: "appended",
        record: null
      })
    });
    const store = openDurableEngineeringEvidenceStore({ substrate: liar });
    await assert.rejects(
      store.conditionalAppend(null, effectEvidence()),
      (error: unknown) => engineeringCodeOf(error) === "ADAPTER_OUTPUT_INVALID"
    );
  } finally {
    inner.close();
    root.cleanup();
  }
});

test("effect evidence survives a restart with its chain position intact", async () => {
  const root = temporaryStoreRoot("evidence-restart");
  const first = effectEvidence();
  const second = effectEvidence({
    sequence: 2,
    previousEvidenceDigest: digest(first),
    state: "completed",
    effectDigest: digest({ effect: "done" }),
    updatedAt: "2026-08-30T12:05:00.000Z"
  });
  const opened = openStore(root, "evidence-store");
  try {
    const store = openDurableEngineeringEvidenceStore({ substrate: opened });
    await store.conditionalAppend(null, first);
    await store.conditionalAppend(first, second);
  } finally {
    opened.close();
  }
  const reopened = openStore(root, "evidence-store");
  try {
    const store = openDurableEngineeringEvidenceStore({ substrate: reopened });
    assert.equal(
      canonicalJson(await store.read(first.effectKey)),
      canonicalJson(second)
    );
    await assert.rejects(
      store.conditionalAppend(first, second),
      (error: unknown) => error instanceof EngineeringEvidenceConflictError
    );
  } finally {
    reopened.close();
    root.cleanup();
  }
});

test("a corrupted evidence row is refused rather than returned", async () => {
  const root = temporaryStoreRoot("evidence-corrupt");
  const evidence = effectEvidence();
  const opened = openStore(root, "evidence-store");
  try {
    const store = openDurableEngineeringEvidenceStore({ substrate: opened });
    await store.conditionalAppend(null, evidence);
  } finally {
    opened.close();
  }
  await mutate(
    pathFor(root, "evidence-store"),
    "UPDATE durable_record SET body = X'00' WHERE key = 'evidence.1'"
  );
  const reopened = openStore(root, "evidence-store");
  try {
    const store = openDurableEngineeringEvidenceStore({ substrate: reopened });
    await assert.rejects(
      store.read(evidence.effectKey),
      (error: unknown) =>
        error instanceof DurableSubstrateError && error.code === "STORE_CORRUPT"
    );
  } finally {
    reopened.close();
    root.cleanup();
  }
});

test("two processes racing one evidence genesis produce exactly one append", async () => {
  for (const identical of [false, true]) {
    const root = temporaryStoreRoot(
      `evidence-multiprocess-${identical ? "identical" : "distinct"}`
    );
    const storePath = pathFor(root, "evidence-store");
    const effectKey = digest({ effect: "raced" });
    try {
      // As above: the store is provisioned once, then contended.
      openStore(root, "evidence-store").close();
      const requests: AdapterWorkerRequest[] = [0, 1, 2, 3].map((workerIndex) => ({
        scenario: "evidence-append-race",
        path: storePath,
        workerIndex,
        identical,
        maxEntries: 512,
        busyTimeoutMs: BUSY_TIMEOUT_MS,
        supportedNodeMajors: SUPPORTED_NODE_MAJORS,
        storeId: "evidence-store",
        storeNamespace: "namespace-evidence-store",
        now: NOW,
        grantCheckedAt: GRANT_CHECKED_AT,
        grantExpiresAt: GRANT_EXPIRES_AT,
        effectKey
      }));
      const replies = await runWorkers(requests);
      assert.deepEqual(replies.flatMap((reply) => reply.errors), []);
      assert.equal(
        replies.reduce((sum, reply) => sum + reply.appended, 0),
        1,
        `exactly one process may win the genesis compare-and-swap (identical bodies: ${String(identical)})`
      );
      assert.equal(
        replies.reduce((sum, reply) => sum + reply.conflicted, 0),
        3
      );
    } finally {
      root.cleanup();
    }
  }
});

test("a release cannot drop a hold from the lineage it chains through", async () => {
  // Contiguity alone only catches an *interior* omission: scanning to the first
  // gap would let a release that dropped its newest entry look self-consistent,
  // because the walk and the claimed set shorten together. The chain is
  // therefore bounded above by the release's own signed ledgerVersion as well as
  // below by the reservation, so a dropped hold becomes an ordinary gap and a
  // padded one is out of range.
  const root = temporaryStoreRoot("cost-truncation");
  const stateStore = openStore(root, "runtime-state-store");
  const journal = openStore(root, "receipt-journal");
  try {
    const usageDigest = digest({ provider: "reference", call: 11 });
    const providerEvidence = openDurableEngineeringProviderEvidence({
      substrate: journal
    });
    const ledger = costLedger(stateStore, 100, providerEvidence);
    const usageLedger = openDurableEngineeringProviderUsageLedger({
      substrate: journal,
      signer: evidenceSigner,
      observer: usageObserver((attempt) =>
        attempt.phase === "framing"
          ? {
              actualCostUnits: 4,
              actualCalls: 1,
              actualTokens: 40,
              providerUsageDigest: usageDigest
            }
          : null
      )
    });
    const reservation = await reserveFixture(ledger);
    const framingHold = await ledger.hold({
      reservation,
      phase: "framing",
      sequence: 1,
      now: NOW
    });
    const framing = await usageLedger.begin({
      reservation,
      hold: framingHold,
      phase: "framing",
      sequence: 1,
      priorSettlements: [],
      now: NOW,
      reconciliationExpiresAt: reconciliationExpiry(reservation.expiresAt)
    });
    const framingUsage = await usageLedger.reconcile({
      reservation,
      attempt: framing,
      now: NOW
    });
    const settlement = await ledger.settle({
      reservation,
      hold: framingHold,
      attempt: framing,
      usage: framingUsage,
      phase: "framing",
      actualCostUnits: 4,
      actualCalls: 1,
      actualTokens: 40,
      providerUsageDigest: usageDigest,
      now: NOW
    });
    const executionHold = await ledger.hold({
      reservation,
      phase: "execution",
      sequence: 2,
      now: NOW
    });
    const honest = await ledger.release({
      releaseIdempotencyKey: digest({
        operation: "release-engineering-reservation",
        reservation: digest(reservation),
        settlements: [digest(settlement)]
      }),
      reservation,
      settledPhases: [settlement],
      expectedOpenHoldDigests: [digest(executionHold)],
      now: NOW
    });
    const validate = (release: EngineeringCostRelease): void => {
      validateCostRelease({
        release,
        reservation,
        settlements: [settlement],
        knownOpenHolds: [],
        verifier: evidenceVerifier,
        now: NOW,
        maximumAgeMs: MAX_AGE_MS
      });
    };
    validate(honest);
    assert.equal(honest.heldCostUnits, PHASE_BUDGETS.execution);

    // Dropping the trailing open hold while still claiming the chain that hold
    // created is refused: the release chains through position 4, and nothing
    // else accounts for it.
    const resign = async (
      base: EngineeringCostRelease,
      overrides: Partial<EngineeringCostRelease>
    ): Promise<EngineeringCostRelease> => {
      const { signature: _drop, ...unsigned } = { ...base, ...overrides };
      return {
        ...unsigned,
        signature: await evidenceSigner.sign(unsigned)
      } as EngineeringCostRelease;
    };
    const droppedHold = await resign(honest, {
      unresolvedHolds: [],
      reconciliationRequired: false,
      heldCostUnits: 0,
      releasedCostUnits: honest.releasedCostUnits + honest.heldCostUnits,
      cumulativeReleasedCostUnits:
        honest.cumulativeReleasedCostUnits + honest.heldCostUnits
    });
    assert.ok(
      droppedHold.releasedCostUnits > honest.releasedCostUnits,
      "the forged release must genuinely return more budget, or it proves nothing"
    );
    assert.throws(
      () => { validate(droppedHold); },
      /missing a ledger position the release chains through/u,
      "a release cannot drop a hold and still chain through the position it held"
    );
    // Note this was refused before the bound was stated explicitly too, by the
    // release-follows-the-walked-tip equality. The assertion pins which
    // position is reported, not a newly closed hole.

    // An entry beyond the release's own stated tip is refused too, so a chain
    // cannot be padded past what the release claims to follow.
    const shortTip = await resign(honest, {
      ledgerVersion: honest.ledgerVersion - 1
    });
    assert.throws(
      () => { validate(shortTip); },
      /claims a position outside its own chain/u,
      "a release cannot claim a tip earlier than the lineage it carries"
    );

  } finally {
    stateStore.close();
    journal.close();
    root.cleanup();
  }
});

test("a release cannot hold one phase budget twice", async () => {
  const root = temporaryStoreRoot("cost-duplicate-phase");
  const stateStore = openStore(root, "runtime-state-store");
  try {
    const ledger = costLedger(stateStore, 100);
    const reservation = await reserveFixture(ledger);
    const framingHold = await ledger.hold({
      reservation,
      phase: "framing",
      sequence: 1,
      now: NOW
    });
    // The adapter refuses to create the shape forged below: while the framing
    // hold is open, no second hold may be taken. Asserted here, before any
    // release exists, and matched on the exact refusal — after a release the
    // already-released guard would answer instead and this would pass for the
    // wrong reason.
    await assert.rejects(
      ledger.hold({ reservation, phase: "execution", sequence: 2, now: NOW }),
      /the framing hold is still open, so this reservation cannot take another/u,
      "no second hold may be open at once"
    );

    const honest = await ledger.release({
      releaseIdempotencyKey: digest({
        operation: "release-engineering-reservation",
        reservation: digest(reservation),
        settlements: []
      }),
      reservation,
      settledPhases: [],
      expectedOpenHoldDigests: [digest(framingHold)],
      now: NOW
    });
    assert.equal(honest.heldCostUnits, PHASE_BUDGETS.framing);

    // Two *distinct* framing holds. The same document twice is already caught
    // by the digest dedupe, so it would never exercise this guard; these differ
    // in id, sequence, and lineage position and are individually well formed.
    const twinPayload = {
      ...costHoldPayloadOf(framingHold),
      holdId: `${framingHold.holdId}.twin`,
      sequence: framingHold.sequence + 1,
      ledgerVersion: framingHold.ledgerVersion + 1,
      ledgerHeadBefore: framingHold.ledgerHeadAfter,
      ledgerHeadAfter: digest({ twin: framingHold.holdId })
    };
    const twin = {
      ...twinPayload,
      signature: await evidenceSigner.sign(twinPayload)
    } as EngineeringCostHold;
    const held = PHASE_BUDGETS.framing * 2;
    const forgedPayload = {
      ...costReleasePayloadOf(honest),
      unresolvedHolds: [framingHold, twin],
      heldCostUnits: held,
      releasedCostUnits: reservation.totalReserved - held,
      cumulativeReleasedCostUnits: reservation.totalReserved - held,
      ledgerVersion: twin.ledgerVersion + 1,
      ledgerHeadBefore: twin.ledgerHeadAfter
    };
    const forged = {
      ...forgedPayload,
      signature: await evidenceSigner.sign(forgedPayload)
    } as EngineeringCostRelease;
    assert.ok(
      forged.releasedCostUnits >= 0,
      "the forgery must be arithmetically plausible, or a different check catches it first"
    );
    assert.throws(
      () => {
        validateCostRelease({
          release: forged,
          reservation,
          settlements: [],
          knownOpenHolds: [],
          verifier: evidenceVerifier,
          now: NOW,
          maximumAgeMs: MAX_AGE_MS
        });
      },
      /holds one phase budget more than once/u,
      "one phase may hold its budget only once"
    );

    // A released reservation is closed to holds as well, which is a separate
    // guard from the one above and reports separately.
    await assert.rejects(
      ledger.hold({ reservation, phase: "execution", sequence: 2, now: NOW }),
      /already been released and cannot take further holds/u,
      "a released reservation takes no further holds"
    );
  } finally {
    stateStore.close();
    root.cleanup();
  }
});

test("a hold whose post-commit readback fails is still held by the release", async () => {
  // The exact liveness case independent review found. `compareAndSwap` lands,
  // so the hold is durable, and then `proveDurable`'s readback throws. The
  // caller's own arrays never learn about the hold, and the original failure is
  // what it must see — but the ledger derives the hold from its own lineage, so
  // the budget stays held and the release stays valid.
  const root = temporaryStoreRoot("cost-hold-postcas");
  const stateStore = openStore(root, "runtime-state-store");
  const journal = openStore(root, "receipt-journal");
  try {
    const providerEvidence = openDurableEngineeringProviderEvidence({
      substrate: journal
    });
    const reservation = await reserveFixture(costLedger(stateStore, 100, providerEvidence));

    // Fails the readback that follows a successful compare-and-swap, leaving a
    // durably committed hold that its caller never receives.
    let failNextRead = false;
    const flaky: DurableSubstrate = {
      ...stateStore,
      compareAndSwap: async (request) => {
        const outcome = await stateStore.compareAndSwap(request);
        failNextRead = true;
        return outcome;
      },
      read: async (request) => {
        if (failNextRead) {
          failNextRead = false;
          throw new Error("simulated post-commit readback failure");
        }
        return stateStore.read(request);
      }
    };
    await assert.rejects(
      costLedger(flaky, 100, providerEvidence).hold({
        reservation,
        phase: "framing",
        sequence: 1,
        now: NOW
      }),
      /simulated post-commit readback failure/u,
      "the original failure must reach the caller, not a success-shaped answer"
    );

    // The hold is nevertheless durable.
    const ledger = costLedger(stateStore, 100, providerEvidence);
    const committed = (await stateStore.verifyChain("engineering.cost-ledger"))
      .filter((record) => (record.body as { kind: string }).kind === "hold")
      .map((record) => (record.body as { readonly document: EngineeringCostHold }).document);
    assert.equal(committed.length, 1, "the compare-and-swap landed");
    const orphanedHold = committed[0];
    assert.ok(orphanedHold);

    // The caller knows nothing about it: no settlements, no open holds.
    const release = await ledger.release({
      releaseIdempotencyKey: digest({
        operation: "release-engineering-reservation",
        reservation: digest(reservation),
        settlements: []
      }),
      reservation,
      settledPhases: [],
      expectedOpenHoldDigests: [],
      now: NOW
    });
    assert.equal(release.heldCostUnits, PHASE_BUDGETS.framing);
    assert.equal(release.reconciliationRequired, true);
    assert.equal(
      digest(release.unresolvedHolds.map((hold: EngineeringCostHold) => digest(hold))),
      digest([digest(orphanedHold)])
    );
    assert.equal(
      release.cumulativeCostUnits +
        release.cumulativeReleasedCostUnits +
        release.heldCostUnits,
      reservation.totalReserved
    );

    // The validator must accept this release while holding nothing of its own.
    // Rebuilding the chain from a caller array would reject it here, because
    // that array is empty and the release chains onto the orphaned hold.
    validateCostRelease({
      release,
      reservation,
      settlements: [],
      knownOpenHolds: [],
      verifier: evidenceVerifier,
      now: NOW,
      maximumAgeMs: MAX_AGE_MS
    });
    assert.equal(
      release.ledgerHeadBefore,
      orphanedHold.ledgerHeadAfter,
      "the release chains onto the hold the caller never saw"
    );
    assert.equal(
      release.ledgerVersion,
      reservation.ledgerVersion + 2,
      "the lineage contains a link no caller array could supply, which is why the chain must be derived from release-pinned content"
    );

    // Exactly one release, and the reservation is closed to further holds.
    await assert.rejects(
      ledger.hold({ reservation, phase: "execution", sequence: 2, now: NOW }),
      (error: unknown) => engineeringCodeOf(error) === "ADAPTER_CONFLICT"
    );
    const releases = (
      await stateStore.verifyChain("engineering.cost-ledger")
    ).filter((record) => (record.body as { kind: string }).kind === "release");
    assert.equal(releases.length, 1, "no second release is written");
  } finally {
    stateStore.close();
    journal.close();
    root.cleanup();
  }
});

test("two processes racing one cost hold commit that budget exactly once", async () => {
  const root = temporaryStoreRoot("cost-hold-race");
  const storePath = pathFor(root, "runtime-state-store");
  try {
    // The reservation is provisioned once, in this process, so every worker
    // races only the hold itself.
    const seed = openStore(root, "runtime-state-store");
    try {
      await reserveFixture(costLedger(seed, 100));
    } finally {
      seed.close();
    }

    const requests: AdapterWorkerRequest[] = [0, 1, 2, 3].map((workerIndex) => ({
      scenario: "cost-hold-race",
      path: storePath,
      workerIndex,
      identical: true,
      maxEntries: 512,
      busyTimeoutMs: BUSY_TIMEOUT_MS,
      supportedNodeMajors: SUPPORTED_NODE_MAJORS,
      storeId: "runtime-state-store",
      storeNamespace: "namespace-runtime-state-store",
      now: NOW,
      grantCheckedAt: GRANT_CHECKED_AT,
      grantExpiresAt: GRANT_EXPIRES_AT,
      effectKey: digest({ effect: "unused" }),
      totalBudgetCostUnits: 100
    }));
    const replies = await runWorkers(requests);
    assert.deepEqual(replies.flatMap((reply) => reply.errors), []);

    // A hold is content-addressed on (reservation, phase, sequence), so a
    // worker that arrives after the winner is answered with the same hold
    // rather than refused. What must never happen is a *second* durable hold:
    // that would commit the same reserved units twice and strand the
    // difference when the reservation is released.
    const observed = new Set(
      replies.flatMap((reply) => reply.holdDigests ?? [])
    );
    assert.equal(
      observed.size,
      1,
      "every process that obtained a hold must have obtained the same one"
    );
    assert.ok(
      replies.reduce((sum, reply) => sum + reply.claimed, 0) >= 1,
      "at least one process must commit the hold"
    );

    const reopened = openStore(root, "runtime-state-store");
    try {
      const holds = (
        await reopened.verifyChain("engineering.cost-ledger")
      ).filter((record) => (record.body as { kind: string }).kind === "hold");
      assert.equal(
        holds.length,
        1,
        "one phase budget is committed exactly once, however many processes raced"
      );
      assert.equal(digest(
        (holds[0]?.body as { readonly document: unknown }).document
      ), [...observed][0]);
    } finally {
      reopened.close();
    }
  } finally {
    root.cleanup();
  }
});

// ---------------------------------------------------------------------------
// EngineeringClosureCheckpointStore
// ---------------------------------------------------------------------------

test("a closure checkpoint is content-addressed and idempotent", async () => {
  const root = temporaryStoreRoot("checkpoint-closure");
  const substrate = openStore(root, "evidence-store");
  try {
    const store = openDurableEngineeringClosureCheckpointStore({ substrate });
    const checkpoint = {
      schemaVersion: "1.0.0",
      workflowId: "workflow-1",
      reviewedHead: "a".repeat(40)
    } as never;
    const checkpointDigest = digest(checkpoint);
    assert.equal(await store.read(checkpointDigest), null);
    await store.put(checkpoint);
    await store.put(checkpoint);
    const stored = await store.read(checkpointDigest);
    assert.equal(canonicalJson(stored), canonicalJson(checkpoint));
    const chain = await substrate.verifyChain("engineering.closure-checkpoints");
    assert.equal(chain.length, 1, "a byte-identical re-put must not grow the journal");
  } finally {
    substrate.close();
    root.cleanup();
  }
});

test("a closure checkpoint that does not hash to its key is refused", async () => {
  const root = temporaryStoreRoot("checkpoint-rewritten");
  const checkpoint = { schemaVersion: "1.0.0", marker: "original" } as never;
  const checkpointDigest = digest(checkpoint);
  const opened = openStore(root, "evidence-store");
  try {
    const store = openDurableEngineeringClosureCheckpointStore({
      substrate: opened
    });
    await store.put(checkpoint);
  } finally {
    opened.close();
  }
  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(pathFor(root, "evidence-store"));
  const rewritten = { schemaVersion: "1.0.0", marker: "rewritten" };
  raw
    .prepare("UPDATE durable_record SET body = ?, body_digest = ? WHERE key = ?")
    .run(
      Buffer.from(canonicalJson(rewritten), "utf8"),
      digest(rewritten),
      checkpointDigest
    );
  raw.close();

  const reopened = openStore(root, "evidence-store");
  try {
    const store = openDurableEngineeringClosureCheckpointStore({
      substrate: reopened
    });
    await assert.rejects(
      store.read(checkpointDigest),
      (error: unknown) =>
        error instanceof DurableEngineeringStoreError ||
        error instanceof DurableSubstrateError
    );
  } finally {
    reopened.close();
    root.cleanup();
  }
});

test("an awaiting-human-merge checkpoint is revised without losing its predecessor", async () => {
  const root = temporaryStoreRoot("checkpoint-awaiting");
  const substrate = openStore(root, "evidence-store");
  try {
    const store = openDurableEngineeringClosureCheckpointStore({ substrate });
    const bindingDigest = digest({ binding: 1 });
    assert.equal(await store.readAwaitingHumanMerge(bindingDigest), null);
    const first = awaitingCheckpoint(bindingDigest, "first");
    await store.putAwaitingHumanMerge(first as never);
    assert.equal(
      canonicalJson(await store.readAwaitingHumanMerge(bindingDigest)),
      canonicalJson(first)
    );
    const revised = awaitingCheckpoint(bindingDigest, "revised");
    await store.putAwaitingHumanMerge(revised as never);
    assert.equal(
      canonicalJson(await store.readAwaitingHumanMerge(bindingDigest)),
      canonicalJson(revised),
      "the reader must return the current revision"
    );
    const chain = await substrate.verifyChain(
      `engineering.awaiting-human-merge.${bindingDigest}`
    );
    assert.equal(
      chain.length,
      2,
      "a revision supersedes its predecessor without destroying it"
    );
  } finally {
    substrate.close();
    root.cleanup();
  }
});

test("cost-release checkpoints are keyed independently per binding", async () => {
  const root = temporaryStoreRoot("checkpoint-cost-release");
  const substrate = openStore(root, "evidence-store");
  try {
    const store = openDurableEngineeringClosureCheckpointStore({ substrate });
    const a = digest({ binding: "a" });
    const b = digest({ binding: "b" });
    const pendingA = { bindingDigest: a, stage: "cost-release-pending", costRelease: null };
    const pendingB = { bindingDigest: b, stage: "cost-release-pending", costRelease: null };
    await store.putCostRelease(pendingA as never);
    await store.putCostRelease(pendingB as never);
    const settledA = {
      bindingDigest: a,
      stage: "cost-release-pending",
      costRelease: { marker: "released" }
    };
    await store.putCostRelease(settledA as never);
    assert.equal(
      canonicalJson(await store.readCostRelease(a)),
      canonicalJson(settledA)
    );
    assert.equal(
      canonicalJson(await store.readCostRelease(b)),
      canonicalJson(pendingB),
      "one binding's revision must not disturb another's"
    );
  } finally {
    substrate.close();
    root.cleanup();
  }
});

test("a checkpoint whose binding digest does not match its chain is refused", async () => {
  const root = temporaryStoreRoot("checkpoint-mismatch");
  const substrate = openStore(root, "evidence-store");
  try {
    const store = openDurableEngineeringClosureCheckpointStore({ substrate });
    const bindingDigest = digest({ binding: 1 });
    await store.putCostRelease({
      bindingDigest,
      stage: "cost-release-pending"
    } as never);
    // The stored body claims a different binding than the namespace it lives
    // in, which is only reachable by rewriting the row.
    await rewriteBody(pathFor(root, "evidence-store"), "checkpoint.1", {
      bindingDigest: digest({ binding: 2 }),
      stage: "cost-release-pending"
    });
    const reread = openDurableEngineeringClosureCheckpointStore({ substrate });
    await assert.rejects(
      reread.readCostRelease(bindingDigest),
      (error: unknown) =>
        error instanceof DurableEngineeringStoreError ||
        error instanceof DurableSubstrateError
    );
  } finally {
    substrate.close();
    root.cleanup();
  }
});

test("a void checkpoint put proves its own durable postcondition", async () => {
  const root = temporaryStoreRoot("checkpoint-postcondition");
  const inner = openStore(root, "evidence-store");
  try {
    const liar = lyingSubstrate(inner, {
      appendOnce: async (): Promise<DurableWriteOutcome> => ({
        status: "appended",
        record: null
      })
    });
    const store = openDurableEngineeringClosureCheckpointStore({ substrate: liar });
    await assert.rejects(
      store.putAwaitingHumanMerge(
        awaitingCheckpoint(digest({ binding: 1 }), "phantom") as never
      ),
      (error: unknown) => engineeringCodeOf(error) === "ADAPTER_OUTPUT_INVALID"
    );
    await assert.rejects(
      store.put({ schemaVersion: "1.0.0" } as never),
      (error: unknown) => engineeringCodeOf(error) === "ADAPTER_OUTPUT_INVALID"
    );
  } finally {
    inner.close();
    root.cleanup();
  }
});

test("checkpoints survive a restart and a restored backup", async () => {
  const root = temporaryStoreRoot("checkpoint-recovery");
  const bindingDigest = digest({ binding: 1 });
  const checkpoint = awaitingCheckpoint(bindingDigest, "durable");
  const backupPath = root.pathFor("evidence-backup.db");
  const opened = openStore(root, "evidence-store");
  try {
    const store = openDurableEngineeringClosureCheckpointStore({
      substrate: opened
    });
    await store.putAwaitingHumanMerge(checkpoint as never);
    await opened.backup(backupPath);
  } finally {
    opened.close();
  }
  copyFileSync(backupPath, pathFor(root, "evidence-store"));
  const restored = openStore(root, "evidence-store");
  try {
    const store = openDurableEngineeringClosureCheckpointStore({
      substrate: restored
    });
    assert.equal(
      canonicalJson(await store.readAwaitingHumanMerge(bindingDigest)),
      canonicalJson(checkpoint)
    );
  } finally {
    restored.close();
    root.cleanup();
  }
});

// ---------------------------------------------------------------------------
// EngineeringCostLedger and EngineeringProviderUsageLedger
// ---------------------------------------------------------------------------

test("a reservation satisfies the caller's own validator", async () => {
  const root = temporaryStoreRoot("cost-reserve");
  const substrate = openStore(root, "runtime-state-store");
  try {
    const ledger = costLedger(substrate);
    const reservation = await reserveFixture(ledger);
    // Caller fidelity: run the real exported validator rather than restating
    // what it checks.
    validateCostReservation({
      reservation,
      verifier: evidenceVerifier,
      workAccordDigest: digest({ accord: 1 }),
      activationLeaseDigest: digest({ lease: 1 }),
      phaseBudgets: PHASE_BUDGETS,
      phaseTokenBudgets: PHASE_TOKEN_BUDGETS,
      maxCalls: 3,
      maxTokens: 1_000,
      now: NOW,
      maximumAgeMs: MAX_AGE_MS
    });
    assert.equal(reservation.totalReserved, 36);
    assert.equal(reservation.remainingBefore, 100);
    assert.equal(reservation.remainingAfter, 64);
    assert.equal(reservation.ledgerHeadBefore, null);
  } finally {
    substrate.close();
    root.cleanup();
  }
});

test("one activation lease reserves once, and a different request is refused", async () => {
  const root = temporaryStoreRoot("cost-reserve-idempotent");
  const substrate = openStore(root, "runtime-state-store");
  try {
    const ledger = costLedger(substrate);
    const first = await reserveFixture(ledger);
    const again = await reserveFixture(ledger);
    assert.equal(canonicalJson(again), canonicalJson(first));
    const chain = await substrate.verifyChain("engineering.cost-ledger");
    assert.equal(chain.length, 1, "a repeated reservation must not spend twice");

    await assert.rejects(
      ledger.reserve({
        workAccordDigest: digest({ accord: 1 }),
        activationLeaseDigest: digest({ lease: 1 }),
        phaseBudgets: { framing: 1, execution: 1, verification: 1 },
        phaseTokenBudgets: PHASE_TOKEN_BUDGETS,
        maxCalls: 3,
        maxTokens: 1_000,
        now: NOW,
        expiresAt: BUDGET_EXPIRES_AT
      }),
      (error: unknown) => engineeringCodeOf(error) === "ADAPTER_CONFLICT"
    );
  } finally {
    substrate.close();
    root.cleanup();
  }
});

test("a reservation that exceeds the pooled budget is refused", async () => {
  const root = temporaryStoreRoot("cost-pool");
  const substrate = openStore(root, "runtime-state-store");
  try {
    const ledger = costLedger(substrate, 10);
    await assert.rejects(
      reserveFixture(ledger),
      (error: unknown) => engineeringCodeOf(error) === "ADAPTER_CONFLICT"
    );
    const chain = await substrate.verifyChain("engineering.cost-ledger");
    assert.equal(chain.length, 0);
  } finally {
    substrate.close();
    root.cleanup();
  }
});

test("an attempt, its usage, and its settlement all satisfy the caller's validators", async () => {
  const root = temporaryStoreRoot("cost-settle");
  const stateStore = openStore(root, "runtime-state-store");
  const journal = openStore(root, "receipt-journal");
  try {
    const ledger = costLedger(stateStore, 100, openDurableEngineeringProviderEvidence({ substrate: journal }));
    const usageDigest = digest({ provider: "reference", call: 1 });
    const usageLedger = openDurableEngineeringProviderUsageLedger({
      substrate: journal,
      signer: evidenceSigner,
      observer: usageObserver(() => ({
        actualCostUnits: 4,
        actualCalls: 1,
        actualTokens: 40,
        providerUsageDigest: usageDigest
      }))
    });
    const reservation = await reserveFixture(ledger);

    const attemptHold = await ledger.hold({
      reservation,
      phase: "framing",
      sequence: 1,
      now: NOW
    });
    const attempt = await usageLedger.begin({
      reservation,
      hold: attemptHold,
      phase: "framing",
      sequence: 1,
      priorSettlements: [],
      now: NOW,
      reconciliationExpiresAt: reconciliationExpiry(reservation.expiresAt)
    });
    validateProviderAttempt({
      attempt,
      hold: attemptHold,
      reservation,
      verifier: evidenceVerifier,
      phase: "framing",
      sequence: 1,
      priorSettlements: [],
      now: NOW,
      maximumAgeMs: MAX_AGE_MS
    });

    const usage = await usageLedger.reconcile({ reservation, attempt, now: NOW });
    validateProviderUsage({
      usage,
      attempt,
      verifier: evidenceVerifier,
      now: NOW,
      maximumAgeMs: MAX_AGE_MS
    });
    assert.equal(usage.status, "settled");

    const settlement = await ledger.settle({
      reservation,
      attempt,
      hold: attemptHold,
      usage,
      phase: "framing",
      actualCostUnits: 4,
      actualCalls: 1,
      actualTokens: 40,
      providerUsageDigest: usageDigest,
      now: NOW
    });
    validateCostSettlement({
      settlement,
      reservation,
      hold: attemptHold,
      verifier: evidenceVerifier,
      priorEntries: [],
      expectedPhase: "framing",
      expectedAttemptDigest: digest(attempt),
      expectedActualCostUnits: 4,
      expectedActualCalls: 1,
      expectedActualTokens: 40,
      expectedProviderUsageDigest: usageDigest,
      now: NOW,
      maximumAgeMs: MAX_AGE_MS
    });
    assert.equal(settlement.releasedCostUnits, PHASE_BUDGETS.framing - 4);
    assert.equal(
      settlement.ledgerHeadBefore,
      attemptHold.ledgerHeadAfter,
      "a settlement chains onto the hold it discharges, not onto the reservation"
    );
    assert.equal(
      attemptHold.ledgerHeadBefore,
      reservation.ledgerHeadAfter,
      "the first hold chains onto the reservation"
    );
  } finally {
    stateStore.close();
    journal.close();
    root.cleanup();
  }
});

test("settle is idempotent, which is what makes the caller's retry safe", async () => {
  const root = temporaryStoreRoot("cost-settle-retry");
  const stateStore = openStore(root, "runtime-state-store");
  const journal = openStore(root, "receipt-journal");
  try {
    const ledger = costLedger(stateStore, 100, openDurableEngineeringProviderEvidence({ substrate: journal }));
    const usageDigest = digest({ provider: "reference", call: 1 });
    const usageLedger = openDurableEngineeringProviderUsageLedger({
      substrate: journal,
      signer: evidenceSigner,
      observer: usageObserver(() => ({
        actualCostUnits: 4,
        actualCalls: 1,
        actualTokens: 40,
        providerUsageDigest: usageDigest
      }))
    });
    const reservation = await reserveFixture(ledger);
    const attemptHold = await ledger.hold({
      reservation,
      phase: "framing",
      sequence: 1,
      now: NOW
    });
    const attempt = await usageLedger.begin({
      reservation,
      hold: attemptHold,
      phase: "framing",
      sequence: 1,
      priorSettlements: [],
      now: NOW,
      reconciliationExpiresAt: reconciliationExpiry(reservation.expiresAt)
    });
    const usage = await usageLedger.reconcile({ reservation, attempt, now: NOW });
    const settle = async (now: string): Promise<EngineeringCostSettlement> =>
      ledger.settle({
        reservation,
        attempt,
        hold: attemptHold,
        usage,
        phase: "framing",
        actualCostUnits: 4,
        actualCalls: 1,
        actualTokens: 40,
        providerUsageDigest: usageDigest,
        now
      });
    const first = await settle(NOW);
    // The caller retries `settle` with a fresh `now` after a failure. It must
    // get the original settlement back, not a second one for the same attempt.
    const retried = await settle("2026-08-30T12:30:00.000Z");
    assert.equal(canonicalJson(retried), canonicalJson(first));
    const chain = await stateStore.verifyChain("engineering.cost-ledger");
    assert.equal(
      chain.length,
      3,
      "reservation, its framing hold, and exactly one settlement"
    );
  } finally {
    stateStore.close();
    journal.close();
    root.cleanup();
  }
});

test("a settlement out of phase order is refused", async () => {
  const root = temporaryStoreRoot("cost-order");
  const stateStore = openStore(root, "runtime-state-store");
  const journal = openStore(root, "receipt-journal");
  try {
    const ledger = costLedger(stateStore, 100, openDurableEngineeringProviderEvidence({ substrate: journal }));
    const usageDigest = digest({ provider: "reference", call: 2 });
    const usageLedger = openDurableEngineeringProviderUsageLedger({
      substrate: journal,
      signer: evidenceSigner,
      observer: usageObserver(() => ({
        actualCostUnits: 4,
        actualCalls: 1,
        actualTokens: 40,
        providerUsageDigest: usageDigest
      }))
    });
    const reservation = await reserveFixture(ledger);
    const attemptHold = await ledger.hold({
      reservation,
      phase: "execution",
      sequence: 1,
      now: NOW
    });
    const attempt = await usageLedger.begin({
      reservation,
      hold: attemptHold,
      phase: "execution",
      sequence: 1,
      priorSettlements: [],
      now: NOW,
      reconciliationExpiresAt: reconciliationExpiry(reservation.expiresAt)
    });
    const usage = await usageLedger.reconcile({ reservation, attempt, now: NOW });
    await assert.rejects(
      ledger.settle({
        reservation,
        attempt,
        hold: attemptHold,
        usage,
        phase: "execution",
        actualCostUnits: 4,
        actualCalls: 1,
        actualTokens: 40,
        providerUsageDigest: usageDigest,
        now: NOW
      }),
      (error: unknown) => engineeringCodeOf(error) === "ADAPTER_CONFLICT"
    );
  } finally {
    stateStore.close();
    journal.close();
    root.cleanup();
  }
});

test("unknown provider usage stays unknown, is never settled, and holds its budget", async () => {
  const root = temporaryStoreRoot("cost-unknown");
  const stateStore = openStore(root, "runtime-state-store");
  const journal = openStore(root, "receipt-journal");
  try {
    const ledger = costLedger(stateStore, 100, openDurableEngineeringProviderEvidence({ substrate: journal }));
    let observations = 0;
    const usageLedger = openDurableEngineeringProviderUsageLedger({
      substrate: journal,
      signer: evidenceSigner,
      observer: {
        observe: async () => {
          observations += 1;
          // Only the very first observation is unknown; a re-observation would
          // report a cost, which must not be able to change the recorded answer.
          return observations === 1
            ? null
            : {
                actualCostUnits: 5,
                actualCalls: 1,
                actualTokens: 50,
                providerUsageDigest: digest({ late: true })
              };
        }
      }
    });
    const reservation = await reserveFixture(ledger);
    const attemptHold = await ledger.hold({
      reservation,
      phase: "framing",
      sequence: 1,
      now: NOW
    });
    const attempt = await usageLedger.begin({
      reservation,
      hold: attemptHold,
      phase: "framing",
      sequence: 1,
      priorSettlements: [],
      now: NOW,
      reconciliationExpiresAt: reconciliationExpiry(reservation.expiresAt)
    });
    const usage = await usageLedger.reconcile({ reservation, attempt, now: NOW });
    assert.equal(usage.status, "unknown");
    assert.equal(usage.actualCostUnits, null);
    assert.equal(usage.providerUsageDigest, null);
    validateProviderUsage({
      usage,
      attempt,
      verifier: evidenceVerifier,
      now: NOW,
      maximumAgeMs: MAX_AGE_MS
    });

    const again = await usageLedger.reconcile({ reservation, attempt, now: NOW });
    assert.equal(
      canonicalJson(again),
      canonicalJson(usage),
      "an unknown answer is final: a later observation must not rewrite it"
    );

    await assert.rejects(
      ledger.settle({
        reservation,
        attempt,
        hold: attemptHold,
        usage,
        phase: "framing",
        actualCostUnits: 4,
        actualCalls: 1,
        actualTokens: 40,
        providerUsageDigest: digest({ invented: true }),
        now: NOW
      }),
      (error: unknown) => engineeringCodeOf(error) === "ADAPTER_ARGUMENT_INVALID"
    );

    // The unresolved attempt holds its phase budget through the release.
    const releaseIdempotencyKey = digest({
      operation: "release-engineering-reservation",
      reservation: digest(reservation),
      settlements: []
    });
    const release = await ledger.release({
      releaseIdempotencyKey,
      reservation,
      settledPhases: [],
      expectedOpenHoldDigests: [digest(attemptHold)],
      now: NOW
    });
    validateCostRelease({
      release,
      reservation,
      settlements: [],
      knownOpenHolds: [attemptHold],
      verifier: evidenceVerifier,
      now: NOW,
      maximumAgeMs: MAX_AGE_MS
    });
    assert.equal(release.heldCostUnits, PHASE_BUDGETS.framing);
    assert.equal(
      release.releasedCostUnits,
      reservation.totalReserved - PHASE_BUDGETS.framing
    );
  } finally {
    stateStore.close();
    journal.close();
    root.cleanup();
  }
});

test("an observation that exceeds its signed attempt is refused, not recorded as unknown", async () => {
  const root = temporaryStoreRoot("cost-overrun");
  const stateStore = openStore(root, "runtime-state-store");
  const journal = openStore(root, "receipt-journal");
  try {
    const ledger = costLedger(stateStore, 100, openDurableEngineeringProviderEvidence({ substrate: journal }));
    const usageLedger = openDurableEngineeringProviderUsageLedger({
      substrate: journal,
      signer: evidenceSigner,
      observer: usageObserver(() => ({
        actualCostUnits: 9_999,
        actualCalls: 1,
        actualTokens: 1,
        providerUsageDigest: digest({ over: true })
      }))
    });
    const reservation = await reserveFixture(ledger);
    const attemptHold = await ledger.hold({
      reservation,
      phase: "framing",
      sequence: 1,
      now: NOW
    });
    const attempt = await usageLedger.begin({
      reservation,
      hold: attemptHold,
      phase: "framing",
      sequence: 1,
      priorSettlements: [],
      now: NOW,
      reconciliationExpiresAt: reconciliationExpiry(reservation.expiresAt)
    });
    await assert.rejects(
      usageLedger.reconcile({ reservation, attempt, now: NOW }),
      (error: unknown) => engineeringCodeOf(error) === "ADAPTER_ARGUMENT_INVALID"
    );
  } finally {
    stateStore.close();
    journal.close();
    root.cleanup();
  }
});

test("begin is idempotent and refuses a reconciliation window it did not derive", async () => {
  const root = temporaryStoreRoot("cost-begin");
  const stateStore = openStore(root, "runtime-state-store");
  const journal = openStore(root, "receipt-journal");
  try {
    const ledger = costLedger(stateStore, 100, openDurableEngineeringProviderEvidence({ substrate: journal }));
    const usageLedger = openDurableEngineeringProviderUsageLedger({
      substrate: journal,
      signer: evidenceSigner,
      observer: usageObserver(() => null)
    });
    const reservation = await reserveFixture(ledger);
    const framingHold = await ledger.hold({
      reservation,
      phase: "framing",
      sequence: 1,
      now: NOW
    });
    const begin = async (now: string): Promise<EngineeringProviderAttempt> =>
      usageLedger.begin({
        reservation,
        hold: framingHold,
        phase: "framing",
        sequence: 1,
        priorSettlements: [],
        now,
        reconciliationExpiresAt: reconciliationExpiry(reservation.expiresAt)
      });
    const first = await begin(NOW);
    const again = await begin("2026-08-30T12:45:00.000Z");
    assert.equal(canonicalJson(again), canonicalJson(first));

    // The framing hold is still open, so no second hold may be taken; the
    // reconciliation-window check under test does not depend on the phase.
    await assert.rejects(
      ledger.hold({ reservation, phase: "execution", sequence: 2, now: NOW }),
      (error: unknown) => engineeringCodeOf(error) === "ADAPTER_CONFLICT"
    );
    await assert.rejects(
      usageLedger.begin({
        reservation,
        hold: framingHold,
        phase: "framing",
        sequence: 1,
        priorSettlements: [],
        now: NOW,
        reconciliationExpiresAt: "2026-09-30T18:00:00.000Z"
      }),
      (error: unknown) => engineeringCodeOf(error) === "ADAPTER_ARGUMENT_INVALID"
    );
  } finally {
    stateStore.close();
    journal.close();
    root.cleanup();
  }
});

test("a release must describe exactly the durably settled phases", async () => {
  const root = temporaryStoreRoot("cost-release-mismatch");
  const stateStore = openStore(root, "runtime-state-store");
  const journal = openStore(root, "receipt-journal");
  try {
    const ledger = costLedger(stateStore, 100, openDurableEngineeringProviderEvidence({ substrate: journal }));
    const usageDigest = digest({ provider: "reference", call: 3 });
    const usageLedger = openDurableEngineeringProviderUsageLedger({
      substrate: journal,
      signer: evidenceSigner,
      observer: usageObserver(() => ({
        actualCostUnits: 4,
        actualCalls: 1,
        actualTokens: 40,
        providerUsageDigest: usageDigest
      }))
    });
    const reservation = await reserveFixture(ledger);
    const attemptHold = await ledger.hold({
      reservation,
      phase: "framing",
      sequence: 1,
      now: NOW
    });
    const attempt = await usageLedger.begin({
      reservation,
      hold: attemptHold,
      phase: "framing",
      sequence: 1,
      priorSettlements: [],
      now: NOW,
      reconciliationExpiresAt: reconciliationExpiry(reservation.expiresAt)
    });
    const usage = await usageLedger.reconcile({ reservation, attempt, now: NOW });
    const settlement = await ledger.settle({
      reservation,
      attempt,
      hold: attemptHold,
      usage,
      phase: "framing",
      actualCostUnits: 4,
      actualCalls: 1,
      actualTokens: 40,
      providerUsageDigest: usageDigest,
      now: NOW
    });

    // Claiming no settlements when one is durably recorded would release
    // budget the ledger has already spent.
    await assert.rejects(
      ledger.release({
        releaseIdempotencyKey: digest({
          operation: "release-engineering-reservation",
          reservation: digest(reservation),
          settlements: []
        }),
        reservation,
        settledPhases: [],
        expectedOpenHoldDigests: [],
        now: NOW
      }),
      (error: unknown) => engineeringCodeOf(error) === "ADAPTER_CONFLICT"
    );

    const releaseIdempotencyKey = digest({
      operation: "release-engineering-reservation",
      reservation: digest(reservation),
      settlements: [digest(settlement)]
    });
    const release = await ledger.release({
      releaseIdempotencyKey,
      reservation,
      settledPhases: [settlement],
      expectedOpenHoldDigests: [],
      now: NOW
    });
    validateCostRelease({
      release,
      reservation,
      settlements: [settlement],
      knownOpenHolds: [],
      verifier: evidenceVerifier,
      now: NOW,
      maximumAgeMs: MAX_AGE_MS
    });
    const repeated = await ledger.release({
      releaseIdempotencyKey,
      reservation,
      settledPhases: [settlement],
      expectedOpenHoldDigests: [],
      now: "2026-08-30T13:30:00.000Z"
    });
    assert.equal(
      canonicalJson(repeated),
      canonicalJson(release),
      "a repeated release must not return budget twice"
    );
  } finally {
    stateStore.close();
    journal.close();
    root.cleanup();
  }
});

test("a release whose idempotency key does not describe its own inputs is refused", async () => {
  const root = temporaryStoreRoot("cost-release-key");
  const substrate = openStore(root, "runtime-state-store");
  try {
    const ledger = costLedger(substrate);
    const reservation = await reserveFixture(ledger);
    await assert.rejects(
      ledger.release({
        releaseIdempotencyKey: digest({ unrelated: true }),
        reservation,
        settledPhases: [],
        expectedOpenHoldDigests: [],
        now: NOW
      }),
      (error: unknown) => engineeringCodeOf(error) === "ADAPTER_ARGUMENT_INVALID"
    );
  } finally {
    substrate.close();
    root.cleanup();
  }
});

test("evidence whose write landed but whose acknowledgement was lost stays undecided", async () => {
  const root = temporaryStoreRoot("evidence-landed-ambiguous");
  const substrate = openStore(root, "evidence-store");
  const { DatabaseSync } = await import("node:sqlite");
  try {
    const store = openDurableEngineeringEvidenceStore({ substrate });
    const evidence = effectEvidence();
    const fault = injectCommitFailure(DatabaseSync, "after-commit");
    try {
      await assert.rejects(
        store.conditionalAppend(null, evidence),
        (error: unknown) => {
          assert.ok(
            error instanceof DurableEngineeringAmbiguityError,
            `expected ambiguity, got ${String(error)}`
          );
          assert.ok(!(error instanceof EngineeringEvidenceConflictError));
          return true;
        }
      );
    } finally {
      fault.restore();
    }
    assert.ok(fault.fired());
    // The bytes are durably present and the port still refused, because a
    // conflict would say "your write did not land" and a success would say
    // "it was yours" — and neither is known.
    assert.equal(
      canonicalJson(await store.read(evidence.effectKey)),
      canonicalJson(evidence)
    );
  } finally {
    substrate.close();
    root.cleanup();
  }
});

test("a release cannot hold one phase budget twice or land outside its window", async () => {
  const root = temporaryStoreRoot("cost-release-guards");
  const stateStore = openStore(root, "runtime-state-store");
  const journal = openStore(root, "receipt-journal");
  try {
    const ledger = costLedger(stateStore, 100, openDurableEngineeringProviderEvidence({ substrate: journal }));
    const usageLedger = openDurableEngineeringProviderUsageLedger({
      substrate: journal,
      signer: evidenceSigner,
      observer: usageObserver(() => null)
    });
    const reservation = await reserveFixture(ledger);
    const firstHold = await ledger.hold({
      reservation,
      phase: "framing",
      sequence: 1,
      now: NOW
    });
    const first = await usageLedger.begin({
      reservation,
      hold: firstHold,
      phase: "framing",
      sequence: 1,
      priorSettlements: [],
      now: NOW,
      reconciliationExpiresAt: reconciliationExpiry(reservation.expiresAt)
    });
    // One phase holds its budget once, and that is now enforced where the
    // budget is committed rather than where it is released: a second framing
    // hold cannot exist at all, so no release can ever be handed two open holds
    // for one phase and strand the difference.
    await assert.rejects(
      ledger.hold({
        reservation,
        phase: "framing",
        sequence: 2,
        now: NOW
      }),
      (error: unknown) => engineeringCodeOf(error) === "ADAPTER_CONFLICT"
    );
    // Naming the one real hold twice is refused rather than counted twice.
    await assert.rejects(
      ledger.release({
        releaseIdempotencyKey: digest({
          operation: "release-engineering-reservation",
          reservation: digest(reservation),
          settlements: []
        }),
        reservation,
        settledPhases: [],
        expectedOpenHoldDigests: [digest(firstHold), digest(firstHold)],
        now: NOW
      }),
      (error: unknown) => engineeringCodeOf(error) === "ADAPTER_ARGUMENT_INVALID"
    );

    // A release after the reconciliation window has closed is rejected by the
    // caller's validator, so it is never durably recorded either.
    await assert.rejects(
      ledger.release({
        releaseIdempotencyKey: digest({
          operation: "release-engineering-reservation",
          reservation: digest(reservation),
          settlements: []
        }),
        reservation,
        settledPhases: [],
        expectedOpenHoldDigests: [],
        now: "2026-09-30T18:00:00.000Z"
      }),
      (error: unknown) => engineeringCodeOf(error) === "ADAPTER_ARGUMENT_INVALID"
    );

    // Reconciling outside the attempt's signed window is refused rather than
    // recorded as an unknown that would then be rejected downstream.
    await assert.rejects(
      usageLedger.reconcile({
        reservation,
        attempt: first,
        now: "2026-09-30T18:00:00.000Z"
      }),
      (error: unknown) => engineeringCodeOf(error) === "ADAPTER_ARGUMENT_INVALID"
    );

    const releases = (
      await stateStore.verifyChain("engineering.cost-ledger")
    ).filter((record) => (record.body as { kind: string }).kind === "release");
    assert.equal(releases.length, 0, "no refused release may be persisted");
  } finally {
    stateStore.close();
    journal.close();
    root.cleanup();
  }
});

test("a mutated replay is refused rather than answered with the original", async () => {
  const root = temporaryStoreRoot("cost-mutated-replay");
  const stateStore = openStore(root, "runtime-state-store");
  const journal = openStore(root, "receipt-journal");
  try {
    const ledger = costLedger(stateStore, 100, openDurableEngineeringProviderEvidence({ substrate: journal }));
    const usageDigest = digest({ provider: "reference", call: 6 });
    const usageLedger = openDurableEngineeringProviderUsageLedger({
      substrate: journal,
      signer: evidenceSigner,
      observer: usageObserver(() => ({
        actualCostUnits: 4,
        actualCalls: 1,
        actualTokens: 40,
        providerUsageDigest: usageDigest
      }))
    });
    const reservation = await reserveFixture(ledger);
    const attemptHold = await ledger.hold({
      reservation,
      phase: "framing",
      sequence: 1,
      now: NOW
    });
    const attempt = await usageLedger.begin({
      reservation,
      hold: attemptHold,
      phase: "framing",
      sequence: 1,
      priorSettlements: [],
      now: NOW,
      reconciliationExpiresAt: reconciliationExpiry(reservation.expiresAt)
    });
    const usage = await usageLedger.reconcile({ reservation, attempt, now: NOW });
    const settlement = await ledger.settle({
      reservation,
      attempt,
      hold: attemptHold,
      usage,
      phase: "framing",
      actualCostUnits: 4,
      actualCalls: 1,
      actualTokens: 40,
      providerUsageDigest: usageDigest,
      now: NOW
    });

    // Same attempt, mutated actuals. Returning the original would be a
    // success-shaped wrong answer: the caller asked about different numbers.
    const mutatedUsage = {
      ...usage,
      actualCostUnits: 9
    } as typeof usage;
    await assert.rejects(
      ledger.settle({
        reservation,
        attempt,
        hold: attemptHold,
        usage: mutatedUsage,
        phase: "framing",
        actualCostUnits: 9,
        actualCalls: 1,
        actualTokens: 40,
        providerUsageDigest: usageDigest,
        now: NOW
      }),
      (error: unknown) => engineeringCodeOf(error) === "ADAPTER_CONFLICT"
    );

    const releaseIdempotencyKey = digest({
      operation: "release-engineering-reservation",
      reservation: digest(reservation),
      settlements: [digest(settlement)]
    });
    await ledger.release({
      releaseIdempotencyKey,
      reservation,
      settledPhases: [settlement],
      expectedOpenHoldDigests: [],
      now: NOW
    });
    // The released reservation is closed, so a new hold cannot appear behind
    // the release's back. This is what stops a release racing an attempt into
    // existence: the two are compare-and-swap writes on one namespace head, and
    // once the release lands the hold is refused rather than silently admitted
    // against budget that has already been returned to the pool.
    await assert.rejects(
      ledger.hold({
        reservation,
        phase: "execution",
        sequence: 2,
        now: NOW
      }),
      (error: unknown) => engineeringCodeOf(error) === "ADAPTER_CONFLICT"
    );
    // Replaying the release returns the original rather than minting a second
    // one. The held set is re-derived from the same durable state on every
    // attempt, so a replay cannot disagree with itself about what is held.
    const replayedRelease = await ledger.release({
      releaseIdempotencyKey,
      reservation,
      settledPhases: [settlement],
      expectedOpenHoldDigests: [],
      now: "2026-08-30T12:30:00.000Z"
    });
    assert.equal(replayedRelease.heldCostUnits, 0);
    assert.equal(replayedRelease.reconciliationRequired, false);
  } finally {
    stateStore.close();
    journal.close();
    root.cleanup();
  }
});

test("a reservation is released exactly once and cannot settle afterwards", async () => {
  const root = temporaryStoreRoot("cost-release-once");
  const stateStore = openStore(root, "runtime-state-store");
  const journal = openStore(root, "receipt-journal");
  try {
    const ledger = costLedger(stateStore, 100, openDurableEngineeringProviderEvidence({ substrate: journal }));
    const usageDigest = digest({ provider: "reference", call: 4 });
    const usageLedger = openDurableEngineeringProviderUsageLedger({
      substrate: journal,
      signer: evidenceSigner,
      observer: usageObserver(() => ({
        actualCostUnits: 4,
        actualCalls: 1,
        actualTokens: 40,
        providerUsageDigest: usageDigest
      }))
    });
    const reservation = await reserveFixture(ledger);
    const released = await ledger.release({
      releaseIdempotencyKey: digest({
        operation: "release-engineering-reservation",
        reservation: digest(reservation),
        settlements: []
      }),
      reservation,
      settledPhases: [],
      expectedOpenHoldDigests: [],
      now: NOW
    });

    // The released reservation is closed at the point budget is committed, not
    // merely at the point it is spent: no further hold can be taken, so no
    // attempt can be opened and no settlement can follow.
    await assert.rejects(
      ledger.hold({
        reservation,
        phase: "framing",
        sequence: 1,
        now: NOW
      }),
      (error: unknown) => engineeringCodeOf(error) === "ADAPTER_CONFLICT"
    );
    // Replaying the same release returns the original rather than minting a
    // second one, and exactly one release is ever persisted. The released
    // amount is derived from the reservation total without subtracting an
    // earlier release, so a second durable release would hand back the same
    // budget twice.
    const replayed = await ledger.release({
      releaseIdempotencyKey: digest({
        operation: "release-engineering-reservation",
        reservation: digest(reservation),
        settlements: []
      }),
      reservation,
      settledPhases: [],
      expectedOpenHoldDigests: [],
      now: "2026-08-30T12:30:00.000Z"
    });
    assert.equal(canonicalJson(replayed), canonicalJson(released));
    const releaseEntries = (
      await stateStore.verifyChain("engineering.cost-ledger")
    ).filter((record) => (record.body as { kind: string }).kind === "release");
    assert.equal(releaseEntries.length, 1, "a reservation is released exactly once");
  } finally {
    stateStore.close();
    journal.close();
    root.cleanup();
  }
});

test("a fabricated reservation cannot settle, release, or mint pooled budget", async () => {
  const root = temporaryStoreRoot("cost-fabricated");
  const stateStore = openStore(root, "runtime-state-store");
  const journal = openStore(root, "receipt-journal");
  try {
    const ledger = costLedger(stateStore, 100, openDurableEngineeringProviderEvidence({ substrate: journal }));
    const real = await reserveFixture(ledger);
    // A structurally perfect reservation this ledger never made. Releasing it
    // would return 36 unspent units to a pool that never held them, so a later
    // legitimate reservation could spend budget that was invented here.
    const forgedPayload = { ...real, reservationId: "reservation.forged" };
    const { signature: _drop, ...unsigned } = forgedPayload;
    const forged = {
      ...unsigned,
      signature: await evidenceSigner.sign(unsigned)
    } as EngineeringCostReservation;

    await assert.rejects(
      ledger.release({
        releaseIdempotencyKey: digest({
          operation: "release-engineering-reservation",
          reservation: digest(forged),
          settlements: []
        }),
        reservation: forged,
        settledPhases: [],
        expectedOpenHoldDigests: [],
        now: NOW
      }),
      (error: unknown) => engineeringCodeOf(error) === "ADAPTER_CONFLICT"
    );

    const usageLedger = openDurableEngineeringProviderUsageLedger({
      substrate: journal,
      signer: evidenceSigner,
      observer: usageObserver(() => ({
        actualCostUnits: 4,
        actualCalls: 1,
        actualTokens: 40,
        providerUsageDigest: digest({ provider: "forged" })
      }))
    });
    // A forged reservation cannot even take a hold: the ledger refuses to
    // commit budget against a reservation it never made, so no attempt can
    // exist to settle against it.
    await assert.rejects(
      ledger.hold({
        reservation: forged,
        phase: "framing",
        sequence: 1,
        now: NOW
      }),
      (error: unknown) => engineeringCodeOf(error) === "ADAPTER_CONFLICT"
    );
    const attemptHold = await ledger.hold({
      reservation: real,
      phase: "framing",
      sequence: 1,
      now: NOW
    });
    // A real hold cannot be re-pointed at the fabricated reservation either:
    // the attempt must name the reservation its hold was committed against, so
    // the forged reservation can never acquire an attempt to settle with.
    await assert.rejects(
      usageLedger.begin({
        hold: attemptHold,
        reservation: forged,
        phase: "framing",
        sequence: 1,
        priorSettlements: [],
        now: NOW,
        reconciliationExpiresAt: reconciliationExpiry(forged.expiresAt)
      }),
      (error: unknown) => engineeringCodeOf(error) === "ADAPTER_ARGUMENT_INVALID"
    );

    // The honest attempt exists, but settling it against the fabricated
    // reservation is still refused: the reservation was never durably reserved.
    const attempt = await usageLedger.begin({
      hold: attemptHold,
      reservation: real,
      phase: "framing",
      sequence: 1,
      priorSettlements: [],
      now: NOW,
      reconciliationExpiresAt: reconciliationExpiry(real.expiresAt)
    });
    const usage = await usageLedger.reconcile({
      reservation: real,
      attempt,
      now: NOW
    });
    await assert.rejects(
      ledger.settle({
        reservation: forged,
        attempt,
        hold: attemptHold,
        usage,
        phase: "framing",
        actualCostUnits: 4,
        actualCalls: 1,
        actualTokens: 40,
        providerUsageDigest: digest({ provider: "forged" }),
        now: NOW
      }),
      (error: unknown) => engineeringCodeOf(error) === "ADAPTER_ARGUMENT_INVALID"
    );

    // The pool is unchanged: a second real reservation still sees exactly what
    // the first one left.
    const second = await ledger.reserve({
      workAccordDigest: digest({ accord: 2 }),
      activationLeaseDigest: digest({ lease: 2 }),
      phaseBudgets: PHASE_BUDGETS,
      phaseTokenBudgets: PHASE_TOKEN_BUDGETS,
      maxCalls: 3,
      maxTokens: 1_000,
      now: NOW,
      expiresAt: BUDGET_EXPIRES_AT
    });
    assert.equal(second.remainingBefore, real.remainingAfter);
  } finally {
    stateStore.close();
    journal.close();
    root.cleanup();
  }
});

test("a settlement that disagrees with its provider usage is refused", async () => {
  const root = temporaryStoreRoot("cost-usage-binding");
  const stateStore = openStore(root, "runtime-state-store");
  const journal = openStore(root, "receipt-journal");
  try {
    const ledger = costLedger(stateStore, 100, openDurableEngineeringProviderEvidence({ substrate: journal }));
    const usageDigest = digest({ provider: "reference", call: 5 });
    const usageLedger = openDurableEngineeringProviderUsageLedger({
      substrate: journal,
      signer: evidenceSigner,
      observer: usageObserver(() => ({
        actualCostUnits: 7,
        actualCalls: 1,
        actualTokens: 70,
        providerUsageDigest: usageDigest
      }))
    });
    const reservation = await reserveFixture(ledger);
    const attemptHold = await ledger.hold({
      reservation,
      phase: "framing",
      sequence: 1,
      now: NOW
    });
    const attempt = await usageLedger.begin({
      reservation,
      hold: attemptHold,
      phase: "framing",
      sequence: 1,
      priorSettlements: [],
      now: NOW,
      reconciliationExpiresAt: reconciliationExpiry(reservation.expiresAt)
    });
    const usage = await usageLedger.reconcile({ reservation, attempt, now: NOW });
    // Understating the cost would return the difference to the pool as if it
    // had never been spent.
    await assert.rejects(
      ledger.settle({
        reservation,
        attempt,
        hold: attemptHold,
        usage,
        phase: "framing",
        actualCostUnits: 1,
        actualCalls: 1,
        actualTokens: 70,
        providerUsageDigest: usageDigest,
        now: NOW
      }),
      (error: unknown) => engineeringCodeOf(error) === "ADAPTER_ARGUMENT_INVALID"
    );

    const settlement = await ledger.settle({
      reservation,
      attempt,
      hold: attemptHold,
      usage,
      phase: "framing",
      actualCostUnits: 7,
      actualCalls: 1,
      actualTokens: 70,
      providerUsageDigest: usageDigest,
      now: NOW
    });
    assert.equal(settlement.actualCostUnits, 7);
  } finally {
    stateStore.close();
    journal.close();
    root.cleanup();
  }
});

test("a reservation the caller's validator would reject is never persisted", async () => {
  const root = temporaryStoreRoot("cost-validator-mirror");
  const substrate = openStore(root, "runtime-state-store");
  try {
    const ledger = costLedger(substrate);
    await assert.rejects(
      ledger.reserve({
        workAccordDigest: digest({ accord: 1 }),
        activationLeaseDigest: digest({ lease: 1 }),
        phaseBudgets: PHASE_BUDGETS,
        phaseTokenBudgets: PHASE_TOKEN_BUDGETS,
        maxCalls: 0,
        maxTokens: 1_000,
        now: NOW,
        expiresAt: BUDGET_EXPIRES_AT
      }),
      (error: unknown) => engineeringCodeOf(error) === "ADAPTER_ARGUMENT_INVALID"
    );
    await assert.rejects(
      ledger.reserve({
        workAccordDigest: digest({ accord: 1 }),
        activationLeaseDigest: digest({ lease: 1 }),
        phaseBudgets: PHASE_BUDGETS,
        phaseTokenBudgets: PHASE_TOKEN_BUDGETS,
        maxCalls: 3,
        maxTokens: 1_000,
        now: BUDGET_EXPIRES_AT,
        expiresAt: BUDGET_EXPIRES_AT
      }),
      (error: unknown) => engineeringCodeOf(error) === "ADAPTER_ARGUMENT_INVALID"
    );
    const chain = await substrate.verifyChain("engineering.cost-ledger");
    assert.equal(chain.length, 0);
  } finally {
    substrate.close();
    root.cleanup();
  }
});

test("a successor landing first does not make a landed predecessor look failed", async () => {
  const root = temporaryStoreRoot("evidence-successor");
  const inner = openStore(root, "evidence-store");
  try {
    const first = effectEvidence();
    const second = effectEvidence({
      sequence: 2,
      previousEvidenceDigest: digest(first),
      state: "completed",
      effectDigest: digest({ effect: "done" }),
      updatedAt: "2026-08-30T12:05:00.000Z"
    });
    // Between the append and the postcondition proof, a legitimate successor
    // lands. The predecessor's write did happen and must not be reported as a
    // conflict just because it is no longer current.
    let appends = 0;
    const racing = lyingSubstrate(inner, {
      appendOnce: async (request) => {
        const outcome = await inner.appendOnce(request);
        appends += 1;
        if (appends === 1) {
          const store = openDurableEngineeringEvidenceStore({ substrate: inner });
          await store.conditionalAppend(first, second);
        }
        return outcome;
      }
    });
    const store = openDurableEngineeringEvidenceStore({ substrate: racing });
    await store.conditionalAppend(null, first);
    assert.equal(
      canonicalJson(await store.read(first.effectKey)),
      canonicalJson(second),
      "the successor is current, and the predecessor's write still succeeded"
    );
  } finally {
    inner.close();
    root.cleanup();
  }
});

test("a ledger cannot be reopened under a different pool authority", async () => {
  const root = temporaryStoreRoot("cost-budget-rebind");
  const opened = openStore(root, "runtime-state-store");
  try {
    await reserveFixture(costLedger(opened, 100));
  } finally {
    opened.close();
  }
  const reopened = openStore(root, "runtime-state-store");
  try {
    // Reopening a 100-unit ledger that has 64 left as a 50-unit ledger would
    // otherwise accept 64 units of headroom the new authority never granted.
    await assert.rejects(
      reserveFixture(costLedger(reopened, 50)),
      (error: unknown) => engineeringCodeOf(error) === "ADAPTER_BINDING_INVALID"
    );
  } finally {
    reopened.close();
    root.cleanup();
  }
});

test("one activation lease reserves once even under a different work accord", async () => {
  const root = temporaryStoreRoot("cost-lease-identity");
  const substrate = openStore(root, "runtime-state-store");
  try {
    const ledger = costLedger(substrate);
    await reserveFixture(ledger);
    // Same lease, different accord. Treating this as a new reservation would
    // let one authorization spend the pool twice.
    await assert.rejects(
      ledger.reserve({
        workAccordDigest: digest({ accord: 99 }),
        activationLeaseDigest: digest({ lease: 1 }),
        phaseBudgets: PHASE_BUDGETS,
        phaseTokenBudgets: PHASE_TOKEN_BUDGETS,
        maxCalls: 3,
        maxTokens: 1_000,
        now: NOW,
        expiresAt: BUDGET_EXPIRES_AT
      }),
      (error: unknown) => engineeringCodeOf(error) === "ADAPTER_CONFLICT"
    );
    const chain = await substrate.verifyChain("engineering.cost-ledger");
    assert.equal(chain.length, 1);
  } finally {
    substrate.close();
    root.cleanup();
  }
});

test("a corrupted earlier revision is detected, not hidden behind a valid head", async () => {
  const root = temporaryStoreRoot("evidence-history-corrupt");
  const first = effectEvidence();
  const second = effectEvidence({
    sequence: 2,
    previousEvidenceDigest: digest(first),
    state: "completed",
    effectDigest: digest({ effect: "done" }),
    updatedAt: "2026-08-30T12:05:00.000Z"
  });
  const opened = openStore(root, "evidence-store");
  try {
    const store = openDurableEngineeringEvidenceStore({ substrate: opened });
    await store.conditionalAppend(null, first);
    await store.conditionalAppend(first, second);
  } finally {
    opened.close();
  }
  // Rewrite the *earlier* revision. The head row stays independently valid, so
  // only a whole-chain check can see that the history is broken.
  await mutate(
    pathFor(root, "evidence-store"),
    "UPDATE durable_record SET body = X'00' WHERE key = 'evidence.1'"
  );
  const reopened = openStore(root, "evidence-store");
  try {
    const store = openDurableEngineeringEvidenceStore({ substrate: reopened });
    await assert.rejects(
      store.read(first.effectKey),
      (error: unknown) =>
        error instanceof DurableSubstrateError ||
        error instanceof DurableEngineeringStoreError
    );
  } finally {
    reopened.close();
    root.cleanup();
  }
});

test("a replayed attempt against a different settlement history is refused", async () => {
  const root = temporaryStoreRoot("provider-attempt-history");
  const stateStore = openStore(root, "runtime-state-store");
  const journal = openStore(root, "receipt-journal");
  try {
    const ledger = costLedger(stateStore, 100, openDurableEngineeringProviderEvidence({ substrate: journal }));
    const usageDigest = digest({ provider: "reference", call: 8 });
    const usageLedger = openDurableEngineeringProviderUsageLedger({
      substrate: journal,
      signer: evidenceSigner,
      observer: usageObserver(() => ({
        actualCostUnits: 4,
        actualCalls: 1,
        actualTokens: 40,
        providerUsageDigest: usageDigest
      }))
    });
    const reservation = await reserveFixture(ledger);
    const attemptHold = await ledger.hold({
      reservation,
      phase: "framing",
      sequence: 1,
      now: NOW
    });
    const attempt = await usageLedger.begin({
      reservation,
      hold: attemptHold,
      phase: "framing",
      sequence: 1,
      priorSettlements: [],
      now: NOW,
      reconciliationExpiresAt: reconciliationExpiry(reservation.expiresAt)
    });
    const usage = await usageLedger.reconcile({ reservation, attempt, now: NOW });
    const settlement = await ledger.settle({
      reservation,
      attempt,
      hold: attemptHold,
      usage,
      phase: "framing",
      actualCostUnits: 4,
      actualCalls: 1,
      actualTokens: 40,
      providerUsageDigest: usageDigest,
      now: NOW
    });
    // Same (reservation, phase, sequence) but a settlement history that moves
    // every projected cumulative. Handing back the stored attempt would be a
    // success the caller's validator rejects immediately.
    await assert.rejects(
      usageLedger.begin({
        reservation,
        hold: attemptHold,
        phase: "framing",
        sequence: 1,
        priorSettlements: [settlement],
        now: NOW,
        reconciliationExpiresAt: reconciliationExpiry(reservation.expiresAt)
      }),
      (error: unknown) => engineeringCodeOf(error) === "ADAPTER_CONFLICT"
    );
  } finally {
    stateStore.close();
    journal.close();
    root.cleanup();
  }
});

test("a forged unresolved attempt cannot inflate the released pool", async () => {
  const root = temporaryStoreRoot("cost-forged-hold");
  const stateStore = openStore(root, "runtime-state-store");
  const journal = openStore(root, "receipt-journal");
  const usageDigest = digest({ provider: "reference", call: 9 });
  try {
    const ledger = costLedger(stateStore, 100, openDurableEngineeringProviderEvidence({ substrate: journal }));
    const usageLedger = openDurableEngineeringProviderUsageLedger({
      substrate: journal,
      signer: evidenceSigner,
      // Framing resolves; execution never does, so its budget must stay held.
      observer: {
        observe: async ({ attempt }) =>
          attempt.phase === "framing"
            ? {
                actualCostUnits: 4,
                actualCalls: 1,
                actualTokens: 40,
                providerUsageDigest: usageDigest
              }
            : null
      }
    });
    const reservation = await reserveFixture(ledger);
    assert.equal(reservation.totalReserved, 36);
    assert.equal(reservation.remainingAfter, 64);

    const framingHold = await ledger.hold({
      reservation,
      phase: "framing",
      sequence: 1,
      now: NOW
    });
    const framing = await usageLedger.begin({
      reservation,
      hold: framingHold,
      phase: "framing",
      sequence: 1,
      priorSettlements: [],
      now: NOW,
      reconciliationExpiresAt: reconciliationExpiry(reservation.expiresAt)
    });
    const framingUsage = await usageLedger.reconcile({
      reservation,
      attempt: framing,
      now: NOW
    });
    const settlement = await ledger.settle({
      reservation,
      attempt: framing,
      hold: framingHold,
      usage: framingUsage,
      phase: "framing",
      actualCostUnits: 4,
      actualCalls: 1,
      actualTokens: 40,
      providerUsageDigest: usageDigest,
      now: NOW
    });

    const executionHold = await ledger.hold({
      reservation,
      phase: "execution",
      sequence: 2,
      now: NOW
    });
    const execution = await usageLedger.begin({
      reservation,
      hold: executionHold,
      phase: "execution",
      sequence: 2,
      priorSettlements: [settlement],
      now: NOW,
      reconciliationExpiresAt: reconciliationExpiry(reservation.expiresAt)
    });
    const executionUsage = await usageLedger.reconcile({
      reservation,
      attempt: execution,
      now: NOW
    });
    assert.equal(executionUsage.status, "unknown");
    assert.equal(execution.phaseBudget, PHASE_BUDGETS.execution);

    const releaseKey = digest({
      operation: "release-engineering-reservation",
      reservation: digest(reservation),
      settlements: [digest(settlement)]
    });
    const releaseWith = async (
      expectedOpenHoldDigests: readonly Digest[]
    ): Promise<EngineeringCostRelease> =>
      ledger.release({
        releaseIdempotencyKey: releaseKey,
        reservation,
        settledPhases: [settlement],
        expectedOpenHoldDigests,
        now: NOW
      });

    const entriesBefore = (await stateStore.verifyChain("engineering.cost-ledger"))
      .length;
    assert.equal(
      entriesBefore,
      4,
      "reservation, framing hold, framing settlement, and the open execution hold"
    );

    // A hold this ledger never wrote cannot be presented as open. The digest is
    // well formed and the attempt it was derived from is real, but the ledger
    // compares against its own durable holds rather than accepting the claim.
    await assert.rejects(
      releaseWith([digest(execution)]),
      (error: unknown) => engineeringCodeOf(error) === "ADAPTER_ARGUMENT_INVALID"
    );
    // A forged low phase budget is no longer even expressible against release:
    // the caller supplies digests of holds, never restated amounts, and the
    // held total is derived from the reservation.
    const forgedLow = {
      ...executionHold,
      heldCostUnits: 0
    } as EngineeringCostHold;
    await assert.rejects(
      releaseWith([digest(forgedLow)]),
      (error: unknown) => engineeringCodeOf(error) === "ADAPTER_ARGUMENT_INVALID"
    );
    // Naming the same open hold twice is refused rather than counted twice.
    await assert.rejects(
      releaseWith([digest(executionHold), digest(executionHold)]),
      (error: unknown) => engineeringCodeOf(error) === "ADAPTER_ARGUMENT_INVALID"
    );

    assert.equal(
      (await stateStore.verifyChain("engineering.cost-ledger")).length,
      entriesBefore,
      "every refused release must be refused before any durable write"
    );

    // The regression this issue exists for. The caller omits the open execution
    // hold entirely — exactly what happens when an exception or a crash lands
    // between the durable hold and the caller's own bookkeeping. The release
    // must still hold that budget, because it derives the open set from durable
    // state and never from the caller's list.
    const omitted = await releaseWith([]);
    assert.equal(
      omitted.heldCostUnits,
      PHASE_BUDGETS.execution,
      "an omitted open hold must still hold its reserved budget"
    );
    assert.equal(omitted.reconciliationRequired, true);
    assert.equal(
      digest(omitted.unresolvedHolds.map((hold) => digest(hold))),
      digest([digest(executionHold)]),
      "the release reports exactly the durable open hold the caller omitted"
    );
    assert.equal(
      omitted.cumulativeCostUnits +
        omitted.cumulativeReleasedCostUnits +
        omitted.heldCostUnits,
      reservation.totalReserved,
      "spent, returned, and still held must account for every reserved unit"
    );
    validateCostRelease({
      release: omitted,
      reservation,
      settlements: [settlement],
      knownOpenHolds: [],
      verifier: evidenceVerifier,
      now: NOW,
      maximumAgeMs: MAX_AGE_MS
    });
    // A caller that *does* know the hold is open agrees with the same release.
    validateCostRelease({
      release: omitted,
      reservation,
      settlements: [settlement],
      knownOpenHolds: [executionHold],
      verifier: evidenceVerifier,
      now: NOW,
      maximumAgeMs: MAX_AGE_MS
    });

  } finally {
    stateStore.close();
    journal.close();
  }

  // The pool must be exactly what honest accounting leaves. Of 100, 36 was
  // reserved; framing settled at 4 and returned its 6 unspent units; the
  // release returned verification's 6, which were never held; and execution's
  // 20 stay held by an open hold whose usage never resolved. 100 - 36 + 6 + 6
  // is 76. Had a forged low hold been honoured, execution's 20 would have been
  // released too, leaving 96 for a later reservation to consume.
  const reopened = openStore(root, "runtime-state-store");
  try {
    const ledger = costLedger(reopened, 100);
    const oversized = { framing: 30, execution: 30, verification: 20 } as const;
    await assert.rejects(
      ledger.reserve({
        workAccordDigest: digest({ accord: "oversized" }),
        activationLeaseDigest: digest({ lease: "oversized" }),
        phaseBudgets: oversized,
        phaseTokenBudgets: PHASE_TOKEN_BUDGETS,
        maxCalls: 3,
        maxTokens: 1_000,
        now: NOW,
        expiresAt: BUDGET_EXPIRES_AT
      }),
      (error: unknown) => engineeringCodeOf(error) === "ADAPTER_CONFLICT"
    );
    const fitting = await ledger.reserve({
      workAccordDigest: digest({ accord: "fitting" }),
      activationLeaseDigest: digest({ lease: "fitting" }),
      phaseBudgets: { framing: 30, execution: 30, verification: 16 },
      phaseTokenBudgets: PHASE_TOKEN_BUDGETS,
      maxCalls: 3,
      maxTokens: 1_000,
      now: NOW,
      expiresAt: BUDGET_EXPIRES_AT
    });
    assert.equal(
      fitting.remainingBefore,
      76,
      "the durable pool must reflect honest accounting only"
    );
    assert.equal(fitting.remainingAfter, 0);
  } finally {
    reopened.close();
    root.cleanup();
  }
});

test("an honest release conserves the reservation exactly", async () => {
  const root = temporaryStoreRoot("cost-conservation");
  const stateStore = openStore(root, "runtime-state-store");
  const journal = openStore(root, "receipt-journal");
  const usageDigest = digest({ provider: "reference", call: 10 });
  try {
    const ledger = costLedger(stateStore, 100, openDurableEngineeringProviderEvidence({ substrate: journal }));
    const usageLedger = openDurableEngineeringProviderUsageLedger({
      substrate: journal,
      signer: evidenceSigner,
      observer: {
        observe: async ({ attempt }) =>
          attempt.phase === "framing"
            ? {
                actualCostUnits: 4,
                actualCalls: 1,
                actualTokens: 40,
                providerUsageDigest: usageDigest
              }
            : null
      }
    });
    const reservation = await reserveFixture(ledger);
    const framingHold = await ledger.hold({
      reservation,
      phase: "framing",
      sequence: 1,
      now: NOW
    });
    const framing = await usageLedger.begin({
      reservation,
      hold: framingHold,
      phase: "framing",
      sequence: 1,
      priorSettlements: [],
      now: NOW,
      reconciliationExpiresAt: reconciliationExpiry(reservation.expiresAt)
    });
    const framingUsage = await usageLedger.reconcile({
      reservation,
      attempt: framing,
      now: NOW
    });
    const settlement = await ledger.settle({
      reservation,
      attempt: framing,
      hold: framingHold,
      usage: framingUsage,
      phase: "framing",
      actualCostUnits: 4,
      actualCalls: 1,
      actualTokens: 40,
      providerUsageDigest: usageDigest,
      now: NOW
    });
    const executionHold = await ledger.hold({
      reservation,
      phase: "execution",
      sequence: 2,
      now: NOW
    });
    const execution = await usageLedger.begin({
      reservation,
      hold: executionHold,
      phase: "execution",
      sequence: 2,
      priorSettlements: [settlement],
      now: NOW,
      reconciliationExpiresAt: reconciliationExpiry(reservation.expiresAt)
    });

    const release = await ledger.release({
      releaseIdempotencyKey: digest({
        operation: "release-engineering-reservation",
        reservation: digest(reservation),
        settlements: [digest(settlement)]
      }),
      reservation,
      settledPhases: [settlement],
      expectedOpenHoldDigests: [digest(executionHold)],
      now: NOW
    });
    validateCostRelease({
      release,
      reservation,
      settlements: [settlement],
      knownOpenHolds: [executionHold],
      verifier: evidenceVerifier,
      now: NOW,
      maximumAgeMs: MAX_AGE_MS
    });

    // Spent, returned, and still held must account for every reserved unit.
    assert.equal(release.heldCostUnits, PHASE_BUDGETS.execution);
    assert.equal(release.cumulativeCostUnits, 4);
    assert.equal(
      release.cumulativeCostUnits +
        release.cumulativeReleasedCostUnits +
        release.heldCostUnits,
      reservation.totalReserved,
      "release must conserve the reservation exactly"
    );
  } finally {
    stateStore.close();
    journal.close();
    root.cleanup();
  }
});

test("a forged provider usage cannot be settled", async () => {
  const root = temporaryStoreRoot("cost-forged-usage");
  const stateStore = openStore(root, "runtime-state-store");
  const journal = openStore(root, "receipt-journal");
  try {
    const ledger = costLedger(
      stateStore,
      100,
      openDurableEngineeringProviderEvidence({ substrate: journal })
    );
    const usageDigest = digest({ provider: "reference", call: 11 });
    const usageLedger = openDurableEngineeringProviderUsageLedger({
      substrate: journal,
      signer: evidenceSigner,
      observer: usageObserver(() => ({
        actualCostUnits: 9,
        actualCalls: 1,
        actualTokens: 90,
        providerUsageDigest: usageDigest
      }))
    });
    const reservation = await reserveFixture(ledger);
    const attemptHold = await ledger.hold({
      reservation,
      phase: "framing",
      sequence: 1,
      now: NOW
    });
    const attempt = await usageLedger.begin({
      reservation,
      hold: attemptHold,
      phase: "framing",
      sequence: 1,
      priorSettlements: [],
      now: NOW,
      reconciliationExpiresAt: reconciliationExpiry(reservation.expiresAt)
    });

    // A well-formed, correctly signed usage that the provider usage ledger
    // never recorded. Settling it would report a cost of zero and return the
    // whole framing budget to the pool; the settlement's own arguments agree
    // with it, so the caller-side consistency check cannot catch it.
    const forgedPayload = {
      attemptDigest: digest(attempt),
      phase: "framing" as const,
      status: "settled" as const,
      actualCostUnits: 0,
      actualCalls: 1,
      actualTokens: 0,
      providerUsageDigest: digest({ provider: "forged" }),
      observedAt: NOW
    };
    const forgedUsage = {
      ...forgedPayload,
      signature: await evidenceSigner.sign(forgedPayload)
    };
    await assert.rejects(
      ledger.settle({
        reservation,
        attempt,
        hold: attemptHold,
        usage: forgedUsage,
        phase: "framing",
        actualCostUnits: 0,
        actualCalls: 1,
        actualTokens: 0,
        providerUsageDigest: forgedPayload.providerUsageDigest,
        now: NOW
      }),
      (error: unknown) => engineeringCodeOf(error) === "ADAPTER_CONFLICT"
    );
    assert.equal(
      (await stateStore.verifyChain("engineering.cost-ledger")).length,
      2,
      "no settlement may be written from unrecorded usage; only the reservation and its hold exist"
    );

    // The genuine reconciliation settles normally, at its real cost.
    const usage = await usageLedger.reconcile({ reservation, attempt, now: NOW });
    const settlement = await ledger.settle({
      reservation,
      attempt,
      hold: attemptHold,
      usage,
      phase: "framing",
      actualCostUnits: 9,
      actualCalls: 1,
      actualTokens: 90,
      providerUsageDigest: usageDigest,
      now: NOW
    });
    assert.equal(settlement.actualCostUnits, 9);
    assert.equal(settlement.releasedCostUnits, PHASE_BUDGETS.framing - 9);
  } finally {
    stateStore.close();
    journal.close();
    root.cleanup();
  }
});

test("the cost ledger survives a restart with its pool and chain intact", async () => {
  const root = temporaryStoreRoot("cost-restart");
  let reservation: EngineeringCostReservation;
  const opened = openStore(root, "runtime-state-store");
  try {
    reservation = await reserveFixture(costLedger(opened));
  } finally {
    opened.close();
  }
  const reopened = openStore(root, "runtime-state-store");
  try {
    const ledger = costLedger(reopened);
    const again = await reserveFixture(ledger);
    assert.equal(
      canonicalJson(again),
      canonicalJson(reservation),
      "the reservation must be recovered, not re-minted"
    );
    // A second, different lease reserves against the pool the first one left.
    const second = await ledger.reserve({
      workAccordDigest: digest({ accord: 2 }),
      activationLeaseDigest: digest({ lease: 2 }),
      phaseBudgets: PHASE_BUDGETS,
      phaseTokenBudgets: PHASE_TOKEN_BUDGETS,
      maxCalls: 3,
      maxTokens: 1_000,
      now: NOW,
      expiresAt: BUDGET_EXPIRES_AT
    });
    assert.equal(second.remainingBefore, reservation.remainingAfter);
    assert.equal(second.ledgerHeadBefore, reservation.ledgerHeadAfter);
  } finally {
    reopened.close();
    root.cleanup();
  }
});

test("a corrupted ledger envelope is refused rather than replayed", async () => {
  const root = temporaryStoreRoot("cost-corrupt");
  const opened = openStore(root, "runtime-state-store");
  try {
    await reserveFixture(costLedger(opened));
  } finally {
    opened.close();
  }
  const rewritten = { kind: "reservation", document: {}, pooledRemainingAfter: 1 };
  await rewriteBody(pathFor(root, "runtime-state-store"), "entry.1", rewritten);
  const reopened = openStore(root, "runtime-state-store");
  try {
    await assert.rejects(
      reserveFixture(costLedger(reopened)),
      (error: unknown) =>
        error instanceof DurableEngineeringStoreError ||
        error instanceof DurableSubstrateError
    );
  } finally {
    reopened.close();
    root.cleanup();
  }
});

test("a ledger compare-and-swap that loses its head is refused, not silently applied", async () => {
  const root = temporaryStoreRoot("cost-cas-conflict");
  const inner = openStore(root, "runtime-state-store");
  try {
    // A permanently conflicting head exhausts the bounded retry rather than
    // spinning, and never falls back to an unfenced write.
    const liar = lyingSubstrate(inner, {
      compareAndSwap: async (): Promise<DurableWriteOutcome> => ({
        status: "conflict",
        record: null
      })
    });
    await assert.rejects(
      reserveFixture(costLedger(liar)),
      (error: unknown) => engineeringCodeOf(error) === "ADAPTER_CONFLICT"
    );
    const chain = await inner.verifyChain("engineering.cost-ledger");
    assert.equal(chain.length, 0);
  } finally {
    inner.close();
    root.cleanup();
  }
});

test("a final-attempt ambiguity that landed is recovered, not reported as failure", async () => {
  const root = temporaryStoreRoot("cost-final-attempt");
  const inner = openStore(root, "runtime-state-store");
  try {
    // The first two attempts are ambiguous and did not write; the third writes
    // and only then loses its acknowledgement, so the bounded loop ends with a
    // conflict even though the mutation is durably present. Without the
    // post-loop derivation the caller would be told the reservation failed
    // while the budget was already committed.
    let attempts = 0;
    const flaky = lyingSubstrate(inner, {
      compareAndSwap: async (request) => {
        attempts += 1;
        if (attempts >= 3) await inner.compareAndSwap(request);
        throw new DurableAmbiguousAcknowledgementError(
          "engineering.cost-ledger",
          request.key
        );
      }
    });
    const reservation = await reserveFixture(costLedger(flaky));
    assert.equal(attempts, 3, "the bounded retry must have been exhausted");
    const chain = await inner.verifyChain("engineering.cost-ledger");
    assert.equal(chain.length, 1, "exactly one entry may exist");
    validateCostReservation({
      reservation,
      verifier: evidenceVerifier,
      workAccordDigest: digest({ accord: 1 }),
      activationLeaseDigest: digest({ lease: 1 }),
      phaseBudgets: PHASE_BUDGETS,
      phaseTokenBudgets: PHASE_TOKEN_BUDGETS,
      maxCalls: 3,
      maxTokens: 1_000,
      now: NOW,
      maximumAgeMs: MAX_AGE_MS
    });
  } finally {
    inner.close();
    root.cleanup();
  }
});

test("an unresolved attempt cannot hold a phase that already settled", async () => {
  const root = temporaryStoreRoot("cost-phase-overlap");
  const stateStore = openStore(root, "runtime-state-store");
  const journal = openStore(root, "receipt-journal");
  try {
    const ledger = costLedger(stateStore, 100, openDurableEngineeringProviderEvidence({ substrate: journal }));
    const usageDigest = digest({ provider: "reference", call: 7 });
    let settledOnce = false;
    const usageLedger = openDurableEngineeringProviderUsageLedger({
      substrate: journal,
      signer: evidenceSigner,
      observer: {
        observe: async () => {
          if (settledOnce) return null;
          settledOnce = true;
          return {
            actualCostUnits: 4,
            actualCalls: 1,
            actualTokens: 40,
            providerUsageDigest: usageDigest
          };
        }
      }
    });
    const reservation = await reserveFixture(ledger);
    const settledAttemptHold = await ledger.hold({
      reservation,
      phase: "framing",
      sequence: 1,
      now: NOW
    });
    const settledAttempt = await usageLedger.begin({
      reservation,
      hold: settledAttemptHold,
      phase: "framing",
      sequence: 1,
      priorSettlements: [],
      now: NOW,
      reconciliationExpiresAt: reconciliationExpiry(reservation.expiresAt)
    });
    const usage = await usageLedger.reconcile({
      reservation,
      attempt: settledAttempt,
      now: NOW
    });
    const settlement = await ledger.settle({
      reservation,
      attempt: settledAttempt,
      hold: settledAttemptHold,
      usage,
      phase: "framing",
      actualCostUnits: 4,
      actualCalls: 1,
      actualTokens: 40,
      providerUsageDigest: usageDigest,
      now: NOW
    });
    // A retry at the same phase would hold the settled units a second time and
    // strand them. That is refused where the budget is committed, so no second
    // attempt can be opened against the phase at all.
    await assert.rejects(
      ledger.hold({
        reservation,
        phase: "framing",
        sequence: 2,
        now: NOW
      }),
      (error: unknown) => engineeringCodeOf(error) === "ADAPTER_CONFLICT"
    );
    // The honest release therefore holds nothing for framing and returns its
    // unspent units exactly once.
    const release = await ledger.release({
      releaseIdempotencyKey: digest({
        operation: "release-engineering-reservation",
        reservation: digest(reservation),
        settlements: [digest(settlement)]
      }),
      reservation,
      settledPhases: [settlement],
      expectedOpenHoldDigests: [],
      now: NOW
    });
    assert.equal(release.heldCostUnits, 0);
    assert.equal(release.reconciliationRequired, false);
    assert.equal(
      release.cumulativeCostUnits +
        release.cumulativeReleasedCostUnits +
        release.heldCostUnits,
      reservation.totalReserved
    );
  } finally {
    stateStore.close();
    journal.close();
    root.cleanup();
  }
});

test("a lost ledger commit acknowledgement resolves against durable state", async () => {
  const root = temporaryStoreRoot("cost-ambiguous");
  const substrate = openStore(root, "runtime-state-store");
  const { DatabaseSync } = await import("node:sqlite");
  try {
    const ledger = costLedger(substrate);
    const fault = injectCommitFailure(DatabaseSync);
    let reserved: EngineeringCostReservation;
    try {
      reserved = await reserveFixture(ledger);
    } finally {
      fault.restore();
    }
    assert.ok(fault.fired(), "the write commit fault must have been exercised");

    // The rolled-back write is decidably absent, so the ambiguity resolves to a
    // conflict, which the bounded retry then re-derives against fresh durable
    // state. Exactly one entry may exist afterwards.
    const chain = await substrate.verifyChain("engineering.cost-ledger");
    assert.equal(
      chain.length,
      1,
      "a retried ambiguous reservation must not be recorded twice"
    );
    validateCostReservation({
      reservation: reserved,
      verifier: evidenceVerifier,
      workAccordDigest: digest({ accord: 1 }),
      activationLeaseDigest: digest({ lease: 1 }),
      phaseBudgets: PHASE_BUDGETS,
      phaseTokenBudgets: PHASE_TOKEN_BUDGETS,
      maxCalls: 3,
      maxTokens: 1_000,
      now: NOW,
      maximumAgeMs: MAX_AGE_MS
    });
    assert.equal(reserved.remainingAfter, 64, "the pool must not double-count");
  } finally {
    substrate.close();
    root.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Export policy and zero fallback
// ---------------------------------------------------------------------------

const ADAPTER_MODULES = [
  "durable-domain-stores.ts",
  "durable-engineering-stores.ts"
] as const;

const SOURCE_ROOT = path.join(import.meta.dirname, "..", "..", "src");

function sourceOf(moduleName: string): string {
  return readFileSync(path.join(SOURCE_ROOT, moduleName), "utf8");
}

test("the durable adapters are not part of the public package API", () => {
  const barrel = readFileSync(path.join(SOURCE_ROOT, "index.ts"), "utf8");
  for (const moduleName of ADAPTER_MODULES) {
    assert.ok(
      !barrel.includes(`./${moduleName.replace(/\.ts$/u, ".js")}`),
      `src/index.ts must not re-export ${moduleName}: these are nonproduction reference adapters, not a supported contract`
    );
  }
  const leaked = [
    "openDurableDomainOperationGrantStore",
    "openDurableEngineeringEvidenceStore",
    "openDurableEngineeringClosureCheckpointStore",
    "openDurableEngineeringCostLedger",
    "openDurableEngineeringProviderUsageLedger",
    "DurableDomainStoreError",
    "DurableEngineeringStoreError"
  ].filter((name) => name in publicApi);
  assert.deepEqual(leaked, [], "adapter symbols must stay off the public API");
});

test("the durable adapters read no environment variable", () => {
  for (const moduleName of ADAPTER_MODULES) {
    const source = sourceOf(moduleName);
    for (const pattern of ["process.env", "getEnv", "loadEnv", "dotenv"]) {
      assert.ok(!source.includes(pattern), `${moduleName} must not reference ${pattern}`);
    }
  }
});

test("the durable adapters open no network client", () => {
  const forbidden = [
    "node:net",
    "node:http",
    "node:https",
    "node:tls",
    "node:dgram",
    "undici",
    "fetch(",
    "XMLHttpRequest",
    "WebSocket"
  ];
  for (const moduleName of ADAPTER_MODULES) {
    const source = sourceOf(moduleName);
    for (const pattern of forbidden) {
      assert.ok(!source.includes(pattern), `${moduleName} must not reference ${pattern}`);
    }
  }
});

test("the durable adapters read no ambient clock", () => {
  // `new Date(value)` and `Date.parse(value)` are deliberately allowed: they are
  // arithmetic on a timestamp the caller supplied and this module must not
  // re-derive. What is forbidden is any source of *current* time, because a
  // timestamp this module invented would not be attributable to the trusted
  // clock the caller validates against.
  const forbidden = ["Date.now(", "new Date()", "performance.now(", "hrtime"];
  for (const moduleName of ADAPTER_MODULES) {
    const source = sourceOf(moduleName);
    for (const pattern of forbidden) {
      assert.ok(
        !source.includes(pattern),
        `${moduleName} must not reference ${pattern}: timestamps come from an injected clock or a port input`
      );
    }
  }
});

test("the durable adapters handle no credential or secret material", () => {
  const forbidden = [
    "privateKey",
    "createPrivateKey",
    "createSign",
    "installationToken",
    "clientSecret",
    "webhookSecret",
    "Authorization",
    "Bearer "
  ];
  for (const moduleName of ADAPTER_MODULES) {
    const source = sourceOf(moduleName);
    for (const pattern of forbidden) {
      assert.ok(!source.includes(pattern), `${moduleName} must not reference ${pattern}`);
    }
  }
});

test("the durable adapters bind no backend and no filesystem path", () => {
  // The adapters depend only on the `DurableSubstrate` seam, so replacing the
  // engine cannot require touching them, and they cannot open a store of their
  // own choosing.
  for (const moduleName of ADAPTER_MODULES) {
    const source = sourceOf(moduleName);
    for (const specifier of ["node:sqlite", "node:fs", "node:path", "node:os"]) {
      assert.ok(
        !new RegExp(`from\\s+["']${specifier}["']`, "u").test(source),
        `${moduleName} must not import ${specifier}`
      );
    }
  }
});
