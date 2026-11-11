import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePilotConfig } from "../src/pilot/config.ts";
import { demoConfig } from "../src/pilot/demo-data.ts";
import { PilotError } from "../src/pilot/errors.ts";

type Json = Record<string, any>;
const config = (change: (c: Json) => void = () => {}): string => { const c = structuredClone(demoConfig()) as Json; change(c); return JSON.stringify(c); };
const code = (text: string): string => {
  try { parsePilotConfig(text); } catch (e) { return e instanceof PilotError ? `${e.code}: ${e.message}` : `not a PilotError: ${(e as Error).message}`; }
  return "accepted";
};
const approval = { provider: "anthropic", endpoint: "https://api.anthropic.com", model: "claude-opus-5-5", key_env: "FERNHILL_PILOT_KEY", data_class: "redacted support conversations (pack)", approved_by: "Rhea Castellan", approved_at: "2026-10-01T00:00:00Z", max_calls: 500, max_input_chars: 2_000_000 };

test("the synthetic pilot's config parses, with provider null meaning scripted models only", () => {
  const parsed = parsePilotConfig(config());
  assert.equal(parsed.pilot_id, "fernhill-juniper");
  assert.equal(parsed.provider, null);
  assert.equal(parsed.repo.api, undefined);
  assert.equal(parsed.metric.primary.name, "resolved");
});

test("a typo, a missing field or an out-of-range number is refused instead of defaulted", () => {
  for (const [why, change] of [
    ["unknown top-level field", (c: Json) => { c.metrics = c.metric; }],
    ["unknown gate field", (c: Json) => { c.replay.gate.min_paired_case = 5; }],
    ["no provider field at all", (c: Json) => { delete c.provider; }],
    ["coverage above 1", (c: Json) => { c.replay.gate.min_paired_coverage = 70; }],
    ["a single case is not recurring", (c: Json) => { c.replay.min_recurring_cases = 1; }],
    ["version 2", (c: Json) => { c.version = 2; }],
    ["pilot id with capitals", (c: Json) => { c.pilot_id = "Fernhill"; }],
    ["repo slug without owner", (c: Json) => { c.repo.slug = "support-agent"; }],
    ["base branch climbing out", (c: Json) => { c.repo.base = "../main"; }],
    ["no agent name", (c: Json) => { c.agent.name = " "; }],
  ] as const) {
    assert.match(code(config(change)), /^invalid_config: pilot\.json: /, why);
  }
  assert.match(code("{"), /^invalid_config/);
  assert.match(code(config((c) => { c.metric.primary.min_efect = 0.1; })), /^invalid_metric/);
});

test("the prompt path must be a plain file inside the repo, never a sensitive one", () => {
  for (const path of ["/etc/passwd", "../other/prompt.md", ".github/workflows/deploy.yml", ".env", "synthe.json"]) {
    assert.match(code(config((c) => { c.agent.prompt_path = path; })), /^invalid_config: pilot\.json: agent\.prompt_path/, path);
  }
});

test("a review can only go to GitHub itself or a loopback stand-in", () => {
  assert.equal(code(config((c) => { c.repo.api = "https://api.github.com"; })), "accepted");
  assert.equal(code(config((c) => { c.repo.api = "http://127.0.0.1:4010"; })), "accepted");
  for (const api of ["https://github.example.com/api", "http://10.0.0.5:4010", "https://api.github.com.evil.example", "not a url"]) {
    assert.match(code(config((c) => { c.repo.api = api; })), /^invalid_config: pilot\.json: repo\.api/, api);
  }
});

test("a provider approval must say where the data goes, under whose approval, with which limits and which key variable", () => {
  assert.equal(code(config((c) => { c.provider = approval; })), "accepted");
  for (const [why, change] of [
    ["plain http endpoint", { endpoint: "http://gateway.example.com" }],
    ["credentials in the endpoint", { endpoint: "https://user:pass@api.anthropic.com" }],
    ["a query on the endpoint", { endpoint: "https://api.anthropic.com/?route=x" }],
    ["another provider", { provider: "someone-else" }],
    ["no approver", { approved_by: "" }],
    ["no data class", { data_class: "" }],
    ["a key value instead of a variable name", { key_env: "sk-not-a-variable-name" }],
    ["no call limit", { max_calls: 0 }],
    ["a bad approval time", { approved_at: "yesterday" }],
    ["an extra field", { fallback_key_env: "ANTHROPIC_API_KEY" }],
  ] as const) {
    assert.match(code(config((c) => { c.provider = { ...approval, ...change }; })), /^invalid_config: pilot\.json: provider/, why);
  }
  assert.equal(code(config((c) => { c.provider = { ...approval, endpoint: "http://127.0.0.1:8089" }; })), "accepted", "a loopback test server may use http");
});
