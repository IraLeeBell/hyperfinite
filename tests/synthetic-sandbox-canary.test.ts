import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { canonicalJson } from "../src/canonical.js";
import { signSyntheticCanaryBody } from "../scripts/run-synthetic-sandbox-canary.js";

test("synthetic canary signatures are deterministic, ephemeral, and tamper-evident", () => {
  const body = {
    kind: "SyntheticSandboxCanaryEvidence",
    targetFree: true,
    stop: "human-review"
  };
  const first = signSyntheticCanaryBody(body);
  const second = signSyntheticCanaryBody(body);
  assert.deepEqual(first, second);
  assert.equal(first.algorithm, "ed25519");
  assert.equal(first.keyId, "synthetic-canary:ephemeral:v1");
  assert.match(
    readFileSync("scripts/run-synthetic-sandbox-canary.ts", "utf8"),
    /agentic-framework credentialless synthetic sandbox canary v1/u
  );
  assert.equal(
    verify(
      null,
      Buffer.from(canonicalJson(body), "utf8"),
      createPublicKey({
        key: Buffer.from(first.publicKey, "base64"),
        format: "der",
        type: "spki"
      }),
      Buffer.from(first.value, "base64")
    ),
    true
  );
  assert.equal(
    verify(
      null,
      Buffer.from(canonicalJson({ ...body, stop: "completed" }), "utf8"),
      createPublicKey({
        key: Buffer.from(first.publicKey, "base64"),
        format: "der",
        type: "spki"
      }),
      Buffer.from(first.value, "base64")
    ),
    false
  );
});

test("synthetic canary rejects live options before ambient environment access", () => {
  const result = spawnSync(
    process.execPath,
    ["dist/scripts/run-synthetic-sandbox-canary.js", "--live"],
    {
      encoding: "utf8",
      env: {
        PATH: "/usr/bin:/bin",
        SECRET_SENTINEL: "must-not-be-read"
      }
    }
  );
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /forbidden before environment or credential reads/u
  );
  assert.equal(result.stderr.includes("must-not-be-read"), false);
});

test("synthetic canary network guard denies Node network primitives", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--import=./dist/scripts/deny-network.js",
      "--input-type=module",
      "--eval",
      'await fetch("https://example.invalid")'
    ],
    {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin" }
    }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SYNTHETIC_CANARY_NETWORK_DENIED/u);

  const rawSocket = spawnSync(
    process.execPath,
    [
      "--import=./dist/scripts/deny-network.js",
      "--input-type=module",
      "--eval",
      'const { Socket } = await import("node:net"); new Socket().connect(80, "192.0.2.1")'
    ],
    {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin" }
    }
  );
  assert.notEqual(rawSocket.status, 0);
  assert.match(rawSocket.stderr, /SYNTHETIC_CANARY_NETWORK_DENIED/u);
});

test("synthetic canary command and source remain credentialless and target-free", () => {
  const packageDocument = JSON.parse(readFileSync("package.json", "utf8")) as {
    readonly scripts: Readonly<Record<string, string>>;
  };
  assert.equal(
    packageDocument.scripts["canary:synthetic"],
    "npm run build && node dist/scripts/run-synthetic-sandbox-canary.js"
  );
  const source = readFileSync(
    "scripts/run-synthetic-sandbox-canary.ts",
    "utf8"
  );
  assert.equal(source.includes("process.env"), false);
  assert.equal(source.includes("GH_TOKEN"), false);
  assert.equal(source.includes("GITHUB_TOKEN"), false);
  assert.equal(source.includes("gh api"), false);
  assert.equal(source.includes("curl"), false);
  assert.match(source, /handsOffStop: "human-review"/u);
  assert.match(source, /automatedReviewEvent: "COMMENT"/u);
  assert.match(source, /liveGitHubApiMutation: false/u);
  assert.match(source, /privateKeyPersisted: false/u);
});
