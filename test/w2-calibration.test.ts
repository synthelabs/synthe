import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { calibrate, calibrationRows, calibrationSummary, checkStats, type CalibrationFile, type Label } from "../src/cli/calibrate.ts";
import type { Scenario } from "../src/core/goal.ts";
import type { Model } from "../src/model/client.ts";
import { goal } from "./helpers.ts";

// n labels of each kind: team says pass/fail, AI marked pass/fail.
const labels = (tp: number, fn: number, tn: number, fp: number): Label[] => [
  ...Array(tp).fill({ team: true, ai: true }), ...Array(fn).fill({ team: true, ai: false }),
  ...Array(tn).fill({ team: false, ai: false }), ...Array(fp).fill({ team: false, ai: true }),
];
const near = (a: number | null, b: number) => assert.ok(a !== null && Math.abs(a - b) < 1e-9, `${a} is not ${b}`);

test("a perfect match gives TPR 1, TNR 1, kappa 1", () => {
  const s = checkStats(labels(3, 0, 3, 0));
  near(s.tpr, 1); near(s.tnr, 1); near(s.kappa, 1);
  assert.equal(s.reading, "matches you well");
});

test("a split set gives known TPR, TNR and kappa, and the words that go with them", () => {
  // 8 labels: team passes 4, AI passes 5. po = 5/8, pe = 1/2.
  const unsure = checkStats(labels(3, 1, 2, 2));
  near(unsure.tpr, 0.75); near(unsure.tnr, 0.5); near(unsure.kappa, 0.25);
  assert.equal(unsure.reading, "unsure");
  // 10 labels: po = 0.9, pe = 0.5.
  const well = checkStats(labels(5, 1, 4, 0));
  near(well.tpr, 5 / 6); near(well.tnr, 1); near(well.kappa, 0.8);
  assert.equal(well.reading, "matches you well");
  // The AI marks the opposite of the team more often than not.
  const bad = checkStats(labels(1, 3, 1, 3));
  near(bad.tpr, 0.25); near(bad.tnr, 0.25); near(bad.kappa, -0.5);
  assert.equal(bad.reading, "disagrees with you");
});

test("TPR and TNR are different numbers: the AI that passes everything catches every pass and no fail", () => {
  const s = checkStats(labels(2, 0, 0, 2));
  near(s.tpr, 1); near(s.tnr, 0); near(s.kappa, 0);
  assert.equal(s.reading, "disagrees with you");
});

test("only one class by the team: not enough variety, no numbers", () => {
  for (const l of [labels(5, 0, 0, 0), labels(0, 0, 4, 1), labels(4, 1, 0, 0)]) {
    const s = checkStats(l);
    assert.deepEqual([s.tpr, s.tnr, s.kappa], [null, null, null]);
    assert.equal(s.reading, "not enough variety");
  }
});

test("fewer than 4 labels gives no numbers, even when the labels would give them", () => {
  const s = checkStats(labels(1, 1, 1, 0));
  assert.deepEqual([s.tpr, s.tnr, s.kappa], [null, null, null]);
  assert.equal(s.reading, "too few replies to judge");
  assert.equal(checkStats([]).reading, "too few replies to judge");
  assert.notEqual(checkStats(labels(2, 1, 1, 0)).reading, "too few replies to judge", "4 is enough");
});

test("the summary line counts checks with kappa of 0.6 or more", () => {
  const row = (l: Label[]) => calibrationRows([{ check: "c", applied: 9, steady: 9, asked: l.length, agreed: 0, verdict: "unused" }], [l])[0];
  const rows = [row(labels(3, 0, 3, 0)), row(labels(3, 1, 2, 2)), row(labels(5, 0, 0, 0)), row(labels(1, 0, 0, 0))];
  assert.equal(calibrationSummary(rows), "Calibration: 1 of 4 checks match your judgement (kappa 0.6 or more)");
  assert.equal(calibrationSummary([]), "Calibration: 0 of 0 checks match your judgement (kappa 0.6 or more)");
});

// Check 1 is always passed by the AI and the team splits on it; check 2 is always passed and the team agrees;
// check 3 never applies.
const CHECKS = ["Team splits on this", "Team always agrees", "Never applies"];
const cases: Scenario[] = Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, input: `question ${i}`, expected: "x", split: "train" as const }));
const fake: Model = {
  async ask(a) {
    if (!a.schema) return { text: `reply to ${a.user}`, costUsd: 0.001 };
    return { text: JSON.stringify({ results: [1, 2, 3].map((check) => ({ check, applies: check !== 3, passes: true })) }), costUsd: 0.001 };
  },
};

test("calibrate prints the table, the plain words and the summary, and writes calibration.json atomically", async () => {
  const dir = mkdtempSync(join(tmpdir(), "synthe-cal-"));
  try {
    const said: string[] = [];
    let check = "", splitAnswers = 0;
    const io = {
      say(t: string) { said.push(t); const m = t.match(/^ {3}Check: (.*)$/); if (m) check = m[1]; },
      async ask(q: string) {
        if (!q.includes("Does this reply pass")) return ""; // keeps the check as it is
        return check === CHECKS[0] ? (splitAnswers++ % 2 === 0 ? "y" : "n") : "y";
      },
    };
    const g = goal({ checks: CHECKS, models: { writer: "writer-model", runner: "runner-model", judge: "judge-model", checker: "checker-model" } });
    const before = Date.now();
    const out = await calibrate(io, g, "Prompt", cases, fake, join(dir, ".synthe"));
    const text = said.join("\n");

    assert.match(text, /How well each check matches your judgement:/);
    assert.match(text, /1\. Team splits on this\n {5}Disagrees with you\. Agreement 50%, steadiness 100%, passes caught 100%, fails caught 0%, kappa 0\.00\./);
    assert.match(text, /2\. Team always agrees\n {5}Not enough variety\.\n/);
    assert.match(text, /3\. Never applies\n {5}Too few replies to judge\.\n/);
    assert.match(text, /\nCalibration: 0 of 3 checks match your judgement \(kappa 0\.6 or more\)/);
    assert.equal(text.split("How well each check")[1].match(/kappa -?\d\.\d\d\./g)?.length, 1, "only the check with a real comparison shows numbers");

    assert.deepEqual(readdirSync(join(dir, ".synthe")), ["calibration.json"], "no temp file is left behind");
    const file: CalibrationFile = JSON.parse(readFileSync(join(dir, ".synthe", "calibration.json"), "utf8"));
    assert.deepEqual(file, out!.report, "what is written is what is returned");
    assert.deepEqual(file.modelIds, { checker: "checker-model", writer: "writer-model" });
    assert.ok(Date.parse(file.timestamp) >= before - 1000 && new Date(file.timestamp).toISOString() === file.timestamp);
    assert.equal(file.checks.length, 3);
    const [split, same, never] = file.checks;
    assert.equal(split.check, CHECKS[0]);
    assert.equal(split.applied, 12);
    assert.equal(split.steady, 12);
    assert.equal(split.agreed, 2);
    assert.deepEqual([split.tpr, split.tnr, split.kappa, split.verdict], [1, 0, 0, "disagrees with you"]);
    assert.deepEqual([same.tpr, same.tnr, same.kappa, same.verdict], [null, null, null, "not enough variety"]);
    assert.deepEqual([never.applied, never.tpr, never.tnr, never.kappa, never.verdict], [0, null, null, null, "too few replies to judge"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("calibrate writes nothing when it isn't given a folder, and the file is replaced on the next run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "synthe-cal-"));
  try {
    const io = { say() {}, async ask() { return "s"; } };
    const out = await calibrate(io, goal({ checks: CHECKS }), "Prompt", cases, fake);
    assert.ok(out!.report.checks.every((c) => c.kappa === null), "skipped questions give no labels");
    assert.deepEqual(readdirSync(dir), []);
    await calibrate(io, goal({ checks: CHECKS }), "Prompt", cases, fake, dir);
    await calibrate(io, goal({ checks: CHECKS }), "Prompt", cases, fake, dir);
    assert.deepEqual(readdirSync(dir), ["calibration.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
