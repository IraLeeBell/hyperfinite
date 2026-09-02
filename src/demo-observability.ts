import { digest } from "./canonical.js";
import {
  createAuditEvent,
  emitDeterministicMetrics,
  redactForAudit,
  serializeAuditEvents,
  type AuditAction,
  type AuditEvent,
  type AuditOutcome,
  type AuditSafeValue,
  type MetricRecord
} from "./observability.js";
import type { Digest } from "./types.js";

export const DEMO_RUNTIME_AUDIT_KINDS = [
  "stage",
  "stage-start",
  "stage-complete",
  "block",
  "run-attempt",
  "binding",
  "lifecycle-transition",
  "artifact",
  "budget-reservation",
  "model-usage",
  "tool-usage",
  "cost-usage",
  "provider-usage",
  "retry",
  "refusal",
  "projection",
  "draft-pr",
  "human-action",
  "reconciliation",
  "recovery",
  "selection-requested",
  "selection-accepted",
  "selection-refused",
  "selection-stale",
  "selection-reconciled",
  "fixed-agent-resolved",
  "selected-agent-resolved",
  "dispatch-started",
  "dispatch-completed",
  "direct-unbound-invocation-refused",
  "project-bootstrap-planned",
  "project-bootstrap-confirmed",
  "project-bootstrap-applied",
  "project-bootstrap-reconciled"
] as const;

export type DemoRuntimeAuditKind =
  (typeof DEMO_RUNTIME_AUDIT_KINDS)[number];

export interface DemoRuntimeAuditInput {
  readonly kind: DemoRuntimeAuditKind;
  readonly occurredAt: string;
  readonly outcome: AuditOutcome;
  readonly reasonCode: string;
  readonly authorityDigest: Digest;
  readonly subjectDigest: Digest;
  readonly usage: {
    readonly attempts: number;
    readonly tokens: number;
    readonly costUnits?: number;
    readonly toolCalls: number;
    readonly effects: number;
    readonly durationMs: number;
  };
}

export interface DemoRuntimeObservabilityBatch {
  readonly events: readonly AuditEvent[];
  readonly newlineDelimitedJson: string;
  readonly metrics: readonly MetricRecord[];
  readonly redacted: readonly AuditSafeValue[];
}

const ACTION_BY_KIND: Readonly<Record<DemoRuntimeAuditKind, AuditAction>> = {
  stage: "transition",
  "stage-start": "transition",
  "stage-complete": "transition",
  block: "transition",
  "run-attempt": "invoke-model",
  binding: "authorize",
  "lifecycle-transition": "transition",
  artifact: "plan-effect",
  "budget-reservation": "reserve-budget",
  "model-usage": "invoke-model",
  "tool-usage": "invoke-tool",
  "cost-usage": "release-budget",
  "provider-usage": "release-budget",
  retry: "reconcile",
  refusal: "authorize",
  projection: "apply-effect",
  "draft-pr": "plan-effect",
  "human-action": "human-gate",
  reconciliation: "reconcile",
  recovery: "reconcile",
  "selection-requested": "authorize",
  "selection-accepted": "authorize",
  "selection-refused": "authorize",
  "selection-stale": "reconcile",
  "selection-reconciled": "reconcile",
  "fixed-agent-resolved": "authorize",
  "selected-agent-resolved": "authorize",
  "dispatch-started": "invoke-model",
  "dispatch-completed": "release-budget",
  "direct-unbound-invocation-refused": "authorize",
  "project-bootstrap-planned": "plan-effect",
  "project-bootstrap-confirmed": "human-gate",
  "project-bootstrap-applied": "apply-effect",
  "project-bootstrap-reconciled": "reconcile"
};

function fail(message: string): never {
  throw new TypeError(message);
}

export function createDemoRuntimeObservabilityBatch(
  inputs: readonly DemoRuntimeAuditInput[]
): DemoRuntimeObservabilityBatch {
  if (inputs.length > 256) {
    fail("demo runtime audit batch exceeds its bounded cardinality");
  }
  let previous: Digest | null = null;
  const events = inputs.map((input, index) => {
    if (!DEMO_RUNTIME_AUDIT_KINDS.includes(input.kind)) {
      fail("demo runtime audit kind is not closed");
    }
    const event = createAuditEvent({
      sequence: index + 1,
      occurredAt: input.occurredAt,
      component: "runtime",
      action: ACTION_BY_KIND[input.kind],
      outcome: input.outcome,
      reasonCode: input.reasonCode,
      authorityDigest: input.authorityDigest,
      subjectDigest: input.subjectDigest,
      previousEventDigest: previous,
      usage: {
        ...input.usage,
        costUnits: input.usage.costUnits ?? 0
      }
    });
    previous = digest(event);
    return event;
  });
  const redacted = events.map((event) => redactForAudit(event));
  return Object.freeze({
    events: Object.freeze(events),
    newlineDelimitedJson: serializeAuditEvents(events),
    metrics: emitDeterministicMetrics(events),
    redacted: Object.freeze(redacted)
  });
}
