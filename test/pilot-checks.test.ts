import assert from "node:assert/strict";
import { test } from "node:test";
import { gradeChecks } from "../src/pilot/checks.ts";
import type { CaseCheck } from "../src/pilot/types.ts";

const ck = (rule: Record<string, unknown>, extra: Record<string, unknown> = {}): CaseCheck =>
  ({ id: "c", turn: 1, role: "primary", ...extra, ...rule }) as CaseCheck;
const grade = (rule: Record<string, unknown>, b: { reply?: string | null; tools_requested?: string[]; tools_before?: string[] }) =>
  gradeChecks([ck(rule)], { reply: null, tools_requested: [], tools_before: [], ...b })[0].pass;

test("reply_includes passes on any phrase, ignoring case", () => {
  assert.equal(grade({ kind: "reply_includes", any_of: ["label", "refund"] }, { reply: "A LABEL is coming." }), true);
  assert.equal(grade({ kind: "reply_includes", any_of: ["label", "refund"] }, { reply: "Nothing here." }), false);
  assert.equal(grade({ kind: "reply_includes", any_of: ["Label"] }, { reply: "a label" }), true);
});

test("reply_excludes passes only when no phrase is present", () => {
  assert.equal(grade({ kind: "reply_excludes", any_of: ["guaranteed refund", "free"] }, { reply: "That is Free." }), false);
  assert.equal(grade({ kind: "reply_excludes", any_of: ["guaranteed refund"] }, { reply: "We will look into it." }), true);
});

test("text checks are null when the turn did not finish", () => {
  assert.equal(grade({ kind: "reply_includes", any_of: ["x"] }, { reply: null }), null);
  assert.equal(grade({ kind: "reply_excludes", any_of: ["x"] }, { reply: null }), null);
});

test("calls_tool: decided when requested, null when unfinished and not yet requested", () => {
  assert.equal(grade({ kind: "calls_tool", tool: "lookup_order" }, { reply: "ok", tools_requested: ["lookup_order"] }), true);
  assert.equal(grade({ kind: "calls_tool", tool: "lookup_order" }, { reply: "ok", tools_requested: [] }), false);
  assert.equal(grade({ kind: "calls_tool", tool: "lookup_order" }, { reply: null, tools_requested: ["lookup_order"] }), true);
  assert.equal(grade({ kind: "calls_tool", tool: "lookup_order" }, { reply: null, tools_requested: ["start_return"] }), null);
});

test("avoids_tool: decided when requested, null when unfinished and not yet requested", () => {
  assert.equal(grade({ kind: "avoids_tool", tool: "start_return" }, { reply: "ok", tools_requested: ["lookup_order"] }), true);
  assert.equal(grade({ kind: "avoids_tool", tool: "start_return" }, { reply: "ok", tools_requested: ["start_return"] }), false);
  assert.equal(grade({ kind: "avoids_tool", tool: "start_return" }, { reply: null, tools_requested: ["start_return"] }), false);
  assert.equal(grade({ kind: "avoids_tool", tool: "start_return" }, { reply: null, tools_requested: [] }), null);
});

test("tool_requires: ordering inside the turn and earlier recorded turns", () => {
  const rule = { kind: "tool_requires", tool: "start_return", after: "check_return_eligibility" };
  assert.equal(grade(rule, { reply: "ok", tools_requested: ["check_return_eligibility", "start_return"] }), true);
  assert.equal(grade(rule, { reply: "ok", tools_requested: ["start_return", "check_return_eligibility"] }), false);
  assert.equal(grade(rule, { reply: "ok", tools_requested: ["start_return"] }), false);
  assert.equal(grade(rule, { reply: "ok", tools_requested: ["start_return"], tools_before: ["check_return_eligibility"] }), true);
  // A violation is decided even though the turn never finished.
  assert.equal(grade(rule, { reply: null, tools_requested: ["start_return"] }), false);
});

test("tool_requires: not requested passes when finished, null when unfinished", () => {
  const rule = { kind: "tool_requires", tool: "start_return", after: "check_return_eligibility" };
  assert.equal(grade(rule, { reply: "ok", tools_requested: [] }), true);
  assert.equal(grade(rule, { reply: null, tools_requested: [] }), null);
});

test("tool_requires: every request of the tool needs the prerequisite before it", () => {
  const rule = { kind: "tool_requires", tool: "start_return", after: "check_return_eligibility" };
  assert.equal(grade(rule, { reply: "ok", tools_requested: ["check_return_eligibility", "start_return", "start_return"] }), true);
  // Requested but unfinished and nothing wrong yet: a later request could still break the rule.
  assert.equal(grade(rule, { reply: null, tools_requested: ["check_return_eligibility", "start_return"] }), null);
});

test("results keep order, role and blocking", () => {
  const out = gradeChecks(
    [ck({ kind: "calls_tool", tool: "a" }, { id: "p" }), ck({ kind: "avoids_tool", tool: "b" }, { id: "g", role: "guard", blocking: true }), ck({ kind: "avoids_tool", tool: "b" }, { id: "h", role: "guard" })],
    { reply: "x", tools_requested: ["a"], tools_before: [] },
  );
  assert.deepEqual(out, [
    { id: "p", role: "primary", blocking: false, pass: true },
    { id: "g", role: "guard", blocking: true, pass: true },
    { id: "h", role: "guard", blocking: false, pass: true },
  ]);
});
