import { digest } from "./canonical.js";
import {
  isActivePhaseOwner,
  isCostBearingPhaseOwner
} from "./lifecycle.js";
import {
  resolveCapability,
  validateClosedSchemaDialect,
  validateRegistrySemantics
} from "./registry.js";
import type {
  CapabilityRegistry,
  CompiledCapabilityGrant,
  ControlPolicy,
  Digest,
  DomainPackPolicy,
  PhaseContract,
  RefusalCode,
  WorkAccord
} from "./types.js";
import { validateDocument } from "./validation.js";

const DEPTH_ORDER = ["D0", "D1", "D2", "D3"] as const;
const RISK_ORDER = ["low", "moderate", "high", "critical"] as const;
const PRIVACY_ORDER = ["public", "internal", "confidential", "restricted"] as const;

export interface CompiledPolicy {
  readonly digest: Digest;
  readonly phase: PhaseContract["phase"];
  readonly allowedCapabilities: readonly string[];
  readonly capabilities: readonly CompiledCapabilityGrant[];
  readonly requiredHumanGates: readonly string[];
  readonly limits: {
    readonly maxCalls: number;
    readonly maxTokens: number;
    readonly maxCostUnits: number;
    readonly maxLoops: number;
    readonly maxRetries: number;
    readonly maxParallel: number;
  };
}

export interface PolicyCompilationFailure {
  readonly ok: false;
  readonly code: RefusalCode;
  readonly errors: readonly string[];
}

export interface PolicyCompilationSuccess {
  readonly ok: true;
  readonly policy: CompiledPolicy;
}

export function computeCompiledPolicyDigest(
  policy: Omit<CompiledPolicy, "digest"> | CompiledPolicy
): Digest {
  const {
    phase,
    allowedCapabilities,
    capabilities,
    requiredHumanGates,
    limits
  } = policy;
  return digest({
    phase,
    allowedCapabilities,
    capabilities,
    requiredHumanGates,
    limits
  });
}

function rank<T extends string>(value: T, values: readonly T[]): number {
  return values.indexOf(value);
}

function isSubset(left: readonly string[], right: readonly string[]): boolean {
  const allowed = new Set(right);
  return left.every((item) => allowed.has(item));
}

function schemaErrors(
  kind:
    | "ControlPolicy"
    | "WorkAccord"
    | "PhaseContract"
    | "DomainPackPolicy"
    | "CapabilityRegistry",
  value: unknown
): readonly string[] {
  const result = validateDocument(kind, value);
  return result.valid ? [] : result.errors.map((error) => `${kind}: ${error}`);
}

export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compilePolicy(input: {
  readonly enterprise: ControlPolicy;
  readonly accord: WorkAccord;
  readonly phase: PhaseContract;
  readonly domainPack: DomainPackPolicy;
  readonly registry: CapabilityRegistry;
}): PolicyCompilationSuccess | PolicyCompilationFailure {
  const { enterprise, accord, phase, domainPack, registry } = input;
  const schemaValidationErrors: string[] = [
    ...schemaErrors("ControlPolicy", enterprise),
    ...schemaErrors("WorkAccord", accord),
    ...schemaErrors("PhaseContract", phase),
    ...schemaErrors("DomainPackPolicy", domainPack),
    ...schemaErrors("CapabilityRegistry", registry)
  ];
  if (schemaValidationErrors.length > 0) {
    return {
      ok: false,
      code: "POLICY_ESCALATION",
      errors: schemaValidationErrors
    };
  }

  const errors: string[] = [
    ...validateRegistrySemantics(registry).map(
      (error) => `${error.path}: ${error.message}`
    ),
    ...validateClosedSchemaDialect({
      schema: phase.inputSchema,
      path: "/phase/inputSchema",
      targetFreeOutput: false
    }).map((error) => `${error.path}: ${error.message}`),
    ...validateClosedSchemaDialect({
      schema: phase.outputSchema,
      path: "/phase/outputSchema",
      targetFreeOutput: phase.allowedCapabilities.length > 0
    }).map((error) => `${error.path}: ${error.message}`)
  ];

  if (!isActivePhaseOwner(phase.phase)) {
    errors.push("Phase Contracts are restricted to approved active phases");
  }
  if (accord.binding.policyDigest !== digest(enterprise)) {
    errors.push("Work Accord binding does not reference the loaded enterprise policy");
  }
  if (accord.policy.domainPack !== `${domainPack.id}@${domainPack.version}`) {
    errors.push("Work Accord domain pack reference does not match the loaded Domain Pack");
  }
  if (accord.policy.domainPackDigest !== digest(domainPack)) {
    errors.push("Work Accord does not bind the exact loaded Domain Pack");
  }
  if (accord.policy.capabilityRegistryDigest !== digest(registry)) {
    errors.push("Work Accord does not bind the exact loaded Capability Registry");
  }
  const phaseBinding = accord.policy.phaseContracts[phase.phase];
  if (
    phaseBinding === undefined ||
    phaseBinding.reference !== `${phase.identity.id}@${phase.identity.version}` ||
    phaseBinding.digest !== digest(phase)
  ) {
    errors.push("Phase Contract does not match the exact Work Accord phase binding");
  }
  if (phase.compatibleLifecycleDigest !== accord.binding.lifecycleGraphDigest) {
    errors.push("Phase Contract and Work Accord bind different lifecycle graphs");
  }
  if (
    rank(accord.policy.depthProfile, DEPTH_ORDER) >
      rank(enterprise.ceilings.depthProfile, DEPTH_ORDER) ||
    rank(accord.policy.depthProfile, DEPTH_ORDER) >
      rank(domainPack.depthCeiling, DEPTH_ORDER)
  ) {
    errors.push("depth profile broadens a policy ceiling");
  }
  if (
    rank(accord.policy.riskClass, RISK_ORDER) >
      rank(enterprise.ceilings.riskClass, RISK_ORDER) ||
    rank(accord.policy.riskClass, RISK_ORDER) >
      rank(domainPack.riskCeiling, RISK_ORDER)
  ) {
    errors.push("risk class broadens a policy ceiling");
  }
  if (
    rank(accord.policy.privacyClass, PRIVACY_ORDER) >
      rank(enterprise.ceilings.privacyClass, PRIVACY_ORDER) ||
    rank(accord.policy.privacyClass, PRIVACY_ORDER) >
      rank(domainPack.privacyCeiling, PRIVACY_ORDER)
  ) {
    errors.push("privacy class broadens a policy ceiling");
  }
  if (
    accord.budget.maxCalls > enterprise.ceilings.maxCalls ||
    accord.budget.maxCalls > domainPack.maxCalls ||
    accord.budget.maxCostUnits > enterprise.ceilings.maxCostUnits ||
    accord.budget.maxCostUnits > domainPack.maxCostUnits ||
    accord.budget.maxLoops > enterprise.ceilings.maxLoops ||
    accord.budget.maxLoops > domainPack.maxLoops ||
    accord.budget.maxRetries > enterprise.ceilings.maxRetries ||
    accord.budget.maxRetries > domainPack.maxRetries ||
    accord.budget.maxParallel > enterprise.ceilings.maxParallel ||
    accord.budget.maxParallel > domainPack.maxParallel
  ) {
    errors.push("Work Accord budget broadens an enterprise or Domain Pack ceiling");
  }
  if (!isSubset(accord.policy.requestedCapabilities, domainPack.allowedCapabilities)) {
    errors.push("Work Accord requests a capability outside the Domain Pack");
  }
  if (!isSubset(phase.allowedCapabilities, accord.policy.requestedCapabilities)) {
    errors.push("Phase Contract requests a capability outside the Work Accord");
  }
  if (!isSubset(phase.humanGates, accord.humanGates)) {
    errors.push("Phase Contract requires an undeclared Work Accord human gate");
  }
  if (
    enterprise.prohibitedEffects.some(
      (effect) => !accord.policy.prohibitedEffects.includes(effect)
    ) ||
    domainPack.prohibitedEffects.some(
      (effect) => !accord.policy.prohibitedEffects.includes(effect)
    )
  ) {
    errors.push("Work Accord omits a prohibited effect required by policy");
  }

  const limits = {
    maxCalls: Math.min(
      accord.budget.maxCalls,
      phase.limits.maxCalls,
      domainPack.maxCalls,
      enterprise.ceilings.maxCalls
    ),
    maxTokens: accord.budget.maxTokens,
    maxCostUnits: Math.min(
      accord.budget.maxCostUnits,
      phase.limits.maxCostUnits,
      domainPack.maxCostUnits,
      enterprise.ceilings.maxCostUnits
    ),
    maxLoops: Math.min(
      accord.budget.maxLoops,
      phase.limits.maxLoops,
      domainPack.maxLoops,
      enterprise.ceilings.maxLoops
    ),
    maxRetries: Math.min(
      accord.budget.maxRetries,
      domainPack.maxRetries,
      enterprise.ceilings.maxRetries
    ),
    maxParallel: Math.min(
      accord.budget.maxParallel,
      phase.limits.maxParallel,
      domainPack.maxParallel,
      enterprise.ceilings.maxParallel
    )
  };

  const capabilities: CompiledCapabilityGrant[] = [];
  for (const reference of phase.allowedCapabilities) {
    const resolution = resolveCapability(registry, reference, phase.phase);
    if (!resolution.ok) {
      errors.push(...resolution.errors.map((error) => error.message));
      continue;
    }
    const capability = resolution.capability;
    const access = capability.access;
    if (
      !isCostBearingPhaseOwner(phase.phase) &&
      (capability.implementation.kind === "model" ||
        capability.limits.maxCalls > 0 ||
        capability.limits.maxCostUnits > 0 ||
        access.tools.length > 0 ||
        access.shellCommands.length > 0 ||
        access.networkDestinations.length > 0 ||
        access.mcpTools.length > 0)
    ) {
      errors.push(
        `capability ${reference} consumes budget or external execution in non-cost-bearing phase ${phase.phase}`
      );
    }
    if (!isSubset(access.tools, accord.policy.tools)) {
      errors.push(`capability ${reference} requests an undeclared tool`);
    }
    if (!isSubset(access.shellCommands, accord.policy.shellCommands)) {
      errors.push(`capability ${reference} requests an undeclared shell command`);
    }
    if (!isSubset(access.networkDestinations, accord.policy.network)) {
      errors.push(`capability ${reference} requests an undeclared network destination`);
    }
    if (!isSubset(access.mcpTools, accord.policy.mcpTools)) {
      errors.push(`capability ${reference} requests an undeclared MCP tool`);
    }
    if (!isSubset(capability.humanGates, accord.humanGates)) {
      errors.push(`capability ${reference} requires an undeclared human gate`);
    }
    if (
      rank(capability.risk.class, RISK_ORDER) >
      rank(accord.policy.riskClass, RISK_ORDER)
    ) {
      errors.push(`capability ${reference} exceeds the Work Accord risk class`);
    }
    if (
      rank(capability.risk.privacyClass, PRIVACY_ORDER) >
        rank(accord.policy.privacyClass, PRIVACY_ORDER) ||
      rank(capability.risk.privacyClass, PRIVACY_ORDER) >
        rank(phase.privacy.maximumClass, PRIVACY_ORDER)
    ) {
      errors.push(`capability ${reference} exceeds an effective privacy ceiling`);
    }
    if (capability.actorClasses.length === 0) {
      errors.push(`capability ${reference} has no authorized actor class`);
    }
    if (capability.compatibility.lifecycle !== phase.compatibleLifecycle) {
      errors.push(`capability ${reference} is incompatible with the lifecycle`);
    }

    capabilities.push({
      reference,
      actorClasses: [...capability.actorClasses].sort(),
      humanGates: [...capability.humanGates].sort(),
      readScopes: [...capability.access.readScopes].sort(),
      tools: [...access.tools].sort(),
      shellCommands: [...access.shellCommands].sort(),
      networkDestinations: [...access.networkDestinations].sort(),
      mcpTools: [...access.mcpTools].sort(),
      riskClass: capability.risk.class,
      privacyClass: capability.risk.privacyClass,
      limits: {
        maxCalls: Math.min(capability.limits.maxCalls, limits.maxCalls),
        maxCostUnits: Math.min(
          capability.limits.maxCostUnits,
          limits.maxCostUnits
        ),
        timeoutMs: capability.limits.timeoutMs,
        maxRetries: Math.min(capability.limits.maxRetries, limits.maxRetries),
        maxOutputBytes: capability.limits.maxOutputBytes,
        maxConcurrency: Math.min(
          capability.limits.maxConcurrency,
          limits.maxParallel
        ),
        parallelSafe: capability.limits.parallelSafe
      },
      evidence: [...capability.evidence].sort(),
      structuralEvaluations: [...capability.evaluations.structural].sort(),
      behavioralEvaluations: [...capability.evaluations.behavioral].sort()
    });
  }

  if (errors.length > 0) {
    return { ok: false, code: "POLICY_ESCALATION", errors };
  }

  capabilities.sort((left, right) =>
    compareCodeUnits(left.reference, right.reference)
  );
  const compiledWithoutDigest = {
    phase: phase.phase,
    allowedCapabilities: capabilities.map((capability) => capability.reference),
    capabilities,
    requiredHumanGates: [
      ...new Set([
        ...phase.humanGates,
        ...capabilities.flatMap((capability) => capability.humanGates)
      ])
    ].sort(),
    limits
  };
  return {
    ok: true,
    policy: {
      ...compiledWithoutDigest,
      digest: computeCompiledPolicyDigest(compiledWithoutDigest)
    }
  };
}
