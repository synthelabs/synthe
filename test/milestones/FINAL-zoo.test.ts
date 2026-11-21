// FINAL checks this statement from swarm/milestones.json: "Across every zoo problem and seeds 1, 2 and 3, `solve`
// keeps at least 80% of the real gains, keeps no trap, and keeps no more than 1 no-op in total."
//
// How it decides: for each problem in swarm/zoo/ and each seed, the check copies the problem into a new git
// repository, writes noise.json (a seeded noise counter outside the repository), and runs
// `node src/cli/main.ts solve <problem.json> --seed N --out DIR` with a private home folder. For seed 2 the problem
// is in a subfolder of the repository, not at its root. The check reads result.json itself and classifies each kept
// attempt with the problem's truth.json. It trusts no bench output. A kept attempt that truth.json does not know
// counts as a trap. A kept attempt must also be on the branch that result.json names, so a report alone is not enough.
import assert from "node:assert/strict";
import { test } from "node:test";
import { availableParallelism } from "node:os";
import { writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  ZOO, attemptsOf, copyDir, git, gitRepo, isolatedEnv, pool, readJson, synthe, tail, tempDir, zooMenu, zooProblems, zooTruth,
  type Kind,
} from "./helpers-c.ts";

const SEEDS = [1, 2, 3];
const LIMIT_MS = 300_000;

interface Outcome { problem: string; seed: number; problemError?: string; kept: Record<Kind, string[]>; unknown: string[] }

async function solveOne(problem: string, seed: number, deadline: number): Promise<Outcome> {
  const outcome: Outcome = { problem, seed, kept: { real: [], noop: [], trap: [] }, unknown: [] };
  const work = tempDir(`final-${problem}-${seed}`);
  const repo = join(work, "repo");
  const folder = seed === 2 ? join(repo, "problems", problem) : repo;
  copyDir(join(ZOO, problem), folder);
  writeFileSync(join(folder, "noise.json"), JSON.stringify({ counter: join(work, "noise-counter"), seed: String(seed) }) + "\n");
  gitRepo(repo);
  const out = join(work, "out");
  const r = await synthe(["solve", join(folder, "problem.json"), "--seed", String(seed), "--out", out], {
    cwd: repo, env: isolatedEnv(join(work, "home")), timeoutMs: Math.max(5_000, deadline - Date.now()),
  });
  const result = readJson(join(out, "result.json"));
  const attempts = attemptsOf(result);
  if (typeof attempts === "string") {
    outcome.problemError = `${attempts} (exit ${r.code}${r.timedOut ? ", timed out" : ""})\n${tail(r.stderr || r.stdout, 6)}`;
    return outcome;
  }
  const truth = zooTruth(problem);
  const menu = new Map(zooMenu(problem).map((m) => [m.summary, m]));
  const branch = (result as { branch?: unknown }).branch;
  const prefix = relative(repo, folder);
  for (const a of attempts) {
    if (a.kept !== true) continue;
    const summary = String(a.summary);
    const kind = truth[summary];
    if (!kind) { outcome.unknown.push(summary); continue; }
    if (!outcome.kept[kind].includes(summary)) outcome.kept[kind].push(summary);
    // The kept change must be on the branch that result.json names.
    for (const e of menu.get(summary)!.edits) {
      let text: string | null = null;
      try { text = git(repo, "show", `${String(branch)}:${prefix ? `${prefix}/` : ""}${e.path}`); } catch { text = null; }
      const there = text !== null && (e.replace.trim() ? text.includes(e.replace.trim()) : !text.includes(e.search.trim()));
      if (!there) outcome.problemError = `result.json says "${summary}" was kept, but branch ${String(branch)} does not have that change in ${e.path}`;
    }
  }
  return outcome;
}

test("FINAL: solve keeps the zoo's real gains and refuses its no-ops and traps", { timeout: LIMIT_MS + 30_000 }, async () => {
  const problems = zooProblems();
  assert.ok(problems.length >= 12, `swarm/zoo/ must hold at least 12 problems; it holds ${problems.length}`);
  const deadline = Date.now() + LIMIT_MS;
  const jobs = problems.flatMap((p) => SEEDS.map((s) => [p, s] as const));
  const limit = Math.max(2, Math.min(6, availableParallelism()));
  const outcomes = await pool(jobs, limit, ([p, s]) => solveOne(p, s, deadline));

  let realOffered = 0, realKept = 0, noopKept = 0, trapKept = 0;
  const lines: string[] = [];
  for (const p of problems) {
    const truth = Object.values(zooTruth(p));
    const reals = truth.filter((k) => k === "real").length;
    const cells = SEEDS.map((s) => {
      const o = outcomes.find((x) => x.problem === p && x.seed === s)!;
      realOffered += reals;
      realKept += o.kept.real.length;
      noopKept += o.kept.noop.length;
      trapKept += o.kept.trap.length + o.unknown.length;
      return o.problemError ? `seed ${s}: ERROR` : `seed ${s}: real ${o.kept.real.length}/${reals} noop ${o.kept.noop.length} trap ${o.kept.trap.length + o.unknown.length}`;
    });
    lines.push(`${p.padEnd(16)} ${cells.join(" | ")}`);
  }
  const details: string[] = [];
  for (const o of outcomes) {
    if (o.problemError) details.push(`${o.problem} seed ${o.seed}: ${o.problemError}`);
    for (const t of o.kept.trap) details.push(`${o.problem} seed ${o.seed}: kept the trap "${t}"`);
    for (const t of o.kept.noop) details.push(`${o.problem} seed ${o.seed}: kept the no-op "${t}"`);
    for (const t of o.unknown) details.push(`${o.problem} seed ${o.seed}: kept "${t}", which is not on the problem's menu`);
  }
  const report = [
    ...lines,
    `real gains kept: ${realKept} of ${realOffered} (${realOffered ? ((100 * realKept) / realOffered).toFixed(1) : 0}%, needs 80%)`,
    `no-ops kept: ${noopKept} (at most 1)`, `traps kept: ${trapKept} (needs 0)`,
    ...details,
  ].join("\n");

  console.log(report);
  const errors = outcomes.filter((o) => o.problemError);
  assert.equal(errors.length, 0, `solve did not finish cleanly on every problem and seed:\n${report}`);
  assert.equal(trapKept, 0, `solve kept a trap:\n${report}`);
  assert.ok(noopKept <= 1, `solve kept more than 1 no-op:\n${report}`);
  assert.ok(realKept >= 0.8 * realOffered, `solve kept less than 80% of the real gains:\n${report}`);
});
