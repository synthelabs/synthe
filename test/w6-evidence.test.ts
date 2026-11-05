import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { undo } from "../src/cli/undo.ts";
import { verify } from "../src/cli/verify.ts";
import { canonicalJson, evidencePath, hashEvidence, verifyEvidence, type EvidenceRecord } from "../src/core/evidence.ts";
import { sha256 } from "../src/core/safety.ts";
import { runDecide } from "../src/loop/decide.ts";
import { MemoryRepo, goal, scored } from "./helpers.ts";

// A repo folder with the goal and test cases the records were scored against: s0..s19 train, h0..h9 held back.
function project() {
  const root = mkdtempSync(join(tmpdir(), "synthe-w6-"));
  const g = goal();
  writeFileSync(join(root, "synthe.json"), JSON.stringify(g));
  const line = (id: string, split: string) => JSON.stringify({ id, input: "a question", expected: "a good answer", split });
  const ids = [...Array(20).keys()].map((i) => line(`s${i}`, "train")).concat([...Array(10).keys()].map((i) => line(`h${i}`, "holdout")));
  writeFileSync(join(root, "s.jsonl"), `${ids.join("\n")}\n`);
  mkdirSync(join(root, ".synthe/evidence"), { recursive: true });
  return root;
}

// Runs real rounds through decide, then copies what it saved to the folder, as a team would after checking out the state branch.
async function rounds(root: string, runs: [train: number, held: number, cand: number, candHeld: number][]) {
  const repo = new MemoryRepo("Old prompt.");
  let prompt = "Old prompt.";
  for (const [i, [train, held, cand, candHeld]] of runs.entries()) {
    const next = `Better prompt ${i}.`;
    await runDecide(goal(), repo, { candidates: [{ id: "c1", text: next }], scores: scored(prompt, train, held, cand, candHeld), costUsd: 0.1 });
    prompt = repo.files.get("prompt.md")!;
  }
  for (const [path, text] of repo.stateFiles) writeFileSync(join(root, path), text);
  return repo;
}

const read = (root: string, n: number): EvidenceRecord => JSON.parse(readFileSync(join(root, evidencePath(n)), "utf8"));
const write = (root: string, n: number, r: EvidenceRecord) => writeFileSync(join(root, evidencePath(n)), JSON.stringify(r, null, 2));
const check = (root: string, n: number) => verifyEvidence(join(root, evidencePath(n)), root);
// Fixes the hash after an edit, as a person covering their tracks would. The chain to the next round is left alone.
const rehash = (r: EvidenceRecord) => { r.sha256 = hashEvidence(r); return r; };

async function threeRounds() {
  const root = project();
  // merge, skip (a candidate no better), merge
  await rounds(root, [[50, 50, 60, 55], [60, 55, 60, 55], [60, 55, 80, 70]]);
  return root;
}

test("a good evidence file passes", async () => {
  const root = await threeRounds();
  assert.deepEqual([1, 2, 3].map((n) => read(root, n).verdict), ["merge", "skip", "merge"]);
  for (const n of [1, 2, 3]) assert.deepEqual(check(root, n).ok, true, JSON.stringify(check(root, n)));
  const lines: string[] = [];
  assert.equal(verify(join(root, evidencePath(3)), root, (l) => lines.push(l)), 0);
  assert.deepEqual(lines, ["Note: the prompt at the recorded commit wasn't checked: this record names no full commit id", "PASS"]);
});

test("a record holds hashes and ids, never prompt text or replies", async () => {
  const root = await threeRounds();
  const text = readFileSync(join(root, evidencePath(1)), "utf8");
  assert.doesNotMatch(text, /Old prompt|Better prompt|question|reply/i);
  const r = read(root, 1);
  assert.equal(r.promptHashBefore, sha256("Old prompt."));
  assert.equal(r.promptHashAfter, sha256("Better prompt 0."));
  assert.equal(r.prevEvidenceHash, null);
  assert.equal(read(root, 2).promptHashAfter, read(root, 2).promptHashBefore);
});

test("a score edited by hand fails", async () => {
  const root = await threeRounds();
  const r = read(root, 1);
  r.scenarioScores[0].candidateScore = 10;
  write(root, 1, r);
  const v = check(root, 1);
  assert.equal(v.ok, false);
  assert.match((v as { reason: string }).reason, /edited after it was written/);
});

test("a reason edited by hand fails", async () => {
  const root = await threeRounds();
  const r = read(root, 1);
  r.verdictReasons = ["it was a landslide"];
  write(root, 1, r);
  assert.match((check(root, 1) as { reason: string }).reason, /edited after it was written/);
});

test("a broken chain fails", async () => {
  const root = await threeRounds();
  const r = read(root, 3);
  r.prevEvidenceHash = sha256("something else");
  write(root, 3, rehash(r));
  assert.match((check(root, 3) as { reason: string }).reason, /chain is broken/);
});

test("a removed link in the chain fails, and so does a lost earlier record", async () => {
  const root = await threeRounds();
  const r = read(root, 3);
  r.prevEvidenceHash = null;
  write(root, 3, rehash(r));
  assert.match((check(root, 3) as { reason: string }).reason, /follows nothing/);
  const lone = project();
  writeFileSync(join(lone, evidencePath(3)), readFileSync(join(root, evidencePath(2)), "utf8").replace('"round": 2', '"round": 3'));
  const orphan = read(root, 2);
  orphan.round = 3;
  write(lone, 3, rehash(orphan));
  assert.match((check(lone, 3) as { reason: string }).reason, /no earlier round/);
});

test("rounds that failed leave a gap, and the chain still links the nearest earlier record", async () => {
  const root = project();
  const repo = new MemoryRepo("Old prompt.");
  await runDecide(goal(), repo, { candidates: [{ id: "c1", text: "Better prompt." }], scores: scored("Old prompt.", 50, 50, 60, 55), costUsd: 0.1 });
  await runDecide(goal(), repo, { candidates: null, scores: null, costUsd: 0.1 }); // round 2 fails: no record
  await runDecide(goal(), repo, { candidates: [{ id: "c1", text: "Even better." }], scores: scored("Better prompt.", 60, 55, 80, 70), costUsd: 0.1 });
  for (const [path, text] of repo.stateFiles) writeFileSync(join(root, path), text);
  assert.equal(read(root, 3).prevEvidenceHash, read(root, 1).sha256);
  assert.equal(check(root, 3).ok, true);
});

test("a verdict that the scores don't give fails, even with a correct hash", async () => {
  const root = await threeRounds();
  const r = read(root, 2); // a skip: the candidate was no better
  r.verdict = "merge";
  r.promptHashAfter = sha256("A prompt that never merged");
  write(root, 2, rehash(r));
  assert.match((check(root, 2) as { reason: string }).reason, /stored verdict is merge, but the recorded scores give skip/);
});

test("field order does not change the hash", async () => {
  const root = await threeRounds();
  const r = read(root, 1);
  const shuffled = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(r).reverse()))) as EvidenceRecord;
  shuffled.modelIds = Object.fromEntries(Object.entries(shuffled.modelIds).reverse()) as EvidenceRecord["modelIds"];
  shuffled.scenarioScores = shuffled.scenarioScores.map((s) => Object.fromEntries(Object.entries(s).reverse()) as typeof s);
  assert.notEqual(JSON.stringify(shuffled), JSON.stringify(r));
  assert.equal(hashEvidence(shuffled), hashEvidence(r));
  assert.equal(canonicalJson({ b: 1, a: { d: [{ y: 1, x: 2 }], c: 3 } }), '{"a":{"c":3,"d":[{"x":2,"y":1}]},"b":1}');
  // The hash is the same whatever the stored sha256 says, since it is blanked first.
  assert.equal(hashEvidence({ ...r, sha256: "junk" }), r.sha256);
});

test("an edited score with a regenerated hash is caught only when it changes the verdict", async () => {
  const root = await threeRounds();
  // Caught: wiping out the candidate's gains turns the merge into a skip, which the rerun notices.
  const flipped = read(root, 1);
  for (const s of flipped.scenarioScores) s.candidateScore = s.baselineScore;
  write(root, 1, rehash(flipped));
  assert.match((check(root, 1) as { reason: string }).reason, /stored verdict is merge, but the recorded scores give skip/);

  // Caught too: a small edit that keeps the merge still moves the judge's numbers quoted in the reasons.
  const nudged = read(root, 3);
  nudged.scenarioScores.find((s) => s.id === "h0")!.candidateScore = 0;
  write(root, 3, rehash(nudged));
  assert.match((check(root, 3) as { reason: string }).reason, /reasons don't match|stored verdict/);

  // Not caught: editing the field the rerun never reads, such as the cost, with the hash fixed. The limit of this check.
  const fresh = await threeRounds();
  const cost = read(fresh, 3);
  cost.costUsd = 0;
  write(fresh, 3, rehash(cost));
  assert.equal(check(fresh, 3).ok, true);
});

test("an edit to the previous record breaks the next one's chain", async () => {
  const root = await threeRounds();
  const r = read(root, 2);
  r.costUsd = 99;
  write(root, 2, rehash(r));
  assert.equal(check(root, 2).ok, true);
  assert.match((check(root, 3) as { reason: string }).reason, /chain is broken/);
});

test("a revert and a proposal record their own verdicts", async () => {
  const root = project();
  const repo = await rounds(root, [[50, 50, 60, 55]]);
  const proposeGoal = goal({ merge_rule: { ...goal().merge_rule, mode: "propose" } });
  await runDecide(proposeGoal, repo, { candidates: [{ id: "c1", text: "Proposed." }], scores: scored("Better prompt 0.", 60, 55, 80, 70), costUsd: 0.1 });
  for (const [path, text] of repo.stateFiles) writeFileSync(join(root, path), text);
  assert.equal(read(root, 2).verdict, "propose");
  assert.match(repo.prs[1].body, new RegExp(`Evidence: \`.synthe/evidence/round-2.json\` on the \`synthe/state\` branch, sha256 \`${read(root, 2).sha256}\``));
  assert.equal(check(root, 2).ok, true);
});

test("undo opens one pull request that puts back the earlier prompt", async () => {
  const root = project();
  const repo = await rounds(root, [[50, 50, 60, 55]]);
  const lines: string[] = [];
  const deps = { repo, goal: goal(), root, slug: "acme/app", history: async () => ["Better prompt 0.", "Old prompt."], say: (l: string) => lines.push(l) };
  const before = repo.prs.length;
  assert.equal(await undo(deps, "1"), 0);
  assert.equal(repo.prs.length, before + 1);
  assert.equal(repo.prs.at(-1)!.title, "Synthe: undo round 1");
  assert.equal(repo.commits.at(-1)!.content, "Old prompt.");
  // The undo isn't merged yet, so asking again finds it instead of opening a second one.
  assert.equal(await undo(deps, "1"), 0);
  assert.equal(repo.prs.length, before + 1);
  assert.match(lines.at(-1)!, /^A revert PR already exists/);
});

test("undo refuses what it can't do safely", async () => {
  const root = await threeRounds();
  const repo = new MemoryRepo("Better prompt 2."); // what three rounds leave live
  const lines: string[] = [];
  const deps = { repo, goal: goal(), root, slug: "acme/app", history: async () => ["Better prompt 1.", "Better prompt 0.", "Old prompt."], say: (l: string) => lines.push(l) };
  assert.equal(await undo(deps, "2"), 0); // a skip changed nothing
  assert.match(lines.pop()!, /didn't change your prompt/);
  assert.equal(await undo(deps, "1"), 1); // later rounds have changed the prompt since
  assert.match(lines.pop()!, /changed since round 1/);
  assert.equal(await undo(deps, "9"), 1);
  assert.match(lines.pop()!, /No evidence for round 9/);
  const r = read(root, 3);
  r.costUsd = 5;
  write(root, 3, r); // edited, hash not fixed
  assert.equal(await undo(deps, "3"), 1);
  assert.match(lines.pop()!, /doesn't match its hash/);
  assert.equal(repo.prs.length, 0);
});

test("edited guard and check numbers fail even with a regenerated hash", async () => {
  const root = await threeRounds();
  const g = read(root, 1);
  assert.equal(g.guardsAfter, 100);
  g.guardsAfter = 0;
  write(root, 1, rehash(g));
  assert.match((check(root, 1) as { reason: string }).reason, /guardsAfter doesn't match/);
  const c = read(root, 1);
  c.checksBefore = 42;
  write(root, 1, rehash(c));
  assert.equal(check(root, 1).ok, false);
});

test("an edited guardsBefore fails even with a regenerated hash", async () => {
  const root = await threeRounds();
  const r = read(root, 1);
  assert.equal(typeof r.guardsBefore, "number");
  r.guardsBefore = r.guardsBefore === 100 ? 0 : 100;
  write(root, 1, rehash(r));
  assert.match((check(root, 1) as { reason: string }).reason, /guardsBefore doesn't match/);
});

test("check rates are recomputed from the stored per-scenario counts", async () => {
  const { buildEvidence } = await import("../src/core/evidence.ts");
  const root = project();
  const g = goal({ checks: ["Asks first"] });
  const mk = (failed: number, applicable: number) => ({ failed, applicable });
  const scores = scored("Old prompt.", 50, 50, 60, 55);
  for (const r of [...scores.baselineTrain, ...scores.baselineHoldout]) Object.assign(r, mk(1, 2));
  for (const r of [...scores.candidates[0].train, ...scores.candidates[0].holdout!]) Object.assign(r, mk(0, 2));
  const { judgeRound } = await import("../src/core/merge-rule.ts");
  const verdict = judgeRound(scores, g, null);
  assert.equal(verdict.action, "merge");
  const rec = buildEvidence({ round: 1, goal: g, promptBefore: "Old prompt.", promptAfter: "Better prompt 0.", verdict: "merge", verdictReasons: [...verdict.reasons], scores, candidateId: "c1", costUsd: 0.1, prevEvidenceHash: null, checks: { before: 50, after: 100 } });
  write(root, 1, rec);
  assert.equal(verifyEvidence(join(root, evidencePath(1)), root).ok, true, JSON.stringify(verifyEvidence(join(root, evidencePath(1)), root)));
  rec.checksAfter = 90;
  write(root, 1, rehash(rec));
  assert.match((check(root, 1) as { reason: string }).reason, /checksAfter doesn't match/);
});

test("a record missing most of its scores fails, even with a regenerated hash", async () => {
  const root = await threeRounds();
  const r = read(root, 2);
  r.scenarioScores = r.scenarioScores.slice(0, 5);
  write(root, 2, rehash(r));
  assert.match((check(root, 2) as { reason: string }).reason, /no scores for scenario/);
});

test("a merge verdict under review mode contradicts itself", async () => {
  const root = await threeRounds();
  const r = read(root, 1);
  r.mergeMode = "propose";
  write(root, 1, rehash(r));
  assert.match((check(root, 1) as { reason: string }).reason, /review mode/);
});

test("a malformed record fails plainly instead of throwing", async () => {
  const root = await threeRounds();
  const r = read(root, 1);
  (r as { scenarioScores: unknown }).scenarioScores = [null];
  write(root, 1, rehash(r));
  assert.match((check(root, 1) as { reason: string }).reason, /isn't a Synthe evidence file/);
});

test("the prompt at the recorded commit is checked when the record names one", async () => {
  const { execFileSync } = await import("node:child_process");
  const root = project();
  writeFileSync(join(root, "prompt.md"), "Old prompt.");
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8" });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "start");
  const sha = git("rev-parse", "HEAD").trim();
  const fresh = await threeRounds();
  const r = read(fresh, 1);
  r.commit = sha;
  write(root, 1, rehash(r));
  const v = verifyEvidence(join(root, evidencePath(1)), root);
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.deepEqual((v as { notes: string[] }).notes, []);
  r.promptHashBefore = sha256("A different prompt.");
  write(root, 1, rehash(r));
  assert.match((check(root, 1) as { reason: string }).reason, /prompt at the recorded commit doesn't match/);
});
