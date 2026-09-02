import assert from "node:assert/strict";
import { test } from "node:test";

import * as publicApi from "../src/index.js";

/**
 * The pre-App deployment topology, GitHub App registration, and
 * administrator plan/readback contracts (ADR 0013) are supported public
 * contracts intended for direct consumption by later durable-adapter and
 * sandbox-composition work. This test makes that support
 * intentional and regression-proof: if any of these symbols are ever
 * accidentally dropped from `src/index.ts`, this test fails.
 */
test("src/index.ts exports the pre-App deployment topology contract", () => {
  assert.equal(typeof publicApi.planDeploymentTopology, "function");
  assert.equal(typeof publicApi.validateDeploymentTopologyPlan, "function");
  assert.deepEqual(publicApi.TRUST_SERVICE_IDS.length, 8);
  assert.deepEqual(publicApi.DURABLE_STORE_IDS.length, 4);
});

test("src/index.ts exports the GitHub App registration plan and target binding contract", () => {
  assert.equal(typeof publicApi.planGitHubAppRegistration, "function");
  assert.equal(typeof publicApi.validateGitHubAppRegistrationPlan, "function");
  assert.equal(typeof publicApi.compareGitHubAppPermissionReadback, "function");
});

test("src/index.ts exports the administrator plan and readback contract", () => {
  assert.equal(typeof publicApi.planAdministratorConfiguration, "function");
  assert.equal(typeof publicApi.validateAdministratorPlan, "function");
  assert.equal(typeof publicApi.compareAdministratorReadback, "function");
  assert.equal(typeof publicApi.checkReadbackDriftCoherence, "function");
  assert.deepEqual(publicApi.REQUIRED_CHECK_NAMES.length, 12);
});

test("src/index.ts exports the integrated administrator handoff and apply-gate contracts", () => {
  assert.equal(typeof publicApi.planAdministratorHandoff, "function");
  assert.equal(typeof publicApi.planAdministratorApply, "function");
  assert.equal(typeof publicApi.validateAdministratorApplyGate, "function");
  assert.equal(typeof publicApi.validateAdministratorPostApplyReadback, "function");
  assert.equal(typeof publicApi.compareAdministratorHandoffReadback, "function");
  assert.equal(typeof publicApi.validateAdministratorHandoffReport, "function");
  assert.deepEqual(publicApi.ADMINISTRATOR_HANDOFF_CONTROLS.length, 27);
  assert.deepEqual(publicApi.ADMINISTRATOR_PROHIBITED_EFFECTS.length, 12);
});

test("src/index.ts exports the shared freshness-window helpers", () => {
  assert.equal(typeof publicApi.checkObservationFreshness, "function");
  assert.equal(typeof publicApi.checkNotExpired, "function");
});

test("src/index.ts exports the shared duplicate-key detection helper", () => {
  assert.equal(typeof publicApi.findDuplicateKeys, "function");
});
