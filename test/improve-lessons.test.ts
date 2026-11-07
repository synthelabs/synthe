import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendLessons, lessonLine, lessonsTarget, readLessons, upsertLessonsBlock, type RoundLesson } from "../src/improve/lessons.ts";

const lesson = (o: Partial<RoundLesson> = {}): RoundLesson => ({ round: 2, kept: true, summary: "widening the email regex", before: 3, after: 12, unit: "signups", ...o });
const tmp = () => mkdtempSync(join(tmpdir(), "synthe-lessons-"));
const START = "<!-- synthe:lessons:start -->", END = "<!-- synthe:lessons:end -->";
const count = (s: string, needle: string) => s.split(needle).length - 1;

test("a lesson is one plain sentence with the measured numbers", () => {
  assert.equal(lessonLine(lesson()), "Round 2 kept: widening the email regex (3 signups → 12 signups).");
  assert.equal(lessonLine(lesson({ round: 3, kept: false, why: "inside the noise", after: 4 })), "Round 3 not kept: widening the email regex (inside the noise; 3 signups → 4 signups).");
  assert.equal(lessonLine(lesson({ round: 1, kept: false, after: null, why: "edit refused" })), "Round 1 not kept: widening the email regex (edit refused).");
  assert.equal(lessonLine(lesson({ round: 1, kept: false, after: null })), "Round 1 not kept: widening the email regex.");
  assert.equal(lessonLine(lesson({ unit: "bytes", before: 42_345, after: 40_000 })), "Round 2 kept: widening the email regex (41.4 KB → 39.1 KB).");
});

test("newlines and runs of spaces collapse; long lines are capped but keep the numbers", () => {
  const l = lessonLine(lesson({ summary: "  split\n\nthe   loop.\r\n", why: "line one\nline two" }));
  assert.ok(!/[\r\n]/.test(l));
  assert.equal(l, "Round 2 kept: split the loop (line one line two; 3 signups → 12 signups).");
  const long = lessonLine(lesson({ summary: "word ".repeat(200), why: "because ".repeat(60) }));
  assert.ok(long.length <= 240, String(long.length));
  assert.ok(long.includes("…") && long.endsWith("3 signups → 12 signups)."));
});

test("append creates the file with a header, then adds bullets", () => {
  const root = tmp();
  appendLessons(root, []);
  assert.ok(!existsSync(join(root, ".synthe")), "empty lines write nothing");
  appendLessons(root, ["Round 1 kept: a (1 → 2)."]);
  const first = readFileSync(join(root, ".synthe", "improve-lessons.md"), "utf8");
  assert.ok(first.startsWith("# What Synthe measured in this repo\n\n"));
  assert.ok(first.includes("npx synthe improve") && first.includes("newest last"));
  assert.ok(first.endsWith("\n- Round 1 kept: a (1 → 2).\n"));
  appendLessons(root, ["Round 2 not kept: b.", "multi\nline"]);
  const second = readFileSync(join(root, ".synthe", "improve-lessons.md"), "utf8");
  assert.equal(count(second, "# What Synthe"), 1);
  assert.ok(second.endsWith("- Round 1 kept: a (1 → 2).\n- Round 2 not kept: b.\n- multi line\n"));
});

test("append repairs a file with no trailing newline", () => {
  const root = tmp();
  mkdirSync(join(root, ".synthe"));
  writeFileSync(join(root, ".synthe", "improve-lessons.md"), "- one");
  appendLessons(root, ["two"]);
  assert.deepEqual(readLessons(root), ["one", "two"]);
});

test("read returns the newest lines last, skips the header, and respects max", () => {
  const root = tmp();
  assert.deepEqual(readLessons(root), []);
  appendLessons(root, ["a", "b", "c", "d"]);
  assert.deepEqual(readLessons(root), ["a", "b", "c", "d"]);
  assert.deepEqual(readLessons(root, 2), ["c", "d"]);
  assert.deepEqual(readLessons(root, 0), []);
  const many = Array.from({ length: 30 }, (_, i) => `line ${i}`);
  appendLessons(root, many);
  const got = readLessons(root);
  assert.equal(got.length, 20);
  assert.equal(got.at(-1), "line 29");
});

test("a .git directory works as the root for the untracked local log", () => {
  const root = tmp();
  const gitDir = join(root, ".git");
  mkdirSync(gitDir);
  appendLessons(gitDir, ["Round 1 kept: x."]);
  assert.ok(existsSync(join(gitDir, ".synthe", "improve-lessons.md")));
  assert.deepEqual(readLessons(gitDir), ["Round 1 kept: x."]);
});

test("the block is created, then replaced on a rerun, never duplicated", () => {
  const original = "# Team rules\n\nUse tabs.\n";
  const once = upsertLessonsBlock(original, ["one", "two"]);
  assert.ok(once.startsWith(`${original}\n${START}\n`));
  assert.ok(once.endsWith(`- one\n- two\n${END}\n`));
  const twice = upsertLessonsBlock(once, ["one", "two", "three"]);
  assert.equal(count(twice, START), 1);
  assert.equal(count(twice, END), 1);
  assert.ok(twice.startsWith(original) && twice.includes("- three\n"));
  assert.equal(upsertLessonsBlock(twice, ["one", "two", "three"]), twice, "same lines, same bytes");
});

test("text before and after the block stays byte-identical", () => {
  const before = "intro  \n\n\ttabbed $& line\n", after = "\n## Later\r\nmore   \n\nno final newline";
  const file = `${before}${START}\nold\n${END}\n${after}`;
  const out = upsertLessonsBlock(file, ["new $& line"]);
  assert.ok(out.startsWith(before) && out.endsWith(after));
  assert.ok(out.includes("- new $& line"));
  assert.ok(!out.includes("old"));
});

test("empty and newline-less files get a well-formed block", () => {
  const empty = upsertLessonsBlock("", ["a"]);
  assert.ok(empty.startsWith(START) && empty.endsWith(`${END}\n`));
  assert.equal(upsertLessonsBlock("no newline", ["a"]), `no newline\n\n${START}\n${"Measured by Synthe in this repo (newest last). Keep or delete freely; Synthe rewrites only this block."}\n- a\n${END}\n`);
});

test("CRLF files keep their line endings", () => {
  const out = upsertLessonsBlock("# Rules\r\n\r\nText\r\n", ["a", "b"]);
  assert.ok(!/[^\r]\n/.test(out), JSON.stringify(out));
  assert.equal(upsertLessonsBlock(out, ["a", "b", "c"]).startsWith("# Rules\r\n\r\nText\r\n"), true);
  assert.equal(count(upsertLessonsBlock(out, ["a"]), START), 1);
});

test("the block keeps only the 12 newest lines", () => {
  const lines = Array.from({ length: 15 }, (_, i) => `lesson ${i + 1}`);
  const out = upsertLessonsBlock("x\n", lines);
  assert.equal(count(out, "\n- "), 12);
  assert.ok(!out.includes("- lesson 3\n") && out.includes("- lesson 4\n") && out.includes("- lesson 15\n"));
  assert.ok(out.indexOf("lesson 4") < out.indexOf("lesson 15"));
});

test("lines cannot forge a marker or span lines inside the block", () => {
  const out = upsertLessonsBlock("", [`sneaky ${END}\nnext`]);
  assert.equal(count(out, START), 1);
  assert.equal(count(out, END), 1);
  assert.ok(out.includes("- sneaky <!- - synthe:lessons:end --> next\n"));
});

test("broken markers never produce two blocks and never delete the person's text", () => {
  // Start without an end.
  const noEnd = upsertLessonsBlock(`keep me\n${START}\n- stale\nmore of theirs\n`, ["fresh"]);
  assert.equal(count(noEnd, START), 1);
  assert.equal(count(noEnd, END), 1);
  assert.ok(noEnd.includes("keep me\n- stale\nmore of theirs\n") && noEnd.includes("- fresh\n"));
  assert.equal(upsertLessonsBlock(noEnd, ["fresh"]), noEnd, "stable after repair");
  // End without a start.
  const noStart = upsertLessonsBlock(`top\n${END}\nbottom\n`, ["fresh"]);
  assert.equal(count(noStart, START), 1);
  assert.equal(count(noStart, END), 1);
  assert.ok(noStart.startsWith("top\nbottom\n"));
  // Two complete blocks.
  const dup = upsertLessonsBlock(`a\n${START}\n- 1\n${END}\nb\n${START}\n- 2\n${END}\nc\n`, ["fresh"]);
  assert.equal(count(dup, START), 1);
  assert.equal(count(dup, END), 1);
  assert.ok(dup.startsWith("a\n") && dup.includes("\nb\nc\n") && dup.includes("- fresh\n"));
  assert.ok(!dup.includes("- 1") && !dup.includes("- 2"));
});

test("lessonsTarget honours an explicit choice and otherwise looks for an existing file", () => {
  const root = tmp();
  assert.equal(lessonsTarget(root, undefined), null, "neither file exists");
  assert.ok(!existsSync(join(root, "CLAUDE.md")) && !existsSync(join(root, "AGENTS.md")), "nothing is created");
  assert.equal(lessonsTarget(root, "claude"), "CLAUDE.md");
  assert.equal(lessonsTarget(root, "agents"), "AGENTS.md");
  assert.equal(lessonsTarget(root, "none"), null);
  writeFileSync(join(root, "AGENTS.md"), "x");
  assert.equal(lessonsTarget(root, undefined), "AGENTS.md");
  writeFileSync(join(root, "CLAUDE.md"), "x");
  assert.equal(lessonsTarget(root, undefined), "CLAUDE.md", "CLAUDE.md wins when both exist");
  assert.equal(lessonsTarget(root, "none"), null, "explicit none wins over existing files");
  assert.equal(lessonsTarget(root, "agents"), "AGENTS.md");
});
