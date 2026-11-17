// Regression tests proposed by the attribution review, for the call log itself.
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readCallLog } from "../src/pilot/calllog.ts";
import { DEMO } from "../src/pilot/demo-data.ts";
import { pilotRecorder } from "../src/pilot/wrap.ts";

const BASE = DEMO.baseline_tag;
const fresh = () => join(mkdtempSync(join(tmpdir(), "attr-lines-")), "log");
const V = { resolved: 1, escalated: 0, refund_usd: 0 };

test("a recorder that appends after a crash left a torn line does not lose its own complete line", () => {
  const dir = fresh();
  const rec = pilotRecorder({ logDir: dir, agent: "Juniper", rawIds: true, now: () => new Date("2026-11-02T10:00:00Z") });
  rec.record({ promptVersion: BASE, conversationId: "t1" });
  rec.record({ promptVersion: BASE, conversationId: "t3" });
  rec.outcome("t1", V);
  // Another process sharing the log died in the middle of a write.
  appendFileSync(join(dir, "calls-2026-11-02.jsonl"), '{"v":1,"type":"outcome","at":"2026-11-02T10:00:00.000Z","agent":"Juniper","conversation_id":"t3","val');
  rec.outcome("t3", V); // the retried outcome, complete
  const log = readCallLog(dir);
  const c = [...log.conversations.values()].find((x) => x.conversation_id === "t3");
  assert.equal(c?.outcome_lines, 1, `the complete outcome line written after the torn fragment was lost (malformed lines: ${log.malformed})`);
});
