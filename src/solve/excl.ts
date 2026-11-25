import { linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { processAlive, startTime } from "./boot.ts";

// One holder at a time for a name in a folder: the `tick` lock of a queue, and the claim of a `solve` on its
// problem (swarm/GOAL-4.md, stages 5b and 5d).
//
// The holder is a row of numbered files `<name>.<n>`. The file with the highest number is the holder now. A process
// takes it by making file n+1 when it judges file n free: released, or from a dead process, or from another boot.
// It makes the file with link(), which fails when the file exists, so only one process can make each number: two
// processes that judge the same holder free can not both win, and a process that judged an old holder free loses to
// any holder made after it. The file below the top is always kept, so the numbers do not start again while a slow
// process still judges an old one.

export interface Holder { n: number; pid: number; boot: string; start: string | null; time: string; released: boolean }

const numbers = (dir: string, name: string): number[] => {
  const re = new RegExp(`^${name.replace(/[.]/g, "\\.")}\\.(\\d+)$`);
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  return names.map((f) => re.exec(f)).filter((m) => m !== null).map((m) => Number(m![1])).sort((x, y) => x - y);
};

// The holder in file n. "gone" when the file no longer exists; null when it can not be read (not one of ours).
function readHolder(dir: string, name: string, n: number): Holder | null | "gone" {
  let text: string;
  try { text = readFileSync(join(dir, `${name}.${n}`), "utf8"); } catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? "gone" : null; }
  try {
    const h = JSON.parse(text);
    if (!h || typeof h.pid !== "number") return null;
    return {
      n, pid: h.pid, boot: typeof h.boot === "string" ? h.boot : "", start: typeof h.start === "string" ? h.start : null,
      time: String(h.time ?? ""), released: h.released === true,
    };
  } catch { return null; }
}

// A holder is live while it is not released and its process runs on this boot. A process id from another boot, or
// with another start time, belongs to some other program now.
export function holderLive(h: Holder | null, boot: string): boolean {
  if (!h || h.released || h.pid === process.pid) return false;
  return h.boot === boot && processAlive(h.pid, h.start);
}

const pause = (ms: number) => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

export type Taken = { ok: true; n: number; stale: boolean } | { ok: false; held: Holder };

// Takes the holder of `name` in `dir`, or returns the live holder. `pauseMs` waits between judging a holder stale
// and taking it over; only tests set it.
export function take(dir: string, name: string, boot: string, pauseMs = 0): Taken {
  mkdirSync(dir, { recursive: true });
  const me = { pid: process.pid, boot, start: startTime(process.pid), time: new Date().toISOString() };
  for (let i = 0; i < 50; i++) {
    const all = numbers(dir, name);
    const top = all.length ? all[all.length - 1] : 0;
    let stale = false;
    if (top) {
      const held = readHolder(dir, name, top);
      if (held === "gone") continue; // its holder removed it just now: judge again
      if (holderLive(held, boot)) return { ok: false, held: held! };
      stale = !held?.released;
      pause(pauseMs);
    }
    const n = top + 1, tmp = join(dir, `.${name}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
    writeFileSync(tmp, JSON.stringify(me) + "\n");
    try {
      linkSync(tmp, join(dir, `${name}.${n}`));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      continue; // another process made holder n first: judge that one
    } finally {
      rmSync(tmp, { force: true });
    }
    // A higher number means this process judged an old holder: the newer one wins.
    if (numbers(dir, name).some((m) => m > n)) {
      rmSync(join(dir, `${name}.${n}`), { force: true });
      continue;
    }
    for (const m of all) if (m < top) rmSync(join(dir, `${name}.${m}`), { force: true });
    return { ok: true, n, stale };
  }
  const all = numbers(dir, name);
  const held = all.length ? readHolder(dir, name, all[all.length - 1]) : null;
  return { ok: false, held: held && held !== "gone" ? held : { n: 0, pid: 0, boot, start: null, time: "", released: false } };
}

// Ends this process's hold on file n: `remove` deletes the file, else it is marked released. Either way the file
// below stays, so the numbers go on.
export function release(dir: string, name: string, n: number, remove = false): void {
  const file = join(dir, `${name}.${n}`);
  const h = readHolder(dir, name, n);
  if (!h || h === "gone" || h.pid !== process.pid) return;
  if (remove) { rmSync(file, { force: true }); return; }
  const { n: _n, ...rest } = h;
  writeFileSync(`${file}.tmp`, JSON.stringify({ ...rest, released: true, time: new Date().toISOString() }) + "\n");
  renameSync(`${file}.tmp`, file);
}
