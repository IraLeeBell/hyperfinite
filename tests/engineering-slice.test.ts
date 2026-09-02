import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  generateKeyPairSync,
  sign as signBytes,
  verify as verifyBytes
} from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  EngineeringEvidenceConflictError,
  EngineeringGitHubAdapter,
  bindEngineeringIntake,
  canonicalJson,
  digest,
  executeBoundedWorktree,
  issueAuthenticatedArtifactApproval,
  rebindEngineeringPullRequest,
  runEngineeringSlice,
  resumeEngineeringAfterHumanMerge,
  resumeEngineeringClosure,
  validateArtifactApproval,
  validateCostReservation,
  validateCostRelease,
  validateCostSettlement,
  type BoundedExecutionGrant,
  type DetachedSignature,
  type Digest,
  type EngineeringCostLedger,
  type EngineeringCostHold,
  type EngineeringCostLineageEntry,
  type EngineeringCostRelease,
  type EngineeringCostReservation,
  type EngineeringCostSettlement,
  type EngineeringCostReleaseCheckpoint,
  type EngineeringAwaitingHumanMergeCheckpoint,
  type EngineeringActivationLeaseEvidence,
  type EngineeringActivationLeaseProvider,
  type EngineeringClosureCheckpoint,
  type EngineeringClosureCheckpointStore,
  type EngineeringDeliveryAuthorization,
  type EngineeringDeliveryEffect,
  type EngineeringEffectEvidence,
  type EngineeringEffectExecutionInput,
  type EngineeringEffectObservation,
  type EngineeringEvidenceStore,
  type EngineeringGitHubApi,
  type EngineeringGitHubSnapshot,
  type EngineeringKernelPort,
  type EngineeringModel,
  type EngineeringPlanner,
  type EngineeringProviderAttempt,
  type EngineeringProviderUsage,
  type EngineeringProviderUsageLedger,
  type EngineeringWorkBinding,
  type EvidenceSigner,
  type EvidenceVerifier,
  type HumanGateProvider,
  type OperationScopedGitHubBroker,
  type SignedArtifactApproval,
  type SignedHumanApprovalEvent,
  type SignedHumanAuthorization,
  type ThreatScanner,
  type ActivationLease,
  type ControlPolicy,
  type WorkAccord
} from "../src/index.js";
import {
  obtainTrustedExecutionTestFreshness,
  type TrustedExecutionTestFreshness,
  type TrustedExecutionTestIdentity
} from "./support/trusted-execution-freshness.js";

const NOW = "2026-08-26T12:00:00.000Z";
const EXPIRES = "2027-08-26T12:00:00.000Z";
const BASE_SHA = "1111111111111111111111111111111111111111";
const COMMIT_SHA = "2222222222222222222222222222222222222222";
const MERGE_SHA = "3333333333333333333333333333333333333333";
const KERNEL_RECEIPT = digest({ kernel: "test-receipt" });
const EXECUTION_GRANT_DIGEST = digest({ grant: "test-execution-grant" });
const PHASE_TOKEN_BUDGETS = {
  framing: 100,
  execution: 100,
  verification: 100
} as const;

function executeAdapter(
  github: EngineeringGitHubAdapter,
  effect: Omit<
    EngineeringEffectExecutionInput,
    keyof TrustedExecutionTestIdentity
  >,
  freshness: TrustedExecutionTestFreshness
) {
  return github.execute({
    ...effect,
    ...freshness.identity,
    freshnessAuthority: freshness.authority,
    patchArtifactDigest: freshness.patchArtifactDigest,
    patchBundleDigest: freshness.patchBundleDigest,
    executionBundleDigest: freshness.executionBundleDigest
  });
}

type ObservationWithoutDigest<
  T = EngineeringEffectObservation
> = T extends EngineeringEffectObservation
  ? Omit<T, "effectDigest" | "effectApplied">
  : never;

function omitSignature<T extends { readonly signature: DetachedSignature }>(
  value: T
): Omit<T, "signature"> {
  const { signature: _signature, ...payload } = value;
  return payload;
}

class FixtureSigner implements EvidenceSigner, EvidenceVerifier {
  private readonly privateKey;
  private readonly publicKey;
  readonly keyId = "engineering-fixture-ed25519";

  constructor() {
    const pair = generateKeyPairSync("ed25519");
    this.privateKey = pair.privateKey;
    this.publicKey = pair.publicKey;
  }

  async sign(payload: unknown): Promise<DetachedSignature> {
    return {
      algorithm: "ed25519",
      keyId: this.keyId,
      value: signBytes(
        null,
        Buffer.from(canonicalJson(payload)),
        this.privateKey
      ).toString("base64")
    };
  }

  verify(payload: unknown, signature: DetachedSignature): boolean {
    return (
      signature.algorithm === "ed25519" &&
      signature.keyId === this.keyId &&
      verifyBytes(
        null,
        Buffer.from(canonicalJson(payload)),
        this.publicKey,
        Buffer.from(signature.value, "base64")
      )
    );
  }
}

class InMemoryEvidenceStore implements EngineeringEvidenceStore {
  readonly values = new Map<string, EngineeringEffectEvidence>();
  conflictNext = false;

  async read(effectKey: `sha256:${string}`): Promise<EngineeringEffectEvidence | null> {
    return this.values.get(effectKey) ?? null;
  }

  async conditionalAppend(
    expected: EngineeringEffectEvidence | null,
    evidence: EngineeringEffectEvidence
  ): Promise<void> {
    if (this.conflictNext) {
      this.conflictNext = false;
      throw new EngineeringEvidenceConflictError();
    }
    const current = this.values.get(evidence.effectKey) ?? null;
    if (
      (current === null) !== (expected === null) ||
      (current !== null && expected !== null && digest(current) !== digest(expected))
    ) {
      throw new EngineeringEvidenceConflictError();
    }
    this.values.set(evidence.effectKey, evidence);
  }
}

class InMemoryClosureCheckpointStore
  implements EngineeringClosureCheckpointStore
{
  readonly values = new Map<string, EngineeringClosureCheckpoint>();
  readonly awaiting = new Map<string, EngineeringAwaitingHumanMergeCheckpoint>();
  readonly releases = new Map<string, EngineeringCostReleaseCheckpoint>();
  failAwaitingAcknowledgementOnce = false;

  async put(checkpoint: EngineeringClosureCheckpoint): Promise<void> {
    const key = digest(checkpoint);
    const current = this.values.get(key);
    if (current !== undefined && digest(current) !== digest(checkpoint)) {
      throw new Error("closure checkpoint conflict");
    }
    this.values.set(key, checkpoint);
  }

  async read(
    checkpointDigest: `sha256:${string}`
  ): Promise<EngineeringClosureCheckpoint | null> {
    return this.values.get(checkpointDigest) ?? null;
  }

  async putAwaitingHumanMerge(
    checkpoint: EngineeringAwaitingHumanMergeCheckpoint
  ): Promise<void> {
    this.awaiting.set(checkpoint.bindingDigest, checkpoint);
    if (this.failAwaitingAcknowledgementOnce) {
      this.failAwaitingAcknowledgementOnce = false;
      throw new Error("simulated lost awaiting-human-merge acknowledgement");
    }
  }

  async readAwaitingHumanMerge(
    bindingDigest: Digest
  ): Promise<EngineeringAwaitingHumanMergeCheckpoint | null> {
    return this.awaiting.get(bindingDigest) ?? null;
  }

  async putCostRelease(
    checkpoint: EngineeringCostReleaseCheckpoint
  ): Promise<void> {
    this.releases.set(checkpoint.bindingDigest, checkpoint);
  }

  async readCostRelease(
    bindingDigest: Digest
  ): Promise<EngineeringCostReleaseCheckpoint | null> {
    return this.releases.get(bindingDigest) ?? null;
  }
}

function cloneSnapshot(snapshot: EngineeringGitHubSnapshot): EngineeringGitHubSnapshot {
  return structuredClone(snapshot);
}

function recanonicalizeObservation(
  observation: EngineeringEffectObservation
): EngineeringEffectObservation {
  const {
    effectDigest: _effectDigest,
    snapshot: _snapshot,
    ...canonical
  } = observation;
  return { ...observation, effectDigest: digest(canonical) };
}

function substituteObservationTarget(
  observation: EngineeringEffectObservation
): EngineeringEffectObservation {
  const substituted = (() => {
    switch (observation.type) {
      case "create-branch":
        return { ...observation, repositoryId: observation.repositoryId + 1 };
      case "create-commit":
        return { ...observation, headRef: `${observation.headRef}-wrong` };
      case "create-draft-pull-request":
        return {
          ...observation,
          pullRequest: {
            ...observation.pullRequest,
            headRef: `${observation.pullRequest.headRef}-wrong`
          }
        };
      case "bind-pull-request":
        return { ...observation, receiptHead: digest({ wrong: "receipt" }) };
      case "comment-review":
        return {
          ...observation,
          pullRequestNumber: observation.pullRequestNumber + 1
        };
      case "project-converge":
        return {
          ...observation,
          projectItemNodeId: `${observation.projectItemNodeId}_wrong`
        };
      case "close-issue":
        return { ...observation, issueNumber: observation.issueNumber + 1 };
      case "record-delivery":
      case "operations-handoff":
        return {
          ...observation,
          bindingDigest: digest({ wrong: observation.type })
        };
    }
  })();
  return recanonicalizeObservation(substituted);
}

class FakeGitHub implements EngineeringGitHubApi {
  snapshot: EngineeringGitHubSnapshot;
  readonly effects: EngineeringDeliveryEffect[] = [];
  readonly observations = new Map<string, EngineeringEffectObservation>();
  failAfterClaim = false;
  failAfterApplyType: EngineeringDeliveryEffect["type"] | null = null;
  failReadOnce = false;
  observationMutator:
    | ((
        effect: EngineeringDeliveryEffect,
        observation: EngineeringEffectObservation
      ) => EngineeringEffectObservation)
    | null = null;
  mergeSha = COMMIT_SHA;

  constructor(
    binding: EngineeringWorkBinding,
    baseSha: string,
    private readonly repositoryPath = "."
  ) {
    this.snapshot = {
      canonicalBindingDigest: digest(binding),
      repositoryId: binding.repository.id,
      repositoryNodeId: binding.repository.nodeId,
      repositoryFullName: binding.repository.fullName,
      issueNumber: binding.issue.number,
      issueNodeId: binding.issue.nodeId,
      projectOwnerNodeId: binding.project.ownerNodeId,
      projectNodeId: binding.project.nodeId,
      projectItemNodeId: binding.project.itemNodeId,
      defaultBranch: { ref: "main", sha: baseSha },
      branches: {},
      pullRequest: null,
      projectStage: "human-review",
      issueClosed: false,
      reviewComments: {},
      deliveryRecords: {},
      operationsRecords: {}
    };
  }

  async readSnapshot(): Promise<EngineeringGitHubSnapshot> {
    if (this.failReadOnce) {
      this.failReadOnce = false;
      throw new Error("simulated pre-write read failure");
    }
    return cloneSnapshot(this.snapshot);
  }

  async applyEffect(
    effect: EngineeringDeliveryEffect,
    patchBundle: Parameters<EngineeringGitHubApi["applyEffect"]>[1]
  ): Promise<EngineeringEffectObservation> {
    if (this.failAfterClaim) throw new Error("simulated write uncertainty");
    this.effects.push(effect);
    let observation: EngineeringEffectObservation;
    switch (effect.type) {
      case "create-branch":
        this.snapshot = {
          ...this.snapshot,
          branches: { ...this.snapshot.branches, [effect.headRef]: effect.baseSha }
        };
        observation = this.observation({
          type: effect.type,
          nodeId: `E_${effect.ordinal}`,
          repositoryId: effect.repositoryId,
          baseSha: effect.baseSha,
          headRef: effect.headRef,
          headSha: effect.baseSha,
          snapshot: cloneSnapshot(this.snapshot)
        });
        break;
      case "create-commit": {
        if (
          patchBundle === null ||
          digest(patchBundle) !== effect.patchBundleDigest ||
          patchBundle.patchDigest !== effect.patchDigest ||
          patchBundle.treeDigest !== effect.treeDigest ||
          patchBundle.baseSha !== effect.parentSha
        ) {
          throw new Error("create-commit patch bundle mismatch");
        }
        const indexPath = path.join(
          this.repositoryPath,
          `.git/hermetic-index-${effect.ordinal}`
        );
        const gitEnvironment = {
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_NO_REPLACE_OBJECTS: "1",
          GIT_LITERAL_PATHSPECS: "1",
          GIT_INDEX_FILE: indexPath,
          GIT_AUTHOR_NAME: "Trusted Delivery",
          GIT_AUTHOR_EMAIL: "trusted-delivery@example.invalid",
          GIT_COMMITTER_NAME: "Trusted Delivery",
          GIT_COMMITTER_EMAIL: "trusted-delivery@example.invalid",
          GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
          GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z"
        };
        try {
          execFileSync("git", ["read-tree", effect.parentSha], {
            cwd: this.repositoryPath,
            env: gitEnvironment
          });
          execFileSync(
            "git",
            ["apply", "--cached", "--whitespace=nowarn", "-"],
            {
              cwd: this.repositoryPath,
              env: gitEnvironment,
              input: patchBundle.patch
            }
          );
          const gitTreeSha = execFileSync("git", ["write-tree"], {
            cwd: this.repositoryPath,
            env: gitEnvironment,
            encoding: "utf8"
          }).trim();
          if (gitTreeSha !== effect.gitTreeSha) {
            throw new Error("created Git tree differs from signed bundle");
          }
          const commitSha = execFileSync(
            "git",
            ["commit-tree", gitTreeSha, "-p", effect.parentSha],
            {
              cwd: this.repositoryPath,
              env: gitEnvironment,
              input: "Apply authenticated patch bundle\n",
              encoding: "utf8"
            }
          ).trim();
          const canonicalPatch = execFileSync(
            "git",
            [
              "diff",
              "--binary",
              "--no-ext-diff",
              "--no-textconv",
              "--no-renames",
              effect.parentSha,
              commitSha,
              "--",
              ...patchBundle.files.map((file) => file.path)
            ],
            {
              cwd: this.repositoryPath,
              env: gitEnvironment,
              encoding: "utf8"
            }
          );
          if (digest(canonicalPatch) !== patchBundle.patchDigest) {
            throw new Error("created commit patch differs from signed bundle");
          }
          const files = patchBundle.files.map((file) => {
            const treeEntry = execFileSync(
              "git",
              ["ls-tree", commitSha, "--", file.path],
              {
                cwd: this.repositoryPath,
                env: gitEnvironment,
                encoding: "utf8"
              }
            ).trim();
            const match = /^(100644) blob ([0-9a-f]{40})\t/u.exec(treeEntry);
            if (match?.[1] === undefined || match[2] === undefined) {
              throw new Error("created commit omitted an authenticated file");
            }
            const content = execFileSync(
              "git",
              ["show", `${commitSha}:${file.path}`],
              {
                cwd: this.repositoryPath,
                env: gitEnvironment
              }
            );
            return {
              path: file.path,
              blobSha: match[2],
              contentDigest: digest(content.toString("base64")),
              mode: "100644"
            } as const;
          });
          if (
            digest(
              files
                .map((file) => ({
                  path: file.path,
                  digest: file.contentDigest,
                  mode: file.mode
                }))
                .sort((left, right) => left.path.localeCompare(right.path))
            ) !== patchBundle.treeDigest
          ) {
            throw new Error("created commit tree differs from signed bundle");
          }
          this.snapshot = {
            ...this.snapshot,
            branches: {
              ...this.snapshot.branches,
              [effect.headRef]: commitSha
            }
          };
          observation = this.observation({
            type: effect.type,
            nodeId: `E_${effect.ordinal}`,
            repositoryId: effect.repositoryId,
            headRef: effect.headRef,
            parentSha: effect.parentSha,
            commitSha,
            gitTreeSha,
            patchDigest: patchBundle.patchDigest,
            treeDigest: patchBundle.treeDigest,
            files,
            snapshot: cloneSnapshot(this.snapshot)
          });
        } finally {
          rmSync(indexPath, { force: true });
        }
        break;
      }
      case "create-draft-pull-request":
        this.snapshot = {
          ...this.snapshot,
          pullRequest: {
            number: 5,
            nodeId: "PR_engineering",
            baseRepositoryId: effect.baseRepositoryId,
            baseRef: effect.baseRef,
            baseSha: effect.baseSha,
            headRepositoryId: effect.headRepositoryId,
            headRef: effect.headRef,
            headSha: effect.headSha,
            draft: true,
            open: true,
            merged: false,
            mergedSha: null,
            mergedByActorId: null,
            mergedByHuman: false,
            mergedAt: null
          }
        };
        observation = this.observation({
          type: effect.type,
          nodeId: `E_${effect.ordinal}`,
          pullRequest: {
            number: 5,
            nodeId: "PR_engineering",
            baseRepositoryId: effect.baseRepositoryId,
            baseRef: effect.baseRef,
            baseSha: effect.baseSha,
            headRepositoryId: effect.headRepositoryId,
            headRef: effect.headRef,
            headSha: effect.headSha,
            draft: true
          },
          snapshot: cloneSnapshot(this.snapshot)
        });
        break;
      case "comment-review":
        this.snapshot = {
          ...this.snapshot,
          reviewComments: {
            ...this.snapshot.reviewComments,
            [`E_${effect.ordinal}`]: {
              repositoryId: effect.repositoryId,
              pullRequestNumber: effect.pullRequestNumber,
              pullRequestNodeId: effect.pullRequestNodeId,
              headSha: effect.headSha,
              event: effect.event,
              bodyDigest: digest(effect.body)
            }
          }
        };
        observation = this.observation({
          type: effect.type,
          nodeId: `E_${effect.ordinal}`,
          repositoryId: effect.repositoryId,
          pullRequestNumber: effect.pullRequestNumber,
          pullRequestNodeId: effect.pullRequestNodeId,
          headSha: effect.headSha,
          event: effect.event,
          bodyDigest: digest(effect.body),
          snapshot: cloneSnapshot(this.snapshot)
        });
        break;
      case "project-converge":
        this.snapshot = { ...this.snapshot, projectStage: effect.stage };
        observation = this.observation({
          type: effect.type,
          nodeId: `E_${effect.ordinal}`,
          projectNodeId: effect.projectNodeId,
          projectItemNodeId: effect.projectItemNodeId,
          stage: effect.stage,
          mergedSha: effect.mergedSha,
          snapshot: cloneSnapshot(this.snapshot)
        });
        break;
      case "close-issue":
        this.snapshot = { ...this.snapshot, issueClosed: true };
        observation = this.observation({
          type: effect.type,
          nodeId: `E_${effect.ordinal}`,
          repositoryId: effect.repositoryId,
          issueNumber: effect.issueNumber,
          issueNodeId: effect.issueNodeId,
          closed: true,
          mergedSha: effect.mergedSha,
          snapshot: cloneSnapshot(this.snapshot)
        });
        break;
      case "bind-pull-request":
        observation = this.observation({
          type: effect.type,
          nodeId: `E_${effect.ordinal}`,
          expectedBindingDigest: effect.expectedBindingDigest,
          pullRequest: effect.pullRequest,
          receiptHead: effect.receiptHead,
          snapshot: cloneSnapshot(this.snapshot)
        });
        break;
      case "record-delivery":
        this.snapshot = {
          ...this.snapshot,
          deliveryRecords: {
            ...this.snapshot.deliveryRecords,
            [`DELIVERY_${effect.ordinal}`]: {
              bindingDigest: effect.bindingDigest,
              mergedSha: effect.mergedSha,
              verificationDigest: effect.verificationDigest
            }
          }
        };
        observation = this.observation({
          type: effect.type,
          nodeId: `E_${effect.ordinal}`,
          recordNodeId: `DELIVERY_${effect.ordinal}`,
          bindingDigest: effect.bindingDigest,
          mergedSha: effect.mergedSha,
          verificationDigest: effect.verificationDigest,
          snapshot: cloneSnapshot(this.snapshot)
        });
        break;
      case "operations-handoff":
        this.snapshot = {
          ...this.snapshot,
          operationsRecords: {
            ...this.snapshot.operationsRecords,
            [`OPERATIONS_${effect.ordinal}`]: {
              bindingDigest: effect.bindingDigest,
              mergedSha: effect.mergedSha,
              measurementPlanDigest: effect.measurementPlanDigest
            }
          }
        };
        observation = this.observation({
          type: effect.type,
          nodeId: `E_${effect.ordinal}`,
          recordNodeId: `OPERATIONS_${effect.ordinal}`,
          bindingDigest: effect.bindingDigest,
          mergedSha: effect.mergedSha,
          measurementPlanDigest: effect.measurementPlanDigest,
          snapshot: cloneSnapshot(this.snapshot)
        });
        break;
    }
    observation = this.observationMutator?.(effect, observation) ?? observation;
    this.observations.set(digest(effect), observation);
    if (this.failAfterApplyType === effect.type) {
      this.failAfterApplyType = null;
      throw new Error(`simulated lost acknowledgement for ${effect.type}`);
    }
    return observation;
  }

  private observation(
    value: ObservationWithoutDigest
  ): EngineeringEffectObservation {
    const { snapshot: _snapshot, ...canonical } = value;
    return {
      ...value,
      effectApplied: true,
      effectDigest: digest({ ...canonical, effectApplied: true })
    } as EngineeringEffectObservation;
  }

  async observeEffect(
    effect: EngineeringDeliveryEffect
  ): Promise<EngineeringEffectObservation | null> {
    return this.observations.get(digest(effect)) ?? null;
  }

  observeIndependentHumanMerge(
    actorId = "human-merger",
    mergedAt = NOW
  ): void {
    if (this.snapshot.pullRequest === null) {
      throw new Error("pull request is absent");
    }
    this.snapshot = {
      ...this.snapshot,
      pullRequest: {
        ...this.snapshot.pullRequest,
        draft: false,
        open: false,
        merged: true,
        mergedSha: this.mergeSha,
        mergedByActorId: actorId,
        mergedByHuman: true,
        mergedAt
      }
    };
  }
}

class FakeBroker implements OperationScopedGitHubBroker {
  calls = 0;

  constructor(readonly api: FakeGitHub) {}

  async withApiForEffect<T>(
    _effectType: EngineeringDeliveryEffect["type"],
    operation: (api: EngineeringGitHubApi) => Promise<T>
  ): Promise<T> {
    this.calls += 1;
    return operation(this.api);
  }
}

class FakeCosts implements EngineeringCostLedger, EngineeringProviderUsageLedger {
  private head: `sha256:${string}` | null = null;
  private version = 0;
  private cumulative = 0;
  private cumulativeCalls = 0;
  private cumulativeTokens = 0;
  private cumulativeReleased = 0;
  private reservation: EngineeringCostReservation | null = null;
  private readonly settlements = new Map<
    EngineeringCostSettlement["phase"],
    EngineeringCostSettlement
  >();
  private releaseReceipt: EngineeringCostRelease | null = null;
  private releaseIdempotencyKey: Digest | null = null;
  private readonly attempts = new Map<
    EngineeringCostSettlement["phase"],
    EngineeringProviderAttempt
  >();
  unknownUsagePhase: EngineeringCostSettlement["phase"] | null = null;
  releaseCalls = 0;
  releaseApplications = 0;
  totalReleasedCostUnits = 0;
  failRelease = false;
  failReleaseAcknowledgementOnce = false;
  failSettlementAcknowledgementOnce = false;
  failHoldOnce = false;
  holdCalls = 0;
  /** Simulates a caller whose in-memory registration was lost before release. */
  dropCallerOpenHoldsOnRelease = false;

  get lastRelease(): EngineeringCostRelease | null {
    return this.releaseReceipt;
  }

  constructor(private readonly signer: FixtureSigner) {}

  get settlementCount(): number {
    return this.settlements.size;
  }

  /** Holds and settlements in chain order, which is the real signed lineage. */
  private readonly lineage: (EngineeringCostHold | EngineeringCostSettlement)[] =
    [];
  private readonly holds = new Map<
    EngineeringCostSettlement["phase"],
    EngineeringCostHold
  >();

  private tip(reservation: EngineeringCostReservation): {
    readonly head: `sha256:${string}`;
    readonly version: number;
  } {
    const last = this.lineage.at(-1);
    return last === undefined
      ? { head: reservation.ledgerHeadAfter, version: reservation.ledgerVersion }
      : { head: last.ledgerHeadAfter, version: last.ledgerVersion };
  }

  get openHoldCount(): number {
    return this.holds.size - this.settlements.size;
  }

  holdFor(phase: EngineeringCostSettlement["phase"]): EngineeringCostHold {
    const hold = this.holds.get(phase);
    if (hold === undefined) throw new Error(`no ${phase} hold recorded`);
    return hold;
  }

  get allHolds(): readonly EngineeringCostHold[] {
    return [...this.holds.values()];
  }

  get lineageEntries(): readonly EngineeringCostLineageEntry[] {
    return this.lineage.map((document) =>
      "heldCostUnits" in document
        ? ({ kind: "hold", hold: document } as const)
        : ({ kind: "settlement", settlement: document } as const)
    );
  }

  /** Lineage links written before the given phase's settlement. */
  priorEntriesFor(
    phase: EngineeringCostSettlement["phase"]
  ): readonly EngineeringCostLineageEntry[] {
    const entries = this.lineageEntries;
    const index = entries.findIndex(
      (entry) => entry.kind === "settlement" && entry.settlement.phase === phase
    );
    return index === -1 ? entries : entries.slice(0, index);
  }

  async hold(input: {
    readonly reservation: EngineeringCostReservation;
    readonly phase: EngineeringProviderAttempt["phase"];
    readonly sequence: number;
    readonly now: string;
  }): Promise<EngineeringCostHold> {
    if (this.failHoldOnce) {
      this.failHoldOnce = false;
      throw new Error("simulated hold failure");
    }
    const existing = this.holds.get(input.phase);
    if (existing !== undefined) return existing;
    this.holdCalls += 1;
    const prior = [...this.settlements.values()].at(-1);
    const heldCostUnits = input.reservation.phaseBudgets[input.phase];
    const heldTokenUnits = input.reservation.phaseTokenBudgets[input.phase];
    const projected = {
      projectedCumulativeCalls: (prior?.cumulativeCalls ?? 0) + 1,
      projectedCumulativeTokens: (prior?.cumulativeTokens ?? 0) + heldTokenUnits,
      projectedCumulativeCostUnits:
        (prior?.cumulativeCostUnits ?? 0) + heldCostUnits
    } as const;
    const { head: ledgerHeadBefore, version: priorVersion } = this.tip(
      input.reservation
    );
    const ledgerVersion = priorVersion + 1;
    const reservationDigest = digest(input.reservation);
    const reconciliationExpiresAt = new Date(
      Date.parse(input.reservation.expiresAt) + 86_400_000
    ).toISOString();
    const holdId = `hold-${input.reservation.reservationId}-${input.phase}`;
    const payload = {
      holdId,
      reservationDigest,
      activationLeaseDigest: input.reservation.activationLeaseDigest,
      phase: input.phase,
      sequence: input.sequence,
      heldCostUnits,
      heldTokenUnits,
      ...projected,
      ledgerVersion,
      ledgerHeadBefore,
      ledgerHeadAfter: digest({
        ledgerHeadBefore,
        ledgerVersion,
        holdId,
        reservationDigest,
        phase: input.phase,
        sequence: input.sequence,
        heldCostUnits,
        heldTokenUnits,
        ...projected,
        reconciliationExpiresAt
      }),
      heldAt: input.now,
      expiresAt: input.reservation.expiresAt,
      reconciliationExpiresAt
    } as const;
    const hold: EngineeringCostHold = {
      ...payload,
      signature: await this.signer.sign(payload)
    };
    this.holds.set(input.phase, hold);
    this.lineage.push(hold);
    this.version = ledgerVersion;
    this.head = hold.ledgerHeadAfter;
    return hold;
  }

  async begin(input: {
    readonly reservation: EngineeringCostReservation;
    readonly hold: EngineeringCostHold;
    readonly phase: EngineeringProviderAttempt["phase"];
    readonly sequence: number;
    readonly priorSettlements: readonly EngineeringCostSettlement[];
    readonly now: string;
    readonly reconciliationExpiresAt: string;
  }): Promise<EngineeringProviderAttempt> {
    const existing = this.attempts.get(input.phase);
    if (existing !== undefined) return existing;
    const payload = {
      attemptId: `attempt-${input.reservation.reservationId}-${input.phase}`,
      reservationDigest: digest(input.reservation),
      activationLeaseDigest: input.reservation.activationLeaseDigest,
      holdDigest: digest(input.hold),
      phase: input.phase,
      phaseBudget: input.reservation.phaseBudgets[input.phase],
      tokenBudget: input.reservation.phaseTokenBudgets[input.phase],
      sequence: input.sequence,
      projectedCumulativeCalls:
        (input.priorSettlements.at(-1)?.cumulativeCalls ?? 0) + 1,
      projectedCumulativeTokens:
        (input.priorSettlements.at(-1)?.cumulativeTokens ?? 0) +
        input.reservation.phaseTokenBudgets[input.phase],
      projectedCumulativeCostUnits:
        (input.priorSettlements.at(-1)?.cumulativeCostUnits ?? 0) +
        input.reservation.phaseBudgets[input.phase],
      startedAt: input.now,
      expiresAt: input.reservation.expiresAt,
      reconciliationExpiresAt: input.reconciliationExpiresAt
    } as const;
    const attempt = { ...payload, signature: await this.signer.sign(payload) };
    this.attempts.set(input.phase, attempt);
    return attempt;
  }

  async reconcile(input: {
    readonly reservation: EngineeringCostReservation;
    readonly attempt: EngineeringProviderAttempt;
    readonly now: string;
  }): Promise<EngineeringProviderUsage> {
    const unknown = this.unknownUsagePhase === input.attempt.phase;
    const payload = {
      attemptDigest: digest(input.attempt),
      phase: input.attempt.phase,
      status: unknown ? "unknown" : "settled",
      actualCostUnits: unknown ? null : 1,
      actualCalls: unknown ? null : 1,
      actualTokens: unknown ? null : 1,
      providerUsageDigest: unknown
        ? null
        : digest({
            provider: "fake-model",
            attemptId: input.attempt.attemptId,
            costUnits: 1
          }),
      observedAt: input.now
    } as const;
    return { ...payload, signature: await this.signer.sign(payload) };
  }

  async reserve(input: {
    readonly workAccordDigest: `sha256:${string}`;
    readonly activationLeaseDigest: `sha256:${string}`;
    readonly phaseBudgets: EngineeringCostReservation["phaseBudgets"];
    readonly phaseTokenBudgets?: EngineeringCostReservation["phaseTokenBudgets"];
    readonly maxCalls?: number;
    readonly maxTokens?: number;
    readonly now: string;
    readonly expiresAt: string;
  }): Promise<EngineeringCostReservation> {
    if (this.reservation !== null) return this.reservation;
    const totalReserved = Object.values(input.phaseBudgets).reduce(
      (sum, value) => sum + value,
      0
    );
    const payload = {
      reservationId: "reservation-engineering-1",
      workAccordDigest: input.workAccordDigest,
      activationLeaseDigest: input.activationLeaseDigest,
      phaseBudgets: input.phaseBudgets,
      phaseTokenBudgets: input.phaseTokenBudgets ?? {
        framing: 100,
        execution: 100,
        verification: 100
      },
      maxCalls: input.maxCalls ?? 3,
      maxTokens: input.maxTokens ?? 1000,
      totalReserved,
      remainingBefore: 100,
      remainingAfter: 100 - totalReserved,
      ledgerVersion: ++this.version,
      ledgerHeadBefore: this.head,
      ledgerHeadAfter: digest({
        ledgerHeadBefore: this.head,
        ledgerVersion: this.version,
        reservationId: "reservation-engineering-1",
        workAccordDigest: input.workAccordDigest,
        activationLeaseDigest: input.activationLeaseDigest,
        phaseBudgets: input.phaseBudgets,
        phaseTokenBudgets: input.phaseTokenBudgets ?? {
          framing: 100,
          execution: 100,
          verification: 100
        },
        maxCalls: input.maxCalls ?? 3,
        maxTokens: input.maxTokens ?? 1000,
        totalReserved,
        remainingBefore: 100,
        remainingAfter: 100 - totalReserved
      }),
      checkedAt: input.now,
      reservedAt: input.now,
      expiresAt: input.expiresAt
    } as const;
    this.head = payload.ledgerHeadAfter;
    this.reservation = {
      ...payload,
      signature: await this.signer.sign(payload)
    };
    return this.reservation;
  }

  async settle(input: {
    readonly reservation: EngineeringCostReservation;
    readonly hold?: EngineeringCostHold;
    readonly attempt?: EngineeringProviderAttempt;
    readonly usage?: EngineeringProviderUsage;
    readonly phase: EngineeringCostSettlement["phase"];
    readonly actualCostUnits: number;
    readonly actualCalls?: number;
    readonly actualTokens?: number;
    readonly providerUsageDigest: `sha256:${string}`;
    readonly now: string;
  }): Promise<EngineeringCostSettlement> {
    const hold =
      input.hold ??
      (await this.hold({
        reservation: input.reservation,
        phase: input.phase,
        sequence: this.holds.size + 1,
        now: input.now
      }));
    const attempt =
      input.attempt ??
      (await this.begin({
        reservation: input.reservation,
        hold,
        phase: input.phase,
        sequence: this.settlements.size + 1,
        priorSettlements: [...this.settlements.values()],
        now: input.now,
        reconciliationExpiresAt: new Date(
          Date.parse(input.reservation.expiresAt) + 86_400_000
        ).toISOString()
      }));
    const actualCalls = input.actualCalls ?? 1;
    const actualTokens = input.actualTokens ?? 1;
    const existing = this.settlements.get(input.phase);
    if (existing !== undefined) {
      if (
        existing.actualCostUnits !== input.actualCostUnits ||
        existing.providerUsageDigest !== input.providerUsageDigest
      ) {
        throw new Error(`duplicate settlement conflict for ${input.phase}`);
      }
      return existing;
    }
    const budget = input.reservation.phaseBudgets[input.phase];
    this.cumulative += input.actualCostUnits;
    this.cumulativeCalls += actualCalls;
    this.cumulativeTokens += actualTokens;
    const releasedCostUnits = budget - input.actualCostUnits;
    this.cumulativeReleased += releasedCostUnits;
    const ledgerVersion = hold.ledgerVersion + 1;
    const ledgerHeadBefore = hold.ledgerHeadAfter;
    const payload = {
      reservationDigest: digest(input.reservation),
      attemptDigest: digest(attempt),
      holdDigest: digest(hold),
      phase: input.phase,
      actualCostUnits: input.actualCostUnits,
      actualCalls,
      actualTokens,
      releasedCostUnits,
      cumulativeCostUnits: this.cumulative,
      cumulativeCalls: this.cumulativeCalls,
      cumulativeTokens: this.cumulativeTokens,
      cumulativeReleasedCostUnits: this.cumulativeReleased,
      providerUsageDigest: input.providerUsageDigest,
      ledgerVersion,
      ledgerHeadBefore,
      ledgerHeadAfter: digest({
        ledgerHeadBefore,
        ledgerVersion,
        attemptDigest: digest(attempt),
        holdDigest: digest(hold),
        phase: input.phase,
        actualCostUnits: input.actualCostUnits,
        actualCalls,
        actualTokens,
        releasedCostUnits,
        cumulativeCostUnits: this.cumulative,
        cumulativeCalls: this.cumulativeCalls,
        cumulativeTokens: this.cumulativeTokens,
        cumulativeReleasedCostUnits: this.cumulativeReleased,
        providerUsageDigest: input.providerUsageDigest,
        reconciliationExpiresAt: attempt.reconciliationExpiresAt
      }),
      settledAt: input.now,
      reconciliationExpiresAt: attempt.reconciliationExpiresAt
    } as const;
    this.head = payload.ledgerHeadAfter;
    this.version = ledgerVersion;
    const settlement = {
      ...payload,
      signature: await this.signer.sign(payload)
    };
    this.settlements.set(input.phase, settlement);
    this.lineage.push(settlement);
    this.totalReleasedCostUnits += releasedCostUnits;
    if (this.failSettlementAcknowledgementOnce) {
      this.failSettlementAcknowledgementOnce = false;
      throw new Error("simulated lost settlement acknowledgement");
    }
    return settlement;
  }

  async release(input: {
    readonly releaseIdempotencyKey: Digest;
    readonly reservation: EngineeringCostReservation;
    readonly settledPhases: readonly EngineeringCostSettlement[];
    readonly expectedOpenHoldDigests?: readonly Digest[];
    readonly now: string;
  }): Promise<EngineeringCostRelease> {
    this.releaseCalls += 1;
    if (this.failRelease) throw new Error("simulated release failure");
    const last = input.settledPhases.at(-1);
    const settlementDigests = input.settledPhases.map((settlement) =>
      digest(settlement)
    );
    // Derived from this ledger's own holds, exactly as the durable adapter
    // does: a caller that omitted an open hold cannot cause its budget to be
    // released, because the caller's list is never the source.
    const settledHoldDigests = new Set(
      [...this.settlements.values()].map((settlement) => settlement.holdDigest)
    );
    const unresolvedHolds = [...this.holds.values()].filter(
      (hold) => !settledHoldDigests.has(digest(hold))
    );
    const expectedOpenHoldDigests = this.dropCallerOpenHoldsOnRelease
      ? []
      : (input.expectedOpenHoldDigests ?? []);
    for (const expectedOpen of expectedOpenHoldDigests) {
      if (!unresolvedHolds.some((hold) => digest(hold) === expectedOpen)) {
        throw new Error(`hold ${expectedOpen} is not an open hold`);
      }
    }
    if (this.releaseReceipt !== null) {
      if (
        this.releaseIdempotencyKey !== input.releaseIdempotencyKey ||
        digest(this.releaseReceipt.settlementDigests) !== digest(settlementDigests)
      ) {
        throw new Error("duplicate release conflict");
      }
      return this.releaseReceipt;
    }
    const previouslyReleasedCostUnits = last?.cumulativeReleasedCostUnits ?? 0;
    const heldCostUnits = unresolvedHolds.reduce(
      (sum, hold) => sum + input.reservation.phaseBudgets[hold.phase],
      0
    );
    const releasedCostUnits =
      input.reservation.totalReserved -
      (last?.cumulativeCostUnits ?? 0) -
      previouslyReleasedCostUnits -
      heldCostUnits;
    const cumulativeReleasedCostUnits =
      previouslyReleasedCostUnits + releasedCostUnits;
    const unresolvedHoldDigests = unresolvedHolds.map((hold) => digest(hold));
    const reconciliationRequired = unresolvedHolds.length > 0;
    const { head: ledgerHeadBefore, version: priorVersion } = this.tip(
      input.reservation
    );
    const ledgerVersion = priorVersion + 1;
    const payload = {
      reservationDigest: digest(input.reservation),
      settlementDigests,
      unresolvedHolds,
      reconciliationRequired,
      previouslyReleasedCostUnits,
      heldCostUnits,
      releasedCostUnits,
      cumulativeCostUnits: last?.cumulativeCostUnits ?? 0,
      cumulativeCalls: last?.cumulativeCalls ?? 0,
      cumulativeTokens: last?.cumulativeTokens ?? 0,
      cumulativeReleasedCostUnits,
      ledgerVersion,
      ledgerHeadBefore,
      ledgerHeadAfter: digest({
        ledgerHeadBefore,
        ledgerVersion,
        reservationDigest: digest(input.reservation),
        settlementDigests,
        unresolvedHoldDigests,
        reconciliationRequired,
        previouslyReleasedCostUnits,
        heldCostUnits,
        releasedCostUnits,
        cumulativeCostUnits: last?.cumulativeCostUnits ?? 0,
        cumulativeCalls: last?.cumulativeCalls ?? 0,
        cumulativeTokens: last?.cumulativeTokens ?? 0,
        cumulativeReleasedCostUnits
      }),
      releasedAt: input.now
    } as const;
    this.head = payload.ledgerHeadAfter;
    this.version = ledgerVersion;
    this.releaseReceipt = {
      ...payload,
      signature: await this.signer.sign(payload)
    };
    this.releaseIdempotencyKey = input.releaseIdempotencyKey;
    this.releaseApplications += 1;
    this.totalReleasedCostUnits += releasedCostUnits;
    if (this.failReleaseAcknowledgementOnce) {
      this.failReleaseAcknowledgementOnce = false;
      throw new Error("simulated lost release acknowledgement");
    }
    return this.releaseReceipt;
  }
}

class FakeKernel implements EngineeringKernelPort {
  private index = 0;
  readonly observedRoutes: string[] = [];
  readonly results = new Map<
    Digest,
    ReturnType<EngineeringKernelPort["transition"]>
  >();
  failAfterRoute: string | null = null;
  readonly routes = [
    "activation.begin-framing",
    "framing.accept",
    "planning.execute",
    "execution.verify",
    "verification.request-review",
    "review.accept"
  ] as const;

  transition(input: Parameters<EngineeringKernelPort["transition"]>[0]) {
    const replay = this.results.get(input.transitionKey);
    if (replay !== undefined) return replay;
    const routeId = this.routes[this.index];
    if (routeId === undefined || input.expectedRouteId !== routeId) {
      throw new Error(`unexpected kernel route ${input.expectedRouteId}`);
    }
    this.index += 1;
    this.observedRoutes.push(routeId);
    const result = {
      routeId,
      snapshotDigest: digest({ routeId, index: this.index }),
      receiptDigest: digest({ routeId, evidence: input.evidenceDigest })
    };
    this.results.set(input.transitionKey, result);
    if (this.failAfterRoute === routeId) {
      this.failAfterRoute = null;
      throw new Error("simulated kernel acknowledgement loss");
    }
    return result;
  }
}

class FakePlanner implements EngineeringPlanner {
  calls = 0;

  constructor(
    private readonly selectTargets: (
      available: readonly string[]
    ) => readonly string[] = (available) => [available[0] ?? "missing"],
    private readonly selectVerifications: (
      available: readonly string[]
    ) => readonly string[] = (available) => [available[0] ?? "missing"]
  ) {}

  plan(input: Parameters<EngineeringPlanner["plan"]>[0]) {
    this.calls += 1;
    return {
      schemaVersion: "1.0.0" as const,
      steps: ["Write the approved logical slot."],
      targetSlots: this.selectTargets(input.availableTargetSlots),
      verificationIds: this.selectVerifications(input.availableVerificationIds)
    };
  }
}

class FakeModel implements EngineeringModel {
  readonly receivedCredentials: readonly string[] = [];
  frameCalls = 0;
  implementationCalls = 0;
  reviewCalls = 0;
  reportedCostUnits = 1;
  reportedTokenUnits = 1;

  constructor(
    private readonly implementationSlot = "delivery-marker",
    private readonly reviewStatus: "success" | "blocked" | "failed" = "success"
  ) {}

  async frame(): ReturnType<EngineeringModel["frame"]> {
    this.frameCalls += 1;
    return {
      artifact: {
        schemaVersion: "1.0.0",
        objective: "Create one bounded demonstration artifact.",
        inScope: ["safe-output"],
        outOfScope: ["GitHub targets", "credentials"],
        assumptions: ["Trusted code resolves the logical slot."],
        dependencies: []
      },
      costUnits: this.reportedCostUnits,
      tokenUnits: this.reportedTokenUnits
    };
  }

  async implement(): ReturnType<EngineeringModel["implement"]> {
    this.implementationCalls += 1;
    return {
      patch: {
        schemaVersion: "1.0.0",
        summary: "Create the delivery marker.",
        changes: [{ slot: this.implementationSlot, content: "delivered hermetically\n" }]
      },
      costUnits: this.reportedCostUnits,
      tokenUnits: this.reportedTokenUnits
    };
  }

  async review(): ReturnType<EngineeringModel["review"]> {
    this.reviewCalls += 1;
    return {
      output: {
        apiVersion: "agentic-framework.github.com/v1alpha1",
        kind: "GitHubSafeOutput",
        schemaVersion: "1.0.0",
        summary: "Independent review completed on the exact head.",
        findings: [],
        openQuestions: [],
        result: {
          status: this.reviewStatus,
          details: "Independent review result."
        }
      },
      costUnits: this.reportedCostUnits,
      tokenUnits: this.reportedTokenUnits
    };
  }
}

class InvalidFrameModel extends FakeModel {
  override async frame(): ReturnType<EngineeringModel["frame"]> {
    this.frameCalls += 1;
    return {
      artifact: {
        schemaVersion: "1.0.0",
        objective: "",
        inScope: ["safe-output"],
        outOfScope: [],
        assumptions: [],
        dependencies: []
      },
      costUnits: 1,
      tokenUnits: 1
    };
  }
}

class FakeHumanGates implements HumanGateProvider {
  afterRead: ((gate: SignedArtifactApproval["gate"]) => void) | null = null;

  constructor(
    readonly approvals: Map<
      SignedArtifactApproval["gate"],
      SignedArtifactApproval
    >
  ) {}

  async read(
    gate: SignedArtifactApproval["gate"]
  ): Promise<SignedArtifactApproval | null> {
    const approval = this.approvals.get(gate) ?? null;
    this.afterRead?.(gate);
    return approval;
  }
}

class FakeActivationLeases implements EngineeringActivationLeaseProvider {
    calls = 0;
    revokeAfterReads: number | null = null;
    afterRead: (() => void) | null = null;

    constructor(
      private readonly signer: FixtureSigner,
      private readonly lease: ActivationLease
    ) {}

    async read(input: {
      readonly phase: EngineeringProviderAttempt["phase"];
      readonly binding: EngineeringWorkBinding;
      readonly reservation: EngineeringCostReservation;
      readonly now: string;
    }): Promise<EngineeringActivationLeaseEvidence> {
      this.calls += 1;
      const lease =
        this.revokeAfterReads !== null && this.calls > this.revokeAfterReads
          ? { ...this.lease, revoked: true }
          : this.lease;
      const payload = {
        lease,
        bindingDigest: digest(input.binding),
        reservationDigest: digest(input.reservation),
        observedAt: input.now
      } as const;
      const evidence = {
        ...payload,
        signature: await this.signer.sign(payload)
      };
      this.afterRead?.();
      return evidence;
  }
}

async function authenticatedApproval(input: {
  readonly signer: FixtureSigner;
  readonly binding: EngineeringWorkBinding;
  readonly requesterId: string;
  readonly automationActorId: string;
  readonly actorId: string;
  readonly actorType?: SignedHumanAuthorization["actorType"];
  readonly permission: SignedHumanAuthorization["repositoryPermission"];
  readonly gate: SignedArtifactApproval["gate"];
  readonly artifactDigest: `sha256:${string}`;
  readonly routeId: string;
  readonly snapshotDigest: `sha256:${string}`;
  readonly workAccordDigest: `sha256:${string}`;
  readonly activationLeaseDigest: `sha256:${string}`;
  readonly currentHead: string | null;
  readonly accord?: WorkAccord;
  readonly roleIds?: readonly string[];
  readonly teamNodeIds?: readonly string[];
  readonly observedAt?: string;
}): Promise<SignedArtifactApproval> {
  const accord = input.accord ?? workAccord();
  const policy = controlPolicy();
  const actorClass = input.gate === "activate" ? "maintainer" : "reviewer";
  const roleIds =
    input.roleIds ??
    (actorClass === "maintainer"
      ? ["repository-maintainer"]
      : ["eligible-reviewer"]);
  const authorizationPayload = {
    repositoryId: input.binding.repository.id,
    actorId: input.actorId,
    actorType: input.actorType ?? "User",
    actorClass,
    repositoryPermission: input.permission,
    roleIds,
    teamNodeIds: input.teamNodeIds ?? ["TEAM_engineering"],
    controlPolicyDigest: digest(policy),
    currentHead: input.currentHead,
    checkedAt: input.observedAt ?? NOW,
    expiresAt: EXPIRES
  } as const;
  const authorization: SignedHumanAuthorization = {
    ...authorizationPayload,
    signature: await input.signer.sign(authorizationPayload)
  };
  const eventPayload = {
    eventId: `event-${input.gate}-${input.actorId}`,
    action: "approved",
    repositoryId: input.binding.repository.id,
    workItemNodeId: input.binding.issue.nodeId,
    actorId: input.actorId,
    actorType: input.actorType ?? "User",
    requesterActorId: input.requesterId,
    automationActorId: input.automationActorId,
    gate: input.gate,
    artifactDigest: input.artifactDigest,
    routeId: input.routeId,
    snapshotDigest: input.snapshotDigest,
    workAccordDigest: input.workAccordDigest,
    activationLeaseDigest: input.activationLeaseDigest,
    currentHead: input.currentHead,
    observedAt: input.observedAt ?? NOW,
    expiresAt: EXPIRES
  } as const;
  const event: SignedHumanApprovalEvent = {
    ...eventPayload,
    signature: await input.signer.sign(eventPayload)
  };
  return issueAuthenticatedArtifactApproval({
    event,
    authorization,
    signer: input.signer,
    verifier: input.signer,
    requesterId: input.requesterId,
    automationActorId: input.automationActorId,
    controlPolicy: policy,
    approverPolicy: accord.evidence.approverPolicy,
    now: input.observedAt ?? NOW,
    maximumAgeMs: 300_000
  });
}

async function gateProvider(input: {
  readonly signer: FixtureSigner;
  readonly accord: WorkAccord;
  readonly binding: EngineeringWorkBinding;
  readonly grant: BoundedExecutionGrant;
  readonly requesterId?: string;
  readonly automationActorId?: string;
}): Promise<FakeHumanGates> {
  const requesterId = input.requesterId ?? "requester";
  const automationActorId = input.automationActorId ?? "automation-app";
  const workAccordDigest = digest(input.accord);
  const activationLeaseDigest = input.grant.activationLeaseDigest;
  const framing = (await new FakeModel().frame()).artifact;
  const planning = new FakePlanner().plan({
    framingDigest: digest(framing),
    availableTargetSlots: input.grant.targets.map((target) => target.slot),
    availableVerificationIds: input.grant.verificationCommandIds
  });
  const approvals = await Promise.all([
    authenticatedApproval({
      signer: input.signer,
      binding: input.binding,
      requesterId,
      automationActorId,
      actorId: "maintainer-1",
      permission: "maintain",
      gate: "activate",
      artifactDigest: digest(input.binding),
      routeId: "activation.begin-framing",
      snapshotDigest: digest(input.binding),
      workAccordDigest,
      activationLeaseDigest,
      currentHead: null
      ,
      accord: input.accord
    }),
    authenticatedApproval({
      signer: input.signer,
      binding: input.binding,
      requesterId,
      automationActorId,
      actorId: "reviewer-1",
      permission: "write",
      gate: "accept-frame",
      artifactDigest: digest(framing),
      routeId: "framing.accept",
      snapshotDigest: digest({
        routeId: "activation.begin-framing",
        index: 1
      }),
      workAccordDigest,
      activationLeaseDigest,
      currentHead: null
      ,
      accord: input.accord
    }),
    authenticatedApproval({
      signer: input.signer,
      binding: input.binding,
      requesterId,
      automationActorId,
      actorId: "reviewer-1",
      permission: "write",
      gate: "accept-plan",
      artifactDigest: digest(planning),
      routeId: "planning.execute",
      snapshotDigest: digest({ routeId: "framing.accept", index: 2 }),
      workAccordDigest,
      activationLeaseDigest,
      currentHead: null
      ,
      accord: input.accord
    })
  ]);
  return new FakeHumanGates(
    new Map(approvals.map((approval) => [approval.gate, approval]))
  );
}

function authorizationProvider(signer: FixtureSigner) {
  return {
    async issue(input: {
      readonly workflowId: string;
      readonly contractRevision: number;
      readonly effect: EngineeringDeliveryEffect;
      readonly binding: EngineeringWorkBinding;
      readonly workAccordDigest: `sha256:${string}`;
      readonly activationLeaseDigest: `sha256:${string}`;
      readonly executionGrantDigest?: `sha256:${string}`;
      readonly kernelReceiptDigest: `sha256:${string}`;
      readonly now: string;
    }): Promise<EngineeringDeliveryAuthorization> {
      const payload = {
        workflowId: input.workflowId,
        contractRevision: input.contractRevision,
        workAccordDigest: input.workAccordDigest,
        activationLeaseDigest: input.activationLeaseDigest,
        executionGrantDigest:
          input.executionGrantDigest ?? EXECUTION_GRANT_DIGEST,
        bindingDigest: digest(input.binding),
        effectType: input.effect.type,
        effectOrdinal: input.effect.ordinal,
        planDigest: digest(input.effect),
        currentHead: input.binding.pullRequest?.headSha ?? null,
        kernelReceiptDigest: input.kernelReceiptDigest,
        issuedAt: input.now,
        expiresAt: EXPIRES
      } as const;
      const authorizationDigest = digest(payload);
      return {
        ...payload,
        authorizationDigest,
        signature: await signer.sign(payload)
      };
    }
  };
}

function scanner(
  signer: FixtureSigner,
  status: "success" | "warning" = "success"
): ThreatScanner {
  return {
    async scan(input) {
      const payload = {
        status,
        authorizationDigest: input.authorizationDigest,
        modelOutputDigest: input.modelOutputDigest,
        kernelReceiptDigest: input.kernelReceiptDigest,
        checkedAt: input.now,
        expiresAt: EXPIRES
      } as const;
      return { ...payload, signature: await signer.sign(payload) };
    }
  };
}

async function authorityBoundRequest(
  signer: FixtureSigner,
  effect: EngineeringDeliveryEffect,
  binding: EngineeringWorkBinding,
  freshness: TrustedExecutionTestFreshness,
  status: "success" | "warning" = "success"
): Promise<
  Omit<EngineeringEffectExecutionInput, keyof TrustedExecutionTestIdentity>
> {
  const authorization = await authorizationProvider(signer).issue({
    workflowId: freshness.identity.workflowId,
    contractRevision: freshness.identity.contractRevision,
    effect,
    binding,
    workAccordDigest: freshness.identity.workAccordDigest,
    activationLeaseDigest: freshness.identity.activationLeaseDigest,
    executionGrantDigest: freshness.identity.executionGrantDigest,
    kernelReceiptDigest: freshness.identity.kernelReceiptDigest,
    now: NOW
  });
  const threatEvidence = await scanner(signer, status).scan({
    authorizationDigest: authorization.authorizationDigest,
    modelOutputDigest: freshness.identity.modelOutputDigest,
    kernelReceiptDigest: freshness.identity.kernelReceiptDigest,
    now: NOW
  });
  return { effect, binding, authorization, threatEvidence };
}

function repositoryFixture(): {
  readonly root: string;
  readonly sha: string;
  cleanup(): void;
} {
  const root = mkdtempSync(path.join(tmpdir(), "engineering-slice-test-"));
  mkdirSync(path.join(root, "examples/engineering/workspace"), { recursive: true });
  writeFileSync(
    path.join(root, "examples/engineering/workspace/README.md"),
    "# fixture\n"
  );
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Hermetic Test"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: root });
  const sha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8"
  }).trim();
  return {
    root,
    sha,
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

function workAccord(): WorkAccord {
  return JSON.parse(
    readFileSync("examples/engineering/work-accord.json", "utf8")
  ) as WorkAccord;
}

function activationLease(accord: WorkAccord): ActivationLease {
  return {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "ActivationLease",
    id: "engineering-lease",
    workAccordDigest: digest(accord),
    approvedBy: "maintainer",
    authorizationDigest: digest({ authorization: "engineering-lease" }),
    allowedPhases: ["framing", "execution", "verification"],
    allowedCapabilities: [
      "core.frame-artifact@1.0.0",
      "core.execute-bounded-change@1.0.0",
      "core.review-current-head@1.0.0"
    ],
    maxCalls: 3,
    maxTokens: 1000,
    maxCostUnits: 15,
    maxParallel: 1,
    expiresAt: EXPIRES,
    revoked: false
  };
}

function controlPolicy(): ControlPolicy {
  return JSON.parse(
    readFileSync("config/v1alpha1/policy.json", "utf8")
  ) as ControlPolicy;
}

function intake(receiptHead = digest({ intake: 1 })): EngineeringWorkBinding {
  return bindEngineeringIntake({
    repository: {
      id: 1,
      nodeId: "R_engineering",
      fullName: "example-organization/hyperfinite"
    },
    issue: { number: 2, nodeId: "I_engineering_slice" },
    projectOwnerNodeId: "O_github",
    projectNodeId: "PVT_synthetic_engineering",
    requesterActorId: "requester",
    automationActorId: "automation-app",
    projectItems: [
      {
        nodeId: "PVTI_synthetic_engineering",
        projectNodeId: "PVT_synthetic_engineering",
        contentNodeId: "I_engineering_slice"
      }
    ],
    receiptHead
  });
}

function executionGrant(
  accord: WorkAccord,
  sha: string
): BoundedExecutionGrant {
  return {
    repositoryId: 1,
    workItemNodeId: "I_engineering_slice",
    workAccordDigest: digest(accord),
    activationLeaseDigest: digest(activationLease(accord)),
    snapshotDigest: digest({ routeId: "framing.accept", index: 2 }),
    routeId: "planning.execute",
    baseSha: sha,
    targets: [
      {
        slot: "delivery-marker",
        path: "examples/engineering/workspace/delivery.txt",
        operation: "create",
        expectedDigest: null,
        expectedMode: "100644",
        maxBytes: 128
      }
    ],
    verificationCommandIds: ["git-diff-check"],
    maxFiles: 1,
    maxPatchBytes: 4096,
    maxTurns: 2,
    maxCostUnits: 15,
    expiresAt: EXPIRES
  };
}

function runPatch(
  input: Parameters<Parameters<typeof runEngineeringSlice>[0]["services"]["executePatch"]>[0]
) {
  return executeBoundedWorktree({
    ...input,
    runner: {
      isolation: "trusted-git-only",
      run(command) {
        const result = spawnSync(command.executable, command.args, {
          cwd: command.cwd,
          encoding: "utf8",
          env: command.env,
          maxBuffer: command.maxOutputBytes,
          shell: false,
          timeout: command.timeoutMs
        });
        return {
          status: result.status,
          signal: result.signal,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
          errorCode:
            result.error === undefined
              ? null
              : "code" in result.error && typeof result.error.code === "string"
                ? result.error.code
                : "UNKNOWN",
          environmentKeys: Object.keys(command.env).sort()
        };
      }
    }
  });
}

async function engineeringHarness(options: {
  readonly model?: FakeModel;
  readonly planner?: FakePlanner;
  readonly kernel?: FakeKernel;
  readonly grant?: (grant: BoundedExecutionGrant) => BoundedExecutionGrant;
  readonly clock?: { readonly now: () => string };
  readonly accord?: WorkAccord;
  readonly lease?: ActivationLease;
  readonly phaseTokenBudgets?: EngineeringCostReservation["phaseTokenBudgets"];
} = {}) {
  const repository = repositoryFixture();
  const accord = options.accord ?? workAccord();
  const binding = intake();
  const signer = new FixtureSigner();
  const github = new FakeGitHub(binding, repository.sha, repository.root);
  const costs = new FakeCosts(signer);
  const lease = options.lease ?? activationLease(accord);
  const activationLeases = new FakeActivationLeases(signer, lease);
  const closureCheckpoints = new InMemoryClosureCheckpointStore();
  const kernel = options.kernel ?? new FakeKernel();
  const planner = options.planner ?? new FakePlanner();
  const model = options.model ?? new FakeModel();
  const clock = options.clock ?? { now: () => NOW };
  const adapter = new EngineeringGitHubAdapter(
    new FakeBroker(github),
    new InMemoryEvidenceStore(),
    signer,
    signer
  );
  const baseGrant = {
    ...executionGrant(accord, repository.sha),
    activationLeaseDigest: digest(lease)
  };
  const grant = options.grant?.(baseGrant) ?? baseGrant;
  const humanGates = await gateProvider({
    signer,
    accord,
    binding,
    grant
  });
  return {
    repository,
    github,
    costs,
    activationLeases,
    signer,
    closureCheckpoints,
    humanGates,
    adapter,
    kernel,
    planner,
    model,
    input: {
      repositoryPath: repository.root,
      requesterId: "requester",
      automationActorId: "automation-app",
      controlPolicy: controlPolicy(),
      accord,
      activationLeaseDigest: digest(lease),
      binding,
      executionGrant: grant,
      branchName: "agentic/issue-2",
      pullRequestTitle: "Engineering slice",
      pullRequestBody: "Implements the approved work item.",
      phaseBudgets: { framing: 5, execution: 5, verification: 5 },
      phaseTokenBudgets: options.phaseTokenBudgets ?? PHASE_TOKEN_BUDGETS,
      measurementPlanDigest: digest({ measurements: ["lead-time"] }),
      maximumEvidenceAgeMs: 300_000,
      services: {
        clock,
        signer,
        verifier: signer,
        closureCheckpoints,
        humanGates,
        activationLeases,
        costs,
        providerUsage: costs,
        kernel,
        planner,
        model,
        executePatch: runPatch,
        github: adapter,
        deliveryAuthorizations: authorizationProvider(signer),
        threatScanner: scanner(signer)
      }
    } satisfies Parameters<typeof runEngineeringSlice>[0]
  };
}

async function prepareHarnessHumanMerge(
  harness: Awaited<ReturnType<typeof engineeringHarness>>
) {
  const awaitingResult = await runEngineeringSlice(harness.input);
  const awaiting = await harness.closureCheckpoints.readAwaitingHumanMerge(
    digest(awaitingResult.binding)
  );
  assert.ok(awaiting);
  await authenticateHarnessHumanMerge(harness, awaiting);
  return awaitingResult;
}

async function authenticateHarnessHumanMerge(
  harness: Awaited<ReturnType<typeof engineeringHarness>>,
  awaiting: EngineeringAwaitingHumanMergeCheckpoint
) {
  harness.humanGates.approvals.set(
    "approve-current-head",
    await authenticatedApproval({
      signer: harness.signer,
      binding: awaiting.binding,
      requesterId: harness.input.requesterId,
      automationActorId: harness.input.automationActorId,
      actorId: "reviewer",
      permission: "write",
      gate: "approve-current-head",
      artifactDigest: awaiting.reviewDigest,
      routeId: "review.accept",
      snapshotDigest: awaiting.kernelSnapshotDigest,
      workAccordDigest: awaiting.workAccordDigest,
      activationLeaseDigest: awaiting.activationLeaseDigest,
      currentHead: awaiting.reviewedHead,
      accord: harness.input.accord
    })
  );
  harness.github.mergeSha = MERGE_SHA;
  harness.github.observeIndependentHumanMerge(
    "human-merger",
    "2026-08-26T12:00:01.000Z"
  );
}

function resumeHarnessAfterHumanMerge(
  harness: Awaited<ReturnType<typeof engineeringHarness>>,
  binding: EngineeringWorkBinding
) {
  return resumeEngineeringAfterHumanMerge({
    binding,
    accord: harness.input.accord,
    controlPolicy: harness.input.controlPolicy,
    maximumEvidenceAgeMs: harness.input.maximumEvidenceAgeMs,
    services: {
      clock: harness.input.services.clock,
      signer: harness.signer,
      verifier: harness.signer,
      checkpoints: harness.closureCheckpoints,
      humanGates: harness.humanGates,
      activationLeases: harness.activationLeases,
      costs: harness.costs,
      github: harness.adapter,
      deliveryAuthorizations: authorizationProvider(harness.signer),
      threatScanner: scanner(harness.signer),
      kernel: harness.kernel
    }
  });
}

test("engineering slice is hermetic from canonical intake through operations closure", async () => {
  const repository = repositoryFixture();
  try {
    const accord = workAccord();
    const binding = intake();
    const signer = new FixtureSigner();
    const github = new FakeGitHub(binding, repository.sha, repository.root);
    github.mergeSha = MERGE_SHA;
    let currentTime = NOW;
    const broker = new FakeBroker(github);
    const store = new InMemoryEvidenceStore();
    const adapter = new EngineeringGitHubAdapter(
      broker,
      store,
      signer,
      signer
    );
    const model = new FakeModel();
    const planner = new FakePlanner();
    const costs = new FakeCosts(signer);
    const activationLeases = new FakeActivationLeases(
      signer,
      activationLease(accord)
    );
    const closureCheckpoints = new InMemoryClosureCheckpointStore();
    const humanGates = await gateProvider({
      signer,
      accord,
      binding,
      grant: executionGrant(accord, repository.sha)
    });
    const kernel = new FakeKernel();
    const result = await runEngineeringSlice({
      repositoryPath: repository.root,
      requesterId: "requester",
      automationActorId: "automation-app",
      controlPolicy: controlPolicy(),
      accord,
      activationLeaseDigest: digest(activationLease(accord)),
      binding,
      executionGrant: executionGrant(accord, repository.sha),
      branchName: "agentic/issue-2",
      pullRequestTitle: "Engineering slice",
      pullRequestBody: "Implements the approved work item.",
      phaseBudgets: { framing: 5, execution: 5, verification: 5 },
      phaseTokenBudgets: { framing: 100, execution: 100, verification: 100 },
      measurementPlanDigest: digest({ measurements: ["lead-time"] }),
      maximumEvidenceAgeMs: 300_000,
      services: {
        clock: { now: () => currentTime },
        signer,
        verifier: signer,
        closureCheckpoints,
        humanGates,
        activationLeases,
        costs,
        providerUsage: costs,
        kernel,
        planner,
        model,
        executePatch: (input) =>
          executeBoundedWorktree({
            ...input,
            runner: {
              isolation: "trusted-git-only",
              run(command) {
                const result = spawnSync(command.executable, command.args, {
                  cwd: command.cwd,
                  encoding: "utf8",
                  env: command.env,
                  maxBuffer: command.maxOutputBytes,
                  shell: false,
                  timeout: command.timeoutMs
                });
                return {
                  status: result.status,
                  signal: result.signal,
                  stdout: result.stdout ?? "",
                  stderr: result.stderr ?? "",
                  errorCode:
                    result.error === undefined
                      ? null
                      : "code" in result.error &&
                          typeof result.error.code === "string"
                        ? result.error.code
                        : "UNKNOWN",
                  environmentKeys: Object.keys(command.env).sort()
                };
              }
            }
          }),
        github: adapter,
        deliveryAuthorizations: authorizationProvider(signer),
        threatScanner: scanner(signer)
      }
    });

    assert.equal(result.binding.issue.nodeId, "I_engineering_slice");
    assert.equal(result.binding.project.itemNodeId, "PVTI_synthetic_engineering");
    assert.match(result.pullRequest.headSha, /^[0-9a-f]{40}$/u);
    assert.notEqual(result.pullRequest.headSha, repository.sha);
    assert.equal(result.costSettlements.length, 3);
    assert.equal(result.status, "awaiting-human-merge");
    assert.equal(costs.totalReleasedCostUnits, 12);
    assert.equal(costs.releaseApplications, 0);
    assert.deepEqual(
      github.effects.map((effect) => effect.type),
      [
        "create-branch",
        "create-commit",
        "create-draft-pull-request",
        "bind-pull-request",
        "comment-review"
      ]
    );
    const awaiting =
      await closureCheckpoints.readAwaitingHumanMerge(digest(result.binding));
    assert.ok(awaiting);
    humanGates.approvals.set(
      "approve-current-head",
      await authenticatedApproval({
        signer,
        binding: result.binding,
        requesterId: "requester",
        automationActorId: "automation-app",
        actorId: "reviewer",
        permission: "write",
        gate: "approve-current-head",
        artifactDigest: awaiting.reviewDigest,
        routeId: "review.accept",
        snapshotDigest: awaiting.kernelSnapshotDigest,
        workAccordDigest: awaiting.workAccordDigest,
        activationLeaseDigest: awaiting.activationLeaseDigest,
        currentHead: awaiting.reviewedHead,
        accord
      })
    );
    currentTime = "2026-08-26T12:00:02.000Z";
    github.observeIndependentHumanMerge(
      "human-merger",
      "2026-08-26T12:00:01.000Z"
    );
    const completed = await resumeEngineeringAfterHumanMerge({
      binding: result.binding,
      accord,
      controlPolicy: controlPolicy(),
      maximumEvidenceAgeMs: 300_000,
      services: {
        clock: { now: () => currentTime },
        signer,
        verifier: signer,
        checkpoints: closureCheckpoints,
        humanGates,
        activationLeases,
        costs,
        github: adapter,
        deliveryAuthorizations: authorizationProvider(signer),
        threatScanner: scanner(signer),
        kernel
      }
    });
    assert.equal(completed.mergedSha, MERGE_SHA);
    assert.equal(completed.costRelease.releasedCostUnits, 0);
    assert.equal(costs.totalReleasedCostUnits, 12);
    assert.equal(costs.releaseApplications, 1);
    assert.deepEqual(
      github.effects.map((effect) => effect.type),
      [
        "create-branch",
        "create-commit",
        "create-draft-pull-request",
        "bind-pull-request",
        "comment-review",
        "project-converge",
        "close-issue",
        "record-delivery",
        "operations-handoff"
      ]
    );
    const review = github.effects.find((effect) => effect.type === "comment-review");
    assert.equal(review?.event, "COMMENT");
    const draft = github.effects.find(
      (effect) => effect.type === "create-draft-pull-request"
    );
    assert.equal(draft?.draft, true);
    assert.equal(github.snapshot.projectStage, "completed");
    assert.equal(github.snapshot.issueClosed, true);
    assert.deepEqual(model.receivedCredentials, []);
    assert.equal(planner.calls, 1);
    assert.equal(model.frameCalls, 1);
    assert.equal(model.implementationCalls, 1);
    assert.equal(model.reviewCalls, 1);
    assert.equal(
      github.effects.some((effect) =>
        ["approve", "merge", "dismiss", "auto-merge"].includes(effect.type)
      ),
      false
    );
  } finally {
    repository.cleanup();
  }
});

test("accepted plan narrows execution targets and rejects model changes to unplanned slots", async () => {
  const harness = await engineeringHarness({
    model: new FakeModel("unplanned-slot"),
    grant: (grant) => ({
      ...grant,
      targets: [
        ...grant.targets,
        {
          slot: "unplanned-slot",
          path: "examples/engineering/workspace/unplanned.txt",
          operation: "create",
          expectedDigest: null,
          expectedMode: "100644",
          maxBytes: 128
        }
      ],
      maxFiles: 2
    })
  });
  try {
    await assert.rejects(
      runEngineeringSlice(harness.input),
      /target-free patch change unplanned-slot is invalid/u
    );
    assert.equal(harness.costs.releaseCalls, 1);
    assert.equal(harness.costs.totalReleasedCostUnits, 13);
    assert.equal(harness.github.effects.length, 0);
  } finally {
    harness.repository.cleanup();
  }
});

test("a predecessor-revision checkpoint is refused, never reinterpreted", async () => {
  // A checkpoint is signed over whatever fields its writer produced, so a
  // 1.0.0 document still verifies: the signature proves authorship, not shape.
  // Only an explicit version comparison refuses it. Without one the resume path
  // reaches the release with an undefined hold set and strands the whole
  // reservation behind an untyped crash.
  const harness = await engineeringHarness();
  try {
    const result = await prepareHarnessHumanMerge(harness);
    const current = await harness.closureCheckpoints.readAwaitingHumanMerge(
      digest(result.binding)
    );
    assert.ok(current);
    const { openHolds: _open, signature: _drop, ...rest } = current;
    // Exactly what the previous revision wrote: no cost holds, an
    // unresolved-attempt list, and its own valid signature.
    const legacyPayload = {
      ...rest,
      schemaVersion: "1.0.0",
      unresolvedAttempts: []
    };
    const legacy = {
      ...legacyPayload,
      signature: await harness.signer.sign(legacyPayload)
    } as unknown as EngineeringAwaitingHumanMergeCheckpoint;
    assert.ok(
      harness.signer.verify(
        { ...legacyPayload },
        legacy.signature
      ),
      "the predecessor document must still verify, which is why the version is checked"
    );
    await harness.closureCheckpoints.putAwaitingHumanMerge(legacy);

    await assert.rejects(
      resumeHarnessAfterHumanMerge(harness, result.binding),
      /AUTHORIZATION_INVALID|awaiting-human-merge checkpoint is absent/u
    );
    assert.equal(
      harness.costs.releaseCalls,
      0,
      "a refused checkpoint releases nothing"
    );
  } finally {
    harness.repository.cleanup();
  }
});

test("a failure after the cost hold keeps that phase's budget held, never released", async () => {
  // The window this contract exists to close. `costs.hold()` commits the
  // execution budget durably, and the very next awaited step throws. Before
  // holds existed the attempt was already recorded in the provider journal but
  // not in the caller's list, so release returned its budget to the pool while
  // the provider could still report cost against it.
  const harness = await engineeringHarness();
  harness.activationLeases.afterRead = () => {
    if (harness.activationLeases.calls === 2) {
      throw new Error("simulated provider-authority read failure");
    }
  };
  try {
    await assert.rejects(
      runEngineeringSlice(harness.input),
      /simulated provider-authority read failure/u
    );
    // framing settled at 1 of 5; execution held its full 5; verification's 5
    // was never held and is the only budget this release may return.
    const release = harness.costs.lastRelease;
    assert.notEqual(release, null);
    assert.equal(release?.heldCostUnits, 5, "the execution hold keeps its budget");
    assert.equal(release?.releasedCostUnits, 5, "only verification is released");
    assert.equal(
      release?.reconciliationRequired,
      true,
      "an unresolved hold is reported, never quietly returned"
    );
    assert.equal(
      (release?.cumulativeCostUnits ?? 0) +
        (release?.cumulativeReleasedCostUnits ?? 0) +
        (release?.heldCostUnits ?? 0),
      15,
      "spent, returned, and still held account for every reserved unit"
    );
    assert.equal(harness.model.implementationCalls, 0);
  } finally {
    harness.repository.cleanup();
  }
});

test("a caller that loses track of its hold still cannot release that budget", async () => {
  // The same failure, but the caller's own view is emptied before release —
  // which is what a crash between the durable hold and the caller's bookkeeping
  // leaves behind. The ledger derives the open set from its own state, so the
  // omission changes nothing about what is held.
  const harness = await engineeringHarness();
  harness.activationLeases.afterRead = () => {
    if (harness.activationLeases.calls === 2) {
      throw new Error("simulated crash before registration");
    }
  };
  harness.costs.dropCallerOpenHoldsOnRelease = true;
  try {
    await assert.rejects(
      runEngineeringSlice(harness.input),
      /simulated crash before registration/u
    );
    const release = harness.costs.lastRelease;
    assert.equal(
      release?.heldCostUnits,
      5,
      "an omitted open hold is still derived and still held"
    );
    assert.equal(release?.releasedCostUnits, 5);
    assert.equal(release?.reconciliationRequired, true);
  } finally {
    harness.repository.cleanup();
  }
});

test("execution grant must bind the exact planning route and snapshot", async () => {
  const harness = await engineeringHarness({
    grant: (grant) => ({ ...grant, snapshotDigest: digest({ stale: true }) })
  });
  try {
    await assert.rejects(
      runEngineeringSlice(harness.input),
      /AUTHORIZATION_INVALID|planning transition snapshot/u
    );
    assert.equal(harness.model.implementationCalls, 0);
    assert.equal(harness.costs.releaseCalls, 1);
    assert.deepEqual(harness.kernel.observedRoutes, [
      "activation.begin-framing",
      "framing.accept"
    ]);
  } finally {
    harness.repository.cleanup();
  }
});

test("execution grant expiry, base, targets, and model cost fail before inference", async () => {
  const mutations: readonly ((
    grant: BoundedExecutionGrant
  ) => BoundedExecutionGrant)[] = [
    (grant) => ({ ...grant, expiresAt: NOW }),
    (grant) => ({ ...grant, baseSha: "9999999999999999999999999999999999999999" }),
    (grant) => ({ ...grant, maxCostUnits: 4 }),
    (grant) => ({
      ...grant,
      targets: [
        {
          ...grant.targets[0]!,
          path: "src/forbidden.ts"
        }
      ]
    })
  ];
  for (const mutate of mutations) {
    const harness = await engineeringHarness({ grant: mutate });
    try {
      await assert.rejects(
        runEngineeringSlice(harness.input),
        /GRANT_INVALID|TARGET_DENIED|AUTHORIZATION_INVALID|execution grant is expired or does not bind the current base|execution grant route or reserved model cost is not authorized|execution target .* is not authorized/u
      );
      assert.equal(harness.model.frameCalls, 0);
      assert.equal(harness.model.implementationCalls, 0);
      assert.equal(harness.costs.releaseCalls, 0);
      assert.equal(harness.github.effects.length, 0);
    } finally {
      harness.repository.cleanup();
    }
  }
});

test("planning cannot omit, duplicate, or invent mandatory verification commands", async () => {
  for (const selected of [
    [] as readonly string[],
    ["git-diff-check", "git-diff-check"],
    ["invented-command"]
  ]) {
    const harness = await engineeringHarness({
      planner: new FakePlanner(undefined, () => selected)
    });
    try {
      await assert.rejects(
        runEngineeringSlice(harness.input),
        /MODEL_OUTPUT_INVALID|mandatory fixed verification|planning artifact is invalid|unapproved logical slot or verification ID/u
      );
      assert.equal(harness.model.implementationCalls, 0);
      assert.equal(harness.github.effects.length, 0);
      assert.equal(harness.costs.totalReleasedCostUnits, 14);
    } finally {
      harness.repository.cleanup();
    }
  }
});

test("unexpected existing pull request is rejected before mutation", async () => {
  const harness = await engineeringHarness();
  harness.github.snapshot = {
    ...harness.github.snapshot,
    pullRequest: {
      number: 99,
      nodeId: "PR_unexpected",
      baseRepositoryId: harness.input.binding.repository.id,
      baseRef: "main",
      baseSha: harness.repository.sha,
      headRepositoryId: harness.input.binding.repository.id,
      headRef: "unexpected",
      headSha: COMMIT_SHA,
      draft: true,
      open: true,
      merged: false,
      mergedSha: null,
      mergedByActorId: null,
      mergedByHuman: false,
      mergedAt: null
    }
  };
  try {
    await assert.rejects(
      runEngineeringSlice(harness.input),
      /BINDING_STALE|unexpected pull request/u
    );
    assert.equal(harness.model.frameCalls, 0);
    assert.equal(harness.github.effects.length, 0);
  } finally {
    harness.repository.cleanup();
  }
});

test("branch and draft pull request derive a non-main authenticated default branch", async () => {
  const harness = await engineeringHarness();
  harness.github.snapshot = {
    ...harness.github.snapshot,
    defaultBranch: { ref: "trunk", sha: harness.repository.sha }
  };
  try {
    await runEngineeringSlice(harness.input);
    const branch = harness.github.effects.find(
      (effect) => effect.type === "create-branch"
    );
    const draft = harness.github.effects.find(
      (effect) => effect.type === "create-draft-pull-request"
    );
    assert.equal(branch?.baseRef, "trunk");
    assert.equal(branch?.baseSha, harness.repository.sha);
    assert.equal(draft?.baseRef, "trunk");
    assert.equal(draft?.baseSha, harness.repository.sha);
  } finally {
    harness.repository.cleanup();
  }
});

test("blocked independent review cannot advance verification or closure", async () => {
  const harness = await engineeringHarness({
    model: new FakeModel("delivery-marker", "blocked")
  });
  try {
    await assert.rejects(
      runEngineeringSlice(harness.input),
      /KERNEL_REFUSED|exact success/u
    );
    assert.equal(harness.costs.releaseCalls, 1);
    assert.equal(harness.costs.totalReleasedCostUnits, 12);
    assert.equal(
      harness.kernel.observedRoutes.includes("verification.request-review"),
      false
    );
    assert.equal(
      harness.github.effects.some((effect) => effect.type === "project-converge"),
      false
    );
  } finally {
    harness.repository.cleanup();
  }
});

test("provider usage is settled before invalid model artifacts are rejected", async () => {
  const harness = await engineeringHarness({ model: new InvalidFrameModel() });
  try {
    await assert.rejects(
      runEngineeringSlice(harness.input),
      /MODEL_OUTPUT_INVALID|framing artifact/u
    );
    assert.equal(harness.model.frameCalls, 1);
    assert.equal(harness.costs.releaseCalls, 1);
    assert.equal(harness.costs.totalReleasedCostUnits, 14);
    assert.equal(harness.github.effects.length, 0);
  } finally {
    harness.repository.cleanup();
  }
});

test("thrown inference reconciles authoritative usage and unknown usage remains held", async () => {
  class ThrowingFrameModel extends FakeModel {
    override async frame(): ReturnType<EngineeringModel["frame"]> {
      this.frameCalls += 1;
      throw new Error("simulated provider transport failure");
    }
  }

  const settled = await engineeringHarness({ model: new ThrowingFrameModel() });
  try {
    await assert.rejects(
      runEngineeringSlice(settled.input),
      /simulated provider transport failure/u
    );
    assert.equal(settled.costs.totalReleasedCostUnits, 14);
  } finally {
    settled.repository.cleanup();
  }

  const unknown = await engineeringHarness({ model: new ThrowingFrameModel() });
  unknown.costs.unknownUsagePhase = "framing";
  try {
    await assert.rejects(
      runEngineeringSlice(unknown.input),
      /simulated provider transport failure/u
    );
    assert.equal(unknown.costs.totalReleasedCostUnits, 10);
  } finally {
    unknown.repository.cleanup();
  }
});

test("lost settlement acknowledgement is reconciled without double release", async () => {
  const harness = await engineeringHarness();
  harness.costs.failSettlementAcknowledgementOnce = true;
  try {
    const awaiting = await prepareHarnessHumanMerge(harness);
    const result = await resumeHarnessAfterHumanMerge(
      harness,
      awaiting.binding
    );
    assert.equal(result.costSettlements.length, 3);
    assert.equal(harness.costs.totalReleasedCostUnits, 12);
    assert.equal(harness.costs.releaseApplications, 1);
  } finally {
    harness.repository.cleanup();
  }
});

test("authoritative usage settles before model-reported cost or token mismatch fails", async () => {
  for (const mismatch of ["cost", "tokens", "cost-lost-ack"] as const) {
    const model = new FakeModel();
    if (mismatch === "tokens") model.reportedTokenUnits = 2;
    else model.reportedCostUnits = 2;
    const harness = await engineeringHarness({ model });
    harness.costs.failSettlementAcknowledgementOnce = mismatch === "cost-lost-ack";
    try {
      await assert.rejects(
        runEngineeringSlice(harness.input),
        /model result differs from authoritative provider usage/u
      );
      assert.equal(harness.costs.settlementCount, 1);
      assert.equal(harness.costs.totalReleasedCostUnits, 14);
      assert.equal(harness.costs.releaseApplications, 1);
      assert.equal(harness.github.effects.length, 0);
    } finally {
      harness.repository.cleanup();
    }
  }
});

test("model authority is revalidated immediately before implementation and review", async () => {
  const implementationHarness = await engineeringHarness({
    grant: (grant) => ({
      ...grant,
      expiresAt: "2026-08-26T12:03:00.000Z"
    })
  });
  let now = NOW;
  const gates = implementationHarness.input.services.humanGates;
  const advancingGates: HumanGateProvider = {
    async read(gate) {
      const approval = await gates.read(gate);
      if (gate === "accept-plan") now = "2026-08-26T12:04:00.000Z";
      return approval;
    }
  };
  try {
    await assert.rejects(
      runEngineeringSlice({
        ...implementationHarness.input,
        services: {
          ...implementationHarness.input.services,
          clock: { now: () => now },
          humanGates: advancingGates
        }
      }),
      /GRANT_INVALID|expired/u
    );
    assert.equal(implementationHarness.model.implementationCalls, 0);
  } finally {
    implementationHarness.repository.cleanup();
  }

  const reviewHarness = await engineeringHarness();
  const originalApply = reviewHarness.github.applyEffect.bind(reviewHarness.github);
  reviewHarness.github.applyEffect = async (effect, patchBundle) => {
    const observation = await originalApply(effect, patchBundle);
    if (effect.type === "bind-pull-request" && reviewHarness.github.snapshot.pullRequest) {
      reviewHarness.github.snapshot = {
        ...reviewHarness.github.snapshot,
        pullRequest: {
          ...reviewHarness.github.snapshot.pullRequest,
          headSha: "9999999999999999999999999999999999999999"
        }
      };
    }
    return observation;
  };
  try {
    await assert.rejects(
      runEngineeringSlice(reviewHarness.input),
      /CURRENT_HEAD_STALE|head changed/u
    );
    assert.equal(reviewHarness.model.reviewCalls, 0);
  } finally {
    reviewHarness.repository.cleanup();
  }

  const baseAdvanceHarness = await engineeringHarness();
  const applyBeforeBaseAdvance =
    baseAdvanceHarness.github.applyEffect.bind(baseAdvanceHarness.github);
  baseAdvanceHarness.github.applyEffect = async (effect, patchBundle) => {
    const observation = await applyBeforeBaseAdvance(effect, patchBundle);
    if (
      effect.type === "bind-pull-request" &&
      baseAdvanceHarness.github.snapshot.pullRequest
    ) {
      baseAdvanceHarness.github.snapshot = {
        ...baseAdvanceHarness.github.snapshot,
        pullRequest: {
          ...baseAdvanceHarness.github.snapshot.pullRequest,
          baseSha: "9999999999999999999999999999999999999999"
        }
      };
    }
    return observation;
  };
  try {
    await assert.rejects(
      runEngineeringSlice(baseAdvanceHarness.input),
      /CURRENT_HEAD_STALE|head changed/u
    );
    assert.equal(baseAdvanceHarness.model.reviewCalls, 0);
    assert.equal(
      baseAdvanceHarness.github.effects.some(
        (effect) => effect.type === "comment-review"
      ),
      false
    );
  } finally {
    baseAdvanceHarness.repository.cleanup();
  }
});

test("review effect rejects a base advance after verification inference", async () => {
  const harness = await engineeringHarness();
  const originalReview = harness.model.review.bind(harness.model);
  harness.model.review = async () => {
    const result = await originalReview();
    if (harness.github.snapshot.pullRequest !== null) {
      harness.github.snapshot = {
        ...harness.github.snapshot,
        pullRequest: {
          ...harness.github.snapshot.pullRequest,
          baseSha: "9999999999999999999999999999999999999999"
        }
      };
    }
    return result;
  };
  try {
    await assert.rejects(
      runEngineeringSlice(harness.input),
      /CURRENT_HEAD_STALE|head changed/u
    );
    assert.equal(harness.model.reviewCalls, 1);
    assert.equal(
      harness.github.effects.some((effect) => effect.type === "comment-review"),
      false
    );
  } finally {
    harness.repository.cleanup();
  }
});

test("live lease revocation prevents every later provider call", async () => {
  const beforeImplementation = await engineeringHarness();
  beforeImplementation.activationLeases.revokeAfterReads = 1;
  try {
    await assert.rejects(
      runEngineeringSlice(beforeImplementation.input),
      /AUTHORIZATION_INVALID|revoked/u
    );
    assert.equal(beforeImplementation.model.frameCalls, 1);
    assert.equal(beforeImplementation.model.implementationCalls, 0);
    assert.equal(beforeImplementation.model.reviewCalls, 0);
  } finally {
    beforeImplementation.repository.cleanup();
  }

  const beforeReview = await engineeringHarness();
  beforeReview.activationLeases.revokeAfterReads = 2;
  try {
    await assert.rejects(
      runEngineeringSlice(beforeReview.input),
      /AUTHORIZATION_INVALID|revoked/u
    );
    assert.equal(beforeReview.model.frameCalls, 1);
    assert.equal(beforeReview.model.implementationCalls, 1);
    assert.equal(beforeReview.model.reviewCalls, 0);
  } finally {
    beforeReview.repository.cleanup();
  }

  const duringHumanWait = await engineeringHarness();
  try {
    const awaiting = await prepareHarnessHumanMerge(duringHumanWait);
    const calls = {
      frame: duringHumanWait.model.frameCalls,
      implementation: duringHumanWait.model.implementationCalls,
      review: duringHumanWait.model.reviewCalls
    };
    duringHumanWait.activationLeases.revokeAfterReads = 0;
    await assert.rejects(
      resumeHarnessAfterHumanMerge(duringHumanWait, awaiting.binding),
      /AUTHORIZATION_INVALID|revoked/u
    );
    assert.deepEqual(
      {
        frame: duringHumanWait.model.frameCalls,
        implementation: duringHumanWait.model.implementationCalls,
        review: duringHumanWait.model.reviewCalls
      },
      calls
    );
  } finally {
    duringHumanWait.repository.cleanup();
  }
});

test("lease call, token, and expiry limits are enforced at invocation boundaries", async () => {
  const baseAccord = workAccord();
  const oneCallAccord = {
    ...baseAccord,
    budget: { ...baseAccord.budget, maxCalls: 1 }
  };
  const oneCallLease = {
    ...activationLease(oneCallAccord),
    maxCalls: 1
  };
  const oneCall = await engineeringHarness({
    accord: oneCallAccord,
    lease: oneCallLease
  });
  try {
    await assert.rejects(
      runEngineeringSlice(oneCall.input),
      /AUTHORIZATION_INVALID|Activation Lease/u
    );
    assert.equal(oneCall.model.frameCalls, 1);
    assert.equal(oneCall.model.implementationCalls, 0);
  } finally {
    oneCall.repository.cleanup();
  }

  const tokenAccord = {
    ...baseAccord,
    budget: { ...baseAccord.budget, maxTokens: 3 }
  };
  const tokenLease = {
    ...activationLease(tokenAccord),
    maxTokens: 3
  };
  const exactBoundary = await engineeringHarness({
    accord: tokenAccord,
    lease: tokenLease,
    phaseTokenBudgets: { framing: 1, execution: 1, verification: 1 }
  });
  try {
    const awaiting = await runEngineeringSlice(exactBoundary.input);
    assert.equal(awaiting.costSettlements.at(-1)?.cumulativeTokens, 3);
  } finally {
    exactBoundary.repository.cleanup();
  }

  const tokenOverflow = await engineeringHarness({
    accord: tokenAccord,
    lease: tokenLease,
    phaseTokenBudgets: { framing: 1, execution: 1, verification: 2 }
  });
  try {
    await assert.rejects(
      runEngineeringSlice(tokenOverflow.input),
      /COST_INVALID|phase budgets/u
    );
    assert.equal(tokenOverflow.model.frameCalls, 0);
  } finally {
    tokenOverflow.repository.cleanup();
  }

  let currentTime = NOW;
  const expiringLease = {
    ...activationLease(baseAccord),
    expiresAt: "2026-08-26T12:00:01.000Z"
  };
  const expiryDuringRead = await engineeringHarness({
    clock: { now: () => currentTime },
    lease: expiringLease
  });
  expiryDuringRead.activationLeases.afterRead = () => {
    currentTime = "2026-08-26T12:00:02.000Z";
  };
  try {
    await assert.rejects(
      runEngineeringSlice(expiryDuringRead.input),
      /AUTHORIZATION_INVALID|expired/u
    );
    assert.equal(expiryDuringRead.model.frameCalls, 0);
  } finally {
    expiryDuringRead.repository.cleanup();
  }
});

test("durable human-wait evidence survives the freshness window but not expiry", async () => {
  let currentTime = NOW;
  const harness = await engineeringHarness({
    clock: { now: () => currentTime }
  });
  try {
    const awaiting = await runEngineeringSlice(harness.input);
    const checkpoint =
      await harness.closureCheckpoints.readAwaitingHumanMerge(
        digest(awaiting.binding)
      );
    assert.ok(checkpoint);
    currentTime = "2026-08-26T12:10:00.000Z";
    harness.humanGates.approvals.set(
      "approve-current-head",
      await authenticatedApproval({
        signer: harness.signer,
        binding: checkpoint.binding,
        requesterId: harness.input.requesterId,
        automationActorId: harness.input.automationActorId,
        actorId: "reviewer",
        permission: "write",
        gate: "approve-current-head",
        artifactDigest: checkpoint.reviewDigest,
        routeId: "review.accept",
        snapshotDigest: checkpoint.kernelSnapshotDigest,
        workAccordDigest: checkpoint.workAccordDigest,
        activationLeaseDigest: checkpoint.activationLeaseDigest,
        currentHead: checkpoint.reviewedHead,
        accord: harness.input.accord,
        observedAt: currentTime
      })
    );
    harness.github.mergeSha = MERGE_SHA;
    harness.github.observeIndependentHumanMerge(
      "human-merger",
      "2026-08-26T12:10:01.000Z"
    );
    currentTime = "2026-08-26T12:10:02.000Z";
    const completed = await resumeHarnessAfterHumanMerge(
      harness,
      awaiting.binding
    );
    assert.equal(completed.mergedSha, MERGE_SHA);

    const tampered = {
      ...checkpoint,
      expiresAt: "2026-08-26T12:09:59.000Z"
    };
    harness.closureCheckpoints.awaiting.set(digest(awaiting.binding), tampered);
    await assert.rejects(
      resumeHarnessAfterHumanMerge(harness, awaiting.binding),
      /absent, unsigned, or inconsistent|expired/u
    );
  } finally {
    harness.repository.cleanup();
  }
});

test("human merge resume requires independent approval before the merge event", async () => {
  const missingApproval = await engineeringHarness();
  try {
    const awaiting = await runEngineeringSlice(missingApproval.input);
    missingApproval.github.observeIndependentHumanMerge(
      "human-merger",
      "2026-08-26T12:00:01.000Z"
    );
    await assert.rejects(
      resumeHarnessAfterHumanMerge(missingApproval, awaiting.binding),
      /approve-current-head approval evidence is missing/u
    );
    assert.equal(missingApproval.costs.releaseApplications, 0);
  } finally {
    missingApproval.repository.cleanup();
  }

  const outOfOrder = await engineeringHarness();
  try {
    const awaiting = await runEngineeringSlice(outOfOrder.input);
    const checkpoint =
      await outOfOrder.closureCheckpoints.readAwaitingHumanMerge(
        digest(awaiting.binding)
      );
    assert.ok(checkpoint);
    outOfOrder.humanGates.approvals.set(
      "approve-current-head",
      await authenticatedApproval({
        signer: outOfOrder.signer,
        binding: awaiting.binding,
        requesterId: outOfOrder.input.requesterId,
        automationActorId: outOfOrder.input.automationActorId,
        actorId: "reviewer",
        permission: "write",
        gate: "approve-current-head",
        artifactDigest: checkpoint.reviewDigest,
        routeId: "review.accept",
        snapshotDigest: checkpoint.kernelSnapshotDigest,
        workAccordDigest: checkpoint.workAccordDigest,
        activationLeaseDigest: checkpoint.activationLeaseDigest,
        currentHead: checkpoint.reviewedHead,
        accord: outOfOrder.input.accord
      })
    );
    outOfOrder.github.observeIndependentHumanMerge(
      "human-merger",
      "2026-08-26T11:59:59.000Z"
    );
    await assert.rejects(
      resumeHarnessAfterHumanMerge(outOfOrder, awaiting.binding),
      /HUMAN_MERGE_REQUIRED|independent human/u
    );
    assert.equal(outOfOrder.costs.releaseApplications, 0);
  } finally {
    outOfOrder.repository.cleanup();
  }
});

test("human approval and merge observation reject an advanced PR base", async () => {
  const approvalHarness = await engineeringHarness();
  try {
    const awaitingResult = await runEngineeringSlice(approvalHarness.input);
    const awaiting =
      await approvalHarness.closureCheckpoints.readAwaitingHumanMerge(
        digest(awaitingResult.binding)
      );
    assert.ok(awaiting);
    approvalHarness.humanGates.approvals.set(
      "approve-current-head",
      await authenticatedApproval({
        signer: approvalHarness.signer,
        binding: awaiting.binding,
        requesterId: approvalHarness.input.requesterId,
        automationActorId: approvalHarness.input.automationActorId,
        actorId: "reviewer",
        permission: "write",
        gate: "approve-current-head",
        artifactDigest: awaiting.reviewDigest,
        routeId: "review.accept",
        snapshotDigest: awaiting.kernelSnapshotDigest,
        workAccordDigest: awaiting.workAccordDigest,
        activationLeaseDigest: awaiting.activationLeaseDigest,
        currentHead: awaiting.reviewedHead,
        accord: approvalHarness.input.accord
      })
    );
    assert.notEqual(approvalHarness.github.snapshot.pullRequest, null);
    if (approvalHarness.github.snapshot.pullRequest === null) {
      throw new TypeError("approval fixture omitted its pull request");
    }
    approvalHarness.github.snapshot = {
      ...approvalHarness.github.snapshot,
      pullRequest: {
        ...approvalHarness.github.snapshot.pullRequest,
        baseSha: "9999999999999999999999999999999999999999"
      }
    };
    await assert.rejects(
      resumeHarnessAfterHumanMerge(approvalHarness, awaiting.binding),
      /CURRENT_HEAD_STALE|head changed/u
    );
    assert.equal(approvalHarness.costs.releaseApplications, 0);
  } finally {
    approvalHarness.repository.cleanup();
  }

  const mergeHarness = await engineeringHarness();
  try {
    const awaitingResult = await prepareHarnessHumanMerge(mergeHarness);
    assert.notEqual(mergeHarness.github.snapshot.pullRequest, null);
    if (mergeHarness.github.snapshot.pullRequest === null) {
      throw new TypeError("merge fixture omitted its pull request");
    }
    mergeHarness.github.snapshot = {
      ...mergeHarness.github.snapshot,
      pullRequest: {
        ...mergeHarness.github.snapshot.pullRequest,
        baseSha: "9999999999999999999999999999999999999999"
      }
    };
    await assert.rejects(
      resumeHarnessAfterHumanMerge(mergeHarness, awaitingResult.binding),
      /CURRENT_HEAD_STALE|head changed/u
    );
  } finally {
    mergeHarness.repository.cleanup();
  }
});

test("authenticated closure checkpoint resumes every post-release effect without model calls", async () => {
  for (const effectType of [
    "project-converge",
    "close-issue",
    "record-delivery",
    "operations-handoff",
    "kernel"
  ] as const) {
    const harness = await engineeringHarness();
    if (effectType === "kernel") {
      harness.kernel.failAfterRoute = "review.accept";
    } else {
      harness.github.failAfterApplyType = effectType;
    }
    try {
      const awaiting = await prepareHarnessHumanMerge(harness);
      await assert.rejects(
        resumeHarnessAfterHumanMerge(harness, awaiting.binding),
        /effect failed after write attempt|simulated kernel acknowledgement loss/u
      );
      const checkpointDigest = [
        ...harness.closureCheckpoints.values.keys()
      ][0] as Digest | undefined;
      assert.ok(checkpointDigest);
      const calls = {
        frame: harness.model.frameCalls,
        implement: harness.model.implementationCalls,
        review: harness.model.reviewCalls
      };
      const closure = await resumeEngineeringClosure({
        checkpointDigest,
        maximumEvidenceAgeMs: harness.input.maximumEvidenceAgeMs,
        services: {
          clock: harness.input.services.clock,
          verifier: harness.signer,
          checkpoints: harness.closureCheckpoints,
          humanGates: harness.humanGates,
          activationLeases: harness.activationLeases,
          github: harness.adapter,
          deliveryAuthorizations: authorizationProvider(harness.signer),
          threatScanner: scanner(harness.signer),
          kernel: harness.kernel
        },
        accord: harness.input.accord,
        controlPolicy: harness.input.controlPolicy
      });
      assert.match(closure.kernelReceiptDigest, /^sha256:/u);
      assert.deepEqual(
        {
          frame: harness.model.frameCalls,
          implement: harness.model.implementationCalls,
          review: harness.model.reviewCalls
        },
        calls
      );
    } finally {
      harness.repository.cleanup();
    }
  }
});

test("closure revalidates human approval and lease immediately before each mutation", async () => {
  for (const revokedAuthority of ["approval", "lease"] as const) {
    const harness = await engineeringHarness();
    harness.github.failAfterApplyType = "project-converge";
    try {
      const awaiting = await prepareHarnessHumanMerge(harness);
      await assert.rejects(
        resumeHarnessAfterHumanMerge(harness, awaiting.binding),
        /effect failed after write attempt/u
      );
      const checkpointDigest = [
        ...harness.closureCheckpoints.values.keys()
      ][0] as Digest | undefined;
      assert.ok(checkpointDigest);
      if (revokedAuthority === "approval") {
        harness.humanGates.afterRead = (gate) => {
          if (gate === "approve-current-head") {
            harness.humanGates.approvals.delete(gate);
            harness.humanGates.afterRead = null;
          }
        };
      } else {
        harness.activationLeases.revokeAfterReads =
          harness.activationLeases.calls + 1;
      }
      await assert.rejects(
        resumeEngineeringClosure({
          checkpointDigest,
          accord: harness.input.accord,
          controlPolicy: harness.input.controlPolicy,
          maximumEvidenceAgeMs: harness.input.maximumEvidenceAgeMs,
          services: {
            clock: harness.input.services.clock,
            verifier: harness.signer,
            checkpoints: harness.closureCheckpoints,
            humanGates: harness.humanGates,
            activationLeases: harness.activationLeases,
            github: harness.adapter,
            deliveryAuthorizations: authorizationProvider(harness.signer),
            threatScanner: scanner(harness.signer),
            kernel: harness.kernel
          }
        }),
        /fresh approve-current-head evidence|AUTHORIZATION_INVALID|revoked/u
      );
      assert.equal(
        harness.github.effects.some((effect) => effect.type === "close-issue"),
        false
      );
    } finally {
      harness.repository.cleanup();
    }
  }
});

test("tampered or independently shortened cost-release checkpoints fail closed", async () => {
  const harness = await engineeringHarness();
  harness.costs.failRelease = true;
  try {
    const awaiting = await prepareHarnessHumanMerge(harness);
    await assert.rejects(
      resumeHarnessAfterHumanMerge(harness, awaiting.binding),
      /simulated release failure/u
    );
    const release = harness.closureCheckpoints.releases.get(
      digest(awaiting.binding)
    );
    assert.ok(release);
    const { signature: _signature, ...payload } = release;
    const shortenedPayload = {
      ...payload,
      expiresAt: "2026-08-26T12:15:00.000Z"
    };
    harness.closureCheckpoints.releases.set(digest(awaiting.binding), {
      ...shortenedPayload,
      signature: await harness.signer.sign(shortenedPayload)
    });
    harness.costs.failRelease = false;
    await assert.rejects(
      resumeHarnessAfterHumanMerge(harness, awaiting.binding),
      /cost-release checkpoint is unsigned, stale, or inconsistent/u
    );
    assert.equal(harness.costs.releaseApplications, 0);
  } finally {
    harness.repository.cleanup();
  }
});

test("provider usage completing after invocation expiry is settled before output rejection", async () => {
  let currentTime = NOW;
  class ExpiringModel extends FakeModel {
    override async frame(): ReturnType<EngineeringModel["frame"]> {
      const result = await super.frame();
      currentTime = "2026-08-26T12:00:31.000Z";
      return result;
    }
  }
  const accord = {
    ...workAccord(),
    budget: {
      ...workAccord().budget,
      expiresAt: "2026-08-26T12:00:30.000Z"
    }
  };
  const harness = await engineeringHarness({
    accord,
    clock: { now: () => currentTime },
    model: new ExpiringModel()
  });
  try {
    await assert.rejects(
      runEngineeringSlice(harness.input),
      /output completed after invocation authority expired/u
    );
    assert.equal(harness.costs.settlementCount, 1);
    assert.equal(harness.costs.releaseApplications, 1);
    assert.equal(harness.github.effects.length, 0);
  } finally {
    harness.repository.cleanup();
  }
});

test("post-release retry reuses one closure checkpoint as trusted time advances", async () => {
  let currentTime = NOW;
  const kernel = new FakeKernel();
  const harness = await engineeringHarness({
    kernel,
    clock: { now: () => currentTime }
  });
  kernel.failAfterRoute = "review.accept";
  try {
    const awaiting = await prepareHarnessHumanMerge(harness);
    currentTime = "2026-08-26T12:00:02.000Z";
    await assert.rejects(
      resumeHarnessAfterHumanMerge(harness, awaiting.binding),
      /simulated kernel acknowledgement loss/u
    );
    const [checkpointDigest] = harness.closureCheckpoints.values.keys();
    assert.ok(checkpointDigest);

    currentTime = "2026-08-26T12:00:03.000Z";
    const result = await resumeHarnessAfterHumanMerge(
      harness,
      awaiting.binding
    );
    assert.equal(result.mergedSha, MERGE_SHA);
    assert.deepEqual(
      [...harness.closureCheckpoints.values.keys()],
      [checkpointDigest]
    );
    assert.equal(
      kernel.observedRoutes.filter((route) => route === "review.accept").length,
      1
    );
  } finally {
    harness.repository.cleanup();
  }
});

test("cost release failure prevents completion", async () => {
  const kernel = new FakeKernel();
  const harness = await engineeringHarness({ kernel });
  harness.costs.failRelease = true;
  try {
    const awaiting = await prepareHarnessHumanMerge(harness);
    await assert.rejects(
      resumeHarnessAfterHumanMerge(harness, awaiting.binding),
      /simulated release failure/u
    );
    assert.equal(harness.costs.releaseCalls, 1);
    assert.equal(kernel.observedRoutes.includes("review.accept"), false);
  } finally {
    harness.repository.cleanup();
  }
});

test("awaiting-checkpoint acknowledgement loss reuses the failure release", async () => {
  const harness = await engineeringHarness();
  harness.closureCheckpoints.failAwaitingAcknowledgementOnce = true;
  try {
    await assert.rejects(
      runEngineeringSlice(harness.input),
      /simulated lost awaiting-human-merge acknowledgement/u
    );
    const bindEffect = harness.github.effects.find(
      (effect) => effect.type === "bind-pull-request"
    );
    assert.ok(bindEffect?.type === "bind-pull-request");
    const bindObservation = harness.github.observations.get(digest(bindEffect));
    assert.ok(bindObservation);
    const currentBinding = rebindEngineeringPullRequest({
      binding: harness.input.binding,
      expectedBindingDigest: bindEffect.expectedBindingDigest,
      pullRequest: bindEffect.pullRequest,
      receiptHead: bindObservation.effectDigest
    });
    const awaiting =
      await harness.closureCheckpoints.readAwaitingHumanMerge(
        digest(currentBinding)
      );
    assert.ok(awaiting);
    assert.equal(harness.costs.releaseApplications, 1);
    await authenticateHarnessHumanMerge(harness, awaiting);

    const result = await resumeHarnessAfterHumanMerge(
      harness,
      awaiting.binding
    );
    assert.equal(result.mergedSha, MERGE_SHA);
    assert.equal(harness.costs.releaseCalls, 2);
    assert.equal(harness.costs.releaseApplications, 1);
  } finally {
    harness.repository.cleanup();
  }
});

test("lost cost release acknowledgement resumes from a discoverable signed checkpoint", async () => {
  let currentTime = NOW;
  const harness = await engineeringHarness({
    clock: { now: () => currentTime }
  });
  harness.costs.failReleaseAcknowledgementOnce = true;
  try {
    const awaiting = await prepareHarnessHumanMerge(harness);
    await assert.rejects(
      resumeHarnessAfterHumanMerge(harness, awaiting.binding),
      /simulated lost release acknowledgement/u
    );
    const pending = await harness.closureCheckpoints.readCostRelease(
      digest(awaiting.binding)
    );
    assert.ok(pending);
    assert.equal(pending.stage, "cost-release-pending");
    assert.equal(pending.costRelease, null);
    assert.equal(harness.costs.releaseApplications, 1);
    assert.equal(
      harness.github.effects.some((effect) => effect.type === "project-converge"),
      false
    );

    currentTime = "2026-08-26T12:00:02.000Z";
    const result = await resumeHarnessAfterHumanMerge(
      harness,
      awaiting.binding
    );
    assert.equal(result.mergedSha, MERGE_SHA);
    assert.equal(harness.costs.releaseCalls, 2);
    assert.equal(harness.costs.releaseApplications, 1);
    const released = await harness.closureCheckpoints.readCostRelease(
      digest(awaiting.binding)
    );
    assert.ok(released?.costRelease);
  } finally {
    harness.repository.cleanup();
  }
});

test("canonical binding rejects missing, duplicate, swapped, and stale PR identities", () => {
  const base = {
    repository: {
      id: 1,
      nodeId: "R_engineering",
      fullName: "example-organization/hyperfinite"
    },
    issue: { number: 2, nodeId: "I_engineering_slice" },
    projectOwnerNodeId: "O_github",
    projectNodeId: "PVT_synthetic_engineering",
    requesterActorId: "requester",
    automationActorId: "automation-app",
    receiptHead: digest({ receipt: 1 })
  } as const;
  assert.throws(
    () => bindEngineeringIntake({ ...base, projectItems: [] }),
    /exactly one Project item/u
  );
  assert.throws(
    () =>
      bindEngineeringIntake({
        ...base,
        projectItems: [
          {
            nodeId: "PVTI_synthetic_1",
            projectNodeId: "PVT_synthetic_engineering",
            contentNodeId: "I_engineering_slice"
          },
          {
            nodeId: "PVTI_synthetic_2",
            projectNodeId: "PVT_synthetic_engineering",
            contentNodeId: "I_engineering_slice"
          }
        ]
      }),
    /exactly one Project item/u
  );
  for (const projectItem of [
    {
      nodeId: "PVTI_synthetic_wrong",
      projectNodeId: "PVT_synthetic_other",
      contentNodeId: "I_engineering_slice"
    },
    {
      nodeId: "PVTI_synthetic_wrong",
      projectNodeId: "PVT_synthetic_engineering",
      contentNodeId: "I_other"
    }
  ]) {
    assert.throws(
      () => bindEngineeringIntake({ ...base, projectItems: [projectItem] }),
      /does not bind/u
    );
  }
  const binding = intake();
  const pull = {
    number: 5,
    nodeId: "PR_engineering",
    baseRepositoryId: 1,
    baseRef: "main",
    baseSha: BASE_SHA,
    headRepositoryId: 1,
    headRef: "agentic/issue-2",
    headSha: COMMIT_SHA
  };
  assert.throws(
    () =>
      rebindEngineeringPullRequest({
        binding,
        expectedBindingDigest: digest({ stale: true }),
        pullRequest: pull,
        receiptHead: digest({ receipt: 2 })
      }),
    /CAS precondition/u
  );
  const rebound = rebindEngineeringPullRequest({
    binding,
    expectedBindingDigest: digest(binding),
    pullRequest: pull,
    receiptHead: digest({ receipt: 2 })
  });
  assert.throws(
    () =>
      rebindEngineeringPullRequest({
        binding: rebound,
        expectedBindingDigest: digest(rebound),
        pullRequest: { ...pull, number: 6 },
        receiptHead: digest({ receipt: 3 })
      }),
    /CAS precondition/u
  );
});

test("single writer replays completed effects and fails closed on threat, CAS, and partial writes", async () => {
  const binding = intake();
  const signer = new FixtureSigner();
  const github = new FakeGitHub(binding, BASE_SHA);
  const broker = new FakeBroker(github);
  const store = new InMemoryEvidenceStore();
  const adapter = new EngineeringGitHubAdapter(
    broker,
    store,
    signer,
    signer
  );
  const effect = {
    type: "create-branch",
    ordinal: 1,
    repositoryId: 1,
    issueNodeId: "I_engineering_slice",
    baseRef: "main",
    baseSha: BASE_SHA,
    headRef: "agentic/issue-2"
  } as const;
  const freshness = await obtainTrustedExecutionTestFreshness({
    binding,
    workAccord: workAccord(),
    activationLeaseDigest: digest({ lease: "engineering" }),
    now: NOW
  });
  const common = await authorityBoundRequest(
    signer,
    effect,
    binding,
    freshness
  );
  const first = await executeAdapter(adapter, common, freshness);
  const second = await executeAdapter(adapter, common, freshness);
  assert.equal(first.status, "applied");
  assert.equal(second.status, "replayed");
  assert.equal(github.effects.length, 1);

  const blockedGithub = new FakeGitHub(binding, BASE_SHA);
  const blockedBroker = new FakeBroker(blockedGithub);
  const blocked = new EngineeringGitHubAdapter(
    blockedBroker,
    new InMemoryEvidenceStore(),
    signer,
    signer
  );
  const warning = await authorityBoundRequest(
    signer,
    effect,
    binding,
    freshness,
    "warning"
  );
  await assert.rejects(
    executeAdapter(blocked, warning, freshness),
    /THREAT_BLOCKED|exact-success/u
  );
  assert.equal(blockedBroker.calls, 0);

  const conflictStore = new InMemoryEvidenceStore();
  conflictStore.conflictNext = true;
  const conflict = new EngineeringGitHubAdapter(
    new FakeBroker(new FakeGitHub(binding, BASE_SHA)),
    conflictStore,
    signer,
    signer
  );
  assert.equal(Reflect.get(adapter, "executeWithFreshness"), undefined);
  assert.equal(Reflect.get(adapter, "observeHumanMergeWithFreshness"), undefined);
  await assert.rejects(
    executeAdapter(conflict, common, freshness),
    /CONCURRENCY_CONFLICT|another writer/u
  );

  const partialGitHub = new FakeGitHub(binding, BASE_SHA);
  partialGitHub.failAfterClaim = true;
  const partial = new EngineeringGitHubAdapter(
    new FakeBroker(partialGitHub),
    new InMemoryEvidenceStore(),
    signer,
    signer
  );
  await assert.rejects(
    executeAdapter(partial, common, freshness),
    /PARTIAL_EFFECT|effect failed after write attempt/u
  );
});

test("typed postconditions reject stable no-op observations for every effect family", async () => {
  for (const effectType of [
    "create-branch",
    "create-commit",
    "create-draft-pull-request",
    "bind-pull-request",
    "comment-review"
  ] as const) {
    const harness = await engineeringHarness();
    harness.github.observationMutator = (effect, observation) =>
      effect.type === effectType
        ? recanonicalizeObservation({
            ...observation,
            effectApplied: false
          })
        : observation;
    try {
      await assert.rejects(
        runEngineeringSlice(harness.input),
        /PARTIAL_EFFECT|postcondition|identity/u
      );
    } finally {
      harness.repository.cleanup();
    }
  }

  for (const effectType of [
    "project-converge",
    "close-issue",
    "record-delivery",
    "operations-handoff"
  ] as const) {
    const harness = await engineeringHarness();
    try {
      const awaiting = await prepareHarnessHumanMerge(harness);
      harness.github.observationMutator = (effect, observation) =>
        effect.type === effectType
          ? recanonicalizeObservation({
              ...observation,
              effectApplied: false
            })
          : observation;
      await assert.rejects(
        resumeHarnessAfterHumanMerge(harness, awaiting.binding),
        /PARTIAL_EFFECT|postcondition|identity/u
      );
    } finally {
      harness.repository.cleanup();
    }
  }
});

test("COMMENT and record completion require fresh resource-backed observations", async () => {
  const commentHarness = await engineeringHarness();
  commentHarness.github.observationMutator = (effect, observation) => {
    if (effect.type !== "comment-review" || observation.type !== effect.type) {
      return observation;
    }
    const { [observation.nodeId]: _removed, ...reviewComments } =
      observation.snapshot.reviewComments;
    return recanonicalizeObservation({
      ...observation,
      snapshot: { ...observation.snapshot, reviewComments }
    });
  };
  try {
    await assert.rejects(
      runEngineeringSlice(commentHarness.input),
      /COMMENT review postcondition differs/u
    );
  } finally {
    commentHarness.repository.cleanup();
  }

  for (const effectType of ["record-delivery", "operations-handoff"] as const) {
    const harness = await engineeringHarness();
    try {
      const awaiting = await prepareHarnessHumanMerge(harness);
      harness.github.observationMutator = (effect, observation) => {
        if (effect.type !== effectType || observation.type !== effect.type) {
          return observation;
        }
        if (observation.type === "record-delivery") {
          const { [observation.recordNodeId]: _removed, ...deliveryRecords } =
            observation.snapshot.deliveryRecords;
          return recanonicalizeObservation({
            ...observation,
            snapshot: { ...observation.snapshot, deliveryRecords }
          });
        }
        const { [observation.recordNodeId]: _removed, ...operationsRecords } =
          observation.snapshot.operationsRecords;
        return recanonicalizeObservation({
          ...observation,
          snapshot: { ...observation.snapshot, operationsRecords }
        });
      };
      await assert.rejects(
        resumeHarnessAfterHumanMerge(harness, awaiting.binding),
        /record postcondition differs/u
      );
    } finally {
      harness.repository.cleanup();
    }
  }
});

test("draft pull request creation evidence retains the authorized base SHA", async () => {
  const harness = await engineeringHarness();
  harness.github.observationMutator = (effect, observation) => {
    if (
      effect.type !== "create-draft-pull-request" ||
      observation.type !== effect.type
    ) {
      return observation;
    }
    return recanonicalizeObservation({
      ...observation,
      pullRequest: {
        ...observation.pullRequest,
        baseSha: "4444444444444444444444444444444444444444"
      }
    });
  };
  try {
    await assert.rejects(
      runEngineeringSlice(harness.input),
      /draft pull-request postcondition differs/u
    );
  } finally {
    harness.repository.cleanup();
  }
});

test("typed postconditions reject wrong targets for every effect family", async () => {
  for (const effectType of [
    "create-branch",
    "create-commit",
    "create-draft-pull-request",
    "bind-pull-request",
    "comment-review"
  ] as const) {
    const harness = await engineeringHarness();
    harness.github.observationMutator = (effect, observation) =>
      effect.type === effectType
        ? substituteObservationTarget(observation)
        : observation;
    try {
      await assert.rejects(
        runEngineeringSlice(harness.input),
        /PARTIAL_EFFECT|postcondition|differs/u
      );
    } finally {
      harness.repository.cleanup();
    }
  }

  for (const effectType of [
    "project-converge",
    "close-issue",
    "record-delivery",
    "operations-handoff"
  ] as const) {
    const harness = await engineeringHarness();
    try {
      const awaiting = await prepareHarnessHumanMerge(harness);
      harness.github.observationMutator = (effect, observation) =>
        effect.type === effectType
          ? substituteObservationTarget(observation)
          : observation;
      await assert.rejects(
        resumeHarnessAfterHumanMerge(harness, awaiting.binding),
        /PARTIAL_EFFECT|postcondition|differs/u
      );
    } finally {
      harness.repository.cleanup();
    }
  }
});

test("commit completion rejects no-op and wrong patch, tree, blob, or content", async () => {
  for (const attack of [
    "no-op",
    "patch",
    "tree",
    "git-tree",
    "blob",
    "content"
  ] as const) {
    const harness = await engineeringHarness();
    harness.github.observationMutator = (effect, observation) => {
      if (effect.type !== "create-commit" || observation.type !== effect.type) {
        return observation;
      }
      const changed =
        attack === "no-op"
          ? {
              ...observation,
              commitSha: observation.parentSha,
              snapshot: {
                ...observation.snapshot,
                branches: {
                  ...observation.snapshot.branches,
                  [observation.headRef]: observation.parentSha
                }
              }
            }
          : attack === "patch"
            ? { ...observation, patchDigest: digest({ wrong: "patch" }) }
            : attack === "tree"
              ? { ...observation, treeDigest: digest({ wrong: "tree" }) }
              : attack === "git-tree"
                ? { ...observation, gitTreeSha: "f".repeat(40) }
                : attack === "blob"
                  ? {
                      ...observation,
                      files: observation.files.map((file, index) =>
                        index === 0 ? { ...file, blobSha: "e".repeat(40) } : file
                      )
                    }
              : {
                  ...observation,
                  files: observation.files.map((file, index) =>
                    index === 0
                      ? { ...file, contentDigest: digest({ wrong: "content" }) }
                      : file
                  )
                };
      return recanonicalizeObservation(changed);
    };
    try {
      await assert.rejects(
        runEngineeringSlice(harness.input),
        /PARTIAL_EFFECT|commit tree, content, or patch/u
      );
    } finally {
      harness.repository.cleanup();
    }
  }
});

test("single writer retries a recorded pre-write rejection without poisoning the effect key", async () => {
  const binding = intake();
  const signer = new FixtureSigner();
  const github = new FakeGitHub(binding, BASE_SHA);
  github.failReadOnce = true;
  const store = new InMemoryEvidenceStore();
  const adapter = new EngineeringGitHubAdapter(
    new FakeBroker(github),
    store,
    signer,
    signer
  );
  const effect = {
    type: "create-branch",
    ordinal: 1,
    repositoryId: 1,
    issueNodeId: "I_engineering_slice",
    baseRef: "main",
    baseSha: BASE_SHA,
    headRef: "agentic/issue-2"
  } as const;
  const freshness = await obtainTrustedExecutionTestFreshness({
    binding,
    workAccord: workAccord(),
    activationLeaseDigest: digest({ lease: "engineering" }),
    now: NOW
  });
  const request = await authorityBoundRequest(
    signer,
    effect,
    binding,
    freshness
  );
  await assert.rejects(
    executeAdapter(adapter, request, freshness),
    /simulated pre-write read failure/u
  );
  const rejected = [...store.values.values()].at(-1);
  assert.equal(rejected?.state, "rejected");
  const retried = await executeAdapter(adapter, request, freshness);
  assert.equal(retried.status, "applied");
  assert.equal(github.effects.length, 1);
});

test("closure effects reconcile lost acknowledgements after a writer restart", async () => {
  const initial = intake();
  const binding = rebindEngineeringPullRequest({
    binding: initial,
    expectedBindingDigest: digest(initial),
    pullRequest: {
      number: 5,
      nodeId: "PR_engineering",
      baseRepositoryId: 1,
      baseRef: "main",
      baseSha: BASE_SHA,
      headRepositoryId: 1,
      headRef: "agentic/issue-2",
      headSha: COMMIT_SHA
    },
    receiptHead: digest({ receipt: "bound" })
  });
  const effects: readonly EngineeringDeliveryEffect[] = [
    {
      type: "project-converge",
      ordinal: 6,
      projectNodeId: binding.project.nodeId,
      projectItemNodeId: binding.project.itemNodeId,
      expectedStage: "human-review",
      stage: "completed",
      mergedSha: MERGE_SHA
    },
    {
      type: "close-issue",
      ordinal: 7,
      repositoryId: binding.repository.id,
      issueNumber: binding.issue.number,
      issueNodeId: binding.issue.nodeId,
      mergedSha: MERGE_SHA
    },
    {
      type: "record-delivery",
      ordinal: 8,
      bindingDigest: digest(binding),
      mergedSha: MERGE_SHA,
      verificationDigest: digest({ verification: "complete" })
    },
    {
      type: "operations-handoff",
      ordinal: 9,
      bindingDigest: digest(binding),
      mergedSha: MERGE_SHA,
      measurementPlanDigest: digest({ measurement: "operations" })
    }
  ];
  const signer = new FixtureSigner();
  const freshness = await obtainTrustedExecutionTestFreshness({
    binding,
    workAccord: workAccord(),
    activationLeaseDigest: digest({ lease: "engineering" }),
    now: NOW
  });
  const github = new FakeGitHub(initial, BASE_SHA);
  github.snapshot = {
    ...github.snapshot,
    pullRequest: {
      ...binding.pullRequest!,
      draft: false,
      open: false,
      merged: true,
      mergedSha: MERGE_SHA,
      mergedByActorId: "human-merger",
      mergedByHuman: true,
      mergedAt: NOW
    }
  };
  const store = new InMemoryEvidenceStore();

  for (const effect of effects) {
    const request = await authorityBoundRequest(
      signer,
      effect,
      binding,
      freshness
    );
    github.failAfterApplyType = effect.type;
    const firstWriter = new EngineeringGitHubAdapter(
      new FakeBroker(github),
      store,
      signer,
      signer
    );
    await assert.rejects(
      executeAdapter(firstWriter, request, freshness),
      /effect failed after write attempt/u
    );

    const restartedWriter = new EngineeringGitHubAdapter(
      new FakeBroker(github),
      store,
      signer,
      signer
    );
    const reconciled = await executeAdapter(
      restartedWriter,
      request,
      freshness
    );
    assert.equal(reconciled.status, "reconciled");
    assert.equal(
      github.effects.filter((candidate) => candidate.type === effect.type).length,
      1
    );
  }
});

test("repeatable effect keys reject workflow and contract substitutions", async () => {
  const initial = intake();
  const binding = rebindEngineeringPullRequest({
    binding: initial,
    expectedBindingDigest: digest(initial),
    pullRequest: {
      number: 5,
      nodeId: "PR_engineering",
      baseRepositoryId: 1,
      baseRef: "main",
      baseSha: BASE_SHA,
      headRepositoryId: 1,
      headRef: "agentic/issue-2",
      headSha: COMMIT_SHA
    },
    receiptHead: digest({ receipt: "bound" })
  });
  const effects: readonly EngineeringDeliveryEffect[] = [
    {
      type: "comment-review",
      ordinal: 5,
      repositoryId: 1,
      pullRequestNumber: 5,
      pullRequestNodeId: "PR_engineering",
      headSha: COMMIT_SHA,
      event: "COMMENT",
      body: "review"
    },
    {
      type: "record-delivery",
      ordinal: 8,
      bindingDigest: digest(binding),
      mergedSha: MERGE_SHA,
      verificationDigest: digest({ verification: 1 })
    },
    {
      type: "operations-handoff",
      ordinal: 9,
      bindingDigest: digest(binding),
      mergedSha: MERGE_SHA,
      measurementPlanDigest: digest({ measurement: 1 })
    }
  ];
  const accord = workAccord();
  const activationLeaseDigest = digest({ lease: "engineering" });
  const freshness = await obtainTrustedExecutionTestFreshness({
    binding,
    workAccord: accord,
    activationLeaseDigest,
    now: NOW
  });
  const revisedAccord: WorkAccord = {
    ...accord,
    identity: {
      ...accord.identity,
      id: "engineering-slice-r2",
      revision: 2,
      supersedes: accord.identity.id
    }
  };
  const substitutedFreshness = await Promise.all([
    obtainTrustedExecutionTestFreshness({
      binding,
      workAccord: accord,
      activationLeaseDigest,
      workflowId: "agentic-substituted-workflow",
      now: NOW
    }),
    obtainTrustedExecutionTestFreshness({
      binding,
      workAccord: revisedAccord,
      activationLeaseDigest,
      now: NOW
    }),
    obtainTrustedExecutionTestFreshness({
      binding,
      workAccord: accord,
      activationLeaseDigest,
      grantIdentity: "substituted-grant",
      now: NOW
    })
  ]);
  const signer = new FixtureSigner();
  for (const effect of effects) {
    const request = await authorityBoundRequest(
      signer,
      effect,
      binding,
      freshness
    );
    for (const substitution of substitutedFreshness) {
      const broker = new FakeBroker(new FakeGitHub(initial, BASE_SHA));
      const adapter = new EngineeringGitHubAdapter(
        broker,
        new InMemoryEvidenceStore(),
        signer,
        signer
      );
      await assert.rejects(
        executeAdapter(adapter, request, substitution),
        /AUTHORIZATION_INVALID|substituted/u
      );
      assert.equal(broker.calls, 0);
    }
    const consistentlySubstituted = {
      ...freshness,
      identity: {
        ...freshness.identity,
        executionGrantDigest: digest({ grant: "substituted" }),
        modelOutputDigest: digest({ modelOutput: "substituted" })
      }
    };
    const consistentlySubstitutedRequest = await authorityBoundRequest(
      signer,
      effect,
      binding,
      consistentlySubstituted
    );
    const broker = new FakeBroker(new FakeGitHub(initial, BASE_SHA));
    const adapter = new EngineeringGitHubAdapter(
      broker,
      new InMemoryEvidenceStore(),
      signer,
      signer
    );
    await assert.rejects(
      adapter.execute({
        ...consistentlySubstitutedRequest,
        ...consistentlySubstituted.identity,
        freshnessAuthority: freshness.authority,
        patchArtifactDigest: freshness.patchArtifactDigest,
        patchBundleDigest: freshness.patchBundleDigest,
        executionBundleDigest: freshness.executionBundleDigest
      }),
      /AUTHORIZATION_INVALID|exact policy/u
    );
    assert.equal(broker.calls, 0);
  }
});

test("persisted effect evidence cannot substitute its derived identity", async () => {
  const binding = intake();
  const effect: EngineeringDeliveryEffect = {
    type: "create-branch",
    ordinal: 1,
    repositoryId: binding.repository.id,
    issueNodeId: binding.issue.nodeId,
    headRef: "agentic/issue-2",
    baseRef: "main",
    baseSha: BASE_SHA
  };
  const signer = new FixtureSigner();
  const freshness = await obtainTrustedExecutionTestFreshness({
    binding,
    workAccord: workAccord(),
    activationLeaseDigest: digest({ lease: "engineering" }),
    now: NOW
  });
  const request = await authorityBoundRequest(
    signer,
    effect,
    binding,
    freshness
  );

  for (const substitution of [
    { effectKey: digest({ effectKey: "substituted" }) },
    { effectOrdinal: 2 },
    { effectType: "create-commit" as const },
    { workflowId: "substituted-workflow" },
    { contractRevision: 2 }
  ]) {
    const github = new FakeGitHub(binding, BASE_SHA);
    const store = new InMemoryEvidenceStore();
    const adapter = new EngineeringGitHubAdapter(
      new FakeBroker(github),
      store,
      signer,
      signer
    );
    await executeAdapter(adapter, request, freshness);
    const [key, evidence] = [...store.values.entries()][0] ?? [];
    assert.ok(key);
    assert.ok(evidence);
    const payload = { ...omitSignature(evidence), ...substitution };
    store.values.set(key, {
      ...payload,
      signature: await signer.sign(payload)
    });
    const replayBroker = new FakeBroker(github);
    const replay = new EngineeringGitHubAdapter(
      replayBroker,
      store,
      signer,
      signer
    );
    await assert.rejects(
      executeAdapter(replay, request, freshness),
      /persisted effect evidence (?:identity does not match|is invalid or conflicting)/u
    );
    assert.equal(replayBroker.calls, 0);
  }
});

test("adapter rejects a structural runtime freshness forgery before GitHub access", async () => {
  const binding = intake();
  const signer = new FixtureSigner();
  const broker = new FakeBroker(new FakeGitHub(binding, BASE_SHA));
  const adapter = new EngineeringGitHubAdapter(
    broker,
    new InMemoryEvidenceStore(),
    signer,
    signer
  );
  await assert.rejects(
    Reflect.apply(adapter.execute, adapter, [
      {
        freshnessAuthority: Object.freeze(Object.create(null))
      }
    ]),
    /freshness context is not bound to authenticated artifact consumption/u
  );
  assert.equal(broker.calls, 0);
});

test("gate signatures are artifact-specific and cannot authorize another phase", async () => {
  const signer = new FixtureSigner();
  const binding = intake();
  const approval = await authenticatedApproval({
    signer,
    binding,
    requesterId: "requester",
    automationActorId: "automation-app",
    actorId: "reviewer-1",
    permission: "write",
    gate: "accept-frame",
    artifactDigest: digest({ frame: 1 }),
    routeId: "framing.accept",
    snapshotDigest: digest({ snapshot: 1 }),
    workAccordDigest: digest(workAccord()),
    activationLeaseDigest: digest({ lease: 1 }),
    currentHead: null
  });
  const payload = omitSignature(approval);
  assert.equal(signer.verify(omitSignature(approval), approval.signature), true);
  validateArtifactApproval({
    approval,
    verifier: signer,
    gate: "accept-frame",
    artifactDigest: payload.artifactDigest,
    routeId: payload.routeId,
    snapshotDigest: payload.snapshotDigest,
    workAccordDigest: payload.workAccordDigest,
    activationLeaseDigest: payload.activationLeaseDigest,
    repositoryId: binding.repository.id,
    workItemNodeId: binding.issue.nodeId,
    currentHead: null,
    requesterId: "requester",
    automationActorId: "automation-app",
    controlPolicy: controlPolicy(),
    approverPolicy: workAccord().evidence.approverPolicy,
    now: NOW,
    maximumAgeMs: 300_000
  });

  const substituted = { ...approval, gate: "accept-plan" as const };
  assert.equal(
    signer.verify(omitSignature(substituted), substituted.signature),
    false
  );
  assert.throws(
    () =>
      validateArtifactApproval({
        approval: substituted,
        verifier: signer,
        gate: "accept-plan",
        artifactDigest: payload.artifactDigest,
        routeId: "planning.execute",
        snapshotDigest: payload.snapshotDigest,
        workAccordDigest: payload.workAccordDigest,
        activationLeaseDigest: payload.activationLeaseDigest,
        repositoryId: binding.repository.id,
        workItemNodeId: binding.issue.nodeId,
        currentHead: null,
        requesterId: "requester",
        automationActorId: "automation-app",
        controlPolicy: controlPolicy(),
        approverPolicy: workAccord().evidence.approverPolicy,
        now: NOW,
        maximumAgeMs: 300_000
      }),
    /APPROVAL_INVALID|substituted/u
  );
});

test("human gates require pre-issued authenticated independent GitHub evidence", async () => {
  const signer = new FixtureSigner();
  const binding = intake();
  const common = {
    signer,
    binding,
    requesterId: "requester",
    automationActorId: "automation-app",
    gate: "activate" as const,
    artifactDigest: digest(binding),
    routeId: "activation.begin-framing",
    snapshotDigest: digest(binding),
    workAccordDigest: digest(workAccord()),
    activationLeaseDigest: digest({ lease: 1 }),
    currentHead: null
  };
  for (const invalid of [
    { actorId: "review-bot", actorType: "Bot" as const, permission: "admin" as const },
    { actorId: "requester", actorType: "User" as const, permission: "admin" as const },
    { actorId: "automation-app", actorType: "App" as const, permission: "admin" as const },
    { actorId: "reader", actorType: "User" as const, permission: "read" as const }
  ]) {
    await assert.rejects(
      authenticatedApproval({ ...common, ...invalid }),
      /unauthenticated, automated, self-issued, or unauthorized/u
    );
  }

  const approval = await authenticatedApproval({
    ...common,
    actorId: "maintainer-1",
    actorType: "User",
    permission: "maintain"
  });
  const forged = { ...approval, actorId: "caller-selected-actor" };
  assert.throws(
    () =>
      validateArtifactApproval({
        approval: forged,
        verifier: signer,
        gate: "activate",
        artifactDigest: common.artifactDigest,
        routeId: common.routeId,
        snapshotDigest: common.snapshotDigest,
        workAccordDigest: common.workAccordDigest,
        activationLeaseDigest: common.activationLeaseDigest,
        repositoryId: binding.repository.id,
        workItemNodeId: binding.issue.nodeId,
        currentHead: null,
        requesterId: common.requesterId,
        automationActorId: common.automationActorId,
        controlPolicy: controlPolicy(),
        approverPolicy: workAccord().evidence.approverPolicy,
        now: NOW,
        maximumAgeMs: 300_000
      }),
    /APPROVAL_INVALID|not independent/u
  );

  const harness = await engineeringHarness();
  harness.input.services.humanGates.approvals.delete("activate");
  try {
    await assert.rejects(
      runEngineeringSlice(harness.input),
      /activate approval evidence is missing/u
    );
    assert.equal(harness.model.frameCalls, 0);
    assert.equal(harness.github.effects.length, 0);
  } finally {
    harness.repository.cleanup();
  }
});

test("human approvals require exact ControlPolicy role and Work Accord team eligibility", async () => {
  const signer = new FixtureSigner();
  const binding = intake();
  const baseAccord = workAccord();
  for (const policy of [
    {
      accord: baseAccord,
      roleIds: ["repository-maintainer"],
      teamNodeIds: ["TEAM_engineering"]
    },
    {
      accord: {
        ...baseAccord,
        evidence: { ...baseAccord.evidence, approverPolicy: "team:TEAM_engineering" }
      },
      roleIds: ["eligible-reviewer"],
      teamNodeIds: ["TEAM_wrong"]
    }
  ]) {
    await assert.rejects(
      authenticatedApproval({
        signer,
        binding,
      requesterId: "requester",
      automationActorId: "automation-app",
        actorId: "reviewer-two",
      actorType: "User",
      permission: "maintain",
      gate: "accept-frame",
        artifactDigest: digest({ frame: 1 }),
        routeId: "framing.plan",
        snapshotDigest: digest({ snapshot: 1 }),
        workAccordDigest: digest(policy.accord),
        activationLeaseDigest: digest({ lease: 1 }),
      currentHead: null,
        accord: policy.accord,
        roleIds: policy.roleIds,
        teamNodeIds: policy.teamNodeIds
      }),
      /unauthenticated, automated, self-issued, or unauthorized/u
    );
  }
});

test("cost reservation cannot be future-dated against trusted time", async () => {
  const signer = new FixtureSigner();
  const accord = workAccord();
  const ledger = new FakeCosts(signer);
  const reservation = await ledger.reserve({
    workAccordDigest: digest(accord),
    activationLeaseDigest: digest({ lease: 1 }),
    phaseBudgets: { framing: 10, execution: 20, verification: 10 },
    phaseTokenBudgets: PHASE_TOKEN_BUDGETS,
    maxCalls: 3,
    maxTokens: 1000,
    now: "2026-08-26T12:00:01.000Z",
    expiresAt: EXPIRES
  });
  assert.throws(
    () =>
      validateCostReservation({
        reservation,
        verifier: signer,
        workAccordDigest: digest(accord),
        activationLeaseDigest: digest({ lease: 1 }),
        phaseBudgets: { framing: 10, execution: 20, verification: 10 },
        phaseTokenBudgets: PHASE_TOKEN_BUDGETS,
        maxCalls: 3,
        maxTokens: 1000,
        now: NOW,
        maximumAgeMs: 300_000
      }),
    /stale, future-dated, or expired/u
  );
  const overdrawn = await ledger.reserve({
    workAccordDigest: digest(accord),
    activationLeaseDigest: digest({ lease: 1 }),
    phaseBudgets: { framing: 60, execution: 60, verification: 60 },
    phaseTokenBudgets: PHASE_TOKEN_BUDGETS,
    maxCalls: 3,
    maxTokens: 1000,
    now: NOW,
    expiresAt: EXPIRES
  });
  assert.throws(
    () =>
      validateCostReservation({
        reservation: overdrawn,
        verifier: signer,
        workAccordDigest: digest(accord),
        activationLeaseDigest: digest({ lease: 1 }),
        phaseBudgets: { framing: 60, execution: 60, verification: 60 },
        phaseTokenBudgets: PHASE_TOKEN_BUDGETS,
        maxCalls: 3,
        maxTokens: 1000,
        now: NOW,
        maximumAgeMs: 300_000
      }),
    /atomic, signed, or correctly bound/u
  );
  const offsetting = await ledger.reserve({
    workAccordDigest: digest(accord),
    activationLeaseDigest: digest({ lease: 1 }),
    phaseBudgets: { framing: 60, execution: -30, verification: 10 },
    phaseTokenBudgets: PHASE_TOKEN_BUDGETS,
    maxCalls: 3,
    maxTokens: 1000,
    now: NOW,
    expiresAt: EXPIRES
  });
  assert.throws(
    () =>
      validateCostReservation({
        reservation: offsetting,
        verifier: signer,
        workAccordDigest: digest(accord),
        activationLeaseDigest: digest({ lease: 1 }),
        phaseBudgets: { framing: 60, execution: -30, verification: 10 },
        phaseTokenBudgets: PHASE_TOKEN_BUDGETS,
        maxCalls: 3,
        maxTokens: 1000,
        now: NOW,
        maximumAgeMs: 300_000
      }),
    /atomic, signed, or correctly bound/u
  );
});

test("cost settlements bind the requested phase, usage, cost, and unique ledger position", async () => {
  const signer = new FixtureSigner();
  const accord = workAccord();
  const ledger = new FakeCosts(signer);
  const reservation = await ledger.reserve({
    workAccordDigest: digest(accord),
    activationLeaseDigest: digest({ lease: 1 }),
    phaseBudgets: { framing: 5, execution: 5, verification: 5 },
    now: NOW,
    expiresAt: EXPIRES
  });
  const usage = digest({ phase: "framing", usage: 1 });
  const settlement = await ledger.settle({
    reservation,
    phase: "framing",
    actualCostUnits: 1,
    providerUsageDigest: usage,
    now: NOW
  });
  const exact = {
    settlement,
    reservation,
    hold: ledger.holdFor("framing"),
    verifier: signer,
    priorEntries: ledger.priorEntriesFor("framing"),
    expectedPhase: "framing",
    expectedAttemptDigest: settlement.attemptDigest,
    expectedActualCostUnits: 1,
    expectedActualCalls: 1,
    expectedActualTokens: 1,
    expectedProviderUsageDigest: usage,
    now: NOW,
    maximumAgeMs: 300_000
  } as const;
  validateCostSettlement(exact);
  assert.throws(
    () => validateCostSettlement({ ...exact, expectedPhase: "execution" }),
    /cost settlement is invalid/u
  );
  assert.throws(
    () =>
      validateCostSettlement({
        ...exact,
        expectedActualCostUnits: 2
      }),
    /cost settlement is invalid/u
  );
  assert.throws(
    () =>
      validateCostSettlement({
        ...exact,
        expectedProviderUsageDigest: digest({ substituted: true })
      }),
    /cost settlement is invalid/u
  );
  await assert.rejects(
    ledger.settle({
      reservation,
      phase: "framing",
      actualCostUnits: 1,
      providerUsageDigest: digest({ phase: "framing", usage: 2 }),
      now: NOW
    }),
    /duplicate settlement conflict/u
  );
  assert.throws(
    () =>
      validateCostSettlement({
        ...exact,
        settlement,
        priorEntries: [...ledger.lineageEntries],
        expectedActualCostUnits: 1,
        expectedProviderUsageDigest: settlement.providerUsageDigest
      }),
    /cost settlement is invalid/u
  );
});

test("cost balance releases each reserved unit at most once across retry and crash", async () => {
  const signer = new FixtureSigner();
  const accord = workAccord();
  const reserve = async (ledger: FakeCosts) =>
    ledger.reserve({
      workAccordDigest: digest(accord),
      activationLeaseDigest: digest({ lease: "balance" }),
      phaseBudgets: { framing: 5, execution: 5, verification: 5 },
      now: NOW,
      expiresAt: EXPIRES
    });

  const underuseLedger = new FakeCosts(signer);
  const underuseReservation = await reserve(underuseLedger);
  const underuseSettlements: EngineeringCostSettlement[] = [];
  for (const phase of ["framing", "execution", "verification"] as const) {
    const usage = digest({ phase, actual: 1 });
    const settlement = await underuseLedger.settle({
      reservation: underuseReservation,
      phase,
      actualCostUnits: 1,
      providerUsageDigest: usage,
      now: NOW
    });
    validateCostSettlement({
      settlement,
      reservation: underuseReservation,
      hold: underuseLedger.holdFor(phase),
      verifier: signer,
      priorEntries: underuseLedger.priorEntriesFor(phase),
      expectedPhase: phase,
      expectedAttemptDigest: settlement.attemptDigest,
      expectedActualCostUnits: 1,
      expectedActualCalls: 1,
      expectedActualTokens: 1,
      expectedProviderUsageDigest: usage,
      now: NOW,
      maximumAgeMs: 300_000
    });
    underuseSettlements.push(settlement);
  }
  const underuseRelease = await underuseLedger.release({
    releaseIdempotencyKey: digest({ release: "underuse" }),
    reservation: underuseReservation,
    settledPhases: underuseSettlements,
    expectedOpenHoldDigests: [],
    now: NOW
  });
  validateCostRelease({
    release: underuseRelease,
    reservation: underuseReservation,
    settlements: underuseSettlements,
    knownOpenHolds: [],
    verifier: signer,
    now: NOW,
    maximumAgeMs: 300_000
  });
  const replayedRelease = await underuseLedger.release({
    releaseIdempotencyKey: digest({ release: "underuse" }),
    reservation: underuseReservation,
    settledPhases: underuseSettlements,
    expectedOpenHoldDigests: [],
    now: NOW
  });
  assert.equal(digest(replayedRelease), digest(underuseRelease));
  assert.equal(underuseRelease.previouslyReleasedCostUnits, 12);
  assert.equal(underuseRelease.releasedCostUnits, 0);
  assert.equal(underuseLedger.totalReleasedCostUnits, 12);
  assert.equal(underuseLedger.releaseApplications, 1);

  const exactLedger = new FakeCosts(signer);
  const exactReservation = await reserve(exactLedger);
  const exactSettlements: EngineeringCostSettlement[] = [];
  for (const phase of ["framing", "execution", "verification"] as const) {
    const usage = digest({ phase, actual: 5 });
    const settlement = await exactLedger.settle({
      reservation: exactReservation,
      phase,
      actualCostUnits: 5,
      providerUsageDigest: usage,
      now: NOW
    });
    validateCostSettlement({
      settlement,
      reservation: exactReservation,
      hold: exactLedger.holdFor(phase),
      verifier: signer,
      priorEntries: exactLedger.priorEntriesFor(phase),
      expectedPhase: phase,
      expectedAttemptDigest: settlement.attemptDigest,
      expectedActualCostUnits: 5,
      expectedActualCalls: 1,
      expectedActualTokens: 1,
      expectedProviderUsageDigest: usage,
      now: NOW,
      maximumAgeMs: 300_000
    });
    exactSettlements.push(settlement);
  }
  const exactRelease = await exactLedger.release({
    releaseIdempotencyKey: digest({ release: "exact" }),
    reservation: exactReservation,
    settledPhases: exactSettlements,
    expectedOpenHoldDigests: [],
    now: NOW
  });
  assert.equal(exactRelease.releasedCostUnits, 0);
  assert.equal(exactLedger.totalReleasedCostUnits, 0);

  const crashLedger = new FakeCosts(signer);
  const crashReservation = await reserve(crashLedger);
  const crashUsage = digest({ phase: "framing", actual: 1 });
  const crashSettlement = await crashLedger.settle({
    reservation: crashReservation,
    phase: "framing",
    actualCostUnits: 1,
    providerUsageDigest: crashUsage,
    now: NOW
  });
  validateCostSettlement({
    settlement: crashSettlement,
    reservation: crashReservation,
    hold: crashLedger.holdFor("framing"),
    verifier: signer,
    priorEntries: crashLedger.priorEntriesFor("framing"),
    expectedPhase: "framing",
    expectedAttemptDigest: crashSettlement.attemptDigest,
    expectedActualCostUnits: 1,
    expectedActualCalls: 1,
    expectedActualTokens: 1,
    expectedProviderUsageDigest: crashUsage,
    now: NOW,
    maximumAgeMs: 300_000
  });
  const crashRelease = await crashLedger.release({
    releaseIdempotencyKey: digest({ release: "crash" }),
    reservation: crashReservation,
    settledPhases: [crashSettlement],
    expectedOpenHoldDigests: [],
    now: NOW
  });
  validateCostRelease({
    release: crashRelease,
    reservation: crashReservation,
    settlements: [crashSettlement],
    knownOpenHolds: [],
    verifier: signer,
    now: NOW,
    maximumAgeMs: 300_000
  });
  assert.equal(crashRelease.previouslyReleasedCostUnits, 4);
  assert.equal(crashRelease.releasedCostUnits, 10);
  assert.equal(crashLedger.totalReleasedCostUnits, 14);

  const overdrawLedger = new FakeCosts(signer);
  const overdrawReservation = await reserve(overdrawLedger);
  const overdrawUsage = digest({ phase: "framing", actual: 6 });
  const overdraw = await overdrawLedger.settle({
    reservation: overdrawReservation,
    phase: "framing",
    actualCostUnits: 6,
    providerUsageDigest: overdrawUsage,
    now: NOW
  });
  assert.throws(
    () =>
      validateCostSettlement({
        settlement: overdraw,
        reservation: overdrawReservation,
        hold: overdrawLedger.holdFor("framing"),
        verifier: signer,
        priorEntries: overdrawLedger.priorEntriesFor("framing"),
        expectedPhase: "framing",
        expectedAttemptDigest: overdraw.attemptDigest,
        expectedActualCostUnits: 6,
        expectedActualCalls: 1,
        expectedActualTokens: 1,
        expectedProviderUsageDigest: overdrawUsage,
        now: NOW,
        maximumAgeMs: 300_000
      }),
    /COST_INVALID|phase budget/u
  );
});

test("phase reservation is bounded by the Work Accord before model execution", async () => {
  for (const phaseBudgets of [
    { framing: 20, execution: 20, verification: 20 },
    { framing: 60, execution: -30, verification: 10 },
    { framing: 0.5, execution: 0.5, verification: 0 }
  ]) {
    const harness = await engineeringHarness();
    try {
      await assert.rejects(
        runEngineeringSlice({
          ...harness.input,
          phaseBudgets
        }),
        /COST_INVALID|Work Accord cost ceiling/u
      );
      assert.equal(harness.model.frameCalls, 0);
      assert.equal(harness.costs.releaseCalls, 0);
    } finally {
      harness.repository.cleanup();
    }
  }
});
