import type {
  ActivePhaseOwner,
  ApiVersion,
  Capability,
  Digest,
  LifecycleState
} from "./types.js";

export const DEMO_PROJECT_IDS = [
  "app-modernization",
  "feature-delivery",
  "security-dependency-remediation",
  "adaptive-delivery"
] as const;

export type DemoProjectId = (typeof DEMO_PROJECT_IDS)[number];

export const DEMO_PROJECT_FIELD_VOCABULARY = [
  { key: "stage", name: "Stage" },
  { key: "journey-stage", name: "Journey Stage" },
  { key: "demo-project-profile", name: "Demo Project Profile" },
  { key: "depth-profile", name: "Depth Profile" },
  { key: "gate-status", name: "Gate Status" },
  { key: "contract-revision", name: "Contract Revision" },
  { key: "last-receipt", name: "Last Receipt" },
  { key: "attention", name: "Attention" },
  { key: "target-repository", name: "Target Repository" },
  { key: "run-attempt", name: "Run / Attempt" },
  { key: "current-draft-pr", name: "Current Draft PR" },
  { key: "current-stage-agent", name: "Current Stage Agent" },
  { key: "stage-interaction", name: "Stage Interaction" },
  { key: "requested-stage-agent", name: "Requested Stage Agent" },
  { key: "agent-selection-status", name: "Agent Selection Status" }
] as const;

export const DEMO_PROJECTION_VOCABULARY =
  DEMO_PROJECT_FIELD_VOCABULARY.filter(
    (field) => field.key !== "requested-stage-agent"
  ) as readonly Exclude<
    (typeof DEMO_PROJECT_FIELD_VOCABULARY)[number],
    { readonly key: "requested-stage-agent" }
  >[];

export type DemoProjectionFieldKey =
  (typeof DEMO_PROJECTION_VOCABULARY)[number]["key"];

export type DemoProjectFieldKey =
  (typeof DEMO_PROJECT_FIELD_VOCABULARY)[number]["key"];

export type DemoStageExecutionKind =
  | "model"
  | "deterministic"
  | "planning"
  | "human"
  | "kernel"
  | "terminal";

export type DemoWorkflowClass =
  | "framing-comment"
  | "target-free-execution"
  | "current-head-comment-review";

export type DemoStageParticipationMode = "none" | "fixed" | "user-selectable";

export type AgentParticipationPosture = "locked" | "guided" | "flexible";

const AGENT_PARTICIPATION_POSTURE_RANK: Readonly<
  Record<AgentParticipationPosture, number>
> = {
  locked: 0,
  guided: 1,
  flexible: 2
};

export function agentParticipationPostureAllows(
  enterpriseMaximum: AgentParticipationPosture,
  projectPosture: AgentParticipationPosture
): boolean {
  return (
    AGENT_PARTICIPATION_POSTURE_RANK[projectPosture] <=
    AGENT_PARTICIPATION_POSTURE_RANK[enterpriseMaximum]
  );
}

export type DemoSelectionActorClass =
  | "system"
  | "enterprise-owner"
  | "organization-owner"
  | "project-owner"
  | "project-member"
  | "bot";

export type DemoAgentSelectionStatus =
  | "not-applicable"
  | "awaiting-selection"
  | "accepted"
  | "invalid"
  | "stale"
  | "reconciliation-required";

export interface DemoRuntimeIdentity {
  readonly agentId: string;
  readonly capabilityId: string;
  readonly workflowId: string;
}

export interface DemoStageReservation {
  readonly stageId: string;
  readonly displayName: string;
  readonly ordinal: number;
  readonly coreState: LifecycleState;
  readonly executionKind: Exclude<DemoStageExecutionKind, "kernel">;
  readonly runtimeBindings: readonly DemoRuntimeIdentity[];
}

export interface DemoControlStageReservation {
  readonly stageId: "activation-pending" | "paused" | "blocked" | "cancelled";
  readonly displayName:
    | "Activation Pending"
    | "Paused"
    | "Blocked"
    | "Cancelled";
  readonly coreState:
    | "ACTIVATION_PENDING"
    | "PAUSED"
    | "BLOCKED"
    | "CANCELLED";
  readonly executionKind: "kernel";
  readonly runtimeBindings: readonly [];
}

export interface ContentAddressedDemoContract<
  K extends string,
  S,
  V extends "1.0.0" | "2.0.0" = "1.0.0"
> {
  readonly apiVersion: ApiVersion;
  readonly kind: K;
  readonly schemaVersion: V;
  readonly contentDigest: Digest;
  readonly spec: S;
}

export interface DemoCatalogEntry {
  readonly id: DemoProjectId;
  readonly title:
    | "App Modernization"
    | "Feature Delivery"
    | "Security and Dependency Remediation"
    | "Adaptive Delivery";
  readonly projectProfileRef: string;
  readonly journeyDefinitionRef: string;
  readonly stageAgentBindingsRef: string;
  readonly capabilityShardRef: string;
  readonly activationProfileRef: string;
  readonly projectionMappingRef: string;
}

export type DemoCatalog = ContentAddressedDemoContract<
  "DemoCatalog",
  {
    readonly entries: readonly DemoCatalogEntry[];
  }
>;

export type DemoIdentityReservationManifest = ContentAddressedDemoContract<
  "DemoIdentityReservationManifest",
  {
    readonly catalogDigest: Digest;
    readonly projects: readonly {
      readonly demoProjectId: DemoProjectId;
      readonly journeyStages: readonly DemoStageReservation[];
      readonly controlStages: readonly DemoControlStageReservation[];
    }[];
  }
>;

export type DemoProjectProfile = ContentAddressedDemoContract<
  "DemoProjectProfile",
  {
    readonly demoProjectId: DemoProjectId;
    readonly catalogDigest: Digest;
    readonly identityReservationsDigest: Digest;
    readonly title: string;
    readonly description: string;
    readonly defaultDepthProfile: "D0" | "D1" | "D2" | "D3";
    readonly allowedDepthProfiles: readonly ("D0" | "D1" | "D2" | "D3")[];
    readonly repositoryBindingDigest: Digest;
    readonly projectBindingDigest: Digest;
    readonly workAccordTemplateDigest: Digest;
    readonly journeyDefinitionRef: string;
    readonly stageAgentBindingsRef: string;
    readonly capabilityShardRef: string;
    readonly activationProfileRef: string;
    readonly projectionMappingRef: string;
  }
>;

export interface DemoJourneyStage {
  readonly stageId: string;
  readonly displayName: string;
  readonly ordinal: number;
  readonly coreState: LifecycleState;
  readonly executionKind: Exclude<DemoStageExecutionKind, "kernel">;
}

export type DemoJourneyDefinition = ContentAddressedDemoContract<
  "DemoJourneyDefinition",
  {
    readonly demoProjectId: DemoProjectId;
    readonly catalogDigest: Digest;
    readonly identityReservationsDigest: Digest;
    readonly projectProfileDigest: Digest;
    readonly lifecycleGraphDigest: Digest;
    readonly initialStageId: "intake";
    readonly terminalStageId: "completed";
    readonly stages: readonly DemoJourneyStage[];
    readonly controlStages: readonly Omit<
      DemoControlStageReservation,
      "runtimeBindings"
    >[];
  }
>;

export interface DemoStageRuntimeBinding {
  readonly optionKey: string | null;
  readonly userInvocable: boolean;
  readonly agent: string;
  readonly skill: string;
  readonly safetySkills: readonly ["authority-refusal"];
  readonly capability: string;
  readonly workflow: string;
  readonly workflowClass: DemoWorkflowClass;
  readonly phase: "framing" | "execution" | "verification";
  readonly role: "framer" | "executor" | "reviewer";
  readonly githubToolsets: readonly string[];
  readonly githubTools: readonly string[];
  readonly modelInvocationAllowed: true;
  readonly slashCommand: {
    readonly name: string;
    readonly events: readonly (
      | "issues"
      | "issue_comment"
      | "pull_request_comment"
    )[];
  };
}

export interface DemoStageBindingEntry {
  readonly stageId: string;
  readonly executionKind: DemoStageExecutionKind;
  readonly participationMode: DemoStageParticipationMode;
  readonly userInputRequired: boolean;
  readonly eligibleActorClasses: readonly DemoSelectionActorClass[];
  readonly requiredEvidenceClass:
    | "none"
    | "activation"
    | "accepted-frame"
    | "accepted-plan"
    | "fresh-project-selection"
    | "exact-current-head"
    | "human-gate"
    | "kernel-state";
  readonly selectionFieldKey: "requested-stage-agent" | null;
  readonly allowedOptionKeys: readonly string[];
  readonly fallbackPolicy: "none";
  readonly clearSelectionOnExit: boolean;
  readonly runtimeBindings: readonly DemoStageRuntimeBinding[];
}

export type StageAgentBindingSet = ContentAddressedDemoContract<
  "StageAgentBindingSet",
  {
    readonly demoProjectId: DemoProjectId;
    readonly catalogDigest: Digest;
    readonly identityReservationsDigest: Digest;
    readonly projectProfileDigest: Digest;
    readonly journeyDefinitionDigest: Digest;
    readonly capabilityShardDigest: Digest;
    readonly participationPolicyDigest: Digest;
    readonly stageBindings: readonly DemoStageBindingEntry[];
    readonly controlBindings: readonly DemoStageBindingEntry[];
  },
  "2.0.0"
>;

export type AgentParticipationPolicy = ContentAddressedDemoContract<
  "AgentParticipationPolicy",
  {
    readonly policyGeneration: number;
    readonly enterpriseMaximum: AgentParticipationPosture;
    readonly eligibleActorClasses: readonly Exclude<
      DemoSelectionActorClass,
      "bot" | "system"
    >[];
    readonly projects: readonly {
      readonly demoProjectId: DemoProjectId;
      readonly posture: AgentParticipationPosture;
      readonly selectableStageIds: readonly string[];
      readonly allowedOptionKeys: readonly string[];
    }[];
  }
>;

export type DemoProjectTargetManifest = ContentAddressedDemoContract<
  "DemoProjectTargetManifest",
  {
    readonly owner: {
      readonly type: "organization";
      readonly login: string;
      readonly nodeId: string;
    };
    readonly repository: {
      readonly fullName: string;
      readonly nodeId: string;
    };
    readonly projects: readonly {
      readonly demoProjectId: DemoProjectId;
      readonly projectSchemaDigest: Digest;
      readonly title: string;
      readonly number: number;
      readonly nodeId: string;
      readonly viewNodeId: string;
      readonly visibility: "private";
      readonly closed: false;
      readonly initialItemCount: 0;
      readonly initialViewName: "View 1";
      readonly initialViewLayout: "BOARD_LAYOUT";
    }[];
  }
>;

export type DemoCapabilityRegistryShard = ContentAddressedDemoContract<
  "DemoCapabilityRegistryShard",
  {
    readonly demoProjectId: DemoProjectId;
    readonly catalogDigest: Digest;
    readonly identityReservationsDigest: Digest;
    readonly projectProfileDigest: Digest;
    readonly capabilities: readonly Capability[];
  }
>;

export type DemoActivationProfile = ContentAddressedDemoContract<
  "DemoActivationProfile",
  {
    readonly demoProjectId: DemoProjectId;
    readonly catalogDigest: Digest;
    readonly projectProfileDigest: Digest;
    readonly stageAgentBindingsDigest: Digest;
    readonly capabilityShardDigest: Digest;
    readonly enabled: boolean;
    readonly authorityEpoch: number;
    readonly revocationGeneration: number;
    readonly allowedSubmitterIds: readonly number[];
    readonly allowedSource: "issue-form";
    readonly consentField: string;
    readonly consentRequired: true;
    readonly leaseTemplate: {
      readonly maxCalls: number;
      readonly maxTokens: number;
      readonly maxCostUnits: number;
      readonly maxDurationMs: number;
      readonly maxRetries: number;
      readonly maxParallel: 1;
    };
    readonly validFrom: string;
    readonly expiresAt: string;
    readonly signingKeyId: string;
  }
>;

export interface DemoCoreStateBinding {
  readonly state: LifecycleState;
  readonly stateVersion: number;
  readonly bindingDigest: Digest;
  readonly lifecycleGraphDigest: Digest;
  readonly workAccordDigest: Digest;
  readonly capabilityRegistryDigest: Digest;
  readonly domainPackDigest: Digest;
  readonly phaseContractDigest: Digest | null;
  readonly compiledPolicyDigest: Digest | null;
  readonly policyDigest: Digest;
  readonly kernelReceiptDigest: Digest | null;
  readonly kernelSnapshotDigest: Digest;
}

export type DemoRunState = ContentAddressedDemoContract<
  "DemoRunState",
  {
    readonly demoProjectId: DemoProjectId;
    readonly catalogDigest: Digest;
    readonly identityReservationsDigest: Digest;
    readonly projectProfileDigest: Digest;
    readonly journeyDefinitionDigest: Digest;
    readonly stageAgentBindingsDigest: Digest;
    readonly capabilityShardDigest: Digest;
    readonly activationProfileDigest: Digest;
    readonly projectionMappingDigest: Digest;
    readonly repositoryId: number;
    readonly workItemNodeId: string;
    readonly repositoryBindingDigest: Digest;
    readonly authorityEpoch: number;
    readonly generation: number;
    readonly runId: string;
    readonly runAttempt: number;
    readonly core: DemoCoreStateBinding;
    readonly journey: {
      readonly currentStageId: string;
      readonly currentStageOrdinal: number;
      readonly previousStageReceiptDigest: Digest | null;
      readonly completedStageReceiptDigests: readonly Digest[];
    };
    readonly fenceDigest: Digest | null;
    readonly fenceBaseRunStateDigest: Digest | null;
    readonly currentDraftPullRequest: {
      readonly number: number;
      readonly nodeId: string;
      readonly headSha: string;
      readonly draft: true;
      readonly state: "open";
    } | null;
    readonly status:
      | "ready"
      | "running"
      | "waiting-human"
      | "blocked"
      | "completed"
      | "cancelled";
    readonly updatedAt: string;
  }
>;

export type DemoRunFence = ContentAddressedDemoContract<
  "DemoRunFence",
  {
    readonly demoProjectId: DemoProjectId;
    readonly repositoryId: number;
    readonly workItemNodeId: string;
    readonly fenceKey: Digest;
    readonly authorityEpoch: number;
    readonly generation: number;
    readonly runId: string;
    readonly runAttempt: number;
    readonly runStateDigest: Digest;
    readonly dispatchDecisionDigest: Digest;
    readonly holderDigest: Digest;
    readonly activationLeaseDigest: Digest;
    readonly previousFenceDigest: Digest | null;
    readonly status: "acquired" | "released";
    readonly acquiredAt: string;
    readonly expiresAt: string;
    readonly releasedAt: string | null;
  }
>;

export type StageArtifactEnvelope = ContentAddressedDemoContract<
  "StageArtifactEnvelope",
  {
    readonly demoProjectId: DemoProjectId;
    readonly stageId: string;
    readonly projectProfileDigest: Digest;
    readonly journeyDefinitionDigest: Digest;
    readonly stageAgentBindingsDigest: Digest;
    readonly authorityEpoch: number;
    readonly generation: number;
    readonly runId: string;
    readonly runAttempt: number;
    readonly producer:
      | {
          readonly kind: "model";
          readonly agentId: string;
          readonly capabilityId: string;
          readonly workflowId: string;
        }
      | {
          readonly kind: "deterministic" | "human";
          readonly agentId: null;
          readonly capabilityId: null;
          readonly workflowId: null;
        };
    readonly inputDigest: Digest;
    readonly artifact: {
      readonly kind: string;
      readonly schemaVersion: "1.0.0";
      readonly mediaType: "application/json" | "text/markdown";
      readonly byteLength: number;
      readonly contentDigest: Digest;
    };
    readonly createdAt: string;
  }
>;

export interface DemoSignature {
  readonly algorithm: "ed25519";
  readonly keyId: string;
  readonly value: string;
}

export interface SignedStageReceipt {
  readonly apiVersion: ApiVersion;
  readonly kind: "SignedStageReceipt";
  readonly schemaVersion: "1.0.0";
  readonly contentDigest: Digest;
  readonly spec: {
    readonly demoProjectId: DemoProjectId;
    readonly projectProfileDigest: Digest;
    readonly journeyDefinitionDigest: Digest;
    readonly stageAgentBindingsDigest: Digest;
    readonly authorityEpoch: number;
    readonly generation: number;
    readonly runId: string;
    readonly runAttempt: number;
    readonly runStateDigest: Digest;
    readonly stageId: string;
    readonly stageOrdinal: number;
    readonly nextStageId: string;
    readonly nextStageOrdinal: number;
    readonly previousStageReceiptDigest: Digest | null;
    readonly artifactEnvelopeDigest: Digest;
    readonly runFenceDigest: Digest | null;
    readonly releasedRunFenceDigest: Digest | null;
    readonly coreBefore: DemoCoreStateBinding;
    readonly coreAfter: DemoCoreStateBinding;
    readonly kernelTransitionReceiptDigest: Digest | null;
    readonly appliedKernelResultDigest: Digest | null;
    readonly outcome: "completed";
    readonly completedAt: string;
  };
  readonly signature: DemoSignature;
}

export type DemoProjectionSource =
  | "kernel-snapshot"
  | "signed-stage-receipt"
  | "project-profile"
  | "work-accord"
  | "trusted-binding"
  | "demo-run-state"
  | "stage-agent-binding-set"
  | "stage-agent-selection";

export type DemoProjectionMapping = ContentAddressedDemoContract<
  "DemoProjectionMapping",
  {
    readonly demoProjectId: DemoProjectId;
    readonly projectProfileDigest: Digest;
    readonly journeyDefinitionDigest: Digest;
    readonly stageAgentBindingsDigest: Digest;
    readonly fields: readonly {
      readonly key: DemoProjectionFieldKey;
      readonly name: string;
      readonly source: DemoProjectionSource;
      readonly displayOnly: boolean;
      readonly writeOrder: number;
    }[];
  }
>;

export interface DemoDecisionRuntimeBinding {
  readonly agentId: string;
  readonly capabilityId: string;
  readonly workflowId: string;
}

export type DemoDispatchAction =
  | "invoke-model"
  | "run-deterministic"
  | "wait-human"
  | "request-kernel-transition"
  | "project"
  | "reconcile"
  | "noop"
  | "refuse";

export type DemoDispatchDecision = ContentAddressedDemoContract<
  "DemoDispatchDecision",
  {
    readonly demoProjectId: DemoProjectId;
    readonly runStateDigest: Digest;
    readonly stageId: string;
    readonly stageOrdinal: number;
    readonly action: DemoDispatchAction;
    readonly runtimeBinding: DemoDecisionRuntimeBinding | null;
    readonly selectionGrantDigest: Digest | null;
    readonly kernelRouteId: string | null;
    readonly refusalDigest: Digest | null;
    readonly reasonCode: string;
    readonly decidedAt: string;
  },
  "2.0.0"
>;

export type DemoScheduleDecision = ContentAddressedDemoContract<
  "DemoScheduleDecision",
  {
    readonly demoProjectId: DemoProjectId;
    readonly runStateDigest: Digest;
    readonly dispatchDecisionDigest: Digest;
    readonly dispatchPersistenceReceiptDigest: Digest;
    readonly stageId: string;
    readonly action:
      | "reserve-and-invoke"
      | "run-deterministic"
      | "wait"
      | "reconcile"
      | "noop"
      | "refuse";
    readonly runtimeBinding: DemoDecisionRuntimeBinding | null;
    readonly runFenceDigest: Digest | null;
    readonly budgetReservation: {
      readonly calls: number;
      readonly tokens: number;
      readonly costUnits: number;
    } | null;
    readonly refusalDigest: Digest | null;
    readonly decidedAt: string;
  }
>;

export type DemoRuntimeRefusal = ContentAddressedDemoContract<
  "DemoRuntimeRefusal",
  {
    readonly demoProjectId: DemoProjectId;
    readonly stageId: string | null;
    readonly inputDigest: Digest;
    readonly code:
      | "CATALOG_INVALID"
      | "PROFILE_INVALID"
      | "JOURNEY_INVALID"
      | "BINDING_INVALID"
      | "VERSION_UNKNOWN"
      | "DIGEST_MISMATCH"
      | "ACTIVATION_REQUIRED"
      | "FENCE_CONFLICT"
      | "BUDGET_EXHAUSTED"
      | "KERNEL_RECEIPT_MISMATCH"
      | "REPLAY_CONFLICT"
      | "MODEL_CONTROL_FIELD"
      | "RECONCILIATION_REQUIRED"
      | "SELECTION_REQUIRED"
      | "SELECTION_UNAUTHORIZED"
      | "SELECTION_INVALID"
      | "SELECTION_STALE"
      | "SELECTION_REPLAYED"
      | "SELECTION_POLICY_MISMATCH"
      | "SELECTION_TARGET_MISMATCH"
      | "SELECTION_STAGE_MISMATCH"
      | "SELECTION_BINDING_MISMATCH"
      | "SELECTION_GENERATION_MISMATCH"
      | "SELECTION_HEAD_MISMATCH";
    readonly ruleId: string;
    readonly message: string;
    readonly retryable: boolean;
    readonly recovery:
      | "none"
      | "human-authorization"
      | "new-contract"
      | "reconcile";
    readonly refusedAt: string;
  }
>;

export interface SignedStageAgentSelectionGrant {
  readonly apiVersion: ApiVersion;
  readonly kind: "SignedStageAgentSelectionGrant";
  readonly schemaVersion: "1.0.0";
  readonly contentDigest: Digest;
  readonly spec: {
    readonly demoProjectId: DemoProjectId;
    readonly stageId: string;
    readonly selectionKey: Digest;
    readonly optionKey: string;
    readonly projectNodeId: string;
    readonly projectItemNodeId: string;
    readonly projectBindingDigest: Digest;
    readonly repositoryId: number;
    readonly workItemNodeId: string;
    readonly authorityEpoch: number;
    readonly generation: number;
    readonly runId: string;
    readonly runAttempt: number;
    readonly receiptHead: Digest | null;
    readonly pullRequestHeadSha: string | null;
    readonly policyGeneration: number;
    readonly selectionPolicyDigest: Digest;
    readonly stageAgentBindingsDigest: Digest;
    readonly workAccordDigest: Digest;
    readonly phaseContractDigest: Digest;
    readonly capabilityRegistryDigest: Digest;
    readonly activationLeaseDigest: Digest;
    readonly budgetAuthorityDigest: Digest;
    readonly agentId: string;
    readonly skillId: string;
    readonly capabilityId: string;
    readonly workflowId: string;
    readonly workflowClass: DemoWorkflowClass;
    readonly phase: "framing" | "execution" | "verification";
    readonly role: "framer" | "executor" | "reviewer";
    readonly inputSchema: Capability["inputSchema"];
    readonly outputSchema: Capability["outputSchema"];
    readonly toolCeiling: {
      readonly tools: readonly string[];
      readonly shellCommands: readonly string[];
      readonly networkDestinations: readonly string[];
      readonly mcpTools: readonly string[];
      readonly secretNames: readonly [];
    };
    readonly budgetCeiling: {
      readonly maxCalls: 1;
      readonly maxTokens: number;
      readonly maxCostUnits: number;
      readonly maxDurationMs: number;
      readonly maxRetries: number;
      readonly maxOutputBytes: number;
      readonly maxConcurrency: 1;
    };
    readonly issuedAt: string;
    readonly expiresAt: string;
  };
  readonly signature: DemoSignature;
}

export type DemoContract =
  | DemoCatalog
  | DemoIdentityReservationManifest
  | AgentParticipationPolicy
  | DemoProjectTargetManifest
  | DemoProjectProfile
  | DemoJourneyDefinition
  | StageAgentBindingSet
  | DemoCapabilityRegistryShard
  | DemoActivationProfile
  | DemoRunState
  | DemoRunFence
  | StageArtifactEnvelope
  | SignedStageReceipt
  | DemoProjectionMapping
  | DemoDispatchDecision
  | DemoScheduleDecision
  | DemoRuntimeRefusal
  | SignedStageAgentSelectionGrant;

export type DemoContractKind = DemoContract["kind"];

export interface TrustedRuntimeWorkflowBinding {
  readonly source: "core" | "demo";
  readonly demoProjectId: DemoProjectId | null;
  readonly stageId: string | null;
  readonly optionKey: string | null;
  readonly userInvocable: boolean;
  readonly phase: "framing" | "execution" | "verification";
  readonly role: "framer" | "executor" | "reviewer";
  readonly agent: string;
  readonly skill: string;
  readonly safetySkills: readonly ["authority-refusal"];
  readonly capability: string;
  readonly workflow: string;
  readonly workflowClass: DemoWorkflowClass;
  readonly githubToolsets: readonly string[];
  readonly githubTools: readonly string[];
  readonly modelInvocationAllowed: true;
  readonly slashCommand: {
    readonly name: string;
    readonly events: readonly (
      | "issues"
      | "issue_comment"
      | "pull_request_comment"
    )[];
  };
}

export interface DemoRegistrationShardPair {
  readonly capabilities: DemoCapabilityRegistryShard;
  readonly bindings: StageAgentBindingSet;
}

export interface DemoProjectContractSet extends DemoRegistrationShardPair {
  readonly profile: DemoProjectProfile;
  readonly journey: DemoJourneyDefinition;
  readonly activation: DemoActivationProfile;
  readonly projection: DemoProjectionMapping;
}

export interface SignedStageReceiptVerifier {
  verify(receipt: SignedStageReceipt): boolean;
}

export type DemoActivePhase = Extract<
  ActivePhaseOwner,
  "framing" | "execution" | "verification"
>;
