import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import catalog from "../config/v1alpha1/demo-portfolio/catalog.json" with { type: "json" };
import targetManifest from "../config/v1alpha1/demo-portfolio/project-targets.example.json" with { type: "json" };
import reservations from "../config/v1alpha1/demo-portfolio/identity-reservations.json" with { type: "json" };
import coreSchema from "../config/v1alpha1/github-project.json" with { type: "json" };

import {
  createDemoProjectTargetManifest,
  planVerifiedDemoProjectBootstrap,
  reconcileVerifiedDemoProjectBootstrap,
  digest,
  validateDemoProjectSchemaCatalog,
  type DemoProjectId,
  type Digest,
  type GitHubProjectSchema,
  type LiveDemoProjectAdminSnapshot,
  type VerifiedDemoProjectBootstrapPlan
} from "../src/index.js";

const OBSERVED_AT = "2026-08-30T16:00:00.000Z";
const EVALUATED_AT = "2026-08-30T16:01:00.000Z";
const RECONCILED_AT = "2026-08-30T16:05:00.000Z";
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
