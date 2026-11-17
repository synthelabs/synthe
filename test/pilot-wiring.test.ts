// Tests for the command line wiring of three protections: the pilot directory's .gitignore (EG-05), the opt-in to a
// provider host other than api.anthropic.com (--allow-endpoint-host), and telemetry ids in the review's egress check.
// Each one fails if the wiring in commands.ts and main.ts is taken out.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BASELINE_PROMPT, CANARIES, DEMO, demoConfig, demoPack, HUMAN_CANDIDATE_PROMPT } from "../src/pilot/demo-data.ts";
import { git, json, replayedPilot, workspace } from "./pilot-cli-helpers.ts";

const refused = (lines: string[], code: string): boolean => lines.some((l) => l.startsWith(`Refused (${code})`));

test("init leaves the pilot directory with a bare * in its .gitignore, keeping the lines that were there", async () => {
  for (const [existing, label] of [["node_modules\n# local notes\n", "ends with a newline"], ["node_modules", "has no final newline"], ["*.log\n!keep.log\n", "has only other patterns"]] as const) {
    const ctx = await workspace();
    try {
      mkdirSync(ctx.dir, { recursive: true });
      writeFileSync(join(ctx.dir, ".gitignore"), existing);
      assert.equal(await ctx.run(["init", "--config", ctx.put("pilot.json", json(demoConfig())), "--repo-dir", ctx.repoDir]), 0, ctx.lines.at(-1) ?? "");
      const lines = readFileSync(join(ctx.dir, ".gitignore"), "utf8").split("\n").map((l) => l.trim());
      assert.ok(lines.includes("*"), `${label}: a bare * line is there`);
      for (const old of existing.split("\n").filter(Boolean)) assert.ok(lines.includes(old), `${label}: ${old} is kept`);
      // A second init adds nothing more.
      const once = readFileSync(join(ctx.dir, ".gitignore"), "utf8");
      assert.equal(await ctx.run(["init", "--config", ctx.put("pilot.json", json(demoConfig())), "--repo-dir", ctx.repoDir]), 0);
      assert.equal(readFileSync(join(ctx.dir, ".gitignore"), "utf8"), once);
    } finally { await ctx.stop(); }
  }
  // With no .gitignore at all, one is written.
  const fresh = await workspace();
  try {
    assert.equal(await fresh.run(["init", "--config", fresh.put("pilot.json", json(demoConfig())), "--repo-dir", fresh.repoDir]), 0);
    assert.equal(readFileSync(join(fresh.dir, ".gitignore"), "utf8"), "*\n");
  } finally { await fresh.stop(); }
});

test("init refuses a pilot directory that is a git repository root", async () => {
  const ctx = await workspace();
  try {
    mkdirSync(ctx.dir, { recursive: true });
    git(["init", "-q"], ctx.dir);
    assert.equal(await ctx.run(["init", "--config", ctx.put("pilot.json", json(demoConfig())), "--repo-dir", ctx.repoDir]), 1);
    assert.ok(refused(ctx.lines, "usage"), ctx.lines.at(-1) ?? "");
    assert.match(ctx.lines.at(-1) ?? "", /git repository root/);
  } finally { await ctx.stop(); }
});

test("init warns when a surrounding repository already tracks files in the pilot directory", async () => {
  const ctx = await workspace();
  try {
    git(["init", "-q"], ctx.root);
    mkdirSync(ctx.dir, { recursive: true });
    writeFileSync(join(ctx.dir, "notes.txt"), "already committed\n");
    git(["add", "--", "pilot/notes.txt"], ctx.root);
    git(["commit", "-q", "-m", "tracked"], ctx.root);
    assert.equal(await ctx.run(["init", "--config", ctx.put("pilot.json", json(demoConfig())), "--repo-dir", ctx.repoDir]), 0, ctx.lines.at(-1) ?? "");
    assert.ok(ctx.lines.some((l) => /^Warning: a surrounding git repository already tracks files in this directory/.test(l)), ctx.lines.join("\n"));
    // Nothing to warn about when nothing is tracked.
    const clean = await workspace();
    try {
      git(["init", "-q"], clean.root);
      assert.equal(await clean.run(["init", "--config", clean.put("pilot.json", json(demoConfig())), "--repo-dir", clean.repoDir]), 0);
      assert.ok(!clean.lines.some((l) => l.startsWith("Warning: a surrounding git repository")));
    } finally { await clean.stop(); }
  } finally { await ctx.stop(); }
});

// A provider on a host that is neither api.anthropic.com nor loopback, reached through an injected fetch.
const GATEWAY = "https://llm-gateway.fernhill.invalid";
const KEY_ENV = "FERNHILL_PILOT_KEY";
function gatewayConfig(): Record<string, unknown> {
  const c = demoConfig();
  return { ...c, provider: { provider: "anthropic", endpoint: GATEWAY, model: DEMO.model, key_env: KEY_ENV, data_class: "redacted support conversations (pack)", approved_by: "Rhea Castellan", approved_at: "2026-10-01T00:00:00Z", max_calls: 5, max_input_chars: 100_000 } };
}

test("a live run on another host needs --allow-endpoint-host naming it", async () => {
  const ctx = await workspace();
  try {
    ctx.env[KEY_ENV] = "test-key-value-not-real";
    for (const argv of [
      ["init", "--config", ctx.put("pilot.json", json(gatewayConfig())), "--repo-dir", ctx.repoDir],
      ["pack", "--file", ctx.put("pack.v1.json", json(demoPack()))],
    ]) assert.equal(await ctx.run(argv), 0, `${argv[0]}: ${ctx.lines.at(-1)}`);
    // Baseline is not needed for a replay-free discover, but the pilot must have a frozen pack: it does.
    const urls: string[] = [];
    const fetcher = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: DEMO.model, content: [{ type: "text", text: "Done." }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 5, output_tokens: 2 } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const live = ["discover", "--live", "--confirm-endpoint", GATEWAY, "--confirm-data", "redacted support conversations (pack)"];

    // Without the flag, or with another host named, nothing is sent.
    assert.equal(await ctx.run(live, { fetch: fetcher }), 1);
    assert.ok(refused(ctx.lines, "live_not_approved"), ctx.lines.at(-1) ?? "");
    assert.match(ctx.lines.at(-1) ?? "", /--allow-endpoint-host llm-gateway\.fernhill\.invalid/);
    assert.equal(await ctx.run([...live, "--allow-endpoint-host", "api.anthropic.com"], { fetch: fetcher }), 1);
    assert.ok(refused(ctx.lines, "live_not_approved"));
    assert.equal(urls.length, 0, "no request went out");

    // With the host named, the run starts: it is announced and the first request goes to that host.
    const before = ctx.lines.length;
    await ctx.run([...live, "--allow-endpoint-host", "llm-gateway.fernhill.invalid"], { fetch: fetcher });
    const said = ctx.lines.slice(before).join("\n");
    assert.match(said, /Sending "redacted support conversations \(pack\)" to anthropic at https:\/\/llm-gateway\.fernhill\.invalid/);
    assert.ok(urls.length > 0 && urls.every((u) => u.startsWith(GATEWAY)), urls.join(","));
    assert.ok(!said.includes("Refused (live_not_approved)"));
  } finally { await ctx.stop(); }
});

test("the review's egress check treats a telemetry conversation id as customer text", async () => {
  const ctx = await replayedPilot();
  try {
    const id = "c-juniper-v14-05-0007"; // a conversation id from the baseline export
    assert.ok(readFileSync(join(ctx.dir, "objects", "telemetry", ctx.store.list("telemetry")[0] + ".json"), "utf8").includes(id), "the id is in the stored baseline export");
    const propose = (rationale: string, name: string) => ctx.run(["propose", "--finding", ctx.finding, "--file", ctx.put(name, HUMAN_CANDIDATE_PROMPT), "--author", "A reviewer", "--rationale", rationale]);
    // A person's candidate that passes replay, with a conversation id in its rationale.
    assert.equal(await propose(`Looked at conversation ${id} and added a note.`, "with-id.md"), 0);
    const leaking = ctx.last("candidate.created");
    assert.equal(await ctx.run(["replay", "--candidate", leaking, "--model", ctx.model]), 0, ctx.lines.at(-1) ?? "");
    assert.equal(await ctx.run(["experiment", "--candidate", leaking, "--start", DEMO.experiment_b_start]), 0, ctx.lines.at(-1) ?? "");
    const before = ctx.lines.length;
    assert.equal(await ctx.run(["review", "--candidate", leaking]), 1);
    assert.ok(refused(ctx.lines, "egress_blocked"), ctx.lines.slice(before).join(" | "));
    assert.match(ctx.lines.at(-1) ?? "", /the candidate's rationale/, "the refusal names the part to change");
    assert.ok(!ctx.lines.slice(before).join("\n").includes(id), "the refusal does not repeat the id");
    assert.equal(ctx.store.find("review.bundled").length, 0);
    assert.ok(!existsSync(join(ctx.dir, "reports", `review-${leaking.slice(0, 12)}`)));
  } finally { await ctx.stop(); }

  // Control, in a second pilot: the same prompt with a rationale that has no id is reviewed, so the id was the reason.
  const other = await replayedPilot();
  try {
    assert.equal(await other.run(["propose", "--finding", other.finding, "--file", other.put("clean.md", HUMAN_CANDIDATE_PROMPT), "--author", "A reviewer", "--rationale", "Adds the return-by date to the reply."]), 0, other.lines.at(-1) ?? "");
    const clean = other.last("candidate.created");
    assert.equal(await other.run(["replay", "--candidate", clean, "--model", other.model]), 0, other.lines.at(-1) ?? "");
    assert.equal(await other.run(["experiment", "--candidate", clean, "--start", DEMO.experiment_b_start]), 0, other.lines.at(-1) ?? "");
    assert.equal(await other.run(["review", "--candidate", clean]), 0, other.lines.slice(-3).join(" | "));
  } finally { await other.stop(); }
});

test("a refusal names the part of the review to change: the rationale or the prompt", async () => {
  const ctx = await replayedPilot();
  try {
    const leaking = `${BASELINE_PROMPT}- After you check eligibility, tell the customer the return-by date. Example: order ${CANARIES.discovery_order}, where ${CANARIES.discovery_words}.\n`;
    assert.equal(await ctx.run(["propose", "--finding", ctx.finding, "--file", ctx.put("leaking.md", leaking), "--author", "A reviewer", "--rationale", "Adds an example."]), 0);
    const candidate = ctx.last("candidate.created");
    assert.equal(await ctx.run(["replay", "--candidate", candidate, "--model", ctx.model]), 0);
    assert.equal(await ctx.run(["experiment", "--candidate", candidate, "--start", DEMO.experiment_b_start]), 0);
    assert.equal(await ctx.run(["review", "--candidate", candidate]), 1);
    assert.ok(refused(ctx.lines, "egress_blocked"));
    assert.match(ctx.lines.at(-1) ?? "", /the candidate prompt/, "the refusal names the prompt, not the whole bundle");
  } finally { await ctx.stop(); }
});
