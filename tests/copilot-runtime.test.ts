import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import * as publicApi from "../src/index.js";
import * as engineeringSliceDeepApi from "../src/engineering-slice.js";
import {
  bridgeRuntimeOutput,
  canonicalJson,
  consumeTrustedExecutionArtifact,
  consumeTrustedPatchArtifact,
  digest,
  EngineeringDraftPullRequestDeliveryPort,
  EngineeringEvidenceConflictError,
  EngineeringGitHubAdapter,
  githubLastPage,
  planCopilotRuntimeWireMigration,
  rebindEngineeringPullRequest,
  redeemRuntimeAuthorization,
  runTrustedExecutionBridge,
  runtimeAuthorizationCandidateDigest,
  runtimeAuthorizationDigest,
  runtimeAuthorizationSigningPayload,
  runtimeMaximumReservation,
  runtimeRedemptionKey,
  runtimeRedemptionLedgerHead,
  runtimeStateSigningPayload,
  validateRuntimeAuthorizationIntegrity,
  validateDocument,
  validateRuntimePreActivation,
  validateStableRuntimeStateObservation,
  verifyRuntimeAuthorizationSignature,
  verifyRuntimeStateSignature,
  workAccordBindingDigest,
  type CopilotRuntimePolicy,
  type CopilotRuntimeState,
  type EngineeringDeliveryEffect,
  type EngineeringEffectEvidence,
  type EngineeringEffectObservation,
  type EngineeringGitHubApi,
  type EngineeringGitHubSnapshot,
  type EngineeringWorkBinding,
  type Digest,
  type DetachedSignature,
  type GitHubSafeOutput,
  type KernelResult,
  type RuntimeActivationRequest,
  type RuntimeAuthorization,
  type RuntimeAuthorizationCandidate,
  type RuntimeAuthorizationRedeemer,
  type RuntimeAuthorizationVerifier,
  type TrustedExecutionDeliveryRequest,
  type TrustedGitHubBinding,
  type ValidatedPatch,
  type WorkAccord
} from "../src/index.js";

const NOW = "2026-08-26T12:00:00.000Z";
const LATER = "2026-08-26T13:00:00.000Z";
const clock = { now: () => NOW };

const policy = JSON.parse(
  await readFile("config/v1alpha1/copilot-runtime-policy.json", "utf8")
) as CopilotRuntimePolicy;
const kernelPolicy = JSON.parse(
  await readFile("config/v1alpha1/policy.json", "utf8")
) as Record<string, unknown>;
const engineeringAccord = JSON.parse(
  await readFile("examples/engineering/work-accord.json", "utf8")
) as WorkAccord;

const WORK_ACCORD_SOURCE_DIGEST = digest({ workAccordSource: 1 });
const D = {
  accord: digest({ accord: 1 }),
  policy: digest(policy),
  kernelPolicy: digest(kernelPolicy),
  lease: digest({ lease: 1 }),
  kernel: digest({ kernel: 1 }),
  kernelBinding: digest({
    repositoryId: 1001,
    sourceDigest: WORK_ACCORD_SOURCE_DIGEST,
    workItemNodeId: "PR_runtime"
  }),
  placeholder: digest({ placeholder: 1 }),
  projectBinding: digest({ projectBinding: 1 })
} as const;

function testCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZip(fileName: string, content: string): Buffer {
  const name = Buffer.from(fileName);
  const data = Buffer.from(content);
  const checksum = testCrc32(data);
  const local = Buffer.alloc(30 + name.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);
  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  name.copy(central, 46);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length + data.length, 16);
  return Buffer.concat([local, data, central, end]);
}

function sha256ArtifactArchive(archiveBytes: Uint8Array): `sha256:${string}` {
  // SHA-256 here binds artifact ZIP bytes; embedded verification key IDs are
  // public metadata rather than passwords or secrets.
  return `sha256:${createHash("sha256").update(archiveBytes).digest("hex")}`;
}

const binding: TrustedGitHubBinding = {
  repository: {
    id: 1001,
    nodeId: "R_runtime",
    owner: "example-organization",
    name: "hyperfinite",
    fullName: "example-organization/hyperfinite"
  },
  workItem: {
    kind: "pull-request",
    number: 6,
    nodeId: "PR_runtime",
    base: {
      repository: {
        id: 1001,
        nodeId: "R_runtime",
        owner: "example-organization",
        name: "hyperfinite",
        fullName: "example-organization/hyperfinite"
      },
      ref: "main",
      sha: "1111111111111111111111111111111111111111"
    },
    head: {
      repository: {
        id: 1001,
        nodeId: "R_runtime",
        owner: "example-organization",
        name: "hyperfinite",
        fullName: "example-organization/hyperfinite"
      },
      ref: "runtime",
      sha: "2222222222222222222222222222222222222222"
    }
  },
  project: {
    ownerNodeId: "O_runtime",
    projectNodeId: "PVT_synthetic_runtime",
    itemNodeId: "PVTI_synthetic_runtime",
    schemaDigest: digest({ projectSchema: 1 }),
    bindingDigest: D.projectBinding,
    fields: []
  },
  installation: {
    id: 2001,
    accountNodeId: "O_runtime",
    repositorySelection: "selected",
    repositoryIds: [1001]
  }
};

const state: CopilotRuntimeState = {
  apiVersion: "agentic-framework.github.com/v1alpha1",
  kind: "CopilotRuntimeState",
  schemaVersion: "2.0.0",
  repositoryId: 1001,
  repositoryFullName: "example-organization/hyperfinite",
  workItemNodeId: "PR_runtime",
  projectNodeId: "PVT_synthetic_runtime",
  projectItemNodeId: "PVTI_synthetic_runtime",
  bindingDigest: digest(binding),
  kernelBindingDigest: D.kernelBinding,
  workAccordSourceDigest: WORK_ACCORD_SOURCE_DIGEST,
  state: "VERIFYING",
  phase: "verification",
  role: "reviewer",
  capability: "core.review-current-head@1.0.0",
  contractRevision: 2,
  workAccordDigest: D.accord,
  policyDigest: D.policy,
  kernelPolicyDigest: D.kernelPolicy,
  activationLeaseDigest: D.lease,
  kernelReceiptDigest: D.kernel,
  kernelRouteId: "verification.review",
  workflowId: "agentic-review",
  activationNonce: "nonce_abcdefghijklmnopqrstuvwxyz012345",
  currentHead: "2222222222222222222222222222222222222222",
  executionContext: null,
  remainingAiCredits: 500,
  repairCount: 0,
  recursionDepth: 0,
  expiresAt: LATER,
  signature: {
    algorithm: "ed25519",
    keyId: "runtime-state-2026",
    value: "dGVzdA=="
  }
};

const request: RuntimeActivationRequest = {
  enabled: true,
  eventName: "issue_comment",
  eventAction: "created",
  actorId: 42,
  actorLogin: "maintainer",
  actorIsBot: false,
  actorPermission: "write",
  repositoryId: state.repositoryId,
  repositoryFullName: state.repositoryFullName,
  workItemKind: "pull-request",
  workItemNumber: 6,
  workItemNodeId: state.workItemNodeId,
  projectNodeId: state.projectNodeId,
  projectItemNodeId: state.projectItemNodeId,
  bindingDigest: state.bindingDigest,
  kernelBindingDigest: state.kernelBindingDigest,
  workAccordSourceDigest: state.workAccordSourceDigest,
  phase: state.phase,
  role: state.role,
  capability: state.capability,
  workflowId: state.workflowId,
  workflowRef:
    "example-organization/hyperfinite/.github/workflows/agentic-review.lock.yml@refs/heads/main",
  workflowSha: "1111111111111111111111111111111111111111",
  defaultBranch: "main",
  runId: 9001,
  runAttempt: 1,
  workAccordDigest: D.accord,
  policyDigest: D.policy,
  kernelPolicyDigest: D.kernelPolicy,
  activationLeaseDigest: D.lease,
  activationNonce: state.activationNonce,
  reservedAiCredits: 500,
  currentHead: state.currentHead
};

function evidence(
  stateOverride: Partial<CopilotRuntimeState> = {}
) {
  return {
    state: { ...state, ...stateOverride },
    stateSignatureVerified: true,
    stateAuthorApplicationId: 99,
    stateAuthorId: 100,
    expectedApplicationId: 99,
    expectedAuthorId: 100,
    allowedActorIds: [42],
    stateCommentId: 7001,
    stateCommentUpdatedAt: NOW,
    stateCollectionEtag: '"state-etag-1"'
  } as const;
}

function preAuthorize(
  requestOverride: Partial<RuntimeActivationRequest> = {},
  stateOverride: Partial<CopilotRuntimeState> = {}
): RuntimeAuthorizationCandidate {
  return validateRuntimePreActivation(
    policy,
    { ...request, ...requestOverride },
    evidence(stateOverride),
    kernelPolicy,
    clock
  );
}

function candidateWith(
  candidate: RuntimeAuthorizationCandidate,
  override: Partial<Omit<RuntimeAuthorizationCandidate, "candidateDigest">>
): RuntimeAuthorizationCandidate {
  const { candidateDigest: _candidateDigest, ...payload } = candidate;
  const updated = { ...payload, ...override };
  return {
    ...updated,
    candidateDigest: runtimeAuthorizationCandidateDigest(updated)
  };
}

const {
  privateKey: authorizationPrivateKey,
  publicKey: authorizationPublicKey
} = generateKeyPairSync("ed25519");
const authorizationKeyId = "runtime-redeemer-test";
const encodedAuthorizationPublicKey = authorizationPublicKey
  .export({ format: "der", type: "spki" })
  .toString("base64");
const authorizationVerifier: RuntimeAuthorizationVerifier = {
  verify: (authorization) =>
    verifyRuntimeAuthorizationSignature(
      authorization,
      authorizationKeyId,
      encodedAuthorizationPublicKey
    )
};

function signedAuthorization(
  candidate: RuntimeAuthorizationCandidate,
  override: Partial<RuntimeAuthorization> = {}
): RuntimeAuthorization {
  const remainingAiCreditsBefore =
    override.remainingAiCreditsBefore ?? candidate.remainingAiCredits;
  const remainingAiCreditsAfter =
    override.remainingAiCreditsAfter ??
    remainingAiCreditsBefore - candidate.reservedAiCredits;
  let draft: RuntimeAuthorization = {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "CopilotRuntimeAuthorization",
    schemaVersion: "2.0.0",
    authorizationDigest: D.placeholder,
    candidateDigest: candidate.candidateDigest,
    inputDigest: candidate.inputDigest,
    stateDigest: candidate.stateDigest,
    policyDigest: candidate.policyDigest,
    kernelPolicyDigest: candidate.kernelPolicyDigest,
    bindingDigest: candidate.bindingDigest,
    kernelBindingDigest: candidate.kernelBindingDigest,
    workAccordSourceDigest: candidate.workAccordSourceDigest,
    repositoryId: candidate.repositoryId,
    repositoryFullName: candidate.repositoryFullName,
    workItemKind: candidate.workItemKind,
    workItemNumber: candidate.workItemNumber,
    workItemNodeId: candidate.workItemNodeId,
    projectNodeId: candidate.projectNodeId,
    projectItemNodeId: candidate.projectItemNodeId,
    kernelReceiptDigest: candidate.kernelReceiptDigest,
    routeId: candidate.routeId,
    phase: candidate.phase,
    role: candidate.role,
    capability: candidate.capability,
    workflowId: candidate.workflowId,
    workflowRef: candidate.workflowRef,
    workflowSha: candidate.workflowSha,
    runId: candidate.runId,
    runAttempt: candidate.runAttempt,
    eventName: candidate.eventName,
    eventAction: candidate.eventAction,
    actorId: candidate.actorId,
    actorLogin: candidate.actorLogin,
    activationLeaseDigest: candidate.activationLeaseDigest,
    activationNonce: candidate.activationNonce,
    reservedAiCredits: candidate.reservedAiCredits,
    remainingAiCreditsBefore,
    remainingAiCreditsAfter,
    contractRevision: candidate.contractRevision,
    contractDigest: candidate.contractDigest,
    currentHead: candidate.currentHead,
    executionContext: candidate.executionContext,
    outputSchema:
      candidate.phase === "execution"
        ? "TargetFreePatch@1.0.0"
        : "GitHubSafeOutput@1.0.0",
    stateCommentId: candidate.stateCommentId,
    stateCommentUpdatedAt: candidate.stateCommentUpdatedAt,
    stateCollectionEtag: candidate.stateCollectionEtag,
    stateRevoked: false,
    leaseRevoked: false,
    projectBindingVerified: true,
    stateCheckedAt: NOW,
    leaseCheckedAt: NOW,
    redemptionKey: runtimeRedemptionKey(candidate),
    casResult: "appended",
    ledgerVersion: 1,
    ledgerHeadBefore: null,
    ledgerHeadAfter: D.placeholder,
    redeemedAt: NOW,
    expiresAt: candidate.expiresAt,
    redeemerServiceId: "test-redeemer",
    signature: {
      algorithm: "ed25519",
      keyId: authorizationKeyId,
      value: "dGVzdA=="
    },
    ...override
  };
  draft = {
    ...draft,
    ledgerHeadAfter: runtimeRedemptionLedgerHead(draft)
  };
  draft = {
    ...draft,
    authorizationDigest: runtimeAuthorizationDigest(draft)
  };
  const signature = sign(
    null,
    Buffer.from(canonicalJson(runtimeAuthorizationSigningPayload(draft))),
    authorizationPrivateKey
  ).toString("base64");
  return {
    ...draft,
    signature: { ...draft.signature, value: signature }
  };
}

function authorizedExecutionKernelContext(
  candidate: RuntimeAuthorizationCandidate,
  options: {
    readonly grantedCapability?: string;
    readonly routeId?: string;
    readonly kernelPolicyDigest?: Digest;
  } = {}
): {
  readonly authorization: RuntimeAuthorization;
  readonly kernelResult: Extract<KernelResult, { readonly kind: "applied" }>;
} {
  const routeId = options.routeId ?? "planning.execute";
  const effects = [
    { type: "emit-receipt", eventId: "execution-kernel-event-1" },
    {
      type: "enter-phase",
      phase: "execution",
      capabilities: [
        {
          reference:
            options.grantedCapability ?? "core.execute-bounded-change@1.0.0",
          actorClasses: ["system"],
          humanGates: ["accept-plan"],
          readScopes: ["repository-content"],
          tools: [],
          shellCommands: ["git"],
          networkDestinations: [],
          mcpTools: [],
          riskClass: "moderate",
          privacyClass: "internal",
          limits: {
            maxCalls: 1,
            maxCostUnits: 10,
            timeoutMs: 600000,
            maxRetries: 0,
            maxOutputBytes: 262144,
            maxConcurrency: 1,
            parallelSafe: false
          },
          evidence: ["validated-patch-digest"],
          structuralEvaluations: ["schema-valid", "target-free"],
          behavioralEvaluations: []
        }
      ]
    }
  ] satisfies Extract<KernelResult, { readonly kind: "applied" }>["effects"];
  const appliedPolicyDigest =
    options.kernelPolicyDigest ?? candidate.kernelPolicyDigest;
  const eventDigest = digest({ event: "execution-kernel-event-1" });
  const idempotencyKey = digest({ idempotency: "execution-kernel-event-1" });
  const receipt = {
    schemaVersion: "1.0.0",
    eventId: "execution-kernel-event-1",
    eventDigest,
    routeId,
    routeVersion: "1.0.0",
    from: "PLANNED",
    to: "EXECUTING",
    stateVersion: 3,
    previousReceipt: null,
    idempotencyKey,
    replacementAuthorityDigest: null,
    bindingDigest: candidate.kernelBindingDigest,
    lifecycleGraphDigest: digest({ graph: "execution" }),
    workAccordDigest: candidate.contractDigest,
    capabilityRegistryDigest: digest({ registry: "execution" }),
    domainPackDigest: digest({ domainPack: "execution" }),
    destinationBindingDigest: candidate.kernelBindingDigest,
    destinationLifecycleGraphDigest: digest({ graph: "execution" }),
    destinationWorkAccordDigest: candidate.contractDigest,
    destinationCapabilityRegistryDigest: digest({ registry: "execution" }),
    destinationDomainPackDigest: digest({ domainPack: "execution" }),
    sourcePhaseContractDigest: digest({ phase: "planning" }),
    sourceCompiledPolicyDigest: digest({ compiled: "planning" }),
    destinationPhaseContractDigest: digest({ phase: "execution" }),
    destinationCompiledPolicyDigest: digest({ compiled: "execution" }),
    policyDigest: appliedPolicyDigest,
    destinationPolicyDigest: appliedPolicyDigest,
    actorId: "runtime-adapter",
    actorAuthorizationDigest: digest({ actor: "runtime-adapter" }),
    occurredAt: NOW,
    effectPlanDigest: digest(effects)
  } satisfies Extract<KernelResult, { readonly kind: "applied" }>["receipt"];
  const receiptDigest = digest(receipt);
  const boundCandidate = candidateWith(candidate, {
    kernelReceiptDigest: receiptDigest
  });
  const authorization = signedAuthorization(boundCandidate);
  const route = {
    id: routeId,
    version: "1.0.0",
    from: "PLANNED",
    to: "EXECUTING",
    event: "execution-authorized",
    actorClasses: ["system"],
    phaseOwner: "execution",
    costBearing: true,
    humanGate: "accept-plan",
    retryable: false,
    maxAttempts: 1
  } satisfies Extract<KernelResult, { readonly kind: "applied" }>["route"];
  const snapshot = {
    schemaVersion: "1.0.0",
    lifecycleVersion: "1.0.0",
    lifecycleGraphDigest: receipt.destinationLifecycleGraphDigest,
    state: "EXECUTING",
    phaseOwner: "execution",
    stateVersion: receipt.stateVersion,
    lastEventSequence: 3,
    bindingDigest: authorization.kernelBindingDigest,
    workAccordDigest: authorization.contractDigest,
    capabilityRegistryDigest: receipt.destinationCapabilityRegistryDigest,
    domainPackDigest: receipt.destinationDomainPackDigest,
    phaseContractDigest: receipt.destinationPhaseContractDigest,
    compiledPolicyDigest: receipt.destinationCompiledPolicyDigest,
    policyDigest: receipt.destinationPolicyDigest,
    currentHead:
      authorization.currentHead === null ? null : digest(authorization.currentHead),
    receiptHead: receiptDigest,
    suspendedState: null,
    recoveryState: null,
    usage: { calls: 1, tokens: 1, costUnits: 1, loops: 0, retries: 0 },
    phaseUsage: { calls: 1, tokens: 1, costUnits: 1, loops: 0, retries: 0 },
    routeAttempts: {},
    processedEvents: {
      [receipt.eventId]: {
        eventDigest,
        receiptDigest,
        idempotencyKey,
        deliveryId: "execution-delivery-1"
      }
    }
  } satisfies Extract<KernelResult, { readonly kind: "applied" }>["snapshot"];
  return {
    authorization,
    kernelResult: {
      kind: "applied",
      route,
      snapshot,
      receipt,
      receiptDigest,
      effects
    }
  };
}

class AtomicRedeemer implements RuntimeAuthorizationRedeemer {
  readonly consumedNonces = new Set<string>();
  readonly consumedRuns = new Set<string>();
  remaining = 500;
  ledgerVersion = 0;
  ledgerHead: Digest | null = null;
  unavailable = false;
  leaseRevoked = false;
  stateRevoked = false;
  casConflict = false;

  async redeem(candidate: RuntimeAuthorizationCandidate): Promise<unknown> {
    if (this.unavailable) throw new TypeError("redeemer unavailable");
    if (this.leaseRevoked) throw new TypeError("lease revoked");
    if (this.stateRevoked) throw new TypeError("state revoked");
    if (this.casConflict) throw new TypeError("redemption CAS conflict");
    const run = `${candidate.workflowId}:${candidate.runId}:${candidate.runAttempt}`;
    if (
      this.consumedNonces.has(candidate.activationNonce) ||
      this.consumedRuns.has(run)
    ) {
      throw new TypeError("runtime redemption replay");
    }
    if (this.remaining < candidate.reservedAiCredits) {
      throw new TypeError("redemption budget exhausted");
    }
    const before = this.remaining;
    this.remaining -= candidate.reservedAiCredits;
    this.ledgerVersion += 1;
    this.consumedNonces.add(candidate.activationNonce);
    this.consumedRuns.add(run);
    const authorization = signedAuthorization(candidate, {
      remainingAiCreditsBefore: before,
      remainingAiCreditsAfter: this.remaining,
      ledgerVersion: this.ledgerVersion,
      ledgerHeadBefore: this.ledgerHead
    });
    this.ledgerHead = authorization.ledgerHeadAfter;
    return authorization;
  }
}

test("pre-activation binds default-branch workflow, actor, state, and full cost", () => {
  const candidate = preAuthorize();
  assert.equal(candidate.routeId, state.kernelRouteId);
  assert.equal(candidate.capability, state.capability);
  assert.equal(candidate.kernelReceiptDigest, state.kernelReceiptDigest);
  assert.equal(candidate.workflowId, "agentic-review");
  assert.equal(candidate.runId, 9001);
  assert.equal(candidate.runAttempt, 1);
  assert.equal(candidate.reservedAiCredits, 500);
  assert.equal(runtimeMaximumReservation(policy), 500);
});

test("signed execution context drives one closed patch through the trusted delivery port", async () => {
  assert.equal(
    "issuePolicyBoundFreshnessContext" in publicApi,
    false,
    "public API must not expose freshness capability issuance"
  );
  assert.equal(
    "issuePolicyBoundFreshnessContext" in engineeringSliceDeepApi,
    false,
    "deep module API must not expose freshness capability issuance"
  );
  assert.equal("executeEngineeringGitHubEffect" in publicApi, false);
  assert.equal("executeAuthenticatedRuntimeGitHubEffect" in publicApi, false);
  assert.equal("observeEngineeringHumanMerge" in publicApi, false);
  assert.equal("executeEngineeringGitHubEffect" in engineeringSliceDeepApi, false);
  assert.equal(
    "executeAuthenticatedRuntimeGitHubEffect" in engineeringSliceDeepApi,
    false
  );
  assert.equal("issueAuthenticatedArtifactConsumptionProof" in publicApi, false);
  assert.equal("observeEngineeringHumanMerge" in engineeringSliceDeepApi, false);
  if (false) {
    // @ts-expect-error Freshness capability issuance is not part of the public API.
    void publicApi.issuePolicyBoundFreshnessContext;
    // @ts-expect-error Deep imports cannot issue freshness capabilities either.
    void engineeringSliceDeepApi.issuePolicyBoundFreshnessContext;
    // @ts-expect-error Caller-clock adapter wrappers are not public API.
    void publicApi.executeEngineeringGitHubEffect;
    // @ts-expect-error Caller-clock merge wrappers are not deep API.
    void engineeringSliceDeepApi.observeEngineeringHumanMerge;
  }
  const planningArtifact = {
    schemaVersion: "1.0.0",
    steps: ["Update the authorized example slot."],
    targetSlots: ["example-output"],
    verificationIds: ["git-diff-check"]
  } as const;
  const grant = {
    repositoryId: engineeringAccord.binding.repositoryId,
    workItemNodeId: engineeringAccord.binding.workItemNodeId,
    workAccordDigest: digest(engineeringAccord),
    activationLeaseDigest: D.lease,
    snapshotDigest: digest({ snapshot: "planning" }),
    routeId: "planning.execute",
    baseSha: "1111111111111111111111111111111111111111",
    targets: [
      {
        slot: "example-output",
        path: "examples/engineering/workspace/bridge.txt",
        operation: "create",
        expectedDigest: null,
        expectedMode: "100644",
        maxBytes: 1024
      }
    ],
    verificationCommandIds: ["git-diff-check"],
    maxFiles: 1,
    maxPatchBytes: 1024,
    maxTurns: 1,
    maxCostUnits: 10,
    expiresAt: LATER
  } as const;
  const executionContext = {
    schemaVersion: "1.0.0",
    planningArtifact,
    planningArtifactDigest: digest(planningArtifact),
    canonicalWorkAccord: canonicalJson(engineeringAccord),
    canonicalExecutionGrant: canonicalJson(grant),
    executionGrantDigest: digest(grant),
    patchSchema: "TargetFreePatch@1.0.0"
  } as const;
  const deliveryBinding: EngineeringWorkBinding = {
    schemaVersion: "1.0.0",
    revision: 1,
    repository: {
      id: engineeringAccord.binding.repositoryId,
      nodeId: "R_engineering",
      fullName: "example-organization/hyperfinite"
    },
    issue: {
      number: 2,
      nodeId: engineeringAccord.binding.workItemNodeId
    },
    requesterActorId: "requester",
    automationActorId: "automation-app",
    project: {
      ownerNodeId: "O_github",
      nodeId: state.projectNodeId,
      itemNodeId: state.projectItemNodeId,
      contentNodeId: engineeringAccord.binding.workItemNodeId
    },
    pullRequest: null,
    previousBindingDigest: null,
    receiptHead: digest({ receipt: "engineering-intake" })
  };
  assert.throws(
    () =>
      preAuthorize(
        {
          repositoryId: engineeringAccord.binding.repositoryId,
          workItemKind: "issue",
          workItemNumber: 2,
          workItemNodeId: engineeringAccord.binding.workItemNodeId,
          phase: "execution",
          role: "executor",
          capability: "core.execute-bounded-change@1.0.0",
          workflowId: "agentic-execution",
          workflowRef:
            "example-organization/hyperfinite/.github/workflows/agentic-execution.lock.yml@refs/heads/main",
          bindingDigest: digest(deliveryBinding),
          kernelBindingDigest: workAccordBindingDigest(engineeringAccord),
          workAccordSourceDigest: engineeringAccord.binding.sourceDigest,
          workAccordDigest: digest(engineeringAccord),
          currentHead: null
        },
        {
          repositoryId: engineeringAccord.binding.repositoryId,
          workItemNodeId: engineeringAccord.binding.workItemNodeId,
          bindingDigest: digest(deliveryBinding),
          kernelBindingDigest: workAccordBindingDigest(engineeringAccord),
          workAccordSourceDigest: engineeringAccord.binding.sourceDigest,
          state: "EXECUTING",
          phase: "execution",
          role: "executor",
          capability: "core.execute-bounded-change@1.0.0",
          workAccordDigest: digest(engineeringAccord),
          contractRevision: engineeringAccord.identity.revision + 1,
          kernelRouteId: "planning.execute",
          workflowId: "agentic-execution",
          currentHead: null,
          executionContext
        }
      ),
    /revision/u
  );
  const executionCandidate = preAuthorize(
    {
      repositoryId: engineeringAccord.binding.repositoryId,
      workItemKind: "issue",
      workItemNumber: 2,
      workItemNodeId: engineeringAccord.binding.workItemNodeId,
      phase: "execution",
      role: "executor",
      capability: "core.execute-bounded-change@1.0.0",
      workflowId: "agentic-execution",
      workflowRef:
        "example-organization/hyperfinite/.github/workflows/agentic-execution.lock.yml@refs/heads/main",
      bindingDigest: digest(deliveryBinding),
      kernelBindingDigest: workAccordBindingDigest(engineeringAccord),
      workAccordSourceDigest: engineeringAccord.binding.sourceDigest,
      workAccordDigest: digest(engineeringAccord),
      currentHead: null
    },
    {
      repositoryId: engineeringAccord.binding.repositoryId,
      workItemNodeId: engineeringAccord.binding.workItemNodeId,
      bindingDigest: digest(deliveryBinding),
      kernelBindingDigest: workAccordBindingDigest(engineeringAccord),
      workAccordSourceDigest: engineeringAccord.binding.sourceDigest,
      state: "EXECUTING",
      phase: "execution",
      role: "executor",
      capability: "core.execute-bounded-change@1.0.0",
      workAccordDigest: digest(engineeringAccord),
      contractRevision: engineeringAccord.identity.revision,
      kernelRouteId: "planning.execute",
      workflowId: "agentic-execution",
      currentHead: null,
      executionContext
    }
  );
  const { authorization, kernelResult } =
    authorizedExecutionKernelContext(executionCandidate);
  const expectedPatch: ValidatedPatch = {
    baseSha: grant.baseSha,
    patch: "diff",
    patchDigest: digest("diff"),
    treeDigest: digest([
      {
        path: "examples/engineering/workspace/bridge.txt",
        digest: digest(Buffer.from("content\n").toString("base64")),
        mode: "100644"
      }
    ]),
    gitTreeSha: "2222222222222222222222222222222222222222",
    files: [
      {
        slot: "example-output",
        path: "examples/engineering/workspace/bridge.txt",
        operation: "create",
        beforeDigest: null,
        afterDigest: digest(Buffer.from("content\n").toString("base64")),
        bytes: 8,
        mode: "100644"
      }
    ],
    verification: [
      {
        commandId: "git-diff-check",
        stdoutDigest: digest(""),
        stderrDigest: digest("")
      }
    ]
  };
  let deliveries = 0;
  const envelope = {
    schemaVersion: "1.0.0",
    planningArtifactDigest: executionContext.planningArtifactDigest,
    executionGrantDigest: executionContext.executionGrantDigest,
    patch: {
      schemaVersion: "1.0.0",
      summary: "Update the example.",
      changes: [{ slot: "example-output", content: "content\n" }]
    }
  } as const;
  const evidenceSigner = {
    async sign(payload: unknown): Promise<DetachedSignature> {
      return {
        algorithm: "ed25519",
        keyId: authorizationKeyId,
        value: sign(
          null,
          Buffer.from(canonicalJson(payload)),
          authorizationPrivateKey
        ).toString("base64")
      };
    }
  };
  const evidenceVerifier = {
    verify(payload: unknown, signature: DetachedSignature): boolean {
      return (
        signature.keyId === authorizationKeyId &&
        verify(
          null,
          Buffer.from(canonicalJson(payload)),
          authorizationPublicKey,
          Buffer.from(signature.value, "base64")
        )
      );
    }
  };
  const threatPayload = {
    status: "success",
    authorizationDigest: authorization.authorizationDigest,
    modelOutputDigest: digest(envelope),
    kernelReceiptDigest: authorization.kernelReceiptDigest,
    checkedAt: NOW,
    expiresAt: authorization.expiresAt
  } as const;
  const threatEvidence = {
    ...threatPayload,
    signature: await evidenceSigner.sign(threatPayload)
  };
  const bridgeEvidence = {
    threatEvidenceValue: threatEvidence,
    evidenceSigner,
    evidenceVerifier
  } as const;
  const result = await runTrustedExecutionBridge({
    repositoryPath: ".",
    authorizationValue: authorization,
    authorizationVerifier,
    kernelResult,
    runtimePolicyValue: policy,
    controlPolicyValue: kernelPolicy,
    envelopeValue: envelope,
    clock,
    ...bridgeEvidence,
    executePatch: (input) => {
      assert.deepEqual(input.grant.targets, grant.targets);
      assert.deepEqual(input.patch, envelope.patch);
      return expectedPatch;
    },
    handoff: {
      async persist(bundle) {
        deliveries += 1;
        assert.equal(
          bundle.authorization.authorizationDigest,
          authorization.authorizationDigest
        );
        assert.equal(bundle.artifact.patchDigest, expectedPatch.patchDigest);
        assert.equal(bundle.artifact.patch, expectedPatch.patch);
        assert.equal(bundle.artifact.kernelProofDigest, digest(kernelResult));
        return { status: "persisted" as const };
      }
    }
  });
  assert.equal(deliveries, 1);
  assert.equal(result.handoff.status, "persisted");
  await assert.rejects(
    Reflect.apply(publicApi.consumeTrustedExecutionBundle, null, [
      {
        bundleValue: result.bundle,
        authorizationVerifier,
        evidenceVerifier,
        runtimePolicyValue: policy,
        controlPolicyValue: kernelPolicy,
        clock,
        artifactConsumptionProof: Object.freeze({}),
        delivery: {
          async deliver() {
            throw new Error("forged artifact proof reached delivery");
          }
        }
      }
    ]),
    /execution bundle lacks authenticated artifact consumption/u
  );

  const serializedBundle = canonicalJson(result.bundle);
  const artifactArchive = storedZip(
    "agentic-execution-bundle.json",
    `${serializedBundle}\n`
  );
  const artifactRequest: TrustedExecutionDeliveryRequest = {
    schemaVersion: "1.0.0",
    repositoryId: authorization.repositoryId,
    repositoryFullName: authorization.repositoryFullName,
    workflowRef: authorization.workflowRef,
    workflowSha: authorization.workflowSha,
    runId: authorization.runId,
    runAttempt: authorization.runAttempt,
    artifactId: 77,
    artifactName: `agentic-execution-bundle-${authorization.runId}-${authorization.runAttempt}`,
    artifactArchiveDigest: sha256ArtifactArchive(artifactArchive),
    bundleDigest: digest(result.bundle)
  };
  let boundaryDeliveries = 0;
  let genuineFreshnessAuthority: unknown;
  const boundaryResult = await consumeTrustedPatchArtifact({
    authorizationValue: authorization,
    authorizationVerifier,
    kernelResult,
    runtimePolicyValue: policy,
    controlPolicyValue: kernelPolicy,
    artifactValue: result.artifact,
    patchBundleValue: result.bundle.patchBundle,
    threatEvidenceValue: threatEvidence,
    evidenceVerifier,
    clock: { now: () => "2026-08-26T12:05:00.000Z" },
    delivery: {
      async deliver(input) {
        boundaryDeliveries += 1;
        genuineFreshnessAuthority = input.freshnessAuthority;
        return "boundary-valid";
      }
    }
  });
  assert.equal(boundaryResult, "boundary-valid");
  assert.equal(boundaryDeliveries, 1);
  assert.equal(
    Object.getPrototypeOf(genuineFreshnessAuthority as object),
    null
  );
  assert.equal(
    Reflect.get(genuineFreshnessAuthority as object, "constructor"),
    undefined
  );
  const immutableAuthority = Reflect.apply(
    publicApi.assertTrustedExecutionFreshnessAuthority,
    null,
    [genuineFreshnessAuthority]
  );
  assert.equal(Object.isFrozen(immutableAuthority), true);
  assert.equal(Object.isFrozen(immutableAuthority.clock), true);
  assert.equal(Object.isFrozen(immutableAuthority.evidence), true);
  await assert.rejects(
    consumeTrustedPatchArtifact({
      authorizationValue: authorization,
      authorizationVerifier,
      kernelResult,
      runtimePolicyValue: policy,
      controlPolicyValue: kernelPolicy,
      artifactValue: result.artifact,
      patchBundleValue: result.bundle.patchBundle,
      threatEvidenceValue: threatEvidence,
      evidenceVerifier,
      clock: { now: () => "2026-08-26T12:05:00.001Z" },
      delivery: {
        async deliver() {
          throw new Error("policy-expired evidence reached delivery");
        }
      }
    }),
    /stale/u
  );
  let delayedDeliveryClockReads = 0;
  let delayedDeliveries = 0;
  await assert.rejects(
    consumeTrustedPatchArtifact({
      authorizationValue: authorization,
      authorizationVerifier,
      kernelResult,
      runtimePolicyValue: policy,
      controlPolicyValue: kernelPolicy,
      artifactValue: result.artifact,
      patchBundleValue: result.bundle.patchBundle,
      threatEvidenceValue: threatEvidence,
      evidenceVerifier,
      clock: {
        now: () =>
          delayedDeliveryClockReads++ === 0
            ? NOW
            : "2026-08-26T12:05:00.001Z"
      },
      delivery: {
        async deliver() {
          delayedDeliveries += 1;
          return "unexpected-delivery";
        }
      }
    }),
    /stale/u
  );
  assert.equal(delayedDeliveries, 0);
  const staleArtifactPayload = {
    ...result.artifact,
    createdAt: "2026-08-26T11:54:59.999Z",
    signature: undefined
  };
  const { signature: _staleArtifactSignature, ...unsignedStaleArtifact } =
    staleArtifactPayload;
  await assert.rejects(
    consumeTrustedPatchArtifact({
      authorizationValue: authorization,
      authorizationVerifier,
      kernelResult,
      runtimePolicyValue: policy,
      controlPolicyValue: kernelPolicy,
      artifactValue: {
        ...unsignedStaleArtifact,
        signature: await evidenceSigner.sign(unsignedStaleArtifact)
      },
      patchBundleValue: result.bundle.patchBundle,
      threatEvidenceValue: threatEvidence,
      evidenceVerifier,
      clock,
      delivery: {
        async deliver() {
          throw new Error("mismatched-age patch artifact reached delivery");
        }
      }
    }),
    /validated patch artifact is stale/u
  );
  const stalePatchBundlePayload = {
    ...result.bundle.patchBundle,
    createdAt: "2026-08-26T11:54:59.999Z",
    signature: undefined
  };
  const { signature: _stalePatchBundleSignature, ...unsignedStalePatchBundle } =
    stalePatchBundlePayload;
  await assert.rejects(
    consumeTrustedPatchArtifact({
      authorizationValue: authorization,
      authorizationVerifier,
      kernelResult,
      runtimePolicyValue: policy,
      controlPolicyValue: kernelPolicy,
      artifactValue: result.artifact,
      patchBundleValue: {
        ...unsignedStalePatchBundle,
        signature: await evidenceSigner.sign(unsignedStalePatchBundle)
      },
      threatEvidenceValue: threatEvidence,
      evidenceVerifier,
      clock,
      delivery: {
        async deliver() {
          throw new Error("mismatched-age signed patch bundle reached delivery");
        }
      }
    }),
    /signed patch bundle is stale/u
  );
  const staleOuterPayload = {
    ...result.bundle,
    createdAt: "2026-08-26T11:54:59.999Z",
    signature: undefined
  };
  const { signature: _staleOuterSignature, ...unsignedStaleOuter } =
    staleOuterPayload;
  const staleOuterBundle = {
    ...unsignedStaleOuter,
    signature: await evidenceSigner.sign(unsignedStaleOuter)
  };
  const staleOuterArchive = storedZip(
    "agentic-execution-bundle.json",
    `${canonicalJson(staleOuterBundle)}\n`
  );
  await assert.rejects(
    consumeTrustedExecutionArtifact({
      request: {
        ...artifactRequest,
        artifactArchiveDigest: sha256ArtifactArchive(staleOuterArchive),
        bundleDigest: digest(staleOuterBundle)
      },
      identity: {
        repositoryId: artifactRequest.repositoryId,
        repositoryFullName: artifactRequest.repositoryFullName,
        workflowRef: artifactRequest.workflowRef,
        workflowSha: artifactRequest.workflowSha,
        runId: artifactRequest.runId,
        runAttempt: artifactRequest.runAttempt
      },
      downloader: {
        async download() {
          return {
            repositoryId: artifactRequest.repositoryId,
            artifactId: artifactRequest.artifactId,
            artifactName: artifactRequest.artifactName,
            runId: artifactRequest.runId,
            runAttempt: artifactRequest.runAttempt,
            archiveBytes: staleOuterArchive
          };
        }
      },
      authorizationVerifier,
      evidenceVerifier,
      runtimePolicyValue: policy,
      controlPolicyValue: kernelPolicy,
      clock,
      delivery: {
        async deliver() {
          throw new Error("mismatched-age bundle reached delivery");
        }
      }
    }),
    /execution bundle is stale/u
  );
  let deliverySnapshot: EngineeringGitHubSnapshot = {
    canonicalBindingDigest: digest(deliveryBinding),
    repositoryId: deliveryBinding.repository.id,
    repositoryNodeId: deliveryBinding.repository.nodeId,
    repositoryFullName: deliveryBinding.repository.fullName,
    issueNumber: deliveryBinding.issue.number,
    issueNodeId: deliveryBinding.issue.nodeId,
    projectOwnerNodeId: deliveryBinding.project.ownerNodeId,
    projectNodeId: deliveryBinding.project.nodeId,
    projectItemNodeId: deliveryBinding.project.itemNodeId,
    defaultBranch: { ref: "trunk", sha: grant.baseSha },
    branches: { trunk: grant.baseSha },
    pullRequest: null,
    projectStage: "executing",
    issueClosed: false,
    reviewComments: {},
    deliveryRecords: {},
    operationsRecords: {}
  };
  let persistedBinding = deliveryBinding;
  const effects: EngineeringDeliveryEffect[] = [];
  const observations = new Map<string, EngineeringEffectObservation>();
  let failDraftAcknowledgementOnce = true;
  const observed = (
    value: Readonly<Record<string, unknown>> & {
      readonly snapshot: EngineeringGitHubSnapshot;
    }
  ): EngineeringEffectObservation => {
    const { snapshot: _snapshot, ...canonical } = value;
    return {
      ...value,
      effectApplied: true,
      effectDigest: digest({ ...canonical, effectApplied: true })
    } as EngineeringEffectObservation;
  };
  const api: EngineeringGitHubApi = {
    async readSnapshot() {
      return deliverySnapshot;
    },
    async applyEffect(effect, patchBundle) {
      effects.push(effect);
      let observation: EngineeringEffectObservation;
      switch (effect.type) {
        case "create-branch":
          deliverySnapshot = {
            ...deliverySnapshot,
            branches: {
              ...deliverySnapshot.branches,
              [effect.headRef]: effect.baseSha
            }
          };
          observation = observed({
            type: effect.type,
            nodeId: `effect-${effect.ordinal}`,
            repositoryId: effect.repositoryId,
            baseSha: effect.baseSha,
            headRef: effect.headRef,
            headSha: effect.baseSha,
            snapshot: deliverySnapshot
          });
          break;
        case "create-commit": {
          if (patchBundle === null) {
            throw new TypeError("commit effect omitted its signed patch bundle");
          }
          const exactBundle = patchBundle;
          const commitSha = createHash("sha1")
            .update(canonicalJson({ effect, patchBundle: exactBundle }))
            .digest("hex");
          deliverySnapshot = {
            ...deliverySnapshot,
            branches: {
              ...deliverySnapshot.branches,
              [effect.headRef]: commitSha
            }
          };
          observation = observed({
            type: effect.type,
            nodeId: `effect-${effect.ordinal}`,
            repositoryId: effect.repositoryId,
            headRef: effect.headRef,
            parentSha: effect.parentSha,
            commitSha,
            gitTreeSha: exactBundle.gitTreeSha,
            patchDigest: exactBundle.patchDigest,
            treeDigest: exactBundle.treeDigest,
            files: exactBundle.files.map((file) => ({
              path: file.path,
              blobSha: file.gitBlobSha,
              contentDigest: file.afterDigest,
              mode: file.mode
            })),
            snapshot: deliverySnapshot
          });
          break;
        }
        case "create-draft-pull-request": {
          const pullRequest = {
            number: 14,
            nodeId: "PR_workflow_delivery",
            baseRepositoryId: effect.baseRepositoryId,
            baseRef: effect.baseRef,
            baseSha: effect.baseSha,
            headRepositoryId: effect.headRepositoryId,
            headRef: effect.headRef,
            headSha: effect.headSha,
            draft: true
          } as const;
          deliverySnapshot = {
            ...deliverySnapshot,
            pullRequest: {
              ...pullRequest,
              open: true,
              merged: false,
              mergedSha: null,
              mergedByActorId: null,
              mergedByHuman: false,
              mergedAt: null
            }
          };
          observation = observed({
            type: effect.type,
            nodeId: `effect-${effect.ordinal}`,
            pullRequest,
            snapshot: deliverySnapshot
          });
          break;
        }
        case "bind-pull-request":
          observation = observed({
            type: effect.type,
            nodeId: `effect-${effect.ordinal}`,
            expectedBindingDigest: effect.expectedBindingDigest,
            pullRequest: effect.pullRequest,
            receiptHead: effect.receiptHead,
            snapshot: deliverySnapshot
          });
          persistedBinding = rebindEngineeringPullRequest({
            binding: deliveryBinding,
            expectedBindingDigest: effect.expectedBindingDigest,
            pullRequest: effect.pullRequest,
            receiptHead: observation.effectDigest
          });
          deliverySnapshot = {
            ...deliverySnapshot,
            canonicalBindingDigest: digest(persistedBinding)
          };
          break;
        default:
          throw new TypeError(`unexpected delivery effect ${effect.type}`);
      }
      observations.set(digest(effect), observation);
      if (
        effect.type === "create-draft-pull-request" &&
        failDraftAcknowledgementOnce
      ) {
        failDraftAcknowledgementOnce = false;
        throw new Error("simulated lost draft acknowledgement");
      }
      return observation;
    },
    async observeEffect(effect) {
      const observation = observations.get(digest(effect));
      return observation === undefined
        ? null
        : {
            ...observation,
            snapshot:
              effect.type === "create-draft-pull-request"
                ? deliverySnapshot
                : observation.snapshot
          };
    }
  };
  const evidenceValues = new Map<string, EngineeringEffectEvidence>();
  let advanceConcreteClockOnBindingRead = false;
  let concreteNow = "2026-08-26T12:04:00.000Z";
  const concreteClock = { now: () => concreteNow };
  const deliveryEvidenceTimes: string[] = [];
  const adapter = new EngineeringGitHubAdapter(
    {
      async withApiForEffect(_effectType, operation) {
        return operation(api);
      }
    },
    {
      async read(effectKey) {
        return evidenceValues.get(effectKey) ?? null;
      },
      async conditionalAppend(expected, evidence) {
        const current = evidenceValues.get(evidence.effectKey) ?? null;
        if (
          (current === null) !== (expected === null) ||
          (current !== null &&
            expected !== null &&
            digest(current) !== digest(expected))
        ) {
          throw new EngineeringEvidenceConflictError();
        }
        evidenceValues.set(evidence.effectKey, evidence);
      }
    },
    evidenceSigner,
    evidenceVerifier
  );
  for (const forgedFreshness of [
    {
      clock: concreteClock,
      maxEvidenceAgeMs: 300_000
    },
    Object.freeze({
      clock: concreteClock,
      maxEvidenceAgeMs: 300_000,
      assertFresh() {
        throw new Error("forged freshness callback must not execute");
      }
    }),
    Object.freeze({
      clock: { now: () => "2020-01-01T00:00:00.000Z" },
      maxEvidenceAgeMs: 300_000,
      assertFresh() {
        throw new Error("forged freshness callback must not execute");
      }
    })
  ]) {
    await assert.rejects(
      Reflect.apply(adapter.execute, adapter, [
        { freshnessAuthority: forgedFreshness }
      ]),
      /freshness context is not bound to authenticated artifact consumption/u
    );
  }
  const delivery = new EngineeringDraftPullRequestDeliveryPort(
    {
      async resolve() {
        return deliveryBinding;
      },
      async readCurrent() {
        if (advanceConcreteClockOnBindingRead) {
          concreteNow = "2026-08-26T12:05:00.001Z";
        }
        return persistedBinding;
      }
    },
    adapter,
    {
      async issue(input) {
        deliveryEvidenceTimes.push(input.now);
        const payload = {
          workflowId: input.workflowId,
          contractRevision: input.contractRevision,
          workAccordDigest: input.workAccordDigest,
          activationLeaseDigest: input.activationLeaseDigest,
          executionGrantDigest: input.executionGrantDigest,
          bindingDigest: digest(input.binding),
          effectType: input.effect.type,
          effectOrdinal: input.effect.ordinal,
          planDigest: digest(input.effect),
          currentHead: input.binding.pullRequest?.headSha ?? null,
          kernelReceiptDigest: input.kernelReceiptDigest,
          issuedAt: input.now,
          expiresAt: authorization.expiresAt
        } as const;
        return {
          authorizationDigest: digest(payload),
          ...payload,
          signature: await evidenceSigner.sign(payload)
        };
      }
    },
    {
      async scan(input) {
        deliveryEvidenceTimes.push(input.now);
        const payload = {
          status: "success",
          authorizationDigest: input.authorizationDigest,
          modelOutputDigest: input.modelOutputDigest,
          kernelReceiptDigest: input.kernelReceiptDigest,
          checkedAt: input.now,
          expiresAt: authorization.expiresAt
        } as const;
        return { ...payload, signature: await evidenceSigner.sign(payload) };
      }
    }
  );
  const identity = {
    repositoryId: authorization.repositoryId,
    repositoryFullName: authorization.repositoryFullName,
    workflowRef: authorization.workflowRef,
    workflowSha: authorization.workflowSha,
    runId: authorization.runId,
    runAttempt: authorization.runAttempt
  };
  const exactDownload = {
    repositoryId: artifactRequest.repositoryId,
    artifactId: artifactRequest.artifactId,
    artifactName: artifactRequest.artifactName,
    runId: artifactRequest.runId,
    runAttempt: artifactRequest.runAttempt,
    archiveBytes: artifactArchive
  } as const;
  let refusedDownloads = 0;
  const refusingDownloader = {
    async download() {
      refusedDownloads += 1;
      return exactDownload;
    }
  };
  if (false) {
    void consumeTrustedExecutionArtifact({
      request: artifactRequest,
      identity,
      downloader: refusingDownloader,
      authorizationVerifier,
      evidenceVerifier,
      runtimePolicyValue: policy,
      controlPolicyValue: kernelPolicy,
      clock,
      // @ts-expect-error The runtime policy is the only evidence-age authority.
      maximumEvidenceAgeMs: 600_000,
      delivery
    });
    void new EngineeringGitHubAdapter(
      {
        async withApiForEffect(_effectType, operation) {
          return operation(api);
        }
      },
      {
        async read() {
          return null;
        },
        async conditionalAppend() {}
      },
      evidenceSigner,
      evidenceVerifier,
      // @ts-expect-error The adapter no longer accepts a caller clock or evidence age.
      concreteClock,
      600_000
    );
    void new EngineeringDraftPullRequestDeliveryPort(
      {
        async resolve() {
          return deliveryBinding;
        },
        async readCurrent() {
          return persistedBinding;
        }
      },
      adapter,
      {
        async issue() {
          throw new Error("type-only");
        }
      },
      {
        async scan() {
          throw new Error("type-only");
        }
      },
      // @ts-expect-error Concrete delivery receives policy-bound freshness per delivery.
      concreteClock
    );
  }
  assert.throws(
    () =>
      Reflect.construct(EngineeringGitHubAdapter, [
        {},
        {},
        evidenceSigner,
        evidenceVerifier,
        concreteClock,
        600_000
      ]),
    /freshness must come from a validated runtime-policy context/u
  );
  assert.throws(
    () =>
      Reflect.construct(EngineeringDraftPullRequestDeliveryPort, [
        {},
        adapter,
        {},
        {},
        concreteClock
      ]),
    /freshness must come from the validated runtime policy/u
  );
  await assert.rejects(
    Reflect.apply(consumeTrustedExecutionArtifact, undefined, [{
      request: artifactRequest,
      identity,
      downloader: refusingDownloader,
      authorizationVerifier,
      evidenceVerifier,
      runtimePolicyValue: policy,
      controlPolicyValue: kernelPolicy,
      clock,
      maximumEvidenceAgeMs: 600_000,
      delivery
    }]),
    /caller-controlled evidence age/u
  );
  assert.equal(refusedDownloads, 0);
  await assert.rejects(
    consumeTrustedExecutionArtifact({
      request: artifactRequest,
      identity,
      downloader: refusingDownloader,
      authorizationVerifier,
      evidenceVerifier,
      runtimePolicyValue: {
        ...policy,
        limits: { ...policy.limits, maxEvidenceAgeMs: 600_000 }
      },
      controlPolicyValue: kernelPolicy,
      clock,
      delivery
    }),
    /CopilotRuntimePolicy/u
  );
  assert.equal(refusedDownloads, 0);
  await assert.rejects(
    consumeTrustedExecutionArtifact({
      request: {
        ...artifactRequest,
        workflowSha: "3333333333333333333333333333333333333333"
      },
      identity: {
        ...identity,
        workflowSha: "3333333333333333333333333333333333333333"
      },
      downloader: { async download() { return exactDownload; } },
      authorizationVerifier,
      evidenceVerifier,
      runtimePolicyValue: policy,
      controlPolicyValue: kernelPolicy,
      clock: concreteClock,
      delivery
    }),
    /bundle authorization is not bound to the authenticated workflow run/u
  );
  await assert.rejects(
    consumeTrustedExecutionArtifact({
      request: {
        ...artifactRequest,
        bundleDigest: digest({ bundle: "substituted" })
      },
      identity,
      downloader: { async download() { return exactDownload; } },
      authorizationVerifier,
      evidenceVerifier,
      runtimePolicyValue: policy,
      controlPolicyValue: kernelPolicy,
      clock: concreteClock,
      delivery
    }),
    /exact canonical signed artifact/u
  );
  await assert.rejects(
    consumeTrustedExecutionArtifact({
      request: artifactRequest,
      identity,
      downloader: {
        async download() {
          return { ...exactDownload, artifactId: artifactRequest.artifactId + 1 };
        }
      },
      authorizationVerifier,
      evidenceVerifier,
      runtimePolicyValue: policy,
      controlPolicyValue: kernelPolicy,
      clock: concreteClock,
      delivery
    }),
    /downloaded artifact identity/u
  );
  const substitutedArchive = Buffer.from(artifactArchive);
  substitutedArchive[35] = (substitutedArchive[35] ?? 0) ^ 1;
  await assert.rejects(
    consumeTrustedExecutionArtifact({
      request: artifactRequest,
      identity,
      downloader: {
        async download() {
          return { ...exactDownload, archiveBytes: substitutedArchive };
        }
      },
      authorizationVerifier,
      evidenceVerifier,
      runtimePolicyValue: policy,
      controlPolicyValue: kernelPolicy,
      clock: concreteClock,
      delivery
    }),
    /downloaded artifact identity/u
  );
  assert.equal(effects.length, 0);
  advanceConcreteClockOnBindingRead = true;
  concreteNow = "2026-08-26T12:04:00.000Z";
  await assert.rejects(
    consumeTrustedExecutionArtifact({
      request: artifactRequest,
      identity,
      downloader: { async download() { return exactDownload; } },
      authorizationVerifier,
      evidenceVerifier,
      runtimePolicyValue: policy,
      controlPolicyValue: kernelPolicy,
      clock: concreteClock,
      delivery
    }),
    /evidence is stale, future-dated, or expired/u
  );
  advanceConcreteClockOnBindingRead = false;
  concreteNow = "2026-08-26T12:05:00.000Z";
  evidenceValues.clear();
  assert.equal(effects.length, 0);
  const initialDeliverySnapshot = deliverySnapshot;
  deliverySnapshot = {
    ...deliverySnapshot,
    defaultBranch: {
      ...deliverySnapshot.defaultBranch,
      sha: "9999999999999999999999999999999999999999"
    }
  };
  await assert.rejects(
    consumeTrustedExecutionArtifact({
      request: artifactRequest,
      identity,
      downloader: { async download() { return exactDownload; } },
      authorizationVerifier,
      evidenceVerifier,
      runtimePolicyValue: policy,
      controlPolicyValue: kernelPolicy,
      clock: concreteClock,
      delivery
    }),
    /default-branch base or pull-request state changed before delivery/u
  );
  assert.equal(effects.length, 0);
  deliverySnapshot = initialDeliverySnapshot;
  await assert.rejects(
    consumeTrustedExecutionArtifact({
      request: artifactRequest,
      identity,
      downloader: { async download() { return exactDownload; } },
      authorizationVerifier,
      evidenceVerifier,
      runtimePolicyValue: policy,
      controlPolicyValue: kernelPolicy,
      clock: concreteClock,
      delivery
    }),
    /effect failed after write attempt/u
  );
  assert.equal(persistedBinding.pullRequest, null);
  assert.deepEqual(
    [...evidenceValues.values()].map((evidence) => evidence.updatedAt),
    [
      "2026-08-26T12:05:00.000Z",
      "2026-08-26T12:05:00.000Z",
      "2026-08-26T12:05:00.000Z"
    ]
  );
  const pendingDraftSnapshot = deliverySnapshot;
  assert.notEqual(pendingDraftSnapshot.pullRequest, null);
  if (pendingDraftSnapshot.pullRequest === null) {
    throw new TypeError("lost acknowledgement omitted the created draft pull request");
  }
  deliverySnapshot = {
    ...pendingDraftSnapshot,
    defaultBranch: {
      ...pendingDraftSnapshot.defaultBranch,
      sha: "6666666666666666666666666666666666666666"
    },
    pullRequest: {
      ...pendingDraftSnapshot.pullRequest,
      baseSha: "6666666666666666666666666666666666666666"
    }
  };
  await assert.rejects(
    consumeTrustedExecutionArtifact({
      request: artifactRequest,
      identity,
      downloader: { async download() { return exactDownload; } },
      authorizationVerifier,
      evidenceVerifier,
      runtimePolicyValue: policy,
      controlPolicyValue: kernelPolicy,
      clock: concreteClock,
      delivery
    }),
    /default-branch base or pull-request state changed before delivery/u
  );
  assert.equal(effects.length, 3);
  deliverySnapshot = pendingDraftSnapshot;
  const delivered = await consumeTrustedExecutionArtifact({
    request: artifactRequest,
    identity,
    downloader: {
      async download() {
        return exactDownload;
      }
    },
    authorizationVerifier,
    evidenceVerifier,
    runtimePolicyValue: policy,
    controlPolicyValue: kernelPolicy,
    clock: concreteClock,
    delivery
  });
  assert.deepEqual(
    effects.map((effect) => effect.type),
    [
      "create-branch",
      "create-commit",
      "create-draft-pull-request",
      "bind-pull-request"
    ]
  );
  assert.equal(deliverySnapshot.pullRequest?.draft, true);
  assert.equal(delivered.pullRequest.baseRef, "trunk");
  assert.equal(delivered.pullRequest.headSha, delivered.headSha);
  assert.notEqual(delivered.headSha, grant.baseSha);
  assert.equal(delivered.binding.pullRequest?.nodeId, "PR_workflow_delivery");
  assert.ok(deliveryEvidenceTimes.includes("2026-08-26T12:05:00.000Z"));
  assert.ok(!deliveryEvidenceTimes.includes("2026-08-26T12:04:00.000Z"));
  deliverySnapshot = {
    ...deliverySnapshot,
    defaultBranch: {
      ...deliverySnapshot.defaultBranch,
      sha: "4444444444444444444444444444444444444444"
    },
    pullRequest:
      deliverySnapshot.pullRequest === null
        ? null
        : {
            ...deliverySnapshot.pullRequest,
            baseSha: "4444444444444444444444444444444444444444"
          }
  };
  const replayed = await consumeTrustedExecutionArtifact({
    request: artifactRequest,
    identity,
    downloader: { async download() { return exactDownload; } },
    authorizationVerifier,
    evidenceVerifier,
    runtimePolicyValue: policy,
    controlPolicyValue: kernelPolicy,
    clock: concreteClock,
    delivery
  });
  assert.equal(replayed.headSha, delivered.headSha);
  assert.equal(effects.length, 4);

  const exactAdvancedSnapshot = deliverySnapshot;
  const exactPullRequest = exactAdvancedSnapshot.pullRequest;
  assert.notEqual(exactPullRequest, null);
  if (exactPullRequest === null) {
    throw new TypeError("delivery replay omitted the bound pull request");
  }
  const replaySubstitutions: readonly {
    readonly name: string;
    readonly snapshot: EngineeringGitHubSnapshot;
  }[] = [
    {
      name: "canonical binding digest",
      snapshot: {
        ...exactAdvancedSnapshot,
        canonicalBindingDigest: digest({ binding: "other" })
      }
    },
    {
      name: "pull-request repository",
      snapshot: {
        ...exactAdvancedSnapshot,
        repositoryId: exactAdvancedSnapshot.repositoryId + 1
      }
    },
    {
      name: "repository node",
      snapshot: {
        ...exactAdvancedSnapshot,
        repositoryNodeId: `${exactAdvancedSnapshot.repositoryNodeId}_other`
      }
    },
    {
      name: "repository full name",
      snapshot: {
        ...exactAdvancedSnapshot,
        repositoryFullName: "github/other"
      }
    },
    {
      name: "issue number",
      snapshot: {
        ...exactAdvancedSnapshot,
        issueNumber: exactAdvancedSnapshot.issueNumber + 1
      }
    },
    {
      name: "issue node",
      snapshot: {
        ...exactAdvancedSnapshot,
        issueNodeId: `${exactAdvancedSnapshot.issueNodeId}_other`
      }
    },
    {
      name: "Project owner",
      snapshot: {
        ...exactAdvancedSnapshot,
        projectOwnerNodeId: `${exactAdvancedSnapshot.projectOwnerNodeId}_other`
      }
    },
    {
      name: "Project node",
      snapshot: {
        ...exactAdvancedSnapshot,
        projectNodeId: `${exactAdvancedSnapshot.projectNodeId}_other`
      }
    },
    {
      name: "Project item",
      snapshot: {
        ...exactAdvancedSnapshot,
        projectItemNodeId: `${exactAdvancedSnapshot.projectItemNodeId}_other`
      }
    },
    {
      name: "missing Project item",
      snapshot: {
        ...exactAdvancedSnapshot,
        projectItemNodeId: ""
      }
    },
    {
      name: "pull-request number",
      snapshot: {
        ...exactAdvancedSnapshot,
        pullRequest: { ...exactPullRequest, number: exactPullRequest.number + 1 }
      }
    },
    {
      name: "pull-request node",
      snapshot: {
        ...exactAdvancedSnapshot,
        pullRequest: { ...exactPullRequest, nodeId: `${exactPullRequest.nodeId}_other` }
      }
    },
    {
      name: "base repository",
      snapshot: {
        ...exactAdvancedSnapshot,
        pullRequest: {
          ...exactPullRequest,
          baseRepositoryId: exactPullRequest.baseRepositoryId + 1
        }
      }
    },
    {
      name: "base ref",
      snapshot: {
        ...exactAdvancedSnapshot,
        pullRequest: { ...exactPullRequest, baseRef: "other-base" }
      }
    },
    {
      name: "head repository",
      snapshot: {
        ...exactAdvancedSnapshot,
        pullRequest: {
          ...exactPullRequest,
          headRepositoryId: exactPullRequest.headRepositoryId + 1
        }
      }
    },
    {
      name: "head ref",
      snapshot: {
        ...exactAdvancedSnapshot,
        pullRequest: { ...exactPullRequest, headRef: "other-head" }
      }
    },
    {
      name: "head sha",
      snapshot: {
        ...exactAdvancedSnapshot,
        pullRequest: {
          ...exactPullRequest,
          headSha: "5555555555555555555555555555555555555555"
        }
      }
    },
    {
      name: "draft state",
      snapshot: {
        ...exactAdvancedSnapshot,
        pullRequest: { ...exactPullRequest, draft: false }
      }
    },
    {
      name: "open state",
      snapshot: {
        ...exactAdvancedSnapshot,
        pullRequest: { ...exactPullRequest, open: false }
      }
    }
  ];
  for (const substitution of replaySubstitutions) {
    deliverySnapshot = substitution.snapshot;
    await assert.rejects(
      consumeTrustedExecutionArtifact({
        request: artifactRequest,
        identity,
        downloader: { async download() { return exactDownload; } },
        authorizationVerifier,
        evidenceVerifier,
        runtimePolicyValue: policy,
        controlPolicyValue: kernelPolicy,
        clock: concreteClock,
        delivery
      }),
      /fresh GitHub|fresh pull-request|draft pull request no longer matches|effect observation aggregate|postcondition/u,
      substitution.name
    );
  }
  deliverySnapshot = exactAdvancedSnapshot;
  assert.equal(effects.length, 4);

  const exactPersistedBinding = persistedBinding;
  persistedBinding = deliveryBinding;
  deliverySnapshot = {
    ...exactAdvancedSnapshot,
    canonicalBindingDigest: digest(deliveryBinding)
  };
  await assert.rejects(
    consumeTrustedExecutionArtifact({
      request: artifactRequest,
      identity,
      downloader: { async download() { return exactDownload; } },
      authorizationVerifier,
      evidenceVerifier,
      runtimePolicyValue: policy,
      controlPolicyValue: kernelPolicy,
      clock: concreteClock,
      delivery
    }),
    /default-branch base or pull-request state changed|completed replay canonical binding is inconsistent/u
  );
  persistedBinding = exactPersistedBinding;
  deliverySnapshot = exactAdvancedSnapshot;
  assert.equal(effects.length, 4);

  persistedBinding = {
    ...exactPersistedBinding,
    project: {
      ...exactPersistedBinding.project,
      itemNodeId: `${exactPersistedBinding.project.itemNodeId}_other`
    }
  };
  deliverySnapshot = {
    ...exactAdvancedSnapshot,
    canonicalBindingDigest: digest(persistedBinding),
    projectItemNodeId: persistedBinding.project.itemNodeId
  };
  await assert.rejects(
    consumeTrustedExecutionArtifact({
      request: artifactRequest,
      identity,
      downloader: { async download() { return exactDownload; } },
      authorizationVerifier,
      evidenceVerifier,
      runtimePolicyValue: policy,
      controlPolicyValue: kernelPolicy,
      clock: concreteClock,
      delivery
    }),
    /completed replay canonical binding is inconsistent/u
  );
  persistedBinding = exactPersistedBinding;
  deliverySnapshot = exactAdvancedSnapshot;
  assert.equal(effects.length, 4);

  for (const substitution of [
    { patch: "different diff" },
    { planningArtifactDigest: digest({ plan: "substituted" }) },
    { executionGrantDigest: digest({ grant: "substituted" }) },
    { baseSha: "3333333333333333333333333333333333333333" },
    { kernelReceiptDigest: digest({ kernel: "substituted" }) }
  ]) {
    const payload = {
      ...result.artifact,
      ...substitution,
      signature: undefined
    };
    const { signature: _signature, ...unsigned } = payload;
    await assert.rejects(
      consumeTrustedPatchArtifact({
        authorizationValue: authorization,
        authorizationVerifier,
        kernelResult,
        runtimePolicyValue: policy,
        controlPolicyValue: kernelPolicy,
        artifactValue: {
          ...unsigned,
          signature: await evidenceSigner.sign(unsigned)
        },
        patchBundleValue: result.bundle.patchBundle,
        threatEvidenceValue: threatEvidence,
        evidenceVerifier,
        clock,
        delivery: {
          async deliver() {
            throw new Error("substituted artifact reached delivery");
          }
        }
      }),
      /stale, unsigned, or substituted|patch digest/u
    );
  }

  await assert.rejects(
    consumeTrustedPatchArtifact({
      authorizationValue: authorization,
      authorizationVerifier,
      kernelResult,
      runtimePolicyValue: policy,
      controlPolicyValue: kernelPolicy,
      artifactValue: result.artifact,
      patchBundleValue: result.bundle.patchBundle,
      threatEvidenceValue: threatEvidence,
      evidenceVerifier,
      clock: { now: () => "2026-08-26T12:05:00.001Z" },
      delivery: {
        async deliver() {
          throw new Error("expired artifact reached delivery");
        }
      }
    }),
    /stale/u
  );

  await assert.rejects(
    runTrustedExecutionBridge({
      repositoryPath: ".",
      authorizationValue: authorization,
      authorizationVerifier,
      kernelResult,
      runtimePolicyValue: policy,
      controlPolicyValue: kernelPolicy,
      envelopeValue: {
        ...envelope,
        executionGrantDigest: digest({ substituted: true })
      },
      clock,
      ...bridgeEvidence,
      executePatch: () => {
        throw new Error("substituted grant reached the executor");
      },
      handoff: {
        async persist() {
          throw new Error("substituted grant reached delivery");
        }
      }
    }),
    /substituted its signed planning or execution grant/u
  );

  const bridgeBase = {
    repositoryPath: ".",
    authorizationValue: authorization,
    authorizationVerifier,
    kernelResult,
    runtimePolicyValue: policy,
    controlPolicyValue: kernelPolicy,
    envelopeValue: envelope,
    clock,
    ...bridgeEvidence,
    executePatch: () => {
      throw new Error("invalid Kernel proof reached the worktree");
    },
    handoff: {
      async persist() {
        throw new Error("invalid Kernel proof reached delivery");
      }
    }
  } as const;
  const invalidKernelResults: readonly KernelResult[] = [
    {
      kind: "noop",
      reason: "duplicate-event",
      receiptDigest: kernelResult.receiptDigest,
      snapshot: kernelResult.snapshot
    },
    {
      kind: "refused",
      refusal: {
        code: "UNAUTHORIZED_ACTOR",
        message: "refused",
        ruleId: "test",
        retryable: false,
        recovery: "human-authorization"
      },
      snapshot: kernelResult.snapshot
    },
    {
      ...kernelResult,
      route: { ...kernelResult.route, id: "wrong.route" }
    },
    {
      ...kernelResult,
      snapshot: { ...kernelResult.snapshot, receiptHead: D.placeholder }
    },
    {
      ...kernelResult,
      effects: kernelResult.effects.map((effect) =>
        effect.type === "enter-phase"
          ? {
              ...effect,
              capabilities: effect.capabilities.map((capability) => ({
                ...capability,
                reference: "core.frame-artifact@1.0.0"
              }))
            }
          : effect
      )
    }
  ];
  for (const invalidKernelResult of invalidKernelResults) {
    await assert.rejects(
      runTrustedExecutionBridge({
        ...bridgeBase,
        kernelResult: invalidKernelResult
      }),
      /Kernel|kernel|capability/u
    );
  }
  const { kernelResult: _kernelResult, ...manualAuthorizationOnly } = bridgeBase;
  await assert.rejects(
    Reflect.apply(runTrustedExecutionBridge, undefined, [
      manualAuthorizationOnly
    ]),
    /Kernel|kernel/u
  );
  await assert.rejects(
    runTrustedExecutionBridge({
      ...bridgeBase,
      runtimePolicyValue: {
        ...policy,
        modelSelection: { ...policy.modelSelection, model: "substituted-model" }
      }
    }),
    /policy/u
  );
  await assert.rejects(
    runTrustedExecutionBridge({
      ...bridgeBase,
      controlPolicyValue: {
        ...kernelPolicy,
        independentGates: []
      }
    }),
    /Control Policy/u
  );
});

test("pre-activation fails closed on stale head, incomplete reservation, and loops", () => {
  assert.throws(
    () => preAuthorize({ currentHead: "3333333333333333333333333333333333333333" }),
    /current-head/
  );
  assert.throws(
    () => preAuthorize({ reservedAiCredits: 200 }),
    /activation\.cost/
  );
  assert.throws(
    () => preAuthorize({}, { remainingAiCredits: 499 }),
    /activation\.cost/
  );
  assert.throws(
    () => preAuthorize({}, { repairCount: 3 }),
    /activation\.loop/
  );
});

test("trusted clocks reject expired, stale, and future runtime evidence", async () => {
  assert.throws(
    () =>
      validateRuntimePreActivation(
        policy,
        request,
        evidence(),
        kernelPolicy,
        { now: () => "2026-08-26T13:00:00.000Z" }
      ),
    /activation\.(expiry|state-freshness)/
  );
  assert.throws(
    () =>
      validateRuntimePreActivation(
        policy,
        request,
        {
          ...evidence(),
          stateCommentUpdatedAt: "2026-08-26T11:54:59.000Z"
        },
        kernelPolicy,
        clock
      ),
    /state-freshness/
  );
  const candidate = preAuthorize();
  await assert.rejects(
    redeemRuntimeAuthorization(
      candidate,
      { redeem: async () => signedAuthorization(candidate) },
      authorizationVerifier,
      { now: () => "2026-08-26T12:05:01.000Z" },
      policy
    ),
    /redemption-freshness/
  );
});

test("pre-activation rejects bots, weak roles, untrusted refs, events, and workflows", () => {
  assert.throws(() => preAuthorize({ actorIsBot: true }), /activation\.actor/);
  assert.throws(
    () => preAuthorize({ actorPermission: "read" }),
    /activation\.permission/
  );
  assert.throws(
    () =>
      preAuthorize({
        workflowRef:
          "example-organization/hyperfinite/.github/workflows/agentic-review.lock.yml@refs/heads/feature"
      }),
    /workflow-source/
  );
  assert.throws(
    () => preAuthorize({ eventName: "pull_request", eventAction: "created" }),
    /activation\.event/
  );
  assert.throws(
    () => preAuthorize({ workflowId: "agentic-framing" }),
    /role-binding/
  );
});

test("pre-activation rejects App, policy, nonce, and signature substitutions", () => {
  assert.throws(
    () =>
      validateRuntimePreActivation(
        policy,
        request,
        {
          ...evidence(),
          stateAuthorApplicationId: 98
        },
        kernelPolicy,
        clock
      ),
    /state-author/
  );
  assert.throws(
    () => preAuthorize({ policyDigest: digest({ substituted: true }) }),
    /activation\.policy/
  );
  assert.throws(
    () =>
      preAuthorize(
        { kernelPolicyDigest: digest({ substituted: true }) },
        { kernelPolicyDigest: digest({ substituted: true }) }
      ),
    /activation\.kernel-policy-integrity/
  );
  assert.throws(
    () => preAuthorize({ activationNonce: "different_nonce_abcdefghijklmnopqrstuvwxyz" }),
    /activation\.policy/
  );
  assert.throws(
    () =>
      validateRuntimePreActivation(
        policy,
        request,
        {
          ...evidence(),
          stateSignatureVerified: false
        },
        kernelPolicy,
        clock
      ),
    /state-signature/
  );
});

test("stable state evidence rejects single-page and paginated races", () => {
  const observation = {
    state,
    commentId: 7001,
    commentUpdatedAt: NOW,
    collectionEtag: '"etag-1"'
  };
  validateStableRuntimeStateObservation(observation, observation);
  assert.throws(
    () =>
      validateStableRuntimeStateObservation(observation, {
        ...observation,
        collectionEtag: '"etag-2"'
      }),
    /state-race/
  );
  assert.throws(
    () =>
      validateStableRuntimeStateObservation(observation, {
        ...observation,
        state: { ...state, currentHead: "3333333333333333333333333333333333333333" }
      }),
    /state-race/
  );
  assert.equal(githubLastPage(null), 1);
  assert.equal(
    githubLastPage(
      '<https://api.github.com/repos/example-organization/hyperfinite/issues/6/comments?per_page=100&page=2>; rel="next", <https://api.github.com/repos/example-organization/hyperfinite/issues/6/comments?per_page=100&page=4>; rel="last"'
    ),
    4
  );
});

test("runtime state signatures bind nonce, workflow, and remaining credits", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keyId = "runtime-state-test";
  const unsigned = {
    ...state,
    stageAgentSelection: {
      grantDigest: digest("selected-agent-grant"),
      authorityEpoch: 1,
      generation: 0,
      runId: "selected-run",
      runAttempt: 1,
      receiptHead: null,
      policyGeneration: 1,
      selectionPolicyDigest: digest("selection-policy"),
      stageAgentBindingsDigest: digest("stage-bindings"),
      capabilityRegistryDigest: digest("selection-registry"),
      budgetAuthorityDigest: digest("selection-budget")
    },
    signature: { algorithm: "ed25519" as const, keyId, value: "dGVzdA==" }
  };
  const signature = sign(
    null,
    Buffer.from(canonicalJson(runtimeStateSigningPayload(unsigned))),
    privateKey
  ).toString("base64");
  const signed = { ...unsigned, signature: { ...unsigned.signature, value: signature } };
  const {
    signature: _stateSignature,
    ...statePayload
  } = unsigned;
  assert.deepEqual(runtimeStateSigningPayload(unsigned), {
    domain: "agentic-framework.runtime-state-signature.v2",
    state: statePayload
  });
  const encodedPublicKey = publicKey
    .export({ format: "der", type: "spki" })
    .toString("base64");
  assert.equal(verifyRuntimeStateSignature(signed, keyId, encodedPublicKey), true);
  assert.equal(
    verifyRuntimeStateSignature(
      { ...signed, activationNonce: "changed_nonce_abcdefghijklmnopqrstuvwxyz" },
      keyId,
      encodedPublicKey
    ),
    false
  );
  assert.equal(
    verifyRuntimeStateSignature(
      {
        ...signed,
        stageAgentSelection: {
          ...signed.stageAgentSelection,
          generation: 1
        }
      },
      keyId,
      encodedPublicKey
    ),
    false
  );
  assert.equal(
    verifyRuntimeStateSignature(
      { ...signed, remainingAiCredits: signed.remainingAiCredits + 1 },
      keyId,
      encodedPublicKey
    ),
    false
  );
});

test("runtime wire v2 requires fresh signed evidence instead of migrating v1", () => {
  const authorization = signedAuthorization(preAuthorize());
  const {
    signature: _authorizationSignature,
    ...authorizationPayload
  } = authorization;
  assert.deepEqual(runtimeAuthorizationSigningPayload(authorization), {
    domain: "agentic-framework.runtime-authorization-signature.v2",
    authorization: authorizationPayload
  });
  assert.equal(
    validateDocument("CopilotRuntimeState", {
      ...state,
      schemaVersion: "1.0.0"
    }).valid,
    false
  );
  assert.equal(
    validateDocument("CopilotRuntimeAuthorization", {
      ...authorization,
      schemaVersion: "1.0.0"
    }).valid,
    false
  );
  assert.deepEqual(
    planCopilotRuntimeWireMigration({
      kind: "CopilotRuntimeState",
      fromVersion: "1.0.0"
    }),
    {
      kind: "CopilotRuntimeState",
      fromVersion: "1.0.0",
      toVersion: "2.0.0",
      action: "reissue",
      reasonCode: "SIGNED_EVIDENCE_REISSUE_REQUIRED"
    }
  );
  assert.deepEqual(
    planCopilotRuntimeWireMigration({
      kind: "CopilotRuntimeAuthorization",
      fromVersion: "2.0.0"
    }),
    {
      kind: "CopilotRuntimeAuthorization",
      fromVersion: "2.0.0",
      toVersion: "2.0.0",
      action: "none",
      reasonCode: "CURRENT"
    }
  );
  assert.throws(
    () =>
      planCopilotRuntimeWireMigration({
        kind: "CopilotRuntimeState",
        fromVersion: "9.9.9"
      }),
    /runtime\.wire-version/u
  );
});

test("trusted redemption atomically consumes nonce, run attempt, and full budget", async () => {
  const candidate = preAuthorize();
  const redeemer = new AtomicRedeemer();
  const authorization = await redeemRuntimeAuthorization(
    candidate,
    redeemer,
    authorizationVerifier,
    clock,
    policy
  );
  assert.equal(authorization.remainingAiCreditsBefore, 500);
  assert.equal(authorization.remainingAiCreditsAfter, 0);
  assert.equal(authorization.reservedAiCredits, 500);
  assert.equal(redeemer.remaining, 0);
  await assert.rejects(
    redeemRuntimeAuthorization(candidate, redeemer, authorizationVerifier, clock, policy),
    /replay/
  );
  await assert.rejects(
    redeemRuntimeAuthorization(
      candidateWith(candidate, { runId: candidate.runId + 1 }),
      redeemer,
      authorizationVerifier,
      clock,
      policy
    ),
    /replay/
  );
});

test("redemption enforces trusted check and redemption timestamp ordering", async () => {
  const candidate = preAuthorize();
  const ordered = {
    stateCheckedAt: "2026-08-26T12:00:01.000Z",
    leaseCheckedAt: "2026-08-26T12:00:01.000Z",
    redeemedAt: "2026-08-26T12:00:02.000Z"
  } as const;
  const authorization = await redeemRuntimeAuthorization(
    candidate,
    {
      redeem: async () => signedAuthorization(candidate, ordered)
    },
    authorizationVerifier,
    { now: () => "2026-08-26T12:00:03.000Z" },
    policy
  );
  assert.equal(authorization.redeemedAt, ordered.redeemedAt);

  await assert.rejects(
    redeemRuntimeAuthorization(
      candidate,
      {
        redeem: async () =>
          signedAuthorization(candidate, {
            ...ordered,
            stateCheckedAt: "2026-08-26T12:00:03.000Z"
          })
      },
      authorizationVerifier,
      { now: () => "2026-08-26T12:00:04.000Z" },
      policy
    ),
    /redemption-freshness/
  );
});

test("concurrent redemption permits exactly one CAS winner", async () => {
  const candidate = preAuthorize();
  const redeemer = new AtomicRedeemer();
  const results = await Promise.allSettled([
    redeemRuntimeAuthorization(candidate, redeemer, authorizationVerifier, clock, policy),
    redeemRuntimeAuthorization(candidate, redeemer, authorizationVerifier, clock, policy)
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
});

test("redemption fails closed on run substitution, revocation, CAS, and missing service", async () => {
  const candidate = preAuthorize();
  await assert.rejects(
    redeemRuntimeAuthorization(
      candidate,
      {
        redeem: async () =>
          signedAuthorization(
            candidateWith(candidate, { runAttempt: candidate.runAttempt + 1 })
          )
      },
      authorizationVerifier,
      clock,
      policy
    ),
    /redemption-binding/
  );
  for (const mode of ["leaseRevoked", "stateRevoked", "casConflict", "unavailable"] as const) {
    const redeemer = new AtomicRedeemer();
    redeemer[mode] = true;
    await assert.rejects(
      redeemRuntimeAuthorization(candidate, redeemer, authorizationVerifier, clock, policy),
      /revoked|conflict|unavailable/
    );
  }
});

test("authorization cannot be forged by recomputing its unkeyed digest", () => {
  const authorization = signedAuthorization(preAuthorize());
  validateRuntimeAuthorizationIntegrity(authorization, authorizationVerifier);
  const forged = { ...authorization, routeId: "forged.route" };
  assert.throws(
    () =>
      validateRuntimeAuthorizationIntegrity(
        {
          ...forged,
          authorizationDigest: runtimeAuthorizationDigest(forged)
        },
        authorizationVerifier
      ),
    /authorization-signature/
  );
});

function authorizedKernelContext(options: {
  readonly grantedCapability?: string;
  readonly appliedKernelPolicyDigest?: Digest;
  readonly routeId?: string;
} = {}): {
  readonly authorization: RuntimeAuthorization;
  readonly kernelResult: Extract<KernelResult, { readonly kind: "applied" }>;
} {
  const routeId = options.routeId ?? state.kernelRouteId;
  const grantedCapability = options.grantedCapability ?? state.capability;
  const effects = [
    { type: "emit-receipt", eventId: "kernel-event-1" },
    {
      type: "enter-phase",
      phase: "verification",
      capabilities: [
        {
          reference: grantedCapability,
          actorClasses: ["system", "reviewer"],
          humanGates: ["activate", "approve-current-head"],
          readScopes: [
            "authorized-review-evidence",
            "trusted-review-profile",
            "trusted-review-skills",
            "trusted-gh-aw-runtime-control"
          ],
          tools: ["read", "search"],
          shellCommands: [],
          networkDestinations: [],
          mcpTools: ["safeoutputs.submit_pull_request_review"],
          riskClass: "moderate",
          privacyClass: "confidential",
          limits: {
            maxCalls: 1,
            maxCostUnits: 20,
            timeoutMs: 600000,
            maxRetries: 1,
            maxOutputBytes: 65536,
            maxConcurrency: 1,
            parallelSafe: false
          },
          evidence: [
            "validated-output-digest",
            "provider-model-receipt",
            "current-head-digest",
            "threat-detection-success"
          ],
          structuralEvaluations: ["schema-valid", "target-free", "comment-only"],
          behavioralEvaluations: [
            "evidence-quality-rubric-v1",
            "review-authority-refusal-rubric-v1"
          ]
        }
      ]
    }
  ] satisfies Extract<KernelResult, { readonly kind: "applied" }>["effects"];
  const kernelPolicyDigest =
    options.appliedKernelPolicyDigest ?? D.kernelPolicy;
  const eventDigest = digest({ event: "kernel-event-1" });
  const idempotencyKey = digest({ idempotency: "kernel-event-1" });
  const receipt = {
    schemaVersion: "1.0.0",
    eventId: "kernel-event-1",
    eventDigest,
    routeId,
    routeVersion: "1.0.0",
    from: "EXECUTING",
    to: "VERIFYING",
    stateVersion: 3,
    previousReceipt: null,
    idempotencyKey,
    replacementAuthorityDigest: null,
    bindingDigest: D.kernelBinding,
    lifecycleGraphDigest: digest({ graph: 1 }),
    workAccordDigest: D.accord,
    capabilityRegistryDigest: digest({ registry: 1 }),
    domainPackDigest: digest({ domainPack: 1 }),
    destinationBindingDigest: D.kernelBinding,
    destinationLifecycleGraphDigest: digest({ graph: 1 }),
    destinationWorkAccordDigest: D.accord,
    destinationCapabilityRegistryDigest: digest({ registry: 1 }),
    destinationDomainPackDigest: digest({ domainPack: 1 }),
    sourcePhaseContractDigest: digest({ phase: "execution" }),
    sourceCompiledPolicyDigest: digest({ compiled: "execution" }),
    destinationPhaseContractDigest: digest({ phase: "verification" }),
    destinationCompiledPolicyDigest: digest({ compiled: "verification" }),
    policyDigest: kernelPolicyDigest,
    destinationPolicyDigest: kernelPolicyDigest,
    actorId: "runtime-adapter",
    actorAuthorizationDigest: digest({ actor: "runtime-adapter" }),
    occurredAt: NOW,
    effectPlanDigest: digest(effects)
  } satisfies Extract<KernelResult, { readonly kind: "applied" }>["receipt"];
  const receiptDigest = digest(receipt);
  const candidate = preAuthorize({}, { kernelReceiptDigest: receiptDigest });
  const authorization = signedAuthorization(candidate);
  const route = {
    id: routeId,
    version: "1.0.0",
    from: "EXECUTING",
    to: "VERIFYING",
    event: "work-submitted",
    actorClasses: ["system"],
    phaseOwner: "verification",
    costBearing: true,
    humanGate: "approve-current-head",
    retryable: false,
    maxAttempts: 1
  } satisfies Extract<KernelResult, { readonly kind: "applied" }>["route"];
  const snapshot = {
    schemaVersion: "1.0.0",
    lifecycleVersion: "1.0.0",
    lifecycleGraphDigest: receipt.destinationLifecycleGraphDigest,
    state: "VERIFYING",
    phaseOwner: "verification",
    stateVersion: receipt.stateVersion,
    lastEventSequence: 3,
    bindingDigest: authorization.kernelBindingDigest,
    workAccordDigest: authorization.contractDigest,
    capabilityRegistryDigest: receipt.destinationCapabilityRegistryDigest,
    domainPackDigest: receipt.destinationDomainPackDigest,
    phaseContractDigest: receipt.destinationPhaseContractDigest,
    compiledPolicyDigest: receipt.destinationCompiledPolicyDigest,
    policyDigest: receipt.destinationPolicyDigest,
    currentHead:
      authorization.currentHead === null ? null : digest(authorization.currentHead),
    receiptHead: receiptDigest,
    suspendedState: null,
    recoveryState: null,
    usage: { calls: 1, tokens: 1, costUnits: 1, loops: 0, retries: 0 },
    phaseUsage: { calls: 1, tokens: 1, costUnits: 1, loops: 0, retries: 0 },
    routeAttempts: {},
    processedEvents: {
      [receipt.eventId]: {
        eventDigest,
        receiptDigest,
        idempotencyKey,
        deliveryId: "delivery-1"
      }
    }
  } satisfies Extract<KernelResult, { readonly kind: "applied" }>["snapshot"];
  return {
    authorization,
    kernelResult: {
      kind: "applied",
      route,
      snapshot,
      receipt,
      receiptDigest,
      effects
    }
  };
}

const output: GitHubSafeOutput = {
  apiVersion: "agentic-framework.github.com/v1alpha1",
  kind: "GitHubSafeOutput",
  schemaVersion: "1.0.0",
  summary: "Review completed for the authorized current head.",
  findings: [],
  openQuestions: [],
  result: { status: "success", details: "No high-confidence defects found." }
};

test("runtime bridge emits only a current-head COMMENT review from signed redemption", () => {
  const { authorization, kernelResult } = authorizedKernelContext();
  const plan = bridgeRuntimeOutput({
    authorization,
    authorizationVerifier,
    kernelResult,
    policy,
    redemptionDigest: digest(authorization),
    threatEvidence: {
      status: "success",
      inputDigest: authorization.authorizationDigest,
      outputDigest: digest(output),
      checkedAt: NOW
    },
    output,
    binding,
    eventId: authorization.redemptionKey,
    receiptHead: kernelResult.receiptDigest,
    attempt: authorization.runAttempt,
    clock
  });
  assert.equal(plan.effect.type, "pull-request-review-comment");
  if (plan.effect.type === "pull-request-review-comment") {
    assert.equal(plan.effect.pullRequest.number, 6);
    assert.equal(plan.effect.headSha, binding.workItem.kind === "pull-request"
      ? binding.workItem.head.sha
      : "");
    assert.equal(plan.effect.event, "COMMENT");
  }
});

test("runtime bridge rejects stale redemption and authorization checks", () => {
  const { authorization, kernelResult } = authorizedKernelContext();
  const staleNow = "2026-08-26T12:05:01.000Z";
  assert.throws(
    () =>
      bridgeRuntimeOutput({
        authorization,
        authorizationVerifier,
        kernelResult,
        policy,
        redemptionDigest: digest(authorization),
        threatEvidence: {
          status: "success",
          inputDigest: authorization.authorizationDigest,
          outputDigest: digest(output),
          checkedAt: staleNow
        },
        output,
        binding,
        eventId: authorization.redemptionKey,
        receiptHead: kernelResult.receiptDigest,
        attempt: authorization.runAttempt,
        clock: { now: () => staleNow }
      }),
    /bridge\.freshness/
  );
});

test("runtime bridge rejects warning, output, run, binding, and signature substitutions", () => {
  const { authorization, kernelResult } = authorizedKernelContext();
  const base = {
    authorization,
    authorizationVerifier,
    kernelResult,
    policy,
    redemptionDigest: digest(authorization),
    output,
    binding,
    eventId: authorization.redemptionKey,
    receiptHead: kernelResult.receiptDigest,
    attempt: authorization.runAttempt,
    clock
  } as const;
  assert.throws(
    () =>
      bridgeRuntimeOutput({
        ...base,
        threatEvidence: {
          status: "warning",
          inputDigest: authorization.authorizationDigest,
          outputDigest: digest(output),
          checkedAt: NOW
        }
      }),
    /threat-detection/
  );
  assert.throws(
    () =>
      bridgeRuntimeOutput({
        ...base,
        threatEvidence: {
          status: "success",
          inputDigest: authorization.authorizationDigest,
          outputDigest: digest({ substituted: true }),
          checkedAt: NOW
        }
      }),
    /threat evidence/
  );
  assert.throws(
    () =>
      bridgeRuntimeOutput({
        ...base,
        eventId: digest({ different: true }),
        threatEvidence: {
          status: "success",
          inputDigest: authorization.authorizationDigest,
          outputDigest: digest(output),
          checkedAt: NOW
        }
      }),
    /exact redeemed run/
  );
  assert.throws(
    () =>
      bridgeRuntimeOutput({
        ...base,
        binding: {
          ...binding,
          installation: { ...binding.installation, id: 2002 }
        },
        threatEvidence: {
          status: "success",
          inputDigest: authorization.authorizationDigest,
          outputDigest: digest(output),
          checkedAt: NOW
        }
      }),
    /Trusted Binding/
  );
  assert.throws(
    () =>
      bridgeRuntimeOutput({
        ...base,
        authorization: { ...authorization, routeId: "forged" },
        redemptionDigest: digest({ forged: true }),
        threatEvidence: {
          status: "success",
          inputDigest: authorization.authorizationDigest,
          outputDigest: digest(output),
          checkedAt: NOW
        }
      }),
    /authorization/
  );
});

test("runtime bridge rejects missing, refused, stale, or mismatched Kernel proof", () => {
  const { authorization, kernelResult } = authorizedKernelContext();
  const threatEvidence = {
    status: "success",
    inputDigest: authorization.authorizationDigest,
    outputDigest: digest(output),
    checkedAt: NOW
  } as const;
  const base = {
    authorization,
    authorizationVerifier,
    kernelResult,
    policy,
    redemptionDigest: digest(authorization),
    threatEvidence,
    output,
    binding,
    eventId: authorization.redemptionKey,
    receiptHead: kernelResult.receiptDigest,
    attempt: authorization.runAttempt,
    clock
  } as const;
  const { kernelResult: _kernelResult, ...withoutKernelResult } = base;
  assert.throws(
    () => Reflect.apply(bridgeRuntimeOutput, undefined, [withoutKernelResult]),
    /bridge\.kernel-result/
  );
  assert.throws(
    () =>
      bridgeRuntimeOutput({
        ...base,
        kernelResult: {
          kind: "noop",
          reason: "duplicate-event",
          receiptDigest: kernelResult.receiptDigest,
          snapshot: kernelResult.snapshot
        }
      }),
    /bridge\.kernel-result/
  );
  assert.throws(
    () =>
      bridgeRuntimeOutput({
        ...base,
        kernelResult: {
          kind: "refused",
          refusal: {
            code: "UNAUTHORIZED_ACTOR",
            message: "refused",
            ruleId: "test",
            retryable: false,
            recovery: "human-authorization"
          },
          snapshot: kernelResult.snapshot
        }
      }),
    /bridge\.kernel-result/
  );
  assert.throws(
    () =>
      bridgeRuntimeOutput({
        ...base,
        kernelResult: {
          ...kernelResult,
          route: { ...kernelResult.route, id: "wrong.route" }
        }
      }),
    /bridge\.kernel-receipt/
  );
  assert.throws(
    () =>
      bridgeRuntimeOutput({
        ...base,
        kernelResult: {
          ...kernelResult,
          snapshot: { ...kernelResult.snapshot, receiptHead: D.placeholder }
        }
      }),
    /bridge\.kernel-receipt/
  );

  const wrongCapability = authorizedKernelContext({
    grantedCapability: "core.frame-artifact@1.0.0"
  });
  assert.throws(
    () =>
      bridgeRuntimeOutput({
        ...base,
        authorization: wrongCapability.authorization,
        kernelResult: wrongCapability.kernelResult,
        redemptionDigest: digest(wrongCapability.authorization),
        threatEvidence: {
          ...threatEvidence,
          inputDigest: wrongCapability.authorization.authorizationDigest
        },
        eventId: wrongCapability.authorization.redemptionKey,
        receiptHead: wrongCapability.kernelResult.receiptDigest
      }),
    /bridge\.capability-grant/
  );
  assert.throws(
    () =>
      bridgeRuntimeOutput({
        ...base,
        policy: {
          ...policy,
          modelSelection: { ...policy.modelSelection, model: "substituted-model" }
        }
      }),
    /bridge\.policy/
  );
  const stalePolicy = authorizedKernelContext({
    appliedKernelPolicyDigest: digest({ policy: "stale-kernel" })
  });
  assert.throws(
    () =>
      bridgeRuntimeOutput({
        ...base,
        authorization: stalePolicy.authorization,
        kernelResult: stalePolicy.kernelResult,
        redemptionDigest: digest(stalePolicy.authorization),
        threatEvidence: {
          ...threatEvidence,
          inputDigest: stalePolicy.authorization.authorizationDigest
        },
        eventId: stalePolicy.authorization.redemptionKey,
        receiptHead: stalePolicy.kernelResult.receiptDigest
      }),
    /bridge\.kernel-receipt/
  );
});
