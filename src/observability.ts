import { canonicalJson, digest } from "./canonical.js";
import type { ApiVersion, Digest } from "./types.js";

export const AUDIT_COMPONENTS = [
  "lifecycle",
  "policy",
  "kernel",
  "adapter",
  "single-writer",
  "runtime",
  "domain-pack"
] as const;

export const AUDIT_ACTIONS = [
  "authorize",
  "transition",
  "invoke-model",
  "invoke-tool",
  "plan-effect",
  "apply-effect",
  "reconcile",
  "human-gate",
  "reserve-budget",
  "release-budget"
] as const;

export const AUDIT_OUTCOMES = ["accepted", "refused", "partial"] as const;

export type AuditComponent = (typeof AUDIT_COMPONENTS)[number];
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

export interface AuditResourceUsage {
  readonly attempts: number;
  readonly tokens: number;
  readonly costUnits: number;
  readonly toolCalls: number;
  readonly effects: number;
  readonly durationMs: number;
}

export interface AuditEvent {
  readonly apiVersion: ApiVersion;
  readonly kind: "AuditEvent";
  readonly schemaVersion: "1.0.0";
  readonly sequence: number;
  readonly occurredAt: string;
  readonly component: AuditComponent;
  readonly action: AuditAction;
  readonly outcome: AuditOutcome;
  readonly reasonCode: string;
  readonly authorityDigest: Digest;
  readonly subjectDigest: Digest;
  readonly previousEventDigest: Digest | null;
  readonly usage: AuditResourceUsage;
}

export const METRIC_NAMES = [
  "agentic_control_decisions_total",
  "agentic_attempts_total",
  "agentic_tokens_total",
  "agentic_cost_units_total",
  "agentic_tool_calls_total",
  "agentic_effects_total",
  "agentic_duration_ms_total"
] as const;

export type MetricName = (typeof METRIC_NAMES)[number];

export interface MetricRecord {
  readonly apiVersion: ApiVersion;
  readonly kind: "MetricRecord";
  readonly schemaVersion: "1.0.0";
  readonly name: MetricName;
  readonly labels: {
    readonly component: AuditComponent;
    readonly outcome: AuditOutcome;
  };
  readonly value: number;
}

export interface RunBudget {
  readonly authorityDigest: Digest;
  readonly maxAttempts: number;
  readonly maxFanout: number;
  readonly maxConcurrency: number;
  readonly maxWallClockMs: number;
  readonly maxTokens: number;
  readonly maxToolCalls: number;
  readonly maxEffects: number;
  readonly expiresAt: string;
}

export interface RunUsage {
  readonly attempts: number;
  readonly fanout: number;
  readonly concurrency: number;
  readonly tokens: number;
  readonly toolCalls: number;
  readonly effects: number;
}

export interface RunReservation {
  readonly attempts: number;
  readonly fanout: number;
  readonly concurrency: number;
  readonly tokens: number;
  readonly toolCalls: number;
  readonly effects: number;
}

export type BudgetReasonCode =
  | "AUTHORIZED"
  | "BUDGET_EXPIRED"
  | "WALL_CLOCK_EXHAUSTED"
  | "ATTEMPT_LIMIT_EXHAUSTED"
  | "FANOUT_LIMIT_EXHAUSTED"
  | "CONCURRENCY_LIMIT_EXHAUSTED"
  | "TOKEN_LIMIT_EXHAUSTED"
  | "TOOL_LIMIT_EXHAUSTED"
  | "EFFECT_LIMIT_EXHAUSTED";

export interface BudgetDecisionEvidence {
  readonly apiVersion: ApiVersion;
  readonly kind: "BudgetDecisionEvidence";
  readonly schemaVersion: "1.0.0";
  readonly authorityDigest: Digest;
  readonly budgetDigest: Digest;
  readonly usageDigest: Digest;
  readonly reservationDigest: Digest;
  readonly previousDecisionDigest: Digest | null;
  readonly status: "authorized" | "refused";
  readonly reasonCode: BudgetReasonCode;
  readonly projectedUsage: RunUsage;
  readonly startedAt: string;
  readonly evaluatedAt: string;
}

export type AuditSafeValue =
  | boolean
  | number
  | string
  | null
  | readonly AuditSafeValue[]
  | { readonly [key: string]: AuditSafeValue };

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const REASON_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;
const AUDIT_FIELD_ALLOWLIST = new Set([
  "action",
  "apiVersion",
  "attempts",
  "authorityDigest",
  "budgetDigest",
  "component",
  "concurrency",
  "costUnits",
  "durationMs",
  "evaluatedAt",
  "effects",
  "fanout",
  "kind",
  "labels",
  "name",
  "occurredAt",
  "outcome",
  "previousDecisionDigest",
  "previousEventDigest",
  "projectedUsage",
  "reasonCode",
  "reservationDigest",
  "schemaVersion",
  "sequence",
  "startedAt",
  "status",
  "subjectDigest",
  "tokens",
  "toolCalls",
  "usage",
  "usageDigest",
  "value"
]);
const AUDIT_STATUSES = new Set([
  "accepted",
  "authorized",
  "claimed",
  "completed",
  "partial",
  "refused",
  "rejected",
  "success"
]);
const MAX_AUDIT_DEPTH = 6;
const MAX_AUDIT_ENTRIES = 32;

function isCanonicalUtcDateTime(value: string): boolean {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/u.exec(
      value
    );
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return false;
  }
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31
  ];
  return day >= 1 && day <= (daysInMonth[month - 1] ?? 0);
}

function isSafeCounter(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function assertExactKeys(
  value: object,
  expected: readonly string[],
  label: string
): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (
    actual.length !== required.length ||
    actual.some((key, index) => key !== required[index])
  ) {
    throw new TypeError(`${label} fields are not canonical`);
  }
}

function assertUsage(
  value: AuditResourceUsage | RunUsage | RunReservation,
  expected: readonly string[]
): void {
  assertExactKeys(value, expected, "usage");
  for (const [name, count] of Object.entries(value)) {
    if (!isSafeCounter(count)) {
      throw new TypeError(`${name} must be a non-negative safe integer`);
    }
  }
}

function safeAdd(left: number, right: number): number | null {
  const result = left + right;
  return Number.isSafeInteger(result) && result >= 0 ? result : null;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function zeroRunUsage(): RunUsage {
  return {
    attempts: 0,
    fanout: 0,
    concurrency: 0,
    tokens: 0,
    toolCalls: 0,
    effects: 0
  };
}

function projectUsage(
  usage: RunUsage,
  reservation: RunReservation
): RunUsage | null {
  const projected = {
    attempts: safeAdd(usage.attempts, reservation.attempts),
    fanout: safeAdd(usage.fanout, reservation.fanout),
    concurrency: safeAdd(usage.concurrency, reservation.concurrency),
    tokens: safeAdd(usage.tokens, reservation.tokens),
    toolCalls: safeAdd(usage.toolCalls, reservation.toolCalls),
    effects: safeAdd(usage.effects, reservation.effects)
  };
  return Object.values(projected).some((value) => value === null)
    ? null
    : (projected as RunUsage);
}

function budgetEvidence(input: {
  readonly budget: RunBudget;
  readonly usage: RunUsage;
  readonly reservation: RunReservation;
  readonly previousDecisionDigest: Digest | null;
  readonly status: BudgetDecisionEvidence["status"];
  readonly reasonCode: BudgetReasonCode;
  readonly projectedUsage: RunUsage;
  readonly startedAt: string;
  readonly evaluatedAt: string;
}): BudgetDecisionEvidence {
  return Object.freeze({
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "BudgetDecisionEvidence",
    schemaVersion: "1.0.0",
    authorityDigest: input.budget.authorityDigest,
    budgetDigest: digest(input.budget),
    usageDigest: digest(input.usage),
    reservationDigest: digest(input.reservation),
    previousDecisionDigest: input.previousDecisionDigest,
    status: input.status,
    reasonCode: input.reasonCode,
    projectedUsage: Object.freeze({ ...input.projectedUsage }),
    startedAt: input.startedAt,
    evaluatedAt: input.evaluatedAt
  });
}

export function evaluateRunBudget(input: {
  readonly budget: RunBudget;
  readonly usage: RunUsage;
  readonly reservation: RunReservation;
  readonly startedAt: string;
  readonly evaluatedAt: string;
  readonly previousDecisionDigest: Digest | null;
}): BudgetDecisionEvidence {
  const stableInput = JSON.parse(canonicalJson(input)) as typeof input;
  const {
    budget,
    usage,
    reservation,
    startedAt,
    evaluatedAt,
    previousDecisionDigest
  } = stableInput;
  assertExactKeys(
    budget,
    [
      "authorityDigest",
      "maxAttempts",
      "maxFanout",
      "maxConcurrency",
      "maxWallClockMs",
      "maxTokens",
      "maxToolCalls",
      "maxEffects",
      "expiresAt"
    ],
    "budget"
  );
  const limits = [
    budget.maxAttempts,
    budget.maxFanout,
    budget.maxConcurrency,
    budget.maxWallClockMs,
    budget.maxTokens,
    budget.maxToolCalls,
    budget.maxEffects
  ];
  const timestampsValid =
    isCanonicalUtcDateTime(startedAt) &&
    isCanonicalUtcDateTime(evaluatedAt) &&
    isCanonicalUtcDateTime(budget.expiresAt);
  assertUsage(usage, [
    "attempts",
    "fanout",
    "concurrency",
    "tokens",
    "toolCalls",
    "effects"
  ]);
  assertUsage(reservation, [
    "attempts",
    "fanout",
    "concurrency",
    "tokens",
    "toolCalls",
    "effects"
  ]);
  const projected = projectUsage(usage, reservation);
  const evaluatedAtMs = Date.parse(evaluatedAt);
  const startedAtMs = Date.parse(startedAt);
  const expiresAt = Date.parse(budget.expiresAt);
  const valid =
    DIGEST.test(budget.authorityDigest) &&
    (previousDecisionDigest === null ||
      DIGEST.test(previousDecisionDigest)) &&
    limits.every(isSafeCounter) &&
    budget.maxWallClockMs > 0 &&
    timestampsValid &&
    Number.isFinite(evaluatedAtMs) &&
    Number.isFinite(startedAtMs) &&
    Number.isFinite(expiresAt) &&
    startedAtMs <= evaluatedAtMs &&
    startedAtMs < expiresAt &&
    projected !== null;
  if (!valid) {
    throw new TypeError("run budget input is not canonical");
  }
  let reasonCode: BudgetReasonCode = "AUTHORIZED";
  if (evaluatedAtMs >= expiresAt) reasonCode = "BUDGET_EXPIRED";
  else if (evaluatedAtMs - startedAtMs >= budget.maxWallClockMs) {
    reasonCode = "WALL_CLOCK_EXHAUSTED";
  } else if (projected.attempts > budget.maxAttempts) {
    reasonCode = "ATTEMPT_LIMIT_EXHAUSTED";
  } else if (projected.fanout > budget.maxFanout) {
    reasonCode = "FANOUT_LIMIT_EXHAUSTED";
  } else if (projected.concurrency > budget.maxConcurrency) {
    reasonCode = "CONCURRENCY_LIMIT_EXHAUSTED";
  } else if (projected.tokens > budget.maxTokens) {
    reasonCode = "TOKEN_LIMIT_EXHAUSTED";
  } else if (projected.toolCalls > budget.maxToolCalls) {
    reasonCode = "TOOL_LIMIT_EXHAUSTED";
  } else if (projected.effects > budget.maxEffects) {
    reasonCode = "EFFECT_LIMIT_EXHAUSTED";
  }
  return budgetEvidence({
    budget,
    usage,
    reservation,
    previousDecisionDigest,
    status: reasonCode === "AUTHORIZED" ? "authorized" : "refused",
    reasonCode,
    projectedUsage: projected ?? zeroRunUsage(),
    startedAt,
    evaluatedAt
  });
}

const AUDIT_INPUT_FIELDS = [
  "sequence",
  "occurredAt",
  "component",
  "action",
  "outcome",
  "reasonCode",
  "authorityDigest",
  "subjectDigest",
  "previousEventDigest",
  "usage"
] as const;

function buildAuditEvent(
  input: Omit<AuditEvent, "apiVersion" | "kind" | "schemaVersion">
): AuditEvent {
  assertUsage(input.usage, [
    "attempts",
    "tokens",
    "costUnits",
    "toolCalls",
    "effects",
    "durationMs"
  ]);
  if (
    !Number.isSafeInteger(input.sequence) ||
    input.sequence < 1 ||
    !isCanonicalUtcDateTime(input.occurredAt) ||
    !AUDIT_COMPONENTS.includes(input.component) ||
    !AUDIT_ACTIONS.includes(input.action) ||
    !AUDIT_OUTCOMES.includes(input.outcome) ||
    !REASON_CODE.test(input.reasonCode) ||
    !DIGEST.test(input.authorityDigest) ||
    !DIGEST.test(input.subjectDigest) ||
    (input.previousEventDigest !== null &&
      !DIGEST.test(input.previousEventDigest))
  ) {
    throw new TypeError("audit event is not canonical");
  }
  return Object.freeze({
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "AuditEvent",
    schemaVersion: "1.0.0",
    sequence: input.sequence,
    occurredAt: input.occurredAt,
    component: input.component,
    action: input.action,
    outcome: input.outcome,
    reasonCode: input.reasonCode,
    authorityDigest: input.authorityDigest,
    subjectDigest: input.subjectDigest,
    previousEventDigest: input.previousEventDigest,
    usage: Object.freeze({
      attempts: input.usage.attempts,
      tokens: input.usage.tokens,
      costUnits: input.usage.costUnits,
      toolCalls: input.usage.toolCalls,
      effects: input.usage.effects,
      durationMs: input.usage.durationMs
    })
  });
}

export function createAuditEvent(
  input: Omit<AuditEvent, "apiVersion" | "kind" | "schemaVersion">
): AuditEvent {
  const stableInput = JSON.parse(canonicalJson(input)) as typeof input;
  assertExactKeys(stableInput, AUDIT_INPUT_FIELDS, "audit event");
  return buildAuditEvent(stableInput);
}

function canonicalAuditEvents(events: readonly AuditEvent[]): readonly AuditEvent[] {
  let prior: AuditEvent | null = null;
  return events.map((event) => {
    const stableEvent = JSON.parse(canonicalJson(event)) as AuditEvent;
    assertExactKeys(
      stableEvent,
      ["apiVersion", "kind", "schemaVersion", ...AUDIT_INPUT_FIELDS],
      "audit event"
    );
    if (
      stableEvent.apiVersion !== "agentic-framework.github.com/v1alpha1" ||
      stableEvent.kind !== "AuditEvent" ||
      stableEvent.schemaVersion !== "1.0.0"
    ) {
      throw new TypeError("audit event version is not canonical");
    }
    const {
      apiVersion: _apiVersion,
      kind: _kind,
      schemaVersion: _schemaVersion,
      ...input
    } = stableEvent;
    const canonicalEvent = buildAuditEvent(input);
    if (
      canonicalEvent.sequence !== (prior?.sequence ?? 0) + 1 ||
      canonicalEvent.previousEventDigest !==
        (prior === null ? null : digest(prior))
    ) {
      throw new TypeError("audit event chain is not contiguous");
    }
    prior = canonicalEvent;
    return canonicalEvent;
  });
}

export function serializeAuditEvents(events: readonly AuditEvent[]): string {
  const records = canonicalAuditEvents(events).map(canonicalJson);
  return records.length === 0 ? "" : `${records.join("\n")}\n`;
}

export function emitDeterministicMetrics(
  events: readonly AuditEvent[]
): readonly MetricRecord[] {
  const canonicalEvents = canonicalAuditEvents(events);
  const values = new Map<string, number>();
  const add = (
    name: MetricName,
    event: AuditEvent,
    increment: number
  ): void => {
    if (increment === 0) return;
    const key = `${name}\u0000${event.component}\u0000${event.outcome}`;
    const next = (values.get(key) ?? 0) + increment;
    if (!Number.isSafeInteger(next) || next < 0) {
      throw new TypeError("metric value overflowed");
    }
    values.set(key, next);
  };
  for (const event of canonicalEvents) {
    add("agentic_control_decisions_total", event, 1);
    add("agentic_attempts_total", event, event.usage.attempts);
    add("agentic_tokens_total", event, event.usage.tokens);
    add("agentic_cost_units_total", event, event.usage.costUnits);
    add("agentic_tool_calls_total", event, event.usage.toolCalls);
    add("agentic_effects_total", event, event.usage.effects);
    add("agentic_duration_ms_total", event, event.usage.durationMs);
  }
  return [...values.entries()]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([key, value]) => {
      const [name, component, outcome] = key.split("\u0000");
      if (
        name === undefined ||
        component === undefined ||
        outcome === undefined ||
        !METRIC_NAMES.includes(name as MetricName) ||
        !AUDIT_COMPONENTS.includes(component as AuditComponent) ||
        !AUDIT_OUTCOMES.includes(outcome as AuditOutcome)
      ) {
        throw new TypeError("metric key is not canonical");
      }
      return Object.freeze({
        apiVersion: "agentic-framework.github.com/v1alpha1" as const,
        kind: "MetricRecord" as const,
        schemaVersion: "1.0.0" as const,
        name: name as MetricName,
        labels: Object.freeze({
          component: component as AuditComponent,
          outcome: outcome as AuditOutcome
        }),
        value
      });
    });
}

export function redactForAudit(value: unknown): AuditSafeValue {
  const seen = new Set<object>();
  const allowedValue = (
    key: string,
    candidate: unknown,
    depth: number
  ): AuditSafeValue => {
    if (
      key === "attempts" ||
      key === "concurrency" ||
      key === "costUnits" ||
      key === "durationMs" ||
      key === "effects" ||
      key === "fanout" ||
      key === "sequence" ||
      key === "tokens" ||
      key === "toolCalls" ||
      key === "value"
    ) {
      return typeof candidate === "number" && isSafeCounter(candidate)
        ? candidate
        : "[REDACTED:INVALID]";
    }
    if (key === "action") {
      return typeof candidate === "string" &&
        AUDIT_ACTIONS.includes(candidate as AuditAction)
        ? candidate
        : "[REDACTED:INVALID]";
    }
    if (key === "component") {
      return typeof candidate === "string" &&
        AUDIT_COMPONENTS.includes(candidate as AuditComponent)
        ? candidate
        : "[REDACTED:INVALID]";
    }
    if (key === "outcome") {
      return typeof candidate === "string" &&
        AUDIT_OUTCOMES.includes(candidate as AuditOutcome)
        ? candidate
        : "[REDACTED:INVALID]";
    }
    if (key === "name") {
      return typeof candidate === "string" &&
        METRIC_NAMES.includes(candidate as MetricName)
        ? candidate
        : "[REDACTED:INVALID]";
    }
    if (key === "reasonCode") {
      return typeof candidate === "string" && REASON_CODE.test(candidate)
        ? candidate
        : "[REDACTED:INVALID]";
    }
    if (key === "status") {
      return typeof candidate === "string" && AUDIT_STATUSES.has(candidate)
        ? candidate
        : "[REDACTED:INVALID]";
    }
    if (key === "apiVersion") {
      return candidate === "agentic-framework.github.com/v1alpha1"
        ? candidate
        : "[REDACTED:INVALID]";
    }
    if (key === "schemaVersion") {
      return candidate === "1.0.0" ? candidate : "[REDACTED:INVALID]";
    }
    if (key === "kind") {
      return candidate === "AuditEvent" ||
        candidate === "MetricRecord" ||
        candidate === "BudgetDecisionEvidence"
        ? candidate
        : "[REDACTED:INVALID]";
    }
    if (
      key === "occurredAt" ||
      key === "startedAt" ||
      key === "evaluatedAt"
    ) {
      return typeof candidate === "string" &&
        isCanonicalUtcDateTime(candidate)
        ? candidate
        : "[REDACTED:INVALID]";
    }
    if (
      key === "authorityDigest" ||
      key === "budgetDigest" ||
      key === "reservationDigest" ||
      key === "subjectDigest" ||
      key === "usageDigest" ||
      key === "previousDecisionDigest" ||
      key === "previousEventDigest"
    ) {
      return ((key === "previousDecisionDigest" ||
        key === "previousEventDigest") &&
        candidate === null) ||
        (typeof candidate === "string" && DIGEST.test(candidate))
        ? (candidate as string | null)
        : "[REDACTED:INVALID]";
    }
    if (key === "labels") {
      if (
        candidate === null ||
        typeof candidate !== "object" ||
        Array.isArray(candidate) ||
        Object.keys(candidate).sort().join(",") !== "component,outcome"
      ) {
        return "[REDACTED:INVALID]";
      }
      return visit(candidate, depth + 1);
    }
    if (key === "usage") {
      if (
        candidate === null ||
        typeof candidate !== "object" ||
        Array.isArray(candidate) ||
        Object.keys(candidate).sort().join(",") !==
          "attempts,costUnits,durationMs,effects,tokens,toolCalls"
      ) {
        return "[REDACTED:INVALID]";
      }
      return visit(candidate, depth + 1);
    }
    if (key === "projectedUsage") {
      if (
        candidate === null ||
        typeof candidate !== "object" ||
        Array.isArray(candidate) ||
        Object.keys(candidate).sort().join(",") !==
          "attempts,concurrency,effects,fanout,tokens,toolCalls"
      ) {
        return "[REDACTED:INVALID]";
      }
      return visit(candidate, depth + 1);
    }
    return "[REDACTED:FIELD]";
  };
  const visit = (candidate: unknown, depth: number): AuditSafeValue => {
    if (depth > MAX_AUDIT_DEPTH) return "[TRUNCATED:DEPTH]";
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      throw new TypeError("audit redaction requires a plain diagnostic object");
    }
    if (seen.has(candidate)) {
      throw new TypeError("audit redaction does not support cyclic values");
    }
    seen.add(candidate);
    let result: AuditSafeValue;
    const record = candidate as Readonly<Record<string, unknown>>;
      const descriptors = Object.getOwnPropertyDescriptors(record);
      if (
        Object.getPrototypeOf(record) !== Object.prototype &&
        Object.getPrototypeOf(record) !== null
      ) {
        throw new TypeError("audit redaction requires plain objects");
      }
      if (
        Object.values(descriptors).some(
          (descriptor) =>
            descriptor.get !== undefined || descriptor.set !== undefined
        )
      ) {
        throw new TypeError("audit redaction does not support accessors");
      }
      const entries = Object.entries(record)
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .slice(0, MAX_AUDIT_ENTRIES)
        .map(([key, child], index) => {
          if (!AUDIT_FIELD_ALLOWLIST.has(key)) {
            return [
              `_redacted_${index.toString().padStart(2, "0")}`,
              "[REDACTED:FIELD]"
            ];
          }
          return [key, allowedValue(key, child, depth)];
        });
      if (
        Object.keys(record).length > MAX_AUDIT_ENTRIES
      ) {
        entries.push(["_truncated", true]);
      }
      result = Object.fromEntries(entries) as {
        readonly [key: string]: AuditSafeValue;
      };
    seen.delete(candidate);
    return result;
  };
  return visit(value, 0);
}
