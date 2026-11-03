import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS, GOAL_FILE, type Goal, type PromptLocation, type Scenario } from "../core/goal.ts";
import { findPrompts } from "../core/prompt.ts";
import { MAX_PROMPT_CHARS, promptPathProblem } from "../core/safety.ts";
import { ISSUE_TITLE } from "../loop/report.ts";
import { askJson, type Model } from "../model/client.ts";

export const ACTION = "synthelabs/synthe@v1";
export const SCENARIOS_FILE = ".synthe/scenarios.jsonl";
export const WORKFLOW_FILE = ".github/workflows/synthe.yml";
const SETUP_BRANCH = "synthe/setup";
const SETUP_PR_BODY = "Adds Synthe, which improves this repo's AI agent prompt overnight. Merging this starts it: it runs once an hour, at most 12 rounds and $3 of credit, and stops by itself.\n\nIt adds `synthe.json` (the goal and your rules), `.synthe/scenarios.jsonl` (the test cases) and `.github/workflows/synthe.yml` (the hourly job). Stop it any time with `npx synthe stop`.";
// Teams that agree to share progress are listed here, one issue each, so the Synthe team can follow how runs go.
export const REGISTRY = "synthelabs/synthe-runs";

export interface Io {
  say(text: string): void;
  ask(question: string): Promise<string>;
  askSecret(question: string): Promise<string>;
  run(cmd: string, args: string[], stdin?: string): Promise<string>;
  model(apiKey: string): Model;
  template(): string;
  sleep(ms: number): Promise<void>;
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
// The model often writes a case or two fewer than asked (29 instead of 30 in 4 of 6 live tries), so it is asked for a
// few extra, and a slightly short list is still used. Below ENOUGH the merge rule loses too much power, so it asks again.
const ASK_FOR = TRAIN + HOLDOUT + 4;
const ENOUGH = 24;

export async function generateScenarios(model: Model, objective: string, promptText: string) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { value } = await askJson<{ guardrails: string[]; policy: string; scenarios: { input: string; expected: string }[] }>(model, {
      model: DEFAULTS.models.writer, maxTokens: 16000, schema: SCENARIO_SCHEMA,
      user: `An AI agent has this system prompt:
<prompt>
${promptText.slice(0, MAX_PROMPT_CHARS)}
</prompt>

Its team wants it to get better at: ${objective}

Write ${ASK_FOR} varied, realistic user messages for testing it, each with a one-sentence description of what a good response does. Include hard and edge cases. Also list 2 guardrails: things it must never do. In "policy", copy the business rules the prompt states (what the agent may and may not offer, limits, fees, deadlines), word for word where possible, without inventing any; leave it empty if the prompt states none.`,
    });
    if (!value || !Array.isArray(value.scenarios) || value.scenarios.length < ENOUGH) continue;
    // A third are held back, the same split as a full set of 20 and 10.
    const n = Math.min(value.scenarios.length, TRAIN + HOLDOUT);
    const holdout = Math.round(n / 3);
    const rows: Scenario[] = value.scenarios.slice(0, n).map((s, i) => ({
      id: `s${i + 1}`, ...s, split: i < n - holdout ? "train" : "holdout",
    }));
    return { guardrails: value.guardrails.slice(0, 5), policy: typeof value.policy === "string" ? value.policy.trim().slice(0, 4000) : "", rows };
  }
  throw new Error("Synthe couldn't write test cases for your prompt this time. Nothing in your repo was changed; run `npx synthe init` again.");
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

// Asks until it gets a y or an n, three times at most. Null means no clear answer, and the caller picks the safe side.
async function yesNo(io: Io, question: string): Promise<boolean | null> {
  for (let i = 0; i < 3; i++) {
    const a = (await io.ask(question)).trim();
    if (/^y/i.test(a)) return true;
    if (/^n/i.test(a)) return false;
    io.say("Please type y or n.");
  }
  return null;
}

// Always asked, even when ANTHROPIC_API_KEY is set: a team building an agent often has its own key there, and Synthe
// should store and spend the capped Synthe key, not theirs. A paste that isn't a key (often the last command copied)
// is caught here, instead of failing in Actions an hour later.
async function askKey(io: Io, envKey: string | undefined): Promise<string | null> {
  const question = envKey?.trim()
    ? "Paste your Synthe key (from the Synthe table), or press Enter to use the key already in ANTHROPIC_API_KEY: "
    : "Paste your Synthe key (from the Synthe table; it has $3 of credit, paid by Synthe): ";
  for (let i = 0; i < 3; i++) {
    const typed = (await io.askSecret(question)).trim();
    const key = typed || envKey?.trim() || "";
    if (/^sk-ant-\S+$/.test(key)) {
      if (!typed) io.say("Using the key in ANTHROPIC_API_KEY.");
      return key;
    }
    io.say(typed ? "That doesn't look like a key: Synthe keys start with sk-ant-. Paste it again." : "Paste your key, then press Enter.");
  }
  return null;
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

export async function init(io: Io, root: string, now = () => new Date(), envKey = process.env.ANTHROPIC_API_KEY) {
  const startedAt = now().toISOString();
  let slug: string;
  try {
    slug = (await io.run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])).trim();
  } catch {
    io.say(await whyGitHubFails(io));
    return false;
  }
  let branch = "your default branch";
  try { branch = (await io.run("gh", ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"])).trim() || branch; } catch { /* keep the generic name */ }
  // GitHub only runs scheduled jobs from the default branch, so setup on another branch would never start.
  let here = "";
  try { here = (await io.run("git", ["rev-parse", "--abbrev-ref", "HEAD"])).trim(); } catch { /* not knowing is fine; the push decides */ }
  if (here && branch !== "your default branch" && here !== branch) {
    io.say(`You're on the branch ${here}. Synthe adds itself to ${branch}, because GitHub only runs hourly jobs from there. Run \`git checkout ${branch}\`, then \`npx synthe init\` again.`);
    return false;
  }
  io.say(`Synthe will improve your agent's system prompt overnight, in ${slug}. It tests new versions of the prompt and puts the clear winners into ${branch}, or into pull requests for you to review if you prefer.\n`);

  const prompts = findPrompts(repoTextFiles(await io.run("git", ["ls-files"]), root));
  let location: PromptLocation;
  if (prompts.length === 0) {
    io.say("Synthe couldn't find your agent's system prompt. Put it in its own file (for example prompt.md) and commit it.");
    const path = (await io.ask("Path to that file: ")).trim();
    location = { kind: "file", path };
  } else {
    if (prompts.length === 1) io.say(`Found your agent's prompt: ${prompts[0].location.path}: ${prompts[0].preview.replaceAll("\n", " ")}...`);
    else { io.say("Found these prompts:"); prompts.forEach((p, i) => io.say(`  ${i + 1}. ${p.location.path}: ${p.preview.replaceAll("\n", " ")}...`)); }
    const pick = prompts.length === 1 ? 1 : Number(await io.ask("Which is your agent's system prompt? "));
    if (!prompts[pick - 1]) { io.say("That isn't one of the options."); return false; }
    location = prompts[pick - 1].location;
  }
  const refused = promptPathProblem(location.path);
  if (refused) { io.say(refused); return false; }

  const promptText = location.kind === "inline" ? location.initial : readFileSync(join(root, location.path), "utf8");
  // Every change to a longer prompt would be refused by the safety check, so the run could only spend and stall.
  if (promptText.length > MAX_PROMPT_CHARS) {
    io.say(`Your prompt is ${promptText.length.toLocaleString("en-US")} characters, and Synthe works on prompts up to ${MAX_PROMPT_CHARS.toLocaleString("en-US")}. Shorten it, for example by moving reference material such as a menu or FAQ into a separate file your agent loads, then run \`npx synthe init\` again.`);
    return false;
  }
  const objective = (await io.ask("\nWhat should your agent get better at? One sentence, for example \"answer returns questions correctly and offer an exchange first\":\n> ")).trim();
  if (!objective) { io.say("Synthe needs a goal to work toward. Run `npx synthe init` again and describe one."); return false; }
  io.say(`\nWhen Synthe finds a clearly better prompt, it can merge it into ${branch} by itself, overnight. If ${branch} deploys your app, each change goes live. Or it can open a pull request each time for you to review.`);
  let auto = await yesNo(io, `Merge improvements into ${branch} automatically? Type y for automatic, or n to review each one: `);
  if (auto === null) { auto = false; io.say("No clear answer, so Synthe will open pull requests for you to review."); }
  io.say(auto ? `Automatic merging: on. Changes go into ${branch} as soon as they win.` : "Review mode: on. Each change waits in a pull request until you merge or close it.");
  const key = await askKey(io, envKey);
  if (!key) { io.say("No key, so nothing was set up. Get a key from the Synthe table, then run `npx synthe init` again."); return false; }

  io.say(`\nReading your prompt and writing ${TRAIN + HOLDOUT} test cases: ${TRAIN} Synthe learns from and ${HOLDOUT} it keeps hidden to check its changes. This takes about a minute...`);
  const { guardrails, policy, rows } = await generateScenarios(io.model(key), objective, promptText);
  io.say("Done. Synthe will check your agent's replies against:");
  io.say("  Rules it must never break:");
  guardrails.forEach((g) => io.say(`    - ${g}`));
  if (policy) {
    const lines = policy.split("\n").filter((l) => l.trim());
    io.say(`  Your business policy, copied from your prompt (${lines.length} line${lines.length === 1 ? "" : "s"}), starting: "${lines[0].slice(0, 80)}"`);
  } else {
    io.say("  No business rules found in your prompt. Adding them as \"policy\" in synthe.json makes judging fairer.");
  }
  io.say(`  You can change these in ${GOAL_FILE}, and the test cases in ${SCENARIOS_FILE}.`);

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
  // A protected branch, or one that moved on since the last pull, refuses the push. A pull request works either way.
  let setupPr: string | null = null;
  try {
    await io.run("git", ["push"]);
    io.say(`\nAdded to ${branch} (committed and pushed): ${GOAL_FILE}, ${SCENARIOS_FILE} and ${WORKFLOW_FILE}. Saved your key as the repo secret SYNTHE_ANTHROPIC_KEY.`);
  } catch {
    try {
      await io.run("git", ["push", "--force", "origin", `HEAD:refs/heads/${SETUP_BRANCH}`]);
      setupPr = (await io.run("gh", ["pr", "create", "--repo", slug, "--base", branch, "--head", SETUP_BRANCH, "--title", "Add Synthe", "--body", SETUP_PR_BODY])).trim();
      // The pull request holds the files now. Without its own copy of the commit, this branch can simply `git pull`
      // after a squash merge instead of hitting "divergent branches". --keep leaves the team's uncommitted work alone.
      await io.run("git", ["reset", "--keep", "HEAD~1"]).catch(() => undefined);
    } catch (e) {
      io.say(`\nGitHub refused the push to ${branch}, and Synthe couldn't open a pull request instead: ${(e as Error).message.trim().split("\n")[0]}`);
      io.say(`Your key is saved as the repo secret SYNTHE_ANTHROPIC_KEY, and Synthe's files are committed on this computer. Get that commit into ${branch} the way your team usually adds changes; Synthe starts within the hour after that. Don't run init again: that would write new test cases.`);
      return false;
    }
    io.say(`\n${branch} only takes changes through pull requests, so Synthe opened one with its files: ${setupPr}`);
    io.say(`Merge it to start Synthe, then run \`git pull\`. Your key is saved as the repo secret SYNTHE_ANTHROPIC_KEY.`);
  }

  let started = false;
  for (let i = 0; i < 5 && !started && !setupPr; i++) {
    try {
      await io.run("gh", ["workflow", "run", "synthe.yml", "--repo", slug]);
      started = true;
    } catch {
      await io.sleep(3000);
    }
  }
  // Opt-in, and only numbers about the run: never the prompt, the scenarios or any code.
  io.say("\nOne last question. Sharing helps us improve Synthe: we'd see your repo name, rounds, merges, spend and why runs stop, never your prompt, test cases or code.");
  const share = (await yesNo(io, "Share this run's progress with the Synthe team? Type y or n: ")) === true;
  io.say(share ? "Sharing progress with Synthe: on." : "Sharing progress with Synthe: off.");
  if (share) {
    const entry = { repo: slug, startedAt, finishedAt: now().toISOString(), mode: goal.merge_rule.mode, version: ACTION };
    try {
      await io.run("gh", ["issue", "create", "--repo", REGISTRY, "--title", `run: ${slug}`, "--body-file", "-"], `${JSON.stringify(entry, null, 2)}\n`);
    } catch { /* sharing is a favour to us; never let it block a team's setup */ }
  }

  // Forks start with Actions turned off, and then nothing would ever run, however long the team waits.
  const actionsOff = !started && !setupPr && (await io.run("gh", ["api", `repos/${slug}/actions/permissions`, "--jq", ".enabled"]).then((o) => o.trim() === "false", () => false));
  const limits = `then it runs once an hour, at most ${goal.merge_rule.max_rounds} rounds, using at most $${goal.budget.max_usd} of your key's credit.`;
  const last = new Date(now().getTime() + goal.merge_rule.max_rounds * 3_600_000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  io.say(started ? `\nSynthe is running. The first round takes a few minutes, ${limits}`
    : setupPr ? `\nSet up, waiting for you to merge ${setupPr}. The first round starts within the hour after that (or right away with \`gh workflow run synthe.yml\`), ${limits}`
    : actionsOff ? `\nSet up, but GitHub Actions is turned off for this repo, so Synthe can't run yet. Turn it on at https://github.com/${slug}/settings/actions, then start the first round with \`gh workflow run synthe.yml\`. After that it runs once an hour, at most ${goal.merge_rule.max_rounds} rounds, using at most $${goal.budget.max_usd} of your key's credit.`
    : `\nSet up. The first round starts within the hour, ${limits}`);
  io.say(`  The last possible change is around ${last}. To keep your agent unchanged before then, for example for a demo, run: npx synthe stop`);
  io.say(`  After the first round, a "${ISSUE_TITLE}" issue appears in your repo. It says what changed and why.`);
  io.say(auto
    ? `  You can keep editing your prompt: Synthe always starts from the latest version on ${branch}. After it changes the prompt, pull before you edit it, and if a push is rejected, run git pull and push again.`
    : "  When Synthe finds a better prompt, it opens a pull request for you to merge or close. It waits, spending nothing, until you decide.");
  io.say(`  Watch it live: https://github.com/${slug}/actions/workflows/synthe.yml`);
  return true;
}
