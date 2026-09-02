import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnySchema } from "ajv";
import { parse } from "yaml";

import {
  advanceDemoJourney,
  assertDemoModelOutputHasNoControlFields,
  assertDocument,
  createDemoContract,
  demoContractContentDigest,
  digest,
  validateDemoContract,
  validateDemoIssueIntake,
  validateDemoJourneyClosure,
  validateDemoProjectContractSet,
  validateDemoRegistrationShards,
  workAccordBindingDigest,
  type CapabilityRegistry,
  type DemoContractKind,
  type DemoJourneyDefinition,
  type DemoIssueFormBinding,
  type DemoProjectContractSet,
  type DemoRunFence,
  type DemoRunState,
  type KernelResult,
  type KernelSnapshot,
  type LifecycleGraph,
  type SignedStageReceipt,
  type StageAgentBindingSet,
  type StageArtifactEnvelope,
  type TransitionReceipt,
  type WorkAccord
} from "../src/index.js";

const ROOT = "config/v1alpha1/demo-projects/feature-delivery";
const FIXTURES = "tests/fixtures/demos/feature-delivery";
const SCHEMAS = "schemas/v1alpha1/demo-projects/feature-delivery";
const ACCEPTANCE_IDS = [
  "FD-AC-001",
  "FD-AC-002",
  "FD-AC-003",
  "FD-AC-004",
  "FD-AC-005"
] as const;
const STAGES = [
  "intake",
  "requirements-clarification",
  "codebase-discovery",
  "solution-design",
  "implementation-plan",
  "build",
  "test-and-verification",
  "human-review",
  "completed"
] as const;
const MODEL_STAGES = [
  "requirements-clarification",
  "codebase-discovery",
  "solution-design",
  "build",
  "test-and-verification"
] as const;
const COMMAND_IDS = [
  "fd-acceptance-tests",
  "fd-regression-tests",
  "fd-typecheck",
  "git-diff-check"
] as const;

interface AddressedDocument {
  readonly apiVersion: string;
  readonly kind: string;
  readonly schemaVersion: string;
  readonly contentDigest: string;
  readonly spec: Readonly<Record<string, unknown>>;
}

interface RuntimeBindingDocument {
  readonly spec: {
    readonly stageBindings: readonly {
      readonly stageId: string;
      readonly executionKind: string;
      readonly runtimeBindings: readonly {
        readonly agent: string;
        readonly skill: string;
        readonly capability: string;
        readonly workflow: string;
      }[];
    }[];
    readonly controlBindings: readonly {
      readonly stageId: string;
      readonly runtimeBindings: readonly unknown[];
    }[];
  };
}

async function readJson(relativePath: string): Promise<unknown> {
  return JSON.parse(await readFile(relativePath, "utf8")) as unknown;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Readonly<Record<string, unknown>>;
}

function addressed(value: unknown): AddressedDocument {
  const document = asRecord(value);
  return document as unknown as AddressedDocument;
}

function assertContentAddress(document: AddressedDocument): void {
  assert.equal(
    document.contentDigest,
    digest({
      apiVersion: document.apiVersion,
      kind: document.kind,
      schemaVersion: document.schemaVersion,
      spec: document.spec
    })
  );
}

async function assertSchemaValid(
  schemaPath: string,
  document: unknown
): Promise<void> {
  const result = await schemaResult(schemaPath, document);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
}

async function schemaResult(
  schemaPath: string,
  document: unknown
): Promise<{
  readonly valid: boolean;
  readonly errors: unknown;
}> {
  const schema = await readJson(schemaPath);
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(schema as AnySchema);
  return {
    valid: validate(document) === true,
    errors: validate.errors ?? []
  };
}

function acceptanceIds(value: unknown): readonly string[] {
  assert.ok(Array.isArray(value));
  return value.map((entry) => {
    assert.equal(typeof entry, "string");
    return entry;
  });
}

function collectKeys(value: unknown, result = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) collectKeys(entry, result);
    return result;
  }
  if (value === null || typeof value !== "object") return result;
  for (const [key, entry] of Object.entries(value)) {
    result.add(key);
    collectKeys(entry, result);
  }
  return result;
}

async function featureAuthority(): Promise<{
  readonly catalog: ReturnType<typeof validateDemoContract<"DemoCatalog">>;
  readonly reservations: ReturnType<
    typeof validateDemoContract<"DemoIdentityReservationManifest">
  >;
  readonly lifecycle: LifecycleGraph;
  readonly registry: CapabilityRegistry;
  readonly contracts: DemoProjectContractSet;
  readonly accord: WorkAccord;
}> {
  const catalog = validateDemoContract(
    "DemoCatalog",
    await readJson("config/v1alpha1/demo-portfolio/catalog.json")
  );
  const reservations = validateDemoContract(
    "DemoIdentityReservationManifest",
    await readJson("config/v1alpha1/demo-portfolio/identity-reservations.json")
  );
  const lifecycle = assertDocument(
    "LifecycleGraph",
    await readJson("config/v1alpha1/lifecycle.json")
  );
  const registry = assertDocument(
    "CapabilityRegistry",
    await readJson("config/v1alpha1/capability-registry.json")
  );
  const profile = validateDemoContract(
    "DemoProjectProfile",
    await readJson(`${ROOT}/project-profile.json`)
  );
  const journey = validateDemoContract(
    "DemoJourneyDefinition",
    await readJson(`${ROOT}/journey.json`)
  );
  const capabilities = validateDemoContract(
    "DemoCapabilityRegistryShard",
    await readJson(`${ROOT}/capabilities.json`)
  );
  const bindings = validateDemoContract(
    "StageAgentBindingSet",
    await readJson(`${ROOT}/runtime-bindings.json`)
  );
  const activation = validateDemoContract(
    "DemoActivationProfile",
    await readJson(`${ROOT}/activation-profile.json`)
  );
  const projection = validateDemoContract(
    "DemoProjectionMapping",
    await readJson(`${ROOT}/projection-mapping.json`)
  );
  const enabledActivation = createDemoContract("DemoActivationProfile", {
    ...activation.spec,
    enabled: true
  });
  const contracts = validateDemoProjectContractSet({
    catalog,
    reservations,
    lifecycle,
    baseRegistry: registry,
    contracts: {
      profile,
      journey,
      capabilities,
      bindings,
      activation: enabledActivation,
      projection
    }
  });
  const accord = assertDocument(
    "WorkAccord",
    await readJson(`${FIXTURES}/work-accord.json`)
  );
  return { catalog, reservations, lifecycle, registry, contracts, accord };
}

function initialFeatureRun(
  authority: Awaited<ReturnType<typeof featureAuthority>>
): DemoRunState {
  const { catalog, reservations, contracts, accord } = authority;
  return createDemoContract("DemoRunState", {
    demoProjectId: "feature-delivery",
    catalogDigest: catalog.contentDigest,
    identityReservationsDigest: reservations.contentDigest,
    projectProfileDigest: contracts.profile.contentDigest,
    journeyDefinitionDigest: contracts.journey.contentDigest,
    stageAgentBindingsDigest: contracts.bindings.contentDigest,
    capabilityShardDigest: contracts.capabilities.contentDigest,
    activationProfileDigest: contracts.activation.contentDigest,
    projectionMappingDigest: contracts.projection.contentDigest,
    repositoryId: accord.binding.repositoryId,
    workItemNodeId: accord.binding.workItemNodeId,
    repositoryBindingDigest: contracts.profile.spec.repositoryBindingDigest,
    authorityEpoch: contracts.activation.spec.authorityEpoch,
    generation: 0,
    runId: "feature-delivery-runtime-proof",
    runAttempt: 1,
    core: {
      state: "ACTIVATION_PENDING",
      stateVersion: 0,
      bindingDigest: workAccordBindingDigest(accord),
      lifecycleGraphDigest: contracts.journey.spec.lifecycleGraphDigest,
      workAccordDigest: digest(accord),
      capabilityRegistryDigest: accord.policy.capabilityRegistryDigest,
      domainPackDigest: accord.policy.domainPackDigest,
      phaseContractDigest: null,
      compiledPolicyDigest: null,
      policyDigest: accord.binding.policyDigest,
      kernelReceiptDigest: null,
      kernelSnapshotDigest: digest("feature-delivery-activation-snapshot")
    },
    journey: {
      currentStageId: "intake",
      currentStageOrdinal: 1,
      previousStageReceiptDigest: null,
      completedStageReceiptDigests: []
    },
    fenceDigest: null,
    fenceBaseRunStateDigest: null,
    currentDraftPullRequest: null,
    status: "ready",
    updatedAt: "2026-08-29T12:00:00Z"
  });
}

function fencedFeatureRun(ready: DemoRunState): {
  readonly runState: DemoRunState;
  readonly acquired: DemoRunFence;
  readonly released: DemoRunFence;
} {
  const acquired = createDemoContract("DemoRunFence", {
    demoProjectId: ready.spec.demoProjectId,
    repositoryId: ready.spec.repositoryId,
    workItemNodeId: ready.spec.workItemNodeId,
    fenceKey: digest({
      repositoryId: ready.spec.repositoryId,
      workItemNodeId: ready.spec.workItemNodeId
    }),
    authorityEpoch: ready.spec.authorityEpoch,
    generation: ready.spec.generation,
    runId: ready.spec.runId,
    runAttempt: ready.spec.runAttempt,
    runStateDigest: ready.contentDigest,
    dispatchDecisionDigest: digest(
      `feature-delivery-dispatch:${ready.spec.journey.currentStageId}`
    ),
    holderDigest: digest(
      `feature-delivery-holder:${ready.spec.journey.currentStageId}`
    ),
    activationLeaseDigest: digest("feature-delivery-synthetic-lease"),
    previousFenceDigest: null,
    status: "acquired",
    acquiredAt: "2026-08-29T12:00:10Z",
    expiresAt: "2026-08-29T12:05:10Z",
    releasedAt: null
  });
  const runState = createDemoContract("DemoRunState", {
    ...ready.spec,
    fenceDigest: acquired.contentDigest,
    fenceBaseRunStateDigest: ready.contentDigest,
    status: "running",
    updatedAt: acquired.spec.acquiredAt
  });
  const released = createDemoContract("DemoRunFence", {
    ...acquired.spec,
    previousFenceDigest: acquired.contentDigest,
    status: "released",
    releasedAt: "2026-08-29T12:00:50Z"
  });
  return { runState, acquired, released };
}

function featureStageArtifact(
  runState: DemoRunState,
  journey: DemoJourneyDefinition,
  bindings: StageAgentBindingSet
): StageArtifactEnvelope {
  const stage =
    journey.spec.stages[runState.spec.journey.currentStageOrdinal - 1]!;
  const runtime =
    bindings.spec.stageBindings[runState.spec.journey.currentStageOrdinal - 1]
      ?.runtimeBindings[0];
  return createDemoContract("StageArtifactEnvelope", {
    demoProjectId: runState.spec.demoProjectId,
    stageId: stage.stageId,
    projectProfileDigest: runState.spec.projectProfileDigest,
    journeyDefinitionDigest: journey.contentDigest,
    stageAgentBindingsDigest: bindings.contentDigest,
    authorityEpoch: runState.spec.authorityEpoch,
    generation: runState.spec.generation,
    runId: runState.spec.runId,
    runAttempt: runState.spec.runAttempt,
    producer:
      runtime === undefined
        ? {
            kind:
              stage.executionKind === "human"
                ? ("human" as const)
                : ("deterministic" as const),
            agentId: null,
            capabilityId: null,
            workflowId: null
          }
        : {
            kind: "model" as const,
            agentId: runtime.agent,
            capabilityId: runtime.capability,
            workflowId: runtime.workflow
          },
    inputDigest: digest(`feature-delivery-input:${stage.stageId}`),
    artifact: {
      kind: "FeatureDeliverySyntheticStageArtifact",
      schemaVersion: "1.0.0",
      mediaType: "application/json",
      byteLength: 2,
      contentDigest: digest({})
    },
    createdAt: "2026-08-29T12:00:30Z"
  });
}

function destinationPhaseDigest(
  state: DemoRunState["spec"]["core"]["state"],
  accord: WorkAccord
): `sha256:${string}` | null {
  const phase =
    state === "FRAMING"
      ? "framing"
      : state === "PLANNED"
        ? "planning"
        : state === "EXECUTING"
          ? "execution"
          : state === "VERIFYING"
            ? "verification"
            : state === "HUMAN_REVIEW"
              ? "human-review"
              : state === "COMPLETED"
                ? "human-review"
              : null;
  return phase === null ? null : accord.policy.phaseContracts[phase]!.digest;
}

function featureKernelResult(
  runState: DemoRunState,
  nextState: DemoRunState["spec"]["core"]["state"],
  lifecycle: LifecycleGraph,
  accord: WorkAccord
): KernelResult {
  const route = lifecycle.routes.find(
    (candidate) =>
      candidate.from === runState.spec.core.state && candidate.to === nextState
  );
  assert.notEqual(route, undefined);
  const eventId = `feature-delivery-event-${runState.spec.journey.currentStageOrdinal}`;
  const eventDigest = digest(eventId);
  const idempotencyKey = digest(`idempotency:${eventId}`);
  const effects = [{ type: "emit-receipt" as const, eventId }];
  const destinationContractDigest = destinationPhaseDigest(nextState, accord);
  const destinationCompiledPolicyDigest =
    destinationContractDigest === null
      ? null
      : nextState === "COMPLETED"
        ? runState.spec.core.compiledPolicyDigest
      : digest(`compiled:${nextState}:${runState.spec.core.stateVersion + 1}`);
  const receipt: TransitionReceipt = {
    schemaVersion: "1.0.0",
    eventId,
    eventDigest,
    routeId: route!.id,
    routeVersion: route!.version,
    from: route!.from,
    to: route!.to,
    stateVersion: runState.spec.core.stateVersion + 1,
    previousReceipt: runState.spec.core.kernelReceiptDigest,
    idempotencyKey,
    replacementAuthorityDigest: null,
    bindingDigest: runState.spec.core.bindingDigest,
    lifecycleGraphDigest: runState.spec.core.lifecycleGraphDigest,
    workAccordDigest: runState.spec.core.workAccordDigest,
    capabilityRegistryDigest: runState.spec.core.capabilityRegistryDigest,
    domainPackDigest: runState.spec.core.domainPackDigest,
    destinationBindingDigest: runState.spec.core.bindingDigest,
    destinationLifecycleGraphDigest: runState.spec.core.lifecycleGraphDigest,
    destinationWorkAccordDigest: runState.spec.core.workAccordDigest,
    destinationCapabilityRegistryDigest:
      runState.spec.core.capabilityRegistryDigest,
    destinationDomainPackDigest: runState.spec.core.domainPackDigest,
    sourcePhaseContractDigest: runState.spec.core.phaseContractDigest,
    sourceCompiledPolicyDigest: runState.spec.core.compiledPolicyDigest,
    destinationPhaseContractDigest: destinationContractDigest,
    destinationCompiledPolicyDigest,
    policyDigest: runState.spec.core.policyDigest,
    destinationPolicyDigest: runState.spec.core.policyDigest,
    actorId: "synthetic-system",
    actorAuthorizationDigest: digest(`authorization:${eventId}`),
    occurredAt: "2026-08-29T12:01:00Z",
    effectPlanDigest: digest(effects)
  };
  const receiptDigest = digest(receipt);
  const snapshot: KernelSnapshot = {
    schemaVersion: "1.0.0",
    lifecycleVersion: "1.0.0",
    lifecycleGraphDigest: receipt.destinationLifecycleGraphDigest,
    state: nextState,
    phaseOwner: route!.phaseOwner,
    stateVersion: receipt.stateVersion,
    lastEventSequence: receipt.stateVersion,
    bindingDigest: receipt.destinationBindingDigest,
    workAccordDigest: receipt.destinationWorkAccordDigest,
    capabilityRegistryDigest: receipt.destinationCapabilityRegistryDigest,
    domainPackDigest: receipt.destinationDomainPackDigest,
    phaseContractDigest: receipt.destinationPhaseContractDigest,
    compiledPolicyDigest: receipt.destinationCompiledPolicyDigest,
    policyDigest: receipt.destinationPolicyDigest,
    currentHead: accord.binding.currentHead,
    receiptHead: receiptDigest,
    suspendedState: null,
    recoveryState: null,
    usage: {
      calls: 0,
      tokens: 0,
      costUnits: 0,
      loops: 0,
      retries: 0
    },
    phaseUsage: {
      calls: 0,
      tokens: 0,
      costUnits: 0,
      loops: 0,
      retries: 0
    },
    routeAttempts: { [route!.id]: 1 },
    processedEvents: {
      [eventId]: {
        eventDigest,
        receiptDigest,
        idempotencyKey,
        deliveryId: `delivery-${eventId}`
      }
    }
  };
  return {
    kind: "applied",
    route: route!,
    snapshot,
    receipt,
    receiptDigest,
    effects
  };
}

function coreFromKernelResult(
  result: Extract<KernelResult, { readonly kind: "applied" }>
): DemoRunState["spec"]["core"] {
  return {
    state: result.snapshot.state,
    stateVersion: result.snapshot.stateVersion,
    bindingDigest: result.snapshot.bindingDigest,
    lifecycleGraphDigest: result.snapshot.lifecycleGraphDigest,
    workAccordDigest: result.snapshot.workAccordDigest,
    capabilityRegistryDigest: result.snapshot.capabilityRegistryDigest,
    domainPackDigest: result.snapshot.domainPackDigest,
    phaseContractDigest: result.snapshot.phaseContractDigest,
    compiledPolicyDigest: result.snapshot.compiledPolicyDigest,
    policyDigest: result.snapshot.policyDigest,
    kernelReceiptDigest: result.snapshot.receiptHead,
    kernelSnapshotDigest: digest(result.snapshot)
  };
}

function featureStageReceipt(input: {
  readonly runState: DemoRunState;
  readonly journey: DemoJourneyDefinition;
  readonly artifact: StageArtifactEnvelope;
  readonly acquired: DemoRunFence | null;
  readonly released: DemoRunFence | null;
  readonly coreAfter: DemoRunState["spec"]["core"];
  readonly applied: KernelResult | null;
}): SignedStageReceipt {
  const current =
    input.journey.spec.stages[
      input.runState.spec.journey.currentStageOrdinal - 1
    ]!;
  const next =
    input.journey.spec.stages[
      input.runState.spec.journey.currentStageOrdinal
    ]!;
  const applied =
    input.applied?.kind === "applied" ? input.applied : null;
  const spec: SignedStageReceipt["spec"] = {
    demoProjectId: input.runState.spec.demoProjectId,
    projectProfileDigest: input.runState.spec.projectProfileDigest,
    journeyDefinitionDigest: input.journey.contentDigest,
    stageAgentBindingsDigest: input.runState.spec.stageAgentBindingsDigest,
    authorityEpoch: input.runState.spec.authorityEpoch,
    generation: input.runState.spec.generation,
    runId: input.runState.spec.runId,
    runAttempt: input.runState.spec.runAttempt,
    runStateDigest: input.runState.contentDigest,
    stageId: current.stageId,
    stageOrdinal: current.ordinal,
    nextStageId: next.stageId,
    nextStageOrdinal: next.ordinal,
    previousStageReceiptDigest:
      input.runState.spec.journey.previousStageReceiptDigest,
    artifactEnvelopeDigest: input.artifact.contentDigest,
    runFenceDigest: input.acquired?.contentDigest ?? null,
    releasedRunFenceDigest: input.released?.contentDigest ?? null,
    coreBefore: input.runState.spec.core,
    coreAfter: input.coreAfter,
    kernelTransitionReceiptDigest: applied?.receiptDigest ?? null,
    appliedKernelResultDigest: applied === null ? null : digest(applied),
    outcome: "completed",
    completedAt: "2026-08-29T12:02:00Z"
  };
  return validateDemoContract("SignedStageReceipt", {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "SignedStageReceipt",
    schemaVersion: "1.0.0",
    contentDigest: demoContractContentDigest("SignedStageReceipt", spec),
    spec,
    signature: {
      algorithm: "ed25519",
      keyId: "feature-delivery:synthetic-stage-key",
      value: "c2lnbmF0dXJl"
    }
  });
}

function advanceFeatureStage(
  ready: DemoRunState,
  authority: Awaited<ReturnType<typeof featureAuthority>>
): DemoRunState {
  const current =
    authority.contracts.journey.spec.stages[
      ready.spec.journey.currentStageOrdinal - 1
    ]!;
  const next =
    authority.contracts.journey.spec.stages[
      ready.spec.journey.currentStageOrdinal
    ]!;
  const fenced =
    current.executionKind === "model" ? fencedFeatureRun(ready) : null;
  const runState = fenced?.runState ?? ready;
  const artifact = featureStageArtifact(
    runState,
    authority.contracts.journey,
    authority.contracts.bindings
  );
  const result =
    current.coreState === next.coreState
      ? null
      : featureKernelResult(
          runState,
          next.coreState,
          authority.lifecycle,
          authority.accord
        );
  const coreAfter =
    result?.kind === "applied"
      ? coreFromKernelResult(result)
      : runState.spec.core;
  const receipt = featureStageReceipt({
    runState,
    journey: authority.contracts.journey,
    artifact,
    acquired: fenced?.acquired ?? null,
    released: fenced?.released ?? null,
    coreAfter,
    applied: result
  });
  return advanceDemoJourney({
    runState,
    authority: {
      catalog: authority.catalog,
      reservations: authority.reservations,
      lifecycle: authority.lifecycle,
      baseRegistry: authority.registry,
      contracts: authority.contracts
    },
    receipt,
    artifact,
    runFence: fenced?.acquired ?? null,
    releasedRunFence: fenced?.released ?? null,
    appliedKernelResult: result,
    workAccord: result === null ? null : authority.accord,
    verifier: { verify: () => true }
  });
}

test("Feature Delivery installs one closed canonical contract set", async () => {
  const catalog = validateDemoContract(
    "DemoCatalog",
    await readJson("config/v1alpha1/demo-portfolio/catalog.json")
  );
  const reservations = validateDemoContract(
    "DemoIdentityReservationManifest",
    await readJson("config/v1alpha1/demo-portfolio/identity-reservations.json")
  );
  const lifecycle = assertDocument(
    "LifecycleGraph",
    await readJson("config/v1alpha1/lifecycle.json")
  );
  const registry = assertDocument(
    "CapabilityRegistry",
    await readJson("config/v1alpha1/capability-registry.json")
  );
  const profile = validateDemoContract(
    "DemoProjectProfile",
    await readJson(`${ROOT}/project-profile.json`)
  );
  const journey = validateDemoContract(
    "DemoJourneyDefinition",
    await readJson(`${ROOT}/journey.json`)
  );
  const capabilities = validateDemoContract(
    "DemoCapabilityRegistryShard",
    await readJson(`${ROOT}/capabilities.json`)
  );
  const bindings = validateDemoContract(
    "StageAgentBindingSet",
    await readJson(`${ROOT}/runtime-bindings.json`)
  );
  const activation = validateDemoContract(
    "DemoActivationProfile",
    await readJson(`${ROOT}/activation-profile.json`)
  );
  const projection = validateDemoContract(
    "DemoProjectionMapping",
    await readJson(`${ROOT}/projection-mapping.json`)
  );

  const contracts = validateDemoProjectContractSet({
    catalog,
    reservations,
    lifecycle,
    baseRegistry: registry,
    contracts: {
      profile,
      journey,
      capabilities,
      bindings,
      activation,
      projection
    }
  });
  assert.equal(contracts.activation.spec.enabled, false);
  assert.deepEqual(
    contracts.journey.spec.stages.map((stage) => stage.stageId),
    STAGES
  );
  assert.deepEqual(
    contracts.bindings.spec.stageBindings
      .filter((entry) => entry.runtimeBindings.length === 1)
      .map((entry) => entry.stageId),
    MODEL_STAGES
  );
  assert.ok(
    contracts.bindings.spec.stageBindings
      .filter((entry) => !MODEL_STAGES.includes(entry.stageId as (typeof MODEL_STAGES)[number]))
      .every((entry) => entry.runtimeBindings.length === 0)
  );
  assert.ok(
    contracts.bindings.spec.controlBindings.every(
      (entry) => entry.runtimeBindings.length === 0
    )
  );
  assert.equal(
    validateDemoRegistrationShards({
      catalog,
      reservations,
      baseRegistry: registry,
      shards: [{ capabilities, bindings }]
    }).length,
    5
  );
});

test("Feature Delivery artifacts and control fixtures are closed and content addressed", async () => {
  const templateNames = [
    "feature-brief",
    "codebase-impact-analysis",
    "solution-design",
    "implementation-plan",
    "target-free-patch",
    "draft-pr-evidence",
    "verification-report",
    "human-review-package"
  ] as const;
  for (const name of templateNames) {
    const document = addressed(await readJson(`${ROOT}/templates/${name}.json`));
    assertContentAddress(document);
    await assertSchemaValid(`${SCHEMAS}/${name}.schema.json`, document);
  }

  const controlSchema = `${SCHEMAS}/control-fixtures.schema.json`;
  for (const name of [
    "trusted-binding",
    "project-binding",
    "logical-targets",
    "verification-commands"
  ]) {
    const document = addressed(await readJson(`${ROOT}/${name}.json`));
    assertContentAddress(document);
    await assertSchemaValid(controlSchema, document);
  }

  const accord = assertDocument(
    "WorkAccord",
    await readJson(`${FIXTURES}/work-accord.json`)
  );
  const targets = addressed(await readJson(`${ROOT}/logical-targets.json`));
  const targetSpec = targets.spec as {
    readonly targets: readonly { readonly path: string }[];
  };
  assert.deepEqual(
    accord.policy.allowedPaths,
    targetSpec.targets.map((target) => target.path)
  );
  assert.equal(accord.binding.currentHead, digest("8f594d53db291f6bb2803f26d421a70ced556362"));

  for (const phase of [
    "framing",
    "planning",
    "execution",
    "verification",
    "human-review"
  ] as const) {
    const contract = assertDocument(
      "PhaseContract",
      await readJson(`${ROOT}/phase-contracts/${phase}.json`)
    );
    assert.equal(accord.policy.phaseContracts[phase]?.digest, digest(contract));
  }
});

test("stable acceptance criteria trace through design, plan, patch, tests, and review", async () => {
  const feature = addressed(await readJson(`${ROOT}/templates/feature-brief.json`));
  const impact = addressed(
    await readJson(`${ROOT}/templates/codebase-impact-analysis.json`)
  );
  const design = addressed(
    await readJson(`${ROOT}/templates/solution-design.json`)
  );
  const plan = addressed(
    await readJson(`${ROOT}/templates/implementation-plan.json`)
  );
  const patch = addressed(
    await readJson(`${ROOT}/templates/target-free-patch.json`)
  );
  const verification = addressed(
    await readJson(`${ROOT}/templates/verification-report.json`)
  );
  const humanReview = addressed(
    await readJson(`${ROOT}/templates/human-review-package.json`)
  );
  const featureCriteria = feature.spec.acceptanceCriteria as readonly {
    readonly id: string;
  }[];
  assert.deepEqual(
    featureCriteria.map((criterion) => criterion.id),
    ACCEPTANCE_IDS
  );
  assert.deepEqual(acceptanceIds(impact.spec.acceptanceCriterionIds), ACCEPTANCE_IDS);
  assert.deepEqual(acceptanceIds(design.spec.acceptanceCriterionIds), ACCEPTANCE_IDS);
  assert.deepEqual(acceptanceIds(patch.spec.acceptanceCriterionIds), ACCEPTANCE_IDS);
  assert.deepEqual(
    acceptanceIds(humanReview.spec.acceptanceCriterionIds),
    ACCEPTANCE_IDS
  );
  const planNodes = plan.spec.nodes as readonly {
    readonly id: string;
    readonly dependsOn: readonly string[];
    readonly acceptanceCriterionIds: readonly string[];
    readonly logicalSlots: readonly string[];
    readonly verificationCommandIds: readonly string[];
  }[];
  const seen = new Set<string>();
  for (const node of planNodes) {
    assert.ok(node.dependsOn.every((dependency) => seen.has(dependency)));
    seen.add(node.id);
  }
  assert.deepEqual(
    [...new Set(planNodes.flatMap((node) => node.acceptanceCriterionIds))].sort(),
    [...ACCEPTANCE_IDS].sort()
  );
  assert.ok(
    planNodes.every(
      (node) =>
        JSON.stringify(node.verificationCommandIds) === JSON.stringify(COMMAND_IDS)
    )
  );
  const verificationCriteria = verification.spec.acceptanceCriteria as readonly {
    readonly id: string;
    readonly status: string;
  }[];
  assert.deepEqual(
    verificationCriteria.map((criterion) => criterion.id),
    ACCEPTANCE_IDS
  );
  assert.ok(
    verificationCriteria
      .slice(0, 4)
      .every((criterion) => criterion.status === "passed")
  );
  assert.equal(verificationCriteria[4]?.status, "pending");
});

test("the deterministic plan and target-free patch cannot select repository controls", async () => {
  const targetMap = addressed(await readJson(`${ROOT}/logical-targets.json`));
  const patch = addressed(
    await readJson(`${ROOT}/templates/target-free-patch.json`)
  );
  const targetSpec = targetMap.spec as {
    readonly targets: readonly { readonly slot: string; readonly path: string }[];
  };
  const patchSpec = patch.spec as {
    readonly changes: readonly {
      readonly slot: string;
      readonly content: string;
      readonly contentDigest: string;
    }[];
  };
  assert.deepEqual(
    patchSpec.changes.map((change) => change.slot),
    targetSpec.targets.map((target) => target.slot)
  );
  assert.ok(
    patchSpec.changes.every(
      (change) => change.contentDigest === digest(change.content)
    )
  );
  const forbidden = new Set([
    "repository",
    "repositoryFullName",
    "path",
    "branch",
    "pullRequest",
    "stage",
    "route",
    "capability",
    "credential",
    "retry",
    "effect",
    "merge"
  ]);
  assert.deepEqual(
    [...collectKeys(patch.spec)].filter((key) => forbidden.has(key)),
    []
  );
  assert.throws(
    () =>
      assertDemoModelOutputHasNoControlFields({
        summary: "Untrusted model output.",
        route: "review.accept"
      }),
    /prohibited control field/u
  );
});

test("the fixed acceptance command executes the generated test directly", async () => {
  const targetMap = addressed(await readJson(`${ROOT}/logical-targets.json`));
  const patch = addressed(
    await readJson(`${ROOT}/templates/target-free-patch.json`)
  );
  const commands = addressed(
    await readJson(`${ROOT}/verification-commands.json`)
  );
  const targets = (
    targetMap.spec as {
      readonly targets: readonly { readonly slot: string; readonly path: string }[];
    }
  ).targets;
  const changes = (
    patch.spec as {
      readonly changes: readonly { readonly slot: string; readonly content: string }[];
    }
  ).changes;
  const acceptance = (
    commands.spec as {
      readonly commands: readonly {
        readonly id: string;
        readonly executable: string;
        readonly args: readonly string[];
      }[];
    }
  ).commands.find((command) => command.id === "fd-acceptance-tests");
  assert.deepEqual(acceptance, {
    id: "fd-acceptance-tests",
    purpose: "acceptance",
    executable: "node",
    args: [
      "--test",
      "examples/demos/feature-delivery/sandbox/tests/export.test.ts"
    ],
    timeoutMs: 120000,
    maxOutputBytes: 65536
  });

  const workspace = await mkdtemp(path.join(tmpdir(), "feature-delivery-demo-"));
  try {
    for (const change of changes) {
      const target = targets.find((candidate) => candidate.slot === change.slot);
      assert.notEqual(target, undefined);
      const destination = path.join(workspace, target!.path);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, change.content, "utf8");
    }
    const result = spawnSync(acceptance!.executable, acceptance!.args, {
      cwd: workspace,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? ""
      }
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("framework receipts advance the hermetic journey to Human review and human evidence completes", async () => {
  const authority = await featureAuthority();
  let runState = initialFeatureRun(authority);
  let externalCalls = 0;
  const visited = [runState.spec.journey.currentStageId];
  while (runState.spec.journey.currentStageId !== "human-review") {
    runState = advanceFeatureStage(runState, authority);
    visited.push(runState.spec.journey.currentStageId);
  }
  assert.deepEqual(visited, STAGES.slice(0, 8));
  assert.equal(runState.spec.core.state, "HUMAN_REVIEW");
  assert.equal(runState.spec.status, "waiting-human");
  assert.equal(
    runState.spec.journey.completedStageReceiptDigests.length,
    7
  );
  assert.equal(externalCalls, 0);

  const humanEvidence = asRecord(
    await readJson(`${FIXTURES}/human-continuation.json`)
  );
  assert.equal(humanEvidence.sourceStageId, "human-review");
  assert.equal(humanEvidence.destinationStageId, "completed");
  assert.equal(humanEvidence.kernelRouteId, "review.accept");
  assert.equal(asRecord(humanEvidence.humanActor).independent, true);
  runState = advanceFeatureStage(runState, authority);
  assert.equal(runState.spec.journey.currentStageId, "completed");
  assert.equal(runState.spec.core.state, "COMPLETED");
  assert.equal(runState.spec.status, "completed");
  assert.equal(runState.spec.journey.completedStageReceiptDigests.length, 8);
  assert.equal(externalCalls, 0);
});

test("hands-off execution stops at Human review and only synthetic human evidence completes", async () => {
  const run = asRecord(await readJson(`${FIXTURES}/hands-off-run.json`)) as {
    readonly stageExecutions: readonly {
      readonly stageId: string;
      readonly executionKind: string;
      readonly modelCalls: number;
    }[];
    readonly stageReceipts: readonly {
      readonly stageId: string;
      readonly nextStageId: string;
      readonly sameCoreState: boolean;
      readonly kernelRouteId: string | null;
      readonly previousReceiptDigest: string | null;
      readonly receiptDigest: string;
    }[];
    readonly verificationCommandIds: readonly string[];
    readonly automatedReviewEvent: string;
    readonly externalCalls: number;
    readonly status: string;
    readonly currentStageId: string;
    readonly automationCanComplete: boolean;
  };
  assert.deepEqual(
    run.stageExecutions.map((stage) => stage.stageId),
    STAGES.slice(0, 8)
  );
  assert.ok(
    run.stageExecutions.every(
      (stage) =>
        stage.modelCalls === (stage.executionKind === "model" ? 1 : 0)
    )
  );
  assert.equal(
    run.stageExecutions.reduce((total, stage) => total + stage.modelCalls, 0),
    5
  );
  assert.equal(run.stageReceipts.length, 7);
  for (const [index, receipt] of run.stageReceipts.entries()) {
    assert.equal(receipt.stageId, STAGES[index]);
    assert.equal(receipt.nextStageId, STAGES[index + 1]);
    assert.equal(
      receipt.previousReceiptDigest,
      run.stageReceipts[index - 1]?.receiptDigest ?? null
    );
    assert.equal(
      receipt.kernelRouteId === null,
      receipt.sameCoreState
    );
  }
  assert.deepEqual(run.verificationCommandIds, COMMAND_IDS);
  assert.equal(run.automatedReviewEvent, "COMMENT");
  assert.equal(run.externalCalls, 0);
  assert.equal(run.status, "waiting-human");
  assert.equal(run.currentStageId, "human-review");
  assert.equal(run.automationCanComplete, false);

  const continuation = asRecord(
    await readJson(`${FIXTURES}/human-continuation.json`)
  );
  assert.equal(continuation.sourceStageId, "human-review");
  assert.equal(continuation.destinationStageId, "completed");
  assert.equal(continuation.kernelRouteId, "review.accept");
  assert.equal(continuation.modelCalls, 0);
  assert.equal(continuation.externalCalls, 0);
  const actor = asRecord(continuation.humanActor);
  assert.equal(actor.independent, true);
  assert.equal(actor.bot, false);
  assert.equal(continuation.approvalBindsReviewedHead, true);
  assert.equal(continuation.mergeObservationAuthenticated, true);
  const completionCriteria = continuation.acceptanceCriteria as readonly {
    readonly id: string;
    readonly status: string;
    readonly evidenceDigests: readonly string[];
  }[];
  assert.deepEqual(completionCriteria, [
    {
      id: "FD-AC-005",
      status: "passed",
      evidenceDigests: [
        "sha256:5555555555555555555555555555555555555555555555555555555555555555"
      ]
    }
  ]);
});

test("repair, retry, reconciliation, and reauthorization fixtures fail closed", async () => {
  const recovery = asRecord(
    await readJson(`${FIXTURES}/recovery-cases.json`)
  ) as {
    readonly cases: readonly {
      readonly id: string;
      readonly route: string;
      readonly expected: string;
      readonly generationChange: number;
      readonly fullVerificationRequired: boolean;
    }[];
    readonly externalCalls: number;
  };
  assert.deepEqual(
    recovery.cases.map((entry) => entry.id),
    [
      "clarification",
      "pause",
      "block",
      "cancel",
      "repair",
      "replan",
      "revision",
      "retry",
      "partial-effect",
      "lost-ack",
      "reauthorization"
    ]
  );
  assert.equal(recovery.externalCalls, 0);
  assert.equal(
    recovery.cases.find((entry) => entry.id === "partial-effect")?.expected,
    "reconcile-without-blind-retry"
  );
  assert.equal(
    recovery.cases.find((entry) => entry.id === "lost-ack")?.expected,
    "two-stable-exact-reads"
  );
  assert.ok(
    recovery.cases
      .filter((entry) => entry.generationChange === 1)
      .every((entry) => entry.fullVerificationRequired)
  );
  assert.equal(
    recovery.cases.find((entry) => entry.id === "revision")
      ?.fullVerificationRequired,
    true
  );

  const adversarial = asRecord(
    await readJson(`${FIXTURES}/adversarial-cases.json`)
  ) as {
    readonly cases: readonly string[];
    readonly expected: {
      readonly decision: string;
      readonly beforeInferenceOrEffect: boolean;
      readonly externalCalls: number;
      readonly repositoryEffects: number;
    };
  };
  assert.equal(new Set(adversarial.cases).size, adversarial.cases.length);
  assert.ok(
    [
      "missing-stage",
      "generic-agent-fallback",
      "cross-demo-evidence",
      "missing-consent",
      "repository-substitution",
      "prompt-injection",
      "model-selected-path",
      "model-selected-route",
      "model-selected-effect",
      "oversized-artifact",
      "protected-path",
      "unexpected-diff",
      "head-movement",
      "partial-effect-blind-retry",
      "lost-ack-blind-retry",
      "stale-reauthorization"
    ].every((id) => adversarial.cases.includes(id))
  );
  assert.deepEqual(adversarial.expected, {
    decision: "refuse",
    beforeInferenceOrEffect: true,
    externalCalls: 0,
    repositoryEffects: 0
  });
});

test("substituted stages, agents, capabilities, consent, targets, and heads are rejected", async () => {
  const catalog = validateDemoContract(
    "DemoCatalog",
    await readJson("config/v1alpha1/demo-portfolio/catalog.json")
  );
  const reservations = validateDemoContract(
    "DemoIdentityReservationManifest",
    await readJson("config/v1alpha1/demo-portfolio/identity-reservations.json")
  );
  const lifecycle = assertDocument(
    "LifecycleGraph",
    await readJson("config/v1alpha1/lifecycle.json")
  );
  const registry = assertDocument(
    "CapabilityRegistry",
    await readJson("config/v1alpha1/capability-registry.json")
  );
  const profile = validateDemoContract(
    "DemoProjectProfile",
    await readJson(`${ROOT}/project-profile.json`)
  );
  const journey = validateDemoContract(
    "DemoJourneyDefinition",
    await readJson(`${ROOT}/journey.json`)
  );
  const capabilities = validateDemoContract(
    "DemoCapabilityRegistryShard",
    await readJson(`${ROOT}/capabilities.json`)
  );
  const bindings = validateDemoContract(
    "StageAgentBindingSet",
    await readJson(`${ROOT}/runtime-bindings.json`)
  );

  const missingStage = createDemoContract("DemoJourneyDefinition", {
    ...journey.spec,
    stages: journey.spec.stages.slice(1)
  });
  assert.throws(
    () =>
      validateDemoJourneyClosure({
        catalog,
        reservations,
        profile,
        journey: missingStage,
        lifecycle
      }),
    /reserved canonical stages|initial/u
  );

  const mutateBinding = (
    mutation: (
      runtime: StageAgentBindingSet["spec"]["stageBindings"][number]["runtimeBindings"][number]
    ) => StageAgentBindingSet["spec"]["stageBindings"][number]["runtimeBindings"][number]
  ): StageAgentBindingSet =>
    createDemoContract("StageAgentBindingSet", {
      ...bindings.spec,
      stageBindings: bindings.spec.stageBindings.map((entry) =>
        entry.stageId !== "requirements-clarification"
          ? entry
          : {
              ...entry,
              runtimeBindings: entry.runtimeBindings.map(mutation)
            }
      )
    });
  for (const badBindings of [
    mutateBinding((runtime) => ({ ...runtime, agent: "runtime-framer" })),
    mutateBinding((runtime) => ({
      ...runtime,
      capability: "demo.feature-delivery.solution-design@1.0.0"
    }))
  ]) {
    assert.throws(
      () =>
        validateDemoRegistrationShards({
          catalog,
          reservations,
          baseRegistry: registry,
          shards: [{ capabilities, bindings: badBindings }]
        }),
      /substitutes a reserved runtime identity/u
    );
  }

  const activationValue = asRecord(
    await readJson(`${ROOT}/activation-profile.json`)
  );
  const activationSpec = {
    ...asRecord(activationValue.spec),
    consentRequired: false
  };
  assert.throws(
    () =>
      validateDemoContract("DemoActivationProfile", {
        ...activationValue,
        contentDigest: demoContractContentDigest(
          "DemoActivationProfile" as DemoContractKind,
          activationSpec
        ),
        spec: activationSpec
      }),
    /validation failed/u
  );

  const trustedBinding = structuredClone(
    await readJson(`${ROOT}/trusted-binding.json`)
  ) as {
    apiVersion: string;
    kind: string;
    schemaVersion: string;
    contentDigest: string;
    spec: { repository: { fullName: string } };
  };
  trustedBinding.spec.repository.fullName = "attacker/example";
  assert.equal(
    (
      await schemaResult(
        `${SCHEMAS}/control-fixtures.schema.json`,
        trustedBinding
      )
    ).valid,
    true
  );
  const { contentDigest: _contentDigest, ...substitutedBody } = trustedBinding;
  const substitutedDigest = digest(substitutedBody);
  assert.notEqual(trustedBinding.contentDigest, substitutedDigest);
  assert.notEqual(profile.spec.repositoryBindingDigest, substitutedDigest);
  const entry = catalog.spec.entries.find(
    (candidate) => candidate.id === "feature-delivery"
  )!;
  const projectSchema = assertDocument(
    "GitHubProjectSchema",
    await readJson(`${ROOT}/project-schema.json`)
  );
  const formBinding: DemoIssueFormBinding = {
    demoProjectId: "feature-delivery",
    title: entry.title,
    formId: "feature-delivery",
    issueFormPath: ".github/ISSUE_TEMPLATE/feature-delivery.yml",
    projectSchemaPath:
      "config/v1alpha1/demo-projects/feature-delivery/project-schema.json",
    projectProfileRef: entry.projectProfileRef,
    projectSchemaDigest: digest(projectSchema),
    consentField: "demo-consent"
  };
  const activation = validateDemoContract(
    "DemoActivationProfile",
    await readJson(`${ROOT}/activation-profile.json`)
  );
  const decision = validateDemoIssueIntake({
    catalog,
    reservations,
    coreSchema: await readJson("config/v1alpha1/github-project.json"),
    schema: projectSchema,
    binding: formBinding,
    profile,
    activation: createDemoContract("DemoActivationProfile", {
      ...activation.spec,
      enabled: true
    }),
    repositoryBindingDigest: substitutedDigest,
    projectBinding: null,
    submission: {
      desiredOutcome: "Produce one bounded customer change.",
      repositoryHint: "untrusted/example-repository",
      constraints: "No deployment.",
      acceptanceEvidence: "Fixed checks pass.",
      depthProfile: "D2",
      consent: true
    },
    submitterId: 1,
    issueNodeId: "I_synthetic_feature_delivery",
    evaluatedAt: "2026-09-01T12:00:00Z",
    maxProjectBindingAgeMs: 5 * 60 * 1000
  });
  assert.equal(decision.status, "blocked");
  if (decision.status === "blocked") {
    assert.equal(decision.code, "REPOSITORY_BINDING_STALE");
    assert.deepEqual(decision.authority, {
      credentials: "denied",
      budgetReservation: "denied",
      inference: "denied",
      issueCreation: "denied"
    });
  }

  const oversizedPatch = structuredClone(
    await readJson(`${ROOT}/templates/target-free-patch.json`)
  ) as {
    spec: { changes: { content: string }[] };
  };
  oversizedPatch.spec.changes[0]!.content = "x".repeat(32769);
  assert.equal(
    (
      await schemaResult(
        `${SCHEMAS}/target-free-patch.schema.json`,
        oversizedPatch
      )
    ).valid,
    false
  );

  const report = addressed(
    await readJson(`${ROOT}/templates/verification-report.json`)
  );
  assert.notEqual(report.spec.headSha, "dddddddddddddddddddddddddddddddddddddddd");
  assert.equal(report.spec.headMovementInvalidates, true);
});

test("each model stage has an exclusive agent, skill, source, and generated lock", async () => {
  const bindings = (await readJson(
    `${ROOT}/runtime-bindings.json`
  )) as RuntimeBindingDocument;
  const modelBindings = bindings.spec.stageBindings.flatMap((entry) =>
    entry.runtimeBindings.map((runtime) => ({
      stageId: entry.stageId,
      ...runtime
    }))
  );
  assert.equal(modelBindings.length, 5);
  assert.equal(
    new Set(modelBindings.map((binding) => binding.agent)).size,
    modelBindings.length
  );
  assert.equal(
    new Set(modelBindings.map((binding) => binding.capability)).size,
    modelBindings.length
  );
  assert.equal(
    new Set(modelBindings.map((binding) => binding.workflow)).size,
    modelBindings.length
  );
  for (const binding of modelBindings) {
    assert.equal(binding.agent, `feature-delivery-${binding.stageId}`);
    assert.equal(binding.skill, binding.agent);
    assert.equal(binding.workflow, binding.agent);
    const source = await readFile(
      `.github/workflows/${binding.workflow}.md`,
      "utf8"
    );
    const frontmatter = /^---\n([\s\S]*?)\n---\n/u.exec(source);
    assert.notEqual(frontmatter?.[1], undefined);
    const parsed = parse(frontmatter![1]!) as {
      readonly engine: { readonly agent: string };
      readonly skills: readonly string[];
    };
    assert.equal(parsed.engine.agent, binding.agent);
    assert.ok(
      parsed.skills.includes(`.github/skills/${binding.skill}`)
    );
    await readFile(`.github/agents/${binding.agent}.agent.md`, "utf8");
    await readFile(`.github/skills/${binding.skill}/SKILL.md`, "utf8");
    await readFile(`.github/workflows/${binding.workflow}.lock.yml`, "utf8");
  }
  const workflowFiles = (await readdir(".github/workflows")).filter((name) =>
    name.startsWith("feature-delivery-")
  );
  assert.equal(workflowFiles.length, 10);
});
