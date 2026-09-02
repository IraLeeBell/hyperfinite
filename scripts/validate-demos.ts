#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import {
  ENGINEERING_VERIFICATION_COMMANDS,
  assertDocument,
  assertTrustedDemoRuntimeBinding,
  issueTrustedDemoRuntimeBinding,
  kernelSupportsContractRequirement,
  validateClosedSchemaDialect,
  validateDemoContract
} from "../src/index.js";
import {
  loadDemoProjectContractSets,
  loadDemoRegistrationMetadata,
  readStrictJsonFile
} from "./demo-runtime-metadata.js";

const DEMOS = [
  "app-modernization",
  "feature-delivery",
  "security-dependency-remediation",
  "adaptive-delivery"
] as const;

const REQUIRED_PACK_FILES: Readonly<Record<(typeof DEMOS)[number], readonly string[]>> = {
  "app-modernization": [
    "logical-slots.json",
    "repository-binding.json",
    "verification-commands.json",
    "work-accord-template.json",
    "artifacts/templates/bounded-intake.json",
    "artifacts/templates/human-review-package.json",
    "artifacts/templates/implementation-evidence.json",
    "artifacts/templates/migration-plan.json",
    "artifacts/templates/modernization-assessment.json",
    "artifacts/templates/repository-inventory.json",
    "artifacts/templates/risk-compatibility.json",
    "artifacts/templates/target-architecture.json",
    "artifacts/templates/verification.json"
  ],
  "feature-delivery": [
    "logical-targets.json",
    "project-binding.json",
    "trusted-binding.json",
    "verification-commands.json",
    "templates/codebase-impact-analysis.json",
    "templates/draft-pr-evidence.json",
    "templates/feature-brief.json",
    "templates/human-review-package.json",
    "templates/implementation-plan.json",
    "templates/solution-design.json",
    "templates/target-free-patch.json",
    "templates/verification-report.json",
    "templates/work-accord-template.json"
  ],
  "security-dependency-remediation": [
    "artifact-catalog.json",
    "trusted-binding.json",
    "artifact-templates/affected-component-inventory.json",
    "artifact-templates/bounded-report.json",
    "artifact-templates/draft-patch-pr-evidence.json",
    "artifact-templates/human-review-package.json",
    "artifact-templates/impact-assessment.json",
    "artifact-templates/remediation-plan.json",
    "artifact-templates/reproduction-evidence.json",
    "artifact-templates/security-verification.json"
  ],
  "adaptive-delivery": [
    "logical-targets.json",
    "project-binding.json",
    "trusted-binding.json",
    "verification-commands.json",
    "work-accord-template.json",
    "policy.json",
    "artifacts/templates/context-inventory.json",
    "artifacts/templates/discovery-studio.json",
    "artifacts/templates/guided-synthesis.json",
    "artifacts/templates/implementation-plan.json",
    "artifacts/templates/target-free-patch.json",
    "artifacts/templates/verification-report.json",
    "artifacts/templates/human-review-package.json"
  ]
};
const RECOVERY_FIXTURES: Readonly<
  Record<
    (typeof DEMOS)[number],
    { readonly recovery: string; readonly adversarial: string }
  >
> = {
  "app-modernization": {
    recovery: "tests/fixtures/demos/app-modernization/recovery-scenarios.json",
    adversarial:
      "tests/fixtures/demos/app-modernization/adversarial-scenarios.json"
  },
  "feature-delivery": {
    recovery: "tests/fixtures/demos/feature-delivery/recovery-cases.json",
    adversarial: "tests/fixtures/demos/feature-delivery/adversarial-cases.json"
  },
  "security-dependency-remediation": {
    recovery:
      "tests/fixtures/demos/security-dependency-remediation/recovery-scenarios.json",
    adversarial:
      "tests/fixtures/demos/security-dependency-remediation/adversarial-scenarios.json"
  },
  "adaptive-delivery": {
    recovery:
      "tests/fixtures/demos/adaptive-delivery/recovery-scenarios.json",
    adversarial:
      "tests/fixtures/demos/adaptive-delivery/adversarial-scenarios.json"
  }
};
const REQUIRED_RECOVERY_IDS = [
  "pause",
  "block",
  "cancel",
  "repair",
  "replan",
  "revision",
  "retry",
  "partial-effect",
  "lost-ack",
  "reauthorization"
] as const;

async function requireFile(relativePath: string): Promise<void> {
  await access(path.resolve(relativePath));
}

async function validateJsonTree(relativeRoot: string): Promise<number> {
  let count = 0;
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name)
    )) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(child);
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        await readStrictJsonFile(child);
        count += 1;
      }
    }
  };
  await visit(relativeRoot);
  return count;
}

const demoDirectoryEntries = await readdir(
  "config/v1alpha1/demo-projects",
  { withFileTypes: true }
);
if (
  demoDirectoryEntries.some((entry) => !entry.isDirectory()) ||
  demoDirectoryEntries
    .map((entry) => entry.name)
    .sort()
    .join(",") !== [...DEMOS].sort().join(",")
) {
  throw new TypeError(
    "demo project directory set differs from the exact canonical portfolio"
  );
}

const lifecycle = assertDocument(
  "LifecycleGraph",
  await readStrictJsonFile("config/v1alpha1/lifecycle.json")
);
const baseRegistry = assertDocument(
  "CapabilityRegistry",
  await readStrictJsonFile("config/v1alpha1/capability-registry.json")
);
const metadata = await loadDemoRegistrationMetadata({ baseRegistry });
const contracts = await loadDemoProjectContractSets({
  baseRegistry,
  lifecycle
});

if (
  metadata.catalog.spec.entries.map((entry) => entry.id).join(",") !==
    DEMOS.join(",") ||
  metadata.reservations.spec.projects
    .map((project) => project.demoProjectId)
    .join(",") !== DEMOS.join(",") ||
  contracts.map((contract) => contract.profile.spec.demoProjectId).join(",") !==
    DEMOS.join(",")
) {
  throw new TypeError("portfolio does not contain the exact canonical four demos");
}

const phaseNames = [
  "framing",
  "planning",
  "execution",
  "verification",
  "human-review"
] as const;
const registeredAgents = new Set<string>();
const registeredSkills = new Set<string>();
const registeredWorkflows = new Set<string>();
let runtimeBindingCount = 0;

for (const contract of contracts) {
  const demoProjectId = contract.profile.spec.demoProjectId;
  const reservation = metadata.reservations.spec.projects.find(
    (project) => project.demoProjectId === demoProjectId
  );
  if (reservation === undefined) {
    throw new TypeError(`${demoProjectId} has no Foundation reservation`);
  }
  for (const relative of REQUIRED_PACK_FILES[demoProjectId]) {
    await requireFile(`config/v1alpha1/demo-projects/${demoProjectId}/${relative}`);
  }
  const recovery = await readStrictJsonFile(
    RECOVERY_FIXTURES[demoProjectId].recovery
  );
  const recoveryText = JSON.stringify(recovery);
  for (const id of REQUIRED_RECOVERY_IDS) {
    if (!recoveryText.includes(`"${id}"`)) {
      throw new TypeError(
        `${demoProjectId} recovery fixture does not bind ${id}`
      );
    }
  }
  const adversarialText = JSON.stringify(
    await readStrictJsonFile(RECOVERY_FIXTURES[demoProjectId].adversarial)
  );
  for (const required of ["cross-demo", "stale", "head"]) {
    if (!adversarialText.includes(required)) {
      throw new TypeError(
        `${demoProjectId} adversarial fixtures do not cover ${required}`
      );
    }
  }
  for (const phase of phaseNames) {
    const phaseContract = assertDocument(
      "PhaseContract",
      await readStrictJsonFile(
        `config/v1alpha1/demo-projects/${demoProjectId}/phase-contracts/${phase}.json`
      )
    );
    const expectedCapabilities = contract.bindings.spec.stageBindings.flatMap(
      (stage) =>
        stage.runtimeBindings
          .filter((binding) => binding.phase === phase)
          .map((binding) => binding.capability)
    );
    if (
      [...phaseContract.allowedCapabilities].sort().join(",") !==
      [...expectedCapabilities].sort().join(",")
    ) {
      throw new TypeError(
        `${demoProjectId} ${phase} Phase Contract differs from its stage bindings`
      );
    }
    const requirementErrors = [
      ...phaseContract.entryPredicates.flatMap((requirement) =>
        kernelSupportsContractRequirement("predicate", requirement)
          ? []
          : [`unknown predicate ${requirement}`]
      ),
      ...phaseContract.exitRules.flatMap((rule) =>
        kernelSupportsContractRequirement("predicate", rule.predicate)
          ? []
          : [`unknown predicate ${rule.predicate}`]
      ),
      ...phaseContract.requiredEvidence.flatMap((requirement) =>
        kernelSupportsContractRequirement("evidence", requirement)
          ? []
          : [`unknown evidence ${requirement}`]
      ),
      ...validateClosedSchemaDialect({
        schema: phaseContract.inputSchema,
        path: `${demoProjectId}/${phase}/input`,
        targetFreeOutput: false
      }).map((error) => error.message),
      ...validateClosedSchemaDialect({
        schema: phaseContract.outputSchema,
        path: `${demoProjectId}/${phase}/output`,
        targetFreeOutput: phaseContract.allowedCapabilities.length > 0
      }).map((error) => error.message)
    ];
    if (requirementErrors.length > 0) {
      throw new TypeError(
        `${demoProjectId} ${phase} Phase Contract is not closed: ${requirementErrors.join("; ")}`
      );
    }
  }
  for (const stage of reservation.journeyStages) {
    const installed = contract.bindings.spec.stageBindings.find(
      (candidate) => candidate.stageId === stage.stageId
    );
    if (
      installed === undefined ||
      installed.executionKind !== stage.executionKind ||
      installed.runtimeBindings.length !== stage.runtimeBindings.length
    ) {
      throw new TypeError(`${demoProjectId}/${stage.stageId} is partially installed`);
    }
    if (stage.executionKind !== "model") continue;
    for (const runtime of installed.runtimeBindings) {
      const handle = issueTrustedDemoRuntimeBinding({
        catalog: metadata.catalog,
        reservations: metadata.reservations,
        lifecycle,
        baseRegistry,
        contracts: contract,
        stageId: stage.stageId,
        runtimeIdentity: {
          agentId: runtime.agent,
          capabilityId: runtime.capability,
          workflowId: runtime.workflow
        }
      });
      const binding = assertTrustedDemoRuntimeBinding(handle);
      if (
        binding.demoProjectId !== demoProjectId ||
        binding.stageId !== stage.stageId ||
        binding.agent.startsWith("runtime-") ||
        binding.skill.startsWith("runtime-") ||
        binding.workflow.startsWith("runtime-")
      ) {
        throw new TypeError(`${demoProjectId}/${stage.stageId} uses a fallback identity`);
      }
      for (const [set, value, subject] of [
        [registeredAgents, binding.agent, "agent"],
        [registeredSkills, binding.skill, "skill"],
        [registeredWorkflows, binding.workflow, "workflow"]
      ] as const) {
        if (set.has(value)) {
          throw new TypeError(`duplicate portfolio ${subject} identity ${value}`);
        }
        set.add(value);
      }
      await Promise.all([
        requireFile(`.github/agents/${binding.agent}.agent.md`),
        requireFile(`.github/skills/${binding.skill}/SKILL.md`),
        requireFile(`.github/workflows/${binding.workflow}.md`),
        requireFile(`.github/workflows/${binding.workflow}.lock.yml`)
      ]);
      runtimeBindingCount += 1;
    }
  }
}

const appCommands = (await readStrictJsonFile(
  "config/v1alpha1/demo-projects/app-modernization/verification-commands.json"
)) as {
  readonly commands: readonly {
    readonly id: string;
    readonly executable: string;
    readonly args: readonly string[];
    readonly timeoutMs: number;
    readonly network: false;
    readonly credentials: false;
  }[];
};
const featureCommands = (await readStrictJsonFile(
  "config/v1alpha1/demo-projects/feature-delivery/verification-commands.json"
)) as {
  readonly spec: {
    readonly commands: readonly {
      readonly id: string;
      readonly executable: string;
      readonly args: readonly string[];
      readonly timeoutMs: number;
      readonly maxOutputBytes: number;
    }[];
  };
};
for (const command of [
  ...appCommands.commands.map((value) => ({
    id: value.id,
    executable: value.executable,
    args: value.args,
    timeoutMs: value.timeoutMs,
    maxOutputBytes: 65_536,
    network: value.network,
    credentials: value.credentials
  })),
  ...featureCommands.spec.commands.map((value) => ({
    ...value,
    network: false as const,
    credentials: false as const
  }))
]) {
  const registered =
    ENGINEERING_VERIFICATION_COMMANDS[
      command.id as keyof typeof ENGINEERING_VERIFICATION_COMMANDS
    ];
  if (
    registered === undefined ||
    command.network !== false ||
    command.credentials !== false ||
    registered.id !== command.id ||
    registered.executable !== command.executable ||
    JSON.stringify(registered.args) !== JSON.stringify(command.args) ||
    registered.timeoutMs !== command.timeoutMs ||
    registered.maxOutputBytes !== command.maxOutputBytes
  ) {
    throw new TypeError(
      `fixed verification command ${command.id} differs from its trusted catalog`
    );
  }
}
const securityBinding = (await readStrictJsonFile(
  "config/v1alpha1/demo-projects/security-dependency-remediation/trusted-binding.json"
)) as { readonly spec: { readonly fixedChecks: readonly string[] } };
if (
  securityBinding.spec.fixedChecks.join(",") !==
  [
    "hermetic-reproduction",
    "fixed-regression",
    "dependency-lock-consistency",
    "threat-detection",
    "dlp-scan",
    "synthetic-security-scan"
  ].join(",")
) {
  throw new TypeError(
    "Security and Dependency Remediation fixed evidence catalog drifted"
  );
}
for (const commandId of securityBinding.spec.fixedChecks) {
  if (
    ENGINEERING_VERIFICATION_COMMANDS[
      commandId as keyof typeof ENGINEERING_VERIFICATION_COMMANDS
    ] === undefined
  ) {
    throw new TypeError(
      `Security and Dependency Remediation fixed check ${commandId} is not registered`
    );
  }
}

const actionLock = JSON.parse(
  await readFile(".github/aw/actions-lock.json", "utf8")
) as { readonly entries?: Readonly<Record<string, unknown>> };
if (
  Object.keys(actionLock.entries ?? {}).join(",") !==
  "github/gh-aw/actions/setup@48e5fa3ff52294d91d97715017a9f8693a48387f"
) {
  throw new TypeError("Agentic Workflow action lock differs from the reviewed set");
}

const jsonCount = await Promise.all([
  validateJsonTree("config/v1alpha1/demo-projects"),
  validateJsonTree("schemas/v1alpha1/demo-projects"),
  validateJsonTree("examples/demos"),
  validateJsonTree("tests/fixtures/demos")
]).then((counts) => counts.reduce((total, count) => total + count, 0));

validateDemoContract("DemoCatalog", metadata.catalog);
validateDemoContract(
  "DemoIdentityReservationManifest",
  metadata.reservations
);

execFileSync(process.execPath, ["dist/scripts/validate-workflows.js"], {
  cwd: process.cwd(),
  encoding: "utf8",
  stdio: "pipe"
});
execFileSync(process.execPath, ["dist/scripts/validate-runtime-config.js"], {
  cwd: process.cwd(),
  encoding: "utf8",
  stdio: "pipe"
});
execFileSync(
  process.execPath,
  [
    "--test",
    "dist/tests/demo-portfolio.test.js",
    "dist/tests/demo-runtime.test.js",
    "dist/tests/app-modernization-demo.test.js",
    "dist/tests/feature-delivery-demo.test.js",
    "dist/tests/security-dependency-remediation-demo.test.js",
    "dist/tests/demo-integration.test.js"
  ],
  {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: "pipe"
  }
);

console.log(
  `Validated the exact ${contracts.length}-demo portfolio, ${runtimeBindingCount} exclusive runtime bindings, ${jsonCount} strict JSON assets, all Phase Contracts, fixed command catalogs, source/lock freshness, recovery behavior, and the reviewed action lock.`
);
