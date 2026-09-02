import { canonicalJson, digest } from "./canonical.js";
import { verifyReceiptChain } from "./receipts.js";
import { validateRegistrySemantics } from "./registry.js";
import type {
  CapabilityRegistry,
  CopilotRuntimePolicy,
  Digest,
  KernelResult,
  LifecycleGraph,
  KernelSnapshot,
  TransitionReceipt,
  WorkAccord
} from "./types.js";
import { assertDocument } from "./validation.js";
import type {
  ContentAddressedDemoContract,
  AgentParticipationPolicy,
  DemoActivationProfile,
  DemoCapabilityRegistryShard,
  DemoCatalog,
  DemoCatalogEntry,
  DemoContract,
  DemoContractKind,
  DemoDispatchDecision,
  DemoIdentityReservationManifest,
  DemoJourneyDefinition,
  DemoProjectId,
  DemoProjectTargetManifest,
  DemoProjectContractSet,
  DemoProjectProfile,
  DemoProjectionMapping,
  DemoRegistrationShardPair,
  DemoRunFence,
  DemoRunState,
  DemoRuntimeRefusal,
  DemoScheduleDecision,
  DemoSignature,
  DemoStageReservation,
  SignedStageAgentSelectionGrant,
  SignedStageReceipt,
  SignedStageReceiptVerifier,
  StageAgentBindingSet,
  StageArtifactEnvelope,
  TrustedRuntimeWorkflowBinding
} from "./demo-types.js";
import {
  agentParticipationPostureAllows,
  DEMO_PROJECT_IDS,
  DEMO_PROJECTION_VOCABULARY
} from "./demo-types.js";

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function immutableCanonicalSnapshot<T>(value: T): T {
  return deepFreeze(JSON.parse(canonicalJson(value)) as T);
}

function fail(message: string): never {
  throw new TypeError(message);
}

function modelIdentity(
  demoProjectId: DemoProjectId,
  agentId: string
): {
  readonly agentId: string;
  readonly capabilityId: string;
  readonly workflowId: string;
} {
  const prefix = `${demoProjectId}-`;
  if (!agentId.startsWith(prefix)) {
    fail(`agent ${agentId} is outside the ${demoProjectId} identity namespace`);
  }
  return {
    agentId,
    capabilityId: `demo.${demoProjectId}.${agentId.slice(prefix.length)}@1.0.0`,
    workflowId: agentId
  };
}

function stage(
  demoProjectId: DemoProjectId,
  stageId: string,
  displayName: string,
  ordinal: number,
  coreState: DemoStageReservation["coreState"],
  executionKind: DemoStageReservation["executionKind"],
  modelAgentIds?: readonly string[]
): DemoStageReservation {
  const runtimeBindings =
    executionKind === "model"
      ? (modelAgentIds ?? [`${demoProjectId}-${stageId}`]).map((agentId) =>
          modelIdentity(demoProjectId, agentId)
        )
      : [];
  return {
    stageId,
    displayName,
    ordinal,
    coreState,
    executionKind,
    runtimeBindings
  };
}

const CONTROL_STAGE_RESERVATIONS = [
  {
    stageId: "activation-pending",
    displayName: "Activation Pending",
    coreState: "ACTIVATION_PENDING",
    executionKind: "kernel",
    runtimeBindings: []
  },
  {
    stageId: "paused",
    displayName: "Paused",
    coreState: "PAUSED",
    executionKind: "kernel",
    runtimeBindings: []
  },
  {
    stageId: "blocked",
    displayName: "Blocked",
    coreState: "BLOCKED",
    executionKind: "kernel",
    runtimeBindings: []
  },
  {
    stageId: "cancelled",
    displayName: "Cancelled",
    coreState: "CANCELLED",
    executionKind: "kernel",
    runtimeBindings: []
  }
] as const;

export const CANONICAL_DEMO_CATALOG_ENTRIES = deepFreeze([
  {
    id: "app-modernization",
    title: "App Modernization",
    projectProfileRef:
      "config/v1alpha1/demo-projects/app-modernization/project-profile.json",
    journeyDefinitionRef:
      "config/v1alpha1/demo-projects/app-modernization/journey.json",
    stageAgentBindingsRef:
      "config/v1alpha1/demo-projects/app-modernization/runtime-bindings.json",
    capabilityShardRef:
      "config/v1alpha1/demo-projects/app-modernization/capabilities.json",
    activationProfileRef:
      "config/v1alpha1/demo-projects/app-modernization/activation-profile.json",
    projectionMappingRef:
      "config/v1alpha1/demo-projects/app-modernization/projection-mapping.json"
  },
  {
    id: "feature-delivery",
    title: "Feature Delivery",
    projectProfileRef:
      "config/v1alpha1/demo-projects/feature-delivery/project-profile.json",
    journeyDefinitionRef:
      "config/v1alpha1/demo-projects/feature-delivery/journey.json",
    stageAgentBindingsRef:
      "config/v1alpha1/demo-projects/feature-delivery/runtime-bindings.json",
    capabilityShardRef:
      "config/v1alpha1/demo-projects/feature-delivery/capabilities.json",
    activationProfileRef:
      "config/v1alpha1/demo-projects/feature-delivery/activation-profile.json",
    projectionMappingRef:
      "config/v1alpha1/demo-projects/feature-delivery/projection-mapping.json"
  },
  {
    id: "security-dependency-remediation",
    title: "Security and Dependency Remediation",
    projectProfileRef:
      "config/v1alpha1/demo-projects/security-dependency-remediation/project-profile.json",
    journeyDefinitionRef:
      "config/v1alpha1/demo-projects/security-dependency-remediation/journey.json",
    stageAgentBindingsRef:
      "config/v1alpha1/demo-projects/security-dependency-remediation/runtime-bindings.json",
    capabilityShardRef:
      "config/v1alpha1/demo-projects/security-dependency-remediation/capabilities.json",
    activationProfileRef:
      "config/v1alpha1/demo-projects/security-dependency-remediation/activation-profile.json",
    projectionMappingRef:
      "config/v1alpha1/demo-projects/security-dependency-remediation/projection-mapping.json"
  },
  {
    id: "adaptive-delivery",
    title: "Adaptive Delivery",
    projectProfileRef:
      "config/v1alpha1/demo-projects/adaptive-delivery/project-profile.json",
    journeyDefinitionRef:
      "config/v1alpha1/demo-projects/adaptive-delivery/journey.json",
    stageAgentBindingsRef:
      "config/v1alpha1/demo-projects/adaptive-delivery/runtime-bindings.json",
    capabilityShardRef:
      "config/v1alpha1/demo-projects/adaptive-delivery/capabilities.json",
    activationProfileRef:
      "config/v1alpha1/demo-projects/adaptive-delivery/activation-profile.json",
    projectionMappingRef:
      "config/v1alpha1/demo-projects/adaptive-delivery/projection-mapping.json"
  }
] satisfies readonly DemoCatalogEntry[]);

export const CANONICAL_DEMO_IDENTITY_RESERVATIONS = deepFreeze([
  {
    demoProjectId: "app-modernization",
    journeyStages: [
      stage(
        "app-modernization",
        "intake",
        "Intake",
        1,
        "ACTIVATION_PENDING",
        "deterministic"
      ),
      stage(
        "app-modernization",
        "repository-discovery",
        "Repository discovery",
        2,
        "FRAMING",
        "deterministic"
      ),
      stage(
        "app-modernization",
        "current-state-inventory",
        "Current-state inventory",
        3,
        "FRAMING",
        "model"
      ),
      stage(
        "app-modernization",
        "modernization-assessment",
        "Modernization assessment",
        4,
        "FRAMING",
        "model"
      ),
      stage(
        "app-modernization",
        "target-architecture",
        "Target architecture",
        5,
        "FRAMING",
        "model"
      ),
      stage(
        "app-modernization",
        "migration-plan",
        "Migration plan",
        6,
        "PLANNED",
        "planning"
      ),
      stage(
        "app-modernization",
        "implementation",
        "Implementation",
        7,
        "EXECUTING",
        "model"
      ),
      stage(
        "app-modernization",
        "verification",
        "Verification",
        8,
        "VERIFYING",
        "model"
      ),
      stage(
        "app-modernization",
        "human-review",
        "Human review",
        9,
        "HUMAN_REVIEW",
        "human"
      ),
      stage(
        "app-modernization",
        "completed",
        "Completed",
        10,
        "COMPLETED",
        "terminal"
      )
    ],
    controlStages: CONTROL_STAGE_RESERVATIONS
  },
  {
    demoProjectId: "feature-delivery",
    journeyStages: [
      stage(
        "feature-delivery",
        "intake",
        "Intake",
        1,
        "ACTIVATION_PENDING",
        "deterministic"
      ),
      stage(
        "feature-delivery",
        "requirements-clarification",
        "Requirements clarification",
        2,
        "FRAMING",
        "model"
      ),
      stage(
        "feature-delivery",
        "codebase-discovery",
        "Codebase discovery",
        3,
        "FRAMING",
        "model"
      ),
      stage(
        "feature-delivery",
        "solution-design",
        "Solution design",
        4,
        "FRAMING",
        "model"
      ),
      stage(
        "feature-delivery",
        "implementation-plan",
        "Implementation plan",
        5,
        "PLANNED",
        "planning"
      ),
      stage(
        "feature-delivery",
        "build",
        "Build",
        6,
        "EXECUTING",
        "model"
      ),
      stage(
        "feature-delivery",
        "test-and-verification",
        "Test and verification",
        7,
        "VERIFYING",
        "model"
      ),
      stage(
        "feature-delivery",
        "human-review",
        "Human review",
        8,
        "HUMAN_REVIEW",
        "human"
      ),
      stage(
        "feature-delivery",
        "completed",
        "Completed",
        9,
        "COMPLETED",
        "terminal"
      )
    ],
    controlStages: CONTROL_STAGE_RESERVATIONS
  },
  {
    demoProjectId: "security-dependency-remediation",
    journeyStages: [
      stage(
        "security-dependency-remediation",
        "intake",
        "Intake",
        1,
        "ACTIVATION_PENDING",
        "deterministic"
      ),
      stage(
        "security-dependency-remediation",
        "triage",
        "Triage",
        2,
        "FRAMING",
        "model"
      ),
      stage(
        "security-dependency-remediation",
        "reproduction-and-impact-analysis",
        "Reproduction and impact analysis",
        3,
        "FRAMING",
        "model"
      ),
      stage(
        "security-dependency-remediation",
        "remediation-design",
        "Remediation design",
        4,
        "FRAMING",
        "model"
      ),
      stage(
        "security-dependency-remediation",
        "patch-planning",
        "Patch planning",
        5,
        "PLANNED",
        "planning"
      ),
      stage(
        "security-dependency-remediation",
        "patch-implementation",
        "Patch implementation",
        6,
        "EXECUTING",
        "model"
      ),
      stage(
        "security-dependency-remediation",
        "security-verification",
        "Security verification",
        7,
        "VERIFYING",
        "model"
      ),
      stage(
        "security-dependency-remediation",
        "human-review",
        "Human review",
        8,
        "HUMAN_REVIEW",
        "human"
      ),
      stage(
        "security-dependency-remediation",
        "completed",
        "Completed",
        9,
        "COMPLETED",
        "terminal"
      )
    ],
    controlStages: CONTROL_STAGE_RESERVATIONS
  },
  {
    demoProjectId: "adaptive-delivery",
    journeyStages: [
      stage(
        "adaptive-delivery",
        "intake",
        "Intake",
        1,
        "ACTIVATION_PENDING",
        "deterministic"
      ),
      stage(
        "adaptive-delivery",
        "context-inventory",
        "Context inventory - autonomous",
        2,
        "FRAMING",
        "model"
      ),
      stage(
        "adaptive-delivery",
        "discovery-studio",
        "Discovery studio - choose agent",
        3,
        "FRAMING",
        "model",
        [
          "adaptive-delivery-customer-value-explorer",
          "adaptive-delivery-technical-options-explorer",
          "adaptive-delivery-delivery-risk-challenger"
        ]
      ),
      stage(
        "adaptive-delivery",
        "guided-synthesis",
        "Guided synthesis - autonomous",
        4,
        "FRAMING",
        "model"
      ),
      stage(
        "adaptive-delivery",
        "implementation-plan",
        "Implementation plan - deterministic gate",
        5,
        "PLANNED",
        "planning"
      ),
      stage(
        "adaptive-delivery",
        "implementation-studio",
        "Implementation studio - choose agent",
        6,
        "EXECUTING",
        "model",
        [
          "adaptive-delivery-minimal-slice-builder",
          "adaptive-delivery-resilience-first-builder"
        ]
      ),
      stage(
        "adaptive-delivery",
        "test-and-verification",
        "Test and verification - autonomous",
        7,
        "VERIFYING",
        "model"
      ),
      stage(
        "adaptive-delivery",
        "human-review",
        "Human review",
        8,
        "HUMAN_REVIEW",
        "human"
      ),
      stage(
        "adaptive-delivery",
        "completed",
        "Completed",
        9,
        "COMPLETED",
        "terminal"
      )
    ],
    controlStages: CONTROL_STAGE_RESERVATIONS
  }
] satisfies DemoIdentityReservationManifest["spec"]["projects"]);

interface DemoContractByKind {
  readonly DemoCatalog: DemoCatalog;
  readonly DemoIdentityReservationManifest: DemoIdentityReservationManifest;
  readonly AgentParticipationPolicy: AgentParticipationPolicy;
  readonly DemoProjectTargetManifest: DemoProjectTargetManifest;
  readonly DemoProjectProfile: DemoProjectProfile;
  readonly DemoJourneyDefinition: DemoJourneyDefinition;
  readonly StageAgentBindingSet: StageAgentBindingSet;
  readonly DemoCapabilityRegistryShard: DemoCapabilityRegistryShard;
  readonly DemoActivationProfile: DemoActivationProfile;
  readonly DemoRunState: DemoRunState;
  readonly DemoRunFence: DemoRunFence;
  readonly StageArtifactEnvelope: StageArtifactEnvelope;
  readonly SignedStageReceipt: SignedStageReceipt;
  readonly DemoProjectionMapping: DemoProjectionMapping;
  readonly DemoDispatchDecision: DemoDispatchDecision;
  readonly DemoScheduleDecision: DemoScheduleDecision;
  readonly DemoRuntimeRefusal: DemoRuntimeRefusal;
  readonly SignedStageAgentSelectionGrant: SignedStageAgentSelectionGrant;
}

function demoContractSchemaVersion(
  kind: DemoContractKind
): DemoContract["schemaVersion"] {
  return kind === "StageAgentBindingSet" || kind === "DemoDispatchDecision"
    ? "2.0.0"
    : "1.0.0";
}

export function demoContractContentDigest(
  kind: DemoContractKind,
  spec: unknown,
  schemaVersion = demoContractSchemaVersion(kind)
): Digest {
  return digest({
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind,
    schemaVersion,
    spec
  });
}

export function createDemoContract<
  K extends Exclude<
    DemoContractKind,
    "SignedStageReceipt" | "SignedStageAgentSelectionGrant"
  >
>(
  kind: K,
  spec: DemoContractByKind[K]["spec"]
): DemoContractByKind[K] {
  const schemaVersion = demoContractSchemaVersion(kind);
  const contract = {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind,
    schemaVersion,
    contentDigest: demoContractContentDigest(kind, spec, schemaVersion),
    spec
  } as DemoContractByKind[K];
  return validateDemoContract(kind, contract);
}

function validateCatalogSemantics(catalog: DemoCatalog): void {
  if (
    canonicalJson(catalog.spec.entries) !==
    canonicalJson(CANONICAL_DEMO_CATALOG_ENTRIES)
  ) {
    fail("DemoCatalog entries are not the exact canonical portfolio");
  }
}

function validateReservationSemantics(
  manifest: DemoIdentityReservationManifest
): void {
  if (
    canonicalJson(manifest.spec.projects) !==
    canonicalJson(CANONICAL_DEMO_IDENTITY_RESERVATIONS)
  ) {
    fail("DemoIdentityReservationManifest is not the exact canonical reservation set");
  }
  const agents = new Set<string>();
  const capabilities = new Set<string>();
  const workflows = new Set<string>();
  for (const project of manifest.spec.projects) {
    for (const reservation of project.journeyStages) {
      if (
        (reservation.executionKind === "model" &&
          reservation.runtimeBindings.length < 1) ||
        (reservation.executionKind !== "model" &&
          reservation.runtimeBindings.length !== 0)
      ) {
        fail(
          `${project.demoProjectId}/${reservation.stageId} has an invalid runtime agent set`
        );
      }
      for (const binding of reservation.runtimeBindings) {
        if (
          agents.has(binding.agentId) ||
          capabilities.has(binding.capabilityId) ||
          workflows.has(binding.workflowId)
        ) {
          fail("demo runtime agent, capability, and workflow identities must be globally injective");
        }
        agents.add(binding.agentId);
        capabilities.add(binding.capabilityId);
        workflows.add(binding.workflowId);
      }
    }
    if (
      project.controlStages.some(
        (control) =>
          control.executionKind !== "kernel" ||
          control.runtimeBindings.length !== 0
      )
    ) {
      fail(`${project.demoProjectId} control stages must have an empty runtime agent set`);
    }
  }
}

function validateParticipationPolicySemantics(
  policy: AgentParticipationPolicy
): void {
  if (
    policy.spec.projects.length !== DEMO_PROJECT_IDS.length ||
    policy.spec.projects.some(
      (project, index) =>
        project.demoProjectId !== DEMO_PROJECT_IDS[index] ||
        !agentParticipationPostureAllows(
          policy.spec.enterpriseMaximum,
          project.posture
        ) ||
        (project.posture === "locked" &&
          (project.selectableStageIds.length > 0 ||
            project.allowedOptionKeys.length > 0))
    )
  ) {
    fail("AgentParticipationPolicy projects do not monotonically narrow enterprise policy");
  }
}

function validateProfileSemantics(profile: DemoProjectProfile): void {
  if (!profile.spec.allowedDepthProfiles.includes(profile.spec.defaultDepthProfile)) {
    fail("DemoProjectProfile default depth must be in its closed allowed set");
  }
}

function validateRunStateSemantics(runState: DemoRunState): void {
  const { journey } = runState.spec;
  if (
    journey.completedStageReceiptDigests.length !==
    journey.currentStageOrdinal - 1
  ) {
    fail("DemoRunState stage receipt count does not match the current stage ordinal");
  }
  const expectedPrevious =
    journey.completedStageReceiptDigests.at(-1) ?? null;
  if (journey.previousStageReceiptDigest !== expectedPrevious) {
    fail("DemoRunState previous stage receipt does not match its receipt chain");
  }
  if (
    runState.spec.status === "running" &&
    (runState.spec.fenceDigest === null ||
      runState.spec.fenceBaseRunStateDigest === null)
  ) {
    fail("a running DemoRunState requires an acquired run fence and base state");
  }
  if (
    runState.spec.status !== "running" &&
    (runState.spec.fenceDigest !== null ||
      runState.spec.fenceBaseRunStateDigest !== null)
  ) {
    fail("a non-running DemoRunState cannot retain a run fence");
  }
}

function validateRunFenceSemantics(fence: DemoRunFence): void {
  if (
    fence.spec.fenceKey !==
    digest({
      repositoryId: fence.spec.repositoryId,
      workItemNodeId: fence.spec.workItemNodeId
    })
  ) {
    fail("DemoRunFence key must bind the exact repository and work-item identity");
  }
  if (
    (fence.spec.status === "acquired" && fence.spec.releasedAt !== null) ||
    (fence.spec.status === "released" && fence.spec.releasedAt === null)
  ) {
    fail("DemoRunFence release state is inconsistent");
  }
  if (
    Date.parse(fence.spec.expiresAt) <= Date.parse(fence.spec.acquiredAt) ||
    (fence.spec.releasedAt !== null &&
      (Date.parse(fence.spec.releasedAt) < Date.parse(fence.spec.acquiredAt) ||
        Date.parse(fence.spec.releasedAt) > Date.parse(fence.spec.expiresAt)))
  ) {
    fail("DemoRunFence timestamps are not ordered");
  }
}

function validateActivationSemantics(profile: DemoActivationProfile): void {
  if (Date.parse(profile.spec.validFrom) >= Date.parse(profile.spec.expiresAt)) {
    fail("DemoActivationProfile expiry must follow its activation time");
  }
}

function validateProjectionSemantics(mapping: DemoProjectionMapping): void {
  const expected = DEMO_PROJECTION_VOCABULARY;
  const expectedSources: Readonly<
    Record<
      (typeof DEMO_PROJECTION_VOCABULARY)[number]["key"],
      DemoProjectionMapping["spec"]["fields"][number]["source"]
    >
  > = {
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
  };
  const writeOrder = new Map(
    expected.map((field, index) => [
      field.key,
      field.key === "stage" ? expected.length : index
    ])
  );
  if (
    mapping.spec.fields.length !== expected.length ||
    mapping.spec.fields.some(
      (field, index) =>
        field.key !== expected[index]?.key ||
        field.name !== expected[index]?.name ||
        field.source !== expectedSources[field.key] ||
        field.displayOnly !== true ||
        field.writeOrder !== writeOrder.get(field.key)
    )
  ) {
    fail("DemoProjectionMapping must use the exact fourteen-field vocabulary and order");
  }
  if (mapping.spec.fields[0]?.writeOrder !== expected.length) {
    fail("DemoProjectionMapping must write Kernel Stage last");
  }
}

function validateDispatchSemantics(decision: DemoDispatchDecision): void {
  const model = decision.spec.action === "invoke-model";
  const kernel = decision.spec.action === "request-kernel-transition";
  const refused = decision.spec.action === "refuse";
  if (
    (model !== (decision.spec.runtimeBinding !== null)) ||
    (!model && decision.spec.selectionGrantDigest !== null) ||
    (kernel !== (decision.spec.kernelRouteId !== null)) ||
    (refused !== (decision.spec.refusalDigest !== null))
  ) {
    fail("DemoDispatchDecision control fields do not match its closed action");
  }
}

function validateScheduleSemantics(decision: DemoScheduleDecision): void {
  const invocation = decision.spec.action === "reserve-and-invoke";
  const refused = decision.spec.action === "refuse";
  if (
    invocation !== (decision.spec.runtimeBinding !== null) ||
    invocation !== (decision.spec.runFenceDigest !== null) ||
    invocation !== (decision.spec.budgetReservation !== null) ||
    refused !== (decision.spec.refusalDigest !== null)
  ) {
    fail("DemoScheduleDecision authority fields do not match its closed action");
  }
}

function validateContractSemantics(contract: DemoContract): void {
  switch (contract.kind) {
    case "DemoCatalog":
      validateCatalogSemantics(contract);
      break;
    case "DemoIdentityReservationManifest":
      validateReservationSemantics(contract);
      break;
    case "AgentParticipationPolicy":
      validateParticipationPolicySemantics(contract);
      break;
    case "DemoProjectTargetManifest":
      break;
    case "DemoProjectProfile":
      validateProfileSemantics(contract);
      break;
    case "DemoRunState":
      validateRunStateSemantics(contract);
      break;
    case "DemoRunFence":
      validateRunFenceSemantics(contract);
      break;
    case "DemoActivationProfile":
      validateActivationSemantics(contract);
      break;
    case "DemoProjectionMapping":
      validateProjectionSemantics(contract);
      break;
    case "DemoDispatchDecision":
      validateDispatchSemantics(contract);
      break;
    case "DemoScheduleDecision":
      validateScheduleSemantics(contract);
      break;
    case "DemoJourneyDefinition":
    case "StageAgentBindingSet":
    case "DemoCapabilityRegistryShard":
    case "StageArtifactEnvelope":
    case "SignedStageReceipt":
    case "SignedStageAgentSelectionGrant":
    case "DemoRuntimeRefusal":
      break;
  }
}

export function validateDemoContract<K extends DemoContractKind>(
  kind: K,
  value: unknown
): DemoContractByKind[K] {
  const validated = assertDocument(kind, value) as unknown as DemoContractByKind[K];
  const snapshot = immutableCanonicalSnapshot(validated);
  if (
    snapshot.contentDigest !==
    demoContractContentDigest(
      snapshot.kind,
      snapshot.spec,
      snapshot.schemaVersion
    )
  ) {
    fail(`${kind} content digest does not match its canonical contract envelope`);
  }
  validateContractSemantics(snapshot);
  return snapshot;
}

export function validatePortfolioFoundation(
  catalogValue: unknown,
  reservationsValue: unknown
): {
  readonly catalog: DemoCatalog;
  readonly reservations: DemoIdentityReservationManifest;
} {
  const catalog = validateDemoContract("DemoCatalog", catalogValue);
  const reservations = validateDemoContract(
    "DemoIdentityReservationManifest",
    reservationsValue
  );
  if (reservations.spec.catalogDigest !== catalog.contentDigest) {
    fail("identity reservations do not bind the exact DemoCatalog");
  }
  return deepFreeze({ catalog, reservations });
}

function reservationFor(
  manifest: DemoIdentityReservationManifest,
  demoProjectId: DemoProjectId
): DemoIdentityReservationManifest["spec"]["projects"][number] {
  const project = manifest.spec.projects.find(
    (candidate) => candidate.demoProjectId === demoProjectId
  );
  if (project === undefined) {
    fail(`unknown demo project ${demoProjectId}`);
  }
  return project;
}

function expectedPhase(
  coreState: DemoStageReservation["coreState"]
): {
  readonly phase: "framing" | "execution" | "verification";
  readonly role: "framer" | "executor" | "reviewer";
  readonly workflowClass:
    | "framing-comment"
    | "target-free-execution"
    | "current-head-comment-review";
} {
  if (coreState === "FRAMING") {
    return {
      phase: "framing",
      role: "framer",
      workflowClass: "framing-comment"
    };
  }
  if (coreState === "EXECUTING") {
    return {
      phase: "execution",
      role: "executor",
      workflowClass: "target-free-execution"
    };
  }
  if (coreState === "VERIFYING") {
    return {
      phase: "verification",
      role: "reviewer",
      workflowClass: "current-head-comment-review"
    };
  }
  fail(`model stage cannot execute in core state ${coreState}`);
}

function validateStageParticipation(
  entry: StageAgentBindingSet["spec"]["stageBindings"][number],
  reservation: DemoStageReservation | DemoIdentityReservationManifest["spec"]["projects"][number]["controlStages"][number]
): void {
  if (entry.fallbackPolicy !== "none") {
    fail(`${entry.stageId} must not declare an agent fallback`);
  }
  if (reservation.executionKind !== "model") {
    if (
      entry.participationMode !== "none" ||
      entry.userInputRequired ||
      entry.selectionFieldKey !== null ||
      entry.allowedOptionKeys.length !== 0 ||
      entry.runtimeBindings.length !== 0 ||
      entry.clearSelectionOnExit ||
      (entry.executionKind === "kernel"
        ? canonicalJson(entry.eligibleActorClasses) !== canonicalJson(["system"])
        : entry.eligibleActorClasses.length !== 0)
    ) {
      fail(`${entry.stageId} non-model participation policy is not closed`);
    }
    return;
  }
  if (entry.participationMode === "fixed") {
    const binding = entry.runtimeBindings[0];
    if (
      entry.userInputRequired ||
      entry.selectionFieldKey !== null ||
      entry.allowedOptionKeys.length !== 0 ||
      entry.runtimeBindings.length !== 1 ||
      binding === undefined ||
      binding.userInvocable ||
      binding.optionKey !== null ||
      canonicalJson(entry.eligibleActorClasses) !== canonicalJson(["system"]) ||
      entry.clearSelectionOnExit
    ) {
      fail(`${entry.stageId} fixed participation policy is not exact`);
    }
    return;
  }
  const optionKeys = entry.runtimeBindings.map((binding) => binding.optionKey);
  if (
    entry.participationMode !== "user-selectable" ||
    !entry.userInputRequired ||
    entry.selectionFieldKey !== "requested-stage-agent" ||
    entry.requiredEvidenceClass !== "fresh-project-selection" ||
    entry.runtimeBindings.length < 2 ||
    entry.eligibleActorClasses.length === 0 ||
    entry.eligibleActorClasses.includes("bot") ||
    entry.eligibleActorClasses.includes("system") ||
    entry.runtimeBindings.some(
      (binding) => !binding.userInvocable || binding.optionKey === null
    ) ||
    new Set(optionKeys).size !== optionKeys.length ||
    canonicalJson(optionKeys) !== canonicalJson(entry.allowedOptionKeys) ||
    !entry.clearSelectionOnExit
  ) {
    fail(`${entry.stageId} selectable participation policy is not exact`);
  }
}

export function validateDemoJourneyClosure(input: {
  readonly catalog: unknown;
  readonly reservations: unknown;
  readonly profile: unknown;
  readonly journey: unknown;
  readonly lifecycle: LifecycleGraph;
}): {
  readonly catalog: DemoCatalog;
  readonly reservations: DemoIdentityReservationManifest;
  readonly profile: DemoProjectProfile;
  readonly journey: DemoJourneyDefinition;
} {
  const { catalog, reservations } = validatePortfolioFoundation(
    input.catalog,
    input.reservations
  );
  const profile = validateDemoContract("DemoProjectProfile", input.profile);
  const journey = validateDemoContract(
    "DemoJourneyDefinition",
    input.journey
  );
  const project = reservationFor(reservations, profile.spec.demoProjectId);
  if (
    journey.spec.demoProjectId !== profile.spec.demoProjectId ||
    profile.spec.catalogDigest !== catalog.contentDigest ||
    journey.spec.catalogDigest !== catalog.contentDigest ||
    profile.spec.identityReservationsDigest !== reservations.contentDigest ||
    journey.spec.identityReservationsDigest !== reservations.contentDigest ||
    journey.spec.projectProfileDigest !== profile.contentDigest ||
    journey.spec.lifecycleGraphDigest !== digest(input.lifecycle)
  ) {
    fail("demo profile and journey contract digests do not close");
  }
  const expectedStages = project.journeyStages.map(
    ({ runtimeBindings: _runtimeBindings, ...reservation }) => reservation
  );
  const expectedControls = project.controlStages.map(
    ({ runtimeBindings: _runtimeBindings, ...reservation }) => reservation
  );
  if (
    canonicalJson(journey.spec.stages) !== canonicalJson(expectedStages) ||
    canonicalJson(journey.spec.controlStages) !== canonicalJson(expectedControls)
  ) {
    fail("DemoJourneyDefinition differs from the reserved canonical stages");
  }
  if (
    journey.spec.stages[0]?.stageId !== journey.spec.initialStageId ||
    journey.spec.stages.at(-1)?.stageId !== journey.spec.terminalStageId
  ) {
    fail("DemoJourneyDefinition initial or terminal stage is not canonical");
  }
  for (let index = 0; index < journey.spec.stages.length; index += 1) {
    const current = journey.spec.stages[index];
    if (current === undefined || current.ordinal !== index + 1) {
      fail("DemoJourneyDefinition ordinals must be contiguous");
    }
    if (
      (current.executionKind === "planning" && current.coreState !== "PLANNED") ||
      (current.executionKind === "human" &&
        current.coreState !== "HUMAN_REVIEW") ||
      (current.executionKind === "terminal" &&
        current.coreState !== "COMPLETED")
    ) {
      fail(`${current.stageId} is mapped to an incompatible core lifecycle state`);
    }
    if (current.executionKind === "model") expectedPhase(current.coreState);
    const next = journey.spec.stages[index + 1];
    if (
      next !== undefined &&
      next.coreState !== current.coreState &&
      !input.lifecycle.routes.some(
        (route) =>
          route.from === current.coreState && route.to === next.coreState
      )
    ) {
      fail(
        `${current.stageId} to ${next.stageId} does not follow a declared Kernel route`
      );
    }
  }
  return deepFreeze({ catalog, reservations, profile, journey });
}

function fullCapabilityReference(
  capability: DemoCapabilityRegistryShard["spec"]["capabilities"][number]
): string {
  return `${capability.id}@${capability.version}`;
}

function validateShardPair(input: {
  readonly catalog: DemoCatalog;
  readonly reservations: DemoIdentityReservationManifest;
  readonly baseRegistry: CapabilityRegistry;
  readonly pair: DemoRegistrationShardPair;
}): readonly TrustedRuntimeWorkflowBinding[] {
  const capabilities = validateDemoContract(
    "DemoCapabilityRegistryShard",
    input.pair.capabilities
  );
  const bindings = validateDemoContract(
    "StageAgentBindingSet",
    input.pair.bindings
  );
  const demoProjectId = capabilities.spec.demoProjectId;
  const project = reservationFor(input.reservations, demoProjectId);
  if (
    bindings.spec.demoProjectId !== demoProjectId ||
    capabilities.spec.catalogDigest !== input.catalog.contentDigest ||
    bindings.spec.catalogDigest !== input.catalog.contentDigest ||
    capabilities.spec.identityReservationsDigest !==
      input.reservations.contentDigest ||
    bindings.spec.identityReservationsDigest !==
      input.reservations.contentDigest ||
    bindings.spec.projectProfileDigest !== capabilities.spec.projectProfileDigest ||
    bindings.spec.capabilityShardDigest !== capabilities.contentDigest
  ) {
    fail(`${demoProjectId} capability and runtime-binding shard digests do not close`);
  }
  const partitionMatches = (
    actual: readonly {
      readonly stageId: string;
      readonly executionKind: string;
    }[],
    expected: readonly {
      readonly stageId: string;
      readonly executionKind: string;
    }[]
  ): boolean =>
    actual.length === expected.length &&
    actual.every(
      (entry, index) =>
        entry.stageId === expected[index]?.stageId &&
        entry.executionKind === expected[index]?.executionKind
    );
  if (
    !partitionMatches(bindings.spec.stageBindings, project.journeyStages) ||
    !partitionMatches(bindings.spec.controlBindings, project.controlStages)
  ) {
    fail(
      `${demoProjectId} stage and control binding partitions are incomplete or reordered`
    );
  }
  const expectedEntries = [...project.journeyStages, ...project.controlStages];
  const actualEntries = [
    ...bindings.spec.stageBindings,
    ...bindings.spec.controlBindings
  ];
  const expectedCapabilityIds = project.journeyStages.flatMap((reservation) =>
    reservation.runtimeBindings.map((binding) => binding.capabilityId)
  );
  const actualCapabilityIds = capabilities.spec.capabilities.map(
    fullCapabilityReference
  );
  if (
    canonicalJson(actualCapabilityIds) !== canonicalJson(expectedCapabilityIds)
  ) {
    fail(`${demoProjectId} capability shard differs from reserved identities`);
  }
  const combinedRegistry: CapabilityRegistry = {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "CapabilityRegistry",
    metadata: { version: "1.0.0" },
    defaults: {
      tools: "deny",
      network: "deny",
      writes: "deny",
      secrets: "deny"
    },
    capabilities: capabilities.spec.capabilities
  };
  const registryErrors = validateRegistrySemantics(combinedRegistry);
  if (registryErrors.length > 0) {
    fail(
      `${demoProjectId} capability shard is invalid: ${registryErrors
        .map((error) => `${error.path} ${error.message}`)
        .join("; ")}`
    );
  }
  const baseCapabilityIds = new Set(
    input.baseRegistry.capabilities.map(fullCapabilityReference)
  );
  if (actualCapabilityIds.some((identity) => baseCapabilityIds.has(identity))) {
    fail(`${demoProjectId} capability shard collides with the base registry`);
  }

  const trusted: TrustedRuntimeWorkflowBinding[] = [];
  for (let index = 0; index < expectedEntries.length; index += 1) {
    const reservation = expectedEntries[index];
    const entry = actualEntries[index];
    if (reservation === undefined || entry === undefined) {
      fail(`${demoProjectId} stage-agent binding set is incomplete`);
    }
    validateStageParticipation(entry, reservation);
    if (reservation.executionKind !== "model") {
      continue;
    }
    if (entry.runtimeBindings.length !== reservation.runtimeBindings.length) {
      fail(`${demoProjectId}/${reservation.stageId} has an incomplete candidate set`);
    }
    for (
      let bindingIndex = 0;
      bindingIndex < reservation.runtimeBindings.length;
      bindingIndex += 1
    ) {
      const expectedIdentity = reservation.runtimeBindings[bindingIndex];
      const runtime = entry.runtimeBindings[bindingIndex];
      if (
        expectedIdentity === undefined ||
        runtime === undefined ||
        runtime.agent !== expectedIdentity.agentId ||
        runtime.capability !== expectedIdentity.capabilityId ||
        runtime.workflow !== expectedIdentity.workflowId ||
        runtime.skill !== expectedIdentity.agentId
      ) {
        fail(
          `${demoProjectId}/${reservation.stageId} substitutes a reserved runtime identity`
        );
      }
      const expected = expectedPhase(reservation.coreState);
      if (
        runtime.phase !== expected.phase ||
        runtime.role !== expected.role ||
        runtime.workflowClass !== expected.workflowClass
      ) {
        fail(
          `${demoProjectId}/${reservation.stageId} uses an incompatible workflow class`
        );
      }
      if (
        runtime.workflowClass !== "framing-comment" &&
        (runtime.githubToolsets.length > 0 || runtime.githubTools.length > 0)
      ) {
        fail(
          `${demoProjectId}/${reservation.stageId} cannot use live GitHub tools in its workflow class`
        );
      }
      const capability = capabilities.spec.capabilities.find(
        (candidate) => fullCapabilityReference(candidate) === runtime.capability
      );
      if (
        capability === undefined ||
        capability.status !== "active" ||
        capability.implementation.kind !== "model" ||
        !capability.allowedPhases.includes(runtime.phase)
      ) {
        fail(
          `${demoProjectId}/${reservation.stageId} capability is not active in its mapped phase`
        );
      }
      const expectedTools =
        runtime.workflowClass === "current-head-comment-review"
          ? ["read", "search"]
          : [];
      const expectedMcpReadTools = runtime.githubTools.map(
        (tool) => `github.${tool}`
      );
      const expectedMcpMutationTools =
        runtime.workflowClass === "framing-comment"
          ? ["safeoutputs.add_comment"]
          : runtime.workflowClass === "current-head-comment-review"
            ? ["safeoutputs.submit_pull_request_review"]
            : [];
      const expectedMcpTools = [
        ...expectedMcpReadTools,
        ...expectedMcpMutationTools
      ];
      const expectedEffectClass =
        runtime.workflowClass === "current-head-comment-review"
          ? "verification-result"
          : "advisory-artifact";
      if (
        canonicalJson(capability.allowedPhases) !==
          canonicalJson([runtime.phase]) ||
        !capability.actorClasses.includes("system") ||
        capability.actorClasses.some(
          (actor) => actor !== "system" && actor !== "reviewer"
        ) ||
        capability.effectClass !== expectedEffectClass ||
        canonicalJson(capability.access.tools) !==
          canonicalJson(expectedTools) ||
        capability.access.shellCommands.length !== 0 ||
        capability.access.networkDestinations.length !== 0 ||
        canonicalJson(capability.access.mcpTools) !==
          canonicalJson(expectedMcpTools) ||
        canonicalJson(capability.access.mcpReadTools) !==
          canonicalJson(expectedMcpReadTools) ||
        canonicalJson(capability.access.mcpMutationTools) !==
          canonicalJson(expectedMcpMutationTools) ||
        capability.access.secretNames.length !== 0
      ) {
        fail(
          `${demoProjectId}/${reservation.stageId} capability exceeds its workflow-class authority`
        );
      }
      trusted.push({
        source: "demo",
        demoProjectId,
        stageId: reservation.stageId,
        optionKey: runtime.optionKey,
        userInvocable: runtime.userInvocable,
        phase: runtime.phase,
        role: runtime.role,
        agent: runtime.agent,
        skill: runtime.skill,
        safetySkills: runtime.safetySkills,
        capability: runtime.capability,
        workflow: runtime.workflow,
        workflowClass: runtime.workflowClass,
        githubToolsets: runtime.githubToolsets,
        githubTools: runtime.githubTools,
        modelInvocationAllowed: runtime.modelInvocationAllowed,
        slashCommand: runtime.slashCommand
      });
    }
  }
  return deepFreeze(trusted);
}

export function validateDemoRegistrationShards(input: {
  readonly catalog: unknown;
  readonly reservations: unknown;
  readonly baseRegistry: CapabilityRegistry;
  readonly shards: readonly DemoRegistrationShardPair[];
}): readonly TrustedRuntimeWorkflowBinding[] {
  const { catalog, reservations } = validatePortfolioFoundation(
    input.catalog,
    input.reservations
  );
  const baseRegistry = assertDocument("CapabilityRegistry", input.baseRegistry);
  const demoIds = new Set<DemoProjectId>();
  const agentIds = new Set<string>();
  const capabilityIds = new Set<string>();
  const workflowIds = new Set<string>();
  const result: TrustedRuntimeWorkflowBinding[] = [];
  for (const pairValue of input.shards) {
    const pair = immutableCanonicalSnapshot(pairValue);
    const demoProjectId = pair.capabilities.spec.demoProjectId;
    if (demoIds.has(demoProjectId)) {
      fail(`duplicate registration shard pair for ${demoProjectId}`);
    }
    demoIds.add(demoProjectId);
    const bindings = validateShardPair({
      catalog,
      reservations,
      baseRegistry,
      pair
    });
    for (const binding of bindings) {
      if (
        agentIds.has(binding.agent) ||
        capabilityIds.has(binding.capability) ||
        workflowIds.has(binding.workflow)
      ) {
        fail("registered demo agent, capability, and workflow identities must be globally injective");
      }
      agentIds.add(binding.agent);
      capabilityIds.add(binding.capability);
      workflowIds.add(binding.workflow);
      result.push(binding);
    }
  }
  return deepFreeze(result);
}

export function validateDemoProjectContractSet(input: {
  readonly catalog: unknown;
  readonly reservations: unknown;
  readonly lifecycle: LifecycleGraph;
  readonly baseRegistry: CapabilityRegistry;
  readonly contracts: DemoProjectContractSet;
}): DemoProjectContractSet {
  const { catalog, reservations, profile, journey } =
    validateDemoJourneyClosure({
      catalog: input.catalog,
      reservations: input.reservations,
      profile: input.contracts.profile,
      journey: input.contracts.journey,
      lifecycle: input.lifecycle
    });
  const capabilities = validateDemoContract(
    "DemoCapabilityRegistryShard",
    input.contracts.capabilities
  );
  const bindings = validateDemoContract(
    "StageAgentBindingSet",
    input.contracts.bindings
  );
  const activation = validateDemoContract(
    "DemoActivationProfile",
    input.contracts.activation
  );
  const projection = validateDemoContract(
    "DemoProjectionMapping",
    input.contracts.projection
  );
  const entry = catalog.spec.entries.find(
    (candidate) => candidate.id === profile.spec.demoProjectId
  );
  if (
    entry === undefined ||
    profile.spec.journeyDefinitionRef !== entry.journeyDefinitionRef ||
    profile.spec.stageAgentBindingsRef !== entry.stageAgentBindingsRef ||
    profile.spec.capabilityShardRef !== entry.capabilityShardRef ||
    profile.spec.activationProfileRef !== entry.activationProfileRef ||
    profile.spec.projectionMappingRef !== entry.projectionMappingRef ||
    capabilities.spec.demoProjectId !== profile.spec.demoProjectId ||
    capabilities.spec.projectProfileDigest !== profile.contentDigest ||
    bindings.spec.demoProjectId !== profile.spec.demoProjectId ||
    bindings.spec.projectProfileDigest !== profile.contentDigest ||
    bindings.spec.journeyDefinitionDigest !== journey.contentDigest ||
    bindings.spec.capabilityShardDigest !== capabilities.contentDigest ||
    activation.spec.demoProjectId !== profile.spec.demoProjectId ||
    activation.spec.catalogDigest !== catalog.contentDigest ||
    activation.spec.projectProfileDigest !== profile.contentDigest ||
    activation.spec.stageAgentBindingsDigest !== bindings.contentDigest ||
    activation.spec.capabilityShardDigest !== capabilities.contentDigest ||
    projection.spec.demoProjectId !== profile.spec.demoProjectId ||
    projection.spec.projectProfileDigest !== profile.contentDigest ||
    projection.spec.journeyDefinitionDigest !== journey.contentDigest ||
    projection.spec.stageAgentBindingsDigest !== bindings.contentDigest
  ) {
    fail(`${profile.spec.demoProjectId} per-demo contract set does not close`);
  }
  validateDemoRegistrationShards({
    catalog,
    reservations,
    baseRegistry: input.baseRegistry,
    shards: [{ capabilities, bindings }]
  });
  return deepFreeze({
    profile,
    journey,
    capabilities,
    bindings,
    activation,
    projection
  });
}

export function collectTrustedRuntimeWorkflowBindings(
  policy: CopilotRuntimePolicy,
  demoBindings: readonly TrustedRuntimeWorkflowBinding[]
): readonly TrustedRuntimeWorkflowBinding[] {
  const core = policy.phaseBindings.flatMap((binding) =>
    binding.workflow === null
      ? []
      : [
          {
            source: "core" as const,
            demoProjectId: null,
            stageId: null,
            optionKey: null,
            userInvocable: false,
            phase: binding.phase,
            role: binding.role,
            agent: binding.agent,
            skill: binding.skill,
            safetySkills: binding.safetySkills,
            capability: binding.capability,
            workflow: binding.workflow,
            workflowClass: binding.workflowClass,
            githubToolsets: binding.githubToolsets,
            githubTools: binding.githubTools,
            modelInvocationAllowed: binding.modelInvocationAllowed,
            slashCommand: binding.slashCommand
          }
        ]
  );
  const combined = [...core, ...demoBindings];
  for (const field of ["agent", "capability", "workflow"] as const) {
    const values = combined.map((binding) => binding[field]);
    if (new Set(values).size !== values.length) {
      fail(`trusted runtime ${field} bindings are not globally injective`);
    }
  }
  return deepFreeze(combined);
}

export interface TrustedDemoRuntimeBinding {
  readonly binding: TrustedRuntimeWorkflowBinding;
}

export interface ValidatedTrustedDemoRuntimeRegistration {
  readonly binding: TrustedRuntimeWorkflowBinding;
  readonly projectProfileDigest: Digest;
  readonly journeyDefinitionDigest: Digest;
  readonly stageAgentBindingsDigest: Digest;
  readonly capabilityShardDigest: Digest;
  readonly repositoryBindingDigest: Digest;
  readonly projectBindingDigest: Digest;
  readonly targetIdentity: TrustedDemoTargetIdentity | null;
  readonly targetIdentityExpiresAt: string | null;
}

export interface TrustedDemoTargetIdentity {
  readonly repositoryId: number;
  readonly repositoryNodeId: string;
  readonly repositoryFullName: string;
  readonly workItemNumber: number;
  readonly workItemNodeId: string;
  readonly projectOwnerNodeId: string;
  readonly projectNodeId: string;
  readonly projectItemNodeId: string;
}

export interface TrustedDemoTargetIdentityEvidence {
  readonly evidence: object;
}

interface ValidatedDemoTargetIdentityEvidence {
  readonly projectProfileDigest: Digest;
  readonly repositoryBindingDigest: Digest;
  readonly projectBindingDigest: Digest;
  readonly targetIdentity: TrustedDemoTargetIdentity;
  readonly observedAt: string;
  readonly expiresAt: string;
}

const trustedDemoTargetIdentityEvidence = new WeakMap<
  object,
  ValidatedDemoTargetIdentityEvidence
>();

export function issueTrustedDemoTargetIdentityEvidence(input: {
  readonly projectProfileDigest: Digest;
  readonly repositoryBindingDigest: Digest;
  readonly projectBindingDigest: Digest;
  readonly targetIdentity: TrustedDemoTargetIdentity;
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly signature: DemoSignature;
  readonly verifier: {
    verify(payload: unknown, signature: DemoSignature): boolean;
  };
  readonly clock: { now(): string };
}): TrustedDemoTargetIdentityEvidence {
  const payload = immutableCanonicalSnapshot({
    projectProfileDigest: input.projectProfileDigest,
    repositoryBindingDigest: input.repositoryBindingDigest,
    projectBindingDigest: input.projectBindingDigest,
    targetIdentity: input.targetIdentity,
    observedAt: input.observedAt,
    expiresAt: input.expiresAt
  });
  const observedAt = Date.parse(input.observedAt);
  const expiresAt = Date.parse(input.expiresAt);
  const nowText = input.clock.now();
  const now = Date.parse(nowText);
  if (
    !/^sha256:[0-9a-f]{64}$/u.test(input.projectProfileDigest) ||
    !/^sha256:[0-9a-f]{64}$/u.test(input.repositoryBindingDigest) ||
    !/^sha256:[0-9a-f]{64}$/u.test(input.projectBindingDigest) ||
    !Number.isFinite(observedAt) ||
    !Number.isFinite(expiresAt) ||
    !Number.isFinite(now) ||
    new Date(now).toISOString() !== nowText ||
    observedAt > now ||
    now >= expiresAt ||
    !input.verifier.verify(payload, input.signature)
  ) {
    fail("trusted demo target identity evidence is invalid or stale");
  }
  const handle = deepFreeze({ evidence: Object.create(null) });
  trustedDemoTargetIdentityEvidence.set(
    handle,
    deepFreeze({
      projectProfileDigest: input.projectProfileDigest,
      repositoryBindingDigest: input.repositoryBindingDigest,
      projectBindingDigest: input.projectBindingDigest,
      targetIdentity: immutableCanonicalSnapshot(input.targetIdentity),
      observedAt: input.observedAt,
      expiresAt: input.expiresAt
    })
  );
  return handle;
}

function assertTrustedDemoTargetIdentityEvidence(
  value: TrustedDemoTargetIdentityEvidence
): ValidatedDemoTargetIdentityEvidence {
  const evidence =
    value !== null && typeof value === "object"
      ? trustedDemoTargetIdentityEvidence.get(value)
      : undefined;
  if (evidence === undefined) {
    fail("trusted demo target identity evidence handle is invalid");
  }
  return evidence;
}

const trustedDemoRuntimeBindings = new WeakMap<
  object,
  ValidatedTrustedDemoRuntimeRegistration
>();

export function issueTrustedDemoRuntimeBinding(input: {
  readonly catalog: unknown;
  readonly reservations: unknown;
  readonly lifecycle: LifecycleGraph;
  readonly baseRegistry: CapabilityRegistry;
  readonly contracts: DemoProjectContractSet;
  readonly stageId: string;
  readonly runtimeIdentity?: {
    readonly agentId: string;
    readonly capabilityId: string;
    readonly workflowId: string;
  };
  readonly targetIdentityEvidence?: TrustedDemoTargetIdentityEvidence;
  readonly targetIdentityClock?: { now(): string };
}): TrustedDemoRuntimeBinding {
  const contracts = validateDemoProjectContractSet({
    catalog: input.catalog,
    reservations: input.reservations,
    lifecycle: input.lifecycle,
    baseRegistry: input.baseRegistry,
    contracts: input.contracts
  });
  const bindings = validateDemoRegistrationShards({
    catalog: input.catalog,
    reservations: input.reservations,
    baseRegistry: input.baseRegistry,
    shards: [
      {
        capabilities: contracts.capabilities,
        bindings: contracts.bindings
      }
    ]
  });
  const candidates = bindings.filter(
    (candidate) =>
      candidate.demoProjectId === contracts.profile.spec.demoProjectId &&
      candidate.stageId === input.stageId &&
      (input.runtimeIdentity === undefined ||
        (candidate.agent === input.runtimeIdentity.agentId &&
          candidate.capability === input.runtimeIdentity.capabilityId &&
          candidate.workflow === input.runtimeIdentity.workflowId))
  );
  if (candidates.length !== 1 || candidates[0] === undefined) {
    fail(
      "trusted demo runtime binding does not identify one exact validated model candidate"
    );
  }
  const binding = candidates[0];
  const targetEvidence =
    input.targetIdentityEvidence === undefined
      ? null
      : assertTrustedDemoTargetIdentityEvidence(
          input.targetIdentityEvidence
        );
  const targetIdentity = targetEvidence?.targetIdentity;
  const targetNow =
    input.targetIdentityClock === undefined
      ? null
      : Date.parse(input.targetIdentityClock.now());
  if (
    targetEvidence !== null &&
    (targetEvidence.projectProfileDigest !== contracts.profile.contentDigest ||
      targetEvidence.repositoryBindingDigest !==
        contracts.profile.spec.repositoryBindingDigest ||
      targetEvidence.projectBindingDigest !==
        contracts.profile.spec.projectBindingDigest ||
      targetNow === null ||
      !Number.isFinite(targetNow) ||
      targetNow >= Date.parse(targetEvidence.expiresAt))
  ) {
    fail(
      "trusted demo target evidence is stale or does not bind the validated profile"
    );
  }
  if (
    targetIdentity !== undefined &&
    (!Number.isSafeInteger(targetIdentity.repositoryId) ||
      targetIdentity.repositoryId < 1 ||
      !Number.isSafeInteger(targetIdentity.workItemNumber) ||
      targetIdentity.workItemNumber < 1 ||
      [
        targetIdentity.repositoryNodeId,
        targetIdentity.repositoryFullName,
        targetIdentity.workItemNodeId,
        targetIdentity.projectOwnerNodeId,
        targetIdentity.projectNodeId,
        targetIdentity.projectItemNodeId
      ].some((value) => value.length < 1 || value.length > 256))
  ) {
    fail("trusted demo target identity is malformed");
  }
  const handle = deepFreeze({ binding });
  trustedDemoRuntimeBindings.set(
    handle,
    deepFreeze({
      binding,
      projectProfileDigest: contracts.profile.contentDigest,
      journeyDefinitionDigest: contracts.journey.contentDigest,
      stageAgentBindingsDigest: contracts.bindings.contentDigest,
      capabilityShardDigest: contracts.capabilities.contentDigest,
      repositoryBindingDigest:
        contracts.profile.spec.repositoryBindingDigest,
      projectBindingDigest: contracts.profile.spec.projectBindingDigest,
      targetIdentity:
        targetIdentity === undefined
          ? null
          : immutableCanonicalSnapshot(targetIdentity),
      targetIdentityExpiresAt: targetEvidence?.expiresAt ?? null
    })
  );
  return handle;
}

export function assertTrustedDemoRuntimeRegistration(
  value: TrustedDemoRuntimeBinding
): ValidatedTrustedDemoRuntimeRegistration {
  const registration =
    value !== null && typeof value === "object"
      ? trustedDemoRuntimeBindings.get(value)
      : undefined;
  if (registration === undefined) {
    fail("trusted demo runtime binding handle is invalid");
  }
  return registration;
}

export function assertTrustedDemoRuntimeBinding(
  value: TrustedDemoRuntimeBinding
): TrustedRuntimeWorkflowBinding {
  return assertTrustedDemoRuntimeRegistration(value).binding;
}

const PROHIBITED_MODEL_CONTROL_FIELDS = new Set([
  "action",
  "agent",
  "agents",
  "agentid",
  "currentstageagent",
  "branch",
  "branches",
  "capability",
  "capabilities",
  "capabilityid",
  "credential",
  "credentials",
  "effect",
  "effects",
  "effectintent",
  "effectrequest",
  "effecttype",
  "journeystage",
  "authorityepoch",
  "generation",
  "kernelfield",
  "kernelreceipt",
  "kernelroute",
  "kernelsnapshot",
  "nextstage",
  "nextstageid",
  "path",
  "paths",
  "repository",
  "repositories",
  "repositoryfullname",
  "repositoryid",
  "runattempt",
  "runid",
  "retry",
  "retries",
  "retrycount",
  "route",
  "routes",
  "routeid",
  "stage",
  "stages",
  "stageid",
  "stateversion",
  "status",
  "target",
  "targets",
  "targetrepository",
  "workflow",
  "workflows",
  "workflowid"
]);

const ALLOWED_DEMO_MODEL_OUTPUT_FIELDS = new Set([
  "artifacts",
  "changes",
  "code",
  "content",
  "details",
  "findings",
  "message",
  "openquestions",
  "reasoncode",
  "result",
  "severity",
  "slot",
  "status",
  "steps",
  "summary",
  "targetslots",
  "verificationids"
]);

function normalizedControlField(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

export function assertDemoModelOutputHasNoControlFields<T>(value: T): T {
  const seen = new Set<object>();
  let nodes = 0;
  const inspect = (candidate: unknown, path: string, depth: number): void => {
    if (candidate === null || typeof candidate !== "object") return;
    if (depth > 32 || nodes >= 10_000) {
      fail("demo model output exceeds structural limits");
    }
    if (seen.has(candidate)) fail("demo model output contains a cycle");
    seen.add(candidate);
    nodes += 1;
    if (Array.isArray(candidate)) {
      candidate.forEach((item, index) => inspect(item, `${path}/${index}`, depth + 1));
    } else {
      for (const [key, child] of Object.entries(candidate)) {
        const normalized = normalizedControlField(key);
        const advisoryResultStatus =
          normalized === "status" && path === "/result";
        if (
          PROHIBITED_MODEL_CONTROL_FIELDS.has(normalized) &&
          !advisoryResultStatus
        ) {
          fail(`demo model output contains prohibited control field ${path}/${key}`);
        }
        if (!ALLOWED_DEMO_MODEL_OUTPUT_FIELDS.has(normalized)) {
          fail(
            `demo model output field ${path}/${key} is outside the closed advisory vocabulary`
          );
        }
        inspect(child, `${path}/${key}`, depth + 1);
      }
    }
    seen.delete(candidate);
  };
  inspect(value, "", 0);
  return immutableCanonicalSnapshot(value);
}

function coreBindingFromSnapshot(snapshot: KernelSnapshot): DemoRunState["spec"]["core"] {
  return {
    state: snapshot.state,
    stateVersion: snapshot.stateVersion,
    bindingDigest: snapshot.bindingDigest,
    lifecycleGraphDigest: snapshot.lifecycleGraphDigest,
    workAccordDigest: snapshot.workAccordDigest,
    capabilityRegistryDigest: snapshot.capabilityRegistryDigest,
    domainPackDigest: snapshot.domainPackDigest,
    phaseContractDigest: snapshot.phaseContractDigest,
    compiledPolicyDigest: snapshot.compiledPolicyDigest,
    policyDigest: snapshot.policyDigest,
    kernelReceiptDigest: snapshot.receiptHead,
    kernelSnapshotDigest: digest(snapshot)
  };
}

function assertAppliedKernelResult(input: {
  readonly result: KernelResult | null;
  readonly receipt: SignedStageReceipt;
  readonly runState: DemoRunState;
  readonly nextState: DemoJourneyDefinition["spec"]["stages"][number]["coreState"];
  readonly workAccord: WorkAccord | null;
}): DemoRunState["spec"]["core"] {
  const result = input.result;
  const workAccord = input.workAccord;
  if (result === null || result.kind !== "applied" || workAccord === null) {
    fail("cross-state journey advancement requires the exact applied Kernel result");
  }
  assertDocument("TransitionReceipt", result.receipt);
  assertDocument("KernelSnapshot", result.snapshot);
  assertDocument("WorkAccord", workAccord);
  const kernelReceiptDigest = digest(result.receipt);
  const processed = result.snapshot.processedEvents[result.receipt.eventId];
  if (
    result.receiptDigest !== kernelReceiptDigest ||
    input.receipt.spec.kernelTransitionReceiptDigest !== kernelReceiptDigest ||
    input.receipt.spec.appliedKernelResultDigest !== digest(result) ||
    result.route.id !== result.receipt.routeId ||
    result.route.version !== result.receipt.routeVersion ||
    result.route.from !== result.receipt.from ||
    result.route.to !== result.receipt.to ||
    result.receipt.from !== input.runState.spec.core.state ||
    result.receipt.to !== input.nextState ||
    result.receipt.previousReceipt !==
      input.runState.spec.core.kernelReceiptDigest ||
    result.receipt.stateVersion !== input.runState.spec.core.stateVersion + 1 ||
    result.snapshot.state !== input.nextState ||
    result.snapshot.phaseOwner !== result.route.phaseOwner ||
    result.snapshot.stateVersion !== result.receipt.stateVersion ||
    result.snapshot.receiptHead !== kernelReceiptDigest ||
    result.snapshot.bindingDigest !== result.receipt.destinationBindingDigest ||
    result.snapshot.lifecycleGraphDigest !==
      result.receipt.destinationLifecycleGraphDigest ||
    result.snapshot.workAccordDigest !==
      result.receipt.destinationWorkAccordDigest ||
    result.snapshot.capabilityRegistryDigest !==
      result.receipt.destinationCapabilityRegistryDigest ||
    result.snapshot.domainPackDigest !==
      result.receipt.destinationDomainPackDigest ||
    result.snapshot.phaseContractDigest !==
      result.receipt.destinationPhaseContractDigest ||
    result.snapshot.compiledPolicyDigest !==
      result.receipt.destinationCompiledPolicyDigest ||
    result.snapshot.policyDigest !== result.receipt.destinationPolicyDigest ||
    result.snapshot.currentHead !== workAccord.binding.currentHead ||
    processed?.receiptDigest !== kernelReceiptDigest ||
    processed.eventDigest !== result.receipt.eventDigest ||
    processed.idempotencyKey !== result.receipt.idempotencyKey ||
    result.receipt.effectPlanDigest !== digest(result.effects) ||
    digest(workAccord) !== input.runState.spec.core.workAccordDigest
  ) {
    fail("applied Kernel result does not match the journey advancement");
  }
  const source = input.runState.spec.core;
  if (
    result.receipt.bindingDigest !== source.bindingDigest ||
    result.receipt.lifecycleGraphDigest !== source.lifecycleGraphDigest ||
    result.receipt.workAccordDigest !== source.workAccordDigest ||
    result.receipt.capabilityRegistryDigest !==
      source.capabilityRegistryDigest ||
    result.receipt.domainPackDigest !== source.domainPackDigest ||
    result.receipt.sourcePhaseContractDigest !== source.phaseContractDigest ||
    result.receipt.sourceCompiledPolicyDigest !== source.compiledPolicyDigest ||
    result.receipt.policyDigest !== source.policyDigest
  ) {
    fail("applied Kernel receipt does not continue the exact source authority");
  }
  const chainErrors = verifyReceiptChain(
    [result.receipt],
    kernelReceiptDigest,
    workAccord,
    source.kernelReceiptDigest
  );
  if (chainErrors.length > 0) {
    fail(
      `applied Kernel receipt chain is invalid: ${chainErrors
        .map((error) => error.message)
        .join("; ")}`
    );
  }
  const projected = coreBindingFromSnapshot(result.snapshot);
  if (canonicalJson(projected) !== canonicalJson(input.receipt.spec.coreAfter)) {
    fail("signed stage receipt does not bind the applied Kernel destination snapshot");
  }
  return projected;
}

function validateArtifactForReceipt(input: {
  readonly artifact: StageArtifactEnvelope;
  readonly receipt: SignedStageReceipt;
  readonly runState: DemoRunState;
  readonly bindingSet: StageAgentBindingSet;
  readonly currentStage: DemoJourneyDefinition["spec"]["stages"][number];
}): void {
  const expected = input.receipt.spec.artifactEnvelopeDigest;
  const artifact = validateDemoContract(
    "StageArtifactEnvelope",
    input.artifact
  );
  const stageBinding =
    input.bindingSet.spec.stageBindings[input.currentStage.ordinal - 1];
  if (
    artifact.contentDigest !== expected ||
    artifact.spec.demoProjectId !== input.runState.spec.demoProjectId ||
    artifact.spec.stageId !== input.runState.spec.journey.currentStageId ||
    artifact.spec.projectProfileDigest !==
      input.runState.spec.projectProfileDigest ||
    artifact.spec.journeyDefinitionDigest !==
      input.runState.spec.journeyDefinitionDigest ||
    artifact.spec.stageAgentBindingsDigest !==
      input.runState.spec.stageAgentBindingsDigest ||
    artifact.spec.authorityEpoch !== input.runState.spec.authorityEpoch ||
    artifact.spec.generation !== input.runState.spec.generation ||
    artifact.spec.runId !== input.runState.spec.runId ||
    artifact.spec.runAttempt !== input.runState.spec.runAttempt ||
    stageBinding?.stageId !== input.currentStage.stageId ||
    stageBinding.executionKind !== input.currentStage.executionKind
  ) {
    fail("stage artifact envelope is substituted or stale");
  }
  if (input.currentStage.executionKind === "model") {
    const matchingRuntimes = stageBinding.runtimeBindings.filter(
      (runtime) =>
        input.artifact.spec.producer.kind === "model" &&
        input.artifact.spec.producer.agentId === runtime.agent &&
        input.artifact.spec.producer.capabilityId === runtime.capability &&
        input.artifact.spec.producer.workflowId === runtime.workflow
    );
    if (
      artifact.spec.producer.kind !== "model" ||
      matchingRuntimes.length !== 1
    ) {
      fail("stage artifact producer does not match the reserved model binding");
    }
  } else {
    const expectedProducer =
      input.currentStage.executionKind === "human"
        ? "human"
        : "deterministic";
    if (
      stageBinding.runtimeBindings.length !== 0 ||
      artifact.spec.producer.kind !== expectedProducer ||
      artifact.spec.producer.agentId !== null ||
      artifact.spec.producer.capabilityId !== null ||
      artifact.spec.producer.workflowId !== null
    ) {
      fail("stage artifact producer does not match the non-model stage");
    }
  }
}

function validateRunFencesForReceipt(input: {
  readonly acquiredValue: unknown | null;
  readonly releasedValue: unknown | null;
  readonly receipt: SignedStageReceipt;
  readonly runState: DemoRunState;
  readonly currentStage: DemoJourneyDefinition["spec"]["stages"][number];
}): void {
  if (input.currentStage.executionKind !== "model") {
    if (
      input.acquiredValue !== null ||
      input.releasedValue !== null ||
      input.receipt.spec.runFenceDigest !== null ||
      input.receipt.spec.releasedRunFenceDigest !== null
    ) {
      fail("a non-model stage cannot consume a model run fence");
    }
    return;
  }
  if (
    input.acquiredValue === null ||
    input.releasedValue === null ||
    input.runState.spec.status !== "running" ||
    input.runState.spec.fenceDigest === null ||
    input.runState.spec.fenceBaseRunStateDigest === null
  ) {
    fail("model stage completion requires acquired and released run-fence evidence");
  }
  const acquired = validateDemoContract("DemoRunFence", input.acquiredValue);
  const released = validateDemoContract("DemoRunFence", input.releasedValue);
  const sameFenceIdentity =
    acquired.spec.demoProjectId === released.spec.demoProjectId &&
    acquired.spec.repositoryId === released.spec.repositoryId &&
    acquired.spec.workItemNodeId === released.spec.workItemNodeId &&
    acquired.spec.fenceKey === released.spec.fenceKey &&
    acquired.spec.authorityEpoch === released.spec.authorityEpoch &&
    acquired.spec.generation === released.spec.generation &&
    acquired.spec.runId === released.spec.runId &&
    acquired.spec.runAttempt === released.spec.runAttempt &&
    acquired.spec.runStateDigest === released.spec.runStateDigest &&
    acquired.spec.dispatchDecisionDigest ===
      released.spec.dispatchDecisionDigest &&
    acquired.spec.holderDigest === released.spec.holderDigest &&
    acquired.spec.activationLeaseDigest ===
      released.spec.activationLeaseDigest &&
    acquired.spec.acquiredAt === released.spec.acquiredAt &&
    acquired.spec.expiresAt === released.spec.expiresAt;
  if (
    acquired.contentDigest !== input.runState.spec.fenceDigest ||
    acquired.contentDigest !== input.receipt.spec.runFenceDigest ||
    released.contentDigest !== input.receipt.spec.releasedRunFenceDigest ||
    acquired.spec.status !== "acquired" ||
    acquired.spec.releasedAt !== null ||
    acquired.spec.runStateDigest !==
      input.runState.spec.fenceBaseRunStateDigest ||
    acquired.spec.demoProjectId !== input.runState.spec.demoProjectId ||
    acquired.spec.repositoryId !== input.runState.spec.repositoryId ||
    acquired.spec.workItemNodeId !== input.runState.spec.workItemNodeId ||
    acquired.spec.authorityEpoch !== input.runState.spec.authorityEpoch ||
    acquired.spec.generation !== input.runState.spec.generation ||
    acquired.spec.runId !== input.runState.spec.runId ||
    acquired.spec.runAttempt !== input.runState.spec.runAttempt ||
    released.spec.status !== "released" ||
    released.spec.previousFenceDigest !== acquired.contentDigest ||
    released.spec.releasedAt === null ||
    Date.parse(released.spec.releasedAt) >
      Date.parse(input.receipt.spec.completedAt) ||
    !sameFenceIdentity
  ) {
    fail("run-fence evidence does not bind the exact model stage completion");
  }
}

export function advanceDemoJourney(input: {
  readonly runState: unknown;
  readonly authority: {
    readonly catalog: unknown;
    readonly reservations: unknown;
    readonly lifecycle: LifecycleGraph;
    readonly baseRegistry: CapabilityRegistry;
    readonly contracts: DemoProjectContractSet;
  };
  readonly receipt: unknown;
  readonly artifact: StageArtifactEnvelope;
  readonly runFence: unknown | null;
  readonly releasedRunFence: unknown | null;
  readonly appliedKernelResult: KernelResult | null;
  readonly workAccord: WorkAccord | null;
  readonly verifier: SignedStageReceiptVerifier;
}): DemoRunState {
  const runState = validateDemoContract("DemoRunState", input.runState);
  const foundation = validatePortfolioFoundation(
    input.authority.catalog,
    input.authority.reservations
  );
  const contracts = validateDemoProjectContractSet({
    catalog: foundation.catalog,
    reservations: foundation.reservations,
    lifecycle: input.authority.lifecycle,
    baseRegistry: input.authority.baseRegistry,
    contracts: input.authority.contracts
  });
  const journey = contracts.journey;
  const receipt = validateDemoContract("SignedStageReceipt", input.receipt);
  const bindingSet = contracts.bindings;
  if (!input.verifier.verify(receipt)) {
    fail("signed stage receipt signature is invalid");
  }
  if (
    runState.spec.demoProjectId !== journey.spec.demoProjectId ||
    runState.spec.catalogDigest !== foundation.catalog.contentDigest ||
    runState.spec.identityReservationsDigest !==
      foundation.reservations.contentDigest ||
    runState.spec.projectProfileDigest !== contracts.profile.contentDigest ||
    runState.spec.journeyDefinitionDigest !== journey.contentDigest ||
    runState.spec.stageAgentBindingsDigest !==
      contracts.bindings.contentDigest ||
    runState.spec.capabilityShardDigest !==
      contracts.capabilities.contentDigest ||
    runState.spec.activationProfileDigest !==
      contracts.activation.contentDigest ||
    runState.spec.projectionMappingDigest !==
      contracts.projection.contentDigest ||
    runState.spec.repositoryBindingDigest !==
      contracts.profile.spec.repositoryBindingDigest ||
    runState.spec.core.lifecycleGraphDigest !==
      journey.spec.lifecycleGraphDigest ||
    contracts.activation.spec.enabled !== true ||
    contracts.activation.spec.authorityEpoch !==
      runState.spec.authorityEpoch ||
    receipt.spec.demoProjectId !== runState.spec.demoProjectId ||
    receipt.spec.projectProfileDigest !== runState.spec.projectProfileDigest ||
    receipt.spec.journeyDefinitionDigest !== journey.contentDigest ||
    receipt.spec.stageAgentBindingsDigest !==
      runState.spec.stageAgentBindingsDigest ||
    receipt.spec.authorityEpoch !== runState.spec.authorityEpoch ||
    receipt.spec.generation !== runState.spec.generation ||
    receipt.spec.runId !== runState.spec.runId ||
    receipt.spec.runAttempt !== runState.spec.runAttempt ||
    receipt.spec.runStateDigest !== runState.contentDigest ||
    receipt.spec.previousStageReceiptDigest !==
      runState.spec.journey.previousStageReceiptDigest ||
    bindingSet.contentDigest !== runState.spec.stageAgentBindingsDigest ||
    bindingSet.spec.demoProjectId !== runState.spec.demoProjectId ||
    bindingSet.spec.projectProfileDigest !==
      runState.spec.projectProfileDigest ||
    bindingSet.spec.journeyDefinitionDigest !== journey.contentDigest
  ) {
    fail("signed stage receipt does not bind the exact current demo run");
  }
  const currentIndex = runState.spec.journey.currentStageOrdinal - 1;
  const current = journey.spec.stages[currentIndex];
  const next = journey.spec.stages[currentIndex + 1];
  if (
    current === undefined ||
    next === undefined ||
    current.stageId !== runState.spec.journey.currentStageId ||
    current.coreState !== runState.spec.core.state ||
    receipt.spec.stageId !== current.stageId ||
    receipt.spec.stageOrdinal !== current.ordinal ||
    receipt.spec.nextStageId !== next.stageId ||
    receipt.spec.nextStageOrdinal !== next.ordinal ||
    next.ordinal !== current.ordinal + 1 ||
    canonicalJson(receipt.spec.coreBefore) !== canonicalJson(runState.spec.core)
  ) {
    fail("signed stage receipt skips, reorders, or substitutes the journey cursor");
  }
  const expectedStatus =
    current.executionKind === "model"
      ? "running"
      : current.executionKind === "human"
        ? "waiting-human"
        : "ready";
  if (runState.spec.status !== expectedStatus) {
    fail(
      `${current.executionKind} stage cannot advance from ${runState.spec.status} run state`
    );
  }
  validateRunFencesForReceipt({
    acquiredValue: input.runFence,
    releasedValue: input.releasedRunFence,
    receipt,
    runState,
    currentStage: current
  });
  validateArtifactForReceipt({
    artifact: input.artifact,
    receipt,
    runState,
    bindingSet,
    currentStage: current
  });
  let nextCore: DemoRunState["spec"]["core"];
  if (current.coreState === next.coreState) {
    if (
      input.appliedKernelResult !== null ||
      input.workAccord !== null ||
      receipt.spec.kernelTransitionReceiptDigest !== null ||
      receipt.spec.appliedKernelResultDigest !== null ||
      canonicalJson(receipt.spec.coreAfter) !== canonicalJson(runState.spec.core)
    ) {
      fail("same-core-state journey advancement cannot alter or invent Kernel state");
    }
    nextCore = runState.spec.core;
  } else {
    nextCore = assertAppliedKernelResult({
      result: input.appliedKernelResult,
      receipt,
      runState,
      nextState: next.coreState,
      workAccord: input.workAccord
    });
  }
  const status =
    next.executionKind === "human"
      ? "waiting-human"
      : next.executionKind === "terminal"
        ? "completed"
        : "ready";
  return createDemoContract("DemoRunState", {
    ...runState.spec,
    core: nextCore,
    journey: {
      currentStageId: next.stageId,
      currentStageOrdinal: next.ordinal,
      previousStageReceiptDigest: receipt.contentDigest,
      completedStageReceiptDigests: [
        ...runState.spec.journey.completedStageReceiptDigests,
        receipt.contentDigest
      ]
    },
    fenceDigest: null,
    fenceBaseRunStateDigest: null,
    status,
    updatedAt: receipt.spec.completedAt
  });
}
