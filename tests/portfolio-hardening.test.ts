import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnySchema } from "ajv";

import hardeningPlanSchema from "../schemas/v1alpha1/demo-portfolio-hardening-plan.schema.json" with { type: "json" };
import externalCallAssertionsSchema from "../schemas/v1alpha1/demo-external-call-assertions.schema.json" with { type: "json" };
import { parseStrictJson } from "../src/strict-json.js";

const plan = parseStrictJson(
  readFileSync("config/v1alpha1/demo-portfolio/hardening-plan.json", "utf8")
);
const validate = new Ajv2020({ allErrors: true, strict: true }).compile(
  hardeningPlanSchema as AnySchema
);

test("portfolio hardening plan is closed, complete, and hermetic", () => {
  assert.equal(validate(plan), true);
  assert.equal(typeof plan, "object");
  assert.notEqual(plan, null);
  assert.equal(Array.isArray(plan), false);
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) return;
  const value = plan as Readonly<Record<string, unknown>>;
  assert.deepEqual(value["demos"], [
    "app-modernization",
    "feature-delivery",
    "security-dependency-remediation",
    "adaptive-delivery"
  ]);
  assert.equal(value["mode"], "hermetic");
  const serialized = JSON.stringify(value);
  for (const prohibited of [
    "personal-access-token",
    "production-ready",
    "projects-provisioned",
    "live-mode-enabled"
  ]) {
    assert.equal(serialized.includes(prohibited), false);
  }
});

test("portfolio hardening plan rejects unknown fields and duplicate JSON keys", () => {
  assert.equal(typeof plan, "object");
  assert.notEqual(plan, null);
  assert.equal(Array.isArray(plan), false);
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) return;
  assert.equal(validate({ ...plan, targetRepository: "untrusted/example" }), false);
  assert.throws(
    () =>
      parseStrictJson(
        '{"kind":"DemoPortfolioHardeningPlan","kind":"Substituted"}'
      ),
    /duplicate JSON object key/u
  );
});

test("portfolio external-call assertions require all four zero categories per demo", () => {
  const validateAssertions = new Ajv2020({
    allErrors: true,
    strict: true
  }).compile(externalCallAssertionsSchema as AnySchema);
  for (const demoProjectId of [
    "app-modernization",
    "feature-delivery",
    "security-dependency-remediation",
    "adaptive-delivery"
  ]) {
    const value = parseStrictJson(
      readFileSync(
        `tests/fixtures/demos/${demoProjectId}/external-call-assertions.json`,
        "utf8"
      )
    );
    assert.equal(validateAssertions(value), true);
    assert.equal(typeof value, "object");
    assert.notEqual(value, null);
    assert.equal(Array.isArray(value), false);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      continue;
    }
    const counters = {
      ...(value as Readonly<Record<string, unknown>>)["counters"] as Readonly<
        Record<string, unknown>
      >
    };
    delete counters["paidInference"];
    assert.equal(
      validateAssertions({ ...value, counters }),
      false,
      demoProjectId
    );
    assert.equal(
      validateAssertions({
        ...value,
        counters: {
          ...(value as Readonly<Record<string, unknown>>)["counters"] as object,
          other: 0
        }
      }),
      false,
      demoProjectId
    );
  }
});

test("hardening gate rejects live options before environment or credential reads", () => {
  const result = spawnSync(
    process.execPath,
    ["dist/scripts/validate-demo-hardening.js", "--live"],
    {
      encoding: "utf8",
      env: {
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        SECRET_SENTINEL: "must-not-be-read"
      }
    }
  );
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /forbidden before environment or credential reads/u
  );
  assert.equal(result.stderr.includes("must-not-be-read"), false);
});

test("readiness runbook keeps Projects and live use behind human administration", () => {
  const readiness = readFileSync(
    "docs/demos/portfolio/activation-and-readiness.md",
    "utf8"
  );
  for (const statement of [
    "Repository/hermetic-demo-ready",
    "Sandbox/live: blocked",
    "Customer adoption:",
    "Repository delivery did not create a GitHub Project",
    "Only after the canary reaches Human Review"
  ]) {
    assert.ok(readiness.includes(statement), statement);
  }
});
