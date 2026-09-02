import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { parse } from "yaml";

import { digest } from "../src/canonical.js";
import { validateDocument } from "../src/validation.js";

test("privileged review workflow never checks out pull-request content", async () => {
  for (const path of [
    ".github/workflows/agentic-review.md",
    ".github/workflows/agentic-review.lock.yml"
  ]) {
    const source = await readFile(path, "utf8");
    assert.equal(
      source.includes(
        "ref: ${{ needs.pre_activation.outputs.authorized_head_sha }}"
      ),
      false
    );
    assert.equal(source.includes("path: review-target"), false);
    assert.ok(source.includes("compareCommitsWithBasehead"));
    assert.ok(source.includes("evidence.json"));
    assert.ok(source.includes("after.data.head.sha !== authorizedHead"));
    assert.ok(source.includes(".github/agents/runtime-reviewer.agent.md"));
    assert.ok(
      source.includes(".github/skills/current-head-review/SKILL.md")
    );
    assert.ok(source.includes(".github/skills/authority-refusal/SKILL.md"));
    assert.ok(source.includes("fs.rmSync(path.join(workspace, entry)"));
    assert.ok(source.includes("/tmp/gh-aw/.github"));
    assert.ok(source.includes("/tmp/gh-aw/base"));
    assert.ok(source.includes("/tmp/gh-aw/aw-prompts/prompt-template.txt"));
    assert.ok(source.includes("/tmp/gh-aw/aw-prompts/prompt-import-tree.json"));
    assert.ok(source.includes("const expectedFiles = ["));
    assert.equal(source.includes('"get_file_contents"'), false);
    assert.equal(source.includes('"get_pull_request_files"'), false);
  }
  const markdown = await readFile(
    ".github/workflows/agentic-review.md",
    "utf8"
  );
  assert.ok(markdown.includes("github: false"));
  assert.ok(markdown.includes("bare: true"));
  assert.ok(markdown.includes('version: "1.0.79"'));
  assert.ok(markdown.includes("--no-auto-update"));
  assert.ok(markdown.includes("cannot select a repository, pull request, or ref"));
  const lock = await readFile(
    ".github/workflows/agentic-review.lock.yml",
    "utf8"
  );
  const generated = parse(lock) as {
    readonly jobs?: {
      readonly agent?: {
        readonly steps?: readonly {
          readonly name?: string;
          readonly run?: string;
          readonly env?: Readonly<Record<string, string>>;
          readonly with?: { readonly script?: string };
        }[];
      };
      readonly detection?: {
        readonly steps?: readonly {
          readonly name?: string;
          readonly run?: string;
          readonly env?: Readonly<Record<string, string>>;
        }[];
      };
    };
  };
  const command = generated.jobs?.agent?.steps?.find(
    (step) => step.name === "Execute GitHub Copilot CLI"
  )?.run;
  const steps = generated.jobs?.agent?.steps ?? [];
  const copilotInstall = steps.find(
    (step) => step.name === "Install GitHub Copilot CLI"
  );
  assert.equal(
    copilotInstall?.run,
    'bash "${RUNNER_TEMP}/gh-aw/actions/install_copilot_cli.sh" 1.0.79'
  );
  assert.equal(copilotInstall?.env?.GH_AW_COMPILED_VERSION, undefined);
  const detectionCopilotInstall = generated.jobs?.detection?.steps?.find(
    (step) => step.name === "Install GitHub Copilot CLI"
  );
  assert.equal(
    detectionCopilotInstall?.run,
    'bash "${RUNNER_TEMP}/gh-aw/actions/install_copilot_cli.sh" 1.0.79'
  );
  assert.equal(
    detectionCopilotInstall?.env?.GH_AW_COMPILED_VERSION,
    undefined
  );
  const restoreAgentIndex = steps.findIndex(
    (step) => step.name === "Restore inline sub-agents from activation artifact"
  );
  const restoreSkillsIndex = steps.findIndex(
    (step) => step.name === "Restore inline skills from activation artifact"
  );
  const guardIndex = steps.findIndex(
    (step) => step.name === "Restrict agent workspace to declared review inputs"
  );
  const executeIndex = steps.findIndex(
    (step) => step.name === "Execute GitHub Copilot CLI"
  );
  assert.ok(restoreAgentIndex < guardIndex);
  assert.ok(restoreSkillsIndex < guardIndex);
  assert.ok(guardIndex < executeIndex);
  const guard = steps[guardIndex]?.with?.script;
  assert.ok(guard?.includes('"/tmp/gh-aw/.github"'));
  assert.ok(guard?.includes('"/tmp/gh-aw/base"'));
  assert.ok(guard?.includes('"/tmp/gh-aw/aw-prompts/prompt-template.txt"'));
  assert.ok(guard?.includes('"/tmp/gh-aw/aw-prompts/prompt-import-tree.json"'));
  assert.deepEqual(
    steps.slice(guardIndex + 1, executeIndex).map((step) => step.name),
    [
      "Download container images",
      "Generate Safe Outputs Config",
      "Generate Safe Outputs Tools",
      "Start MCP Gateway",
      "Mount MCP servers as CLIs",
      "Clean credentials",
      "Audit pre-agent workspace"
    ]
  );
  assert.equal(
    steps.slice(guardIndex + 1, executeIndex).some(
      (step) =>
        step.name?.startsWith("Restore inline ") ||
        step.name?.includes("Check out") ||
        step.name?.includes("Download activation artifact")
    ),
    false
  );
  assert.equal(command?.includes("--allow-all-paths"), false);
  assert.equal(command?.includes("--allow-all-tools"), false);
  assert.ok(command?.includes('--add-dir "${GITHUB_WORKSPACE}"'));
  assert.ok(command?.includes("--no-custom-instructions"));
  assert.ok(command?.includes("--no-auto-update"));
  assert.ok(command?.includes("--deny-tool=write"));
  assert.ok(command?.includes("--deny-tool=shell"));
  assert.ok(
    command?.includes(
      "--allow-tool safeoutputs --allow-tool write --no-custom-instructions --no-auto-update --deny-tool=write --deny-tool=shell"
    )
  );
  assert.equal(command?.match(/--add-dir/g)?.length, 2);
});

test("artifact-policy evidence schema is closed and rejects malformed identity", () => {
  const valid = {
    purpose: "domain-artifact-policy-assessment",
    packId: "marketing",
    authorityDigest: digest("authority"),
    artifactSetDigest: digest("artifacts"),
    inputDigest: digest("input"),
    prohibitedEffectsDigest: digest("effects"),
    status: "success",
    findings: [],
    assessor: "trusted-independent-service",
    modelSelfAttested: false,
    checkedAt: "2026-08-28T00:00:00Z",
    expiresAt: "2026-08-28T00:05:00Z",
    signature: {
      keyId: "artifact-policy:key-1",
      algorithm: "ed25519",
      value: "c2lnbmF0dXJl"
    }
  };
  assert.equal(
    validateDocument("DomainArtifactPolicyAssessment", valid).valid,
    true
  );
  for (const mutation of [
    { ...valid, packId: "engineering" },
    { ...valid, authorityDigest: "sha256:not-a-digest" },
    { ...valid, inputDigest: "sha256:not-a-digest" },
    { ...valid, unexpected: true }
  ]) {
    assert.equal(
      validateDocument("DomainArtifactPolicyAssessment", mutation).valid,
      false
    );
  }
});

test("durable operation-grant claim schema rejects incomplete evidence", () => {
  const payload = {
    purpose: "domain-operation-grant-claim",
    storeId: "trusted:grant-store",
    storeSequence: 1,
    claimChallenge: digest("claim-challenge"),
    casResult: "appended",
    grantDigest: digest("grant"),
    redemptionKey: digest("redemption"),
    operation: "repository-package",
    contextDigest: digest("context"),
    repositoryIdentityDigest: digest("repository"),
    runId: "run-1",
    runAttempt: 1,
    operationSequence: 2,
    grantCheckedAt: "2026-08-28T00:00:00Z",
    claimedAt: "2026-08-28T00:00:01Z",
    grantExpiresAt: "2026-08-28T00:05:00Z",
    previousHead: null
  };
  const valid = {
    ...payload,
    head: digest(payload),
    signature: {
      keyId: "grant-store:key-1",
      algorithm: "ed25519",
      value: "c2lnbmF0dXJl"
    }
  };
  assert.equal(validateDocument("DomainOperationGrantClaim", valid).valid, true);
  const { runAttempt: _runAttempt, ...missingAttempt } = valid;
  assert.equal(
    validateDocument("DomainOperationGrantClaim", missingAttempt).valid,
    false
  );
});

test("operation grant store head schema enforces exact genesis state", () => {
  const base = {
    purpose: "domain-operation-grant-store-head",
    storeId: "trusted:grant-store",
    challenge: digest("store-head-challenge"),
    observedAt: "2026-08-28T00:00:00Z",
    expiresAt: "2026-08-28T00:05:00Z",
    signature: {
      keyId: "grant-store:key-1",
      algorithm: "ed25519",
      value: "c2lnbmF0dXJl"
    }
  };
  assert.equal(
    validateDocument("DomainOperationGrantStoreHead", {
      ...base,
      storeSequence: 0,
      head: null
    }).valid,
    true
  );
  assert.equal(
    validateDocument("DomainOperationGrantStoreHead", {
      ...base,
      storeSequence: 1,
      head: digest("store-head")
    }).valid,
    true
  );
  for (const impossible of [
    { ...base, storeSequence: 0, head: digest("impossible-genesis") },
    { ...base, storeSequence: 1, head: null }
  ]) {
    assert.equal(
      validateDocument("DomainOperationGrantStoreHead", impossible).valid,
      false
    );
  }
});

test("security and governance owner surfaces remain explicit", async () => {
  const codeowners = await readFile(".github/CODEOWNERS", "utf8");
  for (const path of [
    "/.github/",
    "/config/",
    "/schemas/",
    "/src/",
    "/scripts/",
    "/tests/",
    "/docs/security/",
    "/docs/runbooks/",
    "/LICENSE"
  ]) {
    assert.ok(codeowners.includes(path));
  }
  for (const path of [
    "CONTRIBUTING.md",
    "GOVERNANCE.md",
    "SECURITY.md",
    "SUPPORT.md",
    "docs/runbooks/deployment-prerequisites.md",
    "docs/runbooks/incident-response.md",
    "docs/runbooks/recovery.md",
    "docs/security/ghas-administrator-runbook.md",
    "docs/security/secrets-and-identity.md"
  ]) {
    assert.ok((await readFile(path, "utf8")).length > 100);
  }
});
