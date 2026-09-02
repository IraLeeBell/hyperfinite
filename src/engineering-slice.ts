import { createHash } from "node:crypto";
import { canonicalJson, digest } from "./canonical.js";
import type { GitHubSafeOutput } from "./github-types.js";
import { assertDocument } from "./validation.js";
import {
  assertTrustedExecutionFreshnessAuthority,
  type TrustedExecutionFreshnessAuthority
} from "./execution-bridge.js";
import type {
  ActivationLease,
  ActorClass,
  ControlPolicy,
  Digest,
  WorkAccord
} from "./types.js";
import {
  validateBoundedExecutionGrant,
  type BoundedExecutionGrant,
  type TargetFreePatch,
  type ValidatedPatch
} from "./bounded-worktree.js";

export interface TrustedClock {
  now(): string;
}

interface EngineeringFreshnessState {
  readonly clock: TrustedClock;
  readonly maxEvidenceAgeMs: 300_000;
  assertFresh(): string;
}

function engineeringFreshnessState(clock: TrustedClock): EngineeringFreshnessState {
  return {
    clock,
    maxEvidenceAgeMs: 300_000,
    assertFresh: () => clock.now()
  };
}

function runtimeFreshnessState(
  authority: ReturnType<typeof assertTrustedExecutionFreshnessAuthority>
): EngineeringFreshnessState {
  return {
    clock: authority.clock,
    maxEvidenceAgeMs: 300_000,
    assertFresh() {
      const now = authority.clock.now();
      for (const item of [
        authority.evidence.runtimeAuthorization,
        authority.evidence.threatEvidence,
        authority.evidence.patchArtifact,
        authority.evidence.patchBundle,
        ...(authority.evidence.executionBundle === null
          ? []
          : [authority.evidence.executionBundle])
      ]) {
        assertFreshWindow({
          observedAt: item.observedAt,
          expiresAt: item.expiresAt,
          now,
          maximumAgeMs: 300_000
        });
      }
      assertObservedAge({
        observedAt: authority.evidence.kernelProof.observedAt,
        now,
        maximumAgeMs: 300_000
      });
      return now;
    }
  };
}

export interface DetachedSignature {
  readonly algorithm: "ed25519";
  readonly keyId: string;
  readonly value: string;
}

export interface EvidenceSigner {
  sign(payload: unknown): Promise<DetachedSignature>;
}

export interface EvidenceVerifier {
  verify(payload: unknown, signature: DetachedSignature): boolean;
}

export class EngineeringSliceError extends Error {
  constructor(
    readonly code:
      | "BINDING_INVALID"
      | "BINDING_STALE"
      | "APPROVAL_INVALID"
      | "AUTHORIZATION_INVALID"
      | "COST_INVALID"
      | "MODEL_OUTPUT_INVALID"
      | "THREAT_BLOCKED"
      | "CONCURRENCY_CONFLICT"
      | "PARTIAL_EFFECT"
      | "CURRENT_HEAD_STALE"
      | "HUMAN_MERGE_REQUIRED"
      | "KERNEL_REFUSED",
    message: string
  ) {
    super(message);
    this.name = "EngineeringSliceError";
  }
}

function fail(
  code: EngineeringSliceError["code"],
  message: string
): never {
  throw new EngineeringSliceError(code, message);
}

function timestamp(value: string, name: string): number {
  const parsed = Date.parse(value);
  if (
    !Number.isFinite(parsed) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
  ) {
    fail("AUTHORIZATION_INVALID", `${name} must be a canonical UTC timestamp`);
  }
  return parsed;
}

const COST_RECONCILIATION_WINDOW_MS = 24 * 60 * 60 * 1_000;

function reconciliationExpiry(reservationExpiresAt: string): string {
  return new Date(
    timestamp(reservationExpiresAt, "reservation.expiresAt") +
      COST_RECONCILIATION_WINDOW_MS
  ).toISOString();
}

function assertFreshWindow(input: {
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
    now >= expiresAt ||
    now - observedAt > input.maximumAgeMs
  ) {
    fail("AUTHORIZATION_INVALID", "evidence is stale, future-dated, or expired");
  }
}

function assertObservedAge(input: {
  readonly observedAt: string;
  readonly now: string;
  readonly maximumAgeMs: number;
}): void {
  const observedAt = timestamp(input.observedAt, "observedAt");
  const now = timestamp(input.now, "now");
  if (observedAt > now || now - observedAt > input.maximumAgeMs) {
    fail("AUTHORIZATION_INVALID", "evidence is stale or future-dated");
  }
}

function assertDurableUntilExpiry(input: {
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly now: string;
}): void {
  const createdAt = timestamp(input.createdAt, "createdAt");
  const expiresAt = timestamp(input.expiresAt, "expiresAt");
  const now = timestamp(input.now, "now");
  if (createdAt > now || now >= expiresAt) {
    fail("AUTHORIZATION_INVALID", "signed durable evidence is future-dated or expired");
  }
}

export interface EngineeringPullRequestBinding {
  readonly number: number;
  readonly nodeId: string;
  readonly baseRepositoryId: number;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly headRepositoryId: number;
  readonly headRef: string;
  readonly headSha: string;
}

export interface EngineeringWorkBinding {
  readonly schemaVersion: "1.0.0";
  readonly revision: number;
  readonly repository: {
    readonly id: number;
    readonly nodeId: string;
    readonly fullName: string;
  };
  readonly issue: {
    readonly number: number;
    readonly nodeId: string;
  };
  readonly requesterActorId: string;
  readonly automationActorId: string;
  readonly project: {
    readonly ownerNodeId: string;
    readonly nodeId: string;
    readonly itemNodeId: string;
    readonly contentNodeId: string;
  };
  readonly pullRequest: EngineeringPullRequestBinding | null;
  readonly previousBindingDigest: Digest | null;
  readonly receiptHead: Digest;
}

export function bindEngineeringIntake(input: {
  readonly repository: EngineeringWorkBinding["repository"];
  readonly issue: EngineeringWorkBinding["issue"];
  readonly projectNodeId: string;
  readonly projectOwnerNodeId: string;
  readonly projectItems: readonly {
    readonly nodeId: string;
    readonly projectNodeId: string;
    readonly contentNodeId: string;
  }[];
  readonly requesterActorId: string;
  readonly automationActorId: string;
  readonly receiptHead: Digest;
}): EngineeringWorkBinding {
  if (
    !Number.isSafeInteger(input.repository.id) ||
    input.repository.id < 1 ||
    !Number.isSafeInteger(input.issue.number) ||
    input.issue.number < 1 ||
    input.repository.fullName.length < 3 ||
    input.repository.nodeId.length === 0 ||
    input.issue.nodeId.length === 0 ||
    input.projectNodeId.length === 0 ||
    input.projectOwnerNodeId.length === 0 ||
    input.requesterActorId.length === 0 ||
    input.automationActorId.length === 0 ||
    input.requesterActorId === input.automationActorId
  ) {
    fail("BINDING_INVALID", "repository, issue, or Project identity is invalid");
  }
  if (input.projectItems.length !== 1) {
    fail("BINDING_INVALID", "exactly one Project item must bind the intake Issue");
  }
  const item = input.projectItems[0];
  if (
    item === undefined ||
    item.projectNodeId !== input.projectNodeId ||
    item.contentNodeId !== input.issue.nodeId ||
    item.nodeId.length === 0
  ) {
    fail("BINDING_INVALID", "Project item does not bind the canonical intake Issue");
  }
  return {
    schemaVersion: "1.0.0",
    revision: 1,
    repository: input.repository,
    issue: input.issue,
    requesterActorId: input.requesterActorId,
    automationActorId: input.automationActorId,
    project: {
      ownerNodeId: input.projectOwnerNodeId,
      nodeId: input.projectNodeId,
      itemNodeId: item.nodeId,
      contentNodeId: item.contentNodeId
    },
    pullRequest: null,
    previousBindingDigest: null,
    receiptHead: input.receiptHead
  };
}

export function rebindEngineeringPullRequest(input: {
  readonly binding: EngineeringWorkBinding;
  readonly expectedBindingDigest: Digest;
  readonly pullRequest: EngineeringPullRequestBinding;
  readonly receiptHead: Digest;
}): EngineeringWorkBinding {
  if (
    digest(input.binding) !== input.expectedBindingDigest ||
    input.binding.pullRequest !== null
  ) {
    fail("BINDING_STALE", "pull-request binding CAS precondition failed");
  }
  const pull = input.pullRequest;
  if (
    !Number.isSafeInteger(pull.number) ||
    pull.number < 1 ||
    pull.nodeId.length === 0 ||
    pull.baseRepositoryId !== input.binding.repository.id ||
    pull.headRepositoryId !== input.binding.repository.id ||
    pull.baseRef.length === 0 ||
    pull.headRef.length === 0 ||
    !/^[0-9a-f]{40}$/u.test(pull.baseSha) ||
    !/^[0-9a-f]{40}$/u.test(pull.headSha)
  ) {
    fail("BINDING_INVALID", "pull-request binding is malformed");
  }
  return {
    ...input.binding,
    revision: input.binding.revision + 1,
    pullRequest: pull,
    previousBindingDigest: input.expectedBindingDigest,
    receiptHead: input.receiptHead
  };
}

export interface FramingArtifact {
  readonly schemaVersion: "1.0.0";
  readonly objective: string;
  readonly inScope: readonly string[];
  readonly outOfScope: readonly string[];
  readonly assumptions: readonly string[];
  readonly dependencies: readonly string[];
}

export interface PlanningArtifact {
  readonly schemaVersion: "1.0.0";
  readonly steps: readonly string[];
  readonly targetSlots: readonly string[];
  readonly verificationIds: readonly string[];
}

export type GitHubRepositoryPermission =
  | "read"
  | "triage"
  | "write"
  | "maintain"
  | "admin";

export interface SignedHumanAuthorization {
  readonly repositoryId: number;
  readonly actorId: string;
  readonly actorType: "User" | "Bot" | "App";
  readonly actorClass: ActorClass;
  readonly repositoryPermission: GitHubRepositoryPermission;
  readonly roleIds: readonly string[];
  readonly teamNodeIds: readonly string[];
  readonly controlPolicyDigest: Digest;
  readonly currentHead: string | null;
  readonly checkedAt: string;
  readonly expiresAt: string;
  readonly signature: DetachedSignature;
}

export interface SignedHumanApprovalEvent {
  readonly eventId: string;
  readonly action: "approved";
  readonly repositoryId: number;
  readonly workItemNodeId: string;
  readonly actorId: string;
  readonly actorType: "User" | "Bot" | "App";
  readonly requesterActorId: string;
  readonly automationActorId: string;
  readonly gate: "activate" | "accept-frame" | "accept-plan" | "approve-current-head";
  readonly artifactDigest: Digest;
  readonly routeId: string;
  readonly snapshotDigest: Digest;
  readonly workAccordDigest: Digest;
  readonly activationLeaseDigest: Digest;
  readonly currentHead: string | null;
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly signature: DetachedSignature;
}

export interface SignedArtifactApproval {
  readonly gate: "activate" | "accept-frame" | "accept-plan" | "approve-current-head";
  readonly artifactDigest: Digest;
  readonly routeId: string;
  readonly snapshotDigest: Digest;
  readonly workAccordDigest: Digest;
  readonly activationLeaseDigest: Digest;
  readonly repositoryId: number;
  readonly workItemNodeId: string;
  readonly eventDigest: Digest;
  readonly authorizationDigest: Digest;
  readonly actorDigest: Digest;
  readonly actorId: string;
  readonly actorType: "User";
  readonly actorPermission: GitHubRepositoryPermission;
  readonly actorRole: "repository-maintainer" | "eligible-independent-reviewer";
  readonly actorClass: "maintainer" | "reviewer";
  readonly actorRoles: readonly string[];
  readonly actorTeamNodeIds: readonly string[];
  readonly controlPolicyDigest: Digest;
  readonly approverPolicy: string;
  readonly requesterActorId: string;
  readonly automationActorId: string;
  readonly currentHead: string | null;
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly signature: DetachedSignature;
}

function approvalPayload(
  approval: SignedArtifactApproval
): Omit<SignedArtifactApproval, "signature"> {
  const { signature: _signature, ...payload } = approval;
  return payload;
}

function humanAuthorizationPayload(
  authorization: SignedHumanAuthorization
): Omit<SignedHumanAuthorization, "signature"> {
  const { signature: _signature, ...payload } = authorization;
  return payload;
}

function humanApprovalEventPayload(
  event: SignedHumanApprovalEvent
): Omit<SignedHumanApprovalEvent, "signature"> {
  const { signature: _signature, ...payload } = event;
  return payload;
}

function actorRoleForGate(
  gate: SignedArtifactApproval["gate"],
  permission: GitHubRepositoryPermission
): SignedArtifactApproval["actorRole"] | null {
  if (gate === "activate") {
    return permission === "maintain" || permission === "admin"
      ? "repository-maintainer"
      : null;
  }
  return permission === "write" ||
    permission === "maintain" ||
    permission === "admin"
    ? "eligible-independent-reviewer"
    : null;
}

function actorClassForGate(
  gate: SignedArtifactApproval["gate"]
): SignedArtifactApproval["actorClass"] {
  return gate === "activate" ? "maintainer" : "reviewer";
}

function requiredApproverRole(
  gate: SignedArtifactApproval["gate"],
  approverPolicy: string
): string {
  if (gate === "activate") return "repository-maintainer";
  if (approverPolicy === "eligible-independent-reviewer") {
    return "eligible-reviewer";
  }
  if (approverPolicy === "maintainer") return "repository-maintainer";
  if (approverPolicy.startsWith("team:") && approverPolicy.length > 5) {
    return approverPolicy;
  }
  fail("APPROVAL_INVALID", "Work Accord approver policy is not a closed supported policy");
}

export async function issueAuthenticatedArtifactApproval(input: {
  readonly event: SignedHumanApprovalEvent;
  readonly authorization: SignedHumanAuthorization;
  readonly signer: EvidenceSigner;
  readonly verifier: EvidenceVerifier;
  readonly requesterId: string;
  readonly automationActorId: string;
  readonly controlPolicy: ControlPolicy;
  readonly approverPolicy: string;
  readonly now: string;
  readonly maximumAgeMs: number;
}): Promise<SignedArtifactApproval> {
  const eventPayload = humanApprovalEventPayload(input.event);
  const authorizationPayload = humanAuthorizationPayload(input.authorization);
  const role = actorRoleForGate(
    input.event.gate,
    input.authorization.repositoryPermission
  );
  const actorClass = actorClassForGate(input.event.gate);
  const actorRule = input.controlPolicy.actorRules.find(
    (candidate) => candidate.actorClass === actorClass
  );
  const approverRole = requiredApproverRole(
    input.event.gate,
    input.approverPolicy
  );
  const requiredTeam =
    approverRole.startsWith("team:") ? approverRole.slice(5) : null;
  if (
    input.event.action !== "approved" ||
    input.event.repositoryId !== input.authorization.repositoryId ||
    input.event.actorId !== input.authorization.actorId ||
    input.event.actorType !== input.authorization.actorType ||
    input.event.actorType !== "User" ||
    input.event.requesterActorId !== input.requesterId ||
    input.event.automationActorId !== input.automationActorId ||
    input.event.actorId === input.requesterId ||
    input.event.actorId === input.automationActorId ||
    input.authorization.actorClass !== actorClass ||
    input.authorization.controlPolicyDigest !== digest(input.controlPolicy) ||
    input.authorization.currentHead !== input.event.currentHead ||
    actorRule === undefined ||
    actorRule.human !== true ||
    actorRule.requiredRoles.some(
      (requiredRole) => !input.authorization.roleIds.includes(requiredRole)
    ) ||
    (requiredTeam === null
      ? !input.authorization.roleIds.includes(approverRole)
      : !input.authorization.teamNodeIds.includes(requiredTeam)) ||
    (input.controlPolicy.independentGates.includes(input.event.gate) &&
      input.event.actorId === input.requesterId) ||
    role === null ||
    !input.verifier.verify(eventPayload, input.event.signature) ||
    !input.verifier.verify(authorizationPayload, input.authorization.signature)
  ) {
    fail(
      "APPROVAL_INVALID",
      "human approval event is unauthenticated, automated, self-issued, or unauthorized"
    );
  }
  assertFreshWindow({
    observedAt: input.event.observedAt,
    expiresAt: input.event.expiresAt,
    now: input.now,
    maximumAgeMs: input.maximumAgeMs
  });
  assertFreshWindow({
    observedAt: input.authorization.checkedAt,
    expiresAt: input.authorization.expiresAt,
    now: input.now,
    maximumAgeMs: input.maximumAgeMs
  });
  const eventDigest = digest(input.event);
  const authorizationDigest = digest(input.authorization);
  const actorDigest = digest({
    actorId: input.event.actorId,
    actorType: input.event.actorType,
    actorPermission: input.authorization.repositoryPermission,
    actorRole: role,
    actorClass,
    actorRoles: [...input.authorization.roleIds].sort(),
    actorTeamNodeIds: [...input.authorization.teamNodeIds].sort(),
    controlPolicyDigest: input.authorization.controlPolicyDigest,
    approverPolicy: input.approverPolicy,
    requesterActorId: input.requesterId,
    automationActorId: input.automationActorId,
    eventDigest,
    authorizationDigest
  });
  const expiresAt =
    timestamp(input.event.expiresAt, "event.expiresAt") <=
    timestamp(input.authorization.expiresAt, "authorization.expiresAt")
      ? input.event.expiresAt
      : input.authorization.expiresAt;
  const payload = {
    gate: input.event.gate,
    artifactDigest: input.event.artifactDigest,
    routeId: input.event.routeId,
    snapshotDigest: input.event.snapshotDigest,
    workAccordDigest: input.event.workAccordDigest,
    activationLeaseDigest: input.event.activationLeaseDigest,
    repositoryId: input.event.repositoryId,
    workItemNodeId: input.event.workItemNodeId,
    eventDigest,
    authorizationDigest,
    actorDigest,
    actorId: input.event.actorId,
    actorType: input.event.actorType,
    actorPermission: input.authorization.repositoryPermission,
    actorRole: role,
    actorClass,
    actorRoles: [...input.authorization.roleIds].sort(),
    actorTeamNodeIds: [...input.authorization.teamNodeIds].sort(),
    controlPolicyDigest: input.authorization.controlPolicyDigest,
    approverPolicy: input.approverPolicy,
    requesterActorId: input.requesterId,
    automationActorId: input.automationActorId,
    currentHead: input.event.currentHead,
    observedAt: input.event.observedAt,
    expiresAt
  } as const;
  return { ...payload, signature: await input.signer.sign(payload) };
}

export function validateArtifactApproval(input: {
  readonly approval: SignedArtifactApproval;
  readonly verifier: EvidenceVerifier;
  readonly gate: SignedArtifactApproval["gate"];
  readonly artifactDigest: Digest;
  readonly routeId: string;
  readonly snapshotDigest: Digest;
  readonly workAccordDigest: Digest;
  readonly activationLeaseDigest: Digest;
  readonly repositoryId: number;
  readonly workItemNodeId: string;
  readonly currentHead: string | null;
  readonly requesterId: string;
  readonly automationActorId: string;
  readonly controlPolicy: ControlPolicy;
  readonly approverPolicy: string;
  readonly now: string;
  readonly maximumAgeMs: number;
}): void {
  const approval = input.approval;
  const actorRule = input.controlPolicy.actorRules.find(
    (candidate) => candidate.actorClass === approval.actorClass
  );
  const approverRole = requiredApproverRole(input.gate, input.approverPolicy);
  const requiredTeam =
    approverRole.startsWith("team:") ? approverRole.slice(5) : null;
  if (
    approval.gate !== input.gate ||
    approval.artifactDigest !== input.artifactDigest ||
    approval.routeId !== input.routeId ||
    approval.snapshotDigest !== input.snapshotDigest ||
    approval.workAccordDigest !== input.workAccordDigest ||
    approval.activationLeaseDigest !== input.activationLeaseDigest ||
    approval.repositoryId !== input.repositoryId ||
    approval.workItemNodeId !== input.workItemNodeId ||
    approval.currentHead !== input.currentHead ||
    approval.actorId === input.requesterId ||
    approval.actorId === input.automationActorId ||
    approval.actorId.length === 0 ||
    approval.actorType !== "User" ||
    approval.requesterActorId !== input.requesterId ||
    approval.automationActorId !== input.automationActorId ||
    approval.controlPolicyDigest !== digest(input.controlPolicy) ||
    approval.approverPolicy !== input.approverPolicy ||
    approval.actorClass !== actorClassForGate(input.gate) ||
    actorRule === undefined ||
    actorRule.human !== true ||
    actorRule.requiredRoles.some(
      (requiredRole) => !approval.actorRoles.includes(requiredRole)
    ) ||
    (requiredTeam === null
      ? !approval.actorRoles.includes(approverRole)
      : !approval.actorTeamNodeIds.includes(requiredTeam)) ||
    (input.controlPolicy.independentGates.includes(input.gate) &&
      approval.actorId === input.requesterId) ||
    actorRoleForGate(approval.gate, approval.actorPermission) !==
      approval.actorRole ||
    approval.actorDigest !== digest({
      actorId: approval.actorId,
      actorType: approval.actorType,
      actorPermission: approval.actorPermission,
      actorRole: approval.actorRole,
      actorClass: approval.actorClass,
      actorRoles: approval.actorRoles,
      actorTeamNodeIds: approval.actorTeamNodeIds,
      controlPolicyDigest: approval.controlPolicyDigest,
      approverPolicy: approval.approverPolicy,
      requesterActorId: approval.requesterActorId,
      automationActorId: approval.automationActorId,
      eventDigest: approval.eventDigest,
      authorizationDigest: approval.authorizationDigest
    }) ||
    !input.verifier.verify(approvalPayload(approval), approval.signature)
  ) {
    fail("APPROVAL_INVALID", `${input.gate} approval is missing, substituted, or not independent`);
  }
  if (
    input.gate === "activate" &&
    approval.actorRole !== "repository-maintainer"
  ) {
    fail("APPROVAL_INVALID", "activation requires a repository maintainer");
  }
  if (
    input.gate !== "activate" &&
    approval.actorRole !== "eligible-independent-reviewer"
  ) {
    fail("APPROVAL_INVALID", `${input.gate} requires an eligible independent reviewer`);
  }
  assertFreshWindow({
    observedAt: approval.observedAt,
    expiresAt: approval.expiresAt,
    now: input.now,
    maximumAgeMs: input.maximumAgeMs
  });
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  name: string
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail("MODEL_OUTPUT_INVALID", `${name} contains unknown or missing fields`);
  }
}

function assertStrings(values: readonly string[], name: string): void {
  if (
    values.some(
      (value) => typeof value !== "string" || value.length === 0 || value.length > 8192
    )
  ) {
    fail("MODEL_OUTPUT_INVALID", `${name} contains an invalid string`);
  }
}

export function validateFramingArtifact(value: FramingArtifact): FramingArtifact {
  assertExactKeys(
    value as unknown as Readonly<Record<string, unknown>>,
    [
      "schemaVersion",
      "objective",
      "inScope",
      "outOfScope",
      "assumptions",
      "dependencies"
    ],
    "framing artifact"
  );
  if (value.schemaVersion !== "1.0.0" || value.objective.length === 0) {
    fail("MODEL_OUTPUT_INVALID", "framing artifact is invalid");
  }
  assertStrings(value.inScope, "framing inScope");
  assertStrings(value.outOfScope, "framing outOfScope");
  assertStrings(value.assumptions, "framing assumptions");
  assertStrings(value.dependencies, "framing dependencies");
  return value;
}

export function validatePlanningArtifact(value: PlanningArtifact): PlanningArtifact {
  assertExactKeys(
    value as unknown as Readonly<Record<string, unknown>>,
    ["schemaVersion", "steps", "targetSlots", "verificationIds"],
    "planning artifact"
  );
  if (
    value.schemaVersion !== "1.0.0" ||
    value.steps.length === 0 ||
    value.targetSlots.length === 0 ||
    value.verificationIds.length === 0 ||
    new Set(value.targetSlots).size !== value.targetSlots.length ||
    new Set(value.verificationIds).size !== value.verificationIds.length ||
    value.targetSlots.some((slot) => !/^[a-z][a-z0-9-]{0,62}$/u.test(slot)) ||
    value.verificationIds.some((id) => !/^[a-z][a-z0-9-]{0,62}$/u.test(id))
  ) {
    fail("MODEL_OUTPUT_INVALID", "planning artifact is invalid");
  }
  assertStrings(value.steps, "planning steps");
  return value;
}

export interface EngineeringCostReservation {
  readonly reservationId: string;
  readonly workAccordDigest: Digest;
  readonly activationLeaseDigest: Digest;
  readonly phaseBudgets: Readonly<Record<"framing" | "execution" | "verification", number>>;
  readonly phaseTokenBudgets: Readonly<
    Record<"framing" | "execution" | "verification", number>
  >;
  readonly maxCalls: number;
  readonly maxTokens: number;
  readonly totalReserved: number;
  readonly remainingBefore: number;
  readonly remainingAfter: number;
  readonly ledgerVersion: number;
  readonly ledgerHeadBefore: Digest | null;
  readonly ledgerHeadAfter: Digest;
  readonly checkedAt: string;
  readonly reservedAt: string;
  readonly expiresAt: string;
  readonly signature: DetachedSignature;
}

/**
 * A phase budget held in the cost ledger's own lineage *before* any provider
 * work begins.
 *
 * This exists because the opened-but-unsettled set has to be durable state, not
 * a caller's array. A provider attempt is recorded in the receipt journal while
 * the pool lives in the runtime-state store, so an attempt that is durably
 * recorded but never registered by its caller — an exception between the two, or
 * a crash — used to leave reserved budget that `release` would return to the
 * pool while the provider could still report cost against it.
 *
 * The hold closes that window by inverting the order: the ledger commits the
 * hold first, and only a committed hold can carry an attempt. A crash between
 * the two therefore strands the budget as *held*, which is the sole safe
 * direction, and no caller list is consulted to discover it.
 */
export interface EngineeringCostHold {
  readonly holdId: string;
  readonly reservationDigest: Digest;
  readonly activationLeaseDigest: Digest;
  readonly phase: "framing" | "execution" | "verification";
  readonly sequence: number;
  readonly heldCostUnits: number;
  readonly heldTokenUnits: number;
  readonly projectedCumulativeCalls: number;
  readonly projectedCumulativeTokens: number;
  readonly projectedCumulativeCostUnits: number;
  readonly ledgerVersion: number;
  readonly ledgerHeadBefore: Digest;
  readonly ledgerHeadAfter: Digest;
  readonly heldAt: string;
  readonly expiresAt: string;
  readonly reconciliationExpiresAt: string;
  readonly signature: DetachedSignature;
}

/**
 * One link of a reservation's cost lineage.
 *
 * Holds and settlements share a single signed chain, so a validator cannot
 * derive the expected predecessor from settlements alone: an open hold that
 * never settles still occupies a link. Every cost document therefore chains
 * onto the immediately preceding entry of *either* kind.
 */
export type EngineeringCostLineageEntry =
  | { readonly kind: "hold"; readonly hold: EngineeringCostHold }
  | { readonly kind: "settlement"; readonly settlement: EngineeringCostSettlement };

function lineageHead(
  reservation: EngineeringCostReservation,
  priorEntries: readonly EngineeringCostLineageEntry[]
): { readonly head: Digest; readonly version: number } {
  const last = priorEntries.at(-1);
  if (last === undefined) {
    return {
      head: reservation.ledgerHeadAfter,
      version: reservation.ledgerVersion
    };
  }
  const document = last.kind === "hold" ? last.hold : last.settlement;
  return { head: document.ledgerHeadAfter, version: document.ledgerVersion };
}

function lineageSettlements(
  priorEntries: readonly EngineeringCostLineageEntry[]
): readonly EngineeringCostSettlement[] {
  return priorEntries
    .filter(
      (entry): entry is { readonly kind: "settlement"; readonly settlement: EngineeringCostSettlement } =>
        entry.kind === "settlement"
    )
    .map((entry) => entry.settlement);
}

export interface EngineeringProviderAttempt {
  readonly attemptId: string;
  readonly reservationDigest: Digest;
  readonly activationLeaseDigest: Digest;
  /** The durable hold this attempt spends against. */
  readonly holdDigest: Digest;
  readonly phase: "framing" | "execution" | "verification";
  readonly phaseBudget: number;
  readonly tokenBudget: number;
  readonly sequence: number;
  readonly projectedCumulativeCalls: number;
  readonly projectedCumulativeTokens: number;
  readonly projectedCumulativeCostUnits: number;
  readonly startedAt: string;
  readonly expiresAt: string;
  readonly reconciliationExpiresAt: string;
  readonly signature: DetachedSignature;
}

export interface EngineeringActivationLeaseEvidence {
  readonly lease: ActivationLease;
  readonly bindingDigest: Digest;
  readonly reservationDigest: Digest;
  readonly observedAt: string;
  readonly signature: DetachedSignature;
}

export interface EngineeringActivationLeaseProvider {
  read(input: {
    readonly phase: EngineeringProviderAttempt["phase"];
    readonly binding: EngineeringWorkBinding;
    readonly reservation: EngineeringCostReservation;
    readonly now: string;
  }): Promise<EngineeringActivationLeaseEvidence>;
}

export interface EngineeringProviderUsage {
  readonly attemptDigest: Digest;
  readonly phase: EngineeringProviderAttempt["phase"];
  readonly status: "settled" | "unknown";
  readonly actualCostUnits: number | null;
  readonly actualCalls: number | null;
  readonly actualTokens: number | null;
  readonly providerUsageDigest: Digest | null;
  readonly observedAt: string;
  readonly signature: DetachedSignature;
}

export interface EngineeringCostSettlement {
  readonly reservationDigest: Digest;
  readonly attemptDigest: Digest;
  /** The hold this settlement discharges. */
  readonly holdDigest: Digest;
  readonly phase: "framing" | "execution" | "verification";
  readonly actualCostUnits: number;
  readonly actualCalls: number;
  readonly actualTokens: number;
  readonly releasedCostUnits: number;
  readonly cumulativeCostUnits: number;
  readonly cumulativeCalls: number;
  readonly cumulativeTokens: number;
  readonly cumulativeReleasedCostUnits: number;
  readonly providerUsageDigest: Digest;
  readonly ledgerVersion: number;
  readonly ledgerHeadBefore: Digest;
  readonly ledgerHeadAfter: Digest;
  readonly settledAt: string;
  readonly reconciliationExpiresAt: string;
  readonly signature: DetachedSignature;
}

export interface EngineeringCostRelease {
  readonly reservationDigest: Digest;
  readonly settlementDigests: readonly Digest[];
  /**
   * Every hold the ledger derived from its own durable state that no settlement
   * discharged. Whole signed documents rather than digests, so this release is
   * self-proving: a validator can check each hold's signature, reservation
   * binding, and phase without a second store read.
   *
   * A hold is never released on the absence of evidence. Budget leaves a hold
   * only through a settlement that proves what was spent.
   */
  readonly unresolvedHolds: readonly EngineeringCostHold[];
  /**
   * True exactly when `unresolvedHolds` is non-empty: this reservation still
   * holds budget that only an authenticated reconciliation can resolve, and
   * this release did not and cannot decide it.
   */
  readonly reconciliationRequired: boolean;
  readonly previouslyReleasedCostUnits: number;
  readonly heldCostUnits: number;
  readonly releasedCostUnits: number;
  readonly cumulativeCostUnits: number;
  readonly cumulativeCalls: number;
  readonly cumulativeTokens: number;
  readonly cumulativeReleasedCostUnits: number;
  readonly ledgerVersion: number;
  readonly ledgerHeadBefore: Digest;
  readonly ledgerHeadAfter: Digest;
  readonly releasedAt: string;
  readonly signature: DetachedSignature;
}

function reservationPayload(
  reservation: EngineeringCostReservation
): Omit<EngineeringCostReservation, "signature"> {
  const { signature: _signature, ...payload } = reservation;
  return payload;
}

function settlementPayload(
  settlement: EngineeringCostSettlement
): Omit<EngineeringCostSettlement, "signature"> {
  const { signature: _signature, ...payload } = settlement;
  return payload;
}

function providerAttemptPayload(
  attempt: EngineeringProviderAttempt
): Omit<EngineeringProviderAttempt, "signature"> {
  const { signature: _signature, ...payload } = attempt;
  return payload;
}

function costHoldPayload(
  hold: EngineeringCostHold
): Omit<EngineeringCostHold, "signature"> {
  const { signature: _signature, ...payload } = hold;
  return payload;
}

function providerUsagePayload(
  usage: EngineeringProviderUsage
): Omit<EngineeringProviderUsage, "signature"> {
  const { signature: _signature, ...payload } = usage;
  return payload;
}

function activationLeaseEvidencePayload(
  evidence: EngineeringActivationLeaseEvidence
): Omit<EngineeringActivationLeaseEvidence, "signature"> {
  const { signature: _signature, ...payload } = evidence;
  return payload;
}

function releasePayload(
  release: EngineeringCostRelease
): Omit<EngineeringCostRelease, "signature"> {
  const { signature: _signature, ...payload } = release;
  return payload;
}

export interface EngineeringCostLedger {
  reserve(input: {
    readonly workAccordDigest: Digest;
    readonly activationLeaseDigest: Digest;
    readonly phaseBudgets: EngineeringCostReservation["phaseBudgets"];
    readonly phaseTokenBudgets: EngineeringCostReservation["phaseTokenBudgets"];
    readonly maxCalls: number;
    readonly maxTokens: number;
    readonly now: string;
    readonly expiresAt: string;
  }): Promise<EngineeringCostReservation>;
  /**
   * Commits a phase hold to this reservation's cost lineage.
   *
   * Must be durable before the caller opens a provider attempt against it, and
   * must be refused once the reservation has been released, so a release can
   * never race a hold into existence behind its back.
   */
  hold(input: {
    readonly reservation: EngineeringCostReservation;
    readonly phase: EngineeringProviderAttempt["phase"];
    /**
     * The caller's restatement of this hold's position, checked against durable
     * state rather than trusted. The lineage itself is the ledger's own, so the
     * caller never supplies the predecessor it chains onto.
     */
    readonly sequence: number;
    readonly now: string;
  }): Promise<EngineeringCostHold>;
  settle(input: {
    readonly reservation: EngineeringCostReservation;
    readonly hold: EngineeringCostHold;
    readonly attempt: EngineeringProviderAttempt;
    readonly usage: EngineeringProviderUsage;
    readonly phase: EngineeringCostSettlement["phase"];
    readonly actualCostUnits: number;
    readonly actualCalls: number;
    readonly actualTokens: number;
    readonly providerUsageDigest: Digest;
    readonly now: string;
  }): Promise<EngineeringCostSettlement>;
  release(input: {
    readonly releaseIdempotencyKey: Digest;
    readonly reservation: EngineeringCostReservation;
    readonly settledPhases: readonly EngineeringCostSettlement[];
    /**
     * The caller's view of the still-open holds, checked as a *subset* of the
     * set the ledger derives from durable state — never used as its source.
     *
     * Omission is therefore impossible: a hold the caller lost track of is
     * still derived and still held. Fabrication is still refused: a digest the
     * ledger never wrote is rejected rather than silently held.
     */
    readonly expectedOpenHoldDigests: readonly Digest[];
    readonly now: string;
  }): Promise<EngineeringCostRelease>;
}

export interface EngineeringProviderUsageLedger {
  begin(input: {
    readonly reservation: EngineeringCostReservation;
    /** The committed hold this attempt spends against. */
    readonly hold: EngineeringCostHold;
    readonly phase: EngineeringProviderAttempt["phase"];
    readonly sequence: number;
    readonly priorSettlements: readonly EngineeringCostSettlement[];
    readonly now: string;
    readonly reconciliationExpiresAt: string;
  }): Promise<EngineeringProviderAttempt>;
  reconcile(input: {
    readonly reservation: EngineeringCostReservation;
    readonly attempt: EngineeringProviderAttempt;
    readonly now: string;
  }): Promise<EngineeringProviderUsage>;
}

/**
 * Requires a hold to be signed by the ledger and bound to exactly the
 * reservation, phase, sequence, and lineage position the caller expects.
 */
export function validateCostHold(input: {
  readonly hold: EngineeringCostHold;
  readonly reservation: EngineeringCostReservation;
  readonly verifier: EvidenceVerifier;
  readonly phase: EngineeringProviderAttempt["phase"];
  readonly sequence: number;
  readonly priorEntries: readonly EngineeringCostLineageEntry[];
  readonly now: string;
  readonly maximumAgeMs: number;
}): void {
  const hold = input.hold;
  const prior = lineageSettlements(input.priorEntries).at(-1);
  const { head: expectedHeadBefore, version: priorVersion } = lineageHead(
    input.reservation,
    input.priorEntries
  );
  const heldCostUnits = input.reservation.phaseBudgets[input.phase];
  const heldTokenUnits = input.reservation.phaseTokenBudgets[input.phase];
  if (
    hold.reservationDigest !== digest(input.reservation) ||
    hold.activationLeaseDigest !== input.reservation.activationLeaseDigest ||
    hold.phase !== input.phase ||
    hold.sequence !== input.sequence ||
    hold.holdId.length === 0 ||
    hold.heldCostUnits !== heldCostUnits ||
    hold.heldTokenUnits !== heldTokenUnits ||
    hold.projectedCumulativeCalls !== (prior?.cumulativeCalls ?? 0) + 1 ||
    hold.projectedCumulativeTokens !==
      (prior?.cumulativeTokens ?? 0) + heldTokenUnits ||
    hold.projectedCumulativeCostUnits !==
      (prior?.cumulativeCostUnits ?? 0) + heldCostUnits ||
    hold.ledgerVersion !== priorVersion + 1 ||
    hold.ledgerHeadBefore !== expectedHeadBefore ||
    hold.expiresAt !== input.reservation.expiresAt ||
    hold.reconciliationExpiresAt !==
      reconciliationExpiry(input.reservation.expiresAt) ||
    hold.ledgerHeadAfter !==
      digest({
        ledgerHeadBefore: hold.ledgerHeadBefore,
        ledgerVersion: hold.ledgerVersion,
        holdId: hold.holdId,
        reservationDigest: hold.reservationDigest,
        phase: hold.phase,
        sequence: hold.sequence,
        heldCostUnits: hold.heldCostUnits,
        heldTokenUnits: hold.heldTokenUnits,
        projectedCumulativeCalls: hold.projectedCumulativeCalls,
        projectedCumulativeTokens: hold.projectedCumulativeTokens,
        projectedCumulativeCostUnits: hold.projectedCumulativeCostUnits,
        reconciliationExpiresAt: hold.reconciliationExpiresAt
      }) ||
    !input.verifier.verify(costHoldPayload(hold), hold.signature)
  ) {
    fail("COST_INVALID", "cost hold is unsigned, replayed, or incorrectly bound");
  }
  assertFreshWindow({
    observedAt: hold.heldAt,
    expiresAt: hold.expiresAt,
    now: input.now,
    maximumAgeMs: input.maximumAgeMs
  });
}

export function validateProviderAttempt(input: {
  readonly attempt: EngineeringProviderAttempt;
  readonly reservation: EngineeringCostReservation;
  readonly hold: EngineeringCostHold;
  readonly verifier: EvidenceVerifier;
  readonly phase: EngineeringProviderAttempt["phase"];
  readonly sequence: number;
  readonly priorSettlements: readonly EngineeringCostSettlement[];
  readonly now: string;
  readonly maximumAgeMs: number;
}): void {
  const attempt = input.attempt;
  const prior = input.priorSettlements.at(-1);
  const projectedCalls = (prior?.cumulativeCalls ?? 0) + 1;
  const projectedTokens =
    (prior?.cumulativeTokens ?? 0) +
    input.reservation.phaseTokenBudgets[input.phase];
  const projectedCost =
    (prior?.cumulativeCostUnits ?? 0) +
    input.reservation.phaseBudgets[input.phase];
  if (
    attempt.reservationDigest !== digest(input.reservation) ||
    attempt.activationLeaseDigest !== input.reservation.activationLeaseDigest ||
    // The attempt is only authorized by a hold that already committed the
    // budget it is about to spend; an attempt that names another hold, or a
    // hold for another phase or position, is not evidence of held budget.
    attempt.holdDigest !== digest(input.hold) ||
    input.hold.phase !== input.phase ||
    input.hold.sequence !== input.sequence ||
    input.hold.reservationDigest !== digest(input.reservation) ||
    attempt.phase !== input.phase ||
    attempt.phaseBudget !== input.reservation.phaseBudgets[input.phase] ||
    attempt.tokenBudget !== input.reservation.phaseTokenBudgets[input.phase] ||
    attempt.phaseBudget !== input.hold.heldCostUnits ||
    attempt.tokenBudget !== input.hold.heldTokenUnits ||
    attempt.sequence !== input.sequence ||
    attempt.projectedCumulativeCalls !== projectedCalls ||
    attempt.projectedCumulativeTokens !== projectedTokens ||
    attempt.projectedCumulativeCostUnits !== projectedCost ||
    attempt.attemptId.length === 0 ||
    attempt.reconciliationExpiresAt !==
      reconciliationExpiry(input.reservation.expiresAt) ||
    !input.verifier.verify(providerAttemptPayload(attempt), attempt.signature)
  ) {
    fail("COST_INVALID", "provider attempt is unsigned, replayed, or incorrectly bound");
  }
  assertFreshWindow({
    observedAt: attempt.startedAt,
    expiresAt: attempt.expiresAt,
    now: input.now,
    maximumAgeMs: input.maximumAgeMs
  });
}

export function validateActivationLeaseEvidence(input: {
  readonly evidence: EngineeringActivationLeaseEvidence;
  readonly binding: EngineeringWorkBinding;
  readonly reservation: EngineeringCostReservation;
  readonly activationLeaseDigest: Digest;
  readonly workAccordDigest: Digest;
  readonly phase: EngineeringProviderAttempt["phase"];
  readonly capability: string;
  readonly projectedCalls: number;
  readonly projectedTokens: number;
  readonly projectedCostUnits: number;
  readonly verifier: EvidenceVerifier;
  readonly now: string;
  readonly maximumAgeMs: number;
}): void {
  const evidence = input.evidence;
  if (
    digest(evidence.lease) !== input.activationLeaseDigest ||
    evidence.lease.workAccordDigest !== input.workAccordDigest ||
    evidence.lease.revoked ||
    !evidence.lease.allowedPhases.includes(input.phase) ||
    !evidence.lease.allowedCapabilities.includes(input.capability) ||
    input.projectedCalls > evidence.lease.maxCalls ||
    input.projectedTokens > evidence.lease.maxTokens ||
    input.projectedCostUnits > evidence.lease.maxCostUnits ||
    evidence.bindingDigest !== digest(input.binding) ||
    evidence.reservationDigest !== digest(input.reservation) ||
    !input.verifier.verify(
      activationLeaseEvidencePayload(evidence),
      evidence.signature
    )
  ) {
    fail("AUTHORIZATION_INVALID", "live Activation Lease evidence is invalid or revoked");
  }
  assertFreshWindow({
    observedAt: evidence.observedAt,
    expiresAt: evidence.lease.expiresAt,
    now: input.now,
    maximumAgeMs: input.maximumAgeMs
  });
}

export function validateProviderUsage(input: {
  readonly usage: EngineeringProviderUsage;
  readonly attempt: EngineeringProviderAttempt;
  readonly verifier: EvidenceVerifier;
  readonly now: string;
  readonly maximumAgeMs: number;
}): void {
  const usage = input.usage;
  const settled = usage.status === "settled";
  if (
    usage.attemptDigest !== digest(input.attempt) ||
    usage.phase !== input.attempt.phase ||
    (settled &&
      (!Number.isSafeInteger(usage.actualCostUnits) ||
        usage.actualCostUnits === null ||
        usage.actualCostUnits < 0 ||
        usage.actualCostUnits > input.attempt.phaseBudget ||
        usage.actualCalls !== 1 ||
        !Number.isSafeInteger(usage.actualTokens) ||
        usage.actualTokens === null ||
        usage.actualTokens < 0 ||
        usage.actualTokens > input.attempt.tokenBudget ||
        usage.providerUsageDigest === null)) ||
    (!settled &&
      (usage.actualCostUnits !== null ||
        usage.actualCalls !== null ||
        usage.actualTokens !== null ||
        usage.providerUsageDigest !== null)) ||
    !input.verifier.verify(providerUsagePayload(usage), usage.signature)
  ) {
    fail("COST_INVALID", "provider usage is unsigned, inconsistent, or exceeds its attempt");
  }
  const observedAt = timestamp(usage.observedAt, "usage.observedAt");
  const now = timestamp(input.now, "now");
  if (
    observedAt < timestamp(input.attempt.startedAt, "attempt.startedAt") ||
    observedAt > now ||
    now >=
      timestamp(
        input.attempt.reconciliationExpiresAt,
        "attempt.reconciliationExpiresAt"
      )
  ) {
    fail("COST_INVALID", "provider usage is outside its signed reconciliation window");
  }
}

export function validateCostReservation(input: {
  readonly reservation: EngineeringCostReservation;
  readonly verifier: EvidenceVerifier;
  readonly workAccordDigest: Digest;
  readonly activationLeaseDigest: Digest;
  readonly phaseBudgets: EngineeringCostReservation["phaseBudgets"];
  readonly phaseTokenBudgets: EngineeringCostReservation["phaseTokenBudgets"];
  readonly maxCalls: number;
  readonly maxTokens: number;
  readonly now: string;
  readonly maximumAgeMs: number;
}): void {
  const reservation = input.reservation;
  const phaseBudgets = Object.values(input.phaseBudgets);
  const phaseTokenBudgets = Object.values(input.phaseTokenBudgets);
  const total = phaseBudgets.reduce((sum, value) => sum + value, 0);
  if (
    phaseBudgets.some((value) => !Number.isSafeInteger(value) || value < 0) ||
    phaseTokenBudgets.some((value) => !Number.isSafeInteger(value) || value < 0) ||
    !Number.isSafeInteger(input.maxCalls) ||
    input.maxCalls < 1 ||
    !Number.isSafeInteger(input.maxTokens) ||
    input.maxTokens < 0 ||
    !Number.isSafeInteger(total) ||
    reservation.workAccordDigest !== input.workAccordDigest ||
    reservation.activationLeaseDigest !== input.activationLeaseDigest ||
    digest(reservation.phaseBudgets) !== digest(input.phaseBudgets) ||
    digest(reservation.phaseTokenBudgets) !== digest(input.phaseTokenBudgets) ||
    reservation.maxCalls !== input.maxCalls ||
    reservation.maxTokens !== input.maxTokens ||
    reservation.totalReserved !== total ||
    reservation.totalReserved > reservation.remainingBefore ||
    reservation.remainingAfter < 0 ||
    reservation.remainingBefore - reservation.totalReserved !== reservation.remainingAfter ||
    reservation.ledgerHeadAfter !==
      digest({
        ledgerHeadBefore: reservation.ledgerHeadBefore,
        ledgerVersion: reservation.ledgerVersion,
        reservationId: reservation.reservationId,
        workAccordDigest: reservation.workAccordDigest,
        activationLeaseDigest: reservation.activationLeaseDigest,
        phaseBudgets: reservation.phaseBudgets,
        phaseTokenBudgets: reservation.phaseTokenBudgets,
        maxCalls: reservation.maxCalls,
        maxTokens: reservation.maxTokens,
        totalReserved: reservation.totalReserved,
        remainingBefore: reservation.remainingBefore,
        remainingAfter: reservation.remainingAfter
      }) ||
    !input.verifier.verify(reservationPayload(reservation), reservation.signature)
  ) {
    fail("COST_INVALID", "cost reservation is not atomic, signed, or correctly bound");
  }
  assertFreshWindow({
    observedAt: reservation.checkedAt,
    expiresAt: reservation.expiresAt,
    now: input.now,
    maximumAgeMs: input.maximumAgeMs
  });
  const checkedAt = timestamp(reservation.checkedAt, "checkedAt");
  const reservedAt = timestamp(reservation.reservedAt, "reservedAt");
  const now = timestamp(input.now, "now");
  if (
    checkedAt > reservedAt ||
    reservedAt > now ||
    now >= timestamp(reservation.expiresAt, "expiresAt")
  ) {
    fail("COST_INVALID", "reservation occurred before its trusted cost check");
  }
}

/**
 * Checks a settlement against the reservation and its predecessor settlement.
 *
 * Deliberately does *not* take the hold document. A settlement is signed over
 * `holdDigest`, `ledgerHeadBefore`, and `ledgerVersion`, so it already pins the
 * position and identity of the hold it discharges: that hold occupied version
 * `ledgerVersion - 1` and ended at head `ledgerHeadBefore`. Callers that hold
 * the document check it too, but release validation must not need it, because
 * requiring it would make a caller-supplied array authoritative for the chain.
 */
function assertSettlementAgainstReservation(input: {
  readonly settlement: EngineeringCostSettlement;
  readonly reservation: EngineeringCostReservation;
  readonly verifier: EvidenceVerifier;
  readonly priorSettlements: readonly EngineeringCostSettlement[];
  readonly expectedPhase: EngineeringCostSettlement["phase"];
  readonly expectedAttemptDigest: Digest;
  readonly expectedActualCostUnits: number;
  readonly expectedActualCalls: number;
  readonly expectedActualTokens: number;
  readonly expectedProviderUsageDigest: Digest;
  readonly now: string;
  readonly maximumAgeMs: number;
}): void {
  const settlement = input.settlement;
  const priorSettlements = input.priorSettlements;
  const phaseBudget = input.reservation.phaseBudgets[settlement.phase];
  const priorSettlement = priorSettlements.at(-1);
  const priorCumulative = priorSettlement?.cumulativeCostUnits ?? 0;
  const priorReleased = priorSettlement?.cumulativeReleasedCostUnits ?? 0;
  const priorCalls = priorSettlement?.cumulativeCalls ?? 0;
  const priorTokens = priorSettlement?.cumulativeTokens ?? 0;
  const phaseOrder = ["framing", "execution", "verification"] as const;
  const expectedPhaseIndex = phaseOrder.indexOf(settlement.phase);
  if (
    settlement.reservationDigest !== digest(input.reservation) ||
    settlement.attemptDigest !== input.expectedAttemptDigest ||
    settlement.phase !== input.expectedPhase ||
    settlement.actualCostUnits !== input.expectedActualCostUnits ||
    settlement.actualCalls !== input.expectedActualCalls ||
    settlement.actualTokens !== input.expectedActualTokens ||
    settlement.providerUsageDigest !== input.expectedProviderUsageDigest ||
    settlement.reconciliationExpiresAt !==
      reconciliationExpiry(input.reservation.expiresAt) ||
    priorSettlements.some((prior) => prior.phase === settlement.phase) ||
    expectedPhaseIndex !== priorSettlements.length ||
    !Number.isSafeInteger(phaseBudget) ||
    phaseBudget < 0 ||
    !Number.isSafeInteger(settlement.actualCostUnits) ||
    settlement.actualCostUnits < 0 ||
    settlement.actualCostUnits > phaseBudget ||
    settlement.actualCalls !== 1 ||
    !Number.isSafeInteger(settlement.actualTokens) ||
    settlement.actualTokens < 0 ||
    settlement.actualTokens > input.reservation.phaseTokenBudgets[settlement.phase] ||
    settlement.releasedCostUnits !== phaseBudget - settlement.actualCostUnits ||
    settlement.cumulativeCostUnits !== priorCumulative + settlement.actualCostUnits ||
    settlement.cumulativeCalls !== priorCalls + settlement.actualCalls ||
    settlement.cumulativeTokens !== priorTokens + settlement.actualTokens ||
    settlement.cumulativeCalls > input.reservation.maxCalls ||
    settlement.cumulativeTokens > input.reservation.maxTokens ||
    settlement.cumulativeReleasedCostUnits !==
      priorReleased + settlement.releasedCostUnits ||
    settlement.cumulativeCostUnits > input.reservation.totalReserved ||
    settlement.cumulativeReleasedCostUnits > input.reservation.totalReserved ||
    settlement.cumulativeCostUnits + settlement.cumulativeReleasedCostUnits >
      input.reservation.totalReserved ||
    settlement.ledgerHeadAfter !==
      digest({
        ledgerHeadBefore: settlement.ledgerHeadBefore,
        ledgerVersion: settlement.ledgerVersion,
        attemptDigest: settlement.attemptDigest,
        holdDigest: settlement.holdDigest,
        phase: settlement.phase,
        actualCostUnits: settlement.actualCostUnits,
        actualCalls: settlement.actualCalls,
        actualTokens: settlement.actualTokens,
        releasedCostUnits: settlement.releasedCostUnits,
        cumulativeCostUnits: settlement.cumulativeCostUnits,
        cumulativeCalls: settlement.cumulativeCalls,
        cumulativeTokens: settlement.cumulativeTokens,
        cumulativeReleasedCostUnits: settlement.cumulativeReleasedCostUnits,
        providerUsageDigest: settlement.providerUsageDigest,
        reconciliationExpiresAt: settlement.reconciliationExpiresAt
      }) ||
    !input.verifier.verify(settlementPayload(settlement), settlement.signature)
  ) {
    fail("COST_INVALID", "cost settlement is invalid, replayed, or exceeds its phase budget");
  }
  const settledAt = timestamp(settlement.settledAt, "settledAt");
  const now = timestamp(input.now, "now");
  if (
    settledAt > now ||
    now >=
      timestamp(
        settlement.reconciliationExpiresAt,
        "settlement.reconciliationExpiresAt"
      )
  ) {
    fail("COST_INVALID", "cost settlement is future-dated or expired");
  }
}

/**
 * Checks a settlement against the reservation *and* the hold it discharges.
 *
 * Used where the caller genuinely holds the hold document — immediately after
 * settling — so the settlement's binding to that exact hold is proved rather
 * than inferred from the position it pins.
 */
export function validateCostSettlement(input: {
  readonly settlement: EngineeringCostSettlement;
  readonly reservation: EngineeringCostReservation;
  readonly hold: EngineeringCostHold;
  readonly verifier: EvidenceVerifier;
  readonly priorEntries: readonly EngineeringCostLineageEntry[];
  readonly expectedPhase: EngineeringCostSettlement["phase"];
  readonly expectedAttemptDigest: Digest;
  readonly expectedActualCostUnits: number;
  readonly expectedActualCalls: number;
  readonly expectedActualTokens: number;
  readonly expectedProviderUsageDigest: Digest;
  readonly now: string;
  readonly maximumAgeMs: number;
}): void {
  const settlement = input.settlement;
  const hold = input.hold;
  // A settlement discharges its own hold, so it chains directly onto it. The
  // hold is always the immediately preceding entry for this phase, which is
  // what keeps one lineage even when an earlier hold stayed open.
  if (
    settlement.holdDigest !== digest(hold) ||
    hold.phase !== settlement.phase ||
    hold.reservationDigest !== settlement.reservationDigest ||
    input.reservation.phaseBudgets[settlement.phase] !== hold.heldCostUnits ||
    settlement.ledgerVersion !== hold.ledgerVersion + 1 ||
    settlement.ledgerHeadBefore !== hold.ledgerHeadAfter
  ) {
    fail("COST_INVALID", "cost settlement does not discharge the hold it names");
  }
  assertSettlementAgainstReservation({
    settlement,
    reservation: input.reservation,
    verifier: input.verifier,
    priorSettlements: lineageSettlements(input.priorEntries),
    expectedPhase: input.expectedPhase,
    expectedAttemptDigest: input.expectedAttemptDigest,
    expectedActualCostUnits: input.expectedActualCostUnits,
    expectedActualCalls: input.expectedActualCalls,
    expectedActualTokens: input.expectedActualTokens,
    expectedProviderUsageDigest: input.expectedProviderUsageDigest,
    now: input.now,
    maximumAgeMs: input.maximumAgeMs
  });
}

function validateActualCost(
  phase: EngineeringCostSettlement["phase"],
  actualCostUnits: number,
  reservation: EngineeringCostReservation
): void {
  if (
    !Number.isSafeInteger(actualCostUnits) ||
    actualCostUnits < 0 ||
    actualCostUnits > reservation.phaseBudgets[phase]
  ) {
    fail("COST_INVALID", `${phase} actual cost is invalid or exceeds its reservation`);
  }
}

function engineeringReleaseIdempotencyKey(input: {
  readonly reservation: EngineeringCostReservation;
  readonly settlements: readonly EngineeringCostSettlement[];
}): Digest {
  // The held set is derived from durable state rather than supplied, so it is
  // deliberately not part of this key: a release that is retried after the
  // ledger re-derives its holds must still resolve to the same operation.
  return digest({
    operation: "release-engineering-reservation",
    reservation: digest(input.reservation),
    settlements: input.settlements.map((settlement) => digest(settlement))
  });
}

export function validateCostRelease(input: {
  readonly release: EngineeringCostRelease;
  readonly reservation: EngineeringCostReservation;
  readonly settlements: readonly EngineeringCostSettlement[];
  /**
   * The caller's own view of which holds are still open. Checked only as a
   * subset of the set the release itself carries: a release that holds *more*
   * than the caller knew is the expected outcome after a crash or a failed
   * preflight, and must be accepted. A caller that knows of an open hold the
   * release omitted is a real omission and is refused.
   */
  readonly knownOpenHolds: readonly EngineeringCostHold[];
  readonly verifier: EvidenceVerifier;
  readonly now: string;
  readonly maximumAgeMs: number;
}): void {
  const reservationDigest = digest(input.reservation);
  const release = input.release;
  const settledPhases = new Set(input.settlements.map((settlement) => settlement.phase));
  const validatedSettlements: EngineeringCostSettlement[] = [];
  for (const settlement of input.settlements) {
    assertSettlementAgainstReservation({
      settlement,
      reservation: input.reservation,
      verifier: input.verifier,
      priorSettlements: [...validatedSettlements],
      expectedPhase: settlement.phase,
      expectedAttemptDigest: settlement.attemptDigest,
      expectedActualCostUnits: settlement.actualCostUnits,
      expectedActualCalls: settlement.actualCalls,
      expectedActualTokens: settlement.actualTokens,
      expectedProviderUsageDigest: settlement.providerUsageDigest,
      now: input.now,
      maximumAgeMs: input.maximumAgeMs
    });
    validatedSettlements.push(settlement);
  }

  const unresolvedHolds = release.unresolvedHolds;
  const unresolvedHoldDigests = unresolvedHolds.map((hold) => digest(hold));
  const unresolvedDigestSet = new Set(unresolvedHoldDigests);
  // `heldCostUnits` is derived from the *reservation*, over the holds the
  // release itself carries. It is never summed from a caller-supplied list,
  // which is precisely the omission this contract exists to make impossible.
  let heldCostUnits = 0;
  const openPhases = new Set<EngineeringCostSettlement["phase"]>();
  for (const hold of unresolvedHolds) {
    const reservedForPhase = input.reservation.phaseBudgets[hold.phase];
    // One phase holds its budget once. Two open holds for one phase would count
    // the same reserved units twice and strand the difference.
    if (openPhases.has(hold.phase)) {
      fail("COST_INVALID", "cost release holds one phase budget more than once");
    }
    openPhases.add(hold.phase);
    if (
      hold.reservationDigest !== reservationDigest ||
      hold.activationLeaseDigest !== input.reservation.activationLeaseDigest ||
      settledPhases.has(hold.phase) ||
      !Number.isSafeInteger(reservedForPhase) ||
      reservedForPhase < 0 ||
      hold.heldCostUnits !== reservedForPhase ||
      hold.heldTokenUnits !== input.reservation.phaseTokenBudgets[hold.phase] ||
      !input.verifier.verify(costHoldPayload(hold), hold.signature)
    ) {
      fail("COST_INVALID", "an unresolved hold is unsigned, settled, or foreign to this reservation");
    }
    heldCostUnits += reservedForPhase;
  }
  for (const known of input.knownOpenHolds) {
    if (!unresolvedDigestSet.has(digest(known))) {
      fail("COST_INVALID", "cost release omits a hold the caller knows is still open");
    }
  }

  // The lineage is reconstructed from content the *release* pins, never from a
  // caller-supplied hold array.
  //
  // A settlement is signed over `ledgerVersion` and `ledgerHeadBefore`, so it
  // pins the hold it discharged: that hold occupied the immediately preceding
  // version and ended at that head. Every still-open hold is carried whole and
  // signature-verified above. Together those cover every link, so a caller that
  // lost a hold cannot make a correct release look wrong — which is exactly the
  // failure this validator previously had, because rebuilding the chain from the
  // caller's array rejected a valid release whenever that array was incomplete.
  const chain = new Map<number, { readonly headAfter: Digest; readonly headBefore: Digest | null }>();
  const claim = (
    version: number,
    headAfter: Digest,
    headBefore: Digest | null
  ): void => {
    if (!Number.isSafeInteger(version) || chain.has(version)) {
      fail("COST_INVALID", "cost lineage repeats or misnumbers a ledger position");
    }
    chain.set(version, { headAfter, headBefore });
  };
  for (const settlement of input.settlements) {
    claim(settlement.ledgerVersion - 1, settlement.ledgerHeadBefore, null);
    claim(settlement.ledgerVersion, settlement.ledgerHeadAfter, settlement.ledgerHeadBefore);
  }
  for (const hold of unresolvedHolds) {
    claim(hold.ledgerVersion, hold.ledgerHeadAfter, hold.ledgerHeadBefore);
  }
  // The chain is bounded at both ends before it is walked: below by the
  // reservation, above by the release's own signed `ledgerVersion`.
  //
  // Stating the upper bound directly is a clarity change, not a new refusal —
  // requiring the walked distance to equal the claimed size and separately
  // requiring the release to follow the walked tip enforces the same set. It is
  // written this way so the bound is visible at the point it applies and each
  // failure reports which position was missing rather than a generic mismatch.
  //
  // What this proves is that the release is internally complete against the
  // content it pins, so no caller omission — a lost hold, an emptied array, a
  // crash between the durable write and the caller's bookkeeping — can make a
  // correct release look wrong, and no caller can drop a hold while still
  // claiming the chain position that hold created. It does not, and cannot,
  // prove that the ledger did not under-report its own durable state:
  // a signer that both dropped a hold and lowered its own release version would
  // be internally consistent at the shorter history. That is the trusted
  // adapter's authority, held by `openDurableEngineeringCostLedger` deriving the
  // open set from its own lineage under compare-and-swap, not by this checker.
  const tipVersion = release.ledgerVersion - 1;
  if (
    !Number.isSafeInteger(release.ledgerVersion) ||
    tipVersion < input.reservation.ledgerVersion
  ) {
    fail("COST_INVALID", "cost release does not follow its own reservation");
  }
  let expectedHeadBefore: Digest = input.reservation.ledgerHeadAfter;
  for (
    let version = input.reservation.ledgerVersion + 1;
    version <= tipVersion;
    version += 1
  ) {
    const entry = chain.get(version);
    if (entry === undefined) {
      fail(
        "COST_INVALID",
        "cost lineage is missing a ledger position the release chains through"
      );
    }
    if (entry.headBefore !== null && entry.headBefore !== expectedHeadBefore) {
      fail("COST_INVALID", "cost lineage does not chain onto its exact predecessor");
    }
    expectedHeadBefore = entry.headAfter;
  }
  if (chain.size !== tipVersion - input.reservation.ledgerVersion) {
    fail("COST_INVALID", "cost lineage claims a position outside its own chain");
  }

  const last = input.settlements.at(-1);
  const cumulative = last?.cumulativeCostUnits ?? 0;
  const cumulativeCalls = last?.cumulativeCalls ?? 0;
  const cumulativeTokens = last?.cumulativeTokens ?? 0;
  const previouslyReleased = last?.cumulativeReleasedCostUnits ?? 0;
  const settlementDigests = input.settlements.map((settlement) => digest(settlement));
  const releasedCostUnits =
    input.reservation.totalReserved -
    cumulative -
    previouslyReleased -
    heldCostUnits;
  const cumulativeReleasedCostUnits = previouslyReleased + releasedCostUnits;
  if (
    release.reservationDigest !== reservationDigest ||
    digest(release.settlementDigests) !== digest(settlementDigests) ||
    new Set(unresolvedHoldDigests).size !== unresolvedHoldDigests.length ||
    release.reconciliationRequired !== (unresolvedHolds.length > 0) ||
    release.previouslyReleasedCostUnits !== previouslyReleased ||
    release.heldCostUnits !== heldCostUnits ||
    !Number.isSafeInteger(releasedCostUnits) ||
    releasedCostUnits < 0 ||
    release.releasedCostUnits !== releasedCostUnits ||
    !Number.isSafeInteger(release.cumulativeCostUnits) ||
    release.cumulativeCostUnits < 0 ||
    release.cumulativeCostUnits !== cumulative ||
    release.cumulativeCalls !== cumulativeCalls ||
    release.cumulativeTokens !== cumulativeTokens ||
    release.cumulativeReleasedCostUnits !== cumulativeReleasedCostUnits ||
    release.cumulativeCostUnits +
      release.cumulativeReleasedCostUnits +
      release.heldCostUnits !==
      input.reservation.totalReserved ||
    release.ledgerHeadBefore !== expectedHeadBefore ||
    release.ledgerHeadAfter !==
      digest({
        ledgerHeadBefore: release.ledgerHeadBefore,
        ledgerVersion: release.ledgerVersion,
        reservationDigest: release.reservationDigest,
        settlementDigests,
        unresolvedHoldDigests,
        reconciliationRequired: release.reconciliationRequired,
        previouslyReleasedCostUnits: previouslyReleased,
        heldCostUnits,
        releasedCostUnits,
        cumulativeCostUnits: cumulative,
        cumulativeCalls,
        cumulativeTokens,
        cumulativeReleasedCostUnits
      }) ||
    !input.verifier.verify(releasePayload(release), release.signature)
  ) {
    fail("COST_INVALID", "cost release is invalid, unsigned, or incorrectly bound");
  }
  const releasedAt = timestamp(release.releasedAt, "releasedAt");
  const now = timestamp(input.now, "now");
  if (
    releasedAt > now ||
    now >= timestamp(reconciliationExpiry(input.reservation.expiresAt), "expiresAt")
  ) {
    fail("COST_INVALID", "cost release is future-dated, stale, or expired");
  }
}

interface EffectBase {
  readonly ordinal: number;
}

export type EngineeringDeliveryEffect =
  | (EffectBase & {
      readonly type: "create-branch";
      readonly repositoryId: number;
      readonly issueNodeId: string;
      readonly baseRef: string;
      readonly baseSha: string;
      readonly headRef: string;
    })
  | (EffectBase & {
      readonly type: "create-commit";
      readonly repositoryId: number;
      readonly issueNodeId: string;
      readonly headRef: string;
      readonly parentSha: string;
      readonly patchDigest: Digest;
      readonly treeDigest: Digest;
      readonly gitTreeSha: string;
      readonly patchBundleDigest: Digest;
    })
  | (EffectBase & {
      readonly type: "create-draft-pull-request";
      readonly repositoryId: number;
      readonly issueNodeId: string;
      readonly projectItemNodeId: string;
      readonly baseRepositoryId: number;
      readonly baseRef: string;
      readonly baseSha: string;
      readonly headRepositoryId: number;
      readonly headRef: string;
      readonly headSha: string;
      readonly title: string;
      readonly body: string;
      readonly draft: true;
    })
  | (EffectBase & {
      readonly type: "bind-pull-request";
      readonly expectedBindingDigest: Digest;
      readonly pullRequest: EngineeringPullRequestBinding;
      readonly receiptHead: Digest;
    })
  | (EffectBase & {
      readonly type: "comment-review";
      readonly repositoryId: number;
      readonly pullRequestNumber: number;
      readonly pullRequestNodeId: string;
      readonly headSha: string;
      readonly event: "COMMENT";
      readonly body: string;
    })
  | (EffectBase & {
      readonly type: "project-converge";
      readonly projectNodeId: string;
      readonly projectItemNodeId: string;
      readonly expectedStage: "human-review";
      readonly stage: "completed";
      readonly mergedSha: string;
    })
  | (EffectBase & {
      readonly type: "close-issue";
      readonly repositoryId: number;
      readonly issueNumber: number;
      readonly issueNodeId: string;
      readonly mergedSha: string;
    })
  | (EffectBase & {
      readonly type: "record-delivery";
      readonly bindingDigest: Digest;
      readonly mergedSha: string;
      readonly verificationDigest: Digest;
    })
  | (EffectBase & {
      readonly type: "operations-handoff";
      readonly bindingDigest: Digest;
      readonly mergedSha: string;
      readonly measurementPlanDigest: Digest;
    });

export interface EngineeringDeliveryAuthorization {
  readonly authorizationDigest: Digest;
  readonly workflowId: string;
  readonly contractRevision: number;
  readonly workAccordDigest: Digest;
  readonly activationLeaseDigest: Digest;
  readonly executionGrantDigest: Digest;
  readonly bindingDigest: Digest;
  readonly effectType: EngineeringDeliveryEffect["type"];
  readonly effectOrdinal: number;
  readonly planDigest: Digest;
  readonly currentHead: string | null;
  readonly kernelReceiptDigest: Digest;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly signature: DetachedSignature;
}

export interface EngineeringThreatEvidence {
  readonly status: "success" | "warning" | "failure" | "skipped" | "cancelled";
  readonly authorizationDigest: Digest;
  readonly modelOutputDigest: Digest;
  readonly kernelReceiptDigest: Digest;
  readonly checkedAt: string;
  readonly expiresAt: string;
  readonly signature: DetachedSignature;
}

export interface EngineeringGitHubSnapshot {
  readonly canonicalBindingDigest: Digest;
  readonly repositoryId: number;
  readonly repositoryNodeId: string;
  readonly repositoryFullName: string;
  readonly issueNumber: number;
  readonly issueNodeId: string;
  readonly projectOwnerNodeId: string;
  readonly projectNodeId: string;
  readonly projectItemNodeId: string;
  readonly defaultBranch: {
    readonly ref: string;
    readonly sha: string;
  };
  readonly branches: Readonly<Record<string, string>>;
  readonly pullRequest: (EngineeringPullRequestBinding & {
    readonly draft: boolean;
    readonly open: boolean;
    readonly merged: boolean;
    readonly mergedSha: string | null;
    readonly mergedByActorId: string | null;
    readonly mergedByHuman: boolean;
    readonly mergedAt: string | null;
  }) | null;
  readonly projectStage: string;
  readonly issueClosed: boolean;
  readonly reviewComments: Readonly<
    Record<
      string,
      {
        readonly repositoryId: number;
        readonly pullRequestNumber: number;
        readonly pullRequestNodeId: string;
        readonly headSha: string;
        readonly event: "COMMENT";
        readonly bodyDigest: Digest;
      }
    >
  >;
  readonly deliveryRecords: Readonly<
    Record<
      string,
      {
        readonly bindingDigest: Digest;
        readonly mergedSha: string;
        readonly verificationDigest: Digest;
      }
    >
  >;
  readonly operationsRecords: Readonly<
    Record<
      string,
      {
        readonly bindingDigest: Digest;
        readonly mergedSha: string;
        readonly measurementPlanDigest: Digest;
      }
    >
  >;
}

export interface TrustedValidatedPatchBundle {
  readonly schemaVersion: "1.0.0";
  readonly bindingDigest: Digest;
  readonly workAccordDigest: Digest;
  readonly executionGrantDigest: Digest;
  readonly kernelReceiptDigest: Digest;
  readonly modelOutputDigest: Digest;
  readonly baseSha: string;
  readonly patch: string;
  readonly patchDigest: Digest;
  readonly treeDigest: Digest;
  readonly gitTreeSha: string;
  readonly files: readonly (ValidatedPatch["files"][number] & {
    readonly contentBase64: string;
    readonly gitBlobSha: string;
  })[];
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly signature: DetachedSignature;
}

interface ObservationBase {
  readonly nodeId: string;
  readonly effectApplied: boolean;
  readonly effectDigest: Digest;
  readonly snapshot: EngineeringGitHubSnapshot;
}

export type EngineeringEffectObservation =
  | (ObservationBase & {
      readonly type: "create-branch";
      readonly repositoryId: number;
      readonly baseSha: string;
      readonly headRef: string;
      readonly headSha: string;
    })
  | (ObservationBase & {
      readonly type: "create-commit";
      readonly repositoryId: number;
      readonly headRef: string;
      readonly parentSha: string;
      readonly commitSha: string;
      readonly gitTreeSha: string;
      readonly patchDigest: Digest;
      readonly treeDigest: Digest;
      readonly files: readonly {
        readonly path: string;
        readonly blobSha: string;
        readonly contentDigest: Digest;
        readonly mode: "100644";
      }[];
    })
  | (ObservationBase & {
      readonly type: "create-draft-pull-request";
      readonly pullRequest: EngineeringPullRequestBinding & { readonly draft: true };
    })
  | (ObservationBase & {
      readonly type: "bind-pull-request";
      readonly expectedBindingDigest: Digest;
      readonly pullRequest: EngineeringPullRequestBinding;
      readonly receiptHead: Digest;
    })
  | (ObservationBase & {
      readonly type: "comment-review";
      readonly repositoryId: number;
      readonly pullRequestNumber: number;
      readonly pullRequestNodeId: string;
      readonly headSha: string;
      readonly event: "COMMENT";
      readonly bodyDigest: Digest;
    })
  | (ObservationBase & {
      readonly type: "project-converge";
      readonly projectNodeId: string;
      readonly projectItemNodeId: string;
      readonly stage: "completed";
      readonly mergedSha: string;
    })
  | (ObservationBase & {
      readonly type: "close-issue";
      readonly repositoryId: number;
      readonly issueNumber: number;
      readonly issueNodeId: string;
      readonly closed: true;
      readonly mergedSha: string;
    })
  | (ObservationBase & {
      readonly type: "record-delivery";
      readonly recordNodeId: string;
      readonly bindingDigest: Digest;
      readonly mergedSha: string;
      readonly verificationDigest: Digest;
    })
  | (ObservationBase & {
      readonly type: "operations-handoff";
      readonly recordNodeId: string;
      readonly bindingDigest: Digest;
      readonly mergedSha: string;
      readonly measurementPlanDigest: Digest;
    });

export interface EngineeringGitHubApi {
  readSnapshot(): Promise<EngineeringGitHubSnapshot>;
  applyEffect(
    effect: EngineeringDeliveryEffect,
    patchBundle: TrustedValidatedPatchBundle | null
  ): Promise<EngineeringEffectObservation>;
  observeEffect(effect: EngineeringDeliveryEffect): Promise<EngineeringEffectObservation | null>;
}

export interface OperationScopedGitHubBroker {
  withApiForEffect<T>(
    effectType: EngineeringDeliveryEffect["type"],
    operation: (api: EngineeringGitHubApi) => Promise<T>
  ): Promise<T>;
}

export interface EngineeringEffectEvidence {
  readonly sequence: number;
  readonly previousEvidenceDigest: Digest | null;
  readonly effectKey: Digest;
  readonly effectOrdinal: number;
  readonly effectType: EngineeringDeliveryEffect["type"];
  readonly workflowId: string;
  readonly contractRevision: number;
  readonly planDigest: Digest;
  readonly bindingDigest: Digest;
  readonly state: "pending" | "completed" | "partial" | "rejected";
  readonly effectDigest: Digest | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly signature: DetachedSignature;
}

export interface EngineeringEvidenceStore {
  read(effectKey: Digest): Promise<EngineeringEffectEvidence | null>;
  conditionalAppend(
    expected: EngineeringEffectEvidence | null,
    evidence: EngineeringEffectEvidence
  ): Promise<void>;
}

export class EngineeringEvidenceConflictError extends Error {
  constructor() {
    super("engineering evidence head changed");
    this.name = "EngineeringEvidenceConflictError";
  }
}

function effectEvidencePayload(
  evidence: EngineeringEffectEvidence
): Omit<EngineeringEffectEvidence, "signature"> {
  const { signature: _signature, ...payload } = evidence;
  return payload;
}

function validatedPatchBundlePayload(
  bundle: TrustedValidatedPatchBundle
): Omit<TrustedValidatedPatchBundle, "signature"> {
  const { signature: _signature, ...payload } = bundle;
  return payload;
}

function validatedPatchTreeDigest(
  files: TrustedValidatedPatchBundle["files"]
): Digest {
  return digest(
    files
      .map((file) => ({
        path: file.path,
        digest: file.afterDigest,
        mode: file.mode
      }))
      .sort((left, right) => left.path.localeCompare(right.path))
  );
}

export async function issueTrustedValidatedPatchBundle(input: {
  readonly patch: ValidatedPatch;
  readonly contentsBySlot: Readonly<Record<string, string>>;
  readonly bindingDigest: Digest;
  readonly workAccordDigest: Digest;
  readonly executionGrantDigest: Digest;
  readonly kernelReceiptDigest: Digest;
  readonly modelOutputDigest: Digest;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly signer: EvidenceSigner;
}): Promise<TrustedValidatedPatchBundle> {
  const files = input.patch.files.map((file) => {
    const content = input.contentsBySlot[file.slot];
    if (content === undefined) {
      fail("AUTHORIZATION_INVALID", "validated patch file has no authenticated content");
    }
    const bytes = Buffer.from(content, "utf8");
    const contentBase64 = bytes.toString("base64");
    if (
      bytes.byteLength !== file.bytes ||
      digest(contentBase64) !== file.afterDigest
    ) {
      fail("AUTHORIZATION_INVALID", "authenticated content differs from validated patch");
    }
    return {
      ...file,
      contentBase64,
      gitBlobSha: createHash("sha1")
        .update(`blob ${bytes.byteLength}\0`)
        .update(bytes)
        .digest("hex")
    };
  });
  const payload = {
    schemaVersion: "1.0.0",
    bindingDigest: input.bindingDigest,
    workAccordDigest: input.workAccordDigest,
    executionGrantDigest: input.executionGrantDigest,
    kernelReceiptDigest: input.kernelReceiptDigest,
    modelOutputDigest: input.modelOutputDigest,
    baseSha: input.patch.baseSha,
    patch: input.patch.patch,
    patchDigest: input.patch.patchDigest,
    treeDigest: input.patch.treeDigest,
    gitTreeSha: input.patch.gitTreeSha,
    files,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt
  } as const;
  return { ...payload, signature: await input.signer.sign(payload) };
}

export function validateTrustedValidatedPatchBundle(input: {
  readonly bundle: TrustedValidatedPatchBundle;
  readonly verifier: EvidenceVerifier;
  readonly bindingDigest: Digest;
  readonly workAccordDigest: Digest;
  readonly executionGrantDigest: Digest;
  readonly kernelReceiptDigest: Digest;
  readonly modelOutputDigest: Digest;
  readonly now: string;
}): void {
  const bundle = input.bundle;
  if (
    bundle.schemaVersion !== "1.0.0" ||
    bundle.bindingDigest !== input.bindingDigest ||
    bundle.workAccordDigest !== input.workAccordDigest ||
    bundle.executionGrantDigest !== input.executionGrantDigest ||
    bundle.kernelReceiptDigest !== input.kernelReceiptDigest ||
    bundle.modelOutputDigest !== input.modelOutputDigest ||
    bundle.patchDigest !== digest(bundle.patch) ||
    bundle.treeDigest !== validatedPatchTreeDigest(bundle.files) ||
    !/^[0-9a-f]{40}$/u.test(bundle.gitTreeSha) ||
    bundle.files.length === 0 ||
    bundle.files.some((file) => {
      const bytes = Buffer.from(file.contentBase64, "base64");
      return (
        bytes.toString("base64") !== file.contentBase64 ||
        bytes.byteLength !== file.bytes ||
        digest(file.contentBase64) !== file.afterDigest ||
        createHash("sha1")
          .update(`blob ${bytes.byteLength}\0`)
          .update(bytes)
          .digest("hex") !== file.gitBlobSha
      );
    }) ||
    !input.verifier.verify(
      validatedPatchBundlePayload(bundle),
      bundle.signature
    )
  ) {
    fail(
      "AUTHORIZATION_INVALID",
      "trusted validated patch bundle is unsigned, incomplete, or substituted"
    );
  }
  const now = timestamp(input.now, "now");
  const createdAt = timestamp(bundle.createdAt, "bundle.createdAt");
  const expiresAt = timestamp(bundle.expiresAt, "bundle.expiresAt");
  if (createdAt > now || now >= expiresAt) {
    fail("AUTHORIZATION_INVALID", "trusted validated patch bundle is expired");
  }
}

function threatEvidencePayload(
  evidence: EngineeringThreatEvidence
): Omit<EngineeringThreatEvidence, "signature"> {
  const { signature: _signature, ...payload } = evidence;
  return payload;
}

function deliveryAuthorizationPayload(
  authorization: EngineeringDeliveryAuthorization
): Omit<EngineeringDeliveryAuthorization, "signature" | "authorizationDigest"> {
  const {
    signature: _signature,
    authorizationDigest: _authorizationDigest,
    ...payload
  } = authorization;
  return payload;
}

function assertDeliveryAuthorization(input: {
  readonly authorization: EngineeringDeliveryAuthorization;
  readonly verifier: EvidenceVerifier;
  readonly effect: EngineeringDeliveryEffect;
  readonly binding: EngineeringWorkBinding;
  readonly workflowId: string;
  readonly contractRevision: number;
  readonly workAccordDigest: Digest;
  readonly activationLeaseDigest: Digest;
  readonly executionGrantDigest: Digest;
  readonly kernelReceiptDigest: Digest;
  readonly now: string;
  readonly maximumAgeMs: number;
}): void {
  const authorization = input.authorization;
  const payload = deliveryAuthorizationPayload(authorization);
  if (
    authorization.authorizationDigest !== digest(payload) ||
    authorization.workflowId !== input.workflowId ||
    authorization.contractRevision !== input.contractRevision ||
    authorization.workAccordDigest !== input.workAccordDigest ||
    authorization.activationLeaseDigest !== input.activationLeaseDigest ||
    authorization.executionGrantDigest !== input.executionGrantDigest ||
    authorization.bindingDigest !== digest(input.binding) ||
    authorization.effectType !== input.effect.type ||
    authorization.effectOrdinal !== input.effect.ordinal ||
    authorization.planDigest !== digest(input.effect) ||
    authorization.currentHead !== input.binding.pullRequest?.headSha &&
      !(authorization.currentHead === null && input.binding.pullRequest === null) ||
    authorization.kernelReceiptDigest !== input.kernelReceiptDigest ||
    !input.verifier.verify(payload, authorization.signature)
  ) {
    fail("AUTHORIZATION_INVALID", "delivery authorization is invalid or substituted");
  }
  assertFreshWindow({
    observedAt: authorization.issuedAt,
    expiresAt: authorization.expiresAt,
    now: input.now,
    maximumAgeMs: input.maximumAgeMs
  });
}

function assertThreatEvidence(input: {
  readonly evidence: EngineeringThreatEvidence;
  readonly authorization: EngineeringDeliveryAuthorization;
  readonly modelOutputDigest: Digest;
  readonly kernelReceiptDigest: Digest;
  readonly verifier: EvidenceVerifier;
  readonly now: string;
  readonly maximumAgeMs: number;
}): void {
  if (
    input.evidence.status !== "success" ||
    input.evidence.authorizationDigest !== input.authorization.authorizationDigest ||
    input.evidence.modelOutputDigest !== input.modelOutputDigest ||
    input.evidence.kernelReceiptDigest !== input.kernelReceiptDigest ||
    !input.verifier.verify(
      threatEvidencePayload(input.evidence),
      input.evidence.signature
    ) ||
    timestamp(input.evidence.checkedAt, "checkedAt") <
      timestamp(input.authorization.issuedAt, "issuedAt")
  ) {
    fail("THREAT_BLOCKED", "exact-success threat evidence is required before any effect");
  }
  assertFreshWindow({
    observedAt: input.evidence.checkedAt,
    expiresAt: input.evidence.expiresAt,
    now: input.now,
    maximumAgeMs: input.maximumAgeMs
  });
}

function assertBindingSnapshot(
  binding: EngineeringWorkBinding,
  snapshot: EngineeringGitHubSnapshot,
  allowUnboundPullRequest = false
): void {
  if (
    snapshot.repositoryId !== binding.repository.id ||
    snapshot.repositoryNodeId !== binding.repository.nodeId ||
    snapshot.repositoryFullName !== binding.repository.fullName ||
    snapshot.issueNumber !== binding.issue.number ||
    snapshot.issueNodeId !== binding.issue.nodeId ||
    snapshot.projectOwnerNodeId !== binding.project.ownerNodeId ||
    snapshot.projectNodeId !== binding.project.nodeId ||
    snapshot.projectItemNodeId !== binding.project.itemNodeId
  ) {
    fail("BINDING_STALE", "fresh GitHub Issue or Project binding changed");
  }
  if (binding.pullRequest !== null) {
    const current = snapshot.pullRequest;
    if (
      current === null ||
      current.number !== binding.pullRequest.number ||
      current.nodeId !== binding.pullRequest.nodeId ||
      current.baseRepositoryId !== binding.pullRequest.baseRepositoryId ||
      current.baseRef !== binding.pullRequest.baseRef ||
      current.baseSha !== binding.pullRequest.baseSha ||
      current.headRepositoryId !== binding.pullRequest.headRepositoryId ||
      current.headRef !== binding.pullRequest.headRef ||
      current.headSha !== binding.pullRequest.headSha ||
      (current.merged
        ? current.open || current.draft
        : !current.open)
    ) {
      fail("CURRENT_HEAD_STALE", "fresh pull-request binding or head changed");
    }
  } else if (snapshot.pullRequest !== null && !allowUnboundPullRequest) {
    fail(
      "BINDING_STALE",
      "fresh GitHub state contains an unexpected pull request for an unbound work item"
    );
  }
}

function assertEffectTargets(
  effect: EngineeringDeliveryEffect,
  binding: EngineeringWorkBinding,
  snapshot: EngineeringGitHubSnapshot
): void {
  assertBindingSnapshot(
    binding,
    snapshot,
    effect.type === "bind-pull-request"
  );
  switch (effect.type) {
    case "create-branch":
      if (
        binding.pullRequest !== null ||
        effect.repositoryId !== binding.repository.id ||
        effect.issueNodeId !== binding.issue.nodeId ||
        effect.baseRef !== snapshot.defaultBranch.ref ||
        effect.baseSha !== snapshot.defaultBranch.sha ||
        snapshot.branches[effect.headRef] !== undefined
      ) {
        fail("BINDING_STALE", "branch effect target or base is stale");
      }
      return;
    case "create-commit":
      if (
        effect.repositoryId !== binding.repository.id ||
        effect.issueNodeId !== binding.issue.nodeId ||
        snapshot.branches[effect.headRef] !== effect.parentSha
      ) {
        fail("CURRENT_HEAD_STALE", "commit parent is not the fresh branch head");
      }
      return;
    case "create-draft-pull-request":
      if (
        binding.pullRequest !== null ||
        effect.repositoryId !== binding.repository.id ||
        effect.issueNodeId !== binding.issue.nodeId ||
        effect.projectItemNodeId !== binding.project.itemNodeId ||
        effect.baseRepositoryId !== binding.repository.id ||
        effect.headRepositoryId !== binding.repository.id ||
        effect.baseRef !== snapshot.defaultBranch.ref ||
        effect.baseSha !== snapshot.defaultBranch.sha ||
        snapshot.branches[effect.headRef] !== effect.headSha ||
        effect.draft !== true ||
        snapshot.pullRequest !== null
      ) {
        fail("BINDING_STALE", "draft pull-request effect is not bound to fresh branch state");
      }
      return;
    case "bind-pull-request":
      if (
        effect.expectedBindingDigest !== digest(binding) ||
        effect.receiptHead !== binding.receiptHead ||
        binding.pullRequest !== null ||
        snapshot.pullRequest === null ||
        snapshot.repositoryId !== binding.repository.id ||
        snapshot.pullRequest.number !== effect.pullRequest.number ||
        snapshot.pullRequest.nodeId !== effect.pullRequest.nodeId ||
        snapshot.pullRequest.baseRepositoryId !==
          effect.pullRequest.baseRepositoryId ||
        snapshot.pullRequest.baseRef !== effect.pullRequest.baseRef ||
        snapshot.pullRequest.headRepositoryId !==
          effect.pullRequest.headRepositoryId ||
        snapshot.pullRequest.headRef !== effect.pullRequest.headRef ||
        snapshot.pullRequest.headSha !== effect.pullRequest.headSha ||
        !snapshot.pullRequest.draft ||
        !snapshot.pullRequest.open ||
        snapshot.pullRequest.merged
      ) {
        fail("BINDING_STALE", "pull-request rebind does not match fresh GitHub state");
      }
      return;
    case "comment-review":
      if (
        binding.pullRequest === null ||
        effect.repositoryId !== binding.repository.id ||
        effect.pullRequestNumber !== binding.pullRequest.number ||
        effect.pullRequestNodeId !== binding.pullRequest.nodeId ||
        effect.headSha !== binding.pullRequest.headSha ||
        effect.event !== "COMMENT"
      ) {
        fail("CURRENT_HEAD_STALE", "automated review is not COMMENT-only on the exact head");
      }
      return;
    case "project-converge":
      if (
        effect.projectNodeId !== binding.project.nodeId ||
        effect.projectItemNodeId !== binding.project.itemNodeId ||
        snapshot.projectStage !== effect.expectedStage ||
        snapshot.pullRequest?.mergedSha !== effect.mergedSha
      ) {
        fail("BINDING_STALE", "Project closure does not match observed merge state");
      }
      return;
    case "close-issue":
      if (
        effect.repositoryId !== binding.repository.id ||
        effect.issueNumber !== binding.issue.number ||
        effect.issueNodeId !== binding.issue.nodeId ||
        snapshot.pullRequest?.mergedSha !== effect.mergedSha
      ) {
        fail("BINDING_STALE", "issue closure does not match observed merge state");
      }
      return;
    case "record-delivery":
    case "operations-handoff":
      if (
        effect.bindingDigest !== digest(binding) ||
        snapshot.pullRequest?.mergedSha !== effect.mergedSha
      ) {
        fail("BINDING_STALE", `${effect.type} does not match observed merge state`);
      }
      return;
  }
}

function observationDigest(
  observation: EngineeringEffectObservation
): Digest {
  const {
    effectDigest: _effectDigest,
    snapshot: _snapshot,
    ...canonical
  } = observation;
  return digest(canonical);
}

function assertObservationMatchesEffectWithReplayPolicy(
  effect: EngineeringDeliveryEffect,
  observation: EngineeringEffectObservation,
  patchBundle: TrustedValidatedPatchBundle | null,
  binding: EngineeringWorkBinding,
  freshCanonicalBindingDigest: Digest | null,
  allowCompletedDraftPullRequestBaseAdvance: boolean
): void {
  if (
    observation.type !== effect.type ||
    observation.nodeId.length === 0 ||
    observation.effectApplied !== true ||
    observation.effectDigest !== observationDigest(observation)
  ) {
    fail("PARTIAL_EFFECT", "effect observation identity is not canonical");
  }
  if (
    observation.snapshot.repositoryId !== binding.repository.id ||
    observation.snapshot.repositoryNodeId !== binding.repository.nodeId ||
    observation.snapshot.repositoryFullName !== binding.repository.fullName ||
    observation.snapshot.issueNumber !== binding.issue.number ||
    observation.snapshot.issueNodeId !== binding.issue.nodeId ||
    observation.snapshot.projectOwnerNodeId !== binding.project.ownerNodeId ||
    observation.snapshot.projectNodeId !== binding.project.nodeId ||
    observation.snapshot.projectItemNodeId !== binding.project.itemNodeId ||
    (freshCanonicalBindingDigest !== null &&
      observation.snapshot.canonicalBindingDigest !==
        freshCanonicalBindingDigest)
  ) {
    fail("BINDING_STALE", "effect observation aggregate differs from canonical binding");
  }
  switch (effect.type) {
    case "create-branch": {
      if (
        observation.type !== effect.type ||
        observation.repositoryId !== effect.repositoryId ||
        observation.baseSha !== effect.baseSha ||
        observation.headRef !== effect.headRef ||
        observation.headSha !== effect.baseSha ||
        observation.snapshot.branches[effect.headRef] !== effect.baseSha
      ) {
        fail("PARTIAL_EFFECT", "branch postcondition does not match the effect");
      }
      return;
    }
    case "create-commit": {
      if (
        observation.type !== effect.type ||
        patchBundle === null ||
        observation.repositoryId !== effect.repositoryId ||
        observation.headRef !== effect.headRef ||
        observation.parentSha !== effect.parentSha ||
        observation.commitSha === effect.parentSha ||
        observation.snapshot.branches[effect.headRef] !== observation.commitSha ||
        observation.patchDigest !== effect.patchDigest ||
        observation.treeDigest !== effect.treeDigest ||
        observation.gitTreeSha !== effect.gitTreeSha ||
        effect.patchBundleDigest !== digest(patchBundle) ||
        observation.files.length !== patchBundle.files.length ||
        observation.files.some((file, index) => {
          const expected = patchBundle.files[index];
          return (
            expected === undefined ||
            file.path !== expected.path ||
            file.contentDigest !== expected.afterDigest ||
            file.mode !== expected.mode ||
            file.blobSha !== expected.gitBlobSha
          );
        }) ||
        !/^[0-9a-f]{40}$/u.test(observation.gitTreeSha)
      ) {
        fail("PARTIAL_EFFECT", "commit tree, content, or patch postcondition differs");
      }
      return;
    }
    case "create-draft-pull-request": {
      const pull = observation.type === effect.type
        ? observation.pullRequest
        : null;
      const freshPull = observation.snapshot.pullRequest;
      if (
        pull === null ||
        freshPull === null ||
        !pull.draft ||
        !freshPull.draft ||
        !freshPull.open ||
        freshPull.merged ||
        !/^[0-9a-f]{40}$/u.test(freshPull.baseSha) ||
        (!allowCompletedDraftPullRequestBaseAdvance &&
          freshPull.baseSha !== effect.baseSha) ||
        observation.snapshot.repositoryId !== effect.repositoryId ||
        pull.number !== freshPull.number ||
        pull.nodeId !== freshPull.nodeId ||
        pull.baseRepositoryId !== freshPull.baseRepositoryId ||
        pull.baseRef !== freshPull.baseRef ||
        pull.headRepositoryId !== freshPull.headRepositoryId ||
        pull.headRef !== freshPull.headRef ||
        pull.headSha !== freshPull.headSha ||
        pull.baseRepositoryId !== effect.baseRepositoryId ||
        freshPull.baseRef !== effect.baseRef ||
        freshPull.baseRepositoryId !== effect.baseRepositoryId ||
        freshPull.headRepositoryId !== effect.headRepositoryId ||
        freshPull.headRef !== effect.headRef ||
        freshPull.headSha !== effect.headSha ||
        pull.headRepositoryId !== effect.headRepositoryId ||
        pull.baseRef !== effect.baseRef ||
        pull.baseSha !== effect.baseSha ||
        pull.headRef !== effect.headRef ||
        pull.headSha !== effect.headSha
      ) {
        fail("PARTIAL_EFFECT", "draft pull-request postcondition differs");
      }
      return;
    }
    case "bind-pull-request":
      if (
        observation.type !== effect.type ||
        observation.expectedBindingDigest !== effect.expectedBindingDigest ||
        digest(observation.pullRequest) !== digest(effect.pullRequest) ||
        observation.receiptHead !== effect.receiptHead
      ) {
        fail("PARTIAL_EFFECT", "pull-request binding receipt differs");
      }
      return;
    case "comment-review": {
      const reviewComment =
        observation.type === effect.type
          ? observation.snapshot.reviewComments[observation.nodeId]
          : undefined;
      if (
        observation.type !== effect.type ||
        observation.repositoryId !== effect.repositoryId ||
        observation.pullRequestNumber !== effect.pullRequestNumber ||
        observation.pullRequestNodeId !== effect.pullRequestNodeId ||
        observation.headSha !== effect.headSha ||
        observation.event !== "COMMENT" ||
        observation.bodyDigest !== digest(effect.body) ||
        observation.snapshot.pullRequest?.headSha !== effect.headSha ||
        reviewComment === undefined ||
        digest(reviewComment) !==
          digest({
            repositoryId: effect.repositoryId,
            pullRequestNumber: effect.pullRequestNumber,
            pullRequestNodeId: effect.pullRequestNodeId,
            headSha: effect.headSha,
            event: "COMMENT",
            bodyDigest: digest(effect.body)
          })
      ) {
        fail("PARTIAL_EFFECT", "COMMENT review postcondition differs");
      }
      return;
    }
    case "project-converge":
      if (
        observation.type !== effect.type ||
        observation.projectNodeId !== effect.projectNodeId ||
        observation.projectItemNodeId !== effect.projectItemNodeId ||
        observation.stage !== effect.stage ||
        observation.mergedSha !== effect.mergedSha ||
        observation.snapshot.projectStage !== effect.stage
      ) {
        fail("PARTIAL_EFFECT", "Project postcondition differs");
      }
      return;
    case "close-issue":
      if (
        observation.type !== effect.type ||
        observation.repositoryId !== effect.repositoryId ||
        observation.issueNumber !== effect.issueNumber ||
        observation.issueNodeId !== effect.issueNodeId ||
        observation.closed !== true ||
        observation.mergedSha !== effect.mergedSha ||
        !observation.snapshot.issueClosed
      ) {
        fail("PARTIAL_EFFECT", "Issue closure postcondition differs");
      }
      return;
    case "record-delivery": {
      const deliveryRecord =
        observation.type === effect.type
          ? observation.snapshot.deliveryRecords[observation.recordNodeId]
          : undefined;
      if (
        observation.type !== effect.type ||
        observation.recordNodeId.length === 0 ||
        observation.bindingDigest !== effect.bindingDigest ||
        observation.mergedSha !== effect.mergedSha ||
        observation.verificationDigest !== effect.verificationDigest ||
        deliveryRecord === undefined ||
        digest(deliveryRecord) !==
          digest({
            bindingDigest: effect.bindingDigest,
            mergedSha: effect.mergedSha,
            verificationDigest: effect.verificationDigest
          })
      ) {
        fail("PARTIAL_EFFECT", "delivery record postcondition differs");
      }
      return;
    }
    case "operations-handoff": {
      const operationsRecord =
        observation.type === effect.type
          ? observation.snapshot.operationsRecords[observation.recordNodeId]
          : undefined;
      if (
        observation.type !== effect.type ||
        observation.recordNodeId.length === 0 ||
        observation.bindingDigest !== effect.bindingDigest ||
        observation.mergedSha !== effect.mergedSha ||
        observation.measurementPlanDigest !== effect.measurementPlanDigest ||
        operationsRecord === undefined ||
        digest(operationsRecord) !==
          digest({
            bindingDigest: effect.bindingDigest,
            mergedSha: effect.mergedSha,
            measurementPlanDigest: effect.measurementPlanDigest
          })
      ) {
        fail("PARTIAL_EFFECT", "operations record postcondition differs");
      }
      return;
    }
  }
}

function assertObservationMatchesEffect(
  effect: EngineeringDeliveryEffect,
  observation: EngineeringEffectObservation,
  patchBundle: TrustedValidatedPatchBundle | null,
  binding: EngineeringWorkBinding
): void {
  assertObservationMatchesEffectWithReplayPolicy(
    effect,
    observation,
    patchBundle,
    binding,
    null,
    false
  );
}

function assertCompletedObservationMatchesEffect(
  effect: EngineeringDeliveryEffect,
  observation: EngineeringEffectObservation,
  patchBundle: TrustedValidatedPatchBundle | null,
  binding: EngineeringWorkBinding,
  freshBinding: EngineeringWorkBinding,
  requireReboundCanonicalBinding: boolean
): void {
  const observedPullRequest =
    observation.type === "create-draft-pull-request"
      ? observation.pullRequest
      : null;
  if (
    effect.type === "create-draft-pull-request" &&
    (requireReboundCanonicalBinding || digest(freshBinding) !== digest(binding)) &&
    (freshBinding.schemaVersion !== binding.schemaVersion ||
      freshBinding.revision !== binding.revision + 1 ||
      freshBinding.previousBindingDigest !== digest(binding) ||
      digest(freshBinding.repository) !== digest(binding.repository) ||
      digest(freshBinding.issue) !== digest(binding.issue) ||
      digest(freshBinding.project) !== digest(binding.project) ||
      freshBinding.requesterActorId !== binding.requesterActorId ||
      freshBinding.automationActorId !== binding.automationActorId ||
      freshBinding.pullRequest === null ||
      observedPullRequest === null ||
      digest(freshBinding.pullRequest) !==
        digest({
          number: observedPullRequest.number,
          nodeId: observedPullRequest.nodeId,
          baseRepositoryId: observedPullRequest.baseRepositoryId,
          baseRef: observedPullRequest.baseRef,
          baseSha: observedPullRequest.baseSha,
          headRepositoryId: observedPullRequest.headRepositoryId,
          headRef: observedPullRequest.headRef,
          headSha: observedPullRequest.headSha
        }))
  ) {
    fail("BINDING_STALE", "completed replay canonical binding is inconsistent");
  }
  assertObservationMatchesEffectWithReplayPolicy(
    effect,
    observation,
    patchBundle,
    binding,
    effect.type === "create-draft-pull-request" ? digest(freshBinding) : null,
    effect.type === "create-draft-pull-request"
  );
}

export interface EngineeringEffectExecutionResult {
  readonly status: "applied" | "replayed" | "reconciled";
  readonly evidence: EngineeringEffectEvidence;
  readonly observation: EngineeringEffectObservation;
}

export interface EngineeringEffectExecutionInput {
  readonly workflowId: string;
  readonly contractRevision: number;
  readonly effect: EngineeringDeliveryEffect;
  readonly binding: EngineeringWorkBinding;
  readonly workAccordDigest: Digest;
  readonly activationLeaseDigest: Digest;
  readonly executionGrantDigest: Digest;
  readonly kernelReceiptDigest: Digest;
  readonly authorization: EngineeringDeliveryAuthorization;
  readonly threatEvidence: EngineeringThreatEvidence;
  readonly modelOutputDigest: Digest;
  readonly patchBundle?: TrustedValidatedPatchBundle;
  readonly completedReplayBinding?: EngineeringWorkBinding;
  readonly beforeWrite?: () => Promise<void>;
}

export interface RuntimeFreshnessEvidence {
  readonly runtimeAuthorization: {
    readonly observedAt: string;
    readonly expiresAt: string;
  };
  readonly kernelProof: { readonly observedAt: string };
  readonly threatEvidence: {
    readonly observedAt: string;
    readonly expiresAt: string;
  };
  readonly patchArtifact: {
    readonly observedAt: string;
    readonly expiresAt: string;
  };
  readonly patchBundle: {
    readonly observedAt: string;
    readonly expiresAt: string;
  };
  readonly executionBundle: {
    readonly observedAt: string;
    readonly expiresAt: string;
  } | null;
}

interface EngineeringHumanMergeInput {
  readonly binding: EngineeringWorkBinding;
  readonly requesterId: string;
  readonly automationActorId: string;
  readonly approvedAt: string;
}

interface EngineeringHumanMergeObservation {
  readonly mergedSha: string;
  readonly mergedByActorId: string;
  readonly observedAt: string;
  readonly evidenceDigest: Digest;
}

const engineeringAdapterInternals = new WeakMap<
  EngineeringGitHubAdapter,
  {
    readonly execute: (
      input: EngineeringEffectExecutionInput,
      freshness: EngineeringFreshnessState
    ) => Promise<EngineeringEffectExecutionResult>;
    readonly observeHumanMerge: (
      input: EngineeringHumanMergeInput,
      freshness: EngineeringFreshnessState
    ) => Promise<EngineeringHumanMergeObservation>;
  }
>();

export class EngineeringGitHubAdapter {
  constructor(
    private readonly broker: OperationScopedGitHubBroker,
    private readonly store: EngineeringEvidenceStore,
    private readonly signer: EvidenceSigner,
    private readonly verifier: EvidenceVerifier,
    ...legacyFreshness: never[]
  ) {
    if (legacyFreshness.length !== 0) {
      fail(
        "AUTHORIZATION_INVALID",
        "adapter freshness must come from a validated runtime-policy context"
      );
    }
    engineeringAdapterInternals.set(this, {
      execute: (input, freshness) =>
        this.#executeWithFreshness(input, freshness),
      observeHumanMerge: (input, freshness) =>
        this.#observeHumanMergeWithFreshness(input, freshness)
    });
  }

  async readBoundSnapshot(
    binding: EngineeringWorkBinding,
    allowUnboundPullRequest = false
  ): Promise<EngineeringGitHubSnapshot> {
    return this.broker.withApiForEffect("create-branch", async (api) => {
      const snapshot = await api.readSnapshot();
      assertBindingSnapshot(
        binding,
        snapshot,
        allowUnboundPullRequest
      );
      return snapshot;
    });
  }

  private async append(
    expected: EngineeringEffectEvidence | null,
    payload: Omit<EngineeringEffectEvidence, "signature">
  ): Promise<EngineeringEffectEvidence> {
    const evidence = {
      ...payload,
      signature: await this.signer.sign(payload)
    };
    if (!this.verifier.verify(payload, evidence.signature)) {
      fail("AUTHORIZATION_INVALID", "effect evidence signer is not trusted");
    }
    await this.store.conditionalAppend(expected, evidence);
    return evidence;
  }

  async execute(input: EngineeringEffectExecutionInput & {
    readonly freshnessAuthority: TrustedExecutionFreshnessAuthority;
    readonly patchArtifactDigest: Digest;
    readonly patchBundleDigest: Digest;
    readonly executionBundleDigest: Digest | null;
  }): Promise<EngineeringEffectExecutionResult> {
    const authority = assertTrustedExecutionFreshnessAuthority(
      input.freshnessAuthority
    );
    const { authorization, runtimePolicy } = authority;
    const executionBinding = runtimePolicy.phaseBindings.find(
      (binding) => binding.phase === "execution"
    );
    if (
      runtimePolicy.limits.maxEvidenceAgeMs !== 300_000 ||
      digest(runtimePolicy) !== authority.runtimePolicyDigest ||
      authorization.policyDigest !== authority.runtimePolicyDigest ||
      authorization.authorizationDigest !== authority.authorizationDigest ||
      executionBinding?.workflow !== authorization.workflowId ||
      authorization.workflowId !== input.workflowId ||
      authorization.contractRevision !== input.contractRevision ||
      authorization.contractDigest !== input.workAccordDigest ||
      authorization.activationLeaseDigest !== input.activationLeaseDigest ||
      authorization.kernelReceiptDigest !== input.kernelReceiptDigest ||
      authority.kernelReceiptDigest !== input.kernelReceiptDigest ||
      authorization.bindingDigest !== digest(input.binding) ||
      authority.executionGrantDigest !== input.executionGrantDigest ||
      authority.modelOutputDigest !== input.modelOutputDigest ||
      authority.patchArtifactDigest !== input.patchArtifactDigest ||
      authority.patchBundleDigest !== input.patchBundleDigest ||
      authority.executionBundleDigest === null ||
      authority.executionBundleDigest !== input.executionBundleDigest ||
      (input.patchBundle !== undefined &&
        digest(input.patchBundle) !== authority.patchBundleDigest)
    ) {
      fail(
        "AUTHORIZATION_INVALID",
        "runtime freshness authority is not bound to the exact policy, authorization, artifact, and effect"
      );
    }
    return this.#executeWithFreshness(input, runtimeFreshnessState(authority));
  }

  async #executeWithFreshness(
    input: EngineeringEffectExecutionInput,
    freshness: EngineeringFreshnessState
  ): Promise<EngineeringEffectExecutionResult> {
    const now = freshness.assertFresh();
    if (
      input.completedReplayBinding !== undefined &&
      input.effect.type !== "create-draft-pull-request"
    ) {
      fail(
        "AUTHORIZATION_INVALID",
        "completed replay binding is valid only for a draft pull-request effect"
      );
    }
    assertDeliveryAuthorization({
      authorization: input.authorization,
      verifier: this.verifier,
      effect: input.effect,
      binding: input.binding,
      workflowId: input.workflowId,
      contractRevision: input.contractRevision,
      workAccordDigest: input.workAccordDigest,
      activationLeaseDigest: input.activationLeaseDigest,
      executionGrantDigest: input.executionGrantDigest,
      kernelReceiptDigest: input.kernelReceiptDigest,
      now,
      maximumAgeMs: freshness.maxEvidenceAgeMs
    });
    assertThreatEvidence({
      evidence: input.threatEvidence,
      authorization: input.authorization,
      modelOutputDigest: input.modelOutputDigest,
      kernelReceiptDigest: input.kernelReceiptDigest,
      verifier: this.verifier,
      now,
      maximumAgeMs: freshness.maxEvidenceAgeMs
    });
    const patchBundle = input.patchBundle ?? null;
    if (input.effect.type === "create-commit") {
      if (patchBundle === null) {
        fail("AUTHORIZATION_INVALID", "create-commit requires its signed patch bundle");
      }
      validateTrustedValidatedPatchBundle({
        bundle: patchBundle,
        verifier: this.verifier,
        bindingDigest: digest(input.binding),
        workAccordDigest: input.workAccordDigest,
        executionGrantDigest: patchBundle.executionGrantDigest,
        kernelReceiptDigest: input.kernelReceiptDigest,
        modelOutputDigest: input.modelOutputDigest,
        now
      });
      if (
        input.effect.patchBundleDigest !== digest(patchBundle) ||
        input.executionGrantDigest !== patchBundle.executionGrantDigest ||
        input.effect.parentSha !== patchBundle.baseSha ||
        input.effect.patchDigest !== patchBundle.patchDigest ||
        input.effect.treeDigest !== patchBundle.treeDigest ||
        input.effect.gitTreeSha !== patchBundle.gitTreeSha
      ) {
        fail("AUTHORIZATION_INVALID", "commit effect differs from its signed patch bundle");
      }
    } else if (patchBundle !== null) {
      fail("AUTHORIZATION_INVALID", "only create-commit may receive patch content");
    }
    const effectKey = digest({
      workflowId: input.authorization.workflowId,
      workItemNodeId: input.binding.issue.nodeId,
      contractRevision: input.authorization.contractRevision,
      effectOrdinal: input.effect.ordinal,
      effectType: input.effect.type
    });
    const planDigest = digest(input.effect);
    const stored = await this.store.read(effectKey);
    let previous =
      stored === null
        ? null
        : assertDocument("EngineeringEffectEvidence", stored);
    if (previous !== null) {
      if (
        previous.planDigest !== planDigest ||
        previous.bindingDigest !== digest(input.binding) ||
        previous.effectKey !== effectKey ||
        previous.effectOrdinal !== input.effect.ordinal ||
        previous.effectType !== input.effect.type ||
        previous.workflowId !== input.workflowId ||
        previous.contractRevision !== input.contractRevision ||
        !this.verifier.verify(effectEvidencePayload(previous), previous.signature)
      ) {
        fail("CONCURRENCY_CONFLICT", "persisted effect evidence is invalid or conflicting");
      }
      assertFreshWindow({
        observedAt: previous.updatedAt,
        expiresAt: input.authorization.expiresAt,
        now,
        maximumAgeMs: freshness.maxEvidenceAgeMs
      });
      if (previous.state === "completed" && previous.effectDigest !== null) {
        const completedEffectDigest = previous.effectDigest;
        const observation = await this.broker.withApiForEffect(
          input.effect.type,
          async (api) => {
            const observed = await api.observeEffect(input.effect);
            if (observed === null || observed.effectDigest !== completedEffectDigest) {
              fail("PARTIAL_EFFECT", "completed effect cannot be re-observed exactly");
            }
            assertCompletedObservationMatchesEffect(
              input.effect,
              observed,
              patchBundle,
              input.binding,
              input.completedReplayBinding ?? input.binding,
              input.completedReplayBinding !== undefined
            );
            return observed;
          }
        );
        return { status: "replayed", evidence: previous, observation };
      }
      if (previous.state === "rejected") {
        previous = await this.append(previous, {
          sequence: previous.sequence + 1,
          previousEvidenceDigest: digest(previous),
          effectKey,
          effectOrdinal: input.effect.ordinal,
          effectType: input.effect.type,
          workflowId: input.workflowId,
          contractRevision: input.contractRevision,
          planDigest,
          bindingDigest: digest(input.binding),
          state: "pending",
          effectDigest: null,
          createdAt: previous.createdAt,
          updatedAt: now
        });
      } else {
        const reconciled = await this.broker.withApiForEffect(
          input.effect.type,
          async (api) => api.observeEffect(input.effect)
        );
        if (reconciled === null) {
          fail(
            "PARTIAL_EFFECT",
            `${previous.state} effect is not safely retryable without an exact observation`
          );
        }
        assertObservationMatchesEffect(
          input.effect,
          reconciled,
          patchBundle,
          input.binding
        );
        const completed = await this.append(previous, {
          sequence: previous.sequence + 1,
          previousEvidenceDigest: digest(previous),
          effectKey,
          effectOrdinal: input.effect.ordinal,
          effectType: input.effect.type,
          workflowId: input.workflowId,
          contractRevision: input.contractRevision,
          planDigest,
          bindingDigest: digest(input.binding),
          state: "completed",
          effectDigest: reconciled.effectDigest,
          createdAt: previous.createdAt,
          updatedAt: now
        });
        return { status: "reconciled", evidence: completed, observation: reconciled };
      }
    }
    let writeAttempted = false;
    if (previous === null) {
      try {
        previous = await this.append(null, {
          sequence: 1,
          previousEvidenceDigest: null,
          effectKey,
          effectOrdinal: input.effect.ordinal,
          effectType: input.effect.type,
          workflowId: input.workflowId,
          contractRevision: input.contractRevision,
          planDigest,
          bindingDigest: digest(input.binding),
          state: "pending",
          effectDigest: null,
          createdAt: now,
          updatedAt: now
        });
      } catch (error) {
        if (!(error instanceof EngineeringEvidenceConflictError)) throw error;
        fail("CONCURRENCY_CONFLICT", "another writer won the effect evidence CAS");
      }
    }
    try {
      const observation = await this.broker.withApiForEffect(
        input.effect.type,
        async (api) => {
          const snapshot = await api.readSnapshot();
          assertEffectTargets(input.effect, input.binding, snapshot);
          const nowBeforeWrite = freshness.assertFresh();
          assertDeliveryAuthorization({
            authorization: input.authorization,
            verifier: this.verifier,
            effect: input.effect,
            binding: input.binding,
            workflowId: input.workflowId,
            contractRevision: input.contractRevision,
            workAccordDigest: input.workAccordDigest,
            activationLeaseDigest: input.activationLeaseDigest,
            executionGrantDigest: input.executionGrantDigest,
            kernelReceiptDigest: input.kernelReceiptDigest,
            now: nowBeforeWrite,
            maximumAgeMs: freshness.maxEvidenceAgeMs
          });
          assertThreatEvidence({
            evidence: input.threatEvidence,
            authorization: input.authorization,
            modelOutputDigest: input.modelOutputDigest,
            kernelReceiptDigest: input.kernelReceiptDigest,
            verifier: this.verifier,
            now: nowBeforeWrite,
            maximumAgeMs: freshness.maxEvidenceAgeMs
          });
          await input.beforeWrite?.();
          const nowAtMutation = freshness.assertFresh();
          assertDeliveryAuthorization({
            authorization: input.authorization,
            verifier: this.verifier,
            effect: input.effect,
            binding: input.binding,
            workflowId: input.workflowId,
            contractRevision: input.contractRevision,
            workAccordDigest: input.workAccordDigest,
            activationLeaseDigest: input.activationLeaseDigest,
            executionGrantDigest: input.executionGrantDigest,
            kernelReceiptDigest: input.kernelReceiptDigest,
            now: nowAtMutation,
            maximumAgeMs: freshness.maxEvidenceAgeMs
          });
          assertThreatEvidence({
            evidence: input.threatEvidence,
            authorization: input.authorization,
            modelOutputDigest: input.modelOutputDigest,
            kernelReceiptDigest: input.kernelReceiptDigest,
            verifier: this.verifier,
            now: nowAtMutation,
            maximumAgeMs: freshness.maxEvidenceAgeMs
          });
          writeAttempted = true;
          const applied = await api.applyEffect(input.effect, patchBundle);
          const observed = await api.observeEffect(input.effect);
          freshness.assertFresh();
          if (
            observed === null ||
            observed.effectDigest !== applied.effectDigest
          ) {
            fail("PARTIAL_EFFECT", "effect was not observed exactly after write");
          }
          assertObservationMatchesEffect(
            input.effect,
            applied,
            patchBundle,
            input.binding
          );
          assertObservationMatchesEffect(
            input.effect,
            observed,
            patchBundle,
            input.binding
          );
          return observed;
        }
      );
      const completed = await this.append(previous, {
        sequence: previous.sequence + 1,
        previousEvidenceDigest: digest(previous),
        effectKey,
        effectOrdinal: input.effect.ordinal,
        effectType: input.effect.type,
        workflowId: input.workflowId,
        contractRevision: input.contractRevision,
        planDigest,
        bindingDigest: digest(input.binding),
        state: "completed",
        effectDigest: observation.effectDigest,
        createdAt: previous.createdAt,
        updatedAt: freshness.clock.now()
      });
      return { status: "applied", evidence: completed, observation };
    } catch (error) {
      let failureEvidence: EngineeringEffectEvidence;
      try {
        failureEvidence = await this.append(previous, {
          sequence: previous.sequence + 1,
          previousEvidenceDigest: digest(previous),
          effectKey,
          effectOrdinal: input.effect.ordinal,
          effectType: input.effect.type,
          workflowId: input.workflowId,
          contractRevision: input.contractRevision,
          planDigest,
          bindingDigest: digest(input.binding),
          state: writeAttempted ? "partial" : "rejected",
          effectDigest: null,
          createdAt: previous.createdAt,
          updatedAt: freshness.clock.now()
        });
      } catch (evidenceError) {
        throw new AggregateError(
          [error, evidenceError],
          "effect failure and evidence persistence both failed"
        );
      }
      if (!writeAttempted) throw error;
      if (error instanceof EngineeringSliceError) throw error;
      throw new EngineeringSliceError(
        "PARTIAL_EFFECT",
        `effect failed after write attempt ${failureEvidence.effectKey}`
      );
    }
  }

  async #observeHumanMergeWithFreshness(
    input: EngineeringHumanMergeInput,
    freshness: EngineeringFreshnessState
  ): Promise<EngineeringHumanMergeObservation> {
    if (input.binding.pullRequest === null) {
      fail("HUMAN_MERGE_REQUIRED", "pull request is not bound");
    }
    return this.broker.withApiForEffect("record-delivery", async (api) => {
      const snapshot = await api.readSnapshot();
      assertBindingSnapshot(input.binding, snapshot);
      const pull = snapshot.pullRequest;
      if (
        pull === null ||
        !pull.merged ||
        pull.mergedSha === null ||
        pull.mergedByActorId === null ||
        !pull.mergedByHuman ||
        pull.mergedByActorId === input.requesterId ||
        pull.mergedByActorId === input.automationActorId ||
        pull.nodeId !== input.binding.pullRequest?.nodeId ||
        pull.headSha !== input.binding.pullRequest?.headSha ||
        pull.mergedAt === null ||
        timestamp(pull.mergedAt, "mergedAt") <=
          timestamp(input.approvedAt, "approvedAt")
      ) {
        fail(
          "HUMAN_MERGE_REQUIRED",
          "completion requires an independent human merge of the exact reviewed head"
        );
      }
      const observedAt = freshness.assertFresh();
      return {
        mergedSha: pull.mergedSha,
        mergedByActorId: pull.mergedByActorId,
        observedAt,
        evidenceDigest: digest({
          bindingDigest: digest(input.binding),
          mergedSha: pull.mergedSha,
          mergedByActorId: pull.mergedByActorId
        })
      };
    });
  }
}

function executeEngineeringEffectInternally(
  github: EngineeringGitHubAdapter,
  input: EngineeringEffectExecutionInput,
  clock: TrustedClock,
  maxEvidenceAgeMs: number
): Promise<EngineeringEffectExecutionResult> {
  if (maxEvidenceAgeMs !== 300_000) {
    fail(
      "AUTHORIZATION_INVALID",
      "engineering freshness must use the fixed 300000 ms policy ceiling"
    );
  }
  const adapter = engineeringAdapterInternals.get(github);
  if (adapter === undefined) {
    fail("AUTHORIZATION_INVALID", "unrecognized engineering adapter instance");
  }
  return adapter.execute(input, engineeringFreshnessState(clock));
}

function observeEngineeringHumanMergeInternally(
  github: EngineeringGitHubAdapter,
  input: EngineeringHumanMergeInput,
  clock: TrustedClock,
  maxEvidenceAgeMs: number
): Promise<EngineeringHumanMergeObservation> {
  if (maxEvidenceAgeMs !== 300_000) {
    fail(
      "AUTHORIZATION_INVALID",
      "engineering freshness must use the fixed 300000 ms policy ceiling"
    );
  }
  const adapter = engineeringAdapterInternals.get(github);
  if (adapter === undefined) {
    fail("AUTHORIZATION_INVALID", "unrecognized engineering adapter instance");
  }
  return adapter.observeHumanMerge(input, engineeringFreshnessState(clock));
}

export interface EngineeringKernelPort {
  transition(input: {
    readonly transitionKey: Digest;
    readonly event:
      | "activation-approved"
      | "frame-accepted"
      | "execution-authorized"
      | "work-submitted"
      | "verification-passed"
      | "outcome-accepted";
    readonly expectedRouteId: string;
    readonly approval: SignedArtifactApproval | null;
    readonly evidenceDigest: Digest;
  }): {
    readonly routeId: string;
    readonly snapshotDigest: Digest;
    readonly receiptDigest: Digest;
  };
}

export interface EngineeringModel {
  frame(input: {
    readonly issueDigest: Digest;
    readonly workAccordDigest: Digest;
    readonly attempt: EngineeringProviderAttempt;
  }): Promise<{
    readonly artifact: FramingArtifact;
    readonly costUnits: number;
    readonly tokenUnits: number;
  }>;
  implement(input: {
    readonly planningDigest: Digest;
    readonly targetSlots: readonly string[];
    readonly attempt: EngineeringProviderAttempt;
  }): Promise<{
    readonly patch: TargetFreePatch;
    readonly costUnits: number;
    readonly tokenUnits: number;
  }>;
  review(input: {
    readonly patchDigest: Digest;
    readonly headSha: string;
    readonly attempt: EngineeringProviderAttempt;
  }): Promise<{
    readonly output: GitHubSafeOutput;
    readonly costUnits: number;
    readonly tokenUnits: number;
  }>;
}

export interface EngineeringPlanner {
  plan(input: {
    readonly framingDigest: Digest;
    readonly availableTargetSlots: readonly string[];
    readonly availableVerificationIds: readonly string[];
  }): PlanningArtifact;
}

export interface HumanGateProvider {
  read(
    gate: SignedArtifactApproval["gate"]
  ): Promise<SignedArtifactApproval | null>;
}

export interface DeliveryAuthorizationProvider {
  issue(input: {
    readonly workflowId: string;
    readonly contractRevision: number;
    readonly effect: EngineeringDeliveryEffect;
    readonly binding: EngineeringWorkBinding;
    readonly workAccordDigest: Digest;
    readonly activationLeaseDigest: Digest;
    readonly executionGrantDigest: Digest;
    readonly kernelReceiptDigest: Digest;
    readonly now: string;
  }): Promise<EngineeringDeliveryAuthorization>;
}

export interface ThreatScanner {
  scan(input: {
    readonly authorizationDigest: Digest;
    readonly modelOutputDigest: Digest;
    readonly kernelReceiptDigest: Digest;
    readonly now: string;
  }): Promise<EngineeringThreatEvidence>;
}

export interface EngineeringSliceResult {
  readonly binding: EngineeringWorkBinding;
  readonly framingDigest: Digest;
  readonly planningDigest: Digest;
  readonly patch: ValidatedPatch;
  readonly pullRequest: EngineeringPullRequestBinding;
  readonly reviewDigest: Digest;
  readonly mergedSha: string;
  readonly deliveryEvidenceDigest: Digest;
  readonly operationsReceiptDigest: Digest;
  readonly kernelReceiptDigest: Digest;
  readonly costSettlements: readonly EngineeringCostSettlement[];
  readonly costRelease: EngineeringCostRelease;
  readonly closureCheckpointDigest: Digest;
}

export interface EngineeringAwaitingHumanMergeCheckpoint {
  readonly schemaVersion: "1.1.0";
  readonly stage: "awaiting-human-merge";
  readonly workflowId: string;
  readonly contractRevision: number;
  readonly bindingDigest: Digest;
  readonly binding: EngineeringWorkBinding;
  readonly workAccordDigest: Digest;
  readonly controlPolicyDigest: Digest;
  readonly activationLeaseDigest: Digest;
  readonly executionGrantDigest: Digest;
  readonly requesterId: string;
  readonly automationActorId: string;
  readonly framingDigest: Digest;
  readonly planningDigest: Digest;
  readonly patch: ValidatedPatch;
  readonly pullRequest: EngineeringPullRequestBinding;
  readonly reviewedHead: string;
  readonly reviewDigest: Digest;
  readonly reservation: EngineeringCostReservation;
  readonly costSettlements: readonly EngineeringCostSettlement[];
  /**
   * The caller's view of holds no settlement has discharged.
   *
   * Deliberately *not* the lineage: a release reconstructs the chain from the
   * content it pins, and this is only asserted as a subset of what the release
   * derived. Persisting a full hold list here would put a possibly-incomplete
   * caller array into signed evidence and invite it being trusted later.
   */
  readonly openHolds: readonly EngineeringCostHold[];
  readonly measurementPlanDigest: Digest;
  readonly nextEffectOrdinal: number;
  readonly kernelSnapshotDigest: Digest;
  readonly kernelReceiptDigest: Digest;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly signature: DetachedSignature;
}

export interface EngineeringAwaitingHumanMergeResult {
  readonly status: "awaiting-human-merge";
  readonly binding: EngineeringWorkBinding;
  readonly pullRequest: EngineeringPullRequestBinding;
  readonly reviewedHead: string;
  readonly reviewDigest: Digest;
  readonly checkpointDigest: Digest;
  readonly costSettlements: readonly EngineeringCostSettlement[];
}

export interface EngineeringCostReleaseCheckpoint {
  readonly schemaVersion: "1.1.0";
  readonly stage: "cost-release-pending";
  readonly bindingDigest: Digest;
  readonly awaitingCheckpointDigest: Digest;
  readonly awaiting: EngineeringAwaitingHumanMergeCheckpoint;
  readonly mergeApproval: SignedArtifactApproval;
  readonly mergeEvidence: EngineeringClosureCheckpoint["mergeEvidence"];
  readonly releaseIdempotencyKey: Digest;
  readonly costRelease: EngineeringCostRelease | null;
  readonly updatedAt: string;
  readonly expiresAt: string;
  readonly signature: DetachedSignature;
}

export interface EngineeringClosureCheckpoint {
  readonly schemaVersion: "1.1.0";
  readonly workflowId: string;
  readonly contractRevision: number;
  readonly binding: EngineeringWorkBinding;
  readonly workAccordDigest: Digest;
  readonly controlPolicyDigest: Digest;
  readonly activationLeaseDigest: Digest;
  readonly executionGrantDigest: Digest;
  readonly reviewedHead: string;
  readonly mergeEvidence: {
    readonly mergedSha: string;
    readonly mergedByActorId: string;
    readonly observedAt: string;
    readonly evidenceDigest: Digest;
  };
  readonly patchDigest: Digest;
  readonly reviewDigest: Digest;
  readonly reservation: EngineeringCostReservation;
  readonly costSettlements: readonly EngineeringCostSettlement[];
  /**
   * The caller's view of holds no settlement has discharged.
   *
   * Deliberately *not* the lineage: a release reconstructs the chain from the
   * content it pins, and this is only asserted as a subset of what the release
   * derived. Persisting a full hold list here would put a possibly-incomplete
   * caller array into signed evidence and invite it being trusted later.
   */
  readonly openHolds: readonly EngineeringCostHold[];
  readonly costSettlementDigests: readonly Digest[];
  readonly costRelease: EngineeringCostRelease;
  readonly measurementPlanDigest: Digest;
  readonly nextEffectOrdinal: number;
  readonly mergeApproval: SignedArtifactApproval;
  readonly kernelSnapshotDigest: Digest;
  readonly kernelReceiptDigest: Digest;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly signature: DetachedSignature;
}

export interface EngineeringClosureCheckpointStore {
  put(checkpoint: EngineeringClosureCheckpoint): Promise<void>;
  read(checkpointDigest: Digest): Promise<EngineeringClosureCheckpoint | null>;
  putAwaitingHumanMerge(
    checkpoint: EngineeringAwaitingHumanMergeCheckpoint
  ): Promise<void>;
  readAwaitingHumanMerge(
    bindingDigest: Digest
  ): Promise<EngineeringAwaitingHumanMergeCheckpoint | null>;
  putCostRelease(checkpoint: EngineeringCostReleaseCheckpoint): Promise<void>;
  readCostRelease(
    bindingDigest: Digest
  ): Promise<EngineeringCostReleaseCheckpoint | null>;
}

function closureCheckpointPayload(
  checkpoint: EngineeringClosureCheckpoint
): Omit<EngineeringClosureCheckpoint, "signature"> {
  const { signature: _signature, ...payload } = checkpoint;
  return payload;
}

function awaitingHumanMergeCheckpointPayload(
  checkpoint: EngineeringAwaitingHumanMergeCheckpoint
): Omit<EngineeringAwaitingHumanMergeCheckpoint, "signature"> {
  const { signature: _signature, ...payload } = checkpoint;
  return payload;
}

/**
 * The only supported engineering checkpoint contract revision.
 *
 * A checkpoint is signed over whatever fields its writer produced, so a
 * predecessor revision still verifies: the signature proves authorship, never
 * shape. The version is therefore compared explicitly at every read. A `1.0.0`
 * checkpoint carries `unresolvedAttempts` and no cost holds, and those holds
 * never existed and cannot be synthesized, so it is refused rather than
 * reinterpreted — continuing would reach the release path with an undefined
 * hold set and strand the entire reservation.
 */
const ENGINEERING_CHECKPOINT_SCHEMA_VERSION = "1.1.0";

function costReleaseCheckpointPayload(
  checkpoint: EngineeringCostReleaseCheckpoint
): Omit<EngineeringCostReleaseCheckpoint, "signature"> {
  const { signature: _signature, ...payload } = checkpoint;
  return payload;
}

export interface EngineeringClosureResult {
  readonly deliveryEvidenceDigest: Digest;
  readonly operationsReceiptDigest: Digest;
  readonly kernelReceiptDigest: Digest;
}

export async function resumeEngineeringClosure(input: {
  readonly checkpointDigest: Digest;
  readonly accord: WorkAccord;
  readonly controlPolicy: ControlPolicy;
  readonly maximumEvidenceAgeMs: number;
  readonly services: {
    readonly clock: TrustedClock;
    readonly verifier: EvidenceVerifier;
    readonly checkpoints: EngineeringClosureCheckpointStore;
    readonly humanGates: HumanGateProvider;
    readonly activationLeases: EngineeringActivationLeaseProvider;
    readonly github: EngineeringGitHubAdapter;
    readonly deliveryAuthorizations: DeliveryAuthorizationProvider;
    readonly threatScanner: ThreatScanner;
    readonly kernel: EngineeringKernelPort;
  };
}): Promise<EngineeringClosureResult> {
  const checkpoint = await input.services.checkpoints.read(input.checkpointDigest);
  if (
    checkpoint === null ||
    digest(checkpoint) !== input.checkpointDigest ||
    !input.services.verifier.verify(
      closureCheckpointPayload(checkpoint),
      checkpoint.signature
    ) ||
    checkpoint.binding.pullRequest?.headSha !== checkpoint.reviewedHead ||
    checkpoint.workAccordDigest !== digest(input.accord) ||
    checkpoint.controlPolicyDigest !== digest(input.controlPolicy) ||
    checkpoint.schemaVersion !== ENGINEERING_CHECKPOINT_SCHEMA_VERSION ||
    checkpoint.mergeEvidence.mergedSha.length !== 40 ||
    checkpoint.costRelease.reservationDigest.length === 0
  ) {
    fail("AUTHORIZATION_INVALID", "closure checkpoint is absent, unsigned, or inconsistent");
  }
  validateCostRelease({
    release: checkpoint.costRelease,
    reservation: checkpoint.reservation,
    settlements: checkpoint.costSettlements,
    knownOpenHolds: checkpoint.openHolds,
    verifier: input.services.verifier,
    now: input.services.clock.now(),
    maximumAgeMs: input.maximumEvidenceAgeMs
  });
  assertDurableUntilExpiry({
    createdAt: checkpoint.createdAt,
    expiresAt: checkpoint.expiresAt,
    now: input.services.clock.now()
  });
  const currentSnapshot = await input.services.github.readBoundSnapshot(
    checkpoint.binding
  );
  if (
    currentSnapshot.pullRequest?.headSha !== checkpoint.reviewedHead ||
    !currentSnapshot.pullRequest.merged ||
    !currentSnapshot.pullRequest.mergedByHuman ||
    currentSnapshot.pullRequest.mergedSha !== checkpoint.mergeEvidence.mergedSha ||
    currentSnapshot.pullRequest.mergedByActorId !==
      checkpoint.mergeEvidence.mergedByActorId
  ) {
    fail(
      "CURRENT_HEAD_STALE",
      "closure checkpoint no longer matches the fresh human merge observation"
    );
  }
  const lastSettlement = checkpoint.costSettlements.at(-1);
  const validateLiveClosureAuthority =
    async (): Promise<SignedArtifactApproval> => {
      const approval = await input.services.humanGates.read(
        "approve-current-head"
      );
      if (approval === null) {
        fail(
          "APPROVAL_INVALID",
          "fresh approve-current-head evidence is required for closure"
        );
      }
      await input.services.github.readBoundSnapshot(checkpoint.binding);
      validateArtifactApproval({
        approval,
        verifier: input.services.verifier,
        gate: "approve-current-head",
        artifactDigest: checkpoint.reviewDigest,
        routeId: "review.accept",
        snapshotDigest: checkpoint.kernelSnapshotDigest,
        workAccordDigest: checkpoint.workAccordDigest,
        activationLeaseDigest: checkpoint.activationLeaseDigest,
        repositoryId: checkpoint.binding.repository.id,
        workItemNodeId: checkpoint.binding.issue.nodeId,
        currentHead: checkpoint.reviewedHead,
        requesterId: checkpoint.binding.requesterActorId,
        automationActorId: checkpoint.binding.automationActorId,
        controlPolicy: input.controlPolicy,
        approverPolicy: input.accord.evidence.approverPolicy,
        now: input.services.clock.now(),
        maximumAgeMs: input.maximumEvidenceAgeMs
      });
      const leaseEvidence = await input.services.activationLeases.read({
        phase: "verification",
        binding: checkpoint.binding,
        reservation: checkpoint.reservation,
        now: input.services.clock.now()
      });
      validateActivationLeaseEvidence({
        evidence: leaseEvidence,
        binding: checkpoint.binding,
        reservation: checkpoint.reservation,
        activationLeaseDigest: checkpoint.activationLeaseDigest,
        workAccordDigest: checkpoint.workAccordDigest,
        phase: "verification",
        capability: "core.review-current-head@1.0.0",
        projectedCalls: lastSettlement?.cumulativeCalls ?? 0,
        projectedTokens: lastSettlement?.cumulativeTokens ?? 0,
        projectedCostUnits: lastSettlement?.cumulativeCostUnits ?? 0,
        verifier: input.services.verifier,
        now: input.services.clock.now(),
        maximumAgeMs: input.maximumEvidenceAgeMs
      });
      return approval;
    };
  await validateLiveClosureAuthority();
  let ordinal = checkpoint.nextEffectOrdinal;
  const execute = async (
    effect: EngineeringDeliveryEffect
  ): Promise<EngineeringEffectExecutionResult> => {
    const issuedAt = input.services.clock.now();
    const authorization = await input.services.deliveryAuthorizations.issue({
      workflowId: checkpoint.workflowId,
      contractRevision: checkpoint.contractRevision,
      effect,
      binding: checkpoint.binding,
      workAccordDigest: checkpoint.workAccordDigest,
      activationLeaseDigest: checkpoint.activationLeaseDigest,
      executionGrantDigest: checkpoint.executionGrantDigest,
      kernelReceiptDigest: checkpoint.kernelReceiptDigest,
      now: issuedAt
    });
    const threatEvidence = await input.services.threatScanner.scan({
      authorizationDigest: authorization.authorizationDigest,
      modelOutputDigest: input.checkpointDigest,
      kernelReceiptDigest: checkpoint.kernelReceiptDigest,
      now: issuedAt
    });
    return executeEngineeringEffectInternally(input.services.github, {
      workflowId: checkpoint.workflowId,
      contractRevision: checkpoint.contractRevision,
      effect,
      binding: checkpoint.binding,
      workAccordDigest: checkpoint.workAccordDigest,
      activationLeaseDigest: checkpoint.activationLeaseDigest,
      executionGrantDigest: checkpoint.executionGrantDigest,
      kernelReceiptDigest: checkpoint.kernelReceiptDigest,
      authorization,
      threatEvidence,
      modelOutputDigest: input.checkpointDigest,
      beforeWrite: async () => {
        await validateLiveClosureAuthority();
      }
    }, input.services.clock, input.maximumEvidenceAgeMs);
  };
  const project = await execute({
    type: "project-converge",
    ordinal: ordinal++,
    projectNodeId: checkpoint.binding.project.nodeId,
    projectItemNodeId: checkpoint.binding.project.itemNodeId,
    expectedStage: "human-review",
    stage: "completed",
    mergedSha: checkpoint.mergeEvidence.mergedSha
  });
  const closed = await execute({
    type: "close-issue",
    ordinal: ordinal++,
    repositoryId: checkpoint.binding.repository.id,
    issueNumber: checkpoint.binding.issue.number,
    issueNodeId: checkpoint.binding.issue.nodeId,
    mergedSha: checkpoint.mergeEvidence.mergedSha
  });
  const delivered = await execute({
    type: "record-delivery",
    ordinal: ordinal++,
    bindingDigest: digest(checkpoint.binding),
    mergedSha: checkpoint.mergeEvidence.mergedSha,
    verificationDigest: digest({
      patch: checkpoint.patchDigest,
      review: checkpoint.reviewDigest,
      project: project.observation.effectDigest,
      issue: closed.observation.effectDigest,
      costRelease: digest(checkpoint.costRelease)
    })
  });
  const operations = await execute({
    type: "operations-handoff",
    ordinal: ordinal++,
    bindingDigest: digest(checkpoint.binding),
    mergedSha: checkpoint.mergeEvidence.mergedSha,
    measurementPlanDigest: checkpoint.measurementPlanDigest
  });
  const currentMergeApproval = await validateLiveClosureAuthority();
  const kernel = input.services.kernel.transition({
    transitionKey: digest({
      checkpoint: input.checkpointDigest,
      event: "outcome-accepted"
    }),
    event: "outcome-accepted",
    expectedRouteId: "review.accept",
    approval: currentMergeApproval,
    evidenceDigest: digest({
      checkpoint: input.checkpointDigest,
      merge: checkpoint.mergeEvidence.evidenceDigest,
      delivery: delivered.observation.effectDigest,
      operations: operations.observation.effectDigest,
      costRelease: digest(checkpoint.costRelease)
    })
  });
  return {
    deliveryEvidenceDigest: delivered.observation.effectDigest,
    operationsReceiptDigest: operations.observation.effectDigest,
    kernelReceiptDigest: kernel.receiptDigest
  };
}

export async function resumeEngineeringAfterHumanMerge(input: {
  readonly binding: EngineeringWorkBinding;
  readonly accord: WorkAccord;
  readonly controlPolicy: ControlPolicy;
  readonly maximumEvidenceAgeMs: number;
  readonly services: {
    readonly clock: TrustedClock;
    readonly signer: EvidenceSigner;
    readonly verifier: EvidenceVerifier;
    readonly checkpoints: EngineeringClosureCheckpointStore;
    readonly humanGates: HumanGateProvider;
    readonly activationLeases: EngineeringActivationLeaseProvider;
    readonly costs: EngineeringCostLedger;
    readonly github: EngineeringGitHubAdapter;
    readonly deliveryAuthorizations: DeliveryAuthorizationProvider;
    readonly threatScanner: ThreatScanner;
    readonly kernel: EngineeringKernelPort;
  };
}): Promise<EngineeringSliceResult> {
  const bindingDigest = digest(input.binding);
  const awaiting =
    await input.services.checkpoints.readAwaitingHumanMerge(bindingDigest);
  if (
    awaiting === null ||
    awaiting.schemaVersion !== ENGINEERING_CHECKPOINT_SCHEMA_VERSION ||
    awaiting.stage !== "awaiting-human-merge" ||
    awaiting.bindingDigest !== bindingDigest ||
    digest(awaiting.binding) !== bindingDigest ||
    awaiting.workAccordDigest !== digest(input.accord) ||
    awaiting.controlPolicyDigest !== digest(input.controlPolicy) ||
    awaiting.binding.pullRequest?.headSha !== awaiting.reviewedHead ||
    awaiting.pullRequest.headSha !== awaiting.reviewedHead ||
    !input.services.verifier.verify(
      awaitingHumanMergeCheckpointPayload(awaiting),
      awaiting.signature
    )
  ) {
    fail(
      "AUTHORIZATION_INVALID",
      "awaiting-human-merge checkpoint is absent, unsigned, or inconsistent"
    );
  }
  assertDurableUntilExpiry({
    createdAt: awaiting.createdAt,
    expiresAt: awaiting.expiresAt,
    now: input.services.clock.now()
  });
  const mergeApproval = await input.services.humanGates.read(
    "approve-current-head"
  );
  if (mergeApproval === null) {
    fail("APPROVAL_INVALID", "approve-current-head approval evidence is missing");
  }
  await input.services.github.readBoundSnapshot(awaiting.binding);
  validateArtifactApproval({
    approval: mergeApproval,
    verifier: input.services.verifier,
    gate: "approve-current-head",
    artifactDigest: awaiting.reviewDigest,
    routeId: "review.accept",
    snapshotDigest: awaiting.kernelSnapshotDigest,
    workAccordDigest: awaiting.workAccordDigest,
    activationLeaseDigest: awaiting.activationLeaseDigest,
    repositoryId: awaiting.binding.repository.id,
    workItemNodeId: awaiting.binding.issue.nodeId,
    currentHead: awaiting.reviewedHead,
    requesterId: awaiting.requesterId,
    automationActorId: awaiting.automationActorId,
    controlPolicy: input.controlPolicy,
    approverPolicy: input.accord.evidence.approverPolicy,
    now: input.services.clock.now(),
    maximumAgeMs: input.maximumEvidenceAgeMs
  });
  const lastSettlement = awaiting.costSettlements.at(-1);
  const leaseNow = input.services.clock.now();
  const leaseEvidence = await input.services.activationLeases.read({
    phase: "verification",
    binding: awaiting.binding,
    reservation: awaiting.reservation,
    now: leaseNow
  });
  validateActivationLeaseEvidence({
    evidence: leaseEvidence,
    binding: awaiting.binding,
    reservation: awaiting.reservation,
    activationLeaseDigest: awaiting.activationLeaseDigest,
    workAccordDigest: awaiting.workAccordDigest,
    phase: "verification",
    capability: "core.review-current-head@1.0.0",
    projectedCalls: lastSettlement?.cumulativeCalls ?? 0,
    projectedTokens: lastSettlement?.cumulativeTokens ?? 0,
    projectedCostUnits: lastSettlement?.cumulativeCostUnits ?? 0,
    verifier: input.services.verifier,
    now: input.services.clock.now(),
    maximumAgeMs: input.maximumEvidenceAgeMs
  });
  const merge = await observeEngineeringHumanMergeInternally(
    input.services.github,
    {
    binding: awaiting.binding,
    requesterId: awaiting.requesterId,
    automationActorId: awaiting.automationActorId,
      approvedAt: mergeApproval.observedAt
    },
    input.services.clock,
    input.maximumEvidenceAgeMs
  );
  const releaseIdempotencyKey = engineeringReleaseIdempotencyKey({
    reservation: awaiting.reservation,
    settlements: awaiting.costSettlements
  });
  let releaseCheckpoint =
    await input.services.checkpoints.readCostRelease(bindingDigest);
  if (releaseCheckpoint === null) {
    const payload = {
      schemaVersion: "1.1.0",
      stage: "cost-release-pending",
      bindingDigest,
      awaitingCheckpointDigest: digest(awaiting),
      awaiting,
      mergeApproval,
      mergeEvidence: merge,
      releaseIdempotencyKey,
      costRelease: null,
      updatedAt: input.services.clock.now(),
      expiresAt: awaiting.expiresAt
    } as const;
    releaseCheckpoint = {
      ...payload,
      signature: await input.services.signer.sign(payload)
    };
    await input.services.checkpoints.putCostRelease(releaseCheckpoint);
  }
  if (
    releaseCheckpoint.schemaVersion !== ENGINEERING_CHECKPOINT_SCHEMA_VERSION ||
    releaseCheckpoint.awaiting.schemaVersion !==
      ENGINEERING_CHECKPOINT_SCHEMA_VERSION ||
    releaseCheckpoint.bindingDigest !== bindingDigest ||
    releaseCheckpoint.awaitingCheckpointDigest !== digest(awaiting) ||
    releaseCheckpoint.releaseIdempotencyKey !== releaseIdempotencyKey ||
    releaseCheckpoint.mergeApproval.gate !== "approve-current-head" ||
    releaseCheckpoint.mergeApproval.artifactDigest !== awaiting.reviewDigest ||
    releaseCheckpoint.mergeApproval.currentHead !== awaiting.reviewedHead ||
    releaseCheckpoint.mergeApproval.repositoryId !==
      awaiting.binding.repository.id ||
    releaseCheckpoint.mergeApproval.workItemNodeId !==
      awaiting.binding.issue.nodeId ||
    !input.services.verifier.verify(
      approvalPayload(releaseCheckpoint.mergeApproval),
      releaseCheckpoint.mergeApproval.signature
    ) ||
    releaseCheckpoint.mergeEvidence.evidenceDigest !== merge.evidenceDigest ||
    releaseCheckpoint.expiresAt !== awaiting.expiresAt ||
    !input.services.verifier.verify(
      costReleaseCheckpointPayload(releaseCheckpoint),
      releaseCheckpoint.signature
    )
  ) {
    fail(
      "AUTHORIZATION_INVALID",
      "cost-release checkpoint is unsigned, stale, or inconsistent"
    );
  }
  assertDurableUntilExpiry({
    createdAt: releaseCheckpoint.updatedAt,
    expiresAt: releaseCheckpoint.expiresAt,
    now: input.services.clock.now()
  });
  let costRelease = releaseCheckpoint.costRelease;
  if (costRelease === null) {
    costRelease = await input.services.costs.release({
      releaseIdempotencyKey,
      reservation: awaiting.reservation,
      settledPhases: awaiting.costSettlements,
      expectedOpenHoldDigests: awaiting.openHolds.map((hold) => digest(hold)),
      now: input.services.clock.now()
    });
    validateCostRelease({
      release: costRelease,
      reservation: awaiting.reservation,
      settlements: awaiting.costSettlements,
      knownOpenHolds: awaiting.openHolds,
      verifier: input.services.verifier,
      now: input.services.clock.now(),
      maximumAgeMs: input.maximumEvidenceAgeMs
    });
    const releasedPayload = {
      ...costReleaseCheckpointPayload(releaseCheckpoint),
      costRelease,
      updatedAt: input.services.clock.now()
    };
    releaseCheckpoint = {
      ...releasedPayload,
      signature: await input.services.signer.sign(releasedPayload)
    };
    await input.services.checkpoints.putCostRelease(releaseCheckpoint);
  } else {
    validateCostRelease({
      release: costRelease,
      reservation: awaiting.reservation,
      settlements: awaiting.costSettlements,
      knownOpenHolds: awaiting.openHolds,
      verifier: input.services.verifier,
      now: input.services.clock.now(),
      maximumAgeMs: input.maximumEvidenceAgeMs
    });
  }
  const checkpointPayload = {
    schemaVersion: "1.1.0",
    workflowId: awaiting.workflowId,
    contractRevision: awaiting.contractRevision,
    binding: awaiting.binding,
    workAccordDigest: awaiting.workAccordDigest,
    controlPolicyDigest: awaiting.controlPolicyDigest,
    activationLeaseDigest: awaiting.activationLeaseDigest,
    executionGrantDigest: awaiting.executionGrantDigest,
    reviewedHead: awaiting.reviewedHead,
    mergeEvidence: releaseCheckpoint.mergeEvidence,
    patchDigest: awaiting.patch.patchDigest,
    reviewDigest: awaiting.reviewDigest,
    reservation: awaiting.reservation,
    costSettlements: awaiting.costSettlements,
    openHolds: awaiting.openHolds,
    costSettlementDigests: awaiting.costSettlements.map((settlement) =>
      digest(settlement)
    ),
    costRelease,
    measurementPlanDigest: awaiting.measurementPlanDigest,
    nextEffectOrdinal: awaiting.nextEffectOrdinal,
    mergeApproval,
    kernelSnapshotDigest: awaiting.kernelSnapshotDigest,
    kernelReceiptDigest: awaiting.kernelReceiptDigest,
    createdAt: releaseCheckpoint.updatedAt,
    expiresAt: awaiting.expiresAt
  } as const;
  const closureCheckpoint: EngineeringClosureCheckpoint = {
    ...checkpointPayload,
    signature: await input.services.signer.sign(checkpointPayload)
  };
  const closureCheckpointDigest = digest(closureCheckpoint);
  await input.services.checkpoints.put(closureCheckpoint);
  const closure = await resumeEngineeringClosure({
    checkpointDigest: closureCheckpointDigest,
    accord: input.accord,
    controlPolicy: input.controlPolicy,
    maximumEvidenceAgeMs: input.maximumEvidenceAgeMs,
    services: {
      clock: input.services.clock,
      verifier: input.services.verifier,
      checkpoints: input.services.checkpoints,
      humanGates: input.services.humanGates,
      activationLeases: input.services.activationLeases,
      github: input.services.github,
      deliveryAuthorizations: input.services.deliveryAuthorizations,
      threatScanner: input.services.threatScanner,
      kernel: input.services.kernel
    }
  });
  return {
    binding: awaiting.binding,
    framingDigest: awaiting.framingDigest,
    planningDigest: awaiting.planningDigest,
    patch: awaiting.patch,
    pullRequest: awaiting.pullRequest,
    reviewDigest: awaiting.reviewDigest,
    mergedSha: merge.mergedSha,
    deliveryEvidenceDigest: closure.deliveryEvidenceDigest,
    operationsReceiptDigest: closure.operationsReceiptDigest,
    kernelReceiptDigest: closure.kernelReceiptDigest,
    costSettlements: awaiting.costSettlements,
    costRelease,
    closureCheckpointDigest
  };
}

function safeReviewBody(output: GitHubSafeOutput): string {
  const escape = (value: string): string =>
    value.replaceAll("<!-- agentic-framework-", "&lt;!-- agentic-framework-");
  return [
    escape(output.summary),
    ...output.findings.map(
      (finding) =>
        `- **${finding.severity.toUpperCase()} ${finding.code}:** ${escape(finding.message)}`
    ),
    `**${output.result.status}:** ${escape(output.result.details)}`
  ].join("\n");
}

export async function runEngineeringSlice(input: {
  readonly repositoryPath: string;
  readonly requesterId: string;
  readonly automationActorId: string;
  readonly controlPolicy: ControlPolicy;
  readonly accord: WorkAccord;
  readonly activationLeaseDigest: Digest;
  readonly binding: EngineeringWorkBinding;
  readonly executionGrant: BoundedExecutionGrant;
  readonly branchName: string;
  readonly pullRequestTitle: string;
  readonly pullRequestBody: string;
  readonly phaseBudgets: EngineeringCostReservation["phaseBudgets"];
  readonly phaseTokenBudgets: EngineeringCostReservation["phaseTokenBudgets"];
  readonly measurementPlanDigest: Digest;
  readonly maximumEvidenceAgeMs: number;
  readonly services: {
    readonly clock: TrustedClock;
    readonly signer: EvidenceSigner;
    readonly verifier: EvidenceVerifier;
    readonly closureCheckpoints: EngineeringClosureCheckpointStore;
    readonly humanGates: HumanGateProvider;
    readonly activationLeases: EngineeringActivationLeaseProvider;
    readonly costs: EngineeringCostLedger;
    readonly providerUsage: EngineeringProviderUsageLedger;
    readonly kernel: EngineeringKernelPort;
    readonly planner: EngineeringPlanner;
    readonly model: EngineeringModel;
    readonly executePatch: (input: {
      readonly repositoryPath: string;
      readonly accord: WorkAccord;
      readonly grant: BoundedExecutionGrant;
      readonly patch: TargetFreePatch;
      readonly clock: TrustedClock;
    }) => ValidatedPatch;
    readonly github: EngineeringGitHubAdapter;
    readonly deliveryAuthorizations: DeliveryAuthorizationProvider;
    readonly threatScanner: ThreatScanner;
  };
}): Promise<EngineeringAwaitingHumanMergeResult> {
  const now = input.services.clock.now();
  const workAccordDigest = digest(input.accord);
  const totalPhaseBudget = Object.values(input.phaseBudgets).reduce(
    (sum, value) => sum + value,
    0
  );
  const totalPhaseTokenBudget = Object.values(input.phaseTokenBudgets).reduce(
    (sum, value) => sum + value,
    0
  );
  if (
    input.binding.repository.id !== input.accord.binding.repositoryId ||
    input.binding.issue.nodeId !== input.accord.binding.workItemNodeId ||
    input.binding.requesterActorId !== input.requesterId ||
    input.binding.automationActorId !== input.automationActorId ||
    input.executionGrant.workAccordDigest !== workAccordDigest ||
    input.executionGrant.activationLeaseDigest !== input.activationLeaseDigest
  ) {
    fail("BINDING_INVALID", "slice inputs do not share one canonical work identity");
  }
  if (
    Object.values(input.phaseBudgets).some(
      (value) =>
        !Number.isSafeInteger(value) ||
        value < 0 ||
        value > input.accord.budget.maxCostUnits
    ) ||
    !Number.isSafeInteger(totalPhaseBudget) ||
    totalPhaseBudget < 0 ||
    totalPhaseBudget > input.accord.budget.maxCostUnits ||
    Object.values(input.phaseTokenBudgets).some(
      (value) => !Number.isSafeInteger(value) || value < 0
    ) ||
    !Number.isSafeInteger(totalPhaseTokenBudget) ||
    totalPhaseTokenBudget > input.accord.budget.maxTokens
  ) {
    fail("COST_INVALID", "phase budgets exceed the Work Accord cost ceiling");
  }
  const initialSnapshot = await input.services.github.readBoundSnapshot(input.binding);
  if (
    initialSnapshot.defaultBranch.ref.length === 0 ||
    !/^[0-9a-f]{40}$/u.test(initialSnapshot.defaultBranch.sha)
  ) {
    fail("BINDING_STALE", "authenticated default-branch evidence is malformed");
  }
  validateBoundedExecutionGrant({
    accord: input.accord,
    grant: input.executionGrant,
    clock: input.services.clock,
    expectedBaseSha: initialSnapshot.defaultBranch.sha
  });
  if (
    input.executionGrant.routeId !== "planning.execute" ||
    input.phaseBudgets.execution > input.executionGrant.maxCostUnits
  ) {
    fail(
      "AUTHORIZATION_INVALID",
      "execution grant route or reserved model cost is not authorized"
    );
  }
  const reservation = await input.services.costs.reserve({
    workAccordDigest,
    activationLeaseDigest: input.activationLeaseDigest,
    phaseBudgets: input.phaseBudgets,
    phaseTokenBudgets: input.phaseTokenBudgets,
    maxCalls: input.accord.budget.maxCalls,
    maxTokens: input.accord.budget.maxTokens,
    now,
    expiresAt: input.accord.budget.expiresAt
  });
  validateCostReservation({
    reservation,
    verifier: input.services.verifier,
    workAccordDigest,
    activationLeaseDigest: input.activationLeaseDigest,
    phaseBudgets: input.phaseBudgets,
    phaseTokenBudgets: input.phaseTokenBudgets,
    maxCalls: input.accord.budget.maxCalls,
    maxTokens: input.accord.budget.maxTokens,
    now,
    maximumAgeMs: input.maximumEvidenceAgeMs
  });
  const settlements: EngineeringCostSettlement[] = [];
  /** Every hold committed for this reservation, in lineage order. */
  /** Holds committed so far, used only to state this phase's sequence. */
  const costHolds: EngineeringCostHold[] = [];
  /** The caller's view of holds no settlement has discharged. */
  const openHolds: EngineeringCostHold[] = [];
  /** Holds and settlements interleaved, which is the signed chain's real order. */
  const lineage: EngineeringCostLineageEntry[] = [];
  let binding = input.binding;
  const preflightModelCall = async (
    phase: EngineeringProviderAttempt["phase"],
    expectedHead: string | null
  ): Promise<{
    readonly attempt: EngineeringProviderAttempt;
    readonly hold: EngineeringCostHold;
  }> => {
    const preflightNow = input.services.clock.now();
    const phaseBinding = {
      framing: "core.frame-artifact@1.0.0",
      execution: "core.execute-bounded-change@1.0.0",
      verification: "core.review-current-head@1.0.0"
    } as const;
    validateCostReservation({
      reservation,
      verifier: input.services.verifier,
      workAccordDigest,
      activationLeaseDigest: input.activationLeaseDigest,
      phaseBudgets: input.phaseBudgets,
      phaseTokenBudgets: input.phaseTokenBudgets,
      maxCalls: input.accord.budget.maxCalls,
      maxTokens: input.accord.budget.maxTokens,
      now: preflightNow,
      maximumAgeMs:
        timestamp(reservation.expiresAt, "reservation.expiresAt") -
        timestamp(reservation.checkedAt, "reservation.checkedAt")
    });
    const sequence = costHolds.length + 1;
    // The hold commits this phase's budget durably *before* any provider work
    // exists to spend it. Registration is the very next statement, with nothing
    // awaited in between, so the caller's view can never lag the ledger by more
    // than a synchronous step — and even that gap is harmless, because release
    // re-derives the held set from durable state rather than from these arrays.
    const hold = await input.services.costs.hold({
      reservation,
      phase,
      sequence,
      now: input.services.clock.now()
    });
    costHolds.push(hold);
    openHolds.push(hold);
    lineage.push({ kind: "hold", hold });
    validateCostHold({
      hold,
      reservation,
      verifier: input.services.verifier,
      phase,
      sequence,
      priorEntries: lineage.slice(0, -1),
      now: input.services.clock.now(),
      maximumAgeMs: input.maximumEvidenceAgeMs
    });
    const attempt = await input.services.providerUsage.begin({
      reservation,
      hold,
      phase,
      sequence,
      priorSettlements: settlements,
      now: input.services.clock.now(),
      reconciliationExpiresAt: reconciliationExpiry(reservation.expiresAt)
    });
    const snapshot = await input.services.github.readBoundSnapshot(binding);
    if (
      snapshot.defaultBranch.ref !== initialSnapshot.defaultBranch.ref ||
      snapshot.defaultBranch.sha !== initialSnapshot.defaultBranch.sha ||
      (expectedHead !== null && snapshot.pullRequest?.headSha !== expectedHead)
    ) {
      fail("CURRENT_HEAD_STALE", `${phase} model authority is not bound to the current head`);
    }
    const leaseEvidence = await input.services.activationLeases.read({
      phase,
      binding,
      reservation,
      now: input.services.clock.now()
    });
    const invocationNow = input.services.clock.now();
    validateBoundedExecutionGrant({
      accord: input.accord,
      grant: input.executionGrant,
      clock: { now: () => invocationNow },
      expectedBaseSha: initialSnapshot.defaultBranch.sha
    });
    validateProviderAttempt({
      attempt,
      reservation,
      hold,
      verifier: input.services.verifier,
      phase,
      sequence,
      priorSettlements: settlements,
      now: invocationNow,
      maximumAgeMs: input.maximumEvidenceAgeMs
    });
    validateActivationLeaseEvidence({
      evidence: leaseEvidence,
      binding,
      reservation,
      activationLeaseDigest: input.activationLeaseDigest,
      workAccordDigest,
      phase,
      capability: phaseBinding[phase],
      projectedCalls: attempt.projectedCumulativeCalls,
      projectedTokens: attempt.projectedCumulativeTokens,
      projectedCostUnits: attempt.projectedCumulativeCostUnits,
      verifier: input.services.verifier,
      now: invocationNow,
      maximumAgeMs: input.maximumEvidenceAgeMs
    });
    return { attempt, hold };
  };
  const invokeModel = async <
    T extends { readonly costUnits: number; readonly tokenUnits: number }
  >(
    phase: EngineeringProviderAttempt["phase"],
    expectedHead: string | null,
    invoke: (attempt: EngineeringProviderAttempt) => Promise<T>
  ): Promise<T> => {
    const { attempt, hold } = await preflightModelCall(phase, expectedHead);
    let result: T | null = null;
    let modelError: unknown = null;
    try {
      result = await invoke(attempt);
    } catch (error) {
      modelError = error;
    }
    const usage = await input.services.providerUsage.reconcile({
      reservation,
      attempt,
      now: input.services.clock.now()
    });
    validateProviderUsage({
      usage,
      attempt,
      verifier: input.services.verifier,
      now: input.services.clock.now(),
      maximumAgeMs: input.maximumEvidenceAgeMs
    });
    if (usage.status === "settled") {
      const actualCostUnits = usage.actualCostUnits;
      const providerUsageDigest = usage.providerUsageDigest;
      if (
        actualCostUnits === null ||
        usage.actualCalls === null ||
        usage.actualTokens === null ||
        providerUsageDigest === null
      ) {
        fail("COST_INVALID", `${phase} authoritative provider usage is incomplete`);
      }
      validateActualCost(phase, actualCostUnits, reservation);
      let settlement: EngineeringCostSettlement;
      try {
        settlement = await input.services.costs.settle({
          reservation,
          hold,
          attempt,
          usage,
          phase,
          actualCostUnits,
          actualCalls: usage.actualCalls,
          actualTokens: usage.actualTokens,
          providerUsageDigest,
          now: input.services.clock.now()
        });
      } catch {
        settlement = await input.services.costs.settle({
          reservation,
          hold,
          attempt,
          usage,
          phase,
          actualCostUnits,
          actualCalls: usage.actualCalls,
          actualTokens: usage.actualTokens,
          providerUsageDigest,
          now: input.services.clock.now()
        });
      }
      validateCostSettlement({
        settlement,
        reservation,
        hold,
        verifier: input.services.verifier,
        priorEntries: [...lineage],
        expectedPhase: phase,
        expectedAttemptDigest: digest(attempt),
        expectedActualCostUnits: actualCostUnits,
        expectedActualCalls: usage.actualCalls,
        expectedActualTokens: usage.actualTokens,
        expectedProviderUsageDigest: providerUsageDigest,
        now: input.services.clock.now(),
        maximumAgeMs: input.maximumEvidenceAgeMs
      });
      settlements.push(settlement);
      lineage.push({ kind: "settlement", settlement });
      // The settlement discharged this hold; it is no longer open. Release
      // still re-derives the open set durably, so this only keeps the caller's
      // view honest for the subset check it supplies.
      openHolds.splice(openHolds.indexOf(hold), 1);
      if (
        result !== null &&
        (result.costUnits !== actualCostUnits ||
          result.tokenUnits !== usage.actualTokens)
      ) {
        fail("COST_INVALID", `${phase} model result differs from authoritative provider usage`);
      }
    }
    if (modelError !== null) throw modelError;
    if (
      timestamp(input.services.clock.now(), "now") >=
      timestamp(attempt.expiresAt, "attempt.expiresAt")
    ) {
      fail(
        "AUTHORIZATION_INVALID",
        `${phase} output completed after invocation authority expired`
      );
    }
    if (result === null || usage.status !== "settled") {
      fail("COST_INVALID", `${phase} provider usage is unresolved`);
    }
    return result;
  };
  try {
  const intakeDigest = digest(input.binding);
  const activationApproval = await input.services.humanGates.read("activate");
  if (activationApproval === null) {
    fail("APPROVAL_INVALID", "activate approval evidence is missing");
  }
  validateArtifactApproval({
    approval: activationApproval,
    verifier: input.services.verifier,
    gate: "activate",
    artifactDigest: intakeDigest,
    routeId: "activation.begin-framing",
    snapshotDigest: intakeDigest,
    workAccordDigest,
    activationLeaseDigest: input.activationLeaseDigest,
    repositoryId: input.binding.repository.id,
    workItemNodeId: input.binding.issue.nodeId,
    currentHead: null,
    requesterId: input.requesterId,
    automationActorId: input.automationActorId,
    controlPolicy: input.controlPolicy,
    approverPolicy: input.accord.evidence.approverPolicy,
    now,
    maximumAgeMs: input.maximumEvidenceAgeMs
  });
  let kernel = input.services.kernel.transition({
    transitionKey: digest({
      binding: input.binding,
      event: "activation-approved",
      reservation: digest(reservation)
    }),
    event: "activation-approved",
    expectedRouteId: "activation.begin-framing",
    approval: activationApproval,
    evidenceDigest: digest(reservation)
  });
  const framed = await invokeModel("framing", null, (attempt) =>
    input.services.model.frame({
      issueDigest: digest(input.binding.issue),
      workAccordDigest,
      attempt
    })
  );
  const framing = validateFramingArtifact(framed.artifact);
  const framingDigest = digest(framing);
  const frameApproval = await input.services.humanGates.read("accept-frame");
  if (frameApproval === null) {
    fail("APPROVAL_INVALID", "accept-frame approval evidence is missing");
  }
  validateArtifactApproval({
    approval: frameApproval,
    verifier: input.services.verifier,
    gate: "accept-frame",
    artifactDigest: framingDigest,
    routeId: "framing.accept",
    snapshotDigest: kernel.snapshotDigest,
    workAccordDigest,
    activationLeaseDigest: input.activationLeaseDigest,
    repositoryId: input.binding.repository.id,
    workItemNodeId: input.binding.issue.nodeId,
    currentHead: null,
    requesterId: input.requesterId,
    automationActorId: input.automationActorId,
    controlPolicy: input.controlPolicy,
    approverPolicy: input.accord.evidence.approverPolicy,
    now: input.services.clock.now(),
    maximumAgeMs: input.maximumEvidenceAgeMs
  });
  kernel = input.services.kernel.transition({
    transitionKey: digest({
      event: "frame-accepted",
      approval: digest(frameApproval),
      evidence: framingDigest
    }),
    event: "frame-accepted",
    expectedRouteId: "framing.accept",
    approval: frameApproval,
    evidenceDigest: framingDigest
  });
  const planning = validatePlanningArtifact(input.services.planner.plan({
    framingDigest,
    availableTargetSlots: input.executionGrant.targets.map((target) => target.slot),
    availableVerificationIds: input.executionGrant.verificationCommandIds
  }));
  if (
    planning.targetSlots.some(
      (slot) => !input.executionGrant.targets.some((target) => target.slot === slot)
    ) ||
    planning.verificationIds.some(
      (id) => !input.executionGrant.verificationCommandIds.includes(id)
    )
  ) {
    fail("MODEL_OUTPUT_INVALID", "plan requested an unapproved logical slot or verification ID");
  }
  const planningDigest = digest(planning);
  if (
    planning.verificationIds.length === 0 ||
    input.accord.evidence.verificationCommands.some(
      (commandId) => !planning.verificationIds.includes(commandId)
    )
  ) {
    fail(
      "MODEL_OUTPUT_INVALID",
      "plan omitted a mandatory fixed verification command"
    );
  }
  const planApproval = await input.services.humanGates.read("accept-plan");
  if (planApproval === null) {
    fail("APPROVAL_INVALID", "accept-plan approval evidence is missing");
  }
  validateArtifactApproval({
    approval: planApproval,
    verifier: input.services.verifier,
    gate: "accept-plan",
    artifactDigest: planningDigest,
    routeId: "planning.execute",
    snapshotDigest: kernel.snapshotDigest,
    workAccordDigest,
    activationLeaseDigest: input.activationLeaseDigest,
    repositoryId: input.binding.repository.id,
    workItemNodeId: input.binding.issue.nodeId,
    currentHead: null,
    requesterId: input.requesterId,
    automationActorId: input.automationActorId,
    controlPolicy: input.controlPolicy,
    approverPolicy: input.accord.evidence.approverPolicy,
    now: input.services.clock.now(),
    maximumAgeMs: input.maximumEvidenceAgeMs
  });
  if (
    input.executionGrant.routeId !== "planning.execute" ||
    input.executionGrant.snapshotDigest !== kernel.snapshotDigest
  ) {
    fail(
      "AUTHORIZATION_INVALID",
      "execution grant does not bind the planning transition snapshot"
    );
  }
  kernel = input.services.kernel.transition({
    transitionKey: digest({
      event: "execution-authorized",
      approval: digest(planApproval),
      evidence: planningDigest
    }),
    event: "execution-authorized",
    expectedRouteId: "planning.execute",
    approval: planApproval,
    evidenceDigest: planningDigest
  });
  const plannedTargets = input.executionGrant.targets.filter((target) =>
    planning.targetSlots.includes(target.slot)
  );
  const narrowedExecutionGrant: BoundedExecutionGrant = {
    ...input.executionGrant,
    targets: plannedTargets,
    verificationCommandIds: planning.verificationIds,
    maxFiles: Math.min(input.executionGrant.maxFiles, plannedTargets.length)
  };
  const implemented = await invokeModel("execution", null, (attempt) =>
    input.services.model.implement({
      planningDigest,
      targetSlots: planning.targetSlots,
      attempt
    })
  );
  const patch = input.services.executePatch({
    repositoryPath: input.repositoryPath,
    accord: input.accord,
    grant: narrowedExecutionGrant,
    patch: implemented.patch,
    clock: input.services.clock
  });
  kernel = input.services.kernel.transition({
    transitionKey: digest({
      event: "work-submitted",
      evidence: patch.patchDigest
    }),
    event: "work-submitted",
    expectedRouteId: "execution.verify",
    approval: null,
    evidenceDigest: patch.patchDigest
  });
  const implementationOutputDigest = digest(implemented.patch);
  const issuedPatchBundle = await issueTrustedValidatedPatchBundle({
    patch,
    contentsBySlot: Object.fromEntries(
      implemented.patch.changes.map((change) => [change.slot, change.content])
    ),
    bindingDigest: digest(binding),
    workAccordDigest,
    executionGrantDigest: digest(narrowedExecutionGrant),
    kernelReceiptDigest: kernel.receiptDigest,
    modelOutputDigest: implementationOutputDigest,
    createdAt: input.services.clock.now(),
    expiresAt: input.accord.budget.expiresAt,
    signer: input.services.signer
  });
  const patchBundle = JSON.parse(
    canonicalJson(issuedPatchBundle)
  ) as TrustedValidatedPatchBundle;
  validateTrustedValidatedPatchBundle({
    bundle: patchBundle,
    verifier: input.services.verifier,
    bindingDigest: digest(binding),
    workAccordDigest,
    executionGrantDigest: digest(narrowedExecutionGrant),
    kernelReceiptDigest: kernel.receiptDigest,
    modelOutputDigest: implementationOutputDigest,
    now: input.services.clock.now()
  });
  let ordinal = 1;
  const workflowId = "engineering-thin-slice";
  const contractRevision = input.accord.identity.revision;
  const executeEffect = async (
    effect: EngineeringDeliveryEffect,
    modelOutputDigest: Digest,
    commitPatchBundle?: TrustedValidatedPatchBundle
  ): Promise<EngineeringEffectExecutionResult> => {
    const nowAtEffect = input.services.clock.now();
    const authorization = await input.services.deliveryAuthorizations.issue({
      workflowId,
      contractRevision,
      effect,
      binding,
      workAccordDigest,
      activationLeaseDigest: input.activationLeaseDigest,
      executionGrantDigest: patchBundle.executionGrantDigest,
      kernelReceiptDigest: kernel.receiptDigest,
      now: nowAtEffect
    });
    const threatEvidence = await input.services.threatScanner.scan({
      authorizationDigest: authorization.authorizationDigest,
      modelOutputDigest,
      kernelReceiptDigest: kernel.receiptDigest,
      now: nowAtEffect
    });
    return executeEngineeringEffectInternally(input.services.github, {
      workflowId,
      contractRevision,
      effect,
      binding,
      workAccordDigest,
      activationLeaseDigest: input.activationLeaseDigest,
      executionGrantDigest: patchBundle.executionGrantDigest,
      kernelReceiptDigest: kernel.receiptDigest,
      authorization,
      threatEvidence,
      modelOutputDigest,
      ...(commitPatchBundle === undefined
        ? {}
        : { patchBundle: commitPatchBundle })
    }, input.services.clock, input.maximumEvidenceAgeMs);
  };
  const branchEffect: EngineeringDeliveryEffect = {
    type: "create-branch",
    ordinal: ordinal++,
    repositoryId: binding.repository.id,
    issueNodeId: binding.issue.nodeId,
    baseRef: initialSnapshot.defaultBranch.ref,
    baseSha: initialSnapshot.defaultBranch.sha,
    headRef: input.branchName
  };
  const branch = await executeEffect(branchEffect, patch.patchDigest);
  const branchSha = branch.observation.snapshot.branches[input.branchName];
  if (branchSha === undefined) {
    fail("PARTIAL_EFFECT", "created branch was not observed");
  }
  const commitEffect: EngineeringDeliveryEffect = {
    type: "create-commit",
    ordinal: ordinal++,
    repositoryId: binding.repository.id,
    issueNodeId: binding.issue.nodeId,
    headRef: input.branchName,
    parentSha: branchSha,
    patchDigest: patch.patchDigest,
    treeDigest: patch.treeDigest,
    gitTreeSha: patch.gitTreeSha,
    patchBundleDigest: digest(patchBundle)
  };
  const commit = await executeEffect(
    commitEffect,
    implementationOutputDigest,
    patchBundle
  );
  if (commit.observation.type !== "create-commit") {
    fail("PARTIAL_EFFECT", "created commit observation is mistyped");
  }
  const headSha = commit.observation.commitSha;
  const draftEffect: EngineeringDeliveryEffect = {
    type: "create-draft-pull-request",
    ordinal: ordinal++,
    repositoryId: binding.repository.id,
    issueNodeId: binding.issue.nodeId,
    projectItemNodeId: binding.project.itemNodeId,
    baseRepositoryId: binding.repository.id,
    baseRef: initialSnapshot.defaultBranch.ref,
    baseSha: initialSnapshot.defaultBranch.sha,
    headRepositoryId: binding.repository.id,
    headRef: input.branchName,
    headSha,
    title: input.pullRequestTitle,
    body: input.pullRequestBody,
    draft: true
  };
  const drafted = await executeEffect(draftEffect, patch.patchDigest);
  if (drafted.observation.type !== "create-draft-pull-request") {
    fail("PARTIAL_EFFECT", "draft pull request was not observed");
  }
  const pull = drafted.observation.pullRequest;
  const pullBinding: EngineeringPullRequestBinding = {
    number: pull.number,
    nodeId: pull.nodeId,
    baseRepositoryId: pull.baseRepositoryId,
    baseRef: pull.baseRef,
    baseSha: pull.baseSha,
    headRepositoryId: pull.headRepositoryId,
    headRef: pull.headRef,
    headSha: pull.headSha
  };
  const bindEffect: EngineeringDeliveryEffect = {
    type: "bind-pull-request",
    ordinal: ordinal++,
    expectedBindingDigest: digest(binding),
    pullRequest: pullBinding,
    receiptHead: binding.receiptHead
  };
  const rebound = await executeEffect(bindEffect, patch.patchDigest);
  binding = rebindEngineeringPullRequest({
    binding,
    expectedBindingDigest: bindEffect.expectedBindingDigest,
    pullRequest: pullBinding,
    receiptHead: rebound.evidence.effectDigest ?? rebound.observation.effectDigest
  });
  const reviewed = await invokeModel("verification", headSha, (attempt) =>
    input.services.model.review({
      patchDigest: patch.patchDigest,
      headSha,
      attempt
    })
  );
  const reviewOutput = assertDocument("GitHubSafeOutput", reviewed.output);
  const reviewDigest = digest(reviewOutput);
  const reviewEffect: EngineeringDeliveryEffect = {
    type: "comment-review",
    ordinal: ordinal++,
    repositoryId: binding.repository.id,
    pullRequestNumber: pullBinding.number,
    pullRequestNodeId: pullBinding.nodeId,
    headSha,
    event: "COMMENT",
    body: safeReviewBody(reviewOutput)
  };
  const reviewComment = await executeEffect(reviewEffect, reviewDigest);
  if (reviewComment.observation.effectDigest.length === 0) {
    fail("PARTIAL_EFFECT", "comment review was not observed after write");
  }
  if (reviewOutput.result.status !== "success") {
    fail("KERNEL_REFUSED", "verification review did not return exact success");
  }
  kernel = input.services.kernel.transition({
    transitionKey: digest({
      event: "verification-passed",
      evidence: reviewDigest,
      head: headSha
    }),
    event: "verification-passed",
    expectedRouteId: "verification.request-review",
    approval: null,
    evidenceDigest: reviewDigest
  });
  const awaitingPayload = {
    schemaVersion: "1.1.0",
    stage: "awaiting-human-merge",
    workflowId,
    contractRevision,
    bindingDigest: digest(binding),
    binding,
    workAccordDigest,
    controlPolicyDigest: digest(input.controlPolicy),
    activationLeaseDigest: input.activationLeaseDigest,
    executionGrantDigest: patchBundle.executionGrantDigest,
    requesterId: input.requesterId,
    automationActorId: input.automationActorId,
    framingDigest,
    planningDigest,
    patch,
    pullRequest: pullBinding,
    reviewedHead: headSha,
    reviewDigest,
    reservation,
    costSettlements: settlements,
    openHolds,
    measurementPlanDigest: input.measurementPlanDigest,
    nextEffectOrdinal: ordinal,
    kernelSnapshotDigest: kernel.snapshotDigest,
    kernelReceiptDigest: kernel.receiptDigest,
    createdAt: input.services.clock.now(),
    expiresAt: input.accord.budget.expiresAt
  } as const;
  const awaitingCheckpoint: EngineeringAwaitingHumanMergeCheckpoint = {
    ...awaitingPayload,
    signature: await input.services.signer.sign(awaitingPayload)
  };
  await input.services.closureCheckpoints.putAwaitingHumanMerge(
    awaitingCheckpoint
  );
  return {
    status: "awaiting-human-merge",
    binding,
    pullRequest: pullBinding,
    reviewedHead: headSha,
    reviewDigest,
    costSettlements: settlements,
    checkpointDigest: digest(awaitingCheckpoint)
  };
  } catch (error) {
    try {
      const releaseIdempotencyKey = engineeringReleaseIdempotencyKey({
        reservation,
        settlements
      });
      const release = await input.services.costs.release({
        releaseIdempotencyKey,
        reservation,
        settledPhases: settlements,
        expectedOpenHoldDigests: openHolds.map((hold) => digest(hold)),
        now: input.services.clock.now()
      });
      validateCostRelease({
        release,
        reservation,
        settlements,
        knownOpenHolds: openHolds,
        verifier: input.services.verifier,
        now: input.services.clock.now(),
        maximumAgeMs: input.maximumEvidenceAgeMs
      });
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        "engineering slice failed and cost reservation release also failed"
      );
    }
    throw error;
  }
}
