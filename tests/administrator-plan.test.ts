import assert from "node:assert/strict";
import { test } from "node:test";

import { digest } from "../src/canonical.js";
import {
  AdministratorPlanError,
  REQUIRED_CHECK_NAMES,
  checkReadbackDriftCoherence,
  compareAdministratorReadback,
  planAdministratorConfiguration,
  validateAdministratorPlan,
  type AdministratorPlan,
  type AdministratorPlanInput,
  type AdministratorReadback,
  type AdministratorRulesetPlan
} from "../src/administrator-plan.js";
import type { GitHubRepositoryIdentity } from "../src/github-events.js";
import { validateDocument } from "../src/validation.js";

function repository(): GitHubRepositoryIdentity {
  return {
    id: 987654321,
    nodeId: "R_synthetic_hyperfinite",
    owner: "example-organization",
    name: "example-repository",
    fullName: "example-organization/example-repository"
  };
}

function mainBranchRuleset(): AdministratorRulesetPlan {
  return {
    rulesetId: "main-branch-ruleset",
    source: "organization",
    target: "branch",
    refConditions: { include: ["refs/heads/main"], exclude: [] },
    effectiveProtectedRefs: ["refs/heads/main"],
    enforcement: "active",
    bypassActors: [],
    requiresPullRequest: true,
    requiresCodeownerReview: true,
    requiresCurrentHeadApproval: true
  };
}

function validInput(): AdministratorPlanInput {
  return {
    generatedAt: "2026-08-28T00:00:00Z",
    repository: repository(),
    rulesets: [mainBranchRuleset()],
    environments: [
      { environmentId: "copilot", requiresReviewers: true, hasProtectionRules: true }
    ],
    projectBinding: {
      projectNumber: 1,
      ownerLogin: "example-organization",
      schemaDigest: "sha256:" + "a".repeat(64),
      mutationRequiresExplicitConfirmation: true
    },
    incidentContacts: [{ role: "security-owner", contactHandle: "synthetic-owner" }]
  };
}

const FRESHNESS = { now: "2026-08-28T01:10:00Z", maxAgeMs: 60 * 60 * 1000 };

function cleanReadback(plan: AdministratorPlan, observedAt = "2026-08-28T01:00:00Z"): AdministratorReadback {
  return {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "AdministratorReadback",
    schemaVersion: "1.0.0",
    observedAt,
    planDigest: digest(plan),
    repository: plan.repository,
    classicBranchProtectionObserved: false,
    rulesets: plan.rulesets.map((ruleset) => ({ ...ruleset })),
    environments: plan.environments.map((environment) => ({ ...environment })),
    requiredChecks: plan.requiredChecks.map((check) => ({ ...check })),
    actionsPolicy: { ...plan.actionsPolicy },
    ghas: { ...plan.ghas },
    projectBinding: { ...plan.projectBinding },
    incidentContacts: plan.incidentContacts.map((contact) => ({ ...contact })),
    nonAuthoritative: { ...plan.nonAuthoritative },
    driftFound: false
  };
}

test("planAdministratorConfiguration emits the complete closed required-check catalog", () => {
  const plan = planAdministratorConfiguration(validInput());
  assert.deepEqual(
    plan.requiredChecks.map((check) => check.checkName).sort(),
    [...REQUIRED_CHECK_NAMES].sort()
  );
  assert.deepEqual(validateAdministratorPlan(plan), []);
  const result = validateDocument("AdministratorPlan", plan);
  assert.equal(result.valid, true);
});

test("planAdministratorConfiguration fails closed with no rulesets", () => {
  const input = validInput();
  assert.throws(
    () => planAdministratorConfiguration({ ...input, rulesets: [] }),
    AdministratorPlanError
  );
});

test("planAdministratorConfiguration fails closed with no incident contacts", () => {
  const input = validInput();
  assert.throws(
    () => planAdministratorConfiguration({ ...input, incidentContacts: [] }),
    AdministratorPlanError
  );
});

test("validateAdministratorPlan rejects a ruleset that declares a bypass actor", () => {
  const plan = planAdministratorConfiguration(validInput());
  const tampered: AdministratorPlan = {
    ...plan,
    rulesets: plan.rulesets.map((ruleset) => ({
      ...ruleset,
      bypassActors: ["synthetic-bypass-actor"]
    }))
  };
  const issues = validateAdministratorPlan(tampered);
  assert.ok(issues.some((issue) => issue.message.includes("bypass actor")));
});

test("validateAdministratorPlan rejects an omitted required check", () => {
  const plan = planAdministratorConfiguration(validInput());
  const tampered: AdministratorPlan = {
    ...plan,
    requiredChecks: plan.requiredChecks.filter((check) => check.checkName !== "codeql")
  };
  const issues = validateAdministratorPlan(tampered);
  assert.ok(issues.some((issue) => issue.message.includes("codeql")));
});

test("validateAdministratorPlan rejects effectiveProtectedRefs that do not match refConditions", () => {
  const plan = planAdministratorConfiguration(validInput());
  const tampered: AdministratorPlan = {
    ...plan,
    rulesets: plan.rulesets.map((ruleset) => ({
      ...ruleset,
      effectiveProtectedRefs: ["refs/heads/develop"]
    }))
  };
  const issues = validateAdministratorPlan(tampered);
  assert.ok(
    issues.some((issue) => issue.path === "/rulesets/main-branch-ruleset/effectiveProtectedRefs")
  );
});

test("validateAdministratorPlan rejects a ruleset whose ref is outside its target's namespace", () => {
  const plan = planAdministratorConfiguration(validInput());
  const tampered: AdministratorPlan = {
    ...plan,
    rulesets: plan.rulesets.map((ruleset) => ({
      ...ruleset,
      refConditions: { include: ["refs/tags/v1"], exclude: [] },
      effectiveProtectedRefs: ["refs/tags/v1"]
    }))
  };
  const issues = validateAdministratorPlan(tampered);
  assert.ok(
    issues.some((issue) => issue.message.includes("does not start with refs/heads/"))
  );
});

test("validateAdministratorPlan rejects a main-named ruleset that does not protect refs/heads/main", () => {
  const plan = planAdministratorConfiguration(validInput());
  const tampered: AdministratorPlan = {
    ...plan,
    rulesets: plan.rulesets.map((ruleset) => ({
      ...ruleset,
      refConditions: { include: ["refs/heads/develop"], exclude: [] },
      effectiveProtectedRefs: ["refs/heads/develop"]
    }))
  };
  const issues = validateAdministratorPlan(tampered);
  assert.ok(
    issues.some((issue) => issue.message.includes("implies the default main branch"))
  );
});

test("validateAdministratorPlan rejects a wildcard ref pattern in refConditions.include", () => {
  const plan = planAdministratorConfiguration(validInput());
  const tampered: AdministratorPlan = {
    ...plan,
    rulesets: plan.rulesets.map((ruleset) => ({
      ...ruleset,
      refConditions: { include: ["refs/heads/*"], exclude: [] },
      effectiveProtectedRefs: ["refs/heads/*"]
    }))
  };
  const issues = validateAdministratorPlan(tampered);
  assert.ok(
    issues.some((issue) => issue.path === "/rulesets/main-branch-ruleset/refConditions"),
    "a wildcard ref must be rejected because exact-set ref arithmetic is unsound over globs"
  );
});

test("validateAdministratorPlan rejects a wildcard exclude that would otherwise misstate main as protected", () => {
  // This is exactly the unsound scenario a naive literal-string exclusion
  // check could misjudge: an administrator declares a wildcard exclude
  // intending to remove refs/heads/main from protection, but a literal
  // string comparison against "refs/heads/*" would never match
  // "refs/heads/main" and would incorrectly leave it in
  // effectiveProtectedRefs. Because wildcards are rejected outright, this
  // ambiguity can never reach the exact-set-subtraction logic.
  const plan = planAdministratorConfiguration(validInput());
  const tampered: AdministratorPlan = {
    ...plan,
    rulesets: plan.rulesets.map((ruleset) => ({
      ...ruleset,
      refConditions: { include: ["refs/heads/main"], exclude: ["refs/heads/*"] },
      effectiveProtectedRefs: ["refs/heads/main"]
    }))
  };
  const issues = validateAdministratorPlan(tampered);
  assert.ok(issues.some((issue) => issue.path === "/rulesets/main-branch-ruleset/refConditions"));
});

test("validateAdministratorPlan correctly zeroes out protection when a literal exclude matches a literal include", () => {
  // Demonstrates that, once refs are guaranteed literal, exact-set
  // subtraction is sound: excluding the exact same ref an include
  // condition names must leave nothing protected, and the plan must fail
  // closed on "must protect at least one ref" rather than silently passing.
  const plan = planAdministratorConfiguration(validInput());
  const tampered: AdministratorPlan = {
    ...plan,
    rulesets: plan.rulesets.map((ruleset) => ({
      ...ruleset,
      refConditions: { include: ["refs/heads/main"], exclude: ["refs/heads/main"] },
      effectiveProtectedRefs: []
    }))
  };
  const issues = validateAdministratorPlan(tampered);
  assert.ok(
    issues.some((issue) => issue.message.includes("must protect at least one ref"))
  );
});

test("validateAdministratorPlan rejects a duplicate rulesetId", () => {
  const plan = planAdministratorConfiguration(validInput());
  const tampered: AdministratorPlan = {
    ...plan,
    rulesets: [...plan.rulesets, ...plan.rulesets]
  };
  const issues = validateAdministratorPlan(tampered);
  assert.ok(issues.some((issue) => issue.path === "/rulesets" && issue.message.includes("main-branch-ruleset")));
});

test("validateAdministratorPlan rejects a duplicate environmentId", () => {
  const plan = planAdministratorConfiguration(validInput());
  const tampered: AdministratorPlan = {
    ...plan,
    environments: [...plan.environments, ...plan.environments]
  };
  const issues = validateAdministratorPlan(tampered);
  assert.ok(issues.some((issue) => issue.path === "/environments" && issue.message.includes("copilot")));
});

test("validateAdministratorPlan rejects a duplicate incident contact role", () => {
  const plan = planAdministratorConfiguration(validInput());
  const tampered: AdministratorPlan = {
    ...plan,
    incidentContacts: [
      ...plan.incidentContacts,
      { role: "security-owner", contactHandle: "different-owner-same-role" }
    ]
  };
  const issues = validateAdministratorPlan(tampered);
  assert.ok(
    issues.some((issue) => issue.path === "/incidentContacts" && issue.message.includes("security-owner"))
  );
});

test("validateAdministratorPlan rejects a disabled GHAS field", () => {
  const plan = planAdministratorConfiguration(validInput());
  const tampered: AdministratorPlan = {
    ...plan,
    ghas: { ...plan.ghas, secretScanningPushProtection: false as never }
  };
  const issues = validateAdministratorPlan(tampered);
  assert.ok(issues.some((issue) => issue.path === "/ghas/secretScanningPushProtection"));
});

test("validateAdministratorPlan rejects an enabled delegated-bypass field", () => {
  const plan = planAdministratorConfiguration(validInput());
  const tampered: AdministratorPlan = {
    ...plan,
    ghas: { ...plan.ghas, delegatedBypass: true as never }
  };
  const issues = validateAdministratorPlan(tampered);
  assert.ok(issues.some((issue) => issue.path === "/ghas/delegatedBypass"));
});

test("validateAdministratorPlan rejects a disabled fork-pull-request approval requirement", () => {
  const plan = planAdministratorConfiguration(validInput());
  const tampered: AdministratorPlan = {
    ...plan,
    actionsPolicy: { ...plan.actionsPolicy, requireApprovalForForkPullRequests: false as never }
  };
  const issues = validateAdministratorPlan(tampered);
  assert.ok(issues.some((issue) => issue.path === "/actionsPolicy/requireApprovalForForkPullRequests"));
});

test("validateAdministratorPlan rejects a disabled SHA-pinning requirement", () => {
  const plan = planAdministratorConfiguration(validInput());
  const tampered: AdministratorPlan = {
    ...plan,
    actionsPolicy: { ...plan.actionsPolicy, shaPinningRequired: false as never }
  };
  const issues = validateAdministratorPlan(tampered);
  assert.ok(issues.some((issue) => issue.path === "/actionsPolicy/shaPinningRequired"));
});

test("validateAdministratorPlan rejects non-read default workflow permissions", () => {
  const plan = planAdministratorConfiguration(validInput());
  const tampered: AdministratorPlan = {
    ...plan,
    actionsPolicy: { ...plan.actionsPolicy, defaultWorkflowPermissions: "write" as never }
  };
  const issues = validateAdministratorPlan(tampered);
  assert.ok(issues.some((issue) => issue.path === "/actionsPolicy/defaultWorkflowPermissions"));
});

test("validateAdministratorPlan rejects an environment that does not require reviewers", () => {
  const plan = planAdministratorConfiguration(validInput());
  const tampered: AdministratorPlan = {
    ...plan,
    environments: plan.environments.map((environment) => ({
      ...environment,
      requiresReviewers: false as never
    }))
  };
  const issues = validateAdministratorPlan(tampered);
  assert.ok(issues.some((issue) => issue.path === "/environments/copilot/requiresReviewers"));
});

test("compareAdministratorReadback accepts a readback that exactly matches the plan", () => {
  const plan = planAdministratorConfiguration(validInput());
  const readback = cleanReadback(plan);
  assert.deepEqual(compareAdministratorReadback(plan, readback, FRESHNESS), []);
  const result = validateDocument("AdministratorReadback", readback);
  assert.equal(result.valid, true);
});

test("compareAdministratorReadback fails closed when Actions allows all actions instead of selected", () => {
  const plan = planAdministratorConfiguration(validInput());
  const readback: AdministratorReadback = {
    ...cleanReadback(plan),
    actionsPolicy: { ...plan.actionsPolicy, allowedActions: "all" },
    driftFound: true
  };
  const issues = compareAdministratorReadback(plan, readback, FRESHNESS);
  assert.ok(issues.some((issue) => issue.path === "/actionsPolicy/allowedActions"));
});

test("compareAdministratorReadback fails closed when an environment has no protection rules", () => {
  const plan = planAdministratorConfiguration(validInput());
  const readback: AdministratorReadback = {
    ...cleanReadback(plan),
    environments: plan.environments.map((environment) => ({
      ...environment,
      hasProtectionRules: false,
      requiresReviewers: false
    })),
    driftFound: true
  };
  const issues = compareAdministratorReadback(plan, readback, FRESHNESS);
  assert.ok(issues.some((issue) => issue.message.includes("no protection rules")));
});

test("compareAdministratorReadback fails closed when a ruleset is not observed as active", () => {
  const plan = planAdministratorConfiguration(validInput());
  const readback: AdministratorReadback = {
    ...cleanReadback(plan),
    rulesets: plan.rulesets.map((ruleset) => ({ ...ruleset, enforcement: "evaluate" as const })),
    driftFound: true
  };
  const issues = compareAdministratorReadback(plan, readback, FRESHNESS);
  assert.ok(issues.some((issue) => issue.message.includes("is not active")));
});

test("compareAdministratorReadback fails closed when a ruleset is entirely absent from the readback", () => {
  const plan = planAdministratorConfiguration(validInput());
  const readback: AdministratorReadback = {
    ...cleanReadback(plan),
    rulesets: [],
    driftFound: true
  };
  const issues = compareAdministratorReadback(plan, readback, FRESHNESS);
  assert.ok(issues.some((issue) => issue.message.includes("was not observed")));
});

test("compareAdministratorReadback fails closed when a main-named ruleset covers a different ref in the readback", () => {
  const plan = planAdministratorConfiguration(validInput());
  const readback: AdministratorReadback = {
    ...cleanReadback(plan),
    rulesets: plan.rulesets.map((ruleset) => ({
      ...ruleset,
      refConditions: { include: ["refs/heads/develop"], exclude: [] },
      effectiveProtectedRefs: ["refs/heads/develop"]
    })),
    driftFound: true
  };
  const issues = compareAdministratorReadback(plan, readback, FRESHNESS);
  assert.ok(
    issues.some((issue) => issue.path === "/rulesets/main-branch-ruleset/effectiveProtectedRefs")
  );
});

test("compareAdministratorReadback fails closed when an observed ruleset source does not match the planned source", () => {
  const plan = planAdministratorConfiguration(validInput());
  const readback: AdministratorReadback = {
    ...cleanReadback(plan),
    rulesets: plan.rulesets.map((ruleset) => ({ ...ruleset, source: "repository" as const })),
    driftFound: true
  };
  const issues = compareAdministratorReadback(plan, readback, FRESHNESS);
  assert.ok(issues.some((issue) => issue.path === "/rulesets/main-branch-ruleset/source"));
});

test("compareAdministratorReadback fails closed when an observed ruleset target does not match the planned target", () => {
  const plan = planAdministratorConfiguration(validInput());
  const readback: AdministratorReadback = {
    ...cleanReadback(plan),
    // A tampered observation claiming a different (tag) target while the
    // plan requires a branch ruleset with the same ID and refs must not be
    // silently accepted just because a same-shaped enforcement/refs match.
    rulesets: plan.rulesets.map(
      (ruleset) =>
        ({
          ...ruleset,
          target: "tag",
          restrictsTagCreation: true,
          restrictsTagUpdate: true,
          restrictsTagDeletion: true
        }) as unknown as (typeof plan.rulesets)[number]
    ),
    driftFound: true
  };
  const issues = compareAdministratorReadback(plan, readback, FRESHNESS);
  assert.ok(issues.some((issue) => issue.path === "/rulesets/main-branch-ruleset/target"));
});

test("compareAdministratorReadback fails closed when an unplanned ruleset with a bypass actor is observed", () => {
  const plan = planAdministratorConfiguration(validInput());
  const readback: AdministratorReadback = {
    ...cleanReadback(plan),
    rulesets: [
      ...plan.rulesets.map((ruleset) => ({ ...ruleset })),
      {
        rulesetId: "unplanned-ruleset",
        source: "organization",
        target: "branch",
        refConditions: { include: ["refs/heads/release"], exclude: [] },
        effectiveProtectedRefs: ["refs/heads/release"],
        enforcement: "active",
        // An unplanned ruleset carrying a bypass actor must still be caught by
        // the exact-coverage check, not merely never evaluated because it was
        // never in the plan.
        bypassActors: ["some-bypass-actor"],
        requiresPullRequest: true,
        requiresCodeownerReview: true,
        requiresCurrentHeadApproval: true
      }
    ],
    driftFound: true
  };
  const issues = compareAdministratorReadback(plan, readback, FRESHNESS);
  assert.ok(
    issues.some(
      (issue) => issue.path === "/rulesets/unplanned-ruleset" && issue.message.includes("not present in the governed plan")
    )
  );
});

test("compareAdministratorReadback fails closed when an unplanned environment is observed", () => {
  const plan = planAdministratorConfiguration(validInput());
  const readback: AdministratorReadback = {
    ...cleanReadback(plan),
    environments: [
      ...plan.environments.map((environment) => ({ ...environment })),
      { environmentId: "unplanned-environment", requiresReviewers: false, hasProtectionRules: false }
    ],
    driftFound: true
  };
  const issues = compareAdministratorReadback(plan, readback, FRESHNESS);
  assert.ok(issues.some((issue) => issue.path === "/environments/unplanned-environment"));
});

test("compareAdministratorReadback fails closed when an unplanned required check is observed", () => {
  const plan = planAdministratorConfiguration(validInput());
  const readback: AdministratorReadback = {
    ...cleanReadback(plan),
    requiredChecks: [
      ...plan.requiredChecks.map((check) => ({ ...check })),
      { checkName: "unplanned-check", required: true }
    ],
    driftFound: true
  };
  const issues = compareAdministratorReadback(plan, readback, FRESHNESS);
  assert.ok(issues.some((issue) => issue.path === "/requiredChecks/unplanned-check"));
});

test("compareAdministratorReadback fails closed when a nonAuthoritative marker is false", () => {
  const plan = planAdministratorConfiguration(validInput());
  const readback: AdministratorReadback = {
    ...cleanReadback(plan),
    nonAuthoritative: { ...plan.nonAuthoritative, cannotMutateProject: false },
    driftFound: true
  };
  const issues = compareAdministratorReadback(plan, readback, FRESHNESS);
  assert.ok(issues.some((issue) => issue.path === "/nonAuthoritative/cannotMutateProject"));
});

test("compareAdministratorReadback accepts a plan and readback containing both a branch and a tag ruleset", () => {
  const input = validInput();
  const planInput: AdministratorPlanInput = {
    ...input,
    rulesets: [
      ...input.rulesets,
      {
        rulesetId: "release-tag-ruleset",
        source: "organization",
        target: "tag",
        refConditions: { include: ["refs/tags/v1.0.0"], exclude: [] },
        effectiveProtectedRefs: ["refs/tags/v1.0.0"],
        enforcement: "active",
        bypassActors: [],
        restrictsTagCreation: true,
        restrictsTagUpdate: true,
        restrictsTagDeletion: true
      }
    ]
  };
  const plan = planAdministratorConfiguration(planInput);
  const readback = cleanReadback(plan);
  assert.deepEqual(compareAdministratorReadback(plan, readback, FRESHNESS), []);
  const result = validateDocument("AdministratorReadback", readback);
  assert.equal(result.valid, true);
});

test("validateAdministratorPlan rejects a tag ruleset that does not restrict tag creation, update, and deletion", () => {
  const input = validInput();
  const planInput: AdministratorPlanInput = {
    ...input,
    rulesets: [
      ...input.rulesets,
      {
        rulesetId: "release-tag-ruleset",
        source: "organization",
        target: "tag",
        refConditions: { include: ["refs/tags/v1.0.0"], exclude: [] },
        effectiveProtectedRefs: ["refs/tags/v1.0.0"],
        enforcement: "active",
        bypassActors: [],
        restrictsTagCreation: true,
        restrictsTagUpdate: true,
        restrictsTagDeletion: true
      }
    ]
  };
  const plan = planAdministratorConfiguration(planInput);
  const tampered: AdministratorPlan = {
    ...plan,
    rulesets: plan.rulesets.map((ruleset) =>
      ruleset.rulesetId === "release-tag-ruleset"
        ? ({ ...ruleset, restrictsTagDeletion: false } as unknown as (typeof plan.rulesets)[number])
        : ruleset
    )
  };
  const issues = validateAdministratorPlan(tampered);
  assert.ok(issues.some((issue) => issue.message.includes("restrict tag creation, update, and deletion")));
});

test("compareAdministratorReadback fails closed when an observed tag ruleset does not restrict tag deletion", () => {
  const input = validInput();
  const planInput: AdministratorPlanInput = {
    ...input,
    rulesets: [
      ...input.rulesets,
      {
        rulesetId: "release-tag-ruleset",
        source: "organization",
        target: "tag",
        refConditions: { include: ["refs/tags/v1.0.0"], exclude: [] },
        effectiveProtectedRefs: ["refs/tags/v1.0.0"],
        enforcement: "active",
        bypassActors: [],
        restrictsTagCreation: true,
        restrictsTagUpdate: true,
        restrictsTagDeletion: true
      }
    ]
  };
  const plan = planAdministratorConfiguration(planInput);
  const readback: AdministratorReadback = {
    ...cleanReadback(plan),
    rulesets: plan.rulesets.map((ruleset) =>
      ruleset.rulesetId === "release-tag-ruleset" ? { ...ruleset, restrictsTagDeletion: false } : { ...ruleset }
    ),
    driftFound: true
  };
  const issues = compareAdministratorReadback(plan, readback, FRESHNESS);
  assert.ok(issues.some((issue) => issue.message.includes("restrict tag creation, update, and deletion")));
});

test("AdministratorPlan JSON Schema rejects a tag ruleset carrying branch-only controls", () => {
  const input = validInput();
  const planInput: AdministratorPlanInput = {
    ...input,
    rulesets: [
      ...input.rulesets,
      {
        rulesetId: "release-tag-ruleset",
        source: "organization",
        target: "tag",
        refConditions: { include: ["refs/tags/v1.0.0"], exclude: [] },
        effectiveProtectedRefs: ["refs/tags/v1.0.0"],
        enforcement: "active",
        bypassActors: [],
        restrictsTagCreation: true,
        restrictsTagUpdate: true,
        restrictsTagDeletion: true
      }
    ]
  };
  const plan = planAdministratorConfiguration(planInput);
  const impossible = {
    ...plan,
    rulesets: [
      ...plan.rulesets.filter((ruleset) => ruleset.rulesetId !== "release-tag-ruleset"),
      {
        rulesetId: "release-tag-ruleset",
        source: "organization",
        target: "tag",
        refConditions: { include: ["refs/tags/v1.0.0"], exclude: [] },
        effectiveProtectedRefs: ["refs/tags/v1.0.0"],
        enforcement: "active",
        bypassActors: [],
        requiresPullRequest: true,
        requiresCodeownerReview: true,
        requiresCurrentHeadApproval: true
      }
    ]
  };
  const result = validateDocument("AdministratorPlan", impossible);
  assert.equal(result.valid, false);
});

test("AdministratorReadback JSON Schema rejects a document missing the nonAuthoritative marker", () => {
  const plan = planAdministratorConfiguration(validInput());
  const readback = cleanReadback(plan) as unknown as Record<string, unknown>;
  delete readback["nonAuthoritative"];
  const result = validateDocument("AdministratorReadback", readback);
  assert.equal(result.valid, false);
});

test("compareAdministratorReadback fails closed on a disabled GHAS setting", () => {
  const plan = planAdministratorConfiguration(validInput());
  const readback: AdministratorReadback = {
    ...cleanReadback(plan),
    ghas: { ...plan.ghas, secretScanningPushProtection: false },
    driftFound: true
  };
  const issues = compareAdministratorReadback(plan, readback, FRESHNESS);
  assert.ok(issues.some((issue) => issue.path === "/ghas/secretScanningPushProtection"));
});

test("compareAdministratorReadback fails closed when fork pull-request approval is disabled", () => {
  const plan = planAdministratorConfiguration(validInput());
  const readback: AdministratorReadback = {
    ...cleanReadback(plan),
    actionsPolicy: { ...plan.actionsPolicy, requireApprovalForForkPullRequests: false },
    driftFound: true
  };
  const issues = compareAdministratorReadback(plan, readback, FRESHNESS);
  assert.ok(
    issues.some((issue) => issue.path === "/actionsPolicy/requireApprovalForForkPullRequests")
  );
});

test("compareAdministratorReadback fails closed when mutationRequiresExplicitConfirmation drifts", () => {
  const plan = planAdministratorConfiguration(validInput());
  const readback: AdministratorReadback = {
    ...cleanReadback(plan),
    projectBinding: { ...plan.projectBinding, mutationRequiresExplicitConfirmation: false },
    driftFound: true
  };
  const issues = compareAdministratorReadback(plan, readback, FRESHNESS);
  assert.ok(
    issues.some((issue) => issue.path === "/projectBinding/mutationRequiresExplicitConfirmation")
  );
});

test("compareAdministratorReadback fails closed when an incident contact is missing from the readback", () => {
  const plan = planAdministratorConfiguration(validInput());
  const readback: AdministratorReadback = {
    ...cleanReadback(plan),
    incidentContacts: [],
    driftFound: true
  };
  const issues = compareAdministratorReadback(plan, readback, FRESHNESS);
  assert.ok(issues.some((issue) => issue.path === "/incidentContacts"));
});

test("compareAdministratorReadback fails closed when an extra incident contact is observed", () => {
  const plan = planAdministratorConfiguration(validInput());
  const readback: AdministratorReadback = {
    ...cleanReadback(plan),
    incidentContacts: [
      ...plan.incidentContacts,
      { role: "on-call-admin", contactHandle: "unplanned-contact" }
    ],
    driftFound: true
  };
  const issues = compareAdministratorReadback(plan, readback, FRESHNESS);
  assert.ok(issues.some((issue) => issue.path === "/incidentContacts"));
});

test("compareAdministratorReadback fails closed when an incident contact handle is substituted", () => {
  const plan = planAdministratorConfiguration(validInput());
  const readback: AdministratorReadback = {
    ...cleanReadback(plan),
    incidentContacts: [{ role: "security-owner", contactHandle: "substituted-owner" }],
    driftFound: true
  };
  const issues = compareAdministratorReadback(plan, readback, FRESHNESS);
  assert.ok(issues.some((issue) => issue.path === "/incidentContacts"));
});

test("compareAdministratorReadback fails closed when planDigest does not match the supplied plan", () => {
  const plan = planAdministratorConfiguration(validInput());
  const otherPlan = planAdministratorConfiguration({
    ...validInput(),
    repository: { ...repository(), id: 999, fullName: "example-organization/other-repository" }
  });
  const readback = cleanReadback(otherPlan);
  const issues = compareAdministratorReadback(plan, readback, FRESHNESS);
  assert.ok(issues.some((issue) => issue.path === "/planDigest"));
});

test("compareAdministratorReadback fails closed when repository identity does not match the plan", () => {
  const plan = planAdministratorConfiguration(validInput());
  const readback: AdministratorReadback = {
    ...cleanReadback(plan),
    repository: { ...plan.repository, id: 999999 }
  };
  const issues = compareAdministratorReadback(plan, readback, FRESHNESS);
  assert.ok(issues.some((issue) => issue.path === "/repository"));
});

test("compareAdministratorReadback rejects an already-invalid plan instead of treating it as ground truth", () => {
  // A plan constructed outside planAdministratorConfiguration (for example
  // one loaded from storage) that omits a required check must not be
  // silently trusted just because a readback happens to match it exactly.
  const plan = planAdministratorConfiguration(validInput());
  const invalidPlan: AdministratorPlan = {
    ...plan,
    requiredChecks: plan.requiredChecks.filter((check) => check.checkName !== "codeql")
  };
  const readback = cleanReadback(invalidPlan);
  const issues = compareAdministratorReadback(invalidPlan, readback, FRESHNESS);
  assert.ok(issues.some((issue) => issue.message.includes("codeql")));
});

test("compareAdministratorReadback fails closed when a readback duplicates one protected ref instead of reporting a distinct missing one", () => {
  const input = validInput();
  const planWithTwoRefs: AdministratorPlanInput = {
    ...input,
    rulesets: [
      {
        ...mainBranchRuleset(),
        refConditions: { include: ["refs/heads/main", "refs/heads/release"], exclude: [] },
        effectiveProtectedRefs: ["refs/heads/main", "refs/heads/release"]
      }
    ]
  };
  const plan = planAdministratorConfiguration(planWithTwoRefs);
  const readback: AdministratorReadback = {
    ...cleanReadback(plan),
    rulesets: plan.rulesets.map((ruleset) => ({
      ...ruleset,
      // "release" is never actually observed; "main" is duplicated only to
      // keep the array length equal to the planned two-ref set.
      refConditions: { include: ["refs/heads/main", "refs/heads/main"], exclude: [] },
      effectiveProtectedRefs: ["refs/heads/main", "refs/heads/main"]
    })),
    driftFound: true
  };
  const issues = compareAdministratorReadback(plan, readback, FRESHNESS);
  assert.ok(
    issues.some((issue) => issue.path === "/rulesets/main-branch-ruleset/effectiveProtectedRefs"),
    "a duplicated ref must not silently satisfy a distinct missing ref"
  );
});

test("compareAdministratorReadback fails closed when the readback observation is stale", () => {
  const plan = planAdministratorConfiguration(validInput());
  const readback = cleanReadback(plan, "2026-08-27T00:00:00Z");
  const issues = compareAdministratorReadback(plan, readback, FRESHNESS);
  assert.ok(issues.some((issue) => issue.path === "/observedAt"));
});

test("compareAdministratorReadback fails closed when the readback observation is in the future", () => {
  const plan = planAdministratorConfiguration(validInput());
  const readback = cleanReadback(plan, "2026-08-29T00:00:00Z");
  const issues = compareAdministratorReadback(plan, readback, FRESHNESS);
  assert.ok(issues.some((issue) => issue.path === "/observedAt"));
});

test("compareAdministratorReadback fails closed when the readback duplicates a rulesetId instead of building a last-wins Map", () => {
  const plan = planAdministratorConfiguration(validInput());
  const conflictingDuplicate = {
    ...plan.rulesets[0]!,
    enforcement: "disabled" as const
  };
  const readback: AdministratorReadback = {
    ...cleanReadback(plan),
    // A naive Map keyed by rulesetId would silently keep only the last
    // entry (the compliant one) here, discarding the conflicting
    // "disabled" observation instead of failing closed on it.
    rulesets: [conflictingDuplicate, ...plan.rulesets.map((ruleset) => ({ ...ruleset }))],
    driftFound: true
  };
  const issues = compareAdministratorReadback(plan, readback, FRESHNESS);
  assert.ok(
    issues.some((issue) => issue.path === "/rulesets" && issue.message.includes("main-branch-ruleset")),
    "a duplicated rulesetId with conflicting observations must fail closed, not silently resolve last-wins"
  );
});

test("compareAdministratorReadback fails closed when the readback duplicates an environmentId", () => {
  const plan = planAdministratorConfiguration(validInput());
  const conflictingDuplicate = { ...plan.environments[0]!, hasProtectionRules: false, requiresReviewers: false };
  const readback: AdministratorReadback = {
    ...cleanReadback(plan),
    environments: [conflictingDuplicate, ...plan.environments.map((environment) => ({ ...environment }))],
    driftFound: true
  };
  const issues = compareAdministratorReadback(plan, readback, FRESHNESS);
  assert.ok(issues.some((issue) => issue.path === "/environments" && issue.message.includes("copilot")));
});

test("compareAdministratorReadback fails closed when the readback duplicates a checkName", () => {
  const plan = planAdministratorConfiguration(validInput());
  const conflictingDuplicate = { checkName: "codeql" as const, required: false };
  const readback: AdministratorReadback = {
    ...cleanReadback(plan),
    requiredChecks: [conflictingDuplicate, ...plan.requiredChecks.map((check) => ({ ...check }))],
    driftFound: true
  };
  const issues = compareAdministratorReadback(plan, readback, FRESHNESS);
  assert.ok(issues.some((issue) => issue.path === "/requiredChecks" && issue.message.includes("codeql")));
});

test("compareAdministratorReadback fails closed when the readback duplicates an incident contact role", () => {
  const plan = planAdministratorConfiguration(validInput());
  const readback: AdministratorReadback = {
    ...cleanReadback(plan),
    incidentContacts: [
      { role: "security-owner", contactHandle: "conflicting-substituted-owner" },
      ...plan.incidentContacts.map((contact) => ({ ...contact }))
    ],
    driftFound: true
  };
  const issues = compareAdministratorReadback(plan, readback, FRESHNESS);
  assert.ok(
    issues.some((issue) => issue.path === "/incidentContacts" && issue.message.includes("security-owner"))
  );
});

test("checkReadbackDriftCoherence accepts a readback whose driftFound agrees with the comparator", () => {
  const plan = planAdministratorConfiguration(validInput());
  const readback = cleanReadback(plan);
  const issues = compareAdministratorReadback(plan, readback, FRESHNESS);
  assert.deepEqual(checkReadbackDriftCoherence(readback, issues), []);
});

test("checkReadbackDriftCoherence rejects driftFound:true when the comparator found no issues", () => {
  const plan = planAdministratorConfiguration(validInput());
  const readback: AdministratorReadback = { ...cleanReadback(plan), driftFound: true };
  const issues = compareAdministratorReadback(plan, readback, FRESHNESS);
  assert.deepEqual(issues, []);
  const coherence = checkReadbackDriftCoherence(readback, issues);
  assert.ok(coherence.some((issue) => issue.path === "/driftFound"));
});

test("checkReadbackDriftCoherence rejects driftFound:false when the comparator found real issues, and does not suppress them", () => {
  const plan = planAdministratorConfiguration(validInput());
  const readback: AdministratorReadback = {
    ...cleanReadback(plan),
    ghas: { ...plan.ghas, secretScanningPushProtection: false },
    driftFound: false
  };
  const issues = compareAdministratorReadback(plan, readback, FRESHNESS);
  assert.ok(issues.length > 0, "compareAdministratorReadback must still report the real drift");
  const coherence = checkReadbackDriftCoherence(readback, issues);
  assert.ok(coherence.some((issue) => issue.path === "/driftFound"));
});

test("AdministratorPlan JSON Schema rejects a non-empty bypassActors array", () => {
  const plan = planAdministratorConfiguration(validInput());
  const result = validateDocument("AdministratorPlan", {
    ...plan,
    rulesets: plan.rulesets.map((ruleset) => ({
      ...ruleset,
      bypassActors: ["synthetic-actor"]
    }))
  });
  assert.equal(result.valid, false);
});

test("AdministratorPlan JSON Schema rejects an unrecognized required check name", () => {
  const plan = planAdministratorConfiguration(validInput());
  const result = validateDocument("AdministratorPlan", {
    ...plan,
    requiredChecks: [...plan.requiredChecks, { checkName: "unreviewed-check", required: true }]
  });
  assert.equal(result.valid, false);
});

test("AdministratorPlan JSON Schema rejects a ruleset with no ref conditions", () => {
  const plan = planAdministratorConfiguration(validInput());
  const result = validateDocument("AdministratorPlan", {
    ...plan,
    rulesets: plan.rulesets.map((ruleset) => ({
      ...ruleset,
      refConditions: { include: [], exclude: [] },
      effectiveProtectedRefs: []
    }))
  });
  assert.equal(result.valid, false);
});

test("AdministratorPlan JSON Schema rejects a wildcard ref pattern", () => {
  const plan = planAdministratorConfiguration(validInput());
  const result = validateDocument("AdministratorPlan", {
    ...plan,
    rulesets: plan.rulesets.map((ruleset) => ({
      ...ruleset,
      refConditions: { include: ["refs/heads/*"], exclude: [] },
      effectiveProtectedRefs: ["refs/heads/*"]
    }))
  });
  assert.equal(result.valid, false);
});

test("AdministratorPlan JSON Schema rejects a duplicated ruleset object", () => {
  const plan = planAdministratorConfiguration(validInput());
  const result = validateDocument("AdministratorPlan", {
    ...plan,
    rulesets: [...plan.rulesets, ...plan.rulesets]
  });
  assert.equal(result.valid, false);
});

test("AdministratorReadback JSON Schema rejects a wildcard ref pattern", () => {
  const plan = planAdministratorConfiguration(validInput());
  const readback = cleanReadback(plan);
  const result = validateDocument("AdministratorReadback", {
    ...readback,
    rulesets: readback.rulesets.map((ruleset) => ({
      ...ruleset,
      refConditions: { include: ["refs/heads/*"], exclude: [] },
      effectiveProtectedRefs: ["refs/heads/*"]
    }))
  });
  assert.equal(result.valid, false);
});
