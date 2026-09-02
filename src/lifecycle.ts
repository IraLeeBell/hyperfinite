import type {
  ActivePhaseOwner,
  EventType,
  KernelSnapshot,
  LifecycleGraph,
  LifecycleRoute,
  LifecycleState,
  PhaseOwner
} from "./types.js";

export const ACTIVE_PHASE_OWNERS = [
  "framing",
  "planning",
  "execution",
  "verification",
  "human-review"
] as const satisfies readonly ActivePhaseOwner[];

const ACTIVE_PHASE_OWNER_SET = new Set<unknown>(ACTIVE_PHASE_OWNERS);

const STATE_INVARIANTS: Readonly<
  Record<
    LifecycleState,
    {
      readonly phaseOwner: PhaseOwner;
      readonly costBearing: boolean;
      readonly terminal: boolean;
    }
  >
> = {
  CAPTURED: { phaseOwner: "intake", costBearing: false, terminal: false },
  ACTIVATION_PENDING: {
    phaseOwner: "kernel",
    costBearing: false,
    terminal: false
  },
  FRAMING: { phaseOwner: "framing", costBearing: true, terminal: false },
  PLANNED: { phaseOwner: "planning", costBearing: false, terminal: false },
  EXECUTING: { phaseOwner: "execution", costBearing: true, terminal: false },
  VERIFYING: { phaseOwner: "verification", costBearing: true, terminal: false },
  HUMAN_REVIEW: {
    phaseOwner: "human-review",
    costBearing: false,
    terminal: false
  },
  COMPLETED: { phaseOwner: "kernel", costBearing: false, terminal: true },
  PAUSED: { phaseOwner: "kernel", costBearing: false, terminal: false },
  BLOCKED: { phaseOwner: "kernel", costBearing: false, terminal: false },
  CANCELLED: { phaseOwner: "kernel", costBearing: false, terminal: true }
};

const TERMINAL_STATES = new Set<LifecycleState>(["COMPLETED", "CANCELLED"]);

const NULL_AUTHORITY_STATES = new Set<LifecycleState>([
  "CAPTURED",
  "ACTIVATION_PENDING",
  "CANCELLED"
]);

const KERNEL_SAFETY_DESTINATIONS: Readonly<
  Partial<Record<EventType, LifecycleState>>
> = {
  "cancel-requested": "CANCELLED",
  "pause-requested": "PAUSED",
  "dependency-blocked": "BLOCKED",
  "partial-effect-recorded": "BLOCKED",
  "authorization-invalidated": "ACTIVATION_PENDING"
};

export type RouteAuthorityClass =
  | "active-phase"
  | "kernel-safety"
  | "kernel-control";

export function classifyRouteAuthority(
  route: LifecycleRoute
): RouteAuthorityClass {
  if (isActivePhaseOwner(route.phaseOwner)) {
    return "active-phase";
  }
  return KERNEL_SAFETY_DESTINATIONS[route.event] === route.to
    ? "kernel-safety"
    : "kernel-control";
}

export function isActivePhaseOwner(
  owner: unknown
): owner is ActivePhaseOwner {
  return ACTIVE_PHASE_OWNER_SET.has(owner);
}

export function isCostBearingState(state: LifecycleState): boolean {
  return STATE_INVARIANTS[state].costBearing;
}

export function isCostBearingPhaseOwner(owner: ActivePhaseOwner): boolean {
  return owner === "framing" || owner === "execution" || owner === "verification";
}

export function allowsNullPhaseAuthority(state: LifecycleState): boolean {
  return NULL_AUTHORITY_STATES.has(state);
}

export interface LifecycleGraphError {
  readonly path: string;
  readonly message: string;
}

export interface SnapshotLifecycleError {
  readonly path: string;
  readonly message: string;
}

export function validateSnapshotLifecycleSemantics(
  snapshot: KernelSnapshot,
  graph: LifecycleGraph
): readonly SnapshotLifecycleError[] {
  const errors: SnapshotLifecycleError[] = [];
  const state = graph.states.find((candidate) => candidate.id === snapshot.state);
  if (state === undefined) {
    return [{ path: "/state", message: "snapshot state is not declared by the lifecycle" }];
  }
  if (snapshot.phaseOwner !== state.phaseOwner) {
    errors.push({
      path: "/phaseOwner",
      message: `snapshot phase owner must match lifecycle state ${snapshot.state}`
    });
  }
  const hasContract = snapshot.phaseContractDigest !== null;
  const hasPolicy = snapshot.compiledPolicyDigest !== null;
  if (hasContract !== hasPolicy) {
    errors.push({
      path: "/phaseContractDigest",
      message: "snapshot phase contract and compiled policy must be bound together"
    });
  }
  if (!hasContract && !allowsNullPhaseAuthority(snapshot.state)) {
    errors.push({
      path: "/phaseContractDigest",
      message: `snapshot state ${snapshot.state} requires bound phase authority`
    });
  }
  if (hasContract && allowsNullPhaseAuthority(snapshot.state)) {
    errors.push({
      path: "/phaseContractDigest",
      message: `snapshot state ${snapshot.state} requires null phase authority`
    });
  }
  const retainedState =
    snapshot.state === "PAUSED"
      ? snapshot.suspendedState
      : snapshot.state === "BLOCKED"
        ? snapshot.recoveryState
        : null;
  if (
    (snapshot.state === "PAUSED" || snapshot.state === "BLOCKED") &&
    retainedState === null
  ) {
    errors.push({
      path: snapshot.state === "PAUSED" ? "/suspendedState" : "/recoveryState",
      message: `${snapshot.state} requires its retained active state`
    });
  } else if (retainedState !== null) {
    const retained = graph.states.find((candidate) => candidate.id === retainedState);
    if (
      retained === undefined ||
      retained.phaseOwner === "kernel" ||
      retained.phaseOwner === "intake"
    ) {
      errors.push({
        path: snapshot.state === "PAUSED" ? "/suspendedState" : "/recoveryState",
        message: `${snapshot.state} must retain an active phase-owned state`
      });
    }
  }
  return errors;
}

export function validateLifecycleGraph(
  graph: LifecycleGraph
): readonly LifecycleGraphError[] {
  const errors: LifecycleGraphError[] = [];
  const stateIds = new Set<LifecycleState>();
  const routeIds = new Set<string>();
  const routeKeys = new Map<string, LifecycleRoute[]>();

  graph.states.forEach((state, index) => {
    if (stateIds.has(state.id)) {
      errors.push({
        path: `/states/${index}/id`,
        message: `duplicate state ${state.id}`
      });
    }
    stateIds.add(state.id);
    const expected = STATE_INVARIANTS[state.id];
    if (state.phaseOwner !== expected.phaseOwner) {
      errors.push({
        path: `/states/${index}/phaseOwner`,
        message: `state ${state.id} must remain owned by ${expected.phaseOwner}`
      });
    }
    if (state.costBearing !== expected.costBearing) {
      errors.push({
        path: `/states/${index}/costBearing`,
        message: `state ${state.id} has an invalid cost-bearing declaration`
      });
    }
    if (state.terminal !== expected.terminal) {
      errors.push({
        path: `/states/${index}/terminal`,
        message: `state ${state.id} has an invalid terminal declaration`
      });
    }
  });
  for (const state of Object.keys(STATE_INVARIANTS) as LifecycleState[]) {
    if (!stateIds.has(state)) {
      errors.push({
        path: "/states",
        message: `lifecycle must declare conventional state ${state}`
      });
    }
  }

  graph.routes.forEach((route, index) => {
    if (routeIds.has(route.id)) {
      errors.push({
        path: `/routes/${index}/id`,
        message: `duplicate route ${route.id}`
      });
    }
    routeIds.add(route.id);
    if (!stateIds.has(route.from) || !stateIds.has(route.to)) {
      errors.push({
        path: `/routes/${index}`,
        message: "route references an undeclared state"
      });
    }
    if (route.to === "CAPTURED") {
      errors.push({
        path: `/routes/${index}/to`,
        message: "CAPTURED is initial-only and cannot be re-entered"
      });
    }
    const destination = graph.states.find((state) => state.id === route.to);
    if (destination !== undefined && route.phaseOwner !== destination.phaseOwner) {
      errors.push({
        path: `/routes/${index}/phaseOwner`,
        message: `route phase owner must match destination ${route.to}`
      });
    }
    if (route.costBearing !== isCostBearingState(route.to)) {
      errors.push({
        path: `/routes/${index}/costBearing`,
        message: `route cost-bearing declaration must be derived from destination ${route.to}`
      });
    }
    const safetyDestination = KERNEL_SAFETY_DESTINATIONS[route.event];
    if (safetyDestination !== undefined && route.to !== safetyDestination) {
      errors.push({
        path: `/routes/${index}/to`,
        message: `safety event ${route.event} must enter ${safetyDestination}`
      });
    }
    if (
      route.event === "binding-revalidated" &&
      (route.from !== "ACTIVATION_PENDING" ||
        route.to !== "ACTIVATION_PENDING" ||
        route.phaseOwner !== "kernel" ||
        route.actorClasses.some(
          (actorClass) => actorClass !== "system" && actorClass !== "policy"
        ))
    ) {
      errors.push({
        path: `/routes/${index}`,
        message:
          "binding revalidation must be a trusted ACTIVATION_PENDING kernel self-transition"
      });
    }
    if (
      classifyRouteAuthority(route) === "kernel-safety" &&
      route.humanGate !== null
    ) {
      errors.push({
        path: `/routes/${index}/humanGate`,
        message: "kernel safety routes cannot require a human gate"
      });
    }
    if (route.to === "PAUSED" || route.to === "BLOCKED") {
      const source = graph.states.find((state) => state.id === route.from);
      if (
        source === undefined ||
        source.phaseOwner === "kernel" ||
        source.phaseOwner === "intake"
      ) {
        errors.push({
          path: `/routes/${index}/from`,
          message: `${route.to} can only retain an active phase-owned state`
        });
      }
    }
    const source = graph.states.find((state) => state.id === route.from);
    if (TERMINAL_STATES.has(route.from) || source?.terminal === true) {
      errors.push({
        path: `/routes/${index}/from`,
        message: `terminal state ${route.from} cannot have outgoing routes`
      });
    }
    const key = `${route.from}:${route.event}`;
    const routes = routeKeys.get(key) ?? [];
    routes.push(route);
    routeKeys.set(key, routes);
  });

  for (const [key, routes] of routeKeys) {
    if (
      routes.length > 1 &&
      !key.startsWith("PAUSED:resume-requested") &&
      !key.startsWith("BLOCKED:retry-requested") &&
      !key.startsWith("BLOCKED:recovery-approved")
    ) {
      errors.push({
        path: "/routes",
        message: `ambiguous deterministic route set ${key}`
      });
    }
  }

  if (!stateIds.has("CAPTURED")) {
    errors.push({ path: "/states", message: "CAPTURED state is required" });
  }
  if (!stateIds.has("COMPLETED") || !stateIds.has("CANCELLED")) {
    errors.push({
      path: "/states",
      message: "COMPLETED and CANCELLED terminal states are required"
    });
  }

  return errors;
}

export function selectRoute(
  graph: LifecycleGraph,
  state: LifecycleState,
  event: LifecycleRoute["event"],
  resumeState: LifecycleState | null,
  recoveryState: LifecycleState | null
): LifecycleRoute | null | "ambiguous" {
  let candidates = graph.routes.filter(
    (route) => route.from === state && route.event === event
  );
  if (state === "PAUSED" && event === "resume-requested") {
    candidates = candidates.filter((route) => route.to === resumeState);
  }
  if (
    state === "BLOCKED" &&
    (event === "retry-requested" || event === "recovery-approved")
  ) {
    candidates = candidates.filter((route) => route.to === recoveryState);
  }
  if (candidates.length === 0) {
    return null;
  }
  if (candidates.length > 1) {
    return "ambiguous";
  }
  return candidates[0] ?? null;
}
