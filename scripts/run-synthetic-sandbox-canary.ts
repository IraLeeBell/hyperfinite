#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify
} from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { canonicalJson, digest } from "../src/canonical.js";
import {
  validateDeploymentTopologyPlan,
  type DurableStoreId
} from "../src/deployment-topology.js";
import { parseStrictJson } from "../src/strict-json.js";
import { assertDocument } from "../src/validation.js";

const GENERATED_AT = "2026-09-01T04:46:00.000Z";
const COMMAND = "npm run canary:synthetic";
const NETWORK_GUARD = "dist/scripts/deny-network.js";
const HARDENING_RUNNER = "dist/scripts/validate-demo-hardening.js";
const SIMULATOR = "dist/scripts/simulate-demos.js";
const HARDENING_PLAN = "config/v1alpha1/demo-portfolio/hardening-plan.json";
const DEPLOYMENT_TOPOLOGY = "examples/pre-app/deployment-topology.json";
const SUPPORTED_NODE_MAJORS = [24, 26] as const;
const CHILD_ENVIRONMENT_KEYS = [
  "CI",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_TERMINAL_PROMPT",
  "HOME",
  "LANG",
  "LC_ALL",
  "PATH",
  "TMPDIR"
] as const;
const AUTHORITY_ORDER = [
  "lifecycle",
  "work-accord-and-phase-contracts",
  "policy-and-capability-registry",
  "control-kernel",
  "trusted-adapter",
  "single-writer",
  "model-output"
] as const;
const DURABLE_STORE_IDS = [
  "evidence-store",
  "operation-grant-store",
  "receipt-journal",
  "runtime-state-store"
] as const satisfies readonly DurableStoreId[];
const DURABLE_TEST_FILES = [
  "dist/tests/deployment-topology.test.js",
  "dist/tests/pre-app-api-surface.test.js",
  "dist/tests/durable-api-surface.test.js",
  "dist/tests/durable-substrate.test.js",
  "dist/tests/durable-recovery.test.js",
  "dist/tests/durable-multiprocess.test.js",
  "dist/tests/durable-demo-stores.test.js",
  "dist/tests/durable-demo-scheduler-stores.test.js",
  "dist/tests/durable-domain-engineering-stores.test.js",
  "dist/tests/durable-store-composition.test.js"
] as const;
const EXPECTED_EVIDENCE_INPUT_DIGESTS = {
  "config/v1alpha1/demo-portfolio/hardening-plan.json":
    "sha256:34421dd877c79d421d5af4135c645e3d26a5f32e137cf606e61ddbb0fb9acfa9",
  "dist/scripts/deny-network.js":
    "sha256:19d5862159091b38a01d10e2073ce162a5e3cc61d47ee14e35d5eeb0e7078166",
  "dist/scripts/simulate-demos.js":
    "sha256:73b1d0352365836d2e00506706e4e3229df0afebd3f17a2bc1c05f8964f1ab3f",
  "dist/scripts/validate-demo-hardening.js":
    "sha256:65e5ab60e2527a5a915feb8403244e5eac0b8f15b0fb20688abd782f94c1bc16",
  "dist/tests/adaptive-delivery-demo.test.js":
    "sha256:ed0263d262e3eaad8b1bce324d0e566150122bb5947a4310193588d16db5b9ef",
  "dist/tests/app-modernization-demo.test.js":
    "sha256:79d5db9769e798b53db67bfa814d10a2a70c76fbc5c3646f0da077006e33c745",
  "dist/tests/bounded-worktree.test.js":
    "sha256:a6c0f5fa59668b5c714865e785e19197aa529b0ff8af19cb779ff473bce4d986",
  "dist/tests/control-kernel.test.js":
    "sha256:1b0259616197347e602a621d81e93109a42d2c6cae9f0d927ddf829aed4bb414",
  "dist/tests/copilot-runtime.test.js":
    "sha256:d30a2d8c4034f0530da6f1f6a294f3352644764e0c463e3682f6dc9bf3d5899d",
  "dist/tests/demo-integration.test.js":
    "sha256:d0c3d610fba398739eb0595748a2316f854497bbcf7cd2c0798eac1be912a096",
  "dist/tests/demo-portfolio.test.js":
    "sha256:7de4a631cd9c6542707cbd201ebdc7e3232502f40ac04f1b9d1fff496539a3a3",
  "dist/tests/demo-runtime.test.js":
    "sha256:02cfa7587e6af68880cd9b4aae97a3c013fa75643fcf734ea2e4775879d81c4a",
  "dist/tests/deployment-topology.test.js":
    "sha256:c4fe09312b4febac1755af7087953346af68ca12144f8b0592daac6716b8ade9",
  "dist/tests/domain-packs.test.js":
    "sha256:3d8ee36c4e70b70673a7fd3e0e1c6af74cc886022ab1304d022ed2e2ef1d2c31",
  "dist/tests/durable-api-surface.test.js":
    "sha256:4d2b66a513cb1d38bdaee79d4ea057bc25a633b6400acbb856e9905f5f67f1f8",
  "dist/tests/durable-demo-scheduler-stores.test.js":
    "sha256:a33729d07a63725164774e2fd14b1b5224af5bf37b588dc24d5585876b383916",
  "dist/tests/durable-demo-stores.test.js":
    "sha256:4ba73a139a85387df8c19751c8a637ce03c24a826a390c8750feb100018ae0b1",
  "dist/tests/durable-domain-engineering-stores.test.js":
    "sha256:7288b328a14f80e6d9d3870ae7f881a8f99ea7fda0ee1211725b166739c1ec66",
  "dist/tests/durable-multiprocess.test.js":
    "sha256:c9211384cbd42a0a2b355442f610a92fc728ac563b89460053e366510396fca9",
  "dist/tests/durable-recovery.test.js":
    "sha256:73f6959df1c400762f33842e1f5bcde3b2f032150faa1e0682ef3f50d6fe21e6",
  "dist/tests/durable-store-composition.test.js":
    "sha256:97fb62f47ac436c1eb5c0abc62d349cd2ac1fe6da05e6c21e383372d00f3dfe5",
  "dist/tests/durable-substrate.test.js":
    "sha256:4237a5e1e224120505710d1eee4dab92e203637c8218deedf15c3f042a26ca33",
  "dist/tests/engineering-slice.test.js":
    "sha256:f1775ae4cd0abd6a6eac59992bc3dd30dc9d526e24d9def5f392bf1d40481203",
  "dist/tests/feature-delivery-demo.test.js":
    "sha256:efbdb4b781ac65453e7c913cb53ce3391b6880b4c262480c1da32783ff6711e9",
  "dist/tests/github-adapter.test.js":
    "sha256:3f547d9bed92aee84c2a83c6ccdbe5134155a1a8dea134f2860636a7c8ad096e",
  "dist/tests/github-project-bootstrap.test.js":
    "sha256:48a16ef62994c3d9a1d80d80119b9b3135e87773fbc8f4da15bdcc27952c118c",
  "dist/tests/hybrid-agent-selection.test.js":
    "sha256:17661a4d01bdd4bd41892d7950a943a27b6c9523dc02f8c55bab3a60219fb817",
  "dist/tests/observability.test.js":
    "sha256:a1a6a7d2f263e755298fe42ae6ad5cf4a663ca28b3afdc0c85c317cf8c3ac948",
  "dist/tests/packaging.test.js":
    "sha256:fbfafa80c77076dd9a302ff7d15a6d1a4d6a1517f4772103332201624ab18a16",
  "dist/tests/portfolio-hardening.test.js":
    "sha256:5a21d2d27889ed337f2a38c62402a8b8266c765273d3954cde61c99eda50d668",
  "dist/tests/pre-app-api-surface.test.js":
    "sha256:7d754f83f3c76df85c02020fedb3f1113ac2915676f2e6d6d99049382f6e3444",
  "dist/tests/project-ux.test.js":
    "sha256:e7922d324186ac8d914d91525cebcc98f201b876bd0f7ba9b98267ac87eaddca",
  "dist/tests/review-agent-runtime.test.js":
    "sha256:2ac77a2193a7330dee82ba309b49e95a6104a5ee6764b4e1d885dced786052c7",
  "dist/tests/security-dependency-remediation-demo.test.js":
    "sha256:b4eac3fa64e7e6c866f516e6a68966f08a23fd5ac40a698c0e225f73dd1cebfc",
  "dist/tests/security-regression.test.js":
    "sha256:f4c725f65b7bea08b7d0bef628638c045672829dcb723a4b4ec03d735e80db37",
  "examples/pre-app/deployment-topology.json":
    "sha256:b4acaea0ce704045f35ffb4b031e180a48e3d90fd9e273f8db3e472680e5d0ea"
} as const satisfies Readonly<Record<string, `sha256:${string}`>>;
const RESTART_BOUNDARIES = [
  "activation-claim",
  "selection-grant",
  "dispatch",
  "fence-acquire",
  "demo-budget-reserve",
  "demo-provider-usage",
  "demo-budget-settle",
  "kernel-state",
  "stage-receipt",
  "run-state",
  "recovery-budget",
  "fence-release",
  "domain-grant",
  "engineering-reservation",
  "engineering-hold",
  "engineering-attempt",
  "engineering-usage",
  "engineering-settlement",
  "engineering-release",
  "single-writer-evidence",
  "engineering-checkpoint"
] as const;
const REQUIRED_HARDENING_BOUNDARIES = [
  "credential-broker",
  "activation-lease",
  "activation-claim",
  "dispatch-persistence",
  "budget-reservation",
  "run-fence",
  "post-await-authorization",
  "provider-attempt",
  "provider-invocation",
  "provider-usage-reconciliation",
  "budget-settlement",
  "fence-release",
  "stage-artifact",
  "stage-receipt",
  "kernel-persistence",
  "run-state-persistence",
  "project-field-cas",
  "project-readback",
  "branch-creation",
  "commit-creation",
  "draft-pr-creation",
  "review-evidence",
  "comment-application",
  "closure",
  "cost-release",
  "evidence-ledger",
  "trust-service-unavailability",
  "acknowledgement"
] as const;
const REQUIRED_HARDENING_SCENARIOS = [
  "binding-capability-mismatch",
  "project-substitution",
  "disabled-profile",
  "revoked-profile",
  "budget-exhaustion",
  "stale-project",
  "stale-pr-head",
  "stale-current-head",
  "lost-acknowledgement",
  "cancel",
  "retry-ceiling",
  "generation-invalidation",
  "authorization-invalidation",
  "cross-demo-confusion",
  "draft-only-pull-request",
  "current-head-review",
  "comment-only-review",
  "refuse-approve",
  "refuse-dismiss",
  "refuse-merge",
  "refuse-deploy",
  "refuse-publish",
  "zero-fixture-declared-external-calls"
] as const;
const REQUIRED_DURABLE_TESTS = [
  {
    id: "closed-topology",
    testName: "the topology maps every one of the fifteen ports exactly once"
  },
  {
    id: "restart-continuity",
    testName:
      "uninterrupted and every-boundary restarted runs have identical progression and refusals"
  },
  {
    id: "backup-restore-disabled-recovery",
    testName:
      "backup, restore, and disabled-state recovery preserve fail-closed semantics"
  },
  {
    id: "corruption-refusal",
    testName: "corruption is refused instead of repaired or defaulted"
  },
  {
    id: "budget-and-cost-hold",
    testName:
      "budget exhaustion refuses and an unobserved provider attempt never releases its hold"
  },
  {
    id: "ambiguous-acknowledgement",
    testName:
      "ambiguous and lost acknowledgements stay typed and reconcile only through fresh reads"
  },
  {
    id: "cross-process-append",
    testName:
      "independent processes racing one identical append yield exactly one appended"
  },
  {
    id: "cross-process-conflict",
    testName:
      "independent processes racing conflicting bodies yield one appended and the rest conflict"
  },
  {
    id: "cross-process-cas",
    testName:
      "independent processes compare-and-swapping the same head yield exactly one winner"
  },
  {
    id: "cross-process-visibility",
    testName:
      "a record committed by one process is immediately visible to another"
  },
  {
    id: "activation-restart-replay",
    testName:
      "DemoActivationClaimStore: genesis append, replay, conflict, and restart"
  },
  {
    id: "selection-lost-ack",
    testName:
      "StageAgentSelectionGrantStore: a commit that actually landed is recognized by reread, not retried"
  },
  {
    id: "dispatch-restart-replay",
    testName: "DemoDispatchStore: genesis, replay, conflict, and restart"
  },
  {
    id: "fence-restart",
    testName:
      "fence state survives a restart and a stale post-restart acquire still fails closed"
  },
  {
    id: "budget-restart",
    testName: "budget ledger state survives a restart"
  },
  {
    id: "domain-grant-restart",
    testName:
      "a claim survives a restart and is still refused as a replay afterwards"
  },
  {
    id: "engineering-cost-restart",
    testName: "the cost ledger survives a restart with its pool and chain intact"
  },
  {
    id: "signer-verifier-refusal",
    testName:
      "budget read and reserve fail closed on an unverifiable stored signature"
  },
  {
    id: "no-ambient-environment",
    testName: "the durable modules read no environment variable"
  },
  {
    id: "no-network-client",
    testName: "the durable modules open no network client"
  },
  {
    id: "no-credential-material",
    testName: "the durable modules handle no credential or secret material"
  },
  {
    id: "runtime-gate",
    testName: "the runtime gate accepts the supported majors and probes real capability"
  }
] as const;

interface HardeningEvidence {
  readonly apiVersion: "agentic-framework.github.com/v1alpha1";
  readonly kind: "DemoPortfolioHardeningEvidence";
  readonly schemaVersion: "1.0.0";
  readonly evidenceDigest: `sha256:${string}`;
  readonly faultBoundaries: readonly {
    readonly id: string;
    readonly result: "passed";
  }[];
  readonly demos: readonly {
    readonly demoProjectId: string;
    readonly scenarios: readonly {
      readonly id: string;
      readonly outcome: string;
    }[];
  }[];
  readonly externalCallCounterScope:
    "fixture-declared-external-call-assertions";
  readonly externalCallCounters: Readonly<Record<string, number>>;
  readonly invariants: Readonly<Record<string, boolean>>;
  readonly readiness: {
    readonly repositoryClassification: "repository-hermetic-demo-ready";
    readonly sandboxLiveClassification:
      "blocked-pending-human-administration-and-canary";
    readonly productionClassification: "customer-approval-required";
    readonly projectsProvisioned: false;
    readonly liveModeEnabled: false;
    readonly requiredCanaryStage: "human-review";
  };
}

interface CommandResult {
  readonly stdout: string;
}

function fail(message: string): never {
  throw new TypeError(message);
}

function fileDigest(file: string): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(readFileSync(file))
    .digest("hex")}`;
}

function exactValues(
  actual: readonly string[],
  expected: readonly string[],
  label: string
): void {
  if (
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    fail(`${label} differs from its fixed trusted set`);
  }
}

function assertPinnedEvidenceInputs(hardeningPlan: unknown): void {
  if (
    hardeningPlan === null ||
    typeof hardeningPlan !== "object" ||
    Array.isArray(hardeningPlan)
  ) {
    fail("hardening plan is not one closed object");
  }
  const testFiles = Reflect.get(hardeningPlan, "testFiles");
  if (
    !Array.isArray(testFiles) ||
    testFiles.some((file) => typeof file !== "string")
  ) {
    fail("hardening plan test file set is malformed");
  }
  const expectedPaths = [
    HARDENING_PLAN,
    DEPLOYMENT_TOPOLOGY,
    NETWORK_GUARD,
    SIMULATOR,
    HARDENING_RUNNER,
    ...(testFiles as string[]),
    ...DURABLE_TEST_FILES
  ];
  exactValues(
    [...new Set(expectedPaths)].sort(),
    Object.keys(EXPECTED_EVIDENCE_INPUT_DIGESTS).sort(),
    "pinned evidence inputs"
  );
  for (const [file, expectedDigest] of Object.entries(
    EXPECTED_EVIDENCE_INPUT_DIGESTS
  )) {
    if (fileDigest(file) !== expectedDigest) {
      fail(`reviewed evidence input ${file} changed without a new canary pin`);
    }
  }
}

function runNode(
  args: readonly string[],
  environment: Readonly<Record<string, string>>
): CommandResult {
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: environment,
    maxBuffer: 64 * 1024 * 1024,
    stdio: "pipe",
    timeout: 15 * 60_000
  });
  if (result.status !== 0) {
    fail(
      `credentialless canary subprocess failed with status ${String(result.status)}: ${
        result.stderr || result.stdout
      }`
    );
  }
  return { stdout: result.stdout };
}

function parseHardeningEvidence(source: string): HardeningEvidence {
  const value = parseStrictJson(source);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("hardening evidence is not one closed object");
  }
  const evidence = value as HardeningEvidence;
  const { evidenceDigest, ...body } = evidence;
  if (
    evidence.apiVersion !== "agentic-framework.github.com/v1alpha1" ||
    evidence.kind !== "DemoPortfolioHardeningEvidence" ||
    evidence.schemaVersion !== "1.0.0" ||
    evidenceDigest !== digest(body) ||
    !Array.isArray(evidence.faultBoundaries) ||
    !Array.isArray(evidence.demos) ||
    evidence.demos.length !== 4
  ) {
    fail("hardening evidence is malformed or detached from its content");
  }
  exactValues(
    evidence.faultBoundaries.map((boundary) => boundary.id),
    REQUIRED_HARDENING_BOUNDARIES,
    "hardening fault boundaries"
  );
  if (evidence.faultBoundaries.some((boundary) => boundary.result !== "passed")) {
    fail("a required hardening fault boundary did not pass");
  }
  for (const demo of evidence.demos) {
    const ids = new Set(
      demo.scenarios.map(
        (
          scenario: HardeningEvidence["demos"][number]["scenarios"][number]
        ) => scenario.id
      )
    );
    if (REQUIRED_HARDENING_SCENARIOS.some((id) => !ids.has(id))) {
      fail(`${demo.demoProjectId} omitted a required canary refusal scenario`);
    }
  }
  exactValues(
    Object.keys(evidence.externalCallCounters).sort(),
    ["credentials", "github", "network", "paidInference"],
    "external call counters"
  );
  if (
    evidence.externalCallCounterScope !==
      "fixture-declared-external-call-assertions" ||
    Object.values(evidence.externalCallCounters).some((count) => count !== 0) ||
    Object.values(evidence.invariants).some((result) => result !== true) ||
    evidence.readiness.repositoryClassification !==
      "repository-hermetic-demo-ready" ||
    evidence.readiness.sandboxLiveClassification !==
      "blocked-pending-human-administration-and-canary" ||
    evidence.readiness.productionClassification !== "customer-approval-required" ||
    evidence.readiness.projectsProvisioned !== false ||
    evidence.readiness.liveModeEnabled !== false ||
    evidence.readiness.requiredCanaryStage !== "human-review"
  ) {
    fail("hardening evidence widened a canary invariant or readiness claim");
  }
  return evidence;
}

function passedJunitTests(source: string): ReadonlyMap<string, number> {
  if (/<(?:failure|error|skipped)\b/iu.test(source)) {
    fail("durable canary JUnit contains a failed, errored, skipped, or todo test");
  }
  const names = new Map<string, number>();
  for (const match of source.matchAll(/<testcase\b([^>]*)\/?>/gu)) {
    const name = /\bname="([^"]+)"/u.exec(match[1] ?? "")?.[1];
    if (name === undefined) fail("durable canary JUnit testcase omitted its name");
    names.set(name, (names.get(name) ?? 0) + 1);
  }
  if (names.size === 0) fail("durable canary JUnit contains no passing tests");
  for (const required of REQUIRED_DURABLE_TESTS) {
    if (names.get(required.testName) !== 1) {
      fail(`durable canary requires exactly one passing test named ${required.testName}`);
    }
  }
  return names;
}

function createSyntheticEphemeralKeyPair(): {
  readonly privateKey: ReturnType<typeof createPrivateKey>;
  readonly publicKey: ReturnType<typeof createPublicKey>;
} {
  const seed = createHash("sha256")
    .update("agentic-framework credentialless synthetic sandbox canary v1", "utf8")
    .digest();
  const privateKey = createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      seed
    ]),
    format: "der",
    type: "pkcs8"
  });
  return { privateKey, publicKey: createPublicKey(privateKey) };
}

export function signSyntheticCanaryBody(body: unknown): {
  readonly algorithm: "ed25519";
  readonly keyId: "synthetic-canary:ephemeral:v1";
  readonly publicKey: string;
  readonly value: string;
} {
  const keys = createSyntheticEphemeralKeyPair();
  const bytes = Buffer.from(canonicalJson(body), "utf8");
  const publicKey = (
    keys.publicKey.export({ format: "der", type: "spki" }) as Buffer
  ).toString("base64");
  const value = sign(null, bytes, keys.privateKey).toString("base64");
  if (
    !verify(
      null,
      bytes,
      createPublicKey({
        key: Buffer.from(publicKey, "base64"),
        format: "der",
        type: "spki"
      }),
      Buffer.from(value, "base64")
    )
  ) {
    fail("synthetic ephemeral canary signature did not verify");
  }
  return {
    algorithm: "ed25519",
    keyId: "synthetic-canary:ephemeral:v1",
    publicKey,
    value
  };
}

function assertNoSecretMaterial(value: unknown): void {
  const serialized = canonicalJson(value);
  for (const pattern of [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u,
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
    /\b(?:Bearer|Basic) [A-Za-z0-9+/=_-]{16,}\b/u
  ]) {
    if (pattern.test(serialized)) {
      fail("canonical canary evidence contains credential or private-key material");
    }
  }
}

function canonicalTestEvidence(
  first: ReadonlyMap<string, number>,
  second: ReadonlyMap<string, number>
): {
  readonly passedTestCount: number;
  readonly required: readonly {
    readonly id: string;
    readonly testName: string;
    readonly passed: true;
  }[];
  readonly compiledFiles: readonly {
    readonly path: string;
    readonly contentDigest: `sha256:${string}`;
  }[];
  readonly evidenceDigest: `sha256:${string}`;
} {
  exactValues([...first.keys()].sort(), [...second.keys()].sort(), "durable test runs");
  for (const [name, count] of first) {
    if (second.get(name) !== count) {
      fail(`durable test run count changed for ${name}`);
    }
  }
  const body = {
    passedTestCount: [...first.values()].reduce((sum, count) => sum + count, 0),
    required: REQUIRED_DURABLE_TESTS.map((entry) => ({
      ...entry,
      passed: true as const
    })),
    compiledFiles: DURABLE_TEST_FILES.map((file) => ({
      path: file,
      contentDigest: fileDigest(file)
    }))
  };
  return { ...body, evidenceDigest: digest(body) };
}

async function main(): Promise<void> {
  const forbidden = process.argv
    .slice(2)
    .find((argument) =>
      /(?:^|[-_:])(live|apply|execute|github|network|credential|paid)(?:$|[-_=])/iu.test(
        argument
      )
    );
  if (forbidden !== undefined) {
    fail(
      `live canary option ${forbidden} is forbidden before environment or credential reads`
    );
  }
  if (process.argv.length !== 2) {
    fail("the synthetic sandbox canary accepts no command-line options");
  }

  await import("./deny-network.js");

  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "", 10);
  if (!SUPPORTED_NODE_MAJORS.includes(nodeMajor as 24 | 26)) {
    fail(`synthetic sandbox canary does not support Node ${String(nodeMajor)}`);
  }
  const topology = assertDocument(
    "DeploymentTopologyPlan",
    parseStrictJson(readFileSync(DEPLOYMENT_TOPOLOGY, "utf8"))
  );
  const topologyIssues = validateDeploymentTopologyPlan(topology);
  if (topologyIssues.length > 0) {
    fail(`deployment topology is invalid: ${topologyIssues.join("; ")}`);
  }
  exactValues(
    topology.durableStores.map((store) => store.storeId).sort(),
    [...DURABLE_STORE_IDS].sort(),
    "deployment durable stores"
  );
  const hardeningPlan = parseStrictJson(
    readFileSync(HARDENING_PLAN, "utf8")
  );
  assertPinnedEvidenceInputs(hardeningPlan);

  const sandboxRoot = mkdtempSync(
    path.join(tmpdir(), "hyperfinite-synthetic-canary-")
  );
  chmodSync(sandboxRoot, 0o700);
  const home = path.join(sandboxRoot, "home");
  const temporary = path.join(sandboxRoot, "tmp");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(temporary, { mode: 0o700 });
  const childEnvironment = {
    CI: "true",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    HOME: home,
    LANG: "C",
    LC_ALL: "C",
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    TMPDIR: temporary
  } as const;
  exactValues(
    Object.keys(childEnvironment).sort(),
    [...CHILD_ENVIRONMENT_KEYS].sort(),
    "credentialless child environment"
  );

  try {
    const hardeningArgs = [
      `--import=./${NETWORK_GUARD}`,
      HARDENING_RUNNER
    ] as const;
    const firstHardening = runNode(hardeningArgs, childEnvironment).stdout;
    const secondHardening = runNode(hardeningArgs, childEnvironment).stdout;
    if (firstHardening !== secondHardening) {
      fail("hardening evidence is not byte-identical across two executions");
    }
    const hardening = parseHardeningEvidence(firstHardening);

    const durableArgs = [
      `--import=./${NETWORK_GUARD}`,
      "--test",
      "--test-reporter=junit",
      ...DURABLE_TEST_FILES
    ] as const;
    const firstDurable = passedJunitTests(
      runNode(durableArgs, childEnvironment).stdout
    );
    const secondDurable = passedJunitTests(
      runNode(durableArgs, childEnvironment).stdout
    );
    const durableEvidence = canonicalTestEvidence(firstDurable, secondDurable);
    const canaryPlan = {
      command: COMMAND,
      authorityOrder: AUTHORITY_ORDER,
      supportedNodeMajors: SUPPORTED_NODE_MAJORS,
      deploymentTopology: DEPLOYMENT_TOPOLOGY,
      hardeningPlan: HARDENING_PLAN,
      hardeningRunner: HARDENING_RUNNER,
      networkGuard: NETWORK_GUARD,
      simulator: SIMULATOR,
      evidenceInputDigests: EXPECTED_EVIDENCE_INPUT_DIGESTS,
      durableTestFiles: DURABLE_TEST_FILES,
      requiredHardeningBoundaries: REQUIRED_HARDENING_BOUNDARIES,
      requiredHardeningScenarios: REQUIRED_HARDENING_SCENARIOS,
      requiredDurableTests: REQUIRED_DURABLE_TESTS,
      restartBoundaries: RESTART_BOUNDARIES
    };
    const body = {
      apiVersion: "agentic-framework.github.com/v1alpha1",
      kind: "SyntheticSandboxCanaryEvidence",
      schemaVersion: "1.0.0",
      evidenceEpoch: GENERATED_AT,
      mode: "credentialless-local-synthetic",
      authorityOrder: AUTHORITY_ORDER,
      inputs: {
        canaryPlanDigest: digest(canaryPlan),
        deploymentTopologyDigest: digest(topology),
        hardeningPlanDigest: digest(hardeningPlan),
        hardeningEvidenceDigest: hardening.evidenceDigest,
        hardeningBytesDigest: digest(firstHardening),
        durableEvidenceDigest: durableEvidence.evidenceDigest,
        networkGuardDigest: fileDigest(NETWORK_GUARD)
      },
      execution: {
        command: COMMAND,
        supportedNodeMajors: SUPPORTED_NODE_MAJORS,
        childEnvironmentKeys: CHILD_ENVIRONMENT_KEYS,
        ambientEnvironmentRead: false,
        networkAccess: false,
        externalMcpAccess: false,
        credentialAccess: false,
        paidInference: false,
        privateKeyPersisted: false
      },
      journey: {
        demoCount: hardening.demos.length,
        handsOffStop: "human-review",
        automatedReviewEvent: "COMMENT",
        draftPullRequestsOnly: true,
        projectFieldsAreProjectionOnly: true,
        targetFreeEvidence: true
      },
      durability: {
        backend: "node:sqlite-nonproduction-reference",
        storeIds: DURABLE_STORE_IDS,
        adapterPortCount: 15,
        restartBoundaries: RESTART_BOUNDARIES,
        restartSource: "durable-stores-not-process-memory",
        independentProcessRaces: true,
        backupRestoreVerified: true,
        disabledStateRecoveryVerified: true,
        corruptionRefused: true,
        ambiguousAcknowledgementRequiresStableFreshRead: true,
        engineeringHoldPrecedesProviderAttempt: true,
        absentOrUnknownUsageNeverReleasesHold: true
      },
      faultEvidence: {
        assertionSource:
          "exact-name-and-compiled-content-digest-bound-reviewed-tests",
        hardening: REQUIRED_HARDENING_BOUNDARIES.map((id) => ({
          id,
          result: "passed" as const
        })),
        durable: durableEvidence
      },
      externalCallCounterScope: hardening.externalCallCounterScope,
      externalCallCounters: hardening.externalCallCounters,
      prohibitedEffects: {
        liveGitHubApiMutation: false,
        appInstallCreateOrTransfer: false,
        approval: false,
        markReady: false,
        merge: false,
        deployment: false,
        publication: false,
        billingEnablement: false,
        inferenceEnablement: false,
        liveAdministrationMutation: false
      },
      classification: {
        repository: "synthetic-canary-passed",
        sandboxLive: "blocked-pending-human-administration-and-live-canary",
        production: "customer-approval-required",
        nextGate: "independent-human-exact-head-review"
      },
      nonAuthoritative: {
        grantsNoCapability: true,
        selectsNoLiveTarget: true,
        satisfiesNoLiveDeploymentPrerequisite: true,
        authorizesNoAdministration: true,
        authorizesNoApprovalOrMerge: true
      }
    } as const;
    const firstReport = {
      ...body,
      evidenceDigest: digest(body),
      signature: signSyntheticCanaryBody(body)
    };
    const secondReport = {
      ...body,
      evidenceDigest: digest(body),
      signature: signSyntheticCanaryBody(body)
    };
    const firstBytes = canonicalJson(firstReport);
    const secondBytes = canonicalJson(secondReport);
    if (firstBytes !== secondBytes) {
      fail("canonical canary output is not byte-identical across two constructions");
    }
    assertNoSecretMaterial(firstReport);
    process.stdout.write(`${firstBytes}\n`);
  } finally {
    rmSync(sandboxRoot, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(invokedPath)).href
) {
  await main();
}
