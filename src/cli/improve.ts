import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentSetupError, askPerson } from "./agent.ts";
import { DEFAULT_RUNS, improveFile, parseImproveConfig, type Direction, type ImproveConfig, type PresetId } from "../improve/config.ts";
import type { Exec } from "../improve/exec.ts";
import { presetsForRepo, type Preset } from "../improve/presets.ts";
import { promptModeProtect } from "../improve/protect.ts";
import { taskCard } from "../improve/text.ts";
import { measureAt } from "../improve/worktree.ts";

export interface ImproveIo { say(t: string): void; ask(q: string): Promise<string>; run(cmd: string, args: string[], stdin?: string): Promise<string>; exec: Exec }
export interface ImproveOptions {
  agent: boolean; list: boolean; goal?: string; metric?: PresetId; label?: string; unit?: string; command?: string;
  direction?: Direction; guard?: string; mode?: "auto" | "review"; protect: string[];
}

export const IMPROVE_BRANCH = (n: number) => `synthe/improve-${n}`;
export const IMPROVE_NEXT = "NEXT: Synthe measured the current code and saved its config inside .git (nothing to commit). Show the person the baseline and the task card as written. Then create the branch named in the card, make ONE small change to product code only, commit it, and run `npx synthe submit`. Do not edit tests, the metric, package.json or anything under .synthe/.";
export const IMPROVE_LIST_NEXT = "NEXT: Show the person this list as written. Ask them, in one message: what should get better (one sentence), which metric, which regression check, and auto or review. Then run `npx synthe improve --agent` with their answers.";

const PRESET_IDS: PresetId[] = ["test-pass", "pytest", "bundle-size", "build-time", "custom"];
const VALUE_FLAGS = ["--goal", "--metric", "--label", "--unit", "--command", "--direction", "--guard", "--mode", "--protect"];

export function improveOptions(args: string[]): ImproveOptions {
  const agent = args.includes("--agent");
  // An agent is told to ask the person; a person typing the command is told what the option should be.
  const invalid = (flag: string): never => {
    if (agent) askPerson(flag);
    throw new AgentSetupError(`${flag} is not a valid option here. Run npx synthe improve with no options to answer the questions instead.`);
  };
  const o: ImproveOptions = { agent, list: false, protect: [] };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (seen.has(flag) && flag !== "--protect") invalid(flag);
    seen.add(flag);
    if (flag === "--agent") continue;
    if (flag === "--list") { o.list = true; continue; }
    if (!VALUE_FLAGS.includes(flag)) invalid(flag);
    const value = args[++i]?.trim();
    if (!value || value.startsWith("--")) invalid(flag);
    if (flag === "--goal") o.goal = value;
    if (flag === "--label") o.label = value;
    if (flag === "--unit") o.unit = value;
    if (flag === "--command") o.command = value;
    if (flag === "--guard") o.guard = value;
    if (flag === "--metric") {
      if (!PRESET_IDS.includes(value as PresetId)) invalid(flag);
      o.metric = value as PresetId;
    }
    if (flag === "--direction") {
      if (value !== "higher" && value !== "lower") invalid(flag);
      o.direction = value as Direction;
    }
    if (flag === "--mode") {
      if (value !== "auto" && value !== "review") invalid(flag);
      o.mode = value as "auto" | "review";
    }
    if (flag === "--protect") {
      if (value.startsWith("/") || value.split("/").includes("..")) invalid(flag);
      o.protect.push(value);
    }
  }
  if (agent && !o.list) {
    if (!o.goal) askPerson("--goal");
    if (!o.metric) askPerson("--metric");
    if (!o.mode) askPerson("--mode");
    if (o.metric === "custom") {
      if (!o.command) askPerson("--command");
      if (!o.label) askPerson("--label");
      if (!o.direction) askPerson("--direction");
    }
  }
  return o;
}

interface Repo { top: string; head: string; gitDir: string; defaultBranch: string }

const firstLine = (e: unknown) => ((e as Error).message ?? String(e)).trim().split("\n")[0];

// Everything that would stop a run, found at once, so a person fixes them in one pass instead of one per try.
export async function preflight(io: ImproveIo, dirtyMessage: string): Promise<{ problems: string[]; repo?: Repo }> {
  const problems: string[] = [];
  const tryRun = async (cmd: string, args: string[]) => { try { return { out: await io.run(cmd, args) }; } catch (e) { return { error: e }; } };
  let top = "", head = "", gitDir = "", defaultBranch = "";
  const topRun = await tryRun("git", ["rev-parse", "--show-toplevel"]);
  if ("error" in topRun) problems.push("This folder is not inside a git repository. Run this inside your project's folder.");
  else {
    top = topRun.out!.trim();
    gitDir = (await tryRun("git", ["rev-parse", "--absolute-git-dir"])).out?.trim() ?? join(top, ".git");
    const headRun = await tryRun("git", ["rev-parse", "--verify", "HEAD"]);
    if ("error" in headRun) problems.push("This repository has no commit yet. Commit your code first: Synthe measures committed code.");
    else head = headRun.out!.trim();
    const status = await tryRun("git", ["status", "--porcelain"]);
    if ("error" in status || status.out!.trim()) problems.push(dirtyMessage);
  }
  if ("error" in await tryRun("gh", ["--version"])) problems.push("The GitHub CLI (gh) is not installed. Install it from https://cli.github.com, then run gh auth login.");
  else if ("error" in await tryRun("gh", ["auth", "status"])) problems.push("The GitHub CLI is not signed in. Run gh auth login in your own terminal, then run this again.");
  else {
    const view = await tryRun("gh", ["repo", "view", "--json", "nameWithOwner,defaultBranchRef"]);
    try {
      if ("error" in view) throw view.error;
      defaultBranch = JSON.parse(view.out!).defaultBranchRef?.name || "main";
    } catch {
      problems.push("GitHub can't find this repo. Push it to GitHub first (for example gh repo create --source . --push), then run this again.");
    }
  }
  return problems.length ? { problems } : { problems, repo: { top, head, gitDir, defaultBranch } };
}

function presetLine(p: Preset, i: number): string {
  if (p.id === "custom") return `${i + 1}. custom: a command of yours that prints one number (you say whether higher or lower is better)`;
  return `${i + 1}. ${p.id}: ${p.label} (${p.direction} is better; measures ${p.command}${p.guard ? `; regression check: ${p.guard}` : ""})`;
}

export async function improve(io: ImproveIo, root: string, options: ImproveOptions): Promise<boolean> {
  const { problems, repo } = await preflight(io, "Commit your changes first: Synthe measures committed code.");
  if (!repo) {
    io.say("Synthe can't start yet. Fix these, then run npx synthe improve again:");
    for (const p of problems) io.say(`- ${p}`);
    return false;
  }
  const top = repo.top || root;
  const presets = presetsForRepo(top);
  if (options.list) {
    io.say("Metrics this repo can measure:");
    presets.forEach((p, i) => io.say(presetLine(p, i)));
    if (options.agent) io.say(IMPROVE_LIST_NEXT);
    return true;
  }

  const draft = await settle(io, options, presets, repo.defaultBranch, top);
  if (!draft) return false;

  let measured;
  try {
    measured = await measureAt(io.exec, top, repo.head, draft, io.say);
  } catch (e) {
    io.say(`${firstLine(e)} Nothing was written.`);
    return false;
  }
  if (!measured.measurement) {
    io.say(measured.reason ?? "The metric gave no number.");
    io.say("Fix the command, then run npx synthe improve again. Nothing was written.");
    return false;
  }
  if (measured.guardPassed === false) {
    io.say(`The regression check (${draft.guard.command}) fails on the current code. Fix it, or pick another check with --guard, then run npx synthe improve again. Nothing was written.`);
    return false;
  }
  const config = parseImproveConfig(JSON.stringify({ ...draft, baseline: measured.measurement }));
  writeFileSync(improveFile(repo.gitDir), `${JSON.stringify(config, null, 2)}\n`);

  const existing = (await io.run("git", ["branch", "--list", "synthe/improve-*"])).split("\n").filter((l) => l.trim()).length;
  io.say("");
  io.say(taskCard(config, IMPROVE_BRANCH(existing + 1)));
  if (options.agent) io.say(IMPROVE_NEXT);
  return true;
}

// The run's settings, from flags (agent) or questions (person). Returns null after saying why it stopped.
async function settle(io: ImproveIo, o: ImproveOptions, presets: Preset[], defaultBranch: string, top: string): Promise<ImproveConfig | null> {
  const stop = (why: string) => { io.say(why); return null; };
  let goal = o.goal;
  if (!goal) goal = (await io.ask("What should get better? One sentence: ")).trim();
  if (!goal) return stop("Synthe needs a goal. Run npx synthe improve again and say what should get better.");

  let preset: Preset | undefined;
  if (o.metric) {
    preset = presets.find((p) => p.id === o.metric || (o.metric === "test-pass" && p.id === "pytest"));
    if (!preset) return stop(`This repo can't measure ${o.metric} (no matching test setup or script found). Run npx synthe improve --list to see what it can measure.`);
  } else {
    io.say("Which number measures it?");
    presets.forEach((p, i) => io.say(presetLine(p, i)));
    const pick = Number((await io.ask(`Type 1-${presets.length}: `)).trim());
    preset = presets[pick - 1];
    if (!preset) return stop(`Pick a number from 1 to ${presets.length}. Run npx synthe improve again.`);
  }

  let { label, unit, command, direction, runs } = preset;
  if (preset.id === "custom") {
    command = o.command ?? (await io.ask("Command that prints the number: ")).trim();
    if (!command) return stop("Synthe needs the command that prints the number. Run npx synthe improve again.");
    label = o.label ?? (await io.ask("What does the number count? (for example: valid signups): ")).trim();
    if (!label) return stop("Synthe needs a name for the number. Run npx synthe improve again.");
    unit = o.unit ?? ((o.agent ? "" : (await io.ask("Unit (press Enter for units): ")).trim()) || "units");
    if (o.direction) direction = o.direction;
    else {
      const higher = (await io.ask("Is a higher number better? y/n: ")).trim().toLowerCase();
      if (higher !== "y" && higher !== "n") return stop("Answer y or n for whether a higher number is better. Run npx synthe improve again.");
      direction = higher === "y" ? "higher" : "lower";
    }
    runs = DEFAULT_RUNS;
  }

  let guard: string | null = preset.guard;
  if (o.guard) guard = o.guard;
  else if (!o.agent) guard = (await io.ask(`Regression check that must pass before and after (press Enter for ${preset.guard ?? "none"}; type none for no check): `)).trim() || preset.guard;
  if (guard === "none") guard = null;

  let mode = o.mode;
  if (!mode) mode = (await io.ask(`Merge winning changes into ${defaultBranch} automatically? y/n (press Enter for n: review) `)).trim().toLowerCase() === "y" ? "auto" : "review";

  return {
    version: 1, goal, metric: { preset: preset.id, label, unit, command, direction, runs }, guard: { command: guard },
    protect: o.protect, promptFiles: promptModeProtect(top), mode, baseline: { commit: "", median: 0, runs: [], at: "" },
  };
}
