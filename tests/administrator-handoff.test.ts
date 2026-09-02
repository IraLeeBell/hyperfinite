import assert from "node:assert/strict";
import test from "node:test";

import {
  ADMINISTRATOR_HANDOFF_CONTROLS,
  ADMINISTRATOR_PROHIBITED_EFFECTS,
  computeAdministratorHandoffSnapshotDigest,
  compareAdministratorHandoffReadback,
  planAdministratorApply,
  planAdministratorHandoff,
  validateAdministratorApplyGate,
  validateAdministratorApplyPlan,
  validateAdministratorHandoffPlan,
  validateAdministratorHandoffReport,
  validateAdministratorPostApplyReadback,
  type AdministratorApplyConfirmation,
  type AdministratorExactTarget,
  type AdministratorHandoffReadback,
  type AdministratorHandoffReport,
  type AdministratorPostApplyReadback,
  type AdministratorPreApplyReadback,
  type AdministratorStateSet
} from "../src/administrator-handoff.js";
import { digest } from "../src/canonical.js";
import { validateDocument } from "../src/validation.js";

const NOW = "2026-09-01T15:00:00Z";
const FRESHNESS = { now: NOW, maxAgeMs: 60 * 60 * 1000 };

function handoffPlan() {
  return planAdministratorHandoff({
    evidenceEpoch: "2026-09-01T14:00:00Z",
    sourceDigests: {
      deploymentTopologyPlan: `sha256:${"1".repeat(64)}`,
      githubAppRegistrationPlan: `sha256:${"2".repeat(64)}`,
      administratorConfigurationPlan: `sha256:${"3".repeat(64)}`,
      durableAdapterMapping: `sha256:${"4".repeat(64)}`,
      syntheticCanaryEvidence: `sha256:${"5".repeat(64)}`,
      customerStarterCoreSelection: `sha256:${"6".repeat(64)}`,
      customerStarterDemoSelection: `sha256:${"7".repeat(64)}`,
      openSourceReadiness: `sha256:${"8".repeat(64)}`,
      licenseBytes: `sha256:${"9".repeat(64)}`
    }
  });
}

const TARGET: AdministratorExactTarget = {
  sourceOwner: null,
  owner: {
    id: 123456789,
    nodeId: "O_synthetic-owner",
    login: "synthetic-owner"
  },
  repository: {
    id: 987654321,
    nodeId: "R_synthetic-repository",
    owner: "synthetic-owner",
    name: "synthetic-repository",
    fullName: "synthetic-owner/synthetic-repository"
  },
  project: {
    id: "PVT_synthetic_synthetic-project",
    number: 1,
    itemId: "PVTI_synthetic_synthetic-item",
    fieldId: "PVTSSF_synthetic_synthetic-status"
  },
  environment: {
    id: 1234,
    nodeId: "EN_synthetic-environment",
    name: "copilot"
  },
  ruleset: {
    id: 5678,
    name: "synthetic-main-protection",
    target: "branch"
  },
  app: {
    id: 9012,
    nodeId: "A_synthetic-app"
  },
  installation: {
    id: 3456,
    accountId: 123456789,
    accountNodeId: "O_synthetic-owner"
  },
  billingAccountId: "synthetic-billing-account"
};

const CURRENT_RULESET: AdministratorStateSet = {
  count: 2,
  values: [
    { key: "checks.required", value: 0 },
    { key: "ruleset.main", value: false }
  ]
};

const DESIRED_RULESET: AdministratorStateSet = {
  count: 2,
  values: [
    { key: "checks.required", value: 12 },
    { key: "ruleset.main", value: true }
  ]
};

function applyPlan() {
  const handoff = handoffPlan();
  return planAdministratorApply(handoff, {
    generatedAt: "2026-09-01T14:30:00Z",
    expiresAt: "2026-09-01T15:30:00Z",
    operationId: "main-ruleset-and-required-checks",
    handoffPlanDigest: digest(handoff),
    target: TARGET,
    expectedCurrent: CURRENT_RULESET,
    desired: DESIRED_RULESET
  });
}

function confirmation(planDigest: string): AdministratorApplyConfirmation {
  return {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "AdministratorApplyConfirmation",
    schemaVersion: "1.0.0",
    planDigest,
    confirmationId: "synthetic-confirmation",
    confirmedBy: "synthetic-human-administrator",
    confirmedAt: "2026-09-01T14:50:00Z",
    expiresAt: "2026-09-01T15:10:00Z",
    separateExplicitHumanConfirmation: true,
    confirmationEvidenceDigest: `sha256:${"a".repeat(64)}`,
    nonAuthoritative: {
      requiresTrustedAdapterVerification: true,
      performsNoEffect: true
    }
  };
}

function preReadback(
  plan: ReturnType<typeof applyPlan>,
  confirmed: AdministratorApplyConfirmation,
  actual: AdministratorStateSet
): AdministratorPreApplyReadback {
  return {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "AdministratorApplyReadback",
    schemaVersion: "1.0.0",
    phase: "pre-apply",
    observedAt: "2026-09-01T14:55:00Z",
    planDigest: digest(plan),
    confirmationDigest: digest(confirmed),
    attemptId: plan.attemptId,
    target: TARGET,
    actual,
    mutationAttemptCount: 0,
    acknowledgement: "not-attempted",
    preApplyReadbackDigest: null,
    attemptedAt: null,
    attemptReceiptDigest: null,
    completeReadback: true,
    nonAuthoritative: {
      evidenceOnly: true,
      cannotRetryOrApply: true
    }
  };
}

function postReadback(
  plan: ReturnType<typeof applyPlan>,
  confirmed: AdministratorApplyConfirmation,
  before: AdministratorPreApplyReadback,
  actual: AdministratorStateSet,
  acknowledgement: "unambiguous-applied" | "ambiguous"
): AdministratorPostApplyReadback {
  return {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "AdministratorApplyReadback",
    schemaVersion: "1.0.0",
    phase: "post-apply",
    observedAt: "2026-09-01T14:58:00Z",
    planDigest: digest(plan),
    confirmationDigest: digest(confirmed),
    attemptId: plan.attemptId,
    target: TARGET,
    actual,
    mutationAttemptCount: 1,
    acknowledgement,
    preApplyReadbackDigest: digest(before),
    attemptedAt: "2026-09-01T14:57:00Z",
    attemptReceiptDigest: digest({
      attemptId: plan.attemptId,
      idempotencyKey: plan.idempotencyKey
    }),
    completeReadback: true,
    nonAuthoritative: {
      evidenceOnly: true,
      cannotRetryOrApply: true
    }
  };
}

function handoffReadback(): AdministratorHandoffReadback {
  const plan = handoffPlan();
  const source = "synthetic-fixture" as const;
  const target = {
    sourceOwner:
      TARGET.sourceOwner === null ? null : digest(TARGET.sourceOwner),
    owner: digest(TARGET.owner),
    repository: digest(TARGET.repository),
    project: TARGET.project === null ? null : digest(TARGET.project),
    environment:
      TARGET.environment === null ? null : digest(TARGET.environment),
    ruleset: TARGET.ruleset === null ? null : digest(TARGET.ruleset),
    app: TARGET.app === null ? null : digest(TARGET.app),
    installation:
      TARGET.installation === null ? null : digest(TARGET.installation),
    billingAccount:
      TARGET.billingAccountId === null
        ? null
        : digest(TARGET.billingAccountId)
  };
  const controls = ADMINISTRATOR_HANDOFF_CONTROLS.map((control) => ({
    controlId: control.controlId,
    status:
      control.controlId === "open-source-preflight"
        ? ("repository-evidence-only" as const)
        : ("blocked-human-action" as const),
    reasonCode:
      control.controlId === "open-source-preflight"
        ? ("synthetic-only" as const)
        : ("human-decision-required" as const),
    observationDigest: null
  }));
  const readiness = {
    repository: "not-validated" as const,
    credentiallessSyntheticSandbox: "not-run" as const,
    appBackedSandbox: "blocked" as const,
    production: "customer-approval-required" as const
  } as const;
  const body = {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "AdministratorHandoffReadback",
    schemaVersion: "1.0.0",
    observedAt: "2026-09-01T14:45:00Z",
    planDigest: digest(plan),
    source,
    provenance: "synthetic-fixture",
    target,
    controls,
    satisfiedEvidence: [],
    readiness,
    nonAuthoritative: {
      driftProneObservation: true,
      grantsNoAuthority: true,
      authorizesNoEffect: true,
      cannotSatisfyHumanGateByItself: true
    }
  } as const;
  return {
    ...body,
    snapshotDigest: computeAdministratorHandoffSnapshotDigest(body)
  };
}

test("handoff plan fixes the authority order, complete control catalogue, and one-attempt protocol", () => {
  const plan = handoffPlan();
  assert.equal(plan.controls.length, 27);
  assert.equal(plan.durableAdapterPortCount, 15);
  assert.deepEqual(plan.prohibitedEffects, ADMINISTRATOR_PROHIBITED_EFFECTS);
  assert.equal(plan.applyProtocol.maximumApplyAttempts, 1);
  assert.equal(plan.applyProtocol.retryAfterAmbiguousAcknowledgement, false);
  assert.deepEqual(validateAdministratorHandoffPlan(plan), []);
  assert.equal(
    validateDocument("AdministratorHandoffDocument", plan).valid,
    true
  );
});

test("handoff plan rejects a reordered or widened control catalogue", () => {
  const plan = handoffPlan();
  const changed = {
    ...plan,
    controls: [...plan.controls].reverse()
  };
  assert.match(
    validateAdministratorHandoffPlan(changed)[0]?.message ?? "",
    /catalogue/u
  );
});

test("apply plans bind exact targets, counts, desired values, and prohibited effects", () => {
  const plan = applyPlan();
  assert.deepEqual(validateAdministratorApplyPlan(plan), []);
  assert.deepEqual(plan.prohibitedEffects, ADMINISTRATOR_PROHIBITED_EFFECTS);
  assert.equal(plan.expectedCurrent.count, plan.expectedCurrent.values.length);
  assert.equal(plan.desired.count, plan.desired.values.length);
  assert.equal(
    validateDocument("AdministratorHandoffDocument", plan).valid,
    true
  );
});

test("apply plans refuse a required target identity that is absent", () => {
  const plan = {
    ...applyPlan(),
    target: { ...TARGET, ruleset: null }
  };
  assert.ok(
    validateAdministratorApplyPlan(plan).some((issue) =>
      /exact ruleset binding/u.test(issue.message)
    )
  );
});

test("main-protection apply plans require a branch-targeted ruleset", () => {
  const plan = {
    ...applyPlan(),
    target: {
      ...TARGET,
      ruleset: { ...TARGET.ruleset!, target: "tag" as const }
    }
  };
  assert.ok(
    validateAdministratorApplyPlan(plan).some(
      (issue) => issue.path === "/target/ruleset/target"
    )
  );
});

test("apply plans refuse unrelated, missing, or wrong-domain state values", () => {
  const plan = applyPlan();
  const unrelated = {
    ...plan,
    expectedCurrent: {
      count: 1,
      values: [{ key: "billing.enabled" as const, value: false }]
    },
    desired: {
      count: 1,
      values: [{ key: "billing.enabled" as const, value: true }]
    }
  };
  assert.ok(
    validateAdministratorApplyPlan(unrelated).some((issue) =>
      /closed state requirement set/u.test(issue.message)
    )
  );
  const wrongDomain = {
    ...plan,
    desired: {
      ...plan.desired,
      values: [
        { key: "checks.required" as const, value: "twelve" },
        { key: "ruleset.main" as const, value: true }
      ]
    }
  };
  assert.ok(
    validateAdministratorApplyPlan(wrongDomain).some((issue) =>
      /required integer domain/u.test(issue.message)
    )
  );
});

test("semantic apply entrypoints reject schema-invalid nested widening", () => {
  const plan = applyPlan();
  const widened = {
    ...plan,
    target: {
      ...plan.target,
      owner: {
        ...plan.target.owner,
        unexpected: true
      }
    }
  } as typeof plan;
  assert.ok(
    validateAdministratorApplyPlan(widened).some((issue) =>
      /schema validation failed/u.test(issue.message)
    )
  );
  const confirmed = confirmation(digest(widened));
  const before = preReadback(plan, confirmation(digest(plan)), CURRENT_RULESET);
  const gate = validateAdministratorApplyGate({
    plan: widened,
    confirmation: confirmed,
    preApplyReadback: before,
    freshness: FRESHNESS
  });
  assert.equal(gate.readyForTrustedAdapterVerification, false);
  assert.ok(
    gate.issues.some((issue) => /schema validation failed/u.test(issue.message))
  );
});

test("installation and App-transfer plans require coherent immutable owner identities", () => {
  const plan = applyPlan();
  const wrongInstallation = {
    ...plan,
    target: {
      ...plan.target,
      installation: {
        ...plan.target.installation!,
        accountId: plan.target.owner.id + 1
      }
    }
  };
  assert.ok(
    validateAdministratorApplyPlan(wrongInstallation).some((issue) =>
      issue.path.includes("installation")
    )
  );

  const handoff = handoffPlan();
  assert.throws(
    () =>
      planAdministratorApply(handoff, {
        generatedAt: "2026-09-01T14:30:00Z",
        expiresAt: "2026-09-01T15:30:00Z",
        operationId: "app-ownership-transfer",
        handoffPlanDigest: digest(handoff),
        target: {
          ...TARGET,
          sourceOwner: TARGET.owner
        },
        expectedCurrent: {
          count: 1,
          values: [{ key: "app.owner", value: false }]
        },
        desired: {
          count: 1,
          values: [{ key: "app.owner", value: true }]
        }
      }),
    /distinct exact source and destination owners/u
  );
  assert.throws(
    () =>
      planAdministratorApply(handoff, {
        generatedAt: "2026-09-01T14:30:00Z",
        expiresAt: "2026-09-01T15:30:00Z",
        operationId: "app-ownership-transfer",
        handoffPlanDigest: digest(handoff),
        target: {
          ...TARGET,
          sourceOwner: {
            id: TARGET.owner.id + 1,
            nodeId: "O_distinct-owner-node",
            login: TARGET.owner.login.toUpperCase()
          }
        },
        expectedCurrent: {
          count: 1,
          values: [{ key: "app.owner", value: false }]
        },
        desired: {
          count: 1,
          values: [{ key: "app.owner", value: true }]
        }
      }),
    /distinct exact source and destination owners/u
  );
  assert.throws(
    () =>
      planAdministratorApply(handoff, {
        generatedAt: "2026-09-01T14:30:00Z",
        expiresAt: "2026-09-01T15:30:00Z",
        operationId: "app-ownership-transfer",
        handoffPlanDigest: digest(handoff),
        target: {
          ...TARGET,
          sourceOwner: {
            id: TARGET.owner.id,
            nodeId: "O_conflicting-owner-node",
            login: "conflicting-owner"
          }
        },
        expectedCurrent: {
          count: 1,
          values: [{ key: "app.owner", value: false }]
        },
        desired: {
          count: 1,
          values: [{ key: "app.owner", value: true }]
        }
      }),
    /distinct exact source and destination owners/u
  );
});

test("a separate exact-digest confirmation and fresh pre-readback validate the trusted-adapter gate", () => {
  const plan = applyPlan();
  const planDigest = digest(plan);
  const confirmed = confirmation(planDigest);
  const result = validateAdministratorApplyGate({
    plan,
    confirmation: confirmed,
    preApplyReadback: preReadback(plan, confirmed, CURRENT_RULESET),
    freshness: FRESHNESS
  });
  assert.deepEqual(result, {
    readyForTrustedAdapterVerification: true,
    issues: []
  });
});

test("the trusted-adapter gate fails closed on changed current values or a stale confirmation", () => {
  const plan = applyPlan();
  const planDigest = digest(plan);
  const confirmed = confirmation(planDigest);
  const changed = validateAdministratorApplyGate({
    plan,
    confirmation: confirmed,
    preApplyReadback: preReadback(plan, confirmed, DESIRED_RULESET),
    freshness: FRESHNESS
  });
  assert.equal(changed.readyForTrustedAdapterVerification, false);
  assert.ok(changed.issues.some((issue) => issue.path.includes("actual")));

  const staleConfirmation = {
    ...confirmation(planDigest),
    confirmedAt: "2026-09-01T12:00:00Z"
  };
  const stale = validateAdministratorApplyGate({
    plan,
    confirmation: staleConfirmation,
    preApplyReadback: preReadback(
      plan,
      staleConfirmation,
      CURRENT_RULESET
    ),
    freshness: FRESHNESS
  });
  assert.equal(stale.readyForTrustedAdapterVerification, false);
  assert.ok(stale.issues.some((issue) => issue.path.includes("confirmedAt")));
});

test("ambiguous acknowledgement is reconciliation-required and never success-shaped", () => {
  const plan = applyPlan();
  const confirmed = confirmation(digest(plan));
  const before = preReadback(plan, confirmed, CURRENT_RULESET);
  const result = validateAdministratorPostApplyReadback({
    plan,
    confirmation: confirmed,
    preApplyReadback: before,
    readback: postReadback(
      plan,
      confirmed,
      before,
      DESIRED_RULESET,
      "ambiguous"
    ),
    freshness: FRESHNESS
  });
  assert.equal(result.desiredStateObserved, false);
  assert.equal(result.reconciliationRequired, true);
  assert.ok(result.issues.some((issue) => /must not be retried/u.test(issue.message)));
});

test("complete post-apply readback accepts only the exact desired state", () => {
  const plan = applyPlan();
  const confirmed = confirmation(digest(plan));
  const before = preReadback(plan, confirmed, CURRENT_RULESET);
  const result = validateAdministratorPostApplyReadback({
    plan,
    confirmation: confirmed,
    preApplyReadback: before,
    readback: postReadback(
      plan,
      confirmed,
      before,
      DESIRED_RULESET,
      "unambiguous-applied"
    ),
    freshness: FRESHNESS
  });
  assert.deepEqual(result, {
    desiredStateObserved: true,
    reconciliationRequired: false,
    issues: []
  });
});

test("handoff readback preserves repository/synthetic/live/production separation", () => {
  const plan = handoffPlan();
  const readbackValue = handoffReadback();
  const result = compareAdministratorHandoffReadback(
    plan,
    readbackValue,
    FRESHNESS
  );
  assert.equal(result.valid, true);
  assert.equal(result.gaps.length, 27);
  assert.equal(readbackValue.readiness.appBackedSandbox, "blocked");
  assert.equal(readbackValue.readiness.production, "customer-approval-required");
  assert.equal(
    validateDocument("AdministratorHandoffDocument", readbackValue).valid,
    true
  );
});

test("synthetic evidence cannot claim that an App-backed canary reached Human Review", () => {
  const plan = handoffPlan();
  const readbackValue = handoffReadback();
  const changed: AdministratorHandoffReadback = {
    ...readbackValue,
    controls: readbackValue.controls.map((control) => ({
      ...control,
      status: "satisfied",
      reasonCode: "observed-compliant",
      observationDigest: digest(control.controlId)
    })),
    readiness: {
      ...readbackValue.readiness,
      appBackedSandbox: "human-review-reached"
    }
  };
  const result = compareAdministratorHandoffReadback(
    plan,
    changed,
    FRESHNESS
  );
  assert.equal(result.valid, false);
  assert.ok(
    result.issues.some((issue) =>
      /cannot satisfy|requires current authenticated live evidence/u.test(
        issue.message
      )
    )
  );
});

test("a satisfied live control requires its exact bindings and satisfied prerequisites", () => {
  const plan = handoffPlan();
  const baseline = handoffReadback();
  const controls = baseline.controls.map((control) =>
    control.controlId === "app-permissions-and-events"
      ? {
          ...control,
          status: "satisfied" as const,
          reasonCode: "observed-compliant" as const,
          observationDigest: digest("app-permissions-live-evidence")
        }
      : control
  );
  const body = {
    ...baseline,
    source: "authenticated-live-current" as const,
    target: {
      ...baseline.target,
      app: null,
      installation: null
    },
    controls
  };
  const changed = {
    ...body,
    snapshotDigest: computeAdministratorHandoffSnapshotDigest(body)
  };
  const result = compareAdministratorHandoffReadback(
    plan,
    changed,
    FRESHNESS
  );
  assert.equal(result.valid, false);
  assert.ok(
    result.issues.some(
      (issue) => issue.path === "/controls/app-permissions-and-events"
    )
  );
});

test("snapshot identity binds observation time and plan digest against replay", () => {
  const plan = handoffPlan();
  const readbackValue = handoffReadback();
  const changed = {
    ...readbackValue,
    observedAt: "2026-09-01T14:59:00Z"
  };
  const result = compareAdministratorHandoffReadback(
    plan,
    changed,
    FRESHNESS
  );
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.path === "/snapshotDigest"));
});

test("constructors detach and freeze caller-owned contract data", () => {
  const sourceDigests = {
    deploymentTopologyPlan: `sha256:${"1".repeat(64)}`,
    githubAppRegistrationPlan: `sha256:${"2".repeat(64)}`,
    administratorConfigurationPlan: `sha256:${"3".repeat(64)}`,
    durableAdapterMapping: `sha256:${"4".repeat(64)}`,
    syntheticCanaryEvidence: `sha256:${"5".repeat(64)}`,
    customerStarterCoreSelection: `sha256:${"6".repeat(64)}`,
    customerStarterDemoSelection: `sha256:${"7".repeat(64)}`,
    openSourceReadiness: `sha256:${"8".repeat(64)}`,
    licenseBytes: `sha256:${"9".repeat(64)}`
  };
  const plan = planAdministratorHandoff({
    evidenceEpoch: "2026-09-01T14:00:00Z",
    sourceDigests
  });
  sourceDigests.licenseBytes = `sha256:${"a".repeat(64)}`;
  assert.equal(plan.sourceDigests.licenseBytes, `sha256:${"9".repeat(64)}`);
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(ADMINISTRATOR_HANDOFF_CONTROLS), true);
  assert.equal(Object.isFrozen(ADMINISTRATOR_PROHIBITED_EFFECTS), true);
  assert.ok(
    validateAdministratorHandoffPlan({
      ...plan,
      sourceDigests: {} as typeof plan.sourceDigests
    }).some((issue) => /schema validation failed/u.test(issue.message))
  );
});

function reportFixture(): AdministratorHandoffReport {
  const plan = handoffPlan();
  const readbackValue = handoffReadback();
  const apply = applyPlan();
  const confirmed = confirmation(digest(apply));
  const before = preReadback(apply, confirmed, CURRENT_RULESET);
  const after = postReadback(
    apply,
    confirmed,
    before,
    DESIRED_RULESET,
    "unambiguous-applied"
  );
  const starterEvidence = {
    selectionDigest: plan.sourceDigests.customerStarterCoreSelection,
    starterManifestDigest: `sha256:${"2".repeat(64)}`,
    sbomDigest: `sha256:${"3".repeat(64)}`,
    provenanceDigest: `sha256:${"4".repeat(64)}`,
    preflightReportDigest: `sha256:${"5".repeat(64)}`,
    archiveDigest: `sha256:${"6".repeat(64)}`
  };
  const gaps = readbackValue.controls;
  const body = {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "AdministratorHandoffReport",
    schemaVersion: "1.0.0",
    evidenceEpoch: "2026-09-01T15:00:00Z",
    repositoryEvidence: {
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      worktreeClean: true
    },
    plan,
    readback: readbackValue,
    planDigest: digest(plan),
    readbackDigest: digest(readbackValue),
    gaps,
    gapCount: gaps.length,
    customerStarter: {
      controlPlaneCore: starterEvidence,
      demoPortfolio: {
        ...starterEvidence,
        selectionDigest: plan.sourceDigests.customerStarterDemoSelection
      },
      decision: "no-go",
      liveSnapshotExported: false
    },
    syntheticApplyContract: {
      plan: apply,
      confirmation: confirmed,
      preApplyReadback: before,
      postApplyReadback: after,
      planDigest: digest(apply),
      confirmationDigest: digest(confirmed),
      preApplyReadbackDigest: digest(before),
      postApplyReadbackDigest: digest(after),
      gateValidated: true,
      postApplyReadbackValidated: true,
      performedLiveEffect: false
    },
    classification: {
      repository: "exact-head-validation-required",
      credentiallessSyntheticSandbox: "passed",
      appBackedSandbox: "blocked",
      administratorSnapshot: "synthetic-unconfigured",
      production: "customer-approval-required"
    }
  } as const;
  return { ...body, evidenceDigest: digest(body) };
}

test("handoff report semantic validation re-derives every embedded digest and gap", () => {
  const report = reportFixture();
  assert.deepEqual(validateAdministratorHandoffReport(report, FRESHNESS), []);
  const schemaResult = validateDocument("AdministratorHandoffDocument", report);
  assert.equal(schemaResult.valid, true);
  if (schemaResult.valid) {
    assert.equal(Object.isFrozen(schemaResult.value), true);
  }
  const tampered = {
    ...report,
    gapCount: report.gapCount - 1
  };
  assert.ok(
    validateAdministratorHandoffReport(tampered, FRESHNESS).some(
      (issue) => issue.path === "/gaps"
    )
  );
  assert.ok(
    validateAdministratorHandoffReport(
      {
        ...report,
        customerStarter: {
          ...report.customerStarter,
          controlPlaneCore: {
            ...report.customerStarter.controlPlaneCore,
            selectionDigest: `sha256:${"0".repeat(64)}`
          }
        }
      },
      FRESHNESS
    ).some((issue) => issue.path === "/customerStarter")
  );
  assert.ok(
    validateAdministratorHandoffReport(
      {
        ...report,
        syntheticApplyContract: {
          ...report.syntheticApplyContract,
          plan: {
            ...report.syntheticApplyContract.plan,
            handoffPlanDigest: `sha256:${"f".repeat(64)}`
          }
        }
      },
      FRESHNESS
    ).some((issue) => issue.path === "/syntheticApplyContract")
  );
  assert.ok(
    validateAdministratorHandoffReport(
      { ...report, evidenceDigest: `sha256:${"0".repeat(64)}` },
      FRESHNESS
    ).some((issue) => issue.path === "/evidenceDigest")
  );
});

test("administrator handoff schema rejects unknown fields and incomplete targets", () => {
  const plan = handoffPlan();
  assert.equal(
    validateDocument("AdministratorHandoffDocument", {
      ...plan,
      unexpected: true
    }).valid,
    false
  );
  const apply = applyPlan();
  const { owner: _owner, ...incompleteTarget } = apply.target;
  assert.equal(
    validateDocument("AdministratorHandoffDocument", {
      ...apply,
      target: incompleteTarget
    }).valid,
    false
  );
});
