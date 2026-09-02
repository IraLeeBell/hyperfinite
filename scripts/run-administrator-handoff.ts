#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  createHash,
  createPublicKey,
  verify as verifySignature
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

import {
  ADMINISTRATOR_HANDOFF_CONTROLS,
  compareAdministratorHandoffReadback,
  computeAdministratorHandoffSnapshotDigest,
  planAdministratorApply,
  planAdministratorHandoff,
  validateAdministratorApplyGate,
  validateAdministratorHandoffReport,
  validateAdministratorPostApplyReadback,
  type AdministratorApplyConfirmation,
  type AdministratorApplyPlan,
  type AdministratorExactTarget,
  type AdministratorHandoffReadback,
  type AdministratorHandoffReport,
  type AdministratorPostApplyReadback,
  type AdministratorPreApplyReadback,
  type AdministratorStateSet
} from "../src/administrator-handoff.js";
import { validateAdministratorPlan } from "../src/administrator-plan.js";
import { validateGitHubAppRegistrationPlan } from "../src/app-registration-plan.js";
import { canonicalJson, digest } from "../src/canonical.js";
import {
  CUSTOMER_STARTER_PROFILE_CATALOG,
  knownSelectionDocumentPathsFor
} from "../src/customer-starter-catalog.js";
import {
  buildCustomerStarterBundle,
  validateCustomerStarterSelection,
  verifyCustomerStarterBundle,
  type CustomerStarterBundleResult
} from "../src/customer-starter.js";
import { validateDeploymentTopologyPlan } from "../src/deployment-topology.js";
import { DURABLE_ADAPTER_STORE_MAPPING } from "../src/durable-store-composition.js";
import { validateOpenSourceAssessment } from "../src/release.js";
import { parseStrictJson } from "../src/strict-json.js";
import { assertDocument } from "../src/validation.js";

const COMMAND = "npm run handoff:administrator";
const HANDOFF_EVIDENCE_EPOCH = "2026-09-01T15:00:00Z";
const SYNTHETIC_READBACK_EVALUATED_AT = "2026-09-01T15:10:00Z";
const CANARY = "dist/scripts/run-synthetic-sandbox-canary.js";
const DEPLOYMENT_TOPOLOGY = "examples/pre-app/deployment-topology.json";
const APP_REGISTRATION = "examples/pre-app/github-app-registration-plan.json";
const ADMINISTRATOR_PLAN = "examples/pre-app/administrator-plan.json";
const OPEN_SOURCE_READINESS = "config/v1alpha1/open-source-readiness.json";
const CORE_SELECTION =
  "config/v1alpha1/customer-starter-selection.json";
const DEMO_SELECTION =
  "config/v1alpha1/customer-starter-demo-portfolio-selection.json";
const LICENSE = "LICENSE";
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

function fail(message: string): never {
  throw new TypeError(message);
}

function readJson(relativePath: string): unknown {
  return parseStrictJson(readFileSync(relativePath, "utf8"));
}

function fileDigest(relativePath: string): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(readFileSync(relativePath))
    .digest("hex")}`;
}

function syntheticUnconfiguredReadback(
  plan: ReturnType<typeof planAdministratorHandoff>
): AdministratorHandoffReadback {
  const body = {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "AdministratorHandoffReadback",
    schemaVersion: "1.0.0",
    observedAt: HANDOFF_EVIDENCE_EPOCH,
    planDigest: digest(plan),
    source: "synthetic-fixture",
    provenance: "synthetic-fixture",
    target: {
      sourceOwner: null,
      owner: digest({ fixture: "synthetic-unconfigured-owner" }),
      repository: digest({ fixture: "synthetic-unconfigured-repository" }),
      project: null,
      environment: null,
      ruleset: null,
      app: null,
      installation: null,
      billingAccount: null
    },
    controls: ADMINISTRATOR_HANDOFF_CONTROLS.map((control) => ({
      controlId: control.controlId,
      status: "blocked-human-action" as const,
      reasonCode:
        control.requiredBindings.length > 0
          ? ("missing-identity" as const)
          : ("human-decision-required" as const),
      observationDigest: null
    })),
    satisfiedEvidence: [],
    readiness: {
      repository: "not-validated",
      credentiallessSyntheticSandbox: "not-run",
      appBackedSandbox: "blocked",
      production: "customer-approval-required"
    },
    nonAuthoritative: {
      driftProneObservation: true,
      grantsNoAuthority: true,
      authorizesNoEffect: true,
      cannotSatisfyHumanGateByItself: true
    }
  } as const;
  return {
    ...body,
    snapshotDigest: computeAdministratorHandoffSnapshotDigest(body)
  };
}

function run(
  executable: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>>
): string {
  const result = spawnSync(executable, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: environment,
    maxBuffer: 64 * 1024 * 1024,
    stdio: "pipe",
    timeout: 20 * 60_000
  });
  if (result.status !== 0) {
    fail(
      `fixed handoff subprocess failed (${executable} ${args.join(" ")}): ${
        result.stderr || result.stdout
      }`
    );
  }
  return result.stdout.trim();
}

function assertCleanHead(
  environment: Readonly<Record<string, string>>,
  expectedHead?: string
): string {
  const worktreeStatus = run(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    environment
  );
  if (worktreeStatus.length > 0) {
    fail(
      "administrator handoff requires a clean tracked and untracked source worktree"
    );
  }
  const head = run("git", ["rev-parse", "HEAD"], environment);
  if (expectedHead !== undefined && head !== expectedHead) {
    fail("administrator handoff HEAD changed while evidence was evaluated");
  }
  return head;
}

function assertCanaryEvidence(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("synthetic canary evidence is not one object");
  }
  const evidence = value as Readonly<Record<string, unknown>>;
  const {
    evidenceDigest,
    signature,
    ...body
  } = evidence;
  if (
    evidence["kind"] !== "SyntheticSandboxCanaryEvidence" ||
    evidence["mode"] !== "credentialless-local-synthetic" ||
    evidenceDigest !== digest(body) ||
    signature === null ||
    typeof signature !== "object" ||
    Array.isArray(signature)
  ) {
    fail("synthetic canary evidence is malformed or detached");
  }
  const signatureRecord = signature as Readonly<Record<string, unknown>>;
  if (
    signatureRecord["algorithm"] !== "ed25519" ||
    typeof signatureRecord["publicKey"] !== "string" ||
    typeof signatureRecord["value"] !== "string" ||
    !verifySignature(
      null,
      Buffer.from(canonicalJson(body), "utf8"),
      createPublicKey({
        key: Buffer.from(signatureRecord["publicKey"], "base64"),
        format: "der",
        type: "spki"
      }),
      Buffer.from(signatureRecord["value"], "base64")
    )
  ) {
    fail("synthetic canary signature is invalid");
  }
  return evidence;
}

function syntheticApplyTarget(): AdministratorExactTarget {
  return {
    sourceOwner: null,
    owner: {
      id: 1,
      nodeId: "O_synthetic-handoff-owner",
      login: "synthetic-handoff-owner"
    },
    repository: {
      id: 2,
      nodeId: "R_synthetic-handoff-repository",
      owner: "synthetic-handoff-owner",
      name: "synthetic-handoff-repository",
      fullName:
        "synthetic-handoff-owner/synthetic-handoff-repository"
    },
    project: null,
    environment: null,
    ruleset: null,
    app: null,
    installation: null,
    billingAccountId: null
  };
}

function createSyntheticPreApplyReadback(input: {
  readonly plan: AdministratorApplyPlan;
  readonly confirmation: AdministratorApplyConfirmation;
  readonly actual: AdministratorStateSet;
}): AdministratorPreApplyReadback {
  return {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "AdministratorApplyReadback",
    schemaVersion: "1.0.0",
    phase: "pre-apply",
    observedAt: "2026-09-01T15:03:00Z",
    planDigest: digest(input.plan),
    confirmationDigest: digest(input.confirmation),
    attemptId: input.plan.attemptId,
    target: input.plan.target,
    actual: input.actual,
    mutationAttemptCount: 0,
    acknowledgement: "not-attempted",
    preApplyReadbackDigest: null,
    attemptedAt: null,
    attemptReceiptDigest: null,
    completeReadback: true,
    nonAuthoritative: {
      evidenceOnly: true,
      cannotRetryOrApply: true
    }
  };
}

function createSyntheticPostApplyReadback(input: {
  readonly plan: AdministratorApplyPlan;
  readonly confirmation: AdministratorApplyConfirmation;
  readonly preApplyReadback: AdministratorPreApplyReadback;
  readonly actual: AdministratorStateSet;
}): AdministratorPostApplyReadback {
  return {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "AdministratorApplyReadback",
    schemaVersion: "1.0.0",
    phase: "post-apply",
    observedAt: "2026-09-01T15:05:00Z",
    planDigest: digest(input.plan),
    confirmationDigest: digest(input.confirmation),
    attemptId: input.plan.attemptId,
    target: input.plan.target,
    actual: input.actual,
    mutationAttemptCount: 1,
    acknowledgement: "unambiguous-applied",
    preApplyReadbackDigest: digest(input.preApplyReadback),
    attemptedAt: "2026-09-01T15:04:00Z",
    attemptReceiptDigest: digest({
      attemptId: input.plan.attemptId,
      idempotencyKey: input.plan.idempotencyKey,
      fixtureOnly: true
    }),
    completeReadback: true,
    nonAuthoritative: {
      evidenceOnly: true,
      cannotRetryOrApply: true
    }
  };
}

function starterEvidence(
  result: CustomerStarterBundleResult
): Omit<CustomerStarterBundleResult, "outputRoot"> {
  const { outputRoot: _outputRoot, ...evidence } = result;
  return evidence;
}

async function main(): Promise<void> {
  if (process.argv.length !== 2) {
    fail(`${COMMAND} is optionless and accepts no caller-selected path or target`);
  }

  const sandboxRoot = mkdtempSync(
    path.join(tmpdir(), "hyperfinite-administrator-handoff-")
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
  if (
    Object.keys(childEnvironment).sort().join(",") !==
    [...CHILD_ENVIRONMENT_KEYS].sort().join(",")
  ) {
    fail("handoff child environment widened beyond the fixed credentialless set");
  }

  try {
    const head = assertCleanHead(childEnvironment);
    const base = run(
      "git",
      ["merge-base", "HEAD", "origin/main"],
      childEnvironment
    );
    const firstCanary = run(process.execPath, [CANARY], childEnvironment);
    const secondCanary = run(process.execPath, [CANARY], childEnvironment);
    if (firstCanary !== secondCanary) {
      fail("synthetic canary output changed across repeated handoff runs");
    }
    const canaryEvidence = assertCanaryEvidence(parseStrictJson(firstCanary));

    const topology = assertDocument(
      "DeploymentTopologyPlan",
      readJson(DEPLOYMENT_TOPOLOGY)
    );
    const appRegistration = assertDocument(
      "GitHubAppRegistrationPlan",
      readJson(APP_REGISTRATION)
    );
    const administratorPlan = assertDocument(
      "AdministratorPlan",
      readJson(ADMINISTRATOR_PLAN)
    );
    if (
      validateDeploymentTopologyPlan(topology).length > 0 ||
      validateGitHubAppRegistrationPlan(appRegistration).length > 0 ||
      validateAdministratorPlan(administratorPlan).length > 0
    ) {
      fail("a source contract failed semantic validation");
    }
    if (
      DURABLE_ADAPTER_STORE_MAPPING.length !== 15 ||
      new Set(DURABLE_ADAPTER_STORE_MAPPING.map((entry) => entry.port)).size !==
        15
    ) {
      fail("the handoff did not observe exactly fifteen durable adapter ports");
    }

    const knownSelectionPaths = knownSelectionDocumentPathsFor(
      CUSTOMER_STARTER_PROFILE_CATALOG
    );
    const coreSelection = validateCustomerStarterSelection(
      readJson(CORE_SELECTION),
      head,
      process.cwd(),
      knownSelectionPaths
    );
    const demoSelection = validateCustomerStarterSelection(
      readJson(DEMO_SELECTION),
      head,
      process.cwd(),
      knownSelectionPaths
    );
    const openSourceReadiness = readJson(OPEN_SOURCE_READINESS);
    validateOpenSourceAssessment(openSourceReadiness, "0.1.0");
    const coreBundle = buildCustomerStarterBundle({
      repositoryRoot: process.cwd(),
      outputRoot: path.join(sandboxRoot, "control-plane-core"),
      baseSha: base,
      headSha: head,
      packageVersion: "0.1.0",
      profileId: "control-plane-core"
    });
    const coreVerification = verifyCustomerStarterBundle({
      repositoryRoot: process.cwd(),
      bundleRoot: coreBundle.outputRoot,
      baseSha: base,
      headSha: head,
      packageVersion: "0.1.0",
      profileId: "control-plane-core"
    });
    const demoBundle = buildCustomerStarterBundle({
      repositoryRoot: process.cwd(),
      outputRoot: path.join(sandboxRoot, "demo-portfolio"),
      baseSha: base,
      headSha: head,
      packageVersion: "0.1.0",
      profileId: "demo-portfolio"
    });
    const demoVerification = verifyCustomerStarterBundle({
      repositoryRoot: process.cwd(),
      bundleRoot: demoBundle.outputRoot,
      baseSha: base,
      headSha: head,
      packageVersion: "0.1.0",
      profileId: "demo-portfolio"
    });
    if (
      digest(starterEvidence(coreBundle)) !==
        digest(starterEvidence(coreVerification)) ||
      digest(starterEvidence(demoBundle)) !==
        digest(starterEvidence(demoVerification))
    ) {
      fail("customer-starter build and verification evidence diverged");
    }

    const plan = planAdministratorHandoff({
      evidenceEpoch: HANDOFF_EVIDENCE_EPOCH,
      sourceDigests: {
        deploymentTopologyPlan: digest(topology),
        githubAppRegistrationPlan: digest(appRegistration),
        administratorConfigurationPlan: digest(administratorPlan),
        durableAdapterMapping: digest(DURABLE_ADAPTER_STORE_MAPPING),
        syntheticCanaryEvidence: digest(canaryEvidence),
        customerStarterCoreSelection: digest(coreSelection),
        customerStarterDemoSelection: digest(demoSelection),
        openSourceReadiness: digest(openSourceReadiness),
        licenseBytes: fileDigest(LICENSE)
      }
    });
    const planDigest = digest(plan);

    const readback = syntheticUnconfiguredReadback(plan);
    const comparison = compareAdministratorHandoffReadback(plan, readback, {
      now: SYNTHETIC_READBACK_EVALUATED_AT,
      maxAgeMs: 60 * 60 * 1000
    });
    if (!comparison.valid) {
      fail(
        `synthetic handoff readback is malformed or detached: ${comparison.issues
          .map((issue) => `${issue.path}: ${issue.message}`)
          .join("; ")}`
      );
    }

    const target = syntheticApplyTarget();
    const expectedCurrent: AdministratorStateSet = {
      count: 1,
      values: [{ key: "app.registration", value: false }]
    };
    const desired: AdministratorStateSet = {
      count: 1,
      values: [{ key: "app.registration", value: true }]
    };
    const applyPlan = planAdministratorApply(plan, {
      generatedAt: "2026-09-01T15:00:00Z",
      expiresAt: "2026-09-01T15:20:00Z",
      operationId: "app-registration",
      handoffPlanDigest: planDigest,
      target,
      expectedCurrent,
      desired
    });
    const applyPlanDigest = digest(applyPlan);
    const confirmation: AdministratorApplyConfirmation = {
      apiVersion: "agentic-framework.github.com/v1alpha1",
      kind: "AdministratorApplyConfirmation",
      schemaVersion: "1.0.0",
      planDigest: applyPlanDigest,
      confirmationId: "synthetic-explicit-confirmation",
      confirmedBy: "synthetic-human-administrator",
      confirmedAt: "2026-09-01T15:02:00Z",
      expiresAt: "2026-09-01T15:15:00Z",
      separateExplicitHumanConfirmation: true,
      confirmationEvidenceDigest: digest({
        fixture: "synthetic-explicit-confirmation",
        planDigest: applyPlanDigest
      }),
      nonAuthoritative: {
        requiresTrustedAdapterVerification: true,
        performsNoEffect: true
      }
    };
    const preApplyReadback = createSyntheticPreApplyReadback({
      plan: applyPlan,
      confirmation,
      actual: expectedCurrent
    });
    const postApplyReadback = createSyntheticPostApplyReadback({
      plan: applyPlan,
      confirmation,
      preApplyReadback,
      actual: desired
    });
    const syntheticFreshness = {
      now: "2026-09-01T15:10:00Z",
      maxAgeMs: 15 * 60 * 1000
    };
    const gate = validateAdministratorApplyGate({
      plan: applyPlan,
      confirmation,
      preApplyReadback,
      freshness: syntheticFreshness
    });
    const postApply = validateAdministratorPostApplyReadback({
      plan: applyPlan,
      confirmation,
      preApplyReadback,
      readback: postApplyReadback,
      freshness: syntheticFreshness
    });
    if (
      !gate.readyForTrustedAdapterVerification ||
      !postApply.desiredStateObserved
    ) {
      fail("synthetic apply contract did not pass its exact gate/readback proof");
    }

    const body = {
      apiVersion: "agentic-framework.github.com/v1alpha1",
      kind: "AdministratorHandoffReport",
      schemaVersion: "1.0.0",
      evidenceEpoch: HANDOFF_EVIDENCE_EPOCH,
      repositoryEvidence: {
        baseSha: base,
        headSha: head,
        worktreeClean: true
      },
      plan,
      readback,
      planDigest,
      readbackDigest: digest(readback),
      gaps: comparison.gaps,
      gapCount: comparison.gaps.length,
      customerStarter: {
        controlPlaneCore: starterEvidence(coreBundle),
        demoPortfolio: starterEvidence(demoBundle),
        decision: "no-go",
        liveSnapshotExported: false
      },
      syntheticApplyContract: {
        plan: applyPlan,
        confirmation,
        preApplyReadback,
        postApplyReadback,
        planDigest: applyPlanDigest,
        confirmationDigest: digest(confirmation),
        preApplyReadbackDigest: digest(preApplyReadback),
        postApplyReadbackDigest: digest(postApplyReadback),
        gateValidated: true,
        postApplyReadbackValidated: true,
        performedLiveEffect: false
      },
      classification: {
        repository: "exact-head-validation-required",
        credentiallessSyntheticSandbox: "passed",
        appBackedSandbox: "blocked",
        administratorSnapshot: "synthetic-unconfigured",
        production: "customer-approval-required"
      }
    } as const;
    const report: AdministratorHandoffReport = {
      ...body,
      evidenceDigest: digest(body)
    };
    const reportIssues = validateAdministratorHandoffReport(report, {
      now: SYNTHETIC_READBACK_EVALUATED_AT,
      maxAgeMs: 60 * 60 * 1000
    });
    if (reportIssues.length > 0) {
      fail(
        `administrator handoff report failed semantic validation: ${reportIssues
          .map((issue) => `${issue.path}: ${issue.message}`)
          .join("; ")}`
      );
    }
    assertDocument("AdministratorHandoffDocument", report);
    assertCleanHead(childEnvironment, head);
    process.stdout.write(`${canonicalJson(report)}\n`);
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
