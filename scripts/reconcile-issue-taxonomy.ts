#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { Ajv2020, type AnySchema, type ValidateFunction } from "ajv/dist/2020.js";

export type TaxonomyClass =
  | "customer-evaluation"
  | "maintainer-development"
  | "synthetic-demo";

export interface TaxonomyLabel {
  readonly class: TaxonomyClass;
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

export interface IssueTaxonomyConfig {
  readonly apiVersion: "agentic-framework.github.com/v1alpha1";
  readonly kind: "IssueTaxonomy";
  readonly schemaVersion: "1.0.0";
  readonly repository: {
    readonly fullName: string;
    readonly repositoryId: number;
    readonly defaultBranch: string;
  };
  readonly limits: {
    readonly maxOpenIssues: number;
    readonly maxPages: number;
  };
  readonly labels: readonly TaxonomyLabel[];
  readonly historicalIssues: readonly {
    readonly issueNumber: number;
    readonly class: TaxonomyClass;
  }[];
  readonly recognizedTitlePrefixes: readonly {
    readonly prefix: string;
    readonly class: TaxonomyClass;
  }[];
}

export interface RepositoryIssue {
  readonly number: number;
  readonly id: number;
  readonly nodeId: string;
  readonly repositoryUrl: string;
  readonly title: string;
  readonly state: "open" | "closed";
  readonly labels: readonly string[];
}

export interface RepositoryLabel {
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

export interface TaxonomyRepository {
  listOpenIssues(limits: IssueTaxonomyConfig["limits"]): Promise<readonly RepositoryIssue[]>;
  getIssue(issueNumber: number): Promise<RepositoryIssue>;
  getLabel(labelName: string): Promise<RepositoryLabel | null>;
  createLabel(label: TaxonomyLabel): Promise<void>;
  updateLabel(currentName: string, label: TaxonomyLabel): Promise<void>;
  addIssueLabel(issueNumber: number, labelName: string): Promise<void>;
  removeIssueLabel(issueNumber: number, labelName: string): Promise<void>;
}

export interface RuntimeContext {
  readonly eventName: "push" | "issues";
  readonly targetIssue:
    | {
        readonly number: number;
        readonly id: number;
        readonly nodeId: string;
        readonly repositoryUrl: string;
        readonly title: string;
      }
    | null;
}

interface GitHubIssueResponse {
  readonly number: number;
  readonly id: number;
  readonly node_id: string;
  readonly repository_url: string;
  readonly title: string;
  readonly state: string;
  readonly labels: readonly (string | { readonly name?: unknown })[];
  readonly pull_request?: unknown;
}

interface GitHubLabelResponse {
  readonly name: string;
  readonly color: string;
  readonly description: string | null;
}

const TAXONOMY_CLASSES: readonly TaxonomyClass[] = [
  "customer-evaluation",
  "maintainer-development",
  "synthetic-demo"
];
const CONFIG_PATH = "config/v1alpha1/issue-taxonomy.json";
const SCHEMA_PATH = "schemas/v1alpha1/issue-taxonomy.schema.json";
const API_VERSION = "2026-03-10";

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseJsonFile(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
}

export function validateTaxonomyConfigSemantics(
  config: IssueTaxonomyConfig
): IssueTaxonomyConfig {
  const classes = config.labels.map((label) => label.class);
  if (
    classes.length !== TAXONOMY_CLASSES.length ||
    classes.some((value, index) => value !== TAXONOMY_CLASSES[index])
  ) {
    throw new TypeError("issue taxonomy labels must contain the three classes in canonical order");
  }
  for (const label of config.labels) {
    if (label.name !== `type: ${label.class}`) {
      throw new TypeError(`issue taxonomy label ${label.class} has a mismatched name`);
    }
  }
  if (config.limits.maxOpenIssues > config.limits.maxPages * 100) {
    throw new TypeError("issue taxonomy open-issue limit exceeds the pagination bound");
  }
  let previousIssueNumber = 0;
  for (const entry of config.historicalIssues) {
    if (entry.issueNumber <= previousIssueNumber) {
      throw new TypeError("historical issue mappings must be strictly increasing");
    }
    previousIssueNumber = entry.issueNumber;
  }
  let previousPrefix = "";
  for (const entry of config.recognizedTitlePrefixes) {
    if (compareCodeUnits(previousPrefix, entry.prefix) >= 0) {
      throw new TypeError("recognized title prefixes must be strictly sorted and unique");
    }
    previousPrefix = entry.prefix;
  }
  for (const [index, entry] of config.recognizedTitlePrefixes.entries()) {
    const overlap = config.recognizedTitlePrefixes.find(
      (candidate, candidateIndex) =>
        candidateIndex !== index &&
        (candidate.prefix.startsWith(entry.prefix) ||
          entry.prefix.startsWith(candidate.prefix))
    );
    if (overlap !== undefined) {
      throw new TypeError(
        `recognized title prefixes overlap: ${entry.prefix} and ${overlap.prefix}`
      );
    }
  }
  return config;
}

export function loadIssueTaxonomyConfig(root: string): IssueTaxonomyConfig {
  const canonicalRoot = realpathSync(root);
  const schema = parseJsonFile(path.join(canonicalRoot, SCHEMA_PATH));
  const value = parseJsonFile(path.join(canonicalRoot, CONFIG_PATH));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate: ValidateFunction<IssueTaxonomyConfig> = ajv.compile(
    schema as AnySchema
  );
  if (!validate(value)) {
    throw new TypeError(`issue taxonomy config is invalid: ${ajv.errorsText(validate.errors)}`);
  }
  return validateTaxonomyConfigSemantics(value);
}

export function classifyIssue(
  config: IssueTaxonomyConfig,
  issueNumber: number,
  title: string
): TaxonomyClass | null {
  const historical = config.historicalIssues.find(
    (entry) => entry.issueNumber === issueNumber
  );
  if (historical !== undefined) return historical.class;
  return (
    config.recognizedTitlePrefixes.find((entry) => title.startsWith(entry.prefix))
      ?.class ?? null
  );
}

function requiredEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string
): string {
  const value = environment[name];
  if (value === undefined || value === "") {
    throw new TypeError(`missing required environment variable ${name}`);
  }
  return value;
}

function optionalEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  return environment[name] ?? "";
}

function positiveInteger(value: string, name: string): number {
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new TypeError(`${name} exceeds the safe integer bound`);
  }
  return parsed;
}

export function validateRuntimeContext(
  config: IssueTaxonomyConfig,
  environment: NodeJS.ProcessEnv
): RuntimeContext {
  if (requiredEnvironment(environment, "GITHUB_REPOSITORY") !== config.repository.fullName) {
    throw new TypeError("workflow repository full name does not match the reviewed taxonomy");
  }
  if (
    positiveInteger(
      requiredEnvironment(environment, "GITHUB_REPOSITORY_ID"),
      "GITHUB_REPOSITORY_ID"
    ) !== config.repository.repositoryId
  ) {
    throw new TypeError("workflow repository numeric identity does not match the reviewed taxonomy");
  }
  if (requiredEnvironment(environment, "GITHUB_API_URL") !== "https://api.github.com") {
    throw new TypeError("issue taxonomy supports only the reviewed github.com API origin");
  }
  if (requiredEnvironment(environment, "GITHUB_SERVER_URL") !== "https://github.com") {
    throw new TypeError("issue taxonomy supports only the reviewed github.com server origin");
  }
  if (
    requiredEnvironment(environment, "GITHUB_REF") !==
    `refs/heads/${config.repository.defaultBranch}`
  ) {
    throw new TypeError("workflow ref is not the reviewed default branch");
  }
  const sha = requiredEnvironment(environment, "GITHUB_SHA");
  if (!/^[0-9a-f]{40}$/u.test(sha)) {
    throw new TypeError("GITHUB_SHA must be an exact lowercase commit SHA");
  }

  const eventName = requiredEnvironment(environment, "GITHUB_EVENT_NAME");
  if (eventName === "push") {
    const after = requiredEnvironment(environment, "EVENT_AFTER");
    if (after !== sha) {
      throw new TypeError("push event after SHA does not match the checked-out workflow SHA");
    }
    for (const name of [
      "EVENT_ACTION",
      "EVENT_ISSUE_NUMBER",
      "EVENT_ISSUE_ID",
      "EVENT_ISSUE_NODE_ID",
      "EVENT_ISSUE_REPOSITORY_URL",
      "EVENT_ISSUE_TITLE"
    ]) {
      if (optionalEnvironment(environment, name) !== "") {
        throw new TypeError(`push event unexpectedly supplied ${name}`);
      }
    }
    return { eventName, targetIssue: null };
  }
  if (eventName !== "issues") {
    throw new TypeError("issue taxonomy accepts only push and issues events");
  }
  if (requiredEnvironment(environment, "EVENT_ACTION") !== "opened") {
    throw new TypeError("issue taxonomy accepts only the issues.opened action");
  }
  if (optionalEnvironment(environment, "EVENT_AFTER") !== "") {
    throw new TypeError("issues event unexpectedly supplied EVENT_AFTER");
  }
  const repositoryUrl = requiredEnvironment(environment, "EVENT_ISSUE_REPOSITORY_URL");
  const expectedRepositoryUrl = `https://api.github.com/repos/${config.repository.fullName}`;
  if (repositoryUrl !== expectedRepositoryUrl) {
    throw new TypeError("issue event repository URL does not match the reviewed taxonomy");
  }
  return {
    eventName,
    targetIssue: {
      number: positiveInteger(
        requiredEnvironment(environment, "EVENT_ISSUE_NUMBER"),
        "EVENT_ISSUE_NUMBER"
      ),
      id: positiveInteger(
        requiredEnvironment(environment, "EVENT_ISSUE_ID"),
        "EVENT_ISSUE_ID"
      ),
      nodeId: requiredEnvironment(environment, "EVENT_ISSUE_NODE_ID"),
      repositoryUrl,
      title: requiredEnvironment(environment, "EVENT_ISSUE_TITLE")
    }
  };
}

function assertIssueMatches(
  expected: RepositoryIssue,
  actual: RepositoryIssue
): void {
  if (
    actual.number !== expected.number ||
    actual.id !== expected.id ||
    actual.nodeId !== expected.nodeId ||
    actual.repositoryUrl !== expected.repositoryUrl ||
    actual.title !== expected.title ||
    actual.state !== "open"
  ) {
    throw new TypeError(`issue #${expected.number} changed after taxonomy planning`);
  }
}

function expectedIssueFromEvent(target: NonNullable<RuntimeContext["targetIssue"]>): RepositoryIssue {
  return {
    ...target,
    state: "open",
    labels: []
  };
}

function labelForClass(
  config: IssueTaxonomyConfig,
  taxonomyClass: TaxonomyClass
): TaxonomyLabel {
  const label = config.labels.find((candidate) => candidate.class === taxonomyClass);
  if (label === undefined) {
    throw new TypeError(`missing label for taxonomy class ${taxonomyClass}`);
  }
  return label;
}

async function reconcileLabel(
  repository: TaxonomyRepository,
  label: TaxonomyLabel
): Promise<void> {
  const current = await repository.getLabel(label.name);
  if (current === null) {
    await repository.createLabel(label);
  } else if (
    current.name !== label.name ||
    current.color.toUpperCase() !== label.color ||
    current.description !== label.description
  ) {
    await repository.updateLabel(current.name, label);
  }
  const readback = await repository.getLabel(label.name);
  if (
    readback === null ||
    readback.name !== label.name ||
    readback.color.toUpperCase() !== label.color ||
    readback.description !== label.description
  ) {
    throw new TypeError(`label ${label.name} failed exact readback`);
  }
}

async function reconcileIssue(
  config: IssueTaxonomyConfig,
  repository: TaxonomyRepository,
  plannedIssue: RepositoryIssue,
  taxonomyClass: TaxonomyClass
): Promise<void> {
  const current = await repository.getIssue(plannedIssue.number);
  assertIssueMatches(plannedIssue, current);
  const desired = labelForClass(config, taxonomyClass);
  const taxonomyNames = new Map(
    config.labels.map((label) => [label.name.toLowerCase(), label.name])
  );
  const unrelatedBefore = current.labels
    .filter((name) => !taxonomyNames.has(name.toLowerCase()))
    .sort(compareCodeUnits);
  const conflicting = current.labels.filter((name) => {
    const canonical = taxonomyNames.get(name.toLowerCase());
    return canonical !== undefined && canonical !== desired.name;
  });
  for (const labelName of conflicting) {
    await repository.removeIssueLabel(current.number, labelName);
  }
  if (!current.labels.some((name) => name.toLowerCase() === desired.name.toLowerCase())) {
    await repository.addIssueLabel(current.number, desired.name);
  }
  const readback = await repository.getIssue(current.number);
  assertIssueMatches(plannedIssue, readback);
  const taxonomyAfter = readback.labels
    .filter((name) => taxonomyNames.has(name.toLowerCase()))
    .sort(compareCodeUnits);
  const unrelatedAfter = readback.labels
    .filter((name) => !taxonomyNames.has(name.toLowerCase()))
    .sort(compareCodeUnits);
  if (
    taxonomyAfter.length !== 1 ||
    taxonomyAfter[0] !== desired.name ||
    JSON.stringify(unrelatedAfter) !== JSON.stringify(unrelatedBefore)
  ) {
    throw new TypeError(`issue #${current.number} failed exact taxonomy readback`);
  }
}

export async function reconcileIssueTaxonomy(
  config: IssueTaxonomyConfig,
  context: RuntimeContext,
  repository: TaxonomyRepository
): Promise<readonly { readonly issueNumber: number; readonly class: TaxonomyClass }[]> {
  const issues =
    context.targetIssue === null
      ? await repository.listOpenIssues(config.limits)
      : [await repository.getIssue(context.targetIssue.number)];
  if (context.targetIssue !== null) {
    assertIssueMatches(expectedIssueFromEvent(context.targetIssue), issues[0]!);
  }
  if (issues.length > config.limits.maxOpenIssues) {
    throw new TypeError("open issue count exceeds the reviewed taxonomy limit");
  }
  const plan = issues.map((issue) => {
    if (issue.state !== "open") {
      throw new TypeError(`issue #${issue.number} is not open`);
    }
    const taxonomyClass = classifyIssue(config, issue.number, issue.title);
    if (taxonomyClass === null) {
      throw new TypeError(`issue #${issue.number} has no reviewed taxonomy mapping`);
    }
    return { issue, class: taxonomyClass };
  });

  for (const label of config.labels) {
    await reconcileLabel(repository, label);
  }
  for (const entry of plan) {
    await reconcileIssue(config, repository, entry.issue, entry.class);
  }
  return plan.map((entry) => ({
    issueNumber: entry.issue.number,
    class: entry.class
  }));
}

function parseIssue(value: unknown): RepositoryIssue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("GitHub issue response must be an object");
  }
  const issue = value as GitHubIssueResponse;
  if (
    !Number.isSafeInteger(issue.number) ||
    issue.number < 1 ||
    !Number.isSafeInteger(issue.id) ||
    issue.id < 1 ||
    typeof issue.node_id !== "string" ||
    issue.node_id === "" ||
    typeof issue.repository_url !== "string" ||
    typeof issue.title !== "string" ||
    (issue.state !== "open" && issue.state !== "closed") ||
    !Array.isArray(issue.labels) ||
    issue.pull_request !== undefined
  ) {
    throw new TypeError("GitHub issue response has an invalid shape");
  }
  const labels = issue.labels.map((label) => {
    if (typeof label === "string") return label;
    if (
      typeof label === "object" &&
      label !== null &&
      typeof label.name === "string" &&
      label.name !== ""
    ) {
      return label.name;
    }
    throw new TypeError(`GitHub issue #${issue.number} has a malformed label`);
  });
  return {
    number: issue.number,
    id: issue.id,
    nodeId: issue.node_id,
    repositoryUrl: issue.repository_url,
    title: issue.title,
    state: issue.state,
    labels
  };
}

function parseLabel(value: unknown): RepositoryLabel {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("GitHub label response must be an object");
  }
  const label = value as GitHubLabelResponse;
  if (
    typeof label.name !== "string" ||
    label.name === "" ||
    typeof label.color !== "string" ||
    !/^[0-9A-Fa-f]{6}$/u.test(label.color) ||
    (label.description !== null && typeof label.description !== "string")
  ) {
    throw new TypeError("GitHub label response has an invalid shape");
  }
  return {
    name: label.name,
    color: label.color,
    description: label.description ?? ""
  };
}

class GitHubRestRepository implements TaxonomyRepository {
  readonly #baseUrl: string;
  readonly #token: string;

  constructor(config: IssueTaxonomyConfig, token: string) {
    this.#baseUrl = `https://api.github.com/repos/${config.repository.fullName}`;
    this.#token = token;
  }

  async #request(method: string, route: string, body?: unknown): Promise<Response> {
    const response = await fetch(`${this.#baseUrl}${route}`, {
      method,
      redirect: "error",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.#token}`,
        "User-Agent": "agentic-framework-issue-taxonomy/1.0",
        "X-GitHub-Api-Version": API_VERSION,
        ...(body === undefined ? {} : { "Content-Type": "application/json" })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    if (!response.ok && response.status !== 404) {
      const detail = (await response.text()).slice(0, 1000);
      throw new Error(`GitHub API ${method} ${route} failed (${response.status}): ${detail}`);
    }
    return response;
  }

  async listOpenIssues(
    limits: IssueTaxonomyConfig["limits"]
  ): Promise<readonly RepositoryIssue[]> {
    const issues: RepositoryIssue[] = [];
    for (let page = 1; page <= limits.maxPages; page += 1) {
      const response = await this.#request(
        "GET",
        `/issues?state=open&per_page=100&page=${page}`
      );
      const value = (await response.json()) as unknown;
      if (!Array.isArray(value)) {
        throw new TypeError("GitHub open issue response must be an array");
      }
      const pageIssues = value
        .filter(
          (entry) =>
            typeof entry === "object" &&
            entry !== null &&
            !Array.isArray(entry) &&
            !("pull_request" in entry)
        )
        .map(parseIssue);
      issues.push(...pageIssues);
      if (issues.length > limits.maxOpenIssues) {
        throw new TypeError("open issue count exceeds the reviewed taxonomy limit");
      }
      if (value.length < 100) return issues;
    }
    throw new TypeError("open issue pagination exceeds the reviewed taxonomy page limit");
  }

  async getIssue(issueNumber: number): Promise<RepositoryIssue> {
    const response = await this.#request("GET", `/issues/${issueNumber}`);
    if (response.status === 404) {
      throw new TypeError(`issue #${issueNumber} does not exist in the reviewed repository`);
    }
    return parseIssue((await response.json()) as unknown);
  }

  async getLabel(labelName: string): Promise<RepositoryLabel | null> {
    const response = await this.#request("GET", `/labels/${encodeURIComponent(labelName)}`);
    if (response.status === 404) return null;
    return parseLabel((await response.json()) as unknown);
  }

  async createLabel(label: TaxonomyLabel): Promise<void> {
    const response = await this.#request("POST", "/labels", {
      name: label.name,
      color: label.color,
      description: label.description
    });
    if (response.status !== 201) {
      throw new Error(`creating label ${label.name} returned ${response.status}`);
    }
  }

  async updateLabel(currentName: string, label: TaxonomyLabel): Promise<void> {
    const response = await this.#request(
      "PATCH",
      `/labels/${encodeURIComponent(currentName)}`,
      {
        new_name: label.name,
        color: label.color,
        description: label.description
      }
    );
    if (response.status !== 200) {
      throw new Error(`updating label ${currentName} returned ${response.status}`);
    }
  }

  async addIssueLabel(issueNumber: number, labelName: string): Promise<void> {
    const response = await this.#request("POST", `/issues/${issueNumber}/labels`, {
      labels: [labelName]
    });
    if (response.status !== 200) {
      throw new Error(`labeling issue #${issueNumber} returned ${response.status}`);
    }
  }

  async removeIssueLabel(issueNumber: number, labelName: string): Promise<void> {
    const response = await this.#request(
      "DELETE",
      `/issues/${issueNumber}/labels/${encodeURIComponent(labelName)}`
    );
    if (response.status !== 200) {
      throw new Error(`removing ${labelName} from issue #${issueNumber} returned ${response.status}`);
    }
  }
}

async function main(): Promise<void> {
  if (process.argv.length !== 2) {
    throw new TypeError("issue taxonomy reconciliation is optionless");
  }
  const workspace = requiredEnvironment(process.env, "GITHUB_WORKSPACE");
  if (realpathSync(process.cwd()) !== realpathSync(workspace)) {
    throw new TypeError("issue taxonomy must run from the checked-out GitHub workspace root");
  }
  const config = loadIssueTaxonomyConfig(workspace);
  const context = validateRuntimeContext(config, process.env);
  const token = requiredEnvironment(process.env, "GITHUB_TOKEN");
  const repository = new GitHubRestRepository(config, token);
  const result = await reconcileIssueTaxonomy(config, context, repository);
  process.stdout.write(
    `${JSON.stringify({
      repository: config.repository.fullName,
      event: context.eventName,
      reconciled: result
    })}\n`
  );
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  await main();
}
