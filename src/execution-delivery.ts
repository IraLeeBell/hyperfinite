import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { canonicalJson, digest } from "./canonical.js";
import type { ExecutionClock } from "./bounded-worktree.js";
import type { RuntimeAuthorization, RuntimeAuthorizationVerifier } from "./copilot-runtime.js";
import {
  assertTrustedExecutionFreshnessAuthority,
  consumeTrustedExecutionBundle,
  type TrustedExecutionBundle,
  type TrustedExecutionDeliveryPort,
  type TrustedExecutionFreshnessAuthority
} from "./execution-bridge.js";
import {
  rebindEngineeringPullRequest,
  type DeliveryAuthorizationProvider,
  type EngineeringDeliveryEffect,
  type EngineeringEffectExecutionResult,
  type EngineeringGitHubAdapter,
  type EngineeringPullRequestBinding,
  type EngineeringWorkBinding,
  type EvidenceVerifier,
  type ThreatScanner,
  type TrustedValidatedPatchBundle
} from "./engineering-slice.js";
import type { Digest } from "./types.js";
import { assertDocument } from "./validation.js";
import type { TrustedDemoRuntimeBinding } from "./demo-portfolio.js";

declare const authenticatedArtifactConsumptionProofBrand: unique symbol;

export interface AuthenticatedArtifactConsumptionProof {
  readonly [authenticatedArtifactConsumptionProofBrand]: true;
}

const authenticatedArtifactConsumptionProofs = new WeakSet<object>();

function issueAuthenticatedArtifactConsumptionProof(): AuthenticatedArtifactConsumptionProof {
  const proof = Object.freeze(
    Object.create(null)
  ) as AuthenticatedArtifactConsumptionProof;
  authenticatedArtifactConsumptionProofs.add(proof);
  return proof;
}

export function assertAuthenticatedArtifactConsumptionProof(
  proof: AuthenticatedArtifactConsumptionProof
): void {
  if (
    typeof proof !== "object" ||
    proof === null ||
    !authenticatedArtifactConsumptionProofs.has(proof)
  ) {
    fail("execution bundle lacks authenticated artifact consumption");
  }
}

const BUNDLE_FILE = "agentic-execution-bundle.json";
const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;

function fail(message: string): never {
  throw new TypeError(`trusted execution delivery refused: ${message}`);
}

export interface TrustedExecutionDeliveryRequest {
  readonly schemaVersion: "1.0.0";
  readonly repositoryId: number;
  readonly repositoryFullName: string;
  readonly workflowRef: string;
  readonly workflowSha: string;
  readonly runId: number;
  readonly runAttempt: number;
  readonly artifactId: number;
  readonly artifactName: string;
  readonly artifactArchiveDigest: Digest;
  readonly bundleDigest: Digest;
}

export interface TrustedWorkflowIdentity {
  readonly repositoryId: number;
  readonly repositoryFullName: string;
  readonly workflowRef: string;
  readonly workflowSha: string;
  readonly runId: number;
  readonly runAttempt: number;
}

export interface DownloadedTrustedExecutionArtifact {
  readonly repositoryId: number;
  readonly artifactId: number;
  readonly artifactName: string;
  readonly runId: number;
  readonly runAttempt: number;
  readonly archiveBytes: Uint8Array;
}

export interface TrustedExecutionArtifactDownloader {
  download(
    request: TrustedExecutionDeliveryRequest
  ): Promise<DownloadedTrustedExecutionArtifact>;
}

export interface CanonicalEngineeringBindingResolver {
  resolve(input: {
    readonly repositoryId: number;
    readonly workItemNodeId: string;
    readonly bindingDigest: Digest;
  }): Promise<EngineeringWorkBinding>;
  readCurrent(input: {
    readonly repositoryId: number;
    readonly workItemNodeId: string;
  }): Promise<EngineeringWorkBinding>;
}

export interface TrustedDraftPullRequestDeliveryResult {
  readonly binding: EngineeringWorkBinding;
  readonly pullRequest: EngineeringPullRequestBinding;
  readonly headSha: string;
  readonly effectEvidenceDigests: readonly Digest[];
}

function assertRequest(
  request: TrustedExecutionDeliveryRequest,
  identity: TrustedWorkflowIdentity
): void {
  if (
    Object.keys(request).sort().join(",") !==
      "artifactArchiveDigest,artifactId,artifactName,bundleDigest,repositoryFullName,repositoryId,runAttempt,runId,schemaVersion,workflowRef,workflowSha" ||
    request.schemaVersion !== "1.0.0" ||
    !Number.isSafeInteger(request.repositoryId) ||
    request.repositoryId < 1 ||
    request.repositoryId !== identity.repositoryId ||
    request.repositoryFullName !== identity.repositoryFullName ||
    request.workflowRef !== identity.workflowRef ||
    request.workflowSha !== identity.workflowSha ||
    request.runId !== identity.runId ||
    request.runAttempt !== identity.runAttempt ||
    !Number.isSafeInteger(request.artifactId) ||
    request.artifactId < 1 ||
    request.artifactName !==
      `agentic-execution-bundle-${identity.runId}-${identity.runAttempt}` ||
    !/^sha256:[0-9a-f]{64}$/u.test(request.artifactArchiveDigest) ||
    !/^sha256:[0-9a-f]{64}$/u.test(request.bundleDigest)
  ) {
    fail("workflow identity or exact artifact identity is invalid");
  }
}

function parseBundle(content: string, expectedDigest: Digest): unknown {
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch {
    fail("bundle file is not JSON");
  }
  if (content !== `${canonicalJson(value)}\n` || digest(value) !== expectedDigest) {
    fail("bundle file is not the exact canonical signed artifact");
  }
  return value;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function findEndOfCentralDirectory(archive: Buffer): number {
  const minimum = Math.max(0, archive.length - 65_557);
  for (let offset = archive.length - 22; offset >= minimum; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  fail("artifact archive has no ZIP end record");
}

function extractBundleFile(archiveBytes: Uint8Array): string {
  const archive = Buffer.from(archiveBytes);
  if (archive.length < 22 || archive.length > MAX_ARCHIVE_BYTES) {
    fail("artifact archive size is outside the trusted limit");
  }
  const endOffset = findEndOfCentralDirectory(archive);
  const diskNumber = archive.readUInt16LE(endOffset + 4);
  const centralDisk = archive.readUInt16LE(endOffset + 6);
  const entriesOnDisk = archive.readUInt16LE(endOffset + 8);
  const totalEntries = archive.readUInt16LE(endOffset + 10);
  const centralSize = archive.readUInt32LE(endOffset + 12);
  const centralOffset = archive.readUInt32LE(endOffset + 16);
  const commentLength = archive.readUInt16LE(endOffset + 20);
  if (
    diskNumber !== 0 ||
    centralDisk !== 0 ||
    entriesOnDisk !== 1 ||
    totalEntries !== 1 ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff ||
    endOffset + 22 + commentLength !== archive.length ||
    centralOffset + centralSize !== endOffset ||
    centralOffset + 46 > endOffset ||
    archive.readUInt32LE(centralOffset) !== 0x02014b50
  ) {
    fail("artifact archive must contain one non-ZIP64 file");
  }
  const flags = archive.readUInt16LE(centralOffset + 8);
  const compression = archive.readUInt16LE(centralOffset + 10);
  const expectedCrc = archive.readUInt32LE(centralOffset + 16);
  const compressedSize = archive.readUInt32LE(centralOffset + 20);
  const uncompressedSize = archive.readUInt32LE(centralOffset + 24);
  const fileNameLength = archive.readUInt16LE(centralOffset + 28);
  const extraLength = archive.readUInt16LE(centralOffset + 30);
  const entryCommentLength = archive.readUInt16LE(centralOffset + 32);
  const localOffset = archive.readUInt32LE(centralOffset + 42);
  const centralEnd =
    centralOffset + 46 + fileNameLength + extraLength + entryCommentLength;
  const fileName = archive
    .subarray(centralOffset + 46, centralOffset + 46 + fileNameLength)
    .toString("utf8");
  if (
    centralEnd !== endOffset ||
    fileName !== BUNDLE_FILE ||
    (flags & 0x1) !== 0 ||
    (compression !== 0 && compression !== 8) ||
    compressedSize > MAX_ARCHIVE_BYTES ||
    uncompressedSize > MAX_BUNDLE_BYTES ||
    localOffset + 30 > centralOffset ||
    archive.readUInt32LE(localOffset) !== 0x04034b50
  ) {
    fail("artifact archive entry is not the exact supported bundle file");
  }
  const localFlags = archive.readUInt16LE(localOffset + 6);
  const localCompression = archive.readUInt16LE(localOffset + 8);
  const localNameLength = archive.readUInt16LE(localOffset + 26);
  const localExtraLength = archive.readUInt16LE(localOffset + 28);
  const localName = archive
    .subarray(localOffset + 30, localOffset + 30 + localNameLength)
    .toString("utf8");
  const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
  const dataEnd = dataOffset + compressedSize;
  if (
    localFlags !== flags ||
    localCompression !== compression ||
    localName !== BUNDLE_FILE ||
    dataEnd > centralOffset
  ) {
    fail("artifact archive local entry differs from its central record");
  }
  const compressed = archive.subarray(dataOffset, dataEnd);
  const content =
    compression === 0
      ? Buffer.from(compressed)
      : inflateRawSync(compressed, { maxOutputLength: MAX_BUNDLE_BYTES });
  if (content.length !== uncompressedSize || crc32(content) !== expectedCrc) {
    fail("artifact archive content checksum or length is invalid");
  }
  return content.toString("utf8");
}

function assertBundleWorkflowIdentity(
  bundleValue: unknown,
  request: TrustedExecutionDeliveryRequest
): void {
  if (
    typeof bundleValue !== "object" ||
    bundleValue === null ||
    !Object.hasOwn(bundleValue, "authorization")
  ) {
    fail("bundle omits its signed runtime authorization");
  }
  const authorization = (
    bundleValue as { readonly authorization?: unknown }
  ).authorization;
  if (
    typeof authorization !== "object" ||
    authorization === null ||
    (authorization as Readonly<Record<string, unknown>>).repositoryId !==
      request.repositoryId ||
    (authorization as Readonly<Record<string, unknown>>).repositoryFullName !==
      request.repositoryFullName ||
    (authorization as Readonly<Record<string, unknown>>).workflowRef !==
      request.workflowRef ||
    (authorization as Readonly<Record<string, unknown>>).workflowSha !==
      request.workflowSha ||
    (authorization as Readonly<Record<string, unknown>>).runId !== request.runId ||
    (authorization as Readonly<Record<string, unknown>>).runAttempt !==
      request.runAttempt
  ) {
    fail("bundle authorization is not bound to the authenticated workflow run");
  }
}

export async function consumeTrustedExecutionArtifact<T>(input: {
  readonly request: TrustedExecutionDeliveryRequest;
  readonly identity: TrustedWorkflowIdentity;
  readonly downloader: TrustedExecutionArtifactDownloader;
  readonly authorizationVerifier: RuntimeAuthorizationVerifier;
  readonly evidenceVerifier: EvidenceVerifier;
  readonly runtimePolicyValue: unknown;
  readonly controlPolicyValue: unknown;
  readonly clock: ExecutionClock;
  readonly delivery: TrustedExecutionDeliveryPort<T>;
  readonly trustedDemoBinding?: TrustedDemoRuntimeBinding;
}): Promise<T> {
  const runtimePolicy = assertDocument(
    "CopilotRuntimePolicy",
    input.runtimePolicyValue
  );
  if (Object.hasOwn(input, "maximumEvidenceAgeMs")) {
    fail("caller-controlled evidence age is forbidden");
  }
  assertRequest(input.request, input.identity);
  const downloaded = await input.downloader.download(input.request);
  if (
    downloaded.repositoryId !== input.request.repositoryId ||
    downloaded.artifactId !== input.request.artifactId ||
    downloaded.artifactName !== input.request.artifactName ||
    downloaded.runId !== input.request.runId ||
    downloaded.runAttempt !== input.request.runAttempt ||
    `sha256:${createHash("sha256")
      .update(downloaded.archiveBytes)
      .digest("hex")}` !== input.request.artifactArchiveDigest
  ) {
    fail("downloaded artifact identity or contents differ from the request");
  }
  const bundleValue = parseBundle(
    extractBundleFile(downloaded.archiveBytes),
    input.request.bundleDigest
  );
  assertBundleWorkflowIdentity(bundleValue, input.request);
  return consumeTrustedExecutionBundle({
    bundleValue,
    authorizationVerifier: input.authorizationVerifier,
    evidenceVerifier: input.evidenceVerifier,
    runtimePolicyValue: runtimePolicy,
    controlPolicyValue: input.controlPolicyValue,
    clock: input.clock,
    artifactConsumptionProof: issueAuthenticatedArtifactConsumptionProof(),
    delivery: input.delivery,
    ...(input.trustedDemoBinding === undefined
      ? {}
      : { trustedDemoBinding: input.trustedDemoBinding })
  });
}

function trustedBranchName(
  binding: EngineeringWorkBinding,
  authorization: RuntimeAuthorization
): string {
  return `agentic/issue-${binding.issue.number}-r${authorization.contractRevision}`;
}

function trustedPullRequestBody(binding: EngineeringWorkBinding): string {
  return [
    "## Summary",
    "",
    "Applies the authenticated bounded implementation artifact.",
    "",
    "## Authority",
    "",
    "Targets were derived by trusted code from the canonical work binding.",
    "",
    `Relates to #${binding.issue.number}`
  ].join("\n");
}

export class EngineeringDraftPullRequestDeliveryPort
  implements TrustedExecutionDeliveryPort<TrustedDraftPullRequestDeliveryResult>
{
  constructor(
    private readonly bindingResolver: CanonicalEngineeringBindingResolver,
    private readonly github: EngineeringGitHubAdapter,
    private readonly deliveryAuthorizations: DeliveryAuthorizationProvider,
    private readonly threatScanner: ThreatScanner,
    ...legacyFreshness: never[]
  ) {
    if (legacyFreshness.length !== 0) {
      fail("delivery freshness must come from the validated runtime policy");
    }
  }

  async deliver(input: {
    readonly authorization: RuntimeAuthorization;
    readonly artifact: TrustedExecutionBundle["artifact"];
    readonly patchBundle: TrustedValidatedPatchBundle;
    readonly freshnessAuthority: TrustedExecutionFreshnessAuthority;
  }): Promise<TrustedDraftPullRequestDeliveryResult> {
    const trustedFreshness = assertTrustedExecutionFreshnessAuthority(
      input.freshnessAuthority
    );
    const authorization = input.authorization;
    if (
      authorization.authorizationDigest !==
        trustedFreshness.authorizationDigest ||
      digest(authorization) !== digest(trustedFreshness.authorization) ||
      digest(input.artifact) !== trustedFreshness.patchArtifactDigest ||
      digest(input.patchBundle) !== trustedFreshness.patchBundleDigest
    ) {
      fail(
        "freshness authority does not bind the delivered authorization and artifacts"
      );
    }
    const binding = await this.bindingResolver.resolve({
      repositoryId: authorization.repositoryId,
      workItemNodeId: authorization.workItemNodeId,
      bindingDigest: authorization.bindingDigest
    });
    if (
      digest(binding) !== authorization.bindingDigest ||
      binding.repository.id !== authorization.repositoryId ||
      binding.repository.fullName !== authorization.repositoryFullName ||
      authorization.workItemKind !== "issue" ||
      binding.issue.number !== authorization.workItemNumber ||
      binding.issue.nodeId !== authorization.workItemNodeId ||
      binding.project.nodeId !== authorization.projectNodeId ||
      binding.project.itemNodeId !== authorization.projectItemNodeId ||
      input.artifact.repositoryId !== binding.repository.id ||
      input.artifact.workItemNodeId !== binding.issue.nodeId ||
      input.patchBundle.bindingDigest !== digest(binding)
    ) {
      fail("canonical binding does not match the signed runtime authorization");
    }
    const currentBinding = await this.bindingResolver.readCurrent({
      repositoryId: authorization.repositoryId,
      workItemNodeId: authorization.workItemNodeId
    });
    const branchName = trustedBranchName(binding, authorization);
    const replaying = digest(currentBinding) !== digest(binding);
    if (
      replaying &&
      (currentBinding.previousBindingDigest !== authorization.bindingDigest ||
        currentBinding.pullRequest === null ||
        currentBinding.pullRequest.baseSha !== input.artifact.baseSha ||
        currentBinding.pullRequest.baseRepositoryId !== binding.repository.id ||
        currentBinding.pullRequest.headRepositoryId !== binding.repository.id ||
        currentBinding.pullRequest.headRef !== branchName)
    ) {
      fail("current canonical binding is not an exact completed delivery rebind");
    }
    const snapshot = replaying
      ? null
      : await this.github.readBoundSnapshot(binding, true);
    const recoveringDraft =
      snapshot !== null && snapshot.pullRequest !== null;
    if (
      (snapshot !== null &&
        snapshot.defaultBranch.sha !== input.artifact.baseSha) ||
      (recoveringDraft &&
        (snapshot?.pullRequest?.baseSha !== input.artifact.baseSha ||
          snapshot.pullRequest.baseRef !== snapshot.defaultBranch.ref ||
          snapshot.pullRequest.headRef !== branchName ||
          snapshot.pullRequest.baseRepositoryId !== binding.repository.id ||
          snapshot.pullRequest.headRepositoryId !== binding.repository.id ||
          snapshot.pullRequest.draft !== true ||
          !snapshot.pullRequest.open ||
          snapshot.pullRequest.merged))
    ) {
      fail("default-branch base or pull-request state changed before delivery");
    }

    const workflowId = authorization.workflowId;
    const contractRevision = authorization.contractRevision;
    const evidenceDigests: Digest[] = [];
    let ordinal = 1;
    const execute = async (
      effect: EngineeringDeliveryEffect,
      patchBundle?: TrustedValidatedPatchBundle
    ): Promise<EngineeringEffectExecutionResult> => {
      const now = trustedFreshness.clock.now();
      const deliveryAuthorization = await this.deliveryAuthorizations.issue({
        workflowId,
        contractRevision,
        effect,
        binding,
        workAccordDigest: authorization.contractDigest,
        activationLeaseDigest: authorization.activationLeaseDigest,
        executionGrantDigest: input.artifact.executionGrantDigest,
        kernelReceiptDigest: authorization.kernelReceiptDigest,
        now
      });
      const threatEvidence = await this.threatScanner.scan({
        authorizationDigest: deliveryAuthorization.authorizationDigest,
        modelOutputDigest: input.artifact.modelOutputDigest,
        kernelReceiptDigest: authorization.kernelReceiptDigest,
        now
      });
      const result = await this.github.execute({
        freshnessAuthority: input.freshnessAuthority,
        patchArtifactDigest: digest(input.artifact),
        patchBundleDigest: digest(input.patchBundle),
        executionBundleDigest: trustedFreshness.executionBundleDigest,
          workflowId,
          contractRevision,
          effect,
          binding,
          workAccordDigest: authorization.contractDigest,
          activationLeaseDigest: authorization.activationLeaseDigest,
          executionGrantDigest: input.artifact.executionGrantDigest,
          kernelReceiptDigest: authorization.kernelReceiptDigest,
          authorization: deliveryAuthorization,
          threatEvidence,
          modelOutputDigest: input.artifact.modelOutputDigest,
          ...(replaying && effect.type === "create-draft-pull-request"
            ? { completedReplayBinding: currentBinding }
            : {}),
        ...(patchBundle === undefined ? {} : { patchBundle })
      });
      evidenceDigests.push(digest(result.evidence));
      return result;
    };

    const baseRef = replaying
      ? currentBinding.pullRequest?.baseRef
      : recoveringDraft
        ? snapshot?.pullRequest?.baseRef
        : snapshot?.defaultBranch.ref;
    if (baseRef === undefined) {
      fail("replayed delivery omits its canonical base ref");
    }
    const branch = await execute({
      type: "create-branch",
      ordinal: ordinal++,
      repositoryId: binding.repository.id,
      issueNodeId: binding.issue.nodeId,
      baseRef,
      baseSha: input.artifact.baseSha,
      headRef: branchName
    });
    if (branch.observation.type !== "create-branch") {
      fail("branch effect returned the wrong typed observation");
    }
    const commit = await execute(
      {
        type: "create-commit",
        ordinal: ordinal++,
        repositoryId: binding.repository.id,
        issueNodeId: binding.issue.nodeId,
        headRef: branchName,
        parentSha: branch.observation.headSha,
        patchDigest: input.patchBundle.patchDigest,
        treeDigest: input.patchBundle.treeDigest,
        gitTreeSha: input.patchBundle.gitTreeSha,
        patchBundleDigest: digest(input.patchBundle)
      },
      input.patchBundle
    );
    if (commit.observation.type !== "create-commit") {
      fail("commit effect returned the wrong typed observation");
    }
    const drafted = await execute({
      type: "create-draft-pull-request",
      ordinal: ordinal++,
      repositoryId: binding.repository.id,
      issueNodeId: binding.issue.nodeId,
      projectItemNodeId: binding.project.itemNodeId,
      baseRepositoryId: binding.repository.id,
      baseRef,
      baseSha: input.artifact.baseSha,
      headRepositoryId: binding.repository.id,
      headRef: branchName,
      headSha: commit.observation.commitSha,
      title: `Bounded implementation for #${binding.issue.number}`,
      body: trustedPullRequestBody(binding),
      draft: true
    });
    if (drafted.observation.type !== "create-draft-pull-request") {
      fail("draft pull-request effect returned the wrong typed observation");
    }
    const observedPullRequest = drafted.observation.pullRequest;
    const pullRequest: EngineeringPullRequestBinding = {
      number: observedPullRequest.number,
      nodeId: observedPullRequest.nodeId,
      baseRepositoryId: observedPullRequest.baseRepositoryId,
      baseRef: observedPullRequest.baseRef,
      baseSha: observedPullRequest.baseSha,
      headRepositoryId: observedPullRequest.headRepositoryId,
      headRef: observedPullRequest.headRef,
      headSha: observedPullRequest.headSha
    };
    const bindEffect: EngineeringDeliveryEffect = {
      type: "bind-pull-request",
      ordinal: ordinal++,
      expectedBindingDigest: digest(binding),
      pullRequest,
      receiptHead: binding.receiptHead
    };
    const rebound = await execute(bindEffect);
    const expectedBinding = rebindEngineeringPullRequest({
      binding,
      expectedBindingDigest: bindEffect.expectedBindingDigest,
      pullRequest,
      receiptHead: rebound.evidence.effectDigest ?? rebound.observation.effectDigest
    });
    const persistedBinding = await this.bindingResolver.readCurrent({
      repositoryId: authorization.repositoryId,
      workItemNodeId: authorization.workItemNodeId
    });
    if (
      digest(persistedBinding) !== digest(expectedBinding) ||
      canonicalJson(persistedBinding) !== canonicalJson(expectedBinding)
    ) {
      fail("pull-request binding effect did not persist the exact canonical rebind");
    }
    return {
      binding: persistedBinding,
      pullRequest,
      headSha: pullRequest.headSha,
      effectEvidenceDigests: evidenceDigests
    };
  }
}
