#!/usr/bin/env node
// Repeatable clean-extraction validation for every customer-starter
// profile: build the real archive from the exact reviewed repository head,
// extract it into a fresh directory with no Git history, run
// `npm ci --ignore-scripts --no-audit --no-fund` inside that extraction, and
// run every script the profile's selection advertises as standalone-runnable.
// This is the only mechanical check that a profile's
// package/script/import/schema/workflow closure checks (all static, all
// hermetic) cannot substitute for: it proves the archive is actually
// dependency-installable and runnable on its own, not merely closed on paper.
//
// Dependency installation reaches the network, so this script is intentionally
// NOT part of `npm test`/`validate:packaging` (which must stay hermetic); it is
// its own checked, explicitly-run validation step, and it writes a retained JSON
// evidence record (source commit, archive digest, and the exact
// command/exit-status/duration of every step) rather than only printing a
// pass/fail line.

import process from "node:process";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { canonicalJson } from "../src/canonical.js";
import {
  githubRepositoryFromRemote,
  sha256Bytes
} from "../src/release-support.js";
import { CUSTOMER_STARTER_PROFILE_CATALOG } from "../src/customer-starter-catalog.js";

const ROOT = process.cwd();

interface StepEvidence {
  readonly command: string;
  readonly cwd: string;
  readonly outcome: "success" | "expected-failure";
  readonly exitStatus: number;
  readonly signal: NodeJS.Signals | null;
  readonly durationMs: number;
}

interface ProfileEvidence {
  readonly profileId: string;
  readonly extendsProfileId: string | null;
  readonly advertisedScripts: readonly string[];
  readonly archiveDigest: string;
  readonly steps: readonly StepEvidence[];
}

function gitText(args: readonly string[]): string {
  const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8", shell: false });
  if (result.status !== 0 || result.error !== undefined) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function runStep(cwd: string, command: string, args: readonly string[]): StepEvidence {
  const label = [command, ...args].join(" ");
  process.stderr.write(`[customer-starter-extraction] ${label} (cwd=${cwd})\n`);
  const start = Date.now();
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: false });
  const durationMs = Date.now() - start;
  if (result.status !== 0 || result.error !== undefined) {
    throw new Error(`clean-extraction step failed: ${label} (cwd=${cwd})`);
  }
  return {
    command: label,
    cwd,
    outcome: "success",
    exitStatus: result.status,
    signal: result.signal,
    durationMs
  };
}

function validateProfile(
  profileId: string,
  baseSha: string,
  headSha: string,
  packageVersion: string
): ProfileEvidence {
  const profile = CUSTOMER_STARTER_PROFILE_CATALOG.profiles.find(
    (candidate) => candidate.profileId === profileId
  );
  if (profile === undefined) throw new Error(`unknown customer-starter profile ${profileId}`);
  const scratch = realpathSync(
    mkdtempSync(path.join(tmpdir(), `customer-starter-extraction-${profileId}-`))
  );
  try {
    const buildRoot = path.join(scratch, "build");
    const extractRoot = path.join(scratch, "extracted");
    mkdirSync(extractRoot, { recursive: true });
    const steps: StepEvidence[] = [];
    steps.push(
      runStep(ROOT, "npm", [
        "run",
        "--silent",
        "starter:local",
        "--",
        "build",
        "--profile",
        profileId,
        "--base-sha",
        baseSha,
        "--head-sha",
        headSha,
        "--output",
        buildRoot,
        "--version",
        packageVersion
      ])
    );
    const archive = readFileSync(path.join(buildRoot, "customer-starter.tar"));
    // Every archived entry is namespaced under a "payload/" prefix (the
    // same convention src/release.ts uses); strip it on extraction so
    // package.json/package-lock.json land at the extraction root, where
    // dependency installation and every advertised script expect them.
    steps.push(
      runStep(scratch, "tar", [
        "-xf",
        path.join(buildRoot, "customer-starter.tar"),
        "-C",
        extractRoot,
        "--strip-components=1"
      ])
    );
    steps.push(
      runStep(extractRoot, "npm", [
        "ci",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund"
      ])
    );
    // Defense-in-depth for the same authority boundary
    // src/customer-starter.ts's shipped-export surface enforces: prove
    // that once dependencies are installed in this extracted bundle, its own
    // package.json "exports" restriction is in effect, a deep import of an internal
    // module by the package's own name (the same self-reference
    // resolution Node supports for a package that declares "exports" and
    // has a "name" field) fails outright, rather than merely relying on
    // src/customer-starter.ts exporting no test-fixture-only function.
    // This does not exercise a real external consumer installing this
    // package as a dependency (this package is private and unpublished);
    // it proves the "exports" restriction this profile ships is itself
    // load-bearing inside a real, extracted, dependency-installed bundle -- not just
    // present in source and untested.
    const deepImportProbeStartedAt = Date.now();
    const deepImportProbe = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "await import('agentic-framework/dist/src/customer-starter-catalog.js')"
      ],
      { cwd: extractRoot, stdio: "pipe", shell: false, encoding: "utf8" }
    );
    const deepImportProbeDurationMs = Date.now() - deepImportProbeStartedAt;
    if (deepImportProbe.error !== undefined) {
      throw new Error(
        `clean-extraction deep-import probe failed to execute: ${deepImportProbe.error.message}`
      );
    }
    if (deepImportProbe.status === 0) {
      throw new Error(
        "clean-extraction deep-import probe unexpectedly succeeded: the extracted bundle's package.json \"exports\" restriction did not block a deep import by package name"
      );
    }
    if (deepImportProbe.status === null || deepImportProbe.signal !== null) {
      throw new Error(
        `clean-extraction deep-import probe did not exit normally: signal=${deepImportProbe.signal ?? "none"}`
      );
    }
    if (!/ERR_PACKAGE_PATH_NOT_EXPORTED/u.test(deepImportProbe.stderr)) {
      throw new Error(
        `clean-extraction deep-import probe failed for an unexpected reason (expected ERR_PACKAGE_PATH_NOT_EXPORTED): ${deepImportProbe.stderr}`
      );
    }
    steps.push({
      command: "node --input-type=module -e \"await import('agentic-framework/dist/src/customer-starter-catalog.js')\" (expected to fail with ERR_PACKAGE_PATH_NOT_EXPORTED)",
      cwd: extractRoot,
      outcome: "expected-failure",
      exitStatus: deepImportProbe.status,
      signal: deepImportProbe.signal,
      durationMs: deepImportProbeDurationMs
    });
    for (const scriptName of profile.advertisedScripts) {
      steps.push(runStep(extractRoot, "npm", ["run", scriptName]));
    }
    return {
      profileId,
      extendsProfileId: profile.extendsProfileId,
      advertisedScripts: profile.advertisedScripts,
      archiveDigest: sha256Bytes(archive),
      steps
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function main(): void {
  const baseSha = gitText(["rev-parse", "refs/remotes/origin/main"]);
  const headSha = gitText(["rev-parse", "HEAD"]);
  const source = githubRepositoryFromRemote(
    gitText(["remote", "get-url", "origin"])
  );
  const packageVersion = (
    JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { readonly version: string }
  ).version;
  const evidenceDir = path.resolve(
    process.argv[2] ?? path.join(ROOT, "dist", "customer-starter-extraction-evidence")
  );
  mkdirSync(evidenceDir, { recursive: true });

  const profiles = CUSTOMER_STARTER_PROFILE_CATALOG.profiles
    .map((entry) => entry.profileId)
    .sort()
    .map((profileId) => validateProfile(profileId, baseSha, headSha, packageVersion));

  const evidence = {
    kind: "CustomerStarterExtractionEvidence",
    generatedAt: new Date().toISOString(),
    source: { ...source, baseSha, headSha },
    packageVersion,
    profiles
  };
  const evidencePath = path.join(evidenceDir, "evidence.json");
  writeFileSync(evidencePath, `${canonicalJson(evidence)}\n`);
  process.stdout.write(`${canonicalJson(evidence)}\n`);
  process.stderr.write(`[customer-starter-extraction] evidence written to ${evidencePath}\n`);
}

// This script is never imported by another module (it reads
// CUSTOMER_STARTER_PROFILE_CATALOG directly from src/customer-starter-
// catalog.ts, never from scripts/customer-starter-local.ts), so there is
// no "am I the entry point" ambiguity to guard against; calling main()
// unconditionally avoids the entire class of bug where a fragile
// entry-point guard (e.g. comparing an encoded import.meta.url to a raw,
// unencoded process.argv[1]) silently no-ops -- and exits 0 -- when the
// checkout path contains spaces or other URL-special characters.
main();
