import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { GOAL_FILE } from "./goal.ts";
import { oidcToken, scrub } from "./share.ts";
import { sha256 } from "./safety.ts";
import type { RoundScores } from "./merge-rule.ts";
import type { RoundRecord } from "./state.ts";
import type { Candidate, Written } from "../loop/write.ts";
import packageJson from "../../package.json" with { type: "json" };

export const EVENTS_ENDPOINT = "https://synthe-crimson.vercel.app/api/events";
export const MAX_EVENT_BYTES = 192 * 1024;
// How long a step waits at its end for the worker to send what it holds. A write step's few events take a second or
// two; a score step's batches take longer. Past this, the job's cleanup kills the worker and the rest is lost.
export const FLUSH_MS = 15_000;
const WORDS = /^[a-z_-]{1,16}( [a-z_-]{1,16}){0,3}$/;
const KEY = /^[a-z][a-z0-9_]{0,39}$/;
const CREDENTIAL = /secret|token|password|credential|authorization|cookie|(?:^|_)key(?:$|_)|(?:team|event)_code/i;
const CONTENT_KEYS = new Set(["candidate_id", "case_id", "parent_prompt_sha256", "final_prompt_sha256", "diff", "prompt", "writer_rejection", "baseline_output", "candidate_output", "failed_checks", "reasons", "message", "no_op_reason"]);
type Env = Record<string, string | undefined>;
type Share = "numbers" | "detail" | "full";
export interface RoundEvent {
  id: string; kind: "round_start" | "candidate" | "case_result" | "decision" | "round_end" | "failure" | "cancel";
  at: string; stage: string; data: unknown;
}
export interface EventConsent { share: Share; notice: string; source_sha: string; synthe_version: string }

// Scrub both known credential formats and the actual runner secrets, including arbitrary event codes.
export function scrubEventText(text: string, env: Env): string {
  let clean = text;
  for (const [name, value] of Object.entries(env)) {
    if (value?.trim() && /secret|token|password|credential|api.?key|anthropic.*key|(?:event|team)[_-]code/i.test(name)) clean = clean.split(value.trim()).join("[removed]");
  }
  return scrub(clean)
    .replace(/\bcrim(?:-[a-z0-9]{4}){4}\b/gi, "[team code removed]")
    .replace(/\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-synthe-event|x-synthe-team)[ \t]*[:=][ \t]*[^\r\n]*/gi, "$1: [removed]")
    .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [removed]")
    .replace(/\b(?:npm_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,}|hf_[A-Za-z0-9]{20,}|ya29\.[A-Za-z0-9_-]+|[srp]k_(?:live|test)_[A-Za-z0-9]+)/g, "[key removed]")
    .replace(/(["']?)\b([\w.-]*(?:secret|token|password|credential|api[_-]?key|private[_-]?key|access[_-]?key|team[_-]?code|event[_-]?code)[\w.-]*)\1\s*[:=]\s*("[^"\r\n]*"|'[^'\r\n]*'|[^\s,}\]]+)/gi, "$2=[removed]")
    .replace(/https?:\/\/[^\s"'<>]+[?&](?:token|sig|signature|X-Amz-[\w-]+|code|key|access_token)=[^\s"'<>]*/gi, "[signed URL removed]")
    .replace(/https?:\/\/[^\s/:@]+:[^\s/@]+@[^\s"'<>]*/g, "[credential URL removed]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[private key removed]")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
}

// Null out disallowed values rather than converting them into words that might look like real measurements.
export function eventData(value: unknown, full: boolean, env: Env = {}, depth = 0): unknown {
  if (depth > 6) return null;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const clean = scrubEventText(value, env);
    return full || (clean === value && WORDS.test(clean)) ? clean : null;
  }
  if (typeof value !== "object" || !value) return null;
  // At the depth limit a container would put its children beyond the server's limit.
  if (depth === 6) return null;
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => eventData(v, full, env, depth + 1));
  return Object.fromEntries(Object.entries(value).filter(([key]) => KEY.test(key) && !CREDENTIAL.test(key)).slice(0, 50)
    .map(([key, v]) => [key, !full && CONTENT_KEYS.has(key) ? null : eventData(v, full, env, depth + 1)]));
}

export function eventBatches(consent: EventConsent, events: RoundEvent[], env: Env = {}): string[] {
  const batches: string[] = [];
  let batch: RoundEvent[] = [];
  const encode = (items: RoundEvent[]) => JSON.stringify({ schema: 1, ...consent, events: items });
  for (const event of events) {
    let clean = { ...event, data: eventData(event.data, consent.share === "full", env) };
    if (Buffer.byteLength(encode([clean])) > MAX_EVENT_BYTES) clean = { ...clean, data: { content_omitted: true } };
    if (batch.length === 50 || Buffer.byteLength(encode([...batch, clean])) > MAX_EVENT_BYTES) {
      batches.push(encode(batch)); batch = [];
    }
    batch.push(clean);
  }
  if (batch.length) batches.push(encode(batch));
  return batches;
}

interface SenderOptions {
  env?: Env; fetcher?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => number; timeoutMs?: number; onDowngrade?: () => void;
}
// All transport errors are contained here. The worker owns the waits; only flushEvents waits for it, after the step's work.
export async function sendEvents(consent: EventConsent, events: RoundEvent[], options: SenderOptions = {}): Promise<void> {
  const env = options.env ?? process.env, fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now, deadline = now() + (options.timeoutMs ?? 60_000);
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  try {
    if (!["numbers", "detail", "full"].includes(consent.share) || !/^[a-z0-9][a-z0-9.-]{0,39}$/.test(consent.notice)
      || !/^[a-f0-9]{40}$/.test(consent.source_sha) || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]{1,20})?$/.test(consent.synthe_version) || !events.length) return;
    consent = { ...consent };
    let effective = consent;
    for (const original of eventBatches(consent, events, env)) {
      let body = original;
      if (effective.share === "numbers" && consent.share === "full") {
        const batch = JSON.parse(original); body = JSON.stringify({ ...batch, share: "numbers", events: batch.events.map((e: RoundEvent) => ({ ...e, data: eventData(e.data, false, env) })) });
      }
      for (let attempt = 0; attempt < 5 && now() < deadline; attempt++) {
        const signal = AbortSignal.timeout(Math.max(1, Math.min(5_000, deadline - now())));
        const token = await oidcToken("synthe-events", env, fetcher, signal);
        const response = await fetcher(EVENTS_ENDPOINT, { method: "POST", redirect: "error", signal,
          headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body });
        if (response.ok) { await response.body?.cancel(); break; }
        // Only a policy refusal of full content can change the sharing level. Auth/deletion refusals stop uploads.
        if (response.status === 403 && effective.share === "full") {
          const text = await response.text();
          if (/full collection has ended|full sharing needs a currently accepted sharing notice/i.test(text)) {
            effective = { ...consent, share: "numbers" }; options.onDowngrade?.();
            const batch = JSON.parse(body); body = JSON.stringify({ ...batch, share: "numbers", events: batch.events.map((e: RoundEvent) => ({ ...e, data: eventData(e.data, false, env) })) });
            continue;
          }
          return;
        }
        const status = response.status, retryAfter = response.headers.get("retry-after");
        await response.body?.cancel();
        if (![409, 429, 502, 503].includes(status)) return;
        if (attempt === 4) return;
        const seconds = retryAfter === null ? NaN : Number(retryAfter);
        const requested = status === 429 && retryAfter !== null
          ? Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(retryAfter) - now()) : 0;
        const wait = Math.max(500 * 2 ** attempt, Number.isFinite(requested) ? requested : 0);
        // A Retry-After beyond our lifetime means give up, never retry earlier than the server asked.
        if (now() + wait >= deadline) return;
        await sleep(wait);
      }
    }
  } catch { /* Sharing must never change a round's outcome or log a credential-bearing error. */ }
}

// Read policy from a pinned default-branch commit, never a candidate checkout or a PR's config.
export async function eventConsent(env: Env, fetcher: typeof fetch = fetch): Promise<EventConsent | null> {
  const slug = env.GITHUB_REPOSITORY;
  if (!slug || !/^[\w.-]+\/[\w.-]+$/.test(slug)) return null;
  if (!["workflow_dispatch", "schedule", "pull_request"].includes(env.GITHUB_EVENT_NAME ?? "")) return null;
  try {
    if (env.GITHUB_EVENT_NAME === "pull_request") {
      const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH!, "utf8"));
      if (event.pull_request?.head?.repo?.full_name !== slug) return null;
    }
    const token = env["INPUT_GITHUB-TOKEN"] ?? "";
    const get = async (path: string, raw = false) => {
      const response = await fetcher(`${env.GITHUB_API_URL ?? "https://api.github.com"}/repos/${slug}${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json", "User-Agent": "synthe" },
        redirect: "error", signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error("Consent unavailable");
      return raw ? response.text() : response.json();
    };
    const branch = (await get("")).default_branch;
    const source_sha = (await get(`/git/ref/heads/${encodeURIComponent(branch)}`)).object.sha;
    const goal = JSON.parse(await get(`/contents/${GOAL_FILE}?ref=${encodeURIComponent(source_sha)}`, true));
    if (!["numbers", "detail", "full"].includes(goal.share) || typeof goal.share_notice !== "string"
      || !/^[a-z0-9][a-z0-9.-]{0,39}$/.test(goal.share_notice) || !/^[a-f0-9]{40}$/.test(source_sha)) return null;
    return { share: goal.share, notice: goal.share_notice, source_sha, synthe_version: packageJson.version };
  } catch { return null; }
}

let worker: ChildProcess | undefined;
const sending: Promise<void>[] = [];
function capture(kind: RoundEvent["kind"], stage: string, data: unknown): void {
  try {
    if (!process.env.ACTIONS_ID_TOKEN_REQUEST_URL || !process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) return;
    if (!worker) {
      worker = spawn(process.execPath, [process.argv[1], "--synthe-events-worker"], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
      worker.on("error", () => {});
      worker.unref(); worker.channel?.unref();
    }
    const event = { id: randomUUID(), kind, at: new Date().toISOString(), stage, data: eventData(data, true, process.env) };
    // Oversized content is omitted before IPC as well as on the wire, bounding the round's work.
    if (Buffer.byteLength(JSON.stringify(event)) > MAX_EVENT_BYTES) event.data = { content_omitted: true };
    const child = worker;
    if (child.connected) sending.push(new Promise((done) => { child.send(event, () => done()); }));
  } catch { /* Even spawning or serializing a sharing worker is optional. */ }
}

// Actions kills a job's leftover processes as soon as its last step ends, which took the worker down mid-upload and lost
// the events captured last (a write step's second candidate, a failure). So a step ends by handing over what it
// captured and waiting, up to a bound, for the worker to send it and exit. It never throws.
export async function flushEvents(timeoutMs = FLUSH_MS): Promise<void> {
  const child = worker;
  if (!child) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const sent = (async () => {
      await Promise.all(sending);
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((done) => child.once("exit", () => done()));
      // The worker sends everything it has queued once its channel closes, then exits.
      if (child.connected) child.disconnect();
      await exited;
    })();
    await Promise.race([sent, new Promise<void>((done) => { timer = setTimeout(done, timeoutMs); })]);
  } catch { /* Sharing must never change a step's outcome. */ } finally { clearTimeout(timer); }
}

export const captureFailure = (stage: string, error: unknown): void => capture("failure", WORDS.test(stage) ? stage : "round", { reason: "step failed", message: error instanceof Error ? error.message : null });
export const captureCancel = (stage = "round"): void => capture("cancel", stage, { reason: "cancelled" });

export async function observeRoundStep<T>(stage: "write" | "score" | "decide", context: { prompt?: string; candidates?: Candidate[] }, work: () => Promise<T>): Promise<T> {
  if (stage === "write") capture("round_start", stage, {});
  const cancel = (signal: NodeJS.Signals) => { captureCancel(stage); process.exit(signal === "SIGINT" ? 130 : 143); };
  const interrupt = () => cancel("SIGINT"), terminate = () => cancel("SIGTERM");
  process.once("SIGINT", interrupt); process.once("SIGTERM", terminate);
  try {
    const result = await work();
    // Capture is a one-way observer. Neither events nor held-back results ever enter the writer's context.
    try {
      if (stage === "write") {
        const written = result as Written;
        for (const c of written.candidates) capture("candidate", stage, { candidate_id: c.id, parent_prompt_sha256: context.prompt === undefined ? null : sha256(context.prompt), diff: c.edits ?? null, prompt: c.text, writer_rejection: null, scored: null });
        for (const rejection of written.rejected ?? []) capture("candidate", stage, { candidate_id: null, parent_prompt_sha256: context.prompt === undefined ? null : sha256(context.prompt), diff: null, prompt: null, writer_rejection: rejection, scored: false });
      } else if (stage === "score") {
        const { scores } = result as { scores: RoundScores };
        for (const c of scores.candidates) for (const split of ["train", "holdout"] as const) {
          const baseline = split === "train" ? scores.baselineTrain : scores.baselineHoldout;
          for (const row of c[split] ?? []) {
            const before = baseline.find((b) => b.id === row.id);
            capture("case_result", stage, { candidate_id: c.id, case_id: row.id, split, baseline_output: before?.reply ?? null, candidate_output: row.reply ?? null,
              baseline_score: before?.score ?? null, candidate_score: row.score, failed_checks: row.failedChecks ?? null, failed: row.failed ?? null, applicable: row.applicable ?? null,
              baseline_guard_violation: before?.violation ?? null, candidate_guard_violation: row.violation, attack_results: null });
          }
        }
      } else if (result) {
        const record = result as unknown as RoundRecord;
        const chosen = record.edits && context.candidates?.find((c) => JSON.stringify(c.edits) === JSON.stringify(record.edits));
        capture("decision", stage, { candidate_id: chosen ? chosen.id : null, accepted: record.outcome === "merged" || record.outcome === "proposed", outcome: record.outcome, reasons: record.reasons, noise: null, calibration: null });
        capture("round_end", stage, { round: record.round, outcome: record.outcome, no_op_reason: record.outcome === "skipped" ? record.reasons : null, pr: record.pr ?? null, commit: null, cost_usd: record.costUsd, final_prompt_sha256: chosen && record.outcome === "merged" ? sha256(chosen.text) : null });
      }
    } catch { /* Observing a result must not fail the operation it describes. */ }
    return result;
  } finally { process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", terminate); }
}

// The action bundle is also its own worker entry point; no extra shipped artifact or repo code is executed.
export function startEventsWorker(): boolean {
  if (process.argv[2] !== "--synthe-events-worker") return false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const consent = eventConsent(process.env).catch(() => null);
  const queue: RoundEvent[] = [];
  let draining = false, disconnected = false;
  const drain = async () => {
    if (draining) return;
    draining = true;
    try {
      const allowed = await consent;
      while (queue.length) {
        const batch = queue.splice(0, 50);
        if (allowed) await sendEvents(allowed, batch, { onDowngrade: () => { allowed.share = "numbers"; } });
      }
    } catch {} finally {
      draining = false;
      if (disconnected) { if (timeout) clearTimeout(timeout); process.exit(0); }
    }
  };
  process.on("message", (event: RoundEvent) => {
    if (queue.length < 1000) queue.push(event);
    setImmediate(() => { void drain(); });
  });
  process.on("disconnect", () => {
    disconnected = true;
    timeout = setTimeout(() => process.exit(0), 90_000);
    void drain();
  });
  return true;
}
