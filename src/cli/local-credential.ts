import type { Provider } from "../core/goal.ts";
import { providerHost } from "../model/client.ts";

// Which credential `try` and `calibrate` use on this computer. Said out loud every time, so a key in
// ANTHROPIC_API_KEY (often the app's own) is never charged without the team seeing it. Null when there is none.
// provider: from synthe.json. Another provider takes only SYNTHE_API_KEY: an Anthropic key or event code is no use
// there, and OPENAI_API_KEY and the like are never read, since they are usually the app's own.
export interface LocalCredential { key?: string; eventCode?: string; teamCode?: string; line: string }

export function localCredential(env: Partial<Record<string, string>>, provider?: Provider): LocalCredential | null {
  const generic = env.SYNTHE_API_KEY?.trim();
  if (provider?.kind === "openai-compatible") {
    return generic ? { key: generic, line: `Credential: your own key from SYNTHE_API_KEY, sent to ${providerHost(provider)} and charged to that account.` } : null;
  }
  const own = env.SYNTHE_ANTHROPIC_KEY?.trim(), eventCode = env.SYNTHE_EVENT_CODE?.trim(), teamCode = env.SYNTHE_TEAM_CODE?.trim() || undefined, app = env.ANTHROPIC_API_KEY?.trim();
  // Only an Anthropic key: anything else in SYNTHE_API_KEY is for a provider synthe.json doesn't name (yet).
  if (generic?.startsWith("sk-ant-")) return { key: generic, line: "Credential: your own key from SYNTHE_API_KEY, charged to that Anthropic account." };
  if (own) return { key: own, line: "Credential: your own key from SYNTHE_ANTHROPIC_KEY, charged to that Anthropic account." };
  if (eventCode) return { eventCode, teamCode, line: teamCode ? "Credential: Crimson Hacks event credit, with your team code from SYNTHE_TEAM_CODE." : "Credential: Crimson Hacks event credit. SYNTHE_TEAM_CODE isn't set, so the Synthe proxy will ask for your team code." };
  if (app) return { key: app, line: "Credential: the key in ANTHROPIC_API_KEY, charged to that Anthropic account. To use event credit instead, set SYNTHE_EVENT_CODE and SYNTHE_TEAM_CODE." };
  return null;
}
