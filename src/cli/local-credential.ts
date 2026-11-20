// Which credential `try` and `calibrate` use on this computer. Said out loud every time, so a key in
// ANTHROPIC_API_KEY (often the app's own) is never charged without the team seeing it. Null when there is none.
export interface LocalCredential { key: string; line: string }

export function localCredential(env: Partial<Record<string, string>>): LocalCredential | null {
  const own = env.SYNTHE_ANTHROPIC_KEY?.trim(), app = env.ANTHROPIC_API_KEY?.trim();
  if (own) return { key: own, line: "Credential: your own key from SYNTHE_ANTHROPIC_KEY, charged to that Anthropic account." };
  if (app) return { key: app, line: "Credential: the key in ANTHROPIC_API_KEY, charged to that Anthropic account." };
  return null;
}
