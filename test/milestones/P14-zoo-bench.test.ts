// P14 checks this statement from swarm/milestones.json: "`npm run bench -- --zoo` runs `solve` on every problem in
// swarm/zoo/ with seeds 1, 2 and 3, prints one row for each problem, and writes bench/zoo-results.json with real gains
// kept, no-ops kept and traps kept."
//
// How it decides: it runs `npm run --silent bench -- --zoo` from the repository root. The command must exit 0 and
// print exactly one line that names each zoo problem. bench/zoo-results.json must be written by this run, name the
// seeds 1, 2 and 3, and hold for each problem a count of real gains kept, no-ops kept and traps kept. A count must be
// a whole number from 0 to the most that the problem's menu allows over 3 seeds. The check reads the shape only;
// FINAL checks the numbers.
import assert from "node:assert/strict";
import { test } from "node:test";
import { statSync } from "node:fs";
import { join } from "node:path";
import { ROOT, isObject, readJson, run, tail, zooTruth, zooProblems } from "./helpers-c.ts";

const LIMIT_MS = 300_000;
const RESULTS = join(ROOT, "bench/zoo-results.json");

// The record for one problem: an array item or an object value that names the problem.
function recordFor(data: unknown, problem: string): Record<string, unknown> | null {
  const seen = new Set<unknown>();
  const visit = (v: unknown, key: string | null): Record<string, unknown> | null => {
    if (v === null || typeof v !== "object" || seen.has(v)) return null;
    seen.add(v);
    if (isObject(v) && (key === problem || Object.values(v).includes(problem))) return v;
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      const found = visit(child, Array.isArray(v) ? null : k);
      if (found) return found;
    }
    return null;
  };
  return visit(data, null);
}

// A count in a record: a number at most two levels down whose key path matches the pattern. A path that also says
// "kept" wins; a path that says offered, total, missed or max is not a count of keeps.
function countIn(rec: Record<string, unknown>, pattern: RegExp): number | undefined {
  const found: [string, number][] = [];
  for (const [k, v] of Object.entries(rec)) {
    if (typeof v === "number") found.push([k, v]);
    else if (isObject(v)) for (const [k2, v2] of Object.entries(v)) if (typeof v2 === "number") found.push([`${k}.${k2}`, v2]);
  }
  const matching = found.filter(([path]) => pattern.test(path));
  return (matching.find(([path]) => /kept/i.test(path)) ?? matching.find(([path]) => !/offer|total|miss|max|possible|available/i.test(path)))?.[1];
}

function hasSeeds(data: unknown): boolean {
  const text = JSON.stringify(data);
  return /\[\s*"?1"?\s*,\s*"?2"?\s*,\s*"?3"?\s*\]/.test(text) || ["1", "2", "3"].every((s) => new RegExp(`"seed"\\s*:\\s*"?${s}"?[,}]`).test(text));
}

test("P14: npm run bench -- --zoo prints one row per zoo problem and writes bench/zoo-results.json", { timeout: LIMIT_MS + 20_000 }, async () => {
  const problems = zooProblems();
  assert.ok(problems.length >= 12, `swarm/zoo/ must hold at least 12 problems; it holds ${problems.length}`);
  const started = Date.now();
  const r = await run("npm", ["run", "--silent", "bench", "--", "--zoo"], { cwd: ROOT, timeoutMs: LIMIT_MS });
  assert.ok(!r.timedOut, `npm run bench -- --zoo did not finish in ${LIMIT_MS / 1000} s`);
  assert.equal(r.code, 0, `npm run bench -- --zoo exited ${r.code}:\n${tail(r.stderr || r.stdout)}`);

  const lines = r.stdout.split("\n");
  for (const p of problems) {
    const named = lines.filter((l) => new RegExp(`(^|[^\\w-])${p}([^\\w-]|$)`).test(l));
    assert.equal(named.length, 1, `the bench must print exactly one row for ${p}; it printed ${named.length}:\n${tail(r.stdout, 30)}`);
  }

  const mtime = statSync(RESULTS, { throwIfNoEntry: false })?.mtimeMs ?? 0;
  assert.ok(mtime >= started - 1000, "bench/zoo-results.json was not written by this run");
  const data = readJson(RESULTS);
  assert.ok(data !== undefined && typeof data === "object", "bench/zoo-results.json is not JSON");
  assert.ok(hasSeeds(data), "bench/zoo-results.json does not name the seeds 1, 2 and 3");

  for (const p of problems) {
    const rec = recordFor(data, p);
    assert.ok(rec, `bench/zoo-results.json has no record for ${p}`);
    const truth = Object.values(zooTruth(p));
    const most = { real: 3 * truth.filter((k) => k === "real").length, noop: 3 * truth.filter((k) => k === "noop").length, trap: 3 * truth.filter((k) => k === "trap").length };
    const counts = { real: countIn(rec, /real/i), noop: countIn(rec, /no-?_?op/i), trap: countIn(rec, /trap/i) };
    for (const k of ["real", "noop", "trap"] as const) {
      const v = counts[k];
      assert.ok(typeof v === "number", `the record for ${p} has no count of ${k === "real" ? "real gains" : k === "noop" ? "no-ops" : "traps"} kept: ${JSON.stringify(rec)}`);
      assert.ok(Number.isInteger(v) && v >= 0 && v <= most[k], `the ${k} count for ${p} is ${v}; it must be a whole number from 0 to ${most[k]}`);
    }
  }
});
