import { canonicalJson } from "./canonical.js";
import {
  createDemoProjectionState,
  projectedDemoStageLeadsKernel,
  validateDemoProjectionState,
  type DemoProjectionState,
  type DemoRuntimeReconstruction
} from "./demo-runtime-state.js";
import type { DemoProjectionFieldKey } from "./demo-types.js";

export interface DemoProjectionWriteRequest {
  readonly expectedStateDigest: DemoProjectionState["contentDigest"];
  readonly field: DemoProjectionFieldKey;
  readonly expectedCurrentValue: string | null;
  readonly next: DemoProjectionState;
}

export interface DemoProjectionPort {
  read(): Promise<DemoProjectionState>;
  write(request: DemoProjectionWriteRequest): Promise<void>;
}

export class DemoProjectionWriteError extends Error {
  constructor(
    message: string,
    readonly outcomeAmbiguous: boolean
  ) {
    super(message);
    this.name = "DemoProjectionWriteError";
  }
}

export type DemoProjectionResult =
  | {
      readonly kind: "converged";
      readonly projection: DemoProjectionState;
      readonly writes: readonly DemoProjectionFieldKey[];
    }
  | {
      readonly kind: "reconciliation-required";
      readonly projection: DemoProjectionState;
      readonly writes: readonly DemoProjectionFieldKey[];
      readonly reason:
        | "PROJECTION_AHEAD"
        | "PROJECTION_DIVERGED"
        | "WRITE_ACKNOWLEDGEMENT_AMBIGUOUS"
        | "READ_AFTER_WRITE_MISMATCH";
    };

function fail(message: string): never {
  throw new TypeError(message);
}

function fieldValue(
  state: DemoProjectionState,
  key: DemoProjectionFieldKey
): string | null {
  const field = state.spec.fields.find((candidate) => candidate.key === key);
  if (field === undefined) fail(`projection omits ${key}`);
  return field.value;
}

function attention(reconstruction: DemoRuntimeReconstruction): string | null {
  switch (reconstruction.kernelSnapshot.state) {
    case "ACTIVATION_PENDING":
      return "Activation required";
    case "PAUSED":
      return "Paused";
    case "BLOCKED":
      return "Reconciliation required";
    case "CANCELLED":
      return "Cancelled";
    default:
      return reconstruction.activationReady ? null : "Activation required";
  }
}

function stageInteraction(
  reconstruction: DemoRuntimeReconstruction
): string {
  if (
    ["PAUSED", "BLOCKED", "CANCELLED"].includes(
      reconstruction.kernelSnapshot.state
    )
  ) {
    return "kernel-control";
  }
  const entry =
    reconstruction.authority.contracts.bindings.spec.stageBindings[
      reconstruction.currentStage.ordinal - 1
    ];
  if (entry?.participationMode === "fixed") return "backend-autonomous";
  if (entry?.participationMode === "user-selectable") return "user-selectable";
  if (reconstruction.currentStage.executionKind === "human") return "human-gate";
  if (reconstruction.currentStage.executionKind === "terminal") return "terminal";
  return "deterministic";
}

function currentStageAgent(
  reconstruction: DemoRuntimeReconstruction
): string {
  if (
    ["PAUSED", "BLOCKED", "CANCELLED"].includes(
      reconstruction.kernelSnapshot.state
    )
  ) {
    return "Kernel controlled";
  }
  if (reconstruction.currentStage.executionKind === "terminal") {
    return "No active agent";
  }
  const entry =
    reconstruction.authority.contracts.bindings.spec.stageBindings[
      reconstruction.currentStage.ordinal - 1
    ];
  if (entry?.participationMode === "fixed") {
    return entry.runtimeBindings[0]?.agent ?? "Selection blocked";
  }
  if (entry?.participationMode === "user-selectable") {
    const selection = reconstruction.agentSelection;
    if (selection?.kind === "accepted") {
      return selection.runtimeBinding.agentId;
    }
    if (selection?.kind === "refused") return "Selection blocked";
    return "Awaiting user selection";
  }
  return "No model agent";
}

function agentSelectionStatus(
  reconstruction: DemoRuntimeReconstruction
): string {
  const entry =
    reconstruction.authority.contracts.bindings.spec.stageBindings[
      reconstruction.currentStage.ordinal - 1
    ];
  if (entry?.participationMode !== "user-selectable") {
    return "not-applicable";
  }
  return reconstruction.agentSelection?.status ?? "awaiting-selection";
}

export function deriveDemoProjectionState(input: {
  readonly reconstruction: DemoRuntimeReconstruction;
  readonly observedAt: string;
}): DemoProjectionState {
  const { reconstruction } = input;
  const contracts = reconstruction.authority.contracts;
  const receiptDigest =
    reconstruction.runState.spec.journey.previousStageReceiptDigest;
  const stageBinding =
    contracts.bindings.spec.stageBindings[
      reconstruction.currentStage.ordinal - 1
    ];
  if (
    stageBinding === undefined ||
    stageBinding.stageId !== reconstruction.currentStage.stageId
  ) {
    fail("stage-agent binding does not match the canonical journey cursor");
  }
  const draft = reconstruction.runState.spec.currentDraftPullRequest;
  const values: Readonly<Record<DemoProjectionFieldKey, string | null>> = {
    stage: reconstruction.kernelSnapshot.state,
    "journey-stage": reconstruction.currentStage.displayName,
    "demo-project-profile": contracts.profile.spec.title,
    "depth-profile": reconstruction.authority.workAccord.policy.depthProfile,
    "gate-status": reconstruction.runState.spec.status,
    "contract-revision":
      reconstruction.authority.workAccord.identity.revision.toString(),
    "last-receipt": receiptDigest,
    attention: attention(reconstruction),
    "target-repository":
      reconstruction.authority.workAccord.binding.repositoryFullName,
    "run-attempt": `${reconstruction.runState.spec.runId}/${reconstruction.runState.spec.runAttempt}`,
    "current-draft-pr":
      draft === null ? null : `#${draft.number}@${draft.headSha}`,
    "current-stage-agent": currentStageAgent(reconstruction),
    "stage-interaction": stageInteraction(reconstruction),
    "agent-selection-status": agentSelectionStatus(reconstruction)
  };
  return createDemoProjectionState({
    demoProjectId: reconstruction.runState.spec.demoProjectId,
    repositoryId: reconstruction.runState.spec.repositoryId,
    workItemNodeId: reconstruction.runState.spec.workItemNodeId,
    projectBindingDigest: contracts.profile.spec.projectBindingDigest,
    authorityEpoch: reconstruction.runState.spec.authorityEpoch,
    generation: reconstruction.runState.spec.generation,
    kernelStateVersion: reconstruction.kernelSnapshot.stateVersion,
    kernelReceiptDigest: reconstruction.kernelSnapshot.receiptHead,
    stageReceiptDigest: receiptDigest,
    fields: contracts.projection.spec.fields.map((field) => ({
      key: field.key,
      value: values[field.key]
    })),
    observedAt: input.observedAt
  });
}

function sameProjection(
  actual: DemoProjectionState,
  expected: DemoProjectionState
): boolean {
  return canonicalJson({
    ...actual.spec,
    observedAt: expected.spec.observedAt
  }) === canonicalJson(expected.spec);
}

function sameProjectionMetadata(
  actual: DemoProjectionState,
  expected: DemoProjectionState
): boolean {
  return canonicalJson({
    demoProjectId: actual.spec.demoProjectId,
    repositoryId: actual.spec.repositoryId,
    workItemNodeId: actual.spec.workItemNodeId,
    projectBindingDigest: actual.spec.projectBindingDigest,
    authorityEpoch: actual.spec.authorityEpoch,
    generation: actual.spec.generation,
    kernelStateVersion: actual.spec.kernelStateVersion,
    kernelReceiptDigest: actual.spec.kernelReceiptDigest,
    stageReceiptDigest: actual.spec.stageReceiptDigest
  }) ===
    canonicalJson({
      demoProjectId: expected.spec.demoProjectId,
      repositoryId: expected.spec.repositoryId,
      workItemNodeId: expected.spec.workItemNodeId,
      projectBindingDigest: expected.spec.projectBindingDigest,
      authorityEpoch: expected.spec.authorityEpoch,
      generation: expected.spec.generation,
      kernelStateVersion: expected.spec.kernelStateVersion,
      kernelReceiptDigest: expected.spec.kernelReceiptDigest,
      stageReceiptDigest: expected.spec.stageReceiptDigest
    });
}

function assertBoundProjection(
  reconstruction: DemoRuntimeReconstruction,
  state: DemoProjectionState
): DemoProjectionResult["kind"] | null {
  const expectedBinding =
    reconstruction.authority.contracts.profile.spec.projectBindingDigest;
  if (
    state.spec.demoProjectId !== reconstruction.runState.spec.demoProjectId ||
    state.spec.repositoryId !== reconstruction.runState.spec.repositoryId ||
    state.spec.workItemNodeId !==
      reconstruction.runState.spec.workItemNodeId ||
    state.spec.projectBindingDigest !== expectedBinding
  ) {
    fail("projection port returned a different trusted Project binding");
  }
  if (
    state.spec.authorityEpoch > reconstruction.runState.spec.authorityEpoch ||
    state.spec.generation > reconstruction.runState.spec.generation ||
    state.spec.kernelStateVersion > reconstruction.kernelSnapshot.stateVersion
  ) {
    return "reconciliation-required";
  }
  if (
    projectedDemoStageLeadsKernel(
      fieldValue(state, "stage"),
      reconstruction.kernelSnapshot.state
    )
  ) {
    return "reconciliation-required";
  }
  if (
    state.spec.kernelStateVersion ===
      reconstruction.kernelSnapshot.stateVersion &&
    state.spec.kernelReceiptDigest !== reconstruction.kernelSnapshot.receiptHead
  ) {
    return "reconciliation-required";
  }
  if (
    state.spec.stageReceiptDigest !== null &&
    !reconstruction.runState.spec.journey.completedStageReceiptDigests.includes(
      state.spec.stageReceiptDigest
    )
  ) {
    return "reconciliation-required";
  }
  return null;
}

function nextProjectionState(input: {
  readonly current: DemoProjectionState;
  readonly expected: DemoProjectionState;
  readonly field: DemoProjectionFieldKey;
  readonly stageLast: boolean;
}): DemoProjectionState {
  const fields = input.current.spec.fields.map((field) =>
    field.key === input.field
      ? { key: field.key, value: fieldValue(input.expected, input.field) }
      : field
  );
  return createDemoProjectionState(
    input.stageLast
      ? { ...input.expected.spec, fields }
      : {
          ...input.current.spec,
          fields,
          observedAt: input.expected.spec.observedAt
        }
  );
}

async function readStableAfterAmbiguousWrite(input: {
  readonly port: DemoProjectionPort;
  readonly intended: DemoProjectionState;
}): Promise<DemoProjectionState | null> {
  const first = validateDemoProjectionState(await input.port.read());
  const second = validateDemoProjectionState(await input.port.read());
  return first.contentDigest === second.contentDigest &&
    second.contentDigest === input.intended.contentDigest
    ? second
    : null;
}

export function demoProjectionIsConverged(
  reconstruction: DemoRuntimeReconstruction,
  observedAt: string
): boolean {
  const expected = deriveDemoProjectionState({ reconstruction, observedAt });
  return sameProjection(reconstruction.projection, expected);
}

export async function convergeDemoProjection(input: {
  readonly reconstruction: DemoRuntimeReconstruction;
  readonly port: DemoProjectionPort;
  readonly observedAt: string;
}): Promise<DemoProjectionResult> {
  const expected = deriveDemoProjectionState(input);
  let current = validateDemoProjectionState(await input.port.read());
  const bound = assertBoundProjection(input.reconstruction, current);
  if (bound !== null) {
    const reason =
      current.spec.kernelStateVersion >
        input.reconstruction.kernelSnapshot.stateVersion ||
      projectedDemoStageLeadsKernel(
        fieldValue(current, "stage"),
        input.reconstruction.kernelSnapshot.state
      )
        ? "PROJECTION_AHEAD"
        : "PROJECTION_DIVERGED";
    return {
      kind: "reconciliation-required",
      projection: current,
      writes: [],
      reason
    };
  }
  if (sameProjection(current, expected)) {
    return { kind: "converged", projection: current, writes: [] };
  }
  const mapping = input.reconstruction.authority.contracts.projection.spec.fields;
  const ordered = [...mapping].sort(
    (left, right) => left.writeOrder - right.writeOrder
  );
  if (
    ordered.at(-1)?.key !== "stage" ||
    ordered.filter((field) => field.key === "stage").length !== 1
  ) {
    fail("projection mapping does not write Kernel Stage last");
  }
  const writes: DemoProjectionFieldKey[] = [];
  for (const mappingField of ordered) {
    const key = mappingField.key;
    const metadataFlush =
      key === "stage" && !sameProjectionMetadata(current, expected);
    if (
      fieldValue(current, key) === fieldValue(expected, key) &&
      !metadataFlush
    ) {
      continue;
    }
    const intended = nextProjectionState({
      current,
      expected,
      field: key,
      stageLast: key === "stage"
    });
    try {
      await input.port.write({
        expectedStateDigest: current.contentDigest,
        field: key,
        expectedCurrentValue: fieldValue(current, key),
        next: intended
      });
    } catch (error) {
      if (
        !(error instanceof DemoProjectionWriteError) ||
        !error.outcomeAmbiguous
      ) {
        throw error;
      }
      const reconciled = await readStableAfterAmbiguousWrite({
        port: input.port,
        intended
      });
      if (reconciled === null) {
        return {
          kind: "reconciliation-required",
          projection: validateDemoProjectionState(await input.port.read()),
          writes,
          reason: "WRITE_ACKNOWLEDGEMENT_AMBIGUOUS"
        };
      }
      current = reconciled;
      writes.push(key);
      continue;
    }
    const observed = validateDemoProjectionState(await input.port.read());
    if (
      observed.contentDigest !== intended.contentDigest ||
      fieldValue(observed, key) !== fieldValue(expected, key)
    ) {
      return {
        kind: "reconciliation-required",
        projection: observed,
        writes,
        reason: "READ_AFTER_WRITE_MISMATCH"
      };
    }
    const afterBound = assertBoundProjection(input.reconstruction, observed);
    if (afterBound !== null) {
      return {
        kind: "reconciliation-required",
        projection: observed,
        writes,
        reason: "PROJECTION_DIVERGED"
      };
    }
    current = observed;
    writes.push(key);
  }
  if (!sameProjection(current, expected)) {
    return {
      kind: "reconciliation-required",
      projection: current,
      writes,
      reason: "READ_AFTER_WRITE_MISMATCH"
    };
  }
  return { kind: "converged", projection: current, writes };
}
