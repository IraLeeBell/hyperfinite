#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { parse } from "yaml";

import { canonicalJson } from "../src/canonical.js";
import type { CapabilityRegistry, CopilotRuntimePolicy } from "../src/types.js";
import {
  selectDomainProfile,
  validateDomainPackDefinition
} from "../src/domain-packs.js";
import {
  isExactExecutionAuthorizationSealScript,
  isExactReviewHeadScript,
  isExactReviewWorkspaceScript,
  REVIEWED_NON_AGENTIC_WORKFLOW_FILES
} from "../src/runtime-workflow-validation.js";
import { assertDocument } from "../src/validation.js";
import {
  loadTrustedRuntimeWorkflowBindings,
  readStrictJsonFile
} from "./demo-runtime-metadata.js";

interface AgentFrontmatter {
  readonly tools?: readonly string[];
  readonly metadata?: Readonly<Record<string, string>>;
  readonly "user-invocable"?: boolean;
  readonly "disable-model-invocation"?: boolean;
}

interface SkillFrontmatter {
  readonly "allowed-tools"?: readonly string[];
  readonly metadata?: Readonly<Record<string, string>>;
}

interface WorkflowFrontmatter {
  readonly on?: {
    readonly slash_command?: {
      readonly name?: string;
      readonly events?: readonly string[];
    };
    readonly roles?: readonly string[];
    readonly reaction?: string;
    readonly "status-comment"?: boolean;
    readonly permissions?: Readonly<Record<string, string>>;
    readonly steps?: readonly {
      readonly id?: string;
      readonly if?: string;
      readonly name?: string;
      readonly uses?: string;
      readonly run?: string;
      readonly with?: Readonly<Record<string, string | number | boolean>>;
      readonly env?: Readonly<Record<string, string>>;
    }[];
  };
  readonly jobs?: {
    readonly "pre-activation"?: {
      readonly outputs?: Readonly<Record<string, string>>;
    };
    readonly agent?: {
      readonly needs?: readonly string[];
    };
  };
  readonly permissions?: Readonly<Record<string, string>>;
  readonly env?: Readonly<Record<string, string>>;
  readonly if?: string;
  readonly checkout?: boolean;
  readonly "pre-steps"?: readonly {
    readonly name?: string;
    readonly uses?: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly with?: Readonly<Record<string, string | boolean>>;
  }[];
  readonly "pre-agent-steps"?: readonly {
    readonly name?: string;
    readonly uses?: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly with?: Readonly<Record<string, string | boolean>>;
  }[];
  readonly engine?: {
    readonly id?: string;
    readonly version?: string;
    readonly agent?: string;
    readonly args?: readonly string[];
    readonly bare?: boolean;
    readonly "max-continuations"?: number;
  };
  readonly network?: Readonly<Record<string, unknown>>;
  readonly tools?: {
    readonly bash?: false | readonly string[];
    readonly edit?: false;
    readonly "cli-proxy"?: false;
    readonly github?:
      | false
      | {
          readonly toolsets?: readonly string[];
          readonly allowed?: readonly string[];
          readonly "allowed-repos"?: readonly string[];
          readonly "min-integrity"?: string;
          readonly "github-token"?: string;
        };
  };
  readonly skills?: readonly string[];
  readonly "timeout-minutes"?: number;
  readonly model?: string;
  readonly "max-turns"?: number;
  readonly "max-ai-credits"?: number;
  readonly "max-daily-ai-credits"?: number;
  readonly concurrency?: {
    readonly group?: string;
    readonly "cancel-in-progress"?: boolean;
    readonly queue?: string;
  };
  readonly "safe-outputs"?: {
    readonly staged?: boolean;
    readonly "github-token"?: string;
    readonly mentions?: boolean;
    readonly "allowed-github-references"?: readonly string[];
    readonly "max-bot-mentions"?: number;
    readonly "report-failure-as-issue"?: boolean;
    readonly "report-failed-jobs"?: boolean;
    readonly "missing-tool"?: boolean;
    readonly "missing-data"?: boolean;
    readonly "report-incomplete"?: boolean;
    readonly noop?: boolean;
    readonly "threat-detection"?: {
      readonly enabled?: boolean;
      readonly "max-ai-credits"?: number;
      readonly engine?:
        | string
        | {
            readonly id?: string;
            readonly version?: string;
          readonly args?: readonly string[];
        };
    };
    readonly "add-comment"?: {
      readonly max?: number;
      readonly target?: string;
      readonly "target-repo"?: string;
    };
    readonly "submit-pull-request-review"?: {
      readonly max?: number;
      readonly "allowed-events"?: readonly string[];
      readonly target?: string;
      readonly "target-repo"?: string;
      readonly footer?: string;
    };
    readonly jobs?: Readonly<
      Record<
        string,
        {
          readonly description?: string;
          readonly "runs-on"?: string;
          readonly if?: string;
          readonly permissions?: Readonly<Record<string, string>>;
          readonly inputs?: Readonly<
            Record<
              string,
              {
                readonly description?: string;
                readonly required?: boolean;
                readonly type?: string;
              }
            >
          >;
          readonly steps?: readonly {
            readonly id?: string;
            readonly if?: string;
            readonly name?: string;
            readonly uses?: string;
            readonly run?: string;
            readonly with?: Readonly<Record<string, string | number | boolean>>;
            readonly env?: Readonly<Record<string, string>>;
          }[];
        }
      >
    >;
  };
}

async function readJson(relativePath: string): Promise<unknown> {
  return readStrictJsonFile(relativePath);
}

async function readFrontmatter<T>(relativePath: string): Promise<T> {
  const source = await readFile(path.resolve(relativePath), "utf8");
  const match = /^---\n([\s\S]*?)\n---\n/u.exec(source);
  if (match?.[1] === undefined) {
    throw new TypeError(`${relativePath} has no YAML frontmatter`);
  }
  return parse(match[1]) as T;
}

function capabilityByReference(
  registry: CapabilityRegistry,
  reference: string
): CapabilityRegistry["capabilities"][number] {
  const capability = registry.capabilities.find(
    (candidate) => `${candidate.id}@${candidate.version}` === reference
  );
  if (capability === undefined) {
    throw new TypeError(`unknown capability reference ${reference}`);
  }
  return capability;
}

function exactSet(
  values: readonly string[],
  expected: readonly string[],
  subject: string
): void {
  if (values.includes("*")) {
    throw new TypeError(`${subject} uses wildcard tool authority`);
  }

  const actual = [...new Set(values)].sort();
  const wanted = [...new Set(expected)].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((value, index) => value !== wanted[index])
  ) {
    throw new TypeError(
      `${subject} differs from exact authority: expected ${wanted.join(", ") || "none"}; received ${actual.join(", ") || "none"}`
    );
  }
}

function exactRecord(
  value: Readonly<Record<string, string>> | undefined,
  expected: Readonly<Record<string, string>>,
  subject: string
): void {
  if (value === undefined) {
    throw new TypeError(`${subject} is missing`);
  }

  exactSet(Object.keys(value), Object.keys(expected), subject);
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (value[key] !== expectedValue) {
      throw new TypeError(`${subject}.${key} differs from exact policy`);
    }
  }
}

function agentToolName(tool: string): string {
  return tool.replace(".", "/");
}

const policy = assertDocument(
  "CopilotRuntimePolicy",
  await readJson("config/v1alpha1/copilot-runtime-policy.json")
);
const registry = assertDocument(
  "CapabilityRegistry",
  await readJson("config/v1alpha1/capability-registry.json")
);
const runtimeMetadata = await loadTrustedRuntimeWorkflowBindings({
  policy,
  baseRegistry: registry
});
const runtimeRegistry: CapabilityRegistry = {
  ...registry,
  capabilities: [
    ...registry.capabilities,
    ...runtimeMetadata.shards.flatMap((shard) => shard.capabilities.spec.capabilities)
  ]
};
const runtimeBindings = runtimeMetadata.bindings;
const domainProfileCatalog = await readJson("config/v1alpha1/domain-profiles.json");
selectDomainProfile(domainProfileCatalog, "engineering");
const domainDefinitions = await Promise.all(
  (["marketing", "business-operations"] as const).map(async (id) => {
    const profile = selectDomainProfile(domainProfileCatalog, id);
    if (
      profile.definitionRef !==
      `config/v1alpha1/domain-packs/${id}/definition.json`
    ) {
      throw new TypeError(`${id} runtime profile has a substituted definition`);
    }
    return validateDomainPackDefinition(
      await readJson(profile.definitionRef)
    );
  })
);
const errors: string[] = [];

for (const binding of runtimeBindings) {
  try {
    const expectedWorkflowClass =
      binding.phase === "framing"
        ? "framing-comment"
        : binding.phase === "execution"
          ? "target-free-execution"
          : "current-head-comment-review";
    const expectedRole =
      binding.phase === "framing"
        ? "framer"
        : binding.phase === "execution"
          ? "executor"
          : "reviewer";
    if (
      binding.workflowClass !== expectedWorkflowClass ||
      binding.role !== expectedRole
    ) {
      throw new TypeError(
        `${binding.workflow} workflow class cannot weaken its phase controls`
      );
    }
    if (
      binding.workflowClass !== "framing-comment" &&
      (binding.githubToolsets.length > 0 || binding.githubTools.length > 0)
    ) {
      throw new TypeError(
        `${binding.workflow} cannot enable live GitHub tools for its workflow class`
      );
    }
    const capability = capabilityByReference(runtimeRegistry, binding.capability);
    if (!capability.allowedPhases.includes(binding.phase)) {
      throw new TypeError(
        `${binding.capability} is not allowed in ${binding.phase}`
      );
    }
    const agentPath = `.github/agents/${binding.agent}.agent.md`;
    const skillPath = `.github/skills/${binding.skill}/SKILL.md`;
    const agent = await readFrontmatter<AgentFrontmatter>(agentPath);
    const skill = await readFrontmatter<SkillFrontmatter>(skillPath);
    if (!Array.isArray(agent.tools)) {
      throw new TypeError(`${agentPath} must declare an explicit tools array`);
    }
    if (!Array.isArray(skill["allowed-tools"])) {
      throw new TypeError(
        `${skillPath} must declare an explicit allowed-tools array`
      );
    }
    if (
      agent.metadata?.capability !== binding.capability ||
      agent.metadata?.["framework-phase"] !== binding.phase ||
      agent.metadata?.["framework-role"] !== binding.role
    ) {
      throw new TypeError(`${agentPath} metadata differs from its runtime binding`);
    }
    if (
      skill.metadata?.capability !== binding.capability ||
      skill.metadata?.phase !== binding.phase
    ) {
      throw new TypeError(`${skillPath} metadata differs from its runtime binding`);
    }
    if (
      agent["user-invocable"] !== binding.userInvocable ||
      agent["disable-model-invocation"] !== true
    ) {
      throw new TypeError(
        `${agentPath} user-invocable posture differs from its trusted binding`
      );
    }
    if (
      binding.userInvocable !==
        (binding.source === "demo" &&
          binding.demoProjectId === "adaptive-delivery" &&
          binding.optionKey !== null &&
          (binding.stageId === "discovery-studio" ||
            binding.stageId === "implementation-studio"))
    ) {
      throw new TypeError(
        `${agentPath} user invocation is outside a reviewed selectable stage`
      );
    }
    const capabilityTools = [
      ...capability.access.tools,
      ...capability.access.mcpTools.map(agentToolName)
    ];
    exactSet(agent.tools, capabilityTools, agentPath);
    exactSet(skill["allowed-tools"], capabilityTools, skillPath);

    for (const safetySkillName of binding.safetySkills) {
      const safetyPath = `.github/skills/${safetySkillName}/SKILL.md`;
      const safety = await readFrontmatter<SkillFrontmatter>(safetyPath);
      if (!Array.isArray(safety["allowed-tools"])) {
        throw new TypeError(`${safetyPath} must declare an explicit allowed-tools array`);
      }
      const safetyCapabilityReference = safety.metadata?.capability;
      if (
        safetyCapabilityReference === undefined ||
        safety.metadata?.phase !== "all" ||
        safety.metadata?.role !== "safety"
      ) {
        throw new TypeError(`${safetyPath} is not a cross-phase safety skill`);
      }
      const safetyCapability = capabilityByReference(
        runtimeRegistry,
        safetyCapabilityReference
      );
      if (!safetyCapability.allowedPhases.includes(binding.phase)) {
        throw new TypeError(
          `${safetyCapabilityReference} is not allowed in ${binding.phase}`
        );
      }
      exactSet(
        safety["allowed-tools"],
        safetyCapability.access.tools,
        safetyPath
      );
    }

    const expectedMcpTools = [
      ...binding.githubTools.map((tool) => `github.${tool}`),
      ...(binding.workflowClass === "framing-comment"
        ? ["safeoutputs.add_comment"]
        : binding.workflowClass === "current-head-comment-review"
          ? ["safeoutputs.submit_pull_request_review"]
          : [])
    ];
    exactSet(capability.access.mcpTools, expectedMcpTools, binding.capability);

    if (binding.workflow !== null) {
      const workflowPath = `.github/workflows/${binding.workflow}.md`;
      const workflow = await readFrontmatter<WorkflowFrontmatter>(workflowPath);
      const guard = workflow.on?.steps?.find(
        (step) => step.env?.RUNTIME_PHASE !== undefined
      );
      const checkout = workflow.on?.steps?.find(
        (step) => step.uses === "actions/checkout@v7"
      );
      const trustedStepCondition =
        "steps.check_command_position.outputs.command_position_ok == 'true' && steps.check_membership.outputs.is_team_member == 'true'";
      const activationSteps = workflow.on?.steps ?? [];
      const activationCheckout = activationSteps[0];
      const activationNode = activationSteps[1];
      const activationInstall = activationSteps[2];
      const activationBuild = activationSteps[3];
      const activationGuard = activationSteps[4];
      for (const [step, keys, subject] of [
        [activationCheckout, ["name", "if", "uses", "with"], "activation checkout"],
        [activationNode, ["name", "if", "uses", "with"], "activation Node setup"],
        [activationInstall, ["name", "if", "run"], "activation dependency install"],
        [activationBuild, ["name", "if", "run"], "activation build"],
        [activationGuard, ["name", "id", "if", "env", "run"], "trusted activation guard"]
      ] as const) {
        exactSet(
          Object.keys(step ?? {}),
          keys,
          `${workflowPath} ${subject} keys`
        );
      }
      exactSet(
        Object.keys(activationCheckout?.with ?? {}),
        ["ref", "persist-credentials"],
        `${workflowPath} activation checkout inputs`
      );
      exactSet(
        Object.keys(activationNode?.with ?? {}),
        ["node-version", "cache"],
        `${workflowPath} activation Node inputs`
      );
      exactRecord(
        activationGuard?.env,
        {
          GITHUB_TOKEN: "${{ github.token }}",
          AGENTIC_RUNTIME_ENABLED: "${{ vars.AGENTIC_RUNTIME_ENABLED }}",
          AGENTIC_ALLOWED_ACTOR_IDS:
            "${{ vars.AGENTIC_ALLOWED_ACTOR_IDS }}",
          AGENTIC_APP_ID: "${{ vars.AGENTIC_APP_ID }}",
          AGENTIC_APP_ACTOR_ID: "${{ vars.AGENTIC_APP_ACTOR_ID }}",
          AGENTIC_PROJECT_NODE_ID: "${{ vars.AGENTIC_PROJECT_NODE_ID }}",
          AGENTIC_STATE_SIGNING_KEY_ID:
            "${{ vars.AGENTIC_STATE_SIGNING_KEY_ID }}",
          AGENTIC_STATE_SIGNING_PUBLIC_KEY:
            "${{ vars.AGENTIC_STATE_SIGNING_PUBLIC_KEY }}",
          AGENTIC_REDEEMER_URL: "${{ vars.AGENTIC_REDEEMER_URL }}",
          AGENTIC_REDEEMER_AUDIENCE:
            "${{ vars.AGENTIC_REDEEMER_AUDIENCE }}",
          AGENTIC_REDEEMER_SIGNING_KEY_ID:
            "${{ vars.AGENTIC_REDEEMER_SIGNING_KEY_ID }}",
          AGENTIC_REDEEMER_SIGNING_PUBLIC_KEY:
            "${{ vars.AGENTIC_REDEEMER_SIGNING_PUBLIC_KEY }}",
          GITHUB_EVENT_ACTION: "${{ github.event.action }}",
          WORK_ITEM_NUMBER: "${{ github.event.issue.number }}",
          WORK_ITEM_KIND:
            binding.workflowClass === "current-head-comment-review"
              ? "pull-request"
              : "issue",
          RUNTIME_PHASE: binding.phase,
          RUNTIME_ROLE: binding.role,
          RUNTIME_CAPABILITY: binding.capability,
          RUNTIME_WORKFLOW_ID: binding.workflow,
          ...(binding.demoProjectId === null
            ? {}
            : { RUNTIME_DEMO_PROJECT_ID: binding.demoProjectId }),
          ...(binding.stageId === null
            ? {}
            : { RUNTIME_STAGE_ID: binding.stageId }),
          ...(binding.userInvocable
            ? {
                AGENTIC_STAGE_AGENT_SELECTION_SIGNING_KEY_ID:
                  "${{ vars.AGENTIC_STAGE_AGENT_SELECTION_SIGNING_KEY_ID }}",
                AGENTIC_STAGE_AGENT_SELECTION_SIGNING_PUBLIC_KEY:
                  "${{ vars.AGENTIC_STAGE_AGENT_SELECTION_SIGNING_PUBLIC_KEY }}"
              }
            : {}),
          WORK_ACCORD_DIGEST: "${{ vars.AGENTIC_WORK_ACCORD_DIGEST }}",
          POLICY_DIGEST: "${{ vars.AGENTIC_POLICY_DIGEST }}",
          KERNEL_POLICY_DIGEST: "${{ vars.AGENTIC_KERNEL_POLICY_DIGEST }}",
          ACTIVATION_LEASE_DIGEST:
            "${{ vars.AGENTIC_ACTIVATION_LEASE_DIGEST }}"
        },
        `${workflowPath} trusted activation guard environment`
      );
      if (
        activationCheckout?.uses !== "actions/checkout@v7" ||
        activationCheckout.with?.ref !== "${{ github.workflow_sha }}" ||
        activationCheckout.with["persist-credentials"] !== false ||
        activationNode?.uses !== "actions/setup-node@v7" ||
        activationNode.with?.["node-version"] !== 24 ||
        activationNode.with.cache !== "npm" ||
        activationInstall?.run !== "npm ci --ignore-scripts" ||
        activationBuild?.run !== "npm run build" ||
        activationGuard?.id !== "trusted_guard" ||
        activationGuard.run !==
          "node dist/scripts/runtime-pre-activation.js" ||
        !activationSteps
          .slice(0, 5)
          .every((step) => step.if === trustedStepCondition)
      ) {
        throw new TypeError(
          `${workflowPath} trusted pre-activation steps differ from policy`
        );
      }
      if (binding.workflowClass === "target-free-execution") {
        const seal = activationSteps[5];
        const upload = activationSteps[6];
        exactSet(
          Object.keys(seal ?? {}),
          ["name", "if", "env", "run"],
          `${workflowPath} authorization seal keys`
        );
        exactRecord(
          seal?.env,
          {
            TRUSTED_EXECUTION_AUTHORIZATION_B64:
              "${{ steps.trusted_guard.outputs.trusted_execution_authorization_b64 }}",
            TRUSTED_EXECUTION_KERNEL_RESULT_B64:
              "${{ steps.trusted_guard.outputs.trusted_execution_kernel_result_b64 }}"
          },
          `${workflowPath} authorization seal environment`
        );
        exactSet(
          Object.keys(upload ?? {}),
          ["name", "if", "uses", "with"],
          `${workflowPath} authorization upload keys`
        );
        exactSet(
          Object.keys(upload?.with ?? {}),
          ["name", "path", "if-no-files-found", "retention-days"],
          `${workflowPath} authorization upload inputs`
        );
        const transferCondition =
          "steps.trusted_guard.outcome == 'success' && steps.trusted_guard.outputs.trusted_execution_authorization_b64 != ''";
        if (
          seal?.if !== transferCondition ||
          typeof seal.run !== "string" ||
          !isExactExecutionAuthorizationSealScript(seal.run) ||
          upload?.if !== transferCondition ||
          upload.uses !== "actions/upload-artifact@v7" ||
          upload.with?.name !==
            `${binding.workflow}-authorization-\${{ github.run_id }}-\${{ github.run_attempt }}` ||
          upload.with.path !==
            "${{ runner.temp }}/agentic-execution-authorization" ||
          upload.with["if-no-files-found"] !== "error" ||
          upload.with["retention-days"] !== 1
        ) {
          throw new TypeError(
            `${workflowPath} trusted authorization transfer differs from policy`
          );
        }
      }
      if (
        workflow.engine?.id !== policy.modelSelection.provider ||
        workflow.engine.agent !== binding.agent ||
        (binding.workflowClass === "current-head-comment-review"
          ? workflow.engine.version !== "1.0.79" ||
            workflow.engine.bare !== true ||
            canonicalJson(workflow.engine.args) !==
              canonicalJson([
                "--no-auto-update",
                "--deny-tool=write",
                "--deny-tool=shell"
              ])
          : workflow.engine.bare !== undefined ||
            workflow.engine.args !== undefined) ||
        guard?.env?.RUNTIME_PHASE !== binding.phase ||
        guard.env.RUNTIME_ROLE !== binding.role ||
        guard.env.RUNTIME_CAPABILITY !== binding.capability ||
        guard.env.RUNTIME_WORKFLOW_ID !== binding.workflow ||
        guard.env.RUNTIME_DEMO_PROJECT_ID !==
          (binding.demoProjectId ?? undefined) ||
        guard.env.RUNTIME_STAGE_ID !== (binding.stageId ?? undefined) ||
        guard.env.AGENTIC_REDEEMER_URL !== "${{ vars.AGENTIC_REDEEMER_URL }}" ||
        guard.env.AGENTIC_REDEEMER_AUDIENCE !==
          "${{ vars.AGENTIC_REDEEMER_AUDIENCE }}" ||
        guard.env.AGENTIC_REDEEMER_SIGNING_KEY_ID !==
          "${{ vars.AGENTIC_REDEEMER_SIGNING_KEY_ID }}" ||
        guard.env.AGENTIC_REDEEMER_SIGNING_PUBLIC_KEY !==
          "${{ vars.AGENTIC_REDEEMER_SIGNING_PUBLIC_KEY }}" ||
        guard.env.KERNEL_POLICY_DIGEST !==
          "${{ vars.AGENTIC_KERNEL_POLICY_DIGEST }}" ||
        guard.env.REQUESTED_AI_CREDITS !== undefined ||
        checkout?.with?.ref !== "${{ github.workflow_sha }}" ||
        checkout.with["persist-credentials"] !== false ||
        workflow.on?.steps?.length !==
          (binding.workflowClass === "target-free-execution" ? 7 : 5) ||
        activationGuard !== guard ||
        activationCheckout !== checkout
      ) {
        throw new TypeError(`${workflowPath} runtime binding differs from policy`);
      }
      exactSet(
        workflow.skills ?? [],
        [binding.skill, ...binding.safetySkills].map(
          (skillName) => `.github/skills/${skillName}`
        ),
        `${workflowPath} skills`
      );
      const hasGitHubTools =
        binding.githubToolsets.length > 0 || binding.githubTools.length > 0;
      const workflowGitHubTools = workflow.tools?.github;
      exactSet(
        workflowGitHubTools === false
          ? []
          : (workflowGitHubTools?.toolsets ?? []),
        binding.githubToolsets,
        `${workflowPath} GitHub toolsets`
      );
      exactSet(
        workflowGitHubTools === false
          ? []
          : (workflowGitHubTools?.allowed ?? []),
        binding.githubTools,
        `${workflowPath} GitHub tools`
      );
      exactSet(
        workflowGitHubTools === false
          ? []
          : (workflowGitHubTools?.["allowed-repos"] ?? []),
        hasGitHubTools ? ["${{ github.repository }}"] : [],
        `${workflowPath} GitHub repositories`
      );
      if (
        (hasGitHubTools
          ? workflowGitHubTools === false ||
            workflowGitHubTools?.["min-integrity"] !== "approved" ||
            workflowGitHubTools["github-token"] !== "${{ secrets.GITHUB_TOKEN }}"
          : workflowGitHubTools !== false) ||
        workflow.if !==
          (binding.workflowClass === "current-head-comment-review"
            ? "needs.pre_activation.outputs.trusted_guard_result == 'success' && needs.pre_activation.outputs.authorization_digest != '' && needs.pre_activation.outputs.redemption_digest != '' && needs.pre_activation.outputs.authorized_head_sha != ''"
            : "needs.pre_activation.outputs.trusted_guard_result == 'success' && needs.pre_activation.outputs.authorization_digest != '' && needs.pre_activation.outputs.redemption_digest != ''") ||
        workflow.model !== policy.modelSelection.model ||
        workflow["timeout-minutes"] !== policy.limits.timeoutMinutes ||
        workflow["max-turns"] !== policy.limits.maxTurns ||
        workflow.engine["max-continuations"] !== policy.limits.maxContinuations ||
        workflow["max-ai-credits"] !== policy.limits.maxAiCredits ||
        workflow["max-daily-ai-credits"] !== policy.limits.maxDailyAiCredits ||
        workflow.concurrency?.group !==
          `${
            binding.source === "demo"
              ? "agentic-demo"
              : `agentic-${
                  binding.workflowClass === "current-head-comment-review"
                    ? "review"
                    : binding.phase
                }`
          }-\${{ github.repository_id }}-\${{ github.event.issue.number }}` ||
        workflow.concurrency?.["cancel-in-progress"] !== false ||
        workflow.concurrency.queue !== "max" ||
        workflow.on?.reaction !== "none" ||
        workflow.on["status-comment"] !== false ||
        workflow.network === undefined ||
        Object.keys(workflow.network).length !== 0
      ) {
        throw new TypeError(`${workflowPath} runtime limits or guards differ from policy`);
      }
      exactSet(
        Object.keys(workflow.on ?? {}),
        ["slash_command", "roles", "reaction", "status-comment", "permissions", "steps"],
        `${workflowPath} activation keys`
      );
      exactSet(
        workflow.on?.roles ?? [],
        ["admin", "maintainer", "write"],
        `${workflowPath} activation roles`
      );
      const expectedCommand = binding.slashCommand;
      if (workflow.on?.slash_command?.name !== expectedCommand.name) {
        throw new TypeError(`${workflowPath} slash command differs from policy`);
      }
      exactSet(
        workflow.on.slash_command.events ?? [],
        expectedCommand.events,
        `${workflowPath} slash command events`
      );
      exactRecord(
        workflow.on?.permissions,
        {
          contents: "read",
          issues: "read",
          "pull-requests": "read",
          "id-token": "write"
        },
        `${workflowPath} pre-activation permissions`
      );
      exactRecord(
        workflow.jobs?.["pre-activation"]?.outputs,
        binding.workflowClass === "target-free-execution"
          ? {
              authorization_digest:
                "${{ steps.trusted_guard.outputs.authorization_digest }}",
              redemption_digest:
                "${{ steps.trusted_guard.outputs.redemption_digest }}",
              authorized_head_sha:
                "${{ steps.trusted_guard.outputs.authorized_head_sha }}",
              trusted_execution_authorization_b64:
                "${{ steps.trusted_guard.outputs.trusted_execution_authorization_b64 }}",
              trusted_execution_kernel_result_b64:
                "${{ steps.trusted_guard.outputs.trusted_execution_kernel_result_b64 }}",
              model_execution_context_json:
                "${{ steps.trusted_guard.outputs.model_execution_context_json }}"
            }
          : {
              authorization_digest:
                "${{ steps.trusted_guard.outputs.authorization_digest }}",
              redemption_digest:
                "${{ steps.trusted_guard.outputs.redemption_digest }}",
              authorized_head_sha:
                "${{ steps.trusted_guard.outputs.authorized_head_sha }}"
            },
        `${workflowPath} pre-activation outputs`
      );
      exactSet(
        workflow.jobs?.agent?.needs ?? [],
        ["pre-activation"],
        `${workflowPath} agent dependencies`
      );
      exactRecord(
        workflow.permissions,
        {
          contents: "read",
          issues: "read",
          "pull-requests": "read",
          "copilot-requests": "write"
        },
        `${workflowPath} agent permissions`
      );
      if (binding.workflowClass === "target-free-execution") {
        exactRecord(
          workflow.env,
          {
            GITHUB_TOKEN: "",
            GH_TOKEN: "",
            GH_AW_GITHUB_TOKEN: "",
            GH_AW_GITHUB_MCP_SERVER_TOKEN: "",
            GITHUB_MCP_SERVER_TOKEN: ""
          },
          `${workflowPath} agent excluded environment`
        );
      } else if (workflow.env !== undefined) {
        throw new TypeError(
          `${workflowPath} has an unexpected agent environment`
        );
      }
      const safeOutputs = workflow["safe-outputs"];
      if (
        safeOutputs?.staged !== true ||
        safeOutputs["github-token"] !== "${{ secrets.GITHUB_TOKEN }}" ||
        safeOutputs.mentions !== false ||
        (safeOutputs["allowed-github-references"]?.length ?? -1) !== 0 ||
        safeOutputs["max-bot-mentions"] !== 1 ||
        safeOutputs["report-failure-as-issue"] !== false ||
        safeOutputs["report-failed-jobs"] !== false ||
        safeOutputs["missing-tool"] !== false ||
        safeOutputs["missing-data"] !== false ||
        safeOutputs["report-incomplete"] !== false ||
        safeOutputs.noop !== false ||
        safeOutputs["threat-detection"]?.enabled !== true ||
        safeOutputs["threat-detection"]["max-ai-credits"] !==
          policy.limits.maxThreatDetectionAiCredits ||
        (binding.workflowClass === "current-head-comment-review"
          ? typeof safeOutputs["threat-detection"].engine !== "object" ||
            safeOutputs["threat-detection"].engine.id !==
              policy.modelSelection.provider ||
            safeOutputs["threat-detection"].engine.version !== "1.0.79" ||
            canonicalJson(
              safeOutputs["threat-detection"].engine.args
            ) !== canonicalJson(["--no-auto-update"])
          : safeOutputs["threat-detection"].engine !==
            policy.modelSelection.provider)
      ) {
        throw new TypeError(`${workflowPath} safe-output policy differs`);
      }
      const classOutputKey =
        binding.workflowClass === "framing-comment"
          ? "add-comment"
          : binding.workflowClass === "current-head-comment-review"
            ? "submit-pull-request-review"
            : "jobs";
      exactSet(
        Object.keys(safeOutputs),
        [
          "staged",
          "github-token",
          "mentions",
          "allowed-github-references",
          "max-bot-mentions",
          "report-failure-as-issue",
          "report-failed-jobs",
          "missing-tool",
          "missing-data",
          "report-incomplete",
          "noop",
          classOutputKey,
          "threat-detection"
        ],
        `${workflowPath} safe-output keys`
      );
      exactSet(
        Object.keys(safeOutputs["threat-detection"]),
        ["enabled", "max-ai-credits", "engine"],
        `${workflowPath} threat-detection keys`
      );
      if (
        binding.workflowClass === "current-head-comment-review" &&
        typeof safeOutputs["threat-detection"].engine === "object"
      ) {
        exactSet(
          Object.keys(safeOutputs["threat-detection"].engine),
          ["id", "version", "args"],
          `${workflowPath} threat-detection engine keys`
        );
      }
      const expectedTarget =
        "${{ github.event.issue.number }}";
      if (binding.workflowClass === "framing-comment") {
        const comment = safeOutputs["add-comment"];
        exactSet(
          Object.keys(comment ?? {}),
          ["max", "target", "target-repo"],
          `${workflowPath} framing output keys`
        );
        if (
          comment?.max !== 1 ||
          comment.target !== expectedTarget ||
          comment["target-repo"] !== "${{ github.repository }}" ||
          safeOutputs["submit-pull-request-review"] !== undefined
        ) {
          throw new TypeError(`${workflowPath} is not comment-only framing`);
        }
        const preSteps = workflow["pre-steps"] ?? [];
        const trustedCheckout = preSteps[0];
        if (
          workflow.checkout !== false ||
          preSteps.length !== 1 ||
          trustedCheckout?.uses !== "actions/checkout@v7" ||
          trustedCheckout.with?.ref !== "${{ github.workflow_sha }}" ||
          trustedCheckout.with?.["persist-credentials"] !== false
        ) {
          throw new TypeError(
            `${workflowPath} must use only the trusted workflow checkout`
          );
        }
      } else if (binding.workflowClass === "current-head-comment-review") {
        const review = safeOutputs["submit-pull-request-review"];
        exactSet(
          Object.keys(review ?? {}),
          ["max", "allowed-events", "target", "target-repo", "footer"],
          `${workflowPath} review output keys`
        );
        exactSet(
          review?.["allowed-events"] ?? [],
          ["COMMENT"],
          `${workflowPath} review events`
        );
        if (
          review?.max !== 1 ||
          review.target !== expectedTarget ||
          review["target-repo"] !== "${{ github.repository }}" ||
          review.footer !== "always" ||
          safeOutputs["add-comment"] !== undefined
        ) {
          throw new TypeError(`${workflowPath} is not comment-only review`);
        }
        const preSteps = workflow["pre-steps"] ?? [];
        const preAgentSteps = workflow["pre-agent-steps"] ?? [];
        const trustedCheckout = preSteps[0];
        const headCheck = preSteps[1];
        const workspaceGuard = preAgentSteps[0];
        exactSet(
          Object.keys(trustedCheckout ?? {}),
          ["name", "uses", "with"],
          `${workflowPath} trusted review checkout keys`
        );
        exactSet(
          Object.keys(trustedCheckout?.with ?? {}),
          ["ref", "persist-credentials"],
          `${workflowPath} trusted review checkout inputs`
        );
        exactSet(
          Object.keys(headCheck ?? {}),
          ["name", "uses", "env", "with"],
          `${workflowPath} exact-head guard keys`
        );
        exactSet(
          Object.keys(headCheck?.env ?? {}),
          ["AUTHORIZED_HEAD_SHA", "PULL_REQUEST_NUMBER"],
          `${workflowPath} exact-head guard environment`
        );
        exactSet(
          Object.keys(headCheck?.with ?? {}),
          ["github-token", "script"],
          `${workflowPath} exact-head guard inputs`
        );
        exactSet(
          Object.keys(workspaceGuard ?? {}),
          ["name", "uses", "with"],
          `${workflowPath} workspace guard keys`
        );
        exactSet(
          Object.keys(workspaceGuard?.with ?? {}),
          ["script"],
          `${workflowPath} workspace guard inputs`
        );
        if (
          workflow.checkout !== false ||
          preSteps.length !== 2 ||
          preAgentSteps.length !== 1 ||
          trustedCheckout?.uses !== "actions/checkout@v7" ||
          trustedCheckout.with?.ref !== "${{ github.workflow_sha }}" ||
          trustedCheckout.with?.["persist-credentials"] !== false ||
          headCheck?.uses !== "actions/github-script@v9" ||
          headCheck.env?.AUTHORIZED_HEAD_SHA !==
            "${{ needs.pre_activation.outputs.authorized_head_sha }}" ||
          headCheck.env.PULL_REQUEST_NUMBER !==
            "${{ github.event.issue.number }}" ||
          headCheck.with?.["github-token"] !== "${{ github.token }}" ||
          typeof headCheck.with.script !== "string" ||
          !isExactReviewHeadScript(headCheck.with.script) ||
          !headCheck.with.script.includes(
            "before.data.head.sha !== authorizedHead"
          ) ||
          !headCheck.with.script.includes("compareCommitsWithBasehead") ||
          !headCheck.with.script.includes(
            "after.data.head.sha !== authorizedHead"
          ) ||
          !headCheck.with.script.includes(
            'const evidenceSource = "/tmp/gh-aw/authorized-review-evidence.json"'
          ) ||
          workspaceGuard?.name !==
            "Restrict agent workspace to declared review inputs" ||
          workspaceGuard.uses !== "actions/github-script@v9" ||
          typeof workspaceGuard.with?.script !== "string" ||
          !isExactReviewWorkspaceScript(
            workspaceGuard.with.script,
            binding.agent,
            binding.skill
          ) ||
          !workspaceGuard.with.script.includes(
            `".github/agents/${binding.agent}.agent.md"`
          ) ||
          !workspaceGuard.with.script.includes(
            `".github/skills/${binding.skill}/SKILL.md"`
          ) ||
          !workspaceGuard.with.script.includes(
            '".github/skills/authority-refusal/SKILL.md"'
          ) ||
          !workspaceGuard.with.script.includes(
            "fs.rmSync(path.join(workspace, entry)"
          ) ||
          !workspaceGuard.with.script.includes(
            '"/tmp/gh-aw/.github"'
          ) ||
          !workspaceGuard.with.script.includes(
            '"/tmp/gh-aw/base"'
          ) ||
          !workspaceGuard.with.script.includes(
            '"/tmp/gh-aw/aw-prompts/prompt-template.txt"'
          ) ||
          !workspaceGuard.with.script.includes(
            '"/tmp/gh-aw/aw-prompts/prompt-import-tree.json"'
          ) ||
          !workspaceGuard.with.script.includes(
            'const expectedFiles = ['
          ) ||
          workflow.tools?.bash !== false ||
          workflow.tools.edit !== false ||
          workflow.tools["cli-proxy"] !== false ||
          headCheck.with.script.includes("exec.getExecOutput") ||
          workflow["pre-steps"]?.some(
            (step) =>
              step.with?.ref ===
              "${{ needs.pre_activation.outputs.authorized_head_sha }}"
          )
        ) {
          throw new TypeError(
            `${workflowPath} does not preserve API-only current-head review`
          );
        }
      } else {
        const preSteps = workflow["pre-steps"] ?? [];
        const trustedCheckout = preSteps[0];
        const patchJob = safeOutputs.jobs?.["stage-implementation-patch"];
        const patchStep = patchJob?.steps?.find(
          (step) =>
            step.run === "node dist/scripts/runtime-execution-bridge.js"
        );
        const transferStep = patchJob?.steps?.find(
          (step) =>
            step.name === "Transfer the signed trusted execution bundle"
        );
        const deliveryStep = patchJob?.steps?.find(
          (step) =>
            step.name === "Invoke the trusted execution delivery service"
        );
        const onSteps = workflow.on?.steps ?? [];
        const sealedAuthorization = onSteps.find(
          (step) =>
            step.name ===
            "Seal the trusted execution authorization for the post-agent bridge"
        );
        const transferredAuthorization = onSteps.find(
          (step) => step.name === "Transfer the trusted execution authorization"
        );
        exactSet(
          Object.keys(safeOutputs.jobs ?? {}),
          ["stage-implementation-patch"],
          `${workflowPath} custom safe-output jobs`
        );
        exactSet(
          Object.keys(patchJob ?? {}),
          ["description", "runs-on", "if", "permissions", "inputs", "steps"],
          `${workflowPath} custom safe-output job keys`
        );
        const patchSteps = patchJob?.steps ?? [];
        const expectedPatchStepNames = [
          "Retrieve the trusted execution authorization",
          "Check out the trusted runtime and authorized base history",
          "Set up the pinned Node runtime",
          "Install locked dependencies",
          "Build the trusted execution bridge",
          "Validate patch and stage trusted delivery handoff",
          "Transfer the signed trusted execution bundle",
          "Invoke the trusted execution delivery service"
        ];
        const retrieveStep = patchSteps[0];
        const patchCheckout = patchSteps[1];
        const setupNode = patchSteps[2];
        const installDependencies = patchSteps[3];
        const buildBridge = patchSteps[4];
        for (const [step, keys, subject] of [
          [retrieveStep, ["name", "uses", "with"], "authorization download"],
          [patchCheckout, ["name", "uses", "with"], "trusted checkout"],
          [setupNode, ["name", "uses", "with"], "Node setup"],
          [installDependencies, ["name", "run"], "dependency install"],
          [buildBridge, ["name", "run"], "bridge build"],
          [patchStep, ["name", "id", "env", "run"], "trusted patch bridge"],
          [transferStep, ["name", "id", "uses", "with"], "bundle upload"],
          [deliveryStep, ["name", "if", "run", "env"], "delivery invocation"]
        ] as const) {
          exactSet(
            Object.keys(step ?? {}),
            keys,
            `${workflowPath} ${subject} step keys`
          );
        }
        exactSet(
          Object.keys(retrieveStep?.with ?? {}),
          ["name", "path"],
          `${workflowPath} authorization download inputs`
        );
        exactSet(
          Object.keys(patchCheckout?.with ?? {}),
          ["ref", "fetch-depth", "persist-credentials"],
          `${workflowPath} trusted checkout inputs`
        );
        exactSet(
          Object.keys(setupNode?.with ?? {}),
          ["node-version", "cache"],
          `${workflowPath} Node setup inputs`
        );
        exactSet(
          Object.keys(transferStep?.with ?? {}),
          ["name", "path", "if-no-files-found", "retention-days"],
          `${workflowPath} bundle upload inputs`
        );
        for (const input of Object.values(patchJob?.inputs ?? {})) {
          if (input.required !== true || input.type !== "string") {
            throw new TypeError(
              `${workflowPath} custom safe-output inputs are not exact required strings`
            );
          }
        }
        if (
          workflow.checkout !== false ||
          preSteps.length !== 1 ||
          trustedCheckout?.uses !== "actions/checkout@v7" ||
          trustedCheckout.with?.ref !== "${{ github.workflow_sha }}" ||
          trustedCheckout.with?.["persist-credentials"] !== false ||
          safeOutputs["add-comment"] !== undefined ||
          safeOutputs["submit-pull-request-review"] !== undefined ||
          patchSteps.map((step) => step.name).join("\n") !==
            expectedPatchStepNames.join("\n") ||
          retrieveStep?.uses !== "actions/download-artifact@v8" ||
          retrieveStep.with?.name !==
            `${binding.workflow}-authorization-\${{ github.run_id }}-\${{ github.run_attempt }}` ||
          retrieveStep.with.path !==
            "${{ runner.temp }}/agentic-execution-authorization" ||
          patchCheckout?.uses !== "actions/checkout@v7" ||
          patchCheckout.with?.ref !== "${{ github.workflow_sha }}" ||
          patchCheckout.with["fetch-depth"] !== 0 ||
          patchCheckout.with["persist-credentials"] !== false ||
          setupNode?.uses !== "actions/setup-node@v7" ||
          setupNode.with?.["node-version"] !== 24 ||
          setupNode.with.cache !== "npm" ||
          installDependencies?.run !== "npm ci --ignore-scripts" ||
          buildBridge?.run !== "npm run build" ||
          patchJob?.["runs-on"] !== "ubuntu-slim" ||
          patchJob.if !==
            "needs.detection.outputs.detection_success == 'true' && needs.detection.outputs.detection_conclusion == 'success'" ||
          patchJob.permissions?.contents !== "read" ||
          patchJob.permissions?.["id-token"] !== "write" ||
          Object.keys(patchJob.permissions ?? {}).length !== 2 ||
          Object.keys(patchJob.inputs ?? {}).sort().join(",") !==
            "execution_grant_digest,patch_json,planning_artifact_digest" ||
          patchStep?.id !== "trusted_execution_bridge" ||
          patchStep?.env?.TRUSTED_EXECUTION_AUTHORIZATION_PATH !==
            "${{ runner.temp }}/agentic-execution-authorization/authorization.json" ||
          patchStep.env.TRUSTED_KERNEL_RESULT_PATH !==
            "${{ runner.temp }}/agentic-execution-authorization/kernel-result.json" ||
          patchStep.env.GH_AW_DETECTION_SUCCESS !==
            "${{ needs.detection.outputs.detection_success }}" ||
          patchStep.env.GH_AW_DETECTION_CONCLUSION !==
            "${{ needs.detection.outputs.detection_conclusion }}" ||
          patchStep.env.AGENTIC_EVIDENCE_SIGNER_URL !==
            "${{ vars.AGENTIC_EVIDENCE_SIGNER_URL }}" ||
          patchStep.env.AGENTIC_EVIDENCE_SIGNER_AUDIENCE !==
            "${{ vars.AGENTIC_EVIDENCE_SIGNER_AUDIENCE }}" ||
          patchStep.env.AGENTIC_REDEEMER_SIGNING_KEY_ID !==
            "${{ vars.AGENTIC_REDEEMER_SIGNING_KEY_ID }}" ||
          patchStep.env.AGENTIC_REDEEMER_SIGNING_PUBLIC_KEY !==
            "${{ vars.AGENTIC_REDEEMER_SIGNING_PUBLIC_KEY }}" ||
          patchStep.env.AGENTIC_EVIDENCE_SIGNING_KEY_ID !==
            "${{ vars.AGENTIC_EVIDENCE_SIGNING_KEY_ID }}" ||
          patchStep.env.AGENTIC_EVIDENCE_SIGNING_PUBLIC_KEY !==
            "${{ vars.AGENTIC_EVIDENCE_SIGNING_PUBLIC_KEY }}" ||
          (binding.source === "demo"
            ? patchStep.env.RUNTIME_DEMO_PROJECT_ID !==
                binding.demoProjectId ||
              patchStep.env.RUNTIME_STAGE_ID !== binding.stageId ||
              Object.keys(patchStep.env).length !== 12
            : patchStep.env.RUNTIME_DEMO_PROJECT_ID !== undefined ||
              patchStep.env.RUNTIME_STAGE_ID !== undefined ||
              Object.keys(patchStep.env).length !== 10) ||
          transferStep?.id !== "trusted_execution_bundle" ||
          transferStep.uses !== "actions/upload-artifact@v7" ||
          transferStep.with?.name !==
            `${binding.workflow}-bundle-\${{ github.run_id }}-\${{ github.run_attempt }}` ||
          transferStep.with.path !==
            "${{ steps.trusted_execution_bridge.outputs.delivery_handoff_path }}" ||
          transferStep.with["if-no-files-found"] !== "error" ||
          transferStep.with["retention-days"] !== 1 ||
          deliveryStep?.if !==
            "vars.AGENTIC_EXECUTION_DELIVERY_URL != '' && vars.AGENTIC_EXECUTION_DELIVERY_AUDIENCE != ''" ||
          deliveryStep.run !==
            "node dist/scripts/runtime-execution-delivery-request.js" ||
          deliveryStep.env?.AGENTIC_EXECUTION_DELIVERY_URL !==
            "${{ vars.AGENTIC_EXECUTION_DELIVERY_URL }}" ||
          deliveryStep.env.AGENTIC_EXECUTION_DELIVERY_AUDIENCE !==
            "${{ vars.AGENTIC_EXECUTION_DELIVERY_AUDIENCE }}" ||
          deliveryStep.env.TRUSTED_EXECUTION_ARTIFACT_ID !==
            "${{ steps.trusted_execution_bundle.outputs.artifact-id }}" ||
          deliveryStep.env.TRUSTED_EXECUTION_ARTIFACT_DIGEST !==
            "${{ steps.trusted_execution_bundle.outputs.artifact-digest }}" ||
          deliveryStep.env.TRUSTED_EXECUTION_ARTIFACT_NAME !==
            `${binding.workflow}-bundle-\${{ github.run_id }}-\${{ github.run_attempt }}` ||
          deliveryStep.env.TRUSTED_EXECUTION_BUNDLE_DIGEST !==
            "${{ steps.trusted_execution_bridge.outputs.delivery_handoff_digest }}" ||
          Object.keys(deliveryStep.env).length !== 6 ||
          sealedAuthorization?.run === undefined ||
          !sealedAuthorization.run.includes("base64 --decode") ||
          !sealedAuthorization.run.includes("kernel-result.json") ||
          transferredAuthorization?.uses !== "actions/upload-artifact@v7" ||
          transferredAuthorization.with?.name !==
            `${binding.workflow}-authorization-\${{ github.run_id }}-\${{ github.run_attempt }}` ||
          transferredAuthorization.with?.path !==
            "${{ runner.temp }}/agentic-execution-authorization"
        ) {
          throw new TypeError(
            `${workflowPath} execution must be target-free with no GitHub tools or mutation output`
          );
        }
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  const boundWorkflows = new Set(
    runtimeBindings.map((binding) => `${binding.workflow}.md`)
  );
  const workflowEntries = await readdir(".github/workflows");
  const agenticSources = new Set(
    workflowEntries.filter((entry) => entry.endsWith(".md"))
  );
  const reviewedNonAgenticWorkflows = new Set<string>(
    REVIEWED_NON_AGENTIC_WORKFLOW_FILES
  );
  for (const entry of workflowEntries) {
    if (entry.endsWith(".md") && !boundWorkflows.has(entry)) {
      errors.push(`unbound Agentic Workflow source .github/workflows/${entry}`);
    }
    if (
      (entry.endsWith(".yml") || entry.endsWith(".yaml")) &&
      !reviewedNonAgenticWorkflows.has(entry) &&
      (!entry.endsWith(".lock.yml") ||
        !agenticSources.has(entry.replace(/\.lock\.yml$/u, ".md")))
    ) {
      errors.push(
        `executable workflow .github/workflows/${entry} has no Agentic Workflow Markdown source`
      );
    }
  }
}

const boundDomainAgents = new Set<string>();
for (const definition of domainDefinitions) {
  try {
    const capability = capabilityByReference(
      registry,
      definition.capabilityBindings.execution
    );
    const agent = await readFrontmatter<AgentFrontmatter>(definition.agent);
    const skillPath = `.github/skills/${definition.skill}/SKILL.md`;
    const skill = await readFrontmatter<SkillFrontmatter>(skillPath);
    if (
      !capability.allowedPhases.includes("execution") ||
      agent.metadata?.capability !==
        definition.capabilityBindings.execution ||
      agent.metadata?.["framework-phase"] !== "execution" ||
      !definition.roles.includes(
        agent.metadata?.["framework-role"] ?? ""
      ) ||
      skill.metadata?.capability !==
        definition.capabilityBindings.execution ||
      skill.metadata?.phase !== "execution" ||
      skill.metadata?.role !== agent.metadata?.["framework-role"] ||
      agent["user-invocable"] !== false ||
      agent["disable-model-invocation"] !== true ||
      !Array.isArray(agent.tools) ||
      !Array.isArray(skill["allowed-tools"])
    ) {
      throw new TypeError(
        `${definition.id} runtime agent or skill differs from its trusted profile`
      );
    }
    exactSet(agent.tools, capability.access.tools, definition.agent);
    exactSet(
      skill["allowed-tools"],
      capability.access.tools,
      skillPath
    );
    boundDomainAgents.add(path.basename(definition.agent));
  } catch (error) {
    errors.push(
      `${definition.id} runtime profile: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

for (const entry of await readdir(".github/agents")) {
  if (entry.endsWith(".agent.md") && !runtimeBindings.some(
    (binding) => `${binding.agent}.agent.md` === entry
  ) && !boundDomainAgents.has(entry)) {
    errors.push(`unbound runtime agent .github/agents/${entry}`);
  }
}

if (
  policy.access.mcpEnabled ||
  policy.access.mcpServers.length > 0 ||
  policy.access.mcpTools.length > 0 ||
  policy.access.networkDestinations.length > 0 ||
  policy.access.secretNames.length > 0 ||
  policy.access.patFallbackAllowed
) {
  errors.push("runtime policy must keep MCP, network, secrets, and PAT fallback disabled");
}
if (
  policy.protectedFiles.mode !== "blocked" ||
  policy.protectedFiles.paths.length === 0
) {
  errors.push("runtime protected-file policy must be explicitly blocked");
}

if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exitCode = 1;
} else {
  console.log(
    `Validated ${policy.phaseBindings.length} core role bindings, ${runtimeBindings.filter((binding) => binding.source === "demo").length} installed demo stage bindings, and ${domainDefinitions.length} domain profiles for ${(policy as CopilotRuntimePolicy).toolchain.ghAwVersion}.`
  );
}
