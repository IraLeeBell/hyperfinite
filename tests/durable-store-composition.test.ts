/**
 * Complete synthetic durable-store path and restart/fault evidence for issue
 * Unlike the older simulator fakes, this path opens all fifteen adapters
 * through one exact DeploymentTopologyPlan and persists every authority-bearing
 * boundary in the four plan-bound stores.
 */

import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync
} from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { canonicalJson, digest } from "../src/canonical.js";
import type {
  DemoActivationClaim,
  DemoRecoveryBudgetEvidence
} from "../src/demo-activation.js";
import { DemoActivationClaimAmbiguousError } from "../src/demo-activation.js";
import { createDemoContract } from "../src/demo-portfolio.js";
import {
  createDemoBudgetState,
  demoBudgetAuthorityDigest,
  type DemoBudgetState
} from "../src/demo-runtime-state.js";
import type {
  DemoBudgetReservationEvidence,
  DemoBudgetSettlementEvidence,
  DemoProviderAttemptEvidence
} from "../src/demo-scheduler.js";
import type {
  DemoDispatchDecision,
  DemoRunFence,
  DemoRunState,
  SignedStageAgentSelectionGrant,
  SignedStageReceipt
} from "../src/demo-types.js";
import {
  DeploymentTopologyValidationError,
  DURABLE_STORE_IDS,
  type DeploymentTopologyPlan,
  type DurableStoreId
} from "../src/deployment-topology.js";
import type {
  DomainDetachedSignature,
  DomainEvidenceSigner
} from "../src/domain-packs.js";
import {
  DURABLE_ADAPTER_STORE_MAPPING,
  DurableStoreCompositionError,
  openDurableStoreComposition,
  type DurableBackupQuiescenceEvidence,
  type DurableStoreComposition,
  type DurableStoreCompositionInput
} from "../src/durable-store-composition.js";
import {
  DurableEngineeringStoreError
} from "../src/durable-engineering-stores.js";
import {
  DurableSubstrateError
} from "../src/durable-substrate.js";
import type {
  DetachedSignature,
  EngineeringCostReservation,
  EngineeringEffectEvidence,
  EngineeringProviderAttempt,
  EvidenceSigner
} from "../src/engineering-slice.js";
import type {
  Digest,
  KernelResult,
  KernelSnapshot
} from "../src/types.js";
import { assertDocument, validateDocument } from "../src/validation.js";
import {
  BUSY_TIMEOUT_MS,
  SUPPORTED_NODE_MAJORS,
  fixedClock,
  harnessSignature,
  harnessSigner,
  harnessVerifier,
  storePathsFor,
  temporaryStoreRoot
} from "./support/durable-substrate-harness.js";

const NOW = "2026-08-30T12:00:00.000Z";
const LATER = "2026-08-30T12:10:00.000Z";
const EXPIRES = "2026-08-30T18:00:00.000Z";
const REPOSITORY_ID = 42;
const WORK_ITEM_NODE_ID = "WI_demo";
const PHASE_BUDGETS = { framing: 10, execution: 20, verification: 6 } as const;
const PHASE_TOKEN_BUDGETS = {
  framing: 100,
  execution: 400,
  verification: 60
} as const;

const RESTART_BOUNDARIES = [
  "activation-claim",
  "selection-grant",
  "dispatch",
  "fence-acquire",
  "demo-budget-reserve",
  "demo-provider-usage",
  "demo-budget-settle",
  "kernel-state",
  "stage-receipt",
  "run-state",
  "recovery-budget",
  "fence-release",
  "domain-grant",
  "engineering-reservation",
  "engineering-hold",
  "engineering-attempt",
  "engineering-usage",
  "engineering-settlement",
  "engineering-release",
  "single-writer-evidence",
  "engineering-checkpoint"
] as const;

type RestartBoundary = (typeof RESTART_BOUNDARIES)[number];
type Root = ReturnType<typeof temporaryStoreRoot>;

function d(label: string): Digest {
  return digest(label);
}

function topologyPlan(): DeploymentTopologyPlan {
  return assertDocument(
    "DeploymentTopologyPlan",
    JSON.parse(
      readFileSync(
        path.join(process.cwd(), "examples", "pre-app", "deployment-topology.json"),
        "utf8"
      )
    )
  );
}

function topologyPlanWithBound(
  storeId: DurableStoreId,
  maxEntries: number
): DeploymentTopologyPlan {
  const plan = topologyPlan();
  return {
    ...plan,
    durableStores: plan.durableStores.map((store) =>
      store.storeId === storeId
        ? {
            ...store,
            atomicGuarantees: {
              ...store.atomicGuarantees,
              boundedJournal: {
                ...store.atomicGuarantees.boundedJournal,
                maxEntries
              }
            }
          }
        : store
    )
  };
}

function kernelSnapshot(overrides: {
  readonly stateVersion?: number;
  readonly receiptHead?: Digest | null;
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

function coreBinding(state: "FRAMING" | "PLANNED") {
  return {
    state,
    stateVersion: state === "FRAMING" ? 1 : 2,
    bindingDigest: d("binding"),
    lifecycleGraphDigest: d("lifecycle-graph"),
    workAccordDigest: d("work-accord"),
    capabilityRegistryDigest: d("capability-registry"),
    domainPackDigest: d("domain-pack"),
    phaseContractDigest: d("phase-contract"),
    compiledPolicyDigest: d("compiled-policy"),
    policyDigest: d("policy"),
    kernelReceiptDigest: state === "FRAMING" ? null : d("kernel-receipt:advance"),
    kernelSnapshotDigest: d(`kernel-snapshot:${state}`)
  } as const;
}

function runState(overrides: Partial<DemoRunState["spec"]> = {}): DemoRunState {
  return createDemoContract("DemoRunState", {
    demoProjectId: "feature-delivery",
    catalogDigest: d("catalog"),
    identityReservationsDigest: d("identity-reservations"),
    projectProfileDigest: d("profile"),
    journeyDefinitionDigest: d("journey"),
    stageAgentBindingsDigest: d("bindings"),
    capabilityShardDigest: d("capability-shard"),
    activationProfileDigest: d("activation-profile"),
    projectionMappingDigest: d("projection-mapping"),
    repositoryId: REPOSITORY_ID,
    workItemNodeId: WORK_ITEM_NODE_ID,
    repositoryBindingDigest: d("repository-binding"),
    authorityEpoch: 1,
    generation: 0,
    runId: "run-1",
    runAttempt: 1,
    core: coreBinding("FRAMING"),
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
    updatedAt: NOW,
    ...overrides
  });
}

function budgetState(overrides: Partial<DemoBudgetState["spec"]> = {}): DemoBudgetState {
  return createDemoBudgetState({
    demoProjectId: "feature-delivery",
    repositoryId: REPOSITORY_ID,
    workItemNodeId: WORK_ITEM_NODE_ID,
    authorityEpoch: 1,
    generation: 0,
    activationLeaseDigest: d("activation-lease"),
    workAccordDigest: d("work-accord"),
    limits: {
      maxCalls: 10,
      maxTokens: 10_000,
      maxCostUnits: 100,
      maxDurationMs: 60_000,
      maxRetries: 3,
      maxParallel: 1
    },
    usage: { calls: 0, tokens: 0, costUnits: 0, retries: 0 },
    held: { calls: 0, tokens: 0, costUnits: 0 },
    startedAt: NOW,
    expiresAt: EXPIRES,
    ledgerVersion: 0,
    ledgerHead: null,
    ...overrides
  });
}

function domainSignature(
  payload: unknown,
  purpose: string
): DomainDetachedSignature {
  return {
    algorithm: "ed25519",
    keyId: "durable:key-1",
    value: Buffer.from(digest({ payload, purpose }), "utf8").toString("base64url")
  };
}

const domainSigner: DomainEvidenceSigner = {
  sign: (payload, purpose) => domainSignature(payload, purpose)
};

const engineeringSigner: EvidenceSigner = {
  sign: async (payload): Promise<DetachedSignature> => harnessSignature(payload)
};

function backupQuiescenceEvidence(
  topologyDigest: Digest,
  writerGeneration = 7,
  observedAt = NOW,
  expiresAt = EXPIRES
): DurableBackupQuiescenceEvidence {
  const payload = {
    schemaVersion: "1.0.0" as const,
    topologyDigest,
    writerDisabled: true as const,
    writerGeneration,
    checkpointDigest: d(`backup-checkpoint:${String(writerGeneration)}`),
    observedAt,
    expiresAt
  };
  return { ...payload, signature: harnessSignature(payload) };
}

function compositionInput(
  storePaths: Readonly<Record<DurableStoreId, string>>,
  overrides: {
    readonly plan?: DeploymentTopologyPlan;
    readonly totalBudgetCostUnits?: number;
    readonly providerUsage?: {
      readonly actualCostUnits: number;
      readonly actualCalls: number;
      readonly actualTokens: number;
      readonly providerUsageDigest: Digest;
    } | null;
    readonly backupQuiescence?: (
      topologyDigest: Digest
    ) => DurableBackupQuiescenceEvidence;
  } = {}
): DurableStoreCompositionInput {
  const clock = fixedClock(NOW);
  const plan = overrides.plan ?? topologyPlan();
  return {
    plan,
    storePaths,
    busyTimeoutMs: BUSY_TIMEOUT_MS,
    supportedNodeMajors: SUPPORTED_NODE_MAJORS,
    demo: {
      signer: harnessSigner,
      verifier: harnessVerifier,
      clock,
      genesisKernelSnapshot: kernelSnapshot(),
      genesisRunState: runState(),
      genesisRecoveryBudget: budgetState(),
      genesisBudget: budgetState(),
      dispatch: {
        repositoryId: REPOSITORY_ID,
        workItemNodeId: WORK_ITEM_NODE_ID,
        authorityEpoch: 1,
        generation: 0
      },
      resolveProviderUsage: async (attempt) => ({
        status: "settled",
        calls: 1,
        tokens: 80,
        costUnits: 8,
        providerUsageDigest: digest({ attemptDigest: digest(attempt) })
      })
    },
    domain: {
      clock,
      signer: domainSigner,
      headValidityMs: 60_000
    },
    engineering: {
      signer: engineeringSigner,
      providerUsageObserver: {
        observe: async () =>
          overrides.providerUsage === undefined
            ? {
                actualCostUnits: 4,
                actualCalls: 1,
                actualTokens: 40,
                providerUsageDigest: d("engineering-provider-usage")
              }
            : overrides.providerUsage
      },
      totalBudgetCostUnits: overrides.totalBudgetCostUnits ?? 100
    },
    backup: {
      guard: {
        read: async ({ topologyDigest }) =>
          overrides.backupQuiescence?.(topologyDigest) ??
          backupQuiescenceEvidence(topologyDigest)
      },
      clock,
      signer: harnessSigner,
      verifier: harnessVerifier
    }
  };
}

function backupRootFor(
  root: Root,
  prefix = "backup"
): string {
  return root.pathFor(prefix);
}

function activationClaim(
  claimKey = d("activation-claim"),
  revocationGeneration = 0
): DemoActivationClaim {
  return {
    schemaVersion: "1.0.0",
    claimKey,
    demoProjectId: "feature-delivery",
    repositoryId: REPOSITORY_ID,
    workItemNodeId: WORK_ITEM_NODE_ID,
    authorityEpoch: 1,
    generation: 0,
    revocationGeneration,
    sourceEventDigest: d("source-event"),
    submitterId: 101,
    consentDigest: d("consent"),
    activationProfileDigest: d("activation-profile"),
    activationLeaseDigest: d("activation-lease"),
    activationLeaseEvidenceDigest: d("activation-lease-evidence"),
    budgetAuthorityDigest: d("budget-authority"),
    recoveryBudgetEvidenceDigest: null,
    runStateDigest: runState().contentDigest,
    claimedAt: NOW
  };
}

function selectionGrant(
  selectionKey: Digest,
  receiptHead: Digest
): SignedStageAgentSelectionGrant {
  const spec: SignedStageAgentSelectionGrant["spec"] = {
    demoProjectId: "feature-delivery",
    stageId: "execution",
    selectionKey,
    optionKey: "agent-a",
    projectNodeId: "PROJECT_demo",
    projectItemNodeId: "ITEM_demo",
    projectBindingDigest: d("project-binding"),
    repositoryId: REPOSITORY_ID,
    workItemNodeId: WORK_ITEM_NODE_ID,
    authorityEpoch: 1,
    generation: 0,
    runId: "run-1",
    runAttempt: 1,
    receiptHead,
    pullRequestHeadSha: null,
    policyGeneration: 1,
    selectionPolicyDigest: d("selection-policy"),
    stageAgentBindingsDigest: d("bindings"),
    workAccordDigest: d("work-accord"),
    phaseContractDigest: d("phase-contract"),
    capabilityRegistryDigest: d("capability-registry"),
    activationLeaseDigest: d("activation-lease"),
    budgetAuthorityDigest: d("budget-authority"),
    agentId: "agent-a",
    skillId: "skill-a",
    capabilityId: "capability-a@1.0.0",
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
    issuedAt: NOW,
    expiresAt: EXPIRES
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

function dispatchDecision(
  source: DemoRunState,
  selectionGrantDigest: Digest
): DemoDispatchDecision {
  return createDemoContract("DemoDispatchDecision", {
    demoProjectId: "feature-delivery",
    runStateDigest: source.contentDigest,
    stageId: "framing",
    stageOrdinal: 1,
    action: "invoke-model",
    runtimeBinding: {
      agentId: "agent-a",
      capabilityId: "capability-a@1.0.0",
      workflowId: "workflow-a"
    },
    selectionGrantDigest,
    kernelRouteId: null,
    refusalDigest: null,
    reasonCode: "READY",
    decidedAt: NOW
  });
}

function acquiredFence(
  source: DemoRunState,
  decision: DemoDispatchDecision
): DemoRunFence {
  return createDemoContract("DemoRunFence", {
    demoProjectId: "feature-delivery",
    repositoryId: REPOSITORY_ID,
    workItemNodeId: WORK_ITEM_NODE_ID,
    fenceKey: digest({
      repositoryId: REPOSITORY_ID,
      workItemNodeId: WORK_ITEM_NODE_ID
    }),
    authorityEpoch: 1,
    generation: 0,
    runId: "run-1",
    runAttempt: 1,
    runStateDigest: source.contentDigest,
    dispatchDecisionDigest: decision.contentDigest,
    holderDigest: d("holder"),
    activationLeaseDigest: d("activation-lease"),
    previousFenceDigest: null,
    status: "acquired",
    acquiredAt: NOW,
    expiresAt: EXPIRES,
    releasedAt: null
  });
}

function budgetAfterReserve(source: DemoBudgetState): DemoBudgetState {
  return createDemoBudgetState({
    ...source.spec,
    held: { calls: 1, tokens: 100, costUnits: 10 },
    ledgerVersion: 1,
    ledgerHead: digest({
      previousHead: source.spec.ledgerHead,
      operation: "reserve",
      calls: 1,
      tokens: 100,
      costUnits: 10
    })
  });
}

function budgetAfterSettle(
  reserved: DemoBudgetState
): DemoBudgetState {
  return createDemoBudgetState({
    ...reserved.spec,
    usage: { calls: 1, tokens: 80, costUnits: 8, retries: 0 },
    held: { calls: 0, tokens: 0, costUnits: 0 },
    ledgerVersion: 2,
    ledgerHead: digest({
      previousHead: reserved.spec.ledgerHead,
      operation: "settle",
      calls: 1,
      tokens: 80,
      costUnits: 8
    })
  });
}

function reservationEvidence(
  before: DemoBudgetState,
  after: DemoBudgetState,
  decision: DemoDispatchDecision
): Omit<DemoBudgetReservationEvidence, "signature"> {
  return {
    schemaVersion: "1.0.0",
    reservationKey: digest({
      operation: "reserve-demo-stage-cost",
      budgetStateDigest: before.contentDigest
    }),
    budgetBeforeDigest: before.contentDigest,
    budgetAfterDigest: after.contentDigest,
    dispatchDecisionDigest: decision.contentDigest,
    stageId: "framing",
    runtimeBinding: {
      agentId: "agent-a",
      capabilityId: "capability-a@1.0.0",
      workflowId: "workflow-a"
    },
    calls: 1,
    tokens: 100,
    costUnits: 10,
    reservedAt: NOW,
    expiresAt: after.spec.expiresAt
  };
}

function settlementEvidence(
  before: DemoBudgetState,
  after: DemoBudgetState,
  reservation: DemoBudgetReservationEvidence,
  providerUsageDigest: Digest
): Omit<DemoBudgetSettlementEvidence, "signature"> {
  return {
    schemaVersion: "1.0.0",
    reservationDigest: digest(reservation),
    usageDigest: providerUsageDigest,
    budgetBeforeDigest: before.contentDigest,
    budgetAfterDigest: after.contentDigest,
    calls: 1,
    tokens: 80,
    costUnits: 8,
    settledAt: LATER
  };
}

function demoProviderAttempt(
  reservationDigest: Digest,
  fenceDigest: Digest
): Omit<DemoProviderAttemptEvidence, "signature"> {
  return {
    schemaVersion: "1.0.0",
    attemptKey: d("demo-provider-attempt"),
    reservationDigest,
    fenceDigest,
    demoProjectId: "feature-delivery",
    repositoryId: REPOSITORY_ID,
    workItemNodeId: WORK_ITEM_NODE_ID,
    authorityEpoch: 1,
    generation: 0,
    runId: "run-1",
    runAttempt: 1,
    stageId: "framing",
    runtimeBinding: {
      agentId: "agent-a",
      capabilityId: "capability-a",
      workflowId: "workflow-a"
    },
    startedAt: NOW,
    expiresAt: EXPIRES
  };
}

function appliedKernelResult(
  source: KernelSnapshot
): Extract<KernelResult, { kind: "applied" }> {
  const receiptDigest = d("kernel-receipt:advance");
  const snapshot = kernelSnapshot({
    stateVersion: source.stateVersion + 1,
    receiptHead: receiptDigest
  });
  return {
    kind: "applied",
    route: {
      id: "route-1",
      event: "advance",
      from: "FRAMING",
      to: "FRAMING"
    } as never,
    snapshot,
    receipt: {
      schemaVersion: "1.0.0",
      eventId: "event-advance",
      eventDigest: d("event-advance"),
      routeId: "route-1",
      routeVersion: "1.0.0",
      from: "FRAMING",
      to: "FRAMING",
      stateVersion: snapshot.stateVersion,
      previousReceipt: source.receiptHead,
      idempotencyKey: d("idempotency-advance"),
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
      occurredAt: NOW,
      effectPlanDigest: d("effect-plan")
    },
    receiptDigest,
    effects: []
  };
}

function stageReceipt(
  source: DemoRunState,
  nextCore: ReturnType<typeof coreBinding>,
  fence: DemoRunFence
): SignedStageReceipt {
  const spec: SignedStageReceipt["spec"] = {
    demoProjectId: "feature-delivery",
    projectProfileDigest: d("profile"),
    journeyDefinitionDigest: d("journey"),
    stageAgentBindingsDigest: d("bindings"),
    authorityEpoch: 1,
    generation: 0,
    runId: "run-1",
    runAttempt: 1,
    runStateDigest: source.contentDigest,
    stageId: "framing",
    stageOrdinal: 1,
    nextStageId: "planning",
    nextStageOrdinal: 2,
    previousStageReceiptDigest: null,
    artifactEnvelopeDigest: d("artifact"),
    runFenceDigest: fence.contentDigest,
    releasedRunFenceDigest: null,
    coreBefore: coreBinding("FRAMING"),
    coreAfter: nextCore,
    kernelTransitionReceiptDigest: d("kernel-receipt:advance"),
    appliedKernelResultDigest: d("applied-kernel-result"),
    outcome: "completed",
    completedAt: LATER
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

function recoveryEvidence(
  before: DemoBudgetState,
  after: DemoBudgetState
): Omit<DemoRecoveryBudgetEvidence, "signature"> {
  return {
    schemaVersion: "1.0.0",
    budgetBeforeDigest: before.contentDigest,
    budgetAfterDigest: after.contentDigest,
    kernelReceiptDigest: d("kernel-receipt:advance"),
    runStateDigest: d("run-state-recovery"),
    generationBefore: 0,
    generationAfter: 1,
    retriesBefore: 0,
    retriesAfter: 1,
    recordedAt: LATER
  };
}

function effectEvidence(): EngineeringEffectEvidence {
  const payload = {
    sequence: 1,
    previousEvidenceDigest: null,
    effectKey: d("single-writer-effect"),
    effectOrdinal: 1,
    effectType: "create-branch" as const,
    workflowId: "workflow-1",
    contractRevision: 1,
    planDigest: d("effect-plan"),
    bindingDigest: d("binding"),
    state: "completed" as const,
    effectDigest: d("effect-result"),
    createdAt: NOW,
    updatedAt: LATER
  };
  return { ...payload, signature: harnessSignature(payload) };
}

function engineeringReleaseKey(
  reservation: EngineeringCostReservation,
  settlementDigests: readonly Digest[]
): Digest {
  return digest({
    operation: "release-engineering-reservation",
    reservation: digest(reservation),
    settlements: settlementDigests
  });
}

function reconciliationExpiry(expiresAt: string): string {
  return new Date(Date.parse(expiresAt) + 24 * 60 * 60 * 1_000).toISOString();
}

async function observeScenario(composition: DurableStoreComposition) {
  const claim = activationClaim();
  const selectionKey = d("selection-key");
  const activation =
    await composition.adapters.demoActivationClaims.read(claim.claimKey);
  const grant =
    await composition.adapters.stageAgentSelectionGrants.read(selectionKey);
  assert.ok(activation);
  assert.ok(grant);
  const decision = dispatchDecision(runState(), grant.contentDigest);
  const fence = acquiredFence(runState(), decision);
  const fenceKey = digest({
    repositoryId: REPOSITORY_ID,
    workItemNodeId: WORK_ITEM_NODE_ID
  });
  const checkpoint = {
    schemaVersion: "1.1.0",
    workflowId: "workflow-1",
    bindingDigest: d("binding"),
    stage: "awaiting-human-merge"
  };
  const dispatch =
    await composition.adapters.demoDispatch.read(decision.contentDigest);
  const storedFence = await composition.adapters.demoRunFences.read(fenceKey);
  const storedStageReceipt =
    await composition.adapters.demoStageReceipts.read(
      stageReceipt(runState(), coreBinding("PLANNED"), fence).contentDigest
    );
  const storedEvidence =
    await composition.adapters.engineeringEvidence.read(d("single-writer-effect"));
  const storedCheckpoint =
    await composition.adapters.engineeringClosureCheckpoints.read(
      digest(checkpoint)
    );
  const costChain =
    await composition.stores["runtime-state-store"].verifyChain(
      "engineering.cost-ledger"
    );
  assert.ok(dispatch);
  assert.ok(storedFence);
  assert.ok(storedStageReceipt);
  assert.ok(storedEvidence);
  assert.ok(storedCheckpoint);
  assert.ok(costChain.length > 0);
  return {
    activation,
    selection: grant,
    dispatch,
    fence: storedFence,
    demoBudget: await composition.adapters.demoBudget.read(),
    kernel: await composition.adapters.demoKernelState.read(),
    runState: await composition.adapters.demoRunState.read(),
    recoveryBudget: await composition.adapters.demoRecoveryBudget.read(),
    stageReceipt: storedStageReceipt,
    domainHead: await composition.adapters.domainOperationGrants.readHead({
      storeId: "operation-grant-store",
      challenge: d("observation-challenge")
    }),
    engineeringEvidence: storedEvidence,
    checkpoint: storedCheckpoint,
    costChain
  };
}

async function assertActualAdapterMapping(
  composition: DurableStoreComposition
): Promise<void> {
  const activation = await composition.adapters.demoActivationClaims.read(
    activationClaim().claimKey
  );
  const selection = await composition.adapters.stageAgentSelectionGrants.read(
    d("selection-key")
  );
  assert.ok(activation);
  assert.ok(selection);
  const decision = dispatchDecision(runState(), selection.contentDigest);
  const fence = acquiredFence(runState(), decision);
  const namespaceByPort: Readonly<Record<
    (typeof DURABLE_ADAPTER_STORE_MAPPING)[number]["port"],
    string
  >> = {
    DemoActivationClaimStore: `demo-activation-claim:${activationClaim().claimKey}`,
    StageAgentSelectionGrantStore:
      `demo-stage-agent-selection-grant:${d("selection-key")}`,
    DomainOperationGrantStore: "domain.operation-grant-claims",
    DemoDispatchStore: `demo-dispatch:${decision.contentDigest}`,
    DemoStageReceiptStore: "demo-stage-receipt",
    DemoProviderUsageLedger:
      `demo-provider-attempt:${d("demo-provider-attempt")}`,
    EngineeringProviderUsageLedger: "engineering.provider-usage",
    DemoKernelStateStore: "demo-kernel-state",
    DemoRunStateStore: "demo-run-state",
    DemoRunFenceStore: fence.spec.fenceKey,
    DemoBudgetLedger: demoBudgetAuthorityDigest(budgetState()),
    DemoRecoveryBudgetStore: "demo-recovery-budget",
    EngineeringCostLedger: "engineering.cost-ledger",
    EngineeringEvidenceStore:
      `engineering.effect-evidence.${d("single-writer-effect")}`,
    EngineeringClosureCheckpointStore: "engineering.closure-checkpoints"
  };
  const inventories = new Map(
    await Promise.all(
      DURABLE_STORE_IDS.map(async (storeId) => [
        storeId,
        new Set(
          (
            await composition.stores[storeId].inventory()
          ).namespaces.map((entry) => entry.namespace)
        )
      ] as const)
    )
  );
  for (const mapping of DURABLE_ADAPTER_STORE_MAPPING) {
    const namespace = namespaceByPort[mapping.port];
    assert.equal(
      inventories.get(mapping.storeId)?.has(namespace),
      true,
      `${mapping.port} did not write to ${mapping.storeId}`
    );
    for (const otherStoreId of DURABLE_STORE_IDS) {
      if (otherStoreId === mapping.storeId) continue;
      assert.equal(
        inventories.get(otherStoreId)?.has(namespace),
        false,
        `${mapping.port} namespace leaked into ${otherStoreId}`
      );
    }
  }
}

async function runCompleteScenario(
  root: Root,
  restartAfter: RestartBoundary | null
): Promise<{
  readonly composition: DurableStoreComposition;
  readonly input: DurableStoreCompositionInput;
  readonly summary: unknown;
}> {
  const paths = storePathsFor(root);
  const input = compositionInput(paths);
  let composition = openDurableStoreComposition(input);
  const restarted: string[] = [];
  const maybeRestart = (boundary: RestartBoundary): void => {
    if (restartAfter !== boundary) return;
    composition.close();
    composition = openDurableStoreComposition(input);
    restarted.push(boundary);
  };

  const sourceRunState = runState();
  const activation = activationClaim();
  const activationResult =
    await composition.adapters.demoActivationClaims.claim(activation);
  assert.equal(activationResult.status, "appended");
  assert.ok(activationResult.receipt);
  maybeRestart("activation-claim");

  const selectionKey = d("selection-key");
  const grant = selectionGrant(selectionKey, activationResult.receipt.head);
  const selectionResult =
    await composition.adapters.stageAgentSelectionGrants.claim(grant);
  assert.equal(selectionResult.status, "appended");
  maybeRestart("selection-grant");

  const decision = dispatchDecision(sourceRunState, grant.contentDigest);
  const dispatchResult = await composition.adapters.demoDispatch.persist(decision);
  assert.equal(dispatchResult.status, "appended");
  assert.ok(dispatchResult.receipt);
  maybeRestart("dispatch");

  const fence = acquiredFence(sourceRunState, decision);
  const runningState = runState({
    status: "running",
    fenceDigest: fence.contentDigest,
    fenceBaseRunStateDigest: sourceRunState.contentDigest,
    updatedAt: LATER
  });
  const acquired = await composition.adapters.demoRunFences.acquire({
    expectedRunStateDigest: sourceRunState.contentDigest,
    fence,
    runningState
  });
  assert.equal(acquired.status, "appended");
  maybeRestart("fence-acquire");

  const initialBudget = budgetState();
  const reservedBudget = budgetAfterReserve(initialBudget);
  const reservationPayload = reservationEvidence(
    initialBudget,
    reservedBudget,
    decision
  );
  const demoReservation = await composition.adapters.demoBudget.reserve({
    expected: initialBudget,
    next: reservedBudget,
    evidence: reservationPayload
  });
  assert.equal(demoReservation.status, "appended");
  assert.ok(demoReservation.evidence);
  maybeRestart("demo-budget-reserve");

  const providerAttempt = await composition.adapters.demoProviderUsage.begin(
    demoProviderAttempt(digest(demoReservation.evidence), fence.contentDigest)
  );
  const demoUsage =
    await composition.adapters.demoProviderUsage.reconcile(providerAttempt);
  assert.equal(demoUsage.status, "settled");
  assert.ok(demoUsage.providerUsageDigest);
  maybeRestart("demo-provider-usage");

  const settledBudget = budgetAfterSettle(reservedBudget);
  const demoSettlement = await composition.adapters.demoBudget.settle({
    expected: reservedBudget,
    next: settledBudget,
    evidence: settlementEvidence(
      reservedBudget,
      settledBudget,
      demoReservation.evidence,
      demoUsage.providerUsageDigest
    )
  });
  assert.equal(demoSettlement.status, "appended");
  maybeRestart("demo-budget-settle");

  const kernelResult = appliedKernelResult(kernelSnapshot());
  assert.equal(
    (await composition.adapters.demoKernelState.persistApplied(kernelResult)).status,
    "appended"
  );
  maybeRestart("kernel-state");

  const receipt = stageReceipt(
    sourceRunState,
    coreBinding("PLANNED"),
    fence
  );
  const nextRunState = runState({
    core: coreBinding("PLANNED"),
    journey: {
      currentStageId: "planning",
      currentStageOrdinal: 2,
      previousStageReceiptDigest: receipt.contentDigest,
      completedStageReceiptDigests: [receipt.contentDigest]
    },
    updatedAt: LATER
  });
  assert.equal(
    (
      await composition.adapters.demoStageReceipts.append({
        expectedRunStateDigest: sourceRunState.contentDigest,
        receipt,
        nextRunState
      })
    ).status,
    "appended"
  );
  maybeRestart("stage-receipt");

  assert.equal(
    (
      await composition.adapters.demoRunState.compareAndSwap({
        expectedRunStateDigest: sourceRunState.contentDigest,
        nextRunState
      })
    ).status,
    "appended"
  );
  maybeRestart("run-state");

  const recoveryBefore = budgetState();
  const recoveryAfter = budgetState({
    generation: 1,
    usage: { calls: 0, tokens: 0, costUnits: 0, retries: 1 },
    ledgerVersion: 1,
    ledgerHead: d("recovery-ledger-head")
  });
  assert.equal(
    (
      await composition.adapters.demoRecoveryBudget.record({
        expected: recoveryBefore,
        next: recoveryAfter,
        evidence: recoveryEvidence(recoveryBefore, recoveryAfter)
      })
    ).status,
    "appended"
  );
  maybeRestart("recovery-budget");

  const releasedFence = createDemoContract("DemoRunFence", {
    ...fence.spec,
    previousFenceDigest: fence.contentDigest,
    status: "released",
    releasedAt: LATER
  });
  assert.equal(
    (
      await composition.adapters.demoRunFences.release({
        expectedFenceDigest: fence.contentDigest,
        releasedFence,
        runningState
      })
    ).status,
    "appended"
  );
  maybeRestart("fence-release");

  const domainHead = await composition.adapters.domainOperationGrants.readHead({
    storeId: "operation-grant-store",
    challenge: d("domain-head-challenge")
  });
  const domainRequest = {
    storeId: "operation-grant-store",
    claimChallenge: d("domain-claim-challenge"),
    expectedPreviousHead: domainHead.head,
    expectedStoreSequence: domainHead.storeSequence,
    grantDigest: d("domain-grant"),
    redemptionKey: d("domain-redemption"),
    operation: "repository-package" as const,
    contextDigest: d("domain-context"),
    repositoryIdentityDigest: d("domain-repository"),
    runId: "run-1",
    runAttempt: 1,
    operationSequence: 1,
    grantCheckedAt: "2026-08-30T11:59:00.000Z",
    grantExpiresAt: EXPIRES
  };
  const domainClaim =
    await composition.adapters.domainOperationGrants.claim(domainRequest);
  assert.ok(domainClaim);
  maybeRestart("domain-grant");

  const engineeringReservation =
    await composition.adapters.engineeringCost.reserve({
      workAccordDigest: d("engineering-work-accord"),
      activationLeaseDigest: d("engineering-lease"),
      phaseBudgets: PHASE_BUDGETS,
      phaseTokenBudgets: PHASE_TOKEN_BUDGETS,
      maxCalls: 3,
      maxTokens: 1_000,
      now: NOW,
      expiresAt: EXPIRES
    });
  maybeRestart("engineering-reservation");

  const engineeringHold = await composition.adapters.engineeringCost.hold({
    reservation: engineeringReservation,
    phase: "framing",
    sequence: 1,
    now: NOW
  });
  maybeRestart("engineering-hold");

  const engineeringAttempt =
    await composition.adapters.engineeringProviderUsage.begin({
      reservation: engineeringReservation,
      hold: engineeringHold,
      phase: "framing",
      sequence: 1,
      priorSettlements: [],
      now: NOW,
      reconciliationExpiresAt: reconciliationExpiry(
        engineeringReservation.expiresAt
      )
    });
  maybeRestart("engineering-attempt");

  const engineeringUsage =
    await composition.adapters.engineeringProviderUsage.reconcile({
      reservation: engineeringReservation,
      attempt: engineeringAttempt,
      now: NOW
    });
  assert.equal(engineeringUsage.status, "settled");
  assert.ok(engineeringUsage.providerUsageDigest);
  maybeRestart("engineering-usage");

  const engineeringSettlement =
    await composition.adapters.engineeringCost.settle({
      reservation: engineeringReservation,
      hold: engineeringHold,
      attempt: engineeringAttempt,
      usage: engineeringUsage,
      phase: "framing",
      actualCostUnits: 4,
      actualCalls: 1,
      actualTokens: 40,
      providerUsageDigest: engineeringUsage.providerUsageDigest,
      now: NOW
    });
  maybeRestart("engineering-settlement");

  const releaseKey = engineeringReleaseKey(engineeringReservation, [
    digest(engineeringSettlement)
  ]);
  const engineeringRelease =
    await composition.adapters.engineeringCost.release({
      releaseIdempotencyKey: releaseKey,
      reservation: engineeringReservation,
      settledPhases: [engineeringSettlement],
      expectedOpenHoldDigests: [],
      now: LATER
    });
  assert.equal(engineeringRelease.reconciliationRequired, false);
  maybeRestart("engineering-release");

  const singleWriterEvidence = effectEvidence();
  await composition.adapters.engineeringEvidence.conditionalAppend(
    null,
    singleWriterEvidence
  );
  maybeRestart("single-writer-evidence");

  const checkpoint = {
    schemaVersion: "1.1.0",
    workflowId: "workflow-1",
    bindingDigest: d("binding"),
    stage: "awaiting-human-merge"
  } as never;
  await composition.adapters.engineeringClosureCheckpoints.put(checkpoint);
  maybeRestart("engineering-checkpoint");
  await assertActualAdapterMapping(composition);

  const activationReplay =
    await composition.adapters.demoActivationClaims.claim(activation);
  const revokedReplay =
    await composition.adapters.demoActivationClaims.claim(
      activationClaim(activation.claimKey, 1)
    );
  const selectionReplay =
    await composition.adapters.stageAgentSelectionGrants.claim(grant);
  const dispatchReplay = await composition.adapters.demoDispatch.persist(decision);
  const staleRunState =
    await composition.adapters.demoRunState.compareAndSwap({
      expectedRunStateDigest: sourceRunState.contentDigest,
      nextRunState: runState({
        journey: {
          currentStageId: "planning",
          currentStageOrdinal: 2,
          previousStageReceiptDigest: receipt.contentDigest,
          completedStageReceiptDigests: [receipt.contentDigest]
        },
        status: "blocked",
        updatedAt: EXPIRES
      })
    });
  const domainReplay =
    await composition.adapters.domainOperationGrants.claim(domainRequest);
  const releaseReplay =
    await composition.adapters.engineeringCost.release({
      releaseIdempotencyKey: releaseKey,
      reservation: engineeringReservation,
      settledPhases: [engineeringSettlement],
      expectedOpenHoldDigests: [],
      now: LATER
    });
  let postReleaseHoldCode = "none";
  try {
    await composition.adapters.engineeringCost.hold({
      reservation: engineeringReservation,
      phase: "execution",
      sequence: 2,
      now: LATER
    });
  } catch (error) {
    assert.ok(error instanceof DurableEngineeringStoreError);
    postReleaseHoldCode = error.code;
  }
  assert.equal(activationReplay.status, "existing");
  assert.equal(revokedReplay.status, "conflict");
  assert.equal(selectionReplay.status, "existing");
  assert.equal(dispatchReplay.status, "existing");
  assert.equal(staleRunState.status, "conflict");
  assert.equal(domainReplay, null);
  assert.deepEqual(releaseReplay, engineeringRelease);
  assert.equal(postReleaseHoldCode, "ADAPTER_CONFLICT");

  const durableObservation = await observeScenario(composition);
  return {
    composition,
    input,
    summary: {
      restarted,
      progression: durableObservation,
      refusals: {
        activationReplay: activationReplay.status,
        revokedReplay: revokedReplay.status,
        selectionReplay: selectionReplay.status,
        dispatchReplay: dispatchReplay.status,
        staleRunState: staleRunState.status,
        domainReplay,
        engineeringReleaseReplay: digest(releaseReplay),
        postReleaseHoldCode
      }
    }
  };
}

function withoutRestartMarker(summary: unknown): unknown {
  const parsed = JSON.parse(canonicalJson(summary)) as {
    readonly progression: unknown;
    readonly refusals: unknown;
  };
  return {
    progression: parsed.progression,
    refusals: parsed.refusals
  };
}

test("the topology maps every one of the fifteen ports exactly once", () => {
  assert.equal(DURABLE_ADAPTER_STORE_MAPPING.length, 15);
  assert.equal(
    new Set(DURABLE_ADAPTER_STORE_MAPPING.map((entry) => entry.port)).size,
    15
  );
  assert.deepEqual(
    [...new Set(DURABLE_ADAPTER_STORE_MAPPING.map((entry) => entry.storeId))].sort(),
    [...DURABLE_STORE_IDS].sort()
  );
  assert.deepEqual(
    DURABLE_ADAPTER_STORE_MAPPING.map((entry) => [
      entry.port,
      entry.storeId,
      entry.primitive
    ]),
    [
      ["DemoActivationClaimStore", "operation-grant-store", "appendOnce"],
      ["StageAgentSelectionGrantStore", "operation-grant-store", "appendOnce"],
      ["DomainOperationGrantStore", "operation-grant-store", "appendOnce"],
      ["DemoDispatchStore", "receipt-journal", "appendOnce"],
      ["DemoStageReceiptStore", "receipt-journal", "appendOnce"],
      ["DemoProviderUsageLedger", "receipt-journal", "appendOnce"],
      ["EngineeringProviderUsageLedger", "receipt-journal", "appendOnce"],
      ["DemoKernelStateStore", "runtime-state-store", "compareAndSwap"],
      ["DemoRunStateStore", "runtime-state-store", "compareAndSwap"],
      ["DemoRunFenceStore", "runtime-state-store", "compareAndSwap"],
      ["DemoBudgetLedger", "runtime-state-store", "compareAndSwap"],
      ["DemoRecoveryBudgetStore", "runtime-state-store", "compareAndSwap"],
      ["EngineeringCostLedger", "runtime-state-store", "compareAndSwap"],
      ["EngineeringEvidenceStore", "evidence-store", "appendOnce"],
      ["EngineeringClosureCheckpointStore", "evidence-store", "appendOnce"]
    ]
  );
  const manifest = JSON.parse(
    readFileSync(
      path.join(
        process.cwd(),
        "examples",
        "durable-stores",
        "composition-backup-manifest.json"
      ),
      "utf8"
    )
  ) as { stores: { storeId: string; manifestDigest: string }[] };
  manifest.stores = manifest.stores.map((entry, index) => ({
    ...entry,
    storeId: "evidence-store",
    manifestDigest: d(`duplicate-store:${String(index)}`)
  }));
  assert.equal(
    validateDocument("DurableStoreCompositionBackupManifest", manifest).valid,
    false,
    "the schema must require each of the four store ids exactly once"
  );
});

test("uninterrupted and every-boundary restarted runs have identical progression and refusals", async () => {
  const baselineRoot = temporaryStoreRoot("composition-uninterrupted");
  const baseline = await runCompleteScenario(baselineRoot, null);
  const expected = withoutRestartMarker(baseline.summary);
  baseline.composition.close();
  baselineRoot.cleanup();

  for (const boundary of RESTART_BOUNDARIES) {
    const root = temporaryStoreRoot(`composition-restart-${boundary}`);
    const restarted = await runCompleteScenario(root, boundary);
    try {
      assert.deepEqual(
        (
          restarted.summary as {
            readonly restarted: readonly string[];
          }
        ).restarted,
        [boundary],
        `the ${boundary} case did not actually close and reopen the composition`
      );
      assert.equal(
        canonicalJson(withoutRestartMarker(restarted.summary)),
        canonicalJson(expected),
        `restart after ${boundary} changed durable progression or refusal`
      );
    } finally {
      restarted.composition.close();
      root.cleanup();
    }
  }
});

test("backup, restore, and disabled-state recovery preserve fail-closed semantics", async () => {
  const root = temporaryStoreRoot("composition-backup-restore");
  const run = await runCompleteScenario(root, null);
  const before = await observeScenario(run.composition);
  const manifests = await run.composition.backup(backupRootFor(root));
  assert.equal(
    lstatSync(path.dirname(manifests.paths["evidence-store"])).mode & 0o777,
    0o700
  );
  await run.composition.stores["evidence-store"].appendOnce({
    namespace: "post-backup-extra",
    key: "extra",
    body: { extra: true }
  });
  const newerBackup = await run.composition.backup(
    backupRootFor(root, "newer-backup")
  );
  run.composition.close();

  const restoredInput = compositionInput(manifests.paths);
  const restored = openDurableStoreComposition(restoredInput);
  try {
    await restored.verifyRestoredBackup(manifests);
    assert.equal(
      canonicalJson(await observeScenario(restored)),
      canonicalJson(before)
    );
    const mixedStores = {
      ...manifests.stores,
      "evidence-store": newerBackup.stores["evidence-store"]
    };
    const mixedManifestStores = DURABLE_STORE_IDS.map((storeId) => ({
      storeId,
      manifestDigest: digest(mixedStores[storeId])
    }));
    const {
      signature: _originalSignature,
      ...originalManifestPayload
    } = manifests.manifest;
    const forgedManifestPayload = {
      ...originalManifestPayload,
      stores: mixedManifestStores,
      backupSetId: digest({
        topologyDigest: manifests.manifest.topologyDigest,
        quiescenceDigest: digest(manifests.manifest.quiescence),
        stores: mixedManifestStores
      })
    };
    await assert.rejects(
      restored.verifyRestoredBackup({
        manifest: {
          ...forgedManifestPayload,
          signature: manifests.manifest.signature
        },
        stores: mixedStores,
        paths: manifests.paths
      }),
      (error: unknown) =>
        error instanceof DurableStoreCompositionError &&
        error.code === "RESTORE_MISMATCH"
    );
    await restored.stores["evidence-store"].appendOnce({
      namespace: "injected-after-restore",
      key: "extra",
      body: { extra: true }
    });
    await assert.rejects(
      restored.verifyRestoredBackup(manifests),
      (error: unknown) =>
        error instanceof DurableStoreCompositionError &&
        error.code === "RESTORE_MISMATCH"
    );
  } finally {
    restored.close();
  }

  for (const storePath of Object.values(run.input.storePaths)) {
    rmSync(storePath, { force: true });
    rmSync(`${storePath}-wal`, { force: true });
    rmSync(`${storePath}-shm`, { force: true });
  }
  const disabledRecovery = openDurableStoreComposition(run.input);
  try {
    assert.equal(
      await disabledRecovery.adapters.demoActivationClaims.read(
        activationClaim().claimKey
      ),
      null
    );
    assert.equal(
      await disabledRecovery.adapters.stageAgentSelectionGrants.read(
        d("selection-key")
      ),
      null
    );
    assert.deepEqual(
      await disabledRecovery.adapters.demoKernelState.read(),
      kernelSnapshot()
    );
    assert.deepEqual(
      await disabledRecovery.adapters.demoRunState.read(),
      runState()
    );
    assert.equal(
      (
        await disabledRecovery.stores["evidence-store"].readHead(
          "engineering.closure-checkpoints"
        )
      ).sequence,
      0
    );
  } finally {
    disabledRecovery.close();
    root.cleanup();
  }
});

test("invalid topology and unsafe backup destinations fail before widening a binding", async () => {
  const root = temporaryStoreRoot("composition-invalid-binding");
  const plan = topologyPlan();
  const firstNamespace = plan.durableStores[0]?.identity.namespace;
  assert.ok(firstNamespace);
  const invalidPlan: DeploymentTopologyPlan = {
    ...plan,
    durableStores: plan.durableStores.map((store, index) =>
      index === 1
        ? { ...store, identity: { ...store.identity, namespace: firstNamespace } }
        : store
    )
  };
  const paths = storePathsFor(root);
  assert.throws(
    () =>
      openDurableStoreComposition(
        compositionInput(paths, { plan: invalidPlan })
      ),
    (error: unknown) => error instanceof DeploymentTopologyValidationError
  );
  assert.ok(Object.values(paths).every((storePath) => !existsSync(storePath)));

  const incompletePaths = {
    "evidence-store": paths["evidence-store"],
    "operation-grant-store": paths["operation-grant-store"],
    "receipt-journal": paths["receipt-journal"]
  };
  assert.throws(
    () =>
      openDurableStoreComposition(
        compositionInput(incompletePaths as never)
      ),
    (error: unknown) =>
      error instanceof DurableStoreCompositionError &&
      error.code === "ADAPTER_MAPPING_INVALID"
  );
  assert.ok(Object.values(paths).every((storePath) => !existsSync(storePath)));

  assert.throws(
    () =>
      openDurableStoreComposition(
        compositionInput(paths, { totalBudgetCostUnits: -1 })
      ),
    (error: unknown) =>
      error instanceof DurableEngineeringStoreError &&
      error.code === "ADAPTER_BINDING_INVALID"
  );
  const reopenedAfterFailedComposition =
    openDurableStoreComposition(compositionInput(paths));
  reopenedAfterFailedComposition.close();

  const composition = openDurableStoreComposition(compositionInput(paths));
  try {
    await assert.rejects(
      composition.backup("relative-backup"),
      (error: unknown) =>
        error instanceof DurableStoreCompositionError &&
        error.code === "BACKUP_PATH_INVALID"
    );
    await assert.rejects(
      composition.backup(
        `${path.dirname(paths["evidence-store"])}/./lexical-backup`
      ),
      (error: unknown) =>
        error instanceof DurableStoreCompositionError &&
        error.code === "BACKUP_PATH_INVALID"
    );
    const aliasRoot = root.pathFor("alias-root");
    symlinkSync(paths["evidence-store"], aliasRoot);
    await assert.rejects(
      composition.backup(aliasRoot),
      (error: unknown) =>
        error instanceof DurableStoreCompositionError &&
        error.code === "BACKUP_PATH_INVALID"
    );
    await assert.rejects(
      composition.backup(paths["evidence-store"]),
      (error: unknown) =>
        error instanceof DurableStoreCompositionError &&
        error.code === "BACKUP_PATH_INVALID"
    );
    const unsafeParent = root.pathFor("unsafe-parent");
    mkdirSync(unsafeParent, { mode: 0o700 });
    chmodSync(unsafeParent, 0o777);
    await assert.rejects(
      composition.backup(path.join(unsafeParent, "backup-root")),
      (error: unknown) =>
        error instanceof DurableStoreCompositionError &&
        error.code === "BACKUP_PATH_INVALID"
    );
  } finally {
    composition.close();
    root.cleanup();
  }
});

test("composition snapshots caller-owned topology and path data before opening", async () => {
  const root = temporaryStoreRoot("composition-input-snapshot");
  const mutablePlan = structuredClone(topologyPlan());
  const originalTopologyDigest = digest(mutablePlan);
  const mutablePaths: Record<DurableStoreId, string> = {
    ...storePathsFor(root)
  };
  const composition = openDurableStoreComposition(
    compositionInput(mutablePaths, { plan: mutablePlan })
  );
  try {
    const firstStore = mutablePlan.durableStores[0];
    assert.ok(firstStore);
    (
      firstStore.identity as {
        namespace: string;
      }
    ).namespace = "mutated-after-open";
    mutablePaths["evidence-store"] = root.pathFor("caller-repointed.db");

    const backup = await composition.backup(backupRootFor(root));
    assert.equal(backup.manifest.topologyDigest, originalTopologyDigest);
    const restored = openDurableStoreComposition(
      compositionInput(backup.paths, { plan: topologyPlan() })
    );
    try {
      await restored.verifyRestoredBackup(backup);
    } finally {
      restored.close();
    }
  } finally {
    composition.close();
    root.cleanup();
  }
});

test("backup refuses when signed writer quiescence changes during the four copies", async () => {
  const root = temporaryStoreRoot("composition-backup-quiescence");
  let observations = 0;
  const composition = openDurableStoreComposition(
    compositionInput(storePathsFor(root), {
      backupQuiescence: (topologyDigest) =>
        backupQuiescenceEvidence(topologyDigest, ++observations)
    })
  );
  try {
    await assert.rejects(
      composition.backup(backupRootFor(root)),
      (error: unknown) =>
        error instanceof DurableStoreCompositionError &&
        error.code === "BACKUP_NOT_QUIESCENT"
    );
    assert.equal(observations, 2);
  } finally {
    composition.close();
    root.cleanup();
  }
});

test("backup refuses signed quiescence evidence outside its current validity window", async () => {
  const root = temporaryStoreRoot("composition-backup-expired-quiescence");
  const backupRoot = backupRootFor(root);
  const composition = openDurableStoreComposition(
    compositionInput(storePathsFor(root), {
      backupQuiescence: (topologyDigest) =>
        backupQuiescenceEvidence(
          topologyDigest,
          7,
          "2026-08-29T12:00:00.000Z",
          "2026-08-29T13:00:00.000Z"
        )
    })
  );
  try {
    await assert.rejects(
      composition.backup(backupRoot),
      (error: unknown) =>
        error instanceof DurableStoreCompositionError &&
        error.code === "BACKUP_NOT_QUIESCENT"
    );
    assert.equal(existsSync(backupRoot), false);
  } finally {
    composition.close();
    root.cleanup();
  }
});

test("corruption is refused instead of repaired or defaulted", async () => {
  const root = temporaryStoreRoot("composition-corruption");
  const paths = storePathsFor(root);
  const input = compositionInput(paths);
  const composition = openDurableStoreComposition(input);
  const claim = activationClaim();
  await composition.adapters.demoActivationClaims.claim(claim);
  composition.close();

  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(paths["operation-grant-store"]);
  raw
    .prepare(
      "UPDATE durable_record SET body = ? WHERE namespace = ? AND key = ?"
    )
    .run(
      Buffer.from(canonicalJson({ corrupted: true }), "utf8"),
      `demo-activation-claim:${claim.claimKey}`,
      "receipt"
    );
  raw.close();

  const reopened = openDurableStoreComposition(input);
  try {
    await assert.rejects(
      reopened.adapters.demoActivationClaims.read(claim.claimKey),
      (error: unknown) =>
        error instanceof DurableSubstrateError &&
        error.code === "STORE_CORRUPT"
    );
  } finally {
    reopened.close();
    root.cleanup();
  }
});

test("a restored inventory above its plan-bound journal ceiling is refused", async () => {
  const root = temporaryStoreRoot("composition-over-bound");
  const paths = storePathsFor(root);
  const original = openDurableStoreComposition(compositionInput(paths));
  try {
    await original.stores["evidence-store"].appendOnce({
      namespace: "over-bound",
      key: "one",
      body: { ordinal: 1 }
    });
    await original.stores["evidence-store"].appendOnce({
      namespace: "over-bound",
      key: "two",
      body: { ordinal: 2 }
    });
  } finally {
    original.close();
  }

  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(paths["evidence-store"]);
  raw.exec("UPDATE durable_meta SET max_entries = 1 WHERE id = 1");
  raw.close();

  const reopened = openDurableStoreComposition(
    compositionInput(paths, {
      plan: topologyPlanWithBound("evidence-store", 1)
    })
  );
  try {
    await assert.rejects(
      reopened.stores["evidence-store"].inventory(),
      (error: unknown) =>
        error instanceof DurableSubstrateError &&
        error.code === "CAPACITY_EXHAUSTED"
    );
  } finally {
    reopened.close();
    root.cleanup();
  }
});

test("budget exhaustion refuses and an unobserved provider attempt never releases its hold", async () => {
  const exhaustedRoot = temporaryStoreRoot("composition-budget-exhausted");
  const exhausted = openDurableStoreComposition(
    compositionInput(storePathsFor(exhaustedRoot), {
      totalBudgetCostUnits: 35
    })
  );
  try {
    await assert.rejects(
      exhausted.adapters.engineeringCost.reserve({
        workAccordDigest: d("engineering-work-accord"),
        activationLeaseDigest: d("engineering-lease"),
        phaseBudgets: PHASE_BUDGETS,
        phaseTokenBudgets: PHASE_TOKEN_BUDGETS,
        maxCalls: 3,
        maxTokens: 1_000,
        now: NOW,
        expiresAt: EXPIRES
      }),
      (error: unknown) =>
        error instanceof DurableEngineeringStoreError &&
        error.code === "ADAPTER_CONFLICT"
    );
    assert.equal(
      (
        await exhausted.stores["runtime-state-store"].verifyChain(
          "engineering.cost-ledger"
        )
      ).length,
      0
    );
  } finally {
    exhausted.close();
    exhaustedRoot.cleanup();
  }

  const unresolvedRoot = temporaryStoreRoot("composition-unresolved-hold");
  const unresolved = openDurableStoreComposition(
    compositionInput(storePathsFor(unresolvedRoot), {
      providerUsage: null
    })
  );
  try {
    const reservation = await unresolved.adapters.engineeringCost.reserve({
      workAccordDigest: d("engineering-work-accord"),
      activationLeaseDigest: d("engineering-lease"),
      phaseBudgets: PHASE_BUDGETS,
      phaseTokenBudgets: PHASE_TOKEN_BUDGETS,
      maxCalls: 3,
      maxTokens: 1_000,
      now: NOW,
      expiresAt: EXPIRES
    });
    const hold = await unresolved.adapters.engineeringCost.hold({
      reservation,
      phase: "framing",
      sequence: 1,
      now: NOW
    });
    const release = await unresolved.adapters.engineeringCost.release({
      releaseIdempotencyKey: engineeringReleaseKey(reservation, []),
      reservation,
      settledPhases: [],
      expectedOpenHoldDigests: [],
      now: LATER
    });
    assert.equal(release.reconciliationRequired, true);
    assert.equal(release.heldCostUnits, PHASE_BUDGETS.framing);
    assert.deepEqual(
      release.unresolvedHolds.map((candidate) => digest(candidate)),
      [digest(hold)]
    );
  } finally {
    unresolved.close();
    unresolvedRoot.cleanup();
  }
});

function injectNextWriteCommitFault(
  mode: "before-commit" | "after-commit"
): Promise<{ readonly fired: () => boolean; readonly restore: () => void }> {
  return import("node:sqlite").then(({ DatabaseSync }) => {
    const original = DatabaseSync.prototype.exec;
    let inWrite = false;
    let fired = false;
    DatabaseSync.prototype.exec = function patched(
      this: unknown,
      statement: string
    ): void {
      if (statement === "BEGIN IMMEDIATE") inWrite = true;
      if (statement === "COMMIT" && inWrite && !fired) {
        fired = true;
        inWrite = false;
        if (mode === "after-commit") original.call(this, statement);
        throw new Error("synthetic lost durable acknowledgement");
      }
      if (statement === "COMMIT" || statement === "ROLLBACK") inWrite = false;
      return original.call(this, statement);
    };
    return {
      fired: () => fired,
      restore: () => {
        DatabaseSync.prototype.exec = original;
      }
    };
  });
}

test("ambiguous and lost acknowledgements stay typed and reconcile only through fresh reads", async () => {
  const root = temporaryStoreRoot("composition-acknowledgement");
  const input = compositionInput(storePathsFor(root));
  let composition = openDurableStoreComposition(input);
  try {
    const absentClaim = activationClaim(d("ambiguous-absent"));
    const absentFault = await injectNextWriteCommitFault("before-commit");
    try {
      await assert.rejects(
        composition.adapters.demoActivationClaims.claim(absentClaim),
        (error: unknown) => error instanceof DemoActivationClaimAmbiguousError
      );
    } finally {
      absentFault.restore();
    }
    assert.equal(absentFault.fired(), true);
    assert.equal(
      await composition.adapters.demoActivationClaims.read(absentClaim.claimKey),
      null
    );

    const landedClaim = activationClaim(d("ambiguous-landed"));
    const landedFault = await injectNextWriteCommitFault("after-commit");
    try {
      await assert.rejects(
        composition.adapters.demoActivationClaims.claim(landedClaim),
        (error: unknown) => error instanceof DemoActivationClaimAmbiguousError
      );
    } finally {
      landedFault.restore();
    }
    assert.equal(landedFault.fired(), true);

    composition.close();
    composition = openDurableStoreComposition(input);
    const first =
      await composition.adapters.demoActivationClaims.read(landedClaim.claimKey);
    const second =
      await composition.adapters.demoActivationClaims.read(landedClaim.claimKey);
    assert.ok(first);
    assert.deepEqual(second, first);
    assert.deepEqual(first.claim, landedClaim);
  } finally {
    composition.close();
    root.cleanup();
  }
});

test("a close failure is retried without re-closing stores that already closed", () => {
  const root = temporaryStoreRoot("composition-close-retry");
  const composition = openDurableStoreComposition(
    compositionInput(storePathsFor(root))
  );
  const evidenceStore = composition.stores["evidence-store"];
  const realClose = evidenceStore.close.bind(evidenceStore);
  let closeAttempts = 0;
  evidenceStore.close = () => {
    closeAttempts += 1;
    if (closeAttempts === 1) {
      throw new Error("synthetic close failure");
    }
    realClose();
  };
  try {
    assert.throws(
      () => composition.close(),
      (error: unknown) => error instanceof AggregateError
    );
    assert.equal(closeAttempts, 1);
    composition.close();
    assert.equal(closeAttempts, 2);
    composition.close();
    assert.equal(closeAttempts, 2);
  } finally {
    if (closeAttempts < 2) {
      evidenceStore.close = realClose;
      composition.close();
    }
    root.cleanup();
  }
});
