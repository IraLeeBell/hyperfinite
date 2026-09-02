/**
 * Closed administrator configuration plan and readback for rulesets,
 * required checks, Actions policy, GitHub Advanced Security settings,
 * Project binding, and incident contacts.
 *
 * This module never applies a ruleset, required check, workflow permission,
 * GHAS setting, or Project mutation. It only computes the closed desired
 * configuration (`planAdministratorConfiguration`) and compares it against an
 * authenticated readback (`compareAdministratorReadback`) so drift is
 * reported instead of silently accepted. Field names mirror the actual
 * GitHub REST/GraphQL surface (repository rulesets can be repository- or
 * organization-owned, and classic branch protection may be entirely absent
 * when organization rulesets provide enforcement instead) so a real
 * authenticated readback maps onto this contract without reinterpretation.
 *
 * The repository target is bound by immutable numeric/node identity
 * (`GitHubRepositoryIdentity`), never by a mutable full-name string, so a
 * rename cannot silently redirect a plan to a different repository.
 * `compareAdministratorReadback`'s returned issues are the sole compliance
 * result; a readback's own `driftFound` field is only a caller-supplied
 * coherence assertion (see `checkReadbackDriftCoherence`) and never
 * suppresses or overrides an actual comparator finding.
 */

import { checkObservationFreshness, type FreshnessWindow } from "./freshness.js";
import { digest } from "./canonical.js";
import { findDuplicateKeys } from "./duplicate-keys.js";
import type { GitHubRepositoryIdentity } from "./github-events.js";

export type RequiredCheckName =
  | "typecheck"
  | "build"
  | "test"
  | "validate:schemas"
  | "validate:runtime"
  | "validate:workflows"
  | "validate:gh-aw"
  | "validate:packaging"
  | "validate:demos"
  | "validate:hardening"
  | "codeql"
  | "dependency-review";

export const REQUIRED_CHECK_NAMES: readonly RequiredCheckName[] = [
  "typecheck",
  "build",
  "test",
  "validate:schemas",
  "validate:runtime",
  "validate:workflows",
  "validate:gh-aw",
  "validate:packaging",
  "validate:demos",
  "validate:hardening",
  "codeql",
  "dependency-review"
];

export type RulesetSource = "repository" | "organization";
export type RulesetTarget = "branch" | "tag";

/**
 * The exact ref-matching conditions GitHub evaluates for a ruleset, and the
 * closed, fully-resolved set of refs the ruleset actually protects once
 * `exclude` is applied to `include`. Carrying both lets a comparator detect
 * a ruleset whose declared conditions no longer protect the ref its name or
 * intent implies (for example a ruleset named for the default branch whose
 * `include` conditions were quietly repointed at a different branch).
 */
export interface RulesetRefConditions {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
}

export interface AdministratorRulesetCommon {
  readonly rulesetId: string;
  readonly source: RulesetSource;
  readonly refConditions: RulesetRefConditions;
  readonly effectiveProtectedRefs: readonly string[];
  readonly enforcement: "active";
  /**
   * Must be empty for a valid plan. The type is intentionally
   * `readonly string[]` (not `readonly []`) so `validateAdministratorPlan`
   * can accept and report a non-empty value supplied by an untrusted or
   * tampered document instead of that shape being unrepresentable.
   */
  readonly bypassActors: readonly string[];
}

/**
 * GitHub exposes pull-request/CODEOWNERS/current-head-approval rules only
 * for `branch`-targeted rulesets. Modeling branch and tag rulesets as a
 * discriminated union on `target` makes an "impossible" tag ruleset — one
 * that declares branch-only controls GitHub would never honor for a tag —
 * a type error at construction time and a schema/validator rejection for an
 * ingested document, instead of silently accepting fields that cannot
 * apply.
 */
export interface AdministratorBranchRulesetPlan extends AdministratorRulesetCommon {
  readonly target: "branch";
  readonly requiresPullRequest: true;
  readonly requiresCodeownerReview: true;
  readonly requiresCurrentHeadApproval: true;
}

/**
 * GitHub's tag-ruleset rule types restrict tag creation, update, and
 * deletion outside the ruleset's (here always-empty) bypass list; they
 * carry no pull-request or review concept. `restrictsTagCreation`,
 * `restrictsTagUpdate`, and `restrictsTagDeletion` model exactly those
 * three supported rule types.
 */
export interface AdministratorTagRulesetPlan extends AdministratorRulesetCommon {
  readonly target: "tag";
  readonly restrictsTagCreation: true;
  readonly restrictsTagUpdate: true;
  readonly restrictsTagDeletion: true;
}

export type AdministratorRulesetPlan = AdministratorBranchRulesetPlan | AdministratorTagRulesetPlan;

export interface AdministratorRulesetReadbackCommon {
  readonly rulesetId: string;
  readonly source: RulesetSource;
  readonly refConditions: RulesetRefConditions;
  readonly effectiveProtectedRefs: readonly string[];
  readonly enforcement: "active" | "evaluate" | "disabled";
  readonly bypassActors: readonly string[];
}

export interface AdministratorBranchRulesetReadback extends AdministratorRulesetReadbackCommon {
  readonly target: "branch";
  readonly requiresPullRequest: boolean;
  readonly requiresCodeownerReview: boolean;
  readonly requiresCurrentHeadApproval: boolean;
}

export interface AdministratorTagRulesetReadback extends AdministratorRulesetReadbackCommon {
  readonly target: "tag";
  readonly restrictsTagCreation: boolean;
  readonly restrictsTagUpdate: boolean;
  readonly restrictsTagDeletion: boolean;
}

export type AdministratorRulesetReadback = AdministratorBranchRulesetReadback | AdministratorTagRulesetReadback;

export interface AdministratorEnvironmentPlan {
  readonly environmentId: string;
  readonly requiresReviewers: true;
  readonly hasProtectionRules: true;
}

export interface AdministratorEnvironmentReadback {
  readonly environmentId: string;
  readonly requiresReviewers: boolean;
  readonly hasProtectionRules: boolean;
}

export interface RequiredCheckPlan {
  readonly checkName: RequiredCheckName;
  readonly required: true;
}

export interface RequiredCheckReadback {
  readonly checkName: string;
  readonly required: boolean;
}

export interface ActionsPolicyPlan {
  readonly allowedActions: "local_only" | "selected";
  readonly defaultWorkflowPermissions: "read";
  readonly canApprovePullRequestReviews: false;
  readonly shaPinningRequired: true;
  readonly requireApprovalForForkPullRequests: true;
}

export interface ActionsPolicyReadback {
  readonly allowedActions: string;
  readonly defaultWorkflowPermissions: string;
  readonly canApprovePullRequestReviews: boolean;
  readonly shaPinningRequired: boolean;
  readonly requireApprovalForForkPullRequests: boolean;
}

export interface GhasSettingsPlan {
  readonly advancedSecurity: true;
  readonly dependabotAlerts: true;
  readonly dependabotSecurityUpdates: true;
  readonly secretScanning: true;
  readonly secretScanningPushProtection: true;
  readonly secretScanningValidityChecks: true;
  readonly secretScanningNonProviderPatterns: true;
  readonly codeScanningDefaultSetup: true;
  readonly delegatedAlertDismissal: false;
  readonly delegatedBypass: false;
}

export interface GhasSettingsReadback {
  readonly advancedSecurity: boolean;
  readonly dependabotAlerts: boolean;
  readonly dependabotSecurityUpdates: boolean;
  readonly secretScanning: boolean;
  readonly secretScanningPushProtection: boolean;
  readonly secretScanningValidityChecks: boolean;
  readonly secretScanningNonProviderPatterns: boolean;
  readonly codeScanningDefaultSetup: boolean;
  readonly delegatedAlertDismissal: boolean;
  readonly delegatedBypass: boolean;
}

export interface ProjectBindingPlan {
  readonly projectNumber: number;
  readonly ownerLogin: string;
  readonly schemaDigest: string;
  readonly mutationRequiresExplicitConfirmation: true;
}

export interface ProjectBindingReadback {
  readonly projectNumber: number;
  readonly ownerLogin: string;
  readonly schemaDigest: string;
  readonly mutationRequiresExplicitConfirmation: boolean;
}

export type IncidentContactRole = "security-owner" | "platform-owner" | "on-call-admin";

export interface IncidentContact {
  readonly role: IncidentContactRole;
  readonly contactHandle: string;
}

export interface AdministratorNonAuthoritativePlanMarker {
  readonly cannotApplyRuleset: true;
  readonly cannotApplyActionsPolicy: true;
  readonly cannotApplyGhasSetting: true;
  readonly cannotMutateProject: true;
  readonly cannotChangeVisibilityOrBilling: true;
}

/**
 * A readback carries the same evidence-only claim as its plan, but as
 * booleans rather than `true` consts: this keeps the shape representable
 * for an untrusted or tampered ingested document, so
 * `compareAdministratorReadback` can detect and report a readback that
 * silently drops or falsifies the claim instead of that shape being
 * unrepresentable.
 */
export interface AdministratorNonAuthoritativeReadbackMarker {
  readonly cannotApplyRuleset: boolean;
  readonly cannotApplyActionsPolicy: boolean;
  readonly cannotApplyGhasSetting: boolean;
  readonly cannotMutateProject: boolean;
  readonly cannotChangeVisibilityOrBilling: boolean;
}

export interface AdministratorPlan {
  readonly apiVersion: "agentic-framework.github.com/v1alpha1";
  readonly kind: "AdministratorPlan";
  readonly schemaVersion: "1.0.0";
  readonly generatedAt: string;
  readonly repository: GitHubRepositoryIdentity;
  readonly requiresRulesetBasedEnforcement: true;
  readonly rulesets: readonly AdministratorRulesetPlan[];
  readonly environments: readonly AdministratorEnvironmentPlan[];
  readonly requiredChecks: readonly RequiredCheckPlan[];
  readonly actionsPolicy: ActionsPolicyPlan;
  readonly ghas: GhasSettingsPlan;
  readonly projectBinding: ProjectBindingPlan;
  readonly incidentContacts: readonly IncidentContact[];
  readonly nonAuthoritative: AdministratorNonAuthoritativePlanMarker;
}

export interface AdministratorReadback {
  readonly apiVersion: "agentic-framework.github.com/v1alpha1";
  readonly kind: "AdministratorReadback";
  readonly schemaVersion: "1.0.0";
  readonly observedAt: string;
  readonly planDigest: string;
  readonly repository: GitHubRepositoryIdentity;
  readonly classicBranchProtectionObserved: boolean;
  readonly rulesets: readonly AdministratorRulesetReadback[];
  readonly environments: readonly AdministratorEnvironmentReadback[];
  readonly requiredChecks: readonly RequiredCheckReadback[];
  readonly actionsPolicy: ActionsPolicyReadback;
  readonly ghas: GhasSettingsReadback;
  readonly projectBinding: ProjectBindingReadback;
  readonly incidentContacts: readonly IncidentContact[];
  /**
   * The readback's own evidence-only claim, checked exactly against
   * `AdministratorPlan.nonAuthoritative` by `compareAdministratorReadback`
   * (see `requireNonAuthoritativeMatch`). Every document this contract
   * family defines carries an explicit non-authoritative marker; a
   * readback is no exception.
   */
  readonly nonAuthoritative: AdministratorNonAuthoritativeReadbackMarker;
  /**
   * A caller-supplied coherence assertion only — see
   * `checkReadbackDriftCoherence`. It is never read by
   * `compareAdministratorReadback` and cannot suppress or override an actual
   * comparator finding.
   */
  readonly driftFound: boolean;
}

export interface AdministratorPlanInput {
  readonly generatedAt: string;
  readonly repository: GitHubRepositoryIdentity;
  readonly rulesets: readonly AdministratorRulesetPlan[];
  readonly environments: readonly AdministratorEnvironmentPlan[];
  readonly projectBinding: ProjectBindingPlan;
  readonly incidentContacts: readonly IncidentContact[];
}

export interface AdministratorPlanIssue {
  readonly path: string;
  readonly message: string;
}

export class AdministratorPlanError extends Error {
  constructor(readonly issues: readonly AdministratorPlanIssue[]) {
    super(
      `administrator plan is invalid: ${issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("; ")}`
    );
    this.name = "AdministratorPlanError";
  }
}

/**
 * Exact set equality: same distinct values on both sides, with no
 * duplicates tolerated on either side. Checking only `length` plus
 * one-directional membership (as a naive "subset of equal length" check
 * would) is unsound: a side that repeats one value instead of reporting a
 * distinct one the other side has would still pass. Duplicates on either
 * side are therefore treated as inequality rather than silently ignored, so
 * a readback cannot pad its length with a repeated ref to mask an omitted
 * or substituted one.
 */
function stringSetsExactlyEqual(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  if (leftSet.size !== left.length || rightSet.size !== right.length) {
    return false;
  }
  if (leftSet.size !== rightSet.size) return false;
  for (const value of leftSet) {
    if (!rightSet.has(value)) return false;
  }
  return true;
}

function computeEffectiveProtectedRefs(conditions: RulesetRefConditions): readonly string[] {
  const excluded = new Set(conditions.exclude);
  return conditions.include.filter((ref) => !excluded.has(ref));
}

const REF_PREFIX_BY_TARGET: Readonly<Record<RulesetTarget, string>> = {
  branch: "refs/heads/",
  tag: "refs/tags/"
};

/**
 * `computeEffectiveProtectedRefs` and the comparator's ref-condition
 * equality checks perform exact string-set arithmetic. That is only sound
 * when every ref is a literal, fully-qualified ref name: this closed
 * contract does not implement GitHub's fnmatch glob semantics, so a
 * wildcard or glob-metacharacter ref (for example `refs/heads/*` used as an
 * `exclude` entry intended to remove `refs/heads/main` from protection)
 * would not actually subtract anything from a literal `include` set, and
 * `effectiveProtectedRefs` could misstate a ref as protected when a live
 * GitHub ruleset using real glob evaluation would not enforce it — or the
 * reverse. Rather than reimplement GitHub's ref-matching semantics, every
 * ref this contract accepts must be a literal ref: no `*`, `?`, `[`, `]`,
 * or whitespace. A ruleset that needs to describe multiple refs must
 * enumerate them as separate literal `include` entries or separate
 * rulesets.
 */
const REF_GLOB_METACHARACTER_PATTERN = /[\s*?[\]]/;

function isLiteralRef(ref: string): boolean {
  return !REF_GLOB_METACHARACTER_PATTERN.test(ref);
}

/**
 * Deterministically assembles a closed administrator plan. The required
 * check catalog, Actions policy, and GHAS settings are fixed by this module
 * and always emitted in full; only the repository-specific rulesets,
 * environments, Project binding, and incident contacts are caller-supplied.
 */
export function planAdministratorConfiguration(
  input: AdministratorPlanInput
): AdministratorPlan {
  if (input.rulesets.length === 0) {
    throw new AdministratorPlanError([
      { path: "/rulesets", message: "at least one ruleset is required" }
    ]);
  }
  if (input.incidentContacts.length === 0) {
    throw new AdministratorPlanError([
      { path: "/incidentContacts", message: "at least one incident contact is required" }
    ]);
  }

  const plan: AdministratorPlan = {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "AdministratorPlan",
    schemaVersion: "1.0.0",
    generatedAt: input.generatedAt,
    repository: input.repository,
    requiresRulesetBasedEnforcement: true,
    rulesets: input.rulesets,
    environments: input.environments,
    requiredChecks: REQUIRED_CHECK_NAMES.map((checkName) => ({
      checkName,
      required: true
    })),
    actionsPolicy: {
      allowedActions: "selected",
      defaultWorkflowPermissions: "read",
      canApprovePullRequestReviews: false,
      shaPinningRequired: true,
      requireApprovalForForkPullRequests: true
    },
    ghas: {
      advancedSecurity: true,
      dependabotAlerts: true,
      dependabotSecurityUpdates: true,
      secretScanning: true,
      secretScanningPushProtection: true,
      secretScanningValidityChecks: true,
      secretScanningNonProviderPatterns: true,
      codeScanningDefaultSetup: true,
      delegatedAlertDismissal: false,
      delegatedBypass: false
    },
    projectBinding: input.projectBinding,
    incidentContacts: input.incidentContacts,
    nonAuthoritative: {
      cannotApplyRuleset: true,
      cannotApplyActionsPolicy: true,
      cannotApplyGhasSetting: true,
      cannotMutateProject: true,
      cannotChangeVisibilityOrBilling: true
    }
  };

  const issues = validateAdministratorPlan(plan);
  if (issues.length > 0) {
    throw new AdministratorPlanError(issues);
  }
  return plan;
}

/**
 * Fails closed on a plan that omits a required check, requests a bypass
 * actor on any ruleset, declares a duplicate rulesetId/environmentId/
 * incident-contact role, declares a non-literal (wildcard or glob) ref in
 * any ruleset's conditions or resolved protected refs, declares ref
 * conditions that do not resolve to `effectiveProtectedRefs` or protect no
 * ref at all, declares a ref outside its own target's namespace (a
 * `branch` ruleset protecting `refs/tags/*` or vice versa), names a
 * ruleset for the default branch while its conditions protect a different
 * ref, declares a `branch` ruleset that does not require pull request,
 * CODEOWNERS review, and current-head approval, declares a `tag` ruleset
 * that does not restrict tag creation, update, and deletion (the only
 * ruleset rule types GitHub exposes for a tag target — a tag ruleset
 * cannot carry the branch-only controls), grants environment write
 * approval to Actions workflows, or diverges from any other fixed
 * GHAS/Actions/fork-approval/SHA-pinning/read-permission control this
 * contract promises — not merely a representative subset of them.
 */
export function validateAdministratorPlan(
  plan: AdministratorPlan
): readonly AdministratorPlanIssue[] {
  const issues: AdministratorPlanIssue[] = [];
  const observedChecks = new Set(plan.requiredChecks.map((check) => check.checkName));
  if (observedChecks.size !== plan.requiredChecks.length) {
    issues.push({ path: "/requiredChecks", message: "duplicate required check names are not permitted" });
  }
  for (const checkName of REQUIRED_CHECK_NAMES) {
    if (!observedChecks.has(checkName)) {
      issues.push({ path: "/requiredChecks", message: `missing required check ${checkName}` });
    }
  }
  for (const rulesetId of findDuplicateKeys(plan.rulesets, (ruleset) => ruleset.rulesetId)) {
    issues.push({ path: "/rulesets", message: `duplicate rulesetId ${rulesetId} is not permitted` });
  }
  for (const environmentId of findDuplicateKeys(plan.environments, (environment) => environment.environmentId)) {
    issues.push({ path: "/environments", message: `duplicate environmentId ${environmentId} is not permitted` });
  }
  for (const role of findDuplicateKeys(plan.incidentContacts, (contact) => contact.role)) {
    issues.push({ path: "/incidentContacts", message: `duplicate incident contact role ${role} is not permitted` });
  }
  for (const ruleset of plan.rulesets) {
    if (ruleset.bypassActors.length > 0) {
      issues.push({
        path: `/rulesets/${ruleset.rulesetId}/bypassActors`,
        message: "ruleset must not declare a bypass actor"
      });
    }
    if (ruleset.refConditions.include.length === 0) {
      issues.push({
        path: `/rulesets/${ruleset.rulesetId}/refConditions/include`,
        message: "ruleset must include at least one ref condition"
      });
    }
    const nonLiteralRefs = [
      ...ruleset.refConditions.include,
      ...ruleset.refConditions.exclude,
      ...ruleset.effectiveProtectedRefs
    ].filter((ref) => !isLiteralRef(ref));
    if (nonLiteralRefs.length > 0) {
      issues.push({
        path: `/rulesets/${ruleset.rulesetId}/refConditions`,
        message: `ref(s) [${nonLiteralRefs.join(", ")}] contain a wildcard or glob metacharacter; this closed contract supports only literal refs`
      });
      // A non-literal ref makes exact-set subtraction below meaningless for
      // this ruleset; skip the remaining ref-resolution checks for it so a
      // single reported cause is not compounded by derived noise.
      continue;
    }
    const computedProtectedRefs = computeEffectiveProtectedRefs(ruleset.refConditions);
    if (!stringSetsExactlyEqual(ruleset.effectiveProtectedRefs, computedProtectedRefs)) {
      issues.push({
        path: `/rulesets/${ruleset.rulesetId}/effectiveProtectedRefs`,
        message: "effectiveProtectedRefs does not equal refConditions.include minus refConditions.exclude"
      });
    }
    if (ruleset.effectiveProtectedRefs.length === 0) {
      issues.push({
        path: `/rulesets/${ruleset.rulesetId}/effectiveProtectedRefs`,
        message: "ruleset must protect at least one ref after exclusions are applied"
      });
    }
    const expectedPrefix = REF_PREFIX_BY_TARGET[ruleset.target];
    for (const ref of ruleset.effectiveProtectedRefs) {
      if (!ref.startsWith(expectedPrefix)) {
        issues.push({
          path: `/rulesets/${ruleset.rulesetId}/effectiveProtectedRefs`,
          message: `ref ${ref} does not start with ${expectedPrefix} required for target ${ruleset.target}`
        });
      }
    }
    if (
      /main/i.test(ruleset.rulesetId) &&
      ruleset.target === "branch" &&
      !ruleset.effectiveProtectedRefs.includes("refs/heads/main")
    ) {
      issues.push({
        path: `/rulesets/${ruleset.rulesetId}/effectiveProtectedRefs`,
        message: "ruleset name implies the default main branch but does not protect refs/heads/main"
      });
    }
    if (ruleset.target === "branch") {
      if (!ruleset.requiresPullRequest || !ruleset.requiresCodeownerReview || !ruleset.requiresCurrentHeadApproval) {
        issues.push({
          path: `/rulesets/${ruleset.rulesetId}`,
          message: "branch ruleset must require pull request, CODEOWNERS review, and current-head approval"
        });
      }
    } else {
      if (!ruleset.restrictsTagCreation || !ruleset.restrictsTagUpdate || !ruleset.restrictsTagDeletion) {
        issues.push({
          path: `/rulesets/${ruleset.rulesetId}`,
          message: "tag ruleset must restrict tag creation, update, and deletion"
        });
      }
    }
  }
  for (const environment of plan.environments) {
    if (!environment.requiresReviewers) {
      issues.push({
        path: `/environments/${environment.environmentId}/requiresReviewers`,
        message: "environment must require reviewers"
      });
    }
    if (!environment.hasProtectionRules) {
      issues.push({
        path: `/environments/${environment.environmentId}/hasProtectionRules`,
        message: "environment must have protection rules"
      });
    }
  }
  if (plan.actionsPolicy.allowedActions !== "local_only" && plan.actionsPolicy.allowedActions !== "selected") {
    issues.push({
      path: "/actionsPolicy/allowedActions",
      message: "allowed actions must be local_only or selected, never all"
    });
  }
  if (plan.actionsPolicy.defaultWorkflowPermissions !== "read") {
    issues.push({
      path: "/actionsPolicy/defaultWorkflowPermissions",
      message: "default workflow permissions must be read"
    });
  }
  if (plan.actionsPolicy.canApprovePullRequestReviews) {
    issues.push({
      path: "/actionsPolicy/canApprovePullRequestReviews",
      message: "Actions workflows must not be able to approve pull request reviews"
    });
  }
  if (!plan.actionsPolicy.shaPinningRequired) {
    issues.push({
      path: "/actionsPolicy/shaPinningRequired",
      message: "SHA pinning must be required"
    });
  }
  if (!plan.actionsPolicy.requireApprovalForForkPullRequests) {
    issues.push({
      path: "/actionsPolicy/requireApprovalForForkPullRequests",
      message: "fork pull requests must require approval before running"
    });
  }
  const requiredTrueGhasFields: readonly (keyof GhasSettingsPlan)[] = [
    "advancedSecurity",
    "dependabotAlerts",
    "dependabotSecurityUpdates",
    "secretScanning",
    "secretScanningPushProtection",
    "secretScanningValidityChecks",
    "secretScanningNonProviderPatterns",
    "codeScanningDefaultSetup"
  ];
  for (const field of requiredTrueGhasFields) {
    if (!plan.ghas[field]) {
      issues.push({ path: `/ghas/${field}`, message: `${field} must be enabled` });
    }
  }
  const requiredFalseGhasFields: readonly (keyof GhasSettingsPlan)[] = [
    "delegatedAlertDismissal",
    "delegatedBypass"
  ];
  for (const field of requiredFalseGhasFields) {
    if (plan.ghas[field]) {
      issues.push({ path: `/ghas/${field}`, message: `${field} must be disabled` });
    }
  }
  return issues;
}

/**
 * `driftFound` on an `AdministratorReadback` is a caller-supplied coherence
 * assertion only; it is never read by `compareAdministratorReadback` and can
 * never suppress or override an actual comparator finding. Use this helper
 * separately, after `compareAdministratorReadback`, to additionally check
 * that a readback's own `driftFound` claim agrees with the comparator's
 * actual result — for example when validating a generated or stored
 * readback fixture whose author asserted a drift outcome.
 */
export function checkReadbackDriftCoherence(
  readback: AdministratorReadback,
  comparatorIssues: readonly AdministratorPlanIssue[]
): readonly AdministratorPlanIssue[] {
  const driftFound = comparatorIssues.length > 0;
  if (readback.driftFound !== driftFound) {
    return [
      {
        path: "/driftFound",
        message: `readback.driftFound (${String(readback.driftFound)}) is incoherent with the ${comparatorIssues.length} comparator issue(s) actually found`
      }
    ];
  }
  return [];
}

function repositoryIdentityMatches(
  left: GitHubRepositoryIdentity,
  right: GitHubRepositoryIdentity
): boolean {
  return (
    left.id === right.id &&
    left.nodeId === right.nodeId &&
    left.owner === right.owner &&
    left.name === right.name &&
    left.fullName === right.fullName
  );
}

/**
 * Compares an authenticated administrator readback against the plan and
 * reports every drift instead of inferring administrator intent. A repository
 * relying entirely on organization-owned rulesets with no classic branch
 * protection is expected and is not itself drift; the comparator instead
 * verifies that every planned ruleset is present, active, and bypass-free.
 *
 * `validateAdministratorPlan(plan)` is checked first and its issues returned
 * immediately on failure, mirroring `compareGitHubAppPermissionReadback`'s
 * ordering: without this, an already-invalid plan (for example one loaded
 * from storage that never passed through `planAdministratorConfiguration`,
 * such as a plan missing required checks, a disabled GHAS setting, or a
 * main-named ruleset that protects the wrong ref) would be treated as
 * ground truth, and a readback that merely matches that already-broken plan
 * would report zero drift.
 *
 * Only once the plan itself is valid are the readback's `planDigest`,
 * `repository` immutable identity, and `observedAt` freshness checked, each
 * stopping the comparison immediately on failure: without these checks, a
 * readback captured for a different repository, a stale/future plan
 * revision, or a stale observation could otherwise be silently accepted as
 * current evidence for the plan passed in by the caller. No clock is read
 * internally; `freshness.now` is caller-supplied.
 *
 * The readback's rulesets, environments, required checks, and incident
 * contacts are then checked for a duplicated key (`rulesetId`,
 * `environmentId`, `checkName`, or contact `role`) before any lookup Map is
 * built from them: a naive `Map` construction would otherwise silently keep
 * only the last entry for a repeated key, discarding a conflicting
 * duplicate observation rather than failing closed on it.
 *
 * The readback is presented as complete administrator state, so this
 * comparator requires exact governed-set coverage for rulesets,
 * environments, and required checks: an observed `rulesetId`,
 * `environmentId`, or `checkName` absent from the plan is reported as drift
 * even when every planned entry is otherwise satisfied. Without this, an
 * unplanned extra ruleset — including one that carries a bypass actor the
 * threat model requires to fail closed — or an unplanned extra environment
 * with no reviewers or protection rules could be silently ignored simply
 * because the comparator only walked the planned side. This contract does
 * not (yet) distinguish an inherited, informational, out-of-scope ruleset
 * or environment from a governed one; every observed entry must correspond
 * to a planned one.
 *
 * For each matched ruleset, the branch-only (`requiresPullRequest`,
 * `requiresCodeownerReview`, `requiresCurrentHeadApproval`) or tag-only
 * (`restrictsTagCreation`, `restrictsTagUpdate`, `restrictsTagDeletion`)
 * controls are compared according to the ruleset's own discriminated
 * `target`, since GitHub exposes only one control set per target and the
 * other is not merely absent but meaningless for that target.
 *
 * Finally, the readback's own `nonAuthoritative` marker is compared field
 * by field against the plan's — every document in this contract family
 * carries an explicit non-authoritative claim, and a readback that quietly
 * reports `false` for one of these fields is drift like any other.
 *
 * This function's returned array is the sole compliance result. The
 * readback's own `driftFound` field is never read here — see
 * `checkReadbackDriftCoherence` for that separate, non-overriding check.
 */
export function compareAdministratorReadback(
  plan: AdministratorPlan,
  readback: AdministratorReadback,
  freshness: FreshnessWindow
): readonly AdministratorPlanIssue[] {
  const planIssues = validateAdministratorPlan(plan);
  if (planIssues.length > 0) {
    return planIssues;
  }

  const issues: AdministratorPlanIssue[] = [];

  if (readback.planDigest !== digest(plan)) {
    issues.push({
      path: "/planDigest",
      message: "readback planDigest does not match a canonical digest of the supplied plan"
    });
    return issues;
  }
  if (!repositoryIdentityMatches(readback.repository, plan.repository)) {
    issues.push({
      path: "/repository",
      message: "observed repository identity does not match the planned repository identity"
    });
    return issues;
  }
  const freshnessIssues = checkObservationFreshness("/observedAt", readback.observedAt, freshness);
  if (freshnessIssues.length > 0) {
    return freshnessIssues;
  }

  // Reject a readback that observes the same rulesetId, environmentId,
  // checkName, or incident-contact role more than once before any
  // comparison proceeds. Indexing such a collection directly into a `Map`
  // (as every lookup below does) would silently keep only the last entry
  // for a repeated key, discarding a conflicting duplicate observation
  // instead of failing closed on it.
  const duplicateKeyIssues: AdministratorPlanIssue[] = [
    ...findDuplicateKeys(readback.rulesets, (ruleset) => ruleset.rulesetId).map((rulesetId) => ({
      path: "/rulesets",
      message: `observed duplicate rulesetId ${rulesetId}`
    })),
    ...findDuplicateKeys(readback.environments, (environment) => environment.environmentId).map(
      (environmentId) => ({
        path: "/environments",
        message: `observed duplicate environmentId ${environmentId}`
      })
    ),
    ...findDuplicateKeys(readback.requiredChecks, (check) => check.checkName).map((checkName) => ({
      path: "/requiredChecks",
      message: `observed duplicate checkName ${checkName}`
    })),
    ...findDuplicateKeys(readback.incidentContacts, (contact) => contact.role).map((role) => ({
      path: "/incidentContacts",
      message: `observed duplicate incident contact role ${role}`
    }))
  ];
  if (duplicateKeyIssues.length > 0) {
    return duplicateKeyIssues;
  }

  const observedRulesetsById = new Map(
    readback.rulesets.map((ruleset) => [ruleset.rulesetId, ruleset])
  );
  const plannedRulesetIds = new Set(plan.rulesets.map((ruleset) => ruleset.rulesetId));
  for (const observedId of observedRulesetsById.keys()) {
    if (!plannedRulesetIds.has(observedId)) {
      issues.push({
        path: `/rulesets/${observedId}`,
        message: "observed ruleset is not present in the governed plan; an unplanned ruleset (including one carrying a bypass actor) is never evaluated by omission alone"
      });
    }
  }
  for (const planned of plan.rulesets) {
    const observed = observedRulesetsById.get(planned.rulesetId);
    if (observed === undefined) {
      issues.push({ path: `/rulesets/${planned.rulesetId}`, message: "planned ruleset was not observed" });
      continue;
    }
    if (observed.source !== planned.source) {
      issues.push({
        path: `/rulesets/${planned.rulesetId}/source`,
        message: `observed source ${observed.source} does not match planned source ${planned.source}`
      });
    }
    if (observed.target !== planned.target) {
      issues.push({
        path: `/rulesets/${planned.rulesetId}/target`,
        message: `observed target ${observed.target} does not match planned target ${planned.target}`
      });
    }
    if (
      !stringSetsExactlyEqual(observed.refConditions.include, planned.refConditions.include) ||
      !stringSetsExactlyEqual(observed.refConditions.exclude, planned.refConditions.exclude)
    ) {
      issues.push({
        path: `/rulesets/${planned.rulesetId}/refConditions`,
        message: "observed ref conditions do not match planned ref conditions"
      });
    }
    if (!stringSetsExactlyEqual(observed.effectiveProtectedRefs, planned.effectiveProtectedRefs)) {
      issues.push({
        path: `/rulesets/${planned.rulesetId}/effectiveProtectedRefs`,
        message: `observed protected refs [${observed.effectiveProtectedRefs.join(", ")}] do not match planned protected refs [${planned.effectiveProtectedRefs.join(", ")}]`
      });
    }
    if (observed.enforcement !== "active") {
      issues.push({
        path: `/rulesets/${planned.rulesetId}/enforcement`,
        message: `observed enforcement ${observed.enforcement} is not active`
      });
    }
    if (observed.bypassActors.length > 0) {
      issues.push({
        path: `/rulesets/${planned.rulesetId}/bypassActors`,
        message: "observed ruleset declares a bypass actor"
      });
    }
    if (planned.target === "branch") {
      if (observed.target === "branch") {
        if (
          !observed.requiresPullRequest ||
          !observed.requiresCodeownerReview ||
          !observed.requiresCurrentHeadApproval
        ) {
          issues.push({
            path: `/rulesets/${planned.rulesetId}`,
            message: "observed branch ruleset does not require pull request, CODEOWNERS review, and current-head approval"
          });
        }
      }
      // A target mismatch (observed.target !== "branch") was already
      // reported above; branch-specific controls cannot be meaningfully
      // compared against a differently-targeted observation.
    } else {
      if (observed.target === "tag") {
        if (!observed.restrictsTagCreation || !observed.restrictsTagUpdate || !observed.restrictsTagDeletion) {
          issues.push({
            path: `/rulesets/${planned.rulesetId}`,
            message: "observed tag ruleset does not restrict tag creation, update, and deletion"
          });
        }
      }
    }
  }

  const observedEnvironmentsById = new Map(
    readback.environments.map((environment) => [environment.environmentId, environment])
  );
  const plannedEnvironmentIds = new Set(plan.environments.map((environment) => environment.environmentId));
  for (const observedId of observedEnvironmentsById.keys()) {
    if (!plannedEnvironmentIds.has(observedId)) {
      issues.push({
        path: `/environments/${observedId}`,
        message: "observed environment is not present in the governed plan"
      });
    }
  }
  for (const planned of plan.environments) {
    const observed = observedEnvironmentsById.get(planned.environmentId);
    if (observed === undefined) {
      issues.push({
        path: `/environments/${planned.environmentId}`,
        message: "planned environment was not observed"
      });
      continue;
    }
    if (!observed.hasProtectionRules) {
      issues.push({
        path: `/environments/${planned.environmentId}/hasProtectionRules`,
        message: "observed environment has no protection rules"
      });
    }
    if (!observed.requiresReviewers) {
      issues.push({
        path: `/environments/${planned.environmentId}/requiresReviewers`,
        message: "observed environment does not require reviewers"
      });
    }
  }

  const observedChecksByName = new Map(
    readback.requiredChecks.map((check) => [check.checkName, check])
  );
  const plannedCheckNames = new Set<string>(plan.requiredChecks.map((check) => check.checkName));
  for (const observedName of observedChecksByName.keys()) {
    if (!plannedCheckNames.has(observedName)) {
      issues.push({
        path: `/requiredChecks/${observedName}`,
        message: "observed required check is not present in the governed plan"
      });
    }
  }
  for (const planned of plan.requiredChecks) {
    const observed = observedChecksByName.get(planned.checkName);
    if (observed === undefined || !observed.required) {
      issues.push({
        path: `/requiredChecks/${planned.checkName}`,
        message: "planned required check was not observed as required"
      });
    }
  }

  if (readback.actionsPolicy.allowedActions !== plan.actionsPolicy.allowedActions) {
    issues.push({
      path: "/actionsPolicy/allowedActions",
      message: `observed ${readback.actionsPolicy.allowedActions} does not match planned ${plan.actionsPolicy.allowedActions}`
    });
  }
  if (readback.actionsPolicy.defaultWorkflowPermissions !== plan.actionsPolicy.defaultWorkflowPermissions) {
    issues.push({
      path: "/actionsPolicy/defaultWorkflowPermissions",
      message: `observed ${readback.actionsPolicy.defaultWorkflowPermissions} does not match planned ${plan.actionsPolicy.defaultWorkflowPermissions}`
    });
  }
  if (readback.actionsPolicy.canApprovePullRequestReviews !== plan.actionsPolicy.canApprovePullRequestReviews) {
    issues.push({
      path: "/actionsPolicy/canApprovePullRequestReviews",
      message: "observed pull-request review approval permission does not match plan"
    });
  }
  if (readback.actionsPolicy.shaPinningRequired !== plan.actionsPolicy.shaPinningRequired) {
    issues.push({
      path: "/actionsPolicy/shaPinningRequired",
      message: "observed SHA pinning requirement does not match plan"
    });
  }
  if (
    readback.actionsPolicy.requireApprovalForForkPullRequests !==
    plan.actionsPolicy.requireApprovalForForkPullRequests
  ) {
    issues.push({
      path: "/actionsPolicy/requireApprovalForForkPullRequests",
      message: "observed fork pull-request approval requirement does not match plan"
    });
  }

  for (const [key, plannedValue] of Object.entries(plan.ghas) as [
    keyof GhasSettingsPlan,
    boolean
  ][]) {
    if (readback.ghas[key] !== plannedValue) {
      issues.push({
        path: `/ghas/${key}`,
        message: `observed value ${String(readback.ghas[key])} does not match planned value ${String(plannedValue)}`
      });
    }
  }

  if (readback.projectBinding.projectNumber !== plan.projectBinding.projectNumber) {
    issues.push({ path: "/projectBinding/projectNumber", message: "observed Project number does not match plan" });
  }
  if (readback.projectBinding.ownerLogin !== plan.projectBinding.ownerLogin) {
    issues.push({ path: "/projectBinding/ownerLogin", message: "observed Project owner does not match plan" });
  }
  if (readback.projectBinding.schemaDigest !== plan.projectBinding.schemaDigest) {
    issues.push({ path: "/projectBinding/schemaDigest", message: "observed Project schema digest does not match plan" });
  }
  if (
    readback.projectBinding.mutationRequiresExplicitConfirmation !==
    plan.projectBinding.mutationRequiresExplicitConfirmation
  ) {
    issues.push({
      path: "/projectBinding/mutationRequiresExplicitConfirmation",
      message: "observed Project mutation-confirmation requirement does not match plan"
    });
  }

  const plannedContactKeys = new Set(
    plan.incidentContacts.map((contact) => `${contact.role}:${contact.contactHandle}`)
  );
  const observedContactKeys = new Set(
    readback.incidentContacts.map((contact) => `${contact.role}:${contact.contactHandle}`)
  );
  for (const key of plannedContactKeys) {
    if (!observedContactKeys.has(key)) {
      issues.push({ path: "/incidentContacts", message: `planned incident contact ${key} was not observed` });
    }
  }
  for (const key of observedContactKeys) {
    if (!plannedContactKeys.has(key)) {
      issues.push({ path: "/incidentContacts", message: `observed incident contact ${key} is not in the plan` });
    }
  }

  for (const [key, requiredValue] of Object.entries(plan.nonAuthoritative) as [
    keyof AdministratorNonAuthoritativePlanMarker,
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
