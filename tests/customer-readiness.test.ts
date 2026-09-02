import assert from "node:assert/strict";
import test from "node:test";

import { auditCustomerShareability } from "../src/customer-readiness.js";

const CASES = [
  {
    id: "source-repository-binding",
    positive: ["github", "hyperfinite"].join("/"),
    nearMiss: ["github", "hyperfinite-docs"].join("/")
  },
  {
    id: "source-codeowner",
    positive: ["@", "IraLeeBell"].join(""),
    nearMiss: ["@", "IraLeeBelle"].join("")
  },
  {
    id: "github-private-domain",
    positive: ["github", "net"].join("."),
    nearMiss: ["github", "com"].join(".")
  },
  {
    id: "private-slack-link",
    positive: ["https://workspace", "slack.com/archives/C123"].join("."),
    nearMiss: ["https://workspace", "slack.com/messages/C123"].join(".")
  },
  {
    id: "private-sharepoint-link",
    positive: ["https://github", "sharepoint.com/sites/private"].join("."),
    nearMiss: ["https://customer", "sharepoint.com/sites/public"].join(".")
  },
  {
    id: "source-organization-url",
    positive: ["https://github.com/orgs", "github"].join("/"),
    nearMiss: ["https://github.com/orgs", "example"].join("/")
  },
  {
    id: "source-history-reference",
    positive: ["Issue ", "#42"].join(""),
    nearMiss: "Issue 42"
  },
  {
    id: "live-project-node-id",
    positive: ["PVT", "live_customer_project"].join("_"),
    nearMiss: "PVT_synthetic_customer_project"
  },
  {
    id: "source-owner-node-id",
    positive: ["MDEyOk9yZ2FuaX", "phdGlvbjk5MTk="].join(""),
    nearMiss: ["MDEyOk9yZ2FuaX", "phdGlvbjk5MTkX"].join("")
  },
  {
    id: "source-repository-node-id",
    positive: ["R_kgDO", "UEcN5g"].join(""),
    nearMiss: ["R_kgDO", "UEcN5x"].join("")
  }
] as const;

test("customer shareability rules reject matches and accept near misses", () => {
  for (const testCase of CASES) {
    const findings = auditCustomerShareability([
      {
        path: `cases/${testCase.id}.txt`,
        content: testCase.positive
      }
    ]);
    assert.deepEqual(
      findings.map((finding) => finding.ruleId),
      [testCase.id],
      testCase.id
    );
    assert.deepEqual(
      auditCustomerShareability([
        {
          path: `near-misses/${testCase.id}.txt`,
          content: testCase.nearMiss
        }
      ]),
      [],
      testCase.id
    );
  }
});

test("source CODEOWNERS exception is path- and repository-scoped", () => {
  const sourceOwner = CASES.find(
    (testCase) => testCase.id === "source-codeowner"
  )!.positive;
  assert.deepEqual(
    auditCustomerShareability(
      [{ path: ".github/CODEOWNERS", content: `* ${sourceOwner}` }],
      { allowSourceCodeowner: true }
    ),
    []
  );
  assert.deepEqual(
    auditCustomerShareability(
      [{ path: "README.md", content: sourceOwner }],
      { allowSourceCodeowner: true }
    ).map((finding) => finding.ruleId),
    ["source-codeowner"]
  );
});

test("customer shareability audit accepts customer-neutral content", () => {
  assert.deepEqual(
    auditCustomerShareability([
      {
        path: "README.md",
        content: "Configure <customer-organization>/<repository>."
      },
      {
        path: "config/example.json",
        content: "PVT_synthetic_project"
      }
    ]),
    []
  );
});

test("customer shareability audit rejects unsafe or duplicate paths", () => {
  assert.throws(
    () =>
      auditCustomerShareability([
        { path: "../README.md", content: "" }
      ]),
    /unique safe paths/u
  );
  assert.throws(
    () =>
      auditCustomerShareability([
        { path: "README.md", content: "" },
        { path: "README.md", content: "" }
      ]),
    /unique safe paths/u
  );
});
