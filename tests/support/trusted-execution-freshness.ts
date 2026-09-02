import {
  createHash,
  generateKeyPairSync,
  sign as signBytes,
  verify as verifyBytes
} from "node:crypto";
import { readFileSync } from "node:fs";

import {
  canonicalJson,
  consumeTrustedExecutionArtifact,
  digest,
  runTrustedExecutionBridge,
  runtimeAuthorizationDigest,
  runtimeAuthorizationSigningPayload,
  runtimeRedemptionKey,
  runtimeRedemptionLedgerHead,
  workAccordBindingDigest,
  type ControlPolicy,
  type CopilotRuntimePolicy,
  type DetachedSignature,
  type Digest,
  type EngineeringWorkBinding,
  type EvidenceSigner,
  type EvidenceVerifier,
  type KernelResult,
  type RuntimeAuthorization,
  type RuntimeAuthorizationVerifier,
  type TrustedExecutionFreshnessAuthority,
  type ValidatedPatch,
  type WorkAccord
} from "../../src/index.js";

const baseRuntimePolicy = JSON.parse(
  readFileSync("config/v1alpha1/copilot-runtime-policy.json", "utf8")
) as CopilotRuntimePolicy;
const controlPolicy = JSON.parse(
  readFileSync("config/v1alpha1/policy.json", "utf8")
) as ControlPolicy;

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const keyId = "trusted-execution-test-support";
const capability = "core.execute-bounded-change@1.0.0";

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

function storedZip(fileName: string, content: string): Buffer {
  const name = Buffer.from(fileName);
  const data = Buffer.from(content);
  const checksum = crc32(data);
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

function sign(payload: unknown): DetachedSignature {
  return {
    algorithm: "ed25519",
    keyId,
    value: signBytes(
      null,
      Buffer.from(canonicalJson(payload)),
      privateKey
    ).toString("base64")
  };
}

const evidenceSigner: EvidenceSigner = {
  async sign(payload) {
    return sign(payload);
  }
};

const evidenceVerifier: EvidenceVerifier = {
  verify(payload, signature) {
    return (
      signature.algorithm === "ed25519" &&
      signature.keyId === keyId &&
      verifyBytes(
        null,
        Buffer.from(canonicalJson(payload)),
        publicKey,
        Buffer.from(signature.value, "base64")
      )
    );
  }
};

const authorizationVerifier: RuntimeAuthorizationVerifier = {
  verify(authorization) {
    return evidenceVerifier.verify(
      runtimeAuthorizationSigningPayload(authorization),
      authorization.signature
    );
  }
};

export interface TrustedExecutionTestIdentity {
  readonly workflowId: string;
  readonly contractRevision: number;
  readonly workAccordDigest: Digest;
  readonly activationLeaseDigest: Digest;
  readonly executionGrantDigest: Digest;
  readonly kernelReceiptDigest: Digest;
  readonly modelOutputDigest: Digest;
}

export interface TrustedExecutionTestFreshness {
  readonly identity: TrustedExecutionTestIdentity;
  readonly authority: TrustedExecutionFreshnessAuthority;
  readonly patchArtifactDigest: Digest;
  readonly patchBundleDigest: Digest;
  readonly executionBundleDigest: Digest;
}

function runtimePolicyFor(workflowId: string): CopilotRuntimePolicy {
  return {
    ...baseRuntimePolicy,
    phaseBindings: baseRuntimePolicy.phaseBindings.map((binding) =>
      binding.phase === "execution"
        ? { ...binding, workflow: workflowId }
        : binding
    )
  };
}

function authorizedKernelResult(input: {
  readonly kernelBindingDigest: Digest;
  readonly workAccordDigest: Digest;
  readonly occurredAt: string;
}): Extract<KernelResult, { readonly kind: "applied" }> {
  const effects = [
    { type: "emit-receipt", eventId: "trusted-execution-test-event" },
    {
      type: "enter-phase",
      phase: "execution",
      capabilities: [
        {
          reference: capability,
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
            timeoutMs: 600_000,
            maxRetries: 0,
            maxOutputBytes: 262_144,
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
  const eventDigest = digest({ event: "trusted-execution-test-event" });
  const idempotencyKey = digest({
    idempotency: "trusted-execution-test-event"
  });
  const lifecycleGraphDigest = digest({ graph: "trusted-execution-test" });
  const capabilityRegistryDigest = digest({
    registry: "trusted-execution-test"
  });
  const domainPackDigest = digest({ domainPack: "trusted-execution-test" });
  const phaseContractDigest = digest({ phase: "execution" });
  const compiledPolicyDigest = digest({ compiled: "execution" });
  const appliedPolicyDigest = digest(controlPolicy);
  const receipt = {
    schemaVersion: "1.0.0",
    eventId: "trusted-execution-test-event",
    eventDigest,
    routeId: "planning.execute",
    routeVersion: "1.0.0",
    from: "PLANNED",
    to: "EXECUTING",
    stateVersion: 3,
    previousReceipt: null,
    idempotencyKey,
    replacementAuthorityDigest: null,
    bindingDigest: input.kernelBindingDigest,
    lifecycleGraphDigest,
    workAccordDigest: input.workAccordDigest,
    capabilityRegistryDigest,
    domainPackDigest,
    destinationBindingDigest: input.kernelBindingDigest,
    destinationLifecycleGraphDigest: lifecycleGraphDigest,
    destinationWorkAccordDigest: input.workAccordDigest,
    destinationCapabilityRegistryDigest: capabilityRegistryDigest,
    destinationDomainPackDigest: domainPackDigest,
    sourcePhaseContractDigest: digest({ phase: "planning" }),
    sourceCompiledPolicyDigest: digest({ compiled: "planning" }),
    destinationPhaseContractDigest: phaseContractDigest,
    destinationCompiledPolicyDigest: compiledPolicyDigest,
    policyDigest: appliedPolicyDigest,
    destinationPolicyDigest: appliedPolicyDigest,
    actorId: "trusted-execution-test-adapter",
    actorAuthorizationDigest: digest({
      actor: "trusted-execution-test-adapter"
    }),
    occurredAt: input.occurredAt,
    effectPlanDigest: digest(effects)
  } satisfies Extract<KernelResult, { readonly kind: "applied" }>["receipt"];
  const receiptDigest = digest(receipt);
  const route = {
    id: "planning.execute",
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
    lifecycleGraphDigest,
    state: "EXECUTING",
    phaseOwner: "execution",
    stateVersion: receipt.stateVersion,
    lastEventSequence: 3,
    bindingDigest: input.kernelBindingDigest,
    workAccordDigest: input.workAccordDigest,
    capabilityRegistryDigest,
    domainPackDigest,
    phaseContractDigest,
    compiledPolicyDigest,
    policyDigest: appliedPolicyDigest,
    currentHead: null,
    receiptHead: receiptDigest,
    suspendedState: null,
    recoveryState: null,
    usage: { calls: 1, tokens: 1, costUnits: 1, loops: 0, retries: 0 },
    phaseUsage: {
      calls: 1,
      tokens: 1,
      costUnits: 1,
      loops: 0,
      retries: 0
    },
    routeAttempts: {},
    processedEvents: {
      [receipt.eventId]: {
        eventDigest,
        receiptDigest,
        idempotencyKey,
        deliveryId: "trusted-execution-test-delivery"
      }
    }
  } satisfies Extract<KernelResult, { readonly kind: "applied" }>["snapshot"];
  return {
    kind: "applied",
    route,
    snapshot,
    receipt,
    receiptDigest,
    effects
  };
}

function signedAuthorization(input: {
  readonly workflowId: string;
  readonly binding: EngineeringWorkBinding;
  readonly workAccord: WorkAccord;
  readonly activationLeaseDigest: Digest;
  readonly executionContext: NonNullable<RuntimeAuthorization["executionContext"]>;
  readonly kernelResult: Extract<KernelResult, { readonly kind: "applied" }>;
  readonly runtimePolicy: CopilotRuntimePolicy;
  readonly now: string;
  readonly expiresAt: string;
}): RuntimeAuthorization {
  const activationNonce = "trusted_execution_test_nonce_000001";
  const runId = 1;
  const runAttempt = 1;
  const bindingDigest = digest(input.binding);
  const kernelBindingDigest = workAccordBindingDigest(input.workAccord);
  const workAccordDigest = digest(input.workAccord);
  let authorization: RuntimeAuthorization = {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "CopilotRuntimeAuthorization",
    schemaVersion: "2.0.0",
    authorizationDigest: digest({ placeholder: "authorization" }),
    candidateDigest: digest({
      candidate: {
        workflowId: input.workflowId,
        bindingDigest,
        workAccordDigest,
        activationLeaseDigest: input.activationLeaseDigest,
        executionGrantDigest: input.executionContext.executionGrantDigest
      }
    }),
    inputDigest: digest({ input: "trusted-execution-test" }),
    stateDigest: digest({ state: "trusted-execution-test" }),
    policyDigest: digest(input.runtimePolicy),
    kernelPolicyDigest: digest(controlPolicy),
    bindingDigest,
    kernelBindingDigest,
    workAccordSourceDigest: input.workAccord.binding.sourceDigest,
    repositoryId: input.binding.repository.id,
    repositoryFullName: input.binding.repository.fullName,
    workItemKind: "issue",
    workItemNumber: input.binding.issue.number,
    workItemNodeId: input.binding.issue.nodeId,
    projectNodeId: input.binding.project.nodeId,
    projectItemNodeId: input.binding.project.itemNodeId,
    kernelReceiptDigest: input.kernelResult.receiptDigest,
    routeId: "planning.execute",
    phase: "execution",
    role: "executor",
    capability,
    workflowId: input.workflowId,
    workflowRef: `${input.binding.repository.fullName}/.github/workflows/${input.workflowId}.lock.yml@refs/heads/main`,
    workflowSha: "1111111111111111111111111111111111111111",
    runId,
    runAttempt,
    eventName: "issue_comment",
    eventAction: "created",
    actorId: 1,
    actorLogin: "trusted-execution-test",
    activationLeaseDigest: input.activationLeaseDigest,
    activationNonce,
    reservedAiCredits: 1,
    remainingAiCreditsBefore: 2,
    remainingAiCreditsAfter: 1,
    contractRevision: input.workAccord.identity.revision,
    contractDigest: workAccordDigest,
    currentHead: null,
    executionContext: input.executionContext,
    outputSchema: "TargetFreePatch@1.0.0",
    stateCommentId: 1,
    stateCommentUpdatedAt: input.now,
    stateCollectionEtag: '"trusted-execution-test-etag"',
    stateRevoked: false,
    leaseRevoked: false,
    projectBindingVerified: true,
    stateCheckedAt: input.now,
    leaseCheckedAt: input.now,
    redemptionKey: digest({ placeholder: "redemption" }),
    casResult: "appended",
    ledgerVersion: 1,
    ledgerHeadBefore: null,
    ledgerHeadAfter: digest({ placeholder: "ledger" }),
    redeemedAt: input.now,
    expiresAt: input.expiresAt,
    redeemerServiceId: "trusted-execution-test-redeemer",
    signature: {
      algorithm: "ed25519",
      keyId,
      value: "dGVzdA=="
    }
  };
  authorization = {
    ...authorization,
    redemptionKey: runtimeRedemptionKey(authorization),
  };
  authorization = {
    ...authorization,
    ledgerHeadAfter: runtimeRedemptionLedgerHead(authorization)
  };
  authorization = {
    ...authorization,
    authorizationDigest: runtimeAuthorizationDigest(authorization)
  };
  return {
    ...authorization,
    signature: sign(runtimeAuthorizationSigningPayload(authorization))
  };
}

export async function obtainTrustedExecutionTestFreshness(input: {
  readonly binding: EngineeringWorkBinding;
  readonly workAccord: WorkAccord;
  readonly activationLeaseDigest: Digest;
  readonly workflowId?: string;
  readonly now?: string;
  readonly expiresAt?: string;
  readonly grantIdentity?: string;
}): Promise<TrustedExecutionTestFreshness> {
  const workflowId = input.workflowId ?? "agentic-execution";
  const now = input.now ?? "2026-08-26T12:00:00.000Z";
  const expiresAt =
    input.expiresAt ??
    new Date(Date.parse(now) + 60 * 60 * 1_000).toISOString();
  const runtimePolicy = runtimePolicyFor(workflowId);
  const bindingDigest = digest(input.binding);
  const workAccordDigest = digest(input.workAccord);
  const planningArtifact = {
    schemaVersion: "1.0.0",
    steps: ["Produce the authenticated test-support patch."],
    targetSlots: ["test-support-output"],
    verificationIds: ["git-diff-check"]
  } as const;
  const grant = {
    repositoryId: input.binding.repository.id,
    workItemNodeId: input.binding.issue.nodeId,
    workAccordDigest,
    activationLeaseDigest: input.activationLeaseDigest,
    snapshotDigest: digest({
      bindingDigest,
      grantIdentity: input.grantIdentity ?? "default"
    }),
    routeId: "planning.execute",
    baseSha: "1111111111111111111111111111111111111111",
    targets: [
      {
        slot: "test-support-output",
        path: "examples/engineering/workspace/trusted-execution-test.txt",
        operation: "create",
        expectedDigest: null,
        expectedMode: "100644",
        maxBytes: 1_024
      }
    ],
    verificationCommandIds: ["git-diff-check"],
    maxFiles: 1,
    maxPatchBytes: 1_024,
    maxTurns: 1,
    maxCostUnits: 1,
    expiresAt
  } as const;
  const executionContext = {
    schemaVersion: "1.0.0",
    planningArtifact,
    planningArtifactDigest: digest(planningArtifact),
    canonicalWorkAccord: canonicalJson(input.workAccord),
    canonicalExecutionGrant: canonicalJson(grant),
    executionGrantDigest: digest(grant),
    patchSchema: "TargetFreePatch@1.0.0"
  } as const;
  const kernelResult = authorizedKernelResult({
    kernelBindingDigest: workAccordBindingDigest(input.workAccord),
    workAccordDigest,
    occurredAt: now
  });
  const authorization = signedAuthorization({
    workflowId,
    binding: input.binding,
    workAccord: input.workAccord,
    activationLeaseDigest: input.activationLeaseDigest,
    executionContext,
    kernelResult,
    runtimePolicy,
    now,
    expiresAt
  });
  const envelope = {
    schemaVersion: "1.0.0",
    planningArtifactDigest: executionContext.planningArtifactDigest,
    executionGrantDigest: executionContext.executionGrantDigest,
    patch: {
      schemaVersion: "1.0.0",
      summary: "Create the authenticated test-support fixture.",
      changes: [
        { slot: "test-support-output", content: "authenticated fixture\n" }
      ]
    }
  } as const;
  const modelOutputDigest = digest(envelope);
  const threatPayload = {
    status: "success",
    authorizationDigest: authorization.authorizationDigest,
    modelOutputDigest,
    kernelReceiptDigest: authorization.kernelReceiptDigest,
    checkedAt: now,
    expiresAt
  } as const;
  const threatEvidence = {
    ...threatPayload,
    signature: sign(threatPayload)
  };
  const content = envelope.patch.changes[0].content;
  const contentBase64 = Buffer.from(content).toString("base64");
  const file = {
    slot: "test-support-output",
    path: grant.targets[0].path,
    operation: "create",
    beforeDigest: null,
    afterDigest: digest(contentBase64),
    bytes: Buffer.byteLength(content),
    mode: "100644"
  } as const;
  const patch = "authenticated test-support patch";
  const validatedPatch: ValidatedPatch = {
    baseSha: grant.baseSha,
    patch,
    patchDigest: digest(patch),
    treeDigest: digest([
      { path: file.path, digest: file.afterDigest, mode: file.mode }
    ]),
    gitTreeSha: "2222222222222222222222222222222222222222",
    files: [file],
    verification: [
      {
        commandId: "git-diff-check",
        stdoutDigest: digest(""),
        stderrDigest: digest("")
      }
    ]
  };
  const bridge = await runTrustedExecutionBridge({
    repositoryPath: ".",
    authorizationValue: authorization,
    authorizationVerifier,
    kernelResult,
    runtimePolicyValue: runtimePolicy,
    controlPolicyValue: controlPolicy,
    envelopeValue: envelope,
    clock: { now: () => now },
    threatEvidenceValue: threatEvidence,
    evidenceSigner,
    evidenceVerifier,
    executePatch: () => validatedPatch,
    handoff: {
      async persist(bundle) {
        return bundle;
      }
    }
  });
  const archiveBytes = storedZip(
    "agentic-execution-bundle.json",
    `${canonicalJson(bridge.bundle)}\n`
  );
  const artifactId = 1;
  const artifactName = `agentic-execution-bundle-${authorization.runId}-${authorization.runAttempt}`;
  const request = {
    schemaVersion: "1.0.0",
    repositoryId: authorization.repositoryId,
    repositoryFullName: authorization.repositoryFullName,
    workflowRef: authorization.workflowRef,
    workflowSha: authorization.workflowSha,
    runId: authorization.runId,
    runAttempt: authorization.runAttempt,
    artifactId,
    artifactName,
    artifactArchiveDigest: `sha256:${createHash("sha256")
      .update(archiveBytes)
      .digest("hex")}` as Digest,
    bundleDigest: digest(bridge.bundle)
  } as const;
  const authority = await consumeTrustedExecutionArtifact({
    request,
    identity: {
      repositoryId: authorization.repositoryId,
      repositoryFullName: authorization.repositoryFullName,
      workflowRef: authorization.workflowRef,
      workflowSha: authorization.workflowSha,
      runId: authorization.runId,
      runAttempt: authorization.runAttempt
    },
    downloader: {
      async download() {
        return {
          repositoryId: authorization.repositoryId,
          artifactId,
          artifactName,
          runId: authorization.runId,
          runAttempt: authorization.runAttempt,
          archiveBytes
        };
      }
    },
    authorizationVerifier,
    runtimePolicyValue: runtimePolicy,
    controlPolicyValue: controlPolicy,
    evidenceVerifier,
    clock: { now: () => now },
    delivery: {
      async deliver(deliveryInput) {
        return deliveryInput.freshnessAuthority;
      }
    }
  });
  return {
    identity: {
      workflowId,
      contractRevision: input.workAccord.identity.revision,
      workAccordDigest,
      activationLeaseDigest: input.activationLeaseDigest,
      executionGrantDigest: executionContext.executionGrantDigest,
      kernelReceiptDigest: kernelResult.receiptDigest,
      modelOutputDigest
    },
    authority,
    patchArtifactDigest: digest(bridge.artifact),
    patchBundleDigest: digest(bridge.bundle.patchBundle),
    executionBundleDigest: digest(bridge.bundle)
  };
}
