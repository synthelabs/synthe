import { readFileSync } from "node:fs";
import { uptime } from "node:os";

// The id of this machine boot. A machine that is replaced keeps its files but not its processes, and a new
// machine can give an old process id to another program. So a process id means something only with the boot id
// that was current when it was written (swarm/GOAL-4.md). Tests set SYNTHE_BOOT_ID.
export function bootId(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SYNTHE_BOOT_ID) return env.SYNTHE_BOOT_ID;
  try {
    const id = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    if (id) return id;
  } catch { /* not Linux */ }
  // The boot time, to the minute: it is the same for every process of one boot.
  return `boot-${Math.round((Date.now() - uptime() * 1000) / 60_000)}`;
}

// The start time of process `pid` (field 22 of /proc/<pid>/stat, in clock ticks since boot), or null where it can
// not be read. A process id with its start time names one process: a later process that gets the same id has
// another start time.
export function startTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" "); // field 3 onward
    return /^\d+$/.test(fields[19] ?? "") ? fields[19] : null;
  } catch { return null; }
}

// True while process `pid` runs on this machine. A zombie (ended, not yet collected) does not run. With `start`, the
// live process must also have that start time; where the start time can not be read, the process id alone counts.
export function processAlive(pid: number, start?: string | null): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EPERM") return false; }
  let stat: string;
  try { stat = readFileSync(`/proc/${pid}/stat`, "utf8"); } catch { return true; }
  if (/^\d+ \(.*\) Z/.test(stat)) return false;
  if (!start) return true;
  const now = startTime(pid);
  return now === null || now === start;
}
