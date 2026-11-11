import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = join(import.meta.dirname, "..");
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

test("the pilot bundles into one runnable file, the same bytes every time, without touching dist/", () => {
  const dir = mkdtempSync(join(tmpdir(), "pilot-build-"));
  const one = join(dir, "a", "synthe-pilot.mjs");
  const two = join(dir, "b", "nested", "synthe-pilot.mjs");
  const distBefore = execFileSync("git", ["status", "--porcelain", "--", "dist"], { cwd: ROOT, encoding: "utf8" });
  for (const out of [one, two]) execFileSync(process.execPath, [join(ROOT, "scripts", "pilot-build.mjs"), "--outfile", out], { cwd: dir, encoding: "utf8" });
  assert.equal(sha(one), sha(two), "the build does not depend on where it is written or run from");
  assert.equal(execFileSync("git", ["status", "--porcelain", "--", "dist"], { cwd: ROOT, encoding: "utf8" }), distBefore, "the committed bundles are untouched");

  const env = { PATH: process.env.PATH ?? "" };
  const help = spawnSync(process.execPath, [one, "help"], { encoding: "utf8", env });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /keep \/ hold \/ revert/);
  // The bundle is the same program: it runs the synthetic pilot to the same outcomes.
  const demo = spawnSync(process.execPath, [one, "demo", "--out", join(dir, "run")], { encoding: "utf8", env });
  assert.equal(demo.status, 0, demo.stdout.split("\n").filter((l) => l.includes("FAIL")).join("\n") + demo.stderr);
  assert.match(demo.stdout, /every expectation held/);
});
