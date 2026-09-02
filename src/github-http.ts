import type {
  GitHubIssueIdentity,
  GitHubProjectItemIdentity,
  GitHubPullRequestIdentity,
  GitHubRepositoryIdentity
} from "./github-events.js";
import type { GitHubProjectFieldValue } from "./github-types.js";
import { GitHubApiError } from "./github-adapter.js";

export const GITHUB_API_VERSION = "2026-03-10";
export const GITHUB_ACCEPT = "application/vnd.github+json";

export interface GitHubHttpRequest {
  readonly method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export interface GitHubHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: unknown;
}

export interface AuthenticatedGitHubTransport {
  request(request: GitHubHttpRequest): Promise<GitHubHttpResponse>;
}

function requestHeaders(): Readonly<Record<string, string>> {
  return {
    Accept: GITHUB_ACCEPT,
    "User-Agent": "agentic-framework-github-adapter/1.0",
    "X-GitHub-Api-Version": GITHUB_API_VERSION
  };
}

function record(value: unknown, name: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GitHubApiError(
      "RESPONSE_INVALID",
      `${name} response must be an object`,
      null,
      false,
      false
    );
  }
  return value as Readonly<Record<string, unknown>>;
}

function array(value: unknown, name: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new GitHubApiError(
      "RESPONSE_INVALID",
      `${name} response must be an array`,
      null,
      false,
      false
    );
  }
  return value;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new GitHubApiError(
      "RESPONSE_INVALID",
      `${name} must be a non-empty string`,
      null,
      false,
      false
    );
  }
  return value;
}

function integer(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new GitHubApiError(
      "RESPONSE_INVALID",
      `${name} must be a positive integer`,
      null,
      false,
      false
    );
  }
  return Number(value);
}

function parseRepository(value: unknown): GitHubRepositoryIdentity {
  const item = record(value, "repository");
  const owner = record(item.owner, "repository.owner");
  return {
    id: integer(item.id, "repository.id"),
    nodeId: text(item.node_id, "repository.node_id"),
    owner: text(owner.login, "repository.owner.login"),
    name: text(item.name, "repository.name"),
    fullName: text(item.full_name, "repository.full_name")
  };
}

function parseIssue(value: unknown): GitHubIssueIdentity {
  const item = record(value, "issue");
  return {
    number: integer(item.number, "issue.number"),
    nodeId: text(item.node_id, "issue.node_id")
  };
}

function parsePull(value: unknown): GitHubPullRequestIdentity {
  const item = record(value, "pull request");
  const base = record(item.base, "pull request base");
  const head = record(item.head, "pull request head");
  return {
    number: integer(item.number, "pull_request.number"),
    nodeId: text(item.node_id, "pull_request.node_id"),
    base: {
      repository: parseRepository(base.repo),
      ref: text(base.ref, "pull_request.base.ref"),
      sha: text(base.sha, "pull_request.base.sha")
    },
    head: {
      repository: parseRepository(head.repo),
      ref: text(head.ref, "pull_request.head.ref"),
      sha: text(head.sha, "pull_request.head.sha")
    }
  };
}

function responseHeader(
  headers: GitHubHttpResponse["headers"],
  name: string
): string | undefined {
  const expected = name.toLowerCase();
  return Object.entries(headers).find(
    ([header]) => header.toLowerCase() === expected
  )?.[1];
}

function safeDelay(milliseconds: number): number | null {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) return null;
  return milliseconds;
}

function parseHttpDate(value: string): Date | null {
  const parsed = new Date(value);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toUTCString() !== value
  ) {
    return null;
  }
  return parsed;
}

function rateLimitDelay(
  response: GitHubHttpResponse,
  message: string,
  now: Date
): {
  readonly rateLimited: boolean;
  readonly retryAfterMs: number | null;
  readonly invalid: boolean;
} {
  const retryAfter = responseHeader(response.headers, "retry-after");
  if (retryAfter !== undefined) {
    if (/^[0-9]+$/.test(retryAfter)) {
      const numericDelay = safeDelay(Number(retryAfter) * 1000);
      if (numericDelay !== null) {
        return {
          rateLimited: true,
          retryAfterMs: numericDelay,
          invalid: false
        };
      }
    }
    const retryDate = parseHttpDate(retryAfter);
    if (retryDate !== null) {
      const dateDelay = safeDelay(
        Math.max(0, retryDate.getTime() - now.getTime())
      );
      return {
        rateLimited: true,
        retryAfterMs: dateDelay,
        invalid: dateDelay === null
      };
    }
    return { rateLimited: true, retryAfterMs: null, invalid: true };
  }

  const remaining = responseHeader(response.headers, "x-ratelimit-remaining");
  const reset = responseHeader(response.headers, "x-ratelimit-reset");
  if (remaining === "0" && reset !== undefined && /^[0-9]+$/.test(reset)) {
    const resetMilliseconds = Number(reset) * 1000;
    const delay = safeDelay(
      Math.max(0, resetMilliseconds - now.getTime())
    );
    return {
      rateLimited: true,
      retryAfterMs: delay,
      invalid: delay === null
    };
  }
  if (remaining === "0" && reset !== undefined) {
    return { rateLimited: true, retryAfterMs: null, invalid: true };
  }

  if (
    /(?:secondary rate limit|rate limit (?:exceeded|reached))/i.test(message)
  ) {
    return { rateLimited: true, retryAfterMs: null, invalid: false };
  }
  return { rateLimited: false, retryAfterMs: null, invalid: false };
}

function errorFromResponse(
  response: GitHubHttpResponse,
  method: GitHubHttpRequest["method"],
  now: Date
): GitHubApiError {
  const responseRecord =
    typeof response.body === "object" &&
    response.body !== null &&
    !Array.isArray(response.body)
      ? (response.body as Readonly<Record<string, unknown>>)
      : {};
  const message =
    typeof responseRecord.message === "string"
      ? responseRecord.message
      : `GitHub API returned ${response.status}`;
  const ambiguous = method !== "GET" && response.status >= 500;
  const limit = rateLimitDelay(response, message, now);
  if ((response.status === 403 || response.status === 429) && limit.invalid) {
    return new GitHubApiError(
      "RESPONSE_INVALID",
      "GitHub returned an invalid rate-limit deadline",
      response.status,
      false,
      false
    );
  }
  if ((response.status === 403 || response.status === 429) && limit.rateLimited) {
    return new GitHubApiError(
      "RATE_LIMITED",
      message,
      response.status,
      true,
      false,
      limit.retryAfterMs
    );
  }
  if (response.status === 403) {
    return new GitHubApiError("FORBIDDEN", message, 403, false, ambiguous);
  }
  if (response.status === 404) {
    return new GitHubApiError("NOT_FOUND", message, 404, false, ambiguous);
  }
  if (response.status === 410) {
    return new GitHubApiError("GONE", message, 410, false, ambiguous);
  }
  if (response.status === 422) {
    return new GitHubApiError(
      "VALIDATION_FAILED",
      message,
      422,
      false,
      ambiguous
    );
  }
  if (response.status === 429) {
    return new GitHubApiError(
      "RATE_LIMITED",
      message,
      429,
      true,
      false,
      limit.retryAfterMs
    );
  }
  return new GitHubApiError(
    "SERVER_ERROR",
    message,
    response.status,
    response.status >= 500,
    ambiguous
  );
}

export class GitHubHttpOperations {
  constructor(
    private readonly transport: AuthenticatedGitHubTransport,
    private readonly now: () => Date = () => new Date()
  ) {}

  private async request(
    method: GitHubHttpRequest["method"],
    path: string,
    body?: unknown
  ): Promise<GitHubHttpResponse> {
    let response: GitHubHttpResponse;
    try {
      const request: GitHubHttpRequest =
        body === undefined
          ? { method, path, headers: requestHeaders() }
          : { method, path, headers: requestHeaders(), body };
      response = await this.transport.request(request);
    } catch (error) {
      if (error instanceof GitHubApiError) throw error;
      throw new GitHubApiError(
        "TIMEOUT",
        error instanceof Error ? error.message : "GitHub request failed",
        null,
        true,
        method !== "GET"
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw errorFromResponse(response, method, this.now());
    }
    return response;
  }

  async graphql<T>(
    query: string,
    variables: Readonly<Record<string, unknown>>
  ): Promise<T> {
    const response = await this.request("POST", "/graphql", { query, variables });
    const body = record(response.body, "GraphQL");
    if (Array.isArray(body.errors) && body.errors.length > 0) {
      throw new GitHubApiError(
        "GRAPHQL_ERROR",
        `GitHub GraphQL returned errors: ${JSON.stringify(body.errors)}`,
        response.status,
        false,
        true
      );
    }
    if (!Object.hasOwn(body, "data")) {
      throw new GitHubApiError(
        "RESPONSE_INVALID",
        "GitHub GraphQL response is missing data",
        response.status,
        false,
        false
      );
    }
    return body.data as T;
  }

  async getRepository(
    owner: string,
    repository: string
  ): Promise<GitHubRepositoryIdentity> {
    const response = await this.request(
      "GET",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`
    );
    return parseRepository(response.body);
  }

  async getIssue(
    owner: string,
    repository: string,
    issueNumber: number
  ): Promise<GitHubIssueIdentity> {
    const response = await this.request(
      "GET",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/issues/${issueNumber}`
    );
    return parseIssue(response.body);
  }

  async getPullRequest(
    owner: string,
    repository: string,
    pullNumber: number
  ): Promise<GitHubPullRequestIdentity> {
    const response = await this.request(
      "GET",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pulls/${pullNumber}`
    );
    return parsePull(response.body);
  }

  async listIssueComments(
    owner: string,
    repository: string,
    issueNumber: number,
    maximumPages = 10
  ): Promise<readonly Readonly<Record<string, unknown>>[]> {
    const comments: Readonly<Record<string, unknown>>[] = [];
    for (let page = 1; page <= maximumPages; page += 1) {
      const response = await this.request(
        "GET",
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/issues/${issueNumber}/comments?per_page=100&page=${page}`
      );
      const items = array(response.body, "issue comments").map((item) =>
        record(item, "issue comment")
      );
      comments.push(...items);
      if (items.length < 100) return comments;
    }
    throw new GitHubApiError(
      "RESPONSE_INVALID",
      "issue comment pagination exceeded the configured bound",
      null,
      false,
      false
    );
  }

  async createIssueComment(
    owner: string,
    repository: string,
    issueNumber: number,
    body: string
  ): Promise<Readonly<Record<string, unknown>>> {
    const response = await this.request(
      "POST",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/issues/${issueNumber}/comments`,
      { body }
    );
    return record(response.body, "created issue comment");
  }

  async updateIssueComment(
    owner: string,
    repository: string,
    commentId: number,
    body: string
  ): Promise<Readonly<Record<string, unknown>>> {
    const response = await this.request(
      "PATCH",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/issues/comments/${commentId}`,
      { body }
    );
    return record(response.body, "updated issue comment");
  }

  async createCheckRun(input: {
    readonly owner: string;
    readonly repository: string;
    readonly name: string;
    readonly headSha: string;
    readonly externalId: string;
    readonly conclusion:
      | "action_required"
      | "cancelled"
      | "failure"
      | "neutral"
      | "success"
      | "timed_out";
    readonly summary: string;
  }): Promise<Readonly<Record<string, unknown>>> {
    const response = await this.request(
      "POST",
      `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/check-runs`,
      {
        name: input.name,
        head_sha: input.headSha,
        external_id: input.externalId,
        status: "completed",
        conclusion: input.conclusion,
        output: { title: input.name, summary: input.summary }
      }
    );
    return record(response.body, "created check run");
  }

  async listCheckRuns(
    owner: string,
    repository: string,
    ref: string,
    checkName: string
  ): Promise<readonly Readonly<Record<string, unknown>>[]> {
    const response = await this.request(
      "GET",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/commits/${encodeURIComponent(ref)}/check-runs?check_name=${encodeURIComponent(checkName)}&per_page=100`
    );
    const body = record(response.body, "check runs");
    return array(body.check_runs, "check_runs").map((item) =>
      record(item, "check run")
    );
  }

  async getCollaboratorPermission(
    owner: string,
    repository: string,
    username: string
  ): Promise<string> {
    const response = await this.request(
      "GET",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/collaborators/${encodeURIComponent(username)}/permission`
    );
    return text(record(response.body, "collaborator permission").permission, "permission");
  }

  async getOrganizationMembership(
    organization: string,
    username: string
  ): Promise<Readonly<Record<string, unknown>>> {
    const response = await this.request(
      "GET",
      `/orgs/${encodeURIComponent(organization)}/memberships/${encodeURIComponent(username)}`
    );
    return record(response.body, "organization membership");
  }

  async getPullRequestReviews(
    owner: string,
    repository: string,
    pullNumber: number
  ): Promise<readonly Readonly<Record<string, unknown>>[]> {
    const response = await this.request(
      "GET",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pulls/${pullNumber}/reviews?per_page=100`
    );
    return array(response.body, "pull request reviews").map((item) =>
      record(item, "pull request review")
    );
  }

  async getTeamMembership(
    organization: string,
    teamSlug: string,
    username: string
  ): Promise<Readonly<Record<string, unknown>>> {
    const response = await this.request(
      "GET",
      `/orgs/${encodeURIComponent(organization)}/teams/${encodeURIComponent(teamSlug)}/memberships/${encodeURIComponent(username)}`
    );
    return record(response.body, "team membership");
  }

  async getProjectItem(
    projectNodeId: string,
    contentNodeId: string
  ): Promise<GitHubProjectItemIdentity | null> {
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const data: {
        readonly node: {
          readonly items: {
            readonly pageInfo: {
              readonly hasNextPage: boolean;
              readonly endCursor: string | null;
            };
            readonly nodes: readonly {
              readonly id: string;
              readonly content:
                | { readonly id: string }
                | null;
            }[];
          };
        } | null;
      } = await this.graphql(
        `query($project: ID!, $cursor: String) {
          node(id: $project) {
            ... on ProjectV2 {
              items(first: 100, after: $cursor) {
                pageInfo { hasNextPage endCursor }
                nodes { id content { ... on Node { id } } }
              }
            }
          }
        }`,
        { project: projectNodeId, cursor }
      );
      const items = data.node?.items;
      if (items === undefined) return null;
      const match = items.nodes.find(
        (item) => item.content?.id === contentNodeId
      );
      if (match !== undefined) {
        return {
          nodeId: match.id,
          projectNodeId,
          contentNodeId
        };
      }
      if (!items.pageInfo.hasNextPage) return null;
      cursor = items.pageInfo.endCursor;
      if (cursor === null) {
        throw new GitHubApiError(
          "RESPONSE_INVALID",
          "Project pagination omitted its next cursor",
          200,
          false,
          false
        );
      }
    }
    throw new GitHubApiError(
      "RESPONSE_INVALID",
      "Project item pagination exceeded the configured bound",
      200,
      false,
      false
    );
  }

  async addExistingProjectItem(
    projectNodeId: string,
    contentNodeId: string
  ): Promise<GitHubProjectItemIdentity> {
    const data = await this.graphql<{
      readonly addProjectV2ItemById: {
        readonly item: { readonly id: string; readonly content: { readonly id: string } | null };
      } | null;
    }>(
      `mutation($project: ID!, $content: ID!) {
        addProjectV2ItemById(input: { projectId: $project, contentId: $content }) {
          item { id content { ... on Node { id } } }
        }
      }`,
      { project: projectNodeId, content: contentNodeId }
    );
    const item = data.addProjectV2ItemById?.item;
    if (item === undefined || item.content?.id !== contentNodeId) {
      throw new GitHubApiError(
        "RESPONSE_INVALID",
        "Project add-item mutation returned a different content item",
        200,
        false,
        true
      );
    }
    return {
      nodeId: item.id,
      projectNodeId,
      contentNodeId
    };
  }

  async getProjectFieldValue(input: {
    readonly itemNodeId: string;
    readonly fieldNodeId: string;
  }): Promise<GitHubProjectFieldValue | null> {
    const data = await this.graphql<{
      readonly node: {
        readonly fieldValueByName?: unknown;
        readonly fieldValues: {
          readonly nodes: readonly {
            readonly field: { readonly id: string };
            readonly optionId?: string;
            readonly text?: string;
            readonly number?: number;
          }[];
        };
      } | null;
    }>(
      `query($item: ID!) {
        node(id: $item) {
          ... on ProjectV2Item {
            fieldValues(first: 100) {
              nodes {
                ... on ProjectV2ItemFieldSingleSelectValue { optionId field { ... on ProjectV2FieldCommon { id } } }
                ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { id } } }
                ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2FieldCommon { id } } }
              }
            }
          }
        }
      }`,
      { item: input.itemNodeId }
    );
    const value = data.node?.fieldValues.nodes.find(
      (candidate) => candidate.field.id === input.fieldNodeId
    );
    if (value === undefined) return null;
    if (typeof value.optionId === "string") {
      return { kind: "single-select", optionNodeId: value.optionId };
    }
    if (typeof value.text === "string") return { kind: "text", text: value.text };
    if (typeof value.number === "number") {
      return { kind: "number", number: value.number };
    }
    throw new GitHubApiError(
      "RESPONSE_INVALID",
      "Project field value has an unsupported type",
      200,
      false,
      false
    );
  }

  async updateProjectFieldValue(input: {
    readonly projectNodeId: string;
    readonly itemNodeId: string;
    readonly fieldNodeId: string;
    readonly value: GitHubProjectFieldValue;
  }): Promise<string> {
    const value =
      input.value.kind === "single-select"
        ? { singleSelectOptionId: input.value.optionNodeId }
        : input.value.kind === "text"
          ? { text: input.value.text }
          : { number: input.value.number };
    const data = await this.graphql<{
      readonly updateProjectV2ItemFieldValue: {
        readonly projectV2Item: { readonly id: string };
      } | null;
    }>(
      `mutation($project: ID!, $item: ID!, $field: ID!, $value: ProjectV2FieldValue!) {
        updateProjectV2ItemFieldValue(input: {
          projectId: $project,
          itemId: $item,
          fieldId: $field,
          value: $value
        }) {
          projectV2Item { id }
        }
      }`,
      {
        project: input.projectNodeId,
        item: input.itemNodeId,
        field: input.fieldNodeId,
        value
      }
    );
    const itemId = data.updateProjectV2ItemFieldValue?.projectV2Item.id;
    if (itemId === undefined) {
      throw new GitHubApiError(
        "RESPONSE_INVALID",
        "Project field mutation did not return an item",
        200,
        false,
        true
      );
    }
    return itemId;
  }
}
