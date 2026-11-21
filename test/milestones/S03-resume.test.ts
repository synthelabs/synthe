// S03 checks this statement from swarm/milestones.json: "After a solve run is killed mid-run, `solve --resume` keeps
// the recorded attempts and kept changes, does not repeat a finished round, and ends with the same kind of
// result.json; after a run that ended normally, --resume starts a new run and says so."
//
// How the check decides: the proposer has four changes: gain A, a loss, gain B, gain C. It sends the first one whose
// summary is not in its history, so it decides only from its stdin. The measure waits when it sees the level of
// gain B while a hold file exists, and tells the check. So the check kills the process group of `solve` with SIGKILL
// in the middle of round 3: rounds 1 and 2 are finished, and gain B is in the scratch checkout but is not decided.
// Then the check removes the hold file and runs three commands:
// 1. `solve --resume`: it must exit 0. The proposer is asked for rounds 3, 4 and 5 only, and the round 3 request
//    holds the history of rounds 1 and 2 and the file with gain A. result.json has rounds 1 to 4, each one time,
//    with gain A as the stopped run recorded it. The baseline is the first level, and the final score and the
//    branch hold gains A, B and C.
// 2. `solve --resume` again: the last run ended normally, so it must start a new run and say so. The proposer gets
//    round 1 with the four earlier attempts in the history.
// 3. A run that is never killed gets the same four changes: the resumed result.json must have the same fields.
// The working tree and the current branch must not change in any step.
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertTreeUnchanged, attempt, knobFixture, near, plainReason, randInt, readProposerLog, readResult, runCli, showFile,
  snapshot, startCli, tag, tail, tempDir, waitFor, type Proposal,
} from "./helpers-s.ts";

const SAYS_NEW_RUN = /\bnew\s+(solve\s+)?run\b|\bfresh\s+run\b|\bstart\w*\s+(a\s+|an\s+)?(new|fresh)\b|\bnothing\s+to\s+(resume|continue)\b|\bno\s+(\w+\s+){0,3}run\s+to\s+(resume|continue)\b/i;

function changes(level: number, t: string) {
  const [a, b, c] = [randInt(2, 6), randInt(2, 6), randInt(2, 6)];
  const gain = (n: string, from: number, to: number): Proposal => ({ summary: `gain ${n} ${t}`, edits: [{ path: "knob.txt", search: `level=${from}\n`, replace: `level=${to}\n` }] });
  const A = gain("A", level, level + a), B = gain("B", level + a, level + a + b), C = gain("C", level + a + b, level + a + b + c);
  const loss: Proposal = { summary: `loss ${t}`, edits: [{ path: "other.txt", search: "penalty=0", replace: `penalty=${randInt(1, 5)}` }] };
  return { A, loss, B, C, afterA: level + a, afterB: level + a + b, afterC: level + a + b + c };
}

test("S03: --resume continues a killed run, and starts a new run after a normal end", { timeout: 240_000 }, async () => {
  const t = tag(), level = randInt(10, 40), side = tempDir("s03-side");
  const hold = join(side, "hold"), ready = join(side, "ready");
  const ch = changes(level, t);
  // The measure waits only for the level of gain B, and only while the hold file exists.
  const wait = `if (/^level=${ch.afterB}$/m.test(knob) && fs.existsSync(${JSON.stringify(hold)})) {
  fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));
  while (fs.existsSync(${JSON.stringify(hold)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
}`;
  const f = knobFixture({ label: "s03", level, proposals: [ch.A, ch.loss, ch.B, ch.C], measureExtra: wait });
  const run = { cwd: f.repo.dir, home: f.repo.home };
  const before = snapshot(f.repo.dir);
  writeFileSync(hold, "");

  // The run that stops: killed while it measures gain B in round 3.
  const first = startCli(["solve", f.problemFile, "--out", f.out], { ...run, timeoutMs: 120_000 });
  await Promise.race([
    waitFor("the measure of round 3", () => existsSync(ready), 100_000),
    first.done.then((r) => assert.fail(`solve ended before round 3 (exit ${r.code}):\n${tail(r.out)}`)),
  ]);
  first.kill();
  const killed = await first.done;
  assert.equal(killed.signal, "SIGKILL", "the check killed the run");
  // The measure runs in its own process group, so it is stopped apart.
  try { process.kill(Number(readFileSync(ready, "utf8")), "SIGKILL"); } catch { /* already gone */ }
  rmSync(hold);
  const asked = readProposerLog(f.log);
  assert.deepEqual(asked.map((q) => q.round), [1, 2, 3], "before the kill, the proposer was asked for rounds 1, 2 and 3");
  assertTreeUnchanged(f.repo.dir, before);

  // 1. --resume continues the stopped run.
  const resumed = await runCli(["solve", f.problemFile, "--out", f.out, "--resume"], run);
  assert.equal(resumed.code, 0, `solve --resume exited ${resumed.code}:\n${tail(resumed.out)}`);
  const later = readProposerLog(f.log).slice(asked.length);
  assert.deepEqual(later.map((q) => q.round), [3, 4, 5], "after --resume the proposer is asked for rounds 3, 4 and 5: rounds 1 and 2 are finished and are not repeated");
  const history = later[0].history as { summary: string; kept: boolean; reason: string }[];
  assert.deepEqual(history.map((h) => [h.summary.includes(ch.A.summary), h.summary.includes(ch.loss.summary), h.kept]), [[true, false, true], [false, true, false]],
    `the round 3 request holds the history of rounds 1 and 2: ${JSON.stringify(history)}`);
  const knob = later[0].files.find((x: any) => x.path === "knob.txt")?.text;
  assert.match(String(knob), new RegExp(`^level=${ch.afterA}$`, "m"), "the round 3 request holds knob.txt with gain A, the kept change of the stopped run");

  const result = readResult(f.out, resumed);
  assert.equal(result.problem, f.name);
  assert.deepEqual(result.attempts.map((a: any) => a.round), [1, 2, 3, 4], `result.json holds rounds 1 to 4, each one time: ${JSON.stringify(result.attempts)}`);
  const [A, loss, B, C] = [ch.A, ch.loss, ch.B, ch.C].map((p) => attempt(result, p.summary));
  assert.deepEqual([A.round, loss.round, B.round, C.round], [1, 2, 3, 4]);
  assert.deepEqual([A.kept, loss.kept, B.kept, C.kept], [true, false, true, true]);
  near(A.before, level, "gain A's before, as the stopped run recorded it");
  near(A.after, ch.afterA, "gain A's after, as the stopped run recorded it");
  for (const a of result.attempts) plainReason(a.reason, `the reason of round ${a.round}`);
  near(result.baseline, level, "the baseline is the score before round 1");
  near(result.final, ch.afterC, "the final score holds gains A, B and C");
  plainReason(result.stopped, "the stop reason");
  assert.ok(typeof result.branch === "string" && result.branch.startsWith(`synthe/solve-${f.name}-`), `result.json names the branch of the kept changes: ${JSON.stringify(result.branch)}`);
  assert.match(showFile(f.repo.dir, result.branch, "knob.txt"), new RegExp(`^level=${ch.afterC}$`, "m"), "the branch holds gains A, B and C");
  assert.equal(showFile(f.repo.dir, result.branch, "other.txt"), "penalty=0\n", "the branch does not hold the refused loss");
  assert.ok(existsSync(join(f.out, "report.md")), "solve --resume wrote report.md");
  assertTreeUnchanged(f.repo.dir, before);

  // 2. The last run ended normally: --resume starts a new run and says so.
  const again = await runCli(["solve", f.problemFile, "--out", f.out, "--resume"], run);
  assert.equal(again.code, 0, `the second solve --resume exited ${again.code}:\n${tail(again.out)}`);
  assert.match(again.out, SAYS_NEW_RUN, `the output says that this is a new run:\n${tail(again.out)}`);
  assert.doesNotMatch(resumed.out, SAYS_NEW_RUN, `the output of the true resume does not say that it is a new run:\n${tail(resumed.out)}`);
  const fresh = readProposerLog(f.log).slice(asked.length + later.length);
  assert.ok(fresh.length >= 1 && fresh[0].round === 1, `the new run starts at round 1: ${JSON.stringify(fresh.map((q) => q.round))}`);
  for (const p of [ch.A, ch.loss, ch.B, ch.C]) {
    assert.ok(fresh[0].history.some((h: any) => String(h.summary).includes(p.summary)), `the new run's history holds "${p.summary}" from the resumed run`);
  }
  assert.deepEqual(readResult(f.out, again).attempts, [], "the proposer has nothing new, so the new run has no attempt");
  assert.match(showFile(f.repo.dir, result.branch, "knob.txt"), new RegExp(`^level=${ch.afterC}$`, "m"), "the branch of the resumed run still holds its kept changes");
  assertTreeUnchanged(f.repo.dir, before);

  // 3. The same kind of result.json as a run that was never killed.
  const plain = knobFixture({ label: "s03-plain", level, proposals: [ch.A, ch.loss, ch.B, ch.C] });
  const whole = await runCli(["solve", plain.problemFile, "--out", plain.out], { cwd: plain.repo.dir, home: plain.repo.home });
  assert.equal(whole.code, 0, tail(whole.out));
  const reference = readResult(plain.out, whole);
  const shape = (r: any) => ({ keys: Object.keys(r).sort(), attempts: r.attempts.map((a: any) => [a.round, a.kept, Object.keys(a).sort()]) });
  assert.deepEqual(shape(result), shape(reference), "the resumed run and a run that was never killed give result.json the same fields");
  near(result.final, reference.final, "the resumed run ends at the same score as a run that was never killed");
});
