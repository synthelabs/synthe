// Lead ruling 3: a compare command gets the provider's key values only when the problem names a model. No other
// command (run, measure, guard, proposer) ever gets a SYNTHE_* value.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandCompare, compareKeyEnv, runCases } from "../src/solve/judge.ts";
import type { Problem } from "../src/solve/types.ts";

const ENV = { SYNTHE_ANTHROPIC_KEY: "sk-ant-a", SYNTHE_API_KEY: "sk-b", SYNTHE_ANTHROPIC_BASE_URL: "http://127.0.0.1:9", SYNTHE_OTHER: "x", PATH: process.env.PATH };
const problem = (model?: Problem["model"]) => ({ model } as Problem);

test("compareKeyEnv: nothing without a model; only the provider's key values with one", () => {
  assert.deepEqual(compareKeyEnv(problem(), ENV), {});
  assert.deepEqual(compareKeyEnv(problem({ provider: "anthropic", model: "m" }), ENV), { SYNTHE_ANTHROPIC_KEY: "sk-ant-a", SYNTHE_API_KEY: "sk-b", SYNTHE_ANTHROPIC_BASE_URL: "http://127.0.0.1:9" });
  assert.deepEqual(compareKeyEnv(problem({ provider: "openai-compatible", base_url: "https://x.example/v1", model: "m" }), ENV), { SYNTHE_API_KEY: "sk-b" });
});

// A script that reports which SYNTHE_* names it can see.
function seer(dir: string): string {
  writeFileSync(join(dir, "seer.cjs"), 'const seen = Object.keys(process.env).filter((k) => k.startsWith("SYNTHE_")).sort().join(",");\nlet raw = ""; process.stdin.on("data", (d) => { raw += d; }); process.stdin.on("end", () => { process.stderr.write(seen); console.log(JSON.stringify({ winner: seen ? "a" : "b", seen })); });\n');
  return "node seer.cjs";
}

test("the compare command gets the key values it is given; the run command gets none", async () => {
  const dir = mkdtempSync(join(tmpdir(), "synthe-compare-key-"));
  const cmd = seer(dir);
  const saved = { ...process.env };
  Object.assign(process.env, ENV);
  try {
    const withKey = commandCompare(dir, cmd, compareKeyEnv(problem({ provider: "openai-compatible", base_url: "https://x.example/v1", model: "m" }), process.env));
    assert.equal(await withKey({ id: "1", input: "i" }, "x", "y"), "a");
    const without = commandCompare(dir, cmd, compareKeyEnv(problem(), process.env));
    assert.equal(await without({ id: "1", input: "i" }, "x", "y"), "b");
    const outs = await runCases(dir, cmd, [{ id: "1", input: "i" }]);
    assert.ok(!("failed" in outs), JSON.stringify(outs));
    if (!("failed" in outs)) assert.match(outs["1"], /"seen":""/, "the run command sees no SYNTHE_* value");
  } finally {
    for (const k of Object.keys(ENV)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
