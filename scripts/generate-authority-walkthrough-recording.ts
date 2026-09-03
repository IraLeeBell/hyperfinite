#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  renderAuthorityBoundaryDocument,
  runAuthorityBoundaryWalkthrough
} from "../src/authority-walkthrough.js";
import { renderAuthorityBoundaryGif } from "../src/authority-walkthrough-recording.js";

if (process.argv.length !== 2) {
  throw new TypeError(
    "usage: npm run demo:authority:recording"
  );
}

const result = await runAuthorityBoundaryWalkthrough();
const documentPath = path.resolve("docs/authority-boundary-walkthrough.md");
const recordingPath = path.resolve("docs/authority-boundary-walkthrough.gif");
await Promise.all([
  writeFile(documentPath, renderAuthorityBoundaryDocument(result), "utf8"),
  writeFile(recordingPath, renderAuthorityBoundaryGif(result))
]);
process.stdout.write(
  "Regenerated docs/authority-boundary-walkthrough.md and docs/authority-boundary-walkthrough.gif\n"
);
