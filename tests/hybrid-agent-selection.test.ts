import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  sign as signPayload
} from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import baseRegistryDocument from "../config/v1alpha1/capability-registry.json" with { type: "json" };
import participationPolicyDocument from "../config/v1alpha1/agent-participation-policy.json" with { type: "json" };
import catalogDocument from "../config/v1alpha1/demo-portfolio/catalog.json" with { type: "json" };
import reservationsDocument from "../config/v1alpha1/demo-portfolio/identity-reservations.json" with { type: "json" };
import activationDocument from "../config/v1alpha1/demo-projects/adaptive-delivery/activation-profile.json" with { type: "json" };
import capabilitiesDocument from "../config/v1alpha1/demo-projects/adaptive-delivery/capabilities.json" with { type: "json" };
import journeyDocument from "../config/v1alpha1/demo-projects/adaptive-delivery/journey.json" with { type: "json" };
import profileDocument from "../config/v1alpha1/demo-projects/adaptive-delivery/project-profile.json" with { type: "json" };
import projectionDocument from "../config/v1alpha1/demo-projects/adaptive-delivery/projection-mapping.json" with { type: "json" };
import bindingsDocument from "../config/v1alpha1/demo-projects/adaptive-delivery/runtime-bindings.json" with { type: "json" };
import lifecycleDocument from "../config/v1alpha1/lifecycle.json" with { type: "json" };
import accordDocument from "./fixtures/demos/adaptive-delivery/work-accord.json" with { type: "json" };

import {
  agentParticipationPostureAllows,
  createDemoBudgetState,
  createDemoContract,
  createDemoProjectionState,
  assertDocument,
  canonicalJson,
  demoBudgetAuthorityDigest,
  demoContractContentDigest,
  demoCoreBindingFromSnapshot,
  deriveDemoProjectionState,
  digest,
  dispatchDemoRuntime,
  resolveStageAgentSelection,
  validateDemoContract,
  validateDemoProjectContractSet,
  validateBoundStageAgentSelectionGrant,
  validateSignedStageAgentSelectionGrant,
  workAccordBindingDigest,
  type ActivationLease,
  type AgentParticipationPolicy,
  type AuthenticatedStageAgentSelectionObservation,
  type DemoEvidenceSigner,
  type DemoEvidenceVerifier,
  type DemoProjectContractSet,
  type DemoRuntimeReconstruction,
  type DemoSignature,
  type KernelSnapshot,
  type PhaseContract,
  type SignedStageAgentSelectionGrant,
  type StageAgentSelectionGrantStore,
  type WorkAccord
} from "../src/index.js";

const NOW = "2026-08-30T16:00:00.000Z";
const LATER = "2026-08-30T17:00:00.000Z";
const ACTOR_ID = 42;
const lifecycle = assertDocument("LifecycleGraph", lifecycleDocument);
const baseRegistry = assertDocument(
  "CapabilityRegistry",
  baseRegistryDocument
);

function signature(payload: unknown, keyId = "selection-test:key-1"): DemoSignature {
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

class GrantStore implements StageAgentSelectionGrantStore {
  readonly supportsAtomicCreate = true;
  readonly grants = new Map<string, SignedStageAgentSelectionGrant>();

  async claim(grant: SignedStageAgentSelectionGrant) {
    const existing = this.grants.get(grant.spec.selectionKey);
    if (existing === undefined) {
      this.grants.set(grant.spec.selectionKey, grant);
      return { status: "appended" as const, grant };
    }
    return existing.contentDigest === grant.contentDigest
      ? { status: "existing" as const, grant: existing }
      : { status: "conflict" as const, grant: null };
  }

  async read(selectionKey: `sha256:${string}`) {
    return this.grants.get(selectionKey) ?? null;
  }
}

async function framingContract(): Promise<PhaseContract> {
  return JSON.parse(
    await readFile(
      "config/v1alpha1/demo-projects/adaptive-delivery/phase-contracts/framing.json",
      "utf8"
    )
  ) as PhaseContract;
}

function contracts(): DemoProjectContractSet {
  const validated = validateDemoProjectContractSet({
    catalog: catalogDocument,
    reservations: reservationsDocument,
    lifecycle,
    baseRegistry,
    contracts: {
      profile: validateDemoContract("DemoProjectProfile", profileDocument),
      journey: validateDemoContract("DemoJourneyDefinition", journeyDocument),
      capabilities: validateDemoContract(
        "DemoCapabilityRegistryShard",
        capabilitiesDocument
      ),
      bindings: validateDemoContract(
        "StageAgentBindingSet",
        bindingsDocument
      ),
      activation: validateDemoContract(
        "DemoActivationProfile",
        activationDocument
      ),
      projection: validateDemoContract(
        "DemoProjectionMapping",
        projectionDocument
      )
    }
  });
  return {
    ...validated,
    activation: createDemoContract("DemoActivationProfile", {
      ...validated.activation.spec,
      enabled: true,
      validFrom: "2026-08-30T15:00:00.000Z",
      expiresAt: LATER
    })
  };
}

function reconstruction(
  overrides: {
    readonly accord?: WorkAccord;
    readonly generation?: number;
    readonly projectBindingDigest?: `sha256:${string}`;
    readonly status?: DemoRuntimeReconstruction["runState"]["spec"]["status"];
  } = {}
): DemoRuntimeReconstruction {
  const demoContracts = contracts();
  const accord = overrides.accord ?? (accordDocument as WorkAccord);
  const generation = overrides.generation ?? 0;
  const phaseDigest = accord.policy.phaseContracts.framing!.digest;
  const snapshot: KernelSnapshot = {
    schemaVersion: "1.0.0",
    lifecycleVersion: "1.0.0",
    lifecycleGraphDigest: demoContracts.journey.spec.lifecycleGraphDigest,
    state: "FRAMING",
    phaseOwner: "framing",
    stateVersion: 2,
    lastEventSequence: 2,
    bindingDigest: workAccordBindingDigest(accord),
    workAccordDigest: digest(accord),
    capabilityRegistryDigest: accord.policy.capabilityRegistryDigest,
    domainPackDigest: accord.policy.domainPackDigest,
    phaseContractDigest: phaseDigest,
    compiledPolicyDigest: digest("adaptive-framing-compiled-policy"),
    policyDigest: accord.binding.policyDigest,
    currentHead: accord.binding.currentHead,
    receiptHead: digest("adaptive-framing-kernel-receipt"),
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
  const runState = createDemoContract("DemoRunState", {
    demoProjectId: "adaptive-delivery",
    catalogDigest: validateDemoContract("DemoCatalog", catalogDocument)
      .contentDigest,
    identityReservationsDigest: validateDemoContract(
      "DemoIdentityReservationManifest",
      reservationsDocument
    ).contentDigest,
    projectProfileDigest: demoContracts.profile.contentDigest,
    journeyDefinitionDigest: demoContracts.journey.contentDigest,
    stageAgentBindingsDigest: demoContracts.bindings.contentDigest,
    capabilityShardDigest: demoContracts.capabilities.contentDigest,
    activationProfileDigest: demoContracts.activation.contentDigest,
    projectionMappingDigest: demoContracts.projection.contentDigest,
    repositoryId: accord.binding.repositoryId,
    workItemNodeId: accord.binding.workItemNodeId,
    repositoryBindingDigest: demoContracts.profile.spec.repositoryBindingDigest,
    authorityEpoch: demoContracts.activation.spec.authorityEpoch,
    generation,
    runId: "adaptive-selection-run",
    runAttempt: 1,
    core: demoCoreBindingFromSnapshot(snapshot),
    journey: {
      currentStageId: "discovery-studio",
      currentStageOrdinal: 3,
      previousStageReceiptDigest: digest("context-inventory-receipt"),
      completedStageReceiptDigests: [
        digest("intake-receipt"),
        digest("context-inventory-receipt")
      ]
    },
    fenceDigest: null,
    fenceBaseRunStateDigest: null,
    currentDraftPullRequest: null,
    status: overrides.status ?? "ready",
    updatedAt: NOW
  });
  const allowedCapabilities = demoContracts.bindings.spec.stageBindings.flatMap(
    (entry) => entry.runtimeBindings.map((binding) => binding.capability)
  );
  const lease: ActivationLease = {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "ActivationLease",
    id: "adaptive-selection-lease",
    workAccordDigest: digest(accord),
    approvedBy: "synthetic-maintainer",
    authorizationDigest: digest("adaptive-selection-authorization"),
    allowedPhases: [
      "execution",
      "framing",
      "human-review",
      "planning",
      "verification"
    ],
    allowedCapabilities,
    maxCalls: demoContracts.activation.spec.leaseTemplate.maxCalls,
    maxTokens: demoContracts.activation.spec.leaseTemplate.maxTokens,
    maxCostUnits: demoContracts.activation.spec.leaseTemplate.maxCostUnits,
    maxParallel: 1,
    expiresAt: LATER,
    revoked: false
  };
  const budget = createDemoBudgetState({
    demoProjectId: "adaptive-delivery",
    repositoryId: accord.binding.repositoryId,
    workItemNodeId: accord.binding.workItemNodeId,
    authorityEpoch: demoContracts.activation.spec.authorityEpoch,
    generation,
    activationLeaseDigest: digest(lease),
    workAccordDigest: digest(accord),
    limits: demoContracts.activation.spec.leaseTemplate,
    usage: { calls: 0, tokens: 0, costUnits: 0, retries: 0 },
    held: { calls: 0, tokens: 0, costUnits: 0 },
    startedAt: "2026-08-30T15:00:00.000Z",
    expiresAt: LATER,
    ledgerVersion: 0,
    ledgerHead: null
  });
  const projection = createDemoProjectionState({
    demoProjectId: "adaptive-delivery",
    repositoryId: accord.binding.repositoryId,
    workItemNodeId: accord.binding.workItemNodeId,
    projectBindingDigest:
      overrides.projectBindingDigest ??
      demoContracts.profile.spec.projectBindingDigest,
    authorityEpoch: demoContracts.activation.spec.authorityEpoch,
    generation,
    kernelStateVersion: snapshot.stateVersion,
    kernelReceiptDigest: snapshot.receiptHead,
    stageReceiptDigest: runState.spec.journey.previousStageReceiptDigest,
    fields: demoContracts.projection.spec.fields.map((field) => ({
      key: field.key,
      value: null
    })),
    observedAt: NOW
  });
  const currentStage = demoContracts.journey.spec.stages[2]!;
  return {
    authority: {
      catalog: validateDemoContract("DemoCatalog", catalogDocument),
      reservations: validateDemoContract(
        "DemoIdentityReservationManifest",
        reservationsDocument
      ),
      contracts: demoContracts,
      lifecycle,
      baseRegistry,
      workAccord: accord
    },
    runState,
    kernelSnapshot: snapshot,
    activationLease: lease,
    budget,
    projection,
    completedReceipts: [],
    artifacts: [],
    fences: [],
    pendingArtifact: null,
    currentStage,
    nextStage: demoContracts.journey.spec.stages[3]!,
    activationReady: true,
    activationReason: "AUTHORIZED",
    agentSelection: null,
    reconciliation: []
  };
}

function observation(
  reconstructionValue: DemoRuntimeReconstruction,
  overrides: Partial<
    Omit<AuthenticatedStageAgentSelectionObservation, "signature">
  > = {}
): AuthenticatedStageAgentSelectionObservation {
  const payload = {
    schemaVersion: "1.0.0" as const,
    demoProjectId: "adaptive-delivery" as const,
    projectNodeId: "PVT_synthetic_adaptive_delivery",
    projectItemNodeId: "PVTI_synthetic_adaptive_delivery_1",
    projectBindingDigest:
      reconstructionValue.authority.contracts.profile.spec.projectBindingDigest,
    repositoryId: reconstructionValue.runState.spec.repositoryId,
    workItemNodeId: reconstructionValue.runState.spec.workItemNodeId,
    stageId: reconstructionValue.currentStage.stageId,
    fieldKey: "requested-stage-agent" as const,
    optionKey: "discovery-customer-value-explorer",
    actorId: ACTOR_ID,
    actorClass: "project-member" as const,
    authorityEpoch: reconstructionValue.runState.spec.authorityEpoch,
    generation: reconstructionValue.runState.spec.generation,
    runId: reconstructionValue.runState.spec.runId,
    runAttempt: reconstructionValue.runState.spec.runAttempt,
    receiptHead:
      reconstructionValue.runState.spec.journey.previousStageReceiptDigest,
    pullRequestHeadSha:
      reconstructionValue.runState.spec.currentDraftPullRequest?.headSha ?? null,
    observedAt: NOW,
    expiresAt: LATER,
    ...overrides
  };
  return { ...payload, signature: signature(payload) };
}

async function resolve(
  reconstructionValue: DemoRuntimeReconstruction,
  options: {
    readonly policy?: AgentParticipationPolicy;
    readonly phaseContract?: PhaseContract;
    readonly observation?: AuthenticatedStageAgentSelectionObservation | null;
    readonly authorizedActorIds?: readonly number[];
    readonly grantStore?: StageAgentSelectionGrantStore;
  } = {}
) {
  return resolveStageAgentSelection({
    reconstruction: reconstructionValue,
    participationPolicy:
      options.policy ?? participationPolicyDocument,
    phaseContract: options.phaseContract ?? (await framingContract()),
    observation:
      options.observation === undefined
        ? observation(reconstructionValue)
        : options.observation,
    expectedProject: {
      projectNodeId: "PVT_synthetic_adaptive_delivery",
      projectItemNodeId: "PVTI_synthetic_adaptive_delivery_1"
    },
    authorizedActorIds: options.authorizedActorIds ?? [ACTOR_ID],
    grantStore: options.grantStore ?? new GrantStore(),
    observationVerifier: verifier,
    grantSigner: signer,
    grantVerifier: verifier,
    evaluatedAt: NOW
  });
}

test("HYBRID-001 through HYBRID-006 define closed locked, fixed, and selectable ceilings", () => {
  const policy = validateDemoContract(
    "AgentParticipationPolicy",
    participationPolicyDocument
  );
  assert.deepEqual(
    policy.spec.projects.map((project) => [
      project.demoProjectId,
      project.posture
    ]),
    [
      ["app-modernization", "locked"],
      ["feature-delivery", "locked"],
      ["security-dependency-remediation", "locked"],
      ["adaptive-delivery", "guided"]
    ]
  );
  const bindings = validateDemoContract(
    "StageAgentBindingSet",
    bindingsDocument
  );
  assert.equal(bindings.schemaVersion, "2.0.0");
  assert.deepEqual(
    bindings.spec.stageBindings.map((entry) => [
      entry.stageId,
      entry.participationMode,
      entry.runtimeBindings.length,
      entry.fallbackPolicy
    ]),
    [
      ["intake", "none", 0, "none"],
      ["context-inventory", "fixed", 1, "none"],
      ["discovery-studio", "user-selectable", 3, "none"],
      ["guided-synthesis", "fixed", 1, "none"],
      ["implementation-plan", "none", 0, "none"],
      ["implementation-studio", "user-selectable", 2, "none"],
      ["test-and-verification", "fixed", 1, "none"],
      ["human-review", "none", 0, "none"],
      ["completed", "none", 0, "none"]
    ]
  );
});

test("HYBRID-003 enforces ordered enterprise and project posture narrowing", async () => {
  assert.equal(agentParticipationPostureAllows("flexible", "guided"), true);
  assert.equal(agentParticipationPostureAllows("guided", "guided"), true);
  assert.equal(agentParticipationPostureAllows("guided", "flexible"), false);
  assert.equal(agentParticipationPostureAllows("locked", "guided"), false);

  const policy = validateDemoContract(
    "AgentParticipationPolicy",
    participationPolicyDocument
  );
  const invalidSpec: AgentParticipationPolicy["spec"] = {
    ...policy.spec,
    enterpriseMaximum: "guided",
    projects: policy.spec.projects.map((project) =>
      project.demoProjectId === "adaptive-delivery"
        ? { ...project, posture: "flexible" }
        : project
    )
  };
  const invalidPolicy: AgentParticipationPolicy = {
    ...policy,
    contentDigest: demoContractContentDigest(
      "AgentParticipationPolicy",
      invalidSpec
    ),
    spec: invalidSpec
  };
  assert.throws(
    () => validateDemoContract("AgentParticipationPolicy", invalidPolicy),
    /monotonically narrow/u
  );

  const runtime = reconstruction();
  const resolution = await resolve(runtime, { policy: invalidPolicy });
  assert.equal(resolution.kind, "refused");
  if (resolution.kind === "refused") {
    assert.equal(
      resolution.refusal.spec.code,
      "SELECTION_POLICY_MISMATCH"
    );
  }

  const accepted = await resolve(runtime);
  assert.equal(accepted.kind, "accepted");
  if (accepted.kind !== "accepted") return;
  const phase = await framingContract();
  assert.throws(
    () =>
      validateSignedStageAgentSelectionGrant({
        grant: accepted.grant,
        verifier,
        reconstruction: runtime,
        evaluatedAt: NOW,
        participationPolicy: invalidPolicy,
        phaseContract: phase
      }),
    /monotonically narrow/u
  );
});

test("HYBRID-007 through HYBRID-010 require one accepted selection with no fallback", async () => {
  const runtime = reconstruction();
  const grantStore = new GrantStore();
  const phase = await framingContract();
  const awaiting = await resolve(runtime, { observation: null });
  assert.equal(awaiting.kind, "awaiting-selection");
  assert.equal(awaiting.refusal.spec.code, "SELECTION_REQUIRED");
  const awaitingRuntime = {
    ...runtime,
    agentSelection: awaiting,
    projection: deriveDemoProjectionState({
      reconstruction: { ...runtime, agentSelection: awaiting },
      observedAt: NOW
    })
  };
  const refusedDispatch = dispatchDemoRuntime({
    reconstruction: awaitingRuntime,
    decidedAt: NOW
  });
  assert.equal(refusedDispatch.decision.spec.action, "refuse");
  assert.equal(refusedDispatch.decision.spec.runtimeBinding, null);

  const accepted = await resolve(runtime, { grantStore });
  assert.equal(accepted.kind, "accepted");
  if (accepted.kind !== "accepted") return;
  assert.deepEqual(accepted.runtimeBinding, {
    agentId: "adaptive-delivery-customer-value-explorer",
    capabilityId:
      "demo.adaptive-delivery.customer-value-explorer@1.0.0",
    workflowId: "adaptive-delivery-customer-value-explorer"
  });
  assert.equal(
    accepted.grant.spec.budgetAuthorityDigest,
    demoBudgetAuthorityDigest(runtime.budget)
  );
  const acceptedRuntime = {
    ...runtime,
    agentSelection: accepted,
    projection: deriveDemoProjectionState({
      reconstruction: { ...runtime, agentSelection: accepted },
      observedAt: NOW
    })
  };
  const dispatch = dispatchDemoRuntime({
    reconstruction: acceptedRuntime,
    decidedAt: NOW,
    selectionGrantVerifier: verifier,
    participationPolicy: participationPolicyDocument,
    selectionPhaseContract: phase
  });
  assert.equal(dispatch.decision.spec.action, "invoke-model");
  assert.equal(
    dispatch.decision.spec.selectionGrantDigest,
    accepted.grant.contentDigest
  );
  const staleSelection = {
    ...accepted,
    grant: {
      ...accepted.grant,
      spec: {
        ...accepted.grant.spec,
        generation: accepted.grant.spec.generation + 1
      }
    }
  };
  const staleDispatch = dispatchDemoRuntime({
    reconstruction: {
      ...acceptedRuntime,
      agentSelection: staleSelection
    },
    decidedAt: NOW,
    selectionGrantVerifier: verifier,
    participationPolicy: participationPolicyDocument,
    selectionPhaseContract: phase
  });
  assert.equal(staleDispatch.decision.spec.action, "refuse");
  assert.equal(staleDispatch.refusal?.spec.code, "SELECTION_STALE");
});

test("HYBRID-008 rejects unknown, wrong-stage, fixed-agent, and locked-project options", async () => {
  const runtime = reconstruction();
  for (const optionKey of [
    "unknown-agent",
    "implementation-minimal-slice-builder",
    "context-inventory"
  ]) {
    const result = await resolve(runtime, {
      observation: observation(runtime, { optionKey })
    });
    assert.equal(result.kind, "refused");
    if (result.kind === "refused") {
      assert.ok(
        ["SELECTION_POLICY_MISMATCH", "SELECTION_BINDING_MISMATCH"].includes(
          result.refusal.spec.code
        )
      );
    }
  }
  const lockedPolicy = createDemoContract("AgentParticipationPolicy", {
    ...validateDemoContract(
      "AgentParticipationPolicy",
      participationPolicyDocument
    ).spec,
    enterpriseMaximum: "locked",
    projects: validateDemoContract(
      "AgentParticipationPolicy",
      participationPolicyDocument
    ).spec.projects.map((project) => ({
      ...project,
      posture: "locked" as const,
      selectableStageIds: [],
      allowedOptionKeys: []
    }))
  });
  const locked = await resolve(runtime, { policy: lockedPolicy });
  assert.equal(locked.kind, "refused");
  if (locked.kind === "refused") {
    assert.equal(locked.refusal.spec.code, "SELECTION_POLICY_MISMATCH");
  }
});

test("HYBRID-011 and HYBRID-018 reject stale, replayed, and retargeted selections", async () => {
  const runtime = reconstruction();
  const grantStore = new GrantStore();
  for (const overrides of [
    { generation: 2 },
    { receiptHead: digest("stale-receipt") },
    { projectNodeId: "PVT_synthetic_wrong" },
    { projectItemNodeId: "PVTI_synthetic_wrong" },
    { expiresAt: NOW }
  ]) {
    const result = await resolve(runtime, {
      observation: observation(runtime, overrides)
    });
    assert.equal(result.kind, "refused");
  }
  const accepted = await resolve(runtime, { grantStore });
  assert.equal(accepted.kind, "accepted");
  if (accepted.kind !== "accepted") return;
  const duplicate = await resolve(runtime, {
    grantStore
  });
  assert.equal(duplicate.kind, "accepted");
  if (duplicate.kind === "accepted") {
    assert.equal(duplicate.grant.contentDigest, accepted.grant.contentDigest);
  }
  const retargeted = await resolve(runtime, {
    observation: observation(runtime, {
      optionKey: "discovery-technical-options-explorer"
    }),
    grantStore
  });
  assert.equal(retargeted.kind, "refused");
  if (retargeted.kind === "refused") {
    assert.equal(retargeted.refusal.spec.code, "SELECTION_REPLAYED");
  }
  const raceStore = new GrantStore();
  const raced = await Promise.all([
    resolve(runtime, {
      observation: observation(runtime, {
        optionKey: "discovery-customer-value-explorer"
      }),
      grantStore: raceStore
    }),
    resolve(runtime, {
      observation: observation(runtime, {
        optionKey: "discovery-technical-options-explorer"
      }),
      grantStore: raceStore
    })
  ]);
  assert.equal(
    raced.filter((result) => result.kind === "accepted").length,
    1
  );
  assert.equal(
    raced.filter(
      (result) =>
        result.kind === "refused" &&
        result.refusal.spec.code === "SELECTION_REPLAYED"
    ).length,
    1
  );
});

test("HYBRID-002 through HYBRID-004 enforce actor, Work Accord, phase, and policy narrowing", async () => {
  const runtime = reconstruction();
  for (const actorClass of ["bot", "system"] as const) {
    const result = await resolve(runtime, {
      observation: observation(runtime, { actorClass })
    });
    assert.equal(result.kind, "refused");
    if (result.kind === "refused") {
      assert.equal(result.refusal.spec.code, "SELECTION_UNAUTHORIZED");
    }
  }
  const unauthorized = await resolve(runtime, { authorizedActorIds: [7] });
  assert.equal(unauthorized.kind, "refused");

  const narrowedAccord: WorkAccord = {
    ...(accordDocument as WorkAccord),
    policy: {
      ...(accordDocument as WorkAccord).policy,
      requestedCapabilities: (
        accordDocument as WorkAccord
      ).policy.requestedCapabilities.filter(
        (capability) =>
          capability !==
          "demo.adaptive-delivery.customer-value-explorer@1.0.0"
      )
    }
  };
  const workAccordRefusal = await resolve(
    reconstruction({ accord: narrowedAccord })
  );
  assert.equal(workAccordRefusal.kind, "refused");
  if (workAccordRefusal.kind === "refused") {
    assert.equal(
      workAccordRefusal.refusal.spec.code,
      "SELECTION_BINDING_MISMATCH"
    );
  }

  const phase = await framingContract();
  const narrowedPhase: PhaseContract = {
    ...phase,
    allowedCapabilities: phase.allowedCapabilities.filter(
      (capability) =>
        capability !==
        "demo.adaptive-delivery.customer-value-explorer@1.0.0"
    )
  };
  const phaseRefusal = await resolve(runtime, {
    phaseContract: narrowedPhase
  });
  assert.equal(phaseRefusal.kind, "refused");
});

test("HYBRID-009, HYBRID-019, and HYBRID-020 bind one immutable target-free grant", async () => {
  const runtime = reconstruction();
  const phase = await framingContract();
  const result = await resolve(runtime);
  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") return;
  const grant = validateSignedStageAgentSelectionGrant({
    grant: result.grant,
    verifier,
    reconstruction: runtime,
    evaluatedAt: NOW,
    participationPolicy: participationPolicyDocument,
    phaseContract: phase
  });
  assert.equal(grant.spec.agentId.includes(","), false);
  assert.equal(grant.spec.toolCeiling.networkDestinations.length, 0);
  assert.equal(grant.spec.toolCeiling.secretNames.length, 0);
  assert.equal(grant.spec.budgetCeiling.maxCalls, 1);
  assert.equal(JSON.stringify(grant).includes("repositoryFullName"), false);
  assert.equal(JSON.stringify(grant).includes("\"path\""), false);

  const staleRuntime = reconstruction({ generation: 1 });
  assert.throws(
    () =>
      validateSignedStageAgentSelectionGrant({
        grant,
        verifier,
        reconstruction: staleRuntime,
        evaluatedAt: NOW
      }),
    /stale or substituted/u
  );
  const changedPolicy = createDemoContract("AgentParticipationPolicy", {
    ...validateDemoContract(
      "AgentParticipationPolicy",
      participationPolicyDocument
    ).spec,
    policyGeneration: 2
  });
  assert.throws(
    () =>
      validateSignedStageAgentSelectionGrant({
        grant,
        verifier,
        reconstruction: runtime,
        evaluatedAt: NOW,
        participationPolicy: changedPolicy,
        phaseContract: phase
      }),
    /policy changed/u
  );

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keyId = "selection-test:runtime-key";
  const signedGrant = {
    ...grant,
    signature: {
      algorithm: "ed25519" as const,
      keyId,
      value: signPayload(
        null,
        Buffer.from(canonicalJson({ contentDigest: grant.contentDigest })),
        privateKey
      ).toString("base64")
    }
  };
  const boundInput = {
    grant: signedGrant,
    expectedDigest: grant.contentDigest,
    expectedKeyId: keyId,
    encodedPublicKey: publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64"),
    evaluatedAt: NOW,
    expected: {
      demoProjectId: grant.spec.demoProjectId,
      stageId: grant.spec.stageId,
      projectNodeId: grant.spec.projectNodeId,
      projectItemNodeId: grant.spec.projectItemNodeId,
      repositoryId: grant.spec.repositoryId,
      workItemNodeId: grant.spec.workItemNodeId,
      stageAgentBindingsDigest: grant.spec.stageAgentBindingsDigest,
      workAccordDigest: grant.spec.workAccordDigest,
      activationLeaseDigest: grant.spec.activationLeaseDigest,
      agentId: grant.spec.agentId,
      skillId: grant.spec.skillId,
      capabilityId: grant.spec.capabilityId,
      workflowId: grant.spec.workflowId,
      workflowClass: grant.spec.workflowClass,
      phase: grant.spec.phase,
      role: grant.spec.role,
      pullRequestHeadSha: grant.spec.pullRequestHeadSha,
      authorityEpoch: grant.spec.authorityEpoch,
      generation: grant.spec.generation,
      runId: grant.spec.runId,
      runAttempt: grant.spec.runAttempt,
      receiptHead: grant.spec.receiptHead,
      policyGeneration: grant.spec.policyGeneration,
      selectionPolicyDigest: grant.spec.selectionPolicyDigest,
      capabilityRegistryDigest: grant.spec.capabilityRegistryDigest,
      budgetAuthorityDigest: grant.spec.budgetAuthorityDigest
    }
  };
  assert.equal(
    validateBoundStageAgentSelectionGrant(boundInput).contentDigest,
    grant.contentDigest
  );
  assert.throws(
    () =>
      validateBoundStageAgentSelectionGrant({
        ...boundInput,
        expected: {
          ...boundInput.expected,
          workflowId: "adaptive-delivery-technical-options-explorer"
        }
      }),
    /not bound to this runtime request/u
  );
  assert.throws(
    () =>
      validateBoundStageAgentSelectionGrant({
        ...boundInput,
        expected: {
          ...boundInput.expected,
          generation: boundInput.expected.generation + 1
        }
      }),
    /not bound to this runtime request/u
  );
});
