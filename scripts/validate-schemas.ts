#!/usr/bin/env node

import { readFileSync } from "node:fs";
import process from "node:process";

import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnySchema } from "ajv";
import { parse } from "yaml";

import demoPortfolioHardeningPlanSchema from "../schemas/v1alpha1/demo-portfolio-hardening-plan.schema.json" with { type: "json" };
import demoExternalCallAssertionsSchema from "../schemas/v1alpha1/demo-external-call-assertions.schema.json" with { type: "json" };
import technicalIdentityInventorySchema from "../schemas/v1alpha1/technical-identity-inventory.schema.json" with { type: "json" };
import { workAccordBindingDigest } from "../src/binding.js";
import { digest } from "../src/canonical.js";
import { chainHead as durableStoreChainHead } from "../src/durable-substrate.js";
import { createInitialSnapshot } from "../src/kernel.js";
import { validateLifecycleGraph } from "../src/lifecycle.js";
import { compilePolicy } from "../src/policy.js";
import { validateRegistrySemantics } from "../src/registry.js";
import {
  createDemoIssueFormBindings,
  validateDemoIssueFormDefinition,
  validateDemoProjectSchemaCatalog,
  validateProjectSchemaSemantics
} from "../src/github-projects.js";
import {
  domainArtifactSchemaCount,
  validateDomainArtifactSchema
} from "../src/domain-artifact-schemas.js";
import {
  compileDomainRuntimeAuthority,
  mapTargetFreeDomainOutput,
  selectDomainProfile,
  validateDomainPackDefinition,
  type DomainProfileCatalog
} from "../src/domain-packs.js";
import {
  validateMigrationManifest
} from "../src/packaging.js";
import { validateOpenSourceAssessment } from "../src/release.js";
import {
  validateDeploymentTopologyPlan
} from "../src/deployment-topology.js";
import {
  compareGitHubAppPermissionReadback,
  validateGitHubAppRegistrationPlan
} from "../src/app-registration-plan.js";
import {
  checkReadbackDriftCoherence,
  compareAdministratorReadback,
  validateAdministratorPlan
} from "../src/administrator-plan.js";
import {
  ADMINISTRATOR_HANDOFF_CONTROLS,
  compareAdministratorHandoffReadback,
  computeAdministratorHandoffSnapshotDigest,
  planAdministratorHandoff,
  type AdministratorHandoffReadback
} from "../src/administrator-handoff.js";
import { assertDocument, validateDocument } from "../src/validation.js";
import {
  loadDemoProjectContractSets,
  loadDemoRegistrationMetadata,
  readStrictJsonFile
} from "./demo-runtime-metadata.js";

async function readJson(relativePath: string): Promise<unknown> {
  return readStrictJsonFile(relativePath);
}

const lifecycle = assertDocument(
  "LifecycleGraph",
  await readJson("config/v1alpha1/lifecycle.json")
);
const registry = assertDocument(
  "CapabilityRegistry",
  await readJson("config/v1alpha1/capability-registry.json")
);
const demoMetadata = await loadDemoRegistrationMetadata({
  baseRegistry: registry
});
const demoContractSets = await loadDemoProjectContractSets({
  baseRegistry: registry,
  lifecycle
});
const hardeningPlan = await readJson(
  "config/v1alpha1/demo-portfolio/hardening-plan.json"
);
const hardeningAjv = new Ajv2020({
  allErrors: true,
  strict: true
});
const validateHardeningPlan = hardeningAjv.compile(
  demoPortfolioHardeningPlanSchema as AnySchema
);
const validateExternalCallAssertions = hardeningAjv.compile(
  demoExternalCallAssertionsSchema as AnySchema
);
const validateTechnicalIdentityInventory = hardeningAjv.compile(
  technicalIdentityInventorySchema as AnySchema
);
const technicalIdentityInventory = await readJson(
  "config/v1alpha1/technical-identity-inventory.json"
);
const externalCallAssertionDocuments = await Promise.all(
  demoMetadata.catalog.spec.entries.map(async (entry) => ({
    demoProjectId: entry.id,
    value: await readJson(
      `tests/fixtures/demos/${entry.id}/external-call-assertions.json`
    )
  }))
);
const externalCallAssertionErrors = externalCallAssertionDocuments.flatMap(
  ({ demoProjectId, value }) =>
    validateExternalCallAssertions(value) &&
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Readonly<Record<string, unknown>>)["demoProjectId"] ===
      demoProjectId
      ? []
      : [
          `${demoProjectId} external-call assertions: ${hardeningAjv.errorsText(
            validateExternalCallAssertions.errors
          )}`
        ]
);
const policy = assertDocument(
  "ControlPolicy",
  await readJson("config/v1alpha1/policy.json")
);
const domainPack = assertDocument(
  "DomainPackPolicy",
  await readJson("config/v1alpha1/domain-pack-policy.json")
);
const phaseNames = [
  "framing",
  "planning",
  "execution",
  "verification",
  "human-review"
] as const;
const domainProfileCatalog = (await readJson(
  "config/v1alpha1/domain-profiles.json"
)) as DomainProfileCatalog;
selectDomainProfile(domainProfileCatalog, "engineering");
const domainPackIds = ["marketing", "business-operations"] as const;
const domainPackDefinitions = await Promise.all(
  domainPackIds.map(async (id) => {
    selectDomainProfile(domainProfileCatalog, id);
    const definition = validateDomainPackDefinition(
      await readJson(`config/v1alpha1/domain-packs/${id}/definition.json`)
    );
    assertDocument(
      "DomainPackPolicy",
      await readJson(`config/v1alpha1/domain-packs/${id}/policy.json`)
    );
    await Promise.all(
      phaseNames.map(async (phase) =>
        assertDocument(
          "PhaseContract",
          await readJson(
            `config/v1alpha1/domain-packs/${id}/phase-contracts/${phase}.json`
          )
        )
      )
    );
    return definition;
  })
);
const domainCompilations = await Promise.all(
  domainPackIds.map(async (id) => {
    const domainAccord = assertDocument(
      "WorkAccord",
      await readJson(`examples/${id}/work-accord.json`)
    );
    const packPolicy = assertDocument(
      "DomainPackPolicy",
      await readJson(`config/v1alpha1/domain-packs/${id}/policy.json`)
    );
    const phaseContracts = Object.fromEntries(
      await Promise.all(
        phaseNames.map(async (phase) => [
          phase,
          assertDocument(
            "PhaseContract",
            await readJson(
              `config/v1alpha1/domain-packs/${id}/phase-contracts/${phase}.json`
            )
          )
        ])
      )
    );
    const definition = domainPackDefinitions.find((candidate) => candidate.id === id)!;
    const results = phaseNames.map((phase) => ({
      phase,
      result: compilePolicy({
        enterprise: policy,
        accord: domainAccord,
        phase: phaseContracts[phase]!,
        domainPack: packPolicy,
        registry
      })
    }));
    compileDomainRuntimeAuthority({
      definition,
      policyContext: {
        enterprise: policy,
        accord: domainAccord,
        registry,
        domainPack: packPolicy,
        profileCatalog: domainProfileCatalog,
        phaseContracts
      }
    });
    return { id, results };
  })
);
const phases = await Promise.all(
  phaseNames.map(async (name) =>
    assertDocument(
      "PhaseContract",
      await readJson(`config/v1alpha1/phase-contracts/${name}.json`)
    )
  )
);
const accord = assertDocument(
  "WorkAccord",
  await readJson("examples/v1alpha1/work-accord.json")
);
const githubProject = assertDocument(
  "GitHubProjectSchema",
  await readJson("config/v1alpha1/github-project.json")
);
const demoProjectSchemas = validateDemoProjectSchemaCatalog({
  catalog: demoMetadata.catalog,
  reservations: demoMetadata.reservations,
  coreSchema: githubProject,
  entries: await Promise.all(
    demoMetadata.catalog.spec.entries.map(async (entry) => ({
      demoProjectId: entry.id,
      schema: assertDocument(
        "GitHubProjectSchema",
        await readJson(
          `config/v1alpha1/demo-projects/${entry.id}/project-schema.json`
        )
      )
    }))
  )
});
for (const binding of createDemoIssueFormBindings(demoProjectSchemas)) {
  validateDemoIssueFormDefinition(
    binding,
    parse(readFileSync(binding.issueFormPath, "utf8")) as unknown
  );
}
assertDocument(
  "CopilotRuntimePolicy",
  await readJson("config/v1alpha1/copilot-runtime-policy.json")
);
for (const relativePath of [
  "config/v1alpha1/compatibility.json",
  "config/v1alpha1/migrations.json",
  "config/v1alpha1/open-source-readiness.json",
  "examples/customer-installation/installation.json",
  "examples/customer-installation/backup-evidence.json",
  "examples/customer-installation/release-manifest.json",
  "examples/customer-installation/state.json"
]) {
  assertDocument("PackagingDocument", await readJson(relativePath));
}
validateMigrationManifest(await readJson("config/v1alpha1/migrations.json"));
validateOpenSourceAssessment(
  await readJson("config/v1alpha1/open-source-readiness.json"),
  "0.1.0"
);

const deploymentTopologyPlan = assertDocument(
  "DeploymentTopologyPlan",
  await readJson("examples/pre-app/deployment-topology.json")
);
const githubAppRegistrationPlan = assertDocument(
  "GitHubAppRegistrationPlan",
  await readJson("examples/pre-app/github-app-registration-plan.json")
);
const githubAppInstallationTargetBinding = assertDocument(
  "GitHubAppInstallationTargetBinding",
  await readJson("examples/pre-app/github-app-installation-target-binding.json")
);
const githubAppPermissionReadback = assertDocument(
  "GitHubAppPermissionReadback",
  await readJson("examples/pre-app/github-app-permission-readback.json")
);
const administratorPlan = assertDocument(
  "AdministratorPlan",
  await readJson("examples/pre-app/administrator-plan.json")
);
const administratorReadback = assertDocument(
  "AdministratorReadback",
  await readJson("examples/pre-app/administrator-readback.json")
);
const syntheticHandoffPlan = planAdministratorHandoff({
  evidenceEpoch: "2026-08-28T02:00:00Z",
  sourceDigests: {
    deploymentTopologyPlan: digest(deploymentTopologyPlan),
    githubAppRegistrationPlan: digest(githubAppRegistrationPlan),
    administratorConfigurationPlan: digest(administratorPlan),
    durableAdapterMapping:
      "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    syntheticCanaryEvidence:
      "sha256:2222222222222222222222222222222222222222222222222222222222222222",
    customerStarterCoreSelection:
      "sha256:3333333333333333333333333333333333333333333333333333333333333333",
    customerStarterDemoSelection:
      "sha256:4444444444444444444444444444444444444444444444444444444444444444",
    openSourceReadiness:
      "sha256:5555555555555555555555555555555555555555555555555555555555555555",
    licenseBytes:
      "sha256:6666666666666666666666666666666666666666666666666666666666666666"
  }
});
const syntheticHandoffTarget = {
  sourceOwner: null,
  owner:
    "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  repository:
    "sha256:2222222222222222222222222222222222222222222222222222222222222222",
  project: null,
  environment: null,
  ruleset: null,
  app: null,
  installation: null,
  billingAccount: null
} as const;
const syntheticHandoffControls = ADMINISTRATOR_HANDOFF_CONTROLS.map(
  (control) => ({
    controlId: control.controlId,
    status: "blocked-human-action" as const,
    reasonCode: "human-decision-required" as const,
    observationDigest: null
  })
);
const syntheticHandoffReadiness = {
  repository: "not-validated" as const,
  credentiallessSyntheticSandbox: "not-run" as const,
  appBackedSandbox: "blocked" as const,
  production: "customer-approval-required" as const
};
const syntheticHandoffReadbackBody = {
  apiVersion: "agentic-framework.github.com/v1alpha1",
  kind: "AdministratorHandoffReadback",
  schemaVersion: "1.0.0",
  observedAt: "2026-08-28T02:05:00Z",
  planDigest: digest(syntheticHandoffPlan),
  source: "synthetic-fixture",
  provenance: "synthetic-fixture",
  target: syntheticHandoffTarget,
  controls: syntheticHandoffControls,
  satisfiedEvidence: [],
  readiness: syntheticHandoffReadiness,
  nonAuthoritative: {
    driftProneObservation: true,
    grantsNoAuthority: true,
    authorizesNoEffect: true,
    cannotSatisfyHumanGateByItself: true
  }
} as const;
const syntheticHandoffReadback: AdministratorHandoffReadback = {
  ...syntheticHandoffReadbackBody,
  snapshotDigest: computeAdministratorHandoffSnapshotDigest(
    syntheticHandoffReadbackBody
  )
};
assertDocument("AdministratorHandoffDocument", syntheticHandoffPlan);
assertDocument("AdministratorHandoffDocument", syntheticHandoffReadback);
const syntheticHandoffComparison = compareAdministratorHandoffReadback(
  syntheticHandoffPlan,
  syntheticHandoffReadback,
  { now: "2026-08-28T02:10:00Z", maxAgeMs: 60 * 60 * 1000 }
);
if (!syntheticHandoffComparison.valid) {
  throw new TypeError(
    `synthetic administrator handoff fixture failed: ${syntheticHandoffComparison.issues
      .map((issue) => `${issue.path}: ${issue.message}`)
      .join("; ")}`
  );
}
// The durable-substrate reference store's own persisted-record contracts
// Both fixtures are synthetic and non-authoritative; the
// journal record additionally has to re-derive its own chain link, so a
// fixture whose head does not follow from its fields fails here.
const durableJournalRecord = assertDocument(
  "DurableStoreJournalRecord",
  await readJson("examples/durable-stores/journal-record.json")
);
assertDocument(
  "DurableStoreBackupManifest",
  await readJson("examples/durable-stores/backup-manifest.json")
);
const durableCompositionBackupManifest = assertDocument(
  "DurableStoreCompositionBackupManifest",
  await readJson("examples/durable-stores/composition-backup-manifest.json")
);
if (
  durableCompositionBackupManifest.backupSetId !==
  digest({
    topologyDigest: durableCompositionBackupManifest.topologyDigest,
    quiescenceDigest: digest(durableCompositionBackupManifest.quiescence),
    stores: durableCompositionBackupManifest.stores
  })
) {
  throw new TypeError(
    "durable store composition backup set ID does not match its topology and store manifests"
  );
}
const durableJournalRecordErrors =
  durableJournalRecord.head ===
  durableStoreChainHead({
    namespace: durableJournalRecord.namespace,
    key: durableJournalRecord.key,
    sequence: durableJournalRecord.sequence,
    previousHead: durableJournalRecord.previousHead,
    bodyDigest: durableJournalRecord.bodyDigest
  })
    ? []
    : ["durable store journal record head does not match its chain link"];
// Fixed, non-clock-reading freshness windows used only to validate the
// synthetic fixtures below; they bear no relationship to wall-clock time.
const preAppAppFreshness = { now: "2026-08-28T00:10:00Z", maxAgeMs: 60 * 60 * 1000 };
const preAppAdministratorFreshness = { now: "2026-08-28T01:10:00Z", maxAgeMs: 60 * 60 * 1000 };
const administratorReadbackDrift = compareAdministratorReadback(
  administratorPlan,
  administratorReadback,
  preAppAdministratorFreshness
);
const preAppErrors: string[] = [
  ...durableJournalRecordErrors,
  ...validateDeploymentTopologyPlan(deploymentTopologyPlan).map(
    (issue) => `deployment topology plan ${issue.path}: ${issue.message}`
  ),
  ...validateGitHubAppRegistrationPlan(githubAppRegistrationPlan).map(
    (issue) => `GitHub App registration plan ${issue.path}: ${issue.message}`
  ),
  ...validateAdministratorPlan(administratorPlan).map(
    (issue) => `administrator plan ${issue.path}: ${issue.message}`
  ),
  ...(compareGitHubAppPermissionReadback(
    githubAppRegistrationPlan,
    githubAppInstallationTargetBinding,
    githubAppPermissionReadback,
    preAppAppFreshness
  ).length === 0
    ? []
    : [
        "github-app-permission-readback.json unexpectedly drifts from github-app-registration-plan.json / github-app-installation-target-binding.json"
      ]),
  ...checkReadbackDriftCoherence(administratorReadback, administratorReadbackDrift).map(
    (issue) => `administrator readback ${issue.path}: ${issue.message}`
  )
];

const compilations = phases.map((phase) => ({
  phase,
  result: compilePolicy({
    enterprise: policy,
    accord: {
      ...accord,
      policy: {
        ...accord.policy,
        requestedCapabilities: phase.allowedCapabilities,
        riskClass: "high",
        privacyClass: "confidential",
        tools: [
          ...new Set(
            registry.capabilities
              .filter((capability) =>
                phase.allowedCapabilities.includes(
                  `${capability.id}@${capability.version}`
                )
              )
              .flatMap((capability) => capability.access.tools)
          )
        ],
        shellCommands: [
          ...new Set(
            registry.capabilities
              .filter((capability) =>
                phase.allowedCapabilities.includes(
                  `${capability.id}@${capability.version}`
                )
              )
              .flatMap((capability) => capability.access.shellCommands)
          )
        ],
        network: [
          ...new Set(
            registry.capabilities
              .filter((capability) =>
                phase.allowedCapabilities.includes(
                  `${capability.id}@${capability.version}`
                )
              )
              .flatMap((capability) => capability.access.networkDestinations)
          )
        ],
        mcpTools: [
          ...new Set(
            registry.capabilities
              .filter((capability) =>
                phase.allowedCapabilities.includes(
                  `${capability.id}@${capability.version}`
                )
              )
              .flatMap((capability) => capability.access.mcpTools)
          )
        ],
        secretAccess: false
      }
    },
    phase,
    domainPack,
    registry
  })
}));
const initialSnapshot = createInitialSnapshot({
  lifecycleGraphDigest: digest(lifecycle),
  workAccord: accord,
  capabilityRegistryDigest: digest(registry),
  domainPackDigest: digest(domainPack),
  policyDigest: digest(policy)
});
const snapshotValidation = validateDocument("KernelSnapshot", initialSnapshot);
const errors: string[] = [
  ...externalCallAssertionErrors,
  ...preAppErrors,
  ...(validateTechnicalIdentityInventory(technicalIdentityInventory)
    ? []
    : [
        `Technical identity inventory: ${hardeningAjv.errorsText(
          validateTechnicalIdentityInventory.errors
        )}`
      ]),
  ...(validateHardeningPlan(hardeningPlan)
    ? []
    : [
        `Demo portfolio hardening plan: ${hardeningAjv.errorsText(
          validateHardeningPlan.errors
        )}`
      ]),
  ...(domainArtifactSchemaCount() === 17
    ? []
    : ["Domain artifact schema registry must contain exactly 17 schemas"]),
  ...(demoMetadata.catalog.spec.entries.length === 4
    ? []
    : ["Demo catalog must contain exactly four entries"]),
  ...(await Promise.all(
    domainPackDefinitions.flatMap((definition) =>
      definition.slots.map(async (slot) => {
        const template = await readJson(
          `${definition.templateRoot}/${slot.template}`
        );
        return validateDomainArtifactSchema(
          definition.id,
          slot.id,
          template
        ).map((error) => `${definition.id}/${slot.id} template: ${error}`);
      })
    )
  )).flat(),
  ...domainPackDefinitions.flatMap((definition) => {
    try {
      const changes = definition.slots.map((slot) => ({
        slot: slot.id,
        content: readFileSync(
          `${definition.artifactRoot}/${slot.relativePath}`,
          "utf8"
        )
      }));
      mapTargetFreeDomainOutput({
        definition,
        repositoryId: 1,
        workItemId: `${definition.id}-example`,
        headSha: "a".repeat(40),
        output: {
          summary: "Validated synthetic domain example.",
          changes,
          findings: [],
          openQuestions: [],
          result: "drafted",
          reasonCode: null
        },
        sourceEvidence: [
          {
            purpose: "domain-source-evidence",
            sourceDigest:
              "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            content: "Synthetic internal evidence.",
            contentDigest:
              "sha256:9a88fb8236e492808038777a496d37cf0d575dbb5ab0c01868cde24e3b806724",
            classification: "internal",
            locator: "repository:synthetic-fixture",
            rightsBasis: "original",
            retentionDays: 90,
            authorityDigest:
              "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            observedAt: "2026-08-27T11:59:00Z",
            expiresAt: "2026-08-27T12:04:00Z",
            signature: {
              algorithm: "ed25519",
              keyId: "synthetic",
              value: "synthetic"
            }
          }
        ],
        classification: "internal",
        now: "2026-08-27T12:00:00Z"
      });
      return [];
    } catch (error) {
      return [
        `${definition.id} example artifacts: ${
          error instanceof Error ? error.message : String(error)
        }`
      ];
    }
  }),
  ...domainCompilations.flatMap(({ id, results }) =>
    results.flatMap(({ phase, result }) =>
      result.ok
        ? []
        : result.errors.map(
            (error) => `${id}/${phase} policy compilation: ${error}`
          )
    )
  ),
  ...validateLifecycleGraph(lifecycle).map(
    (error) => `${error.path}: ${error.message}`
  ),
  ...validateRegistrySemantics(registry).map(
    (error) => `${error.path}: ${error.message}`
  ),
  ...validateProjectSchemaSemantics(githubProject).map(
    (error) => `${error.path}: ${error.message}`
  ),
  ...(accord.binding.lifecycleGraphDigest === digest(lifecycle)
    ? []
    : ["Work Accord does not bind the loaded lifecycle graph"]),
  ...(initialSnapshot.bindingDigest === workAccordBindingDigest(accord)
    ? []
    : ["Initial snapshot does not bind the loaded Work Accord target"]),
  ...compilations.flatMap(({ phase, result }) =>
    result.ok
      ? []
      : result.errors.map(
          (error) => `${phase.phase} policy compilation: ${error}`
        )
  ),
  ...(snapshotValidation.valid
    ? []
    : snapshotValidation.errors.map(
        (error) => `initial snapshot: ${error}`
      ))
];
if (errors.length > 0) {
  for (const error of errors) {
    console.error(error);
  }
  process.exitCode = 1;
} else {
  console.log(
    `Validated versioned control schemas, the ${demoMetadata.catalog.spec.entries.length}-entry demo catalog, ${demoProjectSchemas.entries.length} Project UX schemas and issue forms, ${demoContractSets.length} installed demo contract sets, ${demoMetadata.runtimeBindings.length} installed demo runtime bindings, ${externalCallAssertionDocuments.length} closed external-call assertion fixtures, the pre-App deployment topology/App-registration/administrator/handoff plan and readback fixtures, the durable-store journal-record, single-store backup, and composition-backup fixtures, and the portfolio hardening plan.`
  );
}
