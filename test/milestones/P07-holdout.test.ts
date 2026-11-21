// P07: with split.holdout true, a change that wins on train only (it memorizes the train cases) is refused, a change
// that wins on both is kept, and the proposer never receives a holdout number.
// How it decides: a ticket router in a temp git repo. The measure reads SYNTHE_SPLIT and scores the train cases or the
// held-back cases. Train scores lie between 10 and 60. Holdout scores lie between 7000 and 8000 and move in steps of
// 113, so no other number in the run looks like one. The proposer offers both changes in a seeded order and logs
// every stdin object. The check passes when the memorizing change is refused, the general change is kept, the measure
// ran on both splits, and no proposer stdin holds a holdout score or a holdout step.
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileOnBranch, keptAttempts, makeRepo, problemFile, readProposerLog, rng, shuffled, solve, word, workDir, write, writeMenuProposer, type Proposal } from "./helpers-b.ts";

test("with split.holdout, a train-only win is refused, a win on both is kept, and the proposer sees no holdout number", async () => {
  const r = rng(`P07-${process.pid}-${Date.now()}`);
  const work = workDir("p07");
  const measureLog = join(work, "measure.log");
  const topic = word(r);
  const train = [
    ["I want a refund", "billing"], ["Refund my order please", "billing"],
    ["Where is my parcel", "shipping"], ["My parcel is late again", "shipping"],
    ["Hello there", "general"], ["A question about the shop", "general"],
    [`The ${topic} contract clause seven`, "legal"], ["Terms of the warranty deed", "legal"],
  ];
  const holdout = [
    ["Refund for a broken lamp", "billing"], ["Please refund the fee", "billing"],
    ["The parcel never came", "shipping"], ["Track my parcel", "shipping"],
    ["Good morning", "general"], ["Do you sell gift cards", "general"],
    ["A clause in the lease", "legal"], ["Read the deed for me", "legal"],
  ];
  const repo = makeRepo(join(work, "repo"), {
    "router/rules.json": `{\n  "keywords": [["refund", "billing"]],\n  "exact": {}\n}\n`,
    "router/route.js": "const { keywords, exact } = require(\"./rules.json\");\nmodule.exports = (text) => {\n  if (exact[text]) return exact[text];\n  const t = text.toLowerCase();\n  for (const [word, team] of keywords) if (t.includes(word)) return team;\n  return \"general\";\n};\n",
    "measure/train.json": JSON.stringify(train),
    "measure/holdout.json": JSON.stringify(holdout),
    "measure/score.js": `const fs = require("fs");
const route = require("../router/route.js");
const split = process.env.SYNTHE_SPLIT || "";
const right = (rows) => rows.filter(([t, team]) => route(t) === team).length;
fs.appendFileSync(${JSON.stringify(measureLog)}, JSON.stringify({ split, rules: fs.readFileSync("router/rules.json", "utf8") }) + "\\n");
const tr = require("./train.json"), ho = require("./holdout.json");
if (split === "train") console.log("score " + (10 + 5 * right(tr)));
else if (split === "holdout") console.log("score " + (7000 + 113 * right(ho)));
else console.log("score " + (3000 + 7 * right(tr.concat(ho))));
`,
  });
  const memorize: Proposal = { summary: "answer the two legal train tickets directly", edits: [{ path: "router/rules.json", search: `"exact": {}`, replace: `"exact": { ${JSON.stringify(train[6][0])}: "legal", ${JSON.stringify(train[7][0])}: "legal" }` }] };
  const general: Proposal = { summary: "send parcel questions to shipping", edits: [{ path: "router/rules.json", search: `[["refund", "billing"]]`, replace: `[["refund", "billing"], ["parcel", "shipping"]]` }] };
  write(work, "menu.json", JSON.stringify(shuffled(r, [memorize, general])));
  const proposerLog = join(work, "proposer.log");
  const proposer = writeMenuProposer(join(work, "propose.mjs"), join(work, "menu.json"), proposerLog, false);
  const file = problemFile(repo.dir, "router.json", {
    name: `router-${topic}`, goal: "Send more support tickets to the right team.",
    artifact: ["router/rules.json"], protect: ["measure/**"],
    measure: { command: "node measure/score.js", direction: "higher", unit: "tickets", runs: 1 },
    split: { holdout: true },
    proposer: { command: `node ${JSON.stringify(proposer)}` },
    budget: { max_rounds: 5 },
  });
  repo.git("add", ".");
  repo.git("commit", "-qm", "Problem file");
  appendFileSync(measureLog, "");

  const { result } = await solve(file, join(work, "out"));

  const byName = (p: Proposal) => result.attempts.find((a) => a.summary === p.summary);
  assert.ok(byName(memorize), "the memorizing change is an attempt in result.json");
  assert.equal(byName(memorize)?.kept, false, "a change that wins on train only is refused");
  assert.equal(byName(general)?.kept, true, "a change that wins on train and holdout is kept");
  assert.deepEqual(keptAttempts(result).map((a) => a.summary), [general.summary]);
  const rules = fileOnBranch(repo, result, "router/rules.json");
  assert.ok(rules.includes(`["parcel", "shipping"]`) && !rules.includes("warranty"), `the branch holds only the general change. Got:\n${rules}`);

  const runs = existsSync(measureLog) ? readFileSync(measureLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { split: string; rules: string }) : [];
  assert.ok(runs.some((m) => m.split === "train" && m.rules.includes("warranty")), "the memorizing change was measured with SYNTHE_SPLIT=train");
  assert.ok(runs.some((m) => m.split === "holdout"), "the measure ran with SYNTHE_SPLIT=holdout");

  const calls = readProposerLog(proposerLog);
  assert.ok(calls.length >= 2, "the proposer was called after the attempts");
  // Any holdout score is 7000 + 113k, and any holdout change is a multiple of 113.
  const holdoutLike = (x: number) => (x >= 7000 && x <= 8000) || (Number.isInteger(x) && x !== 0 && Math.abs(x) % 113 === 0);
  for (const c of calls) {
    const nums = [...c.raw.matchAll(/(?<![\w.])-?\d+(?:\.\d+)?(?![\w])/g)].map((m) => Number(m[0]));
    const leak = nums.filter(holdoutLike);
    assert.deepEqual(leak, [], `the proposer got a holdout number in round ${c.input.round}: ${leak.join(", ")}`);
  }
});
