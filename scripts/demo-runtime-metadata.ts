import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  collectTrustedRuntimeWorkflowBindings,
  issueTrustedDemoRuntimeBinding,
  type TrustedDemoRuntimeBinding,
  validateDemoContract,
  validateDemoProjectContractSet,
  validateDemoRegistrationShards,
  validatePortfolioFoundation
} from "../src/demo-portfolio.js";
import type {
  DemoCatalog,
  DemoIdentityReservationManifest,
  DemoProjectContractSet,
  DemoRegistrationShardPair,
  TrustedRuntimeWorkflowBinding
} from "../src/demo-types.js";
import { parseStrictJson } from "../src/strict-json.js";
import type {
  CapabilityRegistry,
  CopilotRuntimePolicy,
  LifecycleGraph
} from "../src/types.js";

export async function readStrictJsonFile(relativePath: string): Promise<unknown> {
  return parseStrictJson(await readFile(path.resolve(relativePath), "utf8"));
}

async function readOptionalStrictJsonFile(
  relativePath: string
): Promise<unknown | null> {
  try {
    return await readStrictJsonFile(relativePath);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

async function assertKnownDemoDirectories(catalog: DemoCatalog): Promise<void> {
  const root = "config/v1alpha1/demo-projects";
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
  const known = new Set<string>(catalog.spec.entries.map((entry) => entry.id));
  for (const entry of entries) {
    if (!entry.isDirectory() || !known.has(entry.name)) {
      throw new TypeError(
        `unknown demo registration path ${path.join(root, entry.name)}`
      );
    }
  }
}

export async function loadDemoRegistrationMetadata(input: {
  readonly baseRegistry: CapabilityRegistry;
}): Promise<{
  readonly catalog: DemoCatalog;
  readonly reservations: DemoIdentityReservationManifest;
  readonly shards: readonly DemoRegistrationShardPair[];
  readonly runtimeBindings: readonly TrustedRuntimeWorkflowBinding[];
}> {
  const { catalog, reservations } = validatePortfolioFoundation(
    await readStrictJsonFile("config/v1alpha1/demo-portfolio/catalog.json"),
    await readStrictJsonFile(
      "config/v1alpha1/demo-portfolio/identity-reservations.json"
    )
  );
  await assertKnownDemoDirectories(catalog);
  const shards: DemoRegistrationShardPair[] = [];
  for (const entry of catalog.spec.entries) {
    const capabilitiesValue = await readOptionalStrictJsonFile(
      entry.capabilityShardRef
    );
    const bindingsValue = await readOptionalStrictJsonFile(
      entry.stageAgentBindingsRef
    );
    if (capabilitiesValue === null && bindingsValue === null) continue;
    if (capabilitiesValue === null || bindingsValue === null) {
      throw new TypeError(
        `${entry.id} must register capability and runtime-binding shards together`
      );
    }
    const capabilities = validateDemoContract(
      "DemoCapabilityRegistryShard",
      capabilitiesValue
    );
    const bindings = validateDemoContract(
      "StageAgentBindingSet",
      bindingsValue
    );
    if (
      capabilities.spec.demoProjectId !== entry.id ||
      bindings.spec.demoProjectId !== entry.id
    ) {
      throw new TypeError(
        `${entry.id} reserved registration paths contain another demo identity`
      );
    }
    shards.push({ capabilities, bindings });
  }
  const runtimeBindings = validateDemoRegistrationShards({
    catalog,
    reservations,
    baseRegistry: input.baseRegistry,
    shards
  });
  return { catalog, reservations, shards, runtimeBindings };
}

export async function loadTrustedRuntimeWorkflowBindings(input: {
  readonly policy: CopilotRuntimePolicy;
  readonly baseRegistry: CapabilityRegistry;
}): Promise<{
  readonly catalog: DemoCatalog;
  readonly reservations: DemoIdentityReservationManifest;
  readonly shards: readonly DemoRegistrationShardPair[];
  readonly bindings: readonly TrustedRuntimeWorkflowBinding[];
}> {
  const metadata = await loadDemoRegistrationMetadata({
    baseRegistry: input.baseRegistry
  });
  return {
    catalog: metadata.catalog,
    reservations: metadata.reservations,
    shards: metadata.shards,
    bindings: collectTrustedRuntimeWorkflowBindings(
      input.policy,
      metadata.runtimeBindings
    )
  };
}

export async function loadDemoProjectContractSets(input: {
  readonly baseRegistry: CapabilityRegistry;
  readonly lifecycle: LifecycleGraph;
}): Promise<readonly DemoProjectContractSet[]> {
  const { catalog, reservations } = validatePortfolioFoundation(
    await readStrictJsonFile("config/v1alpha1/demo-portfolio/catalog.json"),
    await readStrictJsonFile(
      "config/v1alpha1/demo-portfolio/identity-reservations.json"
    )
  );
  await assertKnownDemoDirectories(catalog);
  const result: DemoProjectContractSet[] = [];
  for (const entry of catalog.spec.entries) {
    const values = await Promise.all([
      readOptionalStrictJsonFile(entry.projectProfileRef),
      readOptionalStrictJsonFile(entry.journeyDefinitionRef),
      readOptionalStrictJsonFile(entry.capabilityShardRef),
      readOptionalStrictJsonFile(entry.stageAgentBindingsRef),
      readOptionalStrictJsonFile(entry.activationProfileRef),
      readOptionalStrictJsonFile(entry.projectionMappingRef)
    ]);
    if (values.every((value) => value === null)) continue;
    if (values.some((value) => value === null)) {
      throw new TypeError(
        `${entry.id} must install its profile, journey, capability, binding, activation, and projection contracts together`
      );
    }
    const [
      profileValue,
      journeyValue,
      capabilityValue,
      bindingValue,
      activationValue,
      projectionValue
    ] = values;
    const contracts = validateDemoProjectContractSet({
        catalog,
        reservations,
        lifecycle: input.lifecycle,
        baseRegistry: input.baseRegistry,
        contracts: {
          profile: validateDemoContract("DemoProjectProfile", profileValue),
          journey: validateDemoContract(
            "DemoJourneyDefinition",
            journeyValue
          ),
          capabilities: validateDemoContract(
            "DemoCapabilityRegistryShard",
            capabilityValue
          ),
          bindings: validateDemoContract(
            "StageAgentBindingSet",
            bindingValue
          ),
          activation: validateDemoContract(
            "DemoActivationProfile",
            activationValue
          ),
          projection: validateDemoContract(
            "DemoProjectionMapping",
            projectionValue
          )
        }
      });
    if (contracts.profile.spec.demoProjectId !== entry.id) {
      throw new TypeError(
        `${entry.id} reserved contract paths contain another demo identity`
      );
    }
    result.push(contracts);
  }
  return result;
}

export async function loadTrustedDemoRuntimeBindingForSelection(input: {
  readonly baseRegistry: CapabilityRegistry;
  readonly lifecycle: LifecycleGraph;
  readonly demoProjectId: string;
  readonly stageId: string;
  readonly phase: TrustedRuntimeWorkflowBinding["phase"];
  readonly role: TrustedRuntimeWorkflowBinding["role"];
  readonly capability: string;
  readonly workflowId: string;
}): Promise<TrustedDemoRuntimeBinding> {
  const [metadata, contracts] = await Promise.all([
    loadDemoRegistrationMetadata({ baseRegistry: input.baseRegistry }),
    loadDemoProjectContractSets({
      baseRegistry: input.baseRegistry,
      lifecycle: input.lifecycle
    })
  ]);
  const contract = contracts.find(
    (candidate) =>
      candidate.profile.spec.demoProjectId === input.demoProjectId
  );
  if (contract === undefined) {
    throw new TypeError(
      `unknown trusted demo project selection ${input.demoProjectId}`
    );
  }
  const stage = contract.bindings.spec.stageBindings.find(
    (candidate) => candidate.stageId === input.stageId
  );
  const selected = stage?.runtimeBindings.filter(
    (candidate) =>
      candidate.phase === input.phase &&
      candidate.role === input.role &&
      candidate.capability === input.capability &&
      candidate.workflow === input.workflowId &&
      candidate.modelInvocationAllowed
  );
  if (
    stage?.executionKind !== "model" ||
    selected === undefined ||
    selected.length !== 1
  ) {
    throw new TypeError(
      "trusted demo catalog/profile/stage selection does not identify one model binding"
    );
  }
  return issueTrustedDemoRuntimeBinding({
    catalog: metadata.catalog,
    reservations: metadata.reservations,
    lifecycle: input.lifecycle,
    baseRegistry: input.baseRegistry,
    contracts: contract,
    stageId: input.stageId,
    runtimeIdentity: {
      agentId: selected[0]!.agent,
      capabilityId: selected[0]!.capability,
      workflowId: selected[0]!.workflow
    }
  });
}
