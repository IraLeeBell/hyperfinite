#!/usr/bin/env node

import process from "node:process";
import path from "node:path";

import { canonicalJson } from "../src/canonical.js";
import {
  buildReleaseBundle,
  verifyReleaseBundle
} from "../src/release.js";

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
    throw new TypeError("release command must be build or verify");
  }
  const valueFlags = new Set([
    "--base-sha",
    "--head-sha",
    "--output",
    "--version"
  ]);
  const known = new Set([
    ...valueFlags,
    ...(command === "verify" ? ["--require-trusted-attestation"] : [])
  ]);
  const positional: string[] = [];
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) continue;
    if (valueFlags.has(argument)) {
      index += 1;
      continue;
    }
    if (argument.startsWith("--") && !known.has(argument)) {
      throw new TypeError(`unknown release argument ${argument}`);
    }
    if (!argument.startsWith("--")) positional.push(argument);
  }
  if (positional.length > 0) {
    throw new TypeError("release command has an unexpected positional argument");
  }
  for (const flag of valueFlags) {
    if (args.filter((argument) => argument === flag).length !== 1) {
      throw new TypeError(`release command requires exactly one ${flag}`);
    }
  }
  if (
    command === "verify" &&
    args.filter((argument) => argument === "--require-trusted-attestation").length > 1
  ) {
    throw new TypeError("--require-trusted-attestation may appear only once");
  }
  const baseSha = value(args, "--base-sha");
  const headSha = value(args, "--head-sha");
  const outputRoot = path.resolve(value(args, "--output"));
  const packageVersion = value(args, "--version");
  const result =
    command === "build"
      ? buildReleaseBundle({
          repositoryRoot: process.cwd(),
          outputRoot,
          baseSha,
          headSha,
          packageVersion
        })
      : verifyReleaseBundle({
          repositoryRoot: process.cwd(),
          bundleRoot: outputRoot,
          baseSha,
          headSha,
          packageVersion,
          requireTrustedAttestation: args.includes("--require-trusted-attestation")
        });
  process.stdout.write(`${canonicalJson(result)}\n`);
}

main();
