import { canonicalJson, digest } from "./canonical.js";
import {
  createDemoContract,
  validateDemoContract
} from "./demo-portfolio.js";
import { demoProjectionIsConverged } from "./demo-projection.js";
import type {
  DemoDispatchDecision,
  DemoRuntimeRefusal,
  DemoSignature
} from "./demo-types.js";
import type {
  DemoEvidenceSigner,
  DemoEvidenceVerifier
} from "./demo-activation.js";
import type { DemoRuntimeReconstruction } from "./demo-runtime-state.js";
import type { Digest } from "./types.js";
import type { PhaseContract } from "./types.js";
import { isCanonicalUtcDateTime } from "./validation.js";
import { validateSignedStageAgentSelectionGrant } from "./demo-agent-selection.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/u;

export interface DemoDispatchResult {
  readonly decision: DemoDispatchDecision;
  readonly refusal: DemoRuntimeRefusal | null;
}

export interface DemoDispatchPersistenceReceipt {
  readonly schemaVersion: "1.0.0";
  readonly storeId: string;
  readonly sequence: number;
  readonly previousHead: Digest | null;
  readonly decisionDigest: Digest;
  readonly runStateDigest: Digest;
  readonly repositoryId: number;
  readonly workItemNodeId: string;
  readonly authorityEpoch: number;
  readonly generation: number;
  readonly status: "persisted";
  readonly persistedAt: string;
  readonly head: Digest;
  readonly signature: DemoSignature;
}

export interface DemoDispatchPersistenceResult {
  readonly status: "appended" | "existing" | "conflict";
  readonly receipt: DemoDispatchPersistenceReceipt | null;
}

export interface DemoDispatchStore {
  persist(
    decision: DemoDispatchDecision
  ): Promise<DemoDispatchPersistenceResult>;
  read(decisionDigest: Digest): Promise<DemoDispatchPersistenceReceipt | null>;
}

export class DemoDispatchPersistenceAmbiguousError extends Error {
  constructor(message = "dispatch persistence acknowledgement is ambiguous") {
    super(message);
    this.name = "DemoDispatchPersistenceAmbiguousError";
  }
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

function stable<T>(value: T): T {
  return deepFreeze(JSON.parse(canonicalJson(value)) as T);
}

function requireTime(value: string, label: string): void {
  if (!isCanonicalUtcDateTime(value) || !Number.isFinite(Date.parse(value))) {
    fail(`${label} must be a real canonical UTC timestamp`);
  }
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

function refusal(input: {
  readonly reconstruction: DemoRuntimeReconstruction;
  readonly code: DemoRuntimeRefusal["spec"]["code"];
  readonly ruleId: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly recovery: DemoRuntimeRefusal["spec"]["recovery"];
  readonly decidedAt: string;
}): DemoDispatchResult {
  const refusalRecord = createDemoContract("DemoRuntimeRefusal", {
    demoProjectId: input.reconstruction.runState.spec.demoProjectId,
    stageId: input.reconstruction.currentStage.stageId,
    inputDigest: digest({
      runStateDigest: input.reconstruction.runState.contentDigest,
      kernelSnapshotDigest:
        input.reconstruction.runState.spec.core.kernelSnapshotDigest,
      budgetDigest: input.reconstruction.budget.contentDigest,
      projectionDigest: input.reconstruction.projection.contentDigest
    }),
    code: input.code,
    ruleId: input.ruleId,
    message: input.message,
    retryable: input.retryable,
    recovery: input.recovery,
    refusedAt: input.decidedAt
  });
  return stable({
    refusal: refusalRecord,
    decision: createDemoContract("DemoDispatchDecision", {
      demoProjectId: input.reconstruction.runState.spec.demoProjectId,
      runStateDigest: input.reconstruction.runState.contentDigest,
      stageId: input.reconstruction.currentStage.stageId,
      stageOrdinal: input.reconstruction.currentStage.ordinal,
      action: "refuse",
      runtimeBinding: null,
      selectionGrantDigest: null,
      kernelRouteId: null,
      refusalDigest: refusalRecord.contentDigest,
      reasonCode: input.code,
      decidedAt: input.decidedAt
    })
  });
}

function decision(input: {
  readonly reconstruction: DemoRuntimeReconstruction;
  readonly action: DemoDispatchDecision["spec"]["action"];
  readonly reasonCode: string;
  readonly decidedAt: string;
  readonly runtimeBinding?: DemoDispatchDecision["spec"]["runtimeBinding"];
  readonly selectionGrantDigest?: Digest | null;
  readonly kernelRouteId?: string | null;
}): DemoDispatchResult {
  return stable({
    refusal: null,
    decision: createDemoContract("DemoDispatchDecision", {
      demoProjectId: input.reconstruction.runState.spec.demoProjectId,
      runStateDigest: input.reconstruction.runState.contentDigest,
      stageId: input.reconstruction.currentStage.stageId,
      stageOrdinal: input.reconstruction.currentStage.ordinal,
      action: input.action,
      runtimeBinding: input.runtimeBinding ?? null,
      selectionGrantDigest: input.selectionGrantDigest ?? null,
      kernelRouteId: input.kernelRouteId ?? null,
      refusalDigest: null,
      reasonCode: input.reasonCode,
      decidedAt: input.decidedAt
    })
  });
}

function routeFromAuthority(input: {
  readonly reconstruction: DemoRuntimeReconstruction;
  readonly from: DemoRuntimeReconstruction["kernelSnapshot"]["state"];
  readonly to: DemoRuntimeReconstruction["kernelSnapshot"]["state"];
}): string {
  const lifecycle = input.reconstruction.authority.contracts.journey;
  if (
    lifecycle.spec.lifecycleGraphDigest !==
    input.reconstruction.kernelSnapshot.lifecycleGraphDigest
  ) {
    fail("dispatcher journey and Kernel lifecycle digests differ");
  }
  const graph =
    input.reconstruction.authority.workAccord.binding.lifecycleGraphDigest;
  if (
    graph !== lifecycle.spec.lifecycleGraphDigest ||
    digest(input.reconstruction.authority.lifecycle) !== graph
  ) {
    fail("dispatcher Work Accord and journey lifecycle digests differ");
  }
  const routes = input.reconstruction.authority.lifecycle.routes.filter(
    (route) => route.from === input.from && route.to === input.to
  );
  if (routes.length !== 1 || routes[0] === undefined) {
    fail(
      `dispatcher requires one canonical route from ${input.from} to ${input.to}`
    );
  }
  return routes[0].id;
}

function hasReleasedFence(
  reconstruction: DemoRuntimeReconstruction
): boolean {
  const acquiredDigest = reconstruction.runState.spec.fenceDigest;
  if (acquiredDigest === null) return false;
  return reconstruction.fences.some(
    (fence) =>
      fence.spec.status === "released" &&
      fence.spec.previousFenceDigest === acquiredDigest
  );
}

export function dispatchDemoRuntime(input: {
  readonly reconstruction: DemoRuntimeReconstruction;
  readonly decidedAt: string;
  readonly selectionGrantVerifier?: DemoEvidenceVerifier;
  readonly participationPolicy?: unknown;
  readonly selectionPhaseContract?: PhaseContract;
}): DemoDispatchResult {
  requireTime(input.decidedAt, "dispatcher decidedAt");
  const { reconstruction } = input;
  if (reconstruction.reconciliation.length > 0) {
    return decision({
      reconstruction,
      action: "reconcile",
      reasonCode: reconstruction.reconciliation[0] ?? "RECONCILIATION_REQUIRED",
      decidedAt: input.decidedAt
    });
  }
  const state = reconstruction.kernelSnapshot.state;
  if (state === "CAPTURED") {
    return decision({
      reconstruction,
      action: "request-kernel-transition",
      kernelRouteId: routeFromAuthority({
        reconstruction,
        from: "CAPTURED",
        to: "ACTIVATION_PENDING"
      }),
      reasonCode: "ACTIVATION_REQUEST_REQUIRED",
      decidedAt: input.decidedAt
    });
  }
  if (
    state === "PAUSED" ||
    (state === "ACTIVATION_PENDING" && !reconstruction.activationReady)
  ) {
    return decision({
      reconstruction,
      action: "wait-human",
      reasonCode:
        state === "PAUSED" ? "RUN_PAUSED" : "ACTIVATION_PENDING",
      decidedAt: input.decidedAt
    });
  }
  if (state === "BLOCKED") {
    return decision({
      reconstruction,
      action: "reconcile",
      reasonCode: "RUN_BLOCKED",
      decidedAt: input.decidedAt
    });
  }
  if (state === "CANCELLED") {
    return decision({
      reconstruction,
      action: "noop",
      reasonCode: "RUN_CANCELLED",
      decidedAt: input.decidedAt
    });
  }
  const projectionConverged = demoProjectionIsConverged(
    reconstruction,
    input.decidedAt
  );
  if (state === "COMPLETED") {
    return decision({
      reconstruction,
      action: projectionConverged ? "noop" : "project",
      reasonCode: projectionConverged
        ? "RUN_COMPLETED"
        : "PROJECTION_LAGGING",
      decidedAt: input.decidedAt
    });
  }
  if (!reconstruction.activationReady) {
    return refusal({
      reconstruction,
      code: "ACTIVATION_REQUIRED",
      ruleId: "demo.activation.current",
      message: `No current exact activation is available: ${reconstruction.activationReason}.`,
      retryable: false,
      recovery: "human-authorization",
      decidedAt: input.decidedAt
    });
  }
  if (reconstruction.pendingArtifact !== null) {
    if (
      reconstruction.currentStage.executionKind === "model" &&
      !hasReleasedFence(reconstruction)
    ) {
      return decision({
        reconstruction,
        action: "reconcile",
        reasonCode: "PROVIDER_OR_FENCE_RECONCILIATION_REQUIRED",
        decidedAt: input.decidedAt
      });
    }
    if (reconstruction.nextStage === null) {
      return decision({
        reconstruction,
        action: "reconcile",
        reasonCode: "TERMINAL_ARTIFACT_UNEXPECTED",
        decidedAt: input.decidedAt
      });
    }
    if (
      reconstruction.nextStage.coreState ===
      reconstruction.kernelSnapshot.state
    ) {
      return decision({
        reconstruction,
        action: "run-deterministic",
        reasonCode: "STAGE_RECEIPT_READY",
        decidedAt: input.decidedAt
      });
    }
    return decision({
      reconstruction,
      action: "request-kernel-transition",
      kernelRouteId: routeFromAuthority({
        reconstruction,
        from: reconstruction.kernelSnapshot.state,
        to: reconstruction.nextStage.coreState
      }),
      reasonCode: "KERNEL_TRANSITION_REQUIRED",
      decidedAt: input.decidedAt
    });
  }
  if (!projectionConverged) {
    return decision({
      reconstruction,
      action: "project",
      reasonCode: "PROJECTION_LAGGING",
      decidedAt: input.decidedAt
    });
  }
  if (reconstruction.runState.spec.status === "running") {
    return decision({
      reconstruction,
      action: "reconcile",
      reasonCode: "RUN_ATTEMPT_INCOMPLETE",
      decidedAt: input.decidedAt
    });
  }
  if (
    reconstruction.runState.spec.status === "waiting-human" ||
    reconstruction.currentStage.executionKind === "planning" ||
    reconstruction.currentStage.executionKind === "human"
  ) {
    return decision({
      reconstruction,
      action: "wait-human",
      reasonCode:
        reconstruction.currentStage.executionKind === "planning"
          ? "PLAN_GATE_REQUIRED"
          : "HUMAN_GATE_REQUIRED",
      decidedAt: input.decidedAt
    });
  }
  if (
    reconstruction.runState.spec.status === "blocked" ||
    reconstruction.runState.spec.status === "cancelled"
  ) {
    return decision({
      reconstruction,
      action:
        reconstruction.runState.spec.status === "cancelled"
          ? "noop"
          : "reconcile",
      reasonCode:
        reconstruction.runState.spec.status === "cancelled"
          ? "RUN_CANCELLED"
          : "RUN_BLOCKED",
      decidedAt: input.decidedAt
    });
  }
  if (reconstruction.currentStage.executionKind === "model") {
    const entry =
      reconstruction.authority.contracts.bindings.spec.stageBindings[
        reconstruction.currentStage.ordinal - 1
      ];
    if (
      entry?.stageId !== reconstruction.currentStage.stageId ||
      entry.executionKind !== "model" ||
      entry.runtimeBindings.length < 1
    ) {
      return refusal({
        reconstruction,
        code: "BINDING_INVALID",
        ruleId: "demo.binding.exact",
        message: "The canonical model stage has no unique trusted runtime binding.",
        retryable: false,
        recovery: "new-contract",
        decidedAt: input.decidedAt
      });
    }
    if (entry.participationMode === "fixed") {
      const binding = entry.runtimeBindings[0];
      if (
        entry.runtimeBindings.length !== 1 ||
        binding === undefined ||
        binding.userInvocable ||
        binding.optionKey !== null
      ) {
        return refusal({
          reconstruction,
          code: "BINDING_INVALID",
          ruleId: "demo.binding.fixed",
          message: "The fixed stage has no unique non-user-invocable binding.",
          retryable: false,
          recovery: "new-contract",
          decidedAt: input.decidedAt
        });
      }
      return decision({
        reconstruction,
        action: "invoke-model",
        runtimeBinding: {
          agentId: binding.agent,
          capabilityId: binding.capability,
          workflowId: binding.workflow
        },
        reasonCode: "FIXED_MODEL_STAGE_READY",
        decidedAt: input.decidedAt
      });
    }
    const selection = reconstruction.agentSelection;
    if (
      entry.participationMode !== "user-selectable" ||
      selection === null ||
      selection.kind !== "accepted" ||
      selection.grant === null ||
      !entry.runtimeBindings.some(
        (binding) =>
          binding.userInvocable &&
          binding.optionKey === selection.grant.spec.optionKey &&
          binding.agent === selection.runtimeBinding.agentId &&
          binding.capability === selection.runtimeBinding.capabilityId &&
          binding.workflow === selection.runtimeBinding.workflowId
      )
    ) {
      const selectionRefusal =
        selection !== null && selection.refusal !== null
          ? selection.refusal
          : null;
      if (selectionRefusal !== null) {
        return stable({
          refusal: selectionRefusal,
          decision: createDemoContract("DemoDispatchDecision", {
            demoProjectId: reconstruction.runState.spec.demoProjectId,
            runStateDigest: reconstruction.runState.contentDigest,
            stageId: reconstruction.currentStage.stageId,
            stageOrdinal: reconstruction.currentStage.ordinal,
            action: "refuse",
            runtimeBinding: null,
            selectionGrantDigest: null,
            kernelRouteId: null,
            refusalDigest: selectionRefusal.contentDigest,
            reasonCode: selectionRefusal.spec.code,
            decidedAt: input.decidedAt
          })
        });
      }
      return refusal({
        reconstruction,
        code: "SELECTION_REQUIRED",
        ruleId: "demo.selection.required",
        message: "The selectable stage has no accepted exact-agent grant.",
        retryable: false,
        recovery: "human-authorization",
        decidedAt: input.decidedAt
      });
    }
    if (
      input.selectionGrantVerifier === undefined ||
      input.participationPolicy === undefined ||
      input.selectionPhaseContract === undefined
    ) {
      return refusal({
        reconstruction,
        code: "SELECTION_INVALID",
        ruleId: "demo.selection.dispatch",
        message:
          "Selectable dispatch requires current signed-grant and policy verification.",
        retryable: false,
        recovery: "reconcile",
        decidedAt: input.decidedAt
      });
    }
    try {
      validateSignedStageAgentSelectionGrant({
        grant: selection.grant,
        verifier: input.selectionGrantVerifier,
        reconstruction,
        evaluatedAt: input.decidedAt,
        participationPolicy: input.participationPolicy,
        phaseContract: input.selectionPhaseContract
      });
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      return refusal({
        reconstruction,
        code: "SELECTION_STALE",
        ruleId: "demo.selection.dispatch",
        message: "The embedded exact-agent grant is stale or invalid.",
        retryable: false,
        recovery: "reconcile",
        decidedAt: input.decidedAt
      });
    }
    return decision({
      reconstruction,
      action: "invoke-model",
      runtimeBinding: selection.runtimeBinding,
      selectionGrantDigest: selection.grant.contentDigest,
      reasonCode: "SELECTED_MODEL_STAGE_READY",
      decidedAt: input.decidedAt
    });
  }
  if (reconstruction.currentStage.executionKind === "deterministic") {
    return decision({
      reconstruction,
      action: "run-deterministic",
      reasonCode: "DETERMINISTIC_STAGE_READY",
      decidedAt: input.decidedAt
    });
  }
  return decision({
    reconstruction,
    action: "noop",
    reasonCode: "NO_AUTHORIZED_STAGE_ACTION",
    decidedAt: input.decidedAt
  });
}

function persistencePayload(
  receipt: DemoDispatchPersistenceReceipt
): Omit<DemoDispatchPersistenceReceipt, "signature"> {
  const { signature: _signature, ...payload } = receipt;
  return payload;
}

function validatePersistenceReceipt(input: {
  readonly receipt: DemoDispatchPersistenceReceipt;
  readonly decision: DemoDispatchDecision;
  readonly reconstruction: DemoRuntimeReconstruction;
  readonly verifier: DemoEvidenceVerifier;
}): DemoDispatchPersistenceReceipt {
  const receipt = stable(input.receipt);
  exactKeys(
    receipt as unknown as Readonly<Record<string, unknown>>,
    [
      "schemaVersion",
      "storeId",
      "sequence",
      "previousHead",
      "decisionDigest",
      "runStateDigest",
      "repositoryId",
      "workItemNodeId",
      "authorityEpoch",
      "generation",
      "status",
      "persistedAt",
      "head",
      "signature"
    ],
    "DemoDispatchPersistenceReceipt"
  );
  requireTime(receipt.persistedAt, "dispatch persistedAt");
  if (
    receipt.schemaVersion !== "1.0.0" ||
    receipt.storeId.length < 1 ||
    receipt.storeId.length > 256 ||
    !Number.isSafeInteger(receipt.sequence) ||
    receipt.sequence < 1 ||
    (receipt.previousHead !== null && !DIGEST.test(receipt.previousHead)) ||
    receipt.decisionDigest !== input.decision.contentDigest ||
    receipt.runStateDigest !==
      input.reconstruction.runState.contentDigest ||
    receipt.repositoryId !== input.reconstruction.runState.spec.repositoryId ||
    receipt.workItemNodeId !==
      input.reconstruction.runState.spec.workItemNodeId ||
    receipt.authorityEpoch !==
      input.reconstruction.runState.spec.authorityEpoch ||
    receipt.generation !== input.reconstruction.runState.spec.generation ||
    receipt.status !== "persisted" ||
    receipt.head !==
      digest({
        storeId: receipt.storeId,
        sequence: receipt.sequence,
        previousHead: receipt.previousHead,
        decisionDigest: receipt.decisionDigest,
        runStateDigest: receipt.runStateDigest,
        repositoryId: receipt.repositoryId,
        workItemNodeId: receipt.workItemNodeId,
        authorityEpoch: receipt.authorityEpoch,
        generation: receipt.generation,
        status: receipt.status,
        persistedAt: receipt.persistedAt
      }) ||
    !input.verifier.verify(persistencePayload(receipt), receipt.signature)
  ) {
    fail("dispatcher decision persistence receipt is invalid or stale");
  }
  return receipt;
}

export async function persistDemoDispatchDecision(input: {
  readonly result: DemoDispatchResult;
  readonly reconstruction: DemoRuntimeReconstruction;
  readonly store: DemoDispatchStore;
  readonly verifier: DemoEvidenceVerifier;
}): Promise<DemoDispatchPersistenceReceipt> {
  const decision = validateDemoContract(
    "DemoDispatchDecision",
    input.result.decision
  );
  if (
    decision.spec.runStateDigest !== input.reconstruction.runState.contentDigest
  ) {
    fail("dispatcher decision was derived from a different run state");
  }
  let result: DemoDispatchPersistenceResult;
  try {
    result = await input.store.persist(decision);
  } catch (error) {
    if (!(error instanceof DemoDispatchPersistenceAmbiguousError)) throw error;
    const first = await input.store.read(decision.contentDigest);
    const second = await input.store.read(decision.contentDigest);
    if (
      first === null ||
      second === null ||
      canonicalJson(first) !== canonicalJson(second)
    ) {
      fail("ambiguous dispatcher persistence did not resolve to one stable receipt");
    }
    result = { status: "existing", receipt: second };
  }
  if (result.status === "conflict" || result.receipt === null) {
    fail("dispatcher decision conflicts with an existing durable decision");
  }
  const receipt = validatePersistenceReceipt({
    receipt: result.receipt,
    decision,
    reconstruction: input.reconstruction,
    verifier: input.verifier
  });
  const observed = await input.store.read(decision.contentDigest);
  if (
    observed === null ||
    canonicalJson(observed) !== canonicalJson(receipt)
  ) {
    fail("dispatcher decision was not durably observed");
  }
  return receipt;
}

export function validatePersistedDemoDispatch(input: {
  readonly decision: unknown;
  readonly persistenceReceipt: DemoDispatchPersistenceReceipt;
  readonly reconstruction: DemoRuntimeReconstruction;
  readonly verifier: DemoEvidenceVerifier;
}): {
  readonly decision: DemoDispatchDecision;
  readonly persistenceReceipt: DemoDispatchPersistenceReceipt;
} {
  const decision = validateDemoContract(
    "DemoDispatchDecision",
    input.decision
  );
  if (
    decision.spec.runStateDigest !==
      input.reconstruction.runState.contentDigest ||
    decision.spec.demoProjectId !==
      input.reconstruction.runState.spec.demoProjectId ||
    decision.spec.stageId !== input.reconstruction.currentStage.stageId ||
    decision.spec.stageOrdinal !== input.reconstruction.currentStage.ordinal
  ) {
    fail("persisted dispatcher decision is delayed or superseded");
  }
  return stable({
    decision,
    persistenceReceipt: validatePersistenceReceipt({
      receipt: input.persistenceReceipt,
      decision,
      reconstruction: input.reconstruction,
      verifier: input.verifier
    })
  });
}
