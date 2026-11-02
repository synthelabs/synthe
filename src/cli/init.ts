import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS, GOAL_FILE, type Goal, type PromptLocation, type Scenario } from "../core/goal.ts";
import { findPrompts } from "../core/prompt.ts";
import { promptPathProblem } from "../core/safety.ts";
import { ISSUE_TITLE } from "../loop/report.ts";
import { askJson, type Model } from "../model/client.ts";

export const ACTION = "synthelabs/synthe@v1";
export const SCENARIOS_FILE = ".synthe/scenarios.jsonl";
export const WORKFLOW_FILE = ".github/workflows/synthe.yml";

export interface Io {
  say(text: string): void;
  ask(question: string): Promise<string>;
  askSecret(question: string): Promise<string>;
  run(cmd: string, args: string[], stdin?: string): Promise<string>;
  model(apiKey: string): Model;
  template(): string;
}

const SCENARIO_SCHEMA = {
  type: "object",
  properties: {
    guardrails: { type: "array", items: { type: "string" } },
    policy: { type: "string" },
    scenarios: {
      type: "array",
      items: {
        type: "object",
        properties: { input: { type: "string" }, expected: { type: "string" } },
        required: ["input", "expected"], additionalProperties: false,
      },
    },
  },
  required: ["guardrails", "policy", "scenarios"], additionalProperties: false,
};

const TRAIN = 20;
const HOLDOUT = 10;

export async function generateScenarios(model: Model, objective: string, promptText: string) {
  const { value } = await askJson<{ guardrails: string[]; policy: string; scenarios: { input: string; expected: string }[] }>(model, {
    model: DEFAULTS.models.writer, maxTokens: 16000, schema: SCENARIO_SCHEMA,
    user: `An AI agent has this system prompt:
<prompt>
${promptText.slice(0, 8000)}
</prompt>

Its team wants it to get better at: ${objective}

Write ${TRAIN + HOLDOUT} varied, realistic user messages for testing it, each with a one-sentence description of what a good response does. Include hard and edge cases. Also list 2 guardrails: things it must never do. In "policy", copy the business rules the prompt states (what the agent may and may not offer, limits, fees, deadlines), word for word where possible, without inventing any; leave it empty if the prompt states none.`,
  });
  if (!value || value.scenarios.length < TRAIN + HOLDOUT) throw new Error("could not generate scenarios; run init again");
  const rows: Scenario[] = value.scenarios.slice(0, TRAIN + HOLDOUT).map((s, i) => ({
    id: `s${i + 1}`, ...s, split: i < TRAIN ? "train" : "holdout",
  }));
  return { guardrails: value.guardrails.slice(0, 5), policy: typeof value.policy === "string" ? value.policy.trim().slice(0, 4000) : "", rows };
}

export function buildGoal(prompt: PromptLocation, objective: string, guardrails: string[], policy = ""): Goal {
  return { version: 1, prompt, objective, ...(policy ? { policy } : {}), guardrails, scenarios: SCENARIOS_FILE, ...DEFAULTS };
}

export function renderWorkflow(template: string): string {
  return template.replaceAll("__ACTION__", ACTION);
}

function repoTextFiles(listing: string, root: string) {
  return listing.split("\n").filter(Boolean).flatMap((path) => {
    try {
      const full = join(root, path);
      return statSync(full).size < 200_000 ? [{ path, text: readFileSync(full, "utf8") }] : [];
    } catch { return []; }
  });
}

// Says exactly what's missing, so a team can fix it in one step.
async function whyGitHubFails(io: Io): Promise<string> {
  try { await io.run("gh", ["--version"]); } catch {
    return "Synthe needs the GitHub CLI. Install it from https://cli.github.com, run `gh auth login`, then run `npx synthe init` again.";
  }
  try { await io.run("gh", ["auth", "status"]); } catch {
    return "Sign in to the GitHub CLI first: run `gh auth login`, then run `npx synthe init` again.";
  }
  return "Run this inside your project's folder, after pushing it to GitHub (you need admin access to the repo).";
}

export async function init(io: Io, root: string) {
  let slug: string;
  try {
    slug = (await io.run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])).trim();
  } catch {
    io.say(await whyGitHubFails(io));
    return false;
  }
  let branch = "your default branch";
  try { branch = (await io.run("gh", ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"])).trim() || branch; } catch { /* keep the generic name */ }
  io.say(`Synthe will improve your agent's system prompt overnight, in ${slug}.\n`);

  const prompts = findPrompts(repoTextFiles(await io.run("git", ["ls-files"]), root));
  let location: PromptLocation;
  if (prompts.length === 0) {
    io.say("Synthe couldn't find your agent's system prompt. Put it in its own file (for example prompt.md) and commit it.");
    const path = (await io.ask("Path to that file: ")).trim();
    location = { kind: "file", path };
  } else {
    io.say(prompts.length === 1 ? "Found your agent's prompt:" : "Found these prompts:");
    prompts.forEach((p, i) => io.say(`  ${i + 1}. ${p.location.path}: ${p.preview.replaceAll("\n", " ")}`));
    const pick = prompts.length === 1 ? 1 : Number(await io.ask("Which is your agent's system prompt? "));
    if (!prompts[pick - 1]) { io.say("That isn't one of the options."); return false; }
    location = prompts[pick - 1].location;
  }
  const refused = promptPathProblem(location.path);
  if (refused) { io.say(refused); return false; }

  const promptText = location.kind === "inline" ? location.initial : readFileSync(join(root, location.path), "utf8");
  const objective = (await io.ask("\nWhat should your agent get better at? One sentence, for example \"answer returns questions correctly and offer an exchange first\":\n> ")).trim();
  if (!objective) { io.say("Synthe needs a goal to work toward. Run `npx synthe init` again and describe one."); return false; }
  const key = process.env.ANTHROPIC_API_KEY || (await io.askSecret("Paste your Synthe key (from the Synthe table): ")).trim();

  io.say(`\nReading your prompt and writing ${TRAIN + HOLDOUT} practice conversations. This takes about a minute...`);
  const { guardrails, policy, rows } = await generateScenarios(io.model(key), objective, promptText);
  io.say("Done. Synthe will judge your agent's replies against:");
  io.say("  Rules it must never break:");
  guardrails.forEach((g) => io.say(`    - ${g}`));
  if (policy) {
    const lines = policy.split("\n").filter((l) => l.trim());
    io.say(`  Your business policy, copied from your prompt (${lines.length} line${lines.length === 1 ? "" : "s"}), starting: "${lines[0].slice(0, 80)}"`);
  } else {
    io.say("  No business rules found in your prompt. Adding them as \"policy\" in synthe.json makes judging fairer.");
  }
  io.say(`  Change any of this in ${GOAL_FILE} and ${SCENARIOS_FILE}.`);

  io.say(`\nWhen Synthe finds a clearly better prompt, it merges it into ${branch}. If ${branch} deploys your app, each change deploys too.`);
  const auto = !/^n/i.test((await io.ask("Merge automatically? Y to merge, or n to get a pull request to review instead (Y/n): ")).trim());
  const goal = buildGoal(location, objective, guardrails, policy);
  if (!auto) goal.merge_rule = { ...goal.merge_rule, mode: "propose" };

  mkdirSync(join(root, ".synthe"), { recursive: true });
  mkdirSync(join(root, ".github/workflows"), { recursive: true });
  writeFileSync(join(root, GOAL_FILE), `${JSON.stringify(goal, null, 2)}\n`);
  writeFileSync(join(root, SCENARIOS_FILE), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
  writeFileSync(join(root, WORKFLOW_FILE), renderWorkflow(io.template()));

  await io.run("gh", ["secret", "set", "SYNTHE_ANTHROPIC_KEY", "--repo", slug], key);
  try {
    await io.run("gh", ["api", "-X", "PUT", `repos/${slug}/actions/permissions/workflow`,
      "-f", "default_workflow_permissions=read", "-F", "can_approve_pull_request_reviews=true"]);
  } catch {
    io.say(`Turn on "Allow GitHub Actions to create and approve pull requests" at https://github.com/${slug}/settings/actions`);
  }

  await io.run("git", ["add", GOAL_FILE, SCENARIOS_FILE, WORKFLOW_FILE]);
  await io.run("git", ["commit", "-m", "Add Synthe", "--", GOAL_FILE, SCENARIOS_FILE, WORKFLOW_FILE]);
  await io.run("git", ["push"]);

  let started = false;
  for (let i = 0; i < 5 && !started; i++) {
    try {
      await io.run("gh", ["workflow", "run", "synthe.yml", "--repo", slug]);
      started = true;
    } catch {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  io.say(started
    ? `\nSynthe is running. The first round takes a few minutes, then it runs every hour: up to ${goal.merge_rule.max_rounds} rounds and $${goal.budget.max_usd} at most.`
    : `\nSet up. The first round starts within the hour, then it runs every hour: up to ${goal.merge_rule.max_rounds} rounds and $${goal.budget.max_usd} at most.`);
  io.say(`  In the morning, open the "${ISSUE_TITLE}" issue in your repo: it says what changed and why.`);
  io.say(auto
    ? "  When Synthe changes your prompt, pull before you edit the prompt yourself."
    : "  When Synthe finds a better prompt, it opens a pull request for you to merge or close.");
  io.say(`  Watch it live: https://github.com/${slug}/actions/workflows/synthe.yml`);
  io.say("  Stop any time: npx synthe stop");
  return true;
}
