#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { canonicalJson, digest } from "../src/canonical.js";
import {
  createDemoProjectTargetManifest,
  exportDemoProjectCatalogConfiguration,
  exportProjectConfiguration,
  importDemoProjectCatalogConfiguration,
  importProjectConfiguration,
  planDemoProjectCatalogSetup,
  planProjectSetup,
  planVerifiedDemoProjectBootstrap,
  reconcileVerifiedDemoProjectBootstrap,
  validateDemoProjectSchemaCatalog,
  validateProjectSchemaSemantics,
  type LiveGitHubProject,
  type LiveDemoProjectAdminSnapshot,
  type VerifiedDemoProjectBootstrapPlan,
  type ValidatedDemoProjectSchemaCatalog
} from "../src/github-projects.js";
import { validatePortfolioFoundation } from "../src/demo-portfolio.js";
import { parseStrictJson } from "../src/strict-json.js";
import { assertDocument } from "../src/validation.js";
import type { DemoProjectId } from "../src/demo-types.js";
import type { Digest } from "../src/types.js";
import type { GitHubProjectBinding } from "../src/github-types.js";

interface CliArguments {
  readonly command:
    | "bootstrap-plan"
    | "bootstrap-readback"
    | "export"
    | "import"
    | "plan"
    | "target-manifest"
    | "validate";
  readonly schemaPath: string;
  readonly catalogPath: string | null;
  readonly reservationsPath: string;
  readonly coreSchemaPath: string;
  readonly schemaRoot: string;
  readonly livePath: string | null;
  readonly bindingPath: string | null;
  readonly inputPath: string | null;
  readonly outputPath: string | null;
  readonly evaluatedAt: string;
  readonly targetManifestPath: string | null;
  readonly confirmedTargetManifestDigest: Digest | null;
  readonly maxSnapshotAgeMs: number;
  readonly confirmedPlanDigest: Digest | null;
  readonly issueBindingsPath: string | null;
}

function argumentValue(
  arguments_: readonly string[],
  name: string
): string | null {
  const index = arguments_.indexOf(name);
  if (index === -1) return null;
  const value = arguments_[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new TypeError(`${name} requires a value`);
  }
  return value;
}

function parseArguments(arguments_: readonly string[]): CliArguments {
  if (arguments_.includes("--apply") || arguments_.includes("--execute")) {
    throw new TypeError(
      "Project creation and migration are explicit human-admin actions; this CLI is dry-run only"
    );
  }
  const positionalCommand = arguments_.find((value) => !value.startsWith("--"));
  const command =
    positionalCommand === undefined ? "plan" : positionalCommand;
  if (
    command !== "export" &&
    command !== "import" &&
    command !== "plan" &&
    command !== "bootstrap-plan" &&
    command !== "bootstrap-readback" &&
    command !== "target-manifest" &&
    command !== "validate"
  ) {
    throw new TypeError(`unknown command ${command}`);
  }
  const catalogPath = argumentValue(arguments_, "--catalog");
  if (catalogPath !== null && arguments_.includes("--schema")) {
    throw new TypeError("--schema and --catalog are mutually exclusive");
  }
  const maxSnapshotAgeMs = Number(
    argumentValue(arguments_, "--max-snapshot-age-ms") ?? "300000"
  );
  if (!Number.isSafeInteger(maxSnapshotAgeMs) || maxSnapshotAgeMs < 1) {
    throw new TypeError("--max-snapshot-age-ms must be a positive safe integer");
  }
  const confirmedPlanDigest = argumentValue(
    arguments_,
    "--confirmed-plan-digest"
  );
  if (
    confirmedPlanDigest !== null &&
    !/^sha256:[0-9a-f]{64}$/u.test(confirmedPlanDigest)
  ) {
    throw new TypeError("--confirmed-plan-digest must be a sha256 digest");
  }
  const confirmedTargetManifestDigest = argumentValue(
    arguments_,
    "--confirmed-target-manifest-digest"
  );
  if (
    confirmedTargetManifestDigest !== null &&
    !/^sha256:[0-9a-f]{64}$/u.test(confirmedTargetManifestDigest)
  ) {
    throw new TypeError(
      "--confirmed-target-manifest-digest must be a sha256 digest"
    );
  }
  return {
    command,
    schemaPath:
      argumentValue(arguments_, "--schema") ??
      "config/v1alpha1/github-project.json",
    catalogPath,
    reservationsPath:
      argumentValue(arguments_, "--reservations") ??
      "config/v1alpha1/demo-portfolio/identity-reservations.json",
    coreSchemaPath:
      argumentValue(arguments_, "--core-schema") ??
      "config/v1alpha1/github-project.json",
    schemaRoot:
      argumentValue(arguments_, "--schema-root") ??
      "config/v1alpha1/demo-projects",
    livePath: argumentValue(arguments_, "--live"),
    bindingPath: argumentValue(arguments_, "--binding"),
    inputPath: argumentValue(arguments_, "--input"),
    outputPath: argumentValue(arguments_, "--output"),
    evaluatedAt:
      argumentValue(arguments_, "--evaluated-at") ?? new Date().toISOString(),
    targetManifestPath: argumentValue(arguments_, "--target-manifest"),
    confirmedTargetManifestDigest:
      confirmedTargetManifestDigest as Digest | null,
    maxSnapshotAgeMs,
    confirmedPlanDigest: confirmedPlanDigest as Digest | null,
    issueBindingsPath: argumentValue(arguments_, "--issue-bindings")
  };
}

async function readJson(filePath: string): Promise<unknown> {
  return parseStrictJson(await readFile(path.resolve(filePath), "utf8"));
}

async function emit(value: string, outputPath: string | null): Promise<void> {
  if (outputPath === null) {
    process.stdout.write(value);
    return;
  }
  await writeFile(path.resolve(outputPath), value, { encoding: "utf8", flag: "wx" });
}

async function loadDemoProjectSchemas(
  arguments_: CliArguments
): Promise<ValidatedDemoProjectSchemaCatalog> {
  if (arguments_.catalogPath === null) {
    throw new TypeError("catalog mode requires --catalog");
  }
  const catalogValue = await readJson(arguments_.catalogPath);
  const reservationsValue = await readJson(arguments_.reservationsPath);
  const { catalog } = validatePortfolioFoundation(
    catalogValue,
    reservationsValue
  );
  const entries = await Promise.all(
    catalog.spec.entries.map(async (entry) => ({
      demoProjectId: entry.id,
      schema: assertDocument(
        "GitHubProjectSchema",
        await readJson(
          path.join(arguments_.schemaRoot, entry.id, "project-schema.json")
        )
      )
    }))
  );
  return validateDemoProjectSchemaCatalog({
    catalog: catalogValue,
    reservations: reservationsValue,
    coreSchema: await readJson(arguments_.coreSchemaPath),
    entries
  });
}

async function readCatalogBindings(
  projectSchemas: ValidatedDemoProjectSchemaCatalog,
  bindingRoot: string | null
): Promise<
  readonly {
    readonly demoProjectId: DemoProjectId;
    readonly binding: GitHubProjectBinding | null;
  }[]
> {
  if (bindingRoot === null) {
    return projectSchemas.entries.map((entry) => ({
      demoProjectId: entry.demoProjectId,
      binding: null
    }));
  }

  return Promise.all(
    projectSchemas.entries.map(async (entry) => ({
      demoProjectId: entry.demoProjectId,
      binding: assertDocument(
        "GitHubProjectBinding",
        await readJson(path.join(bindingRoot, `${entry.demoProjectId}.json`))
      )
    }))
  );
}

async function readAdminSnapshots(
  projectSchemas: ValidatedDemoProjectSchemaCatalog,
  livePath: string
): Promise<
  readonly {
    readonly demoProjectId: DemoProjectId;
    readonly snapshot: LiveDemoProjectAdminSnapshot;
  }[]
> {
  return Promise.all(
    projectSchemas.entries.map(async (entry) => ({
      demoProjectId: entry.demoProjectId,
      snapshot: (await readJson(
        path.join(livePath, `${entry.demoProjectId}.admin.json`)
      )) as LiveDemoProjectAdminSnapshot
    }))
  );
}

const arguments_ = parseArguments(process.argv.slice(2));
const catalogMode = arguments_.catalogPath !== null;

switch (arguments_.command) {
  case "target-manifest": {
    if (!catalogMode || arguments_.livePath === null) {
      throw new TypeError("target-manifest requires --catalog and --live");
    }
    const projectSchemas = await loadDemoProjectSchemas(arguments_);
    const manifest = createDemoProjectTargetManifest({
      projectSchemas,
      snapshots: await readAdminSnapshots(
        projectSchemas,
        arguments_.livePath
      ),
      evaluatedAt: arguments_.evaluatedAt,
      maxSnapshotAgeMs: arguments_.maxSnapshotAgeMs
    });
    await emit(`${canonicalJson(manifest)}\n`, arguments_.outputPath);
    break;
  }
  case "bootstrap-plan": {
    if (
      !catalogMode ||
      arguments_.livePath === null ||
      arguments_.issueBindingsPath === null ||
      arguments_.targetManifestPath === null ||
      arguments_.confirmedTargetManifestDigest === null
    ) {
      throw new TypeError(
        "bootstrap-plan requires --catalog, --live, --issue-bindings, --target-manifest, and --confirmed-target-manifest-digest"
      );
    }
    const projectSchemas = await loadDemoProjectSchemas(arguments_);
    const snapshots = await readAdminSnapshots(
      projectSchemas,
      arguments_.livePath
    );
    const plan = planVerifiedDemoProjectBootstrap({
      targetManifest: await readJson(arguments_.targetManifestPath),
      expectedTargetManifestDigest:
        arguments_.confirmedTargetManifestDigest,
      projectSchemas,
      snapshots,
      issueBindings: (await readJson(arguments_.issueBindingsPath)) as readonly {
        readonly demoProjectId: DemoProjectId;
        readonly scenarioIssueNodeId: string;
        readonly additionalIssueNodeIds: readonly string[];
      }[],
      evaluatedAt: arguments_.evaluatedAt,
      maxSnapshotAgeMs: arguments_.maxSnapshotAgeMs
    });
    await emit(`${canonicalJson(plan)}\n`, arguments_.outputPath);
    break;
  }
  case "bootstrap-readback": {
    if (
      !catalogMode ||
      arguments_.livePath === null ||
      arguments_.inputPath === null ||
      arguments_.targetManifestPath === null ||
      arguments_.confirmedPlanDigest === null
    ) {
      throw new TypeError(
        "bootstrap-readback requires --catalog, --live, --target-manifest, --input, and --confirmed-plan-digest"
      );
    }
    const projectSchemas = await loadDemoProjectSchemas(arguments_);
    const snapshots = await readAdminSnapshots(
      projectSchemas,
      arguments_.livePath
    );
    const report = reconcileVerifiedDemoProjectBootstrap({
      targetManifest: await readJson(arguments_.targetManifestPath),
      projectSchemas,
      confirmedPlan: (await readJson(
        arguments_.inputPath
      )) as VerifiedDemoProjectBootstrapPlan,
      confirmedPlanDigest: arguments_.confirmedPlanDigest,
      snapshots,
      reconciledAt: arguments_.evaluatedAt,
      maxSnapshotAgeMs: arguments_.maxSnapshotAgeMs
    });
    await emit(`${canonicalJson(report)}\n`, arguments_.outputPath);
    if (!report.apiSupportedPostconditionsMet) process.exitCode = 2;
    break;
  }
  case "validate": {
    if (catalogMode) {
      const projectSchemas = await loadDemoProjectSchemas(arguments_);
      await emit(
        `${canonicalJson({
          mode: "dry-run",
          demoCatalogDigest: projectSchemas.catalog.contentDigest,
          valid: true,
          schemas: projectSchemas.entries.map((entry) => ({
            demoProjectId: entry.demoProjectId,
            schemaDigest: digest(entry.schema)
          }))
        })}\n`,
        arguments_.outputPath
      );
      break;
    }
    const schema = assertDocument(
      "GitHubProjectSchema",
      await readJson(arguments_.schemaPath)
    );
    const problems = validateProjectSchemaSemantics(schema);
    await emit(
      `${canonicalJson({
        mode: "dry-run",
        valid: problems.length === 0,
        problems
      })}\n`,
      arguments_.outputPath
    );
    if (problems.length > 0) process.exitCode = 1;
    break;
  }
  case "plan": {
    if (arguments_.livePath === null) {
      throw new TypeError("plan requires --live with an exported fresh Project read");
    }
    if (catalogMode) {
      const projectSchemas = await loadDemoProjectSchemas(arguments_);
      const liveProjects = await Promise.all(
        projectSchemas.entries.map(async (entry) => ({
          demoProjectId: entry.demoProjectId,
          live: (await readJson(
            path.join(arguments_.livePath!, `${entry.demoProjectId}.json`)
          )) as LiveGitHubProject
        }))
      );
      const plan = planDemoProjectCatalogSetup({
        projectSchemas,
        liveProjects,
        evaluatedAt: arguments_.evaluatedAt
      });
      await emit(`${canonicalJson(plan)}\n`, arguments_.outputPath);
      if (
        !plan.valid ||
        plan.entries.some((entry) => entry.plan.actions.length > 0)
      ) {
        process.exitCode = 2;
      }
      break;
    }
    const schema = assertDocument(
      "GitHubProjectSchema",
      await readJson(arguments_.schemaPath)
    );
    const live = (await readJson(arguments_.livePath)) as LiveGitHubProject;
    const plan = planProjectSetup({
      schema,
      live,
      evaluatedAt: arguments_.evaluatedAt
    });
    await emit(`${canonicalJson(plan)}\n`, arguments_.outputPath);
    if (!plan.valid || plan.actions.length > 0) process.exitCode = 2;
    break;
  }
  case "export": {
    if (catalogMode) {
      const projectSchemas = await loadDemoProjectSchemas(arguments_);
      await emit(
        exportDemoProjectCatalogConfiguration({
          projectSchemas,
          bindings: await readCatalogBindings(
            projectSchemas,
            arguments_.bindingPath
          )
        }),
        arguments_.outputPath
      );
      break;
    }
    const schema = assertDocument(
      "GitHubProjectSchema",
      await readJson(arguments_.schemaPath)
    );
    const binding =
      arguments_.bindingPath === null
        ? null
        : assertDocument(
            "GitHubProjectBinding",
            await readJson(arguments_.bindingPath)
          );
    await emit(
      exportProjectConfiguration(schema, binding),
      arguments_.outputPath
    );
    break;
  }
  case "import": {
    if (arguments_.inputPath === null) {
      throw new TypeError("import requires --input");
    }
    const serialized = await readFile(
      path.resolve(arguments_.inputPath),
      "utf8"
    );
    const configuration = catalogMode
      ? importDemoProjectCatalogConfiguration({
          serialized,
          catalog: await readJson(arguments_.catalogPath!),
          reservations: await readJson(arguments_.reservationsPath),
          coreSchema: await readJson(arguments_.coreSchemaPath)
        })
      : importProjectConfiguration(serialized);
    await emit(`${canonicalJson(configuration)}\n`, arguments_.outputPath);
    break;
  }
}
