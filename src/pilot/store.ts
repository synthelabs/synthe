import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "../core/evidence.ts";
import { sha256 } from "../core/safety.ts";
import { PilotError } from "./errors.ts";
import { contentId, isSha256, promptId } from "./ids.ts";
import { readBounded, writeAtomic, writeOnce } from "./io.ts";
import type { IsoTime, Sha256, Stored } from "./types.ts";

// Everything a pilot keeps lives in one directory in the operator's environment:
//   objects/<kind>/<id>.json   write-once records, named by the SHA-256 of their canonical JSON
//   objects/prompt/<id>.txt    prompt texts, named by the SHA-256 of the text
//   journal.jsonl              append-only list of what happened, each line chained to the one before
//   reports/                   markdown rendered from the records; can be deleted and regenerated
// Nothing here is sent anywhere. Packs and telemetry rows are customer data: keep the directory out of git.

export type ObjectKind =
  | "config" | "pack" | "arm" | "finding" | "candidate" | "replay" | "telemetry" | "baseline" | "experiment"
  | "review" | "approval" | "analysis" | "promotion-request" | "promotion";

export const OBJECT_KINDS: ObjectKind[] = [
  "config", "pack", "arm", "finding", "candidate", "replay", "telemetry", "baseline", "experiment",
  "review", "approval", "analysis", "promotion-request", "promotion",
];

export interface JournalEntry {
  seq: number;
  at: IsoTime;
  // What happened, e.g. "pack.frozen", "analysis.decided".
  step: string;
  // What makes this step the same step on a retry: the id of its inputs or output.
  key: string;
  // Ids and small facts (a pull request number, a recommendation). Never conversation or telemetry content.
  refs: Record<string, string>;
  prev: Sha256 | null;
  hash: Sha256;
}

const entryHash = (e: Omit<JournalEntry, "hash">): Sha256 => sha256(canonicalJson(e));
const MAX_OBJECT_BYTES = 256 * 1024 * 1024;
const LOCK_STALE_MS = 60_000;

export class PilotStore {
  dir: string;
  constructor(dir: string) { this.dir = dir; }

  private objectPath(kind: ObjectKind | "prompt", id: Sha256): string {
    if (!isSha256(id)) throw new PilotError("usage", `${String(id).slice(0, 80)} is not a full 64-character id.`);
    return join(this.dir, "objects", kind, `${id}.${kind === "prompt" ? "txt" : "json"}`);
  }

  // Stores a record under its content id. Storing the same record again is a no-op, so every step can be retried.
  put(kind: ObjectKind, value: unknown): Sha256 {
    const id = contentId(value);
    // Written with keys in canonical order, so the same record always produces the same file whatever order its
    // fields were built in; otherwise a retry could look like an attempt to replace the record.
    this.place(this.objectPath(kind, id), `${JSON.stringify(JSON.parse(canonicalJson(value)), null, 2)}\n`);
    return id;
  }

  // A record's name is the hash of its content, so only one content is right for a name. A file there with any
  // other content is damaged (a crash, a stray edit) and is put right; a good record is never touched.
  private place(path: string, content: string): void {
    try {
      writeOnce(path, content);
    } catch (e) {
      if (!(e instanceof PilotError) || e.code !== "conflict") throw e;
      writeAtomic(path, content);
    }
  }

  // Reads a record and checks it still hashes to its name: an edited record is refused, not used.
  get<T>(kind: ObjectKind, id: Sha256): T {
    const path = this.objectPath(kind, id);
    if (!existsSync(path)) throw new PilotError("not_found", `No ${kind} record ${id.slice(0, 12)} in ${this.dir}.`);
    let value: T;
    try { value = JSON.parse(readBounded(path, MAX_OBJECT_BYTES)) as T; } catch (e) {
      if (e instanceof PilotError) throw e;
      throw new PilotError("tampered", `The ${kind} record ${id.slice(0, 12)} is not valid JSON, so it was changed after it was written.`);
    }
    if (contentId(value) !== id) throw new PilotError("tampered", `The ${kind} record ${id.slice(0, 12)} no longer matches its id, so it was changed after it was written.`);
    return value;
  }

  stored<T>(kind: ObjectKind, id: Sha256): Stored<T> { return { id, value: this.get<T>(kind, id) }; }

  has(kind: ObjectKind | "prompt", id: Sha256): boolean { return isSha256(id) && existsSync(this.objectPath(kind, id)); }

  list(kind: ObjectKind | "prompt"): Sha256[] {
    const dir = join(this.dir, "objects", kind);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).map((f) => f.replace(/\.(json|txt)$/, "")).filter(isSha256).sort();
  }

  // A full id, or a prefix of at least 8 characters that names exactly one record. Approvals and publication
  // never use this: they require the full id as typed.
  resolve(kind: ObjectKind | "prompt", idOrPrefix: string): Sha256 {
    // isSha256 is a type guard on an alias of string, so test it through a boolean to keep the string type below.
    const full: boolean = isSha256(idOrPrefix);
    if (full) {
      if (!this.has(kind, idOrPrefix)) throw new PilotError("not_found", `No ${kind} record ${idOrPrefix.slice(0, 12)} in ${this.dir}.`);
      return idOrPrefix;
    }
    if (!/^[0-9a-f]{8,63}$/.test(idOrPrefix)) throw new PilotError("usage", `"${idOrPrefix.slice(0, 80)}" is not an id. Give the full id, or at least its first 8 characters.`);
    const matches = this.list(kind).filter((id) => id.startsWith(idOrPrefix));
    if (matches.length === 0) throw new PilotError("not_found", `No ${kind} record starts with ${idOrPrefix}.`);
    if (matches.length > 1) throw new PilotError("usage", `${matches.length} ${kind} records start with ${idOrPrefix}; give more characters.`);
    return matches[0];
  }

  putPrompt(text: string): Sha256 {
    const id = promptId(text);
    this.place(this.objectPath("prompt", id), text);
    return id;
  }

  getPrompt(id: Sha256): string {
    const path = this.objectPath("prompt", id);
    if (!existsSync(path)) throw new PilotError("not_found", `No prompt ${id.slice(0, 12)} in ${this.dir}.`);
    const text = readBounded(path);
    if (promptId(text) !== id) throw new PilotError("tampered", `The stored prompt ${id.slice(0, 12)} no longer matches its id, so it was changed after it was written.`);
    return text;
  }

  private journalPath(): string { return join(this.dir, "journal.jsonl"); }
  // The sequence number and hash of the newest entry, kept beside the journal. The chain alone cannot show that
  // entries were cut off the end; a journal shorter than its recorded head can.
  private headPath(): string { return join(this.dir, "journal.head"); }

  head(): { seq: number; hash: Sha256 } | null {
    if (!existsSync(this.headPath())) return null;
    try {
      const h = JSON.parse(readFileSync(this.headPath(), "utf8")) as { seq: number; hash: Sha256 };
      if (Number.isInteger(h.seq) && h.seq >= 1 && isSha256(h.hash)) return { seq: h.seq, hash: h.hash };
    } catch { /* falls through */ }
    throw new PilotError("tampered", "journal.head is not readable, so the journal cannot be checked against it.");
  }

  // Every entry, after checking the chain: each line must hash to its own `hash` and name the line before it.
  journal(): JournalEntry[] {
    const path = this.journalPath();
    if (!existsSync(path)) return [];
    const entries: JournalEntry[] = [];
    let prev: Sha256 | null = null;
    for (const [i, line] of readBounded(path, MAX_OBJECT_BYTES).split("\n").entries()) {
      if (!line.trim()) continue;
      let e: JournalEntry;
      try { e = JSON.parse(line) as JournalEntry; } catch { throw new PilotError("tampered", `journal.jsonl line ${i + 1} is not valid JSON.`); }
      const { hash, ...rest } = e;
      if (e.seq !== entries.length + 1 || e.prev !== prev || entryHash(rest) !== hash) {
        throw new PilotError("tampered", `journal.jsonl line ${i + 1} does not follow the line before it, so the journal was edited or lines were removed.`);
      }
      entries.push(e);
      prev = hash;
    }
    const head = this.head();
    // A crash between the append and the head update leaves the head one behind, which is fine. The journal being
    // behind its head, or the head missing from a journal with history, means entries were removed.
    if (head && (entries.length < head.seq || entries[head.seq - 1].hash !== head.hash)) {
      throw new PilotError("tampered", `journal.jsonl has ${entries.length} entries but its recorded head is entry ${head.seq}, so entries were removed or changed.`);
    }
    if (!head && entries.length > 1) throw new PilotError("tampered", "journal.head is missing, so the journal cannot be checked for removed entries.");
    return entries;
  }

  find(step: string, key?: string): JournalEntry[] {
    return this.journal().filter((e) => e.step === step && (key === undefined || e.key === key));
  }

  last(step: string): JournalEntry | null { return this.find(step).at(-1) ?? null; }

  // Appends one entry. A retry of the same step with the same key and refs returns the first entry instead of
  // adding a second, so an interrupted command can be run again without double-counting anything.
  record(step: string, key: string, refs: Record<string, string>, at: IsoTime): JournalEntry {
    return this.locked(() => {
      const entries = this.journal();
      const same = entries.find((e) => e.step === step && e.key === key);
      if (same) {
        if (canonicalJson(same.refs) !== canonicalJson(refs)) {
          throw new PilotError("conflict", `The journal already records ${step} for ${key.slice(0, 12)} with different details. Stored pilot records are never replaced.`);
        }
        return same;
      }
      const rest = { seq: entries.length + 1, at, step, key, refs, prev: entries.at(-1)?.hash ?? null };
      const entry: JournalEntry = { ...rest, hash: entryHash(rest) };
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(this.journalPath(), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
      writeAtomic(this.headPath(), `${JSON.stringify({ seq: entry.seq, hash: entry.hash })}\n`);
      return entry;
    });
  }

  // One writer at a time. A lock left by a process that died is taken over, so a crash never blocks the retry.
  private locked<T>(fn: () => T): T {
    // A journal write takes milliseconds. A lock this old was left behind, even if its process id is in use
    // again by something else.
    const release = this.acquire("journal.lock", LOCK_STALE_MS);
    try { return fn(); } finally { release(); }
  }

  // One run at a time of a step that talks to the outside (publishing a review): two runs at once could both find
  // nothing published yet and both publish.
  async exclusive<T>(name: string, staleMs: number, fn: () => Promise<T>): Promise<T> {
    const release = this.acquire(`${name}.lock`, staleMs);
    try { return await fn(); } finally { release(); }
  }

  private acquire(file: string, staleMs: number): () => void {
    mkdirSync(this.dir, { recursive: true });
    const lock = join(this.dir, file);
    for (let attempt = 0; ; attempt++) {
      try {
        const fd = openSync(lock, "wx", 0o600);
        try { writeSync(fd, String(process.pid)); } finally { closeSync(fd); }
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        const owner = Number(readFileSync(lock, "utf8").trim());
        let alive = Number.isInteger(owner) && owner > 0 && owner !== process.pid;
        if (alive) { try { process.kill(owner, 0); } catch { alive = false; } }
        try { if (Date.now() - statSync(lock).mtimeMs > staleMs) alive = false; } catch { alive = false; }
        if (alive || attempt >= 2) throw new PilotError("conflict", `Another pilot command (process ${owner}) is working in ${this.dir} (${file}). Wait for it to finish and run this again.`);
        try { unlinkSync(lock); } catch { /* another process removed it first */ }
      }
    }
    return () => { try { unlinkSync(lock); } catch { /* already gone */ } };
  }

  // A rendering of stored records. Safe to overwrite: the records, not the report, are the evidence.
  report(name: string, content: string): string {
    const path = join(this.dir, "reports", name);
    writeAtomic(path, content);
    return path;
  }
}
