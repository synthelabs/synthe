#!/usr/bin/env node
// A `compare` command for judged problems, used when the score run has its own judge model.
//
//   node judge.mjs <gate-url> <model>
//
// It gets { case, a, b } on stdin (swarm/GOAL.md, "The judged measure"), reads the goal from problem.json in the
// current folder, asks the judge model through the scorer's gate, and prints { "winner": "a" | "b" | "tie" }.
// The gate holds the real key and counts the cost, so this command needs no key. It exits 1 when it has no answer.
import { readFileSync } from "node:fs";

const SYSTEM = [
  "You judge which of two outputs better meets the goal for one input.",
  "You get a JSON object: the goal, the case with its input, and two outputs, a and b.",
  "Judge only the quality of the output for the goal. The order of a and b means nothing, and a longer output is not better for being longer.",
  'Reply with only a JSON object: {"winner": "a"}, {"winner": "b"}, or {"winner": "tie"} when neither is better.',
].join("\n");
const MAX_TOKENS = 1024;
const TRIES = 4;

export function winnerIn(text) {
  for (const t of [text.trim(), ...(text.match(/\{[^{}]*\}/g) ?? []).reverse()]) {
    try { const w = JSON.parse(t)?.winner; if (w === "a" || w === "b" || w === "tie") return w; } catch { /* next form */ }
  }
  return null;
}

async function main([gate, model]) {
  if (!gate || !model) { console.error("Usage: node judge.mjs <gate-url> <model>"); return 1; }
  const { case: c, a, b } = JSON.parse(readFileSync(0, "utf8"));
  let goal = "";
  try { goal = JSON.parse(readFileSync("problem.json", "utf8")).goal ?? ""; } catch { /* no goal */ }
  const body = JSON.stringify({ model, max_tokens: MAX_TOKENS, system: SYSTEM, messages: [{ role: "user", content: JSON.stringify({ goal, case: c, a, b }, null, 2) }] });
  for (let i = 0; i < TRIES; i++) {
    let res;
    try {
      res = await fetch(`${gate.replace(/\/+$/, "")}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": "placeholder", "x-score-role": "judge" }, body });
    } catch { res = null; }
    if (res?.ok) {
      const reply = await res.json();
      const text = (reply.content ?? []).filter((p) => p?.type === "text").map((p) => p.text).join("");
      const w = winnerIn(text);
      if (w) { console.log(JSON.stringify({ winner: w })); return 0; }
      console.error("The judge model did not answer with a winner.");
      return 1;
    }
    // Only an overloaded or failed server is worth a second try. A refusal (such as the cost cap) is final.
    if (res && res.status !== 429 && res.status < 500) { console.error(`The judge request was refused (${res.status}).`); return 1; }
    await new Promise((done) => setTimeout(done, 1000 * 2 ** i));
  }
  console.error("The judge request failed.");
  return 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main(process.argv.slice(2)).then((code) => process.exit(code));
