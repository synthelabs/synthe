import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { PilotError } from "./errors.ts";

// Largest input file the pilot reads: packs and telemetry exports are bounded by agreement, and an unbounded read
// of a wrong path (a raw trace dump) is exactly what must not happen.
export const MAX_INPUT_BYTES = 32 * 1024 * 1024;

export function readBounded(path: string, maxBytes = MAX_INPUT_BYTES): string {
  let size: number;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) throw new PilotError("not_found", `${path} is not a file.`);
    size = stat.size;
  } catch (e) {
    if (e instanceof PilotError) throw e;
    throw new PilotError("not_found", `${path} does not exist or cannot be read.`);
  }
  if (size > maxBytes) throw new PilotError("too_large", `${path} is ${size} bytes; the limit is ${maxBytes}. Export a smaller, bounded file.`);
  return readFileSync(path, "utf8");
}

// A path under `root`, refusing anything that climbs out of it (a file name taken from an input file).
export function inside(root: string, name: string): string {
  const full = resolve(root, name);
  const rel = relative(resolve(root), full);
  if (isAbsolute(name) || rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new PilotError("usage", `${name} must be a file inside ${root}.`);
  return full;
}

// Writes a file that must never change afterwards. Writing the same content again is fine (a retry); different
// content under the same name is refused, so an older record or approval is never replaced.
// The content goes to a temporary file first and is then linked into place in one step, so a crash can leave a
// stray temporary file but never a half-written record under the real name.
export function writeOnce(path: string, content: string): "written" | "already there" {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  try {
    try {
      linkSync(tmp, path);
      return "written";
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // A file system without hard links: fall back to a rename when the name is free.
      if (code !== "EEXIST" && !existsSync(path)) { renameSync(tmp, path); return "written"; }
      if (code !== "EEXIST" && code !== "EPERM" && code !== "ENOTSUP" && code !== "EXDEV") throw e;
    }
    if (readFileSync(path, "utf8") === content) return "already there";
    throw new PilotError("conflict", `${path} already exists with different content. Stored pilot records are never replaced.`);
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}

// Keys that would reach an object's prototype if a parsed file were used as a lookup table. No input format of the
// pilot needs them, so a file that has one is refused.
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
export function unsafeKey(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const v of value) { const hit = unsafeKey(v); if (hit) return hit; }
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  for (const [k, v] of Object.entries(value)) {
    if (UNSAFE_KEYS.has(k)) return k;
    const hit = unsafeKey(v);
    if (hit) return hit;
  }
  return null;
}

// Replaces a file that is only a rendering of stored records (a report), in one step so a crash never leaves half.
export function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, content, { mode: 0o600 });
    renameSync(tmp, path);
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}
