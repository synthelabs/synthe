import { createHash } from "node:crypto";
import type { Ask, Model, Reply } from "../../src/model/client.ts";
import { costUsd } from "../../src/core/cost.ts";
import { Draws } from "../rng.ts";
import { pick, SCENARIOS, type BenchScenario, type Mark, type MenuItem, type PromptTask, type Tag } from "./tasks.ts";

// What a reply really is, behind its text. The judge and checker oracles read this, never the words.
export interface Truth { quality: number; appeal: number; length: number; checks: Mark[]; guards: Mark[]; breaks: string | null }

export type Role = "writer" | "runner" | "judge" | "checker";
export interface Usage { calls: Record<Role, number>; costUsd: number; upperUsd: Record<Role, number> }

const BASE_QUALITY = 2;
const OPENERS: Record<Tag, string> = {
  refund: "Thanks for getting in touch about a return.",
  shipping: "Thanks for asking about your delivery.",
  account: "Sorry you're having trouble with your account.",
  upset: "I'm sorry this happened.",
};
const FILLER = "Brightside Home has been selling kitchen goods since 2009 and every order is packed by hand in our warehouse. ";
const BETTER = "I've also emailed you these steps so you have them to hand.";
const WORSE = "Sorry if this is a bit unclear.";

const hash = (t: string) => createHash("sha256").update(t).digest("hex").slice(0, 16);
const between = (text: string, open: string, close: string): string | null => {
  const at = text.indexOf(open);
  if (at === -1) return null;
  const end = text.indexOf(close, at + open.length);
  return end === -1 ? null : text.slice(at + open.length, end);
};
const sum = (items: MenuItem[], f: (m: MenuItem) => number | undefined) => items.reduce((n, m) => n + (f(m) ?? 0), 0);

export const present = (task: PromptTask, prompt: string) => task.menu.filter((m) => prompt.includes(m.marker));

// The mean true quality of a prompt's replies over every case, with no runner noise: the number the loop is trying
// to raise, which it never sees.
export function trueQuality(task: PromptTask, prompt: string): number {
  const items = present(task, prompt);
  const total = SCENARIOS.reduce((n, s) => n + BASE_QUALITY + sum(items, (m) => pick(m.quality, s.tag)), 0);
  return total / SCENARIOS.length;
}

function marks(base: Record<number, Partial<Record<string, Mark>>> | undefined, count: number, items: MenuItem[], which: "checks" | "guards", tag: Tag): Mark[] {
  return Array.from({ length: count }, (_, i) => {
    let mark: Mark = pick(base?.[i], tag) ?? "-";
    if (mark === "-") return mark;
    for (const m of items) mark = pick(m[which]?.[i], tag) ?? mark;
    return mark;
  });
}

// A fake model that answers every call the round makes from the task's hidden truth: the runner writes a reply
// whose quality follows the prompt's instructions, the judge and checker mark it with the task's configured error
// and biases, and the writer proposes the task's menu in a seeded order. Every reply text maps to exactly one
// truth, so a judge call can be answered from the two texts it is shown.
export class Oracle implements Model {
  readonly usage: Usage = { calls: { writer: 0, runner: 0, judge: 0, checker: 0 }, costUsd: 0, upperUsd: { writer: 0, runner: 0, judge: 0, checker: 0 } };
  private truths = new Map<string, Truth>();
  private byInput = new Map(SCENARIOS.map((s) => [s.input, s]));
  private proposed = new Map<string, Set<string>>();
  private draws: Draws;
  private order: MenuItem[];

  readonly task: PromptTask;
  private live: Model | null;
  constructor(task: PromptTask, seed: string, order: MenuItem[], live: Model | null = null) {
    this.task = task;
    this.live = live;
    this.draws = new Draws(`${seed}:${task.name}`);
    this.order = order;
  }

  async ask(a: Ask): Promise<Reply> {
    const props = (a.schema as { properties?: Record<string, unknown> } | undefined)?.properties ?? null;
    const [role, text] = props === null ? ["runner" as const, this.runner(a)]
      : "edits" in props ? ["writer" as const, this.writer(a)]
      : "better" in props ? ["judge" as const, this.judge(a)]
      : "results" in props ? ["checker" as const, this.checks(a)]
      : "breaks" in props ? ["checker" as const, this.confirm(a)]
      : this.unknown(a);
    this.usage.calls[role]++;
    // A cost proxy from the real price list: about four characters a token, in and out.
    const input = Math.ceil(((a.system?.length ?? 0) + a.user.length) / 4);
    const cost = costUsd(a.model, { input_tokens: input, output_tokens: Math.ceil(text.length / 4) }) ?? 0;
    this.usage.costUsd += cost;
    // The most a live call could cost: the same input plus a reply that runs to its full limit.
    this.usage.upperUsd[role] += costUsd(a.model, { input_tokens: input, output_tokens: a.maxTokens }) ?? 0;
    // Live mode (scripts/bench.ts --live): the judge and checker calls go to a real model, so the table shows how a
    // real judge handles replies whose true quality is known. The writer and the agent stay scripted.
    if (this.live && (role === "judge" || role === "checker")) return this.live.ask(a);
    return { text, costUsd: cost };
  }

  private unknown(a: Ask): never {
    throw new Error(`The bench's oracle model got a call it doesn't recognise (schema keys: ${Object.keys((a.schema as any)?.properties ?? {}).join(", ")}). If the round now asks the model something new, teach bench/prompt/oracle.ts to answer it.`);
  }

  private scenario(input: string): BenchScenario {
    const s = this.byInput.get(input);
    if (!s) throw new Error(`The bench's runner got a message that isn't one of its cases: ${input.slice(0, 80)}`);
    return s;
  }

  private truthOf(text: string | null, where: string): Truth {
    const t = text === null ? undefined : this.truths.get(text);
    if (!t) throw new Error(`The bench's oracle couldn't find the ${where} it was asked to mark. If the round's ${where} tags changed, update bench/prompt/oracle.ts.`);
    return t;
  }

  private runner(a: Ask): string {
    const s = this.scenario(a.user);
    const items = present(this.task, a.system ?? "");
    const r = this.draws.next("runner", hash(a.system ?? ""), s.id);
    const noise = r < this.task.runnerNoise / 2 ? -1 : r < this.task.runnerNoise ? 1 : 0;
    const breaks = items.map((m) => pick(m.breaks, s.tag)).find((b) => b !== undefined) ?? null;
    const padding = sum(items, (m) => m.padding);
    const sentences = [OPENERS[s.tag], ...items.map((m) => pick(m.sentence, s.tag)).filter((x): x is string => Boolean(x))];
    if (noise > 0) sentences.push(BETTER);
    if (noise < 0) sentences.push(WORSE);
    const text = [...sentences, padding ? FILLER.repeat(Math.ceil(padding / FILLER.length)).slice(0, padding).trim() : ""].filter(Boolean).join(" ");
    const truth: Truth = {
      quality: BASE_QUALITY + sum(items, (m) => pick(m.quality, s.tag)) + noise,
      appeal: BASE_QUALITY + sum(items, (m) => pick(m.appeal, s.tag) ?? pick(m.quality, s.tag)) + noise,
      length: text.length,
      checks: marks(this.task.baseChecks, this.task.checks?.length ?? 0, items, "checks", s.tag),
      guards: marks(this.task.baseGuards, this.task.counter_checks?.length ?? 0, items, "guards", s.tag),
      breaks,
    };
    this.truths.set(text, truth);
    return text;
  }

  // Head to head: position bias first, then length bias, then the truth as the judge sees it, with error.
  private judge(a: Ask): string {
    const ta = between(a.user, "<reply_a>\n", "\n</reply_a>");
    const tb = between(a.user, "<reply_b>\n", "\n</reply_b>");
    const A = this.truthOf(ta, "reply_a"), B = this.truthOf(tb, "reply_b");
    const j = this.task.judge;
    const d = (what: string) => this.draws.next("judge", what, hash(ta!), hash(tb!));
    let better: "A" | "B" | "tie";
    if (d("position") < j.position) better = "A";
    else if (A.length !== B.length && d("length") < j.length) better = A.length > B.length ? "A" : "B";
    else if (A.appeal === B.appeal) better = d("error") < j.error ? (d("side") < 0.5 ? "A" : "B") : "tie";
    else {
      const right = A.appeal > B.appeal ? "A" : "B";
      better = d("error") < j.error ? (right === "A" ? "B" : "A") : right;
    }
    const ok = (t: Truth, side: string) => (t.breaks === null) !== (d(`guard-${side}`) < j.guardError);
    return JSON.stringify({ better, a_guardrail_ok: ok(A, "a"), b_guardrail_ok: ok(B, "b") });
  }

  // The team's checks or guards, from the reply's true marks, each pass flipped with the checker's error rate.
  private checks(a: Ask): string {
    const text = between(a.user, "<reply>\n", "\n</reply>");
    const t = this.truthOf(text, "reply");
    const guards = this.task.counter_checks ?? [];
    const isGuards = guards.length > 0 && guards.every((g) => a.user.includes(g)) && !(this.task.checks ?? []).some((c) => a.user.includes(c));
    const list = isGuards ? t.guards : t.checks;
    const results = list.map((m, i) => {
      if (m === "-") return { check: i + 1, applies: false, passes: false };
      const flip = this.draws.next(isGuards ? "guard" : "check", i, hash(text!)) < this.task.checkerError;
      return { check: i + 1, applies: true, passes: (m === "p") !== flip };
    });
    return JSON.stringify({ results });
  }

  // The guardrail re-check: confirms a real break by quoting it, with the checker's error rate either way.
  private confirm(a: Ask): string {
    const text = between(a.user, "<reply>\n", "\n</reply>");
    const t = this.truthOf(text, "reply");
    const wrong = this.draws.next("confirm", hash(text!)) < this.task.checkerError;
    const breaks = (t.breaks !== null) !== wrong;
    const quote = !breaks ? "" : t.breaks ?? text!.split(/(?<=[.!?]) /)[0];
    return JSON.stringify({ breaks, guardrail: breaks ? this.task.guardrails[0] : "", quote });
  }

  // Proposes the next menu edit, in the seeded order, that isn't in the prompt yet, can apply to it, and wasn't
  // already proposed for this exact prompt. With nothing left, it proposes nothing (the round rejects that).
  private writer(a: Ask): string {
    const prompt = between(a.user, "<prompt>\n", "\n</prompt>");
    if (prompt === null) throw new Error("The bench's writer couldn't find the current prompt in the writer's request. If the <prompt> tags changed, update bench/prompt/oracle.ts.");
    const key = hash(prompt);
    const done = this.proposed.get(key) ?? new Set<string>();
    this.proposed.set(key, done);
    const next = this.order.find((m) => !prompt.includes(m.marker) && !done.has(m.id) && (m.find === "" || prompt.includes(m.find)));
    if (!next) return JSON.stringify({ edits: [], summary: "Nothing new to try.", title: "nothing new" });
    done.add(next.id);
    return JSON.stringify({ edits: [{ find: next.find, replace: next.replace }], summary: next.summary, title: next.title });
  }
}
