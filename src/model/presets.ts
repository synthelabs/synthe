import type { Goal } from "../core/goal.ts";

// Providers with a free tier, offered in `init` and `key` to a team with no key. Each is used through its
// OpenAI-compatible API (src/model/openai-compatible.ts).
//
// UNVERIFIED: none of these base URLs, model ids or sign-up pages could be checked against the providers' docs when
// this table was written. Check every entry against the provider's current docs before a release. Never put a free
// tier's limits (requests, tokens, days) in this file or in any text a team reads: the provider sets them and changes
// them, and Synthe stops cleanly when they run out.
//
// maxRequestsPerMinute is Synthe's own pacing, deliberately slow, not the provider's limit. A round makes many calls,
// so slower pacing makes the score step take longer, and the workflow gives it 15 minutes.
export interface Preset {
  id: string;
  name: string;
  baseUrl: string;
  signup: string; // where a person gets a key
  models: Goal["models"];
  maxRequestsPerMinute: number;
}

export const PRESETS: Preset[] = [
  {
    id: "gemini", name: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", signup: "https://aistudio.google.com/apikey",
    models: { writer: "gemini-2.5-flash", runner: "gemini-2.5-flash", judge: "gemini-2.5-flash", checker: "gemini-2.5-flash" },
    maxRequestsPerMinute: 15,
  },
  {
    id: "groq", name: "Groq", baseUrl: "https://api.groq.com/openai/v1", signup: "https://console.groq.com/keys",
    models: { writer: "llama-3.3-70b-versatile", runner: "llama-3.1-8b-instant", judge: "llama-3.3-70b-versatile", checker: "llama-3.3-70b-versatile" },
    maxRequestsPerMinute: 20,
  },
  {
    id: "openrouter", name: "OpenRouter (free models)", baseUrl: "https://openrouter.ai/api/v1", signup: "https://openrouter.ai/keys",
    models: { writer: "meta-llama/llama-3.3-70b-instruct:free", runner: "meta-llama/llama-3.3-70b-instruct:free", judge: "meta-llama/llama-3.3-70b-instruct:free", checker: "meta-llama/llama-3.3-70b-instruct:free" },
    maxRequestsPerMinute: 15,
  },
];

export const presetById = (id: string) => PRESETS.find((p) => p.id === id);

// The call cap a free key gets at setup when the team gives no prices: enough for a few rounds, so a key that turns
// out to be on a paid plan can't run up a bill.
export const FREE_MAX_CALLS = 500;
