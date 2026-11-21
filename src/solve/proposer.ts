import { spawn } from "node:child_process";
import { childEnv } from "../improve/exec.ts";

// The outside proposer protocol from swarm/GOAL.md: one JSON object on stdin, one JSON object on stdout.
// A proposer is someone else's code, so nothing it does may crash the run: every failure becomes a reason.

export interface ProposerFile { path: string; text: string }
export interface ProposerHistoryEntry { round: number; summary: string; kept: boolean; reason: string }
export interface ProposerInput {
  round: number;
  goal: string;
  files: ProposerFile[];
  history: ProposerHistoryEntry[];
  candidates: number;
}
export interface ProposerEdit { path: string; search: string; replace: string }
export interface Proposal { summary: string; edits: ProposerEdit[] }

// One entry for each proposal the proposer sent. A malformed proposal is kept as a failure with a reason,
// so the loop can record it as an attempt and the other proposals in the reply still count.
export type ProposalItem = { ok: true; proposal: Proposal } | { ok: false; summary: string; reason: string };

export type ProposerReply =
  | { kind: "proposals"; items: ProposalItem[] }
  | { kind: "empty"; reason: string }
  | { kind: "failed"; reason: string };

export const NOTHING_MORE = "The proposer has nothing more to try.";
export const PROPOSER_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT = 8 * 1024 * 1024;

// Only the four fields the protocol names reach the proposer. Numbers such as before/after (and so any holdout
// score) stay out even when the caller passes a richer attempt record.
export function proposerInput(input: ProposerInput): ProposerInput {
  return {
    round: input.round,
    goal: input.goal,
    files: input.files.map((f) => ({ path: f.path, text: f.text })),
    history: input.history.map((h) => ({ round: h.round, summary: h.summary, kept: h.kept, reason: h.reason })),
    candidates: input.candidates,
  };
}

const short = (s: string, n = 200) => {
  const one = s.trim().replace(/\s+/g, " ");
  return one.length > n ? `${one.slice(0, n)}...` : one;
};

function parseJson(stdout: string): unknown {
  const text = stdout.trim();
  try { return JSON.parse(text); } catch { /* try the last line below */ }
  // A proposer may print log lines before its answer; the answer is then the last line.
  const last = text.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
  try { return JSON.parse(last); } catch { return undefined; }
}

function checkProposal(raw: unknown, n: number): ProposalItem {
  const label = `proposal ${n}`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, summary: label, reason: `The proposer's ${label} is not a JSON object.` };
  const p = raw as Record<string, unknown>;
  const summary = typeof p.summary === "string" && p.summary.trim() ? p.summary.trim() : label;
  if (typeof p.summary !== "string") return { ok: false, summary, reason: `The proposer's ${label} has no "summary" text.` };
  if (!Array.isArray(p.edits)) return { ok: false, summary, reason: `The proposer's ${label} has no "edits" list.` };
  if (p.edits.length === 0) return { ok: false, summary, reason: `The proposer's ${label} has an empty "edits" list, so it changes nothing.` };
  const edits: ProposerEdit[] = [];
  for (const [i, e] of p.edits.entries()) {
    const edit = e as Record<string, unknown> | null;
    const bad = !edit || typeof edit !== "object" || Array.isArray(edit);
    for (const field of ["path", "search", "replace"] as const) {
      if (bad || typeof edit[field] !== "string") return { ok: false, summary, reason: `Edit ${i + 1} of the proposer's ${label} has no "${field}" text.` };
    }
    const { path, search, replace } = edit as unknown as ProposerEdit;
    if (!path.trim()) return { ok: false, summary, reason: `Edit ${i + 1} of the proposer's ${label} has an empty "path".` };
    if (search === "") return { ok: false, summary, reason: `Edit ${i + 1} of the proposer's ${label} has an empty "search", so it can not match exactly once.` };
    edits.push({ path, search, replace });
  }
  return { ok: true, proposal: { summary, edits } };
}

export function parseProposerReply(stdout: string): ProposerReply {
  if (!stdout.trim()) return { kind: "failed", reason: "The proposer printed nothing on stdout. It must print one JSON object." };
  const data = parseJson(stdout);
  if (data === undefined) return { kind: "failed", reason: `The proposer's reply is not valid JSON: ${short(stdout, 120)}` };
  if (!data || typeof data !== "object" || Array.isArray(data)) return { kind: "failed", reason: "The proposer's reply is not a JSON object with a \"proposals\" list." };
  const proposals = (data as Record<string, unknown>).proposals;
  if (!Array.isArray(proposals)) return { kind: "failed", reason: "The proposer's reply has no \"proposals\" list." };
  if (proposals.length === 0) return { kind: "empty", reason: NOTHING_MORE };
  return { kind: "proposals", items: proposals.map((p, i) => checkProposal(p, i + 1)) };
}

export interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; error?: string }
export type RunWithStdin = (command: string, cwd: string, stdin: string, timeoutMs: number) => Promise<RunResult>;

export const runWithStdin: RunWithStdin = (command, cwd, stdin, timeoutMs) => new Promise((resolve) => {
  const win = process.platform === "win32";
  // Its own process group off Windows, so a timeout stops the proposer and everything it started.
  const child = spawn(win ? "cmd" : "sh", [win ? "/c" : "-c", command], { cwd, env: childEnv(), stdio: ["pipe", "pipe", "pipe"], detached: !win });
  let stdout = "", stderr = "", timedOut = false, error: string | undefined, done = false;
  child.stdout.on("data", (d: Buffer) => { if (stdout.length < MAX_OUTPUT) stdout += d.toString(); });
  child.stderr.on("data", (d: Buffer) => { if (stderr.length < MAX_OUTPUT) stderr += d.toString(); });
  const timer = setTimeout(() => {
    timedOut = true;
    try { if (win) child.kill("SIGKILL"); else process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ }
  }, timeoutMs);
  const finish = (code: number | null) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    resolve({ code, stdout, stderr, timedOut, error });
  };
  child.on("error", (e) => { error = e.message; finish(null); });
  child.on("close", finish);
  // A proposer that exits without reading stdin closes the pipe first; that is its choice, not a crash.
  child.stdin.on("error", () => {});
  child.stdin.end(stdin);
});

export interface AskOptions { timeoutMs?: number; run?: RunWithStdin }

// Run the proposer command in the folder that holds the problem file and read its reply.
export async function askProposer(command: string, cwd: string, input: ProposerInput, opts: AskOptions = {}): Promise<ProposerReply> {
  const timeoutMs = opts.timeoutMs ?? PROPOSER_TIMEOUT_MS;
  const run = opts.run ?? runWithStdin;
  let result: RunResult;
  try {
    result = await run(command, cwd, `${JSON.stringify(proposerInput(input))}\n`, timeoutMs);
  } catch (e) {
    return { kind: "failed", reason: `The proposer command could not start: ${short(e instanceof Error ? e.message : String(e))}` };
  }
  if (result.error) return { kind: "failed", reason: `The proposer command could not start: ${short(result.error)}` };
  if (result.timedOut) return { kind: "failed", reason: `The proposer command did not finish in ${Math.round(timeoutMs / 1000)} seconds and was stopped.` };
  if (result.code !== 0) {
    const detail = short(result.stderr || result.stdout);
    return { kind: "failed", reason: `The proposer command exited with code ${result.code}${detail ? `: ${detail}` : "."}` };
  }
  return parseProposerReply(result.stdout);
}
