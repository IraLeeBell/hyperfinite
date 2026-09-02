/**
 * Conformance tests for the durable adapters in `src/durable-demo-stores.ts`
 * that map the eight demo ports onto the durable substrate:
 * `DemoActivationClaimStore`, `StageAgentSelectionGrantStore`,
 * `DemoDispatchStore`, `DemoProviderUsageLedger`, `DemoKernelStateStore`,
 * `DemoStageReceiptStore`, `DemoRunStateStore`, and `DemoRecoveryBudgetStore`.
 *
 * Each port is exercised for: genesis, idempotent byte-identical replay,
 * conflict (a different operation contending for the same identity),
 * restart continuity (closing and reopening the backing substrate file),
 * and — for the ports with a dedicated ambiguous-acknowledgement error —
 * reconciliation of a lost commit acknowledgement.
 */

import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { canonicalJson, digest } from "../src/canonical.js";
import { DemoActivationClaimAmbiguousError } from "../src/demo-activation.js";
import type {
  DemoActivationClaim,
  DemoRecoveryBudgetEvidence
} from "../src/demo-activation.js";
import { DemoDispatchPersistenceAmbiguousError } from "../src/demo-dispatcher.js";
import {
  DemoKernelPersistenceAmbiguousError,
  DemoRecoveryBudgetPersistenceAmbiguousError,
  DemoRunStatePersistenceAmbiguousError,
  DemoStageReceiptPersistenceAmbiguousError
} from "../src/demo-runtime.js";
import type { DemoBudgetState } from "../src/demo-runtime-state.js";
import type {
  DemoCoreStateBinding,
  DemoProjectId,
  DemoRunState,
  DemoSignature,
  SignedStageAgentSelectionGrant,
  SignedStageReceipt
} from "../src/demo-types.js";
import type {
  DemoProviderAttemptEvidence,
  DemoProviderUsageEvidence
} from "../src/demo-scheduler.js";
import {
  DurableAmbiguousAcknowledgementError,
  DurableSubstrateError,
  type DurableSubstrate
} from "../src/durable-substrate.js";
import {
  bindDurableStores,
  openBoundDurableStore
} from "../src/durable-store-binding.js";
import {
  createDurableDemoActivationClaimStore,
  createDurableDemoDispatchStore,
  createDurableDemoKernelStateStore,
  createDurableDemoProviderUsageLedger,
  createDurableDemoRecoveryBudgetStore,
  createDurableDemoRunStateStore,
  createDurableDemoStageReceiptStore,
  createDurableStageAgentSelectionGrantStore,
  DemoProviderUsageLedgerPersistenceFailedError,
  DemoProviderUsageLedgerReconciliationPendingError,
  StageAgentSelectionGrantPersistenceAmbiguousError
} from "../src/durable-demo-stores.js";
import type { KernelResult, KernelSnapshot } from "../src/types.js";
import {
  BUSY_TIMEOUT_MS,
  SUPPORTED_NODE_MAJORS,
  fixedClock,
  harnessSignature,
  harnessSigner,
  harnessVerifier,
  storePathsFor,
  syntheticStorePlan,
  temporaryStoreRoot
} from "./support/durable-substrate-harness.js";
import type {
  ProviderUsageWorkerReply,
  ProviderUsageWorkerRequest
} from "./support/durable-demo-stores-worker.js";

const PROJECT_ID: DemoProjectId = "feature-delivery";

function d(label: string): `sha256:${string}` {
  return digest(label);
}

/**
 * Fails the `COMMIT` for a write, `failuresRemaining` times, then behaves
 * normally. Returns a disposer that restores the driver. The commit never
 * executes on a faulted attempt, so the write genuinely never lands —
 * simulating the "stable absence" case reconciliation must resolve without
 * ever resubmitting the mutation (see `classifyAmbiguousWrite`).
 */
async function injectPersistentCommitFailure(
  failuresRemaining: number
): Promise<{ fired: () => number; restore: () => void }> {
  const { DatabaseSync } = await import("node:sqlite");
  const original = DatabaseSync.prototype.exec;
  let remaining = failuresRemaining;
  let fireCount = 0;
  DatabaseSync.prototype.exec = function patched(
    this: unknown,
    statement: string
  ): void {
    if (statement === "COMMIT" && remaining > 0) {
      remaining -= 1;
      fireCount += 1;
      throw new Error("simulated lost commit acknowledgement");
    }
    return original.call(this, statement);
  };
  return {
    fired: () => fireCount,
    restore: () => {
      DatabaseSync.prototype.exec = original;
    }
  };
}

/**
 * Lets the real `COMMIT` execute (so the write genuinely lands) and only
 * *afterward* throws, simulating a lost acknowledgement for a write that
 * actually durably succeeded — as opposed to `injectPersistentCommitFailure`,
 * which prevents the commit from landing at all. This exercises the
 * `"matches"` classification of `classifyAmbiguousWrite`: a double read must
 * find the record already present and return it, never resubmit the write.
 */
async function injectLandedButAcknowledgementLostCommit(
  failuresRemaining: number
): Promise<{ fired: () => number; restore: () => void }> {
  const { DatabaseSync } = await import("node:sqlite");
  const original = DatabaseSync.prototype.exec;
  let remaining = failuresRemaining;
  let fireCount = 0;
  DatabaseSync.prototype.exec = function patched(
    this: unknown,
    statement: string
  ): void {
    if (statement === "COMMIT" && remaining > 0) {
      remaining -= 1;
      fireCount += 1;
      original.call(this, statement);
      throw new Error("simulated lost acknowledgement for a landed commit");
    }
    return original.call(this, statement);
  };
  return {
    fired: () => fireCount,
    restore: () => {
      DatabaseSync.prototype.exec = original;
    }
  };
}

/**
 * Fails exactly the `commitOrdinal`-th `COMMIT` call (1-based) across
 * whatever runs while the returned disposer is active; every other commit —
 * before or after — behaves normally. This targets one specific write inside
 * a multi-write operation (e.g. `DemoProviderUsageLedger.reconcile()`'s
 * claim write vs. its later usage write) without disturbing any other
 * commit, unlike `injectPersistentCommitFailure`/
 * `injectLandedButAcknowledgementLostCommit`, which apply to whichever
 * commit happens to come first.
 *
 * When `letLand` is `false` the targeted commit never executes (nothing
 * durable results, matching `injectPersistentCommitFailure`). When `true`
 * the real commit executes and only then throws (the write genuinely
 * landed, matching `injectLandedButAcknowledgementLostCommit`).
 */
async function injectCommitFaultAtOrdinal(
  commitOrdinal: number,
  letLand: boolean
): Promise<{ fired: () => number; restore: () => void }> {
  const { DatabaseSync } = await import("node:sqlite");
  const original = DatabaseSync.prototype.exec;
  let commitCount = 0;
  let fireCount = 0;
  DatabaseSync.prototype.exec = function patched(
    this: unknown,
    statement: string
  ): void {
    if (statement === "COMMIT") {
      commitCount += 1;
      if (commitCount === commitOrdinal) {
        fireCount += 1;
        if (letLand) {
          original.call(this, statement);
        }
        throw new Error(
          `simulated lost commit acknowledgement (commit #${commitOrdinal})`
        );
      }
    }
    return original.call(this, statement);
  };
  return {
    fired: () => fireCount,
    restore: () => {
      DatabaseSync.prototype.exec = original;
    }
  };
}

/**
 * Wraps a substrate so that exactly the `triggerAtCall`-th `read()` call
 * (1-based, counting every read for one specific namespace/key pair,
 * including any pre-check read before the write is even attempted) triggers
 * `injectBetweenReads` before delegating to the real read. Every other
 * call, including reads for any other key, passes through unmodified.
 *
 * Used to simulate a genuine concurrent writer landing at a precise point
 * relative to `classifyAmbiguousWrite`'s two reconciliation reads:
 * - triggering before the *first* classification read makes both
 *   reconciliation reads agree on the newly-landed value (a stable
 *   `"differs"` classification — a confirmed, different durable record).
 * - triggering before the *second* classification read makes the two
 *   reconciliation reads disagree with each other (an `"unstable"`
 *   classification — the true state cannot be determined at all), which
 *   must fail closed with a dedicated ambiguity error rather than be
 *   concealed as an ordinary conflict.
 */
function withInjectedReadAtCall(
  substrate: DurableSubstrate,
  namespace: string,
  key: string,
  triggerAtCall: number,
  injectBetweenReads: () => Promise<void>
): DurableSubstrate {
  let readCount = 0;
  return {
    ...substrate,
    async read(input) {
      if (input.namespace === namespace && input.key === key) {
        readCount += 1;
        if (readCount === triggerAtCall) {
          await injectBetweenReads();
        }
      }
      return substrate.read(input);
    }
  };
}

function withoutSig<T extends { readonly signature?: unknown }>(
  value: T
): Omit<T, "signature"> {
  const { signature: _signature, ...rest } = value;
  return rest;
}

/** Opens the three durable stores this module's ports need, sharing one root. */
function openStores(root: { pathFor(name: string): string }): {
  readonly operationGrantStore: DurableSubstrate;
  readonly receiptJournal: DurableSubstrate;
  readonly runtimeStateStore: DurableSubstrate;
  readonly close: () => void;
} {
  return openStoresBounded(root, 512);
}

/** Same as `openStores`, but with an explicit store-wide journal bound, so
 * capacity exhaustion can be forced deterministically in a small number of
 * writes rather than 512. */
function openStoresBounded(
  root: { pathFor(name: string): string },
  maxEntries: number
): {
  readonly operationGrantStore: DurableSubstrate;
  readonly receiptJournal: DurableSubstrate;
  readonly runtimeStateStore: DurableSubstrate;
  readonly close: () => void;
} {
  const plan = syntheticStorePlan({ maxEntries });
  const bindings = bindDurableStores({ plan, storePaths: storePathsFor(root) });
  const openOne = (storeId: string): DurableSubstrate => {
    const binding = bindings.find((candidate) => candidate.storeId === storeId);
    assert.ok(binding, `expected a binding for ${storeId}`);
    return openBoundDurableStore({
      binding,
      busyTimeoutMs: BUSY_TIMEOUT_MS,
      supportedNodeMajors: SUPPORTED_NODE_MAJORS
    });
  };
  const operationGrantStore = openOne("operation-grant-store");
  const receiptJournal = openOne("receipt-journal");
  const runtimeStateStore = openOne("runtime-state-store");
  return {
    operationGrantStore,
    receiptJournal,
    runtimeStateStore,
    close: () => {
      operationGrantStore.close();
      receiptJournal.close();
      runtimeStateStore.close();
    }
  };
}

function codeOf(error: unknown): string {
  assert.ok(error instanceof DurableSubstrateError, `expected refusal, got ${String(error)}`);
  return error.code;
}

function coreBinding(state: DemoCoreStateBinding["state"]): DemoCoreStateBinding {
  return {
    state,
    stateVersion: 1,
    bindingDigest: d("binding"),
    lifecycleGraphDigest: d("lifecycle-graph"),
    workAccordDigest: d("work-accord"),
    capabilityRegistryDigest: d("capability-registry"),
    domainPackDigest: d("domain-pack"),
    phaseContractDigest: d("phase-contract"),
    compiledPolicyDigest: d("compiled-policy"),
    policyDigest: d("policy"),
    kernelReceiptDigest: null,
    kernelSnapshotDigest: d("kernel-snapshot")
  };
}

function runState(overrides: {
  readonly runAttempt?: number;
  readonly currentStageId?: string;
  readonly status?: DemoRunState["spec"]["status"];
} = {}): DemoRunState {
  const spec: DemoRunState["spec"] = {
    demoProjectId: PROJECT_ID,
    catalogDigest: d("catalog"),
    identityReservationsDigest: d("reservations"),
    projectProfileDigest: d("profile"),
    journeyDefinitionDigest: d("journey"),
    stageAgentBindingsDigest: d("bindings"),
    capabilityShardDigest: d("capability-shard"),
    activationProfileDigest: d("activation-profile"),
    projectionMappingDigest: d("projection-mapping"),
    repositoryId: 42,
    workItemNodeId: "WI_demo",
    repositoryBindingDigest: d("repository-binding"),
    authorityEpoch: 1,
    generation: 0,
    runId: "run-1",
    runAttempt: overrides.runAttempt ?? 1,
    core: coreBinding("FRAMING"),
    journey: {
      currentStageId: overrides.currentStageId ?? "framing",
      currentStageOrdinal: 1,
      previousStageReceiptDigest: null,
      completedStageReceiptDigests: []
    },
    fenceDigest: null,
    fenceBaseRunStateDigest: null,
    currentDraftPullRequest: null,
    status: overrides.status ?? "ready",
    updatedAt: "2026-08-30T12:00:00.000Z"
  };
  return {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "DemoRunState",
    schemaVersion: "1.0.0",
    contentDigest: digest(spec),
    spec
  };
}

function budgetState(overrides: {
  readonly generation?: number;
  readonly retries?: number;
  readonly ledgerVersion?: number;
} = {}): DemoBudgetState {
  const spec: DemoBudgetState["spec"] = {
    demoProjectId: PROJECT_ID,
    repositoryId: 42,
    workItemNodeId: "WI_demo",
    authorityEpoch: 1,
    generation: overrides.generation ?? 0,
    activationLeaseDigest: d("lease"),
    workAccordDigest: d("work-accord"),
    limits: {
      maxCalls: 10,
      maxTokens: 10_000,
      maxCostUnits: 10,
      maxDurationMs: 60_000,
      maxRetries: 3,
      maxParallel: 1
    },
    usage: {
      calls: 0,
      tokens: 0,
      costUnits: 0,
      retries: overrides.retries ?? 0
    },
    held: { calls: 0, tokens: 0, costUnits: 0 },
    startedAt: "2026-08-30T12:00:00.000Z",
    expiresAt: "2026-08-31T12:00:00.000Z",
    ledgerVersion: overrides.ledgerVersion ?? 0,
    ledgerHead: null
  };
  return {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "DemoBudgetState",
    schemaVersion: "1.0.0",
    contentDigest: digest(spec),
    spec
  };
}

function kernelSnapshot(overrides: {
  readonly stateVersion?: number;
  readonly receiptHead?: `sha256:${string}` | null;
} = {}): KernelSnapshot {
  return {
    schemaVersion: "1.0.0",
    lifecycleVersion: "1.0.0",
    lifecycleGraphDigest: d("lifecycle-graph"),
    state: "FRAMING",
    phaseOwner: "framing",
    stateVersion: overrides.stateVersion ?? 1,
    lastEventSequence: 1,
    bindingDigest: d("binding"),
    workAccordDigest: d("work-accord"),
    capabilityRegistryDigest: d("capability-registry"),
    domainPackDigest: d("domain-pack"),
    phaseContractDigest: d("phase-contract"),
    compiledPolicyDigest: d("compiled-policy"),
    policyDigest: d("policy"),
    currentHead: d("current-head"),
    receiptHead: overrides.receiptHead === undefined ? null : overrides.receiptHead,
    suspendedState: null,
    recoveryState: null,
    usage: { calls: 0, tokens: 0, costUnits: 0, loops: 0, retries: 0 },
    phaseUsage: { calls: 0, tokens: 0, costUnits: 0, loops: 0, retries: 0 },
    routeAttempts: {},
    processedEvents: {}
  };
}

/** A minimal `applied` KernelResult transitioning from `from` to a fresh snapshot. */
function appliedResult(input: {
  readonly from: KernelSnapshot;
  readonly eventId: string;
}): Extract<KernelResult, { kind: "applied" }> {
  const receiptDigest = d(`receipt:${input.eventId}`);
  const snapshot = kernelSnapshot({
    stateVersion: input.from.stateVersion + 1,
    receiptHead: receiptDigest
  });
  return {
    kind: "applied",
    route: { id: "route-1", event: "advance", from: "FRAMING", to: "FRAMING" } as never,
    snapshot,
    receipt: {
      schemaVersion: "1.0.0",
      eventId: input.eventId,
      eventDigest: d(`event:${input.eventId}`),
      routeId: "route-1",
      routeVersion: "1.0.0",
      from: "FRAMING",
      to: "FRAMING",
      stateVersion: snapshot.stateVersion,
      previousReceipt: input.from.receiptHead,
      idempotencyKey: d(`idempotency:${input.eventId}`),
      replacementAuthorityDigest: null,
      bindingDigest: d("binding"),
      lifecycleGraphDigest: d("lifecycle-graph"),
      workAccordDigest: d("work-accord"),
      capabilityRegistryDigest: d("capability-registry"),
      domainPackDigest: d("domain-pack"),
      destinationBindingDigest: d("binding"),
      destinationLifecycleGraphDigest: d("lifecycle-graph"),
      destinationWorkAccordDigest: d("work-accord"),
      destinationCapabilityRegistryDigest: d("capability-registry"),
      destinationDomainPackDigest: d("domain-pack"),
      sourcePhaseContractDigest: d("phase-contract"),
      sourceCompiledPolicyDigest: d("compiled-policy"),
      destinationPhaseContractDigest: d("phase-contract"),
      destinationCompiledPolicyDigest: d("compiled-policy"),
      policyDigest: d("policy"),
      destinationPolicyDigest: d("policy"),
      actorId: "actor-1",
      actorAuthorizationDigest: d("actor-authorization"),
      occurredAt: "2026-08-30T12:00:00.000Z",
      effectPlanDigest: d("effect-plan")
    },
    receiptDigest,
    effects: []
  };
}

function signedStageReceipt(overrides: {
  readonly runStateDigest: `sha256:${string}`;
  readonly stageId?: string;
}): SignedStageReceipt {
  const spec: SignedStageReceipt["spec"] = {
    demoProjectId: PROJECT_ID,
    projectProfileDigest: d("profile"),
    journeyDefinitionDigest: d("journey"),
    stageAgentBindingsDigest: d("bindings"),
    authorityEpoch: 1,
    generation: 0,
    runId: "run-1",
    runAttempt: 1,
    runStateDigest: overrides.runStateDigest,
    stageId: overrides.stageId ?? "framing",
    stageOrdinal: 1,
    nextStageId: "planning",
    nextStageOrdinal: 2,
    previousStageReceiptDigest: null,
    artifactEnvelopeDigest: d("artifact"),
    runFenceDigest: null,
    releasedRunFenceDigest: null,
    coreBefore: coreBinding("FRAMING"),
    coreAfter: coreBinding("PLANNED"),
    kernelTransitionReceiptDigest: null,
    appliedKernelResultDigest: null,
    outcome: "completed",
    completedAt: "2026-08-30T12:00:00.000Z"
  };
  const contentDigest = digest(spec);
  const unsigned = {
    apiVersion: "agentic-framework.github.com/v1alpha1" as const,
    kind: "SignedStageReceipt" as const,
    schemaVersion: "1.0.0" as const,
    contentDigest,
    spec
  };
  return { ...unsigned, signature: harnessSignature(unsigned) };
}

function signedStageAgentSelectionGrant(overrides: {
  readonly selectionKey: `sha256:${string}`;
  readonly optionKey?: string;
}): SignedStageAgentSelectionGrant {
  const spec: SignedStageAgentSelectionGrant["spec"] = {
    demoProjectId: PROJECT_ID,
    stageId: "execution",
    selectionKey: overrides.selectionKey,
    optionKey: overrides.optionKey ?? "agent-a",
    projectNodeId: "PROJECT_demo",
    projectItemNodeId: "ITEM_demo",
    projectBindingDigest: d("project-binding"),
    repositoryId: 42,
    workItemNodeId: "WI_demo",
    authorityEpoch: 1,
    generation: 0,
    runId: "run-1",
    runAttempt: 1,
    receiptHead: null,
    pullRequestHeadSha: null,
    policyGeneration: 1,
    selectionPolicyDigest: d("selection-policy"),
    stageAgentBindingsDigest: d("bindings"),
    workAccordDigest: d("work-accord"),
    phaseContractDigest: d("phase-contract"),
    capabilityRegistryDigest: d("capability-registry"),
    activationLeaseDigest: d("lease"),
    budgetAuthorityDigest: d("budget-authority"),
    agentId: "agent-a",
    skillId: "skill-a",
    capabilityId: "capability-a",
    workflowId: "workflow-a",
    workflowClass: "target-free-execution",
    phase: "execution",
    role: "executor",
    inputSchema: {},
    outputSchema: {},
    toolCeiling: {
      tools: [],
      shellCommands: [],
      networkDestinations: [],
      mcpTools: [],
      secretNames: []
    },
    budgetCeiling: {
      maxCalls: 1,
      maxTokens: 1_000,
      maxCostUnits: 1,
      maxDurationMs: 60_000,
      maxRetries: 0,
      maxOutputBytes: 100_000,
      maxConcurrency: 1
    },
    issuedAt: "2026-08-30T12:00:00.000Z",
    expiresAt: "2026-08-30T13:00:00.000Z"
  };
  const contentDigest = digest(spec);
  const unsigned = {
    apiVersion: "agentic-framework.github.com/v1alpha1" as const,
    kind: "SignedStageAgentSelectionGrant" as const,
    schemaVersion: "1.0.0" as const,
    contentDigest,
    spec
  };
  return { ...unsigned, signature: harnessSignature(unsigned) };
}

function activationClaim(
  overrides: { readonly claimedAt?: string; readonly claimKey?: `sha256:${string}` } = {}
): DemoActivationClaim {
  const claimKey = overrides.claimKey ?? d("claim-key-1");
  return {
    schemaVersion: "1.0.0",
    claimKey,
    demoProjectId: PROJECT_ID,
    repositoryId: 42,
    workItemNodeId: "WI_demo",
    authorityEpoch: 1,
    generation: 0,
    revocationGeneration: 0,
    sourceEventDigest: d("source-event"),
    submitterId: 101,
    consentDigest: d("consent"),
    activationProfileDigest: d("activation-profile"),
    activationLeaseDigest: d("activation-lease"),
    activationLeaseEvidenceDigest: d("activation-lease-evidence"),
    budgetAuthorityDigest: d("budget-authority"),
    recoveryBudgetEvidenceDigest: null,
    runStateDigest: d("run-state"),
    claimedAt: overrides.claimedAt ?? "2026-08-30T12:00:00.000Z"
  };
}

// ---------------------------------------------------------------------------
// DemoActivationClaimStore
// ---------------------------------------------------------------------------

test("DemoActivationClaimStore: genesis append, replay, conflict, and restart", async () => {
  const root = temporaryStoreRoot("activation-claim");
  const stores = openStores(root);
  const clock = fixedClock();
  try {
    const store = createDurableDemoActivationClaimStore({
      substrate: stores.operationGrantStore,
      signer: harnessSigner,
      clock
    });

    const claim = activationClaim();
    const first = await store.claim(claim);
    assert.equal(first.status, "appended");
    assert.ok(first.receipt);
    assert.equal(first.receipt.sequence, 1);
    assert.equal(first.receipt.previousHead, null);
    assert.equal(
      first.receipt.head,
      digest({
        storeId: first.receipt.storeId,
        sequence: first.receipt.sequence,
        previousHead: first.receipt.previousHead,
        claim: first.receipt.claim,
        status: first.receipt.status,
        persistedAt: first.receipt.persistedAt
      }),
      "receipt head must equal the caller's recomputation formula"
    );
    assert.ok(
      harnessVerifier.verify(
        (({ signature: _s, ...rest }) => rest)(first.receipt),
        first.receipt.signature
      )
    );

    // Idempotent byte-identical replay.
    const replay = await store.claim(claim);
    assert.equal(replay.status, "existing");
    assert.deepEqual(replay.receipt, first.receipt);

    // A different claim under the same claimKey (a genuine content conflict).
    const mutated: DemoActivationClaim = { ...claim, submitterId: 202 };
    const conflicting = await store.claim(mutated);
    assert.equal(conflicting.status, "conflict");
    assert.equal(conflicting.receipt, null);

    const read = await store.read(claim.claimKey);
    assert.deepEqual(read, first.receipt);
    assert.equal(await store.read(d("unknown-claim")), null);

    // Restart continuity: close and reopen against the same file.
    stores.close();
    const reopened = openStores(root);
    try {
      const restartedStore = createDurableDemoActivationClaimStore({
        substrate: reopened.operationGrantStore,
        signer: harnessSigner,
        clock
      });
      const afterRestart = await restartedStore.read(claim.claimKey);
      assert.deepEqual(afterRestart, first.receipt);
    } finally {
      reopened.close();
    }
  } finally {
    root.cleanup();
  }
});

test("DemoActivationClaimStore: a lost commit acknowledgement is reported distinctly", async () => {
  const root = temporaryStoreRoot("activation-claim-ambiguous");
  const stores = openStores(root);
  try {
    const store = createDurableDemoActivationClaimStore({
      substrate: stores.operationGrantStore,
      signer: harnessSigner,
      clock: fixedClock()
    });
    const claim = activationClaim();
    const { DatabaseSync } = await import("node:sqlite");
    const original = DatabaseSync.prototype.exec;
    let fired = false;
    DatabaseSync.prototype.exec = function patched(
      this: unknown,
      statement: string
    ): void {
      if (statement === "COMMIT" && !fired) {
        fired = true;
        throw new Error("simulated lost commit acknowledgement");
      }
      return original.call(this, statement);
    };
    try {
      await assert.rejects(
        store.claim(claim),
        (error: unknown) => error instanceof DemoActivationClaimAmbiguousError
      );
    } finally {
      DatabaseSync.prototype.exec = original;
    }
    assert.ok(fired, "the commit fault must actually have fired");
  } finally {
    stores.close();
    root.cleanup();
  }
});

test("DemoActivationClaimStore: two independent substrate handles genuinely racing the same claim yield exactly one winner", async () => {
  const root = temporaryStoreRoot("activation-claim-cross-process");
  openStores(root).close();

  const handleA = openStores(root);
  const handleB = openStores(root);
  try {
    const clock = fixedClock();
    const storeA = createDurableDemoActivationClaimStore({
      substrate: handleA.operationGrantStore,
      signer: harnessSigner,
      clock
    });
    const storeB = createDurableDemoActivationClaimStore({
      substrate: handleB.operationGrantStore,
      signer: harnessSigner,
      clock
    });

    const claim = activationClaim();
    // Both handles submit the exact same claim concurrently — neither
    // `await`s the other first — so this genuinely races the adapters' own
    // read/build/append sequence across two independent processes' worth of
    // state, not merely a sequential replay.
    const [resultA, resultB] = await Promise.all([storeA.claim(claim), storeB.claim(claim)]);
    const statuses = [resultA.status, resultB.status].sort();
    assert.deepEqual(
      statuses,
      ["appended", "existing"],
      "byte-identical racers must yield exactly one winner and one idempotent observer, never a conflict"
    );
    assert.deepEqual(resultA.receipt, resultB.receipt);
    const winnerReceipt = resultA.receipt ?? resultB.receipt;
    assert.ok(winnerReceipt);

    // A different claim under the same claimKey must conflict, never overwrite.
    const mutated: DemoActivationClaim = { ...claim, submitterId: 999 };
    const conflicting = await storeB.claim(mutated);
    assert.equal(conflicting.status, "conflict");

    assert.deepEqual(await storeA.read(claim.claimKey), winnerReceipt);
    assert.deepEqual(await storeB.read(claim.claimKey), winnerReceipt);
  } finally {
    handleA.close();
    handleB.close();
    root.cleanup();
  }
});

// ---------------------------------------------------------------------------
// StageAgentSelectionGrantStore
// ---------------------------------------------------------------------------

test("StageAgentSelectionGrantStore: genesis, replay, conflict, and restart", async () => {
  const root = temporaryStoreRoot("selection-grant");
  const stores = openStores(root);
  try {
    const store = createDurableStageAgentSelectionGrantStore({
      substrate: stores.operationGrantStore
    });
    assert.equal(store.supportsAtomicCreate, true);

    const selectionKey = d("selection-key-1");
    const grant = signedStageAgentSelectionGrant({ selectionKey });
    const first = await store.claim(grant);
    assert.equal(first.status, "appended");
    assert.deepEqual(first.grant, grant);

    const replay = await store.claim(grant);
    assert.equal(replay.status, "existing");
    assert.deepEqual(replay.grant, grant);

    const conflictingGrant = signedStageAgentSelectionGrant({
      selectionKey,
      optionKey: "agent-b"
    });
    const conflicting = await store.claim(conflictingGrant);
    assert.equal(conflicting.status, "conflict");
    assert.equal(conflicting.grant, null);

    assert.deepEqual(await store.read(selectionKey), grant);
    assert.equal(await store.read(d("unknown-selection")), null);

    stores.close();
    const reopened = openStores(root);
    try {
      const restarted = createDurableStageAgentSelectionGrantStore({
        substrate: reopened.operationGrantStore
      });
      assert.deepEqual(await restarted.read(selectionKey), grant);
    } finally {
      reopened.close();
    }
  } finally {
    root.cleanup();
  }
});

test("StageAgentSelectionGrantStore: a stably-absent write after ambiguity fails closed as conflict, never resubmitted", async () => {
  const root = temporaryStoreRoot("selection-grant-absent-ambiguous");
  const stores = openStores(root);
  try {
    const store = createDurableStageAgentSelectionGrantStore({
      substrate: stores.operationGrantStore
    });
    const grant = signedStageAgentSelectionGrant({ selectionKey: d("selection-absent") });
    // The commit never lands: the write genuinely and stably never happens.
    const fault = await injectPersistentCommitFailure(1);
    try {
      const result = await store.claim(grant);
      assert.equal(
        result.status,
        "conflict",
        "a confirmed, stable absence is a definite negative outcome, not ambiguity"
      );
      assert.equal(result.grant, null);
    } finally {
      fault.restore();
    }
    assert.equal(fault.fired(), 1, "the mutation must never be resubmitted");
    // Nothing durable was ever produced for this selection key.
    assert.equal(await store.read(grant.spec.selectionKey), null);
  } finally {
    stores.close();
    root.cleanup();
  }
});

test("StageAgentSelectionGrantStore: a commit that actually landed is recognized by reread, not retried", async () => {
  const root = temporaryStoreRoot("selection-grant-landed-ambiguous");
  const stores = openStores(root);
  try {
    const store = createDurableStageAgentSelectionGrantStore({
      substrate: stores.operationGrantStore
    });
    const grant = signedStageAgentSelectionGrant({ selectionKey: d("selection-landed") });
    const fault = await injectLandedButAcknowledgementLostCommit(1);
    try {
      const result = await store.claim(grant);
      assert.equal(result.status, "existing", "a landed write must be recognized, not retried");
      assert.deepEqual(result.grant, grant);
    } finally {
      fault.restore();
    }
    assert.equal(fault.fired(), 1);
    // Exactly one durable record exists: the mutation was never resubmitted.
    const chain = await stores.operationGrantStore.verifyChain(
      `demo-stage-agent-selection-grant:${grant.spec.selectionKey}`
    );
    assert.equal(chain.length, 1);
    assert.deepEqual(await store.read(grant.spec.selectionKey), grant);
  } finally {
    stores.close();
    root.cleanup();
  }
});

test("StageAgentSelectionGrantStore: a durably different grant discovered while reconciling ambiguity fails closed as conflict", async () => {
  const root = temporaryStoreRoot("selection-grant-differs-ambiguous");
  const stores = openStores(root);
  try {
    const selectionKey = d("selection-differs");
    const grant = signedStageAgentSelectionGrant({ selectionKey });
    const namespace = `demo-stage-agent-selection-grant:${selectionKey}`;
    const otherGrant = signedStageAgentSelectionGrant({ selectionKey, optionKey: "agent-race" });

    // Nothing exists yet when this call's own pre-check read runs (so it
    // proceeds to attempt the write), but a genuinely different grant lands
    // durably before either of the two reconciliation reads that follow the
    // ambiguous commit — both agree on that other, different record.
    const injectingSubstrate = withInjectedReadAtCall(
      stores.operationGrantStore,
      namespace,
      "grant",
      2,
      async () => {
        await stores.operationGrantStore.appendOnce({
          namespace,
          key: "grant",
          body: otherGrant
        });
      }
    );
    const store = createDurableStageAgentSelectionGrantStore({ substrate: injectingSubstrate });

    const fault = await injectPersistentCommitFailure(1);
    try {
      const result = await store.claim(grant);
      assert.equal(result.status, "conflict");
      assert.equal(result.grant, null);
    } finally {
      fault.restore();
    }
    // The durable record is exactly the other, genuinely different grant.
    assert.deepEqual(await store.read(selectionKey), otherGrant);
  } finally {
    stores.close();
    root.cleanup();
  }
});

test("StageAgentSelectionGrantStore: an unstable double read after ambiguity fails closed with a dedicated error, never conceals as conflict", async () => {
  const root = temporaryStoreRoot("selection-grant-unstable-ambiguous");
  const stores = openStores(root);
  try {
    const selectionKey = d("selection-unstable");
    const grant = signedStageAgentSelectionGrant({ selectionKey });
    const namespace = `demo-stage-agent-selection-grant:${selectionKey}`;
    const otherGrant = signedStageAgentSelectionGrant({ selectionKey, optionKey: "agent-race" });

    // Simulate a genuine concurrent writer landing strictly between the two
    // reconciliation reads: the first reconciliation read (nothing there
    // yet) disagrees with the second (someone else's write landed in the
    // interim), so the true state cannot be determined from here at all.
    const unstableSubstrate = withInjectedReadAtCall(
      stores.operationGrantStore,
      namespace,
      "grant",
      3,
      async () => {
        await stores.operationGrantStore.appendOnce({
          namespace,
          key: "grant",
          body: otherGrant
        });
      }
    );
    const store = createDurableStageAgentSelectionGrantStore({ substrate: unstableSubstrate });

    const fault = await injectPersistentCommitFailure(1);
    try {
      await assert.rejects(
        store.claim(grant),
        (error: unknown) => error instanceof StageAgentSelectionGrantPersistenceAmbiguousError
      );
    } finally {
      fault.restore();
    }
  } finally {
    stores.close();
    root.cleanup();
  }
});

// ---------------------------------------------------------------------------
// DemoDispatchStore
// ---------------------------------------------------------------------------

test("DemoDispatchStore: genesis, replay, conflict, and restart", async () => {
  const root = temporaryStoreRoot("dispatch");
  const stores = openStores(root);
  try {
    const store = createDurableDemoDispatchStore({
      substrate: stores.receiptJournal,
      signer: harnessSigner,
      clock: fixedClock(),
      repositoryId: 42,
      workItemNodeId: "WI_demo",
      authorityEpoch: 1,
      generation: 0
    });

    const runStateDigest = d("run-state-a");
    const decision = {
      apiVersion: "agentic-framework.github.com/v1alpha1" as const,
      kind: "DemoDispatchDecision" as const,
      schemaVersion: "2.0.0" as const,
      contentDigest: d("decision-a"),
      spec: {
        demoProjectId: PROJECT_ID,
        runStateDigest,
        stageId: "framing",
        stageOrdinal: 1,
        action: "run-deterministic" as const,
        runtimeBinding: null,
        selectionGrantDigest: null,
        kernelRouteId: null,
        refusalDigest: null,
        reasonCode: "ready",
        decidedAt: "2026-08-30T12:00:00.000Z"
      }
    };

    const first = await store.persist(decision);
    assert.equal(first.status, "appended");
    assert.ok(first.receipt);
    assert.equal(first.receipt.sequence, 1);
    assert.equal(first.receipt.previousHead, null);
    assert.equal(first.receipt.decisionDigest, decision.contentDigest);
    assert.equal(first.receipt.runStateDigest, runStateDigest);
    assert.equal(first.receipt.repositoryId, 42);
    assert.equal(
      first.receipt.head,
      digest({
        storeId: first.receipt.storeId,
        sequence: first.receipt.sequence,
        previousHead: first.receipt.previousHead,
        decisionDigest: first.receipt.decisionDigest,
        runStateDigest: first.receipt.runStateDigest,
        repositoryId: first.receipt.repositoryId,
        workItemNodeId: first.receipt.workItemNodeId,
        authorityEpoch: first.receipt.authorityEpoch,
        generation: first.receipt.generation,
        status: first.receipt.status,
        persistedAt: first.receipt.persistedAt
      })
    );

    const replay = await store.persist(decision);
    assert.equal(replay.status, "existing");
    assert.deepEqual(replay.receipt, first.receipt);

    const conflictingKey = `demo-dispatch:${d("decision-conflict")}`;
    // A genuine conflict requires a differently-shaped receipt already
    // durably present under the exact namespace/key this store would use —
    // since the namespace is itself derived from the decision's own content
    // digest, this can only arise from a foreign/corrupted write, not from
    // this store's own normal operation. Inject one directly via the raw
    // substrate to exercise that path.
    await stores.receiptJournal.appendOnce({
      namespace: conflictingKey,
      key: "receipt",
      body: { foreign: "receipt", decisionDigest: d("decision-conflict-actually-different") }
    });
    const conflictingDecision = { ...decision, contentDigest: d("decision-conflict") };
    const conflictResult = await store.persist(conflictingDecision);
    assert.equal(conflictResult.status, "conflict");
    assert.equal(conflictResult.receipt, null);

    const otherDecision = { ...decision, contentDigest: d("decision-b") };
    const secondPersist = await store.persist(otherDecision);
    assert.equal(secondPersist.status, "appended");
    assert.notEqual(secondPersist.receipt?.decisionDigest, first.receipt.decisionDigest);

    assert.deepEqual(await store.read(decision.contentDigest), first.receipt);
    assert.equal(await store.read(d("unknown-decision")), null);

    stores.close();
    const reopened = openStores(root);
    try {
      const restarted = createDurableDemoDispatchStore({
        substrate: reopened.receiptJournal,
        signer: harnessSigner,
        clock: fixedClock(),
        repositoryId: 42,
        workItemNodeId: "WI_demo",
        authorityEpoch: 1,
        generation: 0
      });
      assert.deepEqual(await restarted.read(decision.contentDigest), first.receipt);
    } finally {
      reopened.close();
    }
  } finally {
    root.cleanup();
  }
});

test("DemoDispatchStore: a lost commit acknowledgement is reported distinctly", async () => {
  const root = temporaryStoreRoot("dispatch-ambiguous");
  const stores = openStores(root);
  try {
    const store = createDurableDemoDispatchStore({
      substrate: stores.receiptJournal,
      signer: harnessSigner,
      clock: fixedClock(),
      repositoryId: 42,
      workItemNodeId: "WI_demo",
      authorityEpoch: 1,
      generation: 0
    });
    const decision = {
      apiVersion: "agentic-framework.github.com/v1alpha1" as const,
      kind: "DemoDispatchDecision" as const,
      schemaVersion: "2.0.0" as const,
      contentDigest: d("decision-ambiguous"),
      spec: {
        demoProjectId: PROJECT_ID,
        runStateDigest: d("run-state-ambiguous"),
        stageId: "framing",
        stageOrdinal: 1,
        action: "run-deterministic" as const,
        runtimeBinding: null,
        selectionGrantDigest: null,
        kernelRouteId: null,
        refusalDigest: null,
        reasonCode: "ready",
        decidedAt: "2026-08-30T12:00:00.000Z"
      }
    };
    const { DatabaseSync } = await import("node:sqlite");
    const original = DatabaseSync.prototype.exec;
    let fired = false;
    DatabaseSync.prototype.exec = function patched(
      this: unknown,
      statement: string
    ): void {
      if (statement === "COMMIT" && !fired) {
        fired = true;
        throw new Error("simulated lost commit acknowledgement");
      }
      return original.call(this, statement);
    };
    try {
      await assert.rejects(
        store.persist(decision),
        (error: unknown) => error instanceof DemoDispatchPersistenceAmbiguousError
      );
    } finally {
      DatabaseSync.prototype.exec = original;
    }
    assert.ok(fired);
  } finally {
    stores.close();
    root.cleanup();
  }
});

// ---------------------------------------------------------------------------
// DemoStageReceiptStore
// ---------------------------------------------------------------------------

test("DemoStageReceiptStore: fencing by predecessor, replay, conflict, and scan-based read", async () => {
  const root = temporaryStoreRoot("stage-receipt");
  const stores = openStores(root);
  try {
    const store = createDurableDemoStageReceiptStore({
      substrate: stores.receiptJournal
    });

    const current = runState();
    const receipt = signedStageReceipt({ runStateDigest: current.contentDigest });
    const next = runState({ currentStageId: "planning" });

    const first = await store.append({
      expectedRunStateDigest: current.contentDigest,
      receipt,
      nextRunState: next
    });
    assert.equal(first.status, "appended");

    const replay = await store.append({
      expectedRunStateDigest: current.contentDigest,
      receipt,
      nextRunState: next
    });
    assert.equal(replay.status, "existing");

    const conflictingReceipt = signedStageReceipt({
      runStateDigest: current.contentDigest,
      stageId: "different-stage"
    });
    const conflicting = await store.append({
      expectedRunStateDigest: current.contentDigest,
      receipt: conflictingReceipt,
      nextRunState: runState({ currentStageId: "verification" })
    });
    assert.equal(conflicting.status, "conflict");

    const readResult = await store.read(receipt.contentDigest);
    assert.deepEqual(readResult?.receipt, receipt);
    assert.deepEqual(readResult?.runState, next);
    assert.equal(await store.read(d("unknown-receipt")), null);

    stores.close();
    const reopened = openStores(root);
    try {
      const restarted = createDurableDemoStageReceiptStore({
        substrate: reopened.receiptJournal
      });
      const afterRestart = await restarted.read(receipt.contentDigest);
      assert.deepEqual(afterRestart?.receipt, receipt);
    } finally {
      reopened.close();
    }
  } finally {
    root.cleanup();
  }
});

test("DemoStageReceiptStore: a receipt whose own predecessor disagrees with the append key fails closed before any write", async () => {
  const root = temporaryStoreRoot("stage-receipt-predecessor-mismatch");
  const stores = openStores(root);
  try {
    const store = createDurableDemoStageReceiptStore({ substrate: stores.receiptJournal });
    const current = runState();
    const otherPredecessor = runState({ runAttempt: 2 });
    // The receipt's own spec.runStateDigest references `current`, but the
    // caller mistakenly supplies a DIFFERENT expectedRunStateDigest as the
    // append key.
    const receipt = signedStageReceipt({ runStateDigest: current.contentDigest });

    await assert.rejects(
      store.append({
        expectedRunStateDigest: otherPredecessor.contentDigest,
        receipt,
        nextRunState: runState({ currentStageId: "planning" })
      }),
      (error: unknown) => error instanceof TypeError
    );

    // Nothing durable was ever produced under either predecessor's key.
    assert.equal(await store.read(receipt.contentDigest), null);
    const chain = await stores.receiptJournal.verifyChain("demo-stage-receipt");
    assert.equal(chain.length, 0, "a mismatched predecessor must never be durably written");
  } finally {
    stores.close();
    root.cleanup();
  }
});

test("DemoStageReceiptStore: a lost commit acknowledgement is reported distinctly", async () => {
  const root = temporaryStoreRoot("stage-receipt-ambiguous");
  const stores = openStores(root);
  try {
    const store = createDurableDemoStageReceiptStore({
      substrate: stores.receiptJournal
    });
    const current = runState();
    const receipt = signedStageReceipt({ runStateDigest: current.contentDigest });
    const { DatabaseSync } = await import("node:sqlite");
    const original = DatabaseSync.prototype.exec;
    let fired = false;
    DatabaseSync.prototype.exec = function patched(
      this: unknown,
      statement: string
    ): void {
      if (statement === "COMMIT" && !fired) {
        fired = true;
        throw new Error("simulated lost commit acknowledgement");
      }
      return original.call(this, statement);
    };
    try {
      await assert.rejects(
        store.append({
          expectedRunStateDigest: current.contentDigest,
          receipt,
          nextRunState: runState({ currentStageId: "planning" })
        }),
        (error: unknown) => error instanceof DemoStageReceiptPersistenceAmbiguousError
      );
    } finally {
      DatabaseSync.prototype.exec = original;
    }
    assert.ok(fired);
  } finally {
    stores.close();
    root.cleanup();
  }
});

// ---------------------------------------------------------------------------
// DemoKernelStateStore
// ---------------------------------------------------------------------------

test("DemoKernelStateStore: genesis read, applied persistence, replay, conflict, and restart", async () => {
  const root = temporaryStoreRoot("kernel-state");
  const stores = openStores(root);
  try {
    const genesis = kernelSnapshot();
    const store = createDurableDemoKernelStateStore({
      substrate: stores.runtimeStateStore,
      genesisSnapshot: genesis
    });

    assert.deepEqual(await store.read(), genesis);

    const applied = appliedResult({ from: genesis, eventId: "event-1" });
    const first = await store.persistApplied(applied);
    assert.equal(first.status, "appended");
    assert.deepEqual(await store.read(), applied.snapshot);

    // Byte-identical replay of the exact same transition.
    const replay = await store.persistApplied(applied);
    assert.equal(replay.status, "existing");
    assert.deepEqual(await store.read(), applied.snapshot);

    // A transition claiming a stale predecessor conflicts.
    const staleApplied = appliedResult({ from: genesis, eventId: "event-2" });
    const conflicting = await store.persistApplied(staleApplied);
    assert.equal(conflicting.status, "conflict");
    assert.deepEqual(await store.read(), applied.snapshot);

    // A genuine forward transition succeeds.
    const advanced = appliedResult({ from: applied.snapshot, eventId: "event-3" });
    const second = await store.persistApplied(advanced);
    assert.equal(second.status, "appended");
    assert.deepEqual(await store.read(), advanced.snapshot);

    stores.close();
    const reopened = openStores(root);
    try {
      const restarted = createDurableDemoKernelStateStore({
        substrate: reopened.runtimeStateStore,
        genesisSnapshot: genesis
      });
      assert.deepEqual(await restarted.read(), advanced.snapshot);
    } finally {
      reopened.close();
    }
  } finally {
    root.cleanup();
  }
});

test("DemoKernelStateStore: a lost commit acknowledgement is reported distinctly", async () => {
  const root = temporaryStoreRoot("kernel-state-ambiguous");
  const stores = openStores(root);
  try {
    const genesis = kernelSnapshot();
    const store = createDurableDemoKernelStateStore({
      substrate: stores.runtimeStateStore,
      genesisSnapshot: genesis
    });
    const applied = appliedResult({ from: genesis, eventId: "event-1" });
    const { DatabaseSync } = await import("node:sqlite");
    const original = DatabaseSync.prototype.exec;
    let fired = false;
    DatabaseSync.prototype.exec = function patched(
      this: unknown,
      statement: string
    ): void {
      if (statement === "COMMIT" && !fired) {
        fired = true;
        throw new Error("simulated lost commit acknowledgement");
      }
      return original.call(this, statement);
    };
    try {
      await assert.rejects(
        store.persistApplied(applied),
        (error: unknown) => error instanceof DemoKernelPersistenceAmbiguousError
      );
    } finally {
      DatabaseSync.prototype.exec = original;
    }
    assert.ok(fired);
  } finally {
    stores.close();
    root.cleanup();
  }
});

// ---------------------------------------------------------------------------
// DemoRunStateStore
// ---------------------------------------------------------------------------

test("DemoRunStateStore: genesis read, CAS, replay, conflict, and restart", async () => {
  const root = temporaryStoreRoot("run-state");
  const stores = openStores(root);
  try {
    const genesis = runState();
    const store = createDurableDemoRunStateStore({
      substrate: stores.runtimeStateStore,
      genesisRunState: genesis
    });

    assert.deepEqual(await store.read(), genesis);

    const next = runState({ currentStageId: "planning" });
    const first = await store.compareAndSwap({
      expectedRunStateDigest: genesis.contentDigest,
      nextRunState: next
    });
    assert.equal(first.status, "appended");
    assert.deepEqual(await store.read(), next);

    const replay = await store.compareAndSwap({
      expectedRunStateDigest: genesis.contentDigest,
      nextRunState: next
    });
    assert.equal(replay.status, "existing");
    assert.deepEqual(await store.read(), next);

    const staleNext = runState({ currentStageId: "verification" });
    const conflicting = await store.compareAndSwap({
      expectedRunStateDigest: genesis.contentDigest,
      nextRunState: staleNext
    });
    assert.equal(conflicting.status, "conflict");
    assert.deepEqual(await store.read(), next);

    const advanced = runState({ currentStageId: "execution" });
    const second = await store.compareAndSwap({
      expectedRunStateDigest: next.contentDigest,
      nextRunState: advanced
    });
    assert.equal(second.status, "appended");
    assert.deepEqual(await store.read(), advanced);

    stores.close();
    const reopened = openStores(root);
    try {
      const restarted = createDurableDemoRunStateStore({
        substrate: reopened.runtimeStateStore,
        genesisRunState: genesis
      });
      assert.deepEqual(await restarted.read(), advanced);
    } finally {
      reopened.close();
    }
  } finally {
    root.cleanup();
  }
});

test("DemoRunStateStore: a lost commit acknowledgement is reported distinctly", async () => {
  const root = temporaryStoreRoot("run-state-ambiguous");
  const stores = openStores(root);
  try {
    const genesis = runState();
    const store = createDurableDemoRunStateStore({
      substrate: stores.runtimeStateStore,
      genesisRunState: genesis
    });
    const next = runState({ currentStageId: "planning" });
    const { DatabaseSync } = await import("node:sqlite");
    const original = DatabaseSync.prototype.exec;
    let fired = false;
    DatabaseSync.prototype.exec = function patched(
      this: unknown,
      statement: string
    ): void {
      if (statement === "COMMIT" && !fired) {
        fired = true;
        throw new Error("simulated lost commit acknowledgement");
      }
      return original.call(this, statement);
    };
    try {
      await assert.rejects(
        store.compareAndSwap({
          expectedRunStateDigest: genesis.contentDigest,
          nextRunState: next
        }),
        (error: unknown) => error instanceof DemoRunStatePersistenceAmbiguousError
      );
    } finally {
      DatabaseSync.prototype.exec = original;
    }
    assert.ok(fired);
  } finally {
    stores.close();
    root.cleanup();
  }
});

test("DemoRunStateStore: two independent substrate handles genuinely racing distinct successors yield exactly one CAS winner", async () => {
  const root = temporaryStoreRoot("run-state-cross-process");
  // Create the store files first so both handles open an initialized store.
  openStores(root).close();

  const genesis = runState();
  const handleA = openStores(root);
  const handleB = openStores(root);
  try {
    const storeA = createDurableDemoRunStateStore({
      substrate: handleA.runtimeStateStore,
      genesisRunState: genesis
    });
    const storeB = createDurableDemoRunStateStore({
      substrate: handleB.runtimeStateStore,
      genesisRunState: genesis
    });

    const next = runState({ currentStageId: "planning" });
    const staleAttempt = runState({ currentStageId: "verification" });
    // Neither handle `await`s the other first: both genuinely race the
    // adapters' own `readCurrent` precheck against the substrate's
    // compare-and-swap, fencing off the SAME genesis expected digest with
    // two DIFFERENT successors.
    const [resultA, resultB] = await Promise.all([
      storeA.compareAndSwap({ expectedRunStateDigest: genesis.contentDigest, nextRunState: next }),
      storeB.compareAndSwap({
        expectedRunStateDigest: genesis.contentDigest,
        nextRunState: staleAttempt
      })
    ]);
    const statuses = [resultA.status, resultB.status].sort();
    assert.deepEqual(
      statuses,
      ["appended", "conflict"],
      "differing successors racing the same predecessor must yield exactly one winner, never two"
    );
    const winningNext = resultA.status === "appended" ? next : staleAttempt;

    // A byte-identical retry of the exact winning operation on the OTHER
    // handle must be recognized as the same durable outcome, not a conflict.
    const replay = await storeB.compareAndSwap({
      expectedRunStateDigest: genesis.contentDigest,
      nextRunState: winningNext
    });
    assert.equal(replay.status, "existing");

    assert.deepEqual(await storeA.read(), winningNext);
    assert.deepEqual(await storeB.read(), winningNext);
  } finally {
    handleA.close();
    handleB.close();
    root.cleanup();
  }
});

// ---------------------------------------------------------------------------
// DemoRecoveryBudgetStore
// ---------------------------------------------------------------------------

function recoveryEvidence(overrides: {
  readonly budgetBeforeDigest: `sha256:${string}`;
  readonly budgetAfterDigest: `sha256:${string}`;
  readonly kernelReceiptDigest: `sha256:${string}`;
}): Omit<DemoRecoveryBudgetEvidence, "signature"> {
  return {
    schemaVersion: "1.0.0",
    budgetBeforeDigest: overrides.budgetBeforeDigest,
    budgetAfterDigest: overrides.budgetAfterDigest,
    kernelReceiptDigest: overrides.kernelReceiptDigest,
    runStateDigest: d("run-state-recovery"),
    generationBefore: 0,
    generationAfter: 1,
    retriesBefore: 0,
    retriesAfter: 1,
    recordedAt: "2026-08-30T12:00:00.000Z"
  };
}

test("DemoRecoveryBudgetStore: genesis read, record, replay, conflict, readEvidence, and restart", async () => {
  const root = temporaryStoreRoot("recovery-budget");
  const stores = openStores(root);
  try {
    const genesis = budgetState();
    const store = createDurableDemoRecoveryBudgetStore({
      substrate: stores.runtimeStateStore,
      signer: harnessSigner,
      genesisBudget: genesis
    });

    assert.deepEqual(await store.read(), genesis);

    const next = budgetState({ generation: 1, retries: 1, ledgerVersion: 1 });
    const evidence = recoveryEvidence({
      budgetBeforeDigest: genesis.contentDigest,
      budgetAfterDigest: next.contentDigest,
      kernelReceiptDigest: d("kernel-receipt-1")
    });
    const first = await store.record({ expected: genesis, next, evidence });
    assert.equal(first.status, "appended");
    assert.deepEqual(first.budget, next);
    assert.equal(
      canonicalJson(withoutSig(first.evidence ?? {})),
      canonicalJson(evidence)
    );
    assert.deepEqual(await store.read(), next);

    const replay = await store.record({ expected: genesis, next, evidence });
    assert.equal(replay.status, "existing");
    assert.deepEqual(replay.budget, next);

    const conflictingNext = budgetState({ generation: 1, retries: 0, ledgerVersion: 1 });
    const conflictingEvidence = recoveryEvidence({
      budgetBeforeDigest: genesis.contentDigest,
      budgetAfterDigest: conflictingNext.contentDigest,
      kernelReceiptDigest: d("kernel-receipt-2")
    });
    const conflicting = await store.record({
      expected: genesis,
      next: conflictingNext,
      evidence: conflictingEvidence
    });
    assert.equal(conflicting.status, "conflict");
    assert.equal(conflicting.budget, null);
    assert.equal(conflicting.evidence, null);

    const readEvidence = await store.readEvidence(d("kernel-receipt-1"));
    assert.ok(readEvidence);
    assert.equal(
      canonicalJson(withoutSig(readEvidence)),
      canonicalJson(evidence)
    );
    assert.equal(await store.readEvidence(d("unknown-kernel-receipt")), null);

    stores.close();
    const reopened = openStores(root);
    try {
      const restarted = createDurableDemoRecoveryBudgetStore({
        substrate: reopened.runtimeStateStore,
        signer: harnessSigner,
        genesisBudget: genesis
      });
      assert.deepEqual(await restarted.read(), next);
    } finally {
      reopened.close();
    }
  } finally {
    root.cleanup();
  }
});

test("DemoRecoveryBudgetStore: a lost commit acknowledgement is reported distinctly", async () => {
  const root = temporaryStoreRoot("recovery-budget-ambiguous");
  const stores = openStores(root);
  try {
    const genesis = budgetState();
    const store = createDurableDemoRecoveryBudgetStore({
      substrate: stores.runtimeStateStore,
      signer: harnessSigner,
      genesisBudget: genesis
    });
    const next = budgetState({ generation: 1, retries: 1, ledgerVersion: 1 });
    const evidence = recoveryEvidence({
      budgetBeforeDigest: genesis.contentDigest,
      budgetAfterDigest: next.contentDigest,
      kernelReceiptDigest: d("kernel-receipt-ambiguous")
    });
    const { DatabaseSync } = await import("node:sqlite");
    const original = DatabaseSync.prototype.exec;
    let fired = false;
    DatabaseSync.prototype.exec = function patched(
      this: unknown,
      statement: string
    ): void {
      if (statement === "COMMIT" && !fired) {
        fired = true;
        throw new Error("simulated lost commit acknowledgement");
      }
      return original.call(this, statement);
    };
    try {
      await assert.rejects(
        store.record({ expected: genesis, next, evidence }),
        (error: unknown) => error instanceof DemoRecoveryBudgetPersistenceAmbiguousError
      );
    } finally {
      DatabaseSync.prototype.exec = original;
    }
    assert.ok(fired);
  } finally {
    stores.close();
    root.cleanup();
  }
});

// ---------------------------------------------------------------------------
// DemoProviderUsageLedger
// ---------------------------------------------------------------------------

function attemptWithoutSignature(overrides: {
  readonly attemptKey: `sha256:${string}`;
}): Omit<DemoProviderAttemptEvidence, "signature"> {
  return {
    schemaVersion: "1.0.0",
    attemptKey: overrides.attemptKey,
    reservationDigest: d("reservation"),
    fenceDigest: d("fence"),
    demoProjectId: PROJECT_ID,
    repositoryId: 42,
    workItemNodeId: "WI_demo",
    authorityEpoch: 1,
    generation: 0,
    runId: "run-1",
    runAttempt: 1,
    stageId: "execution",
    runtimeBinding: {
      agentId: "agent-a",
      capabilityId: "capability-a",
      workflowId: "workflow-a"
    },
    startedAt: "2026-08-30T12:00:00.000Z",
    expiresAt: "2026-08-30T13:00:00.000Z"
  };
}

test("DemoProviderUsageLedger: begin and reconcile are idempotent per attempt", async () => {
  const root = temporaryStoreRoot("provider-usage");
  const stores = openStores(root);
  try {
    let resolveCalls = 0;
    let signCalls = 0;
    const countingSigner = {
      sign: (payload: unknown) => {
        signCalls += 1;
        return harnessSigner.sign(payload);
      }
    };
    const store = createDurableDemoProviderUsageLedger({
      substrate: stores.receiptJournal,
      signer: countingSigner,
      clock: fixedClock(),
      resolveUsage: async (attempt) => {
        resolveCalls += 1;
        return {
          status: "settled",
          calls: 1,
          tokens: 100,
          costUnits: 3,
          providerUsageDigest: digest({ attemptDigest: digest(attempt) })
        };
      }
    });

    const attemptKey = d("attempt-1");
    const draft = attemptWithoutSignature({ attemptKey });
    const first = await store.begin(draft);
    assert.equal(
      canonicalJson(withoutSig(first)),
      canonicalJson(draft)
    );
    assert.equal(signCalls, 1);

    const replayBegin = await store.begin(draft);
    assert.deepEqual(replayBegin, first);
    assert.equal(
      signCalls,
      1,
      "a normal top-level begin() replay must skip signing entirely, not merely skip the write"
    );

    const usage = await store.reconcile(first);
    assert.equal(usage.attemptDigest, digest(first));
    assert.equal(usage.status, "settled");
    assert.equal(resolveCalls, 1);

    const replayReconcile = await store.reconcile(first);
    assert.deepEqual(replayReconcile, usage);
    assert.equal(resolveCalls, 1, "a byte-identical reconcile replay must not resolve usage again");

    stores.close();
  } finally {
    root.cleanup();
  }
});

test("DemoProviderUsageLedger: two attempts with distinct keys never collide", async () => {
  const root = temporaryStoreRoot("provider-usage-distinct");
  const stores = openStores(root);
  try {
    const store = createDurableDemoProviderUsageLedger({
      substrate: stores.receiptJournal,
      signer: harnessSigner,
      clock: fixedClock(),
      resolveUsage: async () => ({
        status: "unknown",
        calls: null,
        tokens: null,
        costUnits: null,
        providerUsageDigest: null
      })
    });
    const a = await store.begin(attemptWithoutSignature({ attemptKey: d("attempt-a") }));
    const b = await store.begin(attemptWithoutSignature({ attemptKey: d("attempt-b") }));
    assert.notEqual(digest(a), digest(b));
    const usageA = await store.reconcile(a);
    const usageB = await store.reconcile(b);
    assert.notEqual(usageA.attemptDigest, usageB.attemptDigest);
  } finally {
    stores.close();
    root.cleanup();
  }
});

test("DemoProviderUsageLedger.begin(): a differently-shaped attempt under the same key is a conflict, never silently overwritten", async () => {
  const root = temporaryStoreRoot("provider-begin-conflict");
  const stores = openStores(root);
  try {
    const store = createDurableDemoProviderUsageLedger({
      substrate: stores.receiptJournal,
      signer: harnessSigner,
      clock: fixedClock(),
      resolveUsage: async () => ({
        status: "unknown",
        calls: null,
        tokens: null,
        costUnits: null,
        providerUsageDigest: null
      })
    });
    const attemptKey = d("attempt-begin-conflict");
    const first = await store.begin(attemptWithoutSignature({ attemptKey }));
    assert.ok(first);

    const mutated = { ...attemptWithoutSignature({ attemptKey }), stageId: "verification" };
    await assert.rejects(store.begin(mutated), (error: unknown) => error instanceof TypeError);

    // The original durable record must be unchanged.
    const namespace = `demo-provider-attempt:${attemptKey}`;
    const record = await stores.receiptJournal.read({ namespace, key: "attempt" });
    assert.ok(record);
    assert.equal(
      canonicalJson(withoutSig(record.body as DemoProviderAttemptEvidence)),
      canonicalJson(withoutSig(first))
    );
  } finally {
    stores.close();
    root.cleanup();
  }
});

test("DemoProviderUsageLedger.begin(): two independent substrate handles racing the same attempt through a non-deterministic signer both succeed as a benign metadata race", async () => {
  const root = temporaryStoreRoot("provider-begin-race-nondeterministic");
  openStores(root).close();

  const handleA = openStores(root);
  const handleB = openStores(root);
  try {
    // A non-deterministic signer (unlike the shared, hash-based
    // `harnessSigner` every other test in this file uses) means two
    // concurrent `begin()` calls for the identical attempt content produce
    // BYTE-DIFFERENT bodies (different signatures) — this is exactly the
    // benign metadata race `singleKeyIdempotentWrite`'s conflict-reread
    // exists to resolve for every sibling `appendOnce` port, and `begin()`
    // must resolve it the same way despite bypassing that shared helper.
    let signCalls = 0;
    const nonDeterministicSigner = {
      sign: (payload: unknown): Promise<DemoSignature> => {
        signCalls += 1;
        return Promise.resolve({
          algorithm: "ed25519" as const,
          keyId: `race:key-${signCalls}`,
          value: Buffer.from(digest(payload)).toString("base64")
        });
      }
    };
    const makeStore = (substrate: DurableSubstrate) =>
      createDurableDemoProviderUsageLedger({
        substrate,
        signer: nonDeterministicSigner,
        clock: fixedClock(),
        resolveUsage: async () => ({
          status: "unknown",
          calls: null,
          tokens: null,
          costUnits: null,
          providerUsageDigest: null
        })
      });
    const storeA = makeStore(handleA.receiptJournal);
    const storeB = makeStore(handleB.receiptJournal);

    const draft = attemptWithoutSignature({ attemptKey: d("attempt-begin-race") });
    const [resultA, resultB] = await Promise.allSettled([
      storeA.begin(draft),
      storeB.begin(draft)
    ]);

    assert.equal(resultA.status, "fulfilled", `storeA must not fail: ${String(resultA)}`);
    assert.equal(resultB.status, "fulfilled", `storeB must not fail: ${String(resultB)}`);
    if (resultA.status === "fulfilled" && resultB.status === "fulfilled") {
      assert.equal(
        canonicalJson(withoutSig(resultA.value)),
        canonicalJson(withoutSig(resultB.value)),
        "both racers must observe the same durable operation content"
      );
    }
  } finally {
    handleA.close();
    handleB.close();
    root.cleanup();
  }
});

test("DemoProviderUsageLedger.reconcile(): a foreign usage record under the same attempt digest is a conflict, never silently overwritten", async () => {
  const root = temporaryStoreRoot("provider-reconcile-conflict");
  const stores = openStores(root);
  try {
    let resolveCalls = 0;
    const store = createDurableDemoProviderUsageLedger({
      substrate: stores.receiptJournal,
      signer: harnessSigner,
      clock: fixedClock(),
      resolveUsage: async () => {
        resolveCalls += 1;
        return {
          status: "settled",
          calls: 1,
          tokens: 10,
          costUnits: 1,
          providerUsageDigest: d("provider-usage-conflict")
        };
      }
    });
    const attempt = await store.begin(
      attemptWithoutSignature({ attemptKey: d("attempt-reconcile-conflict") })
    );
    const attemptDigest = digest(attempt);
    const namespace = `demo-provider-usage:${attemptDigest}`;

    // Seed a foreign usage record directly under the "usage" key this
    // reconcile() call would use, simulating a corrupted or wrongly-routed
    // prior write — its own `attemptDigest` field genuinely differs, so
    // `sameUsage()` must (correctly) treat it as a conflict. The claim
    // itself is left untouched so this call wins it cleanly and reaches the
    // final usage write, which is where the conflict must surface.
    await stores.receiptJournal.appendOnce({
      namespace,
      key: "usage",
      body: { attemptDigest: d("attempt-digest-actually-different"), foreign: "usage-record" }
    });

    await assert.rejects(store.reconcile(attempt), (error: unknown) => error instanceof TypeError);
    assert.equal(
      resolveCalls,
      1,
      "the provider is still invoked exactly once (the claim was won cleanly) even though the final write conflicts"
    );
  } finally {
    stores.close();
    root.cleanup();
  }
});

test("DemoProviderUsageLedger: begin() and reconcile() are restart-continuous", async () => {
  const root = temporaryStoreRoot("provider-restart");
  const stores = openStores(root);
  let resolveCalls = 0;
  const makeStore = (substrate: DurableSubstrate) =>
    createDurableDemoProviderUsageLedger({
      substrate,
      signer: harnessSigner,
      clock: fixedClock(),
      resolveUsage: async () => {
        resolveCalls += 1;
        return {
          status: "settled",
          calls: 1,
          tokens: 10,
          costUnits: 1,
          providerUsageDigest: d("provider-usage-restart")
        };
      }
    });

  const draft = attemptWithoutSignature({ attemptKey: d("attempt-restart") });
  const before = makeStore(stores.receiptJournal);
  const attempt = await before.begin(draft);
  const usageBefore = await before.reconcile(attempt);
  assert.equal(resolveCalls, 1);
  stores.close();

  const reopened = openStores(root);
  try {
    const after = makeStore(reopened.receiptJournal);
    const replayedAttempt = await after.begin(draft);
    assert.deepEqual(replayedAttempt, attempt);

    const usageAfter = await after.reconcile(replayedAttempt);
    assert.deepEqual(usageAfter, usageBefore);
    assert.equal(
      resolveCalls,
      1,
      "restart continuity must not re-invoke the provider for an already-reconciled attempt"
    );
  } finally {
    reopened.close();
    root.cleanup();
  }
});

test("DemoProviderUsageLedger.begin(): a stably-absent write after ambiguity fails closed, never resubmitted", async () => {
  const root = temporaryStoreRoot("provider-begin-absent-ambiguous");
  const stores = openStores(root);
  try {
    const store = createDurableDemoProviderUsageLedger({
      substrate: stores.receiptJournal,
      signer: harnessSigner,
      clock: fixedClock(),
      resolveUsage: async () => ({
        status: "unknown",
        calls: null,
        tokens: null,
        costUnits: null,
        providerUsageDigest: null
      })
    });
    const draft = attemptWithoutSignature({ attemptKey: d("attempt-begin-absent") });
    const fault = await injectPersistentCommitFailure(1);
    try {
      await assert.rejects(
        store.begin(draft),
        (error: unknown) => error instanceof DemoProviderUsageLedgerPersistenceFailedError
      );
    } finally {
      fault.restore();
    }
    assert.equal(fault.fired(), 1, "the mutation must never be resubmitted");
    const record = await stores.receiptJournal.read({
      namespace: `demo-provider-attempt:${draft.attemptKey}`,
      key: "attempt"
    });
    assert.equal(record, null, "nothing durable was ever produced for this attempt");
  } finally {
    stores.close();
    root.cleanup();
  }
});

test("DemoProviderUsageLedger.begin(): a commit that actually landed is recognized by reread, not retried", async () => {
  const root = temporaryStoreRoot("provider-begin-landed-ambiguous");
  const stores = openStores(root);
  try {
    const store = createDurableDemoProviderUsageLedger({
      substrate: stores.receiptJournal,
      signer: harnessSigner,
      clock: fixedClock(),
      resolveUsage: async () => ({
        status: "unknown",
        calls: null,
        tokens: null,
        costUnits: null,
        providerUsageDigest: null
      })
    });
    const draft = attemptWithoutSignature({ attemptKey: d("attempt-begin-landed") });
    const fault = await injectLandedButAcknowledgementLostCommit(1);
    let attempt;
    try {
      attempt = await store.begin(draft);
    } finally {
      fault.restore();
    }
    assert.equal(fault.fired(), 1);
    assert.equal(canonicalJson(withoutSig(attempt)), canonicalJson(draft));
    const chain = await stores.receiptJournal.verifyChain(
      `demo-provider-attempt:${draft.attemptKey}`
    );
    assert.equal(chain.length, 1, "the attempt record must not be duplicated");
  } finally {
    stores.close();
    root.cleanup();
  }
});

test("DemoProviderUsageLedger.begin(): an unstable double read after ambiguity fails closed, never conceals as success", async () => {
  const root = temporaryStoreRoot("provider-begin-unstable-ambiguous");
  const stores = openStores(root);
  try {
    const draft = attemptWithoutSignature({ attemptKey: d("attempt-begin-unstable") });
    const namespace = `demo-provider-attempt:${draft.attemptKey}`;
    const otherAttempt = { ...draft, workItemNodeId: "WI_other", signature: harnessSignature(draft) };

    // The two reconciliation reads disagree: nothing there yet, then a
    // genuinely different attempt record lands strictly between them.
    const unstableSubstrate = withInjectedReadAtCall(
      stores.receiptJournal,
      namespace,
      "attempt",
      3,
      async () => {
        await stores.receiptJournal.appendOnce({ namespace, key: "attempt", body: otherAttempt });
      }
    );
    const store = createDurableDemoProviderUsageLedger({
      substrate: unstableSubstrate,
      signer: harnessSigner,
      clock: fixedClock(),
      resolveUsage: async () => ({
        status: "unknown",
        calls: null,
        tokens: null,
        costUnits: null,
        providerUsageDigest: null
      })
    });

    const fault = await injectPersistentCommitFailure(1);
    try {
      await assert.rejects(
        store.begin(draft),
        (error: unknown) => error instanceof DemoProviderUsageLedgerPersistenceFailedError
      );
    } finally {
      fault.restore();
    }
  } finally {
    stores.close();
    root.cleanup();
  }
});

test("DemoProviderUsageLedger.reconcile(): a stably-absent claim write fails closed and never invokes the provider", async () => {
  const root = temporaryStoreRoot("provider-reconcile-claim-absent");
  const stores = openStores(root);
  try {
    let resolveCalls = 0;
    const store = createDurableDemoProviderUsageLedger({
      substrate: stores.receiptJournal,
      signer: harnessSigner,
      clock: fixedClock(),
      resolveUsage: async () => {
        resolveCalls += 1;
        return {
          status: "settled",
          calls: 1,
          tokens: 10,
          costUnits: 1,
          providerUsageDigest: d("provider-usage-claim-absent")
        };
      }
    });
    const attempt = await store.begin(
      attemptWithoutSignature({ attemptKey: d("attempt-claim-absent") })
    );

    // Targets the first COMMIT inside reconcile() — the claim write — and
    // prevents it from landing at all.
    const fault = await injectCommitFaultAtOrdinal(1, false);
    try {
      await assert.rejects(
        store.reconcile(attempt),
        (error: unknown) => error instanceof DemoProviderUsageLedgerPersistenceFailedError
      );
    } finally {
      fault.restore();
    }
    assert.equal(fault.fired(), 1);
    assert.equal(resolveCalls, 0, "the provider must never be invoked before reconciliation rights are confirmed won");
  } finally {
    stores.close();
    root.cleanup();
  }
});

test("DemoProviderUsageLedger.reconcile(): a claim write that actually landed is treated as a non-owning contender and never invokes the provider", async () => {
  const root = temporaryStoreRoot("provider-reconcile-claim-landed");
  const stores = openStores(root);
  try {
    let resolveCalls = 0;
    const store = createDurableDemoProviderUsageLedger({
      substrate: stores.receiptJournal,
      signer: harnessSigner,
      clock: fixedClock(),
      resolveUsage: async () => {
        resolveCalls += 1;
        return {
          status: "settled",
          calls: 1,
          tokens: 10,
          costUnits: 1,
          providerUsageDigest: d("provider-usage-claim-landed")
        };
      }
    });
    const attempt = await store.begin(
      attemptWithoutSignature({ attemptKey: d("attempt-claim-landed") })
    );

    // Targets the first COMMIT inside reconcile() — the claim write — and
    // lets it actually land before the acknowledgement is lost. Ambiguity
    // means this call cannot prove it is the one that created the claim, so
    // it must conservatively treat itself as a non-owning contender.
    const fault = await injectCommitFaultAtOrdinal(1, true);
    try {
      await assert.rejects(
        store.reconcile(attempt),
        (error: unknown) => error instanceof DemoProviderUsageLedgerReconciliationPendingError
      );
    } finally {
      fault.restore();
    }
    assert.equal(fault.fired(), 1);
    assert.equal(resolveCalls, 0, "an ambiguous-but-landed claim must never invoke the provider");
  } finally {
    stores.close();
    root.cleanup();
  }
});

test("DemoProviderUsageLedger.reconcile(): a stably-absent usage write after a won claim fails closed, provider invoked exactly once", async () => {
  const root = temporaryStoreRoot("provider-reconcile-usage-absent");
  const stores = openStores(root);
  try {
    let resolveCalls = 0;
    const store = createDurableDemoProviderUsageLedger({
      substrate: stores.receiptJournal,
      signer: harnessSigner,
      clock: fixedClock(),
      resolveUsage: async () => {
        resolveCalls += 1;
        return {
          status: "settled",
          calls: 1,
          tokens: 10,
          costUnits: 1,
          providerUsageDigest: d("provider-usage-usage-absent")
        };
      }
    });
    const attempt = await store.begin(
      attemptWithoutSignature({ attemptKey: d("attempt-usage-absent") })
    );

    // Targets the second COMMIT inside reconcile() — the usage write, after
    // the claim already landed cleanly — and prevents it from landing.
    const fault = await injectCommitFaultAtOrdinal(2, false);
    try {
      await assert.rejects(
        store.reconcile(attempt),
        (error: unknown) => error instanceof DemoProviderUsageLedgerPersistenceFailedError
      );
    } finally {
      fault.restore();
    }
    assert.equal(fault.fired(), 1);
    assert.equal(
      resolveCalls,
      1,
      "the provider is invoked exactly once even though the final write failed"
    );
  } finally {
    stores.close();
    root.cleanup();
  }
});

test("DemoProviderUsageLedger.reconcile(): a usage write that actually landed is recognized by reread, never re-resolved", async () => {
  const root = temporaryStoreRoot("provider-reconcile-usage-landed");
  const stores = openStores(root);
  try {
    let resolveCalls = 0;
    const store = createDurableDemoProviderUsageLedger({
      substrate: stores.receiptJournal,
      signer: harnessSigner,
      clock: fixedClock(),
      resolveUsage: async () => {
        resolveCalls += 1;
        return {
          status: "settled",
          calls: 1,
          tokens: 10,
          costUnits: 1,
          providerUsageDigest: d("provider-usage-usage-landed")
        };
      }
    });
    const attempt = await store.begin(
      attemptWithoutSignature({ attemptKey: d("attempt-usage-landed") })
    );
    const attemptDigest = digest(attempt);

    const fault = await injectCommitFaultAtOrdinal(2, true);
    let usage;
    try {
      usage = await store.reconcile(attempt);
    } finally {
      fault.restore();
    }
    assert.equal(fault.fired(), 1);
    assert.equal(usage.attemptDigest, attemptDigest);
    assert.equal(usage.status, "settled");
    assert.equal(resolveCalls, 1, "a landed write must be recognized by reread, never re-resolved");

    const usageChain = await stores.receiptJournal.verifyChain(
      `demo-provider-usage:${attemptDigest}`
    );
    // The claim record and the usage record share this namespace under
    // distinct keys ("claim", "usage"), so the journal holds exactly two
    // entries: one durable usage record, not a duplicate.
    const usageEntries = usageChain.filter((record) => record.key === "usage");
    assert.equal(usageEntries.length, 1, "the usage record must not be duplicated");
  } finally {
    stores.close();
    root.cleanup();
  }
});

test("DemoProviderUsageLedger.reconcile(): a claim left behind by a crashed claimant fails closed on restart, provider never invoked", async () => {
  const root = temporaryStoreRoot("provider-crash-restart");
  const stores = openStores(root);
  try {
    let resolveCalls = 0;
    const store = createDurableDemoProviderUsageLedger({
      substrate: stores.receiptJournal,
      signer: harnessSigner,
      clock: fixedClock(),
      resolveUsage: async () => {
        resolveCalls += 1;
        return {
          status: "settled",
          calls: 1,
          tokens: 10,
          costUnits: 1,
          providerUsageDigest: d("provider-usage-crash")
        };
      }
    });
    const attempt = await store.begin(attemptWithoutSignature({ attemptKey: d("attempt-crash") }));
    const attemptDigest = digest(attempt);
    const namespace = `demo-provider-usage:${attemptDigest}`;

    // Simulate an earlier claimant that durably won reconciliation rights
    // and then crashed before ever calling the provider or writing a
    // completed usage record — the durable claim is the only trace left.
    const claimOutcome = await stores.receiptJournal.appendOnce({
      namespace,
      key: "claim",
      body: { schemaVersion: "1.0.0", attemptDigest, claimed: true }
    });
    assert.equal(claimOutcome.status, "appended");

    // A fresh call (simulating a restart) must never invoke the provider
    // again without authenticated provider-side idempotency evidence, which
    // this port does not have: it fails closed instead.
    await assert.rejects(
      store.reconcile(attempt),
      (error: unknown) => error instanceof DemoProviderUsageLedgerReconciliationPendingError
    );
    assert.equal(
      resolveCalls,
      0,
      "a call that finds an existing claim must never invoke the provider"
    );
  } finally {
    stores.close();
    root.cleanup();
  }
});

test("DemoProviderUsageLedger.reconcile(): two independent substrate handles racing the same attempt invoke the provider exactly once", async () => {
  const root = temporaryStoreRoot("provider-reconcile-race-handles");
  const storesA = openStores(root);
  const storesB = openStores(root);
  try {
    let resolveCalls = 0;
    const makeStore = (substrate: DurableSubstrate) =>
      createDurableDemoProviderUsageLedger({
        substrate,
        signer: harnessSigner,
        clock: fixedClock(),
        resolveUsage: async () => {
          resolveCalls += 1;
          return {
            status: "settled",
            calls: 1,
            tokens: 10,
            costUnits: 1,
            providerUsageDigest: d("provider-usage-race")
          };
        }
      });
    const storeA = makeStore(storesA.receiptJournal);
    const storeB = makeStore(storesB.receiptJournal);

    // Both handles must observe the exact same begun attempt to target the
    // same attempt digest and therefore the same reconciliation claim.
    const attempt = await storeA.begin(
      attemptWithoutSignature({ attemptKey: d("attempt-race-handles") })
    );

    const [resultA, resultB] = await Promise.allSettled([
      storeA.reconcile(attempt),
      storeB.reconcile(attempt)
    ]);

    assert.equal(resolveCalls, 1, "exactly one handle may invoke the provider");

    const outcomes = [resultA, resultB];
    const fulfilled = outcomes.filter(
      (outcome): outcome is PromiseFulfilledResult<DemoProviderUsageEvidence> =>
        outcome.status === "fulfilled"
    );
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected"
    );
    assert.ok(fulfilled.length >= 1, "at least one racer must observe the settled usage");
    for (const outcome of fulfilled) {
      assert.equal(outcome.value.status, "settled");
      assert.equal(outcome.value.attemptDigest, digest(attempt));
    }
    for (const outcome of rejected) {
      assert.ok(
        outcome.reason instanceof DemoProviderUsageLedgerReconciliationPendingError,
        `a losing racer must fail closed with the dedicated pending error, got ${String(outcome.reason)}`
      );
    }
  } finally {
    storesA.close();
    storesB.close();
    root.cleanup();
  }
});

test("DemoProviderUsageLedger.reconcile(): independent processes racing the same attempt invoke the provider exactly once", async () => {
  const root = temporaryStoreRoot("provider-reconcile-race-processes");
  const storePath = root.pathFor("receipt-journal.db");
  // Create the store file first so every worker opens an initialized store.
  const seed = openBoundDurableStore({
    binding: {
      storeId: "receipt-journal",
      namespace: "namespace-receipt-journal",
      credentialId: "credential-receipt-journal",
      maxEntries: 512,
      path: storePath
    },
    busyTimeoutMs: BUSY_TIMEOUT_MS,
    supportedNodeMajors: SUPPORTED_NODE_MAJORS
  });
  const seedLedger = createDurableDemoProviderUsageLedger({
    substrate: seed,
    signer: harnessSigner,
    clock: fixedClock(),
    resolveUsage: async () => ({
      status: "unknown",
      calls: null,
      tokens: null,
      costUnits: null,
      providerUsageDigest: null
    })
  });
  const attempt = await seedLedger.begin(
    attemptWithoutSignature({ attemptKey: d("attempt-race-processes") })
  );
  seed.close();

  try {
    const workerPath = path.join(
      import.meta.dirname,
      "support",
      "durable-demo-stores-worker.js"
    );
    const request: ProviderUsageWorkerRequest = {
      path: storePath,
      maxEntries: 512,
      busyTimeoutMs: BUSY_TIMEOUT_MS,
      supportedNodeMajors: SUPPORTED_NODE_MAJORS,
      attempt
    };
    const replies = await Promise.all(
      [0, 1, 2, 3, 4, 5].map(
        () =>
          new Promise<ProviderUsageWorkerReply>((resolve, reject) => {
            const child = fork(workerPath, [JSON.stringify(request)], { stdio: "inherit" });
            let reply: ProviderUsageWorkerReply | null = null;
            child.on("message", (message) => {
              reply = message as ProviderUsageWorkerReply;
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

    const totalResolveCalls = replies.reduce((sum, reply) => sum + reply.resolveUsageCalls, 0);
    assert.equal(totalResolveCalls, 1, "exactly one process may invoke the provider");
    assert.deepEqual(
      replies.filter((reply) => reply.outcome === "error"),
      [],
      "no process may observe an unexpected error"
    );
    assert.equal(
      replies.filter((reply) => reply.outcome === "settled").length >= 1,
      true,
      "at least one process must observe the settled usage"
    );
  } finally {
    root.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Capacity propagation
//
// The bounded journal is store-wide (ADR 0014): once a physical store's
// `boundedJournal.maxEntries` is reached, the substrate refuses every later
// write in that store with `CAPACITY_EXHAUSTED`, regardless of namespace.
// None of these adapters catch `DurableSubstrateError` (only the narrower
// `DurableAmbiguousAcknowledgementError`), so a capacity refusal must
// propagate unmodified — never silently downgraded to a success-shaped
// status, and never invoking a side-effecting callback before the write it
// gates is confirmed possible.
// ---------------------------------------------------------------------------

test("DemoActivationClaimStore: capacity exhaustion propagates unmodified", async () => {
  const root = temporaryStoreRoot("activation-claim-capacity");
  const stores = openStoresBounded(root, 1);
  try {
    const store = createDurableDemoActivationClaimStore({
      substrate: stores.operationGrantStore,
      signer: harnessSigner,
      clock: fixedClock()
    });
    const first = await store.claim(activationClaim({ claimKey: d("claim-key-capacity-1") }));
    assert.equal(first.status, "appended");

    await assert.rejects(
      store.claim(activationClaim({ claimKey: d("claim-key-capacity-2") })),
      (error: unknown) => codeOf(error) === "CAPACITY_EXHAUSTED"
    );
  } finally {
    stores.close();
    root.cleanup();
  }
});

test("StageAgentSelectionGrantStore: capacity exhaustion propagates unmodified", async () => {
  const root = temporaryStoreRoot("selection-grant-capacity");
  const stores = openStoresBounded(root, 1);
  try {
    const store = createDurableStageAgentSelectionGrantStore({
      substrate: stores.operationGrantStore
    });
    const first = await store.claim(
      signedStageAgentSelectionGrant({ selectionKey: d("selection-capacity-1") })
    );
    assert.equal(first.status, "appended");

    await assert.rejects(
      store.claim(signedStageAgentSelectionGrant({ selectionKey: d("selection-capacity-2") })),
      (error: unknown) => codeOf(error) === "CAPACITY_EXHAUSTED"
    );
  } finally {
    stores.close();
    root.cleanup();
  }
});

test("DemoDispatchStore: capacity exhaustion propagates unmodified", async () => {
  const root = temporaryStoreRoot("dispatch-capacity");
  const stores = openStoresBounded(root, 1);
  try {
    const store = createDurableDemoDispatchStore({
      substrate: stores.receiptJournal,
      signer: harnessSigner,
      clock: fixedClock(),
      repositoryId: 42,
      workItemNodeId: "WI_demo",
      authorityEpoch: 1,
      generation: 0
    });
    const decisionFor = (contentDigest: `sha256:${string}`) => ({
      apiVersion: "agentic-framework.github.com/v1alpha1" as const,
      kind: "DemoDispatchDecision" as const,
      schemaVersion: "2.0.0" as const,
      contentDigest,
      spec: {
        demoProjectId: PROJECT_ID,
        runStateDigest: d("run-state-capacity"),
        stageId: "framing",
        stageOrdinal: 1,
        action: "run-deterministic" as const,
        runtimeBinding: null,
        selectionGrantDigest: null,
        kernelRouteId: null,
        refusalDigest: null,
        reasonCode: "ready",
        decidedAt: "2026-08-30T12:00:00.000Z"
      }
    });
    const first = await store.persist(decisionFor(d("decision-capacity-1")));
    assert.equal(first.status, "appended");

    await assert.rejects(
      store.persist(decisionFor(d("decision-capacity-2"))),
      (error: unknown) => codeOf(error) === "CAPACITY_EXHAUSTED"
    );
  } finally {
    stores.close();
    root.cleanup();
  }
});

test("DemoStageReceiptStore: capacity exhaustion propagates unmodified", async () => {
  const root = temporaryStoreRoot("stage-receipt-capacity");
  const stores = openStoresBounded(root, 1);
  try {
    const store = createDurableDemoStageReceiptStore({ substrate: stores.receiptJournal });
    const current = runState();
    const receipt = signedStageReceipt({ runStateDigest: current.contentDigest });
    const first = await store.append({
      expectedRunStateDigest: current.contentDigest,
      receipt,
      nextRunState: runState({ currentStageId: "planning" })
    });
    assert.equal(first.status, "appended");

    const otherCurrent = runState({ runAttempt: 2 });
    const otherReceipt = signedStageReceipt({ runStateDigest: otherCurrent.contentDigest });
    await assert.rejects(
      store.append({
        expectedRunStateDigest: otherCurrent.contentDigest,
        receipt: otherReceipt,
        nextRunState: runState({ runAttempt: 2, currentStageId: "planning" })
      }),
      (error: unknown) => codeOf(error) === "CAPACITY_EXHAUSTED"
    );
  } finally {
    stores.close();
    root.cleanup();
  }
});

test("DemoKernelStateStore: capacity exhaustion propagates unmodified", async () => {
  const root = temporaryStoreRoot("kernel-state-capacity");
  const stores = openStoresBounded(root, 1);
  try {
    const genesis = kernelSnapshot();
    const store = createDurableDemoKernelStateStore({
      substrate: stores.runtimeStateStore,
      genesisSnapshot: genesis
    });
    const applied1 = appliedResult({ from: genesis, eventId: "event-capacity-1" });
    const first = await store.persistApplied(applied1);
    assert.equal(first.status, "appended");

    const applied2 = appliedResult({ from: applied1.snapshot, eventId: "event-capacity-2" });
    await assert.rejects(
      store.persistApplied(applied2),
      (error: unknown) => codeOf(error) === "CAPACITY_EXHAUSTED"
    );
  } finally {
    stores.close();
    root.cleanup();
  }
});

test("DemoRunStateStore: capacity exhaustion propagates unmodified", async () => {
  const root = temporaryStoreRoot("run-state-capacity");
  const stores = openStoresBounded(root, 1);
  try {
    const genesis = runState();
    const store = createDurableDemoRunStateStore({
      substrate: stores.runtimeStateStore,
      genesisRunState: genesis
    });
    const next = runState({ currentStageId: "planning" });
    const first = await store.compareAndSwap({
      expectedRunStateDigest: genesis.contentDigest,
      nextRunState: next
    });
    assert.equal(first.status, "appended");

    const advanced = runState({ currentStageId: "execution" });
    await assert.rejects(
      store.compareAndSwap({
        expectedRunStateDigest: next.contentDigest,
        nextRunState: advanced
      }),
      (error: unknown) => codeOf(error) === "CAPACITY_EXHAUSTED"
    );
  } finally {
    stores.close();
    root.cleanup();
  }
});

test("DemoRecoveryBudgetStore: capacity exhaustion propagates unmodified", async () => {
  const root = temporaryStoreRoot("recovery-budget-capacity");
  const stores = openStoresBounded(root, 1);
  try {
    const genesis = budgetState();
    const store = createDurableDemoRecoveryBudgetStore({
      substrate: stores.runtimeStateStore,
      signer: harnessSigner,
      genesisBudget: genesis
    });
    const next = budgetState({ generation: 1, retries: 1, ledgerVersion: 1 });
    const evidence = recoveryEvidence({
      budgetBeforeDigest: genesis.contentDigest,
      budgetAfterDigest: next.contentDigest,
      kernelReceiptDigest: d("kernel-receipt-capacity-1")
    });
    const first = await store.record({ expected: genesis, next, evidence });
    assert.equal(first.status, "appended");

    const next2 = budgetState({ generation: 2, retries: 1, ledgerVersion: 2 });
    const evidence2 = recoveryEvidence({
      budgetBeforeDigest: next.contentDigest,
      budgetAfterDigest: next2.contentDigest,
      kernelReceiptDigest: d("kernel-receipt-capacity-2")
    });
    await assert.rejects(
      store.record({ expected: next, next: next2, evidence: evidence2 }),
      (error: unknown) => codeOf(error) === "CAPACITY_EXHAUSTED"
    );
  } finally {
    stores.close();
    root.cleanup();
  }
});

test("DemoProviderUsageLedger.begin(): capacity exhaustion propagates unmodified", async () => {
  const root = temporaryStoreRoot("provider-begin-capacity");
  const stores = openStoresBounded(root, 1);
  try {
    const store = createDurableDemoProviderUsageLedger({
      substrate: stores.receiptJournal,
      signer: harnessSigner,
      clock: fixedClock(),
      resolveUsage: async () => ({
        status: "unknown",
        calls: null,
        tokens: null,
        costUnits: null,
        providerUsageDigest: null
      })
    });
    const first = await store.begin(
      attemptWithoutSignature({ attemptKey: d("attempt-begin-capacity-1") })
    );
    assert.ok(first);

    await assert.rejects(
      store.begin(attemptWithoutSignature({ attemptKey: d("attempt-begin-capacity-2") })),
      (error: unknown) => codeOf(error) === "CAPACITY_EXHAUSTED"
    );
  } finally {
    stores.close();
    root.cleanup();
  }
});

test("DemoProviderUsageLedger.reconcile(): capacity exhaustion on the claim write propagates and never invokes the provider", async () => {
  const root = temporaryStoreRoot("provider-reconcile-capacity");
  // One begin() (1 entry) plus one full reconcile() (claim + usage = 2
  // entries) for the first attempt, plus a second attempt's begin() (1 more
  // entry), exactly fills a 4-entry store; capacity is then exhausted
  // before the second attempt's own claim write can land.
  const stores = openStoresBounded(root, 4);
  try {
    let resolveCalls = 0;
    const store = createDurableDemoProviderUsageLedger({
      substrate: stores.receiptJournal,
      signer: harnessSigner,
      clock: fixedClock(),
      resolveUsage: async () => {
        resolveCalls += 1;
        return {
          status: "settled",
          calls: 1,
          tokens: 10,
          costUnits: 1,
          providerUsageDigest: d("provider-usage-capacity")
        };
      }
    });

    const attempt1 = await store.begin(
      attemptWithoutSignature({ attemptKey: d("attempt-capacity-1") })
    );
    const usage1 = await store.reconcile(attempt1);
    assert.equal(usage1.status, "settled");
    assert.equal(resolveCalls, 1);

    const attempt2 = await store.begin(
      attemptWithoutSignature({ attemptKey: d("attempt-capacity-2") })
    );
    // The store is now exactly full (4 entries): attempt2's own claim write
    // (a fifth entry) must itself refuse before ever consulting the
    // provider, rather than silently making room.
    await assert.rejects(
      store.reconcile(attempt2),
      (error: unknown) => codeOf(error) === "CAPACITY_EXHAUSTED"
    );
    assert.equal(resolveCalls, 1, "capacity exhaustion must never invoke the provider");
  } finally {
    stores.close();
    root.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Corrupt and foreign records
//
// A durable body that no longer re-derives its recorded digest is refused
// as `STORE_CORRUPT` by the substrate itself (`decodeCanonicalBytes`); these
// adapters add no defense of their own and must not conceal or downgrade
// that refusal, whether observed through a direct keyed `read()` or through
// a journal scan (`DemoStageReceiptStore.read()` uses `verifyChain`).
// ---------------------------------------------------------------------------

/**
 * Flips a distinctive, byte-length-preserving marker already present in a
 * durable record's canonical JSON on disk, so the row still reads back but
 * can no longer re-derive its recorded digest — the same technique
 * `tests/durable-substrate.test.ts` uses at the substrate layer, applied
 * here through each adapter's own `read()`/`verifyChain()` path.
 */
function corruptOnDisk(storePath: string, needleValue: string, replacementValue: string): void {
  assert.equal(needleValue.length, replacementValue.length, "corruption must preserve byte length");
  const raw = readFileSync(storePath);
  const needle = Buffer.from(`"${needleValue}"`, "utf8");
  const at = raw.indexOf(needle);
  assert.ok(at > 0, `expected "${needleValue}" to be present on disk`);
  raw.write(`"${replacementValue}"`, at, "utf8");
  writeFileSync(storePath, raw);
}

test("DemoActivationClaimStore: a corrupted durable record surfaces on read, never concealed", async () => {
  const root = temporaryStoreRoot("activation-claim-corrupt");
  const claim = activationClaim({ claimKey: d("claim-key-corrupt") });
  const stores = openStores(root);
  try {
    const store = createDurableDemoActivationClaimStore({
      substrate: stores.operationGrantStore,
      signer: harnessSigner,
      clock: fixedClock()
    });
    const result = await store.claim(claim);
    assert.equal(result.status, "appended");
  } finally {
    stores.close();
  }

  corruptOnDisk(root.pathFor("operation-grant-store.db"), "WI_demo", "WI_XXXX");

  const reopened = openStores(root);
  try {
    const store = createDurableDemoActivationClaimStore({
      substrate: reopened.operationGrantStore,
      signer: harnessSigner,
      clock: fixedClock()
    });
    await assert.rejects(
      store.read(claim.claimKey),
      (error: unknown) => codeOf(error) === "STORE_CORRUPT"
    );
  } finally {
    reopened.close();
    root.cleanup();
  }
});

test("DemoRunStateStore: a corrupted durable record surfaces on read, never concealed", async () => {
  const root = temporaryStoreRoot("run-state-corrupt");
  const genesis = runState();
  const next = runState({ currentStageId: "planning" });
  const stores = openStores(root);
  try {
    const store = createDurableDemoRunStateStore({
      substrate: stores.runtimeStateStore,
      genesisRunState: genesis
    });
    const result = await store.compareAndSwap({
      expectedRunStateDigest: genesis.contentDigest,
      nextRunState: next
    });
    assert.equal(result.status, "appended");
  } finally {
    stores.close();
  }

  corruptOnDisk(root.pathFor("runtime-state-store.db"), "WI_demo", "WI_XXXX");

  const reopened = openStores(root);
  try {
    const store = createDurableDemoRunStateStore({
      substrate: reopened.runtimeStateStore,
      genesisRunState: genesis
    });
    await assert.rejects(
      store.read(),
      (error: unknown) => codeOf(error) === "STORE_CORRUPT"
    );
  } finally {
    reopened.close();
    root.cleanup();
  }
});

test("DemoStageReceiptStore: a corrupted durable record surfaces during journal scan, never concealed", async () => {
  const root = temporaryStoreRoot("stage-receipt-corrupt");
  const current = runState();
  const receipt = signedStageReceipt({ runStateDigest: current.contentDigest });
  const stores = openStores(root);
  try {
    const store = createDurableDemoStageReceiptStore({ substrate: stores.receiptJournal });
    const result = await store.append({
      expectedRunStateDigest: current.contentDigest,
      receipt,
      nextRunState: runState({ currentStageId: "planning" })
    });
    assert.equal(result.status, "appended");
  } finally {
    stores.close();
  }

  corruptOnDisk(root.pathFor("receipt-journal.db"), "WI_demo", "WI_XXXX");

  const reopened = openStores(root);
  try {
    const store = createDurableDemoStageReceiptStore({ substrate: reopened.receiptJournal });
    await assert.rejects(
      store.read(receipt.contentDigest),
      (error: unknown) => codeOf(error) === "STORE_CORRUPT"
    );
  } finally {
    reopened.close();
    root.cleanup();
  }
});

test("DemoActivationClaimStore and StageAgentSelectionGrantStore never collide on a shared physical store, even under the same logical identifier", async () => {
  const root = temporaryStoreRoot("cross-port-isolation");
  const stores = openStores(root);
  try {
    // Adversarially pick the exact same digest as both the activation
    // claim's claimKey and the selection grant's selectionKey: only the
    // adapter's own namespace prefix keeps these independent.
    const sharedIdentifier = d("shared-identifier");
    const claimStore = createDurableDemoActivationClaimStore({
      substrate: stores.operationGrantStore,
      signer: harnessSigner,
      clock: fixedClock()
    });
    const grantStore = createDurableStageAgentSelectionGrantStore({
      substrate: stores.operationGrantStore
    });

    const claim = activationClaim({ claimKey: sharedIdentifier });
    const grant = signedStageAgentSelectionGrant({ selectionKey: sharedIdentifier });

    const claimResult = await claimStore.claim(claim);
    const grantResult = await grantStore.claim(grant);
    assert.equal(claimResult.status, "appended");
    assert.equal(grantResult.status, "appended");

    const readClaim = await claimStore.read(sharedIdentifier);
    const readGrant = await grantStore.read(sharedIdentifier);
    assert.deepEqual(readClaim, claimResult.receipt);
    assert.deepEqual(readGrant, grant);
    assert.notEqual(canonicalJson(readClaim), canonicalJson(readGrant));
  } finally {
    stores.close();
    root.cleanup();
  }
});
