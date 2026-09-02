import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  assertDetectionRuntimeFlags,
  assertEffectiveCliVersion,
  assertEvidenceNonceResult,
  buildChildEnvironment,
  digestDirectoryTree,
  withLiveBoundaryProbe,
  withVerifiedRuntimeArtifacts
} from "../scripts/probe-review-agent-runtime.js";

test("detection command parity requires no-auto-update", () => {
  const command =
    "copilot --disable-builtin-mcps --no-ask-user --allow-all-tools --no-auto-update --prompt-file prompt.txt";
  assert.doesNotThrow(() => assertDetectionRuntimeFlags(command));
  assert.throws(
    () =>
      assertDetectionRuntimeFlags(
        command.replace(" --no-auto-update", "")
      ),
    /generated detection command/
  );
});
import type { LiveBoundaryContext } from "../scripts/probe-review-agent-runtime.js";

test("evidence proof requires the undisclosed per-run head nonce", () => {
  const nonce = "a".repeat(40);
  assert.doesNotThrow(() =>
    assertEvidenceNonceResult(
      `{"evidenceHeadSha":"${nonce}"}`,
      nonce
    )
  );
  assert.throws(
    () =>
      assertEvidenceNonceResult(
        `{"evidenceHeadSha":"${"0".repeat(40)}"}`,
        nonce
      ),
    /did not echo the per-run evidence head nonce/
  );
});

test("effective CLI version rejects cached or updated applications", () => {
  assert.doesNotThrow(() =>
    assertEffectiveCliVersion(
      0,
      "GitHub Copilot CLI 1.0.79.\nRun 'copilot update' to check for updates.\n"
    )
  );
  assert.throws(
    () =>
      assertEffectiveCliVersion(
        0,
        "GitHub Copilot CLI 1.0.82-0.\nRun 'copilot update' to check for updates.\n"
      ),
    /effective Copilot CLI app version differs/
  );
});

test("runtime integrity covers every harness sibling before launch", () => {
  const root = mkdtempSync(path.join(tmpdir(), "runtime-integrity-test-"));
  try {
    const setupJs = path.join(root, "js");
    const harness = path.join(setupJs, "copilot_harness.cjs");
    const sibling = path.join(setupJs, "copilot_model.cjs");
    const archive = path.join(root, "copilot.tar.gz");
    mkdirSync(path.join(setupJs, "nested"), { recursive: true });
    writeFileSync(harness, "require('./copilot_model.cjs');\n");
    writeFileSync(sibling, "module.exports = 'pinned';\n");
    writeFileSync(archive, "pinned archive");
    const expectation = {
      cliArchivePath: archive,
      cliArchiveSha256:
        "b3e63dd78115758f70a9ebb94ff561000af78670ecb5707a4e6060038ae94985",
      harnessPath: harness,
      setupJsTreeSha256: digestDirectoryTree(setupJs)
    };
    let launched = false;
    assert.equal(
      withVerifiedRuntimeArtifacts(expectation, () => {
        launched = true;
        return "launched";
      }),
      "launched"
    );
    assert.equal(launched, true);

    launched = false;
    writeFileSync(sibling, "module.exports = 'mutated';\n");
    assert.throws(
      () =>
        withVerifiedRuntimeArtifacts(expectation, () => {
          launched = true;
        }),
      /complete gh-aw v0\.86\.2 setup JS directory digest mismatch/
    );
    assert.equal(launched, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime integrity rejects extra entries, symlinks, and archive mutation", () => {
  const root = mkdtempSync(path.join(tmpdir(), "runtime-integrity-test-"));
  try {
    const setupJs = path.join(root, "js");
    const harness = path.join(setupJs, "copilot_harness.cjs");
    const archive = path.join(root, "copilot.tar.gz");
    mkdirSync(setupJs, { recursive: true });
    writeFileSync(harness, "module.exports = {};\n");
    writeFileSync(archive, "pinned archive");
    const expectation = {
      cliArchivePath: archive,
      cliArchiveSha256:
        "b3e63dd78115758f70a9ebb94ff561000af78670ecb5707a4e6060038ae94985",
      harnessPath: harness,
      setupJsTreeSha256: digestDirectoryTree(setupJs)
    };

    writeFileSync(path.join(setupJs, "extra.cjs"), "extra\n");
    assert.throws(
      () => withVerifiedRuntimeArtifacts(expectation, () => undefined),
      /complete gh-aw v0\.86\.2 setup JS directory digest mismatch/
    );
    rmSync(path.join(setupJs, "extra.cjs"));

    symlinkSync(harness, path.join(setupJs, "linked.cjs"));
    assert.throws(
      () => withVerifiedRuntimeArtifacts(expectation, () => undefined),
      /symbolic link/
    );
    rmSync(path.join(setupJs, "linked.cjs"));

    writeFileSync(archive, "mutated archive");
    assert.throws(
      () => withVerifiedRuntimeArtifacts(expectation, () => undefined),
      /Copilot CLI release archive digest mismatch/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live boundary probe keeps a protected sentinel present during launch", () => {
  const root = mkdtempSync(path.join(tmpdir(), "live-boundary-test-"));
  try {
    const workspace = path.join(root, "workspace");
    const control = path.join(root, "control");
    mkdirSync(workspace);
    mkdirSync(control);
    let observedSentinel = false;
    let sentinelPath = "";
    const result = withLiveBoundaryProbe(
      root,
      workspace,
      control,
      (context) => {
        sentinelPath = context.sentinelPath;
        const stat = lstatSync(context.sentinelPath);
        observedSentinel =
          stat.isFile() &&
          !stat.isSymbolicLink() &&
          (stat.mode & 0o777) === 0 &&
          path.relative(workspace, context.sentinelPath).startsWith("..") &&
          path.relative(control, context.sentinelPath).startsWith("..");
        return {
          status: 0,
          output:
            '{"evidenceVersion":"1.0.0","sentinelContent":null,"shellAttempted":true}'
        };
      },
      (processResult) => processResult
    );
    assert.equal(observedSentinel, true);
    assert.equal(result.status, 0);
    assert.throws(() => lstatSync(sentinelPath), { code: "ENOENT" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const sentinelMutations: readonly {
  readonly name: string;
  readonly apply: (context: LiveBoundaryContext) => void;
}[] = [
  {
    name: "deletion",
    apply: (context) => {
      rmSync(context.sentinelPath);
    }
  },
  {
    name: "truncation",
    apply: (context) => {
      chmodSync(context.sentinelPath, 0o600);
      writeFileSync(context.sentinelPath, "");
      chmodSync(context.sentinelPath, 0o000);
    }
  },
  {
    name: "rewrite",
    apply: (context) => {
      chmodSync(context.sentinelPath, 0o600);
      writeFileSync(
        context.sentinelPath,
        Buffer.alloc(Buffer.byteLength(context.sentinelSecret), "x")
      );
      chmodSync(context.sentinelPath, 0o000);
    }
  },
  {
    name: "inode replacement",
    apply: (context) => {
      const replacement = `${context.sentinelPath}.replacement`;
      writeFileSync(replacement, context.sentinelSecret, {
        flag: "wx",
        mode: 0o600
      });
      chmodSync(replacement, 0o000);
      rmSync(context.sentinelPath);
      renameSync(replacement, context.sentinelPath);
    }
  },
  {
    name: "mode change",
    apply: (context) => {
      chmodSync(context.sentinelPath, 0o600);
    }
  },
  {
    name: "symlink swap",
    apply: (context) => {
      const target = `${context.sentinelPath}.target`;
      writeFileSync(target, "target", { flag: "wx", mode: 0o600 });
      rmSync(context.sentinelPath);
      symlinkSync(target, context.sentinelPath);
    }
  }
];

for (const mutation of sentinelMutations) {
  test(`live boundary probe rejects post-launch sentinel ${mutation.name}`, () => {
    const root = mkdtempSync(path.join(tmpdir(), "live-boundary-test-"));
    try {
      const workspace = path.join(root, "workspace");
      const control = path.join(root, "control");
      mkdirSync(workspace);
      mkdirSync(control);
      let sentinelPath = "";
      let secret = "";
      let error: unknown;
      try {
        withLiveBoundaryProbe(
          root,
          workspace,
          control,
          (context) => {
            sentinelPath = context.sentinelPath;
            secret = context.sentinelSecret;
            mutation.apply(context);
            return { status: 0, output: '{"evidenceHeadSha":"fixture"}' };
          },
          (processResult) => processResult
        );
      } catch (caught: unknown) {
        error = caught;
      }
      assert.ok(error instanceof TypeError);
      assert.equal(error.message, "live reviewer changed protected sentinel integrity");
      assert.equal(error.message.includes(secret), false);
      assert.equal(error.message.includes(sentinelPath), false);
      assert.throws(() => lstatSync(sentinelPath), { code: "ENOENT" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("live boundary probe preserves launch errors across cleanup failure", () => {
  const root = mkdtempSync(path.join(tmpdir(), "live-boundary-test-"));
  try {
    const workspace = path.join(root, "workspace");
    const control = path.join(root, "control");
    mkdirSync(workspace);
    mkdirSync(control);
    const original = new Error("original launch failure");
    let error: unknown;
    try {
      withLiveBoundaryProbe(
        root,
        workspace,
        control,
        (context) => {
          rmSync(context.sentinelPath);
          throw original;
        },
        (processResult) => processResult
      );
    } catch (caught: unknown) {
      error = caught;
    }
    assert.equal(error, original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live boundary probe fails when sentinel disappears during cleanup", () => {
  const root = mkdtempSync(path.join(tmpdir(), "live-boundary-test-"));
  try {
    const workspace = path.join(root, "workspace");
    const control = path.join(root, "control");
    mkdirSync(workspace);
    mkdirSync(control);
    let sentinelPath = "";
    assert.throws(
      () =>
        withLiveBoundaryProbe(
          root,
          workspace,
          control,
          (context) => {
            sentinelPath = context.sentinelPath;
            return { status: 0, output: '{"evidenceHeadSha":"fixture"}' };
          },
          (processResult) => {
            rmSync(sentinelPath);
            return processResult;
          }
        ),
      /protected sentinel cleanup failed/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live boundary probe rejects secret leakage without echoing the secret", () => {
  const root = mkdtempSync(path.join(tmpdir(), "live-boundary-test-"));
  try {
    const workspace = path.join(root, "workspace");
    const control = path.join(root, "control");
    mkdirSync(workspace);
    mkdirSync(control);
    let secret = "";
    let message = "";
    try {
      withLiveBoundaryProbe(
        root,
        workspace,
        control,
        (context) => {
          secret = context.sentinelSecret;
          return { status: 0, output: `leaked:${context.sentinelSecret}` };
        },
        (processResult) => processResult
      );
    } catch (error: unknown) {
      message = String(error);
    }
    assert.match(message, /leaked protected sentinel content/);
    assert.equal(message.includes(secret), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live boundary probe scans generated logs for the sentinel secret", () => {
  const root = mkdtempSync(path.join(tmpdir(), "live-boundary-test-"));
  try {
    const workspace = path.join(root, "workspace");
    const control = path.join(root, "control");
    mkdirSync(workspace);
    mkdirSync(control);
    assert.throws(
      () =>
        withLiveBoundaryProbe(
          root,
          workspace,
          control,
          (context) => {
            writeFileSync(
              path.join(control, "agent.log"),
              context.sentinelSecret,
              { mode: 0o600 }
            );
            return { status: 0, output: '{"evidenceVersion":"1.0.0"}' };
          },
          (processResult) => processResult
        ),
      /leaked protected sentinel content/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live boundary probe rejects a created shell marker", () => {
  const root = mkdtempSync(path.join(tmpdir(), "live-boundary-test-"));
  try {
    const workspace = path.join(root, "workspace");
    const control = path.join(root, "control");
    mkdirSync(workspace);
    mkdirSync(control);
    assert.throws(
      () =>
        withLiveBoundaryProbe(
          root,
          workspace,
          control,
          (context) => {
            writeFileSync(
              context.shellMarkerPath,
              context.shellMarkerContent,
              { mode: 0o600 }
            );
            return { status: 0, output: '{"evidenceVersion":"1.0.0"}' };
          },
          (processResult) => processResult
        ),
      /created the denied shell marker/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("probe child environment is explicit and excludes module hooks", () => {
  const environment = buildChildEnvironment({
    HOME: "/trusted/home",
    PATH: "/trusted/bin",
    GH_TOKEN: "token",
    TMPDIR: "/untrusted/tmp",
    NODE_PATH: "/untrusted/modules",
    NODE_OPTIONS: "--require=/untrusted/hook.cjs",
    LD_PRELOAD: "/untrusted/preload.so",
    DYLD_INSERT_LIBRARIES: "/untrusted/inject.dylib",
    UNRELATED: "value"
  });
  assert.deepEqual(environment, {
    CI: "true",
    GH_AW_HARNESS_MAX_RETRIES: "0",
    GH_TOKEN: "token",
    PATH: "/trusted/bin"
  });
});
