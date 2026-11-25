import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathProblem, rulesFor } from "./edits.ts";
import { runProgram, type RunResult } from "./run.ts";
import { isAgent, type AgentConfig, type Edit, type HistoryEntry, type Problem, type Proposal, type Proposer, type ProposerFile, type ProposerRequest } from "./types.ts";

// A coding agent (Claude Code or Codex, on the person's own plan) as the proposer (GOAL-2.md, A01).
//
// An agent is a program with its own tools: it can read any file it can reach and run any command. So the rules
// here are about what it can reach, not about what it is asked to do:
// - It runs in a new temporary folder, outside every repository, that holds only the artifact files. The measure,
//   the cases, the protected paths, the problem file and .git are not there. The agent runs as the person, so this
//   keeps them out of its view, not out of its reach: a sandbox in `args` is the only hard limit.
// - Its environment has no SYNTHE_* variable, so it gets no key that Synthe holds and no split or seed.
// - Its prompt holds only the goal, the paths and the proposer's view of the history (no number of an attempt).
// - A time limit stops its whole process group.
// - Its changes come back as one proposal, which then goes through every usual rule (edits.ts). One file outside
//   artifact refuses the whole proposal.

export const SUMMARY_MAX = 200;
const MAX_FILE_BYTES = 1024 * 1024;
// One argument holds the prompt, and an operating system limits the size of one argument (128 KiB on Linux).
const HISTORY_MAX = 40;
const REASON_MAX = 400;

const oneLine = (s: string, max: number) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
};

// The person's own environment without any SYNTHE_* variable. HOME, PATH and the person's own keys stay: the agent
// needs its own login. NODE_TEST_CONTEXT goes too, for the reason given in improve/exec.ts. PWD, OLDPWD and INIT_CWD
// go because they name the folder where solve started, which is usually the person's repository.
const NOT_FOR_AGENT = new Set(["NODE_TEST_CONTEXT", "PWD", "OLDPWD", "INIT_CWD"]);
export function agentEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !/^SYNTHE_/i.test(k) && !NOT_FOR_AGENT.has(k)));
}

// `<bin> -p <prompt>` for claude and `<bin> exec <prompt>` for codex, with the person's args before the prompt.
export function agentArgs(config: Pick<AgentConfig, "agent" | "args">, prompt: string): string[] {
  return config.agent === "claude" ? [...config.args, "-p", prompt] : ["exec", ...config.args, prompt];
}

// The prompt: the goal, the paths, the history and the instruction. Only the four protocol fields of a history
// entry are read, so a number of an attempt (and so any holdout number) cannot get in through a richer record.
export function agentPrompt(request: Pick<ProposerRequest, "goal" | "files" | "history">, artifact: string[]): string {
  const lines = [
    "Improve the files in the current folder for this goal:",
    request.goal.trim(),
    "",
  ];
  if (request.files.length) lines.push("The files:", ...request.files.map((f) => `- ${f.path}`));
  else lines.push("The folder is empty.");
  lines.push("", `You may change, add or remove only files with paths that match: ${artifact.join(", ")}`, "A change to any other path makes the whole change refused.");
  const history: HistoryEntry[] = request.history.slice(-HISTORY_MAX);
  if (history.length) {
    lines.push("", "Earlier attempts, oldest first. Do not repeat a change that was not kept:");
    if (request.history.length > history.length) lines.push("(Only the most recent attempts are shown.)");
    for (const h of history) {
      lines.push(`- Round ${h.round}, ${h.kept ? "kept" : "not kept"}: ${oneLine(h.summary, SUMMARY_MAX) || "(no summary)"} Reason: ${oneLine(h.reason, REASON_MAX)}`);
    }
  }
  lines.push(
    "",
    "Edit the files in place, in this folder. Make one focused change.",
    "The measure is not in this folder, so you cannot run it. Synthe measures your change after you exit.",
    "When you are done, print a summary of your change in one line. It must be the last line of your output.",
  );
  return lines.join("\n");
}

// The last non-empty line of the agent's stdout, at most 200 characters, or "agent change".
export function summaryOf(stdout: string): string {
  const last = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() ?? "";
  return last.slice(0, SUMMARY_MAX).trim() || "agent change";
}

// True when the .git entry marks a real repository: a .git folder with a HEAD file, or a .git file whose first line
// starts with "gitdir:" (a worktree or a submodule). An empty .git folder is ignored: some systems leave one in the
// temporary folder, and git does not treat it as a repository either.
function realGitEntry(entry: string): boolean {
  try {
    const stat = lstatSync(entry);
    if (stat.isDirectory()) return existsSync(join(entry, "HEAD"));
    if (stat.isFile()) return readFileSync(entry, "utf8").split(/\r?\n/, 1)[0].startsWith("gitdir:");
  } catch { /* gone or unreadable: not a repository marker */ }
  return false;
}

// True when the folder or a folder above it is in a real repository (realGitEntry).
function inRepository(dir: string): boolean {
  for (let d = dir; ; d = dirname(d)) {
    if (realGitEntry(join(d, ".git"))) return true;
    if (dirname(d) === d) return false;
  }
}

// A new empty folder outside every repository. Throws a plain reason when the temporary folder of the system is
// itself in a repository: the agent could then reach that repository's files.
export function makeAgentFolder(base: string = tmpdir()): string {
  const dir = realpathSync(mkdtempSync(join(realpathSync(base), "synthe-agent-")));
  if (inRepository(dir)) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`The temporary folder ${base} is inside a git repository, so the agent could read that repository. Set TMPDIR to a folder outside every repository.`);
  }
  return dir;
}

const safePath = (p: string) => Boolean(p) && !isAbsolute(p) && !p.split(/[\\/]/).some((part) => part === ".." || part === ".git" || part === "");

function copyIn(dir: string, files: ProposerFile[]): void {
  for (const f of files) {
    if (!safePath(f.path)) throw new Error(`${f.path} is not a path inside the problem folder.`);
    const file = join(dir, f.path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, f.text);
  }
}

// Every entry in the folder that is not a folder, with paths relative to it and "/" separators. Links are not
// followed.
function walk(dir: string, rel = ""): { path: string; plain: boolean; size: number }[] {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1)).flatMap((e) => {
    const path = rel ? `${rel}/${e.name}` : e.name;
    const full = join(dir, e.name);
    if (e.isDirectory()) return walk(full, path);
    const stat = lstatSync(full);
    return [{ path, plain: stat.isFile(), size: stat.size }];
  });
}

// Compares the folder with the files that were copied into it. Every changed, added or removed file is one
// whole-file edit. A plain reason when the folder holds something a proposal cannot carry.
export function folderEdits(dir: string, before: ProposerFile[]): { edits: Edit[] } | { failed: string } {
  const old = new Map(before.map((f) => [f.path, f.text]));
  const edits: Edit[] = [];
  const seen = new Set<string>();
  for (const entry of walk(dir)) {
    seen.add(entry.path);
    if (!entry.plain) return { failed: `The agent made ${entry.path}, which is not a plain file (a link or a device). A proposal can hold only plain files.` };
    if (entry.size > MAX_FILE_BYTES) return { failed: `The agent made ${entry.path} larger than 1 MB. A proposal can hold only smaller text files.` };
    const bytes = readFileSync(join(dir, entry.path));
    if (bytes.includes(0)) return { failed: `The agent made ${entry.path} a binary file. A proposal can hold only text files.` };
    const text = bytes.toString("utf8");
    if (old.get(entry.path) !== text) edits.push({ path: entry.path, search: "", replace: text, write: true });
  }
  for (const path of old.keys()) if (!seen.has(path)) edits.push({ path, search: "", replace: "", remove: true });
  return { edits: edits.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) };
}

// The files that go into the agent's folder: only those that a proposal may change. A wide artifact glob such as
// "**/*" also matches the measure's files, the judge's cases and the problem file. With those in the folder the
// agent could run the measure or read the cases, so they stay out, the same as the protected paths.
export function agentFiles(problem: Problem, files: ProposerFile[]): ProposerFile[] {
  const rules = rulesFor(problem);
  return files.filter((f) => pathProblem(f.path, rules) === null);
}

export type ProgramFn = (cwd: string, file: string, args: string[], env: NodeJS.ProcessEnv, o: { timeoutMs?: number }) => Promise<RunResult>;
export interface AgentOptions { env?: NodeJS.ProcessEnv; run?: ProgramFn; tmp?: string }

// One agent run in its own new folder: a proposal, or a plain reason. The folder is removed after the run.
async function runAgent(problem: Problem, config: AgentConfig, all: ProposerRequest, o: AgentOptions): Promise<Proposal | { failed: string }> {
  const request = { ...all, files: agentFiles(problem, all.files) };
  let dir: string;
  try { dir = makeAgentFolder(o.tmp); } catch (e) { return { failed: (e as Error).message }; }
  try {
    copyIn(dir, request.files);
    // A relative program path is relative to the problem folder, not to the agent's folder.
    const bin = /[\\/]/.test(config.bin) && !isAbsolute(config.bin) ? resolve(problem.dir, config.bin) : config.bin;
    const timeoutMs = Math.round(config.timeout_s * 1000);
    const result = await (o.run ?? runProgram)(dir, bin, agentArgs(config, agentPrompt(request, problem.artifact)), agentEnv(o.env), { timeoutMs });
    if (result.timedOut) return { failed: `The agent did not finish in ${config.timeout_s} seconds, the time limit (proposer.timeout_s), and was stopped.` };
    if (result.code === null) return { failed: `The agent program ${config.bin} could not start${result.stderr.trim() ? `: ${oneLine(result.stderr, 200)}` : "."} Install it, or set proposer.bin to its path.` };
    if (result.code !== 0) {
      const detail = oneLine(result.stderr || result.stdout, 200);
      return { failed: `The agent exited with code ${result.code}${detail ? `: ${detail}` : "."}` };
    }
    const changes = folderEdits(dir, request.files);
    if ("failed" in changes) return changes;
    if (changes.edits.length === 0) return { failed: "The agent changed no file." };
    return { summary: summaryOf(result.stdout), edits: changes.edits };
  } catch (e) {
    return { failed: `The agent run failed: ${oneLine(e instanceof Error ? e.message : String(e), 200)}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The agent proposer. It runs the agent once for each candidate, one after the other, each in its own new folder
// with the same kept files. It never throws and uses no model call that Synthe pays for.
export function agentProposer(problem: Problem, o: AgentOptions = {}): Proposer {
  if (!isAgent(problem.proposer)) throw new Error("agentProposer needs a problem with an agent proposer.");
  const config = problem.proposer;
  return {
    async propose(request) {
      const n = Math.max(1, request.candidates);
      const runs: (Proposal | { failed: string })[] = [];
      for (let i = 0; i < n; i++) runs.push(await runAgent(problem, config, request, o));
      if (n === 1 && "failed" in runs[0] && !("edits" in runs[0])) return { reply: { failed: runs[0].failed }, calls: 0 };
      // With several candidates, a failed run is one failed attempt and the other candidates still count.
      const proposals = runs.map((r): Proposal => ("edits" in r ? r : { summary: "", edits: [], failed: r.failed }));
      return { reply: { proposals }, calls: 0 };
    },
  };
}
