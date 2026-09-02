/**
 * Closed, versioned, provider-neutral pre-App deployment topology contract.
 *
 * This module declares the exact independent trust-service identities,
 * durable stores, budgets, monitoring signals, retention windows, and
 * protections a human administrator must provision before any live App
 * installation or activation (see `docs/runbooks/deployment-prerequisites.md`).
 *
 * The canonical identity sets below are fixed in code, not supplied by a
 * caller or model: `planDeploymentTopology` always emits exactly these
 * services and stores, and `validateDeploymentTopologyPlan` rejects any
 * ingested document (for example a readback of a previously generated plan)
 * that omits, duplicates, or adds to the closed sets. This module performs no
 * network, environment, filesystem, or clock read; every "generatedAt" value
 * is caller-supplied so evaluation stays deterministic and side-effect free.
 *
 * Independence between services and between durable stores is enforced
 * structurally, not merely declared: every service carries a fixed,
 * code-derived logical `principalId` (validated exactly against its
 * `serviceId`) plus a caller-supplied `signingKeyId` and `oidcAudience`, and
 * every durable store carries a caller-supplied `namespace` and
 * `credentialId`. `validateDeploymentTopologyPlan` requires every one of
 * these identifiers to be unique across the closed set — no two services may
 * share one audience or one key, and no two stores may share one namespace
 * or one credential — so a plan that assigns all eight services to a single
 * shared identity while still claiming independence fails closed. None of
 * these identifiers is a real endpoint, key, or secret; they are opaque
 * logical names a human administrator maps onto real infrastructure.
 */

import { findDuplicateKeys } from "./duplicate-keys.js";

export type TrustServiceId =
  | "webhook-verifier"
  | "runtime-state-publisher"
  | "authorization-redeemer"
  | "evidence-signer"
  | "evidence-and-grant-store-broker"
  | "github-token-broker"
  | "single-writer-reconciler"
  | "installation-and-release-adapter";

export const TRUST_SERVICE_IDS: readonly TrustServiceId[] = [
  "webhook-verifier",
  "runtime-state-publisher",
  "authorization-redeemer",
  "evidence-signer",
  "evidence-and-grant-store-broker",
  "github-token-broker",
  "single-writer-reconciler",
  "installation-and-release-adapter"
];

export type TrustServiceKind =
  | "webhook-ingress"
  | "state-publisher"
  | "oidc-redeemer"
  | "evidence-signer"
  | "durable-store-service"
  | "credential-broker"
  | "single-writer"
  | "installation-adapter";

const SERVICE_KIND_BY_ID: Readonly<Record<TrustServiceId, TrustServiceKind>> = {
  "webhook-verifier": "webhook-ingress",
  "runtime-state-publisher": "state-publisher",
  "authorization-redeemer": "oidc-redeemer",
  "evidence-signer": "evidence-signer",
  "evidence-and-grant-store-broker": "durable-store-service",
  "github-token-broker": "credential-broker",
  "single-writer-reconciler": "single-writer",
  "installation-and-release-adapter": "installation-adapter"
};

/**
 * A fixed, code-derived logical principal identity, one per service, never
 * supplied by a caller. It exists purely to give `validateDeploymentTopologyPlan`
 * an exact expected value to check an ingested plan against (mirroring the
 * `kind` check below) — it is not a credential and carries no authority.
 */
const SERVICE_PRINCIPAL_ID_BY_ID: Readonly<Record<TrustServiceId, string>> = {
  "webhook-verifier": "principal:webhook-verifier",
  "runtime-state-publisher": "principal:runtime-state-publisher",
  "authorization-redeemer": "principal:authorization-redeemer",
  "evidence-signer": "principal:evidence-signer",
  "evidence-and-grant-store-broker": "principal:evidence-and-grant-store-broker",
  "github-token-broker": "principal:github-token-broker",
  "single-writer-reconciler": "principal:single-writer-reconciler",
  "installation-and-release-adapter": "principal:installation-and-release-adapter"
};

export type DurableStoreId =
  | "evidence-store"
  | "operation-grant-store"
  | "receipt-journal"
  | "runtime-state-store";

export const DURABLE_STORE_IDS: readonly DurableStoreId[] = [
  "evidence-store",
  "operation-grant-store",
  "receipt-journal",
  "runtime-state-store"
];

export type MonitoringSignal =
  | "health"
  | "latency"
  | "errorRate"
  | "budgetExhaustion"
  | "evidenceSigningFailure"
  | "replayRejection"
  | "durableStoreUnavailable"
  | "journalCapacityWarning";

export const REQUIRED_MONITORING_SIGNALS: readonly MonitoringSignal[] = [
  "health",
  "latency",
  "errorRate",
  "budgetExhaustion",
  "evidenceSigningFailure",
  "replayRejection",
  "durableStoreUnavailable",
  "journalCapacityWarning"
];

export type RetentionArtifactKind =
  | "signed-evidence"
  | "receipt-journal"
  | "audit-log"
  | "installation-backup";

export const RETENTION_ARTIFACT_KINDS: readonly RetentionArtifactKind[] = [
  "signed-evidence",
  "receipt-journal",
  "audit-log",
  "installation-backup"
];

export type ProtectionScope =
  | "app-installation"
  | "ruleset"
  | "required-check"
  | "actions-policy"
  | "ghas-setting"
  | "project-binding"
  | "billing"
  | "visibility";

export const REQUIRED_PROTECTION_SCOPES: readonly ProtectionScope[] = [
  "app-installation",
  "ruleset",
  "required-check",
  "actions-policy",
  "ghas-setting",
  "project-binding"
];

export type CredentialCustody =
  | "sign-only-broker"
  | "short-lived-scoped-token"
  | "none";

export interface ServiceIdentity {
  readonly principalId: string;
  readonly oidcAudience: string;
  readonly allowedRepositories: readonly string[];
  readonly allowedWorkflows: readonly string[];
  readonly signingKeyId: string;
  readonly credentialCustody: CredentialCustody;
}

export interface ServiceHealth {
  readonly endpointPath: string;
  readonly exposesSecretMaterial: false;
  readonly failClosedOnDependencyUnavailable: true;
}

export interface ServiceNetwork {
  readonly denyByDefaultEgress: true;
  readonly allowedEgressHosts: readonly string[];
}

export interface ServiceIsolation {
  readonly sharedWithModelRunner: false;
  readonly sharedWithReviewerJob: false;
  readonly sharedWithUntrustedActionsJob: false;
  readonly dedicatedCredential: true;
}

export interface DeploymentService {
  readonly serviceId: TrustServiceId;
  readonly kind: TrustServiceKind;
  readonly identity: ServiceIdentity;
  readonly health: ServiceHealth;
  readonly network: ServiceNetwork;
  readonly isolation: ServiceIsolation;
}

export interface DurableStoreAtomicGuarantees {
  readonly casSupported: true;
  readonly idempotentWrites: true;
  readonly replayRefusal: true;
  readonly restartContinuity: true;
  readonly boundedJournal: {
    readonly maxEntries: number;
    readonly enforced: true;
  };
}

export interface DurableStoreIsolation {
  readonly dedicatedCredential: true;
  readonly sharedWithModelRunner: false;
}

/**
 * The backend namespace and credential identity a durable store uses. Both
 * are opaque logical names supplied by the deployment planner (never a real
 * connection string, endpoint, or secret); `validateDeploymentTopologyPlan`
 * requires both to be unique across the closed four-store set so no two
 * stores can claim independence while actually sharing one backend
 * namespace or one credential.
 */
export interface DurableStoreIdentity {
  readonly namespace: string;
  readonly credentialId: string;
}

export interface DeploymentDurableStore {
  readonly storeId: DurableStoreId;
  readonly kind: string;
  readonly identity: DurableStoreIdentity;
  readonly atomicGuarantees: DurableStoreAtomicGuarantees;
  readonly isolation: DurableStoreIsolation;
}

export type BudgetLimitKind = "requests" | "tokens" | "cost-units" | "concurrency";

export interface DeploymentBudget {
  readonly budgetId: string;
  readonly appliesToServiceId: TrustServiceId;
  readonly limitKind: BudgetLimitKind;
  readonly windowSeconds: number;
  readonly maxUnits: number;
}

export type AlertOwnerRole = "security-owner" | "platform-owner" | "on-call-admin";
export type AlertChannel = "incident-queue" | "paging" | "email";

export interface DeploymentMonitoring {
  readonly requiredSignals: readonly MonitoringSignal[];
  readonly alertRouting: {
    readonly ownerRole: AlertOwnerRole;
    readonly channel: AlertChannel;
  };
}

export interface RetentionEntry {
  readonly artifactKind: RetentionArtifactKind;
  readonly minRetentionDays: number;
  readonly maxRetentionDays: number;
}

export interface DeploymentProtection {
  readonly protectionId: string;
  readonly scope: ProtectionScope;
  readonly requiresHumanApproval: true;
  readonly allowsAutomationBypass: false;
}

export interface DeploymentTopologyPlan {
  readonly apiVersion: "agentic-framework.github.com/v1alpha1";
  readonly kind: "DeploymentTopologyPlan";
  readonly schemaVersion: "1.0.0";
  readonly generatedAt: string;
  readonly services: readonly DeploymentService[];
  readonly durableStores: readonly DeploymentDurableStore[];
  readonly budgets: readonly DeploymentBudget[];
  readonly monitoring: DeploymentMonitoring;
  readonly retention: readonly RetentionEntry[];
  readonly protections: readonly DeploymentProtection[];
  readonly nonAuthoritative: {
    readonly cannotInstallOrTransferApp: true;
    readonly cannotMintOrHoldCredentials: true;
    readonly cannotSelectLiveTarget: true;
    readonly cannotDeployOrActivate: true;
  };
}

export interface DeploymentServiceInput {
  readonly oidcAudience: string;
  readonly allowedRepositories: readonly string[];
  readonly allowedWorkflows: readonly string[];
  readonly signingKeyId: string;
  readonly credentialCustody: CredentialCustody;
  readonly endpointPath: string;
  readonly allowedEgressHosts: readonly string[];
}

export interface DeploymentStoreInput {
  readonly maxEntries: number;
  readonly namespace: string;
  readonly credentialId: string;
}

export interface DeploymentTopologyInput {
  readonly generatedAt: string;
  readonly serviceDetails: Readonly<Record<TrustServiceId, DeploymentServiceInput>>;
  readonly storeDetails: Readonly<Record<DurableStoreId, DeploymentStoreInput>>;
  readonly budgets: readonly DeploymentBudget[];
  readonly alertRouting: {
    readonly ownerRole: AlertOwnerRole;
    readonly channel: AlertChannel;
  };
  readonly retention: readonly RetentionEntry[];
  readonly protections: readonly DeploymentProtection[];
}

export interface DeploymentTopologyIssue {
  readonly path: string;
  readonly message: string;
}

export class DeploymentTopologyValidationError extends Error {
  constructor(readonly issues: readonly DeploymentTopologyIssue[]) {
    super(
      `deployment topology plan is invalid: ${issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("; ")}`
    );
    this.name = "DeploymentTopologyValidationError";
  }
}

const DURABLE_STORE_KIND_BY_ID: Readonly<Record<DurableStoreId, string>> = {
  "evidence-store": "conditional-evidence-store",
  "operation-grant-store": "operation-grant-claim-store",
  "receipt-journal": "bounded-signed-receipt-journal",
  "runtime-state-store": "copilot-runtime-state-store"
};

function exactSetCoverage<T extends string>(
  path: string,
  observed: readonly T[],
  canonical: readonly T[]
): readonly DeploymentTopologyIssue[] {
  const observedSet = new Set(observed);
  const canonicalSet = new Set(canonical);
  const issues: DeploymentTopologyIssue[] = [];
  if (observedSet.size !== observed.length) {
    issues.push({ path, message: "duplicate entries are not permitted" });
  }
  for (const expected of canonical) {
    if (!observedSet.has(expected)) {
      issues.push({ path, message: `missing required entry ${expected}` });
    }
  }
  for (const actual of observedSet) {
    if (!canonicalSet.has(actual)) {
      issues.push({ path, message: `unexpected entry ${actual}` });
    }
  }
  return issues;
}

/**
 * Reports drift when any value in `values` is repeated. Used to enforce
 * structural independence: no two services may share a signing key or OIDC
 * audience, and no two durable stores may share a namespace or credential.
 */
function requireUniqueValues(
  path: string,
  values: readonly string[],
  description: string
): readonly DeploymentTopologyIssue[] {
  const seen = new Map<string, number>();
  for (const value of values) {
    seen.set(value, (seen.get(value) ?? 0) + 1);
  }
  const duplicates = [...seen.entries()].filter(([, count]) => count > 1).map(([value]) => value);
  if (duplicates.length === 0) return [];
  return [
    {
      path,
      message: `${description} must be unique across the closed set; duplicate value(s): ${duplicates.join(", ")}`
    }
  ];
}

/**
 * Deterministically assembles a closed deployment topology plan from caller
 * supplied opaque identity, budget, retention, and protection detail. The set
 * of services and durable stores is fixed by this module and cannot be
 * widened or narrowed by the input. Each service's `principalId` is derived
 * by this module, never caller-supplied.
 */
export function planDeploymentTopology(
  input: DeploymentTopologyInput
): DeploymentTopologyPlan {
  const services: DeploymentService[] = TRUST_SERVICE_IDS.map((serviceId) => {
    const detail = input.serviceDetails[serviceId];
    if (detail === undefined) {
      throw new DeploymentTopologyValidationError([
        { path: `/serviceDetails/${serviceId}`, message: "missing required service detail" }
      ]);
    }
    return {
      serviceId,
      kind: SERVICE_KIND_BY_ID[serviceId],
      identity: {
        principalId: SERVICE_PRINCIPAL_ID_BY_ID[serviceId],
        oidcAudience: detail.oidcAudience,
        allowedRepositories: detail.allowedRepositories,
        allowedWorkflows: detail.allowedWorkflows,
        signingKeyId: detail.signingKeyId,
        credentialCustody: detail.credentialCustody
      },
      health: {
        endpointPath: detail.endpointPath,
        exposesSecretMaterial: false,
        failClosedOnDependencyUnavailable: true
      },
      network: {
        denyByDefaultEgress: true,
        allowedEgressHosts: detail.allowedEgressHosts
      },
      isolation: {
        sharedWithModelRunner: false,
        sharedWithReviewerJob: false,
        sharedWithUntrustedActionsJob: false,
        dedicatedCredential: true
      }
    };
  });

  const durableStores: DeploymentDurableStore[] = DURABLE_STORE_IDS.map((storeId) => {
    const detail = input.storeDetails[storeId];
    if (detail === undefined) {
      throw new DeploymentTopologyValidationError([
        { path: `/storeDetails/${storeId}`, message: "missing required store detail" }
      ]);
    }
    return {
      storeId,
      kind: DURABLE_STORE_KIND_BY_ID[storeId],
      identity: {
        namespace: detail.namespace,
        credentialId: detail.credentialId
      },
      atomicGuarantees: {
        casSupported: true,
        idempotentWrites: true,
        replayRefusal: true,
        restartContinuity: true,
        boundedJournal: { maxEntries: detail.maxEntries, enforced: true }
      },
      isolation: { dedicatedCredential: true, sharedWithModelRunner: false }
    };
  });

  const plan: DeploymentTopologyPlan = {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "DeploymentTopologyPlan",
    schemaVersion: "1.0.0",
    generatedAt: input.generatedAt,
    services,
    durableStores,
    budgets: input.budgets,
    monitoring: {
      requiredSignals: REQUIRED_MONITORING_SIGNALS,
      alertRouting: input.alertRouting
    },
    retention: input.retention,
    protections: input.protections,
    nonAuthoritative: {
      cannotInstallOrTransferApp: true,
      cannotMintOrHoldCredentials: true,
      cannotSelectLiveTarget: true,
      cannotDeployOrActivate: true
    }
  };

  const issues = validateDeploymentTopologyPlan(plan);
  if (issues.length > 0) {
    throw new DeploymentTopologyValidationError(issues);
  }
  return plan;
}

/**
 * Fails closed on an ingested deployment topology plan that omits, duplicates,
 * or adds to the closed service/store sets, that leaves a service without a
 * budget, that narrows required monitoring signals or retained artifact
 * kinds, that declares more than one retention entry for the same artifact
 * kind (a conflicting duplicate window, discarded silently by naive `Set`
 * membership alone), or that leaves a required protection scope
 * unrepresented. This validation is independent of JSON Schema shape
 * checking: closed-set completeness across array entries cannot be
 * expressed as a single JSON Schema constraint and is enforced here instead,
 * consistent with the rest of this repository's fail-closed contracts.
 *
 * Independence is checked structurally: every service's `principalId` must
 * exactly match the code-derived expectation for its `serviceId` (as `kind`
 * already is), every durable store's `kind` must exactly match the
 * code-derived expectation for its `storeId`, and `signingKeyId`/
 * `oidcAudience` across all services and `namespace`/`credentialId` across
 * all durable stores must each be unique — a plan that assigns every service
 * the same audience or every store the same namespace fails closed even
 * though every individual field is otherwise well-formed.
 */
export function validateDeploymentTopologyPlan(
  plan: DeploymentTopologyPlan
): readonly DeploymentTopologyIssue[] {
  const issues: DeploymentTopologyIssue[] = [];

  issues.push(
    ...exactSetCoverage(
      "/services",
      plan.services.map((service) => service.serviceId),
      TRUST_SERVICE_IDS
    )
  );
  issues.push(
    ...exactSetCoverage(
      "/durableStores",
      plan.durableStores.map((store) => store.storeId),
      DURABLE_STORE_IDS
    )
  );
  for (const service of plan.services) {
    if (SERVICE_KIND_BY_ID[service.serviceId] !== service.kind) {
      issues.push({
        path: `/services/${service.serviceId}/kind`,
        message: `expected kind ${SERVICE_KIND_BY_ID[service.serviceId]}, observed ${service.kind}`
      });
    }
    if (SERVICE_PRINCIPAL_ID_BY_ID[service.serviceId] !== service.identity.principalId) {
      issues.push({
        path: `/services/${service.serviceId}/identity/principalId`,
        message: `expected principalId ${SERVICE_PRINCIPAL_ID_BY_ID[service.serviceId]}, observed ${service.identity.principalId}`
      });
    }
  }
  issues.push(
    ...requireUniqueValues(
      "/services",
      plan.services.map((service) => service.identity.signingKeyId),
      "signingKeyId"
    )
  );
  issues.push(
    ...requireUniqueValues(
      "/services",
      plan.services.map((service) => service.identity.oidcAudience),
      "oidcAudience"
    )
  );

  for (const store of plan.durableStores) {
    if (DURABLE_STORE_KIND_BY_ID[store.storeId] !== store.kind) {
      issues.push({
        path: `/durableStores/${store.storeId}/kind`,
        message: `expected kind ${DURABLE_STORE_KIND_BY_ID[store.storeId]}, observed ${store.kind}`
      });
    }
  }
  issues.push(
    ...requireUniqueValues(
      "/durableStores",
      plan.durableStores.map((store) => store.identity.namespace),
      "namespace"
    )
  );
  issues.push(
    ...requireUniqueValues(
      "/durableStores",
      plan.durableStores.map((store) => store.identity.credentialId),
      "credentialId"
    )
  );

  const budgetedServiceIds = new Set(plan.budgets.map((budget) => budget.appliesToServiceId));
  for (const serviceId of TRUST_SERVICE_IDS) {
    if (!budgetedServiceIds.has(serviceId)) {
      issues.push({
        path: "/budgets",
        message: `service ${serviceId} has no declared budget`
      });
    }
  }

  issues.push(
    ...exactSetCoverage(
      "/monitoring/requiredSignals",
      plan.monitoring.requiredSignals,
      REQUIRED_MONITORING_SIGNALS
    )
  );

  issues.push(
    ...findDuplicateKeys(plan.retention, (entry) => entry.artifactKind).map((artifactKind) => ({
      path: `/retention/${artifactKind}`,
      message: `artifact kind ${artifactKind} has more than one retention entry; a conflicting duplicate retention window is never resolved by keeping only the last entry`
    }))
  );

  const retentionKinds = new Set(plan.retention.map((entry) => entry.artifactKind));
  for (const kind of RETENTION_ARTIFACT_KINDS) {
    if (!retentionKinds.has(kind)) {
      issues.push({ path: "/retention", message: `artifact kind ${kind} has no retention window` });
    }
  }
  for (const entry of plan.retention) {
    if (entry.minRetentionDays > entry.maxRetentionDays) {
      issues.push({
        path: `/retention/${entry.artifactKind}`,
        message: "minRetentionDays exceeds maxRetentionDays"
      });
    }
  }

  const protectionScopes = new Set(plan.protections.map((protection) => protection.scope));
  for (const scope of REQUIRED_PROTECTION_SCOPES) {
    if (!protectionScopes.has(scope)) {
      issues.push({ path: "/protections", message: `scope ${scope} has no declared protection` });
    }
  }

  for (const store of plan.durableStores) {
    if (store.atomicGuarantees.boundedJournal.maxEntries > 512) {
      issues.push({
        path: `/durableStores/${store.storeId}/atomicGuarantees/boundedJournal/maxEntries`,
        message: "journal bound exceeds the reviewed 512-entry capacity ceiling"
      });
    }
  }

  return issues;
}
