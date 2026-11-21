// P11: when candidates is more than 1, the proposer gets that number, every proposal is measured, and the round keeps
// at most one: the best one that passes the decision rule.
// How it decides: the problem file asks for N candidates (the top-level "candidates" field), with N of 2, 3 and 4.
// The measure is noisy (seeded Gaussian noise, measure.runs 5) and logs which variant it measured. The proposer
// returns N proposals in one reply, in a seeded order: a large gain (10 noise standard deviations), a smaller gain
// that also passes any sound rule (4), a no-op and a loss. The check passes when the proposer's stdin says N, the
// measure saw every variant, and only the large gain is kept. A second case offers only losses: nothing is kept.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileOnBranch, keptAttempts, makeRepo, problemFile, pythonNoise, readProposerLog, rng, shuffled, solve, word, workDir, write, writeMenuProposer, type Proposal } from "./helpers-b.ts";

interface Variant { tag: string; gain: number; summary: string }

async function round(label: string, n: number, gains: number[]) {
  const r = rng(`P11-${label}-${process.pid}-${Date.now()}`);
  const work = workDir(`p11-${label}`);
  const counter = join(work, "noise");
  mkdirSync(counter);
  const measureLog = join(work, "measure.log");
  const sd = Number((0.3 + r() * 2.7).toFixed(3));
  const base = Number((50 + r() * 200).toFixed(2));
  const direction = r() < 0.5 ? "higher" : "lower";
  const sign = direction === "higher" ? 1 : -1;
  const tags = shuffled(r, ["oak", "ash", "elm", "fir", "yew", "box", "bay", "lime"]);
  const start = tags.pop()!;
  const variants: Variant[] = gains.map((gain, i) => ({ tag: tags[i], gain, summary: `use the ${tags[i]} blend` }));
  const table = Object.fromEntries([[start, 0], ...variants.map((v) => [v.tag, v.gain])]);
  const repo = makeRepo(join(work, "repo"), {
    "blend.json": `{\n  "blend": "${start}",\n  "note": "${word(r)}"\n}\n`,
    "measure/score.py": `import json\n${pythonNoise(counter, `${label}:${n}`)}\nimport os\ntag = json.load(open("blend.json"))["blend"]\nwith open(${JSON.stringify(measureLog)}, "a") as f:\n    f.write(tag + "\\n")\nTABLE = ${JSON.stringify(table)}\nprint("%.6f" % (${base} + ${sign} * ${sd} * TABLE.get(tag, -50) + ${sd} * gauss()))\n`,
  });
  const menu: Proposal[] = shuffled(r, variants).map((v) => ({ summary: v.summary, edits: [{ path: "blend.json", search: `"blend": "${start}"`, replace: `"blend": "${v.tag}"` }] }));
  write(work, "menu.json", JSON.stringify(menu));
  const proposerLog = join(work, "proposer.log");
  const proposer = writeMenuProposer(join(work, "propose.mjs"), join(work, "menu.json"), proposerLog, true);
  const file = problemFile(repo.dir, "problem.json", {
    name: `blend-${label}`, goal: `Make the blend score ${direction}.`,
    artifact: ["blend.json"], protect: ["measure/**"],
    measure: { command: "python3 measure/score.py", direction, unit: "points", runs: 5 },
    candidates: n,
    proposer: { command: `node ${JSON.stringify(proposer)}` },
    budget: { max_rounds: 3 },
  });
  repo.git("add", ".");
  repo.git("commit", "-qm", "Problem file");

  const { result } = await solve(file, join(work, "out"));
  const calls = readProposerLog(proposerLog);
  assert.ok(calls.length >= 1, "the proposer was called");
  assert.equal(calls[0].input.candidates, n, `the proposer's stdin asks for ${n} candidates`);
  const measured = new Set(readFileSync(measureLog, "utf8").split("\n").filter(Boolean));
  for (const v of variants) assert.ok(measured.has(v.tag), `the proposal "${v.summary}" was measured`);
  return { result, repo, variants };
}

test("with candidates of 2, 3 and 4, every proposal is measured and only the best one that passes is kept", async () => {
  const cases: [number, number[]][] = [[2, [4, 10]], [3, [4, 0, 10]], [4, [-3, 4, 0, 10]]];
  await Promise.all(cases.map(async ([n, gains]) => {
    const { result, repo, variants } = await round(`best${n}`, n, gains);
    const best = variants.find((v) => v.gain === 10)!;
    const kept = keptAttempts(result);
    assert.deepEqual(kept.map((a) => a.summary), [best.summary], `with ${n} candidates, only the best proposal is kept`);
    const blend = JSON.parse(fileOnBranch(repo, result, "blend.json")) as { blend: string };
    assert.equal(blend.blend, best.tag, "the branch holds the best proposal");
  }));
});

test("with candidates of 3 and only losses on offer, the round keeps nothing", async () => {
  const { result } = await round("losses", 3, [-2, -5, -8]);
  assert.deepEqual(keptAttempts(result).map((a) => a.summary), [], "no proposal is kept when none passes the decision rule");
});
