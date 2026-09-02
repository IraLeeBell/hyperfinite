#!/usr/bin/env node

import { appendFile, readFile } from "node:fs/promises";
import process from "node:process";

import { canonicalJson, digest } from "../src/canonical.js";
import {
  validateBoundStageAgentSelectionGrant
} from "../src/demo-agent-selection.js";
import {
  assertTrustedDemoRuntimeRegistration
} from "../src/demo-portfolio.js";
import {
  bindKernelAuthorization,
  githubLastPage,
  redeemRuntimeAuthorization,
  runtimeMaximumReservation,
  validateStableRuntimeStateObservation,
  validateRuntimePreActivation,
  verifyRuntimeAuthorizationSignature,
  verifyRuntimeStateSignature,
  type RuntimeActivationRequest,
  type RuntimeAuthorizationCandidate
} from "../src/copilot-runtime.js";
import { loadTrustedDemoRuntimeBindingForSelection } from "./demo-runtime-metadata.js";
import type {
  CopilotRuntimeAuthorization,
  CopilotRuntimeState,
  Digest,
  KernelResult
} from "../src/types.js";
import { assertDocument } from "../src/validation.js";

interface GitHubComment {
  readonly id: number;
  readonly body: string | null;
  readonly user: { readonly id: number } | null;
  readonly performed_via_github_app: { readonly id: number } | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface GitHubPage<T> {
  readonly value: T;
  readonly link: string | null;
  readonly etag: string;
}

interface TrustedStateObservation {
  readonly state: CopilotRuntimeState;
  readonly applicationId: number;
  readonly authorId: number;
  readonly commentId: number;
  readonly commentUpdatedAt: string;
  readonly collectionEtag: string;
  readonly comments: readonly GitHubComment[];
}

const markerPattern =
  /<!-- agentic-framework-runtime-state\s*\n([\s\S]*?)\n-->/u;
const selectionMarkerPattern =
  /<!-- agentic-framework-stage-agent-selection\s*\n([\s\S]*?)\n-->/u;

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new TypeError(`required environment value ${name} is missing`);
  }
  return value.trim();
}

function positiveInteger(name: string): number {
  const value = Number(required(name));
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function digestValue(name: string): Digest {
  const value = required(name);
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`${name} must be a sha256 digest`);
  }
  return value as Digest;
}

function allowedActorIds(): readonly number[] {
  const values = required("AGENTIC_ALLOWED_ACTOR_IDS")
    .split(",")
    .map((value) => Number(value.trim()));
  if (
    values.length === 0 ||
    values.some((value) => !Number.isSafeInteger(value) || value < 1)
  ) {
    throw new TypeError(
      "AGENTIC_ALLOWED_ACTOR_IDS must contain positive comma-separated IDs"
    );
  }
  return [...new Set(values)];
}

async function github<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    redirect: "error",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${required("GITHUB_TOKEN")}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...init.headers
    }
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${path} failed with ${response.status}`);
  }
  return (await response.json()) as T;
}

async function githubPage<T>(path: string): Promise<GitHubPage<T>> {
  const response = await fetch(`https://api.github.com${path}`, {
    redirect: "error",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${required("GITHUB_TOKEN")}`,
      "X-GitHub-Api-Version": "2022-11-28"
    }
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${path} failed with ${response.status}`);
  }
  const etag = response.headers.get("etag");
  if (etag === null || etag.length === 0) {
    throw new TypeError(`GitHub API ${path} returned no ETag`);
  }
  return {
    value: (await response.json()) as T,
    link: response.headers.get("link"),
    etag
  };
}

function verifyStateSignature(state: CopilotRuntimeState): boolean {
  return verifyRuntimeStateSignature(
    state,
    required("AGENTIC_STATE_SIGNING_KEY_ID"),
    required("AGENTIC_STATE_SIGNING_PUBLIC_KEY")
  );
}

function parseTrustedState(
  comments: readonly GitHubComment[],
  applicationId: number,
  authorId: number,
  collectionEtag: string
): TrustedStateObservation {
  const candidates = comments
    .filter(
      (comment) =>
        comment.performed_via_github_app?.id === applicationId &&
        comment.user?.id === authorId &&
        comment.created_at === comment.updated_at &&
        comment.body !== null &&
        markerPattern.test(comment.body)
    )
    .sort((left, right) => right.id - left.id);
  const comment = candidates[0];
  if (comment?.body === null || comment?.body === undefined) {
    throw new TypeError("no trusted runtime state marker was found");
  }
  const match = markerPattern.exec(comment.body);
  if (match?.[1] === undefined) {
    throw new TypeError("trusted runtime state marker is malformed");
  }
  return {
    state: assertDocument(
      "CopilotRuntimeState",
      JSON.parse(match[1]) as unknown
    ),
    applicationId,
    authorId,
    commentId: comment.id,
    commentUpdatedAt: comment.updated_at,
    collectionEtag,
    comments
  };
}

function trustedSelectionGrant(input: {
  readonly observation: TrustedStateObservation;
  readonly expectedDigest: Digest;
  readonly expected: Parameters<
    typeof validateBoundStageAgentSelectionGrant
  >[0]["expected"];
  readonly evaluatedAt: string;
}): void {
  const candidates = input.observation.comments.filter(
    (comment) =>
      comment.performed_via_github_app?.id ===
        input.observation.applicationId &&
      comment.user?.id === input.observation.authorId &&
      comment.created_at === comment.updated_at &&
      comment.body !== null &&
      selectionMarkerPattern.test(comment.body)
  );
  const matching = candidates.flatMap((comment) => {
    const match = selectionMarkerPattern.exec(comment.body ?? "");
    if (match?.[1] === undefined) {
      throw new TypeError("trusted stage-agent selection marker is malformed");
    }
    const grant = assertDocument(
      "SignedStageAgentSelectionGrant",
      JSON.parse(match[1]) as unknown
    );
    return grant.contentDigest === input.expectedDigest ? [grant] : [];
  });
  if (matching.length !== 1) {
    throw new TypeError(
      "trusted runtime state does not identify one exact stage-agent selection grant"
    );
  }
  validateBoundStageAgentSelectionGrant({
    grant: matching[0],
    expectedDigest: input.expectedDigest,
    expectedKeyId: required(
      "AGENTIC_STAGE_AGENT_SELECTION_SIGNING_KEY_ID"
    ),
    encodedPublicKey: required(
      "AGENTIC_STAGE_AGENT_SELECTION_SIGNING_PUBLIC_KEY"
    ),
    evaluatedAt: input.evaluatedAt,
    expected: input.expected
  });
}

async function readStableTrustedState(
  owner: string,
  repository: string,
  number: number,
  applicationId: number,
  authorId: number
): Promise<TrustedStateObservation> {
  const pagePath = (page: number): string =>
    `/repos/${owner}/${repository}/issues/${number}/comments?per_page=100&page=${page}`;
  const initialFirst = await githubPage<readonly GitHubComment[]>(pagePath(1));
  const lastPage = githubLastPage(initialFirst.link);
  const initialLast =
    lastPage === 1
      ? initialFirst
      : await githubPage<readonly GitHubComment[]>(pagePath(lastPage));
  const initial = parseTrustedState(
    initialLast.value,
    applicationId,
    authorId,
    initialLast.etag
  );

  const confirmedFirst = await githubPage<readonly GitHubComment[]>(pagePath(1));
  if (
    githubLastPage(confirmedFirst.link) !== lastPage ||
    confirmedFirst.etag !== initialFirst.etag
  ) {
    throw new TypeError("GitHub comments changed during trusted-state pagination");
  }
  const confirmedLast =
    lastPage === 1
      ? confirmedFirst
      : await githubPage<readonly GitHubComment[]>(pagePath(lastPage));
  const confirmed = parseTrustedState(
    confirmedLast.value,
    applicationId,
    authorId,
    confirmedLast.etag
  );
  validateStableRuntimeStateObservation(initial, confirmed);
  return confirmed;
}

function trustedHttpsUrl(value: string, subject: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0
  ) {
    throw new TypeError(`${subject} must be an HTTPS URL without credentials or fragment`);
  }
  return url;
}

async function oidcToken(audience: string): Promise<string> {
  const requestUrl = trustedHttpsUrl(
    required("ACTIONS_ID_TOKEN_REQUEST_URL"),
    "ACTIONS_ID_TOKEN_REQUEST_URL"
  );
  if (!requestUrl.hostname.endsWith(".actions.githubusercontent.com")) {
    throw new TypeError("OIDC token endpoint is not a GitHub Actions host");
  }
  requestUrl.searchParams.set("audience", audience);
  const response = await fetch(requestUrl, {
    redirect: "error",
    headers: {
      Authorization: `Bearer ${required("ACTIONS_ID_TOKEN_REQUEST_TOKEN")}`
    }
  });
  if (!response.ok) {
    throw new Error(`GitHub OIDC request failed with ${response.status}`);
  }
  const body = (await response.json()) as { readonly value?: unknown };
  if (typeof body.value !== "string" || body.value.length === 0) {
    throw new TypeError("GitHub OIDC response contains no token");
  }
  return body.value;
}

let redeemedKernelResult: KernelResult | null = null;

async function redeemCandidate(
  candidate: RuntimeAuthorizationCandidate
): Promise<unknown> {
  const url = trustedHttpsUrl(
    required("AGENTIC_REDEEMER_URL"),
    "AGENTIC_REDEEMER_URL"
  );
  const audience = required("AGENTIC_REDEEMER_AUDIENCE");
  const response = await fetch(url, {
    method: "POST",
    redirect: "error",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${await oidcToken(audience)}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ candidate })
  });
  if (!response.ok) {
    throw new Error(`trusted authorization redeemer failed with ${response.status}`);
  }
  const body = (await response.json()) as {
    readonly authorization?: unknown;
    readonly kernelResult?: unknown;
  };
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    !Object.hasOwn(body, "authorization") ||
    !Object.hasOwn(body, "kernelResult")
  ) {
    throw new TypeError(
      "trusted authorization redeemer must return authorization and applied Kernel result"
    );
  }
  redeemedKernelResult = body.kernelResult as KernelResult;
  return body.authorization;
}

const [owner, repository] = required("GITHUB_REPOSITORY").split("/");
if (owner === undefined || repository === undefined) {
  throw new TypeError("GITHUB_REPOSITORY must be owner/name");
}
const number = positiveInteger("WORK_ITEM_NUMBER");
const kind = required("WORK_ITEM_KIND");
if (kind !== "issue" && kind !== "pull-request") {
  throw new TypeError("WORK_ITEM_KIND must be issue or pull-request");
}
if ((process.env.AW_CONTEXT ?? "").trim().length > 0) {
  throw new TypeError("trusted command activation does not accept aw_context");
}
const workflowSha = required("GITHUB_WORKFLOW_SHA");
if (workflowSha !== required("GITHUB_SHA")) {
  throw new TypeError("checked-out guard does not match the workflow source SHA");
}
const applicationId = positiveInteger("AGENTIC_APP_ID");
const authorId = positiveInteger("AGENTIC_APP_ACTOR_ID");
const projectNodeId = required("AGENTIC_PROJECT_NODE_ID");
const repositoryData = await github<{
  readonly id: number;
  readonly full_name: string;
  readonly default_branch: string;
}>(`/repos/${owner}/${repository}`);
const workItem = await github<{
  readonly node_id: string;
  readonly head?: { readonly sha?: string };
}>(
  kind === "issue"
    ? `/repos/${owner}/${repository}/issues/${number}`
    : `/repos/${owner}/${repository}/pulls/${number}`
);
const permission = await github<{
  readonly permission: "admin" | "write" | "read" | "none";
}>(`/repos/${owner}/${repository}/collaborators/${required("GITHUB_ACTOR")}/permission`);
const trustedState = await readStableTrustedState(
  owner,
  repository,
  number,
  applicationId,
  authorId
);
const currentHead =
  kind === "pull-request"
    ? workItem.head?.sha ??
      (() => {
        throw new TypeError("pull request head SHA is missing");
      })()
    : null;
const policy = assertDocument(
  "CopilotRuntimePolicy",
  JSON.parse(
    await readFile("config/v1alpha1/copilot-runtime-policy.json", "utf8")
  ) as unknown
);
const kernelPolicy = assertDocument(
  "ControlPolicy",
  JSON.parse(await readFile("config/v1alpha1/policy.json", "utf8")) as unknown
);
const lifecycle = assertDocument(
  "LifecycleGraph",
  JSON.parse(await readFile("config/v1alpha1/lifecycle.json", "utf8")) as unknown
);
const baseRegistry = assertDocument(
  "CapabilityRegistry",
  JSON.parse(
    await readFile("config/v1alpha1/capability-registry.json", "utf8")
  ) as unknown
);
const request: RuntimeActivationRequest = {
  enabled: required("AGENTIC_RUNTIME_ENABLED") === "true",
  eventName: required("GITHUB_EVENT_NAME") as RuntimeActivationRequest["eventName"],
  eventAction: required("GITHUB_EVENT_ACTION") as RuntimeActivationRequest["eventAction"],
  actorId: positiveInteger("GITHUB_ACTOR_ID"),
  actorLogin: required("GITHUB_ACTOR"),
  actorIsBot: /\[bot\]$/u.test(required("GITHUB_ACTOR")),
  actorPermission: permission.permission,
  repositoryId: repositoryData.id,
  repositoryFullName: repositoryData.full_name,
  workItemKind: kind,
  workItemNumber: number,
  workItemNodeId: workItem.node_id,
  projectNodeId,
  projectItemNodeId: trustedState.state.projectItemNodeId,
  bindingDigest: trustedState.state.bindingDigest,
  kernelBindingDigest: trustedState.state.kernelBindingDigest,
  workAccordSourceDigest: trustedState.state.workAccordSourceDigest,
  phase: required("RUNTIME_PHASE") as RuntimeActivationRequest["phase"],
  role: required("RUNTIME_ROLE") as RuntimeActivationRequest["role"],
  capability: required("RUNTIME_CAPABILITY"),
  workflowId: required("RUNTIME_WORKFLOW_ID"),
  workflowRef: required("GITHUB_WORKFLOW_REF"),
  workflowSha,
  defaultBranch: repositoryData.default_branch,
  runId: positiveInteger("GITHUB_RUN_ID"),
  runAttempt: positiveInteger("GITHUB_RUN_ATTEMPT"),
  workAccordDigest: digestValue("WORK_ACCORD_DIGEST"),
  policyDigest: digestValue("POLICY_DIGEST"),
  kernelPolicyDigest: digestValue("KERNEL_POLICY_DIGEST"),
  activationLeaseDigest: digestValue("ACTIVATION_LEASE_DIGEST"),
  activationNonce: trustedState.state.activationNonce,
  reservedAiCredits: runtimeMaximumReservation(policy),
  currentHead
};
const demoProjectId = (process.env.RUNTIME_DEMO_PROJECT_ID ?? "").trim();
const demoStageId = (process.env.RUNTIME_STAGE_ID ?? "").trim();
if ((demoProjectId.length === 0) !== (demoStageId.length === 0)) {
  throw new TypeError(
    "RUNTIME_DEMO_PROJECT_ID and RUNTIME_STAGE_ID must be supplied together"
  );
}
const trustedDemoBindings =
  demoProjectId.length === 0
    ? []
    : [
        await loadTrustedDemoRuntimeBindingForSelection({
          baseRegistry,
          lifecycle,
          demoProjectId,
          stageId: demoStageId,
          phase: request.phase,
          role: request.role,
          capability: request.capability,
          workflowId: request.workflowId
        })
      ];
if (
  (request.capability.startsWith("demo.") && trustedDemoBindings.length !== 1) ||
  (!request.capability.startsWith("demo.") && trustedDemoBindings.length !== 0)
) {
  throw new TypeError(
    "demo runtime selection must match exactly one trusted demo capability"
  );
}
const onlyTrustedDemoBinding = trustedDemoBindings[0] ?? null;
const trustedDemoRegistration =
  trustedDemoBindings.length === 1 && onlyTrustedDemoBinding !== null
    ? assertTrustedDemoRuntimeRegistration(onlyTrustedDemoBinding)
    : null;
const stageAgentSelection = trustedState.state.stageAgentSelection ?? null;
if (trustedDemoRegistration?.binding.userInvocable === true) {
  if (
    stageAgentSelection === null ||
    trustedDemoRegistration.binding.demoProjectId === null ||
    trustedDemoRegistration.binding.stageId === null
  ) {
    throw new TypeError(
      "selectable runtime state omits its exact stage-agent selection grant"
    );
  }
  trustedSelectionGrant({
    observation: trustedState,
    expectedDigest: stageAgentSelection.grantDigest,
    evaluatedAt: new Date().toISOString(),
    expected: {
      demoProjectId: trustedDemoRegistration.binding.demoProjectId,
      stageId: trustedDemoRegistration.binding.stageId,
      projectNodeId: trustedState.state.projectNodeId,
      projectItemNodeId: trustedState.state.projectItemNodeId,
      repositoryId: trustedState.state.repositoryId,
      workItemNodeId: trustedState.state.workItemNodeId,
      stageAgentBindingsDigest:
        trustedDemoRegistration.stageAgentBindingsDigest,
      workAccordDigest: trustedState.state.workAccordDigest,
      activationLeaseDigest: trustedState.state.activationLeaseDigest,
      agentId: trustedDemoRegistration.binding.agent,
      skillId: trustedDemoRegistration.binding.skill,
      capabilityId: trustedDemoRegistration.binding.capability,
      workflowId: trustedDemoRegistration.binding.workflow,
      workflowClass: trustedDemoRegistration.binding.workflowClass,
      phase: trustedDemoRegistration.binding.phase,
      role: trustedDemoRegistration.binding.role,
      pullRequestHeadSha: currentHead,
      authorityEpoch: stageAgentSelection.authorityEpoch,
      generation: stageAgentSelection.generation,
      runId: stageAgentSelection.runId,
      runAttempt: stageAgentSelection.runAttempt,
      receiptHead: stageAgentSelection.receiptHead,
      policyGeneration: stageAgentSelection.policyGeneration,
      selectionPolicyDigest: stageAgentSelection.selectionPolicyDigest,
      capabilityRegistryDigest:
        stageAgentSelection.capabilityRegistryDigest,
      budgetAuthorityDigest: stageAgentSelection.budgetAuthorityDigest
    }
  });
} else if (stageAgentSelection !== null) {
  throw new TypeError(
    "fixed or core runtime state cannot carry a stage-agent selection grant"
  );
}
const candidate = validateRuntimePreActivation(
  policy,
  request,
  {
    state: trustedState.state,
    stateSignatureVerified: verifyStateSignature(trustedState.state),
    stateAuthorApplicationId: trustedState.applicationId,
    stateAuthorId: trustedState.authorId,
    expectedApplicationId: applicationId,
    expectedAuthorId: authorId,
    allowedActorIds: allowedActorIds(),
    stateCommentId: trustedState.commentId,
    stateCommentUpdatedAt: trustedState.commentUpdatedAt,
    stateCollectionEtag: trustedState.collectionEtag
  },
  kernelPolicy,
  { now: () => new Date().toISOString() },
  trustedDemoBindings
);
const redeemerKeyId = required("AGENTIC_REDEEMER_SIGNING_KEY_ID");
const redeemerPublicKey = required("AGENTIC_REDEEMER_SIGNING_PUBLIC_KEY");
const authorization = await redeemRuntimeAuthorization(
  candidate,
  { redeem: redeemCandidate },
  {
    verify: (value: CopilotRuntimeAuthorization) =>
      verifyRuntimeAuthorizationSignature(
        value,
        redeemerKeyId,
        redeemerPublicKey
      )
  },
  { now: () => new Date().toISOString() },
  policy
);
if (redeemedKernelResult === null) {
  throw new TypeError("trusted authorization redeemer omitted the Kernel result");
}
if (authorization.kernelPolicyDigest !== digest(kernelPolicy)) {
  throw new TypeError("current Control Policy differs from redeemed authorization");
}
bindKernelAuthorization(
  authorization,
  redeemedKernelResult,
  {
    verify: (value: CopilotRuntimeAuthorization) =>
      verifyRuntimeAuthorizationSignature(
        value,
        redeemerKeyId,
        redeemerPublicKey
      )
  },
  policy
);
const redemptionDigest = digest(authorization);
const trustedExecutionAuthorization =
  authorization.phase === "execution"
    ? Buffer.from(canonicalJson(authorization), "utf8").toString("base64")
    : "";
const trustedExecutionKernelResult =
  authorization.phase === "execution"
    ? Buffer.from(canonicalJson(redeemedKernelResult), "utf8").toString("base64")
    : "";
const modelExecutionContext =
  authorization.executionContext === null
    ? ""
    : canonicalJson({
        schemaVersion: authorization.executionContext.schemaVersion,
        planningArtifact: authorization.executionContext.planningArtifact,
        planningArtifactDigest:
          authorization.executionContext.planningArtifactDigest,
        executionGrantDigest:
          authorization.executionContext.executionGrantDigest,
        patchSchema: authorization.executionContext.patchSchema
      });

await appendFile(
  required("GITHUB_OUTPUT"),
  [
    "trusted_guard_result=success",
    `authorization_digest=${authorization.authorizationDigest}`,
    `redemption_digest=${redemptionDigest}`,
    `input_digest=${authorization.authorizationDigest}`,
    `authorized_head_sha=${authorization.currentHead ?? ""}`,
    `trusted_execution_authorization_b64=${trustedExecutionAuthorization}`,
    `trusted_execution_kernel_result_b64=${trustedExecutionKernelResult}`,
    `model_execution_context_json=${modelExecutionContext}`,
    ""
  ].join("\n")
);
console.log(
  `Redeemed ${request.workflowId} run ${request.runId}/${request.runAttempt} for ` +
    `${owner}/${repository}#${number} (${redemptionDigest}).`
);
