import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { inside } from "../src/pilot/io.ts";
import { baselineExport } from "../src/pilot/demo-data.ts";
import { PilotError } from "../src/pilot/errors.ts";
import { frozenPilot, json, tmp } from "./pilot-cli-helpers.ts";

const refusal = (fn: () => unknown): string => { try { fn(); } catch (e) { return e instanceof PilotError ? `${e.code}: ${e.message}` : `crash: ${(e as Error).message}`; } return "accepted"; };

test("inside(): a file in the directory is fine, a link or anything that climbs out of it is refused, and a symlinked directory root is not a problem (EG-11)", () => {
  const root = tmp("pilot-io-");
  const outside = tmp("pilot-io-outside-");
  writeFileSync(join(root, "rows.csv"), "a,b\n");
  writeFileSync(join(outside, "secret.csv"), "password,hunter2\n");
  symlinkSync(join(outside, "secret.csv"), join(root, "link.csv"));
  symlinkSync(outside, join(root, "dir"));
  assert.equal(inside(root, "rows.csv"), join(root, "rows.csv"));
  assert.equal(inside(root, "absent.csv"), join(root, "absent.csv"), "an absent file is the reader's to report");
  assert.match(refusal(() => inside(root, "link.csv")), /^usage: link\.csv is a symbolic link/);
  assert.match(refusal(() => inside(root, "dir/secret.csv")), /^usage: dir\/secret\.csv must be a file inside/, "a file reached through a linked directory");
  assert.match(refusal(() => inside(root, "../secret.csv")), /^usage: /);
  assert.match(refusal(() => inside(root, join(outside, "secret.csv"))), /^usage: /);
  const viaLink = join(tmp("pilot-io-links-"), "root-link");
  symlinkSync(root, viaLink);
  assert.equal(inside(viaLink, "rows.csv"), join(viaLink, "rows.csv"), "the root itself may be reached through a link");
});

test("an export whose rows_csv is a link to a file elsewhere is refused, and the refusal does not repeat what that file holds (EG-11)", async () => {
  const ctx = await frozenPilot();
  try {
    const outside = tmp("pilot-io-secret-");
    const target = join(outside, "customer-passwords.csv");
    writeFileSync(target, "password_hunter2,secret_token_zq9\nrow-1,row-2\n");
    const x = baselineExport();
    const header = { ...x.header, export_id: "fernhill-linked", rows_csv: "linked.csv" };
    const path = ctx.put("linked.json", json(header));
    symlinkSync(target, join(ctx.inputs, "linked.csv"));
    const before = ctx.lines.length;
    assert.equal(await ctx.run(["baseline", "--telemetry", path]), 1);
    const said = ctx.lines.slice(before).join("\n");
    assert.match(said, /^Refused \(invalid_telemetry\)/m, said);
    assert.ok(!/password|hunter2|secret_token|zq9|row-1/.test(said), `the refusal repeats the target: ${said}`);
    // Control: the same export with the real file in place imports.
    mkdirSync(join(ctx.inputs, "ok"));
    writeFileSync(join(ctx.inputs, "ok", "rows.csv"), x.csv);
    const ok = ctx.put("ok.json", json({ ...x.header, export_id: "fernhill-plain", rows_csv: "plain.csv" }));
    writeFileSync(join(ctx.inputs, "plain.csv"), x.csv);
    assert.equal(await ctx.run(["baseline", "--telemetry", ok]), 0, ctx.lines.slice(-1)[0]);
  } finally { await ctx.stop(); }
});
