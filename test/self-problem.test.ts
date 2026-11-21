import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { FALSE_KEEP_COST, scoreOf, type Results } from "../bench/bench.ts";

// synthe.self.json points Synthe at its own code. These keep it pointed at the right things without a full run.
const self = JSON.parse(readFileSync("synthe.self.json", "utf8"));

test("synthe.self.json changes src/ only, protects the measure, and guards with typecheck and tests", () => {
  assert.equal(self.version, 1);
  assert.match(self.name, /^[A-Za-z0-9-]+$/);
  assert.deepEqual(self.artifact, ["src/**"]);
  for (const p of ["bench/**", "test/**", "swarm/**", "spec/**"]) assert.ok(self.protect.includes(p), `protects ${p}`);
  assert.equal(self.measure.command, "npm run bench -- --score");
  assert.equal(self.measure.direction, "higher");
  assert.deepEqual(self.guards, ["npm run typecheck", "npm test"]);
});

test("the score rewards real gains and costs more for each false keep", () => {
  const base: Results = JSON.parse(readFileSync("bench/baseline.json", "utf8"));
  const t = base.totals;
  assert.equal(scoreOf(base), t.prompt.gainsKept + t.improve.realKept - FALSE_KEEP_COST * (t.prompt.falseKeeps + t.improve.falseKeeps));
  const tradeTrapForGain = structuredClone(base);
  tradeTrapForGain.totals.prompt.gainsKept += 1;
  tradeTrapForGain.totals.prompt.falseKeeps += 1;
  assert.ok(scoreOf(tradeTrapForGain) < scoreOf(base));
});

test("--score refuses other options instead of mixing output into the number", () => {
  const r = spawnSync(process.execPath, ["scripts/bench.ts", "--score", "--check"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /--score takes no other option/);
});
