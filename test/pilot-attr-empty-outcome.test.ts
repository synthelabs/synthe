// Proposed regression test. docs/PILOT.md: once another version has served a conversation, with no outcome recorded
// before that call "every value is empty and it is counted as unattributed". An outcome line that records nothing
// ({} or every metric null) before the other version's call makes export.ts count the conversation as
// other_version_after_outcome (attributed), so it escapes served_two_versions and the max_unattributed_rate refusal.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readCallLog } from "../src/pilot/calllog.ts";
import { parsePilotConfig } from "../src/pilot/config.ts";
import { DEMO, demoConfig } from "../src/pilot/demo-data.ts";
import { PilotError } from "../src/pilot/errors.ts";
import { buildLogExport } from "../src/pilot/export.ts";

const BASE = DEMO.baseline_tag, CAND = "synthe-0123456789ab", A = "Juniper";
const call = (id: string, at: string, v: string = BASE) => ({ v: 1, type: "call", at, agent: A, conversation_id: id, prompt_version: v });
const out = (id: string, at: string, values: Record<string, number | null>) => ({ v: 1, type: "outcome", at, agent: A, conversation_id: id, values });
const R = { resolved: 1, escalated: 0, refund_usd: 0 };
function exportOf(lines: object[]) {
  const dir = join(mkdtempSync(join(tmpdir(), "rev-empty-")), "log"); mkdirSync(dir);
  writeFileSync(join(dir, "calls-2026-11-01.jsonl"), lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
  return buildLogExport({ log: readCallLog(dir), agent: A, contract: { ...parsePilotConfig(JSON.stringify(demoConfig())).metric, max_unattributed_rate: 0.4 }, tags: [BASE, CAND], window: { start: "2026-11-01T00:00:00Z", end: "2026-11-15T00:00:00Z" }, exported_at: "2026-11-20T00:00:00Z", assignment: "randomized", export_id: "e", csv_name: "e.csv" });
}
for (const [label, empty] of [["{}", {}], ["all null", { resolved: null, escalated: null, refund_usd: null }]] as const) {
  test(`an outcome line that records nothing (${label}) before the other version's call is still unattributed`, () => {
    const lines = [
      call("a", "2026-11-02T10:00:00Z"), out("a", "2026-11-02T11:00:00Z", R),
      call("b", "2026-11-02T10:00:00Z"), out("b", "2026-11-02T10:10:00Z", empty), call("b", "2026-11-02T10:30:00Z", CAND), out("b", "2026-11-02T11:00:00Z", R),
    ];
    // Same log without the empty line: 1 of 2 unattributed > 0.4, refused. The empty line must not change that.
    assert.throws(() => exportOf(lines), (e) => e instanceof PilotError && e.code === "telemetry_incomplete");
  });
}
