import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENT_NEXT } from "../src/cli/init.ts";
import { guide } from "../src/cli/guide.ts";

// An agent that reads the draft as a finished install moves on to other work: no workflow, no secrets, no
// round, nothing on the organizer dashboard. Both texts an agent reads must say otherwise.
test("the draft's NEXT line says Synthe is not installed until confirm", () => {
  assert.ok(AGENT_NEXT.startsWith("NEXT: Synthe is NOT installed yet."));
  assert.match(AGENT_NEXT, /no workflow, no secrets, no commit/);
  assert.match(AGENT_NEXT, /Finish confirm before any other work/);
  assert.match(AGENT_NEXT, /do not edit the prompt file until then/);
});

test("the guide makes confirm the next thing and checks that it succeeded", () => {
  assert.match(guide, /Synthe is not installed until confirm succeeds/);
  assert.match(guide, /Finish confirm before you do any other work in this repo/);
  assert.match(guide, /"Synthe is not installed yet\. One more command finishes it\."/);
  assert.match(guide, /Do not edit the prompt file between draft and confirm/);
  assert.match(guide, /Confirm succeeded only if it printed `Added to <branch>` or opened an "Add Synthe" pull request/);
  assert.match(guide, /Do this step only after confirm succeeded/);
});
