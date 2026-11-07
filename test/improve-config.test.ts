import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { improveFile, parseImproveConfig } from "../src/improve/config.ts";
import { config } from "./improve-helpers.ts";

const valid = config();

test("parseImproveConfig accepts a full config and rejects the common mistakes by name", () => {
  const ok = parseImproveConfig(JSON.stringify(valid));
  assert.equal(ok.metric.runs, 3);
  assert.deepEqual(ok, valid);
  for (const [patch, why] of [
    [{ version: 2 }, "version must be 1"],
    [{ metric: { ...valid.metric, direction: "up" } }, "metric.direction must be higher or lower"],
    [{ metric: { ...valid.metric, command: "" } }, "metric.command is required"],
    [{ mode: "manual" }, "mode must be auto or review"],
    [{ baseline: { ...valid.baseline, runs: [] } }, "baseline.runs must list at least one number"],
    [{ protect: ["/etc/passwd"] }, "protect paths must stay inside the repo"],
    [{ protect: ["src/../../x"] }, "protect paths must stay inside the repo"],
    [{ goal: " " }, "goal is required"],
    [{ guard: { command: "" } }, "guard.command must be a command or null"],
  ] as const) assert.throws(() => parseImproveConfig(JSON.stringify({ ...valid, ...patch })), new RegExp(`^Error: synthe improve config: ${why.replace(/\./g, "\\.")}`));
  assert.throws(() => parseImproveConfig("{"), /^Error: synthe improve config: not valid JSON/);
});

test("the config lives inside the git directory, where it is never tracked", () => {
  assert.equal(improveFile("/r/.git"), join("/r/.git", "synthe-improve.json"));
});
