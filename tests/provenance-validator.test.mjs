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
