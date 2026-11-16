// Integrity defects found in review of the pilot's store, approval and publish paths. Each test here failed on the
// code before its fix; the commit that fixed it says which.
import assert from "node:assert/strict";
import { cpSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DEMO, experimentCFinal, experimentFailureCases } from "../src/pilot/demo-data.ts";
import { candidateTag } from "../src/pilot/ids.ts";
import { main } from "../src/pilot/main.ts";
import type { PromotionRequest } from "../src/pilot/types.ts";
import { replayedPilot, tmp, writeExport, json, type Ctx } from "./pilot-cli-helpers.ts";

const filesUnder = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? filesUnder(p) : [p]; }) : []);

// Runs the real `main` against any pilot directory, not only the context's own, with a clock far from the data.
async function run(dir: string, argv: string[], now = "2026-11-20T00:00:00Z"): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const code = await main([...argv, "--dir", dir], { say: (l) => { lines.push(l); }, env: {}, now: () => new Date(now) });
  return { code, lines };
}

// A pilot that has been through every step that writes a record: replay, experiment, review, approval, a final
// decision, and a promotion. The eligible candidate's experiment is the one decided.
async function completePilot(): Promise<Ctx & { candidate: string; experiment: string }> {
  const ctx = await replayedPilot();
  const must = async (argv: string[]) => { if (await ctx.run(argv) !== 0) throw new Error(`setup failed at ${argv[0]}: ${ctx.lines.slice(-3).join(" | ")}`); };
  const candidate = ctx.eligible;
  await must(["experiment", "--candidate", candidate, "--start", DEMO.experiment_c_start]);
  const experiment = ctx.last("experiment.specified");
  await must(["review", "--candidate", candidate]);
  ctx.on("2026-10-26");
  await must(["approve", "--candidate", candidate, "--experiment", experiment, "--approver", "Tomas Lindqvist"]);
  ctx.on("2026-11-13");
  await must(["analyze", "--experiment", experiment, "--telemetry", writeExport(ctx, "final.json", experimentCFinal(candidateTag(candidate)))]);
  const request: PromotionRequest = {
    version: 1, base_pack_id: ctx.last("pack.frozen"), approver: DEMO.quality_lead, at: "2026-11-13T10:00:00Z", existing: [],
    added: experimentFailureCases().map((c) => ({ case: c, reason: "seen in the experiment", evidence: { experiment_id: experiment } })),
  };
  await must(["promote", "--request", ctx.put("promotion.json", json(request))]);
  return Object.assign(ctx, { candidate, experiment });
}

test("verify fails when any record a journal entry names is missing, whatever its kind", async () => {
  const ctx = await completePilot();
  try {
    assert.equal((await run(ctx.dir, ["verify"])).code, 0, "the untouched pilot verifies");
    const objects = join(ctx.dir, "objects");
    const files = filesUnder(objects);
    const kinds = new Set(files.map((f) => f.slice(objects.length + 1).split("/")[0]));
    for (const kind of ["arm", "finding", "candidate", "replay", "telemetry", "baseline", "experiment", "review", "approval", "analysis", "promotion", "promotion-request", "pack", "config", "prompt"]) {
      assert.ok(kinds.has(kind), `the fixture holds a ${kind} record`);
    }
    const copy = join(tmp("pilot-missing-"), "pilot");
    const undetected: string[] = [];
    for (const file of files) {
      rmSync(copy, { recursive: true, force: true });
      cpSync(ctx.dir, copy, { recursive: true });
      rmSync(join(copy, file.slice(ctx.dir.length + 1)));
      const result = await run(copy, ["verify"]);
      if (result.code === 0) undetected.push(file.slice(objects.length + 1, objects.length + 20));
      else assert.ok(result.lines.some((l) => /missing|is gone|not found|No \w+ record/i.test(l)), `a deleted file is named in the report: ${result.lines.join(" | ")}`);
    }
    assert.deepEqual(undetected, [], "every single deletion is reported");
  } finally { await ctx.stop(); }
});
