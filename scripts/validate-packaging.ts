#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { canonicalJson, digest } from "../src/canonical.js";
import {
  planInstallation,
  validateMigrationManifest
} from "../src/packaging.js";
import type {
  CompatibilityMatrix,
  InstallationConfig,
  InstallationState,
  OpenSourceReadinessAssessment,
  PackagingDocument,
  ReleaseManifest
} from "../src/packaging-types.js";
import { validateOpenSourceAssessment } from "../src/release.js";
import { assertDocument } from "../src/validation.js";

const EXPECTED_LICENSE_SHA256 =
  "60eb5d7deb8d13876be870afae1481c3b8a9446f062f0d99fdef38ac0945646a";
const EXPECTED_NOTICES_SHA256 =
  "1e5eabc4458bd403ae53bc1a602ab69d75e0c46cffe83b705e66077bda07bc0d";

async function source(relativePath: string): Promise<string> {
  return readFile(path.resolve(relativePath), "utf8");
}

async function json(relativePath: string): Promise<unknown> {
  return JSON.parse(await source(relativePath)) as unknown;
}

function packaging<T extends PackagingDocument>(
  value: unknown,
  kind: T["kind"]
): T {
  const document = assertDocument("PackagingDocument", value);
  if (document.kind !== kind) throw new TypeError(`expected ${kind}`);
  return document as T;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertContains(
  content: string,
  expected: readonly string[],
  subject: string
): void {
  for (const value of expected) {
    if (!content.includes(value)) {
      throw new TypeError(`${subject} lacks required packaging statement: ${value}`);
    }
  }
}

function actualNpmMajor(): number {
  const userAgent = process.env["npm_config_user_agent"];
  const match = /^npm\/(\d+)\./u.exec(userAgent ?? "");
  if (match?.[1] === undefined) {
    throw new TypeError("npm version is unavailable; run through npm");
  }
  return Number(match[1]);
}

function actualGhVersion(): string {
  const result = spawnSync("gh", ["--version"], {
    encoding: "utf8",
    env: {
      HOME: process.env.HOME ?? "/dev/null",
      PATH: process.env.PATH ?? ""
    },
    maxBuffer: 65_536,
    shell: false,
    timeout: 10_000
  });
  if (result.status !== 0 || result.error !== undefined) {
    throw new TypeError("GitHub CLI version is unavailable");
  }
  const match = /^gh version (\d+\.\d+\.\d+)/u.exec(result.stdout);
  if (match?.[1] === undefined) {
    throw new TypeError("GitHub CLI returned an unknown version");
  }
  return match[1];
}

function actualGitVersion(): string {
  const result = spawnSync("git", ["--version"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
    maxBuffer: 65_536,
    shell: false,
    timeout: 10_000
  });
  const match =
    result.status === 0
      ? /^git version (\d+\.\d+\.\d+)/u.exec(result.stdout)
      : null;
  if (match?.[1] === undefined) {
    throw new TypeError("Git version is unavailable");
  }
  return match[1];
}

function versionAtLeast(actual: string, minimum: string): boolean {
  const left = actual.split(".").map((part) => BigInt(part));
  const right = minimum.split(".").map((part) => BigInt(part));
  for (let index = 0; index < 3; index += 1) {
    if ((left[index] ?? 0n) > (right[index] ?? 0n)) return true;
    if ((left[index] ?? 0n) < (right[index] ?? 0n)) return false;
  }
  return true;
}

async function main(): Promise<void> {
  const [
    packageSource,
    lockSource,
    compatibilityValue,
    migrationValue,
    readinessValue,
    configValue,
    manifestValue,
    stateValue,
    backupValue,
    payload,
    compatibilityDoc,
    administratorRunbook,
    releaseDoc,
    readinessDoc,
    candidateDoc,
    license,
    notices,
    runtimePolicy
  ] = await Promise.all([
    source("package.json"),
    source("package-lock.json"),
    json("config/v1alpha1/compatibility.json"),
    json("config/v1alpha1/migrations.json"),
    json("config/v1alpha1/open-source-readiness.json"),
    json("examples/customer-installation/installation.json"),
    json("examples/customer-installation/release-manifest.json"),
    json("examples/customer-installation/state.json"),
    json("examples/customer-installation/backup-evidence.json"),
    source("examples/customer-installation/payload/example.txt"),
    source("docs/compatibility.md"),
    source("docs/runbooks/customer-administrator.md"),
    source("docs/release/local-release-evidence.md"),
    source("docs/governance/open-source-readiness.md"),
    source("docs/release/release-candidate-checklist.md"),
    source("LICENSE"),
    source("THIRD_PARTY_NOTICES.md"),
    json("config/v1alpha1/copilot-runtime-policy.json")
  ]);

  const packageDocument = JSON.parse(packageSource) as {
    readonly version?: unknown;
    readonly engines?: { readonly node?: unknown };
    readonly scripts?: Readonly<Record<string, string>>;
  };
  const lock = JSON.parse(lockSource) as {
    readonly version?: unknown;
    readonly packages?: {
      readonly ""?: {
        readonly version?: unknown;
        readonly engines?: { readonly node?: unknown };
      };
    };
  };
  const compatibility = packaging<CompatibilityMatrix>(
    compatibilityValue,
    "CompatibilityMatrix"
  );
  const migrations = validateMigrationManifest(migrationValue);
  const readiness = validateOpenSourceAssessment(readinessValue, "0.1.0");
  const config = packaging<InstallationConfig>(
    configValue,
    "InstallationConfig"
  );
  const manifest = packaging<ReleaseManifest>(
    manifestValue,
    "ReleaseManifest"
  );
  const state = packaging<InstallationState>(stateValue, "InstallationState");
  const backup = packaging(
    backupValue,
    "InstallationBackupEvidence"
  );

  if (
    packageDocument.version !== compatibility.packageVersion ||
    lock.version !== compatibility.packageVersion ||
    lock.packages?.[""]?.version !== compatibility.packageVersion ||
    packageDocument.engines?.node !== "^24.0.0 || ^26.0.0" ||
    lock.packages?.[""]?.engines?.node !== "^24.0.0 || ^26.0.0" ||
    migrations.currentVersion !== compatibility.packageVersion
  ) {
    throw new TypeError("package, lockfile, compatibility, and migration versions drifted");
  }
  for (const requiredScript of [
    "installer",
    "release:local",
    "validate:packaging"
  ]) {
    if (packageDocument.scripts?.[requiredScript] === undefined) {
      throw new TypeError(`package script ${requiredScript} is missing`);
    }
  }
  for (const prohibitedScript of ["publish", "release", "deploy"]) {
    if (packageDocument.scripts?.[prohibitedScript] !== undefined) {
      throw new TypeError(`prohibited autonomous package script ${prohibitedScript}`);
    }
  }

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (
    !compatibility.nodeMajors.includes(nodeMajor) ||
    !compatibility.npmMajors.includes(actualNpmMajor()) ||
    actualGhVersion() !== compatibility.ghCliVersion ||
    !versionAtLeast(actualGitVersion(), compatibility.gitMinimumVersion)
  ) {
    throw new TypeError("local toolchain is outside the tested compatibility matrix");
  }
  const runtime = runtimePolicy as {
    readonly metadata?: { readonly version?: unknown };
    readonly toolchain?: { readonly ghAwVersion?: unknown };
  };
  if (
    runtime.metadata?.version !== compatibility.contractVersions.runtime ||
    runtime.toolchain?.ghAwVersion !== compatibility.ghAwVersion
  ) {
    throw new TypeError("runtime policy and compatibility matrix drifted");
  }
  for (const workflow of [
    ".github/workflows/agentic-framing.md",
    ".github/workflows/agentic-execution.md",
    ".github/workflows/agentic-review.md"
  ]) {
    const content = await source(workflow);
    assertContains(content, ["node-version: 24"], workflow);
  }
  assertContains(
    await source(".github/workflows/agentic-execution.md"),
    ["runs-on: ubuntu-slim"],
    "agentic execution workflow"
  );
  assertContains(
    await source(".github/workflows/agentic-review.md"),
    ['version: "1.0.79"', "--no-auto-update"],
    "agentic review workflow"
  );

  if (
    config.apply.enabled ||
    config.apply.humanChangeId !== null ||
    config.target.repositoryFullName !==
      "example-organization/example-repository" ||
    config.target.expectedHeadSha === manifest.source.headSha ||
    config.expectedResultHeadSha === config.target.expectedHeadSha ||
    manifest.files[0]?.digest !==
      `sha256:${sha256(payload)}` ||
    manifest.files[0]?.size !== Buffer.byteLength(payload)
  ) {
    throw new TypeError("hermetic installation example drifted or became mutating");
  }
  const first = planInstallation({
    config,
    releaseManifest: manifest,
    migrationManifest: migrations,
    currentState: state,
    backupEvidence: backup,
    receipts: []
  });
  const second = planInstallation({
    config: structuredClone(config),
    releaseManifest: structuredClone(manifest),
    migrationManifest: structuredClone(migrations),
    currentState: structuredClone(state),
    backupEvidence: structuredClone(backup),
    receipts: []
  });
  if (
    canonicalJson(first) !== canonicalJson(second) ||
    first.plan.applyRequested ||
    config.releaseManifestDigest !== digest(manifest) ||
    config.migrationManifestDigest !== digest(migrations) ||
    config.expectedStateDigest !== digest(state) ||
    config.backupEvidenceDigest !== digest(backup)
  ) {
    throw new TypeError("installer example is nondeterministic or has stale bindings");
  }

  const exampleSources = [
    await source("examples/customer-installation/README.md"),
    await source("examples/customer-installation/installation.json"),
    await source("examples/customer-installation/release-manifest.json"),
    await source("examples/customer-installation/state.json"),
    await source("examples/customer-installation/backup-evidence.json"),
    payload
  ].join("\n");
  if (
    /(ghp_|github_pat_|-----BEGIN [A-Z ]+PRIVATE KEY-----|AKIA[0-9A-Z]{16})/u.test(
      exampleSources
    )
  ) {
    throw new TypeError("customer example contains credential-like content");
  }

  assertContains(
    compatibilityDoc,
    [
      "`agentic-framework 0.1.0`",
      "`github/gh-aw v0.86.2`",
      "`1.0.79`",
      "GitHub Enterprise Server | Unsupported and unverified"
    ],
    "compatibility documentation"
  );
  assertContains(
    administratorRunbook,
    [
      "checked-in CLI cannot apply",
      "no PAT",
      "offline-validate",
      "Receipt journals are capped at 512",
      "repeat an effect because",
      "Do not recursively delete"
    ],
    "administrator runbook"
  );
  assertContains(
    releaseDoc,
    [
      "does not publish, sign, approve,",
      "--require-trusted-attestation",
      "`assertReleasePath`",
      "unsigned local evidence"
    ],
    "release documentation"
  );
  assertContains(
    readinessDoc,
    ["not-ready", "LICENSE", "Automation is prohibited"],
    "open-source readiness documentation"
  );
  assertContains(
    candidateDoc,
    ["decision: no-go", "selfApproved: false", "The checklist cannot change its"],
    "release-candidate documentation"
  );
  if (
    sha256(license) !== EXPECTED_LICENSE_SHA256 ||
    sha256(notices) !== EXPECTED_NOTICES_SHA256
  ) {
    throw new TypeError("LICENSE or THIRD_PARTY_NOTICES.md changed from the reviewed baseline");
  }
  if (
    readiness.decision !== "not-ready" ||
    readiness.authoritative ||
    (readiness as OpenSourceReadinessAssessment).categories.length !== 9
  ) {
    throw new TypeError("open-source readiness assessment weakened");
  }
  console.log(
    `Validated packaging contracts, Node ${nodeMajor}, npm ${actualNpmMajor()}, gh ${actualGhVersion()}, git ${actualGitVersion()}, hermetic example, and documentation drift.`
  );
}

await main();
