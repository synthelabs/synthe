import { STATE_BRANCH } from "../core/goal.ts";
import type { Io } from "./init.ts";
import { anthropicModel, modelProblem } from "../model/client.ts";
import { parseGoal, type Goal } from "../core/goal.ts";
import { newState, type State } from "../core/state.ts";

export async function setKey(io: Pick<Io, "askSecret" | "run" | "say"> & Partial<Pick<Io, "model">>, env: NodeJS.ProcessEnv = process.env, terminal = Boolean(process.stdin.isTTY)): Promise<boolean> {
  // ANTHROPIC_API_KEY is often the team's app key, so it is only used after a deliberate Enter, as in init.
  const own = env.SYNTHE_ANTHROPIC_KEY?.trim(), app = env.ANTHROPIC_API_KEY?.trim();
  if (!own && !terminal) {
    io.say("Ask the person to run `npx synthe key` in their own terminal.");
    return false;
  }
  const typed = own ? "" : (await io.askSecret(app ? "Paste your own Anthropic key, or press Enter to use the key in ANTHROPIC_API_KEY: " : "Paste your own Anthropic key: ")).trim();
  const key = own || typed || app || "";
  if (!/^sk-ant-\S+$/.test(key)) { io.say("That doesn't look like an Anthropic key: it must start with sk-ant-. Nothing changed."); return false; }
  if (!own && !typed && app) io.say("Using the key in ANTHROPIC_API_KEY.");
  const slug = (await io.run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])).trim();
  let goal: Goal;
  try {
    goal = parseGoal(await io.run("gh", ["api", `repos/${slug}/contents/synthe.json`, "-H", "Accept: application/vnd.github.raw+json"]));
  } catch (error) {
    if (!/404|Not Found/i.test((error as Error).message)) throw error;
    io.say("Synthe isn't set up on this repo's default branch. Finish `npx synthe init` and merge its setup pull request before running `npx synthe key`. Nothing changed.");
    return false;
  }
  try {
    await (io.model ?? anthropicModel)(key).ask({ model: "claude-haiku-5-5", user: "Say OK.", maxTokens: 5 });
  } catch (error) {
    io.say(`${modelProblem(error) ?? (error as Error).message} Nothing changed.`);
    return false;
  }
  const path = `repos/${slug}/contents/state.json`;
  let file: { sha: string; content: string } | null = null;
  try {
    file = JSON.parse(await io.run("gh", ["api", `${path}?ref=${encodeURIComponent(STATE_BRANCH)}`]));
  } catch (error) {
    if (!/404|Not Found/i.test((error as Error).message)) throw error;
  }
  const state: State = { ...newState(), ...(file ? JSON.parse(Buffer.from(file.content, "base64").toString("utf8")) : {}) };
  if (!file) {
    try { await io.run("gh", ["api", `repos/${slug}/git/ref/heads/${encodeURIComponent(STATE_BRANCH)}`]); }
    catch (error) {
      if (!/404|Not Found/i.test((error as Error).message)) throw error;
      const head = (await io.run("gh", ["api", `repos/${slug}/commits/HEAD`, "--jq", ".sha"])).trim();
      await io.run("gh", ["api", "-X", "POST", `repos/${slug}/git/refs`, "-f", `ref=refs/heads/${STATE_BRANCH}`, "-f", `sha=${head}`]);
    }
  }
  await io.run("gh", ["secret", "set", "SYNTHE_ANTHROPIC_KEY", "--repo", slug], key);
  if (state.ownKeyFromUsd !== undefined) {
    const budgetStop = Boolean(state.stopped && /^budget/.test(state.stopped));
    io.say(`Rounds now use this Anthropic key. The budget is unchanged: $${goal.budget.max_usd} from when you first ran \`npx synthe key\` (budget.max_usd in synthe.json).${budgetStop ? " To keep going, raise budget.max_usd in synthe.json and push it, then run `npx synthe restart`." : state.stopped ? " Run `npx synthe restart` to continue." : ""}`);
    return true;
  }
  state.ownKeyFromUsd = state.spendUsd;
  const content = Buffer.from(`${JSON.stringify(state, null, 2)}\n`).toString("base64");
  await io.run("gh", ["api", "-X", "PUT", path, "-f", "message=Synthe: switched to own key", "-f", `branch=${STATE_BRANCH}`, ...(file ? ["-f", `sha=${file.sha}`] : []), "-f", `content=${content}`]);
  io.say(`Rounds now use your own Anthropic key, with a fresh $${goal.budget.max_usd} budget (budget.max_usd in synthe.json).${state.stopped ? " Run `npx synthe restart` to continue." : ""}`);
  return true;
}
