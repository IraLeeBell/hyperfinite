import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

import businessOperationsArtifactSchema from "../schemas/v1alpha1/business-operations-artifact-bundle.schema.json" with { type: "json" };
import domainPackDefinitionSchema from "../schemas/v1alpha1/domain-pack-definition.schema.json" with { type: "json" };
import domainProfileCatalogSchema from "../schemas/v1alpha1/domain-profile-catalog.schema.json" with { type: "json" };
import marketingArtifactSchema from "../schemas/v1alpha1/marketing-artifact-bundle.schema.json" with { type: "json" };
import { canonicalJson, digest } from "./canonical.js";
import {
  domainArtifactSchemaDigest,
  domainArtifactTemplateDigest,
  validateDomainArtifactSchema
} from "./domain-artifact-schemas.js";
import { compilePolicy, type CompiledPolicy } from "./policy.js";
import { resolveCapability } from "./registry.js";
import { validateDocument } from "./validation.js";
import type {
  Capability,
  CapabilityRegistry,
  ControlPolicy,
  Digest,
  DomainPackPolicy,
  PhaseContract,
  WorkAccord
} from "./types.js";

export type DomainPackId = "marketing" | "business-operations";
export type DomainProfileId = "engineering" | DomainPackId;
export type DomainPhase =
  | "framing"
  | "planning"
  | "execution"
  | "verification"
  | "human-review";

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function immutableSnapshot<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

export interface DomainPackDefinition {
  readonly apiVersion: "agentic-framework.github.com/v1alpha1";
  readonly kind: "DomainPackDefinition";
  readonly id: DomainPackId;
  readonly version: "1.0.0";
  readonly displayName: string;
  readonly enabledByDefault: false;
  readonly agent: string;
  readonly skill: string;
  readonly policyRef: string;
  readonly artifactRoot: string;
  readonly artifactSchema: string;
  readonly templateRoot: string;
  readonly capabilityBindings: {
    readonly framing: string;
    readonly execution: string;
    readonly verification: string;
  };
  readonly slots: readonly {
    readonly id: string;
    readonly artifactType: string;
    readonly relativePath: string;
    readonly maxBytes: number;
    readonly mode: 100644;
    readonly schema: string;
    readonly template: string;
    readonly dependsOn: readonly string[];
  }[];
  readonly stages: readonly {
    readonly id: string;
    readonly phase: DomainPhase;
    readonly requiredSlots: readonly string[];
    readonly requiredGates: readonly string[];
  }[];
  readonly humanGates: readonly {
    readonly id: string;
    readonly role: string;
    readonly independent: true;
    readonly signed: true;
    readonly current: true;
    readonly requiredForReadiness: true;
    readonly maxAgeMs: number;
  }[];
  readonly roles: readonly string[];
  readonly incompatibleRolePairs: readonly (readonly [string, string])[];
  readonly access: {
    readonly tools: readonly [];
    readonly shellCommands: readonly [];
    readonly networkDestinations: readonly [];
    readonly mcpTools: readonly [];
    readonly secretNames: readonly [];
    readonly externalAdapters: readonly [];
  };
  readonly riskPrivacy: {
    readonly maximumClassification:
      | "internal"
      | "confidential"
      | "restricted";
    readonly allowedClassifications: readonly (
      | "internal"
      | "confidential"
      | "restricted"
    )[];
    readonly prohibitedData: readonly string[];
    readonly retentionDays: number;
  };
  readonly reviewRubric: readonly string[];
  readonly prohibitedEffects: readonly string[];
  readonly limits: {
    readonly maxTokens: number;
    readonly maxDurationMs: number;
    readonly maxRetries: number;
    readonly maxLoops: 2;
    readonly maxParallel: 1;
    readonly maxRecursionDepth: 0;
    readonly maxFiles: number;
    readonly maxPatchBytes: number;
  };
  readonly maxRevisionLoops: 2;
  readonly maxArtifactBytes: number;
}

export interface DomainProfileCatalog {
  readonly apiVersion: "agentic-framework.github.com/v1alpha1";
  readonly kind: "DomainProfileCatalog";
  readonly profiles: readonly {
    readonly id: DomainProfileId;
    readonly version: "1.0.0";
    readonly enabledByDefault: false;
    readonly policyRef: string;
    readonly definitionRef: string | null;
  }[];
}

export interface TargetFreeDomainOutput {
  readonly summary: string;
  readonly changes: readonly {
    readonly slot: string;
    readonly content: string;
  }[];
  readonly findings: readonly string[];
  readonly openQuestions: readonly string[];
  readonly result: "drafted" | "blocked" | "failed";
  readonly reasonCode:
    | "evidence-insufficient"
    | "sensitive-data"
    | "authority-required"
    | "policy-refusal"
    | null;
}

export interface DomainReviewOutput {
  readonly result: "revise" | "ready";
  readonly findings: readonly string[];
}

export interface DomainDetachedSignature {
  readonly algorithm: "ed25519";
  readonly keyId: string;
  readonly value: string;
}

export interface DomainPolicyContext {
  readonly enterprise: ControlPolicy;
  readonly accord: WorkAccord;
  readonly registry: CapabilityRegistry;
  readonly domainPack: DomainPackPolicy;
  readonly profileCatalog: DomainProfileCatalog;
  readonly phaseContracts: Readonly<Record<DomainPhase, PhaseContract>>;
}

export interface DomainRepositoryIdentity {
  readonly repositoryId: number;
  readonly repositoryNodeId: string;
  readonly repositoryFullName: string;
  readonly repositoryRootId: Digest;
  readonly workItemId: string;
  readonly defaultRef: "refs/heads/main";
  readonly proposalRef: `refs/heads/agentic-domain/${string}`;
}

export interface DomainRepositoryBinding extends DomainRepositoryIdentity {
  readonly baseSha: string;
  readonly headSha: string;
}

export interface DomainCompiledAuthority {
  readonly definitionDigest: Digest;
  readonly profileDigest: Digest;
  readonly enterprisePolicyDigest: Digest;
  readonly workAccordDigest: Digest;
  readonly capabilityRegistryDigest: Digest;
  readonly domainPackPolicyDigest: Digest;
  readonly phaseContractDigests: Readonly<Record<DomainPhase, Digest>>;
  readonly compiledPolicies: Readonly<Record<DomainPhase, CompiledPolicy>>;
  readonly bundleSchemaDigest: Digest;
  readonly artifactSchemaDigests: Readonly<Record<string, Digest>>;
  readonly artifactTemplateDigests: Readonly<Record<string, Digest>>;
  readonly reviewRubricDigest: Digest;
  readonly digest: Digest;
}

export interface DomainAppliedKernelAuthorization {
  readonly purpose: "domain-kernel-authorization";
  readonly result: "applied";
  readonly authorityDigest: Digest;
  readonly compiledPolicyDigests: Readonly<Record<DomainPhase, Digest>>;
  readonly repositoryId: number;
  readonly workItemId: string;
  readonly repositoryIdentityDigest: Digest;
  readonly baseSha: string;
  readonly headSha: string;
  readonly roleBindingSetDigest: Digest;
  readonly sourceEvidenceSetDigest: Digest;
  readonly runId: string;
  readonly runAttempt: number;
  readonly runNonce: string;
  readonly runRedemptionKey: Digest;
  readonly runCasResult: "appended";
  readonly kernelReceiptDigest: Digest;
  readonly kernelResultDigest: Digest;
  readonly leaseDigest: Digest;
  readonly threatAssessmentDigest: Digest;
  readonly threatStatus: "success";
  readonly stateRevoked: false;
  readonly leaseRevoked: false;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly signature: DomainDetachedSignature;
}

export interface DomainUsage {
  readonly tokens: number;
  readonly costUnits: number;
  readonly durationMs: number;
  readonly retries: number;
}

export interface DomainProviderAdmission {
  readonly requestDigest: Digest;
  readonly inputBytes: number;
  readonly inputTokenUpperEstimate: number;
  readonly reservedOutputTokens: number;
  readonly maxOutputBytes: number;
  readonly requestedTokenReservation: number;
  readonly requestedCostReservation: number;
}

export interface DomainProviderUsageReceipt {
  readonly purpose: "domain-provider-usage";
  readonly operation: "model-create" | "model-review";
  readonly authorityDigest: Digest;
  readonly grantDigest: Digest;
  readonly requestDigest: Digest;
  readonly admissionDigest: Digest;
  readonly responseDigest: Digest;
  readonly inputBytes: number;
  readonly outputBytes: number;
  readonly chargedInputTokens: number;
  readonly chargedOutputTokens: number;
  readonly costUnits: number;
  readonly durationMs: number;
  readonly retries: number;
  readonly status: "settled";
  readonly observedAt: string;
  readonly signature: DomainDetachedSignature;
}

export type DomainAuthorizedOperation =
  | "model-create"
  | "model-review"
  | "repository-package"
  | "repository-comment"
  | "repository-merge-observe"
  | "repository-closure";

export interface DomainOperationGrant {
  readonly purpose: "domain-operation";
  readonly authorityDigest: Digest;
  readonly kernelAuthorizationDigest: Digest;
  readonly operation: DomainAuthorizedOperation;
  readonly capability: string | null;
  readonly sequence: number;
  readonly runId: string;
  readonly runAttempt: number;
  readonly contextDigest: Digest;
  readonly nonce: string;
  readonly redemptionKey: Digest;
  readonly casResult: "appended";
  readonly repositoryId: number;
  readonly workItemId: string;
  readonly repositoryIdentityDigest: Digest;
  readonly headSha: string;
  readonly roleBindingSetDigest: Digest;
  readonly sourceEvidenceSetDigest: Digest;
  readonly leaseDigest: Digest;
  readonly threatAssessmentDigest: Digest;
  readonly threatStatus: "success";
  readonly policyCurrent: true;
  readonly headCurrent: true;
  readonly stateRevoked: false;
  readonly leaseRevoked: false;
  readonly reservedTokens: number;
  readonly reservedCostUnits: number;
  readonly cumulativeUsage: DomainUsage & {
    readonly calls: number;
    readonly loops: number;
  };
  readonly checkedAt: string;
  readonly expiresAt: string;
  readonly signature: DomainDetachedSignature;
}

export interface DomainOperationGrantClaim {
  readonly purpose: "domain-operation-grant-claim";
  readonly storeId: string;
  readonly storeSequence: number;
  readonly claimChallenge: Digest;
  readonly casResult: "appended";
  readonly grantDigest: Digest;
  readonly redemptionKey: Digest;
  readonly operation: DomainAuthorizedOperation;
  readonly contextDigest: Digest;
  readonly repositoryIdentityDigest: Digest;
  readonly runId: string;
  readonly runAttempt: number;
  readonly operationSequence: number;
  readonly grantCheckedAt: string;
  readonly claimedAt: string;
  readonly grantExpiresAt: string;
  readonly previousHead: Digest | null;
  readonly head: Digest;
  readonly signature: DomainDetachedSignature;
}

export interface DomainOperationGrantStoreHead {
  readonly purpose: "domain-operation-grant-store-head";
  readonly storeId: string;
  readonly storeSequence: number;
  readonly challenge: Digest;
  readonly head: Digest | null;
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly signature: DomainDetachedSignature;
}

export interface DomainOperationGrantChallengeSource {
  next(): Digest;
}

export interface DomainOperationGrantStore {
  readHead(input: {
    readonly storeId: string;
    readonly challenge: Digest;
  }): Promise<DomainOperationGrantStoreHead>;
  claim(input: {
    readonly storeId: string;
    readonly claimChallenge: Digest;
    readonly expectedPreviousHead: Digest | null;
    readonly expectedStoreSequence: number;
    readonly grantDigest: Digest;
    readonly redemptionKey: Digest;
    readonly operation: DomainAuthorizedOperation;
    readonly contextDigest: Digest;
    readonly repositoryIdentityDigest: Digest;
    readonly runId: string;
    readonly runAttempt: number;
    readonly operationSequence: number;
    readonly grantCheckedAt: string;
    readonly grantExpiresAt: string;
  }): Promise<DomainOperationGrantClaim | null>;
}

export interface DomainOperationRedeemer {
  authorizeKernel(input: {
    readonly authority: DomainCompiledAuthority;
    readonly repositoryId: number;
    readonly workItemId: string;
    readonly repositoryIdentityDigest: Digest;
    readonly baseSha: string;
    readonly headSha: string;
    readonly roleBindingSetDigest: Digest;
    readonly sourceEvidenceSetDigest: Digest;
  }): Promise<DomainAppliedKernelAuthorization>;
  redeem(input: {
    readonly authority: DomainCompiledAuthority;
    readonly kernelAuthorization: DomainAppliedKernelAuthorization;
    readonly operation: DomainAuthorizedOperation;
    readonly capability: string | null;
    readonly sequence: number;
    readonly runId: string;
    readonly runAttempt: number;
    readonly contextDigest: Digest;
    readonly usage: DomainUsage & { readonly calls: number; readonly loops: number };
    readonly requestedTokens: number;
    readonly requestedCostUnits: number;
    readonly repositoryId: number;
    readonly workItemId: string;
    readonly repositoryIdentityDigest: Digest;
    readonly headSha: string;
  }): Promise<DomainOperationGrant>;
}

export interface DomainRoleBinding {
  readonly purpose: "domain-role-binding";
  readonly packId: DomainPackId;
  readonly role: string;
  readonly actorId: number;
  readonly actorLogin: string;
  readonly actorType: "User" | "App";
  readonly repositoryPermission: "write" | "maintain" | "admin";
  readonly teamIds: readonly string[];
  readonly authorityDigest: Digest;
  readonly workAccordDigest: Digest;
  readonly repositoryId: number;
  readonly workItemId: string;
  readonly repositoryIdentityDigest: Digest;
  readonly headSha: string;
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly signature: DomainDetachedSignature;
}

export interface DomainSourceEvidence {
  readonly purpose: "domain-source-evidence";
  readonly sourceDigest: Digest;
  readonly content: string;
  readonly contentDigest: Digest;
  readonly classification: "internal" | "confidential";
  readonly locator: string;
  readonly rightsBasis: "original" | "approved-license" | "internal-authorized";
  readonly retentionDays: number;
  readonly authorityDigest: Digest;
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly signature: DomainDetachedSignature;
}

export interface DomainDlpEvidence {
  readonly purpose: "domain-dlp";
  readonly stage: "pre-model" | "pre-comment" | "pre-package";
  readonly authorityDigest: Digest;
  readonly inputDigest: Digest;
  readonly artifactSetDigest: Digest | null;
  readonly sourceDigests: readonly Digest[];
  readonly status: "success" | "restricted" | "unknown" | "unavailable";
  readonly findings: readonly string[];
  readonly checkedAt: string;
  readonly expiresAt: string;
  readonly signature: DomainDetachedSignature;
}

export interface DomainDlpService {
  classify(input: {
    readonly stage: DomainDlpEvidence["stage"];
    readonly authorityDigest: Digest;
    readonly artifactSetDigest: Digest | null;
    readonly sourceDigests: readonly Digest[];
    readonly values: unknown;
  }): Promise<DomainDlpEvidence>;
}

export interface DomainPromptThreatAssessment {
  readonly purpose: "domain-review-threat-assessment";
  readonly authorityDigest: Digest;
  readonly reviewPayloadDigest: Digest;
  readonly artifactBundleDigest: Digest;
  readonly status: "success" | "warning" | "unknown" | "unavailable";
  readonly findings: readonly string[];
  readonly assessor: "trusted-independent-service";
  readonly reviewerSelfAttested: false;
  readonly checkedAt: string;
  readonly expiresAt: string;
  readonly signature: DomainDetachedSignature;
}

export interface DomainPromptThreatService {
  assess(input: {
    readonly authorityDigest: Digest;
    readonly reviewPayloadDigest: Digest;
    readonly artifactBundleDigest: Digest;
    readonly values: unknown;
  }): Promise<DomainPromptThreatAssessment>;
}

export interface DomainArtifactPolicyAssessment {
  readonly purpose: "domain-artifact-policy-assessment";
  readonly packId: DomainPackId;
  readonly authorityDigest: Digest;
  readonly artifactSetDigest: Digest;
  readonly inputDigest: Digest;
  readonly prohibitedEffectsDigest: Digest;
  readonly status: "success" | "violation" | "unknown" | "unavailable";
  readonly findings: readonly string[];
  readonly assessor: "trusted-independent-service";
  readonly modelSelfAttested: false;
  readonly checkedAt: string;
  readonly expiresAt: string;
  readonly signature: DomainDetachedSignature;
}

export interface DomainArtifactPolicyService {
  assess(input: {
    readonly packId: DomainPackId;
    readonly authorityDigest: Digest;
    readonly artifactSetDigest: Digest;
    readonly prohibitedEffects: readonly string[];
    readonly values: unknown;
  }): Promise<DomainArtifactPolicyAssessment>;
}

export interface DomainClaimRequest {
  readonly claimId: string;
  readonly slot: string;
  readonly claim: string;
  readonly claimType: string;
  readonly claimDigest: Digest;
  readonly evidenceDigests: readonly Digest[];
}

export interface DomainRightsRequest {
  readonly rightsId: string;
  readonly slot: string;
  readonly assetId: string;
  readonly assetDigest: Digest;
}

export interface DomainClaimEvidence {
  readonly purpose: "domain-claim-evidence";
  readonly authorityDigest: Digest;
  readonly artifactSetDigest: Digest;
  readonly claimId: string;
  readonly slot: string;
  readonly claimDigest: Digest;
  readonly claimType: string;
  readonly evidenceDigests: readonly Digest[];
  readonly authorized: true;
  readonly revoked: false;
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly signature: DomainDetachedSignature;
}

export interface DomainRightsEvidence {
  readonly purpose: "domain-rights-evidence";
  readonly authorityDigest: Digest;
  readonly artifactSetDigest: Digest;
  readonly rightsId: string;
  readonly slot: string;
  readonly assetId: string;
  readonly assetDigest: Digest;
  readonly license: "original" | "approved-license";
  readonly territories: readonly ["internal-repository"];
  readonly channels: readonly ["repository-pr"];
  readonly trademarkStatus: "none" | "human-reviewed";
  readonly revoked: false;
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly signature: DomainDetachedSignature;
}

export interface DomainClaimsRightsAuthorityEvidence {
  readonly purpose: "domain-claims-rights-authority";
  readonly authorityDigest: Digest;
  readonly artifactSetDigest: Digest;
  readonly revision: number;
  readonly authorityHeadDigest: Digest;
  readonly claimEvidenceSetDigest: Digest;
  readonly rightsEvidenceSetDigest: Digest;
  readonly revoked: false;
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly signature: DomainDetachedSignature;
}

export interface DomainClaimsRightsResolver {
  resolve(input: {
    readonly authorityDigest: Digest;
    readonly artifactSetDigest: Digest;
    readonly claims: readonly DomainClaimRequest[];
    readonly rights: readonly DomainRightsRequest[];
  }): Promise<{
    readonly claims: readonly DomainClaimEvidence[];
    readonly rights: readonly DomainRightsEvidence[];
    readonly authority: DomainClaimsRightsAuthorityEvidence;
  }>;
}

export interface DomainClaimsRightsAuthorityGuard {
  readonly purpose: "domain-claims-rights-authority-guard";
  readonly operation: "repository-package" | "repository-closure";
  readonly authorityDigest: Digest;
  readonly artifactSetDigest: Digest;
  readonly repositoryIdentityDigest: Digest;
  readonly grantContextDigest: Digest;
  readonly authorizationDigest?: Digest;
  readonly authorizationSignatureDigest?: Digest;
  readonly authorizationNonce?: string;
  readonly authorizationRunId?: string;
  readonly authorizationRunAttempt?: number;
  readonly authorizationExpiresAt?: string;
  readonly revision: number;
  readonly authorityHeadDigest: Digest;
  readonly claimEvidenceSetDigest: Digest;
  readonly rightsEvidenceSetDigest: Digest;
  readonly checkedAt: string;
  readonly signature: DomainDetachedSignature;
}

export interface DomainClaimsRightsAuthorityCas {
  withCurrent<T>(input: {
    readonly operation: "repository-package" | "repository-closure";
    readonly authorityEvidence: DomainClaimsRightsAuthorityEvidence;
    readonly repositoryIdentityDigest: Digest;
    readonly grantContextDigest: Digest;
    readonly authorization?: DomainOperationGrant;
    readonly effect: (
      guard: DomainClaimsRightsAuthorityGuard
    ) => Promise<T>;
  }): Promise<T>;
}

export interface DomainHumanWaitCheckpoint {
  readonly purpose: "domain-human-wait";
  readonly authorityDigest: Digest;
  readonly kernelAuthorizationDigest: Digest;
  readonly repositoryIdentityDigest: Digest;
  readonly packageDigest: Digest;
  readonly artifactSetDigest: Digest;
  readonly commentReviewReceiptDigest: Digest;
  readonly claimEvidenceDigest: Digest;
  readonly rightsEvidenceDigest: Digest;
  readonly claimsRightsAuthorityDigest: Digest;
  readonly claimsRightsAuthorityRevision: number;
  readonly claimsRightsAuthorityHeadDigest: Digest;
  readonly claimsRightsExpiresAt: string;
  readonly headSha: string;
  readonly recordedAt: string;
  readonly signature: DomainDetachedSignature;
}

export interface DomainActorAuthorization {
  readonly purpose: `domain-actor-authorization:${string}`;
  readonly actorId: number;
  readonly actorType: "User";
  readonly actorRole: string;
  readonly repositoryPermission: "write" | "maintain" | "admin";
  readonly teamIds: readonly string[];
  readonly roleBindingDigest: Digest;
  readonly authorityDigest: Digest;
  readonly workAccordDigest: Digest;
  readonly artifactSetDigest: Digest;
  readonly packageDigest: Digest;
  readonly commentReviewReceiptDigest: Digest;
  readonly humanWaitCheckpointDigest: Digest;
  readonly claimEvidenceDigest: Digest;
  readonly rightsEvidenceDigest: Digest;
  readonly claimsRightsAuthorityDigest: Digest;
  readonly claimsRightsAuthorityRevision: number;
  readonly claimsRightsAuthorityHeadDigest: Digest;
  readonly claimsRightsExpiresAt: string;
  readonly repositoryId: number;
  readonly workItemId: string;
  readonly repositoryIdentityDigest: Digest;
  readonly headSha: string;
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly signature: DomainDetachedSignature;
}

export interface DomainHumanApproval {
  readonly purpose: `domain-approval:${string}`;
  readonly gate: string;
  readonly role: string;
  readonly approverId: number;
  readonly approverType: "User";
  readonly requesterId: number;
  readonly automationActorId: number;
  readonly packId: DomainPackId;
  readonly repositoryId: number;
  readonly workItemId: string;
  readonly repositoryIdentityDigest: Digest;
  readonly baseSha: string;
  readonly headSha: string;
  readonly artifactSetDigest: Digest;
  readonly packageDigest: Digest;
  readonly commentReviewReceiptDigest: Digest;
  readonly humanWaitCheckpointDigest: Digest;
  readonly claimEvidenceDigest: Digest;
  readonly rightsEvidenceDigest: Digest;
  readonly claimsRightsAuthorityDigest: Digest;
  readonly claimsRightsAuthorityRevision: number;
  readonly claimsRightsAuthorityHeadDigest: Digest;
  readonly claimsRightsExpiresAt: string;
  readonly actorAuthorization: DomainActorAuthorization;
  readonly actorAuthorizationDigest: Digest;
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly signature: DomainDetachedSignature;
}

export interface DomainHumanMergeObservation {
  readonly purpose: "domain-merge-observation";
  readonly packId: DomainPackId;
  readonly repositoryId: number;
  readonly workItemId: string;
  readonly repositoryIdentityDigest: Digest;
  readonly packageId: string;
  readonly headSha: string;
  readonly artifactSetDigest: Digest;
  readonly approvalEvidenceDigests: readonly Digest[];
  readonly claimEvidenceDigest: Digest;
  readonly rightsEvidenceDigest: Digest;
  readonly claimsRightsAuthorityDigest: Digest;
  readonly claimsRightsAuthorityRevision: number;
  readonly claimsRightsAuthorityHeadDigest: Digest;
  readonly claimsRightsExpiresAt: string;
  readonly authorizationDigest: Digest;
  readonly mergedSha: string;
  readonly mergerId: number;
  readonly mergerType: "User";
  readonly mergerRoleBindingDigest: Digest;
  readonly mergerAuthorization: DomainActorAuthorization;
  readonly mergerAuthorizationDigest: Digest;
  readonly observedAt: string;
  readonly proposalOnly: true;
  readonly externalEffectsPerformed: false;
  readonly signature: DomainDetachedSignature;
}

export interface DomainArtifact {
  readonly artifactType: string;
  readonly slot: string;
  readonly path: string;
  readonly mode: 100644;
  readonly schemaDigest: Digest;
  readonly templateDigest: Digest;
  readonly upstreamArtifactDigests: readonly Digest[];
  readonly content: string;
  readonly contentDigest: Digest;
}

export interface DomainArtifactBundle {
  readonly apiVersion: "agentic-framework.github.com/v1alpha1";
  readonly kind:
    | "MarketingArtifactBundle"
    | "BusinessOperationsArtifactBundle";
  readonly packId: DomainPackId;
  readonly repositoryId: number;
  readonly workItemId: string;
  readonly repositoryIdentityDigest: Digest;
  readonly baseSha: string;
  readonly headSha: string;
  readonly classification: "internal" | "confidential" | "restricted";
  readonly authorityDigest: Digest;
  readonly approvedSourceDigests: readonly Digest[];
  readonly artifactSetDigest: Digest;
  readonly executionEvidenceDigests: readonly Digest[];
  readonly artifacts: readonly DomainArtifact[];
  readonly approvalEvidenceDigests: readonly Digest[];
  readonly readiness: {
    readonly status: "proposal-artifacts-merged";
    readonly externalEffectsPerformed: false;
    readonly publicationPerformed: false;
    readonly productionMutationPerformed: false;
  };
}

export interface DomainPackClock {
  now(): string;
}

export interface DomainEvidenceVerifier {
  verify(
    payload: unknown,
    signature: DomainDetachedSignature,
    purpose: string
  ): boolean;
}

export interface DomainEvidenceSigner {
  sign(payload: unknown, purpose: string): DomainDetachedSignature;
}

export interface DomainEvidenceLedger {
  append(entry: {
    readonly type:
      | "kernel-authorized"
      | "operation-redeemed"
      | "model-usage-unavailable"
      | "dlp-validated"
      | "claims-rights-validated"
      | "draft-reviewed"
      | "revision-reviewed"
      | "draft-pr-packaged"
      | "comment-review-recorded"
      | "human-wait-recorded"
      | "approvals-validated"
      | "merge-observed"
      | "repository-closure-recorded";
    readonly packId: DomainPackId;
    readonly subjectDigest: Digest;
    readonly observedAt: string;
  }): Promise<void>;
  appendClosure(input: {
    readonly packId: DomainPackId;
    readonly authorization: DomainOperationGrant;
    readonly authorityGuard: DomainClaimsRightsAuthorityGuard;
    readonly authorityDigest: Digest;
    readonly repositoryIdentity: DomainRepositoryIdentity;
    readonly headSha: string;
    readonly mergeObservationDigest: Digest;
    readonly mergeObservedAt: string;
    readonly packageDigest: Digest;
    readonly artifactSetDigest: Digest;
    readonly approvalEvidenceDigests: readonly Digest[];
    readonly claimEvidenceDigest: Digest;
    readonly rightsEvidenceDigest: Digest;
    readonly claimsRightsAuthorityDigest: Digest;
    readonly claimsRightsAuthorityRevision: number;
    readonly claimsRightsAuthorityHeadDigest: Digest;
    readonly claimsRightsExpiresAt: string;
    readonly evidenceSetDigest: Digest;
    readonly evidenceExpiresAt: string;
    readonly subjectDigest: Digest;
  }): Promise<{
    readonly purpose: "domain-closure-receipt";
    readonly authorizationDigest: Digest;
    readonly authorityGuardDigest: Digest;
    readonly authorityDigest: Digest;
    readonly repositoryIdentityDigest: Digest;
    readonly headSha: string;
    readonly mergeObservationDigest: Digest;
    readonly evidenceSetDigest: Digest;
    readonly subjectDigest: Digest;
    readonly casResult: "appended";
    readonly checkedAt: string;
    readonly signature: DomainDetachedSignature;
  }>;
}

export interface DomainPackModel {
  create(input: {
    readonly authorization: DomainOperationGrant;
    readonly repositoryIdentity: DomainRepositoryIdentity;
    readonly signal: AbortSignal;
    readonly admission: DomainProviderAdmission;
    readonly payload: {
      readonly evidence: readonly string[];
      readonly targetSlots: readonly string[];
      readonly maxPatchBytes: number;
      readonly revision: number;
      readonly priorOutputDigest: Digest;
      readonly priorChanges: readonly {
        readonly slot: string;
        readonly content: string;
      }[];
      readonly reviewFindings: readonly string[];
    };
  }): Promise<{
    readonly output: TargetFreeDomainOutput;
    readonly usageReceipt: DomainProviderUsageReceipt;
  }>;
}

export interface DomainPackReviewer {
  review(input: {
    readonly authorization: DomainOperationGrant;
    readonly repositoryIdentity: DomainRepositoryIdentity;
    readonly signal: AbortSignal;
    readonly admission: DomainProviderAdmission;
    readonly threatAssessment: DomainPromptThreatAssessment;
    readonly payload: {
      readonly evidence: readonly string[];
      readonly targetSlots: readonly string[];
      readonly maxPatchBytes: number;
      readonly artifactContents: readonly {
        readonly slot: string;
        readonly content: string;
      }[];
    };
  }): Promise<{
    readonly output: {
      readonly summary: string;
      readonly findings: readonly string[];
      readonly openQuestions: readonly string[];
    };
    readonly usageReceipt: DomainProviderUsageReceipt;
  }>;
}

export interface DomainHumanGateProvider {
  wait(input: {
    readonly authorityDigest: Digest;
    readonly kernelAuthorizationDigest: Digest;
    readonly repositoryIdentityDigest: Digest;
    readonly packageDigest: Digest;
    readonly artifactSetDigest: Digest;
    readonly commentReviewReceiptDigest: Digest;
    readonly claimEvidenceDigest: Digest;
    readonly rightsEvidenceDigest: Digest;
    readonly claimsRightsAuthorityDigest: Digest;
    readonly claimsRightsAuthorityRevision: number;
    readonly claimsRightsAuthorityHeadDigest: Digest;
    readonly claimsRightsExpiresAt: string;
    readonly headSha: string;
  }): Promise<DomainHumanWaitCheckpoint>;
  collect(input: {
    readonly definition: DomainPackDefinition;
    readonly repositoryId: number;
    readonly workItemId: string;
    readonly repositoryIdentityDigest: Digest;
    readonly baseSha: string;
    readonly headSha: string;
    readonly requesterId: number;
    readonly automationActorId: number;
    readonly authorityDigest: Digest;
    readonly workAccordDigest: Digest;
    readonly artifactSetDigest: Digest;
    readonly packageDigest: Digest;
    readonly commentReviewReceiptDigest: Digest;
    readonly claimEvidenceDigest: Digest;
    readonly rightsEvidenceDigest: Digest;
    readonly claimsRightsAuthorityDigest: Digest;
    readonly claimsRightsAuthorityRevision: number;
    readonly claimsRightsAuthorityHeadDigest: Digest;
    readonly claimsRightsExpiresAt: string;
    readonly humanWaitCheckpointDigest: Digest;
  }): Promise<readonly DomainHumanApproval[]>;
}

export interface DomainGitHubPackager {
  readCurrentBinding(
    input: DomainRepositoryIdentity
  ): Promise<DomainRepositoryBinding>;
  packageDraftPullRequest(input: {
    readonly repositoryId: number;
    readonly workItemId: string;
    readonly repositoryIdentity: DomainRepositoryIdentity;
    readonly expectedBaseSha: string;
    readonly expectedHeadSha: string;
    readonly title: string;
    readonly authorityBindings: {
      readonly definitionDigest: Digest;
      readonly profileDigest: Digest;
      readonly enterprisePolicyDigest: Digest;
      readonly workAccordDigest: Digest;
      readonly capabilityRegistryDigest: Digest;
      readonly domainPackPolicyDigest: Digest;
      readonly phaseContractDigests: Readonly<Record<DomainPhase, Digest>>;
      readonly compiledPolicyDigests: Readonly<Record<DomainPhase, Digest>>;
      readonly bundleSchemaDigest: Digest;
      readonly artifactSchemaDigests: Readonly<Record<string, Digest>>;
      readonly artifactTemplateDigests: Readonly<Record<string, Digest>>;
      readonly reviewRubricDigest: Digest;
      readonly authorityDigest: Digest;
    };
    readonly artifactSetDigest: Digest;
    readonly maxPatchBytes: number;
    readonly authorization: DomainOperationGrant;
    readonly authorityGuard: DomainClaimsRightsAuthorityGuard;
    readonly evidenceDigest: Digest;
    readonly evidenceExpiresAt: string;
    readonly files: readonly DomainArtifact[];
    readonly draft: true;
  }): Promise<{
    readonly purpose: "domain-package-receipt";
    readonly packageId: string;
    readonly repositoryIdentity: DomainRepositoryIdentity;
    readonly headSha: string;
    readonly parentSha: string;
    readonly baseSha: string;
    readonly proposalRef: `refs/heads/agentic-domain/${string}`;
    readonly treeSha: string;
    readonly patchDigest: Digest;
    readonly artifactSetDigest: Digest;
    readonly patchBytes: number;
    readonly authorizationDigest: Digest;
    readonly operationGrantClaimDigest: Digest;
    readonly authorityGuardDigest: Digest;
    readonly authorityRevision: number;
    readonly evidenceDigest: Digest;
    readonly draft: true;
    readonly externalEffectsPerformed: false;
    readonly observedAt: string;
    readonly signature: DomainDetachedSignature;
  }>;
  recordCommentReview(input: {
    readonly packageId: string;
    readonly repositoryIdentity: DomainRepositoryIdentity;
    readonly expectedHeadSha: string;
    readonly artifactSetDigest: Digest;
    readonly reviewHistory: readonly DomainReviewOutput[];
    readonly reviewDlpEvidenceDigest: Digest;
    readonly threatAssessmentDigest: Digest;
    readonly artifactPolicyAssessmentDigest: Digest;
    readonly evidenceExpiresAt: string;
    readonly authorization: DomainOperationGrant;
  }): Promise<{
    readonly purpose: "domain-comment-receipt";
    readonly event: "COMMENT";
    readonly repositoryIdentityDigest: Digest;
    readonly headSha: string;
    readonly artifactSetDigest: Digest;
    readonly receiptDigest: Digest;
    readonly authorizationDigest: Digest;
    readonly externalEffectsPerformed: false;
    readonly observedAt: string;
    readonly signature: DomainDetachedSignature;
  }>;
  observeHumanMerge(input: {
    readonly packId: DomainPackId;
    readonly repositoryId: number;
    readonly workItemId: string;
    readonly repositoryIdentity: DomainRepositoryIdentity;
    readonly packageId: string;
    readonly expectedHeadSha: string;
    readonly artifactSetDigest: Digest;
    readonly approvalEvidenceDigests: readonly Digest[];
    readonly claimEvidenceDigest: Digest;
    readonly rightsEvidenceDigest: Digest;
    readonly claimsRightsAuthorityDigest: Digest;
    readonly claimsRightsAuthorityRevision: number;
    readonly claimsRightsAuthorityHeadDigest: Digest;
    readonly claimsRightsExpiresAt: string;
    readonly authorityDigest: Digest;
    readonly workAccordDigest: Digest;
    readonly packageDigest: Digest;
    readonly commentReviewReceiptDigest: Digest;
    readonly humanWaitCheckpointDigest: Digest;
    readonly mergerRoleBinding: DomainRoleBinding;
    readonly authorization: DomainOperationGrant;
  }): Promise<DomainHumanMergeObservation>;
}

export interface DomainPackDemonstrationResult {
  readonly bundle: DomainArtifactBundle;
  readonly reviewHistory: readonly DomainReviewOutput[];
  readonly revisionCount: number;
  readonly packageId: string;
  readonly mergedSha: string;
  readonly closureStatus: "proposal-artifacts-merged";
}

interface PackInvariant {
  readonly definitionDigest: Digest;
  readonly profileDigest: Digest;
  readonly artifactRoot: string;
  readonly artifactSchema: string;
  readonly agent: string;
  readonly skill: string;
  readonly capabilities: DomainPackDefinition["capabilityBindings"];
  readonly capabilityRegistryDigest: Digest;
  readonly slots: readonly {
    readonly id: string;
    readonly artifactType: string;
    readonly relativePath: string;
    readonly maxBytes: number;
    readonly dependsOn: readonly string[];
  }[];
  readonly stages: readonly string[];
  readonly gates: Readonly<Record<string, string>>;
  readonly roles: readonly string[];
  readonly incompatibleRolePairs: readonly (readonly [string, string])[];
  readonly prohibitedEffects: readonly string[];
}

const COMMON_PROHIBITED_EFFECTS = [
  "approve",
  "merge",
  "deploy",
  "publish",
  "external-publication",
  "production-mutation",
  "crm-mutation",
  "erp-mutation",
  "payment",
  "license-change",
  "visibility-change"
] as const;

function allDistinctRolePairs(
  roles: readonly string[]
): readonly (readonly [string, string])[] {
  return roles.flatMap((left, index) =>
    roles.slice(index + 1).map((right) => [left, right] as const)
  );
}

const PACK_INVARIANTS: Readonly<Record<DomainPackId, PackInvariant>> = {
  marketing: {
    definitionDigest:
      "sha256:85cbb76d3169288604f31b017b336c080bdb585995ab274f31a5f36bca776462",
    profileDigest:
      "sha256:d99944e824a86d46940d2bb23e723d41f3e35574296c43c0afe0808f4a3e0d0d",
    artifactRoot: "examples/marketing/workspace",
    artifactSchema:
      "schemas/v1alpha1/marketing-artifact-bundle.schema.json",
    agent: ".github/agents/marketing-pack.agent.md",
    skill: "marketing-repository-pack",
    capabilities: {
      framing: "marketing.frame-initiative@1.0.0",
      execution: "marketing.create-repository-artifacts@1.0.0",
      verification: "marketing.review-repository-artifacts@1.0.0"
    },
    capabilityRegistryDigest:
      "sha256:acb1d33037998590786d2934625eeb069df8e0429fc5949523791146f9da7427",
    slots: [
      { id: "initiative-intake", artifactType: "initiative-intake", relativePath: "initiative-intake.json", maxBytes: 12288, dependsOn: [] },
      { id: "audience-evidence", artifactType: "audience-evidence", relativePath: "audience-evidence.json", maxBytes: 24576, dependsOn: ["initiative-intake"] },
      { id: "positioning-messaging", artifactType: "positioning-messaging", relativePath: "positioning-messaging.json", maxBytes: 24576, dependsOn: ["audience-evidence"] },
      { id: "content-plan", artifactType: "content-plan", relativePath: "content-plan.json", maxBytes: 24576, dependsOn: ["positioning-messaging"] },
      { id: "content-drafts", artifactType: "content-drafts", relativePath: "content-drafts.json", maxBytes: 81920, dependsOn: ["content-plan"] },
      { id: "measurement-plan", artifactType: "measurement-plan", relativePath: "measurement-plan.json", maxBytes: 20480, dependsOn: ["content-plan"] },
      { id: "brand-legal-assessment", artifactType: "brand-legal-assessment", relativePath: "brand-legal-assessment.json", maxBytes: 20480, dependsOn: ["content-drafts"] },
      { id: "launch-readiness-assessment", artifactType: "launch-readiness-assessment", relativePath: "launch-readiness-assessment.json", maxBytes: 12288, dependsOn: ["brand-legal-assessment", "measurement-plan"] }
    ],
    stages: [
      "initiative-intake",
      "audience-evidence",
      "positioning-messaging",
      "content-plan",
      "content-drafts",
      "measurement-plan",
      "brand-legal-assessment",
      "launch-readiness-assessment"
    ],
    gates: {
      "brand-review": "brand-reviewer",
      "legal-review": "legal-reviewer"
    },
    roles: [
      "requester",
      "activator",
      "content-author",
      "brand-reviewer",
      "legal-reviewer",
      "reviewer",
      "merger"
    ],
    incompatibleRolePairs: [
      ["requester", "brand-reviewer"],
      ["requester", "legal-reviewer"],
      ["content-author", "brand-reviewer"],
      ["content-author", "legal-reviewer"],
      ["brand-reviewer", "legal-reviewer"],
      ["reviewer", "merger"]
    ],
    prohibitedEffects: [
      ...COMMON_PROHIBITED_EFFECTS,
      "cms-mutation",
      "email-send",
      "social-post",
      "ads-mutation",
      "customer-communication"
    ]
  },
  "business-operations": {
    definitionDigest:
      "sha256:c34d61d12aaf295035347f4e1e8d11cabc2e79e68d9ddb3aadf80883f968847a",
    profileDigest:
      "sha256:23e25141db2618ff33cc11b0bb5caeae5e5221ee70bbbf0cf4c5fef9cdf31ae4",
    artifactRoot: "examples/business-operations/workspace/artifacts",
    artifactSchema:
      "schemas/v1alpha1/business-operations-artifact-bundle.schema.json",
    agent: ".github/agents/business-operations-pack.agent.md",
    skill: "business-operations-repository-pack",
    capabilities: {
      framing: "business-operations.frame-problem@1.0.0",
      execution: "business-operations.create-repository-artifacts@1.0.0",
      verification: "business-operations.review-repository-artifacts@1.0.0"
    },
    capabilityRegistryDigest:
      "sha256:acb1d33037998590786d2934625eeb069df8e0429fc5949523791146f9da7427",
    slots: [
      { id: "problem-framing", artifactType: "problem-framing", relativePath: "problem-framing.json", maxBytes: 24576, dependsOn: [] },
      { id: "stakeholder-analysis", artifactType: "stakeholder-analysis", relativePath: "stakeholder-analysis.json", maxBytes: 24576, dependsOn: ["problem-framing"] },
      { id: "process-map", artifactType: "process-map", relativePath: "process-map.json", maxBytes: 32768, dependsOn: ["stakeholder-analysis"] },
      { id: "decision-memo", artifactType: "decision-memo", relativePath: "decision-memo.json", maxBytes: 32768, dependsOn: ["process-map"] },
      { id: "policy-process-design", artifactType: "policy-process-design", relativePath: "policy-process-design.json", maxBytes: 32768, dependsOn: ["decision-memo"] },
      { id: "implementation-plan", artifactType: "implementation-plan", relativePath: "implementation-plan.json", maxBytes: 32768, dependsOn: ["policy-process-design"] },
      { id: "runbook", artifactType: "runbook", relativePath: "runbook.json", maxBytes: 32768, dependsOn: ["implementation-plan"] },
      { id: "controls-approvals", artifactType: "controls-approvals", relativePath: "controls-approvals.json", maxBytes: 24576, dependsOn: ["runbook"] },
      { id: "outcome-measurement", artifactType: "outcome-measurement", relativePath: "outcome-measurement.json", maxBytes: 24576, dependsOn: ["controls-approvals"] }
    ],
    stages: [
      "problem-framing",
      "stakeholder-analysis",
      "process-map",
      "decision-memo",
      "policy-process-design",
      "implementation-plan",
      "runbook",
      "controls-approvals",
      "outcome-measurement"
    ],
    gates: {
      "process-owner-review": "process-owner",
      "control-owner-review": "control-owner",
      "policy-authority-review": "policy-authority",
      "measurement-owner-review": "measurement-owner"
    },
    roles: [
      "requester",
      "activator",
      "proposer",
      "process-owner",
      "control-owner",
      "policy-authority",
      "implementer",
      "measurement-owner",
      "verifier",
      "reviewer",
      "merger"
    ],
    incompatibleRolePairs: allDistinctRolePairs([
      "requester",
      "activator",
      "proposer",
      "process-owner",
      "control-owner",
      "policy-authority",
      "implementer",
      "measurement-owner",
      "verifier",
      "reviewer",
      "merger"
    ]),
    prohibitedEffects: [
      ...COMMON_PROHIBITED_EFFECTS,
      "ticketing-mutation",
      "procurement-mutation",
      "production-operation",
      "workflow-enablement"
    ]
  }
};

const trustedDefinitionSchema = immutableSnapshot(domainPackDefinitionSchema);
const trustedProfileCatalogSchema = immutableSnapshot(domainProfileCatalogSchema);
const trustedMarketingArtifactSchema = immutableSnapshot(marketingArtifactSchema);
const trustedBusinessOperationsArtifactSchema = immutableSnapshot(
  businessOperationsArtifactSchema
);
const ajv = new Ajv2020({ allErrors: true, strict: true });
const definitionValidator = ajv.compile(
  trustedDefinitionSchema
) as ValidateFunction<DomainPackDefinition>;
const profileCatalogValidator = ajv.compile(
  trustedProfileCatalogSchema
) as ValidateFunction<DomainProfileCatalog>;
const artifactValidators: Readonly<
  Record<DomainPackId, ValidateFunction<DomainArtifactBundle>>
> = {
  marketing: ajv.compile(
    trustedMarketingArtifactSchema
  ) as ValidateFunction<DomainArtifactBundle>,
  "business-operations": ajv.compile(
    trustedBusinessOperationsArtifactSchema
  ) as ValidateFunction<DomainArtifactBundle>
};

export class DomainPackError extends Error {
  constructor(
    readonly code:
      | "DEFINITION_INVALID"
      | "GRANT_INVALID"
      | "MODEL_OUTPUT_INVALID"
      | "REVIEW_INVALID"
      | "APPROVAL_INVALID"
      | "HEAD_STALE"
      | "PACKAGE_AMBIGUOUS"
      | "PACKAGE_INVALID",
    message: string
  ) {
    super(message);
    this.name = "DomainPackError";
  }

}

function fail(code: DomainPackError["code"], message: string): never {
  throw new DomainPackError(code, message);
}

export function domainOperationRequestDigest(
  operation: DomainAuthorizedOperation,
  request: unknown
): Digest {
  return digest({ operation, request });
}

export function validateDomainOperationRequest(
  authorization: DomainOperationGrant,
  operation: DomainAuthorizedOperation,
  request: unknown
): void {
  if (
    authorization.operation !== operation ||
    authorization.contextDigest !== domainOperationRequestDigest(operation, request)
  ) {
    fail("GRANT_INVALID", `${operation} authorization does not bind its exact request`);
  }
}

async function invokeWithDeadline<T>(
  timeoutMs: number,
  invoke: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new DomainPackError("GRANT_INVALID", "model invocation exceeded its deadline"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([invoke(controller.signal), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function selectDomainProfile(
  catalog: unknown,
  trustedProfileId: DomainProfileId
): DomainProfileCatalog["profiles"][number] {
  const snapshot = immutableSnapshot(catalog);
  if (!profileCatalogValidator(snapshot)) {
    fail(
      "DEFINITION_INVALID",
      ajv.errorsText(profileCatalogValidator.errors, { separator: "; " })
    );
  }
  const expectedProfileIds: readonly DomainProfileId[] = [
    "engineering",
    "marketing",
    "business-operations"
  ];
  const profileIds = snapshot.profiles.map((candidate) => candidate.id);
  if (
    profileIds.length !== expectedProfileIds.length ||
    profileIds.some((id, index) => id !== expectedProfileIds[index]) ||
    new Set(profileIds).size !== expectedProfileIds.length
  ) {
    fail(
      "DEFINITION_INVALID",
      "trusted profile catalog must contain each supported profile exactly once in canonical order"
    );
  }
  const profiles = snapshot.profiles.filter(
    (candidate) => candidate.id === trustedProfileId
  );
  const profile = profiles[0];
  if (profiles.length !== 1 || profile === undefined) {
    fail("DEFINITION_INVALID", `unknown trusted domain profile ${trustedProfileId}`);
  }
  return deepFreeze(profile);
}

const DOMAIN_PHASES = [
  "framing",
  "planning",
  "execution",
  "verification",
  "human-review"
] as const satisfies readonly DomainPhase[];

function equalStringSets(left: readonly string[], right: readonly string[]): boolean {
  return (
    new Set(left).size === left.length &&
    new Set(right).size === right.length &&
    equalStrings([...left].sort(), [...right].sort())
  );
}

export function compileDomainRuntimeAuthority(input: {
  readonly definition: DomainPackDefinition;
  readonly policyContext: DomainPolicyContext;
}): DomainCompiledAuthority {
  const definition = validateDomainPackDefinition(input.definition);
  const policyContext = immutableSnapshot(input.policyContext);
  const invariant = PACK_INVARIANTS[definition.id];
  const profile = selectDomainProfile(
    policyContext.profileCatalog,
    definition.id
  );
  if (
    digest(profile) !== invariant.profileDigest ||
    profile.definitionRef !==
      `config/v1alpha1/domain-packs/${definition.id}/definition.json` ||
    profile.policyRef !== definition.policyRef ||
    policyContext.domainPack.id !== definition.id ||
    policyContext.domainPack.version !== definition.version
  ) {
    fail("DEFINITION_INVALID", "trusted profile or Domain Pack policy was substituted");
  }
  const expectedPolicyCapabilities = [
    definition.capabilityBindings.framing,
    definition.capabilityBindings.execution,
    definition.capabilityBindings.verification,
    "core.refuse-authority-escalation@1.0.0"
  ];
  if (
    !equalStringSets(
      policyContext.domainPack.allowedCapabilities,
      expectedPolicyCapabilities
    ) ||
    !equalStringSets(
      policyContext.domainPack.prohibitedEffects,
      definition.prohibitedEffects
    ) ||
    policyContext.domainPack.depthCeiling !== "D1" ||
    policyContext.domainPack.riskCeiling !== "high" ||
    policyContext.domainPack.privacyCeiling !== "confidential" ||
    policyContext.domainPack.maxCalls !== 4 ||
    policyContext.domainPack.maxCostUnits !== 40 ||
    policyContext.domainPack.maxLoops !== 1 ||
    policyContext.domainPack.maxRetries !== 1 ||
    policyContext.domainPack.maxParallel !== 1
  ) {
    fail("DEFINITION_INVALID", "Domain Pack policy broadens its trusted ceiling");
  }
  if (
    digest(policyContext.registry) !== invariant.capabilityRegistryDigest ||
    policyContext.accord.policy.capabilityRegistryDigest !==
      invariant.capabilityRegistryDigest ||
    policyContext.accord.policy.tools.length !== 0 ||
    policyContext.accord.policy.shellCommands.length !== 0 ||
    policyContext.accord.policy.network.length !== 0 ||
    policyContext.accord.policy.mcpTools.length !== 0 ||
    policyContext.accord.policy.secretAccess !== false
  ) {
    fail("DEFINITION_INVALID", "domain registry or Work Accord access was substituted");
  }
  const expectedPaths = definition.slots.map(
    (slot) => `${definition.artifactRoot}/${slot.relativePath}`
  );
  validateRepositoryIdentity({
    repositoryId: policyContext.accord.binding.repositoryId,
    repositoryNodeId: policyContext.accord.binding.repositoryNodeId,
    repositoryFullName: policyContext.accord.binding.repositoryFullName,
    repositoryRootId: policyContext.accord.binding.repositoryRootId,
    workItemId: policyContext.accord.binding.workItemNodeId,
    defaultRef: policyContext.accord.binding.defaultRef,
    proposalRef: policyContext.accord.binding.proposalRef
  });
  if (
    !equalStringSets(policyContext.accord.policy.allowedPaths, expectedPaths) ||
    !equalStringSets(
      policyContext.accord.policy.prohibitedEffects,
      definition.prohibitedEffects
    ) ||
    policyContext.accord.policy.privacyClass !== "confidential" ||
    policyContext.accord.retention.artifactDays >
      definition.riskPrivacy.retentionDays ||
    policyContext.accord.retention.receiptDays >
      definition.riskPrivacy.retentionDays ||
    policyContext.accord.budget.maxTokens > definition.limits.maxTokens ||
    policyContext.accord.budget.maxDurationMs >
      definition.limits.maxDurationMs ||
    policyContext.accord.budget.maxPatchBytes >
      definition.limits.maxPatchBytes
  ) {
    fail("DEFINITION_INVALID", "Work Accord broadens the trusted pack contract");
  }

  const phaseContracts = policyContext.phaseContracts;
  const compiledEntries = DOMAIN_PHASES.map((phase) => {
    const contract = phaseContracts[phase];
    const accordPhase = policyContext.accord.policy.phaseContracts[phase];
    if (
      accordPhase === undefined ||
      contract.phase !== phase ||
      contract.identity.id !== `${definition.id}.${phase}` ||
      accordPhase.reference !==
        `${definition.id}.${phase}@1.0.0` ||
      accordPhase.digest !== digest(contract) ||
      contract.privacy.retentionDays >
        definition.riskPrivacy.retentionDays
    ) {
      fail("DEFINITION_INVALID", `${phase} Phase Contract was substituted`);
    }
    const result = compilePolicy({
      enterprise: policyContext.enterprise,
      accord: policyContext.accord,
      phase: contract,
      domainPack: policyContext.domainPack,
      registry: policyContext.registry
    });
    if (!result.ok) {
      fail(
        "DEFINITION_INVALID",
        `${phase} policy compilation failed: ${result.errors.join("; ")}`
      );
    }
    return [phase, result.policy] as const;
  });
  const requestedByPhases = phaseContracts
    ? DOMAIN_PHASES.flatMap(
        (phase) => phaseContracts[phase].allowedCapabilities
      )
    : [];
  if (
    !equalStringSets(
      policyContext.accord.policy.requestedCapabilities,
      requestedByPhases
    )
  ) {
    fail(
      "DEFINITION_INVALID",
      "Work Accord capabilities do not exactly cover every bound Phase Contract"
    );
  }
  for (const reference of requestedByPhases) {
    const phase = DOMAIN_PHASES.find((candidate) =>
      phaseContracts[candidate].allowedCapabilities.includes(reference)
    );
    const resolution =
      phase === undefined
        ? undefined
        : resolveCapability(policyContext.registry, reference, phase);
    if (resolution === undefined || !resolution.ok) {
      fail("DEFINITION_INVALID", `capability ${reference} is not exactly registered`);
    }
    const access = resolution.capability.access;
    if (
      access.write.allowed ||
      access.write.scopes.length !== 0 ||
      access.tools.length !== 0 ||
      access.shellCommands.length !== 0 ||
      access.networkDestinations.length !== 0 ||
      access.mcpTools.length !== 0 ||
      access.mcpReadTools.length !== 0 ||
      access.mcpMutationTools.length !== 0 ||
      access.secretNames.length !== 0
    ) {
      fail("DEFINITION_INVALID", `capability ${reference} exceeds zero-access pack policy`);
    }
  }
  const compiledPolicies = Object.fromEntries(compiledEntries) as unknown as Readonly<
    Record<DomainPhase, CompiledPolicy>
  >;
  const phaseContractDigests = Object.fromEntries(
    DOMAIN_PHASES.map((phase) => [phase, digest(phaseContracts[phase])])
  ) as unknown as Readonly<Record<DomainPhase, Digest>>;
  const artifactSchemaDigests = Object.fromEntries(
    definition.slots.map((slot) => [
      slot.id,
      domainArtifactSchemaDigest(definition.id, slot.id)
    ])
  ) as Readonly<Record<string, Digest>>;
  const artifactTemplateDigests = Object.fromEntries(
    definition.slots.map((slot) => [
      slot.id,
      domainArtifactTemplateDigest(definition.id, slot.id)
    ])
  ) as Readonly<Record<string, Digest>>;
  const bundleSchema =
    definition.id === "marketing"
      ? trustedMarketingArtifactSchema
      : trustedBusinessOperationsArtifactSchema;
  const authority = {
    definitionDigest: digest(definition),
    profileDigest: digest(profile),
    enterprisePolicyDigest: digest(policyContext.enterprise),
    workAccordDigest: digest(policyContext.accord),
    capabilityRegistryDigest: digest(policyContext.registry),
    domainPackPolicyDigest: digest(policyContext.domainPack),
    phaseContractDigests,
    compiledPolicies,
    bundleSchemaDigest: digest(bundleSchema),
    artifactSchemaDigests,
    artifactTemplateDigests,
    reviewRubricDigest: digest(definition.reviewRubric)
  };
  return deepFreeze({ ...authority, digest: digest(authority) });
}

function equalStrings(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function exactKeys(value: object, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (!equalStrings(actual, wanted)) {
    fail("MODEL_OUTPUT_INVALID", `${label} contains unknown or missing fields`);
  }
}

function timestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (
    !Number.isFinite(parsed) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value)
  ) {
    fail("APPROVAL_INVALID", `${label} is not a canonical UTC timestamp`);
  }
  return parsed;
}

function isBoundedOpaqueNodeId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 256;
}

function validateRepositoryIdentity(
  identity: DomainRepositoryIdentity
): DomainRepositoryIdentity {
  if (
    identity.repositoryId < 1 ||
    !Number.isSafeInteger(identity.repositoryId) ||
    !/^R_[A-Za-z0-9_]+$/u.test(identity.repositoryNodeId) ||
    !/^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]+$/u.test(
      identity.repositoryFullName
    ) ||
    !DIGEST_PATTERN.test(identity.repositoryRootId) ||
    !isBoundedOpaqueNodeId(identity.workItemId) ||
    identity.defaultRef !== "refs/heads/main" ||
    !/^refs\/heads\/agentic-domain\/[a-z0-9][a-z0-9._/-]*$/u.test(
      identity.proposalRef
    ) ||
    identity.proposalRef.includes("..") ||
    identity.proposalRef.includes("//") ||
    identity.proposalRef.endsWith("/")
  ) {
    fail(
      "PACKAGE_INVALID",
      "repository identity, root, work item, default ref, or proposal ref is invalid"
    );
  }
  return identity;
}

function earliestExpiry(values: readonly string[]): string {
  return new Date(
    Math.min(...values.map((value) => timestamp(value, "evidence expiresAt")))
  ).toISOString();
}

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
  const FORBIDDEN_TEXT = [
    /https?:\/\//iu,
    /<\s*(?:script|iframe|img|object|embed)\b/iu,
    /[\u202a-\u202e\u2066-\u2069]/u,
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
    /\b(?:api[_ -]?key|password|secret|bearer\s+[a-z0-9._-]+)\b/iu
  ] as const;
  const BUSINESS_FORBIDDEN_KEYS =
    /(?:personName|email|customerId|vendorId|payroll|bank|tax|contract|credential|secret|endpoint|query)/iu;
  const DATA_KEYS: Readonly<Record<DomainPackId, Readonly<Record<string, readonly string[]>>>> = {
    marketing: {
      "initiative-intake": ["objective", "constraints"],
      "audience-evidence": ["evidence"],
      "positioning-messaging": ["positioning", "messages"],
      "content-plan": ["deliverables"],
      "content-drafts": ["drafts"],
      "measurement-plan": ["metricDefinitions"],
      "brand-legal-assessment": ["advisoryOnly", "status", "findings"],
      "launch-readiness-assessment": ["advisoryOnly", "status", "findings"]
    },
    "business-operations": {
      "problem-framing": ["problem", "facts", "assumptions"],
      "stakeholder-analysis": ["roles", "omissions"],
      "process-map": ["nodes", "edges", "controls", "irreversibleBoundaries"],
      "decision-memo": ["options", "tradeoffs", "dissent", "reversibility", "status"],
      "policy-process-design": [
        "proposedPolicy",
        "authorityStatus",
        "controls",
        "exceptions",
        "effectiveStatus"
      ],
      "implementation-plan": ["tasks", "liveExecutionDeferred"],
      runbook: ["simulationOnly", "steps"],
      "controls-approvals": ["controls", "quorum"],
      "outcome-measurement": [
        "metrics",
        "baselineStatus",
        "independentVerifier"
      ]
    }
  };

  function inspectDomainValue(
    value: unknown,
    packId: DomainPackId,
    slot: string,
    path: string
  ): void {
    if (typeof value === "string") {
      if (FORBIDDEN_TEXT.some((pattern) => pattern.test(value))) {
        fail("MODEL_OUTPUT_INVALID", `${path} contains prohibited sensitive or active content`);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) =>
        inspectDomainValue(item, packId, slot, `${path}/${index}`)
      );
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [key, child] of Object.entries(value)) {
      if (packId === "business-operations" && BUSINESS_FORBIDDEN_KEYS.test(key)) {
        fail("MODEL_OUTPUT_INVALID", `${path}/${key} is prohibited business data`);
      }
      if (/^(?:approved|effective|launched|completed|outcomeAchieved)$/iu.test(key)) {
        fail("MODEL_OUTPUT_INVALID", `${path}/${key} attempts to assert human authority`);
      }
      inspectDomainValue(child, packId, slot, `${path}/${key}`);
    }
  }

  function parseDomainArtifactContent(input: {
    readonly definition: DomainPackDefinition;
    readonly slot: DomainPackDefinition["slots"][number];
    readonly content: string;
    readonly priorArtifacts: readonly DomainArtifact[];
    readonly approvedSourceDigests: readonly Digest[];
  }): Readonly<Record<string, unknown>> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.content) as unknown;
    } catch {
      fail("MODEL_OUTPUT_INVALID", `${input.slot.id} content is not JSON`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      fail("MODEL_OUTPUT_INVALID", `${input.slot.id} content must be a closed object`);
    }
    const artifact = parsed as Readonly<Record<string, unknown>>;
    exactKeys(
      artifact,
      [
        "schemaVersion",
        "artifactType",
        "proposalOnly",
        "sourceDigests",
        "upstreamArtifactDigests",
        "data"
      ],
      `${input.slot.id} artifact`
    );
    const sourceDigests = artifact["sourceDigests"];
    const upstreamDigests = artifact["upstreamArtifactDigests"];
    const data = artifact["data"];
    if (
      artifact["schemaVersion"] !== "1.0.0" ||
      artifact["artifactType"] !== input.slot.artifactType ||
      artifact["proposalOnly"] !== true ||
      !Array.isArray(sourceDigests) ||
      sourceDigests.length === 0 ||
      sourceDigests.some(
        (candidate) => typeof candidate !== "string" || !DIGEST_PATTERN.test(candidate)
      ) ||
      !Array.isArray(upstreamDigests) ||
      upstreamDigests.some(
        (candidate) => typeof candidate !== "string" || !DIGEST_PATTERN.test(candidate)
      ) ||
      typeof data !== "object" ||
      data === null ||
      Array.isArray(data)
    ) {
      fail("MODEL_OUTPUT_INVALID", `${input.slot.id} artifact envelope is invalid`);
    }
    if (
      sourceDigests.some(
        (candidate) =>
          !input.approvedSourceDigests.includes(candidate as Digest)
      )
    ) {
      fail(
        "MODEL_OUTPUT_INVALID",
        `${input.slot.id} cites source evidence outside the trusted catalog`
      );
    }
    const requiredDependencies = input.slot.dependsOn.map((dependency) => {
      const prior = input.priorArtifacts.find((candidate) => candidate.slot === dependency);
      if (prior === undefined) {
        fail("MODEL_OUTPUT_INVALID", `${input.slot.id} dependency ${dependency} is absent`);
      }
      return prior.contentDigest;
    });
    if (
      !equalStrings(
        upstreamDigests as readonly string[],
        requiredDependencies
      )
    ) {
      fail(
        "MODEL_OUTPUT_INVALID",
        `${input.slot.id} does not bind the current upstream artifact revisions`
      );
    }
    const expectedDataKeys = DATA_KEYS[input.definition.id][input.slot.id];
    if (expectedDataKeys === undefined) {
      fail("DEFINITION_INVALID", `${input.slot.id} has no deterministic artifact validator`);
    }
    exactKeys(data, expectedDataKeys, `${input.slot.id} data`);
    const schemaErrors = validateDomainArtifactSchema(
      input.definition.id,
      input.slot.id,
      artifact
    );
    if (schemaErrors.length > 0) {
      fail(
        "MODEL_OUTPUT_INVALID",
        `${input.slot.id} fails its closed schema: ${schemaErrors.join("; ")}`
      );
    }
    inspectDomainValue(data, input.definition.id, input.slot.id, `/data`);
    if (
      input.definition.id === "marketing" &&
      (input.slot.id === "brand-legal-assessment" ||
        input.slot.id === "launch-readiness-assessment")
    ) {
      const assessment = data as Readonly<Record<string, unknown>>;
      const allowedStatus =
        input.slot.id === "brand-legal-assessment"
          ? ["review-required", "blocked"]
          : ["ready-for-human-review", "not-ready"];
      if (
        assessment["advisoryOnly"] !== true ||
        typeof assessment["status"] !== "string" ||
        !allowedStatus.includes(assessment["status"])
      ) {
        fail("MODEL_OUTPUT_INVALID", `${input.slot.id} must remain advisory-only`);
      }
    }
    if (
      input.definition.id === "business-operations" &&
      input.slot.id === "runbook" &&
      (data as Readonly<Record<string, unknown>>)["simulationOnly"] !== true
    ) {
      fail("MODEL_OUTPUT_INVALID", "business operations runbook must be simulation-only");
    }
  return artifact;
}

function requireApprovedDigest(
  value: unknown,
  approved: ReadonlySet<string>,
  label: string
): void {
  if (typeof value !== "string" || !approved.has(value)) {
    fail("MODEL_OUTPUT_INVALID", `${label} cites unapproved or mutable evidence`);
  }
}

function validateDomainArtifactSemantics(input: {
  readonly definition: DomainPackDefinition;
  readonly parsed: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
  readonly sourceEvidence: readonly DomainSourceEvidence[];
  readonly classification: "internal" | "confidential" | "restricted";
  readonly now: string;
}): void {
  const approved = new Set<string>(
    input.sourceEvidence.map((record) => record.sourceDigest)
  );
  const sources = new Map(
    input.sourceEvidence.map((record) => [record.sourceDigest, record])
  );
  if (input.definition.id === "marketing") {
    const audience = input.parsed.get("audience-evidence");
    const evidence = (audience?.["data"] as { readonly evidence?: readonly unknown[] })
      ?.evidence;
    if (!Array.isArray(evidence)) {
      fail("MODEL_OUTPUT_INVALID", "marketing evidence catalog is absent");
    }
    for (const [index, item] of evidence.entries()) {
      const record = item as {
        readonly digest?: unknown;
        readonly contentDigest?: unknown;
        readonly classification?: unknown;
        readonly locator?: unknown;
        readonly rightsBasis?: unknown;
        readonly retentionDays?: unknown;
        readonly sourceObservedAt?: unknown;
        readonly sourceExpiresAt?: unknown;
        readonly observation?: unknown;
      };
      const digestValue = record.digest;
      requireApprovedDigest(digestValue, approved, `audience evidence ${index}`);
      const source = sources.get(digestValue as Digest);
      const classificationOrder = {
        internal: 0,
        confidential: 1,
        restricted: 2
      } as const;
      if (
        (record.classification !== "internal" &&
          record.classification !== "confidential") ||
        classificationOrder[record.classification] >
          classificationOrder[input.classification]
      ) {
        fail("MODEL_OUTPUT_INVALID", `audience evidence ${index} exceeds privacy scope`);
      }
      if (
        source === undefined ||
        record.contentDigest !== source.contentDigest ||
        record.classification !== source.classification ||
        record.locator !== source.locator ||
        record.rightsBasis !== source.rightsBasis ||
        record.retentionDays !== source.retentionDays ||
        record.sourceObservedAt !== source.observedAt ||
        record.sourceExpiresAt !== source.expiresAt ||
        record.observation !== source.content
      ) {
        fail(
          "MODEL_OUTPUT_INVALID",
          `audience evidence ${index} substitutes signed source metadata`
        );
      }
      const now = timestamp(input.now, "now");
      const expires = timestamp(
        source.expiresAt,
        "sourceExpiresAt"
      );
      if (
        expires <= now ||
        expires - now >
          input.definition.riskPrivacy.retentionDays * 24 * 60 * 60 * 1000
      ) {
        fail("MODEL_OUTPUT_INVALID", `audience evidence ${index} is stale or over-retained`);
      }
    }
    for (const [slot, artifact] of input.parsed) {
      const visit = (value: unknown, path: string): void => {
        if (Array.isArray(value)) {
          value.forEach((child, index) => visit(child, `${path}/${index}`));
          return;
        }
        if (typeof value !== "object" || value === null) return;
        for (const [key, child] of Object.entries(value)) {
          if (key === "evidenceDigests" && Array.isArray(child)) {
            child.forEach((candidate, index) =>
              requireApprovedDigest(
                candidate,
                approved,
                `${slot}${path}/${key}/${index}`
              )
            );
          } else if (key === "lineageEvidenceDigest") {
            requireApprovedDigest(child, approved, `${slot}${path}/${key}`);
          }
          visit(child, `${path}/${key}`);
        }
      };
      visit(artifact["data"], "/data");
    }
    return;
  }

  const processArtifact = input.parsed.get("process-map");
  const processData = processArtifact?.["data"] as
    | {
        readonly nodes?: readonly string[];
        readonly edges?: readonly { readonly from: string; readonly to: string }[];
        readonly irreversibleBoundaries?: readonly string[];
      }
    | undefined;
  const nodes = processData?.nodes ?? [];
  const edges = processData?.edges ?? [];
  const nodeSet = new Set(nodes);
  const incoming = new Map(nodes.map((node) => [node, 0]));
  const adjacency = new Map(nodes.map((node) => [node, [] as string[]]));
  for (const edge of edges) {
    if (
      !nodeSet.has(edge.from) ||
      !nodeSet.has(edge.to) ||
      edge.from === edge.to
    ) {
      fail("MODEL_OUTPUT_INVALID", "process map has a dangling or self-referential edge");
    }
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    adjacency.get(edge.from)?.push(edge.to);
  }
  if (
    (processData?.irreversibleBoundaries ?? []).some(
      (node) => !nodeSet.has(node)
    )
  ) {
    fail("MODEL_OUTPUT_INVALID", "process map has a dangling irreversible boundary");
  }
  const roots = nodes.filter((node) => incoming.get(node) === 0);
  if (roots.length !== 1) {
    fail("MODEL_OUTPUT_INVALID", "process map must have exactly one reachable root");
  }
  const visited = new Set<string>();
  const active = new Set<string>();
  const walk = (node: string): void => {
    if (active.has(node)) {
      fail("MODEL_OUTPUT_INVALID", "process map contains a cycle");
    }
    if (visited.has(node)) return;
    active.add(node);
    for (const child of adjacency.get(node) ?? []) walk(child);
    active.delete(node);
    visited.add(node);
  };
  walk(roots[0] as string);
  if (visited.size !== nodes.length) {
    fail("MODEL_OUTPUT_INVALID", "process map contains unreachable steps");
  }

  const controlsArtifact = input.parsed.get("controls-approvals");
  const controlsData = controlsArtifact?.["data"] as
    | {
        readonly controls?: readonly {
          readonly ownerRole: string;
          readonly operatorRole: string;
          readonly verifierRole: string;
          readonly policyRole: string;
        }[];
        readonly quorum?: number;
      }
    | undefined;
  if (controlsData?.quorum !== 4) {
    fail("MODEL_OUTPUT_INVALID", "control approval quorum is incomplete");
  }
  for (const control of controlsData?.controls ?? []) {
    if (
      control.ownerRole !== "role:control-owner" ||
      control.operatorRole !== "role:implementer" ||
      control.verifierRole !== "role:verifier" ||
      control.policyRole !== "role:policy-authority"
    ) {
      fail(
        "MODEL_OUTPUT_INVALID",
        "control roles must use the exact independently authorized role constants"
      );
    }
  }
  const outcome = input.parsed.get("outcome-measurement");
  const metrics = (
    outcome?.["data"] as
      | {
          readonly metrics?: readonly {
            readonly lineageEvidenceDigest?: unknown;
          }[];
        }
      | undefined
  )?.metrics;
  for (const [index, metric] of (metrics ?? []).entries()) {
    requireApprovedDigest(
      metric.lineageEvidenceDigest,
      approved,
      `outcome metric ${index}`
    );
  }
}

function unsigned<T extends { readonly signature: DomainDetachedSignature }>(
  value: T
): Omit<T, "signature"> {
  const { signature: _signature, ...payload } = value;
  return payload;
}

function validateFreshWindow(input: {
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly now: string;
  readonly maximumAgeMs: number;
}): void {
  const observedAt = timestamp(input.observedAt, "observedAt");
  const expiresAt = timestamp(input.expiresAt, "expiresAt");
  const now = timestamp(input.now, "now");
  if (
    observedAt > now ||
    expiresAt <= now ||
    now - observedAt > input.maximumAgeMs
  ) {
    fail("APPROVAL_INVALID", "signed evidence is stale, future-dated, or expired");
  }
}

export function validateDomainPackDefinition(
  value: unknown
): DomainPackDefinition {
  const snapshot = immutableSnapshot(value);
  if (!definitionValidator(snapshot)) {
    fail(
      "DEFINITION_INVALID",
      ajv.errorsText(definitionValidator.errors, { separator: "; " })
    );
  }
  const definition = snapshot;
  const invariant = PACK_INVARIANTS[definition.id];
  const slotShape = definition.slots.map(
    ({ id, artifactType, relativePath, maxBytes, dependsOn }) => ({
    id,
    artifactType,
    relativePath,
    maxBytes,
    dependsOn
  }));
  if (
    digest(definition) !== invariant.definitionDigest ||
    definition.enabledByDefault !== false ||
    definition.agent !== invariant.agent ||
    definition.skill !== invariant.skill ||
    definition.policyRef !==
      `config/v1alpha1/domain-packs/${definition.id}/policy.json` ||
    definition.artifactRoot !== invariant.artifactRoot ||
    definition.artifactSchema !== invariant.artifactSchema ||
    definition.templateRoot !==
      `config/v1alpha1/domain-packs/${definition.id}/templates` ||
    canonicalJson(definition.capabilityBindings) !==
      canonicalJson(invariant.capabilities) ||
    canonicalJson(slotShape) !== canonicalJson(invariant.slots) ||
    !definition.slots.every(
      (slot) =>
        slot.mode === 100644 &&
        slot.schema ===
          `schemas/v1alpha1/domain-packs/${definition.id}/${slot.id}.schema.json` &&
        slot.template === `${slot.id}.json`
    ) ||
    !equalStrings(
      definition.stages.map((stage) => stage.id),
      invariant.stages
    ) ||
    definition.access.tools.length !== 0 ||
    definition.access.shellCommands.length !== 0 ||
    definition.access.networkDestinations.length !== 0 ||
    definition.access.mcpTools.length !== 0 ||
    definition.access.secretNames.length !== 0 ||
    definition.access.externalAdapters.length !== 0 ||
    !equalStrings(definition.roles, invariant.roles) ||
    canonicalJson(definition.incompatibleRolePairs) !==
      canonicalJson(invariant.incompatibleRolePairs) ||
    definition.limits.maxTokens > 20_000 ||
    definition.limits.maxDurationMs > 600_000 ||
    definition.limits.maxRetries > 1 ||
    definition.limits.maxLoops !== 2 ||
    definition.limits.maxParallel !== 1 ||
    definition.limits.maxRecursionDepth !== 0 ||
    definition.limits.maxFiles !== invariant.slots.length ||
    definition.limits.maxPatchBytes > 262_144 ||
    definition.maxRevisionLoops !== 2 ||
    definition.maxArtifactBytes !== 262_144 ||
    definition.slots.reduce((sum, slot) => sum + slot.maxBytes, 0) >
      definition.maxArtifactBytes ||
    !invariant.prohibitedEffects.every((effect) =>
      definition.prohibitedEffects.includes(effect)
    )
  ) {
    fail(
      "DEFINITION_INVALID",
      `${definition.id} definition broadens or changes its trusted invariant`
    );
  }
  const gateRoles = Object.fromEntries(
    definition.humanGates.map((gate) => [gate.id, gate.role])
  );
  if (canonicalJson(gateRoles) !== canonicalJson(invariant.gates)) {
    fail(
      "DEFINITION_INVALID",
      `${definition.id} human gates are incomplete or have substituted roles`
    );
  }
  const slotIds = definition.slots.map((slot) => slot.id);
  const paths = definition.slots.map((slot) => slot.relativePath);
  if (
    new Set(slotIds).size !== slotIds.length ||
    new Set(paths).size !== paths.length ||
    !definition.slots.every((slot, index) =>
      slot.dependsOn.every((dependency) => slotIds.indexOf(dependency) < index)
    ) ||
    !definition.stages.every(
      (stage) =>
        equalStrings(stage.requiredSlots, [stage.id]) &&
        stage.requiredSlots.every((slot) => slotIds.includes(slot)) &&
        stage.requiredGates.every(
          (gate) =>
            gate === "accept-frame" ||
            gate === "accept-plan" ||
            Object.hasOwn(invariant.gates, gate)
        )
    ) ||
    !definition.incompatibleRolePairs.every(
      ([left, right]) =>
        left !== right &&
        definition.roles.includes(left) &&
        definition.roles.includes(right)
    )
  ) {
    fail("DEFINITION_INVALID", `${definition.id} references invalid slots, gates, or roles`);
  }
  return deepFreeze(definition);
}

export function validateTargetFreeDomainOutput(
  definition: DomainPackDefinition,
  output: TargetFreeDomainOutput,
  maximumTotalBytes = definition.maxArtifactBytes
): TargetFreeDomainOutput {
  exactKeys(
    output,
    ["summary", "changes", "findings", "openQuestions", "result", "reasonCode"],
    "domain model output"
  );
  if (
    (output.result !== "drafted" &&
      output.result !== "blocked" &&
      output.result !== "failed") ||
    output.summary.length === 0 ||
    output.summary.length > 8000 ||
    output.findings.some((finding) => finding.length === 0 || finding.length > 8192) ||
    output.openQuestions.some(
      (question) => question.length === 0 || question.length > 8192
    )
  ) {
    fail("MODEL_OUTPUT_INVALID", "domain model output is blocked, failed, or malformed");
  }
  if (output.result !== "drafted") {
    if (
      output.changes.length !== 0 ||
      output.reasonCode === null ||
      ![
        "evidence-insufficient",
        "sensitive-data",
        "authority-required",
        "policy-refusal"
      ].includes(output.reasonCode)
    ) {
      fail(
        "MODEL_OUTPUT_INVALID",
        "blocked and failed outputs require zero changes and one typed reason"
      );
    }
    return output;
  }
  if (output.reasonCode !== null) {
    fail("MODEL_OUTPUT_INVALID", "drafted output cannot carry a refusal reason");
  }
  const expectedSlots = definition.slots.map((slot) => slot.id);
  const actualSlots = output.changes.map((change) => change.slot);
  if (
    !equalStrings(actualSlots, expectedSlots) ||
    new Set(actualSlots).size !== actualSlots.length
  ) {
    fail(
      "MODEL_OUTPUT_INVALID",
      "model output must contain every approved logical slot exactly once and in order"
    );
  }
  let totalBytes = 0;
  for (const [index, change] of output.changes.entries()) {
    exactKeys(change, ["slot", "content"], `slot ${change.slot}`);
    const bytes = Buffer.byteLength(change.content, "utf8");
    totalBytes += bytes;
    const slot = definition.slots[index];
    if (
      slot === undefined ||
      bytes === 0 ||
      bytes > slot.maxBytes
    ) {
      fail("MODEL_OUTPUT_INVALID", `slot ${change.slot} exceeds its content bound`);
    }
  }
  if (
    totalBytes > definition.maxArtifactBytes ||
    totalBytes > maximumTotalBytes
  ) {
    fail("MODEL_OUTPUT_INVALID", "domain artifact set exceeds its total byte bound");
  }
  return output;
}

export function mapTargetFreeDomainOutput(input: {
  readonly definition: DomainPackDefinition;
  readonly repositoryId: number;
  readonly workItemId: string;
  readonly headSha: string;
  readonly output: TargetFreeDomainOutput;
  readonly sourceEvidence: readonly DomainSourceEvidence[];
  readonly classification: "internal" | "confidential" | "restricted";
  readonly now: string;
}): readonly DomainArtifact[] {
  const definition = validateDomainPackDefinition(input.definition);
  const output = validateTargetFreeDomainOutput(definition, input.output);
  if (output.result !== "drafted") {
    fail("MODEL_OUTPUT_INVALID", "refusal output cannot be mapped or packaged");
  }
  if (
    input.repositoryId < 1 ||
    !isBoundedOpaqueNodeId(input.workItemId) ||
    !/^[a-f0-9]{40}$/u.test(input.headSha)
  ) {
    fail("PACKAGE_INVALID", "trusted repository, work item, or head binding is invalid");
  }
  if (
    input.sourceEvidence.length === 0 ||
    new Set(input.sourceEvidence.map((record) => record.sourceDigest)).size !==
      input.sourceEvidence.length ||
    input.sourceEvidence.some(
      (record) => !DIGEST_PATTERN.test(record.sourceDigest)
    )
  ) {
    fail("PACKAGE_INVALID", "trusted source evidence catalog is invalid");
  }
  if (!definition.riskPrivacy.allowedClassifications.includes(input.classification)) {
    fail("PACKAGE_INVALID", "requested classification exceeds the pack policy");
  }
  const artifacts: DomainArtifact[] = [];
  const approvedSourceDigests = input.sourceEvidence.map(
    (record) => record.sourceDigest
  );
  const parsedArtifacts = new Map<string, Readonly<Record<string, unknown>>>();
  for (const [index, slot] of definition.slots.entries()) {
    const change = output.changes[index];
    if (change === undefined || change.slot !== slot.id) {
      fail("MODEL_OUTPUT_INVALID", `logical slot ${slot.id} is missing`);
    }
    const parsed = parseDomainArtifactContent({
      definition,
      slot,
      content: change.content,
      priorArtifacts: artifacts,
      approvedSourceDigests
    });
    parsedArtifacts.set(slot.id, parsed);
    artifacts.push({
      artifactType: slot.artifactType,
      slot: slot.id,
      path: `${definition.artifactRoot}/${slot.relativePath}`,
      mode: 100644,
      schemaDigest: domainArtifactSchemaDigest(definition.id, slot.id),
      templateDigest: domainArtifactTemplateDigest(definition.id, slot.id),
      upstreamArtifactDigests: slot.dependsOn.map((dependency) => {
        const dependencyArtifact = artifacts.find(
          (candidate) => candidate.slot === dependency
        );
        if (dependencyArtifact === undefined) {
          fail("MODEL_OUTPUT_INVALID", `dependency ${dependency} is unavailable`);
        }
        return dependencyArtifact.contentDigest;
      }),
      content: change.content,
      contentDigest: digest({ content: change.content })
    });
  }
  validateDomainArtifactSemantics({
    definition,
    parsed: parsedArtifacts,
    sourceEvidence: input.sourceEvidence,
    classification: input.classification,
    now: input.now
  });
  return artifacts;
}

function validateKernelAuthorization(input: {
  readonly authorization: DomainAppliedKernelAuthorization;
  readonly authority: DomainCompiledAuthority;
  readonly repositoryId: number;
  readonly workItemId: string;
  readonly repositoryIdentityDigest: Digest;
  readonly baseSha: string;
  readonly headSha: string;
  readonly roleBindingSetDigest: Digest;
  readonly sourceEvidenceSetDigest: Digest;
  readonly now: string;
  readonly verifier: DomainEvidenceVerifier;
}): void {
  const authorizationDigestMap = Object.fromEntries(
    DOMAIN_PHASES.map((phase) => [
      phase,
      input.authority.compiledPolicies[phase].digest
    ])
  );
  const authorization = input.authorization;
  if (
    authorization.purpose !== "domain-kernel-authorization" ||
    authorization.result !== "applied" ||
    authorization.authorityDigest !== input.authority.digest ||
    canonicalJson(authorization.compiledPolicyDigests) !==
      canonicalJson(authorizationDigestMap) ||
    authorization.repositoryId !== input.repositoryId ||
    authorization.workItemId !== input.workItemId ||
    authorization.repositoryIdentityDigest !== input.repositoryIdentityDigest ||
    authorization.baseSha !== input.baseSha ||
    authorization.headSha !== input.headSha ||
    authorization.roleBindingSetDigest !== input.roleBindingSetDigest ||
    authorization.sourceEvidenceSetDigest !== input.sourceEvidenceSetDigest ||
    authorization.runId.length < 16 ||
    !Number.isSafeInteger(authorization.runAttempt) ||
    authorization.runAttempt < 1 ||
    authorization.runNonce.length < 16 ||
    authorization.runCasResult !== "appended" ||
    authorization.runRedemptionKey !==
      digest({
        authorityDigest: input.authority.digest,
        repositoryId: input.repositoryId,
        workItemId: input.workItemId,
        repositoryIdentityDigest: input.repositoryIdentityDigest,
        baseSha: input.baseSha,
        headSha: input.headSha,
        runId: authorization.runId,
        runAttempt: authorization.runAttempt,
        runNonce: authorization.runNonce
      }) ||
    !DIGEST_PATTERN.test(authorization.kernelReceiptDigest) ||
    !DIGEST_PATTERN.test(authorization.kernelResultDigest) ||
    !DIGEST_PATTERN.test(authorization.leaseDigest) ||
    !DIGEST_PATTERN.test(authorization.threatAssessmentDigest) ||
    authorization.threatStatus !== "success" ||
    authorization.stateRevoked !== false ||
    authorization.leaseRevoked !== false ||
    !input.verifier.verify(
      unsigned(authorization),
      authorization.signature,
      "domain-kernel-authorization"
    )
  ) {
    fail("GRANT_INVALID", "applied Kernel authorization is forged or out of scope");
  }
  validateFreshWindow({
    observedAt: authorization.issuedAt,
    expiresAt: authorization.expiresAt,
    now: input.now,
    maximumAgeMs: 300_000
  });
}

function validateRoleBindings(input: {
  readonly bindings: readonly DomainRoleBinding[];
  readonly definition: DomainPackDefinition;
  readonly authority: DomainCompiledAuthority;
  readonly workAccordDigest: Digest;
  readonly repositoryId: number;
  readonly workItemId: string;
  readonly repositoryIdentityDigest: Digest;
  readonly headSha: string;
  readonly requesterId: number;
  readonly automationActorId: number;
  readonly now: string;
  readonly authorityExpiresAt: string;
  readonly verifier: DomainEvidenceVerifier;
}): ReadonlyMap<string, DomainRoleBinding> {
  if (
    input.bindings.length !== input.definition.roles.length ||
    new Set(input.bindings.map((binding) => binding.role)).size !==
      input.bindings.length
  ) {
    fail("APPROVAL_INVALID", "every configured role requires one signed binding");
  }
  const byRole = new Map<string, DomainRoleBinding>();
  for (const binding of input.bindings) {
    if (
      !input.definition.roles.includes(binding.role) ||
      binding.purpose !== "domain-role-binding" ||
      binding.authorityDigest !== input.authority.digest ||
      binding.workAccordDigest !== input.workAccordDigest ||
      binding.repositoryId !== input.repositoryId ||
      binding.workItemId !== input.workItemId ||
      binding.repositoryIdentityDigest !== input.repositoryIdentityDigest ||
      binding.headSha !== input.headSha ||
      binding.actorId < 1 ||
      binding.actorLogin.length === 0 ||
      (binding.actorType !== "User" && binding.actorType !== "App") ||
      !["write", "maintain", "admin"].includes(binding.repositoryPermission) ||
      (binding.actorType === "App" && binding.role !== "activator") ||
      !binding.teamIds.includes(
        `team:${input.definition.id}:${binding.role}`
      ) ||
      timestamp(binding.expiresAt, "role binding expiresAt") >
        timestamp(input.authorityExpiresAt, "authority expiresAt") ||
      !input.verifier.verify(
        unsigned(binding),
        binding.signature,
        "domain-role-binding"
      )
    ) {
      fail("APPROVAL_INVALID", `role ${binding.role} has invalid actor authorization`);
    }
    validateFreshWindow({
      observedAt: binding.observedAt,
      expiresAt: binding.expiresAt,
      now: input.now,
      maximumAgeMs: 300_000
    });
    byRole.set(binding.role, binding);
  }
  if (
    byRole.get("requester")?.actorId !== input.requesterId ||
    byRole.get("activator")?.actorId !== input.automationActorId
  ) {
    fail("APPROVAL_INVALID", "requester or activator identity is substituted");
  }
  for (const [left, right] of input.definition.incompatibleRolePairs) {
    if (byRole.get(left)?.actorId === byRole.get(right)?.actorId) {
      fail("APPROVAL_INVALID", `${left} and ${right} must use distinct actors`);
    }
  }
  return byRole;
}

function validateApprovals(input: {
  readonly approvals: readonly DomainHumanApproval[];
  readonly definition: DomainPackDefinition;
  readonly authority: DomainCompiledAuthority;
  readonly roleBindings: ReadonlyMap<string, DomainRoleBinding>;
  readonly repositoryId: number;
  readonly workItemId: string;
  readonly repositoryIdentityDigest: Digest;
  readonly baseSha: string;
  readonly headSha: string;
  readonly requesterId: number;
  readonly automationActorId: number;
  readonly artifactSetDigest: Digest;
  readonly packageDigest: Digest;
  readonly commentReviewReceiptDigest: Digest;
  readonly humanWaitCheckpointDigest: Digest;
  readonly claimEvidenceDigest: Digest;
  readonly rightsEvidenceDigest: Digest;
  readonly claimsRightsAuthorityDigest: Digest;
  readonly claimsRightsAuthorityRevision: number;
  readonly claimsRightsAuthorityHeadDigest: Digest;
  readonly claimsRightsExpiresAt: string;
  readonly humanWaitRecordedAt: string;
  readonly authorityExpiresAt: string;
  readonly now: string;
  readonly verifier: DomainEvidenceVerifier;
}): readonly Digest[] {
  const required = input.definition.humanGates.filter(
    (gate) => gate.requiredForReadiness
  );
  if (input.approvals.length !== required.length) {
    fail("APPROVAL_INVALID", "all required domain approvals must be supplied exactly once");
  }
  const approvers = new Set<number>();
  const approvalDigests: Digest[] = [];
  for (const gate of required) {
    const approval = input.approvals.find(
      (candidate) => candidate.gate === gate.id
    );
    const roleBinding = input.roleBindings.get(gate.role);
    const authorization = approval?.actorAuthorization;
    if (
      approval === undefined ||
      roleBinding === undefined ||
      approval.role !== gate.role ||
      approval.approverType !== "User" ||
      approval.packId !== input.definition.id ||
      approval.repositoryId !== input.repositoryId ||
      approval.workItemId !== input.workItemId ||
      approval.repositoryIdentityDigest !== input.repositoryIdentityDigest ||
      approval.baseSha !== input.baseSha ||
      approval.headSha !== input.headSha ||
      approval.requesterId !== input.requesterId ||
      approval.automationActorId !== input.automationActorId ||
      approval.artifactSetDigest !== input.artifactSetDigest ||
      approval.packageDigest !== input.packageDigest ||
      approval.commentReviewReceiptDigest !==
        input.commentReviewReceiptDigest ||
      approval.purpose !== `domain-approval:${gate.id}` ||
      approval.humanWaitCheckpointDigest !==
        input.humanWaitCheckpointDigest ||
      approval.claimEvidenceDigest !== input.claimEvidenceDigest ||
      approval.rightsEvidenceDigest !== input.rightsEvidenceDigest ||
      approval.claimsRightsAuthorityDigest !==
        input.claimsRightsAuthorityDigest ||
      approval.claimsRightsAuthorityRevision !==
        input.claimsRightsAuthorityRevision ||
      approval.claimsRightsAuthorityHeadDigest !==
        input.claimsRightsAuthorityHeadDigest ||
      approval.claimsRightsExpiresAt !== input.claimsRightsExpiresAt ||
      approval.approverId === input.requesterId ||
      approval.approverId === input.automationActorId ||
      approvers.has(approval.approverId) ||
      authorization === undefined ||
      authorization.actorId !== approval.approverId ||
      authorization.actorId !== roleBinding.actorId ||
      authorization.actorType !== roleBinding.actorType ||
      authorization.purpose !==
        `domain-actor-authorization:${gate.id}` ||
      authorization.actorType !== "User" ||
      authorization.actorRole !== gate.role ||
      !["write", "maintain", "admin"].includes(
        authorization.repositoryPermission
      ) ||
      !authorization.teamIds.includes(
        `team:${input.definition.id}:${gate.role}`
      ) ||
      authorization.roleBindingDigest !== digest(roleBinding) ||
      authorization.authorityDigest !== input.authority.digest ||
      authorization.workAccordDigest !== input.authority.workAccordDigest ||
      authorization.artifactSetDigest !== input.artifactSetDigest ||
      authorization.packageDigest !== input.packageDigest ||
      authorization.commentReviewReceiptDigest !==
        input.commentReviewReceiptDigest ||
      authorization.humanWaitCheckpointDigest !==
        input.humanWaitCheckpointDigest ||
      authorization.claimEvidenceDigest !== input.claimEvidenceDigest ||
      authorization.rightsEvidenceDigest !== input.rightsEvidenceDigest ||
      authorization.claimsRightsAuthorityDigest !==
        input.claimsRightsAuthorityDigest ||
      authorization.claimsRightsAuthorityRevision !==
        input.claimsRightsAuthorityRevision ||
      authorization.claimsRightsAuthorityHeadDigest !==
        input.claimsRightsAuthorityHeadDigest ||
      authorization.claimsRightsExpiresAt !== input.claimsRightsExpiresAt ||
      approval.actorAuthorizationDigest !== digest(authorization) ||
      authorization.repositoryId !== input.repositoryId ||
      authorization.workItemId !== input.workItemId ||
      authorization.repositoryIdentityDigest !== input.repositoryIdentityDigest ||
      authorization.headSha !== input.headSha ||
      timestamp(authorization.expiresAt, "actor authorization expiresAt") >
        timestamp(input.authorityExpiresAt, "authority expiresAt") ||
      timestamp(approval.expiresAt, "approval expiresAt") >
        timestamp(input.authorityExpiresAt, "authority expiresAt") ||
      timestamp(authorization.expiresAt, "actor authorization expiresAt") >
        timestamp(input.claimsRightsExpiresAt, "claims and rights expiresAt") ||
      timestamp(approval.expiresAt, "approval expiresAt") >
        timestamp(input.claimsRightsExpiresAt, "claims and rights expiresAt") ||
      timestamp(input.now, "now") >=
        timestamp(input.claimsRightsExpiresAt, "claims and rights expiresAt") ||
      !input.verifier.verify(
        unsigned(authorization),
        authorization.signature,
        `domain-actor-authorization:${gate.id}`
      ) ||
      !input.verifier.verify(
        unsigned(approval),
        approval.signature,
        `domain-approval:${gate.id}`
      )
    ) {
      fail(
        "APPROVAL_INVALID",
        `${gate.id} approval is missing, forged, self-issued, reused, or substituted`
      );
    }
    validateFreshWindow({
      observedAt: approval.observedAt,
      expiresAt: approval.expiresAt,
      now: input.now,
      maximumAgeMs: gate.maxAgeMs
    });
    validateFreshWindow({
      observedAt: authorization.observedAt,
      expiresAt: authorization.expiresAt,
      now: input.now,
      maximumAgeMs: gate.maxAgeMs
    });
    if (
      timestamp(approval.observedAt, "approval observedAt") <
        timestamp(input.humanWaitRecordedAt, "human wait recordedAt") ||
      timestamp(authorization.observedAt, "authorization observedAt") <
        timestamp(input.humanWaitRecordedAt, "human wait recordedAt")
    ) {
      fail("APPROVAL_INVALID", `${gate.id} approval was issued before human wait`);
    }
    approvers.add(approval.approverId);
    approvalDigests.push(digest(approval));
  }
  return approvalDigests;
}

function computeArtifactSetDigest(input: {
  readonly packId: DomainPackId;
  readonly repositoryId: number;
  readonly workItemId: string;
  readonly classification: "internal" | "confidential" | "restricted";
  readonly authorityDigest: Digest;
  readonly approvedSourceDigests: readonly Digest[];
  readonly artifacts: readonly DomainArtifact[];
}): Digest {
  return digest(input);
}

function validateArtifactBundle(
  bundle: DomainArtifactBundle,
  definition: DomainPackDefinition
): void {
  const validator = artifactValidators[bundle.packId];
  if (!validator(bundle)) {
    fail(
      "PACKAGE_INVALID",
      ajv.errorsText(validator.errors, { separator: "; " })
    );
  }
  if (
    bundle.classification === "restricted" ||
    bundle.artifacts.length !== definition.slots.length
  ) {
    fail("PACKAGE_INVALID", "bundle classification or artifact count is invalid");
  }
  if (
    bundle.artifactSetDigest !==
    computeArtifactSetDigest({
      packId: bundle.packId,
      repositoryId: bundle.repositoryId,
      workItemId: bundle.workItemId,
      classification: bundle.classification,
      authorityDigest: bundle.authorityDigest,
      approvedSourceDigests: bundle.approvedSourceDigests,
      artifacts: bundle.artifacts
    })
  ) {
    fail("PACKAGE_INVALID", "bundle artifact-set digest is inconsistent");
  }
  for (const [index, slot] of definition.slots.entries()) {
    const artifact = bundle.artifacts[index];
    if (
      artifact === undefined ||
      artifact.slot !== slot.id ||
      artifact.artifactType !== slot.artifactType ||
      artifact.path !== `${definition.artifactRoot}/${slot.relativePath}` ||
      artifact.schemaDigest !==
        domainArtifactSchemaDigest(definition.id, slot.id) ||
      artifact.templateDigest !==
        domainArtifactTemplateDigest(definition.id, slot.id) ||
      artifact.contentDigest !== digest({ content: artifact.content }) ||
      !equalStrings(
        artifact.upstreamArtifactDigests,
        slot.dependsOn.map((dependency) => {
          const upstream = bundle.artifacts.find(
            (candidate) => candidate.slot === dependency
          );
          return upstream?.contentDigest ?? ("" as Digest);
        })
      )
    ) {
      fail("PACKAGE_INVALID", `bundle slot ${slot.id} is substituted or inconsistent`);
    }
  }
}

function validateSourceEvidence(input: {
    readonly evidence: readonly DomainSourceEvidence[];
    readonly definition: DomainPackDefinition;
    readonly authority: DomainCompiledAuthority;
    readonly classification: "internal" | "confidential" | "restricted";
    readonly authorityExpiresAt: string;
    readonly now: string;
    readonly verifier: DomainEvidenceVerifier;
  }): readonly Digest[] {
    if (
      input.evidence.length === 0 ||
      new Set(input.evidence.map((record) => record.sourceDigest)).size !==
        input.evidence.length
    ) {
      fail("PACKAGE_INVALID", "trusted source catalog is empty or duplicated");
    }
    const order = { internal: 0, confidential: 1, restricted: 2 } as const;
    for (const record of input.evidence) {
      if (
        !Object.hasOwn(order, record.classification) ||
        order[record.classification] > order[input.classification]
      ) {
        fail("PACKAGE_INVALID", "source evidence classification is unknown or restricted");
      }
      if (
        record.purpose !== "domain-source-evidence" ||
        record.authorityDigest !== input.authority.digest ||
        record.content.length === 0 ||
        record.contentDigest !== digest({ content: record.content }) ||
        !DIGEST_PATTERN.test(record.sourceDigest) ||
        !["original", "approved-license", "internal-authorized"].includes(
          record.rightsBasis
        ) ||
        !Number.isSafeInteger(record.retentionDays) ||
        record.retentionDays < 1 ||
        record.retentionDays > input.definition.riskPrivacy.retentionDays ||
        !input.verifier.verify(
          unsigned(record),
          record.signature,
          "domain-source-evidence"
        )
      ) {
        fail("PACKAGE_INVALID", "source evidence is forged, restricted, or substituted");
      }
      if (
        timestamp(record.expiresAt, "source evidence expiresAt") >
        timestamp(input.authorityExpiresAt, "authority expiresAt")
      ) {
        fail("PACKAGE_INVALID", "source evidence outlives its Work Accord");
      }
      validateFreshWindow({
        observedAt: record.observedAt,
        expiresAt: record.expiresAt,
        now: input.now,
        maximumAgeMs: 300_000
      });
    }
    return input.evidence.map((record) => record.sourceDigest);
  }

  function validateDlpEvidence(input: {
    readonly evidence: DomainDlpEvidence;
    readonly stage: DomainDlpEvidence["stage"];
    readonly authority: DomainCompiledAuthority;
    readonly artifactSetDigest: Digest | null;
    readonly sourceDigests: readonly Digest[];
    readonly values: unknown;
    readonly now: string;
    readonly verifier: DomainEvidenceVerifier;
  }): void {
    const evidence = input.evidence;
    if (
      evidence.purpose !== "domain-dlp" ||
      evidence.stage !== input.stage ||
      evidence.authorityDigest !== input.authority.digest ||
      evidence.inputDigest !== digest(input.values) ||
      evidence.artifactSetDigest !== input.artifactSetDigest ||
      !equalStrings(evidence.sourceDigests, input.sourceDigests) ||
      evidence.status !== "success" ||
      evidence.findings.length !== 0 ||
      !input.verifier.verify(unsigned(evidence), evidence.signature, "domain-dlp")
    ) {
      fail("MODEL_OUTPUT_INVALID", "authoritative DLP classification did not pass");
    }

    validateFreshWindow({
      observedAt: evidence.checkedAt,
      expiresAt: evidence.expiresAt,
      now: input.now,
      maximumAgeMs: 300_000
    });
  }

  function validatePromptThreatAssessment(input: {
    readonly evidence: DomainPromptThreatAssessment;
    readonly authority: DomainCompiledAuthority;
    readonly reviewPayloadDigest: Digest;
    readonly artifactBundleDigest: Digest;
    readonly now: string;
    readonly verifier: DomainEvidenceVerifier;
  }): void {
    const evidence = input.evidence;
    if (
      evidence.purpose !== "domain-review-threat-assessment" ||
      evidence.authorityDigest !== input.authority.digest ||
      evidence.reviewPayloadDigest !== input.reviewPayloadDigest ||
      evidence.artifactBundleDigest !== input.artifactBundleDigest ||
      evidence.status !== "success" ||
      evidence.findings.length !== 0 ||
      evidence.assessor !== "trusted-independent-service" ||
      evidence.reviewerSelfAttested !== false ||
      !input.verifier.verify(
        unsigned(evidence),
        evidence.signature,
        "domain-review-threat-assessment"
      )
    ) {
      fail("REVIEW_INVALID", "independent prompt-injection assessment did not pass");
    }
    validateFreshWindow({
      observedAt: evidence.checkedAt,
      expiresAt: evidence.expiresAt,
      now: input.now,
      maximumAgeMs: 300_000
    });
  }

  function validateArtifactPolicyAssessment(input: {
    readonly evidence: DomainArtifactPolicyAssessment;
    readonly authority: DomainCompiledAuthority;
    readonly packId: DomainPackId;
    readonly artifactSetDigest: Digest;
    readonly prohibitedEffects: readonly string[];
    readonly values: unknown;
    readonly now: string;
    readonly verifier: DomainEvidenceVerifier;
  }): void {
    const evidence = input.evidence;
    if (
      evidence.purpose !== "domain-artifact-policy-assessment" ||
      !validateDocument("DomainArtifactPolicyAssessment", evidence).valid ||
      evidence.packId !== input.packId ||
      evidence.authorityDigest !== input.authority.digest ||
      evidence.artifactSetDigest !== input.artifactSetDigest ||
      evidence.inputDigest !== digest(input.values) ||
      evidence.prohibitedEffectsDigest !==
        digest(input.prohibitedEffects) ||
      evidence.status !== "success" ||
      !Array.isArray(evidence.findings) ||
      evidence.findings.length !== 0 ||
      evidence.assessor !== "trusted-independent-service" ||
      evidence.modelSelfAttested !== false ||
      !input.verifier.verify(
        unsigned(evidence),
        evidence.signature,
        "domain-artifact-policy-assessment"
      )
    ) {
      fail(
        "MODEL_OUTPUT_INVALID",
        "independent artifact policy assessment did not pass"
      );
    }
    validateFreshWindow({
      observedAt: evidence.checkedAt,
      expiresAt: evidence.expiresAt,
      now: input.now,
      maximumAgeMs: 300_000
    });
  }

  function extractClaimAndRightsRequests(
    definition: DomainPackDefinition,
    artifacts: readonly DomainArtifact[]
  ): {
    readonly claims: readonly DomainClaimRequest[];
    readonly rights: readonly DomainRightsRequest[];
  } {
    if (definition.id !== "marketing") return { claims: [], rights: [] };
    const claims: DomainClaimRequest[] = [];
    const rights: DomainRightsRequest[] = [];
    for (const artifact of artifacts) {
      const envelope = JSON.parse(artifact.content) as {
        readonly data: Readonly<Record<string, unknown>>;
      };
      if (artifact.slot === "positioning-messaging") {
        const positioning = envelope.data["positioning"] as readonly {
          readonly claim: string;
          readonly claimType: string;
          readonly evidenceDigests: readonly Digest[];
          readonly rightsIds: readonly string[];
        }[];
        const messages = envelope.data["messages"] as typeof positioning;
        [...positioning, ...messages].forEach((message, index) => {
          const claimDigest = digest({
            claim: message.claim,
            claimType: message.claimType
          });
          claims.push({
            claimId:
              index < positioning.length
                ? `positioning:${index + 1}`
                : `message:${index - positioning.length + 1}`,
            slot: artifact.slot,
            claim: message.claim,
            claimType: message.claimType,
            claimDigest,
            evidenceDigests: message.evidenceDigests
          });
          for (const rightsId of message.rightsIds) {
            rights.push({
              rightsId,
              slot: artifact.slot,
              assetId:
                index < positioning.length
                  ? `positioning:${index + 1}`
                  : `message:${index - positioning.length + 1}`,
              assetDigest: claimDigest
            });
          }
        });
      }
      const collection =
        artifact.slot === "content-plan"
          ? (envelope.data["deliverables"] as readonly Record<string, unknown>[])
          : artifact.slot === "content-drafts"
            ? (envelope.data["drafts"] as readonly Record<string, unknown>[])
            : [];
      collection.forEach((asset) => {
        const rightsIds = asset["rightsIds"] as readonly string[];
        const evidenceDigests = asset["evidenceDigests"] as readonly Digest[];
        const assetId = asset["artifactId"] as string;
        const claimScope = Object.fromEntries(
          Object.entries(asset).filter(
            ([key]) => key !== "rightsIds" && key !== "evidenceDigests"
          )
        );
        const assetDigest = digest(claimScope);
        const claimType = `${artifact.slot}-content`;
        const claim = canonicalJson(claimScope);
        claims.push({
          claimId: `asset:${artifact.slot}:${assetId}`,
          slot: artifact.slot,
          claim,
          claimType,
          claimDigest: digest({ claim, claimType }),
          evidenceDigests
        });
        for (const rightsId of rightsIds) {
          rights.push({
            rightsId,
            slot: artifact.slot,
            assetId,
            assetDigest
          });
        }
      });
    }
    return { claims, rights };
  }

  function validateClaimsAndRights(input: {
    readonly requested: {
      readonly claims: readonly DomainClaimRequest[];
      readonly rights: readonly DomainRightsRequest[];
    };
    readonly resolved: {
      readonly claims: readonly DomainClaimEvidence[];
      readonly rights: readonly DomainRightsEvidence[];
      readonly authority: DomainClaimsRightsAuthorityEvidence;
    };
    readonly authority: DomainCompiledAuthority;
    readonly artifactSetDigest: Digest;
    readonly now: string;
    readonly verifier: DomainEvidenceVerifier;
  }): { readonly claimDigest: Digest; readonly rightsDigest: Digest } {
    if (
      input.resolved.claims.length !== input.requested.claims.length ||
      input.resolved.rights.length !== input.requested.rights.length
    ) {
      fail("MODEL_OUTPUT_INVALID", "claim or rights evidence is incomplete");
    }
    for (const request of input.requested.claims) {
      const evidence = input.resolved.claims.find(
        (candidate) => candidate.claimId === request.claimId
      );
      if (
        evidence === undefined ||
        evidence.purpose !== "domain-claim-evidence" ||
        evidence.authorityDigest !== input.authority.digest ||
        evidence.artifactSetDigest !== input.artifactSetDigest ||
        evidence.slot !== request.slot ||
        evidence.claimDigest !== request.claimDigest ||
        evidence.claimType !== request.claimType ||
        !equalStrings(evidence.evidenceDigests, request.evidenceDigests) ||
        evidence.authorized !== true ||
        evidence.revoked !== false ||
        !input.verifier.verify(
          unsigned(evidence),
          evidence.signature,
          "domain-claim-evidence"
        )
      ) {
        fail("MODEL_OUTPUT_INVALID", `claim ${request.claimId} lacks exact authorization`);
      }
      validateFreshWindow({
        observedAt: evidence.observedAt,
        expiresAt: evidence.expiresAt,
        now: input.now,
        maximumAgeMs: 300_000
      });
    }
    for (const [index, request] of input.requested.rights.entries()) {
      const evidence = input.resolved.rights[index];
      if (
        evidence === undefined ||
        evidence.purpose !== "domain-rights-evidence" ||
        evidence.authorityDigest !== input.authority.digest ||
        evidence.artifactSetDigest !== input.artifactSetDigest ||
        evidence.rightsId !== request.rightsId ||
        evidence.slot !== request.slot ||
        evidence.assetId !== request.assetId ||
        evidence.assetDigest !== request.assetDigest ||
        (evidence.license !== "original" &&
          evidence.license !== "approved-license") ||
        !equalStrings(evidence.territories, ["internal-repository"]) ||
        !equalStrings(evidence.channels, ["repository-pr"]) ||
        (evidence.trademarkStatus !== "none" &&
          evidence.trademarkStatus !== "human-reviewed") ||
        evidence.revoked !== false ||
        !input.verifier.verify(
          unsigned(evidence),
          evidence.signature,
          "domain-rights-evidence"
        )
      ) {
        fail("MODEL_OUTPUT_INVALID", `rights ${request.rightsId} is invented or out of scope`);
      }
      validateFreshWindow({
        observedAt: evidence.observedAt,
        expiresAt: evidence.expiresAt,
        now: input.now,
        maximumAgeMs: 300_000
      });
    }
    const evidenceDigests = {
      claimDigest: digest({ claims: input.resolved.claims }),
      rightsDigest: digest({ rights: input.resolved.rights })
    };
    const authorityEvidence = input.resolved.authority;
    if (
      authorityEvidence.purpose !== "domain-claims-rights-authority" ||
      authorityEvidence.authorityDigest !== input.authority.digest ||
      authorityEvidence.artifactSetDigest !== input.artifactSetDigest ||
      !Number.isSafeInteger(authorityEvidence.revision) ||
      authorityEvidence.revision < 1 ||
      !DIGEST_PATTERN.test(authorityEvidence.authorityHeadDigest) ||
      authorityEvidence.claimEvidenceSetDigest !== evidenceDigests.claimDigest ||
      authorityEvidence.rightsEvidenceSetDigest !== evidenceDigests.rightsDigest ||
      authorityEvidence.revoked !== false ||
      !input.verifier.verify(
        unsigned(authorityEvidence),
        authorityEvidence.signature,
        "domain-claims-rights-authority"
      )
    ) {
      fail("MODEL_OUTPUT_INVALID", "claim and rights authority evidence is invalid");
    }
    validateFreshWindow({
      observedAt: authorityEvidence.observedAt,
      expiresAt: authorityEvidence.expiresAt,
      now: input.now,
      maximumAgeMs: 300_000
    });
    return evidenceDigests;
}

export async function runDomainPackDemonstration(input: {
  readonly definition: DomainPackDefinition;
  readonly policyContext: DomainPolicyContext;
  readonly repositoryId: number;
  readonly workItemId: string;
  readonly expectedHeadSha: string;
  readonly expectedBaseSha: string;
  readonly requesterId: number;
  readonly automationActorId: number;
  readonly roleBindings: readonly DomainRoleBinding[];
  readonly classification: "internal" | "confidential" | "restricted";
  readonly clock: DomainPackClock;
  readonly verifier: DomainEvidenceVerifier;
  readonly redeemer: DomainOperationRedeemer;
  readonly ledger: DomainEvidenceLedger;
  readonly model: DomainPackModel;
  readonly reviewer: DomainPackReviewer;
  readonly sourceEvidence: readonly DomainSourceEvidence[];
  readonly dlp: DomainDlpService;
  readonly threat: DomainPromptThreatService;
  readonly artifactPolicy: DomainArtifactPolicyService;
  readonly claimsRights: DomainClaimsRightsResolver;
  readonly claimsRightsAuthority: DomainClaimsRightsAuthorityCas;
  readonly humanGates: DomainHumanGateProvider;
  readonly github: DomainGitHubPackager;
}): Promise<DomainPackDemonstrationResult> {
  const definition = validateDomainPackDefinition(input.definition);
  const policyContext = immutableSnapshot(input.policyContext);
  const sourceEvidence = immutableSnapshot(input.sourceEvidence);
  const signedRoleBindings = immutableSnapshot(input.roleBindings);
  const authority = compileDomainRuntimeAuthority({
    definition,
    policyContext
  });
  const repositoryIdentity = validateRepositoryIdentity({
    repositoryId: policyContext.accord.binding.repositoryId,
    repositoryNodeId: policyContext.accord.binding.repositoryNodeId,
    repositoryFullName: policyContext.accord.binding.repositoryFullName,
    repositoryRootId: policyContext.accord.binding.repositoryRootId,
    workItemId: policyContext.accord.binding.workItemNodeId,
    defaultRef: policyContext.accord.binding.defaultRef,
    proposalRef: policyContext.accord.binding.proposalRef
  });
  const repositoryIdentityDigest = digest(repositoryIdentity);
  if (!definition.riskPrivacy.allowedClassifications.includes(input.classification)) {
    fail("PACKAGE_INVALID", "requested classification exceeds the pack policy");
  }
  if (
    policyContext.accord.binding.repositoryId !== input.repositoryId ||
    policyContext.accord.binding.workItemNodeId !== input.workItemId ||
    policyContext.accord.binding.sourceDigest !==
      sourceEvidence[0]?.sourceDigest
  ) {
    fail("PACKAGE_INVALID", "Work Accord repository or source binding is substituted");
  }
  const accordExpiresAt = timestamp(
    policyContext.accord.budget.expiresAt,
    "Work Accord expiresAt"
  );
  if (timestamp(input.clock.now(), "now") >= accordExpiresAt) {
    fail("GRANT_INVALID", "Work Accord is expired");
  }
  const currentBinding = await input.github.readCurrentBinding(repositoryIdentity);
  if (
    currentBinding.repositoryId !== repositoryIdentity.repositoryId ||
    currentBinding.repositoryNodeId !== repositoryIdentity.repositoryNodeId ||
    currentBinding.repositoryFullName !== repositoryIdentity.repositoryFullName ||
    currentBinding.repositoryRootId !== repositoryIdentity.repositoryRootId ||
    currentBinding.workItemId !== repositoryIdentity.workItemId ||
    currentBinding.defaultRef !== repositoryIdentity.defaultRef ||
    currentBinding.proposalRef !== repositoryIdentity.proposalRef ||
    currentBinding.headSha !== input.expectedHeadSha ||
    currentBinding.baseSha !== input.expectedBaseSha
  ) {
    fail("HEAD_STALE", "trusted repository base or head changed before execution");
  }
  const currentHead = currentBinding.headSha;
  const startedAt = timestamp(input.clock.now(), "now");
  const sourceDigests = validateSourceEvidence({
    evidence: sourceEvidence,
    definition,
    authority,
    classification: input.classification,
    authorityExpiresAt: policyContext.accord.budget.expiresAt,
    now: input.clock.now(),
    verifier: input.verifier
  });
  const roleBindings = validateRoleBindings({
    bindings: signedRoleBindings,
    definition,
    authority,
    workAccordDigest: authority.workAccordDigest,
    repositoryId: input.repositoryId,
    workItemId: input.workItemId,
    repositoryIdentityDigest,
    headSha: currentHead,
    requesterId: input.requesterId,
    automationActorId: input.automationActorId,
    now: input.clock.now(),
    authorityExpiresAt: policyContext.accord.budget.expiresAt,
    verifier: input.verifier
  });
  const kernelAuthorization = await input.redeemer.authorizeKernel({
    authority,
    repositoryId: input.repositoryId,
    workItemId: input.workItemId,
    repositoryIdentityDigest,
    baseSha: currentBinding.baseSha,
    headSha: currentHead,
    roleBindingSetDigest: digest(signedRoleBindings),
    sourceEvidenceSetDigest: digest(sourceEvidence)
  });
  validateKernelAuthorization({
    authorization: kernelAuthorization,
    authority,
    repositoryId: input.repositoryId,
    workItemId: input.workItemId,
    repositoryIdentityDigest,
    baseSha: currentBinding.baseSha,
    headSha: currentHead,
    roleBindingSetDigest: digest(signedRoleBindings),
    sourceEvidenceSetDigest: digest(sourceEvidence),
    now: input.clock.now(),
    verifier: input.verifier
  });
  if (
    timestamp(kernelAuthorization.expiresAt, "Kernel authorization expiresAt") >
    accordExpiresAt
  ) {
    fail("GRANT_INVALID", "Kernel authorization outlives its Work Accord");
  }
  await input.ledger.append({
    type: "kernel-authorized",
    packId: definition.id,
    subjectDigest: digest(kernelAuthorization),
    observedAt: input.clock.now()
  });

  const slots = definition.slots.map((slot) => slot.id);
  const maxPatchBytes = Math.min(
    definition.limits.maxPatchBytes,
    policyContext.accord.budget.maxPatchBytes
  );
  const executionResolution = resolveCapability(
    policyContext.registry,
    definition.capabilityBindings.execution,
    "execution"
  );
  const reviewResolution = resolveCapability(
    policyContext.registry,
    definition.capabilityBindings.verification,
    "verification"
  );
  if (!executionResolution.ok || !reviewResolution.ok) {
    fail("GRANT_INVALID", "compiled model capability is unavailable");
  }
  const modelInputValidator = ajv.compile(executionResolution.capability.inputSchema);
  const modelOutputValidator = ajv.compile(executionResolution.capability.outputSchema);
  const reviewInputValidator = ajv.compile(reviewResolution.capability.inputSchema);
  const reviewOutputValidator = ajv.compile(reviewResolution.capability.outputSchema);
  const maximums = {
    calls: Math.min(
      policyContext.accord.budget.maxCalls,
      policyContext.domainPack.maxCalls,
      policyContext.enterprise.ceilings.maxCalls
    ),
    tokens: Math.min(
      policyContext.accord.budget.maxTokens,
      definition.limits.maxTokens
    ),
    costUnits: Math.min(
      policyContext.accord.budget.maxCostUnits,
      policyContext.domainPack.maxCostUnits,
      policyContext.enterprise.ceilings.maxCostUnits
    ),
    loops: Math.min(
      policyContext.accord.budget.maxLoops,
      policyContext.domainPack.maxLoops,
      policyContext.enterprise.ceilings.maxLoops
    ),
    retries: Math.min(
      policyContext.accord.budget.maxRetries,
      policyContext.domainPack.maxRetries,
      policyContext.enterprise.ceilings.maxRetries
    ),
    durationMs: Math.min(
      policyContext.accord.budget.maxDurationMs,
      definition.limits.maxDurationMs
    )
  };
  let usage = { calls: 0, tokens: 0, costUnits: 0, loops: 0, retries: 0, durationMs: 0 };
  const capabilityUsage = new Map<
    string,
    { calls: number; costUnits: number; retries: number; durationMs: number }
  >();
  let operationSequence = 0;
  let effectHead = currentHead;
  const operationGrants: DomainOperationGrant[] = [];
  const usedRedemptions = new Set<string>();
  const preModelDlp: DomainDlpEvidence[] = [];
  const ensureAuthoritySnapshot = (): void => {
    const current = compileDomainRuntimeAuthority({ definition, policyContext });
    if (current.digest !== authority.digest) {
      fail("GRANT_INVALID", "compiled domain authority changed during execution");
    }
  };
  const ensureCurrentSources = (): void => {
    const currentSourceDigests = validateSourceEvidence({
      evidence: sourceEvidence,
      definition,
      authority,
      classification: input.classification,
      authorityExpiresAt: policyContext.accord.budget.expiresAt,
      now: input.clock.now(),
      verifier: input.verifier
    });
    if (!equalStrings(currentSourceDigests, sourceDigests)) {
      fail("PACKAGE_INVALID", "source evidence changed during execution");
    }
  };
  const ensureCurrentAuthority = (): void => {
    ensureAuthoritySnapshot();
    const now = input.clock.now();
    if (timestamp(now, "now") >= accordExpiresAt) {
      fail("GRANT_INVALID", "Work Accord expired during execution");
    }
    validateKernelAuthorization({
      authorization: kernelAuthorization,
      authority,
      repositoryId: input.repositoryId,
      workItemId: input.workItemId,
      repositoryIdentityDigest,
      baseSha: currentBinding.baseSha,
      headSha: currentHead,
      roleBindingSetDigest: digest(signedRoleBindings),
      sourceEvidenceSetDigest: digest(sourceEvidence),
      now,
      verifier: input.verifier
    });
  };
  const authorizeOperation = async (
    operation: DomainAuthorizedOperation,
    capability: string | null,
    request: unknown,
    reservation: {
      readonly tokens: number;
      readonly costUnits: number;
    } = { tokens: 0, costUnits: 0 }
  ): Promise<DomainOperationGrant> => {
    ensureCurrentAuthority();
    if (
      !Number.isSafeInteger(reservation.tokens) ||
      reservation.tokens < 0 ||
      !Number.isSafeInteger(reservation.costUnits) ||
      reservation.costUnits < 0 ||
      (capability === null &&
        (reservation.tokens !== 0 || reservation.costUnits !== 0))
    ) {
      fail("GRANT_INVALID", "operation requested an invalid provider reservation");
    }
    const boundContextDigest = domainOperationRequestDigest(operation, request);
    let compiledCapability:
      | CompiledPolicy["capabilities"][number]
      | undefined;
    let capabilityKey: string | undefined;
    if (capability !== null) {
      const phase = operation === "model-create" ? "execution" : "verification";
      compiledCapability = authority.compiledPolicies[phase].capabilities.find(
        (candidate) => candidate.reference === capability
      );
      capabilityKey = `${phase}:${capability}`;
      const prior = capabilityUsage.get(capabilityKey) ?? {
        calls: 0,
        costUnits: 0,
        retries: 0,
        durationMs: 0
      };
      if (
        compiledCapability === undefined ||
        prior.calls + 1 > compiledCapability.limits.maxCalls ||
        prior.calls + 1 > authority.compiledPolicies[phase].limits.maxCalls
      ) {
        fail("GRANT_INVALID", "compiled phase or capability call budget is exhausted");
      }
    }
    operationSequence += 1;
    const grant = await input.redeemer.redeem({
      authority,
      kernelAuthorization,
      operation,
      capability,
      sequence: operationSequence,
      runId: kernelAuthorization.runId,
      runAttempt: kernelAuthorization.runAttempt,
      contextDigest: boundContextDigest,
      usage,
      requestedTokens: reservation.tokens,
      requestedCostUnits: reservation.costUnits,
      repositoryId: input.repositoryId,
      workItemId: input.workItemId,
      repositoryIdentityDigest,
      headSha: effectHead
    });
    if (
      grant.purpose !== "domain-operation" ||
      grant.authorityDigest !== authority.digest ||
      grant.kernelAuthorizationDigest !== digest(kernelAuthorization) ||
      grant.operation !== operation ||
      grant.capability !== capability ||
      grant.sequence !== operationSequence ||
      grant.runId !== kernelAuthorization.runId ||
      grant.runAttempt !== kernelAuthorization.runAttempt ||
      grant.contextDigest !== boundContextDigest ||
      grant.repositoryId !== input.repositoryId ||
      grant.workItemId !== input.workItemId ||
      grant.repositoryIdentityDigest !== repositoryIdentityDigest ||
      grant.headSha !== effectHead ||
      grant.roleBindingSetDigest !== digest(signedRoleBindings) ||
      grant.sourceEvidenceSetDigest !== digest(sourceEvidence) ||
      grant.leaseDigest !== kernelAuthorization.leaseDigest ||
      grant.threatAssessmentDigest !==
        kernelAuthorization.threatAssessmentDigest ||
      grant.threatStatus !== "success" ||
      grant.policyCurrent !== true ||
      grant.headCurrent !== true ||
      grant.stateRevoked !== false ||
      grant.leaseRevoked !== false ||
      grant.casResult !== "appended" ||
      canonicalJson(grant.cumulativeUsage) !== canonicalJson(usage) ||
      !Number.isSafeInteger(grant.reservedTokens) ||
      grant.reservedTokens < 0 ||
      grant.reservedTokens !== reservation.tokens ||
      grant.reservedTokens > maximums.tokens - usage.tokens ||
      !Number.isSafeInteger(grant.reservedCostUnits) ||
      grant.reservedCostUnits < 0 ||
      grant.reservedCostUnits !== reservation.costUnits ||
      grant.reservedCostUnits > maximums.costUnits - usage.costUnits ||
      timestamp(grant.expiresAt, "operation grant expiresAt") >
        Math.min(
          accordExpiresAt,
          timestamp(kernelAuthorization.expiresAt, "Kernel authorization expiresAt")
        ) ||
      (capability === null &&
        (reservation.tokens !== 0 || reservation.costUnits !== 0)) ||
      grant.nonce.length < 16 ||
      grant.redemptionKey !==
        digest({
          authorityDigest: authority.digest,
          kernelAuthorizationDigest: digest(kernelAuthorization),
          repositoryIdentityDigest,
          runId: kernelAuthorization.runId,
          runAttempt: kernelAuthorization.runAttempt,
          sequence: operationSequence,
          operation,
          capability,
          contextDigest: boundContextDigest
        }) ||
      usedRedemptions.has(grant.nonce) ||
      usedRedemptions.has(grant.redemptionKey) ||
      !input.verifier.verify(
        unsigned(grant),
        grant.signature,
        "domain-operation"
      )
    ) {
      fail("GRANT_INVALID", "operation authorization is stale, replayed, or substituted");
    }
    if (
      capability !== null &&
      compiledCapability !== undefined &&
      capabilityKey !== undefined
    ) {
      const phase = operation === "model-create" ? "execution" : "verification";
      const resolution = resolveCapability(
        policyContext.registry,
        capability,
        phase
      );
      const prior = capabilityUsage.get(capabilityKey) ?? {
        calls: 0,
        costUnits: 0,
        retries: 0,
        durationMs: 0
      };
      if (
        !resolution.ok ||
        (resolution.capability.limits.maxCostUnits === 0 &&
        compiledCapability.limits.maxCostUnits === 0
          ? grant.reservedCostUnits !== 0
          : grant.reservedCostUnits < 1) ||
        grant.reservedCostUnits >
          compiledCapability.limits.maxCostUnits - prior.costUnits ||
        grant.reservedCostUnits >
          authority.compiledPolicies[phase].limits.maxCostUnits - prior.costUnits
      ) {
        fail("GRANT_INVALID", "operation reservation exceeds its capability");
      }
    }
    validateFreshWindow({
      observedAt: grant.checkedAt,
      expiresAt: grant.expiresAt,
      now: input.clock.now(),
      maximumAgeMs: 300_000
    });
    usedRedemptions.add(grant.nonce);
    usedRedemptions.add(grant.redemptionKey);
    operationGrants.push(grant);
    await input.ledger.append({
      type: "operation-redeemed",
      packId: definition.id,
      subjectDigest: digest(grant),
      observedAt: input.clock.now()
    });
    validateFreshWindow({
      observedAt: grant.checkedAt,
      expiresAt: grant.expiresAt,
      now: input.clock.now(),
      maximumAgeMs: 300_000
    });
    return grant;
  };
  const applyUsage = (
    actual: DomainUsage,
    grant: DomainOperationGrant,
    capability: Capability,
    phase: "execution" | "verification"
  ): void => {
    const capabilityKey = `${phase}:${grant.capability}`;
    const compiledCapability = authority.compiledPolicies[
      phase
    ].capabilities.find((candidate) => candidate.reference === grant.capability);
    const prior = capabilityUsage.get(capabilityKey) ?? {
      calls: 0,
      costUnits: 0,
      retries: 0,
      durationMs: 0
    };
    if (
      compiledCapability === undefined ||
      !Object.values(actual).every(
        (value) => Number.isSafeInteger(value) && value >= 0
      ) ||
      actual.tokens > grant.reservedTokens ||
      actual.costUnits > grant.reservedCostUnits ||
      actual.retries > compiledCapability.limits.maxRetries ||
      actual.retries > capability.limits.maxRetries ||
      actual.durationMs > capability.limits.timeoutMs
    ) {
      fail("GRANT_INVALID", "model usage exceeds its authorized reservation");
    }
    const nextCapabilityUsage = {
      calls: prior.calls + 1,
      costUnits: prior.costUnits + actual.costUnits,
      retries: prior.retries + actual.retries,
      durationMs: prior.durationMs + actual.durationMs
    };
    if (
      nextCapabilityUsage.calls > compiledCapability.limits.maxCalls ||
      nextCapabilityUsage.calls >
        authority.compiledPolicies[phase].limits.maxCalls ||
      nextCapabilityUsage.costUnits >
        compiledCapability.limits.maxCostUnits ||
      nextCapabilityUsage.costUnits >
        authority.compiledPolicies[phase].limits.maxCostUnits ||
      nextCapabilityUsage.retries > compiledCapability.limits.maxRetries
    ) {
      fail("GRANT_INVALID", "compiled phase or capability budget is exhausted");
    }
    capabilityUsage.set(capabilityKey, nextCapabilityUsage);
    usage = {
      calls: usage.calls + 1,
      tokens: usage.tokens + actual.tokens,
      costUnits: usage.costUnits + actual.costUnits,
      loops: usage.loops,
      retries: usage.retries + actual.retries,
      durationMs: usage.durationMs + actual.durationMs
    };
    if (
      usage.calls > maximums.calls ||
      usage.tokens > maximums.tokens ||
      usage.costUnits > maximums.costUnits ||
      usage.loops > maximums.loops ||
      usage.retries > maximums.retries ||
      usage.durationMs > maximums.durationMs ||
      timestamp(input.clock.now(), "now") - startedAt > maximums.durationMs
    ) {
      fail("GRANT_INVALID", "compiled cumulative runtime budget is exhausted");
    }
  };
  const classifyBeforeModel = async (values: unknown): Promise<void> => {
    ensureCurrentAuthority();
    ensureCurrentSources();
    const evidence = await input.dlp.classify({
      stage: "pre-model",
      authorityDigest: authority.digest,
      artifactSetDigest: null,
      sourceDigests,
      values
    });
    validateDlpEvidence({
      evidence,
      stage: "pre-model",
      authority,
      artifactSetDigest: null,
      sourceDigests,
      values,
      now: input.clock.now(),
      verifier: input.verifier
    });
    preModelDlp.push(evidence);
    await input.ledger.append({
      type: "dlp-validated",
      packId: definition.id,
      subjectDigest: digest(evidence),
      observedAt: input.clock.now()
    });
  };
  const callDeadline = (
    capability: Capability,
    grant: DomainOperationGrant
  ): number => {
    const now = timestamp(input.clock.now(), "now");
    const elapsed = now - startedAt;
    const remaining = maximums.durationMs - elapsed;
    const grantRemaining = timestamp(grant.expiresAt, "grant expiresAt") - now;
    const authorityRemaining =
      timestamp(kernelAuthorization.expiresAt, "kernel expiresAt") - now;
    const timeoutMs = Math.min(
      capability.limits.timeoutMs,
      remaining,
      grantRemaining,
      authorityRemaining
    );
    if (timeoutMs <= 0) {
      fail("GRANT_INVALID", "compiled runtime deadline is exhausted");
    }
    return timeoutMs;
  };
  const providerAdmission = (
    payload: unknown,
    capability: Capability,
    phase: "execution" | "verification"
  ): DomainProviderAdmission => {
    const inputBytes = Buffer.byteLength(canonicalJson(payload), "utf8");
    const inputTokenUpperEstimate = inputBytes;
    const requestedTokenReservation = maximums.tokens - usage.tokens;
    const capabilityKey = `${phase}:${capability.id}@${capability.version}`;
    const prior = capabilityUsage.get(capabilityKey) ?? {
      calls: 0,
      costUnits: 0,
      retries: 0,
      durationMs: 0
    };
    const compiledCapability = authority.compiledPolicies[
      phase
    ].capabilities.find(
      (candidate) => candidate.reference === `${capability.id}@${capability.version}`
    );
    if (compiledCapability === undefined) {
      fail("GRANT_INVALID", "provider capability is not in compiled authority");
    }
    const requestedCostReservation = Math.min(
      maximums.costUnits - usage.costUnits,
      capability.limits.maxCostUnits - prior.costUnits,
      compiledCapability.limits.maxCostUnits - prior.costUnits
    );
    const zeroCostCapability =
      capability.limits.maxCostUnits === 0 &&
      compiledCapability.limits.maxCostUnits === 0;
    const reservedOutputTokens =
      requestedTokenReservation - inputTokenUpperEstimate;
    const maxOutputBytes = Math.min(
      capability.limits.maxOutputBytes,
      reservedOutputTokens
    );
    if (
      inputBytes < 1 ||
      requestedTokenReservation < 1 ||
      (zeroCostCapability
        ? requestedCostReservation !== 0
        : requestedCostReservation < 1) ||
      reservedOutputTokens < 1 ||
      maxOutputBytes < 1
    ) {
      fail(
        "GRANT_INVALID",
        `provider input exceeds the remaining token reservation (${inputBytes} input bytes, ${requestedTokenReservation} reserved tokens)`
      );
    }
    return {
      requestDigest: digest(payload),
      inputBytes,
      inputTokenUpperEstimate,
      reservedOutputTokens,
      maxOutputBytes,
      requestedTokenReservation,
      requestedCostReservation
    };
  };
  const recordUnknownModelUsage = async (
    grant: DomainOperationGrant,
    admission: DomainProviderAdmission,
    error: unknown
  ): Promise<never> => {
    await input.ledger.append({
      type: "model-usage-unavailable",
      packId: definition.id,
      subjectDigest: digest({
        grantDigest: digest(grant),
        admissionDigest: digest(admission),
        heldTokens: grant.reservedTokens,
        heldCostUnits: grant.reservedCostUnits,
        cumulativeUsage: grant.cumulativeUsage,
        disposition: "full-reservation-held",
        reason:
          error instanceof DomainPackError ? error.code : "provider-error"
      }),
      observedAt: input.clock.now()
    });
    throw error;
  };
  const authenticatedProviderUsage = (subject: {
    readonly operation: "model-create" | "model-review";
    readonly grant: DomainOperationGrant;
    readonly admission: DomainProviderAdmission;
    readonly output: unknown;
    readonly receipt: DomainProviderUsageReceipt;
  }): DomainUsage => {
    const outputBytes = Buffer.byteLength(canonicalJson(subject.output), "utf8");
    const minimumInputCharge = Math.max(
      1,
      Math.ceil(subject.admission.inputBytes / 4)
    );
    const minimumOutputCharge = Math.max(1, Math.ceil(outputBytes / 4));
    const receipt = subject.receipt;
    const invalid = [
      outputBytes < 1 || outputBytes > subject.admission.maxOutputBytes
        ? "output-bytes"
        : null,
      minimumOutputCharge > subject.admission.reservedOutputTokens
        ? "output-reservation"
        : null,
      receipt.purpose !== "domain-provider-usage" ? "purpose" : null,
      receipt.operation !== subject.operation ? "operation" : null,
      receipt.authorityDigest !== authority.digest ? "authority" : null,
      receipt.grantDigest !== digest(subject.grant) ? "grant" : null,
      receipt.requestDigest !== subject.admission.requestDigest ? "request" : null,
      receipt.admissionDigest !== digest(subject.admission) ? "admission" : null,
      receipt.responseDigest !== digest(subject.output) ? "response" : null,
      receipt.inputBytes !== subject.admission.inputBytes ? "input-bytes" : null,
      receipt.outputBytes !== outputBytes ? "reported-output-bytes" : null,
      !Number.isSafeInteger(receipt.chargedInputTokens) ||
      receipt.chargedInputTokens < minimumInputCharge ||
      receipt.chargedInputTokens >
        subject.admission.inputTokenUpperEstimate
        ? "input-tokens"
        : null,
      !Number.isSafeInteger(receipt.chargedOutputTokens) ||
      receipt.chargedOutputTokens < minimumOutputCharge ||
      receipt.chargedOutputTokens >
        subject.admission.reservedOutputTokens
        ? "output-tokens"
        : null,
      !Number.isSafeInteger(receipt.costUnits) || receipt.costUnits < 0
        ? "cost"
        : null,
      !Number.isSafeInteger(receipt.durationMs) || receipt.durationMs < 0
        ? "duration"
        : null,
      !Number.isSafeInteger(receipt.retries) || receipt.retries < 0
        ? "retries"
        : null,
      receipt.status !== "settled" ? "status" : null,
      timestamp(receipt.observedAt, "provider usage observedAt") <
      timestamp(subject.grant.checkedAt, "operation grant checkedAt")
        ? "issued-before-grant"
        : null,
      timestamp(receipt.observedAt, "provider usage observedAt") >
      timestamp(input.clock.now(), "now")
        ? "future"
        : null,
      timestamp(receipt.observedAt, "provider usage observedAt") >=
      timestamp(subject.grant.expiresAt, "operation grant expiresAt")
        ? "expired"
        : null,
      !input.verifier.verify(
        unsigned(receipt),
        receipt.signature,
        "domain-provider-usage"
      )
        ? "signature"
        : null
    ].filter((value): value is string => value !== null);
    if (invalid.length !== 0) {
      fail(
        "GRANT_INVALID",
        `provider usage receipt is missing, forged, or underreported: ${invalid.join(",")} (${outputBytes}/${subject.admission.maxOutputBytes} bytes)`
      );
    }
    return {
      tokens:
        receipt.chargedInputTokens + receipt.chargedOutputTokens,
      costUnits: receipt.costUnits,
      durationMs: receipt.durationMs,
      retries: receipt.retries
    };
  };
  const createOutput = async (
    revision: number,
    prior: TargetFreeDomainOutput | null,
    reviewFindings: readonly string[]
  ): Promise<TargetFreeDomainOutput> => {
    const modelPayload = {
      evidence: sourceDigests,
      targetSlots: slots,
      maxPatchBytes,
      revision,
      priorOutputDigest:
        prior === null
          ? ("sha256:0000000000000000000000000000000000000000000000000000000000000000" as Digest)
          : digest(prior),
      priorChanges: prior?.changes ?? [],
      reviewFindings
    };
    if (!modelInputValidator(modelPayload)) {
      fail("GRANT_INVALID", "model input does not match the registered capability");
    }
    const dlpValues = {
      sources: sourceEvidence.map((record) => record.content),
      payload: modelPayload
    };
    await classifyBeforeModel(dlpValues);
    const admission = providerAdmission(
      modelPayload,
      executionResolution.capability,
      "execution"
    );
    const modelRequest = { repositoryIdentity, payload: modelPayload, admission };
    const grant = await authorizeOperation(
      "model-create",
      definition.capabilityBindings.execution,
      modelRequest,
      {
        tokens: admission.requestedTokenReservation,
        costUnits: admission.requestedCostReservation
      }
    );
    ensureCurrentSources();
    validateDomainOperationRequest(grant, "model-create", modelRequest);
    const response = await invokeWithDeadline(
      callDeadline(executionResolution.capability, grant),
      (signal) =>
        input.model.create({
          authorization: grant,
          repositoryIdentity,
          signal,
          admission,
          payload: modelPayload
        })
    ).catch((error: unknown) =>
      recordUnknownModelUsage(grant, admission, error)
    );
    let actualUsage: DomainUsage;
    try {
      actualUsage = authenticatedProviderUsage({
        operation: "model-create",
        grant,
        admission,
        output: response.output,
        receipt: response.usageReceipt
      });
      applyUsage(
        actualUsage,
        grant,
        executionResolution.capability,
        "execution"
      );
    } catch (error) {
      return await recordUnknownModelUsage(grant, admission, error);
    }
    if (
      Buffer.byteLength(canonicalJson(response.output), "utf8") >
      admission.maxOutputBytes
    ) {
      fail("MODEL_OUTPUT_INVALID", "model output exceeds its compiled byte ceiling");
    }
    if (!modelOutputValidator(response.output)) {
      fail("MODEL_OUTPUT_INVALID", "model output violates the registered capability");
    }
    ensureCurrentSources();
    const output = validateTargetFreeDomainOutput(
      definition,
      response.output,
      maxPatchBytes
    );
    if (output.result !== "drafted") {
      fail("MODEL_OUTPUT_INVALID", `model refused safely: ${output.reasonCode}`);
    }
    return output;
  };

  let output = await createOutput(0, null, []);
  const reviewHistory: DomainReviewOutput[] = [];
  const reviewThreatAssessments: DomainPromptThreatAssessment[] = [];
  const artifactPolicyAssessments: DomainArtifactPolicyAssessment[] = [];
  let revisionCount = 0;
  for (;;) {
    const candidateArtifacts = mapTargetFreeDomainOutput({
      definition,
      repositoryId: input.repositoryId,
      workItemId: input.workItemId,
      headSha: currentHead,
      output,
      sourceEvidence,
      classification: input.classification,
      now: input.clock.now()
    });
    const candidateArtifactSetDigest = computeArtifactSetDigest({
      packId: definition.id,
      repositoryId: input.repositoryId,
      workItemId: input.workItemId,
      classification: input.classification,
      authorityDigest: authority.digest,
      approvedSourceDigests: sourceDigests,
      artifacts: candidateArtifacts
    });
    const artifactPolicyValues = immutableSnapshot({
      artifacts: candidateArtifacts,
      repositoryOnly: true,
      simulationOnly: definition.id === "business-operations",
      prohibitedEffects: definition.prohibitedEffects
    });
    const artifactPolicyAssessment = await input.artifactPolicy.assess({
      packId: definition.id,
      authorityDigest: authority.digest,
      artifactSetDigest: candidateArtifactSetDigest,
      prohibitedEffects: definition.prohibitedEffects,
      values: artifactPolicyValues
    });
    validateArtifactPolicyAssessment({
      evidence: artifactPolicyAssessment,
      authority,
      packId: definition.id,
      artifactSetDigest: candidateArtifactSetDigest,
      prohibitedEffects: definition.prohibitedEffects,
      values: artifactPolicyValues,
      now: input.clock.now(),
      verifier: input.verifier
    });
    artifactPolicyAssessments.push(artifactPolicyAssessment);
    await classifyBeforeModel({
      sources: sourceEvidence.map((record) => record.content),
      rubric: definition.reviewRubric,
      output
    });
    const reviewPayload = {
      evidence: [
        digest(output),
        authority.reviewRubricDigest,
        digest(artifactPolicyAssessment)
      ],
      targetSlots: slots,
      maxPatchBytes,
      artifactContents: output.changes.map((change) => ({
        slot: change.slot,
        content: change.content
      }))
    };
    if (!reviewInputValidator(reviewPayload)) {
      fail("REVIEW_INVALID", "review input does not match the registered capability");
    }
    const reviewPayloadDigest = digest(reviewPayload);
    const threatAssessment = await input.threat.assess({
      authorityDigest: authority.digest,
      reviewPayloadDigest,
      artifactBundleDigest: candidateArtifactSetDigest,
      values: reviewPayload
    });
    validatePromptThreatAssessment({
      evidence: threatAssessment,
      authority,
      reviewPayloadDigest,
      artifactBundleDigest: candidateArtifactSetDigest,
      now: input.clock.now(),
      verifier: input.verifier
    });
    reviewThreatAssessments.push(threatAssessment);
    const admission = providerAdmission(
      reviewPayload,
      reviewResolution.capability,
      "verification"
    );
    const reviewRequest = {
      repositoryIdentity,
      payload: reviewPayload,
      threatAssessment,
      admission
    };
    const reviewGrant = await authorizeOperation(
      "model-review",
      definition.capabilityBindings.verification,
      reviewRequest,
      {
        tokens: admission.requestedTokenReservation,
        costUnits: admission.requestedCostReservation
      }
    );
    ensureCurrentSources();
    validateDomainOperationRequest(reviewGrant, "model-review", reviewRequest);
    validateArtifactPolicyAssessment({
      evidence: artifactPolicyAssessment,
      authority,
      packId: definition.id,
      artifactSetDigest: candidateArtifactSetDigest,
      prohibitedEffects: definition.prohibitedEffects,
      values: artifactPolicyValues,
      now: input.clock.now(),
      verifier: input.verifier
    });
    const reviewed = await invokeWithDeadline(
      callDeadline(reviewResolution.capability, reviewGrant),
      (signal) =>
        input.reviewer.review({
          authorization: reviewGrant,
          repositoryIdentity,
          signal,
          admission,
          threatAssessment,
          payload: reviewPayload
        })
    ).catch((error: unknown) =>
      recordUnknownModelUsage(reviewGrant, admission, error)
    );
    ensureCurrentSources();
    try {
      applyUsage(
        authenticatedProviderUsage({
          operation: "model-review",
          grant: reviewGrant,
          admission,
          output: reviewed.output,
          receipt: reviewed.usageReceipt
        }),
        reviewGrant,
        reviewResolution.capability,
        "verification"
      );
    } catch (error) {
      return await recordUnknownModelUsage(reviewGrant, admission, error);
    }
    if (!reviewOutputValidator(reviewed.output)) {
      fail("REVIEW_INVALID", "review output violates the registered capability");
    }
    if (
      Buffer.byteLength(canonicalJson(reviewed.output), "utf8") >
        admission.maxOutputBytes ||
      reviewed.output.summary.length === 0 ||
      reviewed.output.summary.length > 8_000 ||
      reviewed.output.findings.length > 100 ||
      reviewed.output.openQuestions.length > 20 ||
      [...reviewed.output.findings, ...reviewed.output.openQuestions].some(
        (value) => value.length === 0 || value.length > 8_192
      )
    ) {
      fail("REVIEW_INVALID", "review output exceeds its compiled bounds");
    }
    const review: DomainReviewOutput = {
      result: reviewed.output.findings.length === 0 ? "ready" : "revise",
      findings: reviewed.output.findings
    };
    if (
      (review.result !== "revise" && review.result !== "ready") ||
      review.findings.some((finding) => finding.length === 0)
    ) {
      fail("REVIEW_INVALID", "review output is malformed");
    }
    reviewHistory.push(review);
    await input.ledger.append({
      type: revisionCount === 0 ? "draft-reviewed" : "revision-reviewed",
      packId: definition.id,
      subjectDigest: digest(review),
      observedAt: input.clock.now()
    });
    if (review.result === "ready") break;
    if (
      revisionCount >= definition.maxRevisionLoops ||
      revisionCount >= maximums.loops
    ) {
      fail("REVIEW_INVALID", "domain review exceeded the bounded revision loops");
    }
    revisionCount += 1;
    usage = { ...usage, loops: revisionCount };
    const prior = output;
    output = await createOutput(revisionCount, prior, review.findings);
  }

  const artifacts = mapTargetFreeDomainOutput({
    definition,
    repositoryId: input.repositoryId,
    workItemId: input.workItemId,
    headSha: currentHead,
    output,
    sourceEvidence,
    classification: input.classification,
    now: input.clock.now()
  });
  const artifactSetDigest = computeArtifactSetDigest({
    packId: definition.id,
    repositoryId: input.repositoryId,
    workItemId: input.workItemId,
    classification: input.classification,
    authorityDigest: authority.digest,
    approvedSourceDigests: sourceDigests,
    artifacts
  });
  const finalThreatAssessment = reviewThreatAssessments.at(-1);
  const finalArtifactPolicyAssessment = artifactPolicyAssessments.at(-1);
  if (
    finalThreatAssessment === undefined ||
    finalArtifactPolicyAssessment === undefined
  ) {
    fail("REVIEW_INVALID", "final review has incomplete independent assessments");
  }
  validatePromptThreatAssessment({
    evidence: finalThreatAssessment,
    authority,
    reviewPayloadDigest: finalThreatAssessment.reviewPayloadDigest,
    artifactBundleDigest: artifactSetDigest,
    now: input.clock.now(),
    verifier: input.verifier
  });
  const artifactPolicyValues = immutableSnapshot({
    artifacts,
    repositoryOnly: true,
    simulationOnly: definition.id === "business-operations",
    prohibitedEffects: definition.prohibitedEffects
  });
  const ensureCurrentArtifactPolicy = (): void =>
    validateArtifactPolicyAssessment({
      evidence: finalArtifactPolicyAssessment,
      authority,
      packId: definition.id,
      artifactSetDigest,
      prohibitedEffects: definition.prohibitedEffects,
      values: artifactPolicyValues,
      now: input.clock.now(),
      verifier: input.verifier
    });
  ensureCurrentArtifactPolicy();
  const reviewDlpValues = { reviewHistory };
  const reviewDlp = await input.dlp.classify({
    stage: "pre-comment",
    authorityDigest: authority.digest,
    artifactSetDigest,
    sourceDigests,
    values: reviewDlpValues
  });
  validateDlpEvidence({
    evidence: reviewDlp,
    stage: "pre-comment",
    authority,
    artifactSetDigest,
    sourceDigests,
    values: reviewDlpValues,
    now: input.clock.now(),
    verifier: input.verifier
  });
  const packageDlpValues = artifacts;
  const packageDlp = await input.dlp.classify({
    stage: "pre-package",
    authorityDigest: authority.digest,
    artifactSetDigest,
    sourceDigests,
    values: packageDlpValues
  });
  validateDlpEvidence({
    evidence: packageDlp,
    stage: "pre-package",
    authority,
    artifactSetDigest,
    sourceDigests,
    values: packageDlpValues,
    now: input.clock.now(),
    verifier: input.verifier
  });
  const claimRightsRequests = extractClaimAndRightsRequests(definition, artifacts);
  const resolvedClaimsRights = await input.claimsRights.resolve({
    authorityDigest: authority.digest,
    artifactSetDigest,
    ...claimRightsRequests
  });
  const claimsRightsDigests = validateClaimsAndRights({
    requested: claimRightsRequests,
    resolved: resolvedClaimsRights,
    authority,
    artifactSetDigest,
    now: input.clock.now(),
    verifier: input.verifier
  });
  const claimsRightsExpiresAt = earliestExpiry([
    policyContext.accord.budget.expiresAt,
    resolvedClaimsRights.authority.expiresAt,
    ...resolvedClaimsRights.claims.map((evidence) => evidence.expiresAt),
    ...resolvedClaimsRights.rights.map((evidence) => evidence.expiresAt)
  ]);
  const claimsRightsAuthorityDigest = digest(resolvedClaimsRights.authority);
  const claimsRightsAuthorityRevision = resolvedClaimsRights.authority.revision;
  const claimsRightsAuthorityHeadDigest =
    resolvedClaimsRights.authority.authorityHeadDigest;
  const ensureCurrentClaimsRights = async (): Promise<void> => {
    const current = await input.claimsRights.resolve({
      authorityDigest: authority.digest,
      artifactSetDigest,
      ...claimRightsRequests
    });
    const currentDigests = validateClaimsAndRights({
      requested: claimRightsRequests,
      resolved: current,
      authority,
      artifactSetDigest,
      now: input.clock.now(),
      verifier: input.verifier
    });
    if (
      currentDigests.claimDigest !== claimsRightsDigests.claimDigest ||
      currentDigests.rightsDigest !== claimsRightsDigests.rightsDigest ||
      digest(current) !== digest(resolvedClaimsRights) ||
      earliestExpiry([
        policyContext.accord.budget.expiresAt,
        current.authority.expiresAt,
        ...current.claims.map((evidence) => evidence.expiresAt),
        ...current.rights.map((evidence) => evidence.expiresAt)
      ]) !== claimsRightsExpiresAt
    ) {
      fail("APPROVAL_INVALID", "claim or rights authority changed after packaging");
    }
  };
  await input.ledger.append({
    type: "claims-rights-validated",
    packId: definition.id,
    subjectDigest: digest(claimsRightsDigests),
    observedAt: input.clock.now()
  });
  if (
    canonicalJson(
      await input.github.readCurrentBinding(repositoryIdentity)
    ) !== canonicalJson(currentBinding)
  ) {
    fail("HEAD_STALE", "trusted repository head changed before packaging");
  }
  ensureCurrentAuthority();
  ensureCurrentSources();
  validatePromptThreatAssessment({
    evidence: finalThreatAssessment,
    authority,
    reviewPayloadDigest: finalThreatAssessment.reviewPayloadDigest,
    artifactBundleDigest: artifactSetDigest,
    now: input.clock.now(),
    verifier: input.verifier
  });
  ensureCurrentArtifactPolicy();
  validateDlpEvidence({
    evidence: packageDlp,
    stage: "pre-package",
    authority,
    artifactSetDigest,
    sourceDigests,
    values: packageDlpValues,
    now: input.clock.now(),
    verifier: input.verifier
  });
  validateClaimsAndRights({
    requested: claimRightsRequests,
    resolved: resolvedClaimsRights,
    authority,
    artifactSetDigest,
    now: input.clock.now(),
    verifier: input.verifier
  });
  const packageEvidenceDigest = digest({
    sourceEvidence,
    dlpEvidence: packageDlp,
    reviewDlpEvidence: reviewDlp,
    threatAssessments: reviewThreatAssessments,
    artifactPolicyAssessments,
    claimsRightsEvidence: resolvedClaimsRights
  });
  const packageEvidenceExpiresAt = earliestExpiry([
    ...sourceEvidence.map((evidence) => evidence.expiresAt),
    packageDlp.expiresAt,
    reviewDlp.expiresAt,
    resolvedClaimsRights.authority.expiresAt,
    ...reviewThreatAssessments.map((evidence) => evidence.expiresAt),
    ...artifactPolicyAssessments.map((evidence) => evidence.expiresAt),
    ...resolvedClaimsRights.claims.map((evidence) => evidence.expiresAt),
    ...resolvedClaimsRights.rights.map((evidence) => evidence.expiresAt)
  ]);
  const basePackageRequest = {
    repositoryId: repositoryIdentity.repositoryId,
    workItemId: repositoryIdentity.workItemId,
    repositoryIdentity,
    expectedBaseSha: currentBinding.baseSha,
    expectedHeadSha: currentHead,
    title: `Draft ${definition.displayName}: ${input.workItemId}`,
    authorityBindings: {
      definitionDigest: authority.definitionDigest,
      profileDigest: authority.profileDigest,
      enterprisePolicyDigest: authority.enterprisePolicyDigest,
      workAccordDigest: authority.workAccordDigest,
      capabilityRegistryDigest: authority.capabilityRegistryDigest,
      domainPackPolicyDigest: authority.domainPackPolicyDigest,
      phaseContractDigests: authority.phaseContractDigests,
      compiledPolicyDigests: Object.fromEntries(
        DOMAIN_PHASES.map((phase) => [
          phase,
          authority.compiledPolicies[phase].digest
        ])
      ) as Readonly<Record<DomainPhase, Digest>>,
      bundleSchemaDigest: authority.bundleSchemaDigest,
      artifactSchemaDigests: authority.artifactSchemaDigests,
      artifactTemplateDigests: authority.artifactTemplateDigests,
      reviewRubricDigest: authority.reviewRubricDigest,
      authorityDigest: authority.digest
    },
    artifactSetDigest,
    maxPatchBytes,
    evidenceDigest: packageEvidenceDigest,
    evidenceExpiresAt: packageEvidenceExpiresAt,
    files: artifacts,
    claimsRightsAuthorityDigest,
    claimsRightsAuthorityRevision,
    claimsRightsAuthorityHeadDigest,
    draft: true as const
  };
  const packageGuardContextDigest = domainOperationRequestDigest(
    "repository-package",
    basePackageRequest
  );
  const packageGrant = await authorizeOperation(
    "repository-package",
    null,
    basePackageRequest
  );
  validateDomainOperationRequest(
    packageGrant,
    "repository-package",
    basePackageRequest
  );
  const { packaged, packageAuthorityGuard } =
    await input.claimsRightsAuthority.withCurrent({
      operation: "repository-package",
      authorityEvidence: resolvedClaimsRights.authority,
      repositoryIdentityDigest,
      grantContextDigest: packageGuardContextDigest,
      authorization: packageGrant,
      effect: async (authorityGuard) => {
        if (
          authorityGuard.operation !== "repository-package" ||
          authorityGuard.authorityDigest !== authority.digest ||
          authorityGuard.artifactSetDigest !== artifactSetDigest ||
          authorityGuard.repositoryIdentityDigest !== repositoryIdentityDigest ||
          authorityGuard.grantContextDigest !== packageGuardContextDigest ||
          authorityGuard.authorizationDigest !== digest(packageGrant) ||
          authorityGuard.authorizationSignatureDigest !==
            digest(packageGrant.signature) ||
          authorityGuard.authorizationNonce !== packageGrant.nonce ||
          authorityGuard.authorizationRunId !== packageGrant.runId ||
          authorityGuard.authorizationRunAttempt !== packageGrant.runAttempt ||
          authorityGuard.authorizationExpiresAt !== packageGrant.expiresAt ||
          authorityGuard.revision !== claimsRightsAuthorityRevision ||
          authorityGuard.authorityHeadDigest !== claimsRightsAuthorityHeadDigest ||
          authorityGuard.claimEvidenceSetDigest !== claimsRightsDigests.claimDigest ||
          authorityGuard.rightsEvidenceSetDigest !== claimsRightsDigests.rightsDigest ||
          !input.verifier.verify(
            unsigned(authorityGuard),
            authorityGuard.signature,
            "domain-claims-rights-authority-guard"
          )
        ) {
          fail("APPROVAL_INVALID", "package authority CAS guard is invalid");
        }
        return {
          packaged: await input.github.packageDraftPullRequest({
            ...basePackageRequest,
            authorityGuard,
            authorization: packageGrant
          }),
          packageAuthorityGuard: authorityGuard
        };
      }
  });
  const packageObservedAt = timestamp(packaged.observedAt, "package observedAt");
  const packagePredecessorAt = Math.max(
    timestamp(packageGrant.checkedAt, "package grant checkedAt"),
    timestamp(packageAuthorityGuard.checkedAt, "package authority guard checkedAt"),
    timestamp(packageDlp.checkedAt, "package DLP checkedAt"),
    timestamp(reviewDlp.checkedAt, "review DLP checkedAt"),
    timestamp(resolvedClaimsRights.authority.observedAt, "claims authority observedAt"),
    ...reviewThreatAssessments.map((evidence) =>
      timestamp(evidence.checkedAt, "review threat checkedAt")
    ),
    ...artifactPolicyAssessments.map((evidence) =>
      timestamp(evidence.checkedAt, "artifact policy checkedAt")
    ),
    ...sourceEvidence.map((evidence) =>
      timestamp(evidence.observedAt, "source evidence observedAt")
    ),
    ...resolvedClaimsRights.claims.map((evidence) =>
      timestamp(evidence.observedAt, "claim evidence observedAt")
    ),
    ...resolvedClaimsRights.rights.map((evidence) =>
      timestamp(evidence.observedAt, "rights evidence observedAt")
    )
  );
  if (
    packaged.purpose !== "domain-package-receipt" ||
    packaged.draft !== true ||
    digest(packaged.repositoryIdentity) !== repositoryIdentityDigest ||
    packaged.artifactSetDigest !== artifactSetDigest ||
    packaged.authorizationDigest !== digest(packageGrant) ||
    !DIGEST_PATTERN.test(packaged.operationGrantClaimDigest) ||
    packaged.authorityGuardDigest !== digest(packageAuthorityGuard) ||
    packaged.evidenceDigest !== packageEvidenceDigest ||
    packaged.parentSha !== currentHead ||
    packaged.baseSha !== currentBinding.baseSha ||
    packaged.proposalRef !== repositoryIdentity.proposalRef ||
    packaged.authorityRevision !== packageAuthorityGuard.revision ||
    !/^[a-f0-9]{40}$/u.test(packaged.treeSha) ||
    !DIGEST_PATTERN.test(packaged.patchDigest) ||
    !Number.isSafeInteger(packaged.patchBytes) ||
    packaged.patchBytes < 1 ||
    packaged.patchBytes > maxPatchBytes ||
    !/^[a-f0-9]{40}$/u.test(packaged.headSha) ||
    packaged.headSha === currentHead ||
    packageObservedAt < packagePredecessorAt ||
    packageObservedAt > timestamp(input.clock.now(), "now") ||
    packageObservedAt >=
      timestamp(packageGrant.expiresAt, "package grant expiresAt") ||
    packageObservedAt >=
      timestamp(packageEvidenceExpiresAt, "package evidence expiresAt") ||
    packaged.externalEffectsPerformed !== false ||
    !input.verifier.verify(
      unsigned(packaged),
      packaged.signature,
      "domain-package-receipt"
    )
  ) {
    fail("PACKAGE_INVALID", "repository packager returned an unsafe effect result");
  }
  effectHead = packaged.headSha;
  await input.ledger.append({
    type: "draft-pr-packaged",
    packId: definition.id,
    subjectDigest: digest(packaged),
    observedAt: input.clock.now()
  });
  if (
    canonicalJson(
      await input.github.readCurrentBinding(repositoryIdentity)
    ) !==
      canonicalJson({
        ...repositoryIdentity,
        baseSha: currentBinding.baseSha,
        headSha: effectHead
      })
  ) {
    fail("HEAD_STALE", "trusted repository head changed before COMMENT review");
  }
  ensureCurrentAuthority();
  ensureCurrentSources();
  ensureCurrentArtifactPolicy();
  validateDlpEvidence({
    evidence: reviewDlp,
    stage: "pre-comment",
    authority,
    artifactSetDigest,
    sourceDigests,
    values: reviewDlpValues,
    now: input.clock.now(),
    verifier: input.verifier
  });
  const commentRequest = {
    repositoryIdentity,
    packageId: packaged.packageId,
    expectedHeadSha: effectHead,
    artifactSetDigest,
    reviewHistory,
    reviewDlpEvidenceDigest: digest(reviewDlp),
    threatAssessmentDigest: digest(finalThreatAssessment),
    artifactPolicyAssessmentDigest: digest(finalArtifactPolicyAssessment),
    evidenceExpiresAt: earliestExpiry([
      reviewDlp.expiresAt,
      finalThreatAssessment.expiresAt,
      finalArtifactPolicyAssessment.expiresAt
    ])
  };
  const commentGrant = await authorizeOperation(
    "repository-comment",
    null,
    commentRequest
  );
  validateDomainOperationRequest(commentGrant, "repository-comment", commentRequest);
  if (
    timestamp(commentGrant.checkedAt, "COMMENT grant checkedAt") <
    packageObservedAt
  ) {
    fail("GRANT_INVALID", "COMMENT authorization predates its package receipt");
  }
  if (
    canonicalJson(
      await input.github.readCurrentBinding(repositoryIdentity)
    ) !==
      canonicalJson({
        ...repositoryIdentity,
        baseSha: currentBinding.baseSha,
        headSha: effectHead
      })
  ) {
    fail(
      "HEAD_STALE",
      "trusted repository head changed at the final COMMENT boundary"
    );
  }
  const commentReview = await input.github.recordCommentReview({
    ...commentRequest,
    authorization: commentGrant
  });
  const commentObservedAt = timestamp(
    commentReview.observedAt,
    "COMMENT observedAt"
  );
  if (
    commentReview.purpose !== "domain-comment-receipt" ||
    commentReview.event !== "COMMENT" ||
    commentReview.repositoryIdentityDigest !== repositoryIdentityDigest ||
    commentReview.headSha !== effectHead ||
    commentReview.artifactSetDigest !== artifactSetDigest ||
    !DIGEST_PATTERN.test(commentReview.receiptDigest) ||
    commentReview.authorizationDigest !== digest(commentGrant) ||
    commentReview.externalEffectsPerformed !== false ||
    commentObservedAt > timestamp(input.clock.now(), "now") ||
    commentObservedAt < packageObservedAt ||
    commentObservedAt <
      timestamp(commentGrant.checkedAt, "COMMENT grant checkedAt") ||
    commentObservedAt <
      timestamp(reviewDlp.checkedAt, "review DLP checkedAt") ||
    commentObservedAt <
      timestamp(finalThreatAssessment.checkedAt, "review threat checkedAt") ||
    commentObservedAt <
      timestamp(finalArtifactPolicyAssessment.checkedAt, "artifact policy checkedAt") ||
    commentObservedAt >=
      timestamp(commentGrant.expiresAt, "COMMENT grant expiresAt") ||
    commentObservedAt >=
      timestamp(reviewDlp.expiresAt, "review DLP expiresAt") ||
    commentObservedAt >=
      timestamp(finalThreatAssessment.expiresAt, "review threat expiresAt") ||
    commentObservedAt >=
      timestamp(finalArtifactPolicyAssessment.expiresAt, "artifact policy expiresAt") ||
    !input.verifier.verify(
      unsigned(commentReview),
      commentReview.signature,
      "domain-comment-receipt"
    )
  ) {
    fail("PACKAGE_INVALID", "repository review was not an exact-head COMMENT");
  }
  await input.ledger.append({
    type: "comment-review-recorded",
    packId: definition.id,
    subjectDigest: commentReview.receiptDigest,
    observedAt: input.clock.now()
  });
  const packageDigest = digest(packaged);
  await ensureCurrentClaimsRights();
  ensureCurrentAuthority();
  ensureCurrentArtifactPolicy();
  validatePromptThreatAssessment({
    evidence: finalThreatAssessment,
    authority,
    reviewPayloadDigest: finalThreatAssessment.reviewPayloadDigest,
    artifactBundleDigest: artifactSetDigest,
    now: input.clock.now(),
    verifier: input.verifier
  });
  const humanWait = await input.humanGates.wait({
    authorityDigest: authority.digest,
    kernelAuthorizationDigest: digest(kernelAuthorization),
    repositoryIdentityDigest,
    packageDigest,
    artifactSetDigest,
    commentReviewReceiptDigest: commentReview.receiptDigest,
    claimEvidenceDigest: claimsRightsDigests.claimDigest,
    rightsEvidenceDigest: claimsRightsDigests.rightsDigest,
    claimsRightsAuthorityDigest,
    claimsRightsAuthorityRevision,
    claimsRightsAuthorityHeadDigest,
    claimsRightsExpiresAt,
    headSha: effectHead
  });
  if (
    humanWait.purpose !== "domain-human-wait" ||
    humanWait.authorityDigest !== authority.digest ||
    humanWait.kernelAuthorizationDigest !== digest(kernelAuthorization) ||
    humanWait.repositoryIdentityDigest !== repositoryIdentityDigest ||
    humanWait.packageDigest !== packageDigest ||
    humanWait.artifactSetDigest !== artifactSetDigest ||
    humanWait.commentReviewReceiptDigest !== commentReview.receiptDigest ||
    humanWait.claimEvidenceDigest !== claimsRightsDigests.claimDigest ||
    humanWait.rightsEvidenceDigest !== claimsRightsDigests.rightsDigest ||
    humanWait.claimsRightsAuthorityDigest !== claimsRightsAuthorityDigest ||
    humanWait.claimsRightsAuthorityRevision !== claimsRightsAuthorityRevision ||
    humanWait.claimsRightsAuthorityHeadDigest !==
      claimsRightsAuthorityHeadDigest ||
    humanWait.claimsRightsExpiresAt !== claimsRightsExpiresAt ||
    humanWait.headSha !== effectHead ||
    packageObservedAt >
      timestamp(humanWait.recordedAt, "human wait recordedAt") ||
    commentObservedAt >
      timestamp(humanWait.recordedAt, "human wait recordedAt") ||
    timestamp(humanWait.recordedAt, "human wait recordedAt") >
      timestamp(input.clock.now(), "now") ||
    !input.verifier.verify(
      unsigned(humanWait),
      humanWait.signature,
      "domain-human-wait"
    )
  ) {
    fail("APPROVAL_INVALID", "human-wait checkpoint is forged or substituted");
  }
  ensureCurrentAuthority();
  ensureCurrentArtifactPolicy();
  validatePromptThreatAssessment({
    evidence: finalThreatAssessment,
    authority,
    reviewPayloadDigest: finalThreatAssessment.reviewPayloadDigest,
    artifactBundleDigest: artifactSetDigest,
    now: input.clock.now(),
    verifier: input.verifier
  });
  validateDlpEvidence({
    evidence: reviewDlp,
    stage: "pre-comment",
    authority,
    artifactSetDigest,
    sourceDigests,
    values: reviewDlpValues,
    now: input.clock.now(),
    verifier: input.verifier
  });
  await input.ledger.append({
    type: "human-wait-recorded",
    packId: definition.id,
    subjectDigest: digest(humanWait),
    observedAt: input.clock.now()
  });
  await ensureCurrentClaimsRights();
  const approvals = await input.humanGates.collect({
    definition,
    repositoryId: input.repositoryId,
    workItemId: input.workItemId,
    repositoryIdentityDigest,
    baseSha: currentBinding.baseSha,
    headSha: effectHead,
    requesterId: input.requesterId,
    automationActorId: input.automationActorId,
    authorityDigest: authority.digest,
    workAccordDigest: authority.workAccordDigest,
    artifactSetDigest,
    packageDigest,
    commentReviewReceiptDigest: commentReview.receiptDigest,
    claimEvidenceDigest: claimsRightsDigests.claimDigest,
    rightsEvidenceDigest: claimsRightsDigests.rightsDigest,
    claimsRightsAuthorityDigest,
    claimsRightsAuthorityRevision,
    claimsRightsAuthorityHeadDigest,
    claimsRightsExpiresAt,
    humanWaitCheckpointDigest: digest(humanWait)
  });
  ensureCurrentAuthority();
  ensureCurrentArtifactPolicy();
  validatePromptThreatAssessment({
    evidence: finalThreatAssessment,
    authority,
    reviewPayloadDigest: finalThreatAssessment.reviewPayloadDigest,
    artifactBundleDigest: artifactSetDigest,
    now: input.clock.now(),
    verifier: input.verifier
  });
  const approvalEvidenceDigests = validateApprovals({
    approvals,
    definition,
    authority,
    roleBindings,
    repositoryId: input.repositoryId,
    workItemId: input.workItemId,
    repositoryIdentityDigest,
    baseSha: currentBinding.baseSha,
    headSha: effectHead,
    requesterId: input.requesterId,
    automationActorId: input.automationActorId,
    artifactSetDigest,
    packageDigest,
    commentReviewReceiptDigest: commentReview.receiptDigest,
    humanWaitCheckpointDigest: digest(humanWait),
    claimEvidenceDigest: claimsRightsDigests.claimDigest,
    rightsEvidenceDigest: claimsRightsDigests.rightsDigest,
    claimsRightsAuthorityDigest,
    claimsRightsAuthorityRevision,
    claimsRightsAuthorityHeadDigest,
    claimsRightsExpiresAt,
    humanWaitRecordedAt: humanWait.recordedAt,
    authorityExpiresAt: kernelAuthorization.expiresAt,
    now: input.clock.now(),
    verifier: input.verifier
  });
  await input.ledger.append({
    type: "approvals-validated",
    packId: definition.id,
    subjectDigest: digest(approvalEvidenceDigests),
    observedAt: input.clock.now()
  });

  validateRoleBindings({
    bindings: signedRoleBindings,
    definition,
    authority,
    workAccordDigest: authority.workAccordDigest,
    repositoryId: input.repositoryId,
    workItemId: input.workItemId,
    repositoryIdentityDigest,
    headSha: currentHead,
    requesterId: input.requesterId,
    automationActorId: input.automationActorId,
    now: input.clock.now(),
    authorityExpiresAt: policyContext.accord.budget.expiresAt,
    verifier: input.verifier
  });
  if (
    canonicalJson(await input.github.readCurrentBinding(repositoryIdentity)) !==
      canonicalJson({
        ...repositoryIdentity,
        baseSha: currentBinding.baseSha,
        headSha: effectHead
      })
  ) {
    fail("HEAD_STALE", "trusted repository head changed after domain approvals");
  }
  await ensureCurrentClaimsRights();
  const latestApprovalAt = Math.max(
    ...approvals.map((approval) =>
      timestamp(approval.observedAt, "approval observedAt")
    )
  );
  const mergeObservationRequest = {
    repositoryIdentity,
    packId: definition.id,
    repositoryId: input.repositoryId,
    workItemId: input.workItemId,
    packageId: packaged.packageId,
    expectedHeadSha: effectHead,
    artifactSetDigest,
    approvalEvidenceDigests,
    claimEvidenceDigest: claimsRightsDigests.claimDigest,
    rightsEvidenceDigest: claimsRightsDigests.rightsDigest,
    claimsRightsAuthorityDigest,
    claimsRightsAuthorityRevision,
    claimsRightsAuthorityHeadDigest,
    claimsRightsExpiresAt,
    authorityDigest: authority.digest,
    workAccordDigest: authority.workAccordDigest,
    packageDigest,
    commentReviewReceiptDigest: commentReview.receiptDigest,
    humanWaitCheckpointDigest: digest(humanWait),
    mergerRoleBinding: roleBindings.get("merger")!
  };
  const mergeObservationGrant = await authorizeOperation(
    "repository-merge-observe",
    null,
    mergeObservationRequest
  );
  validateDomainOperationRequest(
    mergeObservationGrant,
    "repository-merge-observe",
    mergeObservationRequest
  );
  if (
    timestamp(mergeObservationGrant.checkedAt, "merge grant checkedAt") <
      latestApprovalAt ||
    timestamp(mergeObservationGrant.checkedAt, "merge grant checkedAt") <
      timestamp(humanWait.recordedAt, "human wait recordedAt")
  ) {
    fail("GRANT_INVALID", "merge observation authorization predates human approval");
  }
  const mergeObservation = await input.github.observeHumanMerge({
    ...mergeObservationRequest,
    authorization: mergeObservationGrant
  });
  const approvalActors = new Set(
    approvals.map((approval) => approval.approverId)
  );
  const mergeObservedAt = timestamp(
    mergeObservation.observedAt,
    "merge observedAt"
  );
  const mergerRoleBinding = roleBindings.get("merger");
  const mergerAuthorization = mergeObservation.mergerAuthorization;
  if (
    mergeObservation.purpose !== "domain-merge-observation" ||
    mergeObservation.packId !== definition.id ||
    mergeObservation.repositoryId !== input.repositoryId ||
    mergeObservation.workItemId !== input.workItemId ||
    mergeObservation.repositoryIdentityDigest !== repositoryIdentityDigest ||
    mergeObservation.packageId !== packaged.packageId ||
    mergeObservation.headSha !== effectHead ||
    mergeObservation.artifactSetDigest !== artifactSetDigest ||
    mergeObservation.authorizationDigest !== digest(mergeObservationGrant) ||
    !equalStrings(
      mergeObservation.approvalEvidenceDigests,
      approvalEvidenceDigests
    ) ||
    mergeObservation.claimEvidenceDigest !== claimsRightsDigests.claimDigest ||
    mergeObservation.rightsEvidenceDigest !== claimsRightsDigests.rightsDigest ||
    mergeObservation.claimsRightsAuthorityDigest !==
      claimsRightsAuthorityDigest ||
    mergeObservation.claimsRightsAuthorityRevision !==
      claimsRightsAuthorityRevision ||
    mergeObservation.claimsRightsAuthorityHeadDigest !==
      claimsRightsAuthorityHeadDigest ||
    mergeObservation.claimsRightsExpiresAt !== claimsRightsExpiresAt ||
    !/^[a-f0-9]{40}$/u.test(mergeObservation.mergedSha) ||
    mergeObservation.mergerType !== "User" ||
    mergerRoleBinding === undefined ||
    mergeObservation.mergerId !== mergerRoleBinding.actorId ||
    mergeObservation.mergerRoleBindingDigest !== digest(mergerRoleBinding) ||
    mergeObservation.mergerAuthorizationDigest !== digest(mergerAuthorization) ||
    mergerAuthorization.purpose !==
      "domain-actor-authorization:merge-observation" ||
    mergerAuthorization.actorId !== mergeObservation.mergerId ||
    mergerAuthorization.actorType !== "User" ||
    mergerAuthorization.actorRole !== "merger" ||
    !["write", "maintain", "admin"].includes(
      mergerAuthorization.repositoryPermission
    ) ||
    !mergerAuthorization.teamIds.includes(`team:${definition.id}:merger`) ||
    mergerAuthorization.roleBindingDigest !== digest(mergerRoleBinding) ||
    mergerAuthorization.authorityDigest !== authority.digest ||
    mergerAuthorization.workAccordDigest !== authority.workAccordDigest ||
    mergerAuthorization.artifactSetDigest !== artifactSetDigest ||
    mergerAuthorization.packageDigest !== packageDigest ||
    mergerAuthorization.commentReviewReceiptDigest !==
      commentReview.receiptDigest ||
    mergerAuthorization.humanWaitCheckpointDigest !== digest(humanWait) ||
    mergerAuthorization.claimEvidenceDigest !== claimsRightsDigests.claimDigest ||
    mergerAuthorization.rightsEvidenceDigest !== claimsRightsDigests.rightsDigest ||
    mergerAuthorization.claimsRightsAuthorityDigest !==
      claimsRightsAuthorityDigest ||
    mergerAuthorization.claimsRightsAuthorityRevision !==
      claimsRightsAuthorityRevision ||
    mergerAuthorization.claimsRightsAuthorityHeadDigest !==
      claimsRightsAuthorityHeadDigest ||
    mergerAuthorization.claimsRightsExpiresAt !== claimsRightsExpiresAt ||
    mergerAuthorization.repositoryId !== input.repositoryId ||
    mergerAuthorization.workItemId !== input.workItemId ||
    mergerAuthorization.repositoryIdentityDigest !== repositoryIdentityDigest ||
    mergerAuthorization.headSha !== effectHead ||
    timestamp(mergerAuthorization.observedAt, "merger authorization observedAt") <
      latestApprovalAt ||
    timestamp(mergerAuthorization.observedAt, "merger authorization observedAt") >
      mergeObservedAt ||
    mergeObservedAt >=
      timestamp(mergerAuthorization.expiresAt, "merger authorization expiresAt") ||
    timestamp(mergerAuthorization.expiresAt, "merger authorization expiresAt") >
      timestamp(kernelAuthorization.expiresAt, "Kernel authorization expiresAt") ||
    timestamp(mergerAuthorization.expiresAt, "merger authorization expiresAt") >
      timestamp(claimsRightsExpiresAt, "claims and rights expiresAt") ||
    !input.verifier.verify(
      unsigned(mergerAuthorization),
      mergerAuthorization.signature,
      "domain-actor-authorization:merge-observation"
    ) ||
    mergeObservation.mergerId === input.requesterId ||
    mergeObservation.mergerId === input.automationActorId ||
    approvalActors.has(mergeObservation.mergerId) ||
    mergeObservation.proposalOnly !== true ||
    mergeObservation.externalEffectsPerformed !== false ||
    !input.verifier.verify(
      unsigned(mergeObservation),
      mergeObservation.signature,
      "domain-merge-observation"
    ) ||
    mergeObservedAt <
      timestamp(mergeObservationGrant.checkedAt, "merge grant checkedAt") ||
    mergeObservedAt >=
      timestamp(mergeObservationGrant.expiresAt, "merge grant expiresAt") ||
    mergeObservedAt < latestApprovalAt ||
    mergeObservedAt >=
      timestamp(claimsRightsExpiresAt, "claims and rights expiresAt") ||
    mergeObservedAt > timestamp(input.clock.now(), "now")
  ) {
    fail(
      "APPROVAL_INVALID",
      "merge observation is invalid, stale, future-dated, self-issued, or not proposal-only"
    );
  }
  validateFreshWindow({
    observedAt: mergerAuthorization.observedAt,
    expiresAt: mergerAuthorization.expiresAt,
    now: input.clock.now(),
    maximumAgeMs: 300_000
  });
  ensureCurrentSources();
  if (
    canonicalJson(
      await input.github.readCurrentBinding(repositoryIdentity)
    ) !==
    canonicalJson({
      ...repositoryIdentity,
      baseSha: currentBinding.baseSha,
      headSha: effectHead
    })
  ) {
    fail("HEAD_STALE", "trusted repository head changed during merge observation");
  }
  ensureCurrentAuthority();
  ensureCurrentSources();
  validateRoleBindings({
    bindings: signedRoleBindings,
    definition,
    authority,
    workAccordDigest: authority.workAccordDigest,
    repositoryId: input.repositoryId,
    workItemId: input.workItemId,
    repositoryIdentityDigest,
    headSha: currentHead,
    requesterId: input.requesterId,
    automationActorId: input.automationActorId,
    now: input.clock.now(),
    authorityExpiresAt: policyContext.accord.budget.expiresAt,
    verifier: input.verifier
  });
  validateApprovals({
    approvals,
    definition,
    authority,
    roleBindings,
    repositoryId: input.repositoryId,
    workItemId: input.workItemId,
    repositoryIdentityDigest,
    baseSha: currentBinding.baseSha,
    headSha: effectHead,
    requesterId: input.requesterId,
    automationActorId: input.automationActorId,
    artifactSetDigest,
    packageDigest,
    commentReviewReceiptDigest: commentReview.receiptDigest,
    humanWaitCheckpointDigest: digest(humanWait),
    claimEvidenceDigest: claimsRightsDigests.claimDigest,
    rightsEvidenceDigest: claimsRightsDigests.rightsDigest,
    claimsRightsAuthorityDigest,
    claimsRightsAuthorityRevision,
    claimsRightsAuthorityHeadDigest,
    claimsRightsExpiresAt,
    humanWaitRecordedAt: humanWait.recordedAt,
    authorityExpiresAt: kernelAuthorization.expiresAt,
    now: input.clock.now(),
    verifier: input.verifier
  });
  await ensureCurrentClaimsRights();
  const closureSubjectDigest = digest({
    artifactSetDigest,
    mergedSha: mergeObservation.mergedSha,
    completion: "proposal-artifacts-merged"
  });
  const closureEvidenceSetDigest = digest({
    kernelAuthorization,
    sourceEvidence,
    roleBindings: signedRoleBindings,
    approvals,
    mergerAuthorization,
    mergeObservation,
    package: packaged,
    claimsRightsEvidence: resolvedClaimsRights
  });
  const closureEvidenceExpiresAt = earliestExpiry([
    policyContext.accord.budget.expiresAt,
    kernelAuthorization.expiresAt,
    mergerAuthorization.expiresAt,
    ...sourceEvidence.map((evidence) => evidence.expiresAt),
    ...signedRoleBindings.map((binding) => binding.expiresAt),
    ...approvals.flatMap((approval) => [
      approval.expiresAt,
      approval.actorAuthorization.expiresAt
    ]),
    ...resolvedClaimsRights.claims.map((evidence) => evidence.expiresAt),
    ...resolvedClaimsRights.rights.map((evidence) => evidence.expiresAt),
    resolvedClaimsRights.authority.expiresAt
  ]);
  const baseClosureRequest = {
    repositoryIdentity,
    packId: definition.id,
    authorityDigest: authority.digest,
    headSha: effectHead,
    mergeObservationDigest: digest(mergeObservation),
    mergeObservedAt: mergeObservation.observedAt,
    packageDigest,
    artifactSetDigest,
    approvalEvidenceDigests,
    claimEvidenceDigest: claimsRightsDigests.claimDigest,
    rightsEvidenceDigest: claimsRightsDigests.rightsDigest,
    claimsRightsAuthorityDigest,
    claimsRightsAuthorityRevision,
    claimsRightsAuthorityHeadDigest,
    claimsRightsExpiresAt,
    evidenceSetDigest: closureEvidenceSetDigest,
    evidenceExpiresAt: closureEvidenceExpiresAt,
    subjectDigest: closureSubjectDigest
  };
  ensureCurrentAuthority();
  ensureCurrentSources();
  await ensureCurrentClaimsRights();
  const closureGuardContextDigest = domainOperationRequestDigest(
    "repository-closure",
    baseClosureRequest
  );
  const { closureReceipt, closureGrant, closureAuthorityGuard } =
    await input.claimsRightsAuthority.withCurrent({
      operation: "repository-closure",
      authorityEvidence: resolvedClaimsRights.authority,
      repositoryIdentityDigest,
      grantContextDigest: closureGuardContextDigest,
      effect: async (authorityGuard) => {
        if (
          authorityGuard.operation !== "repository-closure" ||
          authorityGuard.authorityDigest !== authority.digest ||
          authorityGuard.artifactSetDigest !== artifactSetDigest ||
          authorityGuard.repositoryIdentityDigest !== repositoryIdentityDigest ||
          authorityGuard.grantContextDigest !== closureGuardContextDigest ||
          authorityGuard.revision !== claimsRightsAuthorityRevision ||
          authorityGuard.authorityHeadDigest !== claimsRightsAuthorityHeadDigest ||
          authorityGuard.claimEvidenceSetDigest !== claimsRightsDigests.claimDigest ||
          authorityGuard.rightsEvidenceSetDigest !== claimsRightsDigests.rightsDigest ||
          !input.verifier.verify(
            unsigned(authorityGuard),
            authorityGuard.signature,
            "domain-claims-rights-authority-guard"
          )
        ) {
          fail("APPROVAL_INVALID", "closure authority CAS guard is invalid");
        }
        const closureGuardCheckedAt = timestamp(
          authorityGuard.checkedAt,
          "closure authority guard checkedAt"
        );
        if (closureGuardCheckedAt > timestamp(input.clock.now(), "now")) {
          fail("APPROVAL_INVALID", "closure authority CAS guard is future-dated");
        }
        const closureRequest = { ...baseClosureRequest, authorityGuard };
        const grant = await authorizeOperation(
          "repository-closure",
          null,
          closureRequest
        );
        validateDomainOperationRequest(grant, "repository-closure", closureRequest);
        validateFreshWindow({
          observedAt: grant.checkedAt,
          expiresAt: grant.expiresAt,
          now: input.clock.now(),
          maximumAgeMs: 300_000
        });
        if (
          timestamp(grant.checkedAt, "closure grant checkedAt") < mergeObservedAt ||
          timestamp(grant.checkedAt, "closure grant checkedAt") <
            closureGuardCheckedAt
        ) {
          fail(
            "GRANT_INVALID",
            "closure authorization predates its controlling evidence"
          );
        }
        return {
          closureReceipt: await input.ledger.appendClosure({
            ...closureRequest,
            authorization: grant
          }),
          closureGrant: grant,
          closureAuthorityGuard: authorityGuard
        };
      }
  });
  if (
    closureReceipt.purpose !== "domain-closure-receipt" ||
    closureReceipt.authorizationDigest !== digest(closureGrant) ||
    closureReceipt.authorityGuardDigest !== digest(closureAuthorityGuard) ||
    closureReceipt.authorityDigest !== authority.digest ||
    closureReceipt.repositoryIdentityDigest !== repositoryIdentityDigest ||
    closureReceipt.headSha !== effectHead ||
    closureReceipt.mergeObservationDigest !== digest(mergeObservation) ||
    closureReceipt.evidenceSetDigest !== closureEvidenceSetDigest ||
    closureReceipt.subjectDigest !== closureSubjectDigest ||
    closureReceipt.casResult !== "appended" ||
    timestamp(closureReceipt.checkedAt, "closure checkedAt") <
      timestamp(closureGrant.checkedAt, "closure grant checkedAt") ||
    timestamp(closureReceipt.checkedAt, "closure checkedAt") <
      timestamp(closureAuthorityGuard.checkedAt, "closure authority guard checkedAt") ||
    timestamp(closureReceipt.checkedAt, "closure checkedAt") < mergeObservedAt ||
    timestamp(closureReceipt.checkedAt, "closure checkedAt") >=
      timestamp(closureGrant.expiresAt, "closure grant expiresAt") ||
    timestamp(closureReceipt.checkedAt, "closure checkedAt") >=
      timestamp(closureEvidenceExpiresAt, "closure evidence expiresAt") ||
    timestamp(closureReceipt.checkedAt, "closure checkedAt") >
      timestamp(input.clock.now(), "now") ||
    !input.verifier.verify(
      unsigned(closureReceipt),
      closureReceipt.signature,
      "domain-closure-receipt"
    )
  ) {
    fail("GRANT_INVALID", "atomic repository closure receipt is invalid");
  }
  const bundle: DomainArtifactBundle = {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind:
      definition.id === "marketing"
        ? "MarketingArtifactBundle"
        : "BusinessOperationsArtifactBundle",
    packId: definition.id,
    repositoryId: input.repositoryId,
    workItemId: input.workItemId,
    repositoryIdentityDigest,
    baseSha: currentBinding.baseSha,
    headSha: effectHead,
    classification: input.classification,
    authorityDigest: authority.digest,
    approvedSourceDigests: sourceDigests,
    artifactSetDigest,
    executionEvidenceDigests: [
      authority.digest,
      digest(kernelAuthorization),
      digest(sourceEvidence),
      digest({ operationGrants, closureReceipt }),
      digest({ preModelDlp, reviewDlp, packageDlp }),
      digest(reviewThreatAssessments),
      digest(artifactPolicyAssessments),
      claimsRightsDigests.claimDigest,
      claimsRightsDigests.rightsDigest
    ],
    artifacts,
    approvalEvidenceDigests,
    readiness: {
      status: "proposal-artifacts-merged",
      externalEffectsPerformed: false,
      publicationPerformed: false,
      productionMutationPerformed: false
    }
  };
  ensureCurrentAuthority();
  validateArtifactBundle(bundle, definition);
  return {
    bundle,
    reviewHistory,
    revisionCount,
    packageId: packaged.packageId,
    mergedSha: mergeObservation.mergedSha,
    closureStatus: "proposal-artifacts-merged"
  };
}
