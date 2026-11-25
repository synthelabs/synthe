// `synthe measure draft --examples <file.jsonl> --out <dir> [--problem <file> | --model <id>]`: drafts a judged
// measure from examples and checks it against the person's labels. See src/solve/draft.ts.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { anthropicModel, type Model } from "../model/client.ts";
import { openAiCompatibleModel } from "../model/openai-compatible.ts";
import { draftMeasure, draftModelFrom, examplesFile, providerKey, type DraftModel } from "../solve/draft.ts";

const USAGE = "Usage: npx synthe measure draft --examples <file.jsonl> --out <dir> [--problem <problem-file> | --model <model-id>]";

// The key rule lives with the draft code, so the CLI and compare.js agree.
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
    // Only the model section: the problem file may have no measure yet, since this command drafts it.
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(resolve(cwd, problemPath!), "utf8")); } catch (e) {
      say(`${problemPath}: Synthe can't read this problem file as JSON (${(e as Error).message}).`);
      return 1;
    }
    const found = draftModelFrom(raw);
    if (!found.ok) { for (const p of found.problems) say(`${problemPath}: ${p}`); return 1; }
    m = found.model;
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
    const hintBase = problemPath ? dirname(resolve(cwd, problemPath)) : cwd;
    return await draftMeasure(examples.examples, m, model, resolve(cwd, out), { say, hide, hintBase });
  } catch (e) {
    say(`The model call failed: ${hide(e instanceof Error ? e.message : String(e))}`);
    return 1;
  }
}
