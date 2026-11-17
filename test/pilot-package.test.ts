import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tmp } from "./pilot-cli-helpers.ts";

// The package entry `synthe/pilot` is the customer's recorder. These tests build it into a temporary folder: a test
// must never write into dist/, because test/e2e.test.ts rebuilds dist while other test files run.
const ROOT = new URL("..", import.meta.url).pathname;
const WRAP_FILES = ["wrap.mjs", "wrap.cjs", "wrap.d.ts", "wrap.d.cts"];
const EXPORTS = ["pilotRecorder", "pickVersion", "pickArm", "bucket", "ASSIGN_RULE"];

function build(): string {
  const out = join(tmp("pilot-package-"), "dist");
  execFileSync(process.execPath, [join(ROOT, "scripts/build-wrap.mjs"), out], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  return out;
}
const built = build();

test("the build writes the four wrap files and nothing else", () => {
  assert.deepEqual(readdirSync(built).sort(), [...WRAP_FILES].sort());
});

test("the build is deterministic: a second build gives the same bytes", () => {
  const again = build();
  for (const name of WRAP_FILES) assert.ok(readFileSync(join(built, name)).equals(readFileSync(join(again, name))), name);
});

test("package.json maps synthe/pilot to the wrap files and ships them", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.deepEqual(pkg.exports, {
    ".": "./dist/cli.js",
    "./pilot": { import: { types: "./dist/wrap.d.ts", default: "./dist/wrap.mjs" }, require: { types: "./dist/wrap.d.cts", default: "./dist/wrap.cjs" } },
    "./package.json": "./package.json",
  });
  for (const name of WRAP_FILES) assert.ok(pkg.files.includes(`dist/${name}`), name);
  assert.match(pkg.scripts.build, / && node scripts\/build-wrap\.mjs$/);
});

// A customer's project: node_modules/synthe holds package.json and the built files, as an install would.
function customer(): string {
  const root = tmp("pilot-customer-");
  const pkgDir = join(root, "node_modules", "synthe");
  mkdirSync(join(pkgDir, "dist"), { recursive: true });
  copyFileSync(join(ROOT, "package.json"), join(pkgDir, "package.json"));
  for (const name of WRAP_FILES) copyFileSync(join(built, name), join(pkgDir, "dist", name));
  return root;
}

test("import('synthe/pilot') returns the recorder and the split rule", () => {
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", `const m = await import("synthe/pilot"); console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(EXPORTS)}.map((k) => [k, typeof m[k]]))), m.ASSIGN_RULE, m.pickVersion({ key: "k", salt: "s", baseline: "b", candidate: "c", candidateShareBp: 5000 }) !== undefined);`], { cwd: customer(), encoding: "utf8" });
  const [types, rule, ok] = out.trim().split("\n")[0].split(" ");
  assert.deepEqual(JSON.parse(types), { pilotRecorder: "function", pickVersion: "function", pickArm: "function", bucket: "function", ASSIGN_RULE: "string" });
  assert.deepEqual([rule, ok], ["sha256-v1", "true"]);
});

test("require('synthe/pilot') returns the same names", () => {
  const out = execFileSync(process.execPath, ["-e", `const m = require("synthe/pilot"); console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(EXPORTS)}.map((k) => [k, typeof m[k]]))), m.ASSIGN_RULE);`], { cwd: customer(), encoding: "utf8" });
  const [types, rule] = out.trim().split(" ");
  assert.deepEqual(JSON.parse(types), { pilotRecorder: "function", pickVersion: "function", pickArm: "function", bucket: "function", ASSIGN_RULE: "string" });
  assert.equal(rule, "sha256-v1");
});

test("the bundled recorder imports only Node built-ins, and the types name the recorder", () => {
  for (const name of ["wrap.mjs", "wrap.cjs"]) {
    const text = readFileSync(join(built, name), "utf8");
    const specs = [...text.matchAll(/(?:\bimport\s*(?:[^"'()]*?\bfrom\s*)?|\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)["']([^"']+)["']/g)].map((m) => m[1]);
    assert.ok(specs.length > 0, `${name}: the check finds the built-in imports`);
    assert.ok(specs.every((s) => s.startsWith("node:")), `${name}: ${specs.join(", ")}`);
  }
  const types = readFileSync(join(built, "wrap.d.ts"), "utf8");
  assert.match(types, /export declare function pilotRecorder/);
  assert.match(types, /export declare function pickVersion/);
  assert.equal(readFileSync(join(built, "wrap.d.cts"), "utf8"), types);
});
