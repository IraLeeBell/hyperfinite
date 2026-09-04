import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

import catalog from "../config/v1alpha1/demo-portfolio/catalog.json" with { type: "json" };
import targetManifest from "../config/v1alpha1/demo-portfolio/project-targets.example.json" with { type: "json" };
import reservations from "../config/v1alpha1/demo-portfolio/identity-reservations.json" with { type: "json" };
import coreSchema from "../config/v1alpha1/github-project.json" with { type: "json" };

import {
  canonicalJson,
  createDisplayOnlyProjectTargetManifest,
  createDemoProjectTargetManifest,
  planVerifiedDemoProjectBootstrap,
  planDisplayOnlyProjectColorReconciliation,
  planProjectSetup,
  readbackDisplayOnlyProjectColorReconciliation,
  reconcileVerifiedDemoProjectBootstrap,
  digest,
  validateDemoProjectSchemaCatalog,
  type DemoProjectId,
  type Digest,
  type GitHubProjectDisplayColorPlan,
  type GitHubProjectDisplaySnapshot,
  type GitHubProjectDisplayTargetManifest,
  type GitHubProjectSchema,
  type LiveDemoProjectAdminSnapshot,
  type LiveGitHubProject,
  type VerifiedDemoProjectBootstrapPlan
} from "../src/index.js";

const OBSERVED_AT = "2026-08-30T16:00:00.000Z";
const EVALUATED_AT = "2026-08-30T16:01:00.000Z";
const RECONCILED_AT = "2026-08-30T16:05:00.000Z";
const DISPLAY_OBSERVED_AT = "2026-09-03T23:53:44.000Z";
const DISPLAY_MANIFEST_AT = "2026-09-03T23:54:00.000Z";
const DISPLAY_PLAN_AT = "2026-09-03T23:55:00.000Z";
const DISPLAY_READBACK_OBSERVED_AT = "2026-09-03T23:56:00.000Z";
const DISPLAY_READBACK_AT = "2026-09-03T23:57:00.000Z";
const DISPLAY_MAX_AGE_MS = 5 * 60 * 1000;
const TARGET_MANIFEST_DIGEST = targetManifest.contentDigest as Digest;
const BUILT_INS = [
  ["Title", "TITLE"],
  ["Assignees", "ASSIGNEES"],
  ["Status", "SINGLE_SELECT"],
  ["Labels", "LABELS"],
  ["Linked pull requests", "LINKED_PULL_REQUESTS"],
  ["Milestone", "MILESTONE"],
  ["Repository", "REPOSITORY"],
  ["Reviewers", "REVIEWERS"],
  ["Parent issue", "PARENT_ISSUE"],
  ["Sub-issues progress", "SUB_ISSUES_PROGRESS"],
  ["Created", "CREATED"],
  ["Updated", "UPDATED"],
  ["Closed", "CLOSED"]
] as const;

async function schemas() {
  return validateDemoProjectSchemaCatalog({
    catalog,
    reservations,
    coreSchema,
    entries: await Promise.all(
      catalog.spec.entries.map(async (entry) => ({
        demoProjectId: entry.id as DemoProjectId,
        schema: JSON.parse(
          await readFile(
            `config/v1alpha1/demo-projects/${entry.id}/project-schema.json`,
            "utf8"
          )
        ) as GitHubProjectSchema
      }))
    )
  });
}

type DisplaySnapshots = readonly {
  readonly demoProjectId: DemoProjectId;
  readonly snapshot: GitHubProjectDisplaySnapshot;
}[];

async function displaySnapshots(): Promise<DisplaySnapshots> {
  return Promise.all(
    catalog.spec.entries.map(async (entry) => ({
      demoProjectId: entry.id as DemoProjectId,
      snapshot: JSON.parse(
        await readFile(
          `tests/fixtures/project-display-colors/live-shaped/${entry.id}.display.json`,
          "utf8"
        )
      ) as GitHubProjectDisplaySnapshot
    }))
  );
}

function withExpectedDisplayColors(
  projectSchemas: Awaited<ReturnType<typeof schemas>>,
  snapshots: DisplaySnapshots,
  observedAt: string
): DisplaySnapshots {
  return snapshots.map((entry, projectIndex) => ({
    demoProjectId: entry.demoProjectId,
    snapshot: {
      ...entry.snapshot,
      observedAt,
      customFields: entry.snapshot.customFields.map((field, fieldIndex) => ({
        ...field,
        options: field.options.map((option, optionIndex) => ({
          ...option,
          color:
            projectSchemas.entries[projectIndex]!.schema.fields[fieldIndex]!
              .options[optionIndex]!.color
        }))
      }))
    }
  }));
}

function displayManifest(
  projectSchemas: Awaited<ReturnType<typeof schemas>>,
  snapshots: DisplaySnapshots
): GitHubProjectDisplayTargetManifest {
  return createDisplayOnlyProjectTargetManifest({
    projectSchemas,
    snapshots,
    generatedAt: DISPLAY_MANIFEST_AT,
    maxSnapshotAgeMs: DISPLAY_MAX_AGE_MS
  });
}

function displayPlan(
  projectSchemas: Awaited<ReturnType<typeof schemas>>,
  manifest: GitHubProjectDisplayTargetManifest,
  snapshots: DisplaySnapshots
): GitHubProjectDisplayColorPlan {
  return planDisplayOnlyProjectColorReconciliation({
    targetManifest: manifest,
    confirmedTargetManifestDigest: manifest.contentDigest,
    projectSchemas,
    snapshots,
    evaluatedAt: DISPLAY_PLAN_AT,
    maxSnapshotAgeMs: DISPLAY_MAX_AGE_MS
  });
}

function rehashDisplayManifest(
  manifest: GitHubProjectDisplayTargetManifest,
  targets: GitHubProjectDisplayTargetManifest["spec"]["targets"]
): GitHubProjectDisplayTargetManifest {
  const payload = {
    apiVersion: manifest.apiVersion,
    kind: manifest.kind,
    schemaVersion: manifest.schemaVersion,
    authoritative: manifest.authoritative,
    displayOnly: manifest.displayOnly,
    spec: {
      ...manifest.spec,
      targets
    }
  };
  return {
    ...payload,
    contentDigest: digest(payload)
  };
}

function rehashDisplayPlan(
  plan: GitHubProjectDisplayColorPlan,
  actions: readonly unknown[],
  overrides: Readonly<Record<string, unknown>> = {}
): unknown {
  const payload = {
    apiVersion: plan.apiVersion,
    kind: plan.kind,
    schemaVersion: plan.schemaVersion,
    authoritative: plan.authoritative,
    displayOnly: plan.displayOnly,
    mode: plan.mode,
    evaluatedAt: plan.evaluatedAt,
    maxSnapshotAgeMs: plan.maxSnapshotAgeMs,
    targetManifestDigest: plan.targetManifestDigest,
    projects: plan.projects,
    actions,
    ...overrides
  };
  return {
    ...payload,
    planDigest: digest(payload)
  };
}

function issueBindings() {
  return catalog.spec.entries.map((entry) => ({
    demoProjectId: entry.id as DemoProjectId,
    scenarioIssueNodeId: `ISSUE_SCENARIO_${entry.id}`,
    additionalIssueNodeIds: []
  }));
}

function initialSnapshots(): readonly {
  readonly demoProjectId: DemoProjectId;
  readonly snapshot: LiveDemoProjectAdminSnapshot;
}[] {
  return targetManifest.spec.projects.map((target) => ({
    demoProjectId: target.demoProjectId as DemoProjectId,
    snapshot: {
      observedAt: OBSERVED_AT,
      owner: {
        type: "organization" as const,
        login: targetManifest.spec.owner.login,
        nodeId: targetManifest.spec.owner.nodeId
      },
      repository: targetManifest.spec.repository,
      project: {
        number: target.number,
        nodeId: target.nodeId,
        title: target.title,
        shortDescription: null,
        readme: null,
        public: false,
        closed: false
      },
      linkedRepositories: [targetManifest.spec.repository],
      itemCount: 0,
      items: [],
      views: [
        {
          nodeId: target.viewNodeId,
          name: "View 1",
          layout: "BOARD_LAYOUT",
          visibleFieldNames: [
            "Title",
            "Assignees",
            "Status",
            "Linked pull requests",
            "Sub-issues progress"
          ],
          groupByFieldNames: []
        }
      ],
      fields: BUILT_INS.map(([name, dataType], index) => ({
        nodeId: `BUILTIN_${target.number}_${index}`,
        name,
        dataType,
        options:
          name === "Status"
            ? ["Todo", "In Progress", "Done"].map((option, optionIndex) => ({
                nodeId: `STATUS_${target.number}_${optionIndex}`,
                name: option,
                color: "GRAY",
                description: ""
              }))
            : []
      }))
    }
  }));
}

function postSnapshot(
  plan: VerifiedDemoProjectBootstrapPlan,
  schema: GitHubProjectSchema,
  source: (ReturnType<typeof initialSnapshots>)[number]
): LiveDemoProjectAdminSnapshot {
  const projectNodeId = source.snapshot.project.nodeId;
  const description = plan.operations.find(
    (operation) =>
      operation.type === "set-project-description" &&
      operation.projectNodeId === projectNodeId
  );
  const readme = plan.operations.find(
    (operation) =>
      operation.type === "set-project-readme" &&
      operation.projectNodeId === projectNodeId
  );
  const blueprint = plan.seedBlueprints.find(
    (candidate) => candidate.projectNodeId === projectNodeId
  )!;
  const observedFieldValues = (
    values: typeof blueprint.draftItems[number]["fieldValues"]
  ) =>
    values.flatMap((value) => {
      if (value.value === null) return [];
      const field = schema.fields.find(
        (candidate) => candidate.key === value.fieldKey
      )!;
      assert.ok(
        field.dataType === "NUMBER" ||
          field.dataType === "SINGLE_SELECT" ||
          field.dataType === "TEXT"
      );
      return [
        {
          fieldName: field.name,
          dataType: field.dataType,
          value: value.value
        }
      ];
    });
  const items = [
    {
      nodeId: `ISSUE_${projectNodeId}`,
      contentNodeId: blueprint.scenarioIssueNodeId,
      title: blueprint.scenarioIssueTitle,
      contentType: "issue" as const,
      fieldValues: observedFieldValues(
        blueprint.draftItems[0]!.fieldValues
      )
    },
    ...blueprint.draftItems.map((draft, index) => ({
      nodeId: `DRAFT_${projectNodeId}_${index}`,
      contentNodeId: `DRAFT_CONTENT_${projectNodeId}_${index}`,
      title: draft.title,
      contentType: "draft" as const,
      fieldValues: observedFieldValues(draft.fieldValues)
    }))
  ];
  return {
    ...source.snapshot,
    observedAt: RECONCILED_AT,
    project: {
      ...source.snapshot.project,
      shortDescription:
        description?.type === "set-project-description"
          ? description.shortDescription
          : schema.project.shortDescription ?? null,
      readme:
        readme?.type === "set-project-readme" ? readme.readme : null
    },
    itemCount: items.length,
    items,
    views: source.snapshot.views.map((view) => ({
      ...view,
      name: "Journey",
      visibleFieldNames: [
        "Title",
        "Stage Interaction",
        "Current Stage Agent",
        "Requested Stage Agent",
        "Agent Selection Status",
        "Gate Status",
        "Attention",
        "Run / Attempt"
      ]
    })),
    fields: [
      ...source.snapshot.fields,
      ...schema.fields.map((field, fieldIndex) => ({
        nodeId: `FIELD_${projectNodeId}_${fieldIndex}`,
        name: field.name,
        dataType: field.dataType,
        options: field.options.map((option, optionIndex) => ({
          nodeId: `OPTION_${projectNodeId}_${fieldIndex}_${optionIndex}`,
          name: option.name,
          color: option.color,
          description: option.description ?? ""
        }))
      }))
    ]
  };
}

test("customer target manifest is derived from fresh empty Project snapshots", async () => {
  const projectSchemas = await schemas();
  const generated = createDemoProjectTargetManifest({
    projectSchemas,
    snapshots: initialSnapshots(),
    evaluatedAt: EVALUATED_AT,
    maxSnapshotAgeMs: 5 * 60 * 1000
  });
  assert.deepEqual(generated, targetManifest);
  assert.deepEqual(
    generated.spec.projects.map((project) => project.projectSchemaDigest),
    projectSchemas.entries.map((entry) => digest(entry.schema))
  );
});

test("HYBRID-026 and HYBRID-027 produce one exact reviewed bootstrap plan", async () => {
  const projectSchemas = await schemas();
  const input = {
    targetManifest,
    expectedTargetManifestDigest: TARGET_MANIFEST_DIGEST,
    projectSchemas,
    snapshots: initialSnapshots(),
    issueBindings: issueBindings(),
    evaluatedAt: EVALUATED_AT,
    maxSnapshotAgeMs: 5 * 60 * 1000
  };
  const first = planVerifiedDemoProjectBootstrap(input);
  const second = planVerifiedDemoProjectBootstrap(input);
  assert.equal(first.planDigest, second.planDigest);
  assert.deepEqual(first.exactTargetNodeIds, [
    "PVT_synthetic_app_modernization",
    "PVT_synthetic_feature_delivery",
    "PVT_synthetic_security_dependency_remediation",
    "PVT_synthetic_adaptive_delivery"
  ]);
  assert.equal(first.operations.length, 68);
  assert.equal(first.seedBlueprints.length, 4);
  assert.deepEqual(
    first.seedBlueprints.map((blueprint) => blueprint.draftItems.length),
    [14, 13, 13, 21]
  );
  assert.equal(first.manualViewSteps.length, 8);
  assert.ok(first.operations.every((operation) => operation.requiresHumanAdmin));
  assert.ok(
    first.operations
      .filter((operation) => operation.type === "create-field")
      .flatMap((operation) => operation.options)
      .every(
        (option) =>
          typeof option.color === "string" &&
          typeof option.description === "string"
      )
  );
  assert.ok(
    first.operations.every(
      (operation) =>
        first.exactTargetNodeIds.includes(operation.projectNodeId) &&
        !["delete-field", "change-visibility", "unlink-repository"].includes(
          operation.type
        )
    )
  );
});

test("bootstrap rejects a rehashed target manifest with a stale Project schema digest", async () => {
  const projectSchemas = await schemas();
  const projects = targetManifest.spec.projects.map((project, index) =>
    index === 0
      ? { ...project, projectSchemaDigest: digest("stale-project-schema") }
      : project
  );
  const spec = { ...targetManifest.spec, projects };
  const changedManifest = {
    ...targetManifest,
    spec,
    contentDigest: digest({
      apiVersion: targetManifest.apiVersion,
      kind: targetManifest.kind,
      schemaVersion: targetManifest.schemaVersion,
      spec
    })
  };
  assert.throws(
    () =>
      planVerifiedDemoProjectBootstrap({
        targetManifest: changedManifest,
        expectedTargetManifestDigest: changedManifest.contentDigest as Digest,
        projectSchemas,
        snapshots: initialSnapshots(),
        issueBindings: issueBindings(),
        evaluatedAt: EVALUATED_AT,
        maxSnapshotAgeMs: 5 * 60 * 1000
      }),
    /live Project target drift blocks bootstrap/u
  );
});

test("the bootstrap target remains bound to the reviewed manifest digest", async () => {
  const projectSchemas = await schemas();
  const changedSpec = {
    ...targetManifest.spec,
    repository: {
      ...targetManifest.spec.repository,
      nodeId: "R_synthetic_substitution"
    }
  };
  assert.throws(
    () =>
      planVerifiedDemoProjectBootstrap({
        targetManifest: {
          ...targetManifest,
          spec: changedSpec,
          contentDigest: digest({
            apiVersion: targetManifest.apiVersion,
            kind: targetManifest.kind,
            schemaVersion: targetManifest.schemaVersion,
            spec: changedSpec
          })
        },
        expectedTargetManifestDigest: TARGET_MANIFEST_DIGEST,
        projectSchemas,
        snapshots: initialSnapshots(),
        issueBindings: issueBindings(),
        evaluatedAt: EVALUATED_AT,
        maxSnapshotAgeMs: 5 * 60 * 1000
      }),
    /differs from the human-confirmed digest/u
  );
});

test("bootstrap rejects a human-confirmed manifest with noncanonical Project titles", async () => {
  const projectSchemas = await schemas();
  const projects = targetManifest.spec.projects.map((project, index) =>
    index === 0 ? { ...project, title: "Renamed Project" } : project
  );
  const spec = { ...targetManifest.spec, projects };
  const changedManifest = {
    ...targetManifest,
    spec,
    contentDigest: digest({
      apiVersion: targetManifest.apiVersion,
      kind: targetManifest.kind,
      schemaVersion: targetManifest.schemaVersion,
      spec
    })
  };
  const snapshots = initialSnapshots().map((entry, index) =>
    index === 0
      ? {
          ...entry,
          snapshot: {
            ...entry.snapshot,
            project: {
              ...entry.snapshot.project,
              title: "Renamed Project"
            }
          }
        }
      : entry
  );
  assert.throws(
    () =>
      planVerifiedDemoProjectBootstrap({
        targetManifest: changedManifest,
        expectedTargetManifestDigest: changedManifest.contentDigest as Digest,
        projectSchemas,
        snapshots,
        issueBindings: issueBindings(),
        evaluatedAt: EVALUATED_AT,
        maxSnapshotAgeMs: 5 * 60 * 1000
      }),
    /live Project target drift blocks bootstrap/u
  );
});

test("exact Project identity, visibility, linkage, view, item, and custom-field drift block planning", async () => {
  const projectSchemas = await schemas();
  const base = initialSnapshots();
  const mutations = [
    (snapshot: LiveDemoProjectAdminSnapshot) => ({
      ...snapshot,
      project: { ...snapshot.project, public: true }
    }),
    (snapshot: LiveDemoProjectAdminSnapshot) => ({
      ...snapshot,
      project: { ...snapshot.project, nodeId: "PVT_synthetic_wrong" }
    }),
    (snapshot: LiveDemoProjectAdminSnapshot) => ({
      ...snapshot,
      linkedRepositories: []
    }),
    (snapshot: LiveDemoProjectAdminSnapshot) => ({
      ...snapshot,
      views: []
    }),
    (snapshot: LiveDemoProjectAdminSnapshot) => ({
      ...snapshot,
      itemCount: 1,
      items: [
        {
          nodeId: "PVTI_synthetic_unexpected",
          contentNodeId: "DI_unexpected",
          title: "Unexpected",
          contentType: "draft" as const,
          fieldValues: []
        }
      ]
    }),
    (snapshot: LiveDemoProjectAdminSnapshot) => ({
      ...snapshot,
      fields: [
        ...snapshot.fields,
        {
          nodeId: "PVTF_synthetic_unexpected",
          name: "Unexpected Custom Field",
          dataType: "TEXT",
          options: []
        }
      ]
    })
  ];
  for (const mutate of mutations) {
    const snapshots = base.map((entry, index) =>
      index === 0
        ? { ...entry, snapshot: mutate(entry.snapshot) }
        : entry
    );
    assert.throws(
      () =>
        planVerifiedDemoProjectBootstrap({
          targetManifest,
          expectedTargetManifestDigest: TARGET_MANIFEST_DIGEST,
          projectSchemas,
          snapshots,
          issueBindings: issueBindings(),
          evaluatedAt: EVALUATED_AT,
          maxSnapshotAgeMs: 5 * 60 * 1000
        }),
      /blocks bootstrap|unexpected custom/u
    );
  }
});

test("post-apply readback reconciles every API-supported field and synthetic item", async () => {
  const projectSchemas = await schemas();
  const initial = initialSnapshots();
  const plan = planVerifiedDemoProjectBootstrap({
    targetManifest,
    expectedTargetManifestDigest: TARGET_MANIFEST_DIGEST,
    projectSchemas,
    snapshots: initial,
    issueBindings: issueBindings(),
    evaluatedAt: EVALUATED_AT,
    maxSnapshotAgeMs: 5 * 60 * 1000
  });
  const snapshots = initial.map((entry, index) => ({
    demoProjectId: entry.demoProjectId,
    snapshot: postSnapshot(
      plan,
      projectSchemas.entries[index]!.schema,
      entry
    )
  }));
  const report = reconcileVerifiedDemoProjectBootstrap({
    targetManifest,
    projectSchemas,
    confirmedPlan: plan,
    confirmedPlanDigest: plan.planDigest,
    snapshots,
    reconciledAt: RECONCILED_AT,
    maxSnapshotAgeMs: 5 * 60 * 1000
  });
  assert.equal(report.apiSupportedPostconditionsMet, true);
  assert.ok(report.projects.every((project) => project.problems.length === 0));
  assert.ok(
    report.projects.every((project) => project.fieldBindings.length === 15)
  );
  for (const [index, project] of report.projects.entries()) {
    assert.deepEqual(
      project.fieldBindings.map((field) => ({
        fieldKey: field.fieldKey,
        name: field.name,
        options: field.options.map((option) => ({
          key: option.key,
          name: option.name,
          color: option.color,
          description: option.description
        }))
      })),
      projectSchemas.entries[index]!.schema.fields.map((field) => ({
        fieldKey: field.key,
        name: field.name,
        options: field.options.map((option) => ({
          key: option.key,
          name: option.name,
          color: option.color,
          description: option.description ?? ""
        }))
      }))
    );
    const nodeIds = project.fieldBindings.flatMap((field) => [
      field.nodeId,
      ...field.options.map((option) => option.nodeId)
    ]);
    assert.equal(new Set(nodeIds).size, nodeIds.length);
  }
  assert.equal(report.confirmedPlanDigest, plan.planDigest);
  const { planDigest: _planDigest, ...planPayload } = plan;
  const tamperedPayload = {
    ...planPayload,
    exactTargetNodeIds: [
      "PVT_synthetic_wrong",
      ...plan.exactTargetNodeIds.slice(1)
    ]
  };
  const tampered = {
    ...tamperedPayload,
    planDigest: digest(tamperedPayload)
  };
  assert.throws(
    () =>
      reconcileVerifiedDemoProjectBootstrap({
        targetManifest,
        projectSchemas,
        confirmedPlan: tampered,
        confirmedPlanDigest: plan.planDigest,
        snapshots,
        reconciledAt: RECONCILED_AT,
        maxSnapshotAgeMs: 5 * 60 * 1000
      }),
    /confirmed plan/u
  );
});

test("readback detects color, description, and option identity drift", async () => {
  const projectSchemas = await schemas();
  const initial = initialSnapshots();
  const plan = planVerifiedDemoProjectBootstrap({
    targetManifest,
    expectedTargetManifestDigest: TARGET_MANIFEST_DIGEST,
    projectSchemas,
    snapshots: initial,
    issueBindings: issueBindings(),
    evaluatedAt: EVALUATED_AT,
    maxSnapshotAgeMs: 5 * 60 * 1000
  });
  const snapshots = initial.map((entry, index) => ({
    demoProjectId: entry.demoProjectId,
    snapshot: postSnapshot(
      plan,
      projectSchemas.entries[index]!.schema,
      entry
    )
  }));
  const first = snapshots[0]!;
  const second = snapshots[1]!;
  const firstStage = first.snapshot.fields.find(
    (field) => field.name === "Stage"
  )!;
  const secondStage = second.snapshot.fields.find(
    (field) => field.name === "Stage"
  )!;
  const drifted = [
    {
      ...first,
      snapshot: {
        ...first.snapshot,
        fields: first.snapshot.fields.map((field) =>
          field.name === firstStage.name
            ? {
                ...field,
                options: field.options.map((option, index) =>
                  index === 0
                    ? { ...option, color: "BLUE" as const }
                    : index === 1
                      ? { ...option, description: "drifted description" }
                      : option
                )
              }
            : field
        )
      }
    },
    {
      ...second,
      snapshot: {
        ...second.snapshot,
        fields: second.snapshot.fields.map((field) =>
          field.name === secondStage.name
            ? {
                ...field,
                options: field.options.map((option, index) =>
                  index === 1
                    ? { ...option, nodeId: field.options[0]!.nodeId }
                    : option
                )
              }
            : field
        )
      }
    },
    ...snapshots.slice(2)
  ];
  const report = reconcileVerifiedDemoProjectBootstrap({
    targetManifest,
    projectSchemas,
    confirmedPlan: plan,
    confirmedPlanDigest: plan.planDigest,
    snapshots: drifted,
    reconciledAt: RECONCILED_AT,
    maxSnapshotAgeMs: 5 * 60 * 1000
  });
  assert.equal(report.apiSupportedPostconditionsMet, false);
  assert.ok(report.projects[0]!.problems.includes("field:stage"));
  assert.ok(
    report.projects[1]!.problems.includes("field-option-identities")
  );
});

test("readback detects missing options, seed items, and target substitution", async () => {
  const projectSchemas = await schemas();
  const initial = initialSnapshots();
  const plan = planVerifiedDemoProjectBootstrap({
    targetManifest,
    expectedTargetManifestDigest: TARGET_MANIFEST_DIGEST,
    projectSchemas,
    snapshots: initial,
    issueBindings: issueBindings(),
    evaluatedAt: EVALUATED_AT,
    maxSnapshotAgeMs: 5 * 60 * 1000
  });
  const snapshots = initial.map((entry, index) => ({
    demoProjectId: entry.demoProjectId,
    snapshot: postSnapshot(
      plan,
      projectSchemas.entries[index]!.schema,
      entry
    )
  }));
  const first = snapshots[0]!;
  const journey = first.snapshot.fields.find(
    (field) => field.name === "Journey Stage"
  )!;
  const drifted = [
    {
      ...first,
      snapshot: {
        ...first.snapshot,
        fields: first.snapshot.fields.map((field) =>
          field.name === journey.name
            ? { ...field, options: field.options.slice(1) }
            : field
        ),
        items: first.snapshot.items.map((item, index) =>
          index === 0
            ? { ...item, contentNodeId: "ISSUE_WRONG_REPOSITORY" }
            : item
        ),
        views: first.snapshot.views.map((view) => ({
          ...view,
          name: "View 1",
          visibleFieldNames: ["Title", "Status"]
        }))
      }
    },
    ...snapshots.slice(1)
  ];
  const report = reconcileVerifiedDemoProjectBootstrap({
    targetManifest,
    projectSchemas,
    confirmedPlan: plan,
    confirmedPlanDigest: plan.planDigest,
    snapshots: drifted,
    reconciledAt: RECONCILED_AT,
    maxSnapshotAgeMs: 5 * 60 * 1000
  });
  assert.equal(report.apiSupportedPostconditionsMet, false);
  assert.ok(
    report.projects[0]!.problems.some(
      (problem) =>
        problem === "field:journey-stage" ||
        problem === "synthetic-scenario-issue" ||
        problem === "issue-membership" ||
        problem === "project-view"
    )
  );
});

test("display-only snapshots accept user and organization owners without installation", async () => {
  const projectSchemas = await schemas();
  const userSnapshots = await displaySnapshots();
  assert.ok(
    userSnapshots.every(
      (entry) =>
        entry.snapshot.owner.type === "user" &&
        !("installation" in entry.snapshot)
    )
  );
  const userManifest = displayManifest(projectSchemas, userSnapshots);
  assert.ok(
    userManifest.spec.targets.every((target) => target.owner.type === "user")
  );

  const organizationSnapshots = userSnapshots.map((entry) => ({
    demoProjectId: entry.demoProjectId,
    snapshot: {
      ...entry.snapshot,
      owner: {
        type: "organization" as const,
        login: "example-organization",
        nodeId: "O_synthetic_display_organization"
      },
      repository: {
        fullName: "example-organization/hyperfinite",
        nodeId: "R_synthetic_display_organization_repository"
      },
      linkedRepositories: [
        {
          fullName: "example-organization/hyperfinite",
          nodeId: "R_synthetic_display_organization_repository"
        }
      ]
    }
  }));
  const organizationManifest = displayManifest(
    projectSchemas,
    organizationSnapshots
  );
  assert.ok(
    organizationManifest.spec.targets.every(
      (target) => target.owner.type === "organization"
    )
  );

  const displaySnapshot = userSnapshots[0]!.snapshot;
  const runtimeCandidate = {
    owner: displaySnapshot.owner,
    project: {
      number: displaySnapshot.project.number,
      nodeId: displaySnapshot.project.nodeId,
      title: displaySnapshot.project.title
    },
    fields: displaySnapshot.customFields
  };
  assert.throws(
    () =>
      planProjectSetup({
        schema: projectSchemas.entries[0]!.schema,
        live: runtimeCandidate as LiveGitHubProject,
        evaluatedAt: DISPLAY_PLAN_AT
      }),
    /required property 'installation'/u
  );

  const installationBearing = userSnapshots.map((entry, index) =>
    index === 0
      ? {
          ...entry,
          snapshot: {
            ...entry.snapshot,
            installation: {
              id: 1,
              accountNodeId: entry.snapshot.owner.nodeId
            }
          }
        }
      : entry
  );
  assert.throws(
    () =>
      createDisplayOnlyProjectTargetManifest({
        projectSchemas,
        snapshots: installationBearing,
        generatedAt: DISPLAY_MANIFEST_AT,
        maxSnapshotAgeMs: DISPLAY_MAX_AGE_MS
      }),
    /GitHubProjectDisplaySnapshot validation failed/u
  );
});

test("display-only planning emits the exact stable 158-action color set", async () => {
  const projectSchemas = await schemas();
  const snapshots = await displaySnapshots();
  assert.ok(
    snapshots.every(
      (entry) => entry.snapshot.observedAt === DISPLAY_OBSERVED_AT
    )
  );
  const manifest = displayManifest(projectSchemas, snapshots);
  const exampleManifest = JSON.parse(
    await readFile(
      "examples/project-display-colors/target-manifest.example.json",
      "utf8"
    )
  ) as unknown;
  assert.deepEqual(exampleManifest, manifest);
  const first = displayPlan(projectSchemas, manifest, snapshots);
  const second = displayPlan(projectSchemas, manifest, snapshots);

  assert.equal(canonicalJson(first), canonicalJson(second));
  assert.equal(first.actions.length, 158);
  assert.deepEqual(
    projectSchemas.entries.map((entry) =>
      first.actions.filter(
        (action) => action.demoProjectId === entry.demoProjectId
      ).length
    ),
    [39, 38, 38, 43]
  );
  assert.ok(
    first.actions.every(
      (action) =>
        action.type === "set-single-select-option-color" &&
        action.authoritative === false &&
        action.displayOnly &&
        action.requiresHumanAdmin &&
        action.before.color === "GRAY" &&
        action.after.color !== "GRAY" &&
        action.projectNodeId.length > 0 &&
        action.fieldNodeId.length > 0 &&
        action.optionNodeId.length > 0 &&
        Object.keys(action.before).length === 1 &&
        Object.keys(action.after).length === 1
    )
  );
  assert.equal("binding" in first, false);
  assert.equal("bindings" in first, false);
  assert.equal("effect" in first, false);
  assert.equal("effects" in first, false);
  assert.equal("installation" in first, false);
  assert.equal("credential" in first, false);

  const schemaBytes = canonicalJson(projectSchemas);
  const reconciledSnapshots = withExpectedDisplayColors(
    projectSchemas,
    snapshots,
    DISPLAY_OBSERVED_AT
  );
  const zeroDrift = displayPlan(
    projectSchemas,
    manifest,
    reconciledSnapshots
  );
  assert.equal(zeroDrift.actions.length, 0);
  assert.equal(canonicalJson(projectSchemas), schemaBytes);
  assert.deepEqual(
    zeroDrift.projects.map((project) => project.projectSchemaDigest),
    first.projects.map((project) => project.projectSchemaDigest)
  );
});

test("display target confirmation, identity, schema, and freshness fail closed", async () => {
  const projectSchemas = await schemas();
  const snapshots = await displaySnapshots();
  const manifest = displayManifest(projectSchemas, snapshots);
  const planInput = {
    targetManifest: manifest,
    confirmedTargetManifestDigest: manifest.contentDigest,
    projectSchemas,
    snapshots,
    evaluatedAt: DISPLAY_PLAN_AT,
    maxSnapshotAgeMs: DISPLAY_MAX_AGE_MS
  } as const;

  assert.throws(
    () =>
      planDisplayOnlyProjectColorReconciliation({
        ...planInput,
        confirmedTargetManifestDigest: digest("wrong-confirmation")
      }),
    /independently confirmed digest/u
  );

  const substitutedTargets = manifest.spec.targets.map((target, index) => {
    if (index !== 0) return target;
    const project = {
      ...target.project,
      nodeId: "PVT_synthetic_substituted_target"
    };
    return {
      ...target,
      proposal: {
        ...target.proposal,
        snapshotDigest: digest({
          ...snapshots[0]!.snapshot,
          project
        })
      },
      project
    };
  });
  const substitutedManifest = rehashDisplayManifest(
    manifest,
    substitutedTargets
  );
  assert.throws(
    () =>
      planDisplayOnlyProjectColorReconciliation({
        ...planInput,
        targetManifest: substitutedManifest,
        confirmedTargetManifestDigest: substitutedManifest.contentDigest
      }),
    /target identity or state changed/u
  );

  const renamedTargets = manifest.spec.targets.map((target, index) =>
    index === 0
      ? {
          ...target,
          project: { ...target.project, title: "Substituted title" }
        }
      : target
  );
  const renamedManifest = rehashDisplayManifest(manifest, renamedTargets);
  assert.throws(
    () =>
      planDisplayOnlyProjectColorReconciliation({
        ...planInput,
        targetManifest: renamedManifest,
        confirmedTargetManifestDigest: renamedManifest.contentDigest
      }),
    /differs from the merged schema/u
  );

  const wrongSchemaTargets = manifest.spec.targets.map((target, index) =>
    index === 0
      ? { ...target, projectSchemaDigest: digest("wrong-schema") }
      : target
  );
  const wrongSchemaManifest = rehashDisplayManifest(
    manifest,
    wrongSchemaTargets
  );
  assert.throws(
    () =>
      planDisplayOnlyProjectColorReconciliation({
        ...planInput,
        targetManifest: wrongSchemaManifest,
        confirmedTargetManifestDigest: wrongSchemaManifest.contentDigest
      }),
    /differs from the merged schema/u
  );

  const wrongSnapshotDigestTargets = manifest.spec.targets.map(
    (target, index) =>
      index === 0
        ? {
            ...target,
            proposal: {
              ...target.proposal,
              snapshotDigest: digest("wrong-proposal-snapshot")
            }
          }
        : target
  );
  const wrongSnapshotDigestManifest = rehashDisplayManifest(
    manifest,
    wrongSnapshotDigestTargets
  );
  assert.throws(
    () =>
      planDisplayOnlyProjectColorReconciliation({
        ...planInput,
        targetManifest: wrongSnapshotDigestManifest,
        confirmedTargetManifestDigest:
          wrongSnapshotDigestManifest.contentDigest
      }),
    /proposal snapshot digest is invalid/u
  );

  const titleOnlySubstitution = snapshots.map((entry, index) =>
    index === 0
      ? {
          ...entry,
          snapshot: {
            ...entry.snapshot,
            project: {
              ...entry.snapshot.project,
              nodeId: "PVT_synthetic_same_title_wrong_identity"
            }
          }
        }
      : entry
  );
  assert.throws(
    () =>
      planDisplayOnlyProjectColorReconciliation({
        ...planInput,
        snapshots: titleOnlySubstitution
      }),
    /target identity or state changed/u
  );

  const targetStateMutations: readonly ((
    snapshot: GitHubProjectDisplaySnapshot
  ) => GitHubProjectDisplaySnapshot)[] = [
    (snapshot) => ({
      ...snapshot,
      owner: { ...snapshot.owner, nodeId: "U_synthetic_wrong_owner" }
    }),
    (snapshot) => ({
      ...snapshot,
      repository: {
        ...snapshot.repository,
        nodeId: "R_synthetic_wrong_repository"
      },
      linkedRepositories: [
        {
          ...snapshot.linkedRepositories[0]!,
          nodeId: "R_synthetic_wrong_repository"
        }
      ]
    }),
    (snapshot) => ({
      ...snapshot,
      project: { ...snapshot.project, visibility: "private" }
    }),
    (snapshot) => ({
      ...snapshot,
      project: { ...snapshot.project, closed: true }
    }),
    (snapshot) => ({
      ...snapshot,
      view: { ...snapshot.view, nodeId: "PVTV_synthetic_wrong_view" }
    }),
    (snapshot) => ({
      ...snapshot,
      customFields: snapshot.customFields.map((field, fieldIndex) =>
        fieldIndex === 0
          ? { ...field, nodeId: "PVTF_synthetic_wrong_field" }
          : field
      )
    }),
    (snapshot) => ({
      ...snapshot,
      customFields: snapshot.customFields.map((field, fieldIndex) =>
        fieldIndex === 0
          ? {
              ...field,
              options: field.options.map((option, optionIndex) =>
                optionIndex === 0
                  ? { ...option, nodeId: "PVTO_synthetic_wrong_option" }
                  : option
              )
            }
          : field
      )
    })
  ];
  for (const mutate of targetStateMutations) {
    const changed = snapshots.map((entry, index) =>
      index === 0
        ? { ...entry, snapshot: mutate(entry.snapshot) }
        : entry
    );
    assert.throws(
      () =>
        planDisplayOnlyProjectColorReconciliation({
          ...planInput,
          snapshots: changed
        }),
      /target identity or state changed/u
    );
  }

  const staleSnapshots = snapshots.map((entry, index) =>
    index === 0
      ? {
          ...entry,
          snapshot: {
            ...entry.snapshot,
            observedAt: "2026-09-03T23:40:00.000Z"
          }
        }
      : entry
  );
  assert.throws(
    () =>
      createDisplayOnlyProjectTargetManifest({
        projectSchemas,
        snapshots: staleSnapshots,
        generatedAt: DISPLAY_MANIFEST_AT,
        maxSnapshotAgeMs: DISPLAY_MAX_AGE_MS
      }),
    /stale or from the future/u
  );

  const futureSnapshots = snapshots.map((entry, index) =>
    index === 0
      ? {
          ...entry,
          snapshot: {
            ...entry.snapshot,
            observedAt: "2026-09-04T00:00:00.000Z"
          }
        }
      : entry
  );
  assert.throws(
    () =>
      planDisplayOnlyProjectColorReconciliation({
        ...planInput,
        snapshots: futureSnapshots
      }),
    /stale or from the future/u
  );

  assert.throws(
    () =>
      planDisplayOnlyProjectColorReconciliation({
        ...planInput,
        evaluatedAt: "2026-09-04T00:10:00.000Z"
      }),
    /display target manifest is stale/u
  );

  const oldSnapshots = snapshots.map((entry) => ({
    ...entry,
    snapshot: {
      ...entry.snapshot,
      observedAt: "2026-09-03T23:39:00.000Z"
    }
  }));
  const oldManifest = createDisplayOnlyProjectTargetManifest({
    projectSchemas,
    snapshots: oldSnapshots,
    generatedAt: "2026-09-03T23:40:00.000Z",
    maxSnapshotAgeMs: DISPLAY_MAX_AGE_MS
  });
  const ordinaryPlan = displayPlan(projectSchemas, manifest, snapshots);
  const staleManifestPlan = rehashDisplayPlan(
    ordinaryPlan,
    ordinaryPlan.actions,
    { targetManifestDigest: oldManifest.contentDigest }
  );
  const staleManifestPlanDigest = (
    staleManifestPlan as { planDigest: Digest }
  ).planDigest;
  assert.throws(
    () =>
      readbackDisplayOnlyProjectColorReconciliation({
        targetManifest: oldManifest,
        confirmedTargetManifestDigest: oldManifest.contentDigest,
        projectSchemas,
        confirmedPlan: staleManifestPlan,
        confirmedPlanDigest: staleManifestPlanDigest,
        snapshots: withExpectedDisplayColors(
          projectSchemas,
          snapshots,
          DISPLAY_READBACK_OBSERVED_AT
        ),
        reconciledAt: DISPLAY_READBACK_AT,
        maxSnapshotAgeMs: DISPLAY_MAX_AGE_MS
      }),
    /display target manifest is stale/u
  );
});

test("display snapshots reject duplicate, missing, extra, reordered, or renamed schema state", async () => {
  const projectSchemas = await schemas();
  const snapshots = await displaySnapshots();
  const manifest = displayManifest(projectSchemas, snapshots);
  const first = snapshots[0]!.snapshot;
  const firstField = first.customFields[0]!;
  const secondField = first.customFields[1]!;
  const mutations: readonly ((
    snapshot: GitHubProjectDisplaySnapshot
  ) => unknown)[] = [
    (snapshot) => ({
      ...snapshot,
      customFields: snapshot.customFields.slice(1)
    }),
    (snapshot) => ({
      ...snapshot,
      customFields: [
        ...snapshot.customFields,
        {
          nodeId: "PVTF_synthetic_unexpected",
          name: "Unexpected",
          dataType: "TEXT",
          options: []
        }
      ]
    }),
    (snapshot) => ({
      ...snapshot,
      customFields: [
        snapshot.customFields[1],
        snapshot.customFields[0],
        ...snapshot.customFields.slice(2)
      ]
    }),
    (snapshot) => ({
      ...snapshot,
      customFields: snapshot.customFields.map((field, index) =>
        index === 0 ? { ...field, name: "Renamed Stage" } : field
      )
    }),
    (snapshot) => ({
      ...snapshot,
      customFields: snapshot.customFields.map((field, index) =>
        index === 0 ? { ...field, dataType: "TEXT" } : field
      )
    }),
    (snapshot) => ({
      ...snapshot,
      customFields: snapshot.customFields.map((field, index) =>
        index === 1 ? { ...field, nodeId: firstField.nodeId } : field
      )
    }),
    (snapshot) => ({
      ...snapshot,
      customFields: snapshot.customFields.map((field, index) =>
        index === 0
          ? { ...field, options: field.options.slice(1) }
          : field
      )
    }),
    (snapshot) => ({
      ...snapshot,
      customFields: snapshot.customFields.map((field, index) =>
        index === 0
          ? {
              ...field,
              options: [
                ...field.options,
                {
                  nodeId: "PVTO_synthetic_unexpected",
                  name: "Unexpected",
                  color: "GRAY",
                  description: ""
                }
              ]
            }
          : field
      )
    }),
    (snapshot) => ({
      ...snapshot,
      customFields: snapshot.customFields.map((field, index) =>
        index === 0
          ? {
              ...field,
              options: [
                field.options[1],
                field.options[0],
                ...field.options.slice(2)
              ]
            }
          : field
      )
    }),
    (snapshot) => ({
      ...snapshot,
      customFields: snapshot.customFields.map((field, index) =>
        index === 0
          ? {
              ...field,
              options: field.options.map((option, optionIndex) =>
                optionIndex === 0
                  ? { ...option, name: "Renamed option" }
                  : option
              )
            }
          : field
      )
    }),
    (snapshot) => ({
      ...snapshot,
      customFields: snapshot.customFields.map((field, index) =>
        index === 0
          ? {
              ...field,
              options: field.options.map((option, optionIndex) =>
                optionIndex === 0
                  ? { ...option, description: "Changed semantics" }
                  : option
              )
            }
          : field
      )
    }),
    (snapshot) => ({
      ...snapshot,
      customFields: snapshot.customFields.map((field, index) =>
        index === 0
          ? {
              ...field,
              options: field.options.map((option, optionIndex) =>
                optionIndex === 1
                  ? { ...option, nodeId: field.options[0]!.nodeId }
                  : option
              )
            }
          : field
      )
    }),
    (snapshot) => ({
      ...snapshot,
      customFields: snapshot.customFields.map((field, index) =>
        index === 0
          ? {
              ...field,
              options: field.options.map((option, optionIndex) =>
                optionIndex === 0 ? { ...option, color: "BLACK" } : option
              )
            }
          : field
      )
    })
  ];
  assert.notEqual(firstField.nodeId, secondField.nodeId);
  for (const mutate of mutations) {
    const changed = snapshots.map((entry, index) =>
      index === 0
        ? { ...entry, snapshot: mutate(entry.snapshot) }
        : entry
    );
    assert.throws(
      () =>
        planDisplayOnlyProjectColorReconciliation({
          targetManifest: manifest,
          confirmedTargetManifestDigest: manifest.contentDigest,
          projectSchemas,
          snapshots: changed,
          evaluatedAt: DISPLAY_PLAN_AT,
          maxSnapshotAgeMs: DISPLAY_MAX_AGE_MS
        }),
      /validation failed|custom field|option identity|duplicate field or option/u
    );
  }
});

test("display-only plan validation rejects altered colors and unexpected action kinds", async () => {
  const projectSchemas = await schemas();
  const snapshots = await displaySnapshots();
  const manifest = displayManifest(projectSchemas, snapshots);
  const plan = displayPlan(projectSchemas, manifest, snapshots);
  const postApply = withExpectedDisplayColors(
    projectSchemas,
    snapshots,
    DISPLAY_READBACK_OBSERVED_AT
  );
  const firstAction = plan.actions[0]!;

  const wrongColorActions = plan.actions.map((action, index) =>
    index === 0
      ? { ...action, after: { color: firstAction.before.color } }
      : action
  );
  const wrongColorPlan = rehashDisplayPlan(plan, wrongColorActions);
  const wrongColorDigest = (wrongColorPlan as { planDigest: Digest })
    .planDigest;
  assert.throws(
    () =>
      readbackDisplayOnlyProjectColorReconciliation({
        targetManifest: manifest,
        confirmedTargetManifestDigest: manifest.contentDigest,
        projectSchemas,
        confirmedPlan: wrongColorPlan,
        confirmedPlanDigest: wrongColorDigest,
        snapshots: postApply,
        reconciledAt: DISPLAY_READBACK_AT,
        maxSnapshotAgeMs: DISPLAY_MAX_AGE_MS
      }),
    /exact observed color drift/u
  );

  const unexpectedActions = plan.actions.map((action, index) =>
    index === 0 ? { ...action, type: "delete-option" } : action
  );
  const unexpectedPlan = rehashDisplayPlan(plan, unexpectedActions);
  const unexpectedDigest = (unexpectedPlan as { planDigest: Digest })
    .planDigest;
  assert.throws(
    () =>
      readbackDisplayOnlyProjectColorReconciliation({
        targetManifest: manifest,
        confirmedTargetManifestDigest: manifest.contentDigest,
        projectSchemas,
        confirmedPlan: unexpectedPlan,
        confirmedPlanDigest: unexpectedDigest,
        snapshots: postApply,
        reconciledAt: DISPLAY_READBACK_AT,
        maxSnapshotAgeMs: DISPLAY_MAX_AGE_MS
      }),
    /GitHubProjectDisplayColorPlan validation failed/u
  );

  const wrongSnapshotProjects = plan.projects.map((project, index) =>
    index === 0
      ? { ...project, snapshotDigest: digest("wrong-plan-snapshot") }
      : project
  );
  const wrongSnapshotPlan = rehashDisplayPlan(plan, plan.actions, {
    projects: wrongSnapshotProjects
  });
  const wrongSnapshotPlanDigest = (
    wrongSnapshotPlan as { planDigest: Digest }
  ).planDigest;
  assert.throws(
    () =>
      readbackDisplayOnlyProjectColorReconciliation({
        targetManifest: manifest,
        confirmedTargetManifestDigest: manifest.contentDigest,
        projectSchemas,
        confirmedPlan: wrongSnapshotPlan,
        confirmedPlanDigest: wrongSnapshotPlanDigest,
        snapshots: postApply,
        reconciledAt: DISPLAY_READBACK_AT,
        maxSnapshotAgeMs: DISPLAY_MAX_AGE_MS
      }),
    /plan snapshot digest is invalid/u
  );
});

test("view layout and visible-field order remain observation-only for color planning", async () => {
  const projectSchemas = await schemas();
  const snapshots = await displaySnapshots();
  const manifest = displayManifest(projectSchemas, snapshots);
  const baseline = displayPlan(projectSchemas, manifest, snapshots);
  const changedViews = snapshots.map((entry) => ({
    ...entry,
    snapshot: {
      ...entry.snapshot,
      view: {
        ...entry.snapshot.view,
        layout: "TABLE_LAYOUT",
        visibleFields: [...entry.snapshot.view.visibleFields].reverse()
      }
    }
  }));
  const changed = displayPlan(projectSchemas, manifest, changedViews);

  assert.deepEqual(changed.actions, baseline.actions);
  assert.ok(
    changed.projects.every(
      (project) =>
        project.view.observedLayout === "TABLE_LAYOUT" &&
        project.view.observedVisibleFields[0]?.name === "Attention"
    )
  );
  assert.notEqual(changed.planDigest, baseline.planDigest);
});

test("display-only post-apply readback requires zero color drift and exact identity", async () => {
  const projectSchemas = await schemas();
  const snapshots = await displaySnapshots();
  const manifest = displayManifest(projectSchemas, snapshots);
  const plan = displayPlan(projectSchemas, manifest, snapshots);
  const postApply = withExpectedDisplayColors(
    projectSchemas,
    snapshots,
    DISPLAY_READBACK_OBSERVED_AT
  );
  const input = {
    targetManifest: manifest,
    confirmedTargetManifestDigest: manifest.contentDigest,
    projectSchemas,
    confirmedPlan: plan,
    confirmedPlanDigest: plan.planDigest,
    snapshots: postApply,
    reconciledAt: DISPLAY_READBACK_AT,
    maxSnapshotAgeMs: DISPLAY_MAX_AGE_MS
  } as const;
  const first = readbackDisplayOnlyProjectColorReconciliation(input);
  const second = readbackDisplayOnlyProjectColorReconciliation(input);

  assert.equal(first.success, true);
  assert.equal(first.runtimeBindingProduced, false);
  assert.ok(
    first.projects.every(
      (project) =>
        project.exactIdentityVerified &&
        project.schemaVerified &&
        project.remainingColorDrift.length === 0
    )
  );
  assert.equal(canonicalJson(first), canonicalJson(second));
  assert.equal("binding" in first, false);
  assert.equal("bindings" in first, false);

  const remainingDrift = postApply.map((entry, projectIndex) =>
    projectIndex === 0
      ? {
          ...entry,
          snapshot: {
            ...entry.snapshot,
            customFields: entry.snapshot.customFields.map(
              (field, fieldIndex) =>
                fieldIndex === 0
                  ? {
                      ...field,
                      options: field.options.map((option, optionIndex) =>
                        optionIndex === 1
                          ? { ...option, color: "GRAY" as const }
                          : option
                      )
                    }
                  : field
            )
          }
        }
      : entry
  );
  const blocked = readbackDisplayOnlyProjectColorReconciliation({
    ...input,
    snapshots: remainingDrift
  });
  assert.equal(blocked.success, false);
  assert.equal(blocked.projects[0]!.remainingColorDrift.length, 1);

  const substitutedIdentity = postApply.map((entry, projectIndex) =>
    projectIndex === 0
      ? {
          ...entry,
          snapshot: {
            ...entry.snapshot,
            project: {
              ...entry.snapshot.project,
              nodeId: "PVT_synthetic_readback_substitution"
            }
          }
        }
      : entry
  );
  assert.throws(
    () =>
      readbackDisplayOnlyProjectColorReconciliation({
        ...input,
        snapshots: substitutedIdentity
      }),
    /target identity or state changed/u
  );

  const staleReadback = postApply.map((entry, projectIndex) =>
    projectIndex === 0
      ? {
          ...entry,
          snapshot: {
            ...entry.snapshot,
            observedAt: DISPLAY_PLAN_AT
          }
        }
      : entry
  );
  assert.throws(
    () =>
      readbackDisplayOnlyProjectColorReconciliation({
        ...input,
        snapshots: staleReadback
      }),
    /does not postdate the confirmed plan/u
  );
});

test("display-only CLI rejects apply and execute before loading any input", () => {
  for (const flag of ["--apply", "--execute"]) {
    const result = spawnSync(
      process.execPath,
      [
        "dist/scripts/github-project-display-colors.js",
        "plan",
        "--snapshots",
        "does-not-exist",
        "--evaluated-at",
        DISPLAY_PLAN_AT,
        flag
      ],
      { cwd: process.cwd(), encoding: "utf8" }
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /dry-run only/u);
    assert.doesNotMatch(result.stderr, /ENOENT/u);
  }
});

test("display-only implementation has no network, authentication, binding, or effect adapter", async () => {
  const source = await readFile(
    "src/github-project-display-colors.ts",
    "utf8"
  );
  const cli = await readFile(
    "scripts/github-project-display-colors.ts",
    "utf8"
  );
  for (const text of [source, cli]) {
    assert.doesNotMatch(
      text,
      /node:(?:http|https|net|tls)|github-(?:auth|http)|fetch\s*\(|process\.env|GH_TOKEN|GITHUB_TOKEN|project-field-update/u
    );
  }
});
