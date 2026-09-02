import { createPublicKey, verify as verifySignature } from "node:crypto";

import { canonicalJson, digest } from "./canonical.js";
import type { TrustedGitHubBinding } from "./github-events.js";
import { translateSafeOutput } from "./github-safe-output.js";
import type { GitHubEffectPlan, GitHubSafeOutput } from "./github-types.js";
import {
  assertTrustedDemoRuntimeBinding,
  type TrustedDemoRuntimeBinding
} from "./demo-portfolio.js";
import type {
  ActivePhaseOwner,
  CopilotRuntimeAuthorization,
  CopilotRuntimePolicy,
  CopilotRuntimeState,
  Digest,
  KernelResult
} from "./types.js";
import { assertDocument } from "./validation.js";

export interface RuntimeActivationRequest {
  readonly enabled: boolean;
  readonly eventName: "issues" | "issue_comment" | "pull_request";
  readonly eventAction: "created" | "edited" | "opened" | "reopened";
  readonly actorId: number;
  readonly actorLogin: string;
  readonly actorIsBot: boolean;
  readonly actorPermission: "admin" | "write" | "read" | "none";
  readonly repositoryId: number;
  readonly repositoryFullName: string;
  readonly workItemKind: "issue" | "pull-request";
  readonly workItemNumber: number;
  readonly workItemNodeId: string;
  readonly projectNodeId: string;
  readonly projectItemNodeId: string;
  readonly bindingDigest: Digest;
  readonly kernelBindingDigest: Digest;
  readonly workAccordSourceDigest: Digest;
  readonly phase: "framing" | "execution" | "verification";
  readonly role: "framer" | "executor" | "reviewer";
  readonly capability: string;
  readonly workflowId: string;
  readonly workflowRef: string;
  readonly workflowSha: string;
  readonly defaultBranch: string;
  readonly runId: number;
  readonly runAttempt: number;
  readonly workAccordDigest: Digest;
  readonly policyDigest: Digest;
  readonly kernelPolicyDigest: Digest;
  readonly activationLeaseDigest: Digest;
  readonly activationNonce: string;
  readonly reservedAiCredits: number;
  readonly currentHead: string | null;
}

export interface RuntimeClock {
  now(): string;
}

export interface RuntimeFreshEvidence {
  readonly state: CopilotRuntimeState;
  readonly stateSignatureVerified: boolean;
  readonly stateAuthorApplicationId: number;
  readonly stateAuthorId: number;
  readonly expectedApplicationId: number;
  readonly expectedAuthorId: number;
  readonly allowedActorIds: readonly number[];
  readonly stateCommentId: number;
  readonly stateCommentUpdatedAt: string;
  readonly stateCollectionEtag: string;
}

export interface RuntimeStateObservation {
  readonly state: CopilotRuntimeState;
  readonly commentId: number;
  readonly commentUpdatedAt: string;
  readonly collectionEtag: string;
}

export interface RuntimeAuthorizationCandidate {
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
  readonly remainingAiCredits: number;
  readonly contractRevision: number;
  readonly contractDigest: Digest;
  readonly currentHead: string | null;
  readonly executionContext: CopilotRuntimeState["executionContext"];
  readonly stateCommentId: number;
  readonly stateCommentUpdatedAt: string;
  readonly stateCollectionEtag: string;
  readonly evaluatedAt: string;
  readonly expiresAt: string;
}

export type RuntimeAuthorization = CopilotRuntimeAuthorization;

export interface RuntimeAuthorizationVerifier {
  verify(authorization: RuntimeAuthorization): boolean;
}

export interface RuntimeAuthorizationRedeemer {
  redeem(candidate: RuntimeAuthorizationCandidate): Promise<unknown>;
}

export interface RuntimeThreatEvidence {
  readonly status: "success" | "warning" | "failure" | "skipped" | "cancelled";
  readonly inputDigest: Digest;
  readonly outputDigest: Digest;
  readonly checkedAt: string;
}

const expectedStateByPhase = {
  framing: "FRAMING",
  execution: "EXECUTING",
  verification: "VERIFYING"
} as const;

const RUNTIME_STATE_SIGNATURE_DOMAIN =
  "agentic-framework.runtime-state-signature.v2";
const RUNTIME_AUTHORIZATION_SIGNATURE_DOMAIN =
  "agentic-framework.runtime-authorization-signature.v2";
const RUNTIME_AUTHORIZATION_DIGEST_DOMAIN =
  "agentic-framework.runtime-authorization-digest.v2";
const RUNTIME_CANDIDATE_DIGEST_DOMAIN =
  "agentic-framework.runtime-authorization-candidate.v2";
const RUNTIME_INPUT_DIGEST_DOMAIN =
  "agentic-framework.runtime-pre-activation-input.v2";
const RUNTIME_REDEMPTION_KEY_DOMAIN =
  "agentic-framework.runtime-redemption-key.v2";
const RUNTIME_LEDGER_HEAD_DOMAIN =
  "agentic-framework.runtime-redemption-ledger-head.v2";

export const COPILOT_RUNTIME_WIRE_SCHEMA_VERSION = "2.0.0" as const;

export interface CopilotRuntimeWireMigrationPlan {
  readonly kind: "CopilotRuntimeState" | "CopilotRuntimeAuthorization";
  readonly fromVersion: string;
  readonly toVersion: typeof COPILOT_RUNTIME_WIRE_SCHEMA_VERSION;
  readonly action: "none" | "reissue";
  readonly reasonCode: "CURRENT" | "SIGNED_EVIDENCE_REISSUE_REQUIRED";
}

export function planCopilotRuntimeWireMigration(input: {
  readonly kind: CopilotRuntimeWireMigrationPlan["kind"];
  readonly fromVersion: string;
}): CopilotRuntimeWireMigrationPlan {
  if (input.fromVersion === COPILOT_RUNTIME_WIRE_SCHEMA_VERSION) {
    return Object.freeze({
      kind: input.kind,
      fromVersion: input.fromVersion,
      toVersion: COPILOT_RUNTIME_WIRE_SCHEMA_VERSION,
      action: "none",
      reasonCode: "CURRENT"
    });
  }
  if (input.fromVersion === "1.0.0") {
    return Object.freeze({
      kind: input.kind,
      fromVersion: input.fromVersion,
      toVersion: COPILOT_RUNTIME_WIRE_SCHEMA_VERSION,
      action: "reissue",
      reasonCode: "SIGNED_EVIDENCE_REISSUE_REQUIRED"
    });
  }
  fail(
    "runtime.wire-version",
    `runtime ${input.kind} schema version ${input.fromVersion} is unsupported`
  );
}

const allowedEventsByPhase = {
  framing: new Set([
    "issues:opened",
    "issues:edited",
    "issues:reopened",
    "issue_comment:created",
    "issue_comment:edited"
  ]),
  execution: new Set([
    "issue_comment:created",
    "issue_comment:edited"
  ]),
  verification: new Set([
    "issue_comment:created",
    "issue_comment:edited"
  ])
} as const;

function validateExecutionContext(state: CopilotRuntimeState): void {
  const context = state.executionContext;
  if ((state.phase === "execution") !== (context !== null)) {
    fail(
      "activation.execution-context",
      "only execution state may carry a signed execution context"
    );
  }
  if (context === null) return;
  if (
    context.planningArtifactDigest !== digest(context.planningArtifact) ||
    context.patchSchema !== "TargetFreePatch@1.0.0"
  ) {
    fail(
      "activation.execution-context",
      "planning artifact or patch schema is not bound exactly"
    );
  }
  let accordValue: unknown;
  let grantValue: unknown;
  try {
    accordValue = JSON.parse(context.canonicalWorkAccord) as unknown;
    grantValue = JSON.parse(context.canonicalExecutionGrant) as unknown;
  } catch {
    fail("activation.execution-context", "canonical execution context is not JSON");
  }
  if (
    canonicalJson(accordValue) !== context.canonicalWorkAccord ||
    canonicalJson(grantValue) !== context.canonicalExecutionGrant ||
    digest(accordValue) !== state.workAccordDigest ||
    digest(grantValue) !== context.executionGrantDigest ||
    typeof accordValue !== "object" ||
    accordValue === null ||
    Array.isArray(accordValue) ||
    typeof grantValue !== "object" ||
    grantValue === null ||
    Array.isArray(grantValue)
  ) {
    fail(
      "activation.execution-context",
      "canonical Work Accord or execution grant digest is invalid"
    );
  }
  const accord = accordValue as Readonly<Record<string, unknown>>;
  const identity = accord.identity;
  if (
    typeof identity !== "object" ||
    identity === null ||
    Array.isArray(identity) ||
    (identity as Readonly<Record<string, unknown>>).revision !==
      state.contractRevision
  ) {
    fail(
      "activation.execution-context",
      "canonical Work Accord revision differs from the signed runtime state"
    );
  }
  const grant = grantValue as Readonly<Record<string, unknown>>;
  const targets = grant.targets;
  const verificationCommandIds = grant.verificationCommandIds;
  if (
    grant.workAccordDigest !== state.workAccordDigest ||
    grant.activationLeaseDigest !== state.activationLeaseDigest ||
    grant.routeId !== "planning.execute" ||
    !Array.isArray(targets) ||
    !Array.isArray(verificationCommandIds) ||
    context.planningArtifact.targetSlots.some(
      (slot) =>
        !targets.some(
          (target) =>
            typeof target === "object" &&
            target !== null &&
            !Array.isArray(target) &&
            (target as Readonly<Record<string, unknown>>).slot === slot
        )
    ) ||
    context.planningArtifact.verificationIds.some(
      (commandId) => !verificationCommandIds.includes(commandId)
    )
  ) {
    fail(
      "activation.execution-context",
      "signed plan is not a narrowing of the exact execution grant"
    );
  }
}

function fail(rule: string, message: string): never {
  throw new TypeError(`runtime authorization failed [${rule}]: ${message}`);
}

function requireSafePositiveInteger(value: number, rule: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(rule, "value must be a positive safe integer");
  }
}

function trustedRuntimeNow(clock: RuntimeClock, rule: string): {
  readonly text: string;
  readonly milliseconds: number;
} {
  const text = clock.now();
  const milliseconds = Date.parse(text);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== text
  ) {
    fail(rule, "trusted clock must return a canonical UTC date-time");
  }
  return { text, milliseconds };
}

function requireFreshEvidence(
  observedAt: number,
  now: number,
  maxAgeMs: number,
  rule: string
): void {
  if (
    !Number.isFinite(observedAt) ||
    observedAt > now ||
    now - observedAt > maxAgeMs
  ) {
    fail(rule, "evidence is stale or from the future");
  }
}

function verifyEd25519(
  payload: unknown,
  signature: RuntimeAuthorization["signature"],
  expectedKeyId: string,
  encodedPublicKey: string
): boolean {
  if (
    signature.algorithm !== "ed25519" ||
    signature.keyId !== expectedKeyId ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(encodedPublicKey) ||
    encodedPublicKey.length % 4 !== 0
  ) {
    return false;
  }
  try {
    const key = createPublicKey({
      key: Buffer.from(encodedPublicKey, "base64"),
      format: "der",
      type: "spki"
    });
    return verifySignature(
      null,
      Buffer.from(canonicalJson(payload)),
      key,
      Buffer.from(signature.value, "base64")
    );
  } catch {
    return false;
  }
}

export function runtimeStateSigningPayload(
  state: CopilotRuntimeState
): {
  readonly domain: typeof RUNTIME_STATE_SIGNATURE_DOMAIN;
  readonly state: Omit<CopilotRuntimeState, "signature">;
} {
  const { signature: _signature, ...payload } = state;
  return {
    domain: RUNTIME_STATE_SIGNATURE_DOMAIN,
    state: payload
  };
}

export function verifyRuntimeStateSignature(
  state: CopilotRuntimeState,
  expectedKeyId: string,
  encodedPublicKey: string
): boolean {
  return verifyEd25519(
    runtimeStateSigningPayload(state),
    state.signature,
    expectedKeyId,
    encodedPublicKey
  );
}

export function runtimeAuthorizationSigningPayload(
  authorization: RuntimeAuthorization
): {
  readonly domain: typeof RUNTIME_AUTHORIZATION_SIGNATURE_DOMAIN;
  readonly authorization: Omit<RuntimeAuthorization, "signature">;
} {
  const { signature: _signature, ...payload } = authorization;
  return {
    domain: RUNTIME_AUTHORIZATION_SIGNATURE_DOMAIN,
    authorization: payload
  };
}

export function runtimeAuthorizationDigest(
  authorization: RuntimeAuthorization
): Digest {
  const {
    authorizationDigest: _authorizationDigest,
    signature: _signature,
    ...payload
  } = authorization;
  return digest({
    domain: RUNTIME_AUTHORIZATION_DIGEST_DOMAIN,
    authorization: payload
  });
}

export function verifyRuntimeAuthorizationSignature(
  authorization: RuntimeAuthorization,
  expectedKeyId: string,
  encodedPublicKey: string
): boolean {
  return verifyEd25519(
    runtimeAuthorizationSigningPayload(authorization),
    authorization.signature,
    expectedKeyId,
    encodedPublicKey
  );
}

export function githubLastPage(linkHeader: string | null): number {
  if (linkHeader === null || linkHeader.trim().length === 0) return 1;
  let lastPage = 1;
  for (const part of linkHeader.split(",")) {
    const match = /^\s*<([^>]+)>;\s*rel="([^"]+)"\s*$/u.exec(part);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    if (match[2].split(/\s+/u).includes("next")) {
      const page = Number(new URL(match[1]).searchParams.get("page"));
      if (Number.isSafeInteger(page) && page > lastPage) lastPage = page;
    }
    if (match[2].split(/\s+/u).includes("last")) {
      const page = Number(new URL(match[1]).searchParams.get("page"));
      if (!Number.isSafeInteger(page) || page < 1) {
        fail("activation.pagination", "GitHub comment pagination is malformed");
      }
      lastPage = page;
    }
  }
  return lastPage;
}

export function runtimeMaximumReservation(
  policy: CopilotRuntimePolicy
): number {
  const mainInvocations = 1 + policy.limits.maxContinuations;
  const cascades = 1 + policy.limits.maxCascadeRuns;
  const reservation =
    (policy.limits.maxAiCredits * mainInvocations +
      policy.limits.maxThreatDetectionAiCredits) *
    cascades;
  if (
    !Number.isSafeInteger(reservation) ||
    reservation < 1 ||
    reservation > policy.limits.maxDailyAiCredits
  ) {
    fail(
      "activation.cost-policy",
      "maximum run, continuation, cascade, and threat budget exceeds daily policy"
    );
  }
  return reservation;
}

export function validateStableRuntimeStateObservation(
  initial: RuntimeStateObservation,
  confirmed: RuntimeStateObservation
): void {
  if (
    initial.collectionEtag.length === 0 ||
    confirmed.collectionEtag.length === 0 ||
    initial.collectionEtag !== confirmed.collectionEtag ||
    initial.commentId !== confirmed.commentId ||
    initial.commentUpdatedAt !== confirmed.commentUpdatedAt ||
    initial.state.currentHead !== confirmed.state.currentHead ||
    digest(initial.state) !== digest(confirmed.state)
  ) {
    fail("activation.state-race", "trusted runtime state changed before redemption");
  }
}

function candidatePayload(
  candidate: Omit<RuntimeAuthorizationCandidate, "candidateDigest">
): Omit<RuntimeAuthorizationCandidate, "candidateDigest"> {
  return candidate;
}

export function runtimeAuthorizationCandidateDigest(
  candidate: Omit<RuntimeAuthorizationCandidate, "candidateDigest">
): Digest {
  return digest({
    domain: RUNTIME_CANDIDATE_DIGEST_DOMAIN,
    candidate: candidatePayload(candidate)
  });
}

export function runtimeKernelBindingDigest(input: {
  readonly repositoryId: number;
  readonly workItemNodeId: string;
  readonly workAccordSourceDigest: Digest;
}): Digest {
  requireSafePositiveInteger(input.repositoryId, "activation.repository");
  if (
    input.workItemNodeId.length === 0 ||
    !/^sha256:[0-9a-f]{64}$/u.test(input.workAccordSourceDigest)
  ) {
    fail(
      "activation.binding",
      "Kernel binding source identity is malformed"
    );
  }
  return digest({
    repositoryId: input.repositoryId,
    sourceDigest: input.workAccordSourceDigest,
    workItemNodeId: input.workItemNodeId
  });
}

export function validateRuntimePreActivation(
  policyValue: unknown,
  request: RuntimeActivationRequest,
  evidence: RuntimeFreshEvidence,
  kernelPolicyValue: unknown,
  clock: RuntimeClock,
  trustedDemoBindings: readonly TrustedDemoRuntimeBinding[] = []
): RuntimeAuthorizationCandidate {
  const policy = assertDocument("CopilotRuntimePolicy", policyValue);
  const kernelPolicy = assertDocument("ControlPolicy", kernelPolicyValue);
  const state = assertDocument("CopilotRuntimeState", evidence.state);
  const now = trustedRuntimeNow(clock, "activation.clock");
  validateExecutionContext(state);
  if (!evidence.stateSignatureVerified) {
    fail("activation.state-signature", "runtime state signature is invalid");
  }
  if (policy.metadata.enabledByDefault || !request.enabled) {
    fail("activation.enabled", "runtime is not explicitly enabled");
  }
  if (
    !allowedEventsByPhase[request.phase].has(
      `${request.eventName}:${request.eventAction}`
    )
  ) {
    fail("activation.event", "event is not an allowed default-branch command trigger");
  }
  if (request.actorIsBot || !evidence.allowedActorIds.includes(request.actorId)) {
    fail("activation.actor", "actor is not an allowlisted human");
  }
  if (request.actorPermission !== "admin" && request.actorPermission !== "write") {
    fail("activation.permission", "legacy write or admin permission is required");
  }
  if (
    evidence.stateAuthorApplicationId !== evidence.expectedApplicationId ||
    evidence.stateAuthorId !== evidence.expectedAuthorId
  ) {
    fail("activation.state-author", "runtime state was not emitted by the trusted GitHub App");
  }
  if (
    state.repositoryId !== request.repositoryId ||
    state.repositoryFullName !== request.repositoryFullName ||
    state.workItemNodeId !== request.workItemNodeId ||
    state.projectNodeId !== request.projectNodeId ||
    state.projectItemNodeId !== request.projectItemNodeId
  ) {
    fail("activation.binding", "fresh repository, work-item, or Project binding differs");
  }
  if (
    state.bindingDigest !== request.bindingDigest ||
    state.kernelBindingDigest !== request.kernelBindingDigest ||
    state.workAccordSourceDigest !== request.workAccordSourceDigest ||
    state.kernelBindingDigest !==
      runtimeKernelBindingDigest({
        repositoryId: request.repositoryId,
        workItemNodeId: request.workItemNodeId,
        workAccordSourceDigest: request.workAccordSourceDigest
      }) ||
    state.bindingDigest === state.kernelBindingDigest
  ) {
    fail(
      "activation.binding",
      "trusted GitHub and Kernel binding domains are missing, stale, or swapped"
    );
  }
  if (
    state.phase !== request.phase ||
    state.role !== request.role ||
    state.capability !== request.capability ||
    state.state !== expectedStateByPhase[request.phase]
  ) {
    fail("activation.phase", "state, phase, role, or capability binding differs");
  }
  const coreBindings = policy.phaseBindings.filter(
    (candidate) =>
      candidate.phase === request.phase &&
      candidate.role === request.role &&
      candidate.capability === request.capability
  );
  const trustedBindings = trustedDemoBindings.map(
    assertTrustedDemoRuntimeBinding
  );
  for (const field of ["agent", "capability", "workflow"] as const) {
    const values = trustedBindings.map((candidate) => candidate[field]);
    if (new Set(values).size !== values.length) {
      fail(
        "activation.binding",
        `trusted runtime ${field} bindings are not globally injective`
      );
    }
  }
  const demoBindings = trustedBindings.filter(
    (candidate) =>
      candidate.source === "demo" &&
      candidate.demoProjectId !== null &&
      candidate.stageId !== null &&
      candidate.phase === request.phase &&
      candidate.role === request.role &&
      candidate.capability === request.capability
  );
  const matchingBindings = [...coreBindings, ...demoBindings];
  const binding = matchingBindings[0];
  if (
    matchingBindings.length !== 1 ||
    binding === undefined ||
    !binding.modelInvocationAllowed ||
    binding.workflow === null ||
    binding.workflow !== request.workflowId ||
    state.workflowId !== request.workflowId
  ) {
    fail("activation.role-binding", "runtime policy does not grant this workflow model role");
  }
  const expectedWorkflowRef =
    `${request.repositoryFullName}/.github/workflows/${request.workflowId}.lock.yml` +
    `@refs/heads/${request.defaultBranch}`;
  if (
    request.workflowRef !== expectedWorkflowRef ||
    !/^[a-f0-9]{40}$/u.test(request.workflowSha)
  ) {
    fail("activation.workflow-source", "workflow is not executing from the trusted default branch");
  }
  requireSafePositiveInteger(request.runId, "activation.run");
  requireSafePositiveInteger(request.runAttempt, "activation.run");
  requireSafePositiveInteger(request.workItemNumber, "activation.work-item");
  requireSafePositiveInteger(evidence.stateCommentId, "activation.state-comment");
  const stateCommentUpdatedAt = Date.parse(evidence.stateCommentUpdatedAt);
  if (
    evidence.stateCollectionEtag.length === 0 ||
    !Number.isFinite(stateCommentUpdatedAt)
  ) {
    fail("activation.state-observation", "stable state comment evidence is invalid");
  }
  if (
    state.workAccordDigest !== request.workAccordDigest ||
    state.policyDigest !== request.policyDigest ||
    state.kernelPolicyDigest !== request.kernelPolicyDigest ||
    state.activationLeaseDigest !== request.activationLeaseDigest ||
    state.activationNonce !== request.activationNonce
  ) {
    fail("activation.policy", "Work Accord, policy, lease, or nonce is stale");
  }
  if (
    state.kernelRouteId.length === 0 ||
    state.currentHead !== request.currentHead
  ) {
    fail("activation.current-head", "route or pull-request head is stale");
  }
  if (request.policyDigest !== digest(policy)) {
    fail("activation.policy-integrity", "runtime policy digest differs from checked-out policy");
  }
  if (request.kernelPolicyDigest !== digest(kernelPolicy)) {
    fail(
      "activation.kernel-policy-integrity",
      "Control Kernel policy digest differs from the administrator anchor"
    );
  }
  const reservation = runtimeMaximumReservation(policy);
  if (
    request.reservedAiCredits !== reservation ||
    state.remainingAiCredits < reservation ||
    state.remainingAiCredits > policy.limits.maxDailyAiCredits
  ) {
    fail(
      "activation.cost",
      "full run, continuation, cascade, and threat budget is not reserved"
    );
  }
  requireFreshEvidence(
    stateCommentUpdatedAt,
    now.milliseconds,
    policy.limits.maxEvidenceAgeMs,
    "activation.state-freshness"
  );
  if (
    state.repairCount > policy.limits.maxRepairLoops ||
    state.recursionDepth > policy.limits.maxRecursionDepth
  ) {
    fail("activation.loop", "repair or recursion limit is exhausted");
  }
  const expiresAt = Date.parse(state.expiresAt);
  if (!Number.isFinite(expiresAt) || now.milliseconds >= expiresAt) {
    fail("activation.expiry", "Activation Lease is expired or time evidence is invalid");
  }
  const stateDigest = digest(state);
  const inputDigest = digest({
    domain: RUNTIME_INPUT_DIGEST_DOMAIN,
    input: {
      request,
      stateCommentId: evidence.stateCommentId,
      stateCommentUpdatedAt: evidence.stateCommentUpdatedAt,
      stateCollectionEtag: evidence.stateCollectionEtag,
      stateDigest
    }
  });
  const candidate = candidatePayload({
    inputDigest,
    stateDigest,
    policyDigest: request.policyDigest,
    kernelPolicyDigest: request.kernelPolicyDigest,
    bindingDigest: state.bindingDigest,
    kernelBindingDigest: state.kernelBindingDigest,
    workAccordSourceDigest: state.workAccordSourceDigest,
    repositoryId: request.repositoryId,
    repositoryFullName: request.repositoryFullName,
    workItemKind: request.workItemKind,
    workItemNumber: request.workItemNumber,
    workItemNodeId: request.workItemNodeId,
    projectNodeId: request.projectNodeId,
    projectItemNodeId: request.projectItemNodeId,
    kernelReceiptDigest: state.kernelReceiptDigest,
    routeId: state.kernelRouteId,
    phase: request.phase,
    role: request.role,
    capability: request.capability,
    workflowId: request.workflowId,
    workflowRef: request.workflowRef,
    workflowSha: request.workflowSha,
    runId: request.runId,
    runAttempt: request.runAttempt,
    eventName: request.eventName,
    eventAction: request.eventAction,
    actorId: request.actorId,
    actorLogin: request.actorLogin,
    activationLeaseDigest: request.activationLeaseDigest,
    activationNonce: request.activationNonce,
    reservedAiCredits: reservation,
    remainingAiCredits: state.remainingAiCredits,
    contractRevision: state.contractRevision,
    contractDigest: state.workAccordDigest,
    currentHead: state.currentHead,
    executionContext: state.executionContext,
    stateCommentId: evidence.stateCommentId,
    stateCommentUpdatedAt: evidence.stateCommentUpdatedAt,
    stateCollectionEtag: evidence.stateCollectionEtag,
    evaluatedAt: now.text,
    expiresAt: state.expiresAt
  });
  return {
    ...candidate,
    candidateDigest: runtimeAuthorizationCandidateDigest(candidate)
  };
}

export function runtimeRedemptionKey(
  candidate: Pick<
    RuntimeAuthorizationCandidate,
    | "activationLeaseDigest"
    | "activationNonce"
    | "bindingDigest"
    | "kernelBindingDigest"
    | "repositoryId"
    | "runAttempt"
    | "runId"
    | "workflowId"
    | "workAccordSourceDigest"
    | "workItemNodeId"
  >
): Digest {
  return digest({
    domain: RUNTIME_REDEMPTION_KEY_DOMAIN,
    redemption: {
      activationLeaseDigest: candidate.activationLeaseDigest,
      activationNonce: candidate.activationNonce,
      bindingDigest: candidate.bindingDigest,
      kernelBindingDigest: candidate.kernelBindingDigest,
      repositoryId: candidate.repositoryId,
      runAttempt: candidate.runAttempt,
      runId: candidate.runId,
      workflowId: candidate.workflowId,
      workAccordSourceDigest: candidate.workAccordSourceDigest,
      workItemNodeId: candidate.workItemNodeId
    }
  });
}

export function runtimeRedemptionLedgerHead(
  authorization: Pick<
    RuntimeAuthorization,
    | "bindingDigest"
    | "candidateDigest"
    | "kernelBindingDigest"
    | "ledgerHeadBefore"
    | "ledgerVersion"
    | "redemptionKey"
    | "remainingAiCreditsAfter"
    | "workAccordSourceDigest"
  >
): Digest {
  return digest({
    domain: RUNTIME_LEDGER_HEAD_DOMAIN,
    ledger: {
      bindingDigest: authorization.bindingDigest,
      candidateDigest: authorization.candidateDigest,
      kernelBindingDigest: authorization.kernelBindingDigest,
      ledgerHeadBefore: authorization.ledgerHeadBefore,
      ledgerVersion: authorization.ledgerVersion,
      redemptionKey: authorization.redemptionKey,
      remainingAiCreditsAfter: authorization.remainingAiCreditsAfter,
      workAccordSourceDigest: authorization.workAccordSourceDigest
    }
  });
}

export function validateRuntimeAuthorizationIntegrity(
  authorizationValue: unknown,
  verifier: RuntimeAuthorizationVerifier
): RuntimeAuthorization {
  const authorization = assertDocument(
    "CopilotRuntimeAuthorization",
    authorizationValue
  );
  if (
    authorization.authorizationDigest !==
      runtimeAuthorizationDigest(authorization) ||
    authorization.bindingDigest === authorization.kernelBindingDigest ||
    authorization.kernelBindingDigest !==
      runtimeKernelBindingDigest({
        repositoryId: authorization.repositoryId,
        workItemNodeId: authorization.workItemNodeId,
        workAccordSourceDigest: authorization.workAccordSourceDigest
      })
  ) {
    fail("bridge.authorization-integrity", "authorization digest is invalid");
  }
  if (!verifier.verify(authorization)) {
    fail("bridge.authorization-signature", "trusted redeemer signature is invalid");
  }
  if (
    authorization.remainingAiCreditsBefore -
      authorization.reservedAiCredits !==
      authorization.remainingAiCreditsAfter ||
    authorization.ledgerHeadAfter !== runtimeRedemptionLedgerHead(authorization)
  ) {
    fail("bridge.redemption-accounting", "redemption accounting or CAS head is invalid");
  }
  return authorization;
}

function validateCandidateBinding(
  candidate: RuntimeAuthorizationCandidate,
  authorization: RuntimeAuthorization
): void {
  const expected = {
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
    contractRevision: candidate.contractRevision,
    contractDigest: candidate.contractDigest,
    currentHead: candidate.currentHead,
    executionContext: candidate.executionContext,
    stateCommentId: candidate.stateCommentId,
    stateCommentUpdatedAt: candidate.stateCommentUpdatedAt,
    stateCollectionEtag: candidate.stateCollectionEtag,
    expiresAt: candidate.expiresAt
  };
  const actual = {
    candidateDigest: authorization.candidateDigest,
    inputDigest: authorization.inputDigest,
    stateDigest: authorization.stateDigest,
    policyDigest: authorization.policyDigest,
    kernelPolicyDigest: authorization.kernelPolicyDigest,
    bindingDigest: authorization.bindingDigest,
    kernelBindingDigest: authorization.kernelBindingDigest,
    workAccordSourceDigest: authorization.workAccordSourceDigest,
    repositoryId: authorization.repositoryId,
    repositoryFullName: authorization.repositoryFullName,
    workItemKind: authorization.workItemKind,
    workItemNumber: authorization.workItemNumber,
    workItemNodeId: authorization.workItemNodeId,
    projectNodeId: authorization.projectNodeId,
    projectItemNodeId: authorization.projectItemNodeId,
    kernelReceiptDigest: authorization.kernelReceiptDigest,
    routeId: authorization.routeId,
    phase: authorization.phase,
    role: authorization.role,
    capability: authorization.capability,
    workflowId: authorization.workflowId,
    workflowRef: authorization.workflowRef,
    workflowSha: authorization.workflowSha,
    runId: authorization.runId,
    runAttempt: authorization.runAttempt,
    eventName: authorization.eventName,
    eventAction: authorization.eventAction,
    actorId: authorization.actorId,
    actorLogin: authorization.actorLogin,
    activationLeaseDigest: authorization.activationLeaseDigest,
    activationNonce: authorization.activationNonce,
    reservedAiCredits: authorization.reservedAiCredits,
    remainingAiCreditsBefore: authorization.remainingAiCreditsBefore,
    contractRevision: authorization.contractRevision,
    contractDigest: authorization.contractDigest,
    currentHead: authorization.currentHead,
    executionContext: authorization.executionContext,
    stateCommentId: authorization.stateCommentId,
    stateCommentUpdatedAt: authorization.stateCommentUpdatedAt,
    stateCollectionEtag: authorization.stateCollectionEtag,
    expiresAt: authorization.expiresAt
  };
  if (digest(actual) !== digest(expected)) {
    fail("activation.redemption-binding", "redeemed authorization differs from the candidate");
  }
}

export async function redeemRuntimeAuthorization(
  candidate: RuntimeAuthorizationCandidate,
  redeemer: RuntimeAuthorizationRedeemer,
  verifier: RuntimeAuthorizationVerifier,
  clock: RuntimeClock,
  policy: CopilotRuntimePolicy
): Promise<RuntimeAuthorization> {
  const now = trustedRuntimeNow(clock, "activation.redemption-clock");
  if (candidate.policyDigest !== digest(policy)) {
    fail("activation.redemption-policy", "candidate policy differs from trusted policy");
  }
  const authorization = validateRuntimeAuthorizationIntegrity(
    await redeemer.redeem(candidate),
    verifier
  );
  validateCandidateBinding(candidate, authorization);
  if (
    authorization.stateRevoked ||
    authorization.leaseRevoked ||
    !authorization.projectBindingVerified ||
    authorization.casResult !== "appended"
  ) {
    fail("activation.redemption-status", "redeemer did not authorize active bound state");
  }
  if (
    authorization.redemptionKey !== runtimeRedemptionKey(candidate) ||
    authorization.outputSchema !==
      (candidate.phase === "execution"
        ? "TargetFreePatch@1.0.0"
        : "GitHubSafeOutput@1.0.0")
  ) {
    fail("activation.redemption-key", "redemption key or output schema differs");
  }
  const evaluatedAt = Date.parse(candidate.evaluatedAt);
  const stateCheckedAt = Date.parse(authorization.stateCheckedAt);
  const leaseCheckedAt = Date.parse(authorization.leaseCheckedAt);
  const redeemedAt = Date.parse(authorization.redeemedAt);
  const expiresAt = Date.parse(authorization.expiresAt);
  if (
    !Number.isFinite(evaluatedAt) ||
    !Number.isFinite(stateCheckedAt) ||
    !Number.isFinite(leaseCheckedAt) ||
    !Number.isFinite(redeemedAt) ||
    !Number.isFinite(expiresAt) ||
    stateCheckedAt < evaluatedAt ||
    leaseCheckedAt < evaluatedAt ||
    stateCheckedAt > redeemedAt ||
    leaseCheckedAt > redeemedAt ||
    redeemedAt > now.milliseconds ||
    now.milliseconds >= expiresAt
  ) {
    fail("activation.redemption-freshness", "redemption or revocation evidence is stale");
  }
  requireFreshEvidence(
    redeemedAt,
    now.milliseconds,
    policy.limits.maxEvidenceAgeMs,
    "activation.redemption-freshness"
  );
  requireFreshEvidence(
    stateCheckedAt,
    now.milliseconds,
    policy.limits.maxEvidenceAgeMs,
    "activation.redemption-freshness"
  );
  requireFreshEvidence(
    leaseCheckedAt,
    now.milliseconds,
    policy.limits.maxEvidenceAgeMs,
    "activation.redemption-freshness"
  );
  return authorization;
}

export function bindKernelAuthorization(
  authorization: RuntimeAuthorization,
  kernelResult: KernelResult,
  verifier: RuntimeAuthorizationVerifier,
  policy: CopilotRuntimePolicy
): RuntimeAuthorization {
  validateRuntimeAuthorizationIntegrity(authorization, verifier);
  if (authorization.policyDigest !== digest(policy)) {
    fail("bridge.policy", "runtime policy differs from signed authorization");
  }
  if (
    kernelResult === null ||
    typeof kernelResult !== "object" ||
    kernelResult.kind !== "applied"
  ) {
    fail("bridge.kernel-result", "Control Kernel did not apply an authorized route");
  }
  const expectedHead =
    authorization.currentHead === null ? null : digest(authorization.currentHead);
  const processed = kernelResult.snapshot.processedEvents[kernelResult.receipt.eventId];
  if (processed === undefined) {
    fail("bridge.kernel-receipt", "Control Kernel snapshot omits the applied event");
  }
  if (
    digest(kernelResult.receipt) !== kernelResult.receiptDigest ||
    kernelResult.receiptDigest !== authorization.kernelReceiptDigest ||
    kernelResult.route.id !== authorization.routeId ||
    kernelResult.receipt.routeId !== authorization.routeId ||
    kernelResult.receipt.routeVersion !== kernelResult.route.version ||
    kernelResult.receipt.from !== kernelResult.route.from ||
    kernelResult.receipt.to !== kernelResult.route.to ||
    kernelResult.snapshot.state !== kernelResult.route.to ||
    kernelResult.snapshot.phaseOwner !== kernelResult.route.phaseOwner ||
    kernelResult.snapshot.stateVersion !== kernelResult.receipt.stateVersion ||
    kernelResult.snapshot.receiptHead !== kernelResult.receiptDigest ||
    kernelResult.snapshot.bindingDigest !== authorization.kernelBindingDigest ||
    kernelResult.receipt.destinationBindingDigest !==
      authorization.kernelBindingDigest ||
    kernelResult.snapshot.workAccordDigest !== authorization.contractDigest ||
    kernelResult.receipt.destinationWorkAccordDigest !==
      authorization.contractDigest ||
    kernelResult.snapshot.currentHead !== expectedHead ||
    kernelResult.snapshot.lifecycleGraphDigest !==
      kernelResult.receipt.destinationLifecycleGraphDigest ||
    kernelResult.snapshot.capabilityRegistryDigest !==
      kernelResult.receipt.destinationCapabilityRegistryDigest ||
    kernelResult.snapshot.domainPackDigest !==
      kernelResult.receipt.destinationDomainPackDigest ||
    kernelResult.snapshot.phaseContractDigest !==
      kernelResult.receipt.destinationPhaseContractDigest ||
    kernelResult.snapshot.compiledPolicyDigest !==
      kernelResult.receipt.destinationCompiledPolicyDigest ||
    kernelResult.snapshot.policyDigest !== authorization.kernelPolicyDigest ||
    kernelResult.receipt.destinationPolicyDigest !==
      authorization.kernelPolicyDigest ||
    kernelResult.receipt.effectPlanDigest !== digest(kernelResult.effects) ||
    processed.receiptDigest !== kernelResult.receiptDigest ||
    processed.eventDigest !== kernelResult.receipt.eventDigest ||
    processed.idempotencyKey !== kernelResult.receipt.idempotencyKey
  ) {
    fail(
      "bridge.kernel-receipt",
      "Control Kernel result, receipt, binding, head, contract, or policy is inconsistent"
    );
  }
  const phaseEffect = kernelResult.effects.find(
    (
      effect
    ): effect is Extract<(typeof kernelResult.effects)[number], { type: "enter-phase" }> =>
      effect.type === "enter-phase" && effect.phase === authorization.phase
  );
  if (
    phaseEffect === undefined ||
    !phaseEffect.capabilities.some(
      (capability) => capability.reference === authorization.capability
    )
  ) {
    fail("bridge.capability-grant", "Control Kernel did not grant the bound capability");
  }
  return authorization;
}

export function bridgeRuntimeOutput(input: {
  readonly authorization: RuntimeAuthorization;
  readonly authorizationVerifier: RuntimeAuthorizationVerifier;
  readonly kernelResult: KernelResult;
  readonly policy: CopilotRuntimePolicy;
  readonly redemptionDigest: Digest;
  readonly threatEvidence: RuntimeThreatEvidence;
  readonly output: GitHubSafeOutput;
  readonly binding: TrustedGitHubBinding;
  readonly eventId: string;
  readonly receiptHead: Digest | null;
  readonly attempt: number;
  readonly clock: RuntimeClock;
  readonly trustedDemoBinding?: TrustedDemoRuntimeBinding;
}): GitHubEffectPlan {
  const output = assertDocument("GitHubSafeOutput", input.output);
  const authorization = bindKernelAuthorization(
    input.authorization,
    input.kernelResult,
    input.authorizationVerifier,
    input.policy
  );
  if (
    input.redemptionDigest !== digest(authorization) ||
    input.eventId !== authorization.redemptionKey ||
    input.attempt !== authorization.runAttempt ||
    input.receiptHead !== authorization.kernelReceiptDigest
  ) {
    fail("bridge.redemption", "effect does not bind the exact redeemed run attempt");
  }
  if (authorization.bindingDigest !== digest(input.binding)) {
    fail("bridge.binding", "Trusted Binding differs from redemption evidence");
  }
  if (
    input.binding.workItem.kind === "pull-request"
      ? authorization.currentHead !== input.binding.workItem.head.sha
      : authorization.currentHead !== null
  ) {
    fail("bridge.current-head", "redeemed head differs from Trusted Binding");
  }
  if (input.threatEvidence.status !== "success") {
    fail("bridge.threat-detection", "exact threat-detection success evidence is required");
  }
  if (
    input.threatEvidence.inputDigest !== authorization.authorizationDigest ||
    input.threatEvidence.outputDigest !== digest(output)
  ) {
    fail("bridge.threat-evidence", "threat evidence does not bind this authorization and output");
  }
  const now = trustedRuntimeNow(input.clock, "bridge.clock");
  const checkedAt = Date.parse(input.threatEvidence.checkedAt);
  const redeemedAt = Date.parse(authorization.redeemedAt);
  const stateCheckedAt = Date.parse(authorization.stateCheckedAt);
  const leaseCheckedAt = Date.parse(authorization.leaseCheckedAt);
  const expiresAt = Date.parse(authorization.expiresAt);
  if (
    !Number.isFinite(checkedAt) ||
    !Number.isFinite(redeemedAt) ||
    !Number.isFinite(stateCheckedAt) ||
    !Number.isFinite(leaseCheckedAt) ||
    !Number.isFinite(expiresAt) ||
    stateCheckedAt > redeemedAt ||
    leaseCheckedAt > redeemedAt ||
    checkedAt < redeemedAt ||
    checkedAt > now.milliseconds ||
    now.milliseconds >= expiresAt
  ) {
    fail("bridge.freshness", "threat or authorization evidence is stale");
  }
  requireFreshEvidence(
    checkedAt,
    now.milliseconds,
    input.policy.limits.maxEvidenceAgeMs,
    "bridge.freshness"
  );
  for (const observedAt of [redeemedAt, stateCheckedAt, leaseCheckedAt]) {
    requireFreshEvidence(
      observedAt,
      now.milliseconds,
      input.policy.limits.maxEvidenceAgeMs,
      "bridge.freshness"
    );
  }
  let intent:
    | { readonly type: "issue-comment" }
    | {
        readonly type: "pull-request-review-comment";
        readonly event: "COMMENT";
      };
  if (input.trustedDemoBinding !== undefined) {
    const binding = assertTrustedDemoRuntimeBinding(
      input.trustedDemoBinding
    );
    if (
      binding.source !== "demo" ||
      binding.demoProjectId === null ||
      binding.stageId === null ||
      binding.phase !== authorization.phase ||
      binding.role !== authorization.role ||
      binding.capability !== authorization.capability ||
      binding.workflow !== authorization.workflowId ||
      binding.modelInvocationAllowed !== true
    ) {
      fail(
        "bridge.output-authority",
        "trusted demo workflow binding does not match the signed authorization"
      );
    }
    intent =
      binding.workflowClass === "framing-comment" &&
      binding.phase === "framing"
        ? { type: "issue-comment" }
        : binding.workflowClass === "current-head-comment-review" &&
            binding.phase === "verification"
          ? { type: "pull-request-review-comment", event: "COMMENT" }
          : fail(
              "bridge.output-authority",
              "trusted demo workflow class has no GitHub Safe Output adapter"
            );
  } else {
    intent =
      authorization.phase === "framing" &&
      authorization.capability === "core.frame-artifact@1.0.0"
        ? { type: "issue-comment" }
        : authorization.phase === "verification" &&
            authorization.capability === "core.review-current-head@1.0.0"
          ? { type: "pull-request-review-comment", event: "COMMENT" }
          : fail(
              "bridge.output-authority",
              "runtime phase has no authorized output adapter"
            );
  }
  return translateSafeOutput({
    output,
    intent,
    binding: input.binding,
    eventId: input.eventId,
    contractRevision: authorization.contractRevision,
    contractDigest: authorization.contractDigest,
    receiptHead: input.receiptHead,
    routeId: authorization.routeId,
    attempt: input.attempt
  });
}

export function phaseIsRuntimeManaged(
  phase: ActivePhaseOwner
): phase is "framing" | "execution" | "verification" {
  return phase === "framing" || phase === "execution" || phase === "verification";
}
