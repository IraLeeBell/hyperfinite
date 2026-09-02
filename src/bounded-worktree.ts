import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { digest } from "./canonical.js";
import type { Digest, WorkAccord } from "./types.js";

export const ENGINEERING_TCB_PATHS = [
  ".git*",
  "**/.git*",
  ".git/**",
  "**/.git/**",
  ".github/**",
  ".env*",
  "**/.env*",
  ".npmrc",
  "**/.npmrc",
  ".yarnrc",
  ".yarnrc.*",
  "**/.yarnrc",
  "**/.yarnrc.*",
  ".pnpmfile.cjs",
  "**/.pnpmfile.cjs",
  "pnpm-workspace.yaml",
  "**/pnpm-workspace.yaml",
  "bunfig.toml",
  "**/bunfig.toml",
  "bun.lock",
  "**/bun.lock",
  "bun.lockb",
  "**/bun.lockb",
  "deno.json",
  "**/deno.json",
  "deno.jsonc",
  "**/deno.jsonc",
  ".node-version",
  "**/.node-version",
  ".nvmrc",
  "**/.nvmrc",
  ".tool-versions",
  "**/.tool-versions",
  "volta.json",
  "**/volta.json",
  ".gitattributes",
  "**/.gitattributes",
  ".gitignore",
  "**/.gitignore",
  ".mailmap",
  "**/.mailmap",
  "CODEOWNERS",
  "docs/CODEOWNERS",
  "config/**",
  "schemas/**",
  "scripts/**",
  "src/**",
  "tests/**",
  "package.json",
  "**/package.json",
  "package-lock.json",
  "**/package-lock.json",
  "npm-shrinkwrap.json",
  "**/npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "**/pnpm-lock.yaml",
  "yarn.lock",
  "**/yarn.lock",
  "tsconfig.json",
  "**/tsconfig.json",
  "tsconfig.*.json",
  "**/tsconfig.*.json",
  "eslint.config.*",
  "**/eslint.config.*",
  ".eslintrc*",
  "**/.eslintrc*",
  "prettier.config.*",
  "**/prettier.config.*",
  ".prettierrc*",
  "**/.prettierrc*",
  "biome.json",
  "**/biome.json",
  "biome.jsonc",
  "**/biome.jsonc",
  "babel.config.*",
  "**/babel.config.*",
  ".babelrc*",
  "**/.babelrc*",
  "postcss.config.*",
  "**/postcss.config.*",
  "tailwind.config.*",
  "**/tailwind.config.*",
  "vitest.config.*",
  "**/vitest.config.*",
  "jest.config.*",
  "**/jest.config.*",
  "turbo.json",
  "**/turbo.json",
  "nx.json",
  "**/nx.json",
  "rollup.config.*",
  "**/rollup.config.*",
  "vite.config.*",
  "**/vite.config.*",
  "webpack.config.*",
  "**/webpack.config.*",
  "LICENSE"
] as const;

const DEMO_TCB_PATHS_BY_CAPABILITY = {
  "demo.app-modernization.implementation@1.0.0": new Set([
    "src/modernized/application.ts",
    "tests/modernized/application.test.ts"
  ]),
  "demo.security-dependency-remediation.patch-implementation@1.0.0": new Set([
    "vendor/mist-lru/package.json",
    "vendor/mist-lru/package-lock.json",
    "src/cache-key.ts",
    "tests/cache-key.test.ts"
  ])
} as const;

export class BoundedExecutionError extends Error {
  constructor(
    readonly code:
      | "GRANT_INVALID"
      | "TARGET_DENIED"
      | "SANDBOX_INVALID"
      | "PATCH_INVALID"
      | "VERIFICATION_FAILED",
    message: string
  ) {
    super(message);
    this.name = "BoundedExecutionError";
  }
}

export interface ExactExecutionTarget {
  readonly slot: string;
  readonly path: string;
  readonly operation: "create" | "modify";
  readonly expectedDigest: Digest | null;
  readonly expectedMode: "100644";
  readonly maxBytes: number;
}

export interface BoundedExecutionGrant {
  readonly repositoryId: number;
  readonly workItemNodeId: string;
  readonly workAccordDigest: Digest;
  readonly activationLeaseDigest: Digest;
  readonly snapshotDigest: Digest;
  readonly routeId: string;
  readonly baseSha: string;
  readonly targets: readonly ExactExecutionTarget[];
  readonly verificationCommandIds: readonly string[];
  readonly maxFiles: number;
  readonly maxPatchBytes: number;
  readonly maxTurns: number;
  readonly maxCostUnits: number;
  readonly expiresAt: string;
}

export interface TargetFreePatch {
  readonly schemaVersion: "1.0.0";
  readonly summary: string;
  readonly changes: readonly {
    readonly slot: string;
    readonly content: string;
  }[];
}

export interface VerificationCommand {
  readonly id: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export const ENGINEERING_VERIFICATION_COMMANDS = {
  typecheck: {
    id: "typecheck",
    executable: "npm",
    args: ["run", "typecheck"],
    timeoutMs: 120_000,
    maxOutputBytes: 65_536
  },
  build: {
    id: "build",
    executable: "npm",
    args: ["run", "build"],
    timeoutMs: 120_000,
    maxOutputBytes: 65_536
  },
  "unit-tests": {
    id: "unit-tests",
    executable: "npm",
    args: ["test"],
    timeoutMs: 600_000,
    maxOutputBytes: 65_536
  },
  security: {
    id: "security",
    executable: "npm",
    args: ["run", "validate:runtime"],
    timeoutMs: 600_000,
    maxOutputBytes: 65_536
  },
  compatibility: {
    id: "compatibility",
    executable: "npm",
    args: ["run", "validate:packaging"],
    timeoutMs: 600_000,
    maxOutputBytes: 65_536
  },
  "migration-dry-run": {
    id: "migration-dry-run",
    executable: "npm",
    args: ["run", "validate:schemas"],
    timeoutMs: 600_000,
    maxOutputBytes: 65_536
  },
  "fd-acceptance-tests": {
    id: "fd-acceptance-tests",
    executable: "node",
    args: [
      "--test",
      "examples/demos/feature-delivery/sandbox/tests/export.test.ts"
    ],
    timeoutMs: 120_000,
    maxOutputBytes: 65_536
  },
  "fd-regression-tests": {
    id: "fd-regression-tests",
    executable: "npm",
    args: ["test"],
    timeoutMs: 120_000,
    maxOutputBytes: 65_536
  },
  "fd-typecheck": {
    id: "fd-typecheck",
    executable: "npm",
    args: ["run", "typecheck"],
    timeoutMs: 120_000,
    maxOutputBytes: 65_536
  },
  "adaptive-acceptance-tests": {
    id: "adaptive-acceptance-tests",
    executable: "node",
    args: [
      "--test",
      "examples/demos/adaptive-delivery/sandbox/tests/change.test.ts"
    ],
    timeoutMs: 120_000,
    maxOutputBytes: 65_536
  },
  "adaptive-regression-tests": {
    id: "adaptive-regression-tests",
    executable: "npm",
    args: ["test"],
    timeoutMs: 120_000,
    maxOutputBytes: 65_536
  },
  "adaptive-typecheck": {
    id: "adaptive-typecheck",
    executable: "npm",
    args: ["run", "typecheck"],
    timeoutMs: 120_000,
    maxOutputBytes: 65_536
  },
  "hermetic-reproduction": {
    id: "hermetic-reproduction",
    executable: "trusted-evidence",
    args: ["hermetic-reproduction"],
    timeoutMs: 30_000,
    maxOutputBytes: 65_536
  },
  "fixed-regression": {
    id: "fixed-regression",
    executable: "trusted-evidence",
    args: ["fixed-regression"],
    timeoutMs: 30_000,
    maxOutputBytes: 65_536
  },
  "dependency-lock-consistency": {
    id: "dependency-lock-consistency",
    executable: "trusted-evidence",
    args: ["dependency-lock-consistency"],
    timeoutMs: 30_000,
    maxOutputBytes: 65_536
  },
  "threat-detection": {
    id: "threat-detection",
    executable: "trusted-evidence",
    args: ["threat-detection"],
    timeoutMs: 30_000,
    maxOutputBytes: 65_536
  },
  "dlp-scan": {
    id: "dlp-scan",
    executable: "trusted-evidence",
    args: ["dlp-scan"],
    timeoutMs: 30_000,
    maxOutputBytes: 65_536
  },
  "synthetic-security-scan": {
    id: "synthetic-security-scan",
    executable: "trusted-evidence",
    args: ["synthetic-security-scan"],
    timeoutMs: 30_000,
    maxOutputBytes: 65_536
  },
  "git-diff-check": {
    id: "git-diff-check",
    executable: "git",
    args: ["diff", "--cached", "--check"],
    timeoutMs: 30_000,
    maxOutputBytes: 65_536
  }
} as const satisfies Readonly<Record<string, VerificationCommand>>;

export interface VerificationResult {
  readonly commandId: string;
  readonly stdoutDigest: Digest;
  readonly stderrDigest: Digest;
}

export interface ValidatedPatch {
  readonly baseSha: string;
  readonly patch: string;
  readonly patchDigest: Digest;
  readonly treeDigest: Digest;
  readonly gitTreeSha: string;
  readonly files: readonly {
    readonly slot: string;
    readonly path: string;
    readonly operation: "create" | "modify";
    readonly beforeDigest: Digest | null;
    readonly afterDigest: Digest;
    readonly bytes: number;
    readonly mode: "100644";
  }[];
  readonly verification: readonly VerificationResult[];
}

export interface CommandRunResult {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly errorCode: string | null;
  readonly environmentKeys: readonly string[];
}

export interface CommandRunner {
  readonly isolation: "trusted-git-only" | "hermetic-unprivileged";
  run(input: {
    readonly executable: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
    readonly env: Readonly<Record<string, string>>;
  }): CommandRunResult;
}

export interface ExecutionClock {
  now(): string;
}

const defaultRunner: CommandRunner = {
  isolation: "trusted-git-only",
  run(input) {
    const result = spawnSync(input.executable, input.args, {
      cwd: input.cwd,
      encoding: "utf8",
      env: input.env,
      maxBuffer: input.maxOutputBytes,
      shell: false,
      timeout: input.timeoutMs
    });
    return {
      status: result.status,
      signal: result.signal,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      errorCode:
        result.error === undefined
          ? null
          : "code" in result.error && typeof result.error.code === "string"
            ? result.error.code
            : "UNKNOWN"
      ,
      environmentKeys: Object.keys(input.env).sort()
    };
  }
};

function fail(
  code: BoundedExecutionError["code"],
  message: string
): never {
  throw new BoundedExecutionError(code, message);
}

function requirePositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail("GRANT_INVALID", `${name} must be a positive safe integer`);
  }
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[]
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

export function assertBoundedExecutionGrant(
  value: unknown
): BoundedExecutionGrant {
  const grant = record(value);
  const keys = [
    "repositoryId",
    "workItemNodeId",
    "workAccordDigest",
    "activationLeaseDigest",
    "snapshotDigest",
    "routeId",
    "baseSha",
    "targets",
    "verificationCommandIds",
    "maxFiles",
    "maxPatchBytes",
    "maxTurns",
    "maxCostUnits",
    "expiresAt"
  ] as const;
  if (
    grant === null ||
    !hasExactKeys(grant, keys) ||
    !Number.isSafeInteger(grant.repositoryId) ||
    typeof grant.workItemNodeId !== "string" ||
    typeof grant.workAccordDigest !== "string" ||
    typeof grant.activationLeaseDigest !== "string" ||
    typeof grant.snapshotDigest !== "string" ||
    typeof grant.routeId !== "string" ||
    typeof grant.baseSha !== "string" ||
    !Array.isArray(grant.targets) ||
    !Array.isArray(grant.verificationCommandIds) ||
    !Number.isSafeInteger(grant.maxFiles) ||
    !Number.isSafeInteger(grant.maxPatchBytes) ||
    !Number.isSafeInteger(grant.maxTurns) ||
    !Number.isSafeInteger(grant.maxCostUnits) ||
    typeof grant.expiresAt !== "string"
  ) {
    fail("GRANT_INVALID", "execution grant does not match the closed contract");
  }
  for (const valueTarget of grant.targets) {
    const target = record(valueTarget);
    if (
      target === null ||
      !hasExactKeys(target, [
        "slot",
        "path",
        "operation",
        "expectedDigest",
        "expectedMode",
        "maxBytes"
      ]) ||
      typeof target.slot !== "string" ||
      typeof target.path !== "string" ||
      (target.operation !== "create" && target.operation !== "modify") ||
      (target.expectedDigest !== null &&
        typeof target.expectedDigest !== "string") ||
      target.expectedMode !== "100644" ||
      !Number.isSafeInteger(target.maxBytes)
    ) {
      fail("GRANT_INVALID", "execution target does not match the closed contract");
    }
  }
  if (
    grant.verificationCommandIds.some(
      (commandId) => typeof commandId !== "string"
    )
  ) {
    fail("GRANT_INVALID", "verification command IDs must be strings");
  }
  return grant as unknown as BoundedExecutionGrant;
}

function canonicalRepositoryPath(value: string): string {
  if (
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.includes("\n") ||
    /[:*?\[\]!]/u.test(value) ||
    path.posix.isAbsolute(value)
  ) {
    fail("TARGET_DENIED", "execution target must be a canonical relative POSIX path");
  }
  const normalized = path.posix.normalize(value);
  if (
    normalized !== value ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    fail("TARGET_DENIED", `execution target ${value} is not canonical`);
  }
  return normalized;
}

function globMatches(scope: string, target: string): boolean {
  const escaped = scope.replace(/[.?+^${}()|[\]\\]/gu, "\\$&");
  const expression = escaped
    .replaceAll("**", "\0")
    .replaceAll("*", "[^/]*")
    .replaceAll("\0", ".*");
  return new RegExp(`^${expression}$`, "u").test(target);
}

export function isEngineeringTcbPath(target: string): boolean {
  const canonical = canonicalRepositoryPath(target);
  return ENGINEERING_TCB_PATHS.some((scope) =>
    globMatches(scope.toLowerCase(), canonical.toLowerCase())
  );
}

function assertNoSymlinkComponents(
  root: string,
  target: string,
  allowMissingParents = false
): void {
  const segments = target.split("/");
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === undefined) continue;
    current = path.join(current, segment);
    try {
      const status = lstatSync(current);
      if (status.isSymbolicLink()) {
        fail("TARGET_DENIED", `execution target traverses symlink ${target}`);
      }
      if (index < segments.length - 1 && !status.isDirectory()) {
        fail("TARGET_DENIED", `execution target parent is not a directory: ${target}`);
      }
      if (index === segments.length - 1 && !status.isFile()) {
        fail("TARGET_DENIED", `execution target is not a regular file: ${target}`);
      }
    } catch (error) {
      const code =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string"
          ? error.code
          : null;
      if (
        code !== "ENOENT" ||
        (!allowMissingParents && index < segments.length - 1)
      ) {
        throw error;
      }
      if (allowMissingParents) return;
    }
  }
}

function runChecked(
  runner: CommandRunner,
  input: {
    readonly executable: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
    readonly code?: BoundedExecutionError["code"];
    readonly extraEnv?: Readonly<Record<string, string>>;
  }
): CommandRunResult {
  const env = {
    CI: "true",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_COUNT: "8",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/dev/null",
    GIT_CONFIG_KEY_1: "core.fsmonitor",
    GIT_CONFIG_VALUE_1: "false",
    GIT_CONFIG_KEY_2: "credential.helper",
    GIT_CONFIG_VALUE_2: "",
    GIT_CONFIG_KEY_3: "core.askPass",
    GIT_CONFIG_VALUE_3: "",
    GIT_CONFIG_KEY_4: "diff.external",
    GIT_CONFIG_VALUE_4: "",
    GIT_CONFIG_KEY_5: "core.autocrlf",
    GIT_CONFIG_VALUE_5: "false",
    GIT_CONFIG_KEY_6: "init.templateDir",
    GIT_CONFIG_VALUE_6: "",
    GIT_CONFIG_KEY_7: "protocol.file.allow",
    GIT_CONFIG_VALUE_7: "never",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
    HOME: input.cwd,
    LANG: "C",
    PATH: "/usr/bin:/bin",
    ...input.extraEnv
  } as const;
  const result = runner.run({
    executable: input.executable,
    args: input.args,
    cwd: input.cwd,
    timeoutMs: input.timeoutMs ?? 30_000,
    maxOutputBytes: input.maxOutputBytes ?? 1_048_576,
    env
  });
  if (
    result.errorCode !== null ||
    result.signal !== null ||
    result.status !== 0
  ) {
    fail(
      input.code ?? "SANDBOX_INVALID",
      `${input.executable} failed with status ${String(result.status)}, signal ${String(result.signal)}, error ${String(result.errorCode)}`
    );
  }
  return result;
}

function validateTargetSet(
  accord: WorkAccord,
  grant: BoundedExecutionGrant
): ReadonlyMap<string, ExactExecutionTarget> {
  if (
    grant.repositoryId !== accord.binding.repositoryId ||
    grant.workItemNodeId !== accord.binding.workItemNodeId ||
    grant.workAccordDigest !== digest(accord) ||
    !/^[0-9a-f]{40}$/u.test(grant.baseSha)
  ) {
    fail("GRANT_INVALID", "execution grant does not bind the exact Work Accord target");
  }
  requirePositiveSafeInteger(grant.maxFiles, "maxFiles");
  requirePositiveSafeInteger(grant.maxPatchBytes, "maxPatchBytes");
  requirePositiveSafeInteger(grant.maxTurns, "maxTurns");
  requirePositiveSafeInteger(grant.maxCostUnits, "maxCostUnits");
  if (
    grant.maxPatchBytes > accord.budget.maxPatchBytes ||
    grant.maxTurns > accord.budget.maxLoops ||
    grant.maxCostUnits > accord.budget.maxCostUnits ||
    grant.targets.length === 0 ||
    grant.targets.length > grant.maxFiles
  ) {
    fail("GRANT_INVALID", "execution grant exceeds the Work Accord budget");
  }
  const bySlot = new Map<string, ExactExecutionTarget>();
  const paths = new Set<string>();
  const foldedPaths = new Set<string>();
  const demoTcbCapabilities = accord.policy.requestedCapabilities.filter(
    (capability) =>
      DEMO_TCB_PATHS_BY_CAPABILITY[
        capability as keyof typeof DEMO_TCB_PATHS_BY_CAPABILITY
      ] !== undefined
  );
  const authorizedDemoTcbPaths =
    demoTcbCapabilities.length === 1
      ? DEMO_TCB_PATHS_BY_CAPABILITY[
          demoTcbCapabilities[0] as keyof typeof DEMO_TCB_PATHS_BY_CAPABILITY
        ]
      : new Set<string>();
  for (const target of grant.targets) {
    const canonical = canonicalRepositoryPath(target.path);
    if (
      !/^[a-z][a-z0-9-]{0,62}$/u.test(target.slot) ||
      target.path !== canonical ||
      bySlot.has(target.slot) ||
      paths.has(canonical) ||
      foldedPaths.has(canonical.toLowerCase()) ||
      (isEngineeringTcbPath(canonical) &&
        !authorizedDemoTcbPaths.has(canonical)) ||
      !accord.policy.allowedPaths.some((scope) => globMatches(scope, canonical))
    ) {
      fail("TARGET_DENIED", `execution target ${target.slot}:${target.path} is not authorized`);
    }
    requirePositiveSafeInteger(target.maxBytes, `${target.slot}.maxBytes`);
    if (
      (target.operation === "create" && target.expectedDigest !== null) ||
      (target.operation === "modify" && target.expectedDigest === null)
    ) {
      fail("GRANT_INVALID", `execution target ${target.slot} has inconsistent preconditions`);
    }
    bySlot.set(target.slot, target);
    paths.add(canonical);
    foldedPaths.add(canonical.toLowerCase());
  }
  return bySlot;
}

export function validateBoundedExecutionGrant(input: {
  readonly accord: WorkAccord;
  readonly grant: BoundedExecutionGrant;
  readonly clock: ExecutionClock;
  readonly expectedBaseSha?: string;
}): void {
  const now = Date.parse(input.clock.now());
  const expiresAt = Date.parse(input.grant.expiresAt);
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(expiresAt) ||
    now >= expiresAt ||
    (input.expectedBaseSha !== undefined &&
      input.grant.baseSha !== input.expectedBaseSha)
  ) {
    fail("GRANT_INVALID", "execution grant is expired or does not bind the current base");
  }
  validateTargetSet(input.accord, input.grant);
  const allowedCommands = input.grant.verificationCommandIds;
  const requiredCommands = input.accord.evidence.verificationCommands;
  if (
    allowedCommands.length === 0 ||
    requiredCommands.length === 0 ||
    new Set(allowedCommands).size !== allowedCommands.length ||
    new Set(requiredCommands).size !== requiredCommands.length ||
    allowedCommands.some(
      (commandId) => ENGINEERING_VERIFICATION_COMMANDS[commandId as keyof typeof ENGINEERING_VERIFICATION_COMMANDS] === undefined
    ) ||
    requiredCommands.some(
      (commandId) =>
        !allowedCommands.includes(commandId) ||
        ENGINEERING_VERIFICATION_COMMANDS[commandId as keyof typeof ENGINEERING_VERIFICATION_COMMANDS] === undefined
    )
  ) {
    fail(
      "GRANT_INVALID",
      "execution grant must include every mandatory fixed verification command exactly once"
    );
  }
}

function validateTargetFreePatch(
  patch: TargetFreePatch,
  targets: ReadonlyMap<string, ExactExecutionTarget>
): void {
  if (
    patch.schemaVersion !== "1.0.0" ||
    patch.summary.length === 0 ||
    patch.changes.length === 0 ||
    patch.changes.length > targets.size
  ) {
    fail("PATCH_INVALID", "target-free patch shape or change count is invalid");
  }
  const slots = new Set<string>();
  for (const change of patch.changes) {
    if (
      Object.keys(change).sort().join(",") !== "content,slot" ||
      !targets.has(change.slot) ||
      slots.has(change.slot) ||
      change.content.includes("\0")
    ) {
      fail("PATCH_INVALID", `target-free patch change ${change.slot} is invalid`);
    }
    slots.add(change.slot);
  }
}

function validateWorkingTree(
  runner: CommandRunner,
  worktree: string,
  targets: ReadonlyMap<string, ExactExecutionTarget>,
  maxFiles: number,
  gitEnv: Readonly<Record<string, string>>
): readonly string[] {
  const status = runChecked(runner, {
    executable: "git",
    args: ["status", "--short", "--untracked-files=all"],
    cwd: worktree,
    code: "PATCH_INVALID",
    extraEnv: gitEnv
  }).stdout;
  const changed = status
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const code = line.slice(0, 2);
      const file = line.slice(3);
      if (
        file.includes(" -> ") ||
        code.includes("R") ||
        code.includes("C") ||
        code.includes("D") ||
        ![...targets.values()].some((target) => target.path === file)
      ) {
        fail("PATCH_INVALID", `unexpected working-tree change ${code} ${file}`);
      }
      return file;
    });
  if (changed.length === 0 || changed.length > maxFiles || new Set(changed).size !== changed.length) {
    fail("PATCH_INVALID", "working-tree change count is invalid");
  }
  return changed.sort();
}

function executeVerificationCommands(
  runner: CommandRunner,
  worktree: string,
  commandIds: readonly string[],
  registry: Readonly<Record<string, VerificationCommand>>,
  gitEnv: Readonly<Record<string, string>>
): readonly VerificationResult[] {
  const results: VerificationResult[] = [];
  for (const commandId of commandIds) {
    const command = registry[commandId];
    if (
      command === undefined ||
      command.id !== commandId ||
      command.args.some((argument) => argument.includes("\0")) ||
      command.executable.length === 0
    ) {
      fail("VERIFICATION_FAILED", `unknown or invalid verification command ${commandId}`);
    }
    if (
      command.executable !== "git" &&
      runner.isolation !== "hermetic-unprivileged"
    ) {
      fail(
        "VERIFICATION_FAILED",
        `verification command ${commandId} requires a separately isolated credentialless runner`
      );
    }
    requirePositiveSafeInteger(command.timeoutMs, `${commandId}.timeoutMs`);
    requirePositiveSafeInteger(command.maxOutputBytes, `${commandId}.maxOutputBytes`);
    const result = runChecked(runner, {
      executable: command.executable,
      args: command.args,
      cwd: worktree,
      timeoutMs: command.timeoutMs,
      maxOutputBytes: command.maxOutputBytes,
      code: "VERIFICATION_FAILED",
      ...(command.executable === "git" ? { extraEnv: gitEnv } : {})
    });
    results.push({
      commandId,
      stdoutDigest: digest(result.stdout),
      stderrDigest: digest(result.stderr)
    });
  }
  return results;
}

export function executeBoundedWorktree(input: {
  readonly repositoryPath: string;
  readonly accord: WorkAccord;
  readonly grant: BoundedExecutionGrant;
  readonly patch: TargetFreePatch;
  readonly clock: ExecutionClock;
  readonly runner?: CommandRunner;
}): ValidatedPatch {
  const runner = input.runner ?? defaultRunner;
  validateBoundedExecutionGrant({
    accord: input.accord,
    grant: input.grant,
    clock: input.clock
  });
  const targets = validateTargetSet(input.accord, input.grant);
  validateTargetFreePatch(input.patch, targets);
  const repository = realpathSync(input.repositoryPath);
  const sandboxRoot = mkdtempSync(path.join(tmpdir(), "hyperfinite-execution-"));
  const worktree = path.join(sandboxRoot, "worktree");
  try {
    const resolvedBase = runChecked(runner, {
      executable: "git",
      args: ["rev-parse", "--verify", `${input.grant.baseSha}^{commit}`],
      cwd: repository
    }).stdout.trim();
    if (resolvedBase !== input.grant.baseSha) {
      fail("SANDBOX_INVALID", "repository base does not match the execution grant");
    }
    const commonGitDir = realpathSync(
      runChecked(runner, {
        executable: "git",
        args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        cwd: repository
      }).stdout.trim()
    );
    const sourceObjects = realpathSync(path.join(commonGitDir, "objects"));
    mkdirSync(worktree, { recursive: true, mode: 0o700 });
    runChecked(runner, {
      executable: "git",
      args: ["init", "--quiet", "--initial-branch=sandbox"],
      cwd: worktree
    });
    const sandboxGitEnv = {
      GIT_ALTERNATE_OBJECT_DIRECTORIES: sourceObjects
    } as const;
    runChecked(runner, {
      executable: "git",
      args: ["update-ref", "refs/heads/sandbox", input.grant.baseSha],
      cwd: worktree,
      extraEnv: sandboxGitEnv
    });
    runChecked(runner, {
      executable: "git",
      args: ["reset", "--hard", "--quiet", input.grant.baseSha],
      cwd: worktree,
      extraEnv: sandboxGitEnv
    });
    const worktreeRoot = realpathSync(worktree);
    const files: ValidatedPatch["files"][number][] = [];
    for (const change of input.patch.changes) {
      const target = targets.get(change.slot);
      if (target === undefined) {
        fail("PATCH_INVALID", `unbound target slot ${change.slot}`);
      }
      const absolute = path.resolve(worktreeRoot, target.path);
      if (!absolute.startsWith(`${worktreeRoot}${path.sep}`)) {
        fail("TARGET_DENIED", `execution target escapes sandbox: ${target.path}`);
      }
      assertNoSymlinkComponents(
        worktreeRoot,
        target.path,
        target.operation === "create"
      );
      if (target.operation === "create") {
        mkdirSync(path.dirname(absolute), {
          recursive: true,
          mode: 0o700
        });
        assertNoSymlinkComponents(worktreeRoot, target.path, true);
      }
      let beforeDigest: Digest | null = null;
      let exists = true;
      try {
        const before = readFileSync(absolute);
        beforeDigest = digest(before.toString("base64"));
      } catch (error) {
        const code =
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof error.code === "string"
            ? error.code
            : null;
        if (code !== "ENOENT") throw error;
        exists = false;
      }
      if (
        (target.operation === "create" && exists) ||
        (target.operation === "modify" &&
          (!exists || beforeDigest !== target.expectedDigest))
      ) {
        fail("TARGET_DENIED", `execution precondition failed for ${target.path}`);
      }
      const bytes = Buffer.byteLength(change.content);
      if (bytes > target.maxBytes) {
        fail("PATCH_INVALID", `execution target ${target.path} exceeds its byte limit`);
      }
      writeFileSync(absolute, change.content, { encoding: "utf8", mode: 0o644 });
      assertNoSymlinkComponents(worktreeRoot, target.path);
      runChecked(runner, {
        executable: "git",
        args: ["add", "--", target.path],
        cwd: worktree,
        code: "PATCH_INVALID",
        extraEnv: sandboxGitEnv
      });
      const stage = runChecked(runner, {
        executable: "git",
        args: ["ls-files", "--stage", "--", target.path],
        cwd: worktree,
        code: "PATCH_INVALID",
        extraEnv: sandboxGitEnv
      }).stdout.trim();
      if (!stage.startsWith(`${target.expectedMode} `)) {
        fail("PATCH_INVALID", `execution target ${target.path} changed mode or type`);
      }
      files.push({
        slot: target.slot,
        path: target.path,
        operation: target.operation,
        beforeDigest,
        afterDigest: digest(Buffer.from(change.content, "utf8").toString("base64")),
        bytes,
        mode: target.expectedMode
      });
    }
    const changed = validateWorkingTree(
      runner,
      worktree,
      targets,
      input.grant.maxFiles,
      sandboxGitEnv
    );
    if (
      changed.length !== files.length ||
      files.some((file) => !changed.includes(file.path))
    ) {
      fail("PATCH_INVALID", "validated files differ from the target-free patch");
    }
    const authorizedPaths = new Set(files.map((file) => file.path));
    const staged = runChecked(runner, {
      executable: "git",
      args: ["diff", "--cached", "--name-only", "--"],
      cwd: worktree,
      code: "PATCH_INVALID",
      extraEnv: sandboxGitEnv
    }).stdout
      .split("\n")
      .filter((entry) => entry.length > 0);
    const indexed = runChecked(runner, {
      executable: "git",
      args: ["ls-files", "--stage", "--", ...files.map((file) => file.path)],
      cwd: worktree,
      code: "PATCH_INVALID",
      extraEnv: sandboxGitEnv
    }).stdout
      .split("\n")
      .filter((entry) => entry.length > 0)
      .map((entry) => entry.slice(entry.indexOf("\t") + 1));
    if (
      staged.length !== authorizedPaths.size ||
      indexed.length !== authorizedPaths.size ||
      staged.some((entry) => !authorizedPaths.has(entry)) ||
      indexed.some((entry) => !authorizedPaths.has(entry)) ||
      [...authorizedPaths].some(
        (target) => !staged.includes(target) || !indexed.includes(target)
      )
    ) {
      fail("PATCH_INVALID", "staged and indexed files differ from authorized targets");
    }
    const summary = runChecked(runner, {
      executable: "git",
      args: ["diff", "--cached", "--summary", "--no-renames"],
      cwd: worktree,
      code: "PATCH_INVALID",
      extraEnv: sandboxGitEnv
    }).stdout;
    if (
      /mode change|rename |copy |delete mode|create mode 160000/u.test(summary)
    ) {
      fail("PATCH_INVALID", "patch contains a mode, rename, copy, delete, or submodule change");
    }
    const numstat = runChecked(runner, {
      executable: "git",
      args: ["diff", "--cached", "--numstat", "--no-renames"],
      cwd: worktree,
      code: "PATCH_INVALID",
      extraEnv: sandboxGitEnv
    }).stdout;
    if (numstat.split("\n").some((line) => line.startsWith("-\t-\t"))) {
      fail("PATCH_INVALID", "binary patches are not authorized");
    }
    runChecked(runner, {
      executable: "git",
      args: ["diff", "--cached", "--check"],
      cwd: worktree,
      code: "PATCH_INVALID",
      extraEnv: sandboxGitEnv
    });
    const patch = runChecked(runner, {
      executable: "git",
      args: [
        "diff",
        "--cached",
        "--binary",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames"
      ],
      cwd: worktree,
      maxOutputBytes: input.grant.maxPatchBytes + 1,
      code: "PATCH_INVALID",
      extraEnv: sandboxGitEnv
    }).stdout;
    if (patch.length === 0) {
      fail("PATCH_INVALID", "generated patch is empty");
    }
    if (Buffer.byteLength(patch) > input.grant.maxPatchBytes) {
      fail("PATCH_INVALID", "generated patch exceeds the grant byte limit");
    }
    const verification = executeVerificationCommands(
      runner,
      worktree,
      input.grant.verificationCommandIds,
      ENGINEERING_VERIFICATION_COMMANDS,
      sandboxGitEnv
    );
    const gitTreeSha = runChecked(runner, {
      executable: "git",
      args: ["write-tree"],
      cwd: worktree,
      code: "PATCH_INVALID",
      extraEnv: sandboxGitEnv
    }).stdout.trim();
    if (!/^[0-9a-f]{40}$/u.test(gitTreeSha)) {
      fail("PATCH_INVALID", "staged patch did not produce a canonical Git tree");
    }
    return {
      baseSha: input.grant.baseSha,
      patch,
      patchDigest: digest(patch),
      treeDigest: digest(
        files
          .map((file) => ({
            path: file.path,
            digest: file.afterDigest,
            mode: file.mode
          }))
          .sort((left, right) => left.path.localeCompare(right.path))
      ),
      gitTreeSha,
      files: files.sort((left, right) => left.path.localeCompare(right.path)),
      verification
    };
  } finally {
    rmSync(sandboxRoot, { recursive: true, force: true });
  }
}
