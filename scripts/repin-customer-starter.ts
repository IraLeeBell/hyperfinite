#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";

import { canonicalJson, digest } from "../src/canonical.js";
import {
  CUSTOMER_STARTER_PROFILE_CATALOG,
  knownSelectionDocumentPathsFor
} from "../src/customer-starter-catalog.js";
import { createRepinnedCustomerStarterSelections } from "../src/customer-starter-authoring.js";
import { parseStrictJson } from "../src/strict-json.js";

if (process.argv.length !== 2) {
  throw new TypeError("customer:repin is optionless");
}

const root = realpathSync(
  execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8"
  }).trim()
);
const status = execFileSync(
  "git",
  ["status", "--porcelain=v1", "--untracked-files=all"],
  { cwd: root, encoding: "utf8" }
);
if (status !== "") {
  throw new TypeError("customer:repin requires a clean committed repository");
}
const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8"
}).trim();
if (!/^[0-9a-f]{40}$/u.test(headSha)) {
  throw new TypeError("customer:repin requires an exact Git head");
}

const corePath = path.join(
  root,
  "config/v1alpha1/customer-starter-selection.json"
);
const demoPath = path.join(
  root,
  "config/v1alpha1/customer-starter-demo-portfolio-selection.json"
);
const result = createRepinnedCustomerStarterSelections({
  root,
  headSha,
  coreSelection: parseStrictJson(readFileSync(corePath, "utf8")),
  demoSelection: parseStrictJson(readFileSync(demoPath, "utf8")),
  knownSelectionDocumentPaths: knownSelectionDocumentPathsFor(
    CUSTOMER_STARTER_PROFILE_CATALOG
  )
});

writeFileSync(corePath, `${JSON.stringify(result.core, null, 4)}\n`, "utf8");
writeFileSync(demoPath, `${JSON.stringify(result.demo, null, 4)}\n`, "utf8");
process.stdout.write(
  `${canonicalJson({
    sourceHeadSha: headSha,
    coreSelectionDigest: digest(result.core),
    coreResolvedClosureDigest: result.core.resolvedClosureDigest,
    demoSelectionDigest: digest(result.demo),
    demoResolvedClosureDigest: result.demo.resolvedClosureDigest
  })}\n`
);
