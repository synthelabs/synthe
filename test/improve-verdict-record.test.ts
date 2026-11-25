import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ImproveConfig, Measurement } from "../src/improve/config.ts";
import { verdict } from "../src/improve/verdict.ts";
import {
  VERDICT_FORMAT, buildVerdictRecord, updatePublication, verdictFile, writeVerdictRecord, type VerdictRecord,
} from "../src/improve/verdict-record.ts";

const root = mkdtempSync(join(tmpdir(), "synthe-verdict-record-"));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const gitDir = () => { const d = join(root, `git-${++n}`); mkdirSync(d); return d; };

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const config: ImproveConfig = {
  version: 1, goal: "Let normal emails sign up",
  metric: { preset: "custom", label: "valid signups", unit: "of 12", command: "node metrics/score.js", direction: "higher", runs: 3 },
  guard: { command: "npm test" }, protect: [], mode: "review",
  baseline: { commit: BASE, median: 3, runs: [3, 3, 3], at: "2026-11-23T00:00:00Z" },
};
const m = (commit: string, median: number, runs: number[]): Measurement => ({ commit, median, runs, at: "2026-11-23T00:00:00Z" });

function record(guardPassed: boolean | null = true): VerdictRecord {
  const baseline = m(BASE, 3, [3, 3, 3]);
  const measured = m(HEAD, 12, [12, 12, 12]);
  return buildVerdictRecord({ config, baseline, candidate: HEAD, measured, guardPassed, verdict: verdict("higher", baseline, measured, guardPassed) });
}

test("a verdict record has exactly the documented fields, for a keep and for a rejection", () => {
  const keep = record(true);
  assert.deepEqual(Object.keys(keep).sort(), ["base", "baseline", "candidate", "decided_at", "delta", "format", "guard", "guard_passed",
    "measured", "metric", "noise", "publication", "reason", "verdict", "why"]);
  assert.equal(keep.format, VERDICT_FORMAT);
  assert.equal(VERDICT_FORMAT, "synthe-improve-verdict/v1");
  assert.equal(keep.base, BASE, "base is the commit the baseline was measured on");
  assert.equal(keep.candidate, HEAD);
  assert.deepEqual(keep.metric, config.metric);
  assert.notEqual(keep.metric, config.metric, "a copy, not the config object");
  const extra = buildVerdictRecord({ config: { ...config, metric: { ...config.metric, token: "secret" } as ImproveConfig["metric"] },
    baseline: m(BASE, 3, [3]), candidate: HEAD, measured: m(HEAD, 12, [12]), guardPassed: true, verdict: verdict("higher", m(BASE, 3, [3]), m(HEAD, 12, [12]), true) });
  assert.deepEqual(Object.keys(extra.metric).sort(), ["command", "direction", "label", "preset", "runs", "unit"], "only the six known metric fields");
  assert.deepEqual(keep.guard, { command: "npm test" });
  assert.deepEqual(keep.baseline, { median: 3, runs: [3, 3, 3] });
  assert.deepEqual(keep.measured, { median: 12, runs: [12, 12, 12] });
  assert.deepEqual([keep.guard_passed, keep.verdict, keep.reason, keep.delta, keep.noise], [true, "keep", null, 9, 0]);
  assert.equal(keep.why, "Better by 9, more than the run-to-run noise of 0; the regression check passed.");
  assert.match(keep.decided_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.deepEqual(keep.publication, { status: "pending" });

  const reject = record(false);
  assert.deepEqual([reject.verdict, reject.reason, reject.why, reject.guard_passed], ["reject", "guard", "The regression check did not pass.", false]);
  assert.deepEqual(reject.publication, { status: "not_attempted" });
});

test("the record file is named by the full candidate hash inside the git folder", () => {
  assert.equal(verdictFile("/r/.git", HEAD), join("/r/.git", "synthe-verdicts", `${HEAD}.json`));
});

test("writeVerdictRecord writes through a temp file in the same folder and leaves no temp file behind", () => {
  const dir = gitDir();
  const other = "c".repeat(40);
  mkdirSync(join(dir, "synthe-verdicts"));
  writeFileSync(join(dir, "synthe-verdicts", `${other}.json`), "older record for another commit\n");
  const written = record();
  writeVerdictRecord(dir, written);
  assert.deepEqual(JSON.parse(readFileSync(verdictFile(dir, HEAD), "utf8")), written);
  assert.deepEqual(readdirSync(join(dir, "synthe-verdicts")).sort(), [`${HEAD}.json`, `${other}.json`].sort(), "no temp file is left");
  assert.equal(readFileSync(join(dir, "synthe-verdicts", `${other}.json`), "utf8"), "older record for another commit\n", "another commit's record is left alone");
  // A second write replaces the file whole.
  writeVerdictRecord(dir, record(false));
  assert.equal(JSON.parse(readFileSync(verdictFile(dir, HEAD), "utf8")).verdict, "reject");
  assert.equal(readdirSync(join(dir, "synthe-verdicts")).length, 2);
});

test("writeVerdictRecord refuses a candidate that is not a full commit hash, so no path can leave the folder", () => {
  const dir = gitDir();
  for (const bad of ["../x", "abc1234", "B".repeat(40)]) {
    assert.throws(() => writeVerdictRecord(dir, { ...record(), candidate: bad }), /full commit hash/);
  }
  assert.equal(existsSync(join(dir, "synthe-verdicts")), false);
});

test("a failed write leaves no temp file and no record", () => {
  const dir = gitDir();
  // A folder where the record file must go makes the rename fail.
  mkdirSync(verdictFile(dir, HEAD), { recursive: true });
  assert.throws(() => writeVerdictRecord(dir, record()));
  assert.deepEqual(readdirSync(join(dir, "synthe-verdicts")), [`${HEAD}.json`]);
});

test("updatePublication changes only the publication field", () => {
  const dir = gitDir();
  const first = record();
  writeVerdictRecord(dir, first);
  const read = () => JSON.parse(readFileSync(verdictFile(dir, HEAD), "utf8")) as VerdictRecord;
  updatePublication(dir, HEAD, { status: "failed", step: "pr" });
  assert.deepEqual(read(), { ...first, publication: { status: "failed", step: "pr" } });
  updatePublication(dir, HEAD, { status: "pr_opened", url: "https://github.com/o/r/pull/1" });
  updatePublication(dir, HEAD, { status: "merged", url: "https://github.com/o/r/pull/1" });
  assert.deepEqual(read(), { ...first, publication: { status: "merged", url: "https://github.com/o/r/pull/1" } });
  assert.deepEqual(readdirSync(join(dir, "synthe-verdicts")), [`${HEAD}.json`]);
});

test("updatePublication refuses a missing record or a record for another commit", () => {
  const dir = gitDir();
  assert.throws(() => updatePublication(dir, HEAD, { status: "pending" }));
  mkdirSync(join(dir, "synthe-verdicts"));
  writeFileSync(verdictFile(dir, HEAD), JSON.stringify({ ...record(), candidate: "c".repeat(40) }));
  assert.throws(() => updatePublication(dir, HEAD, { status: "pr_opened", url: "u" }), /another commit/);
});
