import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Model } from "../model/client.ts";
import type { Compare } from "./judge.ts";
import { SetupError } from "./loop.ts";
import { noTextReason, problemModel } from "./model-proposer.ts";
import { isJudged, type Problem } from "./types.ts";

// The model judge: compare "model" in a judged measure. It gets the same object a compare command gets on stdin,
// { case, a, b }, and must answer { winner: "a" | "b" | "tie" }. judge.ts asks each question twice with a and b
// swapped and controls for length, so a model's position or length bias cannot win a change on its own.
// The key rules are the model proposer's: SYNTHE_API_KEY, sent only to model.base_url, never in a reason.

const MAX_TOKENS = 2_000;

export const WINNER_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["winner"],
  properties: { winner: { type: "string", enum: ["a", "b", "tie"] } },
};

export const JUDGE_SYSTEM = [
  "You judge which of two outputs better meets the goal for one input.",
  "You get a JSON object: the goal, maybe a rubric, the case with its input, and two outputs, a and b.",
  "When there is a rubric, judge by its criteria, most important first.",
  "Judge only the quality of the output for the goal. The order of a and b means nothing, and a longer output is not better for being longer.",
  'Reply with only a JSON object: {"winner": "a"}, {"winner": "b"}, or {"winner": "tie"} when neither is better.',
].join("\n");

// The winner in a reply: the whole reply, or the last {...} in it.
export function winnerIn(text: string): "a" | "b" | "tie" | null {
  for (const t of [text.trim(), text.match(/\{[^{}]*\}(?![\s\S]*\{)/)?.[0] ?? ""]) {
    try {
      const w = (JSON.parse(t) as { winner?: unknown })?.winner;
      if (w === "a" || w === "b" || w === "tie") return w;
    } catch { /* try the next form */ }
  }
  return null;
}

// The rubric of a judged measure (measure.judge.rubric), read once when the judge is built. It is a protected file,
// so no proposal changes it during the run. A rubric that cannot be read stops setup, before any model call.
export function rubricText(problem: Problem): string | undefined {
  const m = problem.measure;
  if (!isJudged(m) || !m.judge.rubric) return undefined;
  try { return readFileSync(join(problem.dir, m.judge.rubric), "utf8").trim() || undefined; } catch {
    throw new SetupError(`Synthe can't read the rubric ${m.judge.rubric} (measure.judge.rubric).`);
  }
}

// Throws SetupError before any call when the problem cannot reach a model. Never throws after that.
export function modelCompare(problem: Problem, env: NodeJS.ProcessEnv = process.env, client?: Model): Compare {
  const { client: model, model: id, hide } = problemModel(problem, env, client);
  const rubric = rubricText(problem);
  return async (c, a, b) => {
    try {
      const user = JSON.stringify({ goal: problem.goal, ...(rubric ? { rubric } : {}), case: c, a, b }, null, 2);
      const reply = await model.ask({ model: id, system: JUDGE_SYSTEM, user, maxTokens: MAX_TOKENS, schema: WINNER_SCHEMA });
      if (reply.text === null) return { failed: hide(`The model judge gave no usable reply: ${noTextReason(reply.stopReason)}.`) };
      const w = winnerIn(reply.text);
      return w ?? { failed: hide(`The model judge did not answer {"winner": "a" | "b" | "tie"}: ${JSON.stringify(reply.text.trim().slice(0, 200))}`) };
    } catch (error) {
      return { failed: hide(`The model judge request failed: ${error instanceof Error ? error.message : String(error)}`) };
    }
  };
}
