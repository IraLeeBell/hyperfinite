import { createHmac, timingSafeEqual } from "node:crypto";

import lifecycleDocument from "../config/v1alpha1/lifecycle.json" with { type: "json" };
import policyDocument from "../config/v1alpha1/policy.json" with { type: "json" };
import registryDocument from "../config/v1alpha1/capability-registry.json" with { type: "json" };
import domainPackDocument from "../config/v1alpha1/domain-pack-policy.json" with { type: "json" };
import runtimePolicyDocument from "../config/v1alpha1/copilot-runtime-policy.json" with { type: "json" };
import projectSchemaDocument from "../config/v1alpha1/github-project.json" with { type: "json" };
import framingPhaseDocument from "../config/v1alpha1/phase-contracts/framing.json" with { type: "json" };
import planningPhaseDocument from "../config/v1alpha1/phase-contracts/planning.json" with { type: "json" };
import executionPhaseDocument from "../config/v1alpha1/phase-contracts/execution.json" with { type: "json" };
import verificationPhaseDocument from "../config/v1alpha1/phase-contracts/verification.json" with { type: "json" };
import humanReviewPhaseDocument from "../config/v1alpha1/phase-contracts/human-review.json" with { type: "json" };
import baseAccordDocument from "../examples/v1alpha1/work-accord.json" with { type: "json" };
import liveProjectDocument from "../tests/fixtures/github/live-project.json" with { type: "json" };

import { workAccordBindingDigest } from "./binding.js";
import { canonicalJson, digest } from "./canonical.js";
import {
  GitHubEvidenceConflictError,
  GitHubExecutionError,
  GitHubSingleWriter,
  type GitHubActorAuthorizationSnapshot,
  type GitHubApi,
  type GitHubEffectObservation,
  type GitHubEffectPrecondition,
  type GitHubEvidenceHead,
  type GitHubEvidenceIdentity,
  type GitHubEvidenceRecord,
  type GitHubEvidenceServices,
  type GitHubEvidenceSignature,
  type GitHubExecutionState,
  type GitHubSignedEvidence
} from "./github-adapter.js";
import {
  GitHubAppCredentialBroker,
  type MintedInstallationGrant,
  type SignedGitHubAppIdentity
} from "./github-auth.js";
import {
  HmacWebhookSignatureVerifier,
  normalizeGitHubWebhook,
  type GitHubBindingReadApi,
  type GitHubInstallationScope,
  type GitHubIssueIdentity,
  type GitHubProjectItemIdentity,
  type GitHubPullRequestIdentity,
  type GitHubRepositoryIdentity,
  type TrustedGitHubBinding
} from "./github-events.js";
import { planProjectSetup, type LiveGitHubProject } from "./github-projects.js";
import { translateSafeOutput } from "./github-safe-output.js";
import type {
  GitHubEffectPlan,
  GitHubProjectBinding,
  GitHubProjectFieldValue,
  GitHubSafeOutput
} from "./github-types.js";
import {
  createInitialSnapshot,
  evaluateTransition,
  eventPayloadDigest,
  type KernelContext
} from "./kernel.js";
import {
  runtimeMaximumReservation,
  validateRuntimePreActivation,
  type RuntimeActivationRequest,
  type RuntimeFreshEvidence
} from "./copilot-runtime.js";
import {
  API_VERSION,
  type ActivationLease,
  type Actor,
  type ActorClass,
  type AuthorityRebind,
  type ContractRequirementEvidence,
  type ControlPolicy,
  type CopilotRuntimePolicy,
  type CopilotRuntimeState,
  type Digest,
  type DomainPackPolicy,
  type EventEnvelope,
  type EventType,
  type HumanGateEvidence,
  type KernelResult,
  type KernelSnapshot,
  type LifecycleGraph,
  type PhaseContract,
  type WorkAccord
} from "./types.js";
import { assertDocument, validateDocument } from "./validation.js";

const NOW = "2026-09-03T17:00:00.000Z";
const OBSERVED_AT = "2026-09-03T16:59:00.000Z";
const EXPIRES_AT = "2027-09-03T17:00:00.000Z";
const OLD_HEAD = "2222222222222222222222222222222222222222";
const NEW_HEAD = "3333333333333333333333333333333333333333";
const CLAIMANT_ID = digest({ walkthrough: "single-writer" });
const WEBHOOK_KEY = Buffer.from("0123456789abcdef0123456789abcdef");
const EVIDENCE_KEY = Buffer.from("walkthrough-evidence-key-32-bytes!");

const graph = assertDocument("LifecycleGraph", lifecycleDocument);
const controlPolicy = assertDocument("ControlPolicy", policyDocument);
const registry = assertDocument("CapabilityRegistry", registryDocument);
const domainPack = assertDocument("DomainPackPolicy", domainPackDocument);
const runtimePolicy = assertDocument(
  "CopilotRuntimePolicy",
  runtimePolicyDocument
);
const baseAccord = assertDocument("WorkAccord", baseAccordDocument);
const projectSchema = assertDocument(
  "GitHubProjectSchema",
  projectSchemaDocument
);
const phases = {
  framing: assertDocument("PhaseContract", framingPhaseDocument),
  planning: assertDocument("PhaseContract", planningPhaseDocument),
  execution: assertDocument("PhaseContract", executionPhaseDocument),
  verification: assertDocument("PhaseContract", verificationPhaseDocument),
  "human-review": assertDocument(
    "PhaseContract",
    humanReviewPhaseDocument
  )
} as const;

const projectPlan = planProjectSetup({
  schema: projectSchema,
  live: liveProjectDocument as LiveGitHubProject,
  evaluatedAt: NOW
});
if (!projectPlan.valid || projectPlan.binding === null) {
  throw new TypeError("synthetic Project fixture does not produce a trusted binding");
}
const projectBinding = projectPlan.binding;

const repository: GitHubRepositoryIdentity = {
  id: 1001,
  nodeId: "R_synthetic_walkthrough",
  owner: "example-organization",
  name: "hyperfinite",
  fullName: "example-organization/hyperfinite"
};

const installation: GitHubInstallationScope = {
  id: projectBinding.installation.id,
  accountNodeId: projectBinding.installation.accountNodeId,
  repositorySelection: "selected",
  repositoryIds: [repository.id]
};

const reviewerOutput = assertDocument("GitHubSafeOutput", {
  apiVersion: API_VERSION,
  kind: "GitHubSafeOutput",
  schemaVersion: "1.0.0",
  summary: "The exact synthetic pull-request head passed bounded review.",
  findings: [
    {
      code: "AUTHORITY_BOUNDARY_OK",
      severity: "info",
      message: "The proposed result contains advisory content only."
    }
  ],
  openQuestions: [],
  result: {
    status: "success",
    details: "Ready for independent human review."
  }
});

interface WalkthroughCounters {
  credentialReads: number;
  evidenceAppends: number;
  fakeProviderEffects: number;
  liveEffects: number;
  modelCalls: number;
  networkCalls: number;
  syntheticBrokerInvocations: number;
  trustedAdapterReads: number;
  writerStateReads: number;
}

export interface AuthorityWalkthroughStep {
  readonly order: number;
  readonly id:
    | "target-free-schema"
    | "runtime-disabled"
    | "activation-missing"
    | "trusted-route"
    | "stale-head"
    | "fresh-comment"
    | "human-review";
  readonly title: string;
  readonly authority: string;
  readonly outcome: "applied" | "refused" | "stopped";
  readonly code: string;
  readonly effectCount: number;
  readonly evidence: Readonly<Record<string, unknown>>;
}

export interface AuthorityWalkthroughResult {
  readonly apiVersion: typeof API_VERSION;
  readonly kind: "AuthorityBoundaryWalkthrough";
  readonly schemaVersion: "1.0.0";
  readonly title: string;
  readonly mode: {
    readonly synthetic: true;
    readonly deterministic: true;
    readonly offline: true;
    readonly expectedDurationMinutes: 5;
  };
  readonly steps: readonly AuthorityWalkthroughStep[];
  readonly counters: Readonly<WalkthroughCounters>;
  readonly finalState: "HUMAN_REVIEW";
  readonly automation: {
    readonly approve: "denied";
    readonly merge: "absent";
    readonly continuation: "independent-human-only";
  };
  readonly readiness: "hermetic-repository-evidence-only";
  readonly scenarioDigest: Digest;
}

class SyntheticBindingApi implements GitHubBindingReadApi {
  constructor(
    private readonly pullRequest: GitHubPullRequestIdentity,
    private readonly counters: WalkthroughCounters
  ) {}

  getRepository(): Promise<GitHubRepositoryIdentity> {
    this.counters.trustedAdapterReads += 1;
    return Promise.resolve(repository);
  }

  getIssue(): Promise<GitHubIssueIdentity> {
    this.counters.trustedAdapterReads += 1;
    return Promise.resolve({
      number: this.pullRequest.number,
      nodeId: this.pullRequest.nodeId
    });
  }

  getPullRequest(): Promise<GitHubPullRequestIdentity> {
    this.counters.trustedAdapterReads += 1;
    return Promise.resolve(this.pullRequest);
  }

  getInstallationScope(): Promise<GitHubInstallationScope> {
    this.counters.trustedAdapterReads += 1;
    return Promise.resolve(installation);
  }

  getProjectItem(
    projectNodeId: string,
    contentNodeId: string
  ): Promise<GitHubProjectItemIdentity> {
    this.counters.trustedAdapterReads += 1;
    return Promise.resolve({
      nodeId: "PVTI_synthetic_walkthrough",
      projectNodeId,
      contentNodeId
    });
  }
}

function pullRequest(headSha: string): GitHubPullRequestIdentity {
  return {
    number: 3,
    nodeId: "PR_synthetic_walkthrough",
    base: {
      repository,
      ref: "main",
      sha: "1111111111111111111111111111111111111111"
    },
    head: {
      repository,
      ref: "authority-walkthrough",
      sha: headSha
    }
  };
}

function webhookRepository(identity: GitHubRepositoryIdentity) {
  return {
    id: identity.id,
    node_id: identity.nodeId,
    name: identity.name,
    full_name: identity.fullName,
    owner: { login: identity.owner }
  };
}

async function issueTrustedBinding(
  headSha: string,
  counters: WalkthroughCounters
): Promise<TrustedGitHubBinding> {
  const pull = pullRequest(headSha);
  const payload = {
    action: "synchronize",
    repository: webhookRepository(repository),
    pull_request: {
      number: pull.number,
      node_id: pull.nodeId,
      updated_at: NOW,
      base: {
        repo: webhookRepository(pull.base.repository),
        ref: pull.base.ref,
        sha: pull.base.sha
      },
      head: {
        repo: webhookRepository(pull.head.repository),
        ref: pull.head.ref,
        sha: pull.head.sha
      }
    },
    installation: { id: installation.id },
    sender: {
      id: 42,
      node_id: "U_synthetic_maintainer",
      login: "synthetic-maintainer",
      type: "User"
    }
  };
  const rawBody = Buffer.from(JSON.stringify(payload));
  const signature = createHmac("sha256", WEBHOOK_KEY)
    .update(rawBody)
    .digest("hex");
  const normalized = await normalizeGitHubWebhook({
    rawBody,
    headers: {
      "x-github-delivery": `delivery-synthetic-${headSha.slice(0, 8)}`,
      "x-github-event": "pull_request",
      "x-hub-signature-256": `sha256=${signature}`
    },
    verifier: new HmacWebhookSignatureVerifier(WEBHOOK_KEY),
    api: new SyntheticBindingApi(pull, counters),
    projectBinding
  });
  return normalized.binding;
}

const actorRoles: Readonly<Record<ActorClass, readonly string[]>> = {
  requester: ["work-item-requester"],
  reviewer: ["eligible-reviewer"],
  maintainer: ["repository-maintainer"],
  administrator: ["repository-administrator"],
  system: ["trusted-kernel"],
  policy: ["trusted-policy"]
};

function actor(actorClass: ActorClass): Actor {
  const id =
    actorClass === "system" || actorClass === "policy"
      ? `trusted-${actorClass}`
      : `synthetic-human-${actorClass}`;
  return {
    id,
    class: actorClass,
    human: actorClass !== "system" && actorClass !== "policy",
    bot: false,
    roles: actorRoles[actorClass],
    authorizationDigest: digest({ actorClass, id, current: true })
  };
}

function workAccord(
  binding: TrustedGitHubBinding,
  revision: 1 | 2,
  supersedes: string | null
): WorkAccord {
  const phaseBindings = Object.fromEntries(
    Object.entries(phases).map(([phase, contract]) => [
      phase,
      {
        reference: `${contract.identity.id}@${contract.identity.version}`,
        digest: digest(contract)
      }
    ])
  ) as WorkAccord["policy"]["phaseContracts"];
  return assertDocument("WorkAccord", {
    ...baseAccord,
    identity: {
      id: `authority-walkthrough-r${revision}`,
      revision,
      supersedes,
      createdAt: NOW,
      createdBy: "synthetic-human-maintainer"
    },
    binding: {
      ...baseAccord.binding,
      repositoryId: binding.repository.id,
      repositoryNodeId: binding.repository.nodeId,
      repositoryFullName: binding.repository.fullName,
      repositoryRootId: digest({ syntheticRepositoryRoot: 1 }),
      workItemNodeId: binding.workItem.nodeId,
      proposalRef: "refs/heads/agentic-domain/authority-walkthrough",
      sourceDigest: digest({ syntheticWalkthroughSource: 1 }),
      policyDigest: digest(controlPolicy),
      lifecycleGraphDigest: digest(graph),
      currentHead:
        binding.workItem.kind === "pull-request"
          ? digest(binding.workItem.head.sha)
          : null
    },
    objective: {
      outcome: "Demonstrate the authority boundary with synthetic offline evidence.",
      inScope: ["synthetic walkthrough evidence"],
      outOfScope: [
        "live GitHub mutation",
        "deployment",
        "approval",
        "merge"
      ],
      assumptions: ["Every provider and identity is a deterministic fixture."],
      dependencies: []
    },
    policy: {
      ...baseAccord.policy,
      domainPackDigest: digest(domainPack),
      capabilityRegistryDigest: digest(registry),
      phaseContracts: phaseBindings,
      riskClass: "high",
      privacyClass: "confidential",
      requestedCapabilities: [
        "core.frame-artifact@1.0.0",
        "core.execute-bounded-change@1.0.0",
        "core.review-current-head@1.0.0"
      ],
      tools: ["read", "search"],
      shellCommands: [],
      network: [],
      mcpTools: [
        "github.issue_read",
        "safeoutputs.add_comment",
        "safeoutputs.submit_pull_request_review"
      ],
      secretAccess: false
    },
    budget: {
      ...baseAccord.budget,
      maxCalls: 10,
      maxCostUnits: 100,
      expiresAt: EXPIRES_AT
    },
    deliverables: [
      "One synthetic comment-only review followed by Human Review"
    ]
  });
}

function activationLease(accord: WorkAccord): ActivationLease {
  const maintainer = actor("maintainer");
  return assertDocument("ActivationLease", {
    apiVersion: API_VERSION,
    kind: "ActivationLease",
    id: `authority-walkthrough-lease-r${accord.identity.revision}`,
    workAccordDigest: digest(accord),
    approvedBy: maintainer.id,
    authorizationDigest: maintainer.authorizationDigest,
    allowedPhases: [
      "framing",
      "planning",
      "execution",
      "verification",
      "human-review"
    ],
    allowedCapabilities: [
      "core.frame-artifact@1.0.0",
      "core.execute-bounded-change@1.0.0",
      "core.review-current-head@1.0.0"
    ],
    maxCalls: accord.budget.maxCalls,
    maxTokens: accord.budget.maxTokens,
    maxCostUnits: accord.budget.maxCostUnits,
    maxParallel: accord.budget.maxParallel,
    expiresAt: EXPIRES_AT,
    revoked: false
  });
}

function humanGate(
  gate: "activate" | "accept-frame" | "accept-plan",
  gateActor: Actor,
  accord: WorkAccord,
  lease: ActivationLease
): HumanGateEvidence {
  return assertDocument("HumanGateEvidence", {
    gate,
    actor: gateActor,
    workAccordDigest: digest(accord),
    activationLeaseDigest: gate === "activate" ? digest(lease) : null,
    currentHead: accord.binding.currentHead,
    observedAt: OBSERVED_AT,
    expiresAt: EXPIRES_AT,
    valid: true
  });
}

function kernelEvent(input: {
  readonly snapshot: KernelSnapshot;
  readonly accord: WorkAccord;
  readonly type: EventType;
  readonly actorClass: ActorClass;
  readonly cost?: EventEnvelope["cost"];
  readonly source?: EventEnvelope["provenance"]["source"];
  readonly replacementAuthorityDigest?: Digest | null;
}): EventEnvelope {
  const sequence = input.snapshot.lastEventSequence + 1;
  const envelope: EventEnvelope = {
    apiVersion: API_VERSION,
    kind: "KernelEvent",
    id: `walkthrough-r${input.accord.identity.revision}-${sequence}-${input.type}`,
    sequence,
    occurredAt: NOW,
    expectedStateVersion: input.snapshot.stateVersion,
    type: input.type,
    replacementAuthorityDigest: input.replacementAuthorityDigest ?? null,
    actor: actor(input.actorClass),
    provenance: {
      source: input.source ?? "trusted-adapter",
      deliveryId: `walkthrough-delivery-${input.accord.identity.revision}-${sequence}`,
      bindingDigest: input.snapshot.bindingDigest,
      payloadDigest: digest("pending")
    },
    cost: input.cost ?? {
      calls: 0,
      tokens: 0,
      costUnits: 0,
      loops: 0
    }
  };
  return {
    ...envelope,
    provenance: {
      ...envelope.provenance,
      payloadDigest: eventPayloadDigest(envelope)
    }
  };
}

function requirementEvidence(input: {
  readonly snapshot: KernelSnapshot;
  readonly accord: WorkAccord;
  readonly routeId: string;
  readonly contract: PhaseContract;
  readonly requirementType: "predicate" | "evidence";
  readonly requirement: string;
  readonly actorAuthorizationDigest: Digest | null;
  readonly lease: ActivationLease | null;
}): ContractRequirementEvidence {
  return assertDocument("ContractRequirementEvidence", {
    apiVersion: API_VERSION,
    kind: "ContractRequirementEvidence",
    requirementType: input.requirementType,
    requirement: input.requirement,
    satisfied: true,
    workAccordDigest: digest(input.accord),
    bindingDigest: input.snapshot.bindingDigest,
    snapshotDigest: digest(input.snapshot),
    phaseContractDigest: digest(input.contract),
    routeId: input.routeId,
    activationLeaseDigest:
      input.requirement === "activation-lease-current" ||
      input.requirement === "activation-lease"
        ? input.lease === null
          ? null
          : digest(input.lease)
        : null,
    currentHead: input.snapshot.currentHead,
    actorAuthorizationDigest: input.actorAuthorizationDigest,
    observedAt: OBSERVED_AT,
    expiresAt: EXPIRES_AT
  });
}

function kernelContext(input: {
  readonly snapshot: KernelSnapshot;
  readonly event: EventEnvelope;
  readonly accord: WorkAccord;
  readonly current: PhaseContract | null;
  readonly destination: PhaseContract | null;
  readonly lease: ActivationLease | null;
  readonly gates: readonly HumanGateEvidence[];
  readonly rebindAuthority?: AuthorityRebind | null;
}): KernelContext {
  const route = graph.routes.find(
    (candidate) =>
      candidate.from === input.snapshot.state &&
      candidate.event === input.event.type
  );
  if (route === undefined) {
    throw new TypeError(
      `walkthrough has no route from ${input.snapshot.state} for ${input.event.type}`
    );
  }
  const requirements: ContractRequirementEvidence[] = [];
  const enteringNewPhase =
    input.destination !== null &&
    route.phaseOwner === input.destination.phase &&
    input.current?.phase !== input.destination.phase;
  if (
    input.current !== null &&
    (enteringNewPhase || route.to === "COMPLETED")
  ) {
    const exitRule = input.current.exitRules.find(
      (candidate) => candidate.event === input.event.type
    );
    if (exitRule !== undefined) {
      requirements.push(
        requirementEvidence({
          snapshot: input.snapshot,
          accord: input.accord,
          routeId: route.id,
          contract: input.current,
          requirementType: "predicate",
          requirement: exitRule.predicate,
          actorAuthorizationDigest: input.event.actor.authorizationDigest,
          lease: input.lease
        })
      );
    }
  }
  if (enteringNewPhase && input.destination !== null) {
    for (const requirement of input.destination.entryPredicates) {
      requirements.push(
        requirementEvidence({
          snapshot: input.snapshot,
          accord: input.accord,
          routeId: route.id,
          contract: input.destination,
          requirementType: "predicate",
          requirement,
          actorAuthorizationDigest: null,
          lease: input.lease
        })
      );
    }
    for (const requirement of input.destination.requiredEvidence) {
      requirements.push(
        requirementEvidence({
          snapshot: input.snapshot,
          accord: input.accord,
          routeId: route.id,
          contract: input.destination,
          requirementType: "evidence",
          requirement,
          actorAuthorizationDigest: null,
          lease: input.lease
        })
      );
    }
  }
  return {
    graph,
    workAccord: input.accord,
    policy: controlPolicy,
    registry,
    domainPack,
    currentPhaseContract: input.current,
    destinationPhaseContract: input.destination,
    activationLease: input.lease,
    humanGateEvidence: input.gates,
    contractRequirementEvidence: requirements,
    requesterId: actor("requester").id,
    evaluatedAt: NOW,
    retryableFailure: false,
    rebindAuthority: input.rebindAuthority ?? null
  };
}

function applied(result: KernelResult, expectedRoute: string) {
  if (result.kind !== "applied" || result.route.id !== expectedRoute) {
    throw new TypeError(
      `walkthrough expected ${expectedRoute}, received ${
        result.kind === "refused"
          ? `${result.refusal.code}: ${result.refusal.message}`
          : result.kind
      }`
    );
  }
  return result;
}

interface ActiveJourney {
  readonly accord: WorkAccord;
  readonly lease: ActivationLease;
  readonly gates: readonly HumanGateEvidence[];
  readonly activationResult: Extract<KernelResult, { readonly kind: "applied" }>;
  readonly verificationResult: Extract<KernelResult, { readonly kind: "applied" }>;
  readonly snapshot: KernelSnapshot;
  readonly missingActivation: Extract<
    KernelResult,
    { readonly kind: "refused" }
  > | null;
}

function reachVerification(
  activationPending: KernelSnapshot,
  accord: WorkAccord,
  includeMissingActivation: boolean
): ActiveJourney {
  const lease = activationLease(accord);
  const gates = [
    humanGate("activate", actor("maintainer"), accord, lease),
    humanGate("accept-frame", actor("reviewer"), accord, lease),
    humanGate("accept-plan", actor("reviewer"), accord, lease)
  ];
  const activationEvent = kernelEvent({
    snapshot: activationPending,
    accord,
    type: "activation-approved",
    actorClass: "maintainer",
    cost: { calls: 1, tokens: 100, costUnits: 1, loops: 0 }
  });
  let missingActivation: ActiveJourney["missingActivation"] = null;
  if (includeMissingActivation) {
    const refused = evaluateTransition(
      activationPending,
      activationEvent,
      kernelContext({
        snapshot: activationPending,
        event: activationEvent,
        accord,
        current: null,
        destination: phases.framing,
        lease: null,
        gates: []
      })
    );
    if (
      refused.kind !== "refused" ||
      refused.refusal.code !== "ACTIVATION_REQUIRED"
    ) {
      throw new TypeError("missing activation did not fail closed");
    }
    missingActivation = refused;
  }
  const activationResult = applied(
    evaluateTransition(
      activationPending,
      activationEvent,
      kernelContext({
        snapshot: activationPending,
        event: activationEvent,
        accord,
        current: null,
        destination: phases.framing,
        lease,
        gates
      })
    ),
    "activation.begin-framing"
  );
  const frameEvent = kernelEvent({
    snapshot: activationResult.snapshot,
    accord,
    type: "frame-accepted",
    actorClass: "reviewer"
  });
  const framed = applied(
    evaluateTransition(
      activationResult.snapshot,
      frameEvent,
      kernelContext({
        snapshot: activationResult.snapshot,
        event: frameEvent,
        accord,
        current: phases.framing,
        destination: phases.planning,
        lease,
        gates
      })
    ),
    "framing.accept"
  );
  const executionEvent = kernelEvent({
    snapshot: framed.snapshot,
    accord,
    type: "execution-authorized",
    actorClass: "reviewer",
    cost: { calls: 1, tokens: 100, costUnits: 1, loops: 0 }
  });
  const planned = applied(
    evaluateTransition(
      framed.snapshot,
      executionEvent,
      kernelContext({
        snapshot: framed.snapshot,
        event: executionEvent,
        accord,
        current: phases.planning,
        destination: phases.execution,
        lease,
        gates
      })
    ),
    "planning.execute"
  );
  const verificationEvent = kernelEvent({
    snapshot: planned.snapshot,
    accord,
    type: "work-submitted",
    actorClass: "system",
    cost: { calls: 1, tokens: 100, costUnits: 1, loops: 0 }
  });
  const verificationResult = applied(
    evaluateTransition(
      planned.snapshot,
      verificationEvent,
      kernelContext({
        snapshot: planned.snapshot,
        event: verificationEvent,
        accord,
        current: phases.execution,
        destination: phases.verification,
        lease,
        gates
      })
    ),
    "execution.verify"
  );
  return {
    accord,
    lease,
    gates,
    activationResult,
    verificationResult,
    snapshot: verificationResult.snapshot,
    missingActivation
  };
}

function beginJourney(
  accord: WorkAccord,
  includeMissingActivation: boolean
): ActiveJourney {
  const initial = createInitialSnapshot({
    lifecycleGraphDigest: digest(graph),
    workAccord: accord,
    capabilityRegistryDigest: digest(registry),
    domainPackDigest: digest(domainPack),
    policyDigest: digest(controlPolicy)
  });
  const requestEvent = kernelEvent({
    snapshot: initial,
    accord,
    type: "activation-requested",
    actorClass: "requester"
  });
  const requested = applied(
    evaluateTransition(
      initial,
      requestEvent,
      kernelContext({
        snapshot: initial,
        event: requestEvent,
        accord,
        current: null,
        destination: null,
        lease: null,
        gates: []
      })
    ),
    "capture.request-activation"
  );
  return reachVerification(
    requested.snapshot,
    accord,
    includeMissingActivation
  );
}

function rebindCurrentHead(
  prior: ActiveJourney,
  replacementAccord: WorkAccord
): KernelSnapshot {
  const invalidationEvent = kernelEvent({
    snapshot: prior.snapshot,
    accord: prior.accord,
    type: "authorization-invalidated",
    actorClass: "system"
  });
  const invalidated = applied(
    evaluateTransition(
      prior.snapshot,
      invalidationEvent,
      kernelContext({
        snapshot: prior.snapshot,
        event: invalidationEvent,
        accord: prior.accord,
        current: phases.verification,
        destination: null,
        lease: prior.lease,
        gates: prior.gates
      })
    ),
    "verifying.reauthorize"
  );
  const replacement = assertDocument("AuthorityRebind", {
    apiVersion: API_VERSION,
    kind: "AuthorityRebind",
    schemaVersion: "1.0.0",
    bindingDigest: workAccordBindingDigest(replacementAccord),
    graph,
    workAccord: replacementAccord,
    policy: controlPolicy,
    registry,
    domainPack,
    phaseContracts: Object.values(phases)
  });
  const rebindEvent = kernelEvent({
    snapshot: invalidated.snapshot,
    accord: prior.accord,
    type: "binding-revalidated",
    actorClass: "policy",
    source: "policy-engine",
    replacementAuthorityDigest: digest(replacement)
  });
  const rebound = applied(
    evaluateTransition(
      invalidated.snapshot,
      rebindEvent,
      kernelContext({
        snapshot: invalidated.snapshot,
        event: rebindEvent,
        accord: prior.accord,
        current: null,
        destination: null,
        lease: null,
        gates: [],
        rebindAuthority: replacement
      })
    ),
    "activation.rebind-authority"
  );
  return rebound.snapshot;
}

function runtimeDisabledRule(
  binding: TrustedGitHubBinding,
  accord: WorkAccord,
  lease: ActivationLease
): string {
  const policyDigest = digest(runtimePolicy);
  const kernelPolicyDigest = digest(controlPolicy);
  const runtimeState: CopilotRuntimeState = {
    apiVersion: API_VERSION,
    kind: "CopilotRuntimeState",
    schemaVersion: "2.0.0",
    repositoryId: binding.repository.id,
    repositoryFullName: binding.repository.fullName,
    workItemNodeId: binding.workItem.nodeId,
    projectNodeId: binding.project.projectNodeId,
    projectItemNodeId: binding.project.itemNodeId,
    bindingDigest: digest(binding),
    kernelBindingDigest: workAccordBindingDigest(accord),
    workAccordSourceDigest: accord.binding.sourceDigest,
    state: "VERIFYING",
    phase: "verification",
    role: "reviewer",
    capability: "core.review-current-head@1.0.0",
    contractRevision: accord.identity.revision,
    workAccordDigest: digest(accord),
    policyDigest,
    kernelPolicyDigest,
    activationLeaseDigest: digest(lease),
    kernelReceiptDigest: digest({ syntheticKernelReceipt: 1 }),
    kernelRouteId: "execution.verify",
    workflowId: "agentic-review",
    activationNonce: "nonce_abcdefghijklmnopqrstuvwxyz012345",
    currentHead:
      binding.workItem.kind === "pull-request"
        ? binding.workItem.head.sha
        : null,
    executionContext: null,
    remainingAiCredits: runtimeMaximumReservation(runtimePolicy),
    repairCount: 0,
    recursionDepth: 0,
    expiresAt: EXPIRES_AT,
    signature: {
      algorithm: "ed25519",
      keyId: "synthetic-runtime-state",
      value: "c3ludGhldGlj"
    }
  };
  const request: RuntimeActivationRequest = {
    enabled: false,
    eventName: "issue_comment",
    eventAction: "created",
    actorId: 42,
    actorLogin: "synthetic-maintainer",
    actorIsBot: false,
    actorPermission: "write",
    repositoryId: runtimeState.repositoryId,
    repositoryFullName: runtimeState.repositoryFullName,
    workItemKind: "pull-request",
    workItemNumber: binding.workItem.number,
    workItemNodeId: runtimeState.workItemNodeId,
    projectNodeId: runtimeState.projectNodeId,
    projectItemNodeId: runtimeState.projectItemNodeId,
    bindingDigest: runtimeState.bindingDigest,
    kernelBindingDigest: runtimeState.kernelBindingDigest,
    workAccordSourceDigest: runtimeState.workAccordSourceDigest,
    phase: runtimeState.phase,
    role: runtimeState.role,
    capability: runtimeState.capability,
    workflowId: runtimeState.workflowId,
    workflowRef:
      `${runtimeState.repositoryFullName}/.github/workflows/` +
      `${runtimeState.workflowId}.lock.yml@refs/heads/main`,
    workflowSha: "1111111111111111111111111111111111111111",
    defaultBranch: "main",
    runId: 9001,
    runAttempt: 1,
    workAccordDigest: runtimeState.workAccordDigest,
    policyDigest,
    kernelPolicyDigest,
    activationLeaseDigest: runtimeState.activationLeaseDigest,
    activationNonce: runtimeState.activationNonce,
    reservedAiCredits: runtimeMaximumReservation(runtimePolicy),
    currentHead: runtimeState.currentHead
  };
  const evidence: RuntimeFreshEvidence = {
    state: runtimeState,
    stateSignatureVerified: true,
    stateAuthorApplicationId: 7001,
    stateAuthorId: 7002,
    expectedApplicationId: 7001,
    expectedAuthorId: 7002,
    allowedActorIds: [42],
    stateCommentId: 8001,
    stateCommentUpdatedAt: OBSERVED_AT,
    stateCollectionEtag: '"synthetic-runtime-state"'
  };
  try {
    validateRuntimePreActivation(
      runtimePolicy,
      request,
      evidence,
      controlPolicy,
      { now: () => NOW }
    );
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    const match = /\[([a-z0-9.-]+)\]/u.exec(error.message);
    if (match?.[1] !== "activation.enabled") throw error;
    return match[1];
  }
  throw new TypeError("disabled runtime unexpectedly passed pre-activation");
}

function evidenceSignature(
  identity: GitHubEvidenceIdentity,
  evidence: GitHubEvidenceRecord["evidence"]
): GitHubEvidenceSignature {
  return {
    algorithm: "HMAC-SHA256-SYNTHETIC",
    keyId: "walkthrough-evidence-key",
    value: createHmac("sha256", EVIDENCE_KEY)
      .update(canonicalJson({ identity, evidence }))
      .digest("hex")
  };
}

function signedEvidenceDigest(record: GitHubEvidenceRecord): Digest {
  return digest({
    identity: {
      applicationId: record.applicationId,
      authorId: record.authorId
    },
    evidence: record.evidence,
    signature: record.signature
  });
}

function evidenceHead(record: GitHubEvidenceRecord): GitHubEvidenceHead {
  return {
    nodeId: record.nodeId,
    sequence: record.evidence.sequence,
    evidenceDigest: signedEvidenceDigest(record)
  };
}

class HermeticGitHubApi implements GitHubApi {
  readonly evidence: GitHubEvidenceRecord[] = [];
  evidenceHead: GitHubEvidenceHead | null = null;
  observation: GitHubEffectObservation | null = null;

  constructor(
    public state: GitHubExecutionState,
    private readonly counters: WalkthroughCounters
  ) {}

  getRepository(): Promise<GitHubRepositoryIdentity> {
    return Promise.resolve(this.state.binding.repository);
  }

  getIssue(): Promise<GitHubIssueIdentity> {
    return Promise.resolve({
      number: this.state.binding.workItem.number,
      nodeId: this.state.binding.workItem.nodeId
    });
  }

  getPullRequest(): Promise<GitHubPullRequestIdentity> {
    if (this.state.binding.workItem.kind !== "pull-request") {
      throw new TypeError("walkthrough binding is not a pull request");
    }
    return Promise.resolve(this.state.binding.workItem);
  }

  getInstallationScope(): Promise<GitHubInstallationScope> {
    return Promise.resolve(this.state.binding.installation);
  }

  getProjectItem(
    projectNodeId: string,
    contentNodeId: string
  ): Promise<GitHubProjectItemIdentity> {
    return Promise.resolve({
      nodeId: this.state.binding.project.itemNodeId,
      projectNodeId,
      contentNodeId
    });
  }

  readExecutionState(): Promise<GitHubExecutionState> {
    this.counters.writerStateReads += 1;
    return Promise.resolve(structuredClone(this.state));
  }

  applyEffect(
    binding: TrustedGitHubBinding,
    plan: GitHubEffectPlan,
    precondition: GitHubEffectPrecondition
  ): Promise<GitHubEffectObservation> {
    const currentHead =
      this.state.binding.workItem.kind === "pull-request"
        ? this.state.binding.workItem.head.sha
        : null;
    if (
      precondition.bindingDigest !== digest(binding) ||
      precondition.planDigest !== digest(plan) ||
      precondition.effectDigest !== digest(plan.effect) ||
      precondition.executionStateDigest !== digest(this.state) ||
      precondition.expectedHeadSha !== currentHead
    ) {
      throw new TypeError("synthetic provider received a stale effect precondition");
    }
    this.counters.fakeProviderEffects += 1;
    this.observation = {
      nodeId: "SYNTHETIC_COMMENT_1",
      effectDigest: digest(plan.effect)
    };
    return Promise.resolve(this.observation);
  }

  observeEffect(): Promise<GitHubEffectObservation | null> {
    return Promise.resolve(this.observation);
  }

  getProjectFieldValue(): Promise<GitHubProjectFieldValue | null> {
    return Promise.resolve(null);
  }

  getActorAuthorization(): Promise<GitHubActorAuthorizationSnapshot> {
    return Promise.resolve({
      actorId: 42,
      actorNodeId: "U_synthetic_maintainer",
      login: "synthetic-maintainer",
      bot: false,
      repositoryPermission: "maintain",
      organizationRole: "direct_member",
      teamNodeIds: ["T_synthetic_reviewers"],
      reviewCommitId: null
    });
  }

  readEvidenceSnapshot() {
    return structuredClone({
      records: this.evidence,
      head: this.evidenceHead
    });
  }

  appendEvidence(
    expectedHead: GitHubEvidenceHead | null,
    signed: GitHubSignedEvidence,
    identity: GitHubEvidenceIdentity
  ): GitHubEvidenceRecord {
    if (digest(expectedHead) !== digest(this.evidenceHead)) {
      throw new GitHubEvidenceConflictError(this.evidenceHead);
    }
    const record: GitHubEvidenceRecord = {
      nodeId: `SYNTHETIC_EVIDENCE_${signed.evidence.sequence}`,
      applicationId: identity.applicationId,
      authorId: identity.authorId,
      evidence: signed.evidence,
      signature: signed.signature
    };
    this.evidence.push(record);
    this.evidenceHead = evidenceHead(record);
    this.counters.evidenceAppends += 1;
    return record;
  }
}

function singleWriter(
  api: HermeticGitHubApi,
  counters: WalkthroughCounters
): GitHubSingleWriter {
  const identity: GitHubEvidenceIdentity = {
    applicationId: 7001,
    authorId: 7002
  };
  const evidenceServices: GitHubEvidenceServices = {
    identity,
    signer: {
      signEvidence: ({ identity: signingIdentity, evidence }) =>
        Promise.resolve(evidenceSignature(signingIdentity, evidence))
    },
    verifier: {
      verifyEvidence: ({ identity: signingIdentity, evidence, signature }) => {
        const expected = evidenceSignature(signingIdentity, evidence);
        const actualBytes = Buffer.from(signature.value);
        const expectedBytes = Buffer.from(expected.value);
        return Promise.resolve(
          signature.algorithm === expected.algorithm &&
            signature.keyId === expected.keyId &&
            actualBytes.length === expectedBytes.length &&
            timingSafeEqual(actualBytes, expectedBytes)
        );
      }
    },
    store: {
      supportsAuthenticatedConditionalAppend: true,
      readEvidence: () => Promise.resolve(api.readEvidenceSnapshot()),
      conditionalAppendEvidence: (
        _client,
        _binding,
        expectedHead,
        signed
      ) => Promise.resolve(api.appendEvidence(expectedHead, signed, identity))
    }
  };
  const credentials = new GitHubAppCredentialBroker(
    {
      withSignedIdentity: <T>(
        _request: {
          readonly algorithm: "RS256";
          readonly issuer: string;
          readonly issuedAt: string;
          readonly expiresAt: string;
        },
        operation: (identity: SignedGitHubAppIdentity) => Promise<T>
      ): Promise<T> => {
        counters.syntheticBrokerInvocations += 1;
        return operation({ kind: "signed-github-app-identity" });
      }
    },
    {
      withInstallationClient: <T>(
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
      ): Promise<T> =>
        operation(api, {
          installationId: request.installationId,
          repositoryIds: request.repositoryIds,
          permissions: request.permissions,
          expiresAt: "2026-09-03T17:30:00.000Z"
        })
    },
    "synthetic-walkthrough-app",
    () => new Date(NOW)
  );
  return new GitHubSingleWriter(
    credentials,
    { maxAttempts: 1, baseDelayMs: 0, maximumDelayMs: 0 },
    async () => {},
    () => new Date(NOW),
    evidenceServices
  );
}

function targetEvidence(plan: GitHubEffectPlan) {
  if (plan.effect.type !== "pull-request-review-comment") {
    throw new TypeError("walkthrough effect is not a comment-only review");
  }
  return {
    repositoryId: plan.effect.repository.id,
    repositoryNodeId: plan.effect.repository.nodeId,
    repositoryFullName: plan.effect.repository.fullName,
    pullRequestNumber: plan.effect.pullRequest.number,
    pullRequestNodeId: plan.effect.pullRequest.nodeId,
    headSha: plan.effect.headSha,
    event: plan.effect.event
  };
}

function stableResult(
  value: Omit<AuthorityWalkthroughResult, "scenarioDigest">
): AuthorityWalkthroughResult {
  return JSON.parse(
    canonicalJson({ ...value, scenarioDigest: digest(value) })
  ) as AuthorityWalkthroughResult;
}

export async function runAuthorityBoundaryWalkthrough(): Promise<AuthorityWalkthroughResult> {
  const counters: WalkthroughCounters = {
    credentialReads: 0,
    evidenceAppends: 0,
    fakeProviderEffects: 0,
    liveEffects: 0,
    modelCalls: 0,
    networkCalls: 0,
    syntheticBrokerInvocations: 0,
    trustedAdapterReads: 0,
    writerStateReads: 0
  };
  const targetBearingOutput = {
    ...reviewerOutput,
    repository: repository.fullName,
    issueNumber: 3,
    effect: "merge"
  };
  const targetFreeValidation = validateDocument(
    "GitHubSafeOutput",
    targetBearingOutput
  );
  if (targetFreeValidation.valid) {
    throw new TypeError("target-bearing model output unexpectedly validated");
  }

  const oldBinding = await issueTrustedBinding(OLD_HEAD, counters);
  const oldAccord = workAccord(oldBinding, 1, null);
  const oldLease = activationLease(oldAccord);
  const disabledRule = runtimeDisabledRule(oldBinding, oldAccord, oldLease);
  const oldJourney = beginJourney(oldAccord, true);
  if (oldJourney.missingActivation === null) {
    throw new TypeError("walkthrough omitted the missing-activation refusal");
  }
  const oldPlan = translateSafeOutput({
    output: reviewerOutput,
    intent: { type: "pull-request-review-comment", event: "COMMENT" },
    binding: oldBinding,
    eventId: "walkthrough-review-r1",
    contractRevision: oldAccord.identity.revision,
    contractDigest: digest(oldAccord),
    receiptHead: oldJourney.snapshot.receiptHead,
    routeId: oldJourney.verificationResult.route.id,
    attempt: 1
  });

  const newBinding = await issueTrustedBinding(NEW_HEAD, counters);
  const api = new HermeticGitHubApi(
    {
      binding: newBinding,
      contractDigest: oldPlan.expected.contractDigest,
      receiptHead: oldPlan.expected.receiptHead,
      projectSchemaDigest: oldPlan.expected.projectSchemaDigest
    },
    counters
  );
  const writer = singleWriter(api, counters);
  let staleCode: GitHubExecutionError["code"] | null = null;
  try {
    await writer.execute(oldBinding, oldPlan, CLAIMANT_ID);
  } catch (error) {
    if (!(error instanceof GitHubExecutionError)) throw error;
    staleCode = error.code;
  }
  if (staleCode !== "CURRENT_HEAD_STALE") {
    throw new TypeError(`expected CURRENT_HEAD_STALE, received ${staleCode}`);
  }
  const staleEffectCount = counters.fakeProviderEffects;

  const newAccord = workAccord(
    newBinding,
    2,
    oldAccord.identity.id
  );
  const rebound = rebindCurrentHead(oldJourney, newAccord);
  const newJourney = reachVerification(rebound, newAccord, false);
  const newPlan = translateSafeOutput({
    output: reviewerOutput,
    intent: { type: "pull-request-review-comment", event: "COMMENT" },
    binding: newBinding,
    eventId: "walkthrough-review-r2",
    contractRevision: newAccord.identity.revision,
    contractDigest: digest(newAccord),
    receiptHead: newJourney.snapshot.receiptHead,
    routeId: newJourney.verificationResult.route.id,
    attempt: 1
  });
  api.state = {
    binding: newBinding,
    contractDigest: newPlan.expected.contractDigest,
    receiptHead: newPlan.expected.receiptHead,
    projectSchemaDigest: newPlan.expected.projectSchemaDigest
  };
  const written = await writer.execute(newBinding, newPlan, CLAIMANT_ID);
  if (written.kind !== "applied") {
    throw new TypeError(`fresh comment was ${written.kind}, not applied`);
  }

  const reviewEvent = kernelEvent({
    snapshot: newJourney.snapshot,
    accord: newAccord,
    type: "verification-passed",
    actorClass: "system"
  });
  const humanReview = applied(
    evaluateTransition(
      newJourney.snapshot,
      reviewEvent,
      kernelContext({
        snapshot: newJourney.snapshot,
        event: reviewEvent,
        accord: newAccord,
        current: phases.verification,
        destination: phases["human-review"],
        lease: newJourney.lease,
        gates: newJourney.gates
      })
    ),
    "verification.request-review"
  );
  if (humanReview.snapshot.state !== "HUMAN_REVIEW") {
    throw new TypeError("verification route did not stop at Human Review");
  }
  const automationEvent = kernelEvent({
    snapshot: humanReview.snapshot,
    accord: newAccord,
    type: "outcome-accepted",
    actorClass: "system"
  });
  const automationAttempt = evaluateTransition(
    humanReview.snapshot,
    automationEvent,
    kernelContext({
      snapshot: humanReview.snapshot,
      event: automationEvent,
      accord: newAccord,
      current: phases["human-review"],
      destination: null,
      lease: newJourney.lease,
      gates: newJourney.gates
    })
  );
  if (
    automationAttempt.kind !== "refused" ||
    automationAttempt.refusal.code !== "UNAUTHORIZED_ACTOR"
  ) {
    throw new TypeError("automation unexpectedly crossed the Human Review gate");
  }
  const approvePlanValid =
    newPlan.effect.type === "pull-request-review-comment" &&
    validateDocument("GitHubEffectPlan", {
      ...newPlan,
      effect: { ...newPlan.effect, event: "APPROVE" }
    }).valid;
  const mergePlanValid = validateDocument("GitHubEffectPlan", {
    ...newPlan,
    effect: {
      type: "merge",
      repository: newBinding.repository,
      pullRequest: newBinding.workItem
    }
  }).valid;
  if (approvePlanValid || mergePlanValid) {
    throw new TypeError("effect-plan schema unexpectedly permits approval or merge");
  }

  const steps: AuthorityWalkthroughStep[] = [
    {
      order: 1,
      id: "target-free-schema",
      title: "Target-bearing model output is rejected",
      authority: "closed GitHubSafeOutput schema",
      outcome: "refused",
      code: "SCHEMA_INVALID",
      effectCount: 0,
      evidence: {
        attemptedControlFields: ["effect", "issueNumber", "repository"],
        schemaErrors: targetFreeValidation.errors.length,
        modelCalls: 0,
        liveEffects: 0
      }
    },
    {
      order: 2,
      id: "runtime-disabled",
      title: "Disabled runtime is refused before inference",
      authority: "runtime pre-activation",
      outcome: "refused",
      code: disabledRule,
      effectCount: 0,
      evidence: {
        modelCalls: 0,
        credentialReads: 0,
        liveEffects: 0
      }
    },
    {
      order: 3,
      id: "activation-missing",
      title: "Cost-bearing Kernel route requires current activation",
      authority: "Control Kernel",
      outcome: "refused",
      code: oldJourney.missingActivation.refusal.code,
      effectCount: 0,
      evidence: {
        route: "activation.begin-framing",
        ruleId: oldJourney.missingActivation.refusal.ruleId,
        modelCalls: 0,
        liveEffects: 0
      }
    },
    {
      order: 4,
      id: "trusted-route",
      title: "Human evidence and Trusted Binding permit one bounded route",
      authority: "Control Kernel and trusted safe-output adapter",
      outcome: "applied",
      code: oldJourney.activationResult.route.id,
      effectCount: oldPlan.effect.type === "pull-request-review-comment" ? 1 : 0,
      evidence: {
        humanGate: "activate",
        leaseDigest: digest(oldJourney.lease),
        kernelReceiptDigest: oldJourney.activationResult.receiptDigest,
        planDigest: digest(oldPlan),
        targetSource: "TrustedGitHubBinding",
        target: targetEvidence(oldPlan)
      }
    },
    {
      order: 5,
      id: "stale-head",
      title: "Single Writer rejects a changed pull-request head",
      authority: "GitHubSingleWriter",
      outcome: "refused",
      code: staleCode,
      effectCount: staleEffectCount,
      evidence: {
        expectedHead: OLD_HEAD,
        observedHead: NEW_HEAD,
        fakeProviderEffects: staleEffectCount,
        liveEffects: 0
      }
    },
    {
      order: 6,
      id: "fresh-comment",
      title: "Fresh exact-head evidence permits the COMMENT-only effect",
      authority: "trusted rebind, effect-plan schema, and GitHubSingleWriter",
      outcome: "applied",
      code: written.kind,
      effectCount: counters.fakeProviderEffects - staleEffectCount,
      evidence: {
        authorityRevision: newAccord.identity.revision,
        priorAuthority: newAccord.identity.supersedes,
        planDigest: digest(newPlan),
        effectDigest: written.effectDigest,
        target: targetEvidence(newPlan),
        provider: "injected-hermetic-fake",
        liveEffects: 0
      }
    },
    {
      order: 7,
      id: "human-review",
      title: "Automation stops at Human Review",
      authority: "lifecycle graph and Control Kernel",
      outcome: "stopped",
      code: humanReview.snapshot.state,
      effectCount: 0,
      evidence: {
        route: humanReview.route.id,
        automationAttempt: automationAttempt.refusal.code,
        approveEffectSchemaValid: approvePlanValid,
        mergeEffectSchemaValid: mergePlanValid,
        humanContinuation: "not-executed"
      }
    }
  ];
  return stableResult({
    apiVersion: API_VERSION,
    kind: "AuthorityBoundaryWalkthrough",
    schemaVersion: "1.0.0",
    title: "Hyperfinite five-minute authority-boundary walkthrough",
    mode: {
      synthetic: true,
      deterministic: true,
      offline: true,
      expectedDurationMinutes: 5
    },
    steps,
    counters: { ...counters },
    finalState: humanReview.snapshot.state,
    automation: {
      approve: "denied",
      merge: "absent",
      continuation: "independent-human-only"
    },
    readiness: "hermetic-repository-evidence-only"
  });
}

function step(
  result: AuthorityWalkthroughResult,
  id: AuthorityWalkthroughStep["id"]
): AuthorityWalkthroughStep {
  const found = result.steps.find((candidate) => candidate.id === id);
  if (found === undefined) throw new TypeError(`walkthrough step ${id} is missing`);
  return found;
}

export function renderAuthorityBoundaryTranscript(
  result: AuthorityWalkthroughResult
): string {
  const targetFree = step(result, "target-free-schema");
  const disabled = step(result, "runtime-disabled");
  const activation = step(result, "activation-missing");
  const trusted = step(result, "trusted-route");
  const stale = step(result, "stale-head");
  const fresh = step(result, "fresh-comment");
  const review = step(result, "human-review");
  const trustedTarget = trusted.evidence["target"] as Readonly<
    Record<string, unknown>
  >;
  const freshTarget = fresh.evidence["target"] as Readonly<
    Record<string, unknown>
  >;
  return [
    "$ npm run demo:authority",
    "",
    "Hyperfinite authority-boundary walkthrough",
    "Mode: SYNTHETIC / DETERMINISTIC / OFFLINE",
    "",
    `1. MODEL OUTPUT ........ ${targetFree.outcome.toUpperCase()} [${targetFree.code}]`,
    "   Attempted repository, issueNumber, and effect fields are outside the closed schema.",
    "   Provider calls: 0 | effects: 0",
    "",
    `2. PRE-ACTIVATION ...... ${disabled.outcome.toUpperCase()} [${disabled.code}]`,
    "   Runtime disabled; no model, credential, network, or effect boundary is crossed.",
    "",
    `3. CONTROL KERNEL ...... ${activation.outcome.toUpperCase()} [${activation.code}]`,
    "   Cost-bearing activation.begin-framing has no current Activation Lease.",
    "   Provider calls: 0 | effects: 0",
    "",
    `4. TRUSTED ROUTE ....... ${trusted.outcome.toUpperCase()} [${trusted.code}]`,
    "   Current human activation evidence and an exact lease satisfy the Kernel.",
    `   Trusted Binding derives ${String(trustedTarget["repositoryFullName"])}#${String(
      trustedTarget["pullRequestNumber"]
    )} @ ${String(trustedTarget["headSha"])}.`,
    "   The model supplied advisory content only; trusted code supplied every target.",
    "",
    `5. SINGLE WRITER ....... ${stale.outcome.toUpperCase()} [${stale.code}]`,
    `   Expected ${String(stale.evidence["expectedHead"])}; observed ${String(
      stale.evidence["observedHead"]
    )}.`,
    `   Fake-provider effects: ${stale.effectCount} | live effects: 0`,
    "",
    `6. FRESH EFFECT PLAN ... ${fresh.outcome.toUpperCase()} [${fresh.code}]`,
    `   Fresh revision ${String(fresh.evidence["authorityRevision"])} binds ${String(
      freshTarget["repositoryFullName"]
    )}#${String(freshTarget["pullRequestNumber"])} @ ${String(
      freshTarget["headSha"]
    )}.`,
    "   Event: COMMENT | injected fake-provider effects: 1 | live effects: 0",
    "",
    `7. LIFECYCLE ........... ${review.outcome.toUpperCase()} [${review.code}]`,
    "   Automation cannot emit APPROVE or merge and cannot cross review.accept.",
    "   Synthetic-human continuation is not executed; only independent human authority may continue.",
    "",
    `Final counters: model=${result.counters.modelCalls}, network=${result.counters.networkCalls}, credential-reads=${result.counters.credentialReads}, live-effects=${result.counters.liveEffects}, fake-effects=${result.counters.fakeProviderEffects}`,
    `Scenario digest: ${result.scenarioDigest}`,
    "",
    "This is hermetic repository evidence, not live deployment or readiness evidence.",
    ""
  ].join("\n");
}

export function renderAuthorityBoundaryRecordingFrames(
  result: AuthorityWalkthroughResult
): readonly (readonly string[])[] {
  return [
    [
      "$ NPM RUN DEMO:AUTHORITY",
      "HYPERFINITE - SYNTHETIC OFFLINE WALKTHROUGH"
    ],
    [
      `1 MODEL OUTPUT: REFUSED ${step(result, "target-free-schema").code}`,
      "TARGET FIELDS NEVER CROSS THE CLOSED SCHEMA"
    ],
    [
      `2 PRE-ACTIVATION: REFUSED ${step(result, "runtime-disabled").code}`,
      "MODEL=0 NETWORK=0 LIVE EFFECTS=0"
    ],
    [
      `3 CONTROL KERNEL: REFUSED ${step(result, "activation-missing").code}`,
      "NO CURRENT LEASE - EFFECTS=0"
    ],
    [
      "4 TRUSTED ROUTE: APPLIED",
      "EXACT TARGET COMES FROM TRUSTED BINDING"
    ],
    [
      `5 SINGLE WRITER: REFUSED ${step(result, "stale-head").code}`,
      "CHANGED HEAD - EFFECTS=0"
    ],
    [
      "6 FRESH EXACT-HEAD COMMENT: APPLIED",
      "EVENT=COMMENT FAKE EFFECTS=1 LIVE=0"
    ],
    [
      `7 CONTROL KERNEL: ${result.finalState}`,
      "AUTOMATION APPROVE=DENIED; MERGE=ABSENT"
    ],
    ["HERMETIC EVIDENCE ONLY - NOT LIVE READINESS"]
  ];
}

export function renderAuthorityBoundaryDocument(
  result: AuthorityWalkthroughResult
): string {
  return [
    "# Authority-boundary walkthrough",
    "",
    "> Generated from the executable deterministic walkthrough. Do not hand-edit",
    "> the transcript or recording; regenerate both from the command below.",
    "",
    "This walkthrough uses fixed synthetic identities, clocks, keys, content, and",
    "an injected fake provider. It performs no network call, credential read, paid",
    "inference, GitHub mutation, approval, or merge. The result is hermetic",
    "repository evidence only; it is not live deployment or readiness evidence.",
    "",
    "The `control-plane-core` customer-starter profile intentionally includes and",
    "advertises `demo:authority` because it exercises that profile's hermetic",
    "control-plane surface. The media generator and generated evidence are included",
    "for reproducibility but do not add a live or administrative command.",
    "",
    "## Run",
    "",
    "From an exact reviewed repository clone after installing the locked",
    "dependencies:",
    "",
    "```bash",
    "npm ci --ignore-scripts --no-audit --no-fund",
    "npm run demo:authority",
    "```",
    "",
    "The structured result is also available without changing the scenario:",
    "",
    "```bash",
    "npm run demo:authority -- --format=json",
    "```",
    "",
    "## Reproduce the recording",
    "",
    "The media generator uses the same canonical structured result and transcript",
    "projection as the executable command and requires no external recorder:",
    "",
    "```bash",
    "npm run demo:authority:recording",
    "```",
    "",
    "The executable text below remains authoritative when animated pixels cannot",
    "be validated or animation is disabled.",
    "",
    "## Complete static transcript",
    "",
    "```text",
    renderAuthorityBoundaryTranscript(result).trimEnd(),
    "```",
    ""
  ].join("\n");
}
