import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DURABLE_STORE_IDS,
  DeploymentTopologyValidationError,
  REQUIRED_MONITORING_SIGNALS,
  REQUIRED_PROTECTION_SCOPES,
  RETENTION_ARTIFACT_KINDS,
  TRUST_SERVICE_IDS,
  planDeploymentTopology,
  validateDeploymentTopologyPlan,
  type DeploymentBudget,
  type DeploymentProtection,
  type DeploymentServiceInput,
  type DeploymentStoreInput,
  type DeploymentTopologyInput,
  type DeploymentTopologyPlan,
  type DurableStoreId,
  type RetentionEntry,
  type TrustServiceId
} from "../src/deployment-topology.js";
import { validateDocument } from "../src/validation.js";

function serviceDetail(serviceId: TrustServiceId): DeploymentServiceInput {
  return {
    oidcAudience: `synthetic://test/${serviceId}`,
    allowedRepositories: ["synthetic-org/synthetic-repo"],
    allowedWorkflows: ["synthetic.yml"],
    signingKeyId: `synthetic-${serviceId}-key`,
    credentialCustody: "sign-only-broker",
    endpointPath: `/healthz/${serviceId}`,
    allowedEgressHosts: []
  };
}

function storeDetail(storeId: DurableStoreId): DeploymentStoreInput {
  return {
    maxEntries: 512,
    namespace: `synthetic-namespace-${storeId}`,
    credentialId: `synthetic-credential-${storeId}`
  };
}

function validBudgets(): readonly DeploymentBudget[] {
  return TRUST_SERVICE_IDS.map((serviceId, index) => ({
    budgetId: `budget-${index}`,
    appliesToServiceId: serviceId,
    limitKind: "requests",
    windowSeconds: 60,
    maxUnits: 100
  }));
}

function validRetention(): readonly RetentionEntry[] {
  return RETENTION_ARTIFACT_KINDS.map((artifactKind) => ({
    artifactKind,
    minRetentionDays: 30,
    maxRetentionDays: 365
  }));
}

function validProtections(): readonly DeploymentProtection[] {
  return REQUIRED_PROTECTION_SCOPES.map((scope) => ({
    protectionId: `protection-${scope}`,
    scope,
    requiresHumanApproval: true,
    allowsAutomationBypass: false
  }));
}

function validInput(): DeploymentTopologyInput {
  return {
    generatedAt: "2026-08-28T00:00:00Z",
    serviceDetails: Object.fromEntries(
      TRUST_SERVICE_IDS.map((serviceId) => [serviceId, serviceDetail(serviceId)])
    ) as Record<TrustServiceId, DeploymentServiceInput>,
    storeDetails: Object.fromEntries(
      DURABLE_STORE_IDS.map((storeId) => [storeId, storeDetail(storeId)])
    ) as Record<DurableStoreId, DeploymentStoreInput>,
    budgets: validBudgets(),
    alertRouting: { ownerRole: "security-owner", channel: "incident-queue" },
    retention: validRetention(),
    protections: validProtections()
  };
}

test("planDeploymentTopology assembles a valid closed plan with no issues", () => {
  const plan = planDeploymentTopology(validInput());
  assert.equal(plan.services.length, 8);
  assert.equal(plan.durableStores.length, 4);
  assert.deepEqual(validateDeploymentTopologyPlan(plan), []);
  const result = validateDocument("DeploymentTopologyPlan", plan);
  assert.equal(result.valid, true);
});

test("planDeploymentTopology derives a fixed, distinct principalId per service", () => {
  const plan = planDeploymentTopology(validInput());
  const principalIds = plan.services.map((service) => service.identity.principalId);
  assert.equal(new Set(principalIds).size, 8);
  for (const service of plan.services) {
    assert.equal(service.identity.principalId, `principal:${service.serviceId}`);
  }
});

test("planDeploymentTopology fails closed when a service detail is omitted", () => {
  const input = validInput();
  const details = { ...input.serviceDetails } as Record<string, DeploymentServiceInput>;
  delete details["webhook-verifier"];
  assert.throws(
    () =>
      planDeploymentTopology({
        ...input,
        serviceDetails: details as Record<TrustServiceId, DeploymentServiceInput>
      }),
    DeploymentTopologyValidationError
  );
});

test("planDeploymentTopology fails closed when a durable store detail is omitted", () => {
  const input = validInput();
  const stores = { ...input.storeDetails } as Record<string, DeploymentStoreInput>;
  delete stores["receipt-journal"];
  assert.throws(
    () =>
      planDeploymentTopology({
        ...input,
        storeDetails: stores as Record<DurableStoreId, DeploymentStoreInput>
      }),
    DeploymentTopologyValidationError
  );
});

test("planDeploymentTopology fails closed when a service has no budget", () => {
  const input = validInput();
  assert.throws(
    () =>
      planDeploymentTopology({
        ...input,
        budgets: input.budgets.filter(
          (budget) => budget.appliesToServiceId !== "github-token-broker"
        )
      }),
    DeploymentTopologyValidationError
  );
});

test("planDeploymentTopology fails closed when a retention artifact kind is omitted", () => {
  const input = validInput();
  assert.throws(
    () =>
      planDeploymentTopology({
        ...input,
        retention: input.retention.filter((entry) => entry.artifactKind !== "audit-log")
      }),
    DeploymentTopologyValidationError
  );
});

test("planDeploymentTopology fails closed on a conflicting duplicate retention window for the same artifact kind", () => {
  const input = validInput();
  const retention = validRetention();
  const firstEntry = retention[0];
  assert.ok(firstEntry !== undefined);
  assert.throws(
    () =>
      planDeploymentTopology({
        ...input,
        // A second, conflicting window for the same kind must not be silently
        // discarded by naive `Set` membership: it is a duplicate the contract
        // must reject, not a harmless repeat.
        retention: [...retention, { ...firstEntry, minRetentionDays: firstEntry.minRetentionDays + 1 }]
      }),
    DeploymentTopologyValidationError
  );
});

test("validateDeploymentTopologyPlan rejects a conflicting duplicate retention window for the same artifact kind", () => {
  const plan = planDeploymentTopology(validInput());
  const firstEntry = plan.retention[0];
  assert.ok(firstEntry !== undefined);
  const tampered: DeploymentTopologyPlan = {
    ...plan,
    retention: [...plan.retention, { ...firstEntry, minRetentionDays: firstEntry.minRetentionDays + 1 }]
  };
  const issues = validateDeploymentTopologyPlan(tampered);
  assert.ok(
    issues.some(
      (issue) => issue.path === `/retention/${firstEntry.artifactKind}` && issue.message.includes("more than one retention entry")
    )
  );
});

test("planDeploymentTopology fails closed when a required protection scope is omitted", () => {
  const input = validInput();
  assert.throws(
    () =>
      planDeploymentTopology({
        ...input,
        protections: input.protections.filter((protection) => protection.scope !== "ruleset")
      }),
    DeploymentTopologyValidationError
  );
});

test("planDeploymentTopology fails closed when all services share one signing key", () => {
  const input = validInput();
  const sharedServiceDetails = Object.fromEntries(
    TRUST_SERVICE_IDS.map((serviceId) => [
      serviceId,
      { ...serviceDetail(serviceId), signingKeyId: "shared-key-for-all-services" }
    ])
  ) as Record<TrustServiceId, DeploymentServiceInput>;
  assert.throws(
    () => planDeploymentTopology({ ...input, serviceDetails: sharedServiceDetails }),
    DeploymentTopologyValidationError
  );
});

test("planDeploymentTopology fails closed when all services share one OIDC audience", () => {
  const input = validInput();
  const sharedServiceDetails = Object.fromEntries(
    TRUST_SERVICE_IDS.map((serviceId) => [
      serviceId,
      { ...serviceDetail(serviceId), oidcAudience: "shared-audience-for-all-services" }
    ])
  ) as Record<TrustServiceId, DeploymentServiceInput>;
  assert.throws(
    () => planDeploymentTopology({ ...input, serviceDetails: sharedServiceDetails }),
    DeploymentTopologyValidationError
  );
});

test("planDeploymentTopology fails closed when all durable stores share one namespace", () => {
  const input = validInput();
  const sharedStoreDetails = Object.fromEntries(
    DURABLE_STORE_IDS.map((storeId) => [
      storeId,
      { ...storeDetail(storeId), namespace: "shared-namespace-for-all-stores" }
    ])
  ) as Record<DurableStoreId, DeploymentStoreInput>;
  assert.throws(
    () => planDeploymentTopology({ ...input, storeDetails: sharedStoreDetails }),
    DeploymentTopologyValidationError
  );
});

test("planDeploymentTopology fails closed when all durable stores share one credential", () => {
  const input = validInput();
  const sharedStoreDetails = Object.fromEntries(
    DURABLE_STORE_IDS.map((storeId) => [
      storeId,
      { ...storeDetail(storeId), credentialId: "shared-credential-for-all-stores" }
    ])
  ) as Record<DurableStoreId, DeploymentStoreInput>;
  assert.throws(
    () => planDeploymentTopology({ ...input, storeDetails: sharedStoreDetails }),
    DeploymentTopologyValidationError
  );
});

test("validateDeploymentTopologyPlan rejects an omitted service in an ingested document", () => {
  const plan = planDeploymentTopology(validInput());
  const tampered: DeploymentTopologyPlan = {
    ...plan,
    services: plan.services.filter((service) => service.serviceId !== "single-writer-reconciler")
  };
  const issues = validateDeploymentTopologyPlan(tampered);
  assert.ok(issues.some((issue) => issue.message.includes("single-writer-reconciler")));
});

test("validateDeploymentTopologyPlan rejects a duplicated service identity", () => {
  const plan = planDeploymentTopology(validInput());
  const duplicated = plan.services[0]!;
  const tampered: DeploymentTopologyPlan = {
    ...plan,
    services: [
      duplicated,
      ...plan.services.filter((service) => service.serviceId !== "installation-and-release-adapter")
    ]
  };
  const issues = validateDeploymentTopologyPlan(tampered);
  assert.ok(issues.some((issue) => issue.message.includes("duplicate entries")));
  assert.ok(issues.some((issue) => issue.message.includes("installation-and-release-adapter")));
});

test("validateDeploymentTopologyPlan rejects a service whose principalId does not match its serviceId", () => {
  const plan = planDeploymentTopology(validInput());
  const tampered: DeploymentTopologyPlan = {
    ...plan,
    services: plan.services.map((service) =>
      service.serviceId === "webhook-verifier"
        ? { ...service, identity: { ...service.identity, principalId: "principal:evidence-signer" } }
        : service
    )
  };
  const issues = validateDeploymentTopologyPlan(tampered);
  assert.ok(issues.some((issue) => issue.path === "/services/webhook-verifier/identity/principalId"));
});

test("validateDeploymentTopologyPlan rejects two services sharing one signing key", () => {
  const plan = planDeploymentTopology(validInput());
  const sharedKey = plan.services[0]!.identity.signingKeyId;
  const tampered: DeploymentTopologyPlan = {
    ...plan,
    services: plan.services.map((service, index) =>
      index === 1 ? { ...service, identity: { ...service.identity, signingKeyId: sharedKey } } : service
    )
  };
  const issues = validateDeploymentTopologyPlan(tampered);
  assert.ok(issues.some((issue) => issue.message.includes("signingKeyId")));
});

test("validateDeploymentTopologyPlan rejects two services sharing one OIDC audience", () => {
  const plan = planDeploymentTopology(validInput());
  const sharedAudience = plan.services[0]!.identity.oidcAudience;
  const tampered: DeploymentTopologyPlan = {
    ...plan,
    services: plan.services.map((service, index) =>
      index === 1 ? { ...service, identity: { ...service.identity, oidcAudience: sharedAudience } } : service
    )
  };
  const issues = validateDeploymentTopologyPlan(tampered);
  assert.ok(issues.some((issue) => issue.message.includes("oidcAudience")));
});

test("validateDeploymentTopologyPlan rejects two durable stores sharing one namespace", () => {
  const plan = planDeploymentTopology(validInput());
  const sharedNamespace = plan.durableStores[0]!.identity.namespace;
  const tampered: DeploymentTopologyPlan = {
    ...plan,
    durableStores: plan.durableStores.map((store, index) =>
      index === 1 ? { ...store, identity: { ...store.identity, namespace: sharedNamespace } } : store
    )
  };
  const issues = validateDeploymentTopologyPlan(tampered);
  assert.ok(issues.some((issue) => issue.message.includes("namespace")));
});

test("validateDeploymentTopologyPlan rejects two durable stores sharing one credential", () => {
  const plan = planDeploymentTopology(validInput());
  const sharedCredential = plan.durableStores[0]!.identity.credentialId;
  const tampered: DeploymentTopologyPlan = {
    ...plan,
    durableStores: plan.durableStores.map((store, index) =>
      index === 1 ? { ...store, identity: { ...store.identity, credentialId: sharedCredential } } : store
    )
  };
  const issues = validateDeploymentTopologyPlan(tampered);
  assert.ok(issues.some((issue) => issue.message.includes("credentialId")));
});

test("validateDeploymentTopologyPlan rejects a durable store whose kind does not match its storeId", () => {
  const plan = planDeploymentTopology(validInput());
  const tampered: DeploymentTopologyPlan = {
    ...plan,
    durableStores: plan.durableStores.map((store) =>
      store.storeId === "evidence-store" ? { ...store, kind: "operation-grant-claim-store" } : store
    )
  };
  const issues = validateDeploymentTopologyPlan(tampered);
  assert.ok(issues.some((issue) => issue.path === "/durableStores/evidence-store/kind"));
});

test("validateDeploymentTopologyPlan rejects a narrowed monitoring signal set", () => {
  const plan = planDeploymentTopology(validInput());
  const tampered: DeploymentTopologyPlan = {
    ...plan,
    monitoring: {
      ...plan.monitoring,
      requiredSignals: plan.monitoring.requiredSignals.filter(
        (signal) => signal !== "durableStoreUnavailable"
      )
    }
  };
  const issues = validateDeploymentTopologyPlan(tampered);
  assert.ok(issues.some((issue) => issue.message.includes("durableStoreUnavailable")));
  assert.equal(REQUIRED_MONITORING_SIGNALS.length, 8);
});

test("validateDeploymentTopologyPlan rejects a journal bound above the 512 ceiling", () => {
  const plan = planDeploymentTopology(validInput());
  const tampered: DeploymentTopologyPlan = {
    ...plan,
    durableStores: plan.durableStores.map((store) =>
      store.storeId === "receipt-journal"
        ? {
            ...store,
            atomicGuarantees: {
              ...store.atomicGuarantees,
              boundedJournal: { maxEntries: 513, enforced: true }
            }
          }
        : store
    )
  };
  const issues = validateDeploymentTopologyPlan(tampered);
  assert.ok(issues.some((issue) => issue.message.includes("512-entry")));
});

test("DeploymentTopologyPlan JSON Schema rejects an extra top-level field", () => {
  const plan = planDeploymentTopology(validInput());
  const result = validateDocument("DeploymentTopologyPlan", {
    ...plan,
    unexpectedField: true
  });
  assert.equal(result.valid, false);
});

test("DeploymentTopologyPlan JSON Schema rejects fewer than eight services", () => {
  const plan = planDeploymentTopology(validInput());
  const result = validateDocument("DeploymentTopologyPlan", {
    ...plan,
    services: plan.services.slice(0, 7)
  });
  assert.equal(result.valid, false);
});

test("DeploymentTopologyPlan JSON Schema rejects more than four retention entries", () => {
  const plan = planDeploymentTopology(validInput());
  const result = validateDocument("DeploymentTopologyPlan", {
    ...plan,
    retention: [...plan.retention, { ...plan.retention[0] }]
  });
  assert.equal(result.valid, false);
});
