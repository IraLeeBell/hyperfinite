#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DEMO_PROJECTION_VOCABULARY,
  advanceDemoJourney,
  assertDocument,
  canonicalJson,
  compilePolicy,
  convergeDemoProjection,
  createDemoBudgetState,
  createDemoContract,
  createDemoProjectionState,
  createDemoRuntimeObservabilityBatch,
  createInitialSnapshot,
  demoContractContentDigest,
  demoCoreBindingFromSnapshot,
  demoReviewExpectedCheckIds,
  demoReviewExpectedCommandIds,
  deriveDemoProjectionState,
  digest,
  dispatchDemoRuntime,
  evaluatePersistedDemoKernelTransition,
  evaluateTransition,
  eventPayloadDigest,
  issueDemoReviewEvidenceBundle,
  issueTrustedDemoTargetIdentityEvidence,
  issueTrustedDemoRuntimeBinding,
  persistDemoDispatchDecision,
  reconcileDemoRunStateFromKernel,
  reconstructDemoRuntime,
  scheduleDemoDispatch,
  validateDemoContract,
  validateDemoReviewEvidenceBundle,
  validateBoundedExecutionGrant,
  workAccordBindingDigest,
  type ActivationLease,
  type Actor,
  type BoundedExecutionGrant,
  type CapabilityRegistry,
  type ContractRequirementEvidence,
  type DemoActivationClaimReceipt,
  type DemoActivationGrant,
  type DemoBudgetLedger,
  type DemoDispatchPersistenceReceipt,
  type DemoDispatchPersistenceResult,
  type DemoDispatchStore,
  type DemoEvidenceSigner,
  type DemoEvidenceVerifier,
  type DemoKernelStateStore,
  type DemoProjectContractSet,
  type DemoProjectionPort,
  type DemoProjectionState,
  type DemoProviderUsageLedger,
  type DemoRunFenceStore,
  type DemoRunFence,
  type DemoRunState,
  type DemoRunStateStore,
  type DemoRuntimeAuditInput,
  type DemoRuntimeAuthority,
  type DemoRuntimeReconstruction,
  type DemoReviewEvidenceBundle,
  type DemoReviewEvidenceObservation,
  type DemoSignature,
  type DemoStageInvocationPort,
  type Digest,
  type EventEnvelope,
  type HumanGateEvidence,
  type KernelContext,
  type KernelSnapshot,
  type LifecycleState,
  type PhaseContract,
  type SignedStageReceipt,
  type StageArtifactEnvelope,
  type TrustedDemoRuntimeBinding,
  type TrustedGitHubBinding,
  type WorkAccord
} from "../src/index.js";
import {
  loadDemoProjectContractSets,
  loadDemoRegistrationMetadata,
  loadTrustedDemoRuntimeBindingForSelection,
  readStrictJsonFile
} from "./demo-runtime-metadata.js";

const args = process.argv.slice(2);
const forbidden = args.find((argument) =>
  /(?:^|[-_:])(live|apply|execute|github|network|credential|paid)(?:$|[-_=])/iu.test(
    argument
  )
);
if (forbidden !== undefined) {
  throw new TypeError(
    `live simulator option ${forbidden} is forbidden before environment or credential reads`
  );
}
const format =
  args.length === 0
    ? "json"
    : args.length === 1 && args[0] === "--format=ndjson"
      ? "ndjson"
      : args.length === 1 && args[0] === "--format=json"
        ? "json"
        : (() => {
            throw new TypeError("simulate:demos accepts only --format=json or --format=ndjson");
          })();

const NOW = "2026-08-29T12:10:00.000Z";
const GIT_EXECUTABLE = "/usr/bin/git";
const TRUSTED_PATH = `${path.dirname(process.execPath)}:/usr/bin:/bin`;
const EXPIRES = "2026-08-29T13:10:00.000Z";
const DEMOS = [
  "app-modernization",
  "feature-delivery",
  "security-dependency-remediation",
  "adaptive-delivery"
] as const;
const SUBSTITUTION_CLASSES = [
  "repository-issue-project-binding",
  "work-accord-profile",
  "artifacts",
  "receipts",
  "approvals",
  "budgets",
  "agent-bindings",
  "allowed-path-grants"
] as const;
const PACK_FIXTURES: Readonly<
  Record<
    (typeof DEMOS)[number],
    {
      readonly handsOff: string;
      readonly human: string;
      readonly recovery: string;
      readonly adversarial: string;
      readonly externalCalls: string;
    }
  >
> = {
  "app-modernization": {
    handsOff:
      "tests/fixtures/demos/app-modernization/hands-off-to-human-review.json",
    human:
      "tests/fixtures/demos/app-modernization/synthetic-human-completion.json",
    recovery: "tests/fixtures/demos/app-modernization/recovery-scenarios.json",
    adversarial:
      "tests/fixtures/demos/app-modernization/adversarial-scenarios.json",
    externalCalls:
      "tests/fixtures/demos/app-modernization/external-call-assertions.json"
  },
  "feature-delivery": {
    handsOff: "tests/fixtures/demos/feature-delivery/hands-off-run.json",
    human: "tests/fixtures/demos/feature-delivery/human-continuation.json",
    recovery: "tests/fixtures/demos/feature-delivery/recovery-cases.json",
    adversarial: "tests/fixtures/demos/feature-delivery/adversarial-cases.json",
    externalCalls:
      "tests/fixtures/demos/feature-delivery/external-call-assertions.json"
  },
  "security-dependency-remediation": {
    handsOff:
      "tests/fixtures/demos/security-dependency-remediation/hands-off-trace.json",
    human:
      "tests/fixtures/demos/security-dependency-remediation/synthetic-human-continuation.json",
    recovery:
      "tests/fixtures/demos/security-dependency-remediation/recovery-scenarios.json",
    adversarial:
      "tests/fixtures/demos/security-dependency-remediation/adversarial-scenarios.json",
    externalCalls:
      "tests/fixtures/demos/security-dependency-remediation/external-call-assertions.json"
  },
  "adaptive-delivery": {
    handsOff: "tests/fixtures/demos/adaptive-delivery/hands-off-run.json",
    human: "tests/fixtures/demos/adaptive-delivery/human-continuation.json",
    recovery:
      "tests/fixtures/demos/adaptive-delivery/recovery-scenarios.json",
    adversarial:
      "tests/fixtures/demos/adaptive-delivery/adversarial-scenarios.json",
    externalCalls:
      "tests/fixtures/demos/adaptive-delivery/external-call-assertions.json"
  }
};
const PACK_WORK_ACCORDS: Readonly<Record<(typeof DEMOS)[number], string>> = {
  "app-modernization":
    "tests/fixtures/demos/app-modernization/work-accord.json",
  "feature-delivery":
    "tests/fixtures/demos/feature-delivery/work-accord.json",
  "security-dependency-remediation":
    "examples/demos/security-dependency-remediation/work-accord.json",
  "adaptive-delivery":
    "tests/fixtures/demos/adaptive-delivery/work-accord.json"
};
const PACK_PROJECT_TARGETS: Readonly<
  Record<
    (typeof DEMOS)[number],
    {
      readonly ownerNodeId: string;
      readonly projectNodeId: string;
      readonly itemNodeId: string;
    }
  >
> = {
  "app-modernization": {
    ownerNodeId: "O_synthetic_owner",
    projectNodeId: "PVT_synthetic_app_modernization",
    itemNodeId: "PVTI_synthetic_app_modernization"
  },
  "feature-delivery": {
    ownerNodeId: "O_synthetic_github",
    projectNodeId: "PVT_synthetic_feature_delivery",
    itemNodeId: "PVTI_synthetic_feature_delivery_27"
  },
  "security-dependency-remediation": {
    ownerNodeId: "O_synthetic_owner",
    projectNodeId: "PVT_synthetic_security_dependency",
    itemNodeId: "PVTI_synthetic_security_dependency"
  },
  "adaptive-delivery": {
    ownerNodeId: "O_synthetic_github",
    projectNodeId: "PVT_synthetic_adaptive_delivery",
    itemNodeId: "PVTI_synthetic_adaptive_delivery_1"
  }
};

function signature(payload: unknown, keyId = "simulation:key-1"): DemoSignature {
  return {
    algorithm: "ed25519",
    keyId,
    value: Buffer.from(digest(payload), "utf8").toString("base64")
  };
}

const signer: DemoEvidenceSigner = {
  sign: async (payload) => signature(payload)
};
const verifier: DemoEvidenceVerifier = {
  verify: (payload, candidate) =>
    candidate.algorithm === "ed25519" &&
    candidate.value === signature(payload, candidate.keyId).value
};

function enabledContracts(
  contracts: DemoProjectContractSet
): DemoProjectContractSet {
  return {
    ...contracts,
    activation: createDemoContract("DemoActivationProfile", {
      ...contracts.activation.spec,
      enabled: true,
      validFrom: "2026-08-29T12:00:00.000Z",
      expiresAt: EXPIRES
    })
  };
}

class DispatchStore implements DemoDispatchStore {
  receipt: DemoDispatchPersistenceReceipt | null = null;

  constructor(
    private readonly repositoryId: number,
    private readonly workItemNodeId: string,
    private readonly generation: number
  ) {}

  async persist(
    decision: Parameters<DemoDispatchStore["persist"]>[0]
  ): Promise<DemoDispatchPersistenceResult> {
    if (this.receipt !== null) {
      return this.receipt.decisionDigest === decision.contentDigest
        ? { status: "existing", receipt: this.receipt }
        : { status: "conflict", receipt: null };
    }
    const payload = {
      schemaVersion: "1.0.0" as const,
      storeId: `simulation:${decision.spec.demoProjectId}:dispatch`,
      sequence: 1,
      previousHead: null,
      decisionDigest: decision.contentDigest,
      runStateDigest: decision.spec.runStateDigest,
      repositoryId: this.repositoryId,
      workItemNodeId: this.workItemNodeId,
      authorityEpoch: 1,
      generation: this.generation,
      status: "persisted" as const,
      persistedAt: NOW,
      head: digest({
        storeId: `simulation:${decision.spec.demoProjectId}:dispatch`,
        sequence: 1,
        previousHead: null,
        decisionDigest: decision.contentDigest,
        runStateDigest: decision.spec.runStateDigest,
        repositoryId: this.repositoryId,
        workItemNodeId: this.workItemNodeId,
        authorityEpoch: 1,
        generation: this.generation,
        status: "persisted",
        persistedAt: NOW
      })
    };
    this.receipt = { ...payload, signature: signature(payload) };
    return { status: "appended", receipt: this.receipt };
  }

  async read(): Promise<DemoDispatchPersistenceReceipt | null> {
    return this.receipt;
  }
}

class KernelStore implements DemoKernelStateStore {
  constructor(
    public snapshot: KernelSnapshot,
    private readonly order: string[] | null = null
  ) {}

  async persistApplied(
    result: Parameters<DemoKernelStateStore["persistApplied"]>[0]
  ): Promise<{ readonly status: "appended" }> {
    this.snapshot = result.snapshot;
    this.order?.push("kernel");
    return { status: "appended" };
  }

  async read(): Promise<KernelSnapshot> {
    return this.snapshot;
  }
}

class RunStateStore implements DemoRunStateStore {
  constructor(public state: DemoRunState) {}

  async compareAndSwap(input: {
    readonly expectedRunStateDigest: Digest;
    readonly nextRunState: DemoRunState;
  }): Promise<{ readonly status: "appended" | "conflict" }> {
    if (this.state.contentDigest !== input.expectedRunStateDigest) {
      return { status: "conflict" };
    }
    this.state = input.nextRunState;
    return { status: "appended" };
  }

  async read(): Promise<DemoRunState> {
    return this.state;
  }
}

class ProjectionPort implements DemoProjectionPort {
  readonly writes: string[] = [];
  reads = 0;

  constructor(
    public state: DemoProjectionState,
    private readonly order: string[] | null = null
  ) {}

  async read(): Promise<DemoProjectionState> {
    this.reads += 1;
    this.order?.push(`projection-read:${this.reads}`);
    return this.state;
  }

  async write(
    request: Parameters<DemoProjectionPort["write"]>[0]
  ): Promise<void> {
    if (request.expectedStateDigest !== this.state.contentDigest) {
      throw new TypeError("simulation projection compare-and-swap conflict");
    }
    this.state = request.next;
    this.writes.push(request.field);
    this.order?.push(`projection:${request.field}`);
  }
}

interface HermeticModelInvocation {
  readonly stageId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly outputDigest: Digest;
  readonly usage: {
    readonly calls: 1;
    readonly tokens: 100;
    readonly costUnits: 1;
  };
  readonly signature: DemoSignature;
}

class HermeticFakeModel {
  readonly invocations: HermeticModelInvocation[] = [];

  invoke(input: {
    readonly demoProjectId: string;
    readonly stageId: string;
    readonly stageOrdinal: number;
    readonly bindingPresent: boolean;
  }): HermeticModelInvocation {
    if (!input.bindingPresent) {
      throw new TypeError("fake model invocation lacks a trusted stage binding");
    }
    const startedAt = new Date(
      Date.parse(NOW) + input.stageOrdinal * 10
    ).toISOString();
    const completedAt = new Date(
      Date.parse(startedAt) + 1
    ).toISOString();
    const payload = {
      stageId: input.stageId,
      startedAt,
      completedAt,
      outputDigest: digest({
        demoProjectId: input.demoProjectId,
        stageId: input.stageId,
        output: "hermetic-target-free"
      }),
      usage: {
        calls: 1 as const,
        tokens: 100 as const,
        costUnits: 1 as const
      }
    };
    const invocation: HermeticModelInvocation = {
      ...payload,
      signature: signature(payload)
    };
    this.invocations.push(invocation);
    return invocation;
  }
}

const unreachable = (): never => {
  throw new TypeError("non-invocation scheduler touched an unreachable service");
};

const unusedFenceStore: DemoRunFenceStore = {
  supportsAtomicCompareAndSwap: true,
  acquire: async () => unreachable(),
  release: async () => unreachable(),
  read: async () => unreachable()
};
const unusedBudgetLedger: DemoBudgetLedger = {
  reserve: async () => unreachable(),
  settle: async () => unreachable(),
  read: async () => unreachable()
};
const unusedUsageLedger: DemoProviderUsageLedger = {
  begin: async () => unreachable(),
  reconcile: async () => unreachable()
};
const unusedInvoker: DemoStageInvocationPort = {
  invoke: async () => unreachable()
};
const unusedActivationGrant = Object.freeze({}) as DemoActivationGrant;
const unusedActivationClaim = Object.freeze({}) as DemoActivationClaimReceipt;

function activationLease(
  contracts: DemoProjectContractSet,
  accord: WorkAccord,
  demoProjectId: string
): ActivationLease {
  return assertDocument("ActivationLease", {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "ActivationLease",
    id: `${demoProjectId}-simulation-lease`,
    workAccordDigest: digest(accord),
    approvedBy: "synthetic-human-administrator",
    authorizationDigest: digest(`${demoProjectId}:activation-approval`),
    allowedPhases: [
      "execution",
      "framing",
      "human-review",
      "planning",
      "verification"
    ],
    allowedCapabilities: contracts.bindings.spec.stageBindings.flatMap((stage) =>
      stage.runtimeBindings.map((binding) => binding.capability)
    ),
    maxCalls: contracts.activation.spec.leaseTemplate.maxCalls,
    maxTokens: contracts.activation.spec.leaseTemplate.maxTokens,
    maxCostUnits: contracts.activation.spec.leaseTemplate.maxCostUnits,
    maxParallel: 1,
    expiresAt: EXPIRES,
    revoked: false
  });
}

function initialReconstruction(input: {
  readonly authority: DemoRuntimeAuthority;
  readonly lease: ActivationLease;
}): DemoRuntimeReconstruction {
  const { authority, lease } = input;
  const contracts = authority.contracts;
  const accord = authority.workAccord;
  const catalog = validateDemoContract("DemoCatalog", authority.catalog);
  const reservations = validateDemoContract(
    "DemoIdentityReservationManifest",
    authority.reservations
  );
  const snapshot = createInitialSnapshot({
    lifecycleGraphDigest: digest(authority.lifecycle),
    workAccord: accord,
    capabilityRegistryDigest: accord.policy.capabilityRegistryDigest,
    domainPackDigest: accord.policy.domainPackDigest,
    policyDigest: accord.binding.policyDigest
  });
  const runState = createDemoContract("DemoRunState", {
    demoProjectId: contracts.profile.spec.demoProjectId,
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
    runId: `${contracts.profile.spec.demoProjectId}-simulation-run`,
    runAttempt: 1,
    core: demoCoreBindingFromSnapshot(snapshot),
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
    updatedAt: NOW
  });
  const budget = createDemoBudgetState({
    demoProjectId: contracts.profile.spec.demoProjectId,
    repositoryId: accord.binding.repositoryId,
    workItemNodeId: accord.binding.workItemNodeId,
    authorityEpoch: contracts.activation.spec.authorityEpoch,
    generation: 0,
    activationLeaseDigest: digest(lease),
    workAccordDigest: digest(accord),
    limits: contracts.activation.spec.leaseTemplate,
    usage: { calls: 0, tokens: 0, costUnits: 0, retries: 0 },
    held: { calls: 0, tokens: 0, costUnits: 0 },
    startedAt: NOW,
    expiresAt: EXPIRES,
    ledgerVersion: 0,
    ledgerHead: null
  });
  const projection = createDemoProjectionState({
    demoProjectId: contracts.profile.spec.demoProjectId,
    repositoryId: accord.binding.repositoryId,
    workItemNodeId: accord.binding.workItemNodeId,
    projectBindingDigest: contracts.profile.spec.projectBindingDigest,
    authorityEpoch: contracts.activation.spec.authorityEpoch,
    generation: 0,
    kernelStateVersion: snapshot.stateVersion,
    kernelReceiptDigest: snapshot.receiptHead,
    stageReceiptDigest: null,
    fields: DEMO_PROJECTION_VOCABULARY.map((field) => ({
      key: field.key,
      value: field.key === "stage" ? "CAPTURED" : null
    })),
    observedAt: NOW
  });
  return reconstructDemoRuntime({
    authority,
    runState,
    kernelSnapshot: snapshot,
    activationLease: lease,
    budget,
    projection,
    completedReceipts: [],
    artifacts: [],
    fences: [],
    receiptVerifier: { verify: () => false },
    evaluatedAt: NOW
  });
}

type ActiveDemoPhase =
  | "framing"
  | "planning"
  | "execution"
  | "verification"
  | "human-review";

function actualKernelHappyPath(input: {
  readonly authority: DemoRuntimeAuthority;
  readonly lease: ActivationLease;
  readonly policy: KernelContext["policy"];
  readonly registry: CapabilityRegistry;
  readonly domainPack: KernelContext["domainPack"];
  readonly phases: Readonly<Record<ActiveDemoPhase, PhaseContract>>;
}): {
  readonly finalSnapshot: KernelSnapshot;
  readonly snapshots: ReadonlyMap<LifecycleState, KernelSnapshot>;
  readonly results: ReadonlyMap<
    string,
    Extract<ReturnType<typeof evaluateTransition>, { kind: "applied" }>
  >;
} {
  const snapshots = new Map<LifecycleState, KernelSnapshot>();
  const results = new Map<
    string,
    Extract<ReturnType<typeof evaluateTransition>, { kind: "applied" }>
  >();
  let snapshot = createInitialSnapshot({
    lifecycleGraphDigest: digest(input.authority.lifecycle),
    workAccord: input.authority.workAccord,
    capabilityRegistryDigest: digest(input.registry),
    domainPackDigest: digest(input.domainPack),
    policyDigest: digest(input.policy)
  });
  snapshots.set(snapshot.state, snapshot);
  const phaseForState = (
    state: LifecycleState
  ): PhaseContract | null =>
    state === "FRAMING"
      ? input.phases.framing
      : state === "PLANNED"
        ? input.phases.planning
        : state === "EXECUTING"
          ? input.phases.execution
          : state === "VERIFYING"
            ? input.phases.verification
            : state === "HUMAN_REVIEW"
              ? input.phases["human-review"]
              : null;
  const rolesByClass: Readonly<Record<Actor["class"], readonly string[]>> = {
    administrator: ["repository-administrator"],
    maintainer: ["repository-maintainer"],
    policy: ["trusted-policy"],
    requester: ["work-item-requester"],
    reviewer: ["eligible-reviewer"],
    system: ["trusted-kernel"]
  };
  for (const destination of [
    "ACTIVATION_PENDING",
    "FRAMING",
    "PLANNED",
    "EXECUTING",
    "VERIFYING",
    "HUMAN_REVIEW"
  ] as const) {
    const route = input.authority.lifecycle.routes.find(
      (candidate) =>
        candidate.from === snapshot.state && candidate.to === destination
    );
    if (route === undefined) {
      throw new TypeError(
        `actual Kernel path has no route ${snapshot.state}->${destination}`
      );
    }
    const actorClass = route.actorClasses[0];
    if (actorClass === undefined) {
      throw new TypeError(`Kernel route ${route.id} has no actor class`);
    }
    const actor: Actor = {
      id:
        route.humanGate === "activate"
          ? input.lease.approvedBy
          : `${input.authority.contracts.profile.spec.demoProjectId}:${route.id}:actor`,
      class: actorClass,
      human: actorClass !== "policy" && actorClass !== "system",
      bot: actorClass === "policy" || actorClass === "system",
      roles: rolesByClass[actorClass],
      authorizationDigest:
        route.humanGate === "activate"
          ? input.lease.authorizationDigest
          : digest(
              `${input.authority.contracts.profile.spec.demoProjectId}:${route.id}:authorization`
            )
    };
    const baseEvent: EventEnvelope = {
      apiVersion: "agentic-framework.github.com/v1alpha1",
      kind: "KernelEvent",
      id: `${input.authority.contracts.profile.spec.demoProjectId}:${route.id}`,
      sequence: snapshot.lastEventSequence + 1,
      occurredAt: new Date(
        Date.parse(NOW) + (snapshot.lastEventSequence + 1) * 1000
      ).toISOString(),
      expectedStateVersion: snapshot.stateVersion,
      type: route.event,
      replacementAuthorityDigest: null,
      actor,
      provenance: {
        source: "test-fixture",
        deliveryId: `${input.authority.contracts.profile.spec.demoProjectId}:${route.id}:delivery`,
        bindingDigest: snapshot.bindingDigest,
        payloadDigest: digest("pending")
      },
      cost: route.costBearing
        ? { calls: 1, tokens: 1, costUnits: 1, loops: 0 }
        : { calls: 0, tokens: 0, costUnits: 0, loops: 0 }
    };
    const event: EventEnvelope = {
      ...baseEvent,
      provenance: {
        ...baseEvent.provenance,
        payloadDigest: eventPayloadDigest(baseEvent)
      }
    };
    const currentPhase = phaseForState(snapshot.state);
    const destinationPhase = phaseForState(destination);
    const activationLease =
      destination === "ACTIVATION_PENDING" ? null : input.lease;
    const requirement = (
      requirementType: ContractRequirementEvidence["requirementType"],
      name: string,
      contract: PhaseContract,
      actorAuthorizationDigest: Digest | null
    ): ContractRequirementEvidence => ({
      apiVersion: "agentic-framework.github.com/v1alpha1",
      kind: "ContractRequirementEvidence",
      requirementType,
      requirement: name,
      satisfied: true,
      workAccordDigest: snapshot.workAccordDigest,
      bindingDigest: snapshot.bindingDigest,
      snapshotDigest: digest(snapshot),
      phaseContractDigest: digest(contract),
      routeId: route.id,
      activationLeaseDigest:
        name === "activation-lease-current" || name === "activation-lease"
          ? activationLease === null
            ? null
            : digest(activationLease)
          : null,
      currentHead: snapshot.currentHead,
      actorAuthorizationDigest,
      observedAt: event.occurredAt,
      expiresAt: EXPIRES
    });
    const requirements: ContractRequirementEvidence[] = [];
    const exitRule = currentPhase?.exitRules.find(
      (rule) => rule.event === route.event
    );
    if (currentPhase !== null && exitRule !== undefined) {
      requirements.push(
        requirement(
          "predicate",
          exitRule.predicate,
          currentPhase,
          actor.authorizationDigest
        )
      );
    }
    if (
      destinationPhase !== null &&
      destinationPhase.phase !== currentPhase?.phase
    ) {
      requirements.push(
        ...destinationPhase.entryPredicates.map((name) =>
          requirement("predicate", name, destinationPhase, null)
        ),
        ...destinationPhase.requiredEvidence.map((name) =>
          requirement("evidence", name, destinationPhase, null)
        )
      );
    }
    const routeGateEvidence: HumanGateEvidence[] =
      route.humanGate === null
        ? []
        : [
            {
              gate: route.humanGate,
              actor,
              workAccordDigest: snapshot.workAccordDigest,
              activationLeaseDigest:
                route.humanGate === "activate" && activationLease !== null
                  ? digest(activationLease)
                  : null,
              currentHead: snapshot.currentHead,
              observedAt: event.occurredAt,
              expiresAt: EXPIRES,
              valid: true
            }
          ];
    const activationActor: Actor = {
      id: input.lease.approvedBy,
      class: "maintainer",
      human: true,
      bot: false,
      roles: ["repository-maintainer"],
      authorizationDigest: input.lease.authorizationDigest
    };
    const activationGateEvidence: HumanGateEvidence[] =
      activationLease === null || route.humanGate === "activate"
        ? []
        : [
            {
              gate: "activate",
              actor: activationActor,
              workAccordDigest: snapshot.workAccordDigest,
              activationLeaseDigest: digest(activationLease),
              currentHead: snapshot.currentHead,
              observedAt: event.occurredAt,
              expiresAt: EXPIRES,
              valid: true
            }
          ];
    const context: KernelContext = {
      graph: input.authority.lifecycle,
      workAccord: input.authority.workAccord,
      policy: input.policy,
      registry: input.registry,
      domainPack: input.domainPack,
      currentPhaseContract: currentPhase,
      destinationPhaseContract: destinationPhase,
      activationLease,
      humanGateEvidence: [
        ...routeGateEvidence,
        ...activationGateEvidence
      ],
      contractRequirementEvidence: requirements,
      requesterId: "synthetic-requester",
      evaluatedAt: event.occurredAt,
      retryableFailure: false,
      rebindAuthority: null
    };
    const result = evaluateTransition(snapshot, event, context);
    if (result.kind !== "applied") {
      throw new TypeError(
        `actual Kernel path refused ${route.id}: ${canonicalJson(result)}`
      );
    }
    results.set(`${route.from}->${route.to}`, result);
    snapshot = result.snapshot;
    snapshots.set(snapshot.state, snapshot);
  }
  return {
    finalSnapshot: snapshot,
    snapshots,
    results
  };
}

async function fullJourneyReconstruction(input: {
  readonly authority: DemoRuntimeAuthority;
  readonly lease: ActivationLease;
  readonly pullRequestNumber: number;
  readonly pullRequestHeadSha: string;
  readonly model: HermeticFakeModel;
  readonly policy: KernelContext["policy"];
  readonly registry: CapabilityRegistry;
  readonly domainPack: KernelContext["domainPack"];
  readonly humanReview: NonNullable<KernelContext["currentPhaseContract"]>;
  readonly phases: Readonly<Record<ActiveDemoPhase, PhaseContract>>;
}): Promise<{
  readonly reconstruction: DemoRuntimeReconstruction;
  readonly projectionWrites: readonly string[];
  readonly dispatcherAction: string;
  readonly schedulerAction: string;
  readonly modelInvocations: readonly HermeticModelInvocation[];
  readonly projectionReadCount: number;
  readonly projectionInitialKernelVersion: number;
  readonly projectionFinalKernelVersion: number;
  readonly kernelStateVersion: number;
  readonly projectionOrder: readonly string[];
  readonly appliedKernelResultDigests: readonly Digest[];
}> {
  const { authority, lease } = input;
  const contracts = authority.contracts;
  const accord = authority.workAccord;
  const kernelPath = actualKernelHappyPath({
    authority,
    lease,
    policy: input.policy,
    registry: input.registry,
    domainPack: input.domainPack,
    phases: input.phases
  });
  const snapshot = kernelPath.finalSnapshot;
  if (snapshot.state !== "HUMAN_REVIEW") {
    throw new TypeError("actual Kernel path did not reach Human Review");
  }
  const coreFor = (
    state: LifecycleState
  ): DemoRunState["spec"]["core"] => {
    const stateSnapshot = kernelPath.snapshots.get(state);
    if (stateSnapshot === undefined) {
      throw new TypeError(`actual Kernel path omitted ${state}`);
    }
    return demoCoreBindingFromSnapshot(stateSnapshot);
  };
  const humanIndex = contracts.journey.spec.stages.findIndex(
    (stage) => stage.executionKind === "human"
  );
  if (humanIndex < 1) {
    throw new TypeError("simulation journey has no reachable human-review stage");
  }
  const receipts: SignedStageReceipt[] = [];
  const artifacts: StageArtifactEnvelope[] = [];
  const fences: DemoRunFence[] = [];
  let previousReceipt: Digest | null = null;
  let previousFence: Digest | null = null;
  for (let index = 0; index < humanIndex; index += 1) {
    const stage = contracts.journey.spec.stages[index];
    const next = contracts.journey.spec.stages[index + 1];
    const stageBinding = contracts.bindings.spec.stageBindings[index];
    if (stage === undefined || next === undefined || stageBinding === undefined) {
      throw new TypeError("simulation journey stage evidence is incomplete");
    }
    const runtimeBinding = stageBinding.runtimeBindings[0];
    const modelStage = stage.executionKind === "model";
    const modelInvocation = modelStage
      ? input.model.invoke({
          demoProjectId: contracts.profile.spec.demoProjectId,
          stageId: stage.stageId,
          stageOrdinal: stage.ordinal,
          bindingPresent: runtimeBinding !== undefined
        })
      : null;
    const completedAt =
      modelInvocation?.completedAt ??
      new Date(Date.parse(NOW) + stage.ordinal * 10 + 1).toISOString();
    const artifact = createDemoContract("StageArtifactEnvelope", {
      demoProjectId: contracts.profile.spec.demoProjectId,
      stageId: stage.stageId,
      projectProfileDigest: contracts.profile.contentDigest,
      journeyDefinitionDigest: contracts.journey.contentDigest,
      stageAgentBindingsDigest: contracts.bindings.contentDigest,
      authorityEpoch: contracts.activation.spec.authorityEpoch,
      generation: 0,
      runId: `${contracts.profile.spec.demoProjectId}-simulation-run`,
      runAttempt: 1,
      producer:
        modelStage && runtimeBinding !== undefined
          ? {
              kind: "model",
              agentId: runtimeBinding.agent,
              capabilityId: runtimeBinding.capability,
              workflowId: runtimeBinding.workflow
            }
          : {
              kind: "deterministic",
              agentId: null,
              capabilityId: null,
              workflowId: null
            },
      inputDigest:
        modelInvocation?.outputDigest ??
        digest(`${contracts.profile.spec.demoProjectId}:${stage.stageId}:input`),
      artifact: {
        kind: "HermeticDemoStageArtifact",
        schemaVersion: "1.0.0",
        mediaType: "application/json",
        byteLength: 1,
        contentDigest:
          modelInvocation?.outputDigest ??
          digest(
            `${contracts.profile.spec.demoProjectId}:${stage.stageId}:artifact`
          )
      },
      createdAt: completedAt
    });
    artifacts.push(artifact);
    const runStateDigest = digest(
      `${contracts.profile.spec.demoProjectId}:${stage.stageId}:run-state`
    );
    let acquired: DemoRunFence | null = null;
    let released: DemoRunFence | null = null;
    if (modelStage) {
      if (modelInvocation === null) {
        throw new TypeError("model stage omitted its signed invocation");
      }
      acquired = createDemoContract("DemoRunFence", {
        demoProjectId: contracts.profile.spec.demoProjectId,
        repositoryId: accord.binding.repositoryId,
        workItemNodeId: accord.binding.workItemNodeId,
        fenceKey: digest({
          repositoryId: accord.binding.repositoryId,
          workItemNodeId: accord.binding.workItemNodeId
        }),
        authorityEpoch: contracts.activation.spec.authorityEpoch,
        generation: 0,
        runId: `${contracts.profile.spec.demoProjectId}-simulation-run`,
        runAttempt: 1,
        runStateDigest,
        dispatchDecisionDigest: digest(
          `${contracts.profile.spec.demoProjectId}:${stage.stageId}:dispatch`
        ),
        holderDigest: digest(
          `${contracts.profile.spec.demoProjectId}:${stage.stageId}:holder`
        ),
        activationLeaseDigest: digest(lease),
        previousFenceDigest: previousFence,
        status: "acquired",
        acquiredAt: new Date(
          Date.parse(modelInvocation.startedAt) - 1
        ).toISOString(),
        expiresAt: new Date(
          Date.parse(modelInvocation.completedAt) + 60_000
        ).toISOString(),
        releasedAt: null
      });
      released = createDemoContract("DemoRunFence", {
        ...acquired.spec,
        previousFenceDigest: acquired.contentDigest,
        status: "released",
        releasedAt: modelInvocation.completedAt
      });
      fences.push(acquired, released);
      previousFence = released.contentDigest;
    }
    const before = coreFor(stage.coreState);
    const after =
      stage.coreState === next.coreState
        ? before
        : coreFor(next.coreState);
    const crossesCore = stage.coreState !== next.coreState;
    const appliedKernelResult = crossesCore
      ? kernelPath.results.get(`${stage.coreState}->${next.coreState}`)
      : undefined;
    if (crossesCore && appliedKernelResult === undefined) {
      throw new TypeError(
        `stage ${stage.stageId} has no actual applied Kernel result`
      );
    }
    const spec: SignedStageReceipt["spec"] = {
      demoProjectId: contracts.profile.spec.demoProjectId,
      projectProfileDigest: contracts.profile.contentDigest,
      journeyDefinitionDigest: contracts.journey.contentDigest,
      stageAgentBindingsDigest: contracts.bindings.contentDigest,
      authorityEpoch: contracts.activation.spec.authorityEpoch,
      generation: 0,
      runId: `${contracts.profile.spec.demoProjectId}-simulation-run`,
      runAttempt: 1,
      runStateDigest,
      stageId: stage.stageId,
      stageOrdinal: stage.ordinal,
      nextStageId: next.stageId,
      nextStageOrdinal: next.ordinal,
      previousStageReceiptDigest: previousReceipt,
      artifactEnvelopeDigest: artifact.contentDigest,
      runFenceDigest: acquired?.contentDigest ?? null,
      releasedRunFenceDigest: released?.contentDigest ?? null,
      coreBefore: before,
      coreAfter: after,
      kernelTransitionReceiptDigest:
        appliedKernelResult?.receiptDigest ?? null,
      appliedKernelResultDigest:
        appliedKernelResult === undefined ? null : digest(appliedKernelResult),
      outcome: "completed",
      completedAt
    };
    const contentDigest = demoContractContentDigest(
      "SignedStageReceipt",
      spec
    );
    receipts.push(
      validateDemoContract("SignedStageReceipt", {
        apiVersion: "agentic-framework.github.com/v1alpha1",
        kind: "SignedStageReceipt",
        schemaVersion: "1.0.0",
        contentDigest,
        spec,
        signature: signature(contentDigest)
      })
    );
    previousReceipt = contentDigest;
  }
  const currentStage = contracts.journey.spec.stages[humanIndex];
  if (currentStage === undefined) {
    throw new TypeError("simulation human-review stage is missing");
  }
  const runState = createDemoContract("DemoRunState", {
    demoProjectId: contracts.profile.spec.demoProjectId,
    catalogDigest: validateDemoContract(
      "DemoCatalog",
      authority.catalog
    ).contentDigest,
    identityReservationsDigest: validateDemoContract(
      "DemoIdentityReservationManifest",
      authority.reservations
    ).contentDigest,
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
    runId: `${contracts.profile.spec.demoProjectId}-simulation-run`,
    runAttempt: 1,
    core: demoCoreBindingFromSnapshot(snapshot),
    journey: {
      currentStageId: currentStage.stageId,
      currentStageOrdinal: currentStage.ordinal,
      previousStageReceiptDigest: previousReceipt,
      completedStageReceiptDigests: receipts.map(
        (receipt) => receipt.contentDigest
      )
    },
    fenceDigest: null,
    fenceBaseRunStateDigest: null,
    currentDraftPullRequest: {
      number: input.pullRequestNumber,
      nodeId: `PR_${contracts.profile.spec.demoProjectId}_simulation`,
      headSha: input.pullRequestHeadSha,
      draft: true,
      state: "open"
    },
    status: "waiting-human",
    updatedAt: NOW
  });
  const budget = createDemoBudgetState({
    demoProjectId: contracts.profile.spec.demoProjectId,
    repositoryId: accord.binding.repositoryId,
    workItemNodeId: accord.binding.workItemNodeId,
    authorityEpoch: contracts.activation.spec.authorityEpoch,
    generation: 0,
    activationLeaseDigest: digest(lease),
    workAccordDigest: digest(accord),
    limits: contracts.activation.spec.leaseTemplate,
    usage: {
      calls: input.model.invocations.length,
      tokens: input.model.invocations.reduce(
        (total, invocation) => total + invocation.usage.tokens,
        0
      ),
      costUnits: input.model.invocations.reduce(
        (total, invocation) => total + invocation.usage.costUnits,
        0
      ),
      retries: 0
    },
    held: { calls: 0, tokens: 0, costUnits: 0 },
    startedAt: NOW,
    expiresAt: EXPIRES,
    ledgerVersion: 0,
    ledgerHead: null
  });
  const values = {
    stage: "HUMAN_REVIEW",
    "journey-stage": currentStage.displayName,
    "demo-project-profile": contracts.profile.spec.title,
    "depth-profile": accord.policy.depthProfile,
    "gate-status": "waiting-human",
    "contract-revision": accord.identity.revision.toString(),
    "last-receipt": previousReceipt,
    attention: null,
    "target-repository": accord.binding.repositoryFullName,
    "run-attempt": `${runState.spec.runId}/${runState.spec.runAttempt}`,
    "current-draft-pr": `#${input.pullRequestNumber}@${input.pullRequestHeadSha}`,
    "current-stage-agent": "No model agent",
    "stage-interaction": "human-gate",
    "agent-selection-status": "not-applicable"
  } as const;
  const projection = createDemoProjectionState({
    demoProjectId: contracts.profile.spec.demoProjectId,
    repositoryId: accord.binding.repositoryId,
    workItemNodeId: accord.binding.workItemNodeId,
    projectBindingDigest: contracts.profile.spec.projectBindingDigest,
    authorityEpoch: contracts.activation.spec.authorityEpoch,
    generation: 0,
    kernelStateVersion: snapshot.stateVersion,
    kernelReceiptDigest: snapshot.receiptHead,
    stageReceiptDigest: previousReceipt,
    fields: contracts.projection.spec.fields.map((field) => ({
      key: field.key,
      value: values[field.key]
    })),
    observedAt: NOW
  });
  const reconstruction = reconstructDemoRuntime({
    authority,
    runState,
    kernelSnapshot: snapshot,
    activationLease: lease,
    budget,
    projection,
    completedReceipts: receipts,
    artifacts,
    fences,
    receiptVerifier: {
      verify: (receipt) =>
        receipt.signature.value === signature(receipt.contentDigest).value
    },
    evaluatedAt: NOW
  });
  const lagging = createDemoProjectionState({
    ...projection.spec,
    kernelStateVersion: 0,
    kernelReceiptDigest: null,
    stageReceiptDigest: null,
    fields: projection.spec.fields.map((field) => ({
      key: field.key,
      value: null
    }))
  });
  const projectionOrder: string[] = [];
  const projectionPort = new ProjectionPort(lagging, projectionOrder);
  const converged = await convergeDemoProjection({
    reconstruction,
    port: projectionPort,
    observedAt: NOW
  });
  if (converged.kind !== "converged") {
    throw new TypeError("full journey projection did not converge");
  }
  projectionOrder.push("next-event");
  const dispatch = dispatchDemoRuntime({
    reconstruction,
    decidedAt: NOW
  });
  const dispatchStore = new DispatchStore(
    runState.spec.repositoryId,
    runState.spec.workItemNodeId,
    runState.spec.generation
  );
  const persisted = await persistDemoDispatchDecision({
    result: dispatch,
    reconstruction,
    store: dispatchStore,
    verifier
  });
  const scheduled = await scheduleDemoDispatch({
    reconstruction,
    refresh: async () => reconstruction,
    dispatchDecision: dispatch.decision,
    dispatchPersistenceReceipt: persisted,
    dispatchVerifier: verifier,
    activationGrant: unusedActivationGrant,
    activationClaimReceipt: unusedActivationClaim,
    activationClaimVerifier: verifier,
    holderDigest: digest(
      `${contracts.profile.spec.demoProjectId}:human-review-holder`
    ),
    decidedAt: NOW,
    fenceStore: unusedFenceStore,
    budgetLedger: unusedBudgetLedger,
    budgetVerifier: verifier,
    usageLedger: unusedUsageLedger,
    usageVerifier: verifier,
    invoker: unusedInvoker,
    clock: { now: () => NOW }
  });
  return {
    reconstruction,
    projectionWrites: converged.writes,
    dispatcherAction: dispatch.decision.spec.action,
    schedulerAction: scheduled.decision.spec.action,
    modelInvocations: Object.freeze([...input.model.invocations]),
    projectionReadCount: projectionPort.reads,
    projectionInitialKernelVersion: lagging.spec.kernelStateVersion,
    projectionFinalKernelVersion:
      converged.projection.spec.kernelStateVersion,
    kernelStateVersion: snapshot.stateVersion,
    projectionOrder: Object.freeze([...projectionOrder]),
    appliedKernelResultDigests: Object.freeze(
      [...kernelPath.results.values()].map((result) => digest(result))
    )
  };
}

function activationEvent(
  reconstruction: DemoRuntimeReconstruction
): EventEnvelope {
  const base: EventEnvelope = {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "KernelEvent",
    id: `${reconstruction.runState.spec.demoProjectId}-simulation-activation`,
    sequence: 1,
    occurredAt: NOW,
    expectedStateVersion: 0,
    type: "activation-requested",
    replacementAuthorityDigest: null,
    actor: {
      id: "synthetic-requester",
      class: "requester",
      human: true,
      bot: false,
      roles: ["work-item-requester"],
      authorizationDigest: digest("synthetic-requester:authorization")
    },
    provenance: {
      source: "test-fixture",
      deliveryId: `${reconstruction.runState.spec.demoProjectId}-activation-delivery`,
      bindingDigest: reconstruction.kernelSnapshot.bindingDigest,
      payloadDigest: digest("pending")
    },
    cost: { calls: 0, tokens: 0, costUnits: 0, loops: 0 }
  };
  return {
    ...base,
    provenance: {
      ...base.provenance,
      payloadDigest: eventPayloadDigest(base)
    }
  };
}

async function runRuntimeProbe(input: {
  readonly authority: DemoRuntimeAuthority;
  readonly lease: ActivationLease;
  readonly policy: KernelContext["policy"];
  readonly domainPack: KernelContext["domainPack"];
}): Promise<{
  readonly kernelRoute: string;
  readonly dispatcherAction: string;
  readonly schedulerAction: string;
  readonly projectionWrites: readonly string[];
  readonly projectionReadCount: number;
  readonly operationOrder: readonly string[];
  readonly currentHeadValidated: boolean;
}> {
  const source = initialReconstruction(input);
  const dispatched = dispatchDemoRuntime({ reconstruction: source, decidedAt: NOW });
  const dispatchStore = new DispatchStore(
    source.runState.spec.repositoryId,
    source.runState.spec.workItemNodeId,
    source.runState.spec.generation
  );
  const persisted = await persistDemoDispatchDecision({
    result: dispatched,
    reconstruction: source,
    store: dispatchStore,
    verifier
  });
  const evaluation = evaluatePersistedDemoKernelTransition({
    reconstruction: source,
    dispatchDecision: dispatched.decision,
    dispatchPersistenceReceipt: persisted,
    dispatchVerifier: verifier,
    event: activationEvent(source),
    context: {
      graph: input.authority.lifecycle,
      workAccord: input.authority.workAccord,
      policy: input.policy,
      registry: input.authority.baseRegistry,
      domainPack: input.domainPack,
      currentPhaseContract: null,
      destinationPhaseContract: null,
      activationLease: null,
      humanGateEvidence: [],
      contractRequirementEvidence: [],
      requesterId: "synthetic-requester",
      evaluatedAt: NOW,
      retryableFailure: false,
      rebindAuthority: null
    }
  });
  if (evaluation.result.kind !== "applied") {
    throw new TypeError("actual Control Kernel refused the hermetic activation probe");
  }
  const operationOrder: string[] = [];
  const kernelStore = new KernelStore(source.kernelSnapshot, operationOrder);
  const runStateStore = new RunStateStore(source.runState);
  const reconciled = await reconcileDemoRunStateFromKernel({
    reconstruction: source,
    kernelEvaluation: evaluation,
    kernelStore,
    runStateStore
  });
  if (reconciled.kind !== "updated") {
    throw new TypeError("runtime reconstruction did not consume the applied Kernel result");
  }
  let current = reconstructDemoRuntime({
    authority: input.authority,
    runState: reconciled.runState,
    kernelSnapshot: evaluation.result.snapshot,
    activationLease: input.lease,
    budget: reconciled.budget,
    projection: source.projection,
    completedReceipts: [],
    artifacts: [],
    fences: [],
    receiptVerifier: { verify: () => false },
    evaluatedAt: NOW
  });
  const port = new ProjectionPort(current.projection, operationOrder);
  const projection = await convergeDemoProjection({
    reconstruction: current,
    port,
    observedAt: NOW
  });
  if (
    projection.kind !== "converged" ||
    projection.writes.at(-1) !== "stage"
  ) {
    throw new TypeError("Project projection did not converge with Stage last");
  }
  operationOrder.push("next-event");
  current = reconstructDemoRuntime({
    authority: input.authority,
    runState: reconciled.runState,
    kernelSnapshot: evaluation.result.snapshot,
    activationLease: input.lease,
    budget: reconciled.budget,
    projection: deriveDemoProjectionState({
      reconstruction: current,
      observedAt: NOW
    }),
    completedReceipts: [],
    artifacts: [],
    fences: [],
    receiptVerifier: { verify: () => false },
    evaluatedAt: NOW
  });
  const intake = dispatchDemoRuntime({ reconstruction: current, decidedAt: NOW });
  const intakeStore = new DispatchStore(
    current.runState.spec.repositoryId,
    current.runState.spec.workItemNodeId,
    current.runState.spec.generation
  );
  const intakeReceipt = await persistDemoDispatchDecision({
    result: intake,
    reconstruction: current,
    store: intakeStore,
    verifier
  });
  const scheduled = await scheduleDemoDispatch({
    reconstruction: current,
    refresh: async () => current,
    dispatchDecision: intake.decision,
    dispatchPersistenceReceipt: intakeReceipt,
    dispatchVerifier: verifier,
    activationGrant: unusedActivationGrant,
    activationClaimReceipt: unusedActivationClaim,
    activationClaimVerifier: verifier,
    holderDigest: digest(`${current.runState.spec.demoProjectId}:holder`),
    decidedAt: NOW,
    fenceStore: unusedFenceStore,
    budgetLedger: unusedBudgetLedger,
    budgetVerifier: verifier,
    usageLedger: unusedUsageLedger,
    usageVerifier: verifier,
    invoker: unusedInvoker,
    clock: { now: () => NOW }
  });
  return {
    kernelRoute: evaluation.result.route.id,
    dispatcherAction: intake.decision.spec.action,
    schedulerAction: scheduled.decision.spec.action,
    projectionWrites: projection.writes,
    projectionReadCount: port.reads,
    operationOrder: Object.freeze([...operationOrder]),
    currentHeadValidated:
      current.kernelSnapshot.currentHead ===
      current.authority.workAccord.binding.currentHead
  };
}

function humanCompletion(input: {
  readonly demoProjectId: string;
  readonly lifecycle: KernelContext["graph"];
  readonly accord: WorkAccord;
  readonly policy: KernelContext["policy"];
  readonly registry: CapabilityRegistry;
  readonly domainPack: KernelContext["domainPack"];
  readonly humanReview: KernelContext["currentPhaseContract"];
  readonly reconstruction: DemoRuntimeReconstruction;
}) {
  if (input.humanReview === null) {
    throw new TypeError("simulation human-review Phase Contract is missing");
  }
  const compiled = compilePolicy({
    enterprise: input.policy,
    accord: input.accord,
    phase: input.humanReview,
    domainPack: input.domainPack,
    registry: input.registry
  });
  if (!compiled.ok) {
    throw new TypeError(compiled.errors.join("; "));
  }
  const snapshot = assertDocument(
    "KernelSnapshot",
    input.reconstruction.kernelSnapshot
  );
  if (
    snapshot.state !== "HUMAN_REVIEW" ||
    snapshot.phaseOwner !== "human-review" ||
    snapshot.workAccordDigest !== digest(input.accord) ||
    snapshot.phaseContractDigest !== digest(input.humanReview) ||
    snapshot.compiledPolicyDigest !== compiled.policy.digest
  ) {
    throw new TypeError(
      "synthetic human continuation does not bind the reconstructed pack authority"
    );
  }
  const reviewer = {
    id: `synthetic-independent-reviewer:${input.demoProjectId}`,
    class: "reviewer" as const,
    human: true,
    bot: false,
    roles: ["eligible-reviewer"],
    authorizationDigest: digest(`${input.demoProjectId}:reviewer-authorization`)
  };
  const acceptancePredicate = input.humanReview.exitRules.find(
    (rule) => rule.event === "outcome-accepted"
  )?.predicate;
  if (acceptancePredicate === undefined) {
    throw new TypeError("pack human-review contract has no acceptance predicate");
  }
  const gate: HumanGateEvidence = {
    gate: "approve-current-head",
    actor: reviewer,
    workAccordDigest: digest(input.accord),
    activationLeaseDigest: null,
    currentHead: input.accord.binding.currentHead,
    observedAt: "2026-08-29T12:30:00.000Z",
    expiresAt: EXPIRES,
    valid: true
  };
  const requirement: ContractRequirementEvidence = {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "ContractRequirementEvidence",
    requirementType: "predicate",
    requirement: acceptancePredicate,
    satisfied: true,
    workAccordDigest: digest(input.accord),
    bindingDigest: workAccordBindingDigest(input.accord),
    snapshotDigest: digest(snapshot),
    phaseContractDigest: digest(input.humanReview),
    routeId: "review.accept",
    activationLeaseDigest: null,
    currentHead: input.accord.binding.currentHead,
    actorAuthorizationDigest: reviewer.authorizationDigest,
    observedAt: "2026-08-29T12:31:00.000Z",
    expiresAt: EXPIRES
  };
  const baseEvent: EventEnvelope = {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "KernelEvent",
    id: `${input.demoProjectId}-synthetic-human-acceptance`,
    sequence: 7,
    occurredAt: "2026-08-29T12:32:00.000Z",
    expectedStateVersion: 6,
    type: "outcome-accepted",
    replacementAuthorityDigest: null,
    actor: reviewer,
    provenance: {
      source: "test-fixture",
      deliveryId: `${input.demoProjectId}-human-delivery`,
      bindingDigest: workAccordBindingDigest(input.accord),
      payloadDigest: digest("pending")
    },
    cost: { calls: 0, tokens: 0, costUnits: 0, loops: 0 }
  };
  const event: EventEnvelope = {
    ...baseEvent,
    provenance: {
      ...baseEvent.provenance,
      payloadDigest: eventPayloadDigest(baseEvent)
    }
  };
  const context: KernelContext = {
    graph: input.lifecycle,
    workAccord: input.accord,
    policy: input.policy,
    registry: input.registry,
    domainPack: input.domainPack,
    currentPhaseContract: input.humanReview,
    destinationPhaseContract: null,
    activationLease: null,
    humanGateEvidence: [gate],
    contractRequirementEvidence: [requirement],
    requesterId: "synthetic-requester",
    evaluatedAt: "2026-08-29T12:32:01.000Z",
    retryableFailure: false,
    rebindAuthority: null
  };
  const result = evaluateTransition(snapshot, event, context);
  if (result.kind !== "applied" || result.snapshot.state !== "COMPLETED") {
    throw new TypeError(
      `synthetic human continuation did not reach Completed: ${canonicalJson(result)}`
    );
  }
  const current = input.reconstruction.currentStage;
  const next = input.reconstruction.nextStage;
  if (
    current.executionKind !== "human" ||
    next === null ||
    next.executionKind !== "terminal"
  ) {
    throw new TypeError("human continuation is not at the terminal journey edge");
  }
  const artifact = createDemoContract("StageArtifactEnvelope", {
    demoProjectId: input.reconstruction.runState.spec.demoProjectId,
    stageId: current.stageId,
    projectProfileDigest:
      input.reconstruction.authority.contracts.profile.contentDigest,
    journeyDefinitionDigest:
      input.reconstruction.authority.contracts.journey.contentDigest,
    stageAgentBindingsDigest:
      input.reconstruction.authority.contracts.bindings.contentDigest,
    authorityEpoch: input.reconstruction.runState.spec.authorityEpoch,
    generation: input.reconstruction.runState.spec.generation,
    runId: input.reconstruction.runState.spec.runId,
    runAttempt: input.reconstruction.runState.spec.runAttempt,
    producer: {
      kind: "human",
      agentId: null,
      capabilityId: null,
      workflowId: null
    },
    inputDigest: digest(gate),
    artifact: {
      kind: "SyntheticHumanCompletionEvidence",
      schemaVersion: "1.0.0",
      mediaType: "application/json",
      byteLength: 1,
      contentDigest: digest({
        gate,
        requirement,
        kernelReceiptDigest: result.receiptDigest
      })
    },
    createdAt: event.occurredAt
  });
  const receiptSpec: SignedStageReceipt["spec"] = {
    demoProjectId: input.reconstruction.runState.spec.demoProjectId,
    projectProfileDigest:
      input.reconstruction.authority.contracts.profile.contentDigest,
    journeyDefinitionDigest:
      input.reconstruction.authority.contracts.journey.contentDigest,
    stageAgentBindingsDigest:
      input.reconstruction.authority.contracts.bindings.contentDigest,
    authorityEpoch: input.reconstruction.runState.spec.authorityEpoch,
    generation: input.reconstruction.runState.spec.generation,
    runId: input.reconstruction.runState.spec.runId,
    runAttempt: input.reconstruction.runState.spec.runAttempt,
    runStateDigest: input.reconstruction.runState.contentDigest,
    stageId: current.stageId,
    stageOrdinal: current.ordinal,
    nextStageId: next.stageId,
    nextStageOrdinal: next.ordinal,
    previousStageReceiptDigest:
      input.reconstruction.runState.spec.journey.previousStageReceiptDigest,
    artifactEnvelopeDigest: artifact.contentDigest,
    runFenceDigest: null,
    releasedRunFenceDigest: null,
    coreBefore: demoCoreBindingFromSnapshot(snapshot),
    coreAfter: demoCoreBindingFromSnapshot(result.snapshot),
    kernelTransitionReceiptDigest: result.receiptDigest,
    appliedKernelResultDigest: digest(result),
    outcome: "completed",
    completedAt: event.occurredAt
  };
  const receiptDigest = demoContractContentDigest(
    "SignedStageReceipt",
    receiptSpec
  );
  const receipt = validateDemoContract("SignedStageReceipt", {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "SignedStageReceipt",
    schemaVersion: "1.0.0",
    contentDigest: receiptDigest,
    spec: receiptSpec,
    signature: signature(receiptDigest)
  });
  const completedRunState = advanceDemoJourney({
    runState: input.reconstruction.runState,
    authority: input.reconstruction.authority,
    receipt,
    artifact,
    runFence: null,
    releasedRunFence: null,
    appliedKernelResult: result,
    workAccord: input.accord,
    verifier: {
      verify: (candidate) =>
        candidate.signature.value === signature(candidate.contentDigest).value
    }
  });
  return {
    kernelReceiptDigest: result.receiptDigest,
    stageReceiptDigest: receipt.contentDigest,
    completedRunState,
    gate,
    snapshot,
    event,
    context
  };
}

async function isolatedLocalGit(): Promise<{
  readonly commitSha: string;
  readonly networkCalls: 0;
  readonly credentialReads: 0;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "hyperfinite-demo-simulation-"));
  try {
    await mkdir(path.join(root, "fixture"), { recursive: true });
    await writeFile(path.join(root, "fixture", "trace.txt"), "hermetic\n", "utf8");
    const env = {
      PATH: TRUSTED_PATH,
      HOME: root,
      LANG: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Hermetic Simulator",
      GIT_AUTHOR_EMAIL: "simulator@example.invalid",
      GIT_COMMITTER_NAME: "Hermetic Simulator",
      GIT_COMMITTER_EMAIL: "simulator@example.invalid",
      GIT_AUTHOR_DATE: "2026-08-29T12:00:00Z",
      GIT_COMMITTER_DATE: "2026-08-29T12:00:00Z"
    };
    execFileSync(
      GIT_EXECUTABLE,
      ["-c", "init.templateDir=", "init", "--quiet", "--initial-branch=main"],
      {
        cwd: root,
        env
      }
    );
    const runtimeScenarioTestsPassed = true;
    execFileSync(GIT_EXECUTABLE, ["add", "--", "fixture/trace.txt"], {
      cwd: root,
      env
    });
    execFileSync(GIT_EXECUTABLE, ["commit", "--quiet", "-m", "Hermetic fixture"], {
      cwd: root,
      env
    });
    return {
      commitSha: execFileSync(GIT_EXECUTABLE, ["rev-parse", "HEAD"], {
        cwd: root,
        env,
        encoding: "utf8"
      }).trim(),
      networkCalls: 0,
      credentialReads: 0
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const lifecycle = assertDocument(
  "LifecycleGraph",
  await readStrictJsonFile("config/v1alpha1/lifecycle.json")
);
const registry = assertDocument(
  "CapabilityRegistry",
  await readStrictJsonFile("config/v1alpha1/capability-registry.json")
);
const policy = assertDocument(
  "ControlPolicy",
  await readStrictJsonFile("config/v1alpha1/policy.json")
);
const domainPack = assertDocument(
  "DomainPackPolicy",
  await readStrictJsonFile("config/v1alpha1/domain-pack-policy.json")
);
const humanReview = assertDocument(
  "PhaseContract",
  await readStrictJsonFile("config/v1alpha1/phase-contracts/human-review.json")
);
const metadata = await loadDemoRegistrationMetadata({ baseRegistry: registry });
const loadedContracts = await loadDemoProjectContractSets({
  baseRegistry: registry,
  lifecycle
});
const accordValue = (await readStrictJsonFile(
  "examples/v1alpha1/work-accord.json"
)) as WorkAccord;
const accord = assertDocument("WorkAccord", {
  ...accordValue,
  binding: {
    ...accordValue.binding,
    currentHead: digest("simulation-current-head")
  }
});

const simulationDemos = [];
const typedEvidence: {
  readonly demoProjectId: (typeof DEMOS)[number];
  readonly authority: DemoRuntimeAuthority;
  readonly journey: DemoRuntimeReconstruction;
  readonly reviewBundle: DemoReviewEvidenceBundle;
  readonly reviewObservation: DemoReviewEvidenceObservation;
  readonly reviewBinding: TrustedDemoRuntimeBinding;
  readonly workAccord: WorkAccord;
  readonly allowedPathAccord: WorkAccord;
  readonly allowedPathGrant: BoundedExecutionGrant;
  readonly human: ReturnType<typeof humanCompletion>;
}[] = [];
const fixtureDeclaredExternalCalls = {
  github: 0,
  network: 0,
  credentials: 0,
  paidInference: 0
};

function externalCallAssertions(
  value: unknown,
  expectedDemoProjectId: (typeof DEMOS)[number]
): Readonly<Record<keyof typeof fixtureDeclaredExternalCalls, 0>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("external-call assertions must be one closed object");
  }
  const assertion = value as Readonly<Record<string, unknown>>;
  if (
    Object.keys(assertion).sort().join(",") !==
      "apiVersion,counters,demoProjectId,kind,schemaVersion,scope" ||
    assertion["apiVersion"] !== "agentic-framework.github.com/v1alpha1" ||
    assertion["kind"] !== "DemoExternalCallAssertions" ||
    assertion["schemaVersion"] !== "1.0.0" ||
    assertion["demoProjectId"] !== expectedDemoProjectId ||
    assertion["scope"] !== "fixture-declared-external-call-assertions" ||
    typeof assertion["counters"] !== "object" ||
    assertion["counters"] === null ||
    Array.isArray(assertion["counters"])
  ) {
    throw new TypeError("external-call assertions are malformed or cross-demo");
  }
  const counters = assertion["counters"] as Readonly<Record<string, unknown>>;
  const expectedKeys = ["credentials", "github", "network", "paidInference"];
  if (
    Object.keys(counters).sort().join(",") !== expectedKeys.join(",") ||
    expectedKeys.some((key) => counters[key] !== 0)
  ) {
    throw new TypeError(
      "external-call assertions require the exact four zero counters"
    );
  }
  return counters as Readonly<
    Record<keyof typeof fixtureDeclaredExternalCalls, 0>
  >;
}
for (const [index, original] of loadedContracts.entries()) {
  const contracts = enabledContracts(original);
  const demoProjectId = contracts.profile.spec.demoProjectId;
  const packWorkAccord = assertDocument(
    "WorkAccord",
    await readStrictJsonFile(PACK_WORK_ACCORDS[demoProjectId])
  );
  const [framing, planning, execution, verification, packHumanReview] =
    await Promise.all(
      [
        "framing",
        "planning",
        "execution",
        "verification",
        "human-review"
      ].map(async (phase) =>
        assertDocument(
          "PhaseContract",
          await readStrictJsonFile(
            `config/v1alpha1/demo-projects/${demoProjectId}/phase-contracts/${phase}.json`
          )
        )
      )
    );
  if (
    framing === undefined ||
    planning === undefined ||
    execution === undefined ||
    verification === undefined ||
    packHumanReview === undefined
  ) {
    throw new TypeError(`${demoProjectId} Phase Contract set is incomplete`);
  }
  const packPhases: Readonly<Record<ActiveDemoPhase, PhaseContract>> = {
    framing,
    planning,
    execution,
    verification,
    "human-review": packHumanReview
  };
  const demoRegistry = assertDocument("CapabilityRegistry", {
    ...registry,
    capabilities: [
      ...registry.capabilities,
      ...contracts.capabilities.spec.capabilities
    ]
  });
  const demoDomainPack = assertDocument("DomainPackPolicy", {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "DomainPackPolicy",
    id: `demo-${demoProjectId}`,
    version: "1.0.0",
    allowedCapabilities: [
      ...new Set([
        ...packWorkAccord.policy.requestedCapabilities,
        "core.refuse-authority-escalation@1.0.0"
      ])
    ],
    prohibitedEffects: [
      ...new Set([
        ...packWorkAccord.policy.prohibitedEffects,
        ...accord.policy.prohibitedEffects
      ])
    ],
    depthCeiling: packWorkAccord.policy.depthProfile,
    riskCeiling: "high",
    privacyCeiling: "confidential",
    maxCalls: packWorkAccord.budget.maxCalls,
    maxCostUnits: packWorkAccord.budget.maxCostUnits,
    maxLoops: packWorkAccord.budget.maxLoops,
    maxRetries: packWorkAccord.budget.maxRetries,
    maxParallel: packWorkAccord.budget.maxParallel
  });
  const journeyWorkAccord = assertDocument("WorkAccord", {
    ...packWorkAccord,
    binding: {
      ...packWorkAccord.binding,
      policyDigest: digest(policy),
      lifecycleGraphDigest: digest(lifecycle),
      currentHead: digest(`${demoProjectId}:current-head`)
    },
    policy: {
      ...packWorkAccord.policy,
      domainPack: `${demoDomainPack.id}@${demoDomainPack.version}`,
      domainPackDigest: digest(demoDomainPack),
      capabilityRegistryDigest: digest(demoRegistry),
      riskClass: "high",
      privacyClass: "confidential",
      prohibitedEffects: demoDomainPack.prohibitedEffects,
      phaseContracts: {
        ...packWorkAccord.policy.phaseContracts,
        "human-review": {
          reference:
            `${packHumanReview.identity.id}@${packHumanReview.identity.version}`,
          digest: digest(packHumanReview)
        }
      }
    }
  });
  const allowedPath = packWorkAccord.policy.allowedPaths[0];
  if (allowedPath === undefined) {
    throw new TypeError(`${demoProjectId} Work Accord has no allowed path`);
  }
  const allowedPathGrant: BoundedExecutionGrant = {
    repositoryId: packWorkAccord.binding.repositoryId,
    workItemNodeId: packWorkAccord.binding.workItemNodeId,
    workAccordDigest: digest(packWorkAccord),
    activationLeaseDigest: digest(`${demoProjectId}:allowed-path-lease`),
    snapshotDigest: digest(`${demoProjectId}:allowed-path-snapshot`),
    routeId: "planning.execute",
    baseSha: "a".repeat(40),
    targets: [
      {
        slot: "portfolio-substitution-probe",
        path: allowedPath,
        operation: "modify",
        expectedDigest: digest(`${demoProjectId}:before`),
        expectedMode: "100644",
        maxBytes: 1024
      }
    ],
    verificationCommandIds: packWorkAccord.evidence.verificationCommands,
    maxFiles: 1,
    maxPatchBytes: Math.min(packWorkAccord.budget.maxPatchBytes, 4096),
    maxTurns: 1,
    maxCostUnits: Math.min(packWorkAccord.budget.maxCostUnits, 1),
    expiresAt: EXPIRES
  };
  const runtimeAuthority: DemoRuntimeAuthority = {
    catalog: metadata.catalog,
    reservations: metadata.reservations,
    lifecycle,
    baseRegistry: registry,
    contracts,
    workAccord: accord
  };
  const journeyAuthority: DemoRuntimeAuthority = {
    ...runtimeAuthority,
    workAccord: journeyWorkAccord
  };
  const runtimeLease = activationLease(contracts, accord, demoProjectId);
  const journeyLease = activationLease(
    contracts,
    journeyWorkAccord,
    demoProjectId
  );
  const runtimeProbe = await runRuntimeProbe({
    authority: runtimeAuthority,
    lease: runtimeLease,
    policy,
    domainPack
  });
  const reviewStage = contracts.bindings.spec.stageBindings.find(
    (stage) =>
      stage.runtimeBindings[0]?.workflowClass === "current-head-comment-review"
  );
  if (reviewStage === undefined) {
    throw new TypeError(`${demoProjectId} has no exact-head review stage`);
  }
  const commandIds = demoReviewExpectedCommandIds(demoProjectId);
  const checkIds = demoReviewExpectedCheckIds(demoProjectId);
  const headSha = `${index + 1}`.repeat(40);
  const repositoryIdentity = {
    id: packWorkAccord.binding.repositoryId,
    nodeId: packWorkAccord.binding.repositoryNodeId,
    owner:
      packWorkAccord.binding.repositoryFullName.split("/")[0] ??
      "example-organization",
    name:
      packWorkAccord.binding.repositoryFullName.split("/")[1] ??
      "synthetic-repository",
    fullName: packWorkAccord.binding.repositoryFullName
  };
  const pullRequest = {
    kind: "pull-request" as const,
    number: 100 + index,
    nodeId: `${packWorkAccord.binding.workItemNodeId}:${demoProjectId}:review`,
    base: {
      repository: repositoryIdentity,
      ref: "refs/heads/main",
      sha: "0".repeat(40)
    },
    head: {
      repository: repositoryIdentity,
      ref: `refs/heads/simulation/${demoProjectId}`,
      sha: headSha
    }
  };
  const trustedGitHubBinding: TrustedGitHubBinding = {
    repository: repositoryIdentity,
    workItem: pullRequest,
    project: {
      ...PACK_PROJECT_TARGETS[demoProjectId],
      schemaDigest: digest(`${demoProjectId}:project-schema`),
      bindingDigest: contracts.profile.spec.projectBindingDigest,
      fields: []
    },
    installation: {
      id: 1,
      accountNodeId: "O_simulation",
      repositorySelection: "selected",
      repositoryIds: [packWorkAccord.binding.repositoryId]
    }
  };
  const targetIdentity = {
    repositoryId: repositoryIdentity.id,
    repositoryNodeId: repositoryIdentity.nodeId,
    repositoryFullName: repositoryIdentity.fullName,
    workItemNumber: pullRequest.number,
    workItemNodeId: pullRequest.nodeId,
    projectOwnerNodeId: trustedGitHubBinding.project.ownerNodeId,
    projectNodeId: trustedGitHubBinding.project.projectNodeId,
    projectItemNodeId: trustedGitHubBinding.project.itemNodeId
  };
  const targetIdentityPayload = {
    projectProfileDigest: contracts.profile.contentDigest,
    repositoryBindingDigest:
      contracts.profile.spec.repositoryBindingDigest,
    projectBindingDigest: contracts.profile.spec.projectBindingDigest,
    targetIdentity,
    observedAt: NOW,
    expiresAt: EXPIRES
  };
  const targetIdentityEvidence = issueTrustedDemoTargetIdentityEvidence({
    ...targetIdentityPayload,
    signature: signature(targetIdentityPayload),
    verifier,
    clock: { now: () => NOW }
  });
  const trustedReviewBinding = issueTrustedDemoRuntimeBinding({
    catalog: metadata.catalog,
    reservations: metadata.reservations,
    lifecycle,
    baseRegistry: registry,
    contracts,
    stageId: reviewStage.stageId,
    targetIdentityEvidence,
    targetIdentityClock: { now: () => NOW }
  });
  const model = new HermeticFakeModel();
  const journeyProbe = await fullJourneyReconstruction({
    authority: journeyAuthority,
    lease: journeyLease,
    pullRequestNumber: pullRequest.number,
    pullRequestHeadSha: pullRequest.head.sha,
    model,
    policy,
    registry: demoRegistry,
    domainPack: demoDomainPack,
    humanReview: packHumanReview,
    phases: packPhases
  });
  for (const invocation of journeyProbe.modelInvocations) {
    const { signature: invocationSignature, ...payload } = invocation;
    if (!verifier.verify(payload, invocationSignature)) {
      throw new TypeError("fake model invocation evidence is unauthenticated");
    }
    const receipt = journeyProbe.reconstruction.completedReceipts.find(
      (candidate) => candidate.spec.stageId === invocation.stageId
    );
    const acquired = journeyProbe.reconstruction.fences.find(
      (candidate) =>
        candidate.contentDigest === receipt?.spec.runFenceDigest
    );
    const released = journeyProbe.reconstruction.fences.find(
      (candidate) =>
        candidate.contentDigest === receipt?.spec.releasedRunFenceDigest
    );
    if (
      receipt === undefined ||
      acquired === undefined ||
      released === undefined ||
      released.spec.releasedAt === null ||
      Date.parse(acquired.spec.acquiredAt) >
        Date.parse(invocation.startedAt) ||
      Date.parse(invocation.completedAt) >
        Date.parse(released.spec.releasedAt)
    ) {
      throw new TypeError(
        "signed fake model invocation is outside its exact run fence"
      );
    }
  }
  const modelFencesValidated = true;
  const diffFiles = [
    {
      pathDigest: digest(`${demoProjectId}:bounded-path`),
      status: "modified" as const,
      additions: 1,
      deletions: 0,
      blobSha: `${index + 4}`.repeat(40),
      patchDigest: digest(`${demoProjectId}:bounded-patch`)
    }
  ];
  const commandEvidence = commandIds.map((id) => ({
    id,
    status: "success" as const,
    stdoutDigest: digest(`${demoProjectId}:${id}:stdout`),
    stderrDigest: digest("")
  }));
  const checkEvidence = checkIds.map((id) => ({
    id,
    status:
      id === "unrelated-scanner-finding-open-unchanged"
        ? ("information" as const)
        : ("success" as const),
    evidenceDigest: digest(`${demoProjectId}:${id}:evidence`)
  }));
  const reviewObservation: DemoReviewEvidenceObservation = {
    repositoryBindingDigest:
      contracts.profile.spec.repositoryBindingDigest,
    trustedGitHubBinding,
    pullRequestState: { draft: true, state: "open" },
    diffFiles,
    diffPageCount: 1,
    diffCollectionComplete: true,
    commands: commandEvidence,
    checks: checkEvidence,
    observedAt: NOW
  };
  let reviewReadCount = 0;
  const issuedReviewBundle = await issueDemoReviewEvidenceBundle({
    trustedDemoBinding: trustedReviewBinding,
    signer,
    reader: {
      read: async () => {
        reviewReadCount += 1;
        return reviewObservation;
      }
    },
    createdAt: NOW,
    expiresAt: EXPIRES
  });
  const reviewBundle = validateDemoReviewEvidenceBundle({
    value: issuedReviewBundle,
    trustedDemoBinding: trustedReviewBinding,
    trustedObservation: reviewObservation,
    verifier,
    expectedHeadSha: pullRequest.head.sha,
    now: NOW
  });
  const fixturePaths = PACK_FIXTURES[demoProjectId];
  const fixtureEvidence = {
    handsOff: await readStrictJsonFile(fixturePaths.handsOff),
    human: await readStrictJsonFile(fixturePaths.human),
    recovery: await readStrictJsonFile(fixturePaths.recovery),
    adversarial: await readStrictJsonFile(fixturePaths.adversarial),
    externalCalls: await readStrictJsonFile(fixturePaths.externalCalls)
  };
  const fixtureEvidenceDigest = digest(fixtureEvidence);
  const declaredCalls = externalCallAssertions(
    fixtureEvidence.externalCalls,
    demoProjectId
  );
  for (const key of Object.keys(fixtureDeclaredExternalCalls) as Array<
    keyof typeof fixtureDeclaredExternalCalls
  >) {
    fixtureDeclaredExternalCalls[key] += declaredCalls[key];
  }
  if (Object.values(fixtureDeclaredExternalCalls).some((count) => count !== 0)) {
    throw new TypeError(`${demoProjectId} fixture attempted an external call`);
  }
  const auditInputs: DemoRuntimeAuditInput[] =
    journeyProbe.reconstruction.completedReceipts.flatMap((receipt) => {
      const stage = contracts.journey.spec.stages.find(
        (candidate) => candidate.stageId === receipt.spec.stageId
      );
      const artifact = journeyProbe.reconstruction.artifacts.find(
        (candidate) =>
          candidate.contentDigest === receipt.spec.artifactEnvelopeDigest
      );
      if (stage === undefined || artifact === undefined) {
        throw new TypeError("validated journey receipt lost its stage artifact");
      }
      const subject = artifact.contentDigest;
      const invocation = journeyProbe.modelInvocations.find(
        (candidate) => candidate.stageId === stage.stageId
      );
      return [
        ...(invocation === undefined
          ? []
          : [
              {
                kind: "stage-start" as const,
                occurredAt: invocation.startedAt,
                outcome: "accepted" as const,
                reasonCode: "STAGE_STARTED",
                authorityDigest: contracts.profile.contentDigest,
                subjectDigest: digest(invocation),
                usage: {
                  attempts: 0,
                  tokens: 0,
                  toolCalls: 0,
                  effects: 0,
                  durationMs: 0
                }
              }
            ]),
        {
          kind: "stage-complete" as const,
          occurredAt: receipt.spec.completedAt,
          outcome: "accepted" as const,
          reasonCode: "STAGE_COMPLETED",
          authorityDigest: contracts.bindings.contentDigest,
          subjectDigest: subject,
          usage: {
            attempts: 0,
            tokens: 0,
            toolCalls: 0,
            effects: 0,
            durationMs: 0
          }
        }
      ];
    });
  auditInputs.push(
    {
      kind: "run-attempt",
      occurredAt: "2026-08-29T12:10:00.100Z",
      outcome: "accepted",
      reasonCode: "RUN_ATTEMPT_BOUND",
      authorityDigest: contracts.activation.contentDigest,
      subjectDigest: digest(`${demoProjectId}:simulation-run:1`),
      usage: { attempts: 1, tokens: 0, toolCalls: 0, effects: 0, durationMs: 0 }
    },
    {
      kind: "binding",
      occurredAt: "2026-08-29T12:10:00.101Z",
      outcome: "accepted",
      reasonCode: "BINDING_VERIFIED",
      authorityDigest: contracts.bindings.contentDigest,
      subjectDigest: digest(trustedReviewBinding.binding),
      usage: { attempts: 0, tokens: 0, toolCalls: 0, effects: 0, durationMs: 0 }
    },
    {
      kind: "lifecycle-transition",
      occurredAt: "2026-08-29T12:10:00.102Z",
      outcome: "accepted",
      reasonCode: "KERNEL_RECEIPT_DURABLE",
      authorityDigest: digest(lifecycle),
      subjectDigest: digest(runtimeProbe.kernelRoute),
      usage: { attempts: 0, tokens: 0, toolCalls: 0, effects: 0, durationMs: 1 }
    },
    {
      kind: "artifact",
      occurredAt: "2026-08-29T12:10:00.103Z",
      outcome: "accepted",
      reasonCode: "ARTIFACT_DIGEST_BOUND",
      authorityDigest: contracts.profile.contentDigest,
      subjectDigest: reviewBundle.bundleDigest,
      usage: { attempts: 0, tokens: 0, toolCalls: 0, effects: 0, durationMs: 0 }
    },
    {
      kind: "budget-reservation",
      occurredAt: "2026-08-29T12:10:00.104Z",
      outcome: "accepted",
      reasonCode: "BUDGET_STATE_OBSERVED",
      authorityDigest: contracts.activation.contentDigest,
      subjectDigest: journeyProbe.reconstruction.budget.contentDigest,
      usage: {
        attempts: 0,
        tokens: 0,
        toolCalls: 0,
        effects: 0,
        durationMs: 0
      }
    },
    {
      kind: "model-usage",
      occurredAt: "2026-08-29T12:10:00.105Z",
      outcome: "accepted",
      reasonCode: "HERMETIC_MODEL_USAGE",
      authorityDigest: contracts.bindings.contentDigest,
      subjectDigest: digest(journeyProbe.modelInvocations),
      usage: {
        attempts: journeyProbe.modelInvocations.reduce(
          (total, invocation) => total + invocation.usage.calls,
          0
        ),
        tokens: journeyProbe.modelInvocations.reduce(
          (total, invocation) => total + invocation.usage.tokens,
          0
        ),
        toolCalls: 0,
        effects: 0,
        durationMs: journeyProbe.modelInvocations.reduce(
          (total, invocation) =>
            total +
            (Date.parse(invocation.completedAt) -
              Date.parse(invocation.startedAt)),
          0
        )
      }
    },
    {
      kind: "tool-usage",
      occurredAt: "2026-08-29T12:10:00.106Z",
      outcome: "accepted",
      reasonCode: "SIGNED_COMMAND_EVIDENCE",
      authorityDigest: reviewBundle.commandCatalogDigest,
      subjectDigest: digest(commandIds),
      usage: {
        attempts: 0,
        tokens: 0,
        toolCalls: commandEvidence.length,
        effects: 0,
        durationMs: 0
      }
    },
    {
      kind: "cost-usage",
      occurredAt: "2026-08-29T12:10:00.107Z",
      outcome: "accepted",
      reasonCode: "COST_USAGE_OBSERVED",
      authorityDigest: contracts.activation.contentDigest,
      subjectDigest: journeyProbe.reconstruction.budget.contentDigest,
      usage: {
        attempts: 0,
        tokens: 0,
        costUnits: journeyProbe.modelInvocations.reduce(
          (total, invocation) => total + invocation.usage.costUnits,
          0
        ),
        toolCalls: 0,
        effects: 0,
        durationMs: 0
      }
    },
    {
      kind: "provider-usage",
      occurredAt: "2026-08-29T12:10:00.108Z",
      outcome: "accepted",
      reasonCode: "HERMETIC_PROVIDER_USAGE",
      authorityDigest: contracts.activation.contentDigest,
      subjectDigest: digest(journeyProbe.modelInvocations),
      usage: {
        attempts: 0,
        tokens: 0,
        toolCalls: 0,
        effects: 0,
        durationMs: 0
      }
    },
    {
      kind: "retry",
      occurredAt: "2026-08-29T12:10:00.109Z",
      outcome: "accepted",
      reasonCode: "RETRY_FIXTURE_VALIDATED",
      authorityDigest: contracts.journey.contentDigest,
      subjectDigest: fixtureEvidenceDigest,
      usage: { attempts: 0, tokens: 0, toolCalls: 0, effects: 0, durationMs: 0 }
    },
    {
      kind: "refusal",
      occurredAt: "2026-08-29T12:10:00.110Z",
      outcome: "accepted",
      reasonCode: "REFUSAL_FIXTURE_VALIDATED",
      authorityDigest: contracts.journey.contentDigest,
      subjectDigest: fixtureEvidenceDigest,
      usage: { attempts: 0, tokens: 0, toolCalls: 0, effects: 0, durationMs: 0 }
    },
    {
      kind: "block",
      occurredAt: "2026-08-29T12:10:00.111Z",
      outcome: "accepted",
      reasonCode: "BLOCK_FIXTURE_VALIDATED",
      authorityDigest: contracts.journey.contentDigest,
      subjectDigest: fixtureEvidenceDigest,
      usage: { attempts: 0, tokens: 0, toolCalls: 0, effects: 0, durationMs: 0 }
    },
    {
      kind: "projection",
      occurredAt: "2026-08-29T12:10:00.112Z",
      outcome: "accepted",
      reasonCode: "STAGE_WRITTEN_LAST",
      authorityDigest: contracts.projection.contentDigest,
      subjectDigest: digest(runtimeProbe.projectionWrites),
      usage: {
        attempts: 0,
        tokens: 0,
        toolCalls: 0,
        effects: runtimeProbe.projectionWrites.length,
        durationMs: 0
      }
    },
    {
      kind: "draft-pr",
      occurredAt: "2026-08-29T12:10:00.113Z",
      outcome: "accepted",
      reasonCode: "DRAFT_PR_OBSERVED",
      authorityDigest: reviewBundle.bundleDigest,
      subjectDigest: digest(headSha),
      usage: { attempts: 0, tokens: 0, toolCalls: 0, effects: 0, durationMs: 0 }
    },
    {
      kind: "human-action",
      occurredAt: "2026-08-29T12:10:00.114Z",
      outcome: "accepted",
      reasonCode: "HUMAN_REVIEW_REQUIRED",
      authorityDigest: digest(journeyWorkAccord),
      subjectDigest: digest(`${demoProjectId}:human-review`),
      usage: { attempts: 0, tokens: 0, toolCalls: 0, effects: 0, durationMs: 0 }
    },
    {
      kind: "reconciliation",
      occurredAt: "2026-08-29T12:10:00.115Z",
      outcome: "accepted",
      reasonCode: "LOST_ACK_FIXTURE_VALIDATED",
      authorityDigest: contracts.journey.contentDigest,
      subjectDigest: fixtureEvidenceDigest,
      usage: { attempts: 0, tokens: 0, toolCalls: 0, effects: 0, durationMs: 0 }
    },
    {
      kind: "recovery",
      occurredAt: "2026-08-29T12:10:00.116Z",
      outcome: "accepted",
      reasonCode: "RECOVERY_FIXTURE_VALIDATED",
      authorityDigest: contracts.journey.contentDigest,
      subjectDigest: fixtureEvidenceDigest,
      usage: { attempts: 0, tokens: 0, toolCalls: 0, effects: 0, durationMs: 0 }
    }
  );
  const observability = createDemoRuntimeObservabilityBatch(auditInputs);
  const human = humanCompletion({
    demoProjectId,
    lifecycle,
    accord: journeyWorkAccord,
    policy,
    registry: demoRegistry,
    domainPack: demoDomainPack,
    humanReview: packHumanReview,
    reconstruction: journeyProbe.reconstruction
  });
  simulationDemos.push({
    demoProjectId,
    profileDigest: contracts.profile.contentDigest,
    bindingDigest: contracts.bindings.contentDigest,
    workAccordDigest: digest(journeyWorkAccord),
    journey: contracts.journey.spec.stages.map((stage) => ({
      stageId: stage.stageId,
      executionKind: stage.executionKind,
      coreState: stage.coreState
    })),
    handsOffTraversedStages: [
      ...journeyProbe.reconstruction.completedReceipts.map(
        (receipt) => receipt.spec.stageId
      ),
      journeyProbe.reconstruction.currentStage.stageId
    ],
    handsOffStop: journeyProbe.reconstruction.currentStage.stageId,
    syntheticHumanContinuation: {
      authority: "human-only",
      state: human.completedRunState.spec.core.state,
      kernelReceiptDigest: human.kernelReceiptDigest,
      stageReceiptDigest: human.stageReceiptDigest,
      completedRunStateDigest: human.completedRunState.contentDigest
    },
    runtimeProbe: {
      ...runtimeProbe,
      fullJourneyDispatcherAction: journeyProbe.dispatcherAction,
      fullJourneySchedulerAction: journeyProbe.schedulerAction,
      fullJourneyProjectionWrites: journeyProbe.projectionWrites,
      fullJourneyProjectionReadCount: journeyProbe.projectionReadCount,
      fullJourneyProjectionOrder: journeyProbe.projectionOrder,
      fullJourneyProjectionInitialKernelVersion:
        journeyProbe.projectionInitialKernelVersion,
      fullJourneyProjectionFinalKernelVersion:
        journeyProbe.projectionFinalKernelVersion,
      fullJourneyKernelStateVersion: journeyProbe.kernelStateVersion,
      fullJourneyAppliedKernelResultDigests:
        journeyProbe.appliedKernelResultDigests,
      completedStageReceiptDigests:
        journeyProbe.reconstruction.completedReceipts.map(
          (receipt) => receipt.contentDigest
        )
    },
    reviewEvidenceDigest: reviewBundle.bundleDigest,
    reviewEvent: reviewBundle.reviewEvent,
    reviewReadCount,
    reviewHeadValidated:
      reviewBundle.pullRequest.headSha === pullRequest.head.sha,
    draftPullRequestOnly:
      journeyProbe.reconstruction.runState.spec.currentDraftPullRequest
        ?.draft === true,
    modelInvocations: journeyProbe.modelInvocations.length,
    modelUsageDigest: digest(journeyProbe.modelInvocations),
    modelFencesValidated,
    fixtureEvidenceDigest: digest(fixtureEvidence),
    observability: {
      ndjsonDigest: digest(observability.newlineDelimitedJson),
      eventCount: observability.events.length,
      metricCount: observability.metrics.length,
      newlineDelimitedJson: observability.newlineDelimitedJson
    }
  });
  typedEvidence.push({
    demoProjectId,
    authority: journeyAuthority,
    journey: journeyProbe.reconstruction,
    reviewBundle,
    reviewObservation,
    reviewBinding: trustedReviewBinding,
    workAccord: journeyWorkAccord,
    allowedPathAccord: packWorkAccord,
    allowedPathGrant,
    human
  });
}

const substitutions = [];
const substitutionRefusals: Readonly<
  Record<(typeof SUBSTITUTION_CLASSES)[number], RegExp>
> = {
  "repository-issue-project-binding":
    /bundle identity|target identity|trusted Project binding/u,
  "work-accord-profile":
    /authoritative Kernel and contracts|Work Accord/u,
  artifacts: /artifact|stage receipt history/u,
  receipts: /receipt|stage evidence cardinality/u,
  approvals: /HUMAN_GATE_MISSING:gate\.valid-evidence/u,
  budgets: /DemoBudgetState|budget/u,
  "agent-bindings": /does not identify one model binding/u,
  "allowed-path-grants": /exact Work Accord target/u
};
for (const evidenceClass of SUBSTITUTION_CLASSES) {
  for (const source of DEMOS) {
    for (const target of DEMOS) {
      if (source === target) continue;
      const sourceEvidence = typedEvidence.find(
        (candidate) => candidate.demoProjectId === source
      );
      const targetEvidence = typedEvidence.find(
        (candidate) => candidate.demoProjectId === target
      );
      if (sourceEvidence === undefined || targetEvidence === undefined) {
        throw new TypeError("canonical substitution contracts are missing");
      }
      const targetJourney = targetEvidence.journey;
      const receiptVerifier = {
        verify: (receipt: SignedStageReceipt) =>
          receipt.signature.value === signature(receipt.contentDigest).value
      };
      let refused = false;
      let refusalMessage: string | null = null;
      try {
        switch (evidenceClass) {
          case "repository-issue-project-binding":
            validateDemoReviewEvidenceBundle({
              value: sourceEvidence.reviewBundle,
              trustedDemoBinding: targetEvidence.reviewBinding,
              trustedObservation: sourceEvidence.reviewObservation,
              verifier,
              expectedHeadSha:
                sourceEvidence.reviewBundle.pullRequest.headSha,
              now: NOW
            });
            break;
          case "approvals": {
            const result = evaluateTransition(
              targetEvidence.human.snapshot,
              targetEvidence.human.event,
              {
                ...targetEvidence.human.context,
                humanGateEvidence: [sourceEvidence.human.gate]
              }
            );
            if (
              result.kind === "refused" &&
              result.refusal.code === "HUMAN_GATE_MISSING" &&
              result.refusal.ruleId === "gate.valid-evidence"
            ) {
              throw new TypeError(
                "HUMAN_GATE_MISSING:gate.valid-evidence"
              );
            }
            if (result.kind === "refused") {
              throw new Error(
                `unexpected approval refusal: ${canonicalJson(result.refusal)}`
              );
            }
            break;
          }
          case "work-accord-profile":
            reconstructDemoRuntime({
              authority: {
                ...targetEvidence.authority,
                workAccord: sourceEvidence.workAccord
              },
              runState: targetJourney.runState,
              kernelSnapshot: targetJourney.kernelSnapshot,
              activationLease: targetJourney.activationLease,
              budget: targetJourney.budget,
              projection: targetJourney.projection,
              completedReceipts: targetJourney.completedReceipts,
              artifacts: targetJourney.artifacts,
              fences: targetJourney.fences,
              receiptVerifier,
              evaluatedAt: NOW
            });
            break;
          case "artifacts":
            reconstructDemoRuntime({
              authority: targetEvidence.authority,
              runState: targetJourney.runState,
              kernelSnapshot: targetJourney.kernelSnapshot,
              activationLease: targetJourney.activationLease,
              budget: targetJourney.budget,
              projection: targetJourney.projection,
              completedReceipts: targetJourney.completedReceipts,
              artifacts: sourceEvidence.journey.artifacts,
              fences: targetJourney.fences,
              receiptVerifier,
              evaluatedAt: NOW
            });
            break;
          case "receipts":
            reconstructDemoRuntime({
              authority: targetEvidence.authority,
              runState: targetJourney.runState,
              kernelSnapshot: targetJourney.kernelSnapshot,
              activationLease: targetJourney.activationLease,
              budget: targetJourney.budget,
              projection: targetJourney.projection,
              completedReceipts: sourceEvidence.journey.completedReceipts,
              artifacts: targetJourney.artifacts,
              fences: targetJourney.fences,
              receiptVerifier,
              evaluatedAt: NOW
            });
            break;
          case "budgets":
            reconstructDemoRuntime({
              authority: targetEvidence.authority,
              runState: targetJourney.runState,
              kernelSnapshot: targetJourney.kernelSnapshot,
              activationLease: targetJourney.activationLease,
              budget: sourceEvidence.journey.budget,
              projection: targetJourney.projection,
              completedReceipts: targetJourney.completedReceipts,
              artifacts: targetJourney.artifacts,
              fences: targetJourney.fences,
              receiptVerifier,
              evaluatedAt: NOW
            });
            break;
          case "agent-bindings": {
            const sourceStage =
              sourceEvidence.authority.contracts.bindings.spec.stageBindings.find(
                (stage) => stage.runtimeBindings.length === 1
              );
            const targetStage =
              targetEvidence.authority.contracts.bindings.spec.stageBindings.find(
                (stage) => stage.runtimeBindings.length === 1
              );
            const sourceBinding = sourceStage?.runtimeBindings[0];
            if (
              sourceStage === undefined ||
              targetStage === undefined ||
              sourceBinding === undefined
            ) {
              throw new TypeError("model-stage binding probe is incomplete");
            }
            await loadTrustedDemoRuntimeBindingForSelection({
              baseRegistry: registry,
              lifecycle,
              demoProjectId: target,
              stageId: targetStage.stageId,
              phase: sourceBinding.phase,
              role: sourceBinding.role,
              capability: sourceBinding.capability,
              workflowId: sourceBinding.workflow
            });
            break;
          }
          case "allowed-path-grants":
            validateBoundedExecutionGrant({
              accord: targetEvidence.allowedPathAccord,
              grant: sourceEvidence.allowedPathGrant,
              clock: { now: () => NOW }
            });
            break;
        }
      } catch (error) {
        if (
          error instanceof Error &&
          substitutionRefusals[evidenceClass].test(error.message)
        ) {
          refused = true;
          refusalMessage = error.message;
        } else {
          throw error;
        }
      }
      if (!refused) {
        throw new TypeError(
          `${evidenceClass} ${source}->${target} substitution was accepted`
        );
      }
      substitutions.push({
        evidenceClass,
        source,
        target,
        result: refused ? "refused" : "accepted",
        beforeInference: true,
        beforeEffects: true,
        reasonCode: "CROSS_DEMO_SUBSTITUTION",
        refusalDigest: digest(refusalMessage)
      });
    }
  }
}

const localGit = await isolatedLocalGit();
const runtimeScenarioOutput = execFileSync(
  process.execPath,
  [
    "--import=./dist/scripts/deny-network.js",
    "--test",
    "--test-reporter=junit",
    "dist/tests/control-kernel.test.js",
    "dist/tests/demo-runtime.test.js",
    "dist/tests/app-modernization-demo.test.js",
    "dist/tests/feature-delivery-demo.test.js",
    "dist/tests/security-dependency-remediation-demo.test.js"
  ],
  {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: "pipe",
    env: {
      PATH: TRUSTED_PATH,
      HOME: tmpdir(),
      LANG: "C",
      CI: "true",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0"
    }
  }
);
const runtimeScenarioTestsPassed = true;
if (/<(?:failure|error|skipped)\b/iu.test(runtimeScenarioOutput)) {
  throw new TypeError(
    "runtime scenario JUnit contains a failed, errored, skipped, or todo test"
  );
}
const passedTestNameCounts = new Map<string, number>();
for (const match of runtimeScenarioOutput.matchAll(
  /<testcase name="([^"]+)"[^>]*(?:\/>|>([\s\S]*?)<\/testcase>)/gu
)) {
  const name = match[1];
  const body = match[2] ?? "";
  if (
    name === undefined ||
    /<(?:failure|error|skipped)\b/iu.test(body)
  ) {
    continue;
  }
  passedTestNameCounts.set(name, (passedTestNameCounts.get(name) ?? 0) + 1);
}
const recoveryTests = {
  duplicate: "valid transition is applied once and duplicate delivery is a no-op",
  "out-of-order": "replay, ordering, concurrency, and provenance checks fail closed",
  concurrent: "cross-workflow scheduler permits one fence winner and settles authenticated usage",
  stale: "security verification fails closed on missing, non-success, or stale evidence",
  partial: "pause, resume, partial failure, and retry preserve bound authority",
  "lost-ack": "projection convergence writes Kernel Stage last and reconciles lost acknowledgements",
  pause: "pause, resume, block, retry, and cancel preserve or invalidate the demo cursor from Kernel state",
  resume: "planning resume restores a ready cursor and converges a lagging PAUSED projection",
  cancel: "blocked cancellation is terminal without rotating generation or requiring a budget store",
  revision: "in-phase revisions require activation but not a future artifact approval",
  "retry-limit": "budget, loop, retry, and safe-integer limits fail closed",
  repair: "scope repair uses the applied backward Kernel route to invalidate only the affected stage suffix",
  replan: "verification replan applies the Kernel route and returns to planning",
  reauthorization: "repair, retry, reconciliation, and reauthorization fixtures fail closed"
} as const;
if (
  new Set(Object.values(recoveryTests)).size !==
  Object.keys(recoveryTests).length
) {
  throw new TypeError(
    "recovery scenarios must map one-to-one to exact passed tests"
  );
}
const recoveryCases = Object.entries(recoveryTests).map(
  ([id, testName]) => {
    if (passedTestNameCounts.get(testName) !== 1) {
      throw new TypeError(`runtime scenario tests did not exercise ${id}`);
    }
    return {
      id,
      verifiedByRuntimeScenarioTests: runtimeScenarioTestsPassed,
      testName,
      authorityGranted: false,
      deterministic: true
    };
  }
);
const stageLast = simulationDemos.every(
  (demo) =>
    demo.runtimeProbe.projectionWrites.at(-1) === "stage" &&
    demo.runtimeProbe.fullJourneyProjectionWrites.at(-1) === "stage"
);
const humanOnlyCompletion = simulationDemos.every(
  (demo) =>
    demo.handsOffStop === "human-review" &&
    demo.syntheticHumanContinuation.authority === "human-only" &&
    demo.syntheticHumanContinuation.state === "COMPLETED"
);
const commentOnly = simulationDemos.every(
  (demo) => demo.reviewEvent === "COMMENT"
);
const projectionNeverLeadsKernel = simulationDemos.every(
  (demo) =>
    demo.runtimeProbe.fullJourneyProjectionInitialKernelVersion <=
      demo.runtimeProbe.fullJourneyKernelStateVersion &&
    demo.runtimeProbe.fullJourneyProjectionFinalKernelVersion ===
      demo.runtimeProbe.fullJourneyKernelStateVersion
);
const fullReadAfterWrite = simulationDemos.every(
  (demo) => {
    const order = demo.runtimeProbe.fullJourneyProjectionOrder;
    const nextEventIndex = order.indexOf("next-event");
    const writeIndexes = order.flatMap((entry, index) =>
      entry.startsWith("projection:") ? [index] : []
    );
    return (
      nextEventIndex === order.length - 1 &&
      writeIndexes.length ===
        demo.runtimeProbe.fullJourneyProjectionWrites.length &&
      writeIndexes.every(
        (index) =>
          order[index + 1]?.startsWith("projection-read:") === true &&
          index < nextEventIndex
      ) &&
      order[writeIndexes.at(-1) ?? -1] === "projection:stage"
    );
  }
);
const kernelReceiptBeforeProjection = simulationDemos.every((demo) => {
  const kernelIndex = demo.runtimeProbe.operationOrder.indexOf("kernel");
  const projectionIndex = demo.runtimeProbe.operationOrder.findIndex((entry) =>
    entry.startsWith("projection:") && !entry.startsWith("projection-read:")
  );
  return kernelIndex >= 0 && projectionIndex > kernelIndex;
});
const currentHeadValidated = simulationDemos.every(
  (demo) =>
    demo.reviewReadCount >= 2 &&
    demo.reviewHeadValidated &&
    demo.runtimeProbe.currentHeadValidated
);
const body = {
  schemaVersion: "1.0.0",
  mode: "hermetic-all-demo",
  generatedAt: NOW,
  authorityOrder: [
    "lifecycle",
    "work-accord-and-phase-contracts",
    "policy-and-capability-registry",
    "control-kernel",
    "trusted-adapter",
    "single-writer",
    "model-output"
  ],
  demos: simulationDemos,
  substitutions,
  recoveryCases,
  invariants: {
    projectNeverLeadsKernel: projectionNeverLeadsKernel,
    projectionDriftAuthorizesAdvancement: !projectionNeverLeadsKernel,
    kernelReceiptBeforeProjectProjection: kernelReceiptBeforeProjection,
    stageWrittenLast: stageLast,
    fullReadAfterWriteBeforeNextEvent: fullReadAfterWrite,
    draftPullRequestsOnly: simulationDemos.every(
      (demo) => demo.draftPullRequestOnly
    ),
    currentHeadRequired: currentHeadValidated,
    automatedReviewEvent: commentOnly ? "COMMENT" : "INVALID",
    automationCanApprove: !commentOnly,
    automationCanMerge: !humanOnlyCompletion
  },
  localGit,
  externalCallCounterScope: "fixture-declared-external-call-assertions",
  externalCallCounters: {
    ...fixtureDeclaredExternalCalls
  }
};
const result = {
  ...body,
  traceDigest: digest(body)
};

if (format === "ndjson") {
  const eventLines = simulationDemos
    .map((demo) => demo.observability.newlineDelimitedJson)
    .join("");
  process.stdout.write(
    `${eventLines}${canonicalJson({
      kind: "DemoPortfolioSimulationSummary",
      traceDigest: result.traceDigest,
      externalCallCounters: result.externalCallCounters
    })}\n`
  );
} else {
  process.stdout.write(`${canonicalJson(result)}\n`);
}
