import { createHash } from "node:crypto";

const REVIEW_HEAD_SCRIPT_SHA256 =
  "ba45060591ed3f9e5c2c1863c87196611513052c347366cadb678f1f529d7789";
const REVIEW_WORKSPACE_SCRIPT_SHA256 =
  "57fbe1a636cfefa5d50400c9d22f8fa32864898928ff68a6d3f54bdbe04ea96f";
const EXECUTION_AUTHORIZATION_SEAL_SCRIPT_SHA256 =
  "bf84831a613fd043e442c255926b43b5db063e9323c0aa3f5b7b775c11cc96f5";

export const PINNED_WORKFLOW_ACTIONS = [
  {
    repo: "actions/cache/restore",
    sha: "55cc8345863c7cc4c66a329aec7e433d2d1c52a9",
    version: "v6.1.0"
  },
  {
    repo: "actions/cache/save",
    sha: "55cc8345863c7cc4c66a329aec7e433d2d1c52a9",
    version: "v6.1.0"
  },
  {
    repo: "actions/checkout",
    sha: "3d3c42e5aac5ba805825da76410c181273ba90b1",
    version: "v7.0.1"
  },
  {
    repo: "actions/download-artifact",
    sha: "3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
    version: "v8.0.1"
  },
  {
    repo: "actions/github-script",
    sha: "3a2844b7e9c422d3c10d287c895573f7108da1b3",
    version: "v9.0.0"
  },
  {
    repo: "actions/setup-node",
    sha: "820762786026740c76f36085b0efc47a31fe5020",
    version: "v7.0.0"
  },
  {
    repo: "actions/upload-artifact",
    sha: "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    version: "v7.0.1"
  },
  {
    repo: "github/gh-aw/actions/setup",
    sha: "48e5fa3ff52294d91d97715017a9f8693a48387f",
    version: "48e5fa3ff52294d91d97715017a9f8693a48387f"
  }
] as const;

function sha256(value: string): string {
  const canonical = value.endsWith("\n") ? value.slice(0, -1) : value;
  return createHash("sha256").update(canonical).digest("hex");
}

export function isExactReviewHeadScript(value: string): boolean {
  return sha256(value) === REVIEW_HEAD_SCRIPT_SHA256;
}

export function isExactExecutionAuthorizationSealScript(
  value: string
): boolean {
  return sha256(value) === EXECUTION_AUTHORIZATION_SEAL_SCRIPT_SHA256;
}

export function isExactReviewWorkspaceScript(
  value: string,
  agent: string,
  skill: string
): boolean {
  const agentPath = `".github/agents/${agent}.agent.md"`;
  const skillPath = `".github/skills/${skill}/SKILL.md"`;
  if (
    value.includes("__AGENT__") ||
    value.includes("__SKILL__") ||
    value.split(agentPath).length - 1 !== 2 ||
    value.split(skillPath).length - 1 !== 2
  ) {
    return false;
  }
  const normalized = value
    .replaceAll(
      agentPath,
      '".github/agents/__AGENT__.agent.md"'
    )
    .replaceAll(
      skillPath,
      '".github/skills/__SKILL__/SKILL.md"'
    );
  return sha256(normalized) === REVIEW_WORKSPACE_SCRIPT_SHA256;
}
