// Proposed regression test: a prompt_version refusal never repeats a conversation id (docs/PILOT.md: refusals never
// print a conversation id). An export query that selected the conversation id column as prompt_version puts raw ids
// (not recorder tokens) into the refusal; TOKEN_SHAPE only hides 32-letter a-p tokens.
import assert from "node:assert/strict";
import { test } from "node:test";
import { demoConfig } from "../src/pilot/demo-data.ts";
import { importTelemetry } from "../src/pilot/telemetry.ts";
import { TELEMETRY_FORMAT, type MetricContract } from "../src/pilot/types.ts";

for (const [label, idOf] of [
  ["raw ids", (i: number) => `conv-77${i}31-zx`],
  ["uppercase tokens", (i: number) => Array.from({ length: 32 }, (_, k) => "ABCDEFGHIJKLMNOP"[(i * 7 + k * 3) % 16]).join("")],
] as [string, (i: number) => string][]) {
  test(`a prompt_version refusal never repeats a conversation id (${label})`, () => {
    const contract = (demoConfig() as { metric: MetricContract }).metric;
    const ids = Array.from({ length: 10 }, (_, i) => idOf(i));
    const rows = ids.map((id, i) => [id, id, `2026-11-0${1 + (i % 5)}T10:00:00Z`, "", "", "", "1", "0", "0"].join(","));
    const csv = `${["conversation_id,prompt_version,started_at,segment,unit_id,model_id,resolved,escalated,refund_usd", ...rows].join("\n")}\n`;
    const metrics = [contract.primary, ...contract.guards] as { name: string; unit: string }[];
    const header = { format: TELEMETRY_FORMAT, export_id: "x", source: "s", exported_at: "2026-11-06T00:00:00Z", window: { start: "2026-11-01T00:00:00Z", end: "2026-11-06T00:00:00Z" }, assignment: "randomized", denominator: contract.denominator, units: Object.fromEntries(metrics.map((m) => [m.name, m.unit])), expected_rows: 10, rows_csv: "x.csv" };
    let message = "";
    try { importTelemetry({ text: JSON.stringify(header), readSibling: () => csv, purpose: "experiment", scope_id: "0".repeat(64), contract, tags: ["juniper-v14", "synthe-0123456789ab"], window: { start: "2026-11-01T00:00:00Z", end: "2026-11-15T00:00:00Z" } }); }
    catch (e) { message = (e as Error).message; }
    assert.ok(message !== "", "refused");
    const leaked = ids.filter((id) => message.includes(id));
    assert.deepEqual(leaked, [], `refusal repeats ${leaked.length} id(s): ${message.slice(0, 200)}`);
  });
}

// A wrong tag is still named, so the operator can see what was exported: a few distinct values are tags, many are ids.
test("up to three distinct unexpected prompt versions are still named; more are only counted", () => {
  const contract = (demoConfig() as { metric: MetricContract }).metric;
  const metrics = [contract.primary, ...contract.guards] as { name: string; unit: string }[];
  const refusalFor = (versions: string[]): string => {
    const rows = versions.map((v, i) => [`c${i}`, v, `2026-11-0${1 + (i % 5)}T10:00:00Z`, "", "", "", "1", "0", "0"].join(","));
    const csv = `${["conversation_id,prompt_version,started_at,segment,unit_id,model_id,resolved,escalated,refund_usd", ...rows].join("\n")}\n`;
    const header = { format: TELEMETRY_FORMAT, export_id: "x", source: "s", exported_at: "2026-11-06T00:00:00Z", window: { start: "2026-11-01T00:00:00Z", end: "2026-11-06T00:00:00Z" }, assignment: "randomized", denominator: contract.denominator, units: Object.fromEntries(metrics.map((m) => [m.name, m.unit])), expected_rows: rows.length, rows_csv: "x.csv" };
    try { importTelemetry({ text: JSON.stringify(header), readSibling: () => csv, purpose: "experiment", scope_id: "0".repeat(64), contract, tags: ["juniper-v14", "synthe-0123456789ab"], window: { start: "2026-11-01T00:00:00Z", end: "2026-11-06T00:00:00Z" } }); }
    catch (e) { return (e as Error).message; }
    return "";
  };
  assert.match(refusalFor(["juniper-v13", "juniper-v13", "beta", "juniper-v14"]), /3 rows carry a prompt_version that is not expected here \(beta, juniper-v13\)/);
  assert.match(refusalFor(["v1", "v2", "v3"]), /\(v1, v2, v3\)/);
  const four = refusalFor(["v1", "v2", "v3", "v4"]);
  assert.match(four, /4 rows carry a prompt_version that is not expected here \(4 different values, not shown/);
  assert.ok(!/v1|v2|v3|v4/.test(four.replace("juniper-v14", "")), four);
});
