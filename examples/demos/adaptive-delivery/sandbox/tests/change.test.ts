import assert from "node:assert/strict";
import test from "node:test";

import { boundedDeliverySummary } from "../src/change.ts";

test("summarizes only the accepted synthetic criteria", () => {
  assert.equal(
    boundedDeliverySummary(["HYBRID-001", "HYBRID-021"]),
    "HYBRID-001, HYBRID-021"
  );
});
