#!/usr/bin/env node

import process from "node:process";
import path from "node:path";

import { canonicalJson } from "../src/canonical.js";
import { buildCustomerStarterBundle, verifyCustomerStarterBundle } from "../src/customer-starter.js";

// This CLI intentionally imports nothing from src/customer-starter-
// catalog.ts and passes no profileCatalog, denylist, or advertisedScripts
// value to either build/verify function: buildCustomerStarterBundle and
// verifyCustomerStarterBundle always resolve the fixed, reviewed
// CUSTOMER_STARTER_PROFILE_CATALOG internally, and there is no parameter
// here through which this CLI (or any other production caller) could
// substitute an alternate catalog, selection, denylist, or script list.
// The set of valid --profile values is therefore not locally known to
// this file at all; an unknown profileId is rejected by the engine
// itself (findProfileCatalogEntry), which is exercised directly by
// scripts/validate-customer-starter-extraction.ts (which imports
// CUSTOMER_STARTER_PROFILE_CATALOG itself, read-only, purely to discover
// which profileIds and advertisedScripts exist for its own clean-
// extraction evidence -- it never passes a catalog to this engine
// either).

function value(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const result = index === -1 ? undefined : args[index + 1];
  if (result === undefined || result.startsWith("--")) {
    throw new TypeError(`${name} is required`);
  }
  return result;
}

function main(): void {
  const args = process.argv.slice(2);
  const command = args[0];
  if (command !== "build" && command !== "verify") {
    throw new TypeError("customer-starter command must be build or verify");
  }
  const valueFlags = new Set(["--base-sha", "--head-sha", "--output", "--version", "--profile"]);
  const positional: string[] = [];
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) continue;
    if (valueFlags.has(argument)) {
      index += 1;
      continue;
    }
    if (argument.startsWith("--")) {
      throw new TypeError(`unknown customer-starter argument ${argument}`);
    }
    positional.push(argument);
  }
  if (positional.length > 0) {
    throw new TypeError("customer-starter command has an unexpected positional argument");
  }
  for (const flag of valueFlags) {
    if (args.filter((argument) => argument === flag).length !== 1) {
      throw new TypeError(`customer-starter command requires exactly one ${flag}`);
    }
  }
  const baseSha = value(args, "--base-sha");
  const headSha = value(args, "--head-sha");
  const outputRoot = path.resolve(value(args, "--output"));
  const packageVersion = value(args, "--version");
  const profileId = value(args, "--profile");

  const result =
    command === "build"
      ? buildCustomerStarterBundle({
          repositoryRoot: process.cwd(),
          outputRoot,
          baseSha,
          headSha,
          packageVersion,
          profileId
        })
      : verifyCustomerStarterBundle({
          repositoryRoot: process.cwd(),
          bundleRoot: outputRoot,
          baseSha,
          headSha,
          packageVersion,
          profileId
        });
  process.stdout.write(`${canonicalJson(result)}\n`);
}

// Guarded so this module can also be imported without re-running the CLI
// as a side effect of import. Compares raw filesystem paths
// (import.meta.filename, not an encoded import.meta.url) against a
// resolved process.argv[1], so a checkout path containing spaces, "#",
// "?", "%", or non-ASCII characters -- which would silently
// desynchronize a `file://${...}` string comparison -- still matches
// correctly. If the entry script's own basename matches but the resolved
// path does not (e.g. a symlink), fail loudly instead of silently no-
// oping, since a silent no-op here would report false success for
// `npm run starter:local`.
const invokedPath = process.argv[1];
const resolvedInvokedPath = invokedPath === undefined ? undefined : path.resolve(invokedPath);
if (resolvedInvokedPath === import.meta.filename) {
  main();
} else if (
  resolvedInvokedPath !== undefined &&
  path.basename(resolvedInvokedPath) === path.basename(import.meta.filename)
) {
  throw new TypeError(
    `customer-starter-local entrypoint guard could not confirm direct invocation despite a matching basename (${resolvedInvokedPath} vs ${import.meta.filename}); refusing to silently no-op`
  );
}
