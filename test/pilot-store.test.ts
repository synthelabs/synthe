import assert from "node:assert/strict";
import { appendFileSync, existsSync, readdirSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PilotError } from "../src/pilot/errors.ts";
import { contentId, promptId } from "../src/pilot/ids.ts";
import { inside, readBounded, unsafeKey, writeOnce } from "../src/pilot/io.ts";
import { PilotStore } from "../src/pilot/store.ts";
import { tmp } from "./pilot-cli-helpers.ts";

const fresh = () => new PilotStore(tmp("pilot-store-"));
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
  const dir = tmp("pilot-io-");
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

  // A fresh lock held by a live process is respected; an old one is not, even if its process id is alive again
  // as something else (process 1 always is).
  const lock = join(store.dir, "journal.lock");
  writeFileSync(lock, "1");
  assert.equal(code(() => store.record("replay.paired", "k2", { replay: "r" }, "2026-10-01T00:02:00Z")), "conflict");
  const old = new Date(Date.now() - 5 * 60_000);
  utimesSync(lock, old, old);
  store.record("replay.paired", "k2", { replay: "r" }, "2026-10-01T00:02:00Z");
  assert.equal(store.journal().length, 3);
  assert.ok(!existsSync(lock));
});

test("entries cut off the end of the journal are noticed through its recorded head", () => {
  const store = fresh();
  for (let i = 1; i <= 4; i++) store.record("step", `k${i}`, { n: String(i) }, "2026-10-01T00:00:00Z");
  assert.deepEqual(store.head(), { seq: 4, hash: store.journal()[3].hash });
  const path = join(store.dir, "journal.jsonl");
  const whole = readFileSync(path, "utf8");
  writeFileSync(path, `${whole.trimEnd().split("\n").slice(0, 2).join("\n")}\n`);
  assert.equal(code(() => store.journal()), "tampered", "the chain of the first two entries is intact, but two are gone");
  writeFileSync(path, whole);
  assert.equal(store.journal().length, 4);
  // A crash between the append and the head update leaves the head one behind: that is not tampering.
  const entry = store.record("step", "k5", { n: "5" }, "2026-10-01T00:00:00Z");
  writeFileSync(join(store.dir, "journal.head"), JSON.stringify({ seq: 4, hash: store.journal()[3].hash }));
  assert.equal(store.journal().length, 5);
  store.record("step", "k6", { n: "6" }, "2026-10-01T00:00:00Z");
  assert.equal(store.head()?.seq, 6);
  assert.ok(entry.seq === 5);
  // Removing the head as well does not hide it.
  unlinkSync(join(store.dir, "journal.head"));
  assert.equal(code(() => store.journal()), "tampered");
});

test("a record is written whole or not at all, and a damaged file under a record's name is put right", () => {
  const store = fresh();
  const value = { conversations: 12, note: "x".repeat(2000) };
  const id = store.put("baseline", value);
  const dir = join(store.dir, "objects", "baseline");
  assert.deepEqual(readdirSync(dir), [`${id}.json`], "no temporary file is left behind");
  // What a crash between creating and writing the file used to leave: an empty file under the record's name.
  writeFileSync(join(dir, `${id}.json`), "");
  assert.equal(code(() => store.get("baseline", id)), "tampered");
  assert.equal(store.put("baseline", value), id, "storing the record again repairs it instead of refusing");
  assert.deepEqual(store.get("baseline", id), value);
  // A file that is not named by its content is still never replaced.
  const plain = join(store.dir, "note.txt");
  writeOnce(plain, "first");
  assert.equal(code(() => writeOnce(plain, "second")), "conflict");
});

test("names that reach an object's prototype are found anywhere in a parsed file", () => {
  assert.equal(unsafeKey(JSON.parse('{"a": [{"b": {"__proto__": {"x": 1}}}]}')), "__proto__");
  assert.equal(unsafeKey(JSON.parse('{"constructor": 1}')), "constructor");
  assert.equal(unsafeKey(JSON.parse('{"a": {"prototype": null}}')), "prototype");
  assert.equal(unsafeKey(JSON.parse('{"a": [1, "__proto__", {"proto": 2}]}')), null, "only keys count, not values");
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
  const dir = tmp("pilot-io-");
  writeFileSync(join(dir, "big.json"), "x".repeat(2000));
  assert.equal(code(() => readBounded(join(dir, "big.json"), 1000)), "too_large");
  assert.equal(code(() => readBounded(join(dir, "missing.json"))), "not_found");
  assert.equal(code(() => readBounded(dir)), "not_found");
  assert.equal(inside(dir, "rows.csv"), join(dir, "rows.csv"));
  for (const name of ["../secrets.csv", "/etc/passwd", "a/../../b.csv", ""]) assert.equal(code(() => inside(dir, name)), "usage", name);
});
