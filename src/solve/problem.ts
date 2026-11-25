// The problem file: what Synthe may change, how to measure it, and what must not break. See swarm/GOAL.md.
// Validation reports every bad field at once, one line each, so a person fixes the file in one pass.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { editableCommandInputs } from "./edits.ts";
import { DEFAULT_AGENT_TIMEOUT_S, DEFAULT_MAX_ROUNDS, DEFAULT_RUNS, isAgent, isJudged, type Direction, type Measure, type Problem, type ProblemCheck } from "./types.ts";

const TOP_KEYS = ["version", "name", "goal", "artifact", "protect", "measure", "guards", "split", "proposer", "budget", "model", "candidates"];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1;

function unknownKeys(obj: Record<string, unknown>, allowed: string[], prefix: string, errors: string[]) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) errors.push(`${prefix}${k}: unknown field. Allowed fields: ${allowed.join(", ")}.`);
  }
}

// A path or glob is relative to the problem folder and stays inside it.
function pathProblem(field: string, g: unknown): string | null {
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
  const bad = v.map((g, i) => pathProblem(`${field}[${i}]`, g)).filter((p): p is string => p !== null);
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

function countOf(field: string, v: unknown, fallback: number, errors: string[]): number {
  if (v === undefined) return fallback;
  if (!isCount(v)) { errors.push(`${field}: must be a whole number of 1 or more.`); return fallback; }
  return v;
}

function measureOf(v: unknown, dir: string, errors: string[]): Measure | null {
  if (!isObject(v)) { errors.push(`measure: must be an object with "command" or "judge".`); return null; }
  const hasCommand = v.command !== undefined, hasJudge = v.judge !== undefined;
  if (hasCommand === hasJudge) {
    errors.push(`measure: give exactly one of "command" or "judge"${hasCommand ? ", not both" : ""}.`);
    return null;
  }
  const before = errors.length;
  if (hasCommand) {
    unknownKeys(v, ["command", "direction", "unit", "runs"], "measure.", errors);
    if (!isText(v.command)) errors.push(`measure.command: must be a non-empty shell command.`);
    if (v.direction !== "higher" && v.direction !== "lower") errors.push(`measure.direction: must be "higher" or "lower".`);
    if (v.unit !== undefined && typeof v.unit !== "string") errors.push(`measure.unit: must be text, such as "points".`);
    const runs = countOf("measure.runs", v.runs, DEFAULT_RUNS, errors);
    if (errors.length > before) return null;
    return { command: v.command as string, direction: v.direction as Direction, ...(v.unit !== undefined ? { unit: v.unit as string } : {}), runs };
  }
  unknownKeys(v, ["judge", "runs"], "measure.", errors);
  const runs = countOf("measure.runs", v.runs, DEFAULT_RUNS, errors);
  const j = v.judge;
  if (!isObject(j)) { errors.push(`measure.judge: must be an object with "cases", "run" and "compare".`); return null; }
  unknownKeys(j, ["cases", "run", "compare", "rubric"], "measure.judge.", errors);
  if (!isText(j.cases)) errors.push(`measure.judge.cases: must be the path of a JSONL file of cases.`);
  else {
    const p = pathProblem("measure.judge.cases", j.cases);
    const casesError = p ?? casesProblem(j.cases, join(dir, j.cases));
    if (casesError) errors.push(p ?? `measure.judge.cases: ${casesError}`);
  }
  if (!isText(j.run)) errors.push(`measure.judge.run: must be a non-empty shell command.`);
  if (!isText(j.compare)) errors.push(`measure.judge.compare: must be a shell command or "model".`);
  let rubric: string | undefined;
  if (j.rubric !== undefined) {
    // GOAL-2.md: a drafted rubric is used through compare "model". A compare command has its own rubric inside it.
    const p = isText(j.rubric) ? pathProblem("measure.judge.rubric", j.rubric) : `measure.judge.rubric: must be the path of a rubric file, such as "judge/rubric.md".`;
    if (p) errors.push(p);
    else if (j.compare !== "model") errors.push(`measure.judge.rubric: works only with "compare": "model". A compare command reads its own rubric.`);
    else if (!existsSync(join(dir, j.rubric as string)) || !statSync(join(dir, j.rubric as string)).isFile()) errors.push(`measure.judge.rubric: Synthe can't find ${j.rubric} next to the problem file.`);
    else rubric = j.rubric as string;
  }
  if (errors.length > before) return null;
  return { judge: { cases: j.cases as string, run: j.run as string, compare: j.compare as string, ...(rubric ? { rubric } : {}) }, runs };
}

function casesProblem(name: string, path: string): string | null {
  if (!existsSync(path) || !statSync(path).isFile()) return `Synthe can't find ${name} next to the problem file.`;
  const lines = readFileSync(path, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return `${name} has no cases. Write one JSON object per line.`;
  const seen = new Set<string>();
  for (const [i, line] of lines.entries()) {
    let c: unknown;
    try { c = JSON.parse(line); } catch { return `line ${i + 1} of ${name} is not valid JSON.`; }
    if (!isObject(c) || (typeof c.id !== "string" && typeof c.id !== "number") || !("input" in c)) return `line ${i + 1} of ${name} needs an "id" and an "input".`;
    if (seen.has(String(c.id))) return `line ${i + 1} of ${name} repeats the id "${c.id}". Each id must be unique.`;
    seen.add(String(c.id));
  }
  return null;
}

function inGitRepo(dir: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, stdio: ["ignore", "pipe", "ignore"] });
    return true;
  } catch { return false; }
}

/** Validates the parsed JSON of a problem file. `file` is its absolute path. */
export function validateProblem(raw: unknown, file: string): ProblemCheck {
  const dir = dirname(file);
  const errors: string[] = [];
  if (!isObject(raw)) return { ok: false, problems: ["file: must be a JSON object, such as { \"version\": 1, ... }."] };
  unknownKeys(raw, TOP_KEYS, "", errors);

  if (raw.version !== 1) errors.push(`version: must be 1.`);
  if (typeof raw.name !== "string" || !/^[A-Za-z0-9-]+$/.test(raw.name)) errors.push(`name: must use only letters, digits and "-", such as "my-problem".`);
  if (!isText(raw.goal)) errors.push(`goal: must be one plain sentence that says what should get better.`);
  const artifact = globList("artifact", raw.artifact, true, errors);
  const protect = globList("protect", raw.protect, false, errors);
  const measure = raw.measure === undefined ? (errors.push(`measure: is required. Give "command" or "judge".`), null) : measureOf(raw.measure, dir, errors);
  const guards = commandList("guards", raw.guards, errors);
  const candidates = countOf("candidates", raw.candidates, 1, errors);

  const split = { holdout: false };
  if (raw.split !== undefined) {
    if (!isObject(raw.split)) errors.push(`split: must be an object, such as { "holdout": true }.`);
    else {
      unknownKeys(raw.split, ["holdout"], "split.", errors);
      if (raw.split.holdout !== undefined && typeof raw.split.holdout !== "boolean") errors.push(`split.holdout: must be true or false.`);
      // GOAL.md defines the held-back split for measure.command (SYNTHE_SPLIT). A judged measure has no split, and a
      // file that asks for one must not pass with a guard that silently never runs.
      else if (raw.split.holdout === true && measure && isJudged(measure)) errors.push(`split.holdout: works only with measure.command, which runs with SYNTHE_SPLIT=train and holdout. A judged measure has no held-back split: remove split.holdout, or measure with a command.`);
      else split.holdout = raw.split.holdout === true;
    }
  }

  let proposer: Problem["proposer"] = "model";
  if (raw.proposer !== undefined && raw.proposer !== "model") {
    if (!isObject(raw.proposer)) errors.push(`proposer: must be "model", { "command": "..." } or { "agent": "claude" }.`);
    else if (raw.proposer.agent !== undefined) {
      const a = raw.proposer;
      const before = errors.length;
      unknownKeys(a, ["agent", "bin", "args", "timeout_s"], "proposer.", errors);
      if (a.agent !== "claude" && a.agent !== "codex") errors.push(`proposer.agent: must be "claude" or "codex". For another tool, write a proposer command: { "command": "..." }.`);
      if (a.bin !== undefined && !isText(a.bin)) errors.push(`proposer.bin: must be the program to run, such as "claude" or a full path.`);
      if (a.args !== undefined && !(Array.isArray(a.args) && a.args.every((x) => typeof x === "string"))) errors.push(`proposer.args: must be a list of text arguments, such as ["--model", "name"].`);
      const limit = a.timeout_s;
      if (limit !== undefined && !(typeof limit === "number" && Number.isFinite(limit) && limit > 0)) errors.push(`proposer.timeout_s: must be a number of seconds above 0, such as ${DEFAULT_AGENT_TIMEOUT_S}.`);
      if (errors.length === before) {
        const agent = a.agent as "claude" | "codex";
        proposer = { agent, bin: (a.bin as string | undefined) ?? agent, args: (a.args as string[] | undefined) ?? [], timeout_s: (limit as number | undefined) ?? DEFAULT_AGENT_TIMEOUT_S };
      }
    } else {
      unknownKeys(raw.proposer, ["command"], "proposer.", errors);
      if (!isText(raw.proposer.command)) errors.push(`proposer.command: must be a non-empty shell command.`);
      else proposer = { command: raw.proposer.command };
    }
  }

  const budget: Problem["budget"] = { max_rounds: DEFAULT_MAX_ROUNDS, max_calls: null };
  if (raw.budget !== undefined) {
    if (!isObject(raw.budget)) errors.push(`budget: must be an object, such as { "max_rounds": 6 }.`);
    else {
      unknownKeys(raw.budget, ["max_rounds", "max_calls", "max_usd"], "budget.", errors);
      budget.max_rounds = countOf("budget.max_rounds", raw.budget.max_rounds, DEFAULT_MAX_ROUNDS, errors);
      if (raw.budget.max_calls !== undefined) budget.max_calls = countOf("budget.max_calls", raw.budget.max_calls, 1, errors);
      const usd = raw.budget.max_usd;
      if (usd !== undefined) {
        if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) errors.push(`budget.max_usd: must be a number of US dollars above 0, such as 2.5.`);
        // Without prices Synthe cannot know what a call costs, so it cannot keep a dollar limit (GOAL-2.md).
        else if (!isObject(raw.model) || raw.model.prices === undefined) errors.push(`budget.max_usd: needs model.prices, so Synthe knows what each call costs. Add "prices": { "input_per_mtok": ..., "output_per_mtok": ... } to model, or remove max_usd.`);
        else budget.max_usd = usd;
      }
    }
  }

  let model: Problem["model"];
  if (raw.model !== undefined) {
    if (!isObject(raw.model)) errors.push(`model: must be an object with "model", and "base_url" for an OpenAI-compatible provider.`);
    else {
      // A key in the file would end up in git. It comes from the environment (GOAL.md, GOAL-2.md).
      // The line names the field but never quotes its value.
      const allowed = ["provider", "base_url", "model", "prices"];
      for (const k of Object.keys(raw.model)) {
        if (allowed.includes(k)) continue;
        errors.push(/key|token|secret|auth/i.test(k)
          ? `model.${k}: never put a key in the problem file. Set SYNTHE_API_KEY (or SYNTHE_ANTHROPIC_KEY for Anthropic) in the environment.`
          : `model.${k}: unknown field. Allowed fields: ${allowed.join(", ")}.`);
      }
      const p = raw.model.provider;
      if (p !== undefined && p !== "anthropic" && p !== "openai-compatible") errors.push(`model.provider: must be "anthropic" or "openai-compatible".`);
      const url = raw.model.base_url;
      // GOAL-2.md: the default provider is openai-compatible when base_url is set, else anthropic.
      const provider: "anthropic" | "openai-compatible" = p === "anthropic" || p === "openai-compatible" ? p : url !== undefined ? "openai-compatible" : "anthropic";
      let urlOk = url === undefined && provider === "anthropic";
      if (typeof url === "string") { try { urlOk = ["http:", "https:"].includes(new URL(url).protocol); } catch { urlOk = false; } }
      if (!urlOk) errors.push(`model.base_url: must be an http or https URL, such as "https://api.example.com/v1".`);
      if (!isText(raw.model.model)) errors.push(`model.model: must be a model name.`);
      let prices: { input_per_mtok: number; output_per_mtok: number } | undefined;
      let pricesOk = true;
      if (raw.model.prices !== undefined) {
        const pr = raw.model.prices;
        const usd = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
        if (!isObject(pr) || !usd(pr.input_per_mtok) || !usd(pr.output_per_mtok) || Object.keys(pr).some((k) => k !== "input_per_mtok" && k !== "output_per_mtok")) {
          pricesOk = false;
          errors.push(`model.prices: must be { "input_per_mtok": <dollars>, "output_per_mtok": <dollars> }, two numbers of 0 or more.`);
        } else prices = { input_per_mtok: pr.input_per_mtok as number, output_per_mtok: pr.output_per_mtok as number };
      }
      if (urlOk && isText(raw.model.model) && pricesOk) {
        model = { provider, model: raw.model.model, ...(typeof url === "string" ? { base_url: url } : {}), ...(prices ? { prices } : {}) };
      }
    }
  }

  if (!inGitRepo(dir)) errors.push(`file: the folder ${dir} is not inside a git repository. Synthe works in scratch checkouts of a git repository.`);

  if (errors.length || !measure) return { ok: false, problems: errors };
  return {
    ok: true,
    problem: {
      version: 1, name: raw.name as string, goal: raw.goal as string, artifact, protect, measure, guards, split,
      proposer, budget, ...(model ? { model } : {}), candidates, dir, file,
    },
  };
}

// Parses and validates the text of a problem file. `file` is its absolute path. Finds every problem, not only the
// first: one line for each, and each line names the field.
export function checkProblem(raw: string, file: string): ProblemCheck {
  let json: unknown;
  try { json = JSON.parse(raw); } catch (e) {
    return { ok: false, problems: [`file: not valid JSON (${(e as Error).message}). Fix the JSON and run the check again.`] };
  }
  return validateProblem(json, file);
}

// The plain summary that `problem check` prints for a valid file.
export function problemSummary(check: Extract<ProblemCheck, { ok: true }>, warnings: string[] = []): string {
  const p = check.problem, m = p.measure;
  const lines = [
    `Problem "${p.name}" is valid.`,
    `Goal: ${p.goal}`,
    `May change: ${p.artifact.join(", ")}`,
  ];
  if (p.protect.length) lines.push(`Never changes: ${p.protect.join(", ")}`);
  lines.push(isJudged(m)
    ? `Measure: judged on ${m.judge.cases}; run "${m.judge.run}", compare with ${m.judge.compare === "model" ? "the model" : `"${m.judge.compare}"`}`
    : `Measure: ${m.command} (${m.direction} is better${m.unit ? `, in ${m.unit}` : ""}, ${m.runs} run${m.runs === 1 ? "" : "s"} each)`);
  lines.push(p.guards.length ? `Guards: ${p.guards.join("; ")}` : `Guards: none`);
  if (p.split.holdout) lines.push(`Holdout: on. A change is kept only if it also wins on the holdout split.`);
  lines.push(`Proposer: ${p.proposer === "model" ? "the configured model" : isAgent(p.proposer)
    ? `the ${p.proposer.agent} agent (${p.proposer.bin}), in a temporary folder that holds only the artifact files, at most ${p.proposer.timeout_s} seconds for each run`
    : p.proposer.command}`);
  if (p.candidates > 1) lines.push(`Candidates: ${p.candidates} in each round`);
  const usdLimit = p.budget.max_usd !== undefined ? `, at most ${p.budget.max_usd} US dollars` : "";
  lines.push(`Budget: ${p.budget.max_rounds} rounds${p.budget.max_calls ? `, ${p.budget.max_calls} model calls` : ""}${usdLimit}`);
  // Allowed on purpose (the measure reads the file the person wants improved), but a scorer listed by mistake would
  // let Synthe raise the score by changing the measure. So say it, and say how to stop it.
  for (const f of editableCommandInputs(p)) {
    lines.push(`Warning: ${f} is named in a command and listed exactly in artifact, so Synthe may change it. That is right when the command reads it as input. If it is part of the measure, list it in protect instead.`);
  }
  lines.push(...warnings);
  lines.push(`Next: run "npx synthe solve ${p.file}".`);
  return lines.join("\n");
}
