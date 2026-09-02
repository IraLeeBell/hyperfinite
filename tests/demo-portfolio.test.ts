import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { parse } from "yaml";

import catalogDocument from "../config/v1alpha1/demo-portfolio/catalog.json" with { type: "json" };
import reservationsDocument from "../config/v1alpha1/demo-portfolio/identity-reservations.json" with { type: "json" };
import registryDocument from "../config/v1alpha1/capability-registry.json" with { type: "json" };
import lifecycleDocument from "../config/v1alpha1/lifecycle.json" with { type: "json" };
import policyDocument from "../config/v1alpha1/policy.json" with { type: "json" };
import accordDocument from "../examples/v1alpha1/work-accord.json" with { type: "json" };
import {
  CANONICAL_DEMO_CATALOG_ENTRIES,
  DEMO_PROJECTION_VOCABULARY,
  advanceDemoJourney,
  assertDemoModelOutputHasNoControlFields,
  createDemoContract,
  demoContractContentDigest,
  digest,
  parseStrictJson,
  isExactReviewHeadScript,
  isExactReviewWorkspaceScript,
  PINNED_WORKFLOW_ACTIONS,
  assertDocument,
  validateDemoContract,
  validateDemoProjectContractSet,
  validateDemoJourneyClosure,
  validateDemoRegistrationShards,
  validatePortfolioFoundation,
  workAccordBindingDigest,
  type Capability,
  type CapabilityRegistry,
  type DemoCapabilityRegistryShard,
  type DemoContractKind,
  type DemoIdentityReservationManifest,
  type DemoJourneyDefinition,
  type DemoProjectId,
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

const catalog = validateDemoContract("DemoCatalog", catalogDocument);
const reservations = validateDemoContract(
  "DemoIdentityReservationManifest",
  reservationsDocument
);
const registry = assertDocument("CapabilityRegistry", registryDocument);
const lifecycle = lifecycleDocument as LifecycleGraph;
const accord = accordDocument as WorkAccord;
const PROJECTION_SOURCES = {
  stage: "kernel-snapshot",
  "journey-stage": "signed-stage-receipt",
  "demo-project-profile": "project-profile",
  "depth-profile": "work-accord",
  "gate-status": "demo-run-state",
  "contract-revision": "work-accord",
  "last-receipt": "signed-stage-receipt",
  attention: "demo-run-state",
  "target-repository": "trusted-binding",
  "run-attempt": "demo-run-state",
  "current-draft-pr": "demo-run-state",
  "current-stage-agent": "stage-agent-selection",
  "stage-interaction": "stage-agent-binding-set",
  "agent-selection-status": "stage-agent-selection"
} as const;

function addressed<K extends DemoContractKind>(
  kind: K,
  spec: unknown,
  extra: Readonly<Record<string, unknown>> = {}
): unknown {
  const schemaVersion =
    kind === "StageAgentBindingSet" || kind === "DemoDispatchDecision"
      ? "2.0.0"
      : "1.0.0";
  return {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind,
    schemaVersion,
    contentDigest: demoContractContentDigest(kind, spec, schemaVersion),
    spec,
    ...extra
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function projectReservation(demoProjectId: DemoProjectId) {
  const project = reservations.spec.projects.find(
    (candidate) => candidate.demoProjectId === demoProjectId
  );
  assert.notEqual(project, undefined);
  return project!;
}

function phaseForState(state: string): {
  readonly phase: "framing" | "execution" | "verification";
  readonly role: "framer" | "executor" | "reviewer";
  readonly workflowClass:
    | "framing-comment"
    | "target-free-execution"
    | "current-head-comment-review";
} {
  if (state === "FRAMING") {
    return {
      phase: "framing",
      role: "framer",
      workflowClass: "framing-comment"
    };
  }
  if (state === "EXECUTING") {
    return {
      phase: "execution",
      role: "executor",
      workflowClass: "target-free-execution"
    };
  }
  return {
    phase: "verification",
    role: "reviewer",
    workflowClass: "current-head-comment-review"
  };
}

function capabilityTemplate(phase: "framing" | "execution" | "verification") {
  const id =
    phase === "framing"
      ? "core.frame-artifact"
      : phase === "execution"
        ? "core.execute-bounded-change"
        : "core.review-current-head";
  const capability = registry.capabilities.find(
    (candidate) => candidate.id === id
  );
  assert.notEqual(capability, undefined);
  return capability!;
}

function demoShardPair(
  demoProjectId: DemoProjectId,
  references: {
    readonly projectProfileDigest: `sha256:${string}`;
    readonly journeyDefinitionDigest: `sha256:${string}`;
  } = {
    projectProfileDigest: digest(`${demoProjectId}:profile`),
    journeyDefinitionDigest: digest(`${demoProjectId}:journey`)
  }
): {
  readonly capabilities: DemoCapabilityRegistryShard;
  readonly bindings: StageAgentBindingSet;
} {
  const project = projectReservation(demoProjectId);
  const modelStages = project.journeyStages.filter(
    (stage) => stage.executionKind === "model"
  );
  const capabilities = modelStages.map((stage) => {
    const expected = phaseForState(stage.coreState);
    const identity = stage.runtimeBindings[0]!;
    const template = capabilityTemplate(expected.phase);
    const separator = identity.capabilityId.lastIndexOf("@");
    const id = identity.capabilityId.slice(0, separator);
    const version = identity.capabilityId.slice(separator + 1);
    if (separator < 1 || id.length === 0 || version.length === 0) {
      throw new TypeError("reserved capability identity is malformed");
    }
    return {
      ...clone(template),
      id,
      version,
      description: `Reserved ${demoProjectId}/${stage.stageId} capability.`,
      allowedPhases: [expected.phase]
    } satisfies Capability;
  });
  const capabilityShard = createDemoContract("DemoCapabilityRegistryShard", {
    demoProjectId,
    catalogDigest: catalog.contentDigest,
    identityReservationsDigest: reservations.contentDigest,
    projectProfileDigest: references.projectProfileDigest,
    capabilities
  });
  const makeEntry = (
    stage: (typeof project.journeyStages)[number]
  ): StageAgentBindingSet["spec"]["stageBindings"][number] => {
    const identity = stage.runtimeBindings[0];
    if (identity === undefined) {
      return {
        stageId: stage.stageId,
        executionKind: stage.executionKind,
        participationMode: "none",
        userInputRequired: false,
        eligibleActorClasses: [],
        requiredEvidenceClass:
          stage.executionKind === "planning"
            ? "accepted-frame"
            : stage.executionKind === "human"
              ? "human-gate"
              : "none",
        selectionFieldKey: null,
        allowedOptionKeys: [],
        fallbackPolicy: "none",
        clearSelectionOnExit: false,
        runtimeBindings: []
      };
    }
    const expected = phaseForState(stage.coreState);
    return {
      stageId: stage.stageId,
      executionKind: stage.executionKind,
      participationMode: "fixed",
      userInputRequired: false,
      eligibleActorClasses: ["system"],
      requiredEvidenceClass:
        stage.coreState === "VERIFYING"
          ? "exact-current-head"
          : stage.coreState === "EXECUTING"
            ? "accepted-plan"
            : "activation",
      selectionFieldKey: null,
      allowedOptionKeys: [],
      fallbackPolicy: "none",
      clearSelectionOnExit: false,
      runtimeBindings: [
        {
          optionKey: null,
          userInvocable: false,
          agent: identity.agentId,
          skill: identity.agentId,
          safetySkills: ["authority-refusal"],
          capability: identity.capabilityId,
          workflow: identity.workflowId,
          workflowClass: expected.workflowClass,
          phase: expected.phase,
          role: expected.role,
          githubToolsets: expected.phase === "framing" ? ["issues"] : [],
          githubTools: expected.phase === "framing" ? ["issue_read"] : [],
          modelInvocationAllowed: true,
          slashCommand: {
            name: identity.workflowId,
            events:
              expected.phase === "verification"
                ? ["pull_request_comment"]
                : ["issue_comment"]
          }
        }
      ]
    };
  };
  const bindings = createDemoContract("StageAgentBindingSet", {
    demoProjectId,
    catalogDigest: catalog.contentDigest,
    identityReservationsDigest: reservations.contentDigest,
    projectProfileDigest: capabilityShard.spec.projectProfileDigest,
    journeyDefinitionDigest: references.journeyDefinitionDigest,
    capabilityShardDigest: capabilityShard.contentDigest,
    participationPolicyDigest: digest("synthetic-participation-policy"),
    stageBindings: project.journeyStages.map(makeEntry),
    controlBindings: project.controlStages.map((stage) => ({
      stageId: stage.stageId,
      executionKind: stage.executionKind,
      participationMode: "none",
      userInputRequired: false,
      eligibleActorClasses: ["system"],
      requiredEvidenceClass: "kernel-state",
      selectionFieldKey: null,
      allowedOptionKeys: [],
      fallbackPolicy: "none",
      clearSelectionOnExit: false,
      runtimeBindings: []
    }))
  });
  return { capabilities: capabilityShard, bindings };
}

function profileAndJourney(demoProjectId: DemoProjectId): {
  readonly profile: ReturnType<
    typeof createDemoContract<"DemoProjectProfile">
  >;
  readonly journey: DemoJourneyDefinition;
} {
  const entry = catalog.spec.entries.find(
    (candidate) => candidate.id === demoProjectId
  )!;
  const profile = createDemoContract("DemoProjectProfile", {
    demoProjectId,
    catalogDigest: catalog.contentDigest,
    identityReservationsDigest: reservations.contentDigest,
    title: entry.title,
    description: `${entry.title} synthetic profile.`,
    defaultDepthProfile: "D2",
    allowedDepthProfiles: ["D1", "D2"],
    repositoryBindingDigest: digest(`${demoProjectId}:repository`),
    projectBindingDigest: digest(`${demoProjectId}:project`),
    workAccordTemplateDigest: digest(`${demoProjectId}:accord-template`),
    journeyDefinitionRef: entry.journeyDefinitionRef,
    stageAgentBindingsRef: entry.stageAgentBindingsRef,
    capabilityShardRef: entry.capabilityShardRef,
    activationProfileRef: entry.activationProfileRef,
    projectionMappingRef: entry.projectionMappingRef
  });
  const project = projectReservation(demoProjectId);
  const journey = createDemoContract("DemoJourneyDefinition", {
    demoProjectId,
    catalogDigest: catalog.contentDigest,
    identityReservationsDigest: reservations.contentDigest,
    projectProfileDigest: profile.contentDigest,
    lifecycleGraphDigest: digest(lifecycle),
    initialStageId: "intake",
    terminalStageId: "completed",
    stages: project.journeyStages.map(
      ({ runtimeBindings: _runtimeBindings, ...stage }) => stage
    ),
    controlStages: project.controlStages.map(
      ({ runtimeBindings: _runtimeBindings, ...stage }) => stage
    )
  });
  return { profile, journey };
}

function demoContractSet(
  demoProjectId: DemoProjectId
): DemoProjectContractSet {
  const { profile, journey } = profileAndJourney(demoProjectId);
  const shard = demoShardPair(demoProjectId, {
    projectProfileDigest: profile.contentDigest,
    journeyDefinitionDigest: journey.contentDigest
  });
  const activation = createDemoContract("DemoActivationProfile", {
    demoProjectId,
    catalogDigest: catalog.contentDigest,
    projectProfileDigest: profile.contentDigest,
    stageAgentBindingsDigest: shard.bindings.contentDigest,
    capabilityShardDigest: shard.capabilities.contentDigest,
    enabled: true,
    authorityEpoch: 1,
    revocationGeneration: 0,
    allowedSubmitterIds: [1],
    allowedSource: "issue-form",
    consentField: "demo-consent",
    consentRequired: true,
    leaseTemplate: {
      maxCalls: 5,
      maxTokens: 10000,
      maxCostUnits: 100,
      maxDurationMs: 600000,
      maxRetries: 1,
      maxParallel: 1
    },
    validFrom: "2026-08-29T12:00:00Z",
    expiresAt: "2026-08-29T13:00:00Z",
    signingKeyId: "activation:key-1"
  });
  const projection = createDemoContract("DemoProjectionMapping", {
    demoProjectId,
    projectProfileDigest: profile.contentDigest,
    journeyDefinitionDigest: journey.contentDigest,
    stageAgentBindingsDigest: shard.bindings.contentDigest,
    fields: DEMO_PROJECTION_VOCABULARY.map((field, index) => ({
      ...field,
      source: PROJECTION_SOURCES[field.key],
      displayOnly: true,
      writeOrder:
        field.key === "stage" ? DEMO_PROJECTION_VOCABULARY.length : index
    }))
  });
  return validateDemoProjectContractSet({
    catalog,
    reservations,
    lifecycle,
    baseRegistry: registry,
    contracts: {
      profile,
      journey,
      capabilities: shard.capabilities,
      bindings: shard.bindings,
      activation,
      projection
    }
  });
}

function coreBinding(
  state: DemoRunState["spec"]["core"]["state"],
  stateVersion: number,
  overrides: Partial<DemoRunState["spec"]["core"]> = {}
): DemoRunState["spec"]["core"] {
  return {
    state,
    stateVersion,
    bindingDigest: digest("binding"),
    lifecycleGraphDigest: digest(lifecycle),
    workAccordDigest: digest(accord),
    capabilityRegistryDigest: digest(registry),
    domainPackDigest: accord.policy.domainPackDigest,
    phaseContractDigest: digest(`${state}:phase`),
    compiledPolicyDigest: digest(`${state}:compiled`),
    policyDigest: digest(policyDocument),
    kernelReceiptDigest: digest(`${state}:receipt-head`),
    kernelSnapshotDigest: digest(`${state}:snapshot`),
    ...overrides
  };
}

function runStateAt(
  contracts: DemoProjectContractSet,
  ordinal: number,
  core: DemoRunState["spec"]["core"]
): DemoRunState {
  const journey = contracts.journey;
  const stage = journey.spec.stages[ordinal - 1]!;
  const completed = Array.from({ length: ordinal - 1 }, (_value, index) =>
    digest(`stage-receipt:${index + 1}`)
  );
  return createDemoContract("DemoRunState", {
    demoProjectId: journey.spec.demoProjectId,
    catalogDigest: catalog.contentDigest,
    identityReservationsDigest: reservations.contentDigest,
    projectProfileDigest: contracts.profile.contentDigest,
    journeyDefinitionDigest: journey.contentDigest,
    stageAgentBindingsDigest: contracts.bindings.contentDigest,
    capabilityShardDigest: contracts.capabilities.contentDigest,
    activationProfileDigest: contracts.activation.contentDigest,
    projectionMappingDigest: contracts.projection.contentDigest,
    repositoryId: 1,
    workItemNodeId: "I_demo",
    repositoryBindingDigest: contracts.profile.spec.repositoryBindingDigest,
    authorityEpoch: 1,
    generation: 0,
    runId: "run-1",
    runAttempt: 1,
    core,
    journey: {
      currentStageId: stage.stageId,
      currentStageOrdinal: ordinal,
      previousStageReceiptDigest: completed.at(-1) ?? null,
      completedStageReceiptDigests: completed
    },
    fenceDigest: null,
    fenceBaseRunStateDigest: null,
    currentDraftPullRequest: null,
    status: "ready",
    updatedAt: "2026-08-29T12:00:00Z"
  });
}

function fencedRunState(ready: DemoRunState): {
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
    dispatchDecisionDigest: digest("dispatch-decision"),
    holderDigest: digest("fence-holder"),
    activationLeaseDigest: digest("activation-lease"),
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

function stageArtifact(
  runState: DemoRunState,
  journey: DemoJourneyDefinition,
  bindingSet: StageAgentBindingSet,
  producerOverride?: StageArtifactEnvelope["spec"]["producer"]
): StageArtifactEnvelope {
  const stage =
    journey.spec.stages[runState.spec.journey.currentStageOrdinal - 1]!;
  const runtime =
    bindingSet.spec.stageBindings[runState.spec.journey.currentStageOrdinal - 1]
      ?.runtimeBindings[0];
  const producer =
    producerOverride ??
    (runtime === undefined
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
        });
  return createDemoContract("StageArtifactEnvelope", {
    demoProjectId: runState.spec.demoProjectId,
    stageId: stage.stageId,
    projectProfileDigest: runState.spec.projectProfileDigest,
    journeyDefinitionDigest: journey.contentDigest,
    stageAgentBindingsDigest: bindingSet.contentDigest,
    authorityEpoch: runState.spec.authorityEpoch,
    generation: runState.spec.generation,
    runId: runState.spec.runId,
    runAttempt: runState.spec.runAttempt,
    producer,
    inputDigest: digest("stage-input"),
    artifact: {
      kind: "SyntheticStageArtifact",
      schemaVersion: "1.0.0",
      mediaType: "application/json",
      byteLength: 2,
      contentDigest: digest({})
    },
    createdAt: "2026-08-29T12:00:30Z"
  });
}

function signedReceipt(
  runState: DemoRunState,
  journey: DemoJourneyDefinition,
  artifact: StageArtifactEnvelope,
  acquired: DemoRunFence | null,
  released: DemoRunFence | null,
  coreAfter: DemoRunState["spec"]["core"],
  kernelTransitionReceiptDigest: `sha256:${string}` | null = null,
  appliedKernelResultDigest: `sha256:${string}` | null = null
): SignedStageReceipt {
  const current = journey.spec.stages[
    runState.spec.journey.currentStageOrdinal - 1
  ]!;
  const next = journey.spec.stages[
    runState.spec.journey.currentStageOrdinal
  ]!;
  const spec: SignedStageReceipt["spec"] = {
    demoProjectId: runState.spec.demoProjectId,
    projectProfileDigest: runState.spec.projectProfileDigest,
    journeyDefinitionDigest: journey.contentDigest,
    stageAgentBindingsDigest: runState.spec.stageAgentBindingsDigest,
    authorityEpoch: runState.spec.authorityEpoch,
    generation: runState.spec.generation,
    runId: runState.spec.runId,
    runAttempt: runState.spec.runAttempt,
    runStateDigest: runState.contentDigest,
    stageId: current.stageId,
    stageOrdinal: current.ordinal,
    nextStageId: next.stageId,
    nextStageOrdinal: next.ordinal,
    previousStageReceiptDigest:
      runState.spec.journey.previousStageReceiptDigest,
    artifactEnvelopeDigest: artifact.contentDigest,
    runFenceDigest: acquired?.contentDigest ?? null,
    releasedRunFenceDigest: released?.contentDigest ?? null,
    coreBefore: runState.spec.core,
    coreAfter,
    kernelTransitionReceiptDigest,
    appliedKernelResultDigest,
    outcome: "completed",
    completedAt: "2026-08-29T12:01:00Z"
  };
  return validateDemoContract(
    "SignedStageReceipt",
    addressed("SignedStageReceipt", spec, {
      signature: {
        algorithm: "ed25519",
        keyId: "stage-receipt:key-1",
        value: "c2lnbmF0dXJl"
      }
    })
  );
}

test("canonical portfolio catalog and identity reservations are exact and immutable", () => {
  const foundation = validatePortfolioFoundation(
    catalogDocument,
    reservationsDocument
  );
  assert.deepEqual(foundation.catalog.spec.entries, CANONICAL_DEMO_CATALOG_ENTRIES);
  assert.deepEqual(
    foundation.reservations.spec.projects.map((project) =>
      project.journeyStages.length
    ),
    [10, 9, 9, 9]
  );
  assert.equal(
    foundation.reservations.spec.projects.flatMap((project) =>
      project.journeyStages.flatMap((stage) => stage.runtimeBindings)
    ).length,
    23
  );
  assert.ok(
    foundation.reservations.spec.projects.every((project) =>
      [...project.journeyStages, ...project.controlStages].every((stage) =>
        stage.executionKind === "model"
          ? stage.runtimeBindings.length >= 1
          : stage.runtimeBindings.length === 0
      )
    )
  );
  assert.equal(Object.isFrozen(foundation.catalog), true);
  assert.equal(Object.isFrozen(foundation.catalog.spec.entries), true);
  assert.equal(
    Object.isFrozen(assertDocument("DemoCatalog", clone(catalogDocument))),
    true
  );
});

test("catalog order, versions, digests, and duplicate JSON keys fail closed", () => {
  const reversedSpec = {
    entries: [...catalog.spec.entries].reverse()
  };
  assert.throws(
    () => validateDemoContract("DemoCatalog", addressed("DemoCatalog", reversedSpec)),
    /exact canonical portfolio/u
  );
  assert.throws(
    () =>
      validateDemoContract("DemoCatalog", {
        ...catalogDocument,
        schemaVersion: "2.0.0"
      }),
    /validation failed/u
  );
  const { contentDigest: _contentDigest, ...missingDigest } = catalogDocument;
  assert.throws(
    () => validateDemoContract("DemoCatalog", missingDigest),
    /validation failed/u
  );
  assert.throws(
    () =>
      validateDemoContract("DemoCatalog", {
        ...catalogDocument,
        contentDigest: digest("wrong")
      }),
    /content digest/u
  );
  assert.throws(
    () =>
      parseStrictJson(
        '{"apiVersion":"agentic-framework.github.com/v1alpha1","kind":"DemoCatalog","kind":"DemoCatalog"}'
      ),
    /duplicate JSON object key "kind"/u
  );
});

test("identity reuse and cross-demo stage binding substitution fail before registration", () => {
  const mutated = {
    ...reservations.spec,
    projects: reservations.spec.projects.map((project, projectIndex) => ({
      ...project,
      journeyStages: project.journeyStages.map((stage, stageIndex) => {
        if (projectIndex !== 1 || stageIndex !== 1) return stage;
        const appIdentity =
          reservations.spec.projects[0]!.journeyStages.find(
            (candidate) => candidate.executionKind === "model"
          )!.runtimeBindings[0]!;
        return {
          ...stage,
          runtimeBindings: [appIdentity]
        };
      })
    }))
  };
  assert.throws(
    () =>
      validateDemoContract(
        "DemoIdentityReservationManifest",
        addressed("DemoIdentityReservationManifest", mutated)
      ),
    /canonical reservation set/u
  );

  assert.deepEqual(
    validateDemoRegistrationShards({
      catalog,
      reservations,
      baseRegistry: registry,
      shards: []
    }),
    []
  );
  const app = demoShardPair("app-modernization");
  assert.equal(
    validateDemoRegistrationShards({
      catalog,
      reservations,
      baseRegistry: registry,
      shards: [app]
    }).length,
    5
  );
  const substituteAgent = (agent: string) => ({
    ...app.bindings.spec,
    stageBindings: app.bindings.spec.stageBindings.map((entry) =>
      entry.runtimeBindings.length === 0
        ? entry
        : {
            ...entry,
            runtimeBindings: [
              {
                ...entry.runtimeBindings[0]!,
                agent
              }
            ]
          }
    )
  });
  const substitutedSpec = substituteAgent(
    "feature-delivery-requirements-clarification"
  );
  const substitutedBindings = validateDemoContract(
    "StageAgentBindingSet",
    addressed("StageAgentBindingSet", substitutedSpec)
  );
  assert.throws(
    () =>
      validateDemoRegistrationShards({
        catalog,
        reservations,
        baseRegistry: registry,
        shards: [
          {
            capabilities: app.capabilities,
            bindings: substitutedBindings
          }
        ]
      }),
    /substitutes a reserved runtime identity/u
  );
  const genericBindings = validateDemoContract(
    "StageAgentBindingSet",
    addressed("StageAgentBindingSet", substituteAgent("runtime-framer"))
  );
  assert.throws(
    () =>
      validateDemoRegistrationShards({
        catalog,
        reservations,
        baseRegistry: registry,
        shards: [
          {
            capabilities: app.capabilities,
            bindings: genericBindings
          }
        ]
      }),
    /substitutes a reserved runtime identity/u
  );
  const liveToolSpec = {
    ...app.bindings.spec,
    stageBindings: app.bindings.spec.stageBindings.map((entry) =>
      entry.runtimeBindings[0]?.workflowClass !==
      "current-head-comment-review"
        ? entry
        : {
            ...entry,
            runtimeBindings: [
              {
                ...entry.runtimeBindings[0],
                githubToolsets: ["pull_requests"],
                githubTools: ["get_pull_request"]
              }
            ]
          }
    )
  };
  assert.throws(
    () =>
      validateDemoRegistrationShards({
        catalog,
        reservations,
        baseRegistry: registry,
        shards: [
          {
            capabilities: app.capabilities,
            bindings: validateDemoContract(
              "StageAgentBindingSet",
              addressed("StageAgentBindingSet", liveToolSpec)
            )
          }
        ]
      }),
    /cannot use live GitHub tools/u
  );
  const widenedCapabilitySpec = {
    ...app.capabilities.spec,
    capabilities: app.capabilities.spec.capabilities.map((capability, index) =>
      index !== 0
        ? capability
        : {
            ...capability,
            allowedPhases: ["framing", "execution"] as const,
            access: {
              ...capability.access,
              tools: ["bash"],
              shellCommands: ["curl"],
              networkDestinations: ["https://example.com"]
            }
          }
    )
  };
  const widenedCapabilities = validateDemoContract(
    "DemoCapabilityRegistryShard",
    addressed("DemoCapabilityRegistryShard", widenedCapabilitySpec)
  );
  const widenedBindings = validateDemoContract(
    "StageAgentBindingSet",
    addressed("StageAgentBindingSet", {
      ...app.bindings.spec,
      capabilityShardDigest: widenedCapabilities.contentDigest
    })
  );
  assert.throws(
    () =>
      validateDemoRegistrationShards({
        catalog,
        reservations,
        baseRegistry: registry,
        shards: [
          {
            capabilities: widenedCapabilities,
            bindings: widenedBindings
          }
        ]
      }),
    /exceeds its workflow-class authority/u
  );
  const misplacedControlBindings = validateDemoContract(
    "StageAgentBindingSet",
    addressed("StageAgentBindingSet", {
      ...app.bindings.spec,
      stageBindings: [
        ...app.bindings.spec.stageBindings,
        app.bindings.spec.controlBindings[0]!
      ],
      controlBindings: app.bindings.spec.controlBindings.slice(1)
    })
  );
  assert.throws(
    () =>
      validateDemoRegistrationShards({
        catalog,
        reservations,
        baseRegistry: registry,
        shards: [
          {
            capabilities: app.capabilities,
            bindings: misplacedControlBindings
          }
        ]
      }),
    /partitions are incomplete or reordered/u
  );
});

test("workflow action manifests and exact-head scripts match pinned trusted templates", async () => {
  const reviewSource = await readFile(
    ".github/workflows/agentic-review.md",
    "utf8"
  );
  const frontmatterMatch = /^---\n([\s\S]*?)\n---\n/u.exec(reviewSource);
  assert.notEqual(frontmatterMatch?.[1], undefined);
  const frontmatter = parse(frontmatterMatch![1]!) as {
    readonly "pre-steps": readonly {
      readonly with?: { readonly script?: string };
    }[];
    readonly "pre-agent-steps": readonly {
      readonly with?: { readonly script?: string };
    }[];
  };
  const headScript = frontmatter["pre-steps"][1]?.with?.script;
  const workspaceScript =
    frontmatter["pre-agent-steps"][0]?.with?.script;
  assert.equal(typeof headScript, "string");
  assert.equal(typeof workspaceScript, "string");
  assert.equal(isExactReviewHeadScript(headScript!), true);
  assert.equal(
    isExactReviewWorkspaceScript(
      workspaceScript!,
      "runtime-reviewer",
      "current-head-review"
    ),
    true
  );
  assert.equal(
    isExactReviewHeadScript(`${headScript}\n// bypass marker`),
    false
  );
  assert.equal(
    isExactReviewWorkspaceScript(
      `${workspaceScript}\n// bypass marker`,
      "runtime-reviewer",
      "current-head-review"
    ),
    false
  );
  assert.equal(
    isExactReviewWorkspaceScript(
      workspaceScript!.replace(
        '".github/agents/runtime-reviewer.agent.md"',
        '".github/agents/__AGENT__.agent.md"'
      ),
      "runtime-reviewer",
      "current-head-review"
    ),
    false
  );
  for (const name of [
    "agentic-framing.lock.yml",
    "agentic-execution.lock.yml",
    "agentic-review.lock.yml"
  ]) {
    const lock = await readFile(`.github/workflows/${name}`, "utf8");
    const manifestMatch = /^# gh-aw-manifest: (.+)$/mu.exec(lock);
    assert.notEqual(manifestMatch?.[1], undefined);
    const manifest = JSON.parse(manifestMatch![1]!) as {
      readonly actions: readonly unknown[];
    };
    assert.deepEqual(manifest.actions, PINNED_WORKFLOW_ACTIONS);
  }
});

test("all four demo journeys close over the unchanged lifecycle", () => {
  for (const demoProjectId of [
    "app-modernization",
    "feature-delivery",
    "security-dependency-remediation",
    "adaptive-delivery"
  ] as const) {
    const { profile, journey } = profileAndJourney(demoProjectId);
    const closed = validateDemoJourneyClosure({
      catalog,
      reservations,
      profile,
      journey,
      lifecycle
    });
    assert.equal(closed.journey.spec.demoProjectId, demoProjectId);
  }
});

test("projection mapping uses fourteen display fields and writes Kernel Stage last", () => {
  const closed = demoContractSet("feature-delivery");
  const mapping = closed.projection;
  assert.equal(
    mapping.spec.fields.find((field) => field.key === "stage")?.writeOrder,
    DEMO_PROJECTION_VOCABULARY.length
  );
  assert.throws(
    () =>
      validateDemoContract(
        "DemoProjectionMapping",
        addressed("DemoProjectionMapping", {
          ...mapping.spec,
          fields: mapping.spec.fields.map((field) =>
            field.key === "depth-profile"
              ? { ...field, source: "kernel-snapshot" }
              : field
          )
        })
      ),
      /fourteen-field vocabulary and order/u
  );
  assert.equal(closed.profile.spec.demoProjectId, "feature-delivery");
});

test("activation, fence, artifact, dispatcher, scheduler, and refusal contracts are closed", () => {
  const activation = createDemoContract("DemoActivationProfile", {
    demoProjectId: "feature-delivery",
    catalogDigest: catalog.contentDigest,
    projectProfileDigest: digest("profile"),
    stageAgentBindingsDigest: digest("bindings"),
    capabilityShardDigest: digest("capabilities"),
    enabled: false,
    authorityEpoch: 1,
    revocationGeneration: 0,
    allowedSubmitterIds: [1],
    allowedSource: "issue-form",
    consentField: "demo-consent",
    consentRequired: true,
    leaseTemplate: {
      maxCalls: 5,
      maxTokens: 10000,
      maxCostUnits: 100,
      maxDurationMs: 600000,
      maxRetries: 1,
      maxParallel: 1
    },
    validFrom: "2026-08-29T12:00:00Z",
    expiresAt: "2026-08-29T13:00:00Z",
    signingKeyId: "activation:key-1"
  });
  assert.equal(activation.spec.enabled, false);

  const fence = createDemoContract("DemoRunFence", {
    demoProjectId: "feature-delivery",
    repositoryId: 1,
    workItemNodeId: "I_demo",
    fenceKey: digest({ repositoryId: 1, workItemNodeId: "I_demo" }),
    authorityEpoch: 1,
    generation: 0,
    runId: "run-1",
    runAttempt: 1,
    runStateDigest: digest("run-state"),
    dispatchDecisionDigest: digest("dispatch"),
    holderDigest: digest("holder"),
    activationLeaseDigest: digest("lease"),
    previousFenceDigest: null,
    status: "acquired",
    acquiredAt: "2026-08-29T12:00:00Z",
    expiresAt: "2026-08-29T12:05:00Z",
    releasedAt: null
  });
  assert.equal(fence.spec.status, "acquired");

  const artifact = createDemoContract("StageArtifactEnvelope", {
    demoProjectId: "feature-delivery",
    stageId: "solution-design",
    projectProfileDigest: digest("profile"),
    journeyDefinitionDigest: digest("journey"),
    stageAgentBindingsDigest: digest("bindings"),
    authorityEpoch: 1,
    generation: 0,
    runId: "run-1",
    runAttempt: 1,
    producer: {
      kind: "model",
      agentId: "feature-delivery-solution-design",
      capabilityId: "demo.feature-delivery.solution-design@1.0.0",
      workflowId: "feature-delivery-solution-design"
    },
    inputDigest: digest("input"),
    artifact: {
      kind: "FeatureSolutionDesign",
      schemaVersion: "1.0.0",
      mediaType: "application/json",
      byteLength: 10,
      contentDigest: digest("artifact")
    },
    createdAt: "2026-08-29T12:00:00Z"
  });
  assert.equal(artifact.spec.producer.kind, "model");

  const runtimeBinding = {
    agentId: "feature-delivery-solution-design",
    capabilityId: "demo.feature-delivery.solution-design@1.0.0",
    workflowId: "feature-delivery-solution-design"
  };
  const dispatch = createDemoContract("DemoDispatchDecision", {
    demoProjectId: "feature-delivery",
    runStateDigest: digest("run-state"),
    stageId: "solution-design",
    stageOrdinal: 4,
    action: "invoke-model",
    runtimeBinding,
    selectionGrantDigest: null,
    kernelRouteId: null,
    refusalDigest: null,
    reasonCode: "MODEL_STAGE_READY",
    decidedAt: "2026-08-29T12:00:00Z"
  });
  createDemoContract("DemoScheduleDecision", {
    demoProjectId: "feature-delivery",
    runStateDigest: digest("run-state"),
    dispatchDecisionDigest: dispatch.contentDigest,
    dispatchPersistenceReceiptDigest: digest("dispatch-persistence"),
    stageId: "solution-design",
    action: "reserve-and-invoke",
    runtimeBinding,
    runFenceDigest: fence.contentDigest,
    budgetReservation: { calls: 1, tokens: 1000, costUnits: 10 },
    refusalDigest: null,
    decidedAt: "2026-08-29T12:00:01Z"
  });
  createDemoContract("DemoRuntimeRefusal", {
    demoProjectId: "feature-delivery",
    stageId: "solution-design",
    inputDigest: digest("input"),
    code: "BINDING_INVALID",
    ruleId: "demo.binding.exact",
    message: "The stage binding is stale.",
    retryable: false,
    recovery: "new-contract",
    refusedAt: "2026-08-29T12:00:00Z"
  });
});

test("model output cannot supply control fields but retains logical target slots", () => {
  const safe = assertDemoModelOutputHasNoControlFields({
    summary: "Drafted bounded content.",
    targetSlots: ["implementation-source"],
    changes: [{ slot: "implementation-source", content: "safe" }]
  });
  assert.equal(Object.isFrozen(safe), true);
  for (const value of [
    { stageId: "build" },
    { nested: { agent: "feature-delivery-build" } },
    { route_id: "planning.execute" },
    { targetRepository: "github/other" },
    { effects: [] },
    { effects: [{ effectType: "merge" }] },
    { action: "request-kernel-transition" },
    { status: "completed" },
    { authorityEpoch: 99 }
  ]) {
    assert.throws(
      () => assertDemoModelOutputHasNoControlFields(value),
      /prohibited control field|outside the closed advisory vocabulary/u
    );
  }
});

test("same-core-state advancement is receipt-backed and cannot alter Kernel state", () => {
  const contracts = demoContractSet("app-modernization");
  const journey = contracts.journey;
  const ready = runStateAt(
    contracts,
    3,
    coreBinding("FRAMING", 5)
  );
  const { runState, acquired, released } = fencedRunState(ready);
  const artifact = stageArtifact(runState, journey, contracts.bindings);
  const receipt = signedReceipt(
    runState,
    journey,
    artifact,
    acquired,
    released,
    runState.spec.core
  );
  const advanced = advanceDemoJourney({
    runState,
    authority: {
      catalog,
      reservations,
      lifecycle,
      baseRegistry: registry,
      contracts
    },
    receipt,
    artifact,
    runFence: acquired,
    releasedRunFence: released,
    appliedKernelResult: null,
    workAccord: null,
    verifier: { verify: () => true }
  });
  assert.equal(advanced.spec.journey.currentStageId, "modernization-assessment");
  assert.equal(advanced.spec.core.stateVersion, runState.spec.core.stateVersion);
  assert.equal(Object.isFrozen(advanced), true);
  const wrongCatalogRun = createDemoContract("DemoRunState", {
    ...runState.spec,
    catalogDigest: digest("substituted-catalog")
  });
  const wrongCatalogArtifact = stageArtifact(
    wrongCatalogRun,
    journey,
    contracts.bindings
  );
  assert.throws(
    () =>
      advanceDemoJourney({
        runState: wrongCatalogRun,
        authority: {
          catalog,
          reservations,
          lifecycle,
          baseRegistry: registry,
          contracts
        },
        receipt: signedReceipt(
          wrongCatalogRun,
          journey,
          wrongCatalogArtifact,
          acquired,
          released,
          wrongCatalogRun.spec.core
        ),
        artifact: wrongCatalogArtifact,
        runFence: acquired,
        releasedRunFence: released,
        appliedKernelResult: null,
        workAccord: null,
        verifier: { verify: () => true }
      }),
    /does not bind the exact current demo run/u
  );
  const readyArtifact = stageArtifact(ready, journey, contracts.bindings);
  assert.throws(
    () =>
      advanceDemoJourney({
        runState: ready,
        authority: {
          catalog,
          reservations,
          lifecycle,
          baseRegistry: registry,
          contracts
        },
        receipt: signedReceipt(
          ready,
          journey,
          readyArtifact,
          acquired,
          released,
          ready.spec.core
        ),
        artifact: readyArtifact,
        runFence: null,
        releasedRunFence: null,
        appliedKernelResult: null,
        workAccord: null,
        verifier: { verify: () => true }
      }),
    /model stage cannot advance from ready/u
  );
  assert.throws(
    () =>
      advanceDemoJourney({
        runState,
        authority: {
          catalog,
          reservations,
          lifecycle,
          baseRegistry: registry,
          contracts
        },
        receipt: signedReceipt(
          runState,
          journey,
          artifact,
          acquired,
          released,
          {
            ...runState.spec.core,
            stateVersion: runState.spec.core.stateVersion + 1
          }
        ),
        artifact,
        runFence: acquired,
        releasedRunFence: released,
        appliedKernelResult: null,
        workAccord: null,
        verifier: { verify: () => true }
      }),
    /cannot alter or invent Kernel state/u
  );
  assert.throws(
    () =>
      advanceDemoJourney({
        runState: advanced,
        authority: {
          catalog,
          reservations,
          lifecycle,
          baseRegistry: registry,
          contracts
        },
        receipt,
        artifact,
        runFence: acquired,
        releasedRunFence: released,
        appliedKernelResult: null,
        workAccord: null,
        verifier: { verify: () => true }
      }),
    /exact current demo run/u
  );
  const humanArtifact = stageArtifact(
    runState,
    journey,
    contracts.bindings,
    {
      kind: "human",
      agentId: null,
      capabilityId: null,
      workflowId: null
    }
  );
  assert.throws(
    () =>
      advanceDemoJourney({
        runState,
        authority: {
          catalog,
          reservations,
          lifecycle,
          baseRegistry: registry,
          contracts
        },
        receipt: signedReceipt(
          runState,
          journey,
          humanArtifact,
          acquired,
          released,
          runState.spec.core
        ),
        artifact: humanArtifact,
        runFence: acquired,
        releasedRunFence: released,
        appliedKernelResult: null,
        workAccord: null,
        verifier: { verify: () => true }
      }),
    /producer does not match the reserved model binding/u
  );
});

test("cancelled non-model runs cannot resume through journey advancement", () => {
  const contracts = demoContractSet("app-modernization");
  const ready = runStateAt(
    contracts,
    2,
    coreBinding("FRAMING", 4)
  );
  const cancelled = createDemoContract("DemoRunState", {
    ...ready.spec,
    status: "cancelled",
    updatedAt: "2026-08-29T12:00:20Z"
  });
  const artifact = stageArtifact(
    cancelled,
    contracts.journey,
    contracts.bindings
  );
  const receipt = signedReceipt(
    cancelled,
    contracts.journey,
    artifact,
    null,
    null,
    cancelled.spec.core
  );
  assert.throws(
    () =>
      advanceDemoJourney({
        runState: cancelled,
        authority: {
          catalog,
          reservations,
          lifecycle,
          baseRegistry: registry,
          contracts
        },
        receipt,
        artifact,
        runFence: null,
        releasedRunFence: null,
        appliedKernelResult: null,
        workAccord: null,
        verifier: { verify: () => true }
      }),
    /deterministic stage cannot advance from cancelled/u
  );
});

function appliedPlanningResult(runState: DemoRunState): KernelResult {
  const route = lifecycle.routes.find(
    (candidate) => candidate.id === "framing.accept"
  )!;
  const eventId = "event-frame-accepted";
  const eventDigest = digest("event-frame-accepted");
  const idempotencyKey = digest("frame-idempotency");
  const effects = [
    { type: "emit-receipt" as const, eventId },
    {
      type: "enter-phase" as const,
      phase: "planning" as const,
      capabilities: []
    }
  ];
  const receipt: TransitionReceipt = {
    schemaVersion: "1.0.0",
    eventId,
    eventDigest,
    routeId: route.id,
    routeVersion: route.version,
    from: route.from,
    to: route.to,
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
    destinationPhaseContractDigest: accord.policy.phaseContracts.planning!.digest,
    destinationCompiledPolicyDigest: digest("planning-compiled"),
    policyDigest: runState.spec.core.policyDigest,
    destinationPolicyDigest: runState.spec.core.policyDigest,
    actorId: "reviewer-1",
    actorAuthorizationDigest: digest("reviewer-authorization"),
    occurredAt: "2026-08-29T12:01:00Z",
    effectPlanDigest: digest(effects)
  };
  const receiptDigest = digest(receipt);
  const snapshot: KernelSnapshot = {
    schemaVersion: "1.0.0",
    lifecycleVersion: "1.0.0",
    lifecycleGraphDigest: receipt.destinationLifecycleGraphDigest,
    state: "PLANNED",
    phaseOwner: "planning",
    stateVersion: receipt.stateVersion,
    lastEventSequence: 1,
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
    routeAttempts: { [route.id]: 1 },
    processedEvents: {
      [eventId]: {
        eventDigest,
        receiptDigest,
        idempotencyKey,
        deliveryId: "delivery-frame-accepted"
      }
    }
  };
  return {
    kind: "applied",
    route,
    snapshot,
    receipt,
    receiptDigest,
    effects
  };
}

test("cross-core advancement requires the exact applied Kernel result and receipt", () => {
  const contracts = demoContractSet("app-modernization");
  const journey = contracts.journey;
  const source = coreBinding("FRAMING", 5, {
    bindingDigest: workAccordBindingDigest(accord),
    lifecycleGraphDigest: accord.binding.lifecycleGraphDigest,
    workAccordDigest: digest(accord),
    capabilityRegistryDigest: accord.policy.capabilityRegistryDigest,
    domainPackDigest: accord.policy.domainPackDigest,
    phaseContractDigest: accord.policy.phaseContracts.framing!.digest,
    compiledPolicyDigest: digest("framing-compiled"),
    policyDigest: accord.binding.policyDigest,
    kernelReceiptDigest: digest("kernel-head")
  });
  const ready = runStateAt(contracts, 5, source);
  const { runState, acquired, released } = fencedRunState(ready);
  const artifact = stageArtifact(runState, journey, contracts.bindings);
  const applied = appliedPlanningResult(runState);
  assert.equal(applied.kind, "applied");
  if (applied.kind !== "applied") return;
  const after = {
    state: applied.snapshot.state,
    stateVersion: applied.snapshot.stateVersion,
    bindingDigest: applied.snapshot.bindingDigest,
    lifecycleGraphDigest: applied.snapshot.lifecycleGraphDigest,
    workAccordDigest: applied.snapshot.workAccordDigest,
    capabilityRegistryDigest: applied.snapshot.capabilityRegistryDigest,
    domainPackDigest: applied.snapshot.domainPackDigest,
    phaseContractDigest: applied.snapshot.phaseContractDigest,
    compiledPolicyDigest: applied.snapshot.compiledPolicyDigest,
    policyDigest: applied.snapshot.policyDigest,
    kernelReceiptDigest: applied.snapshot.receiptHead,
    kernelSnapshotDigest: digest(applied.snapshot)
  };
  const receipt = signedReceipt(
    runState,
    journey,
    artifact,
    acquired,
    released,
    after,
    applied.receiptDigest,
    digest(applied)
  );
  const advanced = advanceDemoJourney({
    runState,
    authority: {
      catalog,
      reservations,
      lifecycle,
      baseRegistry: registry,
      contracts
    },
    receipt,
    artifact,
    runFence: acquired,
    releasedRunFence: released,
    appliedKernelResult: applied,
    workAccord: accord,
    verifier: { verify: () => true }
  });
  assert.equal(advanced.spec.journey.currentStageId, "migration-plan");
  assert.equal(advanced.spec.core.state, "PLANNED");

  const mismatch = signedReceipt(
    runState,
    journey,
    artifact,
    acquired,
    released,
    after,
    digest("wrong-kernel-receipt"),
    digest(applied)
  );
  assert.throws(
    () =>
      advanceDemoJourney({
        runState,
        authority: {
          catalog,
          reservations,
          lifecycle,
          baseRegistry: registry,
          contracts
        },
        receipt: mismatch,
        artifact,
        runFence: acquired,
        releasedRunFence: released,
        appliedKernelResult: applied,
        workAccord: accord,
        verifier: { verify: () => true }
      }),
    /does not match the journey advancement/u
  );

  const substitutedSnapshot = {
    ...applied.snapshot,
    bindingDigest: digest("substituted-destination-binding")
  };
  const substitutedApplied: KernelResult = {
    ...applied,
    snapshot: substitutedSnapshot
  };
  const substitutedAfter = {
    ...after,
    bindingDigest: substitutedSnapshot.bindingDigest,
    kernelSnapshotDigest: digest(substitutedSnapshot)
  };
  const substitutedReceipt = signedReceipt(
    runState,
    journey,
    artifact,
    acquired,
    released,
    substitutedAfter,
    applied.receiptDigest,
    digest(substitutedApplied)
  );
  assert.throws(
    () =>
      advanceDemoJourney({
        runState,
        authority: {
          catalog,
          reservations,
          lifecycle,
          baseRegistry: registry,
          contracts
        },
        receipt: substitutedReceipt,
        artifact,
        runFence: acquired,
        releasedRunFence: released,
        appliedKernelResult: substitutedApplied,
        workAccord: accord,
        verifier: { verify: () => true }
      }),
    /does not match the journey advancement/u
  );
});
