import { authorizeActor, authorizeHumanGate } from "./authorization.js";
import { workAccordBindingDigest } from "./binding.js";
import { digest } from "./canonical.js";
import { eventPayloadDigest } from "./events.js";
import {
  allowsNullPhaseAuthority,
  classifyRouteAuthority,
  isActivePhaseOwner,
  isCostBearingState,
  selectRoute,
  validateLifecycleGraph,
  validateSnapshotLifecycleSemantics
} from "./lifecycle.js";
import {
  compilePolicy,
  computeCompiledPolicyDigest,
  type CompiledPolicy
} from "./policy.js";
import {
  isCanonicalUtcDateTime,
  validateDocument
} from "./validation.js";
import type {
  ActivationLease,
  AuthorityRebind,
  CapabilityRegistry,
  ContractEvidenceType,
  ContractPredicate,
  ContractRequirementEvidence,
  ControlPolicy,
  Digest,
  DomainPackPolicy,
  EventEnvelope,
  HumanGateEvidence,
  KernelEffect,
  KernelRefusal,
  KernelResult,
  KernelSnapshot,
  LifecycleGraph,
  LifecycleRoute,
  PhaseContract,
  TransitionReceipt,
  Usage,
  WorkAccord
} from "./types.js";

export interface KernelContext {
  readonly graph: LifecycleGraph;
  readonly workAccord: WorkAccord;
  readonly policy: ControlPolicy;
  readonly registry: CapabilityRegistry;
  readonly domainPack: DomainPackPolicy;
  readonly currentPhaseContract: PhaseContract | null;
  readonly destinationPhaseContract: PhaseContract | null;
  readonly activationLease: ActivationLease | null;
  readonly humanGateEvidence: readonly HumanGateEvidence[];
  readonly contractRequirementEvidence: readonly ContractRequirementEvidence[];
  readonly requesterId: string;
  readonly evaluatedAt: string;
  readonly retryableFailure: boolean;
  readonly rebindAuthority: AuthorityRebind | null;
}

interface PhaseAuthority {
  readonly contract: PhaseContract;
  readonly compiled: CompiledPolicy;
}

function refusal(
  snapshot: KernelSnapshot,
  code: KernelRefusal["code"],
  message: string,
  ruleId: string,
  retryable: boolean,
  recovery: KernelRefusal["recovery"]
): KernelResult {
  return {
    kind: "refused",
    refusal: { code, message, ruleId, retryable, recovery },
    snapshot
  };
}

export { eventPayloadDigest } from "./events.js";

export function createInitialSnapshot(input: {
  readonly lifecycleGraphDigest: Digest;
  readonly workAccord: WorkAccord;
  readonly capabilityRegistryDigest: Digest;
  readonly domainPackDigest: Digest;
  readonly policyDigest: Digest;
}): KernelSnapshot {
  return {
    schemaVersion: "1.0.0",
    lifecycleVersion: "1.0.0",
    lifecycleGraphDigest: input.lifecycleGraphDigest,
    state: "CAPTURED",
    phaseOwner: "intake",
    stateVersion: 0,
    lastEventSequence: 0,
    bindingDigest: workAccordBindingDigest(input.workAccord),
    workAccordDigest: digest(input.workAccord),
    capabilityRegistryDigest: input.capabilityRegistryDigest,
    domainPackDigest: input.domainPackDigest,
    phaseContractDigest: null,
    compiledPolicyDigest: null,
    policyDigest: input.policyDigest,
    currentHead: input.workAccord.binding.currentHead,
    receiptHead: null,
    suspendedState: null,
    recoveryState: null,
    usage: { calls: 0, tokens: 0, costUnits: 0, loops: 0, retries: 0 },
    phaseUsage: { calls: 0, tokens: 0, costUnits: 0, loops: 0, retries: 0 },
    routeAttempts: {},
    processedEvents: {}
  };
}

function safeAdd(left: number, right: number): number | null {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) {
    return null;
  }
  const result = left + right;
  return Number.isSafeInteger(result) ? result : null;
}

function nonJsonValuePath(value: unknown): string | null {
  const active = new WeakSet<object>();
  const stack: Array<
    | { readonly kind: "enter"; readonly value: unknown; readonly path: string }
    | { readonly kind: "leave"; readonly value: object }
  > = [{ kind: "enter", value, path: "$" }];

  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    if (frame.kind === "leave") {
      active.delete(frame.value);
      continue;
    }
    const item = frame.value;
    if (
      item === null ||
      typeof item === "string" ||
      typeof item === "boolean"
    ) {
      continue;
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) return frame.path;
      continue;
    }
    if (typeof item !== "object") return frame.path;
    if (active.has(item)) return frame.path;
    active.add(item);
    stack.push({ kind: "leave", value: item });
    const descriptors = Object.getOwnPropertyDescriptors(item);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string") return `${frame.path}.[symbol]`;
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !Object.hasOwn(descriptor, "value")
      ) {
        return `${frame.path}.${key}`;
      }
      stack.push({
        kind: "enter",
        value: descriptor.value,
        path: `${frame.path}.${key}`
      });
    }
  }
  return null;
}

function addUsage(
  usage: Usage,
  event: EventEnvelope
): Usage | null {
  const calls = safeAdd(usage.calls, event.cost.calls);
  const tokens = safeAdd(usage.tokens, event.cost.tokens);
  const costUnits = safeAdd(usage.costUnits, event.cost.costUnits);
  const loops = safeAdd(usage.loops, event.cost.loops);
  const retries = safeAdd(
    usage.retries,
    event.type === "retry-requested" ? 1 : 0
  );
  if (
    calls === null ||
    tokens === null ||
    costUnits === null ||
    loops === null ||
    retries === null
  ) {
    return null;
  }
  return { calls, tokens, costUnits, loops, retries };
}

const EMPTY_USAGE: Usage = {
  calls: 0,
  tokens: 0,
  costUnits: 0,
  loops: 0,
  retries: 0
};

const SUPPORTED_PREDICATES = new Set<ContractPredicate>([
  "accepted-patch-plan-current",
  "accepted-plan-current",
  "activation-lease-current",
  "advisory-current",
  "all-current-head-security-evidence-success",
  "base-sha-current",
  "draft-pr-exact-head-current",
  "draft-pull-request-head-current",
  "work-accord-current",
  "eligible-human-accepts-frame",
  "eligible-human-accepts-plan",
  "eligible-human-accepts-remediation-frame",
  "eligible-human-accepts-target-free-patch-plan",
  "work-submitted-for-verification",
  "verification-evidence-passed",
  "eligible-independent-human-accepts-merged-head",
  "eligible-independent-human-accepts-current-head",
  "exact-head-verification-passed",
  "framing-artifacts-current",
  "known-unrelated-alert-open",
  "network-denied",
  "remediation-design-receipt-current",
  "signed-stage-artifact-valid-and-hermetic",
  "synthetic-advisory-signature-valid",
  "target-free-patch-validated-and-draft-pr-observed",
  "trusted-draft-pull-request-created",
  "trusted-repository-base-current",
  "trusted-security-remediation-binding-current",
  "trusted-target-slot-map-current",
  "verification-head-current",
  "verification-receipt-current",
  "eligible-human-accepts-outcome"
]);

const SUPPORTED_EVIDENCE = new Set<ContractEvidenceType>([
  "accepted-frame",
  "accepted-patch-plan",
  "accepted-plan",
  "comment-only-review",
  "dependency-lock-consistency-success",
  "dlp-success",
  "draft-patch-pr",
  "draft-pull-request-evidence",
  "exact-base-sha",
  "fixed-command-catalog",
  "fixed-regression-success",
  "hermetic-reproduction-policy",
  "human-review-package",
  "known-alert-unchanged",
  "logical-target-map",
  "remediation-design",
  "security-regression-verification",
  "signed-synthetic-advisory",
  "signed-synthetic-scanner-success",
  "target-slot-map",
  "threat-detection-success",
  "trusted-binding",
  "activation-lease",
  "validated-patch",
  "verification-report"
]);

export function kernelSupportsContractRequirement(
  requirementType: "predicate" | "evidence",
  requirement: string
): boolean {
  return requirementType === "predicate"
    ? SUPPORTED_PREDICATES.has(requirement as ContractPredicate)
    : SUPPORTED_EVIDENCE.has(requirement as ContractEvidenceType);
}

function requirementEvidenceIsCurrent(input: {
  readonly evidence: ContractRequirementEvidence;
  readonly requirementType: "predicate" | "evidence";
  readonly requirement: string;
  readonly actorAuthorizationDigest: Digest | null;
  readonly phaseContractDigest: Digest;
  readonly routeId: string;
  readonly snapshot: KernelSnapshot;
  readonly context: KernelContext;
}): boolean {
  const { evidence, snapshot, context } = input;
  const observedAt = Date.parse(evidence.observedAt);
  const expiresAt = Date.parse(evidence.expiresAt);
  const evaluatedAt = Date.parse(context.evaluatedAt);
  return (
    evidence.requirementType === input.requirementType &&
    evidence.requirement === input.requirement &&
    evidence.satisfied &&
    evidence.workAccordDigest === snapshot.workAccordDigest &&
    evidence.bindingDigest === snapshot.bindingDigest &&
    evidence.snapshotDigest === digest(snapshot) &&
    evidence.phaseContractDigest === input.phaseContractDigest &&
    evidence.routeId === input.routeId &&
    evidence.activationLeaseDigest ===
      (input.requirement === "activation-lease-current" ||
      input.requirement === "activation-lease"
        ? input.context.activationLease === null
          ? null
          : digest(input.context.activationLease)
        : null) &&
    evidence.currentHead === snapshot.currentHead &&
    evidence.actorAuthorizationDigest === input.actorAuthorizationDigest &&
    Number.isFinite(observedAt) &&
    Number.isFinite(expiresAt) &&
    Number.isFinite(evaluatedAt) &&
    observedAt <= evaluatedAt &&
    evaluatedAt < expiresAt
  );
}

function validateContractRequirement(input: {
  readonly requirementType: "predicate" | "evidence";
  readonly requirement: string;
  readonly actorAuthorizationDigest: Digest | null;
  readonly phaseContractDigest: Digest;
  readonly routeId: string;
  readonly snapshot: KernelSnapshot;
  readonly context: KernelContext;
}): KernelResult | null {
  const known = kernelSupportsContractRequirement(
    input.requirementType,
    input.requirement
  );
  if (!known) {
    return refusal(
      input.snapshot,
      "CONTRACT_REQUIREMENT_MISSING",
      `unknown ${input.requirementType} ${input.requirement}`,
      "contract.known-requirement",
      false,
      "new-contract"
    );
  }
  const satisfied = input.context.contractRequirementEvidence.some((evidence) =>
    requirementEvidenceIsCurrent({ ...input, evidence })
  );
  if (!satisfied) {
    return refusal(
      input.snapshot,
      "CONTRACT_REQUIREMENT_MISSING",
      `${input.requirementType} ${input.requirement} is not satisfied by current trusted evidence`,
      "contract.current-requirement-evidence",
      false,
      "reconcile"
    );
  }
  if (
    (input.requirement === "activation-lease-current" ||
      input.requirement === "activation-lease") &&
    (input.context.activationLease === null ||
      input.context.activationLease.revoked ||
      input.context.activationLease.workAccordDigest !==
        input.snapshot.workAccordDigest ||
      Date.parse(input.context.evaluatedAt) >=
        Date.parse(input.context.activationLease.expiresAt))
  ) {
    return refusal(
      input.snapshot,
      "ACTIVATION_REQUIRED",
      "activation lease requirement is not currently true",
      "contract.activation-lease-current",
      false,
      "human-authorization"
    );
  }
  return null;
}

function validatePhaseRequirements(input: {
  readonly snapshot: KernelSnapshot;
  readonly event: EventEnvelope;
  readonly route: LifecycleRoute;
  readonly current: PhaseAuthority | null;
  readonly destination: PhaseAuthority | null;
  readonly context: KernelContext;
}): KernelResult | null {
  const enteringNewPhase =
    input.destination !== null &&
    (input.current === null ||
      input.destination.contract.phase !== input.current.contract.phase);
  const exitsCurrentPhase =
    input.current !== null &&
    (enteringNewPhase || input.route.to === "COMPLETED");

  if (exitsCurrentPhase && input.current !== null) {
    const exitRule = input.current.contract.exitRules.find(
      (rule) => rule.event === input.event.type
    );
    if (exitRule === undefined) {
      return refusal(
        input.snapshot,
        "CONTRACT_REQUIREMENT_MISSING",
        `Phase Contract has no exit rule for ${input.event.type}`,
        "contract.exit-rule",
        false,
        "new-contract"
      );
    }
    const exitRefusal = validateContractRequirement({
      requirementType: "predicate",
      requirement: exitRule.predicate,
      actorAuthorizationDigest: input.event.actor.authorizationDigest,
      phaseContractDigest: digest(input.current.contract),
      routeId: input.route.id,
      snapshot: input.snapshot,
      context: input.context
    });
    if (exitRefusal !== null) {
      return exitRefusal;
    }
  }

  if (enteringNewPhase && input.destination !== null) {
    for (const requirement of input.destination.contract.entryPredicates) {
      const entryRefusal = validateContractRequirement({
        requirementType: "predicate",
        requirement,
        actorAuthorizationDigest: null,
        phaseContractDigest: digest(input.destination.contract),
        routeId: input.route.id,
        snapshot: input.snapshot,
        context: input.context
      });
      if (entryRefusal !== null) {
        return entryRefusal;
      }
    }
    for (const requirement of input.destination.contract.requiredEvidence) {
      const evidenceRefusal = validateContractRequirement({
        requirementType: "evidence",
        requirement,
        actorAuthorizationDigest: null,
        phaseContractDigest: digest(input.destination.contract),
        routeId: input.route.id,
        snapshot: input.snapshot,
        context: input.context
      });
      if (evidenceRefusal !== null) {
        return evidenceRefusal;
      }
    }
  }
  return null;
}

function compileAuthority(
  contract: PhaseContract,
  context: KernelContext
): PhaseAuthority | KernelRefusal {
  const result = compilePolicy({
    enterprise: context.policy,
    accord: context.workAccord,
    phase: contract,
    domainPack: context.domainPack,
    registry: context.registry
  });
  if (!result.ok) {
    return {
      code: "POLICY_ESCALATION",
      message: result.errors.join("; "),
      ruleId: "policy.compile",
      retryable: false,
      recovery: "new-contract"
    };
  }
  return { contract, compiled: result.policy };
}

function currentAuthority(
  snapshot: KernelSnapshot,
  context: KernelContext,
  requiresAuthority: boolean
): PhaseAuthority | KernelRefusal | null {
  if (
    snapshot.phaseContractDigest === null ||
    snapshot.compiledPolicyDigest === null
  ) {
    if (
      snapshot.phaseContractDigest !== null ||
      snapshot.compiledPolicyDigest !== null ||
      context.currentPhaseContract !== null
    ) {
      return {
        code: "CONTRACT_STALE",
        message: "current phase authority is only partially bound",
        ruleId: "phase.current-binding",
        retryable: false,
        recovery: "new-contract"
      };
    }
    if (requiresAuthority) {
      return {
        code: "CONTRACT_STALE",
        message: `lifecycle state ${snapshot.state} requires current phase authority`,
        ruleId: "phase.required-for-state",
        retryable: false,
        recovery: "new-contract"
      };
    }
    return null;
  }
  if (context.currentPhaseContract === null) {
    return {
      code: "CONTRACT_STALE",
      message: "current Phase Contract is required by the snapshot",
      ruleId: "phase.current-binding",
      retryable: false,
      recovery: "new-contract"
    };
  }
  const authority = compileAuthority(context.currentPhaseContract, context);
  if ("code" in authority) {
    return authority;
  }
  if (
    digest(authority.contract) !== snapshot.phaseContractDigest ||
    computeCompiledPolicyDigest(authority.compiled) !==
      snapshot.compiledPolicyDigest
  ) {
    return {
      code: "CONTRACT_STALE",
      message: "current phase authority does not match the snapshot",
      ruleId: "phase.current-digests",
      retryable: false,
      recovery: "new-contract"
    };
  }
  if (
    authority.contract.phase !== expectedAuthorityPhase(snapshot, context.graph)
  ) {
    return {
      code: "CONTRACT_STALE",
      message: "current Phase Contract does not own the current lifecycle phase",
      ruleId: "phase.current-owner",
      retryable: false,
      recovery: "new-contract"
    };
  }
  return authority;
}

function expectedAuthorityPhase(
  snapshot: KernelSnapshot,
  graph: LifecycleGraph
): PhaseContract["phase"] | null {
  const retainedState =
    snapshot.state === "PAUSED"
      ? snapshot.suspendedState
      : snapshot.state === "BLOCKED"
        ? snapshot.recoveryState
        : null;
  if (retainedState !== null) {
    const owner = graph.states.find((state) => state.id === retainedState)?.phaseOwner;
    return owner !== undefined && isActivePhaseOwner(owner) ? owner : null;
  }
  if (snapshot.state === "COMPLETED") {
    const owners = new Set(
      graph.routes
        .filter((route) => route.to === "COMPLETED")
        .map((route) => graph.states.find((state) => state.id === route.from)?.phaseOwner)
        .filter(
          (owner): owner is PhaseContract["phase"] =>
            owner !== undefined && isActivePhaseOwner(owner)
        )
    );
    const [owner] = owners;
    return owners.size === 1 && owner !== undefined ? owner : null;
  }
  return isActivePhaseOwner(snapshot.phaseOwner) ? snapshot.phaseOwner : null;
}

function destinationAuthority(
  snapshot: KernelSnapshot,
  route: LifecycleRoute,
  current: PhaseAuthority | null,
  context: KernelContext
): PhaseAuthority | KernelResult | null {
  if (route.to === "ACTIVATION_PENDING" || route.to === "CANCELLED") {
    return null;
  }
  if (route.phaseOwner === "kernel") {
    return current;
  }
  if (!isActivePhaseOwner(route.phaseOwner)) {
    return refusal(
      snapshot,
      "GRAPH_INVALID",
      "intake cannot receive transition authority",
      "phase.active-destination",
      false,
      "none"
    );
  }
  if (context.destinationPhaseContract === null) {
    return refusal(
      snapshot,
      "CONTRACT_STALE",
      `destination Phase Contract is required for ${route.phaseOwner}`,
      "phase.destination-binding",
      false,
      "new-contract"
    );
  }
  const authority = compileAuthority(context.destinationPhaseContract, context);
  if ("code" in authority) {
    return { kind: "refused", refusal: authority, snapshot };
  }
  if (authority.contract.phase !== route.phaseOwner) {
    return refusal(
      snapshot,
      "CONTRACT_STALE",
      `destination Phase Contract does not own ${route.phaseOwner}`,
      "phase.destination-owner",
      false,
      "new-contract"
    );
  }
  return authority;
}

export function compiledHumanGatesHaveLifecycleRoutes(
  compiled: CompiledPolicy,
  graph: LifecycleGraph
): boolean {
  const lifecycleGates = new Set(
    graph.routes.flatMap((route) =>
      route.humanGate === null ? [] : [route.humanGate]
    )
  );
  return compiled.requiredHumanGates.every((gate) => lifecycleGates.has(gate));
}

function validateCompiledCapabilityAuthority(
  snapshot: KernelSnapshot,
  compiled: CompiledPolicy | null,
  context: KernelContext
): KernelResult | null {
  if (compiled === null) {
    return null;
  }
  if (
    compiled.capabilities.some(
      (capability) => !capability.actorClasses.includes("system")
    )
  ) {
    return refusal(
      snapshot,
      "POLICY_ESCALATION",
      "an automatically entered capability does not authorize the system actor",
      "capability.system-actor",
      false,
      "new-contract"
    );
  }
  if (!compiledHumanGatesHaveLifecycleRoutes(compiled, context.graph)) {
    return refusal(
      snapshot,
      "POLICY_ESCALATION",
      "compiled policy declares a human gate not enforced by the lifecycle",
      "capability.human-gate-route",
      false,
      "new-contract"
    );
  }
  return null;
}

function validateLeaseAuthority(
  snapshot: KernelSnapshot,
  route: LifecycleRoute,
  compiled: CompiledPolicy | null,
  context: KernelContext
): KernelResult | null {
  if (!isActivePhaseOwner(route.phaseOwner)) {
    return null;
  }
  if (compiled === null) {
    return refusal(
      snapshot,
      "CONTRACT_STALE",
      "active-phase route has no compiled destination authority",
      "phase.lease-authority",
      false,
      "new-contract"
    );
  }
  const lease = context.activationLease;
  if (lease === null || lease.workAccordDigest !== snapshot.workAccordDigest) {
    return refusal(
      snapshot,
      "ACTIVATION_REQUIRED",
      "active-phase transition requires a lease bound to the current Work Accord",
      "lease.current-accord",
      false,
      "human-authorization"
    );
  }
  if (lease.revoked) {
    return refusal(
      snapshot,
      "LEASE_REVOKED",
      "activation lease is revoked",
      "lease.not-revoked",
      false,
      "human-authorization"
    );
  }
  const evaluatedAt = Date.parse(context.evaluatedAt);
  const leaseExpiresAt = Date.parse(lease.expiresAt);
  const accordExpiresAt = Date.parse(context.workAccord.budget.expiresAt);
  if (
    !Number.isFinite(evaluatedAt) ||
    !Number.isFinite(leaseExpiresAt) ||
    !Number.isFinite(accordExpiresAt) ||
    evaluatedAt >= leaseExpiresAt ||
    evaluatedAt >= accordExpiresAt
  ) {
    return refusal(
      snapshot,
      "LEASE_EXPIRED",
      "activation lease or Work Accord has expired",
      "lease.not-expired",
      false,
      "human-authorization"
    );
  }
  if (!lease.allowedPhases.includes(route.phaseOwner)) {
    return refusal(
      snapshot,
      "ACTIVATION_REQUIRED",
      `activation lease does not allow phase ${route.phaseOwner}`,
      "lease.allowed-phase",
      false,
      "human-authorization"
    );
  }
  const activationEvidence = context.humanGateEvidence.find(
    (evidence) =>
      evidence.gate === "activate" &&
      lease.approvedBy === evidence.actor.id &&
      lease.authorizationDigest === evidence.actor.authorizationDigest &&
      authorizeHumanGate({
        gate: "activate",
        policy: context.policy,
        requesterId: context.requesterId,
        workAccordDigest: snapshot.workAccordDigest,
        activationLeaseDigest: digest(lease),
        currentHead: snapshot.currentHead,
        gateEvidence: [evidence],
        evaluatedAt: context.evaluatedAt,
        expectedActor: evidence.actor
      }) === null
  );
  if (activationEvidence === undefined) {
    return refusal(
      snapshot,
      "ACTIVATION_REQUIRED",
      "activation lease is not bound to the current approving human evidence",
      "lease.approver-binding",
      false,
      "human-authorization"
    );
  }
  if (
    !compiled.allowedCapabilities.every((capability) =>
      lease.allowedCapabilities.includes(capability)
    )
  ) {
    return refusal(
      snapshot,
      "ACTIVATION_REQUIRED",
      "activation lease does not allow every compiled capability",
      "lease.allowed-capabilities",
      false,
      "human-authorization"
    );
  }
  if (
    compiled.limits.maxParallel > lease.maxParallel
  ) {
    return refusal(
      snapshot,
      "BUDGET_EXHAUSTED",
      "activation lease parallelism limit would be exceeded",
      "lease.parallel-limit",
      false,
      "human-authorization"
    );
  }
  return null;
}

function validateLeaseCostBudget(
  snapshot: KernelSnapshot,
  event: EventEnvelope,
  route: LifecycleRoute,
  usage: Usage,
  context: KernelContext
): KernelResult | null {
  if (!isCostBearingState(route.to)) {
    if (
      event.cost.calls !== 0 ||
      event.cost.tokens !== 0 ||
      event.cost.costUnits !== 0
    ) {
      return refusal(
        snapshot,
        "BUDGET_EXHAUSTED",
        "non-cost-bearing routes cannot consume calls, tokens, or cost units",
        "budget.non-cost-route",
        false,
        "none"
      );
    }
    return null;
  }
  const lease = context.activationLease;
  if (lease === null) {
    return refusal(
      snapshot,
      "ACTIVATION_REQUIRED",
      "cost-bearing transition has no validated Activation Lease",
      "lease.cost-authority",
      false,
      "human-authorization"
    );
  }
  if (
    usage.calls > lease.maxCalls ||
    usage.tokens > lease.maxTokens ||
    usage.costUnits > lease.maxCostUnits
  ) {
    return refusal(
      snapshot,
      "BUDGET_EXHAUSTED",
      "activation lease budget would be exceeded",
      "lease.remaining-budget",
      false,
      "human-authorization"
    );
  }
  return null;
}

function validateLifetimeBudget(
  snapshot: KernelSnapshot,
  usage: Usage,
  context: KernelContext
): KernelResult | null {
  if (
    usage.calls > context.workAccord.budget.maxCalls ||
    usage.tokens > context.workAccord.budget.maxTokens ||
    usage.costUnits > context.workAccord.budget.maxCostUnits
  ) {
    return refusal(
      snapshot,
      "BUDGET_EXHAUSTED",
      "compiled Work Accord budget would be exceeded",
      "budget.compiled-ceiling",
      false,
      "human-authorization"
    );
  }
  if (usage.loops > context.workAccord.budget.maxLoops) {
    return refusal(
      snapshot,
      "LOOP_LIMIT_EXHAUSTED",
      "compiled loop limit would be exceeded",
      "budget.loop-ceiling",
      false,
      "human-authorization"
    );
  }
  if (usage.retries > context.workAccord.budget.maxRetries) {
    return refusal(
      snapshot,
      "RETRY_LIMIT_EXHAUSTED",
      "compiled retry limit would be exceeded",
      "retry.compiled-ceiling",
      false,
      "human-authorization"
    );
  }
  return null;
}

function validatePhaseBudget(
  snapshot: KernelSnapshot,
  usage: Usage,
  compiled: CompiledPolicy | null
): KernelResult | null {
  if (compiled === null) {
    return null;
  }
  if (
    usage.calls > compiled.limits.maxCalls ||
    usage.tokens > compiled.limits.maxTokens ||
    usage.costUnits > compiled.limits.maxCostUnits
  ) {
    return refusal(
      snapshot,
      "BUDGET_EXHAUSTED",
      "current phase budget would be exceeded",
      "budget.phase-ceiling",
      false,
      "human-authorization"
    );
  }
  if (usage.loops > compiled.limits.maxLoops) {
    return refusal(
      snapshot,
      "LOOP_LIMIT_EXHAUSTED",
      "current phase loop limit would be exceeded",
      "budget.phase-loop-ceiling",
      false,
      "human-authorization"
    );
  }
  if (usage.retries > compiled.limits.maxRetries) {
    return refusal(
      snapshot,
      "RETRY_LIMIT_EXHAUSTED",
      "current phase retry limit would be exceeded",
      "retry.phase-ceiling",
      false,
      "human-authorization"
    );
  }
  return null;
}

function routeAttemptRefusal(
  snapshot: KernelSnapshot,
  event: EventEnvelope,
  route: LifecycleRoute,
  context: KernelContext
): KernelResult | null {
  if (!route.retryable) {
    return null;
  }
  const currentAttempts = Object.hasOwn(snapshot.routeAttempts, route.id)
    ? (snapshot.routeAttempts[route.id] ?? 0)
    : 0;
  const nextAttempts = safeAdd(currentAttempts, 1);
  if (nextAttempts === null) {
    return refusal(
      snapshot,
      "NUMERIC_OVERFLOW",
      "route attempt counter cannot be represented safely",
      "number.safe-integer",
      false,
      "reconcile"
    );
  }
  if (nextAttempts > route.maxAttempts) {
    return refusal(
      snapshot,
      "LOOP_LIMIT_EXHAUSTED",
      `route ${route.id} exceeded its attempt limit`,
      "route.max-attempts",
      false,
      "human-authorization"
    );
  }
  if (event.type === "retry-requested" && !context.retryableFailure) {
    return refusal(
      snapshot,
      "RETRY_NOT_ALLOWED",
      "retry requires a classified retryable failure",
      "retry.classified-failure",
      false,
      "human-authorization"
    );
  }
  return null;
}

function validateAuthorityRebind(
  snapshot: KernelSnapshot,
  event: EventEnvelope,
  context: KernelContext
): AuthorityRebind | KernelResult | null {
  if (event.type !== "binding-revalidated") {
    if (context.rebindAuthority !== null) {
      return refusal(
        snapshot,
        "PROVENANCE_INVALID",
        "replacement authority is only accepted by a binding revalidation event",
        "rebind.dedicated-event",
        false,
        "reconcile"
      );
    }
    return null;
  }
  const replacement = context.rebindAuthority;
  if (replacement === null) {
    return refusal(
      snapshot,
      "CONTRACT_STALE",
      "binding revalidation requires complete replacement authority",
      "rebind.complete-authority",
      false,
      "new-contract"
    );
  }
  if (event.replacementAuthorityDigest !== digest(replacement)) {
    return refusal(
      snapshot,
      "PROVENANCE_INVALID",
      "replacement authority does not match the event-bound authority digest",
      "rebind.event-authority-digest",
      false,
      "reconcile"
    );
  }
  const trustedSource =
    (event.provenance.source === "trusted-adapter" &&
      event.actor.class === "system") ||
    (event.provenance.source === "policy-engine" &&
      event.actor.class === "policy");
  if (!trustedSource) {
    return refusal(
      snapshot,
      "PROVENANCE_INVALID",
      "binding revalidation requires a trusted source and matching trusted actor",
      "rebind.trusted-source",
      false,
      "reconcile"
    );
  }
  const nextRevision = safeAdd(context.workAccord.identity.revision, 1);
  if (
    nextRevision === null ||
    replacement.workAccord.identity.revision !== nextRevision ||
    replacement.workAccord.identity.supersedes !==
      context.workAccord.identity.id ||
    replacement.workAccord.identity.id === context.workAccord.identity.id
  ) {
    return refusal(
      snapshot,
      "CONTRACT_STALE",
      "replacement Work Accord must linearly supersede the current revision",
      "rebind.linear-supersession",
      false,
      "new-contract"
    );
  }
  const expectedBindingDigest = workAccordBindingDigest(replacement.workAccord);
  if (
    replacement.bindingDigest !== expectedBindingDigest ||
    replacement.bindingDigest !== snapshot.bindingDigest ||
    digest(replacement.graph) !==
      replacement.workAccord.binding.lifecycleGraphDigest ||
    digest(replacement.policy) !==
      replacement.workAccord.binding.policyDigest ||
    digest(replacement.registry) !==
      replacement.workAccord.policy.capabilityRegistryDigest ||
    digest(replacement.domainPack) !==
      replacement.workAccord.policy.domainPackDigest ||
    `${replacement.domainPack.id}@${replacement.domainPack.version}` !==
      replacement.workAccord.policy.domainPack
  ) {
    return refusal(
      snapshot,
      "CONTRACT_STALE",
      "replacement authority does not match its exact Work Accord bindings",
      "rebind.exact-bindings",
      false,
      "new-contract"
    );
  }
  if (
    replacement.graph.metadata.version !== snapshot.lifecycleVersion ||
    validateLifecycleGraph(replacement.graph).length > 0
  ) {
    return refusal(
      snapshot,
      "GRAPH_INVALID",
      "replacement lifecycle graph is incompatible or invalid",
      "rebind.lifecycle",
      false,
      "new-contract"
    );
  }
  const contractByPhase = new Map(
    replacement.phaseContracts.map((contract) => [contract.phase, contract])
  );
  if (
    contractByPhase.size !== replacement.phaseContracts.length ||
    contractByPhase.size !==
      Object.keys(replacement.workAccord.policy.phaseContracts).length
  ) {
    return refusal(
      snapshot,
      "CONTRACT_STALE",
      "replacement Phase Contracts must exactly cover each Work Accord binding",
      "rebind.phase-contract-set",
      false,
      "new-contract"
    );
  }
  for (const phase of replacement.phaseContracts) {
    const compilation = compilePolicy({
      enterprise: replacement.policy,
      accord: replacement.workAccord,
      phase,
      domainPack: replacement.domainPack,
      registry: replacement.registry
    });
    if (!compilation.ok) {
      return refusal(
        snapshot,
        "POLICY_ESCALATION",
        compilation.errors.join("; "),
        "rebind.policy-compile",
        false,
        "new-contract"
      );
    }
  }
  return replacement;
}

export function evaluateTransition(
  snapshot: KernelSnapshot,
  rawEvent: EventEnvelope,
  context: KernelContext
): KernelResult {
  const rawRebindAuthority: unknown = context.rebindAuthority;
  if (rawRebindAuthority !== null) {
    let clonedRebind: unknown;
    try {
      clonedRebind = structuredClone(rawRebindAuthority);
      const invalidPath = nonJsonValuePath(clonedRebind);
      if (invalidPath !== null) {
        return refusal(
          snapshot,
          "SCHEMA_INVALID",
          `replacement authority contains a non-JSON value at ${invalidPath}`,
          "boundary.closed-schema",
          false,
          "none"
        );
      }
    } catch (error) {
      return refusal(
        snapshot,
        "SCHEMA_INVALID",
        `replacement authority is not canonical JSON: ${
          error instanceof Error ? error.message : "clone failed"
        }`,
        "boundary.closed-schema",
        false,
        "none"
      );
    }
    const wrapperValidation = validateDocument("AuthorityRebind", clonedRebind);
    if (!wrapperValidation.valid) {
      return refusal(
        snapshot,
        "SCHEMA_INVALID",
        wrapperValidation.errors.join("; "),
        "boundary.closed-schema",
        false,
        "none"
      );
    }
    context = { ...context, rebindAuthority: wrapperValidation.value };
  }
  const currentEventValidation = validateDocument("KernelEvent", rawEvent);
  const schemaChecks = [
    validateDocument("KernelSnapshot", snapshot),
    validateDocument("LifecycleGraph", context.graph),
    validateDocument("WorkAccord", context.workAccord),
    validateDocument("ControlPolicy", context.policy),
    validateDocument("CapabilityRegistry", context.registry),
    validateDocument("DomainPackPolicy", context.domainPack),
    ...context.humanGateEvidence.map((evidence) =>
      validateDocument("HumanGateEvidence", evidence)
    ),
    ...context.contractRequirementEvidence.map((evidence) =>
      validateDocument("ContractRequirementEvidence", evidence)
    ),
    ...(context.currentPhaseContract === null
      ? []
      : [validateDocument("PhaseContract", context.currentPhaseContract)]),
    ...(context.destinationPhaseContract === null
      ? []
      : [validateDocument("PhaseContract", context.destinationPhaseContract)]),
    ...(context.activationLease === null
      ? []
      : [validateDocument("ActivationLease", context.activationLease)]),
    ...(context.rebindAuthority === null
      ? []
      : [
          validateDocument("AuthorityRebind", context.rebindAuthority),
          validateDocument("LifecycleGraph", context.rebindAuthority.graph),
          validateDocument("WorkAccord", context.rebindAuthority.workAccord),
          validateDocument("ControlPolicy", context.rebindAuthority.policy),
          validateDocument(
            "CapabilityRegistry",
            context.rebindAuthority.registry
          ),
          validateDocument(
            "DomainPackPolicy",
            context.rebindAuthority.domainPack
          ),
          ...context.rebindAuthority.phaseContracts.map((contract) =>
            validateDocument("PhaseContract", contract)
          )
        ])
  ];
  const schemaErrors = schemaChecks.flatMap((result) =>
    result.valid ? [] : result.errors
  );
  if (!currentEventValidation.valid) {
    schemaErrors.push(...currentEventValidation.errors);
  }
  if (schemaErrors.length > 0) {
    return refusal(
      snapshot,
      "SCHEMA_INVALID",
      schemaErrors.join("; "),
      "boundary.closed-schema",
      false,
      "none"
    );
  }
  if (!currentEventValidation.valid) {
    return refusal(
      snapshot,
      "SCHEMA_INVALID",
      "event did not validate against a supported version",
      "boundary.closed-schema",
      false,
      "none"
    );
  }
  const event = currentEventValidation.value;

  const eventDigest = digest(event);
  const processed = Object.hasOwn(snapshot.processedEvents, event.id)
    ? snapshot.processedEvents[event.id]
    : undefined;
  if (processed !== undefined) {
    if (
      processed.eventDigest === eventDigest
    ) {
      return {
        kind: "noop",
        reason: "duplicate-event",
        receiptDigest: processed.receiptDigest,
        snapshot
      };
    }
    return refusal(
      snapshot,
      "REPLAY_CONFLICT",
      "event identity was previously observed with different content",
      "replay.event-identity",
      false,
      "reconcile"
    );
  }
  const expectedBindingDigest = workAccordBindingDigest(context.workAccord);
  if (snapshot.bindingDigest !== expectedBindingDigest) {
    return refusal(
      snapshot,
      "CONTRACT_STALE",
      "snapshot binding does not match the Work Accord target identity",
      "binding.work-accord-target",
      false,
      "new-contract"
    );
  }
  if (event.provenance.bindingDigest !== expectedBindingDigest) {
    return refusal(
      snapshot,
      "PROVENANCE_INVALID",
      "event provenance does not match the Work Accord target identity",
      "event.provenance-binding",
      false,
      "reconcile"
    );
  }
  if (
    Object.values(snapshot.processedEvents).some(
      (prior) => prior.deliveryId === event.provenance.deliveryId
    )
  ) {
    return refusal(
      snapshot,
      "REPLAY_CONFLICT",
      "delivery identity was previously observed with a different event identity",
      "replay.delivery-identity",
      false,
      "reconcile"
    );
  }
  if (event.expectedStateVersion !== snapshot.stateVersion) {
    return refusal(
      snapshot,
      "CONCURRENCY_CONFLICT",
      "event expected a different state version",
      "concurrency.compare-and-swap",
      true,
      "reconcile"
    );
  }
  const evaluatedAt = Date.parse(context.evaluatedAt);
  if (
    !isCanonicalUtcDateTime(context.evaluatedAt) ||
    Date.parse(event.occurredAt) > evaluatedAt
  ) {
    return refusal(
      snapshot,
      "PROVENANCE_INVALID",
      "event occurrence time is invalid or later than evaluation time",
      "event.observed-time",
      false,
      "reconcile"
    );
  }
  if (event.sequence <= snapshot.lastEventSequence) {
    return refusal(
      snapshot,
      "REPLAY_OUT_OF_ORDER",
      "event sequence is stale or reordered",
      "replay.monotonic-sequence",
      false,
      "reconcile"
    );
  }
  if (event.provenance.payloadDigest !== eventPayloadDigest(event)) {
    return refusal(
      snapshot,
      "PROVENANCE_INVALID",
      "event provenance does not match its trusted binding or payload",
      "event.provenance-binding",
      false,
      "reconcile"
    );
  }

  const graphDigest = digest(context.graph);
  if (validateLifecycleGraph(context.graph).length > 0) {
    return refusal(
      snapshot,
      "GRAPH_INVALID",
      "lifecycle graph failed semantic validation",
      "graph.semantic-validity",
      false,
      "none"
    );
  }
  if (context.graph.metadata.version !== snapshot.lifecycleVersion) {
    return refusal(
      snapshot,
      "UNKNOWN_VERSION",
      "lifecycle version is not current",
      "contract.known-version",
      false,
      "new-contract"
    );
  }
  if (
    graphDigest !== snapshot.lifecycleGraphDigest ||
    graphDigest !== context.workAccord.binding.lifecycleGraphDigest
  ) {
    return refusal(
      snapshot,
      "CONTRACT_STALE",
      "lifecycle graph does not match the bound authority digest",
      "lifecycle.exact-digest",
      false,
      "new-contract"
    );
  }
  const snapshotLifecycleErrors = validateSnapshotLifecycleSemantics(
    snapshot,
    context.graph
  );
  if (snapshotLifecycleErrors.length > 0) {
    return refusal(
      snapshot,
      "CONTRACT_STALE",
      snapshotLifecycleErrors.map((error) => error.message).join("; "),
      "snapshot.lifecycle-authority",
      false,
      "new-contract"
    );
  }
  if (
    digest(context.workAccord) !== snapshot.workAccordDigest ||
    context.workAccord.binding.policyDigest !== snapshot.policyDigest ||
    digest(context.policy) !== snapshot.policyDigest ||
    context.workAccord.policy.capabilityRegistryDigest !==
      snapshot.capabilityRegistryDigest ||
    digest(context.registry) !== snapshot.capabilityRegistryDigest ||
    context.workAccord.policy.domainPackDigest !== snapshot.domainPackDigest ||
    digest(context.domainPack) !== snapshot.domainPackDigest
  ) {
    return refusal(
      snapshot,
      "CONTRACT_STALE",
      "Work Accord or control policy does not match the snapshot",
      "contract.current-digests",
      false,
      "new-contract"
    );
  }
  if (context.workAccord.binding.currentHead !== snapshot.currentHead) {
    return refusal(
      snapshot,
      "CURRENT_HEAD_STALE",
      "Work Accord does not bind the current snapshot head",
      "binding.current-head",
      false,
      "reconcile"
    );
  }

  const current = currentAuthority(
    snapshot,
    context,
    !allowsNullPhaseAuthority(snapshot.state)
  );
  if (current !== null && "code" in current) {
    return { kind: "refused", refusal: current, snapshot };
  }

  const route = selectRoute(
    context.graph,
    snapshot.state,
    event.type,
    snapshot.suspendedState,
    snapshot.recoveryState
  );
  if (route === null) {
    return refusal(
      snapshot,
      "INVALID_TRANSITION",
      `event ${event.type} is invalid from ${snapshot.state}`,
      "lifecycle.allowed-route",
      false,
      "none"
    );
  }
  if (route === "ambiguous") {
    return refusal(
      snapshot,
      "AMBIGUOUS_ROUTE",
      "more than one deterministic route matched",
      "lifecycle.unique-route",
      false,
      "none"
    );
  }

  const destination = destinationAuthority(snapshot, route, current, context);
  if (destination !== null && "kind" in destination) {
    return destination;
  }
  const effectivePolicy = destination?.compiled ?? current?.compiled ?? null;
  const enteringNewPhase =
    destination !== null &&
    (current === null ||
      destination.contract.phase !== current.contract.phase);
  const routeAuthorityClass = classifyRouteAuthority(route);

  const leaseAuthorityRefusal = validateLeaseAuthority(
    snapshot,
    route,
    effectivePolicy,
    context
  );
  if (leaseAuthorityRefusal !== null) {
    return leaseAuthorityRefusal;
  }

  const phaseRequirementRefusal = validatePhaseRequirements({
    snapshot,
    event,
    route,
    current,
    destination,
    context
  });
  if (phaseRequirementRefusal !== null) {
    return phaseRequirementRefusal;
  }

  const actorRefusal = authorizeActor({
    actor: event.actor,
    route,
    policy: context.policy,
    requesterId: context.requesterId,
    workAccordDigest: snapshot.workAccordDigest,
    activationLeaseDigest:
      context.activationLease === null ? null : digest(context.activationLease),
    currentHead: snapshot.currentHead,
    gateEvidence: context.humanGateEvidence,
    evaluatedAt: context.evaluatedAt
  });
  if (actorRefusal !== null) {
    return { kind: "refused", refusal: actorRefusal, snapshot };
  }
  const rebind = validateAuthorityRebind(snapshot, event, context);
  if (rebind !== null && rebind.kind !== "AuthorityRebind") {
    return rebind;
  }
  if (routeAuthorityClass !== "kernel-safety") {
    const compiledPolicies = [
      current?.compiled ?? null,
      destination?.compiled ?? null
    ].filter(
      (compiled, index, all): compiled is CompiledPolicy =>
        compiled !== null &&
        all.findIndex((candidate) => candidate?.digest === compiled.digest) ===
          index
    );
    for (const compiled of compiledPolicies) {
      const compiledGateRefusal = validateCompiledCapabilityAuthority(
        snapshot,
        compiled,
        context
      );
      if (compiledGateRefusal !== null) {
        return compiledGateRefusal;
      }
    }
  }
  const attemptRefusal = routeAttemptRefusal(snapshot, event, route, context);
  if (attemptRefusal !== null) {
    return attemptRefusal;
  }
  const usage = addUsage(snapshot.usage, event);
  const phaseUsage = addUsage(
    enteringNewPhase ? EMPTY_USAGE : snapshot.phaseUsage,
    event
  );
  const nextStateVersion = safeAdd(snapshot.stateVersion, 1);
  if (usage === null || phaseUsage === null || nextStateVersion === null) {
    return refusal(
      snapshot,
      "NUMERIC_OVERFLOW",
      "state or usage arithmetic cannot be represented safely",
      "number.safe-integer",
      false,
      "reconcile"
    );
  }
  const lifetimeBudgetRefusal = validateLifetimeBudget(
    snapshot,
    usage,
    rebind === null
      ? context
      : { ...context, workAccord: rebind.workAccord }
  );
  if (lifetimeBudgetRefusal !== null) {
    return lifetimeBudgetRefusal;
  }
  const phaseBudgetRefusal = validatePhaseBudget(
    snapshot,
    phaseUsage,
    effectivePolicy
  );
  if (phaseBudgetRefusal !== null) {
    return phaseBudgetRefusal;
  }
  const leaseBudgetRefusal = validateLeaseCostBudget(
    snapshot,
    event,
    route,
    usage,
    context
  );
  if (leaseBudgetRefusal !== null) {
    return leaseBudgetRefusal;
  }

  const idempotencyKey = digest({
    bindingDigest: snapshot.bindingDigest,
    eventId: event.id,
    lifecycleGraphDigest: snapshot.lifecycleGraphDigest,
    replacementAuthorityDigest: event.replacementAuthorityDigest,
    workAccordDigest: snapshot.workAccordDigest,
    routeId: route.id,
    stateVersion: snapshot.stateVersion
  });
  const effects: KernelEffect[] = [{ type: "emit-receipt", eventId: event.id }];
  if (destination !== null && isActivePhaseOwner(route.phaseOwner)) {
    effects.push({
      type: "enter-phase",
      phase: route.phaseOwner,
      capabilities: destination.compiled.capabilities
    });
  }
  if (
    event.type === "dependency-blocked" ||
    event.type === "partial-effect-recorded"
  ) {
    effects.push({ type: "request-reconciliation", reason: event.type });
  }
  const effectPlanDigest = digest(effects);
  const sourcePhaseContractDigest = snapshot.phaseContractDigest;
  const sourceCompiledPolicyDigest = snapshot.compiledPolicyDigest;
  const destinationPhaseContractDigest =
    destination === null ? null : digest(destination.contract);
  const destinationCompiledPolicyDigest =
    destination === null
      ? null
      : computeCompiledPolicyDigest(destination.compiled);
  const destinationBindingDigest =
    rebind?.bindingDigest ?? snapshot.bindingDigest;
  const destinationLifecycleGraphDigest =
    rebind === null ? snapshot.lifecycleGraphDigest : digest(rebind.graph);
  const destinationWorkAccordDigest =
    rebind === null ? snapshot.workAccordDigest : digest(rebind.workAccord);
  const destinationCapabilityRegistryDigest =
    rebind === null ? snapshot.capabilityRegistryDigest : digest(rebind.registry);
  const destinationDomainPackDigest =
    rebind === null ? snapshot.domainPackDigest : digest(rebind.domainPack);
  const destinationPolicyDigest =
    rebind === null ? snapshot.policyDigest : digest(rebind.policy);
  const receipt: TransitionReceipt = {
    schemaVersion: "1.0.0",
    eventId: event.id,
    eventDigest,
    routeId: route.id,
    routeVersion: route.version,
    from: route.from,
    to: route.to,
    stateVersion: nextStateVersion,
    previousReceipt: snapshot.receiptHead,
    idempotencyKey,
    replacementAuthorityDigest: event.replacementAuthorityDigest,
    bindingDigest: snapshot.bindingDigest,
    lifecycleGraphDigest: snapshot.lifecycleGraphDigest,
    workAccordDigest: snapshot.workAccordDigest,
    capabilityRegistryDigest: snapshot.capabilityRegistryDigest,
    domainPackDigest: snapshot.domainPackDigest,
    destinationBindingDigest,
    destinationLifecycleGraphDigest,
    destinationWorkAccordDigest,
    destinationCapabilityRegistryDigest,
    destinationDomainPackDigest,
    sourcePhaseContractDigest,
    sourceCompiledPolicyDigest,
    destinationPhaseContractDigest,
    destinationCompiledPolicyDigest,
    policyDigest: snapshot.policyDigest,
    destinationPolicyDigest,
    actorId: event.actor.id,
    actorAuthorizationDigest: event.actor.authorizationDigest,
    occurredAt: event.occurredAt,
    effectPlanDigest
  };
  const receiptDigest = digest(receipt);
  const currentAttempt = Object.hasOwn(snapshot.routeAttempts, route.id)
    ? (snapshot.routeAttempts[route.id] ?? 0)
    : 0;
  const nextAttempt = route.retryable ? safeAdd(currentAttempt, 1) : null;
  if (route.retryable && nextAttempt === null) {
    return refusal(
      snapshot,
      "NUMERIC_OVERFLOW",
      "route attempt arithmetic cannot be represented safely",
      "number.safe-integer",
      false,
      "reconcile"
    );
  }
  const nextSnapshot: KernelSnapshot = {
    ...snapshot,
    state: route.to,
    phaseOwner: route.phaseOwner,
    stateVersion: nextStateVersion,
    lastEventSequence: event.sequence,
    bindingDigest: destinationBindingDigest,
    workAccordDigest: destinationWorkAccordDigest,
    capabilityRegistryDigest: destinationCapabilityRegistryDigest,
    domainPackDigest: destinationDomainPackDigest,
    policyDigest: destinationPolicyDigest,
    lifecycleGraphDigest: destinationLifecycleGraphDigest,
    currentHead:
      rebind === null ? snapshot.currentHead : rebind.workAccord.binding.currentHead,
    phaseContractDigest: destinationPhaseContractDigest,
    compiledPolicyDigest: destinationCompiledPolicyDigest,
    receiptHead: receiptDigest,
    suspendedState:
      route.to === "PAUSED"
        ? route.from
        : route.from === "PAUSED"
          ? null
          : snapshot.suspendedState,
    recoveryState:
      route.to === "BLOCKED"
        ? route.from
        : route.from === "BLOCKED"
          ? null
          : snapshot.recoveryState,
    usage,
    phaseUsage,
    routeAttempts:
      route.retryable && nextAttempt !== null
        ? { ...snapshot.routeAttempts, [route.id]: nextAttempt }
        : snapshot.routeAttempts,
    processedEvents: {
      ...snapshot.processedEvents,
      [event.id]: {
        eventDigest,
        receiptDigest,
        idempotencyKey,
        deliveryId: event.provenance.deliveryId
      }
    }
  };
  const nextSchema = validateDocument("KernelSnapshot", nextSnapshot);
  const nextSchemaErrors = nextSchema.valid ? [] : nextSchema.errors;
  const nextLifecycleErrors = validateSnapshotLifecycleSemantics(
    nextSnapshot,
    rebind?.graph ?? context.graph
  );
  if (nextSchemaErrors.length > 0 || nextLifecycleErrors.length > 0) {
    return refusal(
      snapshot,
      "GRAPH_INVALID",
      [
        ...nextSchemaErrors,
        ...nextLifecycleErrors.map((error) => error.message)
      ].join("; "),
      "snapshot.next-validity",
      false,
      "reconcile"
    );
  }
  return {
    kind: "applied",
    route,
    snapshot: nextSnapshot,
    receipt,
    receiptDigest,
    effects
  };
}
