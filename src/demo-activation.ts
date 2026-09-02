import { canonicalJson, digest } from "./canonical.js";
import {
  validateDemoContract,
  validateDemoProjectContractSet
} from "./demo-portfolio.js";
import type {
  DemoProjectContractSet,
  DemoProjectId,
  DemoSignature,
  DemoRunState
} from "./demo-types.js";
import {
  createDemoBudgetState,
  demoBudgetAuthorityDigest,
  validateDemoBudgetState,
  type DemoBudgetState,
  type DemoRuntimeAuthority
} from "./demo-runtime-state.js";
import type { ActivationLease, Digest, WorkAccord } from "./types.js";
import { assertDocument, isCanonicalUtcDateTime } from "./validation.js";
import { workAccordBindingDigest } from "./binding.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const CLAIM_KEY_ID = /^[A-Za-z0-9._:-]{1,256}$/u;

export interface DemoEvidenceSigner {
  sign(payload: unknown): Promise<DemoSignature>;
}

export interface DemoEvidenceVerifier {
  verify(payload: unknown, signature: DemoSignature): boolean;
}

export interface DemoRecoveryBudgetEvidence {
  readonly schemaVersion: "1.0.0";
  readonly budgetBeforeDigest: Digest;
  readonly budgetAfterDigest: Digest;
  readonly kernelReceiptDigest: Digest;
  readonly runStateDigest: Digest;
  readonly generationBefore: number;
  readonly generationAfter: number;
  readonly retriesBefore: number;
  readonly retriesAfter: number;
  readonly recordedAt: string;
  readonly signature: DemoSignature;
}

export interface SignedDemoActivationLease {
  readonly apiVersion: "agentic-framework.github.com/v1alpha1";
  readonly kind: "SignedDemoActivationLease";
  readonly schemaVersion: "1.0.0";
  readonly evidenceDigest: Digest;
  readonly demoProjectId: DemoProjectId;
  readonly catalogDigest: Digest;
  readonly projectProfileDigest: Digest;
  readonly stageAgentBindingsDigest: Digest;
  readonly capabilityShardDigest: Digest;
  readonly repositoryId: number;
  readonly workItemNodeId: string;
  readonly repositoryBindingDigest: Digest;
  readonly projectBindingDigest: Digest;
  readonly workAccordDigest: Digest;
  readonly authorityEpoch: number;
  readonly revocationGeneration: number;
  readonly issuedAt: string;
  readonly lease: ActivationLease;
  readonly signature: DemoSignature;
}

export interface DemoActivationClaim {
  readonly schemaVersion: "1.0.0";
  readonly claimKey: Digest;
  readonly demoProjectId: DemoProjectId;
  readonly repositoryId: number;
  readonly workItemNodeId: string;
  readonly authorityEpoch: number;
  readonly generation: number;
  readonly revocationGeneration: number;
  readonly sourceEventDigest: Digest;
  readonly submitterId: number;
  readonly consentDigest: Digest;
  readonly activationProfileDigest: Digest;
  readonly activationLeaseDigest: Digest;
  readonly activationLeaseEvidenceDigest: Digest;
  readonly budgetAuthorityDigest: Digest;
  readonly recoveryBudgetEvidenceDigest: Digest | null;
  readonly runStateDigest: Digest;
  readonly claimedAt: string;
}

export interface DemoActivationClaimReceipt {
  readonly schemaVersion: "1.0.0";
  readonly storeId: string;
  readonly sequence: number;
  readonly previousHead: Digest | null;
  readonly claim: DemoActivationClaim;
  readonly status: "appended";
  readonly head: Digest;
  readonly persistedAt: string;
  readonly signature: DemoSignature;
}

export interface DemoActivationClaimResult {
  readonly status: "appended" | "existing" | "conflict";
  readonly receipt: DemoActivationClaimReceipt | null;
}

export interface DemoActivationClaimStore {
  claim(claim: DemoActivationClaim): Promise<DemoActivationClaimResult>;
  read(claimKey: Digest): Promise<DemoActivationClaimReceipt | null>;
}

export interface DemoActivationRequest {
  readonly demoProjectId: DemoProjectId;
  readonly repositoryId: number;
  readonly workItemNodeId: string;
  readonly source: "issue-form";
  readonly sourceEventDigest: Digest;
  readonly submitterId: number;
  readonly consent: {
    readonly field: string;
    readonly accepted: true;
    readonly evidenceDigest: Digest;
  };
  readonly catalogDigest: Digest;
  readonly projectProfileDigest: Digest;
  readonly stageAgentBindingsDigest: Digest;
  readonly capabilityShardDigest: Digest;
  readonly repositoryBindingDigest: Digest;
  readonly projectBindingDigest: Digest;
  readonly authorityEpoch: number;
  readonly generation: number;
  readonly revocationGeneration: number;
  readonly observedAt: string;
}

export interface DemoActivationGrant {
  readonly apiVersion: "agentic-framework.github.com/v1alpha1";
  readonly kind: "DemoActivationGrant";
  readonly schemaVersion: "1.0.0";
  readonly contentDigest: Digest;
  readonly spec: {
    readonly demoProjectId: DemoProjectId;
    readonly repositoryId: number;
    readonly workItemNodeId: string;
    readonly authorityEpoch: number;
    readonly generation: number;
    readonly revocationGeneration: number;
    readonly sourceEventDigest: Digest;
    readonly activationProfileDigest: Digest;
    readonly activationLeaseDigest: Digest;
    readonly activationLeaseEvidenceDigest: Digest;
    readonly budgetAuthorityDigest: Digest;
    readonly recoveryBudgetEvidenceDigest: Digest | null;
    readonly runStateDigest: Digest;
    readonly claimKey: Digest;
    readonly claimReceiptDigest: Digest;
    readonly activatedAt: string;
    readonly expiresAt: string;
  };
}

export class DemoActivationClaimAmbiguousError extends Error {
  constructor(message = "activation claim acknowledgement is ambiguous") {
    super(message);
    this.name = "DemoActivationClaimAmbiguousError";
  }
}

export class DemoActivationError extends Error {
  constructor(
    readonly code:
      | "ACTIVATION_INVALID"
      | "ACTIVATION_EXPIRED"
      | "ACTIVATION_REVOKED"
      | "ACTIVATION_REPLAY"
      | "ACTIVATION_AMBIGUOUS",
    message: string
  ) {
    super(message);
    this.name = "DemoActivationError";
  }
}

function fail(
  code: DemoActivationError["code"],
  message: string
): never {
  throw new DemoActivationError(code, message);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function stable<T>(value: T): T {
  return deepFreeze(JSON.parse(canonicalJson(value)) as T);
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  label: string
): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (
    actual.length !== required.length ||
    actual.some((key, index) => key !== required[index])
  ) {
    fail("ACTIVATION_INVALID", `${label} fields are not closed`);
  }
}

function timestamp(value: string, label: string): number {
  if (!isCanonicalUtcDateTime(value)) {
    fail("ACTIVATION_INVALID", `${label} is not a canonical UTC timestamp`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    fail("ACTIVATION_INVALID", `${label} is not a real timestamp`);
  }
  return parsed;
}

function positive(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail("ACTIVATION_INVALID", `${label} must be a positive safe integer`);
  }
}

function nonNegative(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("ACTIVATION_INVALID", `${label} must be a non-negative safe integer`);
  }
}

function leasePayload(
  evidence: SignedDemoActivationLease
): Omit<SignedDemoActivationLease, "evidenceDigest" | "signature"> {
  const {
    evidenceDigest: _evidenceDigest,
    signature: _signature,
    ...payload
  } = evidence;
  return payload;
}

function claimReceiptPayload(
  receipt: DemoActivationClaimReceipt
): Omit<DemoActivationClaimReceipt, "signature"> {
  const { signature: _signature, ...payload } = receipt;
  return payload;
}

function claimReceiptDigest(receipt: DemoActivationClaimReceipt): Digest {
  return digest(claimReceiptPayload(receipt));
}

function recoveryBudgetEvidencePayload(
  evidence: DemoRecoveryBudgetEvidence
): Omit<DemoRecoveryBudgetEvidence, "signature"> {
  const { signature: _signature, ...payload } = evidence;
  return payload;
}

function grantContentDigest(spec: DemoActivationGrant["spec"]): Digest {
  return digest({
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "DemoActivationGrant",
    schemaVersion: "1.0.0",
    spec
  });
}

function assertExactLease(input: {
  readonly evidence: SignedDemoActivationLease;
  readonly verifier: DemoEvidenceVerifier;
  readonly request: DemoActivationRequest;
  readonly contracts: DemoProjectContractSet;
  readonly workAccord: WorkAccord;
  readonly now: number;
}): ActivationLease {
  const evidence = stable(input.evidence);
  const lease = stable(assertDocument("ActivationLease", evidence.lease));
  exactKeys(
    evidence as unknown as Readonly<Record<string, unknown>>,
    [
      "apiVersion",
      "kind",
      "schemaVersion",
      "evidenceDigest",
      "demoProjectId",
      "catalogDigest",
      "projectProfileDigest",
      "stageAgentBindingsDigest",
      "capabilityShardDigest",
      "repositoryId",
      "workItemNodeId",
      "repositoryBindingDigest",
      "projectBindingDigest",
      "workAccordDigest",
      "authorityEpoch",
      "revocationGeneration",
      "issuedAt",
      "lease",
      "signature"
    ],
    "SignedDemoActivationLease"
  );
  const payload = leasePayload(evidence);
  const expectedEvidenceDigest = digest(payload);
  const profile = input.contracts.activation;
  const modelCapabilities = input.contracts.bindings.spec.stageBindings.flatMap(
    (entry) => entry.runtimeBindings.map((binding) => binding.capability)
  );
  const activePhases = [
    "execution",
    "framing",
    "human-review",
    "planning",
    "verification"
  ] as const;
  if (
    evidence.apiVersion !== "agentic-framework.github.com/v1alpha1" ||
    evidence.kind !== "SignedDemoActivationLease" ||
    evidence.schemaVersion !== "1.0.0" ||
    evidence.evidenceDigest !== expectedEvidenceDigest ||
    evidence.signature.algorithm !== "ed25519" ||
    evidence.signature.keyId !== profile.spec.signingKeyId ||
    !input.verifier.verify(payload, evidence.signature) ||
    evidence.demoProjectId !== input.request.demoProjectId ||
    evidence.catalogDigest !== input.request.catalogDigest ||
    evidence.projectProfileDigest !== input.request.projectProfileDigest ||
    evidence.stageAgentBindingsDigest !==
      input.request.stageAgentBindingsDigest ||
    evidence.capabilityShardDigest !== input.request.capabilityShardDigest ||
    evidence.repositoryId !== input.request.repositoryId ||
    evidence.workItemNodeId !== input.request.workItemNodeId ||
    evidence.repositoryBindingDigest !==
      input.request.repositoryBindingDigest ||
    evidence.projectBindingDigest !== input.request.projectBindingDigest ||
    evidence.workAccordDigest !== digest(input.workAccord) ||
    evidence.authorityEpoch !== input.request.authorityEpoch ||
    evidence.revocationGeneration !== input.request.revocationGeneration ||
    lease.workAccordDigest !== digest(input.workAccord) ||
    lease.maxCalls !== profile.spec.leaseTemplate.maxCalls ||
    lease.maxTokens !== profile.spec.leaseTemplate.maxTokens ||
    lease.maxCostUnits !== profile.spec.leaseTemplate.maxCostUnits ||
    lease.maxParallel !== profile.spec.leaseTemplate.maxParallel ||
    canonicalJson([...lease.allowedCapabilities].sort()) !==
      canonicalJson([...modelCapabilities].sort()) ||
    canonicalJson([...lease.allowedPhases].sort()) !==
      canonicalJson(activePhases)
  ) {
    fail(
      "ACTIVATION_INVALID",
      "signed activation lease is untrusted, substituted, or not the fixed reviewed grant"
    );
  }
  const issuedAt = timestamp(evidence.issuedAt, "activation lease issuedAt");
  const expiresAt = timestamp(lease.expiresAt, "activation lease expiresAt");
  if (issuedAt > input.now || input.now >= expiresAt) {
    fail("ACTIVATION_EXPIRED", "signed activation lease is not current");
  }
  if (lease.revoked) {
    fail("ACTIVATION_REVOKED", "signed activation lease is revoked");
  }
  return lease;
}

function assertActivationBudget(input: {
  readonly budget: DemoBudgetState;
  readonly request: DemoActivationRequest;
  readonly contracts: DemoProjectContractSet;
  readonly workAccord: WorkAccord;
  readonly lease: ActivationLease;
  readonly priorBudget: DemoBudgetState | null;
  readonly recoveryEvidence: DemoRecoveryBudgetEvidence | null;
  readonly recoveryVerifier: DemoEvidenceVerifier;
}): DemoBudgetState {
  const profile = input.contracts.activation;
  const expectedExpiry =
    Date.parse(profile.spec.expiresAt) <= Date.parse(input.lease.expiresAt)
      ? profile.spec.expiresAt
      : input.lease.expiresAt;
  const budget = validateDemoBudgetState(input.budget);
  const initialGeneration = input.request.generation === 0;
  if (
    budget.spec.demoProjectId !== input.request.demoProjectId ||
    budget.spec.repositoryId !== input.request.repositoryId ||
    budget.spec.workItemNodeId !== input.request.workItemNodeId ||
    budget.spec.authorityEpoch !== input.request.authorityEpoch ||
    budget.spec.generation !== input.request.generation ||
    budget.spec.activationLeaseDigest !== digest(input.lease) ||
    budget.spec.workAccordDigest !== digest(input.workAccord) ||
    canonicalJson(budget.spec.limits) !==
      canonicalJson(profile.spec.leaseTemplate) ||
    budget.spec.expiresAt !== expectedExpiry ||
    Date.parse(budget.spec.startedAt) > Date.parse(input.request.observedAt) ||
    (initialGeneration &&
      (canonicalJson(budget.spec.usage) !==
        canonicalJson({ calls: 0, tokens: 0, costUnits: 0, retries: 0 }) ||
        canonicalJson(budget.spec.held) !==
          canonicalJson({ calls: 0, tokens: 0, costUnits: 0 }) ||
        budget.spec.startedAt !== input.request.observedAt ||
        budget.spec.ledgerVersion !== 0 ||
        budget.spec.ledgerHead !== null)) ||
    (!initialGeneration &&
      (budget.spec.ledgerVersion < 1 || budget.spec.ledgerHead === null))
  ) {
    fail(
      "ACTIVATION_INVALID",
      "initial budget is not the exact fixed, empty activation allocation"
    );
  }
  if (initialGeneration) {
    if (input.priorBudget !== null || input.recoveryEvidence !== null) {
      fail(
        "ACTIVATION_INVALID",
        "initial activation cannot carry recovery budget evidence"
      );
    }
    return budget;
  }
  if (input.priorBudget === null || input.recoveryEvidence === null) {
    fail(
      "ACTIVATION_INVALID",
      "later-generation activation requires its prior budget and signed recovery transition"
    );
  }
  const prior = validateDemoBudgetState(input.priorBudget);
  const evidence = stable(input.recoveryEvidence);
  exactKeys(
    evidence as unknown as Readonly<Record<string, unknown>>,
    [
      "schemaVersion",
      "budgetBeforeDigest",
      "budgetAfterDigest",
      "kernelReceiptDigest",
      "runStateDigest",
      "generationBefore",
      "generationAfter",
      "retriesBefore",
      "retriesAfter",
      "recordedAt",
      "signature"
    ],
    "DemoRecoveryBudgetEvidence"
  );
  const generationDelta =
    evidence.generationAfter - evidence.generationBefore;
  const retryDelta = evidence.retriesAfter - evidence.retriesBefore;
  const operationDigest = digest({
    domain: "agentic-framework.demo-recovery-budget.v1",
    budgetBeforeDigest: prior.contentDigest,
    kernelReceiptDigest: evidence.kernelReceiptDigest,
    runStateDigest: evidence.runStateDigest,
    generationBefore: evidence.generationBefore,
    generationAfter: evidence.generationAfter,
    retriesBefore: evidence.retriesBefore,
    retriesAfter: evidence.retriesAfter
  });
  const expected = createDemoBudgetState({
    ...prior.spec,
    generation: evidence.generationAfter,
    usage: {
      ...prior.spec.usage,
      retries: evidence.retriesAfter
    },
    ledgerVersion: prior.spec.ledgerVersion + 1,
    ledgerHead: digest({
      domain: "agentic-framework.demo-budget-ledger.v1",
      previousHead: prior.spec.ledgerHead,
      operationDigest
    })
  });
  if (
    evidence.schemaVersion !== "1.0.0" ||
    generationDelta !== 1 ||
    retryDelta < 0 ||
    retryDelta > 1 ||
    evidence.generationBefore !== prior.spec.generation ||
    evidence.generationAfter !== budget.spec.generation ||
    evidence.retriesBefore !== prior.spec.usage.retries ||
    evidence.retriesAfter !== budget.spec.usage.retries ||
    evidence.budgetBeforeDigest !== prior.contentDigest ||
    evidence.budgetAfterDigest !== budget.contentDigest ||
    timestamp(evidence.recordedAt, "recovery budget recordedAt") >
      timestamp(input.request.observedAt, "activation observedAt") ||
    canonicalJson(expected) !== canonicalJson(budget) ||
    !input.recoveryVerifier.verify(
      recoveryBudgetEvidencePayload(evidence),
      evidence.signature
    )
  ) {
    fail(
      "ACTIVATION_INVALID",
      "later-generation budget does not authenticate one monotone recovery successor"
    );
  }
  return budget;
}

function validateClaimReceipt(input: {
  readonly receipt: DemoActivationClaimReceipt;
  readonly claim: DemoActivationClaim;
  readonly verifier: DemoEvidenceVerifier;
}): DemoActivationClaimReceipt {
  const receipt = stable(input.receipt);
  exactKeys(
    receipt as unknown as Readonly<Record<string, unknown>>,
    [
      "schemaVersion",
      "storeId",
      "sequence",
      "previousHead",
      "claim",
      "status",
      "head",
      "persistedAt",
      "signature"
    ],
    "DemoActivationClaimReceipt"
  );
  if (
    receipt.schemaVersion !== "1.0.0" ||
    !CLAIM_KEY_ID.test(receipt.storeId) ||
    !Number.isSafeInteger(receipt.sequence) ||
    receipt.sequence < 1 ||
    (receipt.previousHead !== null && !DIGEST.test(receipt.previousHead)) ||
    canonicalJson(receipt.claim) !== canonicalJson(input.claim) ||
    receipt.status !== "appended" ||
    receipt.head !==
      digest({
        storeId: receipt.storeId,
        sequence: receipt.sequence,
        previousHead: receipt.previousHead,
        claim: receipt.claim,
        status: receipt.status,
        persistedAt: receipt.persistedAt
      }) ||
    !input.verifier.verify(claimReceiptPayload(receipt), receipt.signature)
  ) {
    fail(
      "ACTIVATION_AMBIGUOUS",
      "activation claim receipt is not an authenticated append for the exact claim"
    );
  }
  timestamp(receipt.persistedAt, "activation claim persistedAt");
  return receipt;
}

async function reconcileAmbiguousClaim(input: {
  readonly store: DemoActivationClaimStore;
  readonly claim: DemoActivationClaim;
  readonly verifier: DemoEvidenceVerifier;
}): Promise<DemoActivationClaimReceipt> {
  const first = await input.store.read(input.claim.claimKey);
  const second = await input.store.read(input.claim.claimKey);
  if (
    first === null ||
    second === null ||
    canonicalJson(first) !== canonicalJson(second)
  ) {
    fail(
      "ACTIVATION_AMBIGUOUS",
      "ambiguous activation claim did not resolve to one stable authenticated record"
    );
  }
  return validateClaimReceipt({
    receipt: second,
    claim: input.claim,
    verifier: input.verifier
  });
}

export async function issueSignedDemoActivationLease(input: {
  readonly authority: DemoRuntimeAuthority;
  readonly request: DemoActivationRequest;
  readonly lease: ActivationLease;
  readonly issuedAt: string;
  readonly signer: DemoEvidenceSigner;
}): Promise<SignedDemoActivationLease> {
  const contracts = validateDemoProjectContractSet({
    catalog: input.authority.catalog,
    reservations: input.authority.reservations,
    lifecycle: input.authority.lifecycle,
    baseRegistry: input.authority.baseRegistry,
    contracts: input.authority.contracts
  });
  const workAccord = stable(
    assertDocument("WorkAccord", input.authority.workAccord)
  );
  const payload = {
    apiVersion: "agentic-framework.github.com/v1alpha1" as const,
    kind: "SignedDemoActivationLease" as const,
    schemaVersion: "1.0.0" as const,
    demoProjectId: input.request.demoProjectId,
    catalogDigest: input.request.catalogDigest,
    projectProfileDigest: input.request.projectProfileDigest,
    stageAgentBindingsDigest: input.request.stageAgentBindingsDigest,
    capabilityShardDigest: input.request.capabilityShardDigest,
    repositoryId: input.request.repositoryId,
    workItemNodeId: input.request.workItemNodeId,
    repositoryBindingDigest: input.request.repositoryBindingDigest,
    projectBindingDigest: input.request.projectBindingDigest,
    workAccordDigest: digest(workAccord),
    authorityEpoch: input.request.authorityEpoch,
    revocationGeneration: input.request.revocationGeneration,
    issuedAt: input.issuedAt,
    lease: stable(assertDocument("ActivationLease", input.lease))
  };
  if (
    contracts.profile.spec.demoProjectId !== input.request.demoProjectId ||
    contracts.activation.spec.signingKeyId.length === 0
  ) {
    fail("ACTIVATION_INVALID", "activation request does not select one reviewed profile");
  }
  const signature = await input.signer.sign(payload);
  return stable({
    ...payload,
    evidenceDigest: digest(payload),
    signature
  });
}

export async function activateDemoIssue(input: {
  readonly authority: DemoRuntimeAuthority;
  readonly request: DemoActivationRequest;
  readonly signedLease: SignedDemoActivationLease;
  readonly runState: unknown;
  readonly budget: DemoBudgetState;
  readonly priorBudget: DemoBudgetState | null;
  readonly recoveryBudgetEvidence: DemoRecoveryBudgetEvidence | null;
  readonly recoveryBudgetVerifier: DemoEvidenceVerifier;
  readonly leaseVerifier: DemoEvidenceVerifier;
  readonly claimStore: DemoActivationClaimStore;
  readonly claimVerifier: DemoEvidenceVerifier;
}): Promise<DemoActivationGrant> {
  const request = stable(input.request);
  exactKeys(
    request as unknown as Readonly<Record<string, unknown>>,
    [
      "demoProjectId",
      "repositoryId",
      "workItemNodeId",
      "source",
      "sourceEventDigest",
      "submitterId",
      "consent",
      "catalogDigest",
      "projectProfileDigest",
      "stageAgentBindingsDigest",
      "capabilityShardDigest",
      "repositoryBindingDigest",
      "projectBindingDigest",
      "authorityEpoch",
      "generation",
      "revocationGeneration",
      "observedAt"
    ],
    "DemoActivationRequest"
  );
  exactKeys(
    request.consent as unknown as Readonly<Record<string, unknown>>,
    ["field", "accepted", "evidenceDigest"],
    "DemoActivationRequest consent"
  );
  positive(request.repositoryId, "repositoryId");
  positive(request.submitterId, "submitterId");
  positive(request.authorityEpoch, "authorityEpoch");
  nonNegative(request.generation, "generation");
  nonNegative(request.revocationGeneration, "revocationGeneration");
  const now = timestamp(request.observedAt, "activation observedAt");
  const contracts = validateDemoProjectContractSet({
    catalog: input.authority.catalog,
    reservations: input.authority.reservations,
    lifecycle: input.authority.lifecycle,
    baseRegistry: input.authority.baseRegistry,
    contracts: input.authority.contracts
  });
  const catalog = validateDemoContract("DemoCatalog", input.authority.catalog);
  const workAccord = stable(
    assertDocument("WorkAccord", input.authority.workAccord)
  );
  const runState = validateDemoContract("DemoRunState", input.runState);
  const profile = contracts.activation;
  if (
    request.source !== profile.spec.allowedSource ||
    !profile.spec.allowedSubmitterIds.includes(request.submitterId) ||
    request.consent.field !== profile.spec.consentField ||
    request.consent.accepted !== true ||
    !DIGEST.test(request.consent.evidenceDigest) ||
    !DIGEST.test(request.sourceEventDigest)
  ) {
    fail(
      "ACTIVATION_INVALID",
      "activation source, submitter, or explicit consent is not pre-authorized"
    );
  }
  if (!profile.spec.enabled) {
    fail("ACTIVATION_REVOKED", "reviewed demo activation profile is disabled");
  }
  const validFrom = timestamp(profile.spec.validFrom, "profile validFrom");
  const profileExpiry = timestamp(profile.spec.expiresAt, "profile expiresAt");
  if (now < validFrom || now >= profileExpiry) {
    fail("ACTIVATION_EXPIRED", "reviewed demo activation profile is not current");
  }
  if (
    request.demoProjectId !== contracts.profile.spec.demoProjectId ||
    request.catalogDigest !== catalog.contentDigest ||
    request.projectProfileDigest !== contracts.profile.contentDigest ||
    request.stageAgentBindingsDigest !== contracts.bindings.contentDigest ||
    request.capabilityShardDigest !== contracts.capabilities.contentDigest ||
    request.repositoryBindingDigest !==
      contracts.profile.spec.repositoryBindingDigest ||
    request.projectBindingDigest !==
      contracts.profile.spec.projectBindingDigest ||
    request.authorityEpoch !== profile.spec.authorityEpoch ||
    request.revocationGeneration !== profile.spec.revocationGeneration ||
    request.repositoryId !== workAccord.binding.repositoryId ||
    request.workItemNodeId !== workAccord.binding.workItemNodeId ||
    request.demoProjectId !== runState.spec.demoProjectId ||
    request.repositoryId !== runState.spec.repositoryId ||
    request.workItemNodeId !== runState.spec.workItemNodeId ||
    request.authorityEpoch !== runState.spec.authorityEpoch ||
    request.generation !== runState.spec.generation ||
    request.projectProfileDigest !== runState.spec.projectProfileDigest ||
    request.stageAgentBindingsDigest !==
      runState.spec.stageAgentBindingsDigest ||
    request.capabilityShardDigest !== runState.spec.capabilityShardDigest ||
    profile.contentDigest !== runState.spec.activationProfileDigest ||
    (request.generation > 0 &&
      input.recoveryBudgetEvidence?.kernelReceiptDigest !==
        runState.spec.core.kernelReceiptDigest) ||
    workAccordBindingDigest(workAccord) !==
      digest({
        repositoryId: request.repositoryId,
        sourceDigest: workAccord.binding.sourceDigest,
        workItemNodeId: request.workItemNodeId
      })
  ) {
    fail(
      "ACTIVATION_INVALID",
      "activation does not bind the exact catalog, profile, authority, and work item"
    );
  }
  const lease = assertExactLease({
    evidence: input.signedLease,
    verifier: input.leaseVerifier,
    request,
    contracts,
    workAccord,
    now
  });
  const budget = assertActivationBudget({
    budget: input.budget,
    request,
    contracts,
    workAccord,
    lease,
    priorBudget: input.priorBudget,
    recoveryEvidence: input.recoveryBudgetEvidence,
    recoveryVerifier: input.recoveryBudgetVerifier
  });
  const claimKey = digest({
    operation: "activate-demo-issue",
    demoProjectId: request.demoProjectId,
    repositoryId: request.repositoryId,
    workItemNodeId: request.workItemNodeId,
    sourceEventDigest: request.sourceEventDigest,
    authorityEpoch: request.authorityEpoch,
    generation: request.generation,
    revocationGeneration: request.revocationGeneration
  });
  const claim: DemoActivationClaim = stable({
    schemaVersion: "1.0.0",
    claimKey,
    demoProjectId: request.demoProjectId,
    repositoryId: request.repositoryId,
    workItemNodeId: request.workItemNodeId,
    authorityEpoch: request.authorityEpoch,
    generation: request.generation,
    revocationGeneration: request.revocationGeneration,
    sourceEventDigest: request.sourceEventDigest,
    submitterId: request.submitterId,
    consentDigest: request.consent.evidenceDigest,
    activationProfileDigest: profile.contentDigest,
    activationLeaseDigest: digest(lease),
    activationLeaseEvidenceDigest: input.signedLease.evidenceDigest,
    budgetAuthorityDigest: demoBudgetAuthorityDigest(budget),
    recoveryBudgetEvidenceDigest:
      input.recoveryBudgetEvidence === null
        ? null
        : digest(input.recoveryBudgetEvidence),
    runStateDigest: runState.contentDigest,
    claimedAt: request.observedAt
  });

  let result: DemoActivationClaimResult;
  try {
    result = await input.claimStore.claim(claim);
  } catch (error) {
    if (!(error instanceof DemoActivationClaimAmbiguousError)) throw error;
    const receipt = await reconcileAmbiguousClaim({
      store: input.claimStore,
      claim,
      verifier: input.claimVerifier
    });
    result = { status: "existing", receipt };
  }
  if (result.status === "conflict" || result.receipt === null) {
    fail(
      "ACTIVATION_REPLAY",
      "activation claim key is already bound to different evidence"
    );
  }
  const receipt = validateClaimReceipt({
    receipt: result.receipt,
    claim,
    verifier: input.claimVerifier
  });
  const observed = await input.claimStore.read(claimKey);
  if (
    observed === null ||
    canonicalJson(observed) !== canonicalJson(receipt)
  ) {
    fail(
      "ACTIVATION_AMBIGUOUS",
      "activation claim was not durably observed before authorization"
    );
  }
  const expiresAt =
    Date.parse(profile.spec.expiresAt) <= Date.parse(lease.expiresAt)
      ? profile.spec.expiresAt
      : lease.expiresAt;
  const spec: DemoActivationGrant["spec"] = {
    demoProjectId: request.demoProjectId,
    repositoryId: request.repositoryId,
    workItemNodeId: request.workItemNodeId,
    authorityEpoch: request.authorityEpoch,
    generation: request.generation,
    revocationGeneration: request.revocationGeneration,
    sourceEventDigest: request.sourceEventDigest,
    activationProfileDigest: profile.contentDigest,
    activationLeaseDigest: digest(lease),
    activationLeaseEvidenceDigest: input.signedLease.evidenceDigest,
    budgetAuthorityDigest: demoBudgetAuthorityDigest(budget),
    recoveryBudgetEvidenceDigest:
      input.recoveryBudgetEvidence === null
        ? null
        : digest(input.recoveryBudgetEvidence),
    runStateDigest: runState.contentDigest,
    claimKey,
    claimReceiptDigest: claimReceiptDigest(receipt),
    activatedAt: receipt.persistedAt,
    expiresAt
  };
  return stable({
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "DemoActivationGrant",
    schemaVersion: "1.0.0",
    contentDigest: grantContentDigest(spec),
    spec
  });
}

export function validateDemoActivationGrant(input: {
  readonly grant: DemoActivationGrant;
  readonly receipt: DemoActivationClaimReceipt;
  readonly verifier: DemoEvidenceVerifier;
  readonly evaluatedAt: string;
}): DemoActivationGrant {
  const grant = stable(input.grant);
  exactKeys(
    grant as unknown as Readonly<Record<string, unknown>>,
    ["apiVersion", "kind", "schemaVersion", "contentDigest", "spec"],
    "DemoActivationGrant"
  );
  exactKeys(
    grant.spec as unknown as Readonly<Record<string, unknown>>,
    [
      "demoProjectId",
      "repositoryId",
      "workItemNodeId",
      "authorityEpoch",
      "generation",
      "revocationGeneration",
      "sourceEventDigest",
      "activationProfileDigest",
      "activationLeaseDigest",
      "activationLeaseEvidenceDigest",
      "budgetAuthorityDigest",
      "recoveryBudgetEvidenceDigest",
      "runStateDigest",
      "claimKey",
      "claimReceiptDigest",
      "activatedAt",
      "expiresAt"
    ],
    "DemoActivationGrant spec"
  );
  const receipt = validateClaimReceipt({
    receipt: input.receipt,
    claim: input.receipt.claim,
    verifier: input.verifier
  });
  const now = timestamp(input.evaluatedAt, "activation grant evaluatedAt");
  if (
    grant.apiVersion !== "agentic-framework.github.com/v1alpha1" ||
    grant.kind !== "DemoActivationGrant" ||
    grant.schemaVersion !== "1.0.0" ||
    grant.contentDigest !== grantContentDigest(grant.spec) ||
    grant.spec.claimKey !== receipt.claim.claimKey ||
    grant.spec.claimReceiptDigest !== claimReceiptDigest(receipt) ||
    grant.spec.demoProjectId !== receipt.claim.demoProjectId ||
    grant.spec.repositoryId !== receipt.claim.repositoryId ||
    grant.spec.workItemNodeId !== receipt.claim.workItemNodeId ||
    grant.spec.authorityEpoch !== receipt.claim.authorityEpoch ||
    grant.spec.generation !== receipt.claim.generation ||
    grant.spec.revocationGeneration !== receipt.claim.revocationGeneration ||
    grant.spec.sourceEventDigest !== receipt.claim.sourceEventDigest ||
    grant.spec.activationProfileDigest !==
      receipt.claim.activationProfileDigest ||
    grant.spec.activationLeaseDigest !==
      receipt.claim.activationLeaseDigest ||
    grant.spec.activationLeaseEvidenceDigest !==
      receipt.claim.activationLeaseEvidenceDigest ||
    grant.spec.budgetAuthorityDigest !==
      receipt.claim.budgetAuthorityDigest ||
    grant.spec.recoveryBudgetEvidenceDigest !==
      receipt.claim.recoveryBudgetEvidenceDigest ||
    grant.spec.runStateDigest !== receipt.claim.runStateDigest ||
    grant.spec.activatedAt !== receipt.persistedAt ||
    now >= timestamp(grant.spec.expiresAt, "activation grant expiresAt")
  ) {
    fail(
      "ACTIVATION_INVALID",
      "activation grant is stale or detached from its single-use claim"
    );
  }
  return grant;
}
