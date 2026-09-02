import type {
  Actor,
  ControlPolicy,
  Digest,
  HumanGateEvidence,
  KernelRefusal,
  LifecycleRoute
} from "./types.js";

function refusal(
  code: KernelRefusal["code"],
  message: string,
  ruleId: string,
  recovery: KernelRefusal["recovery"]
): KernelRefusal {
  return { code, message, ruleId, retryable: false, recovery };
}

function authorizeIdentity(
  policy: ControlPolicy,
  actor: Actor
): KernelRefusal | null {
  const actorRule = policy.actorRules.find(
    (candidate) => candidate.actorClass === actor.class
  );
  if (actorRule === undefined) {
    return refusal(
      "UNAUTHORIZED_ACTOR",
      `no policy rule exists for actor class ${actor.class}`,
      "actor.known-class",
      "human-authorization"
    );
  }
  if (actorRule.human !== actor.human || (actorRule.human && actor.bot)) {
    return refusal(
      "UNAUTHORIZED_ACTOR",
      "human and bot identity attributes do not satisfy actor policy",
      "actor.identity-kind",
      "human-authorization"
    );
  }
  if (!actorRule.requiredRoles.every((role) => actor.roles.includes(role))) {
    return refusal(
      "UNAUTHORIZED_ACTOR",
      "actor is missing a currently required role",
      "actor.current-role",
      "human-authorization"
    );
  }
  return null;
}

export function authorizeHumanGate(input: {
  readonly gate: string;
  readonly policy: ControlPolicy;
  readonly requesterId: string;
  readonly workAccordDigest: Digest;
  readonly activationLeaseDigest: Digest | null;
  readonly currentHead: Digest | null;
  readonly gateEvidence: readonly HumanGateEvidence[];
  readonly evaluatedAt: string;
  readonly expectedActor: Actor | null;
}): KernelRefusal | null {
  const candidates = input.gateEvidence.filter(
    (candidate) =>
      candidate.gate === input.gate &&
      (input.expectedActor === null ||
        (candidate.actor.id === input.expectedActor.id &&
          candidate.actor.authorizationDigest ===
            input.expectedActor.authorizationDigest))
  );
  if (candidates.length === 0) {
    return refusal(
      "HUMAN_GATE_MISSING",
      `evidence for gate ${input.gate} is required`,
      "gate.valid-evidence",
      "human-authorization"
    );
  }
  const refusals: KernelRefusal[] = [];
  for (const evidence of candidates) {
    const candidateRefusal = validateHumanGateEvidence(input, evidence);
    if (candidateRefusal === null) {
      return null;
    }
    refusals.push(candidateRefusal);
  }
  return (
    refusals[0] ??
    refusal(
      "HUMAN_GATE_MISSING",
      `valid evidence for gate ${input.gate} is required`,
      "gate.valid-evidence",
      "human-authorization"
    )
  );
}

function validateHumanGateEvidence(
  input: Parameters<typeof authorizeHumanGate>[0],
  evidence: HumanGateEvidence
): KernelRefusal | null {
  if (!evidence.valid) {
    return refusal(
      "HUMAN_GATE_MISSING",
      `valid evidence for gate ${input.gate} is required`,
      "gate.valid-evidence",
      "human-authorization"
    );
  }
  const identityRefusal = authorizeIdentity(input.policy, evidence.actor);
  if (identityRefusal !== null || !evidence.actor.human || evidence.actor.bot) {
    return (
      identityRefusal ??
      refusal(
        "UNAUTHORIZED_ACTOR",
        "human gate evidence must identify an authorized human",
        "gate.human-actor",
        "human-authorization"
      )
    );
  }
  if (
    input.policy.independentGates.includes(input.gate) &&
    evidence.actor.id === input.requesterId
  ) {
    return refusal(
      "INDEPENDENCE_REQUIRED",
      `gate ${input.gate} requires an actor independent from the requester`,
      "gate.independent-actor",
      "human-authorization"
    );
  }
  const observedAt = Date.parse(evidence.observedAt);
  const expiresAt = Date.parse(evidence.expiresAt);
  const evaluatedAt = Date.parse(input.evaluatedAt);
  if (
    !Number.isFinite(observedAt) ||
    !Number.isFinite(expiresAt) ||
    !Number.isFinite(evaluatedAt) ||
    observedAt > evaluatedAt ||
    evaluatedAt >= expiresAt
  ) {
    return refusal(
      "HUMAN_GATE_STALE",
      "human gate evidence is expired or has an invalid observation time",
      "gate.current-time",
      "human-authorization"
    );
  }
  if (evidence.workAccordDigest !== input.workAccordDigest) {
    return refusal(
      "HUMAN_GATE_STALE",
      "human gate evidence is bound to a different Work Accord",
      "gate.current-accord",
      "human-authorization"
    );
  }
  if (
    input.gate === "activate" &&
    (input.activationLeaseDigest === null ||
      evidence.activationLeaseDigest !== input.activationLeaseDigest)
  ) {
    return refusal(
      "HUMAN_GATE_STALE",
      "activation evidence is not bound to the exact Activation Lease",
      "gate.current-activation-lease",
      "human-authorization"
    );
  }
  if (
    input.gate === "approve-current-head" &&
    (input.currentHead === null || evidence.currentHead !== input.currentHead)
  ) {
    return refusal(
      "CURRENT_HEAD_STALE",
      "human gate evidence is not bound to the current head",
      "gate.current-head",
      "human-authorization"
    );
  }
  return null;
}

export function authorizeActor(input: {
  readonly actor: Actor;
  readonly route: LifecycleRoute;
  readonly policy: ControlPolicy;
  readonly requesterId: string;
  readonly workAccordDigest: Digest;
  readonly activationLeaseDigest: Digest | null;
  readonly currentHead: Digest | null;
  readonly gateEvidence: readonly HumanGateEvidence[];
  readonly evaluatedAt: string;
}): KernelRefusal | null {
  if (!input.route.actorClasses.includes(input.actor.class)) {
    return refusal(
      "UNAUTHORIZED_ACTOR",
      `actor class ${input.actor.class} cannot use route ${input.route.id}`,
      "actor.route-class",
      "human-authorization"
    );
  }
  const identityRefusal = authorizeIdentity(input.policy, input.actor);
  if (identityRefusal !== null || input.route.humanGate === null) {
    return identityRefusal;
  }
  return authorizeHumanGate({
    gate: input.route.humanGate,
    policy: input.policy,
    requesterId: input.requesterId,
    workAccordDigest: input.workAccordDigest,
    activationLeaseDigest: input.activationLeaseDigest,
    currentHead: input.currentHead,
    gateEvidence: input.gateEvidence,
    evaluatedAt: input.evaluatedAt,
    expectedActor: input.actor
  });
}
