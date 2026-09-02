import assert from "node:assert/strict";
import { test } from "node:test";

import { digest } from "../src/canonical.js";
import { GITHUB_PERMISSION_MANIFEST } from "../src/github-auth.js";
import {
  GitHubAppRegistrationError,
  compareGitHubAppPermissionReadback,
  planGitHubAppRegistration,
  validateGitHubAppRegistrationPlan,
  type GitHubAppInstallationTargetBinding,
  type GitHubAppPermissionReadback,
  type GitHubAppRegistrationPlan
} from "../src/app-registration-plan.js";
import { validateDocument } from "../src/validation.js";

function validTargetBinding(): GitHubAppInstallationTargetBinding {
  return {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "GitHubAppInstallationTargetBinding",
    schemaVersion: "1.0.0",
    approvedAt: "2026-08-28T00:00:00Z",
    approvedBy: "synthetic-human-admin",
    expiresAt: "2026-09-28T00:00:00Z",
    owner: {
      id: 1,
      nodeId: "O_synthetic",
      login: "synthetic-org",
      accountType: "organization"
    },
    app: { id: 2, nodeId: "A_synthetic" },
    installationId: 3,
    selectedRepositories: [
      {
        id: 4,
        nodeId: "R_synthetic",
        owner: "synthetic-org",
        name: "synthetic-repo",
        fullName: "synthetic-org/synthetic-repo"
      }
    ]
  };
}

function readbackFromPlan(
  plan: GitHubAppRegistrationPlan,
  targetBinding: GitHubAppInstallationTargetBinding,
  observedAt = "2026-08-28T00:05:00Z"
): GitHubAppPermissionReadback {
  return {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "GitHubAppPermissionReadback",
    schemaVersion: "1.0.0",
    observedAt,
    planDigest: digest(plan),
    ownerId: targetBinding.owner.id,
    ownerNodeId: targetBinding.owner.nodeId,
    ownerLogin: targetBinding.owner.login,
    accountType: targetBinding.owner.accountType,
    appId: targetBinding.app.id,
    appNodeId: targetBinding.app.nodeId,
    installationId: targetBinding.installationId,
    selectedRepositories: targetBinding.selectedRepositories,
    observedPermissions: plan.leastPrivilegeUnion.map((permission) => ({ ...permission })),
    nonAuthoritative: { ...plan.nonAuthoritative }
  };
}

const FRESHNESS = { now: "2026-08-28T00:10:00Z", maxAgeMs: 60 * 60 * 1000 };

test("planGitHubAppRegistration derives the exact least-privilege union from the manifest", () => {
  const plan = planGitHubAppRegistration("synthetic-app", "2026-08-28T00:00:00Z");
  assert.equal(plan.manifestVersion, GITHUB_PERMISSION_MANIFEST.version);
  assert.deepEqual(
    [...plan.deniedPermissionNames].sort(),
    [...GITHUB_PERMISSION_MANIFEST.denied].sort()
  );
  const union = plan.leastPrivilegeUnion;
  // The manifest requires organization_projects at "write" (project-field-update)
  // even though resolveBinding only requires "read"; the union must retain the
  // highest level any operation needs.
  const orgProjects = union.find(
    (permission) => permission.name === "organization_projects" && permission.scope === "organization"
  );
  assert.ok(orgProjects);
  assert.equal(orgProjects!.level, "write");
  // No permission in the union may be on the denied list.
  for (const permission of union) {
    assert.ok(!GITHUB_PERMISSION_MANIFEST.denied.includes(permission.name as never));
  }
  assert.deepEqual(validateGitHubAppRegistrationPlan(plan), []);
  const result = validateDocument("GitHubAppRegistrationPlan", plan);
  assert.equal(result.valid, true);
});

test("planGitHubAppRegistration rejects an empty app name", () => {
  assert.throws(
    () => planGitHubAppRegistration("   ", "2026-08-28T00:00:00Z"),
    GitHubAppRegistrationError
  );
});

test("validateGitHubAppRegistrationPlan rejects a stale manifest version", () => {
  const plan = planGitHubAppRegistration("synthetic-app", "2026-08-28T00:00:00Z");
  const issues = validateGitHubAppRegistrationPlan({ ...plan, manifestVersion: "0.9.0" });
  assert.ok(issues.some((issue) => issue.message.includes("does not match the current reviewed manifest")));
});

test("validateGitHubAppRegistrationPlan rejects a missing manifest operation", () => {
  const plan = planGitHubAppRegistration("synthetic-app", "2026-08-28T00:00:00Z");
  const issues = validateGitHubAppRegistrationPlan({
    ...plan,
    operations: plan.operations.filter((operation) => operation.operationId !== "check-run")
  });
  assert.ok(issues.some((issue) => issue.path === "/operations/check-run"));
});

test("validateGitHubAppRegistrationPlan rejects an operation absent from the reviewed manifest", () => {
  const plan = planGitHubAppRegistration("synthetic-app", "2026-08-28T00:00:00Z");
  const issues = validateGitHubAppRegistrationPlan({
    ...plan,
    operations: [
      ...plan.operations,
      { operationId: "unreviewed-operation", permissions: [{ name: "metadata", level: "read", scope: "repository" }] }
    ]
  });
  assert.ok(issues.some((issue) => issue.path === "/operations/unreviewed-operation"));
});

test("validateGitHubAppRegistrationPlan rejects an operation whose permissions differ from the manifest", () => {
  const plan = planGitHubAppRegistration("synthetic-app", "2026-08-28T00:00:00Z");
  const issues = validateGitHubAppRegistrationPlan({
    ...plan,
    operations: plan.operations.map((operation) =>
      operation.operationId === "resolveBinding"
        ? { ...operation, permissions: [{ name: "metadata", level: "write", scope: "repository" }] }
        : operation
    )
  });
  assert.ok(issues.some((issue) => issue.path === "/operations/resolveBinding/permissions"));
});

test("validateGitHubAppRegistrationPlan rejects a missing denied permission name", () => {
  const plan = planGitHubAppRegistration("synthetic-app", "2026-08-28T00:00:00Z");
  const issues = validateGitHubAppRegistrationPlan({
    ...plan,
    deniedPermissionNames: plan.deniedPermissionNames.filter((name) => name !== "administration")
  });
  assert.ok(issues.some((issue) => issue.message.includes("administration")));
});

test("validateGitHubAppRegistrationPlan rejects an extra denied permission name", () => {
  const plan = planGitHubAppRegistration("synthetic-app", "2026-08-28T00:00:00Z");
  const issues = validateGitHubAppRegistrationPlan({
    ...plan,
    deniedPermissionNames: [...plan.deniedPermissionNames, "unreviewed-denied-name"]
  });
  assert.ok(issues.some((issue) => issue.message.includes("unreviewed-denied-name")));
});

test("validateGitHubAppRegistrationPlan rejects a least-privilege union missing a required permission", () => {
  const plan = planGitHubAppRegistration("synthetic-app", "2026-08-28T00:00:00Z");
  const issues = validateGitHubAppRegistrationPlan({
    ...plan,
    leastPrivilegeUnion: plan.leastPrivilegeUnion.filter((permission) => permission.name !== "checks")
  });
  assert.ok(issues.some((issue) => issue.path === "/leastPrivilegeUnion"));
});

test("validateGitHubAppRegistrationPlan rejects a least-privilege union with an elevated level", () => {
  const plan = planGitHubAppRegistration("synthetic-app", "2026-08-28T00:00:00Z");
  const issues = validateGitHubAppRegistrationPlan({
    ...plan,
    leastPrivilegeUnion: plan.leastPrivilegeUnion.map((permission) =>
      permission.name === "metadata" ? { ...permission, level: "write" as const } : permission
    )
  });
  assert.ok(issues.some((issue) => issue.path === "/leastPrivilegeUnion"));
});

test("validateGitHubAppRegistrationPlan rejects a union that duplicates one entry instead of reporting a distinct missing one", () => {
  const plan = planGitHubAppRegistration("synthetic-app", "2026-08-28T00:00:00Z");
  const withoutChecks = plan.leastPrivilegeUnion.filter((permission) => permission.name !== "checks");
  // "checks" is never actually present; "metadata" is duplicated only to
  // keep the array length equal to the manifest-derived union length.
  const metadata = plan.leastPrivilegeUnion.find((permission) => permission.name === "metadata")!;
  const issues = validateGitHubAppRegistrationPlan({
    ...plan,
    leastPrivilegeUnion: [...withoutChecks, metadata]
  });
  assert.ok(
    issues.some((issue) => issue.path === "/leastPrivilegeUnion"),
    "a duplicated entry must not silently satisfy a distinct missing manifest-required permission"
  );
});

test("compareGitHubAppPermissionReadback accepts a readback that exactly matches the plan and target binding", () => {
  const plan = planGitHubAppRegistration("synthetic-app", "2026-08-28T00:00:00Z");
  const targetBinding = validTargetBinding();
  const readback = readbackFromPlan(plan, targetBinding);
  assert.deepEqual(compareGitHubAppPermissionReadback(plan, targetBinding, readback, FRESHNESS), []);
  const result = validateDocument("GitHubAppPermissionReadback", readback);
  assert.equal(result.valid, true);
  const targetResult = validateDocument("GitHubAppInstallationTargetBinding", targetBinding);
  assert.equal(targetResult.valid, true);
});

test("compareGitHubAppPermissionReadback fails closed on a plan whose leastPrivilegeUnion silently drops a manifest-required permission", () => {
  const plan = planGitHubAppRegistration("synthetic-app", "2026-08-28T00:00:00Z");
  const targetBinding = validTargetBinding();
  // The exact reviewed attack: remove "checks" from leastPrivilegeUnion,
  // then supply a readback that matches the (already tampered) union
  // exactly. Matching only `manifestVersion` would not catch this, because
  // `operations` still requires "checks" per the manifest; only re-deriving
  // the expected union fresh from `GITHUB_PERMISSION_MANIFEST` (rather than
  // trusting `plan.operations`) detects the drop.
  const downscopedUnion = plan.leastPrivilegeUnion.filter((permission) => permission.name !== "checks");
  assert.ok(downscopedUnion.length < plan.leastPrivilegeUnion.length);
  const tamperedPlan: GitHubAppRegistrationPlan = { ...plan, leastPrivilegeUnion: downscopedUnion };
  const readback: GitHubAppPermissionReadback = {
    ...readbackFromPlan(tamperedPlan, targetBinding),
    observedPermissions: downscopedUnion.map((permission) => ({ ...permission }))
  };
  const issues = compareGitHubAppPermissionReadback(tamperedPlan, targetBinding, readback, FRESHNESS);
  assert.ok(issues.length > 0);
});

test("compareGitHubAppPermissionReadback fails closed when an observed permission key is duplicated with a conflicting level", () => {
  const plan = planGitHubAppRegistration("synthetic-app", "2026-08-28T00:00:00Z");
  const targetBinding = validTargetBinding();
  const base = readbackFromPlan(plan, targetBinding);
  // organization_projects is planned at "write"; a schema-valid readback can
  // contain both a "read" and a "write" object for the same (scope, name)
  // since they are distinct objects under `uniqueItems`. A naive Map keyed
  // by permissionKey would keep only the last one and miss the conflict.
  const conflictingDuplicate = plan.leastPrivilegeUnion.find(
    (permission) => permission.name === "organization_projects"
  );
  assert.ok(conflictingDuplicate !== undefined);
  const readback: GitHubAppPermissionReadback = {
    ...base,
    observedPermissions: [...base.observedPermissions, { ...conflictingDuplicate, level: "read" }]
  };
  const issues = compareGitHubAppPermissionReadback(plan, targetBinding, readback, FRESHNESS);
  assert.ok(issues.some((issue) => issue.message.includes("declared more than once")));
});

test("compareGitHubAppPermissionReadback fails closed when a nonAuthoritative marker is false", () => {
  const plan = planGitHubAppRegistration("synthetic-app", "2026-08-28T00:00:00Z");
  const targetBinding = validTargetBinding();
  const readback: GitHubAppPermissionReadback = {
    ...readbackFromPlan(plan, targetBinding),
    nonAuthoritative: { ...plan.nonAuthoritative, cannotMintInstallationToken: false }
  };
  const issues = compareGitHubAppPermissionReadback(plan, targetBinding, readback, FRESHNESS);
  assert.ok(issues.some((issue) => issue.path === "/nonAuthoritative/cannotMintInstallationToken"));
});

test("compareGitHubAppPermissionReadback fails closed on a denied permission", () => {
  const plan = planGitHubAppRegistration("synthetic-app", "2026-08-28T00:00:00Z");
  const targetBinding = validTargetBinding();
  const readback: GitHubAppPermissionReadback = {
    ...readbackFromPlan(plan, targetBinding),
    observedPermissions: [
      ...plan.leastPrivilegeUnion,
      { name: "administration", level: "write", scope: "repository" }
    ]
  };
  const issues = compareGitHubAppPermissionReadback(plan, targetBinding, readback, FRESHNESS);
  assert.ok(issues.some((issue) => issue.message.includes("denied list")));
});

test("compareGitHubAppPermissionReadback fails closed on an elevated permission level", () => {
  const plan = planGitHubAppRegistration("synthetic-app", "2026-08-28T00:00:00Z");
  const targetBinding = validTargetBinding();
  const readback: GitHubAppPermissionReadback = {
    ...readbackFromPlan(plan, targetBinding),
    observedPermissions: plan.leastPrivilegeUnion.map((permission) =>
      permission.name === "metadata"
        ? { ...permission, level: "write" as const }
        : { ...permission }
    )
  };
  const issues = compareGitHubAppPermissionReadback(plan, targetBinding, readback, FRESHNESS);
  assert.ok(issues.some((issue) => issue.message.includes("does not exactly match planned level")));
});

test("compareGitHubAppPermissionReadback fails closed on a downscoped permission level", () => {
  const plan = planGitHubAppRegistration("synthetic-app", "2026-08-28T00:00:00Z");
  const targetBinding = validTargetBinding();
  // organization_projects is planned at "write" (project-field-update); a
  // readback reporting only "read" must drift, not silently pass, since a
  // downscoped installation would otherwise let a bound operation fail open
  // at request time instead of failing closed here.
  const readback: GitHubAppPermissionReadback = {
    ...readbackFromPlan(plan, targetBinding),
    observedPermissions: plan.leastPrivilegeUnion.map((permission) =>
      permission.name === "organization_projects"
        ? { ...permission, level: "read" as const }
        : { ...permission }
    )
  };
  const issues = compareGitHubAppPermissionReadback(plan, targetBinding, readback, FRESHNESS);
  assert.ok(issues.some((issue) => issue.message.includes("does not exactly match planned level")));
});

test("compareGitHubAppPermissionReadback fails closed on an extra unplanned permission", () => {
  const plan = planGitHubAppRegistration("synthetic-app", "2026-08-28T00:00:00Z");
  const targetBinding = validTargetBinding();
  const readback: GitHubAppPermissionReadback = {
    ...readbackFromPlan(plan, targetBinding),
    observedPermissions: [
      ...plan.leastPrivilegeUnion,
      { name: "contents", level: "read", scope: "repository" }
    ]
  };
  const issues = compareGitHubAppPermissionReadback(plan, targetBinding, readback, FRESHNESS);
  assert.ok(issues.some((issue) => issue.message.includes("not present in the least-privilege plan")));
});

test("compareGitHubAppPermissionReadback fails closed on a missing planned permission", () => {
  const plan = planGitHubAppRegistration("synthetic-app", "2026-08-28T00:00:00Z");
  const targetBinding = validTargetBinding();
  const readback: GitHubAppPermissionReadback = {
    ...readbackFromPlan(plan, targetBinding),
    observedPermissions: plan.leastPrivilegeUnion.filter(
      (permission) => permission.name !== "checks"
    )
  };
  const issues = compareGitHubAppPermissionReadback(plan, targetBinding, readback, FRESHNESS);
  assert.ok(issues.some((issue) => issue.message.includes("was not observed")));
});

test("compareGitHubAppPermissionReadback fails closed on a stale manifest version", () => {
  const plan = planGitHubAppRegistration("synthetic-app", "2026-08-28T00:00:00Z");
  const stalePlan = { ...plan, manifestVersion: "0.9.0" };
  const targetBinding = validTargetBinding();
  const readback = readbackFromPlan(stalePlan, targetBinding);
  const issues = compareGitHubAppPermissionReadback(stalePlan, targetBinding, readback, FRESHNESS);
  assert.ok(issues.some((issue) => issue.message.includes("does not match the current reviewed manifest")));
});

test("compareGitHubAppPermissionReadback fails closed when planDigest does not match the supplied plan", () => {
  const plan = planGitHubAppRegistration("synthetic-app", "2026-08-28T00:00:00Z");
  const otherPlan = planGitHubAppRegistration("different-synthetic-app", "2026-08-28T00:00:00Z");
  const targetBinding = validTargetBinding();
  const readback = readbackFromPlan(otherPlan, targetBinding);
  const issues = compareGitHubAppPermissionReadback(plan, targetBinding, readback, FRESHNESS);
  assert.ok(issues.some((issue) => issue.path === "/planDigest"));
});

test("compareGitHubAppPermissionReadback fails closed when the target binding approval has expired", () => {
  const plan = planGitHubAppRegistration("synthetic-app", "2026-08-28T00:00:00Z");
  const targetBinding: GitHubAppInstallationTargetBinding = {
    ...validTargetBinding(),
    expiresAt: "2026-08-28T00:01:00Z"
  };
  const readback = readbackFromPlan(plan, targetBinding);
  const issues = compareGitHubAppPermissionReadback(plan, targetBinding, readback, FRESHNESS);
  assert.ok(issues.some((issue) => issue.path === "/targetBinding/expiresAt"));
});

test("compareGitHubAppPermissionReadback fails closed when the readback observation is stale", () => {
  const plan = planGitHubAppRegistration("synthetic-app", "2026-08-28T00:00:00Z");
  const targetBinding = validTargetBinding();
  const readback = readbackFromPlan(plan, targetBinding, "2026-08-27T00:00:00Z");
  const issues = compareGitHubAppPermissionReadback(plan, targetBinding, readback, FRESHNESS);
  assert.ok(issues.some((issue) => issue.path === "/observedAt"));
});

test("compareGitHubAppPermissionReadback fails closed when the readback observation is in the future", () => {
  const plan = planGitHubAppRegistration("synthetic-app", "2026-08-28T00:00:00Z");
  const targetBinding = validTargetBinding();
  const readback = readbackFromPlan(plan, targetBinding, "2026-08-29T00:00:00Z");
  const issues = compareGitHubAppPermissionReadback(plan, targetBinding, readback, FRESHNESS);
  assert.ok(issues.some((issue) => issue.path === "/observedAt"));
});

test("compareGitHubAppPermissionReadback fails closed when the observed installation id does not match the approved target", () => {
  const plan = planGitHubAppRegistration("synthetic-app", "2026-08-28T00:00:00Z");
  const targetBinding = validTargetBinding();
  const readback: GitHubAppPermissionReadback = {
    ...readbackFromPlan(plan, targetBinding),
    installationId: targetBinding.installationId + 1
  };
  const issues = compareGitHubAppPermissionReadback(plan, targetBinding, readback, FRESHNESS);
  assert.ok(issues.some((issue) => issue.path === "/installationId"));
});

test("compareGitHubAppPermissionReadback fails closed when the observed owner login does not match the approved target", () => {
  const plan = planGitHubAppRegistration("synthetic-app", "2026-08-28T00:00:00Z");
  const targetBinding = validTargetBinding();
  const readback: GitHubAppPermissionReadback = {
    ...readbackFromPlan(plan, targetBinding),
    ownerLogin: "renamed-org"
  };
  const issues = compareGitHubAppPermissionReadback(plan, targetBinding, readback, FRESHNESS);
  assert.ok(issues.some((issue) => issue.path === "/ownerLogin"));
});

test("compareGitHubAppPermissionReadback fails closed when the selected repositories do not match the approved target", () => {
  const plan = planGitHubAppRegistration("synthetic-app", "2026-08-28T00:00:00Z");
  const targetBinding = validTargetBinding();
  const readback: GitHubAppPermissionReadback = {
    ...readbackFromPlan(plan, targetBinding),
    selectedRepositories: [
      { id: 999, nodeId: "R_other", owner: "synthetic-org", name: "other-repo", fullName: "synthetic-org/other-repo" }
    ]
  };
  const issues = compareGitHubAppPermissionReadback(plan, targetBinding, readback, FRESHNESS);
  assert.ok(issues.some((issue) => issue.path === "/selectedRepositories"));
});

test("compareGitHubAppPermissionReadback fails closed when a readback duplicates one selected repository instead of reporting a distinct missing one", () => {
  const plan = planGitHubAppRegistration("synthetic-app", "2026-08-28T00:00:00Z");
  const secondRepository = {
    id: 5,
    nodeId: "R_synthetic0005",
    owner: "synthetic-org",
    name: "second-repo",
    fullName: "synthetic-org/second-repo"
  };
  const targetBinding: GitHubAppInstallationTargetBinding = {
    ...validTargetBinding(),
    selectedRepositories: [...validTargetBinding().selectedRepositories, secondRepository]
  };
  const readback: GitHubAppPermissionReadback = {
    ...readbackFromPlan(plan, targetBinding),
    // secondRepository is never actually observed; the first approved
    // repository is duplicated only to keep the array length equal to the
    // approved two-repository target.
    selectedRepositories: [targetBinding.selectedRepositories[0]!, targetBinding.selectedRepositories[0]!]
  };
  const issues = compareGitHubAppPermissionReadback(plan, targetBinding, readback, FRESHNESS);
  assert.ok(
    issues.some((issue) => issue.path === "/selectedRepositories"),
    "a duplicated repository must not silently satisfy a distinct missing approved repository"
  );
});

test("GitHubAppRegistrationPlan JSON Schema rejects a permission name outside the closed enum", () => {
  const plan = planGitHubAppRegistration("synthetic-app", "2026-08-28T00:00:00Z");
  const result = validateDocument("GitHubAppRegistrationPlan", {
    ...plan,
    leastPrivilegeUnion: [
      ...plan.leastPrivilegeUnion,
      { name: "administration", level: "write", scope: "repository" }
    ]
  });
  assert.equal(result.valid, false);
});

test("GitHubAppPermissionReadback JSON Schema rejects a document missing target identity fields", () => {
  const plan = planGitHubAppRegistration("synthetic-app", "2026-08-28T00:00:00Z");
  const targetBinding = validTargetBinding();
  const readback = readbackFromPlan(plan, targetBinding) as unknown as Record<string, unknown>;
  delete readback["ownerId"];
  const result = validateDocument("GitHubAppPermissionReadback", readback);
  assert.equal(result.valid, false);
});

test("GitHubAppPermissionReadback JSON Schema rejects a document missing the nonAuthoritative marker", () => {
  const plan = planGitHubAppRegistration("synthetic-app", "2026-08-28T00:00:00Z");
  const targetBinding = validTargetBinding();
  const readback = readbackFromPlan(plan, targetBinding) as unknown as Record<string, unknown>;
  delete readback["nonAuthoritative"];
  const result = validateDocument("GitHubAppPermissionReadback", readback);
  assert.equal(result.valid, false);
});

test("GitHubAppInstallationTargetBinding JSON Schema rejects a document with no selected repositories", () => {
  const targetBinding = validTargetBinding();
  const result = validateDocument("GitHubAppInstallationTargetBinding", {
    ...targetBinding,
    selectedRepositories: []
  });
  assert.equal(result.valid, false);
});
