import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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

// A path under `root`, refusing anything that climbs out of it (a file name taken from an input file), and any
// file that is a symbolic link or whose real location is outside `root`: a name in an export that points at a
// link to some other file would otherwise read that file. Nothing of the target is read to decide this, so a
// refusal cannot repeat what the target holds.
export function inside(root: string, name: string): string {
  const full = resolve(root, name);
  const rel = relative(resolve(root), full);
  if (isAbsolute(name) || rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new PilotError("usage", `${name} must be a file inside ${root}.`);
  let link = false;
  try { link = lstatSync(full).isSymbolicLink(); } catch { return full; } // absent: the reader reports it
  if (link) throw new PilotError("usage", `${name} is a symbolic link. Put the file itself inside ${root}.`);
  try {
    const real = relative(realpathSync(root), realpathSync(full));
    if (real === "" || real.startsWith("..") || isAbsolute(real)) throw new PilotError("usage", `${name} must be a file inside ${root}.`);
  } catch (e) {
    if (e instanceof PilotError) throw e;
    throw new PilotError("not_found", `${name} cannot be read from ${root}.`);
  }
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

// Shape checks for parsed input, shared by the pilot's file readers.
export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export const isNonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
export const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

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

// A customer-supplied string (a name, a unit, a data class) as it may be printed: control characters, line breaks and
// escape sequences are taken out, so it cannot move the cursor, rewrite earlier output or fake a line, and it is cut
// to `max` characters with a mark that says so.
export function printable(text: string, max = 80): string {
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069]+/g, " ").replace(/ {2,}/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}... (cut at ${max} characters)` : flat;
}
