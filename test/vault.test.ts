import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseScenarios, type Scenario } from "../src/core/goal.ts";
import { evidencePath, verifyEvidence } from "../src/core/evidence.ts";
import { signP } from "../src/core/merge-rule.ts";
import { newState, type State } from "../src/core/state.ts";
import { runDecide } from "../src/loop/decide.ts";
import { renderReport } from "../src/loop/report.ts";
import { measureNoise, runScore } from "../src/loop/score.ts";
import { runVault } from "../src/loop/vault.ts";
import { runWrite } from "../src/loop/write.ts";
import { migrate } from "../src/cli/migrate.ts";
import { vault } from "../src/cli/vault.ts";
import type { Ask, Model } from "../src/model/client.ts";
import { MemoryRepo, goal, scenarios, scored } from "./helpers.ts";

const line = (id: string, split: string) => JSON.stringify({ id, input: `question ${id}`, expected: "good", split });
const five = ["t1", "t2", "t3", "t4", "t5"].map((id) => line(id, "train"));

test("parseScenarios accepts vault rows, keeps them optional, and still needs train and holdout", () => {
  const rows = parseScenarios([...five, line("h1", "holdout"), line("v1", "vault"), line("v2", "vault")].join("\n"));
  assert.deepEqual(rows.filter((r) => r.split === "vault").map((r) => r.id), ["v1", "v2"]);
  assert.equal(parseScenarios([...five, line("h1", "holdout")].join("\n")).length, 6);
  // Vault rows don't stand in for held-back ones, nor for training ones.
  assert.throws(() => parseScenarios([...five, line("v1", "vault")].join("\n")), /both train and holdout/);
  assert.throws(() => parseScenarios([...five.slice(1), line("h1", "holdout"), line("v1", "vault")].join("\n")), /at least 5 train/);
  assert.throws(() => parseScenarios([...five, line("h1", "holdout"), line("x", "secret")].join("\n")), /line 7 has a problem: "split" must be "train", "holdout" or "vault"/);
});

// Vault rows each carry a unique marker. The fake model records every call, and the marker must reach none of them,
// nor anything the round writes: the report, pull requests, state or evidence.
const vaultRows: Scenario[] = [1, 2, 3].map((n) => ({ id: `v${n}`, input: `VAULT-MARKER-${n} question`, expected: `VAULT-MARKER-${n} expected`, split: "vault" }));
const withVault: Scenario[] = [...scenarios.slice(0, 3), ...vaultRows, ...scenarios.slice(3)];

function recording(): Model & { seen: Ask[] } {
  const seen: Ask[] = [];
  return {
    seen,
    async ask(a) {
      seen.push(a);
      const schema = JSON.stringify(a.schema ?? {});
      if (schema.includes("guardrail_ok")) {
        const good = (tag: string) => a.user.includes(`<${tag}>\ngood reply`);
        const better = good("reply_a") === good("reply_b") ? "tie" : good("reply_a") ? "A" : "B";
        return { text: JSON.stringify({ better, a_guardrail_ok: true, b_guardrail_ok: true }), costUsd: 0.001 };
      }
      if (schema.includes('"results"')) {
        const n = (a.user.match(/^\d+\. /gm) ?? []).length;
        const pass = a.user.includes("<reply>\ngood reply");
        return { text: JSON.stringify({ results: Array.from({ length: n }, (_, i) => ({ check: i + 1, applies: true, passes: pass })) }), costUsd: 0.001 };
      }
      if (a.schema) return { text: JSON.stringify({ edits: [{ find: "Old", replace: "Improved." }], summary: "Says it better.", title: "say it better" }), costUsd: 0.01 };
      return { text: a.system === "Improved." ? "good reply" : "weak reply", costUsd: 0.001 };
    },
  };
}

test("no vault row reaches any model call or anything a round writes", async () => {
  const g = goal({ compose: true, checks: ["Answers the question"], counter_checks: ["Still answers fully"] });
  const m = recording();
  const repo = new MemoryRepo("Old");
  repo.files.set("s.jsonl", withVault.map((s) => JSON.stringify(s)).join("\n"));
  // Two rounds, so the second writer reads the first round's lessons from state.
  for (const _ of [1, 2]) {
    const state = await repo.readState();
    const prompt = repo.files.get("prompt.md")!;
    const w = await runWrite(g, state, prompt, withVault, m);
    const scored = await runScore(g, prompt, w.candidates, withVault, m);
    await runDecide(g, repo, { candidates: w.candidates, scores: scored.scores, costUsd: 0.1, caches: { attack: null, score: scored.scoreCache ?? null } });
  }
  await measureNoise(g, repo.files.get("prompt.md")!, withVault, m);
  assert.equal(repo.state.round, 2);
  assert.ok(repo.merges.length > 0, "the round should have merged, so the merge paths ran too");
  assert.ok(m.seen.length > 20);
  for (const a of m.seen) assert.doesNotMatch(`${a.system ?? ""}\n${a.user}`, /VAULT-MARKER/);
  const written = [repo.issue, JSON.stringify(repo.state), ...repo.prs.map((p) => `${p.title}\n${p.body}`), ...repo.stateFiles.values(), ...repo.commits.map((c) => c.content)];
  for (const text of written) assert.doesNotMatch(text, /VAULT-MARKER|"v[123]"/);
});

// The current prompt gives a good reply on v1 and v2, the start prompt on v3 and v4: wins 2, ties 1 (v3, both
// good), losses 1 (v4).
function vaultModel(failJudgeOn?: string): Model & { seen: Ask[] } {
  const seen: Ask[] = [];
  const goodFor: Record<string, string[]> = { New: ["v1", "v2", "v3"], Old: ["v3", "v4"] };
  return {
    seen,
    async ask(a) {
      seen.push(a);
      if (JSON.stringify(a.schema ?? {}).includes("guardrail_ok")) {
        if (failJudgeOn && a.user.includes(`case ${failJudgeOn}`)) return { text: "not json", costUsd: 0.002 };
        const good = (tag: string) => new RegExp(`<${tag}>\\ngood`).test(a.user);
        const better = good("reply_a") === good("reply_b") ? "tie" : good("reply_a") ? "A" : "B";
        return { text: JSON.stringify({ better, a_guardrail_ok: true, b_guardrail_ok: true }), costUsd: 0.002 };
      }
      const id = a.user.match(/case (\w+)/)![1];
      return { text: goodFor[a.system!]?.includes(id) ? `good reply to ${id}` : `weak reply to ${id}`, costUsd: 0.001 };
    },
  };
}
const vaultSet: Scenario[] = [
  ...["t1", "t2", "t3", "t4", "t5"].map((id): Scenario => ({ id, input: `case ${id}`, expected: "good", split: "train" })),
  { id: "h1", input: "case h1", expected: "good", split: "holdout" },
  ...["v1", "v2", "v3", "v4"].map((id): Scenario => ({ id, input: `case ${id}`, expected: "good", split: "vault" })),
];

test("runVault duels the current prompt against the start prompt on vault rows only", async () => {
  const m = vaultModel();
  const r = await runVault(goal(), "Old", "New", vaultSet, m, () => 0.3);
  assert.deepEqual({ wins: r.wins, losses: r.losses, ties: r.ties, unknown: r.unknown, cases: r.cases }, { wins: 2, losses: 1, ties: 1, unknown: 0, cases: 4 });
  assert.equal(r.p, signP(2, 1));
  // 4 replies from each prompt and 4 judge calls.
  assert.equal(m.seen.length, 12);
  assert.ok(Math.abs(r.costUsd! - (8 * 0.001 + 4 * 0.002)) < 1e-9);
  for (const a of m.seen) assert.doesNotMatch(a.user, /case [th]\d/);
});

test("runVault counts a case the judge couldn't settle as unknown, and spends nothing without vault rows", async () => {
  const r = await runVault(goal(), "Old", "New", vaultSet, vaultModel("v4"), () => 0.3);
  assert.deepEqual([r.wins, r.losses, r.ties, r.unknown], [2, 0, 1, 1]);
  const m = vaultModel();
  const none = await runVault(goal(), "Old", "New", vaultSet.filter((s) => s.split !== "vault"), m);
  assert.deepEqual([none.cases, none.costUsd, m.seen.length], [0, 0, 0]);
});

const result = (over: Partial<NonNullable<State["vault"]>> = {}) => ({ at: "2026-11-20T00:00:00Z", round: 2, wins: 7, losses: 2, ties: 3, unknown: 0, p: 0.09, cases: 12, costUsd: 0.4, ...over });
const merged = { round: 1, at: "2026-11-19T00:00:00Z", outcome: "merged" as const, reasons: [], costUsd: 0.1, pr: 1 };

test("the report shows the vault line only when a vault result is in the state", () => {
  const plain: State = { ...newState(), round: 2, rounds: [merged, { ...merged, round: 2, outcome: "declined", pr: undefined }] };
  assert.doesNotMatch(renderReport(goal(), plain), /Vault check/);
  const report = renderReport(goal(), { ...plain, vault: result() });
  assert.match(report, /Vault check \(cases no round ever saw\): better in 7, worse in 2, the same in 3\. That is your prompt after round 2 against the one the run started from, on 12 cases\./);
  assert.doesNotMatch(report, /may fit the held-back cases|Rounds ran after this check/);
});

test("the report says what to do when the vault disagrees with the held-back gains, or is out of date", () => {
  const state: State = { ...newState(), round: 3, rounds: [merged], vault: result({ wins: 2, losses: 5, ties: 5 }) };
  const report = renderReport(goal(), state);
  assert.match(report, /better in 2, worse in 5, the same in 5\./);
  assert.match(report, /The held-back cases improved but the vault got worse.*npx synthe undo N.*add fresh held-back cases/);
  assert.match(report, /Rounds ran after this check; run `npx synthe vault` again/);
  assert.match(renderReport(goal(), { ...state, vault: result({ wins: 0, losses: 0, ties: 12 }) }), /the vault shows no gain/);
  // No merged change and no held-back gain: nothing to disagree with.
  assert.doesNotMatch(renderReport(goal(), { ...state, rounds: [], vault: result({ wins: 2, losses: 5 }) }), /held-back cases improved/);
});

test("the first round saves the starting prompt; old state files without it still load and run", async () => {
  const repo = new MemoryRepo("Old");
  await runDecide(goal(), repo, { candidates: [], scores: null, costUsd: 0 });
  assert.equal(repo.state.startPrompt, "Old");
  // A state written before the field existed, mid-run: it loads, a round runs, and no wrong start is invented.
  const old = new MemoryRepo("Later");
  const { startPrompt: _s, vault: _v, ...legacy } = { ...newState(), round: 3 };
  old.state = JSON.parse(JSON.stringify(legacy)) as State;
  assert.equal("startPrompt" in old.state, false);
  await runDecide(goal(), old, { candidates: [], scores: null, costUsd: 0 });
  assert.equal(old.state.round, 4);
  assert.equal(old.state.startPrompt, undefined);
  assert.doesNotMatch(renderReport(goal(), old.state), /Vault check/);
});

// The CLI against a temp folder and a fake gh: it asks before spending, and saves the result to the state branch.
function cliFixture(state: Partial<State>) {
  const dir = mkdtempSync(join(tmpdir(), "synthe-vault-"));
  writeFileSync(join(dir, "synthe.json"), JSON.stringify(goal()));
  writeFileSync(join(dir, "prompt.md"), "New");
  writeFileSync(join(dir, "s.jsonl"), vaultSet.map((s) => JSON.stringify(s)).join("\n"));
  const stateFile = { sha: "abc", content: Buffer.from(JSON.stringify({ ...newState(), ...state })).toString("base64") };
  const calls: string[][] = [];
  const said: string[] = [];
  const model = vaultModel();
  const io = (answer: string) => ({
    cwd: dir, say: (t: string) => { said.push(t); }, ask: async () => answer, random: () => 0.3, now: () => new Date("2026-11-20T00:00:00Z"),
    credential: () => ({ model, line: "Credential: a test model." }),
    run: async (_cmd: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "repo") return "team/app\n";
      if (args.includes("PUT")) return "{}";
      return JSON.stringify(stateFile);
    },
  });
  return { dir, calls, said, model, io };
}

test("npx synthe vault asks first, and spends nothing on anything but yes", async () => {
  const f = cliFixture({ round: 4, startPrompt: "Old", rounds: [merged] });
  assert.equal(await vault(f.io("no"), []), 0);
  assert.equal(f.model.seen.length, 0);
  assert.match(f.said.join("\n"), /about 12 model calls, which cost money/);
  assert.match(f.said.at(-1)!, /Nothing was spent/);
  assert.ok(!f.calls.some((a) => a.includes("PUT")));
});

test("npx synthe vault prints the result and saves it to the state", async () => {
  const f = cliFixture({ round: 4, startPrompt: "Old", rounds: [merged] });
  assert.equal(await vault(f.io("yes"), []), 0);
  assert.equal(f.model.seen.length, 12);
  assert.match(f.said.join("\n"), /better in 2, worse in 1, the same in 1\. That is your prompt after round 4/);
  const put = f.calls.find((a) => a.includes("PUT"))!;
  assert.ok(put.includes("sha=abc") && put.includes("branch=synthe/state"));
  const saved = JSON.parse(Buffer.from(put.find((a) => a.startsWith("content="))!.slice(8), "base64").toString("utf8")) as State;
  assert.deepEqual(saved.vault, { at: "2026-11-20T00:00:00.000Z", round: 4, wins: 2, losses: 1, ties: 1, unknown: 0, p: signP(2, 1), cases: 4, costUsd: saved.vault!.costUsd });
  assert.equal(saved.round, 4);
});

test("npx synthe vault asks for the starting prompt when an old state has none, and uses --start", async () => {
  const f = cliFixture({ round: 4 });
  assert.equal(await vault(f.io("yes"), []), 1);
  assert.match(f.said.at(-1)!, /npx synthe vault --start <file>/);
  assert.equal(f.model.seen.length, 0);
  writeFileSync(join(f.dir, "start.md"), "Old");
  assert.equal(await vault(f.io("yes"), ["--start", "start.md", "--yes"]), 0);
  assert.equal(f.model.seen.length, 12);
});

test("npx synthe verify still passes a round's evidence when the test cases include vault rows", async () => {
  const root = mkdtempSync(join(tmpdir(), "synthe-vault-evidence-"));
  writeFileSync(join(root, "synthe.json"), JSON.stringify(goal()));
  const ids = [...Array(20).keys()].map((i) => line(`s${i}`, "train")).concat([...Array(10).keys()].map((i) => line(`h${i}`, "holdout")), [line("v1", "vault")]);
  writeFileSync(join(root, "s.jsonl"), `${ids.join("\n")}\n`);
  mkdirSync(join(root, ".synthe/evidence"), { recursive: true });
  const repo = new MemoryRepo("Old prompt.");
  await runDecide(goal(), repo, { candidates: [{ id: "c1", text: "Better prompt." }], scores: scored("Old prompt.", 50, 50, 60, 55), costUsd: 0.1 });
  for (const [path, text] of repo.stateFiles) writeFileSync(join(root, path), text);
  const v = verifyEvidence(join(root, evidencePath(1)), root);
  assert.equal(v.ok, true, JSON.stringify(v));
});

test("npx synthe migrate leaves vault rows out of its model calls and its counts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "synthe-vault-migrate-"));
  writeFileSync(join(dir, "synthe.json"), JSON.stringify(goal()));
  writeFileSync(join(dir, "prompt.md"), "Old");
  writeFileSync(join(dir, "s.jsonl"), withVault.map((s) => JSON.stringify(s)).join("\n"));
  const m = recording();
  const said: string[] = [];
  await migrate(["--to", "claude-sonnet-5-5", "--from", "claude-haiku-5-5"], { cwd: dir, say: (t) => said.push(t), model: m, random: () => 0.9 });
  assert.ok(m.seen.length > 0);
  for (const a of m.seen) assert.doesNotMatch(a.user, /VAULT-MARKER/);
  assert.match(said.join("\n"), /Scenarios: 6 train \+ 4 holdout = 10 total/);
});
