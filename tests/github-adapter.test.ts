import assert from "node:assert/strict";
import {
  createHmac,
  timingSafeEqual
} from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

import {
  API_VERSION,
  GITHUB_API_VERSION,
  GITHUB_PERMISSION_MANIFEST,
  GitHubApiError,
  GitHubAppCredentialBroker,
  GitHubBindingError,
  GitHubCredentialError,
  GitHubEvidenceConflictError,
  GitHubExecutionError,
  GitHubHttpOperations,
  GitHubProjectMigrationRegistry,
  GitHubSingleWriter,
  HmacWebhookSignatureVerifier,
  assertDocument,
  authorizeGitHubActor,
  canonicalJson,
  digest,
  exportProjectConfiguration,
  githubConcurrencyKey,
  importProjectConfiguration,
  normalizeGitHubWebhook,
  planProjectSetup,
  translateSafeOutput,
  validateDocument,
  type ActorAuthorizationInput,
  type AuthenticatedGitHubTransport,
  type GitHubActorAuthorizationSnapshot,
  type Digest,
  type GitHubApi,
  type GitHubAppSigner,
  type GitHubEffectObservation,
  type GitHubEffectPlan,
  type GitHubEvidenceHead,
  type GitHubEvidenceIdentity,
  type GitHubEvidenceRecord,
  type GitHubEvidenceServices,
  type GitHubEvidenceSignature,
  type GitHubEvidenceState,
  type GitHubSignedEvidence,
  type GitHubExecutionState,
  type GitHubHttpRequest,
  type GitHubHttpResponse,
  type GitHubInstallationScope,
  type GitHubPermissionGrant,
  type InstallationTokenMinter,
  type GitHubIssueIdentity,
  type GitHubProjectBinding,
  type GitHubProjectFieldValue,
  type GitHubProjectItemIdentity,
  type GitHubProjectSchema,
  type GitHubPullRequestIdentity,
  type GitHubRepositoryIdentity,
  type GitHubSafeOutput,
  type LiveGitHubProject,
  type MintedInstallationGrant,
  type SignedGitHubAppIdentity,
  type TrustedGitHubBinding
} from "../src/index.js";

const ROOT = process.cwd();
const NOW = "2026-08-26T20:10:00.000Z";
const CLAIMANT = digest({ run: "test-writer-1" });
const OTHER_CLAIMANT = digest({ run: "test-writer-2" });
const WEBHOOK_SECRET = Buffer.from("0123456789abcdef0123456789abcdef");

async function readJson(relativePath: string): Promise<unknown> {
  return JSON.parse(
    await readFile(path.resolve(ROOT, relativePath), "utf8")
  ) as unknown;
}

async function projectFixture(): Promise<{
  readonly schema: GitHubProjectSchema;
  readonly live: LiveGitHubProject;
  readonly binding: GitHubProjectBinding;
}> {
  const schema = assertDocument(
    "GitHubProjectSchema",
    await readJson("config/v1alpha1/github-project.json")
  );
  const live = (await readJson(
    "tests/fixtures/github/live-project.json"
  )) as LiveGitHubProject;
  const plan = planProjectSetup({ schema, live, evaluatedAt: NOW });
  assert.equal(plan.valid, true);
  assert.deepEqual(plan.actions, []);
  assert.notEqual(plan.binding, null);
  return { schema, live, binding: plan.binding! };
}

const repository: GitHubRepositoryIdentity = {
  id: 1001,
  nodeId: "R_kgDORepo",
  owner: "example-organization",
  name: "hyperfinite",
  fullName: "example-organization/hyperfinite"
};
const forkRepository: GitHubRepositoryIdentity = {
  id: 1002,
  nodeId: "R_kgDOFork",
  owner: "octocat",
  name: "hyperfinite",
  fullName: "octocat/hyperfinite"
};
const issue: GitHubIssueIdentity = {
  number: 4,
  nodeId: "I_kwDOIssue"
};
const pullRequest: GitHubPullRequestIdentity = {
  number: 3,
  nodeId: "PR_kwDOPull",
  base: {
    repository,
    ref: "main",
    sha: "1111111111111111111111111111111111111111"
  },
  head: {
    repository: forkRepository,
    ref: "feature",
    sha: "2222222222222222222222222222222222222222"
  }
};
const installation: GitHubInstallationScope = {
  id: 2001,
  accountNodeId: "O_kgDOOwner",
  repositorySelection: "selected",
  repositoryIds: [1001]
};

class BindingApi {
  currentRepository = repository;
  currentIssue = issue;
  currentPull = pullRequest;
  currentInstallation = installation;
  projectItem: GitHubProjectItemIdentity | null = {
    nodeId: "PVTI_synthetic_item",
    projectNodeId: "PVT_synthetic_kwDOProject",
    contentNodeId: issue.nodeId
  };

  async getRepository(): Promise<GitHubRepositoryIdentity> {
    return this.currentRepository;
  }

  async getIssue(): Promise<GitHubIssueIdentity> {
    return this.currentIssue;
  }

  async getPullRequest(): Promise<GitHubPullRequestIdentity> {
    return this.currentPull;
  }

  async getInstallationScope(): Promise<GitHubInstallationScope> {
    return this.currentInstallation;
  }

  async getProjectItem(
    projectNodeId: string,
    contentNodeId: string
  ): Promise<GitHubProjectItemIdentity | null> {
    if (this.projectItem === null) return null;
    return { ...this.projectItem, projectNodeId, contentNodeId };
  }
}

function signedWebhook(
  payload: unknown,
  event: "issues" | "pull_request"
): {
  readonly rawBody: Uint8Array;
  readonly headers: Readonly<Record<string, string>>;
} {
  const rawBody = Buffer.from(JSON.stringify(payload));
  return {
    rawBody,
    headers: {
      "x-github-delivery": `delivery-${event}`,
      "x-github-event": event,
      "x-hub-signature-256": `sha256=${createHmac("sha256", WEBHOOK_SECRET)
        .update(rawBody)
        .digest("hex")}`
    }
  };
}

test("declarative Project schema contains no live GitHub IDs", async () => {
  const { schema } = await projectFixture();
  assert.equal(JSON.stringify(schema).includes("nodeId"), false);
  assert.equal(JSON.stringify(schema).includes("installation"), false);
  assert.equal(schema.projections.length, 7);
});

test("Project setup is dry-run and produces a validated binding", async () => {
  const { schema, binding } = await projectFixture();
  assert.equal(binding.projectSchemaDigest, digest(schema));
  assert.equal(binding.project.nodeId, "PVT_synthetic_kwDOProject");
  assert.equal(binding.fields.length, schema.fields.length);
});

test("OWNER schema placeholder accepts the authenticated customer organization", async () => {
  const { schema, live } = await projectFixture();
  const customerLive = {
    ...live,
    owner: {
      ...live.owner,
      login: "example-organization"
    }
  };
  const plan = planProjectSetup({
    schema,
    live: customerLive,
    evaluatedAt: NOW
  });
  assert.equal(plan.valid, true);
  assert.deepEqual(plan.actions, []);
  assert.notEqual(plan.binding, null);
});

test("Project schema drift requires explicit human-admin actions", async () => {
  const { schema, live } = await projectFixture();
  const drifted = structuredClone(live) as {
    project: NonNullable<LiveGitHubProject["project"]>;
    fields: LiveGitHubProject["fields"];
  } & Omit<LiveGitHubProject, "project" | "fields">;
  drifted.fields = drifted.fields.map((field) =>
    field.name === "Stage"
      ? {
          ...field,
          options: field.options.filter((option) => option.name !== "Blocked")
        }
      : field
  );
  const plan = planProjectSetup({ schema, live: drifted, evaluatedAt: NOW });
  assert.equal(plan.binding, null);
  assert.deepEqual(
    plan.actions.filter((action) => action.type === "create-option"),
    [
      {
        type: "create-option",
        fieldKey: "stage",
        optionKey: "blocked",
        name: "Blocked",
        requiresHumanAdmin: true
      }
    ]
  );
});

test("Project export/import binds schema and live IDs", async () => {
  const { schema, binding } = await projectFixture();
  const serialized = exportProjectConfiguration(schema, binding);
  assert.deepEqual(importProjectConfiguration(serialized), {
    format: "agentic-framework.github-project/v1",
    schema,
    binding
  });
  const substituted = JSON.parse(serialized) as Record<string, unknown>;
  const substitutedBinding = substituted.binding as Record<string, unknown>;
  substitutedBinding.projectSchemaDigest = digest({ substituted: true });
  assert.throws(
    () => importProjectConfiguration(JSON.stringify(substituted)),
    /does not match/
  );
});

test("Project migrations are dry-run and deterministic", async () => {
  const { schema } = await projectFixture();
  const registry = new GitHubProjectMigrationRegistry();
  registry.register({
    from: "1.0.0",
    to: "1.1.0",
    migrate: (source) => ({
      ...source,
      metadata: { ...source.metadata, version: "1.1.0" }
    })
  });
  const result = registry.migrate({ schema, to: "1.1.0" });
  assert.equal(result.dryRun, true);
  assert.equal(result.schema.metadata.version, "1.1.0");

  registry.register({
    from: "1.0.0",
    to: "1.2.0",
    migrate: (source) => ({
      ...source,
      metadata: {
        ...source.metadata,
        version: Math.random() > -1 ? "1.2.0" : "never"
      },
      project: { ...source.project, title: `${source.project.title}${Math.random()}` }
    })
  });
  assert.throws(
    () => registry.migrate({ schema, to: "1.2.0" }),
    /deterministic/
  );
});

test("verified issue event resolves exact fresh binding", async () => {
  const payload = await readJson("tests/fixtures/github/issues-opened.json");
  const request = signedWebhook(payload, "issues");
  const { binding } = await projectFixture();
  const api = new BindingApi();
  const normalized = await normalizeGitHubWebhook({
    ...request,
    verifier: new HmacWebhookSignatureVerifier(WEBHOOK_SECRET),
    api,
    projectBinding: binding
  });
  assert.equal(normalized.deliveryId, "delivery-issues");
  assert.equal(normalized.binding.repository.id, 1001);
  assert.equal(normalized.binding.workItem.nodeId, issue.nodeId);
  assert.equal(normalized.binding.project.itemNodeId, "PVTI_synthetic_item");
});

test("webhook verification rejects invalid signatures before reads", async () => {
  const payload = await readJson("tests/fixtures/github/issues-opened.json");
  const request = signedWebhook(payload, "issues");
  const { binding } = await projectFixture();
  let reads = 0;
  const api = new BindingApi();
  api.getRepository = async () => {
    reads += 1;
    return repository;
  };
  await assert.rejects(
    normalizeGitHubWebhook({
      ...request,
      headers: { ...request.headers, "x-hub-signature-256": "sha256=bad" },
      verifier: new HmacWebhookSignatureVerifier(WEBHOOK_SECRET),
      api,
      projectBinding: binding
    }),
    (error: unknown) =>
      error instanceof GitHubBindingError &&
      error.code === "INVALID_SIGNATURE"
  );
  assert.equal(reads, 0);
});

test("wrong repository and issue substitutions fail closed", async () => {
  const payload = await readJson("tests/fixtures/github/issues-opened.json");
  const request = signedWebhook(payload, "issues");
  const { binding } = await projectFixture();

  const wrongRepository = new BindingApi();
  wrongRepository.currentRepository = {
    ...repository,
    id: 9999
  };
  await assert.rejects(
    normalizeGitHubWebhook({
      ...request,
      verifier: new HmacWebhookSignatureVerifier(WEBHOOK_SECRET),
      api: wrongRepository,
      projectBinding: binding
    }),
    (error: unknown) =>
      error instanceof GitHubBindingError &&
      error.code === "REPOSITORY_MISMATCH"
  );

  const wrongIssue = new BindingApi();
  wrongIssue.currentIssue = { ...issue, nodeId: "I_substituted" };
  await assert.rejects(
    normalizeGitHubWebhook({
      ...request,
      verifier: new HmacWebhookSignatureVerifier(WEBHOOK_SECRET),
      api: wrongIssue,
      projectBinding: binding
    }),
    (error: unknown) =>
      error instanceof GitHubBindingError &&
      error.code === "WORK_ITEM_MISMATCH"
  );
});

test("fork pull request binds both repositories and exact SHAs", async () => {
  const payload = await readJson(
    "tests/fixtures/github/pull-request-opened-fork.json"
  );
  const request = signedWebhook(payload, "pull_request");
  const { binding } = await projectFixture();
  const api = new BindingApi();
  api.projectItem = {
    nodeId: "PVTI_synthetic_pull",
    projectNodeId: binding.project.nodeId,
    contentNodeId: pullRequest.nodeId
  };
  const normalized = await normalizeGitHubWebhook({
    ...request,
    verifier: new HmacWebhookSignatureVerifier(WEBHOOK_SECRET),
    api,
    projectBinding: binding
  });
  assert.equal(normalized.binding.workItem.kind, "pull-request");
  if (normalized.binding.workItem.kind === "pull-request") {
    assert.equal(normalized.binding.workItem.base.repository.id, 1001);
    assert.equal(normalized.binding.workItem.head.repository.id, 1002);
    assert.equal(
      normalized.binding.workItem.head.sha,
      "2222222222222222222222222222222222222222"
    );
  }
});

test("wrong fork repository or pull head substitution fails closed", async () => {
  const payload = await readJson(
    "tests/fixtures/github/pull-request-opened-fork.json"
  );
  const request = signedWebhook(payload, "pull_request");
  const { binding } = await projectFixture();
  const api = new BindingApi();
  api.currentPull = {
    ...pullRequest,
    head: {
      ...pullRequest.head,
      repository: { ...forkRepository, id: 9999 },
      sha: "3333333333333333333333333333333333333333"
    }
  };
  await assert.rejects(
    normalizeGitHubWebhook({
      ...request,
      verifier: new HmacWebhookSignatureVerifier(WEBHOOK_SECRET),
      api,
      projectBinding: binding
    }),
    (error: unknown) =>
      error instanceof GitHubBindingError &&
      error.code === "PULL_REQUEST_MISMATCH"
  );

  const wrongRef = new BindingApi();
  wrongRef.currentPull = {
    ...pullRequest,
    head: { ...pullRequest.head, ref: "substituted" }
  };
  await assert.rejects(
    normalizeGitHubWebhook({
      ...request,
      verifier: new HmacWebhookSignatureVerifier(WEBHOOK_SECRET),
      api: wrongRef,
      projectBinding: binding
    }),
    (error: unknown) =>
      error instanceof GitHubBindingError &&
      error.code === "PULL_REQUEST_MISMATCH"
  );
});

test("installation and Project substitutions fail closed", async () => {
  const payload = await readJson("tests/fixtures/github/issues-opened.json");
  const request = signedWebhook(payload, "issues");
  const { binding } = await projectFixture();
  const wrongInstallation = new BindingApi();
  wrongInstallation.currentInstallation = {
    ...installation,
    id: 9999
  };
  await assert.rejects(
    normalizeGitHubWebhook({
      ...request,
      verifier: new HmacWebhookSignatureVerifier(WEBHOOK_SECRET),
      api: wrongInstallation,
      projectBinding: binding
    }),
    (error: unknown) =>
      error instanceof GitHubBindingError &&
      error.code === "INSTALLATION_MISMATCH"
  );

  const wrongProject = new BindingApi();
  wrongProject.projectItem = null;
  await assert.rejects(
    normalizeGitHubWebhook({
      ...request,
      verifier: new HmacWebhookSignatureVerifier(WEBHOOK_SECRET),
      api: wrongProject,
      projectBinding: binding
    }),
    (error: unknown) =>
      error instanceof GitHubBindingError &&
      error.code === "PROJECT_MISMATCH"
  );
});

function safeOutput(): GitHubSafeOutput {
  return {
    apiVersion: API_VERSION,
    kind: "GitHubSafeOutput",
    schemaVersion: "1.0.0",
    summary: "The deterministic checks completed.",
    findings: [
      { code: "CONTROL_OK", severity: "info", message: "No drift found." }
    ],
    openQuestions: [],
    result: { status: "success", details: "Ready for human review." }
  };
}

async function trustedIssueBinding(): Promise<TrustedGitHubBinding> {
  const { binding } = await projectFixture();
  return {
    repository,
    workItem: { kind: "issue", ...issue },
    project: {
      ownerNodeId: binding.owner.nodeId,
      projectNodeId: binding.project.nodeId,
      itemNodeId: "PVTI_synthetic_item",
      schemaDigest: binding.projectSchemaDigest,
      bindingDigest: digest(binding),
      fields: binding.fields
    },
    installation
  };
}

async function issuePlan(): Promise<{
  readonly binding: TrustedGitHubBinding;
  readonly plan: GitHubEffectPlan;
}> {
  const binding = await trustedIssueBinding();
  const plan = translateSafeOutput({
    output: safeOutput(),
    intent: { type: "issue-comment" },
    binding,
    eventId: "delivery-issues:opened",
    contractRevision: 1,
    contractDigest: digest({ contract: 1 }),
    receiptHead: null,
    routeId: "capture-to-activation",
    attempt: 1
  });
  return { binding, plan };
}

async function pullPlan(): Promise<{
  readonly binding: TrustedGitHubBinding;
  readonly plan: GitHubEffectPlan;
}> {
  const issueBinding = await trustedIssueBinding();
  const binding: TrustedGitHubBinding = {
    ...issueBinding,
    workItem: { kind: "pull-request", ...pullRequest }
  };
  return {
    binding,
    plan: translateSafeOutput({
      output: safeOutput(),
      intent: { type: "check-run", name: "Hyperfinite" },
      binding,
      eventId: "pull",
      contractRevision: 1,
      contractDigest: digest({ contract: 1 }),
      receiptHead: null,
      routeId: "verify",
      attempt: 1
    })
  };
}

async function reviewCommentPlan(): Promise<{
  readonly binding: TrustedGitHubBinding;
  readonly plan: GitHubEffectPlan;
}> {
  const issueBinding = await trustedIssueBinding();
  const binding: TrustedGitHubBinding = {
    ...issueBinding,
    workItem: { kind: "pull-request", ...pullRequest }
  };
  return {
    binding,
    plan: translateSafeOutput({
      output: safeOutput(),
      intent: { type: "pull-request-review-comment", event: "COMMENT" },
      binding,
      eventId: "review",
      contractRevision: 1,
      contractDigest: digest({ contract: 1 }),
      receiptHead: null,
      routeId: "review-current-head",
      attempt: 1
    })
  };
}

async function projectEffectPlan(): Promise<{
  readonly binding: TrustedGitHubBinding;
  readonly plan: GitHubEffectPlan;
}> {
  const binding = await trustedIssueBinding();
  return {
    binding,
    plan: translateSafeOutput({
      output: safeOutput(),
      intent: {
        type: "project-field-update",
        fieldKey: "stage",
        expectedCurrentValue: {
          kind: "single-select",
          optionNodeId: "OPT_captured"
        },
        value: { kind: "single-select", optionKey: "blocked" }
      },
      binding,
      eventId: "project",
      contractRevision: 1,
      contractDigest: digest({ contract: 1 }),
      receiptHead: null,
      routeId: "project",
      attempt: 1
    })
  };
}

test("safe-output schema rejects target-bearing and unknown fields", () => {
  const targetBearing = {
    ...safeOutput(),
    repository: "example-organization/hyperfinite",
    issueNumber: 4,
    effect: "merge"
  };
  const result = validateDocument("GitHubSafeOutput", targetBearing);
  assert.equal(result.valid, false);
});

test("safe output translation gets all targets only from Trusted Binding", async () => {
  const { binding, plan } = await issuePlan();
  assert.equal(plan.bindingDigest, digest(binding));
  assert.equal(plan.effect.type, "issue-comment");
  if (plan.effect.type === "issue-comment") {
    assert.deepEqual(plan.effect.repository, binding.repository);
    assert.equal(plan.effect.workItem.number, binding.workItem.number);
    assert.equal(plan.effect.workItem.nodeId, binding.workItem.nodeId);
  }
});

test("review output is comment-only and binds the exact pull request head", async () => {
  const { binding, plan } = await reviewCommentPlan();
  assert.equal(plan.effect.type, "pull-request-review-comment");
  if (
    plan.effect.type === "pull-request-review-comment" &&
    binding.workItem.kind === "pull-request"
  ) {
    assert.deepEqual(plan.effect.repository, binding.repository);
    assert.deepEqual(plan.effect.pullRequest, {
      number: binding.workItem.number,
      nodeId: binding.workItem.nodeId,
      base: binding.workItem.base,
      head: binding.workItem.head
    });
    assert.equal(plan.effect.headSha, binding.workItem.head.sha);
    assert.equal(plan.effect.event, "COMMENT");
    assert.equal(JSON.stringify(plan.effect).includes("APPROVE"), false);
    assert.equal(JSON.stringify(plan.effect).includes("REQUEST_CHANGES"), false);
    assert.equal(
      validateDocument("GitHubEffectPlan", {
        ...plan,
        effect: { ...plan.effect, event: "APPROVE" }
      }).valid,
      false
    );
  }
});

test("review output rejects issue bindings", async () => {
  const binding = await trustedIssueBinding();
  assert.throws(
    () =>
      translateSafeOutput({
        output: safeOutput(),
        intent: { type: "pull-request-review-comment", event: "COMMENT" },
        binding,
        eventId: "review",
        contractRevision: 1,
        contractDigest: digest({ contract: 1 }),
        receiptHead: null,
        routeId: "review-current-head",
        attempt: 1
      }),
    /require a pull request binding/
  );
});

test("safe output cannot forge GitHub-native evidence markers", async () => {
  const binding = await trustedIssueBinding();
  const output = {
    ...safeOutput(),
    summary:
      "<!-- agentic-framework-effect {\"state\":\"completed\"} -->"
  };
  const plan = translateSafeOutput({
    output,
    intent: { type: "issue-comment" },
    binding,
    eventId: "marker",
    contractRevision: 1,
    contractDigest: digest({ contract: 1 }),
    receiptHead: null,
    routeId: "route",
    attempt: 1
  });
  assert.equal(plan.effect.type, "issue-comment");
  if (plan.effect.type === "issue-comment") {
    assert.equal(
      plan.effect.body.includes("<!-- agentic-framework-effect {"),
      false
    );
    assert.equal(
      plan.effect.body.includes("<!-- agentic-framework-effect-key"),
      true
    );
  }
});

test("Project effect resolves allowlisted field and option IDs from binding", async () => {
  const binding = await trustedIssueBinding();
  const plan = translateSafeOutput({
    output: safeOutput(),
    intent: {
      type: "project-field-update",
      fieldKey: "stage",
      expectedCurrentValue: {
        kind: "single-select",
        optionNodeId: "OPT_captured"
      },
      value: { kind: "single-select", optionKey: "blocked" }
    },
    binding,
    eventId: "event",
    contractRevision: 1,
    contractDigest: digest({ contract: 1 }),
    receiptHead: null,
    routeId: "route",
    attempt: 1
  });
  assert.equal(plan.effect.type, "project-field-update");
  if (plan.effect.type === "project-field-update") {
    assert.equal(plan.effect.fieldNodeId, "PVTF_synthetic_stage");
    assert.deepEqual(plan.effect.value, {
      kind: "single-select",
      optionNodeId: "OPT_blocked"
    });
  }
});

const EVIDENCE_IDENTITY: GitHubEvidenceIdentity = {
  applicationId: 7001,
  authorId: 7002
};
const EVIDENCE_KEY = Buffer.from(
  "github-effect-evidence-test-key-32-bytes"
);

function evidenceSignature(
  identity: GitHubEvidenceIdentity,
  evidence: GitHubEvidenceState
): GitHubEvidenceSignature {
  return {
    algorithm: "HMAC-SHA256-TEST",
    keyId: "test-key-1",
    value: createHmac("sha256", EVIDENCE_KEY)
      .update(canonicalJson({ identity, evidence }))
      .digest("hex")
  };
}

function signedEvidenceDigest(record: GitHubEvidenceRecord): `sha256:${string}` {
  return digest({
    identity: {
      applicationId: record.applicationId,
      authorId: record.authorId
    },
    evidence: record.evidence,
    signature: record.signature
  });
}

function mockEvidenceHead(
  record: GitHubEvidenceRecord
): GitHubEvidenceHead {
  return {
    nodeId: record.nodeId,
    sequence: record.evidence.sequence,
    evidenceDigest: signedEvidenceDigest(record)
  };
}

const testEvidenceServices: Omit<GitHubEvidenceServices, "store"> = {
  identity: EVIDENCE_IDENTITY,
  signer: {
    async signEvidence({ identity, evidence }) {
      return evidenceSignature(identity, evidence);
    }
  },
  verifier: {
    async verifyEvidence({ identity, evidence, signature }) {
      const expected = evidenceSignature(identity, evidence);
      if (
        signature.algorithm !== expected.algorithm ||
        signature.keyId !== expected.keyId
      ) {
        return false;
      }
      const actualBytes = Buffer.from(signature.value);
      const expectedBytes = Buffer.from(expected.value);
      return (
        actualBytes.length === expectedBytes.length &&
        timingSafeEqual(actualBytes, expectedBytes)
      );
    }
  }
};

class MockGitHubApi extends BindingApi implements GitHubApi {
  evidence: GitHubEvidenceRecord[] = [];
  evidenceHead: GitHubEvidenceHead | null = null;
  observation: GitHubEffectObservation | null = null;
  applyBehavior: "success" | "fail-before" | "fail-after" | "rate-limited" =
    "success";
  rateLimitRetryAfterMs = 1000;
  claimBehavior:
    | "success"
    | "ambiguous-completed"
    | "ambiguous-own"
    | "ambiguous-other"
    | "ambiguous-partial"
    | "ambiguous-retryable" = "success";
  ambiguousEffectDigest: `sha256:${string}` | null = null;
  evidenceStateSequence: GitHubEvidenceState["state"][] = [];
  conflictOnSequence: number | null = null;
  conflictWithSubmittedEvidence = false;
  applyCount = 0;
  executionStateReads = 0;
  stalePullHeadOnRead: number | null = null;
  beforeConditionalApply: (() => void) | null = null;
  state!: GitHubExecutionState;
  projectValue: GitHubProjectFieldValue | null = null;
  authorization: GitHubActorAuthorizationSnapshot = {
    actorId: 3001,
    actorNodeId: "U_kgDOUser",
    login: "octocat",
    bot: false,
    repositoryPermission: "maintain",
    organizationRole: "direct_member",
    teamNodeIds: ["T_core"],
    reviewCommitId: null
  };

  async readExecutionState(): Promise<GitHubExecutionState> {
    this.executionStateReads += 1;
    if (
      this.stalePullHeadOnRead === this.executionStateReads &&
      this.state.binding.workItem.kind === "pull-request"
    ) {
      this.state = {
        ...this.state,
        binding: {
          ...this.state.binding,
          workItem: {
            ...this.state.binding.workItem,
            head: {
              ...this.state.binding.workItem.head,
              sha: "f".repeat(40)
            }
          }
        }
      };
    }
    return this.state;
  }

  setEvidence(records: readonly GitHubEvidenceRecord[]): void {
    this.evidence = structuredClone([...records]);
    const latest = this.evidence.at(-1);
    this.evidenceHead =
      latest === undefined ? null : mockEvidenceHead(latest);
  }

  private appendTransition(
    update: Pick<
      GitHubEvidenceState,
      | "state"
      | "effectDigest"
      | "writeAttempts"
      | "retryAfterMs"
      | "retryNotBefore"
      | "lastError"
    >
  ): GitHubEvidenceRecord {
    const current = this.evidence.at(-1);
    if (current === undefined) throw new Error("missing evidence");
    const state: GitHubEvidenceState = {
      ...current.evidence,
      sequence: current.evidence.sequence + 1,
      priorSequence: current.evidence.sequence,
      priorEvidenceDigest: signedEvidenceDigest(current),
      ...update,
      updatedAt: NOW
    };
    const record: GitHubEvidenceRecord = {
      nodeId: `IC_${this.evidence.length + 1}`,
      applicationId: EVIDENCE_IDENTITY.applicationId,
      authorId: EVIDENCE_IDENTITY.authorId,
      evidence: state,
      signature: evidenceSignature(EVIDENCE_IDENTITY, state)
    };
    this.evidence.push(record);
    this.evidenceHead = mockEvidenceHead(record);
    return record;
  }

  readEvidenceSnapshot(): {
    readonly records: readonly unknown[];
    readonly head: GitHubEvidenceHead | null;
  } {
    const current = this.evidence.at(-1);
    const state =
      current === undefined ? undefined : this.evidenceStateSequence.shift();
    if (
      state !== undefined &&
      current !== undefined &&
      state !== current.evidence.state
    ) {
      const writeAttempts =
        state === "retryable" || state === "completed"
          ? Math.max(1, current.evidence.writeAttempts)
          : current.evidence.writeAttempts;
      if (state === "retryable" && current.evidence.writeAttempts === 0) {
        this.appendTransition({
          state: "pending",
          effectDigest: null,
          writeAttempts: 1,
          retryAfterMs: null,
          retryNotBefore: null,
          lastError: null
        });
      }
      this.appendTransition({
        state,
        effectDigest:
          state === "completed" ? this.ambiguousEffectDigest : null,
        writeAttempts,
        retryAfterMs: state === "retryable" ? 0 : null,
        retryNotBefore: state === "retryable" ? NOW : null,
        lastError:
          state === "retryable"
            ? {
                code: "RATE_LIMITED",
                status: 429,
                retryable: true,
                outcomeAmbiguous: false
              }
            : state === "partial"
              ? {
                  code: "UNOBSERVED_WRITE",
                  status: null,
                  retryable: false,
                  outcomeAmbiguous: true
                }
              : null
      });
    }
    return structuredClone({
      records: this.evidence,
      head: this.evidenceHead
    });
  }

  appendEvidence(
    expectedHead: GitHubEvidenceHead | null,
    signed: GitHubSignedEvidence
  ): GitHubEvidenceRecord {
    const makeRecord = (
      evidence: GitHubEvidenceState,
      identity: GitHubEvidenceIdentity = EVIDENCE_IDENTITY
    ): GitHubEvidenceRecord => ({
      nodeId: `IC_${this.evidence.length + 1}`,
      applicationId: identity.applicationId,
      authorId: identity.authorId,
      evidence,
      signature: evidenceSignature(identity, evidence)
    });
    if (
      this.conflictOnSequence === signed.evidence.sequence &&
      this.conflictWithSubmittedEvidence
    ) {
      const winner = {
        ...makeRecord(signed.evidence),
        signature: signed.signature
      };
      this.evidence.push(winner);
      this.evidenceHead = mockEvidenceHead(winner);
    }
    if (
      this.conflictOnSequence === signed.evidence.sequence ||
      digest(expectedHead) !== digest(this.evidenceHead)
    ) {
      throw new GitHubEvidenceConflictError(
        this.evidenceHead === null
          ? null
          : structuredClone(this.evidenceHead)
      );
    }
    let record: GitHubEvidenceRecord = {
      ...makeRecord(signed.evidence),
      signature: signed.signature
    };
    if (
      expectedHead === null &&
      this.claimBehavior === "ambiguous-other"
    ) {
      const evidence = {
        ...signed.evidence,
        claimantId: OTHER_CLAIMANT,
        operationDigest: digest({
          claimantId: OTHER_CLAIMANT,
          planDigest: signed.evidence.planDigest
        })
      };
      record = makeRecord(evidence);
    }
    this.evidence.push(record);
    this.evidenceHead = mockEvidenceHead(record);
    if (
      expectedHead === null &&
      this.claimBehavior === "ambiguous-completed"
    ) {
      this.appendTransition({
        state: "completed",
        effectDigest: this.ambiguousEffectDigest,
        writeAttempts: 1,
        retryAfterMs: null,
        retryNotBefore: null,
        lastError: null
      });
    } else if (
      expectedHead === null &&
      this.claimBehavior === "ambiguous-partial"
    ) {
      this.appendTransition({
        state: "partial",
        effectDigest: null,
        writeAttempts: 0,
        retryAfterMs: null,
        retryNotBefore: null,
        lastError: {
          code: "UNOBSERVED_WRITE",
          status: null,
          retryable: false,
          outcomeAmbiguous: true
        }
      });
    } else if (
      expectedHead === null &&
      this.claimBehavior === "ambiguous-retryable"
    ) {
      this.appendTransition({
        state: "pending",
        effectDigest: null,
        writeAttempts: 1,
        retryAfterMs: null,
        retryNotBefore: null,
        lastError: null
      });
      this.appendTransition({
        state: "retryable",
        effectDigest: null,
        writeAttempts: 1,
        retryAfterMs: 0,
        retryNotBefore: NOW,
        lastError: {
          code: "RATE_LIMITED",
          status: 429,
          retryable: true,
          outcomeAmbiguous: false
        }
      });
    }
    if (expectedHead === null && this.claimBehavior !== "success") {
      throw new GitHubApiError(
        "TIMEOUT",
        "claim acknowledgement lost",
        null,
        true,
        true
      );
    }
    return record;
  }

  async applyEffect(
    _binding: TrustedGitHubBinding,
    plan: GitHubEffectPlan,
    precondition: {
      readonly bindingDigest: Digest;
      readonly planDigest: Digest;
      readonly effectDigest: Digest;
      readonly executionStateDigest: Digest;
      readonly expectedHeadSha: string | null;
    }
  ): Promise<GitHubEffectObservation> {
    this.beforeConditionalApply?.();
    const currentHead =
      this.state.binding.workItem.kind === "pull-request"
        ? this.state.binding.workItem.head.sha
        : null;
    if (
      precondition.bindingDigest !== digest(_binding) ||
      precondition.planDigest !== digest(plan) ||
      precondition.effectDigest !== digest(plan.effect) ||
      precondition.executionStateDigest !== digest(this.state) ||
      precondition.expectedHeadSha !==
        (plan.effect.type === "pull-request-review-comment"
          ? currentHead
          : null)
    ) {
      throw new GitHubApiError(
        "VALIDATION_FAILED",
        "atomic effect precondition changed",
        412,
        false,
        false
      );
    }
    this.applyCount += 1;
    if (this.applyBehavior === "fail-before") {
      throw new GitHubApiError(
        "SERVER_ERROR",
        "write failed",
        500,
        true,
        true
      );
    }
    if (this.applyBehavior === "rate-limited") {
      throw new GitHubApiError(
        "RATE_LIMITED",
        "retry later",
        429,
        true,
        false,
        this.rateLimitRetryAfterMs
      );
    }
    this.observation = {
      nodeId: "EFFECT_1",
      effectDigest: digest(plan.effect)
    };
    if (this.applyBehavior === "fail-after") {
      throw new GitHubApiError(
        "TIMEOUT",
        "acknowledgement lost",
        null,
        true,
        true
      );
    }
    return this.observation;
  }

  async observeEffect(): Promise<GitHubEffectObservation | null> {
    return this.observation;
  }

  async getProjectFieldValue(): Promise<GitHubProjectFieldValue | null> {
    return this.projectValue;
  }

  async getActorAuthorization(): Promise<GitHubActorAuthorizationSnapshot> {
    return this.authorization;
  }
}

function evidenceServices(
  overrides: Partial<GitHubEvidenceServices> = {}
): GitHubEvidenceServices {
  return {
    ...testEvidenceServices,
    store: {
      supportsAuthenticatedConditionalAppend: true,
      async readEvidence(api) {
        assert.equal(api instanceof MockGitHubApi, true);
        return (api as MockGitHubApi).readEvidenceSnapshot();
      },
      async conditionalAppendEvidence(api, _binding, expectedHead, evidence) {
        assert.equal(api instanceof MockGitHubApi, true);
        return (api as MockGitHubApi).appendEvidence(expectedHead, evidence);
      }
    },
    ...overrides
  };
}

function credentialBroker(
  api: GitHubApi,
  mutateGrant: (
    grant: MintedInstallationGrant
  ) => MintedInstallationGrant = (grant) => grant,
  onSign: () => void = () => {}
): GitHubAppCredentialBroker {
  return new GitHubAppCredentialBroker(
    {
      async withSignedIdentity<T>(
        _request: {
          readonly algorithm: "RS256";
          readonly issuer: string;
          readonly issuedAt: string;
          readonly expiresAt: string;
        },
        operation: (identity: SignedGitHubAppIdentity) => Promise<T>
      ): Promise<T> {
        onSign();
        return operation({ kind: "signed-github-app-identity" });
      }
    },
    {
      async withInstallationClient<T>(
        _identity: SignedGitHubAppIdentity,
        request: {
          readonly installationId: number;
          readonly repositoryIds: readonly number[];
          readonly permissions: MintedInstallationGrant["permissions"];
        },
        operation: (
          client: GitHubApi,
          grant: MintedInstallationGrant
        ) => Promise<T>
      ): Promise<T> {
        const grant = mutateGrant({
          installationId: request.installationId,
          repositoryIds: request.repositoryIds,
          permissions: request.permissions,
          expiresAt: "2026-08-26T20:40:00.000Z"
        });
        return operation(api, grant);
      }
    },
    "Iv1.test-client",
    () => new Date(NOW)
  );
}

async function writerFixture(): Promise<{
  readonly api: MockGitHubApi;
  readonly binding: TrustedGitHubBinding;
  readonly plan: GitHubEffectPlan;
  readonly writer: GitHubSingleWriter;
}> {
  const { binding, plan } = await issuePlan();
  const api = new MockGitHubApi();
  api.state = {
    binding,
    contractDigest: plan.expected.contractDigest,
    receiptHead: plan.expected.receiptHead,
    projectSchemaDigest: plan.expected.projectSchemaDigest
  };
  return {
    api,
    binding,
    plan,
    writer: new GitHubSingleWriter(
      credentialBroker(api),
      { maxAttempts: 2, baseDelayMs: 0, maximumDelayMs: 0 },
      async () => {},
      () => new Date(NOW),
      evidenceServices()
    )
  };
}

function evidenceFor(
  plan: GitHubEffectPlan,
  claimantId: `sha256:${string}` = CLAIMANT,
  state: GitHubEvidenceState["state"] = "pending"
): GitHubEvidenceRecord {
  const evidence: GitHubEvidenceState = {
    schemaVersion: "v1alpha1",
    sequence: 1,
    priorSequence: null,
    priorEvidenceDigest: null,
    bindingDigest: plan.bindingDigest,
    idempotencyKey: plan.idempotencyKey,
    planDigest: digest(plan),
    claimantId,
    operationDigest: digest({ claimantId, planDigest: digest(plan) }),
    state,
    effectDigest: state === "completed" ? digest(plan.effect) : null,
    writeAttempts:
      state === "completed" || state === "retryable" ? 1 : 0,
    retryAfterMs: state === "retryable" ? 0 : null,
    retryNotBefore: state === "retryable" ? NOW : null,
    lastError:
      state === "retryable"
        ? {
            code: "RATE_LIMITED",
            status: 429,
            retryable: true,
            outcomeAmbiguous: false
          }
        : state === "partial"
          ? {
              code: "UNOBSERVED_WRITE",
              status: null,
              retryable: false,
              outcomeAmbiguous: true
            }
          : null,
    createdAt: NOW,
    updatedAt: NOW
  };
  return {
    nodeId: "IC_pending",
    applicationId: EVIDENCE_IDENTITY.applicationId,
    authorId: EVIDENCE_IDENTITY.authorId,
    evidence,
    signature: evidenceSignature(EVIDENCE_IDENTITY, evidence)
  };
}

function evidenceChainFor(
  plan: GitHubEffectPlan,
  claimantId: `sha256:${string}` = CLAIMANT,
  state: GitHubEvidenceState["state"] = "pending"
): GitHubEvidenceRecord[] {
  const initial = evidenceFor(plan, claimantId);
  if (state === "pending") return [initial];
  const records = [initial];
  let current = initial;
  const append = (
    update: Pick<
      GitHubEvidenceState,
      | "state"
      | "effectDigest"
      | "writeAttempts"
      | "retryAfterMs"
      | "retryNotBefore"
      | "lastError"
    >
  ): void => {
    const evidence: GitHubEvidenceState = {
      ...current.evidence,
      sequence: current.evidence.sequence + 1,
      priorSequence: current.evidence.sequence,
      priorEvidenceDigest: signedEvidenceDigest(current),
      ...update
    };
    current = {
      nodeId: `IC_${records.length + 1}`,
      applicationId: EVIDENCE_IDENTITY.applicationId,
      authorId: EVIDENCE_IDENTITY.authorId,
      evidence,
      signature: evidenceSignature(EVIDENCE_IDENTITY, evidence)
    };
    records.push(current);
  };
  if (state === "retryable") {
    append({
      state: "pending",
      effectDigest: null,
      writeAttempts: 1,
      retryAfterMs: null,
      retryNotBefore: null,
      lastError: null
    });
    append({
      state: "retryable",
      effectDigest: null,
      writeAttempts: 1,
      retryAfterMs: 0,
      retryNotBefore: NOW,
      lastError: {
        code: "RATE_LIMITED",
        status: 429,
        retryable: true,
        outcomeAmbiguous: false
      }
    });
  } else if (state === "completed") {
    append({
      state: "completed",
      effectDigest: digest(plan.effect),
      writeAttempts: 1,
      retryAfterMs: null,
      retryNotBefore: null,
      lastError: null
    });
  } else {
    append({
      state: "partial",
      effectDigest: null,
      writeAttempts: 0,
      retryAfterMs: null,
      retryNotBefore: null,
      lastError: {
        code: "UNOBSERVED_WRITE",
        status: null,
        retryable: false,
        outcomeAmbiguous: true
      }
    });
  }
  return records;
}

function latestEvidenceState(api: MockGitHubApi): GitHubEvidenceState | undefined {
  return api.evidence.at(-1)?.evidence;
}

function replaceEvidenceState(
  record: GitHubEvidenceRecord,
  update: Partial<GitHubEvidenceState>,
  resign = true
): GitHubEvidenceRecord {
  const evidence = { ...record.evidence, ...update };
  return {
    ...record,
    evidence,
    signature: resign
      ? evidenceSignature(
          {
            applicationId: record.applicationId,
            authorId: record.authorId
          },
          evidence
        )
      : record.signature
  };
}

function tamperTarget(
  plan: GitHubEffectPlan,
  pathSegments: readonly string[],
  value: unknown
): GitHubEffectPlan {
  const clone: unknown = structuredClone(plan);
  let target = clone;
  for (const segment of pathSegments.slice(0, -1)) {
    assert.equal(typeof target, "object");
    assert.notEqual(target, null);
    target = (target as Record<string, unknown>)[segment];
  }
  assert.equal(typeof target, "object");
  assert.notEqual(target, null);
  (target as Record<string, unknown>)[pathSegments.at(-1)!] = value;
  return clone as GitHubEffectPlan;
}

test("GitHub App broker downscopes one installation token to one repository", async () => {
  const { api, binding, plan } = await writerFixture();
  let seenRequest:
    | {
        readonly installationId: number;
        readonly repositoryIds: readonly number[];
        readonly permissions: MintedInstallationGrant["permissions"];
      }
    | undefined;
  let signedRequest:
    | {
        readonly algorithm: "RS256";
        readonly issuer: string;
        readonly issuedAt: string;
        readonly expiresAt: string;
      }
    | undefined;
  const signer: GitHubAppSigner = {
    async withSignedIdentity<T>(
      request: {
        readonly algorithm: "RS256";
        readonly issuer: string;
        readonly issuedAt: string;
        readonly expiresAt: string;
      },
      operation: (identity: SignedGitHubAppIdentity) => Promise<T>
    ): Promise<T> {
      signedRequest = request;
      return operation({ kind: "signed-github-app-identity" });
    }
  };
  const minter: InstallationTokenMinter = {
    async withInstallationClient<T>(
      _identity: SignedGitHubAppIdentity,
      request: {
        readonly installationId: number;
        readonly repositoryIds: readonly number[];
        readonly permissions: readonly GitHubPermissionGrant[];
      },
      operation: (
        client: GitHubApi,
        grant: MintedInstallationGrant
      ) => Promise<T>
    ): Promise<T> {
      seenRequest = request;
      return operation(api, {
        ...request,
        expiresAt: "2026-08-26T20:40:00.000Z"
      });
    }
  };
  const broker = new GitHubAppCredentialBroker(
    signer,
    minter,
    "Iv1.test-client",
    () => new Date(NOW)
  );
  await broker.withClientForEffect(binding, plan.effect, async () => undefined);
  assert.equal(seenRequest?.installationId, 2001);
  assert.deepEqual(seenRequest?.repositoryIds, [1001]);
  assert.deepEqual(
    seenRequest?.permissions,
    GITHUB_PERMISSION_MANIFEST.operations["issue-comment"]
  );
  assert.deepEqual(signedRequest, {
    algorithm: "RS256",
    issuer: "Iv1.test-client",
    issuedAt: "2026-08-26T20:09:00.000Z",
    expiresAt: "2026-08-26T20:19:00.000Z"
  });
});

test("GitHub App broker fails closed when signer or minter is unavailable", async () => {
  const { api, binding, plan } = await writerFixture();
  let minterCalls = 0;
  let clientCalls = 0;
  const unavailableSigner: GitHubAppSigner = {
    async withSignedIdentity(): Promise<never> {
      throw new Error("signer unavailable");
    }
  };
  const minter: InstallationTokenMinter = {
    async withInstallationClient(): Promise<never> {
      minterCalls += 1;
      throw new Error("minter unavailable");
    }
  };
  const signerFailure = new GitHubAppCredentialBroker(
    unavailableSigner,
    minter,
    "Iv1.test-client",
    () => new Date(NOW)
  );
  await assert.rejects(
    signerFailure.withClientForEffect(binding, plan.effect, async () => {
      clientCalls += 1;
    }),
    /signer unavailable/u
  );
  assert.equal(minterCalls, 0);
  assert.equal(clientCalls, 0);

  const availableSigner: GitHubAppSigner = {
    async withSignedIdentity<T>(
      _request: {
        readonly algorithm: "RS256";
        readonly issuer: string;
        readonly issuedAt: string;
        readonly expiresAt: string;
      },
      operation: (identity: SignedGitHubAppIdentity) => Promise<T>
    ): Promise<T> {
      return operation({ kind: "signed-github-app-identity" });
    }
  };
  const minterFailure = new GitHubAppCredentialBroker(
    availableSigner,
    minter,
    "Iv1.test-client",
    () => new Date(NOW)
  );
  await assert.rejects(
    minterFailure.withClientForEffect(binding, plan.effect, async () => {
      clientCalls += 1;
      return api;
    }),
    /minter unavailable/u
  );
  assert.equal(minterCalls, 1);
  assert.equal(clientCalls, 0);
});

test("token scope expansion fails before the operation receives a client", async () => {
  const { api, binding, plan } = await writerFixture();
  let called = false;
  const broker = credentialBroker(api, (grant) => ({
    ...grant,
    repositoryIds: [1001, 9999]
  }));
  await assert.rejects(
    broker.withClientForEffect(binding, plan.effect, async () => {
      called = true;
    }),
    (error: unknown) =>
      error instanceof GitHubCredentialError &&
      error.code === "TOKEN_REPOSITORY_SCOPE_MISMATCH"
  );
  assert.equal(called, false);
});

test("elevated and extra token permissions fail before client use", async () => {
  const { api, binding, plan } = await writerFixture();
  const requested = GITHUB_PERMISSION_MANIFEST.operations["issue-comment"];
  const metadata = requested.find(
    (permission) => permission.name === "metadata"
  );
  assert.notEqual(metadata, undefined);
  const elevated = credentialBroker(api, (grant) => ({
    ...grant,
    permissions: grant.permissions.map((permission) =>
      permission.name === "metadata"
        ? { ...permission, level: "write" as const }
        : permission
    )
  }));
  await assert.rejects(
    elevated.withClientForEffect(binding, plan.effect, async () => undefined),
    (error: unknown) =>
      error instanceof GitHubCredentialError &&
      error.code === "TOKEN_PERMISSION_MISMATCH"
  );

  const extra = credentialBroker(api, (grant) => ({
    ...grant,
    permissions: [
      ...grant.permissions,
      { name: "contents", level: "read", scope: "repository" }
    ]
  }));
  await assert.rejects(
    extra.withClientForEffect(binding, plan.effect, async () => undefined),
    (error: unknown) =>
      error instanceof GitHubCredentialError &&
      error.code === "TOKEN_PERMISSION_MISMATCH"
  );
});

test("permission manifest grants only minimal comment review scope and no merge authority", () => {
  const manifest = JSON.stringify(GITHUB_PERMISSION_MANIFEST);
  assert.equal(manifest.includes("merge"), false);
  assert.equal(manifest.includes("approve"), false);
  assert.equal(manifest.includes("request_changes"), false);
  assert.equal(manifest.includes("personal"), false);
  assert.equal(manifest.includes("token"), false);
  assert.deepEqual(
    GITHUB_PERMISSION_MANIFEST.operations["pull-request-review-comment"],
    [
      { name: "metadata", level: "read", scope: "repository" },
      { name: "pull_requests", level: "write", scope: "repository" }
    ]
  );
  assert.equal(
    GITHUB_PERMISSION_MANIFEST.denied.includes("administration"),
    true
  );
  assert.equal(
    GITHUB_PERMISSION_MANIFEST.operations.authorizeActor.every(
      (permission) => permission.level === "read"
    ),
    true
  );
});

test("all concrete effect target substitutions fail before credential signing", async () => {
  const [issue, pull, review, project] = await Promise.all([
    issuePlan(),
    pullPlan(),
    reviewCommentPlan(),
    projectEffectPlan()
  ]);
  const cases: readonly {
    readonly name: string;
    readonly binding: TrustedGitHubBinding;
    readonly plan: GitHubEffectPlan;
    readonly path: readonly string[];
    readonly value: unknown;
  }[] = [
    ...[
      ["id", 9001],
      ["nodeId", "R_other"],
      ["owner", "other"],
      ["name", "elsewhere"],
      ["fullName", "other/elsewhere"]
    ].map(([field, value]) => ({
      name: `issue repository ${field}`,
      binding: issue.binding,
      plan: issue.plan,
      path: ["effect", "repository", String(field)],
      value
    })),
    {
      name: "issue work-item kind",
      binding: issue.binding,
      plan: issue.plan,
      path: ["effect", "workItem", "kind"],
      value: "pull-request"
    },
    {
      name: "issue work-item number",
      binding: issue.binding,
      plan: issue.plan,
      path: ["effect", "workItem", "number"],
      value: 99
    },
    {
      name: "issue work-item node",
      binding: issue.binding,
      plan: issue.plan,
      path: ["effect", "workItem", "nodeId"],
      value: "I_other"
    },
    ...[
      ["id", 9001],
      ["nodeId", "R_other"],
      ["owner", "other"],
      ["name", "elsewhere"],
      ["fullName", "other/elsewhere"]
    ].map(([field, value]) => ({
      name: `check repository ${field}`,
      binding: pull.binding,
      plan: pull.plan,
      path: ["effect", "repository", String(field)],
      value
    })),
    {
      name: "pull request number",
      binding: pull.binding,
      plan: pull.plan,
      path: ["effect", "pullRequest", "number"],
      value: 99
    },
    {
      name: "review pull request head",
      binding: review.binding,
      plan: review.plan,
      path: ["effect", "headSha"],
      value: "3333333333333333333333333333333333333333"
    },
    {
      name: "pull request node",
      binding: pull.binding,
      plan: pull.plan,
      path: ["effect", "pullRequest", "nodeId"],
      value: "PR_other"
    },
    ...(["base", "head"] as const).flatMap((side) => [
      ...[
        ["id", 9001],
        ["nodeId", "R_other"],
        ["owner", "other"],
        ["name", "elsewhere"],
        ["fullName", "other/elsewhere"]
      ].map(([field, value]) => ({
        name: `${side} repository ${field}`,
        binding: pull.binding,
        plan: pull.plan,
        path: [
          "effect",
          "pullRequest",
          side,
          "repository",
          String(field)
        ],
        value
      })),
      {
        name: `${side} ref`,
        binding: pull.binding,
        plan: pull.plan,
        path: ["effect", "pullRequest", side, "ref"],
        value: "refs/heads/substituted"
      },
      {
        name: `${side} SHA`,
        binding: pull.binding,
        plan: pull.plan,
        path: ["effect", "pullRequest", side, "sha"],
        value: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
      }
    ]),
    {
      name: "check-run head SHA",
      binding: pull.binding,
      plan: pull.plan,
      path: ["effect", "headSha"],
      value: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
    },
    ...[
      ["projectOwnerNodeId", "O_other"],
      ["projectNodeId", "PVT_synthetic_project_other"],
      ["itemNodeId", "PVTI_synthetic_other"],
      ["projectBindingDigest", digest({ project: "other" })],
      ["fieldKey", "risk"],
      ["fieldNodeId", "PVTF_synthetic_other"],
      ["fieldDataType", "TEXT"]
    ].map(([field, value]) => ({
      name: `Project ${field}`,
      binding: project.binding,
      plan: project.plan,
      path: ["effect", String(field)],
      value
    })),
    {
      name: "Project expected option",
      binding: project.binding,
      plan: project.plan,
      path: ["effect", "expectedCurrentValue", "optionNodeId"],
      value: "OPT_other"
    },
    {
      name: "Project expected value type",
      binding: project.binding,
      plan: project.plan,
      path: ["effect", "expectedCurrentValue"],
      value: { kind: "text", text: "substituted" }
    },
    {
      name: "Project new option",
      binding: project.binding,
      plan: project.plan,
      path: ["effect", "value", "optionNodeId"],
      value: "OPT_other"
    },
    {
      name: "Project new value type",
      binding: project.binding,
      plan: project.plan,
      path: ["effect", "value"],
      value: { kind: "text", text: "substituted" }
    }
  ];

  for (const testCase of cases) {
    const tampered = tamperTarget(testCase.plan, testCase.path, testCase.value);
    assertDocument("GitHubEffectPlan", tampered);
    const api = new MockGitHubApi();
    api.state = {
      binding: testCase.binding,
      contractDigest: testCase.plan.expected.contractDigest,
      receiptHead: testCase.plan.expected.receiptHead,
      projectSchemaDigest: testCase.plan.expected.projectSchemaDigest
    };
    let signCount = 0;
    const writer = new GitHubSingleWriter(
      credentialBroker(api, (grant) => grant, () => {
        signCount += 1;
      }),
      { maxAttempts: 1, baseDelayMs: 0, maximumDelayMs: 0 },
      undefined,
      undefined,
      evidenceServices()
    );
    await assert.rejects(
      async () => writer.execute(testCase.binding, tampered, CLAIMANT),
      (error: unknown) =>
        error instanceof GitHubExecutionError &&
        error.code === "BINDING_STALE",
      testCase.name
    );
    assert.equal(signCount, 0, testCase.name);
    assert.equal(api.applyCount, 0, testCase.name);
  }
});

test("Single Writer applies once and records completed GitHub evidence", async () => {
  const { api, binding, plan, writer } = await writerFixture();
  const result = await writer.execute(binding, plan, CLAIMANT);
  assert.equal(result.kind, "applied");
  assert.equal(api.applyCount, 1);
  assert.equal(latestEvidenceState(api)?.state, "completed");
  assert.equal(latestEvidenceState(api)?.effectDigest, digest(plan.effect));
});

test("duplicate delivery replays completed evidence without another write", async () => {
  const { api, binding, plan, writer } = await writerFixture();
  await writer.execute(binding, plan, CLAIMANT);
  const replay = await writer.execute(binding, plan, CLAIMANT);
  assert.equal(replay.kind, "replayed");
  assert.equal(api.applyCount, 1);
});

test("completed replay evidence must match the planned effect digest", async () => {
  const { api, binding, plan, writer } = await writerFixture();
  const chain = evidenceChainFor(plan, CLAIMANT, "completed");
  chain[chain.length - 1] = replaceEvidenceState(chain.at(-1)!, {
    effectDigest: digest({ substituted: "effect" })
  });
  api.setEvidence(chain);
  await assert.rejects(
    writer.execute(binding, plan, CLAIMANT),
    (error: unknown) =>
      error instanceof GitHubExecutionError &&
      error.code === "REPLAY_CONFLICT"
  );
  assert.equal(api.applyCount, 0);
});

test("persisted evidence accepts only valid closed state combinations", async () => {
  const { plan } = await writerFixture();
  const validStates = [
    evidenceFor(plan, CLAIMANT, "pending"),
    evidenceFor(plan, CLAIMANT, "retryable"),
    evidenceFor(plan, CLAIMANT, "completed"),
    evidenceFor(plan, CLAIMANT, "partial")
  ];
  for (const evidence of validStates) {
    assert.equal(
      validateDocument("GitHubEffectEvidence", evidence).valid,
      true,
      evidence.evidence.state
    );
  }

  const invalidStates: readonly {
    readonly name: string;
    readonly update: Readonly<Record<string, unknown>>;
  }[] = [
    { name: "negative attempts", update: { state: "retryable", writeAttempts: -1 } },
    { name: "zero retry attempts", update: { state: "retryable", writeAttempts: 0 } },
    {
      name: "unsafe attempts",
      update: {
        state: "retryable",
        writeAttempts: Number.MAX_SAFE_INTEGER + 1
      }
    },
    { name: "missing retry delay", update: { state: "retryable", retryAfterMs: null } },
    {
      name: "unsafe retry delay",
      update: {
        state: "retryable",
        retryAfterMs: Number.MAX_SAFE_INTEGER + 1
      }
    },
    {
      name: "retryable effect digest",
      update: { state: "retryable", effectDigest: digest(plan.effect) }
    },
    {
      name: "pending error",
      update: {
        state: "pending",
        lastError: {
          code: "RATE_LIMITED",
          status: 429,
          retryable: true,
          outcomeAmbiguous: false
        }
      }
    },
    {
      name: "completed retry delay",
      update: { state: "completed", retryAfterMs: 1 }
    },
    { name: "partial without error", update: { state: "partial", lastError: null } },
    { name: "malformed created timestamp", update: { createdAt: "not-a-date" } },
    { name: "malformed updated timestamp", update: { updatedAt: "not-a-date" } },
    { name: "unknown field", update: { unexpected: true } }
  ];
  for (const testCase of invalidStates) {
    const fixture = await writerFixture();
    const record = evidenceFor(fixture.plan, CLAIMANT, "retryable");
    fixture.api.setEvidence([
      {
        ...record,
        evidence: {
          ...record.evidence,
          ...testCase.update
        }
      } as GitHubEvidenceRecord
    ]);
    await assert.rejects(
      fixture.writer.execute(fixture.binding, fixture.plan, CLAIMANT),
      (error: unknown) =>
        error instanceof GitHubExecutionError &&
        error.code === "EVIDENCE_INVALID",
      testCase.name
    );
    assert.equal(fixture.api.applyCount, 0, testCase.name);
  }
});

test("persisted evidence rejects inconsistent identities and timestamp order", async () => {
  const cases: readonly {
    readonly name: string;
    readonly update: Partial<GitHubEvidenceState>;
  }[] = [
    {
      name: "operation digest",
      update: { operationDigest: digest({ substituted: "operation" }) }
    },
    {
      name: "idempotency key",
      update: { idempotencyKey: digest({ substituted: "key" }) }
    },
    {
      name: "timestamp order",
      update: {
        createdAt: "2026-08-26T20:10:01.000Z",
        updatedAt: NOW
      }
    }
  ];
  for (const testCase of cases) {
    const fixture = await writerFixture();
    fixture.api.setEvidence([
      replaceEvidenceState(evidenceFor(fixture.plan), testCase.update)
    ]);
    await assert.rejects(
      fixture.writer.execute(fixture.binding, fixture.plan, CLAIMANT),
      (error: unknown) =>
        error instanceof GitHubExecutionError &&
        error.code === "EVIDENCE_INVALID",
      testCase.name
    );
    assert.equal(fixture.api.applyCount, 0, testCase.name);
  }
});

test("incomplete evidence authentication fails before credential signing", async () => {
  const complete = evidenceServices();
  const cases: readonly unknown[] = [
    undefined,
    { ...complete, signer: undefined },
    { ...complete, verifier: undefined },
    { ...complete, store: undefined },
    {
      ...complete,
      store: {
        ...complete.store,
        supportsAuthenticatedConditionalAppend: false
      }
    }
  ];
  for (const services of cases) {
    const { api, binding, plan } = await writerFixture();
    let signCount = 0;
    const writer = new GitHubSingleWriter(
      credentialBroker(api, (grant) => grant, () => {
        signCount += 1;
      }),
      { maxAttempts: 1, baseDelayMs: 0, maximumDelayMs: 0 },
      async () => undefined,
      () => new Date(NOW),
      services as GitHubEvidenceServices | undefined
    );
    await assert.rejects(
      async () => writer.execute(binding, plan, CLAIMANT),
      (error: unknown) =>
        error instanceof GitHubExecutionError &&
        error.code === "EVIDENCE_AUTHENTICATION_REQUIRED"
    );
    assert.equal(signCount, 0);
    assert.equal(api.applyCount, 0);
  }
});

test("forged and edited evidence fails signature verification", async () => {
  const cases: readonly {
    readonly name: string;
    readonly mutate: (record: GitHubEvidenceRecord) => GitHubEvidenceRecord;
  }[] = [
    {
      name: "self-consistent forged attempts",
      mutate: (record) =>
        replaceEvidenceState(record, { writeAttempts: 2 }, false)
    },
    {
      name: "modified retry deadline",
      mutate: (record) =>
        replaceEvidenceState(
          record,
          {
            retryAfterMs: 5000,
            retryNotBefore: new Date(
              new Date(NOW).getTime() + 5000
            ).toISOString()
          },
          false
        )
    },
    {
      name: "modified state",
      mutate: (record) =>
        replaceEvidenceState(
          record,
          {
            state: "pending",
            retryAfterMs: null,
            retryNotBefore: null,
            lastError: null
          },
          false
        )
    },
    {
      name: "modified error",
      mutate: (record) =>
        replaceEvidenceState(
          record,
          {
            lastError: {
              code: "SERVER_ERROR",
              status: 500,
              retryable: true,
              outcomeAmbiguous: false
            }
          },
          false
        )
    },
    {
      name: "bad signature",
      mutate: (record) => ({
        ...record,
        signature: { ...record.signature, value: "forged" }
      })
    }
  ];
  for (const testCase of cases) {
    const fixture = await writerFixture();
    const chain = evidenceChainFor(
      fixture.plan,
      CLAIMANT,
      "retryable"
    );
    chain[chain.length - 1] = testCase.mutate(chain.at(-1)!);
    fixture.api.setEvidence(chain);
    await assert.rejects(
      fixture.writer.execute(fixture.binding, fixture.plan, CLAIMANT),
      (error: unknown) =>
        error instanceof GitHubExecutionError &&
        error.code === "EVIDENCE_SIGNATURE_INVALID",
      testCase.name
    );
    assert.equal(fixture.api.applyCount, 0, testCase.name);
  }
});

test("wrong evidence App or author identity fails closed", async () => {
  const cases = [
    { applicationId: EVIDENCE_IDENTITY.applicationId + 1 },
    { authorId: EVIDENCE_IDENTITY.authorId + 1 }
  ] as const;
  for (const update of cases) {
    const fixture = await writerFixture();
    const record = evidenceFor(fixture.plan);
    fixture.api.setEvidence([{ ...record, ...update }]);
    await assert.rejects(
      fixture.writer.execute(fixture.binding, fixture.plan, CLAIMANT),
      (error: unknown) =>
        error instanceof GitHubExecutionError &&
        error.code === "EVIDENCE_SIGNATURE_INVALID"
    );
    assert.equal(fixture.api.applyCount, 0);
  }
});

test("rollback and reordered evidence chains fail closed", async () => {
  const rollback = await writerFixture();
  const rollbackChain = evidenceChainFor(
    rollback.plan,
    CLAIMANT,
    "completed"
  );
  rollback.api.setEvidence(rollbackChain);
  const authenticatedHead = rollback.api.evidenceHead;
  rollback.api.evidence = rollbackChain.slice(0, -1);
  rollback.api.evidenceHead = authenticatedHead;
  await assert.rejects(
    rollback.writer.execute(rollback.binding, rollback.plan, CLAIMANT),
    (error: unknown) =>
      error instanceof GitHubExecutionError &&
      error.code === "EVIDENCE_CHAIN_INVALID"
  );
  assert.equal(rollback.api.applyCount, 0);

  const reordered = await writerFixture();
  const reorderedChain = evidenceChainFor(
    reordered.plan,
    CLAIMANT,
    "completed"
  );
  reordered.api.setEvidence([
    reorderedChain[1]!,
    reorderedChain[0]!
  ]);
  await assert.rejects(
    reordered.writer.execute(reordered.binding, reordered.plan, CLAIMANT),
    (error: unknown) =>
      error instanceof GitHubExecutionError &&
      error.code === "EVIDENCE_CHAIN_INVALID"
  );
  assert.equal(reordered.api.applyCount, 0);
});

test("conditional append conflicts re-read and perform zero effect writes", async () => {
  const { api, binding, plan, writer } = await writerFixture();
  api.conflictOnSequence = 2;
  await assert.rejects(
    writer.execute(binding, plan, CLAIMANT),
    (error: unknown) =>
      error instanceof GitHubExecutionError &&
      error.code === "CONCURRENCY_CONFLICT"
  );
  assert.equal(api.applyCount, 0);
  assert.equal(latestEvidenceState(api)?.writeAttempts, 0);
});

test("an identical winning claim never authorizes the CAS loser", async () => {
  const { api, binding, plan, writer } = await writerFixture();
  api.conflictOnSequence = 1;
  api.conflictWithSubmittedEvidence = true;
  await assert.rejects(
    writer.execute(binding, plan, CLAIMANT),
    (error: unknown) =>
      error instanceof GitHubExecutionError &&
      error.code === "CONCURRENCY_CONFLICT"
  );
  assert.equal(api.applyCount, 0);
  assert.equal(latestEvidenceState(api)?.state, "pending");
  assert.equal(latestEvidenceState(api)?.writeAttempts, 0);
});

test("identical concurrent attempt transitions authorize only one writer", async () => {
  const { api, binding, plan } = await writerFixture();
  api.setEvidence(evidenceChainFor(plan));
  const baseServices = evidenceServices();
  const attemptedTransitions: GitHubSignedEvidence[] = [];
  let initialReads = 0;
  let releaseInitialReads: () => void = () => undefined;
  const bothInitialReads = new Promise<void>((resolve) => {
    releaseInitialReads = resolve;
  });
  const services: GitHubEvidenceServices = {
    ...baseServices,
    store: {
      supportsAuthenticatedConditionalAppend: true,
      async readEvidence(sharedApi) {
        const snapshot = (sharedApi as MockGitHubApi).readEvidenceSnapshot();
        if (snapshot.head?.sequence === 1 && initialReads < 2) {
          initialReads += 1;
          if (initialReads === 2) releaseInitialReads();
          await bothInitialReads;
        }
        return snapshot;
      },
      async conditionalAppendEvidence(
        sharedApi,
        _binding,
        expectedHead,
        evidence
      ) {
        if (evidence.evidence.sequence === 2) {
          attemptedTransitions.push(structuredClone(evidence));
        }
        return (sharedApi as MockGitHubApi).appendEvidence(
          expectedHead,
          evidence
        );
      }
    }
  };
  const makeWriter = (): GitHubSingleWriter =>
    new GitHubSingleWriter(
      credentialBroker(api),
      { maxAttempts: 2, baseDelayMs: 0, maximumDelayMs: 0 },
      async () => undefined,
      () => new Date(NOW),
      services
    );

  const results = await Promise.allSettled([
    makeWriter().execute(binding, plan, CLAIMANT),
    makeWriter().execute(binding, plan, CLAIMANT)
  ]);
  assert.equal(attemptedTransitions.length, 2);
  assert.equal(
    digest(attemptedTransitions[0]),
    digest(attemptedTransitions[1])
  );
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1
  );
  const rejected = results.find((result) => result.status === "rejected");
  assert.equal(rejected?.status, "rejected");
  assert.equal(
    rejected?.status === "rejected" &&
      rejected.reason instanceof GitHubExecutionError
      ? rejected.reason.code
      : null,
    "CONCURRENCY_CONFLICT"
  );
  assert.equal(api.applyCount, 1);
  assert.equal(latestEvidenceState(api)?.state, "completed");
});

test("post-effect evidence conflicts require exact authenticated completion", async () => {
  const incomplete = await writerFixture();
  incomplete.api.conflictOnSequence = 3;
  await assert.rejects(
    incomplete.writer.execute(
      incomplete.binding,
      incomplete.plan,
      CLAIMANT
    ),
    (error: unknown) =>
      error instanceof GitHubExecutionError &&
      error.code === "PARTIAL_EFFECT"
  );
  assert.equal(incomplete.api.applyCount, 1);
  assert.equal(latestEvidenceState(incomplete.api)?.state, "pending");

  const completed = await writerFixture();
  completed.api.conflictOnSequence = 3;
  completed.api.conflictWithSubmittedEvidence = true;
  const result = await completed.writer.execute(
    completed.binding,
    completed.plan,
    CLAIMANT
  );
  assert.equal(result.kind, "applied");
  assert.equal(completed.api.applyCount, 1);
  assert.equal(latestEvidenceState(completed.api)?.state, "completed");
});

test("duplicate authenticated evidence heads fail closed", async () => {
  const { api, binding, plan, writer } = await writerFixture();
  const base = evidenceFor(plan);
  api.setEvidence([
    { ...base, nodeId: "IC_1" },
    { ...base, nodeId: "IC_2" }
  ]);
  await assert.rejects(
    writer.execute(binding, plan, CLAIMANT),
    (error: unknown) =>
      error instanceof GitHubExecutionError &&
      error.code === "EVIDENCE_CHAIN_INVALID"
  );
  assert.equal(api.applyCount, 0);
});

test("pending claim reconciles only an exact observed effect", async () => {
  const { api, binding, plan, writer } = await writerFixture();
  api.setEvidence(evidenceChainFor(plan));
  api.observation = {
    nodeId: "EFFECT_prior",
    effectDigest: digest(plan.effect)
  };
  const result = await writer.execute(binding, plan, CLAIMANT);
  assert.equal(result.kind, "reconciled");
  assert.equal(api.applyCount, 0);
  assert.equal(latestEvidenceState(api)?.state, "completed");
});

test("ambiguous claim creation resolves every evidence state without writing", async () => {
  const completed = await writerFixture();
  completed.api.claimBehavior = "ambiguous-completed";
  completed.api.ambiguousEffectDigest = digest(completed.plan.effect);
  const replay = await completed.writer.execute(
    completed.binding,
    completed.plan,
    CLAIMANT
  );
  assert.equal(replay.kind, "replayed");
  assert.equal(completed.api.applyCount, 0);

  const tamperedCompleted = await writerFixture();
  tamperedCompleted.api.claimBehavior = "ambiguous-completed";
  tamperedCompleted.api.ambiguousEffectDigest = digest({ tampered: true });
  await assert.rejects(
    tamperedCompleted.writer.execute(
      tamperedCompleted.binding,
      tamperedCompleted.plan,
      CLAIMANT
    ),
    (error: unknown) =>
      error instanceof GitHubExecutionError &&
      error.code === "REPLAY_CONFLICT"
  );
  assert.equal(tamperedCompleted.api.applyCount, 0);

  const cases = [
    ["ambiguous-partial", "PARTIAL_EFFECT"],
    ["ambiguous-retryable", "CLAIM_RECONCILIATION_REQUIRED"],
    ["ambiguous-own", "CLAIM_RECONCILIATION_REQUIRED"],
    ["ambiguous-other", "CONCURRENCY_CONFLICT"]
  ] as const;
  for (const [claimBehavior, expectedCode] of cases) {
    const fixture = await writerFixture();
    fixture.api.claimBehavior = claimBehavior;
    await assert.rejects(
      fixture.writer.execute(fixture.binding, fixture.plan, CLAIMANT),
      (error: unknown) =>
        error instanceof GitHubExecutionError &&
        error.code === expectedCode,
      claimBehavior
    );
    assert.equal(fixture.api.applyCount, 0, claimBehavior);
  }
});

test("ambiguous claim reconciliation rejects a changing authenticated head", async () => {
  const { api, binding, plan, writer } = await writerFixture();
  api.claimBehavior = "ambiguous-own";
  api.ambiguousEffectDigest = digest(plan.effect);
  api.evidenceStateSequence = ["pending", "completed"];
  await assert.rejects(
    writer.execute(binding, plan, CLAIMANT),
    (error: unknown) =>
      error instanceof GitHubExecutionError &&
      error.code === "CONCURRENCY_CONFLICT"
  );
  assert.equal(api.applyCount, 0);
});

test("tampered effect under a pending claim fails closed", async () => {
  const { api, binding, plan, writer } = await writerFixture();
  api.setEvidence(evidenceChainFor(plan));
  api.observation = {
    nodeId: "EFFECT_tampered",
    effectDigest: digest({ tampered: true })
  };
  await assert.rejects(
    writer.execute(binding, plan, CLAIMANT),
    (error: unknown) =>
      error instanceof GitHubExecutionError &&
      error.code === "READ_AFTER_WRITE_FAILED"
  );
  assert.equal(api.applyCount, 0);
  assert.equal(latestEvidenceState(api)?.state, "partial");
});

test("unobserved prior pending write is never applied again", async () => {
  const { api, binding, plan, writer } = await writerFixture();
  const chain = evidenceChainFor(plan);
  const initial = chain[0]!;
  const pendingAttempt = replaceEvidenceState(initial, {
    sequence: 2,
    priorSequence: 1,
    priorEvidenceDigest: signedEvidenceDigest(initial),
    writeAttempts: 1
  });
  chain.push({ ...pendingAttempt, nodeId: "IC_2" });
  api.setEvidence(chain);
  await assert.rejects(
    writer.execute(binding, plan, CLAIMANT),
    (error: unknown) =>
      error instanceof GitHubExecutionError &&
      error.code === "PARTIAL_EFFECT"
  );
  assert.equal(api.applyCount, 0);
  assert.equal(latestEvidenceState(api)?.state, "partial");
});

test("stale contract, schema, receipt, and pull head are rejected before writes", async () => {
  const { api, binding, plan, writer } = await writerFixture();
  api.state = { ...api.state, contractDigest: digest({ stale: "contract" }) };
  await assert.rejects(
    writer.execute(binding, plan, CLAIMANT),
    (error: unknown) =>
      error instanceof GitHubExecutionError && error.code === "CONTRACT_STALE"
  );
  api.state = {
    ...api.state,
    contractDigest: plan.expected.contractDigest,
    projectSchemaDigest: digest({ stale: "schema" })
  };
  await assert.rejects(
    writer.execute(binding, plan, CLAIMANT),
    (error: unknown) =>
      error instanceof GitHubExecutionError &&
      error.code === "PROJECT_SCHEMA_STALE"
  );
  api.state = {
    ...api.state,
    projectSchemaDigest: plan.expected.projectSchemaDigest,
    receiptHead: digest({ stale: "receipt" })
  };
  await assert.rejects(
    writer.execute(binding, plan, CLAIMANT),
    (error: unknown) =>
      error instanceof GitHubExecutionError && error.code === "RECEIPT_STALE"
  );

  const pullWorkItem = { kind: "pull-request", ...pullRequest } as const;
  const pullBinding: TrustedGitHubBinding = {
    ...binding,
    workItem: pullWorkItem
  };
  const pullPlan = translateSafeOutput({
    output: safeOutput(),
    intent: { type: "check-run", name: "Hyperfinite" },
    binding: pullBinding,
    eventId: "pull",
    contractRevision: 1,
    contractDigest: digest({ contract: 1 }),
    receiptHead: null,
    routeId: "verify",
    attempt: 1
  });
  api.state = {
    binding: {
      ...pullBinding,
      workItem: {
        ...pullWorkItem,
        head: {
          ...pullWorkItem.head,
          sha: "3333333333333333333333333333333333333333"
        }
      }
    },
    contractDigest: pullPlan.expected.contractDigest,
    receiptHead: null,
    projectSchemaDigest: pullPlan.expected.projectSchemaDigest
  };
  const pullWriter = new GitHubSingleWriter(
    credentialBroker(api),
    { maxAttempts: 1, baseDelayMs: 0, maximumDelayMs: 0 },
    undefined,
    undefined,
    evidenceServices()
  );
  await assert.rejects(
    pullWriter.execute(pullBinding, pullPlan, CLAIMANT),
    (error: unknown) =>
      error instanceof GitHubExecutionError &&
      (error.code === "BINDING_STALE" || error.code === "CURRENT_HEAD_STALE")
  );
  assert.equal(api.applyCount, 0);
});

test("COMMENT effects recheck the exact head immediately before mutation", async () => {
  const { binding, plan } = await reviewCommentPlan();
  const api = new MockGitHubApi();
  api.state = {
    binding,
    contractDigest: plan.expected.contractDigest,
    receiptHead: plan.expected.receiptHead,
    projectSchemaDigest: plan.expected.projectSchemaDigest
  };
  api.stalePullHeadOnRead = 3;
  const writer = new GitHubSingleWriter(
    credentialBroker(api),
    { maxAttempts: 1, baseDelayMs: 0, maximumDelayMs: 0 },
    undefined,
    undefined,
    evidenceServices()
  );
  await assert.rejects(
    writer.execute(binding, plan, CLAIMANT),
    (error: unknown) =>
      error instanceof GitHubExecutionError &&
      (error.code === "BINDING_STALE" || error.code === "CURRENT_HEAD_STALE")
  );
  assert.equal(api.executionStateReads, 3);
  assert.equal(api.applyCount, 0);
  api.stalePullHeadOnRead = null;
  api.state = {
    binding,
    contractDigest: plan.expected.contractDigest,
    receiptHead: plan.expected.receiptHead,
    projectSchemaDigest: plan.expected.projectSchemaDigest
  };
  const retried = await writer.execute(binding, plan, CLAIMANT);
  assert.equal(retried.kind, "applied");
  assert.equal(api.applyCount, 1);
});

test("COMMENT application atomically rejects movement after the final head read", async () => {
  const { binding, plan } = await reviewCommentPlan();
  const api = new MockGitHubApi();
  api.state = {
    binding,
    contractDigest: plan.expected.contractDigest,
    receiptHead: plan.expected.receiptHead,
    projectSchemaDigest: plan.expected.projectSchemaDigest
  };
  api.beforeConditionalApply = () => {
    if (api.state.binding.workItem.kind !== "pull-request") return;
    api.state = {
      ...api.state,
      binding: {
        ...api.state.binding,
        workItem: {
          ...api.state.binding.workItem,
          head: {
            ...api.state.binding.workItem.head,
            sha: "e".repeat(40)
          }
        }
      }
    };
  };
  const writer = new GitHubSingleWriter(
    credentialBroker(api),
    { maxAttempts: 1, baseDelayMs: 0, maximumDelayMs: 0 },
    undefined,
    undefined,
    evidenceServices()
  );
  await assert.rejects(
    writer.execute(binding, plan, CLAIMANT),
    (error: unknown) =>
      error instanceof GitHubExecutionError &&
      error.code === "PARTIAL_EFFECT"
  );
  assert.equal(api.applyCount, 0);
  assert.equal(api.observation, null);
});

test("lost write acknowledgement reconciles from fresh GitHub evidence", async () => {
  const { api, binding, plan, writer } = await writerFixture();
  api.applyBehavior = "fail-after";
  const result = await writer.execute(binding, plan, CLAIMANT);
  assert.equal(result.kind, "reconciled");
  assert.equal(api.applyCount, 1);
  assert.equal(latestEvidenceState(api)?.state, "completed");
});

test("unobserved failed write records a partial effect and never retries mutation", async () => {
  const { api, binding, plan, writer } = await writerFixture();
  api.applyBehavior = "fail-before";
  await assert.rejects(
    writer.execute(binding, plan, CLAIMANT),
    (error: unknown) =>
      error instanceof GitHubExecutionError && error.code === "PARTIAL_EFFECT"
  );
  assert.equal(api.applyCount, 1);
  assert.equal(latestEvidenceState(api)?.state, "partial");
});

test("definite rate limits preserve an owned retry and avoid duplicate writes", async () => {
  const { api, binding, plan } = await writerFixture();
  api.applyBehavior = "rate-limited";
  let currentTime = new Date(NOW);
  let signCount = 0;
  const writer = new GitHubSingleWriter(
    credentialBroker(api, (grant) => grant, () => {
      signCount += 1;
    }),
    { maxAttempts: 2, baseDelayMs: 100, maximumDelayMs: 5000 },
    async () => {},
    () => currentTime,
    evidenceServices()
  );
  await assert.rejects(
    async () => writer.execute(binding, plan, CLAIMANT),
    (error: unknown) =>
      error instanceof GitHubExecutionError &&
      error.code === "RETRYABLE_WRITE_FAILURE"
  );
  assert.equal(latestEvidenceState(api)?.state, "retryable");
  assert.equal(latestEvidenceState(api)?.writeAttempts, 1);
  assert.equal(latestEvidenceState(api)?.retryAfterMs, 1000);
  assert.equal(api.applyCount, 1);
  assert.equal(signCount, 1);

  api.applyBehavior = "success";
  await assert.rejects(
    async () => writer.execute(binding, plan, CLAIMANT),
    (error: unknown) =>
      error instanceof GitHubExecutionError &&
      error.code === "RETRY_NOT_BEFORE" &&
      error.retryAfterMs === 1000
  );
  assert.equal(api.applyCount, 1);
  assert.equal(signCount, 1);

  currentTime = new Date(new Date(NOW).getTime() + 1000);
  const result = await writer.execute(binding, plan, CLAIMANT);
  assert.equal(result.kind, "applied");
  assert.equal(api.applyCount, 2);
  assert.equal(signCount, 2);
  assert.equal(latestEvidenceState(api)?.state, "completed");
});

test("server retry deadlines beyond automatic policy are never shortened", async () => {
  const { api, binding, plan } = await writerFixture();
  api.applyBehavior = "rate-limited";
  api.rateLimitRetryAfterMs = 60_000;
  let currentTime = new Date(NOW);
  let signCount = 0;
  const writer = new GitHubSingleWriter(
    credentialBroker(api, (grant) => grant, () => {
      signCount += 1;
    }),
    { maxAttempts: 2, baseDelayMs: 100, maximumDelayMs: 5000 },
    async () => {},
    () => currentTime,
    evidenceServices()
  );
  await assert.rejects(
    async () => writer.execute(binding, plan, CLAIMANT),
    (error: unknown) =>
      error instanceof GitHubExecutionError &&
      error.code === "EXTERNAL_RETRY_WINDOW" &&
      error.retryable === false &&
      error.retryAfterMs === 60_000
  );
  assert.equal(latestEvidenceState(api)?.retryAfterMs, 60_000);
  assert.equal(api.applyCount, 1);
  assert.equal(signCount, 1);

  api.applyBehavior = "success";
  currentTime = new Date(new Date(NOW).getTime() + 59_999);
  await assert.rejects(
    async () => writer.execute(binding, plan, CLAIMANT),
    (error: unknown) =>
      error instanceof GitHubExecutionError &&
      error.code === "EXTERNAL_RETRY_WINDOW" &&
      error.retryAfterMs === 1
  );
  assert.equal(api.applyCount, 1);
  assert.equal(signCount, 1);

  currentTime = new Date(new Date(NOW).getTime() + 60_000);
  const result = await writer.execute(binding, plan, CLAIMANT);
  assert.equal(result.kind, "applied");
  assert.equal(api.applyCount, 2);
  assert.equal(signCount, 2);
});

test("server retry deadlines longer than one hour remain external", async () => {
  const { api, binding, plan } = await writerFixture();
  api.applyBehavior = "rate-limited";
  api.rateLimitRetryAfterMs = 2 * 60 * 60 * 1000;
  let signCount = 0;
  const writer = new GitHubSingleWriter(
    credentialBroker(api, (grant) => grant, () => {
      signCount += 1;
    }),
    { maxAttempts: 2, baseDelayMs: 100, maximumDelayMs: 5000 },
    async () => {},
    () => new Date(NOW),
    evidenceServices()
  );
  await assert.rejects(
    async () => writer.execute(binding, plan, CLAIMANT),
    (error: unknown) =>
      error instanceof GitHubExecutionError &&
      error.code === "EXTERNAL_RETRY_WINDOW" &&
      error.retryAfterMs === 2 * 60 * 60 * 1000
  );
  await assert.rejects(
    async () => writer.execute(binding, plan, CLAIMANT),
    (error: unknown) =>
      error instanceof GitHubExecutionError &&
      error.code === "EXTERNAL_RETRY_WINDOW" &&
      error.retryAfterMs === 2 * 60 * 60 * 1000
  );
  assert.equal(
    latestEvidenceState(api)?.retryAfterMs,
    2 * 60 * 60 * 1000
  );
  assert.equal(api.applyCount, 1);
  assert.equal(signCount, 1);
});

test("expired persisted retry delay resumes while malformed state fails closed", async () => {
  const expired = await writerFixture();
  const expiredChain = evidenceChainFor(
    expired.plan,
    CLAIMANT,
    "retryable"
  );
  expiredChain[expiredChain.length - 1] = replaceEvidenceState(
    expiredChain.at(-1)!,
    {
      retryAfterMs: 500,
      retryNotBefore: new Date(new Date(NOW).getTime() + 500).toISOString()
    }
  );
  expired.api.setEvidence(expiredChain);
  const expiredWriter = new GitHubSingleWriter(
    credentialBroker(expired.api),
    { maxAttempts: 2, baseDelayMs: 100, maximumDelayMs: 5000 },
    async () => {},
    () => new Date(new Date(NOW).getTime() + 501),
    evidenceServices()
  );
  const result = await expiredWriter.execute(
    expired.binding,
    expired.plan,
    CLAIMANT
  );
  assert.equal(result.kind, "applied");
  assert.equal(expired.api.applyCount, 1);

  const malformedCases: readonly {
    readonly update: Partial<GitHubEvidenceState>;
    readonly code: "EVIDENCE_INVALID" | "RETRY_STATE_INVALID";
  }[] = [
    { update: { updatedAt: "not-a-date", retryAfterMs: 1000 }, code: "EVIDENCE_INVALID" },
    { update: { retryAfterMs: null }, code: "EVIDENCE_INVALID" },
    {
      update: { retryAfterMs: Number.MAX_SAFE_INTEGER },
      code: "EVIDENCE_INVALID"
    }
  ];
  for (const { update, code } of malformedCases) {
    const fixture = await writerFixture();
    const chain = evidenceChainFor(
      fixture.plan,
      CLAIMANT,
      "retryable"
    );
    chain[chain.length - 1] = replaceEvidenceState(
      chain.at(-1)!,
      {
        writeAttempts: 1,
        retryAfterMs: 1000,
        retryNotBefore: new Date(
          new Date(NOW).getTime() + 1000
        ).toISOString(),
        ...update
      }
    );
    fixture.api.setEvidence(chain);
    const writer = new GitHubSingleWriter(
      credentialBroker(fixture.api),
      { maxAttempts: 2, baseDelayMs: 100, maximumDelayMs: 5000 },
      async () => {},
      () => new Date(NOW),
      evidenceServices()
    );
    await assert.rejects(
      writer.execute(fixture.binding, fixture.plan, CLAIMANT),
      (error: unknown) =>
        error instanceof GitHubExecutionError &&
        error.code === code
    );
    assert.equal(fixture.api.applyCount, 0);
  }
});

test("retry exhaustion fails before another mutation attempt", async () => {
  const { api, binding, plan } = await writerFixture();
  api.applyBehavior = "rate-limited";
  const writer = new GitHubSingleWriter(
    credentialBroker(api),
    { maxAttempts: 1, baseDelayMs: 0, maximumDelayMs: 0 },
    undefined,
    undefined,
    evidenceServices()
  );
  await assert.rejects(
    writer.execute(binding, plan, CLAIMANT),
    (error: unknown) =>
      error instanceof GitHubExecutionError &&
      error.code === "EXTERNAL_RETRY_WINDOW" &&
      error.retryAfterMs === 1000
  );
  const resumedWriter = new GitHubSingleWriter(
    credentialBroker(api),
    { maxAttempts: 1, baseDelayMs: 0, maximumDelayMs: 0 },
    async () => {},
    () => new Date(new Date(NOW).getTime() + 1000),
    evidenceServices()
  );
  await assert.rejects(
    resumedWriter.execute(binding, plan, CLAIMANT),
    (error: unknown) =>
      error instanceof GitHubExecutionError &&
      error.code === "RETRY_EXHAUSTED"
  );
  assert.equal(api.applyCount, 1);
});

test("Project concurrent value change fails before mutation", async () => {
  const binding = await trustedIssueBinding();
  const plan = translateSafeOutput({
    output: safeOutput(),
    intent: {
      type: "project-field-update",
      fieldKey: "stage",
      expectedCurrentValue: {
        kind: "single-select",
        optionNodeId: "OPT_captured"
      },
      value: { kind: "single-select", optionKey: "blocked" }
    },
    binding,
    eventId: "project",
    contractRevision: 1,
    contractDigest: digest({ contract: 1 }),
    receiptHead: null,
    routeId: "project",
    attempt: 1
  });
  const api = new MockGitHubApi();
  api.state = {
    binding,
    contractDigest: plan.expected.contractDigest,
    receiptHead: null,
    projectSchemaDigest: plan.expected.projectSchemaDigest
  };
  api.projectValue = {
    kind: "single-select",
    optionNodeId: "OPT_executing"
  };
  const writer = new GitHubSingleWriter(
    credentialBroker(api),
    { maxAttempts: 1, baseDelayMs: 0, maximumDelayMs: 0 },
    undefined,
    undefined,
    evidenceServices()
  );
  await assert.rejects(
    writer.execute(binding, plan, CLAIMANT),
    (error: unknown) =>
      error instanceof GitHubExecutionError &&
      error.code === "CONCURRENCY_CONFLICT"
  );
  assert.equal(api.applyCount, 0);
});

test("fresh Project field and option mapping drift fails closed", async () => {
  const { binding, plan } = await projectEffectPlan();
  const api = new MockGitHubApi();
  api.state = {
    binding: {
      ...binding,
      project: {
        ...binding.project,
        bindingDigest: digest({ project: "drifted" }),
        fields: binding.project.fields.map((field) =>
          field.key === "stage"
            ? {
                ...field,
                options: field.options.map((option) =>
                  option.key === "blocked"
                    ? { ...option, nodeId: "OPT_stale" }
                    : option
                )
              }
            : field
        )
      }
    },
    contractDigest: plan.expected.contractDigest,
    receiptHead: plan.expected.receiptHead,
    projectSchemaDigest: plan.expected.projectSchemaDigest
  };
  let signCount = 0;
  const writer = new GitHubSingleWriter(
    credentialBroker(api, (grant) => grant, () => {
      signCount += 1;
    }),
    { maxAttempts: 1, baseDelayMs: 0, maximumDelayMs: 0 },
    undefined,
    undefined,
    evidenceServices()
  );
  await assert.rejects(
    writer.execute(binding, plan, CLAIMANT),
    (error: unknown) =>
      error instanceof GitHubExecutionError &&
      error.code === "BINDING_STALE"
  );
  assert.equal(signCount, 1);
  assert.equal(api.applyCount, 0);
});

test("actor authorization binds human identity, role, team, and review head", async () => {
  const { api } = await writerFixture();
  api.authorization = {
    ...api.authorization,
    reviewCommitId: pullRequest.head.sha
  };
  const input: ActorAuthorizationInput = {
    repositoryId: repository.id,
    actorId: 3001,
    actorNodeId: "U_kgDOUser",
    requiredRepositoryPermissions: ["admin", "maintain"],
    requiredOrganizationRole: "direct_member",
    requiredTeamNodeIds: ["T_core"],
    requesterActorId: 4001,
    requireHuman: true,
    requireIndependent: true,
    pullRequestNumber: 3,
    expectedReviewCommitId: pullRequest.head.sha
  };
  const authorized = await authorizeGitHubActor(api, input);
  assert.equal(authorized.actorNodeId, input.actorNodeId);
  api.authorization = { ...api.authorization, bot: true };
  await assert.rejects(
    authorizeGitHubActor(api, input),
    (error: unknown) =>
      error instanceof GitHubExecutionError &&
      error.code === "ACTOR_UNAUTHORIZED"
  );
  api.authorization = {
    ...api.authorization,
    bot: false,
    reviewCommitId: pullRequest.base.sha
  };
  await assert.rejects(
    authorizeGitHubActor(api, input),
    (error: unknown) =>
      error instanceof GitHubExecutionError &&
      error.code === "ACTOR_UNAUTHORIZED"
  );
  await assert.rejects(
    authorizeGitHubActor(api, {
      ...input,
      requesterActorId: null
    }),
    (error: unknown) =>
      error instanceof GitHubExecutionError &&
      error.code === "ACTOR_UNAUTHORIZED"
  );
});

test("concurrency key is exact per repository and work item", async () => {
  const binding = await trustedIssueBinding();
  assert.equal(
    githubConcurrencyKey(binding),
    "github-1001-I_kwDOIssue"
  );
});

class RecordingTransport implements AuthenticatedGitHubTransport {
  requests: GitHubHttpRequest[] = [];
  responses: GitHubHttpResponse[] = [];

  async request(request: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (response === undefined) throw new Error("no response");
    return response;
  }
}

test("HTTP operations send explicit version, media type, and user agent", async () => {
  const transport = new RecordingTransport();
  transport.responses.push({
    status: 200,
    headers: {},
    body: {
      id: 1001,
      node_id: "R_kgDORepo",
      name: "hyperfinite",
      full_name: "example-organization/hyperfinite",
      owner: { login: "example-organization" }
    }
  });
  const operations = new GitHubHttpOperations(transport);
  await operations.getRepository("example-organization", "hyperfinite");
  const headers = transport.requests[0]?.headers;
  assert.equal(headers?.["X-GitHub-Api-Version"], GITHUB_API_VERSION);
  assert.equal(headers?.Accept, "application/vnd.github+json");
  assert.match(headers?.["User-Agent"] ?? "", /agentic-framework/);
});

test("GraphQL HTTP 200 errors are failures with ambiguous mutation outcome", async () => {
  const transport = new RecordingTransport();
  transport.responses.push({
    status: 200,
    headers: {},
    body: { data: null, errors: [{ message: "stale option ID" }] }
  });
  const operations = new GitHubHttpOperations(transport);
  await assert.rejects(
    operations.graphql("mutation { noop }", {}),
    (error: unknown) =>
      error instanceof GitHubApiError &&
      error.code === "GRAPHQL_ERROR" &&
      error.outcomeAmbiguous
  );
});

test("HTTP errors are typed for 403, 404, 410, 422, 429, and 5xx", async () => {
  const cases = [
    [403, "FORBIDDEN", false],
    [404, "NOT_FOUND", false],
    [410, "GONE", false],
    [422, "VALIDATION_FAILED", false],
    [429, "RATE_LIMITED", true],
    [500, "SERVER_ERROR", true]
  ] as const;
  for (const [status, code, retryable] of cases) {
    const transport = new RecordingTransport();
    transport.responses.push({
      status,
      headers: {},
      body: { message: code }
    });
    await assert.rejects(
      new GitHubHttpOperations(transport).getRepository("example-organization", "hyperfinite"),
      (error: unknown) =>
        error instanceof GitHubApiError &&
        error.code === code &&
        error.retryable === retryable
    );
  }
});

test("HTTP 403 rate limits are distinguished from authorization failures", async () => {
  const now = new Date(NOW);
  const cases: readonly {
    readonly headers: Readonly<Record<string, string>>;
    readonly message: string;
    readonly code: "FORBIDDEN" | "RATE_LIMITED" | "RESPONSE_INVALID";
    readonly retryAfterMs: number | null;
  }[] = [
    {
      headers: { "retry-after": "2" },
      message: "retry later",
      code: "RATE_LIMITED",
      retryAfterMs: 2000
    },
    {
      headers: { "retry-after": "999999" },
      message: "retry later",
      code: "RATE_LIMITED",
      retryAfterMs: 999999000
    },
    {
      headers: {
        "retry-after": new Date(now.getTime() + 2 * 60 * 60 * 1000).toUTCString()
      },
      message: "retry later",
      code: "RATE_LIMITED",
      retryAfterMs: 2 * 60 * 60 * 1000
    },
    {
      headers: {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(Math.floor(now.getTime() / 1000) + 3)
      },
      message: "API rate limit exceeded",
      code: "RATE_LIMITED",
      retryAfterMs: 3000
    },
    {
      headers: {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(
          Math.floor(now.getTime() / 1000) + 2 * 60 * 60
        )
      },
      message: "API rate limit exceeded",
      code: "RATE_LIMITED",
      retryAfterMs: 2 * 60 * 60 * 1000
    },
    {
      headers: {},
      message: "You have exceeded a secondary rate limit.",
      code: "RATE_LIMITED",
      retryAfterMs: null
    },
    {
      headers: {
        "retry-after": "invalid",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "invalid"
      },
      message: "Resource not accessible by integration",
      code: "RESPONSE_INVALID",
      retryAfterMs: null
    },
    {
      headers: {
        "retry-after": "999999999999999999999999"
      },
      message: "retry later",
      code: "RESPONSE_INVALID",
      retryAfterMs: null
    },
    {
      headers: {},
      message: "Resource not accessible by integration",
      code: "FORBIDDEN",
      retryAfterMs: null
    }
  ];
  for (const testCase of cases) {
    const transport = new RecordingTransport();
    transport.responses.push({
      status: 403,
      headers: testCase.headers,
      body: { message: testCase.message }
    });
    await assert.rejects(
      new GitHubHttpOperations(
        transport,
        () => now
      ).getRepository("example-organization", "hyperfinite"),
      (error: unknown) =>
        error instanceof GitHubApiError &&
        error.code === testCase.code &&
        error.retryable === (testCase.code === "RATE_LIMITED") &&
        error.retryAfterMs === testCase.retryAfterMs
    );
  }
});

test("setup CLI rejects autonomous apply before reading or minting anything", () => {
  const result = spawnSync(
    process.execPath,
    ["dist/scripts/github-setup.js", "plan", "--apply"],
    { cwd: ROOT, encoding: "utf8" }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /dry-run only/);
});
