import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Goal, Scenario } from "../core/goal.ts";
import { candidateScope, rememberCandidates, validateCandidateMemory } from "../core/candidate-history.ts";
import { judgeRound } from "../core/merge-rule.ts";
import { newState } from "../core/state.ts";
import { runWrite } from "../loop/write.ts";
import { runScore } from "../loop/score.ts";
import type { Model } from "../model/client.ts";

export async function runLocalTry(cwd: string, goal: Goal, prompt: string, scenarios: Scenario[], model: Model) {
  const directory = join(cwd, ".synthe-local");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "try-history.json");
  const lock = `${path}.lock`;
  let descriptor: number;
  try { descriptor = openSync(lock, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Another local try holds the history lock. If it crashed, remove .synthe-local/try-history.json.lock before retrying.");
    throw error;
  }
  try {
    const state = newState();
    let raw: string | undefined;
    try { raw = readFileSync(path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (raw !== undefined) {
      try {
        const saved = JSON.parse(raw);
        if (saved.version !== 1 || Object.keys(saved).sort().join(",") !== "history,version") throw new Error("schema");
        state.candidateHistory = validateCandidateMemory(saved.history);
      } catch { throw new Error("Local candidate history is corrupt. Restore .synthe-local/try-history.json or remove it explicitly before trying again."); }
    }
    const written = await runWrite(goal, state, prompt, scenarios, model);
    const history = rememberCandidates(state.candidateHistory ?? [], candidateScope(goal, prompt), written.candidates.map((candidate) => candidate.text));
    const temporary = `${path}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify({ version: 1, history }, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, path);
    } finally {
      try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const { scores, costUsd } = await runScore(goal, prompt, written.candidates, scenarios, model);
    return { written, costUsd, verdict: judgeRound(scores, goal, null) };
  } finally {
    closeSync(descriptor);
    unlinkSync(lock);
  }
}
