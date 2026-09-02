import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  DEMO_PORTFOLIO_EVIDENCE_CLASSES,
  ENGINEERING_VERIFICATION_COMMANDS,
  assertDocument,
  demoReviewExpectedCheckIds,
  demoReviewExpectedCommandIds,
  digest,
  issueDemoReviewEvidenceBundle,
  issueTrustedDemoTargetIdentityEvidence,
  issueTrustedDemoRuntimeBinding,
  validateDemoReviewEvidenceBundle,
  type DemoEvidenceSigner,
  type DemoEvidenceVerifier,
  type DemoProjectId,
  type DemoReviewEvidenceObservation,
  type DemoReviewEvidenceBundle,
  type DemoSignature,
  type Digest,
  type TrustedDemoRuntimeBinding,
  type TrustedGitHubBinding
} from "../src/index.js";
import {
  loadDemoProjectContractSets,
  loadDemoRegistrationMetadata,
  loadTrustedDemoRuntimeBindingForSelection,
  readStrictJsonFile
} from "../scripts/demo-runtime-metadata.js";

const NOW = "2026-08-29T12:10:00.000Z";
const EXPIRES = "2026-08-29T13:10:00.000Z";
const DEMOS = [
  "app-modernization",
  "feature-delivery",
  "security-dependency-remediation",
  "adaptive-delivery"
] as const satisfies readonly DemoProjectId[];

function signature(payload: unknown, keyId = "test:key-1"): DemoSignature {
  return {
    algorithm: "ed25519",
    keyId,
    value: Buffer.from(digest(payload), "utf8").toString("base64")
  };
}

const signer: DemoEvidenceSigner = {
  sign: async (payload) => signature(payload)
};
const verifier: DemoEvidenceVerifier = {
  verify: (payload, candidate) =>
    candidate.algorithm === "ed25519" &&
    candidate.value === signature(payload, candidate.keyId).value
};

async function portfolio() {
  const lifecycle = assertDocument(
    "LifecycleGraph",
    await readStrictJsonFile("config/v1alpha1/lifecycle.json")
  );
  const registry = assertDocument(
    "CapabilityRegistry",
    await readStrictJsonFile("config/v1alpha1/capability-registry.json")
  );
  const metadata = await loadDemoRegistrationMetadata({
    baseRegistry: registry
  });
  const contracts = await loadDemoProjectContractSets({
    baseRegistry: registry,
    lifecycle
  });
  return { lifecycle, registry, metadata, contracts };
}

test("trusted loader selects every exact catalog/profile/stage tuple without fallback", async () => {
  const { lifecycle, registry, contracts } = await portfolio();
  let selected = 0;
  for (const contract of contracts) {
    for (const stage of contract.bindings.spec.stageBindings) {
      for (const binding of stage.runtimeBindings) {
        const trusted = await loadTrustedDemoRuntimeBindingForSelection({
          baseRegistry: registry,
          lifecycle,
          demoProjectId: contract.profile.spec.demoProjectId,
          stageId: stage.stageId,
          phase: binding.phase,
          role: binding.role,
          capability: binding.capability,
          workflowId: binding.workflow
        });
        assert.equal(
          trusted.binding.demoProjectId,
          contract.profile.spec.demoProjectId
        );
        assert.equal(trusted.binding.stageId, stage.stageId);
        assert.equal(trusted.binding.agent, binding.agent);
        selected += 1;
      }
    }
  }
  assert.equal(selected, 23);
  const first = contracts[0];
  const second = contracts[1];
  assert.ok(first);
  assert.ok(second);
  const firstBinding = first.bindings.spec.stageBindings.find(
    (stage) => stage.runtimeBindings.length === 1
  )?.runtimeBindings[0];
  assert.ok(firstBinding);
  await assert.rejects(
    loadTrustedDemoRuntimeBindingForSelection({
      baseRegistry: registry,
      lifecycle,
      demoProjectId: second.profile.spec.demoProjectId,
      stageId: first.bindings.spec.stageBindings.find(
        (stage) => stage.runtimeBindings.length === 1
      )!.stageId,
      phase: firstBinding.phase,
      role: firstBinding.role,
      capability: firstBinding.capability,
      workflowId: firstBinding.workflow
    }),
    /does not identify one model binding/u
  );
});

test("pack review bundles authenticate complete fixed evidence and exact current head", async () => {
  const { lifecycle, registry, metadata, contracts } = await portfolio();
  const bundles: DemoReviewEvidenceBundle[] = [];
  const handles: TrustedDemoRuntimeBinding[] = [];
  const githubBindings: TrustedGitHubBinding[] = [];
  const observations: DemoReviewEvidenceObservation[] = [];
  for (const [index, contract] of contracts.entries()) {
    const review = contract.bindings.spec.stageBindings.find(
      (stage) =>
        stage.runtimeBindings[0]?.workflowClass ===
        "current-head-comment-review"
    );
    assert.ok(review);
    const commandIds = demoReviewExpectedCommandIds(
      contract.profile.spec.demoProjectId
    );
    const checkIds = demoReviewExpectedCheckIds(
      contract.profile.spec.demoProjectId
    );
    const headSha = `${index + 1}`.repeat(40);
    const repository = {
      id: index + 1,
      nodeId: `R_integration_${index + 1}`,
      owner: "example",
      name: contract.profile.spec.demoProjectId,
      fullName: `example/${contract.profile.spec.demoProjectId}`
    };
    const pullRequest = {
      kind: "pull-request" as const,
      number: index + 1,
      nodeId: `PR_integration_${index + 1}`,
      base: {
        repository,
        ref: "refs/heads/main",
        sha: "0".repeat(40)
      },
      head: {
        repository,
        ref: `refs/heads/integration-${index + 1}`,
        sha: headSha
      }
    };
    const trustedGitHubBinding: TrustedGitHubBinding = {
      repository,
      workItem: pullRequest,
      project: {
        ownerNodeId: "O_integration",
        projectNodeId: `PVT_synthetic_integration_${index + 1}`,
        itemNodeId: `PVTI_synthetic_integration_${index + 1}`,
        schemaDigest: digest("integration-project-schema"),
        bindingDigest: contract.profile.spec.projectBindingDigest,
        fields: []
      },
      installation: {
        id: 1,
        accountNodeId: "O_integration",
        repositorySelection: "selected",
        repositoryIds: [repository.id]
      }
    };
    const targetIdentity = {
      repositoryId: repository.id,
      repositoryNodeId: repository.nodeId,
      repositoryFullName: repository.fullName,
      workItemNumber: pullRequest.number,
      workItemNodeId: pullRequest.nodeId,
      projectOwnerNodeId: trustedGitHubBinding.project.ownerNodeId,
      projectNodeId: trustedGitHubBinding.project.projectNodeId,
      projectItemNodeId: trustedGitHubBinding.project.itemNodeId
    };
    const targetIdentityPayload = {
      projectProfileDigest: contract.profile.contentDigest,
      repositoryBindingDigest: contract.profile.spec.repositoryBindingDigest,
      projectBindingDigest: contract.profile.spec.projectBindingDigest,
      targetIdentity,
      observedAt: NOW,
      expiresAt: EXPIRES
    };
    const targetIdentityEvidence = issueTrustedDemoTargetIdentityEvidence({
      ...targetIdentityPayload,
      signature: signature(targetIdentityPayload),
      verifier,
      clock: { now: () => NOW }
    });
    if (index === 0) {
      assert.throws(
        () =>
          issueTrustedDemoTargetIdentityEvidence({
            ...targetIdentityPayload,
            targetIdentity: {
              ...targetIdentity,
              repositoryId: 999
            },
            signature: signature(targetIdentityPayload),
            verifier,
            clock: { now: () => NOW }
          }),
        /invalid or stale/u
      );
      assert.throws(
        () =>
          issueTrustedDemoRuntimeBinding({
            catalog: metadata.catalog,
            reservations: metadata.reservations,
            lifecycle,
            baseRegistry: registry,
            contracts: contract,
            stageId: review.stageId,
            targetIdentityEvidence,
            targetIdentityClock: { now: () => EXPIRES }
          }),
        /stale or does not bind/u
      );
    }
    const handle = issueTrustedDemoRuntimeBinding({
      catalog: metadata.catalog,
      reservations: metadata.reservations,
      lifecycle,
      baseRegistry: registry,
      contracts: contract,
      stageId: review.stageId,
      targetIdentityEvidence,
      targetIdentityClock: { now: () => NOW }
    });
    handles.push(handle);
    const diffFiles = [
      {
        pathDigest: digest(`${contract.profile.spec.demoProjectId}:path`),
        status: "modified" as const,
        additions: 1,
        deletions: 0,
        blobSha: `${index + 4}`.repeat(40),
        patchDigest: digest(`${contract.profile.spec.demoProjectId}:patch`)
      }
    ];
    const commands = commandIds.map((id) => ({
      id,
      status: "success" as const,
      stdoutDigest: digest(`${id}:stdout`),
      stderrDigest: digest(`${id}:stderr`)
    }));
    const checks = checkIds.map((id) => ({
      id,
      status:
        id === "unrelated-scanner-finding-open-unchanged"
        ? ("information" as const)
        : ("success" as const),
      evidenceDigest: digest(`${id}:evidence`)
    }));
    const observation: DemoReviewEvidenceObservation = {
      repositoryBindingDigest: contract.profile.spec.repositoryBindingDigest,
      trustedGitHubBinding,
      pullRequestState: { draft: true, state: "open" },
      diffFiles,
      diffPageCount: 1,
      diffCollectionComplete: true,
      commands,
      checks,
      observedAt: NOW
    };
    const bundle = await issueDemoReviewEvidenceBundle({
      trustedDemoBinding: handle,
      signer,
      reader: {
        read: async () => observation
      },
      createdAt: NOW,
      expiresAt: EXPIRES
    });
    assert.equal(
      validateDemoReviewEvidenceBundle({
        value: bundle,
        trustedDemoBinding: handle,
        trustedObservation: observation,
        verifier,
        expectedHeadSha: headSha,
        now: NOW
      }).bundleDigest,
      bundle.bundleDigest
    );
    bundles.push(bundle);
    githubBindings.push(trustedGitHubBinding);
    observations.push(observation);
  }
  for (let source = 0; source < bundles.length; source += 1) {
    for (let target = 0; target < handles.length; target += 1) {
      if (source === target) continue;
      await assert.rejects(
        async () =>
          validateDemoReviewEvidenceBundle({
            value: bundles[source]!,
            trustedDemoBinding: handles[target]!,
            trustedObservation: observations[source]!,
            verifier,
            expectedHeadSha: bundles[source]!.pullRequest.headSha,
            now: NOW
          }),
        /bundle identity/u
      );
    }
  }
  const firstBundle = bundles[0];
  const firstHandle = handles[0];
  const firstGitHubBinding = githubBindings[0];
  assert.ok(firstBundle);
  assert.ok(firstHandle);
  assert.ok(firstGitHubBinding);
  const firstContract = contracts[0];
  const firstReviewStage = firstContract?.bindings.spec.stageBindings.find(
    (stage) =>
      stage.runtimeBindings[0]?.workflowClass ===
      "current-head-comment-review"
  );
  assert.ok(firstContract);
  assert.ok(firstReviewStage);
  const unboundTargetHandle = issueTrustedDemoRuntimeBinding({
    catalog: metadata.catalog,
    reservations: metadata.reservations,
    lifecycle,
    baseRegistry: registry,
    contracts: firstContract,
    stageId: firstReviewStage.stageId
  });
  await assert.rejects(
    issueDemoReviewEvidenceBundle({
      trustedDemoBinding: unboundTargetHandle,
      signer,
      reader: { read: async () => observations[0]! },
      createdAt: NOW,
      expiresAt: EXPIRES
    }),
    /identity/u
  );
  await assert.rejects(
    issueDemoReviewEvidenceBundle({
      trustedDemoBinding: firstHandle,
      signer,
      reader: { read: async () => observations[0]! },
      createdAt: NOW,
      expiresAt: "2026-08-29T14:10:00.000Z"
    }),
    /identity/u
  );
  let reads = 0;
  await assert.rejects(
    issueDemoReviewEvidenceBundle({
      trustedDemoBinding: firstHandle,
      signer,
      reader: {
        read: async () => {
          reads += 1;
          return {
            repositoryBindingDigest: firstBundle.repositoryBindingDigest,
            trustedGitHubBinding:
              reads === 1
                ? firstGitHubBinding
                : {
                    ...firstGitHubBinding,
                    workItem:
                      firstGitHubBinding.workItem.kind === "pull-request"
                        ? {
                            ...firstGitHubBinding.workItem,
                            head: {
                              ...firstGitHubBinding.workItem.head,
                              sha: "f".repeat(40)
                            }
                          }
                        : firstGitHubBinding.workItem
                  },
            pullRequestState: { draft: true as const, state: "open" as const },
            diffFiles: firstBundle.diffFiles,
            diffPageCount: firstBundle.diffPageCount,
            diffCollectionComplete: true,
            commands: firstBundle.commands,
            checks: firstBundle.checks,
            observedAt: NOW
          };
        }
      },
      createdAt: NOW,
      expiresAt: EXPIRES
    }),
    /stable fresh observation/u
  );
  const wrongGitHubBinding: TrustedGitHubBinding = {
    ...firstGitHubBinding,
    workItem:
      firstGitHubBinding.workItem.kind === "pull-request"
        ? { ...firstGitHubBinding.workItem, number: 999 }
        : firstGitHubBinding.workItem
  };
  assert.throws(
    () =>
      validateDemoReviewEvidenceBundle({
        value: firstBundle,
        trustedDemoBinding: firstHandle,
        trustedObservation: {
          ...observations[0]!,
          trustedGitHubBinding: wrongGitHubBinding
        },
        verifier,
        expectedHeadSha: firstBundle.pullRequest.headSha,
        now: NOW
      }),
    /bundle identity/u
  );
});

test("bounded worktree registry exactly covers every pack command catalog", async () => {
  const app = (await readStrictJsonFile(
    "config/v1alpha1/demo-projects/app-modernization/verification-commands.json"
  )) as { readonly commands: readonly { readonly id: string }[] };
  const feature = (await readStrictJsonFile(
    "config/v1alpha1/demo-projects/feature-delivery/verification-commands.json"
  )) as {
    readonly spec: { readonly commands: readonly { readonly id: string }[] };
  };
  const security = (await readStrictJsonFile(
    "config/v1alpha1/demo-projects/security-dependency-remediation/trusted-binding.json"
  )) as {
    readonly spec: { readonly fixedChecks: readonly string[] };
  };
  const adaptive = (await readStrictJsonFile(
    "config/v1alpha1/demo-projects/adaptive-delivery/verification-commands.json"
  )) as {
    readonly spec: { readonly commands: readonly { readonly id: string }[] };
  };
  for (const id of [
    ...app.commands.map((command) => command.id),
    ...feature.spec.commands.map((command) => command.id),
    ...security.spec.fixedChecks,
    ...adaptive.spec.commands.map((command) => command.id)
  ]) {
    assert.ok(
      ENGINEERING_VERIFICATION_COMMANDS[
        id as keyof typeof ENGINEERING_VERIFICATION_COMMANDS
      ]
    );
  }
});

test("portfolio simulator is byte deterministic, hermetic, and rejects live mode", () => {
  const command = ["dist/scripts/simulate-demos.js"];
  const first = spawnSync(process.execPath, command, { encoding: "utf8" });
  const second = spawnSync(process.execPath, command, { encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stdout, second.stdout);
  const result = JSON.parse(first.stdout) as {
    readonly demos: readonly {
      readonly demoProjectId: DemoProjectId;
      readonly workAccordDigest: Digest;
      readonly reviewReadCount: number;
      readonly journey: readonly unknown[];
      readonly handsOffStop: string;
      readonly modelInvocations: number;
      readonly syntheticHumanContinuation: {
        readonly state: string;
        readonly kernelReceiptDigest: Digest;
        readonly stageReceiptDigest: Digest;
        readonly completedRunStateDigest: Digest;
      };
      readonly runtimeProbe: {
        readonly kernelRoute: string;
        readonly schedulerAction: string;
        readonly projectionWrites: readonly string[];
        readonly fullJourneyDispatcherAction: string;
        readonly fullJourneySchedulerAction: string;
        readonly fullJourneyProjectionWrites: readonly string[];
        readonly completedStageReceiptDigests: readonly Digest[];
        readonly fullJourneyAppliedKernelResultDigests: readonly Digest[];
        readonly operationOrder: readonly string[];
        readonly fullJourneyProjectionOrder: readonly string[];
      };
    }[];
    readonly substitutions: readonly {
      readonly evidenceClass: string;
      readonly result: string;
      readonly beforeInference: boolean;
      readonly beforeEffects: boolean;
    }[];
    readonly externalCallCounters: Readonly<Record<string, number>>;
    readonly invariants: Readonly<Record<string, boolean | string>>;
  };
  assert.deepEqual(
    result.demos.map((demo) => demo.demoProjectId),
    DEMOS
  );
  assert.deepEqual(
    result.demos.map((demo) => demo.journey.length),
    [10, 9, 9, 9]
  );
  assert.equal(
    new Set(result.demos.map((demo) => demo.workAccordDigest)).size,
    4
  );
  assert.ok(
    result.demos.every(
      (demo) =>
        demo.handsOffStop === "human-review" &&
        demo.syntheticHumanContinuation.state === "COMPLETED" &&
        /^sha256:[0-9a-f]{64}$/u.test(
          demo.syntheticHumanContinuation.kernelReceiptDigest
        ) &&
        /^sha256:[0-9a-f]{64}$/u.test(
          demo.syntheticHumanContinuation.stageReceiptDigest
        ) &&
        /^sha256:[0-9a-f]{64}$/u.test(
          demo.syntheticHumanContinuation.completedRunStateDigest
        ) &&
        demo.modelInvocations === 5 &&
        demo.runtimeProbe.kernelRoute === "capture.request-activation" &&
        demo.runtimeProbe.schedulerAction === "run-deterministic" &&
        demo.runtimeProbe.projectionWrites.at(-1) === "stage" &&
        demo.runtimeProbe.fullJourneyDispatcherAction === "wait-human" &&
        demo.runtimeProbe.fullJourneySchedulerAction === "wait" &&
        demo.runtimeProbe.fullJourneyProjectionWrites.at(-1) === "stage" &&
        demo.runtimeProbe.fullJourneyAppliedKernelResultDigests.length === 6 &&
        demo.reviewReadCount === 2 &&
        demo.runtimeProbe.operationOrder[0] === "kernel" &&
        demo.runtimeProbe.fullJourneyProjectionOrder.at(-1) === "next-event"
    )
  );
  assert.equal(result.substitutions.length, 96);
  for (const evidenceClass of DEMO_PORTFOLIO_EVIDENCE_CLASSES) {
    const cases = result.substitutions.filter(
      (substitution) => substitution.evidenceClass === evidenceClass
    );
    assert.equal(cases.length, 12);
    assert.ok(
      cases.every(
        (substitution) =>
          substitution.result === "refused" &&
          substitution.beforeInference &&
          substitution.beforeEffects
      )
    );
  }
  assert.ok(
    Object.values(result.externalCallCounters).every((count) => count === 0)
  );
  assert.equal(result.invariants.projectNeverLeadsKernel, true);
  assert.equal(result.invariants.kernelReceiptBeforeProjectProjection, true);
  assert.equal(result.invariants.fullReadAfterWriteBeforeNextEvent, true);
  assert.equal(result.invariants.currentHeadRequired, true);
  const refused = spawnSync(
    process.execPath,
    ["dist/scripts/simulate-demos.js", "--live"],
    {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" }
    }
  );
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /forbidden before environment or credential reads/u);
});
