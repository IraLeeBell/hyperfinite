/**
 * Export policy and zero-fallback guarantees for the durable substrate.
 *
 * Two separate claims are enforced here.
 *
 * 1. Export policy. The durable substrate is a *nonproduction reference
 *    implementation*, not a supported package contract, so it is deliberately
 *    absent from `src/index.ts`. This differs from the pre-App contract modules
 *    of ADR 0013, which `tests/pre-app-api-surface.test.ts` pins as
 *    intentionally public. Tests reach the substrate by deep import, the
 *    established convention for non-barrel modules in this repository.
 *
 * 2. Zero fallback. The substrate must not be able to reach an environment
 *    variable, the network, a credential, or an ambient clock. This is checked
 *    against the module source rather than only through behaviour, because a
 *    fallback path that is never taken in a test is still a fallback path.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import * as publicApi from "../src/index.js";

const SOURCE_ROOT = path.join(import.meta.dirname, "..", "..", "src");

const DURABLE_MODULES = [
  "durable-substrate.ts",
  "durable-sqlite-substrate.ts",
  "durable-store-binding.ts",
  "durable-store-composition.ts"
] as const;

function sourceOf(moduleName: string): string {
  return readFileSync(path.join(SOURCE_ROOT, moduleName), "utf8");
}

/**
 * True when a module actually *binds* a specifier, as opposed to merely
 * naming it in prose. Documentation that explains why the seam exists is
 * legitimate and must not be mistaken for a dependency.
 */
function importsSpecifier(source: string, specifier: string): boolean {
  const quoted = specifier.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(
    `(?:from|import|require)\\s*\\(?\\s*["'']${quoted}["'']`,
    "u"
  ).test(source);
}

// ---------------------------------------------------------------------------
// Export policy
// ---------------------------------------------------------------------------

test("the durable reference substrate is not part of the public package API", () => {
  const barrel = readFileSync(path.join(SOURCE_ROOT, "index.ts"), "utf8");
  for (const moduleName of DURABLE_MODULES) {
    const specifier = `./${moduleName.replace(/\.ts$/u, ".js")}`;
    assert.ok(
      !barrel.includes(specifier),
      `src/index.ts must not re-export ${moduleName}: the durable substrate is a nonproduction reference implementation, not a supported contract. Adding it to the barrel must be a deliberate, reviewed decision, not a by-product of test convenience.`
    );
  }
});

test("no durable substrate symbol leaks into the public barrel", () => {
  const leaked = [
    "openDurableSqliteSubstrate",
    "assertSupportedRuntime",
    "bindDurableStores",
    "openBoundDurableStore",
    "openDurableStoreComposition",
    "DURABLE_ADAPTER_STORE_MAPPING",
    "journalRecordDocument",
    "chainHead",
    "DurableSubstrateError",
    "DurableAmbiguousAcknowledgementError",
    "DURABLE_STORE_FORMAT_VERSION",
    "DURABLE_JOURNAL_MAX_ENTRIES"
  ].filter((name) => name in publicApi);
  assert.deepEqual(leaked, [], "durable substrate symbols must stay off the public API");
});

test("the merged pre-App contracts this substrate binds to remain public", () => {
  // The substrate consumes ADR 0013's contract; if that contract stopped
  // being public, the binding would be reaching into a private module.
  assert.equal(typeof publicApi.validateDeploymentTopologyPlan, "function");
  assert.equal(publicApi.DURABLE_STORE_IDS.length, 4);
});

// ---------------------------------------------------------------------------
// Zero fallback: environment, network, credentials, ambient clock
// ---------------------------------------------------------------------------

test("the durable modules read no environment variable", () => {
  for (const moduleName of DURABLE_MODULES) {
    const source = sourceOf(moduleName);
    for (const pattern of ["process.env", "getEnv", "loadEnv", "dotenv"]) {
      assert.ok(
        !source.includes(pattern),
        `${moduleName} must not reference ${pattern}`
      );
    }
  }
});

test("the durable modules open no network client", () => {
  const forbidden = [
    "node:net",
    "node:http",
    "node:https",
    "node:tls",
    "node:dgram",
    "undici",
    "fetch(",
    "XMLHttpRequest",
    "WebSocket"
  ];
  for (const moduleName of DURABLE_MODULES) {
    const source = sourceOf(moduleName);
    for (const pattern of forbidden) {
      assert.ok(
        !source.includes(pattern),
        `${moduleName} must not reference ${pattern}`
      );
    }
  }
});

test("the durable modules read no ambient clock", () => {
  const forbidden = ["Date.now(", "new Date(", "performance.now(", "hrtime"];
  for (const moduleName of DURABLE_MODULES) {
    const source = sourceOf(moduleName);
    for (const pattern of forbidden) {
      assert.ok(
        !source.includes(pattern),
        `${moduleName} must not reference ${pattern}: timestamps come from an injected clock`
      );
    }
  }
});

test("the durable modules handle no credential or secret material", () => {
  const forbidden = [
    "privateKey",
    "createPrivateKey",
    "createSign",
    "installationToken",
    "clientSecret",
    "webhookSecret",
    "Authorization",
    "Bearer "
  ];
  for (const moduleName of DURABLE_MODULES) {
    const source = sourceOf(moduleName);
    for (const pattern of forbidden) {
      assert.ok(
        !source.includes(pattern),
        `${moduleName} must not reference ${pattern}`
      );
    }
  }
});

test("only one module in all of src/ binds node:sqlite", () => {
  // Scans the whole source tree rather than a hand-maintained list: a new
  // module that imported node:sqlite would otherwise defeat the seam silently.
  const importers = readdirSync(SOURCE_ROOT)
    .filter((entry) => entry.endsWith(".ts"))
    .filter((entry) => importsSpecifier(sourceOf(entry), "node:sqlite"))
    .sort();
  assert.deepEqual(
    importers,
    ["durable-sqlite-substrate.ts"],
    "node:sqlite must remain confined to the single backend module so it can be replaced without touching adapters"
  );
});

test("no adapter or contract module outside the seam imports node:sqlite", () => {
  const barrel = readFileSync(path.join(SOURCE_ROOT, "index.ts"), "utf8");
  assert.ok(!importsSpecifier(barrel, "node:sqlite"));
  for (const moduleName of ["durable-substrate.ts", "durable-store-binding.ts"]) {
    assert.ok(
      !importsSpecifier(sourceOf(moduleName), "node:sqlite"),
      `${moduleName} must depend only on the DurableSubstrate interface`
    );
  }
});

/**
 * Asserts one `BEGIN IMMEDIATE` … `COMMIT` transaction window contains no
 * `await`, scanning through every rollback/error path rather than stopping at
 * the commit — those paths run *after* COMMIT in source order and are exactly
 * where a stray await would leave a transaction open.
 */
function assertNoAwaitInTransactionWindow(
  label: string,
  source: string,
  windowStart: number,
  windowEnd: number
): void {
  assert.ok(windowStart > 0, `${label}: expected an explicit BEGIN IMMEDIATE`);
  assert.ok(windowEnd > windowStart, `${label}: expected to find the end of the transaction window`);
  const body = source.slice(windowStart, windowEnd);
  assert.ok(
    body.includes('db.exec("BEGIN IMMEDIATE")'),
    `${label}: window must include BEGIN IMMEDIATE`
  );
  assert.ok(body.includes('db.exec("COMMIT")'), `${label}: scan window must include the commit`);
  assert.ok(
    body.includes('db.exec("ROLLBACK")'),
    `${label}: scan window must include the rollback paths`
  );
  assert.ok(
    !/\bawait\b/u.test(body),
    `${label}: no await may appear inside the transaction window: sign before the transaction`
  );
}

test("the substrate performs no write between BEGIN IMMEDIATE and COMMIT that could yield", () => {
  const source = sourceOf("durable-sqlite-substrate.ts");

  // Site 1: first-open provisioning inside `openDurableSqliteSubstrate`
  // This transaction is inline in the outer function, not a
  // further nested function, so its window is bounded by the unique comment
  // that immediately follows it rather than by an enclosing function
  // boundary.
  const provisioningBegin = source.indexOf('db.exec("BEGIN IMMEDIATE")');
  const provisioningEnd = source.indexOf(
    "// The durable identity is authoritative.",
    provisioningBegin
  );
  assertNoAwaitInTransactionWindow(
    "provisioning transaction",
    source,
    provisioningBegin,
    provisioningEnd
  );

  // Site 2: the per-write transaction inside the nested `write()` function.
  const writeBegin = source.indexOf('db.exec("BEGIN IMMEDIATE")', provisioningEnd);
  const functionStart = source.lastIndexOf("\n  function write(", writeBegin);
  assert.ok(functionStart > 0, "expected the write() function to enclose the transaction");
  const functionEnd = source.indexOf("\n  }\n", source.indexOf("throw error;", writeBegin));
  assert.ok(functionEnd > writeBegin, "expected to find the end of write()");
  assertNoAwaitInTransactionWindow("write() transaction", source, functionStart, functionEnd);

  // A third `BEGIN IMMEDIATE` site would need its own explicit scan added
  // above rather than silently passing unchecked.
  const thirdBegin = source.indexOf('db.exec("BEGIN IMMEDIATE")', functionEnd);
  assert.equal(thirdBegin, -1, "expected exactly two BEGIN IMMEDIATE transaction sites");
});
