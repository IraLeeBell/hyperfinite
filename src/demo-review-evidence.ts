import { canonicalJson, digest } from "./canonical.js";
import {
  assertTrustedDemoRuntimeRegistration,
  type TrustedDemoRuntimeBinding
} from "./demo-portfolio.js";
import type {
  DemoEvidenceSigner,
  DemoEvidenceVerifier
} from "./demo-activation.js";
import type { DemoProjectId, DemoSignature } from "./demo-types.js";
import type { TrustedGitHubBinding } from "./github-events.js";
import type { Digest } from "./types.js";
import { assertDocument, isCanonicalUtcDateTime } from "./validation.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const SHA = /^[0-9a-f]{40}$/u;

const EXPECTED_COMMANDS: Readonly<
  Record<DemoProjectId, readonly string[]>
> = {
  "app-modernization": [
    "typecheck",
    "build",
    "unit-tests",
    "security",
    "compatibility",
    "migration-dry-run"
  ],
  "feature-delivery": [
    "fd-acceptance-tests",
    "fd-regression-tests",
    "fd-typecheck",
    "git-diff-check"
  ],
  "security-dependency-remediation": [],
  "adaptive-delivery": [
    "adaptive-acceptance-tests",
    "adaptive-regression-tests",
    "adaptive-typecheck",
    "git-diff-check"
  ]
};

const EXPECTED_CHECKS: Readonly<Record<DemoProjectId, readonly string[]>> = {
  "app-modernization": [
    "closed-artifacts",
    "logical-slot-confinement",
    "draft-only-delivery"
  ],
  "feature-delivery": [
    "acceptance-criteria",
    "logical-slot-confinement",
    "draft-only-delivery"
  ],
  "security-dependency-remediation": [
    "fixed-regression",
    "dependency-lock-consistency",
    "threat-detection",
    "dlp-scan",
    "synthetic-security-scan",
    "unrelated-scanner-finding-open-unchanged",
    "automation-review-comment-only"
  ],
  "adaptive-delivery": [
    "hybrid-acceptance-criteria",
    "logical-slot-confinement",
    "draft-only-delivery",
    "exact-selected-agent",
    "comment-only-review"
  ]
};

export interface DemoReviewDiffFile {
  readonly pathDigest: Digest;
  readonly status: "added" | "modified";
  readonly additions: number;
  readonly deletions: number;
  readonly blobSha: string;
  readonly patchDigest: Digest | null;
}

export interface DemoReviewCommandEvidence {
  readonly id: string;
  readonly status: "success";
  readonly stdoutDigest: Digest;
  readonly stderrDigest: Digest;
}

export interface DemoReviewCheckEvidence {
  readonly id: string;
  readonly status: "success" | "information";
  readonly evidenceDigest: Digest;
}

export interface DemoReviewEvidenceBundle {
  readonly schemaVersion: "1.0.0";
  readonly demoProjectId: DemoProjectId;
  readonly stageId: string;
  readonly trustedRuntimeBindingDigest: Digest;
  readonly projectProfileDigest: Digest;
  readonly journeyDefinitionDigest: Digest;
  readonly stageAgentBindingsDigest: Digest;
  readonly capabilityShardDigest: Digest;
  readonly repositoryBindingDigest: Digest;
  readonly trustedGitHubBindingDigest: Digest;
  readonly repositoryId: number;
  readonly workItemNodeId: string;
  readonly pullRequest: {
    readonly number: number;
    readonly baseSha: string;
    readonly headSha: string;
    readonly draft: true;
    readonly state: "open";
  };
  readonly diffFiles: readonly DemoReviewDiffFile[];
  readonly diffFileCount: number;
  readonly diffPageCount: number;
  readonly diffCollectionComplete: true;
  readonly diffCollectionDigest: Digest;
  readonly commandCatalogDigest: Digest;
  readonly commands: readonly DemoReviewCommandEvidence[];
  readonly checks: readonly DemoReviewCheckEvidence[];
  readonly reviewEvent: "COMMENT";
  readonly headMovementInvalidates: true;
  readonly externalCallCount: 0;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly bundleDigest: Digest;
  readonly signature: DemoSignature;
}

type UnsignedReviewBundle = Omit<
  DemoReviewEvidenceBundle,
  "bundleDigest" | "signature"
>;

export interface DemoReviewEvidenceObservation {
  readonly repositoryBindingDigest: Digest;
  readonly trustedGitHubBinding: TrustedGitHubBinding;
  readonly pullRequestState: {
    readonly draft: true;
    readonly state: "open";
  };
  readonly diffFiles: readonly DemoReviewDiffFile[];
  readonly diffPageCount: number;
  readonly diffCollectionComplete: true;
  readonly commands: readonly DemoReviewCommandEvidence[];
  readonly checks: readonly DemoReviewCheckEvidence[];
  readonly observedAt: string;
}

export interface DemoReviewEvidenceReader {
  read(): Promise<DemoReviewEvidenceObservation>;
}

function fail(message: string): never {
  throw new TypeError(`demo review evidence refused: ${message}`);
}

function exactKeys(
  value: object,
  keys: readonly string[],
  subject: string
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(`${subject} fields are not closed`);
  }
}

function exactIds(
  actual: readonly string[],
  expected: readonly string[],
  subject: string
): void {
  if (
    actual.length !== expected.length ||
    new Set(actual).size !== actual.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    fail(`${subject} differs from the exact trusted catalog`);
  }
}

function validCounter(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validateUnsigned(
  value: UnsignedReviewBundle,
  trustedDemoBinding: TrustedDemoRuntimeBinding,
  observation: DemoReviewEvidenceObservation
): void {
  exactKeys(
    observation,
    [
      "repositoryBindingDigest",
      "trustedGitHubBinding",
      "pullRequestState",
      "diffFiles",
      "diffPageCount",
      "diffCollectionComplete",
      "commands",
      "checks",
      "observedAt"
    ],
    "trusted review observation"
  );
  exactKeys(
    observation.pullRequestState,
    ["draft", "state"],
    "trusted pull request state"
  );
  const trustedGitHubBinding = observation.trustedGitHubBinding;
  exactKeys(
    value,
    [
      "schemaVersion",
      "demoProjectId",
      "stageId",
      "trustedRuntimeBindingDigest",
      "projectProfileDigest",
      "journeyDefinitionDigest",
      "stageAgentBindingsDigest",
      "capabilityShardDigest",
      "repositoryBindingDigest",
      "trustedGitHubBindingDigest",
      "repositoryId",
      "workItemNodeId",
      "pullRequest",
      "diffFiles",
      "diffFileCount",
      "diffPageCount",
      "diffCollectionComplete",
      "diffCollectionDigest",
      "commandCatalogDigest",
      "commands",
      "checks",
      "reviewEvent",
      "headMovementInvalidates",
      "externalCallCount",
      "createdAt",
      "expiresAt"
    ],
    "review bundle"
  );
  exactKeys(
    value.pullRequest,
    ["number", "baseSha", "headSha", "draft", "state"],
    "pull request"
  );
  const registration =
    assertTrustedDemoRuntimeRegistration(trustedDemoBinding);
  const binding = registration.binding;
  const target = registration.targetIdentity;
  if (
    value.schemaVersion !== "1.0.0" ||
    value.demoProjectId !== binding.demoProjectId ||
    value.stageId !== binding.stageId ||
    binding.workflowClass !== "current-head-comment-review" ||
    binding.phase !== "verification" ||
    value.trustedRuntimeBindingDigest !== digest(binding) ||
    value.projectProfileDigest !== registration.projectProfileDigest ||
    value.journeyDefinitionDigest !== registration.journeyDefinitionDigest ||
    value.stageAgentBindingsDigest !==
      registration.stageAgentBindingsDigest ||
    value.capabilityShardDigest !== registration.capabilityShardDigest ||
    target === null ||
    registration.targetIdentityExpiresAt === null ||
    Date.parse(value.createdAt) >=
      Date.parse(registration.targetIdentityExpiresAt) ||
    Date.parse(value.expiresAt) >
      Date.parse(registration.targetIdentityExpiresAt) ||
    observation.repositoryBindingDigest !==
      registration.repositoryBindingDigest ||
    value.repositoryBindingDigest !== registration.repositoryBindingDigest ||
    trustedGitHubBinding.workItem.kind !== "pull-request" ||
    trustedGitHubBinding.repository.id !== target.repositoryId ||
    trustedGitHubBinding.repository.nodeId !== target.repositoryNodeId ||
    trustedGitHubBinding.repository.fullName !== target.repositoryFullName ||
    trustedGitHubBinding.workItem.number !== target.workItemNumber ||
    trustedGitHubBinding.workItem.nodeId !== target.workItemNodeId ||
    trustedGitHubBinding.project.ownerNodeId !== target.projectOwnerNodeId ||
    trustedGitHubBinding.project.projectNodeId !== target.projectNodeId ||
    trustedGitHubBinding.project.itemNodeId !== target.projectItemNodeId ||
    value.trustedGitHubBindingDigest !== digest(trustedGitHubBinding) ||
    value.repositoryId !== trustedGitHubBinding.repository.id ||
    value.workItemNodeId !== trustedGitHubBinding.workItem.nodeId ||
    trustedGitHubBinding.project.bindingDigest !==
      registration.projectBindingDigest ||
    value.pullRequest.number !== trustedGitHubBinding.workItem.number ||
    value.pullRequest.baseSha !== trustedGitHubBinding.workItem.base.sha ||
    value.pullRequest.headSha !== trustedGitHubBinding.workItem.head.sha ||
    observation.pullRequestState.draft !== true ||
    observation.pullRequestState.state !== "open" ||
    value.pullRequest.draft !== observation.pullRequestState.draft ||
    value.pullRequest.state !== observation.pullRequestState.state ||
    canonicalJson(value.diffFiles) !== canonicalJson(observation.diffFiles) ||
    value.diffPageCount !== observation.diffPageCount ||
    value.diffCollectionComplete !== observation.diffCollectionComplete ||
    canonicalJson(value.commands) !== canonicalJson(observation.commands) ||
    canonicalJson(value.checks) !== canonicalJson(observation.checks) ||
    !isCanonicalUtcDateTime(observation.observedAt) ||
    observation.observedAt !== value.createdAt ||
    !Number.isSafeInteger(value.pullRequest.number) ||
    value.pullRequest.number < 1 ||
    !SHA.test(value.pullRequest.baseSha) ||
    !SHA.test(value.pullRequest.headSha) ||
    value.pullRequest.draft !== true ||
    value.pullRequest.state !== "open" ||
    value.diffFiles.length < 1 ||
    value.diffFiles.length > 299 ||
    value.diffFileCount !== value.diffFiles.length ||
    !Number.isSafeInteger(value.diffPageCount) ||
    value.diffPageCount < 1 ||
    value.diffCollectionComplete !== true ||
    value.diffCollectionDigest !== digest(value.diffFiles) ||
    value.reviewEvent !== "COMMENT" ||
    value.headMovementInvalidates !== true ||
    value.externalCallCount !== 0 ||
    !isCanonicalUtcDateTime(value.createdAt) ||
    !isCanonicalUtcDateTime(value.expiresAt) ||
    Date.parse(value.createdAt) >= Date.parse(value.expiresAt)
  ) {
    fail("bundle identity, current head, or authority fields are invalid");
  }
  const pathDigests = new Set<Digest>();
  for (const file of value.diffFiles) {
    exactKeys(
      file,
      [
        "pathDigest",
        "status",
        "additions",
        "deletions",
        "blobSha",
        "patchDigest"
      ],
      "diff file"
    );
    if (
      !DIGEST.test(file.pathDigest) ||
      (file.status !== "added" && file.status !== "modified") ||
      !validCounter(file.additions) ||
      !validCounter(file.deletions) ||
      !SHA.test(file.blobSha) ||
      (file.patchDigest !== null && !DIGEST.test(file.patchDigest))
    ) {
      fail("bounded pull-request diff evidence is malformed");
    }
    if (pathDigests.has(file.pathDigest)) {
      fail("bounded pull-request diff evidence contains a duplicate path");
    }
    pathDigests.add(file.pathDigest);
  }
  exactIds(
    value.commands.map((command) => command.id),
    EXPECTED_COMMANDS[value.demoProjectId],
    "verification commands"
  );
  for (const command of value.commands) {
    exactKeys(
      command,
      ["id", "status", "stdoutDigest", "stderrDigest"],
      "command evidence"
    );
    if (
      command.status !== "success" ||
      !DIGEST.test(command.stdoutDigest) ||
      !DIGEST.test(command.stderrDigest)
    ) {
      fail("fixed command evidence is not exact success");
    }
  }
  if (
    value.commandCatalogDigest !==
    digest(value.commands.map((command) => command.id))
  ) {
    fail("fixed command catalog digest is stale or substituted");
  }
  exactIds(
    value.checks.map((check) => check.id),
    EXPECTED_CHECKS[value.demoProjectId],
    "verification checks"
  );
  for (const check of value.checks) {
    exactKeys(
      check,
      ["id", "status", "evidenceDigest"],
      "check evidence"
    );
    const expectedStatus =
      check.id === "unrelated-scanner-finding-open-unchanged"
        ? "information"
        : "success";
    if (check.status !== expectedStatus || !DIGEST.test(check.evidenceDigest)) {
      fail(`verification check ${check.id} is not exact trusted evidence`);
    }
  }
}

export async function issueDemoReviewEvidenceBundle(input: {
  readonly trustedDemoBinding: TrustedDemoRuntimeBinding;
  readonly reader: DemoReviewEvidenceReader;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly signer: DemoEvidenceSigner;
}): Promise<DemoReviewEvidenceBundle> {
  const first = JSON.parse(
    canonicalJson(await input.reader.read())
  ) as DemoReviewEvidenceObservation;
  const second = JSON.parse(
    canonicalJson(await input.reader.read())
  ) as DemoReviewEvidenceObservation;
  if (
    canonicalJson(first) !== canonicalJson(second) ||
    !isCanonicalUtcDateTime(first.observedAt) ||
    Date.parse(first.observedAt) > Date.parse(input.createdAt)
  ) {
    fail("trusted review subject did not produce one stable fresh observation");
  }
  const registration =
    assertTrustedDemoRuntimeRegistration(input.trustedDemoBinding);
  if (
    registration.binding.demoProjectId === null ||
    registration.binding.stageId === null
  ) {
    fail("trusted runtime registration is not demo-stage bound");
  }
  const workItem = first.trustedGitHubBinding.workItem;
  if (workItem.kind !== "pull-request") {
    fail("trusted review subject is not a pull request");
  }
  const stable: UnsignedReviewBundle = {
    schemaVersion: "1.0.0",
    demoProjectId: registration.binding.demoProjectId,
    stageId: registration.binding.stageId,
    trustedRuntimeBindingDigest: digest(registration.binding),
    projectProfileDigest: registration.projectProfileDigest,
    journeyDefinitionDigest: registration.journeyDefinitionDigest,
    stageAgentBindingsDigest: registration.stageAgentBindingsDigest,
    capabilityShardDigest: registration.capabilityShardDigest,
    repositoryBindingDigest: registration.repositoryBindingDigest,
    trustedGitHubBindingDigest: digest(first.trustedGitHubBinding),
    repositoryId: first.trustedGitHubBinding.repository.id,
    workItemNodeId: workItem.nodeId,
    pullRequest: {
      number: workItem.number,
      baseSha: workItem.base.sha,
      headSha: workItem.head.sha,
      draft: first.pullRequestState.draft,
      state: first.pullRequestState.state
    },
    diffFiles: first.diffFiles,
    diffFileCount: first.diffFiles.length,
    diffPageCount: first.diffPageCount,
    diffCollectionComplete: first.diffCollectionComplete,
    diffCollectionDigest: digest(first.diffFiles),
    commandCatalogDigest: digest(
      first.commands.map((command) => command.id)
    ),
    commands: first.commands,
    checks: first.checks,
    reviewEvent: "COMMENT",
    headMovementInvalidates: true,
    externalCallCount: 0,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt
  };
  validateUnsigned(
    stable,
    input.trustedDemoBinding,
    first
  );
  const bundleDigest = digest(stable);
  const bundle: DemoReviewEvidenceBundle = {
    ...stable,
    bundleDigest,
    signature: await input.signer.sign(bundleDigest)
  };
  return assertDocument("DemoReviewEvidenceBundle", bundle);
}

export function validateDemoReviewEvidenceBundle(input: {
  readonly value: DemoReviewEvidenceBundle;
  readonly trustedDemoBinding: TrustedDemoRuntimeBinding;
  readonly trustedObservation: DemoReviewEvidenceObservation;
  readonly verifier: DemoEvidenceVerifier;
  readonly expectedHeadSha: string;
  readonly now: string;
}): DemoReviewEvidenceBundle {
  const stable = JSON.parse(canonicalJson(input.value)) as DemoReviewEvidenceBundle;
  exactKeys(
    stable,
    [
      "schemaVersion",
      "demoProjectId",
      "stageId",
      "trustedRuntimeBindingDigest",
      "projectProfileDigest",
      "journeyDefinitionDigest",
      "stageAgentBindingsDigest",
      "capabilityShardDigest",
      "repositoryBindingDigest",
      "trustedGitHubBindingDigest",
      "repositoryId",
      "workItemNodeId",
      "pullRequest",
      "diffFiles",
      "diffFileCount",
      "diffPageCount",
      "diffCollectionComplete",
      "diffCollectionDigest",
      "commandCatalogDigest",
      "commands",
      "checks",
      "reviewEvent",
      "headMovementInvalidates",
      "externalCallCount",
      "createdAt",
      "expiresAt",
      "bundleDigest",
      "signature"
    ],
    "signed review bundle"
  );
  const { bundleDigest, signature, ...unsigned } = stable;
  const registration = assertTrustedDemoRuntimeRegistration(
    input.trustedDemoBinding
  );
  validateUnsigned(
    unsigned,
    input.trustedDemoBinding,
    input.trustedObservation
  );
  if (
    !SHA.test(input.expectedHeadSha) ||
    stable.pullRequest.headSha !== input.expectedHeadSha ||
    stable.bundleDigest !== digest(unsigned) ||
    !input.verifier.verify(bundleDigest, signature) ||
    !isCanonicalUtcDateTime(input.now) ||
    registration.targetIdentityExpiresAt === null ||
    Date.parse(input.now) >=
      Date.parse(registration.targetIdentityExpiresAt) ||
    Date.parse(input.now) < Date.parse(stable.createdAt) ||
    Date.parse(input.now) >= Date.parse(stable.expiresAt)
  ) {
    fail("bundle signature, digest, freshness, or exact head is invalid");
  }
  return assertDocument("DemoReviewEvidenceBundle", stable);
}

export function demoReviewExpectedCommandIds(
  demoProjectId: DemoProjectId
): readonly string[] {
  return EXPECTED_COMMANDS[demoProjectId];
}

export function demoReviewExpectedCheckIds(
  demoProjectId: DemoProjectId
): readonly string[] {
  return EXPECTED_CHECKS[demoProjectId];
}
