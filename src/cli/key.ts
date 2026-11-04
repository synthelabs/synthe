import { STATE_BRANCH } from "../core/goal.ts";
import type { Io } from "./init.ts";

export async function setKey(io: Pick<Io, "askSecret" | "run" | "say">, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const key = (env.SYNTHE_ANTHROPIC_KEY || env.ANTHROPIC_API_KEY || await io.askSecret("Paste your own Anthropic key: ")).trim();
  if (!/^sk-ant-\S+$/.test(key)) { io.say("That doesn't look like an Anthropic key: it must start with sk-ant-. Nothing changed."); return false; }
  const slug = (await io.run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])).trim();
  await io.run("gh", ["secret", "set", "SYNTHE_ANTHROPIC_KEY", "--repo", slug], key);
  io.say("Rounds now use your own Anthropic key. The event credit is no longer used.");
  try {
    const state = JSON.parse(await io.run("gh", ["api", `repos/${slug}/contents/state.json?ref=${encodeURIComponent(STATE_BRANCH)}`, "-H", "Accept: application/vnd.github.raw+json"]));
    if (state.stopped === "credit") io.say("The run stopped on event credit. Run `npx synthe restart` to continue.");
  } catch { io.say("If the run stopped on event credit, run `npx synthe restart` to continue."); }
  return true;
}
