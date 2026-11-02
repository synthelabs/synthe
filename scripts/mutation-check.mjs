// Breaks each safety rule on purpose and checks that a test fails. Restores every file, even if stopped.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const RULE = "src/core/merge-rule.ts";
const DECIDE = "src/loop/decide.ts";
const SCORE = "src/loop/score.ts";
const WRITE = "src/loop/write.ts";
const STATE = "src/core/state.ts";

const mutations = [
  ["no scenario wins needed", RULE, "if (split.p > max_p) return", "if (false) return"],
  ["no held-back gain needed", RULE, "held < beforeHoldout + min_improvement", "held < beforeHoldout"],
  ["no training gain needed", RULE, "after < before + min_improvement", "after < before"],
  ["unpaired scenarios allowed", RULE, 'if (split === null) return `${c.id}: scenarios could not be compared`;', ""],
  ["unknown scores pair as wins", RULE, 'if (typeof other !== "number" || !Number.isFinite(other) || typeof r.score !== "number" || !Number.isFinite(r.score)) return null;', ""],
  ["different scenario counts allowed", RULE, " || after.length !== before.length", ""],
  ["duplicate candidate rows allowed", RULE, " || new Set(after.map((r) => r.id)).size !== after.length", ""],
  ["ties count as wins", RULE, "if (r.score > other) wins++", "if (r.score >= other) wins++"],
  ["sign test halved", RULE, "tail / 2 ** n", "tail / 2 ** (n + 1)"],
  ["revert ignores the margin", RULE, "is < was - noise_margin && worse.p <= max_p", "worse.p <= max_p"],
  ["revert ignores scenario wins", RULE, "is < was - noise_margin && worse.p <= max_p", "is < was - noise_margin"],
  ["revert uses training rows only", RULE, "const now = [...scores.baselineTrain, ...scores.baselineHoldout];", "const now = [...scores.baselineTrain];"],
  ["guardrail unknown passes", RULE, "r.violation !== false", "r.violation === true"],
  ["held-back guardrails ignored", RULE, "violated(c.train) || violated(c.holdout)", "violated(c.train)"],
  ["unknown row becomes a mean", RULE, "rows.some((r) => r.score === null || !Number.isFinite(r.score))", "false"],
  ["revert hits a teammate's edit", DECIDE, " && last.mergedHash === scores.baselineHash", ""],
  ["identical candidate merges", DECIDE, ' ?? (text.trim() === current.trim() ? "candidate is the current prompt" : null)', ""],
  ["prompt change ignored", DECIDE, "sha256(current) !== scores.baselineHash", "false"],
  ["any stop resumes on new scenarios", STATE, "!/rounds in a row found no winner$/.test(s.stopped) || ", ""],
  ["resumes without a scenario change", STATE, " || s.scenariosHash === scenariosHash", ""],
  ["held-back test goes to the highest average", SCORE, "\n    .filter((c) => trainingProblem(c, scores.baselineTrain, goal) === null)", ""],
  ["writer studies held-back replies", WRITE, "lessonText(state, prompt, train)", "lessonText(state, prompt, scenarios)"],
  ["writer studies a stale prompt's replies", WRITE, " || state.lessons.promptHash !== sha256(prompt)", ""],
  ["judge always sees the challenger first", SCORE, "const first = challengerFirst(s, who);", "const first = true;"],
  ["winner read from the wrong side", SCORE, 'const challengerWon = v.better === (first ? "A" : "B");', 'const challengerWon = v.better === "A";'],
  ["revert without a live prior challenge", DECIDE, " && scores.prior ? scores.prior : null", " ? scores.baselineTrain : null"],
  ["unknown cost merges", DECIDE, "input.costUsd === null", "false"],
  ["identical candidate scored", SCORE, " && c.text.trim() !== baseline.trim()", ""],
  ["candidates trained on held-back scenarios", SCORE, "const duels = await challenge(c.id, c.text, train, trainReplies);", "const duels = await challenge(c.id, c.text, scenarios, new Map([...trainReplies, ...(await holdReplies())]));"],
  ["writer sees held-back scenarios", WRITE, 'const train = scenarios.filter((s) => s.split === "train");', "const train = scenarios;"],
];

let survived = 0;
for (const [name, file, from, to] of mutations) {
  const original = readFileSync(file, "utf8");
  if (!original.includes(from)) { console.log(`STALE     ${name}`); survived++; continue; }
  const restore = () => writeFileSync(file, original);
  process.once("SIGINT", restore);
  try {
    writeFileSync(file, original.replace(from, to));
    const { status } = spawnSync("node", ["--test", "test/core.test.ts", "test/loop.test.ts"], { stdio: "ignore", timeout: 60000 });
    if (status === 0) survived++;
    console.log(`${status === 0 ? "SURVIVED " : "killed   "} ${name}`);
  } finally {
    restore();
    process.removeListener("SIGINT", restore);
  }
}
console.log(survived ? `FAILED: ${survived} of ${mutations.length} not killed` : `OK: ${mutations.length} of ${mutations.length} killed`);
process.exitCode = survived ? 1 : 0;
