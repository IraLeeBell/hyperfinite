import assert from "node:assert/strict";
import test from "node:test";

import catalogDocument from "../config/v1alpha1/demo-portfolio/catalog.json" with { type: "json" };
import reservationsDocument from "../config/v1alpha1/demo-portfolio/identity-reservations.json" with { type: "json" };
import lifecycleDocument from "../config/v1alpha1/lifecycle.json" with { type: "json" };
import registryDocument from "../config/v1alpha1/capability-registry.json" with { type: "json" };
import policyDocument from "../config/v1alpha1/policy.json" with { type: "json" };
import domainPackDocument from "../config/v1alpha1/domain-pack-policy.json" with { type: "json" };
import framingPhaseDocument from "../config/v1alpha1/phase-contracts/framing.json" with { type: "json" };
import planningPhaseDocument from "../config/v1alpha1/phase-contracts/planning.json" with { type: "json" };
import executionPhaseDocument from "../config/v1alpha1/phase-contracts/execution.json" with { type: "json" };
import verificationPhaseDocument from "../config/v1alpha1/phase-contracts/verification.json" with { type: "json" };
import humanReviewPhaseDocument from "../config/v1alpha1/phase-contracts/human-review.json" with { type: "json" };
import runtimePolicyDocument from "../config/v1alpha1/copilot-runtime-policy.json" with { type: "json" };
import accordDocument from "../examples/v1alpha1/work-accord.json" with { type: "json" };
import {
  DEMO_PROJECTION_VOCABULARY,
  DEMO_WORKFLOW_CANCEL_IN_PROGRESS,
  DemoActivationClaimAmbiguousError,
  DemoProjectionWriteError,
  DemoRecoveryBudgetPersistenceAmbiguousError,
  activateDemoIssue,
  assertDocument,
  bridgeRuntimeOutput,
  bindKernelAuthorization,
  canonicalJson,
  completeDemoStage,
  compilePolicy,
  convergeDemoProjection,
  createDemoBudgetState,
  createDemoContract,
  createDemoProjectionState,
  createDemoRuntimeObservabilityBatch,
  demoContractContentDigest,
  demoBudgetAuthorityDigest,
  demoCoreBindingFromSnapshot,
  demoWorkflowConcurrencyKey,
  deriveDemoProjectionState,
  digest,
  dispatchDemoRuntime,
  evaluatePersistedDemoKernelTransition,
  executeDemoBridgedEffect,
  eventPayloadDigest,
  issueSignedDemoActivationLease,
  issueTrustedDemoRuntimeBinding,
  loadDemoRunState,
  persistDemoDispatchDecision,
  reconstructDemoRuntime,
  reconcileDemoRunStateFromKernel,
  runtimeAuthorizationDigest,
  runtimeAuthorizationCandidateDigest,
  runtimeAuthorizationSigningPayload,
  runtimeRedemptionKey,
  runtimeRedemptionLedgerHead,
  scheduleDemoDispatch,
  validateRuntimeAuthorizationIntegrity,
  validateRuntimePreActivation,
  validateDemoContract,
  type ActivationLease,
  type Capability,
  type CapabilityRegistry,
  type CopilotRuntimePolicy,
  type CopilotRuntimeState,
  type DemoActivationClaim,
  type DemoActivationClaimReceipt,
  type DemoActivationClaimResult,
  type DemoActivationClaimStore,
  type DemoActivationGrant,
  type DemoActivationRequest,
  type DemoBudgetLedger,
  type DemoBudgetReservationEvidence,
  type DemoBudgetSettlementEvidence,
  type DemoBudgetState,
  type DemoDispatchPersistenceReceipt,
  type DemoDispatchPersistenceResult,
  type DemoDispatchStore,
  type DemoEvidenceSigner,
  type DemoEvidenceVerifier,
  type DemoProjectContractSet,
  type DemoProjectionPort,
  type DemoProjectionState,
  type DemoProviderAttemptEvidence,
  type DemoProviderUsageEvidence,
  type DemoProviderUsageLedger,
  type DemoRunFence,
  type DemoRunFenceStore,
  type DemoRunState,
  type DemoRunStateStore,
  type DemoRecoveryBudgetEvidence,
  type DemoRecoveryBudgetStore,
  type DemoRuntimeAuthority,
  type DemoRuntimeReconstruction,
  type DemoSignature,
  type DemoStageInvocationPort,
  type DemoStageReceiptStore,
  type DemoKernelStateStore,
  type Digest,
  type DomainPackPolicy,
  type EventEnvelope,
  type ContractRequirementEvidence,
  type HumanGateEvidence,
  GitHubAppCredentialBroker,
  GitHubSingleWriter,
  type KernelContext,
  type KernelSnapshot,
  type LifecycleGraph,
  type SignedDemoActivationLease,
  type SignedStageReceipt,
  type PhaseContract,
  type RuntimeActivationRequest,
  type RuntimeAuthorization,
  type RuntimeAuthorizationCandidate,
  type RuntimeAuthorizationVerifier,
  type GitHubEffectPlan,
  type GitHubExecutionResult,
  type TrustedGitHubBinding,
  type StageAgentBindingSet,
  type StageArtifactEnvelope,
  type WorkAccord
} from "../src/index.js";

const NOW = "2026-08-29T12:10:00.000Z";
const LATER = "2026-08-29T12:50:00.000Z";
const catalog = validateDemoContract("DemoCatalog", catalogDocument);
const reservations = validateDemoContract(
  "DemoIdentityReservationManifest",
  reservationsDocument
);
const lifecycle = lifecycleDocument as LifecycleGraph;
const baseRegistry = assertDocument("CapabilityRegistry", registryDocument);
const controlPolicy = assertDocument("ControlPolicy", policyDocument);
const baseDomainPack = assertDocument(
  "DomainPackPolicy",
  domainPackDocument
);
const baseFramingPhase = assertDocument(
  "PhaseContract",
  framingPhaseDocument
);
const basePlanningPhase = assertDocument(
  "PhaseContract",
  planningPhaseDocument
);
const baseExecutionPhase = assertDocument(
  "PhaseContract",
  executionPhaseDocument
);
const baseVerificationPhase = assertDocument(
  "PhaseContract",
  verificationPhaseDocument
);
const baseHumanReviewPhase = assertDocument(
  "PhaseContract",
  humanReviewPhaseDocument
);
const runtimePolicy = assertDocument(
  "CopilotRuntimePolicy",
  runtimePolicyDocument
);
const accord = accordDocument as WorkAccord;

function signature(payload: unknown, keyId = "activation:key-1"): DemoSignature {
  return {
    algorithm: "ed25519",
    keyId,
    value: Buffer.from(digest(payload), "utf8").toString("base64")
  };
}

const signer: DemoEvidenceSigner = {
  sign: async (payload) => signature(payload)
};

const verifier: DemoEvidenceVerifier = {
  verify: (payload, candidate) =>
    candidate.algorithm === "ed25519" &&
    candidate.value === signature(payload, candidate.keyId).value
};

const stageVerifier = {
  verify: (receipt: SignedStageReceipt) =>
    verifier.verify(receipt.contentDigest, receipt.signature)
};

function reservationFor() {
  const reservation = reservations.spec.projects.find(
    (candidate) => candidate.demoProjectId === "feature-delivery"
  );
  assert.ok(reservation);
  return reservation;
}

function phaseFor(
  state: string
): {
  readonly phase: "framing" | "execution" | "verification";
  readonly role: "framer" | "executor" | "reviewer";
  readonly workflowClass:
    | "framing-comment"
    | "target-free-execution"
    | "current-head-comment-review";
} {
  if (state === "FRAMING") {
    return {
      phase: "framing",
      role: "framer",
      workflowClass: "framing-comment"
    };
  }
  if (state === "EXECUTING") {
    return {
      phase: "execution",
      role: "executor",
      workflowClass: "target-free-execution"
    };
  }
  return {
    phase: "verification",
    role: "reviewer",
    workflowClass: "current-head-comment-review"
  };
}

function capabilityTemplate(
  phase: "framing" | "execution" | "verification"
): Capability {
  const id =
    phase === "framing"
      ? "core.frame-artifact"
      : phase === "execution"
        ? "core.execute-bounded-change"
        : "core.review-current-head";
  const capability = baseRegistry.capabilities.find(
    (candidate) => candidate.id === id
  );
  assert.ok(capability);
  return structuredClone(capability);
}

function contractSet(): DemoProjectContractSet {
  const entry = catalog.spec.entries.find(
    (candidate) => candidate.id === "feature-delivery"
  );
  assert.ok(entry);
  const profile = createDemoContract("DemoProjectProfile", {
    demoProjectId: "feature-delivery",
    catalogDigest: catalog.contentDigest,
    identityReservationsDigest: reservations.contentDigest,
    title: entry.title,
    description: "Synthetic runtime test profile.",
    defaultDepthProfile: "D2",
    allowedDepthProfiles: ["D1", "D2"],
    repositoryBindingDigest: digest("runtime-repository-binding"),
    projectBindingDigest: digest("runtime-project-binding"),
    workAccordTemplateDigest: digest("runtime-work-accord-template"),
    journeyDefinitionRef: entry.journeyDefinitionRef,
    stageAgentBindingsRef: entry.stageAgentBindingsRef,
    capabilityShardRef: entry.capabilityShardRef,
    activationProfileRef: entry.activationProfileRef,
    projectionMappingRef: entry.projectionMappingRef
  });
  const reserved = reservationFor();
  const journey = createDemoContract("DemoJourneyDefinition", {
    demoProjectId: "feature-delivery",
    catalogDigest: catalog.contentDigest,
    identityReservationsDigest: reservations.contentDigest,
    projectProfileDigest: profile.contentDigest,
    lifecycleGraphDigest: digest(lifecycle),
    initialStageId: "intake",
    terminalStageId: "completed",
    stages: reserved.journeyStages.map(
      ({ runtimeBindings: _runtimeBindings, ...stage }) => stage
    ),
    controlStages: reserved.controlStages.map(
      ({ runtimeBindings: _runtimeBindings, ...stage }) => stage
    )
  });
  const capabilities = reserved.journeyStages
    .filter((stage) => stage.executionKind === "model")
    .map((stage) => {
      const identity = stage.runtimeBindings[0];
      assert.ok(identity);
      const expected = phaseFor(stage.coreState);
      const template = capabilityTemplate(expected.phase);
      const separator = identity.capabilityId.lastIndexOf("@");
      return {
        ...template,
        id: identity.capabilityId.slice(0, separator),
        version: identity.capabilityId.slice(separator + 1),
        description: `Synthetic ${stage.stageId} capability.`,
        allowedPhases: [expected.phase]
      } satisfies Capability;
    });
  const capabilityShard = createDemoContract("DemoCapabilityRegistryShard", {
    demoProjectId: "feature-delivery",
    catalogDigest: catalog.contentDigest,
    identityReservationsDigest: reservations.contentDigest,
    projectProfileDigest: profile.contentDigest,
    capabilities
  });
  const stageBindings: StageAgentBindingSet["spec"]["stageBindings"] =
    reserved.journeyStages.map((stage) => {
      const identity = stage.runtimeBindings[0];
      if (identity === undefined) {
        return {
          stageId: stage.stageId,
          executionKind: stage.executionKind,
          participationMode: "none",
          userInputRequired: false,
          eligibleActorClasses: [],
          requiredEvidenceClass:
            stage.executionKind === "planning"
              ? "accepted-frame"
              : stage.executionKind === "human"
                ? "human-gate"
                : "none",
          selectionFieldKey: null,
          allowedOptionKeys: [],
          fallbackPolicy: "none",
          clearSelectionOnExit: false,
          runtimeBindings: []
        };
      }
      const expected = phaseFor(stage.coreState);
      return {
        stageId: stage.stageId,
        executionKind: stage.executionKind,
        participationMode: "fixed",
        userInputRequired: false,
        eligibleActorClasses: ["system"],
        requiredEvidenceClass:
          stage.coreState === "VERIFYING"
            ? "exact-current-head"
            : stage.coreState === "EXECUTING"
              ? "accepted-plan"
              : "activation",
        selectionFieldKey: null,
        allowedOptionKeys: [],
        fallbackPolicy: "none",
        clearSelectionOnExit: false,
        runtimeBindings: [
          {
            optionKey: null,
            userInvocable: false,
            agent: identity.agentId,
            skill: identity.agentId,
            safetySkills: ["authority-refusal"],
            capability: identity.capabilityId,
            workflow: identity.workflowId,
            workflowClass: expected.workflowClass,
            phase: expected.phase,
            role: expected.role,
            githubToolsets: expected.phase === "framing" ? ["issues"] : [],
            githubTools: expected.phase === "framing" ? ["issue_read"] : [],
            modelInvocationAllowed: true,
            slashCommand: {
              name: identity.workflowId,
              events:
                expected.phase === "verification"
                  ? ["pull_request_comment"]
                  : ["issue_comment"]
            }
          }
        ]
      };
    });
  const bindings = createDemoContract("StageAgentBindingSet", {
    demoProjectId: "feature-delivery",
    catalogDigest: catalog.contentDigest,
    identityReservationsDigest: reservations.contentDigest,
    projectProfileDigest: profile.contentDigest,
    journeyDefinitionDigest: journey.contentDigest,
    capabilityShardDigest: capabilityShard.contentDigest,
    participationPolicyDigest: digest("synthetic-participation-policy"),
    stageBindings,
    controlBindings: reserved.controlStages.map((stage) => ({
      stageId: stage.stageId,
      executionKind: stage.executionKind,
      participationMode: "none",
      userInputRequired: false,
      eligibleActorClasses: ["system"],
      requiredEvidenceClass: "kernel-state",
      selectionFieldKey: null,
      allowedOptionKeys: [],
      fallbackPolicy: "none",
      clearSelectionOnExit: false,
      runtimeBindings: []
    }))
  });
  const activation = createDemoContract("DemoActivationProfile", {
    demoProjectId: "feature-delivery",
    catalogDigest: catalog.contentDigest,
    projectProfileDigest: profile.contentDigest,
    stageAgentBindingsDigest: bindings.contentDigest,
    capabilityShardDigest: capabilityShard.contentDigest,
    enabled: true,
    authorityEpoch: 1,
    revocationGeneration: 0,
    allowedSubmitterIds: [101],
    allowedSource: "issue-form",
    consentField: "demo-consent",
    consentRequired: true,
    leaseTemplate: {
      maxCalls: 5,
      maxTokens: 10_000,
      maxCostUnits: 100,
      maxDurationMs: 600_000,
      maxRetries: 1,
      maxParallel: 1
    },
    validFrom: "2026-08-29T12:00:00Z",
    expiresAt: "2026-08-29T13:00:00Z",
    signingKeyId: "activation:key-1"
  });
  const sources = {
    stage: "kernel-snapshot",
    "journey-stage": "signed-stage-receipt",
    "demo-project-profile": "project-profile",
    "depth-profile": "work-accord",
    "gate-status": "demo-run-state",
    "contract-revision": "work-accord",
    "last-receipt": "signed-stage-receipt",
    attention: "demo-run-state",
    "target-repository": "trusted-binding",
    "run-attempt": "demo-run-state",
    "current-draft-pr": "demo-run-state",
    "current-stage-agent": "stage-agent-selection",
    "stage-interaction": "stage-agent-binding-set",
    "agent-selection-status": "stage-agent-selection"
  } as const;
  const projection = createDemoContract("DemoProjectionMapping", {
    demoProjectId: "feature-delivery",
    projectProfileDigest: profile.contentDigest,
    journeyDefinitionDigest: journey.contentDigest,
    stageAgentBindingsDigest: bindings.contentDigest,
    fields: DEMO_PROJECTION_VOCABULARY.map((field, index) => ({
      ...field,
      source: sources[field.key],
      displayOnly: true,
      writeOrder:
        field.key === "stage" ? DEMO_PROJECTION_VOCABULARY.length : index
    }))
  });
  return {
    profile,
    journey,
    capabilities: capabilityShard,
    bindings,
    activation,
    projection
  };
}

const contracts = contractSet();
const authority: DemoRuntimeAuthority = {
  catalog,
  reservations,
  lifecycle,
  baseRegistry,
  contracts,
  workAccord: accord
};

function activationLease(
  overrides: Partial<ActivationLease> = {},
  workAccord: WorkAccord = accord
): ActivationLease {
  const allowedCapabilities =
    contracts.bindings.spec.stageBindings.flatMap((entry) =>
      entry.runtimeBindings.map((binding) => binding.capability)
    );
  return {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "ActivationLease",
    id: "demo-lease-1",
    workAccordDigest: digest(workAccord),
    approvedBy: "maintainer-101",
    authorizationDigest: digest("maintainer-authorization"),
    allowedPhases: [
      "execution",
      "framing",
      "human-review",
      "planning",
      "verification"
    ],
    allowedCapabilities,
    maxCalls: contracts.activation.spec.leaseTemplate.maxCalls,
    maxTokens: contracts.activation.spec.leaseTemplate.maxTokens,
    maxCostUnits: contracts.activation.spec.leaseTemplate.maxCostUnits,
    maxParallel: 1,
    expiresAt: LATER,
    revoked: false,
    ...overrides
  };
}

function kernelSnapshot(
  state: KernelSnapshot["state"],
  stateVersion: number,
  leaseUsage: KernelSnapshot["usage"] = {
    calls: 0,
    tokens: 0,
    costUnits: 0,
    loops: 0,
    retries: 0
  }
): KernelSnapshot {
  const phaseOwner =
    state === "FRAMING"
      ? "framing"
      : state === "PLANNED"
        ? "planning"
        : state === "EXECUTING"
          ? "execution"
          : state === "VERIFYING"
            ? "verification"
            : state === "HUMAN_REVIEW"
              ? "human-review"
              : state === "CAPTURED"
                ? "intake"
                : "kernel";
  const hasAuthority = !["CAPTURED", "ACTIVATION_PENDING", "CANCELLED"].includes(
    state
  );
  return {
    schemaVersion: "1.0.0",
    lifecycleVersion: "1.0.0",
    lifecycleGraphDigest: digest(lifecycle),
    state,
    phaseOwner,
    stateVersion,
    lastEventSequence: stateVersion,
    bindingDigest: digest({
      repositoryId: accord.binding.repositoryId,
      sourceDigest: accord.binding.sourceDigest,
      workItemNodeId: accord.binding.workItemNodeId
    }),
    workAccordDigest: digest(accord),
    capabilityRegistryDigest: digest(baseRegistry),
    domainPackDigest: accord.policy.domainPackDigest,
    phaseContractDigest: hasAuthority ? digest(`${state}:phase`) : null,
    compiledPolicyDigest: hasAuthority ? digest(`${state}:compiled`) : null,
    policyDigest: accord.binding.policyDigest,
    currentHead: accord.binding.currentHead,
    receiptHead: stateVersion === 0 ? null : digest(`${state}:kernel-receipt`),
    suspendedState: state === "PAUSED" ? "FRAMING" : null,
    recoveryState: state === "BLOCKED" ? "FRAMING" : null,
    usage: leaseUsage,
    phaseUsage: leaseUsage,
    routeAttempts: {},
    processedEvents: {}
  };
}

function historicalEvidence(input: {
  readonly snapshot: KernelSnapshot;
  readonly ordinal: number;
}): {
  readonly receiptDigests: readonly Digest[];
  readonly receipts: readonly SignedStageReceipt[];
  readonly artifacts: readonly StageArtifactEnvelope[];
  readonly fences: readonly DemoRunFence[];
} {
  const receipts: SignedStageReceipt[] = [];
  const artifacts: StageArtifactEnvelope[] = [];
  const fences: DemoRunFence[] = [];
  let previous: Digest | null = null;
  let previousFence: Digest | null = null;
  const syntheticCore = (
    state: DemoRunState["spec"]["core"]["state"],
    stateVersion: number,
    label: string
  ): DemoRunState["spec"]["core"] => {
    const active = ![
      "CAPTURED",
      "ACTIVATION_PENDING",
      "CANCELLED"
    ].includes(state);
    return {
      ...demoCoreBindingFromSnapshot(input.snapshot),
      state,
      stateVersion,
      phaseContractDigest: active ? digest(`${label}:phase`) : null,
      compiledPolicyDigest: active ? digest(`${label}:compiled`) : null,
      kernelReceiptDigest: digest(`${label}:kernel-receipt`),
      kernelSnapshotDigest: digest(`${label}:kernel-snapshot`)
    };
  };
  for (let index = 0; index < input.ordinal - 1; index += 1) {
    const stage = contracts.journey.spec.stages[index];
    const next = contracts.journey.spec.stages[index + 1];
    assert.ok(stage);
    assert.ok(next);
    const stageBinding = contracts.bindings.spec.stageBindings[index];
    assert.ok(stageBinding);
    const runtimeBinding = stageBinding.runtimeBindings[0];
    const modelStage = stage.executionKind === "model";
    const artifact = createDemoContract("StageArtifactEnvelope", {
      demoProjectId: "feature-delivery",
      stageId: stage.stageId,
      projectProfileDigest: contracts.profile.contentDigest,
      journeyDefinitionDigest: contracts.journey.contentDigest,
      stageAgentBindingsDigest: contracts.bindings.contentDigest,
      authorityEpoch: 1,
      generation: 0,
      runId: "demo-run-1",
      runAttempt: 1,
      producer:
        modelStage && runtimeBinding !== undefined
          ? {
              kind: "model",
              agentId: runtimeBinding.agent,
              capabilityId: runtimeBinding.capability,
              workflowId: runtimeBinding.workflow
            }
          : {
              kind: "deterministic",
              agentId: null,
              capabilityId: null,
              workflowId: null
            },
      inputDigest: digest(`input:${stage.stageId}`),
      artifact: {
        kind: "SyntheticStageArtifact",
        schemaVersion: "1.0.0",
        mediaType: "application/json",
        byteLength: 1,
        contentDigest: digest(`artifact:${stage.stageId}`)
      },
      createdAt: NOW
    });
    let acquired: DemoRunFence | null = null;
    let released: DemoRunFence | null = null;
    if (modelStage) {
      acquired = createDemoContract("DemoRunFence", {
        demoProjectId: "feature-delivery",
        repositoryId: accord.binding.repositoryId,
        workItemNodeId: accord.binding.workItemNodeId,
        fenceKey: digest({
          repositoryId: accord.binding.repositoryId,
          workItemNodeId: accord.binding.workItemNodeId
        }),
        authorityEpoch: 1,
        generation: 0,
        runId: "demo-run-1",
        runAttempt: 1,
        runStateDigest: digest(`run-state:${stage.stageId}`),
        dispatchDecisionDigest: digest(`dispatch:${stage.stageId}`),
        holderDigest: digest(`holder:${stage.stageId}`),
        activationLeaseDigest: digest(activationLease()),
        previousFenceDigest: previousFence,
        status: "acquired",
        acquiredAt: "2026-08-29T12:05:00.000Z",
        expiresAt: "2026-08-29T12:15:00.000Z",
        releasedAt: null
      });
      released = createDemoContract("DemoRunFence", {
        ...acquired.spec,
        previousFenceDigest: acquired.contentDigest,
        status: "released",
        releasedAt: "2026-08-29T12:06:00.000Z"
      });
      fences.push(acquired, released);
      previousFence = released.contentDigest;
    }
    const before = syntheticCore(stage.coreState, index * 2 + 1, stage.stageId);
    const after =
      stage.coreState === next.coreState
        ? before
        : syntheticCore(
            next.coreState,
            before.stateVersion + 1,
            `${stage.stageId}:after`
          );
    const crossesCore = stage.coreState !== next.coreState;
    const spec: SignedStageReceipt["spec"] = {
      demoProjectId: "feature-delivery",
      projectProfileDigest: contracts.profile.contentDigest,
      journeyDefinitionDigest: contracts.journey.contentDigest,
      stageAgentBindingsDigest: contracts.bindings.contentDigest,
      authorityEpoch: 1,
      generation: 0,
      runId: "demo-run-1",
      runAttempt: 1,
      runStateDigest: digest(`run-state:${stage.stageId}`),
      stageId: stage.stageId,
      stageOrdinal: stage.ordinal,
      nextStageId: next.stageId,
      nextStageOrdinal: next.ordinal,
      previousStageReceiptDigest: previous,
      artifactEnvelopeDigest: artifact.contentDigest,
      runFenceDigest: acquired?.contentDigest ?? null,
      releasedRunFenceDigest: released?.contentDigest ?? null,
      coreBefore: before,
      coreAfter: after,
      kernelTransitionReceiptDigest:
        crossesCore ? after.kernelReceiptDigest : null,
      appliedKernelResultDigest:
        crossesCore ? digest(`applied:${stage.stageId}`) : null,
      outcome: "completed",
      completedAt: NOW
    };
    const contentDigest = demoContractContentDigest(
      "SignedStageReceipt",
      spec
    );
    receipts.push(
      validateDemoContract("SignedStageReceipt", {
        apiVersion: "agentic-framework.github.com/v1alpha1",
        kind: "SignedStageReceipt",
        schemaVersion: "1.0.0",
        contentDigest,
        spec,
        signature: signature(contentDigest)
      })
    );
    artifacts.push(artifact);
    previous = contentDigest;
  }
  return {
    receiptDigests: receipts.map((receipt) => receipt.contentDigest),
    receipts,
    artifacts,
    fences
  };
}

function runStateAt(input: {
  readonly snapshot: KernelSnapshot;
  readonly ordinal: number;
  readonly status?: DemoRunState["spec"]["status"];
  readonly evidence?: ReturnType<typeof historicalEvidence>;
}): {
  readonly runState: DemoRunState;
  readonly evidence: ReturnType<typeof historicalEvidence>;
} {
  const evidence =
    input.evidence ??
    historicalEvidence({ snapshot: input.snapshot, ordinal: input.ordinal });
  const stage = contracts.journey.spec.stages[input.ordinal - 1];
  assert.ok(stage);
  return {
    evidence,
    runState: createDemoContract("DemoRunState", {
      demoProjectId: "feature-delivery",
      catalogDigest: catalog.contentDigest,
      identityReservationsDigest: reservations.contentDigest,
      projectProfileDigest: contracts.profile.contentDigest,
      journeyDefinitionDigest: contracts.journey.contentDigest,
      stageAgentBindingsDigest: contracts.bindings.contentDigest,
      capabilityShardDigest: contracts.capabilities.contentDigest,
      activationProfileDigest: contracts.activation.contentDigest,
      projectionMappingDigest: contracts.projection.contentDigest,
      repositoryId: accord.binding.repositoryId,
      workItemNodeId: accord.binding.workItemNodeId,
      repositoryBindingDigest: contracts.profile.spec.repositoryBindingDigest,
      authorityEpoch: 1,
      generation: 0,
      runId: "demo-run-1",
      runAttempt: 1,
      core: demoCoreBindingFromSnapshot(input.snapshot),
      journey: {
        currentStageId: stage.stageId,
        currentStageOrdinal: stage.ordinal,
        previousStageReceiptDigest: evidence.receiptDigests.at(-1) ?? null,
        completedStageReceiptDigests: evidence.receiptDigests
      },
      fenceDigest: null,
      fenceBaseRunStateDigest: null,
      currentDraftPullRequest: null,
      status: input.status ?? "ready",
      updatedAt: NOW
    })
  };
}

function budgetFor(
  runState: DemoRunState,
  snapshot: KernelSnapshot,
  lease: ActivationLease,
  workAccord: WorkAccord = accord
): DemoBudgetState {
  return createDemoBudgetState({
    demoProjectId: "feature-delivery",
    repositoryId: runState.spec.repositoryId,
    workItemNodeId: runState.spec.workItemNodeId,
    authorityEpoch: runState.spec.authorityEpoch,
    generation: runState.spec.generation,
    activationLeaseDigest: digest(lease),
    workAccordDigest: digest(workAccord),
    limits: contracts.activation.spec.leaseTemplate,
    usage: {
      calls: snapshot.usage.calls,
      tokens: snapshot.usage.tokens,
      costUnits: snapshot.usage.costUnits,
      retries: snapshot.usage.retries
    },
    held: { calls: 0, tokens: 0, costUnits: 0 },
    startedAt: NOW,
    expiresAt: LATER,
    ledgerVersion: 0,
    ledgerHead: null
  });
}

function projectionFor(
  runState: DemoRunState,
  snapshot: KernelSnapshot,
  observedAt = NOW
): DemoProjectionState {
  const stage =
    contracts.journey.spec.stages[
      runState.spec.journey.currentStageOrdinal - 1
    ];
  assert.ok(stage);
  const binding =
    contracts.bindings.spec.stageBindings[stage.ordinal - 1];
  assert.ok(binding);
  const values = {
    stage: snapshot.state,
    "journey-stage": stage.displayName,
    "demo-project-profile": contracts.profile.spec.title,
    "depth-profile": accord.policy.depthProfile,
    "gate-status": runState.spec.status,
    "contract-revision": accord.identity.revision.toString(),
    "last-receipt": runState.spec.journey.previousStageReceiptDigest,
    attention:
      snapshot.state === "ACTIVATION_PENDING" ? "Activation required" : null,
    "target-repository": accord.binding.repositoryFullName,
    "run-attempt": `${runState.spec.runId}/${runState.spec.runAttempt}`,
    "current-draft-pr": null,
    "current-stage-agent": binding.runtimeBindings[0]?.agent ?? "No model agent",
    "stage-interaction":
      binding.participationMode === "fixed"
        ? "backend-autonomous"
        : binding.participationMode === "user-selectable"
          ? "user-selectable"
          : stage.executionKind === "human"
            ? "human-gate"
            : stage.executionKind === "terminal"
              ? "terminal"
              : "deterministic",
    "agent-selection-status":
      binding.participationMode === "user-selectable"
        ? "awaiting-selection"
        : "not-applicable"
  } as const;
  return createDemoProjectionState({
    demoProjectId: "feature-delivery",
    repositoryId: runState.spec.repositoryId,
    workItemNodeId: runState.spec.workItemNodeId,
    projectBindingDigest: contracts.profile.spec.projectBindingDigest,
    authorityEpoch: runState.spec.authorityEpoch,
    generation: runState.spec.generation,
    kernelStateVersion: snapshot.stateVersion,
    kernelReceiptDigest: snapshot.receiptHead,
    stageReceiptDigest: runState.spec.journey.previousStageReceiptDigest,
    fields: DEMO_PROJECTION_VOCABULARY.map((field) => ({
      key: field.key,
      value: values[field.key]
    })),
    observedAt
  });
}

function reconstructionAt(input: {
  readonly state?: KernelSnapshot["state"];
  readonly ordinal?: number;
  readonly status?: DemoRunState["spec"]["status"];
  readonly lease?: ActivationLease;
  readonly budget?: DemoBudgetState;
  readonly projection?: DemoProjectionState;
  readonly artifacts?: readonly StageArtifactEnvelope[];
  readonly fences?: readonly DemoRunFence[];
  readonly runState?: DemoRunState;
  readonly snapshot?: KernelSnapshot;
  readonly evidence?: ReturnType<typeof historicalEvidence>;
} = {}): DemoRuntimeReconstruction {
  const snapshot =
    input.snapshot ?? kernelSnapshot(input.state ?? "FRAMING", 2);
  const lease = input.lease ?? activationLease();
  const prepared =
    input.runState === undefined
      ? runStateAt({
          snapshot,
          ordinal: input.ordinal ?? 2,
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.evidence === undefined
            ? {}
            : { evidence: input.evidence })
        })
      : {
          runState: input.runState,
          evidence:
            input.evidence ??
            historicalEvidence({
              snapshot,
              ordinal: input.runState.spec.journey.currentStageOrdinal
            })
        };
  return reconstructDemoRuntime({
    authority,
    runState: prepared.runState,
    kernelSnapshot: snapshot,
    activationLease: lease,
    budget: input.budget ?? budgetFor(prepared.runState, snapshot, lease),
    projection:
      input.projection ?? projectionFor(prepared.runState, snapshot),
    completedReceipts: prepared.evidence.receipts,
    artifacts: input.artifacts ?? prepared.evidence.artifacts,
    fences: input.fences ?? prepared.evidence.fences,
    receiptVerifier: stageVerifier,
    evaluatedAt: NOW
  });
}

class ActivationClaimStore implements DemoActivationClaimStore {
  calls = 0;
  receipt: DemoActivationClaimReceipt | null = null;
  ambiguous = false;

  async claim(claim: DemoActivationClaim): Promise<DemoActivationClaimResult> {
    this.calls += 1;
    if (this.receipt !== null) {
      return canonicalJson(this.receipt.claim) === canonicalJson(claim)
        ? { status: "existing", receipt: this.receipt }
        : { status: "conflict", receipt: null };
    }
    const payload = {
      schemaVersion: "1.0.0" as const,
      storeId: "activation-store-1",
      sequence: 1,
      previousHead: null,
      claim,
      status: "appended" as const,
      head: digest({
        storeId: "activation-store-1",
        sequence: 1,
        previousHead: null,
        claim,
        status: "appended",
        persistedAt: NOW
      }),
      persistedAt: NOW
    };
    this.receipt = { ...payload, signature: signature(payload) };
    if (this.ambiguous) throw new DemoActivationClaimAmbiguousError();
    return { status: "appended", receipt: this.receipt };
  }

  async read(): Promise<DemoActivationClaimReceipt | null> {
    return this.receipt;
  }
}

function activationRequest(): DemoActivationRequest {
  return {
    demoProjectId: "feature-delivery",
    repositoryId: accord.binding.repositoryId,
    workItemNodeId: accord.binding.workItemNodeId,
    source: "issue-form",
    sourceEventDigest: digest("issue-form-event"),
    submitterId: 101,
    consent: {
      field: "demo-consent",
      accepted: true,
      evidenceDigest: digest("explicit-consent")
    },
    catalogDigest: catalog.contentDigest,
    projectProfileDigest: contracts.profile.contentDigest,
    stageAgentBindingsDigest: contracts.bindings.contentDigest,
    capabilityShardDigest: contracts.capabilities.contentDigest,
    repositoryBindingDigest: contracts.profile.spec.repositoryBindingDigest,
    projectBindingDigest: contracts.profile.spec.projectBindingDigest,
    authorityEpoch: 1,
    generation: 0,
    revocationGeneration: 0,
    observedAt: NOW
  };
}

async function activationGrant(
  store = new ActivationClaimStore()
): Promise<{
  readonly grant: DemoActivationGrant;
  readonly receipt: DemoActivationClaimReceipt;
  readonly signedLease: SignedDemoActivationLease;
  readonly budget: DemoBudgetState;
  readonly runState: DemoRunState;
  readonly store: ActivationClaimStore;
}> {
  const request = activationRequest();
  const lease = activationLease();
  const snapshot = kernelSnapshot("FRAMING", 2);
  const { runState } = runStateAt({ snapshot, ordinal: 2 });
  const budget = budgetFor(runState, snapshot, lease);
  const signedLease = await issueSignedDemoActivationLease({
    authority,
    request,
    lease,
    issuedAt: NOW,
    signer
  });
  const grant = await activateDemoIssue({
    authority,
    request,
    signedLease,
    runState,
    budget,
    priorBudget: null,
    recoveryBudgetEvidence: null,
    recoveryBudgetVerifier: verifier,
    leaseVerifier: verifier,
    claimStore: store,
    claimVerifier: verifier
  });
  assert.ok(store.receipt);
  return {
    grant,
    receipt: store.receipt,
    signedLease,
    budget,
    runState,
    store
  };
}

class DispatchStore implements DemoDispatchStore {
  receipt: DemoDispatchPersistenceReceipt | null = null;

  constructor(readonly generation = 0) {}

  async persist(
    decision: Parameters<DemoDispatchStore["persist"]>[0]
  ): Promise<DemoDispatchPersistenceResult> {
    if (this.receipt !== null) {
      return this.receipt.decisionDigest === decision.contentDigest
        ? { status: "existing", receipt: this.receipt }
        : { status: "conflict", receipt: null };
    }
    const payload = {
      schemaVersion: "1.0.0" as const,
      storeId: "dispatch-store-1",
      sequence: 1,
      previousHead: null,
      decisionDigest: decision.contentDigest,
      runStateDigest: decision.spec.runStateDigest,
      repositoryId: accord.binding.repositoryId,
      workItemNodeId: accord.binding.workItemNodeId,
      authorityEpoch: 1,
      generation: this.generation,
      status: "persisted" as const,
      persistedAt: NOW,
      head: digest({
        storeId: "dispatch-store-1",
        sequence: 1,
        previousHead: null,
        decisionDigest: decision.contentDigest,
        runStateDigest: decision.spec.runStateDigest,
        repositoryId: accord.binding.repositoryId,
        workItemNodeId: accord.binding.workItemNodeId,
        authorityEpoch: 1,
        generation: this.generation,
        status: "persisted",
        persistedAt: NOW
      })
    };
    this.receipt = { ...payload, signature: signature(payload) };
    return { status: "appended", receipt: this.receipt };
  }

  async read(): Promise<DemoDispatchPersistenceReceipt | null> {
    return this.receipt;
  }
}

const runtimeAuthorizationVerifier: RuntimeAuthorizationVerifier = {
  verify: (authorization) =>
    verifier.verify(
      runtimeAuthorizationSigningPayload(authorization),
      authorization.signature
    )
};

function signedRuntimeAuthorization(
  candidate: RuntimeAuthorizationCandidate,
  overrides: Partial<RuntimeAuthorization> = {}
): RuntimeAuthorization {
  let authorization: RuntimeAuthorization = {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "CopilotRuntimeAuthorization",
    schemaVersion: "2.0.0",
    authorizationDigest: digest("authorization-placeholder"),
    candidateDigest: candidate.candidateDigest,
    inputDigest: candidate.inputDigest,
    stateDigest: candidate.stateDigest,
    policyDigest: candidate.policyDigest,
    kernelPolicyDigest: candidate.kernelPolicyDigest,
    bindingDigest: candidate.bindingDigest,
    kernelBindingDigest: candidate.kernelBindingDigest,
    workAccordSourceDigest: candidate.workAccordSourceDigest,
    repositoryId: candidate.repositoryId,
    repositoryFullName: candidate.repositoryFullName,
    workItemKind: candidate.workItemKind,
    workItemNumber: candidate.workItemNumber,
    workItemNodeId: candidate.workItemNodeId,
    projectNodeId: candidate.projectNodeId,
    projectItemNodeId: candidate.projectItemNodeId,
    kernelReceiptDigest: candidate.kernelReceiptDigest,
    routeId: candidate.routeId,
    phase: candidate.phase,
    role: candidate.role,
    capability: candidate.capability,
    workflowId: candidate.workflowId,
    workflowRef: candidate.workflowRef,
    workflowSha: candidate.workflowSha,
    runId: candidate.runId,
    runAttempt: candidate.runAttempt,
    eventName: candidate.eventName,
    eventAction: candidate.eventAction,
    actorId: candidate.actorId,
    actorLogin: candidate.actorLogin,
    activationLeaseDigest: candidate.activationLeaseDigest,
    activationNonce: candidate.activationNonce,
    reservedAiCredits: candidate.reservedAiCredits,
    remainingAiCreditsBefore: candidate.remainingAiCredits,
    remainingAiCreditsAfter:
      candidate.remainingAiCredits - candidate.reservedAiCredits,
    contractRevision: candidate.contractRevision,
    contractDigest: candidate.contractDigest,
    currentHead: candidate.currentHead,
    executionContext: candidate.executionContext,
    outputSchema:
      candidate.phase === "execution"
        ? "TargetFreePatch@1.0.0"
        : "GitHubSafeOutput@1.0.0",
    stateCommentId: candidate.stateCommentId,
    stateCommentUpdatedAt: candidate.stateCommentUpdatedAt,
    stateCollectionEtag: candidate.stateCollectionEtag,
    stateRevoked: false,
    leaseRevoked: false,
    projectBindingVerified: true,
    stateCheckedAt: NOW,
    leaseCheckedAt: NOW,
    redemptionKey: runtimeRedemptionKey(candidate),
    casResult: "appended",
    ledgerVersion: 1,
    ledgerHeadBefore: null,
    ledgerHeadAfter: digest("ledger-placeholder"),
    redeemedAt: NOW,
    expiresAt: candidate.expiresAt,
    redeemerServiceId: "demo-runtime-test-redeemer",
    signature: signature("authorization-placeholder", "runtime:key-1"),
    ...overrides
  };
  authorization = {
    ...authorization,
    redemptionKey: runtimeRedemptionKey(authorization)
  };
  authorization = {
    ...authorization,
    ledgerHeadAfter: runtimeRedemptionLedgerHead(authorization)
  };
  authorization = {
    ...authorization,
    authorizationDigest: runtimeAuthorizationDigest(authorization)
  };
  return {
    ...authorization,
    signature: signature(
      runtimeAuthorizationSigningPayload(authorization),
      "runtime:key-1"
    )
  };
}

test("closed runtime loaders reconstruct immutable Kernel-subordinate state", () => {
  const reconstruction = reconstructionAt();
  const loaded = loadDemoRunState(canonicalJson(reconstruction.runState));
  assert.equal(Object.isFrozen(loaded), true);
  assert.equal(reconstruction.currentStage.stageId, "requirements-clarification");
  assert.equal(reconstruction.activationReady, true);
  assert.equal(reconstruction.reconciliation.length, 0);
  assert.equal(
    demoWorkflowConcurrencyKey({
      repositoryId: 1,
      workItemNodeId: "I_A/b"
    }),
    demoWorkflowConcurrencyKey({
      repositoryId: 1,
      workItemNodeId: "I_A/b"
    })
  );
  assert.notEqual(
    demoWorkflowConcurrencyKey({
      repositoryId: 1,
      workItemNodeId: "I_A/b"
    }),
    demoWorkflowConcurrencyKey({
      repositoryId: 1,
      workItemNodeId: "I_A_b"
    })
  );
  assert.equal(DEMO_WORKFLOW_CANCEL_IN_PROGRESS, false);
  assert.throws(
    () =>
      loadDemoRunState(
        canonicalJson(reconstruction.runState).replace(
          '"kind":"DemoRunState"',
          '"kind":"DemoRunState","kind":"DemoRunState"'
        )
      ),
    /duplicate JSON object key/u
  );
  assert.throws(
    () =>
      reconstructDemoRuntime({
        authority,
        runState: reconstruction.runState,
        kernelSnapshot: {
          ...reconstruction.kernelSnapshot,
          receiptHead: digest("substituted-head")
        },
        activationLease: reconstruction.activationLease,
        budget: reconstruction.budget,
        projection: reconstruction.projection,
        completedReceipts: reconstruction.completedReceipts,
        artifacts: reconstruction.artifacts,
        fences: reconstruction.fences,
        receiptVerifier: stageVerifier,
        evaluatedAt: NOW
      }),
    /authoritative Kernel/u
  );
});

test("dispatcher selects only the first incomplete canonical stage and persisted decisions", async () => {
  const reconstruction = reconstructionAt();
  const dispatched = dispatchDemoRuntime({ reconstruction, decidedAt: NOW });
  assert.equal(dispatched.decision.spec.action, "invoke-model");
  assert.deepEqual(dispatched.decision.spec.runtimeBinding, {
    agentId: "feature-delivery-requirements-clarification",
    capabilityId:
      "demo.feature-delivery.requirements-clarification@1.0.0",
    workflowId: "feature-delivery-requirements-clarification"
  });
  const store = new DispatchStore(
    reconstruction.runState.spec.generation
  );
  const receipt = await persistDemoDispatchDecision({
    result: dispatched,
    reconstruction,
    store,
    verifier
  });
  assert.equal(receipt.decisionDigest, dispatched.decision.contentDigest);
  const lagging = createDemoProjectionState({
    ...reconstruction.projection.spec,
    kernelStateVersion: reconstruction.kernelSnapshot.stateVersion - 1,
    kernelReceiptDigest: null,
    stageReceiptDigest: null,
    fields: reconstruction.projection.spec.fields.map((field) => ({
      ...field,
      value: null
    }))
  });
  const laggingState = reconstructionAt({ projection: lagging });
  assert.equal(
    dispatchDemoRuntime({
      reconstruction: laggingState,
      decidedAt: NOW
    }).decision.spec.action,
    "project"
  );
  const revoked = reconstructionAt({
    lease: activationLease({ revoked: true })
  });
  const refused = dispatchDemoRuntime({ reconstruction: revoked, decidedAt: NOW });
  assert.equal(refused.decision.spec.action, "refuse");
  assert.equal(refused.refusal?.spec.code, "ACTIVATION_REQUIRED");
});

test("captured Kernel state reconciles to a ready deterministic intake cursor", async () => {
  const snapshot = kernelSnapshot("CAPTURED", 0);
  const prepared = runStateAt({ snapshot, ordinal: 1 });
  const lease = activationLease();
  let reconstruction = reconstructDemoRuntime({
    authority,
    runState: prepared.runState,
    kernelSnapshot: snapshot,
    activationLease: lease,
    budget: budgetFor(prepared.runState, snapshot, lease),
    projection: projectionFor(prepared.runState, snapshot),
    completedReceipts: [],
    artifacts: [],
    fences: [],
    receiptVerifier: stageVerifier,
    evaluatedAt: NOW
  });
  assert.equal(
    reconstruction.reconciliation.includes("KERNEL_CURSOR_MISMATCH"),
    false
  );
  const result = dispatchDemoRuntime({ reconstruction, decidedAt: NOW });
  assert.equal(result.decision.spec.action, "request-kernel-transition");
  assert.equal(
    result.decision.spec.kernelRouteId,
    "capture.request-activation"
  );
  assert.equal(result.decision.spec.reasonCode, "ACTIVATION_REQUEST_REQUIRED");
  const dispatchStore = new DispatchStore();
  const dispatchReceipt = await persistDemoDispatchDecision({
    result,
    reconstruction,
    store: dispatchStore,
    verifier
  });
  const requester = {
    id: "requester-1",
    class: "requester" as const,
    human: true,
    bot: false,
    roles: ["work-item-requester"],
    authorizationDigest: digest("requester-current-authorization")
  };
  const baseEvent: EventEnvelope = {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "KernelEvent",
    id: "event-request-activation",
    sequence: 1,
    occurredAt: NOW,
    expectedStateVersion: 0,
    type: "activation-requested",
    replacementAuthorityDigest: null,
    actor: requester,
    provenance: {
      source: "trusted-adapter",
      deliveryId: "delivery-request-activation",
      bindingDigest: snapshot.bindingDigest,
      payloadDigest: digest("pending")
    },
    cost: { calls: 0, tokens: 0, costUnits: 0, loops: 0 }
  };
  const event: EventEnvelope = {
    ...baseEvent,
    provenance: {
      ...baseEvent.provenance,
      payloadDigest: eventPayloadDigest(baseEvent)
    }
  };
  const evaluation = evaluatePersistedDemoKernelTransition({
    reconstruction,
    dispatchDecision: result.decision,
    dispatchPersistenceReceipt: dispatchReceipt,
    dispatchVerifier: verifier,
    event,
    context: {
      graph: lifecycle,
      workAccord: accord,
      policy: controlPolicy,
      registry: baseRegistry,
      domainPack: baseDomainPack,
      currentPhaseContract: null,
      destinationPhaseContract: null,
      activationLease: null,
      humanGateEvidence: [],
      contractRequirementEvidence: [],
      requesterId: "requester-1",
      evaluatedAt: NOW,
      retryableFailure: false,
      rebindAuthority: null
    }
  });
  assert.equal(
    evaluation.result.kind,
    "applied",
    evaluation.result.kind === "refused"
      ? JSON.stringify(evaluation.result.refusal)
      : ""
  );
  if (evaluation.result.kind !== "applied") return;
  const reconciled = await reconcileDemoRunStateFromKernel({
    reconstruction,
    kernelEvaluation: evaluation,
    kernelStore: new KernelStore(snapshot),
    runStateStore: new RunStateStore(reconstruction.runState)
  });
  assert.equal(reconciled.kind, "updated");
  if (reconciled.kind !== "updated") return;
  assert.equal(reconciled.runState.spec.core.state, "ACTIVATION_PENDING");
  assert.equal(reconciled.runState.spec.status, "ready");
  reconstruction = reconstructDemoRuntime({
    authority,
    runState: reconciled.runState,
    kernelSnapshot: evaluation.result.snapshot,
    activationLease: lease,
    budget: reconciled.budget,
    projection: projectionFor(prepared.runState, snapshot),
    completedReceipts: [],
    artifacts: [],
    fences: [],
    receiptVerifier: stageVerifier,
    evaluatedAt: NOW
  });
  const projected = deriveDemoProjectionState({
    reconstruction,
    observedAt: NOW
  });
  reconstruction = reconstructDemoRuntime({
    authority,
    runState: reconciled.runState,
    kernelSnapshot: evaluation.result.snapshot,
    activationLease: lease,
    budget: reconciled.budget,
    projection: projected,
    completedReceipts: [],
    artifacts: [],
    fences: [],
    receiptVerifier: stageVerifier,
    evaluatedAt: NOW
  });
  const intake = dispatchDemoRuntime({ reconstruction, decidedAt: NOW });
  assert.equal(intake.decision.spec.action, "run-deterministic");
  assert.equal(intake.decision.spec.reasonCode, "DETERMINISTIC_STAGE_READY");
});

test("pre-authorized activation requires exact consent and reconciles one durable claim", async () => {
  const store = new ActivationClaimStore();
  store.ambiguous = true;
  const activated = await activationGrant(store);
  assert.equal(activated.grant.spec.claimKey, activated.receipt.claim.claimKey);
  assert.equal(store.calls, 1);
  const callsBefore = store.calls;
  await assert.rejects(
    () =>
      activateDemoIssue({
        authority,
        request: {
          ...activationRequest(),
          consent: {
            field: "demo-consent",
            accepted: true,
            evidenceDigest: "invalid" as Digest
          }
        },
        signedLease: activated.signedLease,
        runState: activated.runState,
        budget: activated.budget,
        priorBudget: null,
        recoveryBudgetEvidence: null,
        recoveryBudgetVerifier: verifier,
        leaseVerifier: verifier,
        claimStore: store,
        claimVerifier: verifier
      }),
    /source, submitter, or explicit consent/u
  );
  assert.equal(store.calls, callsBefore);
  await assert.rejects(
    () =>
      activateDemoIssue({
        authority,
        request: { ...activationRequest(), submitterId: 999 },
        signedLease: activated.signedLease,
        runState: activated.runState,
        budget: activated.budget,
        priorBudget: null,
        recoveryBudgetEvidence: null,
        recoveryBudgetVerifier: verifier,
        leaseVerifier: verifier,
        claimStore: store,
        claimVerifier: verifier
      }),
    /source, submitter, or explicit consent/u
  );
  assert.equal(store.calls, callsBefore);
});

class FenceStore implements DemoRunFenceStore {
  readonly supportsAtomicCompareAndSwap = true;
  snapshot: {
    readonly fence: DemoRunFence;
    readonly runState: DemoRunState;
  } | null = null;

  async acquire(input: {
    readonly expectedRunStateDigest: Digest;
    readonly fence: DemoRunFence;
    readonly runningState: DemoRunState;
  }) {
    if (this.snapshot !== null) {
      return { status: "conflict" as const, snapshot: null };
    }
    assert.equal(
      input.runningState.spec.fenceBaseRunStateDigest,
      input.expectedRunStateDigest
    );
    this.snapshot = {
      fence: input.fence,
      runState: input.runningState
    };
    return { status: "appended" as const, snapshot: this.snapshot };
  }

  async release(input: {
    readonly expectedFenceDigest: Digest;
    readonly releasedFence: DemoRunFence;
    readonly runningState: DemoRunState;
  }) {
    if (
      this.snapshot === null ||
      this.snapshot.fence.contentDigest !== input.expectedFenceDigest
    ) {
      return { status: "conflict" as const, snapshot: null };
    }
    this.snapshot = {
      fence: input.releasedFence,
      runState: input.runningState
    };
    return { status: "appended" as const, snapshot: this.snapshot };
  }

  async read() {
    return this.snapshot;
  }
}

class BudgetLedger implements DemoBudgetLedger {
  reserveCalls = 0;
  settleCalls = 0;
  lastReserve: {
    readonly before: DemoBudgetState;
    readonly after: DemoBudgetState;
    readonly evidence: Omit<DemoBudgetReservationEvidence, "signature">;
  } | null = null;
  lastSettle: {
    readonly before: DemoBudgetState;
    readonly after: DemoBudgetState;
    readonly evidence: Omit<DemoBudgetSettlementEvidence, "signature">;
  } | null = null;

  constructor(public state: DemoBudgetState) {}

  async reserve(input: {
    readonly expected: DemoBudgetState;
    readonly next: DemoBudgetState;
    readonly evidence: Omit<DemoBudgetReservationEvidence, "signature">;
  }) {
    this.reserveCalls += 1;
    if (this.state.contentDigest !== input.expected.contentDigest) {
      return {
        status: "conflict" as const,
        budget: null,
        evidence: null
      };
    }
    this.lastReserve = {
      before: input.expected,
      after: input.next,
      evidence: input.evidence
    };
    this.state = input.next;
    return {
      status: "appended" as const,
      budget: this.state,
      evidence: {
        ...input.evidence,
        signature: signature(input.evidence)
      }
    };
  }

  async settle(input: {
    readonly expected: DemoBudgetState;
    readonly next: DemoBudgetState;
    readonly evidence: Omit<DemoBudgetSettlementEvidence, "signature">;
  }) {
    this.settleCalls += 1;
    if (this.state.contentDigest !== input.expected.contentDigest) {
      return {
        status: "conflict" as const,
        budget: null,
        evidence: null
      };
    }
    this.lastSettle = {
      before: input.expected,
      after: input.next,
      evidence: input.evidence
    };
    this.state = input.next;
    return {
      status: "appended" as const,
      budget: this.state,
      evidence: {
        ...input.evidence,
        signature: signature(input.evidence)
      }
    };
  }

  async read(): Promise<DemoBudgetState> {
    return this.state;
  }
}

class FaultySettlementBudgetLedger extends BudgetLedger {
  constructor(
    state: DemoBudgetState,
    readonly fault: "substituted-state" | "invalid-evidence"
  ) {
    super(state);
  }

  override async settle(input: {
    readonly expected: DemoBudgetState;
    readonly next: DemoBudgetState;
    readonly evidence: Omit<DemoBudgetSettlementEvidence, "signature">;
  }) {
    this.settleCalls += 1;
    if (this.state.contentDigest !== input.expected.contentDigest) {
      return {
        status: "conflict" as const,
        budget: null,
        evidence: null
      };
    }
    if (this.fault === "substituted-state") {
      const substituted = createDemoBudgetState({
        ...input.next.spec,
        ledgerVersion: input.next.spec.ledgerVersion + 1,
        ledgerHead: digest("substituted-settlement-ledger")
      });
      return {
        status: "appended" as const,
        budget: substituted,
        evidence: {
          ...input.evidence,
          signature: signature(input.evidence)
        }
      };
    }
    const invalidEvidence = {
      ...input.evidence,
      costUnits: input.evidence.costUnits + 1
    };
    return {
      status: "appended" as const,
      budget: input.next,
      evidence: {
        ...invalidEvidence,
        signature: signature(invalidEvidence)
      }
    };
  }
}

class UsageLedger implements DemoProviderUsageLedger {
  beginCalls = 0;
  reconcileCalls = 0;

  constructor(readonly unknownUsage = false) {}

  async begin(
    attempt: Omit<DemoProviderAttemptEvidence, "signature">
  ): Promise<DemoProviderAttemptEvidence> {
    this.beginCalls += 1;
    return { ...attempt, signature: signature(attempt) };
  }

  async reconcile(
    attempt: DemoProviderAttemptEvidence
  ): Promise<DemoProviderUsageEvidence> {
    this.reconcileCalls += 1;
    const payload = this.unknownUsage
      ? {
          schemaVersion: "1.0.0" as const,
          attemptDigest: digest(attempt),
          status: "unknown" as const,
          calls: null,
          tokens: null,
          costUnits: null,
          providerUsageDigest: null,
          observedAt: NOW
        }
      : {
          schemaVersion: "1.0.0" as const,
          attemptDigest: digest(attempt),
          status: "settled" as const,
          calls: 1 as const,
          tokens: 100,
          costUnits: 3,
          providerUsageDigest: digest("provider-usage"),
          observedAt: NOW
        };
    return { ...payload, signature: signature(payload) };
  }
}

class StageInvoker implements DemoStageInvocationPort {
  calls = 0;

  async invoke(
    input: Parameters<DemoStageInvocationPort["invoke"]>[0]
  ): Promise<Awaited<ReturnType<DemoStageInvocationPort["invoke"]>>> {
    this.calls += 1;
    return {
      artifact: createDemoContract("StageArtifactEnvelope", {
        demoProjectId: "feature-delivery",
        stageId: input.stageId,
        projectProfileDigest: contracts.profile.contentDigest,
        journeyDefinitionDigest: contracts.journey.contentDigest,
        stageAgentBindingsDigest: contracts.bindings.contentDigest,
        authorityEpoch: 1,
        generation: 0,
        runId: "demo-run-1",
        runAttempt: 1,
        producer: {
          kind: "model",
          agentId: input.runtimeBinding.agentId,
          capabilityId: input.runtimeBinding.capabilityId,
          workflowId: input.runtimeBinding.workflowId
        },
        inputDigest: digest("model-input"),
        artifact: {
          kind: "SyntheticModelArtifact",
          schemaVersion: "1.0.0",
          mediaType: "application/json",
          byteLength: 10,
          contentDigest: digest("model-artifact")
        },
        createdAt: NOW
      }),
      output: {
        summary: "Bounded stage output.",
        result: { status: "success", details: "Complete." }
      }
    };
  }
}

async function persistedModelDispatch(
  reconstruction: DemoRuntimeReconstruction
): Promise<{
  readonly decision: ReturnType<typeof dispatchDemoRuntime>["decision"];
  readonly receipt: DemoDispatchPersistenceReceipt;
}> {
  const result = dispatchDemoRuntime({ reconstruction, decidedAt: NOW });
  const store = new DispatchStore(
    reconstruction.runState.spec.generation
  );
  return {
    decision: result.decision,
    receipt: await persistDemoDispatchDecision({
      result,
      reconstruction,
      store,
      verifier
    })
  };
}

test("cross-workflow scheduler permits one fence winner and settles authenticated usage", async () => {
  const reconstruction = reconstructionAt();
  const persisted = await persistedModelDispatch(reconstruction);
  const activation = await activationGrant();
  const fenceStore = new FenceStore();
  const budgetLedger = new BudgetLedger(reconstruction.budget);
  const usageLedger = new UsageLedger();
  const invoker = new StageInvoker();
  const refresh = async (): Promise<DemoRuntimeReconstruction> => {
    const snapshot = fenceStore.snapshot;
    assert.ok(snapshot);
    const evidence = historicalEvidence({
      snapshot: reconstruction.kernelSnapshot,
      ordinal: 2
    });
    return reconstructDemoRuntime({
      authority,
      runState: snapshot.runState,
      kernelSnapshot: reconstruction.kernelSnapshot,
      activationLease: reconstruction.activationLease,
      budget: budgetLedger.state,
      projection: reconstruction.projection,
      completedReceipts: evidence.receipts,
      artifacts: evidence.artifacts,
      fences: [snapshot.fence],
      receiptVerifier: stageVerifier,
      evaluatedAt: NOW
    });
  };
  const invoke = () =>
    scheduleDemoDispatch({
      reconstruction,
      refresh,
      dispatchDecision: persisted.decision,
      dispatchPersistenceReceipt: persisted.receipt,
      dispatchVerifier: verifier,
      activationGrant: activation.grant,
      activationClaimReceipt: activation.receipt,
      activationClaimVerifier: verifier,
      holderDigest: digest("workflow-holder"),
      decidedAt: NOW,
      fenceStore,
      budgetLedger,
      budgetVerifier: verifier,
      usageLedger,
      usageVerifier: verifier,
      invoker,
      clock: { now: () => NOW }
    });
  const results = await Promise.all([invoke(), invoke()]);
  assert.equal(
    results.filter((result) => result.kind === "invoked").length,
    1
  );
  assert.equal(
    results.filter(
      (result) =>
        result.kind === "reconciliation-required" &&
        result.reason === "FENCE_CONFLICT"
    ).length,
    1
  );
  assert.equal(invoker.calls, 1);
  assert.equal(budgetLedger.reserveCalls, 1);
  assert.equal(budgetLedger.settleCalls, 1);
  assert.equal(usageLedger.beginCalls, 1);
  assert.equal(usageLedger.reconcileCalls, 1);
  assert.ok(budgetLedger.lastReserve);
  assert.equal(
    budgetLedger.lastReserve.after.spec.ledgerHead,
    digest({
      domain: "agentic-framework.demo-budget-ledger.v1",
      previousHead: budgetLedger.lastReserve.before.spec.ledgerHead,
      operationDigest: digest({
        ...budgetLedger.lastReserve.evidence,
        budgetAfterDigest: null
      })
    })
  );
  assert.ok(budgetLedger.lastSettle);
  assert.equal(
    budgetLedger.lastSettle.after.spec.ledgerHead,
    digest({
      domain: "agentic-framework.demo-budget-ledger.v1",
      previousHead: budgetLedger.lastSettle.before.spec.ledgerHead,
      operationDigest: digest({
        operation: "settle-demo-stage-cost",
        reservationDigest:
          budgetLedger.lastSettle.evidence.reservationDigest,
        usageDigest: budgetLedger.lastSettle.evidence.usageDigest
      })
    })
  );
});

test("activation budget lineage remains valid after an earlier stage settlement", async () => {
  const snapshot = kernelSnapshot("FRAMING", 2);
  const prepared = runStateAt({ snapshot, ordinal: 3 });
  const lease = activationLease();
  const pristine = budgetFor(prepared.runState, snapshot, lease);
  const advancedBudget = createDemoBudgetState({
    ...pristine.spec,
    usage: { calls: 1, tokens: 100, costUnits: 3, retries: 0 },
    ledgerVersion: 2,
    ledgerHead: digest("prior-stage-settlement")
  });
  const reconstruction = reconstructDemoRuntime({
    authority,
    runState: prepared.runState,
    kernelSnapshot: snapshot,
    activationLease: lease,
    budget: advancedBudget,
    projection: projectionFor(prepared.runState, snapshot),
    completedReceipts: prepared.evidence.receipts,
    artifacts: prepared.evidence.artifacts,
    fences: prepared.evidence.fences,
    receiptVerifier: stageVerifier,
    evaluatedAt: NOW
  });
  const persisted = await persistedModelDispatch(reconstruction);
  const activation = await activationGrant();
  const fenceStore = new FenceStore();
  const budgetLedger = new BudgetLedger(advancedBudget);
  const usageLedger = new UsageLedger();
  const invoker = new StageInvoker();
  const result = await scheduleDemoDispatch({
    reconstruction,
    refresh: async () => {
      assert.ok(fenceStore.snapshot);
      return reconstructDemoRuntime({
        authority,
        runState: fenceStore.snapshot.runState,
        kernelSnapshot: snapshot,
        activationLease: lease,
        budget: budgetLedger.state,
        projection: reconstruction.projection,
        completedReceipts: prepared.evidence.receipts,
        artifacts: prepared.evidence.artifacts,
        fences: [
          ...prepared.evidence.fences,
          fenceStore.snapshot.fence
        ],
        receiptVerifier: stageVerifier,
        evaluatedAt: NOW
      });
    },
    dispatchDecision: persisted.decision,
    dispatchPersistenceReceipt: persisted.receipt,
    dispatchVerifier: verifier,
    activationGrant: activation.grant,
    activationClaimReceipt: activation.receipt,
    activationClaimVerifier: verifier,
    holderDigest: digest("later-stage-holder"),
    decidedAt: NOW,
    fenceStore,
    budgetLedger,
    budgetVerifier: verifier,
    usageLedger,
    usageVerifier: verifier,
    invoker,
    clock: { now: () => NOW }
  });
  assert.equal(result.kind, "invoked");
  assert.equal(invoker.calls, 1);
});

test("unknown provider usage remains held and never becomes a successful stage", async () => {
  const reconstruction = reconstructionAt();
  const persisted = await persistedModelDispatch(reconstruction);
  const activation = await activationGrant();
  const fenceStore = new FenceStore();
  const budgetLedger = new BudgetLedger(reconstruction.budget);
  const usageLedger = new UsageLedger(true);
  const invoker = new StageInvoker();
  const result = await scheduleDemoDispatch({
    reconstruction,
    refresh: async () => {
      assert.ok(fenceStore.snapshot);
      const evidence = historicalEvidence({
        snapshot: reconstruction.kernelSnapshot,
        ordinal: 2
      });
      return reconstructDemoRuntime({
        authority,
        runState: fenceStore.snapshot.runState,
        kernelSnapshot: reconstruction.kernelSnapshot,
        activationLease: reconstruction.activationLease,
        budget: budgetLedger.state,
        projection: reconstruction.projection,
        completedReceipts: evidence.receipts,
        artifacts: evidence.artifacts,
        fences: [fenceStore.snapshot.fence],
        receiptVerifier: stageVerifier,
        evaluatedAt: NOW
      });
    },
    dispatchDecision: persisted.decision,
    dispatchPersistenceReceipt: persisted.receipt,
    dispatchVerifier: verifier,
    activationGrant: activation.grant,
    activationClaimReceipt: activation.receipt,
    activationClaimVerifier: verifier,
    holderDigest: digest("workflow-holder"),
    decidedAt: NOW,
    fenceStore,
    budgetLedger,
    budgetVerifier: verifier,
    usageLedger,
    usageVerifier: verifier,
    invoker,
    clock: { now: () => NOW }
  });
  assert.equal(result.kind, "reconciliation-required");
  if (result.kind === "reconciliation-required") {
    assert.equal(result.reason, "USAGE_UNKNOWN");
    assert.equal(result.budget.spec.held.calls, 1);
  }
  assert.equal(budgetLedger.settleCalls, 0);
});

test("invalid settlement results never become returned budget authority", async () => {
  for (const fault of [
    "substituted-state",
    "invalid-evidence"
  ] as const) {
    const reconstruction = reconstructionAt();
    const persisted = await persistedModelDispatch(reconstruction);
    const activation = await activationGrant();
    const fenceStore = new FenceStore();
    const budgetLedger = new FaultySettlementBudgetLedger(
      reconstruction.budget,
      fault
    );
    const usageLedger = new UsageLedger();
    const invoker = new StageInvoker();
    await assert.rejects(
      () =>
        scheduleDemoDispatch({
          reconstruction,
          refresh: async () => {
            assert.ok(fenceStore.snapshot);
            return reconstructDemoRuntime({
              authority,
              runState: fenceStore.snapshot.runState,
              kernelSnapshot: reconstruction.kernelSnapshot,
              activationLease: reconstruction.activationLease,
              budget: budgetLedger.state,
              projection: reconstruction.projection,
              completedReceipts: reconstruction.completedReceipts,
              artifacts: reconstruction.artifacts,
              fences: [fenceStore.snapshot.fence],
              receiptVerifier: stageVerifier,
              evaluatedAt: NOW
            });
          },
          dispatchDecision: persisted.decision,
          dispatchPersistenceReceipt: persisted.receipt,
          dispatchVerifier: verifier,
          activationGrant: activation.grant,
          activationClaimReceipt: activation.receipt,
          activationClaimVerifier: verifier,
          holderDigest: digest(`faulty-settlement-${fault}`),
          decidedAt: NOW,
          fenceStore,
          budgetLedger,
          budgetVerifier: verifier,
          usageLedger,
          usageVerifier: verifier,
          invoker,
          clock: { now: () => NOW }
        }),
      fault === "substituted-state"
        ? /budget settlement persisted a substituted state/u
        : /budget settlement evidence is unsigned or does not match provider usage/u
    );
    assert.equal(budgetLedger.settleCalls, 1);
    assert.equal(budgetLedger.state.spec.held.calls, 1);
    assert.equal(budgetLedger.state.spec.usage.calls, 0);
  }
});

test("provider completion after the trusted deadline settles usage and releases the expired fence as failure", async () => {
  const reconstruction = reconstructionAt();
  const persisted = await persistedModelDispatch(reconstruction);
  const activation = await activationGrant();
  const fenceStore = new FenceStore();
  const budgetLedger = new BudgetLedger(reconstruction.budget);
  const usageLedger = new UsageLedger();
  const invoker = new StageInvoker();
  let clockReads = 0;
  const result = await scheduleDemoDispatch({
    reconstruction,
    refresh: async () => {
      assert.ok(fenceStore.snapshot);
      return reconstructDemoRuntime({
        authority,
        runState: fenceStore.snapshot.runState,
        kernelSnapshot: reconstruction.kernelSnapshot,
        activationLease: reconstruction.activationLease,
        budget: budgetLedger.state,
        projection: reconstruction.projection,
        completedReceipts: reconstruction.completedReceipts,
        artifacts: reconstruction.artifacts,
        fences: [fenceStore.snapshot.fence],
        receiptVerifier: stageVerifier,
        evaluatedAt: NOW
      });
    },
    dispatchDecision: persisted.decision,
    dispatchPersistenceReceipt: persisted.receipt,
    dispatchVerifier: verifier,
    activationGrant: activation.grant,
    activationClaimReceipt: activation.receipt,
    activationClaimVerifier: verifier,
    holderDigest: digest("late-provider-holder"),
    decidedAt: NOW,
    fenceStore,
    budgetLedger,
    budgetVerifier: verifier,
    usageLedger,
    usageVerifier: verifier,
    invoker,
    clock: {
      now: () =>
        clockReads++ < 3 ? NOW : "2026-08-29T12:20:00.000Z"
    }
  });
  assert.equal(result.kind, "provider-failed");
  if (result.kind === "provider-failed") {
    assert.equal(
      result.releasedFence?.spec.releasedAt,
      result.acquiredFence.spec.expiresAt
    );
    assert.equal(result.budget.spec.held.calls, 0);
    assert.equal(result.budget.spec.usage.calls, 1);
  }
});

test("scheduler revalidates lease and binding after awaited durable reservations", async () => {
  const reconstruction = reconstructionAt();
  const persisted = await persistedModelDispatch(reconstruction);
  const activation = await activationGrant();
  const fenceStore = new FenceStore();
  const budgetLedger = new BudgetLedger(reconstruction.budget);
  const usageLedger = new UsageLedger();
  const invoker = new StageInvoker();
  await assert.rejects(
    () =>
      scheduleDemoDispatch({
        reconstruction,
        refresh: async () => {
          assert.ok(fenceStore.snapshot);
          const refreshed = reconstructDemoRuntime({
            authority,
            runState: fenceStore.snapshot.runState,
            kernelSnapshot: reconstruction.kernelSnapshot,
            activationLease: reconstruction.activationLease,
            budget: budgetLedger.state,
            projection: reconstruction.projection,
            completedReceipts: reconstruction.completedReceipts,
            artifacts: reconstruction.artifacts,
            fences: [fenceStore.snapshot.fence],
            receiptVerifier: stageVerifier,
            evaluatedAt: NOW
          });
          return {
            ...refreshed,
            activationReady: false,
            activationReason: "LEASE_REVOKED"
          };
        },
        dispatchDecision: persisted.decision,
        dispatchPersistenceReceipt: persisted.receipt,
        dispatchVerifier: verifier,
        activationGrant: activation.grant,
        activationClaimReceipt: activation.receipt,
        activationClaimVerifier: verifier,
        holderDigest: digest("workflow-holder"),
        decidedAt: NOW,
        fenceStore,
        budgetLedger,
        budgetVerifier: verifier,
        usageLedger,
        usageVerifier: verifier,
        invoker,
        clock: { now: () => NOW }
      }),
    /activation grant is not current/u
  );
  assert.equal(invoker.calls, 0);
  assert.equal(usageLedger.beginCalls, 0);
});

class StageReceiptStore implements DemoStageReceiptStore {
  record: {
    readonly receipt: SignedStageReceipt;
    readonly runState: DemoRunState;
  } | null = null;

  constructor(readonly order: string[] | null = null) {}

  async append(input: {
    readonly expectedRunStateDigest: Digest;
    readonly receipt: SignedStageReceipt;
    readonly nextRunState: DemoRunState;
  }) {
    assert.equal(input.receipt.spec.runStateDigest, input.expectedRunStateDigest);
    if (this.record !== null) {
      return this.record.receipt.contentDigest === input.receipt.contentDigest
        ? { status: "existing" as const }
        : { status: "conflict" as const };
    }
    this.record = {
      receipt: input.receipt,
      runState: input.nextRunState
    };
    this.order?.push("stage-receipt");
    return { status: "appended" as const };
  }

  async read() {
    return this.record;
  }
}

class KernelStore implements DemoKernelStateStore {
  persistCalls = 0;

  constructor(
    public snapshot: KernelSnapshot,
    readonly order: string[] | null = null
  ) {}

  async persistApplied(
    result: Parameters<DemoKernelStateStore["persistApplied"]>[0]
  ) {
    this.persistCalls += 1;
    this.snapshot = result.snapshot;
    this.order?.push("kernel");
    return { status: "appended" as const };
  }

  async read(): Promise<KernelSnapshot> {
    return this.snapshot;
  }
}

class RecordingSingleWriter extends GitHubSingleWriter {
  calls = 0;
  plan: GitHubEffectPlan | null = null;

  constructor() {
    super(
      Object.create(
        GitHubAppCredentialBroker.prototype
      ) as GitHubAppCredentialBroker,
      {
        maxAttempts: 1,
        baseDelayMs: 0,
        maximumDelayMs: 0
      }
    );
  }

  override execute(
    _binding: TrustedGitHubBinding,
    plan: GitHubEffectPlan,
    claimantId: Digest
  ): Promise<GitHubExecutionResult> {
    assert.match(claimantId, /^sha256:[0-9a-f]{64}$/u);
    this.calls += 1;
    this.plan = plan;
    return Promise.resolve({
      kind: "applied",
      evidenceNodeId: "EVIDENCE_demo",
      effectNodeId: "EFFECT_demo",
      effectDigest: digest(plan.effect)
    });
  }
}

class RunStateStore implements DemoRunStateStore {
  constructor(public state: DemoRunState) {}

  async compareAndSwap(input: {
    readonly expectedRunStateDigest: Digest;
    readonly nextRunState: DemoRunState;
  }) {
    if (this.state.contentDigest !== input.expectedRunStateDigest) {
      return { status: "conflict" as const };
    }
    this.state = input.nextRunState;
    return { status: "appended" as const };
  }

  async read(): Promise<DemoRunState> {
    return this.state;
  }
}

class RecoveryBudgetStore implements DemoRecoveryBudgetStore {
  evidence: DemoRecoveryBudgetEvidence | null = null;
  ambiguousAfterCommit = false;
  wrongTransitionEvidence = false;
  readonly statuses: Array<"appended" | "existing" | "conflict"> = [];

  constructor(public state: DemoBudgetState) {}

  async record(input: {
    readonly expected: DemoBudgetState;
    readonly next: DemoBudgetState;
    readonly evidence: Omit<DemoRecoveryBudgetEvidence, "signature">;
  }) {
    if (this.state.contentDigest !== input.expected.contentDigest) {
      if (
        this.evidence !== null &&
        this.state.contentDigest === input.next.contentDigest
      ) {
        const {
          signature: _signature,
          ...persistedEvidence
        } = this.evidence;
        if (
          canonicalJson(persistedEvidence) === canonicalJson(input.evidence)
        ) {
          this.statuses.push("existing");
          return {
            status: "existing" as const,
            budget: this.state,
            evidence: this.evidence
          };
        }
      }
      this.statuses.push("conflict");
      return {
        status: "conflict" as const,
        budget: null,
        evidence: null
      };
    }
    this.state = input.next;
    const evidence = this.wrongTransitionEvidence
      ? {
          ...input.evidence,
          runStateDigest: digest("wrong-recovery-transition")
        }
      : input.evidence;
    this.evidence = {
      ...evidence,
      signature: signature(evidence)
    };
    if (this.ambiguousAfterCommit) {
      throw new DemoRecoveryBudgetPersistenceAmbiguousError();
    }
    this.statuses.push("appended");
    return {
      status: "appended" as const,
      budget: this.state,
      evidence: this.evidence
    };
  }

  async read(): Promise<DemoBudgetState> {
    return this.state;
  }

  async readEvidence(
    kernelReceiptDigest: Digest
  ): Promise<DemoRecoveryBudgetEvidence | null> {
    return this.evidence?.kernelReceiptDigest === kernelReceiptDigest
      ? this.evidence
      : null;
  }
}

test("same-core stage completion consumes persisted artifact and fence evidence exactly once", async () => {
  const base = reconstructionAt();
  const persisted = await persistedModelDispatch(base);
  const activation = await activationGrant();
  const fenceStore = new FenceStore();
  const budgetLedger = new BudgetLedger(base.budget);
  const usageLedger = new UsageLedger();
  const invoker = new StageInvoker();
  const scheduled = await scheduleDemoDispatch({
    reconstruction: base,
    refresh: async () => {
      assert.ok(fenceStore.snapshot);
      return reconstructDemoRuntime({
        authority,
        runState: fenceStore.snapshot.runState,
        kernelSnapshot: base.kernelSnapshot,
        activationLease: base.activationLease,
        budget: budgetLedger.state,
        projection: base.projection,
        completedReceipts: base.completedReceipts,
        artifacts: base.artifacts,
        fences: [fenceStore.snapshot.fence],
        receiptVerifier: stageVerifier,
        evaluatedAt: NOW
      });
    },
    dispatchDecision: persisted.decision,
    dispatchPersistenceReceipt: persisted.receipt,
    dispatchVerifier: verifier,
    activationGrant: activation.grant,
    activationClaimReceipt: activation.receipt,
    activationClaimVerifier: verifier,
    holderDigest: digest("workflow-holder"),
    decidedAt: NOW,
    fenceStore,
    budgetLedger,
    budgetVerifier: verifier,
    usageLedger,
    usageVerifier: verifier,
    invoker,
    clock: { now: () => NOW }
  });
  assert.equal(scheduled.kind, "invoked");
  if (scheduled.kind !== "invoked") return;
  const pending = reconstructDemoRuntime({
    authority,
    runState: scheduled.runningState,
    kernelSnapshot: base.kernelSnapshot,
    activationLease: base.activationLease,
    budget: scheduled.budget,
    projection: base.projection,
    completedReceipts: base.completedReceipts,
    artifacts: [...base.artifacts, scheduled.artifact],
    fences: [scheduled.acquiredFence, scheduled.releasedFence],
    receiptVerifier: stageVerifier,
    evaluatedAt: NOW
  });
  const followup = dispatchDemoRuntime({ reconstruction: pending, decidedAt: NOW });
  assert.equal(followup.decision.spec.action, "run-deterministic");
  assert.equal(followup.decision.spec.reasonCode, "STAGE_RECEIPT_READY");
  const receiptStore = new StageReceiptStore();
  const kernelStore = new KernelStore(base.kernelSnapshot);
  const completed = await completeDemoStage({
    reconstruction: pending,
    kernelEvaluation: null,
    kernelStore,
    receiptSigner: { sign: async (contentDigest) => signature(contentDigest) },
    receiptVerifier: stageVerifier,
    receiptStore,
    completedAt: NOW
  });
  assert.equal(kernelStore.persistCalls, 0);
  assert.equal(
    completed.runState.spec.journey.currentStageId,
    "codebase-discovery"
  );
  assert.equal(completed.runState.spec.core.stateVersion, 2);
  assert.equal(completed.runState.spec.fenceDigest, null);
  assert.equal(receiptStore.record?.receipt.contentDigest, completed.receipt.contentDigest);
});

function kernelFramingFixture(): {
  readonly authority: DemoRuntimeAuthority;
  readonly snapshot: KernelSnapshot;
  readonly lease: ActivationLease;
  readonly event: EventEnvelope;
  readonly context: KernelContext;
} {
  const framingCapabilities =
    contracts.bindings.spec.stageBindings.flatMap((entry) =>
      entry.runtimeBindings
        .filter((binding) => binding.phase === "framing")
        .map((binding) => binding.capability)
    );
  const allCapabilities =
    contracts.bindings.spec.stageBindings.flatMap((entry) =>
      entry.runtimeBindings.map((binding) => binding.capability)
    );
  const registry = assertDocument("CapabilityRegistry", {
    ...baseRegistry,
    capabilities: [
      ...baseRegistry.capabilities,
      ...contracts.capabilities.spec.capabilities
    ]
  });
  const domainPack = assertDocument("DomainPackPolicy", {
    ...baseDomainPack,
    allowedCapabilities: framingCapabilities
  });
  const framingPhase = assertDocument("PhaseContract", {
    ...baseFramingPhase,
    identity: {
      id: "demo.feature-delivery.framing",
      version: "1.0.0"
    },
    allowedCapabilities: framingCapabilities
  });
  const planningPhase = assertDocument("PhaseContract", {
    ...basePlanningPhase,
    identity: {
      id: "demo.feature-delivery.planning",
      version: "1.0.0"
    }
  });
  const workAccord = assertDocument("WorkAccord", {
    ...accord,
    binding: {
      ...accord.binding,
      policyDigest: digest(controlPolicy),
      lifecycleGraphDigest: digest(lifecycle)
    },
    policy: {
      ...accord.policy,
      domainPackDigest: digest(domainPack),
      capabilityRegistryDigest: digest(registry),
      phaseContracts: {
        ...accord.policy.phaseContracts,
        framing: {
          reference: `${framingPhase.identity.id}@${framingPhase.identity.version}`,
          digest: digest(framingPhase)
        },
        planning: {
          reference: `${planningPhase.identity.id}@${planningPhase.identity.version}`,
          digest: digest(planningPhase)
        }
      },
      requestedCapabilities: framingCapabilities
    },
    budget: {
      ...accord.budget,
      maxCalls: 5,
      maxTokens: 10_000,
      maxCostUnits: 100,
      maxDurationMs: 600_000,
      maxRetries: 1,
      maxParallel: 1
    }
  });
  const compiled = compilePolicy({
    enterprise: controlPolicy,
    accord: workAccord,
    phase: framingPhase,
    domainPack,
    registry
  });
  assert.equal(compiled.ok, true, compiled.ok ? "" : compiled.errors.join("; "));
  if (!compiled.ok) throw new Error("unreachable");
  const snapshot: KernelSnapshot = {
    schemaVersion: "1.0.0",
    lifecycleVersion: "1.0.0",
    lifecycleGraphDigest: digest(lifecycle),
    state: "FRAMING",
    phaseOwner: "framing",
    stateVersion: 4,
    lastEventSequence: 4,
    bindingDigest: digest({
      repositoryId: workAccord.binding.repositoryId,
      sourceDigest: workAccord.binding.sourceDigest,
      workItemNodeId: workAccord.binding.workItemNodeId
    }),
    workAccordDigest: digest(workAccord),
    capabilityRegistryDigest: digest(registry),
    domainPackDigest: digest(domainPack),
    phaseContractDigest: digest(framingPhase),
    compiledPolicyDigest: compiled.policy.digest,
    policyDigest: digest(controlPolicy),
    currentHead: workAccord.binding.currentHead,
    receiptHead: digest("kernel-framing-head"),
    suspendedState: null,
    recoveryState: null,
    usage: { calls: 0, tokens: 0, costUnits: 0, loops: 0, retries: 0 },
    phaseUsage: {
      calls: 0,
      tokens: 0,
      costUnits: 0,
      loops: 0,
      retries: 0
    },
    routeAttempts: {},
    processedEvents: {}
  };
  const lease: ActivationLease = {
    ...activationLease({}, workAccord),
    workAccordDigest: digest(workAccord),
    allowedCapabilities: allCapabilities
  };
  const reviewer = {
    id: "reviewer-1",
    class: "reviewer" as const,
    human: true,
    bot: false,
    roles: ["eligible-reviewer"],
    authorizationDigest: digest("reviewer-current-authorization")
  };
  const leaseApprover = {
    id: lease.approvedBy,
    class: "maintainer" as const,
    human: true,
    bot: false,
    roles: ["repository-maintainer"],
    authorizationDigest: lease.authorizationDigest
  };
  const baseEvent: EventEnvelope = {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "KernelEvent",
    id: "event-frame-accepted",
    sequence: 5,
    occurredAt: NOW,
    expectedStateVersion: 4,
    type: "frame-accepted",
    replacementAuthorityDigest: null,
    actor: reviewer,
    provenance: {
      source: "trusted-adapter",
      deliveryId: "delivery-frame-accepted",
      bindingDigest: snapshot.bindingDigest,
      payloadDigest: digest("pending")
    },
    cost: { calls: 0, tokens: 0, costUnits: 0, loops: 0 }
  };
  const event: EventEnvelope = {
    ...baseEvent,
    provenance: {
      ...baseEvent.provenance,
      payloadDigest: eventPayloadDigest(baseEvent)
    }
  };
  const requirement = (
    requirementType: ContractRequirementEvidence["requirementType"],
    name: string,
    phase: PhaseContract,
    actorAuthorizationDigest: Digest | null
  ): ContractRequirementEvidence => ({
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "ContractRequirementEvidence",
    requirementType,
    requirement: name,
    satisfied: true,
    workAccordDigest: snapshot.workAccordDigest,
    bindingDigest: snapshot.bindingDigest,
    snapshotDigest: digest(snapshot),
    phaseContractDigest: digest(phase),
    routeId: "framing.accept",
    activationLeaseDigest: null,
    currentHead: snapshot.currentHead,
    actorAuthorizationDigest,
    observedAt: "2026-08-29T12:09:00.000Z",
    expiresAt: LATER
  });
  const gate: HumanGateEvidence = {
    gate: "accept-frame",
    actor: reviewer,
    workAccordDigest: snapshot.workAccordDigest,
    activationLeaseDigest: null,
    currentHead: snapshot.currentHead,
    observedAt: "2026-08-29T12:09:00.000Z",
    expiresAt: LATER,
    valid: true
  };
  const activationGate: HumanGateEvidence = {
    gate: "activate",
    actor: leaseApprover,
    workAccordDigest: snapshot.workAccordDigest,
    activationLeaseDigest: digest(lease),
    currentHead: snapshot.currentHead,
    observedAt: "2026-08-29T12:09:00.000Z",
    expiresAt: LATER,
    valid: true
  };
  return {
    authority: {
      catalog,
      reservations,
      lifecycle,
      baseRegistry,
      contracts,
      workAccord
    },
    snapshot,
    lease,
    event,
    context: {
      graph: lifecycle,
      workAccord,
      policy: controlPolicy,
      registry,
      domainPack,
      currentPhaseContract: framingPhase,
      destinationPhaseContract: planningPhase,
      activationLease: lease,
      humanGateEvidence: [activationGate, gate],
      contractRequirementEvidence: [
        requirement(
          "predicate",
          "eligible-human-accepts-frame",
          framingPhase,
          reviewer.authorizationDigest
        ),
        requirement(
          "predicate",
          "work-accord-current",
          planningPhase,
          null
        ),
        requirement("evidence", "trusted-binding", planningPhase, null)
      ],
      requesterId: "requester-1",
      evaluatedAt: NOW,
      retryableFailure: false,
      rebindAuthority: null
    }
  };
}

type RecoverablePhase =
  | "framing"
  | "planning"
  | "execution"
  | "verification"
  | "human-review";

function kernelRecoveryFixture(input: {
  readonly phase: RecoverablePhase;
  readonly state:
    | "FRAMING"
    | "PLANNED"
    | "EXECUTING"
    | "VERIFYING"
    | "HUMAN_REVIEW";
  readonly ordinal: number;
}): {
  readonly authority: DemoRuntimeAuthority;
  readonly reconstruction: DemoRuntimeReconstruction;
  readonly lease: ActivationLease;
  readonly phaseContract: PhaseContract;
  readonly registry: CapabilityRegistry;
  readonly domainPack: DomainPackPolicy;
  readonly maintainer: EventEnvelope["actor"];
  readonly prepared: ReturnType<typeof runStateAt>;
} {
  const documents: Readonly<Record<RecoverablePhase, PhaseContract>> = {
    framing: baseFramingPhase,
    planning: basePlanningPhase,
    execution: baseExecutionPhase,
    verification: baseVerificationPhase,
    "human-review": baseHumanReviewPhase
  };
  const capabilitiesFor = (phase: RecoverablePhase): readonly string[] =>
    contracts.bindings.spec.stageBindings.flatMap((entry) =>
      entry.runtimeBindings
        .filter((binding) => binding.phase === phase)
        .map((binding) => binding.capability)
    );
  const phaseContracts = Object.fromEntries(
    (Object.keys(documents) as RecoverablePhase[]).map((phase) => [
      phase,
      assertDocument("PhaseContract", {
        ...documents[phase],
        identity: {
          id: `demo.feature-delivery.recovery-${phase}`,
          version: "1.0.0"
        },
        allowedCapabilities: capabilitiesFor(phase)
      })
    ])
  ) as Readonly<Record<RecoverablePhase, PhaseContract>>;
  const registry = assertDocument("CapabilityRegistry", {
    ...baseRegistry,
    capabilities: [
      ...baseRegistry.capabilities,
      ...contracts.capabilities.spec.capabilities
    ]
  });
  const allCapabilities =
    contracts.capabilities.spec.capabilities.map(
      (capability) => `${capability.id}@${capability.version}`
    );
  const domainPack = assertDocument("DomainPackPolicy", {
    ...baseDomainPack,
    allowedCapabilities: allCapabilities
  });
  const capabilityValues = contracts.capabilities.spec.capabilities;
  const tools = [
    ...new Set(capabilityValues.flatMap((capability) => capability.access.tools))
  ].sort();
  const mcpTools = [
    ...new Set(
      capabilityValues.flatMap((capability) => capability.access.mcpTools)
    )
  ].sort();
  const workAccord = assertDocument("WorkAccord", {
    ...accord,
    binding: {
      ...accord.binding,
      policyDigest: digest(controlPolicy),
      lifecycleGraphDigest: digest(lifecycle)
    },
    policy: {
      ...accord.policy,
      domainPackDigest: digest(domainPack),
      capabilityRegistryDigest: digest(registry),
      riskClass: "high",
      privacyClass: "confidential",
      phaseContracts: Object.fromEntries(
        (Object.keys(phaseContracts) as RecoverablePhase[]).map((phase) => {
          const contract = phaseContracts[phase];
          return [
            phase,
            {
              reference: `${contract.identity.id}@${contract.identity.version}`,
              digest: digest(contract)
            }
          ];
        })
      ),
      requestedCapabilities: allCapabilities,
      tools,
      mcpTools
    },
    budget: {
      ...accord.budget,
      maxCalls: 5,
      maxTokens: 10_000,
      maxCostUnits: 100,
      maxDurationMs: 600_000,
      maxRetries: 1,
      maxParallel: 1
    }
  });
  const phaseContract = phaseContracts[input.phase];
  const compiled = compilePolicy({
    enterprise: controlPolicy,
    accord: workAccord,
    phase: phaseContract,
    domainPack,
    registry
  });
  assert.equal(compiled.ok, true, compiled.ok ? "" : compiled.errors.join("; "));
  if (!compiled.ok) throw new Error("unreachable");
  const snapshot: KernelSnapshot = {
    schemaVersion: "1.0.0",
    lifecycleVersion: "1.0.0",
    lifecycleGraphDigest: digest(lifecycle),
    state: "BLOCKED",
    phaseOwner: "kernel",
    stateVersion: 20 + input.ordinal,
    lastEventSequence: 20 + input.ordinal,
    bindingDigest: digest({
      repositoryId: workAccord.binding.repositoryId,
      sourceDigest: workAccord.binding.sourceDigest,
      workItemNodeId: workAccord.binding.workItemNodeId
    }),
    workAccordDigest: digest(workAccord),
    capabilityRegistryDigest: digest(registry),
    domainPackDigest: digest(domainPack),
    phaseContractDigest: digest(phaseContract),
    compiledPolicyDigest: compiled.policy.digest,
    policyDigest: digest(controlPolicy),
    currentHead: workAccord.binding.currentHead,
    receiptHead: digest(`blocked-recover-${input.phase}-head`),
    suspendedState: null,
    recoveryState: input.state,
    usage: { calls: 1, tokens: 100, costUnits: 3, loops: 0, retries: 0 },
    phaseUsage:
      input.phase === "planning" || input.phase === "human-review"
        ? {
            calls: 0,
            tokens: 0,
            costUnits: 0,
            loops: 0,
            retries: 0
          }
        : {
            calls: 1,
            tokens: 100,
            costUnits: 3,
            loops: 0,
            retries: 0
          },
    routeAttempts: {},
    processedEvents: {}
  };
  const lease = activationLease({}, workAccord);
  const prepared = runStateAt({
    snapshot,
    ordinal: input.ordinal,
    status: "blocked"
  });
  const authority: DemoRuntimeAuthority = {
    catalog,
    reservations,
    lifecycle,
    baseRegistry,
    contracts,
    workAccord
  };
  const reconstruction = reconstructDemoRuntime({
    authority,
    runState: prepared.runState,
    kernelSnapshot: snapshot,
    activationLease: lease,
    budget: budgetFor(prepared.runState, snapshot, lease, workAccord),
    projection: projectionFor(prepared.runState, snapshot),
    completedReceipts: prepared.evidence.receipts,
    artifacts: prepared.evidence.artifacts,
    fences: prepared.evidence.fences,
    receiptVerifier: stageVerifier,
    evaluatedAt: NOW
  });
  const maintainer = {
    id: lease.approvedBy,
    class: "maintainer" as const,
    human: true,
    bot: false,
    roles: ["repository-maintainer"],
    authorizationDigest: lease.authorizationDigest
  };
  return {
    authority,
    reconstruction,
    lease,
    phaseContract,
    registry,
    domainPack,
    maintainer,
    prepared
  };
}

test("cross-core completion persists the actual evaluateTransition result before its stage receipt", async () => {
  const fixture = kernelFramingFixture();
  const history = historicalEvidence({
    snapshot: fixture.snapshot,
    ordinal: 4
  });
  const base = runStateAt({
    snapshot: fixture.snapshot,
    ordinal: 4,
    evidence: history
  }).runState;
  const acquired = createDemoContract("DemoRunFence", {
    demoProjectId: "feature-delivery",
    repositoryId: base.spec.repositoryId,
    workItemNodeId: base.spec.workItemNodeId,
    fenceKey: digest({
      repositoryId: base.spec.repositoryId,
      workItemNodeId: base.spec.workItemNodeId
    }),
    authorityEpoch: 1,
    generation: 0,
    runId: base.spec.runId,
    runAttempt: base.spec.runAttempt,
    runStateDigest: base.contentDigest,
    dispatchDecisionDigest: digest("model-stage-dispatch"),
    holderDigest: digest("model-stage-holder"),
    activationLeaseDigest: digest(fixture.lease),
    previousFenceDigest: history.fences.at(-1)?.contentDigest ?? null,
    status: "acquired",
    acquiredAt: "2026-08-29T12:07:00.000Z",
    expiresAt: "2026-08-29T12:20:00.000Z",
    releasedAt: null
  });
  const running = createDemoContract("DemoRunState", {
    ...base.spec,
    fenceDigest: acquired.contentDigest,
    fenceBaseRunStateDigest: base.contentDigest,
    status: "running",
    updatedAt: "2026-08-29T12:07:00.000Z"
  });
  const released = createDemoContract("DemoRunFence", {
    ...acquired.spec,
    previousFenceDigest: acquired.contentDigest,
    status: "released",
    releasedAt: "2026-08-29T12:09:00.000Z"
  });
  const binding = contracts.bindings.spec.stageBindings[3]?.runtimeBindings[0];
  assert.ok(binding);
  const artifact = createDemoContract("StageArtifactEnvelope", {
    demoProjectId: "feature-delivery",
    stageId: "solution-design",
    projectProfileDigest: contracts.profile.contentDigest,
    journeyDefinitionDigest: contracts.journey.contentDigest,
    stageAgentBindingsDigest: contracts.bindings.contentDigest,
    authorityEpoch: 1,
    generation: 0,
    runId: running.spec.runId,
    runAttempt: running.spec.runAttempt,
    producer: {
      kind: "model",
      agentId: binding.agent,
      capabilityId: binding.capability,
      workflowId: binding.workflow
    },
    inputDigest: digest("solution-design-input"),
    artifact: {
      kind: "SyntheticSolutionDesign",
      schemaVersion: "1.0.0",
      mediaType: "application/json",
      byteLength: 10,
      contentDigest: digest("solution-design-artifact")
    },
    createdAt: "2026-08-29T12:08:00.000Z"
  });
  const budget = budgetFor(
    running,
    fixture.snapshot,
    fixture.lease,
    fixture.authority.workAccord
  );
  const reconstruction = reconstructDemoRuntime({
    authority: fixture.authority,
    runState: running,
    kernelSnapshot: fixture.snapshot,
    activationLease: fixture.lease,
    budget,
    projection: projectionFor(running, fixture.snapshot),
    completedReceipts: history.receipts,
    artifacts: [...history.artifacts, artifact],
    fences: [...history.fences, acquired, released],
    receiptVerifier: stageVerifier,
    evaluatedAt: NOW
  });
  const dispatched = dispatchDemoRuntime({ reconstruction, decidedAt: NOW });
  assert.equal(dispatched.decision.spec.action, "request-kernel-transition");
  assert.equal(dispatched.decision.spec.kernelRouteId, "framing.accept");
  const dispatchStore = new DispatchStore();
  const persistenceReceipt = await persistDemoDispatchDecision({
    result: dispatched,
    reconstruction,
    store: dispatchStore,
    verifier
  });
  const evaluation = evaluatePersistedDemoKernelTransition({
    reconstruction,
    dispatchDecision: dispatched.decision,
    dispatchPersistenceReceipt: persistenceReceipt,
    dispatchVerifier: verifier,
    event: fixture.event,
    context: fixture.context
  });
  assert.equal(
    evaluation.result.kind,
    "applied",
    evaluation.result.kind === "refused"
      ? JSON.stringify(evaluation.result.refusal)
      : ""
  );
  const order: string[] = [];
  const kernelStore = new KernelStore(fixture.snapshot, order);
  const receiptStore = new StageReceiptStore(order);
  const completed = await completeDemoStage({
    reconstruction,
    kernelEvaluation: evaluation,
    kernelStore,
    receiptSigner: { sign: async (contentDigest) => signature(contentDigest) },
    receiptVerifier: stageVerifier,
    receiptStore,
    completedAt: NOW
  });
  assert.deepEqual(order, ["kernel", "stage-receipt"]);
  assert.equal(completed.runState.spec.core.state, "PLANNED");
  assert.equal(
    completed.runState.spec.journey.currentStageId,
    "implementation-plan"
  );
  assert.equal(
    completed.receipt.spec.appliedKernelResultDigest,
    evaluation.result.kind === "applied" ? digest(evaluation.result) : null
  );
});

test("actual Kernel activation binds distinct GitHub and Kernel identities through the demo bridge", async () => {
  const fixture = kernelFramingFixture();
  const sourceSnapshot: KernelSnapshot = {
    ...fixture.snapshot,
    state: "ACTIVATION_PENDING",
    phaseOwner: "kernel",
    stateVersion: 1,
    lastEventSequence: 1,
    phaseContractDigest: null,
    compiledPolicyDigest: null,
    receiptHead: digest("capture-request-activation-receipt"),
    routeAttempts: {},
    processedEvents: {}
  };
  const source = runStateAt({
    snapshot: sourceSnapshot,
    ordinal: 1
  }).runState;
  const intakeArtifact = createDemoContract("StageArtifactEnvelope", {
    demoProjectId: "feature-delivery",
    stageId: "intake",
    projectProfileDigest: contracts.profile.contentDigest,
    journeyDefinitionDigest: contracts.journey.contentDigest,
    stageAgentBindingsDigest: contracts.bindings.contentDigest,
    authorityEpoch: 1,
    generation: 0,
    runId: source.spec.runId,
    runAttempt: source.spec.runAttempt,
    producer: {
      kind: "deterministic",
      agentId: null,
      capabilityId: null,
      workflowId: null
    },
    inputDigest: digest("intake-input"),
    artifact: {
      kind: "SyntheticIntake",
      schemaVersion: "1.0.0",
      mediaType: "application/json",
      byteLength: 1,
      contentDigest: digest("intake-artifact")
    },
    createdAt: "2026-08-29T12:08:00.000Z"
  });
  const sourceBudget = budgetFor(
    source,
    sourceSnapshot,
    fixture.lease,
    fixture.authority.workAccord
  );
  const sourceReconstruction = reconstructDemoRuntime({
    authority: fixture.authority,
    runState: source,
    kernelSnapshot: sourceSnapshot,
    activationLease: fixture.lease,
    budget: sourceBudget,
    projection: projectionFor(source, sourceSnapshot),
    completedReceipts: [],
    artifacts: [intakeArtifact],
    fences: [],
    receiptVerifier: stageVerifier,
    evaluatedAt: NOW
  });
  const dispatched = dispatchDemoRuntime({
    reconstruction: sourceReconstruction,
    decidedAt: NOW
  });
  assert.equal(dispatched.decision.spec.kernelRouteId, "activation.begin-framing");
  const dispatchStore = new DispatchStore();
  const dispatchReceipt = await persistDemoDispatchDecision({
    result: dispatched,
    reconstruction: sourceReconstruction,
    store: dispatchStore,
    verifier
  });
  const approver = {
    id: fixture.lease.approvedBy,
    class: "maintainer" as const,
    human: true,
    bot: false,
    roles: ["repository-maintainer"],
    authorizationDigest: fixture.lease.authorizationDigest
  };
  const baseEvent: EventEnvelope = {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "KernelEvent",
    id: "event-activation-approved",
    sequence: 2,
    occurredAt: NOW,
    expectedStateVersion: 1,
    type: "activation-approved",
    replacementAuthorityDigest: null,
    actor: approver,
    provenance: {
      source: "trusted-adapter",
      deliveryId: "delivery-activation-approved",
      bindingDigest: sourceSnapshot.bindingDigest,
      payloadDigest: digest("pending")
    },
    cost: { calls: 0, tokens: 0, costUnits: 0, loops: 0 }
  };
  const event: EventEnvelope = {
    ...baseEvent,
    provenance: {
      ...baseEvent.provenance,
      payloadDigest: eventPayloadDigest(baseEvent)
    }
  };
  const framingPhase = fixture.context.currentPhaseContract;
  assert.ok(framingPhase);
  const requirement = (
    requirementType: ContractRequirementEvidence["requirementType"],
    name: string
  ): ContractRequirementEvidence => ({
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "ContractRequirementEvidence",
    requirementType,
    requirement: name,
    satisfied: true,
    workAccordDigest: sourceSnapshot.workAccordDigest,
    bindingDigest: sourceSnapshot.bindingDigest,
    snapshotDigest: digest(sourceSnapshot),
    phaseContractDigest: digest(framingPhase),
    routeId: "activation.begin-framing",
    activationLeaseDigest:
      name === "activation-lease-current" || name === "activation-lease"
        ? digest(fixture.lease)
        : null,
    currentHead: sourceSnapshot.currentHead,
    actorAuthorizationDigest: null,
    observedAt: "2026-08-29T12:09:00.000Z",
    expiresAt: LATER
  });
  const activationGate: HumanGateEvidence = {
    gate: "activate",
    actor: approver,
    workAccordDigest: sourceSnapshot.workAccordDigest,
    activationLeaseDigest: digest(fixture.lease),
    currentHead: sourceSnapshot.currentHead,
    observedAt: "2026-08-29T12:09:00.000Z",
    expiresAt: LATER,
    valid: true
  };
  const context: KernelContext = {
    ...fixture.context,
    currentPhaseContract: null,
    destinationPhaseContract: framingPhase,
    humanGateEvidence: [activationGate],
    contractRequirementEvidence: [
      requirement("predicate", "activation-lease-current"),
      requirement("predicate", "work-accord-current"),
      requirement("evidence", "trusted-binding"),
      requirement("evidence", "activation-lease")
    ]
  };
  const evaluation = evaluatePersistedDemoKernelTransition({
    reconstruction: sourceReconstruction,
    dispatchDecision: dispatched.decision,
    dispatchPersistenceReceipt: dispatchReceipt,
    dispatchVerifier: verifier,
    event,
    context
  });
  assert.equal(
    evaluation.result.kind,
    "applied",
    evaluation.result.kind === "refused"
      ? JSON.stringify(evaluation.result.refusal)
      : ""
  );
  if (evaluation.result.kind !== "applied") return;
  const applied = evaluation.result;
  const binding: TrustedGitHubBinding = {
    repository: {
      id: accord.binding.repositoryId,
      nodeId: accord.binding.repositoryNodeId,
      owner: "example-organization",
      name: "hyperfinite",
      fullName: accord.binding.repositoryFullName
    },
    workItem: {
      kind: "issue",
      number: 25,
      nodeId: accord.binding.workItemNodeId
    },
    project: {
      ownerNodeId: "O_github",
      projectNodeId: "PVT_synthetic_demo",
      itemNodeId: "PVTI_synthetic_demo",
      schemaDigest: digest("project-schema"),
      bindingDigest: contracts.profile.spec.projectBindingDigest,
      fields: []
    },
    installation: {
      id: 1001,
      accountNodeId: "O_github",
      repositorySelection: "selected",
      repositoryIds: [accord.binding.repositoryId]
    }
  };
  const trustedBinding = issueTrustedDemoRuntimeBinding({
    catalog,
    reservations,
    lifecycle,
    baseRegistry,
    contracts,
    stageId: "requirements-clarification"
  });
  const modelBinding = trustedBinding.binding;
  const runtimeState: CopilotRuntimeState = {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "CopilotRuntimeState",
    schemaVersion: "2.0.0",
    repositoryId: binding.repository.id,
    repositoryFullName: binding.repository.fullName,
    workItemNodeId: binding.workItem.nodeId,
    projectNodeId: binding.project.projectNodeId,
    projectItemNodeId: binding.project.itemNodeId,
    bindingDigest: digest(binding),
    kernelBindingDigest: applied.snapshot.bindingDigest,
    workAccordSourceDigest:
      fixture.authority.workAccord.binding.sourceDigest,
    state: "FRAMING",
    phase: "framing",
    role: "framer",
    capability: modelBinding.capability,
    contractRevision: fixture.authority.workAccord.identity.revision,
    workAccordDigest: digest(fixture.authority.workAccord),
    policyDigest: digest(runtimePolicy),
    kernelPolicyDigest: digest(controlPolicy),
    activationLeaseDigest: digest(fixture.lease),
    kernelReceiptDigest: applied.receiptDigest,
    kernelRouteId: applied.route.id,
    workflowId: modelBinding.workflow,
    activationNonce: "demo_runtime_activation_nonce_000001",
    currentHead: null,
    executionContext: null,
    remainingAiCredits: 500,
    repairCount: 0,
    recursionDepth: 0,
    expiresAt: LATER,
    signature: signature("runtime-state", "state:key-1")
  };
  const request: RuntimeActivationRequest = {
    enabled: true,
    eventName: "issue_comment",
    eventAction: "created",
    actorId: 101,
    actorLogin: "maintainer",
    actorIsBot: false,
    actorPermission: "write",
    repositoryId: binding.repository.id,
    repositoryFullName: binding.repository.fullName,
    workItemKind: "issue",
    workItemNumber: 25,
    workItemNodeId: binding.workItem.nodeId,
    projectNodeId: binding.project.projectNodeId,
    projectItemNodeId: binding.project.itemNodeId,
    bindingDigest: runtimeState.bindingDigest,
    kernelBindingDigest: runtimeState.kernelBindingDigest,
    workAccordSourceDigest: runtimeState.workAccordSourceDigest,
    phase: "framing",
    role: "framer",
    capability: modelBinding.capability,
    workflowId: modelBinding.workflow,
    workflowRef: `${binding.repository.fullName}/.github/workflows/${modelBinding.workflow}.lock.yml@refs/heads/main`,
    workflowSha: "1111111111111111111111111111111111111111",
    defaultBranch: "main",
    runId: 9001,
    runAttempt: 1,
    workAccordDigest: runtimeState.workAccordDigest,
    policyDigest: runtimeState.policyDigest,
    kernelPolicyDigest: runtimeState.kernelPolicyDigest,
    activationLeaseDigest: runtimeState.activationLeaseDigest,
    activationNonce: runtimeState.activationNonce,
    reservedAiCredits: 500,
    currentHead: null
  };
  const candidate = validateRuntimePreActivation(
    runtimePolicy,
    request,
    {
      state: runtimeState,
      stateSignatureVerified: true,
      stateAuthorApplicationId: 1,
      stateAuthorId: 2,
      expectedApplicationId: 1,
      expectedAuthorId: 2,
      allowedActorIds: [101],
      stateCommentId: 1,
      stateCommentUpdatedAt: NOW,
      stateCollectionEtag: '"demo-runtime-state"'
    },
    controlPolicy,
    { now: () => NOW },
    [trustedBinding]
  );
  assert.throws(
    () =>
      validateRuntimePreActivation(
        runtimePolicy,
        {
          ...request,
          bindingDigest: request.kernelBindingDigest,
          kernelBindingDigest: request.bindingDigest
        },
        {
          state: {
            ...runtimeState,
            bindingDigest: runtimeState.kernelBindingDigest,
            kernelBindingDigest: runtimeState.bindingDigest
          },
          stateSignatureVerified: true,
          stateAuthorApplicationId: 1,
          stateAuthorId: 2,
          expectedApplicationId: 1,
          expectedAuthorId: 2,
          allowedActorIds: [101],
          stateCommentId: 1,
          stateCommentUpdatedAt: NOW,
          stateCollectionEtag: '"demo-runtime-state"'
        },
        controlPolicy,
        { now: () => NOW },
        [trustedBinding]
      ),
    /activation\.binding/u
  );
  const {
    kernelBindingDigest: _legacyStateKernelBinding,
    ...legacyState
  } = runtimeState;
  assert.throws(
    () => assertDocument("CopilotRuntimeState", legacyState),
    /kernelBindingDigest/u
  );
  const authorization = signedRuntimeAuthorization(candidate);
  validateRuntimeAuthorizationIntegrity(
    authorization,
    runtimeAuthorizationVerifier
  );
  bindKernelAuthorization(
    authorization,
    applied,
    runtimeAuthorizationVerifier,
    runtimePolicy
  );
  const output = {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "GitHubSafeOutput",
    schemaVersion: "1.0.0",
    summary: "Requirements are bounded.",
    findings: [],
    openQuestions: [],
    result: { status: "success", details: "Ready for the next stage." }
  } as const;
  const plan = bridgeRuntimeOutput({
    authorization,
    authorizationVerifier: runtimeAuthorizationVerifier,
    kernelResult: applied,
    policy: runtimePolicy,
    redemptionDigest: digest(authorization),
    threatEvidence: {
      status: "success",
      inputDigest: authorization.authorizationDigest,
      outputDigest: digest(output),
      checkedAt: NOW
    },
    output,
    binding,
    trustedDemoBinding: trustedBinding,
    eventId: authorization.redemptionKey,
    receiptHead: applied.receiptDigest,
    attempt: authorization.runAttempt,
    clock: { now: () => NOW }
  });
  assert.equal(plan.effect.type, "issue-comment");
  const writer = new RecordingSingleWriter();
  const executed = await executeDemoBridgedEffect({
    kernelEvaluation: evaluation,
    kernelStore: new KernelStore(applied.snapshot),
    authorization,
    authorizationVerifier: runtimeAuthorizationVerifier,
    runtimePolicy,
    redemptionDigest: digest(authorization),
    threatEvidence: {
      status: "success",
      inputDigest: authorization.authorizationDigest,
      outputDigest: digest(output),
      checkedAt: NOW
    },
    output,
    binding,
    trustedDemoBinding: trustedBinding,
    eventId: authorization.redemptionKey,
    receiptHead: applied.receiptDigest,
    attempt: authorization.runAttempt,
    clock: { now: () => NOW },
    writer
  });
  assert.equal(writer.calls, 1);
  assert.equal(executed.result.kind, "applied");
  assert.equal(executed.plan.effect.type, "issue-comment");

  assert.throws(
    () =>
      bridgeRuntimeOutput({
        authorization,
        authorizationVerifier: runtimeAuthorizationVerifier,
        kernelResult: applied,
        policy: runtimePolicy,
        redemptionDigest: digest(authorization),
        threatEvidence: {
          status: "success",
          inputDigest: authorization.authorizationDigest,
          outputDigest: digest(output),
          checkedAt: NOW
        },
        output,
        binding: {
          ...binding,
          workItem: { ...binding.workItem, nodeId: "I_substituted" }
        },
        trustedDemoBinding: trustedBinding,
        eventId: authorization.redemptionKey,
        receiptHead: applied.receiptDigest,
        attempt: authorization.runAttempt,
        clock: { now: () => NOW }
      }),
    /bridge\.binding/u
  );
  const wrongKernelBinding = signedRuntimeAuthorization(candidate, {
    kernelBindingDigest: digest("substituted-kernel-binding")
  });
  assert.throws(
    () =>
      bindKernelAuthorization(
        wrongKernelBinding,
        applied,
        runtimeAuthorizationVerifier,
        runtimePolicy
      ),
    /authorization-integrity/u
  );
  const swapped = signedRuntimeAuthorization(candidate, {
    bindingDigest: candidate.kernelBindingDigest,
    kernelBindingDigest: candidate.bindingDigest
  });
  assert.throws(
    () =>
      bindKernelAuthorization(
        swapped,
        applied,
        runtimeAuthorizationVerifier,
        runtimePolicy
      ),
    /authorization-integrity/u
  );
  const copiedReceipt = {
    ...applied,
    snapshot: {
      ...applied.snapshot,
      bindingDigest: digest("copied-receipt-wrong-binding")
    }
  };
  assert.throws(
    () =>
      bindKernelAuthorization(
        authorization,
        copiedReceipt,
        runtimeAuthorizationVerifier,
        runtimePolicy
      ),
    /kernel-receipt/u
  );
  const forgedCandidatePayload = {
    ...candidate,
    kernelBindingDigest: digest("forged-candidate-kernel-binding")
  };
  const {
    candidateDigest: _candidateDigest,
    ...forgedCandidateWithoutDigest
  } = forgedCandidatePayload;
  assert.notEqual(
    candidate.candidateDigest,
    runtimeAuthorizationCandidateDigest(forgedCandidateWithoutDigest)
  );
  assert.throws(
    () =>
      validateRuntimeAuthorizationIntegrity(
        {
          ...authorization,
          kernelBindingDigest: digest("forged-signature-binding")
        },
        runtimeAuthorizationVerifier
      ),
    /authorization-integrity/u
  );
  assert.throws(
      () =>
        validateRuntimeAuthorizationIntegrity(
          {
            ...authorization,
            signature: {
              ...authorization.signature,
              value: "Zm9yZ2Vk"
            }
          },
          runtimeAuthorizationVerifier
        ),
      /authorization-signature/u
  );
  const {
      kernelBindingDigest: _legacyAuthorizationKernelBinding,
      ...legacyAuthorization
  } = authorization;
  assert.throws(
      () =>
        assertDocument(
          "CopilotRuntimeAuthorization",
          legacyAuthorization
        ),
      /kernelBindingDigest/u
  );
});

async function evaluateControlRoute(input: {
  readonly reconstruction: DemoRuntimeReconstruction;
  readonly routeId: string;
  readonly event: EventEnvelope;
  readonly context: KernelContext;
}) {
  const result = {
    decision: createDemoContract("DemoDispatchDecision", {
      demoProjectId: "feature-delivery",
      runStateDigest: input.reconstruction.runState.contentDigest,
      stageId: input.reconstruction.currentStage.stageId,
      stageOrdinal: input.reconstruction.currentStage.ordinal,
      action: "request-kernel-transition",
      runtimeBinding: null,
      selectionGrantDigest: null,
      kernelRouteId: input.routeId,
      refusalDigest: null,
      reasonCode: "KERNEL_CONTROL_EVENT",
      decidedAt: input.event.occurredAt
    }),
    refusal: null
  };
  const store = new DispatchStore(
    input.reconstruction.runState.spec.generation
  );
  const receipt = await persistDemoDispatchDecision({
    result,
    reconstruction: input.reconstruction,
    store,
    verifier
  });
  return evaluatePersistedDemoKernelTransition({
    reconstruction: input.reconstruction,
    dispatchDecision: result.decision,
    dispatchPersistenceReceipt: receipt,
    dispatchVerifier: verifier,
    event: input.event,
    context: input.context
  });
}

function controlEvent(input: {
  readonly snapshot: KernelSnapshot;
  readonly type: EventEnvelope["type"];
  readonly actor: EventEnvelope["actor"];
  readonly id: string;
}): EventEnvelope {
  const base: EventEnvelope = {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "KernelEvent",
    id: input.id,
    sequence: input.snapshot.lastEventSequence + 1,
    occurredAt: NOW,
    expectedStateVersion: input.snapshot.stateVersion,
    type: input.type,
    replacementAuthorityDigest: null,
    actor: input.actor,
    provenance: {
      source: "trusted-adapter",
      deliveryId: `delivery-${input.id}`,
      bindingDigest: input.snapshot.bindingDigest,
      payloadDigest: digest("pending")
    },
    cost: { calls: 0, tokens: 0, costUnits: 0, loops: 0 }
  };
  return {
    ...base,
    provenance: {
      ...base.provenance,
      payloadDigest: eventPayloadDigest(base)
    }
  };
}

test("pause, resume, block, retry, and cancel preserve or invalidate the demo cursor from Kernel state", async () => {
  const fixture = kernelFramingFixture();
  const prepared = runStateAt({ snapshot: fixture.snapshot, ordinal: 2 });
  const budget = budgetFor(
    prepared.runState,
    fixture.snapshot,
    fixture.lease,
    fixture.authority.workAccord
  );
  let reconstruction = reconstructDemoRuntime({
    authority: fixture.authority,
    runState: prepared.runState,
    kernelSnapshot: fixture.snapshot,
    activationLease: fixture.lease,
    budget,
    projection: projectionFor(prepared.runState, fixture.snapshot),
    completedReceipts: prepared.evidence.receipts,
    artifacts: prepared.evidence.artifacts,
    fences: prepared.evidence.fences,
    receiptVerifier: stageVerifier,
    evaluatedAt: NOW
  });
  const maintainer = {
    id: fixture.lease.approvedBy,
    class: "maintainer" as const,
    human: true,
    bot: false,
    roles: ["repository-maintainer"],
    authorizationDigest: fixture.lease.authorizationDigest
  };
  const system = {
    id: "kernel-system",
    class: "system" as const,
    human: false,
    bot: false,
    roles: ["trusted-kernel"],
    authorizationDigest: digest("kernel-system-authorization")
  };
  const activationGate: HumanGateEvidence = {
    gate: "activate",
    actor: maintainer,
    workAccordDigest: fixture.snapshot.workAccordDigest,
    activationLeaseDigest: digest(fixture.lease),
    currentHead: fixture.snapshot.currentHead,
    observedAt: "2026-08-29T12:09:00.000Z",
    expiresAt: LATER,
    valid: true
  };
  const pause = await evaluateControlRoute({
    reconstruction,
    routeId: "framing.pause",
    event: controlEvent({
      snapshot: reconstruction.kernelSnapshot,
      type: "pause-requested",
      actor: maintainer,
      id: "pause"
    }),
    context: {
      ...fixture.context,
      destinationPhaseContract: null,
      contractRequirementEvidence: []
    }
  });
  assert.equal(pause.result.kind, "applied");
  if (pause.result.kind !== "applied") return;
  let kernelStore = new KernelStore(reconstruction.kernelSnapshot);
  let runStateStore = new RunStateStore(reconstruction.runState);
  const paused = await reconcileDemoRunStateFromKernel({
    reconstruction,
    kernelEvaluation: pause,
    kernelStore,
    runStateStore
  });
  assert.equal(paused.kind, "updated");
  if (paused.kind !== "updated") return;
  assert.equal(paused.runState.spec.core.state, "PAUSED");
  assert.equal(paused.runState.spec.journey.currentStageId, "requirements-clarification");
  assert.equal(paused.runState.spec.generation, 0);
  reconstruction = reconstructDemoRuntime({
    authority: fixture.authority,
    runState: paused.runState,
    kernelSnapshot: pause.result.snapshot,
    activationLease: fixture.lease,
    budget,
    projection: projectionFor(prepared.runState, fixture.snapshot),
    completedReceipts: prepared.evidence.receipts,
    artifacts: prepared.evidence.artifacts,
    fences: prepared.evidence.fences,
    receiptVerifier: stageVerifier,
    evaluatedAt: NOW
  });
  const resume = await evaluateControlRoute({
    reconstruction,
    routeId: "pause.resume-framing",
    event: controlEvent({
      snapshot: reconstruction.kernelSnapshot,
      type: "resume-requested",
      actor: maintainer,
      id: "resume"
    }),
    context: {
      ...fixture.context,
      currentPhaseContract: fixture.context.currentPhaseContract,
      destinationPhaseContract: fixture.context.currentPhaseContract,
      humanGateEvidence: [activationGate],
      contractRequirementEvidence: []
    }
  });
  assert.equal(
    resume.result.kind,
    "applied",
    resume.result.kind === "refused" ? JSON.stringify(resume.result.refusal) : ""
  );
  if (resume.result.kind !== "applied") return;
  kernelStore = new KernelStore(reconstruction.kernelSnapshot);
  runStateStore = new RunStateStore(reconstruction.runState);
  const resumed = await reconcileDemoRunStateFromKernel({
    reconstruction,
    kernelEvaluation: resume,
    kernelStore,
    runStateStore
  });
  assert.equal(resumed.kind, "updated");
  if (resumed.kind !== "updated") return;
  assert.equal(resumed.runState.spec.core.state, "FRAMING");
  assert.equal(resumed.runState.spec.runAttempt, 1);
  reconstruction = reconstructDemoRuntime({
    authority: fixture.authority,
    runState: resumed.runState,
    kernelSnapshot: resume.result.snapshot,
    activationLease: fixture.lease,
    budget,
    projection: projectionFor(prepared.runState, fixture.snapshot),
    completedReceipts: prepared.evidence.receipts,
    artifacts: prepared.evidence.artifacts,
    fences: prepared.evidence.fences,
    receiptVerifier: stageVerifier,
    evaluatedAt: NOW
  });
  const blockedEvaluation = await evaluateControlRoute({
    reconstruction,
    routeId: "framing.block",
    event: controlEvent({
      snapshot: reconstruction.kernelSnapshot,
      type: "dependency-blocked",
      actor: system,
      id: "block"
    }),
    context: {
      ...fixture.context,
      destinationPhaseContract: null,
      contractRequirementEvidence: []
    }
  });
  assert.equal(blockedEvaluation.result.kind, "applied");
  if (blockedEvaluation.result.kind !== "applied") return;
  kernelStore = new KernelStore(reconstruction.kernelSnapshot);
  runStateStore = new RunStateStore(reconstruction.runState);
  const blocked = await reconcileDemoRunStateFromKernel({
    reconstruction,
    kernelEvaluation: blockedEvaluation,
    kernelStore,
    runStateStore
  });
  assert.equal(blocked.kind, "updated");
  if (blocked.kind !== "updated") return;
  assert.equal(blocked.runState.spec.status, "blocked");
  reconstruction = reconstructDemoRuntime({
    authority: fixture.authority,
    runState: blocked.runState,
    kernelSnapshot: blockedEvaluation.result.snapshot,
    activationLease: fixture.lease,
    budget,
    projection: projectionFor(prepared.runState, fixture.snapshot),
    completedReceipts: prepared.evidence.receipts,
    artifacts: prepared.evidence.artifacts,
    fences: prepared.evidence.fences,
    receiptVerifier: stageVerifier,
    evaluatedAt: NOW
  });
  const retryEvaluation = await evaluateControlRoute({
    reconstruction,
    routeId: "blocked.retry-framing",
    event: controlEvent({
      snapshot: reconstruction.kernelSnapshot,
      type: "retry-requested",
      actor: maintainer,
      id: "retry"
    }),
    context: {
      ...fixture.context,
      currentPhaseContract: fixture.context.currentPhaseContract,
      destinationPhaseContract: fixture.context.currentPhaseContract,
      activationLease: fixture.lease,
      humanGateEvidence: [activationGate],
      contractRequirementEvidence: [],
      retryableFailure: true
    }
  });
  assert.equal(
    retryEvaluation.result.kind,
    "applied",
    retryEvaluation.result.kind === "refused"
      ? JSON.stringify(retryEvaluation.result.refusal)
      : ""
  );
  if (retryEvaluation.result.kind !== "applied") return;
  const wrongTransitionStore = new RecoveryBudgetStore(
    reconstruction.budget
  );
  wrongTransitionStore.wrongTransitionEvidence = true;
  await assert.rejects(
    () =>
      reconcileDemoRunStateFromKernel({
        reconstruction,
        kernelEvaluation: retryEvaluation,
        kernelStore: new KernelStore(reconstruction.kernelSnapshot),
        runStateStore: new RunStateStore(reconstruction.runState),
        recoveryBudgetStore: wrongTransitionStore,
        recoveryBudgetVerifier: verifier
      }),
    /recovery budget evidence is unsigned, stale, or substituted/u
  );
  kernelStore = new KernelStore(reconstruction.kernelSnapshot);
  runStateStore = new RunStateStore(reconstruction.runState);
  const recoveryBudgetStore = new RecoveryBudgetStore(
    reconstruction.budget
  );
  recoveryBudgetStore.ambiguousAfterCommit = true;
  const retried = await reconcileDemoRunStateFromKernel({
    reconstruction,
    kernelEvaluation: retryEvaluation,
    kernelStore,
    runStateStore,
    recoveryBudgetStore,
    recoveryBudgetVerifier: verifier
  });
  assert.equal(retried.kind, "updated");
  if (retried.kind !== "updated") return;
  assert.equal(retried.runState.spec.runAttempt, 2);
  assert.equal(retried.runState.spec.generation, 1);
  assert.equal(retried.budget.spec.generation, 1);
  assert.equal(retried.budget.spec.usage.retries, 1);
  assert.equal(
    retried.budget.spec.ledgerVersion,
    reconstruction.budget.spec.ledgerVersion + 1
  );
  assert.notEqual(retried.budget.spec.ledgerHead, null);
  const replayedRetry = await reconcileDemoRunStateFromKernel({
    reconstruction,
    kernelEvaluation: retryEvaluation,
    kernelStore: new KernelStore(reconstruction.kernelSnapshot),
    runStateStore: new RunStateStore(reconstruction.runState),
    recoveryBudgetStore,
    recoveryBudgetVerifier: verifier
  });
  assert.equal(replayedRetry.kind, "updated");
  if (replayedRetry.kind === "updated") {
    assert.equal(
      replayedRetry.budget.contentDigest,
      retried.budget.contentDigest
    );
    assert.equal(replayedRetry.budget.spec.usage.retries, 1);
  }
  assert.deepEqual(recoveryBudgetStore.statuses, ["existing"]);
  assert.ok(recoveryBudgetStore.evidence);
  const retryActivationRequest = {
    ...activationRequest(),
    sourceEventDigest: digest("retry-reactivation"),
    generation: 1
  };
  const retrySignedLease = await issueSignedDemoActivationLease({
    authority: fixture.authority,
    request: retryActivationRequest,
    lease: fixture.lease,
    issuedAt: NOW,
    signer
  });
  const retryGrant = await activateDemoIssue({
    authority: fixture.authority,
    request: retryActivationRequest,
    signedLease: retrySignedLease,
    runState: retried.runState,
    budget: retried.budget,
    priorBudget: reconstruction.budget,
    recoveryBudgetEvidence: recoveryBudgetStore.evidence,
    recoveryBudgetVerifier: verifier,
    leaseVerifier: verifier,
    claimStore: new ActivationClaimStore(),
    claimVerifier: verifier
  });
  assert.equal(retryGrant.spec.generation, 1);
  await assert.rejects(
    () =>
      activateDemoIssue({
        authority: fixture.authority,
        request: {
          ...retryActivationRequest,
          sourceEventDigest: digest("stale-retry-reactivation"),
          generation: 0
        },
        signedLease: retrySignedLease,
        runState: retried.runState,
        budget: retried.budget,
        priorBudget: reconstruction.budget,
        recoveryBudgetEvidence: recoveryBudgetStore.evidence,
        recoveryBudgetVerifier: verifier,
        leaseVerifier: verifier,
        claimStore: new ActivationClaimStore(),
        claimVerifier: verifier
      }),
    /activation does not bind the exact catalog, profile, authority, and work item/u
  );
  reconstruction = reconstructDemoRuntime({
    authority: fixture.authority,
    runState: retried.runState,
    kernelSnapshot: retryEvaluation.result.snapshot,
    activationLease: fixture.lease,
    budget: retried.budget,
    projection: projectionFor(prepared.runState, fixture.snapshot),
    completedReceipts: prepared.evidence.receipts,
    artifacts: prepared.evidence.artifacts,
    fences: prepared.evidence.fences,
    receiptVerifier: stageVerifier,
    evaluatedAt: NOW
  });
  const cancelEvaluation = await evaluateControlRoute({
    reconstruction,
    routeId: "framing.cancel",
    event: controlEvent({
      snapshot: reconstruction.kernelSnapshot,
      type: "cancel-requested",
      actor: maintainer,
      id: "cancel"
    }),
    context: {
      ...fixture.context,
      destinationPhaseContract: null,
      contractRequirementEvidence: []
    }
  });
  assert.equal(cancelEvaluation.result.kind, "applied");
  if (cancelEvaluation.result.kind !== "applied") return;
  kernelStore = new KernelStore(reconstruction.kernelSnapshot);
  runStateStore = new RunStateStore(reconstruction.runState);
  const cancelled = await reconcileDemoRunStateFromKernel({
    reconstruction,
    kernelEvaluation: cancelEvaluation,
    kernelStore,
    runStateStore
  });
  assert.equal(cancelled.kind, "updated");
  if (cancelled.kind === "updated") {
    assert.equal(cancelled.runState.spec.status, "cancelled");
    assert.equal(
      cancelled.runState.spec.journey.currentStageId,
      "requirements-clarification"
    );
  }
});

test("planning resume restores a ready cursor and converges a lagging PAUSED projection", async () => {
  const fixture = kernelFramingFixture();
  const planningPhase = fixture.context.destinationPhaseContract;
  assert.ok(planningPhase);
  const compiled = compilePolicy({
    enterprise: controlPolicy,
    accord: fixture.authority.workAccord,
    phase: planningPhase,
    domainPack: fixture.context.domainPack,
    registry: fixture.context.registry
  });
  assert.equal(compiled.ok, true, compiled.ok ? "" : compiled.errors.join("; "));
  if (!compiled.ok) return;
  const snapshot: KernelSnapshot = {
    ...fixture.snapshot,
    state: "PLANNED",
    phaseOwner: "planning",
    stateVersion: 8,
    lastEventSequence: 8,
    phaseContractDigest: digest(planningPhase),
    compiledPolicyDigest: compiled.policy.digest,
    receiptHead: digest("planning-pause-source-head"),
    phaseUsage: {
      calls: 0,
      tokens: 0,
      costUnits: 0,
      loops: 0,
      retries: 0
    }
  };
  const prepared = runStateAt({ snapshot, ordinal: 5, status: "ready" });
  const budget = budgetFor(
    prepared.runState,
    snapshot,
    fixture.lease,
    fixture.authority.workAccord
  );
  let reconstruction = reconstructDemoRuntime({
    authority: fixture.authority,
    runState: prepared.runState,
    kernelSnapshot: snapshot,
    activationLease: fixture.lease,
    budget,
    projection: projectionFor(prepared.runState, snapshot),
    completedReceipts: prepared.evidence.receipts,
    artifacts: prepared.evidence.artifacts,
    fences: prepared.evidence.fences,
    receiptVerifier: stageVerifier,
    evaluatedAt: NOW
  });
  const maintainer = {
    id: fixture.lease.approvedBy,
    class: "maintainer" as const,
    human: true,
    bot: false,
    roles: ["repository-maintainer"],
    authorizationDigest: fixture.lease.authorizationDigest
  };
  const activationGate: HumanGateEvidence = {
    gate: "activate",
    actor: maintainer,
    workAccordDigest: snapshot.workAccordDigest,
    activationLeaseDigest: digest(fixture.lease),
    currentHead: snapshot.currentHead,
    observedAt: "2026-08-29T12:09:00.000Z",
    expiresAt: LATER,
    valid: true
  };
  const pause = await evaluateControlRoute({
    reconstruction,
    routeId: "planning.pause",
    event: controlEvent({
      snapshot,
      type: "pause-requested",
      actor: maintainer,
      id: "planning-pause"
    }),
    context: {
      ...fixture.context,
      currentPhaseContract: planningPhase,
      destinationPhaseContract: null,
      contractRequirementEvidence: []
    }
  });
  assert.equal(pause.result.kind, "applied");
  if (pause.result.kind !== "applied") return;
  const paused = await reconcileDemoRunStateFromKernel({
    reconstruction,
    kernelEvaluation: pause,
    kernelStore: new KernelStore(snapshot),
    runStateStore: new RunStateStore(reconstruction.runState)
  });
  assert.equal(paused.kind, "updated");
  if (paused.kind !== "updated") return;
  const pausedProjection = deriveDemoProjectionState({
    reconstruction: reconstructDemoRuntime({
      authority: fixture.authority,
      runState: paused.runState,
      kernelSnapshot: pause.result.snapshot,
      activationLease: fixture.lease,
      budget,
      projection: projectionFor(prepared.runState, snapshot),
      completedReceipts: prepared.evidence.receipts,
      artifacts: prepared.evidence.artifacts,
      fences: prepared.evidence.fences,
      receiptVerifier: stageVerifier,
      evaluatedAt: NOW
    }),
    observedAt: NOW
  });
  assert.equal(
    pausedProjection.spec.fields.find((field) => field.key === "stage")?.value,
    "PAUSED"
  );
  reconstruction = reconstructDemoRuntime({
    authority: fixture.authority,
    runState: paused.runState,
    kernelSnapshot: pause.result.snapshot,
    activationLease: fixture.lease,
    budget,
    projection: pausedProjection,
    completedReceipts: prepared.evidence.receipts,
    artifacts: prepared.evidence.artifacts,
    fences: prepared.evidence.fences,
    receiptVerifier: stageVerifier,
    evaluatedAt: NOW
  });
  const resume = await evaluateControlRoute({
    reconstruction,
    routeId: "pause.resume-planning",
    event: controlEvent({
      snapshot: reconstruction.kernelSnapshot,
      type: "resume-requested",
      actor: maintainer,
      id: "planning-resume"
    }),
    context: {
      ...fixture.context,
      currentPhaseContract: planningPhase,
      destinationPhaseContract: planningPhase,
      activationLease: fixture.lease,
      humanGateEvidence: [activationGate],
      contractRequirementEvidence: []
    }
  });
  assert.equal(
    resume.result.kind,
    "applied",
    resume.result.kind === "refused" ? JSON.stringify(resume.result.refusal) : ""
  );
  if (resume.result.kind !== "applied") return;
  const resumed = await reconcileDemoRunStateFromKernel({
    reconstruction,
    kernelEvaluation: resume,
    kernelStore: new KernelStore(reconstruction.kernelSnapshot),
    runStateStore: new RunStateStore(reconstruction.runState)
  });
  assert.equal(resumed.kind, "updated");
  if (resumed.kind !== "updated") return;
  assert.equal(resumed.runState.spec.status, "ready");
  const resumedReconstruction = reconstructDemoRuntime({
    authority: fixture.authority,
    runState: resumed.runState,
    kernelSnapshot: resume.result.snapshot,
    activationLease: fixture.lease,
    budget,
    projection: pausedProjection,
    completedReceipts: prepared.evidence.receipts,
    artifacts: prepared.evidence.artifacts,
    fences: prepared.evidence.fences,
    receiptVerifier: stageVerifier,
    evaluatedAt: NOW
  });
  assert.equal(
    resumedReconstruction.reconciliation.includes("PROJECTION_AHEAD"),
    false
  );
  const projectionResult = await convergeDemoProjection({
    reconstruction: resumedReconstruction,
    port: new ProjectionPort(pausedProjection),
    observedAt: NOW
  });
  assert.equal(projectionResult.kind, "converged");
  if (projectionResult.kind === "converged") {
    assert.equal(
      projectionResult.projection.spec.fields.find(
        (field) => field.key === "stage"
      )?.value,
      "PLANNED"
    );
  }
});

test("review blocking persists blocked status over the human stage kind", async () => {
  const fixture = kernelFramingFixture();
  const humanReviewPhase = assertDocument(
    "PhaseContract",
    humanReviewPhaseDocument
  );
  const compiled = compilePolicy({
    enterprise: controlPolicy,
    accord: fixture.authority.workAccord,
    phase: humanReviewPhase,
    domainPack: fixture.context.domainPack,
    registry: fixture.context.registry
  });
  assert.equal(compiled.ok, true, compiled.ok ? "" : compiled.errors.join("; "));
  if (!compiled.ok) return;
  const snapshot: KernelSnapshot = {
    ...fixture.snapshot,
    state: "HUMAN_REVIEW",
    phaseOwner: "human-review",
    stateVersion: 10,
    lastEventSequence: 10,
    phaseContractDigest: digest(humanReviewPhase),
    compiledPolicyDigest: compiled.policy.digest,
    receiptHead: digest("human-review-block-source"),
    phaseUsage: {
      calls: 0,
      tokens: 0,
      costUnits: 0,
      loops: 0,
      retries: 0
    }
  };
  const prepared = runStateAt({
    snapshot,
    ordinal: 8,
    status: "waiting-human"
  });
  const reconstruction = reconstructDemoRuntime({
    authority: fixture.authority,
    runState: prepared.runState,
    kernelSnapshot: snapshot,
    activationLease: fixture.lease,
    budget: budgetFor(
      prepared.runState,
      snapshot,
      fixture.lease,
      fixture.authority.workAccord
    ),
    projection: projectionFor(prepared.runState, snapshot),
    completedReceipts: prepared.evidence.receipts,
    artifacts: prepared.evidence.artifacts,
    fences: prepared.evidence.fences,
    receiptVerifier: stageVerifier,
    evaluatedAt: NOW
  });
  const system = {
    id: "kernel-system",
    class: "system" as const,
    human: false,
    bot: false,
    roles: ["trusted-kernel"],
    authorizationDigest: digest("kernel-system-review-block")
  };
  const evaluation = await evaluateControlRoute({
    reconstruction,
    routeId: "review.block",
    event: controlEvent({
      snapshot,
      type: "dependency-blocked",
      actor: system,
      id: "review-block"
    }),
    context: {
      ...fixture.context,
      currentPhaseContract: humanReviewPhase,
      destinationPhaseContract: null,
      contractRequirementEvidence: []
    }
  });
  assert.equal(evaluation.result.kind, "applied");
  if (evaluation.result.kind !== "applied") return;
  const blocked = await reconcileDemoRunStateFromKernel({
    reconstruction,
    kernelEvaluation: evaluation,
    kernelStore: new KernelStore(snapshot),
    runStateStore: new RunStateStore(reconstruction.runState)
  });
  assert.equal(blocked.kind, "updated");
  if (blocked.kind === "updated") {
    assert.equal(blocked.runState.spec.core.state, "BLOCKED");
    assert.equal(blocked.runState.spec.status, "blocked");
    assert.equal(blocked.runState.spec.journey.currentStageId, "human-review");
  }
});

test("blocked cancellation is terminal without rotating generation or requiring a budget store", async () => {
  const fixture = kernelFramingFixture();
  const prepared = runStateAt({ snapshot: fixture.snapshot, ordinal: 2 });
  const budget = budgetFor(
    prepared.runState,
    fixture.snapshot,
    fixture.lease,
    fixture.authority.workAccord
  );
  let reconstruction = reconstructDemoRuntime({
    authority: fixture.authority,
    runState: prepared.runState,
    kernelSnapshot: fixture.snapshot,
    activationLease: fixture.lease,
    budget,
    projection: projectionFor(prepared.runState, fixture.snapshot),
    completedReceipts: prepared.evidence.receipts,
    artifacts: prepared.evidence.artifacts,
    fences: prepared.evidence.fences,
    receiptVerifier: stageVerifier,
    evaluatedAt: NOW
  });
  const system = {
    id: "kernel-system",
    class: "system" as const,
    human: false,
    bot: false,
    roles: ["trusted-kernel"],
    authorizationDigest: digest("blocked-cancel-system")
  };
  const maintainer = {
    id: fixture.lease.approvedBy,
    class: "maintainer" as const,
    human: true,
    bot: false,
    roles: ["repository-maintainer"],
    authorizationDigest: fixture.lease.authorizationDigest
  };
  const blockedEvaluation = await evaluateControlRoute({
    reconstruction,
    routeId: "framing.block",
    event: controlEvent({
      snapshot: reconstruction.kernelSnapshot,
      type: "dependency-blocked",
      actor: system,
      id: "blocked-cancel-block"
    }),
    context: {
      ...fixture.context,
      destinationPhaseContract: null,
      contractRequirementEvidence: []
    }
  });
  assert.equal(blockedEvaluation.result.kind, "applied");
  if (blockedEvaluation.result.kind !== "applied") return;
  const blocked = await reconcileDemoRunStateFromKernel({
    reconstruction,
    kernelEvaluation: blockedEvaluation,
    kernelStore: new KernelStore(reconstruction.kernelSnapshot),
    runStateStore: new RunStateStore(reconstruction.runState)
  });
  assert.equal(blocked.kind, "updated");
  if (blocked.kind !== "updated") return;
  reconstruction = reconstructDemoRuntime({
    authority: fixture.authority,
    runState: blocked.runState,
    kernelSnapshot: blockedEvaluation.result.snapshot,
    activationLease: fixture.lease,
    budget: blocked.budget,
    projection: projectionFor(prepared.runState, fixture.snapshot),
    completedReceipts: prepared.evidence.receipts,
    artifacts: prepared.evidence.artifacts,
    fences: prepared.evidence.fences,
    receiptVerifier: stageVerifier,
    evaluatedAt: NOW
  });
  const cancelEvaluation = await evaluateControlRoute({
    reconstruction,
    routeId: "blocked.cancel",
    event: controlEvent({
      snapshot: reconstruction.kernelSnapshot,
      type: "cancel-requested",
      actor: maintainer,
      id: "blocked-cancel"
    }),
    context: {
      ...fixture.context,
      destinationPhaseContract: null,
      contractRequirementEvidence: []
    }
  });
  assert.equal(cancelEvaluation.result.kind, "applied");
  if (cancelEvaluation.result.kind !== "applied") return;
  const cancelled = await reconcileDemoRunStateFromKernel({
    reconstruction,
    kernelEvaluation: cancelEvaluation,
    kernelStore: new KernelStore(reconstruction.kernelSnapshot),
    runStateStore: new RunStateStore(reconstruction.runState)
  });
  assert.equal(cancelled.kind, "updated");
  if (cancelled.kind !== "updated") return;
  assert.equal(cancelled.runState.spec.core.state, "CANCELLED");
  assert.equal(cancelled.runState.spec.status, "cancelled");
  assert.equal(
    cancelled.runState.spec.generation,
    reconstruction.runState.spec.generation
  );
  assert.equal(
    cancelled.runState.spec.runAttempt,
    reconstruction.runState.spec.runAttempt
  );
  assert.equal(
    cancelled.budget.contentDigest,
    reconstruction.budget.contentDigest
  );
  const terminal = reconstructDemoRuntime({
    authority: fixture.authority,
    runState: cancelled.runState,
    kernelSnapshot: cancelEvaluation.result.snapshot,
    activationLease: fixture.lease,
    budget: cancelled.budget,
    projection: reconstruction.projection,
    completedReceipts: prepared.evidence.receipts,
    artifacts: prepared.evidence.artifacts,
    fences: prepared.evidence.fences,
    receiptVerifier: stageVerifier,
    evaluatedAt: NOW
  });
  const decision = dispatchDemoRuntime({ reconstruction: terminal, decidedAt: NOW });
  assert.equal(decision.decision.spec.action, "noop");
  assert.equal(decision.decision.spec.reasonCode, "RUN_CANCELLED");
});

test("all blocked recovery routes rotate and authenticate one new authority generation", async (context) => {
  const scenarios = [
    {
      phase: "framing",
      state: "FRAMING",
      ordinal: 2,
      routeId: "blocked.recover-framing",
      status: "ready"
    },
    {
      phase: "planning",
      state: "PLANNED",
      ordinal: 5,
      routeId: "blocked.recover-planning",
      status: "ready"
    },
    {
      phase: "execution",
      state: "EXECUTING",
      ordinal: 6,
      routeId: "blocked.recover-execution",
      status: "ready"
    },
    {
      phase: "verification",
      state: "VERIFYING",
      ordinal: 7,
      routeId: "blocked.recover-verification",
      status: "ready"
    },
    {
      phase: "human-review",
      state: "HUMAN_REVIEW",
      ordinal: 8,
      routeId: "blocked.recover-review",
      status: "waiting-human"
    }
  ] as const;
  for (const scenario of scenarios) {
    await context.test(scenario.routeId, async () => {
      const fixture = kernelRecoveryFixture(scenario);
      const activationGate: HumanGateEvidence = {
        gate: "activate",
        actor: fixture.maintainer,
        workAccordDigest:
          fixture.reconstruction.kernelSnapshot.workAccordDigest,
        activationLeaseDigest: digest(fixture.lease),
        currentHead: fixture.reconstruction.kernelSnapshot.currentHead,
        observedAt: "2026-08-29T12:09:00.000Z",
        expiresAt: LATER,
        valid: true
      };
      const evaluation = await evaluateControlRoute({
        reconstruction: fixture.reconstruction,
        routeId: scenario.routeId,
        event: controlEvent({
          snapshot: fixture.reconstruction.kernelSnapshot,
          type: "recovery-approved",
          actor: fixture.maintainer,
          id: `recover-${scenario.phase}`
        }),
        context: {
          graph: lifecycle,
          workAccord: fixture.authority.workAccord,
          policy: controlPolicy,
          registry: fixture.registry,
          domainPack: fixture.domainPack,
          currentPhaseContract: fixture.phaseContract,
          destinationPhaseContract: fixture.phaseContract,
          activationLease: fixture.lease,
          humanGateEvidence: [activationGate],
          contractRequirementEvidence: [],
          requesterId: "requester-1",
          evaluatedAt: NOW,
          retryableFailure: false,
          rebindAuthority: null
        }
      });
      assert.equal(
        evaluation.result.kind,
        "applied",
        evaluation.result.kind === "refused"
          ? JSON.stringify(evaluation.result.refusal)
          : ""
      );
      if (evaluation.result.kind !== "applied") return;
      assert.equal(evaluation.result.snapshot.usage.retries, 0);
      const missingStore = await reconcileDemoRunStateFromKernel({
        reconstruction: fixture.reconstruction,
        kernelEvaluation: evaluation,
        kernelStore: new KernelStore(
          fixture.reconstruction.kernelSnapshot
        ),
        runStateStore: new RunStateStore(
          fixture.reconstruction.runState
        )
      });
      assert.equal(missingStore.kind, "reconciliation-required");
      if (missingStore.kind === "reconciliation-required") {
        assert.equal(
          missingStore.reason,
          "RECOVERY_BUDGET_PERSISTENCE_REQUIRED"
        );
      }
      const store = new RecoveryBudgetStore(
        fixture.reconstruction.budget
      );
      const recovered = await reconcileDemoRunStateFromKernel({
        reconstruction: fixture.reconstruction,
        kernelEvaluation: evaluation,
        kernelStore: new KernelStore(
          fixture.reconstruction.kernelSnapshot
        ),
        runStateStore: new RunStateStore(
          fixture.reconstruction.runState
        ),
        recoveryBudgetStore: store,
        recoveryBudgetVerifier: verifier
      });
      assert.equal(recovered.kind, "updated");
      if (recovered.kind !== "updated") return;
      assert.equal(recovered.runState.spec.core.state, scenario.state);
      assert.equal(recovered.runState.spec.status, scenario.status);
      assert.equal(
        recovered.runState.spec.generation,
        fixture.reconstruction.runState.spec.generation + 1
      );
      assert.equal(
        recovered.runState.spec.runAttempt,
        fixture.reconstruction.runState.spec.runAttempt + 1
      );
      assert.equal(
        recovered.budget.spec.generation,
        fixture.reconstruction.budget.spec.generation + 1
      );
      assert.equal(
        recovered.budget.spec.usage.retries,
        fixture.reconstruction.budget.spec.usage.retries
      );
      assert.ok(store.evidence);
      const {
        signature: recoverySignature,
        ...recoveryPayload
      } = store.evidence;
      assert.equal(
        verifier.verify(recoveryPayload, recoverySignature),
        true
      );
      assert.equal(
        store.evidence.generationAfter,
        store.evidence.generationBefore + 1
      );
      assert.equal(
        store.evidence.retriesAfter,
        store.evidence.retriesBefore
      );
      const stale = reconstructDemoRuntime({
        authority: fixture.authority,
        runState: recovered.runState,
        kernelSnapshot: evaluation.result.snapshot,
        activationLease: fixture.lease,
        budget: fixture.reconstruction.budget,
        projection: fixture.reconstruction.projection,
        completedReceipts: fixture.prepared.evidence.receipts,
        artifacts: fixture.prepared.evidence.artifacts,
        fences: fixture.prepared.evidence.fences,
        receiptVerifier: stageVerifier,
        evaluatedAt: NOW
      });
      assert.equal(stale.activationReady, false);
      assert.equal(stale.activationReason, "EPOCH_STALE");
      const staleDecision = dispatchDemoRuntime({
        reconstruction: stale,
        decidedAt: NOW
      });
      assert.equal(staleDecision.decision.spec.action, "refuse");
      const replayed = await reconcileDemoRunStateFromKernel({
        reconstruction: fixture.reconstruction,
        kernelEvaluation: evaluation,
        kernelStore: new KernelStore(
          fixture.reconstruction.kernelSnapshot
        ),
        runStateStore: new RunStateStore(
          fixture.reconstruction.runState
        ),
        recoveryBudgetStore: store,
        recoveryBudgetVerifier: verifier
      });
      assert.equal(replayed.kind, "updated");
      if (replayed.kind === "updated") {
        assert.equal(
          replayed.runState.spec.generation,
          recovered.runState.spec.generation
        );
        assert.equal(
          replayed.runState.spec.runAttempt,
          recovered.runState.spec.runAttempt
        );
        assert.equal(
          replayed.budget.contentDigest,
          recovered.budget.contentDigest
        );
      }
      assert.deepEqual(store.statuses, ["appended", "existing"]);
    });
  }
});

test("scope repair uses the applied backward Kernel route to invalidate only the affected stage suffix", async () => {
  const framingFixture = kernelFramingFixture();
  const framingPhase = framingFixture.context.currentPhaseContract;
  assert.ok(framingPhase);
  const planningPhase = assertDocument("PhaseContract", {
    ...basePlanningPhase,
    identity: {
      id: "demo.feature-delivery.planning-repair",
      version: "1.0.0"
    },
    exitRules: [
      ...basePlanningPhase.exitRules,
      {
        predicate: "work-accord-current",
        event: "scope-repair-requested"
      }
    ]
  });
  const workAccord = assertDocument("WorkAccord", {
    ...framingFixture.authority.workAccord,
    policy: {
      ...framingFixture.authority.workAccord.policy,
      phaseContracts: {
        ...framingFixture.authority.workAccord.policy.phaseContracts,
        planning: {
          reference: `${planningPhase.identity.id}@${planningPhase.identity.version}`,
          digest: digest(planningPhase)
        }
      }
    }
  });
  const compiled = compilePolicy({
    enterprise: controlPolicy,
    accord: workAccord,
    phase: planningPhase,
    domainPack: framingFixture.context.domainPack,
    registry: framingFixture.context.registry
  });
  assert.equal(compiled.ok, true, compiled.ok ? "" : compiled.errors.join("; "));
  if (!compiled.ok) return;
  const snapshot: KernelSnapshot = {
    ...framingFixture.snapshot,
    state: "PLANNED",
    phaseOwner: "planning",
    stateVersion: 8,
    lastEventSequence: 8,
    workAccordDigest: digest(workAccord),
    phaseContractDigest: digest(planningPhase),
    compiledPolicyDigest: compiled.policy.digest,
    receiptHead: digest("planning-repair-source-head"),
    usage: {
      calls: 1,
      tokens: 100,
      costUnits: 3,
      loops: 0,
      retries: 0
    },
    phaseUsage: {
      calls: 1,
      tokens: 100,
      costUnits: 3,
      loops: 0,
      retries: 0
    }
  };
  const lease = {
    ...activationLease({}, workAccord),
    workAccordDigest: digest(workAccord)
  };
  const repairedAuthority: DemoRuntimeAuthority = {
    ...framingFixture.authority,
    workAccord
  };
  const prepared = runStateAt({ snapshot, ordinal: 5, status: "waiting-human" });
  const reconstruction = reconstructDemoRuntime({
    authority: repairedAuthority,
    runState: prepared.runState,
    kernelSnapshot: snapshot,
    activationLease: lease,
    budget: budgetFor(prepared.runState, snapshot, lease, workAccord),
    projection: projectionFor(prepared.runState, snapshot),
    completedReceipts: prepared.evidence.receipts,
    artifacts: prepared.evidence.artifacts,
    fences: prepared.evidence.fences,
    receiptVerifier: stageVerifier,
    evaluatedAt: NOW
  });
  const reviewer = {
    id: "reviewer-repair",
    class: "reviewer" as const,
    human: true,
    bot: false,
    roles: ["eligible-reviewer"],
    authorizationDigest: digest("reviewer-repair-authorization")
  };
  const approver = {
    id: lease.approvedBy,
    class: "maintainer" as const,
    human: true,
    bot: false,
    roles: ["repository-maintainer"],
    authorizationDigest: lease.authorizationDigest
  };
  const event = controlEvent({
    snapshot,
    type: "scope-repair-requested",
    actor: reviewer,
    id: "scope-repair"
  });
  const requirement = (
    requirementType: ContractRequirementEvidence["requirementType"],
    name: string,
    phase: PhaseContract,
    actorAuthorizationDigest: Digest | null
  ): ContractRequirementEvidence => ({
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "ContractRequirementEvidence",
    requirementType,
    requirement: name,
    satisfied: true,
    workAccordDigest: snapshot.workAccordDigest,
    bindingDigest: snapshot.bindingDigest,
    snapshotDigest: digest(snapshot),
    phaseContractDigest: digest(phase),
    routeId: "planning.repair-scope",
    activationLeaseDigest:
      name === "activation-lease-current" || name === "activation-lease"
        ? digest(lease)
        : null,
    currentHead: snapshot.currentHead,
    actorAuthorizationDigest,
    observedAt: "2026-08-29T12:09:00.000Z",
    expiresAt: LATER
  });
  const activationGate: HumanGateEvidence = {
    gate: "activate",
    actor: approver,
    workAccordDigest: snapshot.workAccordDigest,
    activationLeaseDigest: digest(lease),
    currentHead: snapshot.currentHead,
    observedAt: "2026-08-29T12:09:00.000Z",
    expiresAt: LATER,
    valid: true
  };
  const evaluation = await evaluateControlRoute({
    reconstruction,
    routeId: "planning.repair-scope",
    event,
    context: {
      graph: lifecycle,
      workAccord,
      policy: controlPolicy,
      registry: framingFixture.context.registry,
      domainPack: framingFixture.context.domainPack,
      currentPhaseContract: planningPhase,
      destinationPhaseContract: framingPhase,
      activationLease: lease,
      humanGateEvidence: [activationGate],
      contractRequirementEvidence: [
        requirement(
          "predicate",
          "work-accord-current",
          planningPhase,
          reviewer.authorizationDigest
        ),
        requirement(
          "predicate",
          "activation-lease-current",
          framingPhase,
          null
        ),
        requirement(
          "predicate",
          "work-accord-current",
          framingPhase,
          null
        ),
        requirement("evidence", "trusted-binding", framingPhase, null),
        requirement("evidence", "activation-lease", framingPhase, null)
      ],
      requesterId: "requester-1",
      evaluatedAt: NOW,
      retryableFailure: true,
      rebindAuthority: null
    }
  });
  assert.equal(
    evaluation.result.kind,
    "applied",
    evaluation.result.kind === "refused"
      ? JSON.stringify(evaluation.result.refusal)
      : ""
  );
  if (evaluation.result.kind !== "applied") return;
  const recoveryBudgetStore = new RecoveryBudgetStore(
    reconstruction.budget
  );
  const reconciled = await reconcileDemoRunStateFromKernel({
    reconstruction,
    kernelEvaluation: evaluation,
    kernelStore: new KernelStore(snapshot),
    runStateStore: new RunStateStore(reconstruction.runState),
    recoveryBudgetStore,
    recoveryBudgetVerifier: verifier
  });
  assert.equal(reconciled.kind, "updated");
  if (reconciled.kind === "updated") {
    assert.equal(reconciled.runState.spec.core.state, "FRAMING");
    assert.equal(
      reconciled.runState.spec.journey.currentStageId,
      "requirements-clarification"
    );
    assert.equal(
      reconciled.runState.spec.journey.completedStageReceiptDigests.length,
      1
    );
    assert.equal(reconciled.runState.spec.generation, 1);
    assert.equal(reconciled.runState.spec.runAttempt, 2);
    assert.equal(reconciled.budget.spec.generation, 1);
    const afterRepair = reconstructDemoRuntime({
      authority: repairedAuthority,
      runState: reconciled.runState,
      kernelSnapshot: evaluation.result.snapshot,
      activationLease: lease,
      budget: reconciled.budget,
      projection: reconstruction.projection,
      completedReceipts: prepared.evidence.receipts.slice(0, 1),
      artifacts: prepared.evidence.artifacts.slice(0, 1),
      fences: [],
      receiptVerifier: stageVerifier,
      evaluatedAt: NOW
    });
    assert.equal(afterRepair.activationReady, true);
    const activationRequestAfterRepair = {
      ...activationRequest(),
      generation: 1,
      observedAt: NOW
    };
    const signedLease = await issueSignedDemoActivationLease({
      authority: repairedAuthority,
      request: activationRequestAfterRepair,
      lease,
      issuedAt: NOW,
      signer
    });
    const claimStore = new ActivationClaimStore();
    const grant = await activateDemoIssue({
      authority: repairedAuthority,
      request: activationRequestAfterRepair,
      signedLease,
      runState: reconciled.runState,
      budget: reconciled.budget,
      priorBudget: reconstruction.budget,
      recoveryBudgetEvidence: recoveryBudgetStore.evidence,
      recoveryBudgetVerifier: verifier,
      leaseVerifier: verifier,
      claimStore,
      claimVerifier: verifier
    });
    assert.equal(grant.spec.generation, 1);
    assert.equal(
      grant.spec.budgetAuthorityDigest,
      demoBudgetAuthorityDigest(reconciled.budget)
    );
    const resetBudget = createDemoBudgetState({
      ...reconciled.budget.spec,
      usage: { calls: 0, tokens: 0, costUnits: 0, retries: 0 },
      held: { calls: 0, tokens: 0, costUnits: 0 },
      ledgerHead: digest("forged-reset-ledger")
    });
    await assert.rejects(
      () =>
        activateDemoIssue({
          authority: repairedAuthority,
          request: activationRequestAfterRepair,
          signedLease,
          runState: reconciled.runState,
          budget: resetBudget,
          priorBudget: reconstruction.budget,
          recoveryBudgetEvidence: recoveryBudgetStore.evidence,
          recoveryBudgetVerifier: verifier,
          leaseVerifier: verifier,
          claimStore: new ActivationClaimStore(),
          claimVerifier: verifier
        }),
      /monotone recovery successor/u
    );
  }
});

class ProjectionPort implements DemoProjectionPort {
  readonly writes: string[] = [];
  ambiguousField: string | null = null;

  constructor(public state: DemoProjectionState) {}

  async read(): Promise<DemoProjectionState> {
    return this.state;
  }

  async write(input: Parameters<DemoProjectionPort["write"]>[0]): Promise<void> {
    assert.equal(input.expectedStateDigest, this.state.contentDigest);
    this.state = input.next;
    this.writes.push(input.field);
    if (this.ambiguousField === input.field) {
      throw new DemoProjectionWriteError("lost acknowledgement", true);
    }
  }
}

test("projection convergence writes Kernel Stage last and reconciles lost acknowledgements", async () => {
  const current = reconstructionAt();
  const lagging = createDemoProjectionState({
    ...current.projection.spec,
    kernelStateVersion: current.kernelSnapshot.stateVersion - 1,
    kernelReceiptDigest: null,
    stageReceiptDigest: null,
    fields: current.projection.spec.fields.map((field) => ({
      ...field,
      value: null
    }))
  });
  const reconstruction = reconstructionAt({ projection: lagging });
  const port = new ProjectionPort(lagging);
  port.ambiguousField = "journey-stage";
  const result = await convergeDemoProjection({
    reconstruction,
    port,
    observedAt: NOW
  });
  assert.equal(result.kind, "converged");
  assert.equal(port.writes.at(-1), "stage");
  assert.deepEqual(
    port.state.spec.fields,
    deriveDemoProjectionState({ reconstruction, observedAt: NOW }).spec.fields
  );
  const ahead = createDemoProjectionState({
    ...current.projection.spec,
    kernelStateVersion: current.kernelSnapshot.stateVersion - 1,
    kernelReceiptDigest: null,
    fields: current.projection.spec.fields.map((field) =>
      field.key === "stage" ? { ...field, value: "COMPLETED" } : field
    )
  });
  const aheadReconstruction = reconstructionAt({ projection: ahead });
  const refused = await convergeDemoProjection({
    reconstruction: aheadReconstruction,
    port: new ProjectionPort(ahead),
    observedAt: NOW
  });
  assert.equal(refused.kind, "reconciliation-required");
  if (refused.kind === "reconciliation-required") {
    assert.equal(refused.reason, "PROJECTION_AHEAD");
  }
});

test("same-core projection flushes receipt metadata with an unchanged Stage value", async () => {
  const snapshot = kernelSnapshot("FRAMING", 2);
  const currentStage = runStateAt({ snapshot, ordinal: 3 });
  const priorStage = runStateAt({ snapshot, ordinal: 2 });
  const priorProjection = projectionFor(priorStage.runState, snapshot);
  assert.equal(
    priorProjection.spec.fields.find((field) => field.key === "stage")?.value,
    "FRAMING"
  );
  const reconstruction = reconstructDemoRuntime({
    authority,
    runState: currentStage.runState,
    kernelSnapshot: snapshot,
    activationLease: activationLease(),
    budget: budgetFor(
      currentStage.runState,
      snapshot,
      activationLease()
    ),
    projection: priorProjection,
    completedReceipts: currentStage.evidence.receipts,
    artifacts: currentStage.evidence.artifacts,
    fences: currentStage.evidence.fences,
    receiptVerifier: stageVerifier,
    evaluatedAt: NOW
  });
  const port = new ProjectionPort(priorProjection);
  const result = await convergeDemoProjection({
    reconstruction,
    port,
    observedAt: NOW
  });
  assert.equal(result.kind, "converged");
  assert.equal(port.writes.at(-1), "stage");
  assert.equal(
    port.state.spec.stageReceiptDigest,
    currentStage.runState.spec.journey.previousStageReceiptDigest
  );
  assert.equal(
    port.state.spec.fields.find((field) => field.key === "stage")?.value,
    "FRAMING"
  );
});

test("demo runtime observability is bounded, redacted, and fixed-cardinality", () => {
  const kinds = [
    "stage",
    "run-attempt",
    "budget-reservation",
    "provider-usage",
    "refusal",
    "projection",
    "reconciliation"
  ] as const;
  const batch = createDemoRuntimeObservabilityBatch(
    kinds.map((kind, index) => ({
      kind,
      occurredAt: `2026-08-29T12:10:0${index}.000Z`,
      outcome: kind === "refusal" ? "refused" : "accepted",
      reasonCode: kind.replaceAll("-", "_").toUpperCase(),
      authorityDigest: digest("authority"),
      subjectDigest: digest({ index }),
      usage: {
        attempts: kind === "run-attempt" ? 1 : 0,
        tokens: kind === "provider-usage" ? 100 : 0,
        toolCalls: 0,
        effects: kind === "projection" ? 1 : 0,
        durationMs: 1
      }
    }))
  );
  assert.equal(batch.events.length, 7);
  assert.equal(batch.newlineDelimitedJson.split("\n").length, 8);
  assert.ok(batch.metrics.length > 0);
  assert.equal(JSON.stringify(batch.redacted).includes("repository"), false);
});
