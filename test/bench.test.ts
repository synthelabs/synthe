import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkResults, runBench, runLive, type Results } from "../bench/bench.ts";
import { FIXTURES } from "../bench/improve/fixtures.ts";
import { runFixture } from "../bench/improve/run.ts";

// The full bench runs with `npm run bench`; these keep it working and honest without its runtime.
const env = (over: Record<string, string>) => {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("SYNTHE_") && k !== "ANTHROPIC_API_KEY" && k !== "NODE_TEST_CONTEXT") e[k] = v;
  return { ...e, ...over };
};
const bench = (args: string[], over: Record<string, string> = {}) => spawnSync(process.execPath, ["scripts/bench.ts", ...args], { encoding: "utf8", env: env(over), input: "" });

test("one prompt task for two rounds gives the same numbers twice with the same seed, through the real round", async () => {
  const run = () => runBench({ tasks: ["clean-judge"], rounds: 2, seeds: ["7"], improve: false });
  const first = await run();
  assert.deepEqual(await run(), first);
  const r = first.prompt[0];
  assert.equal(r.rounds, 2);
  assert.equal(r.qualityStart, 2);
  assert.ok(r.calls.writer === 4 && r.calls.runner > 0 && r.calls.judge > 0, JSON.stringify(r.calls));
  assert.equal(r.outcomes.length, 2);
});

test("an improve fixture keeps the real fix and refuses the change that games the metric", async () => {
  const r = await runFixture(FIXTURES.find((f) => f.name === "signup-count")!, "1");
  assert.deepEqual([r.start, r.end, r.realKept, r.falseKeeps, r.gamingKept], [3, 12, 1, 0, 0]);
});

test("--check fails on a doctored results file that raises false keeps, and passes on the baseline itself", () => {
  const base: Results = JSON.parse(readFileSync("bench/baseline.json", "utf8"));
  assert.deepEqual(checkResults(base, base), []);
  const doctored: Results = structuredClone(base);
  doctored.totals.prompt.falseKeeps += 1;
  assert.match(checkResults(doctored, base).join("\n"), /prompt mode kept \d+ neutral or trap edits, up from/);
  const file = join(mkdtempSync(join(tmpdir(), "synthe-bench-test-")), "doctored.json");
  writeFileSync(file, JSON.stringify(doctored));
  const failed = bench(["--check", "--results", file]);
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stdout, /Check failed against bench\/baseline\.json/);
  const passed = bench(["--check", "--results", "bench/baseline.json"]);
  assert.equal(passed.status, 0, passed.stdout + passed.stderr);
  const fewer: Results = structuredClone(base);
  fewer.totals.improve.realKept -= 2;
  assert.match(checkResults(fewer, base).join("\n"), /improve mode kept \d+ real fixes, down from/);
});

test("live mode refuses without SYNTHE_BENCH_LIVE=1, never reads ANTHROPIC_API_KEY, and needs the cost typed back", async () => {
  const off = bench(["--live"], { ANTHROPIC_API_KEY: "sk-ant-not-a-real-key" });
  assert.equal(off.status, 2);
  assert.match(off.stdout, /off unless SYNTHE_BENCH_LIVE=1 is set\. Nothing was run\./);
  const noKey = bench(["--live"], { SYNTHE_BENCH_LIVE: "1", ANTHROPIC_API_KEY: "sk-ant-not-a-real-key" });
  assert.equal(noKey.status, 2);
  assert.match(noKey.stdout, /needs SYNTHE_ANTHROPIC_KEY\. It never reads ANTHROPIC_API_KEY/);
  const said: string[] = [];
  const r = await runLive({ env: { SYNTHE_BENCH_LIVE: "1", SYNTHE_ANTHROPIC_KEY: "not-a-real-key" }, say: (t) => said.push(t), ask: async () => "yes" });
  assert.equal(r, null);
  assert.match(said.join("\n"), /Planned: about \d+ judge and checker calls/);
  assert.match(said.join("\n"), /Upper estimate: \$\d+\.\d\d/);
  assert.equal(said.at(-1), "That didn't match, so nothing was run.");
});
