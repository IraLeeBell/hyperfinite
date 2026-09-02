#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { parse } from "yaml";

import {
  loadTrustedRuntimeWorkflowBindings,
  readStrictJsonFile
} from "./demo-runtime-metadata.js";
import {
  isExactReviewHeadScript,
  isExactReviewWorkspaceScript,
  PINNED_WORKFLOW_ACTIONS
} from "../src/runtime-workflow-validation.js";
import { assertDocument } from "../src/validation.js";

const workflowDirectory = path.resolve(".github/workflows");
const expectedVersion = "v0.86.2";
const expectedActionRef = "48e5fa3ff52294d91d97715017a9f8693a48387f";
const runtimePolicy = assertDocument(
  "CopilotRuntimePolicy",
  await readStrictJsonFile("config/v1alpha1/copilot-runtime-policy.json")
);
const capabilityRegistry = assertDocument(
  "CapabilityRegistry",
  await readStrictJsonFile("config/v1alpha1/capability-registry.json")
);
const runtimeMetadata = await loadTrustedRuntimeWorkflowBindings({
  policy: runtimePolicy,
  baseRegistry: capabilityRegistry
});
const bindingsBySource = new Map(
  runtimeMetadata.bindings.map((binding) => [
    `${binding.workflow}.md`,
    binding
  ])
);
if (bindingsBySource.size !== runtimeMetadata.bindings.length) {
  throw new TypeError("trusted runtime metadata binds a workflow more than once");
}

function run(command: string, args: readonly string[]): string {
  return execFileSync(command, [...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function directNeeds(job: { readonly needs?: string | readonly string[] }): Set<string> {
  return new Set(typeof job.needs === "string" ? [job.needs] : (job.needs ?? []));
}

const versionResult = spawnSync("gh", ["aw", "version"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"]
});
if (versionResult.error !== undefined) throw versionResult.error;
if (versionResult.status !== 0) {
  throw new TypeError(
    `gh aw version failed: ${versionResult.stderr.trim() || `exit ${versionResult.status}`}`
  );
}
const version = `${versionResult.stdout}${versionResult.stderr}`.trim();
if (!version.includes(expectedVersion)) {
  throw new TypeError(`gh-aw ${expectedVersion} is required; received ${version}`);
}

const entries = await readdir(workflowDirectory);
const sources = entries.filter((entry) => entry.endsWith(".md")).sort();
if (sources.length === 0) {
  throw new TypeError("no Agentic Workflow Markdown sources were found");
}
for (const source of sources) {
  if (!bindingsBySource.has(source)) {
    throw new TypeError(
      `Agentic Workflow source ${source} has no trusted runtime binding`
    );
  }
}
for (const binding of runtimeMetadata.bindings) {
  const source = `${binding.workflow}.md`;
  if (!sources.includes(source)) {
    throw new TypeError(`trusted runtime binding ${binding.workflow} has no source`);
  }
}
const expectedLocks = new Set(
  sources.map((source) => source.replace(/\.md$/u, ".lock.yml"))
);
const executableWorkflows = entries.filter(
  (entry) => entry.endsWith(".yml") || entry.endsWith(".yaml")
);
for (const workflow of executableWorkflows) {
  if (!expectedLocks.has(workflow)) {
    throw new TypeError(
      `executable workflow ${path.join(workflowDirectory, workflow)} has no Agentic Workflow Markdown source`
    );
  }
}
const artifactPaths = [
  ...sources.flatMap((source) => [
    path.join(workflowDirectory, source),
    path.join(workflowDirectory, source.replace(/\.md$/u, ".lock.yml"))
  ]),
  path.resolve(".github/aw/actions-lock.json")
];
const before = new Map(
  await Promise.all(
    artifactPaths.map(async (file) => [file, sha256(await readFile(file, "utf8"))] as const)
  )
);

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

const errors: string[] = [];
for (const source of sources) {
  const binding = bindingsBySource.get(source);
  if (binding === undefined) {
    throw new TypeError(`workflow ${source} has no trusted runtime binding`);
  }
  const sourcePath = path.join(workflowDirectory, source);
  const lockPath = sourcePath.replace(/\.md$/u, ".lock.yml");
  const lock = await readFile(lockPath, "utf8");
  const generated = parse(lock) as {
    readonly on?: Readonly<Record<string, unknown>>;
    readonly jobs?: Readonly<
      Record<
        string,
        {
          readonly needs?: string | readonly string[];
          readonly env?: Readonly<Record<string, string>>;
          readonly permissions?: Readonly<Record<string, string>>;
          readonly outputs?: Readonly<Record<string, string>>;
          readonly steps?: readonly {
            readonly id?: string;
            readonly if?: string;
            readonly name?: string;
            readonly uses?: string;
            readonly run?: string;
            readonly env?: Readonly<Record<string, string>>;
            readonly with?: Readonly<Record<string, string>>;
          }[];
        }
      >
    >;
  };
  const manifestMatch = /^# gh-aw-manifest: (.+)$/mu.exec(lock);
  if (manifestMatch?.[1] === undefined) {
    errors.push(`${lockPath} has no compiler action manifest`);
    continue;
  }
  const manifest = JSON.parse(manifestMatch[1]) as {
    readonly version?: number;
    readonly actions?: readonly {
      readonly repo?: string;
      readonly sha?: string;
      readonly version?: string;
    }[];
  };
  if (
    manifest.version !== 1 ||
    JSON.stringify(manifest.actions) !== JSON.stringify(PINNED_WORKFLOW_ACTIONS)
  ) {
    errors.push(`${lockPath} differs from the exact pinned workflow action set`);
  }
  const metadataMatch = /^# gh-aw-metadata: (.+)$/mu.exec(lock);
  if (metadataMatch?.[1] === undefined) {
    errors.push(`${lockPath} has no compiler metadata`);
    continue;
  }
  const metadata = JSON.parse(metadataMatch[1]) as {
    readonly frontmatter_hash?: string;
    readonly compiler_version?: string;
    readonly strict?: boolean;
  };
  const frontmatterHash = run("gh", ["aw", "hash-frontmatter", sourcePath]);
  if (
    metadata.compiler_version !== expectedVersion ||
    metadata.strict !== true ||
    metadata.frontmatter_hash !== frontmatterHash
  ) {
    errors.push(`${lockPath} metadata does not match its source and pinned compiler`);
  }
  if (!lock.includes(`github/gh-aw/actions/setup@${expectedActionRef}`)) {
    errors.push(`${lockPath} does not pin the reviewed gh-aw action commit`);
  }
  const operationalFallback = lock.split("\n").find((line) => {
    if (!/\$\{\{\s*secrets\.GH_AW_GITHUB/u.test(line)) return false;
    return !/^\s+(?:GH_AW_GITHUB(?:_MCP_SERVER)?_TOKEN|SECRET_GH_AW_GITHUB(?:_MCP_SERVER)?_TOKEN):/u.test(
      line
    );
  });
  if (operationalFallback !== undefined) {
    errors.push(`${lockPath} contains an operational GH_AW PAT fallback expression`);
  }
  if (
    !lock.includes("needs.pre_activation.outputs.trusted_guard_result == 'success'") ||
    !lock.includes("needs.pre_activation.outputs.authorization_digest != ''") ||
    !lock.includes("needs.pre_activation.outputs.redemption_digest != ''") ||
    !lock.includes("copilot-requests: write")
  ) {
    errors.push(`${lockPath} does not preserve pre-activation gating`);
  }
  if (
    !lock.includes(
      "authorized_head_sha: ${{ steps.trusted_guard.outputs.authorized_head_sha }}"
    )
  ) {
    errors.push(`${lockPath} does not export the signed authorized head`);
  }
  if (
    lock.includes("issues: write") ||
    lock.includes('GH_AW_FAILURE_REPORT_AS_ISSUE: "true"') ||
    lock.includes('"create_report_incomplete_issue"') ||
    lock.includes('"create_missing_tool_issue"')
  ) {
    errors.push(`${lockPath} retains an unreviewed conclusion issue-write path`);
  }
  if (
    lock.includes("Checkout PR branch") ||
    lock.includes("checkout_pr_branch.cjs")
  ) {
    errors.push(`${lockPath} checks out a mutable pull-request branch`);
  }
  const expectedSafeOutputTool =
    binding.workflowClass === "current-head-comment-review"
      ? "submit_pull_request_review"
      : binding.workflowClass === "framing-comment"
        ? "add_comment"
        : binding.workflowClass === "target-free-execution"
          ? "stage_implementation_patch"
          : null;
  if (
    expectedSafeOutputTool !== null &&
    !lock.includes(`"${expectedSafeOutputTool}"`)
  ) {
    errors.push(`${lockPath} omits its exact staged safe-output tool`);
  }
  if (
    lock.includes('"create_issue"') ||
    lock.includes("safe_outputs_auto_create_issue.md") ||
    lock.includes('"report_incomplete"') ||
    lock.includes('"missing_tool"') ||
    lock.includes('"missing_data"') ||
    lock.includes('"noop"')
  ) {
    errors.push(`${lockPath} exposes an implicit safe-output fallback tool`);
  }
  if (
    binding.workflowClass === "target-free-execution" &&
    (!lock.includes("model_execution_context_json") ||
      !lock.includes("trusted_execution_authorization_b64") ||
    !lock.includes("trusted_execution_kernel_result_b64") ||
    !lock.includes(`${binding.workflow}-authorization-\${{ github.run_id }}-\${{ github.run_attempt }}`) ||
      !lock.includes("node dist/scripts/runtime-execution-bridge.js") ||
      !lock.includes("TargetFreePatch@1.0.0") ||
      !lock.includes('GITHUB_TOKEN: ""') ||
      !lock.includes("persist-credentials: false") ||
      !lock.includes("needs.detection.outputs.detection_success == 'true'") ||
      !lock.includes(
        "needs.detection.outputs.detection_conclusion == 'success'"
      ) ||
      !lock.includes("AGENTIC_EVIDENCE_SIGNER_URL") ||
      !lock.includes(`${binding.workflow}-bundle-\${{ github.run_id }}-\${{ github.run_attempt }}`) ||
      !lock.includes("delivery_handoff_path") ||
      !lock.includes("node dist/scripts/runtime-execution-delivery-request.js") ||
      !lock.includes("AGENTIC_EXECUTION_DELIVERY_URL") ||
      !lock.includes("AGENTIC_EXECUTION_DELIVERY_AUDIENCE") ||
      !lock.includes("steps.trusted_execution_bundle.outputs.artifact-id") ||
      !lock.includes("steps.trusted_execution_bundle.outputs.artifact-digest") ||
      !lock.includes("steps.trusted_execution_bridge.outputs.delivery_handoff_digest"))
  ) {
    errors.push(
      `${lockPath} does not preserve the signed plan, closed patch, and trusted bounded-execution bridge`
    );
  }
  const expectedTriggers = [
    ...new Set(
      binding.slashCommand.events.map((event) =>
        event === "pull_request_comment" ? "issue_comment" : event
      )
    )
  ].sort();
  const actualTriggers = Object.keys(generated.on ?? {}).sort();
  if (
    actualTriggers.length !== expectedTriggers.length ||
    actualTriggers.some((trigger, index) => trigger !== expectedTriggers[index])
  ) {
    errors.push(
      `${lockPath} exposes triggers other than the reviewed default-branch issue events`
    );
  }
  const trustedStepCondition =
    "steps.check_command_position.outputs.command_position_ok == 'true' && steps.check_membership.outputs.is_team_member == 'true'";
  for (const [jobName, job] of Object.entries(generated.jobs ?? {})) {
    if (
      binding.workflowClass === "target-free-execution" &&
      jobName === "stage_implementation_patch" &&
      (job.env !== undefined ||
        job.permissions?.contents !== "read" ||
        job.permissions?.["id-token"] !== "write" ||
        Object.keys(job.permissions ?? {}).length !== 2)
    ) {
      errors.push(
        `${lockPath} custom safe-output job has unexpected environment or permissions`
      );
    }
    if (
      job.permissions?.["id-token"] !== undefined &&
      ((jobName !== "pre_activation" &&
        !(binding.workflowClass === "target-free-execution" &&
          jobName === "stage_implementation_patch")) ||
        job.permissions["id-token"] !== "write")
    ) {
      errors.push(`${lockPath} exposes OIDC permission outside trusted pre-activation`);
    }
    const jobNeeds = directNeeds(job);
    const serializedJob = JSON.stringify(job);
    for (const match of serializedJob.matchAll(
      /needs\.([A-Za-z0-9_-]+)(?:\.outputs\.([A-Za-z0-9_-]+))?/gu
    )) {
      const dependency = match[1];
      const output = match[2];
      if (dependency === undefined || !jobNeeds.has(dependency)) {
        errors.push(
          `${lockPath} job ${jobName} references non-direct dependency ${dependency ?? "unknown"}`
        );
        continue;
      }
      if (
        output !== undefined &&
        !Object.hasOwn(generated.jobs?.[dependency]?.outputs ?? {}, output)
      ) {
        errors.push(
          `${lockPath} job ${jobName} references undeclared output ${dependency}.${output}`
        );
      }
    }
  }
  const agentNeeds = directNeeds(generated.jobs?.agent ?? {});
  if (!agentNeeds.has("activation") || !agentNeeds.has("pre_activation")) {
    errors.push(
      `${lockPath} agent job must directly depend on activation and pre_activation`
    );
  }
  const trustedGuard = generated.jobs?.pre_activation?.steps?.find(
    (step) => step.id === "trusted_guard"
  );
  if (trustedGuard?.if !== trustedStepCondition) {
    errors.push(`${lockPath} can redeem before slash-command and role checks succeed`);
  }
  if (generated.jobs?.conclusion?.permissions?.issues !== undefined) {
    errors.push(`${lockPath} conclusion job has issues permission`);
  }
  if (binding.workflowClass === "current-head-comment-review") {
    const agent = generated.jobs?.agent;
    const agentSteps = agent?.steps ?? [];
    const trustedCheckout = agentSteps.find(
      (step) =>
        step.name === "Check out the trusted runtime" &&
        step.uses?.startsWith("actions/checkout@")
    );
    const headCheck = agentSteps.find(
      (step) =>
        step.name === "Materialize exact authorized review evidence" &&
        step.uses?.startsWith("actions/github-script@")
    );
    const workspaceGuard = agentSteps.find(
      (step) =>
        step.name === "Restrict agent workspace to declared review inputs" &&
        step.uses?.startsWith("actions/github-script@")
    );
    const copilotInstall = agentSteps.find(
      (step) => step.name === "Install GitHub Copilot CLI"
    );
    const detectionCopilotInstall = generated.jobs?.detection?.steps?.find(
      (step) => step.name === "Install GitHub Copilot CLI"
    );
    const detectionExecution = generated.jobs?.detection?.steps?.find(
      (step) => step.name === "Execute GitHub Copilot CLI"
    );
    const restoreAgentIndex = agentSteps.findIndex(
      (step) => step.name === "Restore inline sub-agents from activation artifact"
    );
    const restoreSkillsIndex = agentSteps.findIndex(
      (step) => step.name === "Restore inline skills from activation artifact"
    );
    const workspaceGuardIndex = agentSteps.indexOf(workspaceGuard!);
    const executionIndex = agentSteps.findIndex(
      (step) => step.name === "Execute GitHub Copilot CLI"
    );
    const postGuardStepNames = agentSteps
      .slice(workspaceGuardIndex + 1, executionIndex)
      .map((step) => step.name ?? "");
    const expectedPostGuardStepNames = [
      "Download container images",
      "Generate Safe Outputs Config",
      "Generate Safe Outputs Tools",
      "Start MCP Gateway",
      "Mount MCP servers as CLIs",
      "Clean credentials",
      "Audit pre-agent workspace"
    ];
    const safeOutputs = generated.jobs?.safe_outputs;
    if (
      trustedCheckout?.with?.ref !== "${{ github.workflow_sha }}" ||
      agentSteps.some(
        (step) =>
          step.uses?.startsWith("actions/checkout@") &&
          step.with?.ref ===
            "${{ needs.pre_activation.outputs.authorized_head_sha }}"
      ) ||
      headCheck?.env?.AUTHORIZED_HEAD_SHA !==
        "${{ needs.pre_activation.outputs.authorized_head_sha }}" ||
      typeof headCheck.with?.script !== "string" ||
      !isExactReviewHeadScript(headCheck.with.script) ||
      !headCheck.with?.script?.includes("before.data.head.sha !== authorizedHead") ||
      !headCheck.with?.script?.includes(
        "compareCommitsWithBasehead"
      ) ||
      !headCheck.with?.script?.includes(
        "after.data.head.sha !== authorizedHead"
      ) ||
      !headCheck.with?.script?.includes(
        'const evidenceSource = "/tmp/gh-aw/authorized-review-evidence.json"'
      ) ||
      !workspaceGuard?.with?.script?.includes(
        `".github/agents/${binding.agent}.agent.md"`
      ) ||
      typeof workspaceGuard.with.script !== "string" ||
      !isExactReviewWorkspaceScript(
        workspaceGuard.with.script,
        binding.agent,
        binding.skill
      ) ||
      !workspaceGuard.with?.script?.includes(
        `".github/skills/${binding.skill}/SKILL.md"`
      ) ||
      !workspaceGuard.with?.script?.includes(
        '".github/skills/authority-refusal/SKILL.md"'
      ) ||
      !workspaceGuard.with?.script?.includes(
        "fs.rmSync(path.join(workspace, entry)"
      ) ||
      !workspaceGuard.with?.script?.includes(
        '"/tmp/gh-aw/.github"'
      ) ||
      !workspaceGuard.with?.script?.includes(
        '"/tmp/gh-aw/base"'
      ) ||
      !workspaceGuard.with?.script?.includes(
        '"/tmp/gh-aw/aw-prompts/prompt-template.txt"'
      ) ||
      !workspaceGuard.with?.script?.includes(
        '"/tmp/gh-aw/aw-prompts/prompt-import-tree.json"'
      ) ||
      !workspaceGuard.with?.script?.includes(
        'const expectedFiles = ['
      ) ||
      restoreAgentIndex < 0 ||
      restoreSkillsIndex < 0 ||
      workspaceGuardIndex <= restoreAgentIndex ||
      workspaceGuardIndex <= restoreSkillsIndex ||
      executionIndex <= workspaceGuardIndex ||
      postGuardStepNames.join("\n") !==
        expectedPostGuardStepNames.join("\n") ||
      headCheck.with?.script?.includes("exec.getExecOutput") ||
        copilotInstall?.run !==
          'bash "${RUNNER_TEMP}/gh-aw/actions/install_copilot_cli.sh" 1.0.79' ||
        copilotInstall.env?.GH_AW_COMPILED_VERSION !== undefined ||
        detectionCopilotInstall?.run !==
          'bash "${RUNNER_TEMP}/gh-aw/actions/install_copilot_cli.sh" 1.0.79' ||
        detectionCopilotInstall.env?.GH_AW_COMPILED_VERSION !== undefined ||
        JSON.stringify(agent).includes("--allow-all-paths") ||
        JSON.stringify(agent).includes("--allow-all-tools") ||
      !JSON.stringify(agent).includes("--add-dir /tmp/gh-aw/") ||
      !JSON.stringify(agent).includes('--add-dir \\"${GITHUB_WORKSPACE}\\"') ||
      !JSON.stringify(agent).includes("--no-custom-instructions") ||
        !JSON.stringify(agent).includes("--no-auto-update") ||
        !JSON.stringify(detectionExecution).includes("--no-auto-update") ||
        !JSON.stringify(agent).includes("--deny-tool=write") ||
      !JSON.stringify(agent).includes("--deny-tool=shell") ||
      !JSON.stringify(agent).includes(
        "--allow-tool safeoutputs --allow-tool write --no-custom-instructions --no-auto-update --deny-tool=write --deny-tool=shell"
      ) ||
      (
        JSON.stringify(agent).match(/--add-dir/g)?.length ?? 0
      ) !== 2 ||
      safeOutputs?.env?.GH_AW_SAFE_OUTPUTS_STAGED !== "true" ||
      Object.keys(safeOutputs?.permissions ?? {}).length !== 0
    ) {
      errors.push(
        `${lockPath} does not preserve exact-head evidence and non-writing staged review output`
      );
    }
  }
}

for (const file of artifactPaths) {
  const after = sha256(await readFile(file, "utf8"));
  if (before.get(file) !== after) {
    errors.push(`${path.relative(process.cwd(), file)} was stale before compilation`);
  }
}

const actionLock = await readFile(".github/aw/actions-lock.json", "utf8");
const actionLockDocument = JSON.parse(actionLock) as {
  readonly entries?: Readonly<Record<string, unknown>>;
};
const expectedActionLockKey = `github/gh-aw/actions/setup@${expectedActionRef}`;
if (!actionLock.includes(expectedActionRef)) {
  errors.push("actions-lock.json does not contain the pinned gh-aw action commit");
}
const actionLockKeys = Object.keys(actionLockDocument.entries ?? {}).sort();
if (
  actionLockKeys.length !== 1 ||
  actionLockKeys[0] !== expectedActionLockKey
) {
  errors.push(
    `actions-lock.json differs from the exact source action set: expected ${expectedActionLockKey}; received ${actionLockKeys.join(", ") || "none"}`
  );
}

if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exitCode = 1;
} else {
  console.log(
    `Validated ${sources.length} source/lock pairs with gh-aw ${expectedVersion}; generated artifacts are fresh.`
  );
}
