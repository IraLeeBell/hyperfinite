import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

import baseRegistry from "../config/v1alpha1/capability-registry.json" with { type: "json" };
import catalog from "../config/v1alpha1/demo-portfolio/catalog.json" with { type: "json" };
import reservations from "../config/v1alpha1/demo-portfolio/identity-reservations.json" with { type: "json" };
import activation from "../config/v1alpha1/demo-projects/adaptive-delivery/activation-profile.json" with { type: "json" };
import capabilities from "../config/v1alpha1/demo-projects/adaptive-delivery/capabilities.json" with { type: "json" };
import journey from "../config/v1alpha1/demo-projects/adaptive-delivery/journey.json" with { type: "json" };
import profile from "../config/v1alpha1/demo-projects/adaptive-delivery/project-profile.json" with { type: "json" };
import projectSchema from "../config/v1alpha1/demo-projects/adaptive-delivery/project-schema.json" with { type: "json" };
import projection from "../config/v1alpha1/demo-projects/adaptive-delivery/projection-mapping.json" with { type: "json" };
import bindings from "../config/v1alpha1/demo-projects/adaptive-delivery/runtime-bindings.json" with { type: "json" };
import lifecycle from "../config/v1alpha1/lifecycle.json" with { type: "json" };

import {
  ADAPTIVE_DELIVERY_AGENT_OPTIONS,
  DEMO_PROJECT_FIELD_VOCABULARY,
  DEMO_PROJECTION_VOCABULARY,
  assertDocument,
  validateDemoContract,
  validateDemoProjectContractSet
} from "../src/index.js";

const AGENTS = [
  "adaptive-delivery-context-inventory",
  "adaptive-delivery-customer-value-explorer",
  "adaptive-delivery-technical-options-explorer",
  "adaptive-delivery-delivery-risk-challenger",
  "adaptive-delivery-guided-synthesis",
  "adaptive-delivery-minimal-slice-builder",
  "adaptive-delivery-resilience-first-builder",
  "adaptive-delivery-test-and-verification"
] as const;
const SELECTABLE = new Set([
  "adaptive-delivery-customer-value-explorer",
  "adaptive-delivery-technical-options-explorer",
  "adaptive-delivery-delivery-risk-challenger",
  "adaptive-delivery-minimal-slice-builder",
  "adaptive-delivery-resilience-first-builder"
]);

test("Adaptive Delivery is the fourth complete catalog contract", () => {
  const validatedLifecycle = assertDocument("LifecycleGraph", lifecycle);
  const validatedRegistry = assertDocument("CapabilityRegistry", baseRegistry);
  const contracts = validateDemoProjectContractSet({
    catalog,
    reservations,
    lifecycle: validatedLifecycle,
    baseRegistry: validatedRegistry,
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
  assert.equal(catalog.spec.entries[3]?.id, "adaptive-delivery");
  assert.equal(contracts.profile.spec.title, "Adaptive Delivery");
  assert.equal(contracts.activation.spec.enabled, false);
  assert.equal(contracts.journey.spec.stages.length, 9);
  assert.equal(contracts.bindings.schemaVersion, "2.0.0");
  assert.equal(contracts.capabilities.spec.capabilities.length, 8);
  assert.equal(
    contracts.bindings.spec.stageBindings.flatMap(
      (stage) => stage.runtimeBindings
    ).length,
    8
  );
});

test("Adaptive journey exposes exactly two prescribed selection stages", () => {
  const stageBindings = validateDemoContract(
    "StageAgentBindingSet",
    bindings
  ).spec.stageBindings;
  const selectable = stageBindings.filter(
    (stage) => stage.participationMode === "user-selectable"
  );
  assert.deepEqual(
    selectable.map((stage) => [
      stage.stageId,
      stage.allowedOptionKeys,
      stage.runtimeBindings.length
    ]),
    [
      [
        "discovery-studio",
        [
          "discovery-customer-value-explorer",
          "discovery-technical-options-explorer",
          "discovery-delivery-risk-challenger"
        ],
        3
      ],
      [
        "implementation-studio",
        [
          "implementation-minimal-slice-builder",
          "implementation-resilience-first-builder"
        ],
        2
      ]
    ]
  );
  assert.ok(
    selectable.every(
      (stage) =>
        stage.userInputRequired &&
        stage.selectionFieldKey === "requested-stage-agent" &&
        stage.fallbackPolicy === "none" &&
        stage.clearSelectionOnExit &&
        stage.runtimeBindings.every((binding) => binding.userInvocable)
    )
  );
});

test("Adaptive Project schema separates intent from fourteen trusted projections", () => {
  assert.equal(projectSchema.project.title, "Adaptive Delivery - Hyperfinite");
  assert.deepEqual(
    projectSchema.fields.map((field) => ({
      key: field.key,
      name: field.name
    })),
    DEMO_PROJECT_FIELD_VOCABULARY
  );
  assert.deepEqual(
    projectSchema.projections.map((entry) => entry.slot),
    DEMO_PROJECTION_VOCABULARY.map((field) => field.key)
  );
  assert.equal(
    projectSchema.projections.some(
      (entry) => entry.slot === "requested-stage-agent"
    ),
    false
  );
  const requested = projectSchema.fields.find(
    (field) => field.key === "requested-stage-agent"
  );
  assert.deepEqual(requested?.options, ADAPTIVE_DELIVERY_AGENT_OPTIONS);
});

test("all Adaptive agents, skills, and static workflow locks are complete", async () => {
  for (const agentId of AGENTS) {
    const [agent, skill, workflow] = await Promise.all([
      readFile(`.github/agents/${agentId}.agent.md`, "utf8"),
      readFile(`.github/skills/${agentId}/SKILL.md`, "utf8"),
      readFile(`.github/workflows/${agentId}.md`, "utf8"),
      access(`.github/workflows/${agentId}.lock.yml`)
    ]);
    const userInvocable = SELECTABLE.has(agentId);
    assert.equal(
      agent.includes(`user-invocable: ${userInvocable}`),
      true,
      agentId
    );
    assert.equal(agent.includes("disable-model-invocation: true"), true);
    assert.equal(agent.includes("target-free"), true);
    assert.equal(skill.includes("Requested Stage Agent as authority"), true);
    assert.equal(
      new RegExp(
        `engine:\\n  id: copilot\\n(?:  version: "[^"]+"\\n)?  agent: ${agentId}`
      ).test(workflow),
      true
    );
    assert.equal(
      workflow.includes(
        "RUNTIME_STAGE_AGENT_SELECTION_GRANT_DIGEST"
      ),
      false
    );
    assert.equal(
      workflow.includes(
        "AGENTIC_STAGE_AGENT_SELECTION_SIGNING_PUBLIC_KEY"
      ),
      userInvocable
    );
    assert.equal(/engine:\s*\n(?:.|\n)*agent:\s*\$\{\{/u.test(workflow), false);
    assert.equal(
      /event:\s*(?:APPROVE|REQUEST_CHANGES)/u.test(workflow),
      false
    );
    assert.equal(workflow.includes("pulls.merge"), false);
  }
});

test("user-selectable agents explicitly refuse unbound lifecycle authority", async () => {
  for (const agentId of SELECTABLE) {
    const [agent, skill] = await Promise.all([
      readFile(`.github/agents/${agentId}.agent.md`, "utf8"),
      readFile(`.github/skills/${agentId}/SKILL.md`, "utf8")
    ]);
    for (const text of [agent, skill]) {
      assert.equal(text.includes("activation-required"), true);
      assert.equal(text.includes("cannot advance the journey"), true);
    }
  }
});

test("selectable runtime guard binds an App-authored signed grant marker", async () => {
  const guard = await readFile("scripts/runtime-pre-activation.ts", "utf8");
  for (const required of [
    "agentic-framework-stage-agent-selection",
    "stageAgentSelection",
    "validateBoundStageAgentSelectionGrant",
    "binding.userInvocable",
    "AGENTIC_STAGE_AGENT_SELECTION_SIGNING_PUBLIC_KEY"
  ]) {
    assert.equal(guard.includes(required), true, required);
  }
  assert.equal(
    guard.includes("RUNTIME_STAGE_AGENT_SELECTION_GRANT_DIGEST"),
    false
  );
});

test("guided selection resolves one exact candidate and rejects stale or wrong-stage intent", () => {
  const stageBindings = validateDemoContract(
    "StageAgentBindingSet",
    bindings
  ).spec.stageBindings;
  const discovery = stageBindings.find(
    (stage) => stage.stageId === "discovery-studio"
  )!;
  const implementation = stageBindings.find(
    (stage) => stage.stageId === "implementation-studio"
  )!;
  assert.equal(
    discovery.allowedOptionKeys.some((key) =>
      implementation.allowedOptionKeys.includes(key)
    ),
    false
  );
  assert.equal(
    new Set(
      stageBindings.flatMap((stage) =>
        stage.runtimeBindings.map((binding) => binding.agent)
      )
    ).size,
    8
  );
});
