// Stage 4j (swarm/GOAL-3.md): problem init protects **/node_modules/** and every file that the root jest, vitest or
// mocha configuration, or package.json, names to load before or around the tests.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { pathProblem } from "../src/solve/edits.ts";
import { draftProblem, inspectRepo } from "../src/solve/init.ts";

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "synthe-init-setup-"));
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

const protectOf = (dir: string) => draftProblem(inspectRepo(dir)).protect as string[];
const refused = (dir: string, path: string) => {
  const d = draftProblem(inspectRepo(dir));
  return pathProblem(path, { artifact: d.artifact as string[], protect: d.protect as string[], measurePaths: [] });
};
const pkg = (test: string, extra: Record<string, unknown> = {}) => JSON.stringify({ name: "app", main: "src/lib.js", scripts: { test }, ...extra });
const src = { "src/lib.js": "exports.add = (a, b) => a + b;\n", "src/lib.test.js": "test('a', () => {});\n" };

test("problem init protects **/node_modules/**, so a shadow package under src/ is refused", () => {
  const dir = repo({ "package.json": pkg("mocha"), ...src });
  assert.ok(protectOf(dir).includes("**/node_modules/**"));
  assert.match(refused(dir, "src/node_modules/chai/index.js") ?? "", /^src\/node_modules\/chai\/index\.js /, "refused, and the reason names the path");
  assert.equal(refused(dir, "src/lib.js"), null, "the source stays editable");
});

test("vitest: the setupFiles and globalSetup that the root configuration names are protected", () => {
  const dir = repo({
    "package.json": pkg("vitest run"),
    "vitest.config.js": "export default { test: { setupFiles: ['./src/setup.js'], globalSetup: \"src/global.ts\", environment: 'node' } };\n",
    "src/setup.js": "", "src/global.ts": "", ...src,
  });
  const protect = protectOf(dir);
  for (const p of ["src/setup.js", "src/global.ts"]) assert.ok(protect.includes(p), p);
  assert.ok(refused(dir, "src/setup.js"));
  assert.equal(refused(dir, "src/lib.js"), null);
});

test("jest: setup files in jest.config.js and in the package.json jest key are protected, with <rootDir> and no extension", () => {
  const conf = repo({
    "package.json": pkg("jest"),
    "jest.config.js": "module.exports = {\n  setupFiles: ['<rootDir>/src/env.js'],\n  setupFilesAfterEnv: ['./src/after'],\n  globalSetup: './src/gs.js',\n  globalTeardown: './src/gt.js',\n  testEnvironment: './src/env-custom.js',\n};\n",
    "src/env.js": "", "src/after.ts": "", "src/gs.js": "", "src/gt.js": "", "src/env-custom.js": "", ...src,
  });
  const protect = protectOf(conf);
  for (const p of ["src/env.js", "src/after.ts", "src/gs.js", "src/gt.js", "src/env-custom.js"]) assert.ok(protect.includes(p), p);
  const inPkg = repo({ "package.json": pkg("jest", { jest: { setupFilesAfterEnv: ["<rootDir>/src/after.js"], testEnvironment: "node" } }), "src/after.js": "", ...src });
  assert.ok(protectOf(inPkg).includes("src/after.js"));
  assert.ok(!protectOf(inPkg).includes("src/lib.js"), "package.json main names the code, not a setup file");
});

test("mocha: require and file in .mocharc.yml, .mocharc.json and the package.json mocha key are protected", () => {
  const yml = repo({ "package.json": pkg("mocha"), ".mocharc.yml": "require:\n  - ./src/hooks.js\n  - ts-node/register\nfile: src/root.js\nui: bdd\n", "src/hooks.js": "", "src/root.js": "", ...src });
  for (const p of ["src/hooks.js", "src/root.js"]) assert.ok(protectOf(yml).includes(p), p);
  const json = repo({ "package.json": pkg("mocha"), ".mocharc.json": JSON.stringify({ require: "./src/hooks.cjs", file: ["./src/root.cjs"] }), "src/hooks.cjs": "", "src/root.cjs": "", ...src });
  for (const p of ["src/hooks.cjs", "src/root.cjs"]) assert.ok(protectOf(json).includes(p), p);
  const inPkg = repo({ "package.json": pkg("mocha", { mocha: { require: ["./src/hooks.mjs"] } }), "src/hooks.mjs": "", ...src });
  assert.ok(protectOf(inPkg).includes("src/hooks.mjs"));
});

test("a setup file that the configuration names but that does not exist yet is protected, so no proposal can create it", () => {
  const dir = repo({ "package.json": pkg("vitest run"), "vitest.config.mjs": "export default { test: { setupFiles: ['./src/setup.js'] } };\n", ...src });
  assert.ok(refused(dir, "src/setup.js"));
});
