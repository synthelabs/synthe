// Runs the frozen milestone checks and prints a pass/fail table. A milestone's check is every file in
// test/milestones/ whose name starts with its id and a dash, such as test/milestones/P03-proposer.test.ts.
//   node scripts/swarm/milestones.mjs            all milestones
//   node scripts/swarm/milestones.mjs P03 P07    only these
//   node scripts/swarm/milestones.mjs --json     the table as JSON on stdout
// Exit 0 when every selected milestone with a check passes. A milestone with no check yet is "no check", not a failure.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { milestones } = JSON.parse(readFileSync(join(root, "swarm/milestones.json"), "utf8"));
const args = process.argv.slice(2);
const json = args.includes("--json");
const wanted = args.filter((a) => !a.startsWith("--"));
const files = readdirSync(join(root, "test/milestones")).filter((f) => f.endsWith(".test.ts"));

const rows = [];
for (const m of milestones) {
  if (wanted.length && !wanted.includes(m.id)) continue;
  const checks = files.filter((f) => f.startsWith(`${m.id}-`)).map((f) => join("test/milestones", f));
  if (!checks.length) { rows.push({ id: m.id, title: m.title, status: "no check", detail: "" }); continue; }
  const r = spawnSync(process.execPath, ["--test", ...checks], { cwd: root, encoding: "utf8", env: { ...process.env, CI: process.env.CI ?? "" } });
  const out = `${r.stdout}\n${r.stderr}`;
  const num = (k) => Number(out.match(new RegExp(`^ℹ ${k} (\\d+)`, "m"))?.[1] ?? 0);
  const pass = num("pass"), fail = num("fail") + num("cancelled");
  rows.push({ id: m.id, title: m.title, status: r.status === 0 ? "PASS" : "fail", detail: `${pass} passed, ${fail} failed` });
}

if (json) console.log(JSON.stringify(rows, null, 2));
else {
  for (const r of rows) console.log(`${r.id.padEnd(6)} ${r.status.padEnd(9)} ${r.title}${r.detail ? `  (${r.detail})` : ""}`);
  const done = rows.filter((r) => r.status === "PASS").length;
  console.log(`\n${done} of ${rows.length} milestones pass.`);
}
process.exit(rows.some((r) => r.status === "fail") ? 1 : 0);
