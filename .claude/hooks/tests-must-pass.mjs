// Stop hook: Claude can't finish while the typecheck or the tests are red, when code that they cover has changed.
// Exit 2 blocks the stop and hands the failure back to Claude. A second stop in a row is let through with a warning
// the person sees, so a failure Claude can't fix ends in an honest report instead of a loop.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
let input = {};
try { input = JSON.parse(readFileSync(0, "utf8") || "{}"); } catch { /* no input: treat as a first stop */ }

const changed = spawnSync("git", ["status", "--porcelain", "--", "src", "test", "scripts", "templates"], { cwd: root, encoding: "utf8" });
if (changed.status !== 0 || changed.stdout.trim() === "") process.exit(0);

const tail = (r) => `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n").slice(-40).join("\n");
const checks = [
  ["typecheck", [join(root, "node_modules/typescript/bin/tsc"), "--noEmit"]],
  ["tests", ["--test", "test/*.test.ts"]],
];
for (const [name, args] of checks) {
  const r = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", timeout: 240_000 });
  if (r.status === 0) continue;
  if (input.stop_hook_active) {
    console.log(JSON.stringify({ systemMessage: `Synthe's ${name} still fail. Claude stopped anyway; run \`npm run ${name === "tests" ? "test" : "typecheck"}\` to see why.` }));
    process.exit(0);
  }
  console.error(`Synthe's ${name} fail, so this work isn't done. Fix the cause (not the test), or tell the person plainly what is still failing and why.\n\n${tail(r)}`);
  process.exit(2);
}
