import { canonicalJson, digest } from "./canonical.js";
import {
  validateDemoContract,
  validateDemoProjectContractSet
} from "./demo-portfolio.js";
import { parseStrictJson } from "./strict-json.js";
import type {
  DemoProjectContractSet,
  DemoProjectionFieldKey,
  DemoProjectId,
  DemoCatalog,
  DemoIdentityReservationManifest,
  DemoRunFence,
  DemoRunState,
  SignedStageReceipt,
  SignedStageReceiptVerifier,
  StageArtifactEnvelope
} from "./demo-types.js";
import { DEMO_PROJECTION_VOCABULARY } from "./demo-types.js";
import type {
  ActivationLease,
  CapabilityRegistry,
  Digest,
  KernelSnapshot,
  LifecycleGraph,
  WorkAccord
} from "./types.js";
import { assertDocument, isCanonicalUtcDateTime } from "./validation.js";
import { workAccordBindingDigest } from "./binding.js";
import type { StageAgentSelectionResolution } from "./demo-agent-selection.js";

const MAX_RUNTIME_DOCUMENT_BYTES = 1_048_576;
const MAX_STAGE_EVIDENCE = 64;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;

export const DEMO_WORKFLOW_CANCEL_IN_PROGRESS = false;

interface RuntimeContentAddressedRecord<K extends string, S> {
  readonly apiVersion: "agentic-framework.github.com/v1alpha1";
  readonly kind: K;
  readonly schemaVersion: "1.0.0";
  readonly contentDigest: Digest;
  readonly spec: S;
}

export type DemoProjectionState = RuntimeContentAddressedRecord<
  "DemoProjectionState",
  {
    readonly demoProjectId: DemoProjectId;
    readonly repositoryId: number;
    readonly workItemNodeId: string;
    readonly projectBindingDigest: Digest;
    readonly authorityEpoch: number;
    readonly generation: number;
    readonly kernelStateVersion: number;
    readonly kernelReceiptDigest: Digest | null;
    readonly stageReceiptDigest: Digest | null;
    readonly fields: readonly {
      readonly key: DemoProjectionFieldKey;
      readonly value: string | null;
    }[];
    readonly observedAt: string;
  }
>;

export type DemoBudgetState = RuntimeContentAddressedRecord<
  "DemoBudgetState",
  {
    readonly demoProjectId: DemoProjectId;
    readonly repositoryId: number;
    readonly workItemNodeId: string;
    readonly authorityEpoch: number;
    readonly generation: number;
    readonly activationLeaseDigest: Digest;
    readonly workAccordDigest: Digest;
    readonly limits: {
      readonly maxCalls: number;
      readonly maxTokens: number;
      readonly maxCostUnits: number;
      readonly maxDurationMs: number;
      readonly maxRetries: number;
      readonly maxParallel: 1;
    };
    readonly usage: {
      readonly calls: number;
      readonly tokens: number;
      readonly costUnits: number;
      readonly retries: number;
    };
    readonly held: {
      readonly calls: number;
      readonly tokens: number;
      readonly costUnits: number;
    };
    readonly startedAt: string;
    readonly expiresAt: string;
    readonly ledgerVersion: number;
    readonly ledgerHead: Digest | null;
  }
>;

export interface DemoRuntimeAuthority {
  readonly catalog: unknown;
  readonly reservations: unknown;
  readonly lifecycle: LifecycleGraph;
  readonly baseRegistry: CapabilityRegistry;
  readonly contracts: DemoProjectContractSet;
  readonly workAccord: WorkAccord;
}

export type DemoRuntimeReconciliationCode =
  | "KERNEL_CURSOR_MISMATCH"
  | "PROJECTION_AHEAD"
  | "PROJECTION_DIVERGED"
  | "UNRESOLVED_FENCE";

export interface DemoRuntimeReconstruction {
  readonly authority: {
    readonly catalog: DemoCatalog;
    readonly reservations: DemoIdentityReservationManifest;
    readonly contracts: DemoProjectContractSet;
    readonly lifecycle: LifecycleGraph;
    readonly baseRegistry: CapabilityRegistry;
    readonly workAccord: WorkAccord;
  };
  readonly runState: DemoRunState;
  readonly kernelSnapshot: KernelSnapshot;
  readonly activationLease: ActivationLease;
  readonly budget: DemoBudgetState;
  readonly projection: DemoProjectionState;
  readonly completedReceipts: readonly SignedStageReceipt[];
  readonly artifacts: readonly StageArtifactEnvelope[];
  readonly fences: readonly DemoRunFence[];
  readonly pendingArtifact: StageArtifactEnvelope | null;
  readonly currentStage: DemoProjectContractSet["journey"]["spec"]["stages"][number];
  readonly nextStage:
    | DemoProjectContractSet["journey"]["spec"]["stages"][number]
    | null;
  readonly activationReady: boolean;
  readonly activationReason:
    | "AUTHORIZED"
    | "PROFILE_DISABLED"
    | "EPOCH_STALE"
    | "LEASE_REVOKED"
    | "LEASE_EXPIRED"
    | "LEASE_INVALID";
  readonly agentSelection: StageAgentSelectionResolution | null;
  readonly reconciliation: readonly DemoRuntimeReconciliationCode[];
}

function fail(message: string): never {
  throw new TypeError(message);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function immutableSnapshot<T>(value: T): T {
  return deepFreeze(JSON.parse(canonicalJson(value)) as T);
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  label: string
): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((key, index) => key !== canonical[index])
  ) {
    fail(`${label} fields are not closed`);
  }
}

function safeCounter(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`${label} must be a non-negative safe integer`);
  }
}

function positiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(`${label} must be a positive safe integer`);
  }
}

function canonicalTime(value: string, label: string): number {
  if (!isCanonicalUtcDateTime(value)) {
    fail(`${label} must be a canonical UTC timestamp`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    fail(`${label} must represent a real canonical UTC timestamp`);
  }
  return milliseconds;
}

function parseRuntimeJson(source: string, label: string): unknown {
  if (
    typeof source !== "string" ||
    Buffer.byteLength(source, "utf8") > MAX_RUNTIME_DOCUMENT_BYTES
  ) {
    fail(`${label} exceeds the bounded runtime document size`);
  }
  return parseStrictJson(source);
}

function runtimeRecordDigest(kind: string, spec: unknown): Digest {
  return digest({
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind,
    schemaVersion: "1.0.0",
    spec
  });
}

export function validateDemoProjectionState(
  value: unknown
): DemoProjectionState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("DemoProjectionState must be a closed object");
  }
  const state = immutableSnapshot(value as DemoProjectionState);
  exactKeys(
    state as unknown as Readonly<Record<string, unknown>>,
    ["apiVersion", "kind", "schemaVersion", "contentDigest", "spec"],
    "DemoProjectionState"
  );
  if (
    state.apiVersion !== "agentic-framework.github.com/v1alpha1" ||
    state.kind !== "DemoProjectionState" ||
    state.schemaVersion !== "1.0.0" ||
    !DIGEST.test(state.contentDigest) ||
    state.contentDigest !== runtimeRecordDigest(state.kind, state.spec)
  ) {
    fail("DemoProjectionState envelope is invalid");
  }
  exactKeys(
    state.spec as unknown as Readonly<Record<string, unknown>>,
    [
      "demoProjectId",
      "repositoryId",
      "workItemNodeId",
      "projectBindingDigest",
      "authorityEpoch",
      "generation",
      "kernelStateVersion",
      "kernelReceiptDigest",
      "stageReceiptDigest",
      "fields",
      "observedAt"
    ],
    "DemoProjectionState spec"
  );
  positiveInteger(state.spec.repositoryId, "projection repositoryId");
  positiveInteger(state.spec.authorityEpoch, "projection authorityEpoch");
  safeCounter(state.spec.generation, "projection generation");
  safeCounter(state.spec.kernelStateVersion, "projection kernelStateVersion");
  if (
    state.spec.workItemNodeId.length < 1 ||
    state.spec.workItemNodeId.length > 256 ||
    !DIGEST.test(state.spec.projectBindingDigest) ||
    (state.spec.kernelReceiptDigest !== null &&
      !DIGEST.test(state.spec.kernelReceiptDigest)) ||
    (state.spec.stageReceiptDigest !== null &&
      !DIGEST.test(state.spec.stageReceiptDigest))
  ) {
    fail("DemoProjectionState identity or receipt evidence is invalid");
  }
  canonicalTime(state.spec.observedAt, "projection observedAt");
  if (
    state.spec.fields.length !== DEMO_PROJECTION_VOCABULARY.length ||
    state.spec.fields.some((field, index) => {
      const expected = DEMO_PROJECTION_VOCABULARY[index];
      if (expected === undefined) return true;
      exactKeys(
        field as unknown as Readonly<Record<string, unknown>>,
        ["key", "value"],
        "DemoProjectionState field"
      );
      return (
        field.key !== expected.key ||
        (field.value !== null &&
          (typeof field.value !== "string" ||
            field.value.length > 512 ||
            /[\u0000-\u001f\u007f]/u.test(field.value)))
      );
    })
  ) {
    fail("DemoProjectionState must contain the exact bounded field vocabulary");
  }
  return state;
}

export function validateDemoBudgetState(value: unknown): DemoBudgetState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("DemoBudgetState must be a closed object");
  }
  const state = immutableSnapshot(value as DemoBudgetState);
  exactKeys(
    state as unknown as Readonly<Record<string, unknown>>,
    ["apiVersion", "kind", "schemaVersion", "contentDigest", "spec"],
    "DemoBudgetState"
  );
  if (
    state.apiVersion !== "agentic-framework.github.com/v1alpha1" ||
    state.kind !== "DemoBudgetState" ||
    state.schemaVersion !== "1.0.0" ||
    !DIGEST.test(state.contentDigest) ||
    state.contentDigest !== runtimeRecordDigest(state.kind, state.spec)
  ) {
    fail("DemoBudgetState envelope is invalid");
  }
  exactKeys(
    state.spec as unknown as Readonly<Record<string, unknown>>,
    [
      "demoProjectId",
      "repositoryId",
      "workItemNodeId",
      "authorityEpoch",
      "generation",
      "activationLeaseDigest",
      "workAccordDigest",
      "limits",
      "usage",
      "held",
      "startedAt",
      "expiresAt",
      "ledgerVersion",
      "ledgerHead"
    ],
    "DemoBudgetState spec"
  );
  exactKeys(
    state.spec.limits as unknown as Readonly<Record<string, unknown>>,
    [
      "maxCalls",
      "maxTokens",
      "maxCostUnits",
      "maxDurationMs",
      "maxRetries",
      "maxParallel"
    ],
    "DemoBudgetState limits"
  );
  exactKeys(
    state.spec.usage as unknown as Readonly<Record<string, unknown>>,
    ["calls", "tokens", "costUnits", "retries"],
    "DemoBudgetState usage"
  );
  exactKeys(
    state.spec.held as unknown as Readonly<Record<string, unknown>>,
    ["calls", "tokens", "costUnits"],
    "DemoBudgetState held"
  );
  positiveInteger(state.spec.repositoryId, "budget repositoryId");
  positiveInteger(state.spec.authorityEpoch, "budget authorityEpoch");
  safeCounter(state.spec.generation, "budget generation");
  positiveInteger(state.spec.limits.maxDurationMs, "budget maxDurationMs");
  if (state.spec.limits.maxParallel !== 1) {
    fail("DemoBudgetState must use one cross-workflow concurrency domain");
  }
  for (const [key, counter] of Object.entries({
    maxCalls: state.spec.limits.maxCalls,
    maxTokens: state.spec.limits.maxTokens,
    maxCostUnits: state.spec.limits.maxCostUnits,
    maxRetries: state.spec.limits.maxRetries,
    calls: state.spec.usage.calls,
    tokens: state.spec.usage.tokens,
    costUnits: state.spec.usage.costUnits,
    retries: state.spec.usage.retries,
    heldCalls: state.spec.held.calls,
    heldTokens: state.spec.held.tokens,
    heldCostUnits: state.spec.held.costUnits,
    ledgerVersion: state.spec.ledgerVersion
  })) {
    safeCounter(counter, `budget ${key}`);
  }
  if (
    state.spec.workItemNodeId.length < 1 ||
    state.spec.workItemNodeId.length > 256 ||
    !DIGEST.test(state.spec.activationLeaseDigest) ||
    !DIGEST.test(state.spec.workAccordDigest) ||
    (state.spec.ledgerHead !== null && !DIGEST.test(state.spec.ledgerHead)) ||
    (state.spec.ledgerVersion === 0) !== (state.spec.ledgerHead === null)
  ) {
    fail("DemoBudgetState authority or ledger identity is invalid");
  }
  const startedAt = canonicalTime(state.spec.startedAt, "budget startedAt");
  const expiresAt = canonicalTime(state.spec.expiresAt, "budget expiresAt");
  if (
    startedAt >= expiresAt ||
    state.spec.usage.calls + state.spec.held.calls >
      state.spec.limits.maxCalls ||
    state.spec.usage.tokens + state.spec.held.tokens >
      state.spec.limits.maxTokens ||
    state.spec.usage.costUnits + state.spec.held.costUnits >
      state.spec.limits.maxCostUnits ||
    state.spec.usage.retries > state.spec.limits.maxRetries
  ) {
    fail("DemoBudgetState exceeds its fixed budget");
  }
  return state;
}

export function createDemoProjectionState(
  spec: DemoProjectionState["spec"]
): DemoProjectionState {
  return validateDemoProjectionState({
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "DemoProjectionState",
    schemaVersion: "1.0.0",
    contentDigest: runtimeRecordDigest("DemoProjectionState", spec),
    spec
  });
}

export function createDemoBudgetState(
  spec: DemoBudgetState["spec"]
): DemoBudgetState {
  return validateDemoBudgetState({
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "DemoBudgetState",
    schemaVersion: "1.0.0",
    contentDigest: runtimeRecordDigest("DemoBudgetState", spec),
    spec
  });
}

export function demoBudgetAuthorityDigest(
  value: DemoBudgetState
): Digest {
  const budget = validateDemoBudgetState(value);
  return digest({
    domain: "agentic-framework.demo-budget-authority.v1",
    demoProjectId: budget.spec.demoProjectId,
    repositoryId: budget.spec.repositoryId,
    workItemNodeId: budget.spec.workItemNodeId,
    authorityEpoch: budget.spec.authorityEpoch,
    generation: budget.spec.generation,
    activationLeaseDigest: budget.spec.activationLeaseDigest,
    workAccordDigest: budget.spec.workAccordDigest,
    limits: budget.spec.limits,
    startedAt: budget.spec.startedAt,
    expiresAt: budget.spec.expiresAt
  });
}

export function loadDemoRunState(source: string): DemoRunState {
  return validateDemoContract(
    "DemoRunState",
    parseRuntimeJson(source, "DemoRunState")
  );
}

export function loadSignedStageReceipt(source: string): SignedStageReceipt {
  return validateDemoContract(
    "SignedStageReceipt",
    parseRuntimeJson(source, "SignedStageReceipt")
  );
}

export function loadStageArtifactEnvelope(
  source: string
): StageArtifactEnvelope {
  return validateDemoContract(
    "StageArtifactEnvelope",
    parseRuntimeJson(source, "StageArtifactEnvelope")
  );
}

export function loadDemoRunFence(source: string): DemoRunFence {
  return validateDemoContract(
    "DemoRunFence",
    parseRuntimeJson(source, "DemoRunFence")
  );
}

export function loadKernelSnapshot(source: string): KernelSnapshot {
  return immutableSnapshot(
    assertDocument(
      "KernelSnapshot",
      parseRuntimeJson(source, "KernelSnapshot")
    )
  );
}

export function loadActivationLease(source: string): ActivationLease {
  return immutableSnapshot(
    assertDocument(
      "ActivationLease",
      parseRuntimeJson(source, "ActivationLease")
    )
  );
}

export function loadDemoBudgetState(source: string): DemoBudgetState {
  return validateDemoBudgetState(
    parseRuntimeJson(source, "DemoBudgetState")
  );
}

export function loadDemoProjectionState(source: string): DemoProjectionState {
  return validateDemoProjectionState(
    parseRuntimeJson(source, "DemoProjectionState")
  );
}

export function demoWorkflowConcurrencyKey(input: {
  readonly repositoryId: number;
  readonly workItemNodeId: string;
}): string {
  positiveInteger(input.repositoryId, "repositoryId");
  if (
    input.workItemNodeId.length < 1 ||
    input.workItemNodeId.length > 256
  ) {
    fail("workItemNodeId must preserve one exact opaque GitHub node ID");
  }
  return `demo-${input.repositoryId}-${digest({
    repositoryId: input.repositoryId,
    workItemNodeId: input.workItemNodeId
  }).slice("sha256:".length)}`;
}

const FORWARD_KERNEL_STATES = [
  "CAPTURED",
  "ACTIVATION_PENDING",
  "FRAMING",
  "PLANNED",
  "EXECUTING",
  "VERIFYING",
  "HUMAN_REVIEW",
  "COMPLETED"
] as const;
const CONTROL_KERNEL_STATES = new Set([
  "PAUSED",
  "BLOCKED",
  "CANCELLED"
]);

export function projectedDemoStageLeadsKernel(
  projectedStage: string | null,
  kernelState: KernelSnapshot["state"]
): boolean {
  if (projectedStage === null || projectedStage === kernelState) return false;
  const projectedIndex = FORWARD_KERNEL_STATES.indexOf(
    projectedStage as (typeof FORWARD_KERNEL_STATES)[number]
  );
  const kernelIndex = FORWARD_KERNEL_STATES.indexOf(
    kernelState as (typeof FORWARD_KERNEL_STATES)[number]
  );
  if (CONTROL_KERNEL_STATES.has(projectedStage)) return false;
  if (projectedIndex < 0) return true;
  if (kernelIndex < 0) return false;
  return projectedIndex > kernelIndex;
}

export function demoCoreBindingFromSnapshot(
  snapshot: KernelSnapshot
): DemoRunState["spec"]["core"] {
  const validated = assertDocument("KernelSnapshot", snapshot);
  return immutableSnapshot({
    state: validated.state,
    stateVersion: validated.stateVersion,
    bindingDigest: validated.bindingDigest,
    lifecycleGraphDigest: validated.lifecycleGraphDigest,
    workAccordDigest: validated.workAccordDigest,
    capabilityRegistryDigest: validated.capabilityRegistryDigest,
    domainPackDigest: validated.domainPackDigest,
    phaseContractDigest: validated.phaseContractDigest,
    compiledPolicyDigest: validated.compiledPolicyDigest,
    policyDigest: validated.policyDigest,
    kernelReceiptDigest: validated.receiptHead,
    kernelSnapshotDigest: digest(validated)
  });
}

function sameRuntimeIdentity(
  artifact: StageArtifactEnvelope,
  receipt: SignedStageReceipt,
  runState: DemoRunState
): boolean {
  return (
    artifact.contentDigest === receipt.spec.artifactEnvelopeDigest &&
    artifact.spec.demoProjectId === runState.spec.demoProjectId &&
    artifact.spec.projectProfileDigest === runState.spec.projectProfileDigest &&
    artifact.spec.journeyDefinitionDigest ===
      runState.spec.journeyDefinitionDigest &&
    artifact.spec.stageAgentBindingsDigest ===
      runState.spec.stageAgentBindingsDigest &&
    artifact.spec.authorityEpoch <= runState.spec.authorityEpoch &&
    artifact.spec.generation <= runState.spec.generation &&
    artifact.spec.runId === runState.spec.runId &&
    artifact.spec.runAttempt <= runState.spec.runAttempt &&
    artifact.spec.authorityEpoch === receipt.spec.authorityEpoch &&
    artifact.spec.generation === receipt.spec.generation &&
    artifact.spec.runId === receipt.spec.runId &&
    artifact.spec.runAttempt === receipt.spec.runAttempt
  );
}

function orderFenceChain(
  fences: readonly DemoRunFence[]
): readonly DemoRunFence[] {
  if (fences.length === 0) return [];
  const byPredecessor = new Map<Digest | null, DemoRunFence[]>();
  const digests = new Set<Digest>();
  for (const fence of fences) {
    if (digests.has(fence.contentDigest)) {
      fail("duplicate run-fence evidence is not permitted");
    }
    digests.add(fence.contentDigest);
    const successors = byPredecessor.get(fence.spec.previousFenceDigest) ?? [];
    successors.push(fence);
    byPredecessor.set(fence.spec.previousFenceDigest, successors);
  }
  const ordered: DemoRunFence[] = [];
  let predecessor: Digest | null = null;
  while (ordered.length < fences.length) {
    const successors: DemoRunFence[] =
      byPredecessor.get(predecessor) ?? [];
    if (successors.length !== 1 || successors[0] === undefined) {
      fail("run-fence history is forked, disconnected, or reordered");
    }
    const next: DemoRunFence = successors[0];
    ordered.push(next);
    predecessor = next.contentDigest;
  }
  if ((byPredecessor.get(predecessor) ?? []).length !== 0) {
    fail("run-fence history contains a cycle");
  }
  return immutableSnapshot(ordered);
}

function validateCompletedEvidence(input: {
  readonly runState: DemoRunState;
  readonly contracts: DemoProjectContractSet;
  readonly receipts: readonly SignedStageReceipt[];
  readonly artifacts: readonly StageArtifactEnvelope[];
  readonly fences: readonly DemoRunFence[];
  readonly verifier: SignedStageReceiptVerifier;
}): {
  readonly receipts: readonly SignedStageReceipt[];
  readonly artifacts: readonly StageArtifactEnvelope[];
  readonly pendingArtifact: StageArtifactEnvelope | null;
} {
  const expectedDigests =
    input.runState.spec.journey.completedStageReceiptDigests;
  if (
    input.receipts.length !== expectedDigests.length ||
    input.receipts.length > input.contracts.journey.spec.stages.length ||
    input.receipts.length > MAX_STAGE_EVIDENCE ||
    input.artifacts.length > MAX_STAGE_EVIDENCE ||
    input.fences.length > MAX_STAGE_EVIDENCE
  ) {
    fail("demo stage evidence cardinality is not canonical");
  }
  const artifactsByDigest = new Map(
    input.artifacts.map((artifact) => [artifact.contentDigest, artifact] as const)
  );
  if (artifactsByDigest.size !== input.artifacts.length) {
    fail("duplicate stage artifact evidence is not permitted");
  }
  let previous: Digest | null = null;
  const usedArtifacts = new Set<Digest>();
  input.receipts.forEach((receipt, index) => {
    const current = input.contracts.journey.spec.stages[index];
    const next = input.contracts.journey.spec.stages[index + 1];
    if (
      current === undefined ||
      next === undefined ||
      receipt.contentDigest !== expectedDigests[index] ||
      !input.verifier.verify(receipt) ||
      receipt.spec.demoProjectId !== input.runState.spec.demoProjectId ||
      receipt.spec.projectProfileDigest !==
        input.runState.spec.projectProfileDigest ||
      receipt.spec.journeyDefinitionDigest !==
        input.runState.spec.journeyDefinitionDigest ||
      receipt.spec.stageAgentBindingsDigest !==
        input.runState.spec.stageAgentBindingsDigest ||
      receipt.spec.authorityEpoch > input.runState.spec.authorityEpoch ||
      receipt.spec.generation > input.runState.spec.generation ||
      receipt.spec.runId !== input.runState.spec.runId ||
      receipt.spec.runAttempt > input.runState.spec.runAttempt ||
      receipt.spec.stageId !== current.stageId ||
      receipt.spec.stageOrdinal !== current.ordinal ||
      receipt.spec.nextStageId !== next.stageId ||
      receipt.spec.nextStageOrdinal !== next.ordinal ||
      receipt.spec.previousStageReceiptDigest !== previous
    ) {
      fail("signed stage receipt history is stale, reordered, or substituted");
    }
    const sameCoreState = current.coreState === next.coreState;
    if (
      receipt.spec.coreBefore.state !== current.coreState ||
      receipt.spec.coreAfter.state !== next.coreState ||
      (sameCoreState &&
        (canonicalJson(receipt.spec.coreBefore) !==
          canonicalJson(receipt.spec.coreAfter) ||
          receipt.spec.kernelTransitionReceiptDigest !== null ||
          receipt.spec.appliedKernelResultDigest !== null)) ||
      (!sameCoreState &&
        (receipt.spec.coreBefore.stateVersion === Number.MAX_SAFE_INTEGER ||
          receipt.spec.coreAfter.stateVersion !==
            receipt.spec.coreBefore.stateVersion + 1 ||
          receipt.spec.kernelTransitionReceiptDigest === null ||
          receipt.spec.appliedKernelResultDigest === null ||
          receipt.spec.coreAfter.kernelReceiptDigest !==
            receipt.spec.kernelTransitionReceiptDigest))
    ) {
      fail("signed stage receipt history violates Kernel overlay continuity");
    }
    const artifact = artifactsByDigest.get(receipt.spec.artifactEnvelopeDigest);
    if (
      artifact === undefined ||
      artifact.spec.stageId !== current.stageId ||
      !sameRuntimeIdentity(artifact, receipt, input.runState)
    ) {
      fail("signed stage receipt artifact evidence is incomplete or substituted");
    }
    usedArtifacts.add(artifact.contentDigest);
    if (current.executionKind === "model") {
      const acquired = input.fences.find(
        (fence) => fence.contentDigest === receipt.spec.runFenceDigest
      );
      const released = input.fences.find(
        (fence) => fence.contentDigest === receipt.spec.releasedRunFenceDigest
      );
      if (
        acquired === undefined ||
        released === undefined ||
        acquired.spec.status !== "acquired" ||
        released.spec.status !== "released" ||
        released.spec.previousFenceDigest !== acquired.contentDigest
      ) {
        fail("model stage receipt lacks its acquired and released run fence");
      }
    } else if (
      receipt.spec.runFenceDigest !== null ||
      receipt.spec.releasedRunFenceDigest !== null
    ) {
      fail("non-model stage receipt cannot carry run-fence evidence");
    }
    previous = receipt.contentDigest;
  });

  const pending = input.artifacts.filter(
    (artifact) => !usedArtifacts.has(artifact.contentDigest)
  );
  if (pending.length > 1) {
    fail("more than one incomplete stage artifact requires reconciliation");
  }
  const pendingArtifact = pending[0] ?? null;
  const current =
    input.contracts.journey.spec.stages[
      input.runState.spec.journey.currentStageOrdinal - 1
    ];
  if (
    pendingArtifact !== null &&
    (current === undefined ||
      pendingArtifact.spec.stageId !== current.stageId ||
      pendingArtifact.spec.demoProjectId !== input.runState.spec.demoProjectId ||
      pendingArtifact.spec.projectProfileDigest !==
        input.runState.spec.projectProfileDigest ||
      pendingArtifact.spec.journeyDefinitionDigest !==
        input.runState.spec.journeyDefinitionDigest ||
      pendingArtifact.spec.stageAgentBindingsDigest !==
        input.runState.spec.stageAgentBindingsDigest ||
      pendingArtifact.spec.authorityEpoch !== input.runState.spec.authorityEpoch ||
      pendingArtifact.spec.generation !== input.runState.spec.generation ||
      pendingArtifact.spec.runId !== input.runState.spec.runId ||
      pendingArtifact.spec.runAttempt !== input.runState.spec.runAttempt)
  ) {
    fail("pending stage artifact is delayed, cross-demo, or superseded");
  }
  return immutableSnapshot({
    receipts: input.receipts,
    artifacts: input.artifacts,
    pendingArtifact
  });
}

function activationStatus(input: {
  readonly now: number;
  readonly runState: DemoRunState;
  readonly lease: ActivationLease;
  readonly budget: DemoBudgetState;
  readonly contracts: DemoProjectContractSet;
}): {
  readonly ready: boolean;
  readonly reason: DemoRuntimeReconstruction["activationReason"];
} {
  const profile = input.contracts.activation;
  if (!profile.spec.enabled) return { ready: false, reason: "PROFILE_DISABLED" };
  if (
    profile.spec.authorityEpoch !== input.runState.spec.authorityEpoch ||
    input.budget.spec.authorityEpoch !== input.runState.spec.authorityEpoch ||
    input.budget.spec.generation !== input.runState.spec.generation
  ) {
    return { ready: false, reason: "EPOCH_STALE" };
  }
  if (input.lease.revoked) return { ready: false, reason: "LEASE_REVOKED" };
  if (
    input.now < Date.parse(profile.spec.validFrom) ||
    input.now >= Date.parse(profile.spec.expiresAt) ||
    input.now >= Date.parse(input.lease.expiresAt) ||
    input.now >= Date.parse(input.budget.spec.expiresAt)
  ) {
    return { ready: false, reason: "LEASE_EXPIRED" };
  }
  const modelCapabilities = input.contracts.bindings.spec.stageBindings.flatMap(
    (entry) => entry.runtimeBindings.map((binding) => binding.capability)
  );
  const activePhases = [
    "execution",
    "framing",
    "human-review",
    "planning",
    "verification"
  ] as const;
  if (
    input.lease.maxCalls !== profile.spec.leaseTemplate.maxCalls ||
    input.lease.maxTokens !== profile.spec.leaseTemplate.maxTokens ||
    input.lease.maxCostUnits !== profile.spec.leaseTemplate.maxCostUnits ||
    input.lease.maxParallel !== profile.spec.leaseTemplate.maxParallel ||
    canonicalJson([...input.lease.allowedCapabilities].sort()) !==
      canonicalJson([...modelCapabilities].sort()) ||
    canonicalJson([...input.lease.allowedPhases].sort()) !==
      canonicalJson(activePhases)
  ) {
    return { ready: false, reason: "LEASE_INVALID" };
  }
  return { ready: true, reason: "AUTHORIZED" };
}

function projectionField(
  projection: DemoProjectionState,
  key: DemoProjectionFieldKey
): string | null {
  return projection.spec.fields.find((field) => field.key === key)?.value ?? null;
}

export function reconstructDemoRuntime(input: {
  readonly authority: DemoRuntimeAuthority;
  readonly runState: unknown;
  readonly kernelSnapshot: unknown;
  readonly activationLease: unknown;
  readonly budget: unknown;
  readonly projection: unknown;
  readonly completedReceipts: readonly unknown[];
  readonly artifacts: readonly unknown[];
  readonly fences: readonly unknown[];
  readonly receiptVerifier: SignedStageReceiptVerifier;
  readonly agentSelection?: StageAgentSelectionResolution;
  readonly evaluatedAt: string;
}): DemoRuntimeReconstruction {
  const evaluatedAt = canonicalTime(input.evaluatedAt, "evaluatedAt");
  const contracts = validateDemoProjectContractSet({
    catalog: input.authority.catalog,
    reservations: input.authority.reservations,
    lifecycle: input.authority.lifecycle,
    baseRegistry: input.authority.baseRegistry,
    contracts: input.authority.contracts
  });
  const catalog = validateDemoContract(
    "DemoCatalog",
    input.authority.catalog
  );
  const reservations = validateDemoContract(
    "DemoIdentityReservationManifest",
    input.authority.reservations
  );
  const workAccord = immutableSnapshot(
    assertDocument("WorkAccord", input.authority.workAccord)
  );
  const runState = validateDemoContract("DemoRunState", input.runState);
  const kernelSnapshot = immutableSnapshot(
    assertDocument("KernelSnapshot", input.kernelSnapshot)
  );
  const activationLease = immutableSnapshot(
    assertDocument("ActivationLease", input.activationLease)
  );
  const budget = validateDemoBudgetState(input.budget);
  const projection = validateDemoProjectionState(input.projection);
  const receipts = input.completedReceipts.map((value) =>
    validateDemoContract("SignedStageReceipt", value)
  );
  const artifacts = input.artifacts.map((value) =>
    validateDemoContract("StageArtifactEnvelope", value)
  );
  const fences = orderFenceChain(
    input.fences.map((value) =>
      validateDemoContract("DemoRunFence", value)
    )
  );
  const expectedCore = demoCoreBindingFromSnapshot(kernelSnapshot);
  if (
    runState.spec.demoProjectId !== contracts.profile.spec.demoProjectId ||
    runState.spec.catalogDigest !== catalog.contentDigest ||
    runState.spec.identityReservationsDigest !== reservations.contentDigest ||
    runState.spec.projectProfileDigest !== contracts.profile.contentDigest ||
    runState.spec.journeyDefinitionDigest !== contracts.journey.contentDigest ||
    runState.spec.stageAgentBindingsDigest !== contracts.bindings.contentDigest ||
    runState.spec.capabilityShardDigest !==
      contracts.capabilities.contentDigest ||
    runState.spec.activationProfileDigest !==
      contracts.activation.contentDigest ||
    runState.spec.projectionMappingDigest !== contracts.projection.contentDigest ||
    runState.spec.repositoryBindingDigest !==
      contracts.profile.spec.repositoryBindingDigest ||
    canonicalJson(runState.spec.core) !== canonicalJson(expectedCore) ||
    workAccord.binding.repositoryId !== runState.spec.repositoryId ||
    workAccord.binding.workItemNodeId !== runState.spec.workItemNodeId ||
    digest(workAccord) !== kernelSnapshot.workAccordDigest ||
    workAccordBindingDigest(workAccord) !== kernelSnapshot.bindingDigest
  ) {
    fail("DemoRunState does not reconstruct from the authoritative Kernel and contracts");
  }
  if (
    digest(activationLease) !== budget.spec.activationLeaseDigest ||
    activationLease.workAccordDigest !== digest(workAccord) ||
    budget.spec.workAccordDigest !== digest(workAccord) ||
    budget.spec.demoProjectId !== runState.spec.demoProjectId ||
    budget.spec.repositoryId !== runState.spec.repositoryId ||
    budget.spec.workItemNodeId !== runState.spec.workItemNodeId ||
    canonicalJson(budget.spec.limits) !==
      canonicalJson(contracts.activation.spec.leaseTemplate) ||
    budget.spec.usage.calls < kernelSnapshot.usage.calls ||
    budget.spec.usage.tokens < kernelSnapshot.usage.tokens ||
    budget.spec.usage.costUnits < kernelSnapshot.usage.costUnits ||
    budget.spec.usage.retries < kernelSnapshot.usage.retries
  ) {
    fail("DemoBudgetState does not match the Kernel, lease, and activation profile");
  }
  if (
    projection.spec.demoProjectId !== runState.spec.demoProjectId ||
    projection.spec.repositoryId !== runState.spec.repositoryId ||
    projection.spec.workItemNodeId !== runState.spec.workItemNodeId ||
    projection.spec.projectBindingDigest !==
      contracts.profile.spec.projectBindingDigest
  ) {
    fail("DemoProjectionState is bound to a different trusted Project item");
  }
  for (const fence of fences) {
    if (
      fence.spec.demoProjectId !== runState.spec.demoProjectId ||
      fence.spec.repositoryId !== runState.spec.repositoryId ||
      fence.spec.workItemNodeId !== runState.spec.workItemNodeId ||
      fence.spec.runId !== runState.spec.runId ||
      fence.spec.authorityEpoch > runState.spec.authorityEpoch ||
      fence.spec.generation > runState.spec.generation
    ) {
      fail("run fence is cross-demo, delayed, or superseded");
    }
  }
  const evidence = validateCompletedEvidence({
    runState,
    contracts,
    receipts,
    artifacts,
    fences,
    verifier: input.receiptVerifier
  });
  const currentStage =
    contracts.journey.spec.stages[
      runState.spec.journey.completedStageReceiptDigests.length
    ];
  if (
    currentStage === undefined ||
    currentStage.stageId !== runState.spec.journey.currentStageId ||
    currentStage.ordinal !== runState.spec.journey.currentStageOrdinal
  ) {
    fail("DemoRunState does not identify the first incomplete canonical stage");
  }
  const nextStage =
    contracts.journey.spec.stages[currentStage.ordinal] ?? null;
  const reconciliation = new Set<DemoRuntimeReconciliationCode>();
  if (
    !["CAPTURED", "PAUSED", "BLOCKED", "CANCELLED"].includes(
      kernelSnapshot.state
    ) &&
    currentStage.coreState !== kernelSnapshot.state
  ) {
    reconciliation.add("KERNEL_CURSOR_MISMATCH");
  }
  if (projection.spec.kernelStateVersion > kernelSnapshot.stateVersion) {
    reconciliation.add("PROJECTION_AHEAD");
  } else if (
    projection.spec.kernelStateVersion === kernelSnapshot.stateVersion &&
    projection.spec.kernelReceiptDigest !== kernelSnapshot.receiptHead
  ) {
    reconciliation.add("PROJECTION_DIVERGED");
  }
  const projectedStageReceipt = projection.spec.stageReceiptDigest;
  if (
    projectedStageReceipt !== null &&
    !runState.spec.journey.completedStageReceiptDigests.includes(
      projectedStageReceipt
    )
  ) {
    reconciliation.add("PROJECTION_DIVERGED");
  }
  const activeFence =
    runState.spec.fenceDigest === null
      ? null
      : fences.find(
          (candidate) =>
            candidate.contentDigest === runState.spec.fenceDigest &&
            candidate.spec.status === "acquired"
        ) ?? null;
  if (
    (runState.spec.status === "running" && activeFence === null) ||
    (runState.spec.status !== "running" && activeFence !== null)
  ) {
    reconciliation.add("UNRESOLVED_FENCE");
  }
  if (
    projectedDemoStageLeadsKernel(
      projectionField(projection, "stage"),
      kernelSnapshot.state
    )
  ) {
    reconciliation.add("PROJECTION_AHEAD");
  }
  if (
    projectionField(projection, "stage") !== null &&
    projection.spec.kernelStateVersion === kernelSnapshot.stateVersion &&
    projectionField(projection, "stage") !== kernelSnapshot.state
  ) {
    reconciliation.add("PROJECTION_DIVERGED");
  }
  const activation = activationStatus({
    now: evaluatedAt,
    runState,
    lease: activationLease,
    budget,
    contracts
  });
  return immutableSnapshot({
    authority: {
      catalog,
      reservations,
      contracts,
      lifecycle: input.authority.lifecycle,
      baseRegistry: input.authority.baseRegistry,
      workAccord
    },
    runState,
    kernelSnapshot,
    activationLease,
    budget,
    projection,
    completedReceipts: evidence.receipts,
    artifacts: evidence.artifacts,
    fences,
    pendingArtifact: evidence.pendingArtifact,
    currentStage,
    nextStage,
    activationReady: activation.ready,
    activationReason: activation.reason,
    agentSelection: input.agentSelection ?? null,
    reconciliation: [...reconciliation].sort()
  });
}
