import type { Goal } from "../core/goal.ts";

// Providers with a free tier, offered in `init` and `key` to a team with no key. Each is used through its
// OpenAI-compatible API (src/model/openai-compatible.ts).
//
// Base URLs and sign-up pages were verified on 2026-11-20 against the providers' own repos (google-gemini/cookbook,
// groq/groq-api-cookbook, OpenRouterTeam/openrouter-examples) and, for Gemini, against Google's API host. Model ids go
// stale faster, so setup checks every chosen model against the provider's GET {baseUrl}/models list before saving it
// (pickModels in src/cli/init.ts), and OpenRouter's free models are read from that list instead of named here.
//
// Never put a free tier's limits (requests, tokens, days) in this file or in any text a team reads: the provider sets
// them and changes them, and Synthe stops cleanly when they run out.
//
// maxRequestsPerMinute is Synthe's own pacing, deliberately slow, not the provider's limit. A round makes many calls,
// so slower pacing makes the score step take longer, and the workflow gives it 15 minutes.
export interface Preset {
  id: string;
  name: string;
  baseUrl: string;
  signup: string; // where a person gets a key
  // Suggested models per role, or null to offer the provider's free models from its /models list at setup.
  models: Goal["models"] | null;
  maxRequestsPerMinute: number;
  // Sent as reasoning_effort (provider.reasoning_effort in synthe.json). Gemini thinks hard by default, which can
  // spend a scoring call's small max_tokens before it answers, as Haiku's thinking would (see client.ts).
  reasoningEffort?: "low";
}

export const PRESETS: Preset[] = [
  {
    id: "gemini", name: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", signup: "https://aistudio.google.com/app/apikey",
    models: { writer: "gemini-4-hydrogen", runner: "gemini-4-hydrogen", judge: "gemini-4-hydrogen", checker: "gemini-4-hydrogen" },
    maxRequestsPerMinute: 15, reasoningEffort: "low",
  },
  {
    // Non-reasoning models suit Synthe's short JSON calls.
    id: "groq", name: "Groq", baseUrl: "https://api.groq.com/openai/v1", signup: "https://console.groq.com/keys",
    models: { writer: "llama-3.3-70b-versatile", runner: "llama-3.1-8b-instant", judge: "llama-3.3-70b-versatile", checker: "llama-3.3-70b-versatile" },
    maxRequestsPerMinute: 20,
  },
  {
    // Free model ids come and go, so none is named here: setup offers what the /models list prices at 0.
    id: "openrouter", name: "OpenRouter (free models)", baseUrl: "https://openrouter.ai/api/v1", signup: "https://openrouter.ai/keys",
    models: null,
    maxRequestsPerMinute: 15,
  },
];

export const presetById = (id: string) => PRESETS.find((p) => p.id === id);

// The call cap a free key gets at setup when the team gives no prices: enough for a few rounds, so a key that turns
// out to be on a paid plan can't run up a bill.
export const FREE_MAX_CALLS = 500;
