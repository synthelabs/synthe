import assert from "node:assert/strict";
import test from "node:test";
import { builder } from "../src/cli/builder.ts";

const event = "fixture-event", team = "crim-abcd-efgh-jkmn-pqrs";

function fixture(answers: string[] = []) {
  const events: string[] = [], output: string[] = [];
  const deps: Parameters<typeof builder>[1] = {
    interactive: true, cwd: "/project", env: {},
    repoRoot: (path) => { events.push(`repo:${path}`); return path; },
    checkAgent: () => { events.push("checked runner"); },
    io: {
      async ask(question) { events.push(question); return answers.shift() ?? ""; },
      async askSecret(question) { events.push(question); return question.startsWith("Event") ? event : team; },
      say: (line) => { output.push(line); },
    },
    async refine(input) {
      assert.deepEqual(input, { eventCode: event, teamCode: team, goal: "Speed up search", metric: "search latency in ms", direction: "lower", target: 200 });
      return { prompt: "Avoid repeated work in the search loop.", cost: .01 };
    },
    async codingAgent(cwd, prompt) {
      assert.equal(cwd, "/trial");
      assert.match(prompt, /Higher|Lower/);
      assert.doesNotMatch(prompt, /fixture-event|crim-abcd/);
    },
    async run(input) {
      assert.equal(input.mode, "auto");
      assert.deepEqual(input.protectedPaths, ["scripts/metric.mjs"]);
      const refinedPrompt = await input.refine(input.goal);
      await input.runAgent("/trial", refinedPrompt);
      return {
        commit: "a".repeat(40), baseline: { value: 300, guardsPassed: true },
        original: { value: 210, guardsPassed: true, eligible: false, reason: "Missed target" },
        refined: { value: 190, guardsPassed: true, eligible: true }, refinedPrompt,
        winner: "refined", patchPath: "/private/temp/winner.patch", applied: true,
      };
    },
  };
  return { deps, events, output };
}

test("Builder guides a real checkout through masked codes, goal, target and auto selection", async () => {
  const { deps, events, output } = fixture(["Speed up search", "search latency in ms", "node scripts/metric.mjs", "lower 200", "npm test", "auto"]);
  await builder(["--repo", "app", "--protect", "scripts/metric.mjs"], deps);
  assert.deepEqual(events.slice(0, 5), ["repo:/project/app", "checked runner", "Event code: ", "Team code: ", "What should improve? "]);
  assert.match(output.join("\n"), /starting repo 300.*original prompt 210.*refined prompt 190/);
  assert.match(output.join("\n"), /Applied the winning changes locally/);
  assert.doesNotMatch(output.join("\n"), /fixture-event|crim-abcd/);
});

test("Builder defaults to review, refuses secret-bearing goals and fails safely outside a terminal", async () => {
  const selected = fixture(["Speed up search", "search latency in ms", "node metric.mjs", "lower 200", "npm test", ""]);
  selected.deps.run = async (input) => {
    assert.equal(input.mode, "review");
    return {
      commit: "a".repeat(40), baseline: { value: 300, guardsPassed: true },
      original: { value: null, guardsPassed: false, eligible: false },
      refined: { value: null, guardsPassed: false, eligible: false }, refinedPrompt: "Fixture",
      winner: null, patchPath: null, applied: false,
    };
  };
  await builder(["--repo", "."], selected.deps);
  assert.match(selected.output.join("\n"), /No qualifying improvement/);
  const bad = fixture([`Reuse ${event}`, "search latency in ms", "node metric.mjs", "lower 200", "npm test"]);
  await assert.rejects(builder(["--repo", "."], bad.deps), /without credentials/);
  await assert.rejects(builder([], { ...bad.deps, interactive: false }), /in your terminal/);
  await builder(["--help"], { ...bad.deps, interactive: false });
});
