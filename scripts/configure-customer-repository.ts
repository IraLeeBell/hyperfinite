#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";

import { canonicalJson } from "../src/canonical.js";
import { renderCustomerCodeowners } from "../src/customer-repository-config.js";
import { githubRepositoryFromRemote } from "../src/release-support.js";

function argumentValue(name: string): string {
  const index = process.argv.indexOf(name);
  const value = process.argv[index + 1];
  if (index < 2 || value === undefined || value.startsWith("--")) {
    throw new TypeError(`${name} requires a value`);
  }
  return value;
}

if (
  process.argv.length !== 4 ||
  process.argv[2] !== "--codeowner"
) {
  throw new TypeError(
    "customer:configure requires exactly --codeowner @user or @organization/team"
  );
}

const root = realpathSync(
  execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8"
  }).trim()
);
const source = githubRepositoryFromRemote(
  execFileSync("git", ["remote", "get-url", "origin"], {
    cwd: root,
    encoding: "utf8"
  }).trim()
);
const codeowner = argumentValue("--codeowner");
const codeownersPath = path.join(root, ".github/CODEOWNERS");
const rendered = renderCustomerCodeowners({
  source: readFileSync(codeownersPath, "utf8"),
  codeowner,
  repository: source.repository
});
writeFileSync(codeownersPath, rendered, "utf8");
process.stdout.write(
  `${canonicalJson({
    server: source.server,
    repository: source.repository,
    codeowner,
    changedPath: ".github/CODEOWNERS"
  })}\n`
);
