import { canonicalJson, digest } from "./canonical.js";
import {
  assertDemoModelOutputHasNoControlFields,
  createDemoContract,
  validateDemoContract
} from "./demo-portfolio.js";
import {
  validateDemoActivationGrant,
  type DemoActivationClaimReceipt,
  type DemoActivationGrant,
  type DemoEvidenceVerifier
} from "./demo-activation.js";
import {
  validatePersistedDemoDispatch,
  type DemoDispatchPersistenceReceipt
} from "./demo-dispatcher.js";
import {
  createDemoBudgetState,
  demoBudgetAuthorityDigest,
  demoWorkflowConcurrencyKey,
  validateDemoBudgetState,
  type DemoBudgetState,
  type DemoRuntimeReconstruction
} from "./demo-runtime-state.js";
import type {
  DemoDecisionRuntimeBinding,
  DemoRuntimeRefusal,
  DemoRunFence,
  DemoRunState,
  DemoScheduleDecision,
  DemoSignature,
  StageArtifactEnvelope
} from "./demo-types.js";
import type { Capability, Digest, PhaseContract } from "./types.js";
import { isCanonicalUtcDateTime } from "./validation.js";
import {
  validateSignedStageAgentSelectionGrant
} from "./demo-agent-selection.js";
import type { SignedStageAgentSelectionGrant } from "./demo-types.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/u;

export interface DemoFenceStoreSnapshot {
  readonly fence: DemoRunFence;
  readonly runState: DemoRunState;
}

export interface DemoRunFenceStore {
  readonly supportsAtomicCompareAndSwap: true;
  acquire(input: {
    readonly expectedRunStateDigest: Digest;
    readonly fence: DemoRunFence;
    readonly runningState: DemoRunState;
  }): Promise<{
    readonly status: "appended" | "existing" | "conflict";
    readonly snapshot: DemoFenceStoreSnapshot | null;
  }>;
  release(input: {
    readonly expectedFenceDigest: Digest;
    readonly releasedFence: DemoRunFence;
    readonly runningState: DemoRunState;
  }): Promise<{
    readonly status: "appended" | "existing" | "conflict";
    readonly snapshot: DemoFenceStoreSnapshot | null;
  }>;
  read(fenceKey: Digest): Promise<DemoFenceStoreSnapshot | null>;
}

export interface DemoBudgetReservationEvidence {
  readonly schemaVersion: "1.0.0";
  readonly reservationKey: Digest;
  readonly budgetBeforeDigest: Digest;
  readonly budgetAfterDigest: Digest;
  readonly dispatchDecisionDigest: Digest;
  readonly stageId: string;
  readonly runtimeBinding: DemoDecisionRuntimeBinding;
  readonly calls: 1;
  readonly tokens: number;
  readonly costUnits: number;
  readonly reservedAt: string;
  readonly expiresAt: string;
  readonly signature: DemoSignature;
}

export interface DemoBudgetSettlementEvidence {
  readonly schemaVersion: "1.0.0";
  readonly reservationDigest: Digest;
  readonly usageDigest: Digest;
  readonly budgetBeforeDigest: Digest;
  readonly budgetAfterDigest: Digest;
  readonly calls: 1;
  readonly tokens: number;
  readonly costUnits: number;
  readonly settledAt: string;
  readonly signature: DemoSignature;
}

export interface DemoBudgetLedger {
  reserve(input: {
    readonly expected: DemoBudgetState;
    readonly next: DemoBudgetState;
    readonly evidence: Omit<DemoBudgetReservationEvidence, "signature">;
  }): Promise<{
    readonly status: "appended" | "existing" | "conflict";
    readonly budget: DemoBudgetState | null;
    readonly evidence: DemoBudgetReservationEvidence | null;
  }>;
  settle(input: {
    readonly expected: DemoBudgetState;
    readonly next: DemoBudgetState;
    readonly evidence: Omit<DemoBudgetSettlementEvidence, "signature">;
  }): Promise<{
    readonly status: "appended" | "existing" | "conflict";
    readonly budget: DemoBudgetState | null;
    readonly evidence: DemoBudgetSettlementEvidence | null;
  }>;
  read(): Promise<DemoBudgetState>;
}

export interface DemoProviderAttemptEvidence {
  readonly schemaVersion: "1.0.0";
  readonly attemptKey: Digest;
  readonly reservationDigest: Digest;
  readonly fenceDigest: Digest;
  readonly demoProjectId: DemoRunState["spec"]["demoProjectId"];
  readonly repositoryId: number;
  readonly workItemNodeId: string;
  readonly authorityEpoch: number;
  readonly generation: number;
  readonly runId: string;
  readonly runAttempt: number;
  readonly stageId: string;
  readonly runtimeBinding: DemoDecisionRuntimeBinding;
  readonly startedAt: string;
  readonly expiresAt: string;
  readonly signature: DemoSignature;
}

export interface DemoProviderUsageEvidence {
  readonly schemaVersion: "1.0.0";
  readonly attemptDigest: Digest;
  readonly status: "settled" | "unknown";
  readonly calls: 1 | null;
  readonly tokens: number | null;
  readonly costUnits: number | null;
  readonly providerUsageDigest: Digest | null;
  readonly observedAt: string;
  readonly signature: DemoSignature;
}

export interface DemoProviderUsageLedger {
  begin(
    attempt: Omit<DemoProviderAttemptEvidence, "signature">
  ): Promise<DemoProviderAttemptEvidence>;
  reconcile(
    attempt: DemoProviderAttemptEvidence
  ): Promise<DemoProviderUsageEvidence>;
}

export interface DemoStageInvocationPort {
  invoke(input: {
    readonly stageId: string;
    readonly stageOrdinal: number;
    readonly runtimeBinding: DemoDecisionRuntimeBinding;
    readonly capability: Capability;
    readonly runStateDigest: Digest;
    readonly dispatchDecisionDigest: Digest;
    readonly fenceDigest: Digest;
    readonly budgetReservationDigest: Digest;
    readonly providerAttemptDigest: Digest;
    readonly deadline: string;
  }): Promise<{
    readonly artifact: StageArtifactEnvelope;
    readonly output: unknown;
  }>;
}

export interface DemoSchedulerClock {
  now(): string;
}

export type DemoScheduleResult =
  | {
      readonly kind: "scheduled";
      readonly decision: DemoScheduleDecision;
      readonly refusal: DemoRuntimeRefusal | null;
    }
  | {
      readonly kind: "invoked";
      readonly decision: DemoScheduleDecision;
      readonly acquiredFence: DemoRunFence;
      readonly releasedFence: DemoRunFence;
      readonly runningState: DemoRunState;
      readonly artifact: StageArtifactEnvelope;
      readonly output: unknown;
      readonly usage: DemoProviderUsageEvidence;
      readonly budget: DemoBudgetState;
    }
  | {
      readonly kind: "provider-failed";
      readonly decision: DemoScheduleDecision;
      readonly acquiredFence: DemoRunFence;
      readonly releasedFence: DemoRunFence | null;
      readonly runningState: DemoRunState;
      readonly usage: DemoProviderUsageEvidence | null;
      readonly budget: DemoBudgetState;
      readonly failureDigest: Digest;
    }
  | {
      readonly kind: "reconciliation-required";
      readonly decision: DemoScheduleDecision;
      readonly acquiredFence: DemoRunFence | null;
      readonly runningState: DemoRunState | null;
      readonly budget: DemoBudgetState;
      readonly reason:
        | "FENCE_CONFLICT"
        | "FENCE_ACKNOWLEDGEMENT_AMBIGUOUS"
        | "BUDGET_CONFLICT"
        | "BUDGET_ACKNOWLEDGEMENT_AMBIGUOUS"
        | "USAGE_UNKNOWN"
        | "SETTLEMENT_CONFLICT"
        | "SETTLEMENT_ACKNOWLEDGEMENT_AMBIGUOUS"
        | "FENCE_RELEASE_CONFLICT";
    };

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

function stable<T>(value: T): T {
  return deepFreeze(JSON.parse(canonicalJson(value)) as T);
}

function timestamp(value: string, label: string): number {
  if (!isCanonicalUtcDateTime(value)) {
    fail(`${label} must be a canonical UTC timestamp`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail(`${label} must be a real timestamp`);
  return parsed;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  label: string
): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (
    actual.length !== required.length ||
    actual.some((key, index) => key !== required[index])
  ) {
    fail(`${label} fields are not closed`);
  }
}

function safeAdd(left: number, right: number, label: string): number {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`${label} overflowed`);
  }
  return value;
}

function safeSubtract(left: number, right: number, label: string): number {
  const value = left - right;
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`${label} underflowed`);
  }
  return value;
}

function fullCapability(capability: Capability): string {
  return `${capability.id}@${capability.version}`;
}

function refusalResult(input: {
  readonly reconstruction: DemoRuntimeReconstruction;
  readonly dispatchDecisionDigest: Digest;
  readonly dispatchPersistenceReceiptDigest: Digest;
  readonly decidedAt: string;
  readonly code: DemoRuntimeRefusal["spec"]["code"];
  readonly ruleId: string;
  readonly message: string;
  readonly recovery: DemoRuntimeRefusal["spec"]["recovery"];
}): DemoScheduleResult {
  const refusal = createDemoContract("DemoRuntimeRefusal", {
    demoProjectId: input.reconstruction.runState.spec.demoProjectId,
    stageId: input.reconstruction.currentStage.stageId,
    inputDigest: digest({
      dispatchDecisionDigest: input.dispatchDecisionDigest,
      runStateDigest: input.reconstruction.runState.contentDigest,
      budgetDigest: input.reconstruction.budget.contentDigest
    }),
    code: input.code,
    ruleId: input.ruleId,
    message: input.message,
    retryable: false,
    recovery: input.recovery,
    refusedAt: input.decidedAt
  });
  return {
    kind: "scheduled",
    refusal,
    decision: createDemoContract("DemoScheduleDecision", {
      demoProjectId: input.reconstruction.runState.spec.demoProjectId,
      runStateDigest: input.reconstruction.runState.contentDigest,
      dispatchDecisionDigest: input.dispatchDecisionDigest,
      dispatchPersistenceReceiptDigest:
        input.dispatchPersistenceReceiptDigest,
      stageId: input.reconstruction.currentStage.stageId,
      action: "refuse",
      runtimeBinding: null,
      runFenceDigest: null,
      budgetReservation: null,
      refusalDigest: refusal.contentDigest,
      decidedAt: input.decidedAt
    })
  };
}

function nonInvocationSchedule(input: {
  readonly reconstruction: DemoRuntimeReconstruction;
  readonly dispatchDecisionDigest: Digest;
  readonly dispatchPersistenceReceiptDigest: Digest;
  readonly decidedAt: string;
  readonly action: Exclude<
    DemoScheduleDecision["spec"]["action"],
    "reserve-and-invoke" | "refuse"
  >;
}): DemoScheduleResult {
  return {
    kind: "scheduled",
    refusal: null,
    decision: createDemoContract("DemoScheduleDecision", {
      demoProjectId: input.reconstruction.runState.spec.demoProjectId,
      runStateDigest: input.reconstruction.runState.contentDigest,
      dispatchDecisionDigest: input.dispatchDecisionDigest,
      dispatchPersistenceReceiptDigest:
        input.dispatchPersistenceReceiptDigest,
      stageId: input.reconstruction.currentStage.stageId,
      action: input.action,
      runtimeBinding: null,
      runFenceDigest: null,
      budgetReservation: null,
      refusalDigest: null,
      decidedAt: input.decidedAt
    })
  };
}

function exactBinding(input: {
  readonly reconstruction: DemoRuntimeReconstruction;
  readonly runtimeBinding: DemoDecisionRuntimeBinding;
}): {
  readonly runtimeBinding: DemoDecisionRuntimeBinding;
  readonly capability: Capability;
} {
  const entry =
    input.reconstruction.authority.contracts.bindings.spec.stageBindings[
      input.reconstruction.currentStage.ordinal - 1
    ];
  const matchingBindings =
    entry?.runtimeBindings.filter(
      (binding) =>
        binding.agent === input.runtimeBinding.agentId &&
        binding.capability === input.runtimeBinding.capabilityId &&
        binding.workflow === input.runtimeBinding.workflowId
    ) ?? [];
  const binding = matchingBindings[0];
  const capability =
    input.reconstruction.authority.contracts.capabilities.spec.capabilities.find(
      (candidate) =>
        fullCapability(candidate) === input.runtimeBinding.capabilityId
    );
  if (
    entry?.stageId !== input.reconstruction.currentStage.stageId ||
    entry.executionKind !== "model" ||
    matchingBindings.length !== 1 ||
    binding === undefined ||
    binding.agent !== input.runtimeBinding.agentId ||
    binding.capability !== input.runtimeBinding.capabilityId ||
    binding.workflow !== input.runtimeBinding.workflowId ||
    capability === undefined ||
    capability.status !== "active" ||
    capability.implementation.kind !== "model" ||
    capability.limits.maxCostUnits < 1 ||
    !capability.allowedPhases.includes(binding.phase)
  ) {
    fail("global stage-agent binding changed before inference");
  }
  return { runtimeBinding: stable(input.runtimeBinding), capability };
}

function latestFenceDigest(
  reconstruction: DemoRuntimeReconstruction
): Digest | null {
  return reconstruction.fences.at(-1)?.contentDigest ?? null;
}

function proposedFence(input: {
  readonly reconstruction: DemoRuntimeReconstruction;
  readonly dispatchDecisionDigest: Digest;
  readonly activationLeaseDigest: Digest;
  readonly holderDigest: Digest;
  readonly now: string;
  readonly expiresAt: string;
}): DemoRunFence {
  return createDemoContract("DemoRunFence", {
    demoProjectId: input.reconstruction.runState.spec.demoProjectId,
    repositoryId: input.reconstruction.runState.spec.repositoryId,
    workItemNodeId: input.reconstruction.runState.spec.workItemNodeId,
    fenceKey: digest({
      repositoryId: input.reconstruction.runState.spec.repositoryId,
      workItemNodeId: input.reconstruction.runState.spec.workItemNodeId
    }),
    authorityEpoch: input.reconstruction.runState.spec.authorityEpoch,
    generation: input.reconstruction.runState.spec.generation,
    runId: input.reconstruction.runState.spec.runId,
    runAttempt: input.reconstruction.runState.spec.runAttempt,
    runStateDigest: input.reconstruction.runState.contentDigest,
    dispatchDecisionDigest: input.dispatchDecisionDigest,
    holderDigest: input.holderDigest,
    activationLeaseDigest: input.activationLeaseDigest,
    previousFenceDigest: latestFenceDigest(input.reconstruction),
    status: "acquired",
    acquiredAt: input.now,
    expiresAt: input.expiresAt,
    releasedAt: null
  });
}

function validateAcquiredSnapshot(input: {
  readonly snapshot: DemoFenceStoreSnapshot;
  readonly expectedFence: DemoRunFence;
  readonly expectedRunningState: DemoRunState;
}): DemoFenceStoreSnapshot {
  const fence = validateDemoContract("DemoRunFence", input.snapshot.fence);
  const runState = validateDemoContract(
    "DemoRunState",
    input.snapshot.runState
  );
  if (
    canonicalJson(fence) !== canonicalJson(input.expectedFence) ||
    canonicalJson(runState) !== canonicalJson(input.expectedRunningState)
  ) {
    fail("durable fence store did not persist the exact atomic claim");
  }
  return stable({ fence, runState });
}

function reservationPayload(
  evidence: DemoBudgetReservationEvidence
): Omit<DemoBudgetReservationEvidence, "signature"> {
  const { signature: _signature, ...payload } = evidence;
  return payload;
}

function settlementPayload(
  evidence: DemoBudgetSettlementEvidence
): Omit<DemoBudgetSettlementEvidence, "signature"> {
  const { signature: _signature, ...payload } = evidence;
  return payload;
}

function attemptPayload(
  evidence: DemoProviderAttemptEvidence
): Omit<DemoProviderAttemptEvidence, "signature"> {
  const { signature: _signature, ...payload } = evidence;
  return payload;
}

function usagePayload(
  evidence: DemoProviderUsageEvidence
): Omit<DemoProviderUsageEvidence, "signature"> {
  const { signature: _signature, ...payload } = evidence;
  return payload;
}

function validateReservation(input: {
  readonly evidence: DemoBudgetReservationEvidence;
  readonly before: DemoBudgetState;
  readonly after: DemoBudgetState;
  readonly dispatchDecisionDigest: Digest;
  readonly binding: DemoDecisionRuntimeBinding;
  readonly stageId: string;
  readonly verifier: DemoEvidenceVerifier;
}): DemoBudgetReservationEvidence {
  const evidence = stable(input.evidence);
  exactKeys(
    evidence as unknown as Readonly<Record<string, unknown>>,
    [
      "schemaVersion",
      "reservationKey",
      "budgetBeforeDigest",
      "budgetAfterDigest",
      "dispatchDecisionDigest",
      "stageId",
      "runtimeBinding",
      "calls",
      "tokens",
      "costUnits",
      "reservedAt",
      "expiresAt",
      "signature"
    ],
    "DemoBudgetReservationEvidence"
  );
  exactKeys(
    evidence.runtimeBinding as unknown as Readonly<Record<string, unknown>>,
    ["agentId", "capabilityId", "workflowId"],
    "DemoBudgetReservationEvidence runtime binding"
  );
  timestamp(evidence.reservedAt, "reservation reservedAt");
  timestamp(evidence.expiresAt, "reservation expiresAt");
  if (
    evidence.schemaVersion !== "1.0.0" ||
    evidence.reservationKey !==
      digest({
        operation: "reserve-demo-stage-cost",
        budgetStateDigest: input.before.contentDigest,
        dispatchDecisionDigest: input.dispatchDecisionDigest,
        stageId: input.stageId,
        runtimeBinding: input.binding
      }) ||
    evidence.budgetBeforeDigest !== input.before.contentDigest ||
    evidence.budgetAfterDigest !== input.after.contentDigest ||
    evidence.dispatchDecisionDigest !== input.dispatchDecisionDigest ||
    evidence.stageId !== input.stageId ||
    canonicalJson(evidence.runtimeBinding) !== canonicalJson(input.binding) ||
    evidence.calls !== 1 ||
    !Number.isSafeInteger(evidence.tokens) ||
    evidence.tokens < 0 ||
    !Number.isSafeInteger(evidence.costUnits) ||
    evidence.costUnits < 0 ||
    evidence.expiresAt !== input.after.spec.expiresAt ||
    !input.verifier.verify(reservationPayload(evidence), evidence.signature)
  ) {
    fail("budget reservation evidence is unsigned, substituted, or malformed");
  }
  return evidence;
}

function validateAttempt(input: {
  readonly attempt: DemoProviderAttemptEvidence;
  readonly reservation: DemoBudgetReservationEvidence;
  readonly fence: DemoRunFence;
  readonly reconstruction: DemoRuntimeReconstruction;
  readonly binding: DemoDecisionRuntimeBinding;
  readonly verifier: DemoEvidenceVerifier;
}): DemoProviderAttemptEvidence {
  const attempt = stable(input.attempt);
  exactKeys(
    attempt as unknown as Readonly<Record<string, unknown>>,
    [
      "schemaVersion",
      "attemptKey",
      "reservationDigest",
      "fenceDigest",
      "demoProjectId",
      "repositoryId",
      "workItemNodeId",
      "authorityEpoch",
      "generation",
      "runId",
      "runAttempt",
      "stageId",
      "runtimeBinding",
      "startedAt",
      "expiresAt",
      "signature"
    ],
    "DemoProviderAttemptEvidence"
  );
  exactKeys(
    attempt.runtimeBinding as unknown as Readonly<Record<string, unknown>>,
    ["agentId", "capabilityId", "workflowId"],
    "DemoProviderAttemptEvidence runtime binding"
  );
  timestamp(attempt.startedAt, "provider attempt startedAt");
  timestamp(attempt.expiresAt, "provider attempt expiresAt");
  if (
    attempt.schemaVersion !== "1.0.0" ||
    attempt.attemptKey !==
      digest({
        operation: "invoke-demo-stage",
        reservationDigest: digest(input.reservation),
        fenceDigest: input.fence.contentDigest,
        runId: input.reconstruction.runState.spec.runId,
        runAttempt: input.reconstruction.runState.spec.runAttempt,
        stageId: input.reconstruction.currentStage.stageId
      }) ||
    attempt.reservationDigest !== digest(input.reservation) ||
    attempt.fenceDigest !== input.fence.contentDigest ||
    attempt.demoProjectId !==
      input.reconstruction.runState.spec.demoProjectId ||
    attempt.repositoryId !==
      input.reconstruction.runState.spec.repositoryId ||
    attempt.workItemNodeId !==
      input.reconstruction.runState.spec.workItemNodeId ||
    attempt.authorityEpoch !==
      input.reconstruction.runState.spec.authorityEpoch ||
    attempt.generation !== input.reconstruction.runState.spec.generation ||
    attempt.runId !== input.reconstruction.runState.spec.runId ||
    attempt.runAttempt !== input.reconstruction.runState.spec.runAttempt ||
    attempt.stageId !== input.reconstruction.currentStage.stageId ||
    canonicalJson(attempt.runtimeBinding) !== canonicalJson(input.binding) ||
    !input.verifier.verify(attemptPayload(attempt), attempt.signature)
  ) {
    fail("provider attempt is unsigned, stale, or bound to another stage");
  }
  return attempt;
}

function validateUsage(input: {
  readonly usage: DemoProviderUsageEvidence;
  readonly attempt: DemoProviderAttemptEvidence;
  readonly reservation: DemoBudgetReservationEvidence;
  readonly verifier: DemoEvidenceVerifier;
}): DemoProviderUsageEvidence {
  const usage = stable(input.usage);
  exactKeys(
    usage as unknown as Readonly<Record<string, unknown>>,
    [
      "schemaVersion",
      "attemptDigest",
      "status",
      "calls",
      "tokens",
      "costUnits",
      "providerUsageDigest",
      "observedAt",
      "signature"
    ],
    "DemoProviderUsageEvidence"
  );
  timestamp(usage.observedAt, "provider usage observedAt");
  const settled = usage.status === "settled";
  if (
    usage.schemaVersion !== "1.0.0" ||
    usage.attemptDigest !== digest(input.attempt) ||
    (settled &&
      (usage.calls !== 1 ||
        usage.tokens === null ||
        !Number.isSafeInteger(usage.tokens) ||
        usage.tokens < 0 ||
        usage.tokens > input.reservation.tokens ||
        usage.costUnits === null ||
        !Number.isSafeInteger(usage.costUnits) ||
        usage.costUnits < 0 ||
        usage.costUnits > input.reservation.costUnits ||
        usage.providerUsageDigest === null ||
        !DIGEST.test(usage.providerUsageDigest))) ||
    (!settled &&
      (usage.calls !== null ||
        usage.tokens !== null ||
        usage.costUnits !== null ||
        usage.providerUsageDigest !== null)) ||
    !input.verifier.verify(usagePayload(usage), usage.signature)
  ) {
    fail("provider usage is unauthenticated, underreported, or over budget");
  }
  return usage;
}

function validateSettlement(input: {
  readonly evidence: DemoBudgetSettlementEvidence;
  readonly before: DemoBudgetState;
  readonly after: DemoBudgetState;
  readonly reservation: DemoBudgetReservationEvidence;
  readonly usage: DemoProviderUsageEvidence;
  readonly verifier: DemoEvidenceVerifier;
}): DemoBudgetSettlementEvidence {
  const evidence = stable(input.evidence);
  exactKeys(
    evidence as unknown as Readonly<Record<string, unknown>>,
    [
      "schemaVersion",
      "reservationDigest",
      "usageDigest",
      "budgetBeforeDigest",
      "budgetAfterDigest",
      "calls",
      "tokens",
      "costUnits",
      "settledAt",
      "signature"
    ],
    "DemoBudgetSettlementEvidence"
  );
  timestamp(evidence.settledAt, "budget settledAt");
  if (
    input.usage.status !== "settled" ||
    input.usage.calls !== 1 ||
    input.usage.tokens === null ||
    input.usage.costUnits === null ||
    evidence.schemaVersion !== "1.0.0" ||
    evidence.reservationDigest !== digest(input.reservation) ||
    evidence.usageDigest !== digest(input.usage) ||
    evidence.budgetBeforeDigest !== input.before.contentDigest ||
    evidence.budgetAfterDigest !== input.after.contentDigest ||
    evidence.calls !== input.usage.calls ||
    evidence.tokens !== input.usage.tokens ||
    evidence.costUnits !== input.usage.costUnits ||
    !input.verifier.verify(settlementPayload(evidence), evidence.signature)
  ) {
    fail("budget settlement evidence is unsigned or does not match provider usage");
  }
  return evidence;
}

function nextBudgetForReservation(input: {
  readonly current: DemoBudgetState;
  readonly calls: 1;
  readonly tokens: number;
  readonly costUnits: number;
  readonly operationDigest: Digest;
}): DemoBudgetState {
  return createDemoBudgetState({
    ...input.current.spec,
    held: {
      calls: safeAdd(input.current.spec.held.calls, input.calls, "held calls"),
      tokens: safeAdd(
        input.current.spec.held.tokens,
        input.tokens,
        "held tokens"
      ),
      costUnits: safeAdd(
        input.current.spec.held.costUnits,
        input.costUnits,
        "held cost"
      )
    },
    ledgerVersion: safeAdd(
      input.current.spec.ledgerVersion,
      1,
      "budget ledger version"
    ),
    ledgerHead: digest({
      domain: "agentic-framework.demo-budget-ledger.v1",
      previousHead: input.current.spec.ledgerHead,
      operationDigest: input.operationDigest
    })
  });
}

function nextBudgetForSettlement(input: {
  readonly current: DemoBudgetState;
  readonly reservation: DemoBudgetReservationEvidence;
  readonly usage: DemoProviderUsageEvidence;
  readonly operationDigest: Digest;
}): DemoBudgetState {
  if (
    input.usage.status !== "settled" ||
    input.usage.calls !== 1 ||
    input.usage.tokens === null ||
    input.usage.costUnits === null
  ) {
    fail("only authenticated settled usage can release a reservation");
  }
  return createDemoBudgetState({
    ...input.current.spec,
    usage: {
      calls: safeAdd(input.current.spec.usage.calls, 1, "used calls"),
      tokens: safeAdd(
        input.current.spec.usage.tokens,
        input.usage.tokens,
        "used tokens"
      ),
      costUnits: safeAdd(
        input.current.spec.usage.costUnits,
        input.usage.costUnits,
        "used cost"
      ),
      retries: input.current.spec.usage.retries
    },
    held: {
      calls: safeSubtract(
        input.current.spec.held.calls,
        input.reservation.calls,
        "held calls"
      ),
      tokens: safeSubtract(
        input.current.spec.held.tokens,
        input.reservation.tokens,
        "held tokens"
      ),
      costUnits: safeSubtract(
        input.current.spec.held.costUnits,
        input.reservation.costUnits,
        "held cost"
      )
    },
    ledgerVersion: safeAdd(
      input.current.spec.ledgerVersion,
      1,
      "budget ledger version"
    ),
    ledgerHead: digest({
      domain: "agentic-framework.demo-budget-ledger.v1",
      previousHead: input.current.spec.ledgerHead,
      operationDigest: input.operationDigest
    })
  });
}

function validateCurrentGrant(input: {
  readonly reconstruction: DemoRuntimeReconstruction;
  readonly grant: DemoActivationGrant;
  readonly claimReceipt: DemoActivationClaimReceipt;
  readonly verifier: DemoEvidenceVerifier;
  readonly now: string;
}): void {
  validateDemoActivationGrant({
    grant: input.grant,
    receipt: input.claimReceipt,
    verifier: input.verifier,
    evaluatedAt: input.now
  });
  if (
    input.grant.spec.demoProjectId !==
      input.reconstruction.runState.spec.demoProjectId ||
    input.grant.spec.repositoryId !==
      input.reconstruction.runState.spec.repositoryId ||
    input.grant.spec.workItemNodeId !==
      input.reconstruction.runState.spec.workItemNodeId ||
    input.grant.spec.authorityEpoch !==
      input.reconstruction.runState.spec.authorityEpoch ||
    input.grant.spec.generation !==
      input.reconstruction.runState.spec.generation ||
    input.grant.spec.activationProfileDigest !==
      input.reconstruction.authority.contracts.activation.contentDigest ||
    input.grant.spec.activationLeaseDigest !==
      digest(input.reconstruction.activationLease) ||
    input.grant.spec.budgetAuthorityDigest !==
      demoBudgetAuthorityDigest(input.reconstruction.budget) ||
    !input.reconstruction.activationReady
  ) {
    fail("activation grant is not current for this exact run");
  }
}

async function releaseFence(input: {
  readonly store: DemoRunFenceStore;
  readonly acquired: DemoRunFence;
  readonly runningState: DemoRunState;
  readonly observedAt: string;
}): Promise<DemoRunFence | null> {
  const observedAt = timestamp(input.observedAt, "fence release observedAt");
  const acquiredAt = timestamp(
    input.acquired.spec.acquiredAt,
    "fence acquiredAt"
  );
  const expiresAt = timestamp(
    input.acquired.spec.expiresAt,
    "fence expiresAt"
  );
  if (observedAt < acquiredAt) return null;
  const releasedAt =
    observedAt > expiresAt
      ? input.acquired.spec.expiresAt
      : input.observedAt;
  const released = createDemoContract("DemoRunFence", {
    ...input.acquired.spec,
    previousFenceDigest: input.acquired.contentDigest,
    status: "released",
    releasedAt
  });
  const result = await input.store.release({
    expectedFenceDigest: input.acquired.contentDigest,
    releasedFence: released,
    runningState: input.runningState
  });
  if (result.status !== "appended" || result.snapshot === null) return null;
  const snapshot = validateAcquiredSnapshot({
    snapshot: result.snapshot,
    expectedFence: released,
    expectedRunningState: input.runningState
  });
  const observed = await input.store.read(input.acquired.spec.fenceKey);
  if (
    observed === null ||
    canonicalJson(observed) !== canonicalJson(snapshot)
  ) {
    return null;
  }
  return released;
}

function invocationSchedule(input: {
  readonly reconstruction: DemoRuntimeReconstruction;
  readonly dispatchDecisionDigest: Digest;
  readonly dispatchPersistenceReceiptDigest: Digest;
  readonly decidedAt: string;
  readonly binding: DemoDecisionRuntimeBinding;
  readonly fence: DemoRunFence;
  readonly reservation: DemoBudgetReservationEvidence;
}): DemoScheduleDecision {
  return createDemoContract("DemoScheduleDecision", {
    demoProjectId: input.reconstruction.runState.spec.demoProjectId,
    runStateDigest: input.reconstruction.runState.contentDigest,
    dispatchDecisionDigest: input.dispatchDecisionDigest,
    dispatchPersistenceReceiptDigest:
      input.dispatchPersistenceReceiptDigest,
    stageId: input.reconstruction.currentStage.stageId,
    action: "reserve-and-invoke",
    runtimeBinding: input.binding,
    runFenceDigest: input.fence.contentDigest,
    budgetReservation: {
      calls: input.reservation.calls,
      tokens: input.reservation.tokens,
      costUnits: input.reservation.costUnits
    },
    refusalDigest: null,
    decidedAt: input.decidedAt
  });
}

export async function scheduleDemoDispatch(input: {
  readonly reconstruction: DemoRuntimeReconstruction;
  readonly refresh: () => Promise<DemoRuntimeReconstruction>;
  readonly dispatchDecision: unknown;
  readonly dispatchPersistenceReceipt: DemoDispatchPersistenceReceipt;
  readonly dispatchVerifier: DemoEvidenceVerifier;
  readonly activationGrant: DemoActivationGrant;
  readonly activationClaimReceipt: DemoActivationClaimReceipt;
  readonly activationClaimVerifier: DemoEvidenceVerifier;
  readonly selectionGrant?: SignedStageAgentSelectionGrant;
  readonly selectionGrantVerifier?: DemoEvidenceVerifier;
  readonly participationPolicy?: unknown;
  readonly selectionPhaseContract?: PhaseContract;
  readonly refreshSelectionAuthority?: () => Promise<{
    readonly participationPolicy: unknown;
    readonly phaseContract: PhaseContract;
  }>;
  readonly holderDigest: Digest;
  readonly decidedAt: string;
  readonly fenceStore: DemoRunFenceStore;
  readonly budgetLedger: DemoBudgetLedger;
  readonly budgetVerifier: DemoEvidenceVerifier;
  readonly usageLedger: DemoProviderUsageLedger;
  readonly usageVerifier: DemoEvidenceVerifier;
  readonly invoker: DemoStageInvocationPort;
  readonly clock: DemoSchedulerClock;
}): Promise<DemoScheduleResult> {
  timestamp(input.decidedAt, "scheduler decidedAt");
  if (input.clock.now() !== input.decidedAt) {
    fail("scheduler clock does not match the persisted decision time");
  }
  if (!DIGEST.test(input.holderDigest)) {
    fail("scheduler holder identity must be a trusted digest");
  }
  if (input.fenceStore.supportsAtomicCompareAndSwap !== true) {
    fail("scheduler requires a durable atomic cross-workflow fence store");
  }
  const persisted = validatePersistedDemoDispatch({
    decision: input.dispatchDecision,
    persistenceReceipt: input.dispatchPersistenceReceipt,
    reconstruction: input.reconstruction,
    verifier: input.dispatchVerifier
  });
  const dispatch = persisted.decision;
  const nonInvocation = {
    "run-deterministic": "run-deterministic",
    "wait-human": "wait",
    "request-kernel-transition": "run-deterministic",
    project: "reconcile",
    reconcile: "reconcile",
    noop: "noop"
  } as const;
  if (dispatch.spec.action === "refuse") {
    return refusalResult({
      reconstruction: input.reconstruction,
      dispatchDecisionDigest: dispatch.contentDigest,
      dispatchPersistenceReceiptDigest:
        persisted.persistenceReceipt.head,
      decidedAt: input.decidedAt,
      code: "ACTIVATION_REQUIRED",
      ruleId: "demo.dispatch.refused",
      message: "Persisted dispatcher refusal cannot be scheduled for work.",
      recovery: "none"
    });
  }
  if (dispatch.spec.action !== "invoke-model") {
    return nonInvocationSchedule({
      reconstruction: input.reconstruction,
      dispatchDecisionDigest: dispatch.contentDigest,
      dispatchPersistenceReceiptDigest:
        persisted.persistenceReceipt.head,
      decidedAt: input.decidedAt,
      action: nonInvocation[dispatch.spec.action]
    });
  }
  if (dispatch.spec.runtimeBinding === null) {
    fail("model dispatch has no exact runtime binding");
  }
  validateCurrentGrant({
    reconstruction: input.reconstruction,
    grant: input.activationGrant,
    claimReceipt: input.activationClaimReceipt,
    verifier: input.activationClaimVerifier,
    now: input.decidedAt
  });
  const { runtimeBinding, capability } = exactBinding({
    reconstruction: input.reconstruction,
    runtimeBinding: dispatch.spec.runtimeBinding
  });
  const stageBinding =
    input.reconstruction.authority.contracts.bindings.spec.stageBindings[
      input.reconstruction.currentStage.ordinal - 1
    ];
  let validatedSelectionGrant: SignedStageAgentSelectionGrant | null = null;
  let refreshSelectionAuthority:
    | (() => Promise<{
        readonly participationPolicy: unknown;
        readonly phaseContract: PhaseContract;
      }>)
    | null = null;
  if (dispatch.spec.selectionGrantDigest === null) {
    if (stageBinding?.participationMode === "user-selectable") {
      fail("selectable dispatch omitted its signed exact-agent grant");
    }
  } else {
    if (
      input.selectionGrant === undefined ||
      input.selectionGrantVerifier === undefined ||
      input.participationPolicy === undefined ||
      input.selectionPhaseContract === undefined ||
      input.refreshSelectionAuthority === undefined ||
      input.selectionGrant.contentDigest !== dispatch.spec.selectionGrantDigest
    ) {
      fail("selected dispatch grant evidence is missing or substituted");
    }
    validatedSelectionGrant = validateSignedStageAgentSelectionGrant({
      grant: input.selectionGrant,
      verifier: input.selectionGrantVerifier,
      reconstruction: input.reconstruction,
      evaluatedAt: input.decidedAt,
      participationPolicy: input.participationPolicy,
      phaseContract: input.selectionPhaseContract
    });
    refreshSelectionAuthority = input.refreshSelectionAuthority;
    if (
      validatedSelectionGrant.spec.agentId !== runtimeBinding.agentId ||
      validatedSelectionGrant.spec.capabilityId !== runtimeBinding.capabilityId ||
      validatedSelectionGrant.spec.workflowId !== runtimeBinding.workflowId
    ) {
      fail("selected dispatch tuple differs from its signed grant");
    }
  }
  const budget = input.reconstruction.budget;
  const availableTokens =
    budget.spec.limits.maxTokens -
    budget.spec.usage.tokens -
    budget.spec.held.tokens;
  const availableCalls =
    budget.spec.limits.maxCalls -
    budget.spec.usage.calls -
    budget.spec.held.calls;
  const availableCost =
    budget.spec.limits.maxCostUnits -
    budget.spec.usage.costUnits -
    budget.spec.held.costUnits;
  if (
    availableCalls < 1 ||
    availableTokens < 1 ||
    availableCost < capability.limits.maxCostUnits
  ) {
    return refusalResult({
      reconstruction: input.reconstruction,
      dispatchDecisionDigest: dispatch.contentDigest,
      dispatchPersistenceReceiptDigest:
        persisted.persistenceReceipt.head,
      decidedAt: input.decidedAt,
      code: "BUDGET_EXHAUSTED",
      ruleId: "demo.scheduler.budget",
      message: "The exact stage maximum cannot be conservatively reserved.",
      recovery: "human-authorization"
    });
  }
  const nowMs = timestamp(input.decidedAt, "scheduler decidedAt");
  const capabilityExpiry = nowMs + capability.limits.timeoutMs;
  if (!Number.isSafeInteger(capabilityExpiry)) {
    fail("stage timeout exceeds safe timestamp arithmetic");
  }
  const expiresAt = new Date(
    Math.min(
      capabilityExpiry,
      Date.parse(input.reconstruction.activationLease.expiresAt),
      Date.parse(input.reconstruction.budget.spec.expiresAt),
      validatedSelectionGrant === null
        ? Number.MAX_SAFE_INTEGER
        : Date.parse(validatedSelectionGrant.spec.expiresAt)
    )
  ).toISOString();
  const fence = proposedFence({
    reconstruction: input.reconstruction,
    dispatchDecisionDigest: dispatch.contentDigest,
    activationLeaseDigest: digest(input.reconstruction.activationLease),
    holderDigest: input.holderDigest,
    now: input.decidedAt,
    expiresAt
  });
  demoWorkflowConcurrencyKey({
    repositoryId: fence.spec.repositoryId,
    workItemNodeId: fence.spec.workItemNodeId
  });
  const runningState = createDemoContract("DemoRunState", {
    ...input.reconstruction.runState.spec,
    fenceDigest: fence.contentDigest,
    fenceBaseRunStateDigest: input.reconstruction.runState.contentDigest,
    status: "running",
    updatedAt: input.decidedAt
  });
  const fenceResult = await input.fenceStore.acquire({
    expectedRunStateDigest: input.reconstruction.runState.contentDigest,
    fence,
    runningState
  });
  if (fenceResult.status !== "appended" || fenceResult.snapshot === null) {
    return {
      kind: "reconciliation-required",
      decision: nonInvocationSchedule({
        reconstruction: input.reconstruction,
        dispatchDecisionDigest: dispatch.contentDigest,
        dispatchPersistenceReceiptDigest:
          persisted.persistenceReceipt.head,
        decidedAt: input.decidedAt,
        action: "reconcile"
      }).decision,
      acquiredFence: null,
      runningState: null,
      budget,
      reason:
        fenceResult.status === "conflict"
          ? "FENCE_CONFLICT"
          : "FENCE_ACKNOWLEDGEMENT_AMBIGUOUS"
    };
  }
  const acquired = validateAcquiredSnapshot({
    snapshot: fenceResult.snapshot,
    expectedFence: fence,
    expectedRunningState: runningState
  });
  const observedFence = await input.fenceStore.read(fence.spec.fenceKey);
  if (
    observedFence === null ||
    canonicalJson(observedFence) !== canonicalJson(acquired)
  ) {
    return {
      kind: "reconciliation-required",
      decision: nonInvocationSchedule({
        reconstruction: input.reconstruction,
        dispatchDecisionDigest: dispatch.contentDigest,
        dispatchPersistenceReceiptDigest:
          persisted.persistenceReceipt.head,
        decidedAt: input.decidedAt,
        action: "reconcile"
      }).decision,
      acquiredFence: fence,
      runningState,
      budget,
      reason: "FENCE_ACKNOWLEDGEMENT_AMBIGUOUS"
    };
  }

  const reservationKey = digest({
    operation: "reserve-demo-stage-cost",
    budgetStateDigest: budget.contentDigest,
    dispatchDecisionDigest: dispatch.contentDigest,
    stageId: input.reconstruction.currentStage.stageId,
    runtimeBinding
  });
  const reservationWithoutSignature: Omit<
    DemoBudgetReservationEvidence,
    "signature"
  > = {
    schemaVersion: "1.0.0",
    reservationKey,
    budgetBeforeDigest: budget.contentDigest,
    budgetAfterDigest: digest("pending"),
    dispatchDecisionDigest: dispatch.contentDigest,
    stageId: input.reconstruction.currentStage.stageId,
    runtimeBinding,
    calls: 1,
    tokens: availableTokens,
    costUnits: capability.limits.maxCostUnits,
    reservedAt: input.decidedAt,
    expiresAt: budget.spec.expiresAt
  };
  const budgetAfterReserve = nextBudgetForReservation({
    current: budget,
    calls: 1,
    tokens: availableTokens,
    costUnits: capability.limits.maxCostUnits,
    operationDigest: digest({
      ...reservationWithoutSignature,
      budgetAfterDigest: null
    })
  });
  const reserveEvidenceInput = {
    ...reservationWithoutSignature,
    budgetAfterDigest: budgetAfterReserve.contentDigest
  };
  const budgetResult = await input.budgetLedger.reserve({
    expected: budget,
    next: budgetAfterReserve,
    evidence: reserveEvidenceInput
  });
  if (
    budgetResult.status !== "appended" ||
    budgetResult.budget === null ||
    budgetResult.evidence === null
  ) {
    return {
      kind: "reconciliation-required",
      decision: nonInvocationSchedule({
        reconstruction: input.reconstruction,
        dispatchDecisionDigest: dispatch.contentDigest,
        dispatchPersistenceReceiptDigest:
          persisted.persistenceReceipt.head,
        decidedAt: input.decidedAt,
        action: "reconcile"
      }).decision,
      acquiredFence: fence,
      runningState,
      budget,
      reason:
        budgetResult.status === "conflict"
          ? "BUDGET_CONFLICT"
          : "BUDGET_ACKNOWLEDGEMENT_AMBIGUOUS"
    };
  }
  const persistedBudget = validateDemoBudgetState(budgetResult.budget);
  if (persistedBudget.contentDigest !== budgetAfterReserve.contentDigest) {
    fail("budget ledger persisted a substituted reservation state");
  }
  const reservation = validateReservation({
    evidence: budgetResult.evidence,
    before: budget,
    after: persistedBudget,
    dispatchDecisionDigest: dispatch.contentDigest,
    binding: runtimeBinding,
    stageId: input.reconstruction.currentStage.stageId,
    verifier: input.budgetVerifier
  });
  const budgetReadback = validateDemoBudgetState(
    await input.budgetLedger.read()
  );
  if (budgetReadback.contentDigest !== persistedBudget.contentDigest) {
    return {
      kind: "reconciliation-required",
      decision: nonInvocationSchedule({
        reconstruction: input.reconstruction,
        dispatchDecisionDigest: dispatch.contentDigest,
        dispatchPersistenceReceiptDigest:
          persisted.persistenceReceipt.head,
        decidedAt: input.decidedAt,
        action: "reconcile"
      }).decision,
      acquiredFence: fence,
      runningState,
      budget: budgetReadback,
      reason: "BUDGET_ACKNOWLEDGEMENT_AMBIGUOUS"
    };
  }
  const schedule = invocationSchedule({
    reconstruction: input.reconstruction,
    dispatchDecisionDigest: dispatch.contentDigest,
    dispatchPersistenceReceiptDigest:
      persisted.persistenceReceipt.head,
    decidedAt: input.decidedAt,
    binding: runtimeBinding,
    fence,
    reservation
  });

  const refreshed = await input.refresh();
  if (
    refreshed.runState.contentDigest !== runningState.contentDigest ||
    refreshed.budget.contentDigest !== persistedBudget.contentDigest ||
    refreshed.currentStage.stageId !==
      input.reconstruction.currentStage.stageId ||
    refreshed.runState.spec.authorityEpoch !==
      input.reconstruction.runState.spec.authorityEpoch ||
    refreshed.runState.spec.generation !==
      input.reconstruction.runState.spec.generation
  ) {
    return {
      kind: "reconciliation-required",
      decision: schedule,
      acquiredFence: fence,
      runningState,
      budget: persistedBudget,
      reason: "FENCE_CONFLICT"
    };
  }
  let refreshedSelectionAuthority: {
    readonly participationPolicy: unknown;
    readonly phaseContract: PhaseContract;
  } | null = null;
  if (validatedSelectionGrant !== null) {
    if (refreshSelectionAuthority === null) {
      fail("selected dispatch omitted its authority refresh callback");
    }
    refreshedSelectionAuthority = await refreshSelectionAuthority();
  }
  const preInferenceNow = input.clock.now();
  const preInferenceTime = timestamp(
    preInferenceNow,
    "pre-inference revalidation time"
  );
  if (
    preInferenceTime < timestamp(input.decidedAt, "scheduler decidedAt") ||
    preInferenceTime >= timestamp(expiresAt, "stage deadline")
  ) {
    fail("stage authority expired or clock regressed before inference");
  }
  validateCurrentGrant({
    reconstruction: {
      ...refreshed,
      budget: input.reconstruction.budget
    },
    grant: input.activationGrant,
    claimReceipt: input.activationClaimReceipt,
    verifier: input.activationClaimVerifier,
    now: preInferenceNow
  });
  exactBinding({ reconstruction: refreshed, runtimeBinding });
  if (
    dispatch.spec.selectionGrantDigest !== null &&
    input.selectionGrant !== undefined &&
    input.selectionGrantVerifier !== undefined &&
    refreshedSelectionAuthority !== null
  ) {
    validateSignedStageAgentSelectionGrant({
      grant: input.selectionGrant,
      verifier: input.selectionGrantVerifier,
      reconstruction: refreshed,
      evaluatedAt: preInferenceNow,
      participationPolicy: refreshedSelectionAuthority.participationPolicy,
      phaseContract: refreshedSelectionAuthority.phaseContract
    });
  }
  if (
    digest(refreshed.activationLease) !==
      digest(input.reconstruction.activationLease) ||
    !refreshed.activationReady
  ) {
    fail("lease changed immediately before inference");
  }

  const attemptWithoutSignature: Omit<
    DemoProviderAttemptEvidence,
    "signature"
  > = {
    schemaVersion: "1.0.0",
    attemptKey: digest({
      operation: "invoke-demo-stage",
      reservationDigest: digest(reservation),
      fenceDigest: fence.contentDigest,
      runId: runningState.spec.runId,
      runAttempt: runningState.spec.runAttempt,
      stageId: input.reconstruction.currentStage.stageId
    }),
    reservationDigest: digest(reservation),
    fenceDigest: fence.contentDigest,
    demoProjectId: runningState.spec.demoProjectId,
    repositoryId: runningState.spec.repositoryId,
    workItemNodeId: runningState.spec.workItemNodeId,
    authorityEpoch: runningState.spec.authorityEpoch,
    generation: runningState.spec.generation,
    runId: runningState.spec.runId,
    runAttempt: runningState.spec.runAttempt,
    stageId: input.reconstruction.currentStage.stageId,
    runtimeBinding,
    startedAt: preInferenceNow,
    expiresAt
  };
  const attempt = validateAttempt({
    attempt: await input.usageLedger.begin(attemptWithoutSignature),
    reservation,
    fence,
    reconstruction: input.reconstruction,
    binding: runtimeBinding,
    verifier: input.usageVerifier
  });

  const invocationReconstruction = await input.refresh();
  if (
    invocationReconstruction.runState.contentDigest !==
      runningState.contentDigest ||
    invocationReconstruction.budget.contentDigest !==
      persistedBudget.contentDigest ||
    invocationReconstruction.currentStage.stageId !==
      input.reconstruction.currentStage.stageId ||
    invocationReconstruction.runState.spec.authorityEpoch !==
      input.reconstruction.runState.spec.authorityEpoch ||
    invocationReconstruction.runState.spec.generation !==
      input.reconstruction.runState.spec.generation
  ) {
    fail("runtime authority changed after provider-attempt persistence");
  }
  let invocationSelectionAuthority: {
    readonly participationPolicy: unknown;
    readonly phaseContract: PhaseContract;
  } | null = null;
  if (validatedSelectionGrant !== null) {
    if (refreshSelectionAuthority === null) {
      fail("selected dispatch omitted its authority refresh callback");
    }
    invocationSelectionAuthority = await refreshSelectionAuthority();
  }
  const invocationNow = input.clock.now();
  const invocationTime = timestamp(
    invocationNow,
    "immediate pre-invocation time"
  );
  if (
    invocationTime < preInferenceTime ||
    invocationTime >= timestamp(expiresAt, "stage deadline")
  ) {
    fail("stage authority expired or clock regressed immediately before inference");
  }
  validateCurrentGrant({
    reconstruction: {
      ...invocationReconstruction,
      budget: input.reconstruction.budget
    },
    grant: input.activationGrant,
    claimReceipt: input.activationClaimReceipt,
    verifier: input.activationClaimVerifier,
    now: invocationNow
  });
  exactBinding({ reconstruction: invocationReconstruction, runtimeBinding });
  if (
    validatedSelectionGrant !== null &&
    input.selectionGrant !== undefined &&
    input.selectionGrantVerifier !== undefined &&
    invocationSelectionAuthority !== null
  ) {
    validateSignedStageAgentSelectionGrant({
      grant: input.selectionGrant,
      verifier: input.selectionGrantVerifier,
      reconstruction: invocationReconstruction,
      evaluatedAt: invocationNow,
      participationPolicy:
        invocationSelectionAuthority.participationPolicy,
      phaseContract: invocationSelectionAuthority.phaseContract
    });
  }
  if (
    digest(invocationReconstruction.activationLease) !==
      digest(input.reconstruction.activationLease) ||
    !invocationReconstruction.activationReady
  ) {
    fail("lease changed immediately before model invocation");
  }

  let invocation:
    | {
        readonly artifact: StageArtifactEnvelope;
        readonly output: unknown;
      }
    | null = null;
  let invocationFailure: unknown = null;
  try {
    invocation = await input.invoker.invoke({
      stageId: input.reconstruction.currentStage.stageId,
      stageOrdinal: input.reconstruction.currentStage.ordinal,
      runtimeBinding,
      capability,
      runStateDigest: runningState.contentDigest,
      dispatchDecisionDigest: dispatch.contentDigest,
      fenceDigest: fence.contentDigest,
      budgetReservationDigest: digest(reservation),
      providerAttemptDigest: digest(attempt),
      deadline: expiresAt
    });
  } catch (error) {
    invocationFailure = error;
  }

  let usage: DemoProviderUsageEvidence | null = null;
  let settledBudget = persistedBudget;
  try {
    usage = validateUsage({
      usage: await input.usageLedger.reconcile(attempt),
      attempt,
      reservation,
      verifier: input.usageVerifier
    });
  } catch (error) {
    const released = await releaseFence({
      store: input.fenceStore,
      acquired: fence,
      runningState,
      observedAt: input.clock.now()
    });
    return {
      kind: "provider-failed",
      decision: schedule,
      acquiredFence: fence,
      releasedFence: released,
      runningState,
      usage,
      budget: settledBudget,
      failureDigest: digest({
        class: "usage-reconciliation-failure",
        errorName: error instanceof Error ? error.name : "unknown"
      })
    };
  }
  if (usage.status === "settled") {
    if (
      usage.calls !== 1 ||
      usage.tokens === null ||
      usage.costUnits === null
    ) {
      fail("settled provider usage is incomplete");
    }
    const settlementOperationDigest = digest({
      operation: "settle-demo-stage-cost",
      reservationDigest: digest(reservation),
      usageDigest: digest(usage)
    });
    const nextBudget = nextBudgetForSettlement({
      current: persistedBudget,
      reservation,
      usage,
      operationDigest: settlementOperationDigest
    });
    const settlementInput: Omit<
      DemoBudgetSettlementEvidence,
      "signature"
    > = {
      schemaVersion: "1.0.0",
      reservationDigest: digest(reservation),
      usageDigest: digest(usage),
      budgetBeforeDigest: persistedBudget.contentDigest,
      budgetAfterDigest: nextBudget.contentDigest,
      calls: 1,
      tokens: usage.tokens,
      costUnits: usage.costUnits,
      settledAt: usage.observedAt
    };
    const settlementResult = await input.budgetLedger.settle({
      expected: persistedBudget,
      next: nextBudget,
      evidence: settlementInput
    });
    if (
      settlementResult.status !== "appended" ||
      settlementResult.budget === null ||
      settlementResult.evidence === null
    ) {
      return {
        kind: "reconciliation-required",
        decision: schedule,
        acquiredFence: fence,
        runningState,
        budget: persistedBudget,
        reason:
          settlementResult.status === "conflict"
            ? "SETTLEMENT_CONFLICT"
            : "SETTLEMENT_ACKNOWLEDGEMENT_AMBIGUOUS"
      };
    }
    const candidateBudget = validateDemoBudgetState(
      settlementResult.budget
    );
    if (candidateBudget.contentDigest !== nextBudget.contentDigest) {
      fail("budget settlement persisted a substituted state");
    }
    validateSettlement({
      evidence: settlementResult.evidence,
      before: persistedBudget,
      after: candidateBudget,
      reservation,
      usage,
      verifier: input.budgetVerifier
    });
    const settledReadback = validateDemoBudgetState(
      await input.budgetLedger.read()
    );
    if (settledReadback.contentDigest !== candidateBudget.contentDigest) {
      return {
        kind: "reconciliation-required",
        decision: schedule,
        acquiredFence: fence,
        runningState,
        budget: persistedBudget,
        reason: "SETTLEMENT_ACKNOWLEDGEMENT_AMBIGUOUS"
      };
    }
    settledBudget = candidateBudget;
  }
  if (usage.status === "unknown") {
    const released = await releaseFence({
      store: input.fenceStore,
      acquired: fence,
      runningState,
      observedAt: input.clock.now()
    });
    if (released === null) {
      return {
        kind: "reconciliation-required",
        decision: schedule,
        acquiredFence: fence,
        runningState,
        budget: settledBudget,
        reason: "FENCE_RELEASE_CONFLICT"
      };
    }
    return {
      kind: "reconciliation-required",
      decision: schedule,
      acquiredFence: fence,
      runningState,
      budget: settledBudget,
      reason: "USAGE_UNKNOWN"
    };
  }
  const completedAt = input.clock.now();
  const completedAtMs = timestamp(completedAt, "stage completion observedAt");
  const invocationExpired = completedAtMs >= timestamp(expiresAt, "stage deadline");
  if (invocationFailure !== null || invocation === null) {
    const released = await releaseFence({
      store: input.fenceStore,
      acquired: fence,
      runningState,
      observedAt: completedAt
    });
    return {
      kind: "provider-failed",
      decision: schedule,
      acquiredFence: fence,
      releasedFence: released,
      runningState,
      usage,
      budget: settledBudget,
      failureDigest: digest({
        class: invocationExpired ? "provider-timeout" : "provider-failure",
        errorName:
          invocationFailure instanceof Error
            ? invocationFailure.name
            : "unknown"
      })
    };
  }
  if (invocationExpired) {
    const released = await releaseFence({
      store: input.fenceStore,
      acquired: fence,
      runningState,
      observedAt: completedAt
    });
    return {
      kind: "provider-failed",
      decision: schedule,
      acquiredFence: fence,
      releasedFence: released,
      runningState,
      usage,
      budget: settledBudget,
      failureDigest: digest({
        class: "provider-timeout",
        deadline: expiresAt
      })
    };
  }
  const artifact = validateDemoContract(
    "StageArtifactEnvelope",
    invocation.artifact
  );
  const guardedOutput = assertDemoModelOutputHasNoControlFields(
    invocation.output
  );
  if (
    artifact.spec.demoProjectId !== runningState.spec.demoProjectId ||
    artifact.spec.stageId !== input.reconstruction.currentStage.stageId ||
    artifact.spec.projectProfileDigest !==
      runningState.spec.projectProfileDigest ||
    artifact.spec.journeyDefinitionDigest !==
      runningState.spec.journeyDefinitionDigest ||
    artifact.spec.stageAgentBindingsDigest !==
      runningState.spec.stageAgentBindingsDigest ||
    artifact.spec.authorityEpoch !== runningState.spec.authorityEpoch ||
    artifact.spec.generation !== runningState.spec.generation ||
    artifact.spec.runId !== runningState.spec.runId ||
    artifact.spec.runAttempt !== runningState.spec.runAttempt ||
    artifact.spec.producer.kind !== "model" ||
    artifact.spec.producer.agentId !== runtimeBinding.agentId ||
    artifact.spec.producer.capabilityId !== runtimeBinding.capabilityId ||
    artifact.spec.producer.workflowId !== runtimeBinding.workflowId
  ) {
    fail("stage invoker returned a stale, cross-demo, or substituted artifact");
  }
  const released = await releaseFence({
    store: input.fenceStore,
    acquired: fence,
    runningState,
    observedAt: completedAt
  });
  if (released === null) {
    return {
      kind: "reconciliation-required",
      decision: schedule,
      acquiredFence: fence,
      runningState,
      budget: settledBudget,
      reason: "FENCE_RELEASE_CONFLICT"
    };
  }
  return {
    kind: "invoked",
    decision: schedule,
    acquiredFence: fence,
    releasedFence: released,
    runningState,
    artifact,
    output: guardedOutput,
    usage,
    budget: settledBudget
  };
}
