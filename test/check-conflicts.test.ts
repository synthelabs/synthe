import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agentOptions } from "../src/cli/agent.ts";
import { AGENT_NEXT, DRAFT_FILE, findCheckConflicts, init, type Io } from "../src/cli/init.ts";
import { DEFAULTS, parseGoal } from "../src/core/goal.ts";
import type { Ask, Model } from "../src/model/client.ts";

// The checks from the live Antigravity test: on a message missing a value, a reply that asks makes no tool call.
const LIVE = [
  "The reply makes exactly one tool call with every required field filled",
  "Names the site's zoning district in the first sentence",
  "When the user omits a needed value, the reply asks a clarifying question instead of guessing",
];
const CONFLICT = { conflicts: [{ first: 3, second: 1, why: "A reply that asks a clarifying question makes no tool call." }] };

const fixed = (value: unknown): Model & { asks: Ask[] } => {
  const asks: Ask[] = [];
  return { asks, async ask(a) { asks.push(a); return { text: typeof value === "string" ? value : JSON.stringify(value), costUsd: 0.001 }; } };
};

test("conflicting pairs come back once each, 0-based and in order, with the reason", async () => {
  const model = fixed({ conflicts: [
    { first: 3, second: 1, why: " A reply that asks makes no tool call. " },
    { first: 1, second: 3, why: "the same pair again" },
  ] });
  assert.deepEqual(await findCheckConflicts(model, "Site-planning helper.", LIVE), [{ first: 0, second: 2, why: "A reply that asks makes no tool call." }]);
  assert.equal(model.asks.length, 1);
  assert.equal(model.asks[0].model, DEFAULTS.models.writer);
  assert.match(model.asks[0].user, /Could a single reply pass every check\?/);
  assert.match(model.asks[0].user, /What the agent is for: Site-planning helper\./);
  LIVE.forEach((c, i) => assert.ok(model.asks[0].user.includes(`${i + 1}. ${c}`), `the request numbers check ${i + 1}`));
});

test("pairs the model gets wrong are dropped instead of pointing at the wrong check", async () => {
  const model = fixed({ conflicts: [
    { first: 0, second: 1, why: "zero isn't a check" },
    { first: 1, second: 4, why: "there is no check 4" },
    { first: 2, second: 2, why: "a check can't conflict with itself" },
    { first: 1.5, second: 2, why: "not a whole number" },
    { first: "1", second: 2, why: "a string" },
    { first: 1, second: 2, why: "  " },
    null,
    { first: 2, second: 3, why: "kept" },
  ] });
  assert.deepEqual(await findCheckConflicts(model, "", LIVE), [{ first: 1, second: 2, why: "kept" }]);
});

test("no conflicts, an unusable answer or a failed call all mean no conflicts, and fewer than two checks cost nothing", async () => {
  for (const model of [fixed({ conflicts: [] }), fixed("not json"), fixed({ conflicts: "1 and 3" }), fixed({}),
    { ask: async () => ({ text: null, costUsd: 0 }) }, { ask: async () => { throw new Error("529 overloaded"); } }] as Model[]) {
    assert.deepEqual(await findCheckConflicts(model, "", LIVE), []);
  }
  const unused = fixed(CONFLICT);
  assert.deepEqual(await findCheckConflicts(unused, "", [LIVE[0]]), []);
  assert.deepEqual(await findCheckConflicts(unused, "", []), []);
  assert.equal(unused.asks.length, 0);
});

// --- init ---

const repoDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "synthe-conflicts-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "prompt.md"), "You help architects plan building sites.");
  execFileSync("git", ["add", "prompt.md"], { cwd: dir });
  return dir;
};

const scenarioReply = JSON.stringify({
  guardrails: ["Never invent a zoning rule"], policy: "", brief: "Site-planning helper for architects.", checks: LIVE,
  scenarios: Array.from({ length: 40 }, (_, i) => ({ input: `q${i}`, expected: `a${i}` })),
});

function setup(answers: Record<string, string> = {}, conflictsReply: () => unknown = () => CONFLICT) {
  const dir = repoDir();
  const said: string[] = [];
  const asked: string[] = [];
  const conflictAsks: Ask[] = [];
  const model: Model = {
    async ask(a) {
      const schema = JSON.stringify(a.schema ?? {});
      if (schema.includes('"conflicts"')) { conflictAsks.push(a); const v = conflictsReply(); return { text: typeof v === "string" ? v : JSON.stringify(v), costUsd: 0.001 }; }
      if (schema.includes('"scenarios"')) return { text: scenarioReply, costUsd: 0.01 };
      if (schema.includes('"results"')) return { text: JSON.stringify({ results: [1, 2, 3].map((check) => ({ check, applies: true, passes: true })) }), costUsd: 0.001 };
      return { text: "A reply.", costUsd: 0.001 };
    },
  };
  const io: Io = {
    say: (t) => said.push(t),
    ask: async (q) => {
      asked.push(q);
      return Object.entries({ "automatically?": "y", "Real message": "", "Use these checks": "y", "experimental guards": "n", ...answers }).find(([k]) => q.includes(k))?.[1] ?? "Plan sites correctly";
    },
    askSecret: async () => ["sk", "ant", "test-team-key"].join("-"),
    template: () => readFileSync("templates/synthe.yml", "utf8"),
    sleep: async () => {},
    model: () => model,
    async run(cmd, args) {
      // Setup may read the prompt back from GitHub to check it was pushed; here GitHub has the same file.
      if (args.includes("Accept: application/vnd.github.raw")) return readFileSync(join(dir, "prompt.md"), "utf8");
      if (cmd === "git" && args[0] === "ls-files") return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
      return cmd === "git" ? "" : "o/r\n";
    },
  };
  return { dir, io, said, asked, conflictAsks, saved: () => parseGoal(readFileSync(join(dir, "synthe.json"), "utf8")) };
}

test("init names the checks that can't both pass, and the team can reword one", async () => {
  const { dir, io, said, conflictAsks, saved } = setup({ "to reword that check": "1", "New wording for check 1": "When every needed value is given, the reply makes exactly one tool call" });
  assert.equal(await init(io, dir), true);
  assert.equal(conflictAsks.length, 1);
  assert.match(conflictAsks[0].user, /What the agent is for: Site-planning helper for architects\./);
  const text = said.join("\n");
  assert.match(text, /These checks can't both pass on the same reply/);
  assert.ok(text.includes(`  1. ${LIVE[0]}\n  3. ${LIVE[2]}\n  Why: A reply that asks a clarifying question makes no tool call.`));
  assert.match(text, /Check reworded\./);
  assert.deepEqual(saved().checks, ["When every needed value is given, the reply makes exactly one tool call", LIVE[1], LIVE[2]]);
});

test("keeping both checks is allowed: setup goes on and saves them as they were", async () => {
  for (const answer of ["", "keep", "2"]) {
    const { dir, io, said, asked, saved } = setup({ "to reword that check": answer });
    assert.equal(await init(io, dir), true, `answer "${answer}"`);
    assert.ok(asked.some((q) => q === "Type 1 or 3 to reword that check, or press Enter to keep both: "));
    assert.ok(!asked.some((q) => q.startsWith("New wording for check")), `answer "${answer}" doesn't open a rewording`);
    assert.match(said.join("\n"), /Kept both\. You can change them in synthe\.json any time\./);
    assert.deepEqual(saved().checks, LIVE);
  }
});

test("a rewording that repeats another check, or is empty, leaves the checks as they were", async () => {
  for (const wording of [LIVE[1].toUpperCase(), ""]) {
    const { dir, io, said, saved } = setup({ "to reword that check": "3", "New wording for check 3": wording });
    assert.equal(await init(io, dir), true);
    if (wording) assert.match(said.join("\n"), /That repeats another check, so it was kept as it was\./);
    assert.deepEqual(saved().checks, LIVE);
  }
});

test("a pair with a check already reworded isn't asked about again", async () => {
  const { dir, io, asked, saved } = setup({ "to reword that check": "1", "New wording for check 1": "Makes one tool call once every value is known" },
    () => ({ conflicts: [{ first: 1, second: 3, why: "asking means no tool call" }, { first: 1, second: 2, why: "a second pair with check 1" }] }));
  assert.equal(await init(io, dir), true);
  assert.equal(asked.filter((q) => q.includes("to reword that check")).length, 1);
  assert.equal(saved().checks![0], "Makes one tool call once every value is known");
});

test("without conflicts, or when the check can't be made, init says nothing about them and goes on", async () => {
  for (const reply of [() => ({ conflicts: [] }), () => "not json", () => { throw new Error("529 overloaded"); }]) {
    const { dir, io, said, asked, saved } = setup({}, reply);
    assert.equal(await init(io, dir), true);
    assert.doesNotMatch(said.join("\n"), /can't both pass/);
    assert.ok(!asked.some((q) => q.includes("to reword that check")));
    assert.deepEqual(saved().checks, LIVE);
  }
});

test("agent draft prints the conflict for the person, never prompts, and still writes the draft", async () => {
  for (const given of [[], LIVE]) {
    const { dir, io, said, conflictAsks } = setup();
    io.ask = io.askSecret = async () => { throw new Error("agent mode prompted"); };
    const checkFlags = given.flatMap((c) => ["--check", c]);
    const options = agentOptions(["--agent", "--prompt", "prompt.md", "--objective", "Plan sites", "--mode", "review", ...checkFlags]);
    assert.equal(await init(io, dir, () => new Date("2026-11-06"), "", { SYNTHE_ANTHROPIC_KEY: "sk-ant-own" }, options), true);
    assert.equal(conflictAsks.length, 1);
    const text = said.join("\n");
    assert.match(text, /These checks can't both pass on the same reply/);
    assert.ok(said.includes("  Checks 1 and 3: A reply that asks a clarifying question makes no tool call."));
    assert.ok(said.includes("Show the person this conflict and offer to reword one check of each pair. Pass their final wording with --check at confirmation."));
    // Before the example replies, so the person sees the conflict next to the checks it's about.
    assert.ok(text.includes("Your agent replied") && text.indexOf("can't both pass") < text.indexOf("Your agent replied"));
    assert.equal(said.at(-1), AGENT_NEXT);
    assert.ok(existsSync(join(dir, DRAFT_FILE)));
    assert.deepEqual(JSON.parse(readFileSync(join(dir, DRAFT_FILE), "utf8")).goal.checks, LIVE, "the draft keeps the checks; the person decides");
  }
});
