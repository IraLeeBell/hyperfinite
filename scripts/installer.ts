#!/usr/bin/env node

import {
  lstatSync,
  openSync,
  closeSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

import { canonicalJson, digest } from "../src/canonical.js";
import {
  assertInstallationJournalBound,
  planInstallation,
  validateMigrationManifest
} from "../src/packaging.js";
import type { InstallationReceipt } from "../src/packaging-types.js";
import { assertDocument } from "../src/validation.js";

type Command = "plan" | "offline-validate";

interface Arguments {
  readonly command: Command;
  readonly config: string;
  readonly releaseManifest: string;
  readonly migrationManifest: string;
  readonly state: string;
  readonly backupEvidence: string;
  readonly recoveryBaseState: string | null;
  readonly receipts: string | null;
  readonly output: string | null;
}

interface RepositoryLayout {
  readonly root: string;
  readonly gitDirectories: readonly string[];
}

let repositoryLayoutCache: RepositoryLayout | null = null;

function pathIsWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function gitPath(root: string, argument: string): string {
  const result = spawnSync(
    "git",
    [
      "-c",
      "core.fsmonitor=false",
      "-C",
      root,
      "rev-parse",
      argument
    ],
    {
      encoding: "utf8",
      env: {
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_NO_LAZY_FETCH: "1",
        GIT_OPTIONAL_LOCKS: "0",
        PATH: process.env.PATH ?? ""
      },
      maxBuffer: 65_536,
      shell: false,
      timeout: 10_000
    }
  );
  if (result.status !== 0 || result.error !== undefined) {
    throw new TypeError(`installer cannot resolve ${argument}`);
  }
  return result.stdout.trim();
}

function repositoryLayout(): RepositoryLayout {
  if (repositoryLayoutCache !== null) return repositoryLayoutCache;
  const cwd = realpathSync(process.cwd());
  const root = realpathSync(path.resolve(gitPath(cwd, "--show-toplevel")));
  if (root !== cwd) {
    throw new TypeError("installer must run from the canonical Git top-level");
  }
  repositoryLayoutCache = {
    root,
    gitDirectories: [
      gitPath(root, "--absolute-git-dir"),
      gitPath(root, "--git-common-dir")
    ].map((entry) => realpathSync(path.resolve(root, entry)))
  };
  return repositoryLayoutCache;
}

function argumentValue(args: readonly string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new TypeError(`${name} requires one value`);
  }
  return value;
}

function parseArguments(args: readonly string[]): Arguments {
  if (args.includes("apply") || args.includes("--apply") || args.includes("--execute")) {
    throw new TypeError(
      "live apply is available only through an injected trusted adapter with human-signed authorization"
    );
  }
  const valueFlags = new Set([
    "--config",
    "--release-manifest",
    "--migrations",
    "--state",
    "--backup-evidence",
    "--recovery-base-state",
    "--receipts",
    "--output"
  ]);
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) continue;
    if (valueFlags.has(argument)) {
      index += 1;
      continue;
    }
    if (!argument.startsWith("--")) positional.push(argument);
  }
  const commandCandidate = positional[0];
  if (positional.length > 1) {
    throw new TypeError("installer accepts exactly one positional command");
  }
  for (const flag of valueFlags) {
    if (args.filter((argument) => argument === flag).length > 1) {
      throw new TypeError(`installer argument ${flag} may appear only once`);
    }
  }
  const command = commandCandidate ?? "plan";
  if (command === "validate") {
    throw new TypeError(
      "validate is ambiguous; use offline-validate, or the trusted adapter live-validation API"
    );
  }
  if (command !== "plan" && command !== "offline-validate") {
    throw new TypeError(`unknown installer command ${command}`);
  }
  const known = new Set([
    "plan",
    "offline-validate",
    "--config",
    "--release-manifest",
    "--migrations",
    "--state",
    "--backup-evidence",
    "--recovery-base-state",
    "--receipts",
    "--output"
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value?.startsWith("--") && !known.has(value)) {
      throw new TypeError(`unknown installer argument ${value}`);
    }
  }
  return {
    command,
    config:
      argumentValue(args, "--config") ??
      "examples/customer-installation/installation.json",
    releaseManifest:
      argumentValue(args, "--release-manifest") ??
      "examples/customer-installation/release-manifest.json",
    migrationManifest:
      argumentValue(args, "--migrations") ?? "config/v1alpha1/migrations.json",
    state:
      argumentValue(args, "--state") ??
      "examples/customer-installation/state.json",
    backupEvidence:
      argumentValue(args, "--backup-evidence") ??
      "examples/customer-installation/backup-evidence.json",
    recoveryBaseState: argumentValue(args, "--recovery-base-state"),
    receipts: argumentValue(args, "--receipts"),
    output: argumentValue(args, "--output")
  };
}

function safePath(relativePath: string, mustExist: boolean): string {
  if (
    path.isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    relativePath.includes("\0") ||
    relativePath.normalize("NFC") !== relativePath ||
    relativePath
      .split("/")
      .some(
        (segment) =>
          segment.length === 0 ||
          segment === "." ||
          segment === ".." ||
          segment === ".git"
      )
  ) {
    throw new TypeError("installer path is not a canonical repository-relative path");
  }
  const layout = repositoryLayout();
  const root = layout.root;
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (
    relative.length === 0 ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new TypeError("installer paths must remain beneath the current repository");
  }
  if (
    layout.gitDirectories.some((directory) =>
      pathIsWithin(directory, resolved)
    )
  ) {
    throw new TypeError("installer path cannot enter Git metadata");
  }
  if (mustExist) {
    const stat = lstatSync(resolved);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      realpathSync(resolved) !== resolved ||
      stat.size > 8_388_608
    ) {
      throw new TypeError(`installer input is not a bounded regular file: ${relativePath}`);
    }
  } else {
    const parent = path.dirname(resolved);
    const stat = lstatSync(parent);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      realpathSync(parent) !== parent
    ) {
      throw new TypeError("installer output parent is not a canonical directory");
    }
  }
  return resolved;
}

function readJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(safePath(relativePath, true), "utf8")) as unknown;
}

function emit(value: unknown, output: string | null): void {
  const content = `${canonicalJson(value)}\n`;
  if (output === null) {
    process.stdout.write(content);
    return;
  }
  const descriptor = openSync(safePath(output, false), "wx", 0o600);
  try {
    writeFileSync(descriptor, content, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

function readReceipts(receiptsPath: string | null): readonly InstallationReceipt[] {
  if (receiptsPath === null) return [];
  const value = readJson(receiptsPath);
  if (!Array.isArray(value)) throw new TypeError("receipt journal must be an array");
  const receiptCount = assertInstallationJournalBound(value);
  const receipts: InstallationReceipt[] = [];
  for (let index = 0; index < receiptCount; index += 1) {
    const receipt = value[index];
    const document = assertDocument("PackagingDocument", receipt);
    if (document.kind !== "InstallationReceipt") {
      throw new TypeError("receipt journal contains a non-receipt document");
    }
    receipts.push(document);
  }
  return receipts;
}

function main(): void {
  const args = parseArguments(process.argv.slice(2));
  const config = readJson(args.config);
  const releaseManifest = readJson(args.releaseManifest);
  const migrationManifest = readJson(args.migrationManifest);
  const currentState = readJson(args.state);
  const backupEvidence = readJson(args.backupEvidence);
  const recoveryBaseState =
    args.recoveryBaseState === null
      ? undefined
      : readJson(args.recoveryBaseState);
  const receipts = readReceipts(args.receipts);
  validateMigrationManifest(migrationManifest);
  const result = planInstallation({
    config,
    releaseManifest,
    migrationManifest,
    currentState,
    backupEvidence,
    ...(recoveryBaseState === undefined ? {} : { recoveryBaseState }),
    receipts
  });
  emit(
    args.command === "plan"
      ? result.plan
      : {
          mode: "offline-validate",
          valid: true,
          planDigest: result.plan.planDigest,
          expectedResultStateDigest: digest(result.expectedResultState),
          applyRequested: result.plan.applyRequested
        },
    args.output
  );
}

main();
