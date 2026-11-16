// A child process for tests that need two real processes at once. Run as:
//   node test/pilot-worker.ts <ready file> <go file> record <dir> <id> <count>
//   node test/pilot-worker.ts <ready file> <go file> main <dir> <now> <command and options...>
// It says it is ready, waits for the go file, then runs, so the processes start together.
import { existsSync, writeFileSync } from "node:fs";
import { main } from "../src/pilot/main.ts";
import { PilotStore } from "../src/pilot/store.ts";

const [ready, go, mode, dir, ...rest] = process.argv.slice(2);
writeFileSync(ready, "ready");
const pause = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(go)) Atomics.wait(pause, 0, 0, 2);

if (mode === "record") {
  const [id, count] = rest;
  const store = new PilotStore(dir);
  let refused = 0;
  for (let i = 0; i < Number(count); i++) {
    for (let tries = 0; tries < 2000; tries++) {
      try { store.record("worker.step", `${id}-${i}`, { who: id }, "2026-11-01T00:00:00Z"); break; } catch (e) {
        if ((e as { code?: string }).code === "conflict" && /Another pilot command/.test((e as Error).message)) { refused++; Atomics.wait(pause, 0, 0, 1); continue; }
        throw e;
      }
    }
  }
  console.log(JSON.stringify({ id, refused }));
} else {
  const [now, ...argv] = rest;
  const lines: string[] = [];
  const code = await main([...argv, "--dir", dir], { say: (l) => { lines.push(l); }, env: {}, now: () => new Date(now) });
  console.log(JSON.stringify({ code, lines }));
}
