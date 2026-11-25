import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { loadProblem } from "./problem.ts";
import { AlreadyRunningError, SetupError, solve } from "../solve/loop.ts";
import { proposerFor } from "../solve/proposer.ts";
import { openPullRequest } from "../solve/pr.ts";
import { recorder, replayer, replayProblem, useRecording } from "../solve/recording.ts";
import type { SolveOptions } from "../solve/types.ts";

// `synthe solve <problem-file> [--out DIR] [--seed N] [--resume] [--record DIR | --replay DIR] [--pr] [--proposer model]`. Exit 0 when the run ended normally, with or without gains;
// exit 1 for a bad problem file or a failed setup, and for --pr when the push or gh fails after the run; exit 3 when
// another solve of the same problem already runs (nothing changes).
export async function solveCommand(args: string[], cwd: string, say: (line: string) => void, env: NodeJS.ProcessEnv): Promise<number> {
  const value = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const valued = new Set(["--out", "--seed", "--record", "--replay", "--proposer"]);
  const file = args.find((a, i) => !a.startsWith("--") && !valued.has(args[i - 1]));
  if (!file) { say("Usage: npx synthe solve <problem-file> [--out DIR] [--seed N] [--resume] [--record DIR | --replay DIR] [--pr] [--proposer model]"); return 1; }
  // Record and replay of model calls (src/solve/recording.ts). Both are checked before anything runs or is written.
  const record = value("--record"), replay = value("--replay");
  for (const flag of ["--record", "--replay"]) {
    const v = value(flag);
    if (args.includes(flag) && (!v || v.startsWith("--"))) { say(`${flag} needs a folder, such as ${flag} recording.`); return 1; }
  }
  if (record && replay) { say("Use --record or --replay, not both. --record saves the model calls of a run; --replay answers them from a saved recording."); return 1; }
  const replayDir = replay ? resolve(cwd, replay) : undefined;
  const missing = replayDir ? replayProblem(replayDir) : null;
  if (missing) { say(missing); return 1; }
  // --proposer model: use the model proposer whatever the file says. A CI runner has no coding agent.
  const proposer = value("--proposer");
  if (args.includes("--proposer") && proposer !== "model") { say("--proposer takes one value: --proposer model. It uses the model block of the problem file in place of its proposer."); return 1; }
  const options: SolveOptions = {};
  if (args.includes("--resume")) options.resume = true;
  const out = value("--out");
  if (out) options.out = out;
  const seed = value("--seed");
  if (seed !== undefined) {
    if (!/^\d+$/.test(seed)) { say("--seed must be a whole number, such as --seed 1."); return 1; }
    options.seed = Number(seed);
  }
  const check = loadProblem(file, cwd);
  if (!check.ok) { for (const p of check.problems) say(p); return 1; }
  if (proposer === "model") {
    if (!check.problem.model) { say(`--proposer model needs a "model" block in ${file}, such as "model": { "provider": "anthropic", "model": "claude-haiku-5-5" }. Add it, or run without --proposer model.`); return 1; }
    check.problem.proposer = "model";
  }
  if (replayDir) useRecording(check.problem, replayer(replayDir));
  else if (record) useRecording(check.problem, recorder(resolve(cwd, record)));
  try {
    const result = await solve(check.problem, proposerFor(check.problem), options, { say, env });
    say(result.stopped);
    if (!args.includes("--pr")) return 0;
    const problem = check.problem;
    const repoRoot = execFileSync("git", ["-C", problem.dir, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
    // The same folder rule as solve() uses for result.json and report.md.
    const outDir = options.out ? resolve(process.cwd(), options.out) : join(repoRoot, ".synthe", "solve", problem.name);
    const pr = await openPullRequest(result, { repoRoot, reportPath: join(outDir, "report.md"), goal: problem.goal });
    say(pr.message);
    return pr.ok ? 0 : 1;
  } catch (e) {
    if (e instanceof AlreadyRunningError) { say(e.message); return 3; }
    if (e instanceof SetupError) { say(e.message); return 1; }
    throw e;
  }
}
