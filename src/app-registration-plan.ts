/**
 * Least-privilege GitHub App registration plan, human-approved installation
 * target binding, and permission readback, derived from the reviewed
 * `GITHUB_PERMISSION_MANIFEST` operation table in `src/github-auth.ts`.
 *
 * This module never creates, transfers, installs, or authenticates a GitHub
 * App and never mints an installation token. It only computes the exact
 * least-privilege permission union an administrator must configure, records
 * the immutable numeric/node identity of an installation a human has already
 * separately approved, and compares an authenticated readback against both.
 * Elevated, extra, denied, downscoped, misbound, or stale permissions/targets
 * in a readback are treated as fail-closed drift, never silently accepted.
 *
 * The plan itself stays target-free per ADR 0004: it is derived only from
 * the manifest and an App display name, and carries no installation ID,
 * owner, or repository identity, because none of those exist before a human
 * installs the App. `GitHubAppInstallationTargetBinding` is a separate,
 * closed, human-approved record of the immutable identity actually observed
 * after installation; `compareGitHubAppPermissionReadback` requires a
 * readback to match both the plan (`planDigest`) and the approved target
 * binding (owner/app/installation/repository identity) before any
 * permission is compared, and rejects a readback observed outside the
 * caller-supplied freshness window. No wall-clock, environment, or network
 * read occurs inside this module; `now` is always caller-supplied.
 */

import { digest } from "./canonical.js";
import { findDuplicateKeys } from "./duplicate-keys.js";
import { checkNotExpired, checkObservationFreshness, type FreshnessWindow } from "./freshness.js";
import { GITHUB_PERMISSION_MANIFEST } from "./github-auth.js";
import type { GitHubPermissionGrant } from "./github-auth.js";
import type { GitHubRepositoryIdentity } from "./github-events.js";

export interface GitHubAppRegistrationOperation {
  readonly operationId: string;
  readonly permissions: readonly GitHubPermissionGrant[];
}

export interface GitHubAppNonAuthoritativePlanMarker {
  readonly cannotInstallOrTransferApp: true;
  readonly cannotAuthenticateApp: true;
  readonly cannotMintInstallationToken: true;
}

/**
 * Mirrors `GitHubAppNonAuthoritativePlanMarker` as booleans rather than
 * `true` consts so a tampered or falsified readback can be represented and
 * therefore rejected by `compareGitHubAppPermissionReadback`, instead of
 * that shape being unrepresentable.
 */
export interface GitHubAppNonAuthoritativeReadbackMarker {
  readonly cannotInstallOrTransferApp: boolean;
  readonly cannotAuthenticateApp: boolean;
  readonly cannotMintInstallationToken: boolean;
}

export interface GitHubAppRegistrationPlan {
  readonly apiVersion: "agentic-framework.github.com/v1alpha1";
  readonly kind: "GitHubAppRegistrationPlan";
  readonly schemaVersion: "1.0.0";
  readonly generatedAt: string;
  readonly manifestVersion: string;
  readonly appName: string;
  readonly operations: readonly GitHubAppRegistrationOperation[];
  readonly deniedPermissionNames: readonly string[];
  readonly leastPrivilegeUnion: readonly GitHubPermissionGrant[];
  readonly nonAuthoritative: GitHubAppNonAuthoritativePlanMarker;
}

export type GitHubAccountType = "organization" | "user";

/**
 * A closed, human-approved record of the immutable identity observed after
 * a human separately installed the App. This document does not itself
 * install, transfer, or authenticate anything; it only binds later
 * comparisons to one exact, already-existing target so a readback cannot be
 * silently accepted for the wrong owner, App, installation, or repository
 * set. `approvedBy` is an opaque human identity handle, never a credential.
 * `expiresAt` bounds how long the approval itself may be relied on before a
 * fresh human re-approval is required.
 */
export interface GitHubAppInstallationTargetBinding {
  readonly apiVersion: "agentic-framework.github.com/v1alpha1";
  readonly kind: "GitHubAppInstallationTargetBinding";
  readonly schemaVersion: "1.0.0";
  readonly approvedAt: string;
  readonly approvedBy: string;
  readonly expiresAt: string;
  readonly owner: {
    readonly id: number;
    readonly nodeId: string;
    readonly login: string;
    readonly accountType: GitHubAccountType;
  };
  readonly app: {
    readonly id: number;
    readonly nodeId: string;
  };
  readonly installationId: number;
  readonly selectedRepositories: readonly GitHubRepositoryIdentity[];
}

export interface GitHubAppPermissionReadback {
  readonly apiVersion: "agentic-framework.github.com/v1alpha1";
  readonly kind: "GitHubAppPermissionReadback";
  readonly schemaVersion: "1.0.0";
  readonly observedAt: string;
  readonly planDigest: string;
  readonly ownerId: number;
  readonly ownerNodeId: string;
  readonly ownerLogin: string;
  readonly accountType: GitHubAccountType;
  readonly appId: number;
  readonly appNodeId: string;
  readonly installationId: number;
  readonly selectedRepositories: readonly GitHubRepositoryIdentity[];
  readonly observedPermissions: readonly {
    readonly name: string;
    readonly level: "read" | "write";
    readonly scope: "organization" | "repository";
  }[];
  /**
   * The readback's own evidence-only claim, checked exactly against
   * `GitHubAppRegistrationPlan.nonAuthoritative` by
   * `compareGitHubAppPermissionReadback`.
   */
  readonly nonAuthoritative: GitHubAppNonAuthoritativeReadbackMarker;
}

export interface GitHubAppRegistrationIssue {
  readonly path: string;
  readonly message: string;
}

export class GitHubAppRegistrationError extends Error {
  constructor(readonly issues: readonly GitHubAppRegistrationIssue[]) {
    super(
      `GitHub App registration plan is invalid: ${issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("; ")}`
    );
    this.name = "GitHubAppRegistrationError";
  }
}

function permissionKey(permission: {
  readonly name: string;
  readonly scope: string;
}): string {
  return `${permission.scope}:${permission.name}`;
}

function permissionEntryKey(permission: GitHubPermissionGrant): string {
  return `${permissionKey(permission)}:${permission.level}`;
}

/**
 * Exact, order-independent equality over two permission-grant arrays: same
 * length and every (scope, name, level) entry present in both. Neither the
 * reviewed manifest's per-operation permission lists nor the derived
 * least-privilege union may contain duplicate (scope, name) entries, so set
 * membership is sufficient without needing multiset counting.
 */
/**
 * Exact set equality over (scope, name, level) keys: same distinct entries
 * on both sides, with no duplicates tolerated on either side. Checking only
 * `length` plus one-directional membership is unsound — a side that
 * repeats one entry instead of reporting a distinct one the other side has
 * would still pass length and membership checks. Duplicates on either side
 * are therefore treated as inequality, so a duplicated entry can never pad
 * length to mask an omitted or substituted permission.
 */
function permissionsExactlyEqual(
  left: readonly GitHubPermissionGrant[],
  right: readonly GitHubPermissionGrant[]
): boolean {
  const leftKeys = left.map(permissionEntryKey);
  const rightKeys = right.map(permissionEntryKey);
  const leftSet = new Set(leftKeys);
  const rightSet = new Set(rightKeys);
  if (leftSet.size !== leftKeys.length || rightSet.size !== rightKeys.length) {
    return false;
  }
  if (leftSet.size !== rightSet.size) return false;
  for (const key of leftSet) {
    if (!rightSet.has(key)) return false;
  }
  return true;
}

const LEVEL_RANK: Readonly<Record<"read" | "write", number>> = { read: 0, write: 1 };

/**
 * Computes the exact least-privilege permission union across every operation
 * in the reviewed manifest, deduplicated by (scope, name) and retaining the
 * highest level required by any operation for that permission.
 */
function computeLeastPrivilegeUnion(
  operations: readonly GitHubAppRegistrationOperation[]
): readonly GitHubPermissionGrant[] {
  const byKey = new Map<string, GitHubPermissionGrant>();
  for (const operation of operations) {
    for (const permission of operation.permissions) {
      const key = permissionKey(permission);
      const existing = byKey.get(key);
      if (existing === undefined || LEVEL_RANK[permission.level] > LEVEL_RANK[existing.level]) {
        byKey.set(key, permission);
      }
    }
  }
  return [...byKey.values()].sort((left, right) =>
    permissionKey(left).localeCompare(permissionKey(right))
  );
}

function manifestOperations(): readonly GitHubAppRegistrationOperation[] {
  return Object.entries(GITHUB_PERMISSION_MANIFEST.operations).map(
    ([operationId, permissions]) => ({ operationId, permissions })
  );
}

/**
 * Deterministically derives the least-privilege GitHub App registration plan
 * from the reviewed `GITHUB_PERMISSION_MANIFEST`. The operation table and
 * denied-permission list are read from the manifest only; no caller or model
 * input can add, omit, or elevate a permission.
 */
export function planGitHubAppRegistration(
  appName: string,
  generatedAt: string
): GitHubAppRegistrationPlan {
  if (appName.trim().length === 0) {
    throw new GitHubAppRegistrationError([
      { path: "/appName", message: "appName must not be empty" }
    ]);
  }
  const operations = manifestOperations();
  const leastPrivilegeUnion = computeLeastPrivilegeUnion(operations);
  const deniedNames = new Set<string>(GITHUB_PERMISSION_MANIFEST.denied);
  const elevatedIssues = leastPrivilegeUnion
    .filter((permission) => deniedNames.has(permission.name))
    .map((permission) => ({
      path: `/leastPrivilegeUnion/${permissionKey(permission)}`,
      message: `permission name ${permission.name} is on the denied list and cannot be requested`
    }));
  if (elevatedIssues.length > 0) {
    throw new GitHubAppRegistrationError(elevatedIssues);
  }

  const plan: GitHubAppRegistrationPlan = {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "GitHubAppRegistrationPlan",
    schemaVersion: "1.0.0",
    generatedAt,
    manifestVersion: GITHUB_PERMISSION_MANIFEST.version,
    appName,
    operations,
    deniedPermissionNames: [...GITHUB_PERMISSION_MANIFEST.denied],
    leastPrivilegeUnion,
    nonAuthoritative: {
      cannotInstallOrTransferApp: true,
      cannotAuthenticateApp: true,
      cannotMintInstallationToken: true
    }
  };

  const issues = validateGitHubAppRegistrationPlan(plan);
  if (issues.length > 0) {
    throw new GitHubAppRegistrationError(issues);
  }
  return plan;
}

/**
 * Fails closed on an ingested `GitHubAppRegistrationPlan` (for example one
 * read back from storage or supplied by an untrusted caller) whose
 * `operations`, `deniedPermissionNames`, or `leastPrivilegeUnion` do not
 * exactly match what the reviewed `GITHUB_PERMISSION_MANIFEST` requires:
 * a missing or extra operation, a permission list that differs from the
 * manifest for a known operation, a missing or extra denied-permission name,
 * or a least-privilege union that omits, adds, or elevates a permission
 * relative to what `computeLeastPrivilegeUnion` would derive fresh from the
 * manifest. A stale `manifestVersion` is rejected before any of these
 * structural comparisons, since a plan bound to a superseded manifest cannot
 * be meaningfully re-derived against the current one.
 */
export function validateGitHubAppRegistrationPlan(
  plan: GitHubAppRegistrationPlan
): readonly GitHubAppRegistrationIssue[] {
  const issues: GitHubAppRegistrationIssue[] = [];
  if (plan.manifestVersion !== GITHUB_PERMISSION_MANIFEST.version) {
    issues.push({
      path: "/manifestVersion",
      message: `plan manifest version ${plan.manifestVersion} does not match the current reviewed manifest ${GITHUB_PERMISSION_MANIFEST.version}`
    });
    return issues;
  }

  const expectedOperations = manifestOperations();
  const expectedByOperationId = new Map(
    expectedOperations.map((operation) => [operation.operationId, operation])
  );
  const observedByOperationId = new Map(
    plan.operations.map((operation) => [operation.operationId, operation])
  );
  if (observedByOperationId.size !== plan.operations.length) {
    issues.push({ path: "/operations", message: "duplicate operationId entries are not permitted" });
  }
  for (const [operationId, expected] of expectedByOperationId) {
    const observed = observedByOperationId.get(operationId);
    if (observed === undefined) {
      issues.push({
        path: `/operations/${operationId}`,
        message: "reviewed manifest operation is missing from the plan"
      });
      continue;
    }
    if (!permissionsExactlyEqual(observed.permissions, expected.permissions)) {
      issues.push({
        path: `/operations/${operationId}/permissions`,
        message: "plan operation permissions do not exactly match the reviewed manifest"
      });
    }
  }
  for (const operationId of observedByOperationId.keys()) {
    if (!expectedByOperationId.has(operationId)) {
      issues.push({
        path: `/operations/${operationId}`,
        message: "plan declares an operation absent from the reviewed manifest"
      });
    }
  }

  const expectedDenied = new Set<string>(GITHUB_PERMISSION_MANIFEST.denied);
  const observedDenied = new Set<string>(plan.deniedPermissionNames);
  if (observedDenied.size !== plan.deniedPermissionNames.length) {
    issues.push({ path: "/deniedPermissionNames", message: "duplicate denied permission names are not permitted" });
  }
  for (const name of expectedDenied) {
    if (!observedDenied.has(name)) {
      issues.push({ path: "/deniedPermissionNames", message: `reviewed manifest denies ${name}, but the plan omits it` });
    }
  }
  for (const name of observedDenied) {
    if (!expectedDenied.has(name)) {
      issues.push({ path: "/deniedPermissionNames", message: `plan denies ${name}, which is absent from the reviewed manifest` });
    }
  }

  const expectedUnion = computeLeastPrivilegeUnion(expectedOperations);
  if (!permissionsExactlyEqual(plan.leastPrivilegeUnion, expectedUnion)) {
    issues.push({
      path: "/leastPrivilegeUnion",
      message: "plan least-privilege union does not exactly match the union derived from the reviewed manifest"
    });
  }

  return issues;
}

function repositoryKey(repository: GitHubRepositoryIdentity): string {
  return `${repository.id}:${repository.nodeId}`;
}

/**
 * Exact set equality over (id, nodeId) keys: same distinct repositories on
 * both sides, with no duplicates tolerated on either side. Checking only
 * `length` plus one-directional membership is unsound — a side that
 * repeats one repository instead of reporting a distinct one the other side
 * has would still pass length and membership checks. Duplicates on either
 * side are therefore treated as inequality, so a duplicated repository
 * entry can never pad length to mask an omitted or substituted repository.
 */
function repositorySetsExactlyEqual(
  left: readonly GitHubRepositoryIdentity[],
  right: readonly GitHubRepositoryIdentity[]
): boolean {
  const leftKeys = left.map(repositoryKey);
  const rightKeys = right.map(repositoryKey);
  const leftSet = new Set(leftKeys);
  const rightSet = new Set(rightKeys);
  if (leftSet.size !== leftKeys.length || rightSet.size !== rightKeys.length) {
    return false;
  }
  if (leftSet.size !== rightSet.size) return false;
  for (const key of leftSet) {
    if (!rightSet.has(key)) return false;
  }
  return true;
}

/**
 * Fails closed when an authenticated permission readback diverges from the
 * least-privilege plan, the human-approved installation target, or the
 * supplied freshness window. Checked in order, each stopping the comparison
 * immediately on failure so later checks are never evaluated against an
 * already-untrusted plan, target, or observation:
 *
 * 1. `validateGitHubAppRegistrationPlan(plan)` — the plan itself must still
 *    exactly match the reviewed manifest.
 * 2. `readback.planDigest` must equal a canonical digest of `plan`.
 * 3. `targetBinding.expiresAt` must not have lapsed relative to
 *    `freshness.now`, and `readback.observedAt` must fall within
 *    `freshness.maxAgeMs` of `freshness.now` and not be in the future. No
 *    clock is read internally; `freshness.now` is caller-supplied.
 * 4. Every owner/app/installation/repository-set field on the readback must
 *    exactly equal the corresponding field on `targetBinding` — an
 *    immutable numeric/node identity, never a mutable display name.
 *
 * Only once all of the above hold are individual permissions compared: a
 * denied permission name, a level that differs at all from plan (elevated
 * *or* downscoped), an extra permission absent from the plan, or a planned
 * permission missing from the readback are all reported (a silently
 * downscoped permission would otherwise let a bound operation fail open at
 * request time instead of failing closed here). Before that comparison,
 * `readback.observedPermissions` is checked for a duplicated permission key
 * (scope+name): a naive `Map` keyed by that value would otherwise silently
 * keep only the last entry for a repeated key, discarding a conflicting
 * duplicate observation (for example a `read` and a `write` grant for the
 * same permission) rather than failing closed on it.
 *
 * Finally, the readback's own `nonAuthoritative` marker is compared field
 * by field against the plan's.
 */
export function compareGitHubAppPermissionReadback(
  plan: GitHubAppRegistrationPlan,
  targetBinding: GitHubAppInstallationTargetBinding,
  readback: GitHubAppPermissionReadback,
  freshness: FreshnessWindow
): readonly GitHubAppRegistrationIssue[] {
  const planIssues = validateGitHubAppRegistrationPlan(plan);
  if (planIssues.length > 0) {
    return planIssues;
  }
  if (readback.planDigest !== digest(plan)) {
    return [
      {
        path: "/planDigest",
        message: "readback planDigest does not match a canonical digest of the supplied plan"
      }
    ];
  }

  const freshnessFailures = [
    ...checkNotExpired("/targetBinding/expiresAt", targetBinding.expiresAt, freshness.now),
    ...checkObservationFreshness("/observedAt", readback.observedAt, freshness)
  ];
  if (freshnessFailures.length > 0) {
    return freshnessFailures;
  }

  const targetIssues: GitHubAppRegistrationIssue[] = [];
  if (readback.ownerId !== targetBinding.owner.id) {
    targetIssues.push({ path: "/ownerId", message: "observed owner id does not match the approved target binding" });
  }
  if (readback.ownerNodeId !== targetBinding.owner.nodeId) {
    targetIssues.push({ path: "/ownerNodeId", message: "observed owner node id does not match the approved target binding" });
  }
  if (readback.ownerLogin !== targetBinding.owner.login) {
    targetIssues.push({ path: "/ownerLogin", message: "observed owner login does not match the approved target binding" });
  }
  if (readback.accountType !== targetBinding.owner.accountType) {
    targetIssues.push({ path: "/accountType", message: "observed account type does not match the approved target binding" });
  }
  if (readback.appId !== targetBinding.app.id) {
    targetIssues.push({ path: "/appId", message: "observed App id does not match the approved target binding" });
  }
  if (readback.appNodeId !== targetBinding.app.nodeId) {
    targetIssues.push({ path: "/appNodeId", message: "observed App node id does not match the approved target binding" });
  }
  if (readback.installationId !== targetBinding.installationId) {
    targetIssues.push({ path: "/installationId", message: "observed installation id does not match the approved target binding" });
  }
  if (!repositorySetsExactlyEqual(readback.selectedRepositories, targetBinding.selectedRepositories)) {
    targetIssues.push({
      path: "/selectedRepositories",
      message: "observed selected repositories do not exactly match the approved target binding"
    });
  }
  if (targetIssues.length > 0) {
    return targetIssues;
  }

  const duplicateKeyIssues = findDuplicateKeys(readback.observedPermissions, permissionKey).map((key) => ({
    path: `/observedPermissions/${key}`,
    message: `observed permission key ${key} is declared more than once; a conflicting duplicate observation is never resolved by keeping only the last entry`
  }));
  if (duplicateKeyIssues.length > 0) {
    return duplicateKeyIssues;
  }

  const issues: GitHubAppRegistrationIssue[] = [];
  const deniedNames = new Set<string>(GITHUB_PERMISSION_MANIFEST.denied);
  const plannedByKey = new Map(
    plan.leastPrivilegeUnion.map((permission) => [permissionKey(permission), permission])
  );
  const observedByKey = new Map(
    readback.observedPermissions.map((permission) => [permissionKey(permission), permission])
  );

  for (const observed of readback.observedPermissions) {
    if (deniedNames.has(observed.name)) {
      issues.push({
        path: `/observedPermissions/${permissionKey(observed)}`,
        message: `observed permission ${observed.name} is on the denied list`
      });
      continue;
    }
    const planned = plannedByKey.get(permissionKey(observed));
    if (planned === undefined) {
      issues.push({
        path: `/observedPermissions/${permissionKey(observed)}`,
        message: "observed permission is not present in the least-privilege plan"
      });
      continue;
    }
    if (observed.level !== planned.level) {
      issues.push({
        path: `/observedPermissions/${permissionKey(observed)}`,
        message: `observed level ${observed.level} does not exactly match planned level ${planned.level}`
      });
    }
  }

  for (const planned of plan.leastPrivilegeUnion) {
    if (!observedByKey.has(permissionKey(planned))) {
      issues.push({
        path: `/leastPrivilegeUnion/${permissionKey(planned)}`,
        message: "planned permission was not observed on the installed App"
      });
    }
  }

  for (const [key, requiredValue] of Object.entries(plan.nonAuthoritative) as [
    keyof GitHubAppNonAuthoritativePlanMarker,
    boolean
  ][]) {
    if (readback.nonAuthoritative[key] !== requiredValue) {
      issues.push({
        path: `/nonAuthoritative/${key}`,
        message: `observed non-authoritative marker ${String(readback.nonAuthoritative[key])} does not match required value ${String(requiredValue)}`
      });
    }
  }

  return issues;
}
