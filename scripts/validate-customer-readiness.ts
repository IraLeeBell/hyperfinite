#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  lstatSync,
  readFileSync,
  realpathSync
} from "node:fs";
import path from "node:path";

import {
  auditCustomerShareability,
  type CustomerShareabilityFile
} from "../src/customer-readiness.js";
import { codeownersUseRepositoryOwner } from "../src/customer-repository-config.js";
import { githubRepositoryFromRemote } from "../src/release-support.js";

const root = realpathSync(
  execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8"
  }).trim()
);
const listed = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  { cwd: root }
).toString("utf8");
const decoder = new TextDecoder("utf-8", { fatal: true });
const files: CustomerShareabilityFile[] = [];
const source = githubRepositoryFromRemote(
  execFileSync("git", ["remote", "get-url", "origin"], {
    cwd: root,
    encoding: "utf8"
  }).trim()
);

for (const relativePath of [...new Set(listed.split("\0").filter(Boolean))].sort()) {
  const absolutePath = path.join(root, relativePath);
  let status;
  try {
    status = lstatSync(absolutePath);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      continue;
    }
    throw error;
  }
  if (!status.isFile()) {
    throw new TypeError(
      `customer shareability audit refuses non-regular file ${relativePath}`
    );
  }
  let content: string;
  try {
    content = decoder.decode(readFileSync(absolutePath));
  } catch {
    throw new TypeError(
      `customer shareability audit requires UTF-8 text at ${relativePath}`
    );
  }
  files.push({ path: relativePath, content });
}

const findings = auditCustomerShareability(files, {
  allowSourceCodeowner:
    (source.server === "github.com" &&
      source.repository === ["github", "hyperfinite"].join("/")) ||
    codeownersUseRepositoryOwner({
      source:
        files.find((file) => file.path === ".github/CODEOWNERS")?.content ?? "",
      repository: source.repository
    })
});
if (findings.length > 0) {
  for (const finding of findings) {
    process.stderr.write(
      `${finding.path}:${finding.line}: ${finding.ruleId}: ${finding.reason}\n`
    );
  }
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Validated ${files.length} files for customer sharing.\n`
  );
}
