import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { sha256 } from "../src/core/safety.ts";
import { Refusal, githubRepo } from "../src/github/repo.ts";
import { runDecide } from "../src/loop/decide.ts";
import { MemoryRepo, goal, heldRows, scored, trainRows } from "./helpers.ts";

// --- repo.ts against a scripted GitHub: each request is answered from the queue for its "METHOD /path" ---
type Reply = { status: number; body?: unknown; headers?: Record<string, string> };
const queue = new Map<string, Reply[]>();
const seen: string[] = [];
const reply = (key: string, ...replies: Reply[]) => queue.set(key, replies);

const server = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    const key = `${req.method} ${new URL(req.url!, "http://x").pathname.replace("/repos/o/r", "")}`;
    seen.push(key);
    const r = queue.get(key)?.shift() ?? { status: 404, body: {} };
    for (const [k, v] of Object.entries(r.headers ?? {})) res.setHeader(k, v);
    res.statusCode = r.status;
    res.end(JSON.stringify(r.body ?? {}));
  });
});

let repo: ReturnType<typeof githubRepo>;
before(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  repo = githubRepo("o/r", "tok", `http://127.0.0.1:${(server.address() as any).port}`, async () => {});
});
after(() => server.close());

const refusal = async (p: Promise<unknown>) => p.then(() => null, (e) => e);

test("a refusal to open a pull request names the setting and where to turn it on", async () => {
  reply("POST /pulls", { status: 403, body: { message: "GitHub Actions is not permitted to create or approve pull requests." } });
  const e = await refusal(repo.openPr({ branch: "b", base: "main", title: "t", body: "b" }));
  assert.ok(e instanceof Refusal);
  assert.equal(e.problem, "permission");
  assert.match(e.plain, /Allow GitHub Actions to create and approve pull requests' at https:\/\/github\.com\/o\/r\/settings\/actions$/);
  reply("POST /pulls", { status: 401, body: { message: "Bad credentials" } });
  assert.equal((await refusal(repo.openPr({ branch: "b", base: "main", title: "t", body: "b" }))).problem, "token");
  reply("POST /pulls", { status: 201, body: { number: 12 } });
  assert.equal(await repo.openPr({ branch: "b", base: "main", title: "t", body: "b" }), 12);
});

test("other pull request failures stay ordinary errors, so a rate limit or a bad branch isn't called a setting", async () => {
  for (const r of [{ status: 403, body: { message: "You have exceeded a secondary rate limit" } }, { status: 422, body: { message: "No commits between main and b" } }, { status: 502 }]) {
    reply("POST /pulls", r);
    const e = await refusal(repo.openPr({ branch: "b", base: "main", title: "t", body: "b" }));
    assert.ok(e instanceof Error && !(e instanceof Refusal), String(r.status));
  }
});

test("Issues being off is told apart from a token that can't write issues", async () => {
  reply("POST /issues", { status: 410, body: { message: "Issues are disabled for this repo" } });
  const off = await refusal(repo.upsertIssue(null, "t", "b"));
  assert.ok(off instanceof Refusal);
  assert.equal(off.problem, "issues_off");
  assert.match(off.plain, /turn on Issues at https:\/\/github\.com\/o\/r\/settings$/);
  reply("POST /issues", { status: 403, body: { message: "Resource not accessible by integration" } });
  const noWrite = await refusal(repo.upsertIssue(null, "t", "b"));
  assert.equal(noWrite.problem, "permission");
  assert.match(noWrite.plain, /issues: write/);
  reply("POST /issues", { status: 500 });
  const down = await refusal(repo.upsertIssue(null, "t", "b"));
  assert.ok(down instanceof Error && !(down instanceof Refusal));
});

test("updating a report issue that is gone makes a new one, and still reports Issues being off", async () => {
  reply("PATCH /issues/3", { status: 410, body: { message: "This issue was deleted" } });
  reply("POST /issues", { status: 201, body: { number: 8 } });
  assert.equal(await repo.upsertIssue(3, "t", "b"), 8);
  reply("PATCH /issues/3", { status: 410, body: { message: "Issues are disabled for this repo" } });
  reply("POST /issues", { status: 410, body: { message: "Issues are disabled for this repo" } });
  assert.equal((await refusal(repo.upsertIssue(3, "t", "b"))).problem, "issues_off");
  reply("PATCH /issues/3", { status: 200 });
  assert.equal(await repo.upsertIssue(3, "t", "b"), 3);
});

test("after a server error on merge, the pull request itself says whether it merged", async () => {
  seen.length = 0;
  reply("PUT /pulls/7/merge", { status: 502, body: { message: "bad gateway" } });
  reply("GET /pulls/7", { status: 200, body: { merged: true } });
  assert.deepEqual(await repo.mergePr(7, "s"), { merged: true });
  assert.equal(seen.filter((k) => k === "PUT /pulls/7/merge").length, 1); // the merge itself is never repeated
  reply("PUT /pulls/7/merge", { status: 503, body: { message: "unavailable" } });
  reply("GET /pulls/7", { status: 200, body: { merged: false } });
  const r = await repo.mergePr(7, "s");
  assert.equal(r.merged, false);
  assert.equal(!r.merged && r.problem, "other");
});

test("if GitHub can't say either, the merge step stops so recovery checks the pull request next round", async () => {
  reply("PUT /pulls/7/merge", { status: 502 });
  reply("GET /pulls/7", { status: 502 }, { status: 502 }, { status: 502 });
  assert.match((await refusal(repo.mergePr(7, "s"))).message, /couldn't tell whether it merged/);
  // A client error is answered at once and needs no read-back.
  seen.length = 0;
  reply("PUT /pulls/7/merge", { status: 409 });
  const r = await repo.mergePr(7, "s");
  assert.equal(!r.merged && r.problem, "moved");
  assert.deepEqual(seen, ["PUT /pulls/7/merge"]);
});

// --- decide.ts ---
const candidates = [{ id: "c1", text: "Better prompt." }];
const win = () => ({ candidates, scores: scored("Old prompt.", 50, 50, 60, 55), costUsd: 0.1 });
const noWinner = () => ({ candidates, scores: scored("Old prompt.", 50, 50, 50, 50), costUsd: 0.1 });
const propose = () => goal({ merge_rule: { ...goal().merge_rule, mode: "propose" } });
const noPrs = () => new Refusal("permission", "GitHub Actions isn't allowed to open pull requests here; turn on 'Allow GitHub Actions to create and approve pull requests' at https://github.com/o/r/settings/actions", "403");
const issuesOff = () => new Refusal("issues_off", "Issues are turned off in this repo, so Synthe can't write its report; turn on Issues at https://github.com/o/r/settings", "410");

test("when Actions may not open pull requests the run stops with the fix, instead of crashing every round", async () => {
  const repo = new MemoryRepo("Old prompt.");
  repo.refuse.openPr = noPrs();
  const r = await runDecide(goal(), repo, win());
  assert.equal(r?.outcome, "skipped");
  assert.match(repo.state.stopped!, /Allow GitHub Actions to create and approve pull requests' at https:\/\/github\.com\/o\/r\/settings\/actions/);
  assert.match(r!.reasons.join(), /couldn't open a pull request/);
  assert.match(r!.plain!, /wouldn't let it open a pull request/);
  // Nothing is left behind and nothing needs recovering, so the next round doesn't retry or blame the key.
  assert.equal(repo.branches.size, 0);
  assert.equal(repo.prs.length, 0);
  assert.equal(repo.files.get("prompt.md"), "Old prompt.");
  assert.equal(repo.state.pending, null);
  assert.deepEqual(repo.state.rounds.map((x) => x.outcome), ["skipped"]);
  assert.match(repo.issue, /## Stopped: Synthe needs you to fix something\n\nGitHub Actions isn't allowed to open pull requests here/);
  assert.doesNotMatch(repo.issue, /key|credit/);
  assert.equal(await runDecide(goal(), repo, win()), null);
  assert.equal(repo.state.round, 1);
  assert.equal(repo.state.spendUsd, 0.1);
});

test("the same stop happens in review mode, and for an undo", async () => {
  const repo = new MemoryRepo("Old prompt.");
  repo.refuse.openPr = noPrs();
  assert.equal((await runDecide(propose(), repo, win()))?.outcome, "skipped");
  assert.equal(repo.state.proposal, null);
  assert.match(repo.state.stopped!, /Allow GitHub Actions/);
  assert.equal(repo.branches.size, 0);

  const undo = new MemoryRepo("Better prompt.");
  undo.state.lastMerge = { pr: 1, priorPrompt: "Old prompt.", mergedHash: sha256("Better prompt."), reverted: false };
  undo.refuse.openPr = noPrs();
  const slump = { ...scored("Better prompt.", 40, 40, 40, 40), prior: [...trainRows(100), ...heldRows(100)] };
  const r = await runDecide(goal(), undo, { candidates: [], scores: slump, costUsd: 0.1 });
  assert.equal(r?.outcome, "skipped");
  assert.match(undo.state.stopped!, /Allow GitHub Actions/);
  assert.equal(undo.state.lastMerge?.reverted, false);
  assert.equal(undo.branches.size, 0);
});

test("a pull request failure that isn't a refusal still crashes and recovers, as before", async () => {
  const repo = new MemoryRepo("Old prompt.");
  repo.crashOn = "openPr";
  await assert.rejects(runDecide(goal(), repo, win()), /crashed at openPr/);
  assert.equal(repo.state.stopped, null);
  const r = await runDecide(goal(), repo, win());
  assert.equal(r?.outcome, "merged");
  assert.equal(repo.state.rounds[0].outcome, "failed");
  assert.equal(repo.branches.size, 0);
});

test("with Issues off a merge still lands and the state is saved, with a note to turn Issues on", async () => {
  const repo = new MemoryRepo("Old prompt.");
  repo.refuse.upsertIssue = issuesOff();
  const r = await runDecide(goal(), repo, win());
  assert.equal(r?.outcome, "merged");
  assert.equal(repo.files.get("prompt.md"), "Better prompt.");
  assert.equal(repo.state.round, 1);
  assert.equal(repo.state.pending, null);
  assert.equal(repo.state.lastMerge?.mergedHash, sha256("Better prompt."));
  assert.equal(repo.state.rounds.length, 1);
  assert.equal(repo.state.issue, null);
  assert.equal(repo.state.stopped, null); // a merge without a report is still a better prompt, so the run carries on
  assert.ok(r!.reasons.some((x) => /turn on Issues at https:\/\/github\.com\/o\/r\/settings/.test(x)));
  // The next round works the same way and doesn't repeat itself within a record.
  const next = await runDecide(goal(), repo, { candidates: [{ id: "c1", text: "Better still." }], scores: scored("Better prompt.", 50, 50, 60, 55), costUsd: 0.1 });
  assert.equal(next?.round, 2);
  assert.equal(next?.outcome, "merged");
  assert.equal(next!.reasons.filter((x) => /Issues/.test(x)).length, 1);
});

test("with Issues off, a waiting proposal and a finished run still save their state", async () => {
  const repo = new MemoryRepo("Old prompt.");
  repo.refuse.upsertIssue = issuesOff();
  assert.equal((await runDecide(propose(), repo, win()))?.outcome, "proposed");
  assert.equal(repo.state.proposal?.pr, 1);
  assert.equal(await runDecide(propose(), repo, { candidates: null, scores: null, costUsd: null }), null);
  assert.equal(repo.state.proposal?.pr, 1);
  assert.ok(repo.state.rounds[0].reasons.some((x) => /Issues/.test(x)));

  const stalling = new MemoryRepo("Old prompt.");
  stalling.refuse.upsertIssue = issuesOff();
  for (let i = 0; i < 3; i++) await runDecide(goal(), stalling, noWinner());
  assert.match(stalling.state.stopped!, /no winner/);
  assert.equal(stalling.state.rounds.length, 3);
});

test("a decide step that died during a merge is recovered once the pull request is read back as merged", async () => {
  const repo = new MemoryRepo("Old prompt.");
  repo.crashOn = "mergePr"; // the merge went through, but the step died before it could tell
  await assert.rejects(runDecide(goal(), repo, win()));
  assert.equal(repo.files.get("prompt.md"), "Better prompt.");
  await runDecide(goal(), repo, { candidates, scores: scored("Better prompt.", 50, 50, 50, 50), costUsd: 0.1 });
  assert.equal(repo.state.rounds[0].outcome, "merged");
  assert.equal(repo.state.lastMerge?.priorPrompt, "Old prompt.");
  assert.equal(repo.state.pending, null);
  assert.equal(repo.branches.size, 0);
});

test("a refused pull request never leaves state.pending behind for recovery to misread", async () => {
  const repo = new MemoryRepo("Old prompt.");
  repo.refuse.openPr = noPrs();
  await runDecide(goal(), repo, win());
  assert.equal(repo.state.pending, null);
  // Even if the stop were lifted, a fresh round starts clean and lands normally.
  repo.state.stopped = null;
  repo.refuse = {};
  const r = await runDecide(goal(), repo, win());
  assert.equal(r?.round, 2);
  assert.equal(r?.outcome, "merged");
  assert.deepEqual(repo.state.rounds.map((x) => x.outcome), ["skipped", "merged"]);
});
