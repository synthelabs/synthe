import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { failureCases, PLACEHOLDER, renderCases } from "../src/pilot/cases.ts";
import { eligibleFailures } from "../src/pilot/promote.ts";
import type { CaseRun, Pack, PackCase, ReplayReport, Sha256 } from "../src/pilot/types.ts";
import { replayedPilot } from "./pilot-cli-helpers.ts";
import { a, CATALOG, escalateCase, returnCase, TOOLS, u } from "./pilot-replay-helpers.ts";

const SENTINEL = '{"id":"s1","input":"theirs","expected":"theirs","split":"train"}\n';
const parse = (path: string) => readFileSync(path, "utf8").trimEnd().split("\n").map((l) => JSON.parse(l));

test("a replay's failures become train-only scenario lines, and the team's scenarios file is never touched", async () => {
  const ctx = await replayedPilot();
  try {
    const replayId = ctx.last("replay.paired");
    const report = ctx.store.get<ReplayReport>("replay", replayId);
    const pack = ctx.store.get<Pack>("pack", report.pack_id);
    const failing = eligibleFailures([{ id: replayId, value: report }]).filter((f) => f.arm === "baseline");
    const wantTurns = new Set(failing.filter((f) => f.split === "discovery").map((f) => `${f.case_id}/${f.turn}`));
    assert.ok(wantTurns.size > 0 && failing.some((f) => f.split === "heldout"), "the fixture has both kinds of failure");

    // A team's repo next to the pilot, with a scenarios file that must stay as it is.
    const team = join(ctx.root, "team");
    mkdirSync(join(team, ".synthe"), { recursive: true });
    const scenarios = join(team, ".synthe", "scenarios.jsonl");
    writeFileSync(scenarios, SENTINEL);

    // No --out: the lines go inside the pilot directory, not into reports/ (which never hold conversation text).
    ctx.lines.length = 0;
    assert.equal(await ctx.run(["cases", "--replay", replayId.slice(0, 12)]), 0, ctx.lines.join("\n"));
    const inPilot = join(ctx.dir, "cases", `cases-${replayId.slice(0, 12)}.jsonl`);
    const rows = parse(inPilot);
    assert.equal(rows.length, wantTurns.size);
    assert.equal(readFileSync(scenarios, "utf8"), SENTINEL);
    for (const r of rows) {
      assert.deepEqual(Object.keys(r), ["id", "input", "expected", "split"]);
      assert.equal(r.split, "train");
      assert.ok(r.input && r.expected);
    }
    assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, "ids are unique");
    // The expected text is the pack's own sentence for the failed check.
    assert.ok(rows.every((r) => Object.values(pack.check_catalog).some((s) => r.expected.includes(s.replace(/\.$/, "")))));
    // A later turn keeps the conversation before it.
    assert.ok(rows.some((r) => /^Customer: .*\nAgent: .*\nCustomer: /s.test(r.input)));
    // Held-out conversations are not used, and no report holds conversation text.
    const held = pack.cases.filter((c) => c.split === "heldout").map((c) => (c.messages.find((m) => m.role === "user") as { text: string }).text);
    assert.ok(held.length > 0 && rows.every((r) => !held.some((h) => r.input.includes(h))));
    const reports = join(ctx.dir, "reports");
    const firstUser = (rows[0].input as string).split("\n")[0].replace(/^Customer: /, "");
    for (const f of readdirSync(reports)) assert.ok(!readFileSync(join(reports, f), "utf8").includes(firstUser), f);
    // The terminal gets counts and paths, never the conversations.
    assert.ok(!ctx.lines.join("\n").includes(firstUser));

    // --out names a new file: it is created, readable only by its owner. An existing file is refused, untouched.
    const out = join(team, "candidates.jsonl");
    assert.equal(await ctx.run(["cases", "--replay", replayId, "--out", out]), 0);
    assert.deepEqual(parse(out), rows);
    assert.equal(statSync(out).mode & 0o077, 0);
    ctx.lines.length = 0;
    assert.equal(await ctx.run(["cases", "--replay", replayId, "--out", scenarios]), 1);
    assert.match(ctx.lines.join("\n"), /already exists/);
    assert.equal(readFileSync(scenarios, "utf8"), SENTINEL);
    assert.equal(await ctx.run(["cases", "--replay", replayId, "--out", out]), 1, "never added to or replaced");
  } finally { await ctx.stop(); }
});

test("pilot cases asks for a replay, and refuses one it can't find", async () => {
  const ctx = await replayedPilot();
  try {
    ctx.lines.length = 0;
    assert.equal(await ctx.run(["cases"]), 1);
    assert.match(ctx.lines.join("\n"), /--replay is required/);
    assert.equal(await ctx.run(["cases", "--replay", "deadbeef00"]), 1);
    assert.match(ctx.lines.join("\n"), /No replay record starts with deadbeef00/);
    ctx.lines.length = 0;
    assert.equal(await ctx.run(["help"]), 0);
    assert.match(ctx.lines.join("\n"), /cases\s+--replay <id> \[--out <file>\]/);
  } finally { await ctx.stop(); }
});

// --- the pure part, on hand-made replays ---

const turn = (n: number, failed: string[], role: "primary" | "guard" = "primary") => ({ turn: n, status: "scored" as const, tools_requested: [], reply_sha256: null,
  checks: failed.map((id) => ({ id, role, blocking: false, pass: false as boolean | null })) });
const run = (c: PackCase, turns: ReturnType<typeof turn>[], split = c.split): CaseRun => ({ case_id: c.id, split, turns, stopped: null });
const replayOf = (baseline: CaseRun[], candidate: CaseRun[] = []) => ({ id: "9".repeat(64) as Sha256, value: { baseline: { cases: baseline }, candidate: { cases: candidate } } as unknown as ReplayReport });
const packOf = (cases: PackCase[]): Pack => ({
  version: 1, name: "t", pack_version: 1, parent_pack_id: null, tools: TOOLS, check_catalog: CATALOG, cases,
  source: { exported_by: "x", exported_at: "2026-10-01T00:00:00Z", redaction: { method: "m", approved_by: "p", approved_at: "2026-10-01T00:00:00Z" }, approved_uses: ["replay"] },
});

test("personal data that gets past the pack is left out, not written, and only counted", () => {
  const leaky: PackCase = { ...escalateCase("ESC-LEAK"), messages: [u("Please call me, I am jo.bloggs@example.com"), a("Done.")] };
  const card: PackCase = { ...escalateCase("ESC-CARD"), messages: [u("My card is 4111 1111 1111 1111, help"), a("Done.")] };
  const clean = escalateCase("ESC-OK");
  const result = failureCases(packOf([leaky, card, clean]), replayOf([leaky, card, clean].map((c) => run(c, [turn(1, ["escalates_when_asked"])]))));
  assert.equal(result.personalData, 2);
  assert.deepEqual(result.cases.map((c) => c.id), ["pilot-ESC-OK-t1"]);
  const text = renderCases(result.cases);
  assert.doesNotMatch(text, /example\.com|4111/);
});

test("a check phrase that looks like a secret is left out too", () => {
  const c = escalateCase("ESC-SECRET");
  c.checks = [{ id: "escalates_when_asked", turn: 1, role: "primary", kind: "reply_includes", any_of: ["sk-ant-api03-" + "a".repeat(40)] }];
  // No catalog sentence, so `expected` is made from the rule's own phrases.
  const result = failureCases({ ...packOf([c]), check_catalog: {} }, replayOf([run(c, [turn(1, ["escalates_when_asked"])])]));
  assert.equal(result.cases.length, 0);
  assert.equal(result.personalData, 1);
});

test("expected comes from the recorded check, a guard counts as a failure, and a missing check leaves a placeholder", () => {
  const c = returnCase("RET-X");
  const catalogless = { ...packOf([c]), check_catalog: {} };
  const result = failureCases(catalogless, replayOf([run(c, [turn(1, ["looks_up_order"]), turn(2, ["no_promise_refund"], "guard"), turn(2, ["ghost_check"])])]));
  assert.deepEqual(result.cases.map((x) => x.id), ["pilot-RET-X-t1", "pilot-RET-X-t2"]);
  assert.equal(result.cases[0].expected, "The agent calls the lookup_order tool");
  // Turn 2 has a guard failure (described from its rule) and a check the pack case doesn't hold.
  assert.equal(result.cases[1].expected, 'The reply does not say any of: "guaranteed refund"');
  const lonely = failureCases(catalogless, replayOf([run(c, [turn(2, ["ghost_check"])])]));
  assert.equal(lonely.cases[0].expected, PLACEHOLDER);
  assert.equal(lonely.placeholders, 1);
  assert.equal(lonely.usedTools, 1);
  assert.ok(lonely.cases[0].input.startsWith("Customer: Hi, I want to return order"), "the earlier turn is kept");
});

test("held-out cases are never used, and neither is a failure that only the candidate has", () => {
  const held = escalateCase("ESC-HELD", "heldout");
  const mine = escalateCase("ESC-MINE");
  const candidateOnly = escalateCase("ESC-CAND");
  const failing = [turn(1, ["escalates_when_asked"])];
  // The replay says the case was discovery, the pack says held out: the pack wins.
  const result = failureCases(packOf([held, mine, candidateOnly]), replayOf([run(held, failing, "discovery"), run(mine, failing), run(candidateOnly, [turn(1, [])])], [run(candidateOnly, failing)]));
  assert.deepEqual(result.cases.map((c) => c.id), ["pilot-ESC-MINE-t1"]);
  assert.equal(result.heldout, 1);
  assert.ok(result.cases.every((c) => c.split === "train"));
});

test("a replay with no baseline failures gives no cases", () => {
  const c = escalateCase();
  const result = failureCases(packOf([c]), replayOf([run(c, [turn(1, [])])]));
  assert.deepEqual(result.cases, []);
  assert.equal(renderCases(result.cases), "");
});
