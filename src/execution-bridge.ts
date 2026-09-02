import {
  assertBoundedExecutionGrant,
  executeBoundedWorktree,
  type BoundedExecutionGrant,
  type ExecutionClock,
  type TargetFreePatch,
  type ValidatedPatch
} from "./bounded-worktree.js";
import { canonicalJson, digest } from "./canonical.js";
import {
  bindKernelAuthorization,
  validateRuntimeAuthorizationIntegrity,
  type RuntimeAuthorization,
  type RuntimeAuthorizationVerifier
} from "./copilot-runtime.js";
import type {
  ControlPolicy,
  CopilotRuntimePolicy,
  Digest,
  KernelResult,
  WorkAccord
} from "./types.js";
import { assertDocument } from "./validation.js";
import {
  assertAuthenticatedArtifactConsumptionProof,
  type AuthenticatedArtifactConsumptionProof
} from "./execution-delivery.js";
import type {
  DetachedSignature,
  EngineeringThreatEvidence,
  EvidenceSigner,
  EvidenceVerifier,
  RuntimeFreshnessEvidence,
  TrustedValidatedPatchBundle
} from "./engineering-slice.js";
import {
  issueTrustedValidatedPatchBundle,
  validateTrustedValidatedPatchBundle
} from "./engineering-slice.js";
import {
  assertTrustedDemoRuntimeBinding,
  type TrustedDemoRuntimeBinding
} from "./demo-portfolio.js";

export interface TargetFreePatchEnvelope {
  readonly schemaVersion: "1.0.0";
  readonly planningArtifactDigest: Digest;
  readonly executionGrantDigest: Digest;
  readonly patch: TargetFreePatch;
}

declare const trustedExecutionFreshnessAuthorityBrand: unique symbol;

export interface TrustedExecutionFreshnessAuthority {
  readonly [trustedExecutionFreshnessAuthorityBrand]: true;
}

export interface ValidatedExecutionFreshnessAuthority {
  readonly runtimePolicy: CopilotRuntimePolicy;
  readonly runtimePolicyDigest: Digest;
  readonly authorization: RuntimeAuthorization;
  readonly authorizationDigest: Digest;
  readonly kernelReceiptDigest: Digest;
  readonly kernelProofDigest: Digest;
  readonly threatEvidenceDigest: Digest;
  readonly patchArtifactDigest: Digest;
  readonly patchBundleDigest: Digest;
  readonly executionBundleDigest: Digest | null;
  readonly executionGrantDigest: Digest;
  readonly modelOutputDigest: Digest;
  readonly clock: ExecutionClock;
  readonly evidence: RuntimeFreshnessEvidence;
}

const trustedExecutionFreshnessAuthorities = new WeakMap<
  object,
  ValidatedExecutionFreshnessAuthority
>();

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function issueTrustedExecutionFreshnessAuthority(
  authority: ValidatedExecutionFreshnessAuthority
): TrustedExecutionFreshnessAuthority {
  const immutableAuthority = Object.freeze({
    runtimePolicy: deepFreeze(structuredClone(authority.runtimePolicy)),
    runtimePolicyDigest: authority.runtimePolicyDigest,
    authorization: deepFreeze(structuredClone(authority.authorization)),
    authorizationDigest: authority.authorizationDigest,
    kernelReceiptDigest: authority.kernelReceiptDigest,
    kernelProofDigest: authority.kernelProofDigest,
    threatEvidenceDigest: authority.threatEvidenceDigest,
    patchArtifactDigest: authority.patchArtifactDigest,
    patchBundleDigest: authority.patchBundleDigest,
    executionBundleDigest: authority.executionBundleDigest,
    executionGrantDigest: authority.executionGrantDigest,
    modelOutputDigest: authority.modelOutputDigest,
    clock: Object.freeze({ now: authority.clock.now.bind(authority.clock) }),
    evidence: deepFreeze(structuredClone(authority.evidence))
  });
  const capability = Object.freeze(Object.create(null)) as TrustedExecutionFreshnessAuthority;
  trustedExecutionFreshnessAuthorities.set(capability, immutableAuthority);
  return capability;
}

export function assertTrustedExecutionFreshnessAuthority(
  capability: TrustedExecutionFreshnessAuthority
): ValidatedExecutionFreshnessAuthority {
  const authority =
    typeof capability === "object" && capability !== null
      ? trustedExecutionFreshnessAuthorities.get(capability)
      : undefined;
  if (authority === undefined) {
    throw new Error(
      "freshness context is not bound to authenticated artifact consumption"
    );
  }
  return Object.freeze({ ...authority });
}

export interface TrustedExecutionDeliveryPort<T> {
  deliver(input: {
    readonly authorization: RuntimeAuthorization;
    readonly artifact: TrustedValidatedPatchArtifact;
    readonly patchBundle: TrustedValidatedPatchBundle;
    readonly freshnessAuthority: TrustedExecutionFreshnessAuthority;
  }): Promise<T>;
}

export interface TrustedExecutionBridgeResult<T> {
  readonly validatedPatch: ValidatedPatch;
  readonly artifact: TrustedValidatedPatchArtifact;
  readonly bundle: TrustedExecutionBundle;
  readonly handoff: T;
}

export interface TrustedValidatedPatchArtifact {
  readonly schemaVersion: "1.0.0";
  readonly authorizationDigest: Digest;
  readonly contractRevision: number;
  readonly repositoryId: number;
  readonly workItemNodeId: string;
  readonly baseSha: string;
  readonly planningArtifactDigest: Digest;
  readonly executionGrantDigest: Digest;
  readonly modelOutputDigest: Digest;
  readonly threatEvidenceDigest: Digest;
  readonly kernelReceiptDigest: Digest;
  readonly kernelProofDigest: Digest;
  readonly patch: string;
  readonly patchDigest: Digest;
  readonly treeDigest: Digest;
  readonly gitTreeSha: string;
  readonly files: ValidatedPatch["files"];
  readonly verification: ValidatedPatch["verification"];
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly signature: DetachedSignature;
}

export interface TrustedExecutionBundle {
  readonly schemaVersion: "1.0.0";
  readonly authorization: RuntimeAuthorization;
  readonly kernelResult: KernelResult;
  readonly runtimePolicyDigest: Digest;
  readonly controlPolicyDigest: Digest;
  readonly threatEvidence: EngineeringThreatEvidence;
  readonly artifact: TrustedValidatedPatchArtifact;
  readonly patchBundle: TrustedValidatedPatchBundle;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly signature: DetachedSignature;
}

export interface TrustedExecutionBundlePort<T> {
  persist(bundle: TrustedExecutionBundle): Promise<T>;
}

function fail(message: string): never {
  throw new TypeError(`trusted execution bridge refused: ${message}`);
}

function assertRuntimePolicy(value: unknown): CopilotRuntimePolicy {
  return assertDocument("CopilotRuntimePolicy", value);
}

function rejectCallerEvidenceAge(input: object): void {
  if (Object.hasOwn(input, "maximumEvidenceAgeMs")) {
    fail("caller-controlled evidence age is forbidden");
  }
}

function trustedClockNow(clock: ExecutionClock): {
  readonly text: string;
  readonly milliseconds: number;
} {
  const text = clock.now();
  const milliseconds = Date.parse(text);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== text
  ) {
    fail("trusted clock returned a non-canonical UTC date-time");
  }
  return { text, milliseconds };
}

function assertFreshTimestamp(
  value: string,
  now: number,
  maximumAgeMs: number,
  subject: string
): number {
  const timestamp = Date.parse(value);
  if (
    !Number.isFinite(timestamp) ||
    timestamp > now ||
    now - timestamp > maximumAgeMs
  ) {
    fail(`${subject} is stale or future-dated`);
  }
  return timestamp;
}

function assertUnexpired(
  value: string,
  now: number,
  subject: string
): number {
  const expiresAt = Date.parse(value);
  if (!Number.isFinite(expiresAt) || now >= expiresAt) {
    fail(`${subject} is expired`);
  }
  return expiresAt;
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function parseCanonical(value: string, subject: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    fail(`${subject} is not JSON`);
  }
  if (canonicalJson(parsed) !== value) {
    fail(`${subject} is not canonical JSON`);
  }
  return parsed;
}

function assertPatchEnvelope(value: unknown): TargetFreePatchEnvelope {
  const envelope = record(value);
  if (
    envelope === null ||
    Object.keys(envelope).sort().join(",") !==
      "executionGrantDigest,patch,planningArtifactDigest,schemaVersion" ||
    envelope.schemaVersion !== "1.0.0" ||
    typeof envelope.planningArtifactDigest !== "string" ||
    typeof envelope.executionGrantDigest !== "string"
  ) {
    fail("model output does not match the closed patch envelope");
  }
  return {
    schemaVersion: "1.0.0",
    planningArtifactDigest: envelope.planningArtifactDigest as Digest,
    executionGrantDigest: envelope.executionGrantDigest as Digest,
    patch: assertDocument("TargetFreePatch", envelope.patch)
  };
}

function threatPayload(
  evidence: EngineeringThreatEvidence
): Omit<EngineeringThreatEvidence, "signature"> {
  const { signature: _signature, ...payload } = evidence;
  return payload;
}

function artifactPayload(
  artifact: TrustedValidatedPatchArtifact
): Omit<TrustedValidatedPatchArtifact, "signature"> {
  const { signature: _signature, ...payload } = artifact;
  return payload;
}

function bundlePayload(
  bundle: TrustedExecutionBundle
): Omit<TrustedExecutionBundle, "signature"> {
  const { signature: _signature, ...payload } = bundle;
  return payload;
}

function validatedFilesFromBundle(
  files: TrustedValidatedPatchBundle["files"]
): ValidatedPatch["files"] {
  return files.map(({ contentBase64: _content, gitBlobSha: _blob, ...file }) => file);
}

function assertExecutionKernelAuthorization(input: {
  readonly authorization: RuntimeAuthorization;
  readonly authorizationVerifier: RuntimeAuthorizationVerifier;
  readonly kernelResult: KernelResult;
  readonly runtimePolicy: CopilotRuntimePolicy;
  readonly controlPolicyValue: unknown;
  readonly now: number;
  readonly trustedDemoBinding?: TrustedDemoRuntimeBinding;
}): {
  readonly controlPolicy: ControlPolicy;
  readonly kernelResult: Extract<KernelResult, { readonly kind: "applied" }>;
} {
  const controlPolicy = assertDocument("ControlPolicy", input.controlPolicyValue);
  if (digest(controlPolicy) !== input.authorization.kernelPolicyDigest) {
    fail("current Control Policy differs from the signed authorization");
  }
  bindKernelAuthorization(
    input.authorization,
    input.kernelResult,
    input.authorizationVerifier,
    input.runtimePolicy
  );
  const trustedDemoBinding =
    input.trustedDemoBinding === undefined
      ? undefined
      : assertTrustedDemoRuntimeBinding(input.trustedDemoBinding);
  if (
    trustedDemoBinding !== undefined &&
    (trustedDemoBinding.source !== "demo" ||
      trustedDemoBinding.demoProjectId === null ||
      trustedDemoBinding.stageId === null)
  ) {
    fail("trusted demo execution registration is not a stage binding");
  }
  const phaseBinding =
    trustedDemoBinding ??
    input.runtimePolicy.phaseBindings.find(
      (binding) => binding.phase === "execution"
    );
  if (
    input.authorization.routeId !== "planning.execute" ||
    input.authorization.phase !== "execution" ||
    input.authorization.role !== "executor" ||
    phaseBinding === undefined ||
    phaseBinding.role !== input.authorization.role ||
    phaseBinding.capability !== input.authorization.capability ||
    phaseBinding.workflow !== input.authorization.workflowId ||
    phaseBinding.workflowClass !== "target-free-execution" ||
    phaseBinding.modelInvocationAllowed !== true ||
    input.kernelResult.kind !== "applied" ||
    input.kernelResult.route.from !== "PLANNED" ||
    input.kernelResult.route.to !== "EXECUTING" ||
    input.kernelResult.snapshot.state !== "EXECUTING" ||
    input.kernelResult.snapshot.phaseOwner !== "execution"
  ) {
    fail(
      "applied Kernel proof does not authorize the exact execution route, phase, capability, and workflow"
    );
  }
  assertFreshTimestamp(
    input.kernelResult.receipt.occurredAt,
    input.now,
    input.runtimePolicy.limits.maxEvidenceAgeMs,
    "applied Kernel proof"
  );
  return { controlPolicy, kernelResult: input.kernelResult };
}

function assertThreatEvidence(
  value: unknown,
  authorization: RuntimeAuthorization,
  modelOutputDigest: Digest,
  verifier: EvidenceVerifier,
  now: number,
  maximumEvidenceAgeMs: number
): EngineeringThreatEvidence {
  const evidence = record(value) as unknown as EngineeringThreatEvidence | null;
  if (
    evidence === null ||
    evidence.status !== "success" ||
    evidence.authorizationDigest !== authorization.authorizationDigest ||
    evidence.modelOutputDigest !== modelOutputDigest ||
    evidence.kernelReceiptDigest !== authorization.kernelReceiptDigest ||
    !verifier.verify(threatPayload(evidence), evidence.signature)
  ) {
    fail("signed exact-success threat evidence does not bind the output and Kernel proof");
  }
  const checkedAt = Date.parse(evidence.checkedAt);
  const expiresAt = Date.parse(evidence.expiresAt);
  if (
    !Number.isFinite(checkedAt) ||
    !Number.isFinite(expiresAt) ||
    checkedAt > now ||
    checkedAt < Date.parse(authorization.redeemedAt) ||
    now - checkedAt > maximumEvidenceAgeMs ||
    now >= expiresAt
  ) {
    fail("threat evidence is stale, future-dated, or expired");
  }
  return evidence;
}

export async function consumeTrustedPatchArtifact<T>(input: {
  readonly authorizationValue: unknown;
  readonly authorizationVerifier: RuntimeAuthorizationVerifier;
  readonly kernelResult: KernelResult;
  readonly runtimePolicyValue: unknown;
  readonly controlPolicyValue: unknown;
  readonly artifactValue: TrustedValidatedPatchArtifact;
  readonly patchBundleValue: TrustedValidatedPatchBundle;
  readonly threatEvidenceValue: unknown;
  readonly evidenceVerifier: EvidenceVerifier;
  readonly clock: ExecutionClock;
  readonly delivery: TrustedExecutionDeliveryPort<T>;
  readonly trustedDemoBinding?: TrustedDemoRuntimeBinding;
}): Promise<T> {
  const runtimePolicy = assertRuntimePolicy(input.runtimePolicyValue);
  rejectCallerEvidenceAge(input);
  return consumeTrustedPatchArtifactWithContext(input, runtimePolicy);
}

async function consumeTrustedPatchArtifactWithContext<T>(
  input: Parameters<typeof consumeTrustedPatchArtifact<T>>[0],
  runtimePolicy: CopilotRuntimePolicy,
  executionBundle?: {
    readonly observedAt: string;
    readonly expiresAt: string;
    readonly digest: Digest;
  }
): Promise<T> {
  const maximumEvidenceAgeMs = runtimePolicy.limits.maxEvidenceAgeMs;
  const now = trustedClockNow(input.clock);
  const authorization = validateRuntimeAuthorizationIntegrity(
    input.authorizationValue,
    input.authorizationVerifier
  );
  const { kernelResult } = assertExecutionKernelAuthorization({
    authorization,
    authorizationVerifier: input.authorizationVerifier,
    kernelResult: input.kernelResult,
    runtimePolicy,
    controlPolicyValue: input.controlPolicyValue,
    now: now.milliseconds,
    ...(input.trustedDemoBinding === undefined
      ? {}
      : { trustedDemoBinding: input.trustedDemoBinding })
  });
  const context = authorization.executionContext;
  if (context === null) {
    fail("authorization omits its signed execution context");
  }
  const grant = assertBoundedExecutionGrant(
    parseCanonical(context.canonicalExecutionGrant, "execution grant")
  );
  const artifact = assertDocument(
    "TrustedValidatedPatchArtifact",
    input.artifactValue
  );
  const redeemedAt = Date.parse(authorization.redeemedAt);
  const createdAt = Date.parse(artifact.createdAt);
  const expiresAt = Date.parse(artifact.expiresAt);
  if (
    !Number.isFinite(redeemedAt) ||
    !Number.isFinite(createdAt) ||
    !Number.isFinite(expiresAt) ||
    redeemedAt > createdAt ||
    createdAt > now.milliseconds ||
    now.milliseconds - redeemedAt > maximumEvidenceAgeMs ||
    now.milliseconds - createdAt > maximumEvidenceAgeMs ||
    now.milliseconds >= expiresAt ||
    artifact.authorizationDigest !== authorization.authorizationDigest ||
    artifact.contractRevision !== authorization.contractRevision ||
    artifact.repositoryId !== authorization.repositoryId ||
    artifact.workItemNodeId !== authorization.workItemNodeId ||
    artifact.kernelReceiptDigest !== authorization.kernelReceiptDigest ||
    artifact.kernelProofDigest !== digest(input.kernelResult) ||
    artifact.planningArtifactDigest !== context.planningArtifactDigest ||
    artifact.executionGrantDigest !== context.executionGrantDigest ||
    artifact.baseSha !== grant.baseSha ||
    artifact.patchDigest !== digest(artifact.patch) ||
    artifact.treeDigest !==
      digest(
        artifact.files
          .map((file) => ({
            path: file.path,
            digest: file.afterDigest,
            mode: file.mode
          }))
          .sort((left, right) => left.path.localeCompare(right.path))
      ) ||
    !input.evidenceVerifier.verify(artifactPayload(artifact), artifact.signature)
  ) {
    fail("validated patch artifact is stale, unsigned, or substituted");
  }
  const threatEvidence = assertThreatEvidence(
    input.threatEvidenceValue,
    authorization,
    artifact.modelOutputDigest,
    input.evidenceVerifier,
    now.milliseconds,
    maximumEvidenceAgeMs
  );
  if (artifact.threatEvidenceDigest !== digest(threatEvidence)) {
    fail("validated patch artifact substituted its threat evidence");
  }
  validateTrustedValidatedPatchBundle({
    bundle: input.patchBundleValue,
    verifier: input.evidenceVerifier,
    bindingDigest: authorization.bindingDigest,
    workAccordDigest: authorization.contractDigest,
    executionGrantDigest: context.executionGrantDigest,
    kernelReceiptDigest: authorization.kernelReceiptDigest,
    modelOutputDigest: artifact.modelOutputDigest,
    now: now.text
  });
  assertFreshTimestamp(
    input.patchBundleValue.createdAt,
    now.milliseconds,
    maximumEvidenceAgeMs,
    "signed patch bundle"
  );
  if (
    input.patchBundleValue.baseSha !== artifact.baseSha ||
    input.patchBundleValue.patch !== artifact.patch ||
    input.patchBundleValue.patchDigest !== artifact.patchDigest ||
    input.patchBundleValue.treeDigest !== artifact.treeDigest ||
    input.patchBundleValue.gitTreeSha !== artifact.gitTreeSha ||
    digest(validatedFilesFromBundle(input.patchBundleValue.files)) !==
      digest(artifact.files)
  ) {
    fail("validated patch bundle differs from its authenticated artifact");
  }
  const deliveryNow = trustedClockNow(input.clock);
  if (deliveryNow.milliseconds < now.milliseconds) {
    fail("trusted clock moved backwards before delivery");
  }
  for (const [subject, observedAt] of [
    ["runtime authorization", authorization.redeemedAt],
    ["applied Kernel proof", kernelResult.receipt.occurredAt],
    ["threat evidence", threatEvidence.checkedAt],
    ["validated patch artifact", artifact.createdAt],
    ["signed patch bundle", input.patchBundleValue.createdAt],
    ...(executionBundle === undefined
      ? []
      : [["execution bundle", executionBundle.observedAt] as const])
  ] as const) {
    assertFreshTimestamp(
      observedAt,
      deliveryNow.milliseconds,
      maximumEvidenceAgeMs,
      subject
    );
  }
  for (const [subject, expiresAtValue] of [
    ["runtime authorization", authorization.expiresAt],
    ["threat evidence", threatEvidence.expiresAt],
    ["validated patch artifact", artifact.expiresAt],
    ["signed patch bundle", input.patchBundleValue.expiresAt],
    ...(executionBundle === undefined
      ? []
      : [["execution bundle", executionBundle.expiresAt] as const])
  ] as const) {
    assertUnexpired(expiresAtValue, deliveryNow.milliseconds, subject);
  }
  return input.delivery.deliver({
    authorization,
    artifact,
    patchBundle: input.patchBundleValue,
    freshnessAuthority: issueTrustedExecutionFreshnessAuthority({
      runtimePolicy,
      runtimePolicyDigest: digest(runtimePolicy),
      authorization,
      authorizationDigest: authorization.authorizationDigest,
      kernelReceiptDigest: kernelResult.receiptDigest,
      kernelProofDigest: digest(kernelResult),
      threatEvidenceDigest: digest(threatEvidence),
      patchArtifactDigest: digest(artifact),
      patchBundleDigest: digest(input.patchBundleValue),
      executionBundleDigest: executionBundle?.digest ?? null,
      executionGrantDigest: artifact.executionGrantDigest,
      modelOutputDigest: artifact.modelOutputDigest,
      clock: input.clock,
      evidence: {
        runtimeAuthorization: {
          observedAt: authorization.redeemedAt,
          expiresAt: authorization.expiresAt
        },
        kernelProof: { observedAt: kernelResult.receipt.occurredAt },
        threatEvidence: {
          observedAt: threatEvidence.checkedAt,
          expiresAt: threatEvidence.expiresAt
        },
        patchArtifact: {
          observedAt: artifact.createdAt,
          expiresAt: artifact.expiresAt
        },
        patchBundle: {
          observedAt: input.patchBundleValue.createdAt,
          expiresAt: input.patchBundleValue.expiresAt
        },
        executionBundle: executionBundle ?? null
      }
    })
  });
}

export async function consumeTrustedExecutionBundle<T>(input: {
  readonly bundleValue: unknown;
  readonly authorizationVerifier: RuntimeAuthorizationVerifier;
  readonly evidenceVerifier: EvidenceVerifier;
  readonly runtimePolicyValue: unknown;
  readonly controlPolicyValue: unknown;
  readonly clock: ExecutionClock;
  readonly artifactConsumptionProof: AuthenticatedArtifactConsumptionProof;
  readonly delivery: TrustedExecutionDeliveryPort<T>;
  readonly trustedDemoBinding?: TrustedDemoRuntimeBinding;
}): Promise<T> {
  const runtimePolicy = assertRuntimePolicy(input.runtimePolicyValue);
  rejectCallerEvidenceAge(input);
  assertAuthenticatedArtifactConsumptionProof(input.artifactConsumptionProof);
  const maximumEvidenceAgeMs = runtimePolicy.limits.maxEvidenceAgeMs;
  const bundle = record(input.bundleValue) as unknown as TrustedExecutionBundle | null;
  if (
    bundle === null ||
    Object.keys(bundle).sort().join(",") !==
      "artifact,authorization,controlPolicyDigest,createdAt,expiresAt,kernelResult,patchBundle,runtimePolicyDigest,schemaVersion,signature,threatEvidence" ||
    bundle.schemaVersion !== "1.0.0" ||
    bundle.runtimePolicyDigest !== digest(runtimePolicy) ||
    bundle.controlPolicyDigest !== digest(input.controlPolicyValue) ||
    bundle.artifact.authorizationDigest !==
      bundle.authorization.authorizationDigest ||
    bundle.artifact.kernelProofDigest !== digest(bundle.kernelResult) ||
    bundle.artifact.threatEvidenceDigest !== digest(bundle.threatEvidence) ||
    bundle.patchBundle.bindingDigest !== bundle.authorization.bindingDigest ||
    bundle.patchBundle.workAccordDigest !== bundle.authorization.contractDigest ||
    bundle.patchBundle.executionGrantDigest !==
      bundle.artifact.executionGrantDigest ||
    bundle.patchBundle.kernelReceiptDigest !==
      bundle.authorization.kernelReceiptDigest ||
    bundle.patchBundle.modelOutputDigest !== bundle.artifact.modelOutputDigest ||
    bundle.patchBundle.baseSha !== bundle.artifact.baseSha ||
    bundle.patchBundle.patch !== bundle.artifact.patch ||
    bundle.patchBundle.patchDigest !== bundle.artifact.patchDigest ||
    bundle.patchBundle.treeDigest !== bundle.artifact.treeDigest ||
    bundle.patchBundle.gitTreeSha !== bundle.artifact.gitTreeSha ||
    digest(validatedFilesFromBundle(bundle.patchBundle.files)) !==
      digest(bundle.artifact.files) ||
    bundle.expiresAt !== bundle.artifact.expiresAt ||
    !input.evidenceVerifier.verify(bundlePayload(bundle), bundle.signature)
  ) {
    fail("execution bundle is unsigned, incomplete, or substituted");
  }
  const now = trustedClockNow(input.clock);
  const createdAt = Date.parse(bundle.createdAt);
  const expiresAt = Date.parse(bundle.expiresAt);
  if (
    !Number.isFinite(createdAt) ||
    !Number.isFinite(expiresAt) ||
    createdAt > now.milliseconds ||
    now.milliseconds - createdAt > maximumEvidenceAgeMs ||
    now.milliseconds >= expiresAt
  ) {
    fail("execution bundle is stale, future-dated, or expired");
  }
  return consumeTrustedPatchArtifactWithContext({
    authorizationValue: bundle.authorization,
    authorizationVerifier: input.authorizationVerifier,
    kernelResult: bundle.kernelResult,
    runtimePolicyValue: runtimePolicy,
    controlPolicyValue: input.controlPolicyValue,
    artifactValue: bundle.artifact,
    patchBundleValue: bundle.patchBundle,
    threatEvidenceValue: bundle.threatEvidence,
    evidenceVerifier: input.evidenceVerifier,
    clock: input.clock,
    delivery: input.delivery,
    ...(input.trustedDemoBinding === undefined
      ? {}
      : { trustedDemoBinding: input.trustedDemoBinding })
  }, runtimePolicy, {
    observedAt: bundle.createdAt,
    expiresAt: bundle.expiresAt,
    digest: digest(bundle)
  });
}

export async function runTrustedExecutionBridge<T>(input: {
  readonly repositoryPath: string;
  readonly authorizationValue: unknown;
  readonly authorizationVerifier: RuntimeAuthorizationVerifier;
  readonly kernelResult: KernelResult;
  readonly runtimePolicyValue: unknown;
  readonly controlPolicyValue: unknown;
  readonly envelopeValue: unknown;
  readonly clock: ExecutionClock;
  readonly threatEvidenceValue: unknown;
  readonly evidenceSigner: EvidenceSigner;
  readonly evidenceVerifier: EvidenceVerifier;
  readonly handoff: TrustedExecutionBundlePort<T>;
  readonly executePatch?: typeof executeBoundedWorktree;
  readonly trustedDemoBinding?: TrustedDemoRuntimeBinding;
}): Promise<TrustedExecutionBridgeResult<T>> {
  const runtimePolicy = assertRuntimePolicy(input.runtimePolicyValue);
  rejectCallerEvidenceAge(input);
  const maximumEvidenceAgeMs = runtimePolicy.limits.maxEvidenceAgeMs;
  const now = trustedClockNow(input.clock);
  const authorization = validateRuntimeAuthorizationIntegrity(
    input.authorizationValue,
    input.authorizationVerifier
  );
  const { controlPolicy, kernelResult } = assertExecutionKernelAuthorization({
    authorization,
    authorizationVerifier: input.authorizationVerifier,
    kernelResult: input.kernelResult,
    runtimePolicy,
    controlPolicyValue: input.controlPolicyValue,
    now: now.milliseconds,
    ...(input.trustedDemoBinding === undefined
      ? {}
      : { trustedDemoBinding: input.trustedDemoBinding })
  });
  const context = authorization.executionContext;
  const redeemedAt = Date.parse(authorization.redeemedAt);
  const expiresAt = Date.parse(authorization.expiresAt);
  if (
    authorization.phase !== "execution" ||
    authorization.outputSchema !== "TargetFreePatch@1.0.0" ||
    context === null ||
    !Number.isFinite(redeemedAt) ||
    !Number.isFinite(expiresAt) ||
    redeemedAt > now.milliseconds ||
    now.milliseconds - redeemedAt > maximumEvidenceAgeMs ||
    now.milliseconds >= expiresAt
  ) {
    fail("authorization is stale or does not authorize bounded execution");
  }
  const accord = assertDocument(
    "WorkAccord",
    parseCanonical(context.canonicalWorkAccord, "Work Accord")
  );
  const grant = assertBoundedExecutionGrant(
    parseCanonical(context.canonicalExecutionGrant, "execution grant")
  );
  if (
    digest(accord) !== authorization.contractDigest ||
    accord.identity.revision !== authorization.contractRevision ||
    digest(grant) !== context.executionGrantDigest ||
    context.planningArtifactDigest !== digest(context.planningArtifact) ||
    grant.repositoryId !== authorization.repositoryId ||
    grant.workItemNodeId !== authorization.workItemNodeId ||
    grant.workAccordDigest !== authorization.contractDigest ||
    grant.activationLeaseDigest !== authorization.activationLeaseDigest ||
    grant.routeId !== "planning.execute" ||
    context.planningArtifact.targetSlots.some(
      (slot) => !grant.targets.some((target) => target.slot === slot)
    ) ||
    context.planningArtifact.verificationIds.some(
      (commandId) => !grant.verificationCommandIds.includes(commandId)
    )
  ) {
    fail("signed plan, grant, Work Accord, and authorization are not identical");
  }
  const envelope = assertPatchEnvelope(input.envelopeValue);
  const modelOutputDigest = digest(envelope);
  if (
    envelope.planningArtifactDigest !== context.planningArtifactDigest ||
    envelope.executionGrantDigest !== context.executionGrantDigest
  ) {
    fail("model patch substituted its signed planning or execution grant");
  }
  const narrowedGrant: BoundedExecutionGrant = {
    ...grant,
    targets: grant.targets.filter((target) =>
      context.planningArtifact.targetSlots.includes(target.slot)
    ),
    verificationCommandIds: context.planningArtifact.verificationIds,
    maxFiles: Math.min(
      grant.maxFiles,
      context.planningArtifact.targetSlots.length
    )
  };
  const validatedPatch = (input.executePatch ?? executeBoundedWorktree)({
    repositoryPath: input.repositoryPath,
    accord: accord as WorkAccord,
    grant: narrowedGrant,
    patch: envelope.patch,
    clock: input.clock
  });
  const deliveryNow = trustedClockNow(input.clock);
  if (
    deliveryNow.milliseconds < now.milliseconds ||
    deliveryNow.milliseconds - redeemedAt > maximumEvidenceAgeMs ||
    deliveryNow.milliseconds >= expiresAt
  ) {
    fail("authorization expired before trusted delivery");
  }
  const threatEvidence = assertThreatEvidence(
    input.threatEvidenceValue,
    authorization,
    modelOutputDigest,
    input.evidenceVerifier,
    deliveryNow.milliseconds,
    maximumEvidenceAgeMs
  );
  const expiresAtIso =
    Date.parse(threatEvidence.expiresAt) < expiresAt
      ? threatEvidence.expiresAt
      : authorization.expiresAt;
  const payload = {
    schemaVersion: "1.0.0",
    authorizationDigest: authorization.authorizationDigest,
    contractRevision: authorization.contractRevision,
    repositoryId: authorization.repositoryId,
    workItemNodeId: authorization.workItemNodeId,
    baseSha: validatedPatch.baseSha,
    planningArtifactDigest: context.planningArtifactDigest,
    executionGrantDigest: context.executionGrantDigest,
    modelOutputDigest,
    threatEvidenceDigest: digest(threatEvidence),
    kernelReceiptDigest: authorization.kernelReceiptDigest,
    kernelProofDigest: digest(kernelResult),
    patch: validatedPatch.patch,
    patchDigest: validatedPatch.patchDigest,
    treeDigest: validatedPatch.treeDigest,
    gitTreeSha: validatedPatch.gitTreeSha,
    files: validatedPatch.files,
    verification: validatedPatch.verification,
    createdAt: deliveryNow.text,
    expiresAt: expiresAtIso
  } as const;
  const artifact: TrustedValidatedPatchArtifact = {
    ...payload,
    signature: await input.evidenceSigner.sign(payload)
  };
  const patchBundle = await issueTrustedValidatedPatchBundle({
    patch: validatedPatch,
    contentsBySlot: Object.fromEntries(
      envelope.patch.changes.map((change) => [change.slot, change.content])
    ),
    bindingDigest: authorization.bindingDigest,
    workAccordDigest: authorization.contractDigest,
    executionGrantDigest: context.executionGrantDigest,
    kernelReceiptDigest: authorization.kernelReceiptDigest,
    modelOutputDigest,
    createdAt: payload.createdAt,
    expiresAt: expiresAtIso,
    signer: input.evidenceSigner
  });
  const bundleCreatedAt = trustedClockNow(input.clock);
  const bundlePayloadValue = {
    schemaVersion: "1.0.0",
    authorization,
    kernelResult,
    runtimePolicyDigest: digest(runtimePolicy),
    controlPolicyDigest: digest(controlPolicy),
    threatEvidence,
    artifact,
    patchBundle,
    createdAt: bundleCreatedAt.text,
    expiresAt: expiresAtIso
  } as const;
  const bundle: TrustedExecutionBundle = {
    ...bundlePayloadValue,
    signature: await input.evidenceSigner.sign(bundlePayloadValue)
  };
  const handoffNow = trustedClockNow(input.clock);
  if (handoffNow.milliseconds < bundleCreatedAt.milliseconds) {
    fail("trusted clock moved backwards before handoff");
  }
  for (const [subject, observedAt] of [
    ["runtime authorization", authorization.redeemedAt],
    ["applied Kernel proof", kernelResult.receipt.occurredAt],
    ["threat evidence", threatEvidence.checkedAt],
    ["validated patch artifact", artifact.createdAt],
    ["signed patch bundle", patchBundle.createdAt],
    ["execution bundle", bundle.createdAt]
  ] as const) {
    assertFreshTimestamp(
      observedAt,
      handoffNow.milliseconds,
      maximumEvidenceAgeMs,
      subject
    );
  }
  for (const [subject, evidenceExpiresAt] of [
    ["runtime authorization", authorization.expiresAt],
    ["threat evidence", threatEvidence.expiresAt],
    ["validated patch artifact", artifact.expiresAt],
    ["signed patch bundle", patchBundle.expiresAt],
    ["execution bundle", bundle.expiresAt]
  ] as const) {
    assertUnexpired(evidenceExpiresAt, handoffNow.milliseconds, subject);
  }
  const handoff = await input.handoff.persist(bundle);
  return { validatedPatch, artifact, bundle, handoff };
}
