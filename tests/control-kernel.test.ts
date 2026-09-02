import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import domainPackDocument from "../config/v1alpha1/domain-pack-policy.json" with { type: "json" };
import lifecycleDocument from "../config/v1alpha1/lifecycle.json" with { type: "json" };
import phaseDocument from "../config/v1alpha1/phase-contracts/framing.json" with { type: "json" };
import policyDocument from "../config/v1alpha1/policy.json" with { type: "json" };
import registryDocument from "../config/v1alpha1/capability-registry.json" with { type: "json" };
import accordDocument from "../examples/v1alpha1/work-accord.json" with { type: "json" };
import { authorizeActor } from "../src/authorization.js";
import { workAccordBindingDigest } from "../src/binding.js";
import { digest } from "../src/canonical.js";
import {
  compiledHumanGatesHaveLifecycleRoutes,
  createInitialSnapshot,
  evaluateTransition,
  eventPayloadDigest,
  type KernelContext
} from "../src/kernel.js";
import {
  ACTIVE_PHASE_OWNERS,
  allowsNullPhaseAuthority,
  isActivePhaseOwner,
  isCostBearingPhaseOwner,
  isCostBearingState,
  selectRoute,
  validateLifecycleGraph,
  validateSnapshotLifecycleSemantics
} from "../src/lifecycle.js";
import {
  createDefaultMigrationRegistry,
  MigrationRegistry
} from "../src/migrations.js";
import { compareCodeUnits, compilePolicy } from "../src/policy.js";
import { verifyReceiptChain } from "../src/receipts.js";
import { validateRegistrySemantics } from "../src/registry.js";
import type {
  ActivationLease,
  ActivePhaseOwner,
  Actor,
  ActorClass,
  AuthorityRebind,
  CapabilityRegistry,
  ContractRequirementEvidence,
  Digest,
  EventEnvelope,
  EventType,
  HumanGateEvidence,
  KernelSnapshot,
  LifecycleGraph,
  LifecycleState,
  PhaseContract,
  PhaseOwner,
  TransitionReceipt,
  WorkAccord
} from "../src/types.js";
import { assertDocument, validateDocument } from "../src/validation.js";
import { renderWorkAccordMarkdown } from "../src/work-accord-markdown.js";

const lifecycle = assertDocument("LifecycleGraph", lifecycleDocument);
const policy = assertDocument("ControlPolicy", policyDocument);
const registry = assertDocument("CapabilityRegistry", registryDocument);
const domainPack = assertDocument("DomainPackPolicy", domainPackDocument);
const framingPhase = assertDocument("PhaseContract", phaseDocument);
const exampleAccord = assertDocument("WorkAccord", accordDocument);
const bindingDigest = workAccordBindingDigest(exampleAccord);
const policyDigest = digest(policy);
const activePhases = [
  "framing",
  "planning",
  "execution",
  "verification",
  "human-review"
] as const;

const actorRoles: Record<ActorClass, readonly string[]> = {
  requester: ["work-item-requester"],
  reviewer: ["eligible-reviewer"],
  maintainer: ["repository-maintainer"],
  administrator: ["repository-administrator"],
  system: ["trusted-kernel"],
  policy: ["trusted-policy"]
};

function actor(actorClass: ActorClass, id = `${actorClass}-1`): Actor {
  return {
    id,
    class: actorClass,
    human: !["system", "policy"].includes(actorClass),
    bot: false,
    roles: actorRoles[actorClass],
    authorizationDigest: digest({ actorClass, id, current: true })
  };
}

function phaseFor(
  phaseOwner: Exclude<PhaseOwner, "kernel" | "intake">,
  graph: LifecycleGraph = lifecycle
): PhaseContract {
  if (phaseOwner === "framing" && graph === lifecycle) {
    return framingPhase;
  }
  const exitByPhase = {
    planning: {
      predicate: "eligible-human-accepts-plan",
      event: "execution-authorized"
    },
    execution: {
      predicate: "work-submitted-for-verification",
      event: "work-submitted"
    },
    verification: {
      predicate: "verification-evidence-passed",
      event: "verification-passed"
    },
    "human-review": {
      predicate: "eligible-human-accepts-outcome",
      event: "outcome-accepted"
    }
  } as const;
  return {
    ...framingPhase,
    identity: { id: `core.${phaseOwner}`, version: "1.0.0" },
    phase: phaseOwner,
    compatibleLifecycleDigest: digest(graph),
    entryPredicates: ["work-accord-current"],
    requiredEvidence: ["trusted-binding"],
    allowedCapabilities: [],
    humanGates: [],
    exitRules:
      phaseOwner === "framing"
        ? framingPhase.exitRules
        : [exitByPhase[phaseOwner]]
  };
}

function accordFor(
  graph: LifecycleGraph = lifecycle,
  phases: readonly PhaseContract[] = activePhases.map((owner) =>
    phaseFor(owner, graph)
  )
): WorkAccord {
  function bindingFor(owner: ActivePhaseOwner) {
    const contract = phases.find((candidate) => candidate.phase === owner);
    assert.ok(contract, `missing ${owner} Phase Contract`);
    return {
      reference: `${contract.identity.id}@${contract.identity.version}`,
      digest: digest(contract)
    };
  }
  return {
    ...exampleAccord,
    binding: {
      ...exampleAccord.binding,
      policyDigest,
      lifecycleGraphDigest: digest(graph)
    },
    policy: {
      ...exampleAccord.policy,
      domainPackDigest: digest(domainPack),
      capabilityRegistryDigest: digest(registry),
      phaseContracts: {
        framing: bindingFor("framing"),
        planning: bindingFor("planning"),
        execution: bindingFor("execution"),
        verification: bindingFor("verification"),
        "human-review": bindingFor("human-review")
      }
    }
  };
}

const accord = accordFor();
const accordDigest = digest(accord);

function event(input: {
  readonly type: EventType;
  readonly actorClass: ActorClass;
  readonly expectedStateVersion?: number;
  readonly sequence?: number;
  readonly id?: string;
  readonly deliveryId?: string;
  readonly cost?: EventEnvelope["cost"];
  readonly actorId?: string;
  readonly provenanceSource?: EventEnvelope["provenance"]["source"];
  readonly provenanceBindingDigest?: Digest;
  readonly replacementAuthorityDigest?: Digest | null;
  readonly occurredAt?: string;
}): EventEnvelope {
  const envelope: EventEnvelope = {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "KernelEvent",
    id: input.id ?? `event-${input.sequence ?? 1}-${input.type}`,
    sequence: input.sequence ?? 1,
    occurredAt: input.occurredAt ?? "2026-08-26T12:00:00Z",
    expectedStateVersion: input.expectedStateVersion ?? 0,
    type: input.type,
    replacementAuthorityDigest: input.replacementAuthorityDigest ?? null,
    actor: actor(input.actorClass, input.actorId),
    provenance: {
      source: input.provenanceSource ?? "test-fixture",
      deliveryId: input.deliveryId ?? `delivery-${input.sequence ?? 1}`,
      bindingDigest: input.provenanceBindingDigest ?? bindingDigest,
      payloadDigest: digest("pending")
    },
    cost: input.cost ?? { calls: 0, tokens: 0, costUnits: 0, loops: 0 }
  };
  return {
    ...envelope,
    provenance: {
      ...envelope.provenance,
      payloadDigest: eventPayloadDigest(envelope)
    }
  };
}

function replacementAuthority(input?: {
  readonly graph?: LifecycleGraph;
  readonly currentHead?: Digest | null;
  readonly revision?: number;
  readonly supersedes?: string | null;
  readonly repositoryId?: number;
  readonly workItemNodeId?: string;
  readonly sourceDigest?: Digest;
  readonly budget?: Partial<WorkAccord["budget"]>;
}): AuthorityRebind {
  const graph = input?.graph ?? lifecycle;
  const phases = activePhases.map((owner) => phaseFor(owner, graph));
  const baseAccord = accordFor(graph, phases);
  const workAccord: WorkAccord = {
    ...baseAccord,
    identity: {
      ...baseAccord.identity,
      id: "issue-9-r2",
      revision: input?.revision ?? accord.identity.revision + 1,
      supersedes: input?.supersedes ?? accord.identity.id
    },
    binding: {
      ...baseAccord.binding,
      repositoryId:
        input?.repositoryId ?? baseAccord.binding.repositoryId,
      workItemNodeId:
        input?.workItemNodeId ?? baseAccord.binding.workItemNodeId,
      sourceDigest: input?.sourceDigest ?? baseAccord.binding.sourceDigest,
      currentHead: input?.currentHead ?? digest("replacement-head")
    },
    budget: {
      ...baseAccord.budget,
      ...input?.budget
    }
  };
  return {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "AuthorityRebind",
    schemaVersion: "1.0.0",
    bindingDigest: workAccordBindingDigest(workAccord),
    graph,
    workAccord,
    policy,
    registry,
    domainPack,
    phaseContracts: phases
  };
}

function gate(
  name: string,
  gateActor: Actor,
  workAccord: WorkAccord = accord,
  currentHead: Digest | null = workAccord.binding.currentHead,
  expiresAt = "2027-01-01T00:00:00Z"
): HumanGateEvidence {
  return {
    gate: name,
    actor: gateActor,
    workAccordDigest: digest(workAccord),
    activationLeaseDigest: null,
    currentHead,
    observedAt: "2026-08-26T11:59:00Z",
    expiresAt,
    valid: true
  };
}

function requirementEvidence(input: {
  readonly requirementType: "predicate" | "evidence";
  readonly requirement: string;
  readonly workAccord?: WorkAccord;
  readonly actorAuthorizationDigest?: Digest | null;
  readonly satisfied?: boolean;
  readonly expiresAt?: string;
}): ContractRequirementEvidence {
  const workAccord = input.workAccord ?? accord;
  return {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "ContractRequirementEvidence",
    requirementType: input.requirementType,
    requirement: input.requirement,
    satisfied: input.satisfied ?? true,
    workAccordDigest: digest(workAccord),
    bindingDigest,
    snapshotDigest: digest("unbound-snapshot"),
    phaseContractDigest: digest(framingPhase),
    routeId: "test.route",
    activationLeaseDigest: null,
    currentHead: workAccord.binding.currentHead,
    actorAuthorizationDigest: input.actorAuthorizationDigest ?? null,
    observedAt: "2026-08-26T11:59:00Z",
    expiresAt: input.expiresAt ?? "2027-01-01T00:00:00Z"
  };
}

function defaultRequirementEvidence(
  workAccord: WorkAccord
): readonly ContractRequirementEvidence[] {
  return [
    requirementEvidence({
      requirementType: "predicate",
      requirement: "activation-lease-current",
      workAccord
    }),
    requirementEvidence({
      requirementType: "predicate",
      requirement: "work-accord-current",
      workAccord
    }),
    requirementEvidence({
      requirementType: "predicate",
      requirement: "eligible-human-accepts-frame",
      workAccord,
      actorAuthorizationDigest: actor("reviewer").authorizationDigest
    }),
    requirementEvidence({
      requirementType: "predicate",
      requirement: "eligible-human-accepts-plan",
      workAccord,
      actorAuthorizationDigest: actor("reviewer").authorizationDigest
    }),
    requirementEvidence({
      requirementType: "predicate",
      requirement: "work-submitted-for-verification",
      workAccord,
      actorAuthorizationDigest: actor("system").authorizationDigest
    }),
    requirementEvidence({
      requirementType: "predicate",
      requirement: "verification-evidence-passed",
      workAccord,
      actorAuthorizationDigest: actor("system").authorizationDigest
    }),
    requirementEvidence({
      requirementType: "predicate",
      requirement: "eligible-human-accepts-outcome",
      workAccord,
      actorAuthorizationDigest: actor("reviewer").authorizationDigest
    }),
    requirementEvidence({
      requirementType: "evidence",
      requirement: "trusted-binding",
      workAccord
    }),
    requirementEvidence({
      requirementType: "evidence",
      requirement: "activation-lease",
      workAccord
    })
  ];
}

function bindRequirementEvidence(input: {
  readonly evidence: readonly ContractRequirementEvidence[];
  readonly snapshot: KernelSnapshot;
  readonly current: PhaseContract | null;
  readonly destination: PhaseContract | null;
  readonly graph: LifecycleGraph;
  readonly activationLease: ActivationLease | null;
}): readonly ContractRequirementEvidence[] {
  const bound: ContractRequirementEvidence[] = [];
  for (const route of input.graph.routes.filter(
    (candidate) => candidate.from === input.snapshot.state
  )) {
    const enteringNewPhase =
      input.destination !== null &&
      route.phaseOwner === input.destination.phase &&
      (input.current === null ||
        input.destination.phase !== input.current.phase);
    const exitRule =
      input.current !== null &&
      (enteringNewPhase || route.to === "COMPLETED")
        ? input.current.exitRules.find((rule) => rule.event === route.event)
        : undefined;
    for (const evidence of input.evidence) {
      const sourceRequirement =
        evidence.requirementType === "predicate" &&
        evidence.requirement === exitRule?.predicate;
      const destinationRequirement =
        enteringNewPhase &&
        input.destination !== null &&
        ((evidence.requirementType === "predicate" &&
          input.destination.entryPredicates.includes(evidence.requirement)) ||
          (evidence.requirementType === "evidence" &&
            input.destination.requiredEvidence.includes(evidence.requirement)));
      if (!sourceRequirement && !destinationRequirement) {
        continue;
      }
      const phaseContract =
        sourceRequirement ? input.current : input.destination;
      assert.ok(phaseContract);
      bound.push({
        ...evidence,
        snapshotDigest: digest(input.snapshot),
        phaseContractDigest: digest(phaseContract),
        routeId: route.id,
        activationLeaseDigest:
          evidence.requirement === "activation-lease-current" ||
          evidence.requirement === "activation-lease"
            ? input.activationLease === null
              ? null
              : digest(input.activationLease)
            : null
      });
    }
  }
  return bound;
}

function lease(
  workAccord: WorkAccord,
  allowedPhase: ActivePhaseOwner | readonly ActivePhaseOwner[],
  allowedCapabilities: readonly string[]
): ActivationLease {
  const approver = actor("maintainer");
  return {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "ActivationLease",
    id: "lease-1",
    workAccordDigest: digest(workAccord),
    approvedBy: approver.id,
    authorizationDigest: approver.authorizationDigest,
    allowedPhases:
      typeof allowedPhase === "string" ? [allowedPhase] : allowedPhase,
    allowedCapabilities,
    maxCalls: 10,
    maxTokens: 100000,
    maxCostUnits: 100,
    maxParallel: 2,
    expiresAt: "2027-01-01T00:00:00Z",
    revoked: false
  };
}

function gateForLease(
  name: string,
  gateActor: Actor,
  activationLease: ActivationLease,
  workAccord: WorkAccord = accord
): HumanGateEvidence {
  return {
    ...gate(name, gateActor, workAccord),
    activationLeaseDigest:
      name === "activate" ? digest(activationLease) : null
  };
}

function compile(
  contract: PhaseContract,
  workAccord: WorkAccord = accord,
  capabilityRegistry: CapabilityRegistry = registry
) {
  const result = compilePolicy({
    enterprise: policy,
    accord: workAccord,
    phase: contract,
    domainPack,
    registry: capabilityRegistry
  });
  assert.equal(result.ok, true, result.ok ? "" : result.errors.join("; "));
  if (!result.ok) throw new Error("unreachable");
  return result.policy;
}

function harness(input?: {
  readonly state?: LifecycleState;
  readonly phaseOwner?: PhaseOwner;
  readonly stateVersion?: number;
  readonly sequence?: number;
  readonly authorityPhase?: Exclude<PhaseOwner, "kernel" | "intake"> | null;
  readonly destinationPhase?: Exclude<PhaseOwner, "kernel" | "intake"> | null;
  readonly currentPhaseContract?: PhaseContract | null;
  readonly destinationPhaseContract?: PhaseContract | null;
  readonly activationLease?: ActivationLease | null;
  readonly gates?: readonly HumanGateEvidence[];
  readonly retryableFailure?: boolean;
  readonly usage?: KernelSnapshot["usage"];
  readonly phaseUsage?: KernelSnapshot["phaseUsage"];
  readonly suspendedState?: LifecycleState | null;
  readonly recoveryState?: LifecycleState | null;
  readonly graph?: LifecycleGraph;
  readonly workAccord?: WorkAccord;
  readonly capabilityRegistry?: CapabilityRegistry;
  readonly contractRequirementEvidence?: readonly ContractRequirementEvidence[];
}): { snapshot: KernelSnapshot; context: KernelContext } {
  const graph = input?.graph ?? lifecycle;
  const workAccord = input?.workAccord ?? accord;
  const capabilityRegistry = input?.capabilityRegistry ?? registry;
  const authorityPhase = input?.authorityPhase ?? null;
  const currentContract =
    input?.currentPhaseContract !== undefined
      ? input.currentPhaseContract
      : authorityPhase === null
        ? null
        : phaseFor(authorityPhase, graph);
  const compiled =
    currentContract === null
      ? null
      : compile(currentContract, workAccord, capabilityRegistry);
  const destinationOwner =
    input?.destinationPhase === undefined
      ? authorityPhase ?? "framing"
      : input.destinationPhase;
  const destinationContract =
    input?.destinationPhaseContract !== undefined
      ? input.destinationPhaseContract
      : destinationOwner === null
        ? null
        : phaseFor(destinationOwner, graph);
  const activationLease = input?.activationLease ?? null;
  const initial = createInitialSnapshot({
    lifecycleGraphDigest: digest(graph),
    workAccord,
    capabilityRegistryDigest: digest(capabilityRegistry),
    domainPackDigest: digest(domainPack),
    policyDigest
  });
  const snapshot: KernelSnapshot = {
    ...initial,
    state: input?.state ?? "CAPTURED",
    phaseOwner: input?.phaseOwner ?? "intake",
    stateVersion: input?.stateVersion ?? 0,
    lastEventSequence: input?.sequence ?? 0,
    phaseContractDigest:
      currentContract === null ? null : digest(currentContract),
    compiledPolicyDigest: compiled?.digest ?? null,
    suspendedState: input?.suspendedState ?? null,
    recoveryState: input?.recoveryState ?? null,
    usage: input?.usage ?? initial.usage,
    phaseUsage: input?.phaseUsage ?? initial.phaseUsage
  };
  return {
    snapshot,
    context: {
      graph,
      workAccord,
      policy,
      registry: capabilityRegistry,
      domainPack,
      currentPhaseContract: currentContract,
      destinationPhaseContract: destinationContract,
      activationLease,
      humanGateEvidence: (input?.gates ?? []).map((evidence) =>
        evidence.gate === "activate" && activationLease !== null
          ? {
              ...evidence,
              activationLeaseDigest: digest(activationLease)
            }
          : evidence
      ),
      contractRequirementEvidence: bindRequirementEvidence({
        evidence:
          input?.contractRequirementEvidence ??
          defaultRequirementEvidence(workAccord),
        snapshot,
        current: currentContract,
        destination: destinationContract,
        graph,
        activationLease
      }),
      requesterId: "requester-1",
      evaluatedAt: "2026-08-26T12:00:01Z",
      retryableFailure: input?.retryableFailure ?? false,
      rebindAuthority: null
    }
  };
}

function expectRefusal(
  result: ReturnType<typeof evaluateTransition>,
  code: string
): void {
  assert.equal(result.kind, "refused");
  if (result.kind === "refused") assert.equal(result.refusal.code, code);
}

test("versioned configuration and fixtures satisfy closed schemas", async () => {
  for (const [kind, value] of [
    ["LifecycleGraph", lifecycleDocument],
    ["ControlPolicy", policyDocument],
    ["CapabilityRegistry", registryDocument],
    ["DomainPackPolicy", domainPackDocument],
    ["PhaseContract", phaseDocument],
    ["WorkAccord", accordDocument]
  ] as const) {
    assert.equal(validateDocument(kind, value).valid, true, kind);
  }
  assert.equal(
    validateDocument("HumanGateEvidence", gate("activate", actor("maintainer"))).valid,
    true
  );
  assert.equal(
    validateDocument(
      "ContractRequirementEvidence",
      requirementEvidence({
        requirementType: "evidence",
        requirement: "trusted-binding"
      })
    ).valid,
    true
  );
  assert.equal(validateDocument("KernelSnapshot", harness().snapshot).valid, true);
  for (const name of ["activation-requested.json", "partial-effect-recorded.json"]) {
    const source = await readFile(
      path.resolve("tests/fixtures/events", name),
      "utf8"
    );
    assert.equal(validateDocument("KernelEvent", JSON.parse(source)).valid, true);
  }
  const ordinaryEvent = event({
    type: "activation-requested",
    actorClass: "requester"
  });
  assert.equal(
    validateDocument("KernelEvent", {
      ...ordinaryEvent,
      replacementAuthorityDigest: digest("unexpected-authority")
    }).valid,
    false
  );
  assert.equal(
    validateDocument(
      "KernelEvent",
      event({
        type: "binding-revalidated",
        actorClass: "policy",
        provenanceSource: "policy-engine"
      })
    ).valid,
    false
  );
  assert.equal(
    validateDocument("WorkAccord", { ...accordDocument, authority: "approved" }).valid,
    false
  );
});

test("date-time boundaries require real canonical UTC calendar values", () => {
  const invalid = [
    "2026-02-30T00:00:00Z",
    "2025-02-29T00:00:00Z",
    "2026-13-01T00:00:00Z",
    "2026-00-01T00:00:00Z",
    "2026-08-26T24:00:00Z",
    "2026-08-26T12:60:00Z",
    "2026-08-26T12:00:60Z",
    "2026-08-26T12:00:00.1234Z",
    "2026-08-26T12:00:00+00:00",
    "2026-08-26T12:00:00",
    "2026-08-26 12:00:00Z"
  ];
  for (const createdAt of invalid) {
    assert.equal(
      validateDocument("WorkAccord", {
        ...accord,
        identity: { ...accord.identity, createdAt }
      }).valid,
      false,
      createdAt
    );
  }
  for (const createdAt of [
    "2024-02-29T00:00:00Z",
    "2026-08-26T12:00:00Z",
    "2026-08-26T12:00:00.123Z"
  ]) {
    assert.equal(
      validateDocument("WorkAccord", {
        ...accord,
        identity: { ...accord.identity, createdAt }
      }).valid,
      true,
      createdAt
    );
  }
  const base = harness();
  expectRefusal(
    evaluateTransition(
      base.snapshot,
      event({
        type: "activation-requested",
        actorClass: "requester",
        occurredAt: "2026-02-28T12:00:00Z"
      }),
      { ...base.context, evaluatedAt: "2026-02-30T12:00:00Z" }
    ),
    "PROVENANCE_INVALID"
  );
});

test("lifecycle routes are unique, selectable, and cost-bearing truth is derived", () => {
  assert.deepEqual(validateLifecycleGraph(lifecycle), []);
  for (const route of lifecycle.routes) {
    const selected = selectRoute(
      lifecycle,
      route.from,
      route.event,
      route.from === "PAUSED" ? route.to : null,
      route.from === "BLOCKED" ? route.to : null
    );
    assert.notEqual(selected, null, route.id);
    assert.notEqual(selected, "ambiguous", route.id);
    if (selected !== null && selected !== "ambiguous") {
      assert.equal(selected.id, route.id);
    }
    assert.equal(route.costBearing, isCostBearingState(route.to), route.id);
  }
  for (const state of lifecycle.states) {
    assert.equal(state.costBearing, isCostBearingState(state.id), state.id);
  }
});

test("only approved active phases can carry contracts and capabilities", () => {
  assert.deepEqual(ACTIVE_PHASE_OWNERS, activePhases);
  for (const phase of activePhases) {
    assert.equal(isActivePhaseOwner(phase), true);
  }
  for (const forbiddenPhase of ["intake", "kernel"] as const) {
    assert.equal(isActivePhaseOwner(forbiddenPhase), false);
    const invalidContract = {
      ...framingPhase,
      identity: { id: `invalid.${forbiddenPhase}`, version: "1.0.0" },
      phase: forbiddenPhase
    };
    assert.equal(validateDocument("PhaseContract", invalidContract).valid, false);
    const compilation = compilePolicy({
      enterprise: policy,
      accord,
      phase: invalidContract as unknown as PhaseContract,
      domainPack,
      registry
    });
    assert.equal(compilation.ok, false);
    if (!compilation.ok) {
      assert.ok(
        compilation.errors.some((error) =>
          error.includes("PhaseContract: /phase")
        )
      );
    }

    const invalidRegistry = {
      ...registry,
      capabilities: registry.capabilities.map((capability, index) =>
        index === 0
          ? { ...capability, allowedPhases: [forbiddenPhase] }
          : capability
      )
    };
    assert.equal(validateDocument("CapabilityRegistry", invalidRegistry).valid, false);
    assert.ok(
      validateRegistrySemantics(
        invalidRegistry as unknown as CapabilityRegistry
      ).some((error) => error.path.endsWith("/allowedPhases"))
    );
  }

  assert.equal(
    validateDocument("WorkAccord", {
      ...accord,
      policy: {
        ...accord.policy,
        phaseContracts: {
          ...accord.policy.phaseContracts,
          intake: accord.policy.phaseContracts.framing
        }
      }
    }).valid,
    false
  );

  const malformedRegistry = {
    ...registry,
    capabilities: registry.capabilities.map((capability, index) =>
      index === 0 ? { ...capability, allowedPhases: null } : capability
    )
  };
  assert.doesNotThrow(() =>
    validateRegistrySemantics(
      malformedRegistry as unknown as CapabilityRegistry
    )
  );
  const malformedCompilation = compilePolicy({
    enterprise: policy,
    accord,
    phase: framingPhase,
    domainPack,
    registry: malformedRegistry as unknown as CapabilityRegistry
  });
  assert.equal(malformedCompilation.ok, false);
});

test("policy compilation fails closed before reading malformed documents", () => {
  const malformedRegistry = {
    ...registry,
    defaults: null
  };
  let result: ReturnType<typeof compilePolicy> | undefined;
  assert.doesNotThrow(() => {
    result = compilePolicy({
      enterprise: policy,
      accord,
      phase: framingPhase,
      domainPack,
      registry: malformedRegistry as unknown as CapabilityRegistry
    });
  });
  assert.equal(result?.ok, false);
  if (result !== undefined && !result.ok) {
    assert.ok(
      result.errors.some((error) =>
        error.includes("CapabilityRegistry: /defaults")
      )
    );
  }
});

test("code-unit ordering is locale independent for policy digests", () => {
  assert.deepEqual(
    ["a.b", "a-b", "a", "A"].sort(compareCodeUnits),
    ["A", "a", "a-b", "a.b"]
  );
});

test("CAPTURED is initial-only and cannot grant intake capabilities", () => {
  const intakeRoute: LifecycleGraph["routes"][number] = {
    id: "planning.return-captured",
    version: "1.0.0",
    from: "PLANNED",
    to: "CAPTURED",
    event: "activation-requested",
    actorClasses: ["requester"],
    phaseOwner: "intake",
    costBearing: false,
    humanGate: null,
    retryable: false,
    maxAttempts: 1
  };
  const malicious: LifecycleGraph = {
    ...lifecycle,
    routes: [...lifecycle.routes, intakeRoute]
  };
  assert.equal(validateDocument("LifecycleGraph", malicious).valid, false);
  assert.ok(
    validateLifecycleGraph(malicious).some(
      (error) =>
        error.path.endsWith("/to") &&
        error.message.includes("initial-only")
    )
  );

  const workAccord = accordFor(malicious);
  const base = harness({
    state: "PLANNED",
    phaseOwner: "planning",
    authorityPhase: "planning",
    destinationPhase: null,
    graph: malicious,
    workAccord
  });
  const result = evaluateTransition(
    base.snapshot,
    event({ type: "activation-requested", actorClass: "requester" }),
    base.context
  );
  expectRefusal(result, "SCHEMA_INVALID");
});

test("conventional terminal flags and terminal restart prohibition are immutable", () => {
  const terminalStates = new Set<LifecycleState>(["COMPLETED", "CANCELLED"]);
  for (const state of lifecycle.states) {
    const tampered: LifecycleGraph = {
      ...lifecycle,
      states: lifecycle.states.map((candidate) =>
        candidate.id === state.id
          ? { ...candidate, terminal: !candidate.terminal }
          : candidate
      )
    };
    assert.equal(validateDocument("LifecycleGraph", tampered).valid, false, state.id);
    assert.ok(
      validateLifecycleGraph(tampered).some(
        (error) =>
          error.path.endsWith("/terminal") &&
          error.message.includes(state.id)
      ),
      state.id
    );
    assert.equal(state.terminal, terminalStates.has(state.id), state.id);
  }

  for (const from of ["COMPLETED", "CANCELLED"] as const) {
    const restartRoute: LifecycleGraph["routes"][number] = {
      id: `${from.toLowerCase()}.restart`,
      version: "1.0.0",
      from,
      to: "FRAMING",
      event: "activation-approved",
      actorClasses: ["maintainer"],
      phaseOwner: "framing",
      costBearing: true,
      humanGate: "activate",
      retryable: false,
      maxAttempts: 1
    };
    const restarted: LifecycleGraph = {
      ...lifecycle,
      routes: [...lifecycle.routes, restartRoute]
    };
    assert.equal(validateDocument("LifecycleGraph", restarted).valid, false, from);
    assert.ok(
      validateLifecycleGraph(restarted).some(
        (error) =>
          error.path.endsWith("/from") &&
          error.message.includes("terminal state")
      ),
      from
    );
  }

  const restartRoute: LifecycleGraph["routes"][number] = {
    id: "cancelled.restart",
    version: "1.0.0",
    from: "CANCELLED",
    to: "FRAMING",
    event: "activation-approved",
    actorClasses: ["maintainer"],
    phaseOwner: "framing",
    costBearing: true,
    humanGate: "activate",
    retryable: false,
    maxAttempts: 1
  };
  const malicious: LifecycleGraph = {
    ...lifecycle,
    routes: [...lifecycle.routes, restartRoute]
  };
  const workAccord = accordFor(malicious);
  const activationLease = lease(workAccord, "framing", [
    "core.frame-artifact@1.0.0"
  ]);
  const base = harness({
    state: "CANCELLED",
    phaseOwner: "kernel",
    graph: malicious,
    workAccord,
    activationLease,
    gates: [gate("activate", actor("maintainer"), workAccord)]
  });
  expectRefusal(
    evaluateTransition(
      base.snapshot,
      event({ type: "activation-approved", actorClass: "maintainer" }),
      base.context
    ),
    "SCHEMA_INVALID"
  );
});

test("every undeclared state/event combination fails closed", () => {
  const allEvents = [...new Set(lifecycle.routes.map((route) => route.event))];
  for (const state of lifecycle.states) {
    for (const eventType of allEvents) {
      const declared = lifecycle.routes.some(
        (route) => route.from === state.id && route.event === eventType
      );
      if (!declared) {
        assert.equal(selectRoute(lifecycle, state.id, eventType, null, null), null);
      }
    }
  }
});

test("valid transition is applied once and duplicate delivery is a no-op", () => {
  const base = harness();
  const firstEvent = event({
    type: "activation-requested",
    actorClass: "requester"
  });
  const result = evaluateTransition(base.snapshot, firstEvent, base.context);
  assert.equal(result.kind, "applied");
  if (result.kind !== "applied") return;
  assert.equal(validateDocument("CompiledPolicy", compile(framingPhase)).valid, true);
  assert.equal(validateDocument("TransitionReceipt", result.receipt).valid, true);
  assert.equal(result.snapshot.state, "ACTIVATION_PENDING");
  assert.equal(result.snapshot.phaseContractDigest, null);
  const duplicate = evaluateTransition(result.snapshot, firstEvent, base.context);
  assert.equal(duplicate.kind, "noop");
  if (duplicate.kind === "noop") {
    assert.equal(duplicate.receiptDigest, result.receiptDigest);
  }
});

test("replay, ordering, concurrency, and provenance checks fail closed", () => {
  const base = harness();
  const firstEvent = event({
    type: "activation-requested",
    actorClass: "requester"
  });
  const applied = evaluateTransition(base.snapshot, firstEvent, base.context);
  assert.equal(applied.kind, "applied");
  if (applied.kind !== "applied") return;
  expectRefusal(
    evaluateTransition(
      applied.snapshot,
      event({
        type: "cancel-requested",
        actorClass: "requester",
        id: firstEvent.id,
        deliveryId: firstEvent.provenance.deliveryId
      }),
      base.context
    ),
    "REPLAY_CONFLICT"
  );
  expectRefusal(
    evaluateTransition(
      applied.snapshot,
      event({
        type: "cancel-requested",
        actorClass: "requester",
        sequence: 2
      }),
      base.context
    ),
    "CONCURRENCY_CONFLICT"
  );
  expectRefusal(
    evaluateTransition(
      applied.snapshot,
      event({
        type: "cancel-requested",
        actorClass: "requester",
        expectedStateVersion: 1,
        sequence: 1,
        deliveryId: "delivery-reordered"
      }),
      base.context
    ),
    "REPLAY_OUT_OF_ORDER"
  );
  const valid = event({ type: "activation-requested", actorClass: "requester" });
  const forged = {
    ...valid,
    provenance: { ...valid.provenance, bindingDigest: digest("forged") }
  };
  expectRefusal(evaluateTransition(base.snapshot, forged, base.context), "PROVENANCE_INVALID");
});

test("prototype-reserved event IDs are treated as fresh own keys", () => {
  for (const id of ["constructor", "toString", "__proto__"]) {
    const base = harness();
    const result = evaluateTransition(
      base.snapshot,
      event({
        id,
        deliveryId: `delivery-${id}`,
        type: "activation-requested",
        actorClass: "requester"
      }),
      base.context
    );
    assert.equal(result.kind, "applied", id);
    if (result.kind === "applied") {
      assert.equal(Object.hasOwn(result.snapshot.processedEvents, id), true, id);
    }
  }
});

test("canonical Work Accord binding is structural, stable, and head-independent", () => {
  const reordered: WorkAccord = {
    ...accord,
    binding: {
      currentHead: accord.binding.currentHead,
      lifecycleGraphDigest: accord.binding.lifecycleGraphDigest,
      policyDigest: accord.binding.policyDigest,
      sourceDigest: accord.binding.sourceDigest,
      proposalRef: accord.binding.proposalRef,
      defaultRef: accord.binding.defaultRef,
      workItemNodeId: accord.binding.workItemNodeId,
      repositoryRootId: accord.binding.repositoryRootId,
      repositoryFullName: accord.binding.repositoryFullName,
      repositoryNodeId: accord.binding.repositoryNodeId,
      repositoryId: accord.binding.repositoryId
    }
  };
  const changedHead: WorkAccord = {
    ...accord,
    binding: { ...accord.binding, currentHead: digest("new-head") }
  };
  const ambiguousRepository: WorkAccord = {
    ...accord,
    binding: { ...accord.binding, repositoryId: 12, workItemNodeId: "3" }
  };
  const ambiguousWorkItem: WorkAccord = {
    ...accord,
    binding: { ...accord.binding, repositoryId: 1, workItemNodeId: "23" }
  };
  const changedSource: WorkAccord = {
    ...accord,
    binding: { ...accord.binding, sourceDigest: digest("changed-source") }
  };

  assert.equal(workAccordBindingDigest(reordered), bindingDigest);
  assert.equal(workAccordBindingDigest(changedHead), bindingDigest);
  assert.notEqual(
    workAccordBindingDigest(ambiguousRepository),
    workAccordBindingDigest(ambiguousWorkItem)
  );
  assert.notEqual(workAccordBindingDigest(changedSource), bindingDigest);

  const initial = createInitialSnapshot({
    lifecycleGraphDigest: digest(lifecycle),
    workAccord: reordered,
    capabilityRegistryDigest: digest(registry),
    domainPackDigest: digest(domainPack),
    policyDigest
  });
  assert.equal(initial.bindingDigest, bindingDigest);
  assert.equal(initial.workAccordDigest, digest(reordered));
  assert.equal(initial.currentHead, reordered.binding.currentHead);
});

test("repository and work-item substitutions fail before route selection", () => {
  const base = harness();
  for (const substituted of [
    {
      ...accord,
      binding: { ...accord.binding, repositoryId: 2 }
    },
    {
      ...accord,
      binding: { ...accord.binding, workItemNodeId: "I_other" }
    }
  ] satisfies readonly WorkAccord[]) {
    expectRefusal(
      evaluateTransition(
        { ...base.snapshot, workAccordDigest: digest(substituted) },
        event({ type: "activation-requested", actorClass: "requester" }),
        { ...base.context, workAccord: substituted }
      ),
      "CONTRACT_STALE"
    );
  }
});

test("same-version lifecycle substitution is refused before route selection", () => {
  const base = harness({
    state: "HUMAN_REVIEW",
    phaseOwner: "human-review",
    authorityPhase: "human-review",
    destinationPhase: null
  });
  const malicious: LifecycleGraph = {
    ...lifecycle,
    routes: lifecycle.routes.map((route) =>
      route.id === "review.accept" ? { ...route, humanGate: null } : route
    )
  };
  assert.deepEqual(validateLifecycleGraph(malicious), []);
  const result = evaluateTransition(
    base.snapshot,
    event({ type: "outcome-accepted", actorClass: "reviewer" }),
    { ...base.context, graph: malicious }
  );
  expectRefusal(result, "CONTRACT_STALE");
});

test("activation requires its route gate and lease, then emits full grants", () => {
  const maintainer = actor("maintainer");
  const base = harness({
    state: "ACTIVATION_PENDING",
    phaseOwner: "kernel",
    gates: [gate("activate", maintainer)]
  });
  const activation = event({
    type: "activation-approved",
    actorClass: "maintainer",
    cost: { calls: 1, tokens: 100, costUnits: 2, loops: 0 }
  });
  expectRefusal(
    evaluateTransition(base.snapshot, activation, base.context),
    "ACTIVATION_REQUIRED"
  );
  const activationLease = lease(accord, "framing", [
    "core.frame-artifact@1.0.0"
  ]);
  const approved = harness({
    state: "ACTIVATION_PENDING",
    phaseOwner: "kernel",
    activationLease,
    gates: [gate("activate", maintainer)]
  });
  const result = evaluateTransition(
    approved.snapshot,
    activation,
    approved.context
  );
  assert.equal(result.kind, "applied");
  if (result.kind !== "applied") return;
  assert.equal(result.snapshot.state, "FRAMING");
  assert.equal(result.receipt.lifecycleGraphDigest, digest(lifecycle));
  assert.equal(result.receipt.sourcePhaseContractDigest, null);
  assert.equal(result.receipt.destinationPhaseContractDigest, digest(framingPhase));
  const enter = result.effects.find((effect) => effect.type === "enter-phase");
  assert.ok(enter && enter.type === "enter-phase");
  if (enter?.type === "enter-phase") {
    assert.equal(enter.capabilities[0]?.reference, "core.frame-artifact@1.0.0");
    assert.deepEqual(enter.capabilities[0]?.actorClasses, ["system"]);
    assert.deepEqual(enter.capabilities[0]?.humanGates, ["activate"]);
    assert.deepEqual(enter.capabilities[0]?.readScopes, ["accord-evidence"]);
    assert.equal(enter.capabilities[0]?.riskClass, "moderate");
  }
});

test("activation approval is bound to the exact lease", () => {
  const maintainer = actor("maintainer");
  const approvedLease = lease(accord, "framing", [
    "core.frame-artifact@1.0.0"
  ]);
  const base = harness({
    state: "ACTIVATION_PENDING",
    phaseOwner: "kernel",
    activationLease: approvedLease,
    gates: [gate("activate", maintainer)]
  });
  const substitutedLease: ActivationLease = {
    ...approvedLease,
    id: "lease-substituted",
    allowedPhases: ["framing", "execution"],
    allowedCapabilities: [
      ...approvedLease.allowedCapabilities,
      "unreviewed.capability@1.0.0"
    ]
  };
  expectRefusal(
    evaluateTransition(
      base.snapshot,
      event({ type: "activation-approved", actorClass: "maintainer" }),
      { ...base.context, activationLease: substitutedLease }
    ),
    "ACTIVATION_REQUIRED"
  );
});

test("every active-phase entry, resume, and recovery route requires lease authority", () => {
  type ActivePhase = Exclude<PhaseOwner, "kernel" | "intake">;
  const stateByPhase: Readonly<Record<ActivePhase, LifecycleState>> = {
    framing: "FRAMING",
    planning: "PLANNED",
    execution: "EXECUTING",
    verification: "VERIFYING",
    "human-review": "HUMAN_REVIEW"
  };
  const isActivePhase = (phase: PhaseOwner): phase is ActivePhase =>
    phase !== "kernel" && phase !== "intake";
  const routes = lifecycle.routes.filter(
    (route) =>
      isActivePhase(route.phaseOwner) &&
      (route.id === "activation.begin-framing" ||
        route.id.startsWith("pause.resume-") ||
        route.id.startsWith("blocked.retry-") ||
        route.id.startsWith("blocked.recover-"))
  );
  assert.equal(routes.length, 15);

  function routeHarness(
    route: (typeof routes)[number],
    activationLease: ActivationLease
  ) {
    assert.ok(isActivePhase(route.phaseOwner));
    const phase = route.phaseOwner;
    const fromActivation = route.from === "ACTIVATION_PENDING";
    return harness({
      state: route.from,
      phaseOwner: fromActivation ? "kernel" : "kernel",
      authorityPhase: fromActivation ? null : phase,
      destinationPhase: phase,
      activationLease,
      gates: [gate("activate", actor("maintainer"))],
      suspendedState: route.from === "PAUSED" ? stateByPhase[phase] : null,
      recoveryState: route.from === "BLOCKED" ? stateByPhase[phase] : null,
      retryableFailure: route.event === "retry-requested"
    });
  }

  for (const route of routes) {
    assert.ok(isActivePhase(route.phaseOwner));
    const capabilities =
      route.phaseOwner === "framing" ? ["core.frame-artifact@1.0.0"] : [];
    const activationLease = lease(accord, route.phaseOwner, capabilities);
    const base = routeHarness(route, activationLease);
    const result = evaluateTransition(
      base.snapshot,
      event({ type: route.event, actorClass: "maintainer" }),
      base.context
    );
    assert.equal(
      result.kind,
      "applied",
      `${route.id}: ${result.kind === "refused" ? result.refusal.code : ""}`
    );
    if (result.kind === "applied") {
      assert.equal(
        result.effects.some((effect) => effect.type === "enter-phase"),
        true,
        route.id
      );
    }
  }

  const planningRoute = routes.find(
    (route) => route.id === "pause.resume-planning"
  );
  assert.ok(planningRoute);
  const validPlanningLease = lease(accord, "planning", []);
  const planning = routeHarness(planningRoute, validPlanningLease);
  const planningEvent = event({
    type: "resume-requested",
    actorClass: "maintainer"
  });
  expectRefusal(
    evaluateTransition(planning.snapshot, planningEvent, {
      ...planning.context,
      activationLease: null
    }),
    "ACTIVATION_REQUIRED"
  );
  expectRefusal(
    evaluateTransition(planning.snapshot, planningEvent, {
      ...planning.context,
      activationLease: { ...validPlanningLease, revoked: true }
    }),
    "LEASE_REVOKED"
  );
  expectRefusal(
    evaluateTransition(planning.snapshot, planningEvent, {
      ...planning.context,
      activationLease: {
        ...validPlanningLease,
        expiresAt: "2026-08-26T12:00:00Z"
      }
    }),
    "LEASE_EXPIRED"
  );
  const deniedPhase = lease(accord, "framing", []);
  const phaseDenied = routeHarness(planningRoute, deniedPhase);
  expectRefusal(
    evaluateTransition(
      phaseDenied.snapshot,
      planningEvent,
      phaseDenied.context
    ),
    "ACTIVATION_REQUIRED"
  );

  const framingRoute = routes.find(
    (route) => route.id === "activation.begin-framing"
  );
  assert.ok(framingRoute);
  const deniedCapabilities = lease(accord, "framing", []);
  const capabilityDenied = routeHarness(framingRoute, deniedCapabilities);
  expectRefusal(
    evaluateTransition(
      capabilityDenied.snapshot,
      event({ type: "activation-approved", actorClass: "maintainer" }),
      capabilityDenied.context
    ),
    "ACTIVATION_REQUIRED"
  );

  const firstCapability = registry.capabilities[0];
  assert.ok(firstCapability);
  const planningContract: PhaseContract = {
    ...phaseFor("planning"),
    allowedCapabilities: ["core.frame-artifact@1.0.0"]
  };
  const planningRegistry: CapabilityRegistry = {
    ...registry,
    capabilities: [
      {
        ...firstCapability,
        allowedPhases: [...firstCapability.allowedPhases, "planning"]
      },
      ...registry.capabilities.slice(1)
    ]
  };
  const planningAccordBase = accordFor(lifecycle, [
    framingPhase,
    planningContract,
    phaseFor("execution"),
    phaseFor("verification"),
    phaseFor("human-review")
  ]);
  const planningAccord: WorkAccord = {
    ...planningAccordBase,
    policy: {
      ...planningAccordBase.policy,
      capabilityRegistryDigest: digest(planningRegistry)
    }
  };
  const zeroCostCompilation = compilePolicy({
    enterprise: policy,
    accord: planningAccord,
    phase: planningContract,
    domainPack,
    registry: planningRegistry
  });
  assert.equal(zeroCostCompilation.ok, false);
  if (!zeroCostCompilation.ok) {
    assert.match(
      zeroCostCompilation.errors.join("; "),
      /non-cost-bearing phase planning/
    );
  }
});

test("kernel safety transitions remain available without phase gates or leases", () => {
  const staleGate = gate(
    "activate",
    actor("maintainer"),
    accord,
    null,
    "2026-08-26T12:00:00Z"
  );
  const cases: readonly {
    readonly name: string;
    readonly state: LifecycleState;
    readonly phase: "framing" | "execution";
    readonly eventType: EventType;
    readonly actorClass: ActorClass;
    readonly lease: ActivationLease | null;
    readonly gates: readonly HumanGateEvidence[];
  }[] = [
    {
      name: "pause without lease",
      state: "FRAMING",
      phase: "framing",
      eventType: "pause-requested",
      actorClass: "requester",
      lease: null,
      gates: []
    },
    {
      name: "block with revoked lease",
      state: "FRAMING",
      phase: "framing",
      eventType: "dependency-blocked",
      actorClass: "system",
      lease: {
        ...lease(accord, "framing", ["core.frame-artifact@1.0.0"]),
        revoked: true
      },
      gates: [staleGate]
    },
    {
      name: "partial effect with expired lease",
      state: "EXECUTING",
      phase: "execution",
      eventType: "partial-effect-recorded",
      actorClass: "system",
      lease: { ...lease(accord, "execution", []), expiresAt: "2026-08-26T12:00:00Z" },
      gates: [staleGate]
    },
    {
      name: "reauthorize with stale phase gate",
      state: "FRAMING",
      phase: "framing",
      eventType: "authorization-invalidated",
      actorClass: "policy",
      lease: null,
      gates: [staleGate]
    },
    {
      name: "cancel without lease",
      state: "FRAMING",
      phase: "framing",
      eventType: "cancel-requested",
      actorClass: "requester",
      lease: null,
      gates: []
    }
  ];
  for (const item of cases) {
    const base = harness({
      state: item.state,
      phaseOwner: item.phase,
      authorityPhase: item.phase,
      destinationPhase: null,
      activationLease: item.lease,
      gates: item.gates
    });
    const result = evaluateTransition(
      base.snapshot,
      event({ type: item.eventType, actorClass: item.actorClass }),
      base.context
    );
    assert.equal(
      result.kind,
      "applied",
      `${item.name}: ${result.kind === "refused" ? result.refusal.code : ""}`
    );
    if (result.kind === "applied") {
      assert.equal(
        result.effects.some((effect) => effect.type === "enter-phase"),
        false,
        item.name
      );
    }
  }

  const source = harness({
    state: "FRAMING",
    phaseOwner: "framing",
    authorityPhase: "framing",
    destinationPhase: null
  });
  expectRefusal(
    evaluateTransition(
      source.snapshot,
      event({ type: "pause-requested", actorClass: "reviewer" }),
      source.context
    ),
    "UNAUTHORIZED_ACTOR"
  );
  expectRefusal(
    evaluateTransition(
      source.snapshot,
      event({ type: "pause-requested", actorClass: "requester" }),
      { ...source.context, currentPhaseContract: phaseFor("planning") }
    ),
    "CONTRACT_STALE"
  );

  const relabeled: LifecycleGraph = {
    ...lifecycle,
    routes: lifecycle.routes.map((route) =>
      route.id === "framing.pause"
        ? { ...route, to: "PLANNED", phaseOwner: "planning" }
        : route
    )
  };
  assert.equal(
    validateLifecycleGraph(relabeled).some(
      (error) =>
        error.path.endsWith("/to") &&
        error.message.includes("safety event pause-requested")
    ),
    true
  );

  const relabeledSafetyState: LifecycleGraph = {
    ...lifecycle,
    states: lifecycle.states.map((state) =>
      state.id === "PAUSED" ? { ...state, phaseOwner: "planning" } : state
    ),
    routes: lifecycle.routes.map((route) =>
      route.to === "PAUSED" ? { ...route, phaseOwner: "planning" } : route
    )
  };
  assert.equal(
    validateLifecycleGraph(relabeledSafetyState).some(
      (error) =>
        error.path.endsWith("/phaseOwner") &&
        error.message.includes("state PAUSED must remain owned by kernel")
    ),
    true
  );
});

test("in-phase revisions require activation but not a future artifact approval", () => {
  const maintainer = actor("maintainer");
  const base = harness({
    state: "FRAMING",
    phaseOwner: "framing",
    authorityPhase: "framing",
    activationLease: lease(accord, "framing", ["core.frame-artifact@1.0.0"])
  });
  const clarification = event({
    type: "clarification-recorded",
    actorClass: "system",
    cost: { calls: 1, tokens: 10, costUnits: 1, loops: 1 }
  });
  expectRefusal(
    evaluateTransition(base.snapshot, clarification, base.context),
    "ACTIVATION_REQUIRED"
  );
  const result = evaluateTransition(base.snapshot, clarification, {
    ...base.context,
    humanGateEvidence: [
      gateForLease("activate", maintainer, base.context.activationLease!)
    ]
  });
  assert.equal(result.kind, "applied");
});

test("compiled human gate declarations must map to lifecycle routes", () => {
  const compilation = compilePolicy({
    enterprise: policy,
    accord,
    phase: framingPhase,
    domainPack,
    registry
  });
  assert.equal(compilation.ok, true);
  if (!compilation.ok) return;
  assert.equal(
    compiledHumanGatesHaveLifecycleRoutes(compilation.policy, lifecycle),
    true
  );
  assert.equal(
    compiledHumanGatesHaveLifecycleRoutes(
      {
        ...compilation.policy,
        requiredHumanGates: [...compilation.policy.requiredHumanGates, "missing-gate"]
      },
      lifecycle
    ),
    false
  );
});

test("cross-phase handoff atomically installs exact destination authority", () => {
  const planning = phaseFor("planning");
  const reviewer = actor("reviewer");
  const gates = [
    gate("activate", actor("maintainer")),
    gate("accept-frame", reviewer)
  ];
  const base = harness({
    state: "FRAMING",
    phaseOwner: "framing",
    authorityPhase: "framing",
    destinationPhase: "planning",
    activationLease: lease(accord, ["framing", "planning"], [
      "core.frame-artifact@1.0.0"
    ]),
    gates
  });
  const accepted = event({ type: "frame-accepted", actorClass: "reviewer" });
  expectRefusal(
    evaluateTransition(base.snapshot, accepted, {
      ...base.context,
      humanGateEvidence: [gate("accept-frame", reviewer)]
    }),
    "ACTIVATION_REQUIRED"
  );
  const result = evaluateTransition(base.snapshot, accepted, base.context);
  assert.equal(result.kind, "applied");
  if (result.kind !== "applied") return;
  assert.equal(result.snapshot.state, "PLANNED");
  assert.equal(result.snapshot.phaseContractDigest, digest(planning));
  assert.equal(
    result.snapshot.compiledPolicyDigest,
    compile(planning).digest
  );
  assert.equal(result.receipt.sourcePhaseContractDigest, digest(framingPhase));
  assert.equal(result.receipt.destinationPhaseContractDigest, digest(planning));

  const staleDestination: PhaseContract = {
    ...planning,
    identity: { ...planning.identity, version: "1.0.1" }
  };
  expectRefusal(
    evaluateTransition(base.snapshot, accepted, {
      ...base.context,
      destinationPhaseContract: staleDestination
    }),
    "POLICY_ESCALATION"
  );
  expectRefusal(
    evaluateTransition(base.snapshot, accepted, {
      ...base.context,
      destinationPhaseContract: null
    }),
    "CONTRACT_STALE"
  );
});

test("lifecycle state ownership and active authority fail closed for every state", () => {
  const cases: readonly {
    readonly state: LifecycleState;
    readonly owner: PhaseOwner;
    readonly authority: Exclude<PhaseOwner, "kernel" | "intake"> | null;
  }[] = [
    { state: "CAPTURED", owner: "intake", authority: null },
    { state: "ACTIVATION_PENDING", owner: "kernel", authority: null },
    { state: "FRAMING", owner: "framing", authority: "framing" },
    { state: "PLANNED", owner: "planning", authority: "planning" },
    { state: "EXECUTING", owner: "execution", authority: "execution" },
    { state: "VERIFYING", owner: "verification", authority: "verification" },
    { state: "HUMAN_REVIEW", owner: "human-review", authority: "human-review" },
    { state: "PAUSED", owner: "kernel", authority: "execution" },
    { state: "BLOCKED", owner: "kernel", authority: "execution" },
    { state: "COMPLETED", owner: "kernel", authority: "human-review" },
    { state: "CANCELLED", owner: "kernel", authority: null }
  ];

  for (const item of cases) {
    const base = harness({
      state: item.state,
      phaseOwner: item.owner,
      authorityPhase: item.authority,
      suspendedState: item.state === "PAUSED" ? "EXECUTING" : null,
      recoveryState: item.state === "BLOCKED" ? "EXECUTING" : null
    });
    assert.deepEqual(
      validateSnapshotLifecycleSemantics(base.snapshot, lifecycle),
      [],
      item.state
    );
    assert.equal(validateDocument("KernelSnapshot", base.snapshot).valid, true);

    const wrongOwner: KernelSnapshot = {
      ...base.snapshot,
      phaseOwner: item.owner === "kernel" ? "framing" : "kernel"
    };
    assert.notDeepEqual(
      validateSnapshotLifecycleSemantics(wrongOwner, lifecycle),
      [],
      `${item.state} owner`
    );
    assert.equal(validateDocument("KernelSnapshot", wrongOwner).valid, false);

    if (!allowsNullPhaseAuthority(item.state)) {
      const missingAuthority: KernelSnapshot = {
        ...base.snapshot,
        phaseContractDigest: null,
        compiledPolicyDigest: null
      };
      assert.notDeepEqual(
        validateSnapshotLifecycleSemantics(missingAuthority, lifecycle),
        [],
        `${item.state} authority`
      );
      assert.equal(
        validateDocument("KernelSnapshot", missingAuthority).valid,
        false
      );
    }
    if (item.state === "PAUSED" || item.state === "BLOCKED") {
      const missingRetainedState: KernelSnapshot = {
        ...base.snapshot,
        suspendedState: null,
        recoveryState: null
      };
      assert.notDeepEqual(
        validateSnapshotLifecycleSemantics(missingRetainedState, lifecycle),
        []
      );
      assert.equal(
        validateDocument("KernelSnapshot", missingRetainedState).valid,
        false
      );
    }
  }
});

test("source-gated transitions cannot use null or substituted authority", () => {
  const reviewer = actor("reviewer");
  const reviewAccord: WorkAccord = {
    ...accord,
    binding: { ...accord.binding, currentHead: digest("review-head") }
  };
  const base = harness({
    workAccord: reviewAccord,
    state: "HUMAN_REVIEW",
    phaseOwner: "human-review",
    authorityPhase: "human-review",
    destinationPhase: null,
    gates: [gate("approve-current-head", reviewer, reviewAccord)]
  });
  const accepted = event({ type: "outcome-accepted", actorClass: "reviewer" });
  const missingAuthority: KernelSnapshot = {
    ...base.snapshot,
    phaseContractDigest: null,
    compiledPolicyDigest: null
  };
  expectRefusal(
    evaluateTransition(missingAuthority, accepted, {
      ...base.context,
      currentPhaseContract: null
    }),
    "SCHEMA_INVALID"
  );

  expectRefusal(
    evaluateTransition(base.snapshot, accepted, {
      ...base.context,
      currentPhaseContract: phaseFor("planning")
    }),
    "CONTRACT_STALE"
  );
  const result = evaluateTransition(base.snapshot, accepted, base.context);
  assert.equal(
    result.kind,
    "applied",
    result.kind === "refused" ? result.refusal.code : ""
  );
});

test("human-only pack predicates accept closed evidence outputs without weakening model phases", () => {
  for (const predicate of [
    "eligible-independent-human-accepts-merged-head",
    "eligible-independent-human-accepts-current-head"
  ] as const) {
    const human = {
      ...phaseFor("human-review"),
      exitRules: [{ predicate, event: "outcome-accepted" }],
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["decision", "headSha"],
        properties: {
          decision: { enum: ["accept", "request-revision", "cancel"] },
          headSha: { type: "string" }
        }
      }
    } satisfies PhaseContract;
    const phases = [
      framingPhase,
      phaseFor("planning"),
      phaseFor("execution"),
      phaseFor("verification"),
      human
    ];
    const result = compilePolicy({
      enterprise: policy,
      accord: accordFor(lifecycle, phases),
      phase: human,
      domainPack,
      registry
    });
    assert.equal(result.ok, true, result.ok ? "" : result.errors.join("; "));
  }

  const model = {
    ...framingPhase,
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["decision"],
      properties: { decision: { type: "string" } }
    }
  } satisfies PhaseContract;
  const modelPhases = [
    model,
    phaseFor("planning"),
    phaseFor("execution"),
    phaseFor("verification"),
    phaseFor("human-review")
  ];
  const rejected = compilePolicy({
    enterprise: policy,
    accord: accordFor(lifecycle, modelPhases),
    phase: model,
    domainPack,
    registry
  });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) {
    assert.ok(
      rejected.errors.some((error) =>
        error.includes("approved target-free vocabulary")
      )
    );
  }
});

test("phase handoff separates lifetime usage from destination phase usage", () => {
  const planning = phaseFor("planning");
  const zeroPlanning: PhaseContract = {
    ...planning,
    limits: {
      ...planning.limits,
      maxCalls: 0,
      maxCostUnits: 0,
      maxLoops: 0
    }
  };
  const workAccord = accordFor(lifecycle, [
    framingPhase,
    zeroPlanning,
    phaseFor("execution"),
    phaseFor("verification"),
    phaseFor("human-review")
  ]);
  const reviewer = actor("reviewer");
  const base = harness({
    workAccord,
    state: "FRAMING",
    phaseOwner: "framing",
    authorityPhase: "framing",
    destinationPhaseContract: zeroPlanning,
    usage: { calls: 4, tokens: 40, costUnits: 4, loops: 1, retries: 0 },
    phaseUsage: {
      calls: 4,
      tokens: 40,
      costUnits: 4,
      loops: 1,
      retries: 0
    },
    activationLease: lease(workAccord, ["framing", "planning"], [
      "core.frame-artifact@1.0.0"
    ]),
    gates: [
      gate("activate", actor("maintainer"), workAccord),
      gate("accept-frame", reviewer, workAccord)
    ]
  });
  const result = evaluateTransition(
    base.snapshot,
    event({ type: "frame-accepted", actorClass: "reviewer" }),
    base.context
  );
  assert.equal(
    result.kind,
    "applied",
    result.kind === "refused" ? result.refusal.code : ""
  );
  if (result.kind === "applied") {
    assert.equal(result.snapshot.usage.calls, 4);
    assert.deepEqual(result.snapshot.phaseUsage, {
      calls: 0,
      tokens: 0,
      costUnits: 0,
      loops: 0,
      retries: 0
    });
  }
});

test("phase entry, exit, and evidence requirements are mechanically enforced", () => {
  const reviewer = actor("reviewer");
  const baseInput = {
    state: "FRAMING" as const,
    phaseOwner: "framing" as const,
    authorityPhase: "framing" as const,
    destinationPhase: "planning" as const,
    activationLease: lease(accord, ["framing", "planning"], [
      "core.frame-artifact@1.0.0"
    ]),
    gates: [
      gate("activate", actor("maintainer")),
      gate("accept-frame", reviewer)
    ]
  };
  const transition = event({ type: "frame-accepted", actorClass: "reviewer" });
  const complete = harness(baseInput);
  assert.equal(
    evaluateTransition(complete.snapshot, transition, complete.context).kind,
    "applied"
  );
  const staleFirst = harness({
    ...baseInput,
    contractRequirementEvidence: [
      ...defaultRequirementEvidence(accord).map((evidence) => ({
        ...evidence,
        expiresAt: "2026-08-26T12:00:00Z"
      })),
      ...defaultRequirementEvidence(accord)
    ]
  });
  assert.equal(
    evaluateTransition(staleFirst.snapshot, transition, staleFirst.context).kind,
    "applied"
  );

  for (const missing of [
    "eligible-human-accepts-frame",
    "work-accord-current",
    "trusted-binding"
  ]) {
    const candidate = harness({
      ...baseInput,
      contractRequirementEvidence: defaultRequirementEvidence(accord).filter(
        (evidence) => evidence.requirement !== missing
      )
    });
    expectRefusal(
      evaluateTransition(candidate.snapshot, transition, candidate.context),
      "CONTRACT_REQUIREMENT_MISSING"
    );
  }

  const planning = phaseFor("planning");
  const unknownPlanning: PhaseContract = {
    ...planning,
    entryPredicates: ["model-says-ready"]
  };
  const workAccord = accordFor(lifecycle, [
    framingPhase,
    unknownPlanning,
    phaseFor("execution"),
    phaseFor("verification"),
    phaseFor("human-review")
  ]);
  const unknown = harness({
    ...baseInput,
    workAccord,
    activationLease: lease(workAccord, ["framing", "planning"], [
      "core.frame-artifact@1.0.0"
    ]),
    destinationPhaseContract: unknownPlanning,
    gates: [
      gate("activate", actor("maintainer"), workAccord),
      gate("accept-frame", reviewer, workAccord)
    ]
  });
  expectRefusal(
    evaluateTransition(unknown.snapshot, transition, unknown.context),
    "CONTRACT_REQUIREMENT_MISSING"
  );
});

test("contract requirement evidence cannot replay against a changed snapshot", () => {
  const reviewer = actor("reviewer");
  const activationLease = lease(accord, ["framing", "planning"], [
    "core.frame-artifact@1.0.0"
  ]);
  const base = harness({
    state: "FRAMING",
    phaseOwner: "framing",
    authorityPhase: "framing",
    destinationPhase: "planning",
    activationLease,
    gates: [
      gate("activate", actor("maintainer")),
      gate("accept-frame", reviewer)
    ]
  });
  const changedSnapshot: KernelSnapshot = {
    ...base.snapshot,
    stateVersion: 1
  };
  expectRefusal(
    evaluateTransition(
      changedSnapshot,
      event({
        type: "frame-accepted",
        actorClass: "reviewer",
        expectedStateVersion: 1
      }),
      base.context
    ),
    "CONTRACT_REQUIREMENT_MISSING"
  );
});

test("Work Accord must reference the exact Phase Contract identity and digest", () => {
  const unbound = {
    ...framingPhase,
    identity: { ...framingPhase.identity, version: "1.0.1" }
  };
  const result = compilePolicy({
    enterprise: policy,
    accord,
    phase: unbound,
    domainPack,
    registry
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.errors.some((error) => error.includes("exact Work Accord")), true);
  }
});

test("Work Accord binds exact registry and Domain Pack policy inputs", () => {
  const first = registry.capabilities[0];
  assert.ok(first);
  const substitutedRegistry: CapabilityRegistry = {
    ...registry,
    capabilities: [
      {
        ...first,
        access: {
          ...first.access,
          readScopes: [...first.access.readScopes, "unreviewed-sensitive-data"]
        }
      },
      ...registry.capabilities.slice(1)
    ]
  };
  const registryResult = compilePolicy({
    enterprise: policy,
    accord,
    phase: framingPhase,
    domainPack,
    registry: substitutedRegistry
  });
  assert.equal(registryResult.ok, false);
  if (!registryResult.ok) {
    assert.equal(
      registryResult.errors.some((error) =>
        error.includes("exact loaded Capability Registry")
      ),
      true
    );
  }
  const packResult = compilePolicy({
    enterprise: policy,
    accord,
    phase: framingPhase,
    domainPack: { ...domainPack, maxCalls: domainPack.maxCalls - 1 },
    registry
  });
  assert.equal(packResult.ok, false);
  if (!packResult.ok) {
    assert.equal(
      packResult.errors.some((error) =>
        error.includes("exact loaded Domain Pack")
      ),
      true
    );
  }
});

test("cost-bearing flags cannot be flipped for any cost-bearing destination", () => {
  for (const route of lifecycle.routes.filter((candidate) =>
    isCostBearingState(candidate.to)
  )) {
    const mutated: LifecycleGraph = {
      ...lifecycle,
      routes: lifecycle.routes.map((candidate) =>
        candidate.id === route.id ? { ...candidate, costBearing: false } : candidate
      )
    };
    assert.equal(
      validateLifecycleGraph(mutated).some(
        (error) =>
          error.path === `/routes/${lifecycle.routes.indexOf(route)}/costBearing`
      ),
      true,
      route.id
    );
  }
});

test("non-cost-bearing phases cannot grant model or externally executing capabilities", () => {
  assert.equal(isCostBearingPhaseOwner("planning"), false);
  assert.equal(isCostBearingPhaseOwner("human-review"), false);
  assert.equal(isCostBearingPhaseOwner("framing"), true);

  const planning = {
    ...phaseFor("planning"),
    allowedCapabilities: ["core.frame-artifact@1.0.0"]
  };
  const workAccord = accordFor(
    lifecycle,
    activePhases.map((owner) => (owner === "planning" ? planning : phaseFor(owner)))
  );
  const baseCapability = registry.capabilities[0];
  assert.ok(baseCapability);
  const modelRegistry: CapabilityRegistry = {
    ...registry,
    capabilities: [
      {
        ...baseCapability,
        allowedPhases: ["planning"]
      }
    ]
  };
  const modelAccord: WorkAccord = {
    ...workAccord,
    policy: {
      ...workAccord.policy,
      capabilityRegistryDigest: digest(modelRegistry)
    }
  };
  const modelResult = compilePolicy({
    enterprise: policy,
    accord: modelAccord,
    phase: planning,
    domainPack,
    registry: modelRegistry
  });
  assert.equal(modelResult.ok, false);
  if (!modelResult.ok) {
    assert.match(modelResult.errors.join("; "), /non-cost-bearing phase planning/);
  }
  const review = {
    ...phaseFor("human-review"),
    allowedCapabilities: ["core.frame-artifact@1.0.0"]
  };
  const reviewAccordBase = accordFor(
    lifecycle,
    activePhases.map((owner) =>
      owner === "human-review" ? review : phaseFor(owner)
    )
  );
  const reviewRegistry: CapabilityRegistry = {
    ...modelRegistry,
    capabilities: [
      {
        ...baseCapability,
        allowedPhases: ["human-review"]
      }
    ]
  };
  const reviewAccord: WorkAccord = {
    ...reviewAccordBase,
    policy: {
      ...reviewAccordBase.policy,
      capabilityRegistryDigest: digest(reviewRegistry)
    }
  };
  const reviewResult = compilePolicy({
    enterprise: policy,
    accord: reviewAccord,
    phase: review,
    domainPack,
    registry: reviewRegistry
  });
  assert.equal(reviewResult.ok, false);
  if (!reviewResult.ok) {
    assert.match(
      reviewResult.errors.join("; "),
      /non-cost-bearing phase human-review/
    );
  }

  const toolRegistry: CapabilityRegistry = {
    ...modelRegistry,
    capabilities: [
      {
        ...baseCapability,
        implementation: { kind: "deterministic", provider: "local" },
        allowedPhases: ["planning"],
        access: { ...baseCapability.access, tools: ["read-tool"] }
      }
    ]
  };
  const toolAccord: WorkAccord = {
    ...workAccord,
    policy: {
      ...workAccord.policy,
      tools: ["read-tool"],
      capabilityRegistryDigest: digest(toolRegistry)
    }
  };
  const toolResult = compilePolicy({
    enterprise: policy,
    accord: toolAccord,
    phase: planning,
    domainPack,
    registry: toolRegistry
  });
  assert.equal(toolResult.ok, false);
  if (!toolResult.ok) {
    assert.match(toolResult.errors.join("; "), /non-cost-bearing phase planning/);
  }
});

test("control-state routes cannot retain non-active lifecycle states", () => {
  const malicious: LifecycleGraph = {
    ...lifecycle,
    routes: [
      ...lifecycle.routes,
      {
        id: "capture.invalid-pause",
        version: "1.0.0",
        from: "CAPTURED",
        to: "PAUSED",
        event: "pause-requested",
        actorClasses: ["requester"],
        phaseOwner: "kernel",
        costBearing: false,
        humanGate: null,
        retryable: false,
        maxAttempts: 1
      }
    ]
  };
  assert.equal(
    validateLifecycleGraph(malicious).some(
      (error) => error.path.endsWith("/from")
    ),
    true
  );
  const workAccord = accordFor(malicious);
  const base = harness({ graph: malicious, workAccord });
  expectRefusal(
    evaluateTransition(
      base.snapshot,
      event({ type: "pause-requested", actorClass: "requester" }),
      base.context
    ),
    "GRAPH_INVALID"
  );
});

test("capability restrictions are retained and escalation is rejected", () => {
  const result = compilePolicy({
    enterprise: policy,
    accord,
    phase: framingPhase,
    domainPack,
    registry
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const grant = result.policy.capabilities[0];
  assert.ok(grant);
  assert.deepEqual(grant.readScopes, ["accord-evidence"]);
  assert.equal(grant.limits.maxCalls, 1);
  assert.equal(grant.limits.maxConcurrency, 1);
  assert.deepEqual(grant.evidence, [
    "provider-model-receipt",
    "validated-output-digest"
  ]);

  const first = registry.capabilities[0];
  assert.ok(first);
  const escalations: CapabilityRegistry[] = [
    {
      ...registry,
      capabilities: [
        { ...first, access: { ...first.access, tools: ["node"] } },
        ...registry.capabilities.slice(1)
      ]
    },
    {
      ...registry,
      capabilities: [
        { ...first, humanGates: ["undeclared-gate"] },
        ...registry.capabilities.slice(1)
      ]
    }
  ];
  for (const candidate of escalations) {
    const rejected = compilePolicy({
      enterprise: policy,
      accord,
      phase: framingPhase,
      domainPack,
      registry: candidate
    });
    assert.equal(rejected.ok, false);
  }
});

test("capability without system actor cannot be emitted for phase entry", () => {
  const first = registry.capabilities[0];
  assert.ok(first);
  const weakened: CapabilityRegistry = {
    ...registry,
    capabilities: [
      { ...first, actorClasses: ["reviewer"] },
      ...registry.capabilities.slice(1)
    ]
  };
  const weakenedAccord: WorkAccord = {
    ...accord,
    policy: {
      ...accord.policy,
      capabilityRegistryDigest: digest(weakened)
    }
  };
  const maintainer = actor("maintainer");
  const base = harness({
    state: "ACTIVATION_PENDING",
    phaseOwner: "kernel",
    workAccord: weakenedAccord,
    capabilityRegistry: weakened,
    gates: [gate("activate", maintainer, weakenedAccord)],
    activationLease: lease(weakenedAccord, "framing", [
      "core.frame-artifact@1.0.0"
    ])
  });
  expectRefusal(
    evaluateTransition(
      base.snapshot,
      event({ type: "activation-approved", actorClass: "maintainer" }),
      base.context
    ),
    "POLICY_ESCALATION"
  );
});

test("registry only accepts a closed target-free schema dialect", () => {
  assert.deepEqual(validateRegistrySemantics(registry), []);
  const first = registry.capabilities[0];
  assert.ok(first);
  const invalidSchemas: readonly unknown[] = [
    {},
    { type: "object", additionalProperties: true, properties: {} },
    {
      type: "object",
      additionalProperties: false,
      anyOf: [{ type: "object", additionalProperties: false, properties: {} }]
    },
    {
      type: "object",
      additionalProperties: false,
      oneOf: [{ type: "object", additionalProperties: false, properties: {} }]
    },
    {
      type: "object",
      additionalProperties: false,
      allOf: [{ type: "object", additionalProperties: false, properties: {} }]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: { nested: { type: "object", properties: {} } }
    },
    {
      type: "object",
      additionalProperties: false,
      properties: { targetRepository: { type: "string" } }
    },
    {
      type: "object",
      additionalProperties: false,
      properties: { targetrepository: { type: "string" } }
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        orgId: { type: "string" },
        owner: { type: "string" },
        prNumber: { type: "integer" },
        sha: { type: "string" },
        ref: { type: "string" },
        htmlUrl: { type: "string" }
      }
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        nested: {
          type: "object",
          additionalProperties: false,
          properties: { destinationRepo: { type: "string" } }
        }
      }
    },
    {
      type: "object",
      additionalProperties: false,
      properties: { value: { type: ["string", "object"] } }
    },
    { type: "object", additionalProperties: false, enum: [{}] },
    {
      type: "object",
      additionalProperties: false,
      properties: { summary: { type: "string", pattern: "[" } }
    },
    {
      type: "object",
      additionalProperties: false,
      properties: { summary: { type: "string", minLength: "1" } }
    },
    {
      type: "object",
      additionalProperties: false,
      required: "summary",
      properties: { summary: { type: "string" } }
    },
    {
      type: "object",
      additionalProperties: false,
      minLength: 1
    },
    {
      type: "object",
      additionalProperties: false,
      properties: { summary: { type: "string", format: "unknown-format" } }
    }
  ];
  for (const outputSchema of invalidSchemas) {
    const candidate: CapabilityRegistry = {
      ...registry,
      capabilities: [
        {
          ...first,
          outputSchema: outputSchema as Readonly<Record<string, unknown>>
        },
        ...registry.capabilities.slice(1)
      ]
    };
    assert.notDeepEqual(validateRegistrySemantics(candidate), [], JSON.stringify(outputSchema));
  }
  const closedAnyOfRegistry: CapabilityRegistry = {
    ...registry,
    capabilities: [
      {
        ...first,
        outputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["summary"],
          properties: {
            summary: {
              anyOf: [{ type: "string" }, { type: "null" }]
            }
          }
        }
      },
      ...registry.capabilities.slice(1)
    ]
  };
  assert.deepEqual(validateRegistrySemantics(closedAnyOfRegistry), []);

  const privilegedActorRegistry = {
    ...registry,
    capabilities: [
      { ...first, actorClasses: ["privileged"] },
      ...registry.capabilities.slice(1)
    ]
  };
  assert.equal(
    validateDocument("CapabilityRegistry", privilegedActorRegistry).valid,
    false
  );
});

test("registry MCP classification validation is total and emits one partition error", () => {
  const first = registry.capabilities[0];
  assert.ok(first);
  const classificationMessage =
    "every MCP tool must be classified exactly once as read-only or mutating";
  const invalidAccessValues: readonly Readonly<Record<string, unknown>>[] = [
    { mcpReadTools: undefined },
    { mcpMutationTools: undefined },
    { mcpReadTools: "mcp/read" },
    { mcpMutationTools: "mcp/write" },
    {
      mcpTools: ["mcp/shared"],
      mcpReadTools: ["mcp/shared"],
      mcpMutationTools: ["mcp/shared"]
    },
    {
      mcpTools: ["mcp/read", "mcp/write"],
      mcpReadTools: ["mcp/read"],
      mcpMutationTools: []
    },
    {
      mcpTools: ["mcp/read"],
      mcpReadTools: ["mcp/unregistered"],
      mcpMutationTools: []
    }
  ];

  for (const accessChanges of invalidAccessValues) {
    const access = { ...first.access, ...accessChanges };
    for (const key of ["mcpReadTools", "mcpMutationTools"] as const) {
      if (access[key] === undefined) delete access[key];
    }
    const candidate = {
      ...registry,
      capabilities: [
        { ...first, access },
        ...registry.capabilities.slice(1)
      ]
    } as unknown as CapabilityRegistry;
    let errors: ReturnType<typeof validateRegistrySemantics> = [];
    assert.doesNotThrow(() => {
      errors = validateRegistrySemantics(candidate);
    });
    assert.equal(
      errors.filter((error) => error.message === classificationMessage).length,
      1,
      JSON.stringify(accessChanges)
    );
    assert.ok(
      errors.some(
        (error) =>
          error.code === "REGISTRY_INVALID" &&
          error.path === "/capabilities/0/access/mcpTools"
      ),
      JSON.stringify(accessChanges)
    );
  }
});

test("Phase Contract schemas use the same conservative closed dialect", () => {
  const invalidSchemas: readonly {
    readonly inputSchema?: Readonly<Record<string, unknown>>;
    readonly outputSchema?: Readonly<Record<string, unknown>>;
  }[] = [
    { inputSchema: {} },
    {
      inputSchema: {
        type: "object",
        additionalProperties: true,
        properties: {}
      }
    },
    {
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { targetRepository: { type: "string" } }
      }
    },
    {
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          result: {
            type: "object",
            additionalProperties: false,
            properties: { destinationRepo: { type: "string" } }
          }
        }
      }
    },
    {
      outputSchema: {
        type: "object",
        additionalProperties: false,
        anyOf: [
          {
            type: "object",
            additionalProperties: false,
            properties: {}
          }
        ]
      }
    },
    {
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { value: { type: "string", pattern: "[" } }
      }
    },
    {
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { value: { type: "string", minLength: "1" } }
      }
    },
    {
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { result: { $ref: "#/$defs/value" } }
      }
    }
  ];

  for (const schemas of invalidSchemas) {
    const candidate: PhaseContract = {
      ...framingPhase,
      ...(schemas.inputSchema === undefined
        ? {}
        : { inputSchema: schemas.inputSchema }),
      ...(schemas.outputSchema === undefined
        ? {}
        : { outputSchema: schemas.outputSchema })
    };
    const workAccord = accordFor(lifecycle, [
      candidate,
      phaseFor("planning"),
      phaseFor("execution"),
      phaseFor("verification"),
      phaseFor("human-review")
    ]);
    const result = compilePolicy({
      enterprise: policy,
      accord: workAccord,
      phase: candidate,
      domainPack,
      registry
    });
    assert.equal(result.ok, false, JSON.stringify(schemas));
  }
  assert.equal(compilePolicy({
    enterprise: policy,
    accord,
    phase: framingPhase,
    domainPack,
    registry
  }).ok, true);
});

test("actor authorization enforces roles, independence, head, and gate expiry", () => {
  const route = lifecycle.routes.find((candidate) => candidate.id === "review.accept");
  assert.ok(route);
  const head = digest("head");
  const requesterReviewer = actor("reviewer", "requester-1");
  assert.equal(
    authorizeActor({
      actor: requesterReviewer,
      route,
      policy,
      requesterId: "requester-1",
      workAccordDigest: accordDigest,
      activationLeaseDigest: null,
      currentHead: head,
      gateEvidence: [gate("approve-current-head", requesterReviewer, accord, head)],
      evaluatedAt: "2026-08-26T12:00:01Z"
    })?.code,
    "INDEPENDENCE_REQUIRED"
  );
  const reviewer = actor("reviewer");
  assert.equal(
    authorizeActor({
      actor: reviewer,
      route,
      policy,
      requesterId: "requester-1",
      workAccordDigest: accordDigest,
      activationLeaseDigest: null,
      currentHead: head,
      gateEvidence: [
        gate(
          "approve-current-head",
          reviewer,
          accord,
          head,
          "2026-08-26T12:00:00Z"
        )
      ],
      evaluatedAt: "2026-08-26T12:00:01Z"
    })?.code,
    "HUMAN_GATE_STALE"
  );
  assert.equal(
    authorizeActor({
      actor: { ...reviewer, roles: [] },
      route,
      policy,
      requesterId: "requester-1",
      workAccordDigest: accordDigest,
      activationLeaseDigest: null,
      currentHead: head,
      gateEvidence: [],
      evaluatedAt: "2026-08-26T12:00:01Z"
    })?.code,
    "UNAUTHORIZED_ACTOR"
  );

  assert.equal(
    authorizeActor({
      actor: reviewer,
      route,
      policy,
      requesterId: "requester-1",
      workAccordDigest: accordDigest,
      activationLeaseDigest: null,
      currentHead: head,
      gateEvidence: [
        gate(
          "approve-current-head",
          reviewer,
          accord,
          head,
          "2026-08-26T12:00:00Z"
        ),
        gate("approve-current-head", reviewer, accord, head)
      ],
      evaluatedAt: "2026-08-26T12:00:01Z"
    }),
    null
  );
});

test("stale gate and lease evidence cannot shadow later valid evidence", () => {
  const maintainer = actor("maintainer");
  const base = harness({
    state: "ACTIVATION_PENDING",
    phaseOwner: "kernel",
    destinationPhase: "framing",
    activationLease: lease(accord, "framing", ["core.frame-artifact@1.0.0"]),
    gates: [
      gate("activate", maintainer, accord, null, "2026-08-26T12:00:00Z"),
      gate("activate", maintainer)
    ]
  });
  assert.equal(
    evaluateTransition(
      base.snapshot,
      event({ type: "activation-approved", actorClass: "maintainer" }),
      base.context
    ).kind,
    "applied"
  );

  const framing = harness({
    state: "FRAMING",
    phaseOwner: "framing",
    authorityPhase: "framing",
    activationLease: lease(accord, "framing", ["core.frame-artifact@1.0.0"]),
    gates: [
      gate("activate", maintainer, accord, null, "2026-08-26T12:00:00Z"),
      gate("activate", maintainer)
    ]
  });
  assert.equal(
    evaluateTransition(
      framing.snapshot,
      event({
        type: "clarification-recorded",
        actorClass: "system",
        cost: { calls: 1, tokens: 1, costUnits: 1, loops: 1 }
      }),
      framing.context
    ).kind,
    "applied"
  );
});

test("budget, loop, retry, and safe-integer limits fail closed", () => {
  const maintainer = actor("maintainer");
  const common = {
    state: "FRAMING" as const,
    phaseOwner: "framing" as const,
    authorityPhase: "framing" as const,
    gates: [gate("activate", maintainer)],
    activationLease: lease(accord, "framing", ["core.frame-artifact@1.0.0"])
  };
  const expensive = event({
    type: "clarification-recorded",
    actorClass: "system",
    cost: { calls: 2, tokens: 0, costUnits: 2, loops: 1 }
  });
  const overCost = harness({
    ...common,
    usage: { calls: 3, tokens: 0, costUnits: 39, loops: 0, retries: 0 }
  });
  expectRefusal(
    evaluateTransition(overCost.snapshot, expensive, overCost.context),
    "BUDGET_EXHAUSTED"
  );
  const overLoop = harness({
    ...common,
    usage: { calls: 0, tokens: 0, costUnits: 0, loops: 4, retries: 0 }
  });
  expectRefusal(
    evaluateTransition(overLoop.snapshot, expensive, overLoop.context),
    "LOOP_LIMIT_EXHAUSTED"
  );
  const overflow = harness({
    ...common,
    usage: {
      calls: Number.MAX_SAFE_INTEGER,
      tokens: 0,
      costUnits: 0,
      loops: 0,
      retries: 0
    },
    activationLease: {
      ...lease(accord, "framing", ["core.frame-artifact@1.0.0"]),
      maxCalls: Number.MAX_SAFE_INTEGER
    }
  });
  expectRefusal(
    evaluateTransition(overflow.snapshot, expensive, overflow.context),
    "NUMERIC_OVERFLOW"
  );
  const stateOverflow = harness({
    ...common,
    stateVersion: Number.MAX_SAFE_INTEGER
  });
  const stateEvent = event({
    type: "clarification-recorded",
    actorClass: "system",
    expectedStateVersion: Number.MAX_SAFE_INTEGER
  });
  expectRefusal(
    evaluateTransition(stateOverflow.snapshot, stateEvent, stateOverflow.context),
    "NUMERIC_OVERFLOW"
  );
  assert.equal(
    validateDocument("KernelSnapshot", {
      ...overflow.snapshot,
      stateVersion: Number.MAX_SAFE_INTEGER + 1
    }).valid,
    false
  );
});

test("reauthorization clears prior authority and re-enters through fresh framing gates", () => {
  for (const phaseOwner of ["framing", "execution", "verification"] as const) {
    const priorLease =
      phaseOwner === "framing"
        ? lease(accord, "framing", ["core.frame-artifact@1.0.0"])
        : null;
    const base = harness({
      state:
        phaseOwner === "framing"
          ? "FRAMING"
          : phaseOwner === "execution"
            ? "EXECUTING"
            : "VERIFYING",
      phaseOwner,
      authorityPhase: phaseOwner,
      destinationPhase: null,
      activationLease: priorLease,
      gates:
        priorLease === null
          ? []
          : [gate("activate", actor("maintainer"))]
    });
    const invalidated = evaluateTransition(
      base.snapshot,
      event({
        type: "authorization-invalidated",
        actorClass: "policy"
      }),
      base.context
    );
    assert.equal(invalidated.kind, "applied", phaseOwner);
    if (invalidated.kind !== "applied") continue;
    assert.equal(invalidated.snapshot.state, "ACTIVATION_PENDING");
    assert.equal(invalidated.snapshot.phaseContractDigest, null);
    assert.equal(invalidated.snapshot.compiledPolicyDigest, null);

    const freshLease = lease(accord, "framing", [
      "core.frame-artifact@1.0.0"
    ]);
    const freshGate = gateForLease(
      "activate",
      actor("maintainer"),
      freshLease
    );
    const framing = phaseFor("framing");
    const reentryContext: KernelContext = {
      ...base.context,
      currentPhaseContract: null,
      destinationPhaseContract: framing,
      activationLease: freshLease,
      humanGateEvidence: [freshGate],
      contractRequirementEvidence: bindRequirementEvidence({
        evidence: defaultRequirementEvidence(accord),
        snapshot: invalidated.snapshot,
        current: null,
        destination: framing,
        graph: lifecycle,
        activationLease: freshLease
      })
    };
    const reentered = evaluateTransition(
      invalidated.snapshot,
      event({
        type: "activation-approved",
        actorClass: "maintainer",
        expectedStateVersion: 1,
        sequence: 2
      }),
      reentryContext
    );
    assert.equal(reentered.kind, "applied", phaseOwner);
  }
});

test("trusted rebind atomically replaces authority while preserving durable history", () => {
  const base = harness({
    usage: { calls: 1, tokens: 20, costUnits: 2, loops: 1, retries: 0 }
  });
  const requested = evaluateTransition(
    base.snapshot,
    event({ type: "activation-requested", actorClass: "requester" }),
    base.context
  );
  assert.equal(requested.kind, "applied");
  if (requested.kind !== "applied") return;

  const replacementGraph: LifecycleGraph = {
    ...lifecycle,
    routes: lifecycle.routes.map((route) =>
      route.id === "framing.clarify" ? { ...route, maxAttempts: 3 } : route
    )
  };
  const replacement = replacementAuthority({ graph: replacementGraph });
  const rebindEvent = event({
    type: "binding-revalidated",
    actorClass: "policy",
    provenanceSource: "policy-engine",
    replacementAuthorityDigest: digest(replacement),
    expectedStateVersion: 1,
    sequence: 2
  });
  const rebound = evaluateTransition(requested.snapshot, rebindEvent, {
    ...base.context,
    destinationPhaseContract: null,
    rebindAuthority: replacement
  });
  assert.equal(rebound.kind, "applied");
  if (rebound.kind !== "applied") return;

  assert.equal(rebound.snapshot.state, "ACTIVATION_PENDING");
  assert.equal(rebound.snapshot.lifecycleGraphDigest, digest(replacement.graph));
  assert.equal(rebound.snapshot.workAccordDigest, digest(replacement.workAccord));
  assert.equal(rebound.snapshot.policyDigest, digest(replacement.policy));
  assert.equal(rebound.snapshot.bindingDigest, replacement.bindingDigest);
  assert.equal(
    rebound.snapshot.currentHead,
    replacement.workAccord.binding.currentHead
  );
  assert.deepEqual(rebound.snapshot.usage, base.snapshot.usage);
  assert.equal(
    rebound.snapshot.processedEvents[requested.receipt.eventId]?.receiptDigest,
    requested.receiptDigest
  );
  assert.equal(
    rebound.snapshot.processedEvents[rebindEvent.id]?.receiptDigest,
    rebound.receiptDigest
  );
  assert.equal(rebound.receipt.workAccordDigest, digest(accord));
  assert.equal(
    rebound.receipt.replacementAuthorityDigest,
    digest(replacement)
  );
  assert.equal(
    rebound.receipt.destinationWorkAccordDigest,
    digest(replacement.workAccord)
  );
  assert.deepEqual(
    verifyReceiptChain(
      [requested.receipt, rebound.receipt],
      rebound.receiptDigest,
      replacement.workAccord
    ),
    []
  );

  const duplicate = evaluateTransition(rebound.snapshot, rebindEvent, {
    ...base.context,
    rebindAuthority: replacement
  });
  assert.equal(duplicate.kind, "noop");
});

test("rebind fails closed for stale, mismatched, or untrusted authority", () => {
  const base = harness({
    state: "ACTIVATION_PENDING",
    phaseOwner: "kernel",
    destinationPhase: null
  });
  const replacement = replacementAuthority();
  const trusted = event({
    type: "binding-revalidated",
    actorClass: "policy",
    provenanceSource: "policy-engine",
    replacementAuthorityDigest: digest(replacement)
  });

  expectRefusal(
    evaluateTransition(
      base.snapshot,
      event({
        type: "binding-revalidated",
        actorClass: "policy",
        provenanceSource: "policy-engine",
        replacementAuthorityDigest: digest(replacement),
        expectedStateVersion: 1
      }),
      { ...base.context, rebindAuthority: replacement }
    ),
    "CONCURRENCY_CONFLICT"
  );
  const mismatchedBinding = {
    ...replacement,
    bindingDigest: digest("mismatched-binding")
  };
  expectRefusal(
    evaluateTransition(base.snapshot, event({
      type: "binding-revalidated",
      actorClass: "policy",
      provenanceSource: "policy-engine",
      replacementAuthorityDigest: digest(mismatchedBinding)
    }), {
      ...base.context,
      rebindAuthority: mismatchedBinding
    }),
    "CONTRACT_STALE"
  );
  const changedTarget = replacementAuthority({
    repositoryId: 2,
    workItemNodeId: "I_other"
  });
  expectRefusal(
    evaluateTransition(base.snapshot, event({
      type: "binding-revalidated",
      actorClass: "policy",
      provenanceSource: "policy-engine",
      replacementAuthorityDigest: digest(changedTarget)
    }), {
      ...base.context,
      rebindAuthority: changedTarget
    }),
    "CONTRACT_STALE"
  );
  const changedSource = replacementAuthority({
    sourceDigest: digest("other-source")
  });
  expectRefusal(
    evaluateTransition(base.snapshot, event({
      type: "binding-revalidated",
      actorClass: "policy",
      provenanceSource: "policy-engine",
      replacementAuthorityDigest: digest(changedSource)
    }), {
      ...base.context,
      rebindAuthority: changedSource
    }),
    "CONTRACT_STALE"
  );
  expectRefusal(
    evaluateTransition(
      base.snapshot,
      event({
        type: "binding-revalidated",
        actorClass: "policy",
        provenanceSource: "test-fixture",
        replacementAuthorityDigest: digest(replacement)
      }),
      { ...base.context, rebindAuthority: replacement }
    ),
    "PROVENANCE_INVALID"
  );
  expectRefusal(
    evaluateTransition(
      base.snapshot,
      event({
        type: "binding-revalidated",
        actorClass: "requester",
        provenanceSource: "trusted-adapter",
        replacementAuthorityDigest: digest(replacement)
      }),
      { ...base.context, rebindAuthority: replacement }
    ),
    "UNAUTHORIZED_ACTOR"
  );
  const skippedRevision = replacementAuthority({ revision: 4 });
  expectRefusal(
    evaluateTransition(base.snapshot, event({
      type: "binding-revalidated",
      actorClass: "policy",
      provenanceSource: "policy-engine",
      replacementAuthorityDigest: digest(skippedRevision)
    }), {
      ...base.context,
      rebindAuthority: skippedRevision
    }),
    "CONTRACT_STALE"
  );
});

test("rebind authority is event-bound and replay identity cannot change authority", () => {
  const base = harness({
    state: "ACTIVATION_PENDING",
    phaseOwner: "kernel",
    destinationPhase: null
  });
  const firstAuthority = replacementAuthority({
    currentHead: digest("replacement-head-one")
  });
  const secondAuthority = replacementAuthority({
    currentHead: digest("replacement-head-two")
  });
  const firstEvent = event({
    id: "shared-rebind-event",
    type: "binding-revalidated",
    actorClass: "policy",
    provenanceSource: "policy-engine",
    replacementAuthorityDigest: digest(firstAuthority)
  });

  expectRefusal(
    evaluateTransition(base.snapshot, firstEvent, {
      ...base.context,
      rebindAuthority: secondAuthority
    }),
    "PROVENANCE_INVALID"
  );

  const first = evaluateTransition(base.snapshot, firstEvent, {
    ...base.context,
    rebindAuthority: firstAuthority
  });
  assert.equal(first.kind, "applied");
  if (first.kind !== "applied") return;
  const conflictingEvent = event({
    id: firstEvent.id,
    type: "binding-revalidated",
    actorClass: "policy",
    provenanceSource: "policy-engine",
    replacementAuthorityDigest: digest(secondAuthority)
  });
  expectRefusal(
    evaluateTransition(first.snapshot, conflictingEvent, {
      ...base.context,
      rebindAuthority: secondAuthority
    }),
    "REPLAY_CONFLICT"
  );
});

test("AuthorityRebind wrapper is closed and canonical before hashing", () => {
  const base = harness({
    state: "ACTIVATION_PENDING",
    phaseOwner: "kernel",
    destinationPhase: null
  });
  const replacement = replacementAuthority();
  const rebindEvent = event({
    type: "binding-revalidated",
    actorClass: "policy",
    provenanceSource: "policy-engine",
    replacementAuthorityDigest: digest(replacement)
  });
  assert.equal(validateDocument("AuthorityRebind", replacement).valid, true);

  const extra = { ...replacement, unexpected: true };
  const undefinedValue = { ...replacement, registry: undefined };
  const functionValue = { ...replacement, policy: () => "not JSON" };
  const missing = { ...replacement } as Record<string, unknown>;
  delete missing.domainPack;
  const cycle = { ...replacement } as Record<string, unknown>;
  cycle.graph = cycle;

  for (const malformed of [
    extra,
    undefinedValue,
    functionValue,
    missing,
    cycle
  ]) {
    const result = evaluateTransition(base.snapshot, rebindEvent, {
      ...base.context,
      rebindAuthority: malformed as unknown as AuthorityRebind
    });
    expectRefusal(result, "SCHEMA_INVALID");
  }
});

test("rebind validates projected usage against replacement lifetime ceilings", () => {
  const atBoundary = harness({
    state: "ACTIVATION_PENDING",
    phaseOwner: "kernel",
    destinationPhase: null,
    usage: { calls: 1, tokens: 20, costUnits: 2, loops: 3, retries: 0 }
  });
  const replacement = replacementAuthority({ budget: { maxLoops: 4 } });
  const boundaryEvent = event({
    type: "binding-revalidated",
    actorClass: "policy",
    provenanceSource: "policy-engine",
    replacementAuthorityDigest: digest(replacement),
    cost: { calls: 0, tokens: 0, costUnits: 0, loops: 1 }
  });
  const boundaryResult = evaluateTransition(
    atBoundary.snapshot,
    boundaryEvent,
    { ...atBoundary.context, rebindAuthority: replacement }
  );
  assert.equal(boundaryResult.kind, "applied");
  if (boundaryResult.kind === "applied") {
    assert.equal(boundaryResult.snapshot.usage.loops, 4);
  }

  const exhausted = harness({
    state: "ACTIVATION_PENDING",
    phaseOwner: "kernel",
    destinationPhase: null,
    usage: { calls: 1, tokens: 20, costUnits: 2, loops: 4, retries: 0 }
  });
  expectRefusal(
    evaluateTransition(exhausted.snapshot, boundaryEvent, {
      ...exhausted.context,
      rebindAuthority: replacement
    }),
    "LOOP_LIMIT_EXHAUSTED"
  );

  const overflow = harness({
    state: "ACTIVATION_PENDING",
    phaseOwner: "kernel",
    destinationPhase: null,
    usage: {
      calls: 1,
      tokens: 20,
      costUnits: 2,
      loops: Number.MAX_SAFE_INTEGER,
      retries: 0
    }
  });
  expectRefusal(
    evaluateTransition(overflow.snapshot, boundaryEvent, {
      ...overflow.context,
      rebindAuthority: replacement
    }),
    "NUMERIC_OVERFLOW"
  );
});

test("control states reject authority unrelated to their retained state", () => {
  const base = harness({
    state: "PAUSED",
    phaseOwner: "kernel",
    authorityPhase: "framing",
    destinationPhase: "framing",
    suspendedState: "EXECUTING"
  });
  expectRefusal(
    evaluateTransition(
      base.snapshot,
      event({ type: "resume-requested", actorClass: "maintainer" }),
      base.context
    ),
    "CONTRACT_STALE"
  );
});

test("pause, resume, partial failure, and retry preserve bound authority", () => {
  const execution = phaseFor("execution");
  const executionAccord = accord;
  const base = harness({
    state: "EXECUTING",
    phaseOwner: "execution",
    authorityPhase: "execution",
    destinationPhase: null
  });
  const paused = evaluateTransition(
    base.snapshot,
    event({ type: "pause-requested", actorClass: "requester" }),
    base.context
  );
  assert.equal(paused.kind, "applied");
  if (paused.kind !== "applied") return;
  assert.equal(paused.snapshot.phaseContractDigest, digest(execution));
  assert.equal(paused.snapshot.suspendedState, "EXECUTING");

  const maintainer = actor("maintainer");
  const resumeLease = lease(executionAccord, "execution", []);
  const resumeContext: KernelContext = {
    ...base.context,
    currentPhaseContract: execution,
    destinationPhaseContract: execution,
    activationLease: resumeLease,
    humanGateEvidence: [gateForLease("activate", maintainer, resumeLease)]
  };
  const resumed = evaluateTransition(
    paused.snapshot,
    event({
      type: "resume-requested",
      actorClass: "maintainer",
      expectedStateVersion: 1,
      sequence: 2
    }),
    resumeContext
  );
  assert.equal(resumed.kind, "applied");
  if (resumed.kind !== "applied") return;
  const partial = evaluateTransition(
    resumed.snapshot,
    event({
      type: "partial-effect-recorded",
      actorClass: "system",
      expectedStateVersion: 2,
      sequence: 3
    }),
    { ...resumeContext, destinationPhaseContract: null }
  );
  assert.equal(partial.kind, "applied");
  if (partial.kind !== "applied") return;
  assert.equal(partial.snapshot.recoveryState, "EXECUTING");
  const retried = evaluateTransition(
    partial.snapshot,
    event({
      type: "retry-requested",
      actorClass: "maintainer",
      expectedStateVersion: 3,
      sequence: 4
    }),
    { ...resumeContext, retryableFailure: true }
  );
  assert.equal(retried.kind, "applied");
  if (retried.kind === "applied") {
    assert.equal(retried.snapshot.state, "EXECUTING");
    assert.equal(retried.snapshot.usage.retries, 1);
  }
});

test("verification replan applies the Kernel route and returns to planning", () => {
  const planning = phaseFor("planning");
  const verification: PhaseContract = {
    ...phaseFor("verification"),
    exitRules: [
      ...phaseFor("verification").exitRules,
      {
        predicate: "verification-evidence-passed",
        event: "replan-requested"
      }
    ]
  };
  const workAccord = accordFor(lifecycle, [
    framingPhase,
    planning,
    phaseFor("execution"),
    verification,
    phaseFor("human-review")
  ]);
  const activationLease = lease(
    workAccord,
    ["planning", "verification"],
    ["core.review-current-head@1.0.0"]
  );
  const base = harness({
    state: "VERIFYING",
    phaseOwner: "verification",
    stateVersion: 5,
    sequence: 5,
    authorityPhase: "verification",
    destinationPhase: "planning",
    currentPhaseContract: verification,
    destinationPhaseContract: planning,
    workAccord,
    activationLease,
    gates: [gate("activate", actor("maintainer"), workAccord)]
  });
  const result = evaluateTransition(
    base.snapshot,
    event({
      type: "replan-requested",
      actorClass: "system",
      expectedStateVersion: 5,
      sequence: 6
    }),
    base.context
  );
  assert.equal(
    result.kind,
    "applied",
    result.kind === "refused" ? JSON.stringify(result.refusal) : ""
  );
  if (result.kind === "applied") {
    assert.equal(result.route.id, "verification.replan");
    assert.equal(result.snapshot.state, "PLANNED");
  }
});

test("migration registry validates deterministic same-version no-ops", () => {
  const migrations = createDefaultMigrationRegistry();
  const source = structuredClone(accord) as unknown as Record<string, unknown>;
  const before = structuredClone(source);
  const first = migrations.migrate({
    kind: "WorkAccord",
    document: source,
    from: "1.0.0",
    to: "1.0.0",
    dryRun: true
  });
  const second = migrations.migrate({
    kind: "WorkAccord",
    document: source,
    from: "1.0.0",
    to: "1.0.0",
    dryRun: true
  });
  assert.deepEqual(first, second);
  assert.equal(first.ok, true);
  if (first.ok) {
    assert.equal(first.changed, false);
    assert.deepEqual(first.path, []);
    assert.notEqual(first.document, source);
  }
  assert.deepEqual(source, before);
});

test("migration registry rejects malformed and unsupported documents", () => {
  const migrations = createDefaultMigrationRegistry();
  const malformed = {
    ...accord,
    binding: null
  } as unknown as Record<string, unknown>;
  const malformedResult = migrations.migrate({
    kind: "WorkAccord",
    document: malformed,
    from: "1.0.0",
    to: "1.0.0",
    dryRun: true
  });
  assert.deepEqual(malformedResult.ok && malformedResult, false);
  if (!malformedResult.ok) assert.equal(malformedResult.code, "SCHEMA_INVALID");

  for (const [from, to] of [
    ["0.9.0", "1.0.0"],
    ["1.0.0", "1.1.0"],
    ["v1", "1.0.0"]
  ] as const) {
    const unavailable = migrations.migrate({
      kind: "WorkAccord",
      document: accord as unknown as Record<string, unknown>,
      from,
      to,
      dryRun: true
    });
    assert.equal(unavailable.ok, false);
    if (!unavailable.ok) {
      assert.equal(unavailable.code, "MIGRATION_UNAVAILABLE");
    }
  }
});

test("migration plans are deterministic and registry steps are unique", () => {
  const migrations = new MigrationRegistry();
  const validateTarget = (document: Readonly<Record<string, unknown>>) =>
    document["migrationVersion"] === "1.1.0"
      ? ({ valid: true } as const)
      : ({ valid: false, errors: ["target version is invalid"] } as const);
  const step = {
    kind: "WorkAccord" as const,
    from: "1.0.0",
    to: "1.1.0",
    validateSource: () => ({ valid: true } as const),
    validateTarget,
    migrate: (document: Readonly<Record<string, unknown>>) => ({
      ...document,
      migrationVersion: "1.1.0"
    })
  };
  migrations.register(step);
  assert.throws(() => migrations.register(step), /already registered/);
  assert.deepEqual(
    migrations.plan({ kind: "WorkAccord", from: "1.0.0", to: "1.1.0" }),
    migrations.plan({ kind: "WorkAccord", from: "1.0.0", to: "1.1.0" })
  );

  const source = structuredClone(accord) as unknown as Record<string, unknown>;
  const before = structuredClone(source);
  const first = migrations.migrate({
    kind: "WorkAccord",
    document: source,
    from: "1.0.0",
    to: "1.1.0",
    dryRun: true
  });
  const second = migrations.migrate({
    kind: "WorkAccord",
    document: source,
    from: "1.0.0",
    to: "1.1.0",
    dryRun: true
  });
  assert.deepEqual(first, second);
  assert.equal(first.ok && first.changed, true);
  assert.deepEqual(source, before);

  const validateSecondTarget = (
    document: Readonly<Record<string, unknown>>
  ) =>
    document["migrationVersion"] === "1.2.0"
      ? ({ valid: true } as const)
      : ({ valid: false, errors: ["second target is invalid"] } as const);
  const secondStep = {
    kind: "WorkAccord",
    from: "1.1.0",
    to: "1.2.0",
    validateSource: (document: Readonly<Record<string, unknown>>) =>
      document["migrationVersion"] === "1.1.0"
        ? ({ valid: true } as const)
        : ({ valid: false, errors: ["second source is invalid"] } as const),
    validateTarget: validateSecondTarget,
    migrate: (document: Readonly<Record<string, unknown>>) => ({
      ...document,
      migrationVersion: "1.2.0"
    })
  } as const;
  migrations.register(secondStep);
  const chained = migrations.migrate({
    kind: "WorkAccord",
    document: source,
    from: "1.0.0",
    to: "1.2.0",
    dryRun: true
  });
  assert.equal(chained.ok, true);
  if (chained.ok) {
    assert.deepEqual(chained.path, ["1.0.0->1.1.0", "1.1.0->1.2.0"]);
    assert.equal(chained.document["migrationVersion"], "1.2.0");
  }
  const reverseRegistration = new MigrationRegistry();
  reverseRegistration.register(secondStep);
  reverseRegistration.register(step);
  assert.deepEqual(
    reverseRegistration.migrate({
      kind: "WorkAccord",
      document: source,
      from: "1.0.0",
      to: "1.2.0",
      dryRun: true
    }),
    chained
  );

  const futureNoop = migrations.migrate({
    kind: "WorkAccord",
    document:
      first.ok ? first.document : { migrationVersion: "invalid-test-state" },
    from: "1.1.0",
    to: "1.1.0",
    dryRun: true
  });
  assert.equal(futureNoop.ok, true);
  const mislabeledFuture = migrations.migrate({
    kind: "WorkAccord",
    document: source,
    from: "1.1.0",
    to: "1.1.0",
    dryRun: true
  });
  assert.equal(mislabeledFuture.ok, false);
  if (!mislabeledFuture.ok) {
    assert.equal(mislabeledFuture.code, "SCHEMA_INVALID");
  }

  assert.throws(
    () =>
      migrations.register({
        kind: "WorkAccord",
        from: "0.9.0",
        to: "1.1.0",
        validateSource: () => ({ valid: true }),
        validateTarget: () => ({ valid: true }),
        migrate: (document) => document
      }),
    /conflicting validator/
  );
});

test("every migration step enforces its explicit source validator", () => {
  const migrations = new MigrationRegistry();
  migrations.register({
    kind: "WorkAccord",
    from: "1.0.0",
    to: "1.1.0",
    validateSource: () => ({
      valid: false,
      errors: ["step-specific source precondition failed"]
    }),
    validateTarget: () => ({ valid: true }),
    migrate: (document) => ({ ...document, migrationVersion: "1.1.0" })
  });
  const result = migrations.migrate({
    kind: "WorkAccord",
    document: accord as unknown as Record<string, unknown>,
    from: "1.0.0",
    to: "1.1.0",
    dryRun: true
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "SCHEMA_INVALID");
    assert.match(result.message, /step-specific source precondition failed/);
  }
});

test("migration registrations and validators cannot mutate authority", () => {
  const migrations = new MigrationRegistry();
  const mutableStep = {
    kind: "WorkAccord" as const,
    from: "1.0.0",
    to: "1.1.0",
    validateSource: () => ({ valid: true } as const),
    validateTarget: (document: Readonly<Record<string, unknown>>) => {
      delete (document as Record<string, unknown>)["migrationVersion"];
      return { valid: true } as const;
    },
    migrate: (document: Readonly<Record<string, unknown>>) => ({
      ...document,
      migrationVersion: "1.1.0"
    })
  };
  migrations.register(mutableStep);
  mutableStep.from = "1.1.0";
  mutableStep.to = "9.9.9";

  const result = migrations.migrate({
    kind: "WorkAccord",
    document: accord as unknown as Record<string, unknown>,
    from: "1.0.0",
    to: "1.1.0",
    dryRun: true
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "SCHEMA_INVALID");
    assert.match(result.message, /validator mutated/);
  }
  assert.equal(
    Object.hasOwn(accord as unknown as Record<string, unknown>, "migrationVersion"),
    false
  );
});

test("receipt verification requires a trusted terminal head", () => {
  const firstBase = harness();
  const first = evaluateTransition(
    firstBase.snapshot,
    event({ type: "activation-requested", actorClass: "requester" }),
    firstBase.context
  );
  assert.equal(first.kind, "applied");
  if (first.kind !== "applied") return;
  const second = evaluateTransition(
    first.snapshot,
    event({
      type: "cancel-requested",
      actorClass: "requester",
      expectedStateVersion: 1,
      sequence: 2
    }),
    firstBase.context
  );
  assert.equal(second.kind, "applied");
  if (second.kind !== "applied") return;
  assert.deepEqual(
    verifyReceiptChain(
      [first.receipt, second.receipt],
      second.receiptDigest,
      accord
    ),
    []
  );
  const substitutedAccord: WorkAccord = {
    ...accord,
    binding: { ...accord.binding, workItemNodeId: "I_other" }
  };
  assert.notDeepEqual(
    verifyReceiptChain(
      [first.receipt, second.receipt],
      second.receiptDigest,
      substitutedAccord
    ),
    []
  );
  const changedHeadAccord: WorkAccord = {
    ...accord,
    binding: { ...accord.binding, currentHead: digest("substituted-head") }
  };
  assert.equal(
    workAccordBindingDigest(changedHeadAccord),
    workAccordBindingDigest(accord)
  );
  assert.notDeepEqual(
    verifyReceiptChain(
      [first.receipt, second.receipt],
      second.receiptDigest,
      changedHeadAccord
    ),
    []
  );
  const terminalTamper: TransitionReceipt = {
    ...second.receipt,
    actorId: "attacker"
  };
  assert.notDeepEqual(
    verifyReceiptChain(
      [first.receipt, terminalTamper],
      second.receiptDigest,
      accord
    ),
    []
  );

  const rewrittenFirst: TransitionReceipt = {
    ...first.receipt,
    actorId: "attacker"
  };
  const rewrittenSecond: TransitionReceipt = {
    ...second.receipt,
    previousReceipt: digest(rewrittenFirst),
    actorId: "attacker"
  };
  assert.notDeepEqual(
    verifyReceiptChain(
      [rewrittenFirst, rewrittenSecond],
      second.receiptDigest,
      accord
    ),
    []
  );
});

test("human-readable Work Accord is explicitly non-authoritative", () => {
  const markdown = renderWorkAccordMarkdown(accord);
  assert.match(markdown, /grants no authority/);
  assert.match(markdown, /Secret access:\*\* denied/);
});

test("canonical digests are stable across object key order", () => {
  for (let index = 0; index < 100; index += 1) {
    assert.equal(
      digest({ value: index, nested: { odd: index % 2 === 1 } }),
      digest({ nested: { odd: index % 2 === 1 }, value: index })
    );
  }
});
