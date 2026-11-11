import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PilotError } from "../src/pilot/errors.ts";
import { contentId, promptId } from "../src/pilot/ids.ts";
import { inside, readBounded, writeOnce } from "../src/pilot/io.ts";
import { PilotStore } from "../src/pilot/store.ts";

const fresh = () => new PilotStore(mkdtempSync(join(tmpdir(), "pilot-store-")));
const code = (fn: () => unknown): string => {
  try { fn(); } catch (e) { return e instanceof PilotError ? e.code : `not a PilotError: ${(e as Error).message}`; }
  return "no error";
};

test("a record is stored under its content id, and storing it again changes nothing", () => {
  const store = fresh();
  const value = { b: 2, a: [1, { z: 1, y: 2 }] };
  const id = store.put("finding", value);
  assert.equal(id, contentId({ a: [1, { y: 2, z: 1 }], b: 2 }), "key order does not change the id");
  assert.equal(store.put("finding", { a: [1, { y: 2, z: 1 }], b: 2 }), id);
  assert.deepEqual(store.get("finding", id), value);
  assert.deepEqual(store.list("finding"), [id]);
});

test("a record edited after it was written is refused, not used", () => {
  const store = fresh();
  const id = store.put("analysis", { recommendation: "hold" });
  const path = join(store.dir, "objects", "analysis", `${id}.json`);
  writeFileSync(path, readFileSync(path, "utf8").replace("hold", "keep"));
  assert.equal(code(() => store.get("analysis", id)), "tampered");
});

test("a stored file is never replaced by different content", () => {
  const dir = mkdtempSync(join(tmpdir(), "pilot-io-"));
  const path = join(dir, "approval.json");
  assert.equal(writeOnce(path, "first"), "written");
  assert.equal(writeOnce(path, "first"), "already there");
  assert.equal(code(() => writeOnce(path, "second")), "conflict");
  assert.equal(readFileSync(path, "utf8"), "first");
});

test("prompts are stored by the hash of their text and checked on read", () => {
  const store = fresh();
  const id = store.putPrompt("You are Juniper.\n");
  assert.equal(id, promptId("You are Juniper.\n"));
  assert.equal(store.getPrompt(id), "You are Juniper.\n");
  writeFileSync(join(store.dir, "objects", "prompt", `${id}.txt`), "You are someone else.\n");
  assert.equal(code(() => store.getPrompt(id)), "tampered");
});

test("the journal is a chain: a retry adds nothing, and an edited or shortened journal is refused", () => {
  const store = fresh();
  const first = store.record("pack.frozen", "k1", { pack: "p1" }, "2026-10-01T00:00:00Z");
  const again = store.record("pack.frozen", "k1", { pack: "p1" }, "2026-10-02T00:00:00Z");
  assert.deepEqual(again, first, "the same step, key and refs return the first entry");
  store.record("replay.paired", "k2", { replay: "r1" }, "2026-10-01T00:01:00Z");
  store.record("analysis.decided", "k3", { recommendation: "hold" }, "2026-10-01T00:02:00Z");
  assert.equal(store.journal().length, 3);
  assert.equal(code(() => store.record("pack.frozen", "k1", { pack: "another" }, "2026-10-03T00:00:00Z")), "conflict");

  const path = join(store.dir, "journal.jsonl");
  const lines = readFileSync(path, "utf8").trimEnd().split("\n");
  writeFileSync(path, `${lines.join("\n").replace('"hold"', '"keep"')}\n`);
  assert.equal(code(() => store.journal()), "tampered", "an edited entry no longer matches its hash");
  writeFileSync(path, `${[lines[0], lines[2]].join("\n")}\n`);
  assert.equal(code(() => store.journal()), "tampered", "a removed entry breaks the chain");
  writeFileSync(path, `${lines.join("\n")}\n`);
  assert.equal(store.journal().length, 3);
  appendFileSync(path, "not json\n");
  assert.equal(code(() => store.journal()), "tampered");
});

test("a lock left by a process that died does not block the retry", () => {
  const store = fresh();
  store.record("config.frozen", "k", { config: "c" }, "2026-10-01T00:00:00Z");
  writeFileSync(join(store.dir, "journal.lock"), "999999999");
  store.record("pack.frozen", "k", { pack: "p" }, "2026-10-01T00:01:00Z");
  assert.equal(store.journal().length, 2);
});

test("ids resolve from a unique prefix of at least 8 characters, never from less", () => {
  const store = fresh();
  const id = store.put("experiment", { n: 1 });
  assert.equal(store.resolve("experiment", id.slice(0, 12)), id);
  assert.equal(store.resolve("experiment", id), id);
  assert.equal(code(() => store.resolve("experiment", id.slice(0, 6))), "usage");
  assert.equal(code(() => store.resolve("experiment", "0".repeat(12))), "not_found");
  assert.equal(code(() => store.get("experiment", "not-an-id")), "usage");
});

test("input files are bounded and a file name from an input cannot leave its directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "pilot-io-"));
  writeFileSync(join(dir, "big.json"), "x".repeat(2000));
  assert.equal(code(() => readBounded(join(dir, "big.json"), 1000)), "too_large");
  assert.equal(code(() => readBounded(join(dir, "missing.json"))), "not_found");
  assert.equal(code(() => readBounded(dir)), "not_found");
  assert.equal(inside(dir, "rows.csv"), join(dir, "rows.csv"));
  for (const name of ["../secrets.csv", "/etc/passwd", "a/../../b.csv", ""]) assert.equal(code(() => inside(dir, name)), "usage", name);
});
