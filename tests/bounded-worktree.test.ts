import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  digest,
  executeBoundedWorktree,
  isEngineeringTcbPath,
  validateBoundedExecutionGrant,
  type BoundedExecutionGrant,
  type CommandRunResult,
  type CommandRunner,
  type TargetFreePatch,
  type WorkAccord
} from "../src/index.js";

const NOW = "2026-08-26T12:00:00.000Z";
const EXPIRES = "2026-08-26T13:00:00.000Z";
const clock = { now: () => NOW };

interface RepositoryFixture {
  readonly root: string;
  readonly sha: string;
  cleanup(): void;
}

function repositoryFixture(): RepositoryFixture {
  const root = mkdtempSync(path.join(tmpdir(), "bounded-worktree-test-"));
  mkdirSync(path.join(root, "examples/engineering/workspace"), { recursive: true });
  writeFileSync(
    path.join(root, "examples/engineering/workspace/existing.txt"),
    "before\n"
  );
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Hermetic Test"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: root });
  const sha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8"
  }).trim();
  return {
    root,
    sha,
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

function accord(): WorkAccord {
  return {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "WorkAccord",
    identity: {
      id: "bounded-test-r1",
      revision: 1,
      supersedes: null,
      createdAt: NOW,
      createdBy: "maintainer"
    },
    binding: {
      repositoryId: 1,
      repositoryNodeId: "R_bounded",
      repositoryFullName: "example-organization/hyperfinite",
      repositoryRootId: digest({ root: "bounded" }),
      workItemNodeId: "I_bounded",
      defaultRef: "refs/heads/main",
      proposalRef: "refs/heads/agentic-domain/bounded-test",
      sourceDigest: digest({ source: 1 }),
      policyDigest: digest({ policy: 1 }),
      lifecycleGraphDigest: digest({ lifecycle: 1 }),
      currentHead: null
    },
    objective: {
      outcome: "Test bounded execution.",
      inScope: ["examples/engineering/workspace/**"],
      outOfScope: [],
      assumptions: [],
      dependencies: []
    },
    policy: {
      domainPack: "engineering@1.0.0",
      domainPackDigest: digest({ domain: 1 }),
      capabilityRegistryDigest: digest({ registry: 1 }),
      depthProfile: "D2",
      riskClass: "moderate",
      privacyClass: "internal",
      phaseContracts: {},
      requestedCapabilities: ["core.execute-bounded-change@1.0.0"],
      allowedPaths: ["examples/engineering/workspace/**"],
      prohibitedEffects: ["approve", "merge"],
      tools: [],
      shellCommands: [],
      network: [],
      mcpTools: [],
      secretAccess: false
    },
    budget: {
      maxCalls: 2,
      maxTokens: 1000,
      maxCostUnits: 10,
      maxDurationMs: 60_000,
      maxRetries: 1,
      maxLoops: 2,
      maxParallel: 1,
      maxPatchBytes: 4096,
      expiresAt: EXPIRES
    },
    deliverables: ["patch"],
    evidence: {
      required: ["tests-pass"],
      verificationCommands: ["git-diff-check"],
      approverPolicy: "maintainer"
    },
    humanGates: ["activate", "accept-frame", "accept-plan"],
    retention: { receiptDays: 30, artifactDays: 30, cancelOnExpiry: false }
  };
}

function grant(
  workAccord: WorkAccord,
  sha: string,
  override: Partial<BoundedExecutionGrant> = {}
): BoundedExecutionGrant {
  return {
    repositoryId: 1,
    workItemNodeId: "I_bounded",
    workAccordDigest: digest(workAccord),
    activationLeaseDigest: digest({ lease: 1 }),
    snapshotDigest: digest({ snapshot: 1 }),
    routeId: "planning.execute",
    baseSha: sha,
    targets: [
      {
        slot: "output",
        path: "examples/engineering/workspace/output.txt",
        operation: "create",
        expectedDigest: null,
        expectedMode: "100644",
        maxBytes: 128
      }
    ],
    verificationCommandIds: ["git-diff-check"],
    maxFiles: 1,
    maxPatchBytes: 4096,
    maxTurns: 2,
    maxCostUnits: 10,
    expiresAt: EXPIRES,
    ...override
  };
}

const patch: TargetFreePatch = {
  schemaVersion: "1.0.0",
  summary: "Create the bounded output.",
  changes: [{ slot: "output", content: "delivered\n" }]
};

class InstrumentedRunner implements CommandRunner {
  readonly isolation = "hermetic-unprivileged" as const;
  readonly calls: {
    executable: string;
    args: readonly string[];
    environmentKeys: readonly string[];
  }[] = [];
  diffChecks = 0;

  constructor(
    private readonly behavior:
      | "pass"
      | "timeout"
      | "nonzero"
      | "overflow"
      | "unexpected"
      | "extra-staged"
      | "mode"
      | "rename"
      | "submodule"
      | "binary"
      | "empty" = "pass"
  ) {}

  run(input: Parameters<CommandRunner["run"]>[0]): CommandRunResult {
    this.calls.push({
      executable: input.executable,
      args: input.args,
      environmentKeys: Object.keys(input.env).sort()
    });
    if (input.args.join(" ") === "diff --cached --check") {
      this.diffChecks += 1;
      if (this.diffChecks === 2) {
        if (this.behavior === "timeout") {
          return {
            status: null,
            signal: "SIGTERM",
            stdout: "",
            stderr: "",
            errorCode: "ETIMEDOUT",
            environmentKeys: Object.keys(input.env).sort()
          };
        }
        if (this.behavior === "nonzero") {
          return {
            status: 2,
            signal: null,
            stdout: "",
            stderr: "failed",
            errorCode: null,
            environmentKeys: Object.keys(input.env).sort()
          };
        }
        if (this.behavior === "overflow") {
          return {
            status: null,
            signal: null,
            stdout: "",
            stderr: "",
            errorCode: "ENOBUFS",
            environmentKeys: Object.keys(input.env).sort()
          };
        }
      }
    }
    if (
      this.behavior === "extra-staged" &&
      input.args.join(" ") === "diff --cached --name-only --"
    ) {
      return {
        status: 0,
        signal: null,
        stdout:
          "examples/engineering/workspace/output.txt\nexamples/engineering/workspace/evil.txt\n",
        stderr: "",
        errorCode: null,
        environmentKeys: Object.keys(input.env).sort()
      };
    }
    if (
      this.behavior === "unexpected" &&
      input.args.join(" ") === "status --short --untracked-files=all"
    ) {
      return {
        status: 0,
        signal: null,
        stdout: "?? examples/engineering/workspace/evil.txt\n",
        stderr: "",
        errorCode: null,
        environmentKeys: Object.keys(input.env).sort()
      };
    }
    if (
      ["mode", "rename", "submodule"].includes(this.behavior) &&
      input.args.join(" ") === "diff --cached --summary --no-renames"
    ) {
      return {
        status: 0,
        signal: null,
        stdout:
          this.behavior === "rename"
            ? " delete mode 100644 examples/engineering/workspace/output.txt\n create mode 100644 examples/engineering/workspace/renamed.txt\n"
            : this.behavior === "submodule"
              ? " create mode 160000 examples/engineering/workspace/module\n"
              : " mode change 100644 => 100755 examples/engineering/workspace/output.txt\n",
        stderr: "",
        errorCode: null,
        environmentKeys: Object.keys(input.env).sort()
      };
    }
    if (
      this.behavior === "binary" &&
      input.args.join(" ") === "diff --cached --numstat --no-renames"
    ) {
      return {
        status: 0,
        signal: null,
        stdout: "-\t-\texamples/engineering/workspace/output.txt\n",
        stderr: "",
        errorCode: null,
        environmentKeys: Object.keys(input.env).sort()
      };
    }
    if (
      this.behavior === "empty" &&
      input.args.join(" ") ===
        "diff --cached --binary --no-ext-diff --no-textconv --no-renames"
    ) {
      return {
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
        errorCode: null,
        environmentKeys: Object.keys(input.env).sort()
      };
    }
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
            : "UNKNOWN",
      environmentKeys: Object.keys(input.env).sort()
    };
  }
}

test("bounded worktree maps an approved slot to one exact safe path", () => {
  const repository = repositoryFixture();
  try {
    const workAccord = accord();
    const runner = new InstrumentedRunner();
    const result = executeBoundedWorktree({
      repositoryPath: repository.root,
      accord: workAccord,
      grant: grant(workAccord, repository.sha),
      patch,
      clock,
      runner
    });

    assert.deepEqual(result.files.map((file) => file.path), [
      "examples/engineering/workspace/output.txt"
    ]);
    assert.match(result.patch, /delivered/u);
    assert.deepEqual(
      runner.calls.at(-1)?.environmentKeys,
      [
        "CI",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_CONFIG_COUNT",
        "GIT_CONFIG_GLOBAL",
        "GIT_CONFIG_KEY_0",
        "GIT_CONFIG_KEY_1",
        "GIT_CONFIG_KEY_2",
        "GIT_CONFIG_KEY_3",
        "GIT_CONFIG_KEY_4",
        "GIT_CONFIG_KEY_5",
        "GIT_CONFIG_KEY_6",
        "GIT_CONFIG_KEY_7",
        "GIT_CONFIG_NOSYSTEM",
        "GIT_CONFIG_SYSTEM",
        "GIT_CONFIG_VALUE_0",
        "GIT_CONFIG_VALUE_1",
        "GIT_CONFIG_VALUE_2",
        "GIT_CONFIG_VALUE_3",
        "GIT_CONFIG_VALUE_4",
        "GIT_CONFIG_VALUE_5",
        "GIT_CONFIG_VALUE_6",
        "GIT_CONFIG_VALUE_7",
        "GIT_LITERAL_PATHSPECS",
        "GIT_NO_REPLACE_OBJECTS",
        "GIT_TERMINAL_PROMPT",
        "HOME",
        "LANG",
        "PATH"
      ]
    );
    assert.equal(
      runner.calls.some((call) =>
        call.environmentKeys.some((key) =>
          ["GH_TOKEN", "GITHUB_TOKEN", "OIDC_TOKEN", "PAT", "SECRET"].includes(key)
        )
      ),
      false
    );
  } finally {
    repository.cleanup();
  }
});

test("bounded worktree securely creates missing authorized parent directories", () => {
  const repository = repositoryFixture();
  try {
    const workAccord = accord();
    const validated = executeBoundedWorktree({
      repositoryPath: repository.root,
      accord: workAccord,
      grant: grant(workAccord, repository.sha, {
        targets: [
          {
            slot: "output",
            path: "examples/engineering/workspace/new/nested/output.txt",
            operation: "create",
            expectedDigest: null,
            expectedMode: "100644",
            maxBytes: 128
          }
        ]
      }),
      patch,
      clock
    });
    assert.equal(
      validated.files[0]?.path,
      "examples/engineering/workspace/new/nested/output.txt"
    );
  } finally {
    repository.cleanup();
  }
});

test("demo TCB exceptions require one exact reserved implementation capability", () => {
  const base = accord();
  const target = {
    slot: "output",
    path: "src/modernized/application.ts",
    operation: "create" as const,
    expectedDigest: null,
    expectedMode: "100644" as const,
    maxBytes: 128
  };
  const demoAccord: WorkAccord = {
    ...base,
    objective: {
      ...base.objective,
      inScope: ["src/modernized/application.ts"]
    },
    policy: {
      ...base.policy,
      requestedCapabilities: [
        "demo.app-modernization.implementation@1.0.0"
      ],
      allowedPaths: ["src/modernized/application.ts"]
    }
  };
  assert.doesNotThrow(() =>
    validateBoundedExecutionGrant({
      accord: demoAccord,
      grant: grant(demoAccord, "a".repeat(40), {
        targets: [target]
      }),
      clock
    })
  );
  const ambiguousAccord: WorkAccord = {
    ...demoAccord,
    policy: {
      ...demoAccord.policy,
      requestedCapabilities: [
        "demo.app-modernization.implementation@1.0.0",
        "demo.security-dependency-remediation.patch-implementation@1.0.0"
      ]
    }
  };
  assert.throws(
    () =>
      validateBoundedExecutionGrant({
        accord: ambiguousAccord,
        grant: grant(ambiguousAccord, "a".repeat(40), {
          targets: [target]
        }),
        clock
      }),
    /not authorized/u
  );
});

test("bounded worktree denies traversal, TCB paths, case collisions, and symlinks", () => {
  const repository = repositoryFixture();
  const workAccord = accord();
  try {
    for (const targetPath of [
      "../outside.txt",
      ".gitconfig",
      ".git/hooks/pre-commit",
      ".github/workflows/attack.yml",
      ".GitHub/workflows/attack.yml",
      "src/attack.ts",
      "SRC/attack.ts",
      "package.json",
      "Package.json",
      "examples/engineering/workspace/package.json",
      "examples/engineering/workspace/tsconfig.build.json",
      "examples/engineering/workspace/vite.config.ts",
      ".npmrc",
      "examples/engineering/workspace/.npmrc",
      ".env.production",
      "examples/engineering/workspace/.env.local",
      ".gitattributes",
      "examples/engineering/workspace/.gitattributes",
      ".node-version",
      ".nvmrc",
      ".tool-versions",
      "pnpm-workspace.yaml",
      "bunfig.toml",
      "deno.json",
      "CODEOWNERS",
      "docs/CODEOWNERS",
      ".github/CODEOWNERS",
      "eslint.config.js",
      "biome.json",
      "babel.config.js",
      "turbo.json",
      ":(glob)examples/engineering/workspace/*.txt",
      ":(top)examples/engineering/workspace/output.txt",
      "examples/engineering/workspace/*.txt",
      "examples/engineering/workspace/file?.txt",
      "examples/engineering/workspace/file[ab].txt",
      "examples/engineering/workspace/!output.txt",
      "examples/engineering/workspace/.gitconfig",
      "LICENSE"
    ]) {
      assert.throws(
        () =>
          executeBoundedWorktree({
            repositoryPath: repository.root,
            accord: {
              ...workAccord,
              policy: { ...workAccord.policy, allowedPaths: ["**"] }
            },
            grant: grant(
              {
                ...workAccord,
                policy: { ...workAccord.policy, allowedPaths: ["**"] }
              },
              repository.sha,
              {
                targets: [
                  {
                    slot: "output",
                    path: targetPath,
                    operation: "create",
                    expectedDigest: null,
                    expectedMode: "100644",
                    maxBytes: 128
                  }
                ]
              }
            ),
            patch,
            clock
          }),
        /canonical relative|not canonical|not authorized/u
      );
    }
    assert.throws(
      () =>
        executeBoundedWorktree({
          repositoryPath: repository.root,
          accord: workAccord,
          grant: grant(workAccord, repository.sha, {
            maxFiles: 2,
            targets: [
              ...grant(workAccord, repository.sha).targets,
              {
                slot: "other",
                path: "examples/engineering/workspace/OUTPUT.txt",
                operation: "create",
                expectedDigest: null,
                expectedMode: "100644",
                maxBytes: 128
              }
            ]
          }),
          patch,
          clock
        }),
      /not authorized/u
    );
    symlinkSync(
      "existing.txt",
      path.join(repository.root, "examples/engineering/workspace/link.txt")
    );
    execFileSync("git", ["add", "."], { cwd: repository.root });
    execFileSync("git", ["commit", "--quiet", "-m", "symlink"], {
      cwd: repository.root
    });

    const symlinkSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repository.root,
      encoding: "utf8"
    }).trim();
    const symlinkAccord = accord();
    assert.throws(
      () =>
        executeBoundedWorktree({
          repositoryPath: repository.root,
          accord: symlinkAccord,
          grant: grant(symlinkAccord, symlinkSha, {
            targets: [
              {
                slot: "output",
                path: "examples/engineering/workspace/link.txt",
                operation: "modify",
                expectedDigest: digest(
                  Buffer.from("existing.txt").toString("base64")
                ),
                expectedMode: "100644",
                maxBytes: 128
              }
            ]
          }),
          patch,
          clock
        }),
      /symlink/u
    );
  } finally {
    repository.cleanup();
  }
  assert.equal(isEngineeringTcbPath("schemas/v1alpha1/work-accord.schema.json"), true);
});

test("bounded worktree ignores hostile hooks, local config, credentials, fsmonitor, and replace refs", () => {
  const repository = repositoryFixture();
  const markerRoot = path.join(repository.root, "markers");
  mkdirSync(markerRoot);
  const hook = path.join(markerRoot, "post-checkout");
  const helper = path.join(markerRoot, "credential-helper");
  const monitor = path.join(markerRoot, "fsmonitor");
  const touched = path.join(markerRoot, "executed");
  for (const executable of [hook, helper, monitor]) {
    writeFileSync(executable, `#!/bin/sh\nprintf executed >> '${touched}'\n`);
    execFileSync("chmod", ["700", executable]);
  }
  try {
    writeFileSync(
      path.join(repository.root, "examples/engineering/workspace/output.txt"),
      "replacement-controlled\n"
    );
    execFileSync("git", ["add", "."], { cwd: repository.root });
    execFileSync("git", ["commit", "--quiet", "-m", "replacement"], {
      cwd: repository.root
    });
    const replacement = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repository.root,
      encoding: "utf8"
    }).trim();
    execFileSync("git", ["replace", repository.sha, replacement], {
      cwd: repository.root
    });
    execFileSync("git", ["reset", "--hard", "--quiet", repository.sha], {
      cwd: repository.root
    });
    execFileSync("git", ["config", "core.hooksPath", markerRoot], {
      cwd: repository.root
    });
    execFileSync("git", ["config", "core.fsmonitor", monitor], {
      cwd: repository.root
    });
    execFileSync("git", ["config", "credential.helper", `!${helper}`], {
      cwd: repository.root
    });
    execFileSync("git", ["config", "alias.status", `!${hook}`], {
      cwd: repository.root
    });

    const workAccord = accord();
    const result = executeBoundedWorktree({
      repositoryPath: repository.root,
      accord: workAccord,
      grant: grant(workAccord, repository.sha),
      patch,
      clock
    });
    assert.match(result.patch, /delivered/u);
    assert.throws(() => readFileSync(touched), /ENOENT/u);
  } finally {
    repository.cleanup();
  }
});

test("bounded worktree rejects unexpected, staged, mode, binary, empty, and oversized changes", () => {
  for (const behavior of [
    "unexpected",
    "extra-staged",
    "mode",
    "binary",
    "empty"
  ] as const) {
    const repository = repositoryFixture();
    try {
      const workAccord = accord();
      assert.throws(
        () =>
          executeBoundedWorktree({
            repositoryPath: repository.root,
            accord: workAccord,
            grant: grant(workAccord, repository.sha),
            patch,
            clock,
            runner: new InstrumentedRunner(behavior)
          }),
        /PATCH_INVALID|unexpected|staged|mode|binary|empty/u,
        behavior
      );
    } finally {
      repository.cleanup();
    }
  }
  const repository = repositoryFixture();
  try {
    const workAccord = accord();
    assert.throws(
      () =>
        executeBoundedWorktree({
          repositoryPath: repository.root,
          accord: workAccord,
          grant: grant(workAccord, repository.sha),
          patch: {
            ...patch,
            changes: [{ slot: "output", content: "x".repeat(129) }]
          },
          clock
        }),
      /byte limit/u
    );
  } finally {
    repository.cleanup();
  }
});

test("bounded worktree rejects rename and submodule changes", () => {
  for (const behavior of ["rename", "submodule"] as const) {
    const repository = repositoryFixture();
    try {
      const workAccord = accord();
      assert.throws(
        () =>
          executeBoundedWorktree({
            repositoryPath: repository.root,
            accord: workAccord,
            grant: grant(workAccord, repository.sha),
            patch,
            clock,
            runner: new InstrumentedRunner(behavior)
          }),
        /mode, rename, copy, delete, or submodule change/u,
        behavior
      );
    } finally {
      repository.cleanup();
    }
  }
});

test("verification uses fixed commands and fails closed on injection, timeout, nonzero, and output limits", () => {
  for (const behavior of ["timeout", "nonzero", "overflow"] as const) {
    const repository = repositoryFixture();
    try {
      const workAccord = accord();
      assert.throws(
        () =>
          executeBoundedWorktree({
            repositoryPath: repository.root,
            accord: workAccord,
            grant: grant(workAccord, repository.sha),
            patch,
            clock,
            runner: new InstrumentedRunner(behavior)
          }),
        /VERIFICATION_FAILED|failed with status/u
      );
    } finally {
      repository.cleanup();
    }
  }
  const repository = repositoryFixture();
  try {
    const workAccord = accord();
    const runner = new InstrumentedRunner();
    assert.throws(
      () =>
        executeBoundedWorktree({
          repositoryPath: repository.root,
          accord: workAccord,
          grant: grant(workAccord, repository.sha, {
            verificationCommandIds: ["git-diff-check; curl attacker.invalid"]
          }),
          patch,
          clock,
          runner
        }),
      /mandatory fixed verification command/u
    );
    assert.equal(
      runner.calls.some((call) => call.args.join(" ").includes("curl")),
      false
    );
  } finally {
    repository.cleanup();
  }
});

test("non-Git verification requires a separately isolated credentialless runner", () => {
  const repository = repositoryFixture();
  try {
    const workAccord: WorkAccord = {
      ...accord(),
      evidence: {
        ...accord().evidence,
        verificationCommands: ["typecheck"]
      }
    };
    assert.throws(
      () =>
        executeBoundedWorktree({
          repositoryPath: repository.root,
          accord: workAccord,
          grant: grant(workAccord, repository.sha, {
            verificationCommandIds: ["typecheck"]
          }),
          patch,
          clock
        }),
      /separately isolated credentialless runner/u
    );
  } finally {
    repository.cleanup();
  }
});
