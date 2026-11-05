export interface AgentOptions {
  confirm: boolean; keepChecks: boolean; prompt?: string; objective?: string; mode?: "auto" | "review";
  messages: string[]; checks: string[];
  share?: "none" | "numbers" | "detail";
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
    if (!["--prompt", "--objective", "--mode", "--message", "--check", "--share"].includes(flag)) askPerson(flag);
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
    if (flag === "--message") result.messages.push(value);
    if (flag === "--check") result.checks.push(value);
  }
  if (result.messages.length > 5 || result.messages.some((text) => text.length > 500)) askPerson("--message");
  if (result.checks.length > 5 || result.checks.some((text) => text.length > 300)) askPerson("--check");
  if (result.confirm) {
    if (result.prompt || result.objective || result.mode || result.messages.length) askPerson("--confirm");
    if ((!result.checks.length && !result.keepChecks) || (result.checks.length && result.keepChecks)) askPerson("--check or --keep-checks");
  } else {
    if (!result.prompt) askPerson("--prompt");
    if (!result.objective) askPerson("--objective");
    if (!result.mode) askPerson("--mode");
    if (result.keepChecks) askPerson("--keep-checks");
  }
  return result;
}
