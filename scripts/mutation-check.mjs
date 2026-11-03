// Breaks each safety rule on purpose and checks that a test fails. Restores every file, even if stopped.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const RULE = "src/core/merge-rule.ts";
const DECIDE = "src/loop/decide.ts";
const SCORE = "src/loop/score.ts";
const WRITE = "src/loop/write.ts";
const STATE = "src/core/state.ts";
const GITHUB = "src/github/repo.ts";

// Every test file, so a new one is never left out of the check.
const TESTS = readdirSync("test").filter((f) => f.endsWith(".test.ts")).map((f) => `test/${f}`);

const mutations = [
  ["no scenario wins needed", RULE, "if (split.p > max_p) return", "if (false) return"],
  ["no held-back gain needed", RULE, "held < beforeHoldout + min_improvement", "held < beforeHoldout"],
  ["no training gain needed", RULE, "after < before + min_improvement", "after < before"],
  ["unpaired scenarios allowed", RULE, 'if (split === null) return `${c.id}: test cases could not be compared`;', ""],
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
  ["every 403 means no permission", GITHUB, "isRateLimited(res.status, res.headers, text) ? \"rate_limited\"", "false ? \"rate_limited\""],
  ["a quote not in the reply confirms a break", SCORE, " && squash(text).includes(squash(v.quote))", ""],
  ["a failed re-check lets the merge through", SCORE, "if (verdict === false) {", "if (verdict !== true) {"],
  ["propose mode merges anyway", DECIDE, "    if (landing.propose) {", "    if (false) {"],
  ["a merge blocked by review closes the pull request", DECIDE, 'if (merged.problem === "blocked") {', "if (false) {"],
  ["rounds run while a proposal waits", DECIDE, "    if (pr?.open) {\n      await writeReport", "    if (false) {\n      await writeReport"],
  ["a proposal merged by a person isn't tracked", DECIDE, "      state.lastMerge = { pr: p.pr, priorPrompt: p.priorPrompt, mergedHash: sha256(live), reverted: false };", ""],
  ["judge always sees the challenger first", SCORE, "return duel(s, (set.indexOf(s) % 2 === 0) !== flip, current, mine);", "return duel(s, true, current, mine);"],
  ["a break is excused without confirming the current prompt's", SCORE, "      if (cur?.violation === true) {\n", "      if (cur?.violation === true) { checks.excusedConfirmed++; return; }\n      if (false) {\n"],
  ["a POST or PUT is repeated after a server error", GITHUB, 'if (method === "POST" || method === "PUT") return res;', ""],
  ["a review-blocked proposal isn't saved before a crash", DECIDE, "      landing.propose = true;\n      await repo.writeState(state);\n", ""],
  ["settling trusts the proposed text over what merged", DECIDE, "const live = source === null ? null : readPrompt(source, goal, p.text);", "const live = p.text;"],
  ["scoring pays when there's nothing to compare", SCORE, "  if (safe.length === 0 && !hasPrior) {", "  if (false) {"],
  ["an edit may add talk of judging or scores", WRITE, "if (added.length > judgingWords(e.find, own).length) return", "if (false) return"],
  ["the judge never sees the business policy", SCORE, "const policyText = (goal: Goal) => (goal.policy?.trim() ?", "const policyText = (goal: Goal) => (false ?"],
  ["setup defaults an unclear merge answer to automatic", "src/cli/init.ts", "if (auto === null) { auto = false;", "if (auto === null) { auto = true;"],
  ["unknown cost merges", DECIDE, "input.costUsd === null", "false"],
  ["identical candidate scored", SCORE, " && c.text.trim() !== baseline.trim()", ""],
  ["candidates trained on held-back scenarios", SCORE, "const duels = await challenge(c.id, c.text, train, trainReplies);", "const duels = await challenge(c.id, c.text, scenarios, new Map([...trainReplies, ...(await holdReplies())]));"],
  ["writer sees held-back scenarios", WRITE, 'const train = scenarios.filter((s) => s.split === "train");', "const train = scenarios;"],
  ["a busy API round counts as a stall", DECIDE, "Synthe will try again next hour.\";\n      stall = false;", "Synthe will try again next hour.\";"],
  ["a key failure is read as a busy API", "src/loop/failure.ts", "kind: /\\bkey\\b/i.test(plain) ? \"key\" : \"busy\"", "kind: \"busy\""],
  ["every team runs at the same minute", "src/cli/init.ts", ".replaceAll(\"__MINUTE__\", String(minute))", ".replaceAll(\"__MINUTE__\", \"23\")"],
  ["a refused pull request keeps the run going", DECIDE, "state.stopped = e.plain;", ""],
  ["issues being off crashes decide", DECIDE, "if (!(e instanceof Refusal)) throw e;\n    const note", "throw e;\n    const note"],
  ["an unclear merge answer is never read back", GITHUB, "if (back.ok && (await back.json()).merged === true) return { merged: true };", ""],
  ["a cut-off agent reply is unknown", "src/model/client.ts", "const cutOff = allowCutOff === true && res.stop_reason === \"max_tokens\" && text.length > 0;", "const cutOff = false;"],
  ["duplicate scenario ids allowed", "src/core/goal.ts", "if (lineOf.has(s.id)) throw", "if (false) throw"],
  ["restart reopens a finished run", "src/cli/restart.ts", "if (isFinished(stopped) && !failedOut && !roundsRaised) {", "if (false) {"],
  ["restart spends after unknown cost", "src/cli/restart.ts", "if (state.spendUnknown) return", "if (false) return"],
  ["a merged proposal still waits an hour", "src/action.ts", "return !pr || pr.open;", "return true;"],
];

let survived = 0;
for (const [name, file, from, to] of mutations) {
  const original = readFileSync(file, "utf8");
  if (!original.includes(from)) { console.log(`STALE     ${name}`); survived++; continue; }
  const restore = () => writeFileSync(file, original);
  process.once("SIGINT", restore);
  try {
    writeFileSync(file, original.replace(from, to));
    const { status } = spawnSync("node", ["--test", ...TESTS], { stdio: "ignore", timeout: 60000 });
    if (status === 0) survived++;
    console.log(`${status === 0 ? "SURVIVED " : "killed   "} ${name}`);
  } finally {
    restore();
    process.removeListener("SIGINT", restore);
  }
}
console.log(survived ? `FAILED: ${survived} of ${mutations.length} not killed` : `OK: ${mutations.length} of ${mutations.length} killed`);
process.exitCode = survived ? 1 : 0;
