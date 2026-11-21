import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firstMatch, globProblem, listMatching, matchAny, matchesAny, matchGlob, normalizePath } from "../src/solve/glob.ts";

test("* stays inside one segment", () => {
  assert.equal(matchGlob("*.py", "a.py"), true);
  assert.equal(matchGlob("*.py", "src/a.py"), false);
  assert.equal(matchGlob("src/*.py", "src/a.py"), true);
  assert.equal(matchGlob("src/*.py", "src/x/a.py"), false);
});

test("** matches zero or more whole segments", () => {
  assert.equal(matchGlob("src/**/*.py", "src/a.py"), true);
  assert.equal(matchGlob("src/**/*.py", "src/x/y/a.py"), true);
  assert.equal(matchGlob("**/*.py", "a.py"), true);
  assert.equal(matchGlob("**/*.py", "deep/a.py"), true);
  assert.equal(matchGlob("measure/**", "measure/score.py"), true);
  assert.equal(matchGlob("measure/**", "measure/a/b.py"), true);
  assert.equal(matchGlob("measure/**", "measurement/x.py"), false);
  assert.equal(matchGlob("**", "any/thing.txt"), true);
  // "**" inside a segment is just two stars: it must not cross a slash.
  assert.equal(matchGlob("src/a**.ts", "src/a/b.ts"), false);
  assert.equal(matchGlob("src/a**.ts", "src/abc.ts"), true);
});

test("an exact path matches only itself, and dots are literal", () => {
  assert.equal(matchGlob("config.json", "config.json"), true);
  assert.equal(matchGlob("config.json", "configXjson"), false);
  assert.equal(matchGlob("config.json", "sub/config.json"), false);
});

test("? [] and {} work", () => {
  assert.equal(matchGlob("a?.txt", "ab.txt"), true);
  assert.equal(matchGlob("a?.txt", "a/.txt"), false);
  assert.equal(matchGlob("[abc].md", "b.md"), true);
  assert.equal(matchGlob("[!abc].md", "b.md"), false);
  assert.equal(matchGlob("[a-z].md", "q.md"), true);
  assert.equal(matchGlob("*.{js,ts}", "x.ts"), true);
  assert.equal(matchGlob("*.{js,ts}", "x.py"), false);
  assert.equal(matchGlob("{src,lib}/**/*.{c,h}", "lib/x/y.h"), true);
  assert.equal(matchGlob("a{b,{c,d}}e", "ade"), true);
});

test("dot files match, and paths are normalized", () => {
  assert.equal(matchGlob("*", ".env.example"), true);
  assert.equal(matchGlob("./src/*.py", "src/a.py"), true);
  assert.equal(matchGlob("src/*.py", "./src/a.py"), true);
  assert.equal(matchGlob("src/*.py", "src\\a.py"), true);
  assert.equal(normalizePath("./a//b/"), "a/b");
});

test("regex characters in a glob are literal", () => {
  assert.equal(matchGlob("a+b(1).txt", "a+b(1).txt"), true);
  assert.equal(matchGlob("a+b(1).txt", "aab1.txt"), false);
  assert.equal(matchGlob("$x^.txt", "$x^.txt"), true);
});

test("matchAny and firstMatch", () => {
  assert.equal(matchAny(["*.md", "src/**"], "src/a/b.py"), true);
  assert.equal(matchAny([], "x"), false);
  assert.equal(firstMatch(["*.md", "src/**"], "src/a.py"), "src/**");
  assert.equal(firstMatch(["*.md"], "src/a.py"), undefined);
});

test("globProblem names malformed globs", () => {
  assert.equal(globProblem("src/**/*.py"), null);
  assert.match(globProblem("")!, /empty/);
  assert.match(globProblem("/etc/passwd")!, /relative/);
  assert.match(globProblem("../x")!, /\.\./);
  assert.match(globProblem("a/../../x")!, /\.\./);
  assert.match(globProblem("[abc")!, /\[/);
  assert.match(globProblem("{a,b")!, /\{/);
  assert.match(globProblem("a}")!, /\}/);
  assert.throws(() => matchGlob("{a", "a"), /glob/);
});

test("listMatching walks the tree, skips .git and links, applies excludes", (t) => {
  const root = mkdtempSync(join(tmpdir(), "synthe-glob-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src/deep"), { recursive: true });
  mkdirSync(join(root, "measure"));
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, "src/a.py"), "");
  writeFileSync(join(root, "src/deep/b.py"), "");
  writeFileSync(join(root, "src/c.txt"), "");
  writeFileSync(join(root, "measure/score.py"), "");
  writeFileSync(join(root, ".git/config.py"), "");
  writeFileSync(join(root, "config.json"), "");
  symlinkSync(join(root, "measure/score.py"), join(root, "src/link.py"));
  assert.deepEqual(listMatching(root, ["**/*.py", "config.json"], ["measure/**"]), ["config.json", "src/a.py", "src/deep/b.py"]);
  assert.deepEqual(listMatching(root, ["src/**"], ["src/deep/**"]), ["src/a.py", "src/c.txt"]);
  assert.deepEqual(listMatching(join(root, "missing"), ["**"]), []);
});

test("matchesAny takes the path first, as the other modules call it", () => {
  assert.equal(matchesAny("src/a.py", ["src/**"]), true);
  assert.equal(matchesAny("bench/a.ts", ["src/**"]), false);
});
