import { loadProblem } from "./problem.ts";
import { SetupError, solve } from "../solve/loop.ts";
import { proposerFor } from "../solve/proposer.ts";
import { stopRunning } from "../solve/run.ts";
import { closeOpenScratches } from "../solve/scratch.ts";
import type { SolveOptions } from "../solve/types.ts";

// `synthe solve <problem-file> [--out DIR] [--seed N]`. Exit 0 when the run ended normally, with or without gains;
// exit 1 for a bad problem file or a failed setup.
export async function solveCommand(args: string[], cwd: string, say: (line: string) => void, env: NodeJS.ProcessEnv): Promise<number> {
  const value = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const file = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--out" && args[i - 1] !== "--seed");
  if (!file) { say("Usage: npx synthe solve <problem-file> [--out DIR] [--seed N]"); return 1; }
  const options: SolveOptions = {};
  const out = value("--out");
  if (out) options.out = out;
  const seed = value("--seed");
  if (seed !== undefined) {
    if (!/^\d+$/.test(seed)) { say("--seed must be a whole number, such as --seed 1."); return 1; }
    options.seed = Number(seed);
  }
  const check = loadProblem(file, cwd);
  if (!check.ok) { for (const p of check.problems) say(p); return 1; }
  const stopWatching = onInterrupt(say);
  try {
    const result = await solve(check.problem, proposerFor(check.problem), options, { say, env });
    say(result.stopped);
    return 0;
  } catch (e) {
    if (e instanceof SetupError) { say(e.message); return 1; }
    throw e;
  } finally {
    stopWatching();
  }
}

// Ctrl-C, a closed terminal or a kill during a run. Nothing async can finish, so the cleanup is synchronous:
// stop the running commands (they are in their own process groups and do not get the signal), remove the
// scratch checkout, and keep the branch only if it holds a kept change. The person's working tree never changed.
function onInterrupt(say: (line: string) => void): () => void {
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const stop = (signal: NodeJS.Signals) => {
    stopRunning();
    let kept: string[] = [];
    try { kept = closeOpenScratches(); } catch { /* exit anyway */ }
    say(`\nStopped (${signal}). Synthe stopped its commands and removed its scratch checkout. Your working tree did not change.`);
    if (kept.length) say(`The changes kept before the stop are on ${kept.join(", ")}. No result.json was written for this run.`);
    else say("No change was kept, so no branch was left.");
    process.exit(130);
  };
  for (const s of signals) process.once(s, stop);
  return () => { for (const s of signals) process.off(s, stop); };
}
