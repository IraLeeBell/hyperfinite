#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const workflowDirectory = path.resolve(".github/workflows");
const actionsLockPath = path.resolve(".github/aw/actions-lock.json");
const expectedVersion = "v0.86.2";

function run(command: string, args: readonly string[]): void {
  execFileSync(command, [...args], { stdio: "inherit" });
}

const versionResult = spawnSync("gh", ["aw", "version"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"]
});
if (versionResult.error !== undefined) throw versionResult.error;
process.stdout.write(versionResult.stdout);
process.stderr.write(versionResult.stderr);
if (versionResult.status !== 0) {
  throw new TypeError(`gh aw version failed with exit ${versionResult.status}`);
}
const version = `${versionResult.stdout}${versionResult.stderr}`.trim();
if (!version.includes(expectedVersion)) {
  throw new TypeError(`gh-aw ${expectedVersion} is required; received ${version}`);
}

const generatedPaths = [
  ...(await readdir(workflowDirectory))
    .filter((entry) => entry.endsWith(".lock.yml"))
    .sort()
    .map((entry) => path.join(workflowDirectory, entry)),
  actionsLockPath
];
if (generatedPaths.length === 1) {
  throw new TypeError("no generated Agentic Workflow locks were found");
}
const before = new Map(
  await Promise.all(
    generatedPaths.map(async (file) => [file, await readFile(file)] as const)
  )
);

run("gh", ["aw", "validate", "--strict", "--no-check-update"]);
run("gh", [
  "aw",
  "compile",
  "--gh-aw-ref",
  expectedVersion,
  "--strict",
  "--validate",
  "--approve",
  "--no-check-update"
]);
run("npm", ["run", "validate:workflows"]);

const drifted = [];
for (const file of generatedPaths) {
  const original = before.get(file);
  if (original === undefined || !original.equals(await readFile(file))) {
    drifted.push(path.relative(process.cwd(), file));
  }
}
if (drifted.length > 0) {
  throw new TypeError(
    `gh-aw validation changed generated artifacts: ${drifted.join(", ")}`
  );
}

run("git", ["diff", "--exit-code", "--", ...generatedPaths]);
console.log(
  `Validated ${generatedPaths.length} generated gh-aw artifacts without byte drift.`
);
