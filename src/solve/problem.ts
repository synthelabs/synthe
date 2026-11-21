// The problem file: what Synthe may change, how to measure it, and what must not break. See swarm/GOAL.md.
// Validation reports every bad field at once, one line each, so a person fixes the file in one pass.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export type Direction = "higher" | "lower";

export interface CommandMeasure { kind: "command"; command: string; direction: Direction; unit: string; runs: number }
export interface JudgeMeasure { kind: "judge"; cases: string; run: string; compare: string | "model"; runs: number }

export interface Problem {
  version: 1;
  name: string;
  goal: string;
  artifact: string[];
  protect: string[];
  measure: CommandMeasure | JudgeMeasure;
  guards: string[];
  holdout: boolean;
  proposer: { kind: "command"; command: string } | { kind: "model" };
  budget: { maxRounds: number; maxCalls: number | null };
  model: { baseUrl: string; model: string } | null;
  /** The folder that holds the problem file. Every path in the file is relative to it. */
  dir: string;
  /** The top of the git repository that holds `dir`. */
  repo: string;
}

export type ProblemResult = { ok: true; problem: Problem } | { ok: false; errors: string[] };

const TOP_KEYS = ["version", "name", "goal", "artifact", "protect", "measure", "guards", "split", "proposer", "budget", "model"];
const DEFAULT_RUNS = 3;
const DEFAULT_MAX_ROUNDS = 6;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1;

function unknownKeys(obj: Record<string, unknown>, allowed: string[], prefix: string, errors: string[]) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) errors.push(`${prefix}${k}: unknown field. Allowed fields: ${allowed.join(", ")}.`);
  }
}

// A glob is relative to the problem folder and stays inside the repository.
function globProblem(field: string, g: unknown): string | null {
  if (!isText(g)) return `${field}: each entry must be a non-empty glob, such as "src/**/*.py".`;
  if (isAbsolute(g) || /^[A-Za-z]:[\\/]/.test(g)) return `${field}: "${g}" is an absolute path. Use a path relative to the problem file's folder.`;
  if (g.split(/[\\/]/).includes("..")) return `${field}: "${g}" uses "..". Keep paths inside the problem file's folder.`;
  return null;
}

function globList(field: string, v: unknown, required: boolean, errors: string[]): string[] {
  if (v === undefined && !required) return [];
  if (!Array.isArray(v) || (required && v.length === 0)) {
    errors.push(`${field}: must be a ${required ? "non-empty " : ""}list of globs, such as ["src/**/*.py"].`);
    return [];
  }
  const bad = v.map((g, i) => globProblem(`${field}[${i}]`, g)).filter((p): p is string => p !== null);
  errors.push(...bad);
  return bad.length ? [] : (v as string[]);
}

function commandList(field: string, v: unknown, errors: string[]): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every(isText)) {
    errors.push(`${field}: must be a list of shell commands, such as ["python3 -m pytest -q"].`);
    return [];
  }
  return v as string[];
}

function runsOf(field: string, v: unknown, errors: string[]): number {
  if (v === undefined) return DEFAULT_RUNS;
  if (!isCount(v)) { errors.push(`${field}: must be a whole number of 1 or more.`); return DEFAULT_RUNS; }
  return v;
}

function measureOf(v: unknown, dir: string, errors: string[]): CommandMeasure | JudgeMeasure | null {
  if (!isObject(v)) { errors.push(`measure: must be an object with "command" or "judge".`); return null; }
  const hasCommand = v.command !== undefined, hasJudge = v.judge !== undefined;
  if (hasCommand === hasJudge) {
    errors.push(`measure: give exactly one of "command" or "judge"${hasCommand ? ", not both" : ""}.`);
    return null;
  }
  if (hasCommand) {
    unknownKeys(v, ["command", "direction", "unit", "runs"], "measure.", errors);
    const before = errors.length;
    if (!isText(v.command)) errors.push(`measure.command: must be a non-empty shell command.`);
    if (v.direction !== "higher" && v.direction !== "lower") errors.push(`measure.direction: must be "higher" or "lower".`);
    if (v.unit !== undefined && typeof v.unit !== "string") errors.push(`measure.unit: must be text, such as "points".`);
    const runs = runsOf("measure.runs", v.runs, errors);
    if (errors.length > before) return null;
    return { kind: "command", command: v.command as string, direction: v.direction as Direction, unit: (v.unit as string | undefined) ?? "", runs };
  }
  unknownKeys(v, ["judge", "runs"], "measure.", errors);
  const before = errors.length;
  const runs = runsOf("measure.runs", v.runs, errors);
  const j = v.judge;
  if (!isObject(j)) { errors.push(`measure.judge: must be an object with "cases", "run" and "compare".`); return null; }
  unknownKeys(j, ["cases", "run", "compare"], "measure.judge.", errors);
  if (!isText(j.cases)) errors.push(`measure.judge.cases: must be the path of a JSONL file of cases.`);
  else {
    const p = globProblem("measure.judge.cases", j.cases);
    if (p) errors.push(p);
    else {
      const casesError = casesProblem(join(dir, j.cases));
      if (casesError) errors.push(`measure.judge.cases: ${casesError}`);
    }
  }
  if (!isText(j.run)) errors.push(`measure.judge.run: must be a non-empty shell command.`);
  if (!isText(j.compare)) errors.push(`measure.judge.compare: must be a shell command or "model".`);
  if (errors.length > before) return null;
  return { kind: "judge", cases: j.cases as string, run: j.run as string, compare: j.compare as string, runs };
}

function casesProblem(path: string): string | null {
  if (!existsSync(path) || !statSync(path).isFile()) return `file not found: ${path}.`;
  const lines = readFileSync(path, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return `${path} has no cases. Write one JSON object per line.`;
  const seen = new Set<string>();
  for (const [i, line] of lines.entries()) {
    let c: unknown;
    try { c = JSON.parse(line); } catch { return `line ${i + 1} is not valid JSON.`; }
    if (!isObject(c) || (typeof c.id !== "string" && typeof c.id !== "number") || !("input" in c)) return `line ${i + 1} needs an "id" and an "input".`;
    if (seen.has(String(c.id))) return `line ${i + 1} repeats the id "${c.id}". Each id must be unique.`;
    seen.add(String(c.id));
  }
  return null;
}

function repoTop(dir: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch { return null; }
}

/** Validates the parsed JSON of a problem file. `dir` is the folder that holds the file. */
export function validateProblem(raw: unknown, dir: string): ProblemResult {
  const errors: string[] = [];
  if (!isObject(raw)) return { ok: false, errors: ["file: must be a JSON object."] };
  unknownKeys(raw, TOP_KEYS, "", errors);

  if (raw.version !== 1) errors.push(`version: must be 1.`);
  if (typeof raw.name !== "string" || !/^[A-Za-z0-9-]+$/.test(raw.name)) errors.push(`name: must use only letters, digits and "-", such as "my-problem".`);
  if (!isText(raw.goal)) errors.push(`goal: must be one plain sentence that says what should get better.`);
  const artifact = globList("artifact", raw.artifact, true, errors);
  const protect = globList("protect", raw.protect, false, errors);
  const measure = raw.measure === undefined ? (errors.push(`measure: is required. Give "command" or "judge".`), null) : measureOf(raw.measure, dir, errors);
  const guards = commandList("guards", raw.guards, errors);

  let holdout = false;
  if (raw.split !== undefined) {
    if (!isObject(raw.split)) errors.push(`split: must be an object, such as { "holdout": true }.`);
    else {
      unknownKeys(raw.split, ["holdout"], "split.", errors);
      if (raw.split.holdout !== undefined && typeof raw.split.holdout !== "boolean") errors.push(`split.holdout: must be true or false.`);
      else holdout = raw.split.holdout === true;
    }
  }

  let proposer: Problem["proposer"] = { kind: "model" };
  if (raw.proposer !== undefined && raw.proposer !== "model") {
    if (!isObject(raw.proposer)) errors.push(`proposer: must be "model" or { "command": "..." }.`);
    else {
      unknownKeys(raw.proposer, ["command"], "proposer.", errors);
      if (!isText(raw.proposer.command)) errors.push(`proposer.command: must be a non-empty shell command.`);
      else proposer = { kind: "command", command: raw.proposer.command };
    }
  }

  const budget: Problem["budget"] = { maxRounds: DEFAULT_MAX_ROUNDS, maxCalls: null };
  if (raw.budget !== undefined) {
    if (!isObject(raw.budget)) errors.push(`budget: must be an object, such as { "max_rounds": 6 }.`);
    else {
      unknownKeys(raw.budget, ["max_rounds", "max_calls"], "budget.", errors);
      if (raw.budget.max_rounds !== undefined) {
        if (!isCount(raw.budget.max_rounds)) errors.push(`budget.max_rounds: must be a whole number of 1 or more.`);
        else budget.maxRounds = raw.budget.max_rounds;
      }
      if (raw.budget.max_calls !== undefined) {
        if (!isCount(raw.budget.max_calls)) errors.push(`budget.max_calls: must be a whole number of 1 or more.`);
        else budget.maxCalls = raw.budget.max_calls;
      }
    }
  }

  let model: Problem["model"] = null;
  if (raw.model !== undefined) {
    if (!isObject(raw.model)) errors.push(`model: must be an object with "base_url" and "model".`);
    else {
      // Only base_url and model are allowed: a key in the file would leak into git. It comes from SYNTHE_API_KEY.
      for (const k of Object.keys(raw.model)) {
        if (k === "base_url" || k === "model") continue;
        errors.push(/key|token|secret/i.test(k)
          ? `model.${k}: never put a key in the problem file. Set the SYNTHE_API_KEY environment variable.`
          : `model.${k}: unknown field. Allowed fields: base_url, model.`);
      }
      const url = raw.model.base_url;
      let urlOk = false;
      if (typeof url === "string") { try { urlOk = ["http:", "https:"].includes(new URL(url).protocol); } catch { urlOk = false; } }
      if (!urlOk) errors.push(`model.base_url: must be an http or https URL, such as "https://api.example.com/v1".`);
      if (!isText(raw.model.model)) errors.push(`model.model: must be a model name.`);
      if (urlOk && isText(raw.model.model)) model = { baseUrl: url as string, model: raw.model.model };
    }
  }

  const repo = repoTop(dir);
  if (!repo) errors.push(`file: the folder ${dir} is not inside a git repository. Synthe works in scratch checkouts of a git repository.`);

  if (errors.length || !measure || !repo) return { ok: false, errors };
  return {
    ok: true,
    problem: {
      version: 1, name: raw.name as string, goal: raw.goal as string, artifact, protect, measure, guards, holdout,
      proposer, budget, model, dir, repo,
    },
  };
}

/** Reads and validates a problem file. Never throws for a bad file: the errors say what to fix. */
export function loadProblem(file: string): ProblemResult {
  const path = resolve(file);
  if (!existsSync(path) || !statSync(path).isFile()) return { ok: false, errors: [`file: not found: ${path}.`] };
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch (e) {
    return { ok: false, errors: [`file: not valid JSON (${(e as Error).message}).`] };
  }
  return validateProblem(raw, dirname(path));
}

/** A plain summary of a valid problem, for `problem check`. */
export function problemSummary(p: Problem): string[] {
  const m = p.measure;
  const lines = [
    `Problem "${p.name}" is valid.`,
    `Goal: ${p.goal}`,
    `May change: ${p.artifact.join(", ")}`,
  ];
  if (p.protect.length) lines.push(`Never changes: ${p.protect.join(", ")}`);
  lines.push(m.kind === "command"
    ? `Measure: ${m.command} (${m.direction} is better${m.unit ? `, in ${m.unit}` : ""}, ${m.runs} run${m.runs === 1 ? "" : "s"} each)`
    : `Measure: judged on ${m.cases}; run "${m.run}", compare with ${m.compare === "model" ? "the model" : `"${m.compare}"`}`);
  lines.push(p.guards.length ? `Guards: ${p.guards.join("; ")}` : `Guards: none`);
  if (p.holdout) lines.push(`Holdout: on. A change is kept only if it also wins on the holdout split.`);
  lines.push(`Proposer: ${p.proposer.kind === "command" ? p.proposer.command : "the configured model"}`);
  lines.push(`Budget: ${p.budget.maxRounds} rounds${p.budget.maxCalls ? `, ${p.budget.maxCalls} model calls` : ""}`);
  lines.push(`Next: run "npx synthe solve ${"<this file>"}".`);
  return lines;
}
