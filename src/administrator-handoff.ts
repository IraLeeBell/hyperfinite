import { canonicalJson, digest } from "./canonical.js";
import { findDuplicateKeys } from "./duplicate-keys.js";
import {
  checkNotExpired,
  checkObservationFreshness,
  type FreshnessWindow
} from "./freshness.js";
import type { GitHubRepositoryIdentity } from "./github-events.js";
import { validateDocument } from "./validation.js";

export const ADMINISTRATOR_HANDOFF_AUTHORITY_ORDER = Object.freeze([
  "lifecycle-graph",
  "work-accord-and-phase-contracts",
  "policy-compiler-and-capability-registry",
  "control-kernel",
  "trusted-adapter",
  "single-writer",
  "model-output-untrusted-advisory"
] as const);

export type AdministratorHandoffControlId =
  | "app-registration"
  | "app-ownership-transfer"
  | "app-installation"
  | "app-permissions-and-events"
  | "webhook-and-oidc-identity"
  | "key-custody-and-rotation"
  | "four-store-topology"
  | "backup-restore-and-disabled-recovery"
  | "credential-broker"
  | "single-writer"
  | "isolated-runner"
  | "project-binding-and-projection"
  | "main-ruleset-and-required-checks"
  | "actions-policy"
  | "ghas-and-codeql"
  | "protected-environment"
  | "monitoring-health-and-alert-routing"
  | "logs-artifacts-and-data-retention"
  | "provider-billing-budgets-and-usage"
  | "kill-switch-and-revocation"
  | "recovery-drills"
  | "incident-response"
  | "customer-transfer"
  | "open-source-preflight"
  | "final-human-login-and-readback"
  | "app-backed-sandbox-canary"
  | "production-readiness";

export type AdministratorBindingKind =
  | "owner"
  | "repository"
  | "source-owner"
  | "project"
  | "environment"
  | "ruleset"
  | "app"
  | "installation"
  | "billing-account";

export type AdministratorActionClass =
  | "human-administrative-apply"
  | "human-decision"
  | "readback-only"
  | "drill";

export const ADMINISTRATOR_PROHIBITED_EFFECTS = Object.freeze([
  "automatic-approval",
  "automatic-mark-ready",
  "automatic-merge",
  "automatic-issue-close",
  "automatic-project-transition",
  "automatic-deployment",
  "automatic-publication",
  "automatic-license-decision",
  "automatic-visibility-change",
  "pat-fallback",
  "model-job-credential-fallback",
  "blind-retry-after-ambiguous-acknowledgement"
] as const);

export type AdministratorProhibitedEffect =
  (typeof ADMINISTRATOR_PROHIBITED_EFFECTS)[number];

export type AdministratorResponsibleOwner =
  | "organization-administrator"
  | "repository-administrator"
  | "project-administrator"
  | "security-owner"
  | "platform-owner"
  | "billing-owner"
  | "incident-commander"
  | "legal-ospo-owner"
  | "customer-owner";

export type AdministratorTargetSource =
  | "authenticated-owner-repository-read"
  | "authenticated-app-registration-read"
  | "authenticated-installation-read"
  | "authenticated-project-export"
  | "authenticated-repository-administration-read"
  | "protected-deployment-inventory"
  | "protected-billing-read"
  | "protected-operations-evidence"
  | "authorized-human-decision";

export type AdministratorReadbackProcedure =
  | "exact-authenticated-api-readback"
  | "signed-service-health-and-store-readback"
  | "disabled-drill-evidence-readback"
  | "exact-head-security-readback"
  | "human-decision-record-readback"
  | "live-canary-current-head-readback";

export type AdministratorRollbackMode =
  | "new-confirmed-reversal-plan"
  | "disable-writer-and-reconcile"
  | "restore-only-into-disabled-services"
  | "human-decision-no-automatic-rollback"
  | "not-applicable-readback-only";

export type AdministratorStateValueKind = "boolean" | "integer" | "string";

export interface AdministratorStateRequirement {
  readonly key: AdministratorStateKey;
  readonly valueType: AdministratorStateValueKind;
  readonly requiredDesiredValue?: string | number | boolean;
}

export interface AdministratorHandoffControl {
  readonly controlId: AdministratorHandoffControlId;
  readonly sequence: number;
  readonly actionClass: AdministratorActionClass;
  readonly requiredBindings: readonly AdministratorBindingKind[];
  readonly prerequisites: readonly AdministratorHandoffControlId[];
  readonly applyPlanRequired: boolean;
  readonly responsibleOwner: AdministratorResponsibleOwner;
  readonly targetSource: AdministratorTargetSource;
  readonly readbackProcedure: AdministratorReadbackProcedure;
  readonly rollbackMode: AdministratorRollbackMode;
  readonly stateRequirements: readonly AdministratorStateRequirement[];
  readonly prohibitedEffects: typeof ADMINISTRATOR_PROHIBITED_EFFECTS;
}

const CONTROL_SEED: readonly Pick<
  AdministratorHandoffControl,
  | "controlId"
  | "actionClass"
  | "requiredBindings"
  | "prerequisites"
  | "applyPlanRequired"
>[] = [
  {
    controlId: "app-registration",
    actionClass: "human-administrative-apply",
    requiredBindings: ["owner", "repository"],
    prerequisites: [],
    applyPlanRequired: true
  },
  {
    controlId: "app-ownership-transfer",
    actionClass: "human-administrative-apply",
    requiredBindings: ["source-owner", "owner", "repository", "app"],
    prerequisites: ["app-registration"],
    applyPlanRequired: true
  },
  {
    controlId: "app-installation",
    actionClass: "human-administrative-apply",
    requiredBindings: ["owner", "repository", "app"],
    prerequisites: ["app-ownership-transfer"],
    applyPlanRequired: true
  },
  {
    controlId: "project-binding-and-projection",
    actionClass: "human-administrative-apply",
    requiredBindings: ["owner", "repository", "project"],
    prerequisites: [],
    applyPlanRequired: true
  },
  {
    controlId: "app-permissions-and-events",
    actionClass: "human-administrative-apply",
    requiredBindings: ["owner", "repository", "app", "installation"],
    prerequisites: ["app-installation"],
    applyPlanRequired: true
  },
  {
    controlId: "webhook-and-oidc-identity",
    actionClass: "human-administrative-apply",
    requiredBindings: ["owner", "repository", "app", "installation"],
    prerequisites: ["app-permissions-and-events"],
    applyPlanRequired: true
  },
  {
    controlId: "key-custody-and-rotation",
    actionClass: "human-administrative-apply",
    requiredBindings: ["owner", "repository", "app"],
    prerequisites: ["webhook-and-oidc-identity"],
    applyPlanRequired: true
  },
  {
    controlId: "four-store-topology",
    actionClass: "human-administrative-apply",
    requiredBindings: ["owner", "repository"],
    prerequisites: [],
    applyPlanRequired: true
  },
  {
    controlId: "backup-restore-and-disabled-recovery",
    actionClass: "drill",
    requiredBindings: ["owner", "repository"],
    prerequisites: ["four-store-topology"],
    applyPlanRequired: true
  },
  {
    controlId: "credential-broker",
    actionClass: "human-administrative-apply",
    requiredBindings: ["owner", "repository", "app", "installation"],
    prerequisites: ["key-custody-and-rotation", "four-store-topology"],
    applyPlanRequired: true
  },
  {
    controlId: "single-writer",
    actionClass: "human-administrative-apply",
    requiredBindings: ["owner", "repository", "app", "installation"],
    prerequisites: ["credential-broker", "four-store-topology"],
    applyPlanRequired: true
  },
  {
    controlId: "isolated-runner",
    actionClass: "human-administrative-apply",
    requiredBindings: ["owner", "repository"],
    prerequisites: ["webhook-and-oidc-identity"],
    applyPlanRequired: true
  },
  {
    controlId: "main-ruleset-and-required-checks",
    actionClass: "human-administrative-apply",
    requiredBindings: ["owner", "repository", "ruleset"],
    prerequisites: [],
    applyPlanRequired: true
  },
  {
    controlId: "actions-policy",
    actionClass: "human-administrative-apply",
    requiredBindings: ["owner", "repository"],
    prerequisites: [],
    applyPlanRequired: true
  },
  {
    controlId: "ghas-and-codeql",
    actionClass: "human-administrative-apply",
    requiredBindings: ["owner", "repository"],
    prerequisites: ["main-ruleset-and-required-checks"],
    applyPlanRequired: true
  },
  {
    controlId: "protected-environment",
    actionClass: "human-administrative-apply",
    requiredBindings: ["owner", "repository", "environment"],
    prerequisites: ["actions-policy"],
    applyPlanRequired: true
  },
  {
    controlId: "monitoring-health-and-alert-routing",
    actionClass: "human-administrative-apply",
    requiredBindings: ["owner", "repository"],
    prerequisites: ["four-store-topology", "single-writer"],
    applyPlanRequired: true
  },
  {
    controlId: "logs-artifacts-and-data-retention",
    actionClass: "human-administrative-apply",
    requiredBindings: ["owner", "repository"],
    prerequisites: ["monitoring-health-and-alert-routing"],
    applyPlanRequired: true
  },
  {
    controlId: "provider-billing-budgets-and-usage",
    actionClass: "human-administrative-apply",
    requiredBindings: ["owner", "repository", "billing-account"],
    prerequisites: ["credential-broker", "isolated-runner"],
    applyPlanRequired: true
  },
  {
    controlId: "kill-switch-and-revocation",
    actionClass: "drill",
    requiredBindings: ["owner", "repository", "app", "installation"],
    prerequisites: ["single-writer", "provider-billing-budgets-and-usage"],
    applyPlanRequired: true
  },
  {
    controlId: "recovery-drills",
    actionClass: "drill",
    requiredBindings: ["owner", "repository"],
    prerequisites: [
      "backup-restore-and-disabled-recovery",
      "kill-switch-and-revocation"
    ],
    applyPlanRequired: true
  },
  {
    controlId: "incident-response",
    actionClass: "human-decision",
    requiredBindings: ["owner", "repository"],
    prerequisites: ["monitoring-health-and-alert-routing", "recovery-drills"],
    applyPlanRequired: false
  },
  {
    controlId: "customer-transfer",
    actionClass: "human-decision",
    requiredBindings: ["owner", "repository"],
    prerequisites: ["incident-response"],
    applyPlanRequired: false
  },
  {
    controlId: "open-source-preflight",
    actionClass: "human-decision",
    requiredBindings: ["owner", "repository"],
    prerequisites: [],
    applyPlanRequired: false
  },
  {
    controlId: "final-human-login-and-readback",
    actionClass: "readback-only",
    requiredBindings: [
      "owner",
      "repository",
      "project",
      "environment",
      "ruleset",
      "app",
      "installation",
      "billing-account"
    ],
    prerequisites: [
      "project-binding-and-projection",
      "app-permissions-and-events",
      "protected-environment",
      "ghas-and-codeql",
      "logs-artifacts-and-data-retention",
      "provider-billing-budgets-and-usage",
      "incident-response"
    ],
    applyPlanRequired: false
  },
  {
    controlId: "app-backed-sandbox-canary",
    actionClass: "drill",
    requiredBindings: [
      "owner",
      "repository",
      "project",
      "environment",
      "ruleset",
      "app",
      "installation",
      "billing-account"
    ],
    prerequisites: ["final-human-login-and-readback"],
    applyPlanRequired: false
  },
  {
    controlId: "production-readiness",
    actionClass: "human-decision",
    requiredBindings: [
      "owner",
      "repository",
      "project",
      "environment",
      "ruleset",
      "app",
      "installation",
      "billing-account"
    ],
    prerequisites: ["app-backed-sandbox-canary", "customer-transfer"],
    applyPlanRequired: false
  }
];

interface AdministratorControlMetadata {
  readonly responsibleOwner: AdministratorResponsibleOwner;
  readonly targetSource: AdministratorTargetSource;
  readonly readbackProcedure: AdministratorReadbackProcedure;
  readonly rollbackMode: AdministratorRollbackMode;
  readonly stateRequirements: readonly AdministratorStateRequirement[];
}

const booleanState = (
  key: AdministratorStateKey,
  requiredDesiredValue = true
): AdministratorStateRequirement => ({
  key,
  valueType: "boolean",
  requiredDesiredValue
});

const CONTROL_METADATA_BY_ID: Readonly<
  Record<AdministratorHandoffControlId, AdministratorControlMetadata>
> = {
  "app-registration": {
    responsibleOwner: "organization-administrator",
    targetSource: "authenticated-owner-repository-read",
    readbackProcedure: "exact-authenticated-api-readback",
    rollbackMode: "new-confirmed-reversal-plan",
    stateRequirements: [booleanState("app.registration")]
  },
  "app-ownership-transfer": {
    responsibleOwner: "organization-administrator",
    targetSource: "authenticated-app-registration-read",
    readbackProcedure: "exact-authenticated-api-readback",
    rollbackMode: "new-confirmed-reversal-plan",
    stateRequirements: [booleanState("app.owner")]
  },
  "app-installation": {
    responsibleOwner: "organization-administrator",
    targetSource: "authenticated-app-registration-read",
    readbackProcedure: "exact-authenticated-api-readback",
    rollbackMode: "new-confirmed-reversal-plan",
    stateRequirements: [booleanState("app.installation")]
  },
  "app-permissions-and-events": {
    responsibleOwner: "organization-administrator",
    targetSource: "authenticated-installation-read",
    readbackProcedure: "exact-authenticated-api-readback",
    rollbackMode: "new-confirmed-reversal-plan",
    stateRequirements: [
      booleanState("app.events"),
      booleanState("app.permissions")
    ]
  },
  "webhook-and-oidc-identity": {
    responsibleOwner: "security-owner",
    targetSource: "protected-deployment-inventory",
    readbackProcedure: "signed-service-health-and-store-readback",
    rollbackMode: "disable-writer-and-reconcile",
    stateRequirements: [
      booleanState("identity.oidc"),
      booleanState("identity.webhook")
    ]
  },
  "key-custody-and-rotation": {
    responsibleOwner: "security-owner",
    targetSource: "protected-deployment-inventory",
    readbackProcedure: "signed-service-health-and-store-readback",
    rollbackMode: "disable-writer-and-reconcile",
    stateRequirements: [
      booleanState("keys.custody"),
      booleanState("keys.rotation")
    ]
  },
  "four-store-topology": {
    responsibleOwner: "platform-owner",
    targetSource: "protected-deployment-inventory",
    readbackProcedure: "signed-service-health-and-store-readback",
    rollbackMode: "restore-only-into-disabled-services",
    stateRequirements: [booleanState("stores.topology")]
  },
  "backup-restore-and-disabled-recovery": {
    responsibleOwner: "platform-owner",
    targetSource: "protected-operations-evidence",
    readbackProcedure: "disabled-drill-evidence-readback",
    rollbackMode: "restore-only-into-disabled-services",
    stateRequirements: [
      booleanState("stores.backup"),
      booleanState("stores.disabledRecovery"),
      booleanState("stores.restore")
    ]
  },
  "credential-broker": {
    responsibleOwner: "security-owner",
    targetSource: "protected-deployment-inventory",
    readbackProcedure: "signed-service-health-and-store-readback",
    rollbackMode: "disable-writer-and-reconcile",
    stateRequirements: [booleanState("services.credentialBroker")]
  },
  "single-writer": {
    responsibleOwner: "platform-owner",
    targetSource: "protected-deployment-inventory",
    readbackProcedure: "signed-service-health-and-store-readback",
    rollbackMode: "disable-writer-and-reconcile",
    stateRequirements: [booleanState("services.singleWriter")]
  },
  "isolated-runner": {
    responsibleOwner: "platform-owner",
    targetSource: "protected-deployment-inventory",
    readbackProcedure: "signed-service-health-and-store-readback",
    rollbackMode: "disable-writer-and-reconcile",
    stateRequirements: [booleanState("runner.isolation")]
  },
  "project-binding-and-projection": {
    responsibleOwner: "project-administrator",
    targetSource: "authenticated-project-export",
    readbackProcedure: "exact-authenticated-api-readback",
    rollbackMode: "new-confirmed-reversal-plan",
    stateRequirements: [
      booleanState("project.binding"),
      booleanState("project.projection")
    ]
  },
  "main-ruleset-and-required-checks": {
    responsibleOwner: "repository-administrator",
    targetSource: "authenticated-repository-administration-read",
    readbackProcedure: "exact-head-security-readback",
    rollbackMode: "new-confirmed-reversal-plan",
    stateRequirements: [
      {
        key: "checks.required",
        valueType: "integer",
        requiredDesiredValue: 12
      },
      booleanState("ruleset.main")
    ]
  },
  "actions-policy": {
    responsibleOwner: "repository-administrator",
    targetSource: "authenticated-repository-administration-read",
    readbackProcedure: "exact-authenticated-api-readback",
    rollbackMode: "new-confirmed-reversal-plan",
    stateRequirements: [
      booleanState("actions.allowlist"),
      booleanState("actions.reviewPermission", false),
      booleanState("actions.shaPinning")
    ]
  },
  "ghas-and-codeql": {
    responsibleOwner: "security-owner",
    targetSource: "authenticated-repository-administration-read",
    readbackProcedure: "exact-head-security-readback",
    rollbackMode: "new-confirmed-reversal-plan",
    stateRequirements: [
      booleanState("security.codeql"),
      booleanState("security.dependencyReview"),
      booleanState("security.ghas"),
      booleanState("security.secretScanning")
    ]
  },
  "protected-environment": {
    responsibleOwner: "repository-administrator",
    targetSource: "authenticated-repository-administration-read",
    readbackProcedure: "exact-authenticated-api-readback",
    rollbackMode: "new-confirmed-reversal-plan",
    stateRequirements: [booleanState("environment.protection")]
  },
  "monitoring-health-and-alert-routing": {
    responsibleOwner: "platform-owner",
    targetSource: "protected-operations-evidence",
    readbackProcedure: "signed-service-health-and-store-readback",
    rollbackMode: "disable-writer-and-reconcile",
    stateRequirements: [
      booleanState("monitoring.alertRouting"),
      booleanState("monitoring.health")
    ]
  },
  "logs-artifacts-and-data-retention": {
    responsibleOwner: "security-owner",
    targetSource: "protected-operations-evidence",
    readbackProcedure: "exact-authenticated-api-readback",
    rollbackMode: "new-confirmed-reversal-plan",
    stateRequirements: [
      { key: "retention.artifacts", valueType: "integer" },
      { key: "retention.data", valueType: "integer" },
      { key: "retention.logs", valueType: "integer" }
    ]
  },
  "provider-billing-budgets-and-usage": {
    responsibleOwner: "billing-owner",
    targetSource: "protected-billing-read",
    readbackProcedure: "exact-authenticated-api-readback",
    rollbackMode: "disable-writer-and-reconcile",
    stateRequirements: [
      booleanState("billing.enabled"),
      booleanState("budgets.enforced"),
      booleanState("provider.enabled"),
      booleanState("usage.reconciliation")
    ]
  },
  "kill-switch-and-revocation": {
    responsibleOwner: "incident-commander",
    targetSource: "protected-operations-evidence",
    readbackProcedure: "disabled-drill-evidence-readback",
    rollbackMode: "disable-writer-and-reconcile",
    stateRequirements: [
      booleanState("killSwitch.ready"),
      booleanState("revocation.ready")
    ]
  },
  "recovery-drills": {
    responsibleOwner: "incident-commander",
    targetSource: "protected-operations-evidence",
    readbackProcedure: "disabled-drill-evidence-readback",
    rollbackMode: "restore-only-into-disabled-services",
    stateRequirements: [booleanState("recovery.drills")]
  },
  "incident-response": {
    responsibleOwner: "incident-commander",
    targetSource: "authorized-human-decision",
    readbackProcedure: "human-decision-record-readback",
    rollbackMode: "human-decision-no-automatic-rollback",
    stateRequirements: []
  },
  "customer-transfer": {
    responsibleOwner: "customer-owner",
    targetSource: "authorized-human-decision",
    readbackProcedure: "human-decision-record-readback",
    rollbackMode: "human-decision-no-automatic-rollback",
    stateRequirements: []
  },
  "open-source-preflight": {
    responsibleOwner: "legal-ospo-owner",
    targetSource: "authorized-human-decision",
    readbackProcedure: "human-decision-record-readback",
    rollbackMode: "human-decision-no-automatic-rollback",
    stateRequirements: []
  },
  "final-human-login-and-readback": {
    responsibleOwner: "organization-administrator",
    targetSource: "authenticated-repository-administration-read",
    readbackProcedure: "exact-authenticated-api-readback",
    rollbackMode: "not-applicable-readback-only",
    stateRequirements: []
  },
  "app-backed-sandbox-canary": {
    responsibleOwner: "security-owner",
    targetSource: "protected-operations-evidence",
    readbackProcedure: "live-canary-current-head-readback",
    rollbackMode: "disable-writer-and-reconcile",
    stateRequirements: []
  },
  "production-readiness": {
    responsibleOwner: "organization-administrator",
    targetSource: "authorized-human-decision",
    readbackProcedure: "human-decision-record-readback",
    rollbackMode: "human-decision-no-automatic-rollback",
    stateRequirements: []
  }
};

export const ADMINISTRATOR_HANDOFF_CONTROLS: readonly AdministratorHandoffControl[] =
  Object.freeze(
    CONTROL_SEED.map((control, index) => {
      const metadata = CONTROL_METADATA_BY_ID[control.controlId];
      return Object.freeze({
        ...control,
        requiredBindings: Object.freeze([...control.requiredBindings]),
        prerequisites: Object.freeze([...control.prerequisites]),
        sequence: index + 1,
        ...metadata,
        stateRequirements: Object.freeze(
          metadata.stateRequirements.map((requirement) =>
            Object.freeze({ ...requirement })
          )
        ),
        prohibitedEffects: ADMINISTRATOR_PROHIBITED_EFFECTS
      });
    })
  );

export const ADMINISTRATOR_APPLY_PROTOCOL = Object.freeze({
  exactTargetIdentifiersRequired: true as const,
  expectedCountsAndCurrentValuesRequired: true as const,
  closedDesiredValuesRequired: true as const,
  canonicalPlanDigestRequired: true as const,
  separateExplicitHumanConfirmationRequired: true as const,
  freshPreApplyReadbackRequired: true as const,
  maximumApplyAttempts: 1 as const,
  completePostApplyReadbackRequired: true as const,
  retryAfterAmbiguousAcknowledgement: false as const,
  trustedAdapterVerificationRequired: true as const,
  durableAttemptClaimRequired: true as const,
  attemptReceiptRequired: true as const
});

const HANDOFF_READINESS = Object.freeze({
  repository: "requires-exact-head-validation" as const,
  credentiallessSyntheticSandbox: "requires-synthetic-canary" as const,
  appBackedSandbox:
    "blocked-until-complete-administrator-readback-and-live-canary" as const,
  production: "customer-approval-required" as const,
  liveCanaryStop: "human-review" as const
});

const HANDOFF_NON_AUTHORITATIVE = Object.freeze({
  cannotApplyAdministration: true as const,
  cannotCreateTransferOrInstallApp: true as const,
  cannotCreateReadOrRotateKeys: true as const,
  cannotEnableBillingOrInference: true as const,
  cannotDeployPublishApproveMergeOrClose: true as const
});

const APPLY_PLAN_NON_AUTHORITATIVE = Object.freeze({
  planOnly: true as const,
  performsNoEffect: true as const,
  grantsNoCredentialOrAuthority: true as const
});

export interface AdministratorHandoffSourceDigests {
  readonly deploymentTopologyPlan: string;
  readonly githubAppRegistrationPlan: string;
  readonly administratorConfigurationPlan: string;
  readonly durableAdapterMapping: string;
  readonly syntheticCanaryEvidence: string;
  readonly customerStarterCoreSelection: string;
  readonly customerStarterDemoSelection: string;
  readonly openSourceReadiness: string;
  readonly licenseBytes: string;
}

const HANDOFF_SOURCE_DIGEST_KEYS = Object.freeze([
  "administratorConfigurationPlan",
  "customerStarterCoreSelection",
  "customerStarterDemoSelection",
  "deploymentTopologyPlan",
  "durableAdapterMapping",
  "githubAppRegistrationPlan",
  "licenseBytes",
  "openSourceReadiness",
  "syntheticCanaryEvidence"
] as const);

export interface AdministratorHandoffPlan {
  readonly apiVersion: "agentic-framework.github.com/v1alpha1";
  readonly kind: "AdministratorHandoffPlan";
  readonly schemaVersion: "1.0.0";
  readonly evidenceEpoch: string;
  readonly authorityOrder: typeof ADMINISTRATOR_HANDOFF_AUTHORITY_ORDER;
  readonly sourceDigests: AdministratorHandoffSourceDigests;
  readonly durableAdapterPortCount: 15;
  readonly controls: readonly AdministratorHandoffControl[];
  readonly applyProtocol: typeof ADMINISTRATOR_APPLY_PROTOCOL;
  readonly readiness: {
    readonly repository: "requires-exact-head-validation";
    readonly credentiallessSyntheticSandbox: "requires-synthetic-canary";
    readonly appBackedSandbox:
      "blocked-until-complete-administrator-readback-and-live-canary";
    readonly production: "customer-approval-required";
    readonly liveCanaryStop: "human-review";
  };
  readonly prohibitedEffects: typeof ADMINISTRATOR_PROHIBITED_EFFECTS;
  readonly nonAuthoritative: {
    readonly cannotApplyAdministration: true;
    readonly cannotCreateTransferOrInstallApp: true;
    readonly cannotCreateReadOrRotateKeys: true;
    readonly cannotEnableBillingOrInference: true;
    readonly cannotDeployPublishApproveMergeOrClose: true;
  };
}

export interface AdministratorHandoffPlanInput {
  readonly evidenceEpoch: string;
  readonly sourceDigests: AdministratorHandoffSourceDigests;
}

export interface AdministratorExactTarget {
  readonly sourceOwner: {
    readonly id: number;
    readonly nodeId: string;
    readonly login: string;
  } | null;
  readonly owner: {
    readonly id: number;
    readonly nodeId: string;
    readonly login: string;
  };
  readonly repository: GitHubRepositoryIdentity;
  readonly project: {
    readonly id: string;
    readonly number: number;
    readonly itemId: string;
    readonly fieldId: string;
  } | null;
  readonly environment: {
    readonly id: number;
    readonly nodeId: string;
    readonly name: string;
  } | null;
  readonly ruleset: {
    readonly id: number;
    readonly name: string;
    readonly target: "branch" | "tag" | "push";
  } | null;
  readonly app: {
    readonly id: number;
    readonly nodeId: string;
  } | null;
  readonly installation: {
    readonly id: number;
    readonly accountId: number;
    readonly accountNodeId: string;
  } | null;
  readonly billingAccountId: string | null;
}

export type AdministratorStateKey =
  | "app.owner"
  | "app.registration"
  | "app.installation"
  | "app.permissions"
  | "app.events"
  | "identity.webhook"
  | "identity.oidc"
  | "keys.custody"
  | "keys.rotation"
  | "stores.topology"
  | "stores.backup"
  | "stores.restore"
  | "stores.disabledRecovery"
  | "services.credentialBroker"
  | "services.singleWriter"
  | "runner.isolation"
  | "project.binding"
  | "project.projection"
  | "ruleset.main"
  | "checks.required"
  | "actions.allowlist"
  | "actions.shaPinning"
  | "actions.reviewPermission"
  | "security.ghas"
  | "security.codeql"
  | "security.dependencyReview"
  | "security.secretScanning"
  | "environment.protection"
  | "monitoring.health"
  | "monitoring.alertRouting"
  | "retention.logs"
  | "retention.artifacts"
  | "retention.data"
  | "provider.enabled"
  | "billing.enabled"
  | "budgets.enforced"
  | "usage.reconciliation"
  | "killSwitch.ready"
  | "revocation.ready"
  | "recovery.drills"
  | "incident.response"
  | "customer.transfer"
  | "openSource.decision"
  | "readback.complete"
  | "sandbox.canaryStage"
  | "production.decision";

export interface AdministratorStateEntry {
  readonly key: AdministratorStateKey;
  readonly value: string | number | boolean | null;
}

export interface AdministratorStateSet {
  readonly count: number;
  readonly values: readonly AdministratorStateEntry[];
}

export interface AdministratorApplyPlan {
  readonly apiVersion: "agentic-framework.github.com/v1alpha1";
  readonly kind: "AdministratorApplyPlan";
  readonly schemaVersion: "1.0.0";
  readonly generatedAt: string;
  readonly expiresAt: string;
  readonly operationId: AdministratorHandoffControlId;
  readonly attemptId: string;
  readonly idempotencyKey: string;
  readonly handoffPlanDigest: string;
  readonly target: AdministratorExactTarget;
  readonly expectedCurrent: AdministratorStateSet;
  readonly desired: AdministratorStateSet;
  readonly prohibitedEffects: typeof ADMINISTRATOR_PROHIBITED_EFFECTS;
  readonly protocol: AdministratorHandoffPlan["applyProtocol"];
  readonly nonAuthoritative: {
    readonly planOnly: true;
    readonly performsNoEffect: true;
    readonly grantsNoCredentialOrAuthority: true;
  };
}

export interface AdministratorApplyPlanInput {
  readonly generatedAt: string;
  readonly expiresAt: string;
  readonly operationId: AdministratorHandoffControlId;
  readonly handoffPlanDigest: string;
  readonly target: AdministratorExactTarget;
  readonly expectedCurrent: AdministratorStateSet;
  readonly desired: AdministratorStateSet;
}

export interface AdministratorApplyConfirmation {
  readonly apiVersion: "agentic-framework.github.com/v1alpha1";
  readonly kind: "AdministratorApplyConfirmation";
  readonly schemaVersion: "1.0.0";
  readonly planDigest: string;
  readonly confirmationId: string;
  readonly confirmedBy: string;
  readonly confirmedAt: string;
  readonly expiresAt: string;
  readonly separateExplicitHumanConfirmation: true;
  readonly confirmationEvidenceDigest: string;
  readonly nonAuthoritative: {
    readonly requiresTrustedAdapterVerification: true;
    readonly performsNoEffect: true;
  };
}

interface AdministratorApplyReadbackCommon {
  readonly apiVersion: "agentic-framework.github.com/v1alpha1";
  readonly kind: "AdministratorApplyReadback";
  readonly schemaVersion: "1.0.0";
  readonly observedAt: string;
  readonly planDigest: string;
  readonly confirmationDigest: string;
  readonly attemptId: string;
  readonly target: AdministratorExactTarget;
  readonly actual: AdministratorStateSet;
  readonly completeReadback: true;
  readonly nonAuthoritative: {
    readonly evidenceOnly: true;
    readonly cannotRetryOrApply: true;
  };
}

export interface AdministratorPreApplyReadback
  extends AdministratorApplyReadbackCommon {
  readonly phase: "pre-apply";
  readonly mutationAttemptCount: 0;
  readonly acknowledgement: "not-attempted";
  readonly preApplyReadbackDigest: null;
  readonly attemptedAt: null;
  readonly attemptReceiptDigest: null;
}

export interface AdministratorPostApplyReadback
  extends AdministratorApplyReadbackCommon {
  readonly phase: "post-apply";
  readonly mutationAttemptCount: 1;
  readonly acknowledgement: "unambiguous-applied" | "ambiguous";
  readonly preApplyReadbackDigest: string;
  readonly attemptedAt: string;
  readonly attemptReceiptDigest: string;
}

export type AdministratorApplyReadback =
  | AdministratorPreApplyReadback
  | AdministratorPostApplyReadback;

export type AdministratorHandoffStatus =
  | "satisfied"
  | "repository-evidence-only"
  | "blocked-human-action"
  | "unavailable";

export type AdministratorHandoffReasonCode =
  | "observed-compliant"
  | "synthetic-only"
  | "missing-identity"
  | "missing-protection"
  | "configuration-drift"
  | "human-decision-required"
  | "live-evidence-unavailable";

export interface AdministratorHandoffControlReadback {
  readonly controlId: AdministratorHandoffControlId;
  readonly status: AdministratorHandoffStatus;
  readonly reasonCode: AdministratorHandoffReasonCode;
  readonly observationDigest: string | null;
}

export interface AdministratorSatisfiedControlEvidence {
  readonly controlId: AdministratorHandoffControlId;
  readonly responsibleOwner: AdministratorResponsibleOwner;
  readonly targetSource: AdministratorTargetSource;
  readonly readbackProcedure: AdministratorReadbackProcedure;
  readonly observationDigest: string;
}

export interface AdministratorObservedTargetDigests {
  readonly sourceOwner: string | null;
  readonly owner: string;
  readonly repository: string;
  readonly project: string | null;
  readonly environment: string | null;
  readonly ruleset: string | null;
  readonly app: string | null;
  readonly installation: string | null;
  readonly billingAccount: string | null;
}

export interface AdministratorHandoffReadback {
  readonly apiVersion: "agentic-framework.github.com/v1alpha1";
  readonly kind: "AdministratorHandoffReadback";
  readonly schemaVersion: "1.0.0";
  readonly observedAt: string;
  readonly planDigest: string;
  readonly source:
    | "synthetic-fixture"
    | "authenticated-live-current";
  readonly provenance:
    | "synthetic-fixture"
    | "trusted-adapter-authenticated";
  readonly snapshotDigest: string;
  readonly target: AdministratorObservedTargetDigests;
  readonly controls: readonly AdministratorHandoffControlReadback[];
  readonly satisfiedEvidence: readonly AdministratorSatisfiedControlEvidence[];
  readonly readiness: {
    readonly repository: "not-validated";
    readonly credentiallessSyntheticSandbox: "not-run";
    readonly appBackedSandbox: "blocked" | "human-review-reached";
    readonly production: "customer-approval-required";
  };
  readonly nonAuthoritative: {
    readonly driftProneObservation: true;
    readonly grantsNoAuthority: true;
    readonly authorizesNoEffect: true;
    readonly cannotSatisfyHumanGateByItself: true;
  };
}

export interface AdministratorHandoffReport {
  readonly apiVersion: "agentic-framework.github.com/v1alpha1";
  readonly kind: "AdministratorHandoffReport";
  readonly schemaVersion: "1.0.0";
  readonly evidenceEpoch: string;
  readonly repositoryEvidence: {
    readonly baseSha: string;
    readonly headSha: string;
    readonly worktreeClean: true;
  };
  readonly plan: AdministratorHandoffPlan;
  readonly readback: AdministratorHandoffReadback;
  readonly planDigest: string;
  readonly readbackDigest: string;
  readonly gaps: readonly AdministratorHandoffControlReadback[];
  readonly gapCount: number;
  readonly customerStarter: {
    readonly controlPlaneCore: AdministratorStarterEvidence;
    readonly demoPortfolio: AdministratorStarterEvidence;
    readonly decision: "no-go";
    readonly liveSnapshotExported: false;
  };
  readonly syntheticApplyContract: {
    readonly plan: AdministratorApplyPlan;
    readonly confirmation: AdministratorApplyConfirmation;
    readonly preApplyReadback: AdministratorPreApplyReadback;
    readonly postApplyReadback: AdministratorPostApplyReadback;
    readonly planDigest: string;
    readonly confirmationDigest: string;
    readonly preApplyReadbackDigest: string;
    readonly postApplyReadbackDigest: string;
    readonly gateValidated: true;
    readonly postApplyReadbackValidated: true;
    readonly performedLiveEffect: false;
  };
  readonly classification: {
    readonly repository: "exact-head-validation-required";
    readonly credentiallessSyntheticSandbox: "passed";
    readonly appBackedSandbox: "blocked";
    readonly administratorSnapshot: "synthetic-unconfigured";
    readonly production: "customer-approval-required";
  };
  readonly evidenceDigest: string;
}

export interface AdministratorStarterEvidence {
  readonly selectionDigest: string;
  readonly starterManifestDigest: string;
  readonly sbomDigest: string;
  readonly provenanceDigest: string;
  readonly preflightReportDigest: string;
  readonly archiveDigest: string;
}

export interface AdministratorHandoffIssue {
  readonly path: string;
  readonly message: string;
}

export class AdministratorHandoffError extends Error {
  constructor(readonly issues: readonly AdministratorHandoffIssue[]) {
    super(
      `administrator handoff is invalid: ${issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("; ")}`
    );
    this.name = "AdministratorHandoffError";
  }
}

type AdministratorHandoffDocumentKind =
  | "AdministratorHandoffPlan"
  | "AdministratorApplyPlan"
  | "AdministratorApplyConfirmation"
  | "AdministratorApplyReadback"
  | "AdministratorHandoffReadback"
  | "AdministratorHandoffReport";

function handoffDocumentSchemaIssues(
  value: unknown,
  expectedKind: AdministratorHandoffDocumentKind
): readonly AdministratorHandoffIssue[] {
  const result = validateDocument("AdministratorHandoffDocument", value);
  if (!result.valid) {
    return result.errors.map((message) => ({
      path: "/",
      message: `schema validation failed: ${message}`
    }));
  }
  if (result.value.kind !== expectedKind) {
    return [
      {
        path: "/kind",
        message: `expected ${expectedKind}, observed ${result.value.kind}`
      }
    ];
  }
  return [];
}

function exactStringArray(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function stableDataSnapshot<T>(value: T): T {
  return deepFreeze(JSON.parse(canonicalJson(value)) as T);
}

function stateSetsEqual(
  left: AdministratorStateSet,
  right: AdministratorStateSet
): boolean {
  return digest(left) === digest(right);
}

function targetMatches(
  left: AdministratorExactTarget,
  right: AdministratorExactTarget
): boolean {
  return digest(left) === digest(right);
}

function stateSetIssues(
  path: string,
  state: AdministratorStateSet
): readonly AdministratorHandoffIssue[] {
  const issues: AdministratorHandoffIssue[] = [];
  if (
    !Number.isSafeInteger(state.count) ||
    state.count < 0 ||
    !Array.isArray(state.values)
  ) {
    return [
      {
        path,
        message: "state set must carry a non-negative safe count and value array"
      }
    ];
  }
  if (state.count !== state.values.length) {
    issues.push({
      path: `${path}/count`,
      message: "declared count does not match the closed value set"
    });
  }
  const malformed = state.values.some(
    (entry) =>
      entry === null ||
      typeof entry !== "object" ||
      typeof entry.key !== "string" ||
      (entry.value !== null &&
        typeof entry.value !== "string" &&
        typeof entry.value !== "number" &&
        typeof entry.value !== "boolean") ||
      (typeof entry.value === "number" && !Number.isSafeInteger(entry.value))
  );
  if (malformed) {
    issues.push({
      path: `${path}/values`,
      message: "state entries must contain one closed JSON scalar value"
    });
    return issues;
  }
  const duplicateKeys = findDuplicateKeys(state.values, (entry) => entry.key);
  if (duplicateKeys.length > 0) {
    issues.push({
      path: `${path}/values`,
      message: `duplicate state key(s): ${duplicateKeys.join(", ")}`
    });
  }
  const sorted = [...state.values].sort((left, right) =>
    left.key.localeCompare(right.key)
  );
  if (digest(sorted) !== digest(state.values)) {
    issues.push({
      path: `${path}/values`,
      message: "state values must be sorted by key"
    });
  }
  return issues;
}

function valueMatchesRequirement(
  value: AdministratorStateEntry["value"],
  requirement: AdministratorStateRequirement
): boolean {
  if (requirement.valueType === "integer") {
    return typeof value === "number" && Number.isSafeInteger(value);
  }
  return typeof value === requirement.valueType;
}

function targetBindingPresent(
  target: AdministratorExactTarget,
  binding: AdministratorBindingKind
): boolean {
  switch (binding) {
    case "owner":
    case "repository":
      return true;
    case "source-owner":
      return target.sourceOwner !== null;
    case "project":
      return target.project !== null;
    case "environment":
      return target.environment !== null;
    case "ruleset":
      return target.ruleset !== null;
    case "app":
      return target.app !== null;
    case "installation":
      return target.installation !== null;
    case "billing-account":
      return target.billingAccountId !== null;
  }
}

function observedTargetBindingPresent(
  target: AdministratorObservedTargetDigests,
  binding: AdministratorBindingKind
): boolean {
  switch (binding) {
    case "source-owner":
      return target.sourceOwner !== null;
    case "owner":
      return /^sha256:[0-9a-f]{64}$/u.test(target.owner);
    case "repository":
      return /^sha256:[0-9a-f]{64}$/u.test(target.repository);
    case "project":
      return target.project !== null;
    case "environment":
      return target.environment !== null;
    case "ruleset":
      return target.ruleset !== null;
    case "app":
      return target.app !== null;
    case "installation":
      return target.installation !== null;
    case "billing-account":
      return target.billingAccount !== null;
  }
}

function observedTargetIssues(
  target: AdministratorObservedTargetDigests
): readonly AdministratorHandoffIssue[] {
  const observedTargetKeys = [
    "app",
    "billingAccount",
    "environment",
    "installation",
    "owner",
    "project",
    "repository",
    "ruleset",
    "sourceOwner"
  ];
  if (
    target === null ||
    typeof target !== "object" ||
    Array.isArray(target) ||
    !exactStringArray(Object.keys(target).sort(), observedTargetKeys) ||
    Object.values(target).some(
      (value) =>
        value !== null &&
        (typeof value !== "string" ||
          !/^sha256:[0-9a-f]{64}$/u.test(value))
    )
  ) {
    return [
      {
        path: "/target",
        message:
          "handoff readback target must contain only the exact closed target-digest set"
      }
    ];
  }
  return [];
}

function controlDefinition(
  operationId: AdministratorHandoffControlId
): AdministratorHandoffControl | undefined {
  return ADMINISTRATOR_HANDOFF_CONTROLS.find(
    (control) => control.controlId === operationId
  );
}

export function planAdministratorHandoff(
  input: AdministratorHandoffPlanInput
): AdministratorHandoffPlan {
  const sourceDigests = stableDataSnapshot(input.sourceDigests);
  const plan: AdministratorHandoffPlan = {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "AdministratorHandoffPlan",
    schemaVersion: "1.0.0",
    evidenceEpoch: input.evidenceEpoch,
    authorityOrder: ADMINISTRATOR_HANDOFF_AUTHORITY_ORDER,
    sourceDigests,
    durableAdapterPortCount: 15,
    controls: ADMINISTRATOR_HANDOFF_CONTROLS,
    applyProtocol: ADMINISTRATOR_APPLY_PROTOCOL,
    readiness: HANDOFF_READINESS,
    prohibitedEffects: ADMINISTRATOR_PROHIBITED_EFFECTS,
    nonAuthoritative: HANDOFF_NON_AUTHORITATIVE
  };
  const issues = validateAdministratorHandoffPlan(plan);
  if (issues.length > 0) throw new AdministratorHandoffError(issues);
  return deepFreeze(plan);
}

export function validateAdministratorHandoffPlan(
  plan: AdministratorHandoffPlan
): readonly AdministratorHandoffIssue[] {
  const schemaIssues = handoffDocumentSchemaIssues(
    plan,
    "AdministratorHandoffPlan"
  );
  if (schemaIssues.length > 0) return schemaIssues;
  const issues: AdministratorHandoffIssue[] = [];
  if (
    !exactStringArray(
      plan.authorityOrder,
      ADMINISTRATOR_HANDOFF_AUTHORITY_ORDER
    )
  ) {
    issues.push({
      path: "/authorityOrder",
      message: "authority order differs from the fixed trusted order"
    });
  }
  if (
    plan.sourceDigests === null ||
    typeof plan.sourceDigests !== "object" ||
    Array.isArray(plan.sourceDigests) ||
    !exactStringArray(
      Object.keys(plan.sourceDigests).sort(),
      HANDOFF_SOURCE_DIGEST_KEYS
    )
  ) {
    issues.push({
      path: "/sourceDigests",
      message: "source digest object must contain the exact fixed key set"
    });
    return issues;
  }
  for (const [key, value] of Object.entries(plan.sourceDigests)) {
    if (!/^sha256:[0-9a-f]{64}$/u.test(value)) {
      issues.push({
        path: `/sourceDigests/${key}`,
        message: "source digest is not canonical SHA-256 evidence"
      });
    }
  }
  if (plan.durableAdapterPortCount !== 15) {
    issues.push({
      path: "/durableAdapterPortCount",
      message: "handoff must bind exactly fifteen durable adapter ports"
    });
  }
  if (digest(plan.controls) !== digest(ADMINISTRATOR_HANDOFF_CONTROLS)) {
    issues.push({
      path: "/controls",
      message: "control catalogue differs from the fixed trusted catalogue"
    });
  }
  if (
    !exactStringArray(
      plan.prohibitedEffects,
      ADMINISTRATOR_PROHIBITED_EFFECTS
    )
  ) {
    issues.push({
      path: "/prohibitedEffects",
      message: "prohibited effect set differs from the fixed trusted set"
    });
  }
  if (digest(plan.applyProtocol) !== digest(ADMINISTRATOR_APPLY_PROTOCOL)) {
    issues.push({
      path: "/applyProtocol",
      message: "apply protocol differs from the fixed one-attempt human gate"
    });
  }
  if (digest(plan.readiness) !== digest(HANDOFF_READINESS)) {
    issues.push({
      path: "/readiness",
      message: "readiness classification was widened"
    });
  }
  if (digest(plan.nonAuthoritative) !== digest(HANDOFF_NON_AUTHORITATIVE)) {
    issues.push({
      path: "/nonAuthoritative",
      message: "handoff non-authoritative boundary was weakened"
    });
  }
  return issues;
}

export function planAdministratorApply(
  handoffPlan: AdministratorHandoffPlan,
  input: AdministratorApplyPlanInput
): AdministratorApplyPlan {
  const handoffIssues = validateAdministratorHandoffPlan(handoffPlan);
  if (handoffIssues.length > 0) throw new AdministratorHandoffError(handoffIssues);
  if (input.handoffPlanDigest !== digest(handoffPlan)) {
    throw new AdministratorHandoffError([
      {
        path: "/handoffPlanDigest",
        message: "apply plan is not bound to the supplied handoff plan"
      }
    ]);
  }
  const target = stableDataSnapshot(input.target);
  const expectedCurrent = stableDataSnapshot(input.expectedCurrent);
  const desired = stableDataSnapshot(input.desired);
  const attemptId = digest({
    kind: "administrator-apply-attempt",
    handoffPlanDigest: input.handoffPlanDigest,
    operationId: input.operationId,
    generatedAt: input.generatedAt,
    expiresAt: input.expiresAt,
    target,
    expectedCurrent,
    desired
  });
  const idempotencyKey = digest({
    handoffPlanDigest: input.handoffPlanDigest,
    operationId: input.operationId,
    attemptId,
    generatedAt: input.generatedAt,
    expiresAt: input.expiresAt,
    target,
    expectedCurrent,
    desired
  });
  const plan: AdministratorApplyPlan = {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "AdministratorApplyPlan",
    schemaVersion: "1.0.0",
    generatedAt: input.generatedAt,
    expiresAt: input.expiresAt,
    operationId: input.operationId,
    attemptId,
    idempotencyKey,
    handoffPlanDigest: input.handoffPlanDigest,
    target,
    expectedCurrent,
    desired,
    prohibitedEffects: ADMINISTRATOR_PROHIBITED_EFFECTS,
    protocol: ADMINISTRATOR_APPLY_PROTOCOL,
    nonAuthoritative: APPLY_PLAN_NON_AUTHORITATIVE
  };
  const issues = validateAdministratorApplyPlan(plan);
  if (issues.length > 0) throw new AdministratorHandoffError(issues);
  return deepFreeze(plan);
}

export function validateAdministratorApplyPlan(
  plan: AdministratorApplyPlan
): readonly AdministratorHandoffIssue[] {
  const schemaIssues = handoffDocumentSchemaIssues(
    plan,
    "AdministratorApplyPlan"
  );
  if (schemaIssues.length > 0) return schemaIssues;
  const issues: AdministratorHandoffIssue[] = [
    ...stateSetIssues("/expectedCurrent", plan.expectedCurrent),
    ...stateSetIssues("/desired", plan.desired)
  ];
  if (issues.length > 0) return issues;
  if (
    plan.target === null ||
    typeof plan.target !== "object" ||
    Array.isArray(plan.target) ||
    plan.target.owner === null ||
    typeof plan.target.owner !== "object" ||
    plan.target.repository === null ||
    typeof plan.target.repository !== "object"
  ) {
    return [
      {
        path: "/target",
        message: "apply plan target is not one closed exact target object"
      }
    ];
  }
  const definition = controlDefinition(plan.operationId);
  if (definition === undefined) {
    issues.push({
      path: "/operationId",
      message: "operation is outside the closed handoff catalogue"
    });
    return issues;
  }
  if (!definition.applyPlanRequired) {
    issues.push({
      path: "/operationId",
      message: "this human decision/readback step is not an administrative apply"
    });
  }
  if (
    plan.attemptId !==
      digest({
        kind: "administrator-apply-attempt",
        handoffPlanDigest: plan.handoffPlanDigest,
        operationId: plan.operationId,
        generatedAt: plan.generatedAt,
        expiresAt: plan.expiresAt,
        target: plan.target,
        expectedCurrent: plan.expectedCurrent,
        desired: plan.desired
      }) ||
    plan.idempotencyKey !==
      digest({
        handoffPlanDigest: plan.handoffPlanDigest,
        operationId: plan.operationId,
        attemptId: plan.attemptId,
        generatedAt: plan.generatedAt,
        expiresAt: plan.expiresAt,
        target: plan.target,
        expectedCurrent: plan.expectedCurrent,
        desired: plan.desired
      })
  ) {
    issues.push({
      path: "/idempotencyKey",
      message:
        "idempotency key must bind the exact operation, attempt, target, time, current, and desired state"
    });
  }
  const requiredKeys = definition.stateRequirements.map(
    (requirement) => requirement.key
  );
  const expectedKeys = plan.expectedCurrent.values.map((entry) => entry.key);
  const desiredKeys = plan.desired.values.map((entry) => entry.key);
  if (
    !exactStringArray(expectedKeys, requiredKeys) ||
    !exactStringArray(desiredKeys, requiredKeys)
  ) {
    issues.push({
      path: "/expectedCurrent",
      message:
        "current and desired state keys must exactly equal the operation's closed state requirement set"
    });
  } else {
    for (const requirement of definition.stateRequirements) {
      const current = plan.expectedCurrent.values.find(
        (entry) => entry.key === requirement.key
      );
      const desired = plan.desired.values.find(
        (entry) => entry.key === requirement.key
      );
      if (
        current === undefined ||
        desired === undefined ||
        !valueMatchesRequirement(current.value, requirement) ||
        !valueMatchesRequirement(desired.value, requirement)
      ) {
        issues.push({
          path: `/desired/${requirement.key}`,
          message: `state value must use the required ${requirement.valueType} domain`
        });
        continue;
      }
      if (
        requirement.requiredDesiredValue !== undefined &&
        desired.value !== requirement.requiredDesiredValue
      ) {
        issues.push({
          path: `/desired/${requirement.key}`,
          message: `desired value must equal ${String(
            requirement.requiredDesiredValue
          )}`
        });
      }
    }
  }
  for (const binding of definition.requiredBindings) {
    if (!targetBindingPresent(plan.target, binding)) {
      issues.push({
        path: `/target/${binding}`,
        message: `operation requires an exact ${binding} binding`
      });
    }
  }
  if (
    plan.operationId === "main-ruleset-and-required-checks" &&
    plan.target.ruleset?.target !== "branch"
  ) {
    issues.push({
      path: "/target/ruleset/target",
      message:
        "main ruleset and required-check planning requires an exact branch-targeted ruleset"
    });
  }
  if (
    plan.target.owner.login !== plan.target.repository.owner ||
    plan.target.repository.fullName !==
      `${plan.target.repository.owner}/${plan.target.repository.name}`
  ) {
    issues.push({
      path: "/target",
      message: "owner and immutable repository identity do not agree"
    });
  }
  if (
    plan.target.installation !== null &&
    (plan.target.installation.accountId !== plan.target.owner.id ||
      plan.target.installation.accountNodeId !== plan.target.owner.nodeId)
  ) {
    issues.push({
      path: "/target/installation",
      message:
        "installation account identity does not match the exact destination owner"
    });
  }
  if (
    plan.operationId === "app-ownership-transfer" &&
    (plan.target.sourceOwner === null ||
      plan.target.sourceOwner.id === plan.target.owner.id ||
      plan.target.sourceOwner.nodeId === plan.target.owner.nodeId ||
      plan.target.sourceOwner.login.toLowerCase() ===
        plan.target.owner.login.toLowerCase())
  ) {
    issues.push({
      path: "/target/sourceOwner",
      message:
        "App ownership transfer requires distinct exact source and destination owners"
    });
  }
  if (
    !exactStringArray(
      plan.prohibitedEffects,
      ADMINISTRATOR_PROHIBITED_EFFECTS
    )
  ) {
    issues.push({
      path: "/prohibitedEffects",
      message: "apply plan must retain every prohibited effect"
    });
  }
  if (digest(plan.protocol) !== digest(ADMINISTRATOR_APPLY_PROTOCOL)) {
    issues.push({
      path: "/protocol",
      message: "apply protocol differs from the fixed exact human gate"
    });
  }
  if (
    digest(plan.nonAuthoritative) !== digest(APPLY_PLAN_NON_AUTHORITATIVE)
  ) {
    issues.push({
      path: "/nonAuthoritative",
      message: "apply plan non-authoritative boundary was weakened"
    });
  }
  if (Date.parse(plan.generatedAt) >= Date.parse(plan.expiresAt)) {
    issues.push({
      path: "/expiresAt",
      message: "apply plan must expire after it is generated"
    });
  }
  return issues;
}

function compareApplyReadbackBase(
  plan: AdministratorApplyPlan,
  readback: AdministratorApplyReadback,
  freshness: FreshnessWindow
): readonly AdministratorHandoffIssue[] {
  const planIssues = validateAdministratorApplyPlan(plan);
  if (planIssues.length > 0) return planIssues;
  if (readback.planDigest !== digest(plan)) {
    return [
      {
        path: "/planDigest",
        message: "readback is not bound to the canonical exact apply plan"
      }
    ];
  }
  if (!targetMatches(readback.target, plan.target)) {
    return [
      {
        path: "/target",
        message: "readback target differs from the exact apply target"
      }
    ];
  }
  if (
    readback.attemptId !== plan.attemptId ||
    !/^sha256:[0-9a-f]{64}$/u.test(readback.confirmationDigest)
  ) {
    return [
      {
        path: "/attemptId",
        message:
          "readback attempt or confirmation identity differs from the exact apply plan"
      }
    ];
  }
  const issues = [
    ...checkObservationFreshness(
      "/observedAt",
      readback.observedAt,
      freshness
    ),
    ...stateSetIssues("/actual", readback.actual)
  ];
  if (
    readback.completeReadback !== true ||
    readback.nonAuthoritative.evidenceOnly !== true ||
    readback.nonAuthoritative.cannotRetryOrApply !== true
  ) {
    issues.push({
      path: "/nonAuthoritative",
      message: "readback evidence-only boundary was weakened"
    });
  }
  return issues;
}

export function validateAdministratorApplyGate(input: {
  readonly plan: AdministratorApplyPlan;
  readonly confirmation: AdministratorApplyConfirmation;
  readonly preApplyReadback: AdministratorPreApplyReadback;
  readonly freshness: FreshnessWindow;
}): {
  readonly readyForTrustedAdapterVerification: boolean;
  readonly issues: readonly AdministratorHandoffIssue[];
} {
  const schemaIssues = [
    ...handoffDocumentSchemaIssues(input.plan, "AdministratorApplyPlan"),
    ...handoffDocumentSchemaIssues(
      input.confirmation,
      "AdministratorApplyConfirmation"
    ),
    ...handoffDocumentSchemaIssues(
      input.preApplyReadback,
      "AdministratorApplyReadback"
    )
  ];
  if (schemaIssues.length > 0) {
    return {
      readyForTrustedAdapterVerification: false,
      issues: schemaIssues
    };
  }
  const plan = stableDataSnapshot(input.plan);
  const confirmation = stableDataSnapshot(input.confirmation);
  const preApplyReadback = stableDataSnapshot(input.preApplyReadback);
  const issues: AdministratorHandoffIssue[] = [
    ...compareApplyReadbackBase(
      plan,
      preApplyReadback,
      input.freshness
    )
  ];
  const planDigest = digest(plan);
  const confirmationDigest = digest(confirmation);
  if (
    confirmation.planDigest !== planDigest ||
    preApplyReadback.planDigest !== planDigest ||
    preApplyReadback.confirmationDigest !== confirmationDigest
  ) {
    issues.push({
      path: "/confirmation/planDigest",
      message:
        "confirmation and pre-apply readback must bind the same exact plan and confirmation"
    });
  }
  if (
    confirmation.separateExplicitHumanConfirmation !== true ||
    confirmation.nonAuthoritative.requiresTrustedAdapterVerification !== true ||
    confirmation.nonAuthoritative.performsNoEffect !== true ||
    !/^sha256:[0-9a-f]{64}$/u.test(
      confirmation.confirmationEvidenceDigest
    ) ||
    confirmation.confirmationId.length === 0 ||
    confirmation.confirmedBy.length === 0 ||
    Date.parse(confirmation.confirmedAt) >= Date.parse(confirmation.expiresAt)
  ) {
    issues.push({
      path: "/confirmation",
      message:
        "confirmation is incomplete, self-authorizing, or temporally invalid"
    });
  }
  issues.push(
    ...checkObservationFreshness(
      "/confirmation/confirmedAt",
      confirmation.confirmedAt,
      input.freshness
    ),
    ...checkNotExpired(
      "/confirmation/expiresAt",
      confirmation.expiresAt,
      input.freshness.now
    ),
    ...checkNotExpired(
      "/plan/expiresAt",
      plan.expiresAt,
      input.freshness.now
    )
  );
  if (
    preApplyReadback.phase !== "pre-apply" ||
    preApplyReadback.mutationAttemptCount !== 0 ||
    preApplyReadback.acknowledgement !== "not-attempted" ||
    preApplyReadback.preApplyReadbackDigest !== null ||
    preApplyReadback.attemptedAt !== null ||
    preApplyReadback.attemptReceiptDigest !== null
  ) {
    issues.push({
      path: "/preApplyReadback",
      message: "fresh pre-apply evidence must precede every mutation attempt"
    });
  }
  if (
    !stateSetsEqual(preApplyReadback.actual, plan.expectedCurrent)
  ) {
    issues.push({
      path: "/preApplyReadback/actual",
      message: "fresh current counts or values differ from the approved expectation"
    });
  }
  if (
    Date.parse(plan.generatedAt) > Date.parse(confirmation.confirmedAt) ||
    Date.parse(confirmation.confirmedAt) >
      Date.parse(preApplyReadback.observedAt)
  ) {
    issues.push({
      path: "/preApplyReadback/observedAt",
      message:
        "plan, separate confirmation, and fresh pre-apply readback are not temporally ordered"
    });
  }
  return {
    readyForTrustedAdapterVerification: issues.length === 0,
    issues
  };
}

export function validateAdministratorPostApplyReadback(input: {
  readonly plan: AdministratorApplyPlan;
  readonly confirmation: AdministratorApplyConfirmation;
  readonly preApplyReadback: AdministratorPreApplyReadback;
  readonly readback: AdministratorPostApplyReadback;
  readonly freshness: FreshnessWindow;
}): {
  readonly desiredStateObserved: boolean;
  readonly reconciliationRequired: boolean;
  readonly issues: readonly AdministratorHandoffIssue[];
} {
  const schemaIssues = [
    ...handoffDocumentSchemaIssues(input.plan, "AdministratorApplyPlan"),
    ...handoffDocumentSchemaIssues(
      input.confirmation,
      "AdministratorApplyConfirmation"
    ),
    ...handoffDocumentSchemaIssues(
      input.preApplyReadback,
      "AdministratorApplyReadback"
    ),
    ...handoffDocumentSchemaIssues(
      input.readback,
      "AdministratorApplyReadback"
    )
  ];
  if (schemaIssues.length > 0) {
    return {
      desiredStateObserved: false,
      reconciliationRequired: true,
      issues: schemaIssues
    };
  }
  const plan = stableDataSnapshot(input.plan);
  const confirmation = stableDataSnapshot(input.confirmation);
  const preApplyReadback = stableDataSnapshot(input.preApplyReadback);
  const readback = stableDataSnapshot(input.readback);
  const gate = validateAdministratorApplyGate({
    plan,
    confirmation,
    preApplyReadback,
    freshness: input.freshness
  });
  const issues: AdministratorHandoffIssue[] = [
    ...gate.issues,
    ...compareApplyReadbackBase(plan, readback, input.freshness)
  ];
  if (
    readback.phase !== "post-apply" ||
    readback.mutationAttemptCount !== 1
  ) {
    issues.push({
      path: "/readback",
      message: "post-apply readback must follow exactly one bounded attempt"
    });
  }
  if (
    readback.acknowledgement !== "unambiguous-applied" &&
    readback.acknowledgement !== "ambiguous"
  ) {
    issues.push({
      path: "/acknowledgement",
      message: "post-apply acknowledgement is invalid"
    });
  }
  if (
    readback.confirmationDigest !== digest(confirmation) ||
    readback.preApplyReadbackDigest !== digest(preApplyReadback) ||
    readback.attemptId !== plan.attemptId ||
    !/^sha256:[0-9a-f]{64}$/u.test(readback.attemptReceiptDigest)
  ) {
    issues.push({
      path: "/readback",
      message:
        "post-apply readback must bind the exact confirmation, pre-readback, attempt, and trusted attempt receipt"
    });
  }
  if (
    Date.parse(preApplyReadback.observedAt) > Date.parse(readback.attemptedAt) ||
    Date.parse(readback.attemptedAt) > Date.parse(readback.observedAt)
  ) {
    issues.push({
      path: "/readback/attemptedAt",
      message:
        "pre-readback, one attempt, and post-readback are not temporally ordered"
    });
  }
  const desiredObserved = stateSetsEqual(readback.actual, plan.desired);
  if (!desiredObserved) {
    issues.push({
      path: "/actual",
      message: "complete post-apply readback does not equal the closed desired state"
    });
  }
  const ambiguous = readback.acknowledgement === "ambiguous";
  if (ambiguous) {
    issues.push({
      path: "/acknowledgement",
      message: "ambiguous acknowledgement is reconciliation-required and must not be retried"
    });
  }
  return {
    desiredStateObserved: issues.length === 0 && desiredObserved,
    reconciliationRequired: ambiguous || !desiredObserved,
    issues
  };
}

export function compareAdministratorHandoffReadback(
  plan: AdministratorHandoffPlan,
  readback: AdministratorHandoffReadback,
  freshness: FreshnessWindow
): {
  readonly valid: boolean;
  readonly gaps: readonly AdministratorHandoffControlReadback[];
  readonly issues: readonly AdministratorHandoffIssue[];
} {
  const schemaIssues = [
    ...handoffDocumentSchemaIssues(plan, "AdministratorHandoffPlan"),
    ...handoffDocumentSchemaIssues(readback, "AdministratorHandoffReadback")
  ];
  if (schemaIssues.length > 0) {
    return { valid: false, gaps: [], issues: schemaIssues };
  }
  const planIssues = validateAdministratorHandoffPlan(plan);
  if (planIssues.length > 0) {
    return { valid: false, gaps: [], issues: planIssues };
  }
  if (readback.planDigest !== digest(plan)) {
    return {
      valid: false,
      gaps: [],
      issues: [
        {
          path: "/planDigest",
          message: "handoff readback is detached from the exact handoff plan"
        }
      ]
    };
  }
  const freshnessIssues = checkObservationFreshness(
    "/observedAt",
    readback.observedAt,
    freshness
  );
  if (freshnessIssues.length > 0) {
    return { valid: false, gaps: [], issues: freshnessIssues };
  }
  const issues: AdministratorHandoffIssue[] = [];
  const expectedProvenance = {
    "synthetic-fixture": "synthetic-fixture",
    "authenticated-live-current": "trusted-adapter-authenticated"
  } as const;
  if (readback.provenance !== expectedProvenance[readback.source]) {
    issues.push({
      path: "/provenance",
      message: "readback source and provenance classification do not match"
    });
  }
  if (
    readback.source !== "authenticated-live-current" &&
    (readback.readiness.repository !== "not-validated" ||
      readback.readiness.credentiallessSyntheticSandbox !== "not-run" ||
      readback.readiness.appBackedSandbox !== "blocked")
  ) {
    issues.push({
      path: "/readiness",
      message:
        "synthetic readback cannot claim repository, canary, or App-backed readiness"
    });
  }
  issues.push(...observedTargetIssues(readback.target));
  if (
    readback.nonAuthoritative.driftProneObservation !== true ||
    readback.nonAuthoritative.grantsNoAuthority !== true ||
    readback.nonAuthoritative.authorizesNoEffect !== true ||
    readback.nonAuthoritative.cannotSatisfyHumanGateByItself !== true
  ) {
    issues.push({
      path: "/nonAuthoritative",
      message: "handoff readback weakened its drift-prone evidence-only boundary"
    });
  }
  if (
    readback.snapshotDigest !==
    computeAdministratorHandoffSnapshotDigest(readback)
  ) {
    issues.push({
      path: "/snapshotDigest",
      message: "readback snapshot digest does not bind its drift-prone observations"
    });
  }
  const duplicates = findDuplicateKeys(
    readback.controls,
    (control) => control.controlId
  );
  if (duplicates.length > 0) {
    issues.push({
      path: "/controls",
      message: `duplicate control readback(s): ${duplicates.join(", ")}`
    });
  }
  const observed = new Map(
    readback.controls.map((control) => [control.controlId, control])
  );
  const duplicateSatisfiedEvidence = findDuplicateKeys(
    readback.satisfiedEvidence,
    (evidence) => evidence.controlId
  );
  if (duplicateSatisfiedEvidence.length > 0) {
    issues.push({
      path: "/satisfiedEvidence",
      message: `duplicate satisfied-control evidence: ${duplicateSatisfiedEvidence.join(
        ", "
      )}`
    });
  }
  const satisfiedEvidence = new Map(
    readback.satisfiedEvidence.map((evidence) => [
      evidence.controlId,
      evidence
    ])
  );
  for (const planned of plan.controls) {
    if (!observed.has(planned.controlId)) {
      issues.push({
        path: `/controls/${planned.controlId}`,
        message: "planned control is missing from the complete readback"
      });
    }
  }
  for (const controlId of observed.keys()) {
    if (controlDefinition(controlId) === undefined) {
      issues.push({
        path: `/controls/${controlId}`,
        message: "readback contains a control outside the closed catalogue"
      });
    }
  }
  for (const control of readback.controls) {
    const definition = controlDefinition(control.controlId);
    const evidence = satisfiedEvidence.get(control.controlId);
    if (
      control.observationDigest !== null &&
      !/^sha256:[0-9a-f]{64}$/u.test(control.observationDigest)
    ) {
      issues.push({
        path: `/controls/${control.controlId}/observationDigest`,
        message: "observation digest is not canonical SHA-256 evidence"
      });
    }
    if (
      control.status === "satisfied" &&
      (readback.source !== "authenticated-live-current" ||
        control.reasonCode !== "observed-compliant" ||
        control.observationDigest === null ||
        definition === undefined ||
        evidence === undefined ||
        evidence.responsibleOwner !== definition.responsibleOwner ||
        evidence.targetSource !== definition.targetSource ||
        evidence.readbackProcedure !== definition.readbackProcedure ||
        evidence.observationDigest !== control.observationDigest ||
        definition.requiredBindings.some(
          (binding) => !observedTargetBindingPresent(readback.target, binding)
        ) ||
        definition.prerequisites.some(
          (prerequisite) =>
            observed.get(prerequisite)?.status !== "satisfied"
        ))
    ) {
      issues.push({
        path: `/controls/${control.controlId}`,
        message:
          "a satisfied control requires current authenticated live source, exact compliant reason, and non-null evidence"
      });
    }
    if (control.status !== "satisfied" && evidence !== undefined) {
      issues.push({
        path: `/satisfiedEvidence/${control.controlId}`,
        message: "gap control cannot carry satisfied-control evidence"
      });
    }

    if (
      control.status === "repository-evidence-only" &&
      control.reasonCode !== "synthetic-only"
    ) {
      issues.push({
        path: `/controls/${control.controlId}/reasonCode`,
        message:
          "repository-only evidence must remain explicitly classified as synthetic-only"
      });
    }
    for (const controlId of satisfiedEvidence.keys()) {
      if (!observed.has(controlId)) {
        issues.push({
          path: `/satisfiedEvidence/${controlId}`,
          message: "satisfied evidence has no corresponding control readback"
        });
      }
    }
    if (
      control.status !== "satisfied" &&
      control.reasonCode === "observed-compliant"
    ) {
      issues.push({
        path: `/controls/${control.controlId}/reasonCode`,
        message: "a gap cannot claim observed compliance"
      });
    }
  }
  const gaps = readback.controls.filter(
    (control) => control.status !== "satisfied"
  );
  const appBackedExcluded = new Set<AdministratorHandoffControlId>([
    "customer-transfer",
    "open-source-preflight",
    "production-readiness"
  ]);
  const appBackedRequired = plan.controls.filter(
    (control) => !appBackedExcluded.has(control.controlId)
  );
  const appBackedGaps = appBackedRequired.filter(
    (control) => observed.get(control.controlId)?.status !== "satisfied"
  );
  if (
    readback.readiness.appBackedSandbox === "human-review-reached" &&
    (readback.source !== "authenticated-live-current" ||
      appBackedGaps.length > 0 ||
      appBackedRequired.some((control) =>
        control.requiredBindings.some(
          (binding) => !observedTargetBindingPresent(readback.target, binding)
        )
      ))
  ) {
    issues.push({
      path: "/readiness/appBackedSandbox",
      message:
        "App-backed sandbox Human Review requires current authenticated live evidence, every prerequisite control, and every exact target binding"
    });
  }
  if (
    readback.readiness.appBackedSandbox !== "blocked" &&
    readback.source !== "authenticated-live-current"
  ) {
    issues.push({
      path: "/readiness",
      message:
        "synthetic evidence cannot satisfy an App-backed live canary"
    });
  }
  return { valid: issues.length === 0, gaps, issues };
}

export function computeAdministratorHandoffSnapshotDigest(
  readback:
    | AdministratorHandoffReadback
    | Omit<AdministratorHandoffReadback, "snapshotDigest">
): string {
  const {
    snapshotDigest: _snapshotDigest,
    ...body
  } = readback as AdministratorHandoffReadback;
  return digest(body);
}

export function validateAdministratorHandoffReport(
  report: AdministratorHandoffReport,
  readbackFreshness: FreshnessWindow
): readonly AdministratorHandoffIssue[] {
  const schemaIssues = handoffDocumentSchemaIssues(
    report,
    "AdministratorHandoffReport"
  );
  if (schemaIssues.length > 0) return schemaIssues;
  const issues: AdministratorHandoffIssue[] = [];
  if (
    !/^[0-9a-f]{40}$/u.test(report.repositoryEvidence.baseSha) ||
    !/^[0-9a-f]{40}$/u.test(report.repositoryEvidence.headSha) ||
    report.repositoryEvidence.worktreeClean !== true
  ) {
    issues.push({
      path: "/repositoryEvidence",
      message: "report must bind a clean exact base/head pair"
    });
  }
  const planIssues = validateAdministratorHandoffPlan(report.plan);
  issues.push(...planIssues);
  const comparison = compareAdministratorHandoffReadback(
    report.plan,
    report.readback,
    readbackFreshness
  );
  issues.push(...comparison.issues);
  if (
    report.planDigest !== digest(report.plan) ||
    report.readbackDigest !== digest(report.readback)
  ) {
    issues.push({
      path: "/planDigest",
      message: "report plan or readback digest does not match its embedded document"
    });
  }
  if (
    report.gapCount !== comparison.gaps.length ||
    digest(report.gaps) !== digest(comparison.gaps)
  ) {
    issues.push({
      path: "/gaps",
      message: "report gap matrix does not equal the comparator-derived matrix"
    });
  }

  const synthetic = report.syntheticApplyContract;
  if (
    synthetic.plan.handoffPlanDigest !== report.planDigest ||
    synthetic.planDigest !== digest(synthetic.plan) ||
    synthetic.confirmationDigest !== digest(synthetic.confirmation) ||
    synthetic.preApplyReadbackDigest !== digest(synthetic.preApplyReadback) ||
    synthetic.postApplyReadbackDigest !== digest(synthetic.postApplyReadback) ||
    synthetic.performedLiveEffect !== false
  ) {
    issues.push({
      path: "/syntheticApplyContract",
      message:
        "synthetic apply handoff binding, document digests, or no-live-effect marker do not match"
    });
  }
  const syntheticFreshness = {
    now: synthetic.postApplyReadback.observedAt,
    maxAgeMs: 15 * 60 * 1000
  };
  const gate = validateAdministratorApplyGate({
    plan: synthetic.plan,
    confirmation: synthetic.confirmation,
    preApplyReadback: synthetic.preApplyReadback,
    freshness: syntheticFreshness
  });
  const post = validateAdministratorPostApplyReadback({
    plan: synthetic.plan,
    confirmation: synthetic.confirmation,
    preApplyReadback: synthetic.preApplyReadback,
    readback: synthetic.postApplyReadback,
    freshness: syntheticFreshness
  });
  if (
    !gate.readyForTrustedAdapterVerification ||
    !post.desiredStateObserved ||
    synthetic.gateValidated !== true ||
    synthetic.postApplyReadbackValidated !== true
  ) {
    issues.push({
      path: "/syntheticApplyContract",
      message:
        "embedded synthetic plan/confirmation/readbacks do not revalidate"
    });
  }
  if (
    report.customerStarter.decision !== "no-go" ||
    report.customerStarter.liveSnapshotExported !== false
  ) {
    issues.push({
      path: "/customerStarter",
      message:
        "customer starter must remain no-go and exclude the live snapshot"
    });
  }
  if (
    report.customerStarter.controlPlaneCore.selectionDigest !==
      report.plan.sourceDigests.customerStarterCoreSelection ||
    report.customerStarter.demoPortfolio.selectionDigest !==
      report.plan.sourceDigests.customerStarterDemoSelection
  ) {
    issues.push({
      path: "/customerStarter",
      message:
        "customer-starter evidence selections do not match the handoff plan"
    });
  }
  for (const [profile, evidence] of Object.entries({
    controlPlaneCore: report.customerStarter.controlPlaneCore,
    demoPortfolio: report.customerStarter.demoPortfolio
  })) {
    if (
      Object.values(evidence).some(
        (value) =>
          typeof value !== "string" ||
          !/^sha256:[0-9a-f]{64}$/u.test(value)
      )
    ) {
      issues.push({
        path: `/customerStarter/${profile}`,
        message: "customer-starter evidence contains a non-canonical digest"
      });
    }
  }
  if (
    report.classification.repository !== "exact-head-validation-required" ||
    report.classification.credentiallessSyntheticSandbox !== "passed" ||
    report.classification.appBackedSandbox !== "blocked" ||
    report.classification.administratorSnapshot !==
      "synthetic-unconfigured" ||
    report.classification.production !== "customer-approval-required" ||
    report.readback.readiness.appBackedSandbox !== "blocked"
  ) {
    issues.push({
      path: "/classification",
      message: "report widened a repository, snapshot, sandbox, or production claim"
    });
  }
  const { evidenceDigest: _evidenceDigest, ...body } = report;
  if (report.evidenceDigest !== digest(body)) {
    issues.push({
      path: "/evidenceDigest",
      message: "report evidence digest does not bind the complete report body"
    });
  }
  return issues;
}
