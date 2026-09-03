import { canonicalJson, digest } from "./canonical.js";
import type { GitHubAppCredentialBroker } from "./github-auth.js";
import type {
  GitHubBindingReadApi,
  GitHubPullRequestIdentity,
  TrustedGitHubBinding
} from "./github-events.js";
import type {
  GitHubEffectPlan,
  GitHubProjectFieldValue
} from "./github-types.js";
import type { Digest } from "./types.js";
import { assertDocument, validateDocument } from "./validation.js";

export interface GitHubExecutionState {
  readonly binding: TrustedGitHubBinding;
  readonly contractDigest: Digest;
  readonly receiptHead: Digest | null;
  readonly projectSchemaDigest: Digest;
}

export interface GitHubEvidenceError {
  readonly code:
    | GitHubApiError["code"]
    | "READ_AFTER_WRITE_FAILED"
    | "UNOBSERVED_WRITE";
  readonly status: number | null;
  readonly retryable: boolean;
  readonly outcomeAmbiguous: boolean;
}

export interface GitHubEvidenceIdentity {
  readonly applicationId: number;
  readonly authorId: number;
}

export interface GitHubEvidenceState {
  readonly schemaVersion: "v1alpha1";
  readonly sequence: number;
  readonly priorSequence: number | null;
  readonly priorEvidenceDigest: Digest | null;
  readonly bindingDigest: Digest;
  readonly idempotencyKey: Digest;
  readonly planDigest: Digest;
  readonly claimantId: Digest;
  readonly operationDigest: Digest;
  readonly state: "pending" | "retryable" | "completed" | "partial";
  readonly effectDigest: Digest | null;
  readonly writeAttempts: number;
  readonly retryAfterMs: number | null;
  readonly retryNotBefore: string | null;
  readonly lastError: GitHubEvidenceError | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface GitHubEvidenceSignature {
  readonly algorithm: string;
  readonly keyId: string;
  readonly value: string;
}

export interface GitHubSignedEvidence {
  readonly evidence: GitHubEvidenceState;
  readonly signature: GitHubEvidenceSignature;
}

export interface GitHubEvidenceRecord extends GitHubSignedEvidence {
  readonly nodeId: string;
  readonly applicationId: number;
  readonly authorId: number;
}

export interface GitHubEvidenceHead {
  readonly nodeId: string;
  readonly sequence: number;
  readonly evidenceDigest: Digest;
}

export interface GitHubEvidenceSnapshot {
  readonly records: readonly unknown[];
  readonly head: unknown | null;
}

export interface GitHubEvidenceSigner {
  signEvidence(input: {
    readonly identity: GitHubEvidenceIdentity;
    readonly evidence: GitHubEvidenceState;
  }): Promise<GitHubEvidenceSignature>;
}

export interface GitHubEvidenceVerifier {
  verifyEvidence(input: {
    readonly identity: GitHubEvidenceIdentity;
    readonly evidence: GitHubEvidenceState;
    readonly signature: GitHubEvidenceSignature;
  }): Promise<boolean>;
}

export interface GitHubEvidenceStore {
  readonly supportsAuthenticatedConditionalAppend: true;
  readEvidence(
    api: GitHubApi,
    binding: TrustedGitHubBinding,
    idempotencyKey: Digest
  ): Promise<GitHubEvidenceSnapshot>;
  conditionalAppendEvidence(
    api: GitHubApi,
    binding: TrustedGitHubBinding,
    expectedHead: GitHubEvidenceHead | null,
    evidence: GitHubSignedEvidence
  ): Promise<unknown>;
}

export interface GitHubEvidenceServices {
  readonly identity: GitHubEvidenceIdentity;
  readonly signer: GitHubEvidenceSigner;
  readonly verifier: GitHubEvidenceVerifier;
  readonly store: GitHubEvidenceStore;
}

export class GitHubEvidenceConflictError extends Error {
  constructor(
    readonly actualHead: GitHubEvidenceHead | null = null,
    message = "authenticated evidence head changed"
  ) {
    super(message);
    this.name = "GitHubEvidenceConflictError";
  }
}

export interface GitHubEffectObservation {
  readonly nodeId: string;
  readonly effectDigest: Digest;
}

export interface GitHubActorAuthorizationSnapshot {
  readonly actorId: number;
  readonly actorNodeId: string;
  readonly login: string;
  readonly bot: boolean;
  readonly repositoryPermission:
    | "admin"
    | "maintain"
    | "push"
    | "triage"
    | "pull"
    | "none";
  readonly organizationRole: "admin" | "direct_member" | "unaffiliated";
  readonly teamNodeIds: readonly string[];
  readonly reviewCommitId: string | null;
}

export interface GitHubApi extends GitHubBindingReadApi {
  readExecutionState(
    binding: TrustedGitHubBinding
  ): Promise<GitHubExecutionState>;
  applyEffect(
    binding: TrustedGitHubBinding,
    plan: GitHubEffectPlan,
    precondition: GitHubEffectPrecondition
  ): Promise<GitHubEffectObservation>;
  observeEffect(
    binding: TrustedGitHubBinding,
    plan: GitHubEffectPlan
  ): Promise<GitHubEffectObservation | null>;
  getProjectFieldValue(input: {
    readonly projectNodeId: string;
    readonly itemNodeId: string;
    readonly fieldNodeId: string;
  }): Promise<GitHubProjectFieldValue | null>;
  getActorAuthorization(input: {
    readonly repositoryId: number;
    readonly actorId: number;
    readonly pullRequestNumber: number | null;
  }): Promise<GitHubActorAuthorizationSnapshot>;
}

export interface GitHubEffectPrecondition {
  readonly bindingDigest: Digest;
  readonly planDigest: Digest;
  readonly effectDigest: Digest;
  readonly executionStateDigest: Digest;
  readonly expectedHeadSha: string | null;
}

export class GitHubApiError extends Error {
  constructor(
    readonly code:
      | "FORBIDDEN"
      | "NOT_FOUND"
      | "GONE"
      | "VALIDATION_FAILED"
      | "RATE_LIMITED"
      | "SERVER_ERROR"
      | "TIMEOUT"
      | "GRAPHQL_ERROR"
      | "RESPONSE_INVALID",
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
    readonly outcomeAmbiguous: boolean,
    readonly retryAfterMs: number | null = null
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

export class GitHubExecutionError extends Error {
  constructor(
    readonly code:
      | "BINDING_STALE"
      | "CONTRACT_STALE"
      | "RECEIPT_STALE"
      | "PROJECT_SCHEMA_STALE"
      | "CURRENT_HEAD_STALE"
      | "CONCURRENCY_CONFLICT"
      | "REPLAY_CONFLICT"
      | "PARTIAL_EFFECT"
      | "READ_AFTER_WRITE_FAILED"
      | "CLAIM_RECONCILIATION_REQUIRED"
      | "RETRY_NOT_BEFORE"
      | "EXTERNAL_RETRY_WINDOW"
      | "RETRY_STATE_INVALID"
      | "EVIDENCE_INVALID"
      | "EVIDENCE_AUTHENTICATION_REQUIRED"
      | "EVIDENCE_SIGNATURE_INVALID"
      | "EVIDENCE_CHAIN_INVALID"
      | "RETRYABLE_WRITE_FAILURE"
      | "RETRY_EXHAUSTED"
      | "ACTOR_UNAUTHORIZED",
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs: number | null = null
  ) {
    super(message);
    this.name = "GitHubExecutionError";
  }
}

export interface GitHubRetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maximumDelayMs: number;
}

export interface ActorAuthorizationInput {
  readonly repositoryId: number;
  readonly actorId: number;
  readonly actorNodeId: string;
  readonly requiredRepositoryPermissions: readonly (
    | "admin"
    | "maintain"
    | "push"
    | "triage"
    | "pull"
  )[];
  readonly requiredOrganizationRole:
    | "admin"
    | "direct_member"
    | null;
  readonly requiredTeamNodeIds: readonly string[];
  readonly requesterActorId: number | null;
  readonly requireHuman: boolean;
  readonly requireIndependent: boolean;
  readonly pullRequestNumber: number | null;
  readonly expectedReviewCommitId: string | null;
}

export async function authorizeGitHubActor(
  api: GitHubApi,
  input: ActorAuthorizationInput
): Promise<GitHubActorAuthorizationSnapshot> {
  const snapshot = await api.getActorAuthorization({
    repositoryId: input.repositoryId,
    actorId: input.actorId,
    pullRequestNumber: input.pullRequestNumber
  });
  const authorized =
    snapshot.actorId === input.actorId &&
    snapshot.actorNodeId === input.actorNodeId &&
    (!input.requireHuman || !snapshot.bot) &&
    (!input.requireIndependent ||
      (input.requesterActorId !== null &&
        snapshot.actorId !== input.requesterActorId)) &&
    snapshot.repositoryPermission !== "none" &&
    input.requiredRepositoryPermissions.includes(snapshot.repositoryPermission) &&
    (input.requiredOrganizationRole === null ||
      snapshot.organizationRole === input.requiredOrganizationRole) &&
    input.requiredTeamNodeIds.every((team) =>
      snapshot.teamNodeIds.includes(team)
    ) &&
    (input.expectedReviewCommitId === null ||
      snapshot.reviewCommitId === input.expectedReviewCommitId);
  if (!authorized) {
    throw new GitHubExecutionError(
      "ACTOR_UNAUTHORIZED",
      "fresh GitHub actor authorization does not satisfy policy",
      false
    );
  }
  return snapshot;
}

function sameProjectValue(
  left: GitHubProjectFieldValue | null,
  right: GitHubProjectFieldValue | null
): boolean {
  return digest(left) === digest(right);
}

function projectValueMatchesField(
  value: GitHubProjectFieldValue | null,
  field: TrustedGitHubBinding["project"]["fields"][number]
): boolean {
  if (value === null) return true;
  switch (field.dataType) {
    case "SINGLE_SELECT":
      return (
        value.kind === "single-select" &&
        field.options.some((option) => option.nodeId === value.optionNodeId)
      );
    case "TEXT":
      return value.kind === "text";
    case "NUMBER":
      return value.kind === "number";
    case "DATE":
    case "ITERATION":
      return false;
  }
}

function samePullRequest(
  expected: Extract<
    TrustedGitHubBinding["workItem"],
    { readonly kind: "pull-request" }
  >,
  actual: GitHubPullRequestIdentity
): boolean {
  return (
    expected.number === actual.number &&
    expected.nodeId === actual.nodeId &&
    sameRepositoryIdentity(
      expected.base.repository,
      actual.base.repository
    ) &&
    expected.base.ref === actual.base.ref &&
    expected.base.sha === actual.base.sha &&
    sameRepositoryIdentity(
      expected.head.repository,
      actual.head.repository
    ) &&
    expected.head.ref === actual.head.ref &&
    expected.head.sha === actual.head.sha
  );
}

function sameBindingExceptPullRequestHeads(
  expected: TrustedGitHubBinding,
  actual: TrustedGitHubBinding
): boolean {
  if (
    expected.workItem.kind !== "pull-request" ||
    actual.workItem.kind !== "pull-request"
  ) {
    return false;
  }
  const normalized = (binding: TrustedGitHubBinding) => {
    const workItem = binding.workItem;
    if (workItem.kind !== "pull-request") return binding;
    return {
      ...binding,
      workItem: {
        ...workItem,
        base: { ...workItem.base, sha: "<current-base-sha>" },
        head: { ...workItem.head, sha: "<current-head-sha>" }
      }
    };
  };
  return digest(normalized(expected)) === digest(normalized(actual));
}

function sameRepositoryIdentity(
  left: TrustedGitHubBinding["repository"],
  right: TrustedGitHubBinding["repository"]
): boolean {
  return (
    left.id === right.id &&
    left.nodeId === right.nodeId &&
    left.owner === right.owner &&
    left.name === right.name &&
    left.fullName === right.fullName
  );
}

function assertEffectTargets(
  plan: GitHubEffectPlan,
  binding: TrustedGitHubBinding
): void {
  if (
    plan.bindingDigest !== digest(binding) ||
    plan.expected.projectSchemaDigest !== binding.project.schemaDigest
  ) {
    throw new GitHubExecutionError(
      "BINDING_STALE",
      "effect plan authority does not match Trusted Binding",
      false
    );
  }
  switch (plan.effect.type) {
    case "issue-comment":
      if (
        !sameRepositoryIdentity(plan.effect.repository, binding.repository) ||
        plan.effect.workItem.kind !== binding.workItem.kind ||
        plan.effect.workItem.number !== binding.workItem.number ||
        plan.effect.workItem.nodeId !== binding.workItem.nodeId
      ) {
        throw new GitHubExecutionError(
          "BINDING_STALE",
          "issue-comment target does not match Trusted Binding",
          false
        );
      }
      return;
    case "check-run":
      if (
        binding.workItem.kind !== "pull-request" ||
        !sameRepositoryIdentity(plan.effect.repository, binding.repository) ||
        !samePullRequest(binding.workItem, plan.effect.pullRequest) ||
        plan.effect.headSha !== binding.workItem.head.sha
      ) {
        throw new GitHubExecutionError(
          "BINDING_STALE",
          "check-run target does not match Trusted Binding",
          false
        );
      }
      return;
    case "pull-request-review-comment":
      if (
        binding.workItem.kind !== "pull-request" ||
        !sameRepositoryIdentity(plan.effect.repository, binding.repository) ||
        !samePullRequest(binding.workItem, plan.effect.pullRequest) ||
        plan.effect.headSha !== binding.workItem.head.sha ||
        plan.effect.event !== "COMMENT"
      ) {
        throw new GitHubExecutionError(
          "BINDING_STALE",
          "pull-request review comment target does not match Trusted Binding",
          false
        );
      }
      return;
    case "project-field-update": {
      const projectEffect = plan.effect;
      if (
        projectEffect.projectOwnerNodeId !== binding.project.ownerNodeId ||
        projectEffect.projectNodeId !== binding.project.projectNodeId ||
        projectEffect.itemNodeId !== binding.project.itemNodeId ||
        projectEffect.projectBindingDigest !== binding.project.bindingDigest
      ) {
        throw new GitHubExecutionError(
          "BINDING_STALE",
          "Project target does not match Trusted Binding",
          false
        );
      }
      const field = binding.project.fields.find(
        (candidate) => candidate.key === projectEffect.fieldKey
      );
      if (
        field === undefined ||
        field.nodeId !== projectEffect.fieldNodeId ||
        field.dataType !== projectEffect.fieldDataType
      ) {
        throw new GitHubExecutionError(
          "BINDING_STALE",
          "Project field does not match Trusted Binding",
          false
        );
      }
      if (
        !projectValueMatchesField(projectEffect.expectedCurrentValue, field) ||
        !projectValueMatchesField(projectEffect.value, field)
      ) {
        throw new GitHubExecutionError(
          "BINDING_STALE",
          "Project value does not match the bound field type and options",
          false
        );
      }
      return;
    }
  }
}

function assertFreshState(
  plan: GitHubEffectPlan,
  expectedBinding: TrustedGitHubBinding,
  state: GitHubExecutionState
): void {
  const expectedBindingDigest = digest(expectedBinding);
  if (plan.bindingDigest !== expectedBindingDigest) {
    throw new GitHubExecutionError(
      "BINDING_STALE",
      "effect plan no longer matches Trusted Binding",
      false
    );
  }
  if (digest(state.binding) !== expectedBindingDigest) {
    if (sameBindingExceptPullRequestHeads(expectedBinding, state.binding)) {
      throw new GitHubExecutionError(
        "CURRENT_HEAD_STALE",
        "pull request base or head changed before the effect",
        false
      );
    }
    throw new GitHubExecutionError(
      "BINDING_STALE",
      "fresh GitHub identities no longer match Trusted Binding",
      false
    );
  }
  assertEffectTargets(plan, state.binding);
  if (state.contractDigest !== plan.expected.contractDigest) {
    throw new GitHubExecutionError(
      "CONTRACT_STALE",
      "Work Accord changed before the effect",
      false
    );
  }
  if (state.receiptHead !== plan.expected.receiptHead) {
    throw new GitHubExecutionError(
      "RECEIPT_STALE",
      "receipt head changed before the effect",
      false
    );
  }
  if (state.projectSchemaDigest !== plan.expected.projectSchemaDigest) {
    throw new GitHubExecutionError(
      "PROJECT_SCHEMA_STALE",
      "Project schema changed before the effect",
      false
    );
  }
  if (expectedBinding.workItem.kind === "pull-request") {
    const current = state.binding.workItem;
    if (
      current.kind !== "pull-request" ||
      !samePullRequest(expectedBinding.workItem, current) ||
      current.base.sha !== plan.expected.baseSha ||
      current.head.sha !== plan.expected.headSha
    ) {
      throw new GitHubExecutionError(
        "CURRENT_HEAD_STALE",
        "pull request base or head changed before the effect",
        false
      );
    }
  } else if (
    plan.expected.baseSha !== null ||
    plan.expected.headSha !== null
  ) {
    throw new GitHubExecutionError(
      "CURRENT_HEAD_STALE",
      "issue-bound plans cannot carry pull request heads",
      false
    );
  }
}

function signedEvidenceDigest(
  identity: GitHubEvidenceIdentity,
  record: GitHubSignedEvidence
): Digest {
  return digest({
    identity,
    evidence: record.evidence,
    signature: record.signature
  });
}

function evidenceDigest(record: GitHubEvidenceRecord): Digest {
  return signedEvidenceDigest(
    {
      applicationId: record.applicationId,
      authorId: record.authorId
    },
    record
  );
}

function evidenceHead(record: GitHubEvidenceRecord): GitHubEvidenceHead {
  return {
    nodeId: record.nodeId,
    sequence: record.evidence.sequence,
    evidenceDigest: evidenceDigest(record)
  };
}

function sameEvidenceHead(
  left: GitHubEvidenceHead | null,
  right: GitHubEvidenceHead | null
): boolean {
  return digest(left) === digest(right);
}

function parseEvidenceHead(value: unknown): GitHubEvidenceHead {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) => !["nodeId", "sequence", "evidenceDigest"].includes(key)
    )
  ) {
    throw new GitHubExecutionError(
      "EVIDENCE_CHAIN_INVALID",
      "authenticated evidence head is malformed",
      false
    );
  }
  const head = value as Readonly<Record<string, unknown>>;
  if (
    typeof head.nodeId !== "string" ||
    head.nodeId.length === 0 ||
    !Number.isSafeInteger(head.sequence) ||
    Number(head.sequence) < 1 ||
    typeof head.evidenceDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(head.evidenceDigest)
  ) {
    throw new GitHubExecutionError(
      "EVIDENCE_CHAIN_INVALID",
      "authenticated evidence head is malformed",
      false
    );
  }
  return {
    nodeId: head.nodeId,
    sequence: Number(head.sequence),
    evidenceDigest: head.evidenceDigest as Digest
  };
}

function assertEvidenceTransition(
  previous: GitHubEvidenceState,
  current: GitHubEvidenceState
): void {
  const immutable =
    current.schemaVersion === previous.schemaVersion &&
    current.bindingDigest === previous.bindingDigest &&
    current.idempotencyKey === previous.idempotencyKey &&
    current.planDigest === previous.planDigest &&
    current.claimantId === previous.claimantId &&
    current.operationDigest === previous.operationDigest &&
    current.createdAt === previous.createdAt;
  const linked =
    current.sequence === previous.sequence + 1 &&
    current.priorSequence === previous.sequence;
  const priorTerminal =
    previous.state === "completed" || previous.state === "partial";
  let stateTransition = false;
  if (!priorTerminal) {
    switch (current.state) {
      case "pending":
        stateTransition =
          current.writeAttempts === previous.writeAttempts + 1;
        break;
      case "retryable":
        stateTransition =
          previous.state === "pending" &&
          current.writeAttempts === previous.writeAttempts;
        break;
      case "completed":
        stateTransition =
          current.writeAttempts ===
          Math.max(1, previous.writeAttempts);
        break;
      case "partial":
        stateTransition =
          current.writeAttempts === previous.writeAttempts;
        break;
    }
  }
  if (!immutable || !linked || !stateTransition) {
    throw new GitHubExecutionError(
      "EVIDENCE_CHAIN_INVALID",
      "authenticated evidence chain contains an invalid state transition",
      false
    );
  }
}

async function validateEvidence(
  snapshot: GitHubEvidenceSnapshot,
  plan: GitHubEffectPlan,
  services: GitHubEvidenceServices
): Promise<GitHubEvidenceRecord | null> {
  if (!Array.isArray(snapshot.records)) {
    throw new GitHubExecutionError(
      "EVIDENCE_CHAIN_INVALID",
      "authenticated evidence snapshot records are malformed",
      false
    );
  }
  const records: GitHubEvidenceRecord[] = [];
  const seenNodeIds = new Set<string>();
  const seenDigests = new Set<Digest>();
  for (const value of snapshot.records) {
    const result = validateDocument("GitHubEffectEvidence", value);
    if (!result.valid) {
      throw new GitHubExecutionError(
        "EVIDENCE_INVALID",
        `persisted GitHub evidence is invalid: ${result.errors.join("; ")}`,
        false
      );
    }
    const record = result.value;
    const state = record.evidence;
    if (
      record.applicationId !== services.identity.applicationId ||
      record.authorId !== services.identity.authorId
    ) {
      throw new GitHubExecutionError(
        "EVIDENCE_SIGNATURE_INVALID",
        "persisted GitHub evidence has the wrong App or author identity",
        false
      );
    }
    let verified = false;
    try {
      verified = await services.verifier.verifyEvidence({
        identity: services.identity,
        evidence: state,
        signature: record.signature
      });
    } catch {
      verified = false;
    }
    if (!verified) {
      throw new GitHubExecutionError(
        "EVIDENCE_SIGNATURE_INVALID",
        "persisted GitHub evidence signature is invalid",
        false
      );
    }
    if (
      state.bindingDigest !== plan.bindingDigest ||
      state.idempotencyKey !== plan.idempotencyKey ||
      state.operationDigest !==
        digest({
          claimantId: state.claimantId,
          planDigest: state.planDigest
        }) ||
      new Date(state.createdAt).getTime() >
        new Date(state.updatedAt).getTime()
    ) {
      throw new GitHubExecutionError(
        "EVIDENCE_INVALID",
        "persisted GitHub evidence has inconsistent identities or timestamps",
        false
      );
    }
    if (state.planDigest !== digest(plan)) {
      throw new GitHubExecutionError(
        "REPLAY_CONFLICT",
        "idempotency key is already bound to a different effect plan",
        false
      );
    }
    if (state.state === "retryable") {
      const updatedAt = new Date(state.updatedAt).getTime();
      const expectedNotBefore = updatedAt + (state.retryAfterMs ?? 0);
      if (
        !Number.isSafeInteger(expectedNotBefore) ||
        state.retryNotBefore !== new Date(expectedNotBefore).toISOString()
      ) {
        throw new GitHubExecutionError(
          "EVIDENCE_INVALID",
          "retryable evidence deadline does not match its signed delay",
          false
        );
      }
    }
    const currentDigest = evidenceDigest(record);
    if (
      seenNodeIds.has(record.nodeId) ||
      seenDigests.has(currentDigest)
    ) {
      throw new GitHubExecutionError(
        "EVIDENCE_CHAIN_INVALID",
        "authenticated evidence chain contains duplicate records",
        false
      );
    }
    const previous = records.at(-1);
    if (previous === undefined) {
      if (
        state.sequence !== 1 ||
        state.priorSequence !== null ||
        state.priorEvidenceDigest !== null ||
        state.state !== "pending" ||
        state.writeAttempts !== 0
      ) {
        throw new GitHubExecutionError(
          "EVIDENCE_CHAIN_INVALID",
          "authenticated evidence chain has an invalid initial record",
          false
        );
      }
    } else {
      if (state.priorEvidenceDigest !== evidenceDigest(previous)) {
        throw new GitHubExecutionError(
          "EVIDENCE_CHAIN_INVALID",
          "authenticated evidence chain link is invalid",
          false
        );
      }
      assertEvidenceTransition(previous.evidence, state);
    }
    seenNodeIds.add(record.nodeId);
    seenDigests.add(currentDigest);
    records.push(record);
  }
  const latest = records.at(-1) ?? null;
  const authoritativeHead =
    snapshot.head === null ? null : parseEvidenceHead(snapshot.head);
  const computedHead = latest === null ? null : evidenceHead(latest);
  if (!sameEvidenceHead(authoritativeHead, computedHead)) {
    throw new GitHubExecutionError(
      "EVIDENCE_CHAIN_INVALID",
      "authenticated evidence chain does not match its authoritative head",
      false
    );
  }
  return latest;
}

async function boundedRead<T>(
  operation: () => Promise<T>,
  policy: GitHubRetryPolicy,
  sleep: (milliseconds: number) => Promise<void>
): Promise<T> {
  if (
    !Number.isSafeInteger(policy.maxAttempts) ||
    policy.maxAttempts < 1 ||
    policy.maxAttempts > 16 ||
    !Number.isSafeInteger(policy.baseDelayMs) ||
    policy.baseDelayMs < 0 ||
    !Number.isSafeInteger(policy.maximumDelayMs) ||
    policy.maximumDelayMs < policy.baseDelayMs
  ) {
    throw new TypeError("retry policy is outside bounded kernel limits");
  }
  let attempt = 0;
  while (attempt < policy.maxAttempts) {
    attempt += 1;
    try {
      return await operation();
    } catch (error) {
      if (
        !(error instanceof GitHubApiError) ||
        !error.retryable ||
        attempt >= policy.maxAttempts
      ) {
        throw error;
      }
      const delay = Math.min(
        policy.maximumDelayMs,
        policy.baseDelayMs * 2 ** (attempt - 1)
      );
      await sleep(delay);
    }
  }
  throw new TypeError("unreachable retry state");
}

export type GitHubExecutionResult =
  | {
      readonly kind: "applied";
      readonly evidenceNodeId: string;
      readonly effectNodeId: string;
      readonly effectDigest: Digest;
    }
  | {
      readonly kind: "replayed";
      readonly evidenceNodeId: string;
      readonly effectDigest: Digest;
    }
  | {
      readonly kind: "reconciled";
      readonly evidenceNodeId: string;
      readonly effectNodeId: string;
      readonly effectDigest: Digest;
    };

type GitHubEvidenceResolution =
  | {
      readonly kind: "claim";
      readonly claim: GitHubEvidenceRecord;
    }
  | {
      readonly kind: "result";
      readonly result: GitHubExecutionResult;
    };

export class GitHubSingleWriter {
  readonly #localRetryNotBefore = new Map<
    string,
    { readonly notBefore: number; readonly external: boolean }
  >();

  constructor(
    private readonly credentials: GitHubAppCredentialBroker,
    private readonly retryPolicy: GitHubRetryPolicy,
    private readonly sleep: (milliseconds: number) => Promise<void> = (
      milliseconds
    ) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    private readonly now: () => Date = () => new Date(),
    private readonly evidenceServices?: GitHubEvidenceServices
  ) {}

  execute(
    binding: TrustedGitHubBinding,
    rawPlan: GitHubEffectPlan,
    claimantId: Digest
  ): Promise<GitHubExecutionResult> {
    const plan = assertDocument("GitHubEffectPlan", rawPlan);
    if (!/^sha256:[0-9a-f]{64}$/.test(claimantId)) {
      throw new TypeError("claimantId must be a canonical digest");
    }
    const evidenceServices = this.evidenceServices as
      | {
          readonly identity?: Partial<GitHubEvidenceIdentity>;
          readonly signer?: Partial<GitHubEvidenceSigner>;
          readonly verifier?: Partial<GitHubEvidenceVerifier>;
          readonly store?: Partial<GitHubEvidenceStore>;
        }
      | undefined;
    if (
      evidenceServices?.store?.supportsAuthenticatedConditionalAppend !== true ||
      typeof evidenceServices.store.readEvidence !== "function" ||
      typeof evidenceServices.store.conditionalAppendEvidence !== "function" ||
      typeof evidenceServices.signer?.signEvidence !== "function" ||
      typeof evidenceServices.verifier?.verifyEvidence !== "function" ||
      !Number.isSafeInteger(evidenceServices.identity?.applicationId) ||
      Number(evidenceServices.identity?.applicationId) < 1 ||
      !Number.isSafeInteger(evidenceServices.identity?.authorId) ||
      Number(evidenceServices.identity?.authorId) < 1
    ) {
      throw new GitHubExecutionError(
        "EVIDENCE_AUTHENTICATION_REQUIRED",
        "authenticated conditional GitHub evidence is required",
        false
      );
    }
    assertEffectTargets(plan, binding);
    const localRetryKey = `${claimantId}:${plan.idempotencyKey}`;
    const localRetry = this.#localRetryNotBefore.get(localRetryKey);
    if (localRetry !== undefined) {
      const now = this.now().getTime();
      if (!Number.isSafeInteger(now)) {
        throw new TypeError("writer clock returned an invalid date");
      }
      const remainingDelay = localRetry.notBefore - now;
      if (remainingDelay > 0) {
        throw new GitHubExecutionError(
          localRetry.external
            ? "EXTERNAL_RETRY_WINDOW"
            : "RETRY_NOT_BEFORE",
          localRetry.external
            ? "GitHub retry delay exceeds automatic policy bounds"
            : "GitHub retry delay has not elapsed",
          !localRetry.external,
          remainingDelay
        );
      }
      this.#localRetryNotBefore.delete(localRetryKey);
    }
    return this.credentials.withClientForEffect(
      binding,
      plan.effect,
      (api) => this.executeWithClient(api, binding, plan, claimantId)
    );
  }

  private async executeWithClient(
    api: GitHubApi,
    binding: TrustedGitHubBinding,
    plan: GitHubEffectPlan,
    claimantId: Digest
  ): Promise<GitHubExecutionResult> {
    const services = this.evidenceServices;
    if (services === undefined) {
      throw new GitHubExecutionError(
        "EVIDENCE_AUTHENTICATION_REQUIRED",
        "authenticated conditional GitHub evidence is required",
        false
      );
    }
    const read = <T>(operation: () => Promise<T>): Promise<T> =>
      boundedRead(operation, this.retryPolicy, this.sleep);
    assertFreshState(plan, binding, await read(() => api.readExecutionState(binding)));
    const planDigest = digest(plan);
    const plannedEffectDigest = digest(plan.effect);
    const operationDigest = digest({
      claimantId,
      planDigest
    });
    const readEvidence = async (): Promise<GitHubEvidenceRecord | null> => {
      const snapshot = await read(() =>
        services.store.readEvidence(api, binding, plan.idempotencyKey)
      );
      return validateEvidence(snapshot, plan, services);
    };
    const appendEvidence = async (
      previous: GitHubEvidenceRecord | null,
      update: {
        readonly state: GitHubEvidenceState["state"];
        readonly effectDigest: Digest | null;
        readonly writeAttempts: number;
        readonly retryAfterMs: number | null;
        readonly lastError: GitHubEvidenceError | null;
      },
      postEffectTransition = false
    ): Promise<GitHubEvidenceRecord> => {
      const now = this.now();
      if (!Number.isSafeInteger(now.getTime())) {
        throw new TypeError("writer clock returned an invalid date");
      }
      const timestamp = now.toISOString();
      const retryDeadline =
        update.state === "retryable" && update.retryAfterMs !== null
          ? now.getTime() + update.retryAfterMs
          : null;
      if (retryDeadline !== null && !Number.isSafeInteger(retryDeadline)) {
        throw new GitHubExecutionError(
          "RETRY_STATE_INVALID",
          "retry delay exceeds safe time bounds",
          false
        );
      }
      const evidence: GitHubEvidenceState = {
        schemaVersion: "v1alpha1",
        sequence: (previous?.evidence.sequence ?? 0) + 1,
        priorSequence: previous?.evidence.sequence ?? null,
        priorEvidenceDigest:
          previous === null ? null : evidenceDigest(previous),
        bindingDigest: plan.bindingDigest,
        idempotencyKey: plan.idempotencyKey,
        planDigest,
        claimantId,
        operationDigest,
        state: update.state,
        effectDigest: update.effectDigest,
        writeAttempts: update.writeAttempts,
        retryAfterMs: update.retryAfterMs,
        retryNotBefore:
          retryDeadline === null
            ? null
            : new Date(retryDeadline).toISOString(),
        lastError: update.lastError,
        createdAt: previous?.evidence.createdAt ?? timestamp,
        updatedAt: timestamp
      };
      const signature = await services.signer.signEvidence({
        identity: services.identity,
        evidence
      });
      const signed: GitHubSignedEvidence = { evidence, signature };
      try {
        await services.store.conditionalAppendEvidence(
          api,
          binding,
          previous === null ? null : evidenceHead(previous),
          signed
        );
      } catch (error) {
        if (error instanceof GitHubEvidenceConflictError) {
          const latest = await readEvidence();
          const latestHead = latest === null ? null : evidenceHead(latest);
          if (
            postEffectTransition &&
            update.state === "completed" &&
            latest !== null &&
            latest.evidence.state === "completed" &&
            latest.evidence.effectDigest === plannedEffectDigest &&
            error.actualHead !== null &&
            sameEvidenceHead(error.actualHead, latestHead) &&
            latestHead?.evidenceDigest ===
              signedEvidenceDigest(services.identity, signed)
          ) {
            return latest;
          }
          if (postEffectTransition) {
            throw new GitHubExecutionError(
              "PARTIAL_EFFECT",
              "authenticated evidence changed after a GitHub effect attempt",
              false
            );
          }
          throw new GitHubExecutionError(
            "CONCURRENCY_CONFLICT",
            "authenticated evidence head changed during conditional append",
            false
          );
        }
        throw error;
      }
      const latest = await readEvidence();
      if (
        latest === null ||
        latest.evidence.sequence !== evidence.sequence ||
        signedEvidenceDigest(services.identity, latest) !==
          signedEvidenceDigest(services.identity, signed)
      ) {
        throw new GitHubExecutionError(
          "EVIDENCE_CHAIN_INVALID",
          "conditional evidence append was not durably observed at the head",
          false
        );
      }
      return latest;
    };
    const retryDelay = (
      evidence: GitHubEvidenceState
    ): { readonly remainingDelay: number; readonly external: boolean } => {
      if (
        evidence.retryAfterMs === null ||
        !Number.isSafeInteger(evidence.retryAfterMs) ||
        evidence.retryAfterMs < 0
      ) {
        throw new GitHubExecutionError(
          "RETRY_STATE_INVALID",
          "retryable evidence contains an invalid bounded delay",
          false
        );
      }
      const updatedAt = new Date(evidence.updatedAt);
      const normalizedUpdatedAt = evidence.updatedAt.includes(".")
        ? evidence.updatedAt
        : evidence.updatedAt.replace(/Z$/, ".000Z");
      if (
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(
          evidence.updatedAt
        ) ||
        Number.isNaN(updatedAt.getTime()) ||
        updatedAt.toISOString() !== normalizedUpdatedAt
      ) {
        throw new GitHubExecutionError(
          "RETRY_STATE_INVALID",
          "retryable evidence contains an invalid update timestamp",
          false
        );
      }
      const notBefore = updatedAt.getTime() + evidence.retryAfterMs;
      if (!Number.isSafeInteger(notBefore)) {
        throw new GitHubExecutionError(
          "RETRY_STATE_INVALID",
          "retryable evidence delay exceeds safe time bounds",
          false
        );
      }
      const now = this.now().getTime();
      if (!Number.isSafeInteger(now)) {
        throw new TypeError("writer clock returned an invalid date");
      }
      return {
        remainingDelay: Math.max(0, notBefore - now),
        external: evidence.retryAfterMs > this.retryPolicy.maximumDelayMs
      };
    };
    const resolveEvidence = async (
      evidence: GitHubEvidenceRecord,
      allowUnattemptedResume: boolean
    ): Promise<GitHubEvidenceResolution> => {
      const state = evidence.evidence;
      if (state.state === "completed") {
        if (state.effectDigest !== plannedEffectDigest) {
          throw new GitHubExecutionError(
            "REPLAY_CONFLICT",
            "completed evidence does not match the planned effect",
            false
          );
        }
        return {
          kind: "result",
          result: {
            kind: "replayed",
            evidenceNodeId: evidence.nodeId,
            effectDigest: state.effectDigest
          }
        };
      }
      if (state.state === "partial") {
        throw new GitHubExecutionError(
          "PARTIAL_EFFECT",
          "prior execution recorded a partial effect and requires reconciliation",
          false
        );
      }
      if (
        state.claimantId !== claimantId ||
        state.operationDigest !== operationDigest
      ) {
        throw new GitHubExecutionError(
          "CONCURRENCY_CONFLICT",
          "pending claim belongs to another writer",
          false
        );
      }
      if (
        state.state === "retryable" &&
        state.writeAttempts >= this.retryPolicy.maxAttempts
      ) {
        throw new GitHubExecutionError(
          "RETRY_EXHAUSTED",
          "bounded GitHub write attempts are exhausted",
          false
        );
      }
      if (state.state === "retryable") {
        const { remainingDelay, external } = retryDelay(state);
        if (remainingDelay > 0) {
          throw new GitHubExecutionError(
            external ? "EXTERNAL_RETRY_WINDOW" : "RETRY_NOT_BEFORE",
            external
              ? "GitHub retry delay exceeds automatic policy bounds"
              : "GitHub retry delay has not elapsed",
            !external,
            remainingDelay
          );
        }
      }
      const observed = await read(() => api.observeEffect(binding, plan));
      if (observed !== null && observed.effectDigest !== plannedEffectDigest) {
        await appendEvidence(
          evidence,
          {
            state: "partial",
            effectDigest: observed.effectDigest,
            writeAttempts: state.writeAttempts,
            retryAfterMs: null,
            lastError: {
              code: "READ_AFTER_WRITE_FAILED",
              status: null,
              retryable: false,
              outcomeAmbiguous: false
            }
          },
          true
        );
        throw new GitHubExecutionError(
          "READ_AFTER_WRITE_FAILED",
          "pending claim resolved to an effect that does not match its plan",
          false
        );
      }
      if (observed !== null) {
        const completed = await appendEvidence(
          evidence,
          {
            state: "completed",
            effectDigest: observed.effectDigest,
            writeAttempts: Math.max(1, state.writeAttempts),
            retryAfterMs: null,
            lastError: null
          },
          true
        );
        return {
          kind: "result",
          result: {
            kind: "reconciled",
            evidenceNodeId: completed.nodeId,
            effectNodeId: observed.nodeId,
            effectDigest: observed.effectDigest
          }
        };
      }
      if (state.state === "pending" && state.writeAttempts > 0) {
        await appendEvidence(
          evidence,
          {
            state: "partial",
            effectDigest: null,
            writeAttempts: state.writeAttempts,
            retryAfterMs: null,
            lastError: {
              code: "UNOBSERVED_WRITE",
              status: null,
              retryable: false,
              outcomeAmbiguous: true
            }
          },
          true
        );
        throw new GitHubExecutionError(
          "PARTIAL_EFFECT",
          "a prior write attempt has no conclusive GitHub observation",
          false
        );
      }
      if (!allowUnattemptedResume) {
        throw new GitHubExecutionError(
          "CLAIM_RECONCILIATION_REQUIRED",
          "ambiguous claim creation requires a fresh serialized invocation",
          true
        );
      }
      return { kind: "claim", claim: evidence };
    };

    const initialEvidence = await readEvidence();
    let claim: GitHubEvidenceRecord;
    if (initialEvidence !== null) {
      const resolution = await resolveEvidence(initialEvidence, true);
      if (resolution.kind === "result") return resolution.result;
      claim = resolution.claim;
    } else {
      try {
        claim = await appendEvidence(null, {
          state: "pending",
          effectDigest: null,
          writeAttempts: 0,
          retryAfterMs: null,
          lastError: null
        });
      } catch (error) {
        if (!(error instanceof GitHubApiError) || !error.outcomeAmbiguous) {
          throw error;
        }
        const reconciledClaim = await readEvidence();
        const latestClaim = await readEvidence();
        if (
          reconciledClaim === null ||
          latestClaim === null ||
          !sameEvidenceHead(
            evidenceHead(latestClaim),
            evidenceHead(reconciledClaim)
          )
        ) {
          throw new GitHubExecutionError(
            "CONCURRENCY_CONFLICT",
            "ambiguous claim creation did not resolve to one stable claim",
            false
          );
        }
        const resolution = await resolveEvidence(latestClaim, false);
        if (resolution.kind === "result") return resolution.result;
        throw new GitHubExecutionError(
          "CLAIM_RECONCILIATION_REQUIRED",
          "ambiguous claim creation requires a fresh serialized invocation",
          true
        );
      }
    }

    const confirmedClaim = await readEvidence();
    if (
      confirmedClaim === null ||
      !sameEvidenceHead(evidenceHead(confirmedClaim), evidenceHead(claim))
    ) {
      throw new GitHubExecutionError(
        "CONCURRENCY_CONFLICT",
        "GitHub-native effect claim could not be uniquely confirmed",
        false
      );
    }
    const confirmedResolution = await resolveEvidence(confirmedClaim, true);
    if (confirmedResolution.kind === "result") return confirmedResolution.result;
    claim = confirmedResolution.claim;

    assertFreshState(plan, binding, await read(() => api.readExecutionState(binding)));
    if (plan.effect.type === "project-field-update") {
      const projectEffect = plan.effect;
      const currentValue = await read(() =>
        api.getProjectFieldValue({
          projectNodeId: projectEffect.projectNodeId,
          itemNodeId: projectEffect.itemNodeId,
          fieldNodeId: projectEffect.fieldNodeId
        })
      );
      if (!sameProjectValue(projectEffect.expectedCurrentValue, currentValue)) {
        throw new GitHubExecutionError(
          "CONCURRENCY_CONFLICT",
          "Project value changed before the planned update",
          false
        );
      }
    }

    if (claim.evidence.writeAttempts >= this.retryPolicy.maxAttempts) {
      throw new GitHubExecutionError(
        "RETRY_EXHAUSTED",
        "bounded GitHub write attempts are exhausted",
        false
      );
    }
    const commentPreflightState =
      plan.effect.type === "pull-request-review-comment"
        ? await read(() => api.readExecutionState(binding))
        : null;
    if (commentPreflightState !== null) {
      assertFreshState(plan, binding, commentPreflightState);
    }
    claim = await appendEvidence(claim, {
      state: "pending",
      effectDigest: null,
      writeAttempts: claim.evidence.writeAttempts + 1,
      retryAfterMs: null,
      lastError: null
    });
    const finalState =
      commentPreflightState ??
      (await read(() => api.readExecutionState(binding)));
    if (commentPreflightState === null) {
      assertFreshState(plan, binding, finalState);
    }
    const precondition: GitHubEffectPrecondition = {
      bindingDigest: digest(binding),
      planDigest: digest(plan),
      effectDigest: digest(plan.effect),
      executionStateDigest: digest(finalState),
      expectedHeadSha:
        plan.effect.type === "pull-request-review-comment"
          ? plan.effect.headSha
          : null
    };
    let effect: GitHubEffectObservation;
    try {
      effect = await api.applyEffect(binding, plan, precondition);
    } catch (error) {
      if (
        error instanceof GitHubApiError &&
        error.retryable &&
        !error.outcomeAmbiguous
      ) {
        const requestedDelay =
          error.retryAfterMs ??
          this.retryPolicy.baseDelayMs *
            2 ** Math.max(0, claim.evidence.writeAttempts - 1);
        if (!Number.isSafeInteger(requestedDelay) || requestedDelay < 0) {
          throw new GitHubExecutionError(
            "RETRY_STATE_INVALID",
            "GitHub returned an invalid retry delay",
            false
          );
        }
        const retryAfterMs = requestedDelay;
        const retryableEvidence = await appendEvidence(
          claim,
          {
            state: "retryable",
            effectDigest: null,
            writeAttempts: claim.evidence.writeAttempts,
            retryAfterMs,
            lastError: {
              code: error.code,
              status: error.status,
              retryable: error.retryable,
              outcomeAmbiguous: error.outcomeAmbiguous
            }
          },
          true
        );
        const notBefore = new Date(
          retryableEvidence.evidence.retryNotBefore ?? ""
        ).getTime();
        if (!Number.isSafeInteger(notBefore)) {
          throw new GitHubExecutionError(
            "RETRY_STATE_INVALID",
            "retry delay exceeds safe time bounds",
            false
          );
        }
        const external =
          retryAfterMs > this.retryPolicy.maximumDelayMs;
        this.#localRetryNotBefore.set(`${claimantId}:${plan.idempotencyKey}`, {
          notBefore,
          external
        });
        if (external) {
          throw new GitHubExecutionError(
            "EXTERNAL_RETRY_WINDOW",
            "GitHub retry delay exceeds automatic policy bounds",
            false,
            retryAfterMs
          );
        }
        throw new GitHubExecutionError(
          "RETRYABLE_WRITE_FAILURE",
          "GitHub rejected the write before applying it; retry through a fresh writer invocation",
          true
        );
      }
      const observed = await read(() => api.observeEffect(binding, plan));
      if (observed !== null && observed.effectDigest === digest(plan.effect)) {
        const completed = await appendEvidence(
          claim,
          {
            state: "completed",
            effectDigest: observed.effectDigest,
            writeAttempts: claim.evidence.writeAttempts,
            retryAfterMs: null,
            lastError: null
          },
          true
        );
        return {
          kind: "reconciled",
          evidenceNodeId: completed.nodeId,
          effectNodeId: observed.nodeId,
          effectDigest: observed.effectDigest
        };
      }
      await appendEvidence(
        claim,
        {
          state: "partial",
          effectDigest: observed?.effectDigest ?? null,
          writeAttempts: claim.evidence.writeAttempts,
          retryAfterMs: null,
          lastError:
            error instanceof GitHubApiError
              ? {
                  code: error.code,
                  status: error.status,
                  retryable: error.retryable,
                  outcomeAmbiguous: error.outcomeAmbiguous
                }
              : {
                  code: "UNOBSERVED_WRITE",
                  status: null,
                  retryable: false,
                  outcomeAmbiguous: true
                }
        },
        true
      );
      throw new GitHubExecutionError(
        "PARTIAL_EFFECT",
        `GitHub effect outcome is not safely retryable: ${
          error instanceof Error ? error.message : "unknown failure"
        }`,
        false
      );
    }

    const verified = await read(() => api.observeEffect(binding, plan));
    if (
      verified === null ||
      verified.nodeId !== effect.nodeId ||
      verified.effectDigest !== digest(plan.effect)
    ) {
      await appendEvidence(
        claim,
        {
          state: "partial",
          effectDigest: verified?.effectDigest ?? null,
          writeAttempts: claim.evidence.writeAttempts,
          retryAfterMs: null,
          lastError: {
            code: "READ_AFTER_WRITE_FAILED",
            status: null,
            retryable: false,
            outcomeAmbiguous: false
          }
        },
        true
      );
      throw new GitHubExecutionError(
        "READ_AFTER_WRITE_FAILED",
        "GitHub read-after-write verification did not match the effect plan",
        false
      );
    }

    let completedEvidence: GitHubEvidenceRecord;
    try {
      completedEvidence = await appendEvidence(
        claim,
        {
          state: "completed",
          effectDigest: verified.effectDigest,
          writeAttempts: claim.evidence.writeAttempts,
          retryAfterMs: null,
          lastError: null
        },
        true
      );
    } catch (error) {
      if (!(error instanceof GitHubApiError) || !error.outcomeAmbiguous) {
        throw error;
      }
      const evidence = await readEvidence();
      if (
        evidence?.evidence.state !== "completed" ||
        evidence.evidence.effectDigest !== verified.effectDigest
      ) {
        throw new GitHubExecutionError(
          "PARTIAL_EFFECT",
          "effect succeeded but evidence acknowledgement is ambiguous",
          false
        );
      }
      completedEvidence = evidence;
    }

    return {
      kind: "applied",
      evidenceNodeId: completedEvidence.nodeId,
      effectNodeId: effect.nodeId,
      effectDigest: verified.effectDigest
    };
  }
}

export function githubConcurrencyKey(binding: TrustedGitHubBinding): string {
  return `github-${binding.repository.id}-${binding.workItem.nodeId.replace(
    /[^A-Za-z0-9_-]/g,
    "_"
  )}`;
}

export function effectEvidenceMarker(record: GitHubSignedEvidence): string {
  return `<!-- agentic-framework-effect ${canonicalJson(record)} -->`;
}
