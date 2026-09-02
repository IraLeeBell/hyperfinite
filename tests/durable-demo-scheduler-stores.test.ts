/**
 * Durable adapter tests for `src/durable-demo-scheduler-stores.ts`, mapping
 * `DemoRunFenceStore` and `DemoBudgetLedger` (`src/demo-scheduler.ts`) onto
 * the local durable substrate.
 *
 * Everything time- or signature-related is injected via
 * `tests/support/durable-substrate-harness.ts`, matching the convention the
 * substrate's own tests already use, so behaviour here stays deterministic.
 */

import assert from "node:assert/strict";
import { fork } from "node:child_process";
import path from "node:path";
import { test } from "node:test";

import { digest } from "../src/canonical.js";
import { createDemoContract } from "../src/demo-portfolio.js";
import {
  createDurableDemoBudgetLedger,
  createDurableDemoRunFenceStore,
  DurableDemoSchedulerStoreAmbiguousError
} from "../src/durable-demo-scheduler-stores.js";
import {
  createDemoBudgetState,
  demoBudgetAuthorityDigest,
  type DemoBudgetState
} from "../src/demo-runtime-state.js";
import type {
  DemoBudgetReservationEvidence,
  DemoBudgetSettlementEvidence
} from "../src/demo-scheduler.js";
import type { DemoRunFence, DemoRunState } from "../src/demo-types.js";
import type { Digest } from "../src/types.js";
import {
  DurableAmbiguousAcknowledgementError,
  DurableSubstrateError,
  type DurableHead,
  type DurableRecord,
  type DurableSubstrate,
  type DurableWriteOutcome
} from "../src/durable-substrate.js";
import { openDurableSqliteSubstrate } from "../src/durable-sqlite-substrate.js";
import {
  BUSY_TIMEOUT_MS,
  harnessSignature,
  harnessSigner,
  harnessVerifier,
  SUPPORTED_NODE_MAJORS,
  temporaryStoreRoot
} from "./support/durable-substrate-harness.js";
import type {
  FenceWorkerReply,
  FenceWorkerRequest
} from "./support/durable-demo-scheduler-worker.js";

const WORKER = path.join(
  import.meta.dirname,
  "support",
  "durable-demo-scheduler-worker.js"
);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REPOSITORY_ID = 4242;
const WORK_ITEM_NODE_ID = "WI_kwDOdurablefence001";

function fenceKeyFor(repositoryId: number, workItemNodeId: string): Digest {
  return digest({ repositoryId, workItemNodeId });
}

function openStore(storePath: string, maxEntries = 512): DurableSubstrate {
  return openDurableSqliteSubstrate({
    path: storePath,
    storeId: "runtime-state-store",
    storeNamespace: "namespace-runtime-state-store",
    maxEntries,
    busyTimeoutMs: BUSY_TIMEOUT_MS,
    supportedNodeMajors: SUPPORTED_NODE_MAJORS
  });
}

/** Asserts a promise rejects with a `DurableSubstrateError` of exactly `code`. */
async function assertRefusalCode(
  operation: Promise<unknown>,
  code: DurableSubstrateError["code"]
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(
      error instanceof DurableSubstrateError,
      `expected a DurableSubstrateError, got ${String(error)}`
    );
    assert.equal(error.code, code);
    return true;
  });
}

function baseCore(): DemoRunState["spec"]["core"] {
  return {
    state: "EXECUTING",
    stateVersion: 1,
    bindingDigest: digest("binding"),
    lifecycleGraphDigest: digest("lifecycle-graph"),
    workAccordDigest: digest("work-accord"),
    capabilityRegistryDigest: digest("capability-registry"),
    domainPackDigest: digest("domain-pack"),
    phaseContractDigest: null,
    compiledPolicyDigest: null,
    policyDigest: digest("policy"),
    kernelReceiptDigest: null,
    kernelSnapshotDigest: digest("kernel-snapshot")
  };
}

function readyRunState(
  overrides: Partial<DemoRunState["spec"]> = {}
): DemoRunState {
  return createDemoContract("DemoRunState", {
    demoProjectId: "feature-delivery",
    catalogDigest: digest("catalog"),
    identityReservationsDigest: digest("identity-reservations"),
    projectProfileDigest: digest("project-profile"),
    journeyDefinitionDigest: digest("journey-definition"),
    stageAgentBindingsDigest: digest("stage-agent-bindings"),
    capabilityShardDigest: digest("capability-shard"),
    activationProfileDigest: digest("activation-profile"),
    projectionMappingDigest: digest("projection-mapping"),
    repositoryId: REPOSITORY_ID,
    workItemNodeId: WORK_ITEM_NODE_ID,
    repositoryBindingDigest: digest("repository-binding"),
    authorityEpoch: 1,
    generation: 0,
    runId: "run-1",
    runAttempt: 1,
    core: baseCore(),
    journey: {
      currentStageId: "framing",
      currentStageOrdinal: 1,
      previousStageReceiptDigest: null,
      completedStageReceiptDigests: []
    },
    fenceDigest: null,
    fenceBaseRunStateDigest: null,
    currentDraftPullRequest: null,
    status: "ready",
    updatedAt: "2026-08-30T12:00:00.000Z",
    ...overrides
  });
}

function runningRunState(input: {
  readonly base: DemoRunState;
  readonly fenceDigest: Digest;
  readonly updatedAt?: string;
}): DemoRunState {
  return createDemoContract("DemoRunState", {
    ...input.base.spec,
    fenceDigest: input.fenceDigest,
    fenceBaseRunStateDigest: input.base.contentDigest,
    status: "running",
    updatedAt: input.updatedAt ?? "2026-08-30T12:05:00.000Z"
  });
}

function proposeFence(input: {
  readonly repositoryId?: number;
  readonly workItemNodeId?: string;
  readonly previousFenceDigest: Digest | null;
  readonly runStateDigest: Digest;
  readonly status: "acquired" | "released";
  readonly acquiredAt: string;
  readonly expiresAt: string;
  readonly releasedAt: string | null;
  readonly holderDigest?: Digest;
}): DemoRunFence {
  const repositoryId = input.repositoryId ?? REPOSITORY_ID;
  const workItemNodeId = input.workItemNodeId ?? WORK_ITEM_NODE_ID;
  return createDemoContract("DemoRunFence", {
    demoProjectId: "feature-delivery",
    repositoryId,
    workItemNodeId,
    fenceKey: fenceKeyFor(repositoryId, workItemNodeId),
    authorityEpoch: 1,
    generation: 0,
    runId: "run-1",
    runAttempt: 1,
    runStateDigest: input.runStateDigest,
    dispatchDecisionDigest: digest("dispatch-decision"),
    holderDigest: input.holderDigest ?? digest("holder"),
    activationLeaseDigest: digest("activation-lease"),
    previousFenceDigest: input.previousFenceDigest,
    status: input.status,
    acquiredAt: input.acquiredAt,
    expiresAt: input.expiresAt,
    releasedAt: input.releasedAt
  });
}

function genesisBudget(
  overrides: Partial<DemoBudgetState["spec"]> = {}
): DemoBudgetState {
  return createDemoBudgetState({
    demoProjectId: "feature-delivery",
    repositoryId: REPOSITORY_ID,
    workItemNodeId: WORK_ITEM_NODE_ID,
    authorityEpoch: 1,
    generation: 0,
    activationLeaseDigest: digest("activation-lease"),
    workAccordDigest: digest("work-accord"),
    limits: {
      maxCalls: 10,
      maxTokens: 100_000,
      maxCostUnits: 1_000,
      maxDurationMs: 60_000,
      maxRetries: 3,
      maxParallel: 1
    },
    usage: { calls: 0, tokens: 0, costUnits: 0, retries: 0 },
    held: { calls: 0, tokens: 0, costUnits: 0 },
    startedAt: "2026-08-30T12:00:00.000Z",
    expiresAt: "2026-08-30T18:00:00.000Z",
    ledgerVersion: 0,
    ledgerHead: null,
    ...overrides
  });
}

function reservedBudget(input: {
  readonly current: DemoBudgetState;
  readonly tokens: number;
  readonly costUnits: number;
}): DemoBudgetState {
  return createDemoBudgetState({
    ...input.current.spec,
    held: {
      calls: input.current.spec.held.calls + 1,
      tokens: input.current.spec.held.tokens + input.tokens,
      costUnits: input.current.spec.held.costUnits + input.costUnits
    },
    ledgerVersion: input.current.spec.ledgerVersion + 1,
    ledgerHead: digest({
      previousHead: input.current.spec.ledgerHead,
      op: "reserve",
      tokens: input.tokens,
      costUnits: input.costUnits
    })
  });
}

function settledBudget(input: {
  readonly current: DemoBudgetState;
  readonly reservation: DemoBudgetState;
  readonly tokens: number;
  readonly costUnits: number;
}): DemoBudgetState {
  return createDemoBudgetState({
    ...input.current.spec,
    usage: {
      calls: input.current.spec.usage.calls + 1,
      tokens: input.current.spec.usage.tokens + input.tokens,
      costUnits: input.current.spec.usage.costUnits + input.costUnits,
      retries: input.current.spec.usage.retries
    },
    held: {
      calls: input.current.spec.held.calls - 1,
      tokens: input.current.spec.held.tokens - input.reservation.spec.held.tokens,
      costUnits:
        input.current.spec.held.costUnits - input.reservation.spec.held.costUnits
    },
    ledgerVersion: input.current.spec.ledgerVersion + 1,
    ledgerHead: digest({
      previousHead: input.current.spec.ledgerHead,
      op: "settle",
      tokens: input.tokens,
      costUnits: input.costUnits
    })
  });
}

function reservationEvidence(input: {
  readonly expected: DemoBudgetState;
  readonly next: DemoBudgetState;
  readonly tokens: number;
  readonly costUnits: number;
}): Omit<DemoBudgetReservationEvidence, "signature"> {
  return {
    schemaVersion: "1.0.0",
    reservationKey: digest({
      op: "reserve-demo-stage-cost",
      budgetStateDigest: input.expected.contentDigest
    }),
    budgetBeforeDigest: input.expected.contentDigest,
    budgetAfterDigest: input.next.contentDigest,
    dispatchDecisionDigest: digest("dispatch-decision"),
    stageId: "framing",
    runtimeBinding: {
      agentId: "agent-1",
      capabilityId: "cap@1.0.0",
      workflowId: "workflow-1"
    },
    calls: 1,
    tokens: input.tokens,
    costUnits: input.costUnits,
    reservedAt: "2026-08-30T12:01:00.000Z",
    expiresAt: input.next.spec.expiresAt
  };
}

function settlementEvidence(input: {
  readonly expected: DemoBudgetState;
  readonly next: DemoBudgetState;
  readonly reservationEvidenceValue: DemoBudgetReservationEvidence;
  readonly tokens: number;
  readonly costUnits: number;
}): Omit<DemoBudgetSettlementEvidence, "signature"> {
  return {
    schemaVersion: "1.0.0",
    reservationDigest: digest(input.reservationEvidenceValue),
    usageDigest: digest("usage-evidence-1"),
    budgetBeforeDigest: input.expected.contentDigest,
    budgetAfterDigest: input.next.contentDigest,
    calls: 1,
    tokens: input.tokens,
    costUnits: input.costUnits,
    settledAt: "2026-08-30T12:10:00.000Z"
  };
}

/**
 * Wraps a real substrate so `compareAndSwap` can be forced to raise
 * `DurableAmbiguousAcknowledgementError` on demand, letting the adapter's own
 * reconciliation be exercised without depending on a genuine SQLite commit
 * fault (which cannot be triggered deterministically from a test).
 */
function ambiguousOnceSubstrate(
  inner: DurableSubstrate,
  mode: "landed" | "lost"
): DurableSubstrate {
  let triggered = false;
  return {
    metadata: inner.metadata,
    appendOnce: (input) => inner.appendOnce(input),
    async compareAndSwap(input): Promise<DurableWriteOutcome> {
      if (!triggered) {
        triggered = true;
        if (mode === "landed") {
          await inner.compareAndSwap(input);
        }
        throw new DurableAmbiguousAcknowledgementError(
          input.namespace,
          input.key,
          "synthetic ambiguous acknowledgement for test"
        );
      }
      return inner.compareAndSwap(input);
    },
    read: (input) => inner.read(input),
    readHead: (namespace) => inner.readHead(namespace),
    readCurrent: (namespace) => inner.readCurrent(namespace),
    verifyChain: (namespace) => inner.verifyChain(namespace),
    inventory: () => inner.inventory(),
    backup: (destinationPath) => inner.backup(destinationPath),
    close: () => inner.close()
  };
}

/**
 * Wraps a real substrate so `compareAndSwap` always raises an ambiguous
 * acknowledgement without ever performing the underlying write, and the
 * *second* reconciling reread is corrupted to disagree with the first --
 * proving an unresolvable ambiguity throws rather than guessing.
 */
function unstableRereadSubstrate(inner: DurableSubstrate): DurableSubstrate {
  let readCount = 0;
  return {
    metadata: inner.metadata,
    appendOnce: (input) => inner.appendOnce(input),
    async compareAndSwap(input): Promise<DurableWriteOutcome> {
      throw new DurableAmbiguousAcknowledgementError(
        input.namespace,
        input.key,
        "synthetic ambiguous acknowledgement for test"
      );
    },
    read: (input) => inner.read(input),
    readHead: (namespace) => inner.readHead(namespace),
    async readCurrent(
      namespace
    ): Promise<{ readonly head: DurableHead; readonly record: DurableRecord | null }> {
      readCount += 1;
      const real = await inner.readCurrent(namespace);
      // The pre-write read (call 1) and the first reconciling reread (call 2)
      // pass through unchanged; only the second reconciling reread (call 3)
      // is corrupted, so the reconciliation itself sees a genuinely unstable
      // double-read rather than a store that never had anything to read.
      if (readCount === 3) {
        return {
          head: real.head,
          record: {
            namespace,
            key: "unstable-synthetic-key",
            sequence: 1,
            previousHead: null,
            head: digest("synthetic-unstable-head"),
            bodyDigest: digest("synthetic-unstable-body"),
            body: { synthetic: true }
          }
        };
      }
      return real;
    },
    verifyChain: (namespace) => inner.verifyChain(namespace),
    inventory: () => inner.inventory(),
    backup: (destinationPath) => inner.backup(destinationPath),
    close: () => inner.close()
  };
}

// ---------------------------------------------------------------------------
// DemoRunFenceStore
// ---------------------------------------------------------------------------

test("fence acquire then release round-trips the exact durable snapshot", async () => {
  const root = temporaryStoreRoot("demo-fence-roundtrip");
  const substrate = openStore(root.pathFor("s.db"));
  try {
    const store = createDurableDemoRunFenceStore(substrate);
    const base = readyRunState();
    const fence = proposeFence({
      previousFenceDigest: null,
      runStateDigest: base.contentDigest,
      status: "acquired",
      acquiredAt: "2026-08-30T12:00:00.000Z",
      expiresAt: "2026-08-30T13:00:00.000Z",
      releasedAt: null
    });
    const running = runningRunState({ base, fenceDigest: fence.contentDigest });

    const acquired = await store.acquire({
      expectedRunStateDigest: base.contentDigest,
      fence,
      runningState: running
    });
    assert.equal(acquired.status, "appended");
    assert.ok(acquired.snapshot);
    assert.equal(acquired.snapshot.fence.contentDigest, fence.contentDigest);
    assert.equal(acquired.snapshot.runState.contentDigest, running.contentDigest);

    const readBack = await store.read(fence.spec.fenceKey);
    assert.ok(readBack);
    assert.deepEqual(readBack, acquired.snapshot);

    const released = proposeFence({
      previousFenceDigest: fence.contentDigest,
      runStateDigest: base.contentDigest,
      status: "released",
      acquiredAt: fence.spec.acquiredAt,
      expiresAt: fence.spec.expiresAt,
      releasedAt: "2026-08-30T12:30:00.000Z"
    });

    const releaseResult = await store.release({
      expectedFenceDigest: fence.contentDigest,
      releasedFence: released,
      runningState: running
    });
    assert.equal(releaseResult.status, "appended");
    assert.ok(releaseResult.snapshot);
    assert.equal(releaseResult.snapshot.fence.spec.status, "released");

    const finalRead = await store.read(fence.spec.fenceKey);
    assert.deepEqual(finalRead, releaseResult.snapshot);
  } finally {
    substrate.close();
    root.cleanup();
  }
});

test("fence acquire fails closed against a stale expected run-state digest", async () => {
  const root = temporaryStoreRoot("demo-fence-stale");
  const substrate = openStore(root.pathFor("s.db"));
  try {
    const store = createDurableDemoRunFenceStore(substrate);
    const base = readyRunState();
    const fence = proposeFence({
      previousFenceDigest: null,
      runStateDigest: base.contentDigest,
      status: "acquired",
      acquiredAt: "2026-08-30T12:00:00.000Z",
      expiresAt: "2026-08-30T13:00:00.000Z",
      releasedAt: null
    });
    const running = runningRunState({ base, fenceDigest: fence.contentDigest });

    const result = await store.acquire({
      expectedRunStateDigest: digest("some-other-run-state"),
      fence,
      runningState: running
    });
    assert.equal(result.status, "conflict");
    assert.equal(result.snapshot, null);
    assert.equal(await store.read(fence.spec.fenceKey), null);
  } finally {
    substrate.close();
    root.cleanup();
  }
});

test("fence acquire fails closed while the fence is already held", async () => {
  const root = temporaryStoreRoot("demo-fence-double-acquire");
  const substrate = openStore(root.pathFor("s.db"));
  try {
    const store = createDurableDemoRunFenceStore(substrate);
    const base = readyRunState();
    const first = proposeFence({
      previousFenceDigest: null,
      runStateDigest: base.contentDigest,
      status: "acquired",
      acquiredAt: "2026-08-30T12:00:00.000Z",
      expiresAt: "2026-08-30T13:00:00.000Z",
      releasedAt: null
    });
    const running = runningRunState({ base, fenceDigest: first.contentDigest });
    const firstAcquire = await store.acquire({
      expectedRunStateDigest: base.contentDigest,
      fence: first,
      runningState: running
    });
    assert.equal(firstAcquire.status, "appended");

    // A second, distinct acquire attempt for the same work item (restart or
    // a racing scheduler) must not resurrect or double-acquire the fence.
    const second = proposeFence({
      previousFenceDigest: null,
      runStateDigest: base.contentDigest,
      status: "acquired",
      acquiredAt: "2026-08-30T12:00:01.000Z",
      expiresAt: "2026-08-30T13:00:01.000Z",
      releasedAt: null,
      holderDigest: digest("a-different-holder")
    });
    const secondAcquire = await store.acquire({
      expectedRunStateDigest: base.contentDigest,
      fence: second,
      runningState: runningRunState({ base, fenceDigest: second.contentDigest })
    });
    assert.equal(secondAcquire.status, "conflict");
    assert.equal(secondAcquire.snapshot, null);

    const stillHeld = await store.read(first.spec.fenceKey);
    assert.equal(stillHeld?.fence.contentDigest, first.contentDigest);
  } finally {
    substrate.close();
    root.cleanup();
  }
});

test("fence release fails closed against a stale expected fence digest", async () => {
  const root = temporaryStoreRoot("demo-fence-release-stale");
  const substrate = openStore(root.pathFor("s.db"));
  try {
    const store = createDurableDemoRunFenceStore(substrate);
    const base = readyRunState();
    const fence = proposeFence({
      previousFenceDigest: null,
      runStateDigest: base.contentDigest,
      status: "acquired",
      acquiredAt: "2026-08-30T12:00:00.000Z",
      expiresAt: "2026-08-30T13:00:00.000Z",
      releasedAt: null
    });
    const running = runningRunState({ base, fenceDigest: fence.contentDigest });
    await store.acquire({
      expectedRunStateDigest: base.contentDigest,
      fence,
      runningState: running
    });

    const released = proposeFence({
      previousFenceDigest: fence.contentDigest,
      runStateDigest: base.contentDigest,
      status: "released",
      acquiredAt: fence.spec.acquiredAt,
      expiresAt: fence.spec.expiresAt,
      releasedAt: "2026-08-30T12:30:00.000Z"
    });
    const result = await store.release({
      expectedFenceDigest: digest("not-the-held-fence"),
      releasedFence: released,
      runningState: running
    });
    assert.equal(result.status, "conflict");
    assert.equal(result.snapshot, null);
  } finally {
    substrate.close();
    root.cleanup();
  }
});

test("release fails closed for a fence that was never acquired", async () => {
  const root = temporaryStoreRoot("demo-fence-release-never-acquired");
  const substrate = openStore(root.pathFor("s.db"));
  try {
    const store = createDurableDemoRunFenceStore(substrate);
    const base = readyRunState();
    const neverAcquired = proposeFence({
      previousFenceDigest: null,
      runStateDigest: base.contentDigest,
      status: "acquired",
      acquiredAt: "2026-08-30T12:00:00.000Z",
      expiresAt: "2026-08-30T13:00:00.000Z",
      releasedAt: null
    });
    const released = proposeFence({
      previousFenceDigest: neverAcquired.contentDigest,
      runStateDigest: base.contentDigest,
      status: "released",
      acquiredAt: neverAcquired.spec.acquiredAt,
      expiresAt: neverAcquired.spec.expiresAt,
      releasedAt: "2026-08-30T12:30:00.000Z"
    });
    // Internally consistent with `neverAcquired` (as the real caller would
    // produce), so the *only* violated invariant under test is that this
    // fence was never durably acquired here.
    const runningState = runningRunState({
      base,
      fenceDigest: neverAcquired.contentDigest
    });
    const result = await store.release({
      expectedFenceDigest: neverAcquired.contentDigest,
      releasedFence: released,
      runningState
    });
    assert.equal(result.status, "conflict");
    assert.equal(result.snapshot, null);
  } finally {
    substrate.close();
    root.cleanup();
  }
});

test("a byte-identical acquire replay is existing, never appended twice", async () => {
  const root = temporaryStoreRoot("demo-fence-replay");
  const substrate = openStore(root.pathFor("s.db"));
  try {
    const store = createDurableDemoRunFenceStore(substrate);
    const base = readyRunState();
    const fence = proposeFence({
      previousFenceDigest: null,
      runStateDigest: base.contentDigest,
      status: "acquired",
      acquiredAt: "2026-08-30T12:00:00.000Z",
      expiresAt: "2026-08-30T13:00:00.000Z",
      releasedAt: null
    });
    const running = runningRunState({ base, fenceDigest: fence.contentDigest });

    const first = await store.acquire({
      expectedRunStateDigest: base.contentDigest,
      fence,
      runningState: running
    });
    assert.equal(first.status, "appended");

    const replay = await store.acquire({
      expectedRunStateDigest: base.contentDigest,
      fence,
      runningState: running
    });
    assert.equal(replay.status, "existing");
    assert.deepEqual(replay.snapshot, first.snapshot);
  } finally {
    substrate.close();
    root.cleanup();
  }
});

test("fence state survives a restart and a stale post-restart acquire still fails closed", async () => {
  const root = temporaryStoreRoot("demo-fence-restart");
  const storePath = root.pathFor("s.db");
  const base = readyRunState();
  const fence = proposeFence({
    previousFenceDigest: null,
    runStateDigest: base.contentDigest,
    status: "acquired",
    acquiredAt: "2026-08-30T12:00:00.000Z",
    expiresAt: "2026-08-30T13:00:00.000Z",
    releasedAt: null
  });
  const running = runningRunState({ base, fenceDigest: fence.contentDigest });

  const before = openStore(storePath);
  let acquiredSnapshot;
  try {
    const store = createDurableDemoRunFenceStore(before);
    const result = await store.acquire({
      expectedRunStateDigest: base.contentDigest,
      fence,
      runningState: running
    });
    assert.equal(result.status, "appended");
    acquiredSnapshot = result.snapshot;
  } finally {
    before.close();
  }

  const after = openStore(storePath);
  try {
    const store = createDurableDemoRunFenceStore(after);
    const readBack = await store.read(fence.spec.fenceKey);
    assert.deepEqual(readBack, acquiredSnapshot);

    // A fresh, distinct acquire attempt against the restarted store must not
    // resurrect or double-acquire the still-held fence.
    const competing = proposeFence({
      previousFenceDigest: null,
      runStateDigest: base.contentDigest,
      status: "acquired",
      acquiredAt: "2026-08-30T12:00:02.000Z",
      expiresAt: "2026-08-30T13:00:02.000Z",
      releasedAt: null,
      holderDigest: digest("post-restart-holder")
    });
    const competingResult = await store.acquire({
      expectedRunStateDigest: base.contentDigest,
      fence: competing,
      runningState: runningRunState({ base, fenceDigest: competing.contentDigest })
    });
    assert.equal(competingResult.status, "conflict");

    // The legitimate release for the exact held fence still proceeds.
    const released = proposeFence({
      previousFenceDigest: fence.contentDigest,
      runStateDigest: base.contentDigest,
      status: "released",
      acquiredAt: fence.spec.acquiredAt,
      expiresAt: fence.spec.expiresAt,
      releasedAt: "2026-08-30T12:31:00.000Z"
    });
    const releaseResult = await store.release({
      expectedFenceDigest: fence.contentDigest,
      releasedFence: released,
      runningState: running
    });
    assert.equal(releaseResult.status, "appended");
  } finally {
    after.close();
    root.cleanup();
  }
});

test("an ambiguous acquire that actually landed reconciles to existing", async () => {
  const root = temporaryStoreRoot("demo-fence-ambiguous-landed");
  const real = openStore(root.pathFor("s.db"));
  try {
    const wrapped = ambiguousOnceSubstrate(real, "landed");
    const store = createDurableDemoRunFenceStore(wrapped);
    const base = readyRunState();
    const fence = proposeFence({
      previousFenceDigest: null,
      runStateDigest: base.contentDigest,
      status: "acquired",
      acquiredAt: "2026-08-30T12:00:00.000Z",
      expiresAt: "2026-08-30T13:00:00.000Z",
      releasedAt: null
    });
    const running = runningRunState({ base, fenceDigest: fence.contentDigest });

    const result = await store.acquire({
      expectedRunStateDigest: base.contentDigest,
      fence,
      runningState: running
    });
    assert.equal(result.status, "existing");
    assert.ok(result.snapshot);
    assert.equal(result.snapshot.fence.contentDigest, fence.contentDigest);
  } finally {
    real.close();
    root.cleanup();
  }
});

test("an ambiguous acquire that never landed reconciles to conflict", async () => {
  const root = temporaryStoreRoot("demo-fence-ambiguous-lost");
  const real = openStore(root.pathFor("s.db"));
  try {
    const wrapped = ambiguousOnceSubstrate(real, "lost");
    const store = createDurableDemoRunFenceStore(wrapped);
    const base = readyRunState();
    const fence = proposeFence({
      previousFenceDigest: null,
      runStateDigest: base.contentDigest,
      status: "acquired",
      acquiredAt: "2026-08-30T12:00:00.000Z",
      expiresAt: "2026-08-30T13:00:00.000Z",
      releasedAt: null
    });
    const running = runningRunState({ base, fenceDigest: fence.contentDigest });

    const result = await store.acquire({
      expectedRunStateDigest: base.contentDigest,
      fence,
      runningState: running
    });
    assert.equal(result.status, "conflict");
    assert.equal(result.snapshot, null);
    assert.equal(await store.read(fence.spec.fenceKey), null);
  } finally {
    real.close();
    root.cleanup();
  }
});

test("an unresolvable ambiguous acquire throws rather than guessing", async () => {
  const root = temporaryStoreRoot("demo-fence-ambiguous-unstable");
  const real = openStore(root.pathFor("s.db"));
  try {
    const wrapped = unstableRereadSubstrate(real);
    const store = createDurableDemoRunFenceStore(wrapped);
    const base = readyRunState();
    const fence = proposeFence({
      previousFenceDigest: null,
      runStateDigest: base.contentDigest,
      status: "acquired",
      acquiredAt: "2026-08-30T12:00:00.000Z",
      expiresAt: "2026-08-30T13:00:00.000Z",
      releasedAt: null
    });
    const running = runningRunState({ base, fenceDigest: fence.contentDigest });

    await assert.rejects(
      store.acquire({
        expectedRunStateDigest: base.contentDigest,
        fence,
        runningState: running
      }),
      DurableDemoSchedulerStoreAmbiguousError
    );
  } finally {
    real.close();
    root.cleanup();
  }
});

test("concurrent in-process acquire attempts for the same work item yield exactly one winner", async () => {
  const root = temporaryStoreRoot("demo-fence-concurrent");
  const substrate = openStore(root.pathFor("s.db"));
  try {
    const store = createDurableDemoRunFenceStore(substrate);
    const base = readyRunState();
    let previousFenceDigest: Digest | null = null;

    for (let round = 0; round < 3; round += 1) {
      const candidates = [0, 1, 2].map((index) =>
        proposeFence({
          previousFenceDigest,
          runStateDigest: base.contentDigest,
          status: "acquired",
          acquiredAt: `2026-08-30T12:0${round}:0${index}.000Z`,
          expiresAt: `2026-08-30T13:0${round}:0${index}.000Z`,
          releasedAt: null,
          holderDigest: digest(`round-${round}-holder-${index}`)
        })
      );
      const results = await Promise.all(
        candidates.map((fence) =>
          store.acquire({
            expectedRunStateDigest: base.contentDigest,
            fence,
            runningState: runningRunState({ base, fenceDigest: fence.contentDigest })
          })
        )
      );
      const appended = results.filter((result) => result.status === "appended");
      const conflicted = results.filter((result) => result.status === "conflict");
      assert.equal(appended.length, 1, `round ${round} must have exactly one winner`);
      assert.equal(conflicted.length, 2, `round ${round} must reject the other racers`);

      // Release the winner before the next round reuses the same work item.
      const winnerIndex = results.findIndex((result) => result.status === "appended");
      const winnerFence = candidates[winnerIndex];
      assert.ok(winnerFence);
      const released = proposeFence({
        previousFenceDigest: winnerFence.contentDigest,
        runStateDigest: base.contentDigest,
        status: "released",
        acquiredAt: winnerFence.spec.acquiredAt,
        expiresAt: winnerFence.spec.expiresAt,
        releasedAt: winnerFence.spec.expiresAt
      });
      const releaseResult = await store.release({
        expectedFenceDigest: winnerFence.contentDigest,
        releasedFence: released,
        runningState: runningRunState({ base, fenceDigest: winnerFence.contentDigest })
      });
      assert.equal(releaseResult.status, "appended");
      previousFenceDigest = released.contentDigest;
    }
  } finally {
    substrate.close();
    root.cleanup();
  }
});

test("fence acquire is atomic across two independent processes", async () => {
  const root = temporaryStoreRoot("demo-fence-multiprocess");
  const storePath = root.pathFor("s.db");
  try {
    const base = readyRunState();
    const fenceA = proposeFence({
      previousFenceDigest: null,
      runStateDigest: base.contentDigest,
      status: "acquired",
      acquiredAt: "2026-08-30T12:00:00.000Z",
      expiresAt: "2026-08-30T13:00:00.000Z",
      releasedAt: null,
      holderDigest: digest("process-a-holder")
    });
    const fenceB = proposeFence({
      previousFenceDigest: null,
      runStateDigest: base.contentDigest,
      status: "acquired",
      acquiredAt: "2026-08-30T12:00:00.000Z",
      expiresAt: "2026-08-30T13:00:00.000Z",
      releasedAt: null,
      holderDigest: digest("process-b-holder")
    });
    const runningA = runningRunState({ base, fenceDigest: fenceA.contentDigest });
    const runningB = runningRunState({ base, fenceDigest: fenceB.contentDigest });

    function requestFor(
      fence: DemoRunFence,
      runningState: DemoRunState
    ): FenceWorkerRequest {
      return {
        path: storePath,
        maxEntries: 512,
        busyTimeoutMs: BUSY_TIMEOUT_MS,
        supportedNodeMajors: SUPPORTED_NODE_MAJORS,
        fence,
        runningState,
        expectedRunStateDigest: base.contentDigest
      };
    }

    const replies = await Promise.all(
      [requestFor(fenceA, runningA), requestFor(fenceB, runningB)].map(
        (request) =>
          new Promise<FenceWorkerReply>((resolve, reject) => {
            const child = fork(WORKER, [JSON.stringify(request)], {
              stdio: "inherit"
            });
            let reply: FenceWorkerReply | null = null;
            child.on("message", (message) => {
              reply = message as FenceWorkerReply;
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

    for (const reply of replies) {
      assert.equal(reply.error, null, `worker ${reply.pid} reported: ${String(reply.error)}`);
    }
    const appended = replies.filter((reply) => reply.status === "appended");
    const conflicted = replies.filter((reply) => reply.status === "conflict");
    assert.equal(appended.length, 1, "exactly one process must win the fence");
    assert.equal(conflicted.length, 1, "the other process must fail closed");
  } finally {
    root.cleanup();
  }
});

test("fence read fails closed on a malformed durable envelope", async () => {
  const root = temporaryStoreRoot("demo-fence-malformed-envelope");
  const substrate = openStore(root.pathFor("s.db"));
  try {
    const store = createDurableDemoRunFenceStore(substrate);
    const fenceKey = fenceKeyFor(REPOSITORY_ID, WORK_ITEM_NODE_ID);
    // Attack the serialized durable record directly: a caller of this
    // namespace's compare-and-swap, not the adapter, decides the body's
    // shape, so a corrupted or foreign writer can leave behind bytes the
    // adapter must refuse to trust.
    await substrate.compareAndSwap({
      namespace: fenceKey,
      key: "attacker-key",
      expectedHead: null,
      body: { not: "a fence record" }
    });

    await assertRefusalCode(store.read(fenceKey), "STORE_CORRUPT");

    const base = readyRunState();
    const fence = proposeFence({
      previousFenceDigest: null,
      runStateDigest: base.contentDigest,
      status: "acquired",
      acquiredAt: "2026-08-30T12:00:00.000Z",
      expiresAt: "2026-08-30T13:00:00.000Z",
      releasedAt: null
    });
    await assertRefusalCode(
      store.acquire({
        expectedRunStateDigest: base.contentDigest,
        fence,
        runningState: runningRunState({ base, fenceDigest: fence.contentDigest })
      }),
      "STORE_CORRUPT"
    );
  } finally {
    substrate.close();
    root.cleanup();
  }
});

test("fence read fails closed on a record bound to a different fence key", async () => {
  const root = temporaryStoreRoot("demo-fence-foreign-key");
  const substrate = openStore(root.pathFor("s.db"));
  try {
    const store = createDurableDemoRunFenceStore(substrate);
    const fenceKey = fenceKeyFor(REPOSITORY_ID, WORK_ITEM_NODE_ID);
    const foreignBase = readyRunState({
      repositoryId: 9999,
      workItemNodeId: "WI_kwDOforeignfence"
    });
    const foreignFence = proposeFence({
      repositoryId: 9999,
      workItemNodeId: "WI_kwDOforeignfence",
      previousFenceDigest: null,
      runStateDigest: foreignBase.contentDigest,
      status: "acquired",
      acquiredAt: "2026-08-30T12:00:00.000Z",
      expiresAt: "2026-08-30T13:00:00.000Z",
      releasedAt: null
    });
    // A well-formed fence-and-run-state pair, but for a *different* work
    // item's fence key, stored under this work item's namespace.
    await substrate.compareAndSwap({
      namespace: fenceKey,
      key: foreignFence.contentDigest,
      expectedHead: null,
      body: {
        kind: "DurableDemoRunFenceRecord",
        schemaVersion: "1.0.0",
        fence: foreignFence,
        runState: runningRunState({ base: foreignBase, fenceDigest: foreignFence.contentDigest })
      }
    });

    await assertRefusalCode(store.read(fenceKey), "STORE_CORRUPT");
  } finally {
    substrate.close();
    root.cleanup();
  }
});

test("fence operations propagate capacity exhaustion unchanged", async () => {
  const root = temporaryStoreRoot("demo-fence-capacity");
  const substrate = openStore(root.pathFor("s.db"), 1);
  try {
    const store = createDurableDemoRunFenceStore(substrate);
    const base = readyRunState();
    const fence = proposeFence({
      previousFenceDigest: null,
      runStateDigest: base.contentDigest,
      status: "acquired",
      acquiredAt: "2026-08-30T12:00:00.000Z",
      expiresAt: "2026-08-30T13:00:00.000Z",
      releasedAt: null
    });
    const running = runningRunState({ base, fenceDigest: fence.contentDigest });

    // Consumes the store's only journal slot.
    const acquired = await store.acquire({
      expectedRunStateDigest: base.contentDigest,
      fence,
      runningState: running
    });
    assert.equal(acquired.status, "appended");

    // Releasing needs a second composite record; the store is already full.
    const released = proposeFence({
      previousFenceDigest: fence.contentDigest,
      runStateDigest: base.contentDigest,
      status: "released",
      acquiredAt: fence.spec.acquiredAt,
      expiresAt: fence.spec.expiresAt,
      releasedAt: "2026-08-30T12:30:00.000Z"
    });
    await assertRefusalCode(
      store.release({
        expectedFenceDigest: fence.contentDigest,
        releasedFence: released,
        runningState: running
      }),
      "CAPACITY_EXHAUSTED"
    );

    // A brand-new work item's acquire is refused too: the bound is
    // store-wide, not per-namespace.
    const otherBase = readyRunState({
      repositoryId: 5150,
      workItemNodeId: "WI_kwDOanotherworkitem"
    });
    const otherFence = proposeFence({
      repositoryId: 5150,
      workItemNodeId: "WI_kwDOanotherworkitem",
      previousFenceDigest: null,
      runStateDigest: otherBase.contentDigest,
      status: "acquired",
      acquiredAt: "2026-08-30T12:00:00.000Z",
      expiresAt: "2026-08-30T13:00:00.000Z",
      releasedAt: null
    });
    await assertRefusalCode(
      store.acquire({
        expectedRunStateDigest: otherBase.contentDigest,
        fence: otherFence,
        runningState: runningRunState({ base: otherBase, fenceDigest: otherFence.contentDigest })
      }),
      "CAPACITY_EXHAUSTED"
    );
  } finally {
    substrate.close();
    root.cleanup();
  }
});

// ---------------------------------------------------------------------------
// DemoBudgetLedger
// ---------------------------------------------------------------------------

test("budget ledger read returns the injected genesis state before any transition", async () => {
  const root = temporaryStoreRoot("demo-budget-genesis");
  const substrate = openStore(root.pathFor("s.db"));
  try {
    const initialBudget = genesisBudget();
    const ledger = createDurableDemoBudgetLedger({
      substrate,
      initialBudget,
      signer: harnessSigner,
      verifier: harnessVerifier
    });
    const read = await ledger.read();
    assert.equal(read.contentDigest, initialBudget.contentDigest);
  } finally {
    substrate.close();
    root.cleanup();
  }
});

test("budget ledger reserve then settle signs evidence and persists the composite record", async () => {
  const root = temporaryStoreRoot("demo-budget-roundtrip");
  const substrate = openStore(root.pathFor("s.db"));
  try {
    const initialBudget = genesisBudget();
    const ledger = createDurableDemoBudgetLedger({
      substrate,
      initialBudget,
      signer: harnessSigner,
      verifier: harnessVerifier
    });

    const afterReserve = reservedBudget({
      current: initialBudget,
      tokens: 100,
      costUnits: 10
    });
    const reserveResult = await ledger.reserve({
      expected: initialBudget,
      next: afterReserve,
      evidence: reservationEvidence({
        expected: initialBudget,
        next: afterReserve,
        tokens: 100,
        costUnits: 10
      })
    });
    assert.equal(reserveResult.status, "appended");
    assert.ok(reserveResult.budget);
    assert.ok(reserveResult.evidence);
    assert.equal(reserveResult.budget.contentDigest, afterReserve.contentDigest);
    assert.ok(
      harnessVerifier.verify(
        (({ signature: _signature, ...rest }) => rest)(reserveResult.evidence),
        reserveResult.evidence.signature
      )
    );

    const readAfterReserve = await ledger.read();
    assert.equal(readAfterReserve.contentDigest, afterReserve.contentDigest);

    const afterSettle = settledBudget({
      current: afterReserve,
      reservation: afterReserve,
      tokens: 80,
      costUnits: 8
    });
    const settleResult = await ledger.settle({
      expected: afterReserve,
      next: afterSettle,
      evidence: settlementEvidence({
        expected: afterReserve,
        next: afterSettle,
        reservationEvidenceValue: reserveResult.evidence,
        tokens: 80,
        costUnits: 8
      })
    });
    assert.equal(settleResult.status, "appended");
    assert.ok(settleResult.budget);
    assert.ok(settleResult.evidence);
    assert.equal(settleResult.budget.contentDigest, afterSettle.contentDigest);
    assert.ok(
      harnessVerifier.verify(
        (({ signature: _signature, ...rest }) => rest)(settleResult.evidence),
        settleResult.evidence.signature
      )
    );

    const finalRead = await ledger.read();
    assert.equal(finalRead.contentDigest, afterSettle.contentDigest);
  } finally {
    substrate.close();
    root.cleanup();
  }
});

test("budget reserve fails closed against a mismatched authority", async () => {
  const root = temporaryStoreRoot("demo-budget-foreign-authority");
  const substrate = openStore(root.pathFor("s.db"));
  try {
    const initialBudget = genesisBudget();
    const ledger = createDurableDemoBudgetLedger({
      substrate,
      initialBudget,
      signer: harnessSigner,
      verifier: harnessVerifier
    });
    const foreign = genesisBudget({ workItemNodeId: "WI_kwDOforeign002" });
    const afterReserve = reservedBudget({ current: foreign, tokens: 10, costUnits: 1 });

    const result = await ledger.reserve({
      expected: foreign,
      next: afterReserve,
      evidence: reservationEvidence({
        expected: foreign,
        next: afterReserve,
        tokens: 10,
        costUnits: 1
      })
    });
    assert.equal(result.status, "conflict");
    assert.equal(result.budget, null);
    assert.equal(result.evidence, null);
  } finally {
    substrate.close();
    root.cleanup();
  }
});

test("budget reserve fails closed against a stale expected budget state", async () => {
  const root = temporaryStoreRoot("demo-budget-stale-expected");
  const substrate = openStore(root.pathFor("s.db"));
  try {
    const initialBudget = genesisBudget();
    const ledger = createDurableDemoBudgetLedger({
      substrate,
      initialBudget,
      signer: harnessSigner,
      verifier: harnessVerifier
    });
    const firstReserve = reservedBudget({
      current: initialBudget,
      tokens: 100,
      costUnits: 10
    });
    const firstResult = await ledger.reserve({
      expected: initialBudget,
      next: firstReserve,
      evidence: reservationEvidence({
        expected: initialBudget,
        next: firstReserve,
        tokens: 100,
        costUnits: 10
      })
    });
    assert.equal(firstResult.status, "appended");

    // Settle so the ledger's alternation invariant permits a second reserve,
    // but reuse the *stale* genesis budget as the expected precondition.
    const afterSettle = settledBudget({
      current: firstReserve,
      reservation: firstReserve,
      tokens: 80,
      costUnits: 8
    });
    await ledger.settle({
      expected: firstReserve,
      next: afterSettle,
      evidence: settlementEvidence({
        expected: firstReserve,
        next: afterSettle,
        reservationEvidenceValue: firstResult.evidence as DemoBudgetReservationEvidence,
        tokens: 80,
        costUnits: 8
      })
    });

    const staleNext = reservedBudget({ current: initialBudget, tokens: 5, costUnits: 1 });
    const staleResult = await ledger.reserve({
      expected: initialBudget,
      next: staleNext,
      evidence: reservationEvidence({
        expected: initialBudget,
        next: staleNext,
        tokens: 5,
        costUnits: 1
      })
    });
    assert.equal(staleResult.status, "conflict");
    assert.equal(staleResult.budget, null);
  } finally {
    substrate.close();
    root.cleanup();
  }
});

test("budget settle fails closed without an outstanding reservation", async () => {
  const root = temporaryStoreRoot("demo-budget-settle-without-reserve");
  const substrate = openStore(root.pathFor("s.db"));
  try {
    const initialBudget = genesisBudget();
    const ledger = createDurableDemoBudgetLedger({
      substrate,
      initialBudget,
      signer: harnessSigner,
      verifier: harnessVerifier
    });
    // A schema-valid but domain-nonsensical "settlement" chained directly off
    // genesis, with nothing ever reserved to settle.
    const afterSettle = createDemoBudgetState({
      ...initialBudget.spec,
      usage: { calls: 1, tokens: 0, costUnits: 0, retries: 0 },
      ledgerVersion: initialBudget.spec.ledgerVersion + 1,
      ledgerHead: digest({
        previousHead: initialBudget.spec.ledgerHead,
        op: "settle-without-reserve"
      })
    });
    const result = await ledger.settle({
      expected: initialBudget,
      next: afterSettle,
      evidence: settlementEvidence({
        expected: initialBudget,
        next: afterSettle,
        reservationEvidenceValue: {
          schemaVersion: "1.0.0",
          reservationKey: digest("phantom-reservation"),
          budgetBeforeDigest: initialBudget.contentDigest,
          budgetAfterDigest: initialBudget.contentDigest,
          dispatchDecisionDigest: digest("dispatch-decision"),
          stageId: "framing",
          runtimeBinding: {
            agentId: "agent-1",
            capabilityId: "cap@1.0.0",
            workflowId: "workflow-1"
          },
          calls: 1,
          tokens: 0,
          costUnits: 0,
          reservedAt: "2026-08-30T12:01:00.000Z",
          expiresAt: initialBudget.spec.expiresAt,
          signature: await harnessSigner.sign("phantom")
        },
        tokens: 0,
        costUnits: 0
      })
    });
    assert.equal(result.status, "conflict");
    assert.equal(result.budget, null);
  } finally {
    substrate.close();
    root.cleanup();
  }
});

test("a second reserve without an intervening settle fails closed", async () => {
  const root = temporaryStoreRoot("demo-budget-double-reserve");
  const substrate = openStore(root.pathFor("s.db"));
  try {
    const initialBudget = genesisBudget();
    const ledger = createDurableDemoBudgetLedger({
      substrate,
      initialBudget,
      signer: harnessSigner,
      verifier: harnessVerifier
    });
    const afterReserve = reservedBudget({
      current: initialBudget,
      tokens: 100,
      costUnits: 10
    });
    const first = await ledger.reserve({
      expected: initialBudget,
      next: afterReserve,
      evidence: reservationEvidence({
        expected: initialBudget,
        next: afterReserve,
        tokens: 100,
        costUnits: 10
      })
    });
    assert.equal(first.status, "appended");

    // A second reserve chained off the *already-reserved* state, without any
    // intervening settle, must fail closed even though its expected/next
    // digests are internally consistent with each other.
    const secondNext = reservedBudget({
      current: afterReserve,
      tokens: 5,
      costUnits: 1
    });
    const second = await ledger.reserve({
      expected: afterReserve,
      next: secondNext,
      evidence: reservationEvidence({
        expected: afterReserve,
        next: secondNext,
        tokens: 5,
        costUnits: 1
      })
    });
    assert.equal(second.status, "conflict");
    assert.equal(second.budget, null);
  } finally {
    substrate.close();
    root.cleanup();
  }
});

test("a byte-identical reserve replay is existing, never appended twice", async () => {
  const root = temporaryStoreRoot("demo-budget-replay");
  const substrate = openStore(root.pathFor("s.db"));
  try {
    const initialBudget = genesisBudget();
    const ledger = createDurableDemoBudgetLedger({
      substrate,
      initialBudget,
      signer: harnessSigner,
      verifier: harnessVerifier
    });
    const afterReserve = reservedBudget({
      current: initialBudget,
      tokens: 100,
      costUnits: 10
    });
    const evidence = reservationEvidence({
      expected: initialBudget,
      next: afterReserve,
      tokens: 100,
      costUnits: 10
    });
    const first = await ledger.reserve({
      expected: initialBudget,
      next: afterReserve,
      evidence
    });
    assert.equal(first.status, "appended");

    const replay = await ledger.reserve({
      expected: initialBudget,
      next: afterReserve,
      evidence
    });
    assert.equal(replay.status, "existing");
    assert.equal(replay.budget?.contentDigest, afterReserve.contentDigest);
  } finally {
    substrate.close();
    root.cleanup();
  }
});

test("budget ledger state survives a restart", async () => {
  const root = temporaryStoreRoot("demo-budget-restart");
  const storePath = root.pathFor("s.db");
  const initialBudget = genesisBudget();
  const afterReserve = reservedBudget({
    current: initialBudget,
    tokens: 50,
    costUnits: 5
  });

  const before = openStore(storePath);
  try {
    const ledger = createDurableDemoBudgetLedger({
      substrate: before,
      initialBudget,
      signer: harnessSigner,
      verifier: harnessVerifier
    });
    const result = await ledger.reserve({
      expected: initialBudget,
      next: afterReserve,
      evidence: reservationEvidence({
        expected: initialBudget,
        next: afterReserve,
        tokens: 50,
        costUnits: 5
      })
    });
    assert.equal(result.status, "appended");
  } finally {
    before.close();
  }

  const after = openStore(storePath);
  try {
    const ledger = createDurableDemoBudgetLedger({
      substrate: after,
      initialBudget,
      signer: harnessSigner,
      verifier: harnessVerifier
    });
    const read = await ledger.read();
    assert.equal(read.contentDigest, afterReserve.contentDigest);
  } finally {
    after.close();
    root.cleanup();
  }
});

test("budget ledger construction fails closed on a non-genesis initial budget", async () => {
  const root = temporaryStoreRoot("demo-budget-non-genesis-init");
  const substrate = openStore(root.pathFor("s.db"));
  try {
    const initialBudget = genesisBudget();
    const notGenesis = reservedBudget({
      current: initialBudget,
      tokens: 1,
      costUnits: 1
    });
    assert.throws(() =>
      createDurableDemoBudgetLedger({
        substrate,
        initialBudget: notGenesis,
        signer: harnessSigner,
        verifier: harnessVerifier
      })
    );
  } finally {
    substrate.close();
    root.cleanup();
  }
});

test("an ambiguous settle that actually landed reconciles to existing", async () => {
  const root = temporaryStoreRoot("demo-budget-ambiguous-landed");
  const real = openStore(root.pathFor("s.db"));
  try {
    const initialBudget = genesisBudget();
    const seedLedger = createDurableDemoBudgetLedger({
      substrate: real,
      initialBudget,
      signer: harnessSigner,
      verifier: harnessVerifier
    });
    const afterReserve = reservedBudget({
      current: initialBudget,
      tokens: 100,
      costUnits: 10
    });
    const reserveResult = await seedLedger.reserve({
      expected: initialBudget,
      next: afterReserve,
      evidence: reservationEvidence({
        expected: initialBudget,
        next: afterReserve,
        tokens: 100,
        costUnits: 10
      })
    });
    assert.equal(reserveResult.status, "appended");

    const wrapped = ambiguousOnceSubstrate(real, "landed");
    const ledger = createDurableDemoBudgetLedger({
      substrate: wrapped,
      initialBudget,
      signer: harnessSigner,
      verifier: harnessVerifier
    });
    const afterSettle = settledBudget({
      current: afterReserve,
      reservation: afterReserve,
      tokens: 80,
      costUnits: 8
    });
    const settleEvidence = settlementEvidence({
      expected: afterReserve,
      next: afterSettle,
      reservationEvidenceValue: reserveResult.evidence as DemoBudgetReservationEvidence,
      tokens: 80,
      costUnits: 8
    });
    const settleResult = await ledger.settle({
      expected: afterReserve,
      next: afterSettle,
      evidence: settleEvidence
    });
    assert.equal(settleResult.status, "existing");
    assert.equal(settleResult.budget?.contentDigest, afterSettle.contentDigest);
  } finally {
    real.close();
    root.cleanup();
  }
});

test("budget read fails closed on a malformed durable envelope", async () => {
  const root = temporaryStoreRoot("demo-budget-malformed-envelope");
  const substrate = openStore(root.pathFor("s.db"));
  try {
    const initialBudget = genesisBudget();
    const ledger = createDurableDemoBudgetLedger({
      substrate,
      initialBudget,
      signer: harnessSigner,
      verifier: harnessVerifier
    });
    const namespace = demoBudgetAuthorityDigest(initialBudget);
    // Attack the serialized durable record directly: a caller of this
    // namespace's compare-and-swap, not the ledger, decides the body's
    // shape.
    await substrate.compareAndSwap({
      namespace,
      key: "attacker-key",
      expectedHead: null,
      body: { not: "a budget record" }
    });

    await assertRefusalCode(ledger.read(), "STORE_CORRUPT");

    const afterReserve = reservedBudget({
      current: initialBudget,
      tokens: 100,
      costUnits: 10
    });
    await assertRefusalCode(
      ledger.reserve({
        expected: initialBudget,
        next: afterReserve,
        evidence: reservationEvidence({
          expected: initialBudget,
          next: afterReserve,
          tokens: 100,
          costUnits: 10
        })
      }),
      "STORE_CORRUPT"
    );
  } finally {
    substrate.close();
    root.cleanup();
  }
});

test("budget read fails closed on a record bound to a different authority", async () => {
  const root = temporaryStoreRoot("demo-budget-foreign-authority");
  const substrate = openStore(root.pathFor("s.db"));
  try {
    const initialBudget = genesisBudget();
    const ledger = createDurableDemoBudgetLedger({
      substrate,
      initialBudget,
      signer: harnessSigner,
      verifier: harnessVerifier
    });
    const namespace = demoBudgetAuthorityDigest(initialBudget);
    const foreignBudget = genesisBudget({ workItemNodeId: "WI_kwDOforeignbudget" });
    const foreignEvidence = {
      ...reservationEvidence({
        expected: foreignBudget,
        next: foreignBudget,
        tokens: 0,
        costUnits: 0
      }),
      signature: await harnessSigner.sign("phantom")
    };
    // A well-formed budget-and-evidence pair, but for a *different*
    // authority, stored under this ledger's namespace.
    await substrate.compareAndSwap({
      namespace,
      key: foreignBudget.contentDigest,
      expectedHead: null,
      body: {
        kind: "DurableDemoBudgetReservationRecord",
        schemaVersion: "1.0.0",
        budget: foreignBudget,
        evidence: foreignEvidence
      }
    });

    await assertRefusalCode(ledger.read(), "STORE_CORRUPT");
  } finally {
    substrate.close();
    root.cleanup();
  }
});

test("budget read and reserve fail closed on an unverifiable stored signature", async () => {
  const root = temporaryStoreRoot("demo-budget-bad-signature");
  const substrate = openStore(root.pathFor("s.db"));
  try {
    const initialBudget = genesisBudget();
    const ledger = createDurableDemoBudgetLedger({
      substrate,
      initialBudget,
      signer: harnessSigner,
      verifier: harnessVerifier
    });
    const namespace = demoBudgetAuthorityDigest(initialBudget);
    const afterReserve = reservedBudget({
      current: initialBudget,
      tokens: 100,
      costUnits: 10
    });
    const evidencePayload = reservationEvidence({
      expected: initialBudget,
      next: afterReserve,
      tokens: 100,
      costUnits: 10
    });
    // Well-formed shape, but a signature that does not verify against this
    // exact payload (attacking the serialized record's authenticity, not
    // just its shape).
    const wrongSignature = harnessSignature("a-completely-different-payload");
    await substrate.compareAndSwap({
      namespace,
      key: afterReserve.contentDigest,
      expectedHead: null,
      body: {
        kind: "DurableDemoBudgetReservationRecord",
        schemaVersion: "1.0.0",
        budget: afterReserve,
        evidence: { ...evidencePayload, signature: wrongSignature }
      }
    });

    await assertRefusalCode(ledger.read(), "STORE_CORRUPT");

    const afterSettle = settledBudget({
      current: afterReserve,
      reservation: afterReserve,
      tokens: 80,
      costUnits: 8
    });
    await assertRefusalCode(
      ledger.settle({
        expected: afterReserve,
        next: afterSettle,
        evidence: settlementEvidence({
          expected: afterReserve,
          next: afterSettle,
          reservationEvidenceValue: {
            ...evidencePayload,
            signature: wrongSignature
          },
          tokens: 80,
          costUnits: 8
        })
      }),
      "STORE_CORRUPT"
    );
  } finally {
    substrate.close();
    root.cleanup();
  }
});

test("reserve fails closed on a malformed evidence key set", async () => {
  const root = temporaryStoreRoot("demo-budget-reserve-malformed-keys");
  const substrate = openStore(root.pathFor("s.db"));
  try {
    const initialBudget = genesisBudget();
    const ledger = createDurableDemoBudgetLedger({
      substrate,
      initialBudget,
      signer: harnessSigner,
      verifier: harnessVerifier
    });
    const afterReserve = reservedBudget({
      current: initialBudget,
      tokens: 100,
      costUnits: 10
    });
    const evidence = reservationEvidence({
      expected: initialBudget,
      next: afterReserve,
      tokens: 100,
      costUnits: 10
    });

    const { stageId: _stageId, ...missingStageId } = evidence;
    await assert.rejects(
      ledger.reserve({
        expected: initialBudget,
        next: afterReserve,
        evidence: missingStageId as unknown as Omit<
          DemoBudgetReservationEvidence,
          "signature"
        >
      }),
      TypeError
    );

    const withExtraKey = { ...evidence, unexpectedField: "should not be here" };
    await assert.rejects(
      ledger.reserve({
        expected: initialBudget,
        next: afterReserve,
        evidence: withExtraKey as unknown as Omit<
          DemoBudgetReservationEvidence,
          "signature"
        >
      }),
      TypeError
    );

    // Neither malformed attempt left a durable record behind.
    const read = await ledger.read();
    assert.equal(read.contentDigest, initialBudget.contentDigest);
  } finally {
    substrate.close();
    root.cleanup();
  }
});

test("settle fails closed on a malformed evidence key set", async () => {
  const root = temporaryStoreRoot("demo-budget-settle-malformed-keys");
  const substrate = openStore(root.pathFor("s.db"));
  try {
    const initialBudget = genesisBudget();
    const ledger = createDurableDemoBudgetLedger({
      substrate,
      initialBudget,
      signer: harnessSigner,
      verifier: harnessVerifier
    });
    const afterReserve = reservedBudget({
      current: initialBudget,
      tokens: 100,
      costUnits: 10
    });
    const reserveResult = await ledger.reserve({
      expected: initialBudget,
      next: afterReserve,
      evidence: reservationEvidence({
        expected: initialBudget,
        next: afterReserve,
        tokens: 100,
        costUnits: 10
      })
    });
    assert.equal(reserveResult.status, "appended");

    const afterSettle = settledBudget({
      current: afterReserve,
      reservation: afterReserve,
      tokens: 80,
      costUnits: 8
    });
    const settlement = settlementEvidence({
      expected: afterReserve,
      next: afterSettle,
      reservationEvidenceValue: reserveResult.evidence as DemoBudgetReservationEvidence,
      tokens: 80,
      costUnits: 8
    });

    const { usageDigest: _usageDigest, ...missingUsageDigest } = settlement;
    await assert.rejects(
      ledger.settle({
        expected: afterReserve,
        next: afterSettle,
        evidence: missingUsageDigest as unknown as Omit<
          DemoBudgetSettlementEvidence,
          "signature"
        >
      }),
      TypeError
    );

    const withExtraKey = { ...settlement, unexpectedField: "should not be here" };
    await assert.rejects(
      ledger.settle({
        expected: afterReserve,
        next: afterSettle,
        evidence: withExtraKey as unknown as Omit<
          DemoBudgetSettlementEvidence,
          "signature"
        >
      }),
      TypeError
    );

    // The ledger still holds the reservation, not a settlement.
    const read = await ledger.read();
    assert.equal(read.contentDigest, afterReserve.contentDigest);
  } finally {
    substrate.close();
    root.cleanup();
  }
});

test("budget operations propagate capacity exhaustion unchanged", async () => {
  const root = temporaryStoreRoot("demo-budget-capacity");
  const substrate = openStore(root.pathFor("s.db"), 1);
  try {
    const initialBudget = genesisBudget();
    const ledger = createDurableDemoBudgetLedger({
      substrate,
      initialBudget,
      signer: harnessSigner,
      verifier: harnessVerifier
    });
    const afterReserve = reservedBudget({
      current: initialBudget,
      tokens: 100,
      costUnits: 10
    });

    // Consumes the store's only journal slot.
    const reserveResult = await ledger.reserve({
      expected: initialBudget,
      next: afterReserve,
      evidence: reservationEvidence({
        expected: initialBudget,
        next: afterReserve,
        tokens: 100,
        costUnits: 10
      })
    });
    assert.equal(reserveResult.status, "appended");

    const afterSettle = settledBudget({
      current: afterReserve,
      reservation: afterReserve,
      tokens: 80,
      costUnits: 8
    });
    await assertRefusalCode(
      ledger.settle({
        expected: afterReserve,
        next: afterSettle,
        evidence: settlementEvidence({
          expected: afterReserve,
          next: afterSettle,
          reservationEvidenceValue: reserveResult.evidence as DemoBudgetReservationEvidence,
          tokens: 80,
          costUnits: 8
        })
      }),
      "CAPACITY_EXHAUSTED"
    );
  } finally {
    substrate.close();
    root.cleanup();
  }
});
