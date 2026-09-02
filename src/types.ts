export const API_VERSION = "agentic-framework.github.com/v1alpha1" as const;

export type ApiVersion = typeof API_VERSION;
export type Digest = `sha256:${string}`;
export type LifecycleState =
  | "CAPTURED"
  | "ACTIVATION_PENDING"
  | "FRAMING"
  | "PLANNED"
  | "EXECUTING"
  | "VERIFYING"
  | "HUMAN_REVIEW"
  | "COMPLETED"
  | "PAUSED"
  | "BLOCKED"
  | "CANCELLED";
export type PhaseOwner =
  | "intake"
  | "framing"
  | "planning"
  | "execution"
  | "verification"
  | "human-review"
  | "kernel";
export type ActivePhaseOwner = Exclude<PhaseOwner, "intake" | "kernel">;
export type ActorClass =
  | "requester"
  | "reviewer"
  | "maintainer"
  | "administrator"
  | "system"
  | "policy";
export type EventType =
  | "activation-requested"
  | "activation-approved"
  | "clarification-recorded"
  | "frame-accepted"
  | "scope-repair-requested"
  | "execution-authorized"
  | "work-submitted"
  | "repair-requested"
  | "replan-requested"
  | "verification-passed"
  | "revision-requested"
  | "outcome-accepted"
  | "pause-requested"
  | "resume-requested"
  | "dependency-blocked"
  | "partial-effect-recorded"
  | "retry-requested"
  | "recovery-approved"
  | "cancel-requested"
  | "authorization-invalidated"
  | "binding-revalidated";

export interface LifecycleStateDefinition {
  readonly id: LifecycleState;
  readonly phaseOwner: PhaseOwner;
  readonly costBearing: boolean;
  readonly terminal: boolean;
}

export interface LifecycleRoute {
  readonly id: string;
  readonly version: "1.0.0";
  readonly from: LifecycleState;
  readonly to: LifecycleState;
  readonly event: EventType;
  readonly actorClasses: readonly ActorClass[];
  readonly phaseOwner: PhaseOwner;
  readonly costBearing: boolean;
  readonly humanGate: string | null;
  readonly retryable: boolean;
  readonly maxAttempts: number;
}

export interface LifecycleGraph {
  readonly apiVersion: ApiVersion;
  readonly kind: "LifecycleGraph";
  readonly metadata: {
    readonly name: string;
    readonly version: "1.0.0";
  };
  readonly states: readonly LifecycleStateDefinition[];
  readonly routes: readonly LifecycleRoute[];
}

export interface Budget {
  readonly maxCalls: number;
  readonly maxTokens: number;
  readonly maxCostUnits: number;
  readonly maxDurationMs: number;
  readonly maxRetries: number;
  readonly maxLoops: number;
  readonly maxParallel: number;
  readonly maxPatchBytes: number;
  readonly expiresAt: string;
}

export interface CopilotRuntimePolicy {
  readonly apiVersion: ApiVersion;
  readonly kind: "CopilotRuntimePolicy";
  readonly metadata: {
    readonly version: "1.0.0";
    readonly enabledByDefault: false;
  };
  readonly toolchain: {
    readonly ghAwVersion: "v0.86.2";
    readonly ghAwActionRef: string;
  };
  readonly modelSelection: {
    readonly provider: "copilot";
    readonly model: string;
    readonly fallbackAllowed: false;
    readonly selectionAuthority: "administrator-policy-and-activation-lease";
  };
  readonly phaseBindings: readonly {
    readonly phase: "framing" | "execution" | "verification";
    readonly role: "framer" | "executor" | "reviewer";
    readonly agent: string;
    readonly skill: string;
    readonly safetySkills: readonly ["authority-refusal"];
    readonly capability: string;
    readonly workflow: string | null;
    readonly workflowClass:
      | "framing-comment"
      | "target-free-execution"
      | "current-head-comment-review";
    readonly slashCommand: {
      readonly name: string;
      readonly events: readonly (
        | "issues"
        | "issue_comment"
        | "pull_request_comment"
      )[];
    };
    readonly githubToolsets: readonly string[];
    readonly githubTools: readonly string[];
    readonly modelInvocationAllowed: true;
  }[];
  readonly limits: {
    readonly timeoutMinutes: 10;
    readonly maxTurns: 8;
    readonly maxContinuations: 1;
    readonly maxAiCredits: 200;
    readonly maxThreatDetectionAiCredits: 100;
    readonly maxDailyAiCredits: 1500;
    readonly maxConcurrency: 1;
    readonly maxCascadeRuns: 0;
    readonly maxRecursionDepth: 0;
    readonly maxRepairLoops: 2;
    readonly maxPatchBytes: 262144;
    readonly maxEvidenceAgeMs: 300000;
  };
  readonly access: {
    readonly networkDestinations: readonly [];
    readonly mcpEnabled: false;
    readonly mcpServers: readonly [];
    readonly mcpTools: readonly [];
    readonly secretNames: readonly [];
    readonly patFallbackAllowed: false;
  };
  readonly safeOutputs: {
    readonly allowed: readonly [
      "issue-comment",
      "target-free-implementation-patch",
      "pull-request-review-comment"
    ];
    readonly pullRequestReviewEvents: readonly ["COMMENT"];
    readonly requireThreatDetectionStatus: "success";
  };
  readonly protectedFiles: {
    readonly mode: "blocked";
    readonly paths: readonly string[];
  };
}

export interface CopilotRuntimeState {
  readonly apiVersion: ApiVersion;
  readonly kind: "CopilotRuntimeState";
  readonly schemaVersion: "2.0.0";
  readonly repositoryId: number;
  readonly repositoryFullName: string;
  readonly workItemNodeId: string;
  readonly projectNodeId: string;
  readonly projectItemNodeId: string;
  readonly bindingDigest: Digest;
  readonly kernelBindingDigest: Digest;
  readonly workAccordSourceDigest: Digest;
  readonly state: "FRAMING" | "EXECUTING" | "VERIFYING";
  readonly phase: "framing" | "execution" | "verification";
  readonly role: "framer" | "executor" | "reviewer";
  readonly capability: string;
  readonly contractRevision: number;
  readonly workAccordDigest: Digest;
  readonly policyDigest: Digest;
  readonly kernelPolicyDigest: Digest;
  readonly activationLeaseDigest: Digest;
  readonly kernelReceiptDigest: Digest;
  readonly kernelRouteId: string;
  readonly workflowId: string;
  readonly stageAgentSelection?: {
    readonly grantDigest: Digest;
    readonly authorityEpoch: number;
    readonly generation: number;
    readonly runId: string;
    readonly runAttempt: number;
    readonly receiptHead: Digest | null;
    readonly policyGeneration: number;
    readonly selectionPolicyDigest: Digest;
    readonly stageAgentBindingsDigest: Digest;
    readonly capabilityRegistryDigest: Digest;
    readonly budgetAuthorityDigest: Digest;
  } | null;
  readonly activationNonce: string;
  readonly currentHead: string | null;
  readonly executionContext: RuntimeExecutionContext | null;
  readonly remainingAiCredits: number;
  readonly repairCount: number;
  readonly recursionDepth: number;
  readonly expiresAt: string;
  readonly signature: {
    readonly algorithm: "ed25519";
    readonly keyId: string;
    readonly value: string;
  };
}

export interface RuntimeExecutionContext {
  readonly schemaVersion: "1.0.0";
  readonly planningArtifact: {
    readonly schemaVersion: "1.0.0";
    readonly steps: readonly string[];
    readonly targetSlots: readonly string[];
    readonly verificationIds: readonly string[];
  };
  readonly planningArtifactDigest: Digest;
  readonly canonicalWorkAccord: string;
  readonly canonicalExecutionGrant: string;
  readonly executionGrantDigest: Digest;
  readonly patchSchema: "TargetFreePatch@1.0.0";
}

export interface CopilotRuntimeAuthorization {
  readonly apiVersion: ApiVersion;
  readonly kind: "CopilotRuntimeAuthorization";
  readonly schemaVersion: "2.0.0";
  readonly authorizationDigest: Digest;
  readonly candidateDigest: Digest;
  readonly inputDigest: Digest;
  readonly stateDigest: Digest;
  readonly policyDigest: Digest;
  readonly kernelPolicyDigest: Digest;
  readonly bindingDigest: Digest;
  readonly kernelBindingDigest: Digest;
  readonly workAccordSourceDigest: Digest;
  readonly repositoryId: number;
  readonly repositoryFullName: string;
  readonly workItemKind: "issue" | "pull-request";
  readonly workItemNumber: number;
  readonly workItemNodeId: string;
  readonly projectNodeId: string;
  readonly projectItemNodeId: string;
  readonly kernelReceiptDigest: Digest;
  readonly routeId: string;
  readonly phase: "framing" | "execution" | "verification";
  readonly role: "framer" | "executor" | "reviewer";
  readonly capability: string;
  readonly workflowId: string;
  readonly workflowRef: string;
  readonly workflowSha: string;
  readonly runId: number;
  readonly runAttempt: number;
  readonly eventName: string;
  readonly eventAction: string;
  readonly actorId: number;
  readonly actorLogin: string;
  readonly activationLeaseDigest: Digest;
  readonly activationNonce: string;
  readonly reservedAiCredits: number;
  readonly remainingAiCreditsBefore: number;
  readonly remainingAiCreditsAfter: number;
  readonly contractRevision: number;
  readonly contractDigest: Digest;
  readonly currentHead: string | null;
  readonly executionContext: RuntimeExecutionContext | null;
  readonly outputSchema: "GitHubSafeOutput@1.0.0" | "TargetFreePatch@1.0.0";
  readonly stateCommentId: number;
  readonly stateCommentUpdatedAt: string;
  readonly stateCollectionEtag: string;
  readonly stateRevoked: false;
  readonly leaseRevoked: false;
  readonly projectBindingVerified: true;
  readonly stateCheckedAt: string;
  readonly leaseCheckedAt: string;
  readonly redemptionKey: Digest;
  readonly casResult: "appended";
  readonly ledgerVersion: number;
  readonly ledgerHeadBefore: Digest | null;
  readonly ledgerHeadAfter: Digest;
  readonly redeemedAt: string;
  readonly expiresAt: string;
  readonly redeemerServiceId: string;
  readonly signature: {
    readonly algorithm: "ed25519";
    readonly keyId: string;
    readonly value: string;
  };
}

export interface WorkAccord {
  readonly apiVersion: ApiVersion;
  readonly kind: "WorkAccord";
  readonly identity: {
    readonly id: string;
    readonly revision: number;
    readonly supersedes: string | null;
    readonly createdAt: string;
    readonly createdBy: string;
  };
  readonly binding: {
    readonly repositoryId: number;
    readonly repositoryNodeId: string;
    readonly repositoryFullName: string;
    readonly repositoryRootId: Digest;
    readonly workItemNodeId: string;
    readonly defaultRef: "refs/heads/main";
    readonly proposalRef: `refs/heads/agentic-domain/${string}`;
    readonly sourceDigest: Digest;
    readonly policyDigest: Digest;
    readonly lifecycleGraphDigest: Digest;
    readonly currentHead: Digest | null;
  };
  readonly objective: {
    readonly outcome: string;
    readonly inScope: readonly string[];
    readonly outOfScope: readonly string[];
    readonly assumptions: readonly string[];
    readonly dependencies: readonly string[];
  };
  readonly policy: {
    readonly domainPack: string;
    readonly domainPackDigest: Digest;
    readonly capabilityRegistryDigest: Digest;
    readonly depthProfile: "D0" | "D1" | "D2" | "D3";
    readonly riskClass: "low" | "moderate" | "high" | "critical";
    readonly privacyClass: "public" | "internal" | "confidential" | "restricted";
    readonly phaseContracts: Readonly<
      Partial<
        Record<
        ActivePhaseOwner,
        { readonly reference: string; readonly digest: Digest }
        >
      >
    >;
    readonly requestedCapabilities: readonly string[];
    readonly allowedPaths: readonly string[];
    readonly prohibitedEffects: readonly string[];
    readonly tools: readonly string[];
    readonly shellCommands: readonly string[];
    readonly network: readonly string[];
    readonly mcpTools: readonly string[];
    readonly secretAccess: false;
  };
  readonly budget: Budget;
  readonly deliverables: readonly string[];
  readonly evidence: {
    readonly required: readonly string[];
    readonly verificationCommands: readonly string[];
    readonly approverPolicy: string;
  };
  readonly humanGates: readonly string[];
  readonly retention: {
    readonly receiptDays: number;
    readonly artifactDays: number;
    readonly cancelOnExpiry: boolean;
  };
}

export type JsonSchema = Readonly<Record<string, unknown>>;

export interface PhaseContract {
  readonly apiVersion: ApiVersion;
  readonly kind: "PhaseContract";
  readonly identity: { readonly id: string; readonly version: string };
  readonly phase: ActivePhaseOwner;
  readonly compatibleLifecycle: "1.0.0";
  readonly compatibleLifecycleDigest: Digest;
  readonly entryPredicates: readonly string[];
  readonly requiredEvidence: readonly string[];
  readonly allowedCapabilities: readonly string[];
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  readonly exitRules: readonly {
    readonly predicate: string;
    readonly event: string;
  }[];
  readonly limits: {
    readonly maxLoops: number;
    readonly maxCalls: number;
    readonly maxCostUnits: number;
    readonly maxParallel: number;
  };
  readonly humanGates: readonly string[];
  readonly privacy: {
    readonly maximumClass: "public" | "internal" | "confidential" | "restricted";
    readonly retentionDays: number;
  };
}

export interface Capability {
  readonly id: string;
  readonly version: string;
  readonly publisher: string;
  readonly owner: string;
  readonly description: string;
  readonly status: "active" | "disabled" | "deprecated";
  readonly implementation: {
    readonly kind: "deterministic" | "model";
    readonly provider: string;
  };
  readonly allowedPhases: readonly ActivePhaseOwner[];
  readonly actorClasses: readonly ActorClass[];
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  readonly access: {
    readonly readScopes: readonly string[];
    readonly write: { readonly allowed: false; readonly scopes: readonly [] };
    readonly tools: readonly string[];
    readonly shellCommands: readonly string[];
    readonly networkDestinations: readonly string[];
    readonly mcpTools: readonly string[];
    readonly mcpReadTools: readonly string[];
    readonly mcpMutationTools: readonly string[];
    readonly secretNames: readonly [];
  };
  readonly effectClass: "none" | "advisory-artifact" | "verification-result";
  readonly risk: {
    readonly class: "low" | "moderate" | "high";
    readonly trustZone: "T0" | "T2" | "T3" | "T4";
    readonly privacyClass: "public" | "internal" | "confidential" | "restricted";
  };
  readonly limits: {
    readonly maxCalls: number;
    readonly maxCostUnits: number;
    readonly timeoutMs: number;
    readonly maxRetries: number;
    readonly maxOutputBytes: number;
    readonly maxConcurrency: number;
    readonly parallelSafe: boolean;
  };
  readonly humanGates: readonly string[];
  readonly idempotency: {
    readonly required: true;
    readonly scope: "work-item" | "contract-revision" | "event";
  };
  readonly evidence: readonly string[];
  readonly evaluations: {
    readonly structural: readonly string[];
    readonly behavioral: readonly string[];
  };
  readonly provenance: {
    readonly classification: "original" | "conceptual" | "adapted" | "verbatim";
    readonly legalReview: "not-required" | "pending" | "approved" | "rejected";
    readonly securityReview: "pending" | "approved" | "rejected";
  };
  readonly compatibility: {
    readonly lifecycle: "1.0.0";
    readonly replacement: string | null;
  };
}

export interface CapabilityRegistry {
  readonly apiVersion: ApiVersion;
  readonly kind: "CapabilityRegistry";
  readonly metadata: { readonly version: "1.0.0" };
  readonly defaults: {
    readonly tools: "deny";
    readonly network: "deny";
    readonly writes: "deny";
    readonly secrets: "deny";
  };
  readonly capabilities: readonly Capability[];
}

export interface CompiledCapabilityGrant {
  readonly reference: string;
  readonly actorClasses: readonly ActorClass[];
  readonly humanGates: readonly string[];
  readonly readScopes: readonly string[];
  readonly tools: readonly string[];
  readonly shellCommands: readonly string[];
  readonly networkDestinations: readonly string[];
  readonly mcpTools: readonly string[];
  readonly riskClass: "low" | "moderate" | "high";
  readonly privacyClass: "public" | "internal" | "confidential" | "restricted";
  readonly limits: {
    readonly maxCalls: number;
    readonly maxCostUnits: number;
    readonly timeoutMs: number;
    readonly maxRetries: number;
    readonly maxOutputBytes: number;
    readonly maxConcurrency: number;
    readonly parallelSafe: boolean;
  };
  readonly evidence: readonly string[];
  readonly structuralEvaluations: readonly string[];
  readonly behavioralEvaluations: readonly string[];
}

export interface ActorRule {
  readonly actorClass: ActorClass;
  readonly requiredRoles: readonly string[];
  readonly human: boolean;
}

export interface ControlPolicy {
  readonly apiVersion: ApiVersion;
  readonly kind: "ControlPolicy";
  readonly version: "1.0.0";
  readonly actorRules: readonly ActorRule[];
  readonly independentGates: readonly string[];
  readonly prohibitedEffects: readonly string[];
  readonly ceilings: {
    readonly depthProfile: "D0" | "D1" | "D2" | "D3";
    readonly riskClass: "low" | "moderate" | "high" | "critical";
    readonly privacyClass: "public" | "internal" | "confidential" | "restricted";
    readonly maxCalls: number;
    readonly maxCostUnits: number;
    readonly maxLoops: number;
    readonly maxRetries: number;
    readonly maxParallel: number;
  };
}

export interface DomainPackPolicy {
  readonly apiVersion: ApiVersion;
  readonly kind: "DomainPackPolicy";
  readonly id: string;
  readonly version: string;
  readonly allowedCapabilities: readonly string[];
  readonly prohibitedEffects: readonly string[];
  readonly depthCeiling: "D0" | "D1" | "D2" | "D3";
  readonly riskCeiling: "low" | "moderate" | "high" | "critical";
  readonly privacyCeiling: "public" | "internal" | "confidential" | "restricted";
  readonly maxCalls: number;
  readonly maxCostUnits: number;
  readonly maxLoops: number;
  readonly maxRetries: number;
  readonly maxParallel: number;
}

export interface Actor {
  readonly id: string;
  readonly class: ActorClass;
  readonly human: boolean;
  readonly bot: boolean;
  readonly roles: readonly string[];
  readonly authorizationDigest: Digest;
}

export interface EventEnvelope {
  readonly apiVersion: ApiVersion;
  readonly kind: "KernelEvent";
  readonly id: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly expectedStateVersion: number;
  readonly type: EventType;
  readonly replacementAuthorityDigest: Digest | null;
  readonly actor: Actor;
  readonly provenance: {
    readonly source:
      | "trusted-adapter"
      | "policy-engine"
      | "kernel-recovery"
      | "test-fixture";
    readonly deliveryId: string;
    readonly bindingDigest: Digest;
    readonly payloadDigest: Digest;
  };
  readonly cost: {
    readonly calls: number;
    readonly tokens: number;
    readonly costUnits: number;
    readonly loops: number;
  };
}

export interface AuthorityRebind {
  readonly apiVersion: ApiVersion;
  readonly kind: "AuthorityRebind";
  readonly schemaVersion: "1.0.0";
  readonly bindingDigest: Digest;
  readonly graph: LifecycleGraph;
  readonly workAccord: WorkAccord;
  readonly policy: ControlPolicy;
  readonly registry: CapabilityRegistry;
  readonly domainPack: DomainPackPolicy;
  readonly phaseContracts: readonly PhaseContract[];
}

export interface ActivationLease {
  readonly apiVersion: ApiVersion;
  readonly kind: "ActivationLease";
  readonly id: string;
  readonly workAccordDigest: Digest;
  readonly approvedBy: string;
  readonly authorizationDigest: Digest;
  readonly allowedPhases: readonly ActivePhaseOwner[];
  readonly allowedCapabilities: readonly string[];
  readonly maxCalls: number;
  readonly maxTokens: number;
  readonly maxCostUnits: number;
  readonly maxParallel: number;
  readonly expiresAt: string;
  readonly revoked: boolean;
}

export interface HumanGateEvidence {
  readonly gate: string;
  readonly actor: Actor;
  readonly workAccordDigest: Digest;
  readonly activationLeaseDigest: Digest | null;
  readonly currentHead: Digest | null;
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly valid: boolean;
}

export type ContractPredicate =
  | "accepted-patch-plan-current"
  | "accepted-plan-current"
  | "activation-lease-current"
  | "advisory-current"
  | "all-current-head-security-evidence-success"
  | "base-sha-current"
  | "draft-pr-exact-head-current"
  | "draft-pull-request-head-current"
  | "work-accord-current"
  | "eligible-human-accepts-frame"
  | "eligible-human-accepts-plan"
  | "eligible-human-accepts-remediation-frame"
  | "eligible-human-accepts-target-free-patch-plan"
  | "work-submitted-for-verification"
  | "verification-evidence-passed"
  | "eligible-independent-human-accepts-merged-head"
  | "eligible-independent-human-accepts-current-head"
  | "exact-head-verification-passed"
  | "framing-artifacts-current"
  | "known-unrelated-alert-open"
  | "network-denied"
  | "remediation-design-receipt-current"
  | "signed-stage-artifact-valid-and-hermetic"
  | "synthetic-advisory-signature-valid"
  | "target-free-patch-validated-and-draft-pr-observed"
  | "trusted-draft-pull-request-created"
  | "trusted-repository-base-current"
  | "trusted-security-remediation-binding-current"
  | "trusted-target-slot-map-current"
  | "verification-head-current"
  | "verification-receipt-current"
  | "eligible-human-accepts-outcome";

export type ContractEvidenceType =
  | "accepted-frame"
  | "accepted-patch-plan"
  | "accepted-plan"
  | "activation-lease"
  | "comment-only-review"
  | "dependency-lock-consistency-success"
  | "dlp-success"
  | "draft-patch-pr"
  | "draft-pull-request-evidence"
  | "exact-base-sha"
  | "fixed-command-catalog"
  | "fixed-regression-success"
  | "hermetic-reproduction-policy"
  | "human-review-package"
  | "known-alert-unchanged"
  | "logical-target-map"
  | "remediation-design"
  | "security-regression-verification"
  | "signed-synthetic-advisory"
  | "signed-synthetic-scanner-success"
  | "target-slot-map"
  | "threat-detection-success"
  | "trusted-binding"
  | "validated-patch"
  | "verification-report";

export interface ContractRequirementEvidence {
  readonly apiVersion: ApiVersion;
  readonly kind: "ContractRequirementEvidence";
  readonly requirementType: "predicate" | "evidence";
  readonly requirement: string;
  readonly satisfied: boolean;
  readonly workAccordDigest: Digest;
  readonly bindingDigest: Digest;
  readonly snapshotDigest: Digest;
  readonly phaseContractDigest: Digest;
  readonly routeId: string;
  readonly activationLeaseDigest: Digest | null;
  readonly currentHead: Digest | null;
  readonly actorAuthorizationDigest: Digest | null;
  readonly observedAt: string;
  readonly expiresAt: string;
}

export interface Usage {
  readonly calls: number;
  readonly tokens: number;
  readonly costUnits: number;
  readonly loops: number;
  readonly retries: number;
}

export interface ProcessedEvent {
  readonly eventDigest: Digest;
  readonly receiptDigest: Digest;
  readonly idempotencyKey: Digest;
  readonly deliveryId: string;
}

export interface KernelSnapshot {
  readonly schemaVersion: "1.0.0";
  readonly lifecycleVersion: "1.0.0";
  readonly lifecycleGraphDigest: Digest;
  readonly state: LifecycleState;
  readonly phaseOwner: PhaseOwner;
  readonly stateVersion: number;
  readonly lastEventSequence: number;
  readonly bindingDigest: Digest;
  readonly workAccordDigest: Digest;
  readonly capabilityRegistryDigest: Digest;
  readonly domainPackDigest: Digest;
  readonly phaseContractDigest: Digest | null;
  readonly compiledPolicyDigest: Digest | null;
  readonly policyDigest: Digest;
  readonly currentHead: Digest | null;
  readonly receiptHead: Digest | null;
  readonly suspendedState: LifecycleState | null;
  readonly recoveryState: LifecycleState | null;
  readonly usage: Usage;
  readonly phaseUsage: Usage;
  readonly routeAttempts: Readonly<Record<string, number>>;
  readonly processedEvents: Readonly<Record<string, ProcessedEvent>>;
}

export type RefusalCode =
  | "SCHEMA_INVALID"
  | "GRAPH_INVALID"
  | "UNKNOWN_VERSION"
  | "INVALID_TRANSITION"
  | "AMBIGUOUS_ROUTE"
  | "UNAUTHORIZED_ACTOR"
  | "INDEPENDENCE_REQUIRED"
  | "HUMAN_GATE_MISSING"
  | "HUMAN_GATE_STALE"
  | "ACTIVATION_REQUIRED"
  | "LEASE_EXPIRED"
  | "LEASE_REVOKED"
  | "CONTRACT_STALE"
  | "CURRENT_HEAD_STALE"
  | "REPLAY_CONFLICT"
  | "REPLAY_OUT_OF_ORDER"
  | "CONCURRENCY_CONFLICT"
  | "PROVENANCE_INVALID"
  | "BUDGET_EXHAUSTED"
  | "LOOP_LIMIT_EXHAUSTED"
  | "RETRY_NOT_ALLOWED"
  | "RETRY_LIMIT_EXHAUSTED"
  | "REGISTRY_INVALID"
  | "POLICY_ESCALATION"
  | "CONTRACT_REQUIREMENT_MISSING"
  | "NUMERIC_OVERFLOW"
  | "MIGRATION_UNAVAILABLE";

export interface KernelRefusal {
  readonly code: RefusalCode;
  readonly message: string;
  readonly ruleId: string;
  readonly retryable: boolean;
  readonly recovery: "reconcile" | "human-authorization" | "new-contract" | "none";
}

export type KernelEffect =
  | {
      readonly type: "emit-receipt";
      readonly eventId: string;
    }
  | {
      readonly type: "enter-phase";
      readonly phase: ActivePhaseOwner;
      readonly capabilities: readonly CompiledCapabilityGrant[];
    }
  | {
      readonly type: "request-reconciliation";
      readonly reason: string;
    }
  | {
      readonly type: "request-human-action";
      readonly gate: string;
    };

export interface TransitionReceipt {
  readonly schemaVersion: "1.0.0";
  readonly eventId: string;
  readonly eventDigest: Digest;
  readonly routeId: string;
  readonly routeVersion: "1.0.0";
  readonly from: LifecycleState;
  readonly to: LifecycleState;
  readonly stateVersion: number;
  readonly previousReceipt: Digest | null;
  readonly idempotencyKey: Digest;
  readonly replacementAuthorityDigest: Digest | null;
  readonly bindingDigest: Digest;
  readonly lifecycleGraphDigest: Digest;
  readonly workAccordDigest: Digest;
  readonly capabilityRegistryDigest: Digest;
  readonly domainPackDigest: Digest;
  readonly destinationBindingDigest: Digest;
  readonly destinationLifecycleGraphDigest: Digest;
  readonly destinationWorkAccordDigest: Digest;
  readonly destinationCapabilityRegistryDigest: Digest;
  readonly destinationDomainPackDigest: Digest;
  readonly sourcePhaseContractDigest: Digest | null;
  readonly sourceCompiledPolicyDigest: Digest | null;
  readonly destinationPhaseContractDigest: Digest | null;
  readonly destinationCompiledPolicyDigest: Digest | null;
  readonly policyDigest: Digest;
  readonly destinationPolicyDigest: Digest;
  readonly actorId: string;
  readonly actorAuthorizationDigest: Digest;
  readonly occurredAt: string;
  readonly effectPlanDigest: Digest;
}

export type KernelResult =
  | {
      readonly kind: "applied";
      readonly route: LifecycleRoute;
      readonly snapshot: KernelSnapshot;
      readonly receipt: TransitionReceipt;
      readonly receiptDigest: Digest;
      readonly effects: readonly KernelEffect[];
    }
  | {
      readonly kind: "noop";
      readonly reason: "duplicate-event";
      readonly receiptDigest: Digest;
      readonly snapshot: KernelSnapshot;
    }
  | {
      readonly kind: "refused";
      readonly refusal: KernelRefusal;
      readonly snapshot: KernelSnapshot;
    };
