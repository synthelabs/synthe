// Runs a command with TMPDIR set to a new folder, then removes that folder. Tests and checks make hundreds of
// temp git repos and do not all remove them; one `npm test` run left about 64 MB in /tmp. Sessions have a fixed
// disk allowance, so the leftovers stop later runs. This removes them in one place, whatever the test does.
//   node scripts/with-tmp.mjs <command...>      the command runs in a shell, so globs like test/*.test.ts expand
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: node scripts/with-tmp.mjs <command...>");
  process.exit(2);
}
const dir = realpathSync(mkdtempSync(join(tmpdir(), "synthe-run-")));
const cleanup = () => rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
// Quote an argument that holds spaces or shell syntax (a --test-name-pattern, say); leave globs bare so they expand.
const quote = (a) => (/^[\w@%+=:,./*?-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
const child = spawn(args.map(quote).join(" "), { shell: true, stdio: "inherit", env: { ...process.env, TMPDIR: dir, TMP: dir, TEMP: dir } });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code, signal) => {
  cleanup();
  process.exit(code ?? (signal ? 1 : 0));
});
