// Proposed regression tests (privacy lens) for the recorder, src/pilot/wrap.ts. Each fails at 6e51f01.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pilotRecorder } from "../src/pilot/wrap.ts";

const DAY = "2026-11-02T00:00:00Z";
const LOG = `calls-${DAY.slice(0, 10)}.jsonl`;
const fresh = () => mkdtempSync(join(tmpdir(), "wrap-privacy-"));
const KEY = "a-strong-id-key-0123456789abcdef";

test("the recorder never follows a symbolic link planted under the log's name", () => {
  const base = fresh();
  const logDir = join(base, "log");
  mkdirSync(logDir);
  chmodSync(logDir, 0o777); // a shared or loosely created folder: another local user can plant files in it
  const victim = join(base, "elsewhere.txt");
  writeFileSync(victim, "untouched\n", { mode: 0o644 });
  symlinkSync(victim, join(logDir, LOG));
  const rec = pilotRecorder({ logDir, agent: "A", rawIds: true, now: () => new Date(DAY) });
  rec.record({ promptVersion: "v1", conversationId: "customer-raw-id-1" });
  assert.equal(readFileSync(victim, "utf8"), "untouched\n", "the customer id was appended to the link's target");
  assert.equal(rec.problems(), 1, "the refused write is counted as write_failed");
});

test("a blank or very short idKey is refused at startup: it would let anyone reverse the tokens", () => {
  const logDir = join(fresh(), "log");
  for (const idKey of [" ", "\n", "\u0000", "a", "secret"]) {
    assert.throws(() => pilotRecorder({ logDir, agent: "A", idKey }), TypeError, `idKey ${JSON.stringify(idKey)} was accepted`);
  }
  assert.doesNotThrow(() => pilotRecorder({ logDir, agent: "A", idKey: KEY }));
});
