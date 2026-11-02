import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS, GOAL_FILE, type Goal, type PromptLocation, type Scenario } from "../core/goal.ts";
import { findPrompts } from "../core/prompt.ts";
import { promptPathProblem } from "../core/safety.ts";
import { askJson, type Model } from "../model/client.ts";

export const ACTION = "synthelabs/synthe@v0";
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
    scenarios: {
      type: "array",
      items: {
        type: "object",
        properties: { input: { type: "string" }, expected: { type: "string" } },
        required: ["input", "expected"], additionalProperties: false,
      },
    },
  },
  required: ["guardrails", "scenarios"], additionalProperties: false,
};

const TRAIN = 20;
const HOLDOUT = 10;

export async function generateScenarios(model: Model, objective: string, promptText: string) {
  const { value } = await askJson<{ guardrails: string[]; scenarios: { input: string; expected: string }[] }>(model, {
    model: DEFAULTS.models.writer, maxTokens: 16000, schema: SCENARIO_SCHEMA,
    user: `An AI agent has this system prompt:
<prompt>
${promptText.slice(0, 8000)}
</prompt>

Its team wants it to get better at: ${objective}

Write ${TRAIN + HOLDOUT} varied, realistic user messages for testing it, each with a one-sentence description of what a good response does. Include hard and edge cases. Also list 2 guardrails: things it must never do.`,
  });
  if (!value || value.scenarios.length < TRAIN + HOLDOUT) throw new Error("could not generate scenarios; run init again");
  const rows: Scenario[] = value.scenarios.slice(0, TRAIN + HOLDOUT).map((s, i) => ({
    id: `s${i + 1}`, ...s, split: i < TRAIN ? "train" : "holdout",
  }));
  return { guardrails: value.guardrails.slice(0, 5), rows };
}

export function buildGoal(prompt: PromptLocation, objective: string, guardrails: string[]): Goal {
  return { version: 1, prompt, objective, guardrails, scenarios: SCENARIOS_FILE, ...DEFAULTS };
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

const MANUAL = `GitHub CLI is needed: install it from https://cli.github.com and run \`gh auth login\`, then run this again.`;

export async function init(io: Io, root: string) {
  let slug: string;
  try {
    slug = (await io.run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])).trim();
  } catch {
    io.say(MANUAL);
    return false;
  }

  const prompts = findPrompts(repoTextFiles(await io.run("git", ["ls-files"]), root));
  let location: PromptLocation;
  if (prompts.length === 0) {
    const path = (await io.ask("No system prompt found. Move it into its own file, then enter the path: ")).trim();
    location = { kind: "file", path };
  } else {
    prompts.forEach((p, i) => io.say(`  ${i + 1}. ${p.location.path}: ${p.preview.replaceAll("\n", " ")}`));
    const pick = prompts.length === 1 ? 1 : Number(await io.ask("Which is your agent's system prompt? "));
    if (!prompts[pick - 1]) { io.say("That isn't one of the options."); return false; }
    location = prompts[pick - 1].location;
  }
  const refused = promptPathProblem(location.path);
  if (refused) { io.say(refused); return false; }

  const promptText = location.kind === "inline" ? location.initial : readFileSync(join(root, location.path), "utf8");
  const objective = (await io.ask("What should your agent get better at? ")).trim();
  if (!objective) { io.say("Synthe needs a goal to work toward."); return false; }
  const key = process.env.ANTHROPIC_API_KEY || (await io.askSecret("Paste your Synthe key: ")).trim();

  io.say("Writing test scenarios...");
  const { guardrails, rows } = await generateScenarios(io.model(key), objective, promptText);
  const goal = buildGoal(location, objective, guardrails);

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
  io.say(started ? "Synthe is running." : "Set up. The first round starts within the hour.");
  io.say(`Watch it: https://github.com/${slug}/actions/workflows/synthe.yml`);
  io.say("In the morning, open the \"Synthe: overnight prompt report\" issue. Stop any time with `npx synthe stop`.");
  return true;
}
