import { PRESETS, presetById } from "../model/presets.ts";
export interface AgentOptions {
  confirm: boolean; keepChecks: boolean; prompt?: string; objective?: string; mode?: "auto" | "review";
  messages: string[]; checks: string[];
  share?: "none" | "numbers" | "detail";
  // Another provider (step 1 only): its OpenAI-compatible URL, the one model for every role, and that model's price
  // in US dollars per million input and output tokens.
  baseUrl?: string; model?: string; price?: { input: number; output: number };
  // A provider from src/model/presets.ts (fills base URL and models), and --free: a free-tier key, so no prices, a
  // call cap and slow pacing.
  preset?: string; free?: boolean;
}

export class AgentSetupError extends Error {}
export function askPerson(flag: string): never { throw new AgentSetupError(`${flag} is missing or invalid. Ask the person; don't guess.`); }

export function agentOptions(args: string[]): AgentOptions | undefined {
  if (!args.includes("--agent")) return undefined;
  const result: AgentOptions = { confirm: false, keepChecks: false, messages: [], checks: [] };
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (seen.has(flag) && flag !== "--message" && flag !== "--check") askPerson(flag);
    seen.add(flag);
    if (flag === "--agent") continue;
    if (flag === "--confirm") { result.confirm = true; continue; }
    if (flag === "--keep-checks") { result.keepChecks = true; continue; }
    if (flag === "--free") { result.free = true; continue; }
    if (!["--prompt", "--objective", "--mode", "--message", "--check", "--share", "--base-url", "--model", "--price", "--preset"].includes(flag)) askPerson(flag);
    const value = args[++index]?.trim();
    if (!value || value.startsWith("--")) askPerson(flag);
    if (flag === "--prompt") result.prompt = value;
    if (flag === "--objective") result.objective = value;
    if (flag === "--share") {
      if (value !== "none" && value !== "numbers" && value !== "detail") askPerson(flag);
      result.share = value;
    }
    if (flag === "--mode") {
      if (value !== "auto" && value !== "review") askPerson(flag);
      result.mode = value;
    }
    if (flag === "--base-url") result.baseUrl = value;
    if (flag === "--preset") {
      if (!presetById(value)) askPerson(`--preset (one of ${PRESETS.map((p) => p.id).join(", ")})`);
      result.preset = value;
    }
    if (flag === "--model") {
      if (/\s/.test(value)) askPerson(flag);
      result.model = value;
    }
    if (flag === "--price") {
      const m = value.replace(/\$/g, "").match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
      if (!m) askPerson("--price (US dollars per million input and output tokens, like 0.40/1.60)");
      result.price = { input: Number(m[1]), output: Number(m[2]) };
    }
    if (flag === "--message") result.messages.push(value);
    if (flag === "--check") result.checks.push(value);
  }
  if (result.messages.length > 5 || result.messages.some((text) => text.length > 500)) askPerson("--message");
  if (result.checks.length > 5 || result.checks.some((text) => text.length > 300)) askPerson("--check");
  if (result.confirm) {
    if (result.prompt || result.objective || result.mode || result.messages.length || result.baseUrl || result.model || result.price || result.preset || result.free) askPerson("--confirm");
    if ((!result.checks.length && !result.keepChecks) || (result.checks.length && result.keepChecks)) askPerson("--check or --keep-checks");
  } else {
    if (!result.prompt) askPerson("--prompt");
    if (!result.objective) askPerson("--objective");
    if (!result.mode) askPerson("--mode");
    if (result.keepChecks) askPerson("--keep-checks");
    if ((result.model || result.price || result.free) && !result.baseUrl && !result.preset) askPerson("--base-url or --preset (--model, --price and --free are for another provider)");
    if (result.free && result.price) askPerson("--free or --price, not both");
  }
  return result;
}

// `npx synthe init --base-url URL` in a terminal: another provider's OpenAI-compatible API. Undefined when not given.
export function baseUrlOption(args: string[]): string | undefined {
  const i = args.indexOf("--base-url");
  if (i === -1) return undefined;
  const value = args[i + 1]?.trim();
  if (!value || value.startsWith("--")) throw new AgentSetupError("--base-url needs your provider's OpenAI-compatible URL, for example: npx synthe init --base-url https://api.openai.com/v1");
  return value;
}
