import { modelProposer } from "./model-proposer.ts";
import { runCommand, type RunOptions, type RunResult } from "./run.ts";
import type { Edit, Problem, Proposal, Proposer, ProposerReply, ProposerRequest } from "./types.ts";

// The outside proposer protocol from swarm/GOAL.md: one JSON object on stdin, one JSON object on stdout.
// A proposer is someone else's code, so nothing it does may crash the run: every failure becomes a reason.
// Owner: P03.

export const PROPOSER_TIMEOUT_MS = 10 * 60_000;

// Only the fields the protocol names reach the proposer. Numbers such as before/after (and so any holdout score)
// stay out even when the caller passes a richer attempt record.
export function requestObject(r: ProposerRequest): ProposerRequest {
  return {
    round: r.round,
    goal: r.goal,
    files: r.files.map((f) => ({ path: f.path, text: f.text })),
    history: r.history.map((h) => ({ round: h.round, summary: h.summary, kept: h.kept, reason: h.reason })),
    candidates: r.candidates,
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

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

// A plain reason when one proposal has the wrong shape, else the proposal.
// The summary of a malformed proposal, when it has one, so its failed attempt is named in the history.
const summaryOf = (raw: unknown): string | undefined =>
  isObject(raw) && typeof raw.summary === "string" && raw.summary.trim() ? raw.summary.trim() : undefined;

function checkProposal(raw: unknown, n: number): Proposal | string {
  const label = `proposal ${n}`;
  if (!isObject(raw)) return `The proposer's ${label} is not a JSON object.`;
  if (typeof raw.summary !== "string") return `The proposer's ${label} has no "summary" text.`;
  if (!Array.isArray(raw.edits)) return `The proposer's ${label} has no "edits" list.`;
  if (raw.edits.length === 0) return `The proposer's ${label} has an empty "edits" list, so it changes nothing.`;
  const edits: Edit[] = [];
  for (const [i, e] of raw.edits.entries()) {
    const where = `Edit ${i + 1} of the proposer's ${label}`;
    if (!isObject(e)) return `${where} is not a JSON object.`;
    for (const field of ["path", "search", "replace"] as const) {
      if (typeof e[field] !== "string") return `${where} has no "${field}" text.`;
    }
    const { path, search, replace } = e as unknown as Edit;
    if (!path.trim()) return `${where} has an empty "path".`;
    edits.push({ path, search, replace });
  }
  return { summary: raw.summary.trim() || label, edits };
}

// Parses the proposer's stdout. An empty `proposals` list is valid: the loop stops with "nothing more to try".
export function parseReply(stdout: string): ProposerReply {
  if (!stdout.trim()) return { failed: "The proposer printed nothing on stdout. It must print one JSON object." };
  const data = parseJson(stdout);
  if (data === undefined) return { failed: `The proposer's reply is not valid JSON: ${short(stdout, 120)}` };
  if (!isObject(data)) return { failed: "The proposer's reply is not a JSON object with a \"proposals\" list." };
  if (!Array.isArray(data.proposals)) return { failed: "The proposer's reply has no \"proposals\" list." };
  const proposals: Proposal[] = [];
  for (const [i, raw] of data.proposals.entries()) {
    const p = checkProposal(raw, i + 1);
    if (typeof p === "string") { const summary = summaryOf(raw); return summary ? { failed: p, summary } : { failed: p }; }
    proposals.push(p);
  }
  return { proposals };
}

// Turns a finished proposer command into a reply. Exported for tests.
export function replyFrom(result: RunResult, timeoutMs: number): ProposerReply {
  if (result.timedOut) return { failed: `The proposer command did not finish in ${Math.round(timeoutMs / 1000)} seconds and was stopped.` };
  if (!result.ok) {
    const detail = short(result.stderr || result.stdout);
    return { failed: `The proposer command ${result.code === null ? "could not start" : `exited with code ${result.code}`}${detail ? `: ${detail}` : "."}` };
  }
  return parseReply(result.stdout);
}

export type RunFn = (cwd: string, command: string, o: RunOptions) => Promise<RunResult>;

// The outside proposer: runs `command` in problem.dir (the folder that holds the problem file), writes the request
// to stdin and parses stdout. It never throws and uses no model calls.
export function commandProposer(problem: Problem, o: { timeoutMs?: number; run?: RunFn } = {}): Proposer {
  if (problem.proposer === "model") throw new Error("commandProposer needs a problem with a proposer command.");
  const command = problem.proposer.command;
  const timeoutMs = o.timeoutMs ?? PROPOSER_TIMEOUT_MS;
  const run = o.run ?? runCommand;
  return {
    async propose(request) {
      let result: RunResult;
      try {
        result = await run(problem.dir, command, { stdin: `${JSON.stringify(requestObject(request))}\n`, timeoutMs });
      } catch (e) {
        return { reply: { failed: `The proposer command could not start: ${short(e instanceof Error ? e.message : String(e))}` }, calls: 0 };
      }
      return { reply: replyFrom(result, timeoutMs), calls: 0 };
    },
  };
}

// Picks the proposer the problem asks for: the outside command, or the model (model-proposer.ts, P16).
export function proposerFor(problem: Problem, env: NodeJS.ProcessEnv = process.env): Proposer {
  return problem.proposer === "model" ? modelProposer(problem, env) : commandProposer(problem);
}
