import assert from "node:assert/strict";
import { test } from "node:test";
import { daysNeeded, unitsPerArm } from "../src/live/plan.ts";

test("plan: sample sizes match the design plan's table", () => {
  assert.equal(unitsPerArm(0.03, 0.10), 53208);
  assert.equal(unitsPerArm(0.03, 0.20), 13911);
  assert.equal(unitsPerArm(0.50, 0.05), 6272);
  assert.equal(unitsPerArm(0.05, -0.20), 6743);
  assert.equal(daysNeeded(13911, 2000, 0.5), 14);
});
