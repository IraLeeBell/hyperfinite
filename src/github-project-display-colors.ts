import { canonicalJson, digest } from "./canonical.js";
import {
  validateDemoProjectSchemaCatalog,
  type ValidatedDemoProjectSchemaCatalog
} from "./github-projects.js";
import type {
  GitHubProjectFieldType,
  GitHubProjectOptionColor,
  GitHubProjectSchema
} from "./github-types.js";
import type { DemoProjectId } from "./demo-types.js";
import { API_VERSION, type ApiVersion, type Digest } from "./types.js";
import { assertDocument, isCanonicalUtcDateTime } from "./validation.js";

const DISPLAY_SCHEMA_VERSION = "1.0.0" as const;
const DISPLAY_MARKERS = {
  authoritative: false as const,
  displayOnly: true as const
};

export interface GitHubProjectDisplayOwner {
  readonly type: "organization" | "user";
  readonly login: string;
  readonly nodeId: string;
}

export interface GitHubProjectDisplayRepository {
  readonly fullName: string;
  readonly nodeId: string;
}

export interface GitHubProjectDisplayVisibleField {
  readonly nodeId: string;
  readonly name: string;
  readonly dataType: string;
}

export interface GitHubProjectDisplaySnapshot {
  readonly apiVersion: ApiVersion;
  readonly kind: "GitHubProjectDisplaySnapshot";
  readonly schemaVersion: typeof DISPLAY_SCHEMA_VERSION;
  readonly authoritative: false;
  readonly displayOnly: true;
  readonly observedAt: string;
  readonly owner: GitHubProjectDisplayOwner;
  readonly repository: GitHubProjectDisplayRepository;
  readonly linkedRepositories: readonly GitHubProjectDisplayRepository[];
  readonly project: {
    readonly number: number;
    readonly nodeId: string;
    readonly title: string;
    readonly visibility: "private" | "public";
    readonly closed: boolean;
  };
  readonly view: {
    readonly nodeId: string;
    readonly name: string;
    readonly layout: string;
    readonly visibleFields: readonly GitHubProjectDisplayVisibleField[];
  };
  readonly customFields: readonly {
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

export interface GitHubProjectDisplayTargetManifest {
  readonly apiVersion: ApiVersion;
  readonly kind: "GitHubProjectDisplayTargetManifest";
  readonly schemaVersion: typeof DISPLAY_SCHEMA_VERSION;
  readonly authoritative: false;
  readonly displayOnly: true;
  readonly contentDigest: Digest;
  readonly spec: {
    readonly generatedAt: string;
    readonly maxSnapshotAgeMs: number;
    readonly targets: readonly {
      readonly demoProjectId: DemoProjectId;
      readonly projectSchemaDigest: Digest;
      readonly proposal: {
        readonly observedAt: string;
        readonly snapshotDigest: Digest;
      };
      readonly owner: GitHubProjectDisplayOwner;
      readonly repository: GitHubProjectDisplayRepository;
      readonly project: GitHubProjectDisplaySnapshot["project"];
      readonly view: {
        readonly nodeId: string;
        readonly name: string;
        readonly observedLayout: string;
        readonly observedVisibleFields: readonly GitHubProjectDisplayVisibleField[];
      };
      readonly customFields: readonly {
        readonly key: string;
        readonly nodeId: string;
        readonly name: string;
        readonly dataType: GitHubProjectFieldType;
        readonly options: readonly {
          readonly key: string;
          readonly nodeId: string;
          readonly name: string;
          readonly observedColor: GitHubProjectOptionColor;
          readonly description: string;
        }[];
      }[];
    }[];
  };
}

export interface GitHubProjectDisplayColorAction {
  readonly type: "set-single-select-option-color";
  readonly authoritative: false;
  readonly displayOnly: true;
  readonly requiresHumanAdmin: true;
  readonly demoProjectId: DemoProjectId;
  readonly projectSchemaDigest: Digest;
  readonly ownerNodeId: string;
  readonly projectNodeId: string;
  readonly fieldKey: string;
  readonly fieldNodeId: string;
  readonly fieldName: string;
  readonly optionKey: string;
  readonly optionNodeId: string;
  readonly optionName: string;
  readonly optionDescription: string;
  readonly before: {
    readonly color: GitHubProjectOptionColor;
  };
  readonly after: {
    readonly color: GitHubProjectOptionColor;
  };
}

export interface GitHubProjectDisplayColorPlan {
  readonly apiVersion: ApiVersion;
  readonly kind: "GitHubProjectDisplayColorPlan";
  readonly schemaVersion: typeof DISPLAY_SCHEMA_VERSION;
  readonly authoritative: false;
  readonly displayOnly: true;
  readonly mode: "display-only-dry-run";
  readonly evaluatedAt: string;
  readonly maxSnapshotAgeMs: number;
  readonly targetManifestDigest: Digest;
  readonly projects: readonly {
    readonly demoProjectId: DemoProjectId;
    readonly projectSchemaDigest: Digest;
    readonly projectNodeId: string;
    readonly snapshotDigest: Digest;
    readonly observedAt: string;
    readonly view: {
      readonly nodeId: string;
      readonly name: string;
      readonly observedLayout: string;
      readonly observedVisibleFields: readonly GitHubProjectDisplayVisibleField[];
    };
    readonly optionColors: readonly {
      readonly fieldNodeId: string;
      readonly optionNodeId: string;
      readonly color: GitHubProjectOptionColor;
    }[];
  }[];
  readonly actions: readonly GitHubProjectDisplayColorAction[];
  readonly planDigest: Digest;
}

export interface GitHubProjectDisplayColorReadback {
  readonly apiVersion: ApiVersion;
  readonly kind: "GitHubProjectDisplayColorReadback";
  readonly schemaVersion: typeof DISPLAY_SCHEMA_VERSION;
  readonly authoritative: false;
  readonly displayOnly: true;
  readonly mode: "display-only-readback";
  readonly reconciledAt: string;
  readonly maxSnapshotAgeMs: number;
  readonly targetManifestDigest: Digest;
  readonly confirmedPlanDigest: Digest;
  readonly success: boolean;
  readonly runtimeBindingProduced: false;
  readonly projects: readonly {
    readonly demoProjectId: DemoProjectId;
    readonly projectSchemaDigest: Digest;
    readonly projectNodeId: string;
    readonly snapshotDigest: Digest;
    readonly observedAt: string;
    readonly exactIdentityVerified: true;
    readonly schemaVerified: true;
    readonly viewObservation: {
      readonly nodeId: string;
      readonly name: string;
      readonly observedLayout: string;
      readonly observedVisibleFields: readonly GitHubProjectDisplayVisibleField[];
    };
    readonly remainingColorDrift: readonly {
      readonly fieldNodeId: string;
      readonly optionNodeId: string;
      readonly actualColor: GitHubProjectOptionColor;
      readonly expectedColor: GitHubProjectOptionColor;
    }[];
  }[];
  readonly reportDigest: Digest;
}

type ManifestTarget = GitHubProjectDisplayTargetManifest["spec"]["targets"][number];
type PlanProject = GitHubProjectDisplayColorPlan["projects"][number];

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

function findDuplicates(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(`${name} must be a positive safe integer`);
  }
}

function assertFreshObservation(input: {
  readonly observedAt: string;
  readonly evaluatedAt: string;
  readonly maxSnapshotAgeMs: number;
  readonly subject: string;
  readonly mustBeAfter?: string;
}): void {
  if (
    !isCanonicalUtcDateTime(input.observedAt) ||
    !isCanonicalUtcDateTime(input.evaluatedAt)
  ) {
    fail(`${input.subject} must use canonical UTC timestamps`);
  }
  assertPositiveSafeInteger(input.maxSnapshotAgeMs, "maxSnapshotAgeMs");
  const observedAt = Date.parse(input.observedAt);
  const evaluatedAt = Date.parse(input.evaluatedAt);
  if (
    !Number.isFinite(observedAt) ||
    !Number.isFinite(evaluatedAt) ||
    observedAt > evaluatedAt ||
    evaluatedAt - observedAt > input.maxSnapshotAgeMs
  ) {
    fail(`${input.subject} is stale or from the future`);
  }
  if (
    input.mustBeAfter !== undefined &&
    (!isCanonicalUtcDateTime(input.mustBeAfter) ||
      observedAt <= Date.parse(input.mustBeAfter))
  ) {
    fail(`${input.subject} does not postdate the confirmed plan`);
  }
}

function revalidateProjectSchemas(
  projectSchemas: ValidatedDemoProjectSchemaCatalog
): ValidatedDemoProjectSchemaCatalog {
  return validateDemoProjectSchemaCatalog({
    catalog: projectSchemas.catalog,
    reservations: projectSchemas.reservations,
    coreSchema: projectSchemas.coreSchema,
    entries: projectSchemas.entries
  });
}

function expectedDescription(
  option: GitHubProjectSchema["fields"][number]["options"][number]
): string {
  return option.description ?? "";
}

function assertVisibleFieldObservation(
  fields: readonly GitHubProjectDisplayVisibleField[],
  subject: string
): void {
  const duplicateNodeIds = findDuplicates(fields.map((field) => field.nodeId));
  const duplicateNames = findDuplicates(fields.map((field) => field.name));
  if (duplicateNodeIds.length > 0 || duplicateNames.length > 0) {
    fail(`${subject} contains duplicate visible-field identity`);
  }
}

function assertSnapshotSemantics(
  snapshot: GitHubProjectDisplaySnapshot,
  schema: GitHubProjectSchema,
  subject: string
): void {
  if (
    snapshot.linkedRepositories.length !== 1 ||
    canonicalJson(snapshot.linkedRepositories[0]) !==
      canonicalJson(snapshot.repository)
  ) {
    fail(`${subject} repository linkage is not exact`);
  }
  if (snapshot.project.title !== schema.project.title) {
    fail(`${subject} Project title differs from the merged schema`);
  }
  assertVisibleFieldObservation(
    snapshot.view.visibleFields,
    `${subject} view observation`
  );
  if (snapshot.customFields.length !== schema.fields.length) {
    fail(`${subject} custom field set differs from the merged schema`);
  }
  const nodeIds: string[] = [];
  for (let fieldIndex = 0; fieldIndex < schema.fields.length; fieldIndex += 1) {
    const expectedField = schema.fields[fieldIndex];
    const observedField = snapshot.customFields[fieldIndex];
    if (
      expectedField === undefined ||
      observedField === undefined ||
      observedField.name !== expectedField.name ||
      observedField.dataType !== expectedField.dataType ||
      observedField.options.length !== expectedField.options.length
    ) {
      fail(`${subject} custom field identity, type, or order differs`);
    }
    nodeIds.push(observedField.nodeId);
    for (
      let optionIndex = 0;
      optionIndex < expectedField.options.length;
      optionIndex += 1
    ) {
      const expectedOption = expectedField.options[optionIndex];
      const observedOption = observedField.options[optionIndex];
      if (
        expectedOption === undefined ||
        observedOption === undefined ||
        observedOption.name !== expectedOption.name ||
        observedOption.description !== expectedDescription(expectedOption)
      ) {
        fail(`${subject} option identity, description, or order differs`);
      }
      nodeIds.push(observedOption.nodeId);
    }
  }
  if (findDuplicates(nodeIds).length > 0) {
    fail(`${subject} contains duplicate field or option node IDs`);
  }
}

function validateSnapshot(input: {
  readonly value: unknown;
  readonly schema: GitHubProjectSchema;
  readonly evaluatedAt: string;
  readonly maxSnapshotAgeMs: number;
  readonly subject: string;
  readonly mustBeAfter?: string;
}): GitHubProjectDisplaySnapshot {
  const snapshot = immutableCanonicalSnapshot(
    assertDocument("GitHubProjectDisplaySnapshot", input.value)
  );
  assertFreshObservation({
    observedAt: snapshot.observedAt,
    evaluatedAt: input.evaluatedAt,
    maxSnapshotAgeMs: input.maxSnapshotAgeMs,
    subject: input.subject,
    ...(input.mustBeAfter === undefined
      ? {}
      : { mustBeAfter: input.mustBeAfter })
  });
  assertSnapshotSemantics(snapshot, input.schema, input.subject);
  return snapshot;
}

function targetFromSnapshot(
  demoProjectId: DemoProjectId,
  schema: GitHubProjectSchema,
  snapshot: GitHubProjectDisplaySnapshot
): ManifestTarget {
  return {
    demoProjectId,
    projectSchemaDigest: digest(schema),
    proposal: {
      observedAt: snapshot.observedAt,
      snapshotDigest: digest(snapshot)
    },
    owner: snapshot.owner,
    repository: snapshot.repository,
    project: snapshot.project,
    view: {
      nodeId: snapshot.view.nodeId,
      name: snapshot.view.name,
      observedLayout: snapshot.view.layout,
      observedVisibleFields: snapshot.view.visibleFields
    },
    customFields: schema.fields.map((field, fieldIndex) => {
      const observedField = snapshot.customFields[fieldIndex]!;
      return {
        key: field.key,
        nodeId: observedField.nodeId,
        name: observedField.name,
        dataType: observedField.dataType,
        options: field.options.map((option, optionIndex) => {
          const observedOption = observedField.options[optionIndex]!;
          return {
            key: option.key,
            nodeId: observedOption.nodeId,
            name: observedOption.name,
            observedColor: observedOption.color,
            description: observedOption.description
          };
        })
      };
    })
  };
}

function reconstructedSnapshot(input: {
  readonly target: ManifestTarget;
  readonly observedAt: string;
  readonly view: {
    readonly nodeId: string;
    readonly name: string;
    readonly observedLayout: string;
    readonly observedVisibleFields: readonly GitHubProjectDisplayVisibleField[];
  };
  readonly optionColors: readonly {
    readonly fieldNodeId: string;
    readonly optionNodeId: string;
    readonly color: GitHubProjectOptionColor;
  }[];
}): GitHubProjectDisplaySnapshot {
  let observationIndex = 0;
  const customFields = input.target.customFields.map((field) => ({
    nodeId: field.nodeId,
    name: field.name,
    dataType: field.dataType,
    options: field.options.map((option) => {
      const observation = input.optionColors[observationIndex];
      observationIndex += 1;
      if (
        observation === undefined ||
        observation.fieldNodeId !== field.nodeId ||
        observation.optionNodeId !== option.nodeId
      ) {
        fail(`${input.target.demoProjectId} snapshot digest mapping changed`);
      }
      return {
        nodeId: option.nodeId,
        name: option.name,
        color: observation.color,
        description: option.description
      };
    })
  }));
  if (observationIndex !== input.optionColors.length) {
    fail(`${input.target.demoProjectId} snapshot digest mapping changed`);
  }
  return {
    apiVersion: API_VERSION,
    kind: "GitHubProjectDisplaySnapshot",
    schemaVersion: DISPLAY_SCHEMA_VERSION,
    ...DISPLAY_MARKERS,
    observedAt: input.observedAt,
    owner: input.target.owner,
    repository: input.target.repository,
    linkedRepositories: [input.target.repository],
    project: input.target.project,
    view: {
      nodeId: input.view.nodeId,
      name: input.view.name,
      layout: input.view.observedLayout,
      visibleFields: input.view.observedVisibleFields
    },
    customFields
  };
}

function manifestPayload(
  spec: GitHubProjectDisplayTargetManifest["spec"]
): Omit<GitHubProjectDisplayTargetManifest, "contentDigest"> {
  return {
    apiVersion: API_VERSION,
    kind: "GitHubProjectDisplayTargetManifest",
    schemaVersion: DISPLAY_SCHEMA_VERSION,
    ...DISPLAY_MARKERS,
    spec
  };
}

function assertUniquePortfolioTargets(
  targets: GitHubProjectDisplayTargetManifest["spec"]["targets"]
): void {
  const projectNodeIds = targets.map((target) => target.project.nodeId);
  const viewNodeIds = targets.map((target) => target.view.nodeId);
  const ownerProjectNumbers = targets.map(
    (target) => `${target.owner.nodeId}:${target.project.number}`
  );
  const fieldAndOptionNodeIds = targets.flatMap((target) =>
    target.customFields.flatMap((field) => [
      field.nodeId,
      ...field.options.map((option) => option.nodeId)
    ])
  );
  if (
    findDuplicates(projectNodeIds).length > 0 ||
    findDuplicates(viewNodeIds).length > 0 ||
    findDuplicates(ownerProjectNumbers).length > 0 ||
    findDuplicates(fieldAndOptionNodeIds).length > 0
  ) {
    fail("display target manifest contains duplicate target identity");
  }
}

function assertManifestTargetMatchesSchema(
  target: ManifestTarget,
  schema: GitHubProjectSchema,
  demoProjectId: DemoProjectId
): void {
  if (
    target.demoProjectId !== demoProjectId ||
    target.projectSchemaDigest !== digest(schema) ||
    target.project.title !== schema.project.title ||
    target.customFields.length !== schema.fields.length
  ) {
    fail(`${demoProjectId} display target differs from the merged schema`);
  }
  assertVisibleFieldObservation(
    target.view.observedVisibleFields,
    `${demoProjectId} manifest view observation`
  );
  for (let fieldIndex = 0; fieldIndex < schema.fields.length; fieldIndex += 1) {
    const expectedField = schema.fields[fieldIndex];
    const targetField = target.customFields[fieldIndex];
    if (
      expectedField === undefined ||
      targetField === undefined ||
      targetField.key !== expectedField.key ||
      targetField.name !== expectedField.name ||
      targetField.dataType !== expectedField.dataType ||
      targetField.options.length !== expectedField.options.length
    ) {
      fail(`${demoProjectId} manifest field identity, type, or order differs`);
    }
    for (
      let optionIndex = 0;
      optionIndex < expectedField.options.length;
      optionIndex += 1
    ) {
      const expectedOption = expectedField.options[optionIndex];
      const targetOption = targetField.options[optionIndex];
      if (
        expectedOption === undefined ||
        targetOption === undefined ||
        targetOption.key !== expectedOption.key ||
        targetOption.name !== expectedOption.name ||
        targetOption.description !== expectedDescription(expectedOption)
      ) {
        fail(`${demoProjectId} manifest option identity or order differs`);
      }
    }
  }
}

function validateManifest(
  value: unknown,
  schemas: ValidatedDemoProjectSchemaCatalog
): GitHubProjectDisplayTargetManifest {
  const manifest = immutableCanonicalSnapshot(
    assertDocument("GitHubProjectDisplayTargetManifest", value)
  );
  if (manifest.contentDigest !== digest(manifestPayload(manifest.spec))) {
    fail("display target manifest content digest is invalid");
  }
  assertPositiveSafeInteger(
    manifest.spec.maxSnapshotAgeMs,
    "manifest maxSnapshotAgeMs"
  );
  const generatedAt = Date.parse(manifest.spec.generatedAt);
  if (!isCanonicalUtcDateTime(manifest.spec.generatedAt)) {
    fail("display target manifest generatedAt is not canonical");
  }
  if (manifest.spec.targets.length !== schemas.entries.length) {
    fail("display target manifest does not cover the exact demo catalog");
  }
  for (let index = 0; index < schemas.entries.length; index += 1) {
    const schemaEntry = schemas.entries[index];
    const target = manifest.spec.targets[index];
    if (
      schemaEntry === undefined ||
      target === undefined ||
      target.demoProjectId !== schemaEntry.demoProjectId
    ) {
      fail("display target manifest order differs from the Foundation catalog");
    }
    assertManifestTargetMatchesSchema(
      target,
      schemaEntry.schema,
      schemaEntry.demoProjectId
    );
    const proposalSnapshot = reconstructedSnapshot({
      target,
      observedAt: target.proposal.observedAt,
      view: target.view,
      optionColors: target.customFields.flatMap((field) =>
        field.options.map((option) => ({
          fieldNodeId: field.nodeId,
          optionNodeId: option.nodeId,
          color: option.observedColor
        }))
      )
    });
    if (target.proposal.snapshotDigest !== digest(proposalSnapshot)) {
      fail(`${target.demoProjectId} proposal snapshot digest is invalid`);
    }
    const observedAt = Date.parse(target.proposal.observedAt);
    if (
      !Number.isFinite(generatedAt) ||
      !Number.isFinite(observedAt) ||
      observedAt > generatedAt ||
      generatedAt - observedAt > manifest.spec.maxSnapshotAgeMs
    ) {
      fail(`${target.demoProjectId} target proposal is stale or from the future`);
    }
  }
  assertUniquePortfolioTargets(manifest.spec.targets);
  return manifest;
}

function assertConfirmedManifest(
  manifest: GitHubProjectDisplayTargetManifest,
  confirmedDigest: Digest
): void {
  if (manifest.contentDigest !== confirmedDigest) {
    fail("display target manifest differs from the independently confirmed digest");
  }
}

function snapshotIdentity(
  snapshot: GitHubProjectDisplaySnapshot,
  schema: GitHubProjectSchema
): unknown {
  return {
    owner: snapshot.owner,
    repository: snapshot.repository,
    project: snapshot.project,
    view: {
      nodeId: snapshot.view.nodeId,
      name: snapshot.view.name
    },
    customFields: schema.fields.map((field, fieldIndex) => {
      const observedField = snapshot.customFields[fieldIndex]!;
      return {
        key: field.key,
        nodeId: observedField.nodeId,
        name: observedField.name,
        dataType: observedField.dataType,
        options: field.options.map((option, optionIndex) => {
          const observedOption = observedField.options[optionIndex]!;
          return {
            key: option.key,
            nodeId: observedOption.nodeId,
            name: observedOption.name,
            description: observedOption.description
          };
        })
      };
    })
  };
}

function targetIdentity(target: ManifestTarget): unknown {
  return {
    owner: target.owner,
    repository: target.repository,
    project: target.project,
    view: {
      nodeId: target.view.nodeId,
      name: target.view.name
    },
    customFields: target.customFields.map((field) => ({
      key: field.key,
      nodeId: field.nodeId,
      name: field.name,
      dataType: field.dataType,
      options: field.options.map((option) => ({
        key: option.key,
        nodeId: option.nodeId,
        name: option.name,
        description: option.description
      }))
    }))
  };
}

function assertSnapshotMatchesTarget(
  snapshot: GitHubProjectDisplaySnapshot,
  schema: GitHubProjectSchema,
  target: ManifestTarget
): void {
  if (
    canonicalJson(snapshotIdentity(snapshot, schema)) !==
    canonicalJson(targetIdentity(target))
  ) {
    fail(`${target.demoProjectId} display target identity or state changed`);
  }
}

function planProjectObservation(
  demoProjectId: DemoProjectId,
  schema: GitHubProjectSchema,
  snapshot: GitHubProjectDisplaySnapshot
): PlanProject {
  return {
    demoProjectId,
    projectSchemaDigest: digest(schema),
    projectNodeId: snapshot.project.nodeId,
    snapshotDigest: digest(snapshot),
    observedAt: snapshot.observedAt,
    view: {
      nodeId: snapshot.view.nodeId,
      name: snapshot.view.name,
      observedLayout: snapshot.view.layout,
      observedVisibleFields: snapshot.view.visibleFields
    },
    optionColors: schema.fields.flatMap((field, fieldIndex) => {
      const observedField = snapshot.customFields[fieldIndex]!;
      return field.options.map((_option, optionIndex) => {
        const observedOption = observedField.options[optionIndex]!;
        return {
          fieldNodeId: observedField.nodeId,
          optionNodeId: observedOption.nodeId,
          color: observedOption.color
        };
      });
    })
  };
}

function actionsForObservation(
  project: PlanProject,
  target: ManifestTarget,
  schema: GitHubProjectSchema
): readonly GitHubProjectDisplayColorAction[] {
  const expectedObservations = target.customFields.flatMap((field) =>
    field.options.map((option) => ({
      fieldNodeId: field.nodeId,
      optionNodeId: option.nodeId
    }))
  );
  if (
    project.demoProjectId !== target.demoProjectId ||
    project.projectSchemaDigest !== target.projectSchemaDigest ||
    project.projectNodeId !== target.project.nodeId ||
    project.view.nodeId !== target.view.nodeId ||
    project.view.name !== target.view.name ||
    project.optionColors.length !== expectedObservations.length
  ) {
    fail(`${target.demoProjectId} plan observation differs from its target`);
  }
  assertVisibleFieldObservation(
    project.view.observedVisibleFields,
    `${target.demoProjectId} plan view observation`
  );
  let observationIndex = 0;
  const actions: GitHubProjectDisplayColorAction[] = [];
  for (let fieldIndex = 0; fieldIndex < schema.fields.length; fieldIndex += 1) {
    const field = schema.fields[fieldIndex]!;
    const targetField = target.customFields[fieldIndex]!;
    for (
      let optionIndex = 0;
      optionIndex < field.options.length;
      optionIndex += 1
    ) {
      const option = field.options[optionIndex]!;
      const targetOption = targetField.options[optionIndex]!;
      const observation = project.optionColors[observationIndex];
      observationIndex += 1;
      if (
        observation === undefined ||
        observation.fieldNodeId !== targetField.nodeId ||
        observation.optionNodeId !== targetOption.nodeId
      ) {
        fail(`${target.demoProjectId} option-color observation order changed`);
      }
      if (observation.color === option.color) continue;
      actions.push({
        type: "set-single-select-option-color",
        ...DISPLAY_MARKERS,
        requiresHumanAdmin: true,
        demoProjectId: target.demoProjectId,
        projectSchemaDigest: target.projectSchemaDigest,
        ownerNodeId: target.owner.nodeId,
        projectNodeId: target.project.nodeId,
        fieldKey: field.key,
        fieldNodeId: targetField.nodeId,
        fieldName: field.name,
        optionKey: option.key,
        optionNodeId: targetOption.nodeId,
        optionName: option.name,
        optionDescription: expectedDescription(option),
        before: {
          color: observation.color
        },
        after: {
          color: option.color
        }
      });
    }
  }
  return actions;
}

function planPayload(
  input: Omit<GitHubProjectDisplayColorPlan, "planDigest">
): Omit<GitHubProjectDisplayColorPlan, "planDigest"> {
  return input;
}

function validatePlan(input: {
  readonly value: unknown;
  readonly confirmedPlanDigest: Digest;
  readonly manifest: GitHubProjectDisplayTargetManifest;
  readonly schemas: ValidatedDemoProjectSchemaCatalog;
}): GitHubProjectDisplayColorPlan {
  const plan = immutableCanonicalSnapshot(
    assertDocument("GitHubProjectDisplayColorPlan", input.value)
  );
  const { planDigest, ...payload } = plan;
  if (
    planDigest !== digest(planPayload(payload)) ||
    planDigest !== input.confirmedPlanDigest ||
    plan.targetManifestDigest !== input.manifest.contentDigest ||
    plan.maxSnapshotAgeMs !== input.manifest.spec.maxSnapshotAgeMs ||
    plan.projects.length !== input.schemas.entries.length ||
    Date.parse(plan.evaluatedAt) < Date.parse(input.manifest.spec.generatedAt)
  ) {
    fail("display color plan differs from the confirmed manifest or plan digest");
  }
  assertFreshObservation({
    observedAt: input.manifest.spec.generatedAt,
    evaluatedAt: plan.evaluatedAt,
    maxSnapshotAgeMs: plan.maxSnapshotAgeMs,
    subject: "display target manifest"
  });
  const expectedActions: GitHubProjectDisplayColorAction[] = [];
  for (let index = 0; index < input.schemas.entries.length; index += 1) {
    const schemaEntry = input.schemas.entries[index];
    const target = input.manifest.spec.targets[index];
    const project = plan.projects[index];
    if (
      schemaEntry === undefined ||
      target === undefined ||
      project === undefined ||
      project.demoProjectId !== schemaEntry.demoProjectId ||
      target.demoProjectId !== schemaEntry.demoProjectId ||
      project.projectSchemaDigest !== digest(schemaEntry.schema) ||
      Date.parse(project.observedAt) < Date.parse(target.proposal.observedAt)
    ) {
      fail("display color plan project order, schema, or observation changed");
    }
    assertFreshObservation({
      observedAt: project.observedAt,
      evaluatedAt: plan.evaluatedAt,
      maxSnapshotAgeMs: plan.maxSnapshotAgeMs,
      subject: `${project.demoProjectId} confirmed plan observation`
    });
    expectedActions.push(
      ...actionsForObservation(project, target, schemaEntry.schema)
    );
    if (
      project.snapshotDigest !==
      digest(
        reconstructedSnapshot({
          target,
          observedAt: project.observedAt,
          view: project.view,
          optionColors: project.optionColors
        })
      )
    ) {
      fail(`${project.demoProjectId} plan snapshot digest is invalid`);
    }
  }
  if (canonicalJson(plan.actions) !== canonicalJson(expectedActions)) {
    fail("display color plan action set is not the exact observed color drift");
  }
  return plan;
}

export function createDisplayOnlyProjectTargetManifest(input: {
  readonly projectSchemas: ValidatedDemoProjectSchemaCatalog;
  readonly snapshots: readonly {
    readonly demoProjectId: DemoProjectId;
    readonly snapshot: unknown;
  }[];
  readonly generatedAt: string;
  readonly maxSnapshotAgeMs: number;
}): GitHubProjectDisplayTargetManifest {
  const schemas = revalidateProjectSchemas(input.projectSchemas);
  assertPositiveSafeInteger(input.maxSnapshotAgeMs, "maxSnapshotAgeMs");
  if (
    !isCanonicalUtcDateTime(input.generatedAt) ||
    input.snapshots.length !== schemas.entries.length
  ) {
    fail("display target-manifest inputs are incomplete");
  }
  const targets = schemas.entries.map((schemaEntry, index) => {
    const observed = input.snapshots[index];
    if (observed?.demoProjectId !== schemaEntry.demoProjectId) {
      fail("display snapshots differ from the Foundation catalog order");
    }
    const snapshot = validateSnapshot({
      value: observed.snapshot,
      schema: schemaEntry.schema,
      evaluatedAt: input.generatedAt,
      maxSnapshotAgeMs: input.maxSnapshotAgeMs,
      subject: `${schemaEntry.demoProjectId} target proposal`
    });
    return targetFromSnapshot(
      schemaEntry.demoProjectId,
      schemaEntry.schema,
      snapshot
    );
  });
  assertUniquePortfolioTargets(targets);
  const spec = {
    generatedAt: input.generatedAt,
    maxSnapshotAgeMs: input.maxSnapshotAgeMs,
    targets
  };
  const payload = manifestPayload(spec);
  return immutableCanonicalSnapshot(
    assertDocument("GitHubProjectDisplayTargetManifest", {
      ...payload,
      contentDigest: digest(payload)
    })
  );
}

export function planDisplayOnlyProjectColorReconciliation(input: {
  readonly targetManifest: unknown;
  readonly confirmedTargetManifestDigest: Digest;
  readonly projectSchemas: ValidatedDemoProjectSchemaCatalog;
  readonly snapshots: readonly {
    readonly demoProjectId: DemoProjectId;
    readonly snapshot: unknown;
  }[];
  readonly evaluatedAt: string;
  readonly maxSnapshotAgeMs: number;
}): GitHubProjectDisplayColorPlan {
  const schemas = revalidateProjectSchemas(input.projectSchemas);
  const manifest = validateManifest(input.targetManifest, schemas);
  assertConfirmedManifest(manifest, input.confirmedTargetManifestDigest);
  if (
    !isCanonicalUtcDateTime(input.evaluatedAt) ||
    input.maxSnapshotAgeMs !== manifest.spec.maxSnapshotAgeMs ||
    input.snapshots.length !== schemas.entries.length
  ) {
    fail("display color plan inputs differ from the confirmed manifest");
  }
  assertFreshObservation({
    observedAt: manifest.spec.generatedAt,
    evaluatedAt: input.evaluatedAt,
    maxSnapshotAgeMs: input.maxSnapshotAgeMs,
    subject: "display target manifest"
  });
  const projects: PlanProject[] = [];
  const actions: GitHubProjectDisplayColorAction[] = [];
  for (let index = 0; index < schemas.entries.length; index += 1) {
    const schemaEntry = schemas.entries[index]!;
    const target = manifest.spec.targets[index]!;
    const observed = input.snapshots[index];
    if (observed?.demoProjectId !== schemaEntry.demoProjectId) {
      fail("display snapshots differ from the confirmed target order");
    }
    const snapshot = validateSnapshot({
      value: observed.snapshot,
      schema: schemaEntry.schema,
      evaluatedAt: input.evaluatedAt,
      maxSnapshotAgeMs: input.maxSnapshotAgeMs,
      subject: `${schemaEntry.demoProjectId} planning snapshot`
    });
    if (
      Date.parse(snapshot.observedAt) < Date.parse(target.proposal.observedAt)
    ) {
      fail(`${schemaEntry.demoProjectId} planning snapshot predates its target`);
    }
    assertSnapshotMatchesTarget(snapshot, schemaEntry.schema, target);
    const project = planProjectObservation(
      schemaEntry.demoProjectId,
      schemaEntry.schema,
      snapshot
    );
    projects.push(project);
    actions.push(...actionsForObservation(project, target, schemaEntry.schema));
  }
  const payload = planPayload({
    apiVersion: API_VERSION,
    kind: "GitHubProjectDisplayColorPlan",
    schemaVersion: DISPLAY_SCHEMA_VERSION,
    ...DISPLAY_MARKERS,
    mode: "display-only-dry-run",
    evaluatedAt: input.evaluatedAt,
    maxSnapshotAgeMs: input.maxSnapshotAgeMs,
    targetManifestDigest: manifest.contentDigest,
    projects,
    actions
  });
  return immutableCanonicalSnapshot(
    assertDocument("GitHubProjectDisplayColorPlan", {
      ...payload,
      planDigest: digest(payload)
    })
  );
}

export function readbackDisplayOnlyProjectColorReconciliation(input: {
  readonly targetManifest: unknown;
  readonly confirmedTargetManifestDigest: Digest;
  readonly projectSchemas: ValidatedDemoProjectSchemaCatalog;
  readonly confirmedPlan: unknown;
  readonly confirmedPlanDigest: Digest;
  readonly snapshots: readonly {
    readonly demoProjectId: DemoProjectId;
    readonly snapshot: unknown;
  }[];
  readonly reconciledAt: string;
  readonly maxSnapshotAgeMs: number;
}): GitHubProjectDisplayColorReadback {
  const schemas = revalidateProjectSchemas(input.projectSchemas);
  const manifest = validateManifest(input.targetManifest, schemas);
  assertConfirmedManifest(manifest, input.confirmedTargetManifestDigest);
  const plan = validatePlan({
    value: input.confirmedPlan,
    confirmedPlanDigest: input.confirmedPlanDigest,
    manifest,
    schemas
  });
  if (
    !isCanonicalUtcDateTime(input.reconciledAt) ||
    input.maxSnapshotAgeMs !== plan.maxSnapshotAgeMs ||
    input.snapshots.length !== schemas.entries.length ||
    Date.parse(input.reconciledAt) < Date.parse(plan.evaluatedAt)
  ) {
    fail("display color readback inputs differ from the confirmed plan");
  }
  const projects: GitHubProjectDisplayColorReadback["projects"][number][] = [];
  for (let index = 0; index < schemas.entries.length; index += 1) {
    const schemaEntry = schemas.entries[index]!;
    const target = manifest.spec.targets[index]!;
    const observed = input.snapshots[index];
    if (observed?.demoProjectId !== schemaEntry.demoProjectId) {
      fail("display readback snapshots differ from the confirmed target order");
    }
    const snapshot = validateSnapshot({
      value: observed.snapshot,
      schema: schemaEntry.schema,
      evaluatedAt: input.reconciledAt,
      maxSnapshotAgeMs: input.maxSnapshotAgeMs,
      subject: `${schemaEntry.demoProjectId} readback snapshot`,
      mustBeAfter: plan.evaluatedAt
    });
    assertSnapshotMatchesTarget(snapshot, schemaEntry.schema, target);
    const remainingColorDrift =
      schemaEntry.schema.fields.flatMap((field, fieldIndex) => {
        const observedField = snapshot.customFields[fieldIndex]!;
        return field.options.flatMap((option, optionIndex) => {
          const observedOption = observedField.options[optionIndex]!;
          return observedOption.color === option.color
            ? []
            : [
                {
                  fieldNodeId: observedField.nodeId,
                  optionNodeId: observedOption.nodeId,
                  actualColor: observedOption.color,
                  expectedColor: option.color
                }
              ];
        });
      });
    projects.push({
      demoProjectId: schemaEntry.demoProjectId,
      projectSchemaDigest: digest(schemaEntry.schema),
      projectNodeId: snapshot.project.nodeId,
      snapshotDigest: digest(snapshot),
      observedAt: snapshot.observedAt,
      exactIdentityVerified: true,
      schemaVerified: true,
      viewObservation: {
        nodeId: snapshot.view.nodeId,
        name: snapshot.view.name,
        observedLayout: snapshot.view.layout,
        observedVisibleFields: snapshot.view.visibleFields
      },
      remainingColorDrift
    });
  }
  const payload = {
    apiVersion: API_VERSION,
    kind: "GitHubProjectDisplayColorReadback" as const,
    schemaVersion: DISPLAY_SCHEMA_VERSION,
    ...DISPLAY_MARKERS,
    mode: "display-only-readback" as const,
    reconciledAt: input.reconciledAt,
    maxSnapshotAgeMs: input.maxSnapshotAgeMs,
    targetManifestDigest: manifest.contentDigest,
    confirmedPlanDigest: plan.planDigest,
    success: projects.every(
      (project) => project.remainingColorDrift.length === 0
    ),
    runtimeBindingProduced: false as const,
    projects
  };
  return immutableCanonicalSnapshot(
    assertDocument("GitHubProjectDisplayColorReadback", {
      ...payload,
      reportDigest: digest(payload)
    })
  );
}
