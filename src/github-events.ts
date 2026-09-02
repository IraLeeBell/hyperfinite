import {
  createHmac,
  timingSafeEqual
} from "node:crypto";

import { digest } from "./canonical.js";
import type { GitHubProjectBinding } from "./github-types.js";
import type { Digest } from "./types.js";
import { assertDocument } from "./validation.js";

export interface GitHubRepositoryIdentity {
  readonly id: number;
  readonly nodeId: string;
  readonly owner: string;
  readonly name: string;
  readonly fullName: string;
}

export interface GitHubIssueIdentity {
  readonly number: number;
  readonly nodeId: string;
}

export interface GitHubPullRequestIdentity extends GitHubIssueIdentity {
  readonly base: {
    readonly repository: GitHubRepositoryIdentity;
    readonly ref: string;
    readonly sha: string;
  };
  readonly head: {
    readonly repository: GitHubRepositoryIdentity;
    readonly ref: string;
    readonly sha: string;
  };
}

export interface GitHubInstallationScope {
  readonly id: number;
  readonly accountNodeId: string;
  readonly repositorySelection: "all" | "selected";
  readonly repositoryIds: readonly number[];
}

export interface GitHubProjectItemIdentity {
  readonly nodeId: string;
  readonly projectNodeId: string;
  readonly contentNodeId: string;
}

export interface TrustedGitHubBinding {
  readonly repository: GitHubRepositoryIdentity;
  readonly workItem:
    | ({ readonly kind: "issue" } & GitHubIssueIdentity)
    | ({ readonly kind: "pull-request" } & GitHubPullRequestIdentity);
  readonly project: {
    readonly ownerNodeId: string;
    readonly projectNodeId: string;
    readonly itemNodeId: string;
    readonly schemaDigest: Digest;
    readonly bindingDigest: Digest;
    readonly fields: GitHubProjectBinding["fields"];
  };
  readonly installation: GitHubInstallationScope;
}

export interface VerifiedGitHubEventContext {
  readonly deliveryId: string;
  readonly eventName: "issues" | "pull_request";
  readonly action: string;
  readonly occurredAt: string;
  readonly sender: {
    readonly id: number;
    readonly nodeId: string;
    readonly login: string;
    readonly type: "Bot" | "Organization" | "User";
  };
  readonly binding: TrustedGitHubBinding;
  readonly payloadDigest: Digest;
}

export interface GitHubBindingReadApi {
  getRepository(owner: string, repository: string): Promise<GitHubRepositoryIdentity>;
  getIssue(
    owner: string,
    repository: string,
    issueNumber: number
  ): Promise<GitHubIssueIdentity>;
  getPullRequest(
    owner: string,
    repository: string,
    pullNumber: number
  ): Promise<GitHubPullRequestIdentity>;
  getInstallationScope(installationId: number): Promise<GitHubInstallationScope>;
  getProjectItem(
    projectNodeId: string,
    contentNodeId: string
  ): Promise<GitHubProjectItemIdentity | null>;
}

export interface WebhookSignatureVerifier {
  verify(rawBody: Uint8Array, signature: string): boolean;
}

export class HmacWebhookSignatureVerifier implements WebhookSignatureVerifier {
  readonly #secret: Uint8Array;

  constructor(secret: Uint8Array) {
    if (secret.byteLength < 16) {
      throw new TypeError("webhook secret must contain at least 16 bytes");
    }
    this.#secret = Uint8Array.from(secret);
  }

  verify(rawBody: Uint8Array, signature: string): boolean {
    if (!/^sha256=[0-9a-f]{64}$/.test(signature)) return false;
    const expected = createHmac("sha256", this.#secret)
      .update(rawBody)
      .digest();
    const actual = Buffer.from(signature.slice("sha256=".length), "hex");
    return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
  }
}

export class GitHubBindingError extends Error {
  constructor(
    readonly code:
      | "INVALID_SIGNATURE"
      | "INVALID_EVENT"
      | "UNSUPPORTED_EVENT"
      | "REPOSITORY_MISMATCH"
      | "WORK_ITEM_MISMATCH"
      | "PULL_REQUEST_MISMATCH"
      | "INSTALLATION_MISMATCH"
      | "INSTALLATION_SCOPE_MISMATCH"
      | "PROJECT_MISMATCH",
    message: string
  ) {
    super(message);
    this.name = "GitHubBindingError";
  }
}

function objectValue(
  value: unknown,
  name: string
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GitHubBindingError("INVALID_EVENT", `${name} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new GitHubBindingError("INVALID_EVENT", `${name} must be a non-empty string`);
  }
  return value;
}

function integerValue(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new GitHubBindingError("INVALID_EVENT", `${name} must be a positive integer`);
  }
  return Number(value);
}

function canonicalUtc(value: unknown, name: string): string {
  const parsed = new Date(stringValue(value, name));
  if (Number.isNaN(parsed.getTime())) {
    throw new GitHubBindingError("INVALID_EVENT", `${name} must be a date-time`);
  }
  return parsed.toISOString();
}

function sameRepository(
  left: GitHubRepositoryIdentity,
  right: GitHubRepositoryIdentity
): boolean {
  return (
    left.id === right.id &&
    left.nodeId === right.nodeId &&
    left.owner === right.owner &&
    left.name === right.name &&
    left.fullName === right.fullName
  );
}

function parseRepository(value: unknown): GitHubRepositoryIdentity {
  const repository = objectValue(value, "repository");
  const owner = objectValue(repository.owner, "repository.owner");
  const fullName = stringValue(repository.full_name, "repository.full_name");
  return {
    id: integerValue(repository.id, "repository.id"),
    nodeId: stringValue(repository.node_id, "repository.node_id"),
    owner: stringValue(owner.login, "repository.owner.login"),
    name: stringValue(repository.name, "repository.name"),
    fullName
  };
}

function parseIssue(value: unknown): GitHubIssueIdentity {
  const issue = objectValue(value, "issue");
  return {
    number: integerValue(issue.number, "issue.number"),
    nodeId: stringValue(issue.node_id, "issue.node_id")
  };
}

function parsePullRequest(
  value: unknown,
  repository: GitHubRepositoryIdentity
): GitHubPullRequestIdentity {
  const pull = objectValue(value, "pull_request");
  const base = objectValue(pull.base, "pull_request.base");
  const head = objectValue(pull.head, "pull_request.head");
  return {
    number: integerValue(pull.number, "pull_request.number"),
    nodeId: stringValue(pull.node_id, "pull_request.node_id"),
    base: {
      repository: parseRepository(base.repo),
      ref: stringValue(base.ref, "pull_request.base.ref"),
      sha: stringValue(base.sha, "pull_request.base.sha")
    },
    head: {
      repository: parseRepository(head.repo),
      ref: stringValue(head.ref, "pull_request.head.ref"),
      sha: stringValue(head.sha, "pull_request.head.sha")
    }
  };
}

export async function normalizeGitHubWebhook(input: {
  readonly rawBody: Uint8Array;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly verifier: WebhookSignatureVerifier;
  readonly api: GitHubBindingReadApi;
  readonly projectBinding: GitHubProjectBinding;
}): Promise<VerifiedGitHubEventContext> {
  assertDocument("GitHubProjectBinding", input.projectBinding);
  const signature = input.headers["x-hub-signature-256"] ?? "";
  if (!input.verifier.verify(input.rawBody, signature)) {
    throw new GitHubBindingError("INVALID_SIGNATURE", "webhook signature is invalid");
  }

  const deliveryId = stringValue(
    input.headers["x-github-delivery"],
    "x-github-delivery"
  );
  const eventName = input.headers["x-github-event"];
  if (eventName !== "issues" && eventName !== "pull_request") {
    throw new GitHubBindingError(
      "UNSUPPORTED_EVENT",
      `unsupported GitHub event ${eventName ?? "<missing>"}`
    );
  }

  let rawPayload: unknown;
  try {
    rawPayload = JSON.parse(Buffer.from(input.rawBody).toString("utf8")) as unknown;
  } catch {
    throw new GitHubBindingError("INVALID_EVENT", "webhook payload is not valid JSON");
  }
  const payload = objectValue(rawPayload, "payload");
  const payloadRepository = parseRepository(payload.repository);
  const installation = objectValue(payload.installation, "installation");
  const installationId = integerValue(installation.id, "installation.id");
  const sender = objectValue(payload.sender, "sender");

  const repository = await input.api.getRepository(
    payloadRepository.owner,
    payloadRepository.name
  );
  if (!sameRepository(payloadRepository, repository)) {
    throw new GitHubBindingError(
      "REPOSITORY_MISMATCH",
      "webhook repository does not match the fresh repository read"
    );
  }

  const installationScope = await input.api.getInstallationScope(installationId);
  if (
    installationScope.id !== input.projectBinding.installation.id ||
    installationScope.accountNodeId !==
      input.projectBinding.installation.accountNodeId
  ) {
    throw new GitHubBindingError(
      "INSTALLATION_MISMATCH",
      "installation does not match the validated Project binding"
    );
  }
  if (
    installationScope.repositorySelection === "selected" &&
    !installationScope.repositoryIds.includes(repository.id)
  ) {
    throw new GitHubBindingError(
      "INSTALLATION_SCOPE_MISMATCH",
      "repository is outside the fresh installation scope"
    );
  }

  let workItem: TrustedGitHubBinding["workItem"];
  if (eventName === "issues") {
    const payloadIssue = parseIssue(payload.issue);
    const issue = await input.api.getIssue(
      repository.owner,
      repository.name,
      payloadIssue.number
    );
    if (
      issue.number !== payloadIssue.number ||
      issue.nodeId !== payloadIssue.nodeId
    ) {
      throw new GitHubBindingError(
        "WORK_ITEM_MISMATCH",
        "webhook issue does not match the fresh issue read"
      );
    }
    workItem = { kind: "issue", ...issue };
  } else {
    const payloadPull = parsePullRequest(payload.pull_request, repository);
    const pull = await input.api.getPullRequest(
      repository.owner,
      repository.name,
      payloadPull.number
    );
    if (
      pull.number !== payloadPull.number ||
      pull.nodeId !== payloadPull.nodeId ||
      !sameRepository(payloadPull.base.repository, pull.base.repository) ||
      !sameRepository(payloadPull.head.repository, pull.head.repository) ||
      payloadPull.base.ref !== pull.base.ref ||
      payloadPull.head.ref !== pull.head.ref ||
      payloadPull.base.sha !== pull.base.sha ||
      payloadPull.head.sha !== pull.head.sha ||
      pull.base.repository.id !== repository.id
    ) {
      throw new GitHubBindingError(
        "PULL_REQUEST_MISMATCH",
        "webhook pull request does not match the fresh pull request read"
      );
    }
    workItem = { kind: "pull-request", ...pull };
  }

  const projectItem = await input.api.getProjectItem(
    input.projectBinding.project.nodeId,
    workItem.nodeId
  );
  if (
    projectItem === null ||
    projectItem.projectNodeId !== input.projectBinding.project.nodeId ||
    projectItem.contentNodeId !== workItem.nodeId
  ) {
    throw new GitHubBindingError(
      "PROJECT_MISMATCH",
      "work item is not bound to the validated Project"
    );
  }

  return {
    deliveryId,
    eventName,
    action: stringValue(payload.action, "action"),
    occurredAt: canonicalUtc(
      payloadPullOrIssueUpdatedAt(payload, eventName),
      `${eventName}.updated_at`
    ),
    sender: {
      id: integerValue(sender.id, "sender.id"),
      nodeId: stringValue(sender.node_id, "sender.node_id"),
      login: stringValue(sender.login, "sender.login"),
      type: parseSenderType(sender.type)
    },
    binding: {
      repository,
      workItem,
      project: {
        ownerNodeId: input.projectBinding.owner.nodeId,
        projectNodeId: input.projectBinding.project.nodeId,
        itemNodeId: projectItem.nodeId,
        schemaDigest: input.projectBinding.projectSchemaDigest,
        bindingDigest: digest(input.projectBinding),
        fields: input.projectBinding.fields
      },
      installation: installationScope
    },
    payloadDigest: digest(rawPayload)
  };
}

function payloadPullOrIssueUpdatedAt(
  payload: Readonly<Record<string, unknown>>,
  eventName: "issues" | "pull_request"
): unknown {
  const subject = objectValue(
    eventName === "issues" ? payload.issue : payload.pull_request,
    eventName
  );
  return subject.updated_at ?? subject.created_at;
}

function parseSenderType(value: unknown): "Bot" | "Organization" | "User" {
  if (value === "Bot" || value === "Organization" || value === "User") {
    return value;
  }
  throw new GitHubBindingError("INVALID_EVENT", "sender.type is unsupported");
}
