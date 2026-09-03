import { canonicalJson, digest } from "./canonical.js";
import {
  DEMO_PROJECTION_VOCABULARY,
  type DemoCatalog,
  type DemoIdentityReservationManifest,
  type DemoProjectId,
  type DemoProjectTargetManifest
} from "./demo-types.js";
import {
  createDemoContract,
  validateDemoContract,
  validatePortfolioFoundation
} from "./demo-portfolio.js";
import type {
  DemoGitHubProjectSchemaEntry,
  DemoIssueFormBinding,
  DemoIssueIntakeBlockCode,
  DemoIssueIntakeDecision,
  DemoIssueIntakeField,
  DemoIssueIntakeSubmission,
  DemoMissingInformationRequest,
  GitHubProjectBinding,
  GitHubProjectFieldType,
  GitHubProjectOptionColor,
  GitHubProjectProjectionSlot,
  GitHubProjectSchema
} from "./github-types.js";
import type { Digest } from "./types.js";
import { assertDocument, isCanonicalUtcDateTime } from "./validation.js";
import { parseStrictJson } from "./strict-json.js";

export interface LiveGitHubProject {
  readonly owner: {
    readonly type: "organization" | "user";
    readonly login: string;
    readonly nodeId: string;
  };
  readonly installation: {
    readonly id: number;
    readonly accountNodeId: string;
  };
  readonly project: {
    readonly number: number;
    readonly nodeId: string;
    readonly title: string;
  } | null;
  readonly fields: readonly {
    readonly nodeId: string;
    readonly name: string;
    readonly dataType: GitHubProjectFieldType;
    readonly options: readonly {
      readonly nodeId: string;
      readonly name: string;
      readonly color: GitHubProjectOptionColor;
      readonly description: string;
    }[];
  }[];
}

export interface ProjectSchemaProblem {
  readonly code:
    | "DUPLICATE_FIELD_KEY"
    | "DUPLICATE_FIELD_NAME"
    | "DUPLICATE_OPTION_KEY"
    | "DUPLICATE_OPTION_NAME"
    | "DUPLICATE_PROJECTION"
    | "DUPLICATE_PROJECTION_FIELD"
    | "DUPLICATE_PROJECTION_WRITE_ORDER"
    | "INCOMPLETE_PROJECTION_METADATA"
    | "INVALID_FIELD_OPTIONS"
    | "MISSING_PROJECTION"
    | "UNKNOWN_PROJECTION_FIELD";
  readonly path: string;
  readonly message: string;
}

export type ProjectSetupAction =
  | {
      readonly type: "create-project";
      readonly ownerLogin: string;
      readonly title: string;
      readonly requiresHumanAdmin: true;
    }
  | {
      readonly type: "create-field";
      readonly fieldKey: string;
      readonly name: string;
      readonly dataType: GitHubProjectFieldType;
      readonly options: readonly {
        readonly key: string;
        readonly name: string;
        readonly color: GitHubProjectOptionColor;
        readonly description: string;
      }[];
      readonly requiresHumanAdmin: true;
    }
  | {
      readonly type: "create-option";
      readonly fieldKey: string;
      readonly optionKey: string;
      readonly name: string;
      readonly color: GitHubProjectOptionColor;
      readonly description: string;
      readonly requiresHumanAdmin: true;
    }
  | {
      readonly type: "reconcile-drift";
      readonly path: string;
      readonly expected: string;
      readonly actual: string;
      readonly requiresHumanAdmin: true;
    };

export interface ProjectSetupPlan {
  readonly mode: "dry-run";
  readonly schemaDigest: Digest;
  readonly valid: boolean;
  readonly problems: readonly ProjectSchemaProblem[];
  readonly actions: readonly ProjectSetupAction[];
  readonly binding: GitHubProjectBinding | null;
}

function findDuplicates(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

export function validateProjectSchemaSemantics(
  schema: GitHubProjectSchema
): readonly ProjectSchemaProblem[] {
  const problems: ProjectSchemaProblem[] = [];
  for (const key of findDuplicates(schema.fields.map((field) => field.key))) {
    problems.push({
      code: "DUPLICATE_FIELD_KEY",
      path: "/fields",
      message: `field key ${key} is declared more than once`
    });
  }
  for (const name of findDuplicates(schema.fields.map((field) => field.name))) {
    problems.push({
      code: "DUPLICATE_FIELD_NAME",
      path: "/fields",
      message: `field name ${name} is declared more than once`
    });
  }
  for (const field of schema.fields) {
    if (field.dataType !== "SINGLE_SELECT" && field.options.length > 0) {
      problems.push({
        code: "INVALID_FIELD_OPTIONS",
        path: `/fields/${field.key}/options`,
        message: `${field.dataType} fields cannot declare single-select options`
      });
    }
    for (const key of findDuplicates(field.options.map((option) => option.key))) {
      problems.push({
        code: "DUPLICATE_OPTION_KEY",
        path: `/fields/${field.key}/options`,
        message: `option key ${key} is declared more than once`
      });
    }
    for (const name of findDuplicates(field.options.map((option) => option.name))) {
      problems.push({
        code: "DUPLICATE_OPTION_NAME",
        path: `/fields/${field.key}/options`,
        message: `option name ${name} is declared more than once`
      });
    }
  }

  const fieldKeys = new Set(schema.fields.map((field) => field.key));
  for (const slot of findDuplicates(schema.projections.map((entry) => entry.slot))) {
    problems.push({
      code: "DUPLICATE_PROJECTION",
      path: "/projections",
      message: `projection slot ${slot} is declared more than once`
    });
  }
  for (const fieldKey of findDuplicates(
    schema.projections.map((entry) => entry.fieldKey)
  )) {
    problems.push({
      code: "DUPLICATE_PROJECTION_FIELD",
      path: "/projections",
      message: `projection field ${fieldKey} is declared more than once`
    });
  }
  for (const writeOrder of findDuplicates(
    schema.projections.flatMap((entry) =>
      entry.writeOrder === undefined ? [] : [String(entry.writeOrder)]
    )
  )) {
    problems.push({
      code: "DUPLICATE_PROJECTION_WRITE_ORDER",
      path: "/projections",
      message: `projection write order ${writeOrder} is declared more than once`
    });
  }
  const projectionsWithMetadata = schema.projections.filter(
    (entry) =>
      entry.source !== undefined ||
      entry.displayOnly !== undefined ||
      entry.writeOrder !== undefined
  );
  if (
    projectionsWithMetadata.length > 0 &&
    schema.projections.some(
      (entry) =>
        entry.source === undefined ||
        entry.displayOnly === undefined ||
        entry.writeOrder === undefined
    )
  ) {
    problems.push({
      code: "INCOMPLETE_PROJECTION_METADATA",
      path: "/projections",
      message:
        "projection source, displayOnly, and writeOrder must be declared together"
    });
  }
  for (const projection of schema.projections) {
    if (!fieldKeys.has(projection.fieldKey)) {
      problems.push({
        code: "UNKNOWN_PROJECTION_FIELD",
        path: `/projections/${projection.slot}`,
        message: `projection references unknown field key ${projection.fieldKey}`
      });
    }
  }
  const declaredSlots = new Set(schema.projections.map((entry) => entry.slot));
  const demoOnlySlots = [
    "journey-stage",
    "demo-project-profile",
    "target-repository",
    "run-attempt",
    "current-draft-pr",
    "current-stage-agent"
  ] as const;
  const requiredSlots: readonly GitHubProjectProjectionSlot[] =
    demoOnlySlots.some((slot) => declaredSlots.has(slot))
      ? DEMO_PROJECTION_VOCABULARY.map((entry) => entry.key)
      : [
          "stage",
          "depth-profile",
          "domain-pack",
          "gate-status",
          "contract-revision",
          "last-receipt",
          "attention"
        ];
  for (const slot of requiredSlots) {
    if (!declaredSlots.has(slot)) {
      problems.push({
        code: "MISSING_PROJECTION",
        path: "/projections",
        message: `required projection slot ${slot} is missing`
      });
    }
  }
  return problems;
}

const DEMO_PROJECTION_SOURCES = {
  stage: "kernel-snapshot",
  "journey-stage": "signed-stage-receipt",
  "demo-project-profile": "project-profile",
  "depth-profile": "work-accord",
  "gate-status": "demo-run-state",
  "contract-revision": "work-accord",
  "last-receipt": "signed-stage-receipt",
  attention: "demo-run-state",
  "target-repository": "trusted-binding",
  "run-attempt": "demo-run-state",
  "current-draft-pr": "demo-run-state",
  "current-stage-agent": "stage-agent-selection",
  "stage-interaction": "stage-agent-binding-set",
  "agent-selection-status": "stage-agent-selection"
} as const;

const DEMO_PROJECT_TITLES: Readonly<Record<DemoProjectId, string>> = {
  "app-modernization": "App Modernization - Hyperfinite",
  "feature-delivery": "Feature Delivery - Hyperfinite",
  "security-dependency-remediation":
    "Security Dependency Remediation - Hyperfinite",
  "adaptive-delivery": "Adaptive Delivery - Hyperfinite"
};

const CORE_STAGE_OPTIONS = [
  { key: "captured", name: "Captured", color: "GRAY" },
  {
    key: "activation-pending",
    name: "Activation pending",
    color: "YELLOW"
  },
  { key: "framing", name: "Framing", color: "BLUE" },
  { key: "planned", name: "Planned", color: "PURPLE" },
  { key: "executing", name: "Executing", color: "PINK" },
  { key: "verifying", name: "Verifying", color: "ORANGE" },
  { key: "human-review", name: "Human review", color: "YELLOW" },
  { key: "completed", name: "Completed", color: "GREEN" },
  { key: "paused", name: "Paused", color: "ORANGE" },
  { key: "blocked", name: "Blocked", color: "RED" },
  { key: "cancelled", name: "Cancelled", color: "GRAY" }
] as const satisfies readonly {
  readonly key: string;
  readonly name: string;
  readonly color: GitHubProjectOptionColor;
}[];

const DEMO_JOURNEY_STAGE_COLORS = {
  "app-modernization": {
    intake: "GRAY",
    "repository-discovery": "BLUE",
    "current-state-inventory": "BLUE",
    "modernization-assessment": "PURPLE",
    "target-architecture": "PURPLE",
    "migration-plan": "PURPLE",
    implementation: "PINK",
    verification: "ORANGE",
    "human-review": "YELLOW",
    completed: "GREEN",
    "activation-pending": "YELLOW",
    paused: "ORANGE",
    blocked: "RED",
    cancelled: "GRAY"
  },
  "feature-delivery": {
    intake: "GRAY",
    "requirements-clarification": "BLUE",
    "codebase-discovery": "BLUE",
    "solution-design": "PURPLE",
    "implementation-plan": "PURPLE",
    build: "PINK",
    "test-and-verification": "ORANGE",
    "human-review": "YELLOW",
    completed: "GREEN",
    "activation-pending": "YELLOW",
    paused: "ORANGE",
    blocked: "RED",
    cancelled: "GRAY"
  },
  "security-dependency-remediation": {
    intake: "GRAY",
    triage: "BLUE",
    "reproduction-and-impact-analysis": "PURPLE",
    "remediation-design": "PURPLE",
    "patch-planning": "PURPLE",
    "patch-implementation": "PINK",
    "security-verification": "ORANGE",
    "human-review": "YELLOW",
    completed: "GREEN",
    "activation-pending": "YELLOW",
    paused: "ORANGE",
    blocked: "RED",
    cancelled: "GRAY"
  },
  "adaptive-delivery": {
    intake: "GRAY",
    "context-inventory": "BLUE",
    "discovery-studio": "BLUE",
    "guided-synthesis": "PURPLE",
    "implementation-plan": "PURPLE",
    "implementation-studio": "PINK",
    "test-and-verification": "ORANGE",
    "human-review": "YELLOW",
    completed: "GREEN",
    "activation-pending": "YELLOW",
    paused: "ORANGE",
    blocked: "RED",
    cancelled: "GRAY"
  }
} as const satisfies Readonly<
  Record<DemoProjectId, Readonly<Record<string, GitHubProjectOptionColor>>>
>;

function journeyStageColor(
  demoProjectId: DemoProjectId,
  stageId: string
): GitHubProjectOptionColor {
  const color: GitHubProjectOptionColor | undefined =
    DEMO_JOURNEY_STAGE_COLORS[demoProjectId][
      stageId as keyof (typeof DEMO_JOURNEY_STAGE_COLORS)[DemoProjectId]
    ];
  if (color === undefined) {
    fail(`Project color is not declared for ${demoProjectId}/${stageId}`);
  }
  return color;
}

export const ADAPTIVE_DELIVERY_AGENT_OPTIONS = [
  {
    key: "discovery-customer-value-explorer",
    name: "Discovery - Customer Value Explorer",
    color: "BLUE"
  },
  {
    key: "discovery-technical-options-explorer",
    name: "Discovery - Technical Options Explorer",
    color: "BLUE"
  },
  {
    key: "discovery-delivery-risk-challenger",
    name: "Discovery - Delivery Risk Challenger",
    color: "BLUE"
  },
  {
    key: "implementation-minimal-slice-builder",
    name: "Implementation - Minimal Slice Builder",
    color: "PURPLE"
  },
  {
    key: "implementation-resilience-first-builder",
    name: "Implementation - Resilience-First Builder",
    color: "PURPLE"
  }
] as const satisfies readonly {
  readonly key: string;
  readonly name: string;
  readonly color: GitHubProjectOptionColor;
}[];

const ADAPTIVE_DELIVERY_OPTION_BINDINGS = [
  {
    ...ADAPTIVE_DELIVERY_AGENT_OPTIONS[0],
    stageId: "discovery-studio",
    agentId: "adaptive-delivery-customer-value-explorer"
  },
  {
    ...ADAPTIVE_DELIVERY_AGENT_OPTIONS[1],
    stageId: "discovery-studio",
    agentId: "adaptive-delivery-technical-options-explorer"
  },
  {
    ...ADAPTIVE_DELIVERY_AGENT_OPTIONS[2],
    stageId: "discovery-studio",
    agentId: "adaptive-delivery-delivery-risk-challenger"
  },
  {
    ...ADAPTIVE_DELIVERY_AGENT_OPTIONS[3],
    stageId: "implementation-studio",
    agentId: "adaptive-delivery-minimal-slice-builder"
  },
  {
    ...ADAPTIVE_DELIVERY_AGENT_OPTIONS[4],
    stageId: "implementation-studio",
    agentId: "adaptive-delivery-resilience-first-builder"
  }
] as const;

const DEMO_ISSUE_FORM_AUTHORITY = {
  credentials: "denied",
  budgetReservation: "denied",
  inference: "denied",
  issueCreation: "denied"
} as const;

export const DEMO_ISSUE_FORM_LIMITS = {
  desiredOutcomeBytes: 2048,
  repositoryHintBytes: 256,
  constraintsBytes: 4096,
  acceptanceEvidenceBytes: 4096,
  totalBytes: 10496
} as const;

function fail(message: string): never {
  throw new TypeError(message);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function immutableCanonicalSnapshot<T>(value: T): T {
  return deepFreeze(JSON.parse(canonicalJson(value)) as T);
}

function projectBindingMatchesSchema(
  binding: GitHubProjectBinding,
  schema: GitHubProjectSchema
): boolean {
  const nodeIds = binding.fields.flatMap((field) => [
    field.nodeId,
    ...field.options.map((option) => option.nodeId)
  ]);
  return (
    new Set(nodeIds).size === nodeIds.length &&
    binding.projectSchemaDigest === digest(schema) &&
    binding.project.title === schema.project.title &&
    canonicalJson(
      binding.fields.map((field) => ({
        key: field.key,
        name: field.name,
        dataType: field.dataType,
        options: field.options.map((option) => ({
          key: option.key,
          name: option.name,
          color: option.color,
          description: option.description
        }))
      }))
    ) ===
      canonicalJson(
        schema.fields.map((field) => ({
          key: field.key,
          name: field.name,
          dataType: field.dataType,
          options: field.options.map((option) => ({
            key: option.key,
            name: option.name,
            color: option.color,
            description: option.description ?? ""
          }))
        }))
      )
  );
}

function projectFor(
  reservations: DemoIdentityReservationManifest,
  demoProjectId: DemoProjectId
): DemoIdentityReservationManifest["spec"]["projects"][number] {
  const project = reservations.spec.projects.find(
    (candidate) => candidate.demoProjectId === demoProjectId
  );
  if (project === undefined) {
    fail(`unknown demo project ${demoProjectId}`);
  }
  return project;
}

function catalogEntryFor(
  catalog: DemoCatalog,
  demoProjectId: DemoProjectId
): DemoCatalog["spec"]["entries"][number] {
  const entry = catalog.spec.entries.find(
    (candidate) => candidate.id === demoProjectId
  );
  if (entry === undefined) {
    fail(`unknown demo catalog entry ${demoProjectId}`);
  }
  return entry;
}

function demoProjectSchemaPath(demoProjectId: DemoProjectId): string {
  return `config/v1alpha1/demo-projects/${demoProjectId}/project-schema.json`;
}

function demoIssueFormPath(demoProjectId: DemoProjectId): string {
  return `.github/ISSUE_TEMPLATE/${demoProjectId}.yml`;
}

function expectedDemoProjectSchema(input: {
  readonly catalog: DemoCatalog;
  readonly reservations: DemoIdentityReservationManifest;
  readonly coreSchema: GitHubProjectSchema;
  readonly demoProjectId: DemoProjectId;
}): GitHubProjectSchema {
  const entry = catalogEntryFor(input.catalog, input.demoProjectId);
  const project = projectFor(input.reservations, input.demoProjectId);
  const coreStage = input.coreSchema.fields.find(
    (field) => field.key === "stage"
  );
  if (
    coreStage === undefined ||
    coreStage.name !== "Stage" ||
    coreStage.dataType !== "SINGLE_SELECT" ||
    canonicalJson(coreStage.options) !== canonicalJson(CORE_STAGE_OPTIONS)
  ) {
    fail("core Project schema does not contain the canonical colored Stage field");
  }
  return {
    apiVersion: input.coreSchema.apiVersion,
    kind: "GitHubProjectSchema",
    metadata: {
      name: input.demoProjectId,
      version: "2.0.0"
    },
    owner: {
      type: "organization",
      login: input.coreSchema.owner.login
    },
    project: {
      title: DEMO_PROJECT_TITLES[input.demoProjectId],
      shortDescription:
        input.demoProjectId === "adaptive-delivery"
          ? "Guided hybrid-agent journey; Project choices are untrusted intent."
          : `${entry.title} locked projection of deterministic Kernel and receipt state.`
    },
    fields: [
      {
        key: "stage",
        name: "Stage",
        dataType: "SINGLE_SELECT",
        required: true,
        options: coreStage.options
      },
      {
        key: "journey-stage",
        name: "Journey Stage",
        dataType: "SINGLE_SELECT",
        required: true,
        options: [...project.journeyStages, ...project.controlStages].map(
          (stage) => ({
            key: stage.stageId,
            name: stage.displayName,
            color: journeyStageColor(input.demoProjectId, stage.stageId)
          })
        )
      },
      {
        key: "demo-project-profile",
        name: "Demo Project Profile",
        dataType: "TEXT",
        required: true,
        options: []
      },
      {
        key: "depth-profile",
        name: "Depth Profile",
        dataType: "SINGLE_SELECT",
        required: true,
        options: [
          { key: "d0", name: "D0", color: "GRAY" },
          { key: "d1", name: "D1", color: "BLUE" },
          { key: "d2", name: "D2", color: "PURPLE" },
          { key: "d3", name: "D3", color: "PINK" }
        ]
      },
      {
        key: "gate-status",
        name: "Gate Status",
        dataType: "SINGLE_SELECT",
        required: true,
        options: [
          { key: "pending", name: "Pending", color: "YELLOW" },
          { key: "satisfied", name: "Satisfied", color: "GREEN" },
          { key: "blocked", name: "Blocked", color: "RED" }
        ]
      },
      {
        key: "contract-revision",
        name: "Contract Revision",
        dataType: "NUMBER",
        required: true,
        options: []
      },
      {
        key: "last-receipt",
        name: "Last Receipt",
        dataType: "TEXT",
        required: true,
        options: []
      },
      {
        key: "attention",
        name: "Attention",
        dataType: "SINGLE_SELECT",
        required: true,
        options: [
          { key: "none", name: "None", color: "GRAY" },
          { key: "human-action", name: "Human action", color: "YELLOW" },
          { key: "reconciliation", name: "Reconciliation", color: "ORANGE" }
        ]
      },
      {
        key: "target-repository",
        name: "Target Repository",
        dataType: "TEXT",
        required: true,
        options: []
      },
      {
        key: "run-attempt",
        name: "Run / Attempt",
        dataType: "TEXT",
        required: true,
        options: []
      },
      {
        key: "current-draft-pr",
        name: "Current Draft PR",
        dataType: "TEXT",
        required: true,
        options: []
      },
      {
        key: "current-stage-agent",
        name: "Current Stage Agent",
        dataType: "TEXT",
        required: true,
        options: []
      },
      {
        key: "stage-interaction",
        name: "Stage Interaction",
        dataType: "SINGLE_SELECT",
        required: true,
        options: [
          { key: "backend-autonomous", name: "Backend autonomous", color: "BLUE" },
          {
            key: "user-selectable",
            name: "User-selectable agent",
            color: "PURPLE"
          },
          { key: "human-gate", name: "Human gate", color: "YELLOW" },
          { key: "deterministic", name: "Deterministic", color: "GREEN" },
          { key: "kernel-control", name: "Kernel control", color: "ORANGE" },
          { key: "terminal", name: "Terminal", color: "GRAY" }
        ]
      },
      {
        key: "requested-stage-agent",
        name: "Requested Stage Agent",
        dataType: "SINGLE_SELECT",
        required: false,
        options:
          input.demoProjectId === "adaptive-delivery"
            ? ADAPTIVE_DELIVERY_AGENT_OPTIONS
            : [
                {
                  key: "selection-unavailable-locked",
                  name: "User selection unavailable - locked project",
                  color: "GRAY"
                }
              ]
      },
      {
        key: "agent-selection-status",
        name: "Agent Selection Status",
        dataType: "SINGLE_SELECT",
        required: true,
        options: [
          { key: "not-applicable", name: "not-applicable", color: "GRAY" },
          {
            key: "awaiting-selection",
            name: "awaiting-selection",
            color: "YELLOW"
          },
          { key: "accepted", name: "accepted", color: "GREEN" },
          { key: "invalid", name: "invalid", color: "RED" },
          { key: "stale", name: "stale", color: "ORANGE" },
          {
            key: "reconciliation-required",
            name: "reconciliation-required",
            color: "PURPLE"
          }
        ]
      }
    ],
    projections: DEMO_PROJECTION_VOCABULARY.map((field, index) => ({
      slot: field.key,
      fieldKey: field.key,
      source: DEMO_PROJECTION_SOURCES[field.key],
      displayOnly: true,
      writeOrder:
        field.key === "stage" ? DEMO_PROJECTION_VOCABULARY.length : index
    }))
  };
}

export interface ValidatedDemoProjectSchemaCatalog {
  readonly catalog: DemoCatalog;
  readonly reservations: DemoIdentityReservationManifest;
  readonly coreSchema: GitHubProjectSchema;
  readonly entries: readonly DemoGitHubProjectSchemaEntry[];
}

export function validateDemoProjectSchemaCatalog(input: {
  readonly catalog: unknown;
  readonly reservations: unknown;
  readonly coreSchema: unknown;
  readonly entries: readonly DemoGitHubProjectSchemaEntry[];
}): ValidatedDemoProjectSchemaCatalog {
  const { catalog, reservations } = validatePortfolioFoundation(
    input.catalog,
    input.reservations
  );
  const coreSchema = immutableCanonicalSnapshot(
    assertDocument("GitHubProjectSchema", input.coreSchema)
  );
  const coreProblems = validateProjectSchemaSemantics(coreSchema);
  if (coreProblems.length > 0) {
    fail(
      `core Project schema is invalid: ${coreProblems
        .map((problem) => `${problem.path} ${problem.message}`)
        .join("; ")}`
    );
  }
  if (input.entries.length !== catalog.spec.entries.length) {
    fail(
      `demo Project schema catalog must contain exactly ${catalog.spec.entries.length} entries`
    );
  }
  const entries = input.entries.map((entry, index) => {
    const catalogEntry = catalog.spec.entries[index];
    if (
      catalogEntry === undefined ||
      entry.demoProjectId !== catalogEntry.id
    ) {
      fail("demo Project schema catalog order differs from the Foundation catalog");
    }
    const schema = immutableCanonicalSnapshot(
      assertDocument("GitHubProjectSchema", entry.schema)
    );
    const problems = validateProjectSchemaSemantics(schema);
    if (problems.length > 0) {
      fail(
        `${entry.demoProjectId} Project schema is invalid: ${problems
          .map((problem) => `${problem.path} ${problem.message}`)
          .join("; ")}`
      );
    }
    const expected = expectedDemoProjectSchema({
      catalog,
      reservations,
      coreSchema,
      demoProjectId: entry.demoProjectId
    });
    if (canonicalJson(schema) !== canonicalJson(expected)) {
      fail(
        `${entry.demoProjectId} Project schema differs from the exact Foundation projection`
      );
    }
    return {
      demoProjectId: entry.demoProjectId,
      schema
    };
  });
  return immutableCanonicalSnapshot({
    catalog,
    reservations,
    coreSchema,
    entries
  });
}

function revalidateDemoProjectSchemaCatalog(
  projectSchemas: ValidatedDemoProjectSchemaCatalog
): ValidatedDemoProjectSchemaCatalog {
  return validateDemoProjectSchemaCatalog({
    catalog: projectSchemas.catalog,
    reservations: projectSchemas.reservations,
    coreSchema: projectSchemas.coreSchema,
    entries: projectSchemas.entries
  });
}

export function createDemoIssueFormBindings(
  projectSchemas: ValidatedDemoProjectSchemaCatalog
): readonly DemoIssueFormBinding[] {
  const validated = revalidateDemoProjectSchemaCatalog(projectSchemas);
  return Object.freeze(
    validated.entries.map(({ demoProjectId, schema }) => {
      const entry = catalogEntryFor(validated.catalog, demoProjectId);
      return Object.freeze({
        demoProjectId,
        title: entry.title,
        formId: demoProjectId,
        issueFormPath: demoIssueFormPath(demoProjectId),
        projectSchemaPath: demoProjectSchemaPath(demoProjectId),
        projectProfileRef: entry.projectProfileRef,
        projectSchemaDigest: digest(schema),
        consentField: "demo-consent"
      });
    })
  );
}

export function expectedDemoIssueFormDefinition(
  binding: DemoIssueFormBinding
): Readonly<Record<string, unknown>> {
  return {
    name: binding.title,
    description: `Request the bounded ${binding.title} demonstration.`,
    title: `[${binding.title}] `,
    labels: [],
    assignees: [],
    body: [
      {
        type: "markdown",
        attributes: {
          value:
            "Customer evaluation input only. File this form from the customer-owned repository after the evaluation ticket and fixed budget are approved. Use synthetic data; do not include credentials, private IDs, customer source, personal data, or confidential logs. Form values are untrusted intake data, and the repository entry is a hint only; trusted bindings, the Control Kernel, and human gates retain all authority."
        }
      },
      {
        type: "textarea",
        id: "desired-outcome",
        attributes: {
          label: "Desired outcome",
          description: `Describe one outcome in at most ${DEMO_ISSUE_FORM_LIMITS.desiredOutcomeBytes} UTF-8 bytes.`,
          placeholder: "Describe the bounded repository outcome."
        },
        validations: { required: true }
      },
      {
        type: "input",
        id: "repository-hint",
        attributes: {
          label: "Repository hint",
          description: `Provide an operator hint in at most ${DEMO_ISSUE_FORM_LIMITS.repositoryHintBytes} UTF-8 bytes. This value never selects the trusted repository.`,
          placeholder: "example/example-repository"
        },
        validations: { required: true }
      },
      {
        type: "textarea",
        id: "constraints",
        attributes: {
          label: "Constraints",
          description: `List constraints in at most ${DEMO_ISSUE_FORM_LIMITS.constraintsBytes} UTF-8 bytes. Enter None when no additional constraints are known.`,
          placeholder: "Paths, compatibility requirements, and prohibited changes."
        },
        validations: { required: true }
      },
      {
        type: "textarea",
        id: "acceptance-evidence",
        attributes: {
          label: "Acceptance criteria and evidence",
          description: `Describe acceptance criteria or evidence in at most ${DEMO_ISSUE_FORM_LIMITS.acceptanceEvidenceBytes} UTF-8 bytes.`,
          placeholder: "State the checks and evidence a human reviewer should inspect."
        },
        validations: { required: true }
      },
      {
        type: "dropdown",
        id: "depth-profile",
        attributes: {
          label: "Depth profile",
          description:
            "Request a depth. Trusted profile policy may only narrow or reject this request.",
          options: ["D0", "D1", "D2", "D3"]
        },
        validations: { required: true }
      },
      {
        type: "checkboxes",
        id: binding.consentField,
        attributes: {
          label: "Explicit demo consent",
          description:
            "Consent is required but grants no repository, Project, capability, credential, transition, or effect authority.",
          options: [
            {
              label: `I consent to start the pre-authorized ${binding.title} demonstration and consume only its fixed trusted budget.`,
              required: true
            }
          ]
        },
        validations: { required: true }
      }
    ]
  };
}

export function validateDemoIssueFormDefinition(
  binding: DemoIssueFormBinding,
  value: unknown
): void {
  if (
    canonicalJson(value) !==
    canonicalJson(expectedDemoIssueFormDefinition(binding))
  ) {
    fail(`${binding.formId} issue form differs from its trusted static binding`);
  }
}

type SubmissionNormalization =
  | {
      readonly ok: true;
      readonly submission: DemoIssueIntakeSubmission;
      readonly digest: Digest;
      readonly missingField: DemoIssueIntakeField | null;
    }
  | {
      readonly ok: false;
      readonly code: "CONTENT_MALFORMED" | "CONTENT_OVERSIZED";
      readonly message: string;
    };

function normalizeIssueFormSubmission(
  value: unknown
): SubmissionNormalization {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return {
      ok: false,
      code: "CONTENT_MALFORMED",
      message: "issue-form submission must be one plain closed object"
    };
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const expectedKeys = [
    "acceptanceEvidence",
    "consent",
    "constraints",
    "depthProfile",
    "desiredOutcome",
    "repositoryHint"
  ];
  if (
    Object.keys(descriptors).sort().join(",") !== expectedKeys.join(",") ||
    Object.values(descriptors).some(
      (descriptor) => !("value" in descriptor)
    )
  ) {
    return {
      ok: false,
      code: "CONTENT_MALFORMED",
      message: "issue-form submission contains missing, unknown, or computed fields"
    };
  }
  const record = Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      "value" in descriptor ? descriptor.value : undefined
    ])
  ) as Record<string, unknown>;
  if (
    typeof record.desiredOutcome !== "string" ||
    typeof record.repositoryHint !== "string" ||
    typeof record.constraints !== "string" ||
    typeof record.acceptanceEvidence !== "string" ||
    typeof record.depthProfile !== "string" ||
    typeof record.consent !== "boolean" ||
    !["D0", "D1", "D2", "D3"].includes(record.depthProfile)
  ) {
    return {
      ok: false,
      code: "CONTENT_MALFORMED",
      message: "issue-form submission field types or depth are invalid"
    };
  }
  const invalidControl = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
  const normalizeText = (text: string): string =>
    text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
  const desiredOutcome = normalizeText(record.desiredOutcome);
  const repositoryHint = normalizeText(record.repositoryHint);
  const constraints = normalizeText(record.constraints);
  const acceptanceEvidence = normalizeText(record.acceptanceEvidence);
  if (
    [desiredOutcome, repositoryHint, constraints, acceptanceEvidence].some(
      (text) => invalidControl.test(text)
    )
  ) {
    return {
      ok: false,
      code: "CONTENT_MALFORMED",
      message: "issue-form submission contains disallowed control characters"
    };
  }
  const encoder = new TextEncoder();
  const lengths = {
    desiredOutcome: encoder.encode(desiredOutcome).byteLength,
    repositoryHint: encoder.encode(repositoryHint).byteLength,
    constraints: encoder.encode(constraints).byteLength,
    acceptanceEvidence: encoder.encode(acceptanceEvidence).byteLength
  };
  if (
    lengths.desiredOutcome > DEMO_ISSUE_FORM_LIMITS.desiredOutcomeBytes ||
    lengths.repositoryHint > DEMO_ISSUE_FORM_LIMITS.repositoryHintBytes ||
    lengths.constraints > DEMO_ISSUE_FORM_LIMITS.constraintsBytes ||
    lengths.acceptanceEvidence >
      DEMO_ISSUE_FORM_LIMITS.acceptanceEvidenceBytes ||
    Object.values(lengths).reduce((total, length) => total + length, 0) >
      DEMO_ISSUE_FORM_LIMITS.totalBytes
  ) {
    return {
      ok: false,
      code: "CONTENT_OVERSIZED",
      message: "issue-form submission exceeds its fixed UTF-8 byte budget"
    };
  }
  const submission: DemoIssueIntakeSubmission = {
    desiredOutcome,
    repositoryHint,
    constraints,
    acceptanceEvidence,
    depthProfile: record.depthProfile as DemoIssueIntakeSubmission["depthProfile"],
    consent: record.consent
  };
  const missingField =
    ([
      ["desired-outcome", desiredOutcome],
      ["repository-hint", repositoryHint],
      ["constraints", constraints],
      ["acceptance-evidence", acceptanceEvidence]
    ] as const).find(([, content]) => content.length === 0)?.[0] ?? null;
  return {
    ok: true,
    submission,
    digest: digest(submission),
    missingField
  };
}

function missingInformationRequest(input: {
  readonly binding: DemoIssueFormBinding;
  readonly issueNodeId: string;
  readonly submissionDigest: Digest;
  readonly field: DemoIssueIntakeField;
}): DemoMissingInformationRequest {
  const requests: Readonly<Record<DemoIssueIntakeField, string>> = {
    "desired-outcome": "Provide one concrete desired outcome.",
    "repository-hint":
      "Provide one repository hint for trusted operator resolution.",
    constraints: "Provide the applicable constraints or enter None.",
    "acceptance-evidence":
      "Provide the acceptance criteria or evidence a human should inspect."
  };
  const spec = {
    demoProjectId: input.binding.demoProjectId,
    issueNodeId: input.issueNodeId,
    field: input.field,
    request: requests[input.field],
    evidence: {
      kind: "issue-form-submission" as const,
      formId: input.binding.formId,
      submissionDigest: input.submissionDigest
    }
  };
  const envelope = {
    apiVersion: "agentic-framework.github.com/v1alpha1" as const,
    kind: "DemoMissingInformationRequest" as const,
    schemaVersion: "1.0.0" as const,
    spec
  };
  return {
    ...envelope,
    contentDigest: digest(envelope)
  };
}

function blockedIntake(input: {
  readonly demoProjectId: DemoProjectId;
  readonly state: "ACTIVATION_PENDING" | "BLOCKED";
  readonly code: DemoIssueIntakeBlockCode;
  readonly message: string;
  readonly submissionDigest: Digest | null;
  readonly missingInformation?: DemoMissingInformationRequest;
}): DemoIssueIntakeDecision {
  return {
    status: "blocked",
    state: input.state,
    demoProjectId: input.demoProjectId,
    code: input.code,
    message: input.message,
    submissionDigest: input.submissionDigest,
    missingInformation: input.missingInformation ?? null,
    authority: DEMO_ISSUE_FORM_AUTHORITY
  };
}

export function validateDemoIssueIntake(input: {
  readonly catalog: unknown;
  readonly reservations: unknown;
  readonly coreSchema: unknown;
  readonly schema: unknown;
  readonly binding: DemoIssueFormBinding;
  readonly profile: unknown;
  readonly activation: unknown | null;
  readonly repositoryBindingDigest: Digest | null;
  readonly projectBinding: unknown | null;
  readonly submission: unknown;
  readonly submitterId: number;
  readonly issueNodeId: string;
  readonly evaluatedAt: string;
  readonly maxProjectBindingAgeMs: number;
}): DemoIssueIntakeDecision {
  const { catalog, reservations } = validatePortfolioFoundation(
    input.catalog,
    input.reservations
  );
  const coreSchema = assertDocument("GitHubProjectSchema", input.coreSchema);
  const schema = assertDocument("GitHubProjectSchema", input.schema);
  validateDemoProjectSchemaCatalog({
    catalog,
    reservations,
    coreSchema,
    entries: catalog.spec.entries.map((entry) => ({
      demoProjectId: entry.id,
      schema:
        entry.id === input.binding.demoProjectId
          ? schema
          : expectedDemoProjectSchema({
              catalog,
              reservations,
              coreSchema,
              demoProjectId: entry.id
            })
    }))
  });
  const entry = catalogEntryFor(catalog, input.binding.demoProjectId);
  const expectedBinding: DemoIssueFormBinding = {
    demoProjectId: entry.id,
    title: entry.title,
    formId: entry.id,
    issueFormPath: demoIssueFormPath(entry.id),
    projectSchemaPath: demoProjectSchemaPath(entry.id),
    projectProfileRef: entry.projectProfileRef,
    projectSchemaDigest: digest(schema),
    consentField: "demo-consent"
  };
  const profile = validateDemoContract("DemoProjectProfile", input.profile);
  if (
    canonicalJson(input.binding) !== canonicalJson(expectedBinding) ||
    profile.spec.demoProjectId !== input.binding.demoProjectId ||
    profile.spec.catalogDigest !== catalog.contentDigest ||
    profile.spec.identityReservationsDigest !== reservations.contentDigest ||
    profile.spec.title !== input.binding.title ||
    profile.spec.journeyDefinitionRef !== entry.journeyDefinitionRef ||
    profile.spec.stageAgentBindingsRef !== entry.stageAgentBindingsRef ||
    profile.spec.capabilityShardRef !== entry.capabilityShardRef ||
    profile.spec.activationProfileRef !== entry.activationProfileRef ||
    profile.spec.projectionMappingRef !== entry.projectionMappingRef
  ) {
    return blockedIntake({
      demoProjectId: input.binding.demoProjectId,
      state: "BLOCKED",
      code: "FORM_PROFILE_MISMATCH",
      message: "issue form, Project schema, and trusted demo profile do not match",
      submissionDigest: null
    });
  }
  if (
    !Number.isSafeInteger(input.submitterId) ||
    input.submitterId < 1 ||
    input.issueNodeId.length < 1 ||
    input.issueNodeId.length > 256 ||
    !isCanonicalUtcDateTime(input.evaluatedAt) ||
    !Number.isSafeInteger(input.maxProjectBindingAgeMs) ||
    input.maxProjectBindingAgeMs < 1
  ) {
    fail("trusted issue-intake context is malformed");
  }

  const normalized = normalizeIssueFormSubmission(input.submission);
  if (!normalized.ok) {
    return blockedIntake({
      demoProjectId: input.binding.demoProjectId,
      state: "BLOCKED",
      code: normalized.code,
      message: normalized.message,
      submissionDigest: null
    });
  }
  if (normalized.missingField !== null) {
    const missingInformation = missingInformationRequest({
      binding: input.binding,
      issueNodeId: input.issueNodeId,
      submissionDigest: normalized.digest,
      field: normalized.missingField
    });
    return blockedIntake({
      demoProjectId: input.binding.demoProjectId,
      state: "BLOCKED",
      code: "MISSING_INFORMATION",
      message: "one required issue-form field needs focused human input",
      submissionDigest: normalized.digest,
      missingInformation
    });
  }
  if (!normalized.submission.consent) {
    return blockedIntake({
      demoProjectId: input.binding.demoProjectId,
      state: "ACTIVATION_PENDING",
      code: "CONSENT_REQUIRED",
      message: "explicit consent to the fixed demo budget is required",
      submissionDigest: normalized.digest
    });
  }
  if (input.activation === null) {
    return blockedIntake({
      demoProjectId: input.binding.demoProjectId,
      state: "ACTIVATION_PENDING",
      code: "BUDGET_MISSING",
      message: "the trusted activation profile and its fixed budget are missing",
      submissionDigest: normalized.digest
    });
  }
  const activation = validateDemoContract(
    "DemoActivationProfile",
    input.activation
  );
  if (
    activation.spec.demoProjectId !== profile.spec.demoProjectId ||
    activation.spec.catalogDigest !== catalog.contentDigest ||
    activation.spec.projectProfileDigest !== profile.contentDigest ||
    activation.spec.consentField !== input.binding.consentField ||
    activation.spec.consentRequired !== true
  ) {
    return blockedIntake({
      demoProjectId: input.binding.demoProjectId,
      state: "BLOCKED",
      code: "FORM_PROFILE_MISMATCH",
      message: "activation profile does not bind the selected form and profile",
      submissionDigest: normalized.digest
    });
  }
  if (!activation.spec.enabled) {
    return blockedIntake({
      demoProjectId: input.binding.demoProjectId,
      state: "ACTIVATION_PENDING",
      code: "ACTIVATION_PROFILE_DISABLED",
      message: "the trusted activation profile is disabled",
      submissionDigest: normalized.digest
    });
  }
  if (!activation.spec.allowedSubmitterIds.includes(input.submitterId)) {
    return blockedIntake({
      demoProjectId: input.binding.demoProjectId,
      state: "BLOCKED",
      code: "SUBMITTER_UNAUTHORIZED",
      message: "the submitter is not authorized by the activation profile",
      submissionDigest: normalized.digest
    });
  }
  if (input.repositoryBindingDigest === null) {
    return blockedIntake({
      demoProjectId: input.binding.demoProjectId,
      state: "ACTIVATION_PENDING",
      code: "REPOSITORY_BINDING_UNRESOLVED",
      message: "trusted repository binding has not been resolved",
      submissionDigest: normalized.digest
    });
  }
  if (
    input.repositoryBindingDigest !== profile.spec.repositoryBindingDigest
  ) {
    return blockedIntake({
      demoProjectId: input.binding.demoProjectId,
      state: "BLOCKED",
      code: "REPOSITORY_BINDING_STALE",
      message:
        "trusted repository binding differs from the reviewed demo profile",
      submissionDigest: normalized.digest
    });
  }
  if (input.projectBinding === null) {
    return blockedIntake({
      demoProjectId: input.binding.demoProjectId,
      state: "BLOCKED",
      code: "PROJECT_BINDING_STALE",
      message: "validated Project binding is missing",
      submissionDigest: normalized.digest
    });
  }
  const projectBinding = assertDocument(
    "GitHubProjectBinding",
    input.projectBinding
  );
  const evaluatedAt = Date.parse(input.evaluatedAt);
  const validatedAt = Date.parse(projectBinding.validatedAt);
  if (
    projectBinding.projectSchemaDigest !== input.binding.projectSchemaDigest ||
    !projectBindingMatchesSchema(projectBinding, schema) ||
    digest(projectBinding) !== profile.spec.projectBindingDigest ||
    !Number.isFinite(validatedAt) ||
    validatedAt > evaluatedAt ||
    evaluatedAt - validatedAt > input.maxProjectBindingAgeMs
  ) {
    return blockedIntake({
      demoProjectId: input.binding.demoProjectId,
      state: "BLOCKED",
      code: "PROJECT_BINDING_STALE",
      message:
        "validated Project binding is stale or differs from the reviewed profile",
      submissionDigest: normalized.digest
    });
  }
  if (
    !profile.spec.allowedDepthProfiles.includes(
      normalized.submission.depthProfile
    )
  ) {
    return blockedIntake({
      demoProjectId: input.binding.demoProjectId,
      state: "ACTIVATION_PENDING",
      code: "DEPTH_PROFILE_NOT_ALLOWED",
      message: "requested depth is outside the trusted profile allowance",
      submissionDigest: normalized.digest
    });
  }
  if (
    activation.spec.leaseTemplate.maxCalls < 1 ||
    activation.spec.leaseTemplate.maxTokens < 1 ||
    activation.spec.leaseTemplate.maxCostUnits < 1
  ) {
    return blockedIntake({
      demoProjectId: input.binding.demoProjectId,
      state: "ACTIVATION_PENDING",
      code: "BUDGET_MISSING",
      message: "activation profile does not contain a usable fixed budget",
      submissionDigest: normalized.digest
    });
  }
  if (
    evaluatedAt < Date.parse(activation.spec.validFrom) ||
    evaluatedAt >= Date.parse(activation.spec.expiresAt)
  ) {
    return blockedIntake({
      demoProjectId: input.binding.demoProjectId,
      state: "ACTIVATION_PENDING",
      code: "ACTIVATION_WINDOW_INVALID",
      message: "activation profile is not current at the trusted evaluation time",
      submissionDigest: normalized.digest
    });
  }
  return {
    status: "ready-for-kernel-activation",
    state: "ACTIVATION_PENDING",
    demoProjectId: input.binding.demoProjectId,
    profileDigest: profile.contentDigest,
    projectSchemaDigest: input.binding.projectSchemaDigest,
    repositoryBindingDigest: input.repositoryBindingDigest,
    projectBindingDigest: profile.spec.projectBindingDigest,
    submissionDigest: normalized.digest,
    normalizedSubmission: normalized.submission,
    authority: DEMO_ISSUE_FORM_AUTHORITY
  };
}

export interface DemoProjectCatalogSetupPlan {
  readonly mode: "dry-run";
  readonly demoCatalogDigest: Digest;
  readonly valid: boolean;
  readonly entries: readonly {
    readonly demoProjectId: DemoProjectId;
    readonly plan: ProjectSetupPlan;
  }[];
}

export interface LiveDemoProjectAdminSnapshot {
  readonly observedAt: string;
  readonly owner: {
    readonly type: "organization";
    readonly login: string;
    readonly nodeId: string;
  };
  readonly repository: {
    readonly fullName: string;
    readonly nodeId: string;
  };
  readonly project: {
    readonly number: number;
    readonly nodeId: string;
    readonly title: string;
    readonly shortDescription: string | null;
    readonly readme: string | null;
    readonly public: boolean;
    readonly closed: boolean;
  };
  readonly linkedRepositories: readonly {
    readonly fullName: string;
    readonly nodeId: string;
  }[];
  readonly itemCount: number;
  readonly items: readonly {
    readonly nodeId: string;
    readonly contentNodeId: string;
    readonly title: string;
    readonly contentType: "issue" | "draft";
    readonly fieldValues: readonly {
      readonly fieldName: string;
      readonly dataType: "NUMBER" | "SINGLE_SELECT" | "TEXT";
      readonly value: string | number | null;
    }[];
  }[];
  readonly views: readonly {
    readonly nodeId: string;
    readonly name: string;
    readonly layout: string;
    readonly visibleFieldNames: readonly string[];
    readonly groupByFieldNames: readonly string[];
  }[];
  readonly fields: readonly {
    readonly nodeId: string;
    readonly name: string;
    readonly dataType: string;
    readonly options: readonly {
      readonly nodeId: string;
      readonly name: string;
      readonly color: GitHubProjectOptionColor;
      readonly description: string;
    }[];
  }[];
}

export type DemoProjectBootstrapOperation =
  | {
      readonly type: "set-project-description";
      readonly projectNodeId: string;
      readonly shortDescription: string;
      readonly requiresHumanAdmin: true;
    }
  | {
      readonly type: "set-project-readme";
      readonly projectNodeId: string;
      readonly readme: string;
      readonly requiresHumanAdmin: true;
    }
  | {
      readonly type: "create-field";
      readonly projectNodeId: string;
      readonly fieldKey: string;
      readonly name: string;
      readonly dataType: GitHubProjectFieldType;
      readonly options: readonly {
        readonly key: string;
        readonly name: string;
        readonly color: GitHubProjectOptionColor;
        readonly description: string;
      }[];
      readonly requiresHumanAdmin: true;
    };

export interface VerifiedDemoProjectBootstrapPlan {
  readonly mode: "reviewed-dry-run";
  readonly evaluatedAt: string;
  readonly targetManifestDigest: Digest;
  readonly demoCatalogDigest: Digest;
  readonly exactTargetNodeIds: readonly string[];
  readonly operations: readonly DemoProjectBootstrapOperation[];
  readonly seedBlueprints: readonly {
    readonly demoProjectId: DemoProjectId;
    readonly projectNodeId: string;
    readonly scenarioIssueTitle: string;
    readonly scenarioIssueNodeId: string;
    readonly additionalIssueNodeIds: readonly string[];
    readonly draftItems: readonly {
      readonly title: string;
      readonly fieldValues: readonly {
        readonly fieldKey: string;
        readonly value: string | number | null;
      }[];
    }[];
  }[];
  readonly manualViewSteps: readonly string[];
  readonly planDigest: Digest;
}

const BUILT_IN_PROJECT_FIELDS = new Set([
  "Title",
  "Assignees",
  "Status",
  "Labels",
  "Linked pull requests",
  "Milestone",
  "Repository",
  "Reviewers",
  "Parent issue",
  "Sub-issues progress",
  "Created",
  "Updated",
  "Closed"
]);

const SYNTHETIC_SCENARIO_TITLES: Readonly<Record<DemoProjectId, string>> = {
  "app-modernization": "[Demo] App modernization sample journey",
  "feature-delivery": "[Demo] Feature delivery sample journey",
  "security-dependency-remediation":
    "[Demo] Security remediation sample journey",
  "adaptive-delivery": "[Demo] Adaptive delivery hybrid sample journey"
};

const PROJECT_VIEW_VISIBLE_FIELD_NAMES = [
  "Title",
  "Stage Interaction",
  "Current Stage Agent",
  "Requested Stage Agent",
  "Agent Selection Status",
  "Gate Status",
  "Attention",
  "Run / Attempt"
] as const;

const SYNTHETIC_DEPTH: Readonly<Record<DemoProjectId, string>> = {
  "app-modernization": "D2",
  "feature-delivery": "D2",
  "security-dependency-remediation": "D3",
  "adaptive-delivery": "D2"
};

const CORE_STAGE_NAMES: Readonly<Record<string, string>> = {
  CAPTURED: "Captured",
  ACTIVATION_PENDING: "Activation pending",
  FRAMING: "Framing",
  PLANNED: "Planned",
  EXECUTING: "Executing",
  VERIFYING: "Verifying",
  HUMAN_REVIEW: "Human review",
  COMPLETED: "Completed",
  PAUSED: "Paused",
  BLOCKED: "Blocked",
  CANCELLED: "Cancelled"
};

function syntheticStageValues(input: {
  readonly demoProjectId: DemoProjectId;
  readonly logicalTitle: string;
  readonly repositoryFullName: string;
  readonly stage: DemoIdentityReservationManifest["spec"]["projects"][number]["journeyStages"][number] | DemoIdentityReservationManifest["spec"]["projects"][number]["controlStages"][number];
  readonly requestedAgent?: string | null;
  readonly selectedAgent?: string | null;
  readonly selectionStatus?: string;
  readonly blockedSelection?: boolean;
}): readonly {
  readonly fieldKey: string;
  readonly value: string | number | null;
}[] {
  const fixedAgent =
    input.stage.executionKind === "model" &&
    input.stage.runtimeBindings.length === 1
      ? input.stage.runtimeBindings[0]?.agentId ?? "Selection blocked"
      : null;
  const selectable =
    input.stage.executionKind === "model" &&
    input.stage.runtimeBindings.length > 1;
  const interaction =
    input.stage.executionKind === "kernel"
      ? "Kernel control"
      : fixedAgent !== null
        ? "Backend autonomous"
        : selectable
          ? "User-selectable agent"
          : input.stage.executionKind === "human"
            ? "Human gate"
            : input.stage.executionKind === "terminal"
              ? "Terminal"
              : "Deterministic";
  const currentAgent =
    input.blockedSelection === true
      ? "Selection blocked"
      : input.selectedAgent !== undefined && input.selectedAgent !== null
        ? input.selectedAgent
        : fixedAgent ??
          (selectable
            ? "Awaiting user selection"
            : input.stage.executionKind === "kernel"
              ? "Kernel controlled"
              : input.stage.executionKind === "terminal"
                ? "No active agent"
                : "No model agent");
  const selectionStatus =
    input.selectionStatus ??
    (selectable ? "awaiting-selection" : "not-applicable");
  const attention =
    input.blockedSelection === true || input.stage.coreState === "BLOCKED"
      ? "Reconciliation"
      : selectable &&
          input.selectedAgent === undefined &&
          input.stage.executionKind === "model"
        ? "Human action"
        : input.stage.executionKind === "planning" ||
            input.stage.executionKind === "human" ||
            input.stage.coreState === "ACTIVATION_PENDING" ||
            input.stage.coreState === "PAUSED"
          ? "Human action"
          : "None";
  const gateStatus =
    input.blockedSelection === true || input.stage.coreState === "BLOCKED"
      ? "Blocked"
      : input.stage.coreState === "COMPLETED"
        ? "Satisfied"
        : "Pending";
  return [
    {
      fieldKey: "stage",
      value: CORE_STAGE_NAMES[input.stage.coreState] ?? input.stage.coreState
    },
    { fieldKey: "journey-stage", value: input.stage.displayName },
    { fieldKey: "demo-project-profile", value: input.logicalTitle },
    { fieldKey: "depth-profile", value: SYNTHETIC_DEPTH[input.demoProjectId] },
    { fieldKey: "gate-status", value: gateStatus },
    { fieldKey: "contract-revision", value: 1 },
    { fieldKey: "last-receipt", value: "NO-RUNTIME-EVIDENCE" },
    { fieldKey: "attention", value: attention },
    {
      fieldKey: "target-repository",
      value: input.repositoryFullName
    },
    { fieldKey: "run-attempt", value: "DISPLAY-ONLY" },
    { fieldKey: "current-draft-pr", value: "NO-DRAFT-PR" },
    { fieldKey: "current-stage-agent", value: currentAgent },
    { fieldKey: "stage-interaction", value: interaction },
    {
      fieldKey: "requested-stage-agent",
      value:
        input.requestedAgent ??
        (input.demoProjectId === "adaptive-delivery"
          ? null
          : "User selection unavailable - locked project")
    },
    { fieldKey: "agent-selection-status", value: selectionStatus }
  ];
}

function projectReadme(
  demoProjectId: DemoProjectId,
  title: string,
  repositoryFullName: string
): string {
  const posture = demoProjectId === "adaptive-delivery" ? "guided" : "locked";
  return [
    `# ${title}`,
    "",
    `This demonstration Project visualizes the ${demoProjectId} journey in \`${repositoryFullName}\` with a **${posture}** agent-participation posture.`,
    "",
    "Journey Stage, Stage Interaction, Current Stage Agent, and Agent Selection Status are trusted projections. Requested Stage Agent is untrusted human intent and cannot dispatch a model until deterministic policy validation issues one signed exact-agent grant.",
    "",
    "> Cards prefixed with `[Synthetic display only]` are visual fixtures. They are not runtime state, signed evidence, approvals, receipts, or authorization and cannot invoke an agent or satisfy a gate.",
    "",
    "The lifecycle graph, Work Accord, policy compiler, Capability Registry, Control Kernel, trusted adapter, and Single Writer retain authority. Automation cannot approve, merge, deploy, or publish.",
    ...(demoProjectId === "adaptive-delivery"
      ? [
          "",
          "The epic and implementation issues added for dogfooding are planning trackers, not runtime items or authority evidence."
        ]
      : []),
    "",
    "Operator guidance: `docs/runbooks/github-project-setup.md`. To reset, remove only clearly marked synthetic display items and the matching synthetic scenario issue after human review; never delete fields or options automatically."
  ].join("\n");
}

export function createDemoProjectTargetManifest(input: {
  readonly projectSchemas: ValidatedDemoProjectSchemaCatalog;
  readonly snapshots: readonly {
    readonly demoProjectId: DemoProjectId;
    readonly snapshot: LiveDemoProjectAdminSnapshot;
  }[];
  readonly evaluatedAt: string;
  readonly maxSnapshotAgeMs: number;
}): DemoProjectTargetManifest {
  const schemas = revalidateDemoProjectSchemaCatalog(input.projectSchemas);
  if (
    !isCanonicalUtcDateTime(input.evaluatedAt) ||
    !Number.isSafeInteger(input.maxSnapshotAgeMs) ||
    input.maxSnapshotAgeMs < 1 ||
    !Array.isArray(input.snapshots) ||
    input.snapshots.length !== schemas.entries.length
  ) {
    fail("target-manifest inputs are incomplete");
  }
  const evaluatedAt = Date.parse(input.evaluatedAt);
  const snapshots = input.snapshots.map((entry, index) => {
    const schemaEntry = schemas.entries[index];
    if (
      schemaEntry === undefined ||
      entry.demoProjectId !== schemaEntry.demoProjectId
    ) {
      fail("target-manifest snapshots differ from catalog order");
    }
    const snapshot = immutableCanonicalSnapshot(
      assertDocument("GitHubProjectAdminSnapshot", entry.snapshot)
    );
    const observedAt = Date.parse(snapshot.observedAt);
    if (
      !isCanonicalUtcDateTime(snapshot.observedAt) ||
      !Number.isFinite(observedAt) ||
      observedAt > evaluatedAt ||
      evaluatedAt - observedAt > input.maxSnapshotAgeMs ||
      snapshot.project.title !==
        DEMO_PROJECT_TITLES[schemaEntry.demoProjectId] ||
      snapshot.project.public ||
      snapshot.project.closed ||
      snapshot.linkedRepositories.length !== 1 ||
      snapshot.linkedRepositories[0]?.fullName !==
        snapshot.repository.fullName ||
      snapshot.linkedRepositories[0]?.nodeId !== snapshot.repository.nodeId ||
      snapshot.itemCount !== 0 ||
      snapshot.items.length !== 0 ||
      snapshot.views.length !== 1 ||
      snapshot.views[0]?.name !== "View 1" ||
      snapshot.views[0]?.layout !== "BOARD_LAYOUT"
    ) {
      fail(`${entry.demoProjectId} is not a fresh empty Project target`);
    }
    return snapshot;
  });
  const first = snapshots[0];
  if (
    first === undefined ||
    snapshots.some(
      (snapshot) =>
        snapshot.owner.type !== first.owner.type ||
        snapshot.owner.login !== first.owner.login ||
        snapshot.owner.nodeId !== first.owner.nodeId ||
        snapshot.repository.fullName !== first.repository.fullName ||
        snapshot.repository.nodeId !== first.repository.nodeId
    ) ||
    new Set(snapshots.map((snapshot) => snapshot.project.number)).size !==
      snapshots.length ||
    new Set(snapshots.map((snapshot) => snapshot.project.nodeId)).size !==
      snapshots.length ||
    new Set(snapshots.map((snapshot) => snapshot.views[0]!.nodeId)).size !==
      snapshots.length
  ) {
    fail("target-manifest snapshots do not share one unique owner and repository");
  }
  return createDemoContract("DemoProjectTargetManifest", {
    owner: first.owner,
    repository: first.repository,
    projects: snapshots.map((snapshot, index) => ({
      demoProjectId: schemas.entries[index]!.demoProjectId,
      projectSchemaDigest: digest(schemas.entries[index]!.schema),
      title: snapshot.project.title,
      number: snapshot.project.number,
      nodeId: snapshot.project.nodeId,
      viewNodeId: snapshot.views[0]!.nodeId,
      visibility: "private" as const,
      closed: false as const,
      initialItemCount: 0 as const,
      initialViewName: "View 1" as const,
      initialViewLayout: "BOARD_LAYOUT" as const
    }))
  });
}

function exactTargetManifest(
  manifest: DemoProjectTargetManifest,
  expectedDigest: Digest
): void {
  if (manifest.contentDigest !== expectedDigest) {
    fail("Project target manifest differs from the human-confirmed digest");
  }
}

export function planVerifiedDemoProjectBootstrap(input: {
  readonly targetManifest: unknown;
  readonly expectedTargetManifestDigest: Digest;
  readonly projectSchemas: ValidatedDemoProjectSchemaCatalog;
  readonly snapshots: readonly {
    readonly demoProjectId: DemoProjectId;
    readonly snapshot: LiveDemoProjectAdminSnapshot;
  }[];
  readonly issueBindings: readonly {
    readonly demoProjectId: DemoProjectId;
    readonly scenarioIssueNodeId: string;
    readonly additionalIssueNodeIds: readonly string[];
  }[];
  readonly evaluatedAt: string;
  readonly maxSnapshotAgeMs: number;
}): VerifiedDemoProjectBootstrapPlan {
  const manifest = validateDemoContract(
    "DemoProjectTargetManifest",
    input.targetManifest
  );
  exactTargetManifest(manifest, input.expectedTargetManifestDigest);
  const schemas = revalidateDemoProjectSchemaCatalog(input.projectSchemas);
  if (
    !isCanonicalUtcDateTime(input.evaluatedAt) ||
    !Number.isSafeInteger(input.maxSnapshotAgeMs) ||
    input.maxSnapshotAgeMs < 1 ||
    !Array.isArray(input.snapshots) ||
    !Array.isArray(input.issueBindings) ||
    input.snapshots.length !== manifest.spec.projects.length ||
    input.issueBindings.length !== manifest.spec.projects.length
  ) {
    fail("verified Project bootstrap inputs are incomplete");
  }
  const allIssueNodeIds = input.issueBindings.flatMap((binding) => [
    binding.scenarioIssueNodeId,
    ...binding.additionalIssueNodeIds
  ]);
  if (
    new Set(allIssueNodeIds).size !== allIssueNodeIds.length ||
    input.issueBindings.some(
      (binding) =>
        binding.demoProjectId !== "adaptive-delivery" &&
        binding.additionalIssueNodeIds.length > 0
    )
  ) {
    fail(
      "Project bootstrap issue bindings must be globally unique and dogfood only Adaptive Delivery"
    );
  }
  const evaluatedAt = Date.parse(input.evaluatedAt);
  const operations: DemoProjectBootstrapOperation[] = [];
  const seedBlueprints: VerifiedDemoProjectBootstrapPlan["seedBlueprints"][number][] =
    [];
  for (let index = 0; index < manifest.spec.projects.length; index += 1) {
    const target = manifest.spec.projects[index];
    const observed = input.snapshots[index];
    const schemaEntry = schemas.entries[index];
    const issueBinding = input.issueBindings[index];
    if (
      target === undefined ||
      observed === undefined ||
      schemaEntry === undefined ||
      issueBinding === undefined ||
      observed.demoProjectId !== target.demoProjectId ||
      schemaEntry.demoProjectId !== target.demoProjectId ||
      issueBinding.demoProjectId !== target.demoProjectId ||
      issueBinding.scenarioIssueNodeId.length < 1 ||
      issueBinding.additionalIssueNodeIds.some(
        (nodeId: string) => nodeId.length < 1
      ) ||
      new Set(issueBinding.additionalIssueNodeIds).size !==
        issueBinding.additionalIssueNodeIds.length ||
      issueBinding.additionalIssueNodeIds.includes(
        issueBinding.scenarioIssueNodeId
      )
    ) {
      fail("Project bootstrap target, schema, and snapshot order differ");
    }
    const snapshot = immutableCanonicalSnapshot(
      assertDocument("GitHubProjectAdminSnapshot", observed.snapshot)
    );
    const observedAt = Date.parse(snapshot.observedAt);
    if (
      !isCanonicalUtcDateTime(snapshot.observedAt) ||
      !Number.isFinite(observedAt) ||
      observedAt > evaluatedAt ||
      evaluatedAt - observedAt > input.maxSnapshotAgeMs ||
      snapshot.owner.type !== manifest.spec.owner.type ||
      snapshot.owner.login !== manifest.spec.owner.login ||
      snapshot.owner.nodeId !== manifest.spec.owner.nodeId ||
      target.title !== DEMO_PROJECT_TITLES[target.demoProjectId] ||
      target.projectSchemaDigest !== digest(schemaEntry.schema) ||
      snapshot.repository.fullName !== manifest.spec.repository.fullName ||
      snapshot.repository.nodeId !== manifest.spec.repository.nodeId ||
      snapshot.project.number !== target.number ||
      snapshot.project.nodeId !== target.nodeId ||
      snapshot.project.title !== target.title ||
      snapshot.project.public ||
      snapshot.project.closed ||
      snapshot.linkedRepositories.length !== 1 ||
      snapshot.linkedRepositories[0]?.fullName !==
        manifest.spec.repository.fullName ||
      snapshot.linkedRepositories[0]?.nodeId !==
        manifest.spec.repository.nodeId ||
      snapshot.itemCount !== target.initialItemCount ||
      snapshot.items.length !== snapshot.itemCount ||
      snapshot.views.length !== 1 ||
      snapshot.views[0]?.nodeId !== target.viewNodeId ||
      snapshot.views[0]?.name !== target.initialViewName ||
      snapshot.views[0]?.layout !== target.initialViewLayout
    ) {
      fail(`${target.demoProjectId} live Project target drift blocks bootstrap`);
    }
    const unknownFields = snapshot.fields.filter(
      (field) =>
        !BUILT_IN_PROJECT_FIELDS.has(field.name) &&
        !schemaEntry.schema.fields.some((expected) => expected.name === field.name)
    );
    if (unknownFields.length > 0) {
      fail(`${target.demoProjectId} contains unexpected custom Project fields`);
    }
    if (
      snapshot.project.shortDescription !==
      schemaEntry.schema.project.shortDescription
    ) {
      operations.push({
        type: "set-project-description",
        projectNodeId: target.nodeId,
        shortDescription:
          schemaEntry.schema.project.shortDescription ?? "",
        requiresHumanAdmin: true
      });
    }
    const readme = projectReadme(
      target.demoProjectId,
      target.title,
      manifest.spec.repository.fullName
    );
    if (snapshot.project.readme !== readme) {
      operations.push({
        type: "set-project-readme",
        projectNodeId: target.nodeId,
        readme,
        requiresHumanAdmin: true
      });
    }
    for (const expectedField of schemaEntry.schema.fields) {
      const matches = snapshot.fields.filter(
        (field) => field.name === expectedField.name
      );
      if (matches.length === 0) {
        operations.push({
          type: "create-field",
          projectNodeId: target.nodeId,
          fieldKey: expectedField.key,
          name: expectedField.name,
          dataType: expectedField.dataType,
          options: expectedField.options.map((option) => ({
            ...option,
            description: option.description ?? ""
          })),
          requiresHumanAdmin: true
        });
        continue;
      }
      const existing = matches[0];
      if (
        matches.length !== 1 ||
        existing === undefined ||
        existing.dataType !== expectedField.dataType ||
        canonicalJson(
          existing.options.map((option) => ({
            name: option.name,
            color: option.color,
            description: option.description
          }))
        ) !==
          canonicalJson(
            expectedField.options.map((option) => ({
              name: option.name,
              color: option.color,
              description: option.description ?? ""
            }))
          )
      ) {
        fail(
          `${target.demoProjectId}/${expectedField.key} field drift requires human reconciliation`
        );
      }
    }
    const reservation = schemas.reservations.spec.projects[index];
    if (reservation?.demoProjectId !== target.demoProjectId) {
      fail("Project seed blueprint differs from the identity reservation order");
    }
    const reservedStages = [
      ...reservation.journeyStages,
      ...reservation.controlStages
    ];
    const draftItems = reservedStages.map((stage) => ({
      title: `[Synthetic display only] ${stage.displayName}`,
      fieldValues: syntheticStageValues({
        demoProjectId: target.demoProjectId,
        logicalTitle: schemas.catalog.spec.entries[index]!.title,
        repositoryFullName: manifest.spec.repository.fullName,
        stage
      })
    }));
    if (target.demoProjectId === "adaptive-delivery") {
      for (const option of ADAPTIVE_DELIVERY_OPTION_BINDINGS) {
        const stage = reservation.journeyStages.find(
          (candidate) => candidate.stageId === option.stageId
        )!;
        draftItems.push({
          title: `[Synthetic display only] ${option.name}`,
          fieldValues: syntheticStageValues({
            demoProjectId: target.demoProjectId,
            logicalTitle: schemas.catalog.spec.entries[index]!.title,
            repositoryFullName: manifest.spec.repository.fullName,
            stage,
            requestedAgent: option.name,
            selectedAgent: option.agentId,
            selectionStatus: "accepted"
          })
        });
      }
      const discovery = reservation.journeyStages.find(
        (stage) => stage.stageId === "discovery-studio"
      )!;
      const implementation = reservation.journeyStages.find(
        (stage) => stage.stageId === "implementation-studio"
      )!;
      draftItems.push(
        {
          title: "[Synthetic display only] Discovery studio - awaiting selection",
          fieldValues: syntheticStageValues({
            demoProjectId: target.demoProjectId,
            logicalTitle: schemas.catalog.spec.entries[index]!.title,
            repositoryFullName: manifest.spec.repository.fullName,
            stage: discovery
          })
        },
        {
          title:
            "[Synthetic display only] Implementation studio - awaiting selection",
          fieldValues: syntheticStageValues({
            demoProjectId: target.demoProjectId,
            logicalTitle: schemas.catalog.spec.entries[index]!.title,
            repositoryFullName: manifest.spec.repository.fullName,
            stage: implementation
          })
        },
        {
          title: "[Synthetic display only] Wrong-stage selection - blocked",
          fieldValues: syntheticStageValues({
            demoProjectId: target.demoProjectId,
            logicalTitle: schemas.catalog.spec.entries[index]!.title,
            repositoryFullName: manifest.spec.repository.fullName,
            stage: implementation,
            requestedAgent: ADAPTIVE_DELIVERY_AGENT_OPTIONS[0].name,
            selectionStatus: "invalid",
            blockedSelection: true
          })
        }
      );
    }
    seedBlueprints.push({
      demoProjectId: target.demoProjectId,
      projectNodeId: target.nodeId,
      scenarioIssueTitle: SYNTHETIC_SCENARIO_TITLES[target.demoProjectId],
      scenarioIssueNodeId: issueBinding.scenarioIssueNodeId,
      additionalIssueNodeIds: issueBinding.additionalIssueNodeIds,
      draftItems
    });
  }
  const manualViewSteps = manifest.spec.projects.flatMap((target) => [
    `${target.title}: group Journey by Journey Stage.`,
    `${target.title}: order Journey Stage columns by the declarative journey.`
  ]);
  const planWithoutDigest = {
    mode: "reviewed-dry-run" as const,
    evaluatedAt: input.evaluatedAt,
    targetManifestDigest: manifest.contentDigest,
    demoCatalogDigest: schemas.catalog.contentDigest,
    exactTargetNodeIds: manifest.spec.projects.map((target) => target.nodeId),
    operations,
    seedBlueprints,
    manualViewSteps
  };
  return immutableCanonicalSnapshot({
    ...planWithoutDigest,
    planDigest: digest(planWithoutDigest)
  });
}

export interface VerifiedDemoProjectBootstrapReconciliation {
  readonly targetManifestDigest: Digest;
  readonly confirmedPlanDigest: Digest;
  readonly reconciledAt: string;
  readonly apiSupportedPostconditionsMet: boolean;
  readonly projects: readonly {
    readonly demoProjectId: DemoProjectId;
    readonly projectNodeId: string;
    readonly fieldBindings: readonly {
      readonly fieldKey: string;
      readonly nodeId: string;
      readonly name: string;
      readonly dataType: GitHubProjectFieldType;
      readonly options: readonly {
        readonly key: string;
        readonly nodeId: string;
        readonly name: string;
        readonly color: GitHubProjectOptionColor;
        readonly description: string;
      }[];
    }[];
    readonly problems: readonly string[];
  }[];
  readonly manualViewSteps: readonly string[];
  readonly reportDigest: Digest;
}

export function reconcileVerifiedDemoProjectBootstrap(input: {
  readonly targetManifest: unknown;
  readonly projectSchemas: ValidatedDemoProjectSchemaCatalog;
  readonly confirmedPlan: VerifiedDemoProjectBootstrapPlan;
  readonly confirmedPlanDigest: Digest;
  readonly snapshots: readonly {
    readonly demoProjectId: DemoProjectId;
    readonly snapshot: LiveDemoProjectAdminSnapshot;
  }[];
  readonly reconciledAt: string;
  readonly maxSnapshotAgeMs: number;
}): VerifiedDemoProjectBootstrapReconciliation {
  const manifest = validateDemoContract(
    "DemoProjectTargetManifest",
    input.targetManifest
  );
  exactTargetManifest(
    manifest,
    input.confirmedPlan.targetManifestDigest
  );
  const schemas = revalidateDemoProjectSchemaCatalog(input.projectSchemas);
  const { planDigest: _planDigest, ...planPayload } = input.confirmedPlan;
  const exactTargetNodeIds = manifest.spec.projects.map(
    (target) => target.nodeId
  );
  if (
    digest(planPayload) !== input.confirmedPlan.planDigest ||
    input.confirmedPlan.planDigest !== input.confirmedPlanDigest ||
    input.confirmedPlan.targetManifestDigest !== manifest.contentDigest ||
    input.confirmedPlan.demoCatalogDigest !== schemas.catalog.contentDigest ||
    !isCanonicalUtcDateTime(input.reconciledAt) ||
    !Number.isSafeInteger(input.maxSnapshotAgeMs) ||
    input.maxSnapshotAgeMs < 1 ||
    canonicalJson(input.confirmedPlan.exactTargetNodeIds) !==
      canonicalJson(exactTargetNodeIds) ||
    input.confirmedPlan.operations.some(
      (operation) => !exactTargetNodeIds.includes(operation.projectNodeId)
    ) ||
    input.confirmedPlan.seedBlueprints.some(
      (blueprint, index) =>
        blueprint.demoProjectId !==
          manifest.spec.projects[index]?.demoProjectId ||
        blueprint.projectNodeId !== manifest.spec.projects[index]?.nodeId ||
        blueprint.scenarioIssueTitle !==
          SYNTHETIC_SCENARIO_TITLES[blueprint.demoProjectId]
    ) ||
    input.snapshots.length !== manifest.spec.projects.length
  ) {
    fail("Project bootstrap reconciliation inputs do not match the confirmed plan");
  }
  const reconciledAt = Date.parse(input.reconciledAt);
  const projects = manifest.spec.projects.map((target, index) => {
    const observed = input.snapshots[index];
    const schema = schemas.entries[index];
    const blueprint = input.confirmedPlan.seedBlueprints[index];
    if (
      observed?.demoProjectId !== target.demoProjectId ||
      schema?.demoProjectId !== target.demoProjectId ||
      blueprint?.demoProjectId !== target.demoProjectId
    ) {
      fail("Project bootstrap readback order differs from the confirmed plan");
    }
    const snapshot = immutableCanonicalSnapshot(
      assertDocument("GitHubProjectAdminSnapshot", observed.snapshot)
    );
    const problems: string[] = [];
    const observedAt = Date.parse(snapshot.observedAt);
    if (
      !Number.isFinite(observedAt) ||
      observedAt <= Date.parse(input.confirmedPlan.evaluatedAt) ||
      observedAt > reconciledAt ||
      reconciledAt - observedAt > input.maxSnapshotAgeMs
    ) {
      problems.push("readback-freshness");
    }
    const verifyFieldValues = (
      item: LiveDemoProjectAdminSnapshot["items"][number],
      expected: VerifiedDemoProjectBootstrapPlan["seedBlueprints"][number]["draftItems"][number]["fieldValues"],
      label: string
    ): void => {
      for (const expectedValue of expected) {
        const field = schema.schema.fields.find(
          (candidate) => candidate.key === expectedValue.fieldKey
        );
        const matches = item.fieldValues.filter(
          (candidate) => candidate.fieldName === field?.name
        );
        if (expectedValue.value === null) {
          if (matches.length !== 0) {
            problems.push(`item-field:${label}:${expectedValue.fieldKey}`);
          }
          continue;
        }
        if (
          field === undefined ||
          !["NUMBER", "SINGLE_SELECT", "TEXT"].includes(field.dataType) ||
          matches.length !== 1 ||
          matches[0]?.dataType !== field.dataType ||
          matches[0]?.value !== expectedValue.value
        ) {
          problems.push(`item-field:${label}:${expectedValue.fieldKey}`);
        }
      }
    };
    if (
      snapshot.owner.type !== manifest.spec.owner.type ||
      snapshot.owner.login !== manifest.spec.owner.login ||
      snapshot.owner.nodeId !== manifest.spec.owner.nodeId ||
      snapshot.repository.fullName !== manifest.spec.repository.fullName ||
      snapshot.repository.nodeId !== manifest.spec.repository.nodeId ||
      snapshot.project.number !== target.number ||
      snapshot.project.nodeId !== target.nodeId ||
      snapshot.project.title !== target.title ||
      target.projectSchemaDigest !== digest(schema.schema) ||
      snapshot.project.public ||
      snapshot.project.closed ||
      snapshot.linkedRepositories.length !== 1 ||
      snapshot.linkedRepositories[0]?.fullName !==
        manifest.spec.repository.fullName ||
      snapshot.linkedRepositories[0]?.nodeId !== manifest.spec.repository.nodeId
    ) {
      problems.push("exact-target-identity");
    }
    if (
      snapshot.project.shortDescription !==
      schema.schema.project.shortDescription
    ) {
      problems.push("project-description");
    }
    if (
      snapshot.project.readme !==
      projectReadme(
        target.demoProjectId,
        target.title,
        manifest.spec.repository.fullName
      )
    ) {
      problems.push("project-readme");
    }
    const fieldBindings: VerifiedDemoProjectBootstrapReconciliation["projects"][number]["fieldBindings"][number][] =
      [];
    const customFields = snapshot.fields.filter(
      (field) => !BUILT_IN_PROJECT_FIELDS.has(field.name)
    );
    const customNodeIds = customFields.flatMap((field) => [
      field.nodeId,
      ...field.options.map((option) => option.nodeId)
    ]);
    if (new Set(customNodeIds).size !== customNodeIds.length) {
      problems.push("field-option-identities");
    }
    for (const field of schema.schema.fields) {
      const matches = snapshot.fields.filter(
        (candidate) => candidate.name === field.name
      );
      const observedField = matches[0];
      const exactOptions =
        canonicalJson(
          observedField?.options.map((option) => ({
            name: option.name,
            color: option.color,
            description: option.description
          })) ?? []
        ) ===
        canonicalJson(
          field.options.map((option) => ({
            name: option.name,
            color: option.color,
            description: option.description ?? ""
          }))
        );
      if (
        matches.length !== 1 ||
        observedField?.dataType !== field.dataType ||
        !exactOptions
      ) {
        problems.push(`field:${field.key}`);
      } else {
        fieldBindings.push({
          fieldKey: field.key,
          nodeId: observedField.nodeId,
          name: observedField.name,
          dataType: field.dataType,
          options: observedField.options.map((option, optionIndex) => ({
            key: field.options[optionIndex]!.key,
            nodeId: option.nodeId,
            name: option.name,
            color: option.color,
            description: option.description
          }))
        });
      }
    }
    if (
      snapshot.fields.some(
        (field) =>
          !BUILT_IN_PROJECT_FIELDS.has(field.name) &&
          !schema.schema.fields.some(
            (expected) => expected.name === field.name
          )
      )
    ) {
      problems.push("unexpected-custom-field");
    }
    const matchingView = snapshot.views.filter(
      (view) => view.nodeId === target.viewNodeId
    );
    if (
      matchingView.length !== 1 ||
      matchingView[0]?.layout !== "BOARD_LAYOUT" ||
      matchingView[0]?.name !== "Journey" ||
      canonicalJson(matchingView[0]?.visibleFieldNames ?? []) !==
        canonicalJson(PROJECT_VIEW_VISIBLE_FIELD_NAMES) ||
      ![
        canonicalJson([]),
        canonicalJson(["Journey Stage"])
      ].includes(canonicalJson(matchingView[0]?.groupByFieldNames ?? []))
    ) {
      problems.push("project-view");
    }
    const matchingIssues = snapshot.items.filter(
      (item) =>
        item.contentType === "issue" &&
        item.title === blueprint.scenarioIssueTitle &&
        item.contentNodeId === blueprint.scenarioIssueNodeId
    );
    if (matchingIssues.length !== 1) {
      problems.push("synthetic-scenario-issue");
    } else {
      verifyFieldValues(
        matchingIssues[0]!,
        blueprint.draftItems[0]!.fieldValues,
        "scenario"
      );
    }
    const expectedIssueNodeIds = [
      blueprint.scenarioIssueNodeId,
      ...blueprint.additionalIssueNodeIds
    ].sort();
    const actualIssueNodeIds = snapshot.items
      .filter((item) => item.contentType === "issue")
      .map((item) => item.contentNodeId)
      .sort();
    if (
      canonicalJson(actualIssueNodeIds) !==
      canonicalJson(expectedIssueNodeIds)
    ) {
      problems.push("issue-membership");
    }
    for (const draft of blueprint.draftItems) {
      const title = draft.title;
      const matchingDrafts = snapshot.items.filter(
        (item) => item.contentType === "draft" && item.title === title
      );
      if (
        matchingDrafts.length !== 1 ||
        !title.startsWith("[Synthetic display only]")
      ) {
        problems.push(`synthetic-draft:${digest(title)}`);
      } else {
        verifyFieldValues(matchingDrafts[0]!, draft.fieldValues, digest(title));
      }
    }
    const expectedDraftTitles = blueprint.draftItems
      .map((draft) => draft.title)
      .sort();
    const actualDraftTitles = snapshot.items
      .filter((item) => item.contentType === "draft")
      .map((item) => item.title)
      .sort();
    if (
      canonicalJson(actualDraftTitles) !==
      canonicalJson(expectedDraftTitles)
    ) {
      problems.push("draft-membership");
    }
    if (snapshot.items.length !== snapshot.itemCount) {
      problems.push("item-pagination");
    }
    return {
      demoProjectId: target.demoProjectId,
      projectNodeId: target.nodeId,
      fieldBindings,
      problems
    };
  });
  const reportWithoutDigest = {
    targetManifestDigest: manifest.contentDigest,
    confirmedPlanDigest: input.confirmedPlanDigest,
    reconciledAt: input.reconciledAt,
    apiSupportedPostconditionsMet: projects.every(
      (project) => project.problems.length === 0
    ),
    projects,
    manualViewSteps: input.confirmedPlan.manualViewSteps
  };
  return immutableCanonicalSnapshot({
    ...reportWithoutDigest,
    reportDigest: digest(reportWithoutDigest)
  });
}

export function planDemoProjectCatalogSetup(input: {
  readonly projectSchemas: ValidatedDemoProjectSchemaCatalog;
  readonly liveProjects: readonly {
    readonly demoProjectId: DemoProjectId;
    readonly live: LiveGitHubProject;
  }[];
  readonly evaluatedAt: string;
}): DemoProjectCatalogSetupPlan {
  const projectSchemas = revalidateDemoProjectSchemaCatalog(
    input.projectSchemas
  );
  if (input.liveProjects.length !== projectSchemas.entries.length) {
    fail("catalog setup requires one fresh live snapshot per demo");
  }
  const entries = projectSchemas.entries.map((entry, index) => {
    const live = input.liveProjects[index];
    if (
      live === undefined ||
      live.demoProjectId !== entry.demoProjectId
    ) {
      fail("live Project snapshots must follow the Foundation catalog order");
    }
    return {
      demoProjectId: entry.demoProjectId,
      plan: planProjectSetup({
        schema: entry.schema,
        live: live.live,
        evaluatedAt: input.evaluatedAt
      })
    };
  });
  return {
    mode: "dry-run",
    demoCatalogDigest: projectSchemas.catalog.contentDigest,
    valid: entries.every((entry) => entry.plan.valid),
    entries
  };
}

export interface DemoProjectCatalogConfigurationExport {
  readonly format: "agentic-framework.github-project-catalog/v1";
  readonly demoCatalogDigest: Digest;
  readonly entries: readonly {
    readonly demoProjectId: DemoProjectId;
    readonly schema: GitHubProjectSchema;
    readonly binding: GitHubProjectBinding | null;
  }[];
}

export function exportDemoProjectCatalogConfiguration(input: {
  readonly projectSchemas: ValidatedDemoProjectSchemaCatalog;
  readonly bindings: readonly {
    readonly demoProjectId: DemoProjectId;
    readonly binding: GitHubProjectBinding | null;
  }[];
}): string {
  const projectSchemas = revalidateDemoProjectSchemaCatalog(
    input.projectSchemas
  );
  if (input.bindings.length !== projectSchemas.entries.length) {
    fail("catalog export requires one binding slot per demo");
  }
  const entries = projectSchemas.entries.map((entry, index) => {
    const candidate = input.bindings[index];
    if (
      candidate === undefined ||
      candidate.demoProjectId !== entry.demoProjectId
    ) {
      fail("catalog bindings must follow the Foundation catalog order");
    }
    const binding =
      candidate.binding === null
        ? null
        : assertDocument("GitHubProjectBinding", candidate.binding);
    if (
      binding !== null &&
      !projectBindingMatchesSchema(binding, entry.schema)
    ) {
      fail(`${entry.demoProjectId} binding does not match its Project schema`);
    }
    return {
      demoProjectId: entry.demoProjectId,
      schema: entry.schema,
      binding
    };
  });
  return `${canonicalJson({
    format: "agentic-framework.github-project-catalog/v1",
    demoCatalogDigest: projectSchemas.catalog.contentDigest,
    entries
  } satisfies DemoProjectCatalogConfigurationExport)}\n`;
}

function closedRecord(
  value: unknown,
  expectedKeys: readonly string[],
  label: string
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== [...expectedKeys].sort().join(",")) {
    fail(`${label} has an unknown shape`);
  }
  return record;
}

export function importDemoProjectCatalogConfiguration(input: {
  readonly serialized: string;
  readonly catalog: unknown;
  readonly reservations: unknown;
  readonly coreSchema: unknown;
}): DemoProjectCatalogConfigurationExport {
  const raw = closedRecord(
    parseStrictJson(input.serialized),
    ["format", "demoCatalogDigest", "entries"],
    "Project catalog configuration export"
  );
  if (
    raw.format !== "agentic-framework.github-project-catalog/v1" ||
    !Array.isArray(raw.entries)
  ) {
    fail("Project catalog configuration export has an unknown format");
  }
  const parsedEntries = raw.entries.map((value) => {
    const entry = closedRecord(
      value,
      ["demoProjectId", "schema", "binding"],
      "Project catalog entry"
    );
    return {
      demoProjectId: entry.demoProjectId as DemoProjectId,
      schema: entry.schema,
      binding: entry.binding
    };
  });
  const projectSchemas = validateDemoProjectSchemaCatalog({
    catalog: input.catalog,
    reservations: input.reservations,
    coreSchema: input.coreSchema,
    entries: parsedEntries.map((entry) => ({
      demoProjectId: entry.demoProjectId,
      schema: entry.schema as GitHubProjectSchema
    }))
  });
  if (raw.demoCatalogDigest !== projectSchemas.catalog.contentDigest) {
    fail("Project catalog export does not bind the current Foundation catalog");
  }
  const entries = parsedEntries.map((entry, index) => {
    const expected = projectSchemas.entries[index];
    if (
      expected === undefined ||
      entry.demoProjectId !== expected.demoProjectId
    ) {
      fail("Project catalog export order differs from the Foundation catalog");
    }
    const binding =
      entry.binding === null
        ? null
        : assertDocument("GitHubProjectBinding", entry.binding);
    if (
      binding !== null &&
      !projectBindingMatchesSchema(binding, expected.schema)
    ) {
      fail(`${entry.demoProjectId} imported binding does not match its schema`);
    }
    return {
      demoProjectId: entry.demoProjectId,
      schema: expected.schema,
      binding
    };
  });
  return {
    format: "agentic-framework.github-project-catalog/v1",
    demoCatalogDigest: projectSchemas.catalog.contentDigest,
    entries
  };
}

export function planProjectSetup(input: {
  readonly schema: GitHubProjectSchema;
  readonly live: LiveGitHubProject;
  readonly evaluatedAt: string;
}): ProjectSetupPlan {
  assertDocument("GitHubProjectSchema", input.schema);
  assertDocument("GitHubProjectLive", input.live);
  if (!isCanonicalUtcDateTime(input.evaluatedAt)) {
    throw new TypeError("evaluatedAt must be a canonical UTC date-time");
  }

  const problems = [...validateProjectSchemaSemantics(input.schema)];
  const actions: ProjectSetupAction[] = [];
  const schemaDigest = digest(input.schema);
  const expectedOwnerLogin =
    input.schema.owner.login === "OWNER"
      ? input.live.owner.login
      : input.schema.owner.login;

  if (
    input.live.owner.type !== input.schema.owner.type ||
    input.live.owner.login.toLowerCase() !== expectedOwnerLogin.toLowerCase()
  ) {
    actions.push({
      type: "reconcile-drift",
      path: "/owner",
      expected: `${input.schema.owner.type}:${expectedOwnerLogin}`,
      actual: `${input.live.owner.type}:${input.live.owner.login}`,
      requiresHumanAdmin: true
    });
  }

  if (input.live.project === null) {
    actions.push({
      type: "create-project",
      ownerLogin: expectedOwnerLogin,
      title: input.schema.project.title,
      requiresHumanAdmin: true
    });
    return {
      mode: "dry-run",
      schemaDigest,
      valid: problems.length === 0,
      problems,
      actions,
      binding: null
    };
  }

  if (input.live.project.title !== input.schema.project.title) {
    actions.push({
      type: "reconcile-drift",
      path: "/project/title",
      expected: input.schema.project.title,
      actual: input.live.project.title,
      requiresHumanAdmin: true
    });
  }

  const duplicateFieldOrOptionNodeIds = findDuplicates(
    input.live.fields.flatMap((field) => [
      field.nodeId,
      ...field.options.map((option) => option.nodeId)
    ])
  );
  if (duplicateFieldOrOptionNodeIds.length > 0) {
    actions.push({
      type: "reconcile-drift",
      path: "/fields/nodeIds",
      expected: "globally unique field and option node IDs",
      actual: canonicalJson(duplicateFieldOrOptionNodeIds),
      requiresHumanAdmin: true
    });
  }

  const boundFields: GitHubProjectBinding["fields"][number][] = [];
  for (const expectedField of input.schema.fields) {
    const matchingFields = input.live.fields.filter(
      (field) => field.name === expectedField.name
    );
    if (matchingFields.length === 0) {
      actions.push({
        type: "create-field",
        fieldKey: expectedField.key,
        name: expectedField.name,
        dataType: expectedField.dataType,
        options: expectedField.options.map((option) => ({
          ...option,
          description: option.description ?? ""
        })),
        requiresHumanAdmin: true
      });
      continue;
    }
    if (matchingFields.length !== 1) {
      actions.push({
        type: "reconcile-drift",
        path: `/fields/${expectedField.key}`,
        expected: "one field with the declared name",
        actual: `${matchingFields.length} fields`,
        requiresHumanAdmin: true
      });
      continue;
    }
    const liveField = matchingFields[0];
    if (liveField === undefined) continue;
    if (liveField.dataType !== expectedField.dataType) {
      actions.push({
        type: "reconcile-drift",
        path: `/fields/${expectedField.key}/dataType`,
        expected: expectedField.dataType,
        actual: liveField.dataType,
        requiresHumanAdmin: true
      });
      continue;
    }

    const boundOptions: GitHubProjectBinding["fields"][number]["options"][number][] =
      [];
    for (const expectedOption of expectedField.options) {
      const matchingOptions = liveField.options.filter(
        (option) => option.name === expectedOption.name
      );
      if (matchingOptions.length === 0) {
        actions.push({
          type: "create-option",
          fieldKey: expectedField.key,
          optionKey: expectedOption.key,
          name: expectedOption.name,
          color: expectedOption.color,
          description: expectedOption.description ?? "",
          requiresHumanAdmin: true
        });
        continue;
      }
      if (matchingOptions.length !== 1) {
        actions.push({
          type: "reconcile-drift",
          path: `/fields/${expectedField.key}/options/${expectedOption.key}`,
          expected: "one option with the declared name",
          actual: `${matchingOptions.length} options`,
          requiresHumanAdmin: true
        });
        continue;
      }
      const liveOption = matchingOptions[0];
      if (liveOption !== undefined) {
        const expectedDescription = expectedOption.description ?? "";
        if (
          liveOption.color !== expectedOption.color ||
          liveOption.description !== expectedDescription
        ) {
          actions.push({
            type: "reconcile-drift",
            path: `/fields/${expectedField.key}/options/${expectedOption.key}`,
            expected: canonicalJson({
              name: expectedOption.name,
              color: expectedOption.color,
              description: expectedDescription
            }),
            actual: canonicalJson({
              name: liveOption.name,
              color: liveOption.color,
              description: liveOption.description
            }),
            requiresHumanAdmin: true
          });
        }
        boundOptions.push({
          key: expectedOption.key,
          nodeId: liveOption.nodeId,
          name: liveOption.name,
          color: liveOption.color,
          description: liveOption.description
        });
      }
    }
    const expectedOptionNames = expectedField.options.map(
      (option) => option.name
    );
    const expectedOptionNameSet = new Set(expectedOptionNames);
    const liveOptionNames = liveField.options.map((option) => option.name);
    const expectedPresentOrder = expectedOptionNames.filter((name) =>
      liveOptionNames.includes(name)
    );
    const livePresentOrder = liveOptionNames.filter((name) =>
      expectedOptionNameSet.has(name)
    );
    if (
      liveOptionNames.some((name) => !expectedOptionNameSet.has(name)) ||
      canonicalJson(livePresentOrder) !== canonicalJson(expectedPresentOrder)
    ) {
      actions.push({
        type: "reconcile-drift",
        path: `/fields/${expectedField.key}/options`,
        expected: canonicalJson(expectedOptionNames),
        actual: canonicalJson(liveOptionNames),
        requiresHumanAdmin: true
      });
    }
    boundFields.push({
      key: expectedField.key,
      nodeId: liveField.nodeId,
      name: liveField.name,
      dataType: liveField.dataType,
      options: boundOptions
    });
  }

  const binding =
    problems.length === 0 &&
    actions.length === 0 &&
    boundFields.length === input.schema.fields.length
      ? assertDocument("GitHubProjectBinding", {
          apiVersion: input.schema.apiVersion,
          kind: "GitHubProjectBinding",
          schemaVersion: "1.0.0",
          projectSchemaDigest: schemaDigest,
          owner: input.live.owner,
          installation: input.live.installation,
          project: input.live.project,
          fields: boundFields,
          validatedAt: input.evaluatedAt
        })
      : null;

  return {
    mode: "dry-run",
    schemaDigest,
    valid: problems.length === 0,
    problems,
    actions,
    binding
  };
}

export interface GitHubProjectConfigurationExport {
  readonly format: "agentic-framework.github-project/v1";
  readonly schema: GitHubProjectSchema;
  readonly binding: GitHubProjectBinding | null;
}

export function exportProjectConfiguration(
  schema: GitHubProjectSchema,
  binding: GitHubProjectBinding | null
): string {
  assertDocument("GitHubProjectSchema", schema);
  if (binding !== null) {
    assertDocument("GitHubProjectBinding", binding);
    if (!projectBindingMatchesSchema(binding, schema)) {
      throw new TypeError("binding does not match the exported Project schema");
    }
  }
  return `${canonicalJson({
    format: "agentic-framework.github-project/v1",
    schema,
    binding
  } satisfies GitHubProjectConfigurationExport)}\n`;
}

export function importProjectConfiguration(
  serialized: string
): GitHubProjectConfigurationExport {
  const raw = parseStrictJson(serialized);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TypeError("Project configuration export must be an object");
  }
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.join(",") !== "binding,format,schema" ||
    record.format !== "agentic-framework.github-project/v1"
  ) {
    throw new TypeError("Project configuration export has an unknown shape");
  }
  const schema = assertDocument("GitHubProjectSchema", record.schema);
  const binding =
    record.binding === null
      ? null
      : assertDocument("GitHubProjectBinding", record.binding);
  if (binding !== null && !projectBindingMatchesSchema(binding, schema)) {
    throw new TypeError("imported binding does not match its Project schema");
  }
  return {
    format: "agentic-framework.github-project/v1",
    schema,
    binding
  };
}

export interface GitHubProjectMigration {
  readonly from: string;
  readonly to: string;
  readonly migrate: (schema: GitHubProjectSchema) => GitHubProjectSchema;
}

export class GitHubProjectMigrationRegistry {
  readonly #migrations = new Map<string, GitHubProjectMigration>();

  register(migration: GitHubProjectMigration): void {
    const key = `${migration.from}->${migration.to}`;
    if (migration.from === migration.to || this.#migrations.has(key)) {
      throw new TypeError(`invalid or duplicate Project migration ${key}`);
    }
    this.#migrations.set(key, migration);
  }

  migrate(input: {
    readonly schema: GitHubProjectSchema;
    readonly to: string;
    readonly dryRun?: boolean;
  }): {
    readonly dryRun: boolean;
    readonly from: string;
    readonly to: string;
    readonly sourceDigest: Digest;
    readonly targetDigest: Digest;
    readonly schema: GitHubProjectSchema;
  } {
    assertDocument("GitHubProjectSchema", input.schema);
    const migration = this.#migrations.get(
      `${input.schema.metadata.version}->${input.to}`
    );
    if (migration === undefined) {
      throw new TypeError(
        `no Project migration from ${input.schema.metadata.version} to ${input.to}`
      );
    }
    const first = assertDocument(
      "GitHubProjectSchema",
      migration.migrate(structuredClone(input.schema))
    );
    const second = assertDocument(
      "GitHubProjectSchema",
      migration.migrate(structuredClone(input.schema))
    );
    if (first.metadata.version !== migration.to || digest(first) !== digest(second)) {
      throw new TypeError("Project migration must be deterministic and set target version");
    }
    return {
      dryRun: input.dryRun !== false,
      from: migration.from,
      to: migration.to,
      sourceDigest: digest(input.schema),
      targetDigest: digest(first),
      schema: first
    };
  }
}
