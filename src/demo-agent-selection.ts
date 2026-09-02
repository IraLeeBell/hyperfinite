import { createPublicKey, verify as verifySignature } from "node:crypto";

import { canonicalJson, digest } from "./canonical.js";
import {
  createDemoContract,
  demoContractContentDigest,
  validateDemoContract
} from "./demo-portfolio.js";
import { demoBudgetAuthorityDigest } from "./demo-runtime-state.js";
import type {
  DemoEvidenceSigner,
  DemoEvidenceVerifier
} from "./demo-activation.js";
import type { DemoRuntimeReconstruction } from "./demo-runtime-state.js";
import type {
  AgentParticipationPolicy,
  DemoAgentSelectionStatus,
  DemoDecisionRuntimeBinding,
  DemoRuntimeRefusal,
  DemoSelectionActorClass,
  DemoSignature,
  SignedStageAgentSelectionGrant
} from "./demo-types.js";
import { agentParticipationPostureAllows } from "./demo-types.js";
import type { Capability, Digest, PhaseContract } from "./types.js";
import { assertDocument, isCanonicalUtcDateTime } from "./validation.js";

const OBSERVATION_KEYS = [
  "schemaVersion",
  "demoProjectId",
  "projectNodeId",
  "projectItemNodeId",
  "projectBindingDigest",
  "repositoryId",
  "workItemNodeId",
  "stageId",
  "fieldKey",
  "optionKey",
  "actorId",
  "actorClass",
  "authorityEpoch",
  "generation",
  "runId",
  "runAttempt",
  "receiptHead",
  "pullRequestHeadSha",
  "observedAt",
  "expiresAt",
  "signature"
] as const;

export interface AuthenticatedStageAgentSelectionObservation {
  readonly schemaVersion: "1.0.0";
  readonly demoProjectId: DemoRuntimeReconstruction["runState"]["spec"]["demoProjectId"];
  readonly projectNodeId: string;
  readonly projectItemNodeId: string;
  readonly projectBindingDigest: Digest;
  readonly repositoryId: number;
  readonly workItemNodeId: string;
  readonly stageId: string;
  readonly fieldKey: "requested-stage-agent";
  readonly optionKey: string | null;
  readonly actorId: number;
  readonly actorClass: DemoSelectionActorClass;
  readonly authorityEpoch: number;
  readonly generation: number;
  readonly runId: string;
  readonly runAttempt: number;
  readonly receiptHead: Digest | null;
  readonly pullRequestHeadSha: string | null;
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly signature: DemoSignature;
}

export type StageAgentSelectionResolution =
  | {
      readonly kind: "not-applicable";
      readonly status: "not-applicable";
      readonly runtimeBinding: null;
      readonly grant: null;
      readonly refusal: null;
    }
  | {
      readonly kind: "fixed";
      readonly status: "not-applicable";
      readonly runtimeBinding: DemoDecisionRuntimeBinding;
      readonly grant: null;
      readonly refusal: null;
    }
  | {
      readonly kind: "awaiting-selection";
      readonly status: "awaiting-selection";
      readonly runtimeBinding: null;
      readonly grant: null;
      readonly refusal: DemoRuntimeRefusal;
    }
  | {
      readonly kind: "accepted";
      readonly status: "accepted";
      readonly runtimeBinding: DemoDecisionRuntimeBinding;
      readonly grant: SignedStageAgentSelectionGrant;
      readonly refusal: null;
    }
  | {
      readonly kind: "refused";
      readonly status: Exclude<
        DemoAgentSelectionStatus,
        "not-applicable" | "awaiting-selection" | "accepted"
      >;
      readonly runtimeBinding: null;
      readonly grant: null;
      readonly refusal: DemoRuntimeRefusal;
    };

export interface StageAgentSelectionGrantStore {
  readonly supportsAtomicCreate: true;
  claim(grant: SignedStageAgentSelectionGrant): Promise<{
    readonly status: "appended" | "existing" | "conflict";
    readonly grant: SignedStageAgentSelectionGrant | null;
  }>;
  read(selectionKey: Digest): Promise<SignedStageAgentSelectionGrant | null>;
}

function fail(message: string): never {
  throw new TypeError(message);
}

function stable<T>(value: T): T {
  return Object.freeze(JSON.parse(canonicalJson(value)) as T);
}

function exactPlainObservation(
  value: AuthenticatedStageAgentSelectionObservation
): AuthenticatedStageAgentSelectionObservation {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    fail("stage-agent selection observation must be one plain closed object");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.keys(descriptors).sort().join(",") !==
      [...OBSERVATION_KEYS].sort().join(",") ||
    Object.values(descriptors).some((descriptor) => !("value" in descriptor))
  ) {
    fail("stage-agent selection observation fields are not closed");
  }
  return stable(value);
}

function observationPayload(
  observation: AuthenticatedStageAgentSelectionObservation
): Omit<AuthenticatedStageAgentSelectionObservation, "signature"> {
  const { signature: _signature, ...payload } = observation;
  return payload;
}

function fullCapability(capability: Capability): string {
  return `${capability.id}@${capability.version}`;
}

function currentPullRequestHead(
  reconstruction: DemoRuntimeReconstruction
): string | null {
  return (
    reconstruction.runState.spec.currentDraftPullRequest?.headSha ?? null
  );
}

function refusal(input: {
  readonly reconstruction: DemoRuntimeReconstruction;
  readonly code: DemoRuntimeRefusal["spec"]["code"];
  readonly status: Extract<
    DemoAgentSelectionStatus,
    "awaiting-selection" | "invalid" | "stale" | "reconciliation-required"
  >;
  readonly ruleId: string;
  readonly message: string;
  readonly evaluatedAt: string;
}): Extract<
  StageAgentSelectionResolution,
  { readonly kind: "awaiting-selection" | "refused" }
> {
  const record = createDemoContract("DemoRuntimeRefusal", {
    demoProjectId: input.reconstruction.runState.spec.demoProjectId,
    stageId: input.reconstruction.currentStage.stageId,
    inputDigest: digest({
      runStateDigest: input.reconstruction.runState.contentDigest,
      stageAgentBindingsDigest:
        input.reconstruction.authority.contracts.bindings.contentDigest,
      projectBindingDigest:
        input.reconstruction.authority.contracts.profile.spec
          .projectBindingDigest,
      policyDigest: input.reconstruction.kernelSnapshot.policyDigest
    }),
    code: input.code,
    ruleId: input.ruleId,
    message: input.message,
    retryable: false,
    recovery:
      input.status === "awaiting-selection"
        ? "human-authorization"
        : input.status === "reconciliation-required"
          ? "reconcile"
          : "new-contract",
    refusedAt: input.evaluatedAt
  });
  return input.status === "awaiting-selection"
    ? {
        kind: "awaiting-selection",
        status: input.status,
        runtimeBinding: null,
        grant: null,
        refusal: record
      }
    : {
        kind: "refused",
        status: input.status,
        runtimeBinding: null,
        grant: null,
        refusal: record
      };
}

function runtimeTuple(input: {
  readonly agent: string;
  readonly capability: string;
  readonly workflow: string;
}): DemoDecisionRuntimeBinding {
  return {
    agentId: input.agent,
    capabilityId: input.capability,
    workflowId: input.workflow
  };
}

function selectionSignaturePayload(
  grant: SignedStageAgentSelectionGrant
): Readonly<{ contentDigest: Digest }> {
  return { contentDigest: grant.contentDigest };
}

function selectionPolicyDigest(input: {
  readonly policy: AgentParticipationPolicy;
  readonly projectPolicy: AgentParticipationPolicy["spec"]["projects"][number];
  readonly workAccord: DemoRuntimeReconstruction["authority"]["workAccord"];
  readonly phaseContractDigest: Digest;
  readonly stageAgentBindingsDigest: Digest;
  readonly stagePolicy: DemoRuntimeReconstruction["authority"]["contracts"]["bindings"]["spec"]["stageBindings"][number];
}): Digest {
  return digest({
    participationPolicyDigest: input.policy.contentDigest,
    projectPolicy: input.projectPolicy,
    workAccordDigest: digest(input.workAccord),
    phaseContractDigest: input.phaseContractDigest,
    stageAgentBindingsDigest: input.stageAgentBindingsDigest,
    stagePolicy: input.stagePolicy
  });
}

export function validateSignedStageAgentSelectionGrant(input: {
  readonly grant: unknown;
  readonly verifier: DemoEvidenceVerifier;
  readonly reconstruction: DemoRuntimeReconstruction;
  readonly evaluatedAt: string;
  readonly participationPolicy?: unknown;
  readonly phaseContract?: PhaseContract;
}): SignedStageAgentSelectionGrant {
  const grant = validateDemoContract(
    "SignedStageAgentSelectionGrant",
    input.grant
  );
  if (
    !isCanonicalUtcDateTime(input.evaluatedAt) ||
    !Number.isFinite(Date.parse(input.evaluatedAt))
  ) {
    fail("selection grant evaluation time is invalid");
  }
  const entry =
    input.reconstruction.authority.contracts.bindings.spec.stageBindings[
      input.reconstruction.currentStage.ordinal - 1
    ];
  if (entry === undefined) {
    fail("signed stage-agent selection has no current stage policy");
  }
  const binding = entry?.runtimeBindings.find(
    (candidate) =>
      candidate.optionKey === grant.spec.optionKey &&
      candidate.agent === grant.spec.agentId &&
      candidate.skill === grant.spec.skillId &&
      candidate.capability === grant.spec.capabilityId &&
      candidate.workflow === grant.spec.workflowId
  );
  const accord = input.reconstruction.authority.workAccord;
  const phaseBinding = accord.policy.phaseContracts[grant.spec.phase];
  if (
    (input.participationPolicy === undefined) !==
    (input.phaseContract === undefined)
  ) {
    fail("selection policy and Phase Contract must be revalidated together");
  }
  if (
    input.participationPolicy !== undefined &&
    input.phaseContract !== undefined
  ) {
    const policy = validateDemoContract(
      "AgentParticipationPolicy",
      input.participationPolicy
    );
    const phaseContract = assertDocument("PhaseContract", input.phaseContract);
    const projectPolicy = policy.spec.projects.find(
      (project) =>
        project.demoProjectId ===
        input.reconstruction.runState.spec.demoProjectId
    );
    if (
      projectPolicy === undefined ||
      !agentParticipationPostureAllows(
        policy.spec.enterpriseMaximum,
        projectPolicy.posture
      ) ||
      policy.contentDigest !==
        input.reconstruction.authority.contracts.bindings.spec
          .participationPolicyDigest ||
      policy.spec.enterpriseMaximum === "locked" ||
      projectPolicy.posture === "locked" ||
      policy.spec.policyGeneration !== grant.spec.policyGeneration ||
      !projectPolicy.selectableStageIds.includes(grant.spec.stageId) ||
      !projectPolicy.allowedOptionKeys.includes(grant.spec.optionKey) ||
      phaseContract.phase !== grant.spec.phase ||
      digest(phaseContract) !== grant.spec.phaseContractDigest ||
      selectionPolicyDigest({
        policy,
        projectPolicy,
        workAccord: accord,
        phaseContractDigest: digest(phaseContract),
        stageAgentBindingsDigest:
          input.reconstruction.authority.contracts.bindings.contentDigest,
        stagePolicy: entry
      }) !== grant.spec.selectionPolicyDigest
    ) {
      fail("signed stage-agent selection policy changed before inference");
    }
  }
  if (
    !input.verifier.verify(selectionSignaturePayload(grant), grant.signature) ||
    Date.parse(input.evaluatedAt) >= Date.parse(grant.spec.expiresAt) ||
    entry.stageId !== input.reconstruction.currentStage.stageId ||
    entry.participationMode !== "user-selectable" ||
    binding === undefined ||
    grant.spec.demoProjectId !==
      input.reconstruction.runState.spec.demoProjectId ||
    grant.spec.stageId !== input.reconstruction.currentStage.stageId ||
    grant.spec.projectBindingDigest !==
      input.reconstruction.authority.contracts.profile.spec
        .projectBindingDigest ||
    grant.spec.repositoryId !==
      input.reconstruction.runState.spec.repositoryId ||
    grant.spec.workItemNodeId !==
      input.reconstruction.runState.spec.workItemNodeId ||
    grant.spec.authorityEpoch !==
      input.reconstruction.runState.spec.authorityEpoch ||
    grant.spec.generation !==
      input.reconstruction.runState.spec.generation ||
    grant.spec.runId !== input.reconstruction.runState.spec.runId ||
    grant.spec.runAttempt !==
      input.reconstruction.runState.spec.runAttempt ||
    grant.spec.receiptHead !==
      input.reconstruction.runState.spec.journey.previousStageReceiptDigest ||
    grant.spec.pullRequestHeadSha !==
      currentPullRequestHead(input.reconstruction) ||
    grant.spec.stageAgentBindingsDigest !==
      input.reconstruction.authority.contracts.bindings.contentDigest ||
    grant.spec.workAccordDigest !== digest(accord) ||
    phaseBinding === undefined ||
    grant.spec.phaseContractDigest !== phaseBinding.digest ||
    grant.spec.capabilityRegistryDigest !==
      input.reconstruction.kernelSnapshot.capabilityRegistryDigest ||
    grant.spec.activationLeaseDigest !==
      digest(input.reconstruction.activationLease) ||
    grant.spec.budgetAuthorityDigest !==
      demoBudgetAuthorityDigest(input.reconstruction.budget) ||
    canonicalJson(runtimeTuple(binding)) !==
      canonicalJson({
        agentId: grant.spec.agentId,
        capabilityId: grant.spec.capabilityId,
        workflowId: grant.spec.workflowId
      })
  ) {
    fail("signed stage-agent selection grant is stale or substituted");
  }
  return grant;
}

export function validateBoundStageAgentSelectionGrant(input: {
  readonly grant: unknown;
  readonly expectedDigest: Digest;
  readonly expectedKeyId: string;
  readonly encodedPublicKey: string;
  readonly evaluatedAt: string;
  readonly expected: {
    readonly demoProjectId: DemoRuntimeReconstruction["runState"]["spec"]["demoProjectId"];
    readonly stageId: string;
    readonly projectNodeId: string;
    readonly projectItemNodeId: string;
    readonly repositoryId: number;
    readonly workItemNodeId: string;
    readonly stageAgentBindingsDigest: Digest;
    readonly workAccordDigest: Digest;
    readonly activationLeaseDigest: Digest;
    readonly agentId: string;
    readonly skillId: string;
    readonly capabilityId: string;
    readonly workflowId: string;
    readonly workflowClass: SignedStageAgentSelectionGrant["spec"]["workflowClass"];
    readonly phase: SignedStageAgentSelectionGrant["spec"]["phase"];
    readonly role: SignedStageAgentSelectionGrant["spec"]["role"];
    readonly pullRequestHeadSha: string | null;
    readonly authorityEpoch: number;
    readonly generation: number;
    readonly runId: string;
    readonly runAttempt: number;
    readonly receiptHead: Digest | null;
    readonly policyGeneration: number;
    readonly selectionPolicyDigest: Digest;
    readonly capabilityRegistryDigest: Digest;
    readonly budgetAuthorityDigest: Digest;
  };
}): SignedStageAgentSelectionGrant {
  const grant = validateDemoContract(
    "SignedStageAgentSelectionGrant",
    input.grant
  );
  const evaluatedAt = Date.parse(input.evaluatedAt);
  const issuedAt = Date.parse(grant.spec.issuedAt);
  const expiresAt = Date.parse(grant.spec.expiresAt);
  let signatureValid = false;
  if (
    grant.signature.algorithm === "ed25519" &&
    grant.signature.keyId === input.expectedKeyId &&
    /^[A-Za-z0-9+/]+={0,2}$/u.test(input.encodedPublicKey) &&
    input.encodedPublicKey.length % 4 === 0
  ) {
    try {
      const key = createPublicKey({
        key: Buffer.from(input.encodedPublicKey, "base64"),
        format: "der",
        type: "spki"
      });
      signatureValid = verifySignature(
        null,
        Buffer.from(canonicalJson(selectionSignaturePayload(grant))),
        key,
        Buffer.from(grant.signature.value, "base64")
      );
    } catch {
      signatureValid = false;
    }
  }
  if (
    !signatureValid ||
    grant.contentDigest !== input.expectedDigest ||
    !isCanonicalUtcDateTime(input.evaluatedAt) ||
    !Number.isFinite(evaluatedAt) ||
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    issuedAt > evaluatedAt ||
    evaluatedAt >= expiresAt ||
    grant.spec.demoProjectId !== input.expected.demoProjectId ||
    grant.spec.stageId !== input.expected.stageId ||
    grant.spec.projectNodeId !== input.expected.projectNodeId ||
    grant.spec.projectItemNodeId !== input.expected.projectItemNodeId ||
    grant.spec.repositoryId !== input.expected.repositoryId ||
    grant.spec.workItemNodeId !== input.expected.workItemNodeId ||
    grant.spec.stageAgentBindingsDigest !==
      input.expected.stageAgentBindingsDigest ||
    grant.spec.workAccordDigest !== input.expected.workAccordDigest ||
    grant.spec.activationLeaseDigest !==
      input.expected.activationLeaseDigest ||
    grant.spec.agentId !== input.expected.agentId ||
    grant.spec.skillId !== input.expected.skillId ||
    grant.spec.capabilityId !== input.expected.capabilityId ||
    grant.spec.workflowId !== input.expected.workflowId ||
    grant.spec.workflowClass !== input.expected.workflowClass ||
    grant.spec.phase !== input.expected.phase ||
    grant.spec.role !== input.expected.role ||
    grant.spec.pullRequestHeadSha !== input.expected.pullRequestHeadSha ||
    grant.spec.authorityEpoch !== input.expected.authorityEpoch ||
    grant.spec.generation !== input.expected.generation ||
    grant.spec.runId !== input.expected.runId ||
    grant.spec.runAttempt !== input.expected.runAttempt ||
    grant.spec.receiptHead !== input.expected.receiptHead ||
    grant.spec.policyGeneration !== input.expected.policyGeneration ||
    grant.spec.selectionPolicyDigest !==
      input.expected.selectionPolicyDigest ||
    grant.spec.capabilityRegistryDigest !==
      input.expected.capabilityRegistryDigest ||
    grant.spec.budgetAuthorityDigest !== input.expected.budgetAuthorityDigest
  ) {
    fail("signed stage-agent selection grant is not bound to this runtime request");
  }
  return grant;
}

export async function resolveStageAgentSelection(input: {
  readonly reconstruction: DemoRuntimeReconstruction;
  readonly participationPolicy: unknown;
  readonly phaseContract: PhaseContract;
  readonly observation: AuthenticatedStageAgentSelectionObservation | null;
  readonly expectedProject: {
    readonly projectNodeId: string;
    readonly projectItemNodeId: string;
  };
  readonly authorizedActorIds: readonly number[];
  readonly grantStore: StageAgentSelectionGrantStore;
  readonly observationVerifier: DemoEvidenceVerifier;
  readonly grantSigner: DemoEvidenceSigner;
  readonly grantVerifier: DemoEvidenceVerifier;
  readonly evaluatedAt: string;
}): Promise<StageAgentSelectionResolution> {
  if (
    !isCanonicalUtcDateTime(input.evaluatedAt) ||
    !Number.isFinite(Date.parse(input.evaluatedAt))
  ) {
    fail("selection evaluation time is invalid");
  }
  let policy: AgentParticipationPolicy;
  try {
    policy = validateDemoContract(
      "AgentParticipationPolicy",
      input.participationPolicy
    );
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return refusal({
      reconstruction: input.reconstruction,
      code: "SELECTION_POLICY_MISMATCH",
      status: "invalid",
      ruleId: "demo.selection.policy",
      message: "The agent-participation policy is invalid or non-monotonic.",
      evaluatedAt: input.evaluatedAt
    });
  }
  const phaseContract = assertDocument("PhaseContract", input.phaseContract);
  const { reconstruction } = input;
  const entry =
    reconstruction.authority.contracts.bindings.spec.stageBindings[
      reconstruction.currentStage.ordinal - 1
    ];
  if (
    entry === undefined ||
    entry.stageId !== reconstruction.currentStage.stageId ||
    entry.executionKind !== reconstruction.currentStage.executionKind
  ) {
    return refusal({
      reconstruction,
      code: "SELECTION_STAGE_MISMATCH",
      status: "reconciliation-required",
      ruleId: "demo.selection.stage",
      message: "The current stage does not match its reviewed participation policy.",
      evaluatedAt: input.evaluatedAt
    });
  }
  if (entry.participationMode === "none") {
    return {
      kind: "not-applicable",
      status: "not-applicable",
      runtimeBinding: null,
      grant: null,
      refusal: null
    };
  }
  if (entry.participationMode === "fixed") {
    const binding = entry.runtimeBindings[0];
    if (
      binding === undefined ||
      entry.runtimeBindings.length !== 1 ||
      binding.userInvocable ||
      binding.optionKey !== null
    ) {
      return refusal({
        reconstruction,
        code: "SELECTION_BINDING_MISMATCH",
        status: "reconciliation-required",
        ruleId: "demo.selection.fixed",
        message: "The fixed stage does not have one exact non-user-invocable binding.",
        evaluatedAt: input.evaluatedAt
      });
    }
    return {
      kind: "fixed",
      status: "not-applicable",
      runtimeBinding: runtimeTuple(binding),
      grant: null,
      refusal: null
    };
  }
  if (input.observation === null || input.observation.optionKey === null) {
    return refusal({
      reconstruction,
      code: "SELECTION_REQUIRED",
      status: "awaiting-selection",
      ruleId: "demo.selection.required",
      message: "This stage requires one fresh authorized agent selection.",
      evaluatedAt: input.evaluatedAt
    });
  }
  const observation = exactPlainObservation(input.observation);
  if (observation.optionKey === null) {
    return refusal({
      reconstruction,
      code: "SELECTION_REQUIRED",
      status: "awaiting-selection",
      ruleId: "demo.selection.required",
      message: "This stage requires one fresh authorized agent selection.",
      evaluatedAt: input.evaluatedAt
    });
  }
  const optionKey = observation.optionKey;
  const observedAt = Date.parse(observation.observedAt);
  const expiresAt = Date.parse(observation.expiresAt);
  const evaluatedAt = Date.parse(input.evaluatedAt);
  if (
    observation.schemaVersion !== "1.0.0" ||
    !isCanonicalUtcDateTime(observation.observedAt) ||
    !isCanonicalUtcDateTime(observation.expiresAt) ||
    !Number.isFinite(observedAt) ||
    !Number.isFinite(expiresAt) ||
    observedAt > evaluatedAt ||
    evaluatedAt >= expiresAt ||
    !input.observationVerifier.verify(
      observationPayload(observation),
      observation.signature
    )
  ) {
    return refusal({
      reconstruction,
      code: "SELECTION_STALE",
      status: "stale",
      ruleId: "demo.selection.fresh",
      message: "The Project selection observation is unauthenticated or stale.",
      evaluatedAt: input.evaluatedAt
    });
  }
  if (
    observation.demoProjectId !== reconstruction.runState.spec.demoProjectId ||
    observation.projectNodeId !== input.expectedProject.projectNodeId ||
    observation.projectItemNodeId !== input.expectedProject.projectItemNodeId ||
    observation.projectBindingDigest !==
      reconstruction.authority.contracts.profile.spec.projectBindingDigest ||
    observation.repositoryId !== reconstruction.runState.spec.repositoryId ||
    observation.workItemNodeId !== reconstruction.runState.spec.workItemNodeId
  ) {
    return refusal({
      reconstruction,
      code: "SELECTION_TARGET_MISMATCH",
      status: "invalid",
      ruleId: "demo.selection.target",
      message: "The Project selection is bound to a different trusted target.",
      evaluatedAt: input.evaluatedAt
    });
  }
  if (
    observation.stageId !== reconstruction.currentStage.stageId ||
    observation.fieldKey !== "requested-stage-agent"
  ) {
    return refusal({
      reconstruction,
      code: "SELECTION_STAGE_MISMATCH",
      status: "invalid",
      ruleId: "demo.selection.stage",
      message: "The Project selection is not valid for the current stage.",
      evaluatedAt: input.evaluatedAt
    });
  }
  if (
    observation.authorityEpoch !== reconstruction.runState.spec.authorityEpoch ||
    observation.generation !== reconstruction.runState.spec.generation ||
    observation.runId !== reconstruction.runState.spec.runId ||
    observation.runAttempt !== reconstruction.runState.spec.runAttempt ||
    observation.receiptHead !==
      reconstruction.runState.spec.journey.previousStageReceiptDigest
  ) {
    return refusal({
      reconstruction,
      code: "SELECTION_GENERATION_MISMATCH",
      status: "stale",
      ruleId: "demo.selection.generation",
      message: "The Project selection belongs to another run generation or receipt head.",
      evaluatedAt: input.evaluatedAt
    });
  }
  if (
    observation.pullRequestHeadSha !== currentPullRequestHead(reconstruction)
  ) {
    return refusal({
      reconstruction,
      code: "SELECTION_HEAD_MISMATCH",
      status: "stale",
      ruleId: "demo.selection.head",
      message: "The Project selection does not bind the current pull-request head.",
      evaluatedAt: input.evaluatedAt
    });
  }
  const projectPolicy = policy.spec.projects.find(
    (candidate) =>
      candidate.demoProjectId === reconstruction.runState.spec.demoProjectId
  );
  if (
    reconstruction.authority.contracts.bindings.spec
      .participationPolicyDigest !== policy.contentDigest ||
    projectPolicy === undefined ||
    !agentParticipationPostureAllows(
      policy.spec.enterpriseMaximum,
      projectPolicy.posture
    ) ||
    policy.spec.enterpriseMaximum === "locked" ||
    projectPolicy.posture === "locked" ||
    !projectPolicy.selectableStageIds.includes(
      reconstruction.currentStage.stageId
    ) ||
    !projectPolicy.allowedOptionKeys.includes(optionKey) ||
    !entry.allowedOptionKeys.includes(optionKey)
  ) {
    return refusal({
      reconstruction,
      code: "SELECTION_POLICY_MISMATCH",
      status: "invalid",
      ruleId: "demo.selection.policy",
      message: "Enterprise, project, or stage policy does not permit this selection.",
      evaluatedAt: input.evaluatedAt
    });
  }
  if (
    observation.actorClass === "bot" ||
    observation.actorClass === "system" ||
    !Number.isSafeInteger(observation.actorId) ||
    observation.actorId < 1 ||
    !input.authorizedActorIds.includes(observation.actorId) ||
    !policy.spec.eligibleActorClasses.includes(observation.actorClass) ||
    !entry.eligibleActorClasses.includes(observation.actorClass)
  ) {
    return refusal({
      reconstruction,
      code: "SELECTION_UNAUTHORIZED",
      status: "invalid",
      ruleId: "demo.selection.actor",
      message: "The selecting actor is not currently authorized for this stage.",
      evaluatedAt: input.evaluatedAt
    });
  }
  const binding = entry.runtimeBindings.find(
    (candidate) => candidate.optionKey === optionKey
  );
  const capability =
    reconstruction.authority.contracts.capabilities.spec.capabilities.find(
      (candidate) =>
        binding !== undefined &&
        fullCapability(candidate) === binding.capability
    );
  const phaseBinding =
    binding === undefined
      ? undefined
      : reconstruction.authority.workAccord.policy.phaseContracts[
          binding.phase
        ];
  const phaseContractDigest = digest(phaseContract);
  if (
    binding === undefined ||
    capability === undefined ||
    !binding.userInvocable ||
    binding.optionKey === null ||
    capability.status !== "active" ||
    capability.implementation.kind !== "model" ||
    !capability.actorClasses.includes("system") ||
    phaseContract.phase !== binding.phase ||
    phaseBinding === undefined ||
    phaseBinding.digest !== phaseContractDigest ||
    !phaseContract.allowedCapabilities.includes(binding.capability) ||
    !reconstruction.authority.workAccord.policy.requestedCapabilities.includes(
      binding.capability
    ) ||
    !reconstruction.activationLease.allowedCapabilities.includes(
      binding.capability
    )
  ) {
    return refusal({
      reconstruction,
      code: "SELECTION_BINDING_MISMATCH",
      status: "invalid",
      ruleId: "demo.selection.binding",
      message: "The selected option does not resolve through every trusted authority layer.",
      evaluatedAt: input.evaluatedAt
    });
  }
  const availableCalls =
    reconstruction.budget.spec.limits.maxCalls -
    reconstruction.budget.spec.usage.calls -
    reconstruction.budget.spec.held.calls;
  const availableTokens =
    reconstruction.budget.spec.limits.maxTokens -
    reconstruction.budget.spec.usage.tokens -
    reconstruction.budget.spec.held.tokens;
  const availableCost =
    reconstruction.budget.spec.limits.maxCostUnits -
    reconstruction.budget.spec.usage.costUnits -
    reconstruction.budget.spec.held.costUnits;
  if (
    !reconstruction.activationReady ||
    reconstruction.runState.spec.status !== "ready" ||
    availableCalls < 1 ||
    availableTokens < 1 ||
    availableCost < capability.limits.maxCostUnits
  ) {
    return refusal({
      reconstruction,
      code: "ACTIVATION_REQUIRED",
      status: "reconciliation-required",
      ruleId: "demo.selection.activation",
      message: "Current activation, concurrency, or budget authority is insufficient.",
      evaluatedAt: input.evaluatedAt
    });
  }
  const resolvedSelectionPolicyDigest = selectionPolicyDigest({
    policy,
    projectPolicy,
    workAccord: reconstruction.authority.workAccord,
    phaseContractDigest,
    stageAgentBindingsDigest:
      reconstruction.authority.contracts.bindings.contentDigest,
    stagePolicy: entry
  });
  const selectionKey = digest({
    demoProjectId: reconstruction.runState.spec.demoProjectId,
    projectNodeId: observation.projectNodeId,
    projectItemNodeId: observation.projectItemNodeId,
    stageId: reconstruction.currentStage.stageId,
    authorityEpoch: reconstruction.runState.spec.authorityEpoch,
    generation: reconstruction.runState.spec.generation,
    runId: reconstruction.runState.spec.runId,
    runAttempt: reconstruction.runState.spec.runAttempt,
    receiptHead: reconstruction.runState.spec.journey.previousStageReceiptDigest,
    selectionPolicyDigest: resolvedSelectionPolicyDigest
  });
  if (input.grantStore.supportsAtomicCreate !== true) {
    fail("stage-agent selection requires an atomic durable grant store");
  }
  const grantExpiresAt = new Date(
    Math.min(
      expiresAt,
      Date.parse(reconstruction.activationLease.expiresAt),
      Date.parse(reconstruction.budget.spec.expiresAt)
    )
  ).toISOString();
  const spec: SignedStageAgentSelectionGrant["spec"] = {
    demoProjectId: reconstruction.runState.spec.demoProjectId,
    stageId: reconstruction.currentStage.stageId,
    selectionKey,
    optionKey,
    projectNodeId: observation.projectNodeId,
    projectItemNodeId: observation.projectItemNodeId,
    projectBindingDigest:
      reconstruction.authority.contracts.profile.spec.projectBindingDigest,
    repositoryId: reconstruction.runState.spec.repositoryId,
    workItemNodeId: reconstruction.runState.spec.workItemNodeId,
    authorityEpoch: reconstruction.runState.spec.authorityEpoch,
    generation: reconstruction.runState.spec.generation,
    runId: reconstruction.runState.spec.runId,
    runAttempt: reconstruction.runState.spec.runAttempt,
    receiptHead:
      reconstruction.runState.spec.journey.previousStageReceiptDigest,
    pullRequestHeadSha: currentPullRequestHead(reconstruction),
    policyGeneration: policy.spec.policyGeneration,
    selectionPolicyDigest: resolvedSelectionPolicyDigest,
    stageAgentBindingsDigest:
      reconstruction.authority.contracts.bindings.contentDigest,
    workAccordDigest: digest(reconstruction.authority.workAccord),
    phaseContractDigest,
    capabilityRegistryDigest:
      reconstruction.kernelSnapshot.capabilityRegistryDigest,
    activationLeaseDigest: digest(reconstruction.activationLease),
    budgetAuthorityDigest: demoBudgetAuthorityDigest(reconstruction.budget),
    agentId: binding.agent,
    skillId: binding.skill,
    capabilityId: binding.capability,
    workflowId: binding.workflow,
    workflowClass: binding.workflowClass,
    phase: binding.phase,
    role: binding.role,
    inputSchema: capability.inputSchema,
    outputSchema: capability.outputSchema,
    toolCeiling: {
      tools: capability.access.tools,
      shellCommands: capability.access.shellCommands,
      networkDestinations: capability.access.networkDestinations,
      mcpTools: capability.access.mcpTools,
      secretNames: capability.access.secretNames
    },
    budgetCeiling: {
      maxCalls: 1,
      maxTokens: availableTokens,
      maxCostUnits: capability.limits.maxCostUnits,
      maxDurationMs: capability.limits.timeoutMs,
      maxRetries: capability.limits.maxRetries,
      maxOutputBytes: capability.limits.maxOutputBytes,
      maxConcurrency: 1
    },
    issuedAt: input.evaluatedAt,
    expiresAt: grantExpiresAt
  };
  const unsigned: SignedStageAgentSelectionGrant = {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "SignedStageAgentSelectionGrant",
    schemaVersion: "1.0.0",
    contentDigest: demoContractContentDigest(
      "SignedStageAgentSelectionGrant",
      spec
    ),
    spec,
    signature: {
      algorithm: "ed25519",
      keyId: "pending",
      value: "cGVuZGluZw=="
    }
  };
  const proposedGrant = validateDemoContract("SignedStageAgentSelectionGrant", {
    ...unsigned,
    signature: await input.grantSigner.sign(selectionSignaturePayload(unsigned))
  });
  if (
    !input.grantVerifier.verify(
      selectionSignaturePayload(proposedGrant),
      proposedGrant.signature
    )
  ) {
    fail("trusted selection signer produced unverifiable evidence");
  }
  const claim = await input.grantStore.claim(proposedGrant);
  if (claim.status === "conflict" || claim.grant === null) {
    return refusal({
      reconstruction,
      code: "SELECTION_REPLAYED",
      status: "reconciliation-required",
      ruleId: "demo.selection.replay",
      message: "A conflicting selection already exists for this run generation.",
      evaluatedAt: input.evaluatedAt
    });
  }
  const grant = validateSignedStageAgentSelectionGrant({
    grant: claim.grant,
    verifier: input.grantVerifier,
    reconstruction,
    evaluatedAt: input.evaluatedAt,
    participationPolicy: policy,
    phaseContract
  });
  if (
    grant.spec.selectionKey !== selectionKey ||
    grant.contentDigest !== proposedGrant.contentDigest
  ) {
    return refusal({
      reconstruction,
      code: "SELECTION_REPLAYED",
      status: "reconciliation-required",
      ruleId: "demo.selection.replay",
      message: "The durable selection grant conflicts with the proposed exact candidate.",
      evaluatedAt: input.evaluatedAt
    });
  }
  const firstRead = await input.grantStore.read(selectionKey);
  const secondRead = await input.grantStore.read(selectionKey);
  if (
    firstRead === null ||
    secondRead === null ||
    firstRead.contentDigest !== grant.contentDigest ||
    secondRead.contentDigest !== grant.contentDigest ||
    canonicalJson(firstRead.spec) !== canonicalJson(grant.spec) ||
    canonicalJson(secondRead.spec) !== canonicalJson(grant.spec)
  ) {
    fail("stage-agent selection grant was not durably and stably observed");
  }
  return {
    kind: "accepted",
    status: "accepted",
    runtimeBinding: runtimeTuple(binding),
    grant,
    refusal: null
  };
}
