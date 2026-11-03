import assert from "node:assert/strict";
import { test } from "node:test";
import { parseScenarios } from "../src/core/goal.ts";
import { STOPPED_LINE, stoppedLine } from "../src/cli/stopped.ts";

const row = (id: string, split = "train") => JSON.stringify({ id, input: "i", expected: "e", split });
// Five train rows and one holdout row: the smallest file parseScenarios accepts.
const valid = () => [1, 2, 3, 4, 5].map((i) => row(`t${i}`)).concat(row("h1", "holdout"));

test("a repeated scenario id is rejected with both line numbers", () => {
  const lines = Array.from({ length: 31 }, (_, i) => row(`s${i + 1}`));
  lines[11] = row("s99");
  lines[30] = row("s99");
  assert.throws(() => parseScenarios(lines.join("\n")), {
    message: '.synthe/scenarios.jsonl: lines 12 and 31 both use the id "s99"; give each test case its own id',
  });
});

test("a broken JSON line is named by its line number", () => {
  const lines = valid();
  lines[2] = '{"id": "t3", "input": "i"';
  assert.throws(() => parseScenarios(lines.join("\n")), /^Error: \.synthe\/scenarios\.jsonl line 3 isn't valid JSON: /);
});

test("a missing field is named by its line number", () => {
  const lines = valid();
  lines[1] = JSON.stringify({ id: "t2", input: "i", split: "train" });
  assert.throws(() => parseScenarios(lines.join("\n")), {
    message: '.synthe/scenarios.jsonl line 2 has a problem: "expected" is missing.',
  });
});

test("a split other than train or holdout is named by its line number", () => {
  const lines = valid();
  lines[5] = row("h2", "validation");
  assert.throws(() => parseScenarios(lines.join("\n")), /line 6 has a problem: "split" must be "train" or "holdout"/);
});

test("blank lines count toward line numbers but don't break parsing", () => {
  const lines = ["", "", ...valid().slice(0, 3), "", ...valid().slice(3), ""];
  assert.equal(parseScenarios(lines.join("\n")).length, 6);
  const broken = ["", "", row("a"), "", '{"id": "b"'];
  assert.throws(() => parseScenarios(broken.join("\n")), /line 5 isn't valid JSON/);
});

test("stopped line shows only when the workflow is disabled by hand", async () => {
  const calls: string[][] = [];
  const disabled = async (_cmd: string, args: string[]) => {
    calls.push(args);
    return "disabled_manually\n";
  };
  assert.equal(await stoppedLine(disabled, "team/repo"), STOPPED_LINE);
  assert.deepEqual(calls[0], ["api", "repos/team/repo/actions/workflows/synthe.yml", "--jq", ".state"]);
  assert.equal(STOPPED_LINE, "Stopped with npx synthe stop. Nothing more will run or change. To start it again: npx synthe restart");

  assert.equal(await stoppedLine(async () => "active\n", "team/repo"), null);
  assert.equal(await stoppedLine(async () => { throw new Error("gh: not logged in"); }, "team/repo"), null);
});
