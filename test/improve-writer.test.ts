import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Ask, Model } from "../src/model/client.ts";
import {
  candidateFiles, changedLines, checkEdits, EDIT_MODEL, MAX_CONTEXT_CHARS, MAX_LISTED_FILES, PICK_MODEL, pickFiles, proposeEdits, shownFiles, type WriterContext,
} from "../src/improve/writer.ts";
import { config } from "./improve-helpers.ts";

function tree(files: Record<string, string | Buffer>) {
  const dir = mkdtempSync(join(tmpdir(), "synthe-writer-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const cfg = config({ guard: { command: "npm test" }, protect: ["data/"] });
const replying = (value: unknown, costUsd: number | null = 0.01) => {
  const asks: Ask[] = [];
  const model: Model = { async ask(a) { asks.push(a); return { text: typeof value === "string" ? value : JSON.stringify(value), costUsd }; } };
  return { model, asks };
};
const ctx = (over: Partial<WriterContext> = {}): WriterContext => ({ config: cfg, best: 3, tried: [], lessons: [], ...over });

test("candidateFiles lists only tracked product code: no tests, metric, config, generated, binary, linked, huge or agent-notes files", () => {
  const dir = tree({
    "src/validate.js": "x", "README.md": "# r", "index.html": "<p>", "deep/a/b/c.ts": "y",
    "test/validate.test.js": "t", "metrics/score.js": "m", "package.json": "{}", "vite.config.ts": "c", ".env": "S=1",
    "dist/app.js": "built", "logo.png": Buffer.from([0x89, 0x50]), "CLAUDE.md": "notes", "data/seed.json": "[]", "big.js": "x".repeat(60_000),
  });
  symlinkSync("/etc/hosts", join(dir, "hosts.js"));
  const tracked = ["README.md", "big.js", "CLAUDE.md", "data/seed.json", "deep/a/b/c.ts", "dist/app.js", "hosts.js", "index.html", "logo.png", "metrics/score.js", "package.json", "src/validate.js", "test/validate.test.js", "vite.config.ts", ".env", "gone.js"];
  const { files, more } = candidateFiles(dir, tracked, cfg);
  assert.deepEqual(files.map((f) => f.path), ["index.html", "src/validate.js", "deep/a/b/c.ts", "README.md"]);
  assert.deepEqual(files.find((f) => f.path === "src/validate.js"), { path: "src/validate.js", bytes: 1 });
  assert.equal(more, 0);
  const many = tree(Object.fromEntries(Array.from({ length: MAX_LISTED_FILES + 5 }, (_, i) => [`f${i}.js`, "x"])));
  const capped = candidateFiles(many, Array.from({ length: MAX_LISTED_FILES + 5 }, (_, i) => `f${i}.js`), cfg);
  assert.equal(capped.files.length, MAX_LISTED_FILES);
  assert.equal(capped.more, 5);
});

test("pickFiles tells the model the goal, the number, earlier rounds and lessons, and keeps only listed paths, at most 5", async () => {
  const { model, asks } = replying({ paths: ["./src/a.js", "src/a.js", "test/a.test.js", "package.json", "nope.js", "src/b.js", "src/c.js", "src/d.js", "src/e.js", "src/f.js"], why: "w" });
  const files = ["src/a.js", "src/b.js", "src/c.js", "src/d.js", "src/e.js", "src/f.js"].map((path) => ({ path, bytes: 10 }));
  const tried = [{ round: 1, summary: "accept anything with an @", kept: false, value: 12, why: "the regression check did not pass" }];
  const r = await pickFiles(model, ctx({ tried, lessons: ["Round 2 kept: trim spaces (3 → 4)."] }), files, 7);
  assert.deepEqual(r.paths, ["src/a.js", "src/b.js", "src/c.js", "src/d.js", "src/e.js"]);
  assert.equal(r.costUsd, 0.01);
  const a = asks[0];
  assert.equal(a.model, PICK_MODEL);
  assert.ok(a.maxTokens <= 16000 && a.schema);
  for (const part of ["Goal: Make it better", "Metric: valid signups, printed by `node metrics/score.js`; higher is better. Current best: 3 valid signups.",
    "Regression check that must keep passing: `npm test`.", `Round 1: "accept anything with an @" -> 12 valid signups; not kept: the regression check did not pass`,
    "- Round 2 kept: trim spaces (3 → 4).", "src/a.js (10 bytes)", "(7 more files not listed)"]) assert.ok(a.user.includes(part), part);
  assert.deepEqual((await pickFiles(replying("not json").model, ctx(), files)).paths, []);
});

test("shownFiles removes secrets, drops binaries and stops at the context limit without cutting a file", () => {
  const dir = tree({ "a.js": "const key = 'sk-ant-api03-abcdefghijklmnop';\n", "b.bin": Buffer.from([1, 0, 2]), "c.js": "c".repeat(MAX_CONTEXT_CHARS - 10), "d.js": "d" });
  const shown = shownFiles(dir, ["a.js", "b.bin", "c.js", "d.js", "missing.js"]);
  assert.deepEqual(shown.map((f) => f.path), ["a.js", "d.js"]);
  assert.equal(shown[0].text, "const key = '[secret removed]';\n");
});

test("proposeEdits sends the files and the rules, and returns null for a reply that isn't the right shape", async () => {
  const { model, asks } = replying({ summary: "Accept dots.\n", edits: [{ path: "a.js", search: "x", replace: "y" }] });
  const r = await proposeEdits(model, ctx(), [{ path: "a.js", text: "x\n" }]);
  assert.deepEqual(r.proposal, { summary: "Accept dots", edits: [{ path: "a.js", search: "x", replace: "y" }] });
  const a = asks[0];
  assert.equal(a.model, EDIT_MODEL);
  assert.ok(a.maxTokens <= 16000);
  assert.ok(a.user.includes('<file path="a.js">\nx\n\n</file>'));
  for (const rule of ["Never game the metric", "You cannot edit tests, the metric command or its data", "must appear exactly once", "Learn from the earlier rounds"]) assert.ok(a.system!.includes(rule), rule);
  assert.equal((await proposeEdits(replying({ summary: "s" }).model, ctx(), [])).proposal, null);
  assert.equal((await proposeEdits(replying("{cut off").model, ctx(), [])).proposal, null);
});

const signup = () => tree({ "validate.js": "module.exports = (email) => /^[a-z]+@[a-z]+\\.com$/.test(email);\n", "lib/util.js": "export const a = 1;\nexport const b = 1;\n" });
const shown = new Set(["validate.js", "lib/util.js"]);
const problem = (dir: string, edits: unknown, c = cfg) => {
  const r = checkEdits(dir, edits, shown, c);
  return "problem" in r ? r.problem : null;
};

test("checkEdits applies exact, unique edits in order and can create a new product file", () => {
  const dir = signup();
  const r = checkEdits(dir, [
    { path: "validate.js", search: "[a-z]+\\.com", replace: "[^\\s@]+\\.[^\\s@]+" },
    { path: "validate.js", search: "/^[a-z]+@", replace: "/^[^\\s@]+@" },
    { path: "./src/normalize.js", search: "", replace: "module.exports = (s) => s.trim();\n" },
  ], shown, cfg);
  assert.ok("writes" in r);
  assert.deepEqual(r.writes, [
    { path: "validate.js", text: "module.exports = (email) => /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email);\n", created: false },
    { path: "src/normalize.js", text: "module.exports = (s) => s.trim();\n", created: true },
  ]);
  assert.equal(readFileSync(join(dir, "validate.js"), "utf8").includes("[a-z]"), true, "checking writes nothing");
  const crlf = tree({ "w.js": "a\r\nb\r\n" });
  const fixed = checkEdits(crlf, [{ path: "w.js", search: "a\nb", replace: "a\nc" }], new Set(["w.js"]), cfg);
  assert.ok("writes" in fixed && fixed.writes[0].text === "a\r\nc\r\n");
});

test("checkEdits refuses protected paths, ambiguous or missing search text, unseen files, escapes and oversized changes", () => {
  const dir = signup();
  const edit = (path: string, search = "x", replace = "y") => [{ path, search, replace }];
  assert.equal(problem(dir, edit("test/validate.test.js")), "test/validate.test.js is a test file; Synthe measures with the tests as they are.");
  assert.equal(problem(dir, edit("metrics/score.js")), "metrics/score.js is in a test, benchmark, metric or fixture folder; Synthe measures with those as they are.");
  assert.match(problem(dir, edit("package.json"))!, /^package\.json lists dependencies/);
  assert.equal(problem(dir, edit("data/seed.json", "", "[]")), "data/seed.json is protected for this run (--protect data/).");
  assert.match(problem(dir, edit("CLAUDE.md", "", "hi"))!, /notes for coding agents/);
  assert.match(problem(dir, edit("dist/app.js", "", "x"))!, /generated output/);
  assert.equal(problem(dir, edit("lib/util.js", "= 1;", "= 2;")), "the search text for lib/util.js appears 2 times; it must appear once");
  assert.equal(problem(dir, edit("validate.js", "nowhere")), "the search text for validate.js is not in the file");
  assert.equal(problem(dir, edit("validate.js", "", "new")), "the search text for validate.js is empty, but that file already exists");
  assert.equal(problem(dir, edit("ghost.js")), "ghost.js does not exist");
  assert.equal(problem(dir, edit("new.js", "", "  ")), "new.js would be created empty");
  for (const bad of ["../outside.js", "/etc/passwd", "a//b.js", "src\\x.js"]) assert.match(problem(dir, edit(bad, "", "x"))!, /is not a path inside the repo$/, bad);
  const unseen = tree({ "other.js": "x" });
  assert.deepEqual(checkEdits(unseen, edit("other.js"), new Set(), cfg), { problem: "other.js was not among the files shown, so it can't be edited" });
  assert.equal(problem(dir, []), "no edits");
  assert.equal(problem(dir, "nonsense"), "no edits");
  assert.equal(problem(dir, [{ path: "validate.js", search: 1, replace: "y" }]), "an edit is malformed");
  assert.equal(problem(dir, Array.from({ length: 9 }, () => ({ path: "validate.js", search: "email", replace: "email" }))), "9 edits; at most 8 are allowed");
  assert.equal(problem(dir, edit("validate.js", "test(email)", "test(email)")), "the edits change nothing");
  assert.equal(problem(dir, edit("big.js", "", Array.from({ length: 201 }, (_, i) => `line ${i}`).join("\n"))), "the change is about 201 lines; the limit is 200");
});

test("a new file can't be written through a linked folder that leads out of the checkout", () => {
  const dir = signup();
  const outside = mkdtempSync(join(tmpdir(), "synthe-outside-"));
  symlinkSync(outside, join(dir, "linked"));
  assert.equal(problem(dir, [{ path: "linked/evil.js", search: "", replace: "x" }]), "linked/evil.js is not a path inside the repo");
});

test("changedLines counts removed plus added lines, ignoring shared context at either end", () => {
  assert.equal(changedLines("a\nb\nc", "a\nB\nc"), 2);
  assert.equal(changedLines("a\nb", "a\nb\nc\nd"), 2);
  assert.equal(changedLines("", "x\ny"), 2);
  assert.equal(changedLines("same", "same"), 0);
});
