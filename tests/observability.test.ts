import assert from "node:assert/strict";
import { test } from "node:test";

import { digest } from "../src/canonical.js";
import {
  createAuditEvent,
  emitDeterministicMetrics,
  evaluateRunBudget,
  redactForAudit,
  serializeAuditEvents,
  type AuditEvent,
  type AuditSafeValue,
  type RunBudget,
  type RunReservation,
  type RunUsage
} from "../src/observability.js";
import { validateDocument } from "../src/validation.js";

const AUTHORITY = digest({ authority: "reviewed" });
const SUBJECT = digest({ subject: "issue-3" });
const ZERO_USAGE = {
  attempts: 0,
  fanout: 0,
  concurrency: 0,
  tokens: 0,
  toolCalls: 0,
  effects: 0
} satisfies RunUsage;
const ZERO_RESERVATION = {
  attempts: 0,
  fanout: 0,
  concurrency: 0,
  tokens: 0,
  toolCalls: 0,
  effects: 0
} satisfies RunReservation;
const BUDGET = {
  authorityDigest: AUTHORITY,
  maxAttempts: 2,
  maxFanout: 2,
  maxConcurrency: 1,
  maxWallClockMs: 60_000,
  maxTokens: 1_000,
  maxToolCalls: 3,
  maxEffects: 2,
  expiresAt: "2026-08-28T01:00:00Z"
} satisfies RunBudget;

function event(
  sequence: number,
  previousEventDigest: AuditEvent["previousEventDigest"],
  overrides: Partial<
    Omit<AuditEvent, "apiVersion" | "kind" | "schemaVersion" | "sequence">
  > = {}
): AuditEvent {
  return createAuditEvent({
    sequence,
    occurredAt: "2026-08-28T00:30:00Z",
    component: "kernel",
    action: "authorize",
    outcome: "accepted",
    reasonCode: "AUTHORIZED",
    authorityDigest: AUTHORITY,
    subjectDigest: SUBJECT,
    previousEventDigest,
    usage: {
      attempts: 1,
      tokens: 12,
      costUnits: 3,
      toolCalls: 1,
      effects: 0,
      durationMs: 20
    },
    ...overrides
  });
}

test("audit serialization is canonical, chained, and schema valid", () => {
  const first = event(1, null);
  const second = event(2, digest(first), {
    component: "single-writer",
    action: "apply-effect",
    outcome: "partial",
    reasonCode: "WRITE_AMBIGUOUS",
    usage: {
      attempts: 1,
      tokens: 0,
      costUnits: 0,
      toolCalls: 0,
      effects: 1,
      durationMs: 5
    }
  });
  const serialized = serializeAuditEvents([first, second]);
  assert.equal(serialized, serializeAuditEvents([first, second]));
  assert.equal(serialized.split("\n").filter(Boolean).length, 2);
  assert.equal(validateDocument("AuditEvent", first).valid, true);
  assert.equal(validateDocument("AuditEvent", second).valid, true);
  assert.throws(
    () => serializeAuditEvents([second, first]),
    /audit event chain is not contiguous/
  );
  assert.throws(
    () =>
      serializeAuditEvents([
        {
          ...first,
          usage: { ...first.usage, unexpected: 1 }
        } as AuditEvent
      ]),
    /fields are not canonical/
  );
});

test("audit serialization and metrics snapshot mutable events once", () => {
  const first = event(1, null);
  let occurredAtReads = 0;
  const mutableForSerialization = { ...first };
  Object.defineProperty(mutableForSerialization, "occurredAt", {
    enumerable: true,
    get: () => {
      occurredAtReads += 1;
      return occurredAtReads === 1 ? first.occurredAt : "SECRET_LEAK";
    }
  });
  const serialized = serializeAuditEvents([mutableForSerialization]);
  assert.equal(occurredAtReads, 1);
  assert.equal(serialized.includes("SECRET_LEAK"), false);
  assert.equal(
    validateDocument("AuditEvent", JSON.parse(serialized) as unknown).valid,
    true
  );

  let usageReads = 0;
  const mutableForMetrics = { ...first };
  Object.defineProperty(mutableForMetrics, "usage", {
    enumerable: true,
    get: () => {
      usageReads += 1;
      return usageReads === 1 ? first.usage : "SECRET_LEAK";
    }
  });
  const metrics = emitDeterministicMetrics([mutableForMetrics]);
  assert.equal(usageReads, 1);
  assert.equal(
    metrics.find(
      (metric) => metric.name === "agentic_tokens_total"
    )?.value,
    first.usage.tokens
  );
});

test("audit timestamps are bounded to millisecond precision", () => {
  const canonicalEvent = event(1, null);
  const oversizedTimestamp = "2026-08-28T00:00:00.1234Z";
  const {
    apiVersion: _apiVersion,
    kind: _kind,
    schemaVersion: _schemaVersion,
    ...input
  } = canonicalEvent;
  assert.throws(
    () => createAuditEvent({ ...input, occurredAt: oversizedTimestamp }),
    /not canonical/
  );
  assert.equal(
    validateDocument("AuditEvent", {
      ...canonicalEvent,
      occurredAt: oversizedTimestamp
    }).valid,
    false
  );
  assert.equal(
    (
      redactForAudit({
        ...canonicalEvent,
        occurredAt: oversizedTimestamp
      }) as Readonly<Record<string, AuditSafeValue>>
    )["occurredAt"],
    "[REDACTED:INVALID]"
  );
});

test("metrics have deterministic ordering and bounded labels", () => {
  const first = event(1, null);
  const second = event(2, digest(first), {
    component: "adapter",
    action: "invoke-tool",
    outcome: "refused",
    reasonCode: "TOOL_DENIED",
    usage: {
      attempts: 1,
      tokens: 0,
      costUnits: 0,
      toolCalls: 1,
      effects: 0,
      durationMs: 3
    }
  });
  const metrics = emitDeterministicMetrics([first, second]);
  assert.deepEqual(metrics, emitDeterministicMetrics([first, second]));
  assert.ok(metrics.every((metric) => validateDocument("MetricRecord", metric).valid));
  assert.equal(
    metrics
      .filter((metric) => metric.name === "agentic_cost_units_total")
      .reduce((total, metric) => total + metric.value, 0),
    3
  );
  assert.ok(
    metrics.every(
      (metric) =>
        Object.keys(metric.labels).sort().join(",") === "component,outcome"
    )
  );
  assert.deepEqual(
    metrics.map((metric) => `${metric.name}:${metric.labels.component}`),
    [...metrics]
      .map((metric) => `${metric.name}:${metric.labels.component}`)
      .sort()
  );
});

test("audit redaction removes credentials and bounds arbitrary values", () => {
  const longValue = "x".repeat(300);
  const redacted = redactForAudit({
    reasonCode: "RETAINED",
    authorization: "Bearer very-sensitive-token",
    apiKey: "another-secret",
    "x-api-key": "sk-live-examplevalue123",
    name: "password",
    value: "hunter2",
    [longValue]: true
  });
  assert.deepEqual(redacted, {
    _redacted_00: "[REDACTED:FIELD]",
    _redacted_01: "[REDACTED:FIELD]",
    _redacted_05: "[REDACTED:FIELD]",
    _redacted_06: "[REDACTED:FIELD]",
    name: "[REDACTED:INVALID]",
    value: "[REDACTED:INVALID]",
    reasonCode: "RETAINED"
  });
  assert.equal(JSON.stringify(redacted).includes("api-key"), false);
  assert.equal(JSON.stringify(redacted).includes("another-secret"), false);
  const canonicalEvent = event(1, null);
  assert.deepEqual(redactForAudit(canonicalEvent), canonicalEvent);
  assert.deepEqual(
    redactForAudit({
      usage: ["hunter2"],
      labels: ["customer@example.com"]
    }),
    {
      labels: "[REDACTED:INVALID]",
      usage: "[REDACTED:INVALID]"
    }
  );
  assert.throws(
    () => redactForAudit(["customer@example.com", "private business text"]),
    /plain diagnostic object/
  );
  assert.throws(() => redactForAudit("private business text"), /plain diagnostic object/);
});

test("run budgets authorize exact boundaries with durable digest evidence", () => {
  const previousDecisionDigest = digest("previous-budget-decision");
  const decision = evaluateRunBudget({
    budget: BUDGET,
    usage: ZERO_USAGE,
    reservation: {
      attempts: 2,
      fanout: 2,
      concurrency: 1,
      tokens: 1_000,
      toolCalls: 3,
      effects: 2
    },
    startedAt: "2026-08-28T00:29:00Z",
    evaluatedAt: "2026-08-28T00:29:59.999Z",
    previousDecisionDigest
  });
  assert.equal(decision.status, "authorized");
  assert.equal(decision.reasonCode, "AUTHORIZED");
  assert.equal(decision.startedAt, "2026-08-28T00:29:00Z");
  assert.equal(validateDocument("BudgetDecisionEvidence", decision).valid, true);
  assert.equal(decision.budgetDigest, digest(BUDGET));
  assert.equal(decision.previousDecisionDigest, previousDecisionDigest);
  assert.deepEqual(redactForAudit(decision), decision);
  const withoutPredecessor = { ...decision, previousDecisionDigest: null };
  assert.deepEqual(redactForAudit(withoutPredecessor), withoutPredecessor);
  for (const field of [
    "budgetDigest",
    "usageDigest",
    "reservationDigest",
    "previousDecisionDigest"
  ] as const) {
    const redacted = redactForAudit({
      ...decision,
      [field]: "sha256:invalid"
    }) as Readonly<Record<string, AuditSafeValue>>;
    assert.equal(redacted[field], "[REDACTED:INVALID]");
  }
  assert.deepEqual(
    redactForAudit({
      ...decision,
      budgetDigest: "sha256:invalid",
      projectedUsage: { ...decision.projectedUsage, unexpected: 1 }
    }),
    {
      apiVersion: decision.apiVersion,
      authorityDigest: decision.authorityDigest,
      budgetDigest: "[REDACTED:INVALID]",
      evaluatedAt: decision.evaluatedAt,
      kind: decision.kind,
      previousDecisionDigest: decision.previousDecisionDigest,
      projectedUsage: "[REDACTED:INVALID]",
      reasonCode: decision.reasonCode,
      reservationDigest: decision.reservationDigest,
      schemaVersion: decision.schemaVersion,
      startedAt: decision.startedAt,
      status: decision.status,
      usageDigest: decision.usageDigest
    }
  );
});

test("run budgets fail closed for each exhausted ceiling", () => {
  const cases = [
    ["ATTEMPT_LIMIT_EXHAUSTED", { attempts: 3 }],
    ["FANOUT_LIMIT_EXHAUSTED", { fanout: 3 }],
    ["CONCURRENCY_LIMIT_EXHAUSTED", { concurrency: 2 }],
    ["TOKEN_LIMIT_EXHAUSTED", { tokens: 1_001 }],
    ["TOOL_LIMIT_EXHAUSTED", { toolCalls: 4 }],
    ["EFFECT_LIMIT_EXHAUSTED", { effects: 3 }]
  ] as const;
  for (const [reasonCode, change] of cases) {
    const decision = evaluateRunBudget({
      budget: BUDGET,
      usage: ZERO_USAGE,
      reservation: { ...ZERO_RESERVATION, ...change },
      startedAt: "2026-08-28T00:00:00Z",
      evaluatedAt: "2026-08-28T00:00:01Z",
      previousDecisionDigest: null
    });
    assert.equal(decision.status, "refused");
    assert.equal(decision.reasonCode, reasonCode);
    assert.equal(validateDocument("BudgetDecisionEvidence", decision).valid, true);
  }
  assert.equal(
    evaluateRunBudget({
      budget: BUDGET,
      usage: ZERO_USAGE,
      reservation: ZERO_RESERVATION,
      startedAt: "2026-08-28T00:00:00Z",
      evaluatedAt: "2026-08-28T00:01:00Z",
      previousDecisionDigest: null
    }).reasonCode,
    "WALL_CLOCK_EXHAUSTED"
  );
  assert.equal(
    evaluateRunBudget({
      budget: BUDGET,
      usage: ZERO_USAGE,
      reservation: ZERO_RESERVATION,
      startedAt: "2026-08-28T00:00:00Z",
      evaluatedAt: BUDGET.expiresAt,
      previousDecisionDigest: null
    }).reasonCode,
    "BUDGET_EXPIRED"
  );
  assert.throws(
    () =>
      evaluateRunBudget({
        budget: { ...BUDGET, authorityDigest: "sha256:invalid" as never },
        usage: ZERO_USAGE,
        reservation: ZERO_RESERVATION,
        startedAt: "2026-08-28T00:00:00Z",
        evaluatedAt: "2026-08-28T00:00:01Z",
        previousDecisionDigest: null
      }),
    /not canonical/
  );
  assert.throws(
    () =>
      evaluateRunBudget({
        budget: BUDGET,
        usage: { ...ZERO_USAGE, unexpected: 1 } as RunUsage,
        reservation: ZERO_RESERVATION,
        startedAt: "2026-08-28T00:00:00Z",
        evaluatedAt: "2026-08-28T00:00:01Z",
        previousDecisionDigest: null
      }),
    /fields are not canonical/
  );
});

test("run budget evaluation snapshots mutable inputs once", () => {
  let maxTokenReads = 0;
  const mutableBudget = Object.defineProperty(
    { ...BUDGET },
    "maxTokens",
    {
      enumerable: true,
      get: () => {
        maxTokenReads += 1;
        return maxTokenReads === 1 ? 1_000 : 1_000_000;
      }
    }
  ) as RunBudget;
  const decision = evaluateRunBudget({
    budget: mutableBudget,
    usage: ZERO_USAGE,
    reservation: { ...ZERO_RESERVATION, tokens: 1_001 },
    startedAt: "2026-08-28T00:00:00Z",
    evaluatedAt: "2026-08-28T00:00:01Z",
    previousDecisionDigest: null
  });
  assert.equal(maxTokenReads, 1);
  assert.equal(decision.status, "refused");
  assert.equal(decision.reasonCode, "TOKEN_LIMIT_EXHAUSTED");
  assert.equal(
    decision.budgetDigest,
    digest({ ...BUDGET, maxTokens: 1_000 })
  );
});
