#!/usr/bin/env node

import process from "node:process";

import {
  renderAuthorityBoundaryTranscript,
  runAuthorityBoundaryWalkthrough
} from "../src/authority-walkthrough.js";
import { canonicalJson } from "../src/canonical.js";

function outputFormat(arguments_: readonly string[]): "json" | "transcript" {
  if (arguments_.length === 0) return "transcript";
  if (arguments_.length === 1 && arguments_[0] === "--format=json") return "json";
  if (
    arguments_.length === 2 &&
    arguments_[0] === "--format" &&
    arguments_[1] === "json"
  ) {
    return "json";
  }
  throw new TypeError(
    "usage: npm run demo:authority [-- --format=json]"
  );
}

const format = outputFormat(process.argv.slice(2));
const result = await runAuthorityBoundaryWalkthrough();
process.stdout.write(
  format === "json"
    ? `${canonicalJson(result)}\n`
    : renderAuthorityBoundaryTranscript(result)
);
