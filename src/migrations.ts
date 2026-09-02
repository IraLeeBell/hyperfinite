import { digest } from "./canonical.js";
import type { Digest, RefusalCode } from "./types.js";
import {
  type DocumentKind,
  type ValidationResult,
  validateDocument
} from "./validation.js";

export type MigratableKind =
  | "LifecycleGraph"
  | "WorkAccord"
  | "PhaseContract"
  | "CapabilityRegistry"
  | "ControlPolicy"
  | "KernelSnapshot"
  | "TransitionReceipt";

export type VersionedDocument = Readonly<Record<string, unknown>>;

export interface MigrationValidationSuccess {
  readonly valid: true;
}

export interface MigrationValidationFailure {
  readonly valid: false;
  readonly errors: readonly string[];
}

export type MigrationValidation =
  | MigrationValidationSuccess
  | MigrationValidationFailure;

export type MigrationValidator = (
  document: VersionedDocument
) => MigrationValidation;

export interface MigrationStep {
  readonly kind: MigratableKind;
  readonly from: string;
  readonly to: string;
  readonly validateSource: MigrationValidator;
  readonly validateTarget: MigrationValidator;
  readonly migrate: (document: VersionedDocument) => VersionedDocument;
}

export interface MigrationPlan {
  readonly ok: true;
  readonly kind: MigratableKind;
  readonly from: string;
  readonly to: string;
  readonly path: readonly string[];
}

export interface MigrationResult extends MigrationPlan {
  readonly dryRun: boolean;
  readonly inputDigest: Digest;
  readonly outputDigest: Digest;
  readonly changed: boolean;
  readonly document: VersionedDocument;
}

export interface MigrationFailure {
  readonly ok: false;
  readonly code: Extract<
    RefusalCode,
    "SCHEMA_INVALID" | "MIGRATION_UNAVAILABLE"
  >;
  readonly message: string;
}

const INITIAL_VERSION = "1.0.0";
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function asMigrationValidation(
  result: ValidationResult<unknown>
): MigrationValidation {
  return result.valid
    ? { valid: true }
    : { valid: false, errors: result.errors };
}

function validateCurrentDocument(
  kind: MigratableKind,
  document: VersionedDocument
): MigrationValidation {
  return asMigrationValidation(
    validateDocument(kind as DocumentKind, document) as ValidationResult<unknown>
  );
}

function isClosedJson(
  value: unknown,
  ancestors: Set<object> = new Set()
): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every((entry) => isClosedJson(entry, ancestors))
    : Object.getPrototypeOf(value) === Object.prototype &&
      Object.entries(value).every(
        ([, entry]) => isClosedJson(entry, ancestors)
      );
  ancestors.delete(value);
  return valid;
}

function schemaFailure(message: string): MigrationFailure {
  return { ok: false, code: "SCHEMA_INVALID", message };
}

function unavailable(message: string): MigrationFailure {
  return { ok: false, code: "MIGRATION_UNAVAILABLE", message };
}

function runValidator(
  validator: MigrationValidator,
  document: VersionedDocument
): MigrationValidation {
  function once(): {
    readonly result: MigrationValidation;
    readonly before: Digest;
    readonly after: Digest;
  } {
    const candidate = structuredClone(document);
    const before = digest(candidate);
    const result = validator(candidate);
    const after = digest(candidate);
    if (
      !isClosedJson(result) ||
      typeof result.valid !== "boolean" ||
      (!result.valid &&
        (!Array.isArray(result.errors) ||
          !result.errors.every((error) => typeof error === "string")))
    ) {
      return {
        result: { valid: false, errors: ["validator returned an invalid result"] },
        before,
        after
      };
    }
    return { result, before, after };
  }

  try {
    const first = once();
    const second = once();
    if (first.before !== first.after || second.before !== second.after) {
      return { valid: false, errors: ["validator mutated its input"] };
    }
    if (digest(first.result) !== digest(second.result)) {
      return { valid: false, errors: ["validator is nondeterministic"] };
    }
    return first.result;
  } catch (error) {
    return {
      valid: false,
      errors: [
        `validator failed: ${error instanceof Error ? error.message : "unknown error"}`
      ]
    };
  }
}

export class MigrationRegistry {
  readonly #steps = new Map<string, MigrationStep>();
  readonly #knownVersions = new Map<MigratableKind, Set<string>>();
  readonly #validators = new Map<string, MigrationValidator>();

  constructor() {
    for (const kind of [
      "LifecycleGraph",
      "WorkAccord",
      "PhaseContract",
      "CapabilityRegistry",
      "ControlPolicy",
      "KernelSnapshot",
      "TransitionReceipt"
    ] as const) {
      this.#knownVersions.set(kind, new Set([INITIAL_VERSION]));
      this.#validators.set(
        this.#key(kind, INITIAL_VERSION),
        (document) => validateCurrentDocument(kind, document)
      );
    }
  }

  register(step: MigrationStep): void {
    this.#assertVersion(step.from);
    this.#assertVersion(step.to);
    if (step.from === step.to) {
      throw new TypeError("migration steps must advance to a different version");
    }
    const key = this.#key(step.kind, step.from);
    if (this.#steps.has(key)) {
      throw new TypeError(`migration already registered for ${key}`);
    }
    const targetKey = this.#key(step.kind, step.to);
    const targetValidator = this.#validators.get(targetKey);
    if (
      targetValidator !== undefined &&
      targetValidator !== step.validateTarget
    ) {
      throw new TypeError(`conflicting validator registered for ${targetKey}`);
    }
    const registered = Object.freeze({ ...step });
    this.#steps.set(key, registered);
    this.#validators.set(targetKey, registered.validateTarget);
    this.#knownVersions.get(step.kind)?.add(step.from);
    this.#knownVersions.get(step.kind)?.add(step.to);
  }

  plan(input: {
    readonly kind: MigratableKind;
    readonly from: string;
    readonly to: string;
  }): MigrationPlan | MigrationFailure {
    if (!VERSION_PATTERN.test(input.from) || !VERSION_PATTERN.test(input.to)) {
      return unavailable("migration versions must be canonical semantic versions");
    }
    const known = this.#knownVersions.get(input.kind);
    if (!known?.has(input.from) || !known.has(input.to)) {
      return unavailable(
        `unsupported migration version for ${input.kind}: ${input.from} -> ${input.to}`
      );
    }
    if (input.from === input.to) {
      return { ok: true, ...input, path: [] };
    }

    let version = input.from;
    const path: string[] = [];
    const visited = new Set<string>();
    while (version !== input.to) {
      const key = this.#key(input.kind, version);
      if (visited.has(key)) {
        return unavailable(`migration cycle detected at ${key}`);
      }
      visited.add(key);
      const step = this.#steps.get(key);
      if (step === undefined) {
        return unavailable(
          `no released migration path for ${input.kind} from ${version} to ${input.to}`
        );
      }
      path.push(`${step.from}->${step.to}`);
      version = step.to;
    }
    return { ok: true, ...input, path };
  }

  migrate(input: {
    readonly kind: MigratableKind;
    readonly document: VersionedDocument;
    readonly from: string;
    readonly to: string;
    readonly dryRun: boolean;
  }): MigrationResult | MigrationFailure {
    if (!isClosedJson(input.document)) {
      return schemaFailure("migration input must be a finite, acyclic JSON object");
    }
    const plan = this.plan(input);
    if (!plan.ok) return plan;

    const original = structuredClone(input.document);
    const inputDigest = digest(original);
    let current = structuredClone(original);

    if (plan.path.length === 0) {
      const validator = this.#validators.get(this.#key(input.kind, input.from));
      if (validator === undefined) {
        return unavailable(
          `no validator for ${input.kind} version ${input.from}`
        );
      }
      const validation = runValidator(validator, current);
      if (!validation.valid) {
        return schemaFailure(
          `invalid ${input.kind} ${input.from} document: ${validation.errors.join("; ")}`
        );
      }
    } else {
      let version = input.from;
      for (const segment of plan.path) {
        const step = this.#steps.get(this.#key(input.kind, version));
        if (step === undefined) {
          return unavailable(`planned migration step ${segment} is unavailable`);
        }
        const sourceValidator = this.#validators.get(
          this.#key(input.kind, version)
        );
        const targetValidator = this.#validators.get(
          this.#key(input.kind, step.to)
        );
        if (sourceValidator === undefined || targetValidator === undefined) {
          return unavailable(`migration ${step.kind}:${segment} has no validator`);
        }
        const sourceValidation = runValidator(sourceValidator, current);
        if (!sourceValidation.valid) {
          return schemaFailure(
            `invalid ${input.kind} ${step.from} document: ${sourceValidation.errors.join("; ")}`
          );
        }
        const stepSourceValidation = runValidator(
          step.validateSource,
          current
        );
        if (!stepSourceValidation.valid) {
          return schemaFailure(
            `migration ${step.kind}:${segment} rejected its source: ${stepSourceValidation.errors.join("; ")}`
          );
        }
        const first = step.migrate(structuredClone(current));
        const second = step.migrate(structuredClone(current));
        if (!isClosedJson(first) || !isClosedJson(second)) {
          return schemaFailure(`migration ${step.kind}:${segment} produced non-JSON output`);
        }
        if (digest(first) !== digest(second)) {
          throw new TypeError(`migration ${step.kind}:${segment} is nondeterministic`);
        }
        const targetValidation = runValidator(targetValidator, first);
        if (!targetValidation.valid) {
          return schemaFailure(
            `invalid ${input.kind} ${step.to} output: ${targetValidation.errors.join("; ")}`
          );
        }
        current = structuredClone(first);
        version = step.to;
      }
    }

    if (digest(input.document) !== inputDigest) {
      throw new TypeError("migration mutated its input document");
    }
    const outputDigest = digest(current);
    return {
      ...plan,
      dryRun: input.dryRun,
      inputDigest,
      outputDigest,
      changed: outputDigest !== inputDigest,
      document: current
    };
  }

  #assertVersion(version: string): void {
    if (!VERSION_PATTERN.test(version)) {
      throw new TypeError(`invalid migration version: ${version}`);
    }
  }

  #key(kind: MigratableKind, version: string): string {
    return `${kind}:${version}`;
  }
}

export function createDefaultMigrationRegistry(): MigrationRegistry {
  return new MigrationRegistry();
}
