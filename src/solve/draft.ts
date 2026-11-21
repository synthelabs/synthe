// `measure draft`: the hardest step for a person is to write the measure. From a few examples, each an input with a
// better and a worse output, Synthe asks the model for a judging rubric and writes a judged measure (cases.jsonl,
// rubric.md, compare.js). It then checks the rubric against the person's own labels, both ways round, and says
// plainly when the judge does not agree with them. See swarm/GOAL-2.md.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Model } from "../model/client.ts";
import { runCommand } from "./run.ts";

export interface Example { input: string; good: string; bad: string }
export type Provider = "anthropic" | "openai-compatible";
export interface DraftModel { provider: Provider; model: string; base_url?: string }

export const AGREEMENT_NEEDED = 0.8;
const RUBRIC_MAX_TOKENS = 4000;

/** Reads the examples file: one JSON object per line with text "input", "good" and "bad". */
export function readExamples(text: string): { ok: true; examples: Example[] } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const examples: Example[] = [];
  const lines = text.split("\n");
  for (const [i, line] of lines.entries()) {
    if (!line.trim()) continue;
    let e: unknown;
    try { e = JSON.parse(line); } catch { problems.push(`line ${i + 1}: not valid JSON.`); continue; }
    const o = e as Record<string, unknown> | null;
    const missing = ["input", "good", "bad"].filter((k) => !o || typeof o[k] !== "string" || !(o[k] as string).trim());
    if (missing.length) { problems.push(`line ${i + 1}: needs ${missing.map((k) => `"${k}"`).join(", ")} as text.`); continue; }
    if (o!.good === o!.bad) { problems.push(`line ${i + 1}: "good" and "bad" are the same text, so they cannot show a difference.`); continue; }
    examples.push({ input: o!.input as string, good: o!.good as string, bad: o!.bad as string });
  }
  if (!problems.length && examples.length === 0) problems.push("The examples file has no examples. Write one JSON object per line: {\"input\": \"...\", \"good\": \"...\", \"bad\": \"...\"}.");
  return problems.length ? { ok: false, problems } : { ok: true, examples };
}

export const RUBRIC_SYSTEM = [
  "You write a judging rubric. A judge will use it to compare two outputs for the same input and pick the better one.",
  "You get examples. Each has an input, a better output and a worse output, as a person judged them.",
  "Find what makes the better outputs better. Write criteria that a judge can apply to new inputs, not only to these examples.",
  "Do not reward an output only for being longer, or only for coming first.",
  "Reply with only the rubric, in Markdown: a short title, then numbered criteria, most important first.",
].join("\n");

export function rubricUser(examples: Example[]): string {
  return examples.map((e, i) => `## Example ${i + 1}\n\nInput:\n${e.input}\n\nBetter output:\n${e.good}\n\nWorse output:\n${e.bad}`).join("\n\n");
}

/** The id of the case for example `i` (0-based), in cases.jsonl and in messages. */
export const caseId = (i: number) => `ex-${i + 1}`;

// compare.js: the compare command for measure.judge. It has no dependencies, so it runs in any project: CommonJS or
// ESM (it uses only a dynamic import and process.argv), with Node 18 or later for fetch. It reads rubric.md from its
// own folder, so a person can edit the rubric without touching the script.
// The key: for Anthropic, SYNTHE_ANTHROPIC_KEY, or SYNTHE_API_KEY when it starts with sk-ant-; otherwise
// SYNTHE_API_KEY. It goes only to the provider's address and never into output. SYNTHE_ANTHROPIC_BASE_URL is honoured
// only for a loopback address, the same rule as ownKeyBaseUrl in src/model/client.ts.
export function compareScript(m: DraftModel): string {
  return `// Written by \`synthe measure draft\`. The compare command for a judged measure (swarm/GOAL.md, "The judged measure").
// stdin: {"case": {...}, "a": "...", "b": "..."}. stdout: {"winner": "a" | "b" | "tie"}.
// It asks ${m.provider === "anthropic" ? "Anthropic" : m.base_url} (model ${m.model}) to judge with the rubric in rubric.md next to this file.
// Key: ${m.provider === "anthropic" ? "SYNTHE_ANTHROPIC_KEY, or SYNTHE_API_KEY when it starts with sk-ant-" : "SYNTHE_API_KEY"}.
const PROVIDER = ${JSON.stringify(m.provider)};
const MODEL = ${JSON.stringify(m.model)};
const BASE_URL = ${JSON.stringify(m.base_url ?? null)};
const SYSTEM = "You compare two outputs for the same input, using the rubric you are given. Judge the content, not the length and not which output comes first. Reply with only a JSON object: {\\"winner\\": \\"a\\"}, {\\"winner\\": \\"b\\"} or {\\"winner\\": \\"tie\\"}.";

function fail(message) {
  process.stderr.write(message + "\\n");
  process.exit(1);
}

function anthropicBase(env) {
  const override = (env.SYNTHE_ANTHROPIC_BASE_URL || "").trim();
  if (override) {
    try {
      const u = new URL(override);
      if ((u.protocol === "http:" || u.protocol === "https:") && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) return override.replace(/\\/+$/, "");
    } catch {}
  }
  return "https://api.anthropic.com";
}

async function ask(user) {
  const env = process.env;
  if (PROVIDER === "anthropic") {
    const apiKey = (env.SYNTHE_ANTHROPIC_KEY || "").trim() || ((env.SYNTHE_API_KEY || "").trim().startsWith("sk-ant-") ? env.SYNTHE_API_KEY.trim() : "");
    if (!apiKey) fail("compare.js needs a key: set SYNTHE_ANTHROPIC_KEY.");
    const res = await fetch(anthropicBase(env) + "/v1/messages", {
      method: "POST", redirect: "error",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 300, system: SYSTEM, messages: [{ role: "user", content: user }] }),
    });
    if (!res.ok) fail("The model call failed with HTTP " + res.status + ".");
    const body = await res.json();
    return (body.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  }
  const apiKey = (env.SYNTHE_API_KEY || "").trim();
  if (!apiKey) fail("compare.js needs a key: set SYNTHE_API_KEY.");
  const res = await fetch(BASE_URL.replace(/\\/+$/, "") + "/chat/completions", {
    method: "POST", redirect: "error",
    headers: { "content-type": "application/json", authorization: "Bearer " + apiKey },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }] }),
  });
  if (!res.ok) fail("The model call failed with HTTP " + res.status + ".");
  const body = await res.json();
  return (body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content) || "";
}

// The winner in a reply: a JSON object with "winner", or a reply that is only a, b or tie.
function winnerIn(text) {
  const tries = [text, (text.match(/\\{[\\s\\S]*\\}/) || [])[0]];
  for (const t of tries) {
    if (!t) continue;
    try {
      const w = String(JSON.parse(t).winner || "").trim().toLowerCase();
      if (w === "a" || w === "b" || w === "tie") return w;
    } catch {}
  }
  const bare = text.trim().toLowerCase().replace(/[^a-z]/g, "");
  return bare === "a" || bare === "b" || bare === "tie" ? bare : null;
}

(async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const rubric = fs.readFileSync(path.join(path.dirname(path.resolve(process.argv[1])), "rubric.md"), "utf8");
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let q;
  try { q = JSON.parse(raw); } catch { fail("compare.js needs a JSON object on stdin."); }
  const input = typeof q.case?.input === "string" ? q.case.input : JSON.stringify(q.case?.input ?? null);
  const user = "Rubric:\\n" + rubric + "\\n\\nInput:\\n" + input + "\\n\\nOutput A:\\n" + q.a + "\\n\\nOutput B:\\n" + q.b + "\\n\\nWhich output is better by the rubric?";
  const text = await ask(user);
  const winner = winnerIn(text);
  if (!winner) fail("The model's reply did not name a winner.");
  process.stdout.write(JSON.stringify({ winner }) + "\\n");
})().catch((e) => fail("compare.js failed: " + (e && e.message ? e.message : String(e))));
`;
}

/** The key for a provider. For Anthropic, SYNTHE_ANTHROPIC_KEY, or SYNTHE_API_KEY only when it is an Anthropic key. */
export function providerKey(provider: Provider, env: NodeJS.ProcessEnv): string {
  if (provider === "anthropic") {
    const own = env.SYNTHE_ANTHROPIC_KEY?.trim();
    if (own) return own;
    const shared = env.SYNTHE_API_KEY?.trim() ?? "";
    return shared.startsWith("sk-ant-") ? shared : "";
  }
  return env.SYNTHE_API_KEY?.trim() ?? "";
}

/**
 * What `measure draft` gives the compare.js it just wrote, for its own agreement check: the one key for the
 * provider, under the name compare.js reads for that provider, and for Anthropic the loopback test address. Nothing
 * else. A key for another provider (a non-Anthropic SYNTHE_API_KEY with the Anthropic provider) is never passed on.
 * `solve` never calls this: inside solve, problem commands never get a key (GOAL-2.md).
 */
export function compareEnv(m: DraftModel, env: NodeJS.ProcessEnv): Record<string, string> {
  const key = providerKey(m.provider, env);
  if (!key) return {};
  if (m.provider !== "anthropic") return { SYNTHE_API_KEY: key };
  const base = env.SYNTHE_ANTHROPIC_BASE_URL?.trim();
  return { SYNTHE_ANTHROPIC_KEY: key, ...(base ? { SYNTHE_ANTHROPIC_BASE_URL: base } : {}) };
}

export interface Verdict { id: string; input: string; goodFirst: string; badFirst: string; agrees: boolean }

export type Ask = (question: { case: { id: string; input: string }; a: string; b: string }) => Promise<string>;

/**
 * Asks the judge about each example twice: good as a, then good as b. The judge agrees with the person on an example
 * only when it picks the good output both times; a tie, a failed call or a pick that follows the position does not.
 */
export async function checkJudge(examples: Example[], ask: Ask, limit = 4): Promise<Verdict[]> {
  const out: Verdict[] = new Array(examples.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, examples.length) }, async () => {
    while (next < examples.length) {
      const i = next++;
      const e = examples[i];
      const c = { id: caseId(i), input: e.input };
      const [goodFirst, badFirst] = await Promise.all([ask({ case: c, a: e.good, b: e.bad }), ask({ case: c, a: e.bad, b: e.good })]);
      out[i] = { id: c.id, input: e.input, goodFirst, badFirst, agrees: goodFirst === "a" && badFirst === "b" };
    }
  }));
  return out;
}

/** Runs compare.js once. Returns "a", "b", "tie", or a plain reason why it gave no answer. */
export async function runCompare(script: string, question: unknown, env: Record<string, string>, hide: (t: string) => string): Promise<string> {
  const file = resolve(script);
  const r = await runCommand(resolve(file, ".."), `node ${JSON.stringify(file)}`, { stdin: JSON.stringify(question), env, timeoutMs: 120_000 });
  if (!r.ok) return `failed: ${hide((r.stderr || r.stdout).trim().split("\n").slice(-1)[0] || `exit ${r.code}`)}`;
  try {
    const w = (JSON.parse(r.stdout.trim().split("\n").filter(Boolean).at(-1) ?? "") as { winner?: unknown }).winner;
    return w === "a" || w === "b" || w === "tie" ? w : "failed: no winner";
  } catch { return "failed: the output was not JSON"; }
}

export interface DraftIo { say(line: string): void; env: NodeJS.ProcessEnv; hide(text: string): string }

const shortText = (s: string) => { const one = s.replace(/\s+/g, " ").trim(); return one.length > 60 ? `${one.slice(0, 57)}...` : one; };

/**
 * The whole command once the model is known. Returns the exit code: 0 when the judge agrees on at least 80% of the
 * examples, 2 when it does not (the files stay, so the person can edit the rubric), 1 when the model call fails.
 */
export async function draftMeasure(examples: Example[], m: DraftModel, client: Model, outDir: string, io: DraftIo): Promise<number> {
  const reply = await client.ask({ model: m.model, system: RUBRIC_SYSTEM, user: rubricUser(examples), maxTokens: RUBRIC_MAX_TOKENS });
  const rubric = reply.text?.trim();
  if (!rubric) { io.say("The model gave no rubric. Nothing was written. Run the command again, or try another model."); return 1; }

  mkdirSync(outDir, { recursive: true });
  const cases = examples.map((e, i) => JSON.stringify({ id: caseId(i), input: e.input })).join("\n") + "\n";
  writeFileSync(join(outDir, "cases.jsonl"), cases);
  writeFileSync(join(outDir, "rubric.md"), rubric + "\n");
  const script = join(outDir, "compare.js");
  writeFileSync(script, compareScript(m));
  io.say(`Wrote ${join(outDir, "cases.jsonl")} (${examples.length} cases), ${join(outDir, "rubric.md")} and ${script}.`);

  const env = compareEnv(m, io.env);
  const verdicts = await checkJudge(examples, (q) => runCompare(script, q, env, io.hide));
  const agree = verdicts.filter((v) => v.agrees).length;
  io.say(`agreement ${agree}/${examples.length}`);
  const failures = verdicts.filter((v) => v.goodFirst.startsWith("failed") || v.badFirst.startsWith("failed"));
  if (failures.length) io.say(`compare.js gave no answer for ${failures.length} example${failures.length === 1 ? "" : "s"}, for example: ${(failures[0].goodFirst.startsWith("failed") ? failures[0].goodFirst : failures[0].badFirst).replace(/^failed: /, "")}`);

  if (agree / examples.length < AGREEMENT_NEEDED) {
    io.say(`The judge agreed with your labels on ${agree} of ${examples.length} examples. Synthe needs at least ${Math.round(AGREEMENT_NEEDED * 100)}% before a measure is fair to use.`);
    io.say("The judge disagreed on:");
    for (const v of verdicts.filter((x) => !x.agrees)) {
      io.say(`  ${v.id} (${JSON.stringify(shortText(v.input))}): with good first it said ${v.goodFirst}; with good second it said ${v.badFirst}.`);
    }
    io.say(`Next: edit ${join(outDir, "rubric.md")} so it explains why the good outputs are better, then run the command again.`);
    return 2;
  }
  // GOAL-2.md: inside solve, problem commands never get the key, so solve uses the rubric through its own model judge.
  io.say("The judge agrees with you often enough. To use it in solve, put this measure in your problem file, with the paths relative to the problem file, and keep the model section that you drafted with:");
  io.say(`  "measure": { "judge": { "cases": "${join(outDir, "cases.jsonl")}", "run": "<the command that prints the output for one case>", "compare": "model", "rubric": "${join(outDir, "rubric.md")}" } }`);
  io.say(`To try the judge by hand, run: echo '{"case": {...}, "a": "...", "b": "..."}' | node ${script}`);
  return 0;
}

export function examplesFile(path: string): { ok: true; examples: Example[] } | { ok: false; problems: string[] } {
  if (!existsSync(path)) return { ok: false, problems: [`--examples: Synthe can't find ${path}.`] };
  return readExamples(readFileSync(path, "utf8"));
}
