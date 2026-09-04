import {
  Ajv2020,
  type ErrorObject,
  type ValidateFunction
} from "ajv/dist/2020.js";

import capabilityRegistrySchema from "../schemas/v1alpha1/capability-registry.schema.json" with { type: "json" };
import agentParticipationPolicySchema from "../schemas/v1alpha1/agent-participation-policy.schema.json" with { type: "json" };
import demoActivationProfileSchema from "../schemas/v1alpha1/demo-activation-profile.schema.json" with { type: "json" };
import demoCapabilityRegistryShardSchema from "../schemas/v1alpha1/demo-capability-registry-shard.schema.json" with { type: "json" };
import demoCatalogSchema from "../schemas/v1alpha1/demo-catalog.schema.json" with { type: "json" };
import demoContractCommonSchema from "../schemas/v1alpha1/demo-contract-common.schema.json" with { type: "json" };
import demoDispatchDecisionSchema from "../schemas/v1alpha1/demo-dispatch-decision.schema.json" with { type: "json" };
import demoIdentityReservationManifestSchema from "../schemas/v1alpha1/demo-identity-reservation-manifest.schema.json" with { type: "json" };
import demoJourneyDefinitionSchema from "../schemas/v1alpha1/demo-journey-definition.schema.json" with { type: "json" };
import demoProjectProfileSchema from "../schemas/v1alpha1/demo-project-profile.schema.json" with { type: "json" };
import demoProjectTargetManifestSchema from "../schemas/v1alpha1/demo-project-target-manifest.schema.json" with { type: "json" };
import demoProjectionMappingSchema from "../schemas/v1alpha1/demo-projection-mapping.schema.json" with { type: "json" };
import demoRunFenceSchema from "../schemas/v1alpha1/demo-run-fence.schema.json" with { type: "json" };
import demoRunStateSchema from "../schemas/v1alpha1/demo-run-state.schema.json" with { type: "json" };
import demoRuntimeRefusalSchema from "../schemas/v1alpha1/demo-runtime-refusal.schema.json" with { type: "json" };
import demoReviewEvidenceBundleSchema from "../schemas/v1alpha1/demo-review-evidence-bundle.schema.json" with { type: "json" };
import demoScheduleDecisionSchema from "../schemas/v1alpha1/demo-schedule-decision.schema.json" with { type: "json" };
import signedStageReceiptSchema from "../schemas/v1alpha1/signed-stage-receipt.schema.json" with { type: "json" };
import signedStageAgentSelectionGrantSchema from "../schemas/v1alpha1/signed-stage-agent-selection-grant.schema.json" with { type: "json" };
import stageAgentBindingSetSchema from "../schemas/v1alpha1/stage-agent-binding-set.schema.json" with { type: "json" };
import stageArtifactEnvelopeSchema from "../schemas/v1alpha1/stage-artifact-envelope.schema.json" with { type: "json" };
import copilotRuntimePolicySchema from "../schemas/v1alpha1/copilot-runtime-policy.schema.json" with { type: "json" };
import copilotRuntimeAuthorizationSchema from "../schemas/v1alpha1/copilot-runtime-authorization.schema.json" with { type: "json" };
import copilotRuntimeStateSchema from "../schemas/v1alpha1/copilot-runtime-state.schema.json" with { type: "json" };
import compiledPolicySchema from "../schemas/v1alpha1/compiled-policy.schema.json" with { type: "json" };
import contractRequirementEvidenceSchema from "../schemas/v1alpha1/contract-requirement-evidence.schema.json" with { type: "json" };
import activationLeaseSchema from "../schemas/v1alpha1/activation-lease.schema.json" with { type: "json" };
import auditEventSchema from "../schemas/v1alpha1/audit-event.schema.json" with { type: "json" };
import authorityRebindSchema from "../schemas/v1alpha1/authority-rebind.schema.json" with { type: "json" };
import budgetDecisionEvidenceSchema from "../schemas/v1alpha1/budget-decision-evidence.schema.json" with { type: "json" };
import domainArtifactPolicyAssessmentSchema from "../schemas/v1alpha1/domain-artifact-policy-assessment.schema.json" with { type: "json" };
import eventEnvelopeSchema from "../schemas/v1alpha1/event-envelope.schema.json" with { type: "json" };
import domainPackPolicySchema from "../schemas/v1alpha1/domain-pack-policy.schema.json" with { type: "json" };
import domainOperationGrantClaimSchema from "../schemas/v1alpha1/domain-operation-grant-claim.schema.json" with { type: "json" };
import domainOperationGrantStoreHeadSchema from "../schemas/v1alpha1/domain-operation-grant-store-head.schema.json" with { type: "json" };
import durableStoreBackupManifestSchema from "../schemas/v1alpha1/durable-store-backup-manifest.schema.json" with { type: "json" };
import durableStoreCompositionBackupManifestSchema from "../schemas/v1alpha1/durable-store-composition-backup-manifest.schema.json" with { type: "json" };
import durableStoreJournalRecordSchema from "../schemas/v1alpha1/durable-store-journal-record.schema.json" with { type: "json" };
import engineeringEffectEvidenceSchema from "../schemas/v1alpha1/engineering-effect-evidence.schema.json" with { type: "json" };
import humanGateEvidenceSchema from "../schemas/v1alpha1/human-gate-evidence.schema.json" with { type: "json" };
import githubEffectPlanSchema from "../schemas/v1alpha1/github-effect-plan.schema.json" with { type: "json" };
import githubEffectEvidenceSchema from "../schemas/v1alpha1/github-effect-evidence.schema.json" with { type: "json" };
import githubProjectBindingSchema from "../schemas/v1alpha1/github-project-binding.schema.json" with { type: "json" };
import githubProjectAdminSnapshotSchema from "../schemas/v1alpha1/github-project-admin-snapshot.schema.json" with { type: "json" };
import githubProjectDisplayColorPlanSchema from "../schemas/v1alpha1/github-project-display-color-plan.schema.json" with { type: "json" };
import githubProjectDisplayColorReadbackSchema from "../schemas/v1alpha1/github-project-display-color-readback.schema.json" with { type: "json" };
import githubProjectDisplayCommonSchema from "../schemas/v1alpha1/github-project-display-common.schema.json" with { type: "json" };
import githubProjectDisplaySnapshotSchema from "../schemas/v1alpha1/github-project-display-snapshot.schema.json" with { type: "json" };
import githubProjectDisplayTargetManifestSchema from "../schemas/v1alpha1/github-project-display-target-manifest.schema.json" with { type: "json" };
import githubProjectLiveSchema from "../schemas/v1alpha1/github-project-live.schema.json" with { type: "json" };
import githubProjectSchema from "../schemas/v1alpha1/github-project-schema.schema.json" with { type: "json" };
import githubSafeOutputSchema from "../schemas/v1alpha1/github-safe-output.schema.json" with { type: "json" };
import lifecycleGraphSchema from "../schemas/v1alpha1/lifecycle-graph.schema.json" with { type: "json" };
import kernelSnapshotSchema from "../schemas/v1alpha1/kernel-snapshot.schema.json" with { type: "json" };
import phaseContractSchema from "../schemas/v1alpha1/phase-contract.schema.json" with { type: "json" };
import policySchema from "../schemas/v1alpha1/policy.schema.json" with { type: "json" };
import transitionReceiptSchema from "../schemas/v1alpha1/transition-receipt.schema.json" with { type: "json" };
import targetFreePatchSchema from "../schemas/v1alpha1/target-free-patch.schema.json" with { type: "json" };
import trustedValidatedPatchArtifactSchema from "../schemas/v1alpha1/trusted-validated-patch-artifact.schema.json" with { type: "json" };
import workAccordSchema from "../schemas/v1alpha1/work-accord.schema.json" with { type: "json" };
import packagingSchema from "../schemas/v1alpha1/packaging.schema.json" with { type: "json" };
import deploymentTopologySchema from "../schemas/v1alpha1/deployment-topology.schema.json" with { type: "json" };
import githubAppRegistrationPlanSchema from "../schemas/v1alpha1/github-app-registration-plan.schema.json" with { type: "json" };
import githubAppPermissionReadbackSchema from "../schemas/v1alpha1/github-app-permission-readback.schema.json" with { type: "json" };
import administratorPlanSchema from "../schemas/v1alpha1/administrator-plan.schema.json" with { type: "json" };
import administratorReadbackSchema from "../schemas/v1alpha1/administrator-readback.schema.json" with { type: "json" };
import administratorHandoffSchema from "../schemas/v1alpha1/administrator-handoff.schema.json" with { type: "json" };
import githubAppInstallationTargetBindingSchema from "../schemas/v1alpha1/github-app-installation-target-binding.schema.json" with { type: "json" };
import type {
  CapabilityRegistry,
  CopilotRuntimeAuthorization,
  CopilotRuntimePolicy,
  CopilotRuntimeState,
  ActivationLease,
  AuthorityRebind,
  ContractRequirementEvidence,
  ControlPolicy,
  DomainPackPolicy,
  EventEnvelope,
  HumanGateEvidence,
  KernelSnapshot,
  LifecycleGraph,
  PhaseContract,
  TransitionReceipt,
  WorkAccord
} from "./types.js";
import type {
  DemoActivationProfile,
  AgentParticipationPolicy,
  DemoCapabilityRegistryShard,
  DemoCatalog,
  DemoDispatchDecision,
  DemoIdentityReservationManifest,
  DemoJourneyDefinition,
  DemoProjectProfile,
  DemoProjectTargetManifest,
  DemoProjectionMapping,
  DemoRunFence,
  DemoRunState,
  DemoRuntimeRefusal,
  DemoScheduleDecision,
  SignedStageReceipt,
  SignedStageAgentSelectionGrant,
  StageAgentBindingSet,
  StageArtifactEnvelope
} from "./demo-types.js";
import type { CompiledPolicy } from "./policy.js";
import type {
  GitHubEffectPlan,
  GitHubProjectBinding,
  GitHubProjectSchema,
  GitHubSafeOutput
} from "./github-types.js";
import type {
  LiveDemoProjectAdminSnapshot,
  LiveGitHubProject
} from "./github-projects.js";
import type {
  GitHubProjectDisplayColorPlan,
  GitHubProjectDisplayColorReadback,
  GitHubProjectDisplaySnapshot,
  GitHubProjectDisplayTargetManifest
} from "./github-project-display-colors.js";
import type { GitHubEvidenceRecord } from "./github-adapter.js";
import type { TargetFreePatch } from "./bounded-worktree.js";
import type { TrustedValidatedPatchArtifact } from "./execution-bridge.js";
import type { DemoReviewEvidenceBundle } from "./demo-review-evidence.js";
import type { EngineeringEffectEvidence } from "./engineering-slice.js";
import type {
  DurableBackupManifest,
  DurableStoreJournalRecord
} from "./durable-substrate.js";
import type { DurableStoreCompositionBackupManifest } from "./durable-store-composition.js";
import type {
  BudgetDecisionEvidence,
  AuditEvent,
  MetricRecord
} from "./observability.js";
import metricRecordSchema from "../schemas/v1alpha1/metric-record.schema.json" with { type: "json" };
import type {
  DomainArtifactPolicyAssessment,
  DomainOperationGrantClaim,
  DomainOperationGrantStoreHead
} from "./domain-packs.js";
import type { PackagingDocument } from "./packaging-types.js";
import { isReleasePath } from "./release-path.js";
import type { DeploymentTopologyPlan } from "./deployment-topology.js";
import type {
  GitHubAppRegistrationPlan,
  GitHubAppInstallationTargetBinding,
  GitHubAppPermissionReadback
} from "./app-registration-plan.js";
import type {
  AdministratorPlan,
  AdministratorReadback
} from "./administrator-plan.js";
import type {
  AdministratorApplyConfirmation,
  AdministratorApplyPlan,
  AdministratorApplyReadback,
  AdministratorHandoffPlan,
  AdministratorHandoffReadback,
  AdministratorHandoffReport
} from "./administrator-handoff.js";

export type AdministratorHandoffDocument =
  | AdministratorHandoffPlan
  | AdministratorHandoffReadback
  | AdministratorApplyPlan
  | AdministratorApplyConfirmation
  | AdministratorApplyReadback
  | AdministratorHandoffReport;

export type DocumentKind =
  | "LifecycleGraph"
  | "AuditEvent"
  | "BudgetDecisionEvidence"
  | "WorkAccord"
  | "PhaseContract"
  | "CapabilityRegistry"
  | "AgentParticipationPolicy"
  | "DemoCatalog"
  | "DemoIdentityReservationManifest"
  | "DemoProjectProfile"
  | "DemoProjectTargetManifest"
  | "DemoJourneyDefinition"
  | "StageAgentBindingSet"
  | "DemoCapabilityRegistryShard"
  | "DemoActivationProfile"
  | "DemoRunState"
  | "DemoRunFence"
  | "StageArtifactEnvelope"
  | "SignedStageReceipt"
  | "SignedStageAgentSelectionGrant"
  | "DemoProjectionMapping"
  | "DemoDispatchDecision"
  | "DemoScheduleDecision"
  | "DemoRuntimeRefusal"
  | "DemoReviewEvidenceBundle"
  | "CopilotRuntimePolicy"
  | "CopilotRuntimeAuthorization"
  | "CopilotRuntimeState"
  | "CompiledPolicy"
  | "ContractRequirementEvidence"
  | "ControlPolicy"
  | "DomainPackPolicy"
  | "DomainArtifactPolicyAssessment"
  | "DomainOperationGrantClaim"
  | "DomainOperationGrantStoreHead"
  | "DurableStoreJournalRecord"
  | "DurableStoreBackupManifest"
  | "DurableStoreCompositionBackupManifest"
  | "EngineeringEffectEvidence"
  | "HumanGateEvidence"
  | "ActivationLease"
  | "AuthorityRebind"
  | "KernelSnapshot"
  | "TransitionReceipt"
  | "KernelEvent"
  | "MetricRecord"
  | "GitHubProjectSchema"
  | "GitHubProjectBinding"
  | "GitHubProjectAdminSnapshot"
  | "GitHubProjectDisplaySnapshot"
  | "GitHubProjectDisplayTargetManifest"
  | "GitHubProjectDisplayColorPlan"
  | "GitHubProjectDisplayColorReadback"
  | "GitHubProjectLive"
  | "GitHubSafeOutput"
  | "TargetFreePatch"
  | "TrustedValidatedPatchArtifact"
  | "GitHubEffectEvidence"
  | "GitHubEffectPlan"
  | "PackagingDocument"
  | "DeploymentTopologyPlan"
  | "GitHubAppRegistrationPlan"
  | "GitHubAppInstallationTargetBinding"
  | "GitHubAppPermissionReadback"
  | "AdministratorPlan"
  | "AdministratorReadback"
  | "AdministratorHandoffDocument";

export interface ValidationSuccess<T> {
  readonly valid: true;
  readonly value: T;
}

export interface ValidationFailure {
  readonly valid: false;
  readonly errors: readonly string[];
}

export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;

const immutableDocumentKinds = new Set<DocumentKind>([
  "DemoCatalog",
  "AgentParticipationPolicy",
  "DemoIdentityReservationManifest",
  "DemoProjectProfile",
  "DemoProjectTargetManifest",
  "DemoJourneyDefinition",
  "StageAgentBindingSet",
  "DemoCapabilityRegistryShard",
  "DemoActivationProfile",
  "DemoRunState",
  "DemoRunFence",
  "StageArtifactEnvelope",
  "SignedStageReceipt",
  "SignedStageAgentSelectionGrant",
  "DemoProjectionMapping",
  "DemoDispatchDecision",
  "DemoScheduleDecision",
  "DemoRuntimeRefusal",
  "DemoReviewEvidenceBundle",
  "GitHubProjectDisplayTargetManifest",
  "GitHubProjectDisplayColorPlan",
  "GitHubProjectDisplayColorReadback",
  "AdministratorHandoffDocument"
]);

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

export function isCanonicalUtcDateTime(value: string): boolean {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/.exec(
      value
    );
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return false;
  }
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31
  ];
  return day >= 1 && day <= (daysInMonth[month - 1] ?? 0);
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addFormat("date-time", {
  type: "string",
  validate: isCanonicalUtcDateTime
});
ajv.addFormat("release-path", {
  type: "string",
  validate: isReleasePath
});
ajv.addSchema(capabilityRegistrySchema);
ajv.addSchema(demoContractCommonSchema);
ajv.addSchema(githubProjectDisplayCommonSchema);

function registeredValidator(id: string): ValidateFunction {
  const validator = ajv.getSchema(id);
  if (validator === undefined) {
    throw new TypeError(`JSON Schema ${id} was not registered`);
  }
  return validator;
}

const validators: Record<DocumentKind, ValidateFunction> = {
  LifecycleGraph: ajv.compile(lifecycleGraphSchema),
  AuditEvent: ajv.compile(auditEventSchema),
  BudgetDecisionEvidence: ajv.compile(budgetDecisionEvidenceSchema),
  WorkAccord: ajv.compile(workAccordSchema),
  PhaseContract: ajv.compile(phaseContractSchema),
  CapabilityRegistry: registeredValidator(capabilityRegistrySchema.$id),
  AgentParticipationPolicy: ajv.compile(agentParticipationPolicySchema),
  DemoCatalog: ajv.compile(demoCatalogSchema),
  DemoIdentityReservationManifest: ajv.compile(
    demoIdentityReservationManifestSchema
  ),
  DemoProjectProfile: ajv.compile(demoProjectProfileSchema),
  DemoProjectTargetManifest: ajv.compile(demoProjectTargetManifestSchema),
  DemoJourneyDefinition: ajv.compile(demoJourneyDefinitionSchema),
  StageAgentBindingSet: ajv.compile(stageAgentBindingSetSchema),
  DemoCapabilityRegistryShard: ajv.compile(demoCapabilityRegistryShardSchema),
  DemoActivationProfile: ajv.compile(demoActivationProfileSchema),
  DemoRunState: ajv.compile(demoRunStateSchema),
  DemoRunFence: ajv.compile(demoRunFenceSchema),
  StageArtifactEnvelope: ajv.compile(stageArtifactEnvelopeSchema),
  SignedStageReceipt: ajv.compile(signedStageReceiptSchema),
  SignedStageAgentSelectionGrant: ajv.compile(
    signedStageAgentSelectionGrantSchema
  ),
  DemoProjectionMapping: ajv.compile(demoProjectionMappingSchema),
  DemoDispatchDecision: ajv.compile(demoDispatchDecisionSchema),
  DemoScheduleDecision: ajv.compile(demoScheduleDecisionSchema),
  DemoRuntimeRefusal: ajv.compile(demoRuntimeRefusalSchema),
  DemoReviewEvidenceBundle: ajv.compile(demoReviewEvidenceBundleSchema),
  CopilotRuntimePolicy: ajv.compile(copilotRuntimePolicySchema),
  CopilotRuntimeAuthorization: ajv.compile(copilotRuntimeAuthorizationSchema),
  CopilotRuntimeState: ajv.compile(copilotRuntimeStateSchema),
  CompiledPolicy: ajv.compile(compiledPolicySchema),
  ContractRequirementEvidence: ajv.compile(contractRequirementEvidenceSchema),
  ControlPolicy: ajv.compile(policySchema),
  DomainPackPolicy: ajv.compile(domainPackPolicySchema),
  DomainArtifactPolicyAssessment: ajv.compile(
    domainArtifactPolicyAssessmentSchema
  ),
  DomainOperationGrantClaim: ajv.compile(domainOperationGrantClaimSchema),
  DomainOperationGrantStoreHead: ajv.compile(domainOperationGrantStoreHeadSchema),
  DurableStoreJournalRecord: ajv.compile(durableStoreJournalRecordSchema),
  DurableStoreBackupManifest: ajv.compile(durableStoreBackupManifestSchema),
  DurableStoreCompositionBackupManifest: ajv.compile(
    durableStoreCompositionBackupManifestSchema
  ),
  EngineeringEffectEvidence: ajv.compile(engineeringEffectEvidenceSchema),
  HumanGateEvidence: ajv.compile(humanGateEvidenceSchema),
  ActivationLease: ajv.compile(activationLeaseSchema),
  AuthorityRebind: ajv.compile(authorityRebindSchema),
  KernelSnapshot: ajv.compile(kernelSnapshotSchema),
  TransitionReceipt: ajv.compile(transitionReceiptSchema),
  KernelEvent: ajv.compile(eventEnvelopeSchema),
  MetricRecord: ajv.compile(metricRecordSchema),
  GitHubProjectSchema: ajv.compile(githubProjectSchema),
  GitHubProjectBinding: ajv.compile(githubProjectBindingSchema),
  GitHubProjectAdminSnapshot: ajv.compile(githubProjectAdminSnapshotSchema),
  GitHubProjectDisplaySnapshot: ajv.compile(githubProjectDisplaySnapshotSchema),
  GitHubProjectDisplayTargetManifest: ajv.compile(
    githubProjectDisplayTargetManifestSchema
  ),
  GitHubProjectDisplayColorPlan: ajv.compile(
    githubProjectDisplayColorPlanSchema
  ),
  GitHubProjectDisplayColorReadback: ajv.compile(
    githubProjectDisplayColorReadbackSchema
  ),
  GitHubProjectLive: ajv.compile(githubProjectLiveSchema),
  GitHubSafeOutput: ajv.compile(githubSafeOutputSchema),
  TargetFreePatch: ajv.compile(targetFreePatchSchema),
  TrustedValidatedPatchArtifact: ajv.compile(trustedValidatedPatchArtifactSchema),
  GitHubEffectEvidence: ajv.compile(githubEffectEvidenceSchema),
  GitHubEffectPlan: ajv.compile(githubEffectPlanSchema),
  PackagingDocument: ajv.compile(packagingSchema),
  DeploymentTopologyPlan: ajv.compile(deploymentTopologySchema),
  GitHubAppRegistrationPlan: ajv.compile(githubAppRegistrationPlanSchema),
  GitHubAppInstallationTargetBinding: ajv.compile(githubAppInstallationTargetBindingSchema),
  GitHubAppPermissionReadback: ajv.compile(githubAppPermissionReadbackSchema),
  AdministratorPlan: ajv.compile(administratorPlanSchema),
  AdministratorReadback: ajv.compile(administratorReadbackSchema),
  AdministratorHandoffDocument: ajv.compile(administratorHandoffSchema)
};

type KindValue = {
  readonly LifecycleGraph: LifecycleGraph;
  readonly AuditEvent: AuditEvent;
  readonly BudgetDecisionEvidence: BudgetDecisionEvidence;
  readonly WorkAccord: WorkAccord;
  readonly PhaseContract: PhaseContract;
  readonly CapabilityRegistry: CapabilityRegistry;
  readonly AgentParticipationPolicy: AgentParticipationPolicy;
  readonly DemoCatalog: DemoCatalog;
  readonly DemoIdentityReservationManifest: DemoIdentityReservationManifest;
  readonly DemoProjectProfile: DemoProjectProfile;
  readonly DemoProjectTargetManifest: DemoProjectTargetManifest;
  readonly DemoJourneyDefinition: DemoJourneyDefinition;
  readonly StageAgentBindingSet: StageAgentBindingSet;
  readonly DemoCapabilityRegistryShard: DemoCapabilityRegistryShard;
  readonly DemoActivationProfile: DemoActivationProfile;
  readonly DemoRunState: DemoRunState;
  readonly DemoRunFence: DemoRunFence;
  readonly StageArtifactEnvelope: StageArtifactEnvelope;
  readonly SignedStageReceipt: SignedStageReceipt;
  readonly SignedStageAgentSelectionGrant: SignedStageAgentSelectionGrant;
  readonly DemoProjectionMapping: DemoProjectionMapping;
  readonly DemoDispatchDecision: DemoDispatchDecision;
  readonly DemoScheduleDecision: DemoScheduleDecision;
  readonly DemoRuntimeRefusal: DemoRuntimeRefusal;
  readonly DemoReviewEvidenceBundle: DemoReviewEvidenceBundle;
  readonly CopilotRuntimePolicy: CopilotRuntimePolicy;
  readonly CopilotRuntimeAuthorization: CopilotRuntimeAuthorization;
  readonly CopilotRuntimeState: CopilotRuntimeState;
  readonly CompiledPolicy: CompiledPolicy;
  readonly ContractRequirementEvidence: ContractRequirementEvidence;
  readonly ControlPolicy: ControlPolicy;
  readonly DomainPackPolicy: DomainPackPolicy;
  readonly DomainArtifactPolicyAssessment: DomainArtifactPolicyAssessment;
  readonly DomainOperationGrantClaim: DomainOperationGrantClaim;
  readonly DomainOperationGrantStoreHead: DomainOperationGrantStoreHead;
  readonly DurableStoreJournalRecord: DurableStoreJournalRecord;
  readonly DurableStoreBackupManifest: DurableBackupManifest;
  readonly DurableStoreCompositionBackupManifest: DurableStoreCompositionBackupManifest;
  readonly EngineeringEffectEvidence: EngineeringEffectEvidence;
  readonly HumanGateEvidence: HumanGateEvidence;
  readonly ActivationLease: ActivationLease;
  readonly AuthorityRebind: AuthorityRebind;
  readonly KernelSnapshot: KernelSnapshot;
  readonly TransitionReceipt: TransitionReceipt;
  readonly KernelEvent: EventEnvelope;
  readonly MetricRecord: MetricRecord;
  readonly GitHubProjectSchema: GitHubProjectSchema;
  readonly GitHubProjectBinding: GitHubProjectBinding;
  readonly GitHubProjectAdminSnapshot: LiveDemoProjectAdminSnapshot;
  readonly GitHubProjectDisplaySnapshot: GitHubProjectDisplaySnapshot;
  readonly GitHubProjectDisplayTargetManifest: GitHubProjectDisplayTargetManifest;
  readonly GitHubProjectDisplayColorPlan: GitHubProjectDisplayColorPlan;
  readonly GitHubProjectDisplayColorReadback: GitHubProjectDisplayColorReadback;
  readonly GitHubProjectLive: LiveGitHubProject;
  readonly GitHubSafeOutput: GitHubSafeOutput;
  readonly TargetFreePatch: TargetFreePatch;
  readonly TrustedValidatedPatchArtifact: TrustedValidatedPatchArtifact;
  readonly GitHubEffectEvidence: GitHubEvidenceRecord;
  readonly GitHubEffectPlan: GitHubEffectPlan;
  readonly PackagingDocument: PackagingDocument;
  readonly DeploymentTopologyPlan: DeploymentTopologyPlan;
  readonly GitHubAppRegistrationPlan: GitHubAppRegistrationPlan;
  readonly GitHubAppInstallationTargetBinding: GitHubAppInstallationTargetBinding;
  readonly GitHubAppPermissionReadback: GitHubAppPermissionReadback;
  readonly AdministratorPlan: AdministratorPlan;
  readonly AdministratorReadback: AdministratorReadback;
  readonly AdministratorHandoffDocument: AdministratorHandoffDocument;
};

function formatErrors(errors: readonly ErrorObject[] | null | undefined): readonly string[] {
  return (errors ?? []).map(
    (error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`
  );
}

export function validateDocument<K extends DocumentKind>(
  kind: K,
  value: unknown
): ValidationResult<KindValue[K]> {
  const validator = validators[kind];
  if (!validator(value)) {
    return { valid: false, errors: formatErrors(validator.errors) };
  }
  const validatedValue = immutableDocumentKinds.has(kind)
    ? deepFreeze(structuredClone(value))
    : value;
  return { valid: true, value: validatedValue as KindValue[K] };
}

export function assertDocument<K extends DocumentKind>(
  kind: K,
  value: unknown
): KindValue[K] {
  const result = validateDocument(kind, value);
  if (!result.valid) {
    throw new TypeError(`${kind} validation failed: ${result.errors.join("; ")}`);
  }
  return result.value;
}
