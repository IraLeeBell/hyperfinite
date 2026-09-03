import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parse } from "yaml";

import { REVIEWED_NON_AGENTIC_WORKFLOW_FILES } from "../src/runtime-workflow-validation.js";
import {
  classifyIssue,
  loadIssueTaxonomyConfig,
  reconcileIssueTaxonomy,
  validateRuntimeContext,
  type IssueTaxonomyConfig,
  type RepositoryIssue,
  type RepositoryLabel,
  type TaxonomyLabel,
  type TaxonomyRepository
} from "../scripts/reconcile-issue-taxonomy.js";

const ROOT = process.cwd();
const CONFIG = loadIssueTaxonomyConfig(ROOT);
const REPOSITORY_URL = "https://api.github.com/repos/IraLeeBell/hyperfinite";
const SHA = "a".repeat(40);

function issue(
  number: number,
  title: string,
  labels: readonly string[] = []
): RepositoryIssue {
  return {
    number,
    id: number + 1000,
    nodeId: `I_${number}`,
    repositoryUrl: REPOSITORY_URL,
    title,
    state: "open",
    labels
  };
}

function baseEnvironment(): NodeJS.ProcessEnv {
  return {
    GITHUB_REPOSITORY: "IraLeeBell/hyperfinite",
    GITHUB_REPOSITORY_ID: "1354883228",
    GITHUB_API_URL: "https://api.github.com",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: SHA,
    GITHUB_EVENT_NAME: "push",
    EVENT_AFTER: SHA,
    EVENT_ACTION: "",
    EVENT_ISSUE_NUMBER: "",
    EVENT_ISSUE_ID: "",
    EVENT_ISSUE_NODE_ID: "",
    EVENT_ISSUE_REPOSITORY_URL: "",
    EVENT_ISSUE_TITLE: ""
  };
}

class MemoryRepository implements TaxonomyRepository {
  readonly issues = new Map<number, RepositoryIssue>();
  readonly labels = new Map<string, RepositoryLabel>();
  readonly mutations: string[] = [];

  constructor(issues: readonly RepositoryIssue[]) {
    for (const current of issues) this.issues.set(current.number, current);
  }

  async listOpenIssues(): Promise<readonly RepositoryIssue[]> {
    return [...this.issues.values()].filter((current) => current.state === "open");
  }

  async getIssue(issueNumber: number): Promise<RepositoryIssue> {
    const current = this.issues.get(issueNumber);
    if (current === undefined) throw new Error(`missing issue ${issueNumber}`);
    return current;
  }

  async getLabel(labelName: string): Promise<RepositoryLabel | null> {
    return (
      [...this.labels.values()].find(
        (current) => current.name.toLowerCase() === labelName.toLowerCase()
      ) ?? null
    );
  }

  async createLabel(label: TaxonomyLabel): Promise<void> {
    this.mutations.push(`create:${label.name}`);
    this.labels.set(label.name, {
      name: label.name,
      color: label.color,
      description: label.description
    });
  }

  async updateLabel(currentName: string, label: TaxonomyLabel): Promise<void> {
    this.mutations.push(`update:${currentName}:${label.name}`);
    this.labels.delete(currentName);
    this.labels.set(label.name, {
      name: label.name,
      color: label.color,
      description: label.description
    });
  }

  async addIssueLabel(issueNumber: number, labelName: string): Promise<void> {
    this.mutations.push(`add:${issueNumber}:${labelName}`);
    const current = await this.getIssue(issueNumber);
    this.issues.set(issueNumber, {
      ...current,
      labels: [...current.labels, labelName]
    });
  }

  async removeIssueLabel(issueNumber: number, labelName: string): Promise<void> {
    this.mutations.push(`remove:${issueNumber}:${labelName}`);
    const current = await this.getIssue(issueNumber);
    this.issues.set(issueNumber, {
      ...current,
      labels: current.labels.filter((candidate) => candidate !== labelName)
    });
  }
}

test("issue taxonomy config is closed and covers the exact historical classifications", () => {
  assert.equal(CONFIG.repository.fullName, "IraLeeBell/hyperfinite");
  assert.equal(CONFIG.repository.repositoryId, 1354883228);
  assert.deepEqual(
    CONFIG.historicalIssues.map((entry) => [entry.issueNumber, entry.class]),
    [
      ...Array.from({ length: 6 }, (_, index) => [index + 1, "customer-evaluation"]),
      ...Array.from({ length: 4 }, (_, index) => [index + 7, "synthetic-demo"]),
      ...Array.from({ length: 8 }, (_, index) => [
        index + 11,
        "maintainer-development"
      ])
    ]
  );
});

test("classification uses only exact historical mappings or reviewed case-sensitive prefixes", () => {
  assert.equal(classifyIssue(CONFIG, 1, "arbitrary historical title"), "customer-evaluation");
  assert.equal(classifyIssue(CONFIG, 19, "[Development] Future work"), "maintainer-development");
  assert.equal(classifyIssue(CONFIG, 20, "[Demo] Future sample"), "synthetic-demo");
  assert.equal(
    classifyIssue(CONFIG, 21, "[Customer Feedback] Reproducible defect"),
    "customer-evaluation"
  );
  assert.equal(classifyIssue(CONFIG, 22, "[development] Wrong case"), null);
  assert.equal(classifyIssue(CONFIG, 23, " [Development] Leading space"), null);
  assert.equal(classifyIssue(CONFIG, 24, "[Unknown] No reviewed mapping"), null);
});

test("runtime context rejects every event and target outside the reviewed repository boundary", () => {
  assert.deepEqual(validateRuntimeContext(CONFIG, baseEnvironment()), {
    eventName: "push",
    targetIssue: null
  });
  for (const [name, value] of [
    ["GITHUB_REPOSITORY", "attacker/example"],
    ["GITHUB_REPOSITORY_ID", "1"],
    ["GITHUB_API_URL", "https://example.test"],
    ["GITHUB_REF", "refs/heads/feature"],
    ["GITHUB_EVENT_NAME", "pull_request"],
    ["EVENT_AFTER", "b".repeat(40)]
  ] as const) {
    const environment = { ...baseEnvironment(), [name]: value };
    assert.throws(() => validateRuntimeContext(CONFIG, environment));
  }
});

test("issues.opened binds the exact event issue and rejects wrong actions", () => {
  const environment = {
    ...baseEnvironment(),
    GITHUB_EVENT_NAME: "issues",
    EVENT_AFTER: "",
    EVENT_ACTION: "opened",
    EVENT_ISSUE_NUMBER: "19",
    EVENT_ISSUE_ID: "1019",
    EVENT_ISSUE_NODE_ID: "I_19",
    EVENT_ISSUE_REPOSITORY_URL: REPOSITORY_URL,
    EVENT_ISSUE_TITLE: "[Development] Future work"
  };
  assert.deepEqual(validateRuntimeContext(CONFIG, environment), {
    eventName: "issues",
    targetIssue: {
      number: 19,
      id: 1019,
      nodeId: "I_19",
      repositoryUrl: REPOSITORY_URL,
      title: "[Development] Future work"
    }
  });
  assert.throws(() =>
    validateRuntimeContext(CONFIG, { ...environment, EVENT_ACTION: "edited" })
  );
  assert.throws(() =>
    validateRuntimeContext(CONFIG, {
      ...environment,
      EVENT_ISSUE_REPOSITORY_URL: "https://api.github.com/repos/attacker/example"
    })
  );
});

test("reconciliation creates exact labels, replaces conflicts, and preserves unrelated labels", async () => {
  const repository = new MemoryRepository([
    issue(1, "historical", ["documentation", "type: synthetic-demo"]),
    issue(11, "historical", ["enhancement"])
  ]);
  repository.labels.set("type: customer-evaluation", {
    name: "type: customer-evaluation",
    color: "FFFFFF",
    description: "drifted"
  });
  const result = await reconcileIssueTaxonomy(
    CONFIG,
    { eventName: "push", targetIssue: null },
    repository
  );
  assert.deepEqual(result, [
    { issueNumber: 1, class: "customer-evaluation" },
    { issueNumber: 11, class: "maintainer-development" }
  ]);
  assert.deepEqual([...(await repository.getIssue(1)).labels].sort(), [
    "documentation",
    "type: customer-evaluation"
  ]);
  assert.deepEqual([...(await repository.getIssue(11)).labels].sort(), [
    "enhancement",
    "type: maintainer-development"
  ]);
  assert.equal(repository.labels.size, 3);
  assert.ok(
    repository.mutations.includes(
      "remove:1:type: synthetic-demo"
    )
  );
});

test("unrecognized issues fail before any label or issue mutation", async () => {
  const repository = new MemoryRepository([issue(19, "Unclassified future issue")]);
  await assert.rejects(
    reconcileIssueTaxonomy(
      CONFIG,
      { eventName: "push", targetIssue: null },
      repository
    ),
    /no reviewed taxonomy mapping/
  );
  assert.deepEqual(repository.mutations, []);
});

test("issues.opened refuses stale event identity before mutation", async () => {
  const repository = new MemoryRepository([issue(19, "[Development] Changed title")]);
  await assert.rejects(
    reconcileIssueTaxonomy(
      CONFIG,
      {
        eventName: "issues",
        targetIssue: {
          number: 19,
          id: 1019,
          nodeId: "I_19",
          repositoryUrl: REPOSITORY_URL,
          title: "[Development] Original title"
        }
      },
      repository
    ),
    /changed after taxonomy planning/
  );
  assert.deepEqual(repository.mutations, []);
});

test("workflow is merge/open-only, least-privileged, pinned, and customer-starter excluded", () => {
  assert.deepEqual(REVIEWED_NON_AGENTIC_WORKFLOW_FILES, [
    "reconcile-issue-taxonomy.yml"
  ]);
  const workflowText = readFileSync(
    ".github/workflows/reconcile-issue-taxonomy.yml",
    "utf8"
  );
  const workflow = parse(workflowText) as {
    on: Readonly<Record<string, unknown>>;
    permissions: Readonly<Record<string, unknown>>;
    jobs: {
      reconcile: {
        permissions: Readonly<Record<string, string>>;
        steps: readonly Readonly<Record<string, unknown>>[];
      };
    };
  };
  assert.deepEqual(Object.keys(workflow.on).sort(), ["issues", "push"]);
  assert.equal("pull_request" in workflow.on, false);
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(workflow.jobs.reconcile.permissions, {
    contents: "read",
    issues: "write"
  });
  const uses = workflow.jobs.reconcile.steps
    .map((step) => step.uses)
    .filter((value): value is string => typeof value === "string");
  assert.deepEqual(uses, [
    "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020"
  ]);
  assert.match(workflowText, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/u);
  assert.doesNotMatch(workflowText, /pull_request|personal.access.token|PAT_/iu);

  const core = JSON.parse(
    readFileSync("config/v1alpha1/customer-starter-selection.json", "utf8")
  ) as { excludedPaths: readonly string[] };
  const demo = JSON.parse(
    readFileSync(
      "config/v1alpha1/customer-starter-demo-portfolio-selection.json",
      "utf8"
    )
  ) as { excludedPaths: readonly string[] };
  assert.ok(core.excludedPaths.includes("config/v1alpha1/issue-taxonomy.json"));
  assert.ok(core.excludedPaths.includes("schemas/v1alpha1/issue-taxonomy.schema.json"));
  assert.ok(
    demo.excludedPaths.includes(".github/workflows/reconcile-issue-taxonomy.yml")
  );
});
