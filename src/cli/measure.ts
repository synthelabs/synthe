// `synthe measure draft --examples <file.jsonl> --out <dir> [--problem <file> | --model <id>]`: drafts a judged
// measure from examples and checks it against the person's labels. See src/solve/draft.ts.
import { resolve } from "node:path";
import { anthropicModel, type Model } from "../model/client.ts";
import { openAiCompatibleModel } from "../model/openai-compatible.ts";
import { draftMeasure, examplesFile, providerKey, type DraftModel } from "../solve/draft.ts";
import { loadProblem } from "./problem.ts";

const USAGE = "Usage: npx synthe measure draft --examples <file.jsonl> --out <dir> [--problem <problem-file> | --model <model-id>]";

// The key rule lives with the draft code, so the CLI and compare.js's environment agree.
export { providerKey } from "../solve/draft.ts";

export async function measureCommand(args: string[], cwd: string, say: (line: string) => void, env: NodeJS.ProcessEnv, client?: Model): Promise<number> {
  const takesValue = ["--examples", "--out", "--problem", "--model"];
  const value = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const stray = args.slice(1).filter((a, i, rest) => (a.startsWith("--") ? !takesValue.includes(a) : !takesValue.includes(rest[i - 1] ?? "")));
  const examplesPath = value("--examples"), out = value("--out"), problemPath = value("--problem"), modelId = value("--model");
  if (args[0] !== "draft" || stray.length || !examplesPath || !out) { say(USAGE); return 1; }
  if (problemPath && modelId) { say("Give --problem or --model, not both."); return 1; }
  if (!problemPath && !modelId) { say("measure draft asks a model for the rubric. Give --model <model-id> for Anthropic, or --problem <file> to use the model in a problem file."); return 1; }

  let m: DraftModel;
  if (modelId) m = { provider: "anthropic", model: modelId };
  else {
    const check = loadProblem(problemPath!, cwd);
    if (!check.ok) { for (const p of check.problems) say(p); return 1; }
    const config = check.problem.model as ({ provider?: string; base_url?: string; model?: string } | undefined);
    if (!config?.model) { say(`${problemPath}: measure draft needs model.model in the problem file, or use --model <model-id>.`); return 1; }
    const provider = config.provider === "anthropic" || config.provider === "openai-compatible" ? config.provider : config.base_url ? "openai-compatible" : "anthropic";
    if (provider === "openai-compatible" && !config.base_url) { say(`${problemPath}: the openai-compatible provider needs model.base_url.`); return 1; }
    m = { provider, model: config.model, ...(config.base_url ? { base_url: config.base_url } : {}) };
  }

  const examples = examplesFile(resolve(cwd, examplesPath));
  if (!examples.ok) { for (const p of examples.problems) say(p); return 1; }

  const key = providerKey(m.provider, env);
  if (!client && !key) {
    say(m.provider === "anthropic" ? "measure draft needs an Anthropic key: set SYNTHE_ANTHROPIC_KEY." : `measure draft needs a key for ${m.base_url}: set SYNTHE_API_KEY.`);
    return 1;
  }
  const keys = [env.SYNTHE_ANTHROPIC_KEY, env.SYNTHE_API_KEY].map((k) => k?.trim() ?? "").filter(Boolean);
  const hide = (text: string): string => keys.reduce((t, k) => t.split(k).join("[your key]"), text);
  const model = client ?? (m.provider === "anthropic" ? anthropicModel(key) : openAiCompatibleModel({ baseUrl: m.base_url!, apiKey: key }));
  try {
    return await draftMeasure(examples.examples, m, model, resolve(cwd, out), { say, env, hide });
  } catch (e) {
    say(`The model call failed: ${hide(e instanceof Error ? e.message : String(e))}`);
    return 1;
  }
}
