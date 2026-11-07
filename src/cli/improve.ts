import { relative, join } from "node:path";
import { writeFileSync } from "node:fs";
import { AgentSetupError, askPerson } from "./agent.ts";
import { DEFAULT_RUNS, improveFile, parseImproveConfig, type Direction, type ImproveConfig, type PresetId } from "../improve/config.ts";
import type { Exec } from "../improve/exec.ts";
import { DEFAULT_BUDGET_USD, DEFAULT_ROUNDS, FIRST_ROUND_ESTIMATE_USD, LESSONS_FILE, publish, removeScratchCheckouts, runLoop } from "../improve/loop.ts";
import { presetsForRepo, type Preset } from "../improve/presets.ts";
import { promptModeProtect } from "../improve/protect.ts";
import { baselineLine, loopPrBody, loopPrTitle, money, movement, quantity, taskCard, triedLines } from "../improve/text.ts";
import { measureAt } from "../improve/worktree.ts";
import { EDIT_MODEL } from "../improve/writer.ts";
import { anthropicModel, normalizeTeamCode, proxyModel, TEAM_CODE, type Model } from "../model/client.ts";

// env, makeModel and onInterrupt are only used by the loop; main.ts passes the real ones, tests pass fakes.
export interface ImproveIo {
  say(t: string): void; ask(q: string): Promise<string>; run(cmd: string, args: string[], stdin?: string): Promise<string>; exec: Exec;
  env?: Partial<Record<string, string>>; makeModel?: (c: LoopCredential) => Model; onInterrupt?: (cleanup: () => void) => () => void;
}
export type LessonsChoice = "claude" | "agents" | "none";
export interface ImproveOptions {
  agent: boolean; list: boolean; goal?: string; metric?: PresetId; label?: string; unit?: string; command?: string;
  direction?: Direction; guard?: string; mode?: "auto" | "review"; protect: string[];
  handoff: boolean; rounds: number; budgetUsd: number; lessons?: LessonsChoice;
}

export const IMPROVE_BRANCH = (n: number) => `synthe/improve-${n}`;
export const IMPROVE_NEXT = "NEXT: Synthe measured the current code and saved its config inside .git (nothing to commit). Show the person the baseline and the task card as written. Then create the branch named in the card, make ONE small change to product code only, commit it, and run `npx synthe submit`. Do not edit tests, the metric, package.json or anything under .synthe/.";
export const IMPROVE_LIST_NEXT = "NEXT: Show the person this list as written. Ask them, in one message: what should get better (one sentence), which metric, which regression check, and auto or review. Then run `npx synthe improve --agent` with their answers: Synthe proposes code changes itself, measures each one and keeps only wins, which takes several minutes, so give the command a long timeout (30 minutes). It needs SYNTHE_EVENT_CODE and SYNTHE_TEAM_CODE, or SYNTHE_ANTHROPIC_KEY, in the environment. To make the change yourself instead, add --handoff.";
export const IMPROVE_LOOP_NEXT_WIN = "NEXT: Show the person every round line, the result and the pull request link as written. In auto mode, tell them to run git pull. In review mode, tell them to review the pull request and merge it to keep the changes.";
export const IMPROVE_LOOP_NEXT_NONE = "NEXT: Show the person what was tried and why each change was not kept, as written. Nothing was pushed. To try again, run the same command (the next run reads these lessons); to make the change yourself instead, run it with --handoff.";

const PRESET_IDS: PresetId[] = ["test-pass", "pytest", "bundle-size", "build-time", "custom"];
const VALUE_FLAGS = ["--goal", "--metric", "--label", "--unit", "--command", "--direction", "--guard", "--mode", "--protect", "--rounds", "--budget", "--lessons"];
const LOOP_FLAGS = ["--rounds", "--budget", "--lessons"];
export const MAX_ROUNDS = 20;
export const MAX_BUDGET_USD = 20;

export function improveOptions(args: string[]): ImproveOptions {
  const agent = args.includes("--agent");
  // An agent is told to ask the person; a person typing the command is told what the option should be.
  const invalid = (flag: string): never => {
    if (agent) askPerson(flag);
    throw new AgentSetupError(`${flag} is not a valid option here. Run npx synthe improve with no options to answer the questions instead.`);
  };
  const o: ImproveOptions = { agent, list: false, protect: [], handoff: false, rounds: DEFAULT_ROUNDS, budgetUsd: DEFAULT_BUDGET_USD };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (seen.has(flag) && flag !== "--protect") invalid(flag);
    seen.add(flag);
    if (flag === "--agent") continue;
    if (flag === "--list") { o.list = true; continue; }
    if (flag === "--handoff") { o.handoff = true; continue; }
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
    if (flag === "--rounds") {
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > MAX_ROUNDS) invalid(flag);
      o.rounds = Number(value);
    }
    if (flag === "--budget") {
      const usd = Number(value.replace(/^\$/, ""));
      // At least one round's worth, so a run never starts only to stop before its first round.
      if (!/^\$?\d+(\.\d+)?$/.test(value) || usd < FIRST_ROUND_ESTIMATE_USD || usd > MAX_BUDGET_USD) invalid(flag);
      o.budgetUsd = usd;
    }
    if (flag === "--lessons") {
      if (value !== "claude" && value !== "agents" && value !== "none") invalid(flag);
      o.lessons = value as LessonsChoice;
    }
  }
  // The task card hands the change to the person's own agent: there are no rounds, budget or lessons to set.
  if (o.handoff) for (const flag of LOOP_FLAGS) if (seen.has(flag)) invalid(flag);
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
// `more` adds checks that need what was found (the loop's credential and pull request base).
export async function preflight(io: ImproveIo, dirtyMessage: string, more?: (found: Repo) => Promise<string[]>): Promise<{ problems: string[]; repo?: Repo }> {
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
  if (more) problems.push(...await more({ top, head, gitDir, defaultBranch }));
  return problems.length ? { problems } : { problems, repo: { top, head, gitDir, defaultBranch } };
}

export interface LoopCredential { key?: string; eventCode?: string; teamCode?: string; line: string }

// Which credential the loop spends, chosen only from Synthe's own variables. Unlike `try`, it never falls back to
// ANTHROPIC_API_KEY: that is usually the app's own key, and the loop makes several calls per round.
export function loopCredential(env: Partial<Record<string, string>>): { credential: LoopCredential } | { problem: string } {
  const key = env.SYNTHE_ANTHROPIC_KEY?.trim(), eventCode = env.SYNTHE_EVENT_CODE?.trim(), team = env.SYNTHE_TEAM_CODE?.trim();
  if (key) return { credential: { key, line: "Credential: your own key from SYNTHE_ANTHROPIC_KEY, charged to that Anthropic account." } };
  if (eventCode) {
    if (!team) return { problem: "SYNTHE_EVENT_CODE is set but SYNTHE_TEAM_CODE isn't. Set SYNTHE_TEAM_CODE to your team code from the Synthe table, then run this again." };
    if (!TEAM_CODE.test(normalizeTeamCode(team))) return { problem: "SYNTHE_TEAM_CODE doesn't look like a team code (crim- and four groups of four letters or digits). Check it against your card from the Synthe table." };
    return { credential: { eventCode, teamCode: normalizeTeamCode(team), line: "Credential: Crimson Hacks event credit, with your team code from SYNTHE_TEAM_CODE." } };
  }
  return { problem: "Synthe writes the changes itself, so it needs a credential: set SYNTHE_EVENT_CODE and SYNTHE_TEAM_CODE (event credit) or SYNTHE_ANTHROPIC_KEY (your own key) in your terminal. ANTHROPIC_API_KEY is not used: it is often your app's own key. Or run npx synthe improve --handoff to make the change with your own coding agent; that needs no credential." };
}

export const credentialModel = (c: LoopCredential): Model => (c.key ? anthropicModel(c.key) : proxyModel(c.eventCode!, false, c.teamCode));

// The loop starts from HEAD, and the pull request must contain only the kept changes and the lessons commit. So the
// base is the branch HEAD is on when GitHub has it (otherwise the default branch), and HEAD must equal its tip there.
export async function pullRequestBase(io: ImproveIo, defaultBranch: string, head: string): Promise<{ base: string } | { problem: string }> {
  const branch = (await io.run("git", ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  const tipOn = async (name: string) => {
    // ls-remote matches the end of a ref name, so refs/heads/x/main also matches "main": keep only the exact ref.
    const line = (await io.run("git", ["ls-remote", "--heads", "origin", name])).split("\n").find((l) => l.split("\t")[1]?.trim() === `refs/heads/${name}`);
    return line ? line.split("\t")[0].trim() : null;
  };
  let base = defaultBranch, tip: string | null;
  try {
    tip = branch !== "HEAD" ? await tipOn(branch) : null;
    if (tip) base = branch;
    else tip = await tipOn(defaultBranch);
  } catch {
    return { problem: "Synthe pushes its branch to the remote named origin, and git can't reach it. Check git remote -v and that git push works, then run this again." };
  }
  if (tip === head) return { base };
  if (!tip) return { problem: `${defaultBranch} isn't on GitHub yet. Push it (git push -u origin ${defaultBranch}), then run this again.` };
  let ahead = false;
  try { await io.run("git", ["merge-base", "--is-ancestor", tip, head]); ahead = true; } catch { /* behind, split, or GitHub's commit isn't fetched */ }
  const rule = `Synthe starts from your current commit and opens its pull request against ${base}, so the two must match.`;
  if (base === branch) {
    return { problem: ahead
      ? `${branch} has commits that aren't on GitHub yet. Push them first (git push), then run this again. ${rule}`
      : `${branch} on GitHub has commits this clone doesn't. Run git pull (and git push if you have commits of your own), then run this again. ${rule}` };
  }
  return { problem: branch === "HEAD"
    ? `HEAD is not on a branch and is not the same commit as ${defaultBranch} on GitHub. Check out ${defaultBranch} and run git pull, then run this again. ${rule}`
    : `${branch} isn't on GitHub, and your current commit isn't the same as ${defaultBranch} there. Push your branch (git push -u origin ${branch}) or switch to an up-to-date ${defaultBranch}, then run this again. ${rule}` };
}

// One more than the highest synthe/improve-N here or on GitHub, so a new run never reuses a branch name.
async function nextBranch(io: ImproveIo, top: string): Promise<string> {
  const names = [(await io.run("git", ["-C", top, "branch", "--list", "synthe/improve-*"]).catch(() => ""))];
  names.push(await io.run("git", ["-C", top, "ls-remote", "--heads", "origin", "synthe/improve-*"]).catch(() => ""));
  const used = names.join("\n").match(/synthe\/improve-(\d+)\b/g)?.map((m) => Number(m.slice("synthe/improve-".length))) ?? [];
  return IMPROVE_BRANCH(Math.max(0, ...used) + 1);
}

function presetLine(p: Preset, i: number): string {
  if (p.id === "custom") return `${i + 1}. custom: a command of yours that prints one number (you say whether higher or lower is better)`;
  return `${i + 1}. ${p.id}: ${p.label} (${p.direction} is better; measures ${p.command}${p.guard ? `; regression check: ${p.guard}` : ""})`;
}

export async function improve(io: ImproveIo, root: string, options: ImproveOptions): Promise<boolean> {
  const loop = !options.handoff && !options.list;
  const chosen = loop ? loopCredential(io.env ?? {}) : null;
  let base = "";
  const { problems, repo } = await preflight(io, "Commit your changes first: Synthe measures committed code.", loop ? async (found) => {
    const more = chosen && "problem" in chosen ? [chosen.problem] : [];
    if (found.head && found.defaultBranch) {
      const b = await pullRequestBase(io, found.defaultBranch, found.head);
      if ("problem" in b) more.push(b.problem);
      else base = b.base;
    }
    return more;
  } : undefined);
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
  const credential = chosen && "credential" in chosen ? chosen.credential : null;
  if (credential) io.say(credential.line);

  const draft = await settle(io, options, presets, loop ? base : repo.defaultBranch, top);
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

  if (!credential) {
    const existing = (await io.run("git", ["branch", "--list", "synthe/improve-*"])).split("\n").filter((l) => l.trim()).length;
    io.say("");
    io.say(taskCard(config, IMPROVE_BRANCH(existing + 1)));
    if (options.agent) io.say(IMPROVE_NEXT);
    return true;
  }
  return improveLoop(io, options, { top, gitDir: repo.gitDir, base, config, credential });
}

// The rounds, then the pull request. Temp checkouts are cleaned up on every path, Ctrl-C included.
async function improveLoop(io: ImproveIo, o: ImproveOptions, a: { top: string; gitDir: string; base: string; config: ImproveConfig; credential: LoopCredential }): Promise<boolean> {
  const { top, config, base } = a;
  const { metric } = config;
  io.say(baselineLine(config));
  io.say(`Synthe now proposes up to ${o.rounds} changes, one per round, measures each one the same way and keeps only wins (budget ${money(o.budgetUsd)}). Your working tree is not touched. Press Ctrl-C to stop.`);
  const model = (io.makeModel ?? credentialModel)(a.credential);
  const stopWatching = io.onInterrupt?.(() => removeScratchCheckouts(top));
  try {
    const result = await runLoop(io, { top, gitDir: a.gitDir, config, model, rounds: o.rounds, budgetUsd: o.budgetUsd });
    const kept = result.rounds.filter((r) => r.kept).length;
    const total = result.costKnown ? money(result.spentUsd) : `at least ${money(result.spentUsd)} (some costs unknown)`;
    io.say("");
    io.say(result.stopped);
    if (!kept) {
      io.say(`No change beat the current code (${quantity(config.baseline.median, metric)}), so nothing was pushed and no pull request was opened.`);
      if (result.rounds.length) {
        io.say("What was tried:");
        for (const line of triedLines(result.rounds)) io.say(line);
      }
      io.say(`Model cost: ${total}.`);
      if (result.rounds.length) io.say(`Lessons from these rounds are saved in ${relative(top, join(a.gitDir, LESSONS_FILE))} (not part of your code); the next run reads them.`);
      if (o.agent) io.say(IMPROVE_LOOP_NEXT_NONE);
      return false;
    }
    io.say(`Result: ${movement(config.baseline.median, result.best.median, metric)}, ${kept} of ${result.rounds.length} ${result.rounds.length === 1 ? "change" : "changes"} kept. Model cost: ${total}.`);
    const branch = await nextBranch(io, top);
    io.say(`Pushing ${branch} and opening a pull request into ${base}...`);
    const published = await publish(io, {
      top, start: config.baseline.commit, base, branch, config, result, lessonsChoice: o.lessons, title: loopPrTitle(config, result.best),
      body: (lessonsCommit, diffstat, lessonsFiles) => loopPrBody({ config, best: result.best, rows: result.rounds, spentUsd: result.spentUsd, costKnown: result.costKnown, stopped: result.stopped, base, lessonsCommit, lessonsFiles, diffstat, model: EDIT_MODEL }),
    });
    if (!published.url) {
      io.say(published.problem!);
      return false;
    }
    io.say(`Pull request: ${published.url}`);
    if (config.mode === "auto") io.say(published.merged ? `Merged into ${base}. Run git pull.` : published.problem!);
    else io.say("Review it there and merge it to keep the changes. The last commit only adds lessons.");
    if (o.agent) io.say(IMPROVE_LOOP_NEXT_WIN);
    return true;
  } finally {
    stopWatching?.();
  }
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
