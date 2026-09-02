import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { parse } from "yaml";

import catalogDocument from "../config/v1alpha1/demo-portfolio/catalog.json" with { type: "json" };
import reservationsDocument from "../config/v1alpha1/demo-portfolio/identity-reservations.json" with { type: "json" };
import coreProjectSchemaDocument from "../config/v1alpha1/github-project.json" with { type: "json" };
import {
  DEMO_PROJECT_FIELD_VOCABULARY,
  DEMO_PROJECTION_VOCABULARY,
  createDemoContract,
  createDemoIssueFormBindings,
  digest,
  exportDemoProjectCatalogConfiguration,
  importProjectConfiguration,
  importDemoProjectCatalogConfiguration,
  planDemoProjectCatalogSetup,
  planProjectSetup,
  validateDemoIssueFormDefinition,
  validateDemoIssueIntake,
  validateDemoProjectSchemaCatalog,
  type DemoGitHubProjectSchemaEntry,
  type DemoIssueFormBinding,
  type DemoIssueIntakeDecision,
  type DemoProjectId,
  type GitHubProjectBinding,
  type GitHubProjectSchema,
  type LiveGitHubProject,
  type ValidatedDemoProjectSchemaCatalog
} from "../src/index.js";

const ROOT = process.cwd();
const BINDING_TIME = "2026-08-29T17:50:00.000Z";
const EVALUATED_AT = "2026-08-29T18:00:00.000Z";

async function readJson(relativePath: string): Promise<unknown> {
  return JSON.parse(
    await readFile(path.resolve(ROOT, relativePath), "utf8")
  ) as unknown;
}

async function projectSchemas(): Promise<ValidatedDemoProjectSchemaCatalog> {
  const entries = await Promise.all(
    catalogDocument.spec.entries.map(async (entry) => ({
      demoProjectId: entry.id as DemoProjectId,
      schema: (await readJson(
        `config/v1alpha1/demo-projects/${entry.id}/project-schema.json`
      )) as GitHubProjectSchema
    }))
  );
  return validateDemoProjectSchemaCatalog({
    catalog: catalogDocument,
    reservations: reservationsDocument,
    coreSchema: coreProjectSchemaDocument,
    entries
  });
}

async function liveProjects(): Promise<
  readonly {
    readonly demoProjectId: DemoProjectId;
    readonly live: LiveGitHubProject;
  }[]
> {
  return Promise.all(
    catalogDocument.spec.entries.map(async (entry) => ({
      demoProjectId: entry.id as DemoProjectId,
      live: (await readJson(
        `tests/fixtures/project-ux/live/${entry.id}.json`
      )) as LiveGitHubProject
    }))
  );
}

function blockedCode(decision: DemoIssueIntakeDecision): string {
  assert.equal(decision.status, "blocked");
  return decision.status === "blocked" ? decision.code : "unexpected-ready";
}

async function intakeFixture() {
  const schemas = await projectSchemas();
  const schemaEntry = schemas.entries.find(
    (entry) => entry.demoProjectId === "feature-delivery"
  )!;
  const live = (await liveProjects()).find(
    (entry) => entry.demoProjectId === "feature-delivery"
  )!.live;
  const setupPlan = planProjectSetup({
    schema: schemaEntry.schema,
    live,
    evaluatedAt: BINDING_TIME
  });
  assert.notEqual(setupPlan.binding, null);
  const projectBinding = setupPlan.binding!;
  const catalogEntry = schemas.catalog.spec.entries.find(
    (entry) => entry.id === "feature-delivery"
  )!;
  const profile = createDemoContract("DemoProjectProfile", {
    demoProjectId: "feature-delivery",
    catalogDigest: schemas.catalog.contentDigest,
    identityReservationsDigest: schemas.reservations.contentDigest,
    title: catalogEntry.title,
    description: "Synthetic Feature Delivery intake profile.",
    defaultDepthProfile: "D2",
    allowedDepthProfiles: ["D1", "D2"],
    repositoryBindingDigest: digest("trusted-feature-repository"),
    projectBindingDigest: digest(projectBinding),
    workAccordTemplateDigest: digest("feature-work-accord-template"),
    journeyDefinitionRef: catalogEntry.journeyDefinitionRef,
    stageAgentBindingsRef: catalogEntry.stageAgentBindingsRef,
    capabilityShardRef: catalogEntry.capabilityShardRef,
    activationProfileRef: catalogEntry.activationProfileRef,
    projectionMappingRef: catalogEntry.projectionMappingRef
  });
  const activation = createDemoContract("DemoActivationProfile", {
    demoProjectId: "feature-delivery",
    catalogDigest: schemas.catalog.contentDigest,
    projectProfileDigest: profile.contentDigest,
    stageAgentBindingsDigest: digest("feature-stage-bindings"),
    capabilityShardDigest: digest("feature-capabilities"),
    enabled: true,
    authorityEpoch: 1,
    revocationGeneration: 0,
    allowedSubmitterIds: [42],
    allowedSource: "issue-form",
    consentField: "demo-consent",
    consentRequired: true,
    leaseTemplate: {
      maxCalls: 5,
      maxTokens: 10000,
      maxCostUnits: 100,
      maxDurationMs: 600000,
      maxRetries: 1,
      maxParallel: 1
    },
    validFrom: "2026-08-29T17:00:00Z",
    expiresAt: "2026-08-29T19:00:00Z",
    signingKeyId: "synthetic-activation-key"
  });
  const binding = createDemoIssueFormBindings(schemas).find(
    (candidate) => candidate.demoProjectId === "feature-delivery"
  )!;
  const submission = {
    desiredOutcome: "Produce a bounded feature patch.",
    repositoryHint: "untrusted/example-repository",
    constraints: "Keep all changes inside the reviewed path set.",
    acceptanceEvidence: "Targeted tests and exact-head human review.",
    depthProfile: "D2",
    consent: true
  } as const;
  const input = {
    catalog: catalogDocument,
    reservations: reservationsDocument,
    coreSchema: coreProjectSchemaDocument,
    schema: schemaEntry.schema,
    binding,
    profile,
    activation,
    repositoryBindingDigest: profile.spec.repositoryBindingDigest,
    projectBinding,
    submission,
    submitterId: 42,
    issueNodeId: "I_synthetic_feature_intake",
    evaluatedAt: EVALUATED_AT,
    maxProjectBindingAgeMs: 15 * 60 * 1000
  } as const;
  return {
    schemas,
    schemaEntry,
    live,
    projectBinding,
    profile,
    activation,
    binding,
    submission,
    input
  };
}

test("the Project UX catalog is exactly the four Foundation schemas", async () => {
  const schemas = await projectSchemas();
  assert.deepEqual(
    schemas.entries.map((entry) => entry.demoProjectId),
    [
      "app-modernization",
      "feature-delivery",
      "security-dependency-remediation",
      "adaptive-delivery"
    ]
  );
  const coreStage = (
    coreProjectSchemaDocument as GitHubProjectSchema
  ).fields.find((field) => field.key === "stage")!;
  for (const entry of schemas.entries) {
    assert.equal(Object.isFrozen(entry), true);
    assert.equal(Object.isFrozen(entry.schema), true);
    assert.equal(Object.isFrozen(entry.schema.project), true);
    assert.equal(Object.isFrozen(entry.schema.fields), true);
    assert.deepEqual(
      entry.schema.fields.map((field) => ({
        key: field.key,
        name: field.name
      })),
      DEMO_PROJECT_FIELD_VOCABULARY
    );
    assert.deepEqual(
      entry.schema.fields.find((field) => field.key === "stage")?.options,
      coreStage.options
    );
    assert.equal(entry.schema.fields.length, 15);
    assert.equal(entry.schema.projections.length, 14);
    assert.equal(
      entry.schema.projections.find((projection) => projection.slot === "stage")
        ?.writeOrder,
      DEMO_PROJECTION_VOCABULARY.length
    );
    assert.deepEqual(
      entry.schema.projections.find(
        (projection) => projection.slot === "target-repository"
      ),
      {
        slot: "target-repository",
        fieldKey: "target-repository",
        source: "trusted-binding",
        displayOnly: true,
        writeOrder: 8
      }
    );
    assert.equal(JSON.stringify(entry.schema).includes("nodeId"), false);
  }
});

test("Journey Stage options match every reserved stage and control presentation", async () => {
  const schemas = await projectSchemas();
  for (const entry of schemas.entries) {
    const reserved = reservationsDocument.spec.projects.find(
      (project) => project.demoProjectId === entry.demoProjectId
    )!;
    assert.deepEqual(
      entry.schema.fields
        .find((field) => field.key === "journey-stage")
        ?.options.map((option) => ({
          key: option.key,
          name: option.name
        })),
      [...reserved.journeyStages, ...reserved.controlStages].map((stage) => ({
        key: stage.stageId,
        name: stage.displayName
      }))
    );
  }
});

test("Project UX schemas reject projection, field, and catalog substitution", async () => {
  const schemas = await projectSchemas();
  const entries: DemoGitHubProjectSchemaEntry[] = schemas.entries.map(
    (entry) =>
      entry.demoProjectId === "feature-delivery"
        ? {
            ...entry,
            schema: {
              ...entry.schema,
              projections: entry.schema.projections.map((projection) =>
                projection.slot === "target-repository"
                  ? { ...projection, source: "project-profile" }
                  : projection
              )
            }
          }
        : entry
  );
  assert.throws(
    () =>
      validateDemoProjectSchemaCatalog({
        catalog: catalogDocument,
        reservations: reservationsDocument,
        coreSchema: coreProjectSchemaDocument,
        entries
      }),
    /exact Foundation projection/u
  );
  assert.throws(
    () =>
      validateDemoProjectSchemaCatalog({
        catalog: catalogDocument,
        reservations: reservationsDocument,
        coreSchema: coreProjectSchemaDocument,
        entries: [...schemas.entries].reverse()
      }),
    /catalog order/u
  );
  const forged = {
    ...schemas,
    entries: schemas.entries.map((entry) =>
      entry.demoProjectId === "app-modernization"
        ? {
            ...entry,
            schema: {
              ...entry.schema,
              owner: { ...entry.schema.owner, login: "attacker-org" },
              project: {
                ...entry.schema.project,
                title: "Attacker Project"
              }
            }
          }
        : entry
    )
  } as ValidatedDemoProjectSchemaCatalog;
  const forgedLive = (await liveProjects()).map((entry) =>
    entry.demoProjectId === "app-modernization"
      ? {
          ...entry,
          live: {
            ...entry.live,
            owner: { ...entry.live.owner, login: "attacker-org" },
            project: {
              ...entry.live.project!,
              title: "Attacker Project"
            }
          }
        }
      : entry
  );
  assert.throws(
    () =>
      planDemoProjectCatalogSetup({
        projectSchemas: forged,
        liveProjects: forgedLive,
        evaluatedAt: BINDING_TIME
      }),
    /exact Foundation projection/u
  );
});

test("the four issue forms are exact static bindings with bounded data-only fields", async () => {
  const schemas = await projectSchemas();
  const bindings = createDemoIssueFormBindings(schemas);
  assert.equal(bindings.length, 4);
  for (const binding of bindings) {
    const form = parse(
      await readFile(path.resolve(ROOT, binding.issueFormPath), "utf8")
    ) as unknown;
    validateDemoIssueFormDefinition(binding, form);
    const serialized = JSON.stringify(form);
    assert.equal(serialized.includes('"id":"project-profile"'), false);
    assert.equal(serialized.includes("never selects the trusted repository"), true);
    assert.equal(serialized.includes("fixed trusted budget"), true);
  }
});

test("catalog setup, export, and import stay deterministic and dry-run", async () => {
  const schemas = await projectSchemas();
  const plan = planDemoProjectCatalogSetup({
    projectSchemas: schemas,
    liveProjects: await liveProjects(),
    evaluatedAt: BINDING_TIME
  });
  assert.equal(plan.mode, "dry-run");
  assert.equal(plan.valid, true);
  assert.ok(plan.entries.every((entry) => entry.plan.actions.length === 0));
  assert.ok(plan.entries.every((entry) => entry.plan.binding !== null));

  const serialized = exportDemoProjectCatalogConfiguration({
    projectSchemas: schemas,
    bindings: plan.entries.map((entry) => ({
      demoProjectId: entry.demoProjectId,
      binding: entry.plan.binding
    }))
  });
  const imported = importDemoProjectCatalogConfiguration({
    serialized,
    catalog: catalogDocument,
    reservations: reservationsDocument,
    coreSchema: coreProjectSchemaDocument
  });
  assert.equal(imported.demoCatalogDigest, catalogDocument.contentDigest);
  assert.equal(imported.entries.length, 4);

  const driftedLive = (await liveProjects()).map((entry) =>
    entry.demoProjectId === "app-modernization"
      ? {
          ...entry,
          live: {
            ...entry.live,
            fields: entry.live.fields.filter(
              (field) => field.name !== "Current Stage Agent"
            )
          }
        }
      : entry
  );
  const driftPlan = planDemoProjectCatalogSetup({
    projectSchemas: schemas,
    liveProjects: driftedLive,
    evaluatedAt: BINDING_TIME
  });
  const actions = driftPlan.entries.flatMap((entry) => entry.plan.actions);
  assert.equal(actions.length, 1);
  assert.ok(actions.every((action) => action.requiresHumanAdmin));

  for (const options of [
    [...driftedLive[1]!.live.fields
      .find((field) => field.name === "Journey Stage")!
      .options].reverse(),
    [
      ...driftedLive[1]!.live.fields.find(
        (field) => field.name === "Journey Stage"
      )!.options,
      { nodeId: "PVTO_feature_unauthorized", name: "Unauthorized Stage" }
    ]
  ]) {
    const optionDrift = (await liveProjects()).map((entry) =>
      entry.demoProjectId === "feature-delivery"
        ? {
            ...entry,
            live: {
              ...entry.live,
              fields: entry.live.fields.map((field) =>
                field.name === "Journey Stage"
                  ? { ...field, options }
                  : field
              )
            }
          }
        : entry
    );
    const optionPlan = planDemoProjectCatalogSetup({
      projectSchemas: schemas,
      liveProjects: optionDrift,
      evaluatedAt: BINDING_TIME
    });
    const featurePlan = optionPlan.entries.find(
      (entry) => entry.demoProjectId === "feature-delivery"
    )!.plan;
    assert.equal(featurePlan.binding, null);
    assert.deepEqual(
      featurePlan.actions.map((action) =>
        action.type === "reconcile-drift" ? action.path : action.type
      ),
      ["/fields/journey-stage/options"]
    );
    assert.ok(
      featurePlan.actions.every((action) => action.requiresHumanAdmin)
    );
  }

  const mixedDrift = (await liveProjects()).map((entry) =>
    entry.demoProjectId === "feature-delivery"
      ? {
          ...entry,
          live: {
            ...entry.live,
            fields: entry.live.fields.map((field) =>
              field.name === "Journey Stage"
                ? {
                    ...field,
                    options: [
                      ...field.options.filter(
                        (option) => option.name !== "Build"
                      ),
                      {
                        nodeId: "PVTO_feature_unauthorized",
                        name: "Unauthorized Stage"
                      }
                    ]
                  }
                : field
            )
          }
        }
      : entry
  );
  const mixedPlan = planDemoProjectCatalogSetup({
    projectSchemas: schemas,
    liveProjects: mixedDrift,
    evaluatedAt: BINDING_TIME
  }).entries.find(
    (entry) => entry.demoProjectId === "feature-delivery"
  )!.plan;
  assert.equal(mixedPlan.binding, null);
  assert.deepEqual(
    mixedPlan.actions.map((action) => {
      if (action.type === "create-option") {
        return `${action.type}:${action.name}`;
      }
      if (action.type === "reconcile-drift") return action.path;
      return action.type;
    }),
    ["create-option:Build", "/fields/journey-stage/options"]
  );
  assert.ok(mixedPlan.actions.every((action) => action.requiresHumanAdmin));
});

test("catalog setup CLI rejects apply and execute before loading inputs", () => {
  for (const flag of ["--apply", "--execute"]) {
    const result = spawnSync(
      process.execPath,
      [
        "dist/scripts/github-setup.js",
        "plan",
        "--catalog",
        "does-not-exist.json",
        flag
      ],
      { cwd: ROOT, encoding: "utf8" }
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /dry-run only/u);
    assert.doesNotMatch(result.stderr, /ENOENT/u);
  }
});

test("Project configuration and catalog CLI reject duplicate JSON keys", async () => {
  assert.throws(
    () =>
      importProjectConfiguration(
        '{"format":"invalid","format":"agentic-framework.github-project/v1","schema":{},"binding":null}'
      ),
    /duplicate JSON object key/u
  );
  const directory = await mkdtemp(path.join(tmpdir(), "project-ux-"));
  try {
    const catalogPath = path.join(directory, "catalog.json");
    const catalogText = await readFile(
      path.resolve(ROOT, "config/v1alpha1/demo-portfolio/catalog.json"),
      "utf8"
    );
    await writeFile(
      catalogPath,
      catalogText.replace(
        '"schemaVersion": "1.0.0",',
        '"schemaVersion": "9.9.9",\n  "schemaVersion": "1.0.0",'
      ),
      "utf8"
    );
    const result = spawnSync(
      process.execPath,
      [
        "dist/scripts/github-setup.js",
        "validate",
        "--catalog",
        catalogPath
      ],
      { cwd: ROOT, encoding: "utf8" }
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /duplicate JSON object key/u);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("valid issue intake remains Activation Pending and grants no authority", async () => {
  const fixture = await intakeFixture();
  const decision = validateDemoIssueIntake(fixture.input);
  assert.equal(decision.status, "ready-for-kernel-activation");
  if (decision.status === "ready-for-kernel-activation") {
    assert.equal(decision.state, "ACTIVATION_PENDING");
    assert.equal(
      decision.normalizedSubmission.repositoryHint,
      "untrusted/example-repository"
    );
    assert.equal(
      decision.repositoryBindingDigest,
      fixture.profile.spec.repositoryBindingDigest
    );
    assert.deepEqual(decision.authority, {
      credentials: "denied",
      budgetReservation: "denied",
      inference: "denied",
      issueCreation: "denied"
    });
  }
});

test("all required intake failures stop before credentials, reservation, or inference", async () => {
  const fixture = await intakeFixture();
  const disabledActivation = createDemoContract("DemoActivationProfile", {
    ...fixture.activation.spec,
    enabled: false
  });
  const zeroBudgetActivation = createDemoContract("DemoActivationProfile", {
    ...fixture.activation.spec,
    leaseTemplate: {
      ...fixture.activation.spec.leaseTemplate,
      maxCalls: 0
    }
  });
  const staleBinding: GitHubProjectBinding = {
    ...fixture.projectBinding,
    validatedAt: "2026-08-29T16:00:00.000Z"
  };
  const mismatchedForm: DemoIssueFormBinding = {
    ...fixture.binding,
    projectProfileRef:
      "config/v1alpha1/demo-projects/app-modernization/project-profile.json"
  };
  const cases: readonly {
    readonly expected: string;
    readonly input: Parameters<typeof validateDemoIssueIntake>[0];
  }[] = [
    {
      expected: "FORM_PROFILE_MISMATCH",
      input: { ...fixture.input, binding: mismatchedForm }
    },
    {
      expected: "CONSENT_REQUIRED",
      input: {
        ...fixture.input,
        submission: { ...fixture.submission, consent: false }
      }
    },
    {
      expected: "ACTIVATION_PROFILE_DISABLED",
      input: { ...fixture.input, activation: disabledActivation }
    },
    {
      expected: "SUBMITTER_UNAUTHORIZED",
      input: { ...fixture.input, submitterId: 99 }
    },
    {
      expected: "REPOSITORY_BINDING_UNRESOLVED",
      input: { ...fixture.input, repositoryBindingDigest: null }
    },
    {
      expected: "REPOSITORY_BINDING_STALE",
      input: {
        ...fixture.input,
        repositoryBindingDigest: digest("substituted-repository")
      }
    },
    {
      expected: "PROJECT_BINDING_STALE",
      input: { ...fixture.input, projectBinding: staleBinding }
    },
    {
      expected: "CONTENT_MALFORMED",
      input: {
        ...fixture.input,
        submission: { ...fixture.submission, unexpected: "field" }
      }
    },
    {
      expected: "CONTENT_OVERSIZED",
      input: {
        ...fixture.input,
        submission: {
          ...fixture.submission,
          desiredOutcome: "x".repeat(2049)
        }
      }
    },
    {
      expected: "BUDGET_MISSING",
      input: { ...fixture.input, activation: null }
    },
    {
      expected: "BUDGET_MISSING",
      input: { ...fixture.input, activation: zeroBudgetActivation }
    },
    {
      expected: "DEPTH_PROFILE_NOT_ALLOWED",
      input: {
        ...fixture.input,
        submission: { ...fixture.submission, depthProfile: "D3" }
      }
    },
    {
      expected: "ACTIVATION_WINDOW_INVALID",
      input: {
        ...fixture.input,
        evaluatedAt: "2026-08-29T20:00:00.000Z",
        maxProjectBindingAgeMs: 3 * 60 * 60 * 1000
      }
    }
  ];
  for (const testCase of cases) {
    const decision = validateDemoIssueIntake(testCase.input);
    assert.equal(blockedCode(decision), testCase.expected);
    assert.deepEqual(decision.authority, {
      credentials: "denied",
      budgetReservation: "denied",
      inference: "denied",
      issueCreation: "denied"
    });
  }
});

test("missing information produces one typed blocked artifact without prose heuristics", async () => {
  const fixture = await intakeFixture();
  const input = {
    ...fixture.input,
    submission: {
      ...fixture.submission,
      acceptanceEvidence: ""
    }
  };
  const first = validateDemoIssueIntake(input);
  const second = validateDemoIssueIntake(input);
  assert.equal(blockedCode(first), "MISSING_INFORMATION");
  assert.equal(first.status, "blocked");
  assert.equal(second.status, "blocked");
  if (first.status === "blocked" && second.status === "blocked") {
    assert.equal(first.missingInformation?.kind, "DemoMissingInformationRequest");
    assert.equal(
      first.missingInformation?.spec.field,
      "acceptance-evidence"
    );
    assert.equal(
      first.missingInformation?.contentDigest,
      second.missingInformation?.contentDigest
    );
    assert.equal(
      JSON.stringify(first.missingInformation).includes("issue-create"),
      false
    );
  }

  const punctuationFree = validateDemoIssueIntake({
    ...fixture.input,
    submission: {
      ...fixture.submission,
      desiredOutcome: "Produce one bounded change",
      constraints: "None",
      acceptanceEvidence: "Tests pass"
    }
  });
  assert.equal(punctuationFree.status, "ready-for-kernel-activation");
});

test("seeded issues are synthetic and use the exact fourteen display fields", async () => {
  const expectedFields = DEMO_PROJECTION_VOCABULARY.map((field) => field.name);
  for (const entry of catalogDocument.spec.entries) {
    const seed = (await readJson(
      `examples/demo-projects/${entry.id}/seeded-issue.json`
    )) as {
      readonly synthetic: boolean;
      readonly demoProjectId: string;
      readonly formSubmission: Readonly<Record<string, unknown>>;
      readonly projection: Readonly<Record<string, unknown>>;
      readonly blockingEvidence?: {
        readonly apiVersion: string;
        readonly kind: string;
        readonly schemaVersion: string;
        readonly contentDigest: `sha256:${string}`;
        readonly spec: {
          readonly demoProjectId: string;
          readonly issueNodeId: string;
          readonly field: string;
          readonly request: string;
          readonly evidence: {
            readonly kind: string;
            readonly formId: string;
            readonly submissionDigest: `sha256:${string}`;
          };
        };
      };
    };
    assert.equal(seed.synthetic, true);
    assert.equal(seed.demoProjectId, entry.id);
    assert.deepEqual(Object.keys(seed.projection), expectedFields);
    assert.equal(JSON.stringify(seed).includes("example/"), true);
    if (entry.id === "security-dependency-remediation") {
      assert.notEqual(seed.blockingEvidence, undefined);
      const evidence = seed.blockingEvidence!;
      const { contentDigest, ...envelope } = evidence;
      assert.equal(evidence.apiVersion, "agentic-framework.github.com/v1alpha1");
      assert.equal(evidence.kind, "DemoMissingInformationRequest");
      assert.equal(evidence.schemaVersion, "1.0.0");
      assert.equal(evidence.spec.demoProjectId, entry.id);
      assert.equal(evidence.spec.evidence.formId, entry.id);
      assert.equal(
        evidence.spec.evidence.submissionDigest,
        digest(seed.formSubmission)
      );
      assert.equal(contentDigest, digest(envelope));
    }
  }
});
