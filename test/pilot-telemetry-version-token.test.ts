// Proposed regression test (review "recheck", 2026-11-17).
// Rule: a refusal never repeats a recorder token. `shown` now hides a token used as a column name, but the
// prompt_version refusal (versionCheck) repeats up to three values as written. An export whose prompt_version column
// carries the conversation token (a query that selected the wrong column) puts three tokens into the refusal, which
// the CLI prints and `watch` writes into WATCH.md.
import assert from "node:assert/strict";
import { test } from "node:test";
import { demoConfig } from "../src/pilot/demo-data.ts";
import { importTelemetry } from "../src/pilot/telemetry.ts";
import { TELEMETRY_FORMAT, type MetricContract } from "../src/pilot/types.ts";
import { TOKEN_SHAPE } from "../src/pilot/wrap.ts";

test("a prompt_version refusal never repeats a recorder token", () => {
  const contract = (demoConfig() as { metric: MetricContract }).metric;
  const tok = (i: number) => Array.from({ length: 32 }, (_, k) => "abcdefghijklmnop"[(i * 7 + k * 3) % 16]).join("");
  const rows = Array.from({ length: 10 }, (_, i) => [tok(i), tok(i), `2026-11-0${1 + (i % 5)}T10:00:00Z`, "", "", "", "1", "0", "0"].join(","));
  const csv = `${["conversation_id,prompt_version,started_at,segment,unit_id,model_id,resolved,escalated,refund_usd", ...rows].join("\n")}\n`;
  const metrics = [contract.primary, ...contract.guards] as { name: string; unit: string }[];
  const header = { format: TELEMETRY_FORMAT, export_id: "x", source: "s", exported_at: "2026-11-06T00:00:00Z", window: { start: "2026-11-01T00:00:00Z", end: "2026-11-06T00:00:00Z" }, assignment: "randomized", denominator: contract.denominator, units: Object.fromEntries(metrics.map((m) => [m.name, m.unit])), expected_rows: 10, rows_csv: "x.csv" };
  let message = "";
  try {
    importTelemetry({ text: JSON.stringify(header), readSibling: () => csv, purpose: "experiment", scope_id: "0".repeat(64), contract, tags: ["juniper-v14", "synthe-0123456789ab"], window: { start: "2026-11-01T00:00:00Z", end: "2026-11-15T00:00:00Z" } });
  } catch (e) { message = (e as Error).message; }
  assert.ok(message !== "", "the export is refused");
  const repeated = message.split(/[^a-z]+/).filter((w) => TOKEN_SHAPE.test(w));
  assert.deepEqual(repeated, [], `the refusal repeats ${repeated.length} recorder token(s): ${message.slice(0, 160)}`);
});
