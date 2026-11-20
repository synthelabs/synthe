import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GOAL_FILE, STATE_BRANCH, parseGoal, parseScenarios, type Goal } from "../core/goal.ts";
import { readPrompt } from "../core/prompt.ts";
import { newState, type State } from "../core/state.ts";
import type { Model } from "../model/client.ts";
import { runVault, vaultCases, vaultLines } from "../loop/vault.ts";

export interface VaultIo {
  cwd: string;
  say(text: string): void;
  ask(question: string): Promise<string>;
  // gh, for the repo name and the state file on the state branch. Never git or anything that runs the team's hooks.
  run(cmd: string, args: string[], stdin?: string): Promise<string>;
  // The model to spend on and the line that names whose credit it is, or null when nothing is set.
  credential(goal: Goal): { model: Model; line: string } | null;
  now?: () => Date;
  random?: () => number;
}

export const vaultOptions = (args: string[]): { start?: string; yes: boolean } | string => {
  const out: { start?: string; yes: boolean } = { yes: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--yes") out.yes = true;
    else if (args[i] === "--start" && args[i + 1] && !args[i + 1].startsWith("--")) out.start = args[++i];
    else return `Unknown option ${args[i]}. Use --start <file> (the prompt the run started from) and --yes (skip the cost question).`;
  }
  return out;
};

// The repo's state file on the state branch, with the sha GitHub needs to replace it. Null when no round has saved one.
async function readStateFile(io: VaultIo, slug: string): Promise<{ sha: string; state: State } | null> {
  try {
    const file = JSON.parse(await io.run("gh", ["api", `repos/${slug}/contents/state.json?ref=${encodeURIComponent(STATE_BRANCH)}`])) as { sha: string; content: string };
    return { sha: file.sha, state: { ...newState(), ...JSON.parse(Buffer.from(file.content, "base64").toString("utf8")) } };
  } catch {
    return null;
  }
}

// `npx synthe vault`: the prompt now against the prompt the run started from, on the vault cases only. Run it once
// at the end of a run. It spends model calls, so it says how many and asks first. It changes no prompt: it only
// saves its result to the run's state, where the prompt report shows it.
export async function vault(io: VaultIo, args: string[]): Promise<number> {
  const opts = vaultOptions(args);
  if (typeof opts === "string") { io.say(opts); return 1; }
  const goal = parseGoal(readFileSync(join(io.cwd, GOAL_FILE), "utf8"));
  const scenarios = parseScenarios(readFileSync(join(io.cwd, goal.scenarios), "utf8"));
  const cases = vaultCases(scenarios);
  if (cases.length === 0) {
    io.say(`${goal.scenarios} has no vault cases, so there is nothing to check. Before the next run starts, mark a few test cases \`"split": "vault"\`: no round ever reads them, so at the end of the run \`npx synthe vault\` can tell whether its gains carry to cases nobody picked winners on.`);
    return 1;
  }

  let slug: string;
  try {
    slug = (await io.run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])).trim();
  } catch {
    io.say("Couldn't reach this project on GitHub. Check you're signed in to the GitHub CLI (`gh auth status`) and inside your project's folder.");
    return 1;
  }
  const saved = await readStateFile(io, slug);
  if (!saved) {
    io.say("No round has finished yet, so there is no run to check. Run `npx synthe vault` once the run is over.");
    return 1;
  }
  const state = saved.state;

  let start: string | null;
  if (opts.start) {
    const path = join(io.cwd, opts.start);
    if (!existsSync(path)) { io.say(`Couldn't find ${opts.start}. Give the file that holds the prompt the run started from.`); return 1; }
    start = readFileSync(path, "utf8");
  } else start = state.startPrompt ?? null;
  if (start === null) {
    io.say("This run started before Synthe saved its starting prompt. Put the prompt from before the first round in a file (for example from `git log` on your prompt file) and run `npx synthe vault --start <file>`.");
    return 1;
  }
  const current = readPrompt(readFileSync(join(io.cwd, goal.prompt.path), "utf8"), goal, state.prompt);
  if (current === null) {
    io.say(`Couldn't find your prompt in ${goal.prompt.path}. Run \`git pull\` so this folder has the latest round's prompt, then try again.`);
    return 1;
  }
  if (current.trim() === start.trim()) {
    io.say("Your prompt is the same as when the run started, so there is nothing to compare. Nothing was spent.");
    return 0;
  }

  const credential = io.credential(goal);
  if (!credential) {
    io.say("`npx synthe vault` runs on your computer and needs an event code or your own Anthropic key.");
    io.say("Set SYNTHE_EVENT_CODE and SYNTHE_TEAM_CODE, or SYNTHE_ANTHROPIC_KEY or ANTHROPIC_API_KEY, in your environment, then run this again.");
    return 1;
  }
  io.say(credential.line);
  // One reply from each prompt and one judge call per case, plus a mark per reply for the checks and for the guards.
  const perCase = 3 + (goal.checks?.some((c) => c.trim()) ? 2 : 0) + (goal.counter_checks?.some((c) => c.trim()) ? 2 : 0);
  io.say(`This compares the prompt in ${goal.prompt.path} on this computer (run \`git pull\` first so it is the latest round's) with the one the run started from, on ${cases.length} vault ${cases.length === 1 ? "case" : "cases"}. It makes about ${cases.length * perCase} model calls, which cost money.`);
  io.say("Look at the vault once per run: each time you change something because of it, it stops being a fair check.");
  if (!opts.yes && (await io.ask("Type yes to go on: ")).trim().toLowerCase() !== "yes") {
    io.say("Stopped. Nothing was spent.");
    return 0;
  }

  const result = await runVault(goal, start, current, scenarios, credential.model, io.random);
  const record = { at: (io.now?.() ?? new Date()).toISOString(), round: state.round, ...result };
  const shown = { ...state, vault: record };
  for (const line of vaultLines(shown, state.rounds.some((r) => r.outcome === "merged"))) io.say(line);
  io.say(`p = ${result.p.toFixed(3)} (the chance of a split at least this good if the two prompts were really equal). Cost: ${result.costUsd === null ? "unknown" : `$${result.costUsd.toFixed(2)}`}.`);

  // Saved on the freshest state, so a round that finished meanwhile isn't overwritten.
  const latest = await readStateFile(io, slug);
  if (!latest) { io.say("Couldn't save the result to the run's state; the numbers above are the result."); return 0; }
  const content = Buffer.from(`${JSON.stringify({ ...latest.state, vault: record }, null, 2)}\n`).toString("base64");
  try {
    await io.run("gh", ["api", "-X", "PUT", `repos/${slug}/contents/state.json`, "-f", "message=Synthe: vault check by npx synthe vault", "-f", `branch=${STATE_BRANCH}`, "-f", `sha=${latest.sha}`, "-f", `content=${content}`]);
    io.say("Saved. The prompt report shows it the next time it updates.");
  } catch (e) {
    io.say(`Couldn't save the result to the run's state (${(e as Error).message.trim().split("\n")[0]}); the numbers above are the result.`);
  }
  return 0;
}
