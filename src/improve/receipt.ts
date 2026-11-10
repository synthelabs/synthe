import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import packageJson from "../../package.json" with { type: "json" };
import { redactSecrets } from "../core/safety.ts";
import { normalizeTeamCode, PROXY_URL, TEAM_CODE, type Ask, type Model, type Reply } from "../model/client.ts";
import { setupInstallId } from "../model/install.ts";
import type { ImproveConfig, Measurement } from "./config.ts";
import type { Exec } from "./exec.ts";
import type { Edit, ShownFile } from "./writer.ts";

// On event credit, the organizers receive a record of the whole run: every line this terminal shows, the answers and
// flags, each model call, each candidate as a diff, each measurement and the result. It goes to the Crimson proxy in
// batches during the run and is never awaited by the run itself: a dead proxy costs nothing but the record. Runs on
// the team's own key send nothing. Every string is redacted here and again on the server.

export const RECORD_NOTICE = "Event credit: the organizers receive a record of this run — what this terminal shows, your settings, the code changes Claude proposes and the measurements; secrets are removed.";
export const RECORD_NOTICE_VERSION = "crimson-improve-2026-11-v1";
export const MAX_BATCH_BYTES = 64 * 1024; // the proxy's limit per request
export const MAX_BATCH_EVENTS = 200;
export const MAX_DIFF_CHARS = 20 * 1024;
export const MAX_TAIL_CHARS = 2048;
export const SEND_TIMEOUT_MS = 5_000;
// After this many sends in a row fail, the rest of the run is not sent: a dead proxy must not slow the exit either.
export const GIVE_UP_AFTER = 2;
const CLOSE_WAIT_MS = 6_000;
const EVENT_BUDGET = 40 * 1024; // leaves room for the run and summary fields in every batch

export type Command = "improve" | "improve --handoff" | "improve --list" | "submit";
export interface RoundSummary { n: number; kept: boolean; summary: string; value: number | null; why: string; cost_usd: number | null }
export interface Summary {
  metric: { label: string; unit: string; direction: "higher" | "lower"; preset: string } | null;
  baseline: { median: number; runs: number[] } | null;
  best: { median: number } | null;
  rounds: RoundSummary[];
  stop_reason: string | null;
  cost_usd: number | null;
  pr_url: string | null;
  mode: "auto" | "review" | null;
  status: "running" | "finished";
  outcome: string | null;
}
export interface RecordEnv extends Partial<Record<string, string>> {}
export interface RecordOptions {
  env: RecordEnv; command: Command; agent: boolean;
  fetcher?: typeof fetch; installId?: () => string; now?: () => Date; version?: string; node?: string; platform?: string; arch?: string;
}
// What the CLI's io looks like to the recorder: enough to wrap, without importing the cli module.
export interface RecordIo { say(t: string): void; ask(q: string): Promise<string>; exec: Exec }

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩؜]/g;
const SHAPES: [RegExp, string][] = [
  [/\bcrim(-[a-z0-9]{4}){4}\b/gi, "[team code removed]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[token removed]"],
  [/\bbearer[ \t]+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [token removed]"],
  [/\b(github_pat_[A-Za-z0-9_]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,})\b/g, "[key removed]"],
];

// Text that may leave this machine: secrets by shape, this run's own codes by value, no control or bidi characters.
export function cleanText(text: string, env: RecordEnv, max: number): string {
  let out = redactSecrets(String(text)).replace(CONTROL, "");
  for (const [shape, replacement] of SHAPES) out = out.replace(shape, replacement);
  for (const [name, replacement] of [["SYNTHE_EVENT_CODE", "[event code removed]"], ["SYNTHE_TEAM_CODE", "[team code removed]"], ["SYNTHE_ANTHROPIC_KEY", "[key removed]"], ["ANTHROPIC_API_KEY", "[key removed]"], ["GH_TOKEN", "[token removed]"], ["GITHUB_TOKEN", "[token removed]"]] as const) {
    const value = env[name]?.trim();
    if (value && value.length >= 4) out = out.split(value).join(replacement);
  }
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

const lines = (text: string) => (text === "" ? [] : text.replace(/\n$/, "").split("\n"));

// A unified diff of one file, from the common-prefix and common-suffix lines with three lines of context. Not minimal
// when a file has several edits, but every line it shows is real, and the organizers read it, not patch(1).
export function unifiedDiff(path: string, before: string, after: string): string {
  const a = lines(before), b = lines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const ctxBefore = Math.min(3, start), ctxAfter = Math.min(3, end);
  const removed = a.slice(start, a.length - end), added = b.slice(start, b.length - end);
  const head = a.slice(start - ctxBefore, start), tail = a.slice(a.length - end, a.length - end + ctxAfter);
  const oldLen = ctxBefore + removed.length + ctxAfter, newLen = ctxBefore + added.length + ctxAfter;
  const oldStart = before === "" ? 0 : start - ctxBefore + 1, newStart = after === "" ? 0 : start - ctxBefore + 1;
  const body = [...head.map((l) => ` ${l}`), ...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`), ...tail.map((l) => ` ${l}`)];
  return [`--- ${before === "" ? "/dev/null" : `a/${path}`}`, `+++ ${after === "" ? "/dev/null" : `b/${path}`}`, `@@ -${oldStart},${oldLen} +${newStart},${newLen} @@`, ...body].join("\n");
}

// The model's edits applied to the files as the model saw them (secrets already redacted), so the diff shows exactly
// what was proposed and nothing the real file holds that the model did not see.
export function candidateDiff(shown: ShownFile[], edits: Edit[]): { diff: string; cut: boolean; files: string[] } {
  const texts = new Map(shown.map((f) => [f.path, { before: f.text, after: f.text }]));
  for (const e of edits) {
    if (typeof e?.path !== "string" || typeof e.search !== "string" || typeof e.replace !== "string") continue;
    const path = e.path.trim().replace(/^\.\//, "");
    const entry = texts.get(path) ?? { before: "", after: "" };
    if (e.search === "") entry.after = entry.after === "" ? e.replace : entry.after;
    else {
      const at = entry.after.indexOf(e.search);
      // Not found as written (a CRLF file, or a search text that is not in the file): show the edit as the model wrote it.
      entry.after = at === -1 ? `${entry.after}\n@@ edit not applied: search text not found @@\n-${e.search.split("\n").join("\n-")}\n+${e.replace.split("\n").join("\n+")}` : entry.after.slice(0, at) + e.replace + entry.after.slice(at + e.search.length);
    }
    texts.set(path, entry);
  }
  const files = [...texts].filter(([, t]) => t.before !== t.after).map(([path]) => path);
  let diff = files.map((path) => unifiedDiff(path, texts.get(path)!.before, texts.get(path)!.after)).join("\n");
  const cut = diff.length > MAX_DIFF_CHARS;
  if (cut) diff = `${diff.slice(0, MAX_DIFF_CHARS)}\n... cut at ${Math.round(MAX_DIFF_CHARS / 1024)} KB`;
  return { diff, cut, files };
}

const purposeOf = (a: Ask) => {
  const props = (a.schema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
  return "paths" in props ? "pick" : "edits" in props ? "propose" : "other";
};
const firstLine = (e: unknown) => ((e as Error)?.message ?? String(e)).trim().split("\n")[0];
const tailOf = (text: string) => (text.length > MAX_TAIL_CHARS ? text.slice(-MAX_TAIL_CHARS) : text);

export class RunRecord {
  readonly runId = randomUUID();
  readonly summary: Summary = { metric: null, baseline: null, best: null, rounds: [], stop_reason: null, cost_usd: null, pr_url: null, mode: null, status: "running", outcome: null };
  readonly run: { version: string; node: string; platform: string; arch: string; repo: string | null; default_branch: string | null; head: string | null; agent: boolean; command: Command; notice: string; started: string };
  readonly sent: { seq: number; events: number; status: number | null }[] = [];
  private pending: Record<string, unknown>[] = [];
  private pendingBytes = 0;
  private seq = 0;
  private count = 0;
  private chain: Promise<void> = Promise.resolve();
  private failures = 0;
  private closed = false;
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly o: RecordOptions;

  constructor(o: RecordOptions) {
    this.o = o;
    const now = (o.now ?? (() => new Date()))();
    this.run = {
      version: o.version ?? packageJson.version, node: o.node ?? process.version, platform: o.platform ?? process.platform, arch: o.arch ?? process.arch,
      repo: null, default_branch: null, head: null, agent: o.agent, command: o.command, notice: RECORD_NOTICE_VERSION, started: now.toISOString(),
    };
    this.url = `${(o.env.SYNTHE_PROXY_URL || PROXY_URL).replace(/\/+$/, "")}/improve`;
    this.headers = {
      "content-type": "application/json", "x-synthe-event": o.env.SYNTHE_EVENT_CODE!.trim(), "x-synthe-team": normalizeTeamCode(o.env.SYNTHE_TEAM_CODE!),
      "x-synthe-install": (o.installId ?? (() => setupInstallId(process.env)))(),
    };
  }

  get dead(): boolean { return this.failures >= GIVE_UP_AFTER; }
  get batches(): number { return this.seq; }

  private clean(text: unknown, max: number): string | null { return text === null || text === undefined ? null : cleanText(String(text), this.o.env, max); }
  private now(): string { return (this.o.now ?? (() => new Date()))().toISOString(); }

  // One record of something that happened. Strings are cleaned here; numbers and booleans pass as they are.
  event(type: string, data: Record<string, unknown> = {}): void {
    if (this.closed) return;
    const out: Record<string, unknown> = { i: ++this.count, t: this.now(), type };
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue;
      if (typeof value === "string") out[key] = this.clean(value, key === "diff" ? MAX_DIFF_CHARS + 100 : key === "text" || key === "tail" || key === "card" || key === "stack" || key === "goal" ? 4000 : 500);
      else if (Array.isArray(value)) out[key] = value.slice(0, 50).map((item) => (typeof item === "string" ? this.clean(item, 500) : typeof item === "number" && Number.isFinite(item) ? item : null));
      else if (typeof value === "number") out[key] = Number.isFinite(value) ? value : null;
      else out[key] = value ?? null;
    }
    this.pending.push(out);
    this.pendingBytes += JSON.stringify(out).length + 1;
    if (this.pendingBytes >= EVENT_BUDGET || this.pending.length >= MAX_BATCH_EVENTS) this.flush();
  }

  setRepo(repo: string | null, defaultBranch: string | null, head: string | null): void {
    this.run.repo = repo && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[\w.-]{1,100}$/.test(repo) ? repo : null;
    this.run.default_branch = defaultBranch ? cleanText(defaultBranch, this.o.env, 100) : null;
    this.run.head = head && /^[0-9a-f]{40}$/.test(head) ? head : null;
  }

  configured(config: ImproveConfig): void {
    this.summary.metric = { label: cleanText(config.metric.label, this.o.env, 80), unit: cleanText(config.metric.unit, this.o.env, 20), direction: config.metric.direction, preset: config.metric.preset };
    this.summary.mode = config.mode;
    if (config.baseline.commit) this.baselined(config.baseline);
  }
  baselined(m: Measurement): void {
    this.summary.baseline = { median: m.median, runs: m.runs.slice(0, 10) };
    this.summary.best = { median: m.median };
  }
  round(r: { round: number; kept: boolean; summary: string; value: number | null; why: string; costUsd: number | null }, best: number | null): void {
    if (this.summary.rounds.length < 40) this.summary.rounds.push({ n: r.round, kept: r.kept, summary: cleanText(r.summary, this.o.env, 200), value: r.value, why: cleanText(r.why, this.o.env, 200), cost_usd: r.costUsd });
    if (best !== null) this.summary.best = { median: best };
    const costs = this.summary.rounds.map((x) => x.cost_usd);
    this.summary.cost_usd = costs.every((c) => c !== null) ? costs.reduce((a, b) => a + b!, 0) : null;
  }
  finished(outcome: string, a: { stopReason?: string | null; prUrl?: string | null; costUsd?: number | null } = {}): void {
    this.summary.status = "finished";
    this.summary.outcome = outcome;
    if (a.stopReason !== undefined) this.summary.stop_reason = a.stopReason === null ? null : cleanText(a.stopReason, this.o.env, 300);
    if (a.prUrl !== undefined) this.summary.pr_url = a.prUrl && /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[\w.-]{1,100}\/pull\/\d{1,10}$/.test(a.prUrl) ? a.prUrl : null;
    if (a.costUsd !== undefined) this.summary.cost_usd = a.costUsd;
  }

  // Everything the person sees, asks and runs goes through the record on its way.
  wrap<T extends RecordIo>(io: T): T {
    return {
      ...io,
      say: (t: string) => { this.event("say", { text: t }); io.say(t); },
      ask: async (q: string) => { const answer = await io.ask(q); this.event("ask", { question: q, answer }); return answer; },
      exec: (async (cwd, command, timeoutMs) => {
        const r = await io.exec(cwd, command, timeoutMs);
        this.event("command", { command, ok: r.ok, ms: r.ms, timed_out: r.timedOut, tail: r.ok ? null : tailOf([r.stdout.trimEnd(), r.stderr.trimEnd()].filter(Boolean).join("\n")) });
        return r;
      }) as Exec,
    };
  }
  model(m: Model): Model {
    return {
      ask: async (a: Ask): Promise<Reply> => {
        const started = performance.now(), base = { purpose: purposeOf(a), model: a.model, effort: "low", max_tokens: a.maxTokens };
        try {
          const r = await m.ask(a);
          this.event("model", { ...base, input_tokens: r.usage?.input ?? null, output_tokens: r.usage?.output ?? null, cost_usd: r.costUsd, stop_reason: r.stopReason ?? null, ms: Math.round(performance.now() - started), ok: r.text !== null, error: null });
          return r;
        } catch (e) {
          this.event("model", { ...base, input_tokens: null, output_tokens: null, cost_usd: null, stop_reason: null, ms: Math.round(performance.now() - started), ok: false, error: firstLine(e) });
          throw e;
        }
      },
    };
  }

  // Sends what is pending, in batches the proxy accepts, one after another in the background. Never throws.
  flush(final = false): Promise<void> {
    const batches: Record<string, unknown>[][] = [];
    let current: Record<string, unknown>[] = [], size = 0;
    for (const event of this.pending) {
      const length = JSON.stringify(event).length + 1;
      if (current.length && (size + length > EVENT_BUDGET || current.length >= MAX_BATCH_EVENTS)) { batches.push(current); current = []; size = 0; }
      current.push(event);
      size += length;
    }
    if (current.length || (final && !batches.length)) batches.push(current);
    this.pending = [];
    this.pendingBytes = 0;
    for (const [index, events] of batches.entries()) {
      const seq = ++this.seq, body = JSON.stringify({ schema: 1, run_id: this.runId, seq, final: final && index === batches.length - 1, run: this.run, summary: this.summary, events });
      this.chain = this.chain.then(() => this.send(seq, events.length, body));
    }
    return this.chain;
  }

  private async send(seq: number, events: number, body: string): Promise<void> {
    if (this.dead) { this.sent.push({ seq, events, status: null }); return; }
    const fetcher = this.o.fetcher ?? fetch;
    const once = async () => {
      const response = await fetcher(this.url, { method: "POST", headers: this.headers, body, signal: AbortSignal.timeout(SEND_TIMEOUT_MS), redirect: "error" });
      return response.status;
    };
    let status: number | null = null;
    try { status = await once(); } catch (e) {
      // A timeout means the proxy probably has it; only a request that never got out is tried once more.
      if ((e as Error)?.name !== "TimeoutError") { try { status = await once(); } catch { status = null; } }
    }
    this.sent.push({ seq, events, status });
    if (status !== null && status < 500) this.failures = 0;
    else this.failures++;
  }

  // The last batch, waited for only briefly: a slow or dead proxy must not hold the exit.
  async close(): Promise<void> {
    if (this.closed) return;
    const done = this.flush(true);
    this.closed = true;
    await Promise.race([done, new Promise<void>((resolve) => setTimeout(resolve, CLOSE_WAIT_MS).unref?.())]);
  }
  // Ctrl-C: nothing can be waited for; the caller races this against its own exit.
  interrupt(): Promise<void> {
    this.event("interrupt");
    if (this.summary.status === "running") this.finished("interrupted");
    return this.close();
  }
}

// A record only for runs on event credit: the team's own key means nothing is sent, and a run that could not use
// event credit (no team code) has nowhere to send it.
export function startRecord(o: RecordOptions): RunRecord | null {
  if (o.env.SYNTHE_ANTHROPIC_KEY?.trim()) return null;
  if (!o.env.SYNTHE_EVENT_CODE?.trim() || !TEAM_CODE.test(normalizeTeamCode(o.env.SYNTHE_TEAM_CODE ?? ""))) return null;
  try { return new RunRecord(o); } catch { return null; }
}

// Runs a command under a record: the exit, a crash, and the final batch are recorded whatever happens.
export async function recorded(record: RunRecord | null, fn: () => Promise<boolean>): Promise<boolean> {
  if (!record) return fn();
  try {
    const ok = await fn();
    if (record.summary.status === "running") record.finished(ok ? "win" : "early-exit");
    record.event("exit", { ok, code: ok ? 0 : 1 });
    return ok;
  } catch (e) {
    const error = e as Error;
    record.event("crash", { message: firstLine(e), stack: (error?.stack ?? "").split("\n").slice(0, 6).join("\n") });
    if (record.summary.status === "running") record.finished("crashed", { stopReason: firstLine(e) });
    throw e;
  } finally {
    await record.close();
  }
}
