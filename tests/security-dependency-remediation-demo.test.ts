import assert from "node:assert/strict";
import { verify as verifySignature } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { parse } from "yaml";

import {
  PINNED_WORKFLOW_ACTIONS,
  assertDemoModelOutputHasNoControlFields,
  assertDocument,
  demoContractContentDigest,
  digest,
  validateDemoContract,
  validateDemoProjectContractSet,
  validateDemoRegistrationShards,
  type CapabilityRegistry,
  type DemoProjectContractSet,
  type LifecycleGraph
} from "../src/index.js";

const ROOT =
  "config/v1alpha1/demo-projects/security-dependency-remediation";
const SCHEMA_ROOT =
  "schemas/v1alpha1/demo-projects/security-dependency-remediation";
const EXAMPLE_ROOT =
  "examples/demos/security-dependency-remediation";
const FIXTURE_ROOT =
  "tests/fixtures/demos/security-dependency-remediation";
const ZERO_DIGEST = `sha256:${"0".repeat(64)}`;
const EXPECTED_STAGES = [
  "intake",
  "triage",
  "reproduction-and-impact-analysis",
  "remediation-design",
  "patch-planning",
  "patch-implementation",
  "security-verification",
  "human-review",
  "completed"
] as const;
const EXPECTED_MODEL_STAGES = [
  "triage",
  "reproduction-and-impact-analysis",
  "remediation-design",
  "patch-implementation",
  "security-verification"
] as const;
const EXPECTED_RECOVERY_CASES = [
  "pause",
  "block",
  "cancel",
  "repair",
  "replan",
  "revision",
  "retry",
  "partial-effect",
  "lost-ack",
  "scanner-unavailable",
  "stale-advisory",
  "reauthorization"
] as const;
const EXPECTED_ADVERSARIAL_CASES = [
  "arbitrary-network-request",
  "credential-request",
  "production-exploit-request",
  "prompt-injection",
  "malformed-evidence",
  "oversized-evidence",
  "manifest-lock-mismatch",
  "path-traversal",
  "unexpected-diff",
  "scanner-missing",
  "scanner-failed",
  "scanner-stale",
  "threat-warning",
  "dlp-missing",
  "stale-advisory",
  "stale-head",
  "stale-predecessor",
  "wrong-agent",
  "wrong-capability",
  "cross-demo-artifact",
  "duplicate-agent-identity",
  "skipped-stage",
  "reordered-stage",
  "unrelated-finding-fixed-claim",
  "unrelated-finding-dismissal",
  "approval-attempt",
  "merge-attempt",
  "project-reconfiguration",
  "blind-lost-ack-retry"
] as const;

interface AddressedDocument {
  readonly apiVersion: string;
  readonly kind: string;
  readonly schemaVersion: string;
  readonly contentDigest: `sha256:${string}`;
  readonly spec: unknown;
}

interface SecurityAssertion {
  readonly id: string;
  readonly status: "success" | "information";
  readonly evidenceDigest: `sha256:${string}`;
}

interface SecurityArtifact extends AddressedDocument {
  readonly spec: {
    readonly demoProjectId: string;
    readonly stageId: string;
    readonly trustedBindingDigest: `sha256:${string}`;
    readonly subjectDigest: `sha256:${string}`;
    readonly headSha: string | null;
    readonly status: "draft" | "verified" | "waiting-human";
    readonly assertions: readonly SecurityAssertion[];
    readonly constraints: readonly string[];
    readonly externalCallCount: 0;
  };
}

interface SyntheticEvidence extends AddressedDocument {
  readonly spec: {
    readonly demoProjectId: string;
    readonly evidenceType: "advisory" | "scanner";
    readonly evidenceId: string;
    readonly dependency: "mist-lru";
    readonly affectedVersion: "0.4.0";
    readonly fixedVersion: "0.4.1";
    readonly headSha: string | null;
    readonly subjectDigest: `sha256:${string}`;
    readonly outcome: "affected" | "success";
    readonly findings: readonly string[];
    readonly observedAt: string;
    readonly expiresAt: string;
    readonly synthetic: true;
    readonly networkUsed: false;
  };
  readonly signature: {
    readonly algorithm: "ed25519";
    readonly keyId: string;
    readonly value: string;
  };
}

interface ScenarioDocument extends AddressedDocument {
  readonly spec: {
    readonly demoProjectId: string;
    readonly scenarios: readonly {
      readonly id: string;
      readonly input: string;
      readonly expectedAction: string;
      readonly expectedState: string;
      readonly inferenceAllowed: boolean;
      readonly effectAllowed: boolean;
      readonly externalCallCount: 0;
    }[];
  };
}

interface ArtifactCatalog extends AddressedDocument {
  readonly spec: {
    readonly demoProjectId: string;
    readonly artifactSchemaRef: string;
    readonly syntheticEvidenceSchemaRef: string;
    readonly artifacts: readonly {
      readonly kind: string;
      readonly stageId: string;
      readonly templateRef: string;
    }[];
  };
}

async function readJson<T = unknown>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function assertAddressed(document: AddressedDocument): void {
  assert.equal(
    document.contentDigest,
    demoContractContentDigest(document.kind as never, document.spec)
  );
  assert.notEqual(document.contentDigest, ZERO_DIGEST);
}

function validator(schema: object): ValidateFunction {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    validateFormats: false
  });
  return ajv.compile(schema);
}

async function loadContractSet(): Promise<{
  readonly contracts: DemoProjectContractSet;
  readonly lifecycle: LifecycleGraph;
  readonly registry: CapabilityRegistry;
  readonly catalog: unknown;
  readonly reservations: unknown;
}> {
  const [
    catalog,
    reservations,
    lifecycle,
    registry,
    profile,
    journey,
    capabilities,
    bindings,
    activation,
    projection
  ] = await Promise.all([
    readJson("config/v1alpha1/demo-portfolio/catalog.json"),
    readJson("config/v1alpha1/demo-portfolio/identity-reservations.json"),
    readJson<LifecycleGraph>("config/v1alpha1/lifecycle.json"),
    readJson<CapabilityRegistry>("config/v1alpha1/capability-registry.json"),
    readJson(`${ROOT}/project-profile.json`),
    readJson(`${ROOT}/journey.json`),
    readJson(`${ROOT}/capabilities.json`),
    readJson(`${ROOT}/runtime-bindings.json`),
    readJson(`${ROOT}/activation-profile.json`),
    readJson(`${ROOT}/projection-mapping.json`)
  ]);
  const contracts = validateDemoProjectContractSet({
    catalog,
    reservations,
    lifecycle,
    baseRegistry: registry,
    contracts: {
      profile: validateDemoContract("DemoProjectProfile", profile),
      journey: validateDemoContract("DemoJourneyDefinition", journey),
      capabilities: validateDemoContract(
        "DemoCapabilityRegistryShard",
        capabilities
      ),
      bindings: validateDemoContract("StageAgentBindingSet", bindings),
      activation: validateDemoContract("DemoActivationProfile", activation),
      projection: validateDemoContract("DemoProjectionMapping", projection)
    }
  });
  return { contracts, lifecycle, registry, catalog, reservations };
}

test("security remediation core contracts close over exact reserved identities", async () => {
  const { contracts, registry, catalog, reservations } =
    await loadContractSet();
  assert.equal(contracts.profile.spec.demoProjectId, "security-dependency-remediation");
  assert.equal(contracts.activation.spec.enabled, false);
  assert.deepEqual(
    contracts.journey.spec.stages.map((stage) => stage.stageId),
    EXPECTED_STAGES
  );
  assert.deepEqual(
    contracts.journey.spec.stages
      .filter((stage) => stage.executionKind === "model")
      .map((stage) => stage.stageId),
    EXPECTED_MODEL_STAGES
  );
  assert.deepEqual(
    contracts.bindings.spec.stageBindings
      .filter((binding) => binding.runtimeBindings.length > 0)
      .map((binding) => binding.runtimeBindings[0]?.agent),
    EXPECTED_MODEL_STAGES.map(
      (stage) => `security-dependency-remediation-${stage}`
    )
  );
  for (const binding of contracts.bindings.spec.stageBindings) {
    assert.equal(
      binding.runtimeBindings.length,
      binding.executionKind === "model" ? 1 : 0
    );
  }
  assert.ok(
    contracts.bindings.spec.controlBindings.every(
      (binding) => binding.runtimeBindings.length === 0
    )
  );
  const trusted = validateDemoRegistrationShards({
    catalog,
    reservations,
    baseRegistry: registry,
    shards: [
      {
        capabilities: contracts.capabilities,
        bindings: contracts.bindings
      }
    ]
  });
  assert.equal(trusted.length, 5);
  assert.equal(new Set(trusted.map((binding) => binding.agent)).size, 5);
  assert.equal(new Set(trusted.map((binding) => binding.capability)).size, 5);
  assert.equal(new Set(trusted.map((binding) => binding.workflow)).size, 5);
  assert.ok(
    trusted.every(
      (binding) =>
        binding.workflowClass ===
        (binding.phase === "framing"
          ? "framing-comment"
          : binding.phase === "execution"
            ? "target-free-execution"
            : "current-head-comment-review")
    )
  );
});

test("trusted configuration binds target, advisory, base, slots, checks, and budget", async () => {
  const [
    trustedSchema,
    trustedValue,
    profileValue,
    projectSchema,
    accordValue,
    activationBinding
  ] = await Promise.all([
    readJson<object>(`${SCHEMA_ROOT}/trusted-binding.schema.json`),
    readJson<AddressedDocument>(`${ROOT}/trusted-binding.json`),
    readJson(`${ROOT}/project-profile.json`),
    readJson(`${ROOT}/project-schema.json`),
    readJson(`${EXAMPLE_ROOT}/work-accord.json`),
    readJson<AddressedDocument>(`${FIXTURE_ROOT}/activation-binding.json`)
  ]);
  const validate = validator(trustedSchema);
  assert.equal(validate(trustedValue), true, JSON.stringify(validate.errors));
  assertAddressed(trustedValue);
  assertAddressed(activationBinding);
  const trusted = trustedValue as AddressedDocument & {
    readonly spec: {
      readonly repository: { readonly fullName: string; readonly baseSha: string };
      readonly advisory: {
        readonly id: string;
        readonly dependency: string;
        readonly affectedVersion: string;
        readonly fixedVersion: string;
      };
      readonly targetSlots: readonly { readonly slot: string; readonly path: string }[];
      readonly fixedChecks: readonly string[];
      readonly externalCallBudget: number;
      readonly networkDestinations: readonly string[];
      readonly secretNames: readonly string[];
    };
  };
  assert.equal(trusted.spec.repository.fullName, "example/security-remediation-sandbox");
  assert.equal(trusted.spec.repository.baseSha, "8f594d53db291f6bb2803f26d421a70ced556362");
  assert.deepEqual(
    [
      trusted.spec.advisory.id,
      trusted.spec.advisory.dependency,
      trusted.spec.advisory.affectedVersion,
      trusted.spec.advisory.fixedVersion
    ],
    ["SDRA-2026-0001", "mist-lru", "0.4.0", "0.4.1"]
  );
  assert.equal(trusted.spec.targetSlots.length, 4);
  assert.equal(new Set(trusted.spec.targetSlots.map((slot) => slot.slot)).size, 4);
  assert.equal(trusted.spec.fixedChecks.length, 6);
  assert.equal(trusted.spec.externalCallBudget, 0);
  assert.deepEqual(trusted.spec.networkDestinations, []);
  assert.deepEqual(trusted.spec.secretNames, []);

  const profile = validateDemoContract("DemoProjectProfile", profileValue);
  assert.equal(profile.spec.repositoryBindingDigest, trustedValue.contentDigest);
  assert.equal(profile.spec.projectBindingDigest, digest(projectSchema));
  assert.equal(profile.spec.workAccordTemplateDigest, digest(accordValue));
  assert.equal(profile.spec.defaultDepthProfile, "D3");
  assert.deepEqual(profile.spec.allowedDepthProfiles, ["D3"]);
  assertDocument("WorkAccord", accordValue);
});

test("demo Phase Contracts narrow model, patch, verification, and human authority", async () => {
  const accord = assertDocument(
    "WorkAccord",
    await readJson(`${EXAMPLE_ROOT}/work-accord.json`)
  );
  const expectedCapabilities = {
    framing: EXPECTED_MODEL_STAGES.slice(0, 3).map(
      (stage) => `demo.security-dependency-remediation.${stage}@1.0.0`
    ),
    planning: [],
    execution: [
      "demo.security-dependency-remediation.patch-implementation@1.0.0"
    ],
    verification: [
      "demo.security-dependency-remediation.security-verification@1.0.0"
    ],
    "human-review": []
  } as const;
  for (const phase of [
    "framing",
    "planning",
    "execution",
    "verification",
    "human-review"
  ] as const) {
    const value = assertDocument(
      "PhaseContract",
      await readJson(`${ROOT}/phase-contracts/${phase}.json`)
    );
    assert.equal(value.phase, phase);
    assert.deepEqual(value.allowedCapabilities, expectedCapabilities[phase]);
    assert.equal(accord.policy.phaseContracts[phase]?.digest, digest(value));
    if (phase === "planning" || phase === "human-review") {
      assert.equal(value.limits.maxCalls, 0);
      assert.equal(value.limits.maxCostUnits, 0);
    }
  }
  const verification = assertDocument(
    "PhaseContract",
    await readJson(`${ROOT}/phase-contracts/verification.json`)
  );
  assert.ok(verification.requiredEvidence.includes("fixed-regression-success"));
  assert.ok(
    verification.requiredEvidence.includes(
      "dependency-lock-consistency-success"
    )
  );
  assert.ok(verification.requiredEvidence.includes("threat-detection-success"));
  assert.ok(verification.requiredEvidence.includes("dlp-success"));
  assert.ok(
    verification.requiredEvidence.includes(
      "signed-synthetic-scanner-success"
    )
  );
  assert.ok(verification.requiredEvidence.includes("known-alert-unchanged"));
});

test("artifact catalog is closed, content-addressed, and complete", async () => {
  const [catalogSchema, artifactSchema, catalogValue] = await Promise.all([
    readJson<object>(`${SCHEMA_ROOT}/artifact-catalog.schema.json`),
    readJson<object>(`${SCHEMA_ROOT}/security-remediation-artifact.schema.json`),
    readJson<ArtifactCatalog>(`${ROOT}/artifact-catalog.json`)
  ]);
  const validateCatalog = validator(catalogSchema);
  const validateArtifact = validator(artifactSchema);
  assert.equal(
    validateCatalog(catalogValue),
    true,
    JSON.stringify(validateCatalog.errors)
  );
  assertAddressed(catalogValue);
  assert.equal(catalogValue.spec.artifacts.length, 8);
  const seenKinds = new Set<string>();
  for (const entry of catalogValue.spec.artifacts) {
    const artifact = await readJson<SecurityArtifact>(entry.templateRef);
    assert.equal(
      validateArtifact(artifact),
      true,
      `${entry.templateRef}: ${JSON.stringify(validateArtifact.errors)}`
    );
    assertAddressed(artifact);
    assert.equal(artifact.kind, entry.kind);
    assert.equal(artifact.spec.stageId, entry.stageId);
    assert.equal(artifact.spec.externalCallCount, 0);
    seenKinds.add(artifact.kind);
  }
  assert.equal(seenKinds.size, 8);
});

test("synthetic advisory and scanner evidence are signed and current for their subject", async () => {
  const [schema, publicKey, advisory, scanner] = await Promise.all([
    readJson<object>(`${SCHEMA_ROOT}/synthetic-security-evidence.schema.json`),
    readFile(`${EXAMPLE_ROOT}/evidence/synthetic-evidence-public-key.pem`, "utf8"),
    readJson<SyntheticEvidence>(
      `${EXAMPLE_ROOT}/evidence/synthetic-advisory.json`
    ),
    readJson<SyntheticEvidence>(
      `${EXAMPLE_ROOT}/evidence/synthetic-scanner-evidence.json`
    )
  ]);
  const validate = validator(schema);
  for (const evidence of [advisory, scanner]) {
    assert.equal(validate(evidence), true, JSON.stringify(validate.errors));
    assertAddressed(evidence);
    assert.equal(
      verifySignature(
        null,
        Buffer.from(evidence.contentDigest, "utf8"),
        publicKey,
        Buffer.from(evidence.signature.value, "base64")
      ),
      true
    );
    assert.ok(Date.parse(evidence.spec.observedAt) < Date.parse(evidence.spec.expiresAt));
    assert.equal(evidence.spec.synthetic, true);
    assert.equal(evidence.spec.networkUsed, false);
  }
  assert.equal(advisory.spec.evidenceType, "advisory");
  assert.equal(advisory.spec.outcome, "affected");
  assert.equal(advisory.spec.headSha, null);
  assert.equal(scanner.spec.evidenceType, "scanner");
  assert.equal(scanner.spec.outcome, "success");
  assert.match(scanner.spec.headSha ?? "", /^[0-9a-f]{40}$/u);
});

test("reproduction is pure and patch output remains target-free", async () => {
  const [reproduction, patch] = await Promise.all([
    readJson<SecurityArtifact>(
      `${ROOT}/artifact-templates/reproduction-evidence.json`
    ),
    readJson(`${EXAMPLE_ROOT}/target-free-patch.json`)
  ]);
  assertDocument("TargetFreePatch", patch);
  assert.ok(
    [
      "pure-fixture-comparison",
      "no-production-exploit",
      "no-package-install-or-lifecycle-script",
      "no-network-or-credentials"
    ].every((id) =>
      reproduction.spec.assertions.some(
        (assertion) => assertion.id === id && assertion.status === "success"
      )
    )
  );
  const changes = (patch as {
    readonly changes: readonly {
      readonly slot: string;
      readonly content: string;
    }[];
  }).changes;
  assert.deepEqual(
    changes.map((change) => change.slot),
    [
      "dependency-manifest",
      "dependency-lock",
      "cache-key-source",
      "cache-key-regression"
    ]
  );
  assert.ok(
    changes.every(
      (change) =>
        Object.keys(change).sort().join(",") === "content,slot" &&
        !change.slot.includes("/") &&
        !change.slot.includes("..")
    )
  );
  for (const unsafe of [
    { repository: "github/other" },
    { path: "src/canonical.ts" },
    { stageId: "completed" },
    { capability: "core.execute-bounded-change@1.0.0" },
    { effects: [{ type: "merge" }] },
    { credential: "token" },
    { retry: true }
  ]) {
    assert.throws(
      () => assertDemoModelOutputHasNoControlFields(unsafe),
      /prohibited control field|outside the closed advisory vocabulary/u
    );
  }
});

function verificationGate(input: {
  readonly verification: SecurityArtifact;
  readonly scanner: SyntheticEvidence | null;
  readonly currentHead: string;
  readonly now: string;
}): "ready-for-human-review" | "blocked" {
  if (
    input.scanner === null ||
    input.verification.spec.headSha !== input.currentHead ||
    input.scanner.spec.headSha !== input.currentHead ||
    input.scanner.spec.outcome !== "success" ||
    Date.parse(input.scanner.spec.expiresAt) <= Date.parse(input.now)
  ) {
    return "blocked";
  }
  const required = [
    "fixed-regression",
    "dependency-lock-consistency",
    "threat-detection",
    "dlp-scan",
    "synthetic-security-scan",
    "automation-review-comment-only"
  ];
  const assertions = new Map(
    input.verification.spec.assertions.map((assertion) => [
      assertion.id,
      assertion.status
    ])
  );
  if (
    required.some((id) => assertions.get(id) !== "success") ||
    assertions.get("unrelated-scanner-finding-open-unchanged") !== "information"
  ) {
    return "blocked";
  }
  return "ready-for-human-review";
}

test("security verification fails closed on missing, non-success, or stale evidence", async () => {
  const [verification, scanner, adversarial] = await Promise.all([
    readJson<SecurityArtifact>(
      `${ROOT}/artifact-templates/security-verification.json`
    ),
    readJson<SyntheticEvidence>(
      `${EXAMPLE_ROOT}/evidence/synthetic-scanner-evidence.json`
    ),
    readJson<ScenarioDocument>(`${FIXTURE_ROOT}/adversarial-scenarios.json`)
  ]);
  const currentHead = scanner.spec.headSha!;
  assert.equal(
    verificationGate({
      verification,
      scanner,
      currentHead,
      now: "2026-08-29T20:06:00Z"
    }),
    "ready-for-human-review"
  );
  assert.equal(
    verificationGate({
      verification,
      scanner: null,
      currentHead,
      now: "2026-08-29T20:06:00Z"
    }),
    "blocked"
  );
  assert.equal(
    verificationGate({
      verification,
      scanner,
      currentHead: "8".repeat(40),
      now: "2026-08-29T20:06:00Z"
    }),
    "blocked"
  );
  assert.equal(
    verificationGate({
      verification,
      scanner,
      currentHead,
      now: scanner.spec.expiresAt
    }),
    "blocked"
  );
  const warning = structuredClone(verification);
  const threat = warning.spec.assertions.find(
    (assertion) => assertion.id === "threat-detection"
  );
  assert.notEqual(threat, undefined);
  (threat as { status: "success" | "information" }).status = "information";
  assert.equal(
    verificationGate({
      verification: warning,
      scanner,
      currentHead,
      now: "2026-08-29T20:06:00Z"
    }),
    "blocked"
  );
  for (const id of [
    "scanner-missing",
    "scanner-failed",
    "scanner-stale",
    "threat-warning",
    "dlp-missing",
    "stale-head",
    "unrelated-finding-fixed-claim",
    "unrelated-finding-dismissal"
  ]) {
    const scenario = adversarial.spec.scenarios.find(
      (candidate) => candidate.id === id
    );
    assert.notEqual(scenario, undefined);
    assert.equal(scenario?.inferenceAllowed, false);
    assert.equal(scenario?.effectAllowed, false);
  }
});

test("journey and recovery scenarios are hermetic and stop at the human gate", async () => {
  const [schema, traceSchema, journey, recovery, adversarial, trace, continuation] =
    await Promise.all([
    readJson<object>(`${SCHEMA_ROOT}/scenario-fixtures.schema.json`),
    readJson<object>(`${SCHEMA_ROOT}/journey-trace.schema.json`),
    readJson<ScenarioDocument>(`${FIXTURE_ROOT}/journey-scenarios.json`),
    readJson<ScenarioDocument>(`${FIXTURE_ROOT}/recovery-scenarios.json`),
    readJson<ScenarioDocument>(`${FIXTURE_ROOT}/adversarial-scenarios.json`),
    readJson<AddressedDocument>(`${FIXTURE_ROOT}/hands-off-trace.json`),
    readJson<AddressedDocument>(
      `${FIXTURE_ROOT}/synthetic-human-continuation.json`
    )
  ]);
  const validate = validator(schema);
  const validateTrace = validator(traceSchema);
  for (const document of [journey, recovery, adversarial]) {
    assert.equal(validate(document), true, JSON.stringify(validate.errors));
    assertAddressed(document);
    assert.ok(
      document.spec.scenarios.every(
        (scenario) => scenario.externalCallCount === 0
      )
    );
  }
  const handsOff = journey.spec.scenarios.find(
    (scenario) => scenario.id === "hands-off-to-human-review"
  );
  const human = journey.spec.scenarios.find(
    (scenario) => scenario.id === "synthetic-human-to-completed"
  );
  assert.deepEqual(
    {
      action: handsOff?.expectedAction,
      state: handsOff?.expectedState,
      externalCalls: handsOff?.externalCallCount
    },
    { action: "wait-human", state: "HUMAN_REVIEW", externalCalls: 0 }
  );
  assert.deepEqual(
    {
      action: human?.expectedAction,
      state: human?.expectedState,
      inference: human?.inferenceAllowed,
      effect: human?.effectAllowed,
      externalCalls: human?.externalCallCount
    },
    {
      action: "advance",
      state: "COMPLETED",
      inference: false,
      effect: false,
      externalCalls: 0
    }
  );
  assert.deepEqual(
    recovery.spec.scenarios.map((scenario) => scenario.id),
    EXPECTED_RECOVERY_CASES
  );
  assert.ok(
    recovery.spec.scenarios.every(
      (scenario) =>
        scenario.inferenceAllowed === false &&
        scenario.effectAllowed === false
    )
  );
  assert.deepEqual(
    adversarial.spec.scenarios.map((scenario) => scenario.id),
    EXPECTED_ADVERSARIAL_CASES
  );
  assert.ok(
    adversarial.spec.scenarios.every(
      (scenario) =>
        scenario.inferenceAllowed === false &&
        scenario.effectAllowed === false
    )
  );
  assert.equal(validateTrace(trace), true, JSON.stringify(validateTrace.errors));
  assert.equal(
    validateTrace(continuation),
    true,
    JSON.stringify(validateTrace.errors)
  );
  assertAddressed(trace);
  assertAddressed(continuation);
  const traceSpec = trace.spec as {
    readonly entries: readonly {
      readonly stageId: string;
      readonly ordinal: number;
      readonly executionKind: string;
      readonly agentId: string | null;
      readonly receiptDigest: string | null;
    }[];
    readonly currentStageId: string;
    readonly currentCoreState: string;
    readonly humanActionCount: number;
    readonly externalCallCount: number;
  };
  assert.deepEqual(
    traceSpec.entries.map((entry) => entry.stageId),
    EXPECTED_STAGES.slice(0, 8)
  );
  assert.ok(
    traceSpec.entries.every(
      (entry, index) =>
        entry.ordinal === index + 1 &&
        (entry.executionKind === "model"
          ? entry.agentId ===
            `security-dependency-remediation-${entry.stageId}`
          : entry.agentId === null) &&
        (entry.stageId === "human-review"
          ? entry.receiptDigest === null
          : entry.receiptDigest !== null)
    )
  );
  assert.deepEqual(
    {
      stage: traceSpec.currentStageId,
      core: traceSpec.currentCoreState,
      humanActions: traceSpec.humanActionCount,
      externalCalls: traceSpec.externalCallCount
    },
    {
      stage: "human-review",
      core: "HUMAN_REVIEW",
      humanActions: 0,
      externalCalls: 0
    }
  );
  const continuationSpec = continuation.spec as {
    readonly predecessorTraceDigest: string;
    readonly fromStageId: string;
    readonly toStageId: string;
    readonly routeId: string;
    readonly independent: boolean;
    readonly automationActor: boolean;
    readonly externalCallCount: number;
  };
  assert.deepEqual(
    {
      predecessor: continuationSpec.predecessorTraceDigest,
      from: continuationSpec.fromStageId,
      to: continuationSpec.toStageId,
      route: continuationSpec.routeId,
      independent: continuationSpec.independent,
      automation: continuationSpec.automationActor,
      externalCalls: continuationSpec.externalCallCount
    },
    {
      predecessor: trace.contentDigest,
      from: "human-review",
      to: "completed",
      route: "review.accept",
      independent: true,
      automation: false,
      externalCalls: 0
    }
  );
});

test("five stage-local workflows retain pinned guards and COMMENT-only review", async () => {
  const { contracts } = await loadContractSet();
  const modelBindings = contracts.bindings.spec.stageBindings.flatMap(
    (entry) => entry.runtimeBindings
  );
  assert.equal(modelBindings.length, 5);
  for (const binding of modelBindings) {
    const [agent, skill, workflow, lock] = await Promise.all([
      readFile(`.github/agents/${binding.agent}.agent.md`, "utf8"),
      readFile(`.github/skills/${binding.skill}/SKILL.md`, "utf8"),
      readFile(`.github/workflows/${binding.workflow}.md`, "utf8"),
      readFile(`.github/workflows/${binding.workflow}.lock.yml`, "utf8")
    ]);
    assert.ok(agent.includes(`capability: ${binding.capability}`));
    assert.ok(skill.includes(`capability: ${binding.capability}`));
    assert.ok(workflow.includes(`RUNTIME_DEMO_PROJECT_ID: security-dependency-remediation`));
    assert.ok(workflow.includes(`RUNTIME_STAGE_ID: ${binding.workflow.replace("security-dependency-remediation-", "")}`));
    assert.ok(
      workflow.includes(
        "group: agentic-demo-${{ github.repository_id }}-${{ github.event.issue.number }}"
      )
    );
    assert.ok(workflow.includes("cancel-in-progress: false"));
    assert.ok(workflow.includes("network: {}"));
    const manifestMatch = /^# gh-aw-manifest: (.+)$/mu.exec(lock);
    assert.notEqual(manifestMatch?.[1], undefined);
    const manifest = JSON.parse(manifestMatch![1]!) as {
      readonly actions: readonly unknown[];
    };
    assert.deepEqual(manifest.actions, PINNED_WORKFLOW_ACTIONS);
    const frontmatterMatch = /^---\n([\s\S]*?)\n---\n/u.exec(workflow);
    assert.notEqual(frontmatterMatch?.[1], undefined);
    const frontmatter = parse(frontmatterMatch![1]!) as {
      readonly "safe-outputs": {
        readonly "submit-pull-request-review"?: {
          readonly "allowed-events": readonly string[];
        };
      };
    };
    if (binding.workflowClass === "current-head-comment-review") {
      assert.deepEqual(
        frontmatter["safe-outputs"]["submit-pull-request-review"]?.[
          "allowed-events"
        ],
        ["COMMENT"]
      );
    }
    if (binding.workflowClass === "target-free-execution") {
      assert.ok(workflow.includes("TargetFreePatch@1.0.0"));
      assert.ok(workflow.includes("GITHUB_TOKEN: \"\""));
      assert.ok(workflow.includes("stage_implementation_patch"));
    }
  }
});

test("untrusted user text cannot select demo control or effect authority", () => {
  const values = [
    { targetRepository: "github/other" },
    { advisoryId: "USER-SELECTED" },
    { dependencyVersion: "9.9.9" },
    { baseSha: "a".repeat(40) },
    { allowedPaths: ["src/canonical.ts"] },
    { fixedChecks: [] },
    { budget: { maxCalls: 999 } },
    { stage: "completed" },
    { route: "review.accept" },
    { agent: "runtime-reviewer" },
    { action: "merge" },
    { approval: true },
    { dismissAlert: 5 }
  ];
  for (const value of values) {
    assert.throws(
      () => assertDemoModelOutputHasNoControlFields(value),
      /prohibited control field|outside the closed advisory vocabulary/u
    );
  }
});
