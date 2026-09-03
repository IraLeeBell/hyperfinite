import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import test from "node:test";

import {
  renderAuthorityBoundaryDocument,
  renderAuthorityBoundaryRecordingFrames,
  renderAuthorityBoundaryTranscript,
  runAuthorityBoundaryWalkthrough
} from "../src/authority-walkthrough.js";
import {
  AUTHORITY_WALKTHROUGH_RECORDING_DURATION_MS,
  renderAuthorityBoundaryGif
} from "../src/authority-walkthrough-recording.js";
import { canonicalJson } from "../src/canonical.js";

test("walkthrough exercises the authority sequence with no live boundary", async () => {
  const startedAt = performance.now();
  const first = await runAuthorityBoundaryWalkthrough();
  const second = await runAuthorityBoundaryWalkthrough();
  const elapsedMs = performance.now() - startedAt;

  assert.deepEqual(first, second);
  assert.equal(canonicalJson(first), canonicalJson(second));
  assert.equal(
    renderAuthorityBoundaryTranscript(first),
    renderAuthorityBoundaryTranscript(second)
  );
  assert.deepEqual(
    first.steps.map((step) => step.id),
    [
      "target-free-schema",
      "runtime-disabled",
      "activation-missing",
      "trusted-route",
      "stale-head",
      "fresh-comment",
      "human-review"
    ]
  );
  assert.deepEqual(
    first.steps.map((step) => step.code),
    [
      "SCHEMA_INVALID",
      "activation.enabled",
      "ACTIVATION_REQUIRED",
      "activation.begin-framing",
      "CURRENT_HEAD_STALE",
      "applied",
      "HUMAN_REVIEW"
    ]
  );
  assert.deepEqual(
    first.steps.map((step) => step.effectCount),
    [0, 0, 0, 1, 0, 1, 0]
  );
  assert.equal(first.finalState, "HUMAN_REVIEW");
  assert.deepEqual(first.automation, {
    approve: "denied",
    continuation: "independent-human-only",
    merge: "absent"
  });
  assert.equal(first.readiness, "hermetic-repository-evidence-only");
  assert.equal(first.counters.modelCalls, 0);
  assert.equal(first.counters.networkCalls, 0);
  assert.equal(first.counters.credentialReads, 0);
  assert.equal(first.counters.liveEffects, 0);
  assert.equal(first.counters.fakeProviderEffects, 1);
  assert.equal(first.counters.trustedAdapterReads, 8);
  assert.equal(first.counters.syntheticBrokerInvocations, 2);
  assert.equal(first.counters.evidenceAppends, 3);
  assert.ok(elapsedMs < 5_000, `walkthrough took ${elapsedMs}ms`);
  assert.ok(Buffer.byteLength(canonicalJson(first), "utf8") < 16_384);
  assert.ok(
    Buffer.byteLength(renderAuthorityBoundaryTranscript(first), "utf8") < 8_192
  );
});

test("recording and accessible transcript are exact generated projections", async () => {
  const result = await runAuthorityBoundaryWalkthrough();
  const expectedDocument = renderAuthorityBoundaryDocument(result);
  const expectedGif = renderAuthorityBoundaryGif(result);
  const [document, gif] = await Promise.all([
    readFile("docs/authority-boundary-walkthrough.md", "utf8"),
    readFile("docs/authority-boundary-walkthrough.gif")
  ]);

  assert.equal(document, expectedDocument);
  assert.deepEqual(gif, expectedGif);
  assert.equal(gif.subarray(0, 6).toString("ascii"), "GIF89a");
  assert.equal(gif.at(-1), 0x3b);
  assert.ok(gif.byteLength < 512 * 1024);
  assert.equal(gif.includes(Buffer.from("NETSCAPE2.0", "ascii")), false);
  assert.ok(AUTHORITY_WALKTHROUGH_RECORDING_DURATION_MS <= 5_000);
  assert.equal(renderAuthorityBoundaryRecordingFrames(result).length, 9);
  assert.match(document, /Complete static transcript/u);
  assert.match(document, /not live deployment or readiness evidence/u);
});
