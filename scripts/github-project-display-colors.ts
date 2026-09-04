#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { canonicalJson } from "../src/canonical.js";
import type { DemoProjectId } from "../src/demo-types.js";
import {
  createDisplayOnlyProjectTargetManifest,
  planDisplayOnlyProjectColorReconciliation,
  readbackDisplayOnlyProjectColorReconciliation
} from "../src/github-project-display-colors.js";
import {
  validateDemoProjectSchemaCatalog,
  type ValidatedDemoProjectSchemaCatalog
} from "../src/github-projects.js";
import type { GitHubProjectSchema } from "../src/github-types.js";
import { parseStrictJson } from "../src/strict-json.js";
import type { Digest } from "../src/types.js";
import { assertDocument } from "../src/validation.js";

type Command = "target-manifest" | "plan" | "readback";

interface CliArguments {
  readonly command: Command;
  readonly catalogPath: string;
  readonly reservationsPath: string;
  readonly coreSchemaPath: string;
  readonly schemaRoot: string;
  readonly snapshotsPath: string;
  readonly targetManifestPath: string | null;
  readonly confirmedTargetManifestDigest: Digest | null;
  readonly inputPath: string | null;
  readonly confirmedPlanDigest: Digest | null;
  readonly evaluatedAt: string;
  readonly maxSnapshotAgeMs: number;
  readonly outputPath: string | null;
}

const VALUE_FLAGS = new Set([
  "--catalog",
  "--reservations",
  "--core-schema",
  "--schema-root",
  "--snapshots",
  "--target-manifest",
  "--confirmed-target-manifest-digest",
  "--input",
  "--confirmed-plan-digest",
  "--evaluated-at",
  "--max-snapshot-age-ms",
  "--output"
]);

function digestArgument(value: string | null, name: string): Digest | null {
  if (value !== null && !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError(`${name} must be a sha256 digest`);
  }
  return value as Digest | null;
}

function parseArguments(values: readonly string[]): CliArguments {
  if (values.includes("--apply") || values.includes("--execute")) {
    throw new TypeError(
      "display-only Project color reconciliation is dry-run only; readback performs no mutation"
    );
  }
  const command = values[0];
  if (
    command !== "target-manifest" &&
    command !== "plan" &&
    command !== "readback"
  ) {
    throw new TypeError(
      "display-only Project color reconciliation requires target-manifest, plan, or readback"
    );
  }
  const parsed = new Map<string, string>();
  for (let index = 1; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (
      name === undefined ||
      !VALUE_FLAGS.has(name) ||
      value === undefined ||
      value.startsWith("--") ||
      parsed.has(name)
    ) {
      throw new TypeError(
        `invalid or duplicate display-only CLI argument ${name ?? "<missing>"}`
      );
    }
    parsed.set(name, value);
  }
  const snapshotsPath = parsed.get("--snapshots");
  const evaluatedAt = parsed.get("--evaluated-at");
  if (snapshotsPath === undefined || evaluatedAt === undefined) {
    throw new TypeError("--snapshots and --evaluated-at are required");
  }
  const maxSnapshotAgeMs = Number(
    parsed.get("--max-snapshot-age-ms") ?? "300000"
  );
  if (!Number.isSafeInteger(maxSnapshotAgeMs) || maxSnapshotAgeMs < 1) {
    throw new TypeError("--max-snapshot-age-ms must be a positive safe integer");
  }
  const targetManifestPath = parsed.get("--target-manifest") ?? null;
  const confirmedTargetManifestDigest = digestArgument(
    parsed.get("--confirmed-target-manifest-digest") ?? null,
    "--confirmed-target-manifest-digest"
  );
  const inputPath = parsed.get("--input") ?? null;
  const confirmedPlanDigest = digestArgument(
    parsed.get("--confirmed-plan-digest") ?? null,
    "--confirmed-plan-digest"
  );
  if (
    command !== "target-manifest" &&
    (targetManifestPath === null ||
      confirmedTargetManifestDigest === null)
  ) {
    throw new TypeError(
      `${command} requires --target-manifest and --confirmed-target-manifest-digest`
    );
  }
  if (
    command === "readback" &&
    (inputPath === null || confirmedPlanDigest === null)
  ) {
    throw new TypeError(
      "readback requires --input and --confirmed-plan-digest"
    );
  }
  return {
    command,
    catalogPath:
      parsed.get("--catalog") ??
      "config/v1alpha1/demo-portfolio/catalog.json",
    reservationsPath:
      parsed.get("--reservations") ??
      "config/v1alpha1/demo-portfolio/identity-reservations.json",
    coreSchemaPath:
      parsed.get("--core-schema") ?? "config/v1alpha1/github-project.json",
    schemaRoot:
      parsed.get("--schema-root") ?? "config/v1alpha1/demo-projects",
    snapshotsPath,
    targetManifestPath,
    confirmedTargetManifestDigest,
    inputPath,
    confirmedPlanDigest,
    evaluatedAt,
    maxSnapshotAgeMs,
    outputPath: parsed.get("--output") ?? null
  };
}

async function readJson(filePath: string): Promise<unknown> {
  return parseStrictJson(await readFile(path.resolve(filePath), "utf8"));
}

async function emit(value: unknown, outputPath: string | null): Promise<void> {
  const serialized = `${canonicalJson(value)}\n`;
  if (outputPath === null) {
    process.stdout.write(serialized);
    return;
  }
  await writeFile(path.resolve(outputPath), serialized, {
    encoding: "utf8",
    flag: "wx"
  });
}

async function loadProjectSchemas(
  arguments_: CliArguments
): Promise<ValidatedDemoProjectSchemaCatalog> {
  const catalog = await readJson(arguments_.catalogPath);
  const reservations = await readJson(arguments_.reservationsPath);
  const catalogDocument = assertDocument("DemoCatalog", catalog);
  const entries = await Promise.all(
    catalogDocument.spec.entries.map(async (entry) => ({
      demoProjectId: entry.id,
      schema: assertDocument(
        "GitHubProjectSchema",
        await readJson(
          path.join(
            arguments_.schemaRoot,
            entry.id,
            "project-schema.json"
          )
        )
      ) as GitHubProjectSchema
    }))
  );
  return validateDemoProjectSchemaCatalog({
    catalog,
    reservations,
    coreSchema: await readJson(arguments_.coreSchemaPath),
    entries
  });
}

async function loadSnapshots(
  projectSchemas: ValidatedDemoProjectSchemaCatalog,
  snapshotsPath: string
): Promise<
  readonly {
    readonly demoProjectId: DemoProjectId;
    readonly snapshot: unknown;
  }[]
> {
  return Promise.all(
    projectSchemas.entries.map(async (entry) => ({
      demoProjectId: entry.demoProjectId,
      snapshot: await readJson(
        path.join(snapshotsPath, `${entry.demoProjectId}.display.json`)
      )
    }))
  );
}

const arguments_ = parseArguments(process.argv.slice(2));
const projectSchemas = await loadProjectSchemas(arguments_);
const snapshots = await loadSnapshots(
  projectSchemas,
  arguments_.snapshotsPath
);

switch (arguments_.command) {
  case "target-manifest": {
    await emit(
      createDisplayOnlyProjectTargetManifest({
        projectSchemas,
        snapshots,
        generatedAt: arguments_.evaluatedAt,
        maxSnapshotAgeMs: arguments_.maxSnapshotAgeMs
      }),
      arguments_.outputPath
    );
    break;
  }
  case "plan": {
    const plan = planDisplayOnlyProjectColorReconciliation({
      targetManifest: await readJson(arguments_.targetManifestPath!),
      confirmedTargetManifestDigest:
        arguments_.confirmedTargetManifestDigest!,
      projectSchemas,
      snapshots,
      evaluatedAt: arguments_.evaluatedAt,
      maxSnapshotAgeMs: arguments_.maxSnapshotAgeMs
    });
    await emit(plan, arguments_.outputPath);
    if (plan.actions.length > 0) process.exitCode = 2;
    break;
  }
  case "readback": {
    const readback = readbackDisplayOnlyProjectColorReconciliation({
      targetManifest: await readJson(arguments_.targetManifestPath!),
      confirmedTargetManifestDigest:
        arguments_.confirmedTargetManifestDigest!,
      projectSchemas,
      confirmedPlan: await readJson(arguments_.inputPath!),
      confirmedPlanDigest: arguments_.confirmedPlanDigest!,
      snapshots,
      reconciledAt: arguments_.evaluatedAt,
      maxSnapshotAgeMs: arguments_.maxSnapshotAgeMs
    });
    await emit(readback, arguments_.outputPath);
    if (!readback.success) process.exitCode = 2;
    break;
  }
}
