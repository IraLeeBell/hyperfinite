#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import process from "node:process";

import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnySchema } from "ajv";

import hardeningPlanSchema from "../schemas/v1alpha1/demo-portfolio-hardening-plan.schema.json" with { type: "json" };
import { canonicalJson, digest } from "../src/canonical.js";
import { parseStrictJson } from "../src/strict-json.js";

const forbidden = process.argv
  .slice(2)
  .find((argument) =>
    /(?:^|[-_:])(live|apply|execute|github|network|credential|paid)(?:$|[-_=])/iu.test(
      argument
    )
  );
if (forbidden !== undefined) {
  throw new TypeError(
    `live hardening option ${forbidden} is forbidden before environment or credential reads`
  );
}
if (process.argv.length !== 2) {
  throw new TypeError("the hardening gate accepts no command-line options");
}

type DemoProjectId =
  | "app-modernization"
  | "feature-delivery"
  | "security-dependency-remediation"
  | "adaptive-delivery";

interface HardeningPlan {
  readonly apiVersion: "agentic-framework.github.com/v1alpha1";
  readonly kind: "DemoPortfolioHardeningPlan";
  readonly schemaVersion: "1.0.0";
  readonly generatedAt: string;
  readonly mode: "hermetic";
  readonly demos: readonly DemoProjectId[];
  readonly testFiles: readonly string[];
  readonly demoAnchors: Readonly<Record<DemoProjectId, readonly string[]>>;
  readonly scenarios: readonly {
    readonly id: string;
    readonly outcome:
      | "accepted"
      | "refused"
      | "blocked"
      | "reconciled"
      | "human-gated";
    readonly beforePaidInference: boolean;
    readonly beforeMutation: boolean;
    readonly tests: readonly string[];
  }[];
  readonly faultBoundaries: readonly {
    readonly id: string;
    readonly beforePaidInference: boolean;
    readonly beforeMutation: boolean;
    readonly ambiguousOutcome: "exact-readback-or-blocked";
    readonly tests: readonly string[];
  }[];
  readonly requiredInvariants: readonly string[];
  readonly readiness: {
    readonly repositoryClassification: "repository-hermetic-demo-ready";
    readonly sandboxLiveClassification: "blocked-pending-human-administration-and-canary";
    readonly productionClassification: "customer-approval-required";
    readonly projectsProvisioned: false;
    readonly liveModeEnabled: false;
    readonly requiredCanaryStage: "human-review";
  };
}

interface SimulationResult {
  readonly demos: readonly {
    readonly demoProjectId: DemoProjectId;
    readonly handsOffStop: string;
    readonly modelInvocations: number;
    readonly reviewEvent: string;
  }[];
  readonly substitutions: readonly {
    readonly result: string;
    readonly beforeInference: boolean;
    readonly beforeEffects: boolean;
  }[];
  readonly invariants: Readonly<Record<string, boolean | string>>;
  readonly externalCallCounters: Readonly<Record<string, number>>;
  readonly externalCallCounterScope:
    "fixture-declared-external-call-assertions";
  readonly traceDigest: string;
}

const EXPECTED_DEMOS = [
  "app-modernization",
  "feature-delivery",
  "security-dependency-remediation",
  "adaptive-delivery"
] as const satisfies readonly DemoProjectId[];

const EXPECTED_EXTERNAL_COUNTERS = [
  "credentials",
  "github",
  "network",
  "paidInference"
] as const;

const EXPECTED_TEST_FILES = [
  "dist/tests/control-kernel.test.js",
  "dist/tests/copilot-runtime.test.js",
  "dist/tests/github-adapter.test.js",
  "dist/tests/bounded-worktree.test.js",
  "dist/tests/demo-portfolio.test.js",
  "dist/tests/demo-runtime.test.js",
  "dist/tests/project-ux.test.js",
  "dist/tests/demo-integration.test.js",
  "dist/tests/app-modernization-demo.test.js",
  "dist/tests/feature-delivery-demo.test.js",
  "dist/tests/security-dependency-remediation-demo.test.js",
  "dist/tests/engineering-slice.test.js",
  "dist/tests/domain-packs.test.js",
  "dist/tests/security-regression.test.js",
  "dist/tests/packaging.test.js",
  "dist/tests/observability.test.js",
  "dist/tests/portfolio-hardening.test.js",
  "dist/tests/review-agent-runtime.test.js",
  "dist/tests/adaptive-delivery-demo.test.js",
  "dist/tests/hybrid-agent-selection.test.js",
  "dist/tests/github-project-bootstrap.test.js"
] as const;

const EXPECTED_SCENARIOS = [
  "stage-agent-exclusivity",
  "binding-capability-mismatch",
  "repository-substitution",
  "issue-substitution",
  "project-substitution",
  "unauthorized-submitter",
  "missing-consent",
  "disabled-profile",
  "expired-profile",
  "revoked-profile",
  "budget-exhaustion",
  "duplicate-event",
  "out-of-order-event",
  "concurrent-event",
  "stale-project",
  "stale-repository",
  "stale-base",
  "stale-pr-head",
  "stale-current-head",
  "missing-evidence",
  "wrong-evidence",
  "stale-evidence",
  "model-target-attempt",
  "model-path-attempt",
  "model-next-stage-attempt",
  "model-route-attempt",
  "model-effect-attempt",
  "prompt-injection",
  "malformed-artifact",
  "oversized-artifact",
  "path-traversal",
  "symlink-attack",
  "case-collision",
  "mode-change",
  "binary-change",
  "rename-attack",
  "submodule-attack",
  "partial-acknowledgement",
  "lost-acknowledgement",
  "pause",
  "resume",
  "block",
  "cancel",
  "repair",
  "replan",
  "revision",
  "retry-ceiling",
  "generation-invalidation",
  "authorization-invalidation",
  "cross-demo-confusion",
  "draft-only-pull-request",
  "current-head-review",
  "comment-only-review",
  "refuse-approve",
  "refuse-dismiss",
  "refuse-merge",
  "refuse-deploy",
  "refuse-publish",
  "unsupported-environment",
  "zero-fixture-declared-external-calls"
] as const;

const EXPECTED_BOUNDARIES = [
  "credential-broker",
  "activation-lease",
  "activation-claim",
  "dispatch-persistence",
  "budget-reservation",
  "run-fence",
  "post-await-authorization",
  "provider-attempt",
  "provider-invocation",
  "provider-usage-reconciliation",
  "budget-settlement",
  "fence-release",
  "stage-artifact",
  "stage-receipt",
  "kernel-persistence",
  "run-state-persistence",
  "project-field-cas",
  "project-readback",
  "branch-creation",
  "commit-creation",
  "draft-pr-creation",
  "review-evidence",
  "comment-application",
  "closure",
  "cost-release",
  "evidence-ledger",
  "trust-service-unavailability",
  "acknowledgement"
] as const;

const EXPECTED_INVARIANTS = [
  "all-demos-stop-at-human-review",
  "project-never-leads-kernel",
  "kernel-receipt-before-projection",
  "stage-written-last",
  "read-after-write-before-next-event",
  "draft-pull-requests-only",
  "current-head-required",
  "automated-review-comment-only",
  "automation-cannot-approve",
  "automation-cannot-merge",
  "zero-fixture-declared-external-calls",
  "live-mode-disabled",
  "projects-not-provisioned"
] as const;

function exactOrderedValues(
  actual: readonly string[],
  expected: readonly string[],
  label: string
): void {
  if (
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    throw new TypeError(`${label} differs from its closed canonical order`);
  }
}

const planValue = parseStrictJson(
  readFileSync("config/v1alpha1/demo-portfolio/hardening-plan.json", "utf8")
);
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validatePlan = ajv.compile<HardeningPlan>(
  hardeningPlanSchema as AnySchema
);
function assertHardeningPlan(value: unknown): asserts value is HardeningPlan {
  if (!validatePlan(value)) {
    throw new TypeError(
      `hardening plan is invalid: ${ajv.errorsText(validatePlan.errors)}`
    );
  }
}
assertHardeningPlan(planValue);
const plan = planValue;
exactOrderedValues(plan.demos, EXPECTED_DEMOS, "demo set");
exactOrderedValues(plan.testFiles, EXPECTED_TEST_FILES, "hardening test file set");
exactOrderedValues(
  plan.scenarios.map((scenario) => scenario.id),
  EXPECTED_SCENARIOS,
  "hardening scenario set"
);
exactOrderedValues(
  plan.faultBoundaries.map((boundary) => boundary.id),
  EXPECTED_BOUNDARIES,
  "fault boundary set"
);
exactOrderedValues(
  plan.requiredInvariants,
  EXPECTED_INVARIANTS,
  "hardening invariant set"
);

const allIds = [
  ...plan.scenarios.map((scenario) => scenario.id),
  ...plan.faultBoundaries.map((boundary) => boundary.id)
];
if (new Set(allIds).size !== allIds.length) {
  throw new TypeError("hardening scenario and boundary IDs must be globally unique");
}

const childEnvironment = {
  PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
  HOME: tmpdir(),
  LANG: "C",
  CI: "true",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0"
} as const;

function run(executable: string, args: readonly string[]): string {
  const result = spawnSync(executable, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: "pipe",
    env: childEnvironment,
    maxBuffer: 32 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new TypeError(
      `${executable} ${args.join(" ")} failed: ${result.stderr || result.stdout}`
    );
  }
  return result.stdout;
}

const junit = run(process.execPath, [
  "--import=./dist/scripts/deny-network.js",
  "--test",
  "--test-reporter=junit",
  ...plan.testFiles
]);
if (/<(?:failure|error|skipped)\b/iu.test(junit)) {
  throw new TypeError(
    "hardening JUnit contains a failed, errored, skipped, or todo test"
  );
}

const passedTestNameCounts = new Map<string, number>();
for (const match of junit.matchAll(/<testcase\b([^>]*)\/?>/gu)) {
  const name = /\bname="([^"]+)"/u.exec(match[1] ?? "")?.[1];
  if (name === undefined) {
    throw new TypeError("hardening JUnit testcase omitted its name");
  }
  passedTestNameCounts.set(name, (passedTestNameCounts.get(name) ?? 0) + 1);
}

const referencedTests = new Set([
  ...Object.values(plan.demoAnchors).flat(),
  ...plan.scenarios.flatMap((scenario) => scenario.tests),
  ...plan.faultBoundaries.flatMap((boundary) => boundary.tests)
]);
for (const testName of referencedTests) {
  if (passedTestNameCounts.get(testName) !== 1) {
    throw new TypeError(
      `hardening evidence requires exactly one passing testcase named ${testName}`
    );
  }
}

const simulationCommand = [
  "--import=./dist/scripts/deny-network.js",
  "dist/scripts/simulate-demos.js"
] as const;
const firstSimulation = run(process.execPath, simulationCommand);
const secondSimulation = run(process.execPath, simulationCommand);
if (firstSimulation !== secondSimulation) {
  throw new TypeError("portfolio simulation output is not byte deterministic");
}
const simulation = JSON.parse(firstSimulation) as SimulationResult;
exactOrderedValues(
  simulation.demos.map((demo) => demo.demoProjectId),
  EXPECTED_DEMOS,
  "simulated demo set"
);
if (
  simulation.demos.some(
    (demo) =>
      demo.handsOffStop !== "human-review" ||
      demo.modelInvocations !== 5 ||
      demo.reviewEvent !== "COMMENT"
  )
) {
  throw new TypeError("a demo did not stop at COMMENT-only Human Review");
}
if (
  simulation.substitutions.length !== 96 ||
  simulation.substitutions.some(
    (substitution) =>
      substitution.result !== "refused" ||
      !substitution.beforeInference ||
      !substitution.beforeEffects
  )
) {
  throw new TypeError("cross-demo substitution evidence is incomplete");
}
exactOrderedValues(
  Object.keys(simulation.externalCallCounters).sort(),
  EXPECTED_EXTERNAL_COUNTERS,
  "external call counter set"
);
if (
  simulation.externalCallCounterScope !==
    "fixture-declared-external-call-assertions"
) {
  throw new TypeError("simulator external call counter scope is invalid");
}
if (
  Object.values(simulation.externalCallCounters).some(
    (count) => !Number.isSafeInteger(count) || count !== 0
  )
) {
  throw new TypeError("hardening evidence observed a nonzero external call");
}

const invariantResults = {
  "all-demos-stop-at-human-review": true,
  "project-never-leads-kernel":
    simulation.invariants["projectNeverLeadsKernel"] === true,
  "kernel-receipt-before-projection":
    simulation.invariants["kernelReceiptBeforeProjectProjection"] === true,
  "stage-written-last": simulation.invariants["stageWrittenLast"] === true,
  "read-after-write-before-next-event":
    simulation.invariants["fullReadAfterWriteBeforeNextEvent"] === true,
  "draft-pull-requests-only":
    simulation.invariants["draftPullRequestsOnly"] === true,
  "current-head-required":
    simulation.invariants["currentHeadRequired"] === true,
  "automated-review-comment-only":
    simulation.invariants["automatedReviewEvent"] === "COMMENT",
  "automation-cannot-approve":
    simulation.invariants["automationCanApprove"] === false,
  "automation-cannot-merge":
    simulation.invariants["automationCanMerge"] === false,
  "zero-fixture-declared-external-calls": true,
  "live-mode-disabled": plan.readiness.liveModeEnabled === false,
  "projects-not-provisioned": plan.readiness.projectsProvisioned === false
} as const;
if (Object.values(invariantResults).some((result) => !result)) {
  throw new TypeError("one or more required hardening invariants failed");
}

const executedTestFiles = plan.testFiles.map((path) => ({
  path,
  compiledContentDigest: digest(readFileSync(path, "utf8"))
}));
const passedTestEvidence = [...referencedTests].sort().map((testName) => ({
  testName,
  passed: passedTestNameCounts.get(testName) === 1
}));
const testEvidenceDigest = digest({
  executedTestFiles,
  passedTestEvidence
});
const body = {
  apiVersion: "agentic-framework.github.com/v1alpha1",
  kind: "DemoPortfolioHardeningEvidence",
  schemaVersion: "1.0.0",
  generatedAt: plan.generatedAt,
  mode: plan.mode,
  planDigest: digest(plan),
  testEvidenceDigest,
  executedTestFiles,
  simulationTraceDigest: simulation.traceDigest,
  simulationBytesDigest: digest(firstSimulation),
  demos: plan.demos.map((demoProjectId) => {
    const simulationDemo = simulation.demos.find(
      (candidate) => candidate.demoProjectId === demoProjectId
    );
    if (simulationDemo === undefined) {
      throw new TypeError(`simulator omitted ${demoProjectId}`);
    }
    const simulationEvidenceDigest = digest(simulationDemo);
    return {
      demoProjectId,
      simulationEvidenceDigest,
      anchorTests: plan.demoAnchors[demoProjectId],
      scenarios: plan.scenarios.map((scenario) => ({
        id: scenario.id,
        outcome: scenario.outcome,
        beforePaidInference: scenario.beforePaidInference,
        beforeMutation: scenario.beforeMutation,
        tests: scenario.tests,
        evidenceDigest: digest({
          demoProjectId,
          scenarioId: scenario.id,
          simulationEvidenceDigest,
          anchorTests: plan.demoAnchors[demoProjectId],
          tests: scenario.tests,
          testEvidenceDigest
        })
      }))
    };
  }),
  faultBoundaries: plan.faultBoundaries.map((boundary) => ({
    ...boundary,
    result: "passed",
    evidenceDigest: digest({
      boundary,
      testEvidenceDigest,
      simulationTraceDigest: simulation.traceDigest
    })
  })),
  crossDemoSubstitutionCount: simulation.substitutions.length,
  externalCallCounterScope: simulation.externalCallCounterScope,
  externalCallCounters: simulation.externalCallCounters,
  invariants: invariantResults,
  readiness: plan.readiness
};
process.stdout.write(
  `${canonicalJson({ ...body, evidenceDigest: digest(body) })}\n`
);
