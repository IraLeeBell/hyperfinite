import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  validateGitHubCitationForms,
  validateInventoryDocument,
  validateProvenance
} from "../scripts/validate-provenance.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expectedSha = "716daf7da96e287e484c9cdf12b2c5ae80e55cc6";
const publicHistoryStatement =
  "Public project history begins with a curated open-source snapshot. Earlier private development history is intentionally not published.";

function normalizedProse(source) {
  return source.replace(/\s+/gu, " ").trim();
}

async function authoritativeInventory() {
  const [schemaSource, inventorySource] = await Promise.all([
    readFile(
      path.join(root, "docs/provenance/reference-inventory.schema.json"),
      "utf8"
    ),
    readFile(
      path.join(root, "docs/provenance/reference-inventory.yml"),
      "utf8"
    )
  ]);
  return {
    document: parse(inventorySource),
    schema: JSON.parse(schemaSource)
  };
}

test("accepts the empty authoritative reference inventory", async () => {
  const { document, schema } = await authoritativeInventory();
  assert.deepEqual(document.references, []);
  assert.deepEqual(validateInventoryDocument(document, schema), []);
});

test("validates repository provenance without external references", async () => {
  assert.deepEqual(
    await validateProvenance({
      root,
      inventoryPath: path.join(
        root,
        "docs/provenance/reference-inventory.yml"
      )
    }),
    []
  );
});

test("documents the public snapshot boundary and independent customer root", async () => {
  const paths = [
    "README.md",
    "CONTRIBUTING.md",
    "CUSTOMER_EVALUATION_GUIDE.md",
    "CUSTOMER_FAQ.md",
    "GOVERNANCE.md",
    "docs/architecture/distribution-boundary.md",
    "docs/governance/open-source-readiness.md",
    "docs/provenance/README.md"
  ];
  const documents = new Map(
    await Promise.all(
      paths.map(async (relativePath) => [
        relativePath,
        normalizedProse(await readFile(path.join(root, relativePath), "utf8"))
      ])
    )
  );

  for (const relativePath of [
    "README.md",
    "CUSTOMER_FAQ.md",
    "docs/provenance/README.md"
  ]) {
    assert.ok(documents.get(relativePath).includes(publicHistoryStatement));
  }
  assert.match(
    documents.get("CONTRIBUTING.md"),
    /The authoritative `[^`]+` repository uses three issue classes\. It is the authoritative upstream for public development from that snapshot forward/u
  );
  for (const relativePath of [
    "CONTRIBUTING.md",
    "GOVERNANCE.md",
    "docs/governance/open-source-readiness.md",
    "docs/provenance/README.md"
  ]) {
    assert.match(
      documents.get(relativePath),
      /Unpublished issues, pull requests, commits, or coordination records are not required/iu
    );
  }
  for (const relativePath of [
    "CONTRIBUTING.md",
    "CUSTOMER_EVALUATION_GUIDE.md",
    "CUSTOMER_FAQ.md",
    "docs/architecture/distribution-boundary.md",
    "docs/provenance/README.md"
  ]) {
    assert.match(documents.get(relativePath), /own reviewed file snapshot/iu);
    assert.match(documents.get(relativePath), /new evidence-chain root/iu);
  }
  for (const relativePath of [
    "CUSTOMER_FAQ.md",
    "docs/architecture/distribution-boundary.md",
    "docs/provenance/README.md"
  ]) {
    assert.match(
      documents.get(relativePath),
      /Exact-head release and customer-starter (?:evidence|provenance)/iu
    );
  }
});

test("keeps immutable citation validation for this repository", () => {
  const canonical =
    `https://github.com/example-organization/hyperfinite/blob/${expectedSha}/README.md#L1-L2`;
  assert.deepEqual(validateGitHubCitationForms(canonical, "README.md"), []);

  const errors = validateGitHubCitationForms(
    "https://github.com/example-organization/hyperfinite/blob/main/README.md#L1",
    "README.md"
  );
  assert.ok(errors.some((error) => error.includes("mutable GitHub blob ref main")));
});
