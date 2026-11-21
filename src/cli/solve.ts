import { loadProblem } from "./problem.ts";
import { SetupError, solve } from "../solve/loop.ts";
import { proposerFor } from "../solve/proposer.ts";
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
  try {
    const result = await solve(check.problem, proposerFor(check.problem), options, { say, env });
    say(result.stopped);
    return 0;
  } catch (e) {
    if (e instanceof SetupError) { say(e.message); return 1; }
    throw e;
  }
}
