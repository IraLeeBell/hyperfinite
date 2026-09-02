import assert from "node:assert/strict";
import test from "node:test";

import {
  codeownersUseRepositoryOwner,
  renderCustomerCodeowners
} from "../src/customer-repository-config.js";

const SOURCE = [
  "# Human review boundary",
  "* @source-maintainer",
  "/src/ @source-maintainer",
  ""
].join("\n");
const SOURCE_OWNER = ["@", "Ira", "Lee", "Bell"].join("");

test("customer configuration rewrites every CODEOWNERS rule", () => {
  assert.equal(
    renderCustomerCodeowners({
      source: SOURCE,
      codeowner: "@example-customer/platform-reviewers",
      repository: "example-customer/hyperfinite"
    }),
    [
      "# Human review boundary",
      "* @example-customer/platform-reviewers",
      "/src/ @example-customer/platform-reviewers",
      ""
    ].join("\n")
  );
  assert.match(
    renderCustomerCodeowners({
      source: SOURCE,
      codeowner: "@customer-maintainer",
      repository: "example-customer/hyperfinite"
    }),
    /\* @customer-maintainer/u
  );
});

test("customer configuration rejects cross-owner teams and malformed rules", () => {
  assert.throws(
    () =>
      renderCustomerCodeowners({
        source: SOURCE,
        codeowner: "@another-organization/platform-reviewers",
        repository: "example-customer/hyperfinite"
      }),
    /must belong to the repository owner/u
  );
  assert.throws(
    () =>
      renderCustomerCodeowners({
        source: "not-a-rule",
        codeowner: "@example-customer/platform-reviewers",
        repository: "example-customer/hyperfinite"
      }),
    /invalid rule/u
  );
});

test("customer audit accepts code owners belonging to the destination owner", () => {
  assert.equal(
    codeownersUseRepositoryOwner({
      source: `* ${SOURCE_OWNER}\n`,
      repository: "IraLeeBell/hyperfinite"
    }),
    true
  );
  assert.equal(
    codeownersUseRepositoryOwner({
      source: "* @example-customer/platform-reviewers\n",
      repository: "example-customer/hyperfinite"
    }),
    true
  );
  assert.equal(
    codeownersUseRepositoryOwner({
      source: `* ${SOURCE_OWNER}\n`,
      repository: "example-customer/hyperfinite"
    }),
    false
  );
});
