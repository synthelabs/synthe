import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { guideSource, PIN_FILES, pinProblems, setPins } from "../scripts/version-pins.mjs";

const { version, scripts } = JSON.parse(readFileSync("package.json", "utf8"));

// 1.8.x shipped while the guide still installed 1.7.5.
test("every setup pin in the repo names this package's version", () => {
  const files = Object.fromEntries([...PIN_FILES, "src/cli/guide.ts"].map((file) => [file, readFileSync(file, "utf8")]));
  assert.deepEqual(pinProblems(version, files), []);
  assert.ok(Object.values(files).some((text) => text.includes(`github:synthelabs/synthe#v${version}`)), "no pin found at all");
});

// templates/synthe-solve.yml ships to every team. An unpinned `npx --yes synthe` runs whatever npm has that day,
// which may be a version with another problem file format than the one the team's file was written for.
test("templates/synthe-solve.yml runs the synthe version in package.json", () => {
  const text = readFileSync("templates/synthe-solve.yml", "utf8");
  const runs = text.split("\n").filter((l) => /\bnpx\b.*\bsynthe\b/.test(l));
  assert.ok(runs.length >= 1, "no npx synthe line found");
  for (const line of runs) assert.match(line, new RegExp(`\\bnpx --yes synthe@${version.replace(/\./g, "\\.")} `), line.trim());
  assert.ok(PIN_FILES.includes("templates/synthe-solve.yml"), "npm version must move the template pin too");
});

// 1.8.7 shipped with `npm version` committing only package.json and the lock file: the version hook rewrote
// the pins and rebuilt dist/, but nothing it changed was staged, so the tag carried a stale bundle.
// npm includes whatever the version script git-adds in the version commit, so the script must stage every
// file version-pins.mjs writes, plus dist/, after it runs.
test("the version script pins, rebuilds, then stages every file it writes and dist", () => {
  const written = [...PIN_FILES, "src/cli/guide.ts"];   // PIN_FILES holds templates/synthe-solve.yml
  const [pin, build, add, ...extra] = scripts.version.split(" && ");
  assert.equal(pin, "node scripts/version-pins.mjs");
  assert.equal(build, "npm run build");
  assert.deepEqual(add.split(" "), ["git", "add", ...written, "dist"]);
  assert.deepEqual(extra, []);
});

test("setPins and pinProblems also cover the npm pin synthe@X.Y.Z", () => {
  assert.equal(setPins("run: npx --yes synthe@1.7.5 solve synthe.problem.json", "1.8.2"), "run: npx --yes synthe@1.8.2 solve synthe.problem.json");
  assert.deepEqual(pinProblems("1.8.2", { "t.yml": "npx --yes synthe@1.7.5 solve", "u.yml": "npx --yes synthe@1.8.2 solve" }), ["t.yml: v1.7.5"]);
  assert.equal(setPins("uses: synthelabs/synthe@v1 and my-synthe@1.0.0", "1.8.2"), "uses: synthelabs/synthe@v1 and my-synthe@1.0.0");
});

test("setPins moves every pin and nothing else", () => {
  const text = "run `npx --yes github:synthelabs/synthe#v1.7.5 init`, then github:synthelabs/synthe#v1.7.5 upgrade; uses: synthelabs/synthe@v1";
  assert.equal(setPins(text, "1.8.2"), "run `npx --yes github:synthelabs/synthe#v1.8.2 init`, then github:synthelabs/synthe#v1.8.2 upgrade; uses: synthelabs/synthe@v1");
});

test("pinProblems names each stale pin and its file", () => {
  assert.deepEqual(pinProblems("1.8.2", { "a.md": "github:synthelabs/synthe#v1.8.2", "b.md": "github:synthelabs/synthe#v1.7.5 x github:synthelabs/synthe#v1.8.1" }),
    ["b.md: v1.7.5", "b.md: v1.8.1"]);
});

test("guideSource keeps the header comment and swaps only the string", () => {
  const current = "// header\n// more\nexport const guide = \"old\";\n";
  assert.equal(guideSource(current, "# New \"doc\"\n"), "// header\n// more\nexport const guide = \"# New \\\"doc\\\"\\n\";\n");
  assert.throws(() => guideSource("// nothing here\n", "x"), /no `export const guide = ` line/);
});
