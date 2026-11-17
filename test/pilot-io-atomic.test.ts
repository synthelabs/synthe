// From a suspicion in the privacy review of 2026-11-17, reproduced: writeAtomic wrote through `<path>.<pid>.tmp` with
// writeFileSync, which follows a symbolic link, so a link planted under that name in a shared output folder sent the
// content (an export with customer ids) to the link's target. The test plants the link for its own pid, which is
// the best case for whoever plants it.
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PilotError } from "../src/pilot/errors.ts";
import { writeAtomic } from "../src/pilot/io.ts";

test("writeAtomic does not write through a link planted under its temporary name", () => {
  const out = mkdtempSync(join(tmpdir(), "atomic-out-"));
  const elsewhere = join(mkdtempSync(join(tmpdir(), "atomic-victim-")), "victim.txt");
  writeFileSync(elsewhere, "ORIGINAL\n");
  const target = join(out, "export.csv");
  symlinkSync(elsewhere, `${target}.${process.pid}.tmp`);
  assert.throws(() => writeAtomic(target, "conversation_id,prompt_version\nCUSTOMER-ROW,v1\n"), (e: unknown) => e instanceof PilotError && e.code === "conflict" && !e.message.includes("CUSTOMER-ROW"));
  assert.equal(readFileSync(elsewhere, "utf8"), "ORIGINAL\n", "the content was not written into the link's target");
  assert.equal(existsSync(target), false, "nothing was put in place");
  // What it did not create it does not remove.
  assert.ok(lstatSync(`${target}.${process.pid}.tmp`).isSymbolicLink());
});

test("writeAtomic still writes, replaces an existing file and leaves no temporary file", () => {
  const out = mkdtempSync(join(tmpdir(), "atomic-out-"));
  const target = join(out, "deep", "report.md");
  writeAtomic(target, "one\n");
  writeAtomic(target, "two\n");
  assert.equal(readFileSync(target, "utf8"), "two\n");
  assert.deepEqual(readdirSync(join(out, "deep")), ["report.md"]);
  assert.equal(statSync(target).mode & 0o777, 0o600);
});
