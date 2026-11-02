// Breaks each safety rule on purpose and checks that a test fails. Restores every file, even if stopped.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const RULE = "src/core/merge-rule.ts";
const DECIDE = "src/loop/decide.ts";
const SCORE = "src/loop/score.ts";
const WRITE = "src/loop/write.ts";
const STATE = "src/core/state.ts";
const GITHUB = "src/github/repo.ts";

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
  ["guardrail unknown passes", RULE, "rows.filter((r) => r.violation === null || ", "rows.filter((r) => "],
  ["held-back guardrails ignored", RULE, "addedBreaks(c.train, scores.baselineTrain) + addedBreaks(c.holdout, scores.baselineHoldout)", "addedBreaks(c.train, scores.baselineTrain)"],
  ["fixing some breaks but not all still blocks", RULE, " && before.get(r.id) !== true", ""],
  ["unknown row becomes a mean", RULE, "rows.some((r) => r.score === null || !Number.isFinite(r.score))", "false"],
  ["revert hits a teammate's edit", DECIDE, " && last.mergedHash === scores.baselineHash", ""],
  ["identical candidate merges", DECIDE, ' ?? (text.trim() === current.trim() ? "candidate is the current prompt" : null)', ""],
  ["prompt change ignored", DECIDE, "sha256(current) !== scores.baselineHash", "false"],
  ["any stop resumes on new scenarios", STATE, "!/rounds in a row found no winner$/.test(s.stopped) || ", ""],
  ["resumes without a scenario change", STATE, " || s.scenariosHash === scenariosHash", ""],
  ["held-back test goes to the highest average", SCORE, "\n    .filter((c) => trainingProblem(c, scores.baselineTrain, goal) === null)", ""],
  ["writer studies held-back replies", WRITE, "lessonText(state, prompt, train)", "lessonText(state, prompt, scenarios)"],
  ["writer studies a stale prompt's replies", WRITE, " || state.lessons.promptHash !== sha256(prompt)", ""],
  ["winner read from the wrong side", SCORE, 'const challengerWon = v.better === (first ? "A" : "B");', 'const challengerWon = v.better === "A";'],
  ["revert without a live prior challenge", DECIDE, " && scores.prior ? scores.prior : null", " ? scores.baselineTrain : null"],
  ["an edit lands where its text appears twice", WRITE, 'if (text.indexOf(e.find, at + 1) !== -1) return { problem: "an edit\'s text appears more than once" };', ""],
  ["any number of edits allowed", WRITE, "if (edits.length > MAX_EDITS) return", "if (false) return"],
  ["spend saved only at the end", DECIDE, "  state.pending = { round, at: record.at, costUsd: input.costUsd };\n  await repo.writeState(state);", "  state.pending = { round, at: record.at, costUsd: input.costUsd };"],
  ["a merge recovered after a crash is forgotten", DECIDE, "state.lastMerge = { pr: pr.number, priorPrompt: p.land.priorPrompt, mergedHash: sha256(p.land.text), reverted: false };", ""],
  ["a rate limit stops the run", DECIDE, 'token: "GitHub refused the workflow\'s token",', 'token: "GitHub refused the workflow\'s token", rate_limited: "rate limited",'],
  ["every 403 means no permission", GITHUB, 'const problem: MergeProblem = isRateLimited(res.status, res.headers, text) ? "rate_limited"', 'const problem: MergeProblem = false ? "rate_limited"'],
  ["a quote not in the reply confirms a break", SCORE, " && squash(text).includes(squash(v.quote))", ""],
  ["a failed re-check lets the merge through", SCORE, "if (verdict === false) {", "if (verdict !== true) {"],
  ["propose mode merges anyway", DECIDE, "    if (landing.propose) {", "    if (false) {"],
  ["a merge blocked by review closes the pull request", DECIDE, 'if (merged.problem === "blocked") {', "if (false) {"],
  ["rounds run while a proposal waits", DECIDE, "    if (pr?.open) {\n      state.issue", "    if (false) {\n      state.issue"],
  ["a proposal merged by a person isn't tracked", DECIDE, "      state.lastMerge = { pr: p.pr, priorPrompt: p.priorPrompt, mergedHash: sha256(live), reverted: false };", ""],
  ["judge always sees the challenger first", SCORE, "return duel(s, (set.indexOf(s) % 2 === 0) !== flip, current, mine);", "return duel(s, true, current, mine);"],
  ["a break is excused without confirming the current prompt's", SCORE, "      if (cur?.violation === true) {\n", "      if (cur?.violation === true) { checks.excusedConfirmed++; return; }\n      if (false) {\n"],
  ["a POST or PUT is repeated after a server error", GITHUB, 'if (method === "POST" || method === "PUT") return res;', ""],
  ["a review-blocked proposal isn't saved before a crash", DECIDE, "      landing.propose = true;\n      await repo.writeState(state);\n", ""],
  ["settling trusts the proposed text over what merged", DECIDE, "const live = source === null ? null : readPrompt(source, goal, p.text);", "const live = p.text;"],
  ["scoring pays when there's nothing to compare", SCORE, "  if (safe.length === 0 && !hasPrior) {", "  if (false) {"],
  ["an edit may add talk of judging or scores", WRITE, "if (mentions(e.replace) > mentions(e.find)) return", "if (false) return"],
  ["the judge never sees the business policy", SCORE, "const policyText = (goal: Goal) => (goal.policy?.trim() ?", "const policyText = (goal: Goal) => (false ?"],
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
    const { status } = spawnSync("node", ["--test", "test/core.test.ts", "test/loop.test.ts", "test/github.test.ts"], { stdio: "ignore", timeout: 60000 });
    if (status === 0) survived++;
    console.log(`${status === 0 ? "SURVIVED " : "killed   "} ${name}`);
  } finally {
    restore();
    process.removeListener("SIGINT", restore);
  }
}
console.log(survived ? `FAILED: ${survived} of ${mutations.length} not killed` : `OK: ${mutations.length} of ${mutations.length} killed`);
process.exitCode = survived ? 1 : 0;
