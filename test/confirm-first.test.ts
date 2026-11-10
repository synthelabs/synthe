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

// From a real run on Nov 6: the repo had no AI prompt, so the agent wrote one the app never used; the person read the
// check review as a merge approval in auto mode; the run stopped in minutes, not half an hour; and the no-win report
// asked for test cases the guide forbade agents to add.
test("the guide stops when the app has no AI prompt, and never writes one just for Synthe", () => {
  assert.match(guide, /If you find no prompt because the app doesn't call an AI model yet .*, stop here\./);
  assert.match(guide, /Do not write a new prompt only so that Synthe has one to improve: the app would never use the changes\./);
});

test("the guide says the check review is not a merge approval, and how long a run really takes", () => {
  assert.match(guide, /Auto mode is set\. One last step before Synthe starts: approve the checks it will score replies with\. This is not a merge approval/);
  assert.match(guide, /takes up to about 30 minutes\. It stops sooner, often within 5 to 10 minutes, when 3 rounds in a row find nothing clearly better/);
  assert.ok(!/usually about 30 minutes/.test(guide));
});

test("the guide lets an agent add test cases with the person after a no-win stop, and nothing else in .synthe/", () => {
  assert.match(guide, /One exception: after a run stops because nothing was clearly better, if the person wants it to keep going, you may add test cases to `\.synthe\/scenarios\.jsonl` with them/);
  assert.match(guide, /add each as one line to `\.synthe\/scenarios\.jsonl` .* then run `npx synthe restart`\. Change nothing else in `\.synthe\/`\./);
});
