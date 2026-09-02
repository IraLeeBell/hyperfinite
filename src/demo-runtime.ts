import { canonicalJson, digest } from "./canonical.js";
import {
  advanceDemoJourney,
  createDemoContract,
  demoContractContentDigest,
  validateDemoContract,
  type TrustedDemoRuntimeBinding
} from "./demo-portfolio.js";
import {
  validatePersistedDemoDispatch,
  type DemoDispatchPersistenceReceipt
} from "./demo-dispatcher.js";
import {
  createDemoBudgetState,
  demoCoreBindingFromSnapshot,
  validateDemoBudgetState,
  type DemoBudgetState,
  type DemoRuntimeAuthority,
  type DemoRuntimeReconstruction
} from "./demo-runtime-state.js";
import type {
  DemoEvidenceVerifier,
  DemoRecoveryBudgetEvidence
} from "./demo-activation.js";
import {
  bridgeRuntimeOutput,
  type RuntimeAuthorization,
  type RuntimeAuthorizationVerifier,
  type RuntimeClock,
  type RuntimeThreatEvidence
} from "./copilot-runtime.js";
import type {
  DemoSignature,
  SignedStageReceipt,
  SignedStageReceiptVerifier
} from "./demo-types.js";
import type { GitHubSingleWriter, GitHubExecutionResult } from "./github-adapter.js";
import type { TrustedGitHubBinding } from "./github-events.js";
import type { GitHubEffectPlan, GitHubSafeOutput } from "./github-types.js";
import {
  evaluateTransition,
  type KernelContext
} from "./kernel.js";
import type {
  CopilotRuntimePolicy,
  Digest,
  EventEnvelope,
  KernelResult,
  KernelSnapshot,
  LifecycleState
} from "./types.js";
import { assertDocument, isCanonicalUtcDateTime } from "./validation.js";

export interface DemoKernelEvaluation {
  readonly result: KernelResult;
  readonly dispatchDecisionDigest: Digest;
  readonly eventDigest: Digest;
}

export interface DemoKernelStateStore {
  persistApplied(result: Extract<KernelResult, { kind: "applied" }>): Promise<{
    readonly status: "appended" | "existing" | "conflict";
  }>;
  read(): Promise<KernelSnapshot>;
}

export interface DemoStageReceiptSigner {
  sign(contentDigest: Digest): Promise<DemoSignature>;
}

export interface DemoStageReceiptStore {
  append(input: {
    readonly expectedRunStateDigest: Digest;
    readonly receipt: SignedStageReceipt;
    readonly nextRunState: DemoRuntimeReconstruction["runState"];
  }): Promise<{
    readonly status: "appended" | "existing" | "conflict";
  }>;
  read(receiptDigest: Digest): Promise<{
    readonly receipt: SignedStageReceipt;
    readonly runState: DemoRuntimeReconstruction["runState"];
  } | null>;
}

export interface DemoRunStateStore {
  compareAndSwap(input: {
    readonly expectedRunStateDigest: Digest;
    readonly nextRunState: DemoRuntimeReconstruction["runState"];
  }): Promise<{
    readonly status: "appended" | "existing" | "conflict";
  }>;
  read(): Promise<DemoRuntimeReconstruction["runState"]>;
}

export interface DemoRecoveryBudgetStore {
  record(input: {
    readonly expected: DemoBudgetState;
    readonly next: DemoBudgetState;
    readonly evidence: Omit<DemoRecoveryBudgetEvidence, "signature">;
  }): Promise<{
    readonly status: "appended" | "existing" | "conflict";
    readonly budget: DemoBudgetState | null;
    readonly evidence: DemoRecoveryBudgetEvidence | null;
  }>;
  read(): Promise<DemoBudgetState>;
  readEvidence(
    kernelReceiptDigest: Digest
  ): Promise<DemoRecoveryBudgetEvidence | null>;
}

export class DemoKernelPersistenceAmbiguousError extends Error {
  constructor(message = "Kernel persistence acknowledgement is ambiguous") {
    super(message);
    this.name = "DemoKernelPersistenceAmbiguousError";
  }
}

export class DemoStageReceiptPersistenceAmbiguousError extends Error {
  constructor(message = "stage receipt persistence acknowledgement is ambiguous") {
    super(message);
    this.name = "DemoStageReceiptPersistenceAmbiguousError";
  }
}

export class DemoRunStatePersistenceAmbiguousError extends Error {
  constructor(message = "run-state persistence acknowledgement is ambiguous") {
    super(message);
    this.name = "DemoRunStatePersistenceAmbiguousError";
  }
}

export class DemoRecoveryBudgetPersistenceAmbiguousError extends Error {
  constructor(message = "recovery-budget persistence acknowledgement is ambiguous") {
    super(message);
    this.name = "DemoRecoveryBudgetPersistenceAmbiguousError";
  }
}

export type DemoRunStateReconciliationResult =
  | {
      readonly kind: "updated";
      readonly runState: DemoRuntimeReconstruction["runState"];
      readonly budget: DemoBudgetState;
    }
  | {
      readonly kind: "reconciliation-required";
      readonly reason:
        | "UNRESOLVED_RUN_FENCE"
        | "FORWARD_STAGE_TRANSITION_REQUIRED"
        | "RUN_STATE_CONFLICT"
        | "RUN_STATE_ACKNOWLEDGEMENT_AMBIGUOUS"
        | "RECOVERY_BUDGET_PERSISTENCE_REQUIRED"
        | "RECOVERY_BUDGET_CONFLICT"
        | "RECOVERY_BUDGET_ACKNOWLEDGEMENT_AMBIGUOUS";
      readonly kernelSnapshot: KernelSnapshot;
      readonly budget: DemoBudgetState;
    };

const evaluatedKernelResults = new WeakSet<object>();

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

function safeIncrement(value: number, label: string): number {
  const next = value + 1;
  if (!Number.isSafeInteger(next) || next < 1) {
    fail(`${label} overflowed`);
  }
  return next;
}

function assertEvaluation(
  evaluation: DemoKernelEvaluation
): DemoKernelEvaluation {
  if (
    evaluation === null ||
    typeof evaluation !== "object" ||
    !evaluatedKernelResults.has(evaluation)
  ) {
    fail("Kernel evaluation must be produced by evaluatePersistedDemoKernelTransition");
  }
  return evaluation;
}

export function evaluatePersistedDemoKernelTransition(input: {
  readonly reconstruction: DemoRuntimeReconstruction;
  readonly dispatchDecision: unknown;
  readonly dispatchPersistenceReceipt: DemoDispatchPersistenceReceipt;
  readonly dispatchVerifier: DemoEvidenceVerifier;
  readonly event: EventEnvelope;
  readonly context: KernelContext;
}): DemoKernelEvaluation {
  const persisted = validatePersistedDemoDispatch({
    decision: input.dispatchDecision,
    persistenceReceipt: input.dispatchPersistenceReceipt,
    reconstruction: input.reconstruction,
    verifier: input.dispatchVerifier
  });
  if (
    persisted.decision.spec.action !== "request-kernel-transition" ||
    persisted.decision.spec.kernelRouteId === null
  ) {
    fail("only a persisted Kernel-transition dispatch can evaluate the Kernel");
  }
  const result = evaluateTransition(
    input.reconstruction.kernelSnapshot,
    input.event,
    input.context
  );
  if (
    result.kind === "applied" &&
    (result.route.id !== persisted.decision.spec.kernelRouteId ||
      result.receipt.routeId !== persisted.decision.spec.kernelRouteId)
  ) {
    fail("actual Control Kernel route differs from the persisted dispatcher route");
  }
  const stableResult = stable(result);
  const evaluation: DemoKernelEvaluation = Object.freeze({
    result: stableResult,
    dispatchDecisionDigest: persisted.decision.contentDigest,
    eventDigest: digest(input.event)
  });
  evaluatedKernelResults.add(evaluation);
  return evaluation;
}

async function persistAppliedKernelResult(input: {
  readonly evaluation: DemoKernelEvaluation;
  readonly store: DemoKernelStateStore;
}): Promise<Extract<KernelResult, { kind: "applied" }>> {
  const evaluation = assertEvaluation(input.evaluation);
  if (evaluation.result.kind !== "applied") {
    fail("a refused or no-op Kernel result cannot authorize persistence");
  }
  const result = evaluation.result;
  assertDocument("KernelSnapshot", result.snapshot);
  assertDocument("TransitionReceipt", result.receipt);
  if (
    result.receiptDigest !== digest(result.receipt) ||
    result.snapshot.receiptHead !== result.receiptDigest ||
    result.receipt.effectPlanDigest !== digest(result.effects)
  ) {
    fail("actual applied Kernel result is internally inconsistent");
  }
  let status: "appended" | "existing" | "conflict";
  try {
    ({ status } = await input.store.persistApplied(result));
  } catch (error) {
    if (!(error instanceof DemoKernelPersistenceAmbiguousError)) throw error;
    const first = assertDocument("KernelSnapshot", await input.store.read());
    const second = assertDocument("KernelSnapshot", await input.store.read());
    if (
      canonicalJson(first) !== canonicalJson(second) ||
      canonicalJson(second) !== canonicalJson(result.snapshot)
    ) {
      fail("ambiguous Kernel persistence did not reconcile to the exact applied snapshot");
    }
    status = "existing";
  }
  if (status === "conflict") {
    fail("Kernel persistence head changed before the applied result was stored");
  }
  const observed = assertDocument("KernelSnapshot", await input.store.read());
  if (canonicalJson(observed) !== canonicalJson(result.snapshot)) {
    fail("applied Kernel snapshot was not durably observed");
  }
  return result;
}

function fenceEvidence(
  reconstruction: DemoRuntimeReconstruction
): {
  readonly acquired: DemoRuntimeReconstruction["fences"][number] | null;
  readonly released: DemoRuntimeReconstruction["fences"][number] | null;
} {
  const acquiredDigest = reconstruction.runState.spec.fenceDigest;
  if (acquiredDigest === null) return { acquired: null, released: null };
  const acquired =
    reconstruction.fences.find(
      (candidate) =>
        candidate.contentDigest === acquiredDigest &&
        candidate.spec.status === "acquired"
    ) ?? null;
  const released =
    reconstruction.fences.find(
      (candidate) =>
        candidate.spec.status === "released" &&
        candidate.spec.previousFenceDigest === acquiredDigest
    ) ?? null;
  return { acquired, released };
}

async function appendStageReceipt(input: {
  readonly store: DemoStageReceiptStore;
  readonly receipt: SignedStageReceipt;
  readonly current: DemoRuntimeReconstruction["runState"];
  readonly next: DemoRuntimeReconstruction["runState"];
}): Promise<void> {
  let status: "appended" | "existing" | "conflict";
  try {
    ({ status } = await input.store.append({
      expectedRunStateDigest: input.current.contentDigest,
      receipt: input.receipt,
      nextRunState: input.next
    }));
  } catch (error) {
    if (!(error instanceof DemoStageReceiptPersistenceAmbiguousError)) {
      throw error;
    }
    const first = await input.store.read(input.receipt.contentDigest);
    const second = await input.store.read(input.receipt.contentDigest);
    if (
      first === null ||
      second === null ||
      canonicalJson(first) !== canonicalJson(second) ||
      canonicalJson(second.receipt) !== canonicalJson(input.receipt) ||
      canonicalJson(second.runState) !== canonicalJson(input.next)
    ) {
      fail("ambiguous stage receipt append did not resolve to one exact stable record");
    }
    status = "existing";
  }
  if (status === "conflict") {
    fail("stage receipt compare-and-swap lost to another run");
  }
  const observed = await input.store.read(input.receipt.contentDigest);
  if (
    observed === null ||
    canonicalJson(observed.receipt) !== canonicalJson(input.receipt) ||
    canonicalJson(observed.runState) !== canonicalJson(input.next)
  ) {
    fail("stage receipt and next run state were not durably observed");
  }
}

export async function completeDemoStage(input: {
  readonly reconstruction: DemoRuntimeReconstruction;
  readonly kernelEvaluation: DemoKernelEvaluation | null;
  readonly kernelStore: DemoKernelStateStore;
  readonly receiptSigner: DemoStageReceiptSigner;
  readonly receiptVerifier: SignedStageReceiptVerifier;
  readonly receiptStore: DemoStageReceiptStore;
  readonly completedAt: string;
}): Promise<{
  readonly receipt: SignedStageReceipt;
  readonly runState: DemoRuntimeReconstruction["runState"];
  readonly kernelResult: Extract<KernelResult, { kind: "applied" }> | null;
}> {
  timestamp(input.completedAt, "stage completedAt");
  const reconstruction = input.reconstruction;
  const artifact = reconstruction.pendingArtifact;
  const next = reconstruction.nextStage;
  if (artifact === null || next === null) {
    fail("stage completion requires one persisted current-stage artifact and a next stage");
  }
  const changesCore = next.coreState !== reconstruction.kernelSnapshot.state;
  let kernelResult: Extract<KernelResult, { kind: "applied" }> | null = null;
  if (changesCore) {
    if (input.kernelEvaluation === null) {
      fail("cross-core stage completion requires the actual Control Kernel evaluation");
    }
    kernelResult = await persistAppliedKernelResult({
      evaluation: input.kernelEvaluation,
      store: input.kernelStore
    });
    if (
      kernelResult.receipt.from !== reconstruction.kernelSnapshot.state ||
      kernelResult.receipt.to !== next.coreState ||
      kernelResult.receipt.previousReceipt !==
        reconstruction.kernelSnapshot.receiptHead
    ) {
      fail("applied Kernel result does not perform the exact stage handoff");
    }
  } else if (input.kernelEvaluation !== null) {
    fail("same-core stage completion cannot invent a Kernel transition");
  }
  const coreAfter =
    kernelResult === null
      ? reconstruction.runState.spec.core
      : demoCoreBindingFromSnapshot(kernelResult.snapshot);
  const fences = fenceEvidence(reconstruction);
  if (
    reconstruction.currentStage.executionKind === "model" &&
    (fences.acquired === null || fences.released === null)
  ) {
    fail("model stage completion requires its acquired and released durable fence");
  }
  if (
    reconstruction.currentStage.executionKind !== "model" &&
    (fences.acquired !== null || fences.released !== null)
  ) {
    fail("non-model stage completion cannot consume a model run fence");
  }
  const spec: SignedStageReceipt["spec"] = {
    demoProjectId: reconstruction.runState.spec.demoProjectId,
    projectProfileDigest: reconstruction.runState.spec.projectProfileDigest,
    journeyDefinitionDigest:
      reconstruction.runState.spec.journeyDefinitionDigest,
    stageAgentBindingsDigest:
      reconstruction.runState.spec.stageAgentBindingsDigest,
    authorityEpoch: reconstruction.runState.spec.authorityEpoch,
    generation: reconstruction.runState.spec.generation,
    runId: reconstruction.runState.spec.runId,
    runAttempt: reconstruction.runState.spec.runAttempt,
    runStateDigest: reconstruction.runState.contentDigest,
    stageId: reconstruction.currentStage.stageId,
    stageOrdinal: reconstruction.currentStage.ordinal,
    nextStageId: next.stageId,
    nextStageOrdinal: next.ordinal,
    previousStageReceiptDigest:
      reconstruction.runState.spec.journey.previousStageReceiptDigest,
    artifactEnvelopeDigest: artifact.contentDigest,
    runFenceDigest: fences.acquired?.contentDigest ?? null,
    releasedRunFenceDigest: fences.released?.contentDigest ?? null,
    coreBefore: reconstruction.runState.spec.core,
    coreAfter,
    kernelTransitionReceiptDigest: kernelResult?.receiptDigest ?? null,
    appliedKernelResultDigest:
      kernelResult === null ? null : digest(kernelResult),
    outcome: "completed",
    completedAt: input.completedAt
  };
  const contentDigest = demoContractContentDigest("SignedStageReceipt", spec);
  const receipt = validateDemoContract("SignedStageReceipt", {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "SignedStageReceipt",
    schemaVersion: "1.0.0",
    contentDigest,
    spec,
    signature: await input.receiptSigner.sign(contentDigest)
  });
  if (!input.receiptVerifier.verify(receipt)) {
    fail("new stage receipt signature is not trusted");
  }
  const runState = advanceDemoJourney({
    runState: reconstruction.runState,
    authority: {
      catalog: input.reconstruction.authority.catalog,
      reservations: input.reconstruction.authority.reservations,
      lifecycle: input.reconstruction.authority.lifecycle,
      baseRegistry: input.reconstruction.authority.baseRegistry,
      contracts: input.reconstruction.authority.contracts
    },
    receipt,
    artifact,
    runFence: fences.acquired,
    releasedRunFence: fences.released,
    appliedKernelResult: kernelResult,
    workAccord: kernelResult === null ? null : reconstruction.authority.workAccord,
    verifier: input.receiptVerifier
  });
  await appendStageReceipt({
    store: input.receiptStore,
    receipt,
    current: reconstruction.runState,
    next: runState
  });
  return { receipt, runState, kernelResult };
}

function appliedDestination(
  evaluation: DemoKernelEvaluation
): Extract<KernelResult, { kind: "applied" }> {
  const checked = assertEvaluation(evaluation);
  if (checked.result.kind !== "applied") {
    fail("run-state reconciliation requires an applied Kernel result");
  }
  return checked.result;
}

function statusForState(input: {
  readonly state: LifecycleState;
  readonly executionKind:
    DemoRuntimeReconstruction["currentStage"]["executionKind"];
}): DemoRuntimeReconstruction["runState"]["spec"]["status"] {
  if (input.state === "CANCELLED") return "cancelled";
  if (input.state === "COMPLETED") return "completed";
  if (input.state === "BLOCKED") return "blocked";
  if (
    input.state === "PAUSED" ||
    input.executionKind === "human"
  ) {
    return "waiting-human";
  }
  return "ready";
}

async function persistReconciledRunState(input: {
  readonly store: DemoRunStateStore;
  readonly currentDigest: Digest;
  readonly next: DemoRuntimeReconstruction["runState"];
  readonly kernelSnapshot: KernelSnapshot;
  readonly budget: DemoBudgetState;
}): Promise<DemoRunStateReconciliationResult> {
  let status: "appended" | "existing" | "conflict";
  try {
    ({ status } = await input.store.compareAndSwap({
      expectedRunStateDigest: input.currentDigest,
      nextRunState: input.next
    }));
  } catch (error) {
    if (!(error instanceof DemoRunStatePersistenceAmbiguousError)) throw error;
    const first = validateDemoContract("DemoRunState", await input.store.read());
    const second = validateDemoContract("DemoRunState", await input.store.read());
    if (
      canonicalJson(first) !== canonicalJson(second) ||
      canonicalJson(second) !== canonicalJson(input.next)
    ) {
      return {
        kind: "reconciliation-required",
        reason: "RUN_STATE_ACKNOWLEDGEMENT_AMBIGUOUS",
        kernelSnapshot: input.kernelSnapshot,
        budget: input.budget
      };
    }
    status = "existing";
  }
  if (status === "conflict") {
    return {
      kind: "reconciliation-required",
      reason: "RUN_STATE_CONFLICT",
      kernelSnapshot: input.kernelSnapshot,
      budget: input.budget
    };
  }
  const observed = validateDemoContract("DemoRunState", await input.store.read());
  if (canonicalJson(observed) !== canonicalJson(input.next)) {
    return {
      kind: "reconciliation-required",
      reason: "RUN_STATE_ACKNOWLEDGEMENT_AMBIGUOUS",
      kernelSnapshot: input.kernelSnapshot,
      budget: input.budget
    };
  }
  return { kind: "updated", runState: observed, budget: input.budget };
}

function recoveryBudgetEvidencePayload(
  evidence: DemoRecoveryBudgetEvidence
): Omit<DemoRecoveryBudgetEvidence, "signature"> {
  const { signature: _signature, ...payload } = evidence;
  return payload;
}

function nextRecoveryBudget(input: {
  readonly current: DemoBudgetState;
  readonly kernelResult: Extract<KernelResult, { kind: "applied" }>;
  readonly runStateDigest: Digest;
  readonly nextGeneration: number;
}): {
  readonly budget: DemoBudgetState;
  readonly evidence: Omit<DemoRecoveryBudgetEvidence, "signature">;
} {
  const generationBefore = input.current.spec.generation;
  const generationAfter = input.nextGeneration;
  const retriesBefore = input.current.spec.usage.retries;
  const retriesAfter = input.kernelResult.snapshot.usage.retries;
  const generationDelta = generationAfter - generationBefore;
  const retryDelta = retriesAfter - retriesBefore;
  if (
    !Number.isSafeInteger(generationAfter) ||
    generationDelta !== 1 ||
    retryDelta < 0 ||
    retryDelta > 1 ||
    (input.kernelResult.route.event === "retry-requested"
      ? retryDelta !== 1
      : retryDelta !== 0)
  ) {
    fail("Kernel recovery does not linearly continue the demo budget");
  }
  const operationDigest = digest({
    domain: "agentic-framework.demo-recovery-budget.v1",
    budgetBeforeDigest: input.current.contentDigest,
    kernelReceiptDigest: input.kernelResult.receiptDigest,
    runStateDigest: input.runStateDigest,
    generationBefore,
    generationAfter,
    retriesBefore,
    retriesAfter
  });
  const budget = createDemoBudgetState({
    ...input.current.spec,
    generation: generationAfter,
    usage: {
      ...input.current.spec.usage,
      retries: retriesAfter
    },
    ledgerVersion: safeIncrement(
      input.current.spec.ledgerVersion,
      "retry budget ledger version"
    ),
    ledgerHead: digest({
      domain: "agentic-framework.demo-budget-ledger.v1",
      previousHead: input.current.spec.ledgerHead,
      operationDigest
    })
  });
  return {
    budget,
    evidence: {
      schemaVersion: "1.0.0",
      budgetBeforeDigest: input.current.contentDigest,
      budgetAfterDigest: budget.contentDigest,
      kernelReceiptDigest: input.kernelResult.receiptDigest,
      runStateDigest: input.runStateDigest,
      generationBefore,
      generationAfter,
      retriesBefore,
      retriesAfter,
      recordedAt: input.kernelResult.receipt.occurredAt
    }
  };
}

function validateRecoveryBudgetEvidence(input: {
  readonly evidence: DemoRecoveryBudgetEvidence;
  readonly expected: Omit<DemoRecoveryBudgetEvidence, "signature">;
  readonly verifier: DemoEvidenceVerifier;
}): DemoRecoveryBudgetEvidence {
  const evidence = stable(input.evidence);
  exactKeys(
    evidence as unknown as Readonly<Record<string, unknown>>,
    [
      "schemaVersion",
      "budgetBeforeDigest",
      "budgetAfterDigest",
      "kernelReceiptDigest",
      "runStateDigest",
      "generationBefore",
      "generationAfter",
      "retriesBefore",
      "retriesAfter",
      "recordedAt",
      "signature"
    ],
    "DemoRecoveryBudgetEvidence"
  );
  timestamp(evidence.recordedAt, "retry budget recordedAt");
  const generationDelta =
    evidence.generationAfter - evidence.generationBefore;
  const retryDelta = evidence.retriesAfter - evidence.retriesBefore;
  if (
    !Number.isSafeInteger(evidence.generationBefore) ||
    evidence.generationBefore < 0 ||
    !Number.isSafeInteger(evidence.generationAfter) ||
    generationDelta !== 1 ||
    !Number.isSafeInteger(evidence.retriesBefore) ||
    evidence.retriesBefore < 0 ||
    !Number.isSafeInteger(evidence.retriesAfter) ||
    retryDelta < 0 ||
    retryDelta > 1
  ) {
    fail("recovery budget evidence counters are not a linear safe transition");
  }
  if (
    canonicalJson(recoveryBudgetEvidencePayload(evidence)) !==
      canonicalJson(input.expected) ||
    !input.verifier.verify(
      recoveryBudgetEvidencePayload(evidence),
      evidence.signature
    )
  ) {
    fail("recovery budget evidence is unsigned, stale, or substituted");
  }
  return evidence;
}

async function observePersistedRecoveryBudget(input: {
  readonly store: DemoRecoveryBudgetStore;
  readonly verifier: DemoEvidenceVerifier;
  readonly kernelResult: Extract<KernelResult, { kind: "applied" }>;
  readonly runStateDigest: Digest;
  readonly expectedBudget: DemoBudgetState;
  readonly expectedEvidence: Omit<DemoRecoveryBudgetEvidence, "signature">;
}): Promise<DemoBudgetState | null> {
  const first = validateDemoBudgetState(await input.store.read());
  const evidenceValue = await input.store.readEvidence(
    input.kernelResult.receiptDigest
  );
  const second = validateDemoBudgetState(await input.store.read());
  if (
    evidenceValue === null ||
    first.contentDigest !== second.contentDigest ||
    second.contentDigest !== input.expectedBudget.contentDigest
  ) {
    return null;
  }
  const evidence = validateRecoveryBudgetEvidence({
    evidence: evidenceValue,
    expected: input.expectedEvidence,
    verifier: input.verifier
  });
  if (
    evidence.kernelReceiptDigest !== input.kernelResult.receiptDigest ||
    evidence.runStateDigest !== input.runStateDigest ||
    evidence.budgetAfterDigest !== second.contentDigest ||
    evidence.generationAfter !== second.spec.generation ||
    evidence.retriesAfter !== second.spec.usage.retries ||
    evidence.generationAfter - evidence.generationBefore !== 1 ||
    evidence.retriesAfter - evidence.retriesBefore < 0 ||
    evidence.retriesAfter - evidence.retriesBefore > 1
  ) {
    return null;
  }
  return second;
}

async function persistRecoveryBudget(input: {
  readonly current: DemoBudgetState;
  readonly kernelResult: Extract<KernelResult, { kind: "applied" }>;
  readonly runStateDigest: Digest;
  readonly nextGeneration: number;
  readonly store: DemoRecoveryBudgetStore;
  readonly verifier: DemoEvidenceVerifier;
}): Promise<
  | { readonly kind: "updated"; readonly budget: DemoBudgetState }
  | {
      readonly kind: "reconciliation-required";
      readonly reason:
        | "RECOVERY_BUDGET_CONFLICT"
        | "RECOVERY_BUDGET_ACKNOWLEDGEMENT_AMBIGUOUS";
      readonly budget: DemoBudgetState;
    }
> {
  const planned = nextRecoveryBudget(input);
  let result: Awaited<ReturnType<DemoRecoveryBudgetStore["record"]>>;
  try {
    result = await input.store.record({
      expected: input.current,
      next: planned.budget,
      evidence: planned.evidence
    });
  } catch (error) {
    if (!(error instanceof DemoRecoveryBudgetPersistenceAmbiguousError)) {
      throw error;
    }
    const observed = await observePersistedRecoveryBudget({
      store: input.store,
      verifier: input.verifier,
      kernelResult: input.kernelResult,
      runStateDigest: input.runStateDigest,
      expectedBudget: planned.budget,
      expectedEvidence: planned.evidence
    });
    return observed === null
      ? {
          kind: "reconciliation-required",
          reason: "RECOVERY_BUDGET_ACKNOWLEDGEMENT_AMBIGUOUS",
          budget: validateDemoBudgetState(await input.store.read())
        }
      : { kind: "updated", budget: observed };
  }
  if (result.status === "conflict") {
    const observed = await observePersistedRecoveryBudget({
      store: input.store,
      verifier: input.verifier,
      kernelResult: input.kernelResult,
      runStateDigest: input.runStateDigest,
      expectedBudget: planned.budget,
      expectedEvidence: planned.evidence
    });
    return observed === null
      ? {
          kind: "reconciliation-required",
          reason: "RECOVERY_BUDGET_CONFLICT",
          budget: validateDemoBudgetState(await input.store.read())
        }
      : { kind: "updated", budget: observed };
  }
  if (result.budget === null || result.evidence === null) {
    return {
      kind: "reconciliation-required",
      reason: "RECOVERY_BUDGET_ACKNOWLEDGEMENT_AMBIGUOUS",
      budget: validateDemoBudgetState(await input.store.read())
    };
  }
  const budget = validateDemoBudgetState(result.budget);
  if (budget.contentDigest !== planned.budget.contentDigest) {
    fail("recovery budget store persisted a substituted successor");
  }
  validateRecoveryBudgetEvidence({
    evidence: result.evidence,
    expected: planned.evidence,
    verifier: input.verifier
  });
  const observed = validateDemoBudgetState(await input.store.read());
  if (observed.contentDigest !== budget.contentDigest) {
    return {
      kind: "reconciliation-required",
      reason: "RECOVERY_BUDGET_ACKNOWLEDGEMENT_AMBIGUOUS",
      budget: observed
    };
  }
  return { kind: "updated", budget };
}

export async function reconcileDemoRunStateFromKernel(input: {
  readonly reconstruction: DemoRuntimeReconstruction;
  readonly kernelEvaluation: DemoKernelEvaluation;
  readonly kernelStore: DemoKernelStateStore;
  readonly runStateStore: DemoRunStateStore;
  readonly recoveryBudgetStore?: DemoRecoveryBudgetStore;
  readonly recoveryBudgetVerifier?: DemoEvidenceVerifier;
}): Promise<DemoRunStateReconciliationResult> {
  const result = appliedDestination(input.kernelEvaluation);
  await persistAppliedKernelResult({
    evaluation: input.kernelEvaluation,
    store: input.kernelStore
  });
  const current = input.reconstruction.runState;
  if (
    result.receipt.from !== current.spec.core.state ||
    result.receipt.previousReceipt !== current.spec.core.kernelReceiptDigest
  ) {
    fail("Kernel control transition does not continue the current run state");
  }
  if (
    current.spec.status === "running" &&
    fenceEvidence(input.reconstruction).released === null
  ) {
    return {
      kind: "reconciliation-required",
      reason: "UNRESOLVED_RUN_FENCE",
      kernelSnapshot: result.snapshot,
      budget: input.reconstruction.budget
    };
  }
  let reconciledBudget = input.reconstruction.budget;
  const destination = result.snapshot.state;
  const currentStage = input.reconstruction.currentStage;
  const controlDestination = [
    "ACTIVATION_PENDING",
    "PAUSED",
    "BLOCKED",
    "CANCELLED"
  ].includes(destination);
  const resumingCurrentStage =
    (result.receipt.from === "PAUSED" || result.receipt.from === "BLOCKED") &&
    destination === currentStage.coreState;
  let nextStage = currentStage;
  let completed = current.spec.journey.completedStageReceiptDigests;
  let generation = current.spec.generation;
  let runAttempt = current.spec.runAttempt;
  if (!controlDestination && !resumingCurrentStage) {
    const destinationIndex =
      input.reconstruction.authority.contracts.journey.spec.stages.findIndex(
        (stage) => stage.coreState === destination
      );
    if (destinationIndex < 0) {
      return {
        kind: "reconciliation-required",
        reason: "FORWARD_STAGE_TRANSITION_REQUIRED",
        kernelSnapshot: result.snapshot,
        budget: reconciledBudget
      };
    }
    if (destinationIndex > currentStage.ordinal - 1) {
      return {
        kind: "reconciliation-required",
        reason: "FORWARD_STAGE_TRANSITION_REQUIRED",
        kernelSnapshot: result.snapshot,
        budget: reconciledBudget
      };
    }
    const selected =
      input.reconstruction.authority.contracts.journey.spec.stages[
        destinationIndex
      ];
    if (selected === undefined) {
      fail("destination stage lookup failed");
    }
    nextStage = selected;
    completed = completed.slice(0, destinationIndex);
    generation += 1;
    runAttempt += 1;
    if (
      !Number.isSafeInteger(generation) ||
      !Number.isSafeInteger(runAttempt)
    ) {
      fail("run generation or attempt overflowed");
    }
  } else if (
    result.receipt.from === "BLOCKED" &&
    destination !== "CANCELLED"
  ) {
    generation += 1;
    runAttempt += 1;
    if (
      !Number.isSafeInteger(generation) ||
      !Number.isSafeInteger(runAttempt)
    ) {
      fail("run generation or attempt overflowed");
    }
  }
  if (
    result.receipt.from === "BLOCKED" &&
    destination !== "CANCELLED" &&
    generation !== current.spec.generation + 1
  ) {
    fail(
      "every non-terminal blocked recovery must advance one authority generation"
    );
  }
  if (
    result.receipt.from === "BLOCKED" &&
    destination === "CANCELLED" &&
    (generation !== current.spec.generation ||
      runAttempt !== current.spec.runAttempt)
  ) {
    fail("blocked cancellation cannot mint a new run authority");
  }
  if (
    reconciledBudget.spec.generation !== generation ||
    reconciledBudget.spec.usage.retries !== result.snapshot.usage.retries
  ) {
    if (
      input.recoveryBudgetStore === undefined ||
      input.recoveryBudgetVerifier === undefined
    ) {
      return {
        kind: "reconciliation-required",
        reason: "RECOVERY_BUDGET_PERSISTENCE_REQUIRED",
        kernelSnapshot: result.snapshot,
        budget: reconciledBudget
      };
    }
    const recoveryBudget = await persistRecoveryBudget({
      current: reconciledBudget,
      kernelResult: result,
      runStateDigest: current.contentDigest,
      nextGeneration: generation,
      store: input.recoveryBudgetStore,
      verifier: input.recoveryBudgetVerifier
    });
    reconciledBudget = recoveryBudget.budget;
    if (recoveryBudget.kind === "reconciliation-required") {
      return {
        kind: "reconciliation-required",
        reason: recoveryBudget.reason,
        kernelSnapshot: result.snapshot,
        budget: reconciledBudget
      };
    }
  }
  const next = createDemoContract("DemoRunState", {
    ...current.spec,
    core: demoCoreBindingFromSnapshot(result.snapshot),
    authorityEpoch: current.spec.authorityEpoch,
    generation,
    runAttempt,
    journey: {
      currentStageId: nextStage.stageId,
      currentStageOrdinal: nextStage.ordinal,
      previousStageReceiptDigest: completed.at(-1) ?? null,
      completedStageReceiptDigests: completed
    },
    fenceDigest: null,
    fenceBaseRunStateDigest: null,
    status: statusForState({
      state: destination,
      executionKind: nextStage.executionKind
    }),
    updatedAt: result.receipt.occurredAt
  });
  return persistReconciledRunState({
    store: input.runStateStore,
    currentDigest: current.contentDigest,
    next,
    kernelSnapshot: result.snapshot,
    budget: reconciledBudget
  });
}

export async function executeDemoBridgedEffect(input: {
  readonly kernelEvaluation: DemoKernelEvaluation;
  readonly kernelStore: DemoKernelStateStore;
  readonly authorization: RuntimeAuthorization;
  readonly authorizationVerifier: RuntimeAuthorizationVerifier;
  readonly runtimePolicy: CopilotRuntimePolicy;
  readonly redemptionDigest: Digest;
  readonly threatEvidence: RuntimeThreatEvidence;
  readonly output: GitHubSafeOutput;
  readonly binding: TrustedGitHubBinding;
  readonly trustedDemoBinding: TrustedDemoRuntimeBinding;
  readonly eventId: string;
  readonly receiptHead: Digest | null;
  readonly attempt: number;
  readonly clock: RuntimeClock;
  readonly writer: GitHubSingleWriter;
}): Promise<{
  readonly plan: GitHubEffectPlan;
  readonly result: GitHubExecutionResult;
}> {
  const evaluation = assertEvaluation(input.kernelEvaluation);
  if (evaluation.result.kind !== "applied") {
    fail("GitHub bridge requires an applied actual Control Kernel result");
  }
  const persisted = assertDocument("KernelSnapshot", await input.kernelStore.read());
  if (canonicalJson(persisted) !== canonicalJson(evaluation.result.snapshot)) {
    fail("GitHub bridge cannot run before exact Kernel persistence");
  }
  const plan = bridgeRuntimeOutput({
    authorization: input.authorization,
    authorizationVerifier: input.authorizationVerifier,
    kernelResult: evaluation.result,
    policy: input.runtimePolicy,
    redemptionDigest: input.redemptionDigest,
    threatEvidence: input.threatEvidence,
    output: input.output,
    binding: input.binding,
    trustedDemoBinding: input.trustedDemoBinding,
    eventId: input.eventId,
    receiptHead: input.receiptHead,
    attempt: input.attempt,
    clock: input.clock
  });
  const claimantId = digest({
    operation: "apply-demo-runtime-output",
    authorizationDigest: input.authorization.authorizationDigest,
    kernelReceiptDigest: evaluation.result.receiptDigest,
    planDigest: digest(plan)
  });
  const result = await input.writer.execute(
    input.binding,
    plan,
    claimantId
  );
  return { plan, result };
}
