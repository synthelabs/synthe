import { STATE_BRANCH } from "../core/goal.ts";
import type { Io } from "./init.ts";
import { anthropicModel, modelProblem, providerHost, providerModel } from "../model/client.ts";
import { GOAL_FILE, parseGoal, type Goal, type OtherProvider, type Provider } from "../core/goal.ts";
import { askCosts, checkOther, choosePreset, otherSetup, pickModels } from "./init.ts";
import type { Preset } from "../model/presets.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newState, type State } from "../core/state.ts";

// provider: from synthe.json on this computer. Another provider gets its own flow (setOtherKey); without one, this is
// the Anthropic flow as it always was, with SYNTHE_API_KEY also accepted.
// root: the project folder, whose synthe.json a switch to a free provider rewrites (only offered when io can ask).
export async function setKey(io: Pick<Io, "askSecret" | "run" | "say"> & Partial<Pick<Io, "model" | "other" | "ask" | "listModels">>, env: NodeJS.ProcessEnv = process.env, terminal = Boolean(process.stdin.isTTY), provider?: Provider, root?: string): Promise<boolean> {
  if (provider?.kind === "openai-compatible") return setOtherKey(io, provider, env, terminal);
  // ANTHROPIC_API_KEY is often the team's app key, so it is only used after a deliberate Enter, as in init.
  const own = env.SYNTHE_API_KEY?.trim() || env.SYNTHE_ANTHROPIC_KEY?.trim(), app = env.ANTHROPIC_API_KEY?.trim();
  if (!own && !terminal) {
    io.say("Ask the person to run `npx synthe key` in their own terminal.");
    return false;
  }
  // No key yet: a provider with a free tier is one choice away, as in init.
  if (!own && root && io.ask) {
    const picked = await choosePreset({ ask: io.ask, say: io.say }, "your own Anthropic key");
    if (picked) return switchProvider({ ...io, ask: io.ask }, picked, root);
  }
  const typed = own ? "" : (await io.askSecret(app ? "Paste your own Anthropic key, or press Enter to use the key in ANTHROPIC_API_KEY: " : "Paste your own Anthropic key: ")).trim();
  const key = own || typed || app || "";
  if (!/^sk-ant-\S+$/.test(key)) { io.say("That doesn't look like an Anthropic key: it must start with sk-ant-. Nothing changed."); return false; }
  if (!own && !typed && app) io.say("Using the key in ANTHROPIC_API_KEY.");
  const found = await remoteGoal(io);
  if (!found) return false;
  const { slug, goal } = found;
  if (goal.provider?.kind === "openai-compatible") {
    io.say(`synthe.json on GitHub sends model calls to ${providerHost(goal.provider)}, but the one here doesn't. Run \`git pull\`, then \`npx synthe key\` again. Nothing changed.`);
    return false;
  }
  try {
    await (io.model ?? anthropicModel)(key).ask({ model: "claude-haiku-5-5", user: "Say OK.", maxTokens: 5 });
  } catch (error) {
    io.say(`${modelProblem(error) ?? (error as Error).message} Nothing changed.`);
    return false;
  }
  // Saved as SYNTHE_ANTHROPIC_KEY, which every workflow passes, including ones installed before SYNTHE_API_KEY existed.
  await saveKey(io, slug, goal, "SYNTHE_ANTHROPIC_KEY", key, "this Anthropic key", "your own Anthropic key");
  return true;
}

async function remoteGoal(io: Pick<Io, "run" | "say">): Promise<{ slug: string; goal: Goal } | null> {
  const slug = (await io.run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])).trim();
  try {
    return { slug, goal: parseGoal(await io.run("gh", ["api", `repos/${slug}/contents/synthe.json`, "-H", "Accept: application/vnd.github.raw+json"])) };
  } catch (error) {
    if (!/404|Not Found/i.test((error as Error).message)) throw error;
    io.say("Synthe isn't set up on this repo's default branch. Finish `npx synthe init` and merge its setup pull request before running `npx synthe key`. Nothing changed.");
    return null;
  }
}

// A key for the OpenAI-compatible provider in synthe.json. Only SYNTHE_API_KEY or a pasted key: OPENAI_API_KEY and
// the like are never read, since they are usually the app's own. It is tested on the runner model at the base URL
// synthe.json names on GitHub, which is where the workflow sends it, and saved as SYNTHE_API_KEY.
async function setOtherKey(io: Pick<Io, "askSecret" | "run" | "say"> & Partial<Pick<Io, "other">>, provider: OtherProvider, env: NodeJS.ProcessEnv, terminal: boolean): Promise<boolean> {
  const host = providerHost(provider);
  const fromEnv = env.SYNTHE_API_KEY?.trim();
  if (!fromEnv && !terminal) {
    io.say("Ask the person to run `npx synthe key` in their own terminal.");
    return false;
  }
  const key = fromEnv || (await io.askSecret(`Paste your key for ${host}: `)).trim();
  if (!key || /\s/.test(key)) { io.say(`Paste the key for ${host} on one line, then press Enter. Nothing changed.`); return false; }
  const found = await remoteGoal(io);
  if (!found) return false;
  const { slug, goal } = found;
  if (goal.provider?.kind !== "openai-compatible" || goal.provider.base_url !== provider.base_url) {
    io.say(`synthe.json on GitHub doesn't send model calls to ${provider.base_url} yet, and the workflow uses the one there. Push your synthe.json first, then run \`npx synthe key\` again. Nothing changed.`);
    return false;
  }
  try {
    await (io.other ?? providerModel)(goal.provider, key).ask({ model: goal.models.runner, user: "Say OK.", maxTokens: 5 });
  } catch (error) {
    io.say(`${modelProblem(error) ?? (error as Error).message} Nothing changed.`);
    return false;
  }
  await saveKey(io, slug, goal, "SYNTHE_API_KEY", key, `this key for ${host}`, `your own key for ${host}`);
  return true;
}

// Switching an Anthropic or event-credit repo to another provider: the key, the models and their costs, one cheap call,
// then synthe.json here is rewritten and the key saved as SYNTHE_API_KEY. Rounds keep their current credential until
// the team pushes synthe.json: until then the workflow ignores a SYNTHE_API_KEY that isn't an Anthropic key.
async function switchProvider(io: Pick<Io, "askSecret" | "run" | "say" | "ask"> & Partial<Pick<Io, "other" | "listModels">>, picked: { preset?: Preset; baseUrl: string }, root: string): Promise<boolean> {
  const host = providerHost({ kind: "openai-compatible", base_url: picked.baseUrl });
  if (picked.preset) io.say(`Get a key at ${picked.preset.signup} if you don't have one yet, then paste it here.`);
  const key = (await io.askSecret(`Paste your key for ${host}: `)).trim();
  if (!key || /\s/.test(key)) { io.say(`Paste the key for ${host} on one line, then press Enter. Nothing changed.`); return false; }
  const found = await remoteGoal(io);
  if (!found) return false;
  const models = await pickModels(io, picked.baseUrl, key, null, undefined, picked.preset);
  if (!models) { io.say("Synthe needs a model name the provider serves. Nothing changed."); return false; }
  const costs = await askCosts(io, host, models, undefined, picked.preset);
  if (!costs) { io.say("Synthe needs a price for each model. Nothing changed."); return false; }
  const other = otherSetup(picked.baseUrl, models, costs, picked.preset);
  if (!(await checkOther(io, other, key, "Nothing changed."))) return false;
  const path = join(root, GOAL_FILE);
  const saved = JSON.parse(readFileSync(path, "utf8"));
  const next = { ...saved, models, provider: other.provider, budget: { ...saved.budget, ...(other.maxCalls ? { max_calls: other.maxCalls } : {}) } };
  parseGoal(JSON.stringify(next));
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  await saveKey(io, found.slug, found.goal, "SYNTHE_API_KEY", key, `this key for ${host}`, `your own key for ${host}`);
  io.say(`Saved ${GOAL_FILE} with ${picked.preset?.name ?? host}. Rounds use it once you push it: git commit -m "Synthe: use ${picked.preset?.name ?? host}" ${GOAL_FILE} && git push`);
  return true;
}

// Saves the secret (on stdin, never in argv) and starts the own-key budget the first time a key is saved.
async function saveKey(io: Pick<Io, "run" | "say">, slug: string, goal: Goal, secret: string, key: string, thisKey: string, ownKey: string): Promise<void> {
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
  await io.run("gh", ["secret", "set", secret, "--repo", slug], key);
  if (state.ownKeyFromUsd !== undefined) {
    const budgetStop = Boolean(state.stopped && /^budget/.test(state.stopped));
    io.say(`Rounds now use ${thisKey}. The budget is unchanged: $${goal.budget.max_usd} from when you first ran \`npx synthe key\` (budget.max_usd in synthe.json).${budgetStop ? " To keep going, raise budget.max_usd in synthe.json and push it, then run `npx synthe restart`." : state.stopped ? " Run `npx synthe restart` to continue." : ""}`);
    return;
  }
  state.ownKeyFromUsd = state.spendUsd;
  const content = Buffer.from(`${JSON.stringify(state, null, 2)}\n`).toString("base64");
  await io.run("gh", ["api", "-X", "PUT", path, "-f", "message=Synthe: switched to own key", "-f", `branch=${STATE_BRANCH}`, ...(file ? ["-f", `sha=${file.sha}`] : []), "-f", `content=${content}`]);
  io.say(`Rounds now use ${ownKey}, with a fresh $${goal.budget.max_usd} budget (budget.max_usd in synthe.json).${state.stopped ? " Run `npx synthe restart` to continue." : ""}`);
}
